import { DATABASE_SCHEMA_VERSION } from "../db/index.ts";

export const RELEASE_DEPLOYMENT_PHASES = ["bridge", "expand", "activate"] as const;
export type ReleaseDeploymentPhase = typeof RELEASE_DEPLOYMENT_PHASES[number];
export type RuntimeReleaseDeploymentPhase = ReleaseDeploymentPhase | "unconfigured" | "invalid";

export const CANONICAL_ACTIVATION_DATABASE_SCHEMA_VERSION = "18";

export function runtimeReleaseDeploymentPhase(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeReleaseDeploymentPhase {
  const value = environment.RELEASE_DEPLOYMENT_PHASE?.trim() ?? "";
  if (!value) return "unconfigured";
  return (RELEASE_DEPLOYMENT_PHASES as readonly string[]).includes(value)
    ? value as ReleaseDeploymentPhase
    : "invalid";
}

export function expectedReleaseDatabaseSchemaVersion(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = environment.RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION?.trim() ?? "";
  return /^(?:1[3-8])$/u.test(value) ? value : null;
}

/**
 * Environment flags are only activation intent. They cannot enable canonical
 * contract/schema-4 emission until the immutable artifact has completed the
 * explicit expand phase and is configured for schema 18.
 */
export function canonicalContractActivationConfigured(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return runtimeReleaseDeploymentPhase(environment) === "activate"
    && expectedReleaseDatabaseSchemaVersion(environment)
      === CANONICAL_ACTIVATION_DATABASE_SCHEMA_VERSION
    && DATABASE_SCHEMA_VERSION === CANONICAL_ACTIVATION_DATABASE_SCHEMA_VERSION;
}

/**
 * The API additionally checks the authoritative database value before
 * creating a contract-3 brief. A stale or operator-supplied expected value is
 * never sufficient by itself.
 */
export function canonicalContractActivationReady(input: {
  environment?: NodeJS.ProcessEnv;
  observedDatabaseSchemaVersion: string | null;
}): boolean {
  return canonicalContractActivationConfigured(input.environment)
    && input.observedDatabaseSchemaVersion === CANONICAL_ACTIVATION_DATABASE_SCHEMA_VERSION;
}

export function canonicalContractCohortConfigured(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return canonicalContractActivationConfigured(environment) && (
    environment.GUIDANCE_CONTRACT_V3_ENABLED === "true"
    || environment.GUIDANCE_CONTRACT_V3_OWNER_CANARY === "true"
    || environment.GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED === "true"
  );
}
