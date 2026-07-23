import { describe, expect, test, vi } from "vitest";
import {
  executeRetrievalV3,
  publicTrackScopeAttestationV3,
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
import { canonicalContractExecutionPolicyV1 } from "../server/canonical-contract-runtime-v1.ts";
import { compilePlaylistContractRevisionV1 } from "../server/playlist-contract-v1.ts";

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
  const sourceUrl = `https://evidence.example.test/tracks/${encodeURIComponent(value.id)}`;
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
        provenanceRoot: "evidence.example.test",
        strength: 0.9,
        sourceRank: 1,
        kind: "track_specific_source",
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

function canonicalDiscoQualification(
  value: RawTrackCandidateV3,
  patch: Partial<CandidateQualificationV3> = {},
): CandidateQualificationV3 {
  const base = qualification(value, patch);
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
        const base = qualification(value, {
          // Deliberately contradictory legacy booleans: contract3 must ignore
          // these flattened values and execute its Boolean tree below.
          scope: {
            passed: false,
            failedMembershipPredicateIds: ["legacy:flattened"],
            fit: 0,
          },
        });
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
                  evidenceGrade: "authoritative_structured_metadata",
                },
              }
            : index === 1
              ? {
                  "genre:reggaeton": { status: "unknown" },
                  "genre:dembow": { status: "unknown" },
                  "exclude:bad-bunny": {
                    status: "fail",
                    evidenceGrade: "authoritative_structured_metadata",
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
                    evidenceGrade: "authoritative_structured_metadata",
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
        qualify: async ({ candidates }) => candidates.map((value, index) => qualification(value, {
          rankingSignals: {
            relevance: 0.9,
            central_quality: index < 8 ? 0.9 : index === 8 ? 0.6 : 0.2,
          },
        })),
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
    const adapters: RetrievalAdaptersV3 = {
      discover: async ({ strategy }) => {
        if (strategy.discoveryDependencyIds.includes("hosted_web")) {
          throw new RetrievalDependencyErrorV3("hosted search unavailable", ["hosted_web"]);
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
    });
    expect(hosted!.failureAttempts).toBeGreaterThan(1);
    expect(hosted!.affectedStrategyIds.length).toBeGreaterThan(1);
  });

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
      discover: async () => { throw new Error("provider unavailable"); },
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
        throw new Error("provider unavailable");
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
  });
});
