import { describe, expect, test } from "vitest";
import {
  adaptiveFillPlanV3,
  conservativeEndToEndYieldV3,
  decideAdaptiveFillV3,
  estimateStageYieldsV3,
} from "../server/adaptive-fill-v3.ts";

describe("Pipeline V3 adaptive exact-fill controller", () => {
  test("plans for target plus a twenty-percent qualified reserve", () => {
    const plan = adaptiveFillPlanV3({
      target: 50,
      qualified: 20,
      stageObservations: [],
    });
    expect(plan).toMatchObject({
      target: 50,
      reserve: 10,
      targetDeficit: 30,
      qualifiedPoolGoal: 60,
      qualifiedPoolDeficit: 40,
      conservativeEndToEndYield: 0.5,
      rawDiscoveryGoal: 80,
    });

    expect(adaptiveFillPlanV3({ target: 176, qualified: 176, stageObservations: [] })).toMatchObject({
      reserve: 36,
      targetDeficit: 0,
      qualifiedPoolDeficit: 36,
      rawDiscoveryGoal: 72,
    });
  });

  test("uses bounded conservative stage yields instead of raw candidate count", () => {
    const observations = [
      { stage: "scope_eligible" as const, entered: 100, passed: 80 },
      { stage: "evidence_eligible" as const, entered: 80, passed: 60 },
      { stage: "playable" as const, entered: 60, passed: 48 },
    ];
    const estimates = estimateStageYieldsV3(observations);
    expect(estimates).toHaveLength(3);
    expect(estimates[0]!.observedYield).toBe(0.8);
    expect(estimates.every(({ conservativeYield, observedYield }) => (
      conservativeYield !== null && observedYield !== null && conservativeYield < observedYield
    ))).toBe(true);
    expect(conservativeEndToEndYieldV3(observations)).toBeGreaterThanOrEqual(0.2);
    expect(conservativeEndToEndYieldV3(observations)).toBeLessThan(0.5);
  });

  test("caps pathological expansion and rejects impossible stage observations", () => {
    const plan = adaptiveFillPlanV3({
      target: 300,
      qualified: 0,
      maximumRawDiscoveryGoal: 400,
      stageObservations: [{ stage: "evidence_eligible", entered: 100, passed: 1 }],
    });
    expect(plan.conservativeEndToEndYield).toBe(0.2);
    expect(plan.rawDiscoveryGoal).toBe(400);
    expect(() => estimateStageYieldsV3([
      { stage: "playable", entered: 2, passed: 3 },
    ])).toThrow(/cannot pass more candidates/i);
  });

  test("continues only strategies that have not exhausted two zero-yield rounds", () => {
    const plan = adaptiveFillPlanV3({ target: 50, qualified: 25, stageObservations: [] });
    expect(decideAdaptiveFillV3({
      plan,
      deadlineReached: false,
      budgetReached: false,
      strategies: [
        { id: "direct", status: "exhausted", consecutiveZeroYieldRounds: 2 },
        { id: "aliases", status: "available", consecutiveZeroYieldRounds: 1 },
      ],
    })).toEqual({ action: "continue", strategyIds: ["aliases"], reason: "qualified_reserve_missing" });
  });

  test("records an explicit stop reason without turning shortfall into failure", () => {
    const plan = adaptiveFillPlanV3({ target: 50, qualified: 39, stageObservations: [] });
    expect(decideAdaptiveFillV3({
      plan,
      deadlineReached: false,
      budgetReached: false,
      strategies: [{ id: "direct", status: "exhausted", consecutiveZeroYieldRounds: 2 }],
    })).toEqual({ action: "stop", reason: "frontier_exhausted" });
    expect(decideAdaptiveFillV3({
      plan,
      deadlineReached: true,
      budgetReached: false,
      strategies: [{ id: "direct", status: "available", consecutiveZeroYieldRounds: 0 }],
    })).toEqual({ action: "stop", reason: "deadline_reached" });
  });

  test("stops when target and reserve are both satisfied", () => {
    const plan = adaptiveFillPlanV3({ target: 100, qualified: 120, stageObservations: [] });
    expect(decideAdaptiveFillV3({
      plan,
      deadlineReached: false,
      budgetReached: false,
      strategies: [{ id: "direct", status: "available", consecutiveZeroYieldRounds: 0 }],
    })).toEqual({ action: "stop", reason: "qualified_reserve_satisfied" });
  });
});
