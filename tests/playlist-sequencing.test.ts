import { describe, expect, test } from "vitest";
import {
  sequencePlaylist,
  sequencePlaylistRows,
  shouldSequencePlaylist,
  type PlaylistSequenceTrack,
} from "../lib/playlist-sequencing.ts";
import {
  artistDiversityResearchInstruction,
  briefExplicitlyRequestsArtistDiversity,
  briefShouldDiversifyArtists,
  desiredPlaylistArtistCount,
  playlistArtistKey,
  prioritizeUnrepresentedArtistRows,
  selectRankedPlaylistRows,
} from "../lib/playlist-selection.ts";

interface FixtureTrack extends PlaylistSequenceTrack {
  rowId: string;
  title: string;
}

function track(
  rowId: string,
  artist: string,
  album: string,
  metadata: Partial<PlaylistSequenceTrack> = {},
): FixtureTrack {
  return { rowId, title: rowId, artist, album, ...metadata };
}

function adjacentMatches(
  tracks: readonly FixtureTrack[],
  field: "artist" | "album",
): number {
  let matches = 0;
  for (let index = 1; index < tracks.length; index += 1) {
    if (tracks[index]?.[field] === tracks[index - 1]?.[field]) matches += 1;
  }
  return matches;
}

describe("deterministic playlist sequencing", () => {
  test("uses the accepted reserve to diversify similar-to playlists before sequencing", () => {
    const ranked = [
      ...Array.from({ length: 30 }, (_, index) => track(`a-${index}`, "Adjacent Artist A", `A-${index % 3}`)),
      ...Array.from({ length: 10 }, (_, index) => track(`b-${index}`, "Adjacent Artist B", `B-${index % 2}`)),
      ...Array.from({ length: 10 }, (_, index) => track(`c-${index}`, "Adjacent Artist C", `C-${index % 2}`)),
      ...Array.from({ length: 25 }, (_, index) => track(`other-${index}`, `Discovery ${index}`, `D-${index}`)),
    ];

    const selection = selectRankedPlaylistRows(ranked, 50, { diversifyArtists: true });
    const output = sequencePlaylist(selection.selected);
    const counts = output.reduce<Map<string, number>>((result, row) => {
      result.set(row.artist, (result.get(row.artist) ?? 0) + 1);
      return result;
    }, new Map());

    expect(selection.selected).toHaveLength(50);
    expect(selection.overflow).toHaveLength(25);
    expect(new Set([...selection.selected, ...selection.overflow].map((row) => row.rowId)).size)
      .toBe(ranked.length);
    expect(counts.get("Adjacent Artist A")).toBeLessThan(30);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(9);
    expect(adjacentMatches(output, "artist")).toBe(0);
  });

  test("does not diversify a direct-artist catalogue and still fills sparse similarity pools exactly", () => {
    const direct = Array.from({ length: 75 }, (_, index) => track(
      `direct-${index}`,
      "One Requested Artist",
      `Album ${Math.floor(index / 10)}`,
    ));
    expect(selectRankedPlaylistRows(direct, 50).selected.map((row) => row.rowId))
      .toEqual(direct.slice(0, 50).map((row) => row.rowId));

    const sparse = [
      ...Array.from({ length: 60 }, (_, index) => track(`dominant-${index}`, "Only Deep Catalogue", "Archive")),
      ...Array.from({ length: 15 }, (_, index) => track(`other-${index}`, `Other ${index}`, "Compilation")),
    ];
    const result = selectRankedPlaylistRows(sparse, 50, { diversifyArtists: true });
    expect(result.selected).toHaveLength(50);
    expect(result.overflow).toHaveLength(25);
  });

  test("diversifies a 25-track curated brief that explicitly requests diverse artists", () => {
    const brief = {
      mode: "curated",
      relationship: "style reference",
      description: "A cross-era survey of adjacent dream-pop recordings.",
      include: ["Use a diverse artist selection across the full period."],
      orderingPolicy: "editorial flow",
    };
    const ranked = [
      ...Array.from({ length: 12 }, (_, index) => track(`a-${index}`, "Artist A", `A-${index % 3}`)),
      ...Array.from({ length: 10 }, (_, index) => track(`b-${index}`, "Artist B", `B-${index % 2}`)),
      ...Array.from({ length: 13 }, (_, index) => track(`other-${index}`, `Discovery ${index}`, `D-${index}`)),
    ];

    const diversifyArtists = briefExplicitlyRequestsArtistDiversity(brief);
    const selection = selectRankedPlaylistRows(ranked, 25, { diversifyArtists });
    const counts = selection.selected.reduce<Map<string, number>>((result, row) => {
      result.set(row.artist, (result.get(row.artist) ?? 0) + 1);
      return result;
    }, new Map());

    expect(diversifyArtists).toBe(true);
    expect(selection.selected).toHaveLength(25);
    expect(selection.overflow).toHaveLength(10);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(6);
    expect(counts.get("Artist A")).toBeLessThan(12);
  });

  test("leaves direct-artist catalogues unchanged", () => {
    const directBrief = {
      mode: "curated",
      relationship: "best recordings by",
      description: "A balanced career survey.",
      include: ["Use a diverse artist selection across eras and collaborators."],
      orderingPolicy: "editorial flow",
    };
    const ranked = [
      ...Array.from({ length: 30 }, (_, index) => track(`direct-${index}`, "Requested Artist", `Album ${index % 4}`)),
      ...Array.from({ length: 5 }, (_, index) => track(`guest-${index}`, `Guest ${index}`, "Collaborations")),
    ];

    const diversifyArtists = briefExplicitlyRequestsArtistDiversity(directBrief);
    const selection = selectRankedPlaylistRows(ranked, 25, { diversifyArtists });

    expect(diversifyArtists).toBe(false);
    expect(selection.selected.map((row) => row.rowId))
      .toEqual(ranked.slice(0, 25).map((row) => row.rowId));
  });

  test("treats an ordinary curated genre request as multi-artist without magic diversity words", () => {
    const frenchJazzBrief = {
      mode: "curated",
      relationship: "representative of",
      description: "A French jazz playlist.",
      include: [],
      orderingPolicy: "editorial flow",
    };
    // Production replay: the research pool contained 88 candidates across
    // ten artists, but the ranked first 50 were 25 Michel Petrucciani, 24
    // Django Reinhardt, and one Martial Solal. The remaining 38 candidates
    // already contained seven additional artists; only manifest selection
    // failed to use them.
    const ranked = [
      ...Array.from({ length: 25 }, (_, index) => track(
        `petrucciani-${index}`,
        "Michel Petrucciani",
        `Petrucciani ${index % 4}`,
      )),
      ...Array.from({ length: 24 }, (_, index) => track(
        `django-${index}`,
        "Django Reinhardt",
        `Django ${index % 5}`,
      )),
      track("solal-0", "Martial Solal", "Solal 1"),
      ...Array.from({ length: 38 }, (_, index) => track(
        `reserve-${index}`,
        `French Jazz Reserve ${index % 7}`,
        `Reserve ${index}`,
      )),
    ];

    const naiveCounts = selectRankedPlaylistRows(ranked, 50).selected
      .reduce<Map<string, number>>((result, row) => {
        result.set(row.artist, (result.get(row.artist) ?? 0) + 1);
        return result;
      }, new Map());
    expect([...naiveCounts.values()].sort((left, right) => right - left)).toEqual([25, 24, 1]);

    expect(briefExplicitlyRequestsArtistDiversity(frenchJazzBrief)).toBe(false);
    expect(briefShouldDiversifyArtists(frenchJazzBrief)).toBe(true);
    const selection = selectRankedPlaylistRows(ranked, 50, {
      diversifyArtists: briefShouldDiversifyArtists(frenchJazzBrief),
      minimumDistinctArtists: desiredPlaylistArtistCount(frenchJazzBrief, 50),
    });
    const counts = selection.selected.reduce<Map<string, number>>((result, row) => {
      result.set(row.artist, (result.get(row.artist) ?? 0) + 1);
      return result;
    }, new Map());

    expect(selection.selected).toHaveLength(50);
    expect(selection.overflow).toHaveLength(38);
    expect(counts.size).toBeGreaterThanOrEqual(10);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(8);
    expect(artistDiversityResearchInstruction(frenchJazzBrief, 50)).toContain(
      "at least 20 distinct credited recording artists",
    );
  });

  test("preserves the accepted artist minimum when ranked rows are grouped by artist", () => {
    const brief = {
      mode: "curated",
      relationship: "representative of",
      description: "A French jazz playlist.",
      include: [],
      orderingPolicy: "editorial flow",
    };
    const ranked = Array.from({ length: 10 }, (_, artistIndex) => (
      Array.from({ length: 5 }, (_, trackIndex) => track(
        `${artistIndex}-${trackIndex}`,
        `French Jazz Artist ${artistIndex + 1}`,
        `Album ${artistIndex + 1}`,
      ))
    )).flat();

    const selection = selectRankedPlaylistRows(ranked, 25, {
      diversifyArtists: true,
      minimumDistinctArtists: desiredPlaylistArtistCount(brief, 25),
    });
    const counts = selection.selected.reduce<Map<string, number>>((result, row) => {
      result.set(row.artist, (result.get(row.artist) ?? 0) + 1);
      return result;
    }, new Map());

    expect(selection.selected).toHaveLength(25);
    expect(counts.size).toBe(10);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(4);
  });

  test("keeps non-Latin credited artists distinct in diversity accounting", () => {
    const artists = ["山下洋輔", "渡辺貞夫", "上原ひろみ"];
    expect(new Set(artists.map((artist) => playlistArtistKey(artist))).size).toBe(3);
    expect(artists.every((artist) => playlistArtistKey(artist).length > 0)).toBe(true);
  });

  test("prioritizes one row from every new artist before refill repeats", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, index) => ({ id: `old-${index}`, artist: "Django Reinhardt" })),
      ...Array.from({ length: 5 }, (_, index) => ({ id: `new-a-${index}`, artist: "Barney Wilen" })),
      ...Array.from({ length: 5 }, (_, index) => ({ id: `new-b-${index}`, artist: "Jef Gilson" })),
      ...Array.from({ length: 5 }, (_, index) => ({ id: `new-c-${index}`, artist: "Leïla Olivesi" })),
    ];

    const prioritized = prioritizeUnrepresentedArtistRows(rows, ["Django Reinhardt"]);
    expect(prioritized.slice(0, 3).map((row) => row.artist))
      .toEqual(["Barney Wilen", "Jef Gilson", "Leïla Olivesi"]);
    expect(new Set(prioritized.map((row) => row.id))).toEqual(new Set(rows.map((row) => row.id)));
  });

  test.each([
    "primary artist",
    "released by",
    "performed by",
    "best recordings by",
    "artist's discography",
  ])("preserves direct-artist selection for relationship: %s", (relationship) => {
    const brief = {
      mode: "curated",
      relationship,
      description: "A career-spanning selection by one requested artist.",
      include: ["Balance eras and albums."],
      orderingPolicy: "editorial flow",
    };
    expect(briefShouldDiversifyArtists(brief)).toBe(false);
    expect(artistDiversityResearchInstruction(brief, 50)).toBe("");
  });

  test("sequences listening-flow policies while preserving explicit fixed orders", () => {
    expect(shouldSequencePlaylist("editorial flow", "curated")).toBe(true);
    expect(shouldSequencePlaylist("smooth energy arc", "curated")).toBe(true);
    expect(shouldSequencePlaylist("", "curated")).toBe(true);
    expect(shouldSequencePlaylist("chronological by release date", "curated")).toBe(false);
    expect(shouldSequencePlaylist("ranked by influence", "curated")).toBe(false);
    expect(shouldSequencePlaylist("alphabetical by artist", "curated")).toBe(false);
    expect(shouldSequencePlaylist("", "exhaustive")).toBe(false);
  });

  test("interleaves artists and albums when their counts make that feasible", () => {
    const input = [
      track("a1", "Artist A", "Album A"),
      track("a2", "Artist A", "Album A"),
      track("a3", "Artist A", "Album B"),
      track("b1", "Artist B", "Album C"),
      track("b2", "Artist B", "Album C"),
      track("c1", "Artist C", "Album D"),
    ];

    const output = sequencePlaylist(input);

    expect(adjacentMatches(output, "artist")).toBe(0);
    expect(adjacentMatches(output, "album")).toBe(0);
  });

  test("avoids adjacent albums across compilation artists when feasible", () => {
    const input = [
      track("x1", "Artist 1", "Compilation X"),
      track("x2", "Artist 2", "Compilation X"),
      track("x3", "Artist 3", "Compilation X"),
      track("y1", "Artist 4", "Compilation Y"),
      track("y2", "Artist 5", "Compilation Y"),
      track("z1", "Artist 6", "Compilation Z"),
    ];

    expect(adjacentMatches(sequencePlaylist(input), "album")).toBe(0);
  });

  test("preserves duplicate occurrences as distinct source rows without mutation", () => {
    const duplicate = track("duplicate", "Artist A", "Album A", { bpm: 120 });
    const other = track("other", "Artist B", "Album B", { bpm: 121 });
    const input = [duplicate, duplicate, other] as const;
    const before = structuredClone(input);

    const output = sequencePlaylistRows(input);

    expect(output).toHaveLength(3);
    expect(output.map((row) => row.sourceIndex).sort((left, right) => left - right))
      .toEqual([0, 1, 2]);
    expect(output.filter((row) => row.track === duplicate)).toHaveLength(2);
    expect(input).toEqual(before);
  });

  test("uses supplied transition metadata to prefer a smoother next track", () => {
    const input = [
      track("anchor", "Artist A", "Album A", {
        genre: "Detroit techno",
        year: 1995,
        durationMs: 360_000,
        bpm: 128,
        key: "8A",
      }),
      track("rough", "Artist B", "Album B", {
        genre: "ambient",
        year: 1970,
        durationMs: 120_000,
        bpm: 82,
        key: "2B",
      }),
      track("smooth", "Artist C", "Album C", {
        genre: ["Detroit techno"],
        year: 1996,
        durationMs: 355_000,
        bpm: 129,
        key: "9A",
      }),
    ];

    const output = sequencePlaylist(input);

    expect(output[0]?.rowId).toBe("anchor");
    expect(output[1]?.rowId).toBe("smooth");
  });

  test("treats absent metadata as neutral and never adds inferred fields", () => {
    const input = [
      track("one", "Artist A", "Album A"),
      track("two", "Artist B", "Album B"),
      track("three", "Artist C", "Album C"),
    ];

    const output = sequencePlaylist(input);

    expect(output.map((item) => item.rowId)).toEqual(["one", "two", "three"]);
    expect(output.every((item) => !("bpm" in item) && !("key" in item))).toBe(true);
  });

  test("is deterministic", () => {
    const input = Array.from({ length: 120 }, (_, index) => track(
      `row-${index}`,
      `Artist ${index % 11}`,
      `Album ${index % 17}`,
      {
        genre: index % 2 === 0 ? "techno" : "electro",
        releaseYear: 1980 + (index % 40),
        durationMs: 180_000 + index * 137,
        bpm: 90 + (index % 70),
        key: `${(index % 12) + 1}${index % 2 === 0 ? "A" : "B"}`,
      },
    ));

    expect(sequencePlaylist(input).map((item) => item.rowId))
      .toEqual(sequencePlaylist(input).map((item) => item.rowId));
  });

  test("avoids artist adjacency for every small feasible count distribution", () => {
    for (let a = 0; a <= 4; a += 1) {
      for (let b = 0; b <= 4; b += 1) {
        for (let c = 0; c <= 4; c += 1) {
          const total = a + b + c;
          if (total === 0 || Math.max(a, b, c) > Math.ceil(total / 2)) continue;
          const input = [
            ...Array.from({ length: a }, (_, index) => track(`a-${index}`, "A", `A-${index}`)),
            ...Array.from({ length: b }, (_, index) => track(`b-${index}`, "B", `B-${index}`)),
            ...Array.from({ length: c }, (_, index) => track(`c-${index}`, "C", `C-${index}`)),
          ];
          expect(
            adjacentMatches(sequencePlaylist(input), "artist"),
            `counts A=${a}, B=${b}, C=${c}`,
          ).toBe(0);
        }
      }
    }
  });

  test("avoids album adjacency for every small feasible count distribution", () => {
    for (let a = 0; a <= 4; a += 1) {
      for (let b = 0; b <= 4; b += 1) {
        for (let c = 0; c <= 4; c += 1) {
          const total = a + b + c;
          if (total === 0 || Math.max(a, b, c) > Math.ceil(total / 2)) continue;
          let sourceIndex = 0;
          const albumTracks = (count: number, album: string) => Array.from({ length: count }, () => {
            const index = sourceIndex;
            sourceIndex += 1;
            return track(`${album}-${index}`, `Unique Artist ${index}`, album);
          });
          const input = [
            ...albumTracks(a, "Album A"),
            ...albumTracks(b, "Album B"),
            ...albumTracks(c, "Album C"),
          ];
          expect(
            adjacentMatches(sequencePlaylist(input), "album"),
            `counts Album A=${a}, Album B=${b}, Album C=${c}`,
          ).toBe(0);
        }
      }
    }
  });

  // Coverage instrumentation on the shared CI runner is materially slower
  // than production execution. Keep the 10k stress case, but give the
  // instrumented assertion enough headroom to measure correctness instead of
  // runner contention.
  test("handles 10,000 tracks without dropping or deduplicating rows", { timeout: 30_000 }, () => {
    const input = Array.from({ length: 10_000 }, (_, index) => track(
      `large-${index}`,
      `Artist ${index % 250}`,
      `Album ${index % 600}`,
      {
        genre: `genre-${index % 12}`,
        year: 1960 + (index % 65),
        durationMs: 120_000 + (index % 360) * 1_000,
        bpm: 70 + (index % 130),
        key: `${(index % 12) + 1}${index % 2 === 0 ? "A" : "B"}`,
      },
    ));

    const output = sequencePlaylistRows(input);

    expect(output).toHaveLength(input.length);
    expect(new Set(output.map((row) => row.sourceIndex)).size).toBe(input.length);
    expect(adjacentMatches(output.map((row) => row.track), "artist")).toBe(0);
  });
});
