import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  PUBLIC_ROLLOUT_EVIDENCE_SCHEMA_VERSION,
  SIGNED_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_SCHEMA_VERSION,
  SIGNED_PUBLIC_ROLLOUT_EVIDENCE_SCHEMA_VERSION,
  buildPublicRolloutRollbackWarrantPayload,
  publicRolloutPercentages,
  type PublicRolloutConfiguration,
  verifyPublicRolloutFinalizationLineage,
  verifyPreviousPublicRolloutLineage,
  verifyPublicRolloutEvidence,
  verifyPublicRolloutRollbackWarrant,
} from "../shared/public-rollout-evidence.ts";
import {
  PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURES,
  PUBLIC_ROLLOUT_INTENT_CANARY_PROVENANCE_SCHEMA_VERSION,
  PUBLIC_ROLLOUT_INTENT_CANARY_SCHEMA_VERSION,
  SIGNED_PUBLIC_ROLLOUT_INTENT_CANARY_SCHEMA_VERSION,
  publicRolloutIntentCanaryKeyFingerprint,
  publicRolloutIntentAssignmentHashV2,
  publicRolloutIntentCanaryAuthorityPolicyHashV1,
} from "../shared/public-rollout-intent-canary.ts";
import {
  createStrictSignedEnvelope,
  signedArtifactSha256,
} from "../shared/signed-artifact.ts";

const keys = generateKeyPairSync("ed25519");
const intentCanaryKeys = generateKeyPairSync("ed25519");
const revision = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const promotionEvidenceHash = "c".repeat(64);
const productionCanaryEvidenceHash = "f".repeat(64);
const priorSitesRevision = "d".repeat(40);
const priorSitesVersion = "2.3.9";
const executorIdentityHash = "9".repeat(64);
const defaultGeneratedAt = new Date().toISOString();
const intentCanarySourceKeySha256 = {
  assignment: "d".repeat(64),
  manifest: "e".repeat(64),
  apple: "f".repeat(64),
  browser: "0".repeat(64),
  metrics: "7".repeat(64),
};
const intentCanaryProducerKeySha256 =
  publicRolloutIntentCanaryKeyFingerprint(intentCanaryKeys.publicKey);
const rolloutEvidenceKeySha256 =
  publicRolloutIntentCanaryKeyFingerprint(keys.publicKey);
const intentCanaryAuthorityPolicyHash =
  publicRolloutIntentCanaryAuthorityPolicyHashV1({
    sourceKeySha256: intentCanarySourceKeySha256,
    producerKeySha256: intentCanaryProducerKeySha256,
    rolloutEvidenceKeySha256,
  });
const releaseConfiguration = {
  apiHash: "1".repeat(64),
  interactiveWorkerHash: "2".repeat(64),
  deepWorkerHash: "3".repeat(64),
  sitesHash: "4".repeat(64),
  secretVersionsHash: "5".repeat(64),
};
const releaseRuntime = {
  releaseEnvironment: "production",
  deploymentPhase: "activate",
  databaseSchemaVersion: "18",
  databaseCapabilityVersion: "2",
  releaseManifestCanaryGuardsVersion: "1",
  canonicalExecutionHardeningVersion: "1",
  workerProtocol: "playlist-pipeline-v10",
  briefContractVersion: "3",
  queryPlanSchemaVersion: "5",
  modelIds: {
    brief: "gpt-5.6-luna",
    baseline: "gpt-5.6-luna",
    escalation: "gpt-5.6-terra",
  },
  policyVersions: {
    guidance: "guidance-v3",
    evidence: "evidence-v3",
    queryPlan: "query-plan-v4",
    selection: "selection-v3",
    semanticScope: "semantic-v3",
    musicConcept: "concept-v3",
    pipeline: "pipeline-v3",
    prompt: "prompt-v3",
  },
};
const promotionConfigurationHash = signedArtifactSha256(releaseConfiguration);
const promotionRuntimeHash = signedArtifactSha256(releaseRuntime);

function configuration(
  percentages: Partial<Record<string, string>> = {},
  approvals: Partial<Record<string, string>> = {},
): PublicRolloutConfiguration {
  return {
    PIPELINE_V2_OWNER_CANARY: "false",
    PIPELINE_V2_CURATED_PERCENT: "0",
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
    PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED: "false",
    PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED: "false",
    RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
    RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
    RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
    PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "5",
    GUIDANCE_CONTRACT_V3_ENABLED: "false",
    GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
    GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "false",
    ...percentages,
    ...approvals,
  } as PublicRolloutConfiguration;
}

