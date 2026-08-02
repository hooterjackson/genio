import {
  createGuidanceDecisionV4,
  guidanceCheckpointV4,
  type GuidanceCheckpointV4,
  type GuidanceDecisionV4,
  type GuidanceInterpretationSummaryContextV4,
} from "./adaptive-guidance-v4.ts";
import type {
  GuidanceOptionV3,
  PlaylistInterpretationSummaryV1,
} from "./adaptive-guidance-v3.ts";
import {
  applyPlaylistContractPatchV1,
  type PlaylistContractClauseDraftV1,
  type PlaylistContractPatchOperationV1,
  type PlaylistContractRevisionV1,
} from "./playlist-contract-v1.ts";
import type { CriticalAmbiguityV3 } from "./selection-plan-v3.ts";
import { sha256Hex, stableStringify } from "./security.ts";

export const ADAPTIVE_GUIDANCE_POLICY_VERSION_V5 =
  "adaptive_guidance_v5" as const;
export const GUIDANCE_AXIS_REGISTRY_VERSION_V5 =
  "guidance_axis_registry_v5_1" as const;
export const GUIDANCE_OPTION_SIMULATION_POLICY_VERSION_V5 =
  "guidance_option_simulation_v5_1" as const;

export type GuidanceExecutionFieldV5 =
  | "membershipPredicates"
  | "rankingObjectives"
  | "orderingPolicy"
  | "playlistQuotaRules"
  | "playlistQualityPolicy";

export interface GuidanceExecutionEffectV5 {
  readonly field: GuidanceExecutionFieldV5;
  readonly consumerId: string;
  readonly effectHash: string;
}

export interface GuidanceOptionSimulationV5 {
  readonly optionId: string;
  readonly patchHash: string;
  readonly successorSemanticHash: string | null;
  readonly executionEffect: GuidanceExecutionEffectV5 | null;
  readonly valid: true;
}

export interface GuidanceDecisionV5 {
  readonly schemaVersion: 5;
  readonly policyVersion: typeof ADAPTIVE_GUIDANCE_POLICY_VERSION_V5;
  readonly mode: "correctness_blocking" | "nuance_optional";
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly axis: string;
  readonly trigger: "correctness" | "yield_risk" | "nuance";
  readonly criticality: "required" | "optional";
  readonly selectionMode: "single" | "multiple";
  readonly allowCustom: boolean;
  readonly baseContractRevisionId: string;
  readonly baseContractSemanticHash: string;
  readonly whyMaterial: string;
  readonly allowedPatchOperations: readonly string[];
  readonly affectedClauseIds: readonly string[];
  readonly materialityScore: number;
  readonly interpretationSummary?: PlaylistInterpretationSummaryV1;
  readonly options: readonly GuidanceOptionV3[];
  readonly axisRegistryVersion: typeof GUIDANCE_AXIS_REGISTRY_VERSION_V5;
  readonly simulationPolicyVersion:
    typeof GUIDANCE_OPTION_SIMULATION_POLICY_VERSION_V5;
  readonly capabilitySnapshotHash: string;
  readonly semanticConfigurationHash: string;
  readonly simulations: readonly GuidanceOptionSimulationV5[];
  readonly questionHash: string;
}

export interface GuidanceCheckpointV5 {
  readonly policyVersion: typeof ADAPTIVE_GUIDANCE_POLICY_VERSION_V5;
  readonly mode: "correctness_blocking" | "nuance_optional";
  readonly decisions: readonly GuidanceDecisionV5[];
  readonly interpretationSummary: PlaylistInterpretationSummaryV1;
  readonly rejectedDecisionReasons: Readonly<Record<string, string>>;
  readonly checkpointHash: string;
}

interface GuidanceAxisDefinitionV5 {
  readonly id: "familiarity_balance" | "playlist_flow" | "artist_diversity";
  readonly executionField: GuidanceExecutionFieldV5;
  readonly consumerId: string;
}

export const GUIDANCE_AXIS_REGISTRY_V5: Readonly<
  Record<GuidanceAxisDefinitionV5["id"], GuidanceAxisDefinitionV5>
