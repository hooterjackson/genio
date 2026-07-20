import { describe, expect, test } from "vitest";
import {
  criticalAmbiguityAnswersFromGuidanceV3,
  criticalGuidanceQuestionsV3,
  createRunSpecV3,
  resolveRunSpecV3,
} from "../server/selection-plan-v3.ts";

describe("Pipeline V3 typed planning", () => {
  test("separates house music from a lyrical theme about houses", () => {
    const genre = createRunSpecV3({ prompt: "50 influential house music tracks", requestedTrackCount: 50 });
    expect(genre.criticalAmbiguities).toEqual([]);
    expect(genre.intents).toEqual(expect.arrayContaining(["genre_scene", "editorial_ranking"]));
    expect(genre.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "genre",
      operator: "require",
      values: ["house"],
    }));

    const theme = createRunSpecV3({ prompt: "25 songs about houses and homes", requestedTrackCount: 25 });
    expect(theme.criticalAmbiguities).toEqual([]);
    expect(theme.intents).toContain("theme");
    expect(theme.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "theme",
      values: ["houses and homes"],
    }));

    const ambiguous = createRunSpecV3({ prompt: "Make me a house playlist", requestedTrackCount: 25 });
    expect(ambiguous.criticalAmbiguities.map(({ key }) => key)).toEqual(["house_semantics"]);
    expect(ambiguous.membershipPredicates.some(({ axis }) => axis === "genre" || axis === "theme")).toBe(false);
    const questions = criticalGuidanceQuestionsV3(ambiguous);
    expect(questions).toHaveLength(1);
    expect(questions[0]?.options.map(({ id }) => id)).toEqual(["house_genre", "house_theme", "house_both"]);
    const answers = criticalAmbiguityAnswersFromGuidanceV3(ambiguous, [{
      questionId: "v3-critical:house_semantics",
      optionId: "house_genre",
    }]);
    expect(resolveRunSpecV3(ambiguous, answers)).toMatchObject({ confirmed: true });
  });

  test("critical guidance survives unrelated scout questions and supports bounded custom scope", () => {
    const spec = createRunSpecV3({ prompt: "French jazz", requestedTrackCount: 25 });
    const answers = criticalAmbiguityAnswersFromGuidanceV3(spec, [
      { questionId: "unrelated-scout-question", optionId: "anything" },
      { questionId: "v3-critical:french_jazz_scope", customText: "Artists active in Paris between 1945 and 1975" },
    ]);
    expect(answers).toEqual([{
      key: "french_jazz_scope",
      optionId: "custom",
      customValue: "Artists active in Paris between 1945 and 1975",
    }]);
    expect(resolveRunSpecV3(spec, answers).confirmed).toBe(true);
  });

  test("does not silently choose a meaning for French jazz", () => {
    const spec = createRunSpecV3({ prompt: "French jazz across the decades", requestedTrackCount: 100 });
    expect(spec.criticalAmbiguities.map(({ key }) => key)).toContain("french_jazz_scope");
    expect(spec.membershipPredicates).toContainEqual(expect.objectContaining({ axis: "genre", values: ["jazz"] }));

    const plan = resolveRunSpecV3(spec, [{
      key: "french_jazz_scope",
      optionId: "french_scene",
    }]);
    expect(plan.confirmed).toBe(true);
    expect(plan.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "scene",
      values: ["French jazz scene"],
      source: "guided_answer",
    }));
  });

  test("requires an explicit relationship for possessive editorial requests", () => {
    const spec = createRunSpecV3({
      prompt: "Paulinho da Costa's 176 most influential songs",
      requestedTrackCount: 176,
    });
    expect(spec.criticalAmbiguities.map(({ key }) => key)).toContain("possessive_relationship");
    expect(spec.intents).toContain("editorial_ranking");

    const plan = resolveRunSpecV3(spec, [{
      key: "possessive_relationship",
      optionId: "subject_performed",
    }]);
    expect(plan.confirmed).toBe(true);
    expect(plan.intents).toContain("factual_relationship");
    expect(plan.engines).toContain("factual_relationship");
    expect(plan.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "factual_relationship",
      values: ["subject_performed"],
    }));
  });

  test("distinguishes funk carioca from Brazilian soul-and-funk traditions", () => {
    const ambiguous = createRunSpecV3({ prompt: "Brazilian funk essentials", requestedTrackCount: 50 });
    expect(ambiguous.criticalAmbiguities.map(({ key }) => key)).toContain("brazilian_funk_semantics");

    const baile = createRunSpecV3({ prompt: "Baile funk and funk carioca essentials", requestedTrackCount: 50 });
    expect(baile.criticalAmbiguities).toEqual([]);
    expect(baile.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "genre",
      values: ["funk carioca"],
    }));

    const seventies = createRunSpecV3({ prompt: "1970s Brazilian soul and funk", requestedTrackCount: 50 });
    expect(seventies.criticalAmbiguities).toEqual([]);
    expect(seventies.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "genre",
      values: ["Brazilian soul and funk"],
    }));
  });

  test("routes multi-intent requests deterministically and excludes similarity seeds", () => {
    const spec = createRunSpecV3({
      prompt: "Dark dance tracks similar to Beyoncé, but other artists only",
      requestedTrackCount: 25,
      storefront: "US",
    });
    expect(spec.storefront).toBe("us");
    expect(spec.intents).toEqual(expect.arrayContaining(["similarity", "mood_activity"]));
    expect(spec.engines).toEqual(expect.arrayContaining(["similarity", "mood_activity_theme"]));
    expect(spec.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "artist",
      operator: "exclude",
      values: ["beyonce"],
    }));
    expect(spec.rankingObjectives).toContainEqual(expect.objectContaining({ dimension: "similarity" }));
  });

  test("recognizes natural tracks-like phrasing without treating the seed as filler", () => {
    const spec = createRunSpecV3({
      prompt: "50 house music tracks like Beyonce but do not include Beyonce",
      requestedTrackCount: 50,
    });

    expect(spec.intents).toContain("similarity");
    expect(spec.engines).toContain("similarity");
    expect(spec.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "artist",
      operator: "exclude",
      values: ["beyonce"],
    }));
  });

  test("freezes the complete run contract and bounds requested count", () => {
    const spec = createRunSpecV3({ prompt: "Berlin techno", requestedTrackCount: 50 });
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.membershipPredicates)).toBe(true);
    expect(() => createRunSpecV3({ prompt: "Berlin techno", requestedTrackCount: 301 })).toThrow(/between 1 and 300/i);
  });
});
