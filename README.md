# gênio

gênio turns a plain-language request into a cited, reviewable Apple Music playlist. The public site is anonymous and mobile-first; one owner-funded OpenAI project performs research and one owner-authorized Apple Music account creates the playlists. A run exposes a visitor link only after Apple reports the playlist as public and returns an Apple Music catalog URL.

Visitors can start multiple jobs, reopen the jobs available to their browser, and let active research continue in the background.

Published playlists are also available at `/playlists`. The directory is a separate, privacy-safe projection: it contains only the public playlist title, publication date, track and volume counts, and stable `music.apple.com` share links. It never exposes the originating prompt, run or capability identifiers, evidence notes, costs, owner controls, or Apple library playlist IDs. Deleting a private run removes its detailed gênio data without breaking an already-public Apple link; the owner can hide the directory entry independently.

The public flow starts with one prompt and an explicit track count. A small structured preflight then generates two or three request-specific questions—three choices plus a custom answer, one screen at a time—before research begins. Answers are applied through a frozen-scope allowlist, so they can tune selection and playlist flow without changing the subject, exact count, evidence boundary, or cost class.

gênio uses **exhaustive** to mean exhaustive across the sources it can prove it searched. Inaccessible sources and unresolved gaps remain visible.

Curated prompts such as “100 most influential…” use a separate **fast** profile: bounded cited web synthesis, structured extraction, and concurrent Apple catalog lookup. The public One Command surface accepts 1–300 tracks, researches extra candidates to absorb catalog misses, and never silently publishes fewer tracks than requested. Its immutable research-and-matching windows are size-tiered: two minutes for 1–100 tracks, four minutes for 101–200, and six minutes for 201–300. Queueing and Apple publication can add time. Explicit factual enumeration without a track-count control retains the slower source-frontier workflow.

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
pnpm qa:policy:check
pnpm qa:scenarios:check
pnpm build
pnpm lint
pnpm test:e2e
```

`pnpm test` without `DATABASE_URL` is the credential-free deterministic suite.
Postgres integration requires a disposable Postgres 17 database, migration,
and `pnpm test:coverage`; browser QA runs through an isolated preview. The
current harness, covered scenarios, and remaining live-provider gates are
documented in [`docs/qa-sweep-2026-07-17.md`](docs/qa-sweep-2026-07-17.md).

After staging, use `pnpm benchmark:export -- prepare ...`, complete the independent review, then use `pnpm benchmark:export -- finalize ...` and `pnpm benchmark -- <artifact.json>`. The evaluator accepts only a hash-bound Postgres export and fails unless the factual holdouts reach 100% recovery, at least 100 factual matches reach 99.5% auto-match precision and 95% storefront-available resolvability, and the 50–100-track curated result passes citation, uniqueness, concentration, and seven-dimension human review gates. See [`docs/benchmark-holdouts.md`](docs/benchmark-holdouts.md).

Local requests use the same gateway signature and capability flow as production. A real research run additionally requires `OPENAI_API_KEY`; Apple publication requires the owner MusicKit credentials and a stored owner user token.

The default model split is GPT-5.4 mini for short structured brief interpretation, GPT-5.6 Luna for cited fast research, and GPT-5.6 Terra for explicit deep research. Configure the profiles independently with `OPENAI_BRIEF_MODEL`, `OPENAI_FAST_MODEL`, and `OPENAI_DEEP_MODEL`; the unsuffixed legacy `OPENAI_MODEL` is deliberately ignored so it cannot silently route deep work to Sol.

Before a release, export the retained 90-day attempt history with `pnpm qa:scenarios:export`, redact it, and promote every new case into `tests/fixtures/production-search-scenarios.json`. `pnpm qa:scenarios:check` replays every archived request against deterministic under-yield and Apple-recovery tapes and gates exact count, candidate and catalog yield, latency, combined spend, and candidate accounting. Failed, truncated, and budget-gated attempts count just as much as successful ones. See [`docs/release-scenario-qa.md`](docs/release-scenario-qa.md).

## Production

Production uses Sites for the custom-domain UI and signed same-origin gateway, plus one Railway project containing API, worker, and Postgres services. See:

- [`docs/deployment.md`](docs/deployment.md) — environment, rollout, monitoring, rotation, and recovery.
- [`docs/phase-zero.md`](docs/phase-zero.md) — mandatory live Apple and hosting feasibility gates.
- [`docs/security.md`](docs/security.md) — trust boundaries, capabilities, SSRF controls, and retention.

Do not share the site until every phase-zero gate passes. In particular, the code cannot prove Apple share-link behavior, second-account library import, publisher identity, or long-playlist limits without the owner's live credentials and two Apple Music accounts.