function payload(input: {
  operation?: "advance" | "rollback_to_zero";
  intentGroup?: string;
  fromPercent?: string;
  toPercent?: string;
  current?: PublicRolloutConfiguration;
  target?: PublicRolloutConfiguration;
  previousRolloutEvidenceHash?: string | null;
  previousRolloutStage?: string | null;
  rollbackWarrantHash?: string | null;
  intentCanaryHash?: string;
  generatedAt?: string;
  soakDurationSeconds?: number;
  runtimeConfiguration?: typeof releaseConfiguration;
  overrides?: Record<string, unknown>;
} = {}) {
  const generatedAt = input.generatedAt ?? defaultGeneratedAt;
  const soakDurationSeconds = input.soakDurationSeconds ?? 60;
  const soakCompletedAt = new Date(Date.parse(generatedAt) - 10_000).toISOString();
  const soakStartedAt = new Date(
    Date.parse(soakCompletedAt) - soakDurationSeconds * 1_000,
  ).toISOString();
  const previousRolloutEvidenceHash =
    input.previousRolloutEvidenceHash ?? null;
  const previousRolloutStage = input.previousRolloutStage
    ?? (previousRolloutEvidenceHash ? "genre_scene:0->1" : null);
  const runtimeConfiguration =
    input.runtimeConfiguration ?? releaseConfiguration;
  const observationAt = (offsetSeconds: number) =>
    new Date(Date.parse(soakStartedAt) + offsetSeconds * 1_000).toISOString();
  const lane = (
    configurationHash: string,
    observedAt: string,
  ) => ({
    status: "healthy",
    protocolVersion: "playlist-pipeline-v10",
    compatibleCapacity: 1,
    eligibleWorkerCount: 1,
    eligibleIdentityCount: 1,
    eligibleRevisions: [revision],
    eligibleConfigurationHashes: [configurationHash],
    lastSeenAt: new Date(Date.parse(observedAt) - 5_000).toISOString(),
  });
  const observation = (observedAt: string) => ({
    observedAt,
    sitesVersion: priorSitesVersion,
    sitesRevision: priorSitesRevision,
    apiVersion: "2.4.0",
    apiRevision: revision,
    apiConfigurationHash: runtimeConfiguration.apiHash,
    publicRolloutEvidenceHash: previousRolloutEvidenceHash,
    publicRolloutStage: previousRolloutStage,
    systemHttpStatus: 200,
    systemOk: true,
    activationReady: true,
    database: "ready",
    databaseCapabilityVersion: "2",
    releaseManifestCanaryGuardsVersion: "1",
    canonicalExecutionHardeningVersion: "1",
    paused: false,
    workerProtocolExpected: "playlist-pipeline-v10",
    workerProtocolActual: "playlist-pipeline-v10",
    interactiveWorker: lane(
      runtimeConfiguration.interactiveWorkerHash,
      observedAt,
    ),
    deepWorker: lane(runtimeConfiguration.deepWorkerHash, observedAt),
  });
  const observations = [
    observation(observationAt(0)),
    observation(observationAt(soakDurationSeconds / 2)),
    observation(observationAt(soakDurationSeconds)),
  ];
  const current = input.current ?? configuration();
  const target = input.target ?? configuration({
    PIPELINE_V3_GENRE_SCENE_PERCENT: "1",
  });
  const operation = input.operation ?? "advance";
  const intentCanary = operation === "advance"
    ? intentCanaryEnvelope(input)
    : null;
  return {
    schemaVersion: PUBLIC_ROLLOUT_EVIDENCE_SCHEMA_VERSION,
    generatedAt,
    expiresAt: new Date(Date.parse(generatedAt) + 60 * 60_000).toISOString(),
    environment: "production",
    candidate: {
      tag: "v2.4.0-rc.2",
      version: "2.4.0",
      sourceRevision: revision,
      imageDigest,
      promotionEvidenceHash,
    },
    promotion: {
      configurationHash: promotionConfigurationHash,
      runtimeHash: promotionRuntimeHash,
      productionCanaryEvidenceHash,
      sitesVersion: priorSitesVersion,
      sitesRevision: priorSitesRevision,
      sitesCandidateMatched: false,
      databaseSchemaVersion: "18",
      databaseCapabilityVersion: "2",
      releaseManifestCanaryGuardsVersion: "1",
      canonicalExecutionHardeningVersion: "1",
      workerProtocol: "playlist-pipeline-v10",
    },
    transition: {
      operation,
      intentGroup: input.intentGroup ?? "genre_scene",
      fromPercent: input.fromPercent ?? "0",
      toPercent: input.toPercent ?? "1",
      currentPercentages: publicRolloutPercentages(current),
      previousRolloutEvidenceHash,
      previousRolloutStage,
      rollbackWarrantHash: input.rollbackWarrantHash ?? null,
      intentCanaryHash:
        intentCanary?.payloadHash
        ?? input.intentCanaryHash
        ?? "8".repeat(64),
      preserveInFlightRoute: true,
      rollbackPercent: "0",
    },
    soak: {
      runtimeSnapshot: {
        configuration: runtimeConfiguration,
        runtime: releaseRuntime,
        configurationHash: signedArtifactSha256(runtimeConfiguration),
        runtimeHash: promotionRuntimeHash,
      },
      startedAt: soakStartedAt,
      completedAt: soakCompletedAt,
      durationSeconds: soakDurationSeconds,
      healthySampleCount: observations.length,
      observationsHash: signedArtifactSha256(observations),
      observations,
      eligibleOldWorkerCount: 0,
      intentStageMetrics: operation === "advance"
        ? {
            windowStartedAt:
              intentCanary!.payload.stageMetrics.windowStartedAt,
            windowCompletedAt:
              intentCanary!.payload.stageMetrics.windowCompletedAt,
            candidateAssignedCount:
              intentCanary!.payload.stageMetrics.candidateAssignedCount,
            exactCompletionCount:
              intentCanary!.payload.stageMetrics.exactCompletionCount,
          }
        : null,
    },
    targetConfiguration: target,
    targetConfigurationHash: signedArtifactSha256(target),
    ...input.overrides,
  };
}

