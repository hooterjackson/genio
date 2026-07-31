import { describe, expect, test } from "vitest";
import type { QueryPlanV3 } from "../shared/types.ts";
import type { RetrievalResultV3 } from "../server/pipeline-v3-retrieval.ts";
import { auditSemanticCollapseV1 } from "../server/semantic-collapse-audit-v1.ts";

function queryPlan(): QueryPlanV3 {
  return {
    schemaVersion: 6,
    engines: ["curated_genre_scene"],
    verificationExpression: {
      op: "leaf",
      obligationId: "verification:genre",
      clauseId: "genre",
      polarity: "positive",
      axis: "genre",
      verifierFamilies: ["track_editorial"],
      permittedEvidenceGrades: ["track_specific_editorial_assertion"],
      unknownPolicy: "reject",
      storefront: "us",
      versionPolicy: "catalog_policy_v1",
      evidencePolicyVersion: "evidence_v1",
      capableProducerFamilies: ["track_editorial"],
      negativeScope: null,
    },
    executionCoverageReport: {
      version: "execution_coverage_report_v1",
      stage: "query_plan",
      routeId: "curated",
      dependencyRootIds: ["apple_catalog", "openai"],
      workerCapabilityHash: "a".repeat(64),
      configurationHash: "b".repeat(64),
      ontologyVersion: "ontology_v1",
      evidencePolicyVersion: "evidence_v1",
      coveredObligationIds: ["verification:genre"],
      uncoveredObligationIds: [],
      producerFamilies: ["track_editorial"],
      complete: true,
      reportHash: "c".repeat(64),
    },
  } as unknown as QueryPlanV3;
}

function result(patch: Partial<RetrievalResultV3> = {}): RetrievalResultV3 {
  return {
    outcome: {
      status: "no_compatible_tracks",
      stopReason: "frontier_exhausted",
      requestedTrackCount: 10,
      qualifiedTrackCount: 0,
      selectedTrackCount: 0,
      reserveTrackCount: 0,
      shortfall: 10,
      requiresPartialPublicationDecision: false,
    },
    stages: {
      discovered: 12,
      validCandidates: 12,
      scopeEligible: 0,
      hardConstraintEligible: 0,
      evidenceEligible: 0,
      versionCompatible: 0,
      storefrontPlayable: 12,
      canonicalUnique: 12,
      selected: 0,
      reserve: 0,
    },
    strategies: [
      {
        id: "one",
        engine: "curated_genre_scene",
        kind: "trusted_containers",
        discoveryDependencyIds: ["apple_catalog"],
        qualificationDependencyIds: ["apple_catalog"],
        status: "exhausted",
        rounds: 1,
        rawCandidates: 6,
        newQualifiedFamilies: 0,
        consecutiveZeroQualifiedYieldRounds: 1,
        providerFailures: 0,
        cursor: null,
      },
      {
        id: "two",
        engine: "curated_genre_scene",
        kind: "editorial_tracks",
        discoveryDependencyIds: ["hosted_web"],
        qualificationDependencyIds: ["hosted_web"],
        status: "exhausted",
        rounds: 1,
        rawCandidates: 6,
        newQualifiedFamilies: 0,
        consecutiveZeroQualifiedYieldRounds: 1,
        providerFailures: 0,
        cursor: null,
      },
    ],
    predicateDiagnostics: {
      qualificationsObserved: 12,
      scopeFailures: 12,
      failedMembershipPredicateIds: { genre: 12 },
      attemptedCanonicalClauseIds: ["genre"],
      appleLookupCount: 12,
      appleProviderRequestCount: 1,
      rootCause: "evidence_shortfall",
      recoveryAttemptCount: 0,
    },
    candidateLeads: [],
    dependencyOutages: [],
    ...patch,
  } as RetrievalResultV3;
}

describe("SemanticCollapseAuditV1", () => {
  test("treats catalog-rich dominant rejection as a decision, not scarcity proof", () => {
    const audit = auditSemanticCollapseV1({
      queryPlan: queryPlan(),
      result: result(),
    });
    expect(audit).toMatchObject({
      triggered: true,
      disposition: "scarcity_decision",
      signalCodes: expect.arrayContaining([
        "catalog_safe_target_with_zero_qualification",
        "independent_frontiers_dominantly_rejected",
      ]),
    });
  });

  test("quarantines missing producer coverage instead of asking the user", () => {
    const plan = queryPlan();
    const audit = auditSemanticCollapseV1({
      queryPlan: {
        ...plan,
        executionCoverageReport: {
          ...plan.executionCoverageReport!,
          complete: false,
          coveredObligationIds: [],
          uncoveredObligationIds: ["verification:genre"],
        },
      },
      result: result(),
      unresolvedUserSemanticClauseIds: ["genre"],
    });
    expect(audit.disposition).toBe("technical_quarantine");
  });

  test("classifies an active upstream outage as a dependency blocker", () => {
    const audit = auditSemanticCollapseV1({
      queryPlan: queryPlan(),
      result: result({
        dependencyOutages: [{
          dependencyId: "hosted_web",
          active: true,
          outageCount: 1,
          failureAttempts: 1,
          circuitOpen: true,
          failureClass: "transient",
          retryAfterUntil: null,
          affectedStrategyIds: ["two"],
        }],
      }),
    });
    expect(audit.disposition).toBe("dependency_blocker");
  });

  test("does not invent missing acquisition axes when canonical qualification assessed every leaf", () => {
    const base = queryPlan();
    const verificationExpression = {
      op: "allOf" as const,
      children: [
        {
          ...base.verificationExpression!,
          obligationId: "verification:storefront",
          clauseId: "storefront",
          axis: "storefront_availability",
        },
        {
          ...base.verificationExpression!,
          obligationId: "verification:version",
          clauseId: "version",
          axis: "recording_version",
        },
        {
          ...base.verificationExpression!,
          obligationId: "verification:evidence",
          clauseId: "evidence",
          axis: "evidence",
        },
        base.verificationExpression!,
      ],
    };
    const plan = {
      ...base,
      verificationExpression,
      executionCoverageReport: {
        ...base.executionCoverageReport!,
        coveredObligationIds: [
          "verification:evidence",
          "verification:genre",
          "verification:storefront",
          "verification:version",
        ],
      },
    } as QueryPlanV3;
    const audit = auditSemanticCollapseV1({
      queryPlan: plan,
      result: result({
        stages: {
          discovered: 158,
          validCandidates: 158,
          scopeEligible: 0,
          hardConstraintEligible: 0,
          evidenceEligible: 68,
          versionCompatible: 123,
          storefrontPlayable: 123,
          canonicalUnique: 0,
          selected: 0,
          reserve: 0,
        },
        predicateDiagnostics: {
          qualificationsObserved: 158,
          scopeFailures: 90,
          failedMembershipPredicateIds: { genre: 36 },
          attemptedCanonicalClauseIds: [
            "evidence",
            "genre",
            "storefront",
            "version",
          ],
          appleLookupCount: 158,
          appleProviderRequestCount: 4,
          rootCause: "evidence_shortfall",
          recoveryAttemptCount: 0,
        },
      }),
    });

    expect(audit.signalCodes).not.toContain(
      "required_evidence_axis_has_no_acquisition_attempt",
    );
    expect(audit.limitingObligationIds).toEqual([]);
    expect(audit.disposition).not.toBe("technical_quarantine");
  });
});
