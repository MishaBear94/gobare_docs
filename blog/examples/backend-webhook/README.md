# Run a coding agent from your backend, with a webhook

One file. `POST /jobs` starts an agent on its own cloud machine and returns at once;
Gobare calls `POST /hooks/gobare` when the turn finishes; the handler verifies the
signature, collects the answer and files, and deletes the session.

Walkthrough: https://gobare.dev/blog/run-coding-agent-from-backend-api

## Run it

```bash
npm install
export GOBARE_TOKEN=gbr_pat_...            # read/write token
export GOBARE_WEBHOOK_SECRET=whsec_...     # from POST /v1/webhooks, shown once
export GOBARE_MODEL=MiniMax-M3             # a model one of your connections runs
npm start
```

The webhook needs a public HTTPS address. Locally:

```bash
cloudflared tunnel --url http://localhost:3000
```

Subscribe that address once:

```bash
curl -s -X POST https://api.gobare.dev/v1/webhooks \
  -H "Authorization: Bearer $GOBARE_TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://<your-tunnel>/hooks/gobare","events":["turn.completed","turn.failed","session.action_required"]}'
```

Then:

```bash
curl -s -X POST localhost:3000/jobs -H 'content-type: application/json' \
  -d '{"task":"Read this repository and write outputs/report.md: what it does and how to run its tests.","repo":"owner/name"}'
curl -s localhost:3000/jobs/<job_id>
```

Storage is in memory to keep the file short. Replace `jobs` and `handled` with your database before running this for real.
