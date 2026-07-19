import type { CatalogMatchResult, CatalogSong, TrackCandidateInput } from "../shared/types.ts";
import {
  normalizeMusicBaseTitle,
  normalizeMusicText,
} from "../lib/matching.ts";
import {
  APPLE_CATALOG_CACHE_TTL_MS,
  appleCatalogRequestFingerprint,
  type AppleCatalogCacheEntry,
  type AppleCatalogCacheRepository,
} from "./apple-catalog-cache.ts";
import { catalogRecordingVersionClass } from "./pipeline-v2-policy.ts";
import { PIPELINE_V2_MUSICBRAINZ_MAX_UNCACHED_REQUESTS } from "./research-policy.ts";

const MUSICBRAINZ_HOST = "musicbrainz.org";
const MUSICBRAINZ_CACHE_STOREFRONT = "zz";
const MUSICBRAINZ_CACHE_KIND = "musicbrainz_identity" as const;
const MUSICBRAINZ_CACHE_VERSION = "musicbrainz_identity_v1";
const MUSICBRAINZ_MAX_RESPONSE_BYTES = 1_000_000;
const MUSICBRAINZ_REQUEST_TIMEOUT_MS = 5_000;
const MUSICBRAINZ_RETRY_LIMIT = 2;
const MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS = 1_050;
const MUSICBRAINZ_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/u;

export interface MusicBrainzIdentityEnrichment {
  recordingId: string;
  releaseGroupId: string | null;
  source: "cache" | "musicbrainz";
}

interface CachedMusicBrainzIdentity {
  version: typeof MUSICBRAINZ_CACHE_VERSION;
  status: "resolved" | "not_found";
  recordingId: string | null;
  releaseGroupId: string | null;
}

/**
 * The existing provider cache table has a legacy Apple-specific name, but its
 * key and payload columns are provider-neutral. MusicBrainz stores only the
 * two stable identifiers below; no provider response or relevance claim is
 * retained.
 */
export interface MusicBrainzEnrichmentRepository extends Partial<AppleCatalogCacheRepository> {
  reserveMusicBrainzEnrichmentRequest?(runId: string, maximum: number): Promise<number | null>;
  updateCandidateMusicBrainzIdentity?(
    runId: string,
    candidateId: string,
    recordingId: string,
  ): Promise<void>;
}

export interface MusicBrainzEnrichmentOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  throttle?: (signal?: AbortSignal) => Promise<void>;
  timeoutMs?: number;
}

type EnrichmentCandidate = Pick<TrackCandidateInput,
  "artist" | "title" | "album" | "durationMs" | "isrc" | "musicbrainzId" | "versionLabel"> & {
    id: string;
  };

let musicBrainzQueue = Promise.resolve();

async function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error("MusicBrainz request aborted");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("MusicBrainz request aborted"));
    }, { once: true });
  });
}

async function defaultThrottle(signal?: AbortSignal): Promise<void> {
  const previous = musicBrainzQueue;
  let release!: () => void;
  musicBrainzQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    await defaultSleep(MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS, signal);
  } finally {
    release();
  }
}

