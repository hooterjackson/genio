import { createHash } from "node:crypto";

export const STAGING_BOOTSTRAP_PHASE = "bootstrap";
export const STAGING_BOOTSTRAP_DATABASE_SCHEMA_VERSION = "19";
export const STAGING_BOOTSTRAP_DATABASE_CAPABILITY_VERSION = "2";
export const STAGING_BOOTSTRAP_FRESH_EMPTY_DATABASE_CONFIRMATION = "true";

export interface RailwayStagingBootstrapRuntimeConfiguration {
  expectedProjectId: string;
  expectedEnvironmentId: string;
  gatewayKeyId: string;
  gatewayHmacSecret: string;
  capabilityPepper: string;
  capabilityPepperVersion: string;
}

export interface RailwayStagingBootstrapConfiguration {
  environment: "staging";
  phase: typeof STAGING_BOOTSTRAP_PHASE;
  expectedDatabaseSchemaVersion: typeof STAGING_BOOTSTRAP_DATABASE_SCHEMA_VERSION;
  expectedDatabaseCapabilityVersion:
    typeof STAGING_BOOTSTRAP_DATABASE_CAPABILITY_VERSION;
  freshEmptyDatabaseConfirmed: true;
  verifiedCandidateEvidenceHash: null;
  bridgeConvergenceEvidenceHash: null;
  expandConvergenceEvidenceHash: null;
  activationRollout: null;
  publicRolloutEvidenceHash: null;
  publicRolloutStage: null;
  publicRolloutConfiguration: null;
  publicRolloutOperation: null;
  publicRolloutIntentGroup: null;
  publicRolloutFromPercent: null;
  publicRolloutToPercent: null;
  previousPublicRolloutEvidenceHash: null;
  publicRolloutEvidenceEnvelopeBase64: null;
  publicRolloutIntentCanaryHash: null;
  publicRolloutIntentCanaryEnvelopeBase64: null;
  publicRolloutIntentCanaryVerificationKeyBase64: null;
  publicRolloutIntentCanaryProducerKeyId: null;
  publicRolloutIntentCanaryProducerKeySha256: null;
  publicRolloutIntentCanaryAuthorityPolicySha256: null;
  publicRolloutRollbackWarrantHash: null;
  publicRolloutRollbackWarrantEnvelopeBase64: null;
  publicRolloutVerificationKeyBase64: null;
  bootstrapRuntime: RailwayStagingBootstrapRuntimeConfiguration;
  staging: null;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_LABEL = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const EXPLICIT_BOOTSTRAP_SECRET = /^[\x21-\x7e]{32,256}$/u;
const FORBIDDEN_BOOTSTRAP_INPUTS = [
  "DATABASE_URL",
  "DATABASE_PUBLIC_URL",
  "OPENAI_API_KEY",
  "APPLE_MUSICKIT_PRIVATE_KEY",
  "APPLE_MUSICKIT_PRIVATE_KEY_BASE64",
  "APPLE_TOKEN_ENCRYPTION_KEY",
  "GATEWAY_KEYS_JSON",
  "GATEWAY_HMAC_SECRET",
  "GATEWAY_PREVIOUS_HMAC_SECRET",
  "CAPABILITY_PEPPER",
  "CAPABILITY_PREVIOUS_PEPPER",
  "RELEASE_CANARY_HMAC_SECRET",
  "RESEND_API_KEY",
  "DISCOGS_TOKEN",
  "GENIO_VERIFIED_CANDIDATE_EVIDENCE_FILE",
  "GENIO_BRIDGE_CONVERGENCE_EVIDENCE_FILE",
  "GENIO_EXPAND_CONVERGENCE_EVIDENCE_FILE",
  "GENIO_PUBLIC_ROLLOUT_EVIDENCE_FILE",
  "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_FILE",
  "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_HASH",
  "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_VERIFICATION_KEY_FILE",
  "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_ID",
  "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_SHA256",
  "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256",
  "GENIO_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_FILE",
] as const;

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function uuid(environment: NodeJS.ProcessEnv, name: string): string {
  const value = required(environment, name).toLowerCase();
  if (!UUID.test(value)) throw new Error(`${name} must be a Railway UUID`);
  return value;
}

function safeLabel(environment: NodeJS.ProcessEnv, name: string): string {
  const value = required(environment, name);
  if (!SAFE_LABEL.test(value)) throw new Error(`${name} must be a safe label`);
  return value;
}

function explicitSecret(environment: NodeJS.ProcessEnv, name: string): string {
  const value = required(environment, name);
  if (!EXPLICIT_BOOTSTRAP_SECRET.test(value)) {
    throw new Error(`${name} must be 32 through 256 printable non-space characters`);
  }
  return value;
}

function sha256(environment: NodeJS.ProcessEnv, name: string): string {
  const value = required(environment, name).toLowerCase();
  if (!SHA256.test(value)) throw new Error(`${name} must be a SHA-256 digest`);
  return value;
}

function rejectInheritedInputs(environment: NodeJS.ProcessEnv): void {
  const present = FORBIDDEN_BOOTSTRAP_INPUTS.filter(
    (name) => Boolean(environment[name]?.trim()),
  );
  if (present.length > 0) {
    throw new Error(
      `Fresh staging bootstrap forbids inherited data or credential inputs: ${present.join(", ")}`,
    );
  }
}

/**
 * A fresh Railway staging environment has no schema on which a normal bridge
 * can become ready. Bootstrap is a one-time, migration-only phase. It is
 * deliberately parsed before the ordinary bridge/expand/activate contract so
 * production can never inherit this staging-only exception.
 */
export function railwayStagingBootstrapConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): RailwayStagingBootstrapConfiguration | null {
  const phase = environment.GENIO_RELEASE_PHASE?.trim() ?? "";
  const confirmation =
    environment.GENIO_STAGING_BOOTSTRAP_FRESH_EMPTY_DATABASE_CONFIRMED?.trim()
      ?? "";
  if (phase !== STAGING_BOOTSTRAP_PHASE) {
    if (confirmation) {
      throw new Error(
        "GENIO_STAGING_BOOTSTRAP_FRESH_EMPTY_DATABASE_CONFIRMED is valid only during bootstrap",
      );
    }
    return null;
  }
  if (required(environment, "GENIO_RELEASE_ENVIRONMENT") !== "staging") {
    throw new Error("The bootstrap release phase is accepted only for staging");
  }
  if (
    required(environment, "GENIO_EXPECTED_DATABASE_SCHEMA_VERSION")
      !== STAGING_BOOTSTRAP_DATABASE_SCHEMA_VERSION
  ) {
    throw new Error(
      `bootstrap requires GENIO_EXPECTED_DATABASE_SCHEMA_VERSION=${STAGING_BOOTSTRAP_DATABASE_SCHEMA_VERSION}`,
    );
  }
  if (confirmation !== STAGING_BOOTSTRAP_FRESH_EMPTY_DATABASE_CONFIRMATION) {
    throw new Error(
      "GENIO_STAGING_BOOTSTRAP_FRESH_EMPTY_DATABASE_CONFIRMED=true is required only after confirming the staging database is fresh and empty",
    );
  }
  rejectInheritedInputs(environment);
  const gatewayHmacSecret = explicitSecret(
    environment,
    "GENIO_STAGING_BOOTSTRAP_GATEWAY_HMAC_SECRET",
  );
  const capabilityPepper = explicitSecret(
    environment,
    "GENIO_STAGING_BOOTSTRAP_CAPABILITY_PEPPER",
  );
  if (gatewayHmacSecret === capabilityPepper) {
    throw new Error("Bootstrap gateway and capability secrets must be independent");
  }
  if (
    createHash("sha256").update(gatewayHmacSecret).digest("hex")
      === sha256(
        environment,
        "GENIO_STAGING_BOOTSTRAP_PRODUCTION_GATEWAY_HMAC_SHA256",
      )
  ) {
    throw new Error("Bootstrap gateway secret must not match production");
  }
  if (
    createHash("sha256").update(capabilityPepper).digest("hex")
      === sha256(
        environment,
        "GENIO_STAGING_BOOTSTRAP_PRODUCTION_CAPABILITY_PEPPER_SHA256",
      )
  ) {
    throw new Error("Bootstrap capability pepper must not match production");
  }
  return Object.freeze({
    environment: "staging",
    phase: STAGING_BOOTSTRAP_PHASE,
    expectedDatabaseSchemaVersion: STAGING_BOOTSTRAP_DATABASE_SCHEMA_VERSION,
    expectedDatabaseCapabilityVersion:
      STAGING_BOOTSTRAP_DATABASE_CAPABILITY_VERSION,
    freshEmptyDatabaseConfirmed: true,
    verifiedCandidateEvidenceHash: null,
    bridgeConvergenceEvidenceHash: null,
    expandConvergenceEvidenceHash: null,
    activationRollout: null,
    publicRolloutEvidenceHash: null,
    publicRolloutStage: null,
    publicRolloutConfiguration: null,
    publicRolloutOperation: null,
    publicRolloutIntentGroup: null,
    publicRolloutFromPercent: null,
    publicRolloutToPercent: null,
    previousPublicRolloutEvidenceHash: null,
    publicRolloutEvidenceEnvelopeBase64: null,
    publicRolloutIntentCanaryHash: null,
    publicRolloutIntentCanaryEnvelopeBase64: null,
    publicRolloutIntentCanaryVerificationKeyBase64: null,
    publicRolloutIntentCanaryProducerKeyId: null,
    publicRolloutIntentCanaryProducerKeySha256: null,
    publicRolloutIntentCanaryAuthorityPolicySha256: null,
    publicRolloutRollbackWarrantHash: null,
    publicRolloutRollbackWarrantEnvelopeBase64: null,
    publicRolloutVerificationKeyBase64: null,
    bootstrapRuntime: Object.freeze({
      expectedProjectId: uuid(
        environment,
        "GENIO_STAGING_BOOTSTRAP_PROJECT_ID",
      ),
      expectedEnvironmentId: uuid(
        environment,
        "GENIO_STAGING_BOOTSTRAP_ENVIRONMENT_ID",
      ),
      gatewayKeyId: safeLabel(
        environment,
        "GENIO_STAGING_BOOTSTRAP_GATEWAY_KEY_ID",
      ),
      gatewayHmacSecret,
      capabilityPepper,
      capabilityPepperVersion: safeLabel(
        environment,
        "GENIO_STAGING_BOOTSTRAP_CAPABILITY_PEPPER_VERSION",
      ),
    }),
    staging: null,
  });
}
