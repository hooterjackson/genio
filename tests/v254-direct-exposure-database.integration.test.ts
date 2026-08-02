import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  V254_DIRECT_EXPOSURE_ACTIVE_SETTING,
  applyV254DirectExposureDatabaseV1,
  type V254DirectExposureDatabaseClient,
} from "../scripts/apply-v254-direct-exposure.ts";
import {
  nativeV254PublicEditorialActivationVariablesV1,
  nativeV254RouteSwitchVariablesV1,
} from "../scripts/promote-native-schema20-release.ts";
import {
  createV254DirectExposureAssignmentV1,
  v254DirectExposureRuntimeDatabaseAuthorityV1,
} from "../server/public-rollout-assignment.ts";
import { semanticExecutionConfigurationHash } from "../server/runtime-release.ts";
import { signedArtifactSha256 } from "../shared/signed-artifact.ts";
import {
  PUBLIC_ROLLOUT_TARGET_CONFIGURATION_KEYS,
} from "../shared/public-rollout-evidence.ts";
import {
  createV254DirectExposureRollbackPlanV1,
  createV254DirectExposureRuntimeTransitionV1,
  validateV254DirectExposureConfigurationV1,
  type VerifiedV254DirectExposureV1,
} from "../shared/v254-direct-exposure-authority.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseDescribe = databaseUrl ? describe.sequential : describe.skip;
const migrationDirectory = new URL("../postgres-migrations/", import.meta.url);
const migrationFiles = readdirSync(migrationDirectory)
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort();

const sourceRevision = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const candidate = {
  tag: "v2.5.4-rc.1",
  version: "2.5.4",
  sourceRevision,
  imageReference: `ghcr.io/hooterjackson/genio@${imageDigest}`,
  imageDigest,
} as const;

function sha(character: string): string {
  return character.repeat(64);
}

function directConfiguration(
  variables: Readonly<Record<string, string>>,
) {
  const complete: Readonly<Record<string, string>> = {
    RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
    RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
    RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
    RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION: "1",
    ...variables,
  };
  return validateV254DirectExposureConfigurationV1(Object.fromEntries(
    PUBLIC_ROLLOUT_TARGET_CONFIGURATION_KEYS.map((key) => [
      key,
      complete[key],
    ]),
  ));
}

function directFixture(): VerifiedV254DirectExposureV1 {
  const currentConfiguration = directConfiguration(
    nativeV254RouteSwitchVariablesV1(),
  );
  const targetConfiguration = directConfiguration(
    nativeV254PublicEditorialActivationVariablesV1(),
  );
  const preExposureSemanticConfigurationHash =
    semanticExecutionConfigurationHash({ ...currentConfiguration });
  const postExposureSemanticConfigurationHash =
    semanticExecutionConfigurationHash({ ...targetConfiguration });
  const service = (
    serviceId: string,
    serviceName: "needle-worker" | "needle-deep-worker" | "needle-api",
    deploymentId: string,
  ) => ({
    serviceId,
    serviceName,
    preExposureDeploymentId: deploymentId,
    targetImageReference: candidate.imageReference,
    targetImageDigest: candidate.imageDigest,
    targetSourceRevision: candidate.sourceRevision,
    preExposureSemanticConfigurationHash,
    postExposureSemanticConfigurationHash,
    rollbackDeploymentId: deploymentId,
    rollbackImageReference: candidate.imageReference,
    rollbackImageDigest: candidate.imageDigest,
    rollbackSourceRevision: candidate.sourceRevision,
    rollbackSemanticConfigurationHash: preExposureSemanticConfigurationHash,
  });
  const runtimeTransition = createV254DirectExposureRuntimeTransitionV1({
    candidate,
    preExposureSemanticConfigurationHash,
    postExposureSemanticConfigurationHash,
    services: {
      interactive: service(
        "11111111-1111-4111-8111-111111111111",
        "needle-worker",
        "44444444-4444-4444-8444-444444444444",
      ),
      deep: service(
        "22222222-2222-4222-8222-222222222222",
        "needle-deep-worker",
        "55555555-5555-4555-8555-555555555555",
      ),
      api: service(
        "33333333-3333-4333-8333-333333333333",
        "needle-api",
        "66666666-6666-4666-8666-666666666666",
      ),
    },
  });
  const rollbackPlan = createV254DirectExposureRollbackPlanV1({
    candidate,
    targetConfiguration: currentConfiguration,
  });
  return {
    authorityPayloadHash: sha("1"),
    rollbackWarrantPayloadHash: sha("2"),
    candidate,
    currentConfiguration,
    currentConfigurationHash: signedArtifactSha256(currentConfiguration),
    targetConfiguration,
    targetConfigurationHash: signedArtifactSha256(targetConfiguration),
    rollbackPlan,
    rollbackPlanHash: signedArtifactSha256(rollbackPlan),
    runtimeTransition,
    preconditionsHash: sha("3"),
    ownerAppleProofHash: sha("4"),
    cleanNonOwnerProofHash: sha("5"),
    routeReceiptHash: sha("6"),
    exposureClass: "fully_exposed_unproven",
    organicReliabilityProven: false,
  };
}

