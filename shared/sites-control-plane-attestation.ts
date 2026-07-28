import {
  createHash,
  createPublicKey,
  KeyObject,
} from "node:crypto";
import { RELEASE_EVIDENCE_TTL_MS } from "./release-evidence-constants.ts";
import {
  exactObject,
  type JsonRecord,
  sha256Digest,
  verifyStrictSignedEnvelope,
} from "./signed-artifact.ts";

export const SITES_CONTROL_PLANE_ATTESTATION_SCHEMA_V1 =
  "genio-sites-control-plane-attestation/v1";
export const SIGNED_SITES_CONTROL_PLANE_ATTESTATION_SCHEMA_V1 =
  "genio-signed-sites-control-plane-attestation/v1";
export const SITES_CONTROL_PLANE_ISSUER_V1 = "openai-sites-control-plane";
export const SITES_CONTROL_PLANE_VERIFICATION_KEY_SCHEMA_V1 =
  "genio-sites-control-plane-verification-key/v1";
export const SITES_CONTROL_PLANE_TRUST_POLICY_SCHEMA_V1 =
  "genio-sites-control-plane-trust-policy/v1";

const SAFE_KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u;

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function payload(value: unknown): JsonRecord {
  const result = exactObject(value, [
    "schemaVersion",
    "generatedAt",
    "expiresAt",
    "issuer",
    "operation",
    "receiptHash",
  ], "Sites control-plane attestation");
  if (result.schemaVersion !== SITES_CONTROL_PLANE_ATTESTATION_SCHEMA_V1
    || result.issuer !== SITES_CONTROL_PLANE_ISSUER_V1
    || result.operation !== "production_deployment_ready") {
    throw new Error("Sites control-plane attestation has unsupported provenance");
  }
  const generatedAt = timestamp(
    result.generatedAt,
    "Sites control-plane attestation generatedAt",
  );
  const expiresAt = timestamp(
    result.expiresAt,
    "Sites control-plane attestation expiresAt",
  );
  const ttl = Date.parse(expiresAt) - Date.parse(generatedAt);
  if (ttl <= 0 || ttl > RELEASE_EVIDENCE_TTL_MS) {
    throw new Error("Sites control-plane attestation must expire within 24 hours");
  }
  sha256Digest(result.receiptHash, "Sites control-plane attestation receiptHash");
  return result;
}

function key(value: string | Buffer | KeyObject): KeyObject {
  const result = value instanceof KeyObject ? value : createPublicKey(value);
  const publicKey = result.type === "private" ? createPublicKey(result) : result;
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Sites control-plane verification key must be Ed25519");
  }
  return publicKey;
}

export function sitesControlPlaneVerificationKeyV1(
  value: string | Buffer | KeyObject,
): {
  schemaVersion: typeof SITES_CONTROL_PLANE_VERIFICATION_KEY_SCHEMA_V1;
  algorithm: "Ed25519";
  format: "spki-der";
  value: string;
  sha256: string;
} {
  const publicKey = key(value);
  return {
    schemaVersion: SITES_CONTROL_PLANE_VERIFICATION_KEY_SCHEMA_V1,
    algorithm: "Ed25519",
    format: "spki-der",
    value: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    sha256: sitesControlPlaneKeyFingerprint(publicKey),
  };
}

export function validateSitesControlPlaneVerificationKeyV1(
  value: unknown,
): {
  source: ReturnType<typeof sitesControlPlaneVerificationKeyV1>;
  key: KeyObject;
} {
  const source = exactObject(value, [
    "schemaVersion",
    "algorithm",
    "format",
    "value",
    "sha256",
  ], "Sites control-plane verification key");
  if (
    source.schemaVersion !== SITES_CONTROL_PLANE_VERIFICATION_KEY_SCHEMA_V1
    || source.algorithm !== "Ed25519"
    || source.format !== "spki-der"
    || typeof source.value !== "string"
    || !/^[0-9A-Za-z_-]{48,256}$/u.test(source.value)
  ) {
    throw new Error("Sites control-plane verification key is invalid");
  }
  let verificationKey: KeyObject;
  try {
    verificationKey = key(createPublicKey({
      key: Buffer.from(source.value, "base64url"),
      format: "der",
      type: "spki",
    }));
  } catch {
    throw new Error("Sites control-plane verification key is invalid");
  }
  const normalized = sitesControlPlaneVerificationKeyV1(verificationKey);
  if (
    source.sha256 !== normalized.sha256
    || source.value !== normalized.value
  ) {
    throw new Error("Sites control-plane verification key fingerprint does not match");
  }
  return { source: normalized, key: verificationKey };
}

