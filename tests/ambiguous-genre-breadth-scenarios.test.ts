import { afterEach, describe, expect, test, vi } from "vitest";
import scenarios from "./fixtures/ambiguous-genre-breadth-scenarios.json";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  canonicalBriefForRequest,
  deterministicBriefFallback,
} from "../server/brief-policy.ts";
import { interpretPrompt } from "../server/openai.ts";
import {
  artistDiversityResearchInstruction,
  briefShouldDiversifyArtists,
  desiredPlaylistArtistCount,
  selectRankedPlaylistRows,
} from "../lib/playlist-selection.ts";

type SemanticIntent = "genre" | "theme" | "media" | "genre_and_theme" | "direct_artist";

interface Scenario {
  id: string;
  category: string;
  prompt: string;
  requestedTrackCount: number;
  subjectEntities: string[];
  relationship: string;
  semanticIntent: SemanticIntent;
  expectedTerms: string[];
  forbiddenTerms: string[];
  expectArtistDiversity: boolean;
}

const fixture = scenarios as unknown as {
  schemaVersion: number;
  purpose: string;
  scenarios: Scenario[];
};

function normalized(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("en-US");
}

function interpretedBrief(scenario: Scenario): PlaylistBrief {
  return {
    title: scenario.subjectEntities.join(" + ").slice(0, 60),
    description: "A source-backed selection within the requested musical scope.",
    mode: "curated",
    subjectEntities: scenario.subjectEntities,
    relationship: scenario.relationship,
    include: ["Use released recordings that satisfy the confirmed subject and relationship."],
    exclude: [],
    versionPolicy: "one canonical studio recording",
    evidencePolicy: "cited editorial sources",
    orderingPolicy: "editorial flow",
    targetSize: { min: 50, max: 100 },
    ambiguities: [],
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("ambiguous genre and artist-breadth adversarial corpus", () => {
  test("is a stable, broad corpus with explicit semantic contrast cases", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.purpose).toContain("No provider calls");
    expect(fixture.scenarios).toHaveLength(44);
    expect(new Set(fixture.scenarios.map((scenario) => scenario.id)).size).toBe(44);
    expect(new Set(fixture.scenarios.map((scenario) => scenario.category))).toEqual(new Set([
      "ambiguous_genre",
      "explicit_theme",
      "mixed_genre_theme",
      "geographic_genre",
      "direct_artist_exception",
      "esoteric_polysemy",
    ]));
  });

  test.each(fixture.scenarios)("$id preserves count, semantic scope, and breadth policy", (scenario) => {
    const brief = canonicalBriefForRequest({
      prompt: scenario.prompt,
      requestedTrackCount: scenario.requestedTrackCount,
    }, interpretedBrief(scenario));
    const positiveScope = normalized([
      ...brief.subjectEntities,
      brief.relationship,
      ...brief.include,
    ].join(" "));

    expect(brief.targetSize).toEqual({
      min: scenario.requestedTrackCount,
      max: scenario.requestedTrackCount,
    });
    scenario.expectedTerms.forEach((term) => expect(positiveScope).toContain(normalized(term)));
    scenario.forbiddenTerms.forEach((term) => expect(positiveScope).not.toContain(normalized(term)));
    expect(briefShouldDiversifyArtists(brief)).toBe(scenario.expectArtistDiversity);
    if (scenario.expectArtistDiversity) {
      expect(artistDiversityResearchInstruction(brief, scenario.requestedTrackCount))
        .toMatch(/multi-artist curated scope.*distinct credited recording artists/iu);
    } else {
      expect(artistDiversityResearchInstruction(brief, scenario.requestedTrackCount)).toBe("");
    }
  });

  test.each(fixture.scenarios.filter((scenario) => scenario.semanticIntent === "theme"))(
    "$id keeps an explicit about/title request thematic in provider fallback",
    (scenario) => {
      const fallback = deterministicBriefFallback({
        prompt: scenario.prompt,
        requestedTrackCount: scenario.requestedTrackCount,
      });
      expect(fallback.relationship).toMatch(/lyrical|thematic/iu);
      expect(fallback.relationship).not.toMatch(/genre/iu);
    },
  );

  test("brief interpretation instructions require musical polysemy resolution and artist breadth", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-ambiguous-genres");
    let requestBody: any;
    const house = fixture.scenarios.find((scenario) => scenario.id === "AG-G01")!;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: "response-ambiguous-genre-contract",
        model: "test-model",
        usage: { input_tokens: 100, output_tokens: 100 },
        output_text: JSON.stringify(interpretedBrief(house)),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    await interpretPrompt(house.prompt, "test-model");

    expect(requestBody.instructions).toMatch(/resolve musical polysemy/iu);
    expect(requestBody.instructions).toMatch(/musical classification, not a literal keyword theme/iu);
    expect(requestBody.instructions).toMatch(/never convert a genre request into title or lyric keyword matching/iu);
    expect(requestBody.instructions).toMatch(/broad genre or scene playlist.*artist breadth/iu);
    expect(requestBody.instructions).toMatch(/one or two artists/iu);
  });

  test("a broad geographic genre uses its reserve to avoid a two-artist playlist", () => {
    const scenario = fixture.scenarios.find((row) => row.id === "AG-P01")!;
    const brief = canonicalBriefForRequest({
      prompt: scenario.prompt,
      requestedTrackCount: scenario.requestedTrackCount,
    }, interpretedBrief(scenario));
    const ranked = [
      ...Array.from({ length: 30 }, (_, index) => ({ id: `a-${index}`, artist: "Artist A" })),
      ...Array.from({ length: 20 }, (_, index) => ({ id: `b-${index}`, artist: "Artist B" })),
      ...Array.from({ length: 35 }, (_, index) => ({ id: `other-${index}`, artist: `Artist ${index + 3}` })),
    ];
    const selection = selectRankedPlaylistRows(ranked, 50, {
      diversifyArtists: briefShouldDiversifyArtists(brief),
    });
    const counts = selection.selected.reduce<Map<string, number>>((map, row) => {
      map.set(row.artist, (map.get(row.artist) ?? 0) + 1);
      return map;
    }, new Map());

    expect(selection.selected).toHaveLength(50);
    expect(selection.overflow).toHaveLength(35);
    expect(counts.size).toBeGreaterThanOrEqual(10);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(8);
  });

  test("the terse friend report cannot survive as a literal house interpretation", () => {
    const genreScenario = fixture.scenarios.find((row) => row.id === "AG-G09")!;
    const literalScenario = fixture.scenarios.find((row) => row.id === "AG-T01")!;
    const brief = canonicalBriefForRequest({
      prompt: genreScenario.prompt,
      requestedTrackCount: genreScenario.requestedTrackCount,
    }, interpretedBrief(literalScenario));
    const positiveScope = normalized([
      ...brief.subjectEntities,
      brief.relationship,
      ...brief.include,
    ].join(" "));

    expect(brief.subjectEntities).toContain("House music");
    expect(brief.title).toBe("House Music");
    expect(positiveScope).toContain("house music genre");
    expect(positiveScope).not.toContain("physical houses");
    expect(brief.exclude.join(" ")).toMatch(/merely because.*houses.*homes.*architecture/iu);
  });

  test("the terse French-jazz report uses the reserve instead of returning two artists", () => {
    const scenario = fixture.scenarios.find((row) => row.id === "AG-P09")!;
    const brief = canonicalBriefForRequest({
      prompt: scenario.prompt,
      requestedTrackCount: scenario.requestedTrackCount,
    }, interpretedBrief(scenario));
    const ranked = [
      ...Array.from({ length: 13 }, (_, index) => ({ id: `django-${index}`, artist: "Django Reinhardt" })),
      ...Array.from({ length: 12 }, (_, index) => ({ id: `petrucciani-${index}`, artist: "Michel Petrucciani" })),
      ...Array.from({ length: 25 }, (_, index) => ({ id: `reserve-${index}`, artist: `French Jazz Artist ${index + 1}` })),
    ];
    const selection = selectRankedPlaylistRows(ranked, 25, {
      diversifyArtists: briefShouldDiversifyArtists(brief),
      minimumDistinctArtists: desiredPlaylistArtistCount(brief, 25),
    });
    const counts = selection.selected.reduce<Map<string, number>>((map, row) => {
      map.set(row.artist, (map.get(row.artist) ?? 0) + 1);
      return map;
    }, new Map());

    expect(selection.selected).toHaveLength(25);
    expect(counts.size).toBeGreaterThanOrEqual(10);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(4);
    expect(artistDiversityResearchInstruction(brief, 25))
      .toContain("at least 10 distinct credited recording artists");
  });
});