> = Object.freeze({
  familiarity_balance: Object.freeze({
    id: "familiarity_balance",
    executionField: "rankingObjectives",
    consumerId: "pipeline_v3_retrieval:familiarityBoundsV3",
  }),
  playlist_flow: Object.freeze({
    id: "playlist_flow",
    executionField: "orderingPolicy",
    consumerId: "pipeline_v3_retrieval:playlistOptimizationConstraintsV3",
  }),
  artist_diversity: Object.freeze({
    id: "artist_diversity",
    executionField: "rankingObjectives",
    consumerId: "playlist_contract_execution_bridge:canonicalRankingObjectives",
  }),
});

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort();
}

function executionFieldForOperations(
  operations: readonly PlaylistContractPatchOperationV1[],
): GuidanceExecutionFieldV5 {
  if (operations.some(({ op }) => op === "set_sequencing_objectives")) {
    return "orderingPolicy";
  }
  if (operations.some(({ op }) => op === "set_playlist_constraints")) {
    return "playlistQuotaRules";
  }
  if (operations.some(({ op }) => op === "set_quality_policy")) {
    return "playlistQualityPolicy";
  }
  if (operations.some((operation) => (
    (operation.op === "add_clause" || operation.op === "replace_clause")
    && operation.clause.hardness === "soft"
    && (
      operation.clause.kind === "ranking_preference"
      || operation.clause.kind === "suitability"
    )
  ))) {
    return "rankingObjectives";
  }
  return "membershipPredicates";
}

function consumerForField(
  axis: string,
  field: GuidanceExecutionFieldV5,
): string {
  const registered = GUIDANCE_AXIS_REGISTRY_V5[
    axis as GuidanceAxisDefinitionV5["id"]
  ];
  if (registered?.executionField === field) return registered.consumerId;
  if (field === "orderingPolicy") {
    return "pipeline_v3_retrieval:playlistOptimizationConstraintsV3";
  }
  if (field === "rankingObjectives") {
    return "playlist_contract_execution_bridge:canonicalRankingObjectives";
  }
  if (field === "playlistQuotaRules") {
    return "playlist_contract_execution_bridge:canonicalQuotaRules";
  }
  if (field === "playlistQualityPolicy") {
    return "pipeline_v3_retrieval:centralQualityFloor";
  }
  return "playlist_contract_execution_bridge:canonicalMembershipPredicates";
}

function simulateOptions(input: {
  baseContract: PlaylistContractRevisionV1;
  axis: string;
  questionIdentity: string;
  options: readonly GuidanceOptionV3[];
}): GuidanceOptionSimulationV5[] {
  const successorHashes = new Set<string>();
  return input.options.map((option) => {
    const patchHash = sha256Hex(stableStringify({
      operations: option.patch.operations,
      affectedClauseIds: option.patch.affectedClauseIds,
      explicitNoop: option.explicitNoop === true,
    }));
    if (option.patch.operations.length === 0) {
      return {
        optionId: option.id,
        patchHash,
        successorSemanticHash: null,
        executionEffect: null,
        valid: true,
      };
    }
    if (option.patch.operations.some(({ op }) => (
      op === "set_requested_track_count"
    ))) {
      throw new Error("guidance_v5_count_mutation_forbidden");
    }
    const successor = applyPlaylistContractPatchV1(input.baseContract, {
      baseRevisionId: input.baseContract.revisionId,
      baseSemanticHash: input.baseContract.semanticHash,
      answerLineage: {
        questionSetHash: sha256Hex(input.questionIdentity),
        questionId: input.questionIdentity,
        answerHash: patchHash,
      },
      operations: option.patch.operations,
    });
    if (successor.requestedTrackCount
      !== input.baseContract.requestedTrackCount) {
      throw new Error("guidance_v5_count_drift");
    }
    if (successor.semanticHash === input.baseContract.semanticHash
      || successorHashes.has(successor.semanticHash)) {
      throw new Error("guidance_v5_zero_or_duplicate_semantic_effect");
    }
    successorHashes.add(successor.semanticHash);
    const field = executionFieldForOperations(option.patch.operations);
    const executionEffect = {
      field,
      consumerId: consumerForField(input.axis, field),
      effectHash: sha256Hex(stableStringify({
        field,
        operations: option.patch.operations,
      })),
    };
    return {
      optionId: option.id,
      patchHash,
      successorSemanticHash: successor.semanticHash,
      executionEffect,
      valid: true,
    };
  });
}

