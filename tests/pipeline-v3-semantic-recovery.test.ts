import { describe, expect, test, vi } from "vitest";
import {
  createHostedWebEvidenceSnapshotV3,
  executeRetrievalV3,
  publicTrackScopeAttestationV3,
  RetrievalDependencyErrorV3,
  type CandidateQualificationV3,
  type QualificationRequestV3,
  type RawTrackCandidateV3,
  type RetrievalAdaptersV3,
} from "../server/pipeline-v3-retrieval.ts";
import {
  buildSemanticEquivalentRecoveryPlanV3,
  proposeSemanticRecoveryV3,
  semanticRecoveryMinimumSampleV3,
} from "../server/pipeline-v3-semantic-recovery.ts";
import {
  createRunSpecV3,
  resolveRunSpecV3,
  type MembershipPredicateV3,
  type SelectionPlanV3,
} from "../server/selection-plan-v3.ts";

const HOSTED_TEST_ACQUIRED_AT = new Date(Date.now() - 60_000).toISOString();
const HOSTED_TEST_FRESH_UNTIL = new Date(
  Date.parse(HOSTED_TEST_ACQUIRED_AT) + 29 * 24 * 60 * 60_000,
).toISOString();

function basePlan(prompt = "25 baile funk tracks", target = 5): SelectionPlanV3 {
  return resolveRunSpecV3(createRunSpecV3({
    prompt,
    requestedTrackCount: target,
    storefront: "US",
  }), []);
}

function aliasDuplicatePlan(): SelectionPlanV3 {
  const base = basePlan();
  const genre = base.membershipPredicates.find(({ axis }) => axis === "genre")!;
  return {
    ...base,
    membershipPredicates: [
      { ...genre, id: "genre:baile", values: ["baile funk"] },
      { ...genre, id: "genre:carioca", values: ["funk carioca"] },
    ],
  };
}

function candidates(count = 10): RawTrackCandidateV3[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `candidate-${index}`,
    artist: `Artist ${index}`,
    title: `Track ${index}`,
    album: `Album ${index}`,
    sourceObservationIds: [`source-${index}`],
  }));
}

function qualification(input: {
  candidate: RawTrackCandidateV3;
  plan: SelectionPlanV3;
  passed: boolean;
  lookupAttempted: boolean;
}): CandidateQualificationV3 {
  const predicateIds = input.plan.membershipPredicates
    .filter(({ operator, axis }) => operator !== "exclude" && !["era", "content", "recording_version"].includes(axis))
    .map(({ id }) => id);
  const sourceUrl = `https://evidence.example.test/${input.candidate.id}`;
  const excerpt =
    `${input.candidate.artist} — ${input.candidate.title}: exact scoped track evidence.`;
  const hostedEvidenceSnapshot = input.passed
    ? createHostedWebEvidenceSnapshotV3({
      sourceUrl,
      excerpt,
      responseId: `semantic-response-${input.candidate.id}`,
      outputItemId: `semantic-output-${input.candidate.id}`,
      contentIndex: 0,
      citationStartIndex: 0,
      citationEndIndex: excerpt.length,
      excerptStartIndex: 0,
      excerptEndIndex: excerpt.length,
      acquiredAt: HOSTED_TEST_ACQUIRED_AT,
      storefront: input.plan.storefront,
      freshnessExpiresAt: HOSTED_TEST_FRESH_UNTIL,
      predicateIds,
      obligationIds: predicateIds,
    })
    : null;
  const result: CandidateQualificationV3 = {
    candidateId: input.candidate.id,
    scope: {
      passed: input.passed,
      failedMembershipPredicateIds: input.passed ? [] : predicateIds,
      fit: input.passed ? 1 : 0,
    },
    hardConstraints: { passed: true, failedConstraintIds: [] },
    evidence: {
      passed: input.passed,
      bindingIds: input.passed ? [`binding-${input.candidate.id}`] : [],
      strength: input.passed ? 0.95 : 0,
      independentProvenanceRoots: input.passed ? 1 : 0,
      bindings: input.passed ? [{
        id: `binding-${input.candidate.id}`,
        url: sourceUrl,
        provenanceRoot: "evidence.example.test",
        strength: 0.95,
        sourceRank: 1,
        kind: "hosted_web_track",
        predicateIds,
        governance: {
          policyVersion: "evidence-source-governance-v3",
          useScope: "run_local",
          approvalState: "approved",
          accessMethod: "hosted_web_search",
          licenseState: "citation_only",
          licenseVersion: "test-v1",
          termsVersion: "test-v1",
          attribution: "Test source",
          cachePolicy: "excerpt_only",
          retentionPolicy: "ninety_days",
          freshnessPolicy: "revalidate_30d",
          acquiredAt: hostedEvidenceSnapshot!.acquiredAt,
          freshnessExpiresAt: hostedEvidenceSnapshot!.freshnessExpiresAt,
          revokedAt: null,
          sourceHash: hostedEvidenceSnapshot!.snapshotHash,
          sourceRevision: hostedEvidenceSnapshot!.snapshotHash,
        },
        hostedEvidenceSnapshot: hostedEvidenceSnapshot!,
        eligibilityAttestation: publicTrackScopeAttestationV3(
          sourceUrl,
          hostedEvidenceSnapshot!,
        ),
      }] : [],
    },
    version: { compatible: input.passed, confidence: input.passed ? 0.95 : 0 },
    catalog: {
      lookupAttempted: input.lookupAttempted,
      appleProviderRequestCount: input.lookupAttempted ? 2 : 0,
      storefrontPlayable: input.passed,
      appleSongId: input.passed ? `apple-${input.candidate.id}` : null,
      recordingFamilyKey: input.passed ? `family-${input.candidate.id}` : null,
      confidence: input.passed ? 0.95 : 0,
    },
    rankingSignals: { relevance: 1 },
    sourceRank: 1,
  };
  return result;
}

