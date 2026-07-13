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

export function capabilityHash(token: string): string {
  const pepper = process.env.CAPABILITY_PEPPER;
  if (!pepper && process.env.NODE_ENV === "production") throw new Error("CAPABILITY_PEPPER is required");
  return hmacHex(pepper ?? "needle-local-capability-only", token);
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
  const claimIdentity = {
    artist: normalize(candidate.artist),
    title: normalize(candidate.title),
    album: normalize(candidate.album),
    releaseYear: candidate.releaseYear ?? null,
    durationMs: candidate.durationMs ?? null,
    versionLabel: normalize(candidate.versionLabel),
    evidence: candidate.evidence.map((claim) => ({
      sourceUrl: claim.sourceUrl,
      relationship: normalize(claim.relationship),
      note: normalize(claim.note),
    })).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
  };
  return `claim:${sha256Hex(stableStringify(claimIdentity))}`;
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
