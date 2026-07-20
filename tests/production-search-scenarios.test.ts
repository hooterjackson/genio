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
import { createSelectionPlanV2 } from "../server/selection-plan-v2.ts";
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
  /** Explicit size chosen in the UI when the prose itself contains no count. */
  requestedTrackCount?: number | null;
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
    {
      prompt: scenario.prompt,
      requestedTrackCount: scenario.requestedTrackCount,
    },
    adversarialModelBrief,
  );
}

describe("retained production searches", () => {
  test("contains every retained brief attempt from the production audit", () => {
    expect(fixture.schemaVersion).toBe(5);
    expect(fixture.scenarios).toHaveLength(fixture.scenarioCount);
    expect(fixture.scenarioCount).toBe(30);
    expect(new Set(fixture.scenarios.map((scenario) => scenario.id)).size).toBe(30);
    expect(Object.keys(fixture.replayProfiles).sort()).toEqual([
      "baile-funk-19-of-25",
      "baile-funk-23-of-50",
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
      if (scenario.requestedTrackCount == null) {
        expect(explicitTrackCount(scenario.prompt)).toBe(expectedCount);
      } else {
        expect(explicitTrackCount(scenario.prompt)).toBeNull();
        expect(scenario.requestedTrackCount).toBe(expectedCount);
      }
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
    // Pipeline V2 sizes recovery from the conservative post-filter yield and
    // includes the qualified reserve instead of multiplying the deficit by a
    // fixed oversampling factor.
    expect(replay.refillCandidateGoals).toEqual([34]);
    expect(replay.refillCandidateCount).toBe(34);
    expect(replay.refillStrictMatchedCount).toBe(13);
    expect(replay.observation).toMatchObject({
      requestedTrackCount: 50,
      strictMatchedCount: 55,
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

  test.each([
    ["2026-07-17-27", 25],
    ["2026-07-17-28", 50],
    ["2026-07-18-29", 25],
  ] as const)("visitor-submitted Baile funk regression %s recovers to exactly %i tracks", (id, expectedCount) => {
    const scenario = fixture.scenarios.find((row) => row.id === id);
    expect(scenario).toBeDefined();
    expect(scenario?.failureClasses).toContain("catalog_shortfall");

    const replay = replayProductionScenario(
      canonicalScenarioBrief(scenario!),
      fixture.replayProfiles[scenario!.replayProfile]!,
    );

    expect(replay.initialStrictMatchedCount).toBeLessThan(expectedCount);
    expect(replay.postMatchRefillGenerations).toBeGreaterThan(0);
    expect(replay.observation).toMatchObject({
      requestedTrackCount: expectedCount,
      manifestTrackCount: expectedCount,
      publishedTrackCount: expectedCount,
      terminalStatus: "complete",
      terminalPhase: "publication_complete",
    });
    expect(assessProductionScenario(replay.observation, "exact_playlist")).toEqual({
      releaseReady: true,
      failClosed: false,
      violations: [],
    });
  });

  test("the Brazilian-disco incident preserves the open-ended era and treats count shortfall as partial", () => {
    const scenario = fixture.scenarios.find((row) => row.id === "2026-07-20-30");
    expect(scenario).toBeDefined();

    const brief = canonicalScenarioBrief(scenario!);
    const plan = createSelectionPlanV2({ prompt: scenario!.prompt, brief, storefront: "us" });
    const hardEraConstraints = plan.constraints.filter((constraint) => (
      constraint.kind === "hard" && constraint.axis === "era"
    ));

    expect(hardEraConstraints).toEqual([
      expect.objectContaining({
        operator: "between",
        values: ["1970", String(new Date().getUTCFullYear())],
      }),
    ]);
    expect(hardEraConstraints).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ operator: "within", values: ["1970s"] }),
    ]));

    const shortfall = replayProductionScenario(brief, {
      candidateYieldRate: 1,
      initialStrictMatchRate: 0.1,
      retryableCatalogRate: 0,
      recoverySuccessRate: 0,
      refillCandidateYieldRate: 1,
      refillStrictMatchRate: 0,
    });

    expect(shortfall.observation.strictMatchedCount).toBeGreaterThan(0);
    expect(shortfall.observation.strictMatchedCount).toBeLessThan(25);
    expect(shortfall.observation).toMatchObject({
      requestedTrackCount: 25,
      terminalStatus: "partial",
      terminalPhase: "publication_partial",
    });
    expect(shortfall.observation.terminalStatus).not.toBe("failed");
  });

  test("post-match refill stops after three bounded generations and publishes a transparent partial", () => {
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

    expect(replay.postMatchRefillGenerations).toBe(3);
    expect(replay.refillCandidateGoals).toHaveLength(3);
    expect(replay.refillCostUsd).toBeCloseTo(1.05, 10);
    expect(replay.observation).toMatchObject({
      manifestTrackCount: replay.observation.strictMatchedCount,
      publishedTrackCount: replay.observation.strictMatchedCount,
      terminalStatus: "partial",
      terminalPhase: "publication_partial",
      postMatchRefillGenerations: 3,
    });
    const assessment = assessProductionScenario(replay.observation, "exact_playlist");
    expect(assessment.releaseReady).toBe(false);
    expect(assessment.failClosed).toBe(false);
    expect(assessment.violations).toEqual(expect.arrayContaining([
      expect.stringMatching(/^catalog_shortfall:/u),
      expect.stringMatching(/^manifest_count:/u),
      expect.stringMatching(/^published_count:/u),
      "terminal_status:partial",
    ]));
  });

  test("a zero-yield production replay ends as a neutral partial without inventing a playlist", () => {
    const screenshotScenario = fixture.scenarios.find((row) => row.id === "2026-07-18-29");
    expect(screenshotScenario).toBeDefined();
    const replay = replayProductionScenario(canonicalScenarioBrief(screenshotScenario!), {
      candidateYieldRate: 0,
      initialStrictMatchRate: 0,
      retryableCatalogRate: 0,
      recoverySuccessRate: 0,
      refillCandidateYieldRate: 0,
      refillStrictMatchRate: 0,
    });

    expect(replay.observation).toMatchObject({
      requestedTrackCount: 25,
      candidateCount: 0,
      strictMatchedCount: 0,
      accountedCandidateCount: 0,
      manifestTrackCount: 0,
      publishedTrackCount: 0,
      terminalStatus: "partial",
      terminalPhase: "catalog_matching_empty",
    });
    expect(replay.postMatchRefillGenerations).toBe(3);
    expect(replay.observation.totalCostUsd).toBeLessThanOrEqual(PUBLIC_FAST_RESEARCH_BUDGET_USD);
    expect(assessProductionScenario(replay.observation, "exact_playlist")).toMatchObject({
      releaseReady: false,
      failClosed: false,
      violations: expect.arrayContaining([
        "research_under_yield:0/25",
        "catalog_shortfall:0/25",
        "manifest_count:0/25",
        "published_count:0/25",
        "terminal_status:partial",
      ]),
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

  test("a genuine provider failure is safe only when it fails closed without a playlist", () => {
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
      terminalPhase: "provider_failure",
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
      terminalPhase: "provider_failure",
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
