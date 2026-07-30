# Railway configuration

This project defines its Railway infrastructure in code. Apply the same
definition separately to the isolated `staging` and `production` Railway
environments. They may share the `needle` project, but they never share a
database, service instance, or environment variable. The fresh bootstrap is
bound to explicit project/environment UUIDs and emits no preserved variables.

```txt
.railway/railway.ts
```

Use this file to describe the Railway project you want: services, databases, buckets, custom domains, replicas, groups, and environment variables.

## Common commands

Create the configuration files:

```bash
railway config init
```

Import an existing Railway project into code:

```bash
railway config pull
```

For example, preview a production bridge plan while the production Railway
environment is selected:

```bash
GENIO_RELEASE_IMAGE=ghcr.io/<owner>/genio@sha256:<digest> \
GENIO_RELEASE_REVISION=<full-git-sha> \
GENIO_RELEASE_VERSION=<stable-semver> \
GENIO_RELEASE_SECRET_VERSIONS_HASH=<release-secret-versions-sha256> \
GENIO_RELEASE_RC_TAG=v<stable-semver>-rc.<n> \
GENIO_RELEASE_ENVIRONMENT=production \
GENIO_RELEASE_PHASE=bridge \
GENIO_EXPECTED_DATABASE_SCHEMA_VERSION=<current-schema> \
GENIO_VERIFIED_CANDIDATE_EVIDENCE_HASH=<verified-candidate-payload-sha256> \
GENIO_VERIFIED_CANDIDATE_EVIDENCE_FILE=<signed-candidate-evidence.json> \
GENIO_CANDIDATE_CONFIGURATION_HASH=<signed-candidate-configuration-sha256> \
GENIO_CANDIDATE_RUNTIME_HASH=<signed-candidate-runtime-sha256> \
GENIO_RELEASE_VERIFICATION_KEY_FILE=<release-public-key.pem> \
GENIO_RELEASE_VERIFICATION_KEY_SHA256=<pinned-public-key-sha256> \
railway config plan
```

The schema-19 release is three separate plans against the same image digest,
revision, version, and environment. A brand-new staging environment with a
fresh, empty database has one additional one-time bootstrap plan before those
three plans. Export the reviewed artifact values before each command:

