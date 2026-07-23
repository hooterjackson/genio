# Railway configuration

This project defines its Railway infrastructure in code.

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
GENIO_RELEASE_ENVIRONMENT=production \
GENIO_RELEASE_PHASE=bridge \
GENIO_EXPECTED_DATABASE_SCHEMA_VERSION=<current-schema> \
GENIO_VERIFIED_CANDIDATE_EVIDENCE_HASH=<verified-candidate-payload-sha256> \
railway config plan
```

The schema-18 release is three separate plans against the same image digest,
revision, version, and environment. Export those reviewed values (plus the
staging controls listed below when targeting staging) before each command:

```bash
export GENIO_RELEASE_IMAGE=ghcr.io/<owner>/genio@sha256:<digest>
export GENIO_RELEASE_REVISION=<full-git-sha>
export GENIO_RELEASE_VERSION=<stable-semver>
export GENIO_RELEASE_ENVIRONMENT=staging

# 1. bridge: deploy schema-13–18-capable API and both protocol-10 worker lanes.
#    There is deliberately no pre-deploy migration.
GENIO_RELEASE_PHASE=bridge \
GENIO_EXPECTED_DATABASE_SCHEMA_VERSION=<observed-13-through-18> \
railway config plan

# 2. expand: only after release:migration:verify produced passing bridge
#    evidence. This is the only phase whose API has `pnpm run db:migrate`.
GENIO_RELEASE_PHASE=expand \
GENIO_EXPECTED_DATABASE_SCHEMA_VERSION=18 \
GENIO_BRIDGE_CONVERGENCE_EVIDENCE_HASH=<sha256> \
GENIO_BRIDGE_RELEASE_IMAGE="$GENIO_RELEASE_IMAGE" \
railway config plan

# 3. activate: only after another verification proves schema 18 and two fresh
#    worker heartbeats per lane while canonical emission is still disabled.
GENIO_RELEASE_PHASE=activate \
GENIO_EXPECTED_DATABASE_SCHEMA_VERSION=18 \
GENIO_BRIDGE_CONVERGENCE_EVIDENCE_HASH=<sha256> \
GENIO_EXPAND_CONVERGENCE_EVIDENCE_HASH=<sha256> \
GENIO_BRIDGE_RELEASE_IMAGE="$GENIO_RELEASE_IMAGE" \
GENIO_EXPAND_RELEASE_IMAGE="$GENIO_RELEASE_IMAGE" \
railway config plan
```

Staging plans also require:

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
`GENIO_VERIFIED_CANDIDATE_EVIDENCE_HASH`. Set it to the `payloadHash` printed
only after this command succeeds with all exact target hashes:

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

Carry the same value through all three production plans. The expand plan also
requires `GENIO_BRIDGE_VERIFIED_CANDIDATE_EVIDENCE_HASH` with that value; the
activate plan requires both the bridge value and
`GENIO_EXPAND_VERIFIED_CANDIDATE_EVIDENCE_HASH`. These lineage inputs prevent
accidental hash replacement between plans. Railway validates the SHA-256 shape
and equality only; it does not re-verify the signature. Staging does not require
these variables.

## Notes

- `railway config plan` is safe and does not change Railway.
- Run the exact plan separately in the selected `staging` or `production`
  environment and review it before every apply. `GENIO_RELEASE_ENVIRONMENT`
  must match that selected Railway environment or evaluation fails.
- The configuration fails closed unless `GENIO_RELEASE_IMAGE` is an immutable
  GHCR SHA-256 digest and its full Git revision and stable semantic version are
  supplied. It also fails when the release phase or expected database schema
  is missing. API and both worker lanes use that same artifact and expose that
  identity, with image auto-updates disabled.
- Every production service exposes
  `RELEASE_VERIFIED_CANDIDATE_EVIDENCE_HASH` as part of its release identity.
  It is the verified candidate payload hash, not a signature or a substitute
  for running the verification command.
- Rollout percentages, evidence approvals, guidance cohorts, and `APP_ORIGIN`
  are preserved per Railway environment. The runtime phase fence makes those
  preserved canonical/schema-4 settings inert during bridge and expand.
  Activation also checks the authoritative database schema before creating a
  contract-3 brief.
- Every staging plan additionally requires a dedicated non-production HTTPS
  MusicKit origin, a monthly cap no higher than $10, distinct staging and
  production provider/Apple secret-version hashes, Apple-account separation
  evidence, and MusicKit-origin registration evidence. These are safe
  fingerprints/evidence hashes, never credentials.
- Generate the bridge and expand evidence with `pnpm
  release:migration:verify -- ...`. The verifier requires two advancing
  protocol-10 heartbeats from both worker lanes, the exact artifact revision,
  compatible schema support, and canonical/schema-4 emission disabled.
- `railway config apply` previews changes and asks before applying unless you pass `--yes`.
- Destructive changes in non-interactive or agent sessions require `railway config apply --confirm-destructive` after reviewing the plan.
- After schema-18 writes, rollback means redeploying the same schema-13–18
  artifact in `bridge` phase and routing new assignments to the last proven
  cohort. Never deploy an older max-schema-16 binary and never down-migrate.
- Services already managed by `railway.json` / `railway.toml` must be migrated before `.railway/railway.ts` can manage them.
- Use `replicas` for scaling; advanced placement can still specify region names.
- Use `group("Name", [resources])` to keep large projects organized on the Railway canvas.
- Secrets imported from Railway are rendered as `preserve()` so existing values are retained without writing secret values to source. Use `railway config pull --omit-preserved-variables` for a smaller import.
