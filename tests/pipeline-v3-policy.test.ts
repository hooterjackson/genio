import { describe, expect, test } from "vitest";
import {
  createPipelinePolicySnapshotV3,
  pipelineV3ModelRoute,
  pipelineV3ModelRouteFromPolicySnapshot,
  pipelineV3ModelRoutingSignalsFromScoutTelemetry,
  sequenceCandidatesV3,
  selectCandidatesV3,
  validateGuidedScoutV3,
  validateGuidedScoutUsageV3,
  validateProductionGuidedScoutV3,
  type GuidedQuestionV3,
  type SelectionCandidateV3,
} from "../server/pipeline-v3-policy.ts";
import { createRunSpecV3, type MembershipPredicateV3 } from "../server/selection-plan-v3.ts";
import type { PlaylistGuidanceQuestion } from "../shared/types.ts";
import { resolveRunSpecV3 } from "../server/selection-plan-v3.ts";

const source = { url: "https://example.org/house-history", title: "House history" };

function membership(id: string, value: string): MembershipPredicateV3 {
  return {
    id,
    axis: "genre",
    operator: "require",
    values: [value],
    source: "guided_answer",
    reason: "This answer changes genre membership.",
  };
}

function question(overrides: Partial<GuidedQuestionV3> = {}): GuidedQuestionV3 {
  return {
    id: "question:house_semantics",
    decisionKey: "house_semantics",
    header: "Meaning",
    question: "Which meaning of house should define the playlist?",
    whyMaterial: "The answer selects different recordings and evidence sources.",
    groundingSourceUrls: [source.url],
    options: [
      {
        id: "house_genre",
        label: "House music",
        description: "Use the electronic dance genre.",
        recommended: true,
        effects: [{ kind: "membership", predicate: membership("genre:house", "house music") }],
      },
      {
        id: "house_theme",
        label: "Houses and homes",
        description: "Use a lyrical theme about homes.",
        recommended: false,
        effects: [{ kind: "membership", predicate: { ...membership("theme:home", "houses and homes"), axis: "theme" } }],
      },
      {
        id: "both",
        label: "Both meanings",
        description: "Require a documented overlap.",
        recommended: false,
        effects: [
          { kind: "membership", predicate: membership("genre:house-both", "house music") },
          { kind: "membership", predicate: { ...membership("theme:home-both", "houses and homes"), axis: "theme" } },
        ],
      },
    ],
    ...overrides,
  };
}

function productionQuestion(overrides: Partial<PlaylistGuidanceQuestion> = {}): PlaylistGuidanceQuestion {
  return {
    id: "q1",
    decisionKey: "documented_house_lineage",
    header: "House lineage",
    question: "Which documented house-music lineage should guide discovery?",
    whyMaterial: "Chicago foundations, acid house, and deep house produce different candidate pools.",
    grounding: {
      summary: "The source documents distinct historical lineages within house music.",
      sourceUrls: [source.url],
    },
    options: [
      {
        id: "q1-o1",
        label: "Chicago foundations",
        description: "Prioritize the earliest Chicago network.",
        recommended: true,
        effect: { kind: "subscene_focus", value: "Chicago house foundations", orderingBehavior: null },
      },
      {
        id: "q1-o2",
        label: "Acid house",
        description: "Prioritize acid-house recordings.",
        recommended: false,
        effect: { kind: "subscene_focus", value: "acid house lineage", orderingBehavior: null },
      },
      {
        id: "q1-o3",
        label: "Deep house",
        description: "Prioritize deep-house recordings.",
        recommended: false,
        effect: { kind: "subscene_focus", value: "deep house lineage", orderingBehavior: null },
      },
    ],
    ...overrides,
  };
}

function candidate(
  id: string,
  artist: string,
  album: string,
  genre: string,
  relevance: number,
): SelectionCandidateV3<string> {
  return {
    id,
    value: id,
    artist,
    album,
    year: null,
    scene: null,
    memberships: { genre: [genre] },
    objectiveScores: { relevance },
    sourceRank: Number(id.replace(/\D/gu, "")) || 0,
  };
}

