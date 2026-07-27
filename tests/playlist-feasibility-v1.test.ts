import { describe, expect, test } from "vitest";
import {
  assessPlaylistFeasibilityV1,
  assessPlaylistRuntimeFeasibilityV1,
  assertPlaylistFeasibilityReportIntegrityV1,
  playlistCandidateGoalV1,
  playlistReserveTrackCountV1,
  playlistRuntimeNoCompatibleDispositionV1,
  type PlaylistFeasibilityObservationV1,
} from "../server/playlist-feasibility-v1.ts";
import {
  createFixedContainerResolutionProofV1,
} from "../server/fixed-container-resolution-proof-v1.ts";

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

  test("does not treat a composite frontier as independent from its upstream", () => {
    const report = assessPlaylistFeasibilityV1(observation({
      phase: "bounded_research",
      activeResearchBudgetExhausted: true,
      eligibleEstimateLower: null,
      eligibleEstimateUpper: null,
      frontiers: [{
        id: "apple",
        dependencyKey: "apple_catalog",
        dependencyKeys: ["apple_catalog"],
        status: "complete",
        discoveredCount: 10,
        qualifiedCount: 0,
      }, {
        id: "apple-plus-web",
        dependencyKey: "apple_catalog+hosted_web",
        dependencyKeys: ["apple_catalog", "hosted_web"],
        status: "complete",
        discoveredCount: 10,
        qualifiedCount: 0,
      }],
    }));

    expect(report).toMatchObject({
      state: "unknown",
      frontierProof: null,
      reasonCodes: ["insufficient_inventory_coverage"],
    });

    const compositeOnly = assessPlaylistFeasibilityV1(observation({
      phase: "bounded_research",
      activeResearchBudgetExhausted: true,
      eligibleEstimateLower: null,
      eligibleEstimateUpper: null,
      frontiers: [{
        id: "apple-plus-web",
        dependencyKey: "apple_catalog+hosted_web",
        dependencyKeys: ["apple_catalog", "hosted_web"],
        status: "complete",
        discoveredCount: 20,
        qualifiedCount: 0,
      }],
    }));
    expect(compositeOnly).toMatchObject({
      state: "unknown",
      frontierProof: null,
    });
  });

  test("builds a hash-bound runtime proof and gates zero-track outcomes on it", () => {
    const runtime = assessPlaylistRuntimeFeasibilityV1({
      contractRevisionId: "pcr1:runtime-proof",
      contractSemanticHash: "b".repeat(64),
      targetTrackCount: 25,
      scope: "open_world",
      stopReason: "frontier_exhausted",
      discoveredCount: 70,
      qualifiedCount: 0,
      storefrontSafeCount: 0,
      contradictions: [],
      limitingPredicateIds: ["genre:reggaeton"],
      strategies: [{
        id: "apple-containers",
        status: "exhausted",
        rounds: 2,
        rawCandidates: 30,
        newQualifiedFamilies: 0,
        discoveryDependencyIds: ["apple_catalog"],
      }, {
        id: "hosted-editorial",
        status: "exhausted",
        rounds: 2,
        rawCandidates: 40,
        newQualifiedFamilies: 0,
        discoveryDependencyIds: ["hosted_web"],
      }],
      dependencyOutages: [],
      budgets: {
        activeComputeConsumedMs: 240_000,
        activeComputeAllowanceMs: 900_000,
        maximumGlobalRounds: 48,
        maximumRawCandidates: 500,
        maximumCostUnits: 48,
        qualifiedPoolGoal: 30,
      },
      policyVersions: {
        pipeline: "corpus_first_v3",
        queryPlan: "corpus_first_v3_policy_v1",
      },
    });

    expect(runtime).toMatchObject({
      state: "frontier_exhausted_under_policy",
      runtimeEvidence: {
        discoveredCount: 70,
        qualifiedCount: 0,
        storefrontSafeCount: 0,
        activeResearchBudgetExhausted: true,
        budgets: {
          stopReason: "frontier_exhausted",
          observedStrategyRounds: 4,
          maximumRawCandidates: 500,
        },
      },
      frontierProof: {
        completedFrontierIds: ["apple-containers", "hosted-editorial"],
        independentDependencyKeys: ["apple_catalog", "hosted_web"],
      },
    });
    expect(() => assertPlaylistFeasibilityReportIntegrityV1(runtime))
      .not.toThrow();
    expect(playlistRuntimeNoCompatibleDispositionV1({
      report: runtime,
      scope: "open_world",
    })).toBe("allow");

    const insufficient = assessPlaylistRuntimeFeasibilityV1({
      contractRevisionId: "pcr1:runtime-unknown",
      contractSemanticHash: "c".repeat(64),
      targetTrackCount: 25,
      scope: "open_world",
      stopReason: "frontier_exhausted",
      discoveredCount: 30,
      qualifiedCount: 0,
      storefrontSafeCount: 0,
      contradictions: [],
      limitingPredicateIds: [],
      strategies: [{
        id: "hosted-a",
        status: "exhausted",
        rounds: 2,
        rawCandidates: 30,
        newQualifiedFamilies: 0,
        discoveryDependencyIds: ["hosted_web"],
      }, {
        id: "hosted-b",
        status: "exhausted",
        rounds: 2,
        rawCandidates: 0,
        newQualifiedFamilies: 0,
        discoveryDependencyIds: ["hosted_web"],
      }],
      dependencyOutages: [],
      budgets: {
        activeComputeConsumedMs: 240_000,
        activeComputeAllowanceMs: 900_000,
        maximumGlobalRounds: 48,
        maximumRawCandidates: 500,
        maximumCostUnits: 48,
        qualifiedPoolGoal: 30,
      },
      policyVersions: { pipeline: "corpus_first_v3" },
    });
    expect(insufficient).toMatchObject({
      state: "unknown",
      frontierProof: null,
    });
    expect(playlistRuntimeNoCompatibleDispositionV1({
      report: insufficient,
      scope: "open_world",
    })).toBe("actionable_decision");
  });

  test("requires exact fixed-container resolution and complete enumeration for a known ceiling", () => {
    const contractSemanticHash = "e".repeat(64);
    const requested = {
      kind: "album" as const,
      name: "Kind of Blue",
      artistName: "Miles Davis",
    };
    const runtime = (fixedContainerResolution: ReturnType<
      typeof createFixedContainerResolutionProofV1
    >) => assessPlaylistRuntimeFeasibilityV1({
      contractRevisionId: "pcr1:fixed-runtime-proof",
      contractSemanticHash,
      targetTrackCount: 25,
      scope: "closed_set",
      stopReason: "frontier_exhausted",
      discoveredCount: 12,
      qualifiedCount: 12,
      storefrontSafeCount: 12,
      contradictions: [],
      limitingPredicateIds: [],
      strategies: [{
        id: "fixed_container:enumerate_container",
        status: "exhausted",
        rounds: 1,
        rawCandidates: 12,
        newQualifiedFamilies: 12,
        discoveryDependencyIds: ["apple_catalog"],
        fixedContainerResolution,
      }],
      dependencyOutages: [],
      budgets: {
        activeComputeConsumedMs: 30_000,
        activeComputeAllowanceMs: 900_000,
        maximumGlobalRounds: 10,
        maximumRawCandidates: 300,
        maximumCostUnits: 10,
        qualifiedPoolGoal: 30,
      },
      policyVersions: { pipeline: "corpus_first_v3" },
    });

    const complete = runtime(createFixedContainerResolutionProofV1({
      contractSemanticHash,
      storefront: "us",
      requested,
      exactMatchCardinality: 1,
      resolvedResourceId: "268443092",
      resolvedResourceKind: "album",
      identityResolutionComplete: true,
      identitySearchPageCount: 1,
      enumerationComplete: true,
      enumeratedTrackCount: 12,
      pageCount: 1,
    }));
    expect(complete).toMatchObject({
      state: "known_ceiling",
      eligibleEstimateUpper: 12,
      runtimeEvidence: {
        fixedContainerResolution: {
          resolvedResourceId: "268443092",
          enumerationComplete: true,
        },
      },
    });
    expect(playlistRuntimeNoCompatibleDispositionV1({
      report: complete,
      scope: "closed_set",
    })).toBe("allow");

    for (const exactMatchCardinality of [0, 2]) {
      const unresolved = runtime(createFixedContainerResolutionProofV1({
        contractSemanticHash,
        storefront: "us",
        requested,
        exactMatchCardinality,
        resolvedResourceId: null,
        resolvedResourceKind: null,
        identityResolutionComplete: true,
        identitySearchPageCount: 1,
        enumerationComplete: false,
        enumeratedTrackCount: 0,
        pageCount: 0,
      }));
      expect(unresolved).toMatchObject({
        state: "unknown",
        eligibleEstimateLower: null,
        eligibleEstimateUpper: null,
        runtimeEvidence: {
          fixedContainerResolution: {
            exactMatchCardinality,
            resolvedResourceId: null,
            enumerationComplete: false,
          },
        },
      });
      expect(playlistRuntimeNoCompatibleDispositionV1({
        report: unresolved,
        scope: "closed_set",
      })).toBe("actionable_decision");
    }
  });

  test("turns an active runtime outage into a dependency pause, never scarcity", () => {
    const report = assessPlaylistRuntimeFeasibilityV1({
      contractRevisionId: "pcr1:runtime-outage",
      contractSemanticHash: "d".repeat(64),
      targetTrackCount: 25,
      scope: "open_world",
      stopReason: "frontier_exhausted",
      discoveredCount: 0,
      qualifiedCount: 0,
      storefrontSafeCount: 0,
      contradictions: [],
      limitingPredicateIds: [],
      strategies: [{
        id: "hosted-editorial",
        status: "circuit_open",
        rounds: 1,
        rawCandidates: 0,
        newQualifiedFamilies: 0,
        discoveryDependencyIds: ["hosted_web"],
      }],
      dependencyOutages: [{
        dependencyId: "hosted_web",
        active: true,
        circuitOpen: true,
        failureAttempts: 3,
        affectedStrategyIds: ["hosted-editorial"],
      }],
      budgets: {
        activeComputeConsumedMs: 1_000,
        activeComputeAllowanceMs: 900_000,
        maximumGlobalRounds: 48,
        maximumRawCandidates: 500,
        maximumCostUnits: 48,
        qualifiedPoolGoal: 30,
      },
      policyVersions: { pipeline: "corpus_first_v3" },
    });
    expect(report).toMatchObject({
      state: "unknown",
      dependencyHealth: "unavailable",
      reasonCodes: ["dependency_unavailable"],
    });
    expect(playlistRuntimeNoCompatibleDispositionV1({
      report,
      scope: "open_world",
    })).toBe("dependency_pause");
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
