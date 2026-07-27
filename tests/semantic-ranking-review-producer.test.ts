import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  attestSemanticRankingReviewV1,
  evaluateSemanticRankingReviewV1,
  semanticRankingBlindMappingSha256,
  semanticRankingBlindedPackageSha256,
  semanticRankingProtectedBaselineMetadataSha256,
  semanticRankingReviewBaselineIdentityV2,
  semanticRankingReviewerKeyFingerprint,
  verifySemanticRankingReviewerAttestationV1,
  type SemanticRankingBlindMappingV1,
  type SemanticRankingBlindScorecardV1,
  type SemanticRankingBlindedPackageV1,
  type SemanticRankingProtectedBaselineMetadataV1,
  type SemanticRankingReviewArtifactV1,
} from "../lib/semantic-ranking-review.ts";
import {
  RELEASE_EVIDENCE_TTL_MS,
  releaseEvidenceConfigurationHash,
  releaseEvidenceRuntimeHash,
  stableReleaseEvidenceJson,
  validateReleaseEvidencePayload,
} from "../scripts/release-evidence.ts";
import {
  RELEASE_GATE_ARTIFACT_SCHEMA_V1,
  releaseFixtureSha256,
  releaseFixtureBindingsForGate,
  validateReleaseGateArtifact,
  verifyReleaseGateProducerAttestation,
  type ReleaseGateName,
} from "../scripts/release-fixtures.ts";
import {
  authorizeStableRelease,
  stableReleaseKeyFingerprint,
  verifyHistoricalStableReleaseConsumerBundle,
} from "../scripts/authorize-stable-release.ts";
import {
  createSemanticBaselineHandoff,
  SEMANTIC_BASELINE_RELEASE_ASSET_NAMES,
  semanticBaselineReleaseIdentitySha256,
} from "../scripts/semantic-baseline-handoff.ts";
import {
  assertIndependentSemanticReviewerKey,
  parseSemanticRankingReviewProducerArgs,
  produceSemanticRankingReviewGate,
} from "../scripts/semantic-ranking-review-producer.ts";

const revision = "a".repeat(40);
const baselineRevision = "b".repeat(40);
const imageDigest = `sha256:${"c".repeat(64)}`;
const baselineImageDigest = `sha256:${"d".repeat(64)}`;
const reviewedAt = "2026-07-23T20:00:00.000Z";
const stagingOrigin = "https://staging-9enio.example";
const fixtureIds = [
  "fixed-three-track-control-v1",
  "smooth-reggaeton-heat-50-v1",
  "french-jazz-guided-constraint-25-v1",
] as const;

const digest = (value: string): string => value.repeat(64);

