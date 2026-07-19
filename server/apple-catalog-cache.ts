import { createHash, randomUUID } from "node:crypto";
import type { CatalogSong } from "../shared/types.ts";
import type {
  AppleCatalogAlbum,
  AppleCatalogArtist,
  AppleCatalogPage,
  AppleCatalogPlaylist,
  AppleCatalogSearchResult,
  AppleCatalogSearchType,
  AppleArtistAlbumView,
} from "./apple.ts";
import type { CatalogDiscoveryProvider } from "./catalog-discovery-v2.ts";
import { consumeAppleProviderCircuitOpening } from "./apple-provider-control.ts";

export type AppleCatalogCacheResourceKind =
  | "catalog_resource"
  | "search_view"
  | "artist_view"
  | "playlist_membership"
  /** Compact MusicBrainz recording/release-group identity; never relevance evidence. */
  | "musicbrainz_identity";

export type AppleCatalogCacheState = "hit" | "coalesced" | "miss" | "stale" | "malformed" | "unavailable";
export type AppleCatalogProviderState = "skipped" | "success" | "failure" | "invalid" | "circuit_open";

export interface AppleCatalogCacheEntry {
  storefront: string;
  resourceKind: AppleCatalogCacheResourceKind;
  requestFingerprint: string;
  payload: unknown;
  fetchedAt: string;
  expiresAt: string;
}

export interface AppleCatalogCacheWrite {
  storefront: string;
  resourceKind: AppleCatalogCacheResourceKind;
  requestFingerprint: string;
  payload: unknown;
  fetchedAt: string;
  expiresAt: string;
}

export interface AppleCatalogCacheEvent {
  runId: string;
  storefront: string;
  resourceKind: AppleCatalogCacheResourceKind;
  requestFingerprint: string;
  cacheState: AppleCatalogCacheState;
  providerState: AppleCatalogProviderState;
  detail: Record<string, unknown>;
  occurredAt: string;
}

/**
 * Narrow persistence boundary used by the catalog cache. It intentionally
 * lives outside apple.ts so the Apple client remains unaware of repositories.
 */
export interface AppleCatalogCacheRepository {
  getAppleCatalogCacheEntry(
    storefront: string,
    resourceKind: AppleCatalogCacheResourceKind,
    requestFingerprint: string,
  ): Promise<AppleCatalogCacheEntry | null>;
  putAppleCatalogCacheEntry(entry: AppleCatalogCacheWrite): Promise<void>;
  deleteAppleCatalogCacheEntry(
    storefront: string,
    resourceKind: AppleCatalogCacheResourceKind,
    requestFingerprint: string,
  ): Promise<void>;
  recordAppleCatalogCacheEvent(event: AppleCatalogCacheEvent): Promise<void>;
  tryAcquireAppleCatalogCacheLease(
    storefront: string,
    resourceKind: AppleCatalogCacheResourceKind,
    requestFingerprint: string,
    ownerId: string,
    leaseMs: number,
  ): Promise<boolean>;
  releaseAppleCatalogCacheLease(
    storefront: string,
    resourceKind: AppleCatalogCacheResourceKind,
    requestFingerprint: string,
    ownerId: string,
  ): Promise<void>;
  cleanupExpiredAppleCatalogCacheLeases(limit?: number): Promise<number>;
}

export const APPLE_CATALOG_CACHE_TTL_MS = Object.freeze({
  catalog_resource: 7 * 24 * 60 * 60 * 1_000,
  search_view: 24 * 60 * 60 * 1_000,
  artist_view: 24 * 60 * 60 * 1_000,
  playlist_membership: 6 * 60 * 60 * 1_000,
  musicbrainz_identity: 7 * 24 * 60 * 60 * 1_000,
} satisfies Record<AppleCatalogCacheResourceKind, number>);

