import { describe, expect, test } from "vitest";
import type { PlaylistBrief } from "../shared/types.ts";
import { canonicalBriefForRequest } from "../server/brief-policy.ts";
import {
  adaptiveDiscoveryPlan,
  selectWithConstraintLadder,
  terminalPipelineOutcome,
} from "../server/pipeline-v2-policy.ts";
import { createSelectionPlanV2, pipelineV2Route } from "../server/selection-plan-v2.ts";
import {
  briefShouldDiversifyArtists,
  desiredPlaylistArtistCount,
  playlistArtistKey,
  selectRankedPlaylistRows,
} from "../lib/playlist-selection.ts";

function brief(input: {
  title: string;
  subjects: string[];
  relationship: string;
  include?: string[];
  exclude?: string[];
  count?: number;
  versionPolicy?: string;
  orderingPolicy?: string;
}): PlaylistBrief {
  const count = input.count ?? 50;
  return {
    title: input.title,
    description: `A broad, source-backed survey of ${input.title}.`,
    mode: "curated",
    subjectEntities: input.subjects,
    relationship: input.relationship,
    include: input.include ?? [`Recordings that ${input.relationship}.`],
    exclude: input.exclude ?? [],
    versionPolicy: input.versionPolicy ?? "Prefer one canonical studio recording per song.",
    evidencePolicy: "Require track-scope editorial or historical evidence appropriate to the requested relationship.",
    orderingPolicy: input.orderingPolicy ?? "Intermix artists and albums in a coherent editorial sequence.",
    targetSize: { min: count, max: count },
    ambiguities: [],
  };
}

function hardConstraintText(plan: ReturnType<typeof createSelectionPlanV2>): string {
  return plan.constraints
    .filter(({ kind }) => kind === "hard")
    .flatMap(({ values }) => values)
    .join(" ");
}

