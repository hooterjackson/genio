import { describe, expect, test } from "vitest";
import {
  auditSemanticCollapseV2,
  type SemanticCollapseAuditInputV2,
} from "../server/semantic-collapse-audit-v2.ts";

function irishUnknownFixture(
  overrides: Partial<SemanticCollapseAuditInputV2> = {},
): SemanticCollapseAuditInputV2 {
  return {
    requestedTrackCount: 25,
    uniqueLeadCount: 80,
    materializedCandidateCount: 77,
    uniqueRecordingFamilyCount: 77,
    storefrontPlayableCount: 73,
    evidenceQualifiedCount: 0,
    obligations: [{
      obligationId: "historical_influence",
      required: true,
      pass: 0,
      fail: 0,
      unknown: 77,
      acquisitionAttemptCount: 0,
      capableProducerFamilies: ["hosted_editorial"],
      attemptedProducerFamilies: [],
      attemptedProducerRoots: [],
      malformedEvidenceCount: 0,
      wrongAxisEvidenceCount: 0,
    }],
    producers: [{
      producerFamily: "hosted_editorial",
      dependencyRootId: "hosted-search-a",
      health: "healthy",
      retryAfterAt: null,
    }],
    unresolvedUserSemanticClauseIds: [],
    frontierExhausted: false,
    localBudgetExhausted: false,
    ...overrides,
  };
}

