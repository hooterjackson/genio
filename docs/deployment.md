# Deployment and operations

## Topology

Use two Railway projects: `needle-qa` for the isolated staging environment and
`needle` for production. Each project has its own Postgres, API, and worker
services; service IDs, environment IDs, credentials, provider projects, Apple
accounts, and budgets are independently attested.

| Service | Exposure | Config | Responsibility |
| --- | --- | --- | --- |
| Sites | Public custom domain | `.openai/hosting.json` | UI, owner identity, client bucket, signed gateway |
| `needle-api` | Public Railway HTTPS | `.railway/railway.ts` | Validate/enqueue/read state |
| `needle-worker` | Railway private network | `.railway/railway.ts` | Durable paid jobs and deterministic publication |
| Postgres | Railway private network | `.railway/railway.ts` | Authoritative state, leases, cost ledger |

Sites cannot address Railway's private network, so only the API receives a Railway public domain. The API accepts the fixed `/api/v1` route allowlist only after validating the Sites HMAC. Do not expose the worker.

## One-time setup

1. Create a private source repository and require tests and build checks before merge.
2. Create the separate `needle-qa` staging and `needle` production Railway
   projects, each with its own environment, Postgres, API, and workers.
3. Give both app services the internal `DATABASE_URL`; give only the API a public Railway domain.
4. Preview and apply `.railway/railway.ts` separately while linked to each
   project; it emits only the selected release environment and is the sole
   Railway configuration source for both services and Postgres.
5. Enable seven-day Postgres point-in-time recovery before sharing the URL.
6. Create the Sites project, attach the chosen custom domain, and set Sites gateway secrets.
7. Add DNS records for Sites and Resend. Set Apple Music browser origins to the exact HTTPS custom origin.
8. Configure UptimeRobot checks for the custom domain and the Railway API's `/health/system` endpoint.

The Sites artifact contains only Sites metadata. Postgres migrations live in
`postgres-migrations/` so Sites cannot mistake them for D1 migrations. Railway
does not run them during an ordinary bridge or activation deploy. The
schema-18 expand plan attaches `pnpm run db:migrate` to the API pre-deploy
command for an existing environment. A one-time fresh-staging bootstrap uses
the same command only after an operator explicitly confirms that the new
staging database is empty; production rejects that phase.

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
- `OWNER_EMAIL` and a non-secret `OWNER_ALLOWLIST_VERSION` that is bumped
  whenever the allowlist changes

Railway API secrets:

- current and previous gateway keys
- `APP_ORIGIN`, `OWNER_EMAIL`, and the same non-secret
  `OWNER_ALLOWLIST_VERSION`
- environment-specific `RELEASE_ENVIRONMENT` and a dedicated
  `RELEASE_CANARY_HMAC_SECRET`; this authenticates synthetic canary markers so
  public users cannot remove their requests from service-level metrics
- current capability pepper, its non-secret version label, and session
  lifetime; during a bounded rotation, the verification-only previous pepper,
  its distinct version label, and its removal deadline
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
higher than $75. The 73-submission historical replay reserves $59.25 at the
unchanged per-run ceilings and the other required canaries reserve $3, for
$62.25 committed total and $12.75 of bounded retry margin. Budget exhaustion
blocks promotion; it never waives a live gate. The actual provider and Apple
secrets remain environment-local Railway secrets and never enter the plan,
logs, or signed evidence.

The Discogs adapter is excluded from production at launch, even if a legacy
`DISCOGS_TOKEN` remains configured. `ENABLE_DISCOGS_ADAPTER=true` is available
only for explicit non-production testing while the service terms and operating
limits remain unresolved.

The Apple developer credentials and token-encryption key deliberately exist in both app services for version one: the API needs them for owner authorization, while only the private worker imports the deterministic Apple write path. Research modules never receive an Apple client or write capability.

Back up the Apple `.p8`, Apple-token encryption key, current capability pepper,
and both gateway keys in the owner's password manager. Never use a
`NEXT_PUBLIC_` variable for any secret. Capability-pepper version labels are
non-secret, but only their hashes appear in public runtime and release
identity. The `capabilitySession` entry in release secret-version evidence
must identify the exact current/previous version set and deadline without
containing either pepper.

Every secret rotation must atomically rotate its non-secret version label and
the aggregate `GENIO_RELEASE_SECRET_VERSIONS_HASH`. Railway exposes that
aggregate to the application as `RELEASE_SECRET_VERSIONS_HASH`; runtime
snapshots and control-plane evidence bind it, but no release producer reads,
logs, or signs the raw secret values.

## Release procedure

Use the create-only, self-verifying commands in
[`release-artifact-authoring.md`](./release-artifact-authoring.md) to produce
protected baseline, finalization-source, bootstrap, authorization, and bounded
dispatch artifacts. Those commands never dispatch or publish.

1. Prepare the semantic release with `pnpm release:new -- patch|minor|major --title "…" --note "…"`. Repeat `--note` for every user-visible change. This bumps `package.json` and prepends the same version, date, and notes shown on `/about`.
2. Review the pull request and require every named branch check to pass. Merge
   through the protected default branch. Create an annotated
   `v<version>-rc.N` tag that points to that exact merge commit; do not create
   the stable tag yet.
