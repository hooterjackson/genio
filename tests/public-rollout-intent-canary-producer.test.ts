import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  SIGNED_PUBLIC_ROLLOUT_APPLE_SOURCE_SCHEMA_VERSION,
  SIGNED_PUBLIC_ROLLOUT_ASSIGNMENT_SOURCE_SCHEMA_VERSION,
  SIGNED_PUBLIC_ROLLOUT_BROWSER_SOURCE_SCHEMA_VERSION,
  SIGNED_PUBLIC_ROLLOUT_MANIFEST_SOURCE_SCHEMA_VERSION,
  SIGNED_PUBLIC_ROLLOUT_METRICS_SOURCE_SCHEMA_VERSION,
  PUBLIC_ROLLOUT_INTENT_METRICS_QUERY_HASH_V2,
  parsePublicRolloutIntentCanaryProducerArgs,
  producePublicRolloutIntentCanaryV1,
  type ProtectedPublicRolloutSourceV1,
} from "../scripts/public-rollout-intent-canary-producer.ts";
import {
  PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURES,
  publicRolloutIntentAssignmentHashV2,
  publicRolloutIntentCanaryAuthorityPolicyHashV1,
  publicRolloutIntentCanaryKeyFingerprint,
} from "../shared/public-rollout-intent-canary.ts";
import {
  createStrictSignedEnvelope,
  signedArtifactSha256,
  type JsonRecord,
} from "../shared/signed-artifact.ts";

const sourceRevision = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const apiConfigurationHash = "c".repeat(64);
const workerConfigurationHash = "7".repeat(64);
const executorIdentityHash = "d".repeat(64);
const targetConfigurationHash = "e".repeat(64);
const fixtureHash =
  PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURES.genre_scene.fixtureHash;
const contractSemanticHash = "2".repeat(64);
const manifestContentHash = "1".repeat(64);
const generatedAt = "2026-07-25T12:10:00.000Z";
const orderedAppleIds = Array.from({ length: 50 }, (_, index) =>
  `apple-track-${index + 1}`);

const keys = {
  assignment: generateKeyPairSync("ed25519"),
  manifest: generateKeyPairSync("ed25519"),
  apple: generateKeyPairSync("ed25519"),
  browser: generateKeyPairSync("ed25519"),
  metrics: generateKeyPairSync("ed25519"),
  producer: generateKeyPairSync("ed25519"),
  rollout: generateKeyPairSync("ed25519"),
};

type SourceRole =
  | "assignment"
  | "manifest"
  | "apple"
  | "browser"
  | "metrics";

const envelopeSchema: Record<SourceRole, string> = {
  assignment: SIGNED_PUBLIC_ROLLOUT_ASSIGNMENT_SOURCE_SCHEMA_VERSION,
  manifest: SIGNED_PUBLIC_ROLLOUT_MANIFEST_SOURCE_SCHEMA_VERSION,
  apple: SIGNED_PUBLIC_ROLLOUT_APPLE_SOURCE_SCHEMA_VERSION,
  browser: SIGNED_PUBLIC_ROLLOUT_BROWSER_SOURCE_SCHEMA_VERSION,
  metrics: SIGNED_PUBLIC_ROLLOUT_METRICS_SOURCE_SCHEMA_VERSION,
};

function trust(role: SourceRole | "producer") {
  return {
    producerKeyId: `public-rollout-${role}-authority-v1`,
    producerKeySha256:
      publicRolloutIntentCanaryKeyFingerprint(keys[role].publicKey),
  };
}

function source(
  role: SourceRole,
  payload: JsonRecord,
  signingKey = keys[role].privateKey,
  sourceTrust = trust(role),
): ProtectedPublicRolloutSourceV1 {
  return {
    value: createStrictSignedEnvelope({
      envelopeSchemaVersion: envelopeSchema[role],
      payload,
      signingKey,
      keyId: sourceTrust.producerKeyId,
    }),
    verificationKey: keys[role].publicKey,
    trust: sourceTrust,
  };
}

