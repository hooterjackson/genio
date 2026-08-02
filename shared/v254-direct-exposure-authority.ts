import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import {
  PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
  validatePublicRolloutConfiguration,
  type PublicRolloutConfiguration,
} from "./public-rollout-evidence.ts";
import {
  createStrictSignedEnvelope,
  exactObject,
  sha256Digest,
  signedArtifactSha256,
  type JsonRecord,
  verifyStrictSignedEnvelope,
} from "./signed-artifact.ts";

export const V254_DIRECT_EXPOSURE_AUTHORITY_SCHEMA_VERSION =
  "genio-v254-direct-exposure-authority/v1" as const;
export const SIGNED_V254_DIRECT_EXPOSURE_AUTHORITY_SCHEMA_VERSION =
  "genio-signed-v254-direct-exposure-authority/v1" as const;
export const V254_DIRECT_EXPOSURE_ROLLBACK_WARRANT_SCHEMA_VERSION =
  "genio-v254-direct-exposure-rollback-warrant/v1" as const;
export const SIGNED_V254_DIRECT_EXPOSURE_ROLLBACK_WARRANT_SCHEMA_VERSION =
  "genio-signed-v254-direct-exposure-rollback-warrant/v1" as const;
export const V254_DIRECT_EXPOSURE_ROLLBACK_PLAN_SCHEMA_VERSION =
  "genio-v254-direct-exposure-rollback-plan/v1" as const;

export type V254DirectExposureConfigurationV1 = Omit<
  PublicRolloutConfiguration,
  "PIPELINE_V3_OWNER_CANARY" | "PIPELINE_V3_OWNER_CANARY_GROUPS"
> & {
  PIPELINE_V3_OWNER_CANARY: "true" | "false";
  PIPELINE_V3_OWNER_CANARY_GROUPS: string;
};

export interface V254DirectExposureCandidateV1 {
  tag: string;
  version: string;
  sourceRevision: string;
  imageReference: string;
  imageDigest: string;
}

export type V254DirectExposureLaneV1 = "interactive" | "deep" | "api";

export interface V254DirectExposureServiceTargetV1 {
  serviceId: string;
  serviceName: "needle-worker" | "needle-deep-worker" | "needle-api";
  preExposureDeploymentId: string;
  targetImageReference: string;
  targetImageDigest: string;
  targetSourceRevision: string;
  preExposureSemanticConfigurationHash: string;
  postExposureSemanticConfigurationHash: string;
  rollbackDeploymentId: string;
  rollbackImageReference: string;
  rollbackImageDigest: string;
  rollbackSourceRevision: string;
  rollbackSemanticConfigurationHash: string;
}

export interface V254DirectExposureRuntimeTransitionV1 {
  preExposureSemanticConfigurationHash: string;
  postExposureSemanticConfigurationHash: string;
  rollbackSemanticConfigurationHash: string;
  services: Record<
    V254DirectExposureLaneV1,
    V254DirectExposureServiceTargetV1
  >;
  preExposureRuntimeTupleHash: string;
  postExposureRuntimeTupleHash: string;
  rollbackRuntimeTupleHash: string;
}

export interface V254DirectExposureRollbackPlanV1 {
  schemaVersion: typeof V254_DIRECT_EXPOSURE_ROLLBACK_PLAN_SCHEMA_VERSION;
  candidateHash: string;
  operation: "rollback_zero";
  route: "corpus_first_v3";
  intentGroup: "editorial_influence";
  fromPercent: "100";
  toPercent: "0";
  targetConfiguration: V254DirectExposureConfigurationV1;
  targetConfigurationHash: string;
  hardSwitchDisabled: true;
  globalPublicPause: true;
  intentPublicPause: true;
}

export interface V254DirectExposureAuthorityPayloadV1 {
  schemaVersion: typeof V254_DIRECT_EXPOSURE_AUTHORITY_SCHEMA_VERSION;
  generatedAt: string;
  expiresAt: string;
  environment: "production";
  candidate: V254DirectExposureCandidateV1;
  promotion: {
    signedNativePromotionAuthorityHash: string;
    nativePromotionReceiptHash: string;
    configurationHash: string;
    runtimeHash: string;
    semanticBehaviorHash: string;
    nativePromotionCompletedAt: string;
    sitesProjectId: string;
    sitesVersionId: string;
    sitesDeploymentId: string;
    sitesRevision: string;
    sitesDeployedAt: string;
    railwayProjectId: string;
    runtimeTransition: V254DirectExposureRuntimeTransitionV1;
  };
  transition: {
    operation: "direct_expose";
    route: "corpus_first_v3";
    intentGroup: "editorial_influence";
    fromPercent: "0";
    toPercent: "100";
    exposureClass: "fully_exposed_unproven";
    organicReliabilityProven: false;
    organicMetricsClaim: null;
    previousDirectExposureHash: null;
  };
  proofs: {
    ownerApple: {
      workflowPath: ".github/workflows/v254-owner-apple-gate.yml";
      gateEvidenceHash: string;
      attestationPayloadHash: string;
      manifestHash: string;
      expectedOrderedAppleIdsHash: string;
      observedOrderedAppleIdsHash: string;
      trackCount: 25;
      completedAt: string;
    };
    cleanNonOwner: {
      workflowPath: ".github/workflows/v254-pre-exposure-clean-nonowner.yml";
      gateEvidenceHash: string;
      attestationPayloadHash: string;
      assignmentReceiptHash: string;
      routeReceiptHash: string;
      successorContractHash: string;
      queryPlanHash: string;
      workerConsumptionReceiptHash: string;
      identityClass: "clean_non_owner";
      assignmentAuthority: "signed_release_canary";
      publicPercentageBypass: true;
      organicAssignment: false;
      manifestOnly: true;
      appleWriteAccess: "forbidden";
      completedAt: string;
    };
    databaseRouteAuthority: {
      receiptHash: string;
      phase: "public_canary";
      hardSwitchDisabled: false;
      globalPublicPause: true;
      intentPublicPause: true;
      completedAt: string;
    };
  };
  currentConfiguration: V254DirectExposureConfigurationV1;
  currentConfigurationHash: string;
  targetConfiguration: V254DirectExposureConfigurationV1;
  targetConfigurationHash: string;
  preconditionsHash: string;
  rollbackPlanHash: string;
}