3. Dispatch `.github/workflows/release-candidate.yml` through GitHub's
   repository-dispatch API from an administrator or maintainer account:

   ```sh
   gh api repos/hooterjackson/genio/dispatches \
     -f event_type=genio-release-candidate \
     -F 'client_payload[candidate_tag]=v<version>-rc.N'
   ```

   Repository dispatch loads the workflow only from the protected default
   branch. The job independently proves that the annotated tag is the current
   default-branch merge commit and that every required check is green. A tag
   push alone never executes release code. Candidate validation, database
   tests, Playwright engine installation, browser tests, and the stitched
   system test run on a fresh job with only `contents: read`. The protected
   `release-candidate` environment and its package/OIDC/attestation write
   permissions exist only on a later fresh publishing job that has fail-closed
   `needs` edges to both authorization and validation. Browser downloads and
   candidate test processes therefore never share a runner, workspace, or
   token with registry or attestation authority. The publishing job builds
   only `linux/amd64` without pushing, immediately rechecks stable-version
   monotonicity and the exact immutable predecessor, then pushes that already
   built image and attests its resulting digest. Release-candidate, stable,
   and one-time predecessor-bootstrap workflows share the
   `stable-release-mutation` concurrency lock, so their final mutation windows
   cannot overlap. The candidate workflow contains no Railway or Sites deploy
   step.

   Both container roots are immutable: the application Dockerfile pins the
   reviewed Node 22.19 Alpine OCI index digest and CI/RC/Compose pin the
   reviewed Postgres 17 Alpine OCI index digest. A tag-only image reference is
   a release failure even when the tag presently resolves to the same bytes.

   The offline-suite artifact is signed keylessly with GitHub's Actions OIDC
   identity and a Sigstore artifact attestation. The workflow immediately
   verifies the artifact digest, repository, signer workflow, default-branch
   source ref and digest, predicate type, and GitHub-hosted runner before
   uploading the verification bundle. No repository-managed producer private
   key is exposed to candidate-controlled code. The protected release evidence
   signer must independently verify that uploaded GitHub bundle before issuing
   the offline-suite producer attestation; if that trusted signer is
   unavailable, stop rather than substituting a workflow secret.

   ```sh
   pnpm release:offline-attestation:verify -- \
     --artifact release-offline-suite.json \
     --bundle release-offline-suite.github-attestation.json \
     --binding release-offline-suite.github-binding.json
   ```

   This verifier invokes `gh attestation verify` with the repository, signer
   workflow, source ref/SHA, OIDC issuer, SLSA predicate, GitHub-hosted-runner,
   and GitHub Sigstore trust roots pinned. It also recomputes the exact uploaded
   artifact digest before returning the evidence hash to the protected signer.
   The protected signer then performs the same verification and atomically
   issues the required detached producer attestation:

   ```sh
   pnpm release:offline-attestation:authorize -- \
     --confirm-protected-offline-authorization \
     --artifact release-offline-suite.json \
     --github-bundle release-offline-suite.github-attestation.json \
     --github-binding release-offline-suite.github-binding.json \
     --output release-offline-suite.producer-attestation.json \
     --producer-signing-key "$RELEASE_GATE_PRODUCER_PRIVATE_KEY" \
     --producer-key-id "$RELEASE_GATE_PRODUCER_KEY_ID"
   ```

   This authorization command belongs only in the protected release-signing
   environment. The GitHub workflow never receives the producer private key,
   and the signing bundle requires both the GitHub bundle/binding and this
   detached attestation.
4. Select the staging Railway environment. If this is a newly-created
   environment whose Postgres database is known to be fresh and empty, first
   review a one-time plan using the exact candidate image with
   `GENIO_RELEASE_PHASE=bootstrap`,
   `GENIO_EXPECTED_DATABASE_SCHEMA_VERSION=18`, and
   `GENIO_STAGING_BOOTSTRAP_FRESH_EMPTY_DATABASE_CONFIRMED=true`. Also bind
   `GENIO_STAGING_BOOTSTRAP_PROJECT_ID` and
   `GENIO_STAGING_BOOTSTRAP_ENVIRONMENT_ID` to the selected empty environment;
   supply independent bootstrap-only gateway/capability secrets and their
   version labels, plus protected SHA-256 fingerprints proving neither secret
   equals production. Apply only that reviewed staging plan. It runs the API
   migration pre-deploy while both worker lanes remain at zero replicas; the
   runtime rejects every mutating `/api/v1` request and any accidentally
   started worker. Bootstrap emits no preserved variables and rejects inherited
   database URLs, provider/Apple credentials, gateway/capability credentials,
   and promotion evidence. Do not continue
   until `/health/ready` reports schema 18,
   `releaseManifestCanaryGuardsVersion: "1"`, and
   `canonicalExecutionHardeningVersion: "1"`. Production rejects bootstrap,
   and the fresh/empty confirmation is invalid in every later phase.

   Unset the bootstrap confirmation, configure the dedicated staging controls,
   and retain the exact same image digest, full revision, and stable version.
   Set `GENIO_RELEASE_ENVIRONMENT=staging`, `GENIO_RELEASE_PHASE=bridge`, and
   the observed schema. Run and review the exact `railway config plan`; apply
   only that reviewed plan. The bridge deploys the same schema-13–18-capable
   artifact to the API and both worker lanes with no migration. Preserved
   canonical contract/query-plan-4-or-5 cohort settings remain inert behind
   the phase fence.
5. Run `pnpm release:migration:verify -- --phase bridge
   --expected-capability <none-or-2>
   --expected-manifest-canary-guards <none-or-1>
   --expected-canonical-hardening <none-or-1> ...`. All three values must be
   `none` for schemas 13–17; schema 18 requires `2`, `1`, and `1`. It must observe
   two advancing protocol-10 heartbeats for both worker lanes, only the RC
   revision/configuration, current schema readiness, and no canonical/schema-4/5
   emission across at least 30 seconds. The protected phase-evidence producer
   is `pnpm release:phase-evidence:produce`; it takes the same explicit schema
   and three independent capability values and must bind those observations
   to the exact candidate payload hash, image, source, three-service
   configuration aggregate, runtime protocol, and observed database
   schema/composite capability/authoritative markers, then sign the result.
   Supply that file as
   `GENIO_BRIDGE_CONVERGENCE_EVIDENCE_FILE` together with the exact signed
   bridge configuration/schema/composite-capability/both-marker bindings in a
   new Railway plan with `GENIO_RELEASE_PHASE=expand` and expected schema 18.
   A bare observation hash is not promotion evidence. This is the only plan
   that runs the expand-compatible migration.
6. Run the migration verifier again with `--phase expand --expected-schema 18
   --expected-capability 2 --expected-manifest-canary-guards 1
   --expected-canonical-hardening 1`.
   Only after it proves schema 18, both worker lanes, and canonical emission
   still off may the protected producer collect the activation preflight in a
   read-only repeatable-read transaction. The fixed complete query must prove
   every affected DB cohort is disabled, including the global catalog-first V2
   control, while no DB control blocks the intended owner V3 genre-scene route.
   The signed preflight database-identity digest must equal the pinned
   `GENIO_PRODUCTION_DATABASE_IDENTITY_HASH` for the selected Railway
   environment; evidence from another database is rejected.
   It then signs the expand evidence with every public V2/V3 percentage fixed
   at zero, only the authenticated owner candidate route enabled, composite
   capability 2, both authoritative marker-1 expectations, and
   `PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION=5`. Supply
   that envelope as `GENIO_EXPAND_CONVERGENCE_EVIDENCE_FILE`; only then may a
   third reviewed plan set `GENIO_RELEASE_PHASE=activate`. Railway derives
   literal rollout and activation variables from this signed preflight, so
   stale preserved percentages or an out-of-band query-plan value cannot leak
   traffic. The API independently checks the signed composite expectation and
   both authoritative database markers again before creating any contract-3
   brief.
