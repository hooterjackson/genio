import { describe, expect, test } from "vitest";
import {
  sequencePlaylist,
  sequencePlaylistRows,
  shouldSequencePlaylist,
  type PlaylistSequenceTrack,
} from "../lib/playlist-sequencing.ts";

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

  test("handles 10,000 tracks without dropping or deduplicating rows", { timeout: 10_000 }, () => {
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