function semanticReviewInputs(
  score = 4,
  lineage: {
    finalizationEvidencePayloadHash: string;
    finalBrowserGateEvidenceHash: string;
  } = {
    finalizationEvidencePayloadHash: digest("e"),
    finalBrowserGateEvidenceHash: digest("f"),
  },
): {
  artifact: SemanticRankingReviewArtifactV1;
  protectedBaselineMetadata: SemanticRankingProtectedBaselineMetadataV1;
  blindedPackage: SemanticRankingBlindedPackageV1;
  blindScorecard: SemanticRankingBlindScorecardV1;
  blindMapping: SemanticRankingBlindMappingV1;
  baselineMetadataHash: string;
} {
  const protectedBaselineMetadata: SemanticRankingProtectedBaselineMetadataV1 = {
    schemaVersion: "genio-semantic-ranking-protected-baseline/v2",
    rcTag: "v2.3.9-rc.2",
    stableTag: "v2.3.9",
    version: "2.3.9",
    sourceRevision: baselineRevision,
    imageDigest: baselineImageDigest,
    imageReference:
      `ghcr.io/hooterjackson/genio@${baselineImageDigest}`,
    finalizationEvidencePayloadHash:
      lineage.finalizationEvidencePayloadHash,
    finalBrowserGateEvidenceHash:
      lineage.finalBrowserGateEvidenceHash,
    fixtures: fixtureIds.map((fixtureId, index) => ({
      fixtureId,
      orderedManifestHash: digest(String(index + 1)),
      outputHash: digest(String(index + 4)),
    })),
  };
  const candidateOutputs = fixtureIds.map((fixtureId, index) => ({
    fixtureId,
    orderedManifestHash: digest(["7", "8", "9"][index]!),
    outputHash: digest(["a", "b", "c"][index]!),
  }));
  const blindedPackage: SemanticRankingBlindedPackageV1 = {
    schemaVersion: "genio-semantic-ranking-blinded-package/v1",
    randomizationId: "QWxhZGRpbjpvcGVuIHNlc2FtZQ",
    fixtures: fixtureIds.map((fixtureId, index) => {
      const baselineArm = {
        blindLabel: `baselineBlindArm_${index}_8Ywq`,
        orderedManifestHash:
          protectedBaselineMetadata.fixtures[index]!.orderedManifestHash,
        outputHash: protectedBaselineMetadata.fixtures[index]!.outputHash,
      };
      const candidateArm = {
        blindLabel: `candidateBlindArm_${index}_4KpZ`,
        orderedManifestHash: candidateOutputs[index]!.orderedManifestHash,
        outputHash: candidateOutputs[index]!.outputHash,
      };
      return {
        fixtureId,
        arms: (index % 2 === 0
          ? [candidateArm, baselineArm]
          : [baselineArm, candidateArm]) as [
            typeof baselineArm,
            typeof candidateArm,
          ],
      };
    }),
  };
  const baselineMetadataHash =
    semanticRankingProtectedBaselineMetadataSha256(protectedBaselineMetadata);
  const blindedPackageHash =
    semanticRankingBlindedPackageSha256(blindedPackage);
  const blindMapping: SemanticRankingBlindMappingV1 = {
    schemaVersion: "genio-semantic-ranking-blind-mapping/v1",
    blindedPackageHash,
    baselineMetadataHash,
    candidate: { sourceRevision: revision, imageDigest },
    fixtures: fixtureIds.map((fixtureId, index) => ({
      fixtureId,
      baselineBlindLabel: `baselineBlindArm_${index}_8Ywq`,
      candidateBlindLabel: `candidateBlindArm_${index}_4KpZ`,
    })),
  };
  const baselineScores = {
    relevance: 4,
    discoveryQuality: 4,
    coherence: 4,
    sequencing: 4,
  };
  const candidateScores = {
    relevance: score,
    discoveryQuality: score,
    coherence: score,
    sequencing: score,
  };
  const blindScorecard: SemanticRankingBlindScorecardV1 = {
    schemaVersion: "genio-semantic-ranking-blind-scorecard/v1",
    blindedPackageHash,
    reviewedAt,
    fixtures: blindedPackage.fixtures.map((fixture, index) => {
      const mapping = blindMapping.fixtures[index]!;
      return {
        fixtureId: fixture.fixtureId,
        arms: fixture.arms.map((arm) => ({
          ...arm,
          scores: arm.blindLabel === mapping.baselineBlindLabel
            ? baselineScores
            : candidateScores,
        })) as [
          SemanticRankingBlindScorecardV1["fixtures"][number]["arms"][number],
          SemanticRankingBlindScorecardV1["fixtures"][number]["arms"][number],
        ],
      };
    }),
  };
  return {
    protectedBaselineMetadata,
    blindedPackage,
    blindScorecard,
    blindMapping,
    baselineMetadataHash,
    artifact: {
      schemaVersion: "genio-semantic-ranking-review/v2",
      blinded: true,
      independentReviewerAttested: true,
      candidate: { sourceRevision: revision, imageDigest },
      baseline:
        semanticRankingReviewBaselineIdentityV2(protectedBaselineMetadata),
      blinding: {
        blindedPackageHash,
        blindMappingHash: semanticRankingBlindMappingSha256(blindMapping),
      },
      reviewedAt,
      pairs: fixtureIds.map((fixtureId, index) => ({
        fixtureId,
        baseline: {
          scores: baselineScores,
          orderedManifestHash:
            protectedBaselineMetadata.fixtures[index]!.orderedManifestHash,
          outputHash:
            protectedBaselineMetadata.fixtures[index]!.outputHash,
        },
        candidate: {
          scores: candidateScores,
          orderedManifestHash:
            candidateOutputs[index]!.orderedManifestHash,
          outputHash: candidateOutputs[index]!.outputHash,
        },
      })),
    },
  };
}

function runtimeSnapshot() {
  const sitesObservation = {
    version: "2.4.0",
    sourceRevision: revision,
    configurationHash: "4".repeat(64),
    ownerAllowlistVersion: "owner-allowlist-v1",
    candidateMatched: true,
  };
  const configuration = {
    apiHash: "1".repeat(64),
    interactiveWorkerHash: "2".repeat(64),
    deepWorkerHash: "3".repeat(64),
    sitesHash: releaseFixtureSha256({
      buildIdentity: {
        version: sitesObservation.version,
        sourceRevision: sitesObservation.sourceRevision,
      },
      gatewayConfigurationHash: sitesObservation.configurationHash,
    }),
    secretVersionsHash: "5".repeat(64),
  };
  const runtime = {
    releaseEnvironment: "staging" as const,
    deploymentPhase: "activate" as const,
    databaseSchemaVersion: "18" as const,
    databaseCapabilityVersion: "2" as const,
    releaseManifestCanaryGuardsVersion: "1" as const,
    canonicalExecutionHardeningVersion: "1" as const,
    workerProtocol: "playlist-pipeline-v10" as const,
    briefContractVersion: "3" as const,
    queryPlanSchemaVersion: "5" as const,
    modelIds: {
      brief: "gpt-5.4-mini",
      baseline: "gpt-5.6-luna",
      escalation: "gpt-5.6-terra",
    },
    policyVersions: {
      guidance: "adaptive_guidance_v3",
      evidence: "governed_evidence_v2",
      queryPlan: "query_plan_v3_4",
      selection: "selection_plan_v3",
      semanticScope: "scope_gate_v2_1_2",
      musicConcept: "music_concepts_v3_2_0",
      pipeline: "corpus_first_v3",
      prompt: "grounded_recovery_v3_1_prompt_v1",
    },
  };
  const unsigned = {
    schemaVersion: "genio-release-runtime-snapshot/v2" as const,
    generatedAt: reviewedAt,
    origin: stagingOrigin,
    environment: "staging" as const,
    scope: "full" as const,
    candidate: {
      version: "2.4.0",
      sourceRevision: revision,
    },
    sitesObservation,
    configuration,
    runtime,
    credentialVersionHashes: {
      provider: "6".repeat(64),
      apple: "7".repeat(64),
      appleQaVerifier: "8".repeat(64),
    },
    configurationHash: releaseEvidenceConfigurationHash({ configuration }),
    runtimeHash: releaseEvidenceRuntimeHash({ runtime }),
  };
  return {
    ...unsigned,
    snapshotHash: releaseFixtureSha256(unsigned),
  };
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(stableReleaseEvidenceJson(value))
    .digest("hex");
}

