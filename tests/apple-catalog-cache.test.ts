import { describe, expect, test, vi } from "vitest";
import type { CatalogSong } from "../shared/types.ts";
import {
  APPLE_CATALOG_CACHE_TTL_MS,
  appleCatalogRequestFingerprint,
  createCachedCatalogDiscoveryProvider,
  type AppleCatalogCacheEntry,
  type AppleCatalogCacheEvent,
  type AppleCatalogCacheRepository,
  type AppleCatalogCacheResourceKind,
  type AppleCatalogCacheWrite,
} from "../server/apple-catalog-cache.ts";
import type { CatalogDiscoveryProvider } from "../server/catalog-discovery-v2.ts";
import { AppleApiError } from "../server/apple.ts";
import {
  AppleProviderControl,
  createControlledCatalogDiscoveryProvider,
} from "../server/apple-provider-control.ts";
import { PIPELINE_V2_MUSICBRAINZ_MAX_UNCACHED_REQUESTS } from "../server/research-policy.ts";

const song: CatalogSong = {
  id: "1001",
  name: "Can You Feel It",
  artistName: "Mr. Fingers",
  albumName: "Introduction",
  genreNames: ["House"],
  url: "https://music.apple.com/us/song/1001",
};

function key(storefront: string, resourceKind: AppleCatalogCacheResourceKind, fingerprint: string): string {
  return `${storefront}:${resourceKind}:${fingerprint}`;
}

class MemoryCacheRepository implements AppleCatalogCacheRepository {
  readonly entries: Map<string, AppleCatalogCacheEntry>;
  readonly events: AppleCatalogCacheEvent[];
  readonly leases: Map<string, { ownerId: string; expiresAt: number }>;
  deleted = 0;

  constructor(shared?: {
    entries: Map<string, AppleCatalogCacheEntry>;
    events: AppleCatalogCacheEvent[];
    leases: Map<string, { ownerId: string; expiresAt: number }>;
  }) {
    this.entries = shared?.entries ?? new Map();
    this.events = shared?.events ?? [];
    this.leases = shared?.leases ?? new Map();
  }

  async getAppleCatalogCacheEntry(storefront: string, resourceKind: AppleCatalogCacheResourceKind, fingerprint: string) {
    return this.entries.get(key(storefront, resourceKind, fingerprint)) ?? null;
  }

  async putAppleCatalogCacheEntry(entry: AppleCatalogCacheWrite) {
    this.entries.set(key(entry.storefront, entry.resourceKind, entry.requestFingerprint), { ...entry });
  }

  async deleteAppleCatalogCacheEntry(storefront: string, resourceKind: AppleCatalogCacheResourceKind, fingerprint: string) {
    this.deleted += 1;
    this.entries.delete(key(storefront, resourceKind, fingerprint));
  }

  async recordAppleCatalogCacheEvent(event: AppleCatalogCacheEvent) {
    this.events.push(event);
  }

  async tryAcquireAppleCatalogCacheLease(
    storefront: string,
    resourceKind: AppleCatalogCacheResourceKind,
    fingerprint: string,
    ownerId: string,
    leaseMs: number,
  ) {
    const cacheKey = key(storefront, resourceKind, fingerprint);
    const current = this.leases.get(cacheKey);
    if (current && current.ownerId !== ownerId && current.expiresAt > Date.now()) return false;
    this.leases.set(cacheKey, { ownerId, expiresAt: Date.now() + leaseMs });
    return true;
  }

  async releaseAppleCatalogCacheLease(
    storefront: string,
    resourceKind: AppleCatalogCacheResourceKind,
    fingerprint: string,
    ownerId: string,
  ) {
    const cacheKey = key(storefront, resourceKind, fingerprint);
    if (this.leases.get(cacheKey)?.ownerId === ownerId) this.leases.delete(cacheKey);
  }