7. Run unit, database integration, mobile E2E, signed-gateway, anonymous-run,
   manifest-only provider, governed-evidence-v2, owner 301/1,000 admission, and
   bounded Apple publication gates. The hosted smoke requires the RC source
   revision, version, safe canary ID, and the dedicated staging dependencies.
   The provider manifest gate must use the authenticated staging-only shadow
   runner; it executes the live V3 discovery/qualification portfolio through
   an exact hash-locked qualified selection, but the durable run marker,
   worker stage fence, repository queue guard, and evidence endpoint all reject
   matching/publication work:

   ```sh
   RELEASE_CANARY_HMAC_SECRET="$STAGING_RELEASE_CANARY_HMAC_SECRET" \
   RELEASE_STAGING_ORIGIN="$STAGING_ORIGIN" \
   pnpm smoke:manifest:staging -- \
     --confirm-live-provider \
     --origin "$STAGING_ORIGIN" \
     --fixture-id smooth-reggaeton-heat-50-v1 \
     --candidate-tag "$RELEASE_RC_TAG" \
     --expected-revision "$RELEASE_SHA" \
     --expected-version "$RELEASE_VERSION" \
     --image-digest "$RELEASE_IMAGE_DIGEST" \
     --cache-mode reuse_disabled \
     --runtime-snapshot "$STAGING_RUNTIME_SNAPSHOT" \
     --source-output "$STAGING_MANIFEST_SOURCE" \
     --output "$STAGING_MANIFEST_GATE" \
     --attestation-output "$STAGING_MANIFEST_ATTESTATION" \
     --producer-signing-key "$RELEASE_GATE_PRODUCER_PRIVATE_KEY" \
     --producer-key-id "$RELEASE_GATE_PRODUCER_KEY_ID"
   ```

   The command accepts only the exact 50-track Smooth Reggaeton Heat
   code-owned fixture and its recommended typed guidance revision. It fails unless
   the result is exact, every execution attempt uses the expected revision,
   and the database-fenced publication boundary proves zero manifest rows,
   matching jobs, publication jobs, and publication volumes. This is a
   measured write boundary, not a claim that the normal worker binary lacks
   publication code. `reuse_disabled` means only that gênio's
   result reuse is disabled; it makes no unverified claim about provider
   caches. The CLI signs release-canary metadata only after `--origin` exactly matches
   `RELEASE_STAGING_ORIGIN`. It never accepts `9enio.com` as its origin
   and the server rejects the mode outside `RELEASE_ENVIRONMENT=staging`.

   Replay every retained failed submission through the activated staging
   browser before any playlist publication canary. The private corpus remains
   outside release artifacts; only the pinned commitment
   `cec24d3d2c78185ccf1fcb8dfe646193c83ef7f26819f473bca34cd6fbc5eefd`
   and aggregate counters are signed:

   ```sh
   RELEASE_STAGING_ORIGIN="$STAGING_ORIGIN" \
   RELEASE_PRODUCTION_ORIGIN="https://9enio.com" \
   pnpm qa:historical-browser-replay -- \
     --confirm-staging-writes \
     --origin "$STAGING_ORIGIN" \
     --corpus "$PRIVATE_HISTORICAL_REPLAY_CORPUS" \
     --runtime-snapshot "$STAGING_RUNTIME_SNAPSHOT" \
     --staging-control-plane-evidence "$STAGING_CONTROL_PLANE_EVIDENCE" \
     --staging-control-plane-verification-key "$STAGING_CONTROL_PLANE_PUBLIC_KEY" \
     --staging-control-plane-trust-policy "$STAGING_CONTROL_PLANE_TRUST_POLICY" \
     --canary-hmac-key "$STAGING_RELEASE_CANARY_HMAC_KEY_FILE" \
     --output "$HISTORICAL_REPLAY_EVIDENCE" \
     --producer-signing-key "$HISTORICAL_REPLAY_PRIVATE_KEY" \
     --producer-key-id "$HISTORICAL_REPLAY_KEY_ID" \
     --candidate-tag "$RELEASE_RC_TAG" \
     --expected-version "$RELEASE_VERSION" \
     --expected-revision "$RELEASE_SHA" \
     --image-digest "$RELEASE_IMAGE_DIGEST" \
     --max-concurrency 4 \
     --per-run-budget-cap-usd 3

   RELEASE_STAGING_ORIGIN="$STAGING_ORIGIN" \
   RELEASE_PRODUCTION_ORIGIN="https://9enio.com" \
   RELEASE_HISTORICAL_REPLAY_KEY_ID="$HISTORICAL_REPLAY_KEY_ID" \
   RELEASE_HISTORICAL_REPLAY_KEY_SHA256="$HISTORICAL_REPLAY_PUBLIC_KEY_SHA256" \
   pnpm release:historical-browser-replay:produce -- \
     --origin "$STAGING_ORIGIN" \
     --candidate-tag "$RELEASE_RC_TAG" \
     --expected-version "$RELEASE_VERSION" \
     --expected-revision "$RELEASE_SHA" \
     --image-digest "$RELEASE_IMAGE_DIGEST" \
     --runtime-snapshot "$STAGING_RUNTIME_SNAPSHOT" \
     --staging-control-plane-evidence "$STAGING_CONTROL_PLANE_EVIDENCE" \
     --staging-control-plane-verification-key "$STAGING_CONTROL_PLANE_PUBLIC_KEY" \
     --staging-control-plane-trust-policy "$STAGING_CONTROL_PLANE_TRUST_POLICY" \
     --historical-replay-evidence "$HISTORICAL_REPLAY_EVIDENCE" \
     --historical-replay-verification-key "$HISTORICAL_REPLAY_PUBLIC_KEY" \
     --historical-replay-trust-policy "$HISTORICAL_REPLAY_TRUST_POLICY" \
     --source-output "$HISTORICAL_REPLAY_SOURCE" \
     --output "$HISTORICAL_REPLAY_GATE" \
     --attestation-output "$HISTORICAL_REPLAY_GATE_ATTESTATION" \
     --producer-signing-key "$RELEASE_GATE_PRODUCER_PRIVATE_KEY" \
     --producer-key-id "$RELEASE_GATE_PRODUCER_KEY_ID"
   ```

   The replay is exactly 73 submissions, including duplicate prompts. It
   reserves $59.25 at unchanged public count-tier ceilings plus $3 for the
   other required canaries. Only exact original/guided results, a visible
   actionable decision, or a durable dependency retry count as bounded
   outcomes. Result reuse is disabled, prompt/count bytes are intercepted,
   and traces, screenshots, videos, raw prompts, user/run IDs, capabilities,
   and Apple playlist identifiers are forbidden from the signed aggregate.
   The `staging_historical_replay` gate uses a signing key distinct from the
   release-gate producer. Its key ID and SPKI fingerprint must match protected
   release-authority pins both when producing the gate and when signing release
   evidence; an embedded self-approved key is rejected. The gate is mandatory
   in candidate, promotion, and finalization evidence.