function signedBaselineFinalization(signingKey: KeyObject) {
  const generatedAt = "2026-07-22T18:00:00.000Z";
  const rolloutCompletedAt = "2026-07-22T17:40:00.000Z";
  const base = runtimeSnapshot();
  const configuration = {
    ...base.configuration,
    sitesHash: "8".repeat(64),
    secretVersionsHash: "5".repeat(64),
  };
  const stagingConfiguration = {
    ...configuration,
    sitesHash: "7".repeat(64),
    secretVersionsHash: "6".repeat(64),
  };
  const runtime = {
    ...base.runtime,
    releaseEnvironment: "production" as const,
  };
  const stagingRuntime = {
    ...runtime,
    releaseEnvironment: "staging" as const,
  };
  const productionConfigurationHash =
    releaseEvidenceConfigurationHash({ configuration });
  const stagingConfigurationHash =
    releaseEvidenceConfigurationHash({
      configuration: stagingConfiguration,
    });
  const productionRuntimeHash =
    releaseEvidenceRuntimeHash({ runtime });
  const stagingRuntimeHash =
    releaseEvidenceRuntimeHash({ runtime: stagingRuntime });
  const gate = (
    name: "release_convergence" | "final_custom_domain_browser",
    evidenceHash: string,
  ) => ({
    name,
    environment: "production" as const,
    passed: true,
    completedAt: generatedAt,
    evidenceHash,
    artifactSchemaVersion: RELEASE_GATE_ARTIFACT_SCHEMA_V1,
    configurationHash: productionConfigurationHash,
    runtimeHash: productionRuntimeHash,
    fixtures: releaseFixtureBindingsForGate(name as ReleaseGateName, {
      "smooth-reggaeton-heat-50-v1": "7".repeat(64),
      "french-jazz-guided-constraint-25-v1": "8".repeat(64),
    }),
    cacheMode: "reuse_disabled" as const,
    budgetStatus: "not_applicable" as const,
  });
  const payload = validateReleaseEvidencePayload({
    schemaVersion: "genio-release-evidence/v3",
    kind: "finalization",
    generatedAt,
    expiresAt: new Date(
      Date.parse(generatedAt) + RELEASE_EVIDENCE_TTL_MS,
    ).toISOString(),
    candidate: {
      tag: "v2.3.9-rc.2",
      version: "2.3.9",
      sourceRevision: baselineRevision,
      imageDigest: baselineImageDigest,
      sitesSourceRevision: baselineRevision,
    },
    lineage: {
      candidateEvidencePayloadHash: "1".repeat(64),
      candidateEvidenceGeneratedAt: "2026-07-22T17:00:00.000Z",
      promotionEvidencePayloadHash: "2".repeat(64),
      promotionEvidenceGeneratedAt: "2026-07-22T17:20:00.000Z",
      publicRolloutEvidencePayloadHash: "3".repeat(64),
      publicRolloutCompletedAt: rolloutCompletedAt,
      publicRolloutIntentGroup: "genre_scene",
    },
    configuration,
    stagingControls: {
      controlPlanePhase: "finalization",
      candidateEvidencePayloadHash: "1".repeat(64),
      candidateSourceRevision: baselineRevision,
      candidateImageDigest: baselineImageDigest,
      candidateImageReference:
        `ghcr.io/hooterjackson/genio@${baselineImageDigest}`,
      monthlyCostLimitUsd: 10,
      budgetRemainingUsd: 6,
      reservedForRequiredGatesUsd: 4,
      budgetStatus: "available",
      musicKitOrigin: stagingOrigin,
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
      productionRuntimeSnapshotHash: "a".repeat(64),
      stagingConfigurationHash,
      productionConfigurationHash,
      stagingSecretVersionsHash: stagingConfiguration.secretVersionsHash,
      productionSecretVersionsHash: configuration.secretVersionsHash,
      stagingRailwayServiceInventoryHash: "6".repeat(64),
      productionRailwayServiceInventoryHash: "7".repeat(64),
      appleReceiptPayloadHash: "a".repeat(64),
      providerReceiptPayloadHash: "b".repeat(64),
      qaBudgetReceiptPayloadHash: "c".repeat(64),
      appleAccountSeparationEvidenceHash: "5".repeat(64),
      musicKitOriginRegistrationEvidenceHash: "6".repeat(64),
      controlPlaneEvidenceHash: "7".repeat(64),
      controlPlaneKeyId: "baseline-control-plane-test-v1",
      controlPlaneKeyFingerprint: "8".repeat(64),
    },
    runtime,
    environmentSnapshots: {
      staging: {
        scope: "full",
        generatedAt: "2026-07-22T17:00:00.000Z",
        snapshotHash: "9".repeat(64),
        sitesObservationHash: "7".repeat(64),
        sitesVersion: "2.3.9",
        sitesSourceRevision: baselineRevision,
        sitesCandidateMatched: true,
        configurationHash: stagingConfigurationHash,
        secretVersionsHash: stagingConfiguration.secretVersionsHash,
        runtimeHash: stagingRuntimeHash,
        providerCredentialVersionHash: "1".repeat(64),
        appleCredentialVersionHash: "3".repeat(64),
        appleQaVerifierCredentialVersionHash: "d".repeat(64),
      },
      production: {
        scope: "full",
        generatedAt,
        snapshotHash: "a".repeat(64),
        sitesObservationHash: "8".repeat(64),
        sitesVersion: "2.3.9",
        sitesSourceRevision: baselineRevision,
        sitesCandidateMatched: true,
        configurationHash: productionConfigurationHash,
        secretVersionsHash: configuration.secretVersionsHash,
        runtimeHash: productionRuntimeHash,
        providerCredentialVersionHash: "2".repeat(64),
        appleCredentialVersionHash: "4".repeat(64),
        appleQaVerifierCredentialVersionHash: "e".repeat(64),
      },
    },
    gates: [
      gate("release_convergence", "e".repeat(64)),
      gate("final_custom_domain_browser", "f".repeat(64)),
    ],
  });
  const keyId = "baseline-release-evidence-test-v1";
  const payloadHash = sha256(payload);
  return {
    schemaVersion: "genio-signed-release-evidence/v3" as const,
    payload,
    payloadHash,
    signature: {
      algorithm: "Ed25519" as const,
      keyId,
      value: sign(
        null,
        Buffer.from(stableReleaseEvidenceJson({
          algorithm: "Ed25519",
          keyId,
          payload,
        })),
        signingKey,
      ).toString("base64url"),
    },
  };
}