```bash
export GENIO_RELEASE_IMAGE=ghcr.io/<owner>/genio@sha256:<digest>
export GENIO_RELEASE_REVISION=<full-git-sha>
export GENIO_RELEASE_VERSION=<stable-semver>
export GENIO_RELEASE_SECRET_VERSIONS_HASH=<release-secret-versions-sha256>
export GENIO_RELEASE_RC_TAG=v<stable-semver>-rc.<n>
export GENIO_RELEASE_ENVIRONMENT=staging

# 0. bootstrap (fresh staging only): explicitly assert that the new staging
#    database is empty. The API runs the schema-19 migration; both worker lanes
#    remain at zero replicas and every /api/v1 mutation is runtime-fenced.
GENIO_RELEASE_PHASE=bootstrap \
GENIO_EXPECTED_DATABASE_SCHEMA_VERSION=19 \
GENIO_STAGING_BOOTSTRAP_FRESH_EMPTY_DATABASE_CONFIRMED=true \
GENIO_STAGING_BOOTSTRAP_PROJECT_ID=<selected-railway-project-uuid> \
GENIO_STAGING_BOOTSTRAP_ENVIRONMENT_ID=<fresh-staging-environment-uuid> \
GENIO_STAGING_BOOTSTRAP_GATEWAY_KEY_ID=<bootstrap-only-key-id> \
GENIO_STAGING_BOOTSTRAP_GATEWAY_HMAC_SECRET=<independent-bootstrap-secret> \
GENIO_STAGING_BOOTSTRAP_PRODUCTION_GATEWAY_HMAC_SHA256=<production-secret-fingerprint> \
GENIO_STAGING_BOOTSTRAP_CAPABILITY_PEPPER=<independent-bootstrap-pepper> \
GENIO_STAGING_BOOTSTRAP_CAPABILITY_PEPPER_VERSION=<bootstrap-only-version> \
GENIO_STAGING_BOOTSTRAP_PRODUCTION_CAPABILITY_PEPPER_SHA256=<production-pepper-fingerprint> \
railway config plan

# Apply only that reviewed plan, then require /health/ready to report schema 19,
# releaseManifestCanaryGuardsVersion 1, and
# canonicalExecutionHardeningVersion 1. Unset the one-time confirmation,
# configure the dedicated staging controls, and retain the same immutable image
# for the ordinary bridge below. Production rejects bootstrap unconditionally.
# Bootstrap refuses any inherited database URL, provider/Apple credential,
# gateway/capability credential, or promotion-evidence input. Its API receives
# only the new Postgres reference and the explicit bootstrap-only credentials;
# both zero-replica worker lanes receive no provider or publication credentials.

# 1. bridge: deploy schema-13–19-capable API and both protocol-11 worker lanes.
#    There is deliberately no pre-deploy migration.
GENIO_RELEASE_PHASE=bridge \
GENIO_EXPECTED_DATABASE_SCHEMA_VERSION=<observed-13-through-19> \
railway config plan

# 2. expand: only after release:migration:verify produced passing bridge
#    evidence. This is the only phase whose API has `pnpm run db:migrate`.
GENIO_RELEASE_PHASE=expand \
GENIO_EXPECTED_DATABASE_SCHEMA_VERSION=19 \
GENIO_BRIDGE_CONVERGENCE_EVIDENCE_FILE=<signed-bridge-evidence.json> \
GENIO_BRIDGE_DATABASE_SCHEMA_VERSION=<observed-bridge-schema> \
GENIO_BRIDGE_DATABASE_CAPABILITY_VERSION=<observed-version-or-none> \
GENIO_BRIDGE_MANIFEST_CANARY_GUARDS_VERSION=<observed-1-or-none> \
GENIO_BRIDGE_CANONICAL_EXECUTION_HARDENING_VERSION=<observed-1-or-none> \
GENIO_BRIDGE_CONFIGURATION_HASH=<signed-bridge-configuration-sha256> \
railway config plan

# 3. activate: only after another verification proves schema 19 and two fresh
#    worker heartbeats per lane while canonical emission is still disabled.
GENIO_RELEASE_PHASE=activate \
GENIO_EXPECTED_DATABASE_SCHEMA_VERSION=19 \
GENIO_BRIDGE_CONVERGENCE_EVIDENCE_FILE=<signed-bridge-evidence.json> \
GENIO_BRIDGE_DATABASE_SCHEMA_VERSION=<observed-bridge-schema> \
GENIO_BRIDGE_DATABASE_CAPABILITY_VERSION=<observed-version-or-none> \
GENIO_BRIDGE_MANIFEST_CANARY_GUARDS_VERSION=<observed-1-or-none> \
GENIO_BRIDGE_CANONICAL_EXECUTION_HARDENING_VERSION=<observed-1-or-none> \
GENIO_BRIDGE_CONFIGURATION_HASH=<signed-bridge-configuration-sha256> \
GENIO_EXPAND_CONVERGENCE_EVIDENCE_FILE=<signed-expand-evidence.json> \
GENIO_EXPAND_CONFIGURATION_HASH=<signed-expand-configuration-sha256> \
GENIO_PRODUCTION_DATABASE_IDENTITY_HASH=<pinned-production-database-sha256> \
railway config plan
```

Ordinary staging bridge/expand/activate plans also require:

