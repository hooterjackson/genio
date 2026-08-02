import { describe, expect, test } from "vitest";
import {
  ADAPTIVE_GUIDANCE_POLICY_VERSION_V5,
  GUIDANCE_MAX_QUESTION_ROUNDS_V5,
  assertGuidanceDecisionV5,
  assertGuidanceExecutionDecisionV5,
  guidanceAxisProposalFromScoutV5,
  guidanceCheckpointV5,
} from "../server/adaptive-guidance-v5.ts";
import {
  compileGuidanceExecutionActionV5,
  compileGuidanceRoundPatchV3,
  guidanceExecutionDecisionV5FromPublicQuestion,
  publicGuidanceExecutionDecisionV5,
  publicGuidanceQuestionV5,
} from "../server/adaptive-guidance-contract-bridge.ts";
import {
  applyPlaylistContractPatchV1,
  compilePlaylistContractRevisionV1,
  type PlaylistContractRevisionV1,
} from "../server/playlist-contract-v1.ts";
import {
  compilePlaylistContractShadowV1,
} from "../server/playlist-contract-shadow-bridge-v1.ts";
import {
  createSelectionPlanV2,
  SELECTION_INFLUENCE_SCOPE_SIGNAL_V1,
} from "../server/selection-plan-v2.ts";
import { sha256Hex, stableStringify } from "../server/security.ts";
import type { PlaylistBrief } from "../shared/types.ts";

function contract(
  softAxes: readonly string[] = [],
): PlaylistContractRevisionV1 {
  return compilePlaylistContractRevisionV1({
    contractId: "contract:guidance-v5",
    rawPrompt: "A nuanced Greek rap playlist for a late drive",
    requestedTrackCount: 25,
    locale: "en",
    storefront: "us",
    clauses: [
      {
        id: "membership:genre",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "genre",
        operator: "require",
        values: ["Greek rap"],
        source: {
          provenance: "prompt",
          text: "Greek rap",
        },
      },
      ...softAxes.map((axis) => ({
        id: `soft:${axis}`,
        kind: "ranking_preference" as const,
        scope: "track" as const,
        hardness: "soft" as const,
        axis,
        operator: "prefer" as const,
        values: [axis],
        source: {
          provenance: "prompt" as const,
          text: axis,
        },
      })),
    ],
    trackPredicate: { op: "clause", clauseId: "membership:genre" },
  });
}

function influenceContract(
  rawPrompt: string,
  scope = "Irish",
  typedInfluence = true,
): PlaylistContractRevisionV1 {
  return compilePlaylistContractRevisionV1({
    contractId: `contract:guidance-v5-influence:${scope}`,
    rawPrompt,
    requestedTrackCount: 50,
    locale: "en",
    storefront: "us",
    clauses: [
      {
        id: "membership:origin",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "artist_origin",
        operator: "require",
        values: [scope],
        source: {
          provenance: "prompt",
          text: scope,
        },
      },
      ...(typedInfluence
        ? [
            {
              id: "quality:documented-influence",
              kind: "suitability" as const,
              scope: "track" as const,
              hardness: "soft" as const,
              axis: "influence",
              operator: "prefer" as const,
              values: ["documented historical influence"],
              source: {
                provenance: "prompt" as const,
                text: "influential",
              },
              evidence: {
                required: true,
                minimumGrade: null,
                permittedGrades: [
                  "track_specific_editorial_assertion" as const,
                  "independent_secondary_source" as const,
                ],
              },
              unknownPolicy: "defer" as const,
            },
            {
              id: "ranking:original-influence",
              kind: "ranking_preference" as const,
              scope: "track" as const,
              hardness: "soft" as const,
              axis: "influence",
              operator: "prefer" as const,
              values: ["documented historical influence"],
              source: {
                provenance: "prompt" as const,
                text: "influential",
              },
            },
          ]
        : []),
    ],
    trackPredicate: {
      op: "clause",
      clauseId: "membership:origin",
    },
  });
}

function artifactContract(input: {
  rawPrompt: string;
  clauses: Parameters<typeof compilePlaylistContractRevisionV1>[0]["clauses"];
  includeArtifactClausesInPredicate?: boolean;
}): PlaylistContractRevisionV1 {
  const clauses = [
    {
      id: "membership:genre",
      kind: "membership" as const,
      scope: "track" as const,
      hardness: "hard" as const,
      axis: "genre",
      operator: "require" as const,
      values: ["jazz"],
      source: {
        provenance: "prompt" as const,
        text: "jazz",
      },
    },
    ...input.clauses.map((clause) => (
      clause.kind === "suitability"
        ? {
            ...clause,
            evidence: clause.evidence ?? {
              required: true,
              minimumGrade: null,
              permittedGrades: [
                "track_specific_editorial_assertion" as const,
                "independent_secondary_source" as const,
              ],
            },
            unknownPolicy: clause.unknownPolicy ?? "defer" as const,
          }
        : clause
    )),
  ];
  const predicateClauseIds = input.includeArtifactClausesInPredicate
    ? clauses.filter(({ hardness, scope }) => (
        hardness === "hard" && scope === "track"
      )).map(({ id }) => id)
    : ["membership:genre"];
  return compilePlaylistContractRevisionV1({
    contractId: "contract:guidance-v5-artifact",
    rawPrompt: input.rawPrompt,
    requestedTrackCount: 25,
    locale: "en",
    storefront: "us",
    clauses,
    trackPredicate: predicateClauseIds.length === 1
      ? { op: "clause", clauseId: predicateClauseIds[0]! }
      : {
          op: "all",
          children: predicateClauseIds.map(
            (clauseId) => ({ op: "clause" as const, clauseId }),
          ),
        },
  });
}

function checkpoint(baseContract = contract()) {
  return guidanceCheckpointV5({
    prompt: baseContract.rawPrompt,
    baseContract,
    preservedTrackPredicate: baseContract.trackPredicate,
    ambiguousScopeClauseIds: [],
    criticalAmbiguities: [],
    requestShape: "curated",
    capabilitySnapshotHash: "a".repeat(64),
    semanticConfigurationHash: "b".repeat(64),
  });
}