function normalizedIsrc(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase().replace(/[^A-Z0-9]/gu, "") ?? "";
  return ISRC.test(normalized) ? normalized : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalUuid(value: unknown): string | null {
  return typeof value === "string" && MUSICBRAINZ_ID.test(value) ? value.toLowerCase() : null;
}

function isCachedIdentity(value: unknown): value is CachedMusicBrainzIdentity {
  if (!isObject(value) || value.version !== MUSICBRAINZ_CACHE_VERSION) return false;
  if (value.status !== "resolved" && value.status !== "not_found") return false;
  const recordingId = value.recordingId === null ? null : optionalUuid(value.recordingId);
  const releaseGroupId = value.releaseGroupId === null ? null : optionalUuid(value.releaseGroupId);
  if (value.recordingId !== null && !recordingId) return false;
  if (value.releaseGroupId !== null && !releaseGroupId) return false;
  return value.status === "not_found" ? recordingId === null && releaseGroupId === null : recordingId !== null;
}

function compatibleAlternate(primary: CatalogSong, alternate: CatalogSong): boolean {
  if (primary.isrc && alternate.isrc) return normalizedIsrc(primary.isrc) === normalizedIsrc(alternate.isrc);
  return normalizeMusicText(primary.artistName) === normalizeMusicText(alternate.artistName)
    && normalizeMusicBaseTitle(primary.name) === normalizeMusicBaseTitle(alternate.name);
}

/** Avoid turning MusicBrainz into a per-track hot path. */
export function shouldEnrichMusicBrainzIdentity(
  candidate: EnrichmentCandidate,
  match: CatalogMatchResult,
): boolean {
  if (candidate.musicbrainzId || match.status !== "accepted" || !match.song) return false;
  const noStableIsrc = !normalizedIsrc(match.song.isrc ?? candidate.isrc);
  const ambiguousIdentity = match.alternatives.some((alternate) => compatibleAlternate(match.song!, alternate));
  const versionClass = catalogRecordingVersionClass(match.song);
  const versionFamilyNeedsResolution = Boolean(candidate.versionLabel || match.song.versionLabel)
    || !["canonical", "clean", "explicit"].includes(versionClass);
  return noStableIsrc || ambiguousIdentity || versionFamilyNeedsResolution;
}

export function musicBrainzEnrichmentFingerprint(
  candidate: EnrichmentCandidate,
  song: CatalogSong,
): string {
  return appleCatalogRequestFingerprint({
    provider: "musicbrainz",
    version: MUSICBRAINZ_CACHE_VERSION,
    artist: normalizeMusicText(song.artistName || candidate.artist),
    title: normalizeMusicBaseTitle(song.name || candidate.title),
    album: normalizeMusicText(song.albumName || candidate.album || ""),
    durationBucket: Number.isFinite(song.durationInMillis ?? candidate.durationMs)
      ? Math.round(Number(song.durationInMillis ?? candidate.durationMs) / 2_000)
      : null,
    isrc: normalizedIsrc(song.isrc ?? candidate.isrc),
    versionLabel: normalizeMusicText(song.versionLabel ?? candidate.versionLabel ?? ""),
  });
}

function musicBrainzHeaders(): Record<string, string> {
  const contact = process.env.MUSICBRAINZ_CONTACT?.trim() || "https://9enio.com/about";
  return {
    Accept: "application/json",
    "User-Agent": `9enio/1.1 (${contact.slice(0, 200)})`,
  };
}

function quoteMusicBrainzQuery(value: string): string {
  return value.normalize("NFKC").slice(0, 240).replace(/[\\"]/gu, "\\$&");
}

export function musicBrainzIdentityUrl(candidate: EnrichmentCandidate, song: CatalogSong): URL {
  const isrc = normalizedIsrc(song.isrc ?? candidate.isrc);
  const url = isrc
    ? new URL(`https://${MUSICBRAINZ_HOST}/ws/2/isrc/${isrc}`)
    : new URL(`https://${MUSICBRAINZ_HOST}/ws/2/recording`);
  if (!isrc) {
    url.searchParams.set(
      "query",
      `recording:\"${quoteMusicBrainzQuery(song.name || candidate.title)}\" AND artist:\"${quoteMusicBrainzQuery(song.artistName || candidate.artist)}\"`,
    );
    url.searchParams.set("limit", "5");
  } else {
    // `inc` is a lookup/browse parameter. Recording search results already
    // contain artist credit and release summaries, and sending `inc` on a
    // search request can be rejected by MusicBrainz.
    url.searchParams.set("inc", "recordings+artist-credits+releases+release-groups+isrcs");
  }
  url.searchParams.set("fmt", "json");
  return url;
}

function artistCredit(recording: Record<string, unknown>): string {
  const credits = Array.isArray(recording["artist-credit"]) ? recording["artist-credit"] : [];
  return credits.map((credit) => {
    if (typeof credit === "string") return credit;
    if (!isObject(credit)) return "";
    const artist = isObject(credit.artist) ? credit.artist : {};
    return typeof credit.name === "string"
      ? credit.name
      : typeof artist.name === "string"
        ? artist.name
        : "";
  }).filter(Boolean).join(" ");
}

function releaseGroupIds(recording: Record<string, unknown>, album: string | null): string[] {
  const normalizedAlbum = normalizeMusicText(album ?? "");
  const releases = Array.isArray(recording.releases) ? recording.releases.filter(isObject) : [];
  const exactAlbumGroups = releases.flatMap((release) => {
    if (!normalizedAlbum || normalizeMusicText(typeof release.title === "string" ? release.title : "") !== normalizedAlbum) return [];
    const group = isObject(release["release-group"]) ? release["release-group"] : {};
    const id = optionalUuid(group.id);
    return id ? [id] : [];
  });
  const allGroups = releases.flatMap((release) => {
    const group = isObject(release["release-group"]) ? release["release-group"] : {};
    const id = optionalUuid(group.id);
    return id ? [id] : [];
  });
  return [...new Set(exactAlbumGroups.length > 0 ? exactAlbumGroups : allGroups)];
}

function recordingCandidates(payload: unknown): Record<string, unknown>[] {
  if (!isObject(payload)) return [];
  if (Array.isArray(payload.recordings)) return payload.recordings.filter(isObject).slice(0, 10);
  if (isObject(payload.recording)) return [payload.recording];
  return [];
}

function resolveIdentity(
  payload: unknown,
  candidate: EnrichmentCandidate,
  song: CatalogSong,
): Omit<MusicBrainzIdentityEnrichment, "source"> | null {
  const expectedArtist = normalizeMusicText(song.artistName || candidate.artist);
  const expectedTitle = normalizeMusicBaseTitle(song.name || candidate.title);
  const expectedDuration = song.durationInMillis ?? candidate.durationMs;
  const ranked = recordingCandidates(payload).flatMap((recording) => {
    const recordingId = optionalUuid(recording.id);
    const title = typeof recording.title === "string" ? recording.title : "";
    const artist = artistCredit(recording);
    if (!recordingId
      || normalizeMusicBaseTitle(title) !== expectedTitle
      || normalizeMusicText(artist) !== expectedArtist) return [];
    const duration = Number(recording.length);
    const hasComparableDuration = Number.isFinite(expectedDuration) && Number.isFinite(duration);
    if (hasComparableDuration && Math.abs(Number(expectedDuration) - duration) > 10_000) return [];
    const groups = releaseGroupIds(recording, song.albumName || candidate.album);
    const exactAlbum = groups.length > 0 && Boolean(song.albumName || candidate.album);
    return [{
      recordingId,
      releaseGroupId: groups.length === 1 ? groups[0]! : null,
      score: 8 + (hasComparableDuration ? 2 : 0) + (exactAlbum ? 1 : 0),
    }];
  }).sort((left, right) => right.score - left.score || left.recordingId.localeCompare(right.recordingId));
  const best = ranked[0];
  if (!best) return null;
  if (ranked[1] && ranked[1].score === best.score && ranked[1].recordingId !== best.recordingId) return null;
  return { recordingId: best.recordingId, releaseGroupId: best.releaseGroupId };
}

function retryAfterMilliseconds(response: Response, now: Date): number {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return 250;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(5_000, Math.max(0, Math.ceil(seconds * 1_000)));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(5_000, Math.max(0, date - now.getTime())) : 250;
}

async function compactJson(response: Response): Promise<unknown> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > MUSICBRAINZ_MAX_RESPONSE_BYTES) {
    throw new Error("MusicBrainz response exceeded the size limit");
  }
  const text = await response.text();
  if (text.length > MUSICBRAINZ_MAX_RESPONSE_BYTES) throw new Error("MusicBrainz response exceeded the size limit");
  return JSON.parse(text) as unknown;
}

function cachedResult(entry: AppleCatalogCacheEntry | null, now: Date): CachedMusicBrainzIdentity | null {
  if (!entry || Date.parse(entry.expiresAt) <= now.getTime() || !isCachedIdentity(entry.payload)) return null;
  return entry.payload;
}

function hasCacheRepository(repository: MusicBrainzEnrichmentRepository): repository is MusicBrainzEnrichmentRepository & Pick<
  AppleCatalogCacheRepository,
  "getAppleCatalogCacheEntry" | "putAppleCatalogCacheEntry" | "deleteAppleCatalogCacheEntry"
> & Required<Pick<MusicBrainzEnrichmentRepository,
  "reserveMusicBrainzEnrichmentRequest" | "updateCandidateMusicBrainzIdentity"
>> {
  return typeof repository.getAppleCatalogCacheEntry === "function"
    && typeof repository.putAppleCatalogCacheEntry === "function"
    && typeof repository.deleteAppleCatalogCacheEntry === "function"
    && typeof repository.reserveMusicBrainzEnrichmentRequest === "function"
    && typeof repository.updateCandidateMusicBrainzIdentity === "function";
}

/**
 * Optional identity enrichment. Every provider/cache/persistence failure is
 * fail-open so Apple matching remains the authoritative hot path.
 */
export async function enrichMusicBrainzIdentity(
  repository: MusicBrainzEnrichmentRepository,
  runId: string,
  candidate: EnrichmentCandidate,
  match: CatalogMatchResult,
  signal?: AbortSignal,
  options: MusicBrainzEnrichmentOptions = {},
): Promise<MusicBrainzIdentityEnrichment | null> {
  if (!shouldEnrichMusicBrainzIdentity(candidate, match) || !match.song || !hasCacheRepository(repository)) return null;
  const now = options.now ?? (() => new Date());
  const fingerprint = musicBrainzEnrichmentFingerprint(candidate, match.song);
  let entry: AppleCatalogCacheEntry | null = null;
  try {
    entry = await repository.getAppleCatalogCacheEntry(MUSICBRAINZ_CACHE_STOREFRONT, MUSICBRAINZ_CACHE_KIND, fingerprint);
    const cached = cachedResult(entry, now());
    if (cached) {
      if (cached.status === "not_found") return null;
      await repository.updateCandidateMusicBrainzIdentity(runId, candidate.id, cached.recordingId!);
      return {
        recordingId: cached.recordingId!,
        releaseGroupId: cached.releaseGroupId,
        source: "cache",
      };
    }
    if (entry) {
      await repository.deleteAppleCatalogCacheEntry(MUSICBRAINZ_CACHE_STOREFRONT, MUSICBRAINZ_CACHE_KIND, fingerprint);
    }
  } catch {
    // A cache outage is not a matching outage. The durable request reservation
    // below remains the authoritative safety gate.
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const throttle = options.throttle ?? defaultThrottle;
  const timeoutMs = Math.min(10_000, Math.max(500, Math.floor(options.timeoutMs ?? MUSICBRAINZ_REQUEST_TIMEOUT_MS)));
  const url = musicBrainzIdentityUrl(candidate, match.song);
  let resolved: Omit<MusicBrainzIdentityEnrichment, "source"> | null = null;
  let receivedValidPayload = false;

  try {
    for (let attempt = 0; attempt < MUSICBRAINZ_RETRY_LIMIT; attempt += 1) {
      signal?.throwIfAborted();
      const reserved = await repository.reserveMusicBrainzEnrichmentRequest(
        runId,
        PIPELINE_V2_MUSICBRAINZ_MAX_UNCACHED_REQUESTS,
      );
      if (reserved === null) return null;
      await throttle(signal);
      const requestSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(timeoutMs),
      ]);
      const response = await fetchImpl(url, {
        method: "GET",
        headers: musicBrainzHeaders(),
        redirect: "error",
        signal: requestSignal,
      });
      if ((response.status === 429 || response.status >= 500) && attempt + 1 < MUSICBRAINZ_RETRY_LIMIT) {
        await sleep(retryAfterMilliseconds(response, now()), signal);
        continue;
      }
      if (!response.ok) return null;
      resolved = resolveIdentity(await compactJson(response), candidate, match.song);
      receivedValidPayload = true;
      break;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }

  if (!receivedValidPayload) return null;
  const fetchedAt = now();
  const payload: CachedMusicBrainzIdentity = resolved ? {
    version: MUSICBRAINZ_CACHE_VERSION,
    status: "resolved",
    recordingId: resolved.recordingId,
    releaseGroupId: resolved.releaseGroupId,
  } : {
    version: MUSICBRAINZ_CACHE_VERSION,
    status: "not_found",
    recordingId: null,
    releaseGroupId: null,
  };
  try {
    await repository.putAppleCatalogCacheEntry({
      storefront: MUSICBRAINZ_CACHE_STOREFRONT,
      resourceKind: MUSICBRAINZ_CACHE_KIND,
      requestFingerprint: fingerprint,
      payload,
      fetchedAt: fetchedAt.toISOString(),
      expiresAt: new Date(fetchedAt.getTime() + APPLE_CATALOG_CACHE_TTL_MS.musicbrainz_identity).toISOString(),
    });
  } catch {
    // Cache writes are best effort; never turn an enrichment into a run error.
  }
  if (!resolved) return null;
  try {
    await repository.updateCandidateMusicBrainzIdentity(runId, candidate.id, resolved.recordingId);
  } catch {
    return null;
  }
  return { ...resolved, source: "musicbrainz" };
}
