import { describe, expect, test } from "vitest";
import {
  ACTIVATION_COHORT_INVENTORY_QUERY_HASH_V1,
  ACTIVATION_COHORT_INVENTORY_STATEMENTS_V1,
} from "../shared/promotion-phase-evidence.ts";
import {
  REQUIRED_ACTIVATION_EXECUTION_CONTROLS,
} from "../shared/release-activation-contract.ts";
import { signedArtifactSha256 } from "../shared/signed-artifact.ts";
import {
  buildPromotionPhasePayload,
  collectActivationPreflight,
  parsePromotionPhaseEvidenceProducerArgs,
  type ActivationPreflightDatabaseClient,
  type PromotionPhaseEvidenceProducerArgs,
} from "../scripts/promotion-phase-evidence-producer.ts";
import type {
  ReleaseMigrationObservation,
  ReleaseMigrationPhaseEvidence,
} from "../scripts/verify-release-migration-phase.ts";

const revision = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const apiHash = "1".repeat(64);
const interactiveHash = "2".repeat(64);
const deepHash = "3".repeat(64);
const databaseIdentityHash = "4".repeat(64);

function command(phase: "bridge" | "expand"): string[] {
  return [
    "--confirm-production-phase-evidence",
    "--origin", "https://api.9enio.com",
    "--phase", phase,
    "--expected-schema", phase === "expand" ? "19" : "16",
    "--expected-capability", phase === "expand" ? "2" : "none",
    "--expected-manifest-canary-guards", phase === "expand" ? "1" : "none",
    "--expected-canonical-hardening", phase === "expand" ? "1" : "none",
    "--candidate-tag", "v2.4.0-rc.2",
    "--candidate-version", "2.4.0",
    "--candidate-revision", revision,
    "--image-digest", imageDigest,
    "--candidate-evidence", "/tmp/candidate.json",
    "--candidate-verification-key", "/tmp/candidate-public.pem",
    "--samples", "2",
    "--interval-seconds", "30",
    "--output", "/tmp/phase.json",
    "--producer-signing-key", "/tmp/producer-private.pem",
    "--producer-key-id", "production-phase-v1",
  ];
}

function rolloutEnvironment(): NodeJS.ProcessEnv {
  return {
    PIPELINE_V2_OWNER_CANARY: "false",
    PIPELINE_V2_CURATED_PERCENT: "100",
    PIPELINE_V2_SIMILARITY_PERCENT: "0",
    PIPELINE_V2_FACTUAL_OWNER_CANARY: "false",
    PIPELINE_V2_FACTUAL_PERCENT: "0",
    PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
    PIPELINE_V3_OWNER_CANARY: "true",
    PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_OWNER_CANARY_GROUPS: "genre_scene",
    PIPELINE_V3_OWNER_CANARY_MAX_TRACKS: "50",
    PIPELINE_V3_GENRE_SCENE_PERCENT: "0",
    PIPELINE_V3_MOOD_ACTIVITY_PERCENT: "0",
    PIPELINE_V3_SIMILARITY_PERCENT: "0",
    PIPELINE_V3_ARTIST_CATALOGUE_PERCENT: "0",
    PIPELINE_V3_FIXED_CONTAINER_PERCENT: "0",
    PIPELINE_V3_FACTUAL_PERCENT: "0",
    PIPELINE_V3_EXHAUSTIVE_PERCENT: "0",
    GUIDANCE_CONTRACT_V3_ENABLED: "false",
    GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
    GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "false",
  };
}

function observation(
  observedAt: string,
  heartbeatAt: string,
): ReleaseMigrationObservation {
  return {
    observedAt,
    apiVersion: "2.4.0",
    apiRevision: revision,
    apiConfigurationHash: apiHash,
    deploymentPhase: "expand",
    expectedDatabaseSchemaVersion: "19",
    canonicalActivationConfigured: false,
    runtimeSchemaMinimum: "13",
    runtimeSchemaMaximum: "19",
    runtimeWorkerProtocol: "playlist-pipeline-v11",
    runtimeBriefContractVersion: "2",
    runtimeQueryPlanSchemaVersion: "3",
    readyHttpStatus: 200,
    ready: true,
    databaseSchemaVersion: "19",
    databaseCapabilityVersion: "2",
    releaseManifestCanaryGuardsVersion: "1",
    canonicalExecutionHardeningVersion: "1",
    systemHttpStatus: 200,
    systemOk: true,
    activationReady: true,
    systemDatabaseSchemaVersion: "19",
    workerLanes: {
      interactive: {
        status: "healthy",
        protocolVersion: "playlist-pipeline-v11",
        compatibleCapacity: 1,
        eligibleWorkerCount: 1,
        eligibleRevisions: [revision],
        eligibleConfigurationHashes: [interactiveHash],
        lastSeenAt: heartbeatAt,
      },
      deep: {
        status: "healthy",
        protocolVersion: "playlist-pipeline-v11",
        compatibleCapacity: 1,
        eligibleWorkerCount: 1,
        eligibleRevisions: [revision],
        eligibleConfigurationHashes: [deepHash],
        lastSeenAt: heartbeatAt,
      },
    },
  };
}