export interface V254DirectExposureRollbackWarrantPayloadV1 {
  schemaVersion:
    typeof V254_DIRECT_EXPOSURE_ROLLBACK_WARRANT_SCHEMA_VERSION;
  generatedAt: string;
  environment: "production";
  candidate: V254DirectExposureCandidateV1;
  advance: {
    authorityPayloadHash: string;
    targetConfigurationHash: string;
    ownerAppleProofHash: string;
    cleanNonOwnerProofHash: string;
    routeReceiptHash: string;
    rollbackPlanHash: string;
    preExposureRuntimeTupleHash: string;
    postExposureRuntimeTupleHash: string;
    rollbackRuntimeTupleHash: string;
  };
  rollback: V254DirectExposureRollbackPlanV1;
  promotion: {
    signedNativePromotionAuthorityHash: string;
    nativePromotionReceiptHash: string;
    runtimeHash: string;
    sitesRevision: string;
  };
}

export interface V254DirectExposureExpectedV1 {
  keyId: string;
  keySha256: string;
  candidate: V254DirectExposureCandidateV1;
  signedNativePromotionAuthorityHash: string;
  nativePromotionReceiptHash: string;
  configurationHash: string;
  runtimeHash: string;
  semanticBehaviorHash: string;
  sites: {
    projectId: string;
    versionId: string;
    deploymentId: string;
    revision: string;
  };
  runtimeTransition: V254DirectExposureRuntimeTransitionV1;
  ownerAppleGateEvidenceHash: string;
  cleanNonOwnerGateEvidenceHash: string;
  databaseRouteReceiptHash: string;
  currentConfiguration: V254DirectExposureConfigurationV1;
  targetConfiguration: V254DirectExposureConfigurationV1;
  now?: string;
  verificationMode?: "advance" | "rollback";
}

export interface VerifiedV254DirectExposureV1 {
  authorityPayloadHash: string;
  rollbackWarrantPayloadHash: string;
  candidate: V254DirectExposureCandidateV1;
  currentConfiguration: V254DirectExposureConfigurationV1;
  currentConfigurationHash: string;
  targetConfiguration: V254DirectExposureConfigurationV1;
  targetConfigurationHash: string;
  rollbackPlan: V254DirectExposureRollbackPlanV1;
  rollbackPlanHash: string;
  runtimeTransition: V254DirectExposureRuntimeTransitionV1;
  preconditionsHash: string;
  ownerAppleProofHash: string;
  cleanNonOwnerProofHash: string;
  routeReceiptHash: string;
  exposureClass: "fully_exposed_unproven";
  organicReliabilityProven: false;
}

export const V254_DIRECT_EXPOSURE_PRECONDITIONS_SCHEMA_VERSION =
  "genio-v254-direct-exposure-preconditions/v1" as const;

const SHA1 = /^[0-9a-f]{40}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-rc\.[1-9]\d*$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_REFERENCE =
  /^ghcr\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/u;
const SAFE_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{0,255}$/u;
const SAFE_KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{0,159}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_AUTHORITY_LIFETIME_MS = 24 * 60 * 60 * 1_000;

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function safeId(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !SAFE_ID.test(value)
    || /(?:secret|token|password|authorization|sk-)/iu.test(value)
  ) {
    throw new Error(`${label} must be a non-secret identifier`);
  }
  return value;
}

function validateCandidate(value: unknown): V254DirectExposureCandidateV1 {
  const candidate = exactObject(value, [
    "tag", "version", "sourceRevision", "imageReference", "imageDigest",
  ], "direct-exposure candidate");
  const tag = typeof candidate.tag === "string" ? candidate.tag : "";
  const version = typeof candidate.version === "string"
    && VERSION.test(candidate.version)
    ? candidate.version
    : "";
  const tagMatch = TAG.exec(tag);
  if (!tagMatch || !version || tagMatch[1] !== version) {
    throw new Error("direct-exposure candidate tag and version do not match");
  }
  if (
    typeof candidate.sourceRevision !== "string"
    || !SHA1.test(candidate.sourceRevision)
  ) {
    throw new Error("direct-exposure candidate revision must be a full Git SHA");
  }
  if (
    typeof candidate.imageDigest !== "string"
    || !IMAGE_DIGEST.test(candidate.imageDigest)
    || typeof candidate.imageReference !== "string"
    || !IMAGE_REFERENCE.test(candidate.imageReference)
    || !candidate.imageReference.endsWith(`@${candidate.imageDigest}`)
  ) {
    throw new Error("direct-exposure candidate image identity is invalid");
  }
  return candidate as unknown as V254DirectExposureCandidateV1;
}

