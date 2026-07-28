import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  createStrictSignedEnvelope,
  exactObject,
  sha256Digest,
  signedArtifactSha256,
  verifyStrictSignedEnvelope,
  type JsonRecord,
} from "../shared/signed-artifact.ts";
import {
  RELEASE_EVIDENCE_TTL_MS,
  assertFinalizationBrowserPublicRolloutBindingV1,
  assertFinalizationRuntimePublicRolloutBindingV1,
  releaseEvidenceConfigurationHash,
  releaseEvidenceRuntimeHash,
  releaseGateProducerKeyFingerprint,
  releaseGateProducerTrustPolicyV1,
  stableReleaseEvidenceJson,
  validateReleaseGateProducerTrustPolicyV1,
  verifyCandidateSemanticReviewAuthorizationEvidence,
  verifyReleaseEvidence,
  type ReleaseEvidenceGateV1,
  type ReleaseEvidencePayloadV1,
} from "./release-evidence.ts";
import {
  semanticRankingReviewerTrustPolicyV1,
  semanticRankingProtectedBaselineMetadataSha256,
  validateSemanticRankingProtectedBaselineMetadataV1,
  type SemanticRankingProtectedBaselineFixtureV1,
} from "../lib/semantic-ranking-review.ts";
import {
  publicRolloutProductionCanaryEvidenceHash,
  verifyPublicRolloutFinalizationLineage,
  type VerifiedPublicRolloutEvidence,
} from "../shared/public-rollout-evidence.ts";
import {
  sitesControlPlaneTrustPolicyV1,
  validateSitesControlPlaneTrustPolicyV1,
  validateSitesControlPlaneVerificationKeyV1,
  verifySitesControlPlaneAttestation,
} from "../shared/sites-control-plane-attestation.ts";
import {
  stagingControlPlaneTrustPolicyV1,
  validateStagingControlPlaneTrustPolicyV1,
  verifyStagingControlPlaneEvidence,
} from "../shared/staging-control-plane-evidence.ts";
import {
  controlPlaneReceiptTrustPolicyV1,
  validateControlPlaneReceiptTrustPolicyV1,
  verifyAppleControlPlaneReceipt,
  verifyProviderControlPlaneReceipt,
  verifyQaBudgetLedgerReceipt,
} from "../shared/staging-control-plane-receipts.ts";
import {
  validateReleaseGateArtifact,
  verifyReleaseGateProducerAttestation,
  type ReleaseGateArtifactV1,
  type ReleaseGateName,
} from "./release-fixtures.ts";

export const STABLE_RELEASE_AUTHORIZATION_SCHEMA_V1 =
  "genio-stable-release-authorization/v2";
export const SIGNED_STABLE_RELEASE_AUTHORIZATION_SCHEMA_V1 =
  "genio-signed-stable-release-authorization/v2";
export const STABLE_RELEASE_AUTHORIZATION_ISSUER_V1 =
  "genio-protected-stable-release-authorizer";

const CONFIRMATION_FLAG = "--confirm-stable-release-authorization";
const TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-rc\.[1-9]\d*$/u;
const SOURCE_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_REFERENCE =
  /^ghcr\.io\/[0-9a-z](?:[0-9a-z._/-]*[0-9a-z])?@sha256:[0-9a-f]{64}$/u;
const KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u;
export const STABLE_RELEASE_FINALIZATION_SOURCE_BUNDLE_SCHEMA_V2 =
  "genio-stable-release-finalization-source-bundle/v2";
const STABLE_RELEASE_FINALIZATION_SOURCE_GATES = Object.freeze([
  "production_fixed_three_track",
  "production_affected_regression",
  "backend_release_convergence",
  "release_convergence",
  "final_custom_domain_browser",
] as const satisfies readonly ReleaseGateName[]);
type StableReleaseFinalizationSourceGate =
  typeof STABLE_RELEASE_FINALIZATION_SOURCE_GATES[number];

export interface StableReleaseFinalizationSourceBundleV2 {
  schemaVersion:
    typeof STABLE_RELEASE_FINALIZATION_SOURCE_BUNDLE_SCHEMA_V2;
  promotionEvidence: unknown;
  publicRolloutEvidence: unknown;
  stagingControlPlaneEvidence: unknown;
  stagingControlPlaneVerificationKey: unknown;
  stagingControlPlaneTrustPolicy: unknown;
  controlPlaneReceipts: {
    apple: unknown;
    provider: unknown;
    qaBudget: unknown;
  };
  controlPlaneReceiptVerificationKeys: {
    apple: unknown;
    provider: unknown;
    qaBudget: unknown;
  };
  controlPlaneReceiptTrustPolicies: {
    apple: unknown;
    provider: unknown;
    qaBudget: unknown;
  };
  gateArtifacts: Record<StableReleaseFinalizationSourceGate, unknown>;
  gateProducerAttestations:
    Record<StableReleaseFinalizationSourceGate, unknown>;
}

export interface StableReleaseConsumerManifestV1 {
  schemaVersion: "genio-stable-release-consumer-manifest/v2";
  verifiedAt: string;
  candidate: {
    rcTag: string;
    stableTag: string;
    version: string;
    sourceRevision: string;
    imageDigest: string;
    imageReference: string;
  };
  finalizationEvidencePayloadHash: string;
  finalBrowserGateEvidenceHash: string;
  protectedBaselineMetadataHash: string;
  stableAuthorizationPayloadHash: string;
  releaseVerificationKeySha256: string;
  stableAuthorizerKeyId: string;
  stableAuthorizerKeySha256: string;
}

export interface StableReleaseVerificationKeyV1 {
  schemaVersion: "genio-stable-release-verification-key/v1";
  algorithm: "Ed25519";
  format: "spki-der";
  value: string;
  sha256: string;
}

function semanticFixturesMatch(
  actual: readonly SemanticRankingProtectedBaselineFixtureV1[],
  expected: readonly SemanticRankingProtectedBaselineFixtureV1[],
): boolean {
  return actual.length === expected.length
    && actual.every((fixture, index) => {
      const reviewed = expected[index];
      return reviewed !== undefined
        && fixture.fixtureId === reviewed.fixtureId
        && fixture.orderedManifestHash === reviewed.orderedManifestHash
        && fixture.outputHash === reviewed.outputHash;
    });
}

