import { describe, expect, test } from "vitest";
import scenarios from "./fixtures/production-search-scenarios.json";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  canonicalBriefForRequest,
  estimateResearchCost,
  explicitTrackCount,
} from "../server/brief-policy.ts";
import {
  assessProductionScenario,
  maximumScenarioActiveDurationMs,
  replayProductionScenario,
  type ProductionScenarioExpectedOutcome,
  type ProductionScenarioFailureClass,
  type ProductionScenarioReplayProfile,
} from "../server/production-scenario-qa.ts";
import { researchExecutionPolicy } from "../server/research-policy.ts";
import { applySimilaritySeedPolicy, excludedReferenceArtists } from "../server/similarity-policy.ts";
import {
  PUBLIC_FAST_RESEARCH_BUDGET_USD,
  PUBLIC_PLAYLIST_MAXIMUM_TRACKS,
  PUBLIC_PLAYLIST_MISSING_COUNT_TRACKS,
} from "../shared/product-policy.ts";

const adversarialModelBrief: PlaylistBrief = {
  title: "Model-generated title",
  description: "A broad model-generated description.",
  mode: "hybrid",
  subjectEntities: ["Prefuse 73", "Warp Records", "test subject", "extra subject", "another subject", "sixth subject"],
  relationship: "a broad editorial and cultural relationship",
  include: ["all relevant styles"],
  exclude: [],
  versionPolicy: "include original, live, remix, alternate, deluxe, and regional versions",
  evidencePolicy: "cited editorial sources",
  orderingPolicy: "editorial flow",
  targetSize: { min: 75, max: 150 },
  ambiguities: [],
};

interface ArchivedScenario {
  id: string;
  prompt: string;
  expectedTrackCount: number | null;
  expectedOutcome: ProductionScenarioExpectedOutcome;
  replayProfile: string;
  failureClasses: ProductionScenarioFailureClass[];
}

const fixture = scenarios as unknown as {
  schemaVersion: number;
  scenarioCount: number;
  replayProfiles: Record<string, ProductionScenarioReplayProfile>;
  scenarios: ArchivedScenario[];
};

function canonicalScenarioBrief(scenario: ArchivedScenario): PlaylistBrief {
  return canonicalBriefForRequest(
    { prompt: scenario.prompt },
    adversarialModelBrief,
  );
}