describe("Pipeline V3 guided scout policy", () => {
  test("accepts zero questions when there is no critical ambiguity", () => {
    const spec = createRunSpecV3({ prompt: "50 house music tracks", requestedTrackCount: 50 });
    const result = validateGuidedScoutV3({
      spec,
      questions: [],
      sources: [],
      usage: { searchCount: 0, durationMs: 20, costUsd: 0 },
    });
    expect(result).toMatchObject({ canStartResearch: true, acceptedQuestions: [], blockingAmbiguityKeys: [] });
  });

  test("keeps valid questions when a sibling fails validation", () => {
    const spec = createRunSpecV3({ prompt: "Make me a house playlist", requestedTrackCount: 25 });
    const invalid = question({
      id: "question:bad",
      decisionKey: "secondary_preference",
      groundingSourceUrls: ["https://invented.example/not-returned"],
    });
    const result = validateGuidedScoutV3({
      spec,
      questions: [question(), invalid],
      sources: [source],
      usage: { searchCount: 1, durationMs: 2_500, costUsd: 0.01 },
    });
    expect(result.acceptedQuestions.map(({ id }) => id)).toEqual(["question:house_semantics"]);
    expect(result.questionResults[1]).toMatchObject({ accepted: false, issues: ["invalid_source_grounding"] });
    expect(result.canStartResearch).toBe(true);
  });

  test("blocks unresolved critical ambiguity and enforces the scout contract", () => {
    const spec = createRunSpecV3({ prompt: "Make me a house playlist", requestedTrackCount: 25 });
    const unresolved = validateGuidedScoutV3({
      spec,
      questions: [],
      sources: [],
      usage: { searchCount: 0, durationMs: 100, costUsd: 0 },
    });
    expect(unresolved.canStartResearch).toBe(false);
    expect(unresolved.blockingAmbiguityKeys).toEqual(["house_semantics"]);
    expect(validateGuidedScoutUsageV3({ searchCount: 3, durationMs: 10_001, costUsd: 0.031 })).toEqual([
      "search_limit_exceeded",
      "duration_limit_exceeded",
      "cost_limit_exceeded",
    ]);
  });

  test("rejects generic or non-material option sets", () => {
    const spec = createRunSpecV3({ prompt: "Make me a house playlist", requestedTrackCount: 25 });
    const generic = question({
      options: question().options.map((option) => ({ ...option, effects: [] })),
    });
    const result = validateGuidedScoutV3({
      spec,
      questions: [generic],
      sources: [source],
      usage: { searchCount: 1, durationMs: 1_000, costUsd: 0.01 },
    });
    expect(result.acceptedQuestions).toEqual([]);
    expect(result.questionResults[0]!.issues).toContain("option_must_change_candidate_pool_or_rank");
  });

  test("validates the production scout shape independently and preserves a valid sibling", () => {
    const spec = createRunSpecV3({ prompt: "50 house music tracks", requestedTrackCount: 50 });
    const extraSources = [
      source,
      { url: "https://example.org/acid-house", title: "Acid house" },
      { url: "https://example.org/deep-house", title: "Deep house" },
    ];
    const invalid = productionQuestion({
      id: "q2",
      decisionKey: "house_regional_axis",
      grounding: {
        summary: "This sibling cites too many sources for the bounded V3 question contract.",
        sourceUrls: extraSources.map(({ url }) => url),
      },
      options: productionQuestion().options.map((option, index) => ({
        ...option,
        id: `q2-o${index + 1}`,
      })),
    });
    const result = validateProductionGuidedScoutV3({
      spec,
      questions: [productionQuestion(), invalid],
      sourceHints: extraSources.map((item) => ({ ...item, excerpt: "Provider-attested context." })),
      usage: { searchCount: 2, durationMs: 9_500, costUsd: 0.03 },
    });
    expect(result.acceptedQuestions.map(({ id }) => id)).toEqual(["q1"]);
    expect(result.questionResults[1]).toMatchObject({
      questionId: "q2",
      accepted: false,
      issues: ["invalid_source_grounding"],
    });
  });

  test("requires typed answer effects and drops all optional questions after a scout overrun", () => {
    const spec = createRunSpecV3({ prompt: "50 house music tracks", requestedTrackCount: 50 });
    const untyped = productionQuestion({
      options: productionQuestion().options.map((option) => {
        const withoutEffect = { ...option };
        Reflect.deleteProperty(withoutEffect, "effect");
        return withoutEffect;
      }),
    });
    const invalidMapping = validateProductionGuidedScoutV3({
      spec,
      questions: [untyped],
      sourceHints: [{ ...source, excerpt: "Provider-attested context." }],
      usage: { searchCount: 1, durationMs: 1_000, costUsd: 0.01 },
    });
    expect(invalidMapping.acceptedQuestions).toEqual([]);
    expect(invalidMapping.questionResults[0]!.issues).toContain("option_must_change_candidate_pool_or_rank");

    const overrun = validateProductionGuidedScoutV3({
      spec,
      questions: [productionQuestion()],
      sourceHints: [{ ...source, excerpt: "Provider-attested context." }],
      usage: { searchCount: 2, durationMs: 10_001, costUsd: 0.03 },
    });
    expect(overrun.acceptedQuestions).toEqual([]);
    expect(overrun.usageIssues).toEqual(["duration_limit_exceeded"]);
  });
});