describe("Pipeline V2 provider-free scenario matrix", () => {
  test("Brazilian disco keeps only user-stated hard scope and never creates contradictory exclusions", () => {
    const discoBrief: PlaylistBrief = {
      title: "Brazilian Disco Classics",
      description: "Focus on canonical recordings, club staples, and era-defining cuts.",
      mode: "curated",
      subjectEntities: ["Brazilian disco"],
      relationship: "iconic tracks from",
      include: [
        "Disco recordings by Brazilian artists",
        "Brazil-linked disco classics from the late 1970s and early 1980s",
        "Widely recognized dancefloor staples",
      ],
      exclude: [
        "Non-disco Brazilian music",
        "Non-Brazilian disco unrelated to Brazil",
      ],
      versionPolicy: "Prefer canonical original-era recordings.",
      evidencePolicy: "Require cited Brazilian disco histories and specialist editorial sources.",
      orderingPolicy: "Order by historical prominence and dancefloor recognition.",
      targetSize: { min: 50, max: 50 },
      ambiguities: [],
    };
    const plan = createSelectionPlanV2({
      prompt: "Iconic Brazilian disco songs",
      brief: discoBrief,
      storefront: "us",
    });
    const hardRequired = plan.constraints.filter((constraint) => constraint.kind === "hard" && constraint.operator === "require");
    const hardExcluded = plan.constraints.filter((constraint) => constraint.kind === "hard" && constraint.operator === "exclude");

    expect(plan.intents).toEqual(expect.arrayContaining(["genre_scene", "editorial_ranking"]));
    expect(plan.intents).not.toEqual(expect.arrayContaining(["mood_activity", "artist_catalogue"]));
    expect(hardRequired).toEqual(expect.arrayContaining([
      expect.objectContaining({ axis: "genre", values: expect.arrayContaining(["disco"]) }),
      expect.objectContaining({ axis: "geography", values: expect.arrayContaining(["Brazilian"]) }),
    ]));
    for (const excluded of hardExcluded) {
      const required = hardRequired.find((constraint) => constraint.axis === excluded.axis);
      expect(excluded.values.some((value) => required?.values.some((item) => item.toLowerCase() === value.toLowerCase()))).toBe(false);
    }
    expect(plan.constraints.flatMap((constraint) => constraint.values)).not.toEqual(expect.arrayContaining([
      "Non-disco Brazilian music",
      "Non-Brazilian disco unrelated to Brazil",
    ]));
    expect(plan.constraints).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ axis: "activity", values: expect.arrayContaining(["study"]) }),
      expect.objectContaining({ axis: "venue", values: expect.arrayContaining(["club"]) }),
    ]));
    expect(plan.diversityGoals.minimumDistinctArtists).toBeGreaterThan(2);
    expect(plan.diversityGoals.maximumTracksPerArtist).toBeLessThan(50);
  });

  test("plain Brazilian disco is not silently upgraded by generated editorial prose", () => {
    const plan = createSelectionPlanV2({
      prompt: "Brazilian disco songs",
      brief: {
        title: "Brazilian Disco Essentials",
        description: "A representative survey of important recordings by Brazilian artists.",
        mode: "curated",
        subjectEntities: ["Brazilian disco"],
        relationship: "represents essential Brazilian disco",
        include: ["Iconic dancefloor classics"],
        exclude: [],
        versionPolicy: "Prefer canonical studio recordings.",
        evidencePolicy: "Require cited specialist sources.",
        orderingPolicy: "Intermix artists.",
        targetSize: { min: 50, max: 50 },
        ambiguities: [],
      },
    });

    expect(plan.intents).toEqual(["genre_scene"]);
    expect(plan.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ axis: "genre", kind: "hard", values: expect.arrayContaining(["disco"]) }),
      expect.objectContaining({ axis: "geography", kind: "hard", values: expect.arrayContaining(["Brazilian"]) }),
      expect.objectContaining({ axis: "relationship", kind: "soft", operator: "prefer" }),
    ]));
  });

  test("generated exhaustive wording cannot reroute a fixed-count curated request", () => {
    const plan = createSelectionPlanV2({
      prompt: "Brazilian disco songs",
      brief: {
        title: "Complete Brazilian Disco",
        description: "All essential tracks from the complete Brazilian disco catalogue.",
        mode: "curated",
        subjectEntities: ["Brazilian disco"],
        relationship: "represents all important Brazilian disco recordings",
        include: ["Complete survey of all essential tracks"],
        exclude: [],
        versionPolicy: "Prefer canonical studio recordings.",
        evidencePolicy: "Require cited specialist sources.",
        orderingPolicy: "Intermix artists.",
        targetSize: { min: 50, max: 50 },
        ambiguities: [],
      },
    });

    expect(plan.intents).not.toContain("exhaustive");
    expect(pipelineV2Route(plan)).toBe("curated_catalog");
  });

  test("an explicit reference-artist exclusion remains a hard user constraint", () => {
    const plan = createSelectionPlanV2({
      prompt: "Songs like Radiohead, but do not include Radiohead",
      brief: {
        title: "Beyond Radiohead",
        description: "Artists with a similar musical character.",
        mode: "curated",
        subjectEntities: ["Radiohead"],
        relationship: "sounds stylistically similar to Radiohead",
        include: [],
        exclude: ["Radiohead"],
        versionPolicy: "Prefer canonical studio recordings.",
        evidencePolicy: "Require track-level stylistic support.",
        orderingPolicy: "Intermix artists.",
        targetSize: { min: 25, max: 25 },
        ambiguities: [],
      },
    });

    expect(plan.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        axis: "relationship",
        kind: "hard",
        operator: "exclude",
        values: ["Radiohead"],
      }),
    ]));
  });

  test.each([
    {
      name: "American drill",
      prompt: "50 foundational American drill tracks across its major US scenes",
      brief: brief({
        title: "American Drill",
        subjects: ["American drill"],
        relationship: "is foundational to an American drill genre or scene",
        include: ["American drill recordings across Chicago, New York, and other documented US scenes."],
      }),
      intents: ["genre_scene", "editorial_ranking"],
      hardTerms: ["drill", "American"],
    },
    {
      name: "Berlin techno",
      prompt: "50 influential Berlin techno tracks across the major eras",
      brief: brief({
        title: "Berlin Techno",
        subjects: ["Berlin techno"],
        relationship: "is influential in the Berlin techno genre and scene",
        include: ["Berlin club, venue, and label histories across the major eras."],
      }),
      intents: ["genre_scene", "editorial_ranking"],
      hardTerms: ["Berlin", "techno"],
    },
    {
      name: "Brazilian funk / funk carioca",
      prompt: "50 essential Brazilian funk and funk carioca tracks",
      brief: brief({
        title: "Funk Carioca",
        subjects: ["Brazilian funk", "funk carioca", "baile funk"],
        relationship: "is representative of Brazilian funk, funk carioca, or baile funk",
        include: ["Brazilian funk / funk carioca recordings grounded in the documented Rio scene."],
      }),
      intents: ["genre_scene", "editorial_ranking"],
      hardTerms: ["baile funk", "Brazilian"],
    },
    {
      name: "influential footwork",
      prompt: "50 influential footwork tracks from the Chicago scene and its successors",
      brief: brief({
        title: "Influential Footwork",
        subjects: ["footwork", "Chicago footwork"],
        relationship: "is influential in footwork music and its documented scene",
        include: ["Chicago footwork and documented successor scenes."],
      }),
      intents: ["genre_scene", "editorial_ranking"],
      hardTerms: ["footwork", "Chicago"],
    },
    {
      name: "women who shaped Detroit techno",
      prompt: "50 recordings highlighting women who shaped Detroit techno",
      brief: brief({
        title: "Women Who Shaped Detroit Techno",
        subjects: ["Detroit techno", "women in Detroit techno"],
        relationship: "is a documented contribution by a woman who shaped Detroit techno",
        include: ["Women artists and producers with documented importance to the Detroit techno scene."],
      }),
      intents: ["genre_scene", "editorial_ranking"],
      hardTerms: ["Women", "Detroit", "techno"],
    },
  ])("retains the full $name scope as hard selection criteria", (scenario) => {
    const plan = createSelectionPlanV2({ prompt: scenario.prompt, brief: scenario.brief });
    expect(pipelineV2Route(plan)).toBe("curated_catalog");
    expect(plan.intents).toEqual(expect.arrayContaining(scenario.intents));
    expect(plan.requestedTrackCount).toBe(50);
    const hardText = hardConstraintText(plan);
    scenario.hardTerms.forEach((term) => expect(hardText).toContain(term));
    expect(plan.diversityGoals.minimumDistinctArtists).toBeGreaterThan(2);
    expect(plan.diversityGoals.maximumTracksPerArtist).toBeLessThan(50);
  });

  test("house music semantic repair rejects literal-house model drift", () => {
    const staleLiteralBrief = brief({
      title: "Songs About Houses",
      subjects: ["houses", "homes"],
      relationship: "has a title or lyric about a physical house",
      include: ["Songs about residential buildings."],
      count: 25,
    });
    const repaired = canonicalBriefForRequest({
      prompt: "25 classic house tracks for a late-night dance floor",
      requestedTrackCount: 25,
    }, staleLiteralBrief);
    const plan = createSelectionPlanV2({
      prompt: "25 classic house tracks for a late-night dance floor",
      brief: repaired,
    });

    expect(repaired.subjectEntities).toContain("House music");
    expect(repaired.relationship).toContain("house music genre");
    expect(repaired.include.join(" ")).not.toContain("residential buildings");
    expect(repaired.exclude.join(" ")).toMatch(/merely because.*title.*houses/iu);
    expect(plan.intents).toContain("genre_scene");
  });

  test("French jazz is a broad multi-artist scope rather than a two-artist catalogue", () => {
    const frenchJazz = brief({
      title: "French Jazz Across Eras",
      subjects: ["French jazz"],
      relationship: "is representative of the French jazz scene",
      include: ["French jazz artists across multiple eras, cities, and stylistic scenes."],
    });
    const plan = createSelectionPlanV2({ prompt: "50 French jazz tracks across eras and scenes", brief: frenchJazz });
    expect(briefShouldDiversifyArtists(frenchJazz)).toBe(true);
    expect(desiredPlaylistArtistCount(frenchJazz, 50)).toBe(20);
    expect(plan.diversityGoals.minimumDistinctArtists).toBe(10);
    expect(plan.diversityGoals.maximumTracksPerArtist).toBe(8);

    const pool = [
      ...Array.from({ length: 40 }, (_, index) => ({ id: `a-${index}`, artist: "Artist A" })),
      ...Array.from({ length: 40 }, (_, index) => ({ id: `b-${index}`, artist: "Artist B" })),
      ...Array.from({ length: 50 }, (_, index) => ({ id: `other-${index}`, artist: `Artist ${index + 3}` })),
    ];
    const selection = selectRankedPlaylistRows(pool, 50, {
      diversifyArtists: true,
      maximumInitialArtistShare: 0.15,
      minimumDistinctArtists: desiredPlaylistArtistCount(frenchJazz, 50),
    });
    const artistCounts = new Map<string, number>();
    selection.selected.forEach((row) => {
      const key = playlistArtistKey(row.artist);
      artistCounts.set(key, (artistCounts.get(key) ?? 0) + 1);
    });
    expect(selection.selected).toHaveLength(50);
    expect(artistCounts.size).toBeGreaterThanOrEqual(20);
    expect(Math.max(...artistCounts.values())).toBeLessThanOrEqual(8);
  });

  test("dark ambient for sleep keeps genre, mood, and activity as simultaneous axes", () => {
    const darkAmbient = brief({
      title: "Dark Ambient for Sleep",
      subjects: ["dark ambient"],
      relationship: "is dark ambient music suitable for sleep",
      include: ["Dark ambient recordings.", "Suitable for sleep."],
    });
    const plan = createSelectionPlanV2({ prompt: "50 dark ambient tracks for sleep", brief: darkAmbient });
    expect(plan.intents).toEqual(expect.arrayContaining(["genre_scene", "mood_activity"]));
    expect(plan.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "hard", axis: "mood" }),
      expect.objectContaining({ kind: "hard", axis: "activity" }),
    ]));
  });

  test("similarity excludes the reference artist while retaining multidimensional similarity", () => {
    const similarity = brief({
      title: "Radiohead-adjacent",
      subjects: ["Radiohead"],
      relationship: "is stylistically similar to the reference artist",
      include: ["Similar production, harmony, era, and vocal style."],
      exclude: ["Reference artist is a style seed; exclude recordings by: Radiohead"],
      versionPolicy: "Clean versions only.",
    });
    const plan = createSelectionPlanV2({
      prompt: "Songs like Radiohead in production, harmony, era, and vocal style, but do not include Radiohead",
      brief: similarity,
    });
    expect(plan.intents).toContain("similarity");
    expect(plan.referenceRecordings).toEqual(["Radiohead"]);
    expect(plan.similarityDimensions).toEqual(expect.arrayContaining(["production", "harmony", "era", "vocal_style"]));
    expect(plan.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "hard", operator: "exclude", values: [expect.stringContaining("Radiohead")] }),
    ]));
  });

  test("multilingual aliases and language requirements survive normalization", () => {
    const multilingual = brief({
      title: "Algerian Raï Across Scripts",
      subjects: ["raï", "rai", "الراي"],
      relationship: "is part of the Algerian raï scene",
      include: ["French-language and Arabic-language Algerian raï (rai / الراي) recordings."],
    });
    const plan = createSelectionPlanV2({
      prompt: "50 Algerian raï / rai / الراي tracks in Arabic and French",
      brief: multilingual,
    });
    const hardLanguage = plan.constraints.filter((constraint) => (
      constraint.kind === "hard" && constraint.axis === "language"
    ));
    expect(hardLanguage).toHaveLength(1);
    expect(hardLanguage[0]).toEqual(expect.objectContaining({
      operator: "require",
      values: expect.arrayContaining(["Arabic", "French"]),
    }));
    expect(plan.geographyConstraints).toEqual(expect.arrayContaining([
      { value: "Arabic", relationship: "language" },
      { value: "French", relationship: "language" },
    ]));
    expect(plan.contentPolicy.languages.join(" ")).toMatch(/French-language.*Arabic-language/iu);
  });

  test.each([25, 50, 100, 200, 300])(
    "%i-track targets retain exact size and plan a conservative qualified reserve",
    (count) => {
      const scopedBrief = brief({
        title: "Berlin Techno",
        subjects: ["Berlin techno"],
        relationship: "is representative of the Berlin techno scene",
        count,
      });
      const plan = createSelectionPlanV2({ prompt: `${count} Berlin techno tracks`, brief: scopedBrief });
      const discovery = adaptiveDiscoveryPlan({
        target: count,
        qualified: 0,
        attempted: 0,
        observedQualified: 0,
      });
      expect(plan.requestedTrackCount).toBe(count);
      expect(plan.minimumQualifiedTrackCount).toBe(count);
      expect(plan.reserveTrackCount).toBe(Math.max(5, Math.ceil(count * 0.1)));
      expect(discovery.qualifiedReserve).toBe(plan.reserveTrackCount);
      expect(discovery.rawDiscoveryGoal).toBe(Math.ceil((count + plan.reserveTrackCount) / 0.5));
    },
  );

  test("a genuinely narrow hard scope returns a typed partial instead of padding or failing", () => {
    const result = selectWithConstraintLadder({
      target: 25,
      constraints: [
        { id: "required_scene", kind: "hard", relaxationRank: null },
        { id: "required_language", kind: "hard", relaxationRank: null },
        { id: "artist_concentration", kind: "soft", relaxationRank: 1 },
      ],
      candidates: [
        { value: "qualified-1", violations: [] },
        { value: "qualified-2", violations: ["artist_concentration"] },
        { value: "qualified-3", violations: ["artist_concentration"] },
        { value: "wrong-scene", violations: ["required_scene"] },
        { value: "wrong-language", violations: ["required_language"] },
      ],
    });
    expect(result).toEqual({
      outcome: "partial_policy_conflict",
      selected: ["qualified-1", "qualified-2", "qualified-3"],
      relaxedSoftConstraints: ["artist_concentration"],
    });
    expect(terminalPipelineOutcome({ failureOrigin: "policy", safeTrackCount: result.selected.length }))
      .toBe("partial_policy_conflict");
  });
});