describe("production promotion phase evidence producer", () => {
  test("requires an explicit production origin and pinned database for expand", () => {
    expect(parsePromotionPhaseEvidenceProducerArgs(command("bridge"), {
      RELEASE_PRODUCTION_ORIGIN: "https://api.9enio.com",
    })).toMatchObject({
      phase: "bridge",
      expectedDatabaseCapabilityVersion: null,
      productionDatabaseUrl: null,
      expectedDatabaseIdentityHash: null,
    });
    expect(() => parsePromotionPhaseEvidenceProducerArgs(command("expand"), {
      RELEASE_PRODUCTION_ORIGIN: "https://api.9enio.com",
    })).toThrow(/RELEASE_PRODUCTION_DATABASE_URL/u);
    expect(parsePromotionPhaseEvidenceProducerArgs(command("expand"), {
      RELEASE_PRODUCTION_ORIGIN: "https://api.9enio.com",
      RELEASE_PRODUCTION_DATABASE_URL: "postgresql://producer@example/db",
      GENIO_PRODUCTION_DATABASE_IDENTITY_HASH: databaseIdentityHash,
    })).toMatchObject({
      phase: "expand",
      expectedSchemaVersion: "19",
      expectedDatabaseCapabilityVersion: "2",
      expectedReleaseManifestCanaryGuardsVersion: "1",
      expectedCanonicalExecutionHardeningVersion: "1",
      expectedDatabaseIdentityHash: databaseIdentityHash,
    });
    const zeroInterval = command("bridge");
    zeroInterval[zeroInterval.indexOf("--interval-seconds") + 1] = "0";
    expect(() => parsePromotionPhaseEvidenceProducerArgs(zeroInterval, {
      RELEASE_PRODUCTION_ORIGIN: "https://api.9enio.com",
    })).toThrow(/30 through 120/u);
  });

  test("collects cohort inventory from one fixed repeatable-read snapshot", async () => {
    const queries: string[] = [];
    const rows = [{
      cohort_key: "catalog-first-global-pre-activation",
      route: "catalog_first_v2",
      intent_group: null,
      disabled: true,
      reason_code: "candidate_activation_preflight",
      changed_at: "2026-07-24T12:00:00.000Z",
    }];
    const client: ActivationPreflightDatabaseClient = {
      async query(text) {
        queries.push(text);
        if (text.includes("pg_control_system")) {
          return {
            command: "SELECT",
            rowCount: 1,
            oid: 0,
            fields: [],
            rows: [{
              database_name: "railway",
              system_identifier: "7612345678901234567",
              snapshot_id: "00000003-0000001B-1",
              captured_at: "2026-07-24T12:00:05.000Z",
            }],
          };
        }
        if (text === ACTIVATION_COHORT_INVENTORY_STATEMENTS_V1[1]) {
          return {
            command: "SELECT",
            rowCount: 1,
            oid: 0,
            fields: [],
            rows,
          };
        }
        return { command: "OK", rowCount: null, oid: 0, fields: [], rows: [] };
      },
    };
    const evidence = await collectActivationPreflight({
      client,
      environment: rolloutEnvironment(),
    });
    expect(queries).toEqual([
      "BEGIN",
      ACTIVATION_COHORT_INVENTORY_STATEMENTS_V1[0],
      expect.stringContaining("pg_export_snapshot()"),
      ACTIVATION_COHORT_INVENTORY_STATEMENTS_V1[1],
      "COMMIT",
    ]);
    expect(evidence).toMatchObject({
      capturedAt: "2026-07-24T12:00:05.000Z",
      cohortQueryHash: ACTIVATION_COHORT_INVENTORY_QUERY_HASH_V1,
      cohortInventoryHash: signedArtifactSha256([{
        cohortKey: "catalog-first-global-pre-activation",
        route: "catalog_first_v2",
        intentGroup: null,
        disabled: true,
        reasonCode: "candidate_activation_preflight",
        changedAt: "2026-07-24T12:00:00.000Z",
      }]),
      inventoryComplete: true,
      ownerCandidateRoute: {
        route: "corpus_first_v3",
        groups: ["genre_scene"],
        maximumTrackCount: 50,
      },
      activationConfiguration: {
        ...REQUIRED_ACTIVATION_EXECUTION_CONTROLS,
      },
    });
  });

  test("derives runtime and convergence bindings from observations, not caller booleans", () => {
    const args: PromotionPhaseEvidenceProducerArgs = {
      origin: "https://api.9enio.com",
      phase: "expand",
      expectedSchemaVersion: "19",
      expectedDatabaseCapabilityVersion: "2",
      expectedReleaseManifestCanaryGuardsVersion: "1",
      expectedCanonicalExecutionHardeningVersion: "1",
      candidate: {
        tag: "v2.4.0-rc.2",
        version: "2.4.0",
        sourceRevision: revision,
        imageDigest,
      },
      candidateEvidencePath: "/tmp/candidate.json",
      candidateVerificationKeyPath: "/tmp/candidate.pem",
      samples: 2,
      intervalMs: 30_000,
      outputPath: "/tmp/output.json",
      producerSigningKeyPath: "/tmp/producer.pem",
      producerKeyId: "phase-producer-v1",
      productionDatabaseUrl: "postgresql://producer@example/db",
      expectedDatabaseIdentityHash: databaseIdentityHash,
    };
    const observations = [
      observation("2026-07-24T12:00:00.000Z", "2026-07-24T11:59:55.000Z"),
      observation("2026-07-24T12:00:30.000Z", "2026-07-24T12:00:25.000Z"),
    ];
    const migrationEvidence: ReleaseMigrationPhaseEvidence = {
      schemaVersion: "genio-release-migration-phase/v2",
      generatedAt: "2026-07-24T12:00:30.000Z",
      expiresAt: "2026-07-25T12:00:30.000Z",
      origin: args.origin,
      expected: {
        revision,
        version: "2.4.0",
        databaseSchemaVersion: "19",
        databaseCapabilityVersion: "2",
        releaseManifestCanaryGuardsVersion: "1",
        canonicalExecutionHardeningVersion: "1",
        phase: "expand",
        samples: 2,
        minimumObservationSpanMs: 30_000,
      },
      observationSpanMs: 30_000,
      passed: true,
      violations: [],
      observations,
      evidenceHash: "5".repeat(64),
    };
    const payload = buildPromotionPhasePayload({
      args,
      candidateEvidenceHash: "6".repeat(64),
      migrationEvidence,
      activationPreflight: {
        capturedAt: "2026-07-24T12:00:30.000Z",
        databaseIdentityHash,
        databaseSnapshotId: "00000003-0000001B-1",
        cohortQueryHash: ACTIVATION_COHORT_INVENTORY_QUERY_HASH_V1,
        cohortInventoryHash: "7".repeat(64),
        inventoryComplete: true,
        affectedCohorts: [],
        rolloutFlags: {},
        ownerCandidateRoute: {
          route: "corpus_first_v3",
          groups: ["genre_scene"],
          maximumTrackCount: 50,
        },
        activationConfiguration: {
          ...REQUIRED_ACTIVATION_EXECUTION_CONTROLS,
        },
      },
      generatedAt: "2026-07-24T12:00:35.000Z",
    });
    expect(payload.runtime).toMatchObject({
      configurationHash: signedArtifactSha256({
        apiHash,
        interactiveWorkerHash: interactiveHash,
        deepWorkerHash: deepHash,
      }),
      apiConfigurationHash: apiHash,
      interactiveWorkerConfigurationHash: interactiveHash,
      deepWorkerConfigurationHash: deepHash,
      databaseCapabilityVersion: "2",
      releaseManifestCanaryGuardsVersion: "1",
      canonicalExecutionHardeningVersion: "1",
    });
    expect(payload.convergence).toMatchObject({
      passed: true,
      sampleCount: 2,
      freshWorkerHeartbeatsPerLane: 2,
      eligibleOldWorkerCount: 0,
    });
  });
});