describe("Pipeline V3 bounded semantic recovery", () => {
  test("replays retained leads once after a dominant alias-projection failure", async () => {
    const plan = aliasDuplicatePlan();
    let discovered = false;
    let qualifyCalls = 0;
    const claimedRevisions: number[] = [];
    const adapters: RetrievalAdaptersV3 = {
      discover: vi.fn(async () => {
        if (discovered) return { candidates: [], nextCursor: null, exhausted: true };
        discovered = true;
        return { candidates: candidates(), nextCursor: null, exhausted: true };
      }),
      qualify: vi.fn(async (request: QualificationRequestV3) => {
        qualifyCalls += 1;
        return request.candidates.map((candidate) => qualification({
          candidate,
          plan: request.plan,
          passed: qualifyCalls === 2,
          lookupAttempted: qualifyCalls === 2,
        }));
      }),
    };

    const result = await executeRetrievalV3({
      runId: "semantic-recovery",
      plan,
      adapters,
      claimSemanticRecovery: async (revision) => {
        expect(qualifyCalls).toBe(1);
        claimedRevisions.push(revision.revision);
      },
    });
    expect(adapters.discover).toHaveBeenCalled();
    expect(adapters.qualify).toHaveBeenCalledTimes(2);
    expect(claimedRevisions).toEqual([2]);
    expect(result.outcome.status).toBe("exact_ready");
    expect(result.selected).toHaveLength(5);
    expect(result.predicateDiagnostics).toMatchObject({
      qualificationsObserved: 20,
      scopeFailures: 10,
      appleLookupCount: 10,
      appleProviderRequestCount: 20,
      rootCause: "semantic_contract",
      recoveryAttemptCount: 1,
      failedMembershipPredicateIds: { "genre:baile": 10, "genre:carioca": 10 },
    });
    expect(result.semanticPlanRevisions).toHaveLength(1);
    expect(result.semanticPlanRevisions?.[0]?.transformations).toEqual([
      expect.objectContaining({ kind: "alias_projection", removedPredicateId: "genre:carioca" }),
    ]);
    expect(result.recoveryAudits).toEqual([
      expect.objectContaining({
        rootCause: "semantic_contract",
        status: "complete",
        before: expect.objectContaining({ appleLookupCount: 0, appleProviderRequestCount: 0 }),
        after: expect.objectContaining({ appleLookupCount: 10, appleProviderRequestCount: 20, scopeEligible: 10 }),
      }),
    ]);
    expect(result.candidateLeads).toHaveLength(10);
    expect(result.candidateLeads?.every(({ rejectionCode }) => rejectionCode === null)).toBe(true);
  });

  test("does not requalify when the durable semantic-recovery claim is rejected", async () => {
    const plan = aliasDuplicatePlan();
    let discovered = false;
    const adapters: RetrievalAdaptersV3 = {
      discover: async () => {
        if (discovered) return { candidates: [], nextCursor: null, exhausted: true };
        discovered = true;
        return { candidates: candidates(), nextCursor: null, exhausted: true };
      },
      qualify: vi.fn(async (request: QualificationRequestV3) => request.candidates.map((candidate) => qualification({
        candidate,
        plan: request.plan,
        passed: false,
        lookupAttempted: false,
      }))),
    };

    await expect(executeRetrievalV3({
      runId: "semantic-claim-conflict",
      plan,
      adapters,
      claimSemanticRecovery: async () => {
        throw Object.assign(new Error("conflicting recovery"), {
          code: "pipeline_v3_semantic_recovery_conflict",
        });
      },
    })).rejects.toMatchObject({ code: "pipeline_v3_semantic_recovery_conflict" });
    expect(adapters.qualify).toHaveBeenCalledTimes(1);
  });

  test("uses the bounded aggregate sample when no single discovery page reaches the repair threshold", async () => {
    const plan = aliasDuplicatePlan();
    let discoverCalls = 0;
    let qualifyCalls = 0;
    const adapters: RetrievalAdaptersV3 = {
      discover: vi.fn(async () => {
        discoverCalls += 1;
        if (discoverCalls === 1) {
          return { candidates: candidates(5), nextCursor: null, exhausted: true };
        }
        if (discoverCalls === 2) {
          return {
            candidates: candidates(10).slice(5),
            nextCursor: null,
            exhausted: true,
          };
        }
        return { candidates: [], nextCursor: null, exhausted: true };
      }),
      qualify: vi.fn(async (request: QualificationRequestV3) => {
        qualifyCalls += 1;
        return request.candidates.map((candidate) => qualification({
          candidate,
          plan: request.plan,
          passed: qualifyCalls === 3,
          lookupAttempted: qualifyCalls === 3,
        }));
      }),
    };

    const result = await executeRetrievalV3({ runId: "semantic-aggregate-sample", plan, adapters });

    expect(adapters.qualify).toHaveBeenCalledTimes(3);
    expect(result.outcome.status).toBe("exact_ready");
    expect(result.semanticPlanRevisions).toHaveLength(1);
    expect(result.recoveryAudits?.[0]).toMatchObject({
      status: "complete",
      beforeFailedMembershipPredicateIds: {
        "genre:baile": 10,
        "genre:carioca": 10,
      },
    });
  });

  test("never performs a second repair when the semantic-equivalent replay has no yield", async () => {
    const plan = aliasDuplicatePlan();
    let discovered = false;
    const adapters: RetrievalAdaptersV3 = {
      discover: async () => {
        if (discovered) return { candidates: [], nextCursor: null, exhausted: true };
        discovered = true;
        return { candidates: candidates(), nextCursor: null, exhausted: true };
      },
      qualify: vi.fn(async (request: QualificationRequestV3) => request.candidates.map((candidate) => qualification({
        candidate,
        plan: request.plan,
        passed: false,
        lookupAttempted: false,
      }))),
    };

    const result = await executeRetrievalV3({ runId: "semantic-no-yield", plan, adapters });
    expect(adapters.qualify).toHaveBeenCalledTimes(2);
    expect(result.predicateDiagnostics?.recoveryAttemptCount).toBe(1);
    expect(result.recoveryAudits?.[0]?.status).toBe("no_yield");
  });

  test("does not invoke semantic repair when qualification is provider-degraded", async () => {
    const plan = aliasDuplicatePlan();
    let discovered = false;
    const adapters: RetrievalAdaptersV3 = {
      discover: async () => {
        if (discovered) return { candidates: [], nextCursor: null, exhausted: true };
        discovered = true;
        return { candidates: candidates(), nextCursor: null, exhausted: true };
      },
      qualify: vi.fn(async () => {
        throw new RetrievalDependencyErrorV3(
          "Apple unavailable",
          ["apple_catalog"],
        );
      }),
    };
    const result = await executeRetrievalV3({ runId: "provider-outage", plan, adapters });
    expect(adapters.qualify).toHaveBeenCalledTimes(1);
    expect(result.predicateDiagnostics?.recoveryAttemptCount).toBe(0);
    expect(result.semanticPlanRevisions).toEqual([]);
    expect(result.predicateDiagnostics?.rootCause).toBe("provider_degraded");
  });

  test("does not remove a standalone explicit geography predicate", () => {
    const base = basePlan("25 French jazz tracks");
    const genre: MembershipPredicateV3 = {
      id: "genre:jazz",
      axis: "genre",
      operator: "require",
      values: ["jazz"],
      source: "user",
      reason: "Explicit genre",
    };
    const geography: MembershipPredicateV3 = {
      id: "geography:france",
      axis: "geography",
      operator: "require",
      values: ["France"],
      source: "user",
      reason: "Explicit artist origin",
    };
    expect(buildSemanticEquivalentRecoveryPlanV3({
      ...base,
      membershipPredicates: [genre, geography],
    })).toBeNull();
  });

  test("does not equate ambiguous Brazilian funk with funk carioca", () => {
    const base = basePlan("25 Brazilian funk tracks", 25);
    const genre = base.membershipPredicates.find(({ axis }) => axis === "genre")!;
    expect(buildSemanticEquivalentRecoveryPlanV3({
      ...base,
      membershipPredicates: [
        { ...genre, id: "genre:brazilian", values: ["Brazilian funk"] },
        { ...genre, id: "genre:carioca", values: ["funk carioca"] },
      ],
    })).toBeNull();
  });

  test("projects audience-market geography out of evidence membership", () => {
    const base = basePlan("disco for a party in Brazil", 25);
    const geography: MembershipPredicateV3 = {
      id: "legacy:audience:brazil",
      axis: "geography",
      operator: "require",
      values: ["Brazil"],
      source: "user",
      geographyRelationship: "unspecified",
      reason: "Legacy compatibility projection",
    };
    const context = {
      id: "context:audience:brazil",
      role: "context" as const,
      axis: "geography" as const,
      operator: "prefer" as const,
      values: ["Brazil"],
      source: "raw_prompt" as const,
      explicitUserAuthored: true,
      geographyRelationship: "unspecified" as const,
      reason: "Brazil is the intended listening market.",
    };
    const revision = buildSemanticEquivalentRecoveryPlanV3({
      ...base,
      membershipPredicates: [geography],
      semanticClauses: [...base.semanticClauses, context],
      contextSignals: [...base.contextSignals, context],
    });
    expect(revision?.transformations).toEqual([
      expect.objectContaining({
        kind: "context_geography_projection",
        removedPredicateId: geography.id,
      }),
    ]);
    expect(revision?.plan.membershipPredicates).toEqual([]);
  });

  test("projects generated policy prose to catalog policy without changing recording policy", () => {
    const base = basePlan("25 disco tracks", 25);
    const generated: MembershipPredicateV3 = {
      id: "v2:generated_version_policy",
      axis: "recording_version",
      operator: "require",
      values: ["canonical studio recording"],
      source: "user",
      reason: "Generated compatibility prose",
    };
    const policy = {
      id: "catalog:canonical",
      role: "catalog_policy" as const,
      axis: "recording_version" as const,
      operator: "prefer" as const,
      values: ["canonical studio recording"],
      source: "system_default" as const,
      explicitUserAuthored: false,
      geographyRelationship: null,
      reason: "Prefer canonical studio recordings.",
    };
    const revision = buildSemanticEquivalentRecoveryPlanV3({
      ...base,
      membershipPredicates: [generated],
      semanticClauses: [...base.semanticClauses, policy],
      catalogPolicies: [...base.catalogPolicies, policy],
    });
    expect(revision?.transformations).toEqual([
      expect.objectContaining({ kind: "generated_policy_projection", removedPredicateId: generated.id }),
    ]);
    expect(revision?.plan.recordingPolicy).toEqual(base.recordingPolicy);
  });

  test("projects geography only when an explicit scene already encodes it", () => {
    const base = basePlan("25 Berlin techno tracks");
    const scene: MembershipPredicateV3 = {
      id: "scene:berlin",
      axis: "scene",
      operator: "require",
      values: ["Berlin techno"],
      source: "user",
      reason: "Explicit Berlin techno scene",
    };
    const geography: MembershipPredicateV3 = {
      id: "geography:berlin",
      axis: "geography",
      operator: "require",
      values: ["Berlin"],
      source: "guided_answer",
      reason: "Scene context",
    };
    const revision = buildSemanticEquivalentRecoveryPlanV3({
      ...base,
      membershipPredicates: [scene, geography],
    });
    expect(revision?.transformations).toEqual([
      expect.objectContaining({
        kind: "context_geography_projection",
        removedPredicateId: "geography:berlin",
        retainedPredicateId: "scene:berlin",
      }),
    ]);
    expect(revision?.plan.prompt).toBe(base.prompt);
    expect(revision?.plan.requestedTrackCount).toBe(base.requestedTrackCount);
    expect(revision?.plan.hardConstraints).toEqual(base.hardConstraints);
  });

  test("requires both the minimum sample and dominant failing predicate", () => {
    const plan = aliasDuplicatePlan();
    expect(semanticRecoveryMinimumSampleV3(5)).toBe(10);
    expect(semanticRecoveryMinimumSampleV3(15)).toBe(15);
    expect(semanticRecoveryMinimumSampleV3(300)).toBe(20);
    const small = candidates(9).map((candidate) => qualification({
      candidate, plan, passed: false, lookupAttempted: false,
    }));
    expect(proposeSemanticRecoveryV3({
      plan, qualifications: small, providerDegraded: false, priorAttemptCount: 0,
    })).toBeNull();
    expect(proposeSemanticRecoveryV3({
      plan,
      qualifications: candidates(10).map((candidate) => qualification({
        candidate, plan, passed: false, lookupAttempted: false,
      })),
      providerDegraded: true,
      priorAttemptCount: 0,
    })).toBeNull();
  });
});