interface CachedProviderOptions {
  now?: () => Date;
  ttlMs?: Partial<Record<AppleCatalogCacheResourceKind, number>>;
  leaseMs?: number;
  coalescingWaitMs?: number;
  coalescingPollMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_CACHE_LEASE_MS = 30_000;
const DEFAULT_COALESCING_WAIT_MS = 35_000;
const DEFAULT_COALESCING_POLL_MS = 100;
const localInflightByRepository = new WeakMap<object, Map<string, Promise<unknown>>>();

export class AppleCatalogCacheLeaseBusyError extends Error {
  readonly name = "AppleCatalogCacheLeaseBusyError";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function appleCatalogRequestFingerprint(input: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function normalizedStorefront(value: string): string {
  const storefront = value.trim().toLowerCase();
  if (!/^[a-z]{2}$/u.test(storefront)) throw new Error("Apple storefront must be a two-letter code");
  return storefront;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isCatalogSong(value: unknown): value is CatalogSong {
  if (!isObject(value)) return false;
  return typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.artistName === "string"
    && typeof value.albumName === "string"
    && isOptionalString(value.url)
    && (value.contentRating === undefined || value.contentRating === "clean" || value.contentRating === "explicit")
    && (value.genreNames === undefined || isStringArray(value.genreNames));
}

function isArtist(value: unknown): value is AppleCatalogArtist {
  return isObject(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && isStringArray(value.genreNames)
    && isOptionalString(value.url);
}

function isAlbum(value: unknown): value is AppleCatalogAlbum {
  return isObject(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.artistName === "string"
    && isStringArray(value.genreNames)
    && isOptionalString(value.url);
}

function isPlaylist(value: unknown): value is AppleCatalogPlaylist {
  return isObject(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.curatorName === "string"
    && typeof value.description === "string"
    && isOptionalString(value.url);
}

function isPage<T>(value: unknown, itemGuard: (item: unknown) => item is T): value is AppleCatalogPage<T> {
  return isObject(value)
    && Array.isArray(value.items)
    && value.items.every(itemGuard)
    && (value.next === null || typeof value.next === "string");
}

function isSearchResult(value: unknown): value is AppleCatalogSearchResult {
  return isObject(value)
    && Array.isArray(value.songs) && value.songs.every(isCatalogSong)
    && Array.isArray(value.artists) && value.artists.every(isArtist)
    && Array.isArray(value.albums) && value.albums.every(isAlbum)
    && Array.isArray(value.playlists) && value.playlists.every(isPlaylist)
    && (value.next === undefined || (isObject(value.next)
      && Object.entries(value.next).every(([type, cursor]) => (
        ["songs", "artists", "albums", "playlists"].includes(type)
        && typeof cursor === "string"
      ))));
}

async function ignoreTelemetryFailure(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch {
    // Cache and telemetry are deliberately fail-open. The provider remains the
    // source of truth and a metrics outage must not stop playlist assembly.
  }
}

function errorDetail(error: unknown): Record<string, unknown> {
  return {
    errorName: error instanceof Error ? error.name.slice(0, 120) : "UnknownError",
    errorMessage: error instanceof Error ? error.message.slice(0, 500) : "Apple catalog provider failed",
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createCachedCatalogDiscoveryProvider(
  repository: AppleCatalogCacheRepository,
  runId: string,
  provider: CatalogDiscoveryProvider,
  options: CachedProviderOptions = {},
): CatalogDiscoveryProvider {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Apple catalog request aborted"));
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Apple catalog request aborted"));
    }, { once: true });
  }));
  const leaseMs = Math.min(120_000, Math.max(5_000, Math.floor(options.leaseMs ?? DEFAULT_CACHE_LEASE_MS)));
  const coalescingWaitMs = Math.min(125_000, Math.max(
    leaseMs,
    Math.floor(options.coalescingWaitMs ?? DEFAULT_COALESCING_WAIT_MS),
  ));
  const coalescingPollMs = Math.min(1_000, Math.max(
    10,
    Math.floor(options.coalescingPollMs ?? DEFAULT_COALESCING_POLL_MS),
  ));
  const localInflight = localInflightByRepository.get(repository) ?? new Map<string, Promise<unknown>>();
  localInflightByRepository.set(repository, localInflight);
  let cleanupAttempted = false;

  async function cached<T>(input: {
    storefront: string;
    resourceKind: AppleCatalogCacheResourceKind;
    fingerprintInput: Record<string, unknown>;
    validate(value: unknown): value is T;
    fetch(): Promise<T>;
    signal?: AbortSignal;
  }): Promise<T> {
    const storefront = normalizedStorefront(input.storefront);
    const requestFingerprint = appleCatalogRequestFingerprint(input.fingerprintInput);
    const inflightKey = `${storefront}:${input.resourceKind}:${requestFingerprint}`;
    const observedAt = now();
    if (!cleanupAttempted) {
      cleanupAttempted = true;
      await ignoreTelemetryFailure(() => repository.cleanupExpiredAppleCatalogCacheLeases(100).then(() => undefined));
    }
    let cacheState: AppleCatalogCacheState = "miss";
    let entry: AppleCatalogCacheEntry | null = null;
    try {
      entry = await repository.getAppleCatalogCacheEntry(storefront, input.resourceKind, requestFingerprint);
    } catch {
      cacheState = "unavailable";
    }

    if (entry) {
      const expiresAt = Date.parse(entry.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= observedAt.getTime()) {
        cacheState = "stale";
      } else if (!input.validate(entry.payload)) {
        cacheState = "malformed";
        await ignoreTelemetryFailure(() => repository.deleteAppleCatalogCacheEntry(
          storefront,
          input.resourceKind,
          requestFingerprint,
        ));
      } else {
        await ignoreTelemetryFailure(() => repository.recordAppleCatalogCacheEvent({
          runId,
          storefront,
          resourceKind: input.resourceKind,
          requestFingerprint,
          cacheState: "hit",
          providerState: "skipped",
          detail: { ageMs: Math.max(0, observedAt.getTime() - Date.parse(entry!.fetchedAt)) },
          occurredAt: observedAt.toISOString(),
        }));
        return clone(entry.payload);
      }
    }

    const local = localInflight.get(inflightKey) as Promise<T> | undefined;
    if (local) {
      const result = await local;
      await ignoreTelemetryFailure(() => repository.recordAppleCatalogCacheEvent({
        runId,
        storefront,
        resourceKind: input.resourceKind,
        requestFingerprint,
        cacheState: "coalesced",
        providerState: "skipped",
        detail: { scope: "worker" },
        occurredAt: now().toISOString(),
      }));
      return clone(result);
    }

    const ownerId = randomUUID();
    let leaseAcquired = false;
    let leaseAvailable = true;
    try {
      leaseAcquired = await repository.tryAcquireAppleCatalogCacheLease(
        storefront,
        input.resourceKind,
        requestFingerprint,
        ownerId,
        leaseMs,
      );
    } catch {
      // A cache-coordination outage must not make the catalog unavailable.
      // Continue directly to Apple, just as the legacy cache did.
      leaseAvailable = false;
    }

    if (leaseAvailable && !leaseAcquired) {
      const attempts = Math.max(1, Math.ceil(coalescingWaitMs / coalescingPollMs));
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        input.signal?.throwIfAborted();
        await sleep(coalescingPollMs, input.signal);
        let refreshed: AppleCatalogCacheEntry | null = null;
        try {
          refreshed = await repository.getAppleCatalogCacheEntry(
            storefront,
            input.resourceKind,
            requestFingerprint,
          );
        } catch {
          leaseAvailable = false;
          break;
        }
        if (refreshed
          && Date.parse(refreshed.expiresAt) > now().getTime()
          && input.validate(refreshed.payload)) {
          await ignoreTelemetryFailure(() => repository.recordAppleCatalogCacheEvent({
            runId,
            storefront,
            resourceKind: input.resourceKind,
            requestFingerprint,
            cacheState: "coalesced",
            providerState: "skipped",
            detail: { scope: "database", waitAttempts: attempt + 1 },
            occurredAt: now().toISOString(),
          }));
          return clone(refreshed.payload);
        }
        try {
          leaseAcquired = await repository.tryAcquireAppleCatalogCacheLease(
            storefront,
            input.resourceKind,
            requestFingerprint,
            ownerId,
            leaseMs,
          );
        } catch {
          leaseAvailable = false;
          break;
        }
        if (leaseAcquired) break;
      }
      if (leaseAvailable && !leaseAcquired) {
        throw new AppleCatalogCacheLeaseBusyError(
          `Apple catalog cache fill is still active for ${input.resourceKind}`,
        );
      }
    }

    const leaseRenewal = leaseAcquired ? setInterval(() => {
      void ignoreTelemetryFailure(() => repository.tryAcquireAppleCatalogCacheLease(
        storefront,
        input.resourceKind,
        requestFingerprint,
        ownerId,
        leaseMs,
      ).then(() => undefined));
    }, Math.max(1_000, Math.floor(leaseMs / 2))) : null;
    leaseRenewal?.unref?.();
    const providerPromise = (async (): Promise<T> => {
      let result: T;
      try {
        result = await input.fetch();
      } catch (error) {
        const circuitOpening = consumeAppleProviderCircuitOpening(error);
        await ignoreTelemetryFailure(() => repository.recordAppleCatalogCacheEvent({
          runId,
          storefront,
          resourceKind: input.resourceKind,
          requestFingerprint,
          cacheState,
          providerState: circuitOpening ? "circuit_open" : "failure",
          detail: {
            ...errorDetail(error),
            ...(circuitOpening ? { reasonCode: "apple_provider_circuit_open" } : {}),
          },
          occurredAt: observedAt.toISOString(),
        }));
        throw error;
      }
      if (!input.validate(result)) {
        const error = new Error(`Apple catalog provider returned malformed ${input.resourceKind} data`);
        await ignoreTelemetryFailure(() => repository.recordAppleCatalogCacheEvent({
          runId,
          storefront,
          resourceKind: input.resourceKind,
          requestFingerprint,
          cacheState,
          providerState: "invalid",
          detail: errorDetail(error),
          occurredAt: observedAt.toISOString(),
        }));
        throw error;
      }

      const configuredTtl = options.ttlMs?.[input.resourceKind];
      const ttlMs = Number.isFinite(configuredTtl) && configuredTtl! > 0
        ? Math.floor(configuredTtl!)
        : APPLE_CATALOG_CACHE_TTL_MS[input.resourceKind];
      const fetchedAt = now();
      const expiresAt = new Date(fetchedAt.getTime() + ttlMs);
      await ignoreTelemetryFailure(() => repository.putAppleCatalogCacheEntry({
        storefront,
        resourceKind: input.resourceKind,
        requestFingerprint,
        payload: result,
        fetchedAt: fetchedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      }));
      await ignoreTelemetryFailure(() => repository.recordAppleCatalogCacheEvent({
        runId,
        storefront,
        resourceKind: input.resourceKind,
        requestFingerprint,
        cacheState,
        providerState: "success",
        detail: { ttlMs, coordinated: leaseAcquired },
        occurredAt: fetchedAt.toISOString(),
      }));
      return result;
    })();
    localInflight.set(inflightKey, providerPromise);
    try {
      return clone(await providerPromise);
    } finally {
      if (leaseRenewal) clearInterval(leaseRenewal);
      if (localInflight.get(inflightKey) === providerPromise) localInflight.delete(inflightKey);
      if (leaseAcquired) {
        await ignoreTelemetryFailure(() => repository.releaseAppleCatalogCacheLease(
          storefront,
          input.resourceKind,
          requestFingerprint,
          ownerId,
        ));
      }
    }
  }

  return {
    search(storefront, query, types, limit, signal, cursor) {
      const normalizedTypes = [...new Set(types)].sort() as AppleCatalogSearchType[];
      return cached({
        storefront,
        resourceKind: "search_view",
        fingerprintInput: { operation: "search", query: query.trim(), types: normalizedTypes, limit, cursor: cursor ?? null },
        validate: isSearchResult,
        fetch: () => provider.search(storefront, query, types, limit, signal, cursor),
        signal,
      });
    },
    playlistTracks(storefront, playlistId, cursor, signal) {
      return cached({
        storefront,
        resourceKind: "playlist_membership",
        fingerprintInput: { operation: "playlist_tracks", playlistId, cursor },
        validate: (value): value is AppleCatalogPage<CatalogSong> => isPage(value, isCatalogSong),
        fetch: () => provider.playlistTracks(storefront, playlistId, cursor, signal),
        signal,
      });
    },
    albumTracks(storefront, albumId, cursor, signal) {
      return cached({
        storefront,
        resourceKind: "catalog_resource",
        fingerprintInput: { operation: "album_tracks", albumId, cursor },
        validate: (value): value is AppleCatalogPage<CatalogSong> => isPage(value, isCatalogSong),
        fetch: () => provider.albumTracks(storefront, albumId, cursor, signal),
        signal,
      });
    },
    artistTopSongs(storefront, artistId, cursor, signal) {
      return cached({
        storefront,
        resourceKind: "artist_view",
        fingerprintInput: { operation: "artist_top_songs", artistId, cursor },
        validate: (value): value is AppleCatalogPage<CatalogSong> => isPage(value, isCatalogSong),
        fetch: () => provider.artistTopSongs(storefront, artistId, cursor, signal),
        signal,
      });
    },
    artistAlbums(storefront, artistId, view, cursor, signal) {
      return cached({
        storefront,
        resourceKind: "artist_view",
        fingerprintInput: { operation: "artist_albums", artistId, view, cursor },
        validate: (value): value is AppleCatalogPage<AppleCatalogAlbum> => isPage(value, isAlbum),
        fetch: () => provider.artistAlbums(storefront, artistId, view, cursor, signal),
        signal,
      });
    },
    similarArtists(storefront, artistId, cursor, signal) {
      return cached({
        storefront,
        resourceKind: "artist_view",
        fingerprintInput: { operation: "similar_artists", artistId, cursor },
        validate: (value): value is AppleCatalogPage<AppleCatalogArtist> => isPage(value, isArtist),
        fetch: () => provider.similarArtists(storefront, artistId, cursor, signal),
        signal,
      });
    },
  };
}

// Keep this annotation tied to the public Apple view type so adding a new
// artist view cannot accidentally bypass the fingerprinted cache wrapper.
const _artistViewTypeCheck: AppleArtistAlbumView | null = null;
void _artistViewTypeCheck;