function protectedBaselineFixturesMatch(
  protectedBaselineMetadata: ReturnType<
    typeof validateSemanticRankingProtectedBaselineMetadataV1
  >,
  expected: readonly SemanticRankingProtectedBaselineFixtureV1[],
): boolean {
  return semanticFixturesMatch(protectedBaselineMetadata.fixtures, expected);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function canonicalReleaseGate(
  artifact: ReleaseGateArtifactV1,
): ReleaseEvidenceGateV1 {
  return {
    name: artifact.gate,
    environment: artifact.environment,
    passed: true,
    completedAt: artifact.completedAt,
    evidenceHash: artifact.evidenceHash,
    artifactSchemaVersion: artifact.schemaVersion,
    configurationHash: artifact.configurationHash,
    runtimeHash: artifact.runtimeHash,
    fixtures: artifact.fixtures,
    cacheMode: artifact.cacheMode,
    budgetStatus: artifact.budgetStatus,
  };
}

function assertSameCandidate(
  evidence: ReleaseEvidencePayloadV1,
  artifact: ReleaseGateArtifactV1,
): void {
  if (
    stableReleaseEvidenceJson(evidence.candidate)
      !== stableReleaseEvidenceJson(artifact.candidate)
  ) {
    throw new Error(
      `stable authorization source artifact ${artifact.gate} does not bind the exact candidate`,
    );
  }
}

function verifyStableReleaseFinalizationSources(input: {
  value: unknown;
  finalizationEvidence: ReleaseEvidencePayloadV1;
  releaseVerificationKey: string | Buffer | KeyObject;
  releaseGateProducerVerificationKey: string | Buffer | KeyObject;
  approvedReleaseGateProducer: unknown;
  approvedSitesControlPlane: unknown;
  approvedStagingControlPlane: unknown;
  approvedControlPlaneReceipts: unknown;
  expectedTag: string;
  expectedRevision: string;
  expectedImageDigest: string;
  now: string;
}): {
  producerKeySha256: string;
  sitesKeySha256: string;
  stagingControlPlaneKeySha256: string;
  receiptKeySha256: readonly [string, string, string];
  expiresAt: string;
  publicRollout: VerifiedPublicRolloutEvidence;
} {
  const bundle = exactObject(input.value, [
    "schemaVersion",
    "promotionEvidence",
    "publicRolloutEvidence",
    "stagingControlPlaneEvidence",
    "stagingControlPlaneVerificationKey",
    "stagingControlPlaneTrustPolicy",
    "controlPlaneReceipts",
    "controlPlaneReceiptVerificationKeys",
    "controlPlaneReceiptTrustPolicies",
    "gateArtifacts",
    "gateProducerAttestations",
  ], "stable release finalization source bundle");
  if (
    bundle.schemaVersion
      !== STABLE_RELEASE_FINALIZATION_SOURCE_BUNDLE_SCHEMA_V2
  ) {
    throw new Error(
      "stable release finalization source bundle uses an unsupported schema",
    );
  }
  const promotion = verifyReleaseEvidence(
    bundle.promotionEvidence,
    input.releaseVerificationKey,
    {
      expectedKind: "promotion",
      expectedTag: input.expectedTag,
      expectedRevision: input.expectedRevision,
      expectedImageDigest: input.expectedImageDigest,
      now: input.now,
    },
  );
  const promotionEnvelope = exactObject(bundle.promotionEvidence, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], "signed promotion evidence");
  const promotionEvidencePayloadHash = sha256Digest(
    promotionEnvelope.payloadHash,
    "promotion evidence payload hash",
  );
  const finalization = input.finalizationEvidence;
  if (
    finalization.lineage.promotionEvidencePayloadHash
      !== promotionEvidencePayloadHash
    || finalization.lineage.promotionEvidenceGeneratedAt
      !== promotion.generatedAt
    || finalization.lineage.candidateEvidencePayloadHash
      !== promotion.lineage.candidateEvidencePayloadHash
    || finalization.lineage.candidateEvidenceGeneratedAt
      !== promotion.lineage.candidateEvidenceGeneratedAt
    || stableReleaseEvidenceJson(finalization.semanticReview)
      !== stableReleaseEvidenceJson(promotion.semanticReview)
  ) {
    throw new Error(
      "stable authorization finalization does not preserve the exact signed promotion lineage",
    );
  }
  const promotionProduction = promotion.environmentSnapshots.production;
  const finalizationProduction =
    finalization.environmentSnapshots.production;
  if (!promotionProduction || !finalizationProduction) {
    throw new Error(
      "stable authorization requires promotion and finalization production snapshots",
    );
  }
  const embeddedStagingControlPlaneTrust =
    validateStagingControlPlaneTrustPolicyV1(
      bundle.stagingControlPlaneTrustPolicy,
    );
  const approvedStagingControlPlaneTrust =
    validateStagingControlPlaneTrustPolicyV1(
      input.approvedStagingControlPlane,
    );
  if (
    stableReleaseEvidenceJson(embeddedStagingControlPlaneTrust)
      !== stableReleaseEvidenceJson(approvedStagingControlPlaneTrust)
  ) {
    throw new Error(
      "stable authorization staging control-plane source does not match the protected trust policy",
    );
  }
  const stagingControlPlaneKey = validateStableReleaseVerificationKeyV1(
    bundle.stagingControlPlaneVerificationKey,
  );
  const stagingControlPlane = verifyStagingControlPlaneEvidence({
    value: bundle.stagingControlPlaneEvidence,
    verificationKey: stagingControlPlaneKey.key,
    trustPolicy: approvedStagingControlPlaneTrust,
    now: input.now,
  });
  if (
    stableReleaseEvidenceJson(stagingControlPlane.derivedControls)
      !== stableReleaseEvidenceJson(finalization.stagingControls)
    || stagingControlPlane.payload.phase !== "finalization"
    || Date.parse(String(stagingControlPlane.payload.generatedAt))
      > Date.parse(finalization.generatedAt) + 5 * 60_000
  ) {
    throw new Error(
      "stable authorization finalization does not preserve the exact signed staging control-plane evidence",
    );
  }

  const receiptValues = exactObject(
    bundle.controlPlaneReceipts,
    ["apple", "provider", "qaBudget"],
    "stable authorization control-plane receipts",
  );
  const receiptKeyValues = exactObject(
    bundle.controlPlaneReceiptVerificationKeys,
    ["apple", "provider", "qaBudget"],
    "stable authorization control-plane receipt verification keys",
  );
  const receiptTrustValues = exactObject(
    bundle.controlPlaneReceiptTrustPolicies,
    ["apple", "provider", "qaBudget"],
    "stable authorization control-plane receipt trust policies",
  );
  const approvedReceiptValues = exactObject(
    input.approvedControlPlaneReceipts,
    ["apple", "provider", "qaBudget"],
    "approved stable authorization control-plane receipt policies",
  );
  const receiptTrust = {
    apple: validateControlPlaneReceiptTrustPolicyV1(
      receiptTrustValues.apple,
      "apple",
    ),
    provider: validateControlPlaneReceiptTrustPolicyV1(
      receiptTrustValues.provider,
      "provider",
    ),
    qaBudget: validateControlPlaneReceiptTrustPolicyV1(
      receiptTrustValues.qaBudget,
      "qa_budget",
    ),
  };
  const approvedReceiptTrust = {
    apple: validateControlPlaneReceiptTrustPolicyV1(
      approvedReceiptValues.apple,
      "apple",
    ),
    provider: validateControlPlaneReceiptTrustPolicyV1(
      approvedReceiptValues.provider,
      "provider",
    ),
    qaBudget: validateControlPlaneReceiptTrustPolicyV1(
      approvedReceiptValues.qaBudget,
      "qa_budget",
    ),
  };
  if (
    stableReleaseEvidenceJson(receiptTrust)
      !== stableReleaseEvidenceJson(approvedReceiptTrust)
  ) {
    throw new Error(
      "stable authorization control-plane receipts do not match the protected trust policies",
    );
  }
  const receiptKeys = {
    apple: validateStableReleaseVerificationKeyV1(
      receiptKeyValues.apple,
    ),
    provider: validateStableReleaseVerificationKeyV1(
      receiptKeyValues.provider,
    ),
    qaBudget: validateStableReleaseVerificationKeyV1(
      receiptKeyValues.qaBudget,
    ),
  };
  const expectedCandidate = {
    version: finalization.candidate.version,
    sourceRevision: finalization.candidate.sourceRevision,
    imageDigest: finalization.candidate.imageDigest,
    imageReference: finalization.stagingControls.candidateImageReference,
  };
  const stagingSnapshot = finalization.environmentSnapshots.staging;
  const appleReceipt = verifyAppleControlPlaneReceipt({
    value: receiptValues.apple,
    verificationKey: receiptKeys.apple.key,
    trustPolicy: approvedReceiptTrust.apple,
    expected: {
      phase: "finalization",
      candidate: expectedCandidate,
      staging: {
        runtimeSnapshotHash: stagingSnapshot.snapshotHash,
        appleCredentialVersionHash:
          stagingSnapshot.appleCredentialVersionHash,
        appleQaVerifierCredentialVersionHash:
          stagingSnapshot.appleQaVerifierCredentialVersionHash,
        musicKitOrigin: finalization.stagingControls.musicKitOrigin,
      },
      production: {
        runtimeSnapshotHash: finalizationProduction.snapshotHash,
        appleCredentialVersionHash:
          finalizationProduction.appleCredentialVersionHash,
        appleQaVerifierCredentialVersionHash:
          finalizationProduction.appleQaVerifierCredentialVersionHash,
      },
    },
    now: input.now,
  });
  const providerReceipt = verifyProviderControlPlaneReceipt({
    value: receiptValues.provider,
    verificationKey: receiptKeys.provider.key,
    trustPolicy: approvedReceiptTrust.provider,
    expected: {
      phase: "finalization",
      candidate: expectedCandidate,
      staging: {
        runtimeSnapshotHash: stagingSnapshot.snapshotHash,
        providerCredentialVersionHash:
          stagingSnapshot.providerCredentialVersionHash,
      },
      production: {
        runtimeSnapshotHash: finalizationProduction.snapshotHash,
        providerCredentialVersionHash:
          finalizationProduction.providerCredentialVersionHash,
      },
    },
    now: input.now,
  });
  const budgetReceipt = verifyQaBudgetLedgerReceipt({
    value: receiptValues.qaBudget,
    verificationKey: receiptKeys.qaBudget.key,
    trustPolicy: approvedReceiptTrust.qaBudget,
    expected: {
      phase: "finalization",
      candidate: expectedCandidate,
      stagingRuntimeSnapshotHash: stagingSnapshot.snapshotHash,
      productionRuntimeSnapshotHash: finalizationProduction.snapshotHash,
    },
    now: input.now,
  });
  const aggregateReceiptBindings = exactObject(
    stagingControlPlane.payload.receipts,
    ["apple", "provider", "qaBudget"],
    "signed staging control-plane receipt bindings",
  );
  for (const [name, verified, trust] of [
    ["apple", appleReceipt, approvedReceiptTrust.apple],
    ["provider", providerReceipt, approvedReceiptTrust.provider],
    ["qaBudget", budgetReceipt, approvedReceiptTrust.qaBudget],
  ] as const) {
    const binding = exactObject(
      aggregateReceiptBindings[name],
      ["payloadHash", "issuer", "keyId", "keySha256"],
      `${name} signed staging control-plane receipt binding`,
    );
    if (
      binding.payloadHash !== verified.payloadHash
      || binding.issuer !== trust.approvedIssuer
      || binding.keyId !== verified.keyId
      || binding.keySha256 !== verified.verificationKeyFingerprint
    ) {
      throw new Error(
        `stable authorization ${name} receipt does not match the signed staging control-plane aggregate`,
      );
    }
  }
  const controls = finalization.stagingControls;
  if (
    controls.appleReceiptPayloadHash !== appleReceipt.payloadHash
    || controls.providerReceiptPayloadHash !== providerReceipt.payloadHash
    || controls.qaBudgetReceiptPayloadHash !== budgetReceipt.payloadHash
    || controls.appleQaVerifierCredentialIdentityHash
      !== appleReceipt.stagingAppleQaVerifierCredentialIdentityHash
    || controls.productionAppleQaVerifierCredentialIdentityHash
      !== appleReceipt.productionAppleQaVerifierCredentialIdentityHash
    || controls.providerProjectIdentityHash
      !== providerReceipt.stagingProviderProjectIdentityHash
    || controls.productionProviderProjectIdentityHash
      !== providerReceipt.productionProviderProjectIdentityHash
    || controls.musicKitOriginRegistrationEvidenceHash
      !== appleReceipt.musicKitOriginRegistrationEvidenceHash
    || controls.appleAccountSeparationEvidenceHash
      !== signedArtifactSha256({
        stagingAppleAccountIdHash:
          appleReceipt.stagingAppleAccountIdHash,
        productionAppleAccountIdHash:
          appleReceipt.productionAppleAccountIdHash,
      })
    || controls.monthlyCostLimitUsd !== budgetReceipt.monthlyCostLimitUsd
    || controls.budgetRemainingUsd !== budgetReceipt.budgetRemainingUsd
    || controls.reservedForRequiredGatesUsd
      !== budgetReceipt.reservedForRequiredGatesUsd
  ) {
    throw new Error(
      "stable authorization finalization staging controls do not match the independently verified receipts",
    );
  }
  const publicRollout = verifyPublicRolloutFinalizationLineage(
    bundle.publicRolloutEvidence,
    input.releaseVerificationKey,
    {
      expectedTag: input.expectedTag,
      expectedVersion: finalization.candidate.version,
      expectedRevision: input.expectedRevision,
      expectedImageDigest: input.expectedImageDigest,
      expectedPromotionEvidenceHash: promotionEvidencePayloadHash,
      expectedPromotionConfigurationHash:
        releaseEvidenceConfigurationHash(promotion),
      expectedPromotionRuntimeHash: releaseEvidenceRuntimeHash(promotion),
      expectedSemanticBehaviorHash:
        promotion.semanticReview.semanticBehaviorHash,
      expectedProductionCanaryEvidenceHash:
        publicRolloutProductionCanaryEvidenceHash(promotion.gates),
      expectedSitesVersion: promotionProduction.sitesVersion,
      expectedSitesRevision: promotionProduction.sitesSourceRevision,
      minimumSoakStartedAt: promotion.generatedAt,
      now: input.now,
    },
  );
  if (
    finalization.lineage.publicRolloutEvidencePayloadHash
      !== publicRollout.payloadHash
    || finalization.lineage.publicRolloutCompletedAt
      !== publicRollout.soak.completedAt
    || finalization.lineage.publicRolloutIntentGroup
      !== publicRollout.intentGroup
    || finalization.lineage.publicRolloutFromPercent
      !== publicRollout.fromPercent
    || finalization.lineage.publicRolloutToPercent
      !== publicRollout.toPercent
    || finalization.lineage.publicRolloutTargetConfigurationHash
      !== publicRollout.targetConfigurationHash
  ) {
    throw new Error(
      "stable authorization finalization does not preserve the exact independently verified rollout transition",
    );
  }
  assertFinalizationRuntimePublicRolloutBindingV1({
    runtimePublicRollout: finalizationProduction.publicRollout,
    signedRollout: publicRollout,
  });

  const producerTrust = validateReleaseGateProducerTrustPolicyV1(
    input.approvedReleaseGateProducer,
  );
  const producerKeySha256 = releaseGateProducerKeyFingerprint(
    input.releaseGateProducerVerificationKey,
  );
  if (producerKeySha256 !== producerTrust.approvedKeySha256) {
    throw new Error(
      "stable authorization release gate producer does not use the protected approved key",
    );
  }
  const approvedSitesControlPlane =
    validateSitesControlPlaneTrustPolicyV1(
      input.approvedSitesControlPlane,
    );
  const gateArtifacts = exactObject(
    bundle.gateArtifacts,
    STABLE_RELEASE_FINALIZATION_SOURCE_GATES,
    "stable authorization gate artifacts",
  );
  const gateAttestations = exactObject(
    bundle.gateProducerAttestations,
    STABLE_RELEASE_FINALIZATION_SOURCE_GATES,
    "stable authorization gate producer attestations",
  );
  let sitesAttestationExpiresAt: string | null = null;
  for (const gateName of STABLE_RELEASE_FINALIZATION_SOURCE_GATES) {
    const artifact = validateReleaseGateArtifact(gateArtifacts[gateName]);
    if (artifact.gate !== gateName) {
      throw new Error(
        `stable authorization source artifact ${gateName} is mislabeled`,
      );
    }
    const producerAttestation = verifyReleaseGateProducerAttestation(
      gateAttestations[gateName],
      artifact,
      input.releaseGateProducerVerificationKey,
    );
    if (producerAttestation.signature.keyId !== producerTrust.approvedKeyId) {
      throw new Error(
        "stable authorization release gate producer key ID is not protected and approved",
      );
    }
    const phaseEvidence =
      gateName === "production_fixed_three_track"
        || gateName === "production_affected_regression"
        || gateName === "backend_release_convergence"
        ? promotion
        : finalization;
    const signedGate = phaseEvidence.gates.find(
      ({ name }) => name === gateName,
    );
    if (
      !signedGate
      || stableReleaseEvidenceJson(signedGate)
        !== stableReleaseEvidenceJson(canonicalReleaseGate(artifact))
      || artifact.configurationHash
        !== releaseEvidenceConfigurationHash(phaseEvidence)
      || artifact.runtimeHash !== releaseEvidenceRuntimeHash(phaseEvidence)
    ) {
      throw new Error(
        `stable authorization source artifact ${gateName} does not match its signed release evidence`,
      );
    }
    assertSameCandidate(phaseEvidence, artifact);

    if (
      gateName === "production_fixed_three_track"
      || gateName === "production_affected_regression"
    ) {
      const independentApple = record(
        artifact.sources.independentApple,
        `${gateName} independent Apple evidence`,
      );
      if (
        independentApple.verifierCredentialVersionHash
          !== promotionProduction.appleQaVerifierCredentialVersionHash
        || independentApple.verifierCredentialIdentityHash
          !== promotion.stagingControls
            .productionAppleQaVerifierCredentialIdentityHash
      ) {
        throw new Error(
          `stable authorization source artifact ${gateName} does not bind the independent production Apple verifier`,
        );
      }
    }

    if (
      gateName === "backend_release_convergence"
      || gateName === "release_convergence"
    ) {
      const convergence = record(
        artifact.sources.convergence,
        `${gateName} convergence source`,
      );
      const expected = record(
        convergence.expected,
        `${gateName} convergence expected identity`,
      );
      const sites = record(
        expected.sites,
        `${gateName} convergence expected Sites identity`,
      );
      const expectedSnapshot = gateName === "backend_release_convergence"
        ? promotionProduction
        : finalizationProduction;
      if (
        sites.version !== expectedSnapshot.sitesVersion
        || sites.revision !== expectedSnapshot.sitesSourceRevision
        || sites.candidateMatched !== expectedSnapshot.sitesCandidateMatched
      ) {
        throw new Error(
          `stable authorization source artifact ${gateName} does not bind the exact Sites runtime observation`,
        );
      }
      if (gateName === "release_convergence") {
        const expectedStage =
          `${publicRollout.intentGroup}:${publicRollout.fromPercent}->${publicRollout.toPercent}`;
        const observations = Array.isArray(convergence.observations)
          ? convergence.observations
          : [];
        if (observations.length < 2) {
          throw new Error(
            "stable authorization release convergence lacks repeated observations",
          );
        }
        for (const [index, value] of observations.entries()) {
          const observation = record(
            value,
            `stable authorization release convergence observation ${index}`,
          );
          const observedRuntime = record(
            observation.runtime,
            `stable authorization release convergence runtime ${index}`,
          );
          const observedSystem = record(
            observation.system,
            `stable authorization release convergence system ${index}`,
          );
          const observedRollout = record(
            observedSystem.publicRollout,
            `stable authorization release convergence rollout ${index}`,
          );
          if (
            observedRuntime.publicRolloutEvidenceHash
              !== publicRollout.payloadHash
            || observedRuntime.publicRolloutStage !== expectedStage
            || observedRollout.active !== true
            || observedRollout.databaseAuthorized !== true
            || observedRollout.evidenceHash !== publicRollout.payloadHash
            || observedRollout.stage !== expectedStage
            || observedRollout.targetConfigurationHash
              !== publicRollout.targetConfigurationHash
          ) {
            throw new Error(
              "stable authorization release convergence did not independently observe the exact signed rollout",
            );
          }
        }
      }
    }

    if (gateName === "final_custom_domain_browser") {
      const embeddedPolicy = validateSitesControlPlaneTrustPolicyV1(
        artifact.sources.sitesControlPlaneTrustPolicy,
      );
      const embeddedKey = validateSitesControlPlaneVerificationKeyV1(
        artifact.sources.sitesControlPlaneVerificationKey,
      );
      if (
        stableReleaseEvidenceJson(embeddedPolicy)
          !== stableReleaseEvidenceJson(approvedSitesControlPlane)
        || embeddedKey.source.sha256
          !== approvedSitesControlPlane.approvedKeySha256
      ) {
        throw new Error(
          "stable authorization Sites source does not use the protected approved key",
        );
      }
      const sitesReceipt = record(
        artifact.sources.sitesControlPlane,
        "stable authorization Sites deployment receipt",
      );
      const verifiedSitesControlPlane = verifySitesControlPlaneAttestation({
        value: artifact.sources.sitesControlPlaneAttestation,
        verificationKey: embeddedKey.key,
        expectedReceiptHash: String(sitesReceipt.evidenceHash),
        expectedKeyId: approvedSitesControlPlane.approvedKeyId,
        expectedKeyFingerprint:
          approvedSitesControlPlane.approvedKeySha256,
        now: input.now,
      });
      sitesAttestationExpiresAt = String(
        verifiedSitesControlPlane.payload.expiresAt,
      );
      const browser = record(
        artifact.sources.browser,
        "stable authorization final browser source",
      );
      assertFinalizationBrowserPublicRolloutBindingV1({
        probes: Array.isArray(browser.publicAssignmentProbes)
          ? browser.publicAssignmentProbes
          : [],
        signedRollout: publicRollout,
      });
      const rollbackTarget = record(
        sitesReceipt.rollbackTarget,
        "stable authorization Sites rollback target",
      );
      const previousSites = record(
        rollbackTarget.previous,
        "stable authorization previous Sites version",
      );
      if (
        previousSites.liveBuildVersion !== promotionProduction.sitesVersion
        || previousSites.liveBuildRevision
          !== promotionProduction.sitesSourceRevision
        || previousSites.commitSha
          !== promotionProduction.sitesSourceRevision
        || Date.parse(String(sitesReceipt.deploymentRequestedAt))
          <= Date.parse(publicRollout.soak.completedAt)
        || Date.parse(String(browser.observedAt))
          < Date.parse(String(sitesReceipt.observedAt))
        || Date.parse(finalizationProduction.generatedAt)
          < Date.parse(String(sitesReceipt.observedAt))
      ) {
        throw new Error(
          "stable authorization does not preserve rollout → Sites → browser finalization order",
        );
      }
    }
  }
  if (sitesAttestationExpiresAt === null) {
    throw new Error(
      "stable authorization finalization lacks a verified Sites attestation expiry",
    );
  }
  const nestedExpiresAt = [
    promotion.expiresAt,
    publicRollout.expiresAt,
    String(stagingControlPlane.payload.expiresAt),
    String(appleReceipt.payload.expiresAt),
    String(providerReceipt.payload.expiresAt),
    String(budgetReceipt.payload.expiresAt),
    sitesAttestationExpiresAt,
  ].reduce((earliest, value) => (
    Date.parse(value) < Date.parse(earliest) ? value : earliest
  ));
  return {
    producerKeySha256,
    sitesKeySha256: approvedSitesControlPlane.approvedKeySha256,
    stagingControlPlaneKeySha256:
      stagingControlPlane.verificationKeyFingerprint,
    receiptKeySha256: [
      appleReceipt.verificationKeyFingerprint,
      providerReceipt.verificationKeyFingerprint,
      budgetReceipt.verificationKeyFingerprint,
    ],
    expiresAt: nestedExpiresAt,
    publicRollout,
  };
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : "";
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function publicKey(value: string | Buffer | KeyObject): KeyObject {
  const parsed = value instanceof KeyObject ? value : createPublicKey(value);
  const key = parsed.type === "private" ? createPublicKey(parsed) : parsed;
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("stable release verification keys must be Ed25519");
  }
  return key;
}

