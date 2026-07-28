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
  sha256Digest,
  verifyStrictSignedEnvelope,
  type JsonRecord,
} from "./signed-artifact.ts";

export const APPLE_CONTROL_PLANE_RECEIPT_SCHEMA_V1 =
  "genio-apple-control-plane-receipt/v1";
export const SIGNED_APPLE_CONTROL_PLANE_RECEIPT_SCHEMA_V1 =
  "genio-signed-apple-control-plane-receipt/v1";
export const QA_BUDGET_LEDGER_RECEIPT_SCHEMA_V1 =
  "genio-qa-budget-ledger-receipt/v1";
export const SIGNED_QA_BUDGET_LEDGER_RECEIPT_SCHEMA_V1 =
  "genio-signed-qa-budget-ledger-receipt/v1";
export const PROVIDER_CONTROL_PLANE_RECEIPT_SCHEMA_V1 =
  "genio-provider-control-plane-receipt/v1";
export const SIGNED_PROVIDER_CONTROL_PLANE_RECEIPT_SCHEMA_V1 =
  "genio-signed-provider-control-plane-receipt/v1";
export const CONTROL_PLANE_RECEIPT_TRUST_POLICY_SCHEMA_V1 =
  "genio-control-plane-receipt-trust-policy/v1";

export const QA_BUDGET_LEDGER_MAX_AGE_MS = 15 * 60_000;
export const QA_BUDGET_LEDGER_MAX_TTL_MS = 60 * 60_000;

const SAFE_LABEL = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u;
const SOURCE_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_REFERENCE =
  /^ghcr\.io\/[0-9a-z](?:[0-9a-z._/-]*[0-9a-z])?@sha256:[0-9a-f]{64}$/u;

export type ControlPlaneReceiptKind = "apple" | "provider" | "qa_budget";
export type ControlPlaneEvidencePhase =
  | "candidate"
  | "promotion"
  | "finalization";

export interface ControlPlaneReceiptTrustPolicyV1 {
  schemaVersion: typeof CONTROL_PLANE_RECEIPT_TRUST_POLICY_SCHEMA_V1;
  receiptKind: ControlPlaneReceiptKind;
  approvedIssuer: string;
  approvedKeyId: string;
  approvedKeySha256: string;
}

export interface ControlPlaneCandidateBindingV1 {
  version: string;
  sourceRevision: string;
  imageDigest: string;
  imageReference: string;
}

export interface AppleControlPlaneReceiptExpectedV1 {
  phase: ControlPlaneEvidencePhase;
  candidate: ControlPlaneCandidateBindingV1;
  staging: {
    runtimeSnapshotHash: string;
    appleCredentialVersionHash: string;
    appleQaVerifierCredentialVersionHash: string;
    musicKitOrigin: string;
  };
  production: {
    runtimeSnapshotHash: string | null;
    appleCredentialVersionHash?: string;
    appleQaVerifierCredentialVersionHash?: string;
  };
}

export interface ProviderControlPlaneReceiptExpectedV1 {
  phase: ControlPlaneEvidencePhase;
  candidate: ControlPlaneCandidateBindingV1;
  staging: {
    runtimeSnapshotHash: string;
    providerCredentialVersionHash: string;
  };
  production: {
    runtimeSnapshotHash: string | null;
    providerCredentialVersionHash?: string;
  };
}

export interface VerifiedProviderControlPlaneReceiptV1 {
  payload: JsonRecord;
  payloadHash: string;
  keyId: string;
  verificationKeyFingerprint: string;
  stagingProviderCredentialVersionHash: string;
  productionProviderCredentialVersionHash: string;
  stagingProviderProjectIdentityHash: string;
  productionProviderProjectIdentityHash: string;
}

export interface VerifiedAppleControlPlaneReceiptV1 {
  payload: JsonRecord;
  payloadHash: string;
  keyId: string;
  verificationKeyFingerprint: string;
  stagingAppleAccountIdHash: string;
  productionAppleAccountIdHash: string;
  stagingAppleQaVerifierCredentialIdentityHash: string;
  productionAppleQaVerifierCredentialIdentityHash: string;
  musicKitOriginRegistrationEvidenceHash: string;
}

