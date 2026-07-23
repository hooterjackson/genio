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

The Sites artifact contains only Sites metadata. Postgres migrations live in
`postgres-migrations/` so Sites cannot mistake them for D1 migrations. Railway
does not run them during an ordinary bridge or activation deploy. The
schema-18 expand plan is the only phase that attaches `pnpm run db:migrate` to
the API pre-deploy command.

The public `/playlists` page is backed by a dedicated Postgres projection, not
by direct reads of private run state. Migration `0010_public_playlist_directory.sql`
creates the projection and backfills only internally consistent terminal
publications with stable Apple share links. The application schema version is
`18`; API and worker readiness must report support through that version before Sites exposes
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
- environment-specific `RELEASE_ENVIRONMENT` and a dedicated
  `RELEASE_CANARY_HMAC_SECRET`; this authenticates synthetic canary markers so
  public users cannot remove their requests from service-level metrics
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

Staging must not reuse production live dependencies. It has its own capped
provider project/key, Apple developer credential set, staging Apple account,
and registered HTTPS MusicKit origin. Every staging Railway plan requires the
non-secret version/evidence hashes that prove those controls differ from
production, and sets `APP_MONTHLY_COST_LIMIT_USD` to an explicit value no
higher than $10. The actual provider and Apple secrets remain environment-local
Railway secrets and never enter the plan, logs, or signed evidence.

The Discogs adapter is excluded from production at launch, even if a legacy
`DISCOGS_TOKEN` remains configured. `ENABLE_DISCOGS_ADAPTER=true` is available
only for explicit non-production testing while the service terms and operating
limits remain unresolved.

The Apple developer credentials and token-encryption key deliberately exist in both app services for version one: the API needs them for owner authorization, while only the private worker imports the deterministic Apple write path. Research modules never receive an Apple client or write capability.

Back up the Apple `.p8`, Apple-token encryption key, capability pepper, and both gateway keys in the owner's password manager. Never use a `NEXT_PUBLIC_` variable for any secret.

## Release procedure

1. Prepare the semantic release with `pnpm release:new -- patch|minor|major --title "…" --note "…"`. Repeat `--note` for every user-visible change. This bumps `package.json` and prepends the same version, date, and notes shown on `/about`.
2. Review and commit the exact source. Create an annotated `v<version>-rc.N` tag; do not create the stable tag yet.
3. Build the candidate with `.github/workflows/release-candidate.yml`. After
   the workflow exists on the default branch, use its manual dispatch. For the
   first release only, `workflow_dispatch` is not discoverable yet: pushing the
   reviewed annotated RC tag safely bootstraps the tag-triggered workflow from
   that commit. The workflow builds, attests, and publishes only an immutable
   candidate image; it contains no Railway or Sites deploy step. Do not merge
   the application release merely to bootstrap the workflow, and do not use a
   mutable branch tag.
4. Select the staging Railway environment. Set the exact image digest,
   full revision, stable version, `GENIO_RELEASE_ENVIRONMENT=staging`, the
   dedicated staging controls, `GENIO_RELEASE_PHASE=bridge`, and the observed
   pre-migration schema. Run and review the exact `railway config plan`; apply
   only that reviewed plan. The bridge deploys the same schema-13–18-capable
   artifact to the API and both worker lanes with no migration. Preserved
   contract-3/query-plan-4 cohort settings remain inert behind the phase fence.
5. Run `pnpm release:migration:verify -- --phase bridge ...`. It must observe
   two advancing protocol-10 heartbeats for both worker lanes, only the RC
   revision/configuration, current schema readiness, and no canonical/schema-4
   emission. Use its evidence hash in a new exact Railway plan with
   `GENIO_RELEASE_PHASE=expand` and expected schema 18. This is the only plan
   that runs the expand-compatible migration.
6. Run the migration verifier again with `--phase expand --expected-schema 18`.
   Only after it proves schema 18, both worker lanes, and canonical emission
   still off may a third reviewed plan set `GENIO_RELEASE_PHASE=activate`.
   The API checks the authoritative database schema again before creating any
   contract-3 brief.
7. Run unit, database integration, mobile E2E, signed-gateway, anonymous-run,
   manifest-only provider, governed-evidence-v2, owner 301/1,000 admission, and
   bounded Apple publication gates. The hosted smoke requires the RC source
   revision, version, safe canary ID, and the dedicated staging dependencies.
8. Build and sign candidate evidence with `pnpm release:evidence -- sign ...`.
   The strict schema requires a positive capped QA budget with enough remaining
   reservation for every staging live gate, distinct staging/production
   provider and Apple secret-version hashes, Apple-account separation evidence,
   and registered staging MusicKit-origin evidence. There is no budget waiver:
   an exhausted budget or a skipped live gate makes the payload unsignable.
   Then run `release:evidence verify --expected-kind candidate` with the exact
   RC tag, revision, image digest, configuration hash, and runtime hash. Record
   the successful command's `payloadHash` as
   `GENIO_VERIFIED_CANDIDATE_EVIDENCE_HASH`.