function privateKey(value: string | Buffer | KeyObject): KeyObject {
  const key = value instanceof KeyObject ? value : createPrivateKey(value);
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("stable release authorizer key must be a private Ed25519 key");
  }
  return key;
}

export function stableReleaseKeyFingerprint(
  value: string | Buffer | KeyObject,
): string {
  return createHash("sha256")
    .update(publicKey(value).export({ format: "der", type: "spki" }))
    .digest("hex");
}

export function stableReleaseVerificationKeyV1(
  value: string | Buffer | KeyObject,
): StableReleaseVerificationKeyV1 {
  const key = publicKey(value);
  return {
    schemaVersion: "genio-stable-release-verification-key/v1",
    algorithm: "Ed25519",
    format: "spki-der",
    value: key.export({ format: "der", type: "spki" }).toString("base64url"),
    sha256: stableReleaseKeyFingerprint(key),
  };
}

export function validateStableReleaseVerificationKeyV1(
  value: unknown,
): {
  source: StableReleaseVerificationKeyV1;
  key: KeyObject;
} {
  const source = exactObject(value, [
    "schemaVersion",
    "algorithm",
    "format",
    "value",
    "sha256",
  ], "stable release verification key");
  if (
    source.schemaVersion
      !== "genio-stable-release-verification-key/v1"
    || source.algorithm !== "Ed25519"
    || source.format !== "spki-der"
    || typeof source.value !== "string"
    || !/^[0-9A-Za-z_-]{48,256}$/u.test(source.value)
    || typeof source.sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(source.sha256)
  ) {
    throw new Error("stable release verification key is invalid");
  }
  let key: KeyObject;
  try {
    key = publicKey(createPublicKey({
      key: Buffer.from(source.value, "base64url"),
      format: "der",
      type: "spki",
    }));
  } catch {
    throw new Error("stable release verification key is invalid");
  }
  if (
    source.sha256 !== stableReleaseKeyFingerprint(key)
    || source.value
      !== key.export({ format: "der", type: "spki" }).toString("base64url")
  ) {
    throw new Error("stable release verification key is invalid");
  }
  return {
    source: source as unknown as StableReleaseVerificationKeyV1,
    key,
  };
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function validateAuthorizationPayload(value: unknown): JsonRecord {
  const payload = exactObject(value, [
    "schemaVersion",
    "issuer",
    "generatedAt",
    "expiresAt",
    "action",
    "candidate",
    "finalizationEvidencePayloadHash",
    "finalBrowserGateEvidenceHash",
    "protectedBaselineMetadataHash",
  ], "stable release authorization");
  if (
    payload.schemaVersion !== STABLE_RELEASE_AUTHORIZATION_SCHEMA_V1
    || payload.issuer !== STABLE_RELEASE_AUTHORIZATION_ISSUER_V1
    || payload.action !== "create_stable_tag_and_github_release"
  ) {
    throw new Error("stable release authorization provenance is invalid");
  }
  const generatedAt = timestamp(
    payload.generatedAt,
    "stable release authorization generatedAt",
  );
  const expiresAt = timestamp(
    payload.expiresAt,
    "stable release authorization expiresAt",
  );
  if (
    Date.parse(expiresAt) <= Date.parse(generatedAt)
    || Date.parse(expiresAt) - Date.parse(generatedAt)
      > RELEASE_EVIDENCE_TTL_MS
  ) {
    throw new Error("stable release authorization must expire within 24 hours");
  }
  const candidate = exactObject(payload.candidate, [
    "rcTag",
    "stableTag",
    "version",
    "sourceRevision",
    "imageDigest",
  ], "stable release authorization candidate");
  const match = typeof candidate.rcTag === "string"
    ? TAG.exec(candidate.rcTag)
    : null;
  if (
    !match
    || candidate.version !== match[1]
    || candidate.stableTag !== `v${candidate.version}`
    || typeof candidate.sourceRevision !== "string"
    || !SOURCE_REVISION.test(candidate.sourceRevision)
    || typeof candidate.imageDigest !== "string"
    || !IMAGE_DIGEST.test(candidate.imageDigest)
  ) {
    throw new Error("stable release authorization candidate is invalid");
  }
  sha256Digest(
    payload.finalizationEvidencePayloadHash,
    "finalization evidence payload hash",
  );
  sha256Digest(
    payload.finalBrowserGateEvidenceHash,
    "final browser gate evidence hash",
  );
  sha256Digest(
    payload.protectedBaselineMetadataHash,
    "protected semantic baseline metadata hash",
  );
  return payload;
}

export function verifyStableReleaseAuthorization(input: {
  value: unknown;
  verificationKey: string | Buffer | KeyObject;
  approvedKeyId: string;
  approvedKeySha256: string;
  expectedRevision: string;
  expectedImageDigest: string;
  expectedRcTag: string;
  expectedFinalizationEvidencePayloadHash: string;
  expectedProtectedBaselineMetadataHash: string;
  now?: string;
}): JsonRecord {
  if (
    !KEY_ID.test(input.approvedKeyId)
    || sha256Digest(
      input.approvedKeySha256,
      "approved stable release authorizer key fingerprint",
    ) !== stableReleaseKeyFingerprint(input.verificationKey)
  ) {
    throw new Error(
      "stable release authorization does not use the protected approved key",
    );
  }
  const verified = verifyStrictSignedEnvelope({
    value: input.value,
    verificationKey: publicKey(input.verificationKey),
    envelopeSchemaVersion: SIGNED_STABLE_RELEASE_AUTHORIZATION_SCHEMA_V1,
    payloadLabel: "stable release authorization",
    validatePayload: validateAuthorizationPayload,
  });
  if (verified.keyId !== input.approvedKeyId) {
    throw new Error("stable release authorization key ID is not protected");
  }
  const candidate = verified.payload.candidate as JsonRecord;
  if (
    candidate.rcTag !== input.expectedRcTag
    || candidate.sourceRevision !== input.expectedRevision
    || candidate.imageDigest !== input.expectedImageDigest
    || verified.payload.finalizationEvidencePayloadHash
      !== input.expectedFinalizationEvidencePayloadHash
    || verified.payload.protectedBaselineMetadataHash
      !== input.expectedProtectedBaselineMetadataHash
  ) {
    throw new Error(
      "stable release authorization does not bind the exact finalized candidate",
    );
  }
  const now = Date.parse(
    input.now
      ? timestamp(input.now, "stable release authorization verification time")
      : new Date().toISOString(),
  );
  if (
    now < Date.parse(String(verified.payload.generatedAt)) - 5 * 60_000
    || now >= Date.parse(String(verified.payload.expiresAt))
  ) {
    throw new Error("stable release authorization is not currently valid");
  }
  return verified.payload;
}

export async function authorizeStableRelease(input: {
  candidateEvidence: unknown;
  finalizationEvidence: unknown;
  finalizationSourceEvidence: unknown;
  semanticReviewGateArtifact: unknown;
  semanticReviewGateProducerAttestation: unknown;
  protectedBaselineMetadata: unknown;
  releaseVerificationKey: string | Buffer | KeyObject;
  approvedReleaseKeySha256: string;
  releaseGateProducerVerificationKey: string | Buffer | KeyObject;
  approvedReleaseGateProducer: unknown;
  approvedSemanticReviewer: unknown;
  approvedSitesControlPlane: unknown;
  approvedStagingControlPlane: unknown;
  approvedControlPlaneReceipts: unknown;
  authorizerSigningKey: string | Buffer | KeyObject;
  approvedAuthorizerKeyId: string;
  approvedAuthorizerKeySha256: string;
  expectedRcTag: string;
  expectedVersion: string;
  expectedRevision: string;
  expectedImageDigest: string;
  generatedAt?: string;
}): Promise<ReturnType<typeof createStrictSignedEnvelope>> {
  if (
    sha256Digest(
      input.approvedReleaseKeySha256,
      "approved release evidence key fingerprint",
    ) !== stableReleaseKeyFingerprint(input.releaseVerificationKey)
  ) {
    throw new Error(
      "finalization evidence does not use the protected release key",
    );
  }
  if (
    !KEY_ID.test(input.approvedAuthorizerKeyId)
    || sha256Digest(
      input.approvedAuthorizerKeySha256,
      "approved stable authorizer key fingerprint",
    ) !== stableReleaseKeyFingerprint(input.authorizerSigningKey)
    || input.approvedAuthorizerKeySha256 === input.approvedReleaseKeySha256
  ) {
    throw new Error(
      "stable release authorizer must use its distinct protected key",
    );
  }
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const payload = verifyReleaseEvidence(
    input.finalizationEvidence,
    input.releaseVerificationKey,
    {
      expectedKind: "finalization",
      expectedTag: input.expectedRcTag,
      expectedRevision: input.expectedRevision,
      expectedImageDigest: input.expectedImageDigest,
      now: generatedAt,
    },
  );
  if (Date.parse(generatedAt) < Date.parse(payload.generatedAt)) {
    throw new Error(
      "stable release authorization cannot predate finalization evidence",
    );
  }
  if (payload.candidate.version !== input.expectedVersion) {
    throw new Error("finalization evidence version does not match the target");
  }
  const semanticAuthorizationEvidence =
    verifyCandidateSemanticReviewAuthorizationEvidence({
      candidateEvidence: input.candidateEvidence,
      semanticReviewGateArtifact: input.semanticReviewGateArtifact,
      semanticReviewGateProducerAttestation:
        input.semanticReviewGateProducerAttestation,
      releaseVerificationKey: input.releaseVerificationKey,
      releaseGateProducerVerificationKey:
        input.releaseGateProducerVerificationKey,
      approvedReleaseGateProducer: input.approvedReleaseGateProducer,
      approvedSemanticReviewer: input.approvedSemanticReviewer,
      expectedTag: input.expectedRcTag,
      expectedRevision: input.expectedRevision,
      expectedImageDigest: input.expectedImageDigest,
      now: generatedAt,
    });
  const finalizationSourceEvidence =
    verifyStableReleaseFinalizationSources({
      value: input.finalizationSourceEvidence,
      finalizationEvidence: payload,
      releaseVerificationKey: input.releaseVerificationKey,
      releaseGateProducerVerificationKey:
        input.releaseGateProducerVerificationKey,
      approvedReleaseGateProducer: input.approvedReleaseGateProducer,
      approvedSitesControlPlane: input.approvedSitesControlPlane,
      approvedStagingControlPlane: input.approvedStagingControlPlane,
      approvedControlPlaneReceipts: input.approvedControlPlaneReceipts,
      expectedTag: input.expectedRcTag,
      expectedRevision: input.expectedRevision,
      expectedImageDigest: input.expectedImageDigest,
      now: generatedAt,
    });
  const releaseKeySha256 = stableReleaseKeyFingerprint(
    input.releaseVerificationKey,
  );
  const authorizerKeySha256 = stableReleaseKeyFingerprint(
    input.authorizerSigningKey,
  );
  if (
    new Set([
      releaseKeySha256,
      authorizerKeySha256,
      semanticAuthorizationEvidence.producerKeySha256,
      semanticAuthorizationEvidence.reviewerKeySha256,
      finalizationSourceEvidence.sitesKeySha256,
      finalizationSourceEvidence.stagingControlPlaneKeySha256,
      ...finalizationSourceEvidence.receiptKeySha256,
    ]).size !== 9
    || finalizationSourceEvidence.producerKeySha256
      !== semanticAuthorizationEvidence.producerKeySha256
  ) {
    throw new Error(
      "stable release authorization requires separate release, gate producer, semantic reviewer, Sites, staging control-plane, Apple, provider, QA budget, and authorizer keys",
    );
  }
  if (
    payload.lineage.candidateEvidencePayloadHash
      !== semanticAuthorizationEvidence.candidateEvidencePayloadHash
    || payload.lineage.candidateEvidenceGeneratedAt
      !== semanticAuthorizationEvidence.candidateEvidenceGeneratedAt
    || payload.stagingControls.candidateEvidencePayloadHash
      !== semanticAuthorizationEvidence.candidateEvidencePayloadHash
    || payload.semanticReview.gateEvidenceHash
      !== semanticAuthorizationEvidence.gateEvidenceHash
    || payload.semanticReview.reviewedAt
      !== semanticAuthorizationEvidence.reviewedAt
    || payload.semanticReview.semanticBehaviorHash
      !== semanticAuthorizationEvidence.semanticBehaviorHash
    || !semanticFixturesMatch(
      payload.semanticReview.fixtures,
      semanticAuthorizationEvidence.fixtures,
    )
  ) {
    throw new Error(
      "finalization evidence does not preserve the independently verified candidate semantic review lineage",
    );
  }
  const finalBrowser = payload.gates.find(
    ({ name }) => name === "final_custom_domain_browser",
  );
  if (!finalBrowser) {
    throw new Error("finalization evidence has no final browser attestation");
  }
  const envelope = exactObject(input.finalizationEvidence, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], "signed finalization evidence");
  const finalizationEvidencePayloadHash = sha256Digest(
    envelope.payloadHash,
    "finalization evidence payload hash",
  );
  const protectedBaselineMetadata =
    validateSemanticRankingProtectedBaselineMetadataV1(
      input.protectedBaselineMetadata,
    );
  const expectedImageReference =
    payload.stagingControls.candidateImageReference;
  if (
    protectedBaselineMetadata.rcTag !== input.expectedRcTag
    || protectedBaselineMetadata.stableTag
      !== `v${input.expectedVersion}`
    || protectedBaselineMetadata.version !== input.expectedVersion
    || protectedBaselineMetadata.sourceRevision !== input.expectedRevision
    || protectedBaselineMetadata.imageDigest !== input.expectedImageDigest
    || protectedBaselineMetadata.imageReference !== expectedImageReference
    || protectedBaselineMetadata.finalizationEvidencePayloadHash
      !== finalizationEvidencePayloadHash
    || protectedBaselineMetadata.finalBrowserGateEvidenceHash
      !== finalBrowser.evidenceHash
    || !protectedBaselineFixturesMatch(
      protectedBaselineMetadata,
      semanticAuthorizationEvidence.fixtures,
    )
  ) {
    throw new Error(
      "protected semantic baseline metadata does not bind the exact finalized stable release",
    );
  }
  const protectedBaselineMetadataHash =
    semanticRankingProtectedBaselineMetadataSha256(
      protectedBaselineMetadata,
    );
  const expiresAt = new Date(Math.min(
    Date.parse(payload.expiresAt),
    Date.parse(
      semanticAuthorizationEvidence.candidateEvidence.expiresAt,
    ),
    Date.parse(finalizationSourceEvidence.expiresAt),
    Date.parse(generatedAt) + RELEASE_EVIDENCE_TTL_MS,
  )).toISOString();
  const authorization = createStrictSignedEnvelope({
    envelopeSchemaVersion: SIGNED_STABLE_RELEASE_AUTHORIZATION_SCHEMA_V1,
    payload: {
      schemaVersion: STABLE_RELEASE_AUTHORIZATION_SCHEMA_V1,
      issuer: STABLE_RELEASE_AUTHORIZATION_ISSUER_V1,
      generatedAt,
      expiresAt,
      action: "create_stable_tag_and_github_release",
      candidate: {
        rcTag: input.expectedRcTag,
        stableTag: `v${input.expectedVersion}`,
        version: input.expectedVersion,
        sourceRevision: input.expectedRevision,
        imageDigest: input.expectedImageDigest,
      },
      finalizationEvidencePayloadHash,
      finalBrowserGateEvidenceHash: finalBrowser.evidenceHash,
      protectedBaselineMetadataHash,
    },
    signingKey: privateKey(input.authorizerSigningKey),
    keyId: input.approvedAuthorizerKeyId,
  });
  verifyStableReleaseAuthorization({
    value: authorization,
    verificationKey: publicKey(input.authorizerSigningKey),
    approvedKeyId: input.approvedAuthorizerKeyId,
    approvedKeySha256: input.approvedAuthorizerKeySha256,
    expectedRevision: input.expectedRevision,
    expectedImageDigest: input.expectedImageDigest,
    expectedRcTag: input.expectedRcTag,
    expectedFinalizationEvidencePayloadHash:
      finalizationEvidencePayloadHash,
    expectedProtectedBaselineMetadataHash:
      protectedBaselineMetadataHash,
    now: generatedAt,
  });
  return authorization;
}