8. Generate the authoritative live configuration/runtime blocks before signing:

   ```sh
   pnpm release:snapshot -- \
     --origin "$STAGING_ORIGIN" \
     --environment staging \
     --scope full \
     --expected-revision "$RELEASE_SHA" \
     --expected-version "$RELEASE_VERSION" \
     --secret-versions release-secret-versions.json \
     --output release-runtime-snapshot.json
   ```

   `release-secret-versions.json` contains only named SHA-256 credential-version
   digests, never credentials. The command fails unless the Sites version and
   full source-revision markers, API build/configuration hash, schema-18
   runtime, and the sole eligible worker/configuration in both lanes all match
   the candidate. The evidence signing bundle names that exact runtime snapshot
   and one
   exact-parsed gate-artifact file per required gate; it never accepts a
   hand-authored `gates[].evidenceHash`. It also names a detached producer
   attestation for every gate. Then sign candidate evidence with
   `pnpm release:evidence -- sign ... --producer-public-key ...`.
   For `semantic_ranking_blinded_review`, the protected signer must set
   the five `RELEASE_SEMANTIC_BASELINE_*` pins to the values derived from the
   greatest immutable, published stable-semver GitHub Release below the RC:
   exact stable tag and metadata hash, historical release-key fingerprint, and
   historical stable-authorizer key ID/fingerprint. The release and
   stable-authorizer fingerprints must be different. The gate must carry the
   privacy-safe `genio-semantic-ranking-protected-baseline/v2` metadata and
   the immutable release's signed finalization evidence, signed stable
   authorization, both fingerprint-matching public keys, and derived consumer
   manifest, along with the randomized two-arm package and separate unblinding
   mapping. The historical verifier evaluates expiration at the signed stable
   authorization time, so legitimately expired old evidence remains usable;
   it still rejects a signature that was invalid or non-overlapping then,
   future-dated lineage, or any stable tag/source/image/final-browser/fixture
   hash mismatch.
   These inputs must come from the exact
   `genio-semantic-baseline-handoff/v2` directory preserved in the successful
   RC candidate artifact. The directory has exactly the five immutable
   GitHub-Release asset bytes, the two historical public-key byte strings, the
   fresh predecessor GitHub attestation-verification JSON, and its
   candidate-bound manifest. The manifest also binds the exact predecessor
   mode/controller revision and verification byte hash. Set
   `RELEASE_SEMANTIC_BASELINE_HANDOFF_SHA256` from the RC workflow output and
   pass that directory with `--protected-baseline-handoff-directory`; the
   semantic producer no longer accepts independently selected baseline files.
   The two historical public-key files originate from the protected
   `RELEASE_SEMANTIC_BASELINE_RELEASE_PUBLIC_KEY_B64URL` and
   `RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_PUBLIC_KEY_B64URL` GitHub
   secrets and must never be sourced from repository variables.
   The review/attestation v2 hashes bind every baseline and candidate ordered
   manifest/output. An operator-selected baseline SHA, swapped arm, modified
   mapping, self-authored metadata repin, older unproven release, reused
   authority key, or output hash not present in the blinded package fails
   before release evidence can be signed. Repository variables are not the
   authority for predecessor selection.
   The strict schema requires a positive capped QA budget with enough remaining
   reservation for every staging live gate, distinct staging/production
   provider and Apple secret-version hashes, Apple-account separation evidence,
   and registered staging MusicKit-origin evidence. The GitHub Actions budget
   now available must still be represented by a fresh independently signed
   QA-budget-ledger receipt consumed by
   `pnpm release:staging-control-plane:produce`; an operator assertion that
   budget exists is never accepted. That producer also binds the isolated
   `needle-qa` project, exact Railway service inventory and immutable image,
   staging Apple verifier credential identity, provider project identity, and
   the deployed secret-version aggregate. There is no budget waiver: an
   exhausted budget, stale receipt, identity overlap, or skipped live gate
   makes the payload unsignable.
   Then run `release:evidence verify --expected-kind candidate` with the exact
   RC tag, revision, image digest, configuration hash, and runtime hash. Record
   the successful command's `payloadHash` as
   `GENIO_VERIFIED_CANDIDATE_EVIDENCE_HASH`.
9. Repeat bridge → verify → expand → verify → activate with the exact same
   digest in the production environment. Every production plan requires the
   complete signed candidate file, its exact payload hash, the exact signed
   candidate configuration/runtime hashes, the release RC tag, and the
   verification public key pinned by SHA-256. Railway runs the shared strict
   candidate validator and re-verifies the Ed25519 signature and 24-hour
   validity window during plan evaluation.

   Expand additionally requires the signed bridge convergence file plus its
   signed configuration and observed schema/composite-capability/both-marker
   bindings. Activate
   requires both that file and the signed expand/preflight file plus its
   configuration binding. Railway verifies each phase signature, candidate
   lineage, image, source, protocol, schema, composite capability, both
   authoritative markers, advancing heartbeats, and lack of old eligible
   workers; arbitrary convergence-hash or
   prior-image environment values are not accepted. If the protected producer,
   database preflight, or any envelope is unavailable or expired, stop—the plan
   intentionally cannot activate. Then run the owner-only fixed three-track and
   affected-regression canaries. Keep public cohorts on the last proven route
   until both pass. Capture the pre-Sites production snapshot with
   `release:snapshot -- --environment production --scope backend`; it binds the
   candidate API/workers and the signed prior Sites identity without claiming
   that Sites already runs the candidate. Use that snapshot, the promotion-phase
   control-plane receipt, convergence, and production canaries to sign and
   verify `promotion` evidence. Promotion evidence deliberately excludes the
   final custom-domain browser gate.
10. Verify the production PITR window, schema-18 readiness, and two fresh
   protocol-10 heartbeats for both worker lanes. Pause or drain only work
   incompatible with the migration; never reinterpret in-flight contracts.
11. Keep all public cohorts at zero after owner-only activation. Produce a
   protected intent canary first with
   `pnpm release:rollout:intent-canary:produce`. It requires five separately
   signed, fresh authority artifacts: the actual owner-candidate assignment
   receipt, the exact completed manifest/count/order receipt, independent
   Apple API readback, independent browser accessibility/visible-content
   evidence, and DB-derived intent-window metrics/invariant counters. Their
   Ed25519 keys, the canary-producer key, and the rollout/release key must all
   be separately pinned and distinct. The producer cross-binds candidate,
   intent, adjacent stage, target configuration, fixture, API/worker/executor
   identity, manifest count/order, Apple order, browser contents, and database
   denominators before signing; operator-authored JSON or a canary signed with
   the rollout release key is rejected. Feed that exact canary and its
   separately pinned public key to `pnpm release:rollout:evidence:produce`,
   then apply a separate reviewed
   `GENIO_RELEASE_PHASE=rollout` Railway plan. Each intent must advance
   `0 → 1 → 10 → 50 → 100`; a signed emergency rollback may move only the
   affected intent directly to zero. An advance plan must carry
   `GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_FILE`, its exact payload hash,
   verification-key file, protected key ID, SPKI fingerprint, and the authority
   policy hash embedded during release-candidate image finalization. The
   rollout pre-deploy rejects any editable-environment policy that differs from
   the image. Rollback
   consumes only the embedded prior canary hash and warrant; it never accepts
   a fresh canary. Every later step names the immediately previous signed
   rollout envelope.