export interface QaBudgetLedgerReceiptExpectedV1 {
  phase: ControlPlaneEvidencePhase;
  candidate: ControlPlaneCandidateBindingV1;
  stagingRuntimeSnapshotHash: string;
  productionRuntimeSnapshotHash: string | null;
}

export interface VerifiedQaBudgetLedgerReceiptV1 {
  payload: JsonRecord;
  payloadHash: string;
  keyId: string;
  verificationKeyFingerprint: string;
  monthlyCostLimitUsd: number;
  spentUsd: number;
  budgetRemainingUsd: number;
  reservedForRequiredGatesUsd: number;
  asOf: string;
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function safeLabel(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !SAFE_LABEL.test(value)
    || /(?:secret|token|password|sk-)/iu.test(value)
  ) {
    throw new Error(`${label} must be an approved control-plane label`);
  }
  return value;
}

function candidateBinding(
  value: unknown,
  label: string,
): ControlPlaneCandidateBindingV1 {
  const candidate = exactObject(
    value,
    ["version", "sourceRevision", "imageDigest", "imageReference"],
    label,
  );
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
    throw new Error(`${label} is invalid`);
  }
  return {
    version: candidate.version,
    sourceRevision: candidate.sourceRevision,
    imageDigest: candidate.imageDigest,
    imageReference: candidate.imageReference,
  };
}

function evidencePhase(value: unknown, label: string): ControlPlaneEvidencePhase {
  if (
    value !== "candidate"
    && value !== "promotion"
    && value !== "finalization"
  ) {
    throw new Error(`${label} must be candidate, promotion, or finalization`);
  }
  return value;
}

function dedicatedMusicKitOrigin(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Apple control-plane receipt MusicKit origin is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Apple control-plane receipt MusicKit origin is invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.origin !== value
    || parsed.pathname !== "/"
    || parsed.username
    || parsed.password
    || parsed.hostname === "9enio.com"
    || parsed.hostname === "www.9enio.com"
  ) {
    throw new Error(
      "Apple control-plane receipt requires a dedicated non-production MusicKit origin",
    );
  }
  return value;
}

function money(
  value: unknown,
  label: string,
  options: { positive?: boolean } = {},
): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || (options.positive === true && value <= 0)
    || Math.round(value * 1_000_000) !== value * 1_000_000
  ) {
    throw new Error(`${label} must be a non-negative USD amount`);
  }
  return value;
}

function publicKey(value: string | Buffer | KeyObject): KeyObject {
  const parsed = value instanceof KeyObject ? value : createPublicKey(value);
  const key = parsed.type === "private" ? createPublicKey(parsed) : parsed;
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("control-plane receipt verification key must be Ed25519");
  }
  return key;
}

export function controlPlaneReceiptKeyFingerprint(
  value: string | Buffer | KeyObject,
): string {
  return createHash("sha256")
    .update(publicKey(value).export({ format: "der", type: "spki" }))
    .digest("hex");
}

export function controlPlaneReceiptTrustPolicyV1(input: {
  receiptKind: ControlPlaneReceiptKind;
  approvedIssuer: string;
  approvedKeyId: string;
  approvedKeySha256: string;
}): ControlPlaneReceiptTrustPolicyV1 {
  if (
    input.receiptKind !== "apple"
    && input.receiptKind !== "provider"
    && input.receiptKind !== "qa_budget"
  ) {
    throw new Error("control-plane receipt kind is invalid");
  }
  const approvedIssuer = safeLabel(
    input.approvedIssuer,
    "approved control-plane receipt issuer",
  );
  const approvedKeyId = safeLabel(
    input.approvedKeyId,
    "approved control-plane receipt key ID",
  );
  const approvedKeySha256 = sha256Digest(
    input.approvedKeySha256,
    "approved control-plane receipt key fingerprint",
  );
  return {
    schemaVersion: CONTROL_PLANE_RECEIPT_TRUST_POLICY_SCHEMA_V1,
    receiptKind: input.receiptKind,
    approvedIssuer,
    approvedKeyId,
    approvedKeySha256,
  };
}