function validateConfiguration(
  value: unknown,
  label: string,
): V254DirectExposureConfigurationV1 {
  try {
    return validateV254DirectExposureConfigurationV1(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

/**
 * The legacy staged-rollout validator requires the owner canary to remain on.
 * Direct exposure intentionally removes that identity-based bypass while it
 * raises the public editorial percentage. Validate the complete legacy shape
 * first, then restore the one direct-exposure-only owner state.
 */
export function validateV254DirectExposureConfigurationV1(
  value: unknown,
): V254DirectExposureConfigurationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("direct-exposure configuration is invalid");
  }
  const input = value as Record<string, unknown>;
  const ownerCanary = input.PIPELINE_V3_OWNER_CANARY;
  const ownerGroups = input.PIPELINE_V3_OWNER_CANARY_GROUPS;
  if (ownerCanary === "true") {
    return validatePublicRolloutConfiguration(value);
  }
  if (ownerCanary !== "false" || ownerGroups !== "") {
    throw new Error(
      "direct-exposure public configuration must remove the owner bypass",
    );
  }
  const validated = validatePublicRolloutConfiguration({
    ...input,
    PIPELINE_V3_OWNER_CANARY: "true",
    PIPELINE_V3_OWNER_CANARY_GROUPS: "editorial_influence",
  });
  return Object.freeze({
    ...validated,
    PIPELINE_V3_OWNER_CANARY: "false",
    PIPELINE_V3_OWNER_CANARY_GROUPS: "",
  }) as unknown as V254DirectExposureConfigurationV1;
}

function assertDirectConfigurationDelta(
  current: V254DirectExposureConfigurationV1,
  target: V254DirectExposureConfigurationV1,
): void {
  const editorialFlag =
    PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS.editorial_influence;
  if (current[editorialFlag] !== "0" || target[editorialFlag] !== "100") {
    throw new Error("direct exposure must change editorial_influence 0 to 100");
  }
  if (
    current.PIPELINE_V3_OWNER_CANARY !== "true"
    || current.PIPELINE_V3_OWNER_CANARY_GROUPS !== "editorial_influence"
    || target.PIPELINE_V3_OWNER_CANARY !== "false"
    || target.PIPELINE_V3_OWNER_CANARY_GROUPS !== ""
  ) {
    throw new Error(
      "direct exposure must replace the owner-only bypass with public authority",
    );
  }
  for (const [intentGroup, flag] of Object.entries(
    PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
  )) {
    if (intentGroup === "editorial_influence") continue;
    if (current[flag] !== "0" || target[flag] !== "0") {
      throw new Error("unrelated direct-exposure intent percentages must remain zero");
    }
  }
  const changed = (Object.keys(current) as Array<keyof typeof current>).filter(
    (key) => current[key] !== target[key],
  );
  const permittedChanges = new Set<keyof typeof current>([
    editorialFlag,
    "PIPELINE_V3_OWNER_CANARY",
    "PIPELINE_V3_OWNER_CANARY_GROUPS",
  ]);
  if (
    changed.length !== permittedChanges.size
    || changed.some((key) => !permittedChanges.has(key))
  ) {
    throw new Error(
      "direct exposure may change only editorial percentage and owner bypass",
    );
  }
}

function validateOwnerApple(value: unknown): JsonRecord {
  const proof = exactObject(value, [
    "workflowPath", "gateEvidenceHash", "attestationPayloadHash",
    "manifestHash", "expectedOrderedAppleIdsHash",
    "observedOrderedAppleIdsHash", "trackCount", "completedAt",
  ], "direct-exposure owner Apple proof");
  if (
    proof.workflowPath !== ".github/workflows/v254-owner-apple-gate.yml"
    || proof.trackCount !== 25
  ) {
    throw new Error("direct-exposure owner Apple proof is not the exact gate");
  }
  for (const key of [
    "gateEvidenceHash", "attestationPayloadHash", "manifestHash",
    "expectedOrderedAppleIdsHash", "observedOrderedAppleIdsHash",
  ] as const) sha256Digest(proof[key], `owner Apple proof.${key}`);
  if (proof.expectedOrderedAppleIdsHash !== proof.observedOrderedAppleIdsHash) {
    throw new Error("direct-exposure owner Apple ordered IDs do not match");
  }
  timestamp(proof.completedAt, "owner Apple proof.completedAt");
  return proof;
}

function validateCleanNonOwner(value: unknown): JsonRecord {
  const proof = exactObject(value, [
    "workflowPath", "gateEvidenceHash", "attestationPayloadHash",
    "assignmentReceiptHash", "routeReceiptHash", "successorContractHash",
    "queryPlanHash", "workerConsumptionReceiptHash", "identityClass",
    "assignmentAuthority", "publicPercentageBypass", "organicAssignment",
    "manifestOnly", "appleWriteAccess", "completedAt",
  ], "direct-exposure clean non-owner proof");
  if (
    proof.workflowPath
      !== ".github/workflows/v254-pre-exposure-clean-nonowner.yml"
    || proof.identityClass !== "clean_non_owner"
    || proof.assignmentAuthority !== "signed_release_canary"
    || proof.publicPercentageBypass !== true
    || proof.organicAssignment !== false
    || proof.manifestOnly !== true
    || proof.appleWriteAccess !== "forbidden"
  ) {
    throw new Error("direct-exposure clean non-owner proof is not zero-write");
  }
  for (const key of [
    "gateEvidenceHash", "attestationPayloadHash", "assignmentReceiptHash",
    "routeReceiptHash", "successorContractHash", "queryPlanHash",
    "workerConsumptionReceiptHash",
  ] as const) sha256Digest(proof[key], `clean non-owner proof.${key}`);
  timestamp(proof.completedAt, "clean non-owner proof.completedAt");
  return proof;
}

function validateDatabaseRoute(value: unknown): JsonRecord {
  const proof = exactObject(value, [
    "receiptHash", "phase", "hardSwitchDisabled", "globalPublicPause",
    "intentPublicPause", "completedAt",
  ], "direct-exposure database route proof");
  if (
    proof.phase !== "public_canary"
    || proof.hardSwitchDisabled !== false
    || proof.globalPublicPause !== true
    || proof.intentPublicPause !== true
  ) {
    throw new Error("direct exposure requires the paused public-canary route");
  }
  sha256Digest(proof.receiptHash, "database route proof.receiptHash");
  timestamp(proof.completedAt, "database route proof.completedAt");
  return proof;
}

const DIRECT_SERVICE_NAMES = Object.freeze({
  interactive: "needle-worker",
  deep: "needle-deep-worker",
  api: "needle-api",
} as const);

/**
 * Bind only facts that must already be true before semantic variables are
 * staged. The post-exposure semantic hash is deliberately excluded: that hash
 * includes this precondition digest as a runtime marker, so including it here
 * would create an impossible cryptographic fixed point.
 */
export function v254DirectExposurePreconditionsHashV1(input: {
  candidate: V254DirectExposureCandidateV1;
  promotion: V254DirectExposureAuthorityPayloadV1["promotion"];
  proofs: V254DirectExposureAuthorityPayloadV1["proofs"];
  currentConfigurationHash: string;
  targetConfigurationHash: string;
  rollbackPlanHash: string;
}): string {
  const services = input.promotion.runtimeTransition.services;
  return signedArtifactSha256({
    schemaVersion: V254_DIRECT_EXPOSURE_PRECONDITIONS_SCHEMA_VERSION,
    candidate: input.candidate,
    promotion: {
      signedNativePromotionAuthorityHash:
        input.promotion.signedNativePromotionAuthorityHash,
      nativePromotionReceiptHash: input.promotion.nativePromotionReceiptHash,
      configurationHash: input.promotion.configurationHash,
      runtimeHash: input.promotion.runtimeHash,
      semanticBehaviorHash: input.promotion.semanticBehaviorHash,
      nativePromotionCompletedAt: input.promotion.nativePromotionCompletedAt,
      sitesProjectId: input.promotion.sitesProjectId,
      sitesVersionId: input.promotion.sitesVersionId,
      sitesDeploymentId: input.promotion.sitesDeploymentId,
      sitesRevision: input.promotion.sitesRevision,
      sitesDeployedAt: input.promotion.sitesDeployedAt,
      railwayProjectId: input.promotion.railwayProjectId,
      preExposureSemanticConfigurationHash:
        input.promotion.runtimeTransition
          .preExposureSemanticConfigurationHash,
      preExposureRuntimeTupleHash:
        input.promotion.runtimeTransition.preExposureRuntimeTupleHash,
      services: Object.fromEntries(
        (["interactive", "deep", "api"] as const).map((lane) => [lane, {
          serviceId: services[lane].serviceId,
          serviceName: services[lane].serviceName,
          preExposureDeploymentId: services[lane].preExposureDeploymentId,
          targetImageReference: services[lane].targetImageReference,
          targetImageDigest: services[lane].targetImageDigest,
          targetSourceRevision: services[lane].targetSourceRevision,
          preExposureSemanticConfigurationHash:
            services[lane].preExposureSemanticConfigurationHash,
        }]),
      ),
    },
    proofs: input.proofs,
    currentConfigurationHash: input.currentConfigurationHash,
    targetConfigurationHash: input.targetConfigurationHash,
    rollbackPlanHash: input.rollbackPlanHash,
  });
}

function runtimeTupleV1(input: {
  candidate: V254DirectExposureCandidateV1;
  services: V254DirectExposureRuntimeTransitionV1["services"];
  phase: "pre" | "post" | "rollback";
}): unknown {
  return {
    candidate: input.candidate,
    phase: input.phase,
    services: Object.fromEntries(
      (["interactive", "deep", "api"] as const).map((lane) => {
        const target = input.services[lane];
        return [lane, input.phase === "pre"
          ? {
              serviceId: target.serviceId,
              deploymentId: target.preExposureDeploymentId,
              imageReference: target.targetImageReference,
              imageDigest: target.targetImageDigest,
              sourceRevision: target.targetSourceRevision,
              semanticConfigurationHash:
                target.preExposureSemanticConfigurationHash,
            }
          : input.phase === "post"
            ? {
                serviceId: target.serviceId,
                imageReference: target.targetImageReference,
                imageDigest: target.targetImageDigest,
                sourceRevision: target.targetSourceRevision,
                semanticConfigurationHash:
                  target.postExposureSemanticConfigurationHash,
              }
            : {
                serviceId: target.serviceId,
                deploymentId: target.rollbackDeploymentId,
                imageReference: target.rollbackImageReference,
                imageDigest: target.rollbackImageDigest,
                sourceRevision: target.rollbackSourceRevision,
                semanticConfigurationHash:
                  target.rollbackSemanticConfigurationHash,
              }];
      }),
    ),
  };
}

export function validateV254DirectExposureRuntimeTransitionV1(
  value: unknown,
  candidateValue: V254DirectExposureCandidateV1,
  promotionConfigurationHash: string,
): V254DirectExposureRuntimeTransitionV1 {
  const candidate = validateCandidate(candidateValue);
  sha256Digest(
    promotionConfigurationHash,
    "direct-exposure promotion configuration hash",
  );
  const transition = exactObject(value, [
    "preExposureSemanticConfigurationHash",
    "postExposureSemanticConfigurationHash",
    "rollbackSemanticConfigurationHash",
    "services",
    "preExposureRuntimeTupleHash",
    "postExposureRuntimeTupleHash",
    "rollbackRuntimeTupleHash",
  ], "direct-exposure runtime transition");
  for (const key of [
    "preExposureSemanticConfigurationHash",
    "postExposureSemanticConfigurationHash",
    "rollbackSemanticConfigurationHash",
    "preExposureRuntimeTupleHash",
    "postExposureRuntimeTupleHash",
    "rollbackRuntimeTupleHash",
  ] as const) sha256Digest(
    transition[key],
    `direct-exposure runtime transition.${key}`,
  );
  if (
    transition.preExposureSemanticConfigurationHash
      !== promotionConfigurationHash
    || transition.rollbackSemanticConfigurationHash
      !== transition.preExposureSemanticConfigurationHash
    || transition.postExposureSemanticConfigurationHash
      === transition.preExposureSemanticConfigurationHash
  ) {
    throw new Error(
      "direct-exposure runtime transition does not bind distinct pre/post and rollback semantics",
    );
  }
  const servicesValue = exactObject(
    transition.services,
    ["interactive", "deep", "api"],
    "direct-exposure runtime services",
  );
  const services = {} as Record<
    V254DirectExposureLaneV1,
    V254DirectExposureServiceTargetV1
  >;
  const serviceIds = new Set<string>();
  const deploymentIds = new Set<string>();
  for (const lane of ["interactive", "deep", "api"] as const) {
    const service = exactObject(servicesValue[lane], [
      "serviceId", "serviceName", "preExposureDeploymentId",
      "targetImageReference", "targetImageDigest", "targetSourceRevision",
      "preExposureSemanticConfigurationHash",
      "postExposureSemanticConfigurationHash", "rollbackDeploymentId",
      "rollbackImageReference", "rollbackImageDigest",
      "rollbackSourceRevision", "rollbackSemanticConfigurationHash",
    ], `direct-exposure ${lane} service target`);
    if (
      typeof service.serviceId !== "string"
      || !UUID.test(service.serviceId)
      || service.serviceName !== DIRECT_SERVICE_NAMES[lane]
      || typeof service.preExposureDeploymentId !== "string"
      || !UUID.test(service.preExposureDeploymentId)
      || typeof service.rollbackDeploymentId !== "string"
      || !UUID.test(service.rollbackDeploymentId)
      || service.rollbackDeploymentId !== service.preExposureDeploymentId
      || service.targetImageReference !== candidate.imageReference
      || service.targetImageDigest !== candidate.imageDigest
      || service.targetSourceRevision !== candidate.sourceRevision
      || service.rollbackImageReference !== candidate.imageReference
      || service.rollbackImageDigest !== candidate.imageDigest
      || service.rollbackSourceRevision !== candidate.sourceRevision
      || service.preExposureSemanticConfigurationHash
        !== transition.preExposureSemanticConfigurationHash
      || service.postExposureSemanticConfigurationHash
        !== transition.postExposureSemanticConfigurationHash
      || service.rollbackSemanticConfigurationHash
        !== transition.rollbackSemanticConfigurationHash
      || serviceIds.has(service.serviceId)
      || deploymentIds.has(service.preExposureDeploymentId)
    ) {
      throw new Error(
        `direct-exposure ${lane} service/image/rollback target is invalid`,
      );
    }
    serviceIds.add(service.serviceId);
    deploymentIds.add(service.preExposureDeploymentId);
    services[lane] = service as unknown as V254DirectExposureServiceTargetV1;
  }
  const expectedTupleHashes = {
    preExposureRuntimeTupleHash: signedArtifactSha256(runtimeTupleV1({
      candidate,
      services,
      phase: "pre",
    })),
    postExposureRuntimeTupleHash: signedArtifactSha256(runtimeTupleV1({
      candidate,
      services,
      phase: "post",
    })),
    rollbackRuntimeTupleHash: signedArtifactSha256(runtimeTupleV1({
      candidate,
      services,
      phase: "rollback",
    })),
  };
  for (const [key, expected] of Object.entries(expectedTupleHashes)) {
    if (transition[key] !== expected) {
      throw new Error("direct-exposure runtime tuple hash does not match");
    }
  }
  return transition as unknown as V254DirectExposureRuntimeTransitionV1;
}

export function createV254DirectExposureRuntimeTransitionV1(input: {
  candidate: V254DirectExposureCandidateV1;
  preExposureSemanticConfigurationHash: string;
  postExposureSemanticConfigurationHash: string;
  services: V254DirectExposureRuntimeTransitionV1["services"];
}): V254DirectExposureRuntimeTransitionV1 {
  const base = {
    preExposureSemanticConfigurationHash:
      input.preExposureSemanticConfigurationHash,
    postExposureSemanticConfigurationHash:
      input.postExposureSemanticConfigurationHash,
    rollbackSemanticConfigurationHash:
      input.preExposureSemanticConfigurationHash,
    services: structuredClone(input.services),
  };
  return validateV254DirectExposureRuntimeTransitionV1({
    ...base,
    preExposureRuntimeTupleHash: signedArtifactSha256(runtimeTupleV1({
      candidate: input.candidate,
      services: input.services,
      phase: "pre",
    })),
    postExposureRuntimeTupleHash: signedArtifactSha256(runtimeTupleV1({
      candidate: input.candidate,
      services: input.services,
      phase: "post",
    })),
    rollbackRuntimeTupleHash: signedArtifactSha256(runtimeTupleV1({
      candidate: input.candidate,
      services: input.services,
      phase: "rollback",
    })),
  }, input.candidate, input.preExposureSemanticConfigurationHash);
}

function validatePromotion(value: unknown, candidate: V254DirectExposureCandidateV1): JsonRecord {
  const promotion = exactObject(value, [
    "signedNativePromotionAuthorityHash", "nativePromotionReceiptHash",
    "configurationHash", "runtimeHash", "semanticBehaviorHash",
    "nativePromotionCompletedAt",
    "sitesProjectId", "sitesVersionId", "sitesDeploymentId",
    "sitesRevision", "sitesDeployedAt", "railwayProjectId",
    "runtimeTransition",
  ], "direct-exposure promotion");
  for (const key of [
    "signedNativePromotionAuthorityHash", "nativePromotionReceiptHash",
    "configurationHash", "runtimeHash", "semanticBehaviorHash",
  ] as const) sha256Digest(promotion[key], `direct-exposure promotion.${key}`);
  safeId(promotion.sitesProjectId, "direct-exposure Sites project ID");
  safeId(promotion.sitesVersionId, "direct-exposure Sites version ID");
  safeId(promotion.sitesDeploymentId, "direct-exposure Sites deployment ID");
  if (
    typeof promotion.railwayProjectId !== "string"
    || !UUID.test(promotion.railwayProjectId)
  ) throw new Error("direct-exposure Railway project ID is invalid");
  timestamp(
    promotion.nativePromotionCompletedAt,
    "direct-exposure native promotion completion",
  );
  timestamp(promotion.sitesDeployedAt, "direct-exposure Sites deployment time");
  if (promotion.sitesRevision !== candidate.sourceRevision) {
    throw new Error("direct exposure requires candidate-matched Sites");
  }
  validateV254DirectExposureRuntimeTransitionV1(
    promotion.runtimeTransition,
    candidate,
    String(promotion.configurationHash),
  );
  return promotion;
}

export function createV254DirectExposureRollbackPlanV1(input: {
  candidate: V254DirectExposureCandidateV1;
  targetConfiguration: V254DirectExposureConfigurationV1;
}): V254DirectExposureRollbackPlanV1 {
  const candidate = validateCandidate(input.candidate);
  const configuration = validateConfiguration(
    input.targetConfiguration,
    "direct-exposure rollback configuration",
  );
  if (
    configuration[
      PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS.editorial_influence
    ] !== "0"
  ) {
    throw new Error("direct-exposure rollback must target zero");
  }
  return Object.freeze({
    schemaVersion: V254_DIRECT_EXPOSURE_ROLLBACK_PLAN_SCHEMA_VERSION,
    candidateHash: signedArtifactSha256(candidate),
    operation: "rollback_zero",
    route: "corpus_first_v3",
    intentGroup: "editorial_influence",
    fromPercent: "100",
    toPercent: "0",
    targetConfiguration: configuration,
    targetConfigurationHash: signedArtifactSha256(configuration),
    hardSwitchDisabled: true,
    globalPublicPause: true,
    intentPublicPause: true,
  });
}

function validateRollbackPlan(value: unknown): V254DirectExposureRollbackPlanV1 {
  const plan = exactObject(value, [
    "schemaVersion", "candidateHash", "operation", "route", "intentGroup",
    "fromPercent", "toPercent", "targetConfiguration",
    "targetConfigurationHash", "hardSwitchDisabled", "globalPublicPause",
    "intentPublicPause",
  ], "direct-exposure rollback plan");
  if (
    plan.schemaVersion !== V254_DIRECT_EXPOSURE_ROLLBACK_PLAN_SCHEMA_VERSION
    || plan.operation !== "rollback_zero"
    || plan.route !== "corpus_first_v3"
    || plan.intentGroup !== "editorial_influence"
    || plan.fromPercent !== "100"
    || plan.toPercent !== "0"
    || plan.hardSwitchDisabled !== true
    || plan.globalPublicPause !== true
    || plan.intentPublicPause !== true
  ) throw new Error("direct-exposure rollback plan is invalid");
  sha256Digest(plan.candidateHash, "rollback plan.candidateHash");
  const configuration = validateConfiguration(
    plan.targetConfiguration,
    "rollback plan target configuration",
  );
  const configurationHash = sha256Digest(
    plan.targetConfigurationHash,
    "rollback plan target configuration hash",
  );
  if (
    signedArtifactSha256(configuration) !== configurationHash
    || configuration[
      PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS.editorial_influence
    ] !== "0"
  ) throw new Error("direct-exposure rollback configuration does not match");
  return plan as unknown as V254DirectExposureRollbackPlanV1;
}

export function validateV254DirectExposureAuthorityPayloadV1(
  value: unknown,
): V254DirectExposureAuthorityPayloadV1 {
  const payload = exactObject(value, [
    "schemaVersion", "generatedAt", "expiresAt", "environment", "candidate",
    "promotion", "transition", "proofs", "currentConfiguration",
    "currentConfigurationHash", "targetConfiguration",
    "targetConfigurationHash", "preconditionsHash", "rollbackPlanHash",
  ], "v2.5.4 direct-exposure authority");
  if (
    payload.schemaVersion !== V254_DIRECT_EXPOSURE_AUTHORITY_SCHEMA_VERSION
    || payload.environment !== "production"
  ) throw new Error("direct-exposure authority is not production v1");
  const generatedAt = timestamp(payload.generatedAt, "direct authority.generatedAt");
  const expiresAt = timestamp(payload.expiresAt, "direct authority.expiresAt");
  const lifetime = Date.parse(expiresAt) - Date.parse(generatedAt);
  if (lifetime <= 0 || lifetime > MAX_AUTHORITY_LIFETIME_MS) {
    throw new Error("direct-exposure authority must expire within 24 hours");
  }
  const candidate = validateCandidate(payload.candidate);
  const promotion = validatePromotion(payload.promotion, candidate);
  const transition = exactObject(payload.transition, [
    "operation", "route", "intentGroup", "fromPercent", "toPercent",
    "exposureClass", "organicReliabilityProven", "organicMetricsClaim",
    "previousDirectExposureHash",
  ], "direct-exposure transition");
  if (
    transition.operation !== "direct_expose"
    || transition.route !== "corpus_first_v3"
    || transition.intentGroup !== "editorial_influence"
    || transition.fromPercent !== "0"
    || transition.toPercent !== "100"
    || transition.exposureClass !== "fully_exposed_unproven"
    || transition.organicReliabilityProven !== false
    || transition.organicMetricsClaim !== null
    || transition.previousDirectExposureHash !== null
  ) throw new Error("direct exposure must not claim organic rollout evidence");
  const proofs = exactObject(payload.proofs, [
    "ownerApple", "cleanNonOwner", "databaseRouteAuthority",
  ], "direct-exposure proofs");
  const owner = validateOwnerApple(proofs.ownerApple);
  const clean = validateCleanNonOwner(proofs.cleanNonOwner);
  const route = validateDatabaseRoute(proofs.databaseRouteAuthority);
  if (
    Date.parse(String(owner.completedAt)) > Date.parse(generatedAt)
    || Date.parse(String(clean.completedAt)) > Date.parse(generatedAt)
    || Date.parse(generatedAt) - Date.parse(String(owner.completedAt))
      > MAX_AUTHORITY_LIFETIME_MS
    || Date.parse(generatedAt) - Date.parse(String(clean.completedAt))
      > MAX_AUTHORITY_LIFETIME_MS
    || Date.parse(generatedAt) - Date.parse(String(route.completedAt))
      > MAX_AUTHORITY_LIFETIME_MS
    || Date.parse(String(route.completedAt))
      > Date.parse(String(clean.completedAt))
    || Date.parse(String(owner.completedAt))
      > Date.parse(String(route.completedAt))
    || Date.parse(String(promotion.nativePromotionCompletedAt))
      > Date.parse(String(promotion.sitesDeployedAt))
    || Date.parse(String(promotion.sitesDeployedAt))
      > Date.parse(String(owner.completedAt))
    || Date.parse(String(owner.completedAt))
      > Date.parse(String(clean.completedAt))
  ) throw new Error("direct-exposure proof chronology is invalid");
  const current = validateConfiguration(
    payload.currentConfiguration,
    "direct-exposure current configuration",
  );
  const target = validateConfiguration(
    payload.targetConfiguration,
    "direct-exposure target configuration",
  );
  assertDirectConfigurationDelta(current, target);
  if (
    sha256Digest(payload.currentConfigurationHash, "current configuration hash")
      !== signedArtifactSha256(current)
    || sha256Digest(payload.targetConfigurationHash, "target configuration hash")
      !== signedArtifactSha256(target)
  ) throw new Error("direct-exposure configuration hash does not match");
  const preconditionsHash = sha256Digest(
    payload.preconditionsHash,
    "direct-exposure preconditions hash",
  );
  const rollbackPlan = createV254DirectExposureRollbackPlanV1({
    candidate,
    targetConfiguration: current,
  });
  if (
    sha256Digest(payload.rollbackPlanHash, "direct-exposure rollback plan hash")
      !== signedArtifactSha256(rollbackPlan)
  ) throw new Error("direct-exposure rollback plan hash does not match");
  if (preconditionsHash !== v254DirectExposurePreconditionsHashV1({
    candidate,
    promotion: promotion as unknown as V254DirectExposureAuthorityPayloadV1["promotion"],
    proofs: proofs as unknown as V254DirectExposureAuthorityPayloadV1["proofs"],
    currentConfigurationHash: String(payload.currentConfigurationHash),
    targetConfigurationHash: String(payload.targetConfigurationHash),
    rollbackPlanHash: String(payload.rollbackPlanHash),
  })) {
    throw new Error("direct-exposure preconditions hash does not match");
  }
  return payload as unknown as V254DirectExposureAuthorityPayloadV1;
}

export function createSignedV254DirectExposureAuthorityV1(input: {
  payload: V254DirectExposureAuthorityPayloadV1;
  signingKey: string | Buffer | KeyObject;
  keyId: string;
}) {
  if (!SAFE_KEY_ID.test(input.keyId)) {
    throw new Error("direct-exposure signing key ID is invalid");
  }
  const payload = validateV254DirectExposureAuthorityPayloadV1(input.payload);
  return createStrictSignedEnvelope({
    envelopeSchemaVersion:
      SIGNED_V254_DIRECT_EXPOSURE_AUTHORITY_SCHEMA_VERSION,
    payload: payload as unknown as JsonRecord,
    signingKey: input.signingKey,
    keyId: input.keyId,
  });
}

export function validateV254DirectExposureRollbackWarrantPayloadV1(
  value: unknown,
): V254DirectExposureRollbackWarrantPayloadV1 {
  const payload = exactObject(value, [
    "schemaVersion", "generatedAt", "environment", "candidate", "advance",
    "rollback", "promotion",
  ], "v2.5.4 direct-exposure rollback warrant");
  if (
    payload.schemaVersion
      !== V254_DIRECT_EXPOSURE_ROLLBACK_WARRANT_SCHEMA_VERSION
    || payload.environment !== "production"
  ) throw new Error("direct-exposure rollback warrant is not production v1");
  timestamp(payload.generatedAt, "direct rollback warrant.generatedAt");
  validateCandidate(payload.candidate);
  const advance = exactObject(payload.advance, [
    "authorityPayloadHash", "targetConfigurationHash", "ownerAppleProofHash",
    "cleanNonOwnerProofHash", "routeReceiptHash", "rollbackPlanHash",
    "preExposureRuntimeTupleHash", "postExposureRuntimeTupleHash",
    "rollbackRuntimeTupleHash",
  ], "direct rollback warrant advance");
  for (const key of Object.keys(advance)) {
    sha256Digest(advance[key], `direct rollback warrant advance.${key}`);
  }
  validateRollbackPlan(payload.rollback);
  const promotion = exactObject(payload.promotion, [
    "signedNativePromotionAuthorityHash", "nativePromotionReceiptHash",
    "runtimeHash", "sitesRevision",
  ], "direct rollback warrant promotion");
  for (const key of [
    "signedNativePromotionAuthorityHash", "nativePromotionReceiptHash",
    "runtimeHash",
  ] as const) sha256Digest(promotion[key], `direct warrant promotion.${key}`);
  if (typeof promotion.sitesRevision !== "string" || !SHA1.test(promotion.sitesRevision)) {
    throw new Error("direct warrant Sites revision is invalid");
  }
  return payload as unknown as V254DirectExposureRollbackWarrantPayloadV1;
}

export function createSignedV254DirectExposureRollbackWarrantV1(input: {
  payload: V254DirectExposureRollbackWarrantPayloadV1;
  signingKey: string | Buffer | KeyObject;
  keyId: string;
}) {
  if (!SAFE_KEY_ID.test(input.keyId)) {
    throw new Error("direct rollback warrant signing key ID is invalid");
  }
  const payload = validateV254DirectExposureRollbackWarrantPayloadV1(
    input.payload,
  );
  return createStrictSignedEnvelope({
    envelopeSchemaVersion:
      SIGNED_V254_DIRECT_EXPOSURE_ROLLBACK_WARRANT_SCHEMA_VERSION,
    payload: payload as unknown as JsonRecord,
    signingKey: input.signingKey,
    keyId: input.keyId,
  });
}

export function verifyV254DirectExposureAuthorityAndWarrantV1(input: {
  authority: unknown;
  rollbackWarrant: unknown;
  verificationKey: string | Buffer | KeyObject;
  expected: V254DirectExposureExpectedV1;
}): VerifiedV254DirectExposureV1 {
  if (!SAFE_KEY_ID.test(input.expected.keyId)) {
    throw new Error("expected direct-exposure key ID is invalid");
  }
  sha256Digest(input.expected.keySha256, "expected direct-exposure key digest");
  const key = typeof input.verificationKey === "string"
      || Buffer.isBuffer(input.verificationKey)
    ? createPublicKey(input.verificationKey as string | Buffer)
    : (input.verificationKey as KeyObject).type === "public"
      ? input.verificationKey as KeyObject
      : createPublicKey(input.verificationKey as KeyObject);
  if (
    key.asymmetricKeyType !== "ed25519"
    || createHash("sha256")
      .update(key.export({ format: "der", type: "spki" }))
      .digest("hex") !== input.expected.keySha256
  ) throw new Error("direct exposure did not use the protected rollout key");
  const authorityEnvelope = verifyStrictSignedEnvelope({
    value: input.authority,
    verificationKey: input.verificationKey,
    envelopeSchemaVersion:
      SIGNED_V254_DIRECT_EXPOSURE_AUTHORITY_SCHEMA_VERSION,
    payloadLabel: "v2.5.4 direct-exposure authority",
    validatePayload(value) {
      return validateV254DirectExposureAuthorityPayloadV1(
        value,
      ) as unknown as JsonRecord;
    },
  });
  const warrantEnvelope = verifyStrictSignedEnvelope({
    value: input.rollbackWarrant,
    verificationKey: input.verificationKey,
    envelopeSchemaVersion:
      SIGNED_V254_DIRECT_EXPOSURE_ROLLBACK_WARRANT_SCHEMA_VERSION,
    payloadLabel: "v2.5.4 direct-exposure rollback warrant",
    validatePayload(value) {
      return validateV254DirectExposureRollbackWarrantPayloadV1(
        value,
      ) as unknown as JsonRecord;
    },
  });
  if (
    authorityEnvelope.keyId !== input.expected.keyId
    || warrantEnvelope.keyId !== input.expected.keyId
  ) throw new Error("direct exposure did not use the protected rollout key ID");
  const authority = authorityEnvelope.payload as unknown as V254DirectExposureAuthorityPayloadV1;
  const warrant = warrantEnvelope.payload as unknown as V254DirectExposureRollbackWarrantPayloadV1;
  const now = input.expected.now
    ? Date.parse(timestamp(input.expected.now, "direct-exposure verification time"))
    : Date.now();
  if (Date.parse(authority.generatedAt) > now + 5 * 60_000) {
    throw new Error("direct-exposure authority was generated in the future");
  }
  if (
    now >= Date.parse(authority.expiresAt)
    && input.expected.verificationMode !== "rollback"
  ) {
    throw new Error("direct-exposure authority has expired");
  }
  const expected = input.expected;
  const exact = (left: unknown, right: unknown) => (
    signedArtifactSha256(left) === signedArtifactSha256(right)
  );
  if (
    !exact(authority.candidate, expected.candidate)
    || authority.promotion.signedNativePromotionAuthorityHash
      !== expected.signedNativePromotionAuthorityHash
    || authority.promotion.nativePromotionReceiptHash
      !== expected.nativePromotionReceiptHash
    || authority.promotion.configurationHash !== expected.configurationHash
    || authority.promotion.runtimeHash !== expected.runtimeHash
    || authority.promotion.semanticBehaviorHash !== expected.semanticBehaviorHash
    || authority.promotion.sitesProjectId !== expected.sites.projectId
    || authority.promotion.sitesVersionId !== expected.sites.versionId
    || authority.promotion.sitesDeploymentId !== expected.sites.deploymentId
    || authority.promotion.sitesRevision !== expected.sites.revision
    || !exact(
      authority.promotion.runtimeTransition,
      expected.runtimeTransition,
    )
    || authority.proofs.ownerApple.gateEvidenceHash
      !== expected.ownerAppleGateEvidenceHash
    || authority.proofs.cleanNonOwner.gateEvidenceHash
      !== expected.cleanNonOwnerGateEvidenceHash
    || authority.proofs.databaseRouteAuthority.receiptHash
      !== expected.databaseRouteReceiptHash
    || !exact(authority.currentConfiguration, expected.currentConfiguration)
    || !exact(authority.targetConfiguration, expected.targetConfiguration)
  ) throw new Error("direct-exposure authority does not bind the expected proof");
  const rollbackPlan = validateRollbackPlan(warrant.rollback);
  const ownerProofHash = signedArtifactSha256(authority.proofs.ownerApple);
  const cleanProofHash = signedArtifactSha256(authority.proofs.cleanNonOwner);
  if (
    !exact(warrant.candidate, authority.candidate)
    || warrant.advance.authorityPayloadHash !== authorityEnvelope.payloadHash
    || warrant.advance.targetConfigurationHash
      !== authority.targetConfigurationHash
    || warrant.advance.ownerAppleProofHash !== ownerProofHash
    || warrant.advance.cleanNonOwnerProofHash !== cleanProofHash
    || warrant.advance.routeReceiptHash
      !== authority.proofs.databaseRouteAuthority.receiptHash
    || warrant.advance.rollbackPlanHash !== authority.rollbackPlanHash
    || warrant.advance.preExposureRuntimeTupleHash
      !== authority.promotion.runtimeTransition.preExposureRuntimeTupleHash
    || warrant.advance.postExposureRuntimeTupleHash
      !== authority.promotion.runtimeTransition.postExposureRuntimeTupleHash
    || warrant.advance.rollbackRuntimeTupleHash
      !== authority.promotion.runtimeTransition.rollbackRuntimeTupleHash
    || signedArtifactSha256(rollbackPlan) !== authority.rollbackPlanHash
    || rollbackPlan.candidateHash !== signedArtifactSha256(authority.candidate)
    || !exact(rollbackPlan.targetConfiguration, authority.currentConfiguration)
    || warrant.promotion.signedNativePromotionAuthorityHash
      !== authority.promotion.signedNativePromotionAuthorityHash
    || warrant.promotion.nativePromotionReceiptHash
      !== authority.promotion.nativePromotionReceiptHash
    || warrant.promotion.runtimeHash !== authority.promotion.runtimeHash
    || warrant.promotion.sitesRevision !== authority.promotion.sitesRevision
  ) throw new Error("direct-exposure rollback warrant does not bind the authority");
  return Object.freeze({
    authorityPayloadHash: authorityEnvelope.payloadHash,
    rollbackWarrantPayloadHash: warrantEnvelope.payloadHash,
    candidate: Object.freeze({ ...authority.candidate }),
    currentConfiguration: authority.currentConfiguration,
    currentConfigurationHash: authority.currentConfigurationHash,
    targetConfiguration: authority.targetConfiguration,
    targetConfigurationHash: authority.targetConfigurationHash,
    rollbackPlan,
    rollbackPlanHash: authority.rollbackPlanHash,
    runtimeTransition: authority.promotion.runtimeTransition,
    preconditionsHash: authority.preconditionsHash,
    ownerAppleProofHash: ownerProofHash,
    cleanNonOwnerProofHash: cleanProofHash,
    routeReceiptHash: authority.proofs.databaseRouteAuthority.receiptHash,
    exposureClass: "fully_exposed_unproven",
    organicReliabilityProven: false,
  });
}
