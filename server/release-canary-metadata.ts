import { createHmac, timingSafeEqual } from "node:crypto";
import { stableStringify } from "./security.ts";

export const RELEASE_CANARY_METADATA_VERSION = "genio-release-canary/v1" as const;
export const RELEASE_CANARY_MAX_AGE_MS = 5 * 60_000;

export type ReleaseCanaryEnvironment = "staging" | "production";
export type ReleaseCanaryCacheMode = "cold" | "warm" | "mixed";
export type ReleaseCanaryOperation = "brief" | "run";

export interface UnsignedReleaseCanaryMetadata {
  version: typeof RELEASE_CANARY_METADATA_VERSION;
  canaryId: string;
  environment: ReleaseCanaryEnvironment;
  operation: ReleaseCanaryOperation;
  sourceRevision: string;
  issuedAt: string;
  cacheMode: ReleaseCanaryCacheMode;
}

export interface ReleaseCanaryMetadata extends UnsignedReleaseCanaryMetadata {
  signature: string;
}

function validateUnsigned(input: UnsignedReleaseCanaryMetadata): void {
  if (input.version !== RELEASE_CANARY_METADATA_VERSION
    || !/^[0-9A-Za-z][0-9A-Za-z._-]{2,63}$/u.test(input.canaryId)
    || !new Set(["staging", "production"]).has(input.environment)
    || !new Set(["brief", "run"]).has(input.operation)
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(input.sourceRevision)
    || !new Set(["cold", "warm", "mixed"]).has(input.cacheMode)) {
    throw new Error("invalid_release_canary_metadata");
  }
  const issuedAt = Date.parse(input.issuedAt);
  if (!Number.isFinite(issuedAt) || new Date(issuedAt).toISOString() !== input.issuedAt) {
    throw new Error("invalid_release_canary_metadata");
  }
}

function signingMaterial(input: UnsignedReleaseCanaryMetadata): string {
  return stableStringify(input);
}

function key(secret: string): Buffer {
  const normalized = secret.trim();
  if (Buffer.byteLength(normalized, "utf8") < 32) {
    throw new Error("release_canary_secret_too_short");
  }
  return Buffer.from(normalized);
}

export function signReleaseCanaryMetadata(
  input: UnsignedReleaseCanaryMetadata,
  secret: string,
): ReleaseCanaryMetadata {
  validateUnsigned(input);
  return {
    ...input,
    signature: createHmac("sha256", key(secret))
      .update(signingMaterial(input))
      .digest("hex"),
  };
}

export function verifyReleaseCanaryMetadata(
  value: unknown,
  options: {
    secret: string;
    expectedEnvironment: ReleaseCanaryEnvironment;
    expectedOperation: ReleaseCanaryOperation;
    expectedSourceRevision: string;
    now?: string;
  },
): UnsignedReleaseCanaryMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_release_canary_metadata");
  }
  const row = value as Record<string, unknown>;
  const unsigned: UnsignedReleaseCanaryMetadata = {
    version: row.version as typeof RELEASE_CANARY_METADATA_VERSION,
    canaryId: typeof row.canaryId === "string" ? row.canaryId : "",
    environment: row.environment as ReleaseCanaryEnvironment,
    operation: row.operation as ReleaseCanaryOperation,
    sourceRevision: typeof row.sourceRevision === "string"
      ? row.sourceRevision.toLowerCase()
      : "",
    issuedAt: typeof row.issuedAt === "string" ? row.issuedAt : "",
    cacheMode: row.cacheMode as ReleaseCanaryCacheMode,
  };
  validateUnsigned(unsigned);
  if (Object.keys(row).sort().join(",") !== [
    "cacheMode",
    "canaryId",
    "environment",
    "issuedAt",
    "operation",
    "signature",
    "sourceRevision",
    "version",
  ].join(",")) {
    throw new Error("invalid_release_canary_metadata");
  }
  if (unsigned.environment !== options.expectedEnvironment
    || unsigned.operation !== options.expectedOperation
    || unsigned.sourceRevision !== options.expectedSourceRevision.toLowerCase()) {
    throw new Error("release_canary_scope_mismatch");
  }
  const now = Date.parse(options.now ?? new Date().toISOString());
  const issuedAt = Date.parse(unsigned.issuedAt);
  if (!Number.isFinite(now)
    || issuedAt > now + 30_000
    || now - issuedAt > RELEASE_CANARY_MAX_AGE_MS) {
    throw new Error("release_canary_metadata_expired");
  }
  const actual = typeof row.signature === "string" && /^[0-9a-f]{64}$/u.test(row.signature)
    ? Buffer.from(row.signature, "hex")
    : Buffer.alloc(0);
  const expected = createHmac("sha256", key(options.secret))
    .update(signingMaterial(unsigned))
    .digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("release_canary_signature_invalid");
  }
  return unsigned;
}
