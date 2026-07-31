import { describe, expect, test } from "vitest";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  compileFixedTrackList,
  fixedTrackListEntryIndex,
} from "../server/fixed-track-list-policy.ts";
import { createSelectionPlanV2 } from "../server/selection-plan-v2.ts";

const fixedBrief: PlaylistBrief = {
  mode: "curated",
  title: "Pop Classics 3-Pack",
  description: "The exact original studio recordings in the requested order.",
  subjectEntities: ["Michael Jackson", "Madonna", "Earth, Wind & Fire"],
  relationship: "Exact original studio recordings in a user-specified order",
  include: [
    "Michael Jackson — Billie Jean",
    "Madonna — La Isla Bonita",
    "Earth, Wind & Fire — September",
  ],
  exclude: ["remixes", "live versions", "radio edits", "covers", "re-recordings", "duplicates"],
  versionPolicy: "Use only the original studio recording of each listed song; do not substitute alternate versions.",
  evidencePolicy: "Verify track identity by canonical song title, primary artist, and original studio release version.",
  orderingPolicy: "Keep the three tracks in the exact order provided by the user.",
  targetSize: { min: 3, max: 3 },
  ambiguities: [],
};

describe("fixed track list policy", () => {
  test("compiles exact artist/title membership in immutable source order", () => {
    expect(compileFixedTrackList(fixedBrief)).toEqual([
      { artist: "Michael Jackson", title: "Billie Jean" },
      { artist: "Madonna", title: "La Isla Bonita" },
      { artist: "Earth, Wind & Fire", title: "September" },
    ]);

    const plan = createSelectionPlanV2({
      prompt: fixedBrief.description,
      brief: fixedBrief,
    });
    expect(plan.scopeKind).toBe("fixed_track_list");
    expect(plan.fixedTrackList).toEqual(compileFixedTrackList(fixedBrief));
    expect(plan.diversityGoals).toMatchObject({
      minimumDistinctArtists: null,
      minimumDistinctAlbums: null,
      minimumDistinctEras: null,
      maximumTracksPerArtist: null,
      maximumTracksPerAlbum: null,
    });
  });

  test("accepts quoted title-by-artist identities emitted by brief compilation", () => {
    const compiled = compileFixedTrackList({
      ...fixedBrief,
      include: [
        "\"Take on Me\" by a-ha",
        "\"Africa\" by Toto",
        "\"Like a Prayer\" by Madonna",
      ],
      relationship: "Limit to the three explicitly named tracks",
      orderingPolicy: "Preserve the user’s listed order.",
    });
    expect(compiled).toEqual([
      { artist: "a-ha", title: "Take on Me" },
      { artist: "Toto", title: "Africa" },
      { artist: "Madonna", title: "Like a Prayer" },
    ]);
  });

  test("separates a compiler-added recording-version suffix from catalog identity", () => {
    const compiled = compileFixedTrackList({
      ...fixedBrief,
      include: [
        "Michael Jackson — Billie Jean (original studio recording)",
        "Madonna — La Isla Bonita (original studio version)",
        "Earth, Wind & Fire — September (studio recording)",
      ],
    });
    expect(compiled).toEqual([
      { artist: "Michael Jackson", title: "Billie Jean" },
      { artist: "Madonna", title: "La Isla Bonita" },
      { artist: "Earth, Wind & Fire", title: "September" },
    ]);
  });

  test("preserves genuine title parentheticals", () => {
    const compiled = compileFixedTrackList({
      ...fixedBrief,
      include: [
        "Rupert Holmes — Escape (The Piña Colada Song)",
        "Stevie Wonder — Living for the City",
        "Earth, Wind & Fire — September",
      ],
    });
    expect(compiled?.[0]).toEqual({
      artist: "Rupert Holmes",
      title: "Escape (The Piña Colada Song)",
    });
  });

  test("does not infer a closed list without exact count and explicit source order", () => {
    expect(compileFixedTrackList({
      ...fixedBrief,
      relationship: "Original studio recordings selected by the user",
      orderingPolicy: "Use a smooth editorial flow.",
    })).toBeNull();
    expect(compileFixedTrackList({
      ...fixedBrief,
      targetSize: { min: 3, max: 5 },
    })).toBeNull();
  });

  test("requires both the candidate and Apple identity to match the same entry", () => {
    const entries = compileFixedTrackList(fixedBrief)!;
    expect(fixedTrackListEntryIndex(
      entries,
      { artist: "Michael Jackson", title: "Billie Jean" },
      { artistName: "Michael Jackson", name: "Billie Jean" },
    )).toBe(0);
    expect(fixedTrackListEntryIndex(
      entries,
      { artist: "Michael Jackson", title: "Billie Jean" },
      { artistName: "Michael Jackson", name: "Chicago" },
    )).toBe(-1);
    expect(fixedTrackListEntryIndex(
      entries,
      { artist: "Michael Jackson", title: "Chicago" },
      { artistName: "Michael Jackson", name: "Chicago" },
    )).toBe(-1);
  });
});
