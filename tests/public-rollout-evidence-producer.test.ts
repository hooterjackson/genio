import { describe, expect, test } from "vitest";
import {
  historicalPromotionVerificationTimeForRollback,
  parsePublicRolloutEvidenceProducerArgs,
  summarizePublicRolloutObservation,
} from "../scripts/public-rollout-evidence-producer.ts";
import type {
  ReleaseConvergenceObservation,
} from "../scripts/verify-release-convergence.ts";

const revision = "a".repeat(40);
const digest = "b".repeat(64);

function observation(): ReleaseConvergenceObservation {
  const lane = {
    status: "healthy",
    protocolVersion: "playlist-pipeline-v12",
    compatibleCapacity: 1,
    eligibleWorkerCount: 1,
    eligibleIdentityCount: 1,
    eligibleRevisions: [revision],
    eligibleConfigurationHashes: [digest],
    eligibleSemanticExecutionConfigurationHashes: [digest],
    lastSeenAt: "2026-07-24T12:00:00.000Z",
  };
  return {
    observedAt: "2026-07-24T12:00:05.000Z",
    sitesVersion: "2.4.0",
    sitesRevision: revision,
    api: {
      replicaIdentityHash: "f".repeat(64),
      identifier: "genio-api",
      version: "2.4.0",
      revision,
      configurationHash: digest,
      semanticExecutionConfigurationHash: digest,
    },
    runtime: {
      semanticExecutionConfigurationHash: digest,
      publicRolloutEvidenceHash: "c".repeat(64),
      publicRolloutStage: "genre_scene:0->1",
    },
    runtimeContractHash: "d".repeat(64),
    systemHttpStatus: 200,
    system: {
      api: {
        replicaIdentityHash: "0".repeat(64),
        identifier: "genio-api",
        version: "2.4.0",
        revision,
        configurationHash: digest,
        semanticExecutionConfigurationHash: digest,
      },
      ok: true,
      activationReady: true,
      database: "ready",
      releaseManifestCanaryGuardsVersion: "1",
      canonicalExecutionHardeningVersion: "1",
      proofArchitectureVersion: "1",
      proofArchitectureAuthority: "native",
      canonicalExecutorReleaseIdentityFencingVersion: "1",
      executorFencing: {
        ready: true,
        incompleteJobs: 0,
        mismatchedActiveAttempts: 0,
        uncoveredJobs: 0,
        requirementsHash: "f".repeat(64),
      },
      publicRollout: {
        active: true,
        databaseAuthorized: true,
        evidenceHash: "c".repeat(64),
        stage: "genre_scene:0->1",
        targetConfigurationHash: "e".repeat(64),
      },
      paused: false,
      workerProtocol: {
        expected: "playlist-pipeline-v12",
        minimumAccepted: "playlist-pipeline-v12",
        actual: "playlist-pipeline-v12",
      },
      workerLanes: {
        interactive: { ...lane },
        deep: { ...lane },
      },
      queue: {
        queued: 0,
        leased: 0,
        expiredLeases: 0,
        failed: 0,
        oldestQueuedSeconds: 0,
      },
    },
  };
}

