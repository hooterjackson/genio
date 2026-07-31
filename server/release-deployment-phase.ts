import { DATABASE_SCHEMA_SUPPORT } from "../db/index.ts";
import {
  REQUIRED_ACTIVATION_DATABASE_SCHEMA_VERSION,
  REQUIRED_ACTIVATION_EXECUTION_CONTROLS,
} from "../shared/release-activation-contract.ts";

export const RELEASE_DEPLOYMENT_PHASES = [
  "bootstrap",
  "bridge",
  "expand",
  "activate",
] as const;
export type ReleaseDeploymentPhase = typeof RELEASE_DEPLOYMENT_PHASES[number];
export type RuntimeReleaseDeploymentPhase = ReleaseDeploymentPhase | "unconfigured" | "invalid";
export type ReleaseConfigurationDiagnosticCode =
  | "release_phase_unconfigured"
  | "release_phase_invalid"
  | "release_environment_invalid"
  | "release_execution_disabled"
  | "release_expected_schema_invalid";

export const CANONICAL_ACTIVATION_DATABASE_SCHEMA_VERSION =
  REQUIRED_ACTIVATION_DATABASE_SCHEMA_VERSION;
export const CANONICAL_ACTIVATION_DATABASE_CAPABILITY_SETTING =
  "release_manifest_canary_guards_version";
export const CANONICAL_ACTIVATION_DATABASE_CAPABILITY_VERSION =
  REQUIRED_ACTIVATION_EXECUTION_CONTROLS
    .RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION;
/** Additive 0019 fence; separate so schema-18 bridge artifacts stay healthy. */
export const CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_SETTING =
  "canonical_execution_hardening_version";
export const CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_VERSION =
  REQUIRED_ACTIVATION_EXECUTION_CONTROLS
    .RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION;
/** Additive 0020 immutable source/semantic executor fence. */
export const CANONICAL_EXECUTOR_RELEASE_IDENTITY_DATABASE_CAPABILITY_SETTING =
  "canonical_executor_release_identity_fencing_version";
export const CANONICAL_EXECUTOR_RELEASE_IDENTITY_DATABASE_CAPABILITY_VERSION =
  "1";
export const PROOF_ARCHITECTURE_DATABASE_VERSION_SETTING =
  "proof_architecture_version";
export const PROOF_ARCHITECTURE_DATABASE_AUTHORITY_SETTING =
  "proof_architecture_authority";
export const PROOF_ARCHITECTURE_DATABASE_VERSION = "1";
export const CANONICAL_RELEASE_DATABASE_CAPABILITY_VERSION =
  REQUIRED_ACTIVATION_EXECUTION_CONTROLS
    .RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION;
export const STAGING_BOOTSTRAP_FRESH_EMPTY_DATABASE_CONFIRMATION = "true";

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
  return /^(?:1[3-9]|20)$/u.test(value) ? value : null;
}

/**
 * Stable, secret-free startup diagnostics for hosted services. These codes
 * make an operator-visible configuration defect distinguishable from an
 * ordinary dependency outage without leaking environment values.
 */
export function releaseConfigurationDiagnosticCodes(
  environment: NodeJS.ProcessEnv = process.env,
): ReleaseConfigurationDiagnosticCode[] {
  const phase = runtimeReleaseDeploymentPhase(environment);
  const hosted = environment.NODE_ENV === "production"
    || Boolean(environment.RELEASE_ENVIRONMENT?.trim());
  if (!hosted) return [];
  const diagnostics: ReleaseConfigurationDiagnosticCode[] = [];
  if (phase === "unconfigured") {
    diagnostics.push("release_phase_unconfigured");
  } else if (phase === "invalid") {
    diagnostics.push("release_phase_invalid");
  }
  if (!["staging", "production"].includes(
    environment.RELEASE_ENVIRONMENT?.trim() ?? "",
  )) {
    diagnostics.push("release_environment_invalid");
  }
  if (phase !== "bootstrap"
    && environment.RELEASE_EXECUTION_ENABLED?.trim() !== "true") {
    diagnostics.push("release_execution_disabled");
  }
  if (expectedReleaseDatabaseSchemaVersion(environment) === null) {
    diagnostics.push("release_expected_schema_invalid");
  }
  return diagnostics;
}

