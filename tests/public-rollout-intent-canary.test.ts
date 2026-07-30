import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  PUBLIC_ROLLOUT_INTENT_CANARY_SCHEMA_VERSION,
  PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURES,
  PUBLIC_ROLLOUT_INTENT_CANARY_PROVENANCE_SCHEMA_VERSION,
  SIGNED_PUBLIC_ROLLOUT_INTENT_CANARY_SCHEMA_VERSION,
  publicRolloutIntentAssignmentHashV2,
  publicRolloutIntentCanaryAuthorityPolicyHashV1,
  publicRolloutIntentCanaryKeyFingerprint,
  verifyPublicRolloutIntentCanaryV1,
} from "../shared/public-rollout-intent-canary.ts";
import {
  createStrictSignedEnvelope,
  signedArtifactSha256,
} from "../shared/signed-artifact.ts";
import { RELEASE_FIXTURES } from "../scripts/release-fixtures.ts";

const keys = generateKeyPairSync("ed25519");
const sourceRevision = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const apiConfigurationHash = "c".repeat(64);
const executorIdentityHash = "d".repeat(64);
const targetConfigurationHash = "e".repeat(64);
const contractSemanticHash = "1".repeat(64);
const generatedAt = "2026-07-24T12:00:00.000Z";
const producerKeySha256 =
  publicRolloutIntentCanaryKeyFingerprint(keys.publicKey);
const sourceKeySha256 = {
  assignment: "0".repeat(64),
  manifest: "1".repeat(64),
  apple: "2".repeat(64),
  browser: "3".repeat(64),
  metrics: "4".repeat(64),
};
const rolloutEvidenceKeySha256 = "a".repeat(64);
const authorityPolicyHash =
  publicRolloutIntentCanaryAuthorityPolicyHashV1({
    sourceKeySha256,
    producerKeySha256,
    rolloutEvidenceKeySha256,
  });

function provenance() {
  const unsigned = {
    schemaVersion: PUBLIC_ROLLOUT_INTENT_CANARY_PROVENANCE_SCHEMA_VERSION,
    producerKind: "protected_exact_source_derivation",
    sourcePayloadHashes: {
      assignment: "7".repeat(64),
      manifest: "8".repeat(64),
      apple: "5".repeat(64),
      browser: "6".repeat(64),
      metrics: "9".repeat(64),
    },
    sourceKeySha256,
    producerKeySha256,
    rolloutEvidenceKeySha256,
    authorityPolicyHash,
  };
  return {
    ...unsigned,
    derivationHash: signedArtifactSha256(unsigned),
  };
}

