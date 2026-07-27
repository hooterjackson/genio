import { createHash } from "node:crypto";
import {
  afterEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  railwayStagingBootstrapConfiguration,
} from "../.railway/staging-bootstrap.ts";
import {
  railwayReleasePhaseConfiguration,
  releasePhasePreDeployCommand,
} from "../.railway/release-phase.ts";
import {
  releaseDatabaseReadinessReady,
  releaseExecutionConfigured,
  stagingBootstrapConfigured,
} from "../server/release-deployment-phase.ts";

const releaseImage = `ghcr.io/example/genio@sha256:${"a".repeat(64)}`;
const releaseRevision = "b".repeat(40);
const stagingProjectId = "11111111-1111-4111-8111-111111111111";
const stagingEnvironmentId = "22222222-2222-4222-8222-222222222222";
const bootstrapGatewaySecret = "g".repeat(48);
const bootstrapCapabilityPepper = "p".repeat(48);

function bootstrapEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    GENIO_RELEASE_IMAGE: releaseImage,
    GENIO_RELEASE_REVISION: releaseRevision,
    GENIO_RELEASE_VERSION: "2.4.0",
    GENIO_RELEASE_ENVIRONMENT: "staging",
    GENIO_RELEASE_PHASE: "bootstrap",
    GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
    GENIO_RELEASE_SECRET_VERSIONS_HASH: "c".repeat(64),
    GENIO_STAGING_BOOTSTRAP_FRESH_EMPTY_DATABASE_CONFIRMED: "true",
    GENIO_STAGING_BOOTSTRAP_PROJECT_ID: stagingProjectId,
    GENIO_STAGING_BOOTSTRAP_ENVIRONMENT_ID: stagingEnvironmentId,
    GENIO_STAGING_BOOTSTRAP_GATEWAY_KEY_ID: "qa-bootstrap-v1",
    GENIO_STAGING_BOOTSTRAP_GATEWAY_HMAC_SECRET: bootstrapGatewaySecret,
    GENIO_STAGING_BOOTSTRAP_PRODUCTION_GATEWAY_HMAC_SHA256:
      createHash("sha256").update("production-gateway-secret").digest("hex"),
    GENIO_STAGING_BOOTSTRAP_CAPABILITY_PEPPER: bootstrapCapabilityPepper,
    GENIO_STAGING_BOOTSTRAP_CAPABILITY_PEPPER_VERSION:
      "qa-bootstrap-capability-v1",
    GENIO_STAGING_BOOTSTRAP_PRODUCTION_CAPABILITY_PEPPER_SHA256:
      createHash("sha256").update("production-capability-pepper").digest("hex"),
    ...overrides,
  };
}

type RailwayService = {
  type: string;
  name: string;
  source?: { image?: string; autoUpdates?: { type?: string } };
  deploy?: {
    preDeployCommand?: string[];
    multiRegionConfig?: Record<string, { numReplicas?: number }>;
  };
  variables?: Record<string, unknown>;
};

async function railwayProject(
  environment: NodeJS.ProcessEnv,
  contextOverrides: Record<string, unknown> = {},
) {
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
  return definition({
    projectId: stagingProjectId,
    projectName: "needle",
    environmentId: stagingEnvironmentId,
    environment: environment.GENIO_RELEASE_ENVIRONMENT,
    environmentName: environment.GENIO_RELEASE_ENVIRONMENT,
    isEnvironment: (name: string) =>
      name === environment.GENIO_RELEASE_ENVIRONMENT,
    randomString: () => "test",
    shared: {},
    ...contextOverrides,
  });
}

