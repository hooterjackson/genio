import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from "node:crypto";

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{0,159}$/u;
const SIGNATURE_VALUE = /^[0-9A-Za-z_-]{64,256}$/u;

export type JsonRecord = Record<string, unknown>;

export function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as JsonRecord;
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} contains missing or unapproved fields`);
  }
  return record;
}

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortedJsonValue(item)]),
  );
}

export function stableSignedArtifactJson(value: unknown): string {
  return JSON.stringify(sortedJsonValue(value));
}

export function signedArtifactSha256(value: unknown): string {
  return createHash("sha256")
    .update(stableSignedArtifactJson(value))
    .digest("hex");
}

export function sha256Digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function publicKey(value: string | Buffer | KeyObject): KeyObject {
  return value instanceof KeyObject ? value : createPublicKey(value);
}

function privateKey(value: string | Buffer | KeyObject): KeyObject {
  return value instanceof KeyObject ? value : createPrivateKey(value);
}

export function createStrictSignedEnvelope<
  Payload extends JsonRecord,
  SchemaVersion extends string,
>(input: {
  envelopeSchemaVersion: SchemaVersion;
  payload: Payload;
  signingKey: string | Buffer | KeyObject;
  keyId: string;
}): {
  schemaVersion: SchemaVersion;
  payload: Payload;
  payloadHash: string;
  signature: {
    algorithm: "Ed25519";
    keyId: string;
    value: string;
  };
} {
  if (!SAFE_KEY_ID.test(input.keyId)) {
    throw new Error("signed artifact key ID is invalid");
  }
  const key = privateKey(input.signingKey);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("signed artifact requires an Ed25519 private key");
  }
  return {
    schemaVersion: input.envelopeSchemaVersion,
    payload: input.payload,
    payloadHash: signedArtifactSha256(input.payload),
    signature: {
      algorithm: "Ed25519",
      keyId: input.keyId,
      value: sign(
        null,
        Buffer.from(stableSignedArtifactJson({
          algorithm: "Ed25519",
          keyId: input.keyId,
          payload: input.payload,
        })),
        key,
      ).toString("base64url"),
    },
  };
}

export function verifyStrictSignedEnvelope(input: {
  value: unknown;
  verificationKey: string | Buffer | KeyObject;
  envelopeSchemaVersion: string;
  payloadLabel: string;
  validatePayload: (value: unknown) => JsonRecord;
}): { payload: JsonRecord; payloadHash: string; keyId: string } {
  const envelope = exactObject(
    input.value,
    ["schemaVersion", "payload", "payloadHash", "signature"],
    `signed ${input.payloadLabel}`,
  );
  if (envelope.schemaVersion !== input.envelopeSchemaVersion) {
    throw new Error(`signed ${input.payloadLabel} uses an unsupported schema`);
  }
  const payload = input.validatePayload(envelope.payload);
  const payloadHash = sha256Digest(
    envelope.payloadHash,
    `signed ${input.payloadLabel}.payloadHash`,
  );
  if (payloadHash !== signedArtifactSha256(payload)) {
    throw new Error(`signed ${input.payloadLabel} payload hash does not match`);
  }
  const signature = exactObject(
    envelope.signature,
    ["algorithm", "keyId", "value"],
    `signed ${input.payloadLabel}.signature`,
  );
  if (signature.algorithm !== "Ed25519") {
    throw new Error(`signed ${input.payloadLabel} signature algorithm is unsupported`);
  }
  const keyId = typeof signature.keyId === "string" ? signature.keyId : "";
  const signatureValue = typeof signature.value === "string"
    ? signature.value
    : "";
  if (
    !SAFE_KEY_ID.test(keyId)
    || !SIGNATURE_VALUE.test(signatureValue)
    || !verify(
      null,
      Buffer.from(stableSignedArtifactJson({
        algorithm: "Ed25519",
        keyId,
        payload,
      })),
      publicKey(input.verificationKey),
      Buffer.from(signatureValue, "base64url"),
    )
  ) {
    throw new Error(`signed ${input.payloadLabel} signature is invalid`);
  }
  return { payload, payloadHash, keyId };
}
