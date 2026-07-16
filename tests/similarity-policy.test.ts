import { describe, expect, test } from "vitest";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  applySimilaritySeedPolicy,
  excludedReferenceArtists,
  isExcludedReferenceArtist,
  similarityResearchInstruction,
} from "../server/similarity-policy.ts";

function brief(overrides: Partial<PlaylistBrief> = {}): PlaylistBrief {
  return {
    title: "Radiohead-adjacent",
    description: "Music for Radiohead listeners.",
    mode: "curated",
    subjectEntities: ["Radiohead"],
    relationship: "recorded by",
    include: [],
    exclude: [],
    versionPolicy: "one canonical recording",
    evidencePolicy: "cited editorial sources",
    orderingPolicy: "editorial flow",
    targetSize: { min: 50, max: 50 },
    ambiguities: [],
    ...overrides,
  };
}

describe("reference-artist similarity policy", () => {
  test("turns a similar-to artist into an excluded style seed by default", () => {
    const result = applySimilaritySeedPolicy(
      "Make a playlist of music that sounds like Radiohead",
      brief(),
    );

    expect(result.relationship).toBe("stylistically similar to the reference artist");
    expect(result.include).toContain(
      "Recordings by other artists that are stylistically similar to Radiohead",
    );
    expect(excludedReferenceArtists(result)).toEqual(["Radiohead"]);
    expect(isExcludedReferenceArtist(result, "RADIOHEAD")).toBe(true);
    expect(similarityResearchInstruction(result)).toContain(
      "return recordings by other artists",
    );
  });

  test("removes filler entities and unwraps repeated similarity-query fragments", () => {
    const result = applySimilaritySeedPolicy(
      "12 tracks that sound like Radiohead but are by other artists",
      brief({
        subjectEntities: [
          "Radiohead",
          "other artists",
          "tracks that sound like Radiohead",
        ],
      }),
    );

    expect(result.subjectEntities).toEqual(["Radiohead"]);
    expect(excludedReferenceArtists(result)).toEqual(["Radiohead"]);
    expect(result.exclude).toEqual([
      "Reference artist is a style seed; exclude recordings by: Radiohead",
    ]);
    expect(result.include).toContain(
      "Recordings by other artists that are stylistically similar to Radiohead",
    );
  });

  test("unwraps title-cased similarity fragments without losing artist casing", () => {
    const result = applySimilaritySeedPolicy(
      "Tracks that sound like Radiohead but are by other artists",
      brief({
        subjectEntities: [
          "Tracks That Sound Like Radiohead But Are By Other Artists",
          "Other Artists",
        ],
      }),
    );

    expect(result.subjectEntities).toEqual(["Radiohead"]);
    expect(excludedReferenceArtists(result)).toEqual(["Radiohead"]);
  });

  test("keeps multiple real references while ignoring a later filler clause", () => {
    const result = applySimilaritySeedPolicy(
      "Music for fans of Radiohead and Björk, but by other artists",
      brief({
        subjectEntities: ["Radiohead", "Björk", "other artists"],
      }),
    );

    expect(result.subjectEntities).toEqual(["Radiohead", "Björk"]);
    expect(excludedReferenceArtists(result)).toEqual(["Radiohead", "Björk"]);
  });

  test("excludes only the artist used after the similarity relationship", () => {
    const result = applySimilaritySeedPolicy(
      "Indie rock that sounds like Radiohead",
      brief({ subjectEntities: ["indie rock", "Radiohead"] }),
    );

    expect(excludedReferenceArtists(result)).toEqual(["Radiohead"]);
    expect(isExcludedReferenceArtist(result, "indie rock")).toBe(false);
  });

  test("treats an adjacent-to artist as a reference rather than the answer", () => {
    const result = applySimilaritySeedPolicy(
      "Glitch hop adjacent to Prefuse 73",
      brief({ subjectEntities: ["glitch hop", "Prefuse 73"] }),
    );

    expect(excludedReferenceArtists(result)).toEqual(["Prefuse 73"]);
    expect(result.include).toContain(
      "Recordings by other artists that are stylistically similar to Prefuse 73",
    );
  });

  test("honors an explicit exclusion when the reference precedes similar-mode wording", () => {
    const result = applySimilaritySeedPolicy(
      "I like Prefuse 73 and want other artists operating in a similar mode. Don't give me Prefuse 73 songs because I know those.",
      brief({ subjectEntities: ["Prefuse 73", "glitch hop", "Warp Records"] }),
    );

    expect(excludedReferenceArtists(result)).toEqual(["Prefuse 73"]);
  });

  test("does not mistake a preceding style reference for an inclusion request", () => {
    const result = applySimilaritySeedPolicy(
      "I like Radiohead and want other artists operating in a similar mode",
      brief(),
    );
    expect(excludedReferenceArtists(result)).toEqual(["Radiohead"]);

    const shorthand = applySimilaritySeedPolicy(
      "A Radiohead-style playlist for late-night work",
      brief(),
    );
    expect(excludedReferenceArtists(shorthand)).toEqual(["Radiohead"]);
  });

  test("excludes collaborations credited to the reference artist without excluding tribute names", () => {
    const scoped = applySimilaritySeedPolicy(
      "Music that sounds like Radiohead",
      brief(),
    );

    expect(isExcludedReferenceArtist(scoped, "Radiohead feat. Other Artist")).toBe(true);
    expect(isExcludedReferenceArtist(scoped, "Other Artist & Radiohead")).toBe(true);
    expect(isExcludedReferenceArtist(scoped, "Radiohead Tribute Band")).toBe(false);
  });

  test("excludes every artist in a multi-seed similarity request", () => {
    const result = applySimilaritySeedPolicy(
      "Music for fans of Radiohead and Björk",
      brief({ subjectEntities: ["Radiohead", "Björk"] }),
    );

    expect(excludedReferenceArtists(result)).toEqual(["Radiohead", "Björk"]);
  });

  test("allows the reference artist when the requester explicitly includes it", () => {
    const original = brief();
    const result = applySimilaritySeedPolicy(
      "Mix Radiohead with other artists that sound like Radiohead",
      original,
    );

    expect(result).toEqual(original);
    expect(excludedReferenceArtists(result)).toEqual([]);

    expect(applySimilaritySeedPolicy(
      "Songs that sound like Radiohead, but include two Radiohead tracks",
      original,
    )).toEqual(original);

    expect(applySimilaritySeedPolicy(
      "Radiohead songs and other music that sounds like Radiohead",
      original,
    )).toEqual(original);
  });

  test("does not alter direct artist or exhaustive discography requests", () => {
    const curated = brief({ relationship: "best recordings by" });
    expect(applySimilaritySeedPolicy("The best Radiohead songs", curated)).toEqual(curated);

    const exhaustive = brief({
      mode: "exhaustive",
      relationship: "released by",
      targetSize: null,
    });
    expect(applySimilaritySeedPolicy("Every song released by Radiohead", exhaustive))
      .toEqual(exhaustive);
  });
});