function createDecisionV5(input: {
  decision: GuidanceDecisionV4;
  baseContract: PlaylistContractRevisionV1;
  capabilitySnapshotHash: string;
  semanticConfigurationHash: string;
}): GuidanceDecisionV5 {
  const simulations = simulateOptions({
    baseContract: input.baseContract,
    axis: input.decision.axis,
    questionIdentity: input.decision.id,
    options: input.decision.options,
  });
  const v4Body = { ...input.decision };
  delete (v4Body as Record<string, unknown>).schemaVersion;
  delete (v4Body as Record<string, unknown>).policyVersion;
  delete (v4Body as Record<string, unknown>).questionHash;
  const body: Omit<GuidanceDecisionV5, "questionHash"> = {
    ...v4Body,
    schemaVersion: 5 as const,
    policyVersion: ADAPTIVE_GUIDANCE_POLICY_VERSION_V5,
    axisRegistryVersion: GUIDANCE_AXIS_REGISTRY_VERSION_V5,
    simulationPolicyVersion: GUIDANCE_OPTION_SIMULATION_POLICY_VERSION_V5,
    capabilitySnapshotHash: input.capabilitySnapshotHash,
    semanticConfigurationHash: input.semanticConfigurationHash,
    simulations,
  };
  const decision: GuidanceDecisionV5 = {
    ...body,
    questionHash: sha256Hex(stableStringify(body)),
  };
  assertGuidanceDecisionV5(decision, input.baseContract);
  return decision;
}

function rankingClause(
  id: string,
  axis: string,
  value: string,
  text: string,
): PlaylistContractClauseDraftV1 {
  return {
    id,
    kind: "ranking_preference",
    scope: "track",
    hardness: "soft",
    axis,
    operator: "prefer",
    values: [value],
    source: { provenance: "guidance", text },
    unknownPolicy: "allow",
  };
}

function sequencingClause(
  id: string,
  value: string,
  text: string,
): PlaylistContractClauseDraftV1 {
  return {
    id,
    kind: "ranking_preference",
    scope: "playlist",
    hardness: "soft",
    axis: "playlist_flow",
    operator: "prefer",
    values: [value],
    source: { provenance: "guidance", text },
    unknownPolicy: "allow",
  };
}

function keepOption(): GuidanceOptionV3 {
  return {
    id: "keep_current_interpretation",
    label: "Keep my request as written",
    description: "Do not add another taste or sequencing preference.",
    recommended: false,
    expectedFeasibilityDirection: "neutral",
    patch: { operations: [], affectedClauseIds: [] },
  };
}

function familiarityDecision(
  baseContract: PlaylistContractRevisionV1,
): GuidanceDecisionV4 {
  const options = [
    {
      id: "recognizable_anchors",
      label: "Recognizable anchors",
      description:
        "Favor familiar landmarks while keeping the request’s exact scope.",
      value: "familiar landmarks and widely recognized staples",
    },
    {
      id: "balanced_discovery",
      label: "Balanced discovery",
      description:
        "Mix recognizable anchors with deeper discoveries inside the same scope.",
      value: "balanced recognizable anchors and deeper discovery",
      recommended: true,
    },
    {
      id: "deep_discovery",
      label: "Deep discovery",
      description:
        "Favor obscure deep cuts and emerging artists that still satisfy every hard rule.",
      value: "obscure deep cuts and emerging artist discovery",
    },
  ] as const;
  return createGuidanceDecisionV4({
    mode: "nuance_optional",
    id: "v5-nuance:familiarity-balance",
    header: "Discovery balance",
    question: "How familiar should the playlist feel?",
    axis: "familiarity_balance",
    trigger: "nuance",
    criticality: "optional",
    selectionMode: "single",
    allowCustom: false,
    baseContractRevisionId: baseContract.revisionId,
    baseContractSemanticHash: baseContract.semanticHash,
    whyMaterial:
      "Your request defines what belongs, but leaves the balance between recognizable anchors and discovery open.",
    allowedPatchOperations: ["add_clause"],
    affectedClauseIds: options.map(
      ({ id }) => `guidance:v5:familiarity:${id}`,
    ),
    materialityScore: 84,
    options: [
      ...options.map((option) => {
        const clauseId = `guidance:v5:familiarity:${option.id}`;
        return {
          id: option.id,
          label: option.label,
          description: option.description,
          recommended: "recommended" in option
            && option.recommended === true,
          expectedFeasibilityDirection: "neutral" as const,
          patch: {
            affectedClauseIds: [clauseId],
            operations: [{
              op: "add_clause" as const,
              clause: rankingClause(
                clauseId,
                "familiarity_bias",
                option.value,
                option.description,
              ),
            }],
          },
        };
      }),
      keepOption(),
    ],
  });
}

