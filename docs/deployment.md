# Deployment and operations

## Topology

Use one Railway project with separate staging and production environments:

| Service | Exposure | Config | Responsibility |
| --- | --- | --- | --- |
| Sites | Public custom domain | `.openai/hosting.json` | UI, owner identity, client bucket, signed gateway |
| `needle-api` | Public Railway HTTPS | `.railway/railway.ts` | Validate/enqueue/read state |
| `needle-worker` | Railway private network | `.railway/railway.ts` | Durable paid jobs and deterministic publication |
| Postgres | Railway private network | `.railway/railway.ts` | Authoritative state, leases, cost ledger |

Sites cannot address Railway's private network, so only the API receives a Railway public domain. The API accepts the fixed `/api/v1` route allowlist only after validating the Sites HMAC. Do not expose the worker.

## One-time setup

1. Create a private source repository and require tests and build checks before merge.
2. Create the Railway project, staging/production environments, Postgres, API, and worker.
3. Give both app services the internal `DATABASE_URL`; give only the API a public Railway domain.
4. Preview and apply `.railway/railway.ts`; it is the only Railway configuration source for both services and Postgres.
5. Enable seven-day Postgres point-in-time recovery before sharing the URL.
6. Create the Sites project, attach the chosen custom domain, and set Sites gateway secrets.
7. Add DNS records for Sites and Resend. Set Apple Music browser origins to the exact HTTPS custom origin.
8. Configure UptimeRobot checks for the custom domain and the Railway API's `/health/system` endpoint.

The Sites artifact contains only Sites metadata. Postgres migrations live in `postgres-migrations/` so Sites cannot mistake them for D1 migrations; Railway applies them through Drizzle before the API deploy.

The public `/playlists` page is backed by a dedicated Postgres projection, not
by direct reads of private run state. Migration `0010_public_playlist_directory.sql`
creates the projection and backfills only internally consistent terminal
publications with stable Apple share links. The application schema version is
`13`; API and worker readiness must report that version before Sites exposes
the directory revision.

## `9enio.com` cutover

`https://9enio.com` is the canonical public origin. Connect it without interrupting Apple publication:

1. Publish the current `gênio` frontend revision to the existing Sites project.
2. Add the apex domain in Sites and copy the exact verification and routing records Sites returns.
3. Replace only the conflicting Squarespace parking records with those exact values. Preserve unrelated mail, ownership, and security records.
4. Wait for Sites verification and valid HTTPS before changing Railway.
5. Change the API `APP_ORIGIN` to `https://9enio.com`, review the Railway plan, deploy, and verify the owner MusicKit flow on the new origin.
6. Run a three-track publication smoke test and confirm the public Apple link.
7. Keep `genio.engineered.lighting` available during the session grace period. Its host-only capability cookies cannot migrate to `9enio.com`; existing jobs need transfer links or continued access through the old host.

Do not guess Sites DNS values or change `APP_ORIGIN` early. The MusicKit developer token contains the exact browser origin, so an early change disables owner authorization on the still-live hostname.

## Secret placement

Sites secrets:

- `RAILWAY_API_BASE`
- `GATEWAY_KEY_ID`, `GATEWAY_HMAC_SECRET`
- previous gateway key during rotation
- `IP_HASH_SECRET`
- `OWNER_EMAIL`

Railway API secrets:

- current and previous gateway keys
- `APP_ORIGIN`, `OWNER_EMAIL`
- capability pepper and session lifetime
- `DATABASE_URL`
- Apple Team ID, Key ID, Media ID, and full `.p8`, used only to issue the owner's short-lived browser developer token
- the active Apple-token encryption key, key ID, and any temporary decryption keyring entries, used only to encrypt the browser-returned user token

Railway worker secrets:

- `DATABASE_URL`
- dedicated `OPENAI_API_KEY`
- `OPENAI_BRIEF_MODEL`, `OPENAI_FAST_MODEL`, and `OPENAI_DEEP_MODEL`, plus the matching model-specific price variables used by the cost ledger
- fast-profile deadline, hosted-search, token, and Apple matching concurrency limits from `.env.example`
- Apple Team ID, Key ID, Media ID, and full `.p8`
- the same versioned 32-byte Apple-token encryption key and temporary decryption keyring
- optional Resend key

The Discogs adapter is excluded from production at launch, even if a legacy
`DISCOGS_TOKEN` remains configured. `ENABLE_DISCOGS_ADAPTER=true` is available
only for explicit non-production testing while the service terms and operating
limits remain unresolved.

The Apple developer credentials and token-encryption key deliberately exist in both app services for version one: the API needs them for owner authorization, while only the private worker imports the deterministic Apple write path. Research modules never receive an Apple client or write capability.