function payload(input: {
  intentGroup?: keyof typeof PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURES;
  fromPercent?: "0" | "1" | "10" | "50";
  toPercent?: "1" | "10" | "50" | "100";
  candidateAssignedCount?: number;
  exactCompletionCount?: number;
  selectedTrackCount?: number;
  fixtureId?: string;
  assignmentHash?: string;
  generatedAt?: string;
  controlExactCompletionRate?: number;
  candidateExactCompletionRate?: number;
  eligibleSubmissionCount?: number;
  controlAssignedCount?: number;
  controlExactCompletionCount?: number;
  fixtureHash?: string;
  contractSemanticHash?: string;
  executionContractSemanticHash?: string;
} = {}) {
  const intentGroup = input.intentGroup ?? "genre_scene";
  const fromPercent = input.fromPercent ?? "0";
  const toPercent = input.toPercent ?? "1";
  const fixture = PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURES[intentGroup];
  const candidateAssignedCount = input.candidateAssignedCount ?? ({
    "0": 0,
    "1": 20,
    "10": 100,
    "50": 500,
  } as const)[fromPercent];
  const controlAssignedCount = input.controlAssignedCount ?? ({
    "0": 0,
    "1": 1_980,
    "10": 900,
    "50": 500,
  } as const)[fromPercent];
  const exactCompletionCount =
    input.exactCompletionCount ?? candidateAssignedCount;
  const controlExactCompletionCount =
    input.controlExactCompletionCount ?? controlAssignedCount;
  const protectedFixtureHash = input.fixtureHash ?? fixture.fixtureHash;
  const protectedContractSemanticHash =
    input.contractSemanticHash ?? contractSemanticHash;
  const completed = input.generatedAt ?? generatedAt;
  const assignmentHash = input.assignmentHash
    ?? publicRolloutIntentAssignmentHashV2({
      sourceRevision,
      imageDigest,
      apiConfigurationHash,
      executorIdentityHash,
      intentGroup,
      fromPercent,
      toPercent,
      targetConfigurationHash,
      fixtureHash: protectedFixtureHash,
      contractSemanticHash: protectedContractSemanticHash,
    });
  return {
    schemaVersion: PUBLIC_ROLLOUT_INTENT_CANARY_SCHEMA_VERSION,
    generatedAt: completed,
    expiresAt: new Date(Date.parse(completed) + 60 * 60_000).toISOString(),
    environment: "production",
    candidate: {
      tag: "v2.4.0-rc.2",
      version: "2.4.0",
      sourceRevision,
      imageDigest,
      apiConfigurationHash,
      executorIdentityHash,
    },
    transition: {
      operation: "advance",
      intentGroup,
      fromPercent,
      toPercent,
      targetConfigurationHash,
      assignmentRoute: "owner_candidate",
      assignmentHash,
    },
    fixture: {
      fixtureId: input.fixtureId ?? fixture.fixtureId,
      fixtureHash: protectedFixtureHash,
      targetTrackCount: fixture.targetTrackCount,
      contractSemanticHash: protectedContractSemanticHash,
    },
    execution: {
      completedAt: new Date(Date.parse(completed) - 10_000).toISOString(),
      outcome: "exact_ready",
      requestedTrackCount: fixture.targetTrackCount,
      selectedTrackCount:
        input.selectedTrackCount ?? fixture.targetTrackCount,
      contractSemanticHash:
        input.executionContractSemanticHash ?? protectedContractSemanticHash,
      guidanceLineageHash: intentGroup === "genre_scene" ? "2".repeat(64) : null,
      manifestContentHash: "3".repeat(64),
      orderedAppleIdsHash: "4".repeat(64),
      independentAppleEvidenceHash: "5".repeat(64),
      browserEvidenceHash: "6".repeat(64),
      workerRevision: sourceRevision,
      workerConfigurationHash: "7".repeat(64),
      workerIdentityHash: executorIdentityHash,
      qualityScores: {
        relevance: 4,
        discoveryQuality: 4,
        coherence: 4,
        sequencing: 4,
      },
    },
    stageMetrics: {
      windowStartedAt: new Date(Date.parse(completed) - 120_000).toISOString(),
      windowCompletedAt: new Date(Date.parse(completed) - 20_000).toISOString(),
      intentGroup,
      stagePercent: fromPercent,
      eligibleSubmissionCount:
        input.eligibleSubmissionCount
          ?? candidateAssignedCount + controlAssignedCount,
      sharedProviderIncidentCount: 0,
      candidateAssignedCount,
      controlAssignedCount,
      exactCompletionCount,
      actionableDecisionCount: candidateAssignedCount - exactCompletionCount,
      visibleRetryStateCount: 0,
      cancelledCount: 0,
      technicalQuarantineCount: 0,
      controlExactCompletionCount,
      controlActionableDecisionCount:
        controlAssignedCount - controlExactCompletionCount,
      controlVisibleRetryStateCount: 0,
      controlCancelledCount: 0,
      controlTechnicalQuarantineCount: 0,
      unexplainedDeadEndCount: 0,
      countOrderViolationCount: 0,
      hardConstraintViolationCount: 0,
      stalePublicationCount: 0,
      providerScarcityMislabelCount: 0,
      controlExactCompletionRate:
        input.controlExactCompletionRate
          ?? (
            controlAssignedCount === 0
              ? 0
              : controlExactCompletionCount / controlAssignedCount
          ),
      candidateExactCompletionRate:
        input.candidateExactCompletionRate
          ?? (candidateAssignedCount === 0 ? 0 : exactCompletionCount / candidateAssignedCount),
    },
    provenance: provenance(),
  };
}