```txt
GENIO_STAGING_MONTHLY_COST_LIMIT_USD
GENIO_STAGING_MUSICKIT_ORIGIN
GENIO_STAGING_PROVIDER_SECRET_VERSION_HASH
GENIO_PRODUCTION_PROVIDER_SECRET_VERSION_HASH
GENIO_STAGING_APPLE_SECRET_VERSION_HASH
GENIO_PRODUCTION_APPLE_SECRET_VERSION_HASH
GENIO_STAGING_APPLE_ACCOUNT_SEPARATION_EVIDENCE_HASH
GENIO_STAGING_MUSICKIT_ORIGIN_REGISTRATION_EVIDENCE_HASH
```

Every production plan requires
the signed candidate file, its `payloadHash`, the pinned release-verification
key file and key digest, and the candidate configuration/runtime hashes.
Set the hashes only after this command succeeds with all exact target values:

```bash
pnpm release:evidence -- verify \
  --input candidate-evidence.signed.json \
  --public-key "$RELEASE_VERIFICATION_KEY_FILE" \
  --expected-kind candidate \
  --expected-revision "$GENIO_RELEASE_REVISION" \
  --expected-image-digest "${GENIO_RELEASE_IMAGE##*@}" \
  --expected-tag "$RELEASE_RC_TAG" \
  --expected-configuration-hash "$RELEASE_CONFIGURATION_HASH" \
  --expected-runtime-hash "$RELEASE_RUNTIME_HASH"
```

Carry the same candidate envelope through all three production plans. Railway
loads it and runs the same complete strict validator as the evidence CLI: it
recomputes the payload hash, verifies the Ed25519 signature through the pinned
key, enforces the 24-hour window, requires every candidate gate and runtime
binding, and matches the exact tag/version/source/image/configuration/runtime.
A minimal or hand-written payload cannot satisfy the plan.

Expand additionally loads
`GENIO_BRIDGE_CONVERGENCE_EVIDENCE_FILE`; activate loads that same bridge
envelope and `GENIO_EXPAND_CONVERGENCE_EVIDENCE_FILE`. Both are strict signed
`genio-promotion-phase-evidence/v2` envelopes. Railway verifies their
signatures, freshness, candidate-evidence hash, immutable image, source,
configuration aggregate, protocol-11 runtime, database schema, composite
capability 2, release-manifest marker 1, canonical-hardening marker 1,
two advancing worker heartbeats per lane, and zero eligible old workers. The
configuration aggregate is recomputed from the API, interactive-worker, and
deep-worker hashes. A bare SHA-256 environment value is never accepted as
phase-convergence proof.

The signed expand envelope also contains the authoritative activation
preflight. It must be produced from the fixed complete cohort-inventory query
inside a read-only repeatable-read database snapshot, prove the global
catalog-first V2 control and every affected row are disabled, and prove that
no DB control blocks the owner V3 candidate group. Its non-secret database
identity digest must exactly match
`GENIO_PRODUCTION_DATABASE_IDENTITY_HASH`, preventing a valid preflight from a
different Railway database from being replayed. The resulting activation
plan writes every public V2/V3 percentage as literal `0`, disables V2 owner
canaries and global/reggaeton V3 guidance, and enables only the authenticated
owner `corpus_first_v3` genre-scene candidate route plus the curated-hosted
evidence approval already established by the required staging gates. It also
writes `PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION=5` and all three database
expectation literals directly from the signed activation configuration. These
literals override preserved Railway values. If the protected phase-evidence producer or any
required source artifact is unavailable, promotion remains fail-closed.

## Signed public intent rollout

Owner-only activation is not permission to set a public percentage manually.
For each intent, advance exactly `0 → 1 → 10 → 50 → 100`; only a signed
`rollback_to_zero` may jump directly back to `0`. Produce each transition
from the current production runtime, a fresh signed production-promotion
envelope, and (after the first transition) the immediately previous signed
rollout envelope:

