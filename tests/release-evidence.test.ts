import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  attestSemanticRankingReviewV1,
  evaluateSemanticRankingReviewV1,
  semanticRankingBlindMappingSha256,
  semanticRankingBlindedPackageSha256,
  semanticRankingProtectedBaselineMetadataSha256,
  semanticRankingReviewBaselineIdentityV2,
  semanticRankingReviewerTrustPolicyV1,
  semanticRankingReviewerVerificationKeyV1,
} from "../lib/semantic-ranking-review.ts";
import {
  SIGNED_STAGING_CONTROL_PLANE_EVIDENCE_SCHEMA_V1,
  STAGING_CONTROL_PLANE_EVIDENCE_SCHEMA_V1,
  STAGING_CONTROL_PLANE_ISSUER_V1,
  stagingControlPlaneKeyFingerprint,
  stagingControlPlaneTrustPolicyV1,
} from "../shared/staging-control-plane-evidence.ts";
import {
  APPLE_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
  PROVIDER_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
  QA_BUDGET_LEDGER_RECEIPT_SCHEMA_V1,
  SIGNED_APPLE_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
  SIGNED_PROVIDER_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
  SIGNED_QA_BUDGET_LEDGER_RECEIPT_SCHEMA_V1,
  controlPlaneReceiptKeyFingerprint,
  controlPlaneReceiptTrustPolicyV1,
} from "../shared/staging-control-plane-receipts.ts";
import {
  createStrictSignedEnvelope,
  signedArtifactSha256,
} from "../shared/signed-artifact.ts";
import { semanticBehaviorHashV1 } from "../shared/semantic-release-evidence.ts";
import {
  PUBLIC_ROLLOUT_EVIDENCE_SCHEMA_VERSION,
  SIGNED_PUBLIC_ROLLOUT_EVIDENCE_SCHEMA_VERSION,
  publicRolloutPercentages,
  publicRolloutProductionCanaryEvidenceHash,
  type PublicRolloutConfiguration,
} from "../shared/public-rollout-evidence.ts";
import {
  createSitesProductionRollbackTargetV1,
} from "../shared/sites-production-rollback.ts";
import {
  sitesControlPlaneKeyFingerprint,
  sitesControlPlaneTrustPolicyV1,
  sitesControlPlaneVerificationKeyV1,
} from "../shared/sites-control-plane-attestation.ts";
import {
  frenchJazzGuidanceDecisionV3,
  smoothReggaetonHeatGuidanceDecisionV3,
} from "../server/adaptive-guidance-v3.ts";
import { publicGuidanceQuestionV3 } from "../server/adaptive-guidance-contract-bridge.ts";
import { compilePlaylistContractRevisionV1 } from "../server/playlist-contract-v1.ts";
import {
  RELEASE_EVIDENCE_TTL_MS,
  assertFinalizationBrowserPublicRolloutBindingV1,
  assertFinalizationRuntimePublicRolloutBindingV1,
  loadReleaseEvidenceSigningBundle,
  releaseEvidenceConfigurationHash,
  releaseGateProducerKeyFingerprint,
  releaseGateProducerTrustPolicyV1,
  releaseEvidenceRuntimeHash,
  signReleaseEvidenceBundle,
  stableReleaseEvidenceJson,
  validateReleaseEvidencePayload,
  verifyReleaseEvidence,
  type GithubOfflineEvidenceVerifier,
} from "../scripts/release-evidence.ts";
import {
  RELEASE_ATTESTATION_PREDICATE_TYPE,
  RELEASE_ATTESTATION_REPOSITORY,
  RELEASE_ATTESTATION_SOURCE_REF,
  RELEASE_ATTESTATION_WORKFLOW,
  validateGithubOfflineAttestationBinding,
} from "../scripts/github-offline-attestation.ts";
import {
  SIGNED_STABLE_RELEASE_AUTHORIZATION_SCHEMA_V1,
  STABLE_RELEASE_FINALIZATION_SOURCE_BUNDLE_SCHEMA_V2,
  STABLE_RELEASE_AUTHORIZATION_ISSUER_V1,
  STABLE_RELEASE_AUTHORIZATION_SCHEMA_V1,
  authorizeStableRelease,
  parseStableReleaseAuthorizationArgs,
  stableReleaseKeyFingerprint,
  stableReleaseVerificationKeyV1,
  verifyHistoricalStableReleaseConsumerBundle,
  verifyStableReleaseAuthorization,
  verifyStableReleaseConsumerBundle,
} from "../scripts/authorize-stable-release.ts";
import {
  buildStableReleaseDispatchRequest,
  GITHUB_CLIENT_PAYLOAD_MAX_BYTES,
  verifyStableReleaseDispatchArtifacts,
} from "../scripts/prepare-stable-release-dispatch.ts";
import {
  buildReleaseConvergenceEvidence,
  type ReleaseConvergenceObservation,
} from "../scripts/verify-release-convergence.ts";
import {
  FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V1,
  RELEASE_GATE_ARTIFACT_SCHEMA_V1,
  attestReleaseGateArtifact,
  createOfflineReleaseGateArtifact,
  createReleaseGateArtifactFromSources,
  createReleaseFixtureExecutionProof,
  releaseFixtureBindingsForGate,
  releaseFixturePrompt,
  validateReleaseFixtureGuidancePayload,
  validateReleaseGateArtifact,
  type ReleaseFixtureId,
  type ReleaseGateName,
} from "../scripts/release-fixtures.ts";
import {
  produceStagingControlPlaneEvidence,
  type RailwayControlPlaneQueryAdapter,
  type StagingControlPlaneEvidenceProducerArgs,
} from "../scripts/staging-control-plane-evidence-producer.ts";

const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const hash = "c".repeat(64);
const generatedAt = "2026-07-23T12:00:00.000Z";
const expiresAt = new Date(Date.parse(generatedAt) + RELEASE_EVIDENCE_TTL_MS).toISOString();
const phaseGeneratedAt = {
  candidate: generatedAt,
  promotion: "2026-07-23T12:10:00.000Z",
  rollout: "2026-07-23T12:25:00.000Z",
  finalization: "2026-07-23T12:40:00.000Z",
} as const;
const phaseExpiresAt = (
  kind: "candidate" | "promotion" | "finalization",
) => new Date(
  Date.parse(phaseGeneratedAt[kind]) + RELEASE_EVIDENCE_TTL_MS,
).toISOString();
const producerKeys = generateKeyPairSync("ed25519");
const historicalReplayKeys = generateKeyPairSync("ed25519");
const reviewerKeys = generateKeyPairSync("ed25519");
const semanticBaselineReleaseKeys = generateKeyPairSync("ed25519");
const semanticBaselineStableAuthorizerKeys =
  generateKeyPairSync("ed25519");
const stagingControlPlaneKeys = generateKeyPairSync("ed25519");
const sitesControlPlaneKeys = generateKeyPairSync("ed25519");
const controlPlaneReceiptKeys = {
  apple: generateKeyPairSync("ed25519"),
  provider: generateKeyPairSync("ed25519"),
  qaBudget: generateKeyPairSync("ed25519"),
};
const semanticBaselineFixtureIds = [
  "fixed-three-track-control-v1",
  "smooth-reggaeton-heat-50-v1",
  "french-jazz-guided-constraint-25-v1",
] as const;
const approvedProducerTrustPolicy = releaseGateProducerTrustPolicyV1({
  approvedKeyId: "test-producer-2026",
  approvedKeySha256:
    releaseGateProducerKeyFingerprint(producerKeys.publicKey),
});
const approvedHistoricalReplayTrustPolicy =
  releaseGateProducerTrustPolicyV1({
    approvedKeyId: "historical-replay-test-v1",
    approvedKeySha256:
      releaseGateProducerKeyFingerprint(historicalReplayKeys.publicKey),
  });
const approvedStagingControlPlaneTrustPolicy =
  stagingControlPlaneTrustPolicyV1({
    approvedKeyId: "staging-control-plane-test-v1",
    approvedKeySha256:
      stagingControlPlaneKeyFingerprint(stagingControlPlaneKeys.publicKey),
  });
const approvedControlPlaneReceiptTrustPolicies = {
  apple: controlPlaneReceiptTrustPolicyV1({
    receiptKind: "apple",
    approvedIssuer: "apple-control-plane-test-v1",
    approvedKeyId: "apple-control-plane-key-test-v1",
    approvedKeySha256:
      controlPlaneReceiptKeyFingerprint(controlPlaneReceiptKeys.apple.publicKey),
  }),
  provider: controlPlaneReceiptTrustPolicyV1({
    receiptKind: "provider",
    approvedIssuer: "provider-control-plane-test-v1",
    approvedKeyId: "provider-control-plane-key-test-v1",
    approvedKeySha256:
      controlPlaneReceiptKeyFingerprint(
        controlPlaneReceiptKeys.provider.publicKey,
      ),
  }),
  qaBudget: controlPlaneReceiptTrustPolicyV1({
    receiptKind: "qa_budget",
    approvedIssuer: "qa-budget-ledger-test-v1",
    approvedKeyId: "qa-budget-ledger-key-test-v1",
    approvedKeySha256:
      controlPlaneReceiptKeyFingerprint(
        controlPlaneReceiptKeys.qaBudget.publicKey,
      ),
  }),
};
const approvedSitesControlPlaneTrustPolicy = sitesControlPlaneTrustPolicyV1({
  approvedKeyId: "sites-control-plane-test-v1",
  approvedKeySha256:
    sitesControlPlaneKeyFingerprint(sitesControlPlaneKeys.publicKey),
});
const semanticBaselineLineageFixture =
  createSemanticBaselineLineageFixture();
const semanticProtectedBaselineMetadata =
  semanticBaselineLineageFixture.protectedBaselineMetadata;
const semanticBaselineMetadataHash =
  semanticBaselineLineageFixture.consumer.protectedBaselineMetadataHash;
const approvedReviewerTrustPolicy = semanticRankingReviewerTrustPolicyV1({
  approvedKeyId: "independent-reviewer-test-v1",
  approvedKeySha256:
    semanticRankingReviewerVerificationKeyV1(reviewerKeys.publicKey).sha256,
  approvedBaselineMetadataSha256: semanticBaselineMetadataHash,
  approvedBaselineStableTag: semanticProtectedBaselineMetadata.stableTag,
  approvedBaselineReleaseKeySha256:
    stableReleaseKeyFingerprint(semanticBaselineReleaseKeys.publicKey),
  approvedBaselineStableAuthorizerKeyId:
    "semantic-baseline-stable-authorizer-test-v1",
  approvedBaselineStableAuthorizerKeySha256:
    stableReleaseKeyFingerprint(
      semanticBaselineStableAuthorizerKeys.publicKey,
    ),
});

function releaseAuthoringAuthority(
  verificationKey: KeyObject,
  bundle: { generatedAt?: unknown },
) {
  return {
    approvedKeyId: "release-2026",
    approvedKeySha256: stableReleaseKeyFingerprint(verificationKey),
    now: String(bundle.generatedAt),
  };
}

const strictGithubOfflineVerifier: GithubOfflineEvidenceVerifier = async ({
  artifactPath,
  bundlePath,
  bindingValue,
}) => {
  const artifactBytes = readFileSync(artifactPath);
  const artifact = validateReleaseGateArtifact(
    JSON.parse(artifactBytes.toString("utf8")),
  );
  const binding = validateGithubOfflineAttestationBinding(
    bindingValue,
    artifact,
  );
  expect(JSON.parse(readFileSync(bundlePath, "utf8"))).toEqual({});
  expect(createHash("sha256").update(artifactBytes).digest("hex"))
    .toBe(binding.artifactSha256);
  return { artifact, binding };
};

function gate(
  name: string,
  environment: "offline" | "staging" | "production",
  configurationHash: string,
  runtimeHash: string,
  completedAt = generatedAt,
) {
  return {
    name,
    environment,
    passed: true,
    completedAt,
    evidenceHash: hash,
    artifactSchemaVersion: RELEASE_GATE_ARTIFACT_SCHEMA_V1,
    configurationHash,
    runtimeHash,
    fixtures: releaseFixtureBindingsForGate(name as ReleaseGateName, {
      "smooth-reggaeton-heat-50-v1": "7".repeat(64),
      "french-jazz-guided-constraint-25-v1": "8".repeat(64),
    }),
    cacheMode: environment === "offline" ? "not_applicable" : "reuse_disabled",
    budgetStatus: environment === "staging" ? "within_cap" : "not_applicable",
  };
}

function sitesObservation(
  kind: "candidate" | "promotion" | "finalization",
  environment: "staging" | "production",
) {
  const candidateMatched = environment === "staging" || kind === "finalization";
  return {
    version: candidateMatched ? "2.4.0" : "2.3.9",
    sourceRevision: candidateMatched ? revision : "f".repeat(40),
    configurationHash: environment === "staging"
      ? "7".repeat(64)
      : "8".repeat(64),
    ownerAllowlistVersion: candidateMatched
      ? "owner-allowlist-v1"
      : "owner-allowlist-v0",
    candidateMatched,
  };
}

function sitesHash(
  observation: ReturnType<typeof sitesObservation>,
): string {
  return sha256({
    buildIdentity: {
      version: observation.version,
      sourceRevision: observation.sourceRevision,
    },
    gatewayConfigurationHash: observation.configurationHash,
  });
}

function payload(
  kind: "candidate" | "promotion" | "finalization" = "candidate",
): any {
  const completedAt = phaseGeneratedAt[kind];
  const evidenceExpiresAt = phaseExpiresAt(kind);
  const sharedConfiguration = {
    apiHash: hash,
    interactiveWorkerHash: hash,
    deepWorkerHash: hash,
  };
  const stagingSitesObservation = sitesObservation(kind, "staging");
  const productionSitesObservation = sitesObservation(kind, "production");
  const stagingConfiguration = {
    ...sharedConfiguration,
    sitesHash: sitesHash(stagingSitesObservation),
    secretVersionsHash: "b".repeat(64),
  };
  const productionConfiguration = {
    ...sharedConfiguration,
    sitesHash: sitesHash(productionSitesObservation),
    secretVersionsHash: hash,
  };
  const configuration = kind === "candidate"
    ? stagingConfiguration
    : productionConfiguration;
  const runtime = {
    semanticExecutionConfigurationHash: "f".repeat(64),
    releaseEnvironment: kind === "candidate" ? "staging" : "production",
    deploymentPhase: "activate",
    databaseSchemaVersion: "19",
    databaseCapabilityVersion: "2",
    releaseManifestCanaryGuardsVersion: "1",
    canonicalExecutionHardeningVersion: "1",
    workerProtocol: "playlist-pipeline-v11",
    briefContractVersion: "3",
    queryPlanSchemaVersion: "6",
    modelIds: {
      brief: "gpt-5.4-mini",
      baseline: "gpt-5.6-luna",
      escalation: "gpt-5.6-terra",
    },
    policyVersions: {
      guidance: "adaptive_guidance_v4",
      evidence: "governed_evidence_v2",
      queryPlan: "query_plan_v3_4",
      selection: "selection_plan_v3",
      semanticScope: "scope_gate_v2_1_2",
      musicConcept: "music_concepts_v3_3_0",
      pipeline: "corpus_first_v3",
      prompt: "grounded_recovery_v3_1_prompt_v1",
    },
  };
  const stagingRuntime = { ...runtime, releaseEnvironment: "staging" };
  const stagingConfigurationHash = releaseEvidenceConfigurationHash({
    configuration: stagingConfiguration,
  });
  const productionConfigurationHash = releaseEvidenceConfigurationHash({
    configuration: productionConfiguration,
  });
  const stagingRuntimeHash = releaseEvidenceRuntimeHash({ runtime: stagingRuntime } as any);
  const productionRuntimeHash = releaseEvidenceRuntimeHash({ runtime } as any);
  const gates = [
    gate("offline_suite", "offline", stagingConfigurationHash, stagingRuntimeHash, completedAt),
    gate("staging_provider_manifest", "staging", stagingConfigurationHash, stagingRuntimeHash, completedAt),
    gate("staging_historical_replay", "staging", stagingConfigurationHash, stagingRuntimeHash, completedAt),
    gate("staging_fixed_three_track", "staging", stagingConfigurationHash, stagingRuntimeHash, completedAt),
    gate("staging_affected_regression", "staging", stagingConfigurationHash, stagingRuntimeHash, completedAt),
    gate("staging_guided_constraint", "staging", stagingConfigurationHash, stagingRuntimeHash, completedAt),
    gate("semantic_ranking_blinded_review", "staging", stagingConfigurationHash, stagingRuntimeHash, completedAt),
  ];
  if (kind === "promotion") {
    gates.splice(
      0,
      gates.length,
      gate("production_fixed_three_track", "production", productionConfigurationHash, productionRuntimeHash, completedAt),
      gate("production_affected_regression", "production", productionConfigurationHash, productionRuntimeHash, completedAt),
      gate("backend_release_convergence", "production", productionConfigurationHash, productionRuntimeHash, completedAt),
    );
  } else if (kind === "finalization") {
    gates.splice(
      0,
      gates.length,
      gate("release_convergence", "production", productionConfigurationHash, productionRuntimeHash, completedAt),
      gate("final_custom_domain_browser", "production", productionConfigurationHash, productionRuntimeHash, completedAt),
    );
  }
  return {
    schemaVersion: "genio-release-evidence/v3",
    kind,
    generatedAt: completedAt,
    expiresAt: evidenceExpiresAt,
    candidate: {
      tag: "v2.4.0-rc.1",
      version: "2.4.0",
      sourceRevision: revision,
      imageDigest: digest,
      sitesSourceRevision: revision,
    },
    lineage: kind === "candidate"
      ? {
          candidateEvidencePayloadHash: null,
          candidateEvidenceGeneratedAt: null,
          promotionEvidencePayloadHash: null,
          promotionEvidenceGeneratedAt: null,
          publicRolloutEvidencePayloadHash: null,
          publicRolloutCompletedAt: null,
          publicRolloutIntentGroup: null,
          publicRolloutFromPercent: null,
          publicRolloutToPercent: null,
          publicRolloutTargetConfigurationHash: null,
        }
      : kind === "promotion"
        ? {
            candidateEvidencePayloadHash: "f".repeat(64),
            candidateEvidenceGeneratedAt: phaseGeneratedAt.candidate,
            promotionEvidencePayloadHash: null,
            promotionEvidenceGeneratedAt: null,
            publicRolloutEvidencePayloadHash: null,
            publicRolloutCompletedAt: null,
            publicRolloutIntentGroup: null,
            publicRolloutFromPercent: null,
            publicRolloutToPercent: null,
            publicRolloutTargetConfigurationHash: null,
          }
        : {
            candidateEvidencePayloadHash: "f".repeat(64),
            candidateEvidenceGeneratedAt: phaseGeneratedAt.candidate,
            promotionEvidencePayloadHash: "e".repeat(64),
            promotionEvidenceGeneratedAt: phaseGeneratedAt.promotion,
            publicRolloutEvidencePayloadHash: "d".repeat(64),
            publicRolloutCompletedAt: "2026-07-23T12:26:00.000Z",
            publicRolloutIntentGroup: "genre_scene",
            publicRolloutFromPercent: "50",
            publicRolloutToPercent: "100",
            publicRolloutTargetConfigurationHash: "4".repeat(64),
          },
    configuration,
    stagingControls: {
      controlPlanePhase: kind,
      candidateEvidencePayloadHash:
        kind === "candidate" ? null : "f".repeat(64),
      candidateSourceRevision: revision,
      candidateImageDigest: digest,
      candidateImageReference: `ghcr.io/hooterjackson/genio@${digest}`,
      monthlyCostLimitUsd: 10,
      budgetRemainingUsd: 6,
      reservedForRequiredGatesUsd: 4,
      budgetStatus: "available",
      musicKitOrigin: "https://staging-9enio.example",
      providerSecretVersionHash: "1".repeat(64),
      productionProviderSecretVersionHash: "2".repeat(64),
      appleSecretVersionHash: "3".repeat(64),
      productionAppleSecretVersionHash: "4".repeat(64),
      appleQaVerifierSecretVersionHash: "d".repeat(64),
      productionAppleQaVerifierSecretVersionHash: "e".repeat(64),
      appleQaVerifierCredentialIdentityHash: "1".repeat(64),
      productionAppleQaVerifierCredentialIdentityHash: "2".repeat(64),
      providerProjectIdentityHash: "8".repeat(64),
      productionProviderProjectIdentityHash: "9".repeat(64),
      stagingRuntimeSnapshotHash: "9".repeat(64),
      productionRuntimeSnapshotHash:
        kind === "candidate" ? null : "a".repeat(64),
      stagingConfigurationHash,
      productionConfigurationHash:
        kind === "candidate" ? null : productionConfigurationHash,
      stagingSecretVersionsHash: stagingConfiguration.secretVersionsHash,
      productionSecretVersionsHash: productionConfiguration.secretVersionsHash,
      stagingRailwayServiceInventoryHash: "6".repeat(64),
      productionRailwayServiceInventoryHash: "7".repeat(64),
      appleReceiptPayloadHash: "a".repeat(64),
      providerReceiptPayloadHash: "b".repeat(64),
      qaBudgetReceiptPayloadHash: "c".repeat(64),
      appleAccountSeparationEvidenceHash: "5".repeat(64),
      musicKitOriginRegistrationEvidenceHash: "6".repeat(64),
      controlPlaneEvidenceHash: "7".repeat(64),
      controlPlaneKeyId: "staging-control-plane-test-v1",
      controlPlaneKeyFingerprint:
        approvedStagingControlPlaneTrustPolicy.approvedKeySha256,
    },
    runtime,
    semanticReview: {
      schemaVersion: "genio-release-semantic-review/v1",
      gateEvidenceHash: hash,
      reviewedAt: phaseGeneratedAt.candidate,
      semanticBehaviorHash: semanticBehaviorHashV1(runtime),
      fixtures: semanticBaselineFixtureIds.map((fixtureId, index) => ({
        fixtureId,
        orderedManifestHash: ["7", "8", "9"][index]!.repeat(64),
        outputHash: ["a", "b", "c"][index]!.repeat(64),
      })),
    },
    environmentSnapshots: {
      staging: {
        scope: "full",
        generatedAt: phaseGeneratedAt.candidate,
        snapshotHash: "9".repeat(64),
        sitesObservationHash: sha256(stagingSitesObservation),
        sitesVersion: stagingSitesObservation.version,
        sitesSourceRevision: stagingSitesObservation.sourceRevision,
        sitesCandidateMatched: true,
        configurationHash: stagingConfigurationHash,
        secretVersionsHash: stagingConfiguration.secretVersionsHash,
        runtimeHash: stagingRuntimeHash,
        providerCredentialVersionHash: "1".repeat(64),
        appleCredentialVersionHash: "3".repeat(64),
        appleQaVerifierCredentialVersionHash: "d".repeat(64),
        publicRollout: {
          active: false,
          databaseAuthorized: true,
          evidenceHash: null,
          stage: null,
          targetConfigurationHash: null,
        },
      },
      production: kind !== "candidate" ? {
        scope: kind === "finalization" ? "full" : "backend",
        generatedAt: completedAt,
        snapshotHash: "a".repeat(64),
        sitesObservationHash: sha256(productionSitesObservation),
        sitesVersion: productionSitesObservation.version,
        sitesSourceRevision: productionSitesObservation.sourceRevision,
        sitesCandidateMatched: kind === "finalization",
        configurationHash: productionConfigurationHash,
        secretVersionsHash: productionConfiguration.secretVersionsHash,
        runtimeHash: productionRuntimeHash,
        providerCredentialVersionHash: "2".repeat(64),
        appleCredentialVersionHash: "4".repeat(64),
        appleQaVerifierCredentialVersionHash: "e".repeat(64),
        publicRollout: kind === "finalization"
          ? {
              active: true,
              databaseAuthorized: true,
              evidenceHash: "d".repeat(64),
              stage: "genre_scene:50->100",
              targetConfigurationHash: "4".repeat(64),
            }
          : {
              active: false,
              databaseAuthorized: true,
              evidenceHash: null,
              stage: null,
              targetConfigurationHash: null,
            },
      } : null,
    },
    gates,
  };
}