export function validateControlPlaneReceiptTrustPolicyV1(
  value: unknown,
  expectedKind?: ControlPlaneReceiptKind,
): ControlPlaneReceiptTrustPolicyV1 {
  const policy = exactObject(value, [
    "schemaVersion",
    "receiptKind",
    "approvedIssuer",
    "approvedKeyId",
    "approvedKeySha256",
  ], "control-plane receipt trust policy");
  if (policy.schemaVersion !== CONTROL_PLANE_RECEIPT_TRUST_POLICY_SCHEMA_V1) {
    throw new Error("control-plane receipt trust policy uses an unsupported schema");
  }
  const result = controlPlaneReceiptTrustPolicyV1({
    receiptKind: policy.receiptKind as ControlPlaneReceiptKind,
    approvedIssuer: String(policy.approvedIssuer),
    approvedKeyId: String(policy.approvedKeyId),
    approvedKeySha256: String(policy.approvedKeySha256),
  });
  if (expectedKind !== undefined && result.receiptKind !== expectedKind) {
    throw new Error("control-plane receipt trust policy is for the wrong receipt kind");
  }
  return result;
}

function validateReceiptWindow(input: {
  generatedAt: unknown;
  expiresAt: unknown;
  now: number;
  maximumTtlMs: number;
  maximumAgeMs: number;
  label: string;
}): { generatedAt: string; expiresAt: string } {
  const generatedAt = isoTimestamp(
    input.generatedAt,
    `${input.label} generatedAt`,
  );
  const expiresAt = isoTimestamp(input.expiresAt, `${input.label} expiresAt`);
  const generatedMs = Date.parse(generatedAt);
  const expiresMs = Date.parse(expiresAt);
  if (
    expiresMs <= generatedMs
    || expiresMs - generatedMs > input.maximumTtlMs
    || generatedMs > input.now + 5 * 60_000
    || input.now - generatedMs > input.maximumAgeMs
    || input.now >= expiresMs
  ) {
    throw new Error(`${input.label} is stale, future-dated, or expired`);
  }
  return { generatedAt, expiresAt };
}

function verifyReceiptEnvelope(input: {
  value: unknown;
  verificationKey: string | Buffer | KeyObject;
  trustPolicy: unknown;
  expectedKind: ControlPlaneReceiptKind;
  envelopeSchemaVersion: string;
  payloadLabel: string;
  validatePayload: (value: unknown) => JsonRecord;
}): {
  payload: JsonRecord;
  payloadHash: string;
  keyId: string;
  verificationKeyFingerprint: string;
  trust: ControlPlaneReceiptTrustPolicyV1;
} {
  const trust = validateControlPlaneReceiptTrustPolicyV1(
    input.trustPolicy,
    input.expectedKind,
  );
  const key = publicKey(input.verificationKey);
  const fingerprint = controlPlaneReceiptKeyFingerprint(key);
  if (fingerprint !== trust.approvedKeySha256) {
    throw new Error("control-plane receipt does not use its protected approved key");
  }
  const verified = verifyStrictSignedEnvelope({
    value: input.value,
    verificationKey: key,
    envelopeSchemaVersion: input.envelopeSchemaVersion,
    payloadLabel: input.payloadLabel,
    validatePayload: input.validatePayload,
  });
  if (verified.keyId !== trust.approvedKeyId) {
    throw new Error("control-plane receipt key ID is not protected and approved");
  }
  if (verified.payload.issuer !== trust.approvedIssuer) {
    throw new Error("control-plane receipt issuer is not protected and approved");
  }
  return {
    ...verified,
    verificationKeyFingerprint: fingerprint,
    trust,
  };
}

