# gobare_docs

The Mintlify site source for **docs.gobare.dev**. Mintlify's GitHub App
watches this repository's `main` branch directly and deploys on every push —
there is no build step here, and nothing else has to run for a merge to go
live.

## Do not edit the `.mdx` files here

This repository is a **published copy**, not where documentation is written.
The source is `docs/api/` in the product repository —
[MishaBear94/gobare](https://github.com/MishaBear94/gobare) — where a family
of guards (`src/control-plane/v1/docs-*.test.ts` and
`published-docs.test.ts`) check every page against the code it describes:
error codes, rate limits, event names, webhook retry schedules, scopes, and
more, read out of the product's own constants rather than retyped by hand.
None of those guards can see an edit made only here. The next publish
overwrites it without warning, because from the product repository an edit
made only in this repository looks identical to no edit at all.

**To change a page:** edit `docs/api/<page>.mdx` in the product repository,
run its gate, then publish (below). If you are looking at a typo or a wrong
number on docs.gobare.dev right now, fix it there — not in a checkout of this
repository.

## What's generated, and what isn't

Most of `docs/api/*.mdx` is hand-written prose. Three files are not, and are
overwritten by a generator every time they're needed rather than hand-edited
in either repository:

| File | Generator (run in the product repo) | Source of truth |
| --- | --- | --- |
| `openapi.json` | `pnpm docs:openapi` | `buildRoutes()` — the same route table the server matches requests against |
| `objects.mdx` | `pnpm docs:objects` | the curated schema list in `scripts/docs/objects-schema.ts`, rendered from the same OpenAPI document |
| `run-session.mdx` | `pnpm docs:run-session` | `scripts/e2e/v1/run-session.ts`, the real file `pnpm e2e:v1:minimax` runs against production |

Endpoint titles on the reference pages (`api-reference/*`) come from a
hand-written table, `OPERATION_TITLES` in
`src/control-plane/v1/call-names.ts` — not from the OpenAPI `summary`
sentence, which would have made an unreadable URL out of every endpoint
(`change-a-session:-title-metadata-instructions-or-its-safety-settings`), and
not from the bare client call name (`sessions.update`), which Mintlify has no
space to break on and collapses to `sessionsupdate`. A guard in
`openapi.test.ts` fails if a route has no title, or a title names a route
that doesn't exist.

## Publishing a change

From the product repository, after editing:

```bash
# Only if you touched something a generator owns — safe to run always.
pnpm docs:openapi
pnpm docs:objects
pnpm docs:run-session

# Fails loudly if docs/api has drifted from the code, or a generated file is
# stale. This is the only supported way to update this repository.
bash scripts/publish-docs-mintlify.sh /path/to/a/gobare_docs/checkout
cd /path/to/a/gobare_docs/checkout && git push
```

Mintlify deploys within a minute or two of the push landing on `main`. There
is no separate "publish" step to remember on this side.

## Previewing locally

```bash
npx --yes mint@4.2.890 dev              # local preview server
npx --yes mint@4.2.890 validate         # strict build validation
npx --yes mint@4.2.890 broken-links     # link + anchor check
```

Pinned to `4.2.890` rather than `@latest`: at the time this was written,
`mint@latest` failed to install with an unresolvable dependency
(`@mintlify/validation@0.1.854` did not exist on npm). If `@latest` works
again when you read this, either is fine — the pin exists only to route
around a broken release, not because a specific version is required.

## The custom domain

`docs.gobare.dev` is a Cloudflare **CNAME** to `cname.mintlify.builders`,
verified with two Cloudflare **TXT** records (`_acme-challenge.docs` and
`_cf-custom-hostname.docs`) that Mintlify's own domain-setup page
(Site → Domain setup, in the `gobare-dev` Mintlify workspace) shows you the
exact values for if they ever need to be recreated — don't copy them from
anywhere else; a truncated value copied from a screenshot is a record that
will never validate.

The Cloudflare zone is `gobare.dev`, managed with a `CLOUDFLARE_API_TOKEN`
that lives in the production VM's `.env.prod` — the same token Caddy uses for
its own DNS-01 certificate challenges on the product's other subdomains. Pull
it read-only over SSH the same way `scripts/ops/acceptance-token.sh` reaches
the VM's other production secrets; do not create a second token for this.

**What used to be here:** `docs.gobare.dev` was served by a Caddy site block
on the production VM, reading a static build (`docs-site/` in the product
repository, built by `docs-site/build.ts`) from a bind-mounted directory. All
of that is retired — `docs-site/` is deleted, the Caddy block now only
returns 404 (kept solely so the hostname stays reserved against a customer
publishing a preview there — see
`src/control-plane/reserved-subdomains.test.ts`), and the VM has not served a
single byte of documentation since the CNAME above went live. If
`docs.gobare.dev` is ever serving something wrong, the fault is almost
certainly on Mintlify's side or in this repository, not on the VM.

## The other mirror

[MishaBear94/gobare_tools](https://github.com/MishaBear94/gobare_tools) is a
**different** public repository: it carries mirrors of the TypeScript and
Python SDK clients (`sdk/ts`, `sdk/python`), published by
`scripts/publish-api-docs.sh` in the product repository. It used to carry a
`docs/api` mirror as well, from before the documentation site moved to
Mintlify — that copy is deleted now that this repository is the real one.
Nothing about updating documentation touches `gobare_tools`.