Back up the Apple `.p8`, Apple-token encryption key, capability pepper, and both gateway keys in the owner's password manager. Never use a `NEXT_PUBLIC_` variable for any secret.

## Release procedure

1. Prepare the semantic release with `pnpm release:new -- patch|minor|major --title "…" --note "…"`. Repeat `--note` for every user-visible change. This bumps `package.json` and prepends the same version, date, and notes shown on `/about`.
2. Review the notes, commit the exact source, create the annotated tag `v<version>`, and run `pnpm release:check:deploy`. A production release is invalid when the package, manifest, or tag disagree.
3. Deploy the exact tagged revision to staging.
4. Run unit, integration, mobile E2E, signed-gateway, anonymous-run, and Apple smoke tests.
5. Verify the production PITR window and a recent worker heartbeat.
6. Pause new research, drain the old worker, then run the expand-compatible schema migrations once through the API pre-deploy step.
7. Deploy API; verify liveness, readiness, schema compatibility, and replay rejection.
8. Deploy worker; verify heartbeat and a reclaimed test lease.
9. Deploy Sites last and run custom-domain and owner-authorization smoke tests.
10. Open `/about` and confirm the web release and API build report the expected version. Then open `/playlists` anonymously and verify pagination, newest-first ordering,
   ordered volume links, an empty/error-safe response, and the absence of
   prompt, run, capability, evidence, cost, manifest-description, and Apple
   library-ID fields. Hide and relist one entry from the owner control and
   confirm both changes are audited.
11. Create the matching GitHub Release from the checked-in patch notes and promote manually. Keep one-release backward compatibility before contract migrations.

`GET /health/live` exposes only the package version and a validated Git commit
revision from the deployment environment. Record its `build.identifier` beside
the successful CI revision during every smoke test; a missing revision is a
deployment-observability failure, not evidence that production matches CI.
The public `/about` page shows this API build separately from the Sites web
release so a partially rolled out deployment is visible instead of being
mistaken for a complete release.

Never run an automatic destructive down-migration. A worker refuses an unsupported schema version.

## Alerts and limits

- Application research ceiling: `$50` per calendar month in `America/Sao_Paulo`.
- OpenAI project alerts: below `$50`, with the provider project scoped only to gênio.
- Railway alerts: `$10`, `$20`, owner review at `$25`; do not stop Postgres automatically.
- Owner notifications: worker stale, database unavailable, budget request, Apple reauthorization, failed/orphaned publication, and outbox backlog.
- Operational metrics: queue depth/age, expired leases, failed jobs, worker heartbeat, reserved/actual spend, Apple authorization, notification backlog/failures, publication failures, orphan playlists, database readiness, and the last retention sweep.

## Degraded behavior

| Failure | Required behavior |
| --- | --- |
| Sites unavailable | Existing Railway jobs continue. |
| API unavailable | No new runs; worker finishes valid leases. |
| Worker stale | API rejects new paid runs; leases become reclaimable. |
| Postgres unavailable | No OpenAI or Apple request starts. |
| OpenAI 429/5xx | Three bounded retries, then durable pause/failure. |
| Apple 401/403 | Preserve manifest, notify owner, wait for reauthorization. |
| Resend unavailable | Keep the outbox; owner dashboard stays authoritative. |
| Monthly ceiling reached | Reject new research; reads and approved publication continue. |

## Recovery and rotation

- Target database RPO: about one minute. Owner-operated RTO: four hours.
- Perform a real PITR restore/cutover drill before beta and quarterly while shared.
- Rotate gateway keys by deploying the new key as current and the old key as previous on both sides, switch Sites, observe, then remove the previous key.
- Rotate the Apple-token master key by decrypting with its recorded version and re-encrypting transactionally with the new version.
- If the capability pepper is lost, invalidate all visitor sessions; published Apple links remain valid.
- Inventory orphan, `[GÊNIO TEST]`, and legacy `[NEEDLE TEST]` playlists in the owner console; deletion from Apple remains an explicit owner action.

## Owner-only data controls

- The owner console can invalidate a completed run's 30-day reuse window without deleting its evidence or published links; the next equivalent confirmed brief creates fresh work.
- A specialist CSV/JSON catalogue may be attached only while research is globally paused and the selected run is quiescent before matching. Each row requires an explicit public HTTPS source, but every production import enters as inferred because gênio has not fetched the linked support; visitors must review it or a later research pass must verify it. Even while normalizing reported corroboration, the parser requires one stable ISRC/MusicBrainz recording ID across two distinct provenance roots, and metadata-only rows remain possible duplicates.
- The browser gateway limits each import batch to 24 KiB. Split larger catalogues into multiple batches and resume research only after the final import succeeds.