12. Before requesting the Sites candidate deployment, query the Sites control
    plane for the exact currently live saved version and deployment, then run
    `pnpm release:sites-rollback:capture` as described below. The captured
    target must bind the prior version ID/number/commit/archive, prior
    deployment ID, and a fresh no-store live build observation. Only after that
    create or select the exact saved candidate version and deploy it last.
    Preserve the opaque target and candidate version/deployment IDs.
13. Open `/about` and confirm the web release and API build report the expected version. Then open `/playlists` anonymously and verify pagination, newest-first ordering,
   ordered volume links, an empty/error-safe response, and the absence of
   prompt, run, capability, evidence, cost, manifest-description, and Apple
   library-ID fields. Hide and relist one entry from the owner control and
   confirm both changes are audited.
14. Require the protected Sites control plane to sign a
    `genio-sites-control-plane-deployment/v2` receipt containing the predeploy
    rollback target, exact candidate version ID/number/archive/deployment,
    deployment request time, and ready observation. Capture a new production
    `--scope full` runtime snapshot, run the final
    `9enio.com` browser producer, and sign and verify `finalization` evidence
    against the exact revision, image digest, and RC tag. Full scope requires
    the Sites build marker, owner-allowlist version, and configuration to match
    the candidate. Finalization must use newly observed, independently signed
    Apple, provider-project, and QA-budget authority sources. Convert each
    source into a fresh receipt with the corresponding
    `release:receipt:*:produce` command using `--phase finalization`, the
    staging snapshot, and the new full production snapshot. Then run
    `release:staging-control-plane:produce -- --phase finalization` with those
    three receipts, the candidate evidence, and both snapshots. Promotion
    receipts or the earlier backend-scoped production snapshot cannot be
    replayed. The receipt CLIs do not poll Apple, the provider, or the budget
    ledger and cannot turn operator JSON into authority: each `--authority-source`
    must already be an exact, fresh envelope signed by that independent
    authority's separately pinned source key.

    In the isolated stable-authorizer environment, issue the separate
    authorization:

    ```sh
    RELEASE_VERIFICATION_KEY_SHA256="$RELEASE_VERIFICATION_KEY_SHA256" \
    RELEASE_GATE_PRODUCER_KEY_ID="$RELEASE_GATE_PRODUCER_KEY_ID" \
    RELEASE_GATE_PRODUCER_KEY_SHA256="$RELEASE_GATE_PRODUCER_KEY_SHA256" \
    RELEASE_SEMANTIC_REVIEWER_KEY_ID="$RELEASE_SEMANTIC_REVIEWER_KEY_ID" \
    RELEASE_SEMANTIC_REVIEWER_KEY_SHA256="$RELEASE_SEMANTIC_REVIEWER_KEY_SHA256" \
    RELEASE_SEMANTIC_BASELINE_METADATA_SHA256="$RELEASE_SEMANTIC_BASELINE_METADATA_SHA256" \
    RELEASE_SEMANTIC_BASELINE_STABLE_TAG="$RELEASE_SEMANTIC_BASELINE_STABLE_TAG" \
    RELEASE_SEMANTIC_BASELINE_RELEASE_KEY_SHA256="$RELEASE_SEMANTIC_BASELINE_RELEASE_KEY_SHA256" \
    RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_ID="$RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_ID" \
    RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_SHA256="$RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_SHA256" \
    RELEASE_SITES_CONTROL_PLANE_KEY_ID="$RELEASE_SITES_CONTROL_PLANE_KEY_ID" \
    RELEASE_SITES_CONTROL_PLANE_KEY_SHA256="$RELEASE_SITES_CONTROL_PLANE_KEY_SHA256" \
    RELEASE_STAGING_CONTROL_PLANE_KEY_ID="$RELEASE_STAGING_CONTROL_PLANE_KEY_ID" \
    RELEASE_STAGING_CONTROL_PLANE_KEY_SHA256="$RELEASE_STAGING_CONTROL_PLANE_KEY_SHA256" \
    RELEASE_APPLE_CONTROL_PLANE_ISSUER="$RELEASE_APPLE_CONTROL_PLANE_ISSUER" \
    RELEASE_APPLE_CONTROL_PLANE_KEY_ID="$RELEASE_APPLE_CONTROL_PLANE_KEY_ID" \
    RELEASE_APPLE_CONTROL_PLANE_KEY_SHA256="$RELEASE_APPLE_CONTROL_PLANE_KEY_SHA256" \
    RELEASE_PROVIDER_CONTROL_PLANE_ISSUER="$RELEASE_PROVIDER_CONTROL_PLANE_ISSUER" \
    RELEASE_PROVIDER_CONTROL_PLANE_KEY_ID="$RELEASE_PROVIDER_CONTROL_PLANE_KEY_ID" \
    RELEASE_PROVIDER_CONTROL_PLANE_KEY_SHA256="$RELEASE_PROVIDER_CONTROL_PLANE_KEY_SHA256" \
    RELEASE_QA_BUDGET_LEDGER_ISSUER="$RELEASE_QA_BUDGET_LEDGER_ISSUER" \
    RELEASE_QA_BUDGET_LEDGER_KEY_ID="$RELEASE_QA_BUDGET_LEDGER_KEY_ID" \
    RELEASE_QA_BUDGET_LEDGER_KEY_SHA256="$RELEASE_QA_BUDGET_LEDGER_KEY_SHA256" \
    RELEASE_STABLE_AUTHORIZER_KEY_ID="$RELEASE_STABLE_AUTHORIZER_KEY_ID" \
    RELEASE_STABLE_AUTHORIZER_KEY_SHA256="$RELEASE_STABLE_AUTHORIZER_KEY_SHA256" \
    pnpm release:stable:authorize -- \
      --confirm-stable-release-authorization \
      --candidate-evidence candidate-evidence.signed.json \
      --finalization-evidence finalization-evidence.signed.json \
      --finalization-source-evidence finalization-source-evidence.json \
      --semantic-review-gate-artifact gate-semantic-ranking-blinded-review.json \
      --semantic-review-gate-producer-attestation gate-semantic-ranking-blinded-review.attestation.json \
      --protected-baseline-metadata protected-semantic-baseline.json \
      --release-verification-key "$RELEASE_VERIFICATION_KEY_FILE" \
      --release-gate-producer-verification-key "$RELEASE_GATE_PRODUCER_VERIFICATION_KEY_FILE" \
      --authorizer-signing-key "$RELEASE_STABLE_AUTHORIZER_PRIVATE_KEY_FILE" \
      --output stable-release-authorization.signed.json \
      --expected-rc-tag "$RELEASE_RC_TAG" \
      --expected-version "$RELEASE_VERSION" \
      --expected-revision "$RELEASE_SHA" \
      --expected-image-digest "$RELEASE_IMAGE_DIGEST"
    ```

    `finalization-source-evidence.json` must use
    `genio-stable-release-finalization-source-bundle/v2`. It preserves the
    actual signed promotion evidence and public-rollout evidence plus the raw
    artifact and detached producer attestation for
    `production_fixed_three_track`, `production_affected_regression`,
    `backend_release_convergence`, `release_convergence`, and
    `final_custom_domain_browser`. The stable authorizer independently
    re-verifies those sources, including the Apple verifier binding, exact
    rollout transition and target configuration, repeated convergence,
    protected Sites receipt, and final browser probes. It does not accept the
    release signer's gate summaries as source evidence. Preserve this input
    with the isolated authorizer's audit record; the bounded GitHub dispatch
    remains the five-key signed-consumer bundle below.

    The same source bundle must also contain the signed finalization staging
    control-plane aggregate, its canonical
    `genio-stable-release-verification-key/v1` public key, and its protected
    trust policy; plus the detached Apple, provider, and QA-budget receipts,
    each receipt's canonical public key, and each protected receipt trust
    policy. The protected values supplied through the environment above must
    match the embedded audit copies exactly. The stable authorizer re-verifies
    every signature and candidate/runtime/hash binding at authorization time,
    checks the finalization `stagingControls` against the aggregate-derived
    controls, and caps authorization expiry to the earliest nested source
    expiry. An expired Sites attestation, control-plane aggregate, or detached
    receipt requires fresh evidence rather than historical replay.

    The authorizer also independently re-verifies the candidate evidence,
    semantic-review gate, detached gate-producer signature, blinded external
    review, and protected predecessor. The release, gate-producer,
    semantic-reviewer, Sites-control-plane, staging-control-plane, Apple
    receipt, provider receipt, QA-budget receipt, and stable-authorizer keys
    must be nine distinct protected keys. The authorizer recomputes the candidate-arm
    fixture hashes; a rewritten candidate/finalization/baseline bundle cannot
    self-assert a new reviewed result. Only this fresh signed authorization
    permits creation of the stable annotated `v<version>` tag and matching
    GitHub Release.
    Prepare the bounded five-key dispatch payload locally before calling
    GitHub; the command fails before dispatch when the encoded evidence reaches
    GitHub's 64 KiB `client_payload` ceiling:

    ```sh
    pnpm release:stable:dispatch:prepare -- \
      --confirm-stable-release-dispatch \
      --candidate-tag "$RELEASE_RC_TAG" \
      --image-digest "$RELEASE_IMAGE_DIGEST" \
      --finalization-evidence finalization-evidence.signed.json \
      --protected-baseline-metadata protected-semantic-baseline.json \
      --stable-authorization stable-release-authorization.signed.json \
      --output stable-release-dispatch.json

    gh api "repos/$GITHUB_REPOSITORY/dispatches" \
      --method POST \
      --input stable-release-dispatch.json
    ```

    `.github/workflows/stable-release.yml` and the one-time, hard-coded
    `.github/workflows/bootstrap-stable-predecessor.yml` are the only workflows
    with `contents: write`. The bootstrap publisher can publish evidence for
    only the existing annotated `v2.3.4` predecessor while it remains the
    greatest stable tag and no `v2.4.0` stable Release exists; it cannot create,
    move, or delete any tag or ref. It accepts no successor identity, and its
    signed authorization permits only a later `v2.4.0-rc.N` descendant of the
    exact protected default-branch bootstrap controller. The historical
    `v2.3.4` tree contains no Dockerfile. Read-only recovery preserved the exact
    API, worker, and deep-worker deployment records and complete retained build
    logs, but Railway exposed no registry reference, OCI manifest/config bytes,
    generated plan bytes, SBOM, signature, or supply-chain attestation. The
    canonical capture is therefore typed
    `authenticated_platform_observation_not_supply_chain_attestation`; its
    three lane-specific Railway metadata digests and distinct BuildKit
    manifest/config digests can never satisfy an image-attestation predicate.
    Bootstrap semantic fixtures are likewise scoped only to the reconstructed
    wrapper. The evidence embeds the exact three staging fixture gate
    artifacts, the final custom-domain browser artifact, and all four detached
    producer attestations in a bounded canonical compressed source bundle.
    Verification replays the typed gate validators, requires a protected
    producer key distinct from the release, stable-authorizer, and Sites
    control-plane keys, and derives the fixture registry from those artifacts.
    Bootstrap authorization additionally requires the Sites verification key
    and trust policy from protected environment configuration, verifies the
    embedded Sites signature with that external key, and rejects an
    internally consistent substituted Sites key/policy pair. The resulting
    `wrapperFixtureEvidenceHash` is not a claim that wrapper outputs equal any
    historical production execution.

    `.github/workflows/bootstrap-stable-predecessor-image.yml` is a separate
    one-time digest-only wrapper producer. It accepts no payload, checks out the
    exact historical revision, verifies a pinned deterministic `git archive`,
    expands that archive into a VCS-metadata-free build context, verifies the
    protected controller Dockerfile independently, pushes no tag, and keylessly
    attests only the resulting GHCR wrapper. The wrapper bytes and controller
    recipe are explicitly not claimed to equal any historical Railway artifact.
    `bootstrap-stable-predecessor.yml` never builds or writes a registry. Its
    dormant publisher independently reruns GitHub's keyless verification for
    the exact digest, signer workflow, protected source revision, source ref,
    predicate type, and hosted runner, then hash-binds the canonical parsed
    verification result into the image-attestation asset and rederives the
    consumer through the five-asset verifier. Before doing so, it materializes
    the original tag, commit, and tree object bytes plus the protected
    controller workflow bytes from Git, reconstructs the exact Git object IDs,
    and compares byte-derived SHA-256 commitments with the signed bootstrap
    evidence; operator-entered digest summaries are not accepted. The
    publisher remains fail-closed on the exact canonical recovered Railway
    observation. It validates all three fixed deployment records and retained
    build-log commitments, and requires the capture to state that no registry
    reference, manifest/config bytes, SBOM, or supply-chain attestation was
    recovered. There is deliberately no caller-entered "original Railway
    image" reference and no signature that can turn an unknown historical
    artifact identity into a verified claim. The separately attested GHCR
    image is only the deterministic reconstruction wrapper.

    Bootstrap evidence, image attestation, and authorization use the v2
    reduced-claim schemas. The signed authorization binds the canonical
    Railway observation hash and its
    `authenticated_platform_observation_not_supply_chain_attestation` kind,
    plus the wrapper digest and
    `controller_recipe_wrapper_not_historical_railway_artifact` mode. It must
    also contain `historicalArtifactEquivalence: "not_claimed"` and a null
    `historicalArtifactIdentity`; any historical artifact reference, digest,
    or equivalence claim is rejected. The authorization and publication
    verifier still require
    `RELEASE_SITES_CONTROL_PLANE_KEY_ID`,
    `RELEASE_SITES_CONTROL_PLANE_KEY_SHA256`, and the protected
    `RELEASE_SITES_CONTROL_PLANE_VERIFICATION_KEY_B64URL`. Missing, expired,
    mismatched, or substituted evidence blocks before publication. The signed
    bootstrap authorization requires four distinct protected authorities:
    release signer, stable authorizer, gate producer, and Sites control plane.
    Immediately before the Release API mutation, the workflow rereads stable
    tags and Releases under the shared mutation lock and requires `v2.3.4` to
    remain the greatest exact stable identity. Every ordinary stable release
    uses `stable-release.yml`.

    Before any ref or Release write, `stable-release.yml` verifies the exact
    annotated RC/default-branch SHA/package version/image digest, full
    post-Sites finalization evidence, the independently signed stable
    authorization, and the GHCR provenance attestation. Both publishers read
    GitHub's control plane and fail closed unless:

    - `main` is protected with strict GitHub-Actions-app-bound required checks,
      at least one approving PR review, and admin enforcement;
    - the `stable-release` environment exists and permits only protected
      branches (an environment reviewer is optional Enterprise hardening; the
      distinct signed authorization is the mandatory independent approval);
    - the active tag ruleset has exactly the `refs/tags/v*` include and
      `refs/tags/v*-rc.*` exclude, exactly the creation/update/deletion rules,
      and only the GitHub Actions Integration returned by
      `apps.getBySlug("github-actions")` as an always bypass. The workflow does
      not accept an operator-entered bypass actor ID; checkout and the tag push
      use the job-scoped `${{ github.token }}` installation credential, and the
      verified Integration/ruleset IDs are recorded in the tag annotation;
    - repository immutable releases are enabled.

    It creates a draft Release, uploads and byte-compares the five evidence
    assets, verifies exact title/body/target/assets, publishes, then rereads the
    Release and requires GitHub to report it immutable. A pre-existing
    incomplete or inconsistent tag, draft, Release, or asset fails closed.

    **Current external P0 (verified 2026-07-26):** the four workflow
    environments now exist and are restricted to protected branches, but this
    private repository is on a GitHub plan where GitHub explicitly reports
    that branch protections and repository rulesets are not enforced.
    Required environment reviewers are also unavailable. `main` therefore
    cannot yet provide the enforced app-bound checks, independent approval,
    and admin enforcement required by the release verifier. The repository
    also currently has no Actions secrets or variables, so its pinned release
    keys, control-plane tokens, and tag-ruleset identity are absent. Immutable
    Releases have not been independently proven enabled. Railway staging
    exists but contains no services; its first declarative plan cannot be
    generated until an immutable RC image digest is supplied. Do not dispatch
    a bootstrap/stable publisher and do not create a manual RC/stable tag or
    Release until these controls are available and configured. Adding GitHub
    Actions spend changes only compute budget; it does not satisfy any of
    these controls.