function flowDecision(
  baseContract: PlaylistContractRevisionV1,
): GuidanceDecisionV4 {
  const options = [
    {
      id: "smooth_flow",
      label: "Smooth flow",
      description: "Keep transitions cohesive and gradual.",
      direction: "smooth" as const,
    },
    {
      id: "rising_energy",
      label: "Rising energy",
      description: "Build progressively toward the most energetic stretch.",
      direction: "ascending" as const,
      recommended: true,
    },
    {
      id: "bold_contrasts",
      label: "Bold contrasts",
      description: "Use deliberate changes of pace and texture.",
      direction: "contrast" as const,
    },
  ];
  return createGuidanceDecisionV4({
    mode: "nuance_optional",
    id: "v5-nuance:playlist-flow",
    header: "Playlist flow",
    question: "How should the playlist develop from start to finish?",
    axis: "playlist_flow",
    trigger: "nuance",
    criticality: "optional",
    selectionMode: "single",
    allowCustom: false,
    baseContractRevisionId: baseContract.revisionId,
    baseContractSemanticHash: baseContract.semanticHash,
    whyMaterial:
      "The same qualifying tracks can feel very different depending on pacing and transitions.",
    allowedPatchOperations: [
      "add_clause",
      "set_sequencing_objectives",
    ],
    affectedClauseIds: options.map(
      ({ id }) => `guidance:v5:flow:${id}`,
    ),
    materialityScore: 82,
    options: [
      ...options.map((option, index) => {
        const clauseId = `guidance:v5:flow:${option.id}`;
        return {
          id: option.id,
          label: option.label,
          description: option.description,
          recommended: "recommended" in option
            && option.recommended === true,
          expectedFeasibilityDirection: "neutral" as const,
          patch: {
            affectedClauseIds: [clauseId],
            operations: [
              {
                op: "add_clause" as const,
                clause: sequencingClause(
                  clauseId,
                  option.id,
                  option.description,
                ),
              },
              {
                op: "set_sequencing_objectives" as const,
                objectives: [{
                  id: `guidance:v5:flow-objective:${option.id}`,
                  clauseId,
                  dimension: "playlist_flow",
                  direction: option.direction,
                  weight: 1,
                  priority: index + 1,
                }],
              },
            ],
          },
        };
      }),
      keepOption(),
    ],
  });
}

