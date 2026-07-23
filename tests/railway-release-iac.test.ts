import { afterEach, describe, expect, test, vi } from "vitest";
import {
  MAXIMUM_STAGING_MONTHLY_COST_USD,
  railwayReleasePhaseConfiguration,
} from "../.railway/release-phase.ts";
import {
  DATABASE_SCHEMA_SUPPORT,
  isDatabaseSchemaVersionCompatible,
} from "../db/index.ts";
import {
  canonicalContractActivationReady,
  runtimeReleaseDeploymentPhase,
} from "../server/release-deployment-phase.ts";

const releaseImage = `ghcr.io/example/genio@sha256:${"a".repeat(64)}`;
const releaseRevision = "b".repeat(40);
const releaseVersion = "2.4.0";
const hash = (character: string) => character.repeat(64);
const verifiedCandidateEvidenceHash = hash("9");

function baseEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GENIO_RELEASE_IMAGE: releaseImage,
    GENIO_RELEASE_REVISION: releaseRevision,
    GENIO_RELEASE_VERSION: releaseVersion,
    GENIO_RELEASE_ENVIRONMENT: "production",
    GENIO_RELEASE_PHASE: "bridge",
    GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "16",
    GENIO_VERIFIED_CANDIDATE_EVIDENCE_HASH: verifiedCandidateEvidenceHash,
    GENIO_BRIDGE_VERIFIED_CANDIDATE_EVIDENCE_HASH: verifiedCandidateEvidenceHash,
    GENIO_EXPAND_VERIFIED_CANDIDATE_EVIDENCE_HASH: verifiedCandidateEvidenceHash,
    ...overrides,
  };
}

function stagingEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return baseEnvironment({
    GENIO_RELEASE_ENVIRONMENT: "staging",
    GENIO_VERIFIED_CANDIDATE_EVIDENCE_HASH: undefined,
    GENIO_BRIDGE_VERIFIED_CANDIDATE_EVIDENCE_HASH: undefined,
    GENIO_EXPAND_VERIFIED_CANDIDATE_EVIDENCE_HASH: undefined,
    GENIO_STAGING_MONTHLY_COST_LIMIT_USD: "7.5",
    GENIO_STAGING_MUSICKIT_ORIGIN: "https://staging-9enio.example",
    GENIO_STAGING_PROVIDER_SECRET_VERSION_HASH: hash("1"),
    GENIO_PRODUCTION_PROVIDER_SECRET_VERSION_HASH: hash("2"),
    GENIO_STAGING_APPLE_SECRET_VERSION_HASH: hash("3"),
    GENIO_PRODUCTION_APPLE_SECRET_VERSION_HASH: hash("4"),
    GENIO_STAGING_APPLE_ACCOUNT_SEPARATION_EVIDENCE_HASH: hash("5"),
    GENIO_STAGING_MUSICKIT_ORIGIN_REGISTRATION_EVIDENCE_HASH: hash("6"),
    ...overrides,
  });
}

type RailwayService = {
  type: string;
  name: string;
  source?: { image?: string; autoUpdates?: { type?: string } };
  deploy?: { preDeployCommand?: string[] };
  variables?: Record<string, unknown>;
};

async function railwayProject(environment: NodeJS.ProcessEnv) {
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) vi.stubEnv(name, value);
  }
  vi.resetModules();
  const definition = (await import("../.railway/railway.ts")).default as unknown as (
    context: Record<string, unknown>,
  ) => {
    environments: string[];
    resources: RailwayService[];
  };
  const selectedEnvironment = environment.GENIO_RELEASE_ENVIRONMENT!;
  return definition({
    environment: selectedEnvironment,
    environmentName: selectedEnvironment,
    isEnvironment: (name: string) => name === selectedEnvironment,
    randomString: () => "test",
    shared: {},
  });
}

