import { describe, expect, test, vi } from "vitest";
import {
  canonicalRequiredEvidenceIntegrityV3,
  centralQualityVerdictV3,
  createCentralQualityCriterionObservationV3,
  createHostedWebEvidenceSnapshotV3,
  executeRetrievalV3,
  publicTrackScopeAttestationV3,
  RetrievalPlaylistOptimizationBudgetExceededErrorV3,
  RetrievalDependencyErrorV3,
  retrievalStrategiesForEnginesV3,
  routeRetrievalEnginesV3,
  validateCanonicalPublicationSetV3,
  type CandidateQualificationV3,
  type QualifiedTrackV3,
  type RawTrackCandidateV3,
  type RetrievalAdaptersV3,
} from "../server/pipeline-v3-retrieval.ts";
import {
  createRunSpecV3,
  evidenceMembershipPredicateIdsV3,
  resolveRunSpecV3,
  type IntentV3,
  type SelectionPlanV3,
} from "../server/selection-plan-v3.ts";
import {
  canonicalContractExecutionPolicyV1,
  evaluateCanonicalContractTrackV1,
} from "../server/canonical-contract-runtime-v1.ts";
import {
  compilePlaylistContractRevisionV1,
  type PlaylistContractDraftV1,
  type PlaylistPredicateV1,
} from "../server/playlist-contract-v1.ts";
import { playlistCandidateGoalV1 } from "../server/playlist-feasibility-v1.ts";
import {
  playlistOptimizationBudgetForPassV1,
  withPlaylistOptimizationBudgetV1,
} from "../server/playlist-optimizer-v1.ts";

const HOSTED_TEST_ACQUIRED_AT = new Date(Date.now() - 60_000).toISOString();
const HOSTED_TEST_FRESH_UNTIL = new Date(
  Date.parse(HOSTED_TEST_ACQUIRED_AT) + 29 * 24 * 60 * 60_000,
).toISOString();

function plan(prompt: string, target = 25): SelectionPlanV3 {
  return resolveRunSpecV3(createRunSpecV3({
    prompt,
    requestedTrackCount: target,
    storefront: "US",
  }), []);
}

// Evidence bindings are keyed to the immutable predicate ids emitted by the
// semantic compiler. Keep the test adapter on that same contract instead of
// pinning the pre-scope-gate disco id: a continuation deliberately rejects a
// seed whose evidence attests a different plan revision.
const DISCO_MEMBERSHIP_PREDICATE_IDS = evidenceMembershipPredicateIdsV3(
  plan("one disco track", 1),
);

function canonicalDiscoPlan(
  target: number,
  patch: Partial<SelectionPlanV3> = {},
): SelectionPlanV3 {
  const contract = compilePlaylistContractRevisionV1({
    contractId: `contract:optimizer:${target}`,
    rawPrompt: `${target} disco tracks`,
    requestedTrackCount: target,
    locale: "en-US",
    storefront: "us",
    clauses: [{
      id: "genre:disco",
      kind: "membership",
      scope: "track",
      hardness: "hard",
      axis: "genre",
      operator: "require",
      values: ["disco"],
      source: { provenance: "prompt", text: "disco" },
    }],
    trackPredicate: { op: "clause", clauseId: "genre:disco" },
  });
  return {
    ...plan(`${target} disco tracks`, target),
    canonicalContractPolicy: canonicalContractExecutionPolicyV1(contract),
    diversityGoals: {
      minimumDistinctArtists: null,
      minimumDistinctAlbums: null,
      minimumDistinctEras: null,
      minimumDistinctScenes: null,
      minimumDistinctGeographies: null,
      maximumTracksPerArtist: null,
      maximumTracksPerAlbum: null,
    },
    softGoalRelaxationOrder: [],
    ...patch,
  };
}

function planWithIntents(intents: readonly IntentV3[], target = 25): SelectionPlanV3 {
  const base = plan("music for a test playlist", target);
  return {
    ...base,
    intents,
    confirmed: true,
  };
}

function candidate(index: number, patch: Partial<RawTrackCandidateV3> = {}): RawTrackCandidateV3 {
  return {
    id: `candidate-${index}`,
    title: `Track ${index}`,
    artist: `Artist ${index % 12}`,
    album: `Album ${index % 7}`,
    sourceObservationIds: [`source-${index}`],
    ...patch,
  };
}

function qualification(
  value: RawTrackCandidateV3,
  patch: Partial<CandidateQualificationV3> = {},
): CandidateQualificationV3 {
  const bindingId = `binding-${value.id}`;
  const provenanceRoot = `${encodeURIComponent(value.id)}.evidence.example.test`;
  const sourceUrl = `https://${provenanceRoot}/tracks/${encodeURIComponent(value.id)}`;
  return {
    candidateId: value.id,
    scope: { passed: true, failedMembershipPredicateIds: [], fit: 0.9 },
    hardConstraints: { passed: true, failedConstraintIds: [] },
    evidence: {
      passed: true,
      bindingIds: [bindingId],
      strength: 0.9,
      independentProvenanceRoots: 2,
      bindings: [{
        id: bindingId,
        url: sourceUrl,
        provenanceRoot,
        strength: 0.9,
        sourceRank: 1,
        kind: "hosted_web_track",
        predicateIds: DISCO_MEMBERSHIP_PREDICATE_IDS,
        governance: {
          policyVersion: "evidence-source-governance-v3",
          useScope: "run_local",
          approvalState: "approved",
          accessMethod: "hosted_web_search",
          licenseState: "citation_only",
          licenseVersion: "test-citation-v1",
          termsVersion: "test-terms-v1",
          attribution: "Test exact track source",
          cachePolicy: "excerpt_only",
          retentionPolicy: "ninety_days",
          freshnessPolicy: "revalidate_30d",
          sourceHash: "a".repeat(64),
          sourceRevision: "a".repeat(64),
        },
        eligibilityAttestation: publicTrackScopeAttestationV3(sourceUrl),
      }],
    },
    version: { compatible: true, confidence: 0.95 },
    catalog: {
      storefrontPlayable: true,
      appleSongId: `apple-${value.id}`,
      recordingFamilyKey: `family-${value.id}`,
      confidence: 0.98,
    },
    rankingSignals: { relevance: 0.8, influence: 0.5 },
    sourceRank: 10,
    ...patch,
  };
}

function centralQualityObservations(
  value: RawTrackCandidateV3,
  policy: NonNullable<SelectionPlanV3["playlistQualityPolicy"]>,
  verdict: "pass" | "fail" | "unknown",
  sourceId = `quality:${value.id}`,
  catalogIdentity = {
    appleSongId: `apple-${value.id}`,
    recordingFamilyKey: `family-${value.id}`,
  },
) {
  return policy.criteria.map((criterion) => (
    createCentralQualityCriterionObservationV3({
      policy,
      criterion,
      verdict,
      sourceKind: "hosted_web_response",
      sourceId,
      artist: value.artist,
      title: value.title,
      album: value.album,
      catalogIdentity,
    })
  ));
}

function withHostedCanonicalEvidence(
  value: RawTrackCandidateV3,
  qualificationResult: CandidateQualificationV3,
  predicateIds: readonly string[],
): CandidateQualificationV3 {
  const evidenceBinding = qualificationResult.evidence.bindings?.[0];
  if (!evidenceBinding?.url) return qualificationResult;
  const excerpt = `${value.artist} — ${value.title}: source evidence for ${predicateIds.join(", ")}.`;
  const hostedEvidenceSnapshot = createHostedWebEvidenceSnapshotV3({
    sourceUrl: evidenceBinding.url,
    excerpt,
    responseId: `test-response-${value.id}`,
    outputItemId: `test-output-${value.id}`,
    contentIndex: 0,
    citationStartIndex: 0,
    citationEndIndex: excerpt.length,
    excerptStartIndex: 0,
    excerptEndIndex: excerpt.length,
    acquiredAt: HOSTED_TEST_ACQUIRED_AT,
    storefront: "us",
    freshnessExpiresAt: HOSTED_TEST_FRESH_UNTIL,
    predicateIds,
    obligationIds: predicateIds,
  });
  return {
    ...qualificationResult,
    evidence: {
      ...qualificationResult.evidence,
      bindings: [{
        ...evidenceBinding,
        predicateIds,
        governance: {
          ...evidenceBinding.governance,
          acquiredAt: hostedEvidenceSnapshot.acquiredAt,
          freshnessExpiresAt: hostedEvidenceSnapshot.freshnessExpiresAt,
          revokedAt: null,
          sourceHash: hostedEvidenceSnapshot.snapshotHash,
          sourceRevision: hostedEvidenceSnapshot.snapshotHash,
        },
        hostedEvidenceSnapshot,
        eligibilityAttestation: publicTrackScopeAttestationV3(
          evidenceBinding.url,
          hostedEvidenceSnapshot,
        ),
      }],
    },
  };
}

function negativeProofClause(
  id: string,
  kind: "membership" | "exclusion",
): PlaylistContractDraftV1["clauses"][number] {
  return {
    id,
    kind,
    scope: "track",
    hardness: "hard",
    axis: kind === "exclusion" ? "artist" : "membership",
    operator: kind === "exclusion" ? "exclude" : "require",
    values: [id],
    source: { provenance: "prompt", text: id },
  };
}

const REDUNDANT_NEGATIVE_PROOF_CASES: readonly {
  name: string;
  clauses: PlaylistContractDraftV1["clauses"];
  trackPredicate: PlaylistPredicateV1;
  negativeClauseIds: readonly string[];
  positiveClauseIds: readonly string[];
  proofClauseIds: readonly string[];
}[] = [
  {
    name: "OR exclusions",
    clauses: [
      negativeProofClause("exclude:artist-a", "exclusion"),
      negativeProofClause("exclude:artist-b", "exclusion"),
    ],
    trackPredicate: {
      op: "any",
      children: [
        { op: "clause", clauseId: "exclude:artist-a" },
        { op: "clause", clauseId: "exclude:artist-b" },
      ],
    },
    negativeClauseIds: ["exclude:artist-a", "exclude:artist-b"],
    positiveClauseIds: [],
    proofClauseIds: ["exclude:artist-a"],
  },
  {
    name: "ALL exclusions",
    clauses: [
      negativeProofClause("exclude:all-a", "exclusion"),
      negativeProofClause("exclude:all-b", "exclusion"),
    ],
    trackPredicate: {
      op: "all",
      children: [
        { op: "clause", clauseId: "exclude:all-a" },
        { op: "clause", clauseId: "exclude:all-b" },
      ],
    },
    negativeClauseIds: ["exclude:all-a", "exclude:all-b"],
    positiveClauseIds: [],
    proofClauseIds: ["exclude:all-a", "exclude:all-b"],
  },
  {
    name: "explicit alternatives",
    clauses: [
      negativeProofClause("exclude:alternative-a", "exclusion"),
      negativeProofClause("exclude:alternative-b", "exclusion"),
    ],
    trackPredicate: {
      op: "alternative",
      choices: [
        {
          id: "alternative-a",
          priority: 1,
          predicate: {
            op: "clause",
            clauseId: "exclude:alternative-a",
          },
        },
        {
          id: "alternative-b",
          priority: 2,
          predicate: {
            op: "clause",
            clauseId: "exclude:alternative-b",
          },
        },
      ],
    },
    negativeClauseIds: [
      "exclude:alternative-a",
      "exclude:alternative-b",
    ],
    positiveClauseIds: [],
    proofClauseIds: ["exclude:alternative-a"],
  },
  {
    name: "nested NOT",
    clauses: [
      negativeProofClause("membership:not-a", "membership"),
      negativeProofClause("membership:not-b", "membership"),
    ],
    trackPredicate: {
      op: "any",
      children: [
        {
          op: "not",
          child: {
            op: "not",
            child: {
              op: "not",
              child: { op: "clause", clauseId: "membership:not-a" },
            },
          },
        },
        {
          op: "not",
          child: {
            op: "not",
            child: {
              op: "not",
              child: { op: "clause", clauseId: "membership:not-b" },
            },
          },
        },
      ],
    },
    negativeClauseIds: ["membership:not-a", "membership:not-b"],
    positiveClauseIds: [],
    proofClauseIds: ["membership:not-a"],
  },
  {
    name: "EXCEPT with redundant negative witnesses",
    clauses: [
      negativeProofClause("membership:base", "membership"),
      negativeProofClause("membership:exception-a", "membership"),
      negativeProofClause("membership:exception-b", "membership"),
    ],
    trackPredicate: {
      op: "except",
      base: { op: "clause", clauseId: "membership:base" },
      exceptions: [{
        op: "all",
        children: [
          { op: "clause", clauseId: "membership:exception-a" },
          { op: "clause", clauseId: "membership:exception-b" },
        ],
      }],
    },
    negativeClauseIds: [
      "membership:exception-a",
      "membership:exception-b",
    ],
    positiveClauseIds: ["membership:base"],
    proofClauseIds: ["membership:exception-a"],
  },
];

function canonicalDiscoQualification(
  value: RawTrackCandidateV3,
  patch: Partial<CandidateQualificationV3> = {},
): CandidateQualificationV3 {
  const base = withHostedCanonicalEvidence(
    value,
    qualification(value, patch),
    ["genre:disco"],
  );
  const bindingId = base.evidence.bindingIds[0]!;
  return {
    ...base,
    canonicalClauseAssessments: {
      "genre:disco": {
        status: "pass",
        evidenceGrade: "track_specific_editorial_assertion",
        evidenceIds: [bindingId],
      },
    },
  };
}

function allQualifiedAdapter(batchSize = 20): RetrievalAdaptersV3 {
  let next = 0;
  return {
    discover: vi.fn(async ({ requestedRawCandidateCount }) => {
      const count = Math.min(batchSize, requestedRawCandidateCount);
      const candidates = Array.from({ length: count }, () => candidate(next++));
      return { candidates, nextCursor: null, exhausted: true };
    }),
    qualify: vi.fn(async (
      { candidates }: Parameters<RetrievalAdaptersV3["qualify"]>[0],
    ) => candidates.map((value) => qualification(value))),
  };
}

