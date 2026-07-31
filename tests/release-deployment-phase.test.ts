import { describe, expect, test } from "vitest";
import {
  canonicalContractActivationConfigured,
  canonicalContractActivationReady,
  canonicalContractCohortConfigured,
  expectedReleaseDatabaseSchemaVersion,
  releaseDatabaseReadinessReady,
  releaseConfigurationDiagnosticCodes,
  releaseExecutionConfigured,
  runtimeReleaseDeploymentPhase,
} from "../server/release-deployment-phase.ts";

describe("runtime release deployment phase", () => {
  test("reports stable secret-free startup diagnostics", () => {
    expect(releaseConfigurationDiagnosticCodes({
      NODE_ENV: "production",
    })).toEqual([
      "release_phase_unconfigured",
      "release_environment_invalid",
      "release_execution_disabled",
      "release_expected_schema_invalid",
    ]);
    expect(releaseConfigurationDiagnosticCodes({
      NODE_ENV: "production",
      RELEASE_ENVIRONMENT: "production",
      RELEASE_DEPLOYMENT_PHASE: "surprise",
      RELEASE_EXECUTION_ENABLED: "true",
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "20",
    })).toEqual(["release_phase_invalid"]);
    expect(releaseConfigurationDiagnosticCodes({
      NODE_ENV: "production",
      RELEASE_ENVIRONMENT: "production",
      RELEASE_DEPLOYMENT_PHASE: "activate",
      RELEASE_EXECUTION_ENABLED: "true",
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "20",
    })).toEqual([]);
    expect(releaseConfigurationDiagnosticCodes({})).toEqual([]);
  });

  test("fails closed on missing, invalid, pre-activation, and schema-mismatched configuration", () => {
    expect(runtimeReleaseDeploymentPhase({})).toBe("unconfigured");
    expect(runtimeReleaseDeploymentPhase({ RELEASE_DEPLOYMENT_PHASE: "surprise" })).toBe("invalid");
    expect(expectedReleaseDatabaseSchemaVersion({
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "not-a-schema",
    })).toBeNull();
    expect(releaseExecutionConfigured({})).toBe(true);
    expect(releaseExecutionConfigured({ NODE_ENV: "production" })).toBe(false);
    expect(releaseExecutionConfigured({
      NODE_ENV: "production",
      RELEASE_ENVIRONMENT: "production",
      RELEASE_DEPLOYMENT_PHASE: "surprise",
    })).toBe(false);
    expect(releaseDatabaseReadinessReady({
      environment: {
        NODE_ENV: "production",
        RELEASE_ENVIRONMENT: "production",
        RELEASE_DEPLOYMENT_PHASE: "surprise",
      },
      observedDatabaseSchemaVersion: "19",
      observedDatabaseCapabilityVersion: "1",
    })).toBe(false);
    for (const environment of [
      {
        RELEASE_DEPLOYMENT_PHASE: "bridge",
        RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "19",
      },
      {
        RELEASE_DEPLOYMENT_PHASE: "expand",
        RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "19",
      },
      {
        RELEASE_DEPLOYMENT_PHASE: "activate",
        RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "17",
      },
      {
        RELEASE_DEPLOYMENT_PHASE: "activate",
      },
    ]) {
      expect(canonicalContractActivationConfigured(environment)).toBe(false);
      expect(canonicalContractActivationReady({
        environment,
        observedDatabaseSchemaVersion: "19",
        observedDatabaseCapabilityVersion: "1",
      })).toBe(false);
    }
  });

  test("requires the configured phase, actual schema, and a cohort independently", () => {
    const environment = {
      RELEASE_ENVIRONMENT: "production",
      RELEASE_DEPLOYMENT_PHASE: "activate",
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "20",
      RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
      RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
      RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
      RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION: "1",
      PIPELINE_V3_PROOF_ARCHITECTURE_MODE: "native",
      RELEASE_EXECUTION_ENABLED: "true",
      PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "6",
      GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
    };
    expect(canonicalContractActivationConfigured(environment)).toBe(true);
    expect(canonicalContractActivationReady({
      environment,
      observedDatabaseSchemaVersion: "17",
      observedDatabaseCapabilityVersion: "1",
    })).toBe(false);
    expect(canonicalContractActivationReady({
      environment,
      observedDatabaseSchemaVersion: "20",
      observedDatabaseCapabilityVersion: null,
    })).toBe(false);
    expect(canonicalContractActivationReady({
      environment,
      observedDatabaseSchemaVersion: "20",
      observedDatabaseCapabilityVersion: "1",
      observedCanonicalExecutionHardeningVersion: "1",
      observedCanonicalExecutorReleaseIdentityFencingVersion: "1",
      observedProofArchitectureVersion: "1",
      observedProofArchitectureAuthority: "native",
      executorReleaseIdentityFenceSupported: true,
    })).toBe(true);
    expect(canonicalContractCohortConfigured(environment)).toBe(true);
    expect(canonicalContractCohortConfigured({
      RELEASE_ENVIRONMENT: "production",
      RELEASE_DEPLOYMENT_PHASE: "activate",
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "20",
      RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
      RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
      RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
      RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION: "1",
      PIPELINE_V3_PROOF_ARCHITECTURE_MODE: "native",
      RELEASE_EXECUTION_ENABLED: "true",
    })).toBe(false);
  });

  test("drains schema-4/5 work but only activates new canonical work under schema 6 hardening", () => {
    const base = {
      RELEASE_ENVIRONMENT: "production",
      RELEASE_DEPLOYMENT_PHASE: "activate",
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "20",
      RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
      RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
      RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
      RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION: "1",
      PIPELINE_V3_PROOF_ARCHITECTURE_MODE: "native",
      RELEASE_EXECUTION_ENABLED: "true",
      GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
    };
    const schema4 = {
      ...base,
      PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "4",
    };
    expect(releaseExecutionConfigured(schema4)).toBe(true);
    expect(canonicalContractActivationConfigured(schema4)).toBe(false);
    expect(canonicalContractActivationReady({
      environment: schema4,
      observedDatabaseSchemaVersion: "20",
      observedDatabaseCapabilityVersion: "1",
      observedCanonicalExecutionHardeningVersion: "1",
    })).toBe(false);

    const schema5 = {
      ...base,
      PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "6",
    };
    expect(canonicalContractActivationReady({
      environment: schema5,
      observedDatabaseSchemaVersion: "20",
      observedDatabaseCapabilityVersion: "1",
      observedCanonicalExecutionHardeningVersion: null,
    })).toBe(false);
    expect(canonicalContractActivationReady({
      environment: schema5,
      observedDatabaseSchemaVersion: "20",
      observedDatabaseCapabilityVersion: "1",
      observedCanonicalExecutionHardeningVersion: "1",
      observedCanonicalExecutorReleaseIdentityFencingVersion: "1",
      observedProofArchitectureVersion: "1",
      observedProofArchitectureAuthority: "native",
      executorReleaseIdentityFenceSupported: true,
    })).toBe(true);
    expect(canonicalContractActivationReady({
      environment: schema5,
      observedDatabaseSchemaVersion: "20",
      observedDatabaseCapabilityVersion: "1",
      observedCanonicalExecutionHardeningVersion: "1",
      observedCanonicalExecutorReleaseIdentityFencingVersion: null,
      observedProofArchitectureVersion: "1",
      observedProofArchitectureAuthority: "native",
      executorReleaseIdentityFenceSupported: true,
    })).toBe(false);
    expect(canonicalContractActivationReady({
      environment: schema5,
      observedDatabaseSchemaVersion: "20",
      observedDatabaseCapabilityVersion: "1",
      observedCanonicalExecutionHardeningVersion: "1",
      observedCanonicalExecutorReleaseIdentityFencingVersion: "1",
      observedProofArchitectureVersion: "1",
      observedProofArchitectureAuthority: "native",
      executorReleaseIdentityFenceSupported: false,
    })).toBe(false);
  });

  test("requires every independently signed activation control without fallback", () => {
    const valid = {
      RELEASE_ENVIRONMENT: "production",
      RELEASE_DEPLOYMENT_PHASE: "activate",
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "20",
      RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
      RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
      RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
      RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION: "1",
      PIPELINE_V3_PROOF_ARCHITECTURE_MODE: "native",
      RELEASE_EXECUTION_ENABLED: "true",
      PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "6",
    };
    expect(canonicalContractActivationConfigured(valid)).toBe(true);
    for (const key of [
      "RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION",
      "RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION",
      "RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION",
      "RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION",
      "PIPELINE_V3_PROOF_ARCHITECTURE_MODE",
      "PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION",
    ] as const) {
      const missing = Object.fromEntries(
        Object.entries(valid).filter(([entryKey]) => entryKey !== key),
      );
      expect(canonicalContractActivationConfigured(missing)).toBe(false);
      expect(canonicalContractActivationConfigured({
        ...valid,
        [key]: "unexpected",
      })).toBe(false);
    }
  });

  test("requires bridge and expand runtime identity plus authoritative database state", () => {
    const bridge = {
      NODE_ENV: "production",
      RELEASE_ENVIRONMENT: "production",
      RELEASE_DEPLOYMENT_PHASE: "bridge",
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "17",
      RELEASE_EXECUTION_ENABLED: "true",
    };
    expect(releaseExecutionConfigured(bridge)).toBe(true);
    expect(releaseDatabaseReadinessReady({
      environment: bridge,
      observedDatabaseSchemaVersion: "17",
      observedDatabaseCapabilityVersion: null,
    })).toBe(true);
    expect(releaseDatabaseReadinessReady({
      environment: bridge,
      observedDatabaseSchemaVersion: "19",
      observedDatabaseCapabilityVersion: "1",
    })).toBe(false);

    const expand = {
      ...bridge,
      RELEASE_DEPLOYMENT_PHASE: "expand",
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "19",
    };
    expect(releaseDatabaseReadinessReady({
      environment: expand,
      observedDatabaseSchemaVersion: "19",
      observedDatabaseCapabilityVersion: null,
    })).toBe(false);
    expect(releaseDatabaseReadinessReady({
      environment: expand,
      observedDatabaseSchemaVersion: "19",
      observedDatabaseCapabilityVersion: "1",
      observedCanonicalExecutionHardeningVersion: "1",
      observedCanonicalExecutorReleaseIdentityFencingVersion: "1",
      executorReleaseIdentityFenceSupported: true,
    })).toBe(true);

    const schema20Expand = {
      ...expand,
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "20",
      PIPELINE_V3_PROOF_ARCHITECTURE_MODE: "shadow",
    };
    expect(releaseDatabaseReadinessReady({
      environment: schema20Expand,
      observedDatabaseSchemaVersion: "20",
      observedDatabaseCapabilityVersion: "1",
      observedCanonicalExecutionHardeningVersion: "1",
      observedCanonicalExecutorReleaseIdentityFencingVersion: "1",
      observedProofArchitectureVersion: "1",
      observedProofArchitectureAuthority: "shadow",
      executorReleaseIdentityFenceSupported: true,
    })).toBe(true);
  });
});
