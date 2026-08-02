import {
  createHash,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { RELEASE_EVIDENCE_TTL_MS } from "./release-evidence-constants.ts";
import {
  createStrictSignedEnvelope,
  exactObject,
  type JsonRecord,
  sha256Digest,
  verifyStrictSignedEnvelope,
} from "./signed-artifact.ts";

export const NATIVE_SCHEMA20_ROLLOUT_PROMOTION_AUTHORITY_SCHEMA_VERSION =
  "genio-native-schema20-rollout-promotion-authority/v1";
export const SIGNED_NATIVE_SCHEMA20_ROLLOUT_PROMOTION_AUTHORITY_SCHEMA_VERSION =
  "genio-signed-native-schema20-rollout-promotion-authority/v1";

export interface NativeSchema20RolloutPromotionAuthorityPayloadV1 {
  schemaVersion:
    typeof NATIVE_SCHEMA20_ROLLOUT_PROMOTION_AUTHORITY_SCHEMA_VERSION;
  generatedAt: string;
  expiresAt: string;
  environment: "production";
  candidate: {
    tag: string;
    version: string;
    sourceRevision: string;
    imageReference: string;
    imageDigest: string;
  };
  nativePromotion: {
    receiptHash: string;
    completedAt: string;
  };
  promotion: {
    configurationHash: string;
    runtimeHash: string;
    semanticBehaviorHash: string;
    backendConvergenceEvidenceHash: string;
    backendConvergenceCompletedAt: string;
  };
  sites: {
    projectId: string;
    versionId: string;
    deploymentId: string;
    version: string;
    sourceRevision: string;
    candidateMatched: false;
    controlPlaneEvidenceHash: string;
  };
}

export interface NativeSchema20RolloutPromotionAuthorityExpectedV1 {
  keyId: string;
  keySha256: string;
  candidate: {
    tag: string;
    version: string;
    sourceRevision: string;
    imageReference: string;
    imageDigest: string;
  };
  nativePromotion: {
    receiptHash: string;
    completedAt: string;
  };
  promotion: {
    configurationHash: string;
    runtimeHash: string;
    semanticBehaviorHash: string;
    backendConvergenceEvidenceHash: string;
    backendConvergenceCompletedAt: string;
  };
  sites: {
    projectId: string;
    versionId: string;
    deploymentId: string;
    version: string;
    sourceRevision: string;
    controlPlaneEvidenceHash: string;
  };
  now?: string;
}

export interface NormalizedPublicRolloutPromotionContextV1 {
  authorityKind: "native_schema20_rollout_promotion";
  payloadHash: string;
  generatedAt: string;
  expiresAt: string;
  candidate: {
    tag: string;
    version: string;
    sourceRevision: string;
    imageReference: string;
    imageDigest: string;
  };
  nativePromotionReceiptHash: string;
  nativePromotionCompletedAt: string;
  configurationHash: string;
  runtimeHash: string;
  semanticBehaviorHash: string;
  backendConvergenceEvidenceHash: string;
  backendConvergenceCompletedAt: string;
  sitesVersion: string;
  sitesRevision: string;
  sitesCandidateMatched: false;
  sites: {
    projectId: string;
    versionId: string;
    deploymentId: string;
    controlPlaneEvidenceHash: string;
  };
}

const FULL_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const RC_TAG =
  /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-rc\.[1-9]\d*$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_REFERENCE =
  /^ghcr\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/u;
const SAFE_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{0,255}$/u;
const SAFE_KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{0,159}$/u;

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function revision(value: unknown, label: string): string {
  if (typeof value !== "string" || !FULL_REVISION.test(value)) {
    throw new Error(`${label} must be a full Git revision`);
  }
  return value;
}

function version(value: unknown, label: string): string {
  if (typeof value !== "string" || !VERSION.test(value)) {
    throw new Error(`${label} must be a semantic version`);
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

function validateCandidate(value: unknown): JsonRecord {
  const candidate = exactObject(value, [
    "tag",
    "version",
    "sourceRevision",
    "imageReference",
    "imageDigest",
  ], "native rollout promotion candidate");
  const tag = typeof candidate.tag === "string" ? candidate.tag : "";
  const tagMatch = RC_TAG.exec(tag);
  const candidateVersion = version(
    candidate.version,
    "native rollout promotion candidate.version",
  );
  if (!tagMatch || tagMatch[1] !== candidateVersion) {
    throw new Error(
      "native rollout promotion candidate tag and version do not match",
    );
  }
  revision(
    candidate.sourceRevision,
    "native rollout promotion candidate.sourceRevision",
  );
  const imageDigest = typeof candidate.imageDigest === "string"
    && IMAGE_DIGEST.test(candidate.imageDigest)
    ? candidate.imageDigest
    : "";
  const imageReference = typeof candidate.imageReference === "string"
    && IMAGE_REFERENCE.test(candidate.imageReference)
    ? candidate.imageReference
    : "";
  if (!imageDigest || !imageReference || !imageReference.endsWith(`@${imageDigest}`)) {
    throw new Error(
      "native rollout promotion candidate image reference and digest do not match",
    );
  }
  return candidate;
}

function validateNativePromotion(value: unknown): JsonRecord {
  const promotion = exactObject(value, [
    "receiptHash",
    "completedAt",
  ], "native rollout promotion receipt");
  sha256Digest(
    promotion.receiptHash,
    "native rollout promotion receipt.receiptHash",
  );
  timestamp(
    promotion.completedAt,
    "native rollout promotion receipt.completedAt",
  );
  return promotion;
}

function validatePromotion(value: unknown): JsonRecord {
  const promotion = exactObject(value, [
    "configurationHash",
    "runtimeHash",
    "semanticBehaviorHash",
    "backendConvergenceEvidenceHash",
    "backendConvergenceCompletedAt",
  ], "native rollout promotion standard context");
  for (const field of [
    "configurationHash",
    "runtimeHash",
    "semanticBehaviorHash",
    "backendConvergenceEvidenceHash",
  ] as const) {
    sha256Digest(
      promotion[field],
      `native rollout promotion standard context.${field}`,
    );
  }
  timestamp(
    promotion.backendConvergenceCompletedAt,
    "native rollout promotion backend convergence completion",
  );
  return promotion;
}

function validateSites(
  value: unknown,
  candidate: JsonRecord,
): JsonRecord {
  const sites = exactObject(value, [
    "projectId",
    "versionId",
    "deploymentId",
    "version",
    "sourceRevision",
    "candidateMatched",
    "controlPlaneEvidenceHash",
  ], "native rollout promotion Sites identity");
  safeId(sites.projectId, "native rollout promotion Sites projectId");
  safeId(sites.versionId, "native rollout promotion Sites versionId");
  safeId(sites.deploymentId, "native rollout promotion Sites deploymentId");
  version(sites.version, "native rollout promotion Sites version");
  revision(
    sites.sourceRevision,
    "native rollout promotion Sites sourceRevision",
  );
  sha256Digest(
    sites.controlPlaneEvidenceHash,
    "native rollout promotion Sites controlPlaneEvidenceHash",
  );
  if (
    sites.candidateMatched !== false
    || (
      sites.version === candidate.version
      && sites.sourceRevision === candidate.sourceRevision
    )
  ) {
    throw new Error(
      "native rollout promotion must preserve the exact prior Sites identity",
    );
  }
  return sites;
}

export function validateNativeSchema20RolloutPromotionAuthorityPayloadV1(
  value: unknown,
): NativeSchema20RolloutPromotionAuthorityPayloadV1 {
  const payload = exactObject(value, [
    "schemaVersion",
    "generatedAt",
    "expiresAt",
    "environment",
    "candidate",
    "nativePromotion",
    "promotion",
    "sites",
  ], "native schema-20 rollout promotion authority");
  if (
    payload.schemaVersion
      !== NATIVE_SCHEMA20_ROLLOUT_PROMOTION_AUTHORITY_SCHEMA_VERSION
    || payload.environment !== "production"
  ) {
    throw new Error(
      "native schema-20 rollout promotion authority is not production v1",
    );
  }
  const generatedAt = timestamp(
    payload.generatedAt,
    "native rollout promotion generatedAt",
  );
  const expiresAt = timestamp(
    payload.expiresAt,
    "native rollout promotion expiresAt",
  );
  const validity = Date.parse(expiresAt) - Date.parse(generatedAt);
  if (validity <= 0 || validity > RELEASE_EVIDENCE_TTL_MS) {
    throw new Error(
      "native rollout promotion authority must expire within 24 hours",
    );
  }
  const candidate = validateCandidate(payload.candidate);
  const nativePromotion = validateNativePromotion(payload.nativePromotion);
  const promotion = validatePromotion(payload.promotion);
  validateSites(payload.sites, candidate);
  if (
    Date.parse(String(promotion.backendConvergenceCompletedAt))
      < Date.parse(String(nativePromotion.completedAt))
    || Date.parse(generatedAt)
      < Date.parse(String(promotion.backendConvergenceCompletedAt))
  ) {
    throw new Error(
      "native rollout promotion authority chronology is invalid",
    );
  }
  return payload as unknown as NativeSchema20RolloutPromotionAuthorityPayloadV1;
}

function sameRecord(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  return Object.keys(expected).every((key) => actual[key] === expected[key]);
}

export function createSignedNativeSchema20RolloutPromotionAuthorityV1(input: {
  payload: NativeSchema20RolloutPromotionAuthorityPayloadV1;
  signingKey: string | Buffer | KeyObject;
  keyId: string;
}) {
  if (!SAFE_KEY_ID.test(input.keyId)) {
    throw new Error("native rollout promotion release key ID is invalid");
  }
  const payload = validateNativeSchema20RolloutPromotionAuthorityPayloadV1(
    input.payload,
  );
  return createStrictSignedEnvelope({
    envelopeSchemaVersion:
      SIGNED_NATIVE_SCHEMA20_ROLLOUT_PROMOTION_AUTHORITY_SCHEMA_VERSION,
    payload: payload as unknown as JsonRecord,
    signingKey: input.signingKey,
    keyId: input.keyId,
  });
}

export function verifyNativeSchema20RolloutPromotionAuthorityV1(
  value: unknown,
  verificationKey: string | Buffer | KeyObject,
  expected: NativeSchema20RolloutPromotionAuthorityExpectedV1,
): NormalizedPublicRolloutPromotionContextV1 {
  if (!SAFE_KEY_ID.test(expected.keyId)) {
    throw new Error("expected native rollout promotion release key ID is invalid");
  }
  sha256Digest(
    expected.keySha256,
    "expected native rollout promotion release key digest",
  );
  const publicKey = typeof verificationKey === "string"
    || Buffer.isBuffer(verificationKey)
    ? createPublicKey(verificationKey)
    : verificationKey.type === "public"
      ? verificationKey
      : createPublicKey(verificationKey);
  const observedKeySha256 = createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
  if (
    publicKey.asymmetricKeyType !== "ed25519"
    || observedKeySha256 !== expected.keySha256
  ) {
    throw new Error(
      "native rollout promotion authority did not use the protected release key",
    );
  }
  const verified = verifyStrictSignedEnvelope({
    value,
    verificationKey,
    envelopeSchemaVersion:
      SIGNED_NATIVE_SCHEMA20_ROLLOUT_PROMOTION_AUTHORITY_SCHEMA_VERSION,
    payloadLabel: "native schema-20 rollout promotion authority",
    validatePayload: (payloadValue) => (
      validateNativeSchema20RolloutPromotionAuthorityPayloadV1(
        payloadValue,
      ) as unknown as JsonRecord
    ),
  });
  if (verified.keyId !== expected.keyId) {
    throw new Error(
      "native rollout promotion authority did not use the protected release key ID",
    );
  }
  const payload =
    verified.payload as unknown as NativeSchema20RolloutPromotionAuthorityPayloadV1;
  const now = expected.now
    ? Date.parse(timestamp(expected.now, "native rollout promotion verification time"))
    : Date.now();
  if (Date.parse(payload.generatedAt) > now + 5 * 60_000) {
    throw new Error("native rollout promotion authority was generated in the future");
  }
  if (now >= Date.parse(payload.expiresAt)) {
    throw new Error("native rollout promotion authority has expired");
  }
  if (
    !sameRecord(payload.candidate, expected.candidate)
    || !sameRecord(payload.nativePromotion, expected.nativePromotion)
    || !sameRecord(payload.promotion, expected.promotion)
    || !sameRecord(payload.sites, {
      ...expected.sites,
      candidateMatched: false,
    })
  ) {
    throw new Error(
      "native rollout promotion authority does not bind the expected release context",
    );
  }
  return Object.freeze({
    authorityKind: "native_schema20_rollout_promotion" as const,
    payloadHash: verified.payloadHash,
    generatedAt: payload.generatedAt,
    expiresAt: payload.expiresAt,
    candidate: Object.freeze({ ...payload.candidate }),
    nativePromotionReceiptHash: payload.nativePromotion.receiptHash,
    nativePromotionCompletedAt: payload.nativePromotion.completedAt,
    configurationHash: payload.promotion.configurationHash,
    runtimeHash: payload.promotion.runtimeHash,
    semanticBehaviorHash: payload.promotion.semanticBehaviorHash,
    backendConvergenceEvidenceHash:
      payload.promotion.backendConvergenceEvidenceHash,
    backendConvergenceCompletedAt:
      payload.promotion.backendConvergenceCompletedAt,
    sitesVersion: payload.sites.version,
    sitesRevision: payload.sites.sourceRevision,
    sitesCandidateMatched: false as const,
    sites: Object.freeze({
      projectId: payload.sites.projectId,
      versionId: payload.sites.versionId,
      deploymentId: payload.sites.deploymentId,
      controlPlaneEvidenceHash: payload.sites.controlPlaneEvidenceHash,
    }),
  });
}