function intentCanaryEnvelope(
  input: Parameters<typeof payload>[0] = {},
) {
  const generatedAt = input.generatedAt ?? defaultGeneratedAt;
  const soakDurationSeconds = input.soakDurationSeconds ?? 60;
  const rolloutSoakCompletedAt =
    new Date(Date.parse(generatedAt) - 10_000).toISOString();
  const rolloutSoakStartedAt = new Date(
    Date.parse(rolloutSoakCompletedAt) - soakDurationSeconds * 1_000,
  ).toISOString();
  const canaryGeneratedAt = new Date(
    Date.parse(rolloutSoakStartedAt) - 1_000,
  ).toISOString();
  const intentGroup = (input.intentGroup ?? "genre_scene") as
    keyof typeof PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURES;
  const fromPercent = (input.fromPercent ?? "0") as "0" | "1" | "10" | "50";
  const toPercent = (input.toPercent ?? "1") as "1" | "10" | "50" | "100";
  const fixture = PUBLIC_ROLLOUT_INTENT_CANARY_FIXTURES[intentGroup];
  const target = input.target ?? configuration({
    PIPELINE_V3_GENRE_SCENE_PERCENT: "1",
  });
  const targetConfigurationHash = signedArtifactSha256(target);
  const runtimeConfiguration =
    input.runtimeConfiguration ?? releaseConfiguration;
  const fixtureHash = fixture.fixtureHash;
  const contractSemanticHash = "1".repeat(64);
  const candidateAssignedCount = fromPercent === "0"
    ? 0
    : fromPercent === "1"
      ? 20
      : fromPercent === "10"
        ? 100
        : 500;
  const controlAssignedCount = fromPercent === "0"
    ? 0
    : fromPercent === "1"
      ? 1_980
      : fromPercent === "10"
        ? 900
        : 500;
  const stageMetrics = {
    windowStartedAt: new Date(
      Date.parse(canaryGeneratedAt) - 120_000,
    ).toISOString(),
    windowCompletedAt: new Date(
      Date.parse(canaryGeneratedAt) - 1_000,
    ).toISOString(),
    intentGroup,
    stagePercent: fromPercent,
    eligibleSubmissionCount: candidateAssignedCount + controlAssignedCount,
    sharedProviderIncidentCount: 0,
    candidateAssignedCount,
    controlAssignedCount,
    exactCompletionCount: candidateAssignedCount,
    actionableDecisionCount: 0,
    visibleRetryStateCount: 0,
    cancelledCount: 0,
    technicalQuarantineCount: 0,
    controlExactCompletionCount: controlAssignedCount,
    controlActionableDecisionCount: 0,
    controlVisibleRetryStateCount: 0,
    controlCancelledCount: 0,
    controlTechnicalQuarantineCount: 0,
    unexplainedDeadEndCount: 0,
    countOrderViolationCount: 0,
    hardConstraintViolationCount: 0,
    stalePublicationCount: 0,
    providerScarcityMislabelCount: 0,
    controlExactCompletionRate: controlAssignedCount === 0 ? 0 : 1,
    candidateExactCompletionRate: candidateAssignedCount === 0 ? 0 : 1,
  };
  const unsignedProvenance = {
    schemaVersion: PUBLIC_ROLLOUT_INTENT_CANARY_PROVENANCE_SCHEMA_VERSION,
    producerKind: "protected_exact_source_derivation",
    sourcePayloadHashes: {
      assignment: "a".repeat(64),
      manifest: "b".repeat(64),
      apple: "5".repeat(64),
      browser: "6".repeat(64),
      metrics: "c".repeat(64),
    },
    sourceKeySha256: intentCanarySourceKeySha256,
    producerKeySha256: intentCanaryProducerKeySha256,
    rolloutEvidenceKeySha256,
    authorityPolicyHash: intentCanaryAuthorityPolicyHash,
  };
  return createStrictSignedEnvelope({
    envelopeSchemaVersion:
      SIGNED_PUBLIC_ROLLOUT_INTENT_CANARY_SCHEMA_VERSION,
    payload: {
      schemaVersion: PUBLIC_ROLLOUT_INTENT_CANARY_SCHEMA_VERSION,
      generatedAt: canaryGeneratedAt,
      expiresAt: new Date(
        Date.parse(canaryGeneratedAt) + 60 * 60_000,
      ).toISOString(),
      environment: "production",
      candidate: {
        tag: "v2.4.0-rc.2",
        version: "2.4.0",
        sourceRevision: revision,
        imageDigest,
        apiConfigurationHash: runtimeConfiguration.apiHash,
        executorIdentityHash,
      },
      transition: {
        operation: "advance",
        intentGroup,
        fromPercent,
        toPercent,
        targetConfigurationHash,
        assignmentRoute: "owner_candidate",
        assignmentHash: publicRolloutIntentAssignmentHashV2({
          sourceRevision: revision,
          imageDigest,
          apiConfigurationHash: runtimeConfiguration.apiHash,
          executorIdentityHash,
          intentGroup,
          fromPercent,
          toPercent,
          targetConfigurationHash,
          fixtureHash,
          contractSemanticHash,
        }),
      },
      fixture: {
        fixtureId: fixture.fixtureId,
        fixtureHash,
        targetTrackCount: fixture.targetTrackCount,
        contractSemanticHash,
      },
      execution: {
        completedAt: new Date(
          Date.parse(canaryGeneratedAt) - 500,
        ).toISOString(),
        outcome: "exact_ready",
        requestedTrackCount: fixture.targetTrackCount,
        selectedTrackCount: fixture.targetTrackCount,
        contractSemanticHash,
        guidanceLineageHash: intentGroup === "genre_scene"
          ? "2".repeat(64)
          : null,
        manifestContentHash: "3".repeat(64),
        orderedAppleIdsHash: "4".repeat(64),
        independentAppleEvidenceHash: "5".repeat(64),
        browserEvidenceHash: "6".repeat(64),
        workerRevision: revision,
        workerConfigurationHash: runtimeConfiguration.apiHash,
        workerIdentityHash: executorIdentityHash,
        qualityScores: {
          relevance: 4,
          discoveryQuality: 4,
          coherence: 4,
          sequencing: 4,
        },
      },
      stageMetrics,
      provenance: {
        ...unsignedProvenance,
        derivationHash: signedArtifactSha256(unsignedProvenance),
      },
    },
    signingKey: intentCanaryKeys.privateKey,
    keyId: "public-rollout-intent-canary-test-v1",
  });
}

