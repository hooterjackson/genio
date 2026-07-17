import { describe, expect, test } from "vitest";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  canonicalBriefForRequest,
  estimateResearchCost,
} from "../server/brief-policy.ts";
import {
  catalogMatchingCandidateGoal,
  researchExecutionPolicy,
} from "../server/research-policy.ts";
import {
  excludedReferenceArtists,
  isExcludedReferenceArtist,
} from "../server/similarity-policy.ts";
import { PUBLIC_FAST_RESEARCH_BUDGET_USD } from "../shared/product-policy.ts";

function hostileInterpretation(subjectEntities: string[]): PlaylistBrief {
  return {
    title: "Esoteric request",
    description: "A deliberately unstable model interpretation.",
    mode: "hybrid",
    subjectEntities,
    relationship: "is relevant to",
    include: [],
    exclude: [],
    versionPolicy: "one canonical recording",
    evidencePolicy: "cited editorial sources",
    orderingPolicy: "editorial flow",
    targetSize: null,
    ambiguities: [],
  };
}

describe("esoteric offline release scenarios", () => {
  const scenarios = [
    ["40 Buchla tape works", 40, ["Buchla"]],
    ["35 Japanese environmental music pieces", 35, ["Japanese environmental music"]],
    ["33 Greenlandic metal and traditional drum-song crossover compositions", 33, ["Greenlandic metal", "drum-song"]],
    ["45 Indonesian jaipongan club selections", 45, ["jaipongan"]],
    ["20 spectralist-influenced black-metal cuts", 20, ["spectralism", "black metal"]],
    ["37 Inuit throat-singing collaborations with electroacoustic composers", 37, ["Inuit throat singing"]],
  ] as const;

  test.each(scenarios)("keeps %s exact, fast, reserved, and cost bounded", (prompt, count, entities) => {
    const brief = canonicalBriefForRequest(
      { prompt },
      hostileInterpretation([...entities]),
    );

    expect(brief).toMatchObject({
      mode: "curated",
      targetSize: { min: count, max: count },
    });
    expect(researchExecutionPolicy(brief)).toMatchObject({
      kind: "fast_curated",
      targetMinimum: count,
      targetMaximum: Math.max(50, count),
      candidateGoal: catalogMatchingCandidateGoal(count),
    });
    expect(catalogMatchingCandidateGoal(count)).toBeGreaterThan(count);
    expect(estimateResearchCost(brief)).toBeLessThanOrEqual(PUBLIC_FAST_RESEARCH_BUDGET_USD);
  });

  test("keeps numeric artist names out of the result for X-adjacent shorthand", () => {
    const prompt = "100 gecs-adjacent hyperpop, but no 100 gecs — 50 tracks";
    const brief = canonicalBriefForRequest(
      { prompt },
      hostileInterpretation(["100 gecs", "hyperpop"]),
    );

    expect(brief.targetSize).toEqual({ min: 50, max: 50 });
    expect(excludedReferenceArtists(brief)).toEqual(["100 gecs"]);
    expect(isExcludedReferenceArtist(brief, "100 gecs")).toBe(true);
    expect(isExcludedReferenceArtist(brief, "Other Artist")).toBe(false);
  });
});
