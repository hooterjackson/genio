# Needle

Needle turns a plain-language request into a cited, reviewable Apple Music playlist. The public site is anonymous and mobile-first; one owner-funded OpenAI project performs research and one owner-authorized Apple Music account publishes share-link playlists.

> Apple Music's Playlist Playground suggests 25 tracks. Needle is for deeper work: Paulinho da Costa's biography credits him on more than 6,000 songs, so Needle researches the evidence and assembles the source-backed playlist.

Needle uses **exhaustive** to mean exhaustive across the sources it can prove it searched. Inaccessible sources and unresolved gaps remain visible.

Curated prompts such as “100 most influential…” use a separate **fast** profile: one bounded cited web synthesis, one structured extraction, and concurrent Apple catalog lookup. The product targets confirmation-to-review in under two minutes and reports an explicit partial result when evidence or provider latency prevents the requested count. Exhaustive and hybrid prompts retain the slower source-frontier workflow and make no two-minute promise.

## Architecture

- `app/` — dark, terminal-style Sites UI.
- `worker/index.ts` — same-origin Sites gateway. It derives an anonymous client bucket and signs the fixed Railway route allowlist.
- `server/index.ts` — public Railway Fastify API. It validates gateway signatures, capabilities, limits, and state transitions; it never performs paid work inline.
- `server/worker-runner.ts` — private Railway worker. It leases resumable research, matching, publication, notification, and retention jobs from Postgres.
- `db/schema.ts` — authoritative Postgres schema, including source provenance, immutable manifests, leases, costs, capabilities, Apple authorization, and audit state.

The browser never receives the OpenAI key, MusicKit private key, or the owner's Apple Music user token. Research code has no route to Apple writes; the publisher accepts only a locked manifest ID.

The owner console also exposes budget decisions, Apple reauthorization, emergency pauses, cache invalidation, and paused-run specialist CSV/JSON imports. These controls are owner-only and audited; public visitors still receive only capability-scoped run access.

## Local development

Requirements: Node 22.13+, pnpm 11, and Postgres 17.

1. Copy `.env.example` to `.env.local` and fill the local-only secrets.
2. Start Postgres with `docker compose up -d postgres`.
3. Apply the schema with `pnpm db:migrate`.
4. Start Sites, API, and worker together with `pnpm dev`.
5. Open `http://localhost:3000`.

Useful checks:

```sh
pnpm test
pnpm build
pnpm lint
pnpm test:e2e
```

After staging, use `pnpm benchmark:export -- prepare ...`, complete the independent review, then use `pnpm benchmark:export -- finalize ...` and `pnpm benchmark -- <artifact.json>`. The evaluator accepts only a hash-bound Postgres export and fails unless the factual holdouts reach 100% recovery, at least 100 factual matches reach 99.5% auto-match precision and 95% storefront-available resolvability, and the 50–100-track curated result passes citation, uniqueness, concentration, and seven-dimension human review gates. See [`docs/benchmark-holdouts.md`](docs/benchmark-holdouts.md).

Local requests use the same gateway signature and capability flow as production. A real research run additionally requires `OPENAI_API_KEY`; Apple publication requires the owner MusicKit credentials and a stored owner user token.

The default model split is Luna for brief interpretation and fast curated research, and Terra for deep research. Configure the three profiles independently with `OPENAI_BRIEF_MODEL`, `OPENAI_FAST_MODEL`, and `OPENAI_DEEP_MODEL`; `OPENAI_MODEL` remains a legacy deep-only override.

## Production

Production uses Sites for the custom-domain UI and signed same-origin gateway, plus one Railway project containing API, worker, and Postgres services. See:

- [`docs/deployment.md`](docs/deployment.md) — environment, rollout, monitoring, rotation, and recovery.
- [`docs/phase-zero.md`](docs/phase-zero.md) — mandatory live Apple and hosting feasibility gates.
- [`docs/security.md`](docs/security.md) — trust boundaries, capabilities, SSRF controls, and retention.

Do not share the site until every phase-zero gate passes. In particular, the code cannot prove Apple share-link behavior, second-account library import, publisher identity, or long-playlist limits without the owner's live credentials and two Apple Music accounts.
