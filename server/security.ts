import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { TrackCandidateInput } from "../shared/types.ts";

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.0\.0\./,
  /^192\.0\.2\./,
  /^192\.168\./,
  /^198\.(1[89])\./,
  /^198\.51\.100\./,
  /^203\.0\.113\./,
  /^(22[4-9]|23\d)\./,
  /^(24\d|25[0-5])\./,
];

export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly code = "request_error") {
    super(message);
  }
}

export function assertPublicHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "Source URL is invalid", "invalid_source_url");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new HttpError(400, "Only public HTTPS sources are allowed", "invalid_source_url");
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new HttpError(400, "Local sources are not allowed", "private_source_url");
  }
  if (isIP(host) === 4 && PRIVATE_V4.some((rule) => rule.test(host))) {
    throw new HttpError(400, "Private-network sources are not allowed", "private_source_url");
  }
  const ipv6 = host.replace(/^\[|\]$/g, "");
  if (isIP(ipv6) === 6 && (
    ipv6 === "::" || ipv6 === "::1" || ipv6.startsWith("fc") || ipv6.startsWith("fd") ||
    ipv6.startsWith("fe8") || ipv6.startsWith("fe9") || ipv6.startsWith("fea") || ipv6.startsWith("feb") ||
    ipv6.startsWith("ff") || ipv6.startsWith("::ffff:") || ipv6.startsWith("64:ff9b:") ||
    ipv6.startsWith("100:") || ipv6.startsWith("2001:db8:")
  )) {
    throw new HttpError(400, "Private-network sources are not allowed", "private_source_url");
  }
  url.hash = "";
  return url;
}

export function assertAdapterUrl(value: string, allowedHosts: readonly string[]): URL {
  const url = assertPublicHttpsUrl(value);
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
    throw new HttpError(400, "Source host is not enabled", "source_host_not_allowed");
  }
  return url;
}

export function compactEvidenceNote(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
}