export function verifyStableReleaseConsumerBundle(input: {
  finalizationEvidence: unknown;
  protectedBaselineMetadata: unknown;
  releaseVerificationKey: string | Buffer | KeyObject;
  approvedReleaseKeySha256: string;
  stableAuthorization: unknown;
  stableAuthorizationVerificationKey: string | Buffer | KeyObject;
  approvedStableAuthorizerKeyId: string;
  approvedStableAuthorizerKeySha256: string;
  expectedRcTag: string;
  expectedVersion: string;
  expectedRevision: string;
  expectedImageDigest: string;
  expectedImageReference: string;
  now?: string;
}): StableReleaseConsumerManifestV1 {
  const verifiedAt = input.now
    ? timestamp(input.now, "stable release consumer verification time")
    : new Date().toISOString();
  const rcMatch = TAG.exec(input.expectedRcTag);
  if (
    !rcMatch
    || rcMatch[1] !== input.expectedVersion
    || !SOURCE_REVISION.test(input.expectedRevision)
    || !IMAGE_DIGEST.test(input.expectedImageDigest)
    || !IMAGE_REFERENCE.test(input.expectedImageReference)
    || !input.expectedImageReference.endsWith(
      `@${input.expectedImageDigest}`,
    )
  ) {
    throw new Error("stable release consumer target identity is invalid");
  }
  const protectedBaselineMetadata =
    validateSemanticRankingProtectedBaselineMetadataV1(
      input.protectedBaselineMetadata,
    );
  if (
    protectedBaselineMetadata.rcTag !== input.expectedRcTag
    || protectedBaselineMetadata.stableTag
      !== `v${input.expectedVersion}`
    || protectedBaselineMetadata.version !== input.expectedVersion
    || protectedBaselineMetadata.sourceRevision !== input.expectedRevision
    || protectedBaselineMetadata.imageDigest !== input.expectedImageDigest
    || protectedBaselineMetadata.imageReference
      !== input.expectedImageReference
  ) {
    throw new Error(
      "protected semantic baseline metadata does not bind the exact stable release target",
    );
  }
  const protectedBaselineMetadataHash =
    semanticRankingProtectedBaselineMetadataSha256(
      protectedBaselineMetadata,
    );
  const releaseKeySha256 = stableReleaseKeyFingerprint(
    input.releaseVerificationKey,
  );
  const stableKeySha256 = stableReleaseKeyFingerprint(
    input.stableAuthorizationVerificationKey,
  );
  if (
    sha256Digest(
      input.approvedReleaseKeySha256,
      "approved release verification key fingerprint",
    ) !== releaseKeySha256
    || sha256Digest(
      input.approvedStableAuthorizerKeySha256,
      "approved stable authorizer key fingerprint",
    ) !== stableKeySha256
    || releaseKeySha256 === stableKeySha256
  ) {
    throw new Error(
      "stable release consumer keys are unapproved or not independent",
    );
  }
  const finalization = verifyReleaseEvidence(
    input.finalizationEvidence,
    input.releaseVerificationKey,
    {
      expectedKind: "finalization",
      expectedTag: input.expectedRcTag,
      expectedRevision: input.expectedRevision,
      expectedImageDigest: input.expectedImageDigest,
      now: verifiedAt,
    },
  );
  if (
    Date.parse(verifiedAt) < Date.parse(finalization.generatedAt)
    || finalization.candidate.version !== input.expectedVersion
    || finalization.stagingControls.candidateImageReference
      !== input.expectedImageReference
    || finalization.stagingControls.controlPlanePhase !== "finalization"
    || finalization.environmentSnapshots.production?.scope !== "full"
    || finalization.environmentSnapshots.production.sitesCandidateMatched
      !== true
  ) {
    throw new Error(
      "finalization evidence does not bind the full post-Sites target",
    );
  }
  const finalizationEnvelope = exactObject(input.finalizationEvidence, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], "signed finalization evidence");
  const finalizationEvidencePayloadHash = sha256Digest(
    finalizationEnvelope.payloadHash,
    "finalization evidence payload hash",
  );
  const authorization = verifyStableReleaseAuthorization({
    value: input.stableAuthorization,
    verificationKey: input.stableAuthorizationVerificationKey,
    approvedKeyId: input.approvedStableAuthorizerKeyId,
    approvedKeySha256: input.approvedStableAuthorizerKeySha256,
    expectedRevision: input.expectedRevision,
    expectedImageDigest: input.expectedImageDigest,
    expectedRcTag: input.expectedRcTag,
    expectedFinalizationEvidencePayloadHash:
      finalizationEvidencePayloadHash,
    expectedProtectedBaselineMetadataHash:
      protectedBaselineMetadataHash,
    now: verifiedAt,
  });
  const authorizationCandidate = authorization.candidate as JsonRecord;
  const finalBrowser = finalization.gates.find(
    ({ name }) => name === "final_custom_domain_browser",
  );
  if (
    !finalBrowser
    || authorization.finalBrowserGateEvidenceHash
      !== finalBrowser.evidenceHash
    || protectedBaselineMetadata.finalizationEvidencePayloadHash
      !== finalizationEvidencePayloadHash
    || protectedBaselineMetadata.finalBrowserGateEvidenceHash
      !== finalBrowser.evidenceHash
    || !protectedBaselineFixturesMatch(
      protectedBaselineMetadata,
      finalization.semanticReview.fixtures,
    )
    || authorizationCandidate.version !== input.expectedVersion
    || authorizationCandidate.stableTag !== `v${input.expectedVersion}`
  ) {
    throw new Error(
      "stable authorization does not bind the exact final browser evidence",
    );
  }
  const authorizationEnvelope = exactObject(input.stableAuthorization, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], "signed stable release authorization");
  return {
    schemaVersion: "genio-stable-release-consumer-manifest/v2",
    verifiedAt,
    candidate: {
      rcTag: input.expectedRcTag,
      stableTag: `v${input.expectedVersion}`,
      version: input.expectedVersion,
      sourceRevision: input.expectedRevision,
      imageDigest: input.expectedImageDigest,
      imageReference: input.expectedImageReference,
    },
    finalizationEvidencePayloadHash,
    finalBrowserGateEvidenceHash: finalBrowser.evidenceHash,
    protectedBaselineMetadataHash,
    stableAuthorizationPayloadHash: sha256Digest(
      authorizationEnvelope.payloadHash,
      "stable authorization payload hash",
    ),
    releaseVerificationKeySha256: releaseKeySha256,
    stableAuthorizerKeyId: input.approvedStableAuthorizerKeyId,
    stableAuthorizerKeySha256: stableKeySha256,
  };
}