async function setup(score = 4) {
  const directory = await mkdtemp(join(tmpdir(), "genio-semantic-review-"));
  const handoffDirectory = join(directory, "semantic-baseline-handoff");
  await mkdir(handoffDirectory, { mode: 0o700 });
  const reviewer = generateKeyPairSync("ed25519");
  const producer = generateKeyPairSync("ed25519");
  const baselineRelease = generateKeyPairSync("ed25519");
  const baselineStableAuthorizer = generateKeyPairSync("ed25519");
  const baselineFinalization =
    signedBaselineFinalization(baselineRelease.privateKey);
  const finalBrowserGate = baselineFinalization.payload.gates.find(
    ({ name }) => name === "final_custom_domain_browser",
  );
  if (!finalBrowserGate) {
    throw new Error("baseline finalization test fixture has no browser gate");
  }
  const semanticInputs = semanticReviewInputs(score, {
    finalizationEvidencePayloadHash: baselineFinalization.payloadHash,
    finalBrowserGateEvidenceHash: finalBrowserGate.evidenceHash,
  });
  const baselineStableAuthorizerKeyId =
    "semantic-baseline-stable-authorizer-test-v1";
  const baselineStableAuthorization = await authorizeStableRelease({
    finalizationEvidence: baselineFinalization,
    protectedBaselineMetadata: semanticInputs.protectedBaselineMetadata,
    releaseVerificationKey: baselineRelease.publicKey,
    approvedReleaseKeySha256:
      stableReleaseKeyFingerprint(baselineRelease.publicKey),
    authorizerSigningKey: baselineStableAuthorizer.privateKey,
    approvedAuthorizerKeyId: baselineStableAuthorizerKeyId,
    approvedAuthorizerKeySha256:
      stableReleaseKeyFingerprint(baselineStableAuthorizer.publicKey),
    expectedRcTag: semanticInputs.protectedBaselineMetadata.rcTag,
    expectedVersion: semanticInputs.protectedBaselineMetadata.version,
    expectedRevision:
      semanticInputs.protectedBaselineMetadata.sourceRevision,
    expectedImageDigest:
      semanticInputs.protectedBaselineMetadata.imageDigest,
    generatedAt: "2026-07-22T19:00:00.000Z",
  });
  const baselineStoredConsumer = verifyHistoricalStableReleaseConsumerBundle({
    finalizationEvidence: baselineFinalization,
    protectedBaselineMetadata: semanticInputs.protectedBaselineMetadata,
    releaseVerificationKey: baselineRelease.publicKey,
    approvedReleaseKeySha256:
      stableReleaseKeyFingerprint(baselineRelease.publicKey),
    stableAuthorization: baselineStableAuthorization,
    stableAuthorizationVerificationKey:
      baselineStableAuthorizer.publicKey,
    approvedStableAuthorizerKeyId: baselineStableAuthorizerKeyId,
    approvedStableAuthorizerKeySha256:
      stableReleaseKeyFingerprint(baselineStableAuthorizer.publicKey),
    expectedRcTag: semanticInputs.protectedBaselineMetadata.rcTag,
    expectedVersion: semanticInputs.protectedBaselineMetadata.version,
    expectedRevision:
      semanticInputs.protectedBaselineMetadata.sourceRevision,
    expectedImageDigest:
      semanticInputs.protectedBaselineMetadata.imageDigest,
    expectedImageReference:
      semanticInputs.protectedBaselineMetadata.imageReference,
    now: reviewedAt,
  });
  const artifact = semanticInputs.artifact;
  const report = evaluateSemanticRankingReviewV1(artifact);
  const reviewerAttestation = attestSemanticRankingReviewV1({
    blindScorecard: semanticInputs.blindScorecard,
    signingKey: reviewer.privateKey,
    keyId: "independent-curation-panel-v1",
  });
  const paths = {
    handoffDirectory,
    runtime: join(directory, "runtime.json"),
    artifact: join(directory, "review.json"),
    report: join(directory, "review-report.json"),
    reviewerAttestation: join(directory, "review-attestation.json"),
    reviewerPublicKey: join(directory, "reviewer-public.pem"),
    protectedBaselineMetadata:
      join(handoffDirectory, "protected-semantic-baseline.json"),
    protectedBaselineFinalizationEvidence:
      join(handoffDirectory, "finalization-evidence.json"),
    protectedBaselineReleaseVerificationKey:
      join(handoffDirectory, "release-verification-public-key.pem"),
    protectedBaselineStableAuthorization:
      join(handoffDirectory, "stable-authorization.json"),
    protectedBaselineStableAuthorizerVerificationKey:
      join(handoffDirectory, "stable-authorizer-public-key.pem"),
    protectedBaselineStoredConsumer:
      join(handoffDirectory, "stable-release-consumer.json"),
    protectedBaselineImageAttestation:
      join(handoffDirectory, "stable-image-attestation.json"),
    protectedBaselineHandoffManifest:
      join(handoffDirectory, "semantic-baseline-handoff.json"),
    blindedPackage: join(directory, "blinded-package.json"),
    blindScorecard: join(directory, "blind-scorecard.json"),
    blindMapping: join(directory, "blind-mapping.json"),
    producerPrivateKey: join(directory, "producer-private.pem"),
    source: join(directory, "gate-source.json"),
    gate: join(directory, "gate.json"),
    producerAttestation: join(directory, "gate-attestation.json"),
  };
  await Promise.all([
    writeFile(paths.runtime, JSON.stringify(runtimeSnapshot())),
    writeFile(paths.artifact, JSON.stringify(artifact)),
    writeFile(paths.report, JSON.stringify(report)),
    writeFile(paths.reviewerAttestation, JSON.stringify(reviewerAttestation)),
    writeFile(
      paths.protectedBaselineMetadata,
      JSON.stringify(semanticInputs.protectedBaselineMetadata),
    ),
    writeFile(
      paths.protectedBaselineFinalizationEvidence,
      JSON.stringify(baselineFinalization),
    ),
    writeFile(
      paths.protectedBaselineReleaseVerificationKey,
      baselineRelease.publicKey.export({
        format: "pem",
        type: "spki",
      }),
    ),
    writeFile(
      paths.protectedBaselineStableAuthorization,
      JSON.stringify(baselineStableAuthorization),
    ),
    writeFile(
      paths.protectedBaselineStableAuthorizerVerificationKey,
      baselineStableAuthorizer.publicKey.export({
        format: "pem",
        type: "spki",
      }),
    ),
    writeFile(
      paths.protectedBaselineStoredConsumer,
      JSON.stringify(baselineStoredConsumer),
    ),
    writeFile(
      paths.protectedBaselineImageAttestation,
      JSON.stringify({
        verified: true,
        evidenceHash: "f".repeat(64),
      }),
    ),
    writeFile(paths.blindedPackage, JSON.stringify(semanticInputs.blindedPackage)),
    writeFile(paths.blindScorecard, JSON.stringify(semanticInputs.blindScorecard)),
    writeFile(paths.blindMapping, JSON.stringify(semanticInputs.blindMapping)),
    writeFile(paths.reviewerPublicKey, reviewer.publicKey.export({
      format: "pem",
      type: "spki",
    })),
    writeFile(paths.producerPrivateKey, producer.privateKey.export({
      format: "pem",
      type: "pkcs8",
    })),
  ]);
  const assetSha256 = Object.fromEntries(
    await Promise.all(
      SEMANTIC_BASELINE_RELEASE_ASSET_NAMES.map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(join(handoffDirectory, name)))
          .digest("hex"),
      ] as const),
    ),
  ) as Record<
    (typeof SEMANTIC_BASELINE_RELEASE_ASSET_NAMES)[number],
    string
  >;
  const predecessorReleaseId = 239;
  const predecessorReleaseIdentitySha256 =
    semanticBaselineReleaseIdentitySha256({
      releaseId: predecessorReleaseId,
      stableTag: semanticInputs.protectedBaselineMetadata.stableTag,
      sourceRevision:
        semanticInputs.protectedBaselineMetadata.sourceRevision,
      metadataSha256: semanticInputs.baselineMetadataHash,
      assetSha256,
    });
  const handoff = await createSemanticBaselineHandoff({
    directory: handoffDirectory,
    manifestOutputPath: paths.protectedBaselineHandoffManifest,
    candidateTag: "v2.4.0-rc.2",
    candidateSourceRevision: revision,
    predecessorReleaseId,
    predecessorStableTag:
      semanticInputs.protectedBaselineMetadata.stableTag,
    predecessorSourceRevision:
      semanticInputs.protectedBaselineMetadata.sourceRevision,
    predecessorReleaseIdentitySha256,
    metadataSha256: semanticInputs.baselineMetadataHash,
    assetSha256,
    releaseVerificationKeySha256:
      stableReleaseKeyFingerprint(baselineRelease.publicKey),
    stableAuthorizerKeyId: baselineStableAuthorizerKeyId,
    stableAuthorizerKeySha256:
      stableReleaseKeyFingerprint(baselineStableAuthorizer.publicKey),
  });
  return {
    directory,
    reviewer,
    producer,
    baselineRelease,
    baselineStableAuthorizer,
    baselineStableAuthorizerKeyId,
    baselineFinalization,
    baselineStableAuthorization,
    baselineStoredConsumer,
    handoff,
    artifact,
    report,
    reviewerAttestation,
    semanticInputs,
    paths,
  };
}

