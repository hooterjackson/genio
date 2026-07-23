import { createHash } from "node:crypto";

export const RELEASE_DEPLOYMENT_PHASES = ["bridge", "expand", "activate"] as const;
export type ReleaseDeploymentPhase = typeof RELEASE_DEPLOYMENT_PHASES[number];
export type ReleaseEnvironment = "staging" | "production";

export const EXPANDED_DATABASE_SCHEMA_VERSION = "18";
export const MAXIMUM_STAGING_MONTHLY_COST_USD = 10;

const SHA256 = /^[0-9a-f]{64}$/u;
const DATABASE_SCHEMA = /^(?:1[3-8])$/u;

export interface StagingReleaseControls {
  monthlyCostLimitUsd: number;
  musicKitOrigin: string;
  providerSecretVersionHash: string;
  productionProviderSecretVersionHash: string;
  appleSecretVersionHash: string;
  productionAppleSecretVersionHash: string;
  appleAccountSeparationEvidenceHash: string;
  musicKitOriginRegistrationEvidenceHash: string;
  controlHash: string;
}

export interface RailwayReleasePhaseConfiguration {
  environment: ReleaseEnvironment;
  phase: ReleaseDeploymentPhase;
  expectedDatabaseSchemaVersion: string;
  verifiedCandidateEvidenceHash: string | null;
  bridgeConvergenceEvidenceHash: string | null;
  expandConvergenceEvidenceHash: string | null;
  staging: StagingReleaseControls | null;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(environment: NodeJS.ProcessEnv, name: string): string {
  const value = required(environment, name).toLowerCase();
  if (!SHA256.test(value)) throw new Error(`${name} must be a SHA-256 digest`);
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function stagingOrigin(environment: NodeJS.ProcessEnv): string {
  const value = required(environment, "GENIO_STAGING_MUSICKIT_ORIGIN");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("GENIO_STAGING_MUSICKIT_ORIGIN must be a valid HTTPS origin");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.hostname === "9enio.com"
    || parsed.hostname === "www.9enio.com"
  ) {
    throw new Error(
      "GENIO_STAGING_MUSICKIT_ORIGIN must be a dedicated non-production HTTPS origin",
    );
  }
  return parsed.origin;
}

function stagingControls(environment: NodeJS.ProcessEnv): StagingReleaseControls {
  const monthlyCostLimitUsd = Number(
    required(environment, "GENIO_STAGING_MONTHLY_COST_LIMIT_USD"),
  );
  if (
    !Number.isFinite(monthlyCostLimitUsd)
    || monthlyCostLimitUsd <= 0
    || monthlyCostLimitUsd > MAXIMUM_STAGING_MONTHLY_COST_USD
  ) {
    throw new Error(
      `GENIO_STAGING_MONTHLY_COST_LIMIT_USD must be greater than 0 and no more than ${MAXIMUM_STAGING_MONTHLY_COST_USD}`,
    );
  }
  const controls = {
    monthlyCostLimitUsd,
    musicKitOrigin: stagingOrigin(environment),
    providerSecretVersionHash: sha256(environment, "GENIO_STAGING_PROVIDER_SECRET_VERSION_HASH"),
    productionProviderSecretVersionHash: sha256(
      environment,
      "GENIO_PRODUCTION_PROVIDER_SECRET_VERSION_HASH",
    ),
    appleSecretVersionHash: sha256(environment, "GENIO_STAGING_APPLE_SECRET_VERSION_HASH"),
    productionAppleSecretVersionHash: sha256(
      environment,
      "GENIO_PRODUCTION_APPLE_SECRET_VERSION_HASH",
    ),
    appleAccountSeparationEvidenceHash: sha256(
      environment,
      "GENIO_STAGING_APPLE_ACCOUNT_SEPARATION_EVIDENCE_HASH",
    ),
    musicKitOriginRegistrationEvidenceHash: sha256(
      environment,
      "GENIO_STAGING_MUSICKIT_ORIGIN_REGISTRATION_EVIDENCE_HASH",
    ),
  };
  if (controls.providerSecretVersionHash === controls.productionProviderSecretVersionHash) {
    throw new Error("staging and production provider secret versions must be different");
  }
  if (controls.appleSecretVersionHash === controls.productionAppleSecretVersionHash) {
    throw new Error("staging and production Apple secret versions must be different");
  }
  return Object.freeze({
    ...controls,
    controlHash: createHash("sha256").update(stableJson(controls)).digest("hex"),
  });
}

/**
 * Parse the explicit Railway promotion phase. The plan is intentionally
 * impossible to evaluate without this contract: a missing phase must not
 * inherit the old API pre-deploy migration behavior.
 */
export function railwayReleasePhaseConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): RailwayReleasePhaseConfiguration {
  const releaseEnvironment = required(environment, "GENIO_RELEASE_ENVIRONMENT");
  if (releaseEnvironment !== "staging" && releaseEnvironment !== "production") {
    throw new Error("GENIO_RELEASE_ENVIRONMENT must be staging or production");
  }
  const phaseValue = required(environment, "GENIO_RELEASE_PHASE");
  if (!(RELEASE_DEPLOYMENT_PHASES as readonly string[]).includes(phaseValue)) {
    throw new Error("GENIO_RELEASE_PHASE must be bridge, expand, or activate");
  }
  const phase = phaseValue as ReleaseDeploymentPhase;
  const verifiedCandidateEvidenceHash = releaseEnvironment === "production"
    ? sha256(environment, "GENIO_VERIFIED_CANDIDATE_EVIDENCE_HASH")
    : null;
  if (
    verifiedCandidateEvidenceHash
    && phase !== "bridge"
    && sha256(
      environment,
      "GENIO_BRIDGE_VERIFIED_CANDIDATE_EVIDENCE_HASH",
    ) !== verifiedCandidateEvidenceHash
  ) {
    throw new Error(
      "expand and activate must retain the exact bridge verified candidate evidence hash",
    );
  }
  if (
    verifiedCandidateEvidenceHash
    && phase === "activate"
    && sha256(
      environment,
      "GENIO_EXPAND_VERIFIED_CANDIDATE_EVIDENCE_HASH",
    ) !== verifiedCandidateEvidenceHash
  ) {
    throw new Error(
      "activate must retain the exact expand verified candidate evidence hash",
    );
  }
  const expectedDatabaseSchemaVersion = required(
    environment,
    "GENIO_EXPECTED_DATABASE_SCHEMA_VERSION",
  );
  if (!DATABASE_SCHEMA.test(expectedDatabaseSchemaVersion)) {
    throw new Error("GENIO_EXPECTED_DATABASE_SCHEMA_VERSION must be an integer from 13 through 18");
  }
  if (
    (phase === "expand" || phase === "activate")
    && expectedDatabaseSchemaVersion !== EXPANDED_DATABASE_SCHEMA_VERSION
  ) {
    throw new Error(
      `${phase} requires GENIO_EXPECTED_DATABASE_SCHEMA_VERSION=${EXPANDED_DATABASE_SCHEMA_VERSION}`,
    );
  }
  const bridgeConvergenceEvidenceHash = phase === "bridge"
    ? null
    : sha256(environment, "GENIO_BRIDGE_CONVERGENCE_EVIDENCE_HASH");
  const expandConvergenceEvidenceHash = phase === "activate"
    ? sha256(environment, "GENIO_EXPAND_CONVERGENCE_EVIDENCE_HASH")
    : null;
  const releaseImage = required(environment, "GENIO_RELEASE_IMAGE");
  if (
    phase !== "bridge"
    && required(environment, "GENIO_BRIDGE_RELEASE_IMAGE") !== releaseImage
  ) {
    throw new Error("expand and activate must use the exact bridge image digest");
  }
  if (
    phase === "activate"
    && required(environment, "GENIO_EXPAND_RELEASE_IMAGE") !== releaseImage
  ) {
    throw new Error("activate must use the exact expand image digest");
  }

  return Object.freeze({
    environment: releaseEnvironment,
    phase,
    expectedDatabaseSchemaVersion,
    verifiedCandidateEvidenceHash,
    bridgeConvergenceEvidenceHash,
    expandConvergenceEvidenceHash,
    staging: releaseEnvironment === "staging" ? stagingControls(environment) : null,
  });
}

export function releasePhasePreDeployCommand(
  configuration: Pick<RailwayReleasePhaseConfiguration, "phase">,
): string | undefined {
  return configuration.phase === "expand" ? "pnpm run db:migrate" : undefined;
}
