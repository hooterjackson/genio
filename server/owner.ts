import { timingSafeEqual } from "node:crypto";
import type { GatewayIdentity } from "./gateway-auth.ts";
import { createDeveloperToken, decryptMusicUserToken, encryptMusicUserToken } from "./apple.ts";
import { HttpError } from "./security.ts";

export interface EncryptedAppleAuthorization {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
  storefront: string;
  status: "unverified";
}

export function isOwner(identity: GatewayIdentity): boolean {
  const configured = process.env.OWNER_EMAIL?.trim().toLowerCase();
  return Boolean(configured && identity.ownerEmail === configured);
}

export function assertOwner(identity: GatewayIdentity): string {
  const configured = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (!configured) throw new Error("OWNER_EMAIL is required");
  if (!isOwner(identity)) {
    throw new HttpError(403, "Owner access is required", "owner_required");
  }
  return configured;
}

export function assertConfiguredAppleStorefront(storefront: string): string {
  const normalized = storefront.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(normalized)) {
    throw new HttpError(400, "Apple storefront must be a two-letter code", "invalid_storefront");
  }
  const configured = process.env.APPLE_STOREFRONT?.trim().toLowerCase();
  if (configured && configured !== normalized) {
    throw new HttpError(
      409,
      `This Apple account uses the ${normalized.toUpperCase()} storefront, but Needle is configured for ${configured.toUpperCase()}`,
      "storefront_mismatch",
    );
  }
  return normalized;
}

export function encryptAppleUserToken(userToken: string, storefront: string): EncryptedAppleAuthorization {
  const token = userToken.trim();
  if (token.length < 20 || token.length > 16_384) throw new HttpError(400, "Apple Music authorization is invalid", "invalid_apple_token");
  const canonicalStorefront = assertConfiguredAppleStorefront(storefront);
  const envelope = JSON.parse(encryptMusicUserToken(token)) as {
    ciphertext: string;
    iv: string;
    tag: string;
    kid: string;
  };
  return {
    ciphertext: envelope.ciphertext,
    iv: envelope.iv,
    authTag: envelope.tag,
    keyVersion: envelope.kid,
    storefront: canonicalStorefront,
    status: "unverified",
  };
}

export function decryptAppleUserToken(input: Pick<EncryptedAppleAuthorization, "ciphertext" | "iv" | "authTag" | "keyVersion">): string {
  return decryptMusicUserToken(JSON.stringify({
    v: 1,
    alg: "A256GCM",
    kid: input.keyVersion,
    iv: input.iv,
    ciphertext: input.ciphertext,
    tag: input.authTag,
  }));
}

export function appleUserTokenMatches(
  input: Pick<EncryptedAppleAuthorization, "ciphertext" | "iv" | "authTag" | "keyVersion">,
  candidate: string,
): boolean {
  try {
    const stored = Buffer.from(decryptAppleUserToken(input), "utf8");
    const supplied = Buffer.from(candidate.trim(), "utf8");
    return stored.length === supplied.length && timingSafeEqual(stored, supplied);
  } catch {
    return false;
  }
}

export function selectAppleAuthorizationStage<T extends {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
  storefront: string;
}>(
  existing: T | null,
  candidate: string,
  encrypted: EncryptedAppleAuthorization,
): { authorization: T | EncryptedAppleAuthorization; sameAuthorization: boolean } {
  const sameAuthorization = Boolean(
    existing
    && existing.storefront === encrypted.storefront
    && appleUserTokenMatches(existing, candidate),
  );
  return {
    authorization: sameAuthorization && existing ? existing : encrypted,
    sameAuthorization,
  };
}

export async function createAppleDeveloperToken(): Promise<{ developerToken: string; mediaId: string; expiresAt: string }> {
  const mediaId = process.env.APPLE_MEDIA_ID?.trim();
  if (!mediaId) throw new Error("APPLE_MEDIA_ID is required");
  const ttlSeconds = 15 * 60;
  return {
    developerToken: await createDeveloperToken({ origin: process.env.APP_ORIGIN, ttlSeconds }),
    mediaId,
    expiresAt: new Date(Date.now() + ttlSeconds * 1_000).toISOString(),
  };
}
