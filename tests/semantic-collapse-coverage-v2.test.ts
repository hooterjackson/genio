import { describe, expect, test } from "vitest";
import type { QueryPlanV3 } from "../shared/types.ts";
import type {
  EvidenceAcquisitionAttemptV3,
  RetrievalResultV3,
} from "../server/pipeline-v3-retrieval.ts";
import {
  createSemanticCollapseDatabaseFactsV2,
  parseSemanticCollapseDatabaseFactsV2,
  parseSemanticCollapseCoverageV2,
  semanticCollapseTelemetryDivergenceV2,
  semanticCollapseCoverageV2,
} from "../server/semantic-collapse-coverage-v2.ts";
import { auditSemanticCollapseV2 } from "../server/semantic-collapse-audit-v2.ts";
import {
  canonicalContractExecutionPolicyV1,
} from "../server/canonical-contract-runtime-v1.ts";
import {
  compilePlaylistContractRevisionV1,
} from "../server/playlist-contract-v1.ts";
import {
  centralQualityVerificationLeavesV1,
  verificationExpressionV1,
} from "../server/verification-expression-v1.ts";

const queryPlan = {
  verificationExpression: {
    op: "leaf",
    obligationId: "verification:influence",
    clauseId: "influence",
    polarity: "positive",
    axis: "influence",
    verifierFamilies: ["factual_source"],
    permittedEvidenceGrades: ["independent_secondary_source"],
    unknownPolicy: "reject",
    storefront: "us",
    versionPolicy: "catalog_policy_v1",
    evidencePolicyVersion: "governed_evidence_v2",
    capableProducerFamilies: ["factual_source"],
    negativeScope: null,
  },
} as unknown as QueryPlanV3;

const result = {
  outcome: {
    requestedTrackCount: 25,
    stopReason: "frontier_exhausted",
  },
  stages: {
    discovered: 80,
    validCandidates: 80,
    evidenceEligible: 0,
    storefrontPlayable: 73,
    canonicalUnique: 73,
  },
  strategies: [{
    discoveryDependencyIds: ["hosted_web"],
    qualificationDependencyIds: ["hosted_web"],
    status: "exhausted",
  }],
  dependencyOutages: [],
  predicateDiagnostics: {
    qualificationsObserved: 77,
    attemptedCanonicalClauseIds: ["influence"],
    canonicalClauseDispositionCounts: {
      influence: { pass: 0, fail: 0, unknown: 77 },
    },
  },
  candidateLeads: Array.from({ length: 80 }, (_, index) => ({
    candidateKey: `lead-${index + 1}`,
  })),
} as unknown as RetrievalResultV3;

function databaseFacts(input: {
  clauseCounts?: { pass: number; fail: number; unknown: number };
  evidenceAcquisitionAttempts?: readonly EvidenceAcquisitionAttemptV3[];
} = {}) {
  return createSemanticCollapseDatabaseFactsV2({
    queryPlanHash: "a".repeat(64),
    contractRevisionId: "contract-revision",
    observationCount: 80,
    uniqueLeadCount: 80,
    materializedCandidateCount: 77,
    uniqueRecordingFamilyCount: 73,
    storefrontPlayableCount: 73,
    evidenceQualifiedCount: 0,
    nullCandidateQualificationCount: 0,
    evidenceAcquisitionAttempts: input.evidenceAcquisitionAttempts ?? [],
    canonicalClauseDispositionCounts: {
      influence: input.clauseCounts ?? { pass: 0, fail: 0, unknown: 77 },
    },
    capturedAt: "2026-08-02T04:00:00.000Z",
  });
}

