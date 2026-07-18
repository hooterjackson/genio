import { afterEach, describe, expect, test, vi } from "vitest";
import type { PlaylistBrief } from "../shared/types.ts";
import { canonicalBriefForRequest } from "../server/brief-policy.ts";
import {
  applyMusicIntentPolicy,
  HOUSE_GENRE_INCLUDE_RULE,
  HOUSE_LITERAL_EXCLUSION_RULE,
} from "../server/music-intent-policy.ts";
import { interpretPrompt } from "../server/openai.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function adversarialLiteralInterpretation(
  overrides: Partial<PlaylistBrief> = {},
): PlaylistBrief {
  return {
    title: "Songs About Houses",
    description: "Songs whose titles or lyrics discuss houses and homes.",
    mode: "curated",
    subjectEntities: ["houses", "homes"],
    relationship: "has a lyrical or thematic relationship to physical houses",
    include: ["Songs about residential buildings"],
    exclude: [],
    versionPolicy: "one canonical studio recording",
    evidencePolicy: "cited editorial sources",
    orderingPolicy: "editorial flow",
    targetSize: { min: 50, max: 50 },
    ambiguities: [],
    ...overrides,
  };
}

describe("musical-domain intent policy", () => {
  test.each([
    "Make me a house music playlist.",
    "I want a house playlist for Saturday night.",
    "50 classic house tracks.",
    "French house classics from the 1990s.",
    "Deep house and acid house, but no live versions.",
  ])("repairs a literal model interpretation for genre request: %s", (prompt) => {
    const brief = canonicalBriefForRequest(
      { prompt, requestedTrackCount: 50 },
      adversarialLiteralInterpretation(),
    );

    expect(brief.mode).toBe("curated");
    expect(brief.targetSize).toEqual({ min: 50, max: 50 });
    expect(brief.title).toBe("House Music");
    expect(brief.subjectEntities).toContain("House music");
    expect(brief.relationship).toContain("house music genre");
    expect(brief.include).toContain(HOUSE_GENRE_INCLUDE_RULE);
    expect(brief.include).not.toContain("Songs about residential buildings");
    expect(brief.description).not.toMatch(/titles or lyrics discuss houses/iu);
    expect(brief.exclude).toContain(HOUSE_LITERAL_EXCLUSION_RULE);
  });

  test("preserves geographic and subgenre entities while replacing literal house entities", () => {
    const brief = applyMusicIntentPolicy(
      "A French house playlist with Chicago house foundations.",
      adversarialLiteralInterpretation({
        subjectEntities: ["France", "houses", "Chicago house"],
      }),
    );

    expect(brief.subjectEntities).toEqual(["France", "House music", "Chicago house"]);
  });

  test("canonicalizes a prompt-shaped fallback entity instead of researching the wrapper text", () => {
    const brief = applyMusicIntentPolicy(
      "I want a house playlist for Saturday night.",
      adversarialLiteralInterpretation({
        subjectEntities: ["house playlist for Saturday night"],
      }),
    );

    expect(brief.subjectEntities).toEqual(["House music"]);
  });

  test.each([
    "Songs about houses and homes.",
    "Architecture songs for a real-estate convention.",
    "Music from the television series House.",
    "A playlist for a house party with pop singalongs.",
    "Songs recorded in a house rather than a studio.",
  ])("does not force the genre onto an explicitly literal or non-genre request: %s", (prompt) => {
    const input = adversarialLiteralInterpretation();
    expect(applyMusicIntentPolicy(prompt, input)).toEqual(input);
  });

  test("keeps a dual request genre-scoped without banning a qualifying house track for its lyrics", () => {
    const brief = applyMusicIntentPolicy(
      "House music about houses and architecture.",
      adversarialLiteralInterpretation(),
    );

    expect(brief.subjectEntities).toContain("House music");
    expect(brief.subjectEntities).toEqual(expect.arrayContaining(["houses", "homes"]));
    expect(brief.relationship).toMatch(/house music genre.*lyrical or thematic/iu);
    expect(brief.include).toContain("Songs about residential buildings");
    expect(brief.exclude).toContain(HOUSE_LITERAL_EXCLUSION_RULE);
    expect(HOUSE_LITERAL_EXCLUSION_RULE).toContain("merely because");
  });

  test("preserves a subgenre plus literal theme and removes a stale ban on the genre", () => {
    const brief = applyMusicIntentPolicy(
      "French house about Parisian apartments and domestic life.",
      adversarialLiteralInterpretation({
        subjectEntities: ["French house", "apartments"],
        exclude: ["Exclude house music and dance tracks"],
      }),
    );

    expect(brief.subjectEntities).toEqual(expect.arrayContaining(["House music", "French house", "apartments"]));
    expect(brief.relationship).toMatch(/house music genre.*lyrical or thematic/iu);
    expect(brief.exclude.join(" ")).not.toMatch(/exclude house music/iu);
  });

  test("is idempotent when both interpretation and API canonicalization apply it", () => {
    const prompt = "A soulful house music playlist.";
    const first = applyMusicIntentPolicy(prompt, adversarialLiteralInterpretation());
    const second = applyMusicIntentPolicy(prompt, first);

    expect(second).toEqual(first);
    expect(second.include.filter((rule) => rule === HOUSE_GENRE_INCLUDE_RULE)).toHaveLength(1);
    expect(second.exclude.filter((rule) => rule === HOUSE_LITERAL_EXCLUSION_RULE)).toHaveLength(1);
  });

  test("the model receives the general polysemy rule and its literal house mistake is repaired", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-music-intent");
    let requestBody: any;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: "response-house-misread",
        model: "test-model",
        usage: { input_tokens: 100, output_tokens: 100 },
        output_text: JSON.stringify(adversarialLiteralInterpretation()),
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const result = await interpretPrompt("Give me 50 house music classics", "test-model");

    expect(requestBody.instructions).toContain("Resolve musical polysemy");
    expect(requestBody.instructions).toContain("house music");
    expect(requestBody.instructions).toContain("Never convert a genre request");
    expect(result.brief).toMatchObject({
      title: "House Music",
      subjectEntities: ["House music"],
      targetSize: { min: 50, max: 50 },
    });
    expect(result.brief.exclude).toContain(HOUSE_LITERAL_EXCLUSION_RULE);
  });
});