function signed(input: Parameters<typeof payload>[0] = {}) {
  return createStrictSignedEnvelope({
    envelopeSchemaVersion: SIGNED_PUBLIC_ROLLOUT_EVIDENCE_SCHEMA_VERSION,
    payload: payload(input),
    signingKey: keys.privateKey,
    keyId: "public-rollout-test-v1",
  });
}

function options(
  overrides: Record<string, unknown> = {},
  evidenceInput: Parameters<typeof payload>[0] | null = {},
) {
  const includesIntentCanary =
    evidenceInput !== null || Object.hasOwn(overrides, "intentCanary");
  return {
    expectedTag: "v2.4.0-rc.2",
    expectedVersion: "2.4.0",
    expectedRevision: revision,
    expectedImageDigest: imageDigest,
    expectedPromotionEvidenceHash: promotionEvidenceHash,
    expectedPromotionConfigurationHash: promotionConfigurationHash,
    expectedPromotionRuntimeHash: promotionRuntimeHash,
    expectedProductionCanaryEvidenceHash: productionCanaryEvidenceHash,
    expectedOwnerCanaryGroups: "genre_scene",
    expectedOwnerCanaryMaximumTracks: "50",
    minimumSoakStartedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...(evidenceInput === null
      ? {}
      : { intentCanary: intentCanaryEnvelope(evidenceInput) }),
    ...(includesIntentCanary
      ? {
        intentCanaryVerificationKey: intentCanaryKeys.publicKey,
        intentCanaryTrust: {
          producerKeyId: "public-rollout-intent-canary-test-v1",
          producerKeySha256:
            publicRolloutIntentCanaryKeyFingerprint(intentCanaryKeys.publicKey),
        },
        intentCanaryAuthorityPolicyHash,
      }
      : {}),
    ...overrides,
  };
}