describe("retained production searches", () => {
  test("contains every retained brief attempt from the production audit", () => {
    expect(fixture.schemaVersion).toBe(3);
    expect(fixture.scenarios).toHaveLength(fixture.scenarioCount);
    expect(fixture.scenarioCount).toBe(26);
    expect(new Set(fixture.scenarios.map((scenario) => scenario.id)).size).toBe(26);
    expect(Object.keys(fixture.replayProfiles).sort()).toEqual([
      "catalog-shortfall",
      "large-target",
      "nominal",
      "research-under-yield",
      "rio-88-to-42-refill",
    ]);
    for (const scenario of fixture.scenarios) {
      expect(scenario.expectedOutcome).toBe("exact_playlist");
      expect(fixture.replayProfiles[scenario.replayProfile]).toBeDefined();
    }
  });

  test.each(fixture.scenarios)("$id is deterministically bounded regardless of model prose", (scenario) => {
    const canonical = canonicalScenarioBrief(scenario);
    const expectedCount = scenario.expectedTrackCount;

    expect(canonical.mode).toBe("curated");
    expect(canonical.targetSize).not.toBeNull();
    expect(canonical.targetSize!.max).toBeLessThanOrEqual(PUBLIC_PLAYLIST_MAXIMUM_TRACKS);
    if (expectedCount !== null) {
      expect(explicitTrackCount(scenario.prompt)).toBe(expectedCount);
      expect(canonical.targetSize).toEqual({ min: expectedCount, max: expectedCount });
    } else {
      expect(canonical.targetSize).toEqual({
        min: PUBLIC_PLAYLIST_MISSING_COUNT_TRACKS,
        max: PUBLIC_PLAYLIST_MISSING_COUNT_TRACKS,
      });
    }
    expect(researchExecutionPolicy(canonical).kind).toBe("fast_curated");
    expect(estimateResearchCost(canonical)).toBeLessThanOrEqual(PUBLIC_FAST_RESEARCH_BUDGET_USD);
  });

  test.each(fixture.scenarios)(
    "$id replays research yield, Apple recovery, exact count, latency, spend, and accounting",
    (scenario) => {
      const brief = canonicalScenarioBrief(scenario);
      const profile = fixture.replayProfiles[scenario.replayProfile]!;
      const replay = replayProductionScenario(brief, profile);
      const assessment = assessProductionScenario(replay.observation, scenario.expectedOutcome);
      const requested = replay.observation.requestedTrackCount;

      expect(profile.candidateYieldRate).toBeLessThanOrEqual(1);
      expect(replay.observation.candidateCount).toBeGreaterThanOrEqual(requested);
      expect(replay.observation.strictMatchedCount).toBeGreaterThanOrEqual(requested);
      expect(replay.observation.manifestTrackCount).toBe(requested);
      expect(replay.observation.publishedTrackCount).toBe(requested);
      expect(replay.observation.accountedCandidateCount).toBe(replay.observation.candidateCount);
      expect(replay.observation.totalCostUsd).toBeLessThanOrEqual(PUBLIC_FAST_RESEARCH_BUDGET_USD);
      expect(replay.observation.activeWorkDurationMs).toBeLessThanOrEqual(
        maximumScenarioActiveDurationMs(requested, replay.postMatchRefillGenerations),
      );
      expect(assessment).toEqual({
        releaseReady: true,
        failClosed: false,
        violations: [],
      });
    },
  );

  test("catalog-shortfall replays require the implemented reserve or retryable Apple recovery", () => {
    const exercised = fixture.scenarios
      .filter((scenario) => scenario.failureClasses.includes("catalog_shortfall"))
      .map((scenario) => {
        const replay = replayProductionScenario(
          canonicalScenarioBrief(scenario),
          fixture.replayProfiles[scenario.replayProfile]!,
        );
        return {
          id: scenario.id,
          reserveWasNecessary: replay.initialStrictMatchedCount
            < replay.observation.requestedTrackCount
            || replay.observation.candidateCount > replay.observation.requestedTrackCount,
          recoveryWasUsed: replay.recoveredCatalogCount > 0,
        };
      });

    expect(exercised.length).toBeGreaterThan(0);
    expect(exercised.every((row) => row.reserveWasNecessary)).toBe(true);
    expect(exercised.some((row) => row.recoveryWasUsed)).toBe(true);
  });

  test("the promoted Rio regression recovers 88 candidates and 42 strict matches to an exact 50-track playlist", () => {
    const scenario = fixture.scenarios.find((row) => row.id === "2026-07-17-26");
    expect(scenario).toBeDefined();
    const replay = replayProductionScenario(
      canonicalScenarioBrief(scenario!),
      fixture.replayProfiles[scenario!.replayProfile]!,
    );

    expect(replay.candidateGoal).toBe(88);
    expect(replay.initialStrictMatchedCount).toBe(42);
    expect(replay.recoveredCatalogCount).toBe(0);
    expect(replay.postMatchRefillGenerations).toBe(1);
    expect(replay.refillCandidateGoals).toEqual([21]);
    expect(replay.refillCandidateCount).toBe(21);
    expect(replay.refillStrictMatchedCount).toBe(8);
    expect(replay.observation).toMatchObject({
      requestedTrackCount: 50,
      strictMatchedCount: 50,
      manifestTrackCount: 50,
      publishedTrackCount: 50,
      terminalStatus: "complete",
      terminalPhase: "publication_complete",
      postMatchRefillGenerations: 1,
    });
    expect(assessProductionScenario(replay.observation, "exact_playlist")).toEqual({
      releaseReady: true,
      failClosed: false,
      violations: [],
    });
  });

  test("post-match refill stops after two bounded generations and fails closed", () => {
    const brief = canonicalScenarioBrief({
      id: "bounded-refill-failure",
      prompt: "50 impossibly obscure recordings",
      expectedTrackCount: 50,
      expectedOutcome: "explicit_failure",
      replayProfile: "bounded-refill-failure",
      failureClasses: ["catalog_shortfall"],
    });
    const replay = replayProductionScenario(brief, {
      candidateYieldRate: 1,
      initialStrictMatchRate: 0.25,
      retryableCatalogRate: 0,
      recoverySuccessRate: 0,
      refillCandidateYieldRate: 1,
      refillStrictMatchRate: 0,
    });

    expect(replay.postMatchRefillGenerations).toBe(2);
    expect(replay.refillCandidateGoals).toHaveLength(2);
    expect(replay.refillCostUsd).toBe(0.7);
    expect(replay.observation).toMatchObject({
      manifestTrackCount: 0,
      publishedTrackCount: 0,
      terminalStatus: "failed",
      terminalPhase: "catalog_matching_shortfall",
      postMatchRefillGenerations: 2,
    });
    expect(assessProductionScenario(replay.observation, "explicit_failure")).toEqual({
      releaseReady: true,
      failClosed: true,
      violations: [],
    });
  });

  test("a historical 50-to-28 result is a visible release failure, never a smaller success", () => {
    const shortfall = {
      requestedTrackCount: 50,
      candidateCount: 50,
      strictMatchedCount: 28,
      accountedCandidateCount: 50,
      manifestTrackCount: 28,
      publishedTrackCount: 28,
      totalCostUsd: 0.40,
      activeWorkDurationMs: 70_000,
      terminalStatus: "complete",
      terminalPhase: "publication_complete",
    };

    const result = assessProductionScenario(shortfall, "exact_playlist");
    expect(result.releaseReady).toBe(false);
    expect(result.failClosed).toBe(false);
    expect(result.violations).toEqual(expect.arrayContaining([
      "catalog_shortfall:28/50",
      "manifest_count:28/50",
      "published_count:28/50",
    ]));
  });

  test("an explicit catalog shortfall is safe only when it fails closed without a playlist", () => {
    const result = assessProductionScenario({
      requestedTrackCount: 50,
      candidateCount: 50,
      strictMatchedCount: 28,
      accountedCandidateCount: 50,
      manifestTrackCount: 0,
      publishedTrackCount: 0,
      totalCostUsd: 0.40,
      activeWorkDurationMs: 70_000,
      terminalStatus: "failed",
      terminalPhase: "catalog_matching_shortfall",
    }, "explicit_failure");

    expect(result).toEqual({
      releaseReady: true,
      failClosed: true,
      violations: [],
    });
  });

  test("a failed retry can never relabel a partially assembled playlist as fail-closed", () => {
    const result = assessProductionScenario({
      requestedTrackCount: 100,
      candidateCount: 150,
      strictMatchedCount: 78,
      accountedCandidateCount: 150,
      manifestTrackCount: 78,
      publishedTrackCount: 25,
      totalCostUsd: 0.75,
      activeWorkDurationMs: 150_000,
      terminalStatus: "failed",
      terminalPhase: "catalog_matching_shortfall",
    }, "explicit_failure");

    expect(result.releaseReady).toBe(false);
    expect(result.failClosed).toBe(false);
    expect(result.violations).toContain("failure_not_fail_closed");
  });

  test("the release gate rejects prior cost, target-truncation, latency, and accounting failures", () => {
    const base = {
      requestedTrackCount: 300,
      candidateCount: 450,
      strictMatchedCount: 300,
      accountedCandidateCount: 449,
      manifestTrackCount: 100,
      publishedTrackCount: 100,
      totalCostUsd: 8,
      activeWorkDurationMs: 360_001,
      terminalStatus: "complete",
      terminalPhase: "publication_complete",
    };
    const result = assessProductionScenario(base, "exact_playlist");

    expect(result.releaseReady).toBe(false);
    expect(result.violations).toEqual(expect.arrayContaining([
      "candidate_accounting:449/450",
      "cost_explosion:8.000000",
      "latency_regression:360001/360000",
      "manifest_count:100/300",
      "published_count:100/300",
    ]));
  });

  test("the promoted audit records the historical failure classes instead of only prompts", () => {
    const classes = new Set(fixture.scenarios.flatMap((scenario) => scenario.failureClasses));
    expect(classes).toEqual(new Set<ProductionScenarioFailureClass>([
      "catalog_shortfall",
      "cost_explosion",
      "research_under_yield",
      "target_truncation",
    ]));
  });

  test("the retained Prefuse-adjacent searches treat Prefuse 73 as a style seed", () => {
    for (const scenario of fixture.scenarios.slice(0, 3)) {
      const brief = applySimilaritySeedPolicy(scenario.prompt, {
        ...adversarialModelBrief,
        mode: "curated",
        subjectEntities: ["glitch hop", "Prefuse 73", "Warp Records"],
      });
      expect(excludedReferenceArtists(brief)).toContain("Prefuse 73");
    }
  });
});
