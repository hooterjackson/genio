import {
  createHash,
  createPublicKey,
  KeyObject,
} from "node:crypto";
import {
  MAXIMUM_STAGING_MONTHLY_COST_USD,
  RELEASE_EVIDENCE_TTL_MS,
} from "./release-evidence-constants.ts";
import {
  exactObject,
  type JsonRecord,
  sha256Digest,
  signedArtifactSha256,
  verifyStrictSignedEnvelope,
} from "./signed-artifact.ts";

export const STAGING_CONTROL_PLANE_EVIDENCE_SCHEMA_V1 =
  "genio-staging-control-plane-evidence/v1";
export const SIGNED_STAGING_CONTROL_PLANE_EVIDENCE_SCHEMA_V1 =
  "genio-signed-staging-control-plane-evidence/v1";
export const STAGING_CONTROL_PLANE_TRUST_POLICY_SCHEMA_V1 =
  "genio-staging-control-plane-trust-policy/v1";
export const STAGING_CONTROL_PLANE_ISSUER_V1 =
  "genio-protected-release-control-plane";

const SAFE_KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u;
const SOURCE_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_REFERENCE =
  /^ghcr\.io\/[0-9a-z](?:[0-9a-z._/-]*[0-9a-z])?@sha256:[0-9a-f]{64}$/u;

export interface StagingControlPlaneTrustPolicyV1 {
  schemaVersion: typeof STAGING_CONTROL_PLANE_TRUST_POLICY_SCHEMA_V1;
  approvedKeyId: string;
  approvedKeySha256: string;
}

