import { describe, expect, test } from "vitest";
import type { CatalogSong } from "../shared/types.ts";
import { AppleApiError, AppleAuthorizationRequiredError } from "../server/apple.ts";
import {
  boundedCatalogConcurrency,
  CATALOG_DISCOVERY_PROGRESS_VERSION,
  catalogDiscoverySizePolicy,
  classifyCatalogProviderFailure,
  discoverCuratedAppleCatalog,
  isSafeAppleCatalogCursor,
  scheduleCatalogTasks,
  type CatalogDiscoveryProgressSnapshot,
  type CatalogDiscoveryProvider,
} from "../server/catalog-discovery-v2.ts";
import {
  AppleProviderControl,
  createControlledCatalogDiscoveryProvider,
} from "../server/apple-provider-control.ts";

function song(index: number): CatalogSong {
  return {
    id: String(1_000 + index),
    name: `Track ${index}`,
    artistName: `Artist ${index}`,
    albumName: `Album ${index}`,
    isrc: `USAAA260${String(index).padStart(4, "0")}`,
  };
}

function provider(overrides: Partial<CatalogDiscoveryProvider> = {}): CatalogDiscoveryProvider {
  return {
    search: async () => ({ songs: [], artists: [], albums: [], playlists: [] }),
    playlistTracks: async () => ({ items: [], next: null }),
    albumTracks: async () => ({ items: [], next: null }),
    artistTopSongs: async () => ({ items: [], next: null }),
    artistAlbums: async () => ({ items: [], next: null }),
    similarArtists: async () => ({ items: [], next: null }),
    ...overrides,
  };
}