The public-rollout producer consumes the exact backend-scoped production
runtime snapshot and signed promotion evidence, reads the protected current
rollout values, and collects at least three cache-busted Sites/API/system
samples over at least 60 seconds. API and both worker lanes must expose the
candidate identity; Sites must remain on the exact prior version and revision
bound into promotion. It rejects a stale or mismatched API/worker
configuration, a changed Sites identity, a paused or unhealthy system, a
missing/old worker heartbeat, or a live rollout
evidence-hash/stage that does not match the prior signed target. Its target is
server-derived from `--intent-group` and the next allowed `--to-percent`;
operators cannot pass an arbitrary configuration object.

The Railway rollout pre-deploy changes the corresponding database kill switch
and evidence lineage in one serializable, advisory-locked transaction before
deploying the same signed target variables to API and both worker lanes.
Persisted in-flight assignments retain their original route. If a deployment
fails after the pre-deploy transaction, reuse the exact same signed envelope
and plan while the evidence is still valid; that hash is idempotent. Do not
produce a different envelope against the now-stale predecessor.

Advance evidence is always fresh. A rollback to zero has a deliberately
separate historical-promotion verification path so an incident can be stopped
after 24 hours, but it relaxes only promotion expiry: signature, candidate,
image, source, configuration, and runtime still match exactly, and a fresh
signed rollback envelope is required. That path is unavailable to advances.
The signed promotion is the pre-Sites authorization for public cohort rollout;
it does not include the final custom-domain browser gate. After rollout, deploy
Sites last, collect a full production snapshot, and include the final browser
gate in separately signed `finalization` evidence. See `.railway/README.md` for
the rollout command.

