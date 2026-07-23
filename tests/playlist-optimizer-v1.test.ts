import { describe, expect, test } from "vitest";
import {
  optimizePlaylistV1,
  type PlaylistOptimizationCandidateV1,
  type PlaylistOptimizationConstraintsV1,
} from "../server/playlist-optimizer-v1.ts";

function track(
  id: string,
  overrides: Partial<PlaylistOptimizationCandidateV1> = {},
): PlaylistOptimizationCandidateV1 {
  return {
    id,
    recordingFamilyKey: `family-${id}`,
    artistKey: `artist-${id}`,
    albumKey: `album-${id}`,
    relevanceScore: 0.8,
    familiarityScore: 0.2,
    discoveryScore: 0.8,
    eraKeys: ["2020s"],
    sceneKeys: ["core"],
    geographyKeys: ["global"],
    energy: 0.5,
    tempo: 0.5,
    chronologyPosition: 2020,
    centralQualityVerdict: "pass",
    ...overrides,
  };
}

function constraints(
  overrides: Partial<PlaylistOptimizationConstraintsV1> = {},
): PlaylistOptimizationConstraintsV1 {
  return {
    targetTrackCount: 4,
    maximumTracksPerArtist: 1,
    maximumTracksPerAlbum: 1,
    minimumDistinctArtists: 4,
    minimumDistinctAlbums: 4,
    minimumDistinctEras: 2,
    minimumDistinctScenes: 2,
    minimumDistinctGeographies: 2,
    minimumFamiliarTracks: 1,
    maximumFamiliarTracks: 2,
    minimumCentralQualityPassTracks: 0,
    maximumCentralQualityUnknownTracks: 4,
    zeroCentralQualityFailures: false,
    sequencingMode: "smooth",
    avoidAdjacentSameArtist: true,
    avoidAdjacentSameAlbum: true,
    ...overrides,
  };
}