function artistDiversityDecision(
  baseContract: PlaylistContractRevisionV1,
): GuidanceDecisionV4 {
  const options = [
    {
      id: "broad_artist_mix",
      label: "Broad artist mix",
      description: "Favor more distinct artists and fewer repeats.",
      value: "maximize artist diversity",
      recommended: true,
    },
    {
      id: "deeper_artist_runs",
      label: "Deeper artist runs",
      description: "Allow more tracks from the strongest matching artists.",
      value: "allow deeper artist runs",
    },
    {
      id: "balanced_artist_mix",
      label: "Balanced",
      description: "Balance breadth with a few recurring anchor artists.",
      value: "balanced artist breadth and recurring anchors",
    },
  ] as const;
  return createGuidanceDecisionV4({
    mode: "nuance_optional",
    id: "v5-nuance:artist-diversity",
    header: "Artist variety",
    question: "How much artist variety should the playlist prioritize?",
    axis: "artist_diversity",
    trigger: "nuance",
    criticality: "optional",
    selectionMode: "single",
    allowCustom: false,
    baseContractRevisionId: baseContract.revisionId,
    baseContractSemanticHash: baseContract.semanticHash,
    whyMaterial:
      "Artist repetition changes discovery breadth even when every track matches the same request.",
    allowedPatchOperations: ["add_clause"],
    affectedClauseIds: options.map(
      ({ id }) => `guidance:v5:artist-diversity:${id}`,
    ),
    materialityScore: 78,
    options: [
      ...options.map((option) => {
        const clauseId = `guidance:v5:artist-diversity:${option.id}`;
        return {
          id: option.id,
          label: option.label,
          description: option.description,
          recommended: "recommended" in option
            && option.recommended === true,
          expectedFeasibilityDirection: "neutral" as const,
          patch: {
            affectedClauseIds: [clauseId],
            operations: [{
              op: "add_clause" as const,
              clause: rankingClause(
                clauseId,
                "artist_diversity",
                option.value,
                option.description,
              ),
            }],
          },
        };
      }),
      keepOption(),
    ],
  });
}

function fallbackDecision(
  contract: PlaylistContractRevisionV1,
): GuidanceDecisionV4 {
  const axes = new Set(contract.clauses.map(({ axis }) => axis));
  if (![...axes].some((axis) => (
    axis === "familiarity_bias"
    || axis === "discovery"
    || axis === "novelty"
  ))) {
    return familiarityDecision(contract);
  }
  if (contract.sequencingObjectives.length === 0) {
    return flowDecision(contract);
  }
  return artistDiversityDecision(contract);
}

export function guidanceCheckpointV5(input: {
  prompt: string;
  baseContract: PlaylistContractRevisionV1;
  preservedTrackPredicate: PlaylistContractRevisionV1["trackPredicate"] | null;
  ambiguousScopeClauseIds: readonly string[];
  criticalAmbiguities?: readonly CriticalAmbiguityV3[];
  requestShape: "fully_explicit" | "fixed_list" | "factual" | "curated";
  interpretationSummaryContext?: GuidanceInterpretationSummaryContextV4;
  compilationTimestamp?: string;
  answeredAxes?: readonly string[];
  priorQuestionHashes?: readonly string[];
  clarificationAttemptsByAxis?: Readonly<Record<string, number>>;
  capabilitySnapshotHash: string;
  semanticConfigurationHash: string;
}): GuidanceCheckpointV5 {
  if (!/^[a-f0-9]{64}$/u.test(input.capabilitySnapshotHash)
    || !/^[a-f0-9]{64}$/u.test(input.semanticConfigurationHash)) {
    throw new Error("guidance_v5_capability_fence_invalid");
  }
  const v4: GuidanceCheckpointV4 = guidanceCheckpointV4(input);
  const answeredAxes = new Set(input.answeredAxes ?? []);
  const decisionsV4 = v4.decisions.length > 0
    ? [...v4.decisions]
    : [fallbackDecision(input.baseContract)].filter(
      ({ axis }) => !answeredAxes.has(axis),
    );
  if (decisionsV4.length === 0) {
    throw new Error("guidance_v5_question_required");
  }
  const decisions = decisionsV4.slice(0, 2).map((decision) => (
    createDecisionV5({
      decision,
      baseContract: input.baseContract,
      capabilitySnapshotHash: input.capabilitySnapshotHash,
      semanticConfigurationHash: input.semanticConfigurationHash,
    })
  ));
  const mode = decisions.some(({ mode }) => mode === "correctness_blocking")
    ? "correctness_blocking" as const
    : "nuance_optional" as const;
  const body = {
    policyVersion: ADAPTIVE_GUIDANCE_POLICY_VERSION_V5,
    mode,
    decisionHashes: decisions.map(({ questionHash }) => questionHash),
    interpretationSummary: v4.interpretationSummary,
    rejectedDecisionReasons: v4.rejectedDecisionReasons,
  };
  return {
    policyVersion: ADAPTIVE_GUIDANCE_POLICY_VERSION_V5,
    mode,
    decisions,
    interpretationSummary: v4.interpretationSummary,
    rejectedDecisionReasons: v4.rejectedDecisionReasons,
    checkpointHash: sha256Hex(stableStringify(body)),
  };
}