describe("signed public cohort rollout evidence", () => {
  test("derives the exact first 1% intent cohort from signed promotion and canary evidence", () => {
    const verified = verifyPublicRolloutEvidence(
      signed(),
      keys.publicKey,
      options(),
    );
    expect(verified).toMatchObject({
      operation: "advance",
      intentGroup: "genre_scene",
      fromPercent: "0",
      toPercent: "1",
      previousRolloutEvidenceHash: null,
      targetConfiguration: {
        PIPELINE_V2_CURATED_PERCENT: "0",
        PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED: "true",
        PIPELINE_V3_GENRE_SCENE_PERCENT: "1",
        PIPELINE_V3_MOOD_ACTIVITY_PERCENT: "0",
        PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "5",
      },
      soak: {
        durationSeconds: 60,
        healthySampleCount: 3,
      },
    });
  });

  test("rejects a missing, cross-intent, wrong-stage, or stale-configuration intent canary", () => {
    const evidence = signed();
    expect(() => verifyPublicRolloutEvidence(
      evidence,
      keys.publicKey,
      options({}, null),
    )).toThrow(/protected-producer intent canary/u);
    const validCanary = intentCanaryEnvelope();
    const selfAuthoredCanary = createStrictSignedEnvelope({
      envelopeSchemaVersion:
        SIGNED_PUBLIC_ROLLOUT_INTENT_CANARY_SCHEMA_VERSION,
      payload: validCanary.payload,
      signingKey: keys.privateKey,
      keyId: "public-rollout-test-v1",
    });
    expect(() => verifyPublicRolloutEvidence(
      evidence,
      keys.publicKey,
      options({
        intentCanary: selfAuthoredCanary,
        intentCanaryVerificationKey: keys.publicKey,
      }, null),
    )).toThrow(/not signed by the protected producer/u);
    const wrongRolloutKeys = generateKeyPairSync("ed25519");
    const validProvenance =
      validCanary.payload.provenance as Record<string, unknown>;
    const unsignedWrongRolloutProvenance: Record<string, unknown> = {
      ...validProvenance,
      rolloutEvidenceKeySha256:
        publicRolloutIntentCanaryKeyFingerprint(wrongRolloutKeys.publicKey),
      authorityPolicyHash:
        publicRolloutIntentCanaryAuthorityPolicyHashV1({
          sourceKeySha256: intentCanarySourceKeySha256,
          producerKeySha256: intentCanaryProducerKeySha256,
          rolloutEvidenceKeySha256:
            publicRolloutIntentCanaryKeyFingerprint(
              wrongRolloutKeys.publicKey,
            ),
        }),
    };
    delete unsignedWrongRolloutProvenance.derivationHash;
    const wrongRolloutCanary = createStrictSignedEnvelope({
      envelopeSchemaVersion:
        SIGNED_PUBLIC_ROLLOUT_INTENT_CANARY_SCHEMA_VERSION,
      payload: {
        ...validCanary.payload,
        provenance: {
          ...unsignedWrongRolloutProvenance,
          derivationHash:
            signedArtifactSha256(unsignedWrongRolloutProvenance),
        },
      },
      signingKey: intentCanaryKeys.privateKey,
      keyId: "public-rollout-intent-canary-test-v1",
    });
    expect(() => verifyPublicRolloutEvidence(
      evidence,
      keys.publicKey,
      options({ intentCanary: wrongRolloutCanary }, null),
    )).toThrow(/exact candidate transition/u);
    expect(() => verifyPublicRolloutEvidence(
      evidence,
      keys.publicKey,
      options({
        intentCanary: intentCanaryEnvelope({
          intentGroup: "similarity",
          target: configuration({
            PIPELINE_V3_SIMILARITY_PERCENT: "1",
          }),
        }),
      }, null),
    )).toThrow(/exact candidate transition/u);
    expect(() => verifyPublicRolloutEvidence(
      evidence,
      keys.publicKey,
      options({
        intentCanary: intentCanaryEnvelope({
          fromPercent: "1",
          toPercent: "10",
          target: configuration({
            PIPELINE_V3_GENRE_SCENE_PERCENT: "10",
          }),
        }),
      }, null),
    )).toThrow(/exact candidate transition/u);
    expect(() => verifyPublicRolloutEvidence(
      evidence,
      keys.publicKey,
      options({
        intentCanary: intentCanaryEnvelope({
          runtimeConfiguration: {
            ...releaseConfiguration,
            apiHash: "0".repeat(64),
          },
        }),
      }, null),
    )).toThrow(/exact candidate transition/u);
  });

  test("requires the adjacent ladder and an immediate signed target for later steps", () => {
    expect(() => verifyPublicRolloutEvidence(
      signed({
        toPercent: "10",
        target: configuration({ PIPELINE_V3_GENRE_SCENE_PERCENT: "10" }),
      }),
      keys.publicKey,
      options(),
    )).toThrow(/owner→1%→10%→50%→100%/u);

    const previousHash = "2".repeat(64);
    const current = configuration({ PIPELINE_V3_GENRE_SCENE_PERCENT: "1" });
    const target = configuration({ PIPELINE_V3_GENRE_SCENE_PERCENT: "10" });
    expect(verifyPublicRolloutEvidence(
      signed({
        fromPercent: "1",
        toPercent: "10",
        current,
        target,
        previousRolloutEvidenceHash: previousHash,
      }),
      keys.publicKey,
      options({
        expectedPreviousRolloutEvidenceHash: previousHash,
        expectedPreviousTargetPercentages: publicRolloutPercentages(current),
      }, {
        fromPercent: "1",
        toPercent: "10",
        target,
      }),
    )).toMatchObject({ fromPercent: "1", toPercent: "10" });
    expect(() => verifyPublicRolloutEvidence(
      signed({
        fromPercent: "1",
        toPercent: "10",
        current,
        target,
        previousRolloutEvidenceHash: previousHash,
      }),
      keys.publicKey,
      options({
        expectedPreviousRolloutEvidenceHash: "3".repeat(64),
        expectedPreviousTargetPercentages: publicRolloutPercentages(current),
      }, {
        fromPercent: "1",
        toPercent: "10",
        target,
      }),
    )).toThrow(/immediately previous rollout/u);
  });

  test("allows a signed affected-cohort rollback directly to zero", () => {
    const beforeAdvance = configuration({
      PIPELINE_V3_GENRE_SCENE_PERCENT: "10",
      PIPELINE_V3_MOOD_ACTIVITY_PERCENT: "10",
    });
    const current = configuration({
      PIPELINE_V3_GENRE_SCENE_PERCENT: "50",
      PIPELINE_V3_MOOD_ACTIVITY_PERCENT: "10",
    });
    const target = configuration({
      PIPELINE_V3_GENRE_SCENE_PERCENT: "0",
      PIPELINE_V3_MOOD_ACTIVITY_PERCENT: "10",
    });
    const postAdvanceConfiguration = {
      ...releaseConfiguration,
      apiHash: "6".repeat(64),
      interactiveWorkerHash: "7".repeat(64),
      deepWorkerHash: "8".repeat(64),
    };
    const advance = verifyPublicRolloutEvidence(
      signed({
        fromPercent: "10",
        toPercent: "50",
        current: beforeAdvance,
        target: current,
        previousRolloutEvidenceHash: "3".repeat(64),
        previousRolloutStage: "genre_scene:1->10",
      }),
      keys.publicKey,
      options({
        expectedPreviousRolloutEvidenceHash: "3".repeat(64),
      }, {
        fromPercent: "10",
        toPercent: "50",
        target: current,
      }),
    );
    const warrant = createStrictSignedEnvelope({
      envelopeSchemaVersion:
        SIGNED_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_SCHEMA_VERSION,
      payload: buildPublicRolloutRollbackWarrantPayload({
        advance,
        candidate: {
          tag: "v2.4.0-rc.2",
          version: "2.4.0",
          sourceRevision: revision,
          imageDigest,
        },
        promotion: {
          configurationHash: promotionConfigurationHash,
          runtimeHash: promotionRuntimeHash,
          productionCanaryEvidenceHash,
          sitesVersion: priorSitesVersion,
          sitesRevision: priorSitesRevision,
        },
      }),
      signingKey: keys.privateKey,
      keyId: "public-rollout-test-v1",
    });
    const rollbackEnvelope = signed({
      operation: "rollback_to_zero",
      fromPercent: "50",
      toPercent: "0",
      current,
      target,
      previousRolloutEvidenceHash: advance.payloadHash,
      previousRolloutStage: "genre_scene:10->50",
      rollbackWarrantHash: warrant.payloadHash,
      intentCanaryHash: advance.intentCanaryHash,
      runtimeConfiguration: postAdvanceConfiguration,
    });
    expect(() => verifyPublicRolloutEvidence(
      rollbackEnvelope,
      keys.publicKey,
      options(
        { expectedPreviousRolloutEvidenceHash: advance.payloadHash },
        null,
      ),
    )).toThrow(/durable signed rollback warrant/u);
    const warrantPayload =
      warrant.payload as Record<string, unknown>;
    const wrongCandidateWarrant = createStrictSignedEnvelope({
      envelopeSchemaVersion:
        SIGNED_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_SCHEMA_VERSION,
      payload: {
        ...warrantPayload,
        candidate: {
          ...(warrantPayload.candidate as Record<string, unknown>),
          imageDigest: `sha256:${"9".repeat(64)}`,
        },
      },
      signingKey: keys.privateKey,
      keyId: "public-rollout-test-v1",
    });
    expect(() => verifyPublicRolloutEvidence(
      rollbackEnvelope,
      keys.publicKey,
      options({
        expectedPreviousRolloutEvidenceHash: advance.payloadHash,
        rollbackWarrant: wrongCandidateWarrant,
      }, null),
    )).toThrow(/exact candidate, promotion, canaries, and prior Sites/u);
    const overbroadTarget = configuration({
      PIPELINE_V3_GENRE_SCENE_PERCENT: "0",
      PIPELINE_V3_MOOD_ACTIVITY_PERCENT: "0",
    });
    const rollbackWarrantPayload =
      warrantPayload.rollback as Record<string, unknown>;
    const overbroadWarrant = createStrictSignedEnvelope({
      envelopeSchemaVersion:
        SIGNED_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_SCHEMA_VERSION,
      payload: {
        ...warrantPayload,
        rollback: {
          ...rollbackWarrantPayload,
          targetConfiguration: overbroadTarget,
          targetConfigurationHash: signedArtifactSha256(overbroadTarget),
        },
      },
      signingKey: keys.privateKey,
      keyId: "public-rollout-test-v1",
    });
    expect(() => verifyPublicRolloutRollbackWarrant(
      overbroadWarrant,
      keys.publicKey,
      {
        expectedTag: "v2.4.0-rc.2",
        expectedVersion: "2.4.0",
        expectedRevision: revision,
        expectedImageDigest: imageDigest,
        expectedPromotionEvidenceHash: promotionEvidenceHash,
        expectedPromotionConfigurationHash: promotionConfigurationHash,
        expectedPromotionRuntimeHash: promotionRuntimeHash,
        expectedProductionCanaryEvidenceHash: productionCanaryEvidenceHash,
        expectedSitesVersion: priorSitesVersion,
        expectedSitesRevision: priorSitesRevision,
        expectedAdvance: advance,
      },
    )).toThrow(/zero only its affected intent/u);
    expect(verifyPublicRolloutEvidence(
      rollbackEnvelope,
      keys.publicKey,
      options({
        expectedPreviousRolloutEvidenceHash: advance.payloadHash,
        rollbackWarrant: warrant,
      }, null),
    )).toMatchObject({
      operation: "rollback_to_zero",
      intentGroup: "genre_scene",
      toPercent: "0",
    });
    expect(() => verifyPublicRolloutEvidence(
      rollbackEnvelope,
      keys.publicKey,
      options({
        expectedPreviousRolloutEvidenceHash: advance.payloadHash,
        rollbackWarrant: warrant,
        intentCanary: intentCanaryEnvelope(),
      }, null),
    )).toThrow(/rollback must not consume a fresh intent canary/u);
    expect(verifyPublicRolloutRollbackWarrant(
      warrant,
      keys.publicKey,
      {
        expectedTag: "v2.4.0-rc.2",
        expectedVersion: "2.4.0",
        expectedRevision: revision,
        expectedImageDigest: imageDigest,
        expectedPromotionEvidenceHash: promotionEvidenceHash,
        expectedPromotionConfigurationHash: promotionConfigurationHash,
        expectedPromotionRuntimeHash: promotionRuntimeHash,
        expectedProductionCanaryEvidenceHash: productionCanaryEvidenceHash,
        expectedSitesVersion: priorSitesVersion,
        expectedSitesRevision: priorSitesRevision,
        expectedAdvance: advance,
        now: new Date(
          Date.parse(advance.generatedAt) + 30 * 24 * 60 * 60_000,
        ).toISOString(),
      },
    )).toMatchObject({
      payloadHash: warrant.payloadHash,
      rollback: { fromPercent: "50", toPercent: "0" },
    });
  });

  test("rejects multi-intent mutation, missing governed approval, and arbitrary literals", () => {
    expect(() => verifyPublicRolloutEvidence(
      signed({
        target: configuration({
          PIPELINE_V3_GENRE_SCENE_PERCENT: "1",
          PIPELINE_V3_SIMILARITY_PERCENT: "1",
        }),
      }),
      keys.publicKey,
      options(),
    )).toThrow(/exactly one signed intent cohort/u);
    expect(() => verifyPublicRolloutEvidence(
      signed({
        target: configuration(
          { PIPELINE_V3_GENRE_SCENE_PERCENT: "1" },
          { PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED: "false" },
        ),
      }),
      keys.publicKey,
      options(),
    )).toThrow(/genre-scene evidence approval/u);
    expect(() => verifyPublicRolloutEvidence(
      signed({
        target: configuration(
          { PIPELINE_V3_GENRE_SCENE_PERCENT: "1" },
          { PIPELINE_V2_CURATED_PERCENT: "1" },
        ),
      }),
      keys.publicKey,
      options(),
    )).toThrow(/PIPELINE_V2_CURATED_PERCENT=0/u);
  });

  test("requires an elapsed post-canary soak and rejects stale or mismatched proof", () => {
    expect(() => verifyPublicRolloutEvidence(
      signed({ soakDurationSeconds: 30 }),
      keys.publicKey,
      options(),
    )).toThrow(/at least 60 elapsed seconds/u);
    expect(() => verifyPublicRolloutEvidence(
      signed(),
      keys.publicKey,
      options({ minimumSoakStartedAt: new Date(Date.now() - 10_000).toISOString() }),
    )).toThrow(/predates the production canaries/u);
    const expiredGeneratedAt =
      new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    expect(() => verifyPublicRolloutEvidence(
      signed({
        generatedAt: expiredGeneratedAt,
        overrides: {
          expiresAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        },
      }),
      keys.publicKey,
      options(
        { minimumSoakStartedAt: undefined },
        { generatedAt: expiredGeneratedAt },
      ),
    )).toThrow(/not fresh|expired/u);
    expect(() => verifyPublicRolloutEvidence(
      signed(),
      keys.publicKey,
      options({ expectedPromotionRuntimeHash: "9".repeat(64) }),
    )).toThrow(/configuration, runtime, and canaries/u);
  });

  test("requires explicit composite capability 2 and both promotion markers", () => {
    const validPromotion = payload().promotion;
    for (const [field, expected] of [
      ["databaseCapabilityVersion", "2"],
      ["releaseManifestCanaryGuardsVersion", "1"],
      ["canonicalExecutionHardeningVersion", "1"],
    ] as const) {
      expect(() => verifyPublicRolloutEvidence(
        signed({
          overrides: {
            promotion: {
              ...validPromotion,
              [field]: "unexpected",
            },
          },
        }),
        keys.publicKey,
        options(),
      )).toThrow(/composite capability 2, both authoritative marker-1 values/u);
      expect(() => verifyPublicRolloutEvidence(
        signed({
          overrides: {
            promotion: Object.fromEntries(
              Object.entries(validPromotion).filter(([key]) => key !== field),
            ),
          },
        }),
        keys.publicKey,
        options(),
      )).toThrow(/public rollout promotion contains missing or unapproved fields/u);
      expect(validPromotion[field]).toBe(expected);
    }
  });

  test("accepts expiry only for a historical predecessor, never a current advance", () => {
    const generatedAt = new Date(Date.now() - 26 * 60 * 60_000).toISOString();
    const historical = signed({
      generatedAt,
      overrides: {
        expiresAt: new Date(
          Date.parse(generatedAt) + 60 * 60_000,
        ).toISOString(),
      },
    });
    expect(verifyPreviousPublicRolloutLineage(
      historical,
      keys.publicKey,
      {
        expectedTag: "v2.4.0-rc.2",
        expectedVersion: "2.4.0",
        expectedRevision: revision,
        expectedImageDigest: imageDigest,
        expectedOwnerCanaryGroups: "genre_scene",
        expectedOwnerCanaryMaximumTracks: "50",
      },
    )).toMatchObject({ fromPercent: "0", toPercent: "1" });
    expect(() => verifyPublicRolloutEvidence(
      historical,
      keys.publicKey,
      options(
        { minimumSoakStartedAt: undefined },
        { generatedAt },
      ),
    )).toThrow(/not fresh|expired/u);
  });

  test("rejects tampering, unknown fields, and a changed owner route", () => {
    const envelope = signed();
    envelope.payload.targetConfiguration.PIPELINE_V3_GENRE_SCENE_PERCENT = "10";
    expect(() => verifyPublicRolloutEvidence(
      envelope,
      keys.publicKey,
      options(),
    )).toThrow(/exactly one signed intent cohort/u);
    expect(() => verifyPublicRolloutEvidence(
      signed({ overrides: { rawPrompt: "must never appear in release evidence" } }),
      keys.publicKey,
      options(),
    )).toThrow(/unapproved fields/u);
    expect(() => verifyPublicRolloutEvidence(
      signed(),
      keys.publicKey,
      options({ expectedOwnerCanaryGroups: "similarity" }),
    )).toThrow(/owner candidate route/u);
  });

  test("finalization requires a fresh completed 100% rollout while prior Sites stayed live", () => {
    const current = configuration({ PIPELINE_V3_GENRE_SCENE_PERCENT: "50" });
    const target = configuration({ PIPELINE_V3_GENRE_SCENE_PERCENT: "100" });
    const complete = signed({
      fromPercent: "50",
      toPercent: "100",
      current,
      target,
      previousRolloutEvidenceHash: "7".repeat(64),
    });
    const verification = verifyPublicRolloutFinalizationLineage(
      complete,
      keys.publicKey,
      {
        expectedTag: "v2.4.0-rc.2",
        expectedVersion: "2.4.0",
        expectedRevision: revision,
        expectedImageDigest: imageDigest,
        expectedPromotionEvidenceHash: promotionEvidenceHash,
        expectedPromotionConfigurationHash: promotionConfigurationHash,
        expectedPromotionRuntimeHash: promotionRuntimeHash,
        expectedProductionCanaryEvidenceHash: productionCanaryEvidenceHash,
        expectedSitesVersion: priorSitesVersion,
        expectedSitesRevision: priorSitesRevision,
        minimumSoakStartedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
    );
    expect(verification).toMatchObject({
      operation: "advance",
      fromPercent: "50",
      toPercent: "100",
    });
    expect(() => verifyPublicRolloutFinalizationLineage(
      signed(),
      keys.publicKey,
      {
        expectedTag: "v2.4.0-rc.2",
        expectedVersion: "2.4.0",
        expectedRevision: revision,
        expectedImageDigest: imageDigest,
        expectedPromotionEvidenceHash: promotionEvidenceHash,
        expectedPromotionConfigurationHash: promotionConfigurationHash,
        expectedPromotionRuntimeHash: promotionRuntimeHash,
        expectedProductionCanaryEvidenceHash: productionCanaryEvidenceHash,
        expectedSitesVersion: priorSitesVersion,
        expectedSitesRevision: priorSitesRevision,
        minimumSoakStartedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
    )).toThrow(/completed signed backend cohort rollout to 100%/u);
  });
});