function envelope(value = payload()) {
  return createStrictSignedEnvelope({
    envelopeSchemaVersion:
      SIGNED_PUBLIC_ROLLOUT_INTENT_CANARY_SCHEMA_VERSION,
    payload: value,
    signingKey: keys.privateKey,
    keyId: "release-intent-canary",
  });
}

function expected(
  input: {
    intentGroup?: keyof typeof PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURES;
    fromPercent?: "0" | "1" | "10" | "50";
    toPercent?: "1" | "10" | "50" | "100";
  } = {},
) {
  return {
    tag: "v2.4.0-rc.2",
    version: "2.4.0",
    sourceRevision,
    imageDigest,
    apiConfigurationHash,
    executorIdentityHash,
    intentGroup: input.intentGroup ?? "genre_scene",
    fromPercent: input.fromPercent ?? "0",
    toPercent: input.toPercent ?? "1",
    targetConfigurationHash,
    authorityPolicyHash,
    now: generatedAt,
  } as const;
}

describe("public rollout intent-specific canary", () => {
  test("pins the affected regression to the exact code-owned release fixture", () => {
    expect(PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURES.genre_scene.fixtureHash)
      .toBe(RELEASE_FIXTURES["smooth-reggaeton-heat-50-v1"].fixtureHash);
  });

  test("accepts the exact signed owner canary and current-stage metrics", () => {
    const verified = verifyPublicRolloutIntentCanaryV1(
      envelope(),
      keys.publicKey,
      expected(),
    );
    expect(verified).toMatchObject({
      transition: {
        intentGroup: "genre_scene",
        fromPercent: "0",
        toPercent: "1",
      },
      fixture: {
        fixtureId: "smooth-reggaeton-heat-50-v1",
        targetTrackCount: 50,
      },
      execution: {
        orderedAppleIdsHash: "4".repeat(64),
      },
    });
    expect(verified.payloadHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("rejects a hand-authored claim without protected source provenance", () => {
    const handAuthored: Record<string, unknown> = { ...payload() };
    delete handAuthored.provenance;
    expect(() => verifyPublicRolloutIntentCanaryV1(
      envelope(handAuthored as ReturnType<typeof payload>),
      keys.publicKey,
      expected(),
    )).toThrow(/missing or unapproved fields/u);
  });

  test("rejects a cross-intent fixture even when its assignment is rehashed", () => {
    const value = payload({
      intentGroup: "similarity",
      fixtureId: "smooth-reggaeton-heat-50-v1",
    });
    expect(() => envelope(value)).not.toThrow();
    expect(() => verifyPublicRolloutIntentCanaryV1(
      envelope(value),
      keys.publicKey,
      expected({ intentGroup: "similarity" }),
    )).toThrow(/wrong capability fixture/u);
  });

  test("rejects an easy substitute fixture and a different compiled contract", () => {
    expect(() => verifyPublicRolloutIntentCanaryV1(
      envelope(payload({ fixtureHash: "f".repeat(64) })),
      keys.publicKey,
      expected(),
    )).toThrow(/fixture hash is not the protected capability fixture/u);
    expect(() => verifyPublicRolloutIntentCanaryV1(
      envelope(payload({
        executionContractSemanticHash: "9".repeat(64),
      })),
      keys.publicKey,
      expected(),
    )).toThrow(/execution is not exact/u);
  });

  test("rejects a canary when editable trust is repinned away from the build policy", () => {
    expect(() => verifyPublicRolloutIntentCanaryV1(
      envelope(),
      keys.publicKey,
      {
        ...expected(),
        authorityPolicyHash: "f".repeat(64),
      },
    )).toThrow(/exact candidate transition/u);
  });

  test("rejects a healthy system canary whose exact manifest is short", () => {
    expect(() => verifyPublicRolloutIntentCanaryV1(
      envelope(payload({ selectedTrackCount: 49 })),
      keys.publicKey,
      expected(),
    )).toThrow(/execution is not exact/u);
  });

  test("rejects a stale, wrong-stage, or tampered assignment", () => {
    expect(() => verifyPublicRolloutIntentCanaryV1(
      envelope(payload()),
      keys.publicKey,
      expected({ fromPercent: "1", toPercent: "10" }),
    )).toThrow(/exact candidate transition/u);
    expect(() => verifyPublicRolloutIntentCanaryV1(
      envelope(payload({ assignmentHash: signedArtifactSha256({ wrong: true }) })),
      keys.publicKey,
      expected(),
    )).toThrow(/assignment hash/u);
    expect(() => verifyPublicRolloutIntentCanaryV1(
      envelope(payload()),
      keys.publicKey,
      {
        ...expected(),
        now: "2026-07-24T14:00:00.000Z",
      },
    )).toThrow(/not fresh/u);
  });

  test("blocks the next cohort when the current stage lacks samples or regresses", () => {
    expect(() => verifyPublicRolloutIntentCanaryV1(
      envelope(payload({
        fromPercent: "1",
        toPercent: "10",
        candidateAssignedCount: 19,
        exactCompletionCount: 19,
      })),
      keys.publicKey,
      expected({ fromPercent: "1", toPercent: "10" }),
    )).toThrow(/lacks samples or regresses/u);
    expect(() => verifyPublicRolloutIntentCanaryV1(
      envelope(payload({
        fromPercent: "1",
        toPercent: "10",
        candidateAssignedCount: 20,
        exactCompletionCount: 19,
        controlExactCompletionRate: 1,
      })),
      keys.publicKey,
      expected({ fromPercent: "1", toPercent: "10" }),
    )).toThrow(/lacks samples or regresses/u);
    expect(() => verifyPublicRolloutIntentCanaryV1(
      envelope(payload({
        fromPercent: "1",
        toPercent: "10",
        candidateAssignedCount: 20,
        exactCompletionCount: 20,
      })),
      keys.publicKey,
      expected({ fromPercent: "1", toPercent: "10" }),
    )).not.toThrow();
  });

  test("rejects cherry-picked denominators and unrecomputable control metrics", () => {
    expect(() => verifyPublicRolloutIntentCanaryV1(
      envelope(payload({
        fromPercent: "1",
        toPercent: "10",
        candidateAssignedCount: 20,
        eligibleSubmissionCount: 1,
      })),
      keys.publicKey,
      expected({ fromPercent: "1", toPercent: "10" }),
    )).toThrow(/lacks samples or regresses/u);
    expect(() => verifyPublicRolloutIntentCanaryV1(
      envelope(payload({
        fromPercent: "1",
        toPercent: "10",
        candidateAssignedCount: 20,
        controlAssignedCount: 1_980,
        controlExactCompletionCount: 1_979,
        controlExactCompletionRate: 1,
      })),
      keys.publicKey,
      expected({ fromPercent: "1", toPercent: "10" }),
    )).toThrow(/controlExactCompletionRate is not recomputable/u);
    expect(() => verifyPublicRolloutIntentCanaryV1(
      envelope(payload({
        fromPercent: "1",
        toPercent: "10",
        candidateAssignedCount: 20,
        controlAssignedCount: 0,
        eligibleSubmissionCount: 20,
      })),
      keys.publicKey,
      expected({ fromPercent: "1", toPercent: "10" }),
    )).toThrow(/lacks samples or regresses/u);
  });
});