function validateApplePayload(
  value: unknown,
  now: number,
): JsonRecord {
  const payload = exactObject(value, [
    "schemaVersion",
    "phase",
    "issuer",
    "generatedAt",
    "expiresAt",
    "candidate",
    "staging",
    "production",
  ], "Apple control-plane receipt");
  if (payload.schemaVersion !== APPLE_CONTROL_PLANE_RECEIPT_SCHEMA_V1) {
    throw new Error("Apple control-plane receipt uses an unsupported schema");
  }
  const phase = evidencePhase(payload.phase, "Apple control-plane receipt phase");
  safeLabel(payload.issuer, "Apple control-plane receipt issuer");
  validateReceiptWindow({
    generatedAt: payload.generatedAt,
    expiresAt: payload.expiresAt,
    now,
    maximumTtlMs: RELEASE_EVIDENCE_TTL_MS,
    maximumAgeMs: RELEASE_EVIDENCE_TTL_MS,
    label: "Apple control-plane receipt",
  });
  candidateBinding(payload.candidate, "Apple control-plane receipt candidate");
  const staging = exactObject(payload.staging, [
    "runtimeSnapshotHash",
    "appleCredentialVersionHash",
    "appleQaVerifierCredentialVersionHash",
    "appleQaVerifierCredentialIdentityHash",
    "appleAccountIdHash",
    "musicKitOrigin",
    "musicKitOriginRegistered",
    "musicKitOriginRegistrationEvidenceHash",
  ], "Apple control-plane receipt staging binding");
  const production = exactObject(payload.production, [
    "runtimeSnapshotHash",
    "appleCredentialVersionHash",
    "appleQaVerifierCredentialVersionHash",
    "appleQaVerifierCredentialIdentityHash",
    "appleAccountIdHash",
  ], "Apple control-plane receipt production binding");
  for (const [environment, binding] of [
    ["staging", staging],
    ["production", production],
  ] as const) {
    for (const field of [
      "appleCredentialVersionHash",
      "appleQaVerifierCredentialVersionHash",
      "appleQaVerifierCredentialIdentityHash",
      "appleAccountIdHash",
    ]) {
      sha256Digest(
        binding[field],
        `Apple control-plane receipt ${environment}.${field}`,
      );
    }
  }
  sha256Digest(
    staging.runtimeSnapshotHash,
    "Apple control-plane receipt staging.runtimeSnapshotHash",
  );
  if (
    (phase === "candidate" && production.runtimeSnapshotHash !== null)
    || (phase !== "candidate" && production.runtimeSnapshotHash === null)
  ) {
    throw new Error(
      "Apple control-plane receipt production runtime binding does not match its phase",
    );
  }
  if (production.runtimeSnapshotHash !== null) {
    sha256Digest(
      production.runtimeSnapshotHash,
      "Apple control-plane receipt production.runtimeSnapshotHash",
    );
  }
  if (
    staging.appleAccountIdHash === production.appleAccountIdHash
    || staging.appleCredentialVersionHash
      === production.appleCredentialVersionHash
    || staging.appleQaVerifierCredentialVersionHash
      === production.appleQaVerifierCredentialVersionHash
    || staging.appleQaVerifierCredentialIdentityHash
      === production.appleQaVerifierCredentialIdentityHash
  ) {
    throw new Error(
      "Apple control-plane receipt must prove separate staging and production identities",
    );
  }
  if (staging.musicKitOriginRegistered !== true) {
    throw new Error("staging MusicKit origin is not registered");
  }
  dedicatedMusicKitOrigin(staging.musicKitOrigin);
  sha256Digest(
    staging.musicKitOriginRegistrationEvidenceHash,
    "Apple control-plane receipt registration evidence hash",
  );
  return payload;
}