describe("public rollout live observation producer", () => {
  test("requires --intent-canary only for an advance", () => {
    const common = [
      "--confirm-production-public-rollout",
      "--origin", "https://9enio.com",
      "--candidate-tag", "v2.4.0-rc.2",
      "--candidate-version", "2.4.0",
      "--candidate-revision", revision,
      "--image-digest", `sha256:${digest}`,
      "--intent-group", "genre_scene",
      "--samples", "3",
      "--interval-seconds", "30",
      "--runtime-snapshot", "runtime.json",
      "--promotion-evidence", "promotion.json",
      "--verification-key", "release.pub",
      "--output", "rollout.json",
      "--producer-signing-key", "release.key",
      "--producer-key-id", "release-test-v1",
    ];
    const environment = {
      RELEASE_PRODUCTION_ORIGIN: "https://9enio.com",
      RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_ID:
        "intent-canary-producer-v1",
      RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_SHA256: "c".repeat(64),
      RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256:
        "d".repeat(64),
    };
    expect(() => parsePublicRolloutEvidenceProducerArgs([
      ...common,
      "--to-percent", "1",
      "--rollback-warrant-output", "rollback-warrant.json",
    ], environment)).toThrow(/advance requires --intent-canary/u);
    expect(parsePublicRolloutEvidenceProducerArgs([
      ...common,
      "--to-percent", "1",
      "--intent-canary", "intent-canary.json",
      "--intent-canary-verification-key", "intent-canary.pub",
      "--rollback-warrant-output", "rollback-warrant.json",
    ], environment)).toMatchObject({
      toPercent: "1",
      intentCanaryPath: "intent-canary.json",
      intentCanaryVerificationKeyPath: "intent-canary.pub",
    });
    expect(parsePublicRolloutEvidenceProducerArgs([
      ...common,
      "--to-percent", "0",
      "--rollback-warrant", "rollback-warrant.json",
    ], environment)).toMatchObject({
      toPercent: "0",
      intentCanaryPath: null,
    });
    expect(() => parsePublicRolloutEvidenceProducerArgs([
      ...common,
      "--to-percent", "0",
      "--intent-canary", "intent-canary.json",
      "--rollback-warrant", "rollback-warrant.json",
    ], environment)).toThrow(/rollback.*forbids.*--intent-canary/u);
  });

  test("scopes historical promotion time strictly to emergency rollback", () => {
    const expired = {
      payload: { generatedAt: "2026-07-20T12:00:00.000Z" },
    };
    expect(historicalPromotionVerificationTimeForRollback(expired, "0"))
      .toBe("2026-07-20T12:00:00.000Z");
    expect(historicalPromotionVerificationTimeForRollback(expired, "1"))
      .toBeUndefined();
    expect(historicalPromotionVerificationTimeForRollback(expired, "10"))
      .toBeUndefined();
  });

  test("copies only an exact healthy observation", () => {
    expect(summarizePublicRolloutObservation(observation())).toMatchObject({
      systemHttpStatus: 200,
      systemOk: true,
      activationReady: true,
      database: "ready",
      databaseCapabilityVersion: "2",
      releaseManifestCanaryGuardsVersion: "1",
      canonicalExecutionHardeningVersion: "1",
      paused: false,
      workerProtocolActual: "playlist-pipeline-v12",
      interactiveWorker: {
        status: "healthy",
        protocolVersion: "playlist-pipeline-v12",
      },
    });
  });

  test.each([
    ["HTTP failure", (value: ReleaseConvergenceObservation) => {
      value.systemHttpStatus = 503;
    }],
    ["system failure", (value: ReleaseConvergenceObservation) => {
      value.system.ok = false;
    }],
    ["database failure", (value: ReleaseConvergenceObservation) => {
      value.system.database = "unavailable";
    }],
    ["capability failure", (value: ReleaseConvergenceObservation) => {
      value.system.releaseManifestCanaryGuardsVersion = "0";
    }],
    ["unauthorized rollout database state", (value: ReleaseConvergenceObservation) => {
      value.system.publicRollout.databaseAuthorized = false;
    }],
    ["mismatched rollout database state", (value: ReleaseConvergenceObservation) => {
      value.system.publicRollout.evidenceHash = "9".repeat(64);
    }],
    ["paused system", (value: ReleaseConvergenceObservation) => {
      value.system.paused = true;
    }],
    ["unhealthy worker", (value: ReleaseConvergenceObservation) => {
      value.system.workerLanes.interactive.status = "degraded";
    }],
    ["wrong worker protocol", (value: ReleaseConvergenceObservation) => {
      value.system.workerLanes.deep.protocolVersion = "playlist-pipeline-v9";
    }],
  ])("rejects %s instead of coercing it into passing evidence", (_label, mutate) => {
    const value = observation();
    mutate(value);
    expect(() => summarizePublicRolloutObservation(value)).toThrow(
      /cannot summarize an unhealthy convergence observation/u,
    );
  });
});