```bash
pnpm release:rollout:intent-canary:produce -- \
  --assignment-receipt owner-candidate-assignment.signed.json \
  --assignment-verification-key "$ROLLOUT_ASSIGNMENT_SOURCE_PUBLIC_KEY_FILE" \
  --manifest-receipt exact-manifest.signed.json \
  --manifest-verification-key "$ROLLOUT_MANIFEST_SOURCE_PUBLIC_KEY_FILE" \
  --apple-evidence independent-apple.signed.json \
  --apple-verification-key "$ROLLOUT_APPLE_SOURCE_PUBLIC_KEY_FILE" \
  --browser-evidence independent-browser.signed.json \
  --browser-verification-key "$ROLLOUT_BROWSER_SOURCE_PUBLIC_KEY_FILE" \
  --metrics-receipt intent-window-metrics.signed.json \
  --metrics-verification-key "$ROLLOUT_METRICS_SOURCE_PUBLIC_KEY_FILE" \
  --output intent-canary-genre-scene-0-to-1.signed.json \
  --producer-signing-key "$ROLLOUT_INTENT_CANARY_SIGNING_KEY_FILE" \
  --producer-key-id "$RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_ID"

pnpm release:rollout:evidence:produce -- \
  --confirm-production-public-rollout \
  --origin https://9enio.com \
  --candidate-tag "$GENIO_RELEASE_RC_TAG" \
  --candidate-version "$GENIO_RELEASE_VERSION" \
  --candidate-revision "$GENIO_RELEASE_REVISION" \
  --image-digest "${GENIO_RELEASE_IMAGE##*@}" \
  --intent-group genre_scene \
  --to-percent 1 \
  --samples 3 \
  --interval-seconds 30 \
  --runtime-snapshot production-runtime-snapshot.json \
  --promotion-evidence production-promotion.signed.json \
  --intent-canary intent-canary-genre-scene-0-to-1.signed.json \
  --intent-canary-verification-key "$ROLLOUT_INTENT_CANARY_PUBLIC_KEY_FILE" \
  --verification-key "$GENIO_RELEASE_VERIFICATION_KEY_FILE" \
  --rollback-warrant-output public-rollout-genre-scene-1.warrant.signed.json \
  --output public-rollout-genre-scene-1.signed.json \
  --producer-signing-key "$RELEASE_SIGNING_KEY_FILE" \
  --producer-key-id "$RELEASE_SIGNING_KEY_ID"
```

The five inputs to the intent-canary producer are authority artifacts, not
operator summaries. The assignment receipt must come from the production
owner-candidate assignment gateway; the manifest receipt must come from the
completed worker/API execution and contain the exact selected count and
ordered Apple stable IDs; Apple readback must be signed by an independent
Apple verifier; the browser receipt must be signed by the independent browser
runner after checking public accessibility and visible contents; and the
intent-window receipt must be emitted from the production database query
authority with the exact cohort denominators and invariant counters. Each
authority and the intent-canary producer has a separately pinned Ed25519 key.
The producer recomputes
`RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256` from those exact
keys and the code-owned fixture registry. Release-candidate finalization embeds
that hash in the image, so changing CLI or Railway trust variables after the
build cannot establish a new authority set.
The producer rejects reused keys, stale sources, a release-key self-authored
canary, count/order disagreement, worker/API identity disagreement, and
metrics that fail the current stage. A hand-authored signed claim cannot
substitute for any of these protected source receipts.

Add `--previous-rollout-evidence <immediately-previous.signed.json>` for every
later transition and rollback. The protected producer reads the full current
rollout configuration from the environment; there is no target-configuration
JSON or arbitrary percentage input. It collects three cache-busted
`9enio.com` Sites/API/system observations over at least 60 seconds and fails
unless the API and both worker configuration hashes match the fresh runtime
snapshot, both worker heartbeats advance, there is no eligible old worker,
and the live rollout evidence hash/stage exactly match the previous signed
target. API and both worker lanes must expose the candidate identity while
Sites must retain the exact prior version/revision recorded by the backend
promotion snapshot. The envelope binds the exact source, image, promotion
configuration, runtime, production canaries, schema 19, composite capability
2, both marker-1 values, and protocol 11.

Review a separate production Railway plan for that exact envelope:

```bash
GENIO_RELEASE_PHASE=rollout \
GENIO_PRODUCTION_PROMOTION_EVIDENCE_FILE=production-promotion.signed.json \
GENIO_PUBLIC_ROLLOUT_EVIDENCE_FILE=public-rollout-genre-scene-1.signed.json \
GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_FILE=intent-canary-genre-scene-0-to-1.signed.json \
GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_HASH="<verified-canary-payload-hash>" \
GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_VERIFICATION_KEY_FILE="$ROLLOUT_INTENT_CANARY_PUBLIC_KEY_FILE" \
GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_ID="$RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_ID" \
GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_SHA256="$RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_SHA256" \
GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256="$RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256" \
railway config plan
```

For a non-genesis transition, also set
`GENIO_PREVIOUS_PUBLIC_ROLLOUT_EVIDENCE_FILE` to the exact previous envelope.
The rollout pre-deploy transaction takes an advisory lock, verifies that the
database lineage and current percentage match, changes only the affected
intent kill switch, and records the new evidence hash atomically. Existing
runs keep their persisted route; rollback disables only new assignment for
that intent. If deployment fails after this pre-deploy transaction, rerun the
same plan with the same evidence file while it remains valid—the transaction
is idempotent by evidence hash. Do not mint a replacement transition against
the old predecessor after the database has already recorded the new hash.

Advances require fresh promotion and public-rollout evidence. An emergency
rollback may verify an expired historical promotion envelope only through the
rollback-only producer path; it still requires an exact valid signature,
candidate, source, image, configuration, and runtime, plus a newly generated
signed rollback envelope. An advance can never use that expiry exception.

Production promotion uses a backend-scoped runtime snapshot and intentionally
does not include the final custom-domain browser gate. It authorizes the
Railway public rollout while Sites stays on the prior proven build. After the
rollout succeeds, capture the exact currently live saved Sites version and its
live build identity with `release:sites-rollback:capture` before requesting the
candidate deployment. Deploy the exact saved candidate Sites version last.
The signed `genio-sites-control-plane-deployment/v2` receipt must embed that
rollback target and bind the candidate version ID/number/archive/deployment,
request time, and ready observation. Then capture a full-scoped production
snapshot, run the final cache-busted `9enio.com` browser producer, and sign
`finalization` evidence. Finalization requires the signed promotion evidence,
the completed signed backend rollout to 100%, and new
`--phase finalization` Apple, provider-project, and QA-budget receipts derived
from independently signed authority-source envelopes, plus a new
`release:staging-control-plane:produce -- --phase finalization` aggregate bound
to the full production snapshot. Neither a promotion receipt nor an operator
assertion can substitute. Only a distinct protected stable authorization
derived from that finalization evidence may authorize the stable tag and
GitHub Release.

Stable publication is outside Railway and runs only through
`.github/workflows/stable-release.yml`. Prepare its four-key, sub-64-KiB
repository-dispatch body with `pnpm release:stable:dispatch:prepare`; never
paste an unmeasured evidence envelope into a dispatch. The workflow checks the
protected default branch, stable-release environment branch policy, exact
GitHub Actions tag-ruleset bypass (with RC tags excluded), repository immutable
releases, signed evidence/authorization, and image provenance before writing.
It publishes through a verified draft and fails closed on inconsistent existing
state. As of 2026-07-24 the repository's GitHub plan/control plane does not
supply those protections, so stable publication is an external P0 and manual
tag/Release creation is not authorized.

## Notes

- `railway config plan` is safe and does not change Railway.
- Run the exact plan separately in the selected `staging` or `production`
  environment and review it before every apply. `GENIO_RELEASE_ENVIRONMENT`
  must match that selected Railway environment or evaluation fails.