function protectedBaselineMetadataForFinalization(
  finalization: {
    payload: ReturnType<typeof payload>;
    payloadHash: string;
  },
) {
  const finalBrowser = finalization.payload.gates.find(
    ({ name }: { name: string }) => name === "final_custom_domain_browser",
  );
  if (!finalBrowser) throw new Error("finalization fixture has no browser gate");
  return {
    schemaVersion:
      "genio-semantic-ranking-protected-baseline/v2" as const,
    rcTag: finalization.payload.candidate.tag,
    stableTag: `v${finalization.payload.candidate.version}`,
    version: finalization.payload.candidate.version,
    sourceRevision: finalization.payload.candidate.sourceRevision,
    imageDigest: finalization.payload.candidate.imageDigest,
    imageReference:
      finalization.payload.stagingControls.candidateImageReference,
    finalizationEvidencePayloadHash: finalization.payloadHash,
    finalBrowserGateEvidenceHash: finalBrowser.evidenceHash,
    fixtures: finalization.payload.semanticReview.fixtures.map(
      (fixture: {
        fixtureId: string;
        orderedManifestHash: string;
        outputHash: string;
      }) => ({ ...fixture }),
    ),
  };
}

function createSemanticBaselineLineageFixture() {
  const finalizationPayload = structuredClone(payload("finalization"));
  const finalizationGeneratedAt = "2026-07-22T10:00:00.000Z";
  const authorizationGeneratedAt = "2026-07-22T11:00:00.000Z";
  const finalizationExpiresAt = new Date(
    Date.parse(finalizationGeneratedAt) + RELEASE_EVIDENCE_TTL_MS,
  ).toISOString();
  const sourceRevision = "b".repeat(40);
  const imageDigest = `sha256:${"d".repeat(64)}`;
  finalizationPayload.generatedAt = finalizationGeneratedAt;
  finalizationPayload.expiresAt = finalizationExpiresAt;
  finalizationPayload.candidate = {
    tag: "v2.3.9-rc.2",
    version: "2.3.9",
    sourceRevision,
    imageDigest,
    sitesSourceRevision: sourceRevision,
  };
  finalizationPayload.lineage = {
    candidateEvidencePayloadHash: "1".repeat(64),
    candidateEvidenceGeneratedAt: "2026-07-22T08:00:00.000Z",
    promotionEvidencePayloadHash: "2".repeat(64),
    promotionEvidenceGeneratedAt: "2026-07-22T09:00:00.000Z",
    publicRolloutEvidencePayloadHash: "3".repeat(64),
    publicRolloutCompletedAt: "2026-07-22T09:30:00.000Z",
    publicRolloutIntentGroup: "genre_scene",
    publicRolloutFromPercent: "50",
    publicRolloutToPercent: "100",
    publicRolloutTargetConfigurationHash: "4".repeat(64),
  };
  finalizationPayload.semanticReview.reviewedAt =
    finalizationPayload.lineage.candidateEvidenceGeneratedAt;
  finalizationPayload.stagingControls.candidateEvidencePayloadHash =
    finalizationPayload.lineage.candidateEvidencePayloadHash;
  finalizationPayload.stagingControls.candidateSourceRevision =
    sourceRevision;
  finalizationPayload.stagingControls.candidateImageDigest = imageDigest;
  finalizationPayload.stagingControls.candidateImageReference =
    `ghcr.io/hooterjackson/genio@${imageDigest}`;
  finalizationPayload.environmentSnapshots.staging.generatedAt =
    "2026-07-22T08:00:00.000Z";
  finalizationPayload.environmentSnapshots.staging.sitesVersion = "2.3.9";
  finalizationPayload.environmentSnapshots.staging.sitesSourceRevision =
    sourceRevision;
  finalizationPayload.environmentSnapshots.production.generatedAt =
    finalizationGeneratedAt;
  finalizationPayload.environmentSnapshots.production.sitesVersion =
    "2.3.9";
  finalizationPayload.environmentSnapshots.production.sitesSourceRevision =
    sourceRevision;
  finalizationPayload.environmentSnapshots.production.publicRollout = {
    active: true,
    databaseAuthorized: true,
    evidenceHash:
      finalizationPayload.lineage.publicRolloutEvidencePayloadHash!,
    stage: "genre_scene:50->100",
    targetConfigurationHash: "4".repeat(64),
  };
  for (const gateValue of finalizationPayload.gates) {
    gateValue.completedAt = finalizationGeneratedAt;
  }
  const validatedPayload =
    validateReleaseEvidencePayload(finalizationPayload);
  const releaseKeyId = "semantic-baseline-release-test-v1";
  const finalization = {
    schemaVersion: "genio-signed-release-evidence/v3" as const,
    payload: validatedPayload,
    payloadHash: sha256(validatedPayload),
    signature: {
      algorithm: "Ed25519" as const,
      keyId: releaseKeyId,
      value: sign(
        null,
        Buffer.from(stableReleaseEvidenceJson({
          algorithm: "Ed25519",
          keyId: releaseKeyId,
          payload: validatedPayload,
        })),
        semanticBaselineReleaseKeys.privateKey,
      ).toString("base64url"),
    },
  };
  const protectedBaselineMetadata =
    protectedBaselineMetadataForFinalization(finalization);
  const protectedBaselineMetadataHash =
    semanticRankingProtectedBaselineMetadataSha256(
      protectedBaselineMetadata,
    );
  const finalBrowser = validatedPayload.gates.find(
    ({ name }) => name === "final_custom_domain_browser",
  );
  if (!finalBrowser) {
    throw new Error("semantic baseline fixture has no final browser gate");
  }
  const stableAuthorizerKeyId =
    "semantic-baseline-stable-authorizer-test-v1";
  const stableAuthorization = createStrictSignedEnvelope({
    envelopeSchemaVersion:
      SIGNED_STABLE_RELEASE_AUTHORIZATION_SCHEMA_V1,
    payload: {
      schemaVersion: STABLE_RELEASE_AUTHORIZATION_SCHEMA_V1,
      issuer: STABLE_RELEASE_AUTHORIZATION_ISSUER_V1,
      generatedAt: authorizationGeneratedAt,
      expiresAt: finalizationExpiresAt,
      action: "create_stable_tag_and_github_release",
      candidate: {
        rcTag: protectedBaselineMetadata.rcTag,
        stableTag: protectedBaselineMetadata.stableTag,
        version: protectedBaselineMetadata.version,
        sourceRevision: protectedBaselineMetadata.sourceRevision,
        imageDigest: protectedBaselineMetadata.imageDigest,
      },
      finalizationEvidencePayloadHash: finalization.payloadHash,
      finalBrowserGateEvidenceHash: finalBrowser.evidenceHash,
      protectedBaselineMetadataHash,
    },
    signingKey: semanticBaselineStableAuthorizerKeys.privateKey,
    keyId: stableAuthorizerKeyId,
  });
  const consumer = verifyHistoricalStableReleaseConsumerBundle({
    finalizationEvidence: finalization,
    protectedBaselineMetadata,
    releaseVerificationKey: semanticBaselineReleaseKeys.publicKey,
    approvedReleaseKeySha256:
      stableReleaseKeyFingerprint(semanticBaselineReleaseKeys.publicKey),
    stableAuthorization,
    stableAuthorizationVerificationKey:
      semanticBaselineStableAuthorizerKeys.publicKey,
    approvedStableAuthorizerKeyId: stableAuthorizerKeyId,
    approvedStableAuthorizerKeySha256:
      stableReleaseKeyFingerprint(
        semanticBaselineStableAuthorizerKeys.publicKey,
      ),
    expectedRcTag: protectedBaselineMetadata.rcTag,
    expectedVersion: protectedBaselineMetadata.version,
    expectedRevision: protectedBaselineMetadata.sourceRevision,
    expectedImageDigest: protectedBaselineMetadata.imageDigest,
    expectedImageReference: protectedBaselineMetadata.imageReference,
    now: generatedAt,
  });
  return {
    finalization,
    protectedBaselineMetadata,
    releaseVerificationKey:
      stableReleaseVerificationKeyV1(semanticBaselineReleaseKeys.publicKey),
    stableAuthorization,
    stableAuthorizerVerificationKey:
      stableReleaseVerificationKeyV1(
        semanticBaselineStableAuthorizerKeys.publicKey,
      ),
    consumer,
  };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableReleaseEvidenceJson(value)).digest("hex");
}

function resignReleaseEvidence(
  value: {
    payload: unknown;
    signature: { keyId: string };
  },
  signingKey: KeyObject,
) {
  const signedPayload = validateReleaseEvidencePayload(value.payload);
  const keyId = value.signature.keyId;
  return {
    schemaVersion: "genio-signed-release-evidence/v3" as const,
    payload: signedPayload,
    payloadHash: sha256(signedPayload),
    signature: {
      algorithm: "Ed25519" as const,
      keyId,
      value: sign(
        null,
        Buffer.from(stableReleaseEvidenceJson({
          algorithm: "Ed25519",
          keyId,
          payload: signedPayload,
        })),
        signingKey,
      ).toString("base64url"),
    },
  };
}

function runtimeSnapshot(
  value: ReturnType<typeof payload>,
  environment: "staging" | "production",
  publicRolloutEvidence?: unknown,
) {
  const observation = sitesObservation(value.kind, environment);
  const configuration = {
    ...value.configuration,
    sitesHash: sitesHash(observation),
    secretVersionsHash: environment === "staging"
      ? "b".repeat(64)
      : hash,
  };
  const runtime = {
    ...value.runtime,
    releaseEnvironment: environment,
  };
  const configurationHash = releaseEvidenceConfigurationHash({
    configuration,
  });
  const runtimeHash = releaseEvidenceRuntimeHash({ runtime } as any);
  const rolloutEnvelope = publicRolloutEvidence as
    | {
        payloadHash: string;
        payload: {
          transition: {
            intentGroup: string;
            fromPercent: string;
            toPercent: string;
          };
          targetConfigurationHash: string;
        };
      }
    | undefined;
  const publicRollout = environment === "production"
    && value.kind === "finalization"
    ? {
        active: true,
        databaseAuthorized: true,
        evidenceHash: rolloutEnvelope!.payloadHash,
        stage:
          `${rolloutEnvelope!.payload.transition.intentGroup}:${rolloutEnvelope!.payload.transition.fromPercent}->${rolloutEnvelope!.payload.transition.toPercent}`,
        targetConfigurationHash:
          rolloutEnvelope!.payload.targetConfigurationHash,
      }
    : {
        active: false,
        databaseAuthorized: true,
        evidenceHash: null,
        stage: null,
        targetConfigurationHash: null,
      };
  const unsigned = {
    schemaVersion: "genio-release-runtime-snapshot/v3",
    generatedAt: environment === "staging"
      ? phaseGeneratedAt.candidate
      : value.generatedAt,
    origin: environment === "staging"
      ? "https://staging-9enio.example"
      : "https://9enio.com",
    environment,
    scope: environment === "staging" || value.kind === "finalization"
      ? "full"
      : "backend",
    candidate: {
      version: value.candidate.version,
      sourceRevision: value.candidate.sourceRevision,
    },
    sitesObservation: observation,
    apiObservations: {
      liveReplicaIdentityHash: "8".repeat(64),
      systemReplicaIdentityHash: "9".repeat(64),
    },
    executorFencing: {
      version: "1",
      ready: true,
      incompleteJobs: 0,
      mismatchedActiveAttempts: 0,
      uncoveredJobs: 0,
      requirementsHash: "a".repeat(64),
    },
    configuration,
    runtime,
    publicRollout,
    credentialVersionHashes: {
      provider: environment === "staging" ? "1".repeat(64) : "2".repeat(64),
      apple: environment === "staging" ? "3".repeat(64) : "4".repeat(64),
      appleQaVerifier: environment === "staging" ? "d".repeat(64) : "e".repeat(64),
    },
    configurationHash,
    runtimeHash,
  };
  return {
    ...unsigned,
    snapshotHash: sha256(unsigned),
  };
}

function fixtureGuidancePayload(
  fixtureId: Extract<
    ReleaseFixtureId,
    "smooth-reggaeton-heat-50-v1" | "french-jazz-guided-constraint-25-v1"
  >,
) {
  const questionSetHash = fixtureId === "smooth-reggaeton-heat-50-v1"
    ? "a".repeat(64)
    : "b".repeat(64);
  if (fixtureId === "smooth-reggaeton-heat-50-v1") {
    const decision = smoothReggaetonHeatGuidanceDecisionV3({
      prompt: releaseFixturePrompt(fixtureId),
      baseContractRevisionId: "fixture-contract-reggaeton-v1",
      baseContractSemanticHash: "c".repeat(64),
      preservedTrackPredicate: null,
      ambiguousScopeClauseIds: [],
    });
    if (!decision) throw new Error("missing reggaeton fixture guidance decision");
    return {
      questionSetHash,
      questions: [publicGuidanceQuestionV3(decision)],
    };
  }
  const prompt = releaseFixturePrompt(fixtureId);
  const protectedClauses = [
    {
      id: "genre:jazz",
      kind: "membership" as const,
      scope: "track" as const,
      hardness: "hard" as const,
      axis: "genre",
      operator: "require" as const,
      values: ["jazz"],
      source: { provenance: "prompt" as const, text: "jazz" },
    },
    {
      id: "recording:clean",
      kind: "catalog_version" as const,
      scope: "track" as const,
      hardness: "hard" as const,
      axis: "content",
      operator: "require" as const,
      values: ["clean"],
      source: { provenance: "prompt" as const, text: "clean" },
    },
    {
      id: "recording:original-studio",
      kind: "catalog_version" as const,
      scope: "track" as const,
      hardness: "hard" as const,
      axis: "version",
      operator: "require" as const,
      values: ["original studio"],
      source: { provenance: "prompt" as const, text: "original studio" },
    },
    {
      id: "exclude:live",
      kind: "exclusion" as const,
      scope: "track" as const,
      hardness: "hard" as const,
      axis: "version",
      operator: "exclude" as const,
      values: ["live"],
      source: { provenance: "prompt" as const, text: "exclude live recordings" },
    },
    {
      id: "exclude:remix",
      kind: "exclusion" as const,
      scope: "track" as const,
      hardness: "hard" as const,
      axis: "version",
      operator: "exclude" as const,
      values: ["remix"],
      source: { provenance: "prompt" as const, text: "exclude remixes" },
    },
  ];
  const base = compilePlaylistContractRevisionV1({
    contractId: "release-fixture:french-jazz-guided-constraint-25-v1",
    rawPrompt: prompt,
    requestedTrackCount: 25,
    locale: "en-US",
    storefront: "us",
    clauses: [
      ...protectedClauses,
      {
        id: "prompt:french",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "geography",
        operator: "require",
        values: ["French"],
        source: { provenance: "prompt", text: "French" },
      },
    ],
    trackPredicate: {
      op: "all",
      children: [...protectedClauses.map(({ id }) => ({
        op: "clause" as const,
        clauseId: id,
      })), { op: "clause", clauseId: "prompt:french" }],
    },
  });
  const decision = frenchJazzGuidanceDecisionV3({ prompt, baseContract: base });
  if (!decision) throw new Error("missing French-jazz fixture guidance decision");
  return {
    questionSetHash,
    questions: [publicGuidanceQuestionV3(decision)],
  };
}