describe("Pipeline V3 model routing", () => {
  test("uses exact provider-catalog IDs and rejects unavailable dated model IDs", () => {
    expect(pipelineV3ModelRoute({}, { FAST_RESEARCH_MODEL: "gpt-5.6-luna" })).toMatchObject({
      tier: "baseline",
      providerModelId: "gpt-5.6-luna",
      escalationProviderModelId: "gpt-5.6-terra",
      resolutionMode: "provider_managed_alias",
      modelCatalogValidatedAt: "2026-07-20T00:00:00.000Z",
      reason: "baseline",
      escalationCount: 0,
    });
    expect(() => pipelineV3ModelRoute({}, {
      PIPELINE_V3_BASELINE_MODEL_ID: "gpt-5.6-luna-2026-07-15",
    })).toThrow(/validated allowlist/i);
  });

  test("escalates once for low confidence or a failed structured repair", () => {
    const env = {
      PIPELINE_V3_BASELINE_MODEL_ID: "gpt-5.6-luna",
      PIPELINE_V3_ESCALATION_MODEL_ID: "gpt-5.6-terra",
      PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT: "2026-07-20T14:30:00.000Z",
    };
    expect(pipelineV3ModelRoute({ interpretationConfidence: 0.59 }, env)).toMatchObject({
      tier: "escalation",
      providerModelId: "gpt-5.6-terra",
      reason: "interpretation_low_confidence",
      escalationCount: 1,
    });
    expect(pipelineV3ModelRoute({ structuredRepairFailures: 9 }, env)).toMatchObject({
      tier: "escalation",
      reason: "structured_repair_failed",
      structuredRepairFailures: 9,
      escalationCount: 1,
    });
  });

  test("persists the chosen route and both permitted provider IDs in the immutable policy", () => {
    const plan = resolveRunSpecV3(createRunSpecV3({
      prompt: "50 disco songs",
      requestedTrackCount: 50,
    }), []);
    const policy = createPipelinePolicySnapshotV3({
      plan,
      environment: {
        PIPELINE_V3_BASELINE_MODEL_ID: "gpt-5.6-luna",
        PIPELINE_V3_ESCALATION_MODEL_ID: "gpt-5.6-terra",
        PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT: "2026-07-20T14:30:00.000Z",
      },
      modelRoutingSignals: { structuredRepairFailures: 1 },
      capturedAt: "2026-07-20T12:00:00.000Z",
    });
    expect(policy.executionPolicy).toMatchObject({
      kind: "corpus_first_v3",
      model: "gpt-5.6-terra",
      modelRoute: {
        providerModelId: "gpt-5.6-terra",
        baselineProviderModelId: "gpt-5.6-luna",
        escalationProviderModelId: "gpt-5.6-terra",
        resolutionMode: "provider_managed_alias",
        modelCatalogValidatedAt: "2026-07-20T14:30:00.000Z",
        escalationCount: 1,
      },
    });

    expect(pipelineV3ModelRouteFromPolicySnapshot(policy)).toMatchObject({
      providerModelId: "gpt-5.6-terra",
      baselineProviderModelId: "gpt-5.6-luna",
      escalationProviderModelId: "gpt-5.6-terra",
      resolutionMode: "provider_managed_alias",
      modelCatalogValidatedAt: "2026-07-20T14:30:00.000Z",
    });

    const unavailableDatedModel = structuredClone(policy) as unknown as {
      executionPolicy: {
        model: string;
        modelRoute: { providerModelId: string };
      };
    };
    unavailableDatedModel.executionPolicy.model = "gpt-5.6-terra-2026-07-15";
    unavailableDatedModel.executionPolicy.modelRoute.providerModelId = "gpt-5.6-terra-2026-07-15";
    expect(() => pipelineV3ModelRouteFromPolicySnapshot(unavailableDatedModel as never)).toThrow(
      /immutable model route failed validation/i,
    );

    const invalidCatalogTimestamp = structuredClone(policy) as unknown as {
      executionPolicy: {
        modelRoute: { modelCatalogValidatedAt: string };
      };
    };
    invalidCatalogTimestamp.executionPolicy.modelRoute.modelCatalogValidatedAt = "yesterday";
    expect(() => pipelineV3ModelRouteFromPolicySnapshot(invalidCatalogTimestamp as never)).toThrow(
      /immutable model route failed validation/i,
    );
  });

  test("routes only local scout contract failures or explicit low confidence to escalation", () => {
    expect(pipelineV3ModelRoutingSignalsFromScoutTelemetry({
      generationMode: "scout_unavailable",
      acceptedQuestionCount: 0,
      validationIssues: ["scout:provider_http_503", "scout:timeout"],
    })).toEqual({ interpretationConfidence: "medium", structuredRepairFailures: 0 });
    expect(pipelineV3ModelRoutingSignalsFromScoutTelemetry({
      generationMode: "scout_unavailable",
      acceptedQuestionCount: 0,
      validationIssues: ["interpretation:invalid_structured_output"],
    })).toEqual({ interpretationConfidence: "low", structuredRepairFailures: 1 });
    expect(pipelineV3ModelRoutingSignalsFromScoutTelemetry({
      generationMode: "grounded_scout",
      acceptedQuestionCount: 2,
      validationIssues: ["scout:low_confidence"],
    })).toEqual({ interpretationConfidence: "low", structuredRepairFailures: 0 });
  });

  test("persists the scout-selected provider route instead of recomputing mutable aliases", () => {
    const plan = resolveRunSpecV3(createRunSpecV3({
      prompt: "50 French jazz tracks",
      requestedTrackCount: 50,
    }), [{ key: "french_jazz_scope", optionId: "french_scene" }]);
    const signals = pipelineV3ModelRoutingSignalsFromScoutTelemetry({
      generationMode: "scout_unavailable",
      acceptedQuestionCount: 0,
      validationIssues: ["interpretation:invalid_structured_output"],
    });
    const policy = createPipelinePolicySnapshotV3({ plan, modelRoutingSignals: signals });
    expect(policy.executionPolicy).toMatchObject({
      kind: "corpus_first_v3",
      model: "gpt-5.6-terra",
      modelRoute: {
        tier: "escalation",
        reason: "structured_repair_failed",
        escalationCount: 1,
      },
    });
  });
});