export function verifyAppleControlPlaneReceipt(input: {
  value: unknown;
  verificationKey: string | Buffer | KeyObject;
  trustPolicy: unknown;
  expected: AppleControlPlaneReceiptExpectedV1;
  now?: string;
}): VerifiedAppleControlPlaneReceiptV1 {
  const now = input.now === undefined
    ? Date.now()
    : Date.parse(isoTimestamp(input.now, "Apple receipt verification time"));
  const verified = verifyReceiptEnvelope({
    value: input.value,
    verificationKey: input.verificationKey,
    trustPolicy: input.trustPolicy,
    expectedKind: "apple",
    envelopeSchemaVersion: SIGNED_APPLE_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
    payloadLabel: "Apple control-plane receipt",
    validatePayload: (value) => validateApplePayload(value, now),
  });
  const candidate = candidateBinding(
    verified.payload.candidate,
    "Apple control-plane receipt candidate",
  );
  const staging = verified.payload.staging as JsonRecord;
  const production = verified.payload.production as JsonRecord;
  const expected = input.expected;
  if (
    verified.payload.phase !== expected.phase
    || candidate.version !== expected.candidate.version
    || candidate.sourceRevision !== expected.candidate.sourceRevision
    || candidate.imageDigest !== expected.candidate.imageDigest
    || candidate.imageReference !== expected.candidate.imageReference
    || staging.runtimeSnapshotHash !== expected.staging.runtimeSnapshotHash
    || staging.appleCredentialVersionHash
      !== expected.staging.appleCredentialVersionHash
    || staging.appleQaVerifierCredentialVersionHash
      !== expected.staging.appleQaVerifierCredentialVersionHash
    || staging.musicKitOrigin !== expected.staging.musicKitOrigin
    || production.runtimeSnapshotHash !== expected.production.runtimeSnapshotHash
    || (
      expected.production.appleCredentialVersionHash !== undefined
      && production.appleCredentialVersionHash
        !== expected.production.appleCredentialVersionHash
    )
    || (
      expected.production.appleQaVerifierCredentialVersionHash !== undefined
      && production.appleQaVerifierCredentialVersionHash
        !== expected.production.appleQaVerifierCredentialVersionHash
    )
  ) {
    throw new Error(
      "Apple control-plane receipt does not bind the exact candidate runtime snapshots",
    );
  }
  return {
    payload: verified.payload,
    payloadHash: verified.payloadHash,
    keyId: verified.keyId,
    verificationKeyFingerprint: verified.verificationKeyFingerprint,
    stagingAppleAccountIdHash: String(staging.appleAccountIdHash),
    productionAppleAccountIdHash: String(production.appleAccountIdHash),
    stagingAppleQaVerifierCredentialIdentityHash:
      String(staging.appleQaVerifierCredentialIdentityHash),
    productionAppleQaVerifierCredentialIdentityHash:
      String(production.appleQaVerifierCredentialIdentityHash),
    musicKitOriginRegistrationEvidenceHash:
      String(staging.musicKitOriginRegistrationEvidenceHash),
  };
}

function validateProviderPayload(value: unknown, now: number): JsonRecord {
  const payload = exactObject(value, [
    "schemaVersion",
    "phase",
    "issuer",
    "generatedAt",
    "expiresAt",
    "candidate",
    "staging",
    "production",
  ], "provider control-plane receipt");
  if (payload.schemaVersion !== PROVIDER_CONTROL_PLANE_RECEIPT_SCHEMA_V1) {
    throw new Error("provider control-plane receipt uses an unsupported schema");
  }
  const phase = evidencePhase(
    payload.phase,
    "provider control-plane receipt phase",
  );
  safeLabel(payload.issuer, "provider control-plane receipt issuer");
  validateReceiptWindow({
    generatedAt: payload.generatedAt,
    expiresAt: payload.expiresAt,
    now,
    maximumTtlMs: RELEASE_EVIDENCE_TTL_MS,
    maximumAgeMs: RELEASE_EVIDENCE_TTL_MS,
    label: "provider control-plane receipt",
  });
  candidateBinding(payload.candidate, "provider control-plane receipt candidate");
  const staging = exactObject(payload.staging, [
    "runtimeSnapshotHash",
    "providerCredentialVersionHash",
    "providerProjectIdentityHash",
  ], "provider control-plane receipt staging binding");
  const production = exactObject(payload.production, [
    "runtimeSnapshotHash",
    "providerCredentialVersionHash",
    "providerProjectIdentityHash",
  ], "provider control-plane receipt production binding");
  for (const [environment, binding] of [
    ["staging", staging],
    ["production", production],
  ] as const) {
    sha256Digest(
      binding.providerCredentialVersionHash,
      `provider control-plane receipt ${environment} credential version`,
    );
    sha256Digest(
      binding.providerProjectIdentityHash,
      `provider control-plane receipt ${environment} project identity`,
    );
  }
  sha256Digest(
    staging.runtimeSnapshotHash,
    "provider control-plane receipt staging runtime snapshot",
  );
  if (
    (phase === "candidate" && production.runtimeSnapshotHash !== null)
    || (phase !== "candidate" && production.runtimeSnapshotHash === null)
  ) {
    throw new Error(
      "provider control-plane receipt production runtime binding does not match its phase",
    );
  }
  if (production.runtimeSnapshotHash !== null) {
    sha256Digest(
      production.runtimeSnapshotHash,
      "provider control-plane receipt production runtime snapshot",
    );
  }
  if (
    staging.providerCredentialVersionHash
      === production.providerCredentialVersionHash
    || staging.providerProjectIdentityHash
      === production.providerProjectIdentityHash
  ) {
    throw new Error(
      "provider control-plane receipt must prove separate staging and production projects",
    );
  }
  return payload;
}

