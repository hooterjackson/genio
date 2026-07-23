import { describe, expect, test } from "vitest";
import {
  assessPlaylistFeasibilityV1,
  playlistCandidateGoalV1,
  playlistReserveTrackCountV1,
  type PlaylistFeasibilityObservationV1,
} from "../server/playlist-feasibility-v1.ts";

function observation(
  overrides: Partial<PlaylistFeasibilityObservationV1> = {},
): PlaylistFeasibilityObservationV1 {
  return {
    contractRevisionId: "contract-revision-1",
    contractSemanticHash: "a".repeat(64),
    targetTrackCount: 50,
    scope: "open_world",
    phase: "preview",
    dependencyHealth: "healthy",
    eligibleEstimateLower: 55,
    eligibleEstimateUpper: 80,
    closedSetCapacity: null,
    discoveredCount: 0,
    qualifiedCount: 0,
    storefrontSafeCount: 0,
    contradictions: [],
    limitingPredicateIds: [],
    frontiers: [],
    activeResearchBudgetExhausted: false,
    policyVersions: {
      evidence: "governed_evidence_v1",
      ontology: "music_concepts_v3_2_0",
    },
    ...overrides,
  };
}

describe("playlist feasibility v1", () => {
  test("sizes reserve and candidates from the clamped conservative conversion rate", () => {
    expect(playlistReserveTrackCountV1(50)).toBe(5);
    expect(playlistReserveTrackCountV1(100)).toBe(10);
    expect(playlistCandidateGoalV1(50, 0.5)).toEqual({
      candidateGoal: 105,
      reserveTrackCount: 5,
      clampedConversionRate: 0.5,
    });
    expect(playlistCandidateGoalV1(50, 0.01)).toMatchObject({
      candidateGoal: 205,
      clampedConversionRate: 0.25,
    });
    expect(playlistCandidateGoalV1(50, 1)).toMatchObject({
      candidateGoal: 61,
      clampedConversionRate: 0.9,
    });
  });

  test("reports likely only when conservative inventory covers the target and projection covers reserve", () => {
    const report = assessPlaylistFeasibilityV1(observation());
    expect(report).toMatchObject({
      state: "likely",
      targetTrackCount: 50,
      reserveTrackCount: 5,
      requiredInventoryCount: 55,
      reasonCodes: ["conservative_inventory_covers_target_and_reserve"],
    });
    expect(report.reportHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(assessPlaylistFeasibilityV1(observation()).reportHash).toBe(report.reportHash);
  });

  test("keeps weak projections at risk instead of claiming impossibility", () => {
    expect(assessPlaylistFeasibilityV1(observation({
      eligibleEstimateLower: 22,
      eligibleEstimateUpper: 42,
    }))).toMatchObject({
      state: "at_risk",
      reasonCodes: ["projected_inventory_below_target"],
    });
  });

  test("uses known ceiling only for deterministic closed sets", () => {
    expect(assessPlaylistFeasibilityV1(observation({
      scope: "closed_set",
      closedSetCapacity: 12,
      targetTrackCount: 25,
    }))).toMatchObject({
      state: "known_ceiling",
      reasonCodes: ["closed_set_below_requested_count"],
    });
    expect(() => assessPlaylistFeasibilityV1(observation({
      scope: "open_world",
      closedSetCapacity: 12,
    }))).toThrow("open_world_cannot_have_closed_set_capacity");
  });

  test("reports dependency uncertainty before scarcity", () => {
    expect(assessPlaylistFeasibilityV1(observation({
      dependencyHealth: "unavailable",
      eligibleEstimateLower: 0,
      eligibleEstimateUpper: 0,
    }))).toMatchObject({
      state: "unknown",
      reasonCodes: ["dependency_unavailable"],
      frontierProof: null,
    });
  });

  test("requires two genuinely independent healthy completed frontiers for exhaustion", () => {
    const common = {
      phase: "bounded_research" as const,
      activeResearchBudgetExhausted: true,
      eligibleEstimateLower: 20,
      eligibleEstimateUpper: 30,
      discoveredCount: 133,
      qualifiedCount: 26,
      storefrontSafeCount: 26,
      limitingPredicateIds: ["genre:reggaeton"],
    };
    const sharedProvider = assessPlaylistFeasibilityV1(observation({
      ...common,
      frontiers: [
        {
          id: "provider-prompt-a",
          dependencyKey: "provider-a",
          status: "complete",
          discoveredCount: 80,
          qualifiedCount: 20,
        },
        {
          id: "provider-prompt-b",
          dependencyKey: "provider-a",
          status: "complete",
          discoveredCount: 53,
          qualifiedCount: 6,
        },
      ],
    }));
    expect(sharedProvider.state).toBe("at_risk");

    const independent = assessPlaylistFeasibilityV1(observation({
      ...common,
      frontiers: [
        {
          id: "apple-editorial",
          dependencyKey: "apple-catalog",
          status: "complete",
          discoveredCount: 80,
          qualifiedCount: 20,
        },
        {
          id: "grounded-web",
          dependencyKey: "hosted-web-provider",
          status: "complete",
          discoveredCount: 53,
          qualifiedCount: 6,
        },
      ],
    }));
    expect(independent).toMatchObject({
      state: "frontier_exhausted_under_policy",
      reasonCodes: [
        "healthy_independent_frontiers_exhausted",
        "qualified_inventory_below_target",
      ],
      frontierProof: {
        completedFrontierIds: ["apple-editorial", "grounded-web"],
        independentDependencyKeys: ["apple-catalog", "hosted-web-provider"],
        discoveredCount: 133,
        qualifiedCount: 26,
        storefrontSafeCount: 26,
        limitingPredicateIds: ["genre:reggaeton"],
      },
    });
  });

  test("contradictions take precedence and remain bound into the report hash", () => {
    const report = assessPlaylistFeasibilityV1(observation({
      contradictions: ["requires_and_excludes_same_artist"],
      dependencyHealth: "unavailable",
    }));
    expect(report).toMatchObject({
      state: "contradictory",
      reasonCodes: [
        "conflict:requires_and_excludes_same_artist",
        "contract_predicates_conflict",
      ],
    });
    expect(assessPlaylistFeasibilityV1(observation({
      contradictions: ["different_conflict"],
      dependencyHealth: "unavailable",
    })).reportHash).not.toBe(report.reportHash);
  });
});