function evidenceAttempt(input: {
  obligationId?: string;
  producerFamily?: EvidenceAcquisitionAttemptV3["producerFamily"];
  dependencyRootId?: EvidenceAcquisitionAttemptV3["dependencyRootId"];
  attemptCount?: number;
} = {}): EvidenceAcquisitionAttemptV3 {
  return {
    obligationId: input.obligationId ?? "verification:influence",
    producerFamily: input.producerFamily ?? "factual_source",
    dependencyRootId: input.dependencyRootId ?? "hosted_web",
    operation: "qualify",
    attemptedAt: "2026-08-02T03:59:00.000Z",
    outcome: "success",
    failureClass: null,
    retryAfterUntil: null,
    strategyDeltaProofHash: "f".repeat(64),
    automaticRescueOrdinal: 1,
    attemptCount: input.attemptCount ?? 1,
  };
}

describe("semanticCollapseCoverageV2", () => {
  test("persists the production-shaped 80/77/73 tri-state facts", () => {
    const coverage = semanticCollapseCoverageV2({
      queryPlan,
      queryPlanHash: "a".repeat(64),
      result,
      databaseFacts: databaseFacts(),
      capturedAt: "2026-08-02T04:00:00.000Z",
    });
    expect(coverage).toMatchObject({
      uniqueLeadCount: 80,
      materializedCandidateCount: 77,
      storefrontPlayableCount: 73,
      evidenceQualifiedCount: 0,
      obligations: [{
        obligationId: "verification:influence",
        pass: 0,
        fail: 0,
        unknown: 77,
        acquisitionAttemptCount: 0,
        attemptedProducerFamilies: [],
        attemptedProducerRoots: [],
      }],
    });
    expect(parseSemanticCollapseCoverageV2(coverage)).toEqual(coverage);
  });

  test("uses explicit evidence acquisition calls rather than clause evaluation", () => {
    expect(semanticCollapseCoverageV2({
      queryPlan,
      queryPlanHash: "a".repeat(64),
      result,
      databaseFacts: databaseFacts({
        evidenceAcquisitionAttempts: [evidenceAttempt({ attemptCount: 2 })],
      }),
      capturedAt: "2026-08-02T04:00:00.000Z",
    }).obligations[0]).toMatchObject({
      acquisitionAttemptCount: 2,
      attemptedProducerFamilies: ["factual_source"],
      attemptedProducerRoots: [{
        producerFamily: "factual_source",
        dependencyRootId: "hosted_web",
      }],
    });
  });

  test("audits evidence-backed central quality even when hard membership passes", () => {
    const centralQualityPlan = {
      ...queryPlan,
      verificationExpression: {
        ...queryPlan.verificationExpression,
        obligationId: "verification:irish-membership",
        clauseId: "irish-membership",
        axis: "geography",
        capableProducerFamilies: ["structured_music_metadata"],
        verifierFamilies: ["structured_music_metadata"],
      },
      canonicalContractPolicy: {
        evidencePolicyVersion: "governed_evidence_v2",
        catalogPolicyVersion: "catalog_policy_v1",
        storefront: "us",
        clauses: [{
          id: "irish-membership",
          kind: "membership",
          axis: "geography",
          operator: "require",
          evidence: { permittedGrades: ["independent_secondary_source"] },
          unknownPolicy: "reject",
        }, {
          id: "influence-quality",
          kind: "suitability",
          axis: "influence",
          operator: "prefer",
          evidence: {
            permittedGrades: [
              "track_specific_editorial_assertion",
              "independent_secondary_source",
            ],
          },
          unknownPolicy: "defer",
        }],
      },
      playlistQualityPolicy: {
        policyVersion: "canonical_central_quality_v1",
        clauseIds: ["influence-quality"],
        criteria: ["documented historical influence"],
        minimumPassRatio: 0.8,
        maximumUnknownRatio: 0.2,
        zeroKnownFailures: true,
        signalDimension: "central_quality",
        passThreshold: 0.75,
        failThreshold: 0.4,
        signalSemantics: "ranking_only_not_factual_evidence",
      },
    } as unknown as QueryPlanV3;
    const centralResult = {
      ...result,
      stages: {
        ...result.stages,
        evidenceEligible: 73,
      },
      predicateDiagnostics: {
        ...result.predicateDiagnostics,
        canonicalClauseDispositionCounts: {
          "irish-membership": { pass: 77, fail: 0, unknown: 0 },
          "influence-quality": { pass: 0, fail: 0, unknown: 77 },
        },
      },
    } as unknown as RetrievalResultV3;
    const centralFacts = createSemanticCollapseDatabaseFactsV2({
      queryPlanHash: "b".repeat(64),
      contractRevisionId: "contract-revision",
      observationCount: 80,
      uniqueLeadCount: 80,
      materializedCandidateCount: 77,
      uniqueRecordingFamilyCount: 73,
      storefrontPlayableCount: 73,
      evidenceQualifiedCount: 73,
      nullCandidateQualificationCount: 0,
      evidenceAcquisitionAttempts: [evidenceAttempt({
        obligationId: "central_quality:influence-quality",
        producerFamily: "suitability_assessment",
        attemptCount: 2,
      })],
      canonicalClauseDispositionCounts: {
        "irish-membership": { pass: 77, fail: 0, unknown: 0 },
        "influence-quality": { pass: 0, fail: 0, unknown: 77 },
      },
      capturedAt: "2026-08-02T04:00:00.000Z",
    });
    const coverage = semanticCollapseCoverageV2({
      queryPlan: centralQualityPlan,
      queryPlanHash: "b".repeat(64),
      result: centralResult,
      databaseFacts: centralFacts,
      capturedAt: "2026-08-02T04:00:00.000Z",
    });
    expect(coverage.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        obligationId: "central_quality:influence-quality",
        pass: 0,
        fail: 0,
        unknown: 77,
        acquisitionAttemptCount: 2,
      }),
    ]));
  });

  test("carries a newly compiled influence-quality clause through the query-plan policy into the coverage audit", () => {
    const qualityClauseId = "quality:historical-influence";
    const contract = compilePlaylistContractRevisionV1({
      contractId: "contract:irish-influence-coverage",
      rawPrompt: "Influential Irish music",
      requestedTrackCount: 25,
      locale: "en-US",
      storefront: "us",
      clauses: [{
        id: "membership:irish",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "geography",
        operator: "require",
        values: ["Irish"],
        source: { provenance: "prompt", text: "Irish" },
      }, {
        id: qualityClauseId,
        kind: "suitability",
        scope: "track",
        hardness: "soft",
        axis: "influence",
        operator: "prefer",
        values: ["documented historical influence"],
        source: { provenance: "prompt", text: "Influential" },
        evidence: {
          required: true,
          minimumGrade: null,
          permittedGrades: [
            "track_specific_editorial_assertion",
            "independent_secondary_source",
          ],
        },
        unknownPolicy: "defer",
      }],
      trackPredicate: {
        op: "clause",
        clauseId: "membership:irish",
      },
      qualityPolicy: {
        centralSuitabilityClauseIds: [qualityClauseId],
        minimumPassRatio: 0.8,
        maximumUnknownRatio: 0.2,
        zeroKnownFailures: true,
      },
    });
    const canonicalContractPolicy =
      canonicalContractExecutionPolicyV1(contract);
    const playlistQualityPolicy = {
      policyVersion: "canonical_central_quality_v1" as const,
      clauseIds: [qualityClauseId],
      criteria: ["documented historical influence"],
      minimumPassRatio: 0.8,
      maximumUnknownRatio: 0.2,
      zeroKnownFailures: true as const,
      signalDimension: "central_quality" as const,
      passThreshold: 0.75,
      failThreshold: 0.4,
      signalSemantics: "ranking_only_not_factual_evidence" as const,
    };
    const qualityLeaves = centralQualityVerificationLeavesV1({
      policy: canonicalContractPolicy,
      qualityPolicy: playlistQualityPolicy,
    });
    expect(canonicalContractPolicy.clauses).toContainEqual(
      expect.objectContaining({
        id: qualityClauseId,
        kind: "suitability",
        axis: "influence",
        operator: "require",
      }),
    );
    expect(qualityLeaves).toEqual([
      expect.objectContaining({
        obligationId: `central_quality:${qualityClauseId}`,
        clauseId: qualityClauseId,
        axis: "influence",
        unknownPolicy: "defer",
      }),
    ]);

    const compiledQueryPlan = {
      ...queryPlan,
      verificationExpression: verificationExpressionV1(
        canonicalContractPolicy,
      ),
      canonicalContractPolicy,
      playlistQualityPolicy,
    } as unknown as QueryPlanV3;
    const compiledResult = {
      ...result,
      stages: {
        ...result.stages,
        evidenceEligible: 0,
      },
      predicateDiagnostics: {
        ...result.predicateDiagnostics,
        attemptedCanonicalClauseIds: [
          "membership:irish",
          qualityClauseId,
        ],
        canonicalClauseDispositionCounts: {
          "membership:irish": { pass: 77, fail: 0, unknown: 0 },
          [qualityClauseId]: { pass: 0, fail: 0, unknown: 77 },
        },
        evidenceAcquisitionAttempts: [],
      },
    } as unknown as RetrievalResultV3;
    const capturedAt = "2026-08-02T04:00:00.000Z";
    const compiledFacts = createSemanticCollapseDatabaseFactsV2({
      queryPlanHash: "c".repeat(64),
      contractRevisionId: contract.revisionId,
      observationCount: 80,
      uniqueLeadCount: 80,
      materializedCandidateCount: 77,
      uniqueRecordingFamilyCount: 73,
      storefrontPlayableCount: 73,
      evidenceQualifiedCount: 0,
      nullCandidateQualificationCount: 0,
      canonicalClauseDispositionCounts: {
        "membership:irish": { pass: 77, fail: 0, unknown: 0 },
        [qualityClauseId]: { pass: 0, fail: 0, unknown: 77 },
      },
      capturedAt,
    });
    const coverage = semanticCollapseCoverageV2({
      queryPlan: compiledQueryPlan,
      queryPlanHash: "c".repeat(64),
      result: compiledResult,
      databaseFacts: compiledFacts,
      capturedAt,
    });

    expect(coverage.telemetryDivergenceCodes).toEqual([]);
    expect(coverage.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        obligationId: `central_quality:${qualityClauseId}`,
        pass: 0,
        fail: 0,
        unknown: 77,
      }),
    ]));
    expect(auditSemanticCollapseV2(coverage)).toMatchObject({
      disposition: "deficit_research",
      reasonCode: "bounded_evidence_enrichment_required",
      limitingObligationIds: expect.arrayContaining([
        `central_quality:${qualityClauseId}`,
      ]),
    });
  });

  test("does not invent a certified producer root missing from the live route", () => {
    const noLiveProducer = {
      ...result,
      strategies: [{
        discoveryDependencyIds: ["apple_catalog"],
        qualificationDependencyIds: ["apple_catalog"],
        status: "exhausted",
      }],
    } as unknown as RetrievalResultV3;
    const coverage = semanticCollapseCoverageV2({
      queryPlan,
      queryPlanHash: "a".repeat(64),
      result: noLiveProducer,
      databaseFacts: databaseFacts(),
      capturedAt: "2026-08-02T04:00:00.000Z",
    });
    expect(coverage.obligations[0]).toMatchObject({
      capableProducerFamilies: [],
      attemptedProducerFamilies: [],
      attemptedProducerRoots: [],
    });
    expect(coverage.producers).toEqual([]);
    expect(auditSemanticCollapseV2(coverage)).toMatchObject({
      disposition: "technical_quarantine",
      reasonCode: "capability_gap",
    });
  });

  test("persists wrong-axis proof as unknown structural evidence instead of a pass", () => {
    const structurallyInvalid = {
      ...result,
      predicateDiagnostics: {
        ...result.predicateDiagnostics,
        canonicalClauseDispositionCounts: {
          influence: { pass: 77, fail: 0, unknown: 0 },
        },
        evidenceBindingDefects: [{
          obligationId: "verification:influence",
          malformedEvidenceCount: 0,
          wrongAxisEvidenceCount: 77,
        }],
      },
    } as RetrievalResultV3;
    expect(semanticCollapseCoverageV2({
      queryPlan,
      queryPlanHash: "a".repeat(64),
      result: structurallyInvalid,
      databaseFacts: databaseFacts({
        clauseCounts: { pass: 77, fail: 0, unknown: 0 },
        evidenceAcquisitionAttempts: [evidenceAttempt({
          attemptCount: 77,
        })],
      }),
      capturedAt: "2026-08-02T04:00:00.000Z",
    }).obligations[0]).toMatchObject({
      pass: 0,
      fail: 0,
      unknown: 77,
      malformedEvidenceCount: 0,
      wrongAxisEvidenceCount: 77,
      acquisitionAttemptCount: 77,
    });
  });

  test("rejects a tampered persisted checkpoint", () => {
    const coverage = semanticCollapseCoverageV2({
      queryPlan,
      queryPlanHash: "a".repeat(64),
      result,
      databaseFacts: databaseFacts(),
      capturedAt: "2026-08-02T04:00:00.000Z",
    });
    expect(parseSemanticCollapseCoverageV2({
      ...coverage,
      storefrontPlayableCount: 0,
    })).toBeNull();
  });

  test("keeps pre-evidence recording families distinct from post-evidence canonical yield", () => {
    const facts = databaseFacts();
    expect(parseSemanticCollapseDatabaseFactsV2(facts)).toEqual(facts);
    expect(parseSemanticCollapseDatabaseFactsV2({
      ...facts,
      uniqueLeadCount: 79,
    })).toBeNull();
    const coverage = semanticCollapseCoverageV2({
      queryPlan,
      queryPlanHash: "a".repeat(64),
      result: {
        ...result,
        stages: { ...result.stages, discovered: 1_005, canonicalUnique: 0 },
      },
      databaseFacts: facts,
      capturedAt: "2026-08-02T04:00:00.000Z",
    });
    expect(coverage).toMatchObject({
      observationCount: 80,
      uniqueLeadCount: 80,
      materializedCandidateCount: 77,
      uniqueRecordingFamilyCount: 73,
      telemetryDivergenceCodes: expect.arrayContaining([
        "observation_count_mismatch",
      ]),
    });
    expect(coverage.telemetryDivergenceCodes).not.toContain(
      "recording_family_count_mismatch",
    );
  });

  test("compares cumulative observations and unique candidates without duplicate false quarantine", () => {
    const duplicatedResult = {
      ...result,
      stages: {
        ...result.stages,
        discovered: 3,
        validCandidates: 3,
        storefrontPlayable: 0,
      },
      candidateLeads: [{ candidateKey: "lead-1" }],
      predicateDiagnostics: {
        ...result.predicateDiagnostics,
        qualificationsObserved: 3,
        uniqueQualificationsObserved: 1,
        canonicalClauseDispositionCounts: {
          influence: { pass: 0, fail: 0, unknown: 1 },
        },
      },
    } as unknown as RetrievalResultV3;
    const duplicatedFacts = createSemanticCollapseDatabaseFactsV2({
      queryPlanHash: "d".repeat(64),
      contractRevisionId: "contract-revision",
      observationCount: 3,
      uniqueLeadCount: 1,
      materializedCandidateCount: 1,
      uniqueRecordingFamilyCount: 1,
      storefrontPlayableCount: 0,
      evidenceQualifiedCount: 0,
      nullCandidateQualificationCount: 0,
      canonicalClauseDispositionCounts: {
        influence: { pass: 0, fail: 0, unknown: 1 },
      },
      capturedAt: "2026-08-02T04:00:00.000Z",
    });
    expect(semanticCollapseTelemetryDivergenceV2({
      result: duplicatedResult,
      databaseFacts: duplicatedFacts,
      queryPlan,
    })).toEqual([]);
  });

  test("compares a one-candidate rescue with cumulative 80/77/73 database truth", () => {
    const rescueResult = {
      ...result,
      stages: {
        ...result.stages,
        discovered: 81,
        validCandidates: 77,
        evidenceEligible: 1,
        storefrontPlayable: 73,
        canonicalUnique: 1,
      },
      predicateDiagnostics: {
        ...result.predicateDiagnostics,
        // A bounded repair pass reports only the candidate it actually
        // evaluated. The collapse audit reads cumulative latest-distinct
        // qualification truth from the database projection.
        qualificationsObserved: 1,
        uniqueQualificationsObserved: 1,
        canonicalClauseDispositionCounts: {
          influence: { pass: 1, fail: 0, unknown: 0 },
        },
        evidenceAcquisitionAttempts: [evidenceAttempt()],
      },
      continuationTelemetryScope: "pass_local_qualification_projection",
    } as unknown as RetrievalResultV3;
    const cumulativeFacts = createSemanticCollapseDatabaseFactsV2({
      queryPlanHash: "e".repeat(64),
      contractRevisionId: "contract-revision",
      observationCount: 81,
      uniqueLeadCount: 80,
      materializedCandidateCount: 77,
      uniqueRecordingFamilyCount: 73,
      storefrontPlayableCount: 73,
      evidenceQualifiedCount: 1,
      nullCandidateQualificationCount: 0,
      evidenceAcquisitionAttempts: [evidenceAttempt()],
      canonicalClauseDispositionCounts: {
        influence: { pass: 1, fail: 0, unknown: 76 },
      },
      capturedAt: "2026-08-02T04:00:00.000Z",
    });
    const coverage = semanticCollapseCoverageV2({
      queryPlan,
      queryPlanHash: "e".repeat(64),
      result: rescueResult,
      databaseFacts: cumulativeFacts,
      capturedAt: "2026-08-02T04:00:00.000Z",
      authenticatedEvidenceRepairContinuation: {
        strategyDeltaProofHash: "f".repeat(64),
        automaticRescueOrdinal: 1,
      },
    });
    expect(coverage).toMatchObject({
      observationCount: 81,
      uniqueLeadCount: 80,
      materializedCandidateCount: 77,
      storefrontPlayableCount: 73,
      evidenceQualifiedCount: 1,
      telemetryDivergenceCodes: [],
      obligations: [{
        pass: 1,
        fail: 0,
        unknown: 76,
      }],
    });
  });

  test.each([
    {
      label: "a newly playable candidate",
      storefrontPlayableCount: 74,
      evidenceQualifiedCount: 2,
    },
    {
      label: "a previously playable candidate becoming unavailable",
      storefrontPlayableCount: 72,
      evidenceQualifiedCount: 1,
    },
  ])("uses database latest-distinct truth when repair sees $label", ({
    storefrontPlayableCount,
    evidenceQualifiedCount,
  }) => {
    const passLocalResult = {
      ...result,
      continuationTelemetryScope: "pass_local_qualification_projection",
      stages: {
        ...result.stages,
        discovered: 81,
        validCandidates: 77,
        storefrontPlayable: 73,
        evidenceEligible: 1,
      },
      predicateDiagnostics: {
        ...result.predicateDiagnostics,
        qualificationsObserved: 1,
        uniqueQualificationsObserved: 1,
        canonicalClauseDispositionCounts: {
          influence: { pass: 1, fail: 0, unknown: 0 },
        },
        evidenceAcquisitionAttempts: [evidenceAttempt()],
      },
    } as unknown as RetrievalResultV3;
    const latestDistinctFacts = createSemanticCollapseDatabaseFactsV2({
      queryPlanHash: "e".repeat(64),
      contractRevisionId: "contract-revision",
      observationCount: 81,
      uniqueLeadCount: 80,
      materializedCandidateCount: 77,
      uniqueRecordingFamilyCount: storefrontPlayableCount,
      storefrontPlayableCount,
      evidenceQualifiedCount,
      nullCandidateQualificationCount: 0,
      evidenceAcquisitionAttempts: [evidenceAttempt()],
      canonicalClauseDispositionCounts: {
        influence: {
          pass: evidenceQualifiedCount,
          fail: 0,
          unknown: 77 - evidenceQualifiedCount,
        },
      },
      capturedAt: "2026-08-02T04:00:00.000Z",
    });

    expect(semanticCollapseTelemetryDivergenceV2({
      result: passLocalResult,
      databaseFacts: latestDistinctFacts,
      queryPlan,
      authenticatedEvidenceRepairContinuation: {
        strategyDeltaProofHash: "f".repeat(64),
        automaticRescueOrdinal: 1,
      },
    })).toEqual([]);
  });

  test("does not trust a self-declared pass-local marker without a validated rescue", () => {
    const untrustedResult = {
      ...result,
      continuationTelemetryScope: "pass_local_qualification_projection",
      stages: {
        ...result.stages,
        discovered: 81,
        storefrontPlayable: 73,
        evidenceEligible: 1,
      },
      predicateDiagnostics: {
        ...result.predicateDiagnostics,
        qualificationsObserved: 1,
        uniqueQualificationsObserved: 1,
        canonicalClauseDispositionCounts: {
          influence: { pass: 1, fail: 0, unknown: 0 },
        },
        evidenceAcquisitionAttempts: [evidenceAttempt()],
      },
    } as unknown as RetrievalResultV3;
    const cumulativeFacts = createSemanticCollapseDatabaseFactsV2({
      queryPlanHash: "e".repeat(64),
      contractRevisionId: "contract-revision",
      observationCount: 81,
      uniqueLeadCount: 80,
      materializedCandidateCount: 77,
      uniqueRecordingFamilyCount: 73,
      storefrontPlayableCount: 73,
      evidenceQualifiedCount: 1,
      nullCandidateQualificationCount: 0,
      evidenceAcquisitionAttempts: [evidenceAttempt()],
      canonicalClauseDispositionCounts: {
        influence: { pass: 1, fail: 0, unknown: 76 },
      },
      capturedAt: "2026-08-02T04:00:00.000Z",
    });

    expect(semanticCollapseTelemetryDivergenceV2({
      result: untrustedResult,
      databaseFacts: cumulativeFacts,
      queryPlan,
    })).toEqual(expect.arrayContaining([
      "materialized_candidate_count_mismatch",
      "clause_disposition_mismatch",
    ]));
  });

  test("does not trust a proof identity that differs from the executed repair", () => {
    const passLocalResult = {
      ...result,
      continuationTelemetryScope: "pass_local_qualification_projection",
      stages: {
        ...result.stages,
        discovered: 81,
        evidenceEligible: 1,
      },
      predicateDiagnostics: {
        ...result.predicateDiagnostics,
        qualificationsObserved: 1,
        uniqueQualificationsObserved: 1,
        canonicalClauseDispositionCounts: {
          influence: { pass: 1, fail: 0, unknown: 0 },
        },
        evidenceAcquisitionAttempts: [evidenceAttempt()],
      },
    } as unknown as RetrievalResultV3;
    const cumulativeFacts = createSemanticCollapseDatabaseFactsV2({
      queryPlanHash: "e".repeat(64),
      contractRevisionId: "contract-revision",
      observationCount: 81,
      uniqueLeadCount: 80,
      materializedCandidateCount: 77,
      uniqueRecordingFamilyCount: 73,
      storefrontPlayableCount: 73,
      evidenceQualifiedCount: 1,
      nullCandidateQualificationCount: 0,
      evidenceAcquisitionAttempts: [evidenceAttempt()],
      canonicalClauseDispositionCounts: {
        influence: { pass: 1, fail: 0, unknown: 76 },
      },
      capturedAt: "2026-08-02T04:00:00.000Z",
    });

    expect(semanticCollapseTelemetryDivergenceV2({
      result: passLocalResult,
      databaseFacts: cumulativeFacts,
      queryPlan,
      authenticatedEvidenceRepairContinuation: {
        strategyDeltaProofHash: "b".repeat(64),
        automaticRescueOrdinal: 1,
      },
    })).toEqual(expect.arrayContaining([
      "materialized_candidate_count_mismatch",
      "clause_disposition_mismatch",
    ]));
  });
});
