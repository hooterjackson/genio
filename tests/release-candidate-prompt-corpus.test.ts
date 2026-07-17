import { describe, expect, test } from "vitest";
import corpus from "./fixtures/release-candidate-esoteric-scenarios.json";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  canonicalBriefForRequest,
  estimateResearchCost,
} from "../server/brief-policy.ts";
import { researchExecutionPolicy } from "../server/research-policy.ts";
import { excludedReferenceArtists } from "../server/similarity-policy.ts";
import { PUBLIC_FAST_RESEARCH_BUDGET_USD } from "../shared/product-policy.ts";

type ExpectedMode = PlaylistBrief["mode"];

interface PromptCorpusScenario {
  id: string;
  category: string;
  prompt: string;
  requestedTrackCount: number | null;
  subjectEntities: string[];
  expectedMode: ExpectedMode;
  expectedTrackCount: number | null;
  expectedExcludedReferenceArtists: string[];
}

const fixture = corpus as unknown as {
  schemaVersion: number;
  purpose: string;
  scenarios: PromptCorpusScenario[];
};

function interpretedBrief(scenario: PromptCorpusScenario): PlaylistBrief {
  const exhaustive = scenario.requestedTrackCount === null;
  return {
    title: "Offline QA fixture",
    description: "A deliberately adversarial model interpretation for offline policy QA.",
    mode: exhaustive ? "exhaustive" : "hybrid",
    subjectEntities: scenario.subjectEntities,
    relationship: scenario.category === "exhaustive_credit" ? "explicitly credited on" : "editorially related to",
    include: ["released recordings supported by the confirmed scope"],
    exclude: [],
    versionPolicy: "one canonical recording",
    evidencePolicy: "cited sources appropriate to the claim",
    orderingPolicy: "editorial flow",
    targetSize: exhaustive ? null : { min: 50, max: 100 },
    ambiguities: [],
  };
}

describe("release-candidate esoteric prompt policy corpus", () => {
  test("has stable unique IDs and the required high-risk prompt classes", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.purpose).toContain("without evaluating live research quality");
    expect(fixture.scenarios.length).toBeGreaterThanOrEqual(20);
    expect(new Set(fixture.scenarios.map((scenario) => scenario.id)).size)
      .toBe(fixture.scenarios.length);
    const categories = new Set(fixture.scenarios.map((scenario) => scenario.category));
    expect([...categories]).toEqual(expect.arrayContaining([
      "count_control",
      "similarity",
      "esoteric_similarity",
      "esoteric_editorial",
      "esoteric_instrumentation",
      "exhaustive_credit",
    ]));
  });

  test.each(fixture.scenarios)("$id preserves the deterministic workload contract", (scenario) => {
    const canonical = canonicalBriefForRequest({
      prompt: scenario.prompt,
      requestedTrackCount: scenario.requestedTrackCount,
    }, interpretedBrief(scenario));

    expect(canonical.mode).toBe(scenario.expectedMode);
    if (scenario.expectedTrackCount === null) {
      expect(canonical.targetSize).toBeNull();
    } else {
      expect(canonical.targetSize).toEqual({
        min: scenario.expectedTrackCount,
        max: scenario.expectedTrackCount,
      });
      expect(researchExecutionPolicy(canonical).kind).toBe("fast_curated");
      expect(estimateResearchCost(canonical)).toBeLessThanOrEqual(PUBLIC_FAST_RESEARCH_BUDGET_USD);
    }
    expect(excludedReferenceArtists(canonical))
      .toEqual(expect.arrayContaining(scenario.expectedExcludedReferenceArtists));
  });

  test("the UI size control wins over prompt prose and unrelated numbers", () => {
    for (const id of ["RC-P01", "RC-P02", "RC-P03", "RC-P04"]) {
      const scenario = fixture.scenarios.find((row) => row.id === id)!;
      const canonical = canonicalBriefForRequest({
        prompt: scenario.prompt,
        requestedTrackCount: scenario.requestedTrackCount,
      }, interpretedBrief(scenario));
      expect(canonical.targetSize).toEqual({
        min: scenario.expectedTrackCount,
        max: scenario.expectedTrackCount,
      });
    }
  });

  test("source-frontier credit prompts stay unbounded only without the public count control", () => {
    for (const scenario of fixture.scenarios.filter((row) => row.category === "exhaustive_credit")) {
      const canonical = canonicalBriefForRequest({ prompt: scenario.prompt }, interpretedBrief(scenario));
      expect(canonical).toMatchObject({ mode: "exhaustive", targetSize: null });

      const publicCanonical = canonicalBriefForRequest({
        prompt: scenario.prompt,
        requestedTrackCount: 50,
      }, interpretedBrief(scenario));
      expect(publicCanonical).toMatchObject({
        mode: "curated",
        targetSize: { min: 50, max: 50 },
      });
    }
  });
});