describe("Pipeline V2 curated Apple catalog discovery", () => {
  test("the scheduler stays within 2-8 workers and preserves task order", async () => {
    expect(boundedCatalogConcurrency(-10)).toBe(2);
    expect(boundedCatalogConcurrency(100)).toBe(8);
    expect(boundedCatalogConcurrency(Number.NaN)).toBe(6);
    let active = 0;
    let maximumActive = 0;
    const result = await scheduleCatalogTasks(
      Array.from({ length: 24 }, (_, index) => index),
      100,
      async (value) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return value * 2;
      },
    );
    expect(maximumActive).toBe(8);
    expect(result).toEqual(Array.from({ length: 24 }, (_, index) => index * 2));
  });

  test.each([
    [25, 25, 30_000, 4, 48],
    [50, 50, 45_000, 5, 80],
    [100, 100, 90_000, 6, 140],
    [200, 200, 180_000, 8, 260],
    [300, 300, 300_000, 10, 400],
    [301, 500, 450_000, 17, 667],
    [1_000, 1_000, 900_000, 34, 1_334],
  ] as const)("target %i selects the immutable %i-track discovery tier", (target, tier, deadlineMs, pages, calls) => {
    expect(catalogDiscoverySizePolicy(target)).toEqual({
      policyVersion: "relevance_first_2026_07_r2",
      tier,
      deadlineMs,
      maxPagesPerStrategy: pages,
      maxTotalProviderCalls: calls,
    });
    expect(Object.isFrozen(catalogDiscoverySizePolicy(target))).toBe(true);
  });

  test("retains immutable catalog limits for resumable pre-r2 runs", () => {
    expect(catalogDiscoverySizePolicy(50, "relevance_first_2026_07")).toEqual({
      policyVersion: "relevance_first_2026_07",
      tier: 50,
      deadlineMs: 45_000,
      maxPagesPerStrategy: 5,
      maxTotalProviderCalls: 80,
    });
    expect(Object.isFrozen(catalogDiscoverySizePolicy(50, "relevance_first_2026_07"))).toBe(true);
  });

  test.each([25, 50, 100, 200, 300] as const)(
    "target tier %i seeds adaptive planning from existing qualified and attempted counts",
    async (target) => {
      let calls = 0;
      const reserve = Math.max(5, Math.ceil(target * 0.1));
      const initialQualifiedCount = target + reserve;
      const initialAttemptedCount = initialQualifiedCount * 2;
      const result = await discoverCuratedAppleCatalog(provider({
        search: async () => {
          calls += 1;
          return { songs: [song(1)], artists: [], albums: [], playlists: [] };
        },
      }), {
        storefront: "us",
        query: "already filled",
        target,
        concurrency: 6,
        initialQualifiedCount,
        initialAttemptedCount,
        evaluate: () => ({ eligible: true, scopeBindingRefs: ["scope:1"], reasonCode: "qualified" }),
      });
      expect(calls).toBe(0);
      expect(result.totalQualifiedCount).toBe(initialQualifiedCount);
      expect(result.totalAttemptedCount).toBe(initialAttemptedCount);
      expect(result.stoppedBecause).toBe("target_and_reserve");
    },
  );

  test("stops at target plus the policy reserve when evidence bindings qualify Apple identities", async () => {
    const catalog = Array.from({ length: 12 }, (_, index) => song(index + 1));
    let searchCalls = 0;
    const result = await discoverCuratedAppleCatalog(provider({
      search: async () => {
        searchCalls += 1;
        return { songs: catalog, artists: [], albums: [], playlists: [] };
      },
    }), {
      storefront: "US",
      query: "documented scene",
      target: 5,
      concurrency: 6,
      evaluate: (_item, context) => ({
        eligible: true,
        scopeBindingRefs: [`source:${context.query}`],
        reasonCode: "track_scope_binding",
      }),
    });

    expect(result.reserve).toBe(5);
    expect(result.qualifiedGoal).toBe(10);
    expect(result.qualified).toHaveLength(12);
    expect(result.stoppedBecause).toBe("target_and_reserve");
    expect(searchCalls).toBe(1);
  });

  test("Apple catalog identity alone never becomes relevance evidence", async () => {
    const result = await discoverCuratedAppleCatalog(provider({
      search: async () => ({ songs: [song(1), song(2)], artists: [], albums: [], playlists: [] }),
    }), {
      storefront: "us",
      query: "house music",
      target: 1,
      concurrency: 2,
      evaluate: () => ({ eligible: true, scopeBindingRefs: [], reasonCode: "apple_search_hit" }),
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.qualified).toHaveLength(0);
    expect(result.candidates.every((candidate) => candidate.reasonCodes.includes("missing_scope_binding"))).toBe(true);
    expect(result.stoppedBecause).toBe("frontier_exhausted");
  });

  test("lossy display slugs never collapse distinct multilingual search aliases", async () => {
    const queries: string[] = [];
    await discoverCuratedAppleCatalog(provider({
      search: async (_storefront, query) => {
        queries.push(query);
        return { songs: [], artists: [], albums: [], playlists: [] };
      },
    }), {
      storefront: "us",
      query: "café",
      aliases: ["cafe"],
      target: 25,
      concurrency: 2,
      evaluate: () => ({ eligible: false, scopeBindingRefs: [], reasonCode: "none" }),
    });

    expect(queries).toEqual(["café", "cafe"]);
  });

  test("failed or malformed track evaluations are isolated without discarding valid siblings", async () => {
    const result = await discoverCuratedAppleCatalog(provider({
      search: async () => ({ songs: [song(1), song(2), song(3)], artists: [], albums: [], playlists: [] }),
    }), {
      storefront: "us",
      query: "mixed evaluator output",
      target: 25,
      concurrency: 2,
      evaluate(item) {
        if (item.id === song(1).id) throw new TypeError("malformed evidence row");
        if (item.id === song(2).id) return { eligible: "yes", scopeBindingRefs: [null], reasonCode: "" } as never;
        return { eligible: true, scopeBindingRefs: ["binding:2"], reasonCode: "qualified" };
      },
    });

    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.find((candidate) => candidate.song.id === song(1).id)).toMatchObject({
      eligible: false,
      reasonCodes: ["eligibility_evaluation_failed"],
    });
    expect(result.candidates.find((candidate) => candidate.song.id === song(2).id)).toMatchObject({
      eligible: false,
      reasonCodes: ["eligibility_evaluation_invalid"],
    });
    expect(result.qualified.map((candidate) => candidate.song.id)).toEqual([song(3).id]);
  });

  test("later container pages enrich a duplicate Apple identity before matching", async () => {
    const sparse = { ...song(1), albumName: "", isrc: undefined, genreNames: ["Music"] };
    const enriched = { ...song(1), albumName: "Canonical Album", genreNames: ["House"], releaseDate: "1992-01-01" };
    const result = await discoverCuratedAppleCatalog(provider({
      search: async () => ({ songs: [sparse], artists: [], albums: [], playlists: [] }),
      playlistTracks: async () => ({ items: [enriched], next: null }),
    }), {
      storefront: "us",
      query: "metadata enrichment",
      target: 25,
      concurrency: 2,
      scopedPlaylists: [{ id: "pl.enrichment", scopeBindingRefs: ["binding:trusted"] }],
      evaluate(_item, context) {
        return context.containerType === "playlist"
          ? { eligible: true, scopeBindingRefs: [], reasonCode: "qualified" }
          : { eligible: false, scopeBindingRefs: [], reasonCode: "unbound_search" };
      },
    });

    expect(result.qualified).toHaveLength(1);
    expect(result.qualified[0]!.song).toMatchObject({
      id: song(1).id,
      albumName: "Canonical Album",
      releaseDate: "1992-01-01",
      isrc: song(1).isrc,
    });
    expect(new Set(result.qualified[0]!.song.genreNames)).toEqual(new Set(["Music", "House"]));
  });

  test("artist and album expansion discovers identities but never qualifies unsupported whole-album tracks", async () => {
    const result = await discoverCuratedAppleCatalog(provider({
      search: async () => ({
        songs: [],
        artists: [{ id: "artist-1", name: "Seed Artist", genreNames: ["House"] }],
        albums: [{ id: "album-1", name: "Seed Album", artistName: "Seed Artist", genreNames: ["House"] }],
        playlists: [],
      }),
      artistTopSongs: async () => ({ items: [song(1)], next: null }),
      artistAlbums: async (_storefront, _artistId, view) => ({
        items: [{ id: `album-${view}`, name: view, artistName: "Seed Artist", genreNames: ["House"] }],
        next: null,
      }),
      albumTracks: async (_storefront, albumId) => ({
        items: [song(albumId.length + 10)],
        next: null,
      }),
      similarArtists: async () => ({ items: [], next: null }),
    }), {
      storefront: "us",
      query: "house music",
      target: 25,
      concurrency: 4,
      evaluate: (_item, context) => ({
        // Artist/album genre metadata may seed discovery, but it is not an
        // exact-track binding and therefore must not expand eligibility.
        eligible: context.strategyKind === "seed_artist_top_songs"
          || context.strategyKind === "selected_album_tracks",
        scopeBindingRefs: context.inheritedScopeBindingRefs,
        reasonCode: "artist_or_album_metadata_only",
      }),
    });

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.qualified).toEqual([]);
    expect(result.candidates.every((candidate) => (
      candidate.reasonCodes.includes("missing_scope_binding")
    ))).toBe(true);
  });

  test("catalog rediscovery cannot erase trusted bindings from a selected album", async () => {
    const result = await discoverCuratedAppleCatalog(provider({
      search: async () => ({
        songs: [],
        artists: [],
        albums: [{ id: "album-bound", name: "Bound Album", artistName: "Artist", genreNames: [] }],
        playlists: [],
      }),
      albumTracks: async (_storefront, albumId) => ({
        items: albumId === "album-bound" ? [song(1)] : [],
        next: null,
      }),
    }), {
      storefront: "us",
      query: "bound album",
      target: 25,
      concurrency: 2,
      selectedAlbums: [{ id: "album-bound", scopeBindingRefs: ["binding:album"] }],
      evaluate(_item, context) {
        return {
          eligible: context.inheritedScopeBindingRefs.includes("binding:album"),
          scopeBindingRefs: [],
          reasonCode: "trusted_album_track",
        };
      },
    });

    expect(result.qualified.map((candidate) => candidate.song.id)).toEqual([song(1).id]);
    expect(result.qualified[0]!.scopeBindingRefs).toContain("binding:album");
  });

  test("trusted container bindings remain external and can qualify exact playlist members", async () => {
    const result = await discoverCuratedAppleCatalog(provider({
      playlistTracks: async () => ({ items: Array.from({ length: 6 }, (_, index) => song(index + 1)), next: null }),
    }), {
      storefront: "us",
      query: "specialist history",
      target: 1,
      concurrency: 4,
      scopedPlaylists: [{ id: "pl.trusted", scopeBindingRefs: ["source-record:42"] }],
      evaluate: (_item, context) => ({
        eligible: context.inheritedScopeBindingRefs.includes("source-record:42"),
        scopeBindingRefs: [],
        reasonCode: "trusted_scoped_membership",
      }),
    });

    expect(result.qualified).toHaveLength(6);
    expect(result.qualified[0]?.scopeBindingRefs).toEqual(["source-record:42"]);
  });

  test("trusted editorial playlists discovered during a deficit search are enumerated in Round D", async () => {
    const playlistCalls: string[] = [];
    const result = await discoverCuratedAppleCatalog(provider({
      search: async (_storefront, query) => ({
        songs: [],
        artists: [],
        albums: [],
        playlists: query === "american drill deficit"
          ? [{
              id: "pl.deficit",
              name: "American Drill",
              curatorName: "Apple Music Hip-Hop",
              description: "American drill across regional scenes",
            }]
          : [],
      }),
      playlistTracks: async (_storefront, playlistId) => {
        playlistCalls.push(playlistId);
        return { items: Array.from({ length: 6 }, (_, index) => song(index + 1)), next: null };
      },
    }), {
      storefront: "us",
      query: "seed without results",
      deficitQueries: ["american drill deficit"],
      target: 1,
      concurrency: 4,
      trustDiscoveredPlaylist(playlist) {
        return playlist.id === "pl.deficit" ? ["source-record:deficit-playlist"] : null;
      },
      evaluate: (_item, context) => ({
        eligible: context.inheritedScopeBindingRefs.includes("source-record:deficit-playlist"),
        scopeBindingRefs: [],
        reasonCode: "trusted_scoped_membership",
      }),
    });

    expect(playlistCalls).toEqual(["pl.deficit"]);
    expect(result.qualified).toHaveLength(6);
    expect(result.frontier).toContainEqual(expect.objectContaining({
      id: "D:trusted-playlist:pl-deficit",
      round: "D",
      kind: "trusted_scoped_playlist",
      status: "complete",
    }));
  });

  test("enumerates a newly trusted playlist before remaining direct searches", async () => {
    const calls: string[] = [];
    const result = await discoverCuratedAppleCatalog(provider({
      search: async (_storefront, query) => {
        calls.push(`search:${query}`);
        return {
          songs: [],
          artists: [],
          albums: [],
          playlists: query === "house music"
            ? [{
                id: "pl.house",
                name: "Classic House Essentials",
                curatorName: "Apple Music Dance",
                description: "Foundational house records",
              }]
            : [],
        };
      },
      playlistTracks: async (_storefront, playlistId) => {
        calls.push(`playlist:${playlistId}`);
        return { items: Array.from({ length: 6 }, (_, index) => song(index + 1)), next: null };
      },
    }), {
      storefront: "us",
      query: "house music",
      aliases: ["classic house", "Chicago house", "deep house"],
      target: 1,
      concurrency: 4,
      trustDiscoveredPlaylist(playlist) {
        return playlist.id === "pl.house" ? ["source-record:classic-house"] : null;
      },
      evaluate: (_item, context) => ({
        eligible: context.inheritedScopeBindingRefs.includes("source-record:classic-house"),
        scopeBindingRefs: [],
        reasonCode: "trusted_scoped_membership",
      }),
    });

    expect(calls).toEqual(["search:house music", "playlist:pl.house"]);
    expect(result.qualified).toHaveLength(6);
    expect(result.stoppedBecause).toBe("target_and_reserve");
  });

  test("sizes each adaptive discovery wave for Apple's 25-result search pages", async () => {
    let activeSearches = 0;
    let maximumActiveSearches = 0;
    const result = await discoverCuratedAppleCatalog(provider({
      search: async () => {
        activeSearches += 1;
        maximumActiveSearches = Math.max(maximumActiveSearches, activeSearches);
        await new Promise((resolve) => setTimeout(resolve, 2));
        activeSearches -= 1;
        return { songs: [], artists: [], albums: [], playlists: [] };
      },
    }), {
      storefront: "us",
      query: "primary",
      aliases: ["alias one", "alias two", "alias three"],
      target: 25,
      concurrency: 8,
      maxTotalProviderCalls: 3,
      evaluate: () => ({ eligible: false, scopeBindingRefs: [], reasonCode: "none" }),
    });

    // A cold 25-track target needs 60 raw discoveries including reserve.
    // At 25 Apple resources per page, the first bounded wave is three calls.
    expect(maximumActiveSearches).toBe(3);
    expect(result.providerCallCount).toBe(3);
    expect(result.stoppedBecause).toBe("provider_call_limit");
  });

  test("two zero-yield pages exhaust a strategy and unsafe cursors never reach the provider", async () => {
    let safeCalls = 0;
    const safe = await discoverCuratedAppleCatalog(provider({
      playlistTracks: async (_storefront, _id, cursor) => {
        safeCalls += 1;
        return cursor
          ? { items: [], next: "/v1/catalog/us/playlists/pl.scope/tracks?offset=200" }
          : { items: [], next: "/v1/catalog/us/playlists/pl.scope/tracks?offset=100" };
      },
    }), {
      storefront: "us",
      query: "narrow",
      target: 25,
      concurrency: 4,
      maxPagesPerStrategy: 8,
      scopedPlaylists: [{ id: "pl.scope", scopeBindingRefs: ["binding:1"] }],
      evaluate: () => ({ eligible: false, scopeBindingRefs: [], reasonCode: "not_supported" }),
    });
    expect(safeCalls).toBe(2);
    expect(safe.frontier).toContainEqual(expect.objectContaining({
      round: "D",
      kind: "deep_pagination",
      status: "exhausted",
      zeroYieldPages: 2,
      lastReasonCode: "two_zero_yield_pages",
    }));
    expect(safe.stoppedBecause).toBe("zero_yield_exhausted");

    let maliciousCalls = 0;
    const malicious = await discoverCuratedAppleCatalog(provider({
      playlistTracks: async () => {
        maliciousCalls += 1;
        return { items: [], next: "https://attacker.invalid/steal" };
      },
    }), {
      storefront: "us",
      query: "narrow",
      target: 25,
      concurrency: 4,
      scopedPlaylists: [{ id: "pl.scope", scopeBindingRefs: ["binding:1"] }],
      evaluate: () => ({ eligible: false, scopeBindingRefs: [], reasonCode: "not_supported" }),
    });
    expect(maliciousCalls).toBe(1);
    expect(malicious.frontier).toContainEqual(expect.objectContaining({
      round: "D",
      status: "invalid_cursor",
      lastReasonCode: "invalid_cursor",
    }));
  });

  test("cursor validation requires an exact container path boundary", () => {
    expect(isSafeAppleCatalogCursor("us", {
      resourceKind: "playlist",
      resourceId: "pl.scope",
      artistAlbumView: null,
      query: "scope",
      searchTypes: [],
    }, "/v1/catalog/us/playlists/pl.scope/tracks?offset=100")).toBe(true);
    expect(isSafeAppleCatalogCursor("us", {
      resourceKind: "playlist",
      resourceId: "pl.scope",
      artistAlbumView: null,
      query: "scope",
      searchTypes: [],
    }, "/v1/catalog/us/playlists/pl.scope/tracks-evil?offset=100")).toBe(false);
  });

  test("returns typed budget, deadline, degraded-provider, and policy stop reasons", async () => {
    const budget = await discoverCuratedAppleCatalog(provider(), {
      storefront: "us",
      query: "budget",
      aliases: ["second budget query"],
      target: 25,
      concurrency: 2,
      maxTotalProviderCalls: 1,
      evaluate: () => ({ eligible: false, scopeBindingRefs: [], reasonCode: "not_supported" }),
    });
    expect(budget.stoppedBecause).toBe("provider_call_limit");
    expect(budget.roundsCompleted).toEqual([]);

    const deadline = new AbortController();
    deadline.abort(new DOMException("deadline", "AbortError"));
    const timedOut = await discoverCuratedAppleCatalog(provider(), {
      storefront: "us",
      query: "deadline",
      target: 25,
      concurrency: 2,
      signal: deadline.signal,
      deadlineSignal: deadline.signal,
      evaluate: () => ({ eligible: false, scopeBindingRefs: [], reasonCode: "not_supported" }),
    });
    expect(timedOut.stoppedBecause).toBe("timed_out");

    const degraded = await discoverCuratedAppleCatalog(provider({
      search: async () => { throw new AppleApiError("temporary", 503, true); },
    }), {
      storefront: "us",
      query: "degraded",
      target: 25,
      concurrency: 2,
      evaluate: () => ({ eligible: false, scopeBindingRefs: [], reasonCode: "not_supported" }),
    });
    expect(degraded.stoppedBecause).toBe("provider_degraded");

    const policy = await discoverCuratedAppleCatalog(provider({
      search: async () => ({ songs: [song(1)], artists: [], albums: [], playlists: [] }),
    }), {
      storefront: "us",
      query: "studio versions only",
      target: 25,
      concurrency: 2,
      evaluate: () => ({
        eligible: false,
        scopeBindingRefs: ["binding:version"],
        reasonCode: "version_policy_conflict",
      }),
    });
    expect(policy.stoppedBecause).toBe("policy_conflict");
  });

  test("distinguishes a provider circuit opening from generic degradation", async () => {
    const controlled = createControlledCatalogDiscoveryProvider(provider({
      search: async () => { throw new AppleApiError("temporary", 503, true); },
    }), new AppleProviderControl({
      initialConcurrency: 1,
      minimumConcurrency: 1,
      maximumConcurrency: 1,
      transientFailureThreshold: 2,
      circuitCooldownMs: 1_000,
    }));
    const result = await discoverCuratedAppleCatalog(controlled, {
      storefront: "us",
      query: "first circuit query",
      aliases: ["second circuit query"],
      target: 25,
      concurrency: 2,
      evaluate: () => ({ eligible: false, scopeBindingRefs: [], reasonCode: "not_supported" }),
    });
    expect(result.stoppedBecause).toBe("provider_circuit_open");
    expect(result.frontier).toContainEqual(expect.objectContaining({
      lastReasonCode: "apple_provider_circuit_open",
      retryable: true,
    }));
  });

  test("a transient page failure resumes from the persisted cursor instead of page one", async () => {
    const firstCursors: Array<string | null> = [];
    const first = await discoverCuratedAppleCatalog(provider({
      playlistTracks: async (_storefront, _id, cursor) => {
        firstCursors.push(cursor);
        if (cursor) throw new AppleApiError("temporary", 503, true);
        return {
          items: [song(1)],
          next: "/v1/catalog/us/playlists/pl.resume/tracks?offset=100",
        };
      },
    }), {
      storefront: "us",
      query: "resume",
      target: 25,
      concurrency: 2,
      scopedPlaylists: [{ id: "pl.resume", scopeBindingRefs: ["binding:resume"] }],
      evaluate: () => ({ eligible: true, scopeBindingRefs: [], reasonCode: "trusted" }),
    });
    expect(firstCursors).toEqual([null, "/v1/catalog/us/playlists/pl.resume/tracks?offset=100"]);
    expect(first.frontier).toContainEqual(expect.objectContaining({
      round: "D",
      cursor: "/v1/catalog/us/playlists/pl.resume/tracks?offset=100",
      status: "failed",
      retryable: true,
      lastReasonCode: "apple_server_error",
    }));

    const resumedCursors: Array<string | null> = [];
    const resumed = await discoverCuratedAppleCatalog(provider({
      playlistTracks: async (_storefront, _id, cursor) => {
        resumedCursors.push(cursor);
        return { items: [song(2)], next: null };
      },
    }), {
      storefront: "us",
      query: "resume",
      target: 25,
      concurrency: 2,
      resumeFrontier: first.frontier,
      initialQualifiedCount: first.totalQualifiedCount,
      initialAttemptedCount: first.totalAttemptedCount,
      scopedPlaylists: [{ id: "pl.resume", scopeBindingRefs: ["binding:resume"] }],
      evaluate: () => ({ eligible: true, scopeBindingRefs: [], reasonCode: "trusted" }),
    });
    expect(resumedCursors).toEqual(["/v1/catalog/us/playlists/pl.resume/tracks?offset=100"]);
    expect(resumed.totalQualifiedCount).toBe(2);
  });

  test("emits one versioned checkpoint per applied page with monotonic sequence and counters", async () => {
    const checkpoints: CatalogDiscoveryProgressSnapshot[] = [];
    const result = await discoverCuratedAppleCatalog(provider({
      search: async () => ({ songs: [song(1)], artists: [], albums: [], playlists: [] }),
      playlistTracks: async () => ({ items: [song(2)], next: null }),
    }), {
      storefront: "us",
      query: "checkpointed discovery",
      target: 25,
      concurrency: 2,
      scopedPlaylists: [{ id: "pl.checkpoint", scopeBindingRefs: ["binding:checkpoint"] }],
      evaluate: () => ({ eligible: true, scopeBindingRefs: ["binding:track"], reasonCode: "qualified" }),
      onCheckpoint(snapshot) {
        checkpoints.push(structuredClone(snapshot));
      },
    });

    expect(checkpoints).toHaveLength(result.providerCallCount);
    expect(checkpoints.map((snapshot) => snapshot.sequence)).toEqual(
      checkpoints.map((_, index) => index + 1),
    );
    expect(checkpoints.every((snapshot) => snapshot.version === CATALOG_DISCOVERY_PROGRESS_VERSION)).toBe(true);
    for (let index = 1; index < checkpoints.length; index += 1) {
      expect(checkpoints[index]!.providerCallCount).toBeGreaterThanOrEqual(checkpoints[index - 1]!.providerCallCount);
      expect(checkpoints[index]!.totalAttemptedCount).toBeGreaterThanOrEqual(checkpoints[index - 1]!.totalAttemptedCount);
      expect(checkpoints[index]!.totalQualifiedCount).toBeGreaterThanOrEqual(checkpoints[index - 1]!.totalQualifiedCount);
    }
    expect(result.progress.sequence).toBe(checkpoints.at(-1)!.sequence + 1);
    expect(result.progress.totalAttemptedCount).toBe(result.totalAttemptedCount);
    expect(result.progress.totalQualifiedCount).toBe(result.totalQualifiedCount);
    expect(result.progress.candidates.map((candidate) => candidate.song.id)).toEqual(
      result.candidates.map((candidate) => candidate.song.id),
    );
  });

  test("fails closed when durable checkpoint persistence rejects", async () => {
    let checkpointCalls = 0;
    await expect(discoverCuratedAppleCatalog(provider({
      search: async () => ({ songs: [song(1)], artists: [], albums: [], playlists: [] }),
    }), {
      storefront: "us",
      query: "checkpoint failure",
      target: 25,
      concurrency: 2,
      evaluate: () => ({ eligible: true, scopeBindingRefs: ["binding:1"], reasonCode: "qualified" }),
      onCheckpoint() {
        checkpointCalls += 1;
        throw new Error("durable write failed");
      },
    })).rejects.toThrow("durable write failed");
    expect(checkpointCalls).toBe(1);
  });

  test("restores completed pages and candidates without replaying the provider call", async () => {
    const first = await discoverCuratedAppleCatalog(provider({
      search: async () => ({ songs: [song(1)], artists: [], albums: [], playlists: [] }),
    }), {
      storefront: "us",
      query: "completed resume",
      target: 25,
      concurrency: 2,
      evaluate: () => ({ eligible: true, scopeBindingRefs: ["binding:1"], reasonCode: "qualified" }),
    });
    let replayedCalls = 0;
    const resumed = await discoverCuratedAppleCatalog(provider({
      search: async () => {
        replayedCalls += 1;
        return { songs: [song(99)], artists: [], albums: [], playlists: [] };
      },
    }), {
      storefront: "us",
      query: "completed resume",
      target: 25,
      concurrency: 2,
      resumeProgress: first.progress,
      evaluate: () => ({ eligible: true, scopeBindingRefs: ["binding:1"], reasonCode: "qualified" }),
    });

    expect(replayedCalls).toBe(0);
    expect(resumed.candidates.map((candidate) => candidate.song.id)).toEqual([song(1).id]);
    expect(resumed.totalAttemptedCount).toBe(first.totalAttemptedCount);
    expect(resumed.totalQualifiedCount).toBe(first.totalQualifiedCount);
    expect(resumed.progress.sequence).toBe(first.progress.sequence + 1);
  });

  test("resumes an interrupted paginated frontier from its durable cursor with prior candidates", async () => {
    let durableSnapshot: CatalogDiscoveryProgressSnapshot | null = null;
    await expect(discoverCuratedAppleCatalog(provider({
      search: async () => ({ songs: [], artists: [], albums: [], playlists: [] }),
      playlistTracks: async (_storefront, _id, cursor) => ({
        items: [song(cursor ? 2 : 1)],
        next: cursor ? null : "/v1/catalog/us/playlists/pl.durable/tracks?offset=100",
      }),
    }), {
      storefront: "us",
      query: "durable cursor",
      target: 25,
      concurrency: 2,
      scopedPlaylists: [{ id: "pl.durable", scopeBindingRefs: ["binding:durable"] }],
      evaluate: () => ({ eligible: true, scopeBindingRefs: [], reasonCode: "qualified" }),
      onCheckpoint(snapshot) {
        const playlist = snapshot.frontier.find((item) => item.id === "A:trusted-playlist:pl-durable");
        if (playlist?.pagesAttempted === 1) {
          durableSnapshot = structuredClone(snapshot);
          throw new Error("worker interrupted after durable page");
        }
      },
    })).rejects.toThrow("worker interrupted after durable page");
    expect(durableSnapshot).not.toBeNull();

    const cursors: Array<string | null> = [];
    const resumed = await discoverCuratedAppleCatalog(provider({
      search: async () => {
        throw new Error("completed search page must not replay");
      },
      playlistTracks: async (_storefront, _id, cursor) => {
        cursors.push(cursor);
        return { items: [song(2)], next: null };
      },
    }), {
      storefront: "us",
      query: "durable cursor",
      target: 25,
      concurrency: 2,
      scopedPlaylists: [{ id: "pl.durable", scopeBindingRefs: ["binding:durable"] }],
      resumeProgress: durableSnapshot!,
      evaluate: () => ({ eligible: true, scopeBindingRefs: [], reasonCode: "qualified" }),
    });

    expect(cursors).toEqual(["/v1/catalog/us/playlists/pl.durable/tracks?offset=100"]);
    expect(resumed.candidates.map((candidate) => candidate.song.id)).toEqual([song(1).id, song(2).id]);
    expect(resumed.totalQualifiedCount).toBe(2);
  });

  test("restores dynamically discovered seed resources without replaying their completed search page", async () => {
    let durableSnapshot: CatalogDiscoveryProgressSnapshot | null = null;
    await expect(discoverCuratedAppleCatalog(provider({
      search: async () => ({
        songs: [],
        artists: [{ id: "artist-201", name: "Durable Seed", genreNames: [] }],
        albums: [],
        playlists: [],
      }),
    }), {
      storefront: "us",
      query: "durable seed",
      target: 25,
      concurrency: 2,
      evaluate: () => ({ eligible: false, scopeBindingRefs: [], reasonCode: "none" }),
      onCheckpoint(snapshot) {
        durableSnapshot = structuredClone(snapshot);
        throw new Error("worker interrupted after seed discovery");
      },
    })).rejects.toThrow("worker interrupted after seed discovery");
    expect((durableSnapshot as CatalogDiscoveryProgressSnapshot | null)?.seedArtists)
      .toEqual([{ id: "artist-201", name: "Durable Seed" }]);

    let searchCalls = 0;
    let topSongCalls = 0;
    await discoverCuratedAppleCatalog(provider({
      search: async () => {
        searchCalls += 1;
        return { songs: [], artists: [], albums: [], playlists: [] };
      },
      artistTopSongs: async () => {
        topSongCalls += 1;
        return { items: [], next: null };
      },
    }), {
      storefront: "us",
      query: "durable seed",
      target: 25,
      concurrency: 2,
      resumeProgress: durableSnapshot!,
      evaluate: () => ({ eligible: false, scopeBindingRefs: [], reasonCode: "none" }),
    });

    expect(searchCalls).toBe(0);
    expect(topSongCalls).toBeGreaterThan(0);
  });

  test("rejects incompatible, ambiguous, or unbounded progress snapshots", async () => {
    const first = await discoverCuratedAppleCatalog(provider({
      search: async () => ({ songs: [song(1)], artists: [], albums: [], playlists: [] }),
    }), {
      storefront: "us",
      query: "bounded resume",
      target: 25,
      concurrency: 2,
      evaluate: () => ({ eligible: true, scopeBindingRefs: ["binding:1"], reasonCode: "qualified" }),
    });
    const wrongVersion = { ...first.progress, version: "catalog_discovery_progress_v0" };
    await expect(discoverCuratedAppleCatalog(provider(), {
      storefront: "us",
      query: "bounded resume",
      target: 25,
      concurrency: 2,
      resumeProgress: wrongVersion as CatalogDiscoveryProgressSnapshot,
      evaluate: () => ({ eligible: false, scopeBindingRefs: [], reasonCode: "none" }),
    })).rejects.toThrow("Unsupported catalog discovery checkpoint version");

    await expect(discoverCuratedAppleCatalog(provider(), {
      storefront: "us",
      query: "bounded resume",
      target: 25,
      concurrency: 2,
      resumeProgress: first.progress,
      initialAttemptedCount: 1,
      evaluate: () => ({ eligible: false, scopeBindingRefs: [], reasonCode: "none" }),
    })).rejects.toThrow("cannot be mixed with legacy resume fields");

    const oversizedContexts = structuredClone(first.progress);
    oversizedContexts.candidates[0]!.contexts = Array.from(
      { length: 65 },
      (_, index) => ({ ...oversizedContexts.candidates[0]!.contexts[0]!, strategyId: `strategy-${index}` }),
    );
    await expect(discoverCuratedAppleCatalog(provider(), {
      storefront: "us",
      query: "bounded resume",
      target: 25,
      concurrency: 2,
      resumeProgress: oversizedContexts,
      evaluate: () => ({ eligible: false, scopeBindingRefs: [], reasonCode: "none" }),
    })).rejects.toThrow("checkpoint candidates are invalid");

    const malformedBindings = structuredClone(first.progress);
    malformedBindings.candidates[0]!.scopeBindingRefs = [null as unknown as string];
    await expect(discoverCuratedAppleCatalog(provider(), {
      storefront: "us",
      query: "bounded resume",
      target: 25,
      concurrency: 2,
      resumeProgress: malformedBindings,
      evaluate: () => ({ eligible: false, scopeBindingRefs: [], reasonCode: "none" }),
    })).rejects.toThrow("checkpoint candidates are invalid");
  });

  test.each([
    [400, false, "apple_bad_request", "permanent"],
    [404, false, "apple_not_found", "permanent"],
    [422, false, "apple_unprocessable", "permanent"],
    [429, true, "apple_rate_limited", "transient"],
    [503, true, "apple_server_error", "transient"],
  ] as const)(
    "classifies Apple %i (retriable=%s) as %s/%s",
    (status, retriable, reasonCode, failureClass) => {
      expect(classifyCatalogProviderFailure(new AppleApiError("provider response", status, retriable))).toEqual({
        reasonCode,
        failureClass,
      });
    },
  );

  test("classifies timeout/abort failures as transient and authorization as permanent", () => {
    const controller = new AbortController();
    controller.abort();
    expect(classifyCatalogProviderFailure(new DOMException("timed out", "AbortError"), controller.signal)).toEqual({
      reasonCode: "apple_request_timeout",
      failureClass: "transient",
    });
    expect(classifyCatalogProviderFailure(new AppleAuthorizationRequiredError(401))).toEqual({
      reasonCode: "apple_authorization_required",
      failureClass: "permanent",
    });
  });

  test("permanent Apple errors are bounded and never become retryable frontier work", async () => {
    let calls = 0;
    const first = await discoverCuratedAppleCatalog(provider({
      playlistTracks: async () => {
        calls += 1;
        throw new AppleApiError("missing", 404, false);
      },
    }), {
      storefront: "us",
      query: "missing",
      target: 25,
      concurrency: 2,
      scopedPlaylists: [{ id: "pl.missing", scopeBindingRefs: ["binding:missing"] }],
      evaluate: () => ({ eligible: false, scopeBindingRefs: [], reasonCode: "not_supported" }),
    });
    expect(calls).toBe(1);
    expect(first.frontier).toContainEqual(expect.objectContaining({
      status: "failed", retryable: false, lastReasonCode: "apple_not_found",
    }));
    await discoverCuratedAppleCatalog(provider({
      playlistTracks: async () => {
        calls += 1;
        return { items: [], next: null };
      },
    }), {
      storefront: "us",
      query: "missing",
      target: 25,
      concurrency: 2,
      resumeFrontier: first.frontier,
      scopedPlaylists: [{ id: "pl.missing", scopeBindingRefs: ["binding:missing"] }],
      evaluate: () => ({ eligible: false, scopeBindingRefs: [], reasonCode: "not_supported" }),
    });
    expect(calls).toBe(1);
  });

  test("the fixed A-D frontier expands searches, artists, releases, similar artists, and deficit queries", async () => {
    const fixture = provider({
      search: async (_storefront, query) => ({
        songs: [],
        artists: query === "scene" ? [{ id: "201", name: "Seed", genreNames: [] }] : [],
        albums: query === "scene" ? [{ id: "301", name: "Selected", artistName: "Seed", genreNames: [] }] : [],
        playlists: [],
      }),
      artistAlbums: async (_storefront, _artist, view) => ({
        items: [{ id: view === "singles" ? "302" : view === "full-albums" ? "303" : "304", name: view, artistName: "Seed", genreNames: [] }],
        next: null,
      }),
      similarArtists: async () => ({ items: [{ id: "202", name: "Adjacent", genreNames: [] }], next: null }),
    });

    const result = await discoverCuratedAppleCatalog(fixture, {
      storefront: "us",
      query: "scene",
      target: 25,
      concurrency: 6,
      deficitQueries: ["scene local-language alias"],
      evaluate: () => ({ eligible: false, scopeBindingRefs: [], reasonCode: "not_supported" }),
    });
    const kinds = new Set(result.frontier.map((entry) => entry.kind));
    expect(result.roundsCompleted).toEqual(["A", "B", "C", "D"]);
    for (const kind of [
      "direct_search",
      "seed_artist_top_songs",
      "artist_singles",
      "selected_album_tracks",
      "artist_full_albums",
      "artist_appears_on",
      "similar_artists",
      "similar_artist_top_songs",
      "deficit_search",
    ]) expect(kinds.has(kind as never)).toBe(true);
  });
});