export function assertGuidanceDecisionV5(
  decision: GuidanceDecisionV5,
  baseContract?: PlaylistContractRevisionV1,
): void {
  if (decision.schemaVersion !== 5
    || decision.policyVersion !== ADAPTIVE_GUIDANCE_POLICY_VERSION_V5
    || decision.axisRegistryVersion !== GUIDANCE_AXIS_REGISTRY_VERSION_V5
    || decision.simulationPolicyVersion
      !== GUIDANCE_OPTION_SIMULATION_POLICY_VERSION_V5
    || !/^[a-f0-9]{64}$/u.test(decision.capabilitySnapshotHash)
    || !/^[a-f0-9]{64}$/u.test(decision.semanticConfigurationHash)
    || decision.options.length < 2
    || decision.options.length > 4
    || decision.simulations.length !== decision.options.length) {
    throw new Error("invalid_guidance_v5_contract");
  }
  const optionIds = new Set(decision.options.map(({ id }) => id));
  if (optionIds.size !== decision.options.length
    || decision.simulations.some(({ optionId, valid }) => (
      !optionIds.has(optionId) || valid !== true
    ))) {
    throw new Error("invalid_guidance_v5_option_simulation");
  }
  if (baseContract) {
    const expected = simulateOptions({
      baseContract,
      axis: decision.axis,
      questionIdentity: decision.id,
      options: decision.options,
    });
    if (stableStringify(expected) !== stableStringify(decision.simulations)) {
      throw new Error("guidance_v5_simulation_drift");
    }
  }
  const body = Object.fromEntries(
    Object.entries(decision).filter(([key]) => key !== "questionHash"),
  );
  if (decision.questionHash !== sha256Hex(stableStringify(body))) {
    throw new Error("guidance_v5_question_hash_mismatch");
  }
}

export function compileGuidanceSelectionV5(
  decision: GuidanceDecisionV5,
  answer: {
    readonly optionIds?: readonly string[];
    readonly skipped?: boolean;
  },
): {
  state: "accepted" | "required_answer_missing";
  answerHash: string;
  selectedOptionIds: string[];
  operations: PlaylistContractPatchOperationV1[];
  affectedClauseIds: string[];
} {
  assertGuidanceDecisionV5(decision);
  if (answer.skipped) {
    return {
      state: decision.criticality === "required"
        ? "required_answer_missing"
        : "accepted",
      answerHash: sha256Hex(stableStringify({
        questionHash: decision.questionHash,
        skipped: true,
      })),
      selectedOptionIds: [],
      operations: [],
      affectedClauseIds: [],
    };
  }
  const optionIds = unique(answer.optionIds ?? []);
  if (decision.selectionMode === "single" && optionIds.length !== 1) {
    return {
      state: decision.criticality === "required"
        ? "required_answer_missing"
        : "accepted",
      answerHash: sha256Hex(stableStringify({
        questionHash: decision.questionHash,
        optionIds,
      })),
      selectedOptionIds: [],
      operations: [],
      affectedClauseIds: [],
    };
  }
  const selected = optionIds.map((id) => {
    const option = decision.options.find((candidate) => candidate.id === id);
    if (!option) throw new Error("unknown_guidance_v5_option");
    return option;
  });
  return {
    state: "accepted",
    answerHash: sha256Hex(stableStringify({
      questionHash: decision.questionHash,
      optionIds,
    })),
    selectedOptionIds: optionIds,
    operations: selected.flatMap(({ patch }) => [...patch.operations]),
    affectedClauseIds: unique(
      selected.flatMap(({ patch }) => patch.affectedClauseIds),
    ),
  };
}