describe("Pipeline V3 intent-specific retrieval orchestration", () => {
  test("routes every intent to its dedicated engine without converting ranking into membership", () => {
    expect(routeRetrievalEnginesV3(planWithIntents(["genre_scene", "editorial_ranking"]))).toEqual([
      "curated_genre_scene",
    ]);
    expect(routeRetrievalEnginesV3(planWithIntents(["mood_activity", "theme"]))).toEqual([
      "mood_activity_theme",
    ]);
    expect(routeRetrievalEnginesV3(planWithIntents(["similarity"]))).toEqual(["similarity"]);
    expect(routeRetrievalEnginesV3(planWithIntents(["artist_catalogue"]))).toEqual(["artist_catalogue"]);
    expect(routeRetrievalEnginesV3(planWithIntents(["factual_relationship"]))).toEqual([
      "factual_relationship",
    ]);
    expect(routeRetrievalEnginesV3(planWithIntents(["exhaustive"]))).toEqual(["exhaustive"]);
    expect(routeRetrievalEnginesV3(planWithIntents(["genre_scene"], 25), {
      fixedContainer: true,
    })).toEqual(["fixed_container", "curated_genre_scene"]);

    const strategies = retrievalStrategiesForEnginesV3([
      "curated_genre_scene", "factual_relationship", "exhaustive",
    ]);
    expect(strategies.some(({ kind }) => kind === "trusted_containers")).toBe(true);
    expect(strategies
      .filter(({ kind }) => kind === "trusted_containers")
      .every(({ maximumRounds }) => maximumRounds === 12)).toBe(true);
    expect(strategies.some(({ kind }) => kind === "graph_traversal")).toBe(true);
    expect(strategies.filter(({ kind }) => kind === "gap_pass")).toHaveLength(2);
    expect(strategies.every(({ zeroQualifiedYieldLimit }) => zeroQualifiedYieldLimit === 2)).toBe(true);
  });

  test("blocks unresolved critical membership ambiguity before any adapter call", async () => {
    const ambiguous = createRunSpecV3({
      prompt: "Make me a house playlist",
      requestedTrackCount: 25,
    });
    const unresolved: SelectionPlanV3 = {
      ...ambiguous,
      confirmed: false,
      resolvedAmbiguityKeys: [],
    };
    const adapters = allQualifiedAdapter();
    const result = await executeRetrievalV3({
      runId: "ambiguous-run",
      plan: unresolved,
      adapters,
    });

    expect(result.outcome).toMatchObject({
      status: "awaiting_guidance",
      stopReason: "awaiting_guidance",
      selectedTrackCount: 0,
    });
    expect(result.publicationBoundary).toEqual({
      appleWriteAccess: "forbidden",
      manifestDisposition: "blocked_awaiting_guidance",
    });
    expect(adapters.discover).not.toHaveBeenCalled();
    expect(adapters.qualify).not.toHaveBeenCalled();
  });

  test("uses the canonical Boolean/evidence/unknown policy instead of flattened scope booleans", async () => {
    const contract = compilePlaylistContractRevisionV1({
      contractId: "contract:retrieval-authority",
      rawPrompt: "One reggaeton or dembow track, no Bad Bunny.",
      requestedTrackCount: 1,
      locale: "en-US",
      storefront: "us",
      clauses: [
        {
          id: "genre:reggaeton",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "genre",
          operator: "require",
          values: ["reggaeton"],
          source: { provenance: "prompt", text: "reggaeton" },
        },
        {
          id: "genre:dembow",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "genre",
          operator: "require",
          values: ["dembow"],
          source: { provenance: "prompt", text: "dembow" },
        },
        {
          id: "exclude:bad-bunny",
          kind: "exclusion",
          scope: "track",
          hardness: "hard",
          axis: "artist",
          operator: "exclude",
          values: ["Bad Bunny"],
          source: { provenance: "prompt", text: "no Bad Bunny" },
        },
      ],
      trackPredicate: {
        op: "all",
        children: [
          {
            op: "any",
            children: [
              { op: "clause", clauseId: "genre:reggaeton" },
              { op: "clause", clauseId: "genre:dembow" },
            ],
          },
          { op: "clause", clauseId: "exclude:bad-bunny" },
        ],
      },
      qualityPolicy: {
        centralSuitabilityClauseIds: [],
        minimumPassRatio: 0.8,
        maximumUnknownRatio: 0.2,
        zeroKnownFailures: true,
      },
    });
    const candidates = [
      candidate(1, { artist: "Ivy Queen" }),
      candidate(2, { artist: "Unknown Artist" }),
      candidate(3, { artist: "Bad Bunny" }),
    ];
    let delivered = false;
    const adapters: RetrievalAdaptersV3 = {
      discover: vi.fn(async () => {
        if (delivered) return { candidates: [], nextCursor: null, exhausted: true };
        delivered = true;
        return { candidates, nextCursor: null, exhausted: true };
      }),
      qualify: vi.fn(async (
        { candidates: values }: Parameters<RetrievalAdaptersV3["qualify"]>[0],
      ) => values.map((value: RawTrackCandidateV3, index: number): CandidateQualificationV3 => {
        const base = withHostedCanonicalEvidence(
          value,
          qualification(value, {
            // Deliberately contradictory legacy booleans: contract3 must ignore
            // these flattened values and execute its Boolean tree below.
            scope: {
              passed: false,
              failedMembershipPredicateIds: ["legacy:flattened"],
              fit: 0,
            },
            version: {
              compatible: false,
              confidence: 0,
            },
          }),
          ["genre:reggaeton", "exclude:bad-bunny"],
        );
        const bindingId = base.evidence.bindingIds[0]!;
        return {
          ...base,
          canonicalClauseAssessments: index === 0
            ? {
                "genre:reggaeton": {
                  status: "pass",
                  evidenceGrade: "track_specific_editorial_assertion",
                  evidenceIds: [bindingId],
                },
                "genre:dembow": { status: "unknown" },
                "exclude:bad-bunny": {
                  status: "fail",
                  evidenceGrade: "track_specific_editorial_assertion",
                  evidenceIds: [bindingId],
                },
              }
            : index === 1
              ? {
                  "genre:reggaeton": { status: "unknown" },
                  "genre:dembow": { status: "unknown" },
                  "exclude:bad-bunny": {
                    status: "fail",
                    evidenceGrade: "track_specific_editorial_assertion",
                    evidenceIds: [bindingId],
                  },
                }
              : {
                  "genre:reggaeton": {
                    status: "pass",
                    evidenceGrade: "track_specific_editorial_assertion",
                    evidenceIds: [bindingId],
                  },
                  "genre:dembow": { status: "unknown" },
                  "exclude:bad-bunny": {
                    status: "pass",
                    evidenceGrade: "track_specific_editorial_assertion",
                    evidenceIds: [bindingId],
                  },
                },
        };
      })),
    };
    const canonicalPlan: SelectionPlanV3 = {
      ...plan("legacy prompt that must not control execution", 1),
      canonicalContractPolicy: canonicalContractExecutionPolicyV1(contract),
    };
    const result = await executeRetrievalV3({
      runId: "canonical-runtime-gate",
      plan: canonicalPlan,
      adapters,
    });

    expect(result.selected.map(({ candidateId }) => candidateId)).toEqual(["candidate-1"]);
    expect(result.deficit.discardedByReason).toMatchObject({
      canonical_contract_unknown: 1,
      canonical_contract_failed: 1,
    });
    expect(validateCanonicalPublicationSetV3({
      plan: canonicalPlan,
      tracks: result.selected,
    })).toEqual({ valid: true, reasonCodes: [] });
    expect(validateCanonicalPublicationSetV3({
      plan: canonicalPlan,
      tracks: [{
        ...result.selected[0]!,
        canonicalClauseAssessments: {
          ...result.selected[0]!.canonicalClauseAssessments,
          "genre:reggaeton": { status: "unknown" },
        },
      }],
    })).toMatchObject({
      valid: false,
      reasonCodes: expect.arrayContaining(["canonical_track_unknown"]),
    });
  });

  test("requires obligation-bound proof when a negative fact makes an exclusion eligible", () => {
    const contract = compilePlaylistContractRevisionV1({
      contractId: "contract:negative-proof",
      rawPrompt: "One reggaeton track, but not Bad Bunny",
      requestedTrackCount: 1,
      locale: "en-US",
      storefront: "us",
      clauses: [
        {
          id: "genre:reggaeton",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "genre",
          operator: "require",
          values: ["reggaeton"],
          source: { provenance: "prompt", text: "reggaeton" },
        },
        {
          id: "exclude:bad-bunny",
          kind: "exclusion",
          scope: "track",
          hardness: "hard",
          axis: "artist",
          operator: "exclude",
          values: ["Bad Bunny"],
          source: { provenance: "prompt", text: "not Bad Bunny" },
        },
      ],
      trackPredicate: {
        op: "all",
        children: [
          { op: "clause", clauseId: "genre:reggaeton" },
          { op: "clause", clauseId: "exclude:bad-bunny" },
        ],
      },
    });
    const policy = canonicalContractExecutionPolicyV1(contract);
    const value = candidate(99, { artist: "Ivy Queen" });
    const proven = withHostedCanonicalEvidence(
      value,
      qualification(value),
      ["genre:reggaeton", "exclude:bad-bunny"],
    );
    const bindingId = proven.evidence.bindingIds[0]!;
    const assessments = {
      "genre:reggaeton": {
        status: "pass" as const,
        evidenceGrade: "track_specific_editorial_assertion" as const,
        evidenceIds: [bindingId],
      },
      "exclude:bad-bunny": {
        status: "fail" as const,
        evidenceGrade: "track_specific_editorial_assertion" as const,
      },
    };

    expect(canonicalRequiredEvidenceIntegrityV3({
      policy,
      assessments,
      bindingIds: proven.evidence.bindingIds,
      bindings: proven.evidence.bindings,
      storefront: "us",
    })).toMatchObject({
      passed: false,
      missingRequiredClauseIds: ["exclude:bad-bunny"],
    });
    expect(canonicalRequiredEvidenceIntegrityV3({
      policy,
      assessments: {
        ...assessments,
        "exclude:bad-bunny": {
          ...assessments["exclude:bad-bunny"],
          evidenceIds: [bindingId],
        },
      },
      bindingIds: proven.evidence.bindingIds,
      bindings: proven.evidence.bindings,
      storefront: "us",
    })).toMatchObject({
      passed: true,
      missingRequiredClauseIds: [],
      obligationMismatchClauseIds: [],
    });
  });

  test("rejects an attested low-entailment binding whose assessment claims primary-source proof", () => {
    const clauseId = "relationship:claimed-primary";
    const contract = compilePlaylistContractRevisionV1({
      contractId: "contract:claimed-primary-grade-laundering",
      rawPrompt: "A track with a documented factual relationship",
      requestedTrackCount: 1,
      locale: "en-US",
      storefront: "us",
      clauses: [{
        id: clauseId,
        kind: "factual_relationship",
        scope: "track",
        hardness: "hard",
        axis: "relationship",
        operator: "require",
        values: ["documented relationship"],
        source: {
          provenance: "prompt",
          text: "documented factual relationship",
        },
        evidence: {
          required: true,
          minimumGrade: null,
          permittedGrades: [
            "primary_source",
            "independent_secondary_source",
          ],
        },
      }],
      trackPredicate: { op: "clause", clauseId },
    });
    const value = candidate(109);
    const proven = withHostedCanonicalEvidence(
      value,
      qualification(value),
      [clauseId],
    );
    const binding = proven.evidence.bindings?.[0];
    expect(binding).toBeDefined();
    const integrity = canonicalRequiredEvidenceIntegrityV3({
      policy: canonicalContractExecutionPolicyV1(contract),
      assessments: {
        [clauseId]: {
          status: "pass",
          evidenceGrade: "primary_source",
          evidenceIds: [binding!.id],
        },
      },
      bindingIds: proven.evidence.bindingIds,
      bindings: [{
        ...binding!,
        // This legacy kind is intentionally not mapped to a selection-grade
        // entailment, regardless of the grade asserted by the assessment.
        kind: "track_specific_source",
      }],
      storefront: "us",
    });

    expect(integrity).toMatchObject({
      passed: false,
      missingRequiredClauseIds: [],
      unattestedEvidenceIds: [],
      obligationMismatchClauseIds: [],
      evidenceGradeMismatchClauseIds: [clauseId],
    });
  });

  test("treats the evidence-policy clause as a meta-policy without requiring a duplicate obligation id", () => {
    const membershipClauseId = "genre:reggaeton";
    const evidenceClauseId = "bridge:evidence:qualification-policy";
    const contract = compilePlaylistContractRevisionV1({
      contractId: "contract:evidence-meta-policy",
      rawPrompt: "One verified reggaeton track",
      requestedTrackCount: 1,
      locale: "en-US",
      storefront: "us",
      clauses: [
        {
          id: membershipClauseId,
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "genre",
          operator: "require",
          values: ["reggaeton"],
          source: { provenance: "prompt", text: "reggaeton" },
        },
        {
          id: evidenceClauseId,
          kind: "factual_relationship",
          scope: "track",
          hardness: "hard",
          axis: "evidence",
          operator: "require",
          values: ["selection-grade evidence"],
          source: {
            provenance: "system_default",
            text: "Require selection-grade evidence.",
          },
          evidence: {
            required: true,
            minimumGrade: null,
            permittedGrades: ["track_specific_editorial_assertion"],
          },
        },
      ],
      trackPredicate: {
        op: "all",
        children: [
          { op: "clause", clauseId: membershipClauseId },
          { op: "clause", clauseId: evidenceClauseId },
        ],
      },
    });
    const value = candidate(111);
    const proven = withHostedCanonicalEvidence(
      value,
      qualification(value),
      [membershipClauseId],
    );
    const bindingId = proven.evidence.bindingIds[0]!;

    expect(canonicalRequiredEvidenceIntegrityV3({
      policy: canonicalContractExecutionPolicyV1(contract),
      assessments: {
        [membershipClauseId]: {
          status: "pass",
          evidenceGrade: "track_specific_editorial_assertion",
          evidenceIds: [bindingId],
        },
        [evidenceClauseId]: {
          status: "pass",
          evidenceGrade: "track_specific_editorial_assertion",
          evidenceIds: [bindingId],
        },
      },
      bindingIds: proven.evidence.bindingIds,
      bindings: proven.evidence.bindings,
      storefront: "us",
    })).toMatchObject({
      passed: true,
      missingRequiredClauseIds: [],
      unattestedEvidenceIds: [],
      obligationMismatchClauseIds: [],
      evidenceGradeMismatchClauseIds: [],
    });
  });

  test("does not upgrade an unknown binding kind merely because it arrived through a structured adapter", () => {
    const clauseId = "membership:structured-transport-is-not-entailment";
    const contract = compilePlaylistContractRevisionV1({
      contractId: "contract:structured-transport-grade-laundering",
      rawPrompt: "A verified genre member",
      requestedTrackCount: 1,
      locale: "en-US",
      storefront: "us",
      clauses: [negativeProofClause(clauseId, "membership")],
      trackPredicate: { op: "clause", clauseId },
    });
    const value = candidate(110);
    const proven = withHostedCanonicalEvidence(
      value,
      qualification(value),
      [clauseId],
    );
    const binding = proven.evidence.bindings?.[0];
    expect(binding?.url).toBeTruthy();
    const {
      hostedEvidenceSnapshot: ignoredHostedSnapshot,
      ...unhostedBinding
    } = binding!;
    void ignoredHostedSnapshot;
    const integrity = canonicalRequiredEvidenceIntegrityV3({
      policy: canonicalContractExecutionPolicyV1(contract),
      assessments: {
        [clauseId]: {
          status: "pass",
          evidenceGrade: "authoritative_structured_metadata",
          evidenceIds: [binding!.id],
        },
      },
      bindingIds: proven.evidence.bindingIds,
      bindings: [{
        ...unhostedBinding,
        kind: "track_specific_source",
        governance: {
          ...binding!.governance,
          accessMethod: "structured_adapter",
        },
        eligibilityAttestation: publicTrackScopeAttestationV3(binding!.url!),
      }],
      storefront: "us",
    });

    expect(integrity).toMatchObject({
      passed: false,
      unattestedEvidenceIds: [],
      obligationMismatchClauseIds: [],
      evidenceGradeMismatchClauseIds: [clauseId],
    });
  });

  test("accepts only the deterministic binding-derived grade and preserves the bounded catalog exception", () => {
    const factualClauseId = "relationship:derived-grade";
    const factualContract = compilePlaylistContractRevisionV1({
      contractId: "contract:deterministic-derived-grade",
      rawPrompt: "A track with independently documented provenance",
      requestedTrackCount: 1,
      locale: "en-US",
      storefront: "us",
      clauses: [{
        id: factualClauseId,
        kind: "factual_relationship",
        scope: "track",
        hardness: "hard",
        axis: "relationship",
        operator: "require",
        values: ["documented provenance"],
        source: {
          provenance: "prompt",
          text: "independently documented provenance",
        },
        evidence: {
          required: true,
          minimumGrade: null,
          permittedGrades: [
            "primary_source",
            "independent_secondary_source",
          ],
        },
      }],
      trackPredicate: { op: "clause", clauseId: factualClauseId },
    });
    const value = candidate(111);
    const proven = withHostedCanonicalEvidence(
      value,
      qualification(value),
      [factualClauseId],
    );
    const binding = proven.evidence.bindings?.[0];
    expect(binding).toBeDefined();
    const primaryBinding = {
      ...binding!,
      id: `${binding!.id}:primary`,
      kind: "primary_source",
    };
    const secondaryBinding = {
      ...binding!,
      id: `${binding!.id}:secondary`,
      kind: "independent_secondary_source",
    };
    const bindingIds = [primaryBinding.id, secondaryBinding.id];
    const derivedSecondary = {
      [factualClauseId]: {
        status: "pass" as const,
        evidenceGrade: "independent_secondary_source" as const,
        evidenceIds: bindingIds,
      },
    };
    expect(canonicalRequiredEvidenceIntegrityV3({
      policy: canonicalContractExecutionPolicyV1(factualContract),
      assessments: derivedSecondary,
      bindingIds,
      bindings: [primaryBinding, secondaryBinding],
      storefront: "us",
    })).toMatchObject({
      passed: true,
      evidenceGradeMismatchClauseIds: [],
    });
    expect(canonicalRequiredEvidenceIntegrityV3({
      policy: canonicalContractExecutionPolicyV1(factualContract),
      assessments: {
        [factualClauseId]: {
          ...derivedSecondary[factualClauseId],
          evidenceGrade: "primary_source",
        },
      },
      bindingIds,
      bindings: [primaryBinding, secondaryBinding],
      storefront: "us",
    })).toMatchObject({
      passed: false,
      evidenceGradeMismatchClauseIds: [factualClauseId],
    });

    const catalogClauseId = "membership:catalog-derived";
    const catalogContract = compilePlaylistContractRevisionV1({
      contractId: "contract:catalog-grade-boundary",
      rawPrompt: "A catalog-verified genre member",
      requestedTrackCount: 1,
      locale: "en-US",
      storefront: "us",
      clauses: [negativeProofClause(catalogClauseId, "membership")],
      trackPredicate: { op: "clause", clauseId: catalogClauseId },
    });
    const catalogPolicy = canonicalContractExecutionPolicyV1(catalogContract);
    expect(canonicalRequiredEvidenceIntegrityV3({
      policy: catalogPolicy,
      assessments: {
        [catalogClauseId]: {
          status: "pass",
          evidenceGrade: "authoritative_structured_metadata",
        },
      },
      bindingIds: [],
      bindings: [],
      storefront: "us",
    })).toMatchObject({
      passed: true,
      evidenceGradeMismatchClauseIds: [],
    });

    const catalogBinding = {
      ...binding!,
      kind: "authoritative_structured_metadata",
      predicateIds: [catalogClauseId],
      supportedPredicateIds: [catalogClauseId],
    };
    const catalogSnapshot = createHostedWebEvidenceSnapshotV3({
      sourceUrl: catalogBinding.url!,
      excerpt: `${value.artist} — ${value.title}: catalog evidence.`,
      responseId: `catalog-response-${value.id}`,
      outputItemId: `catalog-output-${value.id}`,
      contentIndex: 0,
      citationStartIndex: 0,
      citationEndIndex:
        `${value.artist} — ${value.title}: catalog evidence.`.length,
      excerptStartIndex: 0,
      excerptEndIndex:
        `${value.artist} — ${value.title}: catalog evidence.`.length,
      acquiredAt: HOSTED_TEST_ACQUIRED_AT,
      storefront: "us",
      freshnessExpiresAt: HOSTED_TEST_FRESH_UNTIL,
      predicateIds: [catalogClauseId],
      obligationIds: [catalogClauseId],
    });
    const boundCatalogBinding = {
      ...catalogBinding,
      governance: {
        ...catalogBinding.governance,
        acquiredAt: catalogSnapshot.acquiredAt,
        freshnessExpiresAt: catalogSnapshot.freshnessExpiresAt,
        sourceHash: catalogSnapshot.snapshotHash,
        sourceRevision: catalogSnapshot.snapshotHash,
      },
      hostedEvidenceSnapshot: catalogSnapshot,
      eligibilityAttestation: publicTrackScopeAttestationV3(
        catalogBinding.url!,
        catalogSnapshot,
      ),
    };
    expect(canonicalRequiredEvidenceIntegrityV3({
      policy: catalogPolicy,
      assessments: {
        [catalogClauseId]: {
          status: "pass",
          evidenceGrade: "authoritative_structured_metadata",
          evidenceIds: [boundCatalogBinding.id],
        },
      },
      bindingIds: [boundCatalogBinding.id],
      bindings: [boundCatalogBinding],
      storefront: "us",
    })).toMatchObject({
      passed: true,
      evidenceGradeMismatchClauseIds: [],
    });
  });

  test.each(REDUNDANT_NEGATIVE_PROOF_CASES)(
    "requires a complete bound negative-proof witness for $name",
    ({
      name,
      clauses,
      trackPredicate,
      negativeClauseIds,
      positiveClauseIds,
      proofClauseIds,
    }) => {
      const contract = compilePlaylistContractRevisionV1({
        contractId: `contract:redundant-negative:${
          name.toLowerCase().replace(/[^a-z0-9]+/gu, "-")
        }`,
        rawPrompt: `Canonical Boolean proof fixture: ${name}`,
        requestedTrackCount: 1,
        locale: "en-US",
        storefront: "us",
        clauses,
        trackPredicate,
      });
      const policy = canonicalContractExecutionPolicyV1(contract);
      const assessments = {
        ...Object.fromEntries(negativeClauseIds.map((clauseId) => [
          clauseId,
          {
            status: "fail" as const,
            evidenceGrade: "authoritative_structured_metadata" as const,
          },
        ])),
        ...Object.fromEntries(positiveClauseIds.map((clauseId) => [
          clauseId,
          {
            status: "pass" as const,
            evidenceGrade: "authoritative_structured_metadata" as const,
          },
        ])),
      };

      const withoutProof = canonicalRequiredEvidenceIntegrityV3({
        policy,
        assessments,
        bindingIds: [],
        bindings: [],
        storefront: "us",
      });
      expect(withoutProof.passed).toBe(false);
      expect(withoutProof.missingRequiredClauseIds.length).toBeGreaterThan(0);

      const value = candidate(199);
      const proven = withHostedCanonicalEvidence(
        value,
        qualification(value),
        proofClauseIds,
      );
      const bindingId = proven.evidence.bindingIds[0]!;
      const withCompleteWitness = canonicalRequiredEvidenceIntegrityV3({
        policy,
        assessments: {
          ...assessments,
          ...Object.fromEntries(proofClauseIds.map((clauseId) => [
            clauseId,
            {
              ...assessments[clauseId],
              evidenceGrade: "track_specific_editorial_assertion" as const,
              evidenceIds: [bindingId],
            },
          ])),
        },
        bindingIds: proven.evidence.bindingIds,
        bindings: proven.evidence.bindings,
        storefront: "us",
      });
      expect(withCompleteWitness).toMatchObject({
        passed: true,
        missingRequiredClauseIds: [],
        obligationMismatchClauseIds: [],
      });

      const wrong = withHostedCanonicalEvidence(
        value,
        qualification(value),
        ["wrong:obligation"],
      );
      const wrongBindingId = wrong.evidence.bindingIds[0]!;
      const withWrongObligation = canonicalRequiredEvidenceIntegrityV3({
        policy,
        assessments: {
          ...assessments,
          ...Object.fromEntries(proofClauseIds.map((clauseId) => [
            clauseId,
            {
              ...assessments[clauseId],
              evidenceGrade: "track_specific_editorial_assertion" as const,
              evidenceIds: [wrongBindingId],
            },
          ])),
        },
        bindingIds: wrong.evidence.bindingIds,
        bindings: wrong.evidence.bindings,
        storefront: "us",
      });
      expect(withWrongObligation.passed).toBe(false);
      expect(withWrongObligation.obligationMismatchClauseIds)
        .toEqual(expect.arrayContaining([...proofClauseIds]));
    },
  );

  test.each([
    {
      name: "NOT with a missing reject-policy leaf",
      clauses: [{
        ...negativeProofClause("membership:not-missing", "membership"),
        unknownPolicy: "reject" as const,
      }],
      trackPredicate: {
        op: "not" as const,
        child: {
          op: "clause" as const,
          clauseId: "membership:not-missing",
        },
      },
      assessments: {},
      expectedMissingClauseIds: ["membership:not-missing"],
    },
    {
      name: "NOT with an explicit unknown reject-policy leaf",
      clauses: [{
        ...negativeProofClause("membership:not-unknown", "membership"),
        unknownPolicy: "reject" as const,
      }],
      trackPredicate: {
        op: "not" as const,
        child: {
          op: "clause" as const,
          clauseId: "membership:not-unknown",
        },
      },
      assessments: {
        "membership:not-unknown": { status: "unknown" as const },
      },
      expectedMissingClauseIds: ["membership:not-unknown"],
    },
    {
      name: "nested NOT with a missing reject-policy leaf",
      clauses: [{
        ...negativeProofClause("membership:nested-not-missing", "membership"),
        unknownPolicy: "reject" as const,
      }],
      trackPredicate: {
        op: "not" as const,
        child: {
          op: "not" as const,
          child: {
            op: "not" as const,
            child: {
              op: "clause" as const,
              clauseId: "membership:nested-not-missing",
            },
          },
        },
      },
      assessments: {},
      expectedMissingClauseIds: ["membership:nested-not-missing"],
    },
    {
      name: "EXCEPT with a missing reject-policy exception",
      clauses: [
        negativeProofClause("membership:except-base", "membership"),
        {
          ...negativeProofClause(
            "membership:except-missing",
            "membership",
          ),
          unknownPolicy: "reject" as const,
        },
      ],
      trackPredicate: {
        op: "except" as const,
        base: {
          op: "clause" as const,
          clauseId: "membership:except-base",
        },
        exceptions: [{
          op: "clause" as const,
          clauseId: "membership:except-missing",
        }],
      },
      assessments: {
        "membership:except-base": {
          status: "pass" as const,
          evidenceGrade: "authoritative_structured_metadata" as const,
        },
      },
      expectedMissingClauseIds: ["membership:except-missing"],
    },
    {
      name: "alternative NOT branches with missing reject-policy leaves",
      clauses: [
        {
          ...negativeProofClause(
            "membership:alternative-missing-a",
            "membership",
          ),
          unknownPolicy: "reject" as const,
        },
        {
          ...negativeProofClause(
            "membership:alternative-missing-b",
            "membership",
          ),
          unknownPolicy: "reject" as const,
        },
      ],
      trackPredicate: {
        op: "alternative" as const,
        choices: [
          {
            id: "missing-a",
            priority: 1,
            predicate: {
              op: "not" as const,
              child: {
                op: "clause" as const,
                clauseId: "membership:alternative-missing-a",
              },
            },
          },
          {
            id: "missing-b",
            priority: 2,
            predicate: {
              op: "not" as const,
              child: {
                op: "clause" as const,
                clauseId: "membership:alternative-missing-b",
              },
            },
          },
        ],
      },
      assessments: {},
      expectedMissingClauseIds: [
        "membership:alternative-missing-a",
        "membership:alternative-missing-b",
      ],
    },
    {
      name: "NOT with a disallowed authoritative grade label",
      clauses: [{
        ...negativeProofClause(
          "membership:not-disallowed-grade",
          "membership",
        ),
        unknownPolicy: "reject" as const,
        evidence: {
          required: true,
          minimumGrade: "trusted_scoped_container" as const,
          permittedGrades: ["trusted_scoped_container" as const],
        },
      }],
      trackPredicate: {
        op: "not" as const,
        child: {
          op: "clause" as const,
          clauseId: "membership:not-disallowed-grade",
        },
      },
      assessments: {
        "membership:not-disallowed-grade": {
          status: "pass" as const,
          evidenceGrade: "authoritative_structured_metadata" as const,
        },
      },
      expectedMissingClauseIds: ["membership:not-disallowed-grade"],
    },
  ])("does not turn policy coercion into factual proof for $name", ({
    name,
    clauses,
    trackPredicate,
    assessments,
    expectedMissingClauseIds,
  }) => {
    const typedAssessments = assessments as NonNullable<
      CandidateQualificationV3["canonicalClauseAssessments"]
    >;
    const contract = compilePlaylistContractRevisionV1({
      contractId: `contract:policy-proof:${
        name.toLowerCase().replace(/[^a-z0-9]+/gu, "-")
      }`,
      rawPrompt: `Policy proof fixture: ${name}`,
      requestedTrackCount: 1,
      locale: "en-US",
      storefront: "us",
      clauses,
      trackPredicate,
    });
    const policy = canonicalContractExecutionPolicyV1(contract);
    expect(evaluateCanonicalContractTrackV1({
      policy,
      assessments: typedAssessments,
    }).eligible).toBe(true);

    const integrity = canonicalRequiredEvidenceIntegrityV3({
      policy,
      assessments: typedAssessments,
      bindingIds: [],
      bindings: [],
      storefront: "us",
    });
    expect(integrity.passed).toBe(false);
    expect(integrity.missingRequiredClauseIds.length).toBeGreaterThan(0);
    expect([...expectedMissingClauseIds]).toEqual(
      expect.arrayContaining([...integrity.missingRequiredClauseIds]),
    );
    expect(integrity.obligationMismatchClauseIds).toEqual([]);
  });

  test("requires decisive positive proof even when a hard clause allows unknown", () => {
    const clauseId = "membership:hard-positive-allow";
    const contract = compilePlaylistContractRevisionV1({
      contractId: "contract:hard-positive-allow-proof",
      rawPrompt: "Use the hard positive membership",
      requestedTrackCount: 1,
      locale: "en-US",
      storefront: "us",
      clauses: [{
        ...negativeProofClause(clauseId, "membership"),
        unknownPolicy: "allow",
      }],
      trackPredicate: { op: "clause", clauseId },
    });
    const policy = canonicalContractExecutionPolicyV1(contract);
    expect(evaluateCanonicalContractTrackV1({
      policy,
      assessments: {},
    }).eligible).toBe(true);
    expect(canonicalRequiredEvidenceIntegrityV3({
      policy,
      assessments: {},
      bindingIds: [],
      bindings: [],
      storefront: "us",
    })).toMatchObject({
      passed: false,
      missingRequiredClauseIds: [clauseId],
    });

    const value = candidate(299);
    const proven = withHostedCanonicalEvidence(
      value,
      qualification(value),
      [clauseId],
    );
    const bindingId = proven.evidence.bindingIds[0]!;
    const assessments = {
      [clauseId]: {
        status: "pass" as const,
        evidenceGrade: "track_specific_editorial_assertion" as const,
        evidenceIds: [bindingId],
      },
    };
    expect(canonicalRequiredEvidenceIntegrityV3({
      policy,
      assessments,
      bindingIds: proven.evidence.bindingIds,
      bindings: proven.evidence.bindings,
      storefront: "us",
    })).toMatchObject({
      passed: true,
      missingRequiredClauseIds: [],
      obligationMismatchClauseIds: [],
    });
    expect(canonicalRequiredEvidenceIntegrityV3({
      policy,
      assessments: {
        [clauseId]: {
          ...assessments[clauseId],
          evidenceIds: [],
        },
      },
      bindingIds: [],
      bindings: [],
      storefront: "us",
    })).toMatchObject({
      passed: false,
      missingRequiredClauseIds: [clauseId],
    });
  });

  test("does not require proof for a failed negative branch irrelevant to a complete positive witness", () => {
    const contract = compilePlaylistContractRevisionV1({
      contractId: "contract:irrelevant-negative-proof",
      rawPrompt: "Use the explicit membership or the exclusion alternative",
      requestedTrackCount: 1,
      locale: "en-US",
      storefront: "us",
      clauses: [
        negativeProofClause("membership:complete", "membership"),
        negativeProofClause("exclude:irrelevant", "exclusion"),
      ],
      trackPredicate: {
        op: "any",
        children: [
          { op: "clause", clauseId: "membership:complete" },
          { op: "clause", clauseId: "exclude:irrelevant" },
        ],
      },
    });

    expect(canonicalRequiredEvidenceIntegrityV3({
      policy: canonicalContractExecutionPolicyV1(contract),
      assessments: {
        "membership:complete": {
          status: "pass",
          evidenceGrade: "authoritative_structured_metadata",
        },
        "exclude:irrelevant": {
          status: "fail",
          evidenceGrade: "authoritative_structured_metadata",
        },
      },
      bindingIds: [],
      bindings: [],
      storefront: "us",
    })).toMatchObject({
      passed: true,
      missingRequiredClauseIds: [],
      obligationMismatchClauseIds: [],
    });
  });

  test("rejects a hash-valid hosted binding borrowed for the wrong canonical obligation", async () => {
    const selection = canonicalDiscoPlan(1);
    const result = await executeRetrievalV3({
      runId: "canonical-wrong-obligation",
      plan: selection,
      adapters: {
        discover: async () => ({
          candidates: [candidate(0)],
          nextCursor: null,
          exhausted: true,
        }),
        qualify: async ({ candidates }) => candidates.map((value) => {
          const qualified = canonicalDiscoQualification(value);
          const binding = qualified.evidence.bindings?.[0];
          const snapshot = binding?.hostedEvidenceSnapshot;
          if (!binding?.url || !snapshot) {
            throw new Error("canonical hosted evidence fixture is incomplete");
          }
          const wrongObligation = createHostedWebEvidenceSnapshotV3({
            sourceUrl: snapshot.sourceUrl,
            excerpt: snapshot.excerpt,
            responseId: snapshot.providerLocator.responseId,
            outputItemId: snapshot.providerLocator.outputItemId,
            contentIndex: snapshot.providerLocator.contentIndex,
            citationStartIndex:
              snapshot.providerLocator.citationStartIndex,
            citationEndIndex: snapshot.providerLocator.citationEndIndex,
            excerptStartIndex: snapshot.providerLocator.excerptStartIndex,
            excerptEndIndex: snapshot.providerLocator.excerptEndIndex,
            acquiredAt: snapshot.acquiredAt,
            storefront: snapshot.storefront,
            freshnessExpiresAt: snapshot.freshnessExpiresAt,
            predicateIds: ["genre:disco"],
            obligationIds: ["genre:house"],
          });
          return {
            ...qualified,
            evidence: {
              ...qualified.evidence,
              bindings: [{
                ...binding,
                governance: {
                  ...binding.governance,
                  sourceHash: wrongObligation.snapshotHash,
                  sourceRevision: wrongObligation.snapshotHash,
                },
                hostedEvidenceSnapshot: wrongObligation,
                eligibilityAttestation: publicTrackScopeAttestationV3(
                  binding.url,
                  wrongObligation,
                ),
              }],
            },
          };
        }),
      },
      policy: { maximumGlobalRounds: 1 },
    });

    expect(result.qualifiedPool).toEqual([]);
    expect(result.deficit.discardedByReason)
      .toMatchObject({ evidence_attestation_missing: 1 });
    expect(result.integrityEvents).toContainEqual(
      expect.stringContaining("canonical_evidence_attestation_missing:"),
    );
  });

  test("fills the exact target plus max(10, twenty-percent) qualified reserve", async () => {
    const adapters = allQualifiedAdapter(20);
    const result = await executeRetrievalV3({
      runId: "exact-run",
      plan: plan("50 influential disco tracks", 50),
      adapters,
    });

    expect(result.outcome).toMatchObject({
      status: "exact_ready",
      requestedTrackCount: 50,
      selectedTrackCount: 50,
      reserveTrackCount: 10,
      shortfall: 0,
      requiresPartialPublicationDecision: false,
    });
    expect(result.selected).toHaveLength(50);
    expect(result.reserve).toHaveLength(10);
    expect(result.deficit).toMatchObject({
      qualifiedPoolGoal: 60,
      targetShortfall: 0,
      reserveShortfall: 0,
    });
    expect(result.publicationBoundary).toEqual({
      appleWriteAccess: "forbidden",
      manifestDisposition: "exact_draft_ready",
    });
    expect(adapters.discover).toHaveBeenCalled();
    for (const [request] of vi.mocked(adapters.discover).mock.calls) {
      expect(request.appleWriteAccess).toBe("forbidden");
      expect(request.requestedRawCandidateCount).toBeGreaterThan(0);
    }
  });

  test("uses the immutable conversion-derived qualified pool goal when supplied", async () => {
    const result = await executeRetrievalV3({
      runId: "conversion-reserve-run",
      plan: plan("20 storefront-safe disco tracks", 20),
      adapters: allQualifiedAdapter(50),
      policy: { qualifiedPoolGoal: 45 },
    });

    expect(result.outcome).toMatchObject({
      status: "exact_ready",
      selectedTrackCount: 20,
      reserveTrackCount: 25,
    });
    expect(result.deficit).toMatchObject({
      qualifiedPoolGoal: 45,
      reserveShortfall: 0,
    });
  });

  test("uses the clamped P10 goal for discovery without demanding that many Apple-safe tracks", async () => {
    const conversion = playlistCandidateGoalV1(25, 0.01);
    expect(conversion).toEqual({
      candidateGoal: 105,
      reserveTrackCount: 5,
      clampedConversionRate: 0.25,
    });
    const discover = vi.fn(async (
      request: Parameters<RetrievalAdaptersV3["discover"]>[0],
    ) => ({
      candidates: Array.from(
        { length: Math.min(35, request.requestedRawCandidateCount) },
        (_, index) => candidate(index),
      ),
      nextCursor: null,
      exhausted: true,
      costUnits: 1,
    }));
    const result = await executeRetrievalV3({
      runId: "conversion-discovery-not-safe-reserve",
      plan: planWithIntents(["mood_activity"], 25),
      adapters: {
        discover,
        qualify: async ({ candidates }) => candidates.map((value) => qualification(value)),
      },
      policy: {
        maximumConcurrentDiscovery: 1,
        maximumCostUnits: 1,
        candidateGoal: conversion.candidateGoal,
        qualifiedPoolGoal: 25 + conversion.reserveTrackCount,
      },
    });

    expect(discover).toHaveBeenCalledOnce();
    expect(result.outcome).toMatchObject({
      status: "exact_ready",
      selectedTrackCount: 25,
      reserveTrackCount: 5,
    });
    expect(result.deficit).toMatchObject({
      qualifiedPoolGoal: 30,
      reserveShortfall: 0,
    });
    expect(result.qualifiedPool).toHaveLength(35);
  });

  test("does not fill an exact count with a known central-quality failure", async () => {
    let next = 0;
    let delivered = false;
    const qualityPlan: SelectionPlanV3 = {
      ...plan("10 smooth, polished, danceable disco tracks", 10),
      playlistQualityPolicy: {
        policyVersion: "canonical_central_quality_v1",
        clauseIds: ["quality:smooth", "quality:polished", "quality:danceable"],
        criteria: ["smooth", "polished", "danceable"],
        minimumPassRatio: 0.8,
        maximumUnknownRatio: 0.2,
        zeroKnownFailures: true,
        signalDimension: "central_quality",
        passThreshold: 0.75,
        failThreshold: 0.4,
        signalSemantics: "ranking_only_not_factual_evidence",
      },
    };
    const result = await executeRetrievalV3({
      runId: "quality-floor-run",
      plan: qualityPlan,
      adapters: {
        discover: async () => {
          if (delivered) return { candidates: [], nextCursor: null, exhausted: true };
          delivered = true;
          return {
            candidates: Array.from({ length: 10 }, () => candidate(next++)),
            nextCursor: null,
            exhausted: true,
          };
        },
        qualify: async ({ candidates }) => candidates.map((value, index) => (
          qualification(value, {
            centralQualityCriterionObservations: centralQualityObservations(
              value,
              qualityPlan.playlistQualityPolicy!,
              index < 8 ? "pass" : index === 8 ? "unknown" : "fail",
            ),
            rankingSignals: {
              relevance: 0.9,
              central_quality: index < 8 ? 0.9 : index === 8 ? 0.6 : 0.2,
            },
          })
        )),
      },
    });

    expect(result.outcome).toMatchObject({
      status: "partial_ready",
      stopReason: "central_quality_floor",
      selectedTrackCount: 9,
      shortfall: 1,
      requiresPartialPublicationDecision: true,
    });
    expect(result.selected.some(({ rankingSignals }) => (
      Number(rankingSignals.central_quality ?? 0) < 0.4
    ))).toBe(false);
    expect(result.centralQuality).toMatchObject({
      passed: true,
      passCount: 8,
      failCount: 0,
      unknownCount: 1,
    });
    expect(result.deficit.discardedByReason).toMatchObject({
      central_quality_failed: 1,
    });
  });

  test.each([
    {
      label: "five verified criteria and one bounded unknown",
      verdicts: ["pass", "pass", "pass", "pass", "pass", "unknown"] as const,
      expected: "pass" as const,
    },
    {
      label: "four verified criteria and two unknowns above the ceiling",
      verdicts: ["pass", "pass", "pass", "pass", "unknown", "unknown"] as const,
      expected: "unknown" as const,
    },
    {
      label: "a known failure despite five verified criteria",
      verdicts: ["pass", "pass", "pass", "pass", "pass", "fail"] as const,
      expected: "fail" as const,
    },
  ])("aggregates central suitability without converting every criterion into a hard gate: $label", ({
    verdicts,
    expected,
  }) => {
    const criteria = [
      "crowd-pleasing",
      "danceable",
      "flirtatious",
      "polished",
      "sensual",
      "smooth",
    ];
    const qualityPlan = canonicalDiscoPlan(1, {
      playlistQualityPolicy: {
        policyVersion: "canonical_central_quality_v1",
        clauseIds: criteria.map((criterion) => `quality:${criterion}`),
        criteria,
        minimumPassRatio: 0.8,
        maximumUnknownRatio: 0.2,
        zeroKnownFailures: true,
        signalDimension: "central_quality",
        passThreshold: 0.75,
        failThreshold: 0.4,
        signalSemantics: "ranking_only_not_factual_evidence",
      },
    });
    const value = candidate(888);
    const qualificationResult = canonicalDiscoQualification(value, {
      centralQualityCriterionObservations: criteria.map((criterion, index) => (
        createCentralQualityCriterionObservationV3({
          policy: qualityPlan.playlistQualityPolicy!,
          criterion,
          verdict: verdicts[index]!,
          sourceKind: "hosted_web_response",
          sourceId: `quality:${criterion}`,
          artist: value.artist,
          title: value.title,
          album: value.album,
          catalogIdentity: {
            appleSongId: `apple-${value.id}`,
            recordingFamilyKey: `family-${value.id}`,
          },
        })
      )),
    });
    const track: QualifiedTrackV3 = {
      candidateId: qualificationResult.candidateId,
      artist: value.artist,
      title: value.title,
      album: value.album,
      sourceObservationIds: value.sourceObservationIds,
      appleSongId: qualificationResult.catalog.appleSongId!,
      recordingFamilyKey: qualificationResult.catalog.recordingFamilyKey!,
      evidenceBindingIds: qualificationResult.evidence.bindingIds,
      evidenceBindings: qualificationResult.evidence.bindings,
      centralQualityCriterionObservations:
        qualificationResult.centralQualityCriterionObservations,
      canonicalClauseAssessments:
        qualificationResult.canonicalClauseAssessments,
      evidenceStrength: qualificationResult.evidence.strength,
      scopeFit: qualificationResult.scope.fit,
      independentProvenanceRoots:
        qualificationResult.evidence.independentProvenanceRoots,
      versionConfidence: qualificationResult.version.confidence,
      catalogConfidence: qualificationResult.catalog.confidence,
      rankingSignals: qualificationResult.rankingSignals,
      sourceRank: qualificationResult.sourceRank,
    };

    expect(centralQualityVerdictV3(
      track,
      qualityPlan.playlistQualityPolicy!,
    )).toBe(expected);
  });

  test("preserves catalog-bound quality proof when discovery omitted the album", async () => {
    const qualityPlan: SelectionPlanV3 = {
      ...plan("one smooth disco track", 1),
      playlistQualityPolicy: {
        policyVersion: "canonical_central_quality_v1",
        clauseIds: ["quality:smooth"],
        criteria: ["smooth"],
        minimumPassRatio: 0.8,
        maximumUnknownRatio: 0.2,
        zeroKnownFailures: true,
        signalDimension: "central_quality",
        passThreshold: 0.75,
        failThreshold: 0.4,
        signalSemantics: "ranking_only_not_factual_evidence",
      },
    };
    const value = candidate(101, {
      artist: "Resolved Artist",
      title: "Resolved Track",
      album: null,
    });
    const appleSongId = `apple-${value.id}`;
    const recordingFamilyKey = `family-${value.id}`;
    const observations = qualityPlan.playlistQualityPolicy!.criteria.map(
      (criterion) => createCentralQualityCriterionObservationV3({
        policy: qualityPlan.playlistQualityPolicy!,
        criterion,
        verdict: "pass",
        sourceKind: "hosted_web_response",
        sourceId: "resolved-quality-source",
        artist: value.artist,
        title: value.title,
        album: "Resolved Album",
        catalogIdentity: { appleSongId, recordingFamilyKey },
      }),
    );
    let delivered = false;
    const result = await executeRetrievalV3({
      runId: "quality-resolved-catalog-identity",
      plan: qualityPlan,
      adapters: {
        discover: async () => {
          if (delivered) {
            return { candidates: [], nextCursor: null, exhausted: true };
          }
          delivered = true;
          return { candidates: [value], nextCursor: null, exhausted: true };
        },
        qualify: async () => [qualification(value, {
          catalog: {
            storefrontPlayable: true,
            appleSongId,
            recordingFamilyKey,
            artistName: value.artist,
            trackName: value.title,
            albumName: "Resolved Album",
            confidence: 0.99,
          },
          centralQualityCriterionObservations: observations,
          rankingSignals: { relevance: 1, central_quality: 1 },
        })],
      },
    });

    expect(result.outcome.status).toBe("exact_ready");
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]).toMatchObject({
      artist: value.artist,
      title: value.title,
      album: "Resolved Album",
      appleSongId,
      recordingFamilyKey,
    });
    expect(result.centralQuality).toMatchObject({
      passed: true,
      passCount: 1,
      failCount: 0,
      unknownCount: 0,
    });
  });

  test("joins catalog-bound quality proof to a separately membership-qualified recording", async () => {
    const qualityPlan = canonicalDiscoPlan(1, {
      playlistQualityPolicy: {
        policyVersion: "canonical_central_quality_v1",
        clauseIds: ["quality:smooth"],
        criteria: ["smooth"],
        minimumPassRatio: 0.8,
        maximumUnknownRatio: 0.2,
        zeroKnownFailures: true,
        signalDimension: "central_quality",
        passThreshold: 0.75,
        failThreshold: 0.4,
        signalSemantics: "ranking_only_not_factual_evidence",
      },
    });
    const membershipLead = candidate(201, {
      artist: "Shared Artist",
      title: "Shared Track",
      album: "Shared Album",
    });
    const qualityLead = candidate(202, {
      artist: `${membershipLead.artist} feat. Guest`,
      title: membershipLead.title,
      album: membershipLead.album,
    });
    const catalogIdentity = {
      appleSongId: "apple-shared-recording",
      recordingFamilyKey: "family-shared-recording",
    };
    const catalog = {
      storefrontPlayable: true,
      ...catalogIdentity,
      artistName: membershipLead.artist,
      trackName: membershipLead.title,
      albumName: membershipLead.album!,
      confidence: 0.99,
    };
    const membership = canonicalDiscoQualification(membershipLead, { catalog });
    const quality = {
      ...canonicalDiscoQualification(qualityLead, {
        catalog,
        centralQualityCriterionObservations:
          qualityPlan.playlistQualityPolicy!.criteria.map((criterion) => (
            createCentralQualityCriterionObservationV3({
              policy: qualityPlan.playlistQualityPolicy!,
              criterion,
              verdict: "pass",
              sourceKind: "hosted_web_response",
              sourceId: "quality-only-source",
              artist: membershipLead.artist,
              title: membershipLead.title,
              album: membershipLead.album,
              catalogIdentity,
            })
          )),
      }),
      canonicalClauseAssessments: {
        "genre:disco": {
          status: "unknown" as const,
          evidenceGrade: null,
        },
      },
    };
    let delivered = false;
    const result = await executeRetrievalV3({
      runId: "quality-separated-membership-proof",
      plan: qualityPlan,
      adapters: {
        discover: async () => {
          if (delivered) {
            return { candidates: [], nextCursor: null, exhausted: true };
          }
          delivered = true;
          return {
            candidates: [membershipLead, qualityLead],
            nextCursor: null,
            exhausted: true,
          };
        },
        qualify: async () => [membership, quality],
      },
      policy: {
        qualifiedPoolGoal: 1,
        maximumGlobalRounds: 1,
      },
    });

    expect(result.outcome).toMatchObject({
      status: "exact_ready",
      selectedTrackCount: 1,
      shortfall: 0,
    });
    expect(result.selected[0]).toMatchObject(catalogIdentity);
    expect(result.centralQuality).toMatchObject({
      passed: true,
      passCount: 1,
      failCount: 0,
      unknownCount: 0,
    });
  });

  test("retains conflicting criterion observations and lets a known failure dominate a later pass", async () => {
    const qualityPlan: SelectionPlanV3 = {
      ...plan("one smooth disco track", 1),
      playlistQualityPolicy: {
        policyVersion: "canonical_central_quality_v1",
        clauseIds: ["quality:smooth"],
        criteria: ["smooth"],
        minimumPassRatio: 0.8,
        maximumUnknownRatio: 0.2,
        zeroKnownFailures: true,
        signalDimension: "central_quality",
        passThreshold: 0.75,
        failThreshold: 0.4,
        signalSemantics: "ranking_only_not_factual_evidence",
      },
    };
    const candidates = [candidate(100, {
      artist: "Conflict Artist",
      title: "Conflict Track",
      album: "Conflict Album",
    })];
    let delivered = false;
    const result = await executeRetrievalV3({
      runId: "quality-conflict-fails-closed",
      plan: qualityPlan,
      adapters: {
        discover: async () => {
          if (delivered) {
            return { candidates: [], nextCursor: null, exhausted: true };
          }
          delivered = true;
          return { candidates, nextCursor: null, exhausted: true };
        },
        qualify: async ({ candidates: values }) => values.map(
          (value) => qualification(value, {
            centralQualityCriterionObservations: [
              ...Array.from({ length: 450 }, (_, sourceIndex) => (
                centralQualityObservations(
                  value,
                  qualityPlan.playlistQualityPolicy!,
                  "pass",
                  `quality-conflict-pass-${sourceIndex}`,
                )
              )).flat(),
              ...centralQualityObservations(
                value,
                qualityPlan.playlistQualityPolicy!,
                "fail",
                "quality-conflict-late-failure",
              ),
            ],
            rankingSignals: {
              relevance: 0.9,
              central_quality: 1,
            },
          }),
        ),
      },
    });

    expect(result.selected).toHaveLength(0);
    expect(result.deficit.discardedByReason).toMatchObject({
      central_quality_failed: 1,
    });
    expect(result.outcome).toMatchObject({
      status: "needs_decision",
      stopReason: "central_quality_floor",
      selectedTrackCount: 0,
    });
  });

  test("treats a high aggregate score with stale policy-bound observations as unknown", async () => {
    const qualityPlan: SelectionPlanV3 = {
      ...plan("one smooth disco track", 1),
      playlistQualityPolicy: {
        policyVersion: "canonical_central_quality_v1",
        clauseIds: ["quality:smooth"],
        criteria: ["smooth"],
        minimumPassRatio: 0.8,
        maximumUnknownRatio: 0.2,
        zeroKnownFailures: true,
        signalDimension: "central_quality",
        passThreshold: 0.75,
        failThreshold: 0.4,
        signalSemantics: "ranking_only_not_factual_evidence",
      },
    };
    const value = candidate(102);
    const stalePolicy = {
      ...qualityPlan.playlistQualityPolicy!,
      minimumPassRatio: 0.7,
    };
    let delivered = false;
    const result = await executeRetrievalV3({
      runId: "quality-aggregate-not-proof",
      plan: qualityPlan,
      adapters: {
        discover: async () => {
          if (delivered) {
            return { candidates: [], nextCursor: null, exhausted: true };
          }
          delivered = true;
          return { candidates: [value], nextCursor: null, exhausted: true };
        },
        qualify: async () => [qualification(value, {
          centralQualityCriterionObservations:
            centralQualityObservations(value, stalePolicy, "pass"),
          rankingSignals: { relevance: 1, central_quality: 1 },
        })],
      },
    });

    expect(result.selected).toHaveLength(0);
    expect(result.deficit.discardedByReason).toMatchObject({
      central_quality_unknown_excess: 1,
    });
    expect(result.outcome.stopReason).toBe("central_quality_floor");
  });

  test("does not replay central-quality proof across albums or catalog recording families", async () => {
    const qualityPlan: SelectionPlanV3 = {
      ...plan("one smooth disco track", 1),
      playlistQualityPolicy: {
        policyVersion: "canonical_central_quality_v1",
        clauseIds: ["quality:smooth"],
        criteria: ["smooth"],
        minimumPassRatio: 0.8,
        maximumUnknownRatio: 0.2,
        zeroKnownFailures: true,
        signalDimension: "central_quality",
        passThreshold: 0.75,
        failThreshold: 0.4,
        signalSemantics: "ranking_only_not_factual_evidence",
      },
    };
    const value = candidate(103, {
      artist: "Shared Artist",
      title: "Shared Title",
      album: "Selected Album",
    });
    const replayed = qualityPlan.playlistQualityPolicy!.criteria.map(
      (criterion) => createCentralQualityCriterionObservationV3({
        policy: qualityPlan.playlistQualityPolicy!,
        criterion,
        verdict: "pass",
        sourceKind: "independent_curator_review",
        sourceId: "review-for-another-recording",
        artist: value.artist,
        title: value.title,
        album: "Different Album",
        catalogIdentity: {
          appleSongId: "apple-different-recording",
          recordingFamilyKey: "family-different-recording",
        },
      }),
    );
    let delivered = false;
    const result = await executeRetrievalV3({
      runId: "quality-catalog-replay-fails-closed",
      plan: qualityPlan,
      adapters: {
        discover: async () => {
          if (delivered) {
            return { candidates: [], nextCursor: null, exhausted: true };
          }
          delivered = true;
          return { candidates: [value], nextCursor: null, exhausted: true };
        },
        qualify: async () => [qualification(value, {
          centralQualityCriterionObservations: replayed,
          rankingSignals: { relevance: 1, central_quality: 1 },
        })],
      },
    });

    expect(result.selected).toHaveLength(0);
    expect(result.deficit.discardedByReason).toMatchObject({
      central_quality_unknown_excess: 1,
    });
    expect(result.outcome.stopReason).toBe("central_quality_floor");
  });

  test("does not truncate quality enrichment to remaining raw-lead capacity", async () => {
    const base = canonicalDiscoPlan(5);
    const qualityPlan: SelectionPlanV3 = {
      ...base,
      playlistQualityPolicy: {
        policyVersion: "canonical_central_quality_v1",
        clauseIds: ["quality:smooth"],
        criteria: ["smooth"],
        minimumPassRatio: 0.8,
        maximumUnknownRatio: 0.2,
        zeroKnownFailures: true,
        signalDimension: "central_quality",
        passThreshold: 0.75,
        failThreshold: 0.4,
        signalSemantics: "ranking_only_not_factual_evidence",
      },
    };
    let seeded = false;
    let qualityRequestCount = 0;
    await executeRetrievalV3({
      runId: "quality-enrichment-raw-capacity",
      plan: qualityPlan,
      policy: {
        maximumRawCandidates: 6,
        maximumGlobalRounds: 20,
        maximumConcurrentDiscovery: 1,
        qualifiedPoolGoal: 5,
      },
      adapters: {
        discover: async (request) => {
          if (request.strategy.kind === "qualified_expansion"
            && request.qualifiedTrackSeeds.length > 0) {
            qualityRequestCount = Math.max(
              qualityRequestCount,
              request.requestedRawCandidateCount,
            );
            return { candidates: [], nextCursor: null, exhausted: true };
          }
          if (!seeded
            && request.strategy.discoveryDependencyIds.some(
              (dependency) => dependency !== "orchestration_local",
            )) {
            seeded = true;
            return {
              candidates: Array.from({ length: 5 }, (_, index) => candidate(index)),
              nextCursor: null,
              exhausted: true,
            };
          }
          return { candidates: [], nextCursor: null, exhausted: true };
        },
        qualify: async ({ candidates }) => candidates.map((value) => (
          canonicalDiscoQualification(value)
        )),
      },
    });

    expect(qualityRequestCount).toBe(5);
  });

  test("stops re-judging resolved quality seeds and spends the next pass on the deficit", async () => {
    const base = canonicalDiscoPlan(6);
    const qualityPlan: SelectionPlanV3 = {
      ...base,
      playlistQualityPolicy: {
        policyVersion: "canonical_central_quality_v1",
        clauseIds: ["quality:smooth"],
        criteria: ["smooth"],
        minimumPassRatio: 0.8,
        maximumUnknownRatio: 0.2,
        zeroKnownFailures: true,
        signalDimension: "central_quality",
        passThreshold: 0.75,
        failThreshold: 0.4,
        signalSemantics: "ranking_only_not_factual_evidence",
      },
    };
    const initial = Array.from({ length: 6 }, (_, index) => candidate(index));
    const replacements = [candidate(6), candidate(7)];
    let replacementIndex = 0;
    let seeded = false;
    const unresolvedSeedCounts: number[] = [];
    const strategyKinds: string[] = [];

    const result = await executeRetrievalV3({
      runId: "quality-deficit-switches-to-fresh-catalog",
      plan: qualityPlan,
      policy: {
        maximumRawCandidates: 20,
        maximumGlobalRounds: 20,
        maximumConcurrentDiscovery: 1,
        candidateGoal: 12,
        qualifiedPoolGoal: 7,
      },
      adapters: {
        discover: async (request) => {
          strategyKinds.push(request.strategy.kind);
          if (request.strategy.kind === "qualified_expansion"
            && request.qualifiedTrackSeeds.length > 0) {
            const unresolved = request.qualityEvidenceTrackSeeds ?? [];
            unresolvedSeedCounts.push(unresolved.length);
            if (unresolved.length > 0) {
              return {
                candidates: initial.map((value) => ({
                  ...value,
                  sourceObservationIds: [
                    ...value.sourceObservationIds,
                    `quality-${value.id}`,
                  ],
                })),
                nextCursor: "quality-complete",
                exhausted: false,
                provenance: { cacheOrigin: "live", sourceFreshUntil: null },
              };
            }
            return {
              candidates: replacementIndex < replacements.length
                ? [replacements[replacementIndex++]!]
                : [],
              nextCursor: null,
              exhausted: replacementIndex >= replacements.length,
              provenance: { cacheOrigin: "live", sourceFreshUntil: null },
            };
          }
          if (!seeded
            && request.strategy.discoveryDependencyIds.some(
              (dependency) => dependency !== "orchestration_local",
            )) {
            seeded = true;
            return {
              candidates: initial,
              nextCursor: null,
              exhausted: true,
              provenance: { cacheOrigin: "live", sourceFreshUntil: null },
            };
          }
          return { candidates: [], nextCursor: null, exhausted: true };
        },
        qualify: async ({ candidates: values }) => values.map((value) => {
          const qualityEnriched = value.sourceObservationIds.some(
            (id) => id.startsWith("quality-"),
          ) || replacements.some(({ id }) => id === value.id);
          return canonicalDiscoQualification(value, qualityEnriched ? {
            centralQualityCriterionObservations: centralQualityObservations(
              value,
              qualityPlan.playlistQualityPolicy!,
              value.id === initial[0]!.id ? "fail" : "pass",
            ),
          } : {});
        }),
      },
    });

    expect(unresolvedSeedCounts).toEqual([6, 0, 0]);
    const firstQualifiedExpansion = strategyKinds.indexOf("qualified_expansion");
    const firstBroadEditorial = strategyKinds.indexOf("editorial_tracks");
    expect(firstQualifiedExpansion).toBeGreaterThan(
      strategyKinds.indexOf("trusted_containers"),
    );
    expect(firstBroadEditorial === -1
      || firstQualifiedExpansion < firstBroadEditorial).toBe(true);
    expect(result.outcome).toMatchObject({
      status: "exact_ready",
      selectedTrackCount: 6,
      reserveTrackCount: 1,
      shortfall: 0,
    });
    expect(result.selected).not.toContainEqual(expect.objectContaining({
      candidateId: initial[0]!.id,
    }));
    expect(result.selected).toContainEqual(expect.objectContaining({
      candidateId: replacements[0]!.id,
    }));
  });

  test("continues a productive trusted container when known quality failures create an identity deficit", async () => {
    const base = canonicalDiscoPlan(5);
    const qualityPlan: SelectionPlanV3 = {
      ...base,
      playlistQualityPolicy: {
        policyVersion: "canonical_central_quality_v1",
        clauseIds: ["quality:smooth"],
        criteria: ["smooth"],
        minimumPassRatio: 0.8,
        maximumUnknownRatio: 0.2,
        zeroKnownFailures: true,
        signalDimension: "central_quality",
        passThreshold: 0.75,
        failThreshold: 0.4,
        signalSemantics: "ranking_only_not_factual_evidence",
      },
    };
    const initial = Array.from({ length: 5 }, (_, index) => candidate(index));
    const replacements = Array.from(
      { length: 3 },
      (_, index) => candidate(index + initial.length),
    );
    const strategyKinds: string[] = [];
    let trustedRound = 0;

    await executeRetrievalV3({
      runId: "quality-known-failure-continues-trusted-container",
      plan: qualityPlan,
      policy: {
        maximumRawCandidates: 20,
        maximumGlobalRounds: 20,
        maximumConcurrentDiscovery: 1,
        qualifiedPoolGoal: 5,
      },
      adapters: {
        discover: async (request) => {
          strategyKinds.push(request.strategy.kind);
          if (request.strategy.kind === "trusted_containers") {
            trustedRound += 1;
            return trustedRound === 1
              ? {
                  candidates: initial,
                  nextCursor: "trusted-page-2",
                  exhausted: false,
                }
              : {
                  candidates: replacements,
                  nextCursor: null,
                  exhausted: true,
                };
          }
          return { candidates: [], nextCursor: null, exhausted: true };
        },
        qualify: async ({ candidates: values }) => values.map((value) => (
          canonicalDiscoQualification(value, {
            centralQualityCriterionObservations: centralQualityObservations(
              value,
              qualityPlan.playlistQualityPolicy!,
              initial.slice(2).some(({ id }) => id === value.id)
                ? "fail"
                : "pass",
            ),
          })
        )),
      },
    });

    const trustedRounds = strategyKinds
      .map((kind, index) => ({ kind, index }))
      .filter(({ kind }) => kind === "trusted_containers");
    expect(trustedRounds).toHaveLength(2);
    const firstQualifiedExpansion = strategyKinds.indexOf(
      "qualified_expansion",
    );
    expect(firstQualifiedExpansion === -1
      || trustedRounds[1]!.index < firstQualifiedExpansion).toBe(true);
  });

  test("does not call a cache-sized qualified pool exact when artist diversity is infeasible", async () => {
    const diversityPlan = canonicalDiscoPlan(3, {
      diversityGoals: {
        minimumDistinctArtists: 3,
        minimumDistinctAlbums: 3,
        minimumDistinctEras: null,
        minimumDistinctScenes: null,
        minimumDistinctGeographies: null,
        maximumTracksPerArtist: 1,
        maximumTracksPerAlbum: 1,
      },
    });
    let delivered = false;
    const result = await executeRetrievalV3({
      runId: "optimizer-cache-diversity",
      plan: diversityPlan,
      adapters: {
        discover: async () => {
          if (delivered) return { candidates: [], nextCursor: null, exhausted: true };
          delivered = true;
          return {
            candidates: Array.from({ length: 3 }, (_, index) => candidate(index, {
              artist: "One Cached Artist",
              album: `Cached Album ${index}`,
              metadata: { cacheHit: true },
            })),
            nextCursor: null,
            exhausted: true,
          };
        },
        qualify: async ({ candidates }) => candidates.map((value, index) => (
          canonicalDiscoQualification(value, {
            playlistOptimizationSignals: {
              familiarityScore: 0.5,
              discoveryScore: 0.5,
              eraKeys: ["2020s"],
              sceneKeys: ["disco"],
              geographyKeys: ["global"],
              chronologyPosition: 2020 + index,
            },
          })
        )),
      },
    });

    expect(result.stages.canonicalUnique).toBe(3);
    expect(result.outcome).toMatchObject({
      status: "needs_decision",
      stopReason: "playlist_optimization_constraints",
      selectedTrackCount: 1,
      shortfall: 2,
      requiresPartialPublicationDecision: true,
    });
    expect(result.playlistOptimization).toMatchObject({
      exact: false,
      evidenceQualifiedCandidateCount: 3,
      distinct: { artists: 1, albums: 1 },
    });
    expect(result.playlistOptimization?.unmetConstraints).toEqual(expect.arrayContaining([
      "exact_count:1/3",
      "minimum_distinct_artists:1/3",
      "minimum_distinct_albums:1/3",
    ]));
    expect(result.publicationBoundary.manifestDisposition).toBe("no_manifest");
    expect(validateCanonicalPublicationSetV3({
      plan: diversityPlan,
      tracks: result.selected,
      partialPublicationAuthorized: true,
    })).toMatchObject({ valid: false });
  });

  test("does not misclassify an empty canonical pool as optimizer infeasibility", async () => {
    const selection = canonicalDiscoPlan(5);
    let delivered = false;
    const result = await executeRetrievalV3({
      runId: "canonical-zero-qualified-is-not-optimizer",
      plan: selection,
      adapters: {
        discover: async () => {
          if (delivered) return { candidates: [], nextCursor: null, exhausted: true };
          delivered = true;
          return {
            candidates: Array.from({ length: 10 }, (_, index) => candidate(index)),
            nextCursor: null,
            exhausted: true,
          };
        },
        qualify: async ({ candidates }) => candidates.map((value) => {
          const base = canonicalDiscoQualification(value);
          return {
            ...base,
            canonicalClauseAssessments: {
              "genre:disco": { status: "unknown" as const },
            },
          };
        }),
      },
    });

    expect(result.qualifiedPool).toHaveLength(0);
    expect(result.playlistOptimization?.unmetConstraints).toEqual(["exact_count:0/5"]);
    expect(result.outcome).toMatchObject({
      status: "no_compatible_tracks",
      selectedTrackCount: 0,
      shortfall: 5,
    });
    expect(result.outcome.stopReason).not.toBe("playlist_optimization_constraints");
  });

  test("cannot spoof fifty unattributed discovery candidates into live provenance", async () => {
    const selection = canonicalDiscoPlan(50);
    let targetStrategyId: string | null = null;
    let emitted = 0;
    const result = await executeRetrievalV3({
      runId: "optimizer-provenance-spoof-50",
      plan: selection,
      adapters: {
        discover: async ({ strategy, requestedRawCandidateCount }) => {
          if (!strategy.discoveryDependencyIds.includes("hosted_web")) {
            return { candidates: [], nextCursor: null, exhausted: true };
          }
          targetStrategyId ??= strategy.id;
          if (strategy.id !== targetStrategyId || emitted >= 50) {
            return { candidates: [], nextCursor: null, exhausted: true };
          }
          const count = Math.min(50 - emitted, requestedRawCandidateCount);
          const candidates = Array.from({ length: count }, (_, index) => {
            const ordinal = emitted + index;
            return candidate(ordinal, {
              // Provider/candidate metadata is untrusted and must not be able
              // to claim a live origin or manufacture independent sources.
              metadata: {
                cacheOrigin: "live",
                provenanceRoots: [`spoof-${ordinal}.example.test`],
              },
            });
          });
          emitted += count;
          return {
            candidates,
            nextCursor: emitted < 50 ? `cursor-${emitted}` : null,
            exhausted: emitted >= 50,
            // Intentionally omit the server-adapter-owned provenance field.
          };
        },
        qualify: async ({ candidates }) => candidates.map((value) => (
          canonicalDiscoQualification(value)
        )),
      },
      policy: { maximumGlobalRounds: 20 },
    });

    expect(result.qualifiedPool).toHaveLength(50);
    expect(result.qualifiedPool.every(({ cacheOrigin }) => cacheOrigin === "unknown"))
      .toBe(true);
    expect(result.outcome).toMatchObject({
      status: "partial_ready",
      stopReason: "frontier_exhausted",
      requiresPartialPublicationDecision: true,
    });
    expect(result.selected.length).toBeLessThanOrEqual(25);
    expect(result.selected).not.toHaveLength(50);
  });

  test("does not turn shared live provenance into an accidental playlist count cap", async () => {
    const selection = canonicalDiscoPlan(50);
    let delivered = false;
    const result = await executeRetrievalV3({
      runId: "optimizer-empty-provenance-source-cap",
      plan: selection,
      adapters: {
        discover: async () => {
          if (delivered) return { candidates: [], nextCursor: null, exhausted: true };
          delivered = true;
          return {
            candidates: Array.from({ length: 50 }, (_, index) => candidate(index)),
            nextCursor: null,
            exhausted: true,
            provenance: {
              cacheOrigin: "live",
              sourceFreshUntil: null,
            },
          };
        },
        qualify: async ({ candidates }) => candidates.map((value) => {
          const qualified = canonicalDiscoQualification(value, {
            evidence: {
              passed: true,
              bindingIds: [],
              strength: 1,
              independentProvenanceRoots: 0,
              bindings: [],
            },
          });
          return {
            ...qualified,
            canonicalClauseAssessments: {
              "genre:disco": {
                status: "pass",
                evidenceGrade: "authoritative_structured_metadata",
                evidenceIds: [],
              },
            },
          };
        }),
      },
    });

    expect(result.qualifiedPool).toHaveLength(50);
    expect(result.qualifiedPool.every(({ provenanceRoots }) => (
      provenanceRoots?.length === 0
    ))).toBe(true);
    expect(result.outcome).toMatchObject({
      status: "exact_ready",
      selectedTrackCount: 50,
      shortfall: 0,
    });
    expect(result.playlistOptimization).toMatchObject({
      exact: true,
      evidenceQualifiedCandidateCount: 50,
    });
  });

  test("replaces a homogeneous cache prefix with lower-ranked qualified diversity", async () => {
    const diversityPlan = canonicalDiscoPlan(3, {
      diversityGoals: {
        minimumDistinctArtists: 3,
        minimumDistinctAlbums: 3,
        minimumDistinctEras: null,
        minimumDistinctScenes: null,
        minimumDistinctGeographies: null,
        maximumTracksPerArtist: 1,
        maximumTracksPerAlbum: 1,
      },
    });
    const candidates = [
      ...Array.from({ length: 3 }, (_, index) => candidate(index, {
        artist: "Cached Headliner",
        album: `Headliner Album ${index}`,
        metadata: { cacheHit: true },
      })),
      candidate(3, { artist: "Artist B", album: "Album B" }),
      candidate(4, { artist: "Artist C", album: "Album C" }),
      candidate(5, { artist: "Artist D", album: "Album D" }),
    ];
    let delivered = false;
    const result = await executeRetrievalV3({
      runId: "optimizer-cache-repair",
      plan: diversityPlan,
      adapters: {
        discover: async () => {
          if (delivered) return { candidates: [], nextCursor: null, exhausted: true };
          delivered = true;
          return { candidates, nextCursor: null, exhausted: true };
        },
        qualify: async ({ candidates: values }) => values.map((value, index) => (
          canonicalDiscoQualification(value, {
            rankingSignals: { relevance: index < 3 ? 0.99 : 0.7 },
          })
        )),
      },
    });

    expect(result.outcome).toMatchObject({
      status: "exact_ready",
      selectedTrackCount: 3,
      shortfall: 0,
    });
    expect(new Set(result.selected.map(({ artist }) => artist)).size).toBe(3);
    expect(result.playlistOptimization).toMatchObject({
      exact: true,
      evidenceQualifiedCandidateCount: 6,
      distinct: { artists: 3, albums: 3 },
    });
    expect(validateCanonicalPublicationSetV3({
      plan: diversityPlan,
      tracks: result.selected,
    })).toEqual({ valid: true, reasonCodes: [] });
  });

  test.each([
    {
      label: "fixed-container",
      scopeKind: "fixed_release_container" as const,
      intents: ["genre_scene"] as const,
      routingHints: { fixedContainer: true },
    },
    {
      label: "artist-catalogue",
      scopeKind: "artist_catalogue" as const,
      intents: ["artist_catalogue"] as const,
      routingHints: undefined,
    },
    {
      label: "factual",
      scopeKind: "factual_frontier" as const,
      intents: ["factual_relationship"] as const,
      routingHints: undefined,
    },
    {
      label: "exhaustive",
      scopeKind: "factual_frontier" as const,
      intents: ["exhaustive"] as const,
      routingHints: undefined,
    },
  ])("enforces immutable diversity for $label canonical runs", async ({
    label,
    scopeKind,
    intents,
    routingHints,
  }) => {
    const diversityPlan = canonicalDiscoPlan(3, {
      scopeKind,
      intents,
      diversityGoals: {
        minimumDistinctArtists: 3,
        minimumDistinctAlbums: 3,
        minimumDistinctEras: null,
        minimumDistinctScenes: null,
        minimumDistinctGeographies: null,
        maximumTracksPerArtist: 1,
        maximumTracksPerAlbum: 1,
      },
    });
    const values = [
      ...Array.from({ length: 3 }, (_, index) => candidate(index, {
        artist: "High Rank Artist",
        album: `High Rank Album ${index}`,
      })),
      candidate(3, { artist: "Diverse Artist B", album: "Diverse Album B" }),
      candidate(4, { artist: "Diverse Artist C", album: "Diverse Album C" }),
      candidate(5, { artist: "Diverse Artist D", album: "Diverse Album D" }),
    ];
    let delivered = false;
    const result = await executeRetrievalV3({
      runId: `optimizer-non-broad-${label}`,
      plan: diversityPlan,
      routingHints,
      adapters: {
        discover: async () => {
          if (delivered) return { candidates: [], nextCursor: null, exhausted: true };
          delivered = true;
          return {
            candidates: values,
            nextCursor: null,
            exhausted: true,
            provenance: {
              cacheOrigin: "governed_snapshot",
              dependencyIds: ["one-authoritative-source"],
              provenanceRoots: ["one-authoritative-source.example"],
              sourceFreshUntil: null,
            },
          };
        },
        qualify: async ({ candidates: candidatesToQualify }) => (
          candidatesToQualify.map((value, index) => canonicalDiscoQualification(value, {
            rankingSignals: { relevance: index < 3 ? 0.99 : 0.7 },
            sourceRank: index,
          }))
        ),
      },
    });

    expect(result.outcome).toMatchObject({
      status: "exact_ready",
      selectedTrackCount: 3,
      shortfall: 0,
    });
    expect(new Set(result.selected.map(({ artist }) => artist)).size).toBe(3);
    expect(result.playlistOptimization).toMatchObject({
      exact: true,
      evidenceQualifiedCandidateCount: 6,
      distinct: { artists: 3, albums: 3 },
    });
  });

  test.each([
    ["fixed-container", "fixed_release_container", ["genre_scene"], { fixedContainer: true }],
    ["artist-catalogue", "artist_catalogue", ["artist_catalogue"], undefined],
    ["factual", "factual_frontier", ["factual_relationship"], undefined],
    ["exhaustive", "factual_frontier", ["exhaustive"], undefined],
  ] as const)("returns an explicit diversity decision for infeasible %s canonical runs", async (
    label,
    scopeKind,
    intents,
    routingHints,
  ) => {
    const diversityPlan = canonicalDiscoPlan(3, {
      scopeKind,
      intents,
      diversityGoals: {
        minimumDistinctArtists: 3,
        minimumDistinctAlbums: null,
        minimumDistinctEras: null,
        minimumDistinctScenes: null,
        minimumDistinctGeographies: null,
        maximumTracksPerArtist: 1,
        maximumTracksPerAlbum: null,
      },
    });
    let delivered = false;
    const result = await executeRetrievalV3({
      runId: `optimizer-non-broad-infeasible-${label}`,
      plan: diversityPlan,
      ...(routingHints ? { routingHints } : {}),
      adapters: {
        discover: async () => {
          if (delivered) return { candidates: [], nextCursor: null, exhausted: true };
          delivered = true;
          return {
            candidates: Array.from({ length: 3 }, (_, index) => candidate(index, {
              artist: "One Artist",
              album: `Album ${index}`,
            })),
            nextCursor: null,
            exhausted: true,
            provenance: {
              cacheOrigin: "governed_snapshot",
              dependencyIds: ["one-authoritative-source"],
              provenanceRoots: ["one-authoritative-source.example"],
              sourceFreshUntil: null,
            },
          };
        },
        qualify: async ({ candidates: candidatesToQualify }) => (
          candidatesToQualify.map((value, index) => canonicalDiscoQualification(value, {
            sourceRank: index,
          }))
        ),
      },
    });

    expect(result.outcome).toMatchObject({
      status: "needs_decision",
      stopReason: "playlist_optimization_constraints",
      selectedTrackCount: 1,
      shortfall: 2,
      requiresPartialPublicationDecision: true,
    });
    expect(result.playlistOptimization?.unmetConstraints).toEqual(
      expect.arrayContaining(["minimum_distinct_artists:1/3"]),
    );
    expect(result.publicationBoundary.manifestDisposition).toBe("no_manifest");
  });

  test("does not call evidence-qualified exact count success when central quality misses its floor", async () => {
    const qualityPlan = canonicalDiscoPlan(5, {
      playlistQualityPolicy: {
        policyVersion: "canonical_central_quality_v1",
        clauseIds: ["quality:smooth"],
        criteria: ["smooth"],
        minimumPassRatio: 0.8,
        maximumUnknownRatio: 0.2,
        zeroKnownFailures: true,
        signalDimension: "central_quality",
        passThreshold: 0.75,
        failThreshold: 0.4,
        signalSemantics: "ranking_only_not_factual_evidence",
      },
    });
    let delivered = false;
    const result = await executeRetrievalV3({
      runId: "optimizer-central-quality-floor",
      plan: qualityPlan,
      adapters: {
        discover: async () => {
          if (delivered) return { candidates: [], nextCursor: null, exhausted: true };
          delivered = true;
          return {
            candidates: Array.from({ length: 5 }, (_, index) => candidate(index)),
            nextCursor: null,
            exhausted: true,
          };
        },
        qualify: async ({ candidates }) => candidates.map((value, index) => (
          canonicalDiscoQualification(value, {
            centralQualityCriterionObservations: centralQualityObservations(
              value,
              qualityPlan.playlistQualityPolicy!,
              index < 4 ? "pass" : "fail",
            ),
            rankingSignals: {
              relevance: 0.9,
              central_quality: index < 4 ? 0.9 : 0.2,
            },
          })
        )),
      },
    });

    expect(result.stages.canonicalUnique).toBe(5);
    expect(result.outcome).toMatchObject({
      status: "partial_ready",
      stopReason: "central_quality_floor",
      selectedTrackCount: 4,
      shortfall: 1,
      requiresPartialPublicationDecision: true,
    });
    expect(result.playlistOptimization).toMatchObject({
      exact: false,
      evidenceQualifiedCandidateCount: 4,
    });
    expect(result.playlistOptimization?.unmetConstraints).toContain("exact_count:4/5");
    expect(result.selected).toHaveLength(4);
    expect(result.publicationBoundary.manifestDisposition).toBe("partial_confirmation_required");
  });

  test("keeps a lower-ranked quality-unknown track when it is required for an exact canonical quota", async () => {
    const qualityQuotaPlan = canonicalDiscoPlan(5, {
      playlistQualityPolicy: {
        policyVersion: "canonical_central_quality_v1",
        clauseIds: ["quality:smooth"],
        criteria: ["smooth"],
        minimumPassRatio: 0.8,
        maximumUnknownRatio: 0.2,
        zeroKnownFailures: true,
        signalDimension: "central_quality",
        passThreshold: 0.75,
        failThreshold: 0.4,
        signalSemantics: "ranking_only_not_factual_evidence",
      },
      playlistQuotaRules: [{
        id: "quota:rare",
        clauseId: "quota:rare",
        axis: "genre",
        values: ["rare"],
        minimumCount: 1,
        maximumCount: null,
        minimumRatio: null,
        maximumRatio: null,
        evidenceGrade: "authoritative_structured_metadata",
      }],
    });
    let delivered = false;
    const result = await executeRetrievalV3({
      runId: "quality-quota-joint-optimization",
      plan: qualityQuotaPlan,
      adapters: {
        discover: async () => {
          if (delivered) return { candidates: [], nextCursor: null, exhausted: true };
          delivered = true;
          return {
            candidates: Array.from({ length: 16 }, (_, index) => candidate(index)),
            nextCursor: null,
            exhausted: true,
          };
        },
        qualify: async ({ candidates }) => candidates.map((value, index) => (
          canonicalDiscoQualification(value, {
            centralQualityCriterionObservations: centralQualityObservations(
              value,
              qualityQuotaPlan.playlistQualityPolicy!,
              index === 15 ? "unknown" : "pass",
            ),
            catalog: {
              storefrontPlayable: true,
              appleSongId: `apple-${value.id}`,
              recordingFamilyKey: `family-${value.id}`,
              confidence: 0.98,
              genreNames: [index === 15 ? "Rare" : "Common"],
            },
            rankingSignals: {
              relevance: 1 - index * 0.01,
              central_quality: index === 15 ? 0.6 : 0.9,
            },
          })
        )),
      },
      policy: {
        qualifiedPoolGoal: 15,
        maximumGlobalRounds: 1,
      },
    });

    expect(result.outcome).toMatchObject({
      status: "exact_ready",
      selectedTrackCount: 5,
      shortfall: 0,
    });
    expect(result.selected.some(({ catalogGenreNames }) => (
      catalogGenreNames?.includes("Rare")
    ))).toBe(true);
    expect(result.centralQuality).toMatchObject({
      passed: true,
      passCount: 4,
      failCount: 0,
      unknownCount: 1,
    });
    expect(result.playlistOptimization).toMatchObject({ exact: true });
  });

  test("does not reinterpret playlist quota ratios against replacement reserve inventory", async () => {
    const quotaPlan = canonicalDiscoPlan(2, {
      playlistQuotaRules: [{
        id: "quota:rare",
        clauseId: "quota:rare",
        axis: "genre",
        values: ["rare"],
        minimumCount: null,
        maximumCount: 1,
        minimumRatio: 0.5,
        maximumRatio: null,
        evidenceGrade: "authoritative_structured_metadata",
      }],
    });
    const values = Array.from({ length: 12 }, (_, index) => candidate(index));
    let delivered = false;
    const result = await executeRetrievalV3({
      runId: "quota-ratio-reserve-capacity",
      plan: quotaPlan,
      adapters: {
        discover: async () => {
          if (delivered) return { candidates: [], nextCursor: null, exhausted: true };
          delivered = true;
          return { candidates: values, nextCursor: null, exhausted: true };
        },
        qualify: async ({ candidates }) => candidates.map((value, index) => (
          canonicalDiscoQualification(value, {
            catalog: {
              storefrontPlayable: true,
              appleSongId: `apple-${value.id}`,
              recordingFamilyKey: `family-${value.id}`,
              confidence: 0.98,
              genreNames: [index === 0 ? "Rare" : "Common"],
            },
          })
        )),
      },
      policy: {
        qualifiedPoolGoal: 12,
        maximumGlobalRounds: 1,
      },
    });

    expect(result.outcome).toMatchObject({
      status: "exact_ready",
      selectedTrackCount: 2,
      reserveTrackCount: 10,
      shortfall: 0,
    });
    expect(result.selected.filter(({ catalogGenreNames = [] }) => (
      catalogGenreNames.includes("Rare")
    ))).toHaveLength(1);
    expect(result.playlistOptimization).toMatchObject({ exact: true });
  });

  test("solves canonical quotas and artist diversity in one bounded search", async () => {
    const jointPlan = canonicalDiscoPlan(2, {
      diversityGoals: {
        minimumDistinctArtists: 2,
        minimumDistinctAlbums: null,
        minimumDistinctEras: null,
        minimumDistinctScenes: null,
        minimumDistinctGeographies: null,
        maximumTracksPerArtist: 1,
        maximumTracksPerAlbum: null,
      },
      playlistQuotaRules: [{
        id: "quota:rare",
        clauseId: "quota:rare",
        axis: "genre",
        values: ["rare"],
        minimumCount: 1,
        maximumCount: null,
        minimumRatio: null,
        maximumRatio: null,
        evidenceGrade: "authoritative_structured_metadata",
      }],
    });
    const values = [
      candidate(0, { artist: "Artist A" }),
      candidate(1, { artist: "Artist B" }),
      candidate(2, { artist: "Artist A" }),
      candidate(3, { artist: "Artist C" }),
    ];
    let delivered = false;
    const result = await executeRetrievalV3({
      runId: "quota-diversity-joint-optimization",
      plan: jointPlan,
      adapters: {
        discover: async () => {
          if (delivered) return { candidates: [], nextCursor: null, exhausted: true };
          delivered = true;
          return { candidates: values, nextCursor: null, exhausted: true };
        },
        qualify: async ({ candidates }) => candidates.map((value, index) => (
          canonicalDiscoQualification(value, {
            catalog: {
              storefrontPlayable: true,
              appleSongId: `apple-${value.id}`,
              recordingFamilyKey: `family-${value.id}`,
              confidence: 0.98,
              genreNames: [index >= 2 ? "Rare" : "Common"],
            },
            rankingSignals: { relevance: 1 - index * 0.01 },
          })
        )),
      },
      policy: { maximumGlobalRounds: 1 },
    });

    expect(result.outcome).toMatchObject({
      status: "exact_ready",
      selectedTrackCount: 2,
      shortfall: 0,
    });
    expect(new Set(result.selected.map(({ artist }) => artist)).size).toBe(2);
    expect(result.selected.some(({ catalogGenreNames = [] }) => (
      catalogGenreNames.includes("Rare")
    ))).toBe(true);
    expect(result.playlistOptimization).toMatchObject({ exact: true });
  });

  test("keeps a lower-ranked recording representation when it alone satisfies the joint contract", async () => {
    const alternatePlan = canonicalDiscoPlan(2, {
      playlistQuotaRules: [{
        id: "quota:rare",
        clauseId: "quota:rare",
        axis: "genre",
        values: ["rare"],
        minimumCount: 1,
        maximumCount: null,
        minimumRatio: null,
        maximumRatio: null,
        evidenceGrade: "authoritative_structured_metadata",
      }],
    });
    const values = [
      candidate(0, { artist: "Artist A", title: "Recording A", album: "Primary Edition" }),
      candidate(1, { artist: "Artist A", title: "Recording A", album: "Alternate Edition" }),
      candidate(2, { artist: "Artist B", title: "Recording B" }),
    ];
    let delivered = false;
    const result = await executeRetrievalV3({
      runId: "quota-recording-representation-joint-optimization",
      plan: alternatePlan,
      adapters: {
        discover: async () => {
          if (delivered) return { candidates: [], nextCursor: null, exhausted: true };
          delivered = true;
          return { candidates: values, nextCursor: null, exhausted: true };
        },
        qualify: async ({ candidates }) => candidates.map((value, index) => (
          canonicalDiscoQualification(value, {
            catalog: {
              storefrontPlayable: true,
              appleSongId: `apple-${value.id}`,
              recordingFamilyKey: index < 2 ? "family-recording-a" : "family-recording-b",
              confidence: 0.98,
              genreNames: [index === 1 ? "Rare" : "Common"],
            },
            rankingSignals: { relevance: index === 0 ? 1 : index === 2 ? 0.9 : 0.8 },
          })
        )),
      },
      policy: { maximumGlobalRounds: 1 },
    });

    expect(result.outcome).toMatchObject({
      status: "exact_ready",
      selectedTrackCount: 2,
      shortfall: 0,
    });
    expect(result.selected.map(({ candidateId }) => candidateId).sort()).toEqual([
      "candidate-1",
      "candidate-2",
    ]);
    expect(result.compatibleAlternatesByRecordingFamily["family-recording-a"]?.map(
      ({ candidateId }) => candidateId,
    )).toContain("candidate-0");
  });

  test("retries optimizer compute from the fenced qualified pool without another provider call", async () => {
    const retryPlan = canonicalDiscoPlan(2);
    const discover = vi.fn(async () => ({
      candidates: [candidate(0), candidate(1)],
      nextCursor: null,
      exhausted: true,
    }));
    const qualify = vi.fn(async ({ candidates }: { candidates: readonly RawTrackCandidateV3[] }) => (
      candidates.map((value) => canonicalDiscoQualification(value))
    ));

    let failure: RetrievalPlaylistOptimizationBudgetExceededErrorV3 | null = null;
    try {
      await withPlaylistOptimizationBudgetV1({
        maximumHeuristicWorkUnits: 1,
        maximumExactNodes: 1,
        maximumExactWorkUnits: 1,
      }, () => executeRetrievalV3({
        runId: "optimizer-compute-retry-seed",
        plan: retryPlan,
        adapters: { discover, qualify },
        policy: { maximumGlobalRounds: 1 },
      }));
    } catch (error) {
      expect(error).toBeInstanceOf(
        RetrievalPlaylistOptimizationBudgetExceededErrorV3,
      );
      failure = error as RetrievalPlaylistOptimizationBudgetExceededErrorV3;
    }

    expect(failure?.retrySeed).toMatchObject({
      providerCallPermitted: false,
      approvedStrategyIds: [],
    });
    expect(failure?.retrySeed.qualifiedTracks).toHaveLength(2);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(qualify).toHaveBeenCalledTimes(1);

    const result = await withPlaylistOptimizationBudgetV1(
      playlistOptimizationBudgetForPassV1(2),
      () => executeRetrievalV3({
        runId: "optimizer-compute-retry-seed",
        plan: retryPlan,
        continuation: failure!.retrySeed,
        adapters: {
          discover: vi.fn(async () => {
            throw new Error("provider_discovery_must_not_run_on_compute_retry");
          }),
          qualify: vi.fn(async () => {
            throw new Error("provider_qualification_must_not_run_on_compute_retry");
          }),
        },
        policy: { maximumGlobalRounds: 1 },
      }),
    );

    expect(result.outcome).toMatchObject({
      status: "exact_ready",
      selectedTrackCount: 2,
    });
  });

  test("raises the next raw discovery goal from observed post-filter yield", async () => {
    let next = 0;
    let batchNumber = 0;
    const requestedGoals: number[] = [];
    const adapters: RetrievalAdaptersV3 = {
      discover: async ({ requestedRawCandidateCount }) => {
        requestedGoals.push(requestedRawCandidateCount);
        batchNumber += 1;
        const count = batchNumber === 1 ? 20 : 30;
        return {
          candidates: Array.from({ length: count }, () => candidate(next++)),
          nextCursor: null,
          exhausted: true,
        };
      },
      qualify: async ({ candidates }) => candidates.map((value, index) => qualification(value, {
        scope: batchNumber === 1 && index >= 10
          ? { passed: false, failedMembershipPredicateIds: ["scope"], fit: 0 }
          : { passed: true, failedMembershipPredicateIds: [], fit: 0.9 },
      })),
    };

    const result = await executeRetrievalV3({
      runId: "yield-run",
      plan: plan("25 disco tracks", 25),
      adapters,
      // This assertion isolates the adaptive controller. Portfolio
      // concurrency is covered independently below.
      policy: { maximumConcurrentDiscovery: 1 },
    });

    expect(result.outcome.status).toBe("exact_ready");
    expect(requestedGoals.length).toBeGreaterThanOrEqual(2);
    expect(requestedGoals[1]!).toBeGreaterThan(requestedGoals[0]!);
    expect(result.deficit.discardedByReason.scope_membership_failed).toBe(10);
  });

  test("keeps ranking signals downstream of hard membership and evidence eligibility", async () => {
    let emitted = false;
    const adapters: RetrievalAdaptersV3 = {
      discover: async () => {
        if (emitted) return { candidates: [], nextCursor: null, exhausted: true };
        emitted = true;
        return {
          candidates: [candidate(1), candidate(2), candidate(3)],
          nextCursor: null,
          exhausted: true,
        };
      },
      qualify: async ({ candidates }) => candidates.map((value, index) => {
        if (index === 0) {
          return qualification(value, {
            rankingSignals: { influence: 0 },
          });
        }
        if (index === 1) {
          return qualification(value, {
            scope: { passed: false, failedMembershipPredicateIds: ["genre:disco"], fit: 1 },
            rankingSignals: { influence: 1 },
          });
        }
        return qualification(value, {
          hardConstraints: { passed: false, failedConstraintIds: ["exclude:reference_artist" ] },
          rankingSignals: { influence: 1 },
        });
      }),
    };

    const result = await executeRetrievalV3({
      runId: "hard-before-ranking",
      plan: plan("25 influential disco tracks", 25),
      adapters,
    });

    expect(result.qualifiedPool.map(({ candidateId }) => candidateId)).toEqual(["candidate-1"]);
    expect(result.deficit.discardedByReason).toMatchObject({
      scope_membership_failed: 1,
      hard_constraint_failed: 1,
    });
    expect(result.outcome.status).toBe("partial_ready");
  });

  test.each([
    {
      label: "binding ids without provider attestation",
      patch: (value: RawTrackCandidateV3) => ({
        evidence: {
          ...qualification(value).evidence,
          bindings: undefined,
        },
      }),
    },
    {
      label: "a URL-less binding",
      patch: (value: RawTrackCandidateV3) => {
        const evidence = qualification(value).evidence;
        return {
          evidence: {
            ...evidence,
            bindings: evidence.bindings?.map((binding) => ({ ...binding, url: null })),
          },
        };
      },
    },
    {
      label: "an HTTPS binding without an eligibility attestation",
      patch: (value: RawTrackCandidateV3) => {
        const evidence = qualification(value).evidence;
        return {
          evidence: {
            ...evidence,
            bindings: evidence.bindings?.map(({ eligibilityAttestation, ...binding }) => {
              void eligibilityAttestation;
              return binding;
            }),
          },
        };
      },
    },
  ])("fails closed for $label", async ({ patch }) => {
    const value = candidate(901);
    let emitted = false;
    const result = await executeRetrievalV3({
      runId: `unattested-${value.id}`,
      plan: plan("one evidence-bound track", 1),
      adapters: {
        discover: async () => {
          if (emitted) return { candidates: [], nextCursor: null, exhausted: true };
          emitted = true;
          return { candidates: [value], nextCursor: null, exhausted: true };
        },
        qualify: async () => [qualification(value, patch(value))],
      },
    });

    expect(result.selected).toEqual([]);
    expect(result.qualifiedPool).toEqual([]);
    expect(result.deficit.discardedByReason.evidence_attestation_missing).toBe(1);
    expect(result.publicationBoundary.manifestDisposition).toBe("no_manifest");
  });

  test("turns a bounded shortfall into partial_ready and never silently authorizes Apple writes", async () => {
    let emitted = false;
    const adapters: RetrievalAdaptersV3 = {
      discover: async () => {
        if (emitted) return { candidates: [], nextCursor: null, exhausted: true };
        emitted = true;
        return {
          candidates: [candidate(1), candidate(2), candidate(3)],
          nextCursor: null,
          exhausted: true,
        };
      },
      qualify: async ({ candidates }) => candidates.map((value) => qualification(value)),
    };
    const result = await executeRetrievalV3({
      runId: "partial-run",
      plan: plan("50 American drill tracks", 50),
      adapters,
    });

    expect(result.outcome).toMatchObject({
      status: "partial_ready",
      stopReason: "frontier_exhausted",
      selectedTrackCount: 3,
      shortfall: 47,
      requiresPartialPublicationDecision: true,
    });
    expect(result.publicationBoundary).toEqual({
      appleWriteAccess: "forbidden",
      manifestDisposition: "partial_confirmation_required",
    });
    expect(result.deficit.primaryShortfallReason).toBe("frontier_exhausted");
  });

  test("returns a completed zero-result outcome rather than a system failure", async () => {
    const adapters: RetrievalAdaptersV3 = {
      discover: async () => ({ candidates: [], nextCursor: null, exhausted: true }),
      qualify: async () => [],
    };
    const result = await executeRetrievalV3({
      runId: "empty-run",
      plan: plan("an intentionally narrow scene", 25),
      adapters,
    });
    expect(result.outcome).toMatchObject({
      status: "no_compatible_tracks",
      selectedTrackCount: 0,
      requiresPartialPublicationDecision: false,
    });
    expect(result.publicationBoundary.manifestDisposition).toBe("no_manifest");
  });

  test("retains compatible alternate Apple IDs while counting one recording family", async () => {
    let emitted = false;
    const adapters: RetrievalAdaptersV3 = {
      discover: async () => {
        if (emitted) return { candidates: [], nextCursor: null, exhausted: true };
        emitted = true;
        return {
          candidates: [candidate(1), candidate(2)],
          nextCursor: null,
          exhausted: true,
        };
      },
      qualify: async ({ candidates }) => candidates.map((value, index) => qualification(value, {
        catalog: {
          storefrontPlayable: true,
          appleSongId: `alternate-${index}`,
          recordingFamilyKey: "shared-family",
          confidence: index === 0 ? 0.9 : 0.95,
        },
      })),
    };
    const result = await executeRetrievalV3({
      runId: "alternate-run",
      plan: plan("a fixed recording family", 5),
      adapters,
    });

    expect(result.qualifiedPool).toHaveLength(1);
    expect(result.compatibleAlternatesByRecordingFamily["shared-family"]).toHaveLength(1);
    expect(result.deficit.discardedByReason.duplicate_recording_family).toBe(1);
    expect(result.stages.canonicalUnique).toBe(1);
  });

  test("merges repeated recording evidence across rounds and treats stronger evidence as yield", async () => {
    const selection = plan("one disco track", 1);
    const targetStrategy = "curated_genre_scene:trusted_scoped_containers";
    const roundsByStrategy = new Map<string, number>();
    const qualificationObservations: string[][] = [];
    const adapters: RetrievalAdaptersV3 = {
      discover: async ({ strategy }) => {
        const round = (roundsByStrategy.get(strategy.id) ?? 0) + 1;
        roundsByStrategy.set(strategy.id, round);
        if (strategy.id !== targetStrategy) {
          return { candidates: [], nextCursor: null, exhausted: true };
        }
        return {
          candidates: [candidate(round, {
            id: `round-${round}`,
            title: "Shared Recording",
            artist: "One Artist",
            album: "One Album",
            sourceObservationIds: [`observation-${round}`],
          })],
          nextCursor: null,
          exhausted: false,
        };
      },
      qualify: async ({ candidates }) => candidates.map((value) => {
        qualificationObservations.push([...value.sourceObservationIds]);
        const base = qualification(value);
        const suffix = value.sourceObservationIds.length;
        const binding = base.evidence.bindings![0]!;
        return qualification(value, {
          evidence: {
            ...base.evidence,
            bindingIds: [`binding-${suffix}`],
            bindings: [{
              ...binding,
              id: `binding-${suffix}`,
              provenanceRoot: `source-${suffix}.example.test`,
              strength: suffix === 1 ? 0.81 : 0.95,
            }],
            strength: suffix === 1 ? 0.81 : 0.95,
            independentProvenanceRoots: suffix,
          },
          catalog: {
            storefrontPlayable: true,
            appleSongId: "apple-shared",
            recordingFamilyKey: "family-shared",
            confidence: 0.98,
          },
        });
      }),
    };

    const result = await executeRetrievalV3({
      runId: "evidence-merge",
      plan: selection,
      adapters,
      policy: { maximumGlobalRounds: 4 },
    });

    expect(qualificationObservations).toContainEqual(["observation-1", "observation-2"]);
    expect(result.qualifiedPool).toHaveLength(1);
    expect(result.qualifiedPool[0]).toMatchObject({
      sourceObservationIds: ["observation-1", "observation-2"],
      evidenceBindingIds: ["binding-1", "binding-2"],
      evidenceStrength: 0.95,
      independentProvenanceRoots: 2,
    });
    expect(result.strategies).toContainEqual(expect.objectContaining({
      id: targetStrategy,
      newQualifiedFamilies: 1,
      consecutiveZeroQualifiedYieldRounds: 0,
    }));
  });

  test("qualifies a same-batch cumulative recording only once", async () => {
    const targetStrategy = "curated_genre_scene:trusted_scoped_containers";
    let emitted = false;
    const qualificationObservations: string[][] = [];
    const adapters: RetrievalAdaptersV3 = {
      discover: async ({ strategy }) => {
        if (strategy.id !== targetStrategy || emitted) {
          return { candidates: [], nextCursor: null, exhausted: true };
        }
        emitted = true;
        return {
          candidates: [
            candidate(1, {
              id: "same-batch-recording",
              title: "Shared Recording",
              artist: "One Artist",
              album: "One Album",
              sourceObservationIds: ["observation-1"],
            }),
            candidate(2, {
              id: "same-batch-recording",
              title: "Shared Recording",
              artist: "One Artist",
              album: "One Album",
              sourceObservationIds: ["observation-2"],
            }),
          ],
          nextCursor: null,
          exhausted: true,
        };
      },
      qualify: async ({ candidates }) => candidates.map((value) => {
        qualificationObservations.push([...value.sourceObservationIds]);
        return qualification(value);
      }),
    };

    const result = await executeRetrievalV3({
      runId: "same-batch-cumulative-recording",
      plan: plan("one disco track", 1),
      adapters,
    });

    expect(qualificationObservations).toEqual([
      ["observation-1", "observation-2"],
    ]);
    expect(result.qualifiedPool).toHaveLength(1);
  });

  test("resets zero-yield only when an exact-family issue proves an earlier canonical year", async () => {
    const targetStrategy = "curated_genre_scene:qualified_artist_release_expansion";
    const run = async (releaseYearsByRound: readonly (readonly number[])[]) => {
      let targetRound = 0;
      const adapters: RetrievalAdaptersV3 = {
        discover: async ({ strategy }) => {
          if (strategy.id !== targetStrategy) {
            return { candidates: [], nextCursor: null, exhausted: true };
          }
          targetRound += 1;
          return {
            candidates: [candidate(targetRound, {
              id: `shared-era-recording-${targetRound}`,
              title: "Shared Era Recording",
              artist: "One Artist",
              // Distinct source editions reach qualification, but resolve to
              // the same Apple song and recording family below.
              album: `One Album · issue ${targetRound}`,
              sourceObservationIds: ["shared-observation"],
            })],
            nextCursor: null,
            exhausted: false,
          };
        },
        qualify: async ({ candidates }) => candidates.map((value) => {
          const years = releaseYearsByRound[Math.min(targetRound - 1, releaseYearsByRound.length - 1)]!;
          const base = qualification(value);
          const binding = base.evidence.bindings![0]!;
          return qualification(value, {
            evidence: {
              ...base.evidence,
              bindingIds: ["shared-binding"],
              bindings: [{ ...binding, id: "shared-binding" }],
            },
            catalog: {
              storefrontPlayable: true,
              appleSongId: "apple-shared-era",
              recordingFamilyKey: "family-shared-era",
              confidence: 0.98,
              releaseYear: years[years.length - 1] ?? null,
              compatibleReleaseYears: years,
            },
          });
        }),
      };
      const result = await executeRetrievalV3({
        runId: `canonical-year-${releaseYearsByRound.flat().join("-")}`,
        plan: plan("two disco tracks", 2),
        adapters,
        policy: { maximumGlobalRounds: 100 },
      });
      return result.strategies.find(({ id }) => id === targetStrategy)!;
    };

    const laterCompilationOnly = await run([[1978], [1978, 2004], [1978, 2004], [1978, 2004]]);
    const earlierExactFamilyIssue = await run([[2004], [1978, 2004], [1978, 2004], [1978, 2004]]);

    expect(laterCompilationOnly).toMatchObject({
      rounds: 3,
      consecutiveZeroQualifiedYieldRounds: 2,
      status: "exhausted",
    });
    expect(earlierExactFamilyIssue).toMatchObject({
      rounds: 4,
      consecutiveZeroQualifiedYieldRounds: 2,
      status: "exhausted",
    });
  });

  test("exhausts each strategy after two zero-qualified-yield rounds", async () => {
    const adapters: RetrievalAdaptersV3 = {
      discover: vi.fn(async () => ({ candidates: [], nextCursor: null, exhausted: false })),
      qualify: vi.fn(async () => []),
    };
    const result = await executeRetrievalV3({
      runId: "zero-yield-run",
      plan: plan("disco songs", 25),
      adapters,
      policy: { maximumGlobalRounds: 100 },
    });

    expect(result.outcome.stopReason).toBe("frontier_exhausted");
    expect(result.strategies.every(({ rounds }) => rounds <= 2)).toBe(true);
    expect(result.strategies.every(({ status }) => status === "exhausted")).toBe(true);
    expect(vi.mocked(adapters.discover).mock.calls.length).toBeGreaterThan(1);
    expect(vi.mocked(adapters.discover).mock.calls.length).toBeLessThanOrEqual(result.strategies.length * 2);
  });

  test("runs genuinely independent discovery dependencies concurrently", async () => {
    const active = new Map<string, number>();
    let maximumIndependentCalls = 0;
    const adapters: RetrievalAdaptersV3 = {
      discover: async ({ strategy }) => {
        for (const dependencyId of strategy.discoveryDependencyIds) {
          active.set(dependencyId, (active.get(dependencyId) ?? 0) + 1);
        }
        maximumIndependentCalls = Math.max(
          maximumIndependentCalls,
          [...active.values()].filter((count) => count > 0).length,
        );
        // Yield once so every independently schedulable member of this wave
        // reaches the adapter before any one call completes.
        await Promise.resolve();
        for (const dependencyId of strategy.discoveryDependencyIds) {
          active.set(dependencyId, (active.get(dependencyId) ?? 1) - 1);
        }
        return { candidates: [], nextCursor: null, exhausted: true, costUnits: 0 };
      },
      qualify: async () => [],
    };

    await executeRetrievalV3({
      runId: "independent-portfolio",
      plan: plan("disco songs", 25),
      adapters,
      policy: { maximumConcurrentDiscovery: 4 },
    });

    // The first tier contains local orchestration, Apple catalog, and hosted
    // web work. Apple and hosted web must overlap as independent frontiers.
    expect(maximumIndependentCalls).toBeGreaterThanOrEqual(2);
  });

  test("never overlaps strategies that share any discovery dependency", async () => {
    const active = new Map<string, number>();
    const maximum = new Map<string, number>();
    const adapters: RetrievalAdaptersV3 = {
      discover: async ({ strategy }) => {
        for (const dependencyId of strategy.discoveryDependencyIds) {
          const count = (active.get(dependencyId) ?? 0) + 1;
          active.set(dependencyId, count);
          maximum.set(dependencyId, Math.max(maximum.get(dependencyId) ?? 0, count));
        }
        await Promise.resolve();
        for (const dependencyId of strategy.discoveryDependencyIds) {
          active.set(dependencyId, (active.get(dependencyId) ?? 1) - 1);
        }
        return { candidates: [], nextCursor: null, exhausted: false, costUnits: 0 };
      },
      qualify: async () => [],
    };

    await executeRetrievalV3({
      runId: "shared-dependency-mutex",
      plan: planWithIntents(["genre_scene", "similarity"], 25),
      adapters,
      policy: { maximumConcurrentDiscovery: 16, maximumGlobalRounds: 100 },
    });

    expect([...maximum.entries()]).toEqual(expect.arrayContaining([
      ["hosted_web", 1],
      ["apple_catalog", 1],
    ]));
    expect([...maximum.values()].every((count) => count === 1)).toBe(true);
  });

  test("counts repeated failures from one shared upstream as one contiguous outage", async () => {
    const retryAfterUntil = new Date("2030-01-02T03:04:05.000Z");
    const adapters: RetrievalAdaptersV3 = {
      discover: async ({ strategy }) => {
        if (strategy.discoveryDependencyIds.includes("hosted_web")) {
          throw new RetrievalDependencyErrorV3(
            "hosted search unavailable",
            ["hosted_web"],
            retryAfterUntil,
            "rate_limited",
          );
        }
        return { candidates: [], nextCursor: null, exhausted: true, costUnits: 0 };
      },
      qualify: async () => [],
    };

    const result = await executeRetrievalV3({
      runId: "shared-upstream-outage",
      plan: planWithIntents(["genre_scene", "similarity"], 25),
      adapters,
      policy: {
        maximumConcurrentDiscovery: 8,
        maximumGlobalRounds: 100,
        maximumProviderFailuresPerStrategy: 1,
      },
    });

    const hosted = result.dependencyOutages?.find(({ dependencyId }) => dependencyId === "hosted_web");
    expect(hosted).toMatchObject({
      outageCount: 1,
      active: true,
      circuitOpen: false,
      failureClass: "rate_limited",
      retryAfterUntil: retryAfterUntil.toISOString(),
    });
    expect(hosted!.failureAttempts).toBeGreaterThan(1);
    expect(hosted!.affectedStrategyIds.length).toBeGreaterThan(1);
  });

  test.each(["discovery", "qualification"] as const)(
    "isolates a non-retryable %s provider class as an operational outage instead of aborting the portfolio",
    async (stage) => {
      const failure = new RetrievalDependencyErrorV3(
        "provider quota unavailable",
        [stage === "discovery" ? "hosted_web" : "apple_catalog"],
        null,
        "quota",
      );
      const adapters: RetrievalAdaptersV3 = {
        discover: async () => {
          if (stage === "discovery") throw failure;
          return {
            candidates: [candidate(1)],
            nextCursor: null,
            exhausted: true,
            costUnits: 0,
          };
        },
        qualify: async ({ candidates }) => {
          if (stage === "qualification") throw failure;
          return candidates.map((value) => qualification(value));
        },
      };

      const result = await executeRetrievalV3({
        runId: `non-retryable-${stage}-provider`,
        plan: plan("25 disco songs", 25),
        adapters,
      });

      expect(result.outcome).toMatchObject({
        status: "failed_system",
        stopReason: "provider_failure",
      });
      expect(result.publicationBoundary.manifestDisposition)
        .toBe("blocked_operational_failure");
      if (stage === "discovery") {
        expect(result.dependencyOutages).toContainEqual(expect.objectContaining({
          dependencyId: "hosted_web",
          failureClass: "quota",
          active: true,
        }));
      }
      expect(result.strategies.some((strategy) => (
        strategy.providerFailures > 0
        && strategy.status === "provider_error"
      ))).toBe(true);
    },
  );

  test.each(["discovery", "qualification"] as const)(
    "propagates an untyped %s fault instead of turning it into provider scarcity",
    async (stage) => {
      const fault = new TypeError(`${stage} programmer fault`);
      const adapters: RetrievalAdaptersV3 = {
        discover: async () => {
          if (stage === "discovery") throw fault;
          return {
            candidates: [candidate(1)],
            nextCursor: null,
            exhausted: true,
            costUnits: 0,
          };
        },
        qualify: async ({ candidates }) => {
          if (stage === "qualification") throw fault;
          return candidates.map((value) => qualification(value));
        },
      };

      await expect(executeRetrievalV3({
        runId: `untyped-${stage}-fault`,
        plan: plan("25 disco songs", 25),
        adapters,
      })).rejects.toBe(fault);
    },
  );

  test("does not call an incomplete independent portfolio frontier exhaustion", async () => {
    let emittedAppleCandidate = false;
    const adapters: RetrievalAdaptersV3 = {
      discover: async ({ strategy }) => {
        if (strategy.discoveryDependencyIds.includes("hosted_web")) {
          throw new RetrievalDependencyErrorV3("hosted search unavailable", ["hosted_web"]);
        }
        if (!emittedAppleCandidate && strategy.discoveryDependencyIds.includes("apple_catalog")) {
          emittedAppleCandidate = true;
          return {
            candidates: [candidate(999)],
            nextCursor: null,
            exhausted: true,
            costUnits: 0,
          };
        }
        return { candidates: [], nextCursor: null, exhausted: true, costUnits: 0 };
      },
      qualify: async ({ candidates }) => candidates.map((value) => qualification(value)),
    };

    const result = await executeRetrievalV3({
      runId: "incomplete-frontier",
      plan: plan("25 disco songs", 25),
      adapters,
      policy: {
        // Scope resolution plus one Apple/hosted portfolio wave reaches this
        // generic boundary. The unresolved hosted outage must still win.
        maximumGlobalRounds: 3,
        maximumProviderFailuresPerStrategy: 1,
      },
    });

    expect(result.qualifiedPool).toHaveLength(1);
    expect(result.outcome).toMatchObject({
      status: "failed_system",
      stopReason: "provider_failure",
    });
    expect(result.deficit.primaryShortfallReason).toBe("provider_failure");
    expect(result.publicationBoundary.manifestDisposition).toBe("blocked_operational_failure");
  });

  test("fences pagination cursor loops as integrity failures", async () => {
    const adapters: RetrievalAdaptersV3 = {
      discover: async () => ({ candidates: [], nextCursor: "repeated", exhausted: false }),
      qualify: async () => [],
    };
    const result = await executeRetrievalV3({
      runId: "cursor-loop-run",
      plan: plan("disco songs", 25),
      adapters,
      policy: { maximumGlobalRounds: 100 },
    });

    expect(result.outcome).toMatchObject({
      status: "failed_integrity",
      stopReason: "integrity_failure",
    });
    expect(result.integrityEvents.some((event) => event.startsWith("pagination_cursor_loop:"))).toBe(true);
  });

  test("reports catastrophic provider loss as operational failure, not a catalog shortfall", async () => {
    const adapters: RetrievalAdaptersV3 = {
      discover: async ({ strategy }) => {
        throw new RetrievalDependencyErrorV3(
          "provider unavailable",
          strategy.discoveryDependencyIds,
        );
      },
      qualify: async () => [],
    };
    const result = await executeRetrievalV3({
      runId: "provider-failure-run",
      plan: plan("disco songs", 25),
      adapters,
      policy: { maximumProviderFailuresPerStrategy: 1 },
    });
    expect(result.outcome).toMatchObject({
      status: "failed_system",
      stopReason: "provider_failure",
    });
    expect(result.publicationBoundary.manifestDisposition).toBe("blocked_operational_failure");
  });

  test("does not let synthetic zero-work scope strategies hide provider loss", async () => {
    const adapters: RetrievalAdaptersV3 = {
      discover: async ({ strategy }) => {
        if (strategy.kind === "scope_resolution"
          || strategy.kind === "gap_pass"
          || strategy.kind === "trusted_containers"
          || strategy.kind === "qualified_expansion") {
          return { candidates: [], nextCursor: null, exhausted: true, costUnits: 0 };
        }
        throw new RetrievalDependencyErrorV3(
          "provider unavailable",
          strategy.discoveryDependencyIds,
        );
      },
      qualify: async () => [],
    };
    const result = await executeRetrievalV3({
      runId: "provider-failure-with-synthetic-noops",
      plan: plan("disco songs", 25),
      adapters,
      policy: { maximumProviderFailuresPerStrategy: 1 },
    });

    expect(result.strategies).toContainEqual(expect.objectContaining({
      kind: "scope_resolution",
      status: "exhausted",
      rawCandidates: 0,
      providerFailures: 0,
    }));
    expect(result.strategies).toContainEqual(expect.objectContaining({
      kind: "trusted_containers",
      status: "exhausted",
      rawCandidates: 0,
      providerFailures: 0,
    }));
    expect(result.strategies).toContainEqual(expect.objectContaining({
      kind: "qualified_expansion",
      status: "exhausted",
      rawCandidates: 0,
      providerFailures: 0,
    }));
    expect(result.outcome).toMatchObject({
      status: "failed_system",
      stopReason: "provider_failure",
    });
    expect(result.publicationBoundary.manifestDisposition).toBe("blocked_operational_failure");
  });

  test("shadow mode remains manifest-only even after an exact qualified result", async () => {
    const result = await executeRetrievalV3({
      runId: "shadow-run",
      plan: plan("25 disco songs", 25),
      adapters: allQualifiedAdapter(40),
      executionMode: "shadow",
    });
    expect(result.outcome.status).toBe("exact_ready");
    expect(result.publicationBoundary).toEqual({
      appleWriteAccess: "forbidden",
      manifestDisposition: "shadow_manifest_only",
    });
  });

  test("preserves custom targets through the executable owner cap", async () => {
    const result = await executeRetrievalV3({
      runId: "three-hundred-run",
      plan: plan("300 broad disco tracks", 300),
      adapters: allQualifiedAdapter(300),
    });
    expect(result.selected).toHaveLength(300);
    expect(result.reserve).toHaveLength(60);
    expect(result.outcome.requestedTrackCount).toBe(300);

    const thousandPlan = plan("1000 broad disco tracks", 1_000);
    const thousand = await executeRetrievalV3({
      runId: "one-thousand-run",
      plan: {
        ...thousandPlan,
        diversityGoals: {
          minimumDistinctArtists: null,
          minimumDistinctAlbums: null,
          minimumDistinctEras: null,
          minimumDistinctScenes: null,
          minimumDistinctGeographies: null,
          maximumTracksPerArtist: null,
          maximumTracksPerAlbum: null,
        },
        orderingPolicy: {
          ...thousandPlan.orderingPolicy,
          avoidAdjacentSameArtist: false,
          avoidAdjacentSameAlbum: false,
        },
      },
      adapters: allQualifiedAdapter(1_200),
    });
    expect(thousand.selected).toHaveLength(1_000);
    expect(thousand.outcome.requestedTrackCount).toBe(1_000);

    const invalid = { ...plan("50 tracks", 50), requestedTrackCount: 1_001 };
    await expect(executeRetrievalV3({
      runId: "invalid-count",
      plan: invalid,
      adapters: allQualifiedAdapter(),
    })).rejects.toThrow(/between 1 and 1000/i);
  });

  test("uses explicit deadline and budget stop reasons without mislabeling a shortfall", async () => {
    const adapters: RetrievalAdaptersV3 = {
      discover: async () => ({ candidates: [candidate(1)], nextCursor: null, exhausted: false, costUnits: 2 }),
      qualify: async ({ candidates }) => candidates.map((value) => qualification(value)),
    };
    const budget = await executeRetrievalV3({
      runId: "budget-run",
      plan: plan("50 jazz tracks", 50),
      adapters,
      policy: { maximumCostUnits: 1 },
    });
    expect(budget.outcome).toMatchObject({ status: "partial_ready", stopReason: "budget_reached" });

    const deadline = await executeRetrievalV3({
      runId: "deadline-run",
      plan: plan("50 techno tracks", 50),
      adapters,
      policy: { deadlineAtEpochMs: 100 },
      now: () => 100,
    });
    expect(deadline.outcome).toMatchObject({ status: "needs_decision", stopReason: "deadline_reached" });
    expect(deadline.publicationBoundary).toEqual({
      appleWriteAccess: "forbidden",
      manifestDisposition: "no_manifest",
    });
  });

  test("treats the immutable dollar reservation boundary as budget exhaustion, not a technical failure", async () => {
    let discoveryCall = 0;
    const budgetError = Object.assign(
      new Error("Run needs additional budget approval"),
      { code: "run_budget_reached" },
    );
    const result = await executeRetrievalV3({
      runId: "dollar-budget-run",
      plan: plan("two disco tracks", 2),
      adapters: {
        discover: async () => {
          discoveryCall += 1;
          if (discoveryCall > 1) throw budgetError;
          return {
            candidates: [candidate(1)],
            nextCursor: null,
            exhausted: false,
            costUnits: 1,
          };
        },
        qualify: async ({ candidates }) => candidates.map((value) => qualification(value)),
      },
      policy: {
        maximumConcurrentDiscovery: 1,
        maximumGlobalRounds: 2,
      },
    });

    expect(discoveryCall).toBe(2);
    expect(result.selected).toHaveLength(1);
    expect(result.outcome).toMatchObject({
      status: "partial_ready",
      stopReason: "budget_reached",
      shortfall: 1,
    });
  });

  test("aborts provider work that is still in flight at the active-compute deadline", async () => {
    const startedAt = Date.now();
    let observedSignal: AbortSignal | undefined;
    const result = await executeRetrievalV3({
      runId: "in-flight-deadline-run",
      plan: plan("50 techno tracks", 50),
      adapters: {
        discover: async (request) => {
          observedSignal = request.signal;
          if (!request.signal) throw new Error("provider deadline signal missing");
          await new Promise<void>((_resolve, reject) => {
            const fallback = setTimeout(
              () => reject(new Error("provider deadline signal did not abort")),
              1_000,
            );
            request.signal!.addEventListener("abort", () => {
              clearTimeout(fallback);
              reject(request.signal!.reason);
            }, { once: true });
          });
          return { candidates: [], nextCursor: null, exhausted: false };
        },
        qualify: async () => [],
      },
      policy: {
        deadlineAtEpochMs: startedAt + 25,
        maximumConcurrentDiscovery: 1,
      },
    });
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.outcome).toMatchObject({
      status: "needs_decision",
      stopReason: "deadline_reached",
    });
  });

  test("a continuation preserves qualified tracks and runs only its frozen approved strategy set", async () => {
    const selection = plan("five disco tracks", 5);
    let firstIndex = 0;
    const initial = await executeRetrievalV3({
      runId: "continuation-source",
      plan: selection,
      adapters: {
        discover: async () => ({
          candidates: Array.from({ length: 3 }, () => candidate(firstIndex++)),
          nextCursor: null,
          exhausted: false,
        }),
        qualify: async ({ candidates }) => candidates.map((value) => qualification(value)),
      },
      policy: { maximumGlobalRounds: 1 },
    });
    expect(initial.outcome.status).toBe("partial_ready");
    const approved = initial.strategies.find(({ status }) => status === "available")?.id;
    expect(approved).toBeTruthy();

    const calledStrategies: string[] = [];
    let continuedIndex = 100;
    const continued = await executeRetrievalV3({
      runId: "continuation-successor",
      plan: selection,
      continuation: {
        approvedStrategyIds: [approved!],
        qualifiedTracks: initial.qualifiedPool,
        compatibleAlternatesByRecordingFamily: initial.compatibleAlternatesByRecordingFamily,
        stages: initial.stages,
        strategies: initial.strategies,
      },
      adapters: {
        discover: async ({ strategy, requestedRawCandidateCount }) => {
          calledStrategies.push(strategy.id);
          return {
            candidates: Array.from(
              { length: Math.min(20, requestedRawCandidateCount) },
              () => candidate(continuedIndex++),
            ),
            nextCursor: null,
            exhausted: true,
          };
        },
        qualify: async ({ candidates }) => candidates.map((value) => qualification(value)),
      },
    });
    expect(continued.outcome.status).toBe("exact_ready");
    expect(continued.selected.some(({ candidateId }) => candidateId === "candidate-0")).toBe(true);
    expect(new Set(calledStrategies)).toEqual(new Set([approved!]));
  });

  test("a continuation retains mixed cache, source, and dependency provenance under the same caps", async () => {
    const selection = canonicalDiscoPlan(4);
    let delivered = false;
    const source = await executeRetrievalV3({
      runId: "provenance-continuation-source",
      plan: selection,
      adapters: {
        discover: async () => {
          if (delivered) return { candidates: [], nextCursor: null, exhausted: true };
          delivered = true;
          return {
            candidates: Array.from({ length: 4 }, (_, index) => candidate(index)),
            nextCursor: null,
            exhausted: true,
            provenance: {
              cacheOrigin: "live",
              sourceFreshUntil: null,
            },
          };
        },
        qualify: async ({ candidates }) => candidates.map((value) => (
          canonicalDiscoQualification(value)
        )),
      },
      policy: { maximumGlobalRounds: 1 },
    });
    expect(source.qualifiedPool).toHaveLength(4);
    const approved = source.strategies[0]!.id;
    const future = "2099-01-01T00:00:00.000Z";
    const qualifiedTracks = source.qualifiedPool.map((track, index) => ({
      ...track,
      provenanceRoots: index < 3 ? ["shared-source"] : [],
      discoveryDependencyIds: index < 2
        ? ["hosted_web" as const]
        : index === 2
          ? ["apple_catalog" as const]
          : [],
      cacheOrigin: index === 0
        ? "live" as const
        : index < 3
          ? "fresh_cache" as const
          : "unknown" as const,
      sourceFreshUntil: index > 0 && index < 3 ? future : null,
    }));

    const continued = await executeRetrievalV3({
      runId: "provenance-continuation-successor",
      plan: selection,
      continuation: {
        approvedStrategyIds: [approved],
        qualifiedTracks,
        compatibleAlternatesByRecordingFamily: {},
        stages: source.stages,
        strategies: source.strategies,
      },
      adapters: {
        discover: async () => ({ candidates: [], nextCursor: null, exhausted: true }),
        qualify: async () => [],
      },
    });

    expect(continued.qualifiedPool).toHaveLength(4);
    expect(continued.qualifiedPool.map(({ cacheOrigin }) => cacheOrigin))
      .toEqual(["live", "fresh_cache", "fresh_cache", "unknown"]);
    expect(continued.qualifiedPool[3]).toMatchObject({
      provenanceRoots: [],
      discoveryDependencyIds: [],
      cacheOrigin: "unknown",
    });
    expect(continued.outcome).toMatchObject({
      status: "partial_ready",
      stopReason: "frontier_exhausted",
      selectedTrackCount: 3,
      shortfall: 1,
    });
    expect(continued.playlistOptimization?.unmetConstraints)
      .toContain("exact_count:3/4");
  });

  test.each([
    ["missing predicate coverage", (track: QualifiedTrackV3) => ({
      ...track,
      evidenceBindings: track.evidenceBindings?.map((binding) => ({
        ...binding,
        predicateIds: [],
      })),
    }), "scope_membership_failed"],
    ["incompatible version", (track: QualifiedTrackV3) => ({
      ...track,
      versionConfidence: 0,
    }), "version_incompatible"],
    ["unplayable catalog identity", (track: QualifiedTrackV3) => ({
      ...track,
      catalogConfidence: 0,
    }), "storefront_unavailable"],
  ] as const)("rejects continuation seed tracks with %s", async (_label, mutate, reason) => {
    const selection = plan("one disco track", 1);
    const source = await executeRetrievalV3({
      runId: "seed-source",
      plan: selection,
      adapters: allQualifiedAdapter(1),
      policy: { maximumGlobalRounds: 1 },
    });
    const approved = source.strategies.find(({ status }) => status === "available")?.id
      ?? source.strategies[0]!.id;
    const result = await executeRetrievalV3({
      runId: "seed-validation",
      plan: selection,
      continuation: {
        approvedStrategyIds: [approved],
        qualifiedTracks: [mutate(source.qualifiedPool[0]!)],
        compatibleAlternatesByRecordingFamily: {},
        stages: source.stages,
        strategies: source.strategies,
      },
      adapters: {
        discover: async () => ({ candidates: [], nextCursor: null, exhausted: true }),
        qualify: async () => [],
      },
    });
    expect(result.qualifiedPool).toEqual([]);
    expect(result.integrityEvents).toContain(`continuation_seed_rejected:${reason}:candidate-0`);
  });

  test.each([
    ["tampered hosted excerpt", "tampered"],
    ["expired hosted source", "expired"],
    ["revoked hosted source", "revoked"],
  ] as const)("rejects a canonical continuation seed with a %s", async (_label, mutation) => {
    const selection = canonicalDiscoPlan(1);
    const source = await executeRetrievalV3({
      runId: `canonical-hosted-seed-source-${mutation}`,
      plan: selection,
      adapters: {
        discover: async () => ({
          candidates: [candidate(0)],
          nextCursor: null,
          exhausted: true,
        }),
        qualify: async ({ candidates }) => candidates.map((value) => (
          canonicalDiscoQualification(value)
        )),
      },
      policy: { maximumGlobalRounds: 1 },
    });
    expect(source.qualifiedPool).toHaveLength(1);
    const seed = source.qualifiedPool[0]!;
    const binding = seed.evidenceBindings?.[0];
    const snapshot = binding?.hostedEvidenceSnapshot;
    if (!binding || !snapshot) throw new Error("canonical hosted evidence fixture is incomplete");
    const mutatedBinding = mutation === "tampered"
      ? {
        ...binding,
        hostedEvidenceSnapshot: {
          ...snapshot,
          excerpt: `${snapshot.excerpt} tampered`,
        },
      }
      : {
        ...binding,
        governance: {
          ...binding.governance,
          ...(mutation === "expired"
            ? { freshnessExpiresAt: "2000-01-01T00:00:00.000Z" }
            : { revokedAt: "2026-01-01T00:00:00.000Z" }),
        },
      };
    const approved = source.strategies.find(({ status }) => status === "available")?.id
      ?? source.strategies[0]!.id;
    const result = await executeRetrievalV3({
      runId: `canonical-hosted-seed-restart-${mutation}`,
      plan: selection,
      continuation: {
        approvedStrategyIds: [approved],
        qualifiedTracks: [{
          ...seed,
          evidenceBindings: [mutatedBinding],
        }],
        compatibleAlternatesByRecordingFamily: {},
        stages: source.stages,
        strategies: source.strategies,
      },
      adapters: {
        discover: async () => ({ candidates: [], nextCursor: null, exhausted: true }),
        qualify: async () => [],
      },
    });

    expect(result.qualifiedPool).toEqual([]);
    expect(result.integrityEvents).toContain(
      "continuation_seed_rejected:evidence_attestation_missing:candidate-0",
    );
  });

  test("rechecks persisted hard constraints before trusting a continuation seed", async () => {
    const base = plan("one disco track", 1);
    const selection: SelectionPlanV3 = {
      ...base,
      hardConstraints: [{
        id: "exclude-artist-zero",
        axis: "artist",
        operator: "exclude",
        values: ["Artist 0"],
        kind: "hard",
        relaxationRank: null,
      }],
    };
    const source = await executeRetrievalV3({
      runId: "hard-seed-source",
      plan: base,
      adapters: allQualifiedAdapter(1),
      policy: { maximumGlobalRounds: 1 },
    });
    const approved = source.strategies.find(({ status }) => status === "available")?.id
      ?? source.strategies[0]!.id;
    const result = await executeRetrievalV3({
      runId: "hard-seed-validation",
      plan: selection,
      continuation: {
        approvedStrategyIds: [approved],
        qualifiedTracks: [source.qualifiedPool[0]!],
        compatibleAlternatesByRecordingFamily: {},
        stages: source.stages,
        strategies: source.strategies,
      },
      adapters: {
        discover: async () => ({ candidates: [], nextCursor: null, exhausted: true }),
        qualify: async () => [],
      },
    });
    expect(result.qualifiedPool).toEqual([]);
    expect(result.integrityEvents).toContain(
      "continuation_seed_rejected:hard_constraint_failed:candidate-0",
    );
  });

  test.each([
    [1972, false],
    [1973, true],
    [1983, true],
    [1984, false],
  ] as const)("rechecks the inclusive 1973–1983 catalog era when continuing a %i seed", async (
    catalogReleaseYear,
    accepted,
  ) => {
    const base = plan("one disco track", 1);
    const selection: SelectionPlanV3 = {
      ...base,
      membershipPredicates: [
        ...base.membershipPredicates,
        {
          id: "era-membership",
          axis: "era",
          operator: "require",
          values: ["1973", "1983"],
          source: "user",
          reason: "Requested era.",
        },
      ],
      hardConstraints: [{
        id: "era-between",
        axis: "era",
        operator: "between",
        values: ["1973", "1983"],
        kind: "hard",
        relaxationRank: null,
      }],
    };
    const source = await executeRetrievalV3({
      runId: `era-seed-source-${catalogReleaseYear}`,
      plan: base,
      adapters: allQualifiedAdapter(1),
      policy: { maximumGlobalRounds: 1 },
    });
    const approved = source.strategies.find(({ status }) => status === "available")?.id
      ?? source.strategies[0]!.id;
    const result = await executeRetrievalV3({
      runId: `era-seed-validation-${catalogReleaseYear}`,
      plan: selection,
      continuation: {
        approvedStrategyIds: [approved],
        qualifiedTracks: [{ ...source.qualifiedPool[0]!, catalogReleaseYear }],
        compatibleAlternatesByRecordingFamily: {},
        stages: source.stages,
        strategies: source.strategies,
      },
      adapters: {
        discover: async () => ({ candidates: [], nextCursor: null, exhausted: true }),
        qualify: async () => [],
      },
    });

    expect(result.qualifiedPool).toHaveLength(accepted ? 1 : 0);
    if (!accepted) {
      expect(result.integrityEvents).toContain(
        "continuation_seed_rejected:hard_constraint_failed:candidate-0",
      );
    }
  });

  test("retains compatible recording-family era proof across continuation checkpoints", async () => {
    const base = plan("one disco track", 1);
    const selection: SelectionPlanV3 = {
      ...base,
      membershipPredicates: [
        ...base.membershipPredicates,
        {
          id: "era-membership",
          axis: "era",
          operator: "require",
          values: ["1973", "1983"],
          source: "user",
          reason: "Requested era.",
        },
      ],
      hardConstraints: [{
        id: "era-between",
        axis: "era",
        operator: "between",
        values: ["1973", "1983"],
        kind: "hard",
        relaxationRank: null,
      }],
    };
    const source = await executeRetrievalV3({
      runId: "compatible-era-seed-source",
      plan: base,
      adapters: allQualifiedAdapter(1),
      policy: { maximumGlobalRounds: 1 },
    });
    const approved = source.strategies.find(({ status }) => status === "available")?.id
      ?? source.strategies[0]!.id;
    const result = await executeRetrievalV3({
      runId: "compatible-era-seed-validation",
      plan: selection,
      continuation: {
        approvedStrategyIds: [approved],
        qualifiedTracks: [{
          ...source.qualifiedPool[0]!,
          catalogReleaseYear: 2004,
          catalogCompatibleReleaseYears: [1978, 2004],
        }],
        compatibleAlternatesByRecordingFamily: {},
        stages: source.stages,
        strategies: source.strategies,
      },
      adapters: {
        discover: async () => ({ candidates: [], nextCursor: null, exhausted: true }),
        qualify: async () => [],
      },
    });

    expect(result.qualifiedPool).toHaveLength(1);
    expect(result.qualifiedPool[0]).toMatchObject({
      catalogReleaseYear: 2004,
      catalogCompatibleReleaseYears: [1978, 2004],
    });
  });

  test("rejects conflicting Apple identities in a continuation checkpoint", async () => {
    const selection = plan("two disco tracks", 2);
    const source = await executeRetrievalV3({
      runId: "identity-conflict-source",
      plan: selection,
      adapters: allQualifiedAdapter(2),
      policy: { maximumGlobalRounds: 1 },
    });
    const approved = source.strategies.find(({ status }) => status === "available")?.id
      ?? source.strategies[0]!.id;
    const first = source.qualifiedPool[0]!;
    const second = { ...source.qualifiedPool[1]!, appleSongId: first.appleSongId };
    const result = await executeRetrievalV3({
      runId: "identity-conflict-continuation",
      plan: selection,
      continuation: {
        approvedStrategyIds: [approved],
        qualifiedTracks: [first, second],
        compatibleAlternatesByRecordingFamily: {},
        stages: source.stages,
        strategies: source.strategies,
      },
      adapters: {
        discover: async () => ({ candidates: [], nextCursor: null, exhausted: true }),
        qualify: async () => [],
      },
    });

    expect(result.qualifiedPool).toHaveLength(1);
    expect(result.integrityEvents).toContain(
      `continuation_seed_rejected:catalog_identity_conflict:${second.candidateId}`,
    );
    expect(result.outcome).toMatchObject({
      status: "failed_integrity",
      stopReason: "integrity_failure",
    });
    expect(result.publicationBoundary.manifestDisposition)
      .toBe("blocked_operational_failure");
  });

  test("quarantines a live identity conflict even when the exact reserve is otherwise full", async () => {
    const candidates = Array.from({ length: 4 }, (_, index) => candidate(index));
    const result = await executeRetrievalV3({
      runId: "identity-conflict-with-full-reserve",
      plan: planWithIntents(["mood_activity"], 2),
      adapters: {
        discover: async () => ({
          candidates,
          nextCursor: null,
          exhausted: true,
          costUnits: 1,
        }),
        qualify: async ({ candidates: discovered }) => discovered.map((value, index) => (
          qualification(value, index === 1 ? {
            catalog: {
              storefrontPlayable: true,
              appleSongId: "apple-candidate-0",
              recordingFamilyKey: "family-candidate-1",
              confidence: 0.98,
            },
          } : {})
        )),
      },
      policy: {
        maximumConcurrentDiscovery: 1,
        maximumGlobalRounds: 1,
        qualifiedPoolGoal: 3,
      },
    });

    expect(result.selected).toHaveLength(2);
    expect(result.reserve).toHaveLength(1);
    expect(result.outcome).toMatchObject({
      status: "failed_integrity",
      stopReason: "integrity_failure",
      selectedTrackCount: 2,
      reserveTrackCount: 1,
      shortfall: 0,
    });
    expect(result.integrityEvents).toContain("catalog_identity_conflict:apple-candidate-0");
    expect(result.publicationBoundary.manifestDisposition)
      .toBe("blocked_operational_failure");
  });
});
