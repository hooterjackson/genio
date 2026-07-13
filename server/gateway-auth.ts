import type { FastifyRequest } from "fastify";
import { HttpError, hmacBase64Url, parseClientBucketAliases, safeEqualText, sha256Hex } from "./security.ts";

const SIGNED_HEADERS = [
  "x-needle-key-id",
  "x-needle-timestamp",
  "x-needle-nonce",
  "x-needle-body-sha256",
  "x-needle-client-bucket",
  "x-needle-owner-email",
  "x-needle-signature",
] as const;

export interface GatewayIdentity {
  keyId: string;
  clientBucket: string;
  clientBucketAliases: string[];
  ownerEmail: string | null;
}

export interface GatewayNonceStore {
  claimGatewayNonce(keyId: string, nonce: string, expiresAt: Date): Promise<boolean>;
}

function readGatewayKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  const encoded = process.env.GATEWAY_KEYS_JSON;
  if (encoded) {
    let parsed: unknown;
    try { parsed = JSON.parse(encoded); } catch { throw new Error("GATEWAY_KEYS_JSON must be valid JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("GATEWAY_KEYS_JSON must be an object");
    for (const [keyId, secret] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof secret === "string" && keyId && secret.length >= 24) keys.set(keyId, secret);
    }
  }
  const currentSecret = process.env.GATEWAY_HMAC_SECRET ?? process.env.GATEWAY_SECRET;
  if (process.env.GATEWAY_KEY_ID && currentSecret) {
    keys.set(process.env.GATEWAY_KEY_ID, currentSecret);
  }
  const previousSecret = process.env.GATEWAY_PREVIOUS_HMAC_SECRET ?? process.env.GATEWAY_PREVIOUS_SECRET;
  if (process.env.GATEWAY_PREVIOUS_KEY_ID && previousSecret) {
    keys.set(process.env.GATEWAY_PREVIOUS_KEY_ID, previousSecret);
  }
  if (keys.size === 0 && process.env.NODE_ENV !== "production") {
    keys.set("local-dev", "needle-local-development-only");
  }
  if (keys.size === 0) throw new Error("At least one Sites gateway key is required");
  if (keys.size > 2) throw new Error("Only current and previous Sites gateway keys may be active");
  if (process.env.NODE_ENV === "production" && [...keys.values()].some((secret) => secret.length < 24)) {
    throw new Error("Sites gateway HMAC secrets must contain at least 24 characters");
  }
  return keys;
}

function uniqueRawHeader(request: FastifyRequest, name: string, required: boolean): string {
  const values: string[] = [];
  const raw = request.raw.rawHeaders;
  for (let index = 0; index < raw.length; index += 2) {
    if (raw[index]?.toLowerCase() === name) values.push(raw[index + 1] ?? "");
  }
  if (values.length > 1 || (values.length === 1 && values[0]!.includes(","))) {
    throw new HttpError(401, `Duplicate ${name} header`, "invalid_gateway_signature");
  }
  if (required && values.length !== 1) throw new HttpError(401, `Missing ${name} header`, "invalid_gateway_signature");
  return values[0]?.trim() ?? "";
}

export function canonicalGatewayRequest(input: {
  keyId: string;
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  bodyHash: string;
  clientBucket: string;
  ownerEmail: string;
}): string {
  return [
    input.keyId,
    input.timestamp,
    input.nonce,
    input.method.toUpperCase(),
    input.path,
    input.bodyHash,
    input.clientBucket,
    input.ownerEmail,
  ].join("\n");
}

export function createGatewayVerifier(store: GatewayNonceStore) {
  const keys = readGatewayKeys();
  return async function verifyGateway(request: FastifyRequest): Promise<GatewayIdentity> {
    for (const header of SIGNED_HEADERS) uniqueRawHeader(request, header, header !== "x-needle-owner-email");

    const keyId = uniqueRawHeader(request, "x-needle-key-id", true);
    const timestamp = uniqueRawHeader(request, "x-needle-timestamp", true);
    const nonce = uniqueRawHeader(request, "x-needle-nonce", true);
    const bodyHash = uniqueRawHeader(request, "x-needle-body-sha256", true).toLowerCase();
    const clientBucket = uniqueRawHeader(request, "x-needle-client-bucket", true);
    const ownerEmail = uniqueRawHeader(request, "x-needle-owner-email", false).toLowerCase();
    const signature = uniqueRawHeader(request, "x-needle-signature", true);

    if (!/^[A-Za-z0-9._-]{1,80}$/.test(keyId) || !/^[A-Za-z0-9_-]{20,160}$/.test(nonce)) {
      throw new HttpError(401, "Gateway identity is invalid", "invalid_gateway_signature");
    }
    if (!/^\d{10}$/.test(timestamp)) throw new HttpError(401, "Gateway timestamp is invalid", "invalid_gateway_signature");
    const timestampSeconds = Number(timestamp);
    const nowSeconds = Math.floor(Date.now() / 1_000);
    if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > 60) {
      throw new HttpError(401, "Gateway request has expired", "stale_gateway_request");
    }
    if (!/^[a-f0-9]{64}$/.test(bodyHash) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
      throw new HttpError(401, "Gateway signature is invalid", "invalid_gateway_signature");
    }
    if (ownerEmail && (!/^.{1,240}@.{1,240}$/.test(ownerEmail) || ownerEmail.includes("\n"))) {
      throw new HttpError(401, "Owner identity is invalid", "invalid_gateway_identity");
    }

    const body = (request as FastifyRequest & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    if (!safeEqualText(sha256Hex(body), bodyHash)) {
      throw new HttpError(401, "Request body was modified", "invalid_gateway_body");
    }
    const secret = keys.get(keyId);
    if (!secret) throw new HttpError(401, "Gateway key is not recognized", "invalid_gateway_signature");
    const path = request.raw.url ?? request.url;
    const expected = hmacBase64Url(secret, canonicalGatewayRequest({
      keyId,
      timestamp,
      nonce,
      method: request.method,
      path,
      bodyHash,
      clientBucket,
      ownerEmail,
    }));
    if (!safeEqualText(expected, signature)) throw new HttpError(401, "Gateway signature is invalid", "invalid_gateway_signature");

    const claimed = await store.claimGatewayNonce(keyId, nonce, new Date((timestampSeconds + 120) * 1_000));
    if (!claimed) throw new HttpError(409, "Gateway request was already used", "gateway_replay");
    const clientBucketAliases = parseClientBucketAliases(clientBucket);
    return { keyId, clientBucket: clientBucketAliases[0]!, clientBucketAliases, ownerEmail: ownerEmail || null };
  };
}