export function verifyProviderControlPlaneReceipt(input: {
  value: unknown;
  verificationKey: string | Buffer | KeyObject;
  trustPolicy: unknown;
  expected: ProviderControlPlaneReceiptExpectedV1;
  now?: string;
}): VerifiedProviderControlPlaneReceiptV1 {
  const now = input.now === undefined
    ? Date.now()
    : Date.parse(isoTimestamp(input.now, "provider receipt verification time"));
  const verified = verifyReceiptEnvelope({
    value: input.value,
    verificationKey: input.verificationKey,
    trustPolicy: input.trustPolicy,
    expectedKind: "provider",
    envelopeSchemaVersion: SIGNED_PROVIDER_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
    payloadLabel: "provider control-plane receipt",
    validatePayload: (value) => validateProviderPayload(value, now),
  });
  const candidate = candidateBinding(
    verified.payload.candidate,
    "provider control-plane receipt candidate",
  );
  const staging = verified.payload.staging as JsonRecord;
  const production = verified.payload.production as JsonRecord;
  const expected = input.expected;
  if (
    verified.payload.phase !== expected.phase
    || candidate.version !== expected.candidate.version
    || candidate.sourceRevision !== expected.candidate.sourceRevision
    || candidate.imageDigest !== expected.candidate.imageDigest
    || candidate.imageReference !== expected.candidate.imageReference
    || staging.runtimeSnapshotHash !== expected.staging.runtimeSnapshotHash
    || staging.providerCredentialVersionHash
      !== expected.staging.providerCredentialVersionHash
    || production.runtimeSnapshotHash !== expected.production.runtimeSnapshotHash
    || (
      expected.production.providerCredentialVersionHash !== undefined
      && production.providerCredentialVersionHash
        !== expected.production.providerCredentialVersionHash
    )
  ) {
    throw new Error(
      "provider control-plane receipt does not bind the exact candidate runtime snapshots",
    );
  }
  return {
    payload: verified.payload,
    payloadHash: verified.payloadHash,
    keyId: verified.keyId,
    verificationKeyFingerprint: verified.verificationKeyFingerprint,
    stagingProviderCredentialVersionHash:
      String(staging.providerCredentialVersionHash),
    productionProviderCredentialVersionHash:
      String(production.providerCredentialVersionHash),
    stagingProviderProjectIdentityHash:
      String(staging.providerProjectIdentityHash),
    productionProviderProjectIdentityHash:
      String(production.providerProjectIdentityHash),
  };
}