function service(
  project: Awaited<ReturnType<typeof railwayProject>>,
  name: string,
): RailwayService {
  return project.resources.find(
    (resource) => resource.type === "service" && resource.name === name,
  )!;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("fresh staging bootstrap", () => {
  test("is staging-only and requires an explicit fresh/empty assertion", () => {
    const integrated = railwayReleasePhaseConfiguration(
      bootstrapEnvironment(),
    );
    expect(integrated).toMatchObject({
      environment: "staging",
      phase: "bootstrap",
      expectedDatabaseSchemaVersion: "18",
      expectedDatabaseCapabilityVersion: "2",
      freshEmptyDatabaseConfirmed: true,
      activationRollout: null,
      bootstrapRuntime: {
        expectedProjectId: stagingProjectId,
        expectedEnvironmentId: stagingEnvironmentId,
        gatewayKeyId: "qa-bootstrap-v1",
        capabilityPepperVersion: "qa-bootstrap-capability-v1",
      },
      staging: null,
    });
    expect(releasePhasePreDeployCommand(integrated)).toBe(
      "pnpm run db:migrate",
    );
    expect(() => railwayStagingBootstrapConfiguration(
      bootstrapEnvironment({
        GENIO_RELEASE_ENVIRONMENT: "production",
      }),
    )).toThrow(/accepted only for staging/u);
    expect(() => railwayStagingBootstrapConfiguration(
      bootstrapEnvironment({
        GENIO_STAGING_BOOTSTRAP_FRESH_EMPTY_DATABASE_CONFIRMED: undefined,
      }),
    )).toThrow(/fresh and empty/u);
    expect(() => railwayStagingBootstrapConfiguration(
      bootstrapEnvironment({
        GENIO_EXPECTED_DATABASE_SCHEMA_VERSION: "17",
      }),
    )).toThrow(/requires GENIO_EXPECTED_DATABASE_SCHEMA_VERSION=18/u);
    expect(() => railwayStagingBootstrapConfiguration(
      bootstrapEnvironment({
        GENIO_RELEASE_PHASE: "bridge",
      }),
    )).toThrow(/valid only during bootstrap/u);
  });

  test("requires explicit isolated QA identity and independent bootstrap secrets", async () => {
    for (const name of [
      "GENIO_STAGING_BOOTSTRAP_PROJECT_ID",
      "GENIO_STAGING_BOOTSTRAP_ENVIRONMENT_ID",
      "GENIO_STAGING_BOOTSTRAP_GATEWAY_KEY_ID",
      "GENIO_STAGING_BOOTSTRAP_GATEWAY_HMAC_SECRET",
      "GENIO_STAGING_BOOTSTRAP_PRODUCTION_GATEWAY_HMAC_SHA256",
      "GENIO_STAGING_BOOTSTRAP_CAPABILITY_PEPPER",
      "GENIO_STAGING_BOOTSTRAP_CAPABILITY_PEPPER_VERSION",
      "GENIO_STAGING_BOOTSTRAP_PRODUCTION_CAPABILITY_PEPPER_SHA256",
    ]) {
      expect(() => railwayStagingBootstrapConfiguration(
        bootstrapEnvironment({ [name]: undefined }),
      )).toThrow(new RegExp(name, "u"));
    }
    expect(() => railwayStagingBootstrapConfiguration(
      bootstrapEnvironment({
        GENIO_STAGING_BOOTSTRAP_CAPABILITY_PEPPER: bootstrapGatewaySecret,
      }),
    )).toThrow(/must be independent/u);
    expect(() => railwayStagingBootstrapConfiguration(
      bootstrapEnvironment({
        GENIO_STAGING_BOOTSTRAP_PRODUCTION_GATEWAY_HMAC_SHA256:
          createHash("sha256").update(bootstrapGatewaySecret).digest("hex"),
      }),
    )).toThrow(/gateway secret must not match production/u);
    expect(() => railwayStagingBootstrapConfiguration(
      bootstrapEnvironment({
        GENIO_STAGING_BOOTSTRAP_PRODUCTION_CAPABILITY_PEPPER_SHA256:
          createHash("sha256").update(bootstrapCapabilityPepper).digest("hex"),
      }),
    )).toThrow(/capability pepper must not match production/u);
    await expect(railwayProject(bootstrapEnvironment(), {
      environmentId: "33333333-3333-4333-8333-333333333333",
    })).rejects.toThrow(/explicitly approved Railway project and environment IDs/u);
    await expect(railwayProject(bootstrapEnvironment(), {
      projectId: "33333333-3333-4333-8333-333333333333",
    })).rejects.toThrow(/explicitly approved Railway project and environment IDs/u);
  });

  test("rejects inherited production data, credentials, and promotion evidence", () => {
    for (const name of [
      "DATABASE_URL",
      "OPENAI_API_KEY",
      "APPLE_MUSICKIT_PRIVATE_KEY_BASE64",
      "GATEWAY_HMAC_SECRET",
      "CAPABILITY_PEPPER",
      "GENIO_VERIFIED_CANDIDATE_EVIDENCE_FILE",
      "GENIO_PUBLIC_ROLLOUT_EVIDENCE_FILE",
      "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_FILE",
      "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_HASH",
      "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_VERIFICATION_KEY_FILE",
      "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_ID",
      "GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_SHA256",
    ]) {
      expect(() => railwayStagingBootstrapConfiguration(
        bootstrapEnvironment({ [name]: "must-not-cross-environments" }),
      )).toThrow(/forbids inherited data or credential inputs/u);
    }
  });

  test("migrates only the API while both immutable-image worker lanes stay at zero", async () => {
    const project = await railwayProject(bootstrapEnvironment());
    const api = service(project, "needle-api");
    const workers = [
      service(project, "needle-worker"),
      service(project, "needle-deep-worker"),
    ];
    for (const current of [api, ...workers]) {
      expect(current.source).toMatchObject({
        image: releaseImage,
        autoUpdates: { type: "disabled" },
      });
      expect(current.variables).toMatchObject({
        SOURCE_COMMIT_SHA: { type: "literal", value: releaseRevision },
        RELEASE_ENVIRONMENT: { type: "literal", value: "staging" },
        RELEASE_DEPLOYMENT_PHASE: { type: "literal", value: "bootstrap" },
        RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: {
          type: "literal",
          value: "18",
        },
        RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: {
          type: "literal",
          value: "2",
        },
        RELEASE_SECRET_VERSIONS_HASH: {
          type: "literal",
          value: "c".repeat(64),
        },
        RELEASE_STAGING_BOOTSTRAP_FRESH_EMPTY_DATABASE_CONFIRMED: {
          type: "literal",
          value: "true",
        },
        RELEASE_EXECUTION_ENABLED: { type: "literal", value: "false" },
      });
      expect(Object.values(current.variables ?? {}).some(
        (value) => (
          value
          && typeof value === "object"
          && (value as { type?: unknown }).type === "preserve"
        ),
      )).toBe(false);
    }
    expect(api.deploy?.preDeployCommand).toEqual(["pnpm run db:migrate"]);
    expect(api.deploy?.multiRegionConfig).toEqual({
      "us-west2": { numReplicas: 1 },
    });
    expect(api.variables).toMatchObject({
      REQUIRE_WORKER_HEARTBEAT: { type: "literal", value: "true" },
      PIPELINE_V3_ASSIGNMENT_ENABLED: { type: "literal", value: "false" },
      GUIDANCE_CONTRACT_V2_ENABLED: { type: "literal", value: "false" },
      GUIDANCE_CONTRACT_V3_ENABLED: { type: "literal", value: "false" },
      NODE_ENV: { type: "literal", value: "production" },
      GATEWAY_KEY_ID: { type: "literal", value: "qa-bootstrap-v1" },
      GATEWAY_HMAC_SECRET: {
        type: "literal",
        value: bootstrapGatewaySecret,
      },
      CAPABILITY_PEPPER: {
        type: "literal",
        value: bootstrapCapabilityPepper,
      },
      CAPABILITY_PEPPER_VERSION: {
        type: "literal",
        value: "qa-bootstrap-capability-v1",
      },
    });
    expect(api.variables).not.toHaveProperty("QA_STAGING_CONTROL_HASH");
    for (const worker of workers) {
      expect(worker.deploy?.multiRegionConfig).toEqual({
        "us-west2": { numReplicas: 0 },
      });
      expect(worker.variables).not.toHaveProperty("OPENAI_API_KEY");
      expect(worker.variables).not.toHaveProperty(
        "APPLE_MUSICKIT_PRIVATE_KEY_BASE64",
      );
      expect(worker.variables).not.toHaveProperty("GATEWAY_HMAC_SECRET");
      expect(worker.variables).not.toHaveProperty("CAPABILITY_PEPPER");
    }
  });

  test("blocks runtime execution and requires schema 18 plus both capability-2 markers for readiness", () => {
    const runtime = {
      RELEASE_ENVIRONMENT: "staging",
      RELEASE_DEPLOYMENT_PHASE: "bootstrap",
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
      RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
      RELEASE_STAGING_BOOTSTRAP_FRESH_EMPTY_DATABASE_CONFIRMED: "true",
    };
    expect(stagingBootstrapConfigured(runtime)).toBe(true);
    expect(releaseExecutionConfigured(runtime)).toBe(false);
    expect(releaseDatabaseReadinessReady({
      environment: runtime,
      observedDatabaseSchemaVersion: "18",
      observedDatabaseCapabilityVersion: "1",
      observedCanonicalExecutionHardeningVersion: "1",
    })).toBe(true);
    expect(releaseDatabaseReadinessReady({
      environment: runtime,
      observedDatabaseSchemaVersion: "17",
      observedDatabaseCapabilityVersion: "1",
      observedCanonicalExecutionHardeningVersion: "1",
    })).toBe(false);
    expect(releaseDatabaseReadinessReady({
      environment: runtime,
      observedDatabaseSchemaVersion: "18",
      observedDatabaseCapabilityVersion: null,
      observedCanonicalExecutionHardeningVersion: "1",
    })).toBe(false);
    expect(releaseDatabaseReadinessReady({
      environment: runtime,
      observedDatabaseSchemaVersion: "18",
      observedDatabaseCapabilityVersion: "1",
      observedCanonicalExecutionHardeningVersion: null,
    })).toBe(false);
    expect(stagingBootstrapConfigured({
      ...runtime,
      RELEASE_ENVIRONMENT: "production",
    })).toBe(false);
    expect(releaseExecutionConfigured({
      ...runtime,
      RELEASE_ENVIRONMENT: "production",
    })).toBe(false);
    expect(releaseDatabaseReadinessReady({
      environment: {
        ...runtime,
        RELEASE_ENVIRONMENT: "production",
      },
      observedDatabaseSchemaVersion: "18",
      observedDatabaseCapabilityVersion: "1",
      observedCanonicalExecutionHardeningVersion: "1",
    })).toBe(false);
  });
});