`GET /health/live` exposes only the package version and a validated Git commit
revision from the deployment environment. Record its `build.identifier` beside
the successful CI revision during every smoke test; a missing revision is a
deployment-observability failure, not evidence that production matches CI.
The public `/about` page shows this API build separately from the Sites web
release so a partially rolled out deployment is visible instead of being
mistaken for a complete release.

Do not declare convergence from a single liveness response. After Railway's
overlap window, collect two cache-busted samples for promotion. The production
runtime snapshot for this phase is backend-scoped; Sites remains on the prior
proven build until the rollout succeeds:

```sh
pnpm release:convergence -- \
  --origin https://9enio.com \
  --scope backend \
  --expected-version "$RELEASE_VERSION" \
  --expected-revision "$RELEASE_SHA" \
  --expected-sites-version "$PRIOR_SITES_VERSION" \
  --expected-sites-revision "$PRIOR_SITES_REVISION"
```

The backend-scoped read-only probe fails unless Sites remains on that exact
prior identity while the API, schema 18, protocol 10, brief contract 3,
query-plan schema 5, database readiness, interactive worker lane, and deep
worker lane remain on the candidate backend artifact in both samples. After
the Sites deployment, rerun it with `--scope full` and both expected Sites
arguments set to the candidate identity. Its JSON output includes only
allowlisted release metadata, queue counters, an expiring timestamp, and a
deterministic evidence hash; it contains no response bodies, prompts,
credentials, worker IDs, or capability data. The hash is an integrity digest,
not a signature. Bind its hash into the promotion payload, then sign and verify
the strict envelope:

