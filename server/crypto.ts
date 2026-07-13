import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { optionalSecret, parseSecretJson, requireSecret } from "./secrets.ts";

const ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = 1;

export interface EncryptedEnvelope {
  v: 1;
  alg: "A256GCM";
  kid: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

function decodeKey(value: string, name: string): Buffer {
  const normalized = value.trim();
  let key: Buffer;
  if (/^[a-f\d]{64}$/i.test(normalized)) key = Buffer.from(normalized, "hex");
  else key = Buffer.from(normalized.replaceAll("-", "+").replaceAll("_", "/"), "base64");
  if (key.length !== 32) throw new Error(`${name} must decode to exactly 32 bytes`);
  return key;
}

function keyRing(): { activeId: string; keys: Map<string, Buffer> } {
  const activeId = optionalSecret("APPLE_TOKEN_ENCRYPTION_KEY_ID") ?? "v1";
  const activeValue = requireSecret("APPLE_TOKEN_ENCRYPTION_KEY");
  const keys = new Map<string, Buffer>([[activeId, decodeKey(activeValue, "APPLE_TOKEN_ENCRYPTION_KEY")]]);
  const previous = parseSecretJson<Record<string, string>>("APPLE_TOKEN_DECRYPTION_KEYS_JSON", {});
  for (const [id, value] of Object.entries(previous)) {
    if (!keys.has(id)) keys.set(id, decodeKey(value, `APPLE_TOKEN_DECRYPTION_KEYS_JSON.${id}`));
  }
  return { activeId, keys };
}

function associatedData(purpose: string): Buffer {
  return Buffer.from(`needle:${ENVELOPE_VERSION}:${purpose}`, "utf8");
}

export function encryptSecret(plaintext: string, purpose: string): string {
  if (!plaintext) throw new Error("Refusing to encrypt an empty secret");
  const { activeId, keys } = keyRing();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, keys.get(activeId)!, iv);
  cipher.setAAD(associatedData(purpose));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope: EncryptedEnvelope = {
    v: ENVELOPE_VERSION,
    alg: "A256GCM",
    kid: activeId,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
  return JSON.stringify(envelope);
}

export function decryptSecret(serialized: string, purpose: string): string {
  let envelope: EncryptedEnvelope;
  try {
    envelope = JSON.parse(serialized) as EncryptedEnvelope;
  } catch {
    throw new Error("Encrypted secret envelope is malformed");
  }
  if (envelope.v !== ENVELOPE_VERSION || envelope.alg !== "A256GCM" || !envelope.kid) {
    throw new Error("Encrypted secret envelope uses an unsupported format");
  }
  const key = keyRing().keys.get(envelope.kid);
  if (!key) throw new Error(`No decryption key is configured for key ID ${envelope.kid}`);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(associatedData(purpose));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Encrypted secret could not be authenticated");
  }
}
