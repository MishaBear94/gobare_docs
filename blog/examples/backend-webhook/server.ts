// server.ts: npm i express, then run with tsx or compile with tsc.
import express from "express";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const API = "https://api.gobare.dev/v1";
const TOKEN = process.env.GOBARE_TOKEN!;
const SECRET = process.env.GOBARE_WEBHOOK_SECRET!;
const MODEL = process.env.GOBARE_MODEL ?? "MiniMax-M3"; // a model one of your connections runs

async function gobare(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Demo storage. Use your database in production.
type Job = {
  sessionId: string;
  status: "running" | "completed" | "failed" | "action_required";
  answer?: string;
  files?: string[];
  error?: string;
};
const jobs = new Map<string, Job>();
const handled = new Set<string>();

const app = express();

// ── 1. Dispatch: returns at once, holds nothing open ────────────────────────
app.post("/jobs", express.json(), async (req, res) => {
  const jobId = randomUUID();
  const { task, repo } = req.body as { task: string; repo?: string };

  let session;
  try {
    session = await gobare(
      "POST",
      "/sessions",
      {
        agent: {
          model: MODEL,
          // Optional: a function your backend answers when the agent calls it.
          tools: [
            {
              type: "function",
              name: "lookup_ticket",
              description: "Fetch a support ticket from our system by id.",
              parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
            },
          ],
        },
        ...(repo ? { environment: { repo } } : {}), // "owner/name"; needs a GitHub connection
        metadata: { job_id: jobId }, // comes back on every read, so no lookup table
        input: `${task}\n\nWrite anything you produce as files under /workspace/outputs.`,
      },
      { "idempotency-key": `job-${jobId}` }, // a retried dispatch cannot start a second agent
    );
  } catch (err) {
    console.error("dispatch:", err);
    return res.status(502).json({ error: "could not start the agent" });
  }

  jobs.set(jobId, { sessionId: session.id, status: "running" });
  res.status(202).json({ job_id: jobId, status: "running" });
});

app.get("/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  job ? res.json(job) : res.sendStatus(404);
});

// ── 2. Webhook: verify, answer 200, work afterwards ─────────────────────────
function verify(timestamp: string, body: string, signature: string): boolean {
  const expected = createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex");
  if (expected.length !== signature.length) return false;
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) return false;
  return Math.abs(Date.now() - Number(timestamp)) <= 5 * 60_000; // milliseconds, not seconds
}

// express.raw, not express.json: the signature is over the exact bytes we sent.
app.post("/hooks/gobare", express.raw({ type: "application/json" }), (req, res) => {
  const body = req.body.toString("utf8");
  const ok = verify(req.header("x-gobare-timestamp") ?? "", body, req.header("x-gobare-signature") ?? "");
  if (!ok) return res.sendStatus(400);

  res.sendStatus(200); // a receiver that takes longer than 10 s is abandoned and retried
  handle(JSON.parse(body)).catch((err) => console.error("webhook:", err));
});

type WebhookEvent = {
  type: "turn.completed" | "turn.failed" | "session.action_required";
  created_at: number;
  data: { session_id: string; turn_id?: string; required_action?: { type: string } };
};

async function handle(event: WebhookEvent) {
  // At least once, possibly out of order: handle each fact once, and read current state.
  const key = `${event.type}:${event.data.turn_id ?? `${event.data.session_id}:${event.created_at}`}`;
  if (handled.has(key)) return;
  handled.add(key);

  const session = await gobare("GET", `/sessions/${event.data.session_id}`);
  const jobId = session.metadata?.job_id as string | undefined;
  if (!jobId || !jobs.has(jobId)) return; // not a session this service started

  if (event.type === "turn.completed") return collect(jobId, session.id, event.data.turn_id!);
  if (event.type === "turn.failed") return fail(jobId, session.id, event.data.turn_id!);
  if (event.type === "session.action_required") return answer(jobId, session);
}

// ── 3. Collect: the answer, the files, then free the machine ────────────────
async function collect(jobId: string, sessionId: string, turnId: string) {
  const turn = await gobare("GET", `/sessions/${sessionId}/turns/${turnId}`);
  if (turn.artifacts === "pending") {
    // The webhook waits for publishing, but gives up after 30 s. Come back.
    setTimeout(() => collect(jobId, sessionId, turnId).catch(console.error), 5_000);
    return;
  }

  // The agent's written reply is the newest assistant message.
  const { data: items } = await gobare("GET", `/sessions/${sessionId}/items?limit=20`);
  const reply = items.find((i: any) => i.type === "message" && i.role === "assistant");

  // Files it wrote under /workspace/outputs in this turn.
  const { data: artifacts } = await gobare(
    "GET",
    `/sessions/${sessionId}/artifacts?turn_id=${turnId}&limit=100`,
  );
  await mkdir(`out/${jobId}`, { recursive: true });
  for (const artifact of artifacts) {
    const file = await fetch(`${API}/sessions/${sessionId}/artifacts/${artifact.id}/content`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await writeFile(`out/${jobId}/${artifact.path.split("/").pop()}`, Buffer.from(await file.arrayBuffer()));
  }
  if (turn.artifacts === "partial") console.warn("skipped:", turn.artifacts_skipped);

  jobs.set(jobId, {
    sessionId,
    status: "completed",
    answer: reply?.content ?? "",
    files: artifacts.map((a: any) => a.path),
  });
  await gobare("DELETE", `/sessions/${sessionId}`); // a session holds a concurrency slot until deleted
}

async function fail(jobId: string, sessionId: string, turnId: string) {
  const turn = await gobare("GET", `/sessions/${sessionId}/turns/${turnId}`);
  jobs.set(jobId, { sessionId, status: "failed", error: turn.error?.message ?? "the turn failed" });
  await gobare("DELETE", `/sessions/${sessionId}`);
}

// ── 4. The agent is waiting on you ──────────────────────────────────────────
async function answer(jobId: string, session: any) {
  for (const action of session.required_actions ?? []) {
    if (action.type !== "function_call") {
      // "approval" or "question": a person decides. Answer later with input.approval
      // or input.question_answer, or let them do it in the Console.
      jobs.set(jobId, { ...jobs.get(jobId)!, status: "action_required" });
      continue;
    }
    let result: { success: true; output: string } | { success: false; error: string };
    try {
      result = { success: true, output: JSON.stringify(await runMyFunction(action.name, action.arguments)) };
    } catch {
      result = { success: false, error: "That lookup failed. Continue without it." }; // never send a stack trace to the model
    }
    await gobare(
      "POST",
      `/sessions/${session.id}/events`,
      {
        events: [{ type: "input.tool_result", turn_id: action.turn_id, call_id: action.call_id, ...result }],
      },
      { "idempotency-key": `answer-${action.call_id}` },
    );
  }
}

async function runMyFunction(name: string, args: any) {
  if (name === "lookup_ticket") return { id: args.id, title: "Checkout fails on Safari", priority: "high" };
  throw new Error(`no such function: ${name}`);
}

app.listen(3000, () => console.log("listening on :3000"));