describe("adaptive guidance v5", () => {
  test("never returns a questionless curated checkpoint", () => {
    const result = checkpoint();
    expect(result.policyVersion).toBe(
      ADAPTIVE_GUIDANCE_POLICY_VERSION_V5,
    );
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({
      schemaVersion: 5,
      axis: "familiarity_balance",
      mode: "nuance_optional",
      capabilitySnapshotHash: "a".repeat(64),
      semanticConfigurationHash: "b".repeat(64),
    });
    expect(result.decisions[0]!.options).toHaveLength(4);
    expect(result.decisions[0]!.options.some(
      ({ id }) => id === "keep_current_interpretation",
    )).toBe(true);
  });

  test("proves every non-noop successor and worker-consumed effect", () => {
    const base = contract();
    const decision = checkpoint(base).decisions[0]!;
    expect(() => assertGuidanceDecisionV5(decision, base)).not.toThrow();
    const nonNoop = decision.simulations.filter(
      ({ successorSemanticHash }) => successorSemanticHash !== null,
    );
    expect(nonNoop).toHaveLength(3);
    expect(new Set(nonNoop.map(
      ({ successorSemanticHash }) => successorSemanticHash,
    )).size).toBe(3);
    expect(nonNoop.every(({ executionEffect }) => (
      executionEffect?.field === "rankingObjectives"
      && executionEffect.consumerId
        === "pipeline_v3_retrieval:familiarityBoundsV3"
    ))).toBe(true);
    expect(nonNoop.every(({ consumerReceipt }) => (
      consumerReceipt?.consumerId
        === "pipeline_v3_retrieval:familiarityBoundsV3"
      && consumerReceipt.registryHash === decision.consumerRegistryHash
      && consumerReceipt.capabilitySnapshotHash
        === decision.capabilitySnapshotHash
    ))).toBe(true);
    expect(nonNoop.every((simulation) => (
      simulation.beforeQueryPlanHash !== simulation.afterQueryPlanHash
      && /^[a-f0-9]{64}$/u.test(simulation.simulationReceiptHash)
    ))).toBe(true);
    const explicitNoop = decision.simulations.find(
      ({ successorSemanticHash }) => successorSemanticHash === null,
    )!;
    expect(explicitNoop.beforeQueryPlanHash).toBe(
      explicitNoop.afterQueryPlanHash,
    );
  });

  test("round-trips the signed public question and compiles its patch", () => {
    const base = contract();
    const decision = checkpoint(base).decisions[0]!;
    const question = publicGuidanceQuestionV5(decision);
    expect(question.consumerRegistryHash).toBe(
      decision.consumerRegistryHash,
    );
    expect(question.options[0]?.optionSimulation?.consumerReceipt)
      .toMatchObject({
        registryHash: decision.consumerRegistryHash,
        axis: decision.axis,
        consumerId:
          "pipeline_v3_retrieval:familiarityBoundsV3",
      });
    expect(question.options[0]?.optionSimulation).toMatchObject({
      beforeQueryPlanHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      afterQueryPlanHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      simulationReceiptHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const patch = compileGuidanceRoundPatchV3({
      base,
      questionSetHash: checkpoint(base).checkpointHash,
      questions: [question],
      answers: [{
        questionId: question.id,
        optionId: "balanced_discovery",
      }],
    });
    expect(patch).not.toBeNull();
    const successor = applyPlaylistContractPatchV1(base, patch!);
    expect(successor.requestedTrackCount).toBe(25);
    expect(successor.clauses).toContainEqual(expect.objectContaining({
      axis: "familiarity_bias",
      hardness: "soft",
    }));
  });

  test("chooses another registered axis when familiarity is explicit", () => {
    const base = contract(["familiarity_bias"]);
    const result = checkpoint(base);
    expect(result.decisions[0]?.axis).toBe("playlist_flow");
    expect(result.decisions[0]?.simulations.filter(
      ({ executionEffect }) => executionEffect !== null,
    ).every(({ executionEffect }) => (
      executionEffect?.field === "orderingPolicy"
    ))).toBe(true);
  });

  test.each([
    "Infuential irish music",
    "Influential Irish music",
    "Irish music that changed the world",
    "Essential influential music from Ireland",
    "Landmark Irish recordings",
  ])("selects the generalized influence axis for %s", (prompt) => {
    const base = influenceContract(prompt);
    const result = checkpoint(base);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({
      axis: "influence_scope",
      mode: "nuance_optional",
      question: "Which kind of influence should lead the playlist?",
    });
    expect(result.decisions[0]?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "within_scope_cultural_impact",
          label: "Irish cultural impact",
          recommended: false,
        }),
        expect.objectContaining({
          id: "global_influence",
          label: "Global influence",
          recommended: false,
        }),
        expect.objectContaining({
          id: "balanced_influence",
          label: "Balanced",
          recommended: true,
          recommendationReason:
            "The original wording leaves Irish cultural impact versus global influence open, so a balanced emphasis preserves both readings.",
        }),
      ]),
    );
    const publicQuestion = publicGuidanceQuestionV5(
      result.decisions[0]!,
    );
    expect(publicQuestion.options.find(
      ({ id }) => id === "balanced_influence",
    )?.recommendationReason).toBe(
      "The original wording leaves Irish cultural impact versus global influence open, so a balanced emphasis preserves both readings.",
    );
    expect(publicQuestion.questionHash).toBe(
      result.decisions[0]?.questionHash,
    );
  });

  test("does not reinterpret raw prompt prose inside Guidance V5", () => {
    const base = influenceContract(
      "Influential Irish music",
      "Irish",
      false,
    );
    expect(checkpoint(base).decisions[0]?.axis).toBe(
      "familiarity_balance",
    );
  });

  test.each([
    "Infuential irish music",
    "Influential music from Ireland",
    "Irish recordings that changed the world",
    "Landmark recordings from Ireland",
  ])("compiles %s into a typed influence artifact before guidance", (prompt) => {
    const requestBrief: PlaylistBrief = {
      title: "Irish influence",
      description: "A curated survey of Irish music.",
      mode: "curated",
      subjectEntities: ["Irish music"],
      relationship: "recordings within the requested Irish scope",
      include: [],
      exclude: [],
      versionPolicy: "Prefer canonical studio recordings.",
      evidencePolicy: "Use policy-valid evidence.",
      orderingPolicy: "Use a coherent editorial flow.",
      targetSize: { min: 25, max: 25 },
      ambiguities: [],
    };
    const selectionPlan = createSelectionPlanV2({
      prompt,
      brief: requestBrief,
      storefront: "us",
    });
    expect(selectionPlan.constraints).toContainEqual(
      expect.objectContaining({
        axis: "relationship",
        kind: "soft",
        values: [SELECTION_INFLUENCE_SCOPE_SIGNAL_V1],
      }),
    );
    const shadow = compilePlaylistContractShadowV1({
      contractId:
        `typed-influence:${prompt.replace(/[^A-Za-z0-9]+/gu, "-")}`,
      prompt,
      brief: requestBrief,
      selectionPlan,
    });
    expect(shadow.contract.clauses).toContainEqual(
      expect.objectContaining({
        axis: "influence",
        kind: "ranking_preference",
        hardness: "soft",
        values: ["documented historical influence"],
      }),
    );
    expect(checkpoint(shadow.contract).decisions[0]?.axis).toBe(
      "influence_scope",
    );
  });

  test("uses typed influence semantics without a subject-specific prompt rule", () => {
    const base = influenceContract(
      "A definitive survey of Nigerian recordings",
      "Nigerian",
      true,
    );
    const decision = checkpoint(base).decisions[0]!;
    expect(decision.axis).toBe("influence_scope");
    expect(decision.question).toBe(
      "Which kind of influence should lead the playlist?",
    );
    expect(decision.options[0]?.label).toBe(
      "Nigerian cultural impact",
    );
    expect(decision.options.find(
      ({ id }) => id === "balanced_influence",
    )?.recommendationReason).toBe(
      "The original wording leaves Nigerian cultural impact versus global influence open, so a balanced emphasis preserves both readings.",
    );
  });

  test("falls back deterministically when the question scout fails", () => {
    const base = influenceContract("Infuential irish music");
    const healthy = checkpoint(base).decisions[0]!;
    const failedScout = guidanceCheckpointV5({
      prompt: base.rawPrompt,
      baseContract: base,
      preservedTrackPredicate: base.trackPredicate,
      ambiguousScopeClauseIds: [],
      criticalAmbiguities: [],
      requestShape: "curated",
      capabilitySnapshotHash: "a".repeat(64),
      semanticConfigurationHash: "b".repeat(64),
      scoutFailure: "provider_unavailable",
    });
    expect(failedScout.decisions[0]?.questionHash).toBe(
      healthy.questionHash,
    );
    expect(failedScout.rejectedDecisionReasons).toMatchObject({
      "v5-scout-failure": "deterministic_server_axis_used",
    });
  });

  test("binds the recommendation explanation into the V5 question hash", () => {
    const base = influenceContract("Infuential irish music");
    const decision = structuredClone(checkpoint(base).decisions[0]!);
    const balanced = decision.options.find(
      ({ id }) => id === "balanced_influence",
    )!;
    (balanced as { recommendationReason?: string }).recommendationReason =
      "A different unsigned explanation.";
    expect(() => assertGuidanceDecisionV5(decision, base)).toThrow(
      "guidance_v5_question_hash_mismatch",
    );
  });

  test("preserves the protected Smooth Reggaeton recommendation with an explicit reason", () => {
    const prompt = "Smooth Reggaeton Heat: A 50-track smooth reggaeton playlist centered on polished, sensual, danceable reggaeton and adjacent Latin urban tracks with a flirtatious, crowd-pleasing vibe.";
    const requestBrief: PlaylistBrief = {
      title: "Smooth Reggaeton Heat",
      description: "Polished, sensual, danceable reggaeton and adjacent Latin urban.",
      mode: "curated",
      subjectEntities: ["reggaeton", "Latin urban"],
      relationship: "representative of the requested genre scope",
      include: ["reggaeton", "adjacent Latin urban"],
      exclude: [],
      versionPolicy: "Prefer canonical recordings.",
      evidencePolicy: "Use policy-valid genre evidence.",
      orderingPolicy: "Use a crowd-pleasing flow.",
      targetSize: { min: 50, max: 50 },
      ambiguities: ["how far adjacent Latin urban should extend"],
    };
    const selectionPlan = createSelectionPlanV2({
      prompt,
      brief: requestBrief,
      storefront: "us",
    });
    const shadow = compilePlaylistContractShadowV1({
      contractId: "contract:v5-smooth-reggaeton-recommendation",
      prompt,
      brief: requestBrief,
      selectionPlan,
    });
    const result = guidanceCheckpointV5({
      prompt,
      baseContract: shadow.contract,
      preservedTrackPredicate: shadow.preservedTrackPredicate,
      ambiguousScopeClauseIds: shadow.ambiguousScopeClauseIds,
      requestShape: "curated",
      capabilitySnapshotHash: "a".repeat(64),
      semanticConfigurationHash: "b".repeat(64),
      expectedRolloutGroup: "genre_scene",
    });
    const recommended = result.decisions[0]?.options.find(
      ({ id }) => id === "reggaeton_dembow_latin_urban",
    );
    expect(result.decisions[0]?.axis).toBe(
      "adjacent_latin_urban_scope",
    );
    expect(result.decisions[0]?.rolloutGroup).toBe("genre_scene");
    expect(result.decisions[0]?.simulations.every((simulation) => (
      simulation.baseRolloutGroup === "mood_activity_theme"
      && simulation.successorRolloutGroup === "genre_scene"
    ))).toBe(true);
    expect(recommended).toMatchObject({
      recommended: true,
      recommendationReason:
        "The request explicitly pairs reggaeton with adjacent Latin urban tracks, so this option preserves both while keeping a core-reggaeton majority.",
    });
  });

  test("asks exactly one correctness axis before a later nuance axis", () => {
    const base = contract();
    const criticalAmbiguities = [{
      key: "temporal_width" as const,
      summary: "The requested year could mean one year or a wider era.",
      blocking: true as const,
      trust: "server_derived" as const,
      resolution: "pending_question" as const,
      optionIds: ["era_year_only", "era_around_year", "era_full_decade"],
      yearValue: 2010,
    }];
    const correctness = guidanceCheckpointV5({
      prompt: "2010 Greek rap",
      baseContract: base,
      preservedTrackPredicate: base.trackPredicate,
      ambiguousScopeClauseIds: [],
      criticalAmbiguities,
      requestShape: "curated",
      capabilitySnapshotHash: "a".repeat(64),
      semanticConfigurationHash: "b".repeat(64),
    });
    expect(correctness.mode).toBe("correctness_blocking");
    expect(correctness.decisions).toHaveLength(1);
    expect(correctness.decisions[0]?.axis).toBe("temporal_width");

    const nuance = guidanceCheckpointV5({
      prompt: "2010 Greek rap",
      baseContract: base,
      preservedTrackPredicate: base.trackPredicate,
      ambiguousScopeClauseIds: [],
      criticalAmbiguities,
      requestShape: "curated",
      answeredAxes: ["temporal_width"],
      priorQuestionHashes: [
        correctness.decisions[0]!.questionHash,
      ],
      capabilitySnapshotHash: "a".repeat(64),
      semanticConfigurationHash: "b".repeat(64),
    });
    expect(nuance.mode).toBe("nuance_optional");
    expect(nuance.decisions).toHaveLength(1);
    expect(nuance.decisions[0]?.axis).toBe("familiarity_balance");
  });

  test("returns a typed execution decision after bounded axis exhaustion", () => {
    const base = contract();
    const exhausted = guidanceCheckpointV5({
      prompt: base.rawPrompt,
      baseContract: base,
      preservedTrackPredicate: base.trackPredicate,
      ambiguousScopeClauseIds: [],
      criticalAmbiguities: [],
      requestShape: "curated",
      answeredAxes: [
        "familiarity_balance",
        "playlist_flow",
        "artist_diversity",
        "selection_tiebreak",
      ],
      capabilitySnapshotHash: "a".repeat(64),
      semanticConfigurationHash: "b".repeat(64),
    });
    expect(exhausted).toMatchObject({
      mode: "execution_decision",
      decisions: [],
      interpretationSummary: {
        count: 25,
      },
    });
    expect(exhausted.executionDecision).toMatchObject({
      mode: "execution_decision",
      axis: "execution_readiness",
      options: [
        expect.objectContaining({
          id: "execute_confirmed_contract",
          action: {
            kind: "execute_confirmed_contract",
            startsResearch: true,
          },
        }),
        expect.objectContaining({
          id: "review_interpretation",
          action: {
            kind: "review_interpretation",
            startsResearch: false,
          },
        }),
        expect.objectContaining({
          id: "cancel_request",
          action: {
            kind: "cancel_request",
            startsResearch: false,
          },
        }),
      ],
    });
    expect(() => assertGuidanceExecutionDecisionV5(
      exhausted.executionDecision!,
    )).not.toThrow();
    expect(exhausted.checkpointHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("derives a relationship-scope question from an unresolved factual clause", () => {
    const base = artifactContract({
      rawPrompt: "Jazz connected to a named musical movement",
      clauses: [{
        id: "relationship:documented",
        kind: "factual_relationship",
        scope: "track",
        hardness: "hard",
        axis: "relationship",
        operator: "require",
        values: ["documented connection"],
        source: {
          provenance: "prompt",
          text: "connected to the named movement",
        },
        unknownPolicy: "defer",
      }],
      includeArtifactClausesInPredicate: true,
    });
    const decision = checkpoint(base).decisions[0]!;
    expect(decision).toMatchObject({
      axis: "relationship_scope",
      question:
        "Which kind of documented relationship should lead the playlist?",
    });
    expect(decision.options.map(({ id }) => id)).toEqual([
      "direct_recording_links",
      "artist_scene_links",
      "broader_documented_influence",
      "keep_current_interpretation",
    ]);
    expect(decision.simulations.filter(
      ({ executionEffect }) => executionEffect !== null,
    ).every(({ executionEffect }) => (
      executionEffect?.field === "rankingObjectives"
      && executionEffect.consumerId
        === "pipeline_v3_live_adapters:hostedDiscoveryRankingObjectivesV5"
    ))).toBe(true);
  });

  test("does not repeat relationship scope already resolved by a typed marker", () => {
    const base = artifactContract({
      rawPrompt: "Jazz recordings with a documented artist credit",
      clauses: [{
        id: "relationship:artist-credit",
        kind: "factual_relationship",
        scope: "track",
        hardness: "hard",
        axis: "relationship",
        operator: "require",
        values: ["relationship:artist_credit"],
        source: {
          provenance: "prompt",
          text: "documented artist credit",
        },
        unknownPolicy: "defer",
      }],
      includeArtifactClausesInPredicate: true,
    });
    expect(checkpoint(base).decisions[0]?.axis).toBe(
      "familiarity_balance",
    );
  });

  test("treats an explicit recordings-by-artist relationship as resolved", () => {
    const base = artifactContract({
      rawPrompt: "Exactly 25 studio recordings by Radiohead",
      clauses: [{
        id: "relationship:artist-recordings",
        kind: "factual_relationship",
        scope: "track",
        hardness: "hard",
        axis: "relationship",
        operator: "require",
        values: ["recordings by Radiohead"],
        source: {
          provenance: "prompt",
          text: "recordings by Radiohead",
        },
        unknownPolicy: "defer",
      }],
      includeArtifactClausesInPredicate: true,
    });
    expect(checkpoint(base).decisions[0]?.axis).toBe(
      "familiarity_balance",
    );
  });

  test("derives mood intensity from typed mood artifacts without reading prompt prose", () => {
    const base = artifactContract({
      rawPrompt: "A completely unrelated display title",
      clauses: [{
        id: "suitability:atmosphere",
        kind: "suitability",
        scope: "track",
        hardness: "soft",
        axis: "mood",
        operator: "prefer",
        values: ["after-hours atmosphere"],
        source: {
          provenance: "prompt",
          text: "after-hours atmosphere",
        },
      }],
    });
    const decision = checkpoint(base).decisions[0]!;
    expect(decision).toMatchObject({
      axis: "energy_mood_intensity",
      question: "How intense should the playlist’s confirmed mood feel?",
    });
    expect(decision.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "understated_intensity" }),
      expect.objectContaining({ id: "balanced_intensity" }),
      expect.objectContaining({ id: "vivid_intensity" }),
      expect.objectContaining({ id: "keep_current_interpretation" }),
    ]));
  });

  test("does not manufacture an intensity fork when typed values resolve it", () => {
    const base = artifactContract({
      rawPrompt: "An explicit energetic playlist",
      clauses: [{
        id: "suitability:energy",
        kind: "suitability",
        scope: "track",
        hardness: "soft",
        axis: "energy",
        operator: "prefer",
        values: ["high energetic intensity"],
        source: {
          provenance: "prompt",
          text: "high energetic intensity",
        },
      }],
    });
    expect(checkpoint(base).decisions[0]?.axis).toBe(
      "familiarity_balance",
    );
  });

  test("derives a recording-version preference only from multiple permitted alternatives", () => {
    const base = artifactContract({
      rawPrompt: "A catalog-compatible jazz playlist",
      clauses: [{
        id: "catalog:recording-version",
        kind: "catalog_version",
        scope: "track",
        hardness: "hard",
        axis: "recording_version",
        operator: "require",
        values: [
          "allow:canonical",
          "allow:live",
          "allow:acoustic",
          "prefer:live",
          "prefer:acoustic",
        ],
        source: {
          provenance: "migration",
          text: "Multiple permitted recording versions",
        },
        unknownPolicy: "reject",
      }],
      includeArtifactClausesInPredicate: true,
    });
    const decision = checkpoint(base).decisions[0]!;
    expect(decision).toMatchObject({
      axis: "recording_version_preference",
      question:
        "Which already-allowed recording version should rank first?",
    });
    expect(decision.options.map(({ id }) => id)).toEqual([
      "prefer_acoustic",
      "prefer_live",
      "balanced_allowed_versions",
      "keep_current_interpretation",
    ]);
    for (const option of decision.options.filter(
      ({ patch }) => patch.operations.length > 0,
    )) {
      const patch = compileGuidanceRoundPatchV3({
        base,
        questionSetHash: checkpoint(base).checkpointHash,
        questions: [publicGuidanceQuestionV5(decision)],
        answers: [{
          questionId: decision.id,
          optionId: option.id,
        }],
      });
      const successor = applyPlaylistContractPatchV1(base, patch!);
      expect(successor.requestedTrackCount).toBe(base.requestedTrackCount);
      expect(successor.trackPredicate).toEqual(base.trackPredicate);
      expect(successor.partialPolicy).toBe(base.partialPolicy);
      expect(successor.versions).toEqual(base.versions);
      expect(successor.clauses.filter(
        ({ hardness }) => hardness === "hard",
      )).toEqual(base.clauses.filter(
        ({ hardness }) => hardness === "hard",
      ));
    }
  });

  test("uses deterministic artifact guidance when the scout is unavailable", () => {
    const base = artifactContract({
      rawPrompt: "Display text without a mood keyword",
      clauses: [{
        id: "suitability:night",
        kind: "suitability",
        scope: "track",
        hardness: "soft",
        axis: "mood",
        operator: "prefer",
        values: ["night atmosphere"],
        source: {
          provenance: "prompt",
          text: "night atmosphere",
        },
      }],
    });
    const healthy = checkpoint(base).decisions[0]!;
    const failedScout = guidanceCheckpointV5({
      prompt: base.rawPrompt,
      baseContract: base,
      preservedTrackPredicate: base.trackPredicate,
      ambiguousScopeClauseIds: [],
      criticalAmbiguities: [],
      requestShape: "curated",
      capabilitySnapshotHash: "a".repeat(64),
      semanticConfigurationHash: "b".repeat(64),
      scoutFailure: "timeout",
    });
    expect(failedScout.decisions[0]?.questionHash).toBe(
      healthy.questionHash,
    );
    expect(failedScout.rejectedDecisionReasons).toMatchObject({
      "v5-scout-failure": "deterministic_server_axis_used",
    });
  });

  test("does not let a scout invent influence semantics", () => {
    const base = contract();
    const result = guidanceCheckpointV5({
      prompt: base.rawPrompt,
      baseContract: base,
      preservedTrackPredicate: base.trackPredicate,
      ambiguousScopeClauseIds: [],
      criticalAmbiguities: [],
      requestShape: "curated",
      capabilitySnapshotHash: "a".repeat(64),
      semanticConfigurationHash: "b".repeat(64),
      axisProposal: {
        schemaVersion: 1,
        source: "model_scout",
        axisId: "influence_scope",
        materialityScore: 99,
      },
    });
    expect(result.decisions[0]?.axis).toBe("familiarity_balance");
    expect(result.rejectedDecisionReasons).toMatchObject({
      "v5-scout-axis-proposal":
        "unsupported_or_unconfirmed_server_axis",
    });
  });

  test("lets validated scout output nominate only an existing server-owned axis", () => {
    const base = contract();
    const proposal = guidanceAxisProposalFromScoutV5([{
      id: "q1",
      decisionKey: "subject_sequence_flow",
      header: "Documented sequence",
      question: "Which documented sequence should shape the listening arc?",
      whyMaterial: "The answer changes only the ordering objective.",
      options: [
        {
          id: "q1-o1",
          label: "Smooth",
          description: "Use gradual transitions.",
          recommended: true,
          effect: {
            kind: "ordering_behavior",
            value: "gradual transitions",
            orderingBehavior: "smooth",
            geographyConstraint: null,
          },
        },
        {
          id: "q1-o2",
          label: "Contrast",
          description: "Use deliberate contrasts.",
          recommended: false,
          effect: {
            kind: "ordering_behavior",
            value: "deliberate contrasts",
            orderingBehavior: "contrast",
            geographyConstraint: null,
          },
        },
        {
          id: "q1-o3",
          label: "Editorial",
          description: "Use an editorial arc.",
          recommended: false,
          effect: {
            kind: "ordering_behavior",
            value: "editorial arc",
            orderingBehavior: "editorial",
            geographyConstraint: null,
          },
        },
      ],
    }]);
    expect(proposal).toMatchObject({
      schemaVersion: 1,
      source: "model_scout",
      axisId: "playlist_flow",
    });
    const result = guidanceCheckpointV5({
      prompt: base.rawPrompt,
      baseContract: base,
      preservedTrackPredicate: base.trackPredicate,
      ambiguousScopeClauseIds: [],
      criticalAmbiguities: [],
      requestShape: "curated",
      capabilitySnapshotHash: "a".repeat(64),
      semanticConfigurationHash: "b".repeat(64),
      axisProposal: proposal,
    });
    expect(result.decisions[0]?.axis).toBe("playlist_flow");
    expect(result.decisions[0]?.question).not.toBe(
      "Which documented sequence should shape the listening arc?",
    );
    expect(result.decisions[0]?.simulations.every(
      ({ executionEffect }) => (
        executionEffect === null
        || executionEffect.consumerId
          === "pipeline_v3_retrieval:playlistOptimizationConstraintsV3"
      ),
    )).toBe(true);
  });

  test("does not fabricate recommendation reasons for generic fallback options", () => {
    const decision = checkpoint(contract()).decisions[0]!;
    expect(decision.axis).toBe("familiarity_balance");
    expect(decision.options.every(({ recommended, recommendationReason }) => (
      recommended === false && recommendationReason === undefined
    ))).toBe(true);
  });

  test("preserves exact count and hard membership for every influence option", () => {
    const base = influenceContract("Influential Irish music");
    const decision = checkpoint(base).decisions[0]!;
    const nonNoopSimulations = decision.simulations.filter(
      ({ executionEffect }) => executionEffect !== null,
    );
    expect(nonNoopSimulations).toHaveLength(3);
    expect(nonNoopSimulations.every(({ executionEffect }) => (
      executionEffect?.field === "rankingObjectives"
      && executionEffect.consumerId
        === "pipeline_v3_live_adapters:hostedDiscoveryRankingObjectivesV5"
    ))).toBe(true);
    expect(new Set(nonNoopSimulations.map(
      ({ successorSemanticHash }) => successorSemanticHash,
    )).size).toBe(3);
    expect(decision.rolloutGroup).toBe("editorial_influence");
    expect(decision.simulations.every((simulation) => (
      simulation.baseRolloutGroup === "editorial_influence"
      && simulation.successorRolloutGroup === "editorial_influence"
    ))).toBe(true);

    for (const option of decision.options.filter(
      ({ patch }) => patch.operations.length > 0,
    )) {
      const question = publicGuidanceQuestionV5(decision);
      const patch = compileGuidanceRoundPatchV3({
        base,
        questionSetHash: checkpoint(base).checkpointHash,
        questions: [question],
        answers: [{
          questionId: question.id,
          optionId: option.id,
        }],
      });
      expect(patch).not.toBeNull();
      const successor = applyPlaylistContractPatchV1(base, patch!);
      expect(successor.requestedTrackCount).toBe(
        base.requestedTrackCount,
      );
      expect(successor.trackPredicate).toEqual(base.trackPredicate);
      expect(successor.clauses.filter(
        ({ hardness }) => hardness === "hard",
      )).toEqual(base.clauses.filter(
        ({ hardness }) => hardness === "hard",
      ));
      expect(successor.clauses).toContainEqual(
        expect.objectContaining({
          id: `guidance:v5:influence-scope:${option.id}`,
          axis: "influence",
          hardness: "soft",
          kind: "ranking_preference",
        }),
      );
    }
  });

  test("rejects public option simulations that do not match their typed patch", () => {
    const base = influenceContract("Influential Irish music");
    const decision = checkpoint(base).decisions[0]!;
    const question = publicGuidanceQuestionV5(decision);
    const tampered = structuredClone(question);
    tampered.options[0]!.optionSimulation!.patchHash = "0".repeat(64);
    expect(() => compileGuidanceRoundPatchV3({
      base,
      questionSetHash: checkpoint(base).checkpointHash,
      questions: [tampered],
      answers: [{
        questionId: tampered.id,
        optionId: tampered.options[0]!.id,
      }],
    })).toThrow("contract5_guidance_public_patch_hash_mismatch");
  });

  test("rejects a non-noop option whose query-plan compiler projection has no effect", () => {
    const base = influenceContract("Influential Irish music");
    const decision = structuredClone(checkpoint(base).decisions[0]!);
    const simulation = decision.simulations.find(
      ({ successorSemanticHash }) => successorSemanticHash !== null,
    )!;
    const mutableSimulation = simulation as unknown as {
      afterQueryPlanHash: string;
      simulationReceiptHash: string;
    };
    mutableSimulation.afterQueryPlanHash = simulation.beforeQueryPlanHash;
    const receiptBody = Object.fromEntries(
      Object.entries(simulation).filter(
        ([key]) => key !== "simulationReceiptHash",
      ),
    );
    mutableSimulation.simulationReceiptHash = sha256Hex(
      stableStringify(receiptBody),
    );
    expect(() => assertGuidanceDecisionV5(decision, base))
      .toThrow("guidance_v5_non_noop_simulation_invalid");
  });

  test("binds the rollout group into the public question and every option simulation", () => {
    const base = influenceContract("Influential Irish music");
    const decision = checkpoint(base).decisions[0]!;
    const question = publicGuidanceQuestionV5(decision);
    expect(question.rolloutGroup).toBe("editorial_influence");
    expect(question.options.every(({ optionSimulation }) => (
      optionSimulation?.baseRolloutGroup === "editorial_influence"
      && optionSimulation.successorRolloutGroup === "editorial_influence"
    ))).toBe(true);

    const tampered = structuredClone(question);
    tampered.rolloutGroup = "genre_scene";
    expect(() => compileGuidanceRoundPatchV3({
      base,
      questionSetHash: checkpoint(base).checkpointHash,
      questions: [tampered],
      answers: [{
        questionId: tampered.id,
        optionId: tampered.options[0]!.id,
      }],
    })).toThrow("guidance_v5_rollout_group_simulation_mismatch");
  });

  test("rejects a tampered registered-consumer receipt", () => {
    const base = influenceContract("Influential Irish music");
    const decision = checkpoint(base).decisions[0]!;
    const question = publicGuidanceQuestionV5(decision);
    const tampered = structuredClone(question);
    tampered.options[0]!.optionSimulation!.consumerReceipt!.receiptHash =
      "0".repeat(64);
    const optionSimulation = tampered.options[0]!.optionSimulation!;
    optionSimulation.simulationReceiptHash = sha256Hex(stableStringify({
      optionId: tampered.options[0]!.id,
      patchHash: optionSimulation.patchHash,
      baseRolloutGroup: optionSimulation.baseRolloutGroup,
      successorRolloutGroup: optionSimulation.successorRolloutGroup,
      successorSemanticHash: optionSimulation.successorSemanticHash,
      beforeQueryPlanHash: optionSimulation.beforeQueryPlanHash,
      afterQueryPlanHash: optionSimulation.afterQueryPlanHash,
      executionEffect: tampered.options[0]!.executionEffect,
      consumerReceipt: optionSimulation.consumerReceipt,
      valid: true,
    }));
    expect(() => compileGuidanceRoundPatchV3({
      base,
      questionSetHash: checkpoint(base).checkpointHash,
      questions: [tampered],
      answers: [{
        questionId: tampered.id,
        optionId: tampered.options[0]!.id,
      }],
    })).toThrow("guidance_v5_registered_consumer_mismatch");
  });

  test("selects another question instead of returning zero for curated work", () => {
    const base = contract();
    const result = guidanceCheckpointV5({
      prompt: base.rawPrompt,
      baseContract: base,
      preservedTrackPredicate: base.trackPredicate,
      ambiguousScopeClauseIds: [],
      criticalAmbiguities: [],
      requestShape: "curated",
      answeredAxes: ["familiarity_balance"],
      capabilitySnapshotHash: "a".repeat(64),
      semanticConfigurationHash: "b".repeat(64),
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.axis).toBe("playlist_flow");
  });

  test.each(["fixed_list", "factual"] as const)(
    "leads %s requests with a worker-consumed flow question",
    (requestShape) => {
      const base = artifactContract({
        rawPrompt: "A fixed or factual relationship collection",
        clauses: [{
          id: "relationship:unresolved",
          kind: "factual_relationship",
          scope: "track",
          hardness: "hard",
          axis: "relationship",
          operator: "require",
          values: ["documented connection"],
          source: {
            provenance: "prompt",
            text: "documented connection",
          },
          unknownPolicy: "defer",
        }],
        includeArtifactClausesInPredicate: true,
      });
      const result = guidanceCheckpointV5({
        prompt: base.rawPrompt,
        baseContract: base,
        preservedTrackPredicate: base.trackPredicate,
        ambiguousScopeClauseIds: [],
        criticalAmbiguities: [],
        requestShape,
        capabilitySnapshotHash: "a".repeat(64),
        semanticConfigurationHash: "b".repeat(64),
      });
      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0]).toMatchObject({
        axis: "playlist_flow",
        question:
          "How should the playlist develop from start to finish?",
      });
      expect(result.decisions[0]?.simulations.some(
        ({ executionEffect }) => (
          executionEffect?.field === "orderingPolicy"
          && executionEffect.consumerId
            === "pipeline_v3_retrieval:playlistOptimizationConstraintsV3"
        ),
      )).toBe(true);
    },
  );

  test("uses a subject-independent close-call axis for an otherwise saturated curated request", () => {
    const base = compilePlaylistContractRevisionV1({
      contractId: "contract:guidance-v5-saturated-curated",
      rawPrompt:
        "Exactly 25 Greek rap tracks with balanced discovery, broad artist variety, and a smooth arc",
      requestedTrackCount: 25,
      locale: "en",
      storefront: "us",
      clauses: [
        {
          id: "membership:genre",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "genre",
          operator: "require",
          values: ["Greek rap"],
          source: { provenance: "prompt", text: "Greek rap" },
        },
        {
          id: "preference:familiarity",
          kind: "ranking_preference",
          scope: "track",
          hardness: "soft",
          axis: "familiarity_bias",
          operator: "prefer",
          values: ["balanced familiarity"],
          source: { provenance: "prompt", text: "balanced discovery" },
        },
        {
          id: "preference:artist-diversity",
          kind: "ranking_preference",
          scope: "track",
          hardness: "soft",
          axis: "artist_diversity",
          operator: "prefer",
          values: ["broad artist variety"],
          source: { provenance: "prompt", text: "broad artist variety" },
        },
        {
          id: "preference:flow",
          kind: "ranking_preference",
          scope: "playlist",
          hardness: "soft",
          axis: "playlist_flow",
          operator: "prefer",
          values: ["smooth"],
          source: { provenance: "prompt", text: "smooth arc" },
        },
      ],
      trackPredicate: {
        op: "clause",
        clauseId: "membership:genre",
      },
      sequencingObjectives: [{
        id: "sequence:smooth",
        clauseId: "preference:flow",
        dimension: "playlist_flow",
        direction: "smooth",
        weight: 1,
        priority: 1,
      }],
    });
    const result = checkpoint(base);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({
      axis: "selection_tiebreak",
      question:
        "When several tracks fit equally well, what should break the tie?",
    });
    expect(result.decisions[0]?.options.map(({ id }) => id)).toEqual([
      "closest_musical_fit",
      "strongest_playlist_cohesion",
      "more_discovery",
      "keep_current_interpretation",
    ]);
    expect(result.decisions[0]?.simulations.filter(
      ({ executionEffect }) => executionEffect !== null,
    ).every(({ executionEffect }) => (
      executionEffect?.field === "rankingObjectives"
      && executionEffect.consumerId
        === "pipeline_v3_live_adapters:hostedDiscoveryRankingObjectivesV5"
    ))).toBe(true);
  });

  test("uses an execution decision when an exact fixed request has no faithful musical fork", () => {
    const base = compilePlaylistContractRevisionV1({
      contractId: "contract:guidance-v5-saturated-fixed",
      rawPrompt: "Use these exact tracks in this exact order",
      requestedTrackCount: 3,
      locale: "en",
      storefront: "us",
      clauses: [
        {
          id: "membership:fixed",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "fixed_track_list",
          operator: "require",
          values: ["track-a", "track-b", "track-c"],
          source: {
            provenance: "prompt",
            text: "these exact tracks",
          },
        },
        {
          id: "ordering:fixed",
          kind: "ranking_preference",
          scope: "playlist",
          hardness: "soft",
          axis: "playlist_flow",
          operator: "prefer",
          values: ["exact user order"],
          source: {
            provenance: "prompt",
            text: "this exact order",
          },
        },
      ],
      trackPredicate: {
        op: "clause",
        clauseId: "membership:fixed",
      },
      sequencingObjectives: [{
        id: "sequence:fixed",
        clauseId: "ordering:fixed",
        dimension: "playlist_flow",
        direction: "editorial",
        weight: 1,
        priority: 1,
      }],
    });
    const checkpointResult = guidanceCheckpointV5({
      prompt: base.rawPrompt,
      baseContract: base,
      preservedTrackPredicate: base.trackPredicate,
      ambiguousScopeClauseIds: [],
      criticalAmbiguities: [],
      requestShape: "fixed_list",
      capabilitySnapshotHash: "a".repeat(64),
      semanticConfigurationHash: "b".repeat(64),
    });
    expect(checkpointResult).toMatchObject({
      mode: "execution_decision",
      decisions: [],
    });
    const decision = checkpointResult.executionDecision!;
    const publicDecision = publicGuidanceExecutionDecisionV5(decision);
    expect(publicDecision).toMatchObject({
      guidanceMode: "execution_decision",
      questionHash: decision.decisionHash,
    });
    expect("contractPatch" in publicDecision).toBe(false);
    expect(publicDecision.options.every((option) => (
      option.contractPatch === undefined
      && option.executionAction !== undefined
    ))).toBe(true);
    expect(guidanceExecutionDecisionV5FromPublicQuestion(
      publicDecision,
    )).toEqual(decision);
    expect(() => compileGuidanceRoundPatchV3({
      base,
      questionSetHash: checkpointResult.checkpointHash,
      questions: [publicDecision],
      answers: [{
        questionId: publicDecision.id,
        optionId: "execute_confirmed_contract",
      }],
    })).toThrow("invalid_contract5_guidance_question");

    const review = compileGuidanceExecutionActionV5(decision, {
      decisionHash: decision.decisionHash,
      optionId: "review_interpretation",
    });
    expect(review).toMatchObject({
      kind: "review_interpretation",
      startsResearch: false,
    });
    const execute = compileGuidanceExecutionActionV5(decision, {
      decisionHash: decision.decisionHash,
      optionId: "execute_confirmed_contract",
    });
    expect(execute).toMatchObject({
      kind: "execute_confirmed_contract",
      startsResearch: true,
    });
  });

  test("normalizes answered axes, rejects reused hashes, and stops at the root round bound", () => {
    const base = contract();
    const initial = checkpoint(base);
    const afterNormalizedAnswer = guidanceCheckpointV5({
      prompt: base.rawPrompt,
      baseContract: base,
      preservedTrackPredicate: base.trackPredicate,
      ambiguousScopeClauseIds: [],
      criticalAmbiguities: [],
      requestShape: "curated",
      answeredAxes: ["Familiarity Balance"],
      priorQuestionHashes: [initial.decisions[0]!.questionHash],
      capabilitySnapshotHash: "a".repeat(64),
      semanticConfigurationHash: "b".repeat(64),
    });
    expect(afterNormalizedAnswer.decisions[0]?.axis).toBe("playlist_flow");
    expect(afterNormalizedAnswer.rejectedDecisionReasons).toMatchObject({
      "v5-nuance:familiarity-balance": "axis_already_answered",
    });

    const afterReusedHash = guidanceCheckpointV5({
      prompt: base.rawPrompt,
      baseContract: base,
      preservedTrackPredicate: base.trackPredicate,
      ambiguousScopeClauseIds: [],
      criticalAmbiguities: [],
      requestShape: "curated",
      priorQuestionHashes: [initial.decisions[0]!.questionHash],
      capabilitySnapshotHash: "a".repeat(64),
      semanticConfigurationHash: "b".repeat(64),
    });
    expect(afterReusedHash.decisions[0]?.axis).toBe("playlist_flow");
    expect(afterReusedHash.rejectedDecisionReasons).toMatchObject({
      "v5-nuance:familiarity-balance":
        "question_hash_already_used",
    });

    const capped = guidanceCheckpointV5({
      prompt: base.rawPrompt,
      baseContract: base,
      preservedTrackPredicate: base.trackPredicate,
      ambiguousScopeClauseIds: [],
      criticalAmbiguities: [],
      requestShape: "curated",
      priorQuestionHashes: Array.from(
        { length: GUIDANCE_MAX_QUESTION_ROUNDS_V5 },
        (_, index) => String(index).padStart(64, "0"),
      ),
      capabilitySnapshotHash: "a".repeat(64),
      semanticConfigurationHash: "b".repeat(64),
    });
    expect(capped).toMatchObject({
      mode: "execution_decision",
      decisions: [],
    });
    expect(Object.values(capped.rejectedDecisionReasons)).toContain(
      "root_question_round_limit",
    );
  });

  test("never authorizes execution when a correctness axis is bounded but unresolved", () => {
    const base = contract();
    const unresolved = guidanceCheckpointV5({
      prompt: "2010 Greek rap",
      baseContract: base,
      preservedTrackPredicate: base.trackPredicate,
      ambiguousScopeClauseIds: [],
      criticalAmbiguities: [{
        key: "temporal_width",
        summary: "The requested year could mean one year or a wider era.",
        blocking: true,
        trust: "server_derived",
        resolution: "pending_question",
        optionIds: [
          "era_year_only",
          "era_around_year",
          "era_full_decade",
        ],
        yearValue: 2010,
      }],
      requestShape: "curated",
      clarificationAttemptsByAxis: { temporal_width: 2 },
      capabilitySnapshotHash: "a".repeat(64),
      semanticConfigurationHash: "b".repeat(64),
    });
    expect(unresolved).toMatchObject({
      mode: "execution_decision",
      decisions: [],
      executionDecision: {
        id: "v5-execution:unresolved-review",
      },
      rejectedDecisionReasons: {
        "v4-critical:temporal_width": "clarification_attempt_limit",
      },
    });
    expect(unresolved.executionDecision?.options.map(
      ({ action }) => action.kind,
    )).toEqual(["review_interpretation", "cancel_request"]);
    expect(unresolved.executionDecision?.options.some(
      ({ action }) => action.startsResearch,
    )).toBe(false);
    const publicDecision = publicGuidanceExecutionDecisionV5(
      unresolved.executionDecision!,
    );
    expect(guidanceExecutionDecisionV5FromPublicQuestion(
      publicDecision,
    )).toEqual(unresolved.executionDecision);
  });

  test.each([
    "curated",
    "fully_explicit",
    "fixed_list",
    "factual",
  ] as const)(
    "never produces a zero-action initial checkpoint for %s work",
    (requestShape) => {
      const base = contract();
      const result = guidanceCheckpointV5({
        prompt: base.rawPrompt,
        baseContract: base,
        preservedTrackPredicate: base.trackPredicate,
        ambiguousScopeClauseIds: [],
        criticalAmbiguities: [],
        requestShape,
        capabilitySnapshotHash: "a".repeat(64),
        semanticConfigurationHash: "b".repeat(64),
      });
      expect(result.mode).not.toBe("interpretation_confirmation");
      expect(
        result.decisions.length === 1
        || result.executionDecision !== undefined,
      ).toBe(true);
    },
  );

  test.each([
    "timeout",
    "malformed_output",
    "budget_exhausted",
    "provider_unavailable",
  ] as const)(
    "uses the same deterministic subject-aware axis after scout %s",
    (scoutFailure) => {
      const base = influenceContract(
        "A private display label that contains no influence keyword",
      );
      const result = guidanceCheckpointV5({
        prompt: base.rawPrompt,
        baseContract: base,
        preservedTrackPredicate: base.trackPredicate,
        ambiguousScopeClauseIds: [],
        criticalAmbiguities: [],
        requestShape: "curated",
        capabilitySnapshotHash: "a".repeat(64),
        semanticConfigurationHash: "b".repeat(64),
        scoutFailure,
      });
      expect(result.decisions[0]).toMatchObject({
        axis: "influence_scope",
        question:
          "Which kind of influence should lead the playlist?",
      });
      expect(result.rejectedDecisionReasons).toMatchObject({
        "v5-scout-failure": "deterministic_server_axis_used",
      });
    },
  );

  test("generalizes typed influence guidance across a seeded paraphrase matrix", () => {
    const openings = [
      "A definitive survey of",
      "Please explore",
      "Build a playlist around",
      "I want to understand",
      "Curate",
    ];
    const subjects = [
      "Irish recordings",
      "music from Ireland",
      "the Irish musical canon",
      "Ireland’s musical legacy",
    ];
    const endings = [
      ".",
      " — 25 tracks.",
      "!",
      " for a first-time listener.",
    ];
    const prompts = Array.from({ length: 20 }, (_, index) => (
      `${openings[(index * 7) % openings.length]} ${
        subjects[(index * 11) % subjects.length]
      }${endings[(index * 13) % endings.length]}`
    ));
    for (const prompt of prompts) {
      const result = checkpoint(influenceContract(prompt));
      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0]?.axis).toBe("influence_scope");
      expect(result.decisions[0]?.options.map(({ id }) => id)).toEqual([
        "within_scope_cultural_impact",
        "global_influence",
        "balanced_influence",
        "keep_current_interpretation",
      ]);
    }
  });
});