- `bootstrap` is accepted only for a new staging database and only with
  `GENIO_STAGING_BOOTSTRAP_FRESH_EMPTY_DATABASE_CONFIRMED=true`, exact Railway
  project/environment UUIDs, independent bootstrap-only gateway/capability
  secrets, and non-matching production secret fingerprints. It runs
  `pnpm run db:migrate` on the API, deploys both worker lanes at zero replicas,
  emits no preserved variables, and reports ready only after schema 19 and
  both marker-1 values are authoritative. The assertion is invalid in every
  later phase and bootstrap is rejected for production.
- The configuration fails closed unless `GENIO_RELEASE_IMAGE` is an immutable
  GHCR SHA-256 digest and its full Git revision and stable semantic version are
  supplied. It also fails when the release phase or expected database schema
  is missing. API and both worker lanes use that same artifact and expose that
  identity, with image auto-updates disabled.
- Every production service exposes
  `RELEASE_VERIFIED_CANDIDATE_EVIDENCE_HASH` as part of its release identity.
  It is the verified candidate payload hash, not a signature or a substitute
  for running the verification command.
- Every app service also exposes the non-secret
  `RELEASE_SECRET_VERSIONS_HASH`. Rotate it atomically with the corresponding
  non-secret secret-version labels whenever any secret changes. Release
  snapshots bind this aggregate; raw secret values are never queried, logged,
  or signed.
- Rollout percentages, evidence approvals, guidance cohorts, and `APP_ORIGIN`
  are preserved per Railway environment during bridge and expand. The runtime
  phase fence makes preserved canonical/schema-4/5 settings inert then.
  Activation never preserves rollout percentages: it uses only the literal
  zero/public and owner-only values derived from the signed database preflight,
  and the API still checks the authoritative schema, composite capability, and
  both independent database markers before creating a contract-3 brief.
- Every staging plan additionally requires a dedicated non-production HTTPS
  MusicKit origin, a monthly cap no higher than $75, distinct staging and
  production provider/Apple secret-version hashes, Apple-account separation
  evidence, and MusicKit-origin registration evidence. The cap covers the
  73-submission historical replay reserve ($59.25) plus $3 for the other
  required canaries ($62.25 committed total), leaving $12.75 for bounded
  retries without waiving a gate. These are safe fingerprints/evidence hashes,
  never credentials.
- Generate bridge and expand observations with the read-only migration
  verifier, then have the protected phase-evidence producer bind those
  observations, the exact runtime/configuration snapshots, and (for expand)
  the authoritative DB cohort preflight into the signed envelopes consumed by
  Railway. Do not manually translate an observation hash into an environment
  variable.
- `railway config apply` previews changes and asks before applying unless you pass `--yes`.
- Destructive changes in non-interactive or agent sessions require `railway config apply --confirm-destructive` after reviewing the plan.
- After schema-19 writes, rollback means redeploying the same schema-13–19
  artifact in `bridge` phase and routing new assignments to the last proven
  cohort. Never deploy an older max-schema-16 binary and never down-migrate.
- Services already managed by `railway.json` / `railway.toml` must be migrated before `.railway/railway.ts` can manage them.
- Use `replicas` for scaling; advanced placement can still specify region names.
- Use `group("Name", [resources])` to keep large projects organized on the Railway canvas.
- Secrets imported from Railway are rendered as `preserve()` so existing values are retained without writing secret values to source. Use `railway config pull --omit-preserved-variables` for a smaller import.
- Capability-pepper rotation preserves
  `CAPABILITY_PEPPER`, `CAPABILITY_PEPPER_VERSION`,
  `CAPABILITY_PREVIOUS_PEPPER`, `CAPABILITY_PREVIOUS_PEPPER_VERSION`, and
  `CAPABILITY_PREVIOUS_PEPPER_EXPIRES_AT` on the API. The previous pepper is
  verification-only. Set its deadline to the rotation instant plus
  `CAPABILITY_SESSION_TTL_DAYS`; readiness rejects malformed or longer
  overlap. Once the deadline passes, remove the three previous-pepper
  variables together. Plans and public health surfaces expose only hashes of
  non-secret version labels, never either pepper or a pepper-derived digest.