describe("Pipeline V3 selection and sequencing", () => {
  test("applies membership before ranking and never ranks an ineligible track into the set", () => {
    const candidates = [
      candidate("1", "Wrong but famous", "A", "rock", 1),
      candidate("2", "Eligible", "B", "house music", 0.6),
      candidate("3", "Also eligible", "C", "house music", 0.5),
    ];
    const result = selectCandidatesV3({
      candidates,
      membershipPredicates: [membership("house-only", "house music")],
      rankingObjectives: [{
        id: "relevance",
        dimension: "relevance",
        direction: "maximize",
        weight: 1,
        relaxationRank: null,
        values: [],
        reason: "Rank qualified tracks.",
      }],
      target: 2,
    });
    expect(result.selected.map(({ id }) => id)).toEqual(["2", "3"]);
    expect(result.rejected).toEqual([expect.objectContaining({
      candidate: expect.objectContaining({ id: "1" }),
      failedPredicateIds: ["house-only"],
    })]);
  });

  test("returns a transparent shortfall without weakening membership", () => {
    const result = selectCandidatesV3({
      candidates: [candidate("1", "One", "A", "jazz", 0.9)],
      membershipPredicates: [membership("house-only", "house music")],
      rankingObjectives: [],
      target: 10,
    });
    expect(result).toMatchObject({ selected: [], shortfall: 10 });
  });

  test("spaces artists and albums deterministically when alternatives exist", () => {
    const input = [
      candidate("1", "Artist A", "Album A", "house", 1),
      candidate("2", "Artist A", "Album A", "house", 0.9),
      candidate("3", "Artist B", "Album B", "house", 0.8),
      candidate("4", "Artist C", "Album C", "house", 0.7),
    ];
    const sequenced = sequenceCandidatesV3(input);
    expect(sequenced.map(({ id }) => id)).toEqual(["1", "3", "2", "4"]);
    for (let index = 1; index < sequenced.length; index += 1) {
      expect(sequenced[index]!.artist).not.toBe(sequenced[index - 1]!.artist);
    }
  });
});