```sh
pnpm release:evidence -- sign \
  --input promotion-signing-bundle.json \
  --output promotion-evidence.signed.json \
  --private-key "$RELEASE_SIGNING_KEY_FILE" \
  --producer-public-key "$RELEASE_GATE_PRODUCER_VERIFICATION_KEY_FILE" \
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

The protected signing environment must pin the gate-producer key independently
with `RELEASE_GATE_PRODUCER_KEY_ID` and
`RELEASE_GATE_PRODUCER_KEY_SHA256`; passing an arbitrary
`--producer-public-key` is insufficient. Finalization signing additionally
requires the independently pinned Sites control-plane key.

Evidence expires within 24 hours. Any source, image, behavior-affecting
configuration, secret-version set, model route, policy, schema, or protocol
change requires new evidence. The signing command prints the aggregate
configuration and runtime hashes; verification requires both so a correctly
signed envelope for a prior model route or cohort configuration cannot promote
a changed runtime. This schema-18/protocol-10 release contract also requires
`adaptive_guidance_v3` and `governed_evidence_v2`; a legacy policy label makes
the payload unsignable. Verification requires the caller to name the expected
`candidate`, `promotion`, or `finalization` kind, so a staging-only candidate
envelope can never satisfy production promotion and promotion evidence cannot
authorize a stable release.

The signing-bundle schema is `genio-release-evidence-signing-bundle/v3`. It
contains candidate identity, budget/credential-separation controls, relative
paths to staging/production runtime snapshots, and an exact gate-name-to-file
map. A promotion bundle must name the signed candidate parent. A finalization
bundle must name the signed promotion parent and the fresh signed rollout that
completed the affected backend cohort at 100% while the prior Sites identity
remained live. The signer loads every file, rejects extra or missing fields,
enforces candidate → promotion → rollout → Sites deployment → finalization
timestamps, recomputes
the runtime snapshot hash plus each gate's inner proof hash and outer evidence
hash, and cross-binds candidate, environment, configuration, runtime, and
timestamps before signing. Generic smoke prompts remain diagnostic only.
Promotable playlist gates use the immutable code-owned fixtures:

- `fixed-three-track-control-v1`
- `smooth-reggaeton-heat-50-v1`
- `french-jazz-guided-constraint-25-v1`

The reggaeton fixture requires the sole
`guidance:reggaeton:adjacent-latin-urban-scope` question, the recommended
`reggaeton_dembow_latin_urban` typed answer, a minimum 70% core-reggaeton
quota, and a persisted guidance-lineage hash. Gate artifacts contain only
the immutable fixture hashes, answer-lineage hash, and the server-owned typed
question/patch needed to recompile the asserted guidance delta—never a raw
user prompt, custom answer, user run ID, or playlist capability identifier.
Every gate artifact also requires an Ed25519 producer attestation from its
approved harness before the release signer will load it.

Never run an automatic destructive down-migration. A worker refuses an
unsupported schema version. After schema-18 writes, binary rollback to the old
max-schema-16 release is forbidden. Roll back behavior by setting the affected
cohort to zero and redeploying this same schema-13–18-compatible artifact in
`bridge` phase; it stops new canonical/schema-4/5 emission while remaining
able to drain compatible schema-18 work.

### Sites production rollback

Capture the currently live saved Sites version before deploying a candidate.
Obtain the exact opaque project, version, and deployment IDs from the Sites
control plane; do not reconstruct an ID from a URL or version number. Record
the saved version's `versionId`, `versionNumber`, `commitSha`, packaged archive
SHA-256, current `deploymentId`/status, the production origin, and the planned
candidate commit/build version in a
`genio-sites-production-rollback-capture-source/v1` JSON file. Then run:

```sh
pnpm release:sites-rollback:capture -- \
  --source sites-rollback-capture-source.json \
  --output sites-rollback-target.json \
  --confirm-before-candidate-deployment
```

This performs a no-store, cache-busted production read and refuses a stale
control-plane observation or a live build revision that differs from the
saved version's commit. The output is create-only and must exist before the
candidate deployment becomes ready.

For a Sites rollback, deploy `previous.versionId` from that target to exactly
`projectId`; never rebuild the old commit or save a replacement version. Poll
that new deployment with the Sites control plane until `ready` or `succeeded`.
Record the candidate deployment, rollback request, returned rollback
deployment ID, and at least two ordered poll observations in a
`genio-sites-production-rollback-deployment-result/v1` JSON file, including
the candidate deployment request time so the verifier can prove the capture
predated deployment. Produce the receipt:

```sh
pnpm release:sites-rollback:produce -- \
  --target sites-rollback-target.json \
  --deployment-result sites-rollback-deployment-result.json \
  --output sites-rollback-receipt.json \
  --confirm-exact-saved-version-deployed
```

The producer rejects any project/version/number/commit/archive/deployment
disagreement and performs two distinct no-store, cache-busted reads of the
restored live build. The protected Sites control plane must then Ed25519-sign
the exact receipt and target binding with operation
`production_rollback_ready`; an operator or release-producer key cannot
substitute. Verify the detached envelope against the protected key and explicit
expected IDs:

```sh
pnpm release:sites-rollback:verify -- \
  --target sites-rollback-target.json \
  --receipt sites-rollback-receipt.json \
  --attestation sites-rollback-attestation.signed.json \
  --verification-key sites-control-plane-verification-key.json \
  --trust-policy sites-control-plane-trust-policy.json \
  --expected-project-id "$SITES_PROJECT_ID" \
  --expected-production-url https://9enio.com \
  --expected-version-id "$PREVIOUS_SITES_VERSION_ID" \
  --expected-version-number "$PREVIOUS_SITES_VERSION_NUMBER" \
  --expected-deployment-id "$ROLLBACK_SITES_DEPLOYMENT_ID" \
  --output sites-rollback-proof.json
```

The verifier fails closed on an expired or future receipt, more than five
minutes of receipt/attestation skew, cross-project/version/deployment
substitution, a mismatched receipt hash, or an unpinned key. Do not announce a
Sites rollback as complete without the resulting proof.

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
- Rotate the capability pepper by setting the former secret as
  `CAPABILITY_PREVIOUS_PEPPER`, giving current and previous distinct safe
  version labels, and setting `CAPABILITY_PREVIOUS_PEPPER_EXPIRES_AT` to the
  rotation instant plus `CAPABILITY_SESSION_TTL_DAYS`. Deploy all four values
  atomically. New hashes immediately use only `CAPABILITY_PEPPER`; existing
  tokens and sessions verify against both candidates in one database
  operation. The API rejects malformed overlap or a deadline farther away
  than the active TTL. After the deadline, verify readiness reports
  `previousCleanupRequired`, then remove the previous secret, version, and
  deadline together. Never extend the deadline to conceal missed cleanup.
- If the capability pepper is lost, invalidate all visitor sessions; published Apple links remain valid.
- Inventory orphan, `[GÊNIO TEST]`, and legacy `[NEEDLE TEST]` playlists in the owner console; deletion from Apple remains an explicit owner action.

## Owner-only data controls

- The owner console can invalidate a completed run's 30-day reuse window without deleting its evidence or published links; the next equivalent confirmed brief creates fresh work.
- A specialist CSV/JSON catalogue may be attached only while research is globally paused and the selected run is quiescent before matching. Each row requires an explicit public HTTPS source, but every production import enters as inferred because gênio has not fetched the linked support; visitors must review it or a later research pass must verify it. Even while normalizing reported corroboration, the parser requires one stable ISRC/MusicBrainz recording ID across two distinct provenance roots, and metadata-only rows remain possible duplicates.
- The browser gateway limits each import batch to 24 KiB. Split larger catalogues into multiple batches and resume research only after the final import succeeds.