function sourcePayloads(input: {
  fromPercent?: "0" | "1";
  toPercent?: "1" | "10";
  candidateAssignedCount?: number;
  selectedTrackCount?: number;
  manifestIds?: string[];
  appleIds?: string[];
  fixtureHash?: string;
  assignmentContractSemanticHash?: string;
  manifestContractSemanticHash?: string;
  eligibleSubmissionCount?: number;
  controlAssignedCount?: number;
  controlExactCompletionCount?: number;
  controlExactCompletionRate?: number;
} = {}) {
  const fromPercent = input.fromPercent ?? "0";
  const toPercent = input.toPercent ?? "1";
  const candidateAssignedCount = input.candidateAssignedCount
    ?? (fromPercent === "0" ? 0 : 20);
  const manifestIds = input.manifestIds ?? orderedAppleIds;
  const appleIds = input.appleIds ?? orderedAppleIds;
  const selectedFixtureHash = input.fixtureHash ?? fixtureHash;
  const assignmentContractSemanticHash =
    input.assignmentContractSemanticHash ?? contractSemanticHash;
  const controlAssignedCount = input.controlAssignedCount
    ?? (fromPercent === "0" ? 0 : 2_000 - candidateAssignedCount);
  const controlExactCompletionCount =
    input.controlExactCompletionCount ?? controlAssignedCount;
  const assignmentHash = publicRolloutIntentAssignmentHashV2({
    sourceRevision,
    imageDigest,
    apiConfigurationHash,
    executorIdentityHash,
    intentGroup: "genre_scene",
    fromPercent,
    toPercent,
    targetConfigurationHash,
    fixtureHash: selectedFixtureHash,
    contractSemanticHash: assignmentContractSemanticHash,
  });
  return {
    assignment: {
      schemaVersion: "genio-public-rollout-assignment-source/v2",
      capturedAt: "2026-07-25T12:00:00.000Z",
      environment: "production",
      route: "owner_candidate",
      assigned: true,
      candidate: {
        tag: "v2.4.0-rc.2",
        version: "2.4.0",
        sourceRevision,
        imageDigest,
        apiConfigurationHash,
        executorIdentityHash,
      },
      transition: {
        intentGroup: "genre_scene",
        fromPercent,
        toPercent,
        targetConfigurationHash,
      },
      fixture: {
        fixtureId: "smooth-reggaeton-heat-50-v1",
        fixtureHash: selectedFixtureHash,
        targetTrackCount: 50,
        contractSemanticHash: assignmentContractSemanticHash,
      },
      assignmentHash,
    },
    manifest: {
      schemaVersion: "genio-public-rollout-manifest-source/v1",
      completedAt: "2026-07-25T12:02:00.000Z",
      environment: "production",
      fixtureId: "smooth-reggaeton-heat-50-v1",
      fixtureHash: selectedFixtureHash,
      outcome: "exact_ready",
      requestedTrackCount: 50,
      selectedTrackCount: input.selectedTrackCount ?? 50,
      contractSemanticHash:
        input.manifestContractSemanticHash ?? assignmentContractSemanticHash,
      guidanceLineageHash: "3".repeat(64),
      manifestContentHash,
      orderedAppleIds: manifestIds,
      apiConfigurationHash,
      workerRevision: sourceRevision,
      workerConfigurationHash,
      executorIdentityHash,
      qualityScores: {
        relevance: 4,
        discoveryQuality: 4,
        coherence: 4,
        sequencing: 4,
      },
    },
    apple: {
      schemaVersion: "genio-public-rollout-apple-source/v1",
      observedAt: "2026-07-25T12:03:00.000Z",
      environment: "production",
      fixtureId: "smooth-reggaeton-heat-50-v1",
      manifestContentHash,
      orderedAppleIds: appleIds,
      exactOrderedReadback: true,
      verifierRole: "independent_apple_api",
      verifierIdentityHash: "4".repeat(64),
    },
    browser: {
      schemaVersion: "genio-public-rollout-browser-source/v1",
      observedAt: "2026-07-25T12:04:00.000Z",
      environment: "production",
      fixtureId: "smooth-reggaeton-heat-50-v1",
      manifestContentHash,
      visibleTrackCount: 50,
      orderedContentsHash: signedArtifactSha256(manifestIds),
      publicAccessibility: true,
      verifierRole: "independent_browser",
      screenshotHash: "5".repeat(64),
    },
    metrics: {
      schemaVersion: "genio-public-rollout-metrics-source/v2",
      capturedAt: "2026-07-25T12:09:00.000Z",
      environment: "production",
      source: "production_database",
      databaseIdentityHash: "6".repeat(64),
      sourceQueryHash: PUBLIC_ROLLOUT_INTENT_METRICS_QUERY_HASH_V2,
      candidateSourceRevision: sourceRevision,
      apiConfigurationHash,
      windowStartedAt: "2026-07-25T12:05:00.000Z",
      windowCompletedAt: "2026-07-25T12:08:00.000Z",
      intentGroup: "genre_scene",
      stagePercent: fromPercent,
      eligibleSubmissionCount:
        input.eligibleSubmissionCount
          ?? candidateAssignedCount + controlAssignedCount,
      sharedProviderIncidentCount: 0,
      candidateAssignedCount,
      controlAssignedCount,
      exactCompletionCount: candidateAssignedCount,
      actionableDecisionCount: 0,
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
          ?? (controlAssignedCount === 0
            ? 0
            : controlExactCompletionCount / controlAssignedCount),
      candidateExactCompletionRate: candidateAssignedCount === 0 ? 0 : 1,
    },
  } satisfies Record<SourceRole, JsonRecord>;
}

