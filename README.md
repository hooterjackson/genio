# Needle

Needle turns a plain-language request into a cited, reviewable Apple Music playlist. The public site is anonymous and mobile-first; one owner-funded OpenAI project performs research and one owner-authorized Apple Music account publishes share-link playlists.

> Apple Music's Playlist Playground suggests 25 tracks. Needle is for deeper work: Paulinho da Costa's biography credits him on more than 6,000 songs, so Needle researches the evidence and assembles the source-backed playlist.

Needle uses **exhaustive** to mean exhaustive across the sources it can prove it searched. Inaccessible sources and unresolved gaps remain visible.

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

After staging produces an independently reviewed result artifact, run `pnpm benchmark -- <results.json>`. The evaluator fails unless the factual holdouts reach 100% recovery, auto-match precision reaches 99.5%, storefront-available resolvability reaches 95%, and the 50–100-track curated result passes citation, uniqueness, concentration, and seven-dimension human review gates. The checked-in holdout is deliberately only a seed and must be independently expanded before launch acceptance can be claimed.

Local requests use the same gateway signature and capability flow as production. A real research run additionally requires `OPENAI_API_KEY`; Apple publication requires the owner MusicKit credentials and a stored owner user token.

## Production

Production uses Sites for the custom-domain UI and signed same-origin gateway, plus one Railway project containing API, worker, and Postgres services. See:

- [`docs/deployment.md`](docs/deployment.md) — environment, rollout, monitoring, rotation, and recovery.
- [`docs/phase-zero.md`](docs/phase-zero.md) — mandatory live Apple and hosting feasibility gates.
- [`docs/security.md`](docs/security.md) — trust boundaries, capabilities, SSRF controls, and retention.

Do not share the site until every phase-zero gate passes. In particular, the code cannot prove Apple share-link behavior, second-account library import, publisher identity, or long-playlist limits without the owner's live credentials and two Apple Music accounts.