/**
 * Bootstrap exists solely to migrate a newly-created, empty staging database
 * before any worker or public mutation is allowed. Treat the runtime flag as
 * inert unless every non-secret fence emitted by the Railway plan agrees.
 */
export function stagingBootstrapConfigured(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return runtimeReleaseDeploymentPhase(environment) === "bootstrap"
    && environment.RELEASE_ENVIRONMENT?.trim() === "staging"
    && expectedReleaseDatabaseSchemaVersion(environment)
      === CANONICAL_ACTIVATION_DATABASE_SCHEMA_VERSION
    && environment.RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION?.trim()
      === CANONICAL_RELEASE_DATABASE_CAPABILITY_VERSION
    && environment.RELEASE_STAGING_BOOTSTRAP_FRESH_EMPTY_DATABASE_CONFIRMED?.trim()
      === STAGING_BOOTSTRAP_FRESH_EMPTY_DATABASE_CONFIRMATION;
}

/**
 * No provider, matching, publication, or other mutating API work may execute
 * while the fresh-staging bootstrap artifact is running. This is derived from
 * the phase rather than an independently mutable enable flag.
 */
export function releaseExecutionConfigured(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const phase = runtimeReleaseDeploymentPhase(environment);
  if (phase === "bootstrap") return false;
  if (phase === "bridge" || phase === "expand" || phase === "activate") {
    return (
      environment.RELEASE_ENVIRONMENT?.trim() === "staging"
      || environment.RELEASE_ENVIRONMENT?.trim() === "production"
    )
      && environment.RELEASE_EXECUTION_ENABLED?.trim() === "true"
      && expectedReleaseDatabaseSchemaVersion(environment) !== null;
  }
  // Local development predates release-phase fencing. A deployed production
  // process or any partially configured release environment must fail closed.
  return phase === "unconfigured"
    && environment.NODE_ENV !== "production"
    && !(environment.RELEASE_ENVIRONMENT?.trim());
}

/**
 * Readiness for bootstrap is intentionally stronger than ordinary bridge
 * readiness: migrations 0018 through 0020, their capability markers, and the
 * exact 0020 trigger/column inventory must be visible.
 */
export function releaseDatabaseReadinessReady(input: {
  environment?: NodeJS.ProcessEnv;
  observedDatabaseSchemaVersion: string | null;
  observedDatabaseCapabilityVersion?: string | null;
  observedCanonicalExecutionHardeningVersion?: string | null;
  observedCanonicalExecutorReleaseIdentityFencingVersion?: string | null;
  observedProofArchitectureVersion?: string | null;
  observedProofArchitectureAuthority?: string | null;
  executorReleaseIdentityFenceSupported?: boolean;
}): boolean {
  const phase = runtimeReleaseDeploymentPhase(input.environment);
  if (phase === "bootstrap") {
    return stagingBootstrapConfigured(input.environment)
      && input.observedDatabaseSchemaVersion
        === CANONICAL_ACTIVATION_DATABASE_SCHEMA_VERSION
      && input.observedDatabaseCapabilityVersion
        === CANONICAL_ACTIVATION_DATABASE_CAPABILITY_VERSION
      && input.observedCanonicalExecutionHardeningVersion
        === CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_VERSION
      && input.observedCanonicalExecutorReleaseIdentityFencingVersion
        === CANONICAL_EXECUTOR_RELEASE_IDENTITY_DATABASE_CAPABILITY_VERSION
      && input.observedProofArchitectureVersion
        === PROOF_ARCHITECTURE_DATABASE_VERSION
      && ["shadow", "native"].includes(
        input.observedProofArchitectureAuthority ?? "",
      )
      && input.executorReleaseIdentityFenceSupported === true;
  }
  if (phase === "activate") {
    return releaseExecutionConfigured(input.environment)
      && canonicalContractActivationReady(input);
  }
  if (phase === "bridge" || phase === "expand") {
    const expectedSchema = expectedReleaseDatabaseSchemaVersion(input.environment);
    return releaseExecutionConfigured(input.environment)
      && expectedSchema !== null
      && input.observedDatabaseSchemaVersion === expectedSchema
      && (
        Number(expectedSchema) < 19
        || (
          input.observedDatabaseCapabilityVersion
            === CANONICAL_ACTIVATION_DATABASE_CAPABILITY_VERSION
          && input.observedCanonicalExecutionHardeningVersion
            === CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_VERSION
          && input.observedCanonicalExecutorReleaseIdentityFencingVersion
            === CANONICAL_EXECUTOR_RELEASE_IDENTITY_DATABASE_CAPABILITY_VERSION
          && input.executorReleaseIdentityFenceSupported === true
          && (
            Number(expectedSchema) < 20
            || (
              input.observedProofArchitectureVersion
                === PROOF_ARCHITECTURE_DATABASE_VERSION
              && ["shadow", "native"].includes(
                input.observedProofArchitectureAuthority ?? "",
              )
            )
          )
        )
      );
  }
  return phase === "unconfigured"
    && releaseExecutionConfigured(input.environment);
}