export function collectKnownUrls(value: unknown, output = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectKnownUrls(item, output));
    return output;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.url === "string") {
    try { output.add(assertPublicHttpsUrl(record.url).toString()); } catch { /* invalid URLs are not evidence */ }
  }
  Object.values(record).forEach((item) => collectKnownUrls(item, output));
  return output;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacHex(secret: string | Buffer, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function hmacBase64Url(secret: string | Buffer, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function safeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

const LOCAL_CAPABILITY_PEPPER = "needle-local-capability-only";
const LOCAL_CAPABILITY_PEPPER_VERSION = "development-current";
const CAPABILITY_PEPPER_VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u;
const CAPABILITY_PEPPER_VERSION_HASH_DOMAIN = "genio-capability-pepper-version/v1";
const MILLISECONDS_PER_DAY = 86_400_000;

export type CapabilityPepperConfigurationIssue =
  | "current_pepper_missing"
  | "current_version_missing"
  | "current_version_invalid"
  | "previous_pepper_missing"
  | "previous_version_missing"
  | "previous_version_invalid"
  | "pepper_reused"
  | "version_reused"
  | "previous_expiry_missing"
  | "previous_expiry_invalid"
  | "previous_expiry_too_long"
  | "session_ttl_invalid";

export interface CapabilityPepperRotationStatus {
  ready: boolean;
  currentVersionHash: string | null;
  previousVersionHash: string | null;
  previousVerificationActive: boolean;
  previousCleanupRequired: boolean;
  issue: CapabilityPepperConfigurationIssue | null;
}

interface CapabilityPepperConfiguration extends CapabilityPepperRotationStatus {
  currentPepper: string | null;
  previousPepper: string | null;
}

function capabilityPepperVersionHash(value: string): string {
  return sha256Hex(`${CAPABILITY_PEPPER_VERSION_HASH_DOMAIN}\0${value}`);
}

function exactIsoInstant(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : null;
}

function capabilityPepperConfiguration(
  environment: NodeJS.ProcessEnv,
  now: Date,
): CapabilityPepperConfiguration {
  const production = environment.NODE_ENV === "production";
  const configuredCurrentPepper = environment.CAPABILITY_PEPPER;
  const currentPepper = configuredCurrentPepper && configuredCurrentPepper.length > 0
    ? configuredCurrentPepper
    : production
      ? null
      : LOCAL_CAPABILITY_PEPPER;
  const configuredCurrentVersion = environment.CAPABILITY_PEPPER_VERSION?.trim() ?? "";
  const currentVersion = configuredCurrentVersion || (
    production ? "" : LOCAL_CAPABILITY_PEPPER_VERSION
  );
  const configuredPreviousPepper = environment.CAPABILITY_PREVIOUS_PEPPER;
  const previousPepper = configuredPreviousPepper && configuredPreviousPepper.length > 0
    ? configuredPreviousPepper
    : null;
  const previousVersion = environment.CAPABILITY_PREVIOUS_PEPPER_VERSION?.trim() ?? "";
  const previousExpiryValue = environment.CAPABILITY_PREVIOUS_PEPPER_EXPIRES_AT?.trim() ?? "";
  const currentVersionValid = CAPABILITY_PEPPER_VERSION.test(currentVersion);
  const previousVersionValid = !previousVersion || CAPABILITY_PEPPER_VERSION.test(previousVersion);
  const currentVersionHash = currentVersionValid
    ? capabilityPepperVersionHash(currentVersion)
    : null;
  const previousVersionHash = previousVersion && previousVersionValid
    ? capabilityPepperVersionHash(previousVersion)
    : null;

  let issue: CapabilityPepperConfigurationIssue | null = null;
  let previousExpiry: number | null = null;
  if (!currentPepper) {
    issue = "current_pepper_missing";
  } else if (production && !configuredCurrentVersion) {
    issue = "current_version_missing";
  } else if (!currentVersionValid) {
    issue = "current_version_invalid";
  } else if (!previousPepper && previousVersion) {
    issue = "previous_pepper_missing";
  } else if (!previousPepper && previousExpiryValue) {
    issue = "previous_pepper_missing";
  } else if (previousPepper && !previousVersion) {
    issue = "previous_version_missing";
  } else if (previousPepper && !previousVersionValid) {
    issue = "previous_version_invalid";
  } else if (previousPepper === currentPepper) {
    issue = "pepper_reused";
  } else if (previousPepper && previousVersion === currentVersion) {
    issue = "version_reused";
  } else if (previousPepper && !previousExpiryValue) {
    issue = "previous_expiry_missing";
  } else if (previousPepper) {
    previousExpiry = exactIsoInstant(previousExpiryValue);
    if (previousExpiry === null) {
      issue = "previous_expiry_invalid";
    } else {
      const ttlDays = Number(environment.CAPABILITY_SESSION_TTL_DAYS ?? 90);
      if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
        issue = "session_ttl_invalid";
      } else if (
        previousExpiry > now.getTime() + (ttlDays * MILLISECONDS_PER_DAY)
      ) {
        issue = "previous_expiry_too_long";
      }
    }
  }

  const ready = issue === null;
  const previousVerificationActive = ready
    && previousPepper !== null
    && previousExpiry !== null
    && previousExpiry > now.getTime();
  return {
    ready,
    currentPepper,
    previousPepper,
    currentVersionHash,
    previousVersionHash,
    previousVerificationActive,
    previousCleanupRequired: ready
      && previousPepper !== null
      && previousExpiry !== null
      && previousExpiry <= now.getTime(),
    issue,
  };
}

/**
 * Secret-free rotation state suitable for readiness and release identity.
 * Hashes are derived only from explicit non-secret version labels. They are
 * never derived from the pepper itself, so this view cannot help guess secret
 * material.
 */
export function capabilityPepperRotationStatus(
  environment: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): CapabilityPepperRotationStatus {
  const {
    ready,
    currentVersionHash,
    previousVersionHash,
    previousVerificationActive,
    previousCleanupRequired,
    issue,
  } = capabilityPepperConfiguration(environment, now);
  return Object.freeze({
    ready,
    currentVersionHash,
    previousVersionHash,
    previousVerificationActive,
    previousCleanupRequired,
    issue,
  });
}

function requiredCapabilityPepperConfiguration(
  environment: NodeJS.ProcessEnv,
  now = new Date(),
): CapabilityPepperConfiguration & { currentPepper: string } {
  const configuration = capabilityPepperConfiguration(environment, now);
  if (!configuration.ready || !configuration.currentPepper) {
    throw new Error(
      `Capability pepper configuration is invalid (${configuration.issue ?? "current_pepper_missing"})`,
    );
  }
  return configuration as CapabilityPepperConfiguration & { currentPepper: string };
}

/** Minting always uses the current pepper. */
export function capabilityHash(
  token: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configuration = requiredCapabilityPepperConfiguration(environment);
  return hmacHex(configuration.currentPepper, token);
}

/**
 * Verification computes both candidates before the repository performs one
 * atomic lookup. The matched generation is deliberately not returned.
 */
export function capabilityVerificationHashes(
  token: string,
  environment: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): readonly string[] {
  const configuration = requiredCapabilityPepperConfiguration(environment, now);
  const currentHash = hmacHex(configuration.currentPepper, token);
  const previousHash = configuration.previousVerificationActive
    && configuration.previousPepper
    ? hmacHex(configuration.previousPepper, token)
    : null;
  return Object.freeze([
    currentHash,
    ...(previousHash ? [previousHash] : []),
  ]);
}

export function parseClientBucketAliases(value: string): string[] {
  const aliases = value.split("|").map((part) => part.trim()).filter(Boolean);
  if (aliases.length < 1 || aliases.length > 2) throw new HttpError(401, "Client bucket is invalid", "invalid_gateway_identity");
  for (const alias of aliases) {
    if (!/^\d{4}-\d{2}-\d{2}\.[A-Za-z0-9_-]{20,120}$/.test(alias)) {
      throw new HttpError(401, "Client bucket is invalid", "invalid_gateway_identity");
    }
  }
  return [...new Set(aliases)];
}

function normalize(value: string | null | undefined): string {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

export function candidateIdentityKey(candidate: TrackCandidateInput): string {
  if (candidate.isrc?.trim()) return `isrc:${normalize(candidate.isrc).replace(/[^a-z0-9]/g, "")}`;
  if (candidate.musicbrainzId?.trim()) return `mbid:${normalize(candidate.musicbrainzId)}`;
  // Evidence is deliberately excluded. Rediscovering the same identifierless
  // recording through a second source must merge the new claim into the
  // existing candidate instead of manufacturing a second recording.
  const recordingDescriptor = {
    artist: normalize(candidate.artist),
    title: normalize(candidate.title),
    album: normalize(candidate.album),
    releaseYear: candidate.releaseYear ?? null,
    durationMs: candidate.durationMs ?? null,
    versionLabel: normalize(candidate.versionLabel),
  };
  return `metadata:${sha256Hex(stableStringify(recordingDescriptor))}`;
}

export function duplicateClusterKey(candidate: TrackCandidateInput): string {
  return `metadata:${sha256Hex(stableStringify({
    artist: normalize(candidate.artist),
    title: normalize(candidate.title),
    album: normalize(candidate.album),
    releaseYear: candidate.releaseYear ?? null,
    durationBucket: candidate.durationMs == null ? null : Math.round(candidate.durationMs / 2_000),
    versionLabel: normalize(candidate.versionLabel),
  }))}`;
}