function producerInput(
  payloads = sourcePayloads(),
  overrides: Partial<{
    assignment: ProtectedPublicRolloutSourceV1;
    manifest: ProtectedPublicRolloutSourceV1;
    apple: ProtectedPublicRolloutSourceV1;
    browser: ProtectedPublicRolloutSourceV1;
    metrics: ProtectedPublicRolloutSourceV1;
    producerSigningKey: typeof keys.producer.privateKey;
    producerTrust: ReturnType<typeof trust>;
    rolloutEvidenceKeySha256: string;
    authorityPolicyHash: string;
  }> = {},
) {
  const rolloutEvidenceKeySha256 =
    publicRolloutIntentCanaryKeyFingerprint(keys.rollout.publicKey);
  const authorityPolicyHash =
    publicRolloutIntentCanaryAuthorityPolicyHashV1({
      sourceKeySha256: {
        assignment: trust("assignment").producerKeySha256,
        manifest: trust("manifest").producerKeySha256,
        apple: trust("apple").producerKeySha256,
        browser: trust("browser").producerKeySha256,
        metrics: trust("metrics").producerKeySha256,
      },
      producerKeySha256: trust("producer").producerKeySha256,
      rolloutEvidenceKeySha256,
    });
  return {
    assignment: source("assignment", payloads.assignment),
    manifest: source("manifest", payloads.manifest),
    apple: source("apple", payloads.apple),
    browser: source("browser", payloads.browser),
    metrics: source("metrics", payloads.metrics),
    producerSigningKey: keys.producer.privateKey,
    producerTrust: trust("producer"),
    rolloutEvidenceKeySha256,
    authorityPolicyHash,
    generatedAt,
    ...overrides,
  };
}