function validateBudgetPayload(value: unknown, now: number): JsonRecord {
  const payload = exactObject(value, [
    "schemaVersion",
    "phase",
    "issuer",
    "generatedAt",
    "expiresAt",
    "candidate",
    "runtimeSnapshots",
    "ledgerScope",
    "currency",
    "monthlyCostLimitUsd",
    "spentUsd",
    "reservedForRequiredGatesUsd",
    "asOf",
  ], "QA budget-ledger receipt");
  if (payload.schemaVersion !== QA_BUDGET_LEDGER_RECEIPT_SCHEMA_V1) {
    throw new Error("QA budget-ledger receipt uses an unsupported schema");
  }
  const phase = evidencePhase(payload.phase, "QA budget-ledger receipt phase");
  safeLabel(payload.issuer, "QA budget-ledger receipt issuer");
  validateReceiptWindow({
    generatedAt: payload.generatedAt,
    expiresAt: payload.expiresAt,
    now,
    maximumTtlMs: QA_BUDGET_LEDGER_MAX_TTL_MS,
    maximumAgeMs: QA_BUDGET_LEDGER_MAX_AGE_MS,
    label: "QA budget-ledger receipt",
  });
  candidateBinding(payload.candidate, "QA budget-ledger receipt candidate");
  const snapshots = exactObject(payload.runtimeSnapshots, [
    "staging",
    "production",
  ], "QA budget-ledger receipt runtime snapshots");
  sha256Digest(snapshots.staging, "QA budget receipt staging snapshot hash");
  if (
    (phase === "candidate" && snapshots.production !== null)
    || (phase !== "candidate" && snapshots.production === null)
  ) {
    throw new Error(
      "QA budget receipt production runtime binding does not match its phase",
    );
  }
  if (snapshots.production !== null) {
    sha256Digest(
      snapshots.production,
      "QA budget receipt production snapshot hash",
    );
  }
  if (
    payload.ledgerScope !== "staging_release_qa"
    || payload.currency !== "USD"
  ) {
    throw new Error("QA budget-ledger receipt is for the wrong ledger or currency");
  }
  const limit = money(
    payload.monthlyCostLimitUsd,
    "QA budget monthly limit",
    { positive: true },
  );
  const spent = money(payload.spentUsd, "QA budget spent amount");
  const reserved = money(
    payload.reservedForRequiredGatesUsd,
    "QA budget reserved amount",
    { positive: true },
  );
  if (
    limit > MAXIMUM_STAGING_MONTHLY_COST_USD
    || spent > limit
    || reserved > limit - spent
  ) {
    throw new Error("QA budget-ledger receipt cannot cover the required gates");
  }
  const asOf = isoTimestamp(payload.asOf, "QA budget-ledger receipt asOf");
  const asOfMs = Date.parse(asOf);
  if (asOfMs > now + 5 * 60_000 || now - asOfMs > QA_BUDGET_LEDGER_MAX_AGE_MS) {
    throw new Error("QA budget-ledger receipt ledger position is stale");
  }
  return payload;
}

export function verifyQaBudgetLedgerReceipt(input: {
  value: unknown;
  verificationKey: string | Buffer | KeyObject;
  trustPolicy: unknown;
  expected: QaBudgetLedgerReceiptExpectedV1;
  now?: string;
}): VerifiedQaBudgetLedgerReceiptV1 {
  const now = input.now === undefined
    ? Date.now()
    : Date.parse(isoTimestamp(input.now, "QA budget verification time"));
  const verified = verifyReceiptEnvelope({
    value: input.value,
    verificationKey: input.verificationKey,
    trustPolicy: input.trustPolicy,
    expectedKind: "qa_budget",
    envelopeSchemaVersion: SIGNED_QA_BUDGET_LEDGER_RECEIPT_SCHEMA_V1,
    payloadLabel: "QA budget-ledger receipt",
    validatePayload: (value) => validateBudgetPayload(value, now),
  });
  const candidate = candidateBinding(
    verified.payload.candidate,
    "QA budget-ledger receipt candidate",
  );
  const snapshots = verified.payload.runtimeSnapshots as JsonRecord;
  if (
    verified.payload.phase !== input.expected.phase
    || candidate.version !== input.expected.candidate.version
    || candidate.sourceRevision !== input.expected.candidate.sourceRevision
    || candidate.imageDigest !== input.expected.candidate.imageDigest
    || candidate.imageReference !== input.expected.candidate.imageReference
    || snapshots.staging !== input.expected.stagingRuntimeSnapshotHash
    || snapshots.production !== input.expected.productionRuntimeSnapshotHash
  ) {
    throw new Error(
      "QA budget-ledger receipt does not bind the exact candidate runtime snapshots",
    );
  }
  const monthlyCostLimitUsd = Number(verified.payload.monthlyCostLimitUsd);
  const spentUsd = Number(verified.payload.spentUsd);
  return {
    payload: verified.payload,
    payloadHash: verified.payloadHash,
    keyId: verified.keyId,
    verificationKeyFingerprint: verified.verificationKeyFingerprint,
    monthlyCostLimitUsd,
    spentUsd,
    budgetRemainingUsd: Number((monthlyCostLimitUsd - spentUsd).toFixed(6)),
    reservedForRequiredGatesUsd:
      Number(verified.payload.reservedForRequiredGatesUsd),
    asOf: String(verified.payload.asOf),
  };
}