9. Repeat bridge → verify → expand → verify → activate with the exact same
   digest in the production environment. Every production plan requires
   `GENIO_VERIFIED_CANDIDATE_EVIDENCE_HASH`; expand also requires the same value
   as `GENIO_BRIDGE_VERIFIED_CANDIDATE_EVIDENCE_HASH`, and activate requires
   both bridge and `GENIO_EXPAND_VERIFIED_CANDIDATE_EVIDENCE_HASH` lineage
   values. Railway checks SHA-256 shape and phase-to-phase equality; it does not
   re-verify the signature. Then run the owner-only fixed three-track and
   affected-regression canaries. Keep public cohorts on the last proven route
   until both pass.
10. Verify the production PITR window, schema-18 readiness, and two fresh
   protocol-10 heartbeats for both worker lanes. Pause or drain only work
   incompatible with the migration; never reinterpret in-flight contracts.
11. Switch backend cohorts only after both production canaries pass. Deploy the exact Sites source revision last.
12. Open `/about` and confirm the web release and API build report the expected version. Then open `/playlists` anonymously and verify pagination, newest-first ordering,
   ordered volume links, an empty/error-safe response, and the absence of
   prompt, run, capability, evidence, cost, manifest-description, and Apple
   library-ID fields. Hide and relist one entry from the owner control and
   confirm both changes are audited.
13. Collect convergence evidence, run the final `9enio.com` browser smoke, and verify the signed promotion evidence against the exact revision, image digest, and RC tag. Only then create the stable annotated `v<version>` tag and matching GitHub Release.

`GET /health/live` exposes only the package version and a validated Git commit
revision from the deployment environment. Record its `build.identifier` beside
the successful CI revision during every smoke test; a missing revision is a
deployment-observability failure, not evidence that production matches CI.
The public `/about` page shows this API build separately from the Sites web
release so a partially rolled out deployment is visible instead of being
mistaken for a complete release.

Do not declare convergence from a single liveness response. After Railway's
overlap window and the Sites publish complete, collect two cache-busted samples:

```sh
pnpm release:convergence -- \
  --origin https://9enio.com \
  --expected-version "$RELEASE_VERSION" \
  --expected-revision "$RELEASE_SHA"
```

The read-only probe fails unless the Sites version marker, API build, schema
18, protocol 10, brief contract 3, query-plan schema 4, database readiness,
interactive worker lane, and deep worker lane remain on the expected artifact
in both samples. Its JSON output includes only
allowlisted release metadata, queue counters, an expiring timestamp, and a
deterministic evidence hash; it contains no response bodies, prompts,
credentials, worker IDs, or capability data. The hash is an integrity digest,
not a signature. Bind its hash into the promotion payload, then sign and verify
the strict envelope:

```sh
pnpm release:evidence -- sign \
  --input promotion-evidence.json \
  --output promotion-evidence.signed.json \
  --private-key "$RELEASE_SIGNING_KEY_FILE" \
  --key-id "$RELEASE_SIGNING_KEY_ID"

pnpm release:evidence -- verify \
  --input promotion-evidence.signed.json \
  --public-key "$RELEASE_VERIFICATION_KEY_FILE" \
  --expected-kind promotion \
  --expected-revision "$RELEASE_SHA" \
  --expected-image-digest "$RELEASE_IMAGE_DIGEST" \
  --expected-tag "$RELEASE_RC_TAG" \
  --expected-configuration-hash "$RELEASE_CONFIGURATION_HASH" \
  --expected-runtime-hash "$RELEASE_RUNTIME_HASH"
```

Evidence expires within 24 hours. Any source, image, behavior-affecting
configuration, secret-version set, model route, policy, schema, or protocol
change requires new evidence. The signing command prints the aggregate
configuration and runtime hashes; verification requires both so a correctly
signed envelope for a prior model route or cohort configuration cannot promote
a changed runtime. This schema-18/protocol-10 release contract also requires
`adaptive_guidance_v3` and `governed_evidence_v2`; a legacy policy label makes
the payload unsignable. Verification requires the caller to name the expected
`candidate` or `promotion` kind, so a staging-only candidate envelope can never
satisfy the production promotion command.

Never run an automatic destructive down-migration. A worker refuses an
unsupported schema version. After schema-18 writes, binary rollback to the old
max-schema-16 release is forbidden. Roll back behavior by setting the affected
cohort to zero and redeploying this same schema-13–18-compatible artifact in
`bridge` phase; it stops new canonical/schema-4 emission while remaining able
to drain compatible schema-18 work.

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