export interface VerifiedStagingControlPlaneEvidenceV1 {
  payload: JsonRecord;
  payloadHash: string;
  keyId: string;
  verificationKeyFingerprint: string;
  derivedControls: {
    controlPlanePhase: "candidate" | "promotion" | "finalization";
    candidateEvidencePayloadHash: string | null;
    candidateSourceRevision: string;
    candidateImageDigest: string;
    candidateImageReference: string;
    monthlyCostLimitUsd: number;
    budgetRemainingUsd: number;
    reservedForRequiredGatesUsd: number;
    budgetStatus: "available";
    musicKitOrigin: string;
    providerSecretVersionHash: string;
    productionProviderSecretVersionHash: string;
    appleSecretVersionHash: string;
    productionAppleSecretVersionHash: string;
    appleQaVerifierSecretVersionHash: string;
    productionAppleQaVerifierSecretVersionHash: string;
    appleQaVerifierCredentialIdentityHash: string;
    productionAppleQaVerifierCredentialIdentityHash: string;
    providerProjectIdentityHash: string;
    productionProviderProjectIdentityHash: string;
    stagingRuntimeSnapshotHash: string;
    productionRuntimeSnapshotHash: string | null;
    stagingConfigurationHash: string;
    productionConfigurationHash: string | null;
    stagingSecretVersionsHash: string;
    productionSecretVersionsHash: string;
    stagingRailwayServiceInventoryHash: string;
    productionRailwayServiceInventoryHash: string;
    appleReceiptPayloadHash: string;
    providerReceiptPayloadHash: string;
    qaBudgetReceiptPayloadHash: string;
    appleAccountSeparationEvidenceHash: string;
    musicKitOriginRegistrationEvidenceHash: string;
    controlPlaneEvidenceHash: string;
    controlPlaneKeyId: string;
    controlPlaneKeyFingerprint: string;
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

function positiveMoney(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive amount`);
  }
  return value;
}

function environmentBinding(
  value: unknown,
  name: "staging" | "production",
  phase: "candidate" | "promotion" | "finalization",
): JsonRecord {
  const binding = exactObject(value, [
    "railwayProjectIdHash",
    "railwayEnvironmentIdHash",
    "railwayServiceInventoryHash",
    "runtimeSnapshotHash",
    "configurationHash",
    "secretVersionsHash",
    "providerCredentialVersionHash",
    "appleCredentialVersionHash",
    "appleQaVerifierCredentialVersionHash",
    "appleQaVerifierCredentialIdentityHash",
    "providerProjectIdentityHash",
    "appleAccountIdHash",
    ...(name === "staging"
      ? ["musicKitOrigin", "musicKitOriginRegistrationEvidenceHash"]
      : []),
  ], `${name} control-plane binding`);
  const commonDigestFields = [
    "railwayProjectIdHash",
    "railwayEnvironmentIdHash",
    "railwayServiceInventoryHash",
    "providerCredentialVersionHash",
    "appleCredentialVersionHash",
    "appleQaVerifierCredentialVersionHash",
    "appleQaVerifierCredentialIdentityHash",
    "providerProjectIdentityHash",
    "appleAccountIdHash",
  ];
  for (const field of commonDigestFields) {
    sha256Digest(binding[field], `${name} control-plane binding ${field}`);
  }
  sha256Digest(
    binding.secretVersionsHash,
    `${name} control-plane binding secretVersionsHash`,
  );
  if (name === "staging" || phase !== "candidate") {
    for (const field of [
      "runtimeSnapshotHash",
      "configurationHash",
    ]) {
      sha256Digest(binding[field], `${name} control-plane binding ${field}`);
    }
  } else if (
    binding.runtimeSnapshotHash !== null
    || binding.configurationHash !== null
  ) {
    throw new Error(
      "candidate control-plane evidence cannot claim a candidate production runtime",
    );
  }
  if (name === "staging") {
    sha256Digest(
      binding.musicKitOriginRegistrationEvidenceHash,
      "staging MusicKit origin registration evidence hash",
    );
    if (typeof binding.musicKitOrigin !== "string") {
      throw new Error("staging MusicKit origin is invalid");
    }
    let origin: URL;
    try {
      origin = new URL(binding.musicKitOrigin);
    } catch {
      throw new Error("staging MusicKit origin is invalid");
    }
    if (
      origin.protocol !== "https:"
      || origin.origin !== binding.musicKitOrigin
      || origin.pathname !== "/"
      || origin.username
      || origin.password
      || origin.hostname === "9enio.com"
      || origin.hostname === "www.9enio.com"
    ) {
      throw new Error("staging MusicKit origin must be a dedicated non-production origin");
    }
  }
  return binding;
}

function validatePayload(value: unknown): JsonRecord {
  const result = exactObject(value, [
    "schemaVersion",
    "phase",
    "candidate",
    "candidateEvidencePayloadHash",
    "generatedAt",
    "expiresAt",
    "issuer",
    "staging",
    "production",
    "budget",
    "receipts",
  ], "staging control-plane evidence");
  if (
    result.schemaVersion !== STAGING_CONTROL_PLANE_EVIDENCE_SCHEMA_V1
    || result.issuer !== STAGING_CONTROL_PLANE_ISSUER_V1
  ) {
    throw new Error("staging control-plane evidence has unsupported provenance");
  }
  if (
    result.phase !== "candidate"
    && result.phase !== "promotion"
    && result.phase !== "finalization"
  ) {
    throw new Error("staging control-plane evidence phase is invalid");
  }
  const phase = result.phase;
  const candidate = exactObject(result.candidate, [
    "version",
    "sourceRevision",
    "imageDigest",
    "imageReference",
  ], "staging control-plane evidence candidate");
  if (
    typeof candidate.version !== "string"
    || !VERSION.test(candidate.version)
    || typeof candidate.sourceRevision !== "string"
    || !SOURCE_REVISION.test(candidate.sourceRevision)
    || typeof candidate.imageDigest !== "string"
    || !IMAGE_DIGEST.test(candidate.imageDigest)
    || typeof candidate.imageReference !== "string"
    || !IMAGE_REFERENCE.test(candidate.imageReference)
    || !candidate.imageReference.endsWith(`@${candidate.imageDigest}`)
  ) {
    throw new Error("staging control-plane evidence candidate is invalid");
  }
  if (
    (phase === "candidate" && result.candidateEvidencePayloadHash !== null)
    || (
      phase !== "candidate"
      && (
        sha256Digest(
          result.candidateEvidencePayloadHash,
          "candidate release-evidence payload hash",
        ) !== result.candidateEvidencePayloadHash
      )
    )
  ) {
    throw new Error(
      "candidate release-evidence payload hash does not match the control-plane phase",
    );
  }
  const generatedAt = timestamp(
    result.generatedAt,
    "staging control-plane evidence generatedAt",
  );
  const expiresAt = timestamp(
    result.expiresAt,
    "staging control-plane evidence expiresAt",
  );
  const ttl = Date.parse(expiresAt) - Date.parse(generatedAt);
  if (ttl <= 0 || ttl > RELEASE_EVIDENCE_TTL_MS) {
    throw new Error("staging control-plane evidence must expire within 24 hours");
  }
  const staging = environmentBinding(result.staging, "staging", phase);
  const production = environmentBinding(result.production, "production", phase);
  for (const field of [
    "railwayProjectIdHash",
    "railwayEnvironmentIdHash",
    "railwayServiceInventoryHash",
    "secretVersionsHash",
    "providerCredentialVersionHash",
    "appleCredentialVersionHash",
    "appleQaVerifierCredentialVersionHash",
    "appleQaVerifierCredentialIdentityHash",
    "providerProjectIdentityHash",
    "appleAccountIdHash",
  ]) {
    if (staging[field] === production[field]) {
      throw new Error(`staging and production ${field} must be different`);
    }
  }
  if (phase !== "candidate") {
    for (const field of [
      "runtimeSnapshotHash",
      "configurationHash",
    ]) {
      if (staging[field] === production[field]) {
        throw new Error(`staging and production ${field} must be different`);
      }
    }
  }
  const receipts = exactObject(result.receipts, [
    "apple",
    "provider",
    "qaBudget",
  ], "staging control-plane receipt bindings");
  const receiptKeyFingerprints: string[] = [];
  for (const [name, value] of Object.entries(receipts)) {
    const receipt = exactObject(value, [
      "payloadHash",
      "issuer",
      "keyId",
      "keySha256",
    ], `${name} control-plane receipt binding`);
    sha256Digest(receipt.payloadHash, `${name} receipt payload hash`);
    sha256Digest(receipt.keySha256, `${name} receipt key fingerprint`);
    receiptKeyFingerprints.push(String(receipt.keySha256));
    if (
      typeof receipt.issuer !== "string"
      || !SAFE_KEY_ID.test(receipt.issuer)
      || typeof receipt.keyId !== "string"
      || !SAFE_KEY_ID.test(receipt.keyId)
    ) {
      throw new Error(`${name} receipt provenance is invalid`);
    }
  }
  if (new Set(receiptKeyFingerprints).size !== receiptKeyFingerprints.length) {
    throw new Error("Apple, provider, and QA budget receipts must use independent keys");
  }
  const budget = exactObject(result.budget, [
    "currency",
    "monthlyCostLimitUsd",
    "budgetRemainingUsd",
    "reservedForRequiredGatesUsd",
    "status",
  ], "staging control-plane budget");
  const monthlyCostLimitUsd = positiveMoney(
    budget.monthlyCostLimitUsd,
    "staging monthly cost limit",
  );
  const budgetRemainingUsd = positiveMoney(
    budget.budgetRemainingUsd,
    "staging budget remaining",
  );
  const reservedForRequiredGatesUsd = positiveMoney(
    budget.reservedForRequiredGatesUsd,
    "staging reserved gate budget",
  );
  if (
    budget.currency !== "USD"
    || budget.status !== "available"
    || monthlyCostLimitUsd > MAXIMUM_STAGING_MONTHLY_COST_USD
    || budgetRemainingUsd > monthlyCostLimitUsd
    || reservedForRequiredGatesUsd > budgetRemainingUsd
  ) {
    throw new Error("staging control-plane budget cannot cover the required gates");
  }
  return result;
}

function publicKey(value: string | Buffer | KeyObject): KeyObject {
  const parsed = value instanceof KeyObject ? value : createPublicKey(value);
  const key = parsed.type === "private" ? createPublicKey(parsed) : parsed;
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("staging control-plane verification key must be Ed25519");
  }
  return key;
}

export function stagingControlPlaneKeyFingerprint(
  value: string | Buffer | KeyObject,
): string {
  return createHash("sha256").update(
    publicKey(value).export({ format: "der", type: "spki" }),
  ).digest("hex");
}

export function stagingControlPlaneTrustPolicyV1(input: {
  approvedKeyId: string;
  approvedKeySha256: string;
}): StagingControlPlaneTrustPolicyV1 {
  if (!SAFE_KEY_ID.test(input.approvedKeyId)) {
    throw new Error("approved staging control-plane key ID is invalid");
  }
  sha256Digest(
    input.approvedKeySha256,
    "approved staging control-plane key fingerprint",
  );
  return {
    schemaVersion: STAGING_CONTROL_PLANE_TRUST_POLICY_SCHEMA_V1,
    approvedKeyId: input.approvedKeyId,
    approvedKeySha256: input.approvedKeySha256,
  };
}

export function validateStagingControlPlaneTrustPolicyV1(
  value: unknown,
): StagingControlPlaneTrustPolicyV1 {
  const policy = exactObject(value, [
    "schemaVersion",
    "approvedKeyId",
    "approvedKeySha256",
  ], "staging control-plane trust policy");
  if (policy.schemaVersion !== STAGING_CONTROL_PLANE_TRUST_POLICY_SCHEMA_V1) {
    throw new Error("staging control-plane trust policy uses an unsupported schema");
  }
  return stagingControlPlaneTrustPolicyV1({
    approvedKeyId: String(policy.approvedKeyId),
    approvedKeySha256: String(policy.approvedKeySha256),
  });
}

export function verifyStagingControlPlaneEvidence(input: {
  value: unknown;
  verificationKey: string | Buffer | KeyObject;
  trustPolicy: unknown;
  now?: string;
}): VerifiedStagingControlPlaneEvidenceV1 {
  const trust = validateStagingControlPlaneTrustPolicyV1(input.trustPolicy);
  const key = publicKey(input.verificationKey);
  const fingerprint = stagingControlPlaneKeyFingerprint(key);
  if (fingerprint !== trust.approvedKeySha256) {
    throw new Error(
      "staging control-plane evidence does not use the protected approved key",
    );
  }
  const verified = verifyStrictSignedEnvelope({
    value: input.value,
    verificationKey: key,
    envelopeSchemaVersion: SIGNED_STAGING_CONTROL_PLANE_EVIDENCE_SCHEMA_V1,
    payloadLabel: "staging control-plane evidence",
    validatePayload,
  });
  if (verified.keyId !== trust.approvedKeyId) {
    throw new Error(
      "staging control-plane evidence key ID is not the protected approved key",
    );
  }
  const verifiedReceiptBindings = verified.payload.receipts as JsonRecord;
  if (Object.values(verifiedReceiptBindings).some((value) => (
    (value as JsonRecord).keySha256 === fingerprint
  ))) {
    throw new Error(
      "staging control-plane aggregate and detached receipts must use independent keys",
    );
  }
  const now = input.now
    ? Date.parse(timestamp(input.now, "staging control-plane verification time"))
    : Date.now();
  const generatedAt = Date.parse(String(verified.payload.generatedAt));
  const expiresAt = Date.parse(String(verified.payload.expiresAt));
  if (generatedAt > now + 5 * 60_000 || now >= expiresAt) {
    throw new Error("staging control-plane evidence is not currently valid");
  }
  const staging = verified.payload.staging as JsonRecord;
  const production = verified.payload.production as JsonRecord;
  const budget = verified.payload.budget as JsonRecord;
  return {
    ...verified,
    verificationKeyFingerprint: fingerprint,
    derivedControls: {
      controlPlanePhase: verified.payload.phase as
        | "candidate"
        | "promotion"
        | "finalization",
      candidateEvidencePayloadHash:
        verified.payload.candidateEvidencePayloadHash === null
          ? null
          : String(verified.payload.candidateEvidencePayloadHash),
      candidateSourceRevision:
        String((verified.payload.candidate as JsonRecord).sourceRevision),
      candidateImageDigest:
        String((verified.payload.candidate as JsonRecord).imageDigest),
      candidateImageReference:
        String((verified.payload.candidate as JsonRecord).imageReference),
      monthlyCostLimitUsd: Number(budget.monthlyCostLimitUsd),
      budgetRemainingUsd: Number(budget.budgetRemainingUsd),
      reservedForRequiredGatesUsd: Number(budget.reservedForRequiredGatesUsd),
      budgetStatus: "available",
      musicKitOrigin: String(staging.musicKitOrigin),
      providerSecretVersionHash:
        String(staging.providerCredentialVersionHash),
      productionProviderSecretVersionHash:
        String(production.providerCredentialVersionHash),
      appleSecretVersionHash: String(staging.appleCredentialVersionHash),
      productionAppleSecretVersionHash:
        String(production.appleCredentialVersionHash),
      appleQaVerifierSecretVersionHash:
        String(staging.appleQaVerifierCredentialVersionHash),
      productionAppleQaVerifierSecretVersionHash:
        String(production.appleQaVerifierCredentialVersionHash),
      appleQaVerifierCredentialIdentityHash:
        String(staging.appleQaVerifierCredentialIdentityHash),
      productionAppleQaVerifierCredentialIdentityHash:
        String(production.appleQaVerifierCredentialIdentityHash),
      providerProjectIdentityHash:
        String(staging.providerProjectIdentityHash),
      productionProviderProjectIdentityHash:
        String(production.providerProjectIdentityHash),
      stagingRuntimeSnapshotHash: String(staging.runtimeSnapshotHash),
      productionRuntimeSnapshotHash:
        production.runtimeSnapshotHash === null
          ? null
          : String(production.runtimeSnapshotHash),
      stagingConfigurationHash: String(staging.configurationHash),
      productionConfigurationHash:
        production.configurationHash === null
          ? null
          : String(production.configurationHash),
      stagingSecretVersionsHash: String(staging.secretVersionsHash),
      productionSecretVersionsHash: String(production.secretVersionsHash),
      stagingRailwayServiceInventoryHash:
        String(staging.railwayServiceInventoryHash),
      productionRailwayServiceInventoryHash:
        String(production.railwayServiceInventoryHash),
      appleReceiptPayloadHash:
        String((verifiedReceiptBindings.apple as JsonRecord).payloadHash),
      providerReceiptPayloadHash:
        String((verifiedReceiptBindings.provider as JsonRecord).payloadHash),
      qaBudgetReceiptPayloadHash:
        String((verifiedReceiptBindings.qaBudget as JsonRecord).payloadHash),
      appleAccountSeparationEvidenceHash: signedArtifactSha256({
        stagingAppleAccountIdHash: staging.appleAccountIdHash,
        productionAppleAccountIdHash: production.appleAccountIdHash,
      }),
      musicKitOriginRegistrationEvidenceHash:
        String(staging.musicKitOriginRegistrationEvidenceHash),
      controlPlaneEvidenceHash: verified.payloadHash,
      controlPlaneKeyId: verified.keyId,
      controlPlaneKeyFingerprint: fingerprint,
    },
  };
}