/**
 * Revalidates an immutable past stable release at the signed authorization
 * issuance time. Release evidence and authorization may be expired today, but
 * both must have been valid and overlapping when the protected stable
 * authorizer approved the release. Future-dated lineage still fails closed.
 */
export function verifyHistoricalStableReleaseConsumerBundle(
  input: Omit<
    Parameters<typeof verifyStableReleaseConsumerBundle>[0],
    "now"
  > & { now?: string },
): StableReleaseConsumerManifestV1 {
  const authorizationEnvelope = exactObject(input.stableAuthorization, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], "signed stable release authorization");
  const authorizationPayload = validateAuthorizationPayload(
    authorizationEnvelope.payload,
  );
  const issuedAt = timestamp(
    authorizationPayload.generatedAt,
    "historical stable release authorization generatedAt",
  );
  const currentTime = input.now
    ? timestamp(input.now, "historical stable release verification time")
    : new Date().toISOString();
  if (Date.parse(currentTime) < Date.parse(issuedAt)) {
    throw new Error("historical stable release lineage is future-dated");
  }
  return verifyStableReleaseConsumerBundle({
    ...input,
    now: issuedAt,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.filter((value) => value === CONFIRMATION_FLAG).length !== 1) {
    throw new Error(
      `stable release authorization requires ${CONFIRMATION_FLAG}`,
    );
  }
  const allowed = new Set([
    CONFIRMATION_FLAG,
    "--candidate-evidence",
    "--finalization-evidence",
    "--finalization-source-evidence",
    "--semantic-review-gate-artifact",
    "--semantic-review-gate-producer-attestation",
    "--protected-baseline-metadata",
    "--release-verification-key",
    "--release-gate-producer-verification-key",
    "--authorizer-signing-key",
    "--output",
    "--expected-rc-tag",
    "--expected-version",
    "--expected-revision",
    "--expected-image-digest",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!allowed.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    if (argument !== CONFIRMATION_FLAG) index += 1;
  }
  const [
    candidateEvidenceSource,
    finalizationEvidenceSource,
    finalizationSourceEvidenceSource,
    semanticReviewGateArtifactSource,
    semanticReviewGateProducerAttestationSource,
    protectedBaselineMetadataSource,
    releaseVerificationKey,
    releaseGateProducerVerificationKey,
    authorizerSigningKey,
  ] = await Promise.all([
    readFile(option(args, "--candidate-evidence"), "utf8"),
    readFile(option(args, "--finalization-evidence"), "utf8"),
    readFile(option(args, "--finalization-source-evidence"), "utf8"),
    readFile(option(args, "--semantic-review-gate-artifact"), "utf8"),
    readFile(
      option(args, "--semantic-review-gate-producer-attestation"),
      "utf8",
    ),
    readFile(option(args, "--protected-baseline-metadata"), "utf8"),
    readFile(option(args, "--release-verification-key")),
    readFile(option(args, "--release-gate-producer-verification-key")),
    readFile(option(args, "--authorizer-signing-key")),
  ]);
  const authorization = await authorizeStableRelease({
    candidateEvidence: JSON.parse(candidateEvidenceSource),
    finalizationEvidence: JSON.parse(finalizationEvidenceSource),
    finalizationSourceEvidence:
      JSON.parse(finalizationSourceEvidenceSource),
    semanticReviewGateArtifact:
      JSON.parse(semanticReviewGateArtifactSource),
    semanticReviewGateProducerAttestation:
      JSON.parse(semanticReviewGateProducerAttestationSource),
    protectedBaselineMetadata:
      JSON.parse(protectedBaselineMetadataSource),
    releaseVerificationKey,
    approvedReleaseKeySha256:
      process.env.RELEASE_VERIFICATION_KEY_SHA256?.trim().toLowerCase() ?? "",
    releaseGateProducerVerificationKey,
    approvedReleaseGateProducer: releaseGateProducerTrustPolicyV1({
      approvedKeyId:
        process.env.RELEASE_GATE_PRODUCER_KEY_ID?.trim() ?? "",
      approvedKeySha256:
        process.env.RELEASE_GATE_PRODUCER_KEY_SHA256
          ?.trim()
          .toLowerCase() ?? "",
    }),
    approvedSemanticReviewer: semanticRankingReviewerTrustPolicyV1({
      approvedKeyId:
        process.env.RELEASE_SEMANTIC_REVIEWER_KEY_ID?.trim() ?? "",
      approvedKeySha256:
        process.env.RELEASE_SEMANTIC_REVIEWER_KEY_SHA256
          ?.trim()
          .toLowerCase() ?? "",
      approvedBaselineMetadataSha256:
        process.env.RELEASE_SEMANTIC_BASELINE_METADATA_SHA256
          ?.trim()
          .toLowerCase() ?? "",
      approvedBaselineStableTag:
        process.env.RELEASE_SEMANTIC_BASELINE_STABLE_TAG?.trim() ?? "",
      approvedBaselineReleaseKeySha256:
        process.env.RELEASE_SEMANTIC_BASELINE_RELEASE_KEY_SHA256
          ?.trim()
          .toLowerCase() ?? "",
      approvedBaselineStableAuthorizerKeyId:
        process.env.RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_ID
          ?.trim() ?? "",
      approvedBaselineStableAuthorizerKeySha256:
        process.env
          .RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_SHA256
          ?.trim()
          .toLowerCase() ?? "",
    }),
    approvedSitesControlPlane: sitesControlPlaneTrustPolicyV1({
      approvedKeyId:
        process.env.RELEASE_SITES_CONTROL_PLANE_KEY_ID?.trim() ?? "",
      approvedKeySha256:
        process.env.RELEASE_SITES_CONTROL_PLANE_KEY_SHA256
          ?.trim()
          .toLowerCase() ?? "",
    }),
    approvedStagingControlPlane: stagingControlPlaneTrustPolicyV1({
      approvedKeyId:
        process.env.RELEASE_STAGING_CONTROL_PLANE_KEY_ID?.trim() ?? "",
      approvedKeySha256:
        process.env.RELEASE_STAGING_CONTROL_PLANE_KEY_SHA256
          ?.trim()
          .toLowerCase() ?? "",
    }),
    approvedControlPlaneReceipts: {
      apple: controlPlaneReceiptTrustPolicyV1({
        receiptKind: "apple",
        approvedIssuer:
          process.env.RELEASE_APPLE_CONTROL_PLANE_ISSUER?.trim() ?? "",
        approvedKeyId:
          process.env.RELEASE_APPLE_CONTROL_PLANE_KEY_ID?.trim() ?? "",
        approvedKeySha256:
          process.env.RELEASE_APPLE_CONTROL_PLANE_KEY_SHA256
            ?.trim()
            .toLowerCase() ?? "",
      }),
      provider: controlPlaneReceiptTrustPolicyV1({
        receiptKind: "provider",
        approvedIssuer:
          process.env.RELEASE_PROVIDER_CONTROL_PLANE_ISSUER?.trim() ?? "",
        approvedKeyId:
          process.env.RELEASE_PROVIDER_CONTROL_PLANE_KEY_ID?.trim() ?? "",
        approvedKeySha256:
          process.env.RELEASE_PROVIDER_CONTROL_PLANE_KEY_SHA256
            ?.trim()
            .toLowerCase() ?? "",
      }),
      qaBudget: controlPlaneReceiptTrustPolicyV1({
        receiptKind: "qa_budget",
        approvedIssuer:
          process.env.RELEASE_QA_BUDGET_LEDGER_ISSUER?.trim() ?? "",
        approvedKeyId:
          process.env.RELEASE_QA_BUDGET_LEDGER_KEY_ID?.trim() ?? "",
        approvedKeySha256:
          process.env.RELEASE_QA_BUDGET_LEDGER_KEY_SHA256
            ?.trim()
            .toLowerCase() ?? "",
      }),
    },
    authorizerSigningKey,
    approvedAuthorizerKeyId:
      process.env.RELEASE_STABLE_AUTHORIZER_KEY_ID?.trim() ?? "",
    approvedAuthorizerKeySha256:
      process.env.RELEASE_STABLE_AUTHORIZER_KEY_SHA256
        ?.trim()
        .toLowerCase() ?? "",
    expectedRcTag: option(args, "--expected-rc-tag"),
    expectedVersion: option(args, "--expected-version"),
    expectedRevision: option(args, "--expected-revision").toLowerCase(),
    expectedImageDigest: option(args, "--expected-image-digest").toLowerCase(),
  });
  const output = option(args, "--output");
  await writeFile(output, `${JSON.stringify(authorization, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    stableTag:
      (authorization.payload.candidate as JsonRecord).stableTag,
    finalizationEvidencePayloadHash:
      authorization.payload.finalizationEvidencePayloadHash,
    output,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "stable_release_authorization_failed",
      message: error instanceof Error
        ? error.message
        : "Stable release authorization failed",
    })}\n`);
    process.exitCode = 1;
  });
}