function service(project: Awaited<ReturnType<typeof railwayProject>>, name: string): RailwayService {
  return project.resources.find((resource) => resource.type === "service" && resource.name === name)!;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Railway immutable bridge-expand-activate release", () => {
  test("fails the plan closed when the phase is missing or invalid", () => {
    expect(() => railwayReleasePhaseConfiguration(baseEnvironment({
      GENIO_RELEASE_PHASE: undefined,
    }))).toThrow(/GENIO_RELEASE_PHASE is required/u);
    expect(() => railwayReleasePhaseConfiguration(baseEnvironment({
      GENIO_RELEASE_PHASE: "migrate-and-hope",
    }))).toThrow(/bridge, expand, or activate/u);
  });

  test("requires verified candidate evidence for production but not staging", () => {
    expect(() => railwayReleasePhaseConfiguration(baseEnvironment({
      GENIO_VERIFIED_CANDIDATE_EVIDENCE_HASH: undefined,
    }))).toThrow(/GENIO_VERIFIED_CANDIDATE_EVIDENCE_HASH is required/u);
    expect(() => railwayReleasePhaseConfiguration(baseEnvironment({
      GENIO_VERIFIED_CANDIDATE_EVIDENCE_HASH: "verified-but-not-a-hash",
    }))).toThrow(/must be a SHA-256 digest/u);
    expect(
      railwayReleasePhaseConfiguration(stagingEnvironment())
        .verifiedCandidateEvidenceHash,
    ).toBeNull();
  });

  test("deploys one immutable bridge artifact to API and both worker lanes with no migration", async () => {
    const project = await railwayProject(baseEnvironment());
    expect(project.environments).toEqual(["staging", "production"]);
    const services = project.resources.filter((resource) => resource.type === "service");
    expect(services.map(({ name }) => name).sort()).toEqual([
      "needle-api",
      "needle-deep-worker",
      "needle-worker",
    ]);
    for (const current of services) {
      expect(current.source).toMatchObject({
        image: releaseImage,
        autoUpdates: { type: "disabled" },
      });
      expect(current.variables).toMatchObject({
        APP_VERSION: { type: "literal", value: releaseVersion },
        SOURCE_COMMIT_SHA: { type: "literal", value: releaseRevision },
        RELEASE_ENVIRONMENT: { type: "literal", value: "production" },
        RELEASE_DEPLOYMENT_PHASE: { type: "literal", value: "bridge" },
        RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: { type: "literal", value: "16" },
        RELEASE_VERIFIED_CANDIDATE_EVIDENCE_HASH: {
          type: "literal",
          value: verifiedCandidateEvidenceHash,
        },
      });
    }
    expect(service(project, "needle-api").deploy?.preDeployCommand).toBeUndefined();
    for (const current of [service(project, "needle-api"), service(project, "needle-worker")]) {
      expect(current.variables!.PIPELINE_V3_ASSIGNMENT_ENABLED).toEqual({ type: "preserve" });
      expect(current.variables!.GUIDANCE_CONTRACT_V3_ENABLED).toEqual({ type: "preserve" });
      expect(current.variables!.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION).toEqual({ type: "preserve" });
    }
  });

  test("runs the expand-only migration only after bridge convergence evidence exists", async () => {
    await expect(railwayProject(baseEnvironment({
      GENIO_RELEASE_PHASE: "expand",
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
    }))).rejects.toThrow(/GENIO_BRIDGE_CONVERGENCE_EVIDENCE_HASH is required/u);

    const project = await railwayProject(baseEnvironment({
      GENIO_RELEASE_PHASE: "expand",
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
      GENIO_BRIDGE_CONVERGENCE_EVIDENCE_HASH: hash("c"),
      GENIO_BRIDGE_RELEASE_IMAGE: releaseImage,
    }));
    expect(service(project, "needle-api").deploy?.preDeployCommand).toEqual([
      "pnpm run db:migrate",
    ]);
    expect(service(project, "needle-api").variables).toMatchObject({
      RELEASE_DEPLOYMENT_PHASE: { type: "literal", value: "expand" },
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: { type: "literal", value: "18" },
      RELEASE_BRIDGE_CONVERGENCE_EVIDENCE_HASH: {
        type: "literal",
        value: hash("c"),
      },
    });
    await expect(railwayProject(baseEnvironment({
      GENIO_RELEASE_PHASE: "expand",
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
      GENIO_BRIDGE_CONVERGENCE_EVIDENCE_HASH: hash("c"),
      GENIO_BRIDGE_RELEASE_IMAGE:
        `ghcr.io/example/genio@sha256:${"f".repeat(64)}`,
    }))).rejects.toThrow(/exact bridge image digest/u);
    await expect(railwayProject(baseEnvironment({
      GENIO_RELEASE_PHASE: "expand",
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
      GENIO_BRIDGE_CONVERGENCE_EVIDENCE_HASH: hash("c"),
      GENIO_BRIDGE_RELEASE_IMAGE: releaseImage,
      GENIO_BRIDGE_VERIFIED_CANDIDATE_EVIDENCE_HASH: hash("8"),
    }))).rejects.toThrow(/exact bridge verified candidate evidence hash/u);
    await expect(railwayProject(baseEnvironment({
      GENIO_RELEASE_PHASE: "expand",
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
      GENIO_BRIDGE_CONVERGENCE_EVIDENCE_HASH: hash("c"),
      GENIO_BRIDGE_RELEASE_IMAGE: releaseImage,
      GENIO_BRIDGE_VERIFIED_CANDIDATE_EVIDENCE_HASH: undefined,
    }))).rejects.toThrow(
      /GENIO_BRIDGE_VERIFIED_CANDIDATE_EVIDENCE_HASH is required/u,
    );
  });

  test("activation has no migration and requires both bridge and schema-18 evidence", async () => {
    await expect(railwayProject(baseEnvironment({
      GENIO_RELEASE_PHASE: "activate",
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
      GENIO_BRIDGE_CONVERGENCE_EVIDENCE_HASH: hash("c"),
      GENIO_BRIDGE_RELEASE_IMAGE: releaseImage,
    }))).rejects.toThrow(/GENIO_EXPAND_CONVERGENCE_EVIDENCE_HASH is required/u);

    const project = await railwayProject(baseEnvironment({
      GENIO_RELEASE_PHASE: "activate",
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
      GENIO_BRIDGE_CONVERGENCE_EVIDENCE_HASH: hash("c"),
      GENIO_EXPAND_CONVERGENCE_EVIDENCE_HASH: hash("d"),
      GENIO_BRIDGE_RELEASE_IMAGE: releaseImage,
      GENIO_EXPAND_RELEASE_IMAGE: releaseImage,
    }));
    expect(service(project, "needle-api").deploy?.preDeployCommand).toBeUndefined();
    expect(service(project, "needle-api").variables).toMatchObject({
      RELEASE_DEPLOYMENT_PHASE: { type: "literal", value: "activate" },
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: { type: "literal", value: "18" },
      RELEASE_BRIDGE_CONVERGENCE_EVIDENCE_HASH: {
        type: "literal",
        value: hash("c"),
      },
      RELEASE_EXPAND_CONVERGENCE_EVIDENCE_HASH: {
        type: "literal",
        value: hash("d"),
      },
    });
    await expect(railwayProject(baseEnvironment({
      GENIO_RELEASE_PHASE: "activate",
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "17",
      GENIO_BRIDGE_CONVERGENCE_EVIDENCE_HASH: hash("c"),
      GENIO_EXPAND_CONVERGENCE_EVIDENCE_HASH: hash("d"),
      GENIO_BRIDGE_RELEASE_IMAGE: releaseImage,
      GENIO_EXPAND_RELEASE_IMAGE: releaseImage,
    }))).rejects.toThrow(/requires GENIO_EXPECTED_DATABASE_SCHEMA_VERSION=18/u);
    await expect(railwayProject(baseEnvironment({
      GENIO_RELEASE_PHASE: "activate",
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
      GENIO_BRIDGE_CONVERGENCE_EVIDENCE_HASH: hash("c"),
      GENIO_EXPAND_CONVERGENCE_EVIDENCE_HASH: hash("d"),
      GENIO_BRIDGE_RELEASE_IMAGE: releaseImage,
      GENIO_EXPAND_RELEASE_IMAGE: releaseImage,
      GENIO_EXPAND_VERIFIED_CANDIDATE_EVIDENCE_HASH: hash("8"),
    }))).rejects.toThrow(/exact expand verified candidate evidence hash/u);
    await expect(railwayProject(baseEnvironment({
      GENIO_RELEASE_PHASE: "activate",
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
      GENIO_BRIDGE_CONVERGENCE_EVIDENCE_HASH: hash("c"),
      GENIO_EXPAND_CONVERGENCE_EVIDENCE_HASH: hash("d"),
      GENIO_BRIDGE_RELEASE_IMAGE: releaseImage,
      GENIO_EXPAND_RELEASE_IMAGE: releaseImage,
      GENIO_EXPAND_VERIFIED_CANDIDATE_EVIDENCE_HASH: undefined,
    }))).rejects.toThrow(
      /GENIO_EXPAND_VERIFIED_CANDIDATE_EVIDENCE_HASH is required/u,
    );
  });

  test("staging is capped and bound to separate provider, Apple, account, and MusicKit controls", async () => {
    const project = await railwayProject(stagingEnvironment());
    const api = service(project, "needle-api");
    const worker = service(project, "needle-worker");
    expect(api.variables).toMatchObject({
      RELEASE_ENVIRONMENT: { type: "literal", value: "staging" },
      APP_ORIGIN: { type: "literal", value: "https://staging-9enio.example" },
      APP_MONTHLY_COST_LIMIT_USD: { type: "literal", value: "7.5" },
      QA_STAGING_CONTROL_HASH: {
        type: "literal",
        value: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    expect(worker.variables!.APP_MONTHLY_COST_LIMIT_USD).toEqual({
      type: "literal",
      value: "7.5",
    });
    expect(api.variables).not.toHaveProperty(
      "RELEASE_VERIFIED_CANDIDATE_EVIDENCE_HASH",
    );

    expect(() => railwayReleasePhaseConfiguration(stagingEnvironment({
      GENIO_STAGING_MONTHLY_COST_LIMIT_USD: String(MAXIMUM_STAGING_MONTHLY_COST_USD + 0.01),
    }))).toThrow(/no more than/u);
    expect(() => railwayReleasePhaseConfiguration(stagingEnvironment({
      GENIO_PRODUCTION_PROVIDER_SECRET_VERSION_HASH: hash("1"),
    }))).toThrow(/provider secret versions must be different/u);
    expect(() => railwayReleasePhaseConfiguration(stagingEnvironment({
      GENIO_PRODUCTION_APPLE_SECRET_VERSION_HASH: hash("3"),
    }))).toThrow(/Apple secret versions must be different/u);
    expect(() => railwayReleasePhaseConfiguration(stagingEnvironment({
      GENIO_STAGING_MUSICKIT_ORIGIN: "https://9enio.com",
    }))).toThrow(/dedicated non-production HTTPS origin/u);
  });

  test("rejects planning one environment with another environment's controls", async () => {
    vi.unstubAllEnvs();
    for (const [name, value] of Object.entries(baseEnvironment())) {
      if (value !== undefined) vi.stubEnv(name, value);
    }
    vi.resetModules();
    const definition = (await import("../.railway/railway.ts")).default as unknown as (
      context: Record<string, unknown>,
    ) => unknown;
    expect(() => definition({
      environment: "staging",
      environmentName: "staging",
      isEnvironment: () => false,
      randomString: () => "test",
      shared: {},
    })).toThrow(/does not match the selected Railway environment/u);
  });

  test("rollback after schema-18 writes means the same bridge artifact, never a schema-16 binary", async () => {
    expect(DATABASE_SCHEMA_SUPPORT).toEqual({
      minimum: "13",
      maximum: "18",
      preferred: "18",
    });
    expect(isDatabaseSchemaVersionCompatible("18", DATABASE_SCHEMA_SUPPORT)).toBe(true);
    const project = await railwayProject(baseEnvironment({
      GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
    }));
    expect(service(project, "needle-api").deploy?.preDeployCommand).toBeUndefined();
    expect(runtimeReleaseDeploymentPhase({
      RELEASE_DEPLOYMENT_PHASE: "bridge",
    })).toBe("bridge");
    expect(canonicalContractActivationReady({
      environment: {
        RELEASE_DEPLOYMENT_PHASE: "bridge",
        RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
        GUIDANCE_CONTRACT_V3_ENABLED: "true",
      },
      observedDatabaseSchemaVersion: "18",
    })).toBe(false);
  });
});