export function sitesControlPlaneTrustPolicyV1(input: {
  approvedKeyId: string;
  approvedKeySha256: string;
}): {
  schemaVersion: typeof SITES_CONTROL_PLANE_TRUST_POLICY_SCHEMA_V1;
  approvedKeyId: string;
  approvedKeySha256: string;
} {
  if (!SAFE_KEY_ID.test(input.approvedKeyId)) {
    throw new Error("approved Sites control-plane key ID is invalid");
  }
  sha256Digest(
    input.approvedKeySha256,
    "approved Sites control-plane key fingerprint",
  );
  return {
    schemaVersion: SITES_CONTROL_PLANE_TRUST_POLICY_SCHEMA_V1,
    approvedKeyId: input.approvedKeyId,
    approvedKeySha256: input.approvedKeySha256,
  };
}

export function validateSitesControlPlaneTrustPolicyV1(
  value: unknown,
): ReturnType<typeof sitesControlPlaneTrustPolicyV1> {
  const policy = exactObject(value, [
    "schemaVersion",
    "approvedKeyId",
    "approvedKeySha256",
  ], "Sites control-plane trust policy");
  if (policy.schemaVersion !== SITES_CONTROL_PLANE_TRUST_POLICY_SCHEMA_V1) {
    throw new Error("Sites control-plane trust policy uses an unsupported schema");
  }
  return sitesControlPlaneTrustPolicyV1({
    approvedKeyId: String(policy.approvedKeyId),
    approvedKeySha256: String(policy.approvedKeySha256),
  });
}

export function sitesControlPlaneKeyFingerprint(
  value: string | Buffer | KeyObject,
): string {
  return createHash("sha256").update(
    key(value).export({ format: "der", type: "spki" }),
  ).digest("hex");
}

export function verifySitesControlPlaneAttestation(input: {
  value: unknown;
  verificationKey: string | Buffer | KeyObject;
  expectedReceiptHash: string;
  expectedKeyId: string;
  expectedKeyFingerprint: string;
  now?: string;
}): {
  payload: JsonRecord;
  payloadHash: string;
  keyId: string;
  verificationKeyFingerprint: string;
} {
  sha256Digest(input.expectedReceiptHash, "expected Sites receipt hash");
  sha256Digest(
    input.expectedKeyFingerprint,
    "expected Sites control-plane key fingerprint",
  );
  if (!SAFE_KEY_ID.test(input.expectedKeyId)) {
    throw new Error("expected Sites control-plane key ID is invalid");
  }
  const verificationKey = key(input.verificationKey);
  const fingerprint = sitesControlPlaneKeyFingerprint(verificationKey);
  if (fingerprint !== input.expectedKeyFingerprint) {
    throw new Error(
      "Sites control-plane verification key is not the protected trusted key",
    );
  }
  const verified = verifyStrictSignedEnvelope({
    value: input.value,
    verificationKey,
    envelopeSchemaVersion: SIGNED_SITES_CONTROL_PLANE_ATTESTATION_SCHEMA_V1,
    payloadLabel: "Sites control-plane attestation",
    validatePayload: payload,
  });
  if (verified.keyId !== input.expectedKeyId) {
    throw new Error("Sites control-plane attestation key ID is not trusted");
  }
  if (verified.payload.receiptHash !== input.expectedReceiptHash) {
    throw new Error("Sites control-plane attestation does not bind the deployment receipt");
  }
  const now = input.now
    ? Date.parse(timestamp(input.now, "Sites control-plane verification time"))
    : Date.now();
  const generatedAt = Date.parse(String(verified.payload.generatedAt));
  const expiresAt = Date.parse(String(verified.payload.expiresAt));
  if (generatedAt > now + 5 * 60_000 || now >= expiresAt) {
    throw new Error("Sites control-plane attestation is not currently valid");
  }
  return {
    ...verified,
    verificationKeyFingerprint: fingerprint,
  };
}