describe("playlist optimizer v1", () => {
  test("satisfies exact count, diversity, concentration, and familiarity together", () => {
    const candidates = [
      track("a", {
        artistKey: "artist-one",
        albumKey: "album-one",
        familiarityScore: 0.9,
        eraKeys: ["1990s"],
        sceneKeys: ["old-school"],
        geographyKeys: ["br"],
        relevanceScore: 0.95,
      }),
      track("a-lower-duplicate", {
        recordingFamilyKey: "family-a",
        relevanceScore: 0.1,
      }),
      track("b", {
        artistKey: "artist-two",
        albumKey: "album-two",
        familiarityScore: 0.7,
        eraKeys: ["2010s"],
        sceneKeys: ["new-school"],
        geographyKeys: ["pr"],
      }),
      track("c", { artistKey: "artist-three", albumKey: "album-three" }),
      track("d", { artistKey: "artist-four", albumKey: "album-four" }),
      track("e", { artistKey: "artist-one", albumKey: "album-five", relevanceScore: 0.99 }),
    ];
    const first = optimizePlaylistV1({ candidates, constraints: constraints() });
    const second = optimizePlaylistV1({ candidates: [...candidates].reverse(), constraints: constraints() });
    expect(first.exact).toBe(true);
    expect(first.unmetConstraints).toEqual([]);
    expect(first.selected).toHaveLength(4);
    expect(first.selected.map(({ id }) => id)).toEqual(second.selected.map(({ id }) => id));
    expect(new Set(first.selected.map(({ artistKey }) => artistKey)).size).toBe(4);
    expect(first.distinct).toMatchObject({ eras: 2, scenes: 2, geographies: 2 });
    expect(first.familiarTrackCount).toBeGreaterThanOrEqual(1);
    expect(first.familiarTrackCount).toBeLessThanOrEqual(2);
    expect(first.selected.some(({ id }) => id === "a-lower-duplicate")).toBe(false);
  });

  test("returns an explicit infeasible result instead of filler or silent relaxation", () => {
    const result = optimizePlaylistV1({
      candidates: [
        track("a", { eraKeys: ["2020s"] }),
        track("b", { eraKeys: ["2020s"] }),
        track("c", { eraKeys: ["2020s"] }),
        track("d", { eraKeys: ["2020s"], familiarityScore: 0.9 }),
      ],
      constraints: constraints({ minimumDistinctEras: 3 }),
    });
    expect(result.exact).toBe(false);
    expect(result.selected).toHaveLength(4);
    expect(result.unmetConstraints).toContain("minimum_distinct_eras:1/3");
  });

  test("smooth sequencing prefers nearby energy while avoiding adjacent artists", () => {
    const result = optimizePlaylistV1({
      candidates: [
        track("low", { artistKey: "same", energy: 0.1, tempo: 0.1, familiarityScore: 0.9 }),
        track("near", { artistKey: "other", energy: 0.2, tempo: 0.2 }),
        track("high", { artistKey: "same", energy: 0.9, tempo: 0.9 }),
      ],
      constraints: constraints({
        targetTrackCount: 3,
        maximumTracksPerArtist: 2,
        minimumDistinctArtists: 2,
        minimumDistinctAlbums: 3,
        minimumDistinctEras: 1,
        minimumDistinctScenes: 1,
        minimumDistinctGeographies: 1,
        minimumFamiliarTracks: 1,
        maximumFamiliarTracks: 3,
        maximumCentralQualityUnknownTracks: 3,
      }),
    });
    expect(result.exact).toBe(true);
    for (let index = 1; index < result.selected.length; index += 1) {
      expect(result.selected[index]!.artistKey)
        .not.toBe(result.selected[index - 1]!.artistKey);
    }
  });

  test("retains alternative set compositions when the highest-ranked greedy pick is a diversity trap", () => {
    const result = optimizePlaylistV1({
      candidates: [
        track("trap", {
          relevanceScore: 1,
          eraKeys: ["era-one"],
          sceneKeys: ["scene-one"],
        }),
        track("era-side", {
          relevanceScore: 0.8,
          eraKeys: ["era-two"],
          sceneKeys: ["scene-one"],
        }),
        track("scene-side", {
          relevanceScore: 0.79,
          eraKeys: ["era-one"],
          sceneKeys: ["scene-two"],
        }),
      ],
      constraints: constraints({
        targetTrackCount: 2,
        minimumDistinctArtists: 2,
        minimumDistinctAlbums: 2,
        minimumDistinctEras: 2,
        minimumDistinctScenes: 2,
        minimumDistinctGeographies: 1,
        minimumFamiliarTracks: 0,
        maximumFamiliarTracks: 2,
        maximumCentralQualityUnknownTracks: 2,
      }),
    });
    expect(result.exact).toBe(true);
    expect(result.selected.map(({ id }) => id).sort()).toEqual([
      "era-side",
      "scene-side",
    ]);
  });

  test("does not start an adjacency sequence with the minority artist when that makes a valid ending impossible", () => {
    const result = optimizePlaylistV1({
      candidates: [
        track("a1", { artistKey: "artist-a", relevanceScore: 0.8 }),
        track("a2", { artistKey: "artist-a", relevanceScore: 0.79 }),
        track("a3", { artistKey: "artist-a", relevanceScore: 0.78 }),
        track("b1", { artistKey: "artist-b", relevanceScore: 1 }),
        track("b2", { artistKey: "artist-b", relevanceScore: 0.99 }),
      ],
      constraints: constraints({
        targetTrackCount: 5,
        maximumTracksPerArtist: 3,
        maximumTracksPerAlbum: 1,
        minimumDistinctArtists: 2,
        minimumDistinctAlbums: 5,
        minimumDistinctEras: 1,
        minimumDistinctScenes: 1,
        minimumDistinctGeographies: 1,
        minimumFamiliarTracks: 0,
        maximumFamiliarTracks: 5,
        maximumCentralQualityUnknownTracks: 5,
      }),
    });
    expect(result.exact).toBe(true);
    expect(result.selected.map(({ artistKey }) => artistKey)).toEqual([
      "artist-a",
      "artist-b",
      "artist-a",
      "artist-b",
      "artist-a",
    ]);
  });

  test("never treats an unknown chronology position as chronology-proof filler", () => {
    const result = optimizePlaylistV1({
      candidates: [
        track("known-older", { chronologyPosition: 1990 }),
        track("known-newer", { chronologyPosition: 2000 }),
        track("unknown", { chronologyPosition: null, relevanceScore: 1 }),
      ],
      constraints: constraints({
        targetTrackCount: 3,
        maximumTracksPerArtist: 1,
        maximumTracksPerAlbum: 1,
        minimumDistinctArtists: 3,
        minimumDistinctAlbums: 3,
        minimumDistinctEras: 1,
        minimumDistinctScenes: 1,
        minimumDistinctGeographies: 1,
        minimumFamiliarTracks: 0,
        maximumFamiliarTracks: 3,
        maximumCentralQualityUnknownTracks: 3,
        sequencingMode: "chronological",
      }),
    });
    expect(result.exact).toBe(false);
    expect(result.selected.map(({ id }) => id)).toEqual([
      "known-older",
      "known-newer",
    ]);
    expect(result.unmetConstraints).toContain("exact_count:2/3");
    expect(result.unmetConstraints).not.toContain("chronology_unproven");
  });
});