function producerArgs(paths: Awaited<ReturnType<typeof setup>>["paths"]) {
  return [
    "--origin", stagingOrigin,
    "--expected-revision", revision,
    "--expected-version", "2.4.0",
    "--candidate-tag", "v2.4.0-rc.2",
    "--image-digest", imageDigest,
    "--runtime-snapshot", paths.runtime,
    "--review-artifact", paths.artifact,
    "--review-report", paths.report,
    "--reviewer-attestation", paths.reviewerAttestation,
    "--reviewer-verification-key", paths.reviewerPublicKey,
    "--protected-baseline-handoff-directory", paths.handoffDirectory,
    "--blinded-package", paths.blindedPackage,
    "--blind-scorecard", paths.blindScorecard,
    "--blind-mapping", paths.blindMapping,
    "--reggaeton-guidance-lineage-hash", "9".repeat(64),
    "--french-guidance-lineage-hash", "d".repeat(64),
    "--source-output", paths.source,
    "--output", paths.gate,
    "--attestation-output", paths.producerAttestation,
    "--producer-signing-key", paths.producerPrivateKey,
    "--producer-key-id", "staging-release-producer-v1",
  ];
}

function approvedReviewerEnvironment(
  value: Awaited<ReturnType<typeof setup>>,
): NodeJS.ProcessEnv {
  return {
    RELEASE_STAGING_ORIGIN: stagingOrigin,
    RELEASE_SEMANTIC_REVIEWER_KEY_ID: "independent-curation-panel-v1",
    RELEASE_SEMANTIC_REVIEWER_KEY_SHA256:
      semanticRankingReviewerKeyFingerprint(value.reviewer.publicKey),
    RELEASE_SEMANTIC_BASELINE_METADATA_SHA256:
      value.semanticInputs.baselineMetadataHash,
    RELEASE_SEMANTIC_BASELINE_STABLE_TAG:
      value.semanticInputs.protectedBaselineMetadata.stableTag,
    RELEASE_SEMANTIC_BASELINE_RELEASE_KEY_SHA256:
      stableReleaseKeyFingerprint(value.baselineRelease.publicKey),
    RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_ID:
      value.baselineStableAuthorizerKeyId,
    RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_SHA256:
      stableReleaseKeyFingerprint(value.baselineStableAuthorizer.publicKey),
    RELEASE_SEMANTIC_BASELINE_HANDOFF_SHA256:
      value.handoff.manifestSha256,
  };
}

