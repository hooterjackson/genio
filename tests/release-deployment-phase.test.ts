import { describe, expect, test } from "vitest";
import {
  canonicalContractActivationConfigured,
  canonicalContractActivationReady,
  canonicalContractCohortConfigured,
  expectedReleaseDatabaseSchemaVersion,
  runtimeReleaseDeploymentPhase,
} from "../server/release-deployment-phase.ts";

describe("runtime release deployment phase", () => {
  test("fails closed on missing, invalid, pre-activation, and schema-mismatched configuration", () => {
    expect(runtimeReleaseDeploymentPhase({})).toBe("unconfigured");
    expect(runtimeReleaseDeploymentPhase({ RELEASE_DEPLOYMENT_PHASE: "surprise" })).toBe("invalid");
    expect(expectedReleaseDatabaseSchemaVersion({
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "not-a-schema",
    })).toBeNull();
    for (const environment of [
      {
        RELEASE_DEPLOYMENT_PHASE: "bridge",
        RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
      },
      {
        RELEASE_DEPLOYMENT_PHASE: "expand",
        RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
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
        observedDatabaseSchemaVersion: "18",
      })).toBe(false);
    }
  });

  test("requires the configured phase, actual schema, and a cohort independently", () => {
    const environment = {
      RELEASE_DEPLOYMENT_PHASE: "activate",
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
      GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
    };
    expect(canonicalContractActivationConfigured(environment)).toBe(true);
    expect(canonicalContractActivationReady({
      environment,
      observedDatabaseSchemaVersion: "17",
    })).toBe(false);
    expect(canonicalContractActivationReady({
      environment,
      observedDatabaseSchemaVersion: "18",
    })).toBe(true);
    expect(canonicalContractCohortConfigured(environment)).toBe(true);
    expect(canonicalContractCohortConfigured({
      RELEASE_DEPLOYMENT_PHASE: "activate",
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
    })).toBe(false);
  });
});