describe("public rollout intent canary protected producer", () => {
  test("derives the signed canary only from exact independently signed sources", () => {
    const produced = producePublicRolloutIntentCanaryV1(producerInput());
    expect(produced.verified).toMatchObject({
      candidate: {
        sourceRevision,
        apiConfigurationHash,
        executorIdentityHash,
      },
      transition: {
        intentGroup: "genre_scene",
        fromPercent: "0",
        toPercent: "1",
        targetConfigurationHash,
      },
      fixture: {
        fixtureId: "smooth-reggaeton-heat-50-v1",
        fixtureHash,
        targetTrackCount: 50,
        contractSemanticHash,
      },
      execution: {
        manifestContentHash,
        orderedAppleIdsHash: signedArtifactSha256(orderedAppleIds),
        workerConfigurationHash,
      },
    });
    expect(Object.keys(produced.sourcePayloadHashes).sort()).toEqual([
      "apple",
      "assignment",
      "browser",
      "manifest",
      "metrics",
    ]);
  });

  test("rejects a trusted manifest that disagrees with independent Apple order", () => {
    const payloads = sourcePayloads({
      manifestIds: [...orderedAppleIds].reverse(),
    });
    expect(() => producePublicRolloutIntentCanaryV1(
      producerInput(payloads),
    )).toThrow(/Apple source does not prove exact manifest count and order/u);
  });

  test("rejects a healthy-looking system receipt with a short exact outcome", () => {
    const payloads = sourcePayloads({ selectedTrackCount: 49 });
    expect(() => producePublicRolloutIntentCanaryV1(
      producerInput(payloads),
    )).toThrow(/manifest does not prove exact candidate execution/u);
  });

  test("rejects a replaceable easy fixture and a manifest from another contract", () => {
    expect(() => producePublicRolloutIntentCanaryV1(
      producerInput(sourcePayloads({ fixtureHash: "f".repeat(64) })),
    )).toThrow(/wrong intent fixture/u);
    expect(() => producePublicRolloutIntentCanaryV1(
      producerInput(sourcePayloads({
        manifestContractSemanticHash: "9".repeat(64),
      })),
    )).toThrow(/manifest does not prove exact candidate execution/u);
  });

  test("rejects CLI or environment trust repinning outside the immutable build policy", () => {
    expect(() => producePublicRolloutIntentCanaryV1(producerInput(
      sourcePayloads(),
      { authorityPolicyHash: "f".repeat(64) },
    ))).toThrow(/immutable build policy/u);
  });

  test("rejects low database-derived samples for a staged advance", () => {
    const payloads = sourcePayloads({
      fromPercent: "1",
      toPercent: "10",
      candidateAssignedCount: 19,
    });
    expect(() => producePublicRolloutIntentCanaryV1(
      producerInput(payloads),
    )).toThrow(/stage lacks samples/u);
  });

  test("rejects cherry-picked denominators and unrecomputable control rates", () => {
    expect(() => producePublicRolloutIntentCanaryV1(
      producerInput(sourcePayloads({
        fromPercent: "1",
        toPercent: "10",
        candidateAssignedCount: 20,
        eligibleSubmissionCount: 1,
      })),
    )).toThrow(/stage lacks samples or regresses/u);
    expect(() => producePublicRolloutIntentCanaryV1(
      producerInput(sourcePayloads({
        fromPercent: "1",
        toPercent: "10",
        candidateAssignedCount: 20,
        controlExactCompletionCount: 1_979,
        controlExactCompletionRate: 1,
      })),
    )).toThrow(/controlExactCompletionRate is not recomputable/u);
  });

  test("rejects metrics signed from an arbitrary database query", () => {
    const payloads = sourcePayloads();
    payloads.metrics.sourceQueryHash = "7".repeat(64);
    expect(() => producePublicRolloutIntentCanaryV1(
      producerInput(payloads),
    )).toThrow(/fixed intent-window query/u);
  });

  test("rejects a release-key self-authored canary and reused source authority", () => {
    expect(() => producePublicRolloutIntentCanaryV1(producerInput(
      sourcePayloads(),
      {
        producerSigningKey: keys.rollout.privateKey,
        producerTrust: {
          producerKeyId: "public-rollout-self-authored-v1",
          producerKeySha256:
            publicRolloutIntentCanaryKeyFingerprint(keys.rollout.publicKey),
        },
      },
    ))).toThrow(/must use distinct protected keys/u);

    const payloads = sourcePayloads();
    const reusedApple = source(
      "apple",
      payloads.apple,
      keys.browser.privateKey,
      trust("browser"),
    );
    expect(() => producePublicRolloutIntentCanaryV1(producerInput(
      payloads,
      {
        apple: {
          ...reusedApple,
          verificationKey: keys.browser.publicKey,
        },
      },
    ))).toThrow(/must use distinct protected keys/u);
  });

  test("rejects tampering after an authority signed its source", () => {
    const payloads = sourcePayloads();
    const signedManifest = source("manifest", payloads.manifest);
    const envelope = signedManifest.value as {
      payload: JsonRecord;
    };
    envelope.payload.selectedTrackCount = 49;
    expect(() => producePublicRolloutIntentCanaryV1(producerInput(
      payloads,
      { manifest: signedManifest },
    ))).toThrow(/payload hash does not match/u);
  });

  test("parses only the complete immutable source set", () => {
    const argv = [
      "--assignment-receipt", "assignment.json",
      "--assignment-verification-key", "assignment.pub",
      "--manifest-receipt", "manifest.json",
      "--manifest-verification-key", "manifest.pub",
      "--apple-evidence", "apple.json",
      "--apple-verification-key", "apple.pub",
      "--browser-evidence", "browser.json",
      "--browser-verification-key", "browser.pub",
      "--metrics-receipt", "metrics.json",
      "--metrics-verification-key", "metrics.pub",
      "--output", "intent-canary.json",
      "--producer-signing-key", "intent-canary.key",
      "--producer-key-id", "public-rollout-intent-canary-v1",
    ];
    expect(parsePublicRolloutIntentCanaryProducerArgs(argv)).toMatchObject({
      outputPath: "intent-canary.json",
      producerKeyId: "public-rollout-intent-canary-v1",
    });
    expect(() => parsePublicRolloutIntentCanaryProducerArgs(
      argv.slice(0, -2),
    )).toThrow(/--producer-key-id is required exactly once/u);
  });
});
