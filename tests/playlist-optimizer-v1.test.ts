import { describe, expect, test } from "vitest";
import {
  optimizePlaylistV1,
  PlaylistOptimizationBudgetExceededErrorV1,
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
    sourceOrder: 0,
    artistKey: `artist-${id}`,
    albumKey: `album-${id}`,
    relevanceScore: 0.8,
    familiarityScore: 0.2,
    discoveryScore: 0.8,
    eraKeys: ["2020s"],
    sceneKeys: ["core"],
    geographyKeys: ["global"],
    sourceKeys: [`source-${id}`],
    dependencyKeys: [`dependency-${id}`],
    cacheOrigin: "live",
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
    maximumTracksPerSource: null,
    maximumTracksPerDependency: null,
    maximumFreshCacheTracks: null,
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
  test("solves canonical quotas jointly with artist diversity instead of rejecting a feasible pool", () => {
    const result = optimizePlaylistV1({
      candidates: [
        track("rank-0", {
          artistKey: "artist-a",
          relevanceScore: 1,
          canonicalQuotaRuleIds: [],
        }),
        track("rank-1", {
          artistKey: "artist-b",
          relevanceScore: 0.99,
          canonicalQuotaRuleIds: [],
        }),
        track("rank-2", {
          artistKey: "artist-a",
          relevanceScore: 0.98,
          canonicalQuotaRuleIds: ["quota:rare"],
        }),
        track("rank-3", {
          artistKey: "artist-c",
          relevanceScore: 0.97,
          canonicalQuotaRuleIds: ["quota:rare"],
        }),
      ],
      constraints: constraints({
        targetTrackCount: 2,
        maximumTracksPerArtist: 1,
        maximumTracksPerAlbum: null,
        minimumDistinctArtists: 2,
        minimumDistinctAlbums: 0,
        minimumDistinctEras: 0,
        minimumDistinctScenes: 0,
        minimumDistinctGeographies: 0,
        minimumFamiliarTracks: 0,
        maximumFamiliarTracks: 2,
        maximumCentralQualityUnknownTracks: 2,
        canonicalQuotaRules: [{
          id: "quota:rare",
          minimumCount: 1,
          maximumCount: 2,
        }],
        avoidAdjacentSameArtist: false,
        avoidAdjacentSameAlbum: false,
      }),
    });

    expect(result.exact).toBe(true);
    expect(new Set(result.selected.map(({ artistKey }) => artistKey)).size).toBe(2);
    expect(result.selected.some(({ canonicalQuotaRuleIds = [] }) => (
      canonicalQuotaRuleIds.includes("quota:rare")
    ))).toBe(true);
  });

  test("keeps a lower-ranked representation when its provenance makes the recording feasible", () => {
    const result = optimizePlaylistV1({
      candidates: [
        track("a-high", {
          recordingFamilyKey: "family-a",
          relevanceScore: 1,
          sourceKeys: ["source-x"],
        }),
        track("a-low", {
          recordingFamilyKey: "family-a",
          relevanceScore: 0.8,
          sourceKeys: ["source-y"],
        }),
        track("b", {
          recordingFamilyKey: "family-b",
          relevanceScore: 0.9,
          sourceKeys: ["source-x"],
        }),
      ],
      constraints: constraints({
        targetTrackCount: 2,
        maximumTracksPerArtist: null,
        maximumTracksPerAlbum: null,
        maximumTracksPerSource: 1,
        minimumDistinctArtists: 0,
        minimumDistinctAlbums: 0,
        minimumDistinctEras: 0,
        minimumDistinctScenes: 0,
        minimumDistinctGeographies: 0,
        minimumFamiliarTracks: 0,
        maximumFamiliarTracks: 2,
        maximumCentralQualityUnknownTracks: 2,
        avoidAdjacentSameArtist: false,
        avoidAdjacentSameAlbum: false,
      }),
    });

    expect(result.exact).toBe(true);
    expect(result.selected.map(({ id }) => id).sort()).toEqual(["a-low", "b"]);
    expect(new Set(result.selected.map(({ recordingFamilyKey }) => recordingFamilyKey)).size)
      .toBe(2);
  });

  test("preserves immutable source order even when relevance rank differs", () => {
    const result = optimizePlaylistV1({
      candidates: [
        track("middle", { sourceOrder: 1, relevanceScore: 1 }),
        track("last", { sourceOrder: 2, relevanceScore: 0.9 }),
        track("first", { sourceOrder: 0, relevanceScore: 0.1 }),
      ],
      constraints: constraints({
        targetTrackCount: 3,
        maximumTracksPerArtist: null,
        maximumTracksPerAlbum: null,
        minimumDistinctArtists: 0,
        minimumDistinctAlbums: 0,
        minimumDistinctEras: 0,
        minimumDistinctScenes: 0,
        minimumDistinctGeographies: 0,
        minimumFamiliarTracks: 0,
        maximumFamiliarTracks: 3,
        maximumCentralQualityUnknownTracks: 3,
        sequencingMode: "source_order",
        avoidAdjacentSameArtist: false,
        avoidAdjacentSameAlbum: false,
      }),
    });

    expect(result.exact).toBe(true);
    expect(result.selected.map(({ id }) => id)).toEqual(["first", "middle", "last"]);
  });

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

  test("backtracks across intersecting artist and album adjacency instead of reporting false infeasibility", () => {
    const result = optimizePlaylistV1({
      candidates: [
        track("0", { artistKey: "b", albumKey: "a", relevanceScore: 1 }),
        track("1", { artistKey: "b", albumKey: "b", relevanceScore: 0.9 }),
        track("2", { artistKey: "b", albumKey: "c", relevanceScore: 0.8 }),
        track("3", { artistKey: "c", albumKey: "c", relevanceScore: 0.7 }),
        track("4", { artistKey: "a", albumKey: "b", relevanceScore: 0.6 }),
      ],
      constraints: constraints({
        targetTrackCount: 5,
        maximumTracksPerArtist: null,
        maximumTracksPerAlbum: null,
        minimumDistinctArtists: 0,
        minimumDistinctAlbums: 0,
        minimumDistinctEras: 0,
        minimumDistinctScenes: 0,
        minimumDistinctGeographies: 0,
        minimumFamiliarTracks: 0,
        maximumFamiliarTracks: 5,
        maximumCentralQualityUnknownTracks: 5,
      }),
    });

    expect(result.exact).toBe(true);
    expect(result.selected).toHaveLength(5);
    for (let index = 1; index < result.selected.length; index += 1) {
      expect(result.selected[index]!.artistKey)
        .not.toBe(result.selected[index - 1]!.artistKey);
      expect(result.selected[index]!.albumKey)
        .not.toBe(result.selected[index - 1]!.albumKey);
    }
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

  test("enforces dependency diversity across every dependency attached to a candidate", () => {
    const result = optimizePlaylistV1({
      candidates: [
        track("a", {
          dependencyKeys: ["provider-a", "shared-upstream"],
        }),
        track("b", {
          dependencyKeys: ["provider-b", "shared-upstream"],
        }),
        track("c", {
          dependencyKeys: ["provider-c", "shared-upstream"],
        }),
      ],
      constraints: constraints({
        targetTrackCount: 3,
        maximumTracksPerDependency: 2,
        minimumDistinctArtists: 3,
        minimumDistinctAlbums: 3,
        minimumDistinctEras: 1,
        minimumDistinctScenes: 1,
        minimumDistinctGeographies: 1,
        minimumFamiliarTracks: 0,
        maximumFamiliarTracks: 3,
        maximumCentralQualityUnknownTracks: 3,
      }),
    });

    expect(result.exact).toBe(false);
    expect(result.selected).toHaveLength(2);
    expect(result.selected.every(({ dependencyKeys }) => (
      dependencyKeys.includes("shared-upstream")
    ))).toBe(true);
    expect(result.unmetConstraints).toContain("exact_count:2/3");
  });

  test("caps fresh-cache concentration before an exact set can be selected", () => {
    const result = optimizePlaylistV1({
      candidates: [
        track("cache-a", { cacheOrigin: "fresh_cache" }),
        track("cache-b", { cacheOrigin: "fresh_cache" }),
        track("live", { cacheOrigin: "live", relevanceScore: 0.7 }),
      ],
      constraints: constraints({
        targetTrackCount: 3,
        maximumFreshCacheTracks: 1,
        minimumDistinctArtists: 3,
        minimumDistinctAlbums: 3,
        minimumDistinctEras: 1,
        minimumDistinctScenes: 1,
        minimumDistinctGeographies: 1,
        minimumFamiliarTracks: 0,
        maximumFamiliarTracks: 3,
        maximumCentralQualityUnknownTracks: 3,
      }),
    });

    expect(result.exact).toBe(false);
    expect(result.selected).toHaveLength(2);
    expect(result.selected.filter(({ cacheOrigin }) => cacheOrigin === "fresh_cache"))
      .toHaveLength(1);
    expect(result.unmetConstraints).toContain("exact_count:2/3");
  });

  test("buckets empty source and dependency provenance so unattributed tracks cannot evade caps", () => {
    const result = optimizePlaylistV1({
      candidates: [
        track("unattributed-a", { sourceKeys: [], dependencyKeys: [] }),
        track("unattributed-b", { sourceKeys: [], dependencyKeys: [] }),
        track("unattributed-c", { sourceKeys: [], dependencyKeys: [] }),
      ],
      constraints: constraints({
        targetTrackCount: 3,
        maximumTracksPerSource: 1,
        maximumTracksPerDependency: 1,
        minimumDistinctArtists: 1,
        minimumDistinctAlbums: 1,
        minimumDistinctEras: 1,
        minimumDistinctScenes: 1,
        minimumDistinctGeographies: 1,
        minimumFamiliarTracks: 0,
        maximumFamiliarTracks: 3,
        maximumCentralQualityUnknownTracks: 3,
      }),
    });

    expect(result.exact).toBe(false);
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]).toMatchObject({
      sourceKeys: ["__unattributed_source"],
      dependencyKeys: ["__unattributed_dependency"],
    });
    expect(result.unmetConstraints).toContain("exact_count:1/3");
  });

  test("finds a feasible exact 120-track set without exhausting overlapping source capacity", () => {
    const overlapping = Array.from({ length: 25 }, (_, index) => track(
      `overlap-${index}`,
      {
        relevanceScore: 1,
        sourceKeys: ["source-a", "source-b"],
      },
    ));
    const sourceA = Array.from({ length: 72 }, (_, index) => track(
      `source-a-${index}`,
      {
        relevanceScore: 0.8,
        sourceKeys: ["source-a"],
      },
    ));
    const sourceB = Array.from({ length: 72 }, (_, index) => track(
      `source-b-${index}`,
      {
        relevanceScore: 0.79,
        sourceKeys: ["source-b"],
      },
    ));

    const result = optimizePlaylistV1({
      candidates: [...overlapping, ...sourceA, ...sourceB],
      constraints: constraints({
        targetTrackCount: 120,
        maximumTracksPerArtist: null,
        maximumTracksPerAlbum: null,
        maximumTracksPerSource: 72,
        minimumDistinctArtists: 0,
        minimumDistinctAlbums: 0,
        minimumDistinctEras: 0,
        minimumDistinctScenes: 0,
        minimumDistinctGeographies: 0,
        minimumFamiliarTracks: 0,
        maximumFamiliarTracks: 120,
        maximumCentralQualityUnknownTracks: 120,
        sequencingMode: "source_order",
        avoidAdjacentSameArtist: false,
        avoidAdjacentSameAlbum: false,
      }),
    });

    expect(result.exact).toBe(true);
    expect(result.selected).toHaveLength(120);
    for (const source of ["source-a", "source-b"]) {
      expect(result.selected.filter(({ sourceKeys }) => sourceKeys.includes(source)))
        .toHaveLength(72);
    }
    expect(result.selected.filter(({ sourceKeys }) => sourceKeys.length === 2).length)
      .toBeLessThanOrEqual(24);
  });

  test("rescues an exact large-pool set even when every beam branch is a diversity trap", () => {
    const candidates = [
      ...Array.from({ length: 6 }, (_, index) => track(`high-ranked-trap-${index}`, {
        relevanceScore: 1 - index / 100,
        eraKeys: ["era-one"],
        sceneKeys: ["scene-one"],
      })),
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
      ...Array.from({ length: 993 }, (_, index) => track(`decoy-${index}`, {
        relevanceScore: 0.01,
        eraKeys: ["era-one"],
        sceneKeys: ["scene-one"],
      })),
    ];

    const result = optimizePlaylistV1({
      candidates,
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

  test("throws a retryable technical error instead of treating a bounded search as infeasible", () => {
    expect(() => optimizePlaylistV1({
      candidates: [
        track("trap", {
          relevanceScore: 1,
          eraKeys: ["era-one"],
          sceneKeys: ["scene-one"],
        }),
        track("era-side", {
          eraKeys: ["era-two"],
          sceneKeys: ["scene-one"],
        }),
        track("scene-side", {
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
      budget: {
        maximumHeuristicWorkUnits: 1,
        maximumExactNodes: 1,
        maximumExactWorkUnits: 1,
      },
    })).toThrow(PlaylistOptimizationBudgetExceededErrorV1);
  });

  test("charges exact sequencing and terminal summaries to the deterministic work cap", () => {
    expect(() => optimizePlaylistV1({
      candidates: [
        track("0", { artistKey: "b", albumKey: "a", relevanceScore: 1 }),
        track("1", { artistKey: "b", albumKey: "b", relevanceScore: 0.9 }),
        track("2", { artistKey: "b", albumKey: "c", relevanceScore: 0.8 }),
        track("3", { artistKey: "c", albumKey: "c", relevanceScore: 0.7 }),
        track("4", { artistKey: "a", albumKey: "b", relevanceScore: 0.6 }),
      ],
      constraints: constraints({
        targetTrackCount: 5,
        maximumTracksPerArtist: null,
        maximumTracksPerAlbum: null,
        minimumDistinctArtists: 0,
        minimumDistinctAlbums: 0,
        minimumDistinctEras: 0,
        minimumDistinctScenes: 0,
        minimumDistinctGeographies: 0,
        minimumFamiliarTracks: 0,
        maximumFamiliarTracks: 5,
        maximumCentralQualityUnknownTracks: 5,
      }),
      budget: {
        maximumHeuristicWorkUnits: 10_000,
        maximumExactNodes: 100,
        maximumExactWorkUnits: 40,
      },
    })).toThrow(PlaylistOptimizationBudgetExceededErrorV1);
  });
});
