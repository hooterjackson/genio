import { describe, expect, test } from "vitest";
import type { CatalogSong } from "../shared/types.ts";
import {
  discoverCuratedAppleCatalog,
  type CatalogDiscoveryProvider,
  type CatalogDiscoveryRound,
} from "../server/catalog-discovery-v2.ts";

function numericTail(value: string): number {
  return Number(value.replace(/\D/gu, "").slice(-6)) || 1;
}

function catalogSong(id: number, source: string): CatalogSong {
  return {
    id: String(id),
    name: `${source} Track ${id}`,
    artistName: `${source} Artist ${Math.floor(id / 100)}`,
    albumName: `${source} Collection`,
    isrc: `USQAV26${String(id).padStart(5, "0").slice(-5)}`,
    genreNames: ["Scenario Genre"],
  };
}

function pageSongs(base: number, offset: number, count = 10, source = "Scoped"): CatalogSong[] {
  return Array.from({ length: count }, (_, index) => catalogSong(base + offset + index, source));
}

/**
 * Replayable fake of the source-plural Apple frontier. Every fourth Apple
 * identity lacks track-level external evidence, so the controller must plan
 * from post-filter yield instead of assuming every discovered row survives.
 */
function replayProvider() {
  const calls: Array<{ operation: string; cursor: string | null }> = [];
  const provider: CatalogDiscoveryProvider = {
    async search(_storefront, query, types, _limit, _signal, cursor) {
      calls.push({ operation: `search:${types.join(",")}`, cursor: cursor ?? null });
      const offset = cursor ? 25 : 0;
      const songs = types.includes("songs") ? pageSongs(1, offset, 25, "Search") : [];
      return {
        songs,
        artists: !cursor && types.includes("artists")
          ? Array.from({ length: 8 }, (_, index) => ({
            id: String(1_001 + index), name: `Seed ${index + 1}`, genreNames: ["Scenario Genre"],
          }))
          : [],
        albums: !cursor && types.includes("albums")
          ? Array.from({ length: 8 }, (_, index) => ({
            id: String(2_001 + index), name: `Seed Release ${index + 1}`, artistName: `Seed ${index + 1}`, genreNames: ["Scenario Genre"],
          }))
          : [],
        playlists: [],
        ...(!cursor && types.includes("songs") ? {
          next: {
            songs: `/v1/catalog/us/search?term=${encodeURIComponent(query)}&types=songs&limit=25&offset=25`,
          },
        } : {}),
      };
    },
    async playlistTracks() {
      calls.push({ operation: "playlist", cursor: null });
      return { items: [], next: null };
    },
    async albumTracks(_storefront, albumId, cursor) {
      calls.push({ operation: "album", cursor });
      const offset = cursor ? 10 : 0;
      const base = 100_000 + numericTail(albumId) * 100;
      return {
        items: pageSongs(base, offset, cursor ? 10 : 6, "Release"),
        next: cursor ? null : `/v1/catalog/us/albums/${albumId}/tracks?limit=100&offset=10`,
      };
    },
    async artistTopSongs(_storefront, artistId, cursor) {
      calls.push({ operation: "artist_top", cursor });
      const offset = cursor ? 10 : 0;
      const base = 1_000_000 + numericTail(artistId) * 100;
      return {
        items: pageSongs(base, offset, cursor ? 10 : 6, "Artist"),
        next: cursor ? null : `/v1/catalog/us/artists/${artistId}/view/top-songs?limit=25&offset=10`,
      };
    },
    async artistAlbums(_storefront, artistId, view, cursor) {
      calls.push({ operation: `artist_albums:${view}`, cursor });
      const viewOffset = view === "singles" ? 0 : view === "full-albums" ? 20 : 40;
      const albumId = 20_000 + numericTail(artistId) * 100 + viewOffset;
      return {
        items: [{
          id: String(albumId),
          name: `${view} ${artistId}`,
          artistName: `Seed ${artistId}`,
          genreNames: ["Scenario Genre"],
        }],
        next: null,
      };
    },
    async similarArtists(_storefront, artistId, cursor) {
      calls.push({ operation: "similar_artists", cursor });
      return {
        items: cursor ? [] : [{
          id: String(50_000 + numericTail(artistId)),
          name: `Adjacent ${artistId}`,
          genreNames: ["Scenario Genre"],
        }],
        next: null,
      };
    },
  };
  return { provider, calls };
}

describe("Pipeline V2 provider-backed exact-fill replays", () => {
  test.each([25, 50, 100, 200, 300] as const)(
    "%i-track target reaches target plus reserve through filtered A-D provider yield",
    async (target) => {
      const { provider, calls } = replayProvider();
      const result = await discoverCuratedAppleCatalog(provider, {
        storefront: "us",
        query: "Scenario Genre",
        target,
        concurrency: 6,
        maxPagesPerStrategy: 10,
        maxTotalProviderCalls: 500,
        evaluate(song, context) {
          const ordinal = numericTail(song.id);
          if (ordinal % 4 === 0) {
            return { eligible: false, scopeBindingRefs: [], reasonCode: "external_scope_not_found" };
          }
          // Independent source roots alternate across exact track claims. The
          // artist/release/similar endpoints discover identities, but only this
          // exact-song evidence makes them eligible.
          const provenance = ordinal % 2 === 0 ? "specialist-history-a" : "editorial-database-b";
          return {
            eligible: true,
            scopeBindingRefs: [`${provenance}:track:${song.id}`],
            reasonCode: `track_specific_scope:${context.strategyKind}`,
          };
        },
      });

      const reserve = Math.max(5, Math.ceil(target * 0.1));
      expect(result.totalQualifiedCount).toBeGreaterThanOrEqual(target + reserve);
      expect(result.stoppedBecause).toBe("target_and_reserve");
      expect(result.totalAttemptedCount).toBeGreaterThan(result.totalQualifiedCount);
      expect(result.providerCallCount).toBeGreaterThan(1);
      expect(calls).toHaveLength(result.providerCallCount);
      expect(new Set(result.qualified.flatMap((candidate) => candidate.scopeBindingRefs)
        .map((reference) => reference.split(":")[0])).size).toBeGreaterThan(1);

      const qualifyingRounds = new Set<CatalogDiscoveryRound>(result.qualified.flatMap((candidate) => (
        candidate.contexts.map((context) => context.round)
      )));
      expect(qualifyingRounds.has("B")).toBe(true);
      if (target >= 200) expect(qualifyingRounds.has("C")).toBe(true);
      if (target >= 300) expect(qualifyingRounds.has("D")).toBe(true);
    },
    20_000,
  );
});