describe("SemanticCollapseAuditV2", () => {
  test("routes the 80/77/73/all-unknown incident to bounded enrichment", () => {
    expect(auditSemanticCollapseV2(irishUnknownFixture())).toMatchObject({
      triggered: true,
      disposition: "deficit_research",
      reasonCode: "bounded_evidence_enrichment_required",
      limitingObligationIds: ["historical_influence"],
      signalCodes: expect.arrayContaining([
        "catalog_safe_target_with_zero_qualification",
        "hard_obligation_unknown_for_every_candidate",
        "required_evidence_axis_has_no_acquisition_attempt",
      ]),
    });
  });

  test("quarantines an obligation with no certified producer", () => {
    const base = irishUnknownFixture();
    expect(auditSemanticCollapseV2(irishUnknownFixture({
      obligations: [{
        ...base.obligations[0]!,
        capableProducerFamilies: [],
      }],
    }))).toMatchObject({
      disposition: "technical_quarantine",
      reasonCode: "capability_gap",
    });
  });

  test("waits visibly when a capable producer is unhealthy", () => {
    const retryAfterAt = "2026-08-02T05:00:00.000Z";
    expect(auditSemanticCollapseV2(irishUnknownFixture({
      obligations: [{
        ...irishUnknownFixture().obligations[0]!,
        acquisitionAttemptCount: 1,
        attemptedProducerFamilies: ["hosted_editorial"],
        attemptedProducerRoots: [{
          producerFamily: "hosted_editorial",
          dependencyRootId: "hosted-search-a",
        }],
      }],
      producers: [{
        producerFamily: "hosted_editorial",
        dependencyRootId: "hosted-search-a",
        health: "unhealthy",
        retryAfterAt,
      }],
    }))).toMatchObject({
      disposition: "dependency_blocker",
      reasonCode: "evidence_dependency_unhealthy",
      nextRetryAt: retryAfterAt,
    });
  });

  test("aggregates all dependency roots instead of letting the last root overwrite producer health", () => {
    const base = irishUnknownFixture();
    const audit = auditSemanticCollapseV2(irishUnknownFixture({
      obligations: [{
        ...base.obligations[0]!,
        acquisitionAttemptCount: 0,
        attemptedProducerFamilies: [],
      }],
      producers: [{
        producerFamily: "hosted_editorial",
        dependencyRootId: "hosted-search-a",
        health: "healthy",
        retryAfterAt: null,
      }, {
        producerFamily: "hosted_editorial",
        dependencyRootId: "hosted-search-b",
        health: "unhealthy",
        retryAfterAt: "2026-08-02T05:00:00.000Z",
      }],
    }));
    expect(audit).toMatchObject({
      disposition: "deficit_research",
      reasonCode: "bounded_evidence_enrichment_required",
    });
  });

  test("keeps an unattempted healthy root available after trying a sibling root", () => {
    const base = irishUnknownFixture();
    const audit = auditSemanticCollapseV2(irishUnknownFixture({
      obligations: [{
        ...base.obligations[0]!,
        acquisitionAttemptCount: 1,
        attemptedProducerFamilies: ["hosted_editorial"],
        attemptedProducerRoots: [{
          producerFamily: "hosted_editorial",
          dependencyRootId: "hosted-search-a",
        }],
      }],
      producers: [{
        producerFamily: "hosted_editorial",
        dependencyRootId: "hosted-search-a",
        health: "healthy",
        retryAfterAt: null,
      }, {
        producerFamily: "hosted_editorial",
        dependencyRootId: "hosted-search-b",
        health: "healthy",
        retryAfterAt: null,
      }],
    }));
    expect(audit).toMatchObject({
      disposition: "deficit_research",
      reasonCode: "bounded_evidence_enrichment_required",
      signalCodes: expect.arrayContaining([
        "required_evidence_axis_has_no_acquisition_attempt",
      ]),
    });
  });

  test("quarantines wrong-axis evidence instead of asking the user", () => {
    expect(auditSemanticCollapseV2(irishUnknownFixture({
      obligations: [{
        ...irishUnknownFixture().obligations[0]!,
        acquisitionAttemptCount: 1,
        attemptedProducerFamilies: ["hosted_editorial"],
        attemptedProducerRoots: [{
          producerFamily: "hosted_editorial",
          dependencyRootId: "hosted-search-a",
        }],
        wrongAxisEvidenceCount: 77,
      }],
    }))).toMatchObject({
      disposition: "technical_quarantine",
      reasonCode: "evidence_binding_defect",
    });
  });

  test("unknown evidence can never become a scarcity decision", () => {
    const audit = auditSemanticCollapseV2(irishUnknownFixture({
      obligations: [{
        ...irishUnknownFixture().obligations[0]!,
        acquisitionAttemptCount: 2,
        attemptedProducerFamilies: ["hosted_editorial"],
        attemptedProducerRoots: [{
          producerFamily: "hosted_editorial",
          dependencyRootId: "hosted-search-a",
        }, {
          producerFamily: "hosted_editorial",
          dependencyRootId: "hosted-search-b",
        }],
      }],
      producers: [
        {
          producerFamily: "hosted_editorial",
          dependencyRootId: "hosted-search-a",
          health: "healthy",
          retryAfterAt: null,
        },
        {
          producerFamily: "hosted_editorial",
          dependencyRootId: "hosted-search-b",
          health: "healthy",
          retryAfterAt: null,
        },
      ],
      frontierExhausted: true,
    }));
    expect(audit.disposition).toBe("deficit_research");
    expect(audit.reasonCode).not.toBe("frontier_exhausted_under_policy");
  });

  test("local budget exhaustion is an operational decision, not scarcity", () => {
    const audit = auditSemanticCollapseV2(irishUnknownFixture({
      obligations: [{
        ...irishUnknownFixture().obligations[0]!,
        acquisitionAttemptCount: 1,
        attemptedProducerFamilies: ["hosted_editorial"],
        attemptedProducerRoots: [{
          producerFamily: "hosted_editorial",
          dependencyRootId: "hosted-search-a",
        }],
        unknown: 0,
        fail: 77,
      }],
      localBudgetExhausted: true,
    }));
    expect(audit).toMatchObject({
      disposition: "actionable_decision",
      reasonCode: "local_budget_exhausted",
    });
  });

  test("allows a named scarcity decision only after independent healthy fail evidence", () => {
    expect(auditSemanticCollapseV2(irishUnknownFixture({
      obligations: [{
        ...irishUnknownFixture().obligations[0]!,
        fail: 77,
        unknown: 0,
        acquisitionAttemptCount: 2,
        capableProducerFamilies: ["editorial-a", "editorial-b"],
        attemptedProducerFamilies: ["editorial-a", "editorial-b"],
        attemptedProducerRoots: [{
          producerFamily: "editorial-a",
          dependencyRootId: "independent-a",
        }, {
          producerFamily: "editorial-b",
          dependencyRootId: "independent-b",
        }],
      }],
      producers: [
        {
          producerFamily: "editorial-a",
          dependencyRootId: "independent-a",
          health: "healthy",
          retryAfterAt: null,
        },
        {
          producerFamily: "editorial-b",
          dependencyRootId: "independent-b",
          health: "healthy",
          retryAfterAt: null,
        },
      ],
      frontierExhausted: true,
    }))).toMatchObject({
      disposition: "scarcity_decision",
      reasonCode: "frontier_exhausted_under_policy",
      independentDependencyRootIds: ["independent-a", "independent-b"],
    });
  });

  test("does not count a satisfied obligation root toward the limiting frontier", () => {
    const base = irishUnknownFixture();
    const audit = auditSemanticCollapseV2(irishUnknownFixture({
      obligations: [{
        ...base.obligations[0]!,
        fail: 77,
        unknown: 0,
        acquisitionAttemptCount: 1,
        capableProducerFamilies: ["influence-editorial"],
        attemptedProducerFamilies: ["influence-editorial"],
        attemptedProducerRoots: [{
          producerFamily: "influence-editorial",
          dependencyRootId: "limiting-influence-root",
        }],
      }, {
        obligationId: "artist_origin",
        required: true,
        pass: 77,
        fail: 0,
        unknown: 0,
        acquisitionAttemptCount: 1,
        capableProducerFamilies: ["origin-registry"],
        attemptedProducerFamilies: ["origin-registry"],
        attemptedProducerRoots: [{
          producerFamily: "origin-registry",
          dependencyRootId: "unrelated-satisfied-root",
        }],
        malformedEvidenceCount: 0,
        wrongAxisEvidenceCount: 0,
      }],
      producers: [{
        producerFamily: "influence-editorial",
        dependencyRootId: "limiting-influence-root",
        health: "healthy",
        retryAfterAt: null,
      }, {
        producerFamily: "origin-registry",
        dependencyRootId: "unrelated-satisfied-root",
        health: "healthy",
        retryAfterAt: null,
      }],
      frontierExhausted: true,
    }));

    expect(audit).toMatchObject({
      disposition: "deficit_research",
      reasonCode: "bounded_evidence_enrichment_required",
      limitingObligationIds: ["historical_influence"],
      independentDependencyRootIds: ["limiting-influence-root"],
    });
  });
});