  async cleanupExpiredAppleCatalogCacheLeases(limit = 1_000) {
    let deleted = 0;
    for (const [cacheKey, lease] of this.leases) {
      if (deleted >= limit) break;
      if (lease.expiresAt <= Date.now()) {
        this.leases.delete(cacheKey);
        deleted += 1;
      }
    }
    return deleted;
  }
}

function provider(overrides: Partial<CatalogDiscoveryProvider> = {}): CatalogDiscoveryProvider {
  return {
    search: vi.fn(async () => ({ songs: [song], artists: [], albums: [], playlists: [] })),
    playlistTracks: vi.fn(async () => ({ items: [song], next: null })),
    albumTracks: vi.fn(async () => ({ items: [song], next: null })),
    artistTopSongs: vi.fn(async () => ({ items: [song], next: null })),
    artistAlbums: vi.fn(async () => ({ items: [{
      id: "2001", name: "Introduction", artistName: "Mr. Fingers", genreNames: ["House"],
    }], next: null })),
    similarArtists: vi.fn(async () => ({ items: [{
      id: "3001", name: "Frankie Knuckles", genreNames: ["House"],
    }], next: null })),
    ...overrides,
  };
}

describe("durable Apple catalog discovery cache", () => {
  test("fingerprints canonical inputs and retains the five-request MusicBrainz policy cap", () => {
    expect(appleCatalogRequestFingerprint({ b: 2, a: ["x", "y"] }))
      .toBe(appleCatalogRequestFingerprint({ a: ["x", "y"], b: 2 }));
    expect(PIPELINE_V2_MUSICBRAINZ_MAX_UNCACHED_REQUESTS).toBe(5);
  });

  test("persists a miss, serves a hit, and isolates storefronts", async () => {
    const repository = new MemoryCacheRepository();
    const upstream = provider();
    const cached = createCachedCatalogDiscoveryProvider(repository, "run-1", upstream);

    await expect(cached.search("US", "house", ["songs"], 25)).resolves.toMatchObject({ songs: [song] });
    await expect(cached.search("us", "house", ["songs"], 25)).resolves.toMatchObject({ songs: [song] });
    await expect(cached.search("gb", "house", ["songs"], 25)).resolves.toMatchObject({ songs: [song] });

    expect(upstream.search).toHaveBeenCalledTimes(2);
    expect(repository.entries.size).toBe(2);
    expect(repository.events.map(({ storefront, cacheState, providerState }) => ({
      storefront, cacheState, providerState,
    }))).toEqual([
      { storefront: "us", cacheState: "miss", providerState: "success" },
      { storefront: "us", cacheState: "hit", providerState: "skipped" },
      { storefront: "gb", cacheState: "miss", providerState: "success" },
    ]);
  });

  test("applies seven-day, 24-hour, and six-hour TTLs by resource class", async () => {
    const repository = new MemoryCacheRepository();
    const instant = new Date("2026-07-19T12:00:00.000Z");
    const cached = createCachedCatalogDiscoveryProvider(repository, "run-ttl", provider(), { now: () => instant });

    await cached.search("us", "house", ["songs"], 25);
    await cached.albumTracks("us", "2001", null);
    await cached.artistTopSongs("us", "3001", null);
    await cached.playlistTracks("us", "pl.house", null);

    const ttlByKind = new Map([...repository.entries.values()].map((entry) => [
      entry.resourceKind,
      Date.parse(entry.expiresAt) - Date.parse(entry.fetchedAt),
    ]));
    expect(ttlByKind).toEqual(new Map([
      ["search_view", APPLE_CATALOG_CACHE_TTL_MS.search_view],
      ["catalog_resource", APPLE_CATALOG_CACHE_TTL_MS.catalog_resource],
      ["artist_view", APPLE_CATALOG_CACHE_TTL_MS.artist_view],
      ["playlist_membership", APPLE_CATALOG_CACHE_TTL_MS.playlist_membership],
    ]));
  });

  test("refreshes expired entries and records stale provider telemetry", async () => {
    const repository = new MemoryCacheRepository();
    const upstream = provider();
    let instant = new Date("2026-07-19T12:00:00.000Z");
    const cached = createCachedCatalogDiscoveryProvider(repository, "run-stale", upstream, { now: () => instant });
    await cached.playlistTracks("us", "pl.house", null);
    instant = new Date(instant.getTime() + APPLE_CATALOG_CACHE_TTL_MS.playlist_membership + 1);
    await cached.playlistTracks("us", "pl.house", null);

    expect(upstream.playlistTracks).toHaveBeenCalledTimes(2);
    expect(repository.events.at(-1)).toMatchObject({
      cacheState: "stale",
      providerState: "success",
      resourceKind: "playlist_membership",
    });
  });

  test("treats malformed cached payload as a miss and repairs it from Apple", async () => {
    const repository = new MemoryCacheRepository();
    const upstream = provider();
    const fingerprint = appleCatalogRequestFingerprint({
      operation: "search", query: "house", types: ["songs"], limit: 25, cursor: null,
    });
    repository.entries.set(key("us", "search_view", fingerprint), {
      storefront: "us",
      resourceKind: "search_view",
      requestFingerprint: fingerprint,
      payload: { songs: "not-an-array" },
      fetchedAt: "2026-07-19T11:00:00.000Z",
      expiresAt: "2026-07-20T11:00:00.000Z",
    });
    const cached = createCachedCatalogDiscoveryProvider(repository, "run-malformed", upstream, {
      now: () => new Date("2026-07-19T12:00:00.000Z"),
    });

    await expect(cached.search("us", "house", ["songs"], 25)).resolves.toMatchObject({ songs: [song] });
    expect(repository.deleted).toBe(1);
    expect(upstream.search).toHaveBeenCalledTimes(1);
    expect(repository.events).toContainEqual(expect.objectContaining({
      cacheState: "malformed",
      providerState: "success",
    }));
    expect(repository.entries.get(key("us", "search_view", fingerprint))?.payload)
      .toMatchObject({ songs: [song] });
  });

  test("never caches provider failures and persists the provider state", async () => {
    const repository = new MemoryCacheRepository();
    const failure = new Error("Apple unavailable");
    const upstream = provider({ search: vi.fn(async () => { throw failure; }) });
    const cached = createCachedCatalogDiscoveryProvider(repository, "run-failure", upstream);

    await expect(cached.search("us", "house", ["songs"], 25)).rejects.toBe(failure);
    expect(repository.entries.size).toBe(0);
    expect(repository.events).toContainEqual(expect.objectContaining({
      cacheState: "miss",
      providerState: "failure",
      detail: expect.objectContaining({ errorName: "Error" }),
    }));
  });

  test("persists the exact Apple request that opens the shared provider circuit", async () => {
    const repository = new MemoryCacheRepository();
    const failures = [
      new AppleApiError("Apple unavailable", 503, true),
      new AppleApiError("Apple unavailable", 503, true),
    ];
    const upstream = provider({
      search: vi.fn(async () => { throw failures.shift()!; }),
    });
    const control = new AppleProviderControl({
      transientFailureThreshold: 2,
      circuitCooldownMs: 4_000,
      recoverySuccesses: 100,
    });
    const controlled = createControlledCatalogDiscoveryProvider(upstream, control);
    const cached = createCachedCatalogDiscoveryProvider(repository, "run-circuit", controlled);

    await expect(cached.search("us", "house one", ["songs"], 25)).rejects.toMatchObject({ status: 503 });
    await expect(cached.search("us", "house two", ["songs"], 25)).rejects.toMatchObject({ status: 503 });

    expect(repository.events.map(({ providerState }) => providerState)).toEqual([
      "failure",
      "circuit_open",
    ]);
    expect(repository.events[1]).toMatchObject({
      runId: "run-circuit",
      storefront: "us",
      providerState: "circuit_open",
      detail: {
        errorName: "AppleApiError",
        reasonCode: "apple_provider_circuit_open",
      },
    });
  });

  test("coalesces the same cache miss across workers into one Apple request", async () => {
    const shared = {
      entries: new Map<string, AppleCatalogCacheEntry>(),
      events: [] as AppleCatalogCacheEvent[],
      leases: new Map<string, { ownerId: string; expiresAt: number }>(),
    };
    const firstRepository = new MemoryCacheRepository(shared);
    const secondRepository = new MemoryCacheRepository(shared);
    let releaseUpstream!: () => void;
    const waitForUpstream = new Promise<void>((resolve) => { releaseUpstream = resolve; });
    const upstreamSearch = vi.fn(async () => {
      await waitForUpstream;
      return { songs: [song], artists: [], albums: [], playlists: [] };
    });
    const upstream = provider({ search: upstreamSearch });
    const first = createCachedCatalogDiscoveryProvider(firstRepository, "run-worker-1", upstream, {
      coalescingPollMs: 10,
      coalescingWaitMs: 5_000,
    });
    const second = createCachedCatalogDiscoveryProvider(secondRepository, "run-worker-2", upstream, {
      coalescingPollMs: 10,
      coalescingWaitMs: 5_000,
    });

    const firstResult = first.search("us", "house", ["songs"], 25);
    await vi.waitFor(() => expect(upstreamSearch).toHaveBeenCalledOnce());
    const secondResult = second.search("us", "house", ["songs"], 25);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(upstreamSearch).toHaveBeenCalledOnce();
    releaseUpstream();

    await expect(Promise.all([firstResult, secondResult])).resolves.toEqual([
      expect.objectContaining({ songs: [song] }),
      expect.objectContaining({ songs: [song] }),
    ]);
    expect(upstreamSearch).toHaveBeenCalledOnce();
    expect(shared.events).toContainEqual(expect.objectContaining({
      runId: "run-worker-2",
      cacheState: "coalesced",
      providerState: "skipped",
    }));
  });

  test("takes over an expired miss lease and cleans abandoned lease rows", async () => {
    const repository = new MemoryCacheRepository();
    const fingerprint = appleCatalogRequestFingerprint({
      operation: "search", query: "house", types: ["songs"], limit: 25, cursor: null,
    });
    repository.leases.set(key("us", "search_view", fingerprint), {
      ownerId: "expired-owner",
      expiresAt: Date.now() - 1,
    });

    const cached = createCachedCatalogDiscoveryProvider(repository, "run-expired-lease", provider());
    await expect(cached.search("us", "house", ["songs"], 25)).resolves.toMatchObject({ songs: [song] });
    expect(repository.leases.size).toBe(0);

    repository.leases.set("expired-1", { ownerId: "one", expiresAt: Date.now() - 10 });
    repository.leases.set("expired-2", { ownerId: "two", expiresAt: Date.now() - 10 });
    repository.leases.set("live", { ownerId: "three", expiresAt: Date.now() + 10_000 });
    await expect(repository.cleanupExpiredAppleCatalogCacheLeases(1)).resolves.toBe(1);
    expect(repository.leases.size).toBe(2);
    await expect(repository.cleanupExpiredAppleCatalogCacheLeases()).resolves.toBe(1);
    expect([...repository.leases.keys()]).toEqual(["live"]);
  });

  test("fails open when cache persistence is unavailable", async () => {
    const repository = new MemoryCacheRepository();
    repository.getAppleCatalogCacheEntry = vi.fn(async () => { throw new Error("database cache read failed"); });
    repository.putAppleCatalogCacheEntry = vi.fn(async () => { throw new Error("database cache write failed"); });
    repository.recordAppleCatalogCacheEvent = vi.fn(async () => { throw new Error("telemetry failed"); });
    const upstream = provider();
    const cached = createCachedCatalogDiscoveryProvider(repository, "run-cache-outage", upstream);

    await expect(cached.search("us", "house", ["songs"], 25)).resolves.toMatchObject({ songs: [song] });
    expect(upstream.search).toHaveBeenCalledTimes(1);
  });
});