databaseDescribe("v2.5.4 direct exposure database transition", () => {
  const schemaName = `genio_v254_direct_${randomUUID().replaceAll("-", "")}`;
  const verified = directFixture();
  const authorityArtifact = { kind: "signed-direct-authority", version: 1 };
  const warrantArtifact = { kind: "signed-rollback-warrant", version: 1 };
  const authorityArtifactHash = signedArtifactSha256(authorityArtifact);
  const warrantArtifactHash = signedArtifactSha256(warrantArtifact);
  let adminPool: Pool | undefined;
  let client: Client | undefined;
  let databaseClient: V254DirectExposureDatabaseClient;

  beforeAll(async () => {
    adminPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: "genio-v254-direct-exposure-admin",
    });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    const migrationPool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 2,
      application_name: "genio-v254-direct-exposure-migrations",
    });
    try {
      for (const file of migrationFiles) {
        await migrationPool.query(readFileSync(
          new URL(`../postgres-migrations/${file}`, import.meta.url),
          "utf8",
        ));
      }
    } finally {
      await migrationPool.end();
    }
    client = new Client({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      application_name: "genio-v254-direct-exposure",
    });
    await client.connect();
    await client.query(
      `INSERT INTO settings(key,value,updated_at)
       VALUES('schema_version','20',now()),
             ('proof_architecture_authority','native',now())
       ON CONFLICT(key) DO UPDATE
       SET value=excluded.value,updated_at=excluded.updated_at`,
    );
    databaseClient = {
      async query(text, values) {
        const result = await client!.query(text, [...(values ?? [])]);
        return { rows: result.rows, rowCount: result.rowCount };
      },
    };
  }, 60_000);

  afterAll(async () => {
    await client?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  }, 30_000);

  async function apply(operation: "plan" | "arm" | "activate" | "rollback") {
    return applyV254DirectExposureDatabaseV1({
      client: databaseClient,
      operation,
      verified,
      authorityArtifactHash,
      warrantArtifactHash,
      authorityArtifact,
      warrantArtifact,
      now: new Date("2026-08-02T20:00:00.000Z"),
    });
  }

  async function persistedAuthority(): Promise<unknown> {
    const result = await client!.query(
      "SELECT value FROM settings WHERE key=$1",
      [V254_DIRECT_EXPOSURE_ACTIVE_SETTING],
    );
    return JSON.parse(String(result.rows[0]?.value ?? "null"));
  }

  async function durableState() {
    const [settings, killSwitch] = await Promise.all([
      client!.query(
        `SELECT key,value FROM settings
         WHERE key=ANY($1::text[])
         ORDER BY key`,
        [[
          "pipeline_v3_public_assignment_paused",
          "pipeline_v3_public_assignment_paused:editorial_influence",
        ]],
      ),
      client!.query(
        `SELECT disabled FROM pipeline_cohort_kill_switches
         WHERE route='corpus_first_v3'
           AND intent_group='editorial_influence'`,
      ),
    ]);
    return {
      settings: Object.fromEntries(
        settings.rows.map((row) => [String(row.key), String(row.value)]),
      ),
      disabled: killSwitch.rows[0]?.disabled,
    };
  }

  test("arms paused, activates last, assigns through signed authority, and rolls back terminally", async () => {
    expect(await apply("plan")).toMatchObject({ applied: false });
    expect(await persistedAuthority()).toBeNull();

    expect(await apply("arm")).toMatchObject({
      applied: true,
      state: "armed",
      terminal: false,
    });
    expect(await durableState()).toEqual({
      settings: {
        pipeline_v3_public_assignment_paused: "true",
        "pipeline_v3_public_assignment_paused:editorial_influence": "true",
      },
      disabled: true,
    });

    expect(await apply("activate")).toMatchObject({
      applied: true,
      state: "active",
      terminal: false,
    });
    expect(await apply("activate")).toMatchObject({
      applied: false,
      state: "active",
    });
    expect(await durableState()).toEqual({
      settings: {
        pipeline_v3_public_assignment_paused: "false",
        "pipeline_v3_public_assignment_paused:editorial_influence": "false",
      },
      disabled: false,
    });

    const authority = { active: await persistedAuthority() };
    const environment: NodeJS.ProcessEnv = {
      ...verified.targetConfiguration,
      RELEASE_ENVIRONMENT: "production",
      RELEASE_DEPLOYMENT_PHASE: "activate",
      RELEASE_V254_DIRECT_EXPOSURE_PRECONDITIONS_HASH:
        verified.preconditionsHash,
      RELEASE_V254_DIRECT_EXPOSURE_ROLLBACK_PLAN_HASH:
        verified.rollbackPlanHash,
      RELEASE_V254_DIRECT_EXPOSURE_STAGE:
        "editorial_influence:0->100:fully_exposed_unproven",
      RELEASE_V254_DIRECT_EXPOSURE_TARGET_CONFIGURATION_HASH:
        verified.targetConfigurationHash,
    };
    expect(v254DirectExposureRuntimeDatabaseAuthorityV1({
      environment,
      databaseAuthority: authority,
    })).toMatchObject({ active: true, organicReliabilityProven: false });
    expect(createV254DirectExposureAssignmentV1({
      prompt: "Infuential irish music",
      requestedTrackCount: 25,
      stickyKey: "direct-db-clean-non-owner",
      environment,
      databaseAuthority: authority,
    })).toMatchObject({
      assigned: true,
      intentGroup: "editorial_influence",
      percentage: 100,
    });

    expect(await apply("rollback")).toMatchObject({
      applied: true,
      state: "rolled_back",
      terminal: true,
    });
    expect(await durableState()).toEqual({
      settings: {
        pipeline_v3_public_assignment_paused: "true",
        "pipeline_v3_public_assignment_paused:editorial_influence": "true",
      },
      disabled: true,
    });
    await expect(apply("arm")).rejects.toThrow(
      /rolled back and cannot be re-armed/u,
    );
  }, 30_000);
});