/**
 * Environment flags are only activation intent. They cannot enable canonical
 * contract/schema-6 emission until the immutable artifact has completed the
 * explicit expand phase and is configured for schema 20 plus the exact
 * capability-fenced query-plan protocol. Historical schema-4 plans remain
 * executable, but no activated artifact may create new schema-4 work.
 */
export function canonicalContractActivationConfigured(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return releaseExecutionConfigured(environment)
    && runtimeReleaseDeploymentPhase(environment) === "activate"
    && environment.RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION?.trim()
      === REQUIRED_ACTIVATION_EXECUTION_CONTROLS
        .RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION
    && environment.RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION?.trim()
      === REQUIRED_ACTIVATION_EXECUTION_CONTROLS
        .RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION
    && environment.RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION?.trim()
      === REQUIRED_ACTIVATION_EXECUTION_CONTROLS
        .RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION
    && environment.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION?.trim()
      === REQUIRED_ACTIVATION_EXECUTION_CONTROLS
        .PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION
    && environment.RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION?.trim()
      === REQUIRED_ACTIVATION_EXECUTION_CONTROLS
        .RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION
    && environment.PIPELINE_V3_PROOF_ARCHITECTURE_MODE?.trim()
      === REQUIRED_ACTIVATION_EXECUTION_CONTROLS
        .PIPELINE_V3_PROOF_ARCHITECTURE_MODE
    && expectedReleaseDatabaseSchemaVersion(environment)
      === CANONICAL_ACTIVATION_DATABASE_SCHEMA_VERSION
    && Number(DATABASE_SCHEMA_SUPPORT.maximum)
      >= Number(CANONICAL_ACTIVATION_DATABASE_SCHEMA_VERSION);
}

/**
 * The API additionally checks the authoritative database value before
 * creating a contract-3 brief. A stale or operator-supplied expected value is
 * never sufficient by itself.
 */
export function canonicalContractActivationReady(input: {
  environment?: NodeJS.ProcessEnv;
  observedDatabaseSchemaVersion: string | null;
  observedDatabaseCapabilityVersion?: string | null;
  observedCanonicalExecutionHardeningVersion?: string | null;
  observedCanonicalExecutorReleaseIdentityFencingVersion?: string | null;
  observedProofArchitectureVersion?: string | null;
  observedProofArchitectureAuthority?: string | null;
  executorReleaseIdentityFenceSupported?: boolean;
}): boolean {
  return canonicalContractActivationConfigured(input.environment)
    && input.observedDatabaseSchemaVersion === CANONICAL_ACTIVATION_DATABASE_SCHEMA_VERSION
    && input.observedDatabaseCapabilityVersion
      === CANONICAL_ACTIVATION_DATABASE_CAPABILITY_VERSION
    && input.observedCanonicalExecutionHardeningVersion
      === CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_VERSION
    && input.observedCanonicalExecutorReleaseIdentityFencingVersion
      === CANONICAL_EXECUTOR_RELEASE_IDENTITY_DATABASE_CAPABILITY_VERSION
    && input.observedProofArchitectureVersion
      === PROOF_ARCHITECTURE_DATABASE_VERSION
    && input.observedProofArchitectureAuthority === "native"
    && input.executorReleaseIdentityFenceSupported === true;
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