describe("semantic ranking blinded-review live gate producer", () => {
  test("accepts only the configured staging origin and has no caller pass option", async () => {
    const value = await setup();
    const { paths } = value;
    expect(parseSemanticRankingReviewProducerArgs(producerArgs(paths), {
      ...approvedReviewerEnvironment(value),
    })).toMatchObject({
      origin: stagingOrigin,
      expectedRevision: revision,
      guidanceLineageHashes: {
        reggaeton: "9".repeat(64),
        frenchJazz: "d".repeat(64),
      },
    });
    expect(() => parseSemanticRankingReviewProducerArgs([
      ...producerArgs(paths),
      "--passed", "true",
    ], {
      ...approvedReviewerEnvironment(value),
    })).toThrow(/Unknown argument: --passed/u);
    expect(() => parseSemanticRankingReviewProducerArgs([
      ...producerArgs(paths),
      "--protected-baseline-metadata",
      paths.protectedBaselineMetadata,
    ], {
      ...approvedReviewerEnvironment(value),
    })).toThrow(/Unknown argument: --protected-baseline-metadata/u);
    expect(() => parseSemanticRankingReviewProducerArgs(producerArgs(paths), {
      ...approvedReviewerEnvironment(value),
      RELEASE_STAGING_ORIGIN: "https://different-staging.example",
    })).toThrow(/configured HTTPS staging origin/u);
    const unpinned = approvedReviewerEnvironment(value);
    delete unpinned.RELEASE_SEMANTIC_REVIEWER_KEY_SHA256;
    expect(() => parseSemanticRankingReviewProducerArgs(
      producerArgs(paths),
      unpinned,
    )).toThrow(/RELEASE_SEMANTIC_REVIEWER_KEY_ID.*SHA256/u);
    const baselineUnpinned = approvedReviewerEnvironment(value);
    delete baselineUnpinned.RELEASE_SEMANTIC_BASELINE_METADATA_SHA256;
    expect(() => parseSemanticRankingReviewProducerArgs(
      producerArgs(paths),
      baselineUnpinned,
    )).toThrow(/RELEASE_SEMANTIC_BASELINE_METADATA_SHA256/u);
    const handoffUnpinned = approvedReviewerEnvironment(value);
    delete handoffUnpinned.RELEASE_SEMANTIC_BASELINE_HANDOFF_SHA256;
    expect(() => parseSemanticRankingReviewProducerArgs(
      producerArgs(paths),
      handoffUnpinned,
    )).toThrow(/RELEASE_SEMANTIC_BASELINE_HANDOFF_SHA256/u);
    await expect(produceSemanticRankingReviewGate(
      parseSemanticRankingReviewProducerArgs(producerArgs(paths), {
        ...approvedReviewerEnvironment(value),
        RELEASE_SEMANTIC_REVIEWER_KEY_SHA256: "f".repeat(64),
      }),
    )).rejects.toThrow(/protected approved reviewer key/u);
    await expect(produceSemanticRankingReviewGate(
      parseSemanticRankingReviewProducerArgs(producerArgs(paths), {
        ...approvedReviewerEnvironment(value),
        RELEASE_SEMANTIC_BASELINE_METADATA_SHA256: "f".repeat(64),
      }),
    )).rejects.toThrow(/protected candidate and predecessor pins/u);
  });

  test("emits the gate only after verifying the independent detached review", async () => {
    const setupValue = await setup();
    const args = parseSemanticRankingReviewProducerArgs(
      producerArgs(setupValue.paths),
      approvedReviewerEnvironment(setupValue),
    );
    const produced = await produceSemanticRankingReviewGate(args);
    expect(produced.reviewerAttestation)
      .toEqual(setupValue.reviewerAttestation);
    expect(verifySemanticRankingReviewerAttestationV1({
      value: produced.reviewerAttestation,
      blindScorecard: setupValue.semanticInputs.blindScorecard,
      verificationKey: setupValue.reviewer.publicKey,
    })).toEqual(setupValue.reviewerAttestation);

    const gate = validateReleaseGateArtifact(
      JSON.parse(await readFile(setupValue.paths.gate, "utf8")),
    );
    expect(gate).toMatchObject({
      gate: "semantic_ranking_blinded_review",
      candidate: {
        sourceRevision: revision,
        imageDigest,
      },
      proof: {
        passed: true,
        assertions: {
          blinded_review: true,
          independent_reviewer_attested: true,
          all_release_fixtures_reviewed: true,
          protected_last_proven_baseline: true,
          ordered_outputs_bound: true,
          blinded_package_mapping_bound: true,
          candidate_medians_at_least_four: true,
          no_fixture_dimension_regression: true,
          no_material_regression: true,
        },
      },
      sources: {
        protectedBaselineMetadata:
          setupValue.semanticInputs.protectedBaselineMetadata,
        blindedPackage: setupValue.semanticInputs.blindedPackage,
        blindScorecard: setupValue.semanticInputs.blindScorecard,
        blindMapping: setupValue.semanticInputs.blindMapping,
        reviewerAttestation: setupValue.reviewerAttestation,
      },
    });
    expect(verifyReleaseGateProducerAttestation(
      JSON.parse(await readFile(setupValue.paths.producerAttestation, "utf8")),
      gate,
      setupValue.producer.publicKey,
    )).toEqual(produced.attestation);
    const source = JSON.parse(await readFile(setupValue.paths.source, "utf8"));
    expect(source).toMatchObject({
      schemaVersion: "genio-release-gate-producer-source/v1",
      gate: "semantic_ranking_blinded_review",
      runtimeSnapshotHash: runtimeSnapshot().snapshotHash,
    });
    expect(source.sourceHash).toBe(releaseFixtureSha256({
      schemaVersion: source.schemaVersion,
      gate: source.gate,
      completedAt: source.completedAt,
      candidate: source.candidate,
      runtimeSnapshotHash: source.runtimeSnapshotHash,
      credentialVersionHashes: source.credentialVersionHashes,
      evidence: source.evidence,
    }));
  });

  test("rejects self-repinned metadata, unapproved predecessor tags, key reuse, and lineage hash tampering", async () => {
    const selfRepinned = await setup();
    const selfAuthoredMetadata = structuredClone(
      selfRepinned.semanticInputs.protectedBaselineMetadata,
    );
    selfAuthoredMetadata.fixtures[0]!.outputHash = "0".repeat(64);
    await writeFile(
      selfRepinned.paths.protectedBaselineMetadata,
      JSON.stringify(selfAuthoredMetadata),
    );
    await expect(produceSemanticRankingReviewGate(
      parseSemanticRankingReviewProducerArgs(
        producerArgs(selfRepinned.paths),
        {
          ...approvedReviewerEnvironment(selfRepinned),
          RELEASE_SEMANTIC_BASELINE_METADATA_SHA256:
            semanticRankingProtectedBaselineMetadataSha256(
              selfAuthoredMetadata,
            ),
        },
      ),
    )).rejects.toThrow(/protected candidate and predecessor pins/u);

    const oldRelease = await setup();
    await expect(produceSemanticRankingReviewGate(
      parseSemanticRankingReviewProducerArgs(
        producerArgs(oldRelease.paths),
        {
          ...approvedReviewerEnvironment(oldRelease),
          RELEASE_SEMANTIC_BASELINE_STABLE_TAG: "v2.3.8",
        },
      ),
    )).rejects.toThrow(/protected candidate and predecessor pins/u);

    const keyReuse = await setup();
    expect(() => parseSemanticRankingReviewProducerArgs(
      producerArgs(keyReuse.paths),
      {
        ...approvedReviewerEnvironment(keyReuse),
        RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_SHA256:
          stableReleaseKeyFingerprint(keyReuse.baselineRelease.publicKey),
      },
    )).toThrow(/stable-release lineage keys are invalid/u);

    const hashTamper = await setup();
    const tamperedFinalization = structuredClone(
      hashTamper.baselineFinalization,
    );
    tamperedFinalization.payloadHash = "0".repeat(64);
    await writeFile(
      hashTamper.paths.protectedBaselineFinalizationEvidence,
      JSON.stringify(tamperedFinalization),
    );
    await expect(produceSemanticRankingReviewGate(
      parseSemanticRankingReviewProducerArgs(
        producerArgs(hashTamper.paths),
        approvedReviewerEnvironment(hashTamper),
      ),
    )).rejects.toThrow(/finalization-evidence\.json hash mismatch/u);
  });

  test("rejects missing or substituted handoff assets, keys, and manifest hashes", async () => {
    const missingAsset = await setup();
    await rm(missingAsset.paths.protectedBaselineImageAttestation);
    await expect(produceSemanticRankingReviewGate(
      parseSemanticRankingReviewProducerArgs(
        producerArgs(missingAsset.paths),
        approvedReviewerEnvironment(missingAsset),
      ),
    )).rejects.toThrow(/missing or unexpected file/u);

    const missingKey = await setup();
    await rm(
      missingKey.paths.protectedBaselineStableAuthorizerVerificationKey,
    );
    await expect(produceSemanticRankingReviewGate(
      parseSemanticRankingReviewProducerArgs(
        producerArgs(missingKey.paths),
        approvedReviewerEnvironment(missingKey),
      ),
    )).rejects.toThrow(/missing or unexpected file/u);

    const substitutedKey = await setup();
    const attackerKey = generateKeyPairSync("ed25519");
    await writeFile(
      substitutedKey.paths.protectedBaselineReleaseVerificationKey,
      attackerKey.publicKey.export({ format: "pem", type: "spki" }),
    );
    await expect(produceSemanticRankingReviewGate(
      parseSemanticRankingReviewProducerArgs(
        producerArgs(substitutedKey.paths),
        approvedReviewerEnvironment(substitutedKey),
      ),
    )).rejects.toThrow(/historical public-key bytes mismatch/u);

    const substitutedAsset = await setup();
    await writeFile(
      substitutedAsset.paths.protectedBaselineImageAttestation,
      JSON.stringify({ verified: false }),
    );
    await expect(produceSemanticRankingReviewGate(
      parseSemanticRankingReviewProducerArgs(
        producerArgs(substitutedAsset.paths),
        approvedReviewerEnvironment(substitutedAsset),
      ),
    )).rejects.toThrow(/stable-image-attestation\.json hash mismatch/u);

    const mismatchedManifestHash = await setup();
    await expect(produceSemanticRankingReviewGate(
      parseSemanticRankingReviewProducerArgs(
        producerArgs(mismatchedManifestHash.paths),
        {
          ...approvedReviewerEnvironment(mismatchedManifestHash),
          RELEASE_SEMANTIC_BASELINE_HANDOFF_SHA256: "0".repeat(64),
        },
      ),
    )).rejects.toThrow(/protected candidate and predecessor pins/u);
  });

  test("rejects tampering, failing derived medians, and reviewer/producer key reuse", async () => {
    const valid = await setup();
    const tamperedReport = {
      ...valid.report,
      passed: false,
    };
    await writeFile(valid.paths.report, JSON.stringify(tamperedReport));
    await expect(produceSemanticRankingReviewGate(
      parseSemanticRankingReviewProducerArgs(producerArgs(valid.paths), {
        ...approvedReviewerEnvironment(valid),
      }),
    )).rejects.toThrow(/not derived/u);

    const failing = await setup(3);
    await expect(produceSemanticRankingReviewGate(
      parseSemanticRankingReviewProducerArgs(producerArgs(failing.paths), {
        ...approvedReviewerEnvironment(failing),
      }),
    )).rejects.toThrow(/does not prove every immutable release fixture/u);

    expect(() => assertIndependentSemanticReviewerKey({
      reviewerVerificationKey: valid.reviewer.publicKey,
      producerSigningKey: valid.reviewer.privateKey,
    })).toThrow(/separate from the release gate producer key/u);
    expect(stableReleaseEvidenceJson(valid.reviewerAttestation))
      .not.toContain("passed");

    const unbound = await setup();
    const unboundPackage = structuredClone(
      unbound.semanticInputs.blindedPackage,
    );
    unboundPackage.fixtures[0]!.arms[0]!.orderedManifestHash = "f".repeat(64);
    await writeFile(
      unbound.paths.blindedPackage,
      JSON.stringify(unboundPackage),
    );
    await expect(produceSemanticRankingReviewGate(
      parseSemanticRankingReviewProducerArgs(producerArgs(unbound.paths), {
        ...approvedReviewerEnvironment(unbound),
      }),
    )).rejects.toThrow(/blind scorecard does not bind the exact blinded package/u);

    const mappingTamper = await setup();
    const tamperedMapping = structuredClone(
      mappingTamper.semanticInputs.blindMapping,
    );
    const firstMapping = tamperedMapping.fixtures[0]!;
    const baselineBlindLabel = firstMapping.baselineBlindLabel;
    firstMapping.baselineBlindLabel = firstMapping.candidateBlindLabel;
    firstMapping.candidateBlindLabel = baselineBlindLabel;
    await writeFile(
      mappingTamper.paths.blindMapping,
      JSON.stringify(tamperedMapping),
    );
    await expect(produceSemanticRankingReviewGate(
      parseSemanticRankingReviewProducerArgs(
        producerArgs(mappingTamper.paths),
        approvedReviewerEnvironment(mappingTamper),
      ),
    )).rejects.toThrow(/protected baseline and exact blinded outputs/u);
  });

  test("exact-parses review artifacts and reports before accepting their attestation", async () => {
    const value = await setup();
    await writeFile(value.paths.artifact, JSON.stringify({
      ...value.artifact,
      reviewerName: "must-not-enter-release-evidence",
    }));
    await expect(produceSemanticRankingReviewGate(
      parseSemanticRankingReviewProducerArgs(producerArgs(value.paths), {
        ...approvedReviewerEnvironment(value),
      }),
    )).rejects.toThrow(/missing or unapproved fields/u);
  });
});