function sourceEvidence(
  gateName: ReleaseGateName,
  candidate: ReturnType<typeof payload>["candidate"],
  fixtures: ReturnType<typeof releaseFixtureBindingsForGate>,
  environment: "offline" | "staging" | "production",
  verifierCredentialVersionHash: string,
  releaseRuntimeSnapshot: ReturnType<typeof runtimeSnapshot>,
  stagingControlPlanePayloadHash: string,
): Record<string, unknown> {
  const sourceGeneratedAt = releaseRuntimeSnapshot.generatedAt;
  const sourceExpiresAt = new Date(
    Date.parse(sourceGeneratedAt) + RELEASE_EVIDENCE_TTL_MS,
  ).toISOString();
  const fixtureExecution = fixtures[0]
    ? createReleaseFixtureExecutionProof({
      fixtureId: fixtures[0].fixtureId,
      guidanceLineageHash: fixtures[0].guidanceLineageHash,
      guidancePayload: fixtures[0].guidanceMode === "recommended"
        ? fixtureGuidancePayload(fixtures[0].fixtureId as
          | "smooth-reggaeton-heat-50-v1"
          | "french-jazz-guided-constraint-25-v1")
        : null,
    })
    : null;
  if (gateName === "staging_provider_manifest") {
    const manifestUnsigned = {
      schemaVersion: "genio-release-manifest-canary-evidence/v1",
      environment: "staging",
      cacheMode: "reuse_disabled",
      sourceRevision: candidate.sourceRevision,
      outcome: "exact_ready",
      completedAt: sourceGeneratedAt,
      requestedTrackCount: fixtures[0]!.targetTrackCount,
      selectedTrackCount: fixtures[0]!.targetTrackCount,
      zeroWriteProof: {
        autoPublish: false,
        manifestRows: 0,
        matchingJobs: 0,
        publicationJobs: 0,
        publicationVolumeRows: 0,
      },
      selectionValidation: {
        canonicalPublicationValid: true,
        centralQualityRequired: true,
        centralQualityPassed: true,
        playlistOptimizationRequired: true,
        playlistOptimizationExact: true,
      },
    };
    const evidence = { ...manifestUnsigned, evidenceHash: sha256(manifestUnsigned) };
    const reportUnsigned = {
      schemaVersion: "genio-staging-manifest-canary/v1",
      candidate: {
        version: candidate.version,
        sourceRevision: candidate.sourceRevision,
      },
      runtimeSnapshotHash: releaseRuntimeSnapshot.snapshotHash,
      evidence,
    };
    return {
      fixtureExecution,
      manifestCanary: {
        ...reportUnsigned,
        evidenceHash: sha256(reportUnsigned),
      },
    };
  }
  if (gateName === "staging_historical_replay") {
    const replayPayload = {
      schemaVersion: "genio-historical-browser-replay-evidence/v1",
      generatedAt: sourceGeneratedAt,
      expiresAt: sourceExpiresAt,
      environment: "staging",
      candidate: {
        tag: candidate.tag,
        version: candidate.version,
        sourceRevision: candidate.sourceRevision,
        imageDigest: candidate.imageDigest,
      },
      staging: {
        originHash: sha256(releaseRuntimeSnapshot.origin),
        runtimeSnapshotHash: releaseRuntimeSnapshot.snapshotHash,
        configurationHash: releaseRuntimeSnapshot.configurationHash,
        runtimeHash: releaseRuntimeSnapshot.runtimeHash,
        controlPlaneEvidenceHash: stagingControlPlanePayloadHash,
        serviceInventoryHash: "6".repeat(64),
      },
      corpus: {
        commitmentHash:
          "cec24d3d2c78185ccf1fcb8dfe646193c83ef7f26819f473bca34cd6fbc5eefd",
        submissionCount: 73,
        maximumResearchBudgetUsd: 59.25,
        requiredOtherCanaryReserveUsd: 3,
        requiredBudgetReservationUsd: 62.25,
      },
      browser: {
        engine: "chromium",
        maximumConcurrency: 4,
        perRunDeadlineMs: 900_000,
        perRunBudgetCapUsd: 3,
        cacheMode: "reuse_disabled",
        traceCount: 0,
        screenshotCount: 0,
        videoCount: 0,
        rawArtifactCount: 0,
      },
      outcomes: {
        completedSubmissionCount: 73,
        exactOriginalCount: 73,
        exactAfterGuidanceCount: 0,
        actionableDecisionCount: 0,
        visibleRetryCount: 0,
        guidanceSubmissionCount: 0,
        briefMarkerCount: 73,
        runMarkerCount: 73,
        freshRunCount: 73,
        countIntegrityCheckCount: 73,
        unexplainedTerminalCount: 0,
        countViolationCount: 0,
        integrityViolationCount: 0,
        budgetExhaustionCount: 0,
        transcriptCommitmentHash: "3".repeat(64),
      },
      passed: true,
    };
    const keyId = "historical-replay-test-v1";
    const keyFingerprint =
      releaseGateProducerKeyFingerprint(historicalReplayKeys.publicKey);
    return {
      historicalReplay: createStrictSignedEnvelope({
        envelopeSchemaVersion:
          "genio-signed-historical-browser-replay-evidence/v1",
        payload: replayPayload,
        signingKey: historicalReplayKeys.privateKey,
        keyId,
      }),
      historicalReplayVerificationKey: {
        schemaVersion:
          "genio-historical-browser-replay-verification-key/v1",
        algorithm: "Ed25519",
        keyId,
        publicKeyPem: historicalReplayKeys.publicKey.export({
          format: "pem",
          type: "spki",
        }).toString(),
        publicKeySha256: keyFingerprint,
      },
      historicalReplayTrust: releaseGateProducerTrustPolicyV1({
        approvedKeyId: keyId,
        approvedKeySha256: keyFingerprint,
      }),
    };
  }
  if (gateName === "semantic_ranking_blinded_review") {
    const candidateOutputs = fixtures.map(({ fixtureId }, index) => ({
      fixtureId,
      orderedManifestHash: ["7", "8", "9"][index]!.repeat(64),
      outputHash: ["a", "b", "c"][index]!.repeat(64),
    }));
    const blindedPackage = {
      schemaVersion: "genio-semantic-ranking-blinded-package/v1" as const,
      randomizationId: "QWxhZGRpbjpvcGVuIHNlc2FtZQ",
      fixtures: fixtures.map(({ fixtureId }, index) => {
        const baselineArm = {
          blindLabel: `baselineBlindArm_${index}_8Ywq`,
          orderedManifestHash:
            semanticProtectedBaselineMetadata.fixtures[index]!
              .orderedManifestHash,
          outputHash:
            semanticProtectedBaselineMetadata.fixtures[index]!.outputHash,
        };
        const candidateArm = {
          blindLabel: `candidateBlindArm_${index}_4KpZ`,
          orderedManifestHash:
            candidateOutputs[index]!.orderedManifestHash,
          outputHash: candidateOutputs[index]!.outputHash,
        };
        return {
          fixtureId,
          arms: index % 2 === 0
            ? [candidateArm, baselineArm]
            : [baselineArm, candidateArm],
        };
      }),
    };
    const blindedPackageHash =
      semanticRankingBlindedPackageSha256(blindedPackage);
    const blindMapping = {
      schemaVersion: "genio-semantic-ranking-blind-mapping/v1" as const,
      blindedPackageHash,
      baselineMetadataHash: semanticBaselineMetadataHash,
      candidate: {
        sourceRevision: candidate.sourceRevision,
        imageDigest: candidate.imageDigest,
      },
      fixtures: fixtures.map(({ fixtureId }, index) => ({
        fixtureId,
        baselineBlindLabel: `baselineBlindArm_${index}_8Ywq`,
        candidateBlindLabel: `candidateBlindArm_${index}_4KpZ`,
      })),
    };
    const blindScorecard = {
      schemaVersion:
        "genio-semantic-ranking-blind-scorecard/v1" as const,
      blindedPackageHash,
      reviewedAt: sourceGeneratedAt,
      fixtures: blindedPackage.fixtures.map((fixture) => {
        return {
          fixtureId: fixture.fixtureId,
          arms: fixture.arms.map((arm) => ({
            ...arm,
            scores: {
              relevance: 4,
              discoveryQuality: 4,
              coherence: 4,
              sequencing: 4,
            },
          })),
        };
      }),
    };
    const reviewArtifact = {
      schemaVersion: "genio-semantic-ranking-review/v2" as const,
      blinded: true as const,
      independentReviewerAttested: true as const,
      candidate: {
        sourceRevision: candidate.sourceRevision,
        imageDigest: candidate.imageDigest,
      },
      baseline: semanticRankingReviewBaselineIdentityV2(
        semanticProtectedBaselineMetadata,
      ),
      blinding: {
        blindedPackageHash,
        blindMappingHash:
          semanticRankingBlindMappingSha256(blindMapping),
      },
      reviewedAt: sourceGeneratedAt,
      pairs: fixtures.map(({ fixtureId }, index) => ({
        fixtureId,
        baseline: {
          scores: {
            relevance: 4,
            discoveryQuality: 4,
            coherence: 4,
            sequencing: 4,
          },
          orderedManifestHash:
            semanticProtectedBaselineMetadata.fixtures[index]!
              .orderedManifestHash,
          outputHash:
            semanticProtectedBaselineMetadata.fixtures[index]!.outputHash,
        },
        candidate: {
          scores: {
            relevance: 4,
            discoveryQuality: 4,
            coherence: 4,
            sequencing: 4,
          },
          orderedManifestHash:
            candidateOutputs[index]!.orderedManifestHash,
          outputHash: candidateOutputs[index]!.outputHash,
        },
      })),
    };
    const reviewReport = evaluateSemanticRankingReviewV1(reviewArtifact);
    return {
      reviewArtifact,
      reviewReport,
      protectedBaselineMetadata: semanticProtectedBaselineMetadata,
      protectedBaselineFinalizationEvidence:
        semanticBaselineLineageFixture.finalization,
      protectedBaselineReleaseVerificationKey:
        semanticBaselineLineageFixture.releaseVerificationKey,
      protectedBaselineStableAuthorization:
        semanticBaselineLineageFixture.stableAuthorization,
      protectedBaselineStableAuthorizerVerificationKey:
        semanticBaselineLineageFixture.stableAuthorizerVerificationKey,
      protectedBaselineVerification: {
        schemaVersion:
          "genio-historical-stable-predecessor-verification-context/v1",
        mode: "normal",
        repository: "hooterjackson/genio",
        defaultBranch: "main",
        controllerSourceRevision: null,
        successorRcTag: candidate.tag,
        successorSourceRevision: candidate.sourceRevision,
      },
      protectedBaselineImageAttestation: null,
      protectedBaselineStoredConsumer:
        semanticBaselineLineageFixture.consumer,
      protectedBaselineGithubAttestationVerification: null,
      protectedBaselineLineage:
        semanticBaselineLineageFixture.consumer,
      blindedPackage,
      blindScorecard,
      blindMapping,
      reviewerAttestation: attestSemanticRankingReviewV1({
        blindScorecard,
        signingKey: reviewerKeys.privateKey,
        keyId: "independent-reviewer-test-v1",
      }),
      reviewerVerificationKey:
        semanticRankingReviewerVerificationKeyV1(reviewerKeys.publicKey),
      reviewerTrustPolicy: approvedReviewerTrustPolicy,
    };
  }
  if (
    gateName === "backend_release_convergence"
    || gateName === "release_convergence"
  ) {
    const scope = gateName === "backend_release_convergence"
      ? "backend"
      : "full";
    const sitesCandidateMatched = scope === "full";
    const nextObservedAt = new Date(
      Date.parse(sourceGeneratedAt) + 30_000,
    ).toISOString();
    const semanticExecution =
      releaseRuntimeSnapshot.runtime.semanticExecutionConfigurationHash;
    const convergenceObservation = (
      observedAt: string,
    ): ReleaseConvergenceObservation => {
      const runtime = {
        pipelineVersion: "pipeline-v3",
        semanticExecutionConfigurationHash: semanticExecution,
        releaseEnvironment: "production",
        deploymentPhase: "activate",
        expectedDatabaseSchemaVersion: "19",
        canonicalActivationConfigured: "true",
        assignmentEnabled: "true",
        ownerCanaryEnabled: "true",
        productionEvidenceApproved: "true",
        curatedHostedEvidenceApproved: "true",
        genreSceneEvidenceApproved: "true",
        geographicScopeEvidenceApproved: "true",
        factualFeasibilityApproved: "true",
        publicRolloutEvidenceHash:
          releaseRuntimeSnapshot.publicRollout.evidenceHash,
        publicRolloutStage:
          releaseRuntimeSnapshot.publicRollout.stage,
        schemaVersion: "19",
        schemaMinimum: "17",
        schemaMaximum: "19",
        schemaPreferred: "19",
        workerProtocol: "playlist-pipeline-v11",
        minimumWorkerProtocol: "playlist-pipeline-v11",
        selectionPlanVersion: "selection-plan-v3",
        queryPlanSchemaVersion: "6",
        briefContractVersion: "3",
        guidanceContractOwnerCanaryEnabled: "true",
        guidanceContractReggaetonCanaryEnabled: "true",
        guidancePolicyVersion: "adaptive_guidance_v4",
        evidencePolicyVersion: "governed_evidence_v2",
        queryPlanPolicyVersion: "query_plan_v3_4",
        semanticScopePolicyVersion: "scope_gate_v2_1_2",
        musicConceptPolicyVersion: "music_concepts_v3_3_0",
        pipelinePolicyVersion: "corpus_first_v3",
        promptVersion: "grounded_recovery_v3_1_prompt_v1",
        briefProviderModelId: "gpt-5.4-mini",
        baselineProviderModelId: "gpt-5.6-luna",
        escalationProviderModelId: "gpt-5.6-terra",
        modelResolutionMode: "catalog",
        modelCatalogValidatedAt: sourceGeneratedAt,
      };
      const lane = (configurationHash: string) => ({
        status: "healthy",
        protocolVersion: "playlist-pipeline-v11",
        compatibleCapacity: 1,
        eligibleWorkerCount: 1,
        eligibleIdentityCount: 1,
        eligibleRevisions: [candidate.sourceRevision],
        eligibleConfigurationHashes: [configurationHash],
        eligibleSemanticExecutionConfigurationHashes: [
          semanticExecution,
        ],
        lastSeenAt: observedAt,
      });
      return {
        observedAt,
        sitesVersion:
          releaseRuntimeSnapshot.sitesObservation.version,
        sitesRevision:
          releaseRuntimeSnapshot.sitesObservation.sourceRevision,
        api: {
          replicaIdentityHash:
            releaseRuntimeSnapshot.apiObservations.liveReplicaIdentityHash,
          identifier: "genio-api",
          version: candidate.version,
          revision: candidate.sourceRevision,
          configurationHash: hash,
          semanticExecutionConfigurationHash: semanticExecution,
        },
        runtime,
        runtimeContractHash: sha256(runtime),
        systemHttpStatus: 200,
        system: {
          api: {
            replicaIdentityHash:
              releaseRuntimeSnapshot.apiObservations
                .systemReplicaIdentityHash,
            identifier: "genio-api",
            version: candidate.version,
            revision: candidate.sourceRevision,
            configurationHash: hash,
            semanticExecutionConfigurationHash: semanticExecution,
          },
          ok: true,
          activationReady: true,
          database: "ready",
          releaseManifestCanaryGuardsVersion: "1",
          canonicalExecutionHardeningVersion: "1",
          canonicalExecutorReleaseIdentityFencingVersion: "1",
          executorFencing: {
            ready: true,
            incompleteJobs: 0,
            mismatchedActiveAttempts: 0,
            uncoveredJobs: 0,
            requirementsHash: "f".repeat(64),
          },
          publicRollout: releaseRuntimeSnapshot.publicRollout,
          paused: false,
          workerProtocol: {
            expected: "playlist-pipeline-v11",
            minimumAccepted: "playlist-pipeline-v11",
            actual: "playlist-pipeline-v11",
          },
          workerLanes: {
            interactive: lane(hash),
            deep: lane(hash),
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
    };
    const convergence = buildReleaseConvergenceEvidence({
      origin: "https://9enio.com",
      scope,
      expectedRevision: candidate.sourceRevision,
      expectedVersion: candidate.version,
      expectedSitesRevision:
        releaseRuntimeSnapshot.sitesObservation.sourceRevision,
      expectedSitesVersion:
        releaseRuntimeSnapshot.sitesObservation.version,
      expectedSamples: 2,
      expectedConfigurationHashes: {
        api: hash,
        interactiveWorker: hash,
        deepWorker: hash,
        semanticExecution,
      },
      observations: [
        convergenceObservation(sourceGeneratedAt),
        convergenceObservation(nextObservedAt),
      ],
      generatedAt: sourceGeneratedAt,
    });
    expect(convergence.expected.sites.candidateMatched)
      .toBe(sitesCandidateMatched);
    return { convergence };
  }
  if (gateName === "final_custom_domain_browser") {
    const rollbackTarget = createSitesProductionRollbackTargetV1({
      capturedAt: "2026-07-23T12:30:00.000Z",
      projectId: "project-test",
      productionUrl: "https://9enio.com",
      plannedCandidate: {
        commitSha: candidate.sitesSourceRevision,
        buildVersion: candidate.version,
      },
      previous: {
        versionId: "version-prior-test",
        versionNumber: 80,
        commitSha: "f".repeat(40),
        archiveSha256: "9".repeat(64),
        deploymentId: "deployment-prior-test",
        deploymentStatus: "succeeded",
        controlPlaneObservedAt: "2026-07-23T12:29:00.000Z",
        liveObservedAt: "2026-07-23T12:29:30.000Z",
        liveBuildVersion: "2.3.9",
        liveBuildRevision: "f".repeat(40),
      },
    });
    const sitesUnsigned = {
      schemaVersion: "genio-sites-control-plane-deployment/v2",
      projectId: "project-test",
      versionId: "version-test",
      versionNumber: 81,
      archiveSha256: "8".repeat(64),
      deploymentId: "deployment-test",
      commitSha: candidate.sitesSourceRevision,
      buildVersion: candidate.version,
      productionUrl: "https://9enio.com",
      status: "ready",
      deploymentRequestedAt: "2026-07-23T12:31:00.000Z",
      observedAt: sourceGeneratedAt,
      rollbackTarget,
    };
    const browserUnsigned = {
      schemaVersion: "genio-final-custom-domain-browser/v2",
      origin: "https://9enio.com",
      candidateRevision: candidate.sourceRevision,
      observedAt: sourceGeneratedAt,
      tlsValid: true,
      releaseIdentityVisible: true,
      anonymousPlaylistDirectory: true,
      publicPlaylistContentsVisible: true,
      privacyProjectionPassed: true,
      screenshotHashes: ["c".repeat(64)],
      publicAssignmentProbes:
        FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V1.map((fixture, index) => ({
          fixtureId: fixture.fixtureId,
          intentGroup: fixture.intentGroup,
          targetTrackCount: fixture.targetTrackCount,
          rolloutEvidenceHash:
            releaseRuntimeSnapshot.publicRollout.evidenceHash!,
          rolloutStage:
            releaseRuntimeSnapshot.publicRollout.stage!,
          assignmentHash: String((index % 9) + 1).repeat(64),
          contractVersion: 3,
          cleanupStatus: 204,
        })),
    };
    const sitesControlPlane = {
      ...sitesUnsigned,
      evidenceHash: sha256(sitesUnsigned),
    };
    const sitesAttestationPayload = {
      schemaVersion: "genio-sites-control-plane-attestation/v1",
      generatedAt: sourceGeneratedAt,
      expiresAt: new Date(
        Date.parse(sourceGeneratedAt) + 6 * 60_000,
      ).toISOString(),
      issuer: "openai-sites-control-plane",
      operation: "production_deployment_ready",
      receiptHash: sitesControlPlane.evidenceHash,
    };
    const sitesControlPlaneAttestation = createStrictSignedEnvelope({
      envelopeSchemaVersion:
        "genio-signed-sites-control-plane-attestation/v1",
      payload: sitesAttestationPayload,
      signingKey: sitesControlPlaneKeys.privateKey,
      keyId: approvedSitesControlPlaneTrustPolicy.approvedKeyId,
    });
    const sitesTrustUnsigned = {
      schemaVersion: "genio-sites-control-plane-trust-verification/v1",
      receiptHash: sitesControlPlane.evidenceHash,
      attestationPayloadHash: sitesControlPlaneAttestation.payloadHash,
      trustedKeyId: sitesControlPlaneAttestation.signature.keyId,
      verificationKeyFingerprint:
        approvedSitesControlPlaneTrustPolicy.approvedKeySha256,
      verifiedAt: sourceGeneratedAt,
    };
    return {
      sitesControlPlane,
      sitesControlPlaneAttestation,
      sitesControlPlaneTrust: {
        ...sitesTrustUnsigned,
        evidenceHash: sha256(sitesTrustUnsigned),
      },
      sitesControlPlaneVerificationKey:
        sitesControlPlaneVerificationKeyV1(sitesControlPlaneKeys.publicKey),
      sitesControlPlaneTrustPolicy: approvedSitesControlPlaneTrustPolicy,
      browser: {
        ...browserUnsigned,
        evidenceHash: sha256(browserUnsigned),
      },
    };
  }
  const fixture = fixtures[0]!;
  const canaryId = `${gateName}-canary`;
  const orderedHash = "6".repeat(64);
  const independentUnsigned = {
    schemaVersion: "genio-independent-apple-release-evidence/v1",
    canaryId,
    environment,
    candidateRevision: candidate.sourceRevision,
    observedAt: sourceGeneratedAt,
    verifierCredentialVersionHash,
    verifierCredentialIdentityHash:
      environment === "staging" ? "1".repeat(64) : "2".repeat(64),
    playlistCount: 1,
    targetTrackCount: fixture.targetTrackCount,
    expectedOrderedIdsHash: orderedHash,
    observedOrderedIdsHash: orderedHash,
    exactOrderedReadback: true,
    publicNamesHash: "5".repeat(64),
    browserChecks: [{
      volumeIndex: 1,
      screenshotHash: "4".repeat(64),
      titleVisible: true,
      firstTrackVisible: true,
      lastTrackVisible: true,
      countVisible: true,
    }],
  };
  const independentApple = {
    ...independentUnsigned,
    evidenceHash: sha256(independentUnsigned),
  };
  const hostedUnsigned = {
    schemaVersion: "genio-hosted-publication-smoke/v1",
    canaryId,
    cacheMode: "reuse_disabled",
    targetTrackCount: fixture.targetTrackCount,
    manifestContentHash: "1".repeat(64),
    contractHash: "2".repeat(64),
    answerLineageHash: "3".repeat(64),
    queryPlanRevisionHash: "4".repeat(64),
    guidanceLineageHash: fixture.guidanceLineageHash ?? "0".repeat(64),
    guidanceRevisionCount: fixture.guidanceLineageHash ? 1 : 0,
    executorRevisions: [candidate.sourceRevision],
    executorIdentityHashes: ["7".repeat(64)],
    configurationHashes: [hash],
    completedAttemptCount: 1,
    allAttemptsComplete: true,
    serverReportedOrderedAppleReconciliation: true,
    orderedAppleIdsHash: orderedHash,
    independentAppleEvidenceHash: independentApple.evidenceHash,
    volumes: [{
      index: 1,
      trackCount: fixture.targetTrackCount,
      appendedCount: fixture.targetTrackCount,
      shareUrl: "https://music.apple.com/us/playlist/test/pl.u-test",
    }],
  };
  return {
    hostedPublication: {
      ...hostedUnsigned,
      evidenceHash: createHash("sha256").update(JSON.stringify(hostedUnsigned)).digest("hex"),
    },
    independentApple,
    fixtureExecution,
  };
}

const STABLE_CONTROL_PLANE_SOURCE_FIXTURE_FILE =
  "stable-finalization-control-plane-sources.json";

function writeStagingControlPlaneEvidence(
  directory: string,
  kind: "candidate" | "promotion" | "finalization",
  stagingSnapshot: ReturnType<typeof runtimeSnapshot>,
  productionSnapshot: ReturnType<typeof runtimeSnapshot> | null,
  candidateEvidencePayloadHash: string | null,
): {
  evidenceFile: string;
  verificationKeyFile: string;
  payloadHash: string;
} {
  const evidenceFile = "staging-control-plane-evidence.json";
  const verificationKeyFile = "staging-control-plane-public.pem";
  const candidate = {
    version: "2.4.0",
    sourceRevision: revision,
    imageDigest: digest,
    imageReference: `ghcr.io/hooterjackson/genio@${digest}`,
  };
  const generatedAt = phaseGeneratedAt[kind];
  const appleReceipt = createStrictSignedEnvelope({
    envelopeSchemaVersion: SIGNED_APPLE_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
    payload: {
      schemaVersion: APPLE_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
      phase: kind,
      issuer: approvedControlPlaneReceiptTrustPolicies.apple.approvedIssuer,
      generatedAt,
      expiresAt: phaseExpiresAt(kind),
      candidate,
      staging: {
        runtimeSnapshotHash: stagingSnapshot.snapshotHash,
        appleCredentialVersionHash: "3".repeat(64),
        appleQaVerifierCredentialVersionHash: "d".repeat(64),
        appleQaVerifierCredentialIdentityHash: "1".repeat(64),
        appleAccountIdHash: "c".repeat(64),
        musicKitOrigin: "https://staging-9enio.example",
        musicKitOriginRegistered: true,
        musicKitOriginRegistrationEvidenceHash: "6".repeat(64),
      },
      production: {
        runtimeSnapshotHash: productionSnapshot?.snapshotHash ?? null,
        appleCredentialVersionHash: "4".repeat(64),
        appleQaVerifierCredentialVersionHash: "e".repeat(64),
        appleQaVerifierCredentialIdentityHash: "2".repeat(64),
        appleAccountIdHash: "0".repeat(64),
      },
    },
    signingKey: controlPlaneReceiptKeys.apple.privateKey,
    keyId: approvedControlPlaneReceiptTrustPolicies.apple.approvedKeyId,
  });
  const providerReceipt = createStrictSignedEnvelope({
    envelopeSchemaVersion: SIGNED_PROVIDER_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
    payload: {
      schemaVersion: PROVIDER_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
      phase: kind,
      issuer: approvedControlPlaneReceiptTrustPolicies.provider.approvedIssuer,
      generatedAt,
      expiresAt: phaseExpiresAt(kind),
      candidate,
      staging: {
        runtimeSnapshotHash: stagingSnapshot.snapshotHash,
        providerCredentialVersionHash: "1".repeat(64),
        providerProjectIdentityHash: "8".repeat(64),
      },
      production: {
        runtimeSnapshotHash: productionSnapshot?.snapshotHash ?? null,
        providerCredentialVersionHash: "2".repeat(64),
        providerProjectIdentityHash: "9".repeat(64),
      },
    },
    signingKey: controlPlaneReceiptKeys.provider.privateKey,
    keyId: approvedControlPlaneReceiptTrustPolicies.provider.approvedKeyId,
  });
  const budgetReceipt = createStrictSignedEnvelope({
    envelopeSchemaVersion: SIGNED_QA_BUDGET_LEDGER_RECEIPT_SCHEMA_V1,
    payload: {
      schemaVersion: QA_BUDGET_LEDGER_RECEIPT_SCHEMA_V1,
      phase: kind,
      issuer: approvedControlPlaneReceiptTrustPolicies.qaBudget.approvedIssuer,
      generatedAt,
      expiresAt: new Date(
        Date.parse(generatedAt) + 60 * 60_000,
      ).toISOString(),
      candidate,
      runtimeSnapshots: {
        staging: stagingSnapshot.snapshotHash,
        production: productionSnapshot?.snapshotHash ?? null,
      },
      ledgerScope: "staging_release_qa",
      currency: "USD",
      monthlyCostLimitUsd: 10,
      spentUsd: 4,
      reservedForRequiredGatesUsd: 4,
      asOf: generatedAt,
    },
    signingKey: controlPlaneReceiptKeys.qaBudget.privateKey,
    keyId: approvedControlPlaneReceiptTrustPolicies.qaBudget.approvedKeyId,
  });
  const envelope = createStrictSignedEnvelope({
    envelopeSchemaVersion: SIGNED_STAGING_CONTROL_PLANE_EVIDENCE_SCHEMA_V1,
    payload: {
      schemaVersion: STAGING_CONTROL_PLANE_EVIDENCE_SCHEMA_V1,
      phase: kind,
      candidate,
      candidateEvidencePayloadHash,
      generatedAt: phaseGeneratedAt[kind],
      expiresAt: phaseExpiresAt(kind),
      issuer: STAGING_CONTROL_PLANE_ISSUER_V1,
      staging: {
        railwayProjectIdHash: "a".repeat(64),
        railwayEnvironmentIdHash: "b".repeat(64),
        railwayServiceInventoryHash: "6".repeat(64),
        runtimeSnapshotHash: stagingSnapshot.snapshotHash,
        configurationHash: stagingSnapshot.configurationHash,
        secretVersionsHash: stagingSnapshot.configuration.secretVersionsHash,
        providerCredentialVersionHash: "1".repeat(64),
        appleCredentialVersionHash: "3".repeat(64),
        appleQaVerifierCredentialVersionHash: "d".repeat(64),
        appleQaVerifierCredentialIdentityHash: "1".repeat(64),
        providerProjectIdentityHash: "8".repeat(64),
        appleAccountIdHash: "c".repeat(64),
        musicKitOrigin: "https://staging-9enio.example",
        musicKitOriginRegistrationEvidenceHash: "6".repeat(64),
      },
      production: {
        railwayProjectIdHash: "e".repeat(64),
        railwayEnvironmentIdHash: "f".repeat(64),
        railwayServiceInventoryHash: "7".repeat(64),
        runtimeSnapshotHash: productionSnapshot?.snapshotHash ?? null,
        configurationHash: productionSnapshot?.configurationHash ?? null,
        secretVersionsHash: productionSnapshot
          ? productionSnapshot.configuration.secretVersionsHash
          : hash,
        providerCredentialVersionHash: "2".repeat(64),
        appleCredentialVersionHash: "4".repeat(64),
        appleQaVerifierCredentialVersionHash: "e".repeat(64),
        appleQaVerifierCredentialIdentityHash: "2".repeat(64),
        providerProjectIdentityHash: "9".repeat(64),
        appleAccountIdHash: "0".repeat(64),
      },
      budget: {
        currency: "USD",
        monthlyCostLimitUsd: 10,
        budgetRemainingUsd: 6,
        reservedForRequiredGatesUsd: 4,
        status: "available",
      },
      receipts: {
        apple: {
          payloadHash: appleReceipt.payloadHash,
          issuer:
            approvedControlPlaneReceiptTrustPolicies.apple.approvedIssuer,
          keyId:
            approvedControlPlaneReceiptTrustPolicies.apple.approvedKeyId,
          keySha256:
            approvedControlPlaneReceiptTrustPolicies.apple.approvedKeySha256,
        },
        provider: {
          payloadHash: providerReceipt.payloadHash,
          issuer:
            approvedControlPlaneReceiptTrustPolicies.provider.approvedIssuer,
          keyId:
            approvedControlPlaneReceiptTrustPolicies.provider.approvedKeyId,
          keySha256:
            approvedControlPlaneReceiptTrustPolicies.provider
              .approvedKeySha256,
        },
        qaBudget: {
          payloadHash: budgetReceipt.payloadHash,
          issuer:
            approvedControlPlaneReceiptTrustPolicies.qaBudget.approvedIssuer,
          keyId:
            approvedControlPlaneReceiptTrustPolicies.qaBudget.approvedKeyId,
          keySha256:
            approvedControlPlaneReceiptTrustPolicies.qaBudget
              .approvedKeySha256,
        },
      },
    },
    signingKey: stagingControlPlaneKeys.privateKey,
    keyId: approvedStagingControlPlaneTrustPolicy.approvedKeyId,
  });
  writeFileSync(join(directory, evidenceFile), JSON.stringify(envelope));
  writeFileSync(
    join(directory, verificationKeyFile),
    stagingControlPlaneKeys.publicKey.export({ format: "pem", type: "spki" }),
  );
  writeFileSync(
    join(directory, STABLE_CONTROL_PLANE_SOURCE_FIXTURE_FILE),
    JSON.stringify({
      stagingControlPlaneEvidence: envelope,
      stagingControlPlaneVerificationKey:
        stableReleaseVerificationKeyV1(stagingControlPlaneKeys.publicKey),
      stagingControlPlaneTrustPolicy:
        approvedStagingControlPlaneTrustPolicy,
      controlPlaneReceipts: {
        apple: appleReceipt,
        provider: providerReceipt,
        qaBudget: budgetReceipt,
      },
      controlPlaneReceiptVerificationKeys: {
        apple:
          stableReleaseVerificationKeyV1(
            controlPlaneReceiptKeys.apple.publicKey,
          ),
        provider:
          stableReleaseVerificationKeyV1(
            controlPlaneReceiptKeys.provider.publicKey,
          ),
        qaBudget:
          stableReleaseVerificationKeyV1(
            controlPlaneReceiptKeys.qaBudget.publicKey,
          ),
      },
      controlPlaneReceiptTrustPolicies:
        approvedControlPlaneReceiptTrustPolicies,
    }),
  );
  return {
    evidenceFile,
    verificationKeyFile,
    payloadHash: envelope.payloadHash,
  };
}

function writeSigningBundle(
  directory: string,
  kind: "candidate" | "promotion" | "finalization" = "candidate",
  lineage: {
    priorReleaseEvidence?: unknown;
    publicRolloutEvidence?: unknown;
    mutatePayload?: (value: ReturnType<typeof payload>) => void;
  } = {},
): string {
  const value = payload(kind);
  lineage.mutatePayload?.(value);
  const priorEnvelope = lineage.priorReleaseEvidence as
    | {
        payloadHash: string;
        payload: {
          lineage?: { candidateEvidencePayloadHash?: string | null };
        };
      }
    | undefined;
  const candidateEvidencePayloadHash = kind === "candidate"
    ? null
    : kind === "promotion"
      ? priorEnvelope?.payloadHash ?? null
      : priorEnvelope?.payload.lineage?.candidateEvidencePayloadHash ?? null;
  const stagingSnapshot = runtimeSnapshot(value, "staging");
  writeFileSync(join(directory, "runtime-staging.json"), JSON.stringify(stagingSnapshot));
  const productionSnapshot = kind !== "candidate"
    ? runtimeSnapshot(
        value,
        "production",
        kind === "finalization" ? lineage.publicRolloutEvidence : undefined,
      )
    : null;
  if (productionSnapshot) {
    writeFileSync(join(directory, "runtime-production.json"), JSON.stringify(productionSnapshot));
  }
  const stagingControlPlane = writeStagingControlPlaneEvidence(
    directory,
    kind,
    stagingSnapshot,
    productionSnapshot,
    candidateEvidencePayloadHash,
  );
  const artifactFiles: Record<string, string> = {};
  const attestationFiles: Record<string, string> = {};
  for (const item of value.gates) {
    const expectedSnapshot = item.environment === "production"
      ? productionSnapshot!
      : stagingSnapshot;
    const fixtures = releaseFixtureBindingsForGate(item.name, {
        "smooth-reggaeton-heat-50-v1": "7".repeat(64),
        "french-jazz-guided-constraint-25-v1": "8".repeat(64),
      });
    const artifact = item.name === "offline_suite"
      ? createOfflineReleaseGateArtifact({
        candidate: value.candidate,
        completedAt: item.completedAt,
        workflow: {
          repository: "hooterjackson/genio",
          runId: "30035354716",
          runAttempt: "1",
          sha: value.candidate.sourceRevision,
          refName: value.candidate.tag,
        },
      })
      : createReleaseGateArtifactFromSources({
        gate: item.name,
        completedAt: item.completedAt,
        candidate: value.candidate,
        configurationHash: expectedSnapshot.configurationHash,
        runtimeHash: expectedSnapshot.runtimeHash,
        fixtures,
        sources: sourceEvidence(
          item.name,
          value.candidate,
          fixtures,
          item.environment,
          expectedSnapshot.credentialVersionHashes.appleQaVerifier,
          expectedSnapshot,
          stagingControlPlane.payloadHash,
        ),
      });
    const file = `gate-${item.name}.json`;
    writeFileSync(join(directory, file), JSON.stringify(artifact));
    artifactFiles[item.name] = file;
    const attestationFile = `gate-${item.name}.attestation.json`;
    writeFileSync(
      join(directory, attestationFile),
      JSON.stringify(attestReleaseGateArtifact(
        artifact,
        producerKeys.privateKey,
        "test-producer-2026",
      )),
    );
    attestationFiles[item.name] = attestationFile;
  }
  const offlineGithubBundleFile = "offline-suite.sigstore.json";
  const offlineGithubBindingFile = "offline-suite.binding.json";
  writeFileSync(join(directory, offlineGithubBundleFile), "{}");
  if (artifactFiles.offline_suite) {
    const offlineArtifactBytes = readFileSync(
      join(directory, artifactFiles.offline_suite),
    );
    writeFileSync(join(directory, offlineGithubBindingFile), JSON.stringify({
      schemaVersion: "genio-release-offline-attestation-binding/v1",
      repository: RELEASE_ATTESTATION_REPOSITORY,
      workflow: RELEASE_ATTESTATION_WORKFLOW,
      workflowRef: RELEASE_ATTESTATION_SOURCE_REF,
      workflowSha: value.candidate.sourceRevision,
      candidateSourceRevision: value.candidate.sourceRevision,
      artifactSha256:
        createHash("sha256").update(offlineArtifactBytes).digest("hex"),
      predicateType: RELEASE_ATTESTATION_PREDICATE_TYPE,
    }));
  } else {
    writeFileSync(join(directory, offlineGithubBindingFile), "{}");
  }
  const priorReleaseEvidenceFile = lineage.priorReleaseEvidence
    ? "prior-release-evidence.json"
    : null;
  const publicRolloutEvidenceFile = lineage.publicRolloutEvidence
    ? "public-rollout-evidence.json"
    : null;
  if (priorReleaseEvidenceFile) {
    writeFileSync(
      join(directory, priorReleaseEvidenceFile),
      JSON.stringify(lineage.priorReleaseEvidence),
    );
  }
  if (publicRolloutEvidenceFile) {
    writeFileSync(
      join(directory, publicRolloutEvidenceFile),
      JSON.stringify(lineage.publicRolloutEvidence),
    );
  }
  const bundle = {
    schemaVersion: "genio-release-evidence-signing-bundle/v3",
    kind,
    generatedAt: phaseGeneratedAt[kind],
    expiresAt: phaseExpiresAt(kind),
    candidate: value.candidate,
    stagingControlPlaneEvidenceFile: stagingControlPlane.evidenceFile,
    stagingControlPlaneVerificationKeyFile:
      stagingControlPlane.verificationKeyFile,
    offlineGithubAttestationFiles: {
      bundle: offlineGithubBundleFile,
      binding: offlineGithubBindingFile,
    },
    runtimeSnapshotFiles: {
      staging: "runtime-staging.json",
      production: productionSnapshot ? "runtime-production.json" : null,
    },
    priorReleaseEvidenceFile,
    publicRolloutEvidenceFile,
    gateArtifactFiles: artifactFiles,
    gateAttestationFiles: attestationFiles,
  };
  const bundlePath = join(directory, "signing-bundle.json");
  writeFileSync(bundlePath, JSON.stringify(bundle));
  return bundlePath;
}

function candidateSemanticAuthorizationEvidence(
  directory: string,
  candidateEvidence: unknown,
) {
  return {
    candidateEvidence,
    semanticReviewGateArtifact: JSON.parse(readFileSync(
      join(directory, "gate-semantic_ranking_blinded_review.json"),
      "utf8",
    )),
    semanticReviewGateProducerAttestation: JSON.parse(readFileSync(
      join(
        directory,
        "gate-semantic_ranking_blinded_review.attestation.json",
      ),
      "utf8",
    )),
    releaseGateProducerVerificationKey: producerKeys.publicKey,
    approvedReleaseGateProducer: approvedProducerTrustPolicy,
    approvedSemanticReviewer: approvedReviewerTrustPolicy,
  };
}

function stableFinalizationSourceEvidence(
  promotionDirectory: string,
  finalizationDirectory: string,
  promotionEvidence: unknown,
  publicRolloutEvidence: unknown,
) {
  const controlPlaneSources = JSON.parse(readFileSync(
    join(
      finalizationDirectory,
      STABLE_CONTROL_PLANE_SOURCE_FIXTURE_FILE,
    ),
    "utf8",
  )) as {
    stagingControlPlaneEvidence: unknown;
    stagingControlPlaneVerificationKey: unknown;
    stagingControlPlaneTrustPolicy: unknown;
    controlPlaneReceipts: unknown;
    controlPlaneReceiptVerificationKeys: unknown;
    controlPlaneReceiptTrustPolicies: unknown;
  };
  const gateDirectory = (gateName: string): string =>
    gateName.startsWith("production_")
      || gateName === "backend_release_convergence"
      ? promotionDirectory
      : finalizationDirectory;
  const gateNames = [
    "production_fixed_three_track",
    "production_affected_regression",
    "backend_release_convergence",
    "release_convergence",
    "final_custom_domain_browser",
  ] as const;
  return {
    finalizationSourceEvidence: {
      schemaVersion:
        STABLE_RELEASE_FINALIZATION_SOURCE_BUNDLE_SCHEMA_V2,
      promotionEvidence,
      publicRolloutEvidence,
      ...controlPlaneSources,
      gateArtifacts: Object.fromEntries(
        gateNames.map((gateName) => [
          gateName,
          JSON.parse(readFileSync(
            join(gateDirectory(gateName), `gate-${gateName}.json`),
            "utf8",
          )),
        ]),
      ),
      gateProducerAttestations: Object.fromEntries(
        gateNames.map((gateName) => [
          gateName,
          JSON.parse(readFileSync(
            join(
              gateDirectory(gateName),
              `gate-${gateName}.attestation.json`,
            ),
            "utf8",
          )),
        ]),
      ),
    },
    approvedSitesControlPlane:
      approvedSitesControlPlaneTrustPolicy,
    approvedStagingControlPlane:
      approvedStagingControlPlaneTrustPolicy,
    approvedControlPlaneReceipts:
      controlPlaneSources.controlPlaneReceiptTrustPolicies,
  };
}

function rolloutConfiguration(
  genreScenePercent: "50" | "100",
): PublicRolloutConfiguration {
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
    PIPELINE_V3_GENRE_SCENE_PERCENT: genreScenePercent,
    PIPELINE_V3_MOOD_ACTIVITY_PERCENT: "100",
    PIPELINE_V3_SIMILARITY_PERCENT: "100",
    PIPELINE_V3_ARTIST_CATALOGUE_PERCENT: "100",
    PIPELINE_V3_FIXED_CONTAINER_PERCENT: "100",
    PIPELINE_V3_FACTUAL_PERCENT: "100",
    PIPELINE_V3_EXHAUSTIVE_PERCENT: "100",
    PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED: "false",
    PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED: "true",
    RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
    RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
    RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
    PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "6",
    GUIDANCE_CONTRACT_V3_ENABLED: "false",
    GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
    GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "false",
  };
}

function completedPublicRolloutEvidence(
  promotion: {
    payloadHash: string;
    payload: ReturnType<typeof payload>;
  },
  signingKey: KeyObject,
): ReturnType<typeof createStrictSignedEnvelope> {
  const previousRolloutEvidenceHash = "1".repeat(64);
  const previousRolloutStage = "genre_scene:10->50";
  const startedAt = "2026-07-23T12:20:00.000Z";
  const completedAt = "2026-07-23T12:21:00.000Z";
  const current = rolloutConfiguration("50");
  const target = rolloutConfiguration("100");
  const productionSnapshot =
    promotion.payload.environmentSnapshots.production!;
  const configuration = promotion.payload.configuration;
  const observation = (observedAt: string) => {
    const lastSeenAt = new Date(Date.parse(observedAt) - 5_000).toISOString();
    const lane = (configurationHash: string) => ({
      status: "healthy",
      protocolVersion: "playlist-pipeline-v11",
      compatibleCapacity: 1,
      eligibleWorkerCount: 1,
      eligibleIdentityCount: 1,
      eligibleRevisions: [revision],
      eligibleConfigurationHashes: [configurationHash],
      lastSeenAt,
    });
    return {
      observedAt,
      sitesVersion: productionSnapshot.sitesVersion,
      sitesRevision: productionSnapshot.sitesSourceRevision,
      apiVersion: promotion.payload.candidate.version,
      apiRevision: revision,
      apiConfigurationHash: configuration.apiHash,
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
      workerProtocolExpected: "playlist-pipeline-v11",
      workerProtocolActual: "playlist-pipeline-v11",
      interactiveWorker: lane(configuration.interactiveWorkerHash),
      deepWorker: lane(configuration.deepWorkerHash),
    };
  };
  const observations = [
    observation(startedAt),
    observation("2026-07-23T12:20:30.000Z"),
    observation(completedAt),
  ];
  const rolloutPayload = {
    schemaVersion: PUBLIC_ROLLOUT_EVIDENCE_SCHEMA_VERSION,
    generatedAt: phaseGeneratedAt.rollout,
    expiresAt: new Date(
      Date.parse(phaseGeneratedAt.rollout) + RELEASE_EVIDENCE_TTL_MS,
    ).toISOString(),
    environment: "production",
    candidate: {
      tag: promotion.payload.candidate.tag,
      version: promotion.payload.candidate.version,
      sourceRevision: revision,
      imageDigest: promotion.payload.candidate.imageDigest,
      promotionEvidenceHash: promotion.payloadHash,
    },
    promotion: {
      configurationHash: releaseEvidenceConfigurationHash(promotion.payload),
      runtimeHash: releaseEvidenceRuntimeHash(promotion.payload),
      semanticBehaviorHash:
        promotion.payload.semanticReview.semanticBehaviorHash,
      productionCanaryEvidenceHash:
        publicRolloutProductionCanaryEvidenceHash(promotion.payload.gates),
      sitesVersion: productionSnapshot.sitesVersion,
      sitesRevision: productionSnapshot.sitesSourceRevision,
      sitesCandidateMatched: false,
      databaseSchemaVersion: "19",
      databaseCapabilityVersion: "2",
      releaseManifestCanaryGuardsVersion: "1",
      canonicalExecutionHardeningVersion: "1",
      workerProtocol: "playlist-pipeline-v11",
    },
    transition: {
      operation: "advance",
      intentGroup: "genre_scene",
      fromPercent: "50",
      toPercent: "100",
      currentPercentages: publicRolloutPercentages(current),
      previousRolloutEvidenceHash,
      previousRolloutStage,
      rollbackWarrantHash: null,
      intentCanaryHash: "8".repeat(64),
      preserveInFlightRoute: true,
      rollbackPercent: "0",
    },
    soak: {
      runtimeSnapshot: {
        configuration,
        runtime: promotion.payload.runtime,
        configurationHash: releaseEvidenceConfigurationHash(promotion.payload),
        runtimeHash: releaseEvidenceRuntimeHash(promotion.payload),
      },
      startedAt,
      completedAt,
      durationSeconds: 60,
      healthySampleCount: observations.length,
      observationsHash: signedArtifactSha256(observations),
      observations,
      eligibleOldWorkerCount: 0,
      intentStageMetrics: {
        windowStartedAt: "2026-07-23T12:10:00.000Z",
        windowCompletedAt: "2026-07-23T12:19:00.000Z",
        candidateAssignedCount: 500,
        exactCompletionCount: 500,
      },
    },
    targetConfiguration: target,
    targetConfigurationHash: signedArtifactSha256(target),
  };
  return createStrictSignedEnvelope({
    envelopeSchemaVersion: SIGNED_PUBLIC_ROLLOUT_EVIDENCE_SCHEMA_VERSION,
    payload: rolloutPayload,
    signingKey,
    keyId: "release-2026",
  });
}

function installStrictGithubCliFake(directory: string): void {
  const executable = join(directory, "gh");
  writeFileSync(executable, `#!/usr/bin/env node
const { createHash } = require("node:crypto");
const { existsSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "attestation" || args[1] !== "verify" || !args[2]) {
  throw new Error("unexpected gh command");
}
const option = (name) => {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error("missing " + name);
  return args[index + 1];
};
if (
  option("--repo") !== ${JSON.stringify(RELEASE_ATTESTATION_REPOSITORY)}
  || option("--signer-workflow") !== ${JSON.stringify(RELEASE_ATTESTATION_WORKFLOW)}
  || option("--source-ref") !== ${JSON.stringify(RELEASE_ATTESTATION_SOURCE_REF)}
  || option("--predicate-type") !== ${JSON.stringify(RELEASE_ATTESTATION_PREDICATE_TYPE)}
  || option("--cert-oidc-issuer") !== "https://token.actions.githubusercontent.com"
  || !args.includes("--deny-self-hosted-runners")
  || !existsSync(option("--bundle"))
) {
  throw new Error("untrusted gh verification arguments");
}
const artifactSha256 = createHash("sha256")
  .update(readFileSync(args[2]))
  .digest("hex");
process.stdout.write(JSON.stringify([{
  verificationResult: {
    statement: {
      predicateType: ${JSON.stringify(RELEASE_ATTESTATION_PREDICATE_TYPE)},
      subject: [{ digest: { sha256: artifactSha256 } }],
    },
    signature: { certificate: { issuer: "github-actions" } },
    verifiedTimestamps: [],
  },
}]));
`);
  chmodSync(executable, 0o755);
}

async function writeRealFinalizationControlPlane(input: {
  directory: string;
  stagingSnapshot: ReturnType<typeof runtimeSnapshot>;
  productionSnapshot: ReturnType<typeof runtimeSnapshot>;
  candidateEvidence: unknown;
  releaseVerificationKey: KeyObject;
}): Promise<{
  evidenceFile: string;
  verificationKeyFile: string;
}> {
  const controlGeneratedAt = phaseGeneratedAt.finalization;
  const controlExpiresAt = phaseExpiresAt("finalization");
  const receiptKeys = {
    apple: generateKeyPairSync("ed25519"),
    provider: generateKeyPairSync("ed25519"),
    budget: generateKeyPairSync("ed25519"),
  };
  const trusts = {
    apple: controlPlaneReceiptTrustPolicyV1({
      receiptKind: "apple",
      approvedIssuer: "apple-finalization-control-v1",
      approvedKeyId: "apple-finalization-key-v1",
      approvedKeySha256:
        controlPlaneReceiptKeyFingerprint(receiptKeys.apple.publicKey),
    }),
    provider: controlPlaneReceiptTrustPolicyV1({
      receiptKind: "provider",
      approvedIssuer: "provider-finalization-control-v1",
      approvedKeyId: "provider-finalization-key-v1",
      approvedKeySha256:
        controlPlaneReceiptKeyFingerprint(receiptKeys.provider.publicKey),
    }),
    budget: controlPlaneReceiptTrustPolicyV1({
      receiptKind: "qa_budget",
      approvedIssuer: "qa-finalization-budget-v1",
      approvedKeyId: "qa-finalization-budget-key-v1",
      approvedKeySha256:
        controlPlaneReceiptKeyFingerprint(receiptKeys.budget.publicKey),
    }),
  };
  const candidate = {
    version: "2.4.0",
    sourceRevision: revision,
    imageDigest: digest,
    imageReference: `ghcr.io/hooterjackson/genio@${digest}`,
  };
  const appleReceipt = createStrictSignedEnvelope({
    envelopeSchemaVersion: SIGNED_APPLE_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
    payload: {
      schemaVersion: APPLE_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
      phase: "finalization",
      issuer: trusts.apple.approvedIssuer,
      generatedAt: controlGeneratedAt,
      expiresAt: controlExpiresAt,
      candidate,
      staging: {
        runtimeSnapshotHash: input.stagingSnapshot.snapshotHash,
        appleCredentialVersionHash:
          input.stagingSnapshot.credentialVersionHashes.apple,
        appleQaVerifierCredentialVersionHash:
          input.stagingSnapshot.credentialVersionHashes.appleQaVerifier,
        appleQaVerifierCredentialIdentityHash: "1".repeat(64),
        appleAccountIdHash: "2".repeat(64),
        musicKitOrigin: input.stagingSnapshot.origin,
        musicKitOriginRegistered: true,
        musicKitOriginRegistrationEvidenceHash: "3".repeat(64),
      },
      production: {
        runtimeSnapshotHash: input.productionSnapshot.snapshotHash,
        appleCredentialVersionHash:
          input.productionSnapshot.credentialVersionHashes.apple,
        appleQaVerifierCredentialVersionHash:
          input.productionSnapshot.credentialVersionHashes.appleQaVerifier,
        appleQaVerifierCredentialIdentityHash: "2".repeat(64),
        appleAccountIdHash: "5".repeat(64),
      },
    },
    signingKey: receiptKeys.apple.privateKey,
    keyId: trusts.apple.approvedKeyId,
  });
  const providerReceipt = createStrictSignedEnvelope({
    envelopeSchemaVersion: SIGNED_PROVIDER_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
    payload: {
      schemaVersion: PROVIDER_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
      phase: "finalization",
      issuer: trusts.provider.approvedIssuer,
      generatedAt: controlGeneratedAt,
      expiresAt: controlExpiresAt,
      candidate,
      staging: {
        runtimeSnapshotHash: input.stagingSnapshot.snapshotHash,
        providerCredentialVersionHash:
          input.stagingSnapshot.credentialVersionHashes.provider,
        providerProjectIdentityHash: "6".repeat(64),
      },
      production: {
        runtimeSnapshotHash: input.productionSnapshot.snapshotHash,
        providerCredentialVersionHash:
          input.productionSnapshot.credentialVersionHashes.provider,
        providerProjectIdentityHash: "7".repeat(64),
      },
    },
    signingKey: receiptKeys.provider.privateKey,
    keyId: trusts.provider.approvedKeyId,
  });
  const budgetReceipt = createStrictSignedEnvelope({
    envelopeSchemaVersion: SIGNED_QA_BUDGET_LEDGER_RECEIPT_SCHEMA_V1,
    payload: {
      schemaVersion: QA_BUDGET_LEDGER_RECEIPT_SCHEMA_V1,
      phase: "finalization",
      issuer: trusts.budget.approvedIssuer,
      generatedAt: controlGeneratedAt,
      expiresAt: "2026-07-23T13:40:00.000Z",
      candidate,
      runtimeSnapshots: {
        staging: input.stagingSnapshot.snapshotHash,
        production: input.productionSnapshot.snapshotHash,
      },
      ledgerScope: "staging_release_qa",
      currency: "USD",
      monthlyCostLimitUsd: 10,
      spentUsd: 2,
      reservedForRequiredGatesUsd: 4,
      asOf: controlGeneratedAt,
    },
    signingKey: receiptKeys.budget.privateKey,
    keyId: trusts.budget.approvedKeyId,
  });
  const files = {
    stagingSnapshot: "real-finalization-staging-runtime.json",
    productionSnapshot: "real-finalization-production-runtime.json",
    candidateEvidence: "real-finalization-candidate-evidence.json",
    candidateEvidenceKey: "real-finalization-release-public.pem",
    appleReceipt: "real-finalization-apple-receipt.json",
    appleKey: "real-finalization-apple-public.pem",
    providerReceipt: "real-finalization-provider-receipt.json",
    providerKey: "real-finalization-provider-public.pem",
    budgetReceipt: "real-finalization-budget-receipt.json",
    budgetKey: "real-finalization-budget-public.pem",
    producerKey: "real-finalization-control-private.pem",
    evidence: "real-finalization-control-plane.json",
    verificationKey: "real-finalization-control-public.pem",
  };
  const target = (name: keyof typeof files) =>
    join(input.directory, files[name]);
  for (const [name, value] of [
    ["stagingSnapshot", input.stagingSnapshot],
    ["productionSnapshot", input.productionSnapshot],
    ["candidateEvidence", input.candidateEvidence],
    ["appleReceipt", appleReceipt],
    ["providerReceipt", providerReceipt],
    ["budgetReceipt", budgetReceipt],
  ] as const) {
    writeFileSync(target(name), JSON.stringify(value));
  }
  for (const [name, key] of [
    ["candidateEvidenceKey", input.releaseVerificationKey],
    ["appleKey", receiptKeys.apple.publicKey],
    ["providerKey", receiptKeys.provider.publicKey],
    ["budgetKey", receiptKeys.budget.publicKey],
  ] as const) {
    writeFileSync(target(name), key.export({ format: "pem", type: "spki" }));
  }
  writeFileSync(
    target("producerKey"),
    stagingControlPlaneKeys.privateKey.export({
      format: "pem",
      type: "pkcs8",
    }),
  );

  const stagingProjectId = "11111111-1111-4111-8111-111111111111";
  const productionProjectId = "22222222-2222-4222-8222-222222222222";
  const stagingEnvironmentId = "33333333-3333-4333-8333-333333333333";
  const productionEnvironmentId = "44444444-4444-4444-8444-444444444444";
  const stagingServices = [
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
    "77777777-7777-4777-8777-777777777777",
  ];
  const productionServices = [
    "88888888-8888-4888-8888-888888888888",
    "99999999-9999-4999-8999-999999999999",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ];
  const railwayStatus = (
    projectId: string,
    environmentId: string,
    serviceIds: readonly string[],
  ) => ({
    id: projectId,
    environments: {
      edges: [{
        node: {
          id: environmentId,
          canAccess: true,
          deletedAt: null,
          serviceInstances: {
            edges: serviceIds.map((serviceId) => ({
              node: {
                serviceId,
                environmentId,
                latestDeployment: {
                  status: "SUCCESS",
                  instances: [{ status: "RUNNING" }],
                  meta: {
                    commitHash: revision,
                    image: null,
                    imageDigest: digest,
                  },
                },
              },
            })),
          },
        },
      }],
    },
  });
  const railway: RailwayControlPlaneQueryAdapter = {
    async queryStatus(selector) {
      return selector.projectId === stagingProjectId
        ? railwayStatus(
          stagingProjectId,
          stagingEnvironmentId,
          stagingServices,
        )
        : railwayStatus(
          productionProjectId,
          productionEnvironmentId,
          productionServices,
        );
    },
    async querySecretVersionsHash(query) {
      return query.projectId === stagingProjectId
        ? input.stagingSnapshot.configuration.secretVersionsHash
        : input.productionSnapshot.configuration.secretVersionsHash;
    },
  };
  const args: StagingControlPlaneEvidenceProducerArgs = {
    phase: "finalization",
    candidateImageDigest: digest,
    candidateImageReference: candidate.imageReference,
    stagingRuntimeSnapshotPath: target("stagingSnapshot"),
    productionRuntimeSnapshotPath: target("productionSnapshot"),
    candidateEvidencePath: target("candidateEvidence"),
    candidateEvidenceVerificationKeyPath: target("candidateEvidenceKey"),
    candidateEvidenceKeySha256:
      stagingControlPlaneKeyFingerprint(input.releaseVerificationKey),
    appleReceiptPath: target("appleReceipt"),
    appleReceiptVerificationKeyPath: target("appleKey"),
    providerReceiptPath: target("providerReceipt"),
    providerReceiptVerificationKeyPath: target("providerKey"),
    budgetReceiptPath: target("budgetReceipt"),
    budgetReceiptVerificationKeyPath: target("budgetKey"),
    producerSigningKeyPath: target("producerKey"),
    outputPath: target("evidence"),
    verificationKeyOutputPath: target("verificationKey"),
    producerKeyId: approvedStagingControlPlaneTrustPolicy.approvedKeyId,
    producerKeySha256:
      approvedStagingControlPlaneTrustPolicy.approvedKeySha256,
    stagingOrigin: input.stagingSnapshot.origin,
    productionOrigin: input.productionSnapshot.origin,
    stagingRailway: {
      projectId: stagingProjectId,
      environmentId: stagingEnvironmentId,
      requiredServiceIds: stagingServices,
      candidateServiceIds: stagingServices,
    },
    productionRailway: {
      projectId: productionProjectId,
      environmentId: productionEnvironmentId,
      requiredServiceIds: productionServices,
      candidateServiceIds: productionServices,
    },
    appleReceiptTrust: trusts.apple,
    providerReceiptTrust: trusts.provider,
    budgetReceiptTrust: trusts.budget,
  };
  await produceStagingControlPlaneEvidence({
    args,
    railway,
    now: controlGeneratedAt,
  });
  writeFileSync(
    join(input.directory, STABLE_CONTROL_PLANE_SOURCE_FIXTURE_FILE),
    JSON.stringify({
      stagingControlPlaneEvidence: JSON.parse(
        readFileSync(target("evidence"), "utf8"),
      ),
      stagingControlPlaneVerificationKey:
        stableReleaseVerificationKeyV1(stagingControlPlaneKeys.publicKey),
      stagingControlPlaneTrustPolicy:
        approvedStagingControlPlaneTrustPolicy,
      controlPlaneReceipts: {
        apple: appleReceipt,
        provider: providerReceipt,
        qaBudget: budgetReceipt,
      },
      controlPlaneReceiptVerificationKeys: {
        apple: stableReleaseVerificationKeyV1(receiptKeys.apple.publicKey),
        provider:
          stableReleaseVerificationKeyV1(receiptKeys.provider.publicKey),
        qaBudget:
          stableReleaseVerificationKeyV1(receiptKeys.budget.publicKey),
      },
      controlPlaneReceiptTrustPolicies: {
        apple: trusts.apple,
        provider: trusts.provider,
        qaBudget: trusts.budget,
      },
    }),
  );
  return {
    evidenceFile: files.evidence,
    verificationKeyFile: files.verificationKey,
  };
}

describe("signed release evidence", () => {
  test("rejects duplicate stable authorization CLI options", () => {
    const args = [
      "--confirm-stable-release-authorization",
      "--candidate-evidence", "candidate.json",
      "--finalization-evidence", "finalization.json",
      "--finalization-source-evidence", "sources.json",
      "--semantic-review-gate-artifact", "semantic.json",
      "--semantic-review-gate-producer-attestation", "semantic.sig.json",
      "--protected-baseline-metadata", "baseline.json",
      "--release-verification-key", "release.pem",
      "--release-gate-producer-verification-key", "producer.pem",
      "--authorizer-signing-key", "authorizer.pem",
      "--output", "authorization.json",
      "--expected-rc-tag", "v2.4.0-rc.5",
      "--expected-version", "2.4.0",
      "--expected-revision", revision,
      "--expected-image-digest", digest,
    ];
    expect(parseStableReleaseAuthorizationArgs(args)).toMatchObject({
      "--expected-revision": revision,
    });
    expect(() => parseStableReleaseAuthorizationArgs([
      ...args,
      "--output",
      "replacement.json",
    ])).toThrow(/Duplicate argument: --output/u);
  });

  test("recomputes convergence instead of trusting a signed passed flag", () => {
    const value = payload("promotion");
    const snapshot = runtimeSnapshot(value, "production");
    const fixtures = releaseFixtureBindingsForGate(
      "backend_release_convergence",
    );
    const sources = sourceEvidence(
      "backend_release_convergence",
      value.candidate,
      fixtures,
      "production",
      snapshot.credentialVersionHashes.appleQaVerifier,
      snapshot,
      "9".repeat(64),
    );
    const convergence = sources.convergence as {
      evidenceHash: string;
      observations: Array<{
        runtime: { semanticExecutionConfigurationHash: string };
      }>;
      [key: string]: unknown;
    };
    convergence.observations[0]!.runtime
      .semanticExecutionConfigurationHash = "0".repeat(64);
    const unsigned: Record<string, unknown> = { ...convergence };
    delete unsigned.evidenceHash;
    convergence.evidenceHash = sha256(unsigned);

    expect(() => createReleaseGateArtifactFromSources({
      gate: "backend_release_convergence",
      completedAt: value.generatedAt,
      candidate: value.candidate,
      configurationHash: snapshot.configurationHash,
      runtimeHash: snapshot.runtimeHash,
      fixtures,
      sources,
    })).toThrow(/canonical recomputation/u);
  });

  test("recompiles both immutable guided fixtures from the actual server-owned questions", () => {
    const reggaeton = validateReleaseFixtureGuidancePayload(
      "smooth-reggaeton-heat-50-v1",
      fixtureGuidancePayload("smooth-reggaeton-heat-50-v1"),
    );
    expect(reggaeton).toMatchObject({
      selectedOptionId: "reggaeton_dembow_latin_urban",
      executionDeltaHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    const frenchJazzPayload = fixtureGuidancePayload(
      "french-jazz-guided-constraint-25-v1",
    );
    const frenchJazz = validateReleaseFixtureGuidancePayload(
      "french-jazz-guided-constraint-25-v1",
      frenchJazzPayload,
    );
    expect(frenchJazz).toMatchObject({
      selectedOptionId: "french_jazz_scene",
      executionDeltaHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });

    const mutated = structuredClone(frenchJazzPayload);
    mutated.questions[0]!.options[0]!.contractPatch!.operations =
      mutated.questions[0]!.options[0]!.contractPatch!.operations.filter((operation) => (
        JSON.stringify(operation).includes("exclude:live") === false
      ));
    expect(() => validateReleaseFixtureGuidancePayload(
      "french-jazz-guided-constraint-25-v1",
      mutated,
    )).toThrow();
  });

  test("signs and verifies a strict, expiring artifact-bound candidate", async () => {
    const keys = generateKeyPairSync("ed25519");
    const directory = mkdtempSync(join(tmpdir(), "genio-release-sign-"));
    try {
      const bundle = JSON.parse(readFileSync(writeSigningBundle(directory), "utf8"));
      const signed = await signReleaseEvidenceBundle(
        bundle,
        directory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
        keys.privateKey,
        "release-2026",
        releaseAuthoringAuthority(keys.publicKey, bundle),
      );
      expect(verifyReleaseEvidence(signed, keys.publicKey, {
        expectedKind: "candidate",
        now: "2026-07-23T12:30:00.000Z",
        expectedRevision: revision,
        expectedImageDigest: digest,
        expectedTag: "v2.4.0-rc.1",
        expectedConfigurationHash: releaseEvidenceConfigurationHash(signed.payload),
        expectedRuntimeHash: releaseEvidenceRuntimeHash(signed.payload),
      })).toMatchObject({
        kind: "candidate",
        candidate: { sourceRevision: revision, imageDigest: digest },
      });
      expect(signed.payloadHash).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("pins the release signer, uses the signer clock, and separates all nine authorities", async () => {
    const keys = generateKeyPairSync("ed25519");
    const directory = mkdtempSync(join(tmpdir(), "genio-release-authority-"));
    try {
      const bundle = JSON.parse(
        readFileSync(writeSigningBundle(directory), "utf8"),
      );
      await expect(signReleaseEvidenceBundle(
        bundle,
        directory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
        keys.privateKey,
        "release-2026",
        {
          ...releaseAuthoringAuthority(keys.publicKey, bundle),
          approvedKeySha256: "f".repeat(64),
        },
      )).rejects.toThrow(/protected release authority/u);

      await expect(signReleaseEvidenceBundle(
        bundle,
        directory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
        producerKeys.privateKey,
        "release-2026",
        releaseAuthoringAuthority(producerKeys.publicKey, bundle),
      )).rejects.toThrow(/nine distinct protected authorities/u);

      await expect(signReleaseEvidenceBundle(
        bundle,
        directory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
        keys.privateKey,
        "release-2026",
        {
          ...releaseAuthoringAuthority(keys.publicKey, bundle),
          now: new Date(
            Date.parse(String(bundle.generatedAt)) - 6 * 60_000,
          ).toISOString(),
        },
      )).rejects.toThrow(/generated in the future/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("signs real post-Sites finalization that fits the stable dispatch", async () => {
    const releaseKeys = generateKeyPairSync("ed25519");
    const candidateDirectory = mkdtempSync(
      join(tmpdir(), "genio-real-finalization-candidate-"),
    );
    const promotionDirectory = mkdtempSync(
      join(tmpdir(), "genio-real-finalization-promotion-"),
    );
    const finalizationDirectory = mkdtempSync(
      join(tmpdir(), "genio-real-finalization-"),
    );
    try {
      const candidateBundle = JSON.parse(
        readFileSync(
          writeSigningBundle(candidateDirectory, "candidate"),
          "utf8",
        ),
      );
      const candidateEvidence = await signReleaseEvidenceBundle(
        candidateBundle,
        candidateDirectory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
        releaseKeys.privateKey,
        "release-2026",
        releaseAuthoringAuthority(
          releaseKeys.publicKey,
          candidateBundle,
        ),
      );
      const promotionBundle = JSON.parse(readFileSync(
        writeSigningBundle(promotionDirectory, "promotion", {
          priorReleaseEvidence: candidateEvidence,
        }),
        "utf8",
      ));
      const promotionEvidence = await signReleaseEvidenceBundle(
        promotionBundle,
        promotionDirectory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
        releaseKeys.privateKey,
        "release-2026",
        releaseAuthoringAuthority(
          releaseKeys.publicKey,
          promotionBundle,
        ),
      );
      const publicRolloutEvidence = completedPublicRolloutEvidence(
        promotionEvidence as any,
        releaseKeys.privateKey,
      );
      const finalizationBundlePath = writeSigningBundle(
        finalizationDirectory,
        "finalization",
        {
          priorReleaseEvidence: promotionEvidence,
          publicRolloutEvidence,
        },
      );
      const finalizationBundle = JSON.parse(
        readFileSync(finalizationBundlePath, "utf8"),
      );
      const stagingSnapshot = JSON.parse(
        readFileSync(
          join(finalizationDirectory, "runtime-staging.json"),
          "utf8",
        ),
      ) as ReturnType<typeof runtimeSnapshot>;
      const productionSnapshot = JSON.parse(
        readFileSync(
          join(finalizationDirectory, "runtime-production.json"),
          "utf8",
        ),
      ) as ReturnType<typeof runtimeSnapshot>;
      expect(productionSnapshot).toMatchObject({
        scope: "full",
        sitesObservation: {
          candidateMatched: true,
          sourceRevision: revision,
        },
      });
      const controlPlane = await writeRealFinalizationControlPlane({
        directory: finalizationDirectory,
        stagingSnapshot,
        productionSnapshot,
        candidateEvidence,
        releaseVerificationKey: releaseKeys.publicKey,
      });
      finalizationBundle.stagingControlPlaneEvidenceFile =
        controlPlane.evidenceFile;
      finalizationBundle.stagingControlPlaneVerificationKeyFile =
        controlPlane.verificationKeyFile;
      const finalization = await signReleaseEvidenceBundle(
        finalizationBundle,
        finalizationDirectory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
        releaseKeys.privateKey,
        "release-2026",
        releaseAuthoringAuthority(
          releaseKeys.publicKey,
          finalizationBundle,
        ),
      );
      expect(verifyReleaseEvidence(
        finalization,
        releaseKeys.publicKey,
        {
          expectedKind: "finalization",
          expectedTag: "v2.4.0-rc.1",
          expectedRevision: revision,
          expectedImageDigest: digest,
          now: "2026-07-23T12:45:00.000Z",
        },
      )).toMatchObject({
        stagingControls: {
          controlPlanePhase: "finalization",
          candidateEvidencePayloadHash: candidateEvidence.payloadHash,
          productionRuntimeSnapshotHash: productionSnapshot.snapshotHash,
        },
        environmentSnapshots: {
          production: {
            scope: "full",
            sitesCandidateMatched: true,
          },
        },
      });
      const stableAuthorizer = generateKeyPairSync("ed25519");
      const protectedBaselineMetadata =
        protectedBaselineMetadataForFinalization(finalization);
      const stableAuthorizationInput = {
        ...candidateSemanticAuthorizationEvidence(
          candidateDirectory,
          candidateEvidence,
        ),
        ...stableFinalizationSourceEvidence(
          promotionDirectory,
          finalizationDirectory,
          promotionEvidence,
          publicRolloutEvidence,
        ),
        finalizationEvidence: finalization,
        protectedBaselineMetadata,
        releaseVerificationKey: releaseKeys.publicKey,
        approvedReleaseKeySha256:
          stableReleaseKeyFingerprint(releaseKeys.publicKey),
        authorizerSigningKey: stableAuthorizer.privateKey,
        approvedAuthorizerKeyId: "real-finalization-authorizer-v1",
        approvedAuthorizerKeySha256:
          stableReleaseKeyFingerprint(stableAuthorizer.publicKey),
        expectedRcTag: "v2.4.0-rc.1",
        expectedVersion: "2.4.0",
        expectedRevision: revision,
        expectedImageDigest: digest,
        generatedAt: "2026-07-23T12:45:00.000Z",
      };
      const forgedProtectedBaselineMetadata =
        structuredClone(protectedBaselineMetadata);
      forgedProtectedBaselineMetadata.fixtures[0]!.orderedManifestHash =
        "0".repeat(64);
      await expect(authorizeStableRelease({
        ...stableAuthorizationInput,
        protectedBaselineMetadata: forgedProtectedBaselineMetadata,
      })).rejects.toThrow(
        /protected semantic baseline metadata does not bind the exact finalized stable release/u,
      );
      const forgedGateProducerAttestation = structuredClone(
        stableAuthorizationInput.semanticReviewGateProducerAttestation,
      );
      forgedGateProducerAttestation.signature.value = "A".repeat(86);
      await expect(authorizeStableRelease({
        ...stableAuthorizationInput,
        semanticReviewGateProducerAttestation:
          forgedGateProducerAttestation,
      })).rejects.toThrow(
        /release gate producer attestation signature is invalid/u,
      );
      await expect(authorizeStableRelease({
        ...stableAuthorizationInput,
        approvedSemanticReviewer: {
          ...approvedReviewerTrustPolicy,
          approvedKeySha256: "0".repeat(64),
        },
      })).rejects.toThrow(
        /semantic reviewer or baseline does not match the protected semantic review policy/u,
      );
      const finalizationSourceGateNames = [
        "production_fixed_three_track",
        "production_affected_regression",
        "backend_release_convergence",
        "release_convergence",
        "final_custom_domain_browser",
      ] as const;
      const signerSummaryOnlyBundle = structuredClone(
        stableAuthorizationInput.finalizationSourceEvidence,
      ) as unknown as {
        gateArtifacts: Record<string, unknown>;
      };
      signerSummaryOnlyBundle.gateArtifacts = Object.fromEntries(
        finalizationSourceGateNames.map((gateName) => {
          const phase = gateName === "production_fixed_three_track"
              || gateName === "production_affected_regression"
              || gateName === "backend_release_convergence"
            ? promotionEvidence.payload
            : finalization.payload;
          return [
            gateName,
            phase.gates.find(({ name }) => name === gateName),
          ];
        }),
      );
      await expect(authorizeStableRelease({
        ...stableAuthorizationInput,
        finalizationSourceEvidence: signerSummaryOnlyBundle,
      })).rejects.toThrow(
        /release gate artifact contains missing or unapproved fields/u,
      );
      for (const gateName of finalizationSourceGateNames) {
        const mutatedArtifactBundle = structuredClone(
          stableAuthorizationInput.finalizationSourceEvidence,
        ) as unknown as {
          gateArtifacts: Record<
            string,
            { evidenceHash: string }
          >;
        };
        mutatedArtifactBundle.gateArtifacts[gateName]!.evidenceHash =
          "0".repeat(64);
        await expect(authorizeStableRelease({
          ...stableAuthorizationInput,
          finalizationSourceEvidence: mutatedArtifactBundle,
        })).rejects.toThrow(
          new RegExp(
            `release gate ${gateName} evidence hash does not match`,
            "u",
          ),
        );

        const mutatedAttestationBundle = structuredClone(
          stableAuthorizationInput.finalizationSourceEvidence,
        ) as unknown as {
          gateProducerAttestations: Record<
            string,
            { signature: { value: string } }
          >;
        };
        mutatedAttestationBundle.gateProducerAttestations[
          gateName
        ]!.signature.value = "A".repeat(86);
        await expect(authorizeStableRelease({
          ...stableAuthorizationInput,
          finalizationSourceEvidence: mutatedAttestationBundle,
        })).rejects.toThrow(
          /release gate producer attestation signature is invalid/u,
        );
      }
      const mutatedReceiptBundle = structuredClone(
        stableAuthorizationInput.finalizationSourceEvidence,
      ) as unknown as {
        controlPlaneReceipts: {
          apple: { signature: { value: string } };
        };
      };
      mutatedReceiptBundle.controlPlaneReceipts.apple.signature.value =
        "A".repeat(86);
      await expect(authorizeStableRelease({
        ...stableAuthorizationInput,
        finalizationSourceEvidence: mutatedReceiptBundle,
      })).rejects.toThrow(
        /Apple control-plane receipt signature is invalid/u,
      );

      for (const mutation of [
        {
          lineage: { publicRolloutFromPercent: "10" },
          runtime: { stage: "genre_scene:10->100" },
        },
        {
          lineage: {
            publicRolloutTargetConfigurationHash: "0".repeat(64),
          },
          runtime: {
            targetConfigurationHash: "0".repeat(64),
          },
        },
      ]) {
        const mutatedFinalizationPayload =
          structuredClone(finalization.payload);
        Object.assign(
          mutatedFinalizationPayload.lineage,
          mutation.lineage,
        );
        Object.assign(
          mutatedFinalizationPayload.environmentSnapshots.production!
            .publicRollout,
          mutation.runtime,
        );
        const resignedMutation = resignReleaseEvidence({
          payload: mutatedFinalizationPayload,
          signature: finalization.signature,
        }, releaseKeys.privateKey);
        await expect(authorizeStableRelease({
          ...stableAuthorizationInput,
          finalizationEvidence: resignedMutation,
          protectedBaselineMetadata:
            protectedBaselineMetadataForFinalization(resignedMutation),
        })).rejects.toThrow(
          /does not preserve the exact independently verified rollout transition/u,
        );
      }
      const changedRolloutTargetPayload =
        structuredClone(finalization.payload);
      changedRolloutTargetPayload.lineage.publicRolloutToPercent = "50";
      changedRolloutTargetPayload.environmentSnapshots.production!
        .publicRollout.stage = "genre_scene:50->50";
      expect(() => resignReleaseEvidence({
        payload: changedRolloutTargetPayload,
        signature: finalization.signature,
      }, releaseKeys.privateKey)).toThrow(
        /candidate → promotion → rollout → finalization/u,
      );

      const mutatedGateSummaryPayload =
        structuredClone(finalization.payload);
      mutatedGateSummaryPayload.gates.find(
        ({ name }) => name === "final_custom_domain_browser",
      )!.evidenceHash = "0".repeat(64);
      const resignedGateSummary = resignReleaseEvidence({
        payload: mutatedGateSummaryPayload,
        signature: finalization.signature,
      }, releaseKeys.privateKey);
      await expect(authorizeStableRelease({
        ...stableAuthorizationInput,
        finalizationEvidence: resignedGateSummary,
        protectedBaselineMetadata:
          protectedBaselineMetadataForFinalization(resignedGateSummary),
      })).rejects.toThrow(
        /source artifact final_custom_domain_browser does not match its signed release evidence/u,
      );
      const rewrittenControlPlanePayload =
        structuredClone(finalization.payload);
      rewrittenControlPlanePayload.stagingControls.controlPlaneEvidenceHash =
        "0".repeat(64);
      const resignedControlPlaneRewrite = resignReleaseEvidence({
        payload: rewrittenControlPlanePayload,
        signature: finalization.signature,
      }, releaseKeys.privateKey);
      await expect(authorizeStableRelease({
        ...stableAuthorizationInput,
        finalizationEvidence: resignedControlPlaneRewrite,
        protectedBaselineMetadata:
          protectedBaselineMetadataForFinalization(
            resignedControlPlaneRewrite,
          ),
      })).rejects.toThrow(
        /does not preserve the exact signed staging control-plane evidence/u,
      );
      const forgedCandidatePayload =
        structuredClone(candidateEvidence.payload);
      const forgedCandidateFixtures =
        forgedCandidatePayload.semanticReview.fixtures as Array<{
          fixtureId: string;
          orderedManifestHash: string;
          outputHash: string;
        }>;
      forgedCandidateFixtures[0]!.orderedManifestHash = "0".repeat(64);
      const forgedCandidateEvidence = resignReleaseEvidence({
        payload: forgedCandidatePayload,
        signature: candidateEvidence.signature,
      }, releaseKeys.privateKey);
      const forgedFinalizationPayload =
        structuredClone(finalization.payload);
      forgedFinalizationPayload.lineage.candidateEvidencePayloadHash =
        forgedCandidateEvidence.payloadHash;
      forgedFinalizationPayload.stagingControls
        .candidateEvidencePayloadHash = forgedCandidateEvidence.payloadHash;
      forgedFinalizationPayload.semanticReview =
        structuredClone(forgedCandidateEvidence.payload.semanticReview);
      const forgedFinalization = resignReleaseEvidence({
        payload: forgedFinalizationPayload,
        signature: finalization.signature,
      }, releaseKeys.privateKey);
      const releaseSignerOwnedMetadata =
        protectedBaselineMetadataForFinalization(forgedFinalization);
      await expect(authorizeStableRelease({
        ...stableAuthorizationInput,
        ...candidateSemanticAuthorizationEvidence(
          candidateDirectory,
          forgedCandidateEvidence,
        ),
        finalizationEvidence: forgedFinalization,
        protectedBaselineMetadata: releaseSignerOwnedMetadata,
      })).rejects.toThrow(
        /candidate semantic review fixtures were not mechanically derived from the independently verified candidate arms/u,
      );
      await expect(authorizeStableRelease({
        ...stableAuthorizationInput,
        generatedAt: "2026-07-23T12:47:00.000Z",
      })).rejects.toThrow(
        /Sites control-plane attestation is not currently valid/u,
      );
      const stableAuthorization = await authorizeStableRelease(
        stableAuthorizationInput,
      );
      expect(verifyStableReleaseDispatchArtifacts({
        candidateTag: "v2.4.0-rc.1",
        imageDigest: digest,
        finalizationEvidence: finalization,
        protectedBaselineMetadata,
        stableAuthorization,
        releaseVerificationKey: releaseKeys.publicKey,
        approvedReleaseKeyId: "release-2026",
        approvedReleaseKeySha256:
          stableReleaseKeyFingerprint(releaseKeys.publicKey),
        stableAuthorizationVerificationKey: stableAuthorizer.publicKey,
        approvedStableAuthorizerKeyId:
          stableAuthorization.signature.keyId,
        approvedStableAuthorizerKeySha256:
          stableReleaseKeyFingerprint(stableAuthorizer.publicKey),
        now: String(stableAuthorization.payload.generatedAt),
      })).toMatchObject({
        candidate: {
          rcTag: "v2.4.0-rc.1",
          imageDigest: digest,
        },
      });
      expect(() => verifyStableReleaseDispatchArtifacts({
        candidateTag: "v2.4.0-rc.1",
        imageDigest: digest,
        finalizationEvidence: {},
        protectedBaselineMetadata,
        stableAuthorization,
        releaseVerificationKey: releaseKeys.publicKey,
        approvedReleaseKeyId: "release-2026",
        approvedReleaseKeySha256:
          stableReleaseKeyFingerprint(releaseKeys.publicKey),
        stableAuthorizationVerificationKey: stableAuthorizer.publicKey,
        approvedStableAuthorizerKeyId:
          stableAuthorization.signature.keyId,
        approvedStableAuthorizerKeySha256:
          stableReleaseKeyFingerprint(stableAuthorizer.publicKey),
      })).toThrow(/signed finalization evidence/u);
      const dispatch = buildStableReleaseDispatchRequest({
        candidateTag: "v2.4.0-rc.1",
        imageDigest: digest,
        finalizationEvidence: Buffer.from(
          `${JSON.stringify(finalization, null, 2)}\n`,
        ),
        protectedBaselineMetadata: Buffer.from(
          `${JSON.stringify(protectedBaselineMetadata, null, 2)}\n`,
        ),
        stableAuthorization: Buffer.from(
          `${JSON.stringify(stableAuthorization, null, 2)}\n`,
        ),
      });
      expect(Object.keys(dispatch.client_payload)).toHaveLength(5);
      expect(Buffer.byteLength(
        JSON.stringify(dispatch.client_payload),
        "utf8",
      )).toBeLessThan(GITHUB_CLIENT_PAYLOAD_MAX_BYTES);
    } finally {
      rmSync(candidateDirectory, { recursive: true, force: true });
      rmSync(promotionDirectory, { recursive: true, force: true });
      rmSync(finalizationDirectory, { recursive: true, force: true });
    }
  });

  test("invalidates otherwise valid evidence when runtime or configuration changes", async () => {
    const keys = generateKeyPairSync("ed25519");
    const directory = mkdtempSync(join(tmpdir(), "genio-release-sign-"));
    try {
      const bundle = JSON.parse(readFileSync(writeSigningBundle(directory), "utf8"));
      const signed = await signReleaseEvidenceBundle(
        bundle,
        directory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
        keys.privateKey,
        "release-2026",
        releaseAuthoringAuthority(keys.publicKey, bundle),
      );
      expect(() => verifyReleaseEvidence(signed, keys.publicKey, {
        expectedKind: "candidate",
        now: "2026-07-23T12:30:00.000Z",
        expectedConfigurationHash: "d".repeat(64),
      })).toThrow(/configuration does not match/u);
      expect(() => verifyReleaseEvidence(signed, keys.publicKey, {
        expectedKind: "candidate",
        now: "2026-07-23T12:30:00.000Z",
        expectedRuntimeHash: "e".repeat(64),
      })).toThrow(/runtime does not match/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects model and semantic-policy drift after independent review", async () => {
    const keys = generateKeyPairSync("ed25519");
    const candidateDirectory = mkdtempSync(
      join(tmpdir(), "genio-semantic-behavior-candidate-"),
    );
    const driftedPromotionDirectory = mkdtempSync(
      join(tmpdir(), "genio-semantic-behavior-promotion-drift-"),
    );
    const promotionDirectory = mkdtempSync(
      join(tmpdir(), "genio-semantic-behavior-promotion-"),
    );
    const driftedFinalizationDirectory = mkdtempSync(
      join(tmpdir(), "genio-semantic-behavior-finalization-drift-"),
    );
    try {
      const candidateBundle = JSON.parse(readFileSync(
        writeSigningBundle(candidateDirectory),
        "utf8",
      ));
      const candidate = await signReleaseEvidenceBundle(
        candidateBundle,
        candidateDirectory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
        keys.privateKey,
        "release-2026",
        releaseAuthoringAuthority(keys.publicKey, candidateBundle),
      );
      const driftedPromotionBundle = JSON.parse(readFileSync(
        writeSigningBundle(
          driftedPromotionDirectory,
          "promotion",
          {
            priorReleaseEvidence: candidate,
            mutatePayload: (value) => {
              value.runtime.modelIds.baseline = "gpt-5.6-terra";
            },
          },
        ),
        "utf8",
      ));
      await expect(signReleaseEvidenceBundle(
        driftedPromotionBundle,
        driftedPromotionDirectory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
        keys.privateKey,
        "release-2026",
        releaseAuthoringAuthority(
          keys.publicKey,
          driftedPromotionBundle,
        ),
      )).rejects.toThrow(
        /semantic behavior changed after the reviewed candidate phase/u,
      );

      const promotionBundle = JSON.parse(readFileSync(
        writeSigningBundle(promotionDirectory, "promotion", {
          priorReleaseEvidence: candidate,
        }),
        "utf8",
      ));
      const promotion = await signReleaseEvidenceBundle(
        promotionBundle,
        promotionDirectory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
        keys.privateKey,
        "release-2026",
        releaseAuthoringAuthority(keys.publicKey, promotionBundle),
      );
      const publicRolloutEvidence = completedPublicRolloutEvidence(
        promotion as any,
        keys.privateKey,
      );
      const driftedFinalizationBundle = JSON.parse(readFileSync(
        writeSigningBundle(
          driftedFinalizationDirectory,
          "finalization",
          {
            priorReleaseEvidence: promotion,
            publicRolloutEvidence,
            mutatePayload: (value) => {
              value.runtime.policyVersions.selection =
                "selection_plan_v3_drifted";
            },
          },
        ),
        "utf8",
      ));
      await expect(signReleaseEvidenceBundle(
        driftedFinalizationBundle,
        driftedFinalizationDirectory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
        keys.privateKey,
        "release-2026",
        releaseAuthoringAuthority(
          keys.publicKey,
          driftedFinalizationBundle,
        ),
      )).rejects.toThrow(
        /semantic behavior changed after the reviewed candidate phase/u,
      );
    } finally {
      rmSync(candidateDirectory, { recursive: true, force: true });
      rmSync(driftedPromotionDirectory, { recursive: true, force: true });
      rmSync(promotionDirectory, { recursive: true, force: true });
      rmSync(driftedFinalizationDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  test("rejects tampering, expiry, and a signature for another key", async () => {
    const keys = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const directory = mkdtempSync(join(tmpdir(), "genio-release-sign-"));
    try {
      const bundle = JSON.parse(readFileSync(writeSigningBundle(directory), "utf8"));
      const signed = await signReleaseEvidenceBundle(
        bundle,
        directory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
        keys.privateKey,
        "release-2026",
        releaseAuthoringAuthority(keys.publicKey, bundle),
      );
      expect(() => verifyReleaseEvidence({
        ...signed,
        payload: {
          ...signed.payload,
          candidate: { ...signed.payload.candidate, imageDigest: `sha256:${"d".repeat(64)}` },
        },
      }, keys.publicKey, {
        expectedKind: "candidate",
        now: "2026-07-23T12:30:00.000Z",
      })).toThrow(/candidate artifact|payload hash/u);
      expect(() => verifyReleaseEvidence(signed, other.publicKey, {
        expectedKind: "candidate",
        now: "2026-07-23T12:30:00.000Z",
      })).toThrow(/signature is invalid/u);
      expect(() => verifyReleaseEvidence(signed, keys.publicKey, {
        expectedKind: "candidate",
        now: expiresAt,
      })).toThrow(/expired/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("requires and enforces the caller's expected evidence kind", async () => {
    const keys = generateKeyPairSync("ed25519");
    const candidateDirectory = mkdtempSync(join(tmpdir(), "genio-release-sign-candidate-"));
    const promotionDirectory = mkdtempSync(join(tmpdir(), "genio-release-sign-promotion-"));
    const finalizationDirectory = mkdtempSync(
      join(tmpdir(), "genio-release-sign-finalization-"),
    );
    try {
      const candidateBundle = JSON.parse(readFileSync(writeSigningBundle(candidateDirectory), "utf8"));
      const candidate = await signReleaseEvidenceBundle(
        candidateBundle,
        candidateDirectory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
        keys.privateKey,
        "release-2026",
        releaseAuthoringAuthority(keys.publicKey, candidateBundle),
      );
      const candidateSemanticEvidence =
        candidateSemanticAuthorizationEvidence(
          candidateDirectory,
          candidate,
        );
      expect(() => verifyReleaseEvidence(
        candidate,
        keys.publicKey,
        undefined as never,
      )).toThrow(
        /requires an expected candidate, promotion, or finalization kind/u,
      );
      expect(() => verifyReleaseEvidence(candidate, keys.publicKey, {
        expectedKind: "promotion",
        now: "2026-07-23T12:30:00.000Z",
      })).toThrow(/kind candidate does not match expected promotion/u);

      const promotionBundle = JSON.parse(
        readFileSync(writeSigningBundle(promotionDirectory, "promotion", {
          priorReleaseEvidence: candidate,
        }), "utf8"),
      );
      const promotion = await signReleaseEvidenceBundle(
        promotionBundle,
        promotionDirectory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
        keys.privateKey,
        "release-2026",
        releaseAuthoringAuthority(keys.publicKey, promotionBundle),
      );
      const verifiedPromotion = verifyReleaseEvidence(
        promotion,
        keys.publicKey,
        {
        expectedKind: "promotion",
        now: "2026-07-23T12:30:00.000Z",
        },
      );
      expect(verifiedPromotion).toMatchObject({ kind: "promotion" });
      expect(verifiedPromotion.gates.map(({ name }) => name))
        .not.toContain("final_custom_domain_browser");

      const publicRolloutEvidence = completedPublicRolloutEvidence(
        promotion as any,
        keys.privateKey,
      );
      const finalizationBundle = JSON.parse(
        readFileSync(
          writeSigningBundle(finalizationDirectory, "finalization", {
            priorReleaseEvidence: promotion,
            publicRolloutEvidence,
          }),
          "utf8",
        ),
      );
      await expect(signReleaseEvidenceBundle(
        finalizationBundle,
        finalizationDirectory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        {
          ...approvedSitesControlPlaneTrustPolicy,
          approvedKeySha256: "0".repeat(64),
        },
        strictGithubOfflineVerifier,
        keys.privateKey,
        "release-2026",
        releaseAuthoringAuthority(keys.publicKey, finalizationBundle),
      )).rejects.toThrow(/protected approved key/u);
      const finalization = await signReleaseEvidenceBundle(
        finalizationBundle,
        finalizationDirectory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
        keys.privateKey,
        "release-2026",
        releaseAuthoringAuthority(keys.publicKey, finalizationBundle),
      );
      expect(verifyReleaseEvidence(finalization, keys.publicKey, {
        expectedKind: "finalization",
        now: "2026-07-23T12:45:00.000Z",
      }).gates.map(({ name }) => name))
        .toContain("final_custom_domain_browser");
      expect(() => verifyReleaseEvidence(promotion, keys.publicKey, {
        expectedKind: "finalization",
        now: "2026-07-23T12:30:00.000Z",
      })).toThrow(/kind promotion does not match expected finalization/u);
      const stableAuthorizer = generateKeyPairSync("ed25519");
      const protectedBaselineMetadata =
        protectedBaselineMetadataForFinalization(finalization);
      const protectedBaselineMetadataHash =
        semanticRankingProtectedBaselineMetadataSha256(
          protectedBaselineMetadata,
        );
      await expect(authorizeStableRelease({
        ...candidateSemanticEvidence,
        ...stableFinalizationSourceEvidence(
          promotionDirectory,
          finalizationDirectory,
          promotion,
          publicRolloutEvidence,
        ),
        finalizationEvidence: finalization,
        protectedBaselineMetadata,
        releaseVerificationKey: keys.publicKey,
        approvedReleaseKeySha256:
          stableReleaseKeyFingerprint(keys.publicKey),
        authorizerSigningKey: stableAuthorizer.privateKey,
        approvedAuthorizerKeyId: "stable-authorizer-test-v1",
        approvedAuthorizerKeySha256:
          stableReleaseKeyFingerprint(stableAuthorizer.publicKey),
        expectedRcTag: payload().candidate.tag,
        expectedVersion: payload().candidate.version,
        expectedRevision: revision,
        expectedImageDigest: digest,
        generatedAt: "2026-07-23T12:39:00.000Z",
      })).rejects.toThrow(/cannot predate finalization/u);
      const stableAuthorization = await authorizeStableRelease({
        ...candidateSemanticEvidence,
        ...stableFinalizationSourceEvidence(
          promotionDirectory,
          finalizationDirectory,
          promotion,
          publicRolloutEvidence,
        ),
        finalizationEvidence: finalization,
        protectedBaselineMetadata,
        releaseVerificationKey: keys.publicKey,
        approvedReleaseKeySha256:
          stableReleaseKeyFingerprint(keys.publicKey),
        authorizerSigningKey: stableAuthorizer.privateKey,
        approvedAuthorizerKeyId: "stable-authorizer-test-v1",
        approvedAuthorizerKeySha256:
          stableReleaseKeyFingerprint(stableAuthorizer.publicKey),
        expectedRcTag: payload().candidate.tag,
        expectedVersion: payload().candidate.version,
        expectedRevision: revision,
        expectedImageDigest: digest,
        generatedAt: "2026-07-23T12:45:00.000Z",
      });
      expect(verifyStableReleaseAuthorization({
        value: stableAuthorization,
        verificationKey: stableAuthorizer.publicKey,
        approvedKeyId: "stable-authorizer-test-v1",
        approvedKeySha256:
          stableReleaseKeyFingerprint(stableAuthorizer.publicKey),
        expectedRevision: revision,
        expectedImageDigest: digest,
        expectedRcTag: payload().candidate.tag,
        expectedFinalizationEvidencePayloadHash:
          finalization.payloadHash,
        expectedProtectedBaselineMetadataHash:
          protectedBaselineMetadataHash,
        now: "2026-07-23T12:45:00.000Z",
      })).toMatchObject({
        action: "create_stable_tag_and_github_release",
        finalizationEvidencePayloadHash: finalization.payloadHash,
      });
      const stableDispatch = buildStableReleaseDispatchRequest({
        candidateTag: payload().candidate.tag,
        imageDigest: digest,
        finalizationEvidence: Buffer.from(JSON.stringify(finalization)),
        protectedBaselineMetadata:
          Buffer.from(JSON.stringify(protectedBaselineMetadata)),
        stableAuthorization:
          Buffer.from(JSON.stringify(stableAuthorization)),
      });
      expect(Object.keys(stableDispatch.client_payload)).toHaveLength(5);
      expect(Buffer.byteLength(
        JSON.stringify(stableDispatch.client_payload),
        "utf8",
      )).toBeLessThan(GITHUB_CLIENT_PAYLOAD_MAX_BYTES);
      expect(verifyStableReleaseConsumerBundle({
        finalizationEvidence: finalization,
        protectedBaselineMetadata,
        releaseVerificationKey: keys.publicKey,
        approvedReleaseKeySha256:
          stableReleaseKeyFingerprint(keys.publicKey),
        stableAuthorization,
        stableAuthorizationVerificationKey: stableAuthorizer.publicKey,
        approvedStableAuthorizerKeyId: "stable-authorizer-test-v1",
        approvedStableAuthorizerKeySha256:
          stableReleaseKeyFingerprint(stableAuthorizer.publicKey),
        expectedRcTag: payload().candidate.tag,
        expectedVersion: payload().candidate.version,
        expectedRevision: revision,
        expectedImageDigest: digest,
        expectedImageReference:
          `ghcr.io/hooterjackson/genio@${digest}`,
        now: "2026-07-23T12:45:00.000Z",
      })).toMatchObject({
        schemaVersion: "genio-stable-release-consumer-manifest/v2",
        candidate: {
          stableTag: "v2.4.0",
          sourceRevision: revision,
          imageDigest: digest,
        },
        finalizationEvidencePayloadHash: finalization.payloadHash,
        stableAuthorizationPayloadHash: stableAuthorization.payloadHash,
      });
      expect(() => verifyStableReleaseConsumerBundle({
        finalizationEvidence: finalization,
        protectedBaselineMetadata,
        releaseVerificationKey: keys.publicKey,
        approvedReleaseKeySha256:
          stableReleaseKeyFingerprint(keys.publicKey),
        stableAuthorization,
        stableAuthorizationVerificationKey: stableAuthorizer.publicKey,
        approvedStableAuthorizerKeyId: "stable-authorizer-test-v1",
        approvedStableAuthorizerKeySha256:
          stableReleaseKeyFingerprint(stableAuthorizer.publicKey),
        expectedRcTag: payload().candidate.tag,
        expectedVersion: payload().candidate.version,
        expectedRevision: revision,
        expectedImageDigest: digest,
        expectedImageReference:
          `ghcr.io/hooterjackson/genio@${digest}`,
        now: "2026-07-25T12:45:00.000Z",
      })).toThrow(/expired/u);
      expect(verifyHistoricalStableReleaseConsumerBundle({
        finalizationEvidence: finalization,
        protectedBaselineMetadata,
        releaseVerificationKey: keys.publicKey,
        approvedReleaseKeySha256:
          stableReleaseKeyFingerprint(keys.publicKey),
        stableAuthorization,
        stableAuthorizationVerificationKey: stableAuthorizer.publicKey,
        approvedStableAuthorizerKeyId: "stable-authorizer-test-v1",
        approvedStableAuthorizerKeySha256:
          stableReleaseKeyFingerprint(stableAuthorizer.publicKey),
        expectedRcTag: payload().candidate.tag,
        expectedVersion: payload().candidate.version,
        expectedRevision: revision,
        expectedImageDigest: digest,
        expectedImageReference:
          `ghcr.io/hooterjackson/genio@${digest}`,
        now: "2026-07-25T12:45:00.000Z",
      })).toMatchObject({
        verifiedAt: "2026-07-23T12:45:00.000Z",
        protectedBaselineMetadataHash,
      });
      expect(() => verifyHistoricalStableReleaseConsumerBundle({
        finalizationEvidence: finalization,
        protectedBaselineMetadata,
        releaseVerificationKey: keys.publicKey,
        approvedReleaseKeySha256:
          stableReleaseKeyFingerprint(keys.publicKey),
        stableAuthorization,
        stableAuthorizationVerificationKey: stableAuthorizer.publicKey,
        approvedStableAuthorizerKeyId: "stable-authorizer-test-v1",
        approvedStableAuthorizerKeySha256:
          stableReleaseKeyFingerprint(stableAuthorizer.publicKey),
        expectedRcTag: payload().candidate.tag,
        expectedVersion: payload().candidate.version,
        expectedRevision: revision,
        expectedImageDigest: digest,
        expectedImageReference:
          `ghcr.io/hooterjackson/genio@${digest}`,
        now: "2026-07-23T12:44:00.000Z",
      })).toThrow(/future-dated/u);
      expect(() => verifyStableReleaseConsumerBundle({
        finalizationEvidence: finalization,
        protectedBaselineMetadata,
        releaseVerificationKey: keys.publicKey,
        approvedReleaseKeySha256:
          stableReleaseKeyFingerprint(keys.publicKey),
        stableAuthorization,
        stableAuthorizationVerificationKey: stableAuthorizer.publicKey,
        approvedStableAuthorizerKeyId: "stable-authorizer-test-v1",
        approvedStableAuthorizerKeySha256:
          stableReleaseKeyFingerprint(stableAuthorizer.publicKey),
        expectedRcTag: payload().candidate.tag,
        expectedVersion: payload().candidate.version,
        expectedRevision: revision,
        expectedImageDigest: digest,
        expectedImageReference:
          `ghcr.io/other/genio@${digest}`,
        now: "2026-07-23T12:45:00.000Z",
      })).toThrow(/exact stable release target/u);
      await expect(authorizeStableRelease({
        ...candidateSemanticEvidence,
        ...stableFinalizationSourceEvidence(
          promotionDirectory,
          finalizationDirectory,
          promotion,
          publicRolloutEvidence,
        ),
        finalizationEvidence: promotion,
        protectedBaselineMetadata,
        releaseVerificationKey: keys.publicKey,
        approvedReleaseKeySha256:
          stableReleaseKeyFingerprint(keys.publicKey),
        authorizerSigningKey: stableAuthorizer.privateKey,
        approvedAuthorizerKeyId: "stable-authorizer-test-v1",
        approvedAuthorizerKeySha256:
          stableReleaseKeyFingerprint(stableAuthorizer.publicKey),
        expectedRcTag: payload().candidate.tag,
        expectedVersion: payload().candidate.version,
        expectedRevision: revision,
        expectedImageDigest: digest,
        generatedAt: "2026-07-23T12:45:00.000Z",
      })).rejects.toThrow(
        /kind promotion does not match expected finalization/u,
      );
    } finally {
      rmSync(candidateDirectory, { recursive: true, force: true });
      rmSync(promotionDirectory, { recursive: true, force: true });
      rmSync(finalizationDirectory, { recursive: true, force: true });
    }
  });

  test("derives signed gates only from exact-parsed, snapshot-bound artifacts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "genio-release-bundle-"));
    try {
      const bundlePath = writeSigningBundle(directory);
      const bundle = JSON.parse(
        await import("node:fs/promises").then(({ readFile }) => readFile(bundlePath, "utf8")),
      );
      const derived = await loadReleaseEvidenceSigningBundle(
        bundle,
        directory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
      );
      expect(derived.gates).toHaveLength(7);
      expect(derived.gates.find(({ name }) => (
        name === "staging_historical_replay"
      ))).toMatchObject({
        environment: "staging",
        passed: true,
        cacheMode: "reuse_disabled",
        budgetStatus: "within_cap",
      });
      expect(derived.gates.find(({ name }) => name === "staging_affected_regression"))
        .toMatchObject({
          cacheMode: "reuse_disabled",
          fixtures: [{
            fixtureId: "smooth-reggaeton-heat-50-v1",
            targetTrackCount: 50,
            guidanceMode: "recommended",
            guidanceLineageHash: "7".repeat(64),
          }],
        });
      expect(derived.environmentSnapshots.production).toBeNull();
      expect(derived.configuration)
        .toEqual(payload().configuration);
      expect(derived.stagingControls).toMatchObject({
        providerSecretVersionHash: "1".repeat(64),
        productionProviderSecretVersionHash: "2".repeat(64),
        appleSecretVersionHash: "3".repeat(64),
        productionAppleSecretVersionHash: "4".repeat(64),
        controlPlaneEvidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        controlPlaneKeyId:
          approvedStagingControlPlaneTrustPolicy.approvedKeyId,
        controlPlaneKeyFingerprint:
          approvedStagingControlPlaneTrustPolicy.approvedKeySha256,
      });
      await expect(loadReleaseEvidenceSigningBundle(
        {
          ...bundle,
          runtimeSnapshotFiles: {
            ...bundle.runtimeSnapshotFiles,
            staging: "../runtime-staging.json",
          },
        },
        directory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
      )).rejects.toThrow(/normalized relative path without traversal/u);
      await expect(loadReleaseEvidenceSigningBundle(
        bundle,
        directory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        {
          ...approvedReviewerTrustPolicy,
          approvedKeySha256: "f".repeat(64),
        },
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
      )).rejects.toThrow(/protected semantic review policy/u);
      await expect(loadReleaseEvidenceSigningBundle(
        bundle,
        directory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        {
          ...approvedReviewerTrustPolicy,
          approvedBaselineMetadataSha256: "f".repeat(64),
        },
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
      )).rejects.toThrow(/protected semantic review policy/u);
      await expect(loadReleaseEvidenceSigningBundle(
        bundle,
        directory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        {
          ...approvedHistoricalReplayTrustPolicy,
          approvedKeySha256: "f".repeat(64),
        },
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
      )).rejects.toThrow(/historical replay producer.*protected approved key/u);
      await expect(loadReleaseEvidenceSigningBundle(
        bundle,
        directory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        {
          ...approvedStagingControlPlaneTrustPolicy,
          approvedKeySha256: "0".repeat(64),
        },
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
      )).rejects.toThrow(/protected approved key/u);
      await expect(loadReleaseEvidenceSigningBundle(
        { ...bundle, stagingControls: payload().stagingControls },
        directory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
      )).rejects.toThrow(/unapproved fields/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects opaque gates, mutated inner proofs, and generic fixture substitution", async () => {
    const directory = mkdtempSync(join(tmpdir(), "genio-release-bundle-invalid-"));
    try {
      const bundlePath = writeSigningBundle(directory);
      const { readFileSync } = await import("node:fs");
      const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
      const wrongProducer = generateKeyPairSync("ed25519");
      for (const gateName of Object.keys(bundle.gateArtifactFiles)) {
        const artifact = JSON.parse(readFileSync(
          join(directory, bundle.gateArtifactFiles[gateName]),
          "utf8",
        ));
        writeFileSync(
          join(directory, bundle.gateAttestationFiles[gateName]),
          JSON.stringify(attestReleaseGateArtifact(
            artifact,
            wrongProducer.privateKey,
            "wrong-producer-2026",
          )),
        );
      }
      await expect(loadReleaseEvidenceSigningBundle(
        bundle,
        directory,
        wrongProducer.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
      )).rejects.toThrow(/protected approved key/u);
      writeSigningBundle(directory);
      const attestationPath = join(
        directory,
        bundle.gateAttestationFiles.staging_affected_regression,
      );
      const affectedPath = join(directory, "gate-staging_affected_regression.json");
      const affectedArtifact = JSON.parse(readFileSync(affectedPath, "utf8"));
      writeFileSync(
        attestationPath,
        JSON.stringify(attestReleaseGateArtifact(
          affectedArtifact,
          wrongProducer.privateKey,
          "wrong-producer-2026",
        )),
      );
      await expect(loadReleaseEvidenceSigningBundle(
        bundle,
        directory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
      )).rejects.toThrow(/producer attestation signature is invalid/u);

      writeSigningBundle(directory);
      await expect(loadReleaseEvidenceSigningBundle({
        ...bundle,
        gates: payload().gates,
      }, directory, producerKeys.publicKey, approvedProducerTrustPolicy,
      approvedReviewerTrustPolicy,
      approvedHistoricalReplayTrustPolicy,
      approvedStagingControlPlaneTrustPolicy,
      approvedSitesControlPlaneTrustPolicy,
      strictGithubOfflineVerifier))
        .rejects.toThrow(/unapproved fields/u);

      const affected = JSON.parse(readFileSync(affectedPath, "utf8"));
      affected.proof.assertions.reggaeton_question_semantics = false;
      writeFileSync(affectedPath, JSON.stringify(affected));
      await expect(loadReleaseEvidenceSigningBundle(
        bundle,
        directory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
      ))
        .rejects.toThrow(/unsuccessful assertion|proof hash/u);

      writeSigningBundle(directory);
      const substituted = JSON.parse(readFileSync(affectedPath, "utf8"));
      substituted.fixtures[0].promptHash = "f".repeat(64);
      const unsigned = { ...substituted };
      delete unsigned.evidenceHash;
      substituted.evidenceHash = sha256(unsigned);
      writeFileSync(affectedPath, JSON.stringify(substituted));
      await expect(loadReleaseEvidenceSigningBundle(
        bundle,
        directory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
      ))
        .rejects.toThrow(/immutable definition/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the signing CLI rejects hand-authored and stale typed bundles", () => {
    const keys = generateKeyPairSync("ed25519");
    const directory = mkdtempSync(join(tmpdir(), "genio-release-signing-cli-"));
    installStrictGithubCliFake(directory);
    const cliEnvironment = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ""}`,
      RELEASE_VERIFICATION_KEY_ID: "release-2026",
      RELEASE_VERIFICATION_KEY_SHA256:
        stableReleaseKeyFingerprint(keys.publicKey),
      RELEASE_GATE_PRODUCER_KEY_ID:
        approvedProducerTrustPolicy.approvedKeyId,
      RELEASE_GATE_PRODUCER_KEY_SHA256:
        approvedProducerTrustPolicy.approvedKeySha256,
      RELEASE_SEMANTIC_REVIEWER_KEY_ID:
        approvedReviewerTrustPolicy.approvedKeyId,
      RELEASE_SEMANTIC_REVIEWER_KEY_SHA256:
        approvedReviewerTrustPolicy.approvedKeySha256,
      RELEASE_SEMANTIC_BASELINE_METADATA_SHA256:
        approvedReviewerTrustPolicy.approvedBaselineMetadataSha256,
      RELEASE_SEMANTIC_BASELINE_STABLE_TAG:
        approvedReviewerTrustPolicy.approvedBaselineStableTag,
      RELEASE_SEMANTIC_BASELINE_RELEASE_KEY_SHA256:
        approvedReviewerTrustPolicy.approvedBaselineReleaseKeySha256,
      RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_ID:
        approvedReviewerTrustPolicy
          .approvedBaselineStableAuthorizerKeyId,
      RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_SHA256:
        approvedReviewerTrustPolicy
          .approvedBaselineStableAuthorizerKeySha256,
      RELEASE_HISTORICAL_REPLAY_KEY_ID:
        approvedHistoricalReplayTrustPolicy.approvedKeyId,
      RELEASE_HISTORICAL_REPLAY_KEY_SHA256:
        approvedHistoricalReplayTrustPolicy.approvedKeySha256,
      RELEASE_STAGING_CONTROL_PLANE_KEY_ID:
        approvedStagingControlPlaneTrustPolicy.approvedKeyId,
      RELEASE_STAGING_CONTROL_PLANE_KEY_SHA256:
        approvedStagingControlPlaneTrustPolicy.approvedKeySha256,
      RELEASE_SITES_CONTROL_PLANE_KEY_ID:
        approvedSitesControlPlaneTrustPolicy.approvedKeyId,
      RELEASE_SITES_CONTROL_PLANE_KEY_SHA256:
        approvedSitesControlPlaneTrustPolicy.approvedKeySha256,
    };
    try {
      const privateKeyPath = join(directory, "signing-key.pem");
      const producerPublicKeyPath = join(directory, "producer-key.pub.pem");
      const outputPath = join(directory, "signed.json");
      writeFileSync(privateKeyPath, keys.privateKey.export({
        type: "pkcs8",
        format: "pem",
      }), { mode: 0o600 });
      writeFileSync(producerPublicKeyPath, producerKeys.publicKey.export({
        type: "spki",
        format: "pem",
      }));
      const opaquePath = join(directory, "opaque-payload.json");
      writeFileSync(opaquePath, JSON.stringify(payload()));
      const command = fileURLToPath(new URL("../scripts/release-evidence.ts", import.meta.url));
      const rejected = spawnSync(process.execPath, [
        "--experimental-transform-types",
        command,
        "sign",
        "--input",
        opaquePath,
        "--output",
        outputPath,
        "--private-key",
        privateKeyPath,
        "--producer-public-key",
        producerPublicKeyPath,
        "--key-id",
        "release-2026",
      ], { encoding: "utf8", env: cliEnvironment });
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain("signing bundle");

      const bundlePath = writeSigningBundle(directory);
      const accepted = spawnSync(process.execPath, [
        "--experimental-transform-types",
        command,
        "sign",
        "--input",
        bundlePath,
        "--output",
        outputPath,
        "--private-key",
        privateKeyPath,
        "--producer-public-key",
        producerPublicKeyPath,
        "--key-id",
        "release-2026",
      ], { encoding: "utf8", env: cliEnvironment });
      expect(accepted.status).toBe(1);
      expect(accepted.stderr).toMatch(/expired|evidence window/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the verification CLI fails closed when --expected-kind is omitted", async () => {
    const keys = generateKeyPairSync("ed25519");
    const directory = mkdtempSync(join(tmpdir(), "genio-release-evidence-"));
    try {
      const bundle = JSON.parse(readFileSync(writeSigningBundle(directory), "utf8"));
      const signed = await signReleaseEvidenceBundle(
        bundle,
        directory,
        producerKeys.publicKey,
        approvedProducerTrustPolicy,
        approvedReviewerTrustPolicy,
        approvedHistoricalReplayTrustPolicy,
        approvedStagingControlPlaneTrustPolicy,
        approvedSitesControlPlaneTrustPolicy,
        strictGithubOfflineVerifier,
        keys.privateKey,
        "release-2026",
        releaseAuthoringAuthority(keys.publicKey, bundle),
      );
      const evidencePath = join(directory, "evidence.json");
      const publicKeyPath = join(directory, "verification-key.pem");
      writeFileSync(evidencePath, JSON.stringify(signed));
      writeFileSync(publicKeyPath, keys.publicKey.export({
        type: "spki",
        format: "pem",
      }));
      const result = spawnSync(process.execPath, [
        "--experimental-transform-types",
        fileURLToPath(new URL("../scripts/release-evidence.ts", import.meta.url)),
        "verify",
        "--input",
        evidencePath,
        "--public-key",
        publicKeyPath,
        "--expected-revision",
        revision,
        "--expected-image-digest",
        digest,
        "--expected-tag",
        "v2.4.0-rc.1",
        "--expected-configuration-hash",
        releaseEvidenceConfigurationHash(signed.payload),
        "--expected-runtime-hash",
        releaseEvidenceRuntimeHash(signed.payload),
      ], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "--expected-kind must be supplied exactly once",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("allows no raw prompts, run IDs, arbitrary labels, or incomplete promotion gates", () => {
    expect(() => validateReleaseEvidencePayload({
      ...payload(),
      runtime: {
        ...payload().runtime,
        releaseEnvironment: "production",
      },
    })).toThrow(/runtime\.releaseEnvironment must be staging/u);
    expect(() => validateReleaseEvidencePayload({
      ...payload(),
      rawPrompt: "make a playlist",
    })).toThrow(/unapproved fields/u);
    expect(() => validateReleaseEvidencePayload({
      ...payload(),
      runtime: {
        ...payload().runtime,
        modelIds: {
          ...payload().runtime.modelIds,
          brief: "sk-secret",
        },
      },
    })).toThrow(/approved release label/u);
    expect(() => validateReleaseEvidencePayload({
      ...payload("promotion"),
      kind: "promotion",
      gates: payload().gates.map((item: Record<string, unknown>) => ({
        ...item,
        completedAt: phaseGeneratedAt.promotion,
      })),
    })).toThrow(/gates do not match promotion/u);
    expect(() => validateReleaseEvidencePayload({
      ...payload(),
      runtime: {
        ...payload().runtime,
        queryPlanSchemaVersion: "3",
      },
    })).toThrow(/schema-19\/protocol-11 release contract/u);
    for (const [field, value] of [
      ["guidance", "intelligent_guidance_v2"],
      ["evidence", "governed_evidence_v1"],
    ] as const) {
      expect(() => validateReleaseEvidencePayload({
        ...payload(),
        runtime: {
          ...payload().runtime,
          policyVersions: {
            ...payload().runtime.policyVersions,
            [field]: value,
          },
        },
      })).toThrow(new RegExp(`policyVersions\\.${field}.*release contract`, "u"));
    }
  });

  test("requires composite capability 2 and both authoritative marker-1 values", () => {
    for (const [field, expected] of [
      ["databaseCapabilityVersion", "2"],
      ["releaseManifestCanaryGuardsVersion", "1"],
      ["canonicalExecutionHardeningVersion", "1"],
    ] as const) {
      const validRuntime = payload().runtime;
      expect(() => validateReleaseEvidencePayload({
        ...payload(),
        runtime: {
          ...validRuntime,
          [field]: "unexpected",
        },
      })).toThrow(new RegExp(`runtime\\.${field}.*release contract`, "u"));
      expect(() => validateReleaseEvidencePayload({
        ...payload(),
        runtime: Object.fromEntries(
          Object.entries(validRuntime).filter(([key]) => key !== field),
        ),
      })).toThrow(/runtime contains missing or unapproved fields/u);
      expect(validRuntime[field]).toBe(expected);
    }
  });

  test("rejects stale or unauthorized finalization rollout snapshot bindings", () => {
    for (const publicRollout of [
      {
        ...payload("finalization").environmentSnapshots.production!
          .publicRollout,
        evidenceHash: "0".repeat(64),
      },
      {
        ...payload("finalization").environmentSnapshots.production!
          .publicRollout,
        stage: "genre_scene:10->50",
      },
      {
        ...payload("finalization").environmentSnapshots.production!
          .publicRollout,
        databaseAuthorized: false,
      },
    ]) {
      const value = payload("finalization");
      value.environmentSnapshots.production!.publicRollout =
        publicRollout;
      expect(() => validateReleaseEvidencePayload(value))
        .toThrow(/public rollout|database authority/u);
    }
  });

  test("preserves the exact rollout transition in signed finalization lineage", () => {
    expect(validateReleaseEvidencePayload(payload("finalization")).lineage)
      .toMatchObject({
        publicRolloutIntentGroup: "genre_scene",
        publicRolloutFromPercent: "50",
        publicRolloutToPercent: "100",
        publicRolloutTargetConfigurationHash: "4".repeat(64),
      });
    const changedFrom = payload("finalization");
    changedFrom.lineage.publicRolloutFromPercent = "10";
    expect(() => validateReleaseEvidencePayload(changedFrom))
      .toThrow(/does not bind its signed public rollout lineage/u);

    const changedConfiguration = payload("finalization");
    changedConfiguration.lineage.publicRolloutTargetConfigurationHash =
      "0".repeat(64);
    expect(() => validateReleaseEvidencePayload(changedConfiguration))
      .toThrow(/does not bind its signed public rollout lineage/u);

    const nonFinalTarget = payload("finalization");
    nonFinalTarget.lineage.publicRolloutToPercent = "50";
    nonFinalTarget.environmentSnapshots.production!.publicRollout.stage =
      "genre_scene:50->50";
    expect(() => validateReleaseEvidencePayload(nonFinalTarget))
      .toThrow(/candidate → promotion → rollout → finalization/u);

    const missingTransition = structuredClone(payload("finalization"));
    delete (missingTransition.lineage as Partial<
      typeof missingTransition.lineage
    >).publicRolloutTargetConfigurationHash;
    expect(() => validateReleaseEvidencePayload(missingTransition))
      .toThrow(/lineage contains missing or unapproved fields/u);
  });

  test("exactly binds finalization runtime rollout hash, stage, and target configuration", () => {
    const signedRollout = {
      payloadHash: "1".repeat(64),
      intentGroup: "genre_scene",
      fromPercent: "50",
      toPercent: "100",
      targetConfigurationHash: "2".repeat(64),
    };
    const runtimePublicRollout = {
      active: true,
      databaseAuthorized: true,
      evidenceHash: signedRollout.payloadHash,
      stage: "genre_scene:50->100",
      targetConfigurationHash:
        signedRollout.targetConfigurationHash,
    };
    expect(() => assertFinalizationRuntimePublicRolloutBindingV1({
      runtimePublicRollout,
      signedRollout,
    })).not.toThrow();
    for (const invalid of [
      { ...runtimePublicRollout, evidenceHash: "3".repeat(64) },
      { ...runtimePublicRollout, stage: "genre_scene:10->50" },
      {
        ...runtimePublicRollout,
        targetConfigurationHash: "4".repeat(64),
      },
      { ...runtimePublicRollout, databaseAuthorized: false },
    ]) {
      expect(() => assertFinalizationRuntimePublicRolloutBindingV1({
        runtimePublicRollout: invalid,
        signedRollout,
      })).toThrow(/exact signed public rollout/u);
    }
  });

  test("rejects browser probes for any rollout other than finalization lineage", () => {
    const signedRollout = {
      payloadHash: "1".repeat(64),
      intentGroup: "genre_scene",
      fromPercent: "50",
      toPercent: "100",
    };
    const probe = {
      rolloutEvidenceHash: signedRollout.payloadHash,
      rolloutStage: "genre_scene:50->100",
    };
    expect(() => assertFinalizationBrowserPublicRolloutBindingV1({
      probes: [probe],
      signedRollout,
    })).not.toThrow();
    expect(() => assertFinalizationBrowserPublicRolloutBindingV1({
      probes: [{
        ...probe,
        rolloutEvidenceHash: "2".repeat(64),
      }],
      signedRollout,
    })).toThrow(/exact signed public rollout/u);
    expect(() => assertFinalizationBrowserPublicRolloutBindingV1({
      probes: [{
        ...probe,
        rolloutStage: "genre_scene:10->50",
      }],
      signedRollout,
    })).toThrow(/exact signed public rollout/u);
  });

  test("cannot sign candidate evidence when staging budget or credential isolation is unproven", () => {
    expect(() => validateReleaseEvidencePayload({
      ...payload(),
      stagingControls: {
        ...payload().stagingControls,
        budgetRemainingUsd: 0,
        reservedForRequiredGatesUsd: 0,
      },
    })).toThrow(/budget cannot cover every required live gate/u);
    expect(() => validateReleaseEvidencePayload({
      ...payload(),
      stagingControls: {
        ...payload().stagingControls,
        productionProviderSecretVersionHash:
          payload().stagingControls.providerSecretVersionHash,
      },
    })).toThrow(/provider credential versions must be different/u);
    expect(() => validateReleaseEvidencePayload({
      ...payload(),
      stagingControls: {
        ...payload().stagingControls,
        productionAppleQaVerifierSecretVersionHash:
          payload().stagingControls.appleQaVerifierSecretVersionHash,
      },
    })).toThrow(/QA verifier credential versions must be different/u);
    expect(() => validateReleaseEvidencePayload({
      ...payload(),
      stagingControls: {
        ...payload().stagingControls,
        appleQaVerifierSecretVersionHash: "9".repeat(64),
      },
    })).toThrow(/runtime credential-version bindings/u);
    const candidate = payload();
    candidate.gates = candidate.gates.map((item: any) => (
      item.environment === "staging" ? { ...item, budgetStatus: "not_applicable" } : item
    ));
    expect(() => validateReleaseEvidencePayload(candidate)).toThrow(/QA budget state/u);
  });
});
