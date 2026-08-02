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
import {
  projectPlaylistContractExecutionV1,
} from "./playlist-contract-execution-bridge-v1.ts";
import {
  createQueryPlanV3,
  pipelineV3RolloutGroup,
  type PipelineV3RolloutGroup,
} from "./query-plan-v3.ts";
import {
  assertGuidanceRuntimeConsumerEffectV5,
  type GuidanceRuntimeAxisV5,
} from "./pipeline-v3-retrieval.ts";
import type { PlaylistGuidanceQuestion } from "../shared/types.ts";

export const ADAPTIVE_GUIDANCE_POLICY_VERSION_V5 =
  "adaptive_guidance_v5" as const;
export const GUIDANCE_AXIS_REGISTRY_VERSION_V5 =
  "guidance_axis_registry_v5_1" as const;
export const GUIDANCE_OPTION_SIMULATION_POLICY_VERSION_V5 =
  "guidance_option_simulation_v5_2" as const;
export const GUIDANCE_RUNTIME_CONSUMER_REGISTRY_VERSION_V5 =
  "guidance_runtime_consumer_registry_v5_1" as const;
export const GUIDANCE_MAX_QUESTION_ROUNDS_V5 = 3 as const;

export type GuidanceExecutionFieldV5 =
  | "membershipPredicates"
  | "rankingObjectives"
  | "orderingPolicy"
  | "playlistQuotaRules"
  | "playlistQualityPolicy";

export interface GuidanceExecutionEffectV5 {
  readonly field: GuidanceExecutionFieldV5;
  readonly consumerId: string;
  readonly beforeConsumerResultHash: string;
  readonly afterConsumerResultHash: string;
  readonly effectHash: string;
}

export interface GuidanceConsumerReceiptV5 {
  readonly registryVersion:
    typeof GUIDANCE_RUNTIME_CONSUMER_REGISTRY_VERSION_V5;
  readonly registryHash: string;
  readonly capabilitySnapshotHash: string;
  readonly axis: string;
  readonly field: GuidanceExecutionFieldV5;
  readonly consumerId: string;
  readonly receiptHash: string;
}

export interface GuidanceOptionSimulationV5 {
  readonly optionId: string;
  readonly patchHash: string;
  readonly baseRolloutGroup: PipelineV3RolloutGroup;
  readonly successorRolloutGroup: PipelineV3RolloutGroup;
  readonly successorSemanticHash: string | null;
  /**
   * Deterministic display-time query-plan counterfactuals. Both plans use the
   * same locked synthetic graph snapshot, so a different hash proves that the
   * typed option survives the contract-to-query-plan compiler rather than only
   * changing contract prose or an intermediate selection projection.
   */
  readonly beforeQueryPlanHash: string;
  readonly afterQueryPlanHash: string;
  readonly executionEffect: GuidanceExecutionEffectV5 | null;
  readonly consumerReceipt: GuidanceConsumerReceiptV5 | null;
  readonly simulationReceiptHash: string;
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
  readonly rolloutGroup: PipelineV3RolloutGroup;
  readonly consumerRegistryHash: string;
  readonly simulations: readonly GuidanceOptionSimulationV5[];
  readonly questionHash: string;
}

export interface GuidanceCheckpointV5 {
  readonly policyVersion: typeof ADAPTIVE_GUIDANCE_POLICY_VERSION_V5;
  readonly mode:
    | "correctness_blocking"
    | "nuance_optional"
    | "interpretation_confirmation"
    | "execution_decision";
  readonly decisions: readonly GuidanceDecisionV5[];
  /**
   * Present only when no faithful musical question remains. This is a typed
   * brief-state action, never a contract patch and never an authorization to
   * auto-start research.
   */
  readonly executionDecision?: GuidanceExecutionDecisionV5;
  readonly interpretationSummary: PlaylistInterpretationSummaryV1;
  readonly confirmationKind?: "unresolved_review";
  readonly rejectedDecisionReasons: Readonly<Record<string, string>>;
  readonly checkpointHash: string;
}

interface GuidanceAxisDefinitionV5 {
  readonly id:
    | "influence_scope"
    | "relationship_scope"
    | "energy_mood_intensity"
    | "recording_version_preference"
    | "familiarity_balance"
    | "playlist_flow"
    | "artist_diversity"
    | "selection_tiebreak";
  readonly executionField: GuidanceExecutionFieldV5;
}

export const GUIDANCE_AXIS_REGISTRY_V5: Readonly<
  Record<GuidanceAxisDefinitionV5["id"], GuidanceAxisDefinitionV5>
> = Object.freeze({
  influence_scope: Object.freeze({
    id: "influence_scope",
    executionField: "rankingObjectives",
  }),
  relationship_scope: Object.freeze({
    id: "relationship_scope",
    executionField: "rankingObjectives",
  }),
  energy_mood_intensity: Object.freeze({
    id: "energy_mood_intensity",
    executionField: "rankingObjectives",
  }),
  recording_version_preference: Object.freeze({
    id: "recording_version_preference",
    executionField: "rankingObjectives",
  }),
  familiarity_balance: Object.freeze({
    id: "familiarity_balance",
    executionField: "rankingObjectives",
  }),
  playlist_flow: Object.freeze({
    id: "playlist_flow",
    executionField: "orderingPolicy",
  }),
  artist_diversity: Object.freeze({
    id: "artist_diversity",
    executionField: "rankingObjectives",
  }),
  selection_tiebreak: Object.freeze({
    id: "selection_tiebreak",
    executionField: "rankingObjectives",
  }),
});

export type GuidanceExecutionActionKindV5 =
  | "execute_confirmed_contract"
  | "review_interpretation"
  | "cancel_request";

export interface GuidanceExecutionDecisionOptionV5 {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly recommended: boolean;
  readonly recommendationReason?: string;
  readonly action: {
    readonly kind: GuidanceExecutionActionKindV5;
    readonly startsResearch: boolean;
  };
}

export interface GuidanceExecutionDecisionV5 {
  readonly schemaVersion: 1;
  readonly policyVersion: typeof ADAPTIVE_GUIDANCE_POLICY_VERSION_V5;
  readonly mode: "execution_decision";
  readonly id:
    | "v5-execution:confirmed-contract"
    | "v5-execution:unresolved-review";
  readonly axis: "execution_readiness";
  readonly header: string;
  readonly question: string;
  readonly whyMaterial: string;
  readonly selectionMode: "single";
  readonly criticality: "required";
  readonly allowCustom: false;
  readonly baseContractRevisionId: string;
  readonly baseContractSemanticHash: string;
  readonly capabilitySnapshotHash: string;
  readonly semanticConfigurationHash: string;
  readonly interpretationSummary: PlaylistInterpretationSummaryV1;
  readonly options: readonly GuidanceExecutionDecisionOptionV5[];
  readonly decisionHash: string;
}

interface GuidanceRuntimeConsumerCapabilityV5 {
  readonly consumerId: string;
  readonly field: GuidanceExecutionFieldV5;
  readonly axes: readonly string[];
}

export interface GuidanceRuntimeConsumerRegistryV5 {
  readonly version: typeof GUIDANCE_RUNTIME_CONSUMER_REGISTRY_VERSION_V5;
  readonly capabilitySnapshotHash: string;
  readonly consumers: readonly GuidanceRuntimeConsumerCapabilityV5[];
  readonly hash: string;
}

const GUIDANCE_RUNTIME_CONSUMER_BLUEPRINT_V5:
  readonly GuidanceRuntimeConsumerCapabilityV5[] = Object.freeze([
    Object.freeze({
      consumerId: "pipeline_v3_retrieval:familiarityBoundsV3",
      field: "rankingObjectives",
      axes: Object.freeze(["familiarity_balance"]),
    }),
    Object.freeze({
      consumerId:
        "pipeline_v3_retrieval:playlistOptimizationConstraintsV3",
      field: "orderingPolicy",
      axes: Object.freeze(["playlist_flow"]),
    }),
    Object.freeze({
      consumerId:
        "pipeline_v3_live_adapters:hostedDiscoveryRankingObjectivesV5",
      field: "rankingObjectives",
      axes: Object.freeze([
        "influence_scope",
        "relationship_scope",
        "energy_mood_intensity",
        "recording_version_preference",
        "artist_diversity",
        "selection_tiebreak",
        "narrative_date_window",
        "sonic_anchor",
        "rap_grime_emphasis",
        "drill_grime_emphasis",
        "rare_scope_breadth",
      ]),
    }),
    Object.freeze({
      consumerId:
        "pipeline_v3_retrieval:evaluateCanonicalContractTrackV1",
      field: "membershipPredicates",
      axes: Object.freeze([
        "temporal_width",
        "genre",
        "factual_relationship",
        "french_jazz_relationship",
        "exact_artist_identity",
      ]),
    }),
    Object.freeze({
      consumerId: "pipeline_v3_retrieval:canonicalQuotaRules",
      field: "playlistQuotaRules",
      axes: Object.freeze(["adjacent_latin_urban_scope"]),
    }),
  ]);

export function guidanceRuntimeConsumerRegistryV5(
  capabilitySnapshotHash: string,
): GuidanceRuntimeConsumerRegistryV5 {
  if (!/^[a-f0-9]{64}$/u.test(capabilitySnapshotHash)) {
    throw new Error("guidance_v5_consumer_capability_hash_invalid");
  }
  const body = {
    version: GUIDANCE_RUNTIME_CONSUMER_REGISTRY_VERSION_V5,
    capabilitySnapshotHash,
    consumers: GUIDANCE_RUNTIME_CONSUMER_BLUEPRINT_V5,
  };
  return Object.freeze({
    ...body,
    hash: sha256Hex(stableStringify(body)),
  });
}

export type GuidanceScoutFailureV5 =
  | "timeout"
  | "malformed_output"
  | "budget_exhausted"
  | "provider_unavailable";

/**
 * A scout may nominate a server-owned axis, but it cannot supply question
 * wording, options, or executable operations. The contract must independently
 * contain the material semantic signal before the nomination is accepted.
 */
export interface GuidanceAxisProposalV5 {
  readonly schemaVersion: 1;
  readonly source: "model_scout";
  readonly axisId: string;
  readonly materialityScore: number;
}

const SCOUT_AXIS_PRIORITY_V5 = Object.freeze({
  influence_scope: 95,
  relationship_scope: 92,
  recording_version_preference: 88,
  energy_mood_intensity: 86,
  playlist_flow: 84,
  artist_diversity: 82,
  familiarity_balance: 80,
  selection_tiebreak: 75,
} satisfies Record<GuidanceAxisDefinitionV5["id"], number>);

function serverAxisForScoutQuestionV5(
  question: PlaylistGuidanceQuestion,
): GuidanceAxisDefinitionV5["id"] | null {
  const effectKinds = new Set(
    question.options.flatMap(({ effect }) => effect ? [effect.kind] : []),
  );
  if (effectKinds.has("ordering_behavior")) return "playlist_flow";
  if (effectKinds.has("familiarity_bias")) return "familiarity_balance";
  if (effectKinds.has("version_preference")) {
    return "recording_version_preference";
  }

  // The scout may nominate only a closed server axis. Model-authored wording,
  // option labels, and effect values are deliberately excluded from this
  // mapping so they can never become executable semantics.
  const key = guidanceAxisKey(question.decisionKey ?? "");
  if (/(?:^|_)(?:influence|impact|canon)(?:_|$)/u.test(key)) {
    return "influence_scope";
  }
  if (/(?:^|_)(?:relationship|credit|collaboration|contribution|performed|membership)(?:_|$)/u.test(key)) {
    return "relationship_scope";
  }
  if (/(?:^|_)(?:version|live|remix|remaster|studio)(?:_|$)/u.test(key)) {
    return "recording_version_preference";
  }
  if (/(?:^|_)(?:mood|energy|intensity|tempo)(?:_|$)/u.test(key)) {
    return "energy_mood_intensity";
  }
  if (/(?:^|_)(?:sequence|sequencing|flow|ordering|pacing|transition)(?:_|$)/u.test(key)) {
    return "playlist_flow";
  }
  if (/(?:^|_)(?:diversity|variety|breadth)(?:_|$)/u.test(key)) {
    return "artist_diversity";
  }
  if (/(?:^|_)(?:familiarity|familiar|discovery|obscurity|deep_cut)(?:_|$)/u.test(key)) {
    return "familiarity_balance";
  }
  if (/(?:^|_)(?:tiebreak|tie_break|close_call|cohesion)(?:_|$)/u.test(key)) {
    return "selection_tiebreak";
  }
  return null;
}

/**
 * Converts validated scout output into a nomination of one closed server axis.
 * It never carries model-authored copy, options, or effects into the contract.
 */
export function guidanceAxisProposalFromScoutV5(
  questions: readonly PlaylistGuidanceQuestion[],
): GuidanceAxisProposalV5 | null {
  const axes = [...new Set(
    questions
      .map(serverAxisForScoutQuestionV5)
      .filter((axis): axis is GuidanceAxisDefinitionV5["id"] => axis !== null),
  )].sort((left, right) => (
    SCOUT_AXIS_PRIORITY_V5[right] - SCOUT_AXIS_PRIORITY_V5[left]
    || left.localeCompare(right)
  ));
  const axisId = axes[0];
  if (!axisId) return null;
  return Object.freeze({
    schemaVersion: 1,
    source: "model_scout",
    axisId,
    materialityScore: SCOUT_AXIS_PRIORITY_V5[axisId],
  });
}

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
  registry: GuidanceRuntimeConsumerRegistryV5,
  axis: string,
  field: GuidanceExecutionFieldV5,
): GuidanceRuntimeConsumerCapabilityV5 {
  const exact = registry.consumers.find((consumer) => (
    consumer.field === field && consumer.axes.includes(axis)
  ));
  if (!exact) throw new Error("guidance_v5_registered_consumer_missing");
  return exact;
}

function consumerReceiptV5(input: {
  registry: GuidanceRuntimeConsumerRegistryV5;
  axis: string;
  field: GuidanceExecutionFieldV5;
  consumerId: string;
}): GuidanceConsumerReceiptV5 {
  const body = {
    registryVersion: input.registry.version,
    registryHash: input.registry.hash,
    capabilitySnapshotHash: input.registry.capabilitySnapshotHash,
    axis: input.axis,
    field: input.field,
    consumerId: input.consumerId,
  };
  return {
    ...body,
    receiptHash: sha256Hex(stableStringify(body)),
  };
}

function hardContractFingerprint(
  contract: PlaylistContractRevisionV1,
): string {
  return sha256Hex(stableStringify({
    requestedTrackCount: contract.requestedTrackCount,
    storefront: contract.storefront,
    partialPolicy: contract.partialPolicy,
    versions: contract.versions,
    hardClauses: contract.clauses
      .filter(({ hardness }) => hardness === "hard")
      .sort((left, right) => left.id.localeCompare(right.id)),
    trackPredicate: contract.trackPredicate,
    playlistConstraints: contract.playlistConstraints,
    qualityPolicy: contract.qualityPolicy,
    executionDirectives: contract.executionDirectives ?? null,
  }));
}

/**
 * Canonical contract-side projection used both when an option is simulated
 * and when the worker proves that the selected option reached its declared
 * execution consumer. Keeping one projection function prevents the question
 * compiler and worker-claim verifier from drifting apart.
 */
export function guidanceExecutionProjectionV5(
  contract: PlaylistContractRevisionV1,
  field: GuidanceExecutionFieldV5,
): unknown {
  if (field === "rankingObjectives") {
    return contract.clauses
      .filter(({ hardness, kind }) => (
        hardness === "soft"
        && (kind === "ranking_preference" || kind === "suitability")
      ))
      .sort((left, right) => left.id.localeCompare(right.id));
  }
  if (field === "orderingPolicy") {
    return {
      sequencingObjectives: contract.sequencingObjectives,
      sequencingClauses: contract.clauses
        .filter(({ id }) => (
          contract.sequencingObjectives.some(({ clauseId }) => clauseId === id)
        ))
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  }
  if (field === "playlistQuotaRules") {
    return contract.playlistConstraints;
  }
  if (field === "playlistQualityPolicy") {
    return {
      qualityPolicy: contract.qualityPolicy,
      clauses: contract.clauses
        .filter(({ id }) => (
          contract.qualityPolicy.centralSuitabilityClauseIds.includes(id)
        ))
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  }
  return {
    clauses: contract.clauses
      .filter(({ hardness }) => hardness === "hard")
      .sort((left, right) => left.id.localeCompare(right.id)),
    trackPredicate: contract.trackPredicate,
  };
}

function assertRegisteredAxisOperations(
  axis: string,
  operations: readonly PlaylistContractPatchOperationV1[],
): void {
  const expectedClauseAxis: Readonly<Record<string, string>> = {
    influence_scope: "influence",
    relationship_scope: "relationship_scope",
    energy_mood_intensity: "energy_mood_intensity",
    recording_version_preference: "recording_version_preference",
  };
  const clauseAxis = expectedClauseAxis[axis];
  if (!clauseAxis) return;
  if (operations.length === 0 || operations.some((operation) => (
    operation.op !== "add_clause"
    || operation.clause.kind !== "ranking_preference"
    || operation.clause.scope !== "track"
    || operation.clause.hardness !== "soft"
    || operation.clause.axis !== clauseAxis
    || operation.clause.operator !== "prefer"
  ))) {
    throw new Error(`guidance_v5_${axis}_patch_invalid`);
  }
}

function contractRolloutGroupV5(
  contract: PlaylistContractRevisionV1,
): PipelineV3RolloutGroup {
  const projection = projectPlaylistContractExecutionV1({
    contract,
    basePlan: {
      requestedTrackCount: contract.requestedTrackCount,
      minimumQualifiedTrackCount: contract.requestedTrackCount,
      storefront: contract.storefront,
    },
  });
  return pipelineV3RolloutGroup(projection.selectionPlanV3);
}

const GUIDANCE_OPTION_SIMULATION_GRAPH_SNAPSHOT_V5 =
  "00000000-0000-4000-8000-000000000541" as const;

function counterfactualQueryPlanHashV5(
  contract: PlaylistContractRevisionV1,
): string {
  const selectionPlan = projectPlaylistContractExecutionV1({
    contract,
    basePlan: {
      requestedTrackCount: contract.requestedTrackCount,
      minimumQualifiedTrackCount: contract.requestedTrackCount,
      storefront: contract.storefront,
    },
  }).selectionPlanV3;
  const queryPlan = createQueryPlanV3(
    selectionPlan,
    GUIDANCE_OPTION_SIMULATION_GRAPH_SNAPSHOT_V5,
    {
      schemaVersion: 6,
      briefContractVersion: 3,
      playlistContractRevisionId: contract.revisionId,
      playlistContractSemanticHash: contract.semanticHash,
      playlistContractCompilerVersion: contract.versions.compiler,
      guidancePolicyVersion: ADAPTIVE_GUIDANCE_POLICY_VERSION_V5,
    },
  );
  const canonicalPolicy = queryPlan.canonicalContractPolicy;
  /**
   * Contract revision IDs, semantic hashes, graph IDs, and plan wrapper hashes
   * must not satisfy the option-effect gate. Only fields the executor can
   * consume are included, so an option rejected or dropped by the query-plan
   * compiler produces the same projection and is not displayable.
   */
  return sha256Hex(stableStringify({
    engine: queryPlan.engine,
    engines: queryPlan.engines,
    membershipPredicates: queryPlan.membershipPredicates,
    rankingObjectives: queryPlan.rankingObjectives,
    targetTrackCount: queryPlan.targetTrackCount,
    storefront: queryPlan.storefront,
    hardConstraints: queryPlan.hardConstraints,
    softPreferences: queryPlan.softPreferences,
    sourceDiscoveryHints: queryPlan.sourceDiscoveryHints,
    conceptDiscoveryHints: queryPlan.conceptDiscoveryHints ?? [],
    scopeKind: queryPlan.scopeKind ?? null,
    diversityGoals: queryPlan.diversityGoals ?? null,
    orderingPolicy: queryPlan.orderingPolicy ?? null,
    softGoalRelaxationOrder: queryPlan.softGoalRelaxationOrder ?? [],
    semanticClauses: queryPlan.semanticClauses ?? [],
    contextSignals: queryPlan.contextSignals ?? [],
    catalogPolicies: queryPlan.catalogPolicies ?? [],
    recordingPolicy: queryPlan.recordingPolicy ?? null,
    playlistQuotaRules: queryPlan.playlistQuotaRules ?? [],
    playlistQualityPolicy: queryPlan.playlistQualityPolicy ?? null,
    executionDirectives: queryPlan.executionDirectives ?? null,
    verificationExpression: queryPlan.verificationExpression ?? null,
    canonicalPolicy: canonicalPolicy
      ? {
          policyVersion: canonicalPolicy.policyVersion,
          evidenceStrengthPolicyVersion:
            canonicalPolicy.evidenceStrengthPolicyVersion,
          contractCompilerVersion: canonicalPolicy.contractCompilerVersion,
          evidencePolicyVersion: canonicalPolicy.evidencePolicyVersion,
          catalogPolicyVersion: canonicalPolicy.catalogPolicyVersion,
          requestedTrackCount: canonicalPolicy.requestedTrackCount,
          storefront: canonicalPolicy.storefront,
          clauses: canonicalPolicy.clauses,
          trackPredicate: canonicalPolicy.trackPredicate,
          executionDirectives: canonicalPolicy.executionDirectives ?? null,
        }
      : null,
  }));
}

function guidanceOptionSimulationV5(
  input: Omit<
    GuidanceOptionSimulationV5,
    "simulationReceiptHash" | "valid"
  >,
): GuidanceOptionSimulationV5 {
  const body = {
    ...input,
    valid: true as const,
  };
  return {
    ...body,
    simulationReceiptHash: sha256Hex(stableStringify(body)),
  };
}

function simulateOptions(input: {
  baseContract: PlaylistContractRevisionV1;
  axis: string;
  mode: GuidanceDecisionV4["mode"];
  questionIdentity: string;
  options: readonly GuidanceOptionV3[];
  consumerRegistry: GuidanceRuntimeConsumerRegistryV5;
  expectedRolloutGroup?: PipelineV3RolloutGroup;
}): GuidanceOptionSimulationV5[] {
  const successorHashes = new Set<string>();
  const baseHardContractFingerprint = hardContractFingerprint(
    input.baseContract,
  );
  const baseRolloutGroup = contractRolloutGroupV5(input.baseContract);
  const beforeQueryPlanHash = counterfactualQueryPlanHashV5(
    input.baseContract,
  );
  if (input.expectedRolloutGroup
    && input.mode === "nuance_optional"
    && baseRolloutGroup !== input.expectedRolloutGroup) {
    throw new Error("guidance_v5_assignment_rollout_group_mismatch");
  }
  const simulations = input.options.map((option) => {
    const patchHash = sha256Hex(stableStringify({
      operations: option.patch.operations,
      affectedClauseIds: option.patch.affectedClauseIds,
      explicitNoop: option.explicitNoop === true,
    }));
    if (option.patch.operations.length === 0) {
      return guidanceOptionSimulationV5({
        optionId: option.id,
        patchHash,
        baseRolloutGroup,
        successorRolloutGroup: baseRolloutGroup,
        successorSemanticHash: null,
        beforeQueryPlanHash,
        afterQueryPlanHash: beforeQueryPlanHash,
        executionEffect: null,
        consumerReceipt: null,
      });
    }
    assertRegisteredAxisOperations(input.axis, option.patch.operations);
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
    if (input.mode === "nuance_optional"
      && hardContractFingerprint(successor)
        !== baseHardContractFingerprint) {
      throw new Error("guidance_v5_hard_contract_drift");
    }
    if (successor.semanticHash === input.baseContract.semanticHash
      || successorHashes.has(successor.semanticHash)) {
      throw new Error("guidance_v5_zero_or_duplicate_semantic_effect");
    }
    successorHashes.add(successor.semanticHash);
    const successorRolloutGroup = contractRolloutGroupV5(successor);
    if (input.mode === "nuance_optional"
      && successorRolloutGroup !== baseRolloutGroup) {
      throw new Error("guidance_v5_successor_rollout_group_drift");
    }
    const afterQueryPlanHash = counterfactualQueryPlanHashV5(successor);
    if (afterQueryPlanHash === beforeQueryPlanHash) {
      throw new Error("guidance_v5_zero_query_plan_effect");
    }
    const field = executionFieldForOperations(option.patch.operations);
    const registered = GUIDANCE_AXIS_REGISTRY_V5[
      input.axis as GuidanceAxisDefinitionV5["id"]
    ];
    if (registered && registered.executionField !== field) {
      throw new Error("guidance_v5_registered_execution_field_mismatch");
    }
    const consumer = consumerForField(
      input.consumerRegistry,
      input.axis,
      field,
    );
    const consumerId = consumer.consumerId;
    const baseExecution = projectPlaylistContractExecutionV1({
      contract: input.baseContract,
      basePlan: {
        requestedTrackCount: input.baseContract.requestedTrackCount,
        minimumQualifiedTrackCount: input.baseContract.requestedTrackCount,
        storefront: input.baseContract.storefront,
      },
    }).selectionPlanV3;
    const successorExecution = projectPlaylistContractExecutionV1({
      contract: successor,
      basePlan: {
        requestedTrackCount: successor.requestedTrackCount,
        minimumQualifiedTrackCount: successor.requestedTrackCount,
        storefront: successor.storefront,
      },
    }).selectionPlanV3;
    const consumerResult = assertGuidanceRuntimeConsumerEffectV5({
      beforePlan: baseExecution,
      afterPlan: successorExecution,
      axis: input.axis as GuidanceRuntimeAxisV5,
      field,
    });
    const beforeConsumerResultHash = sha256Hex(
      stableStringify(consumerResult.before),
    );
    const afterConsumerResultHash = sha256Hex(
      stableStringify(consumerResult.after),
    );
    const executionEffect = {
      field,
      consumerId,
      beforeConsumerResultHash,
      afterConsumerResultHash,
      effectHash: sha256Hex(stableStringify({
        axis: input.axis,
        field,
        consumerId,
        beforeConsumerResultHash,
        afterConsumerResultHash,
      })),
    };
    return guidanceOptionSimulationV5({
      optionId: option.id,
      patchHash,
      baseRolloutGroup,
      successorRolloutGroup,
      successorSemanticHash: successor.semanticHash,
      beforeQueryPlanHash,
      afterQueryPlanHash,
      executionEffect,
      consumerReceipt: consumerReceiptV5({
        registry: input.consumerRegistry,
        axis: input.axis,
        field,
        consumerId,
      }),
    });
  });
  const successorRolloutGroups = new Set(
    simulations.map(({ successorRolloutGroup }) => successorRolloutGroup),
  );
  if (successorRolloutGroups.size !== 1) {
    throw new Error("guidance_v5_option_rollout_group_divergence");
  }
  const successorRolloutGroup = simulations[0]!.successorRolloutGroup;
  if (input.expectedRolloutGroup
    && successorRolloutGroup !== input.expectedRolloutGroup) {
    throw new Error("guidance_v5_assignment_rollout_group_mismatch");
  }
  return simulations;
}

function createDecisionV5(input: {
  decision: GuidanceDecisionV4;
  baseContract: PlaylistContractRevisionV1;
  capabilitySnapshotHash: string;
  semanticConfigurationHash: string;
  expectedRolloutGroup?: PipelineV3RolloutGroup;
}): GuidanceDecisionV5 {
  const consumerRegistry = guidanceRuntimeConsumerRegistryV5(
    input.capabilitySnapshotHash,
  );
  const simulations = simulateOptions({
    baseContract: input.baseContract,
    axis: input.decision.axis,
    mode: input.decision.mode,
    questionIdentity: input.decision.id,
    options: input.decision.options,
    consumerRegistry,
    expectedRolloutGroup: input.expectedRolloutGroup,
  });
  const v4Body = { ...input.decision };
  delete (v4Body as Record<string, unknown>).schemaVersion;
  delete (v4Body as Record<string, unknown>).policyVersion;
  delete (v4Body as Record<string, unknown>).questionHash;
  const options = input.decision.options.map((option) => {
    const recommendationReason = option.recommendationReason?.trim();
    return {
      ...option,
      // A recommendation is an executable product claim. Never manufacture
      // its rationale from a generic template: an option remains recommended
      // only when its server-owned definition supplied a hash-bound reason.
      recommended: Boolean(option.recommended && recommendationReason),
      ...(option.recommended && recommendationReason
        ? { recommendationReason }
        : {}),
    };
  });
  const body: Omit<GuidanceDecisionV5, "questionHash"> = {
    ...v4Body,
    schemaVersion: 5 as const,
    policyVersion: ADAPTIVE_GUIDANCE_POLICY_VERSION_V5,
    axisRegistryVersion: GUIDANCE_AXIS_REGISTRY_VERSION_V5,
    simulationPolicyVersion: GUIDANCE_OPTION_SIMULATION_POLICY_VERSION_V5,
    capabilitySnapshotHash: input.capabilitySnapshotHash,
    semanticConfigurationHash: input.semanticConfigurationHash,
    // Correctness guidance may resolve an otherwise non-executable base
    // contract into its signed execution cohort (for example the ambiguous
    // Smooth Reggaeton scope starts without a genre predicate). Every option
    // must converge on this same successor group before the question can be
    // displayed; optional nuance is still forbidden from changing routes.
    rolloutGroup: simulations[0]!.successorRolloutGroup,
    consumerRegistryHash: consumerRegistry.hash,
    simulations,
    options,
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

function keepOption(recommended = false): GuidanceOptionV3 {
  return {
    id: "keep_current_interpretation",
    label: "Keep my request as written",
    description: "Do not add another taste or sequencing preference.",
    recommended,
    expectedFeasibilityDirection: "neutral",
    patch: { operations: [], affectedClauseIds: [] },
  };
}

function guidanceAxisKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function createExecutionDecisionV5(input: {
  baseContract: PlaylistContractRevisionV1;
  interpretationSummary: PlaylistInterpretationSummaryV1;
  capabilitySnapshotHash: string;
  semanticConfigurationHash: string;
  unresolvedCorrectness: boolean;
}): GuidanceExecutionDecisionV5 {
  const confirmedOptions: readonly GuidanceExecutionDecisionOptionV5[] = [
    {
      id: "execute_confirmed_contract",
      label: "Build this exact request",
      description:
        "Begin research from the confirmed immutable interpretation without changing its count or rules.",
      recommended: true,
      recommendationReason:
        "The request is already fully specified, so this preserves its exact confirmed scope and starts no unapproved revision.",
      action: {
        kind: "execute_confirmed_contract",
        startsResearch: true,
      },
    },
    {
      id: "review_interpretation",
      label: "Review the interpretation",
      description:
        "Return to the editable Must have / Prefer / Avoid / Flow / Count summary without starting research.",
      recommended: false,
      action: {
        kind: "review_interpretation",
        startsResearch: false,
      },
    },
    {
      id: "cancel_request",
      label: "Cancel",
      description:
        "Cancel this saved request without researching or publishing anything.",
      recommended: false,
      action: {
        kind: "cancel_request",
        startsResearch: false,
      },
    },
  ];
  const unresolvedOptions: readonly GuidanceExecutionDecisionOptionV5[] = [
    {
      id: "review_interpretation",
      label: "Review the interpretation",
      description:
        "Return to the editable Must have / Prefer / Avoid / Flow / Count summary without starting research.",
      recommended: true,
      recommendationReason:
        "A correctness question remains unresolved, so reviewing the saved interpretation is the only option that can resolve it without weakening the request.",
      action: {
        kind: "review_interpretation",
        startsResearch: false,
      },
    },
    {
      id: "cancel_request",
      label: "Cancel",
      description:
        "Cancel this saved request without researching or publishing anything.",
      recommended: false,
      action: {
        kind: "cancel_request",
        startsResearch: false,
      },
    },
  ];
  const unresolved = input.unresolvedCorrectness;
  const options = unresolved ? unresolvedOptions : confirmedOptions;
  const body: Omit<GuidanceExecutionDecisionV5, "decisionHash"> = {
    schemaVersion: 1,
    policyVersion: ADAPTIVE_GUIDANCE_POLICY_VERSION_V5,
    mode: "execution_decision",
    id: unresolved
      ? "v5-execution:unresolved-review"
      : "v5-execution:confirmed-contract",
    axis: "execution_readiness",
    header: unresolved ? "Interpretation needs review" : "Confirmed request",
    question: unresolved
      ? "A correctness question is still unresolved. What should happen next?"
      : "Your playlist request is fully specified. What should happen next?",
    whyMaterial: unresolved
      ? "Research cannot begin while a material correctness question remains unresolved; review the interpretation or cancel the saved request."
      : "The contract has no faithful unresolved musical fork. This explicit choice prevents a fabricated taste question and prevents research from starting without confirmation.",
    selectionMode: "single",
    criticality: "required",
    allowCustom: false,
    baseContractRevisionId: input.baseContract.revisionId,
    baseContractSemanticHash: input.baseContract.semanticHash,
    capabilitySnapshotHash: input.capabilitySnapshotHash,
    semanticConfigurationHash: input.semanticConfigurationHash,
    interpretationSummary: input.interpretationSummary,
    options,
  };
  const decision = {
    ...body,
    decisionHash: sha256Hex(stableStringify(body)),
  };
  assertGuidanceExecutionDecisionV5(decision);
  return decision;
}

export function assertGuidanceExecutionDecisionV5(
  decision: GuidanceExecutionDecisionV5,
): void {
  const unresolved = decision.id === "v5-execution:unresolved-review";
  if (decision.schemaVersion !== 1
    || decision.policyVersion !== ADAPTIVE_GUIDANCE_POLICY_VERSION_V5
    || decision.mode !== "execution_decision"
    || (
      decision.id !== "v5-execution:confirmed-contract"
      && decision.id !== "v5-execution:unresolved-review"
    )
    || decision.axis !== "execution_readiness"
    || decision.selectionMode !== "single"
    || decision.criticality !== "required"
    || decision.allowCustom !== false
    || !/^[a-f0-9]{64}$/u.test(decision.capabilitySnapshotHash)
    || !/^[a-f0-9]{64}$/u.test(decision.semanticConfigurationHash)
    || decision.options.length < 2
    || decision.options.length > 4
    || new Set(decision.options.map(({ id }) => id)).size
      !== decision.options.length
    || decision.options.filter(({ recommended }) => recommended).length !== 1
    || decision.options.some((option) => (
      option.recommended
        ? !option.recommendationReason?.trim()
        : option.recommendationReason !== undefined
    ))
    || decision.options.some(({ action }) => (
      action.startsResearch
      !== (action.kind === "execute_confirmed_contract")
    ))) {
    throw new Error("invalid_guidance_v5_execution_decision");
  }
  const expectedKinds = new Set<GuidanceExecutionActionKindV5>([
    "execute_confirmed_contract",
    "review_interpretation",
    "cancel_request",
  ]);
  if (decision.options.some(({ action }) => (
    !expectedKinds.has(action.kind)
  ))) {
    throw new Error("invalid_guidance_v5_execution_action");
  }
  const actionKinds = new Set(
    decision.options.map(({ action }) => action.kind),
  );
  if (unresolved
    ? actionKinds.size !== 2
      || !actionKinds.has("review_interpretation")
      || !actionKinds.has("cancel_request")
      || actionKinds.has("execute_confirmed_contract")
    : actionKinds.size !== 3
      || !actionKinds.has("execute_confirmed_contract")
      || !actionKinds.has("review_interpretation")
      || !actionKinds.has("cancel_request")) {
    throw new Error("invalid_guidance_v5_execution_action_set");
  }
  const body = Object.fromEntries(
    Object.entries(decision).filter(([key]) => key !== "decisionHash"),
  );
  if (decision.decisionHash !== sha256Hex(stableStringify(body))) {
    throw new Error("guidance_v5_execution_decision_hash_mismatch");
  }
}

const INFLUENCE_AXIS_IDS = new Set([
  "influence",
  "historical_influence",
  "cultural_impact",
  "editorial_ranking",
]);

const INFLUENCE_SCOPE_AXES = [
  "artist_origin",
  "geography",
  "geographic_scope",
  "scene",
  "genre_scene",
  "country",
  "region",
  "genre",
] as const;

function semanticWord(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .toLocaleLowerCase("en-US");
}

function semanticWords(value: string): string[] {
  return semanticWord(value).match(/[\p{Letter}\p{Number}]+/gu) ?? [];
}

function contractHasMaterialInfluenceIntent(
  contract: PlaylistContractRevisionV1,
): boolean {
  return contract.clauses.some((clause) => (
    clause.hardness === "soft"
    && (
      clause.kind === "ranking_preference"
      || clause.kind === "suitability"
    )
    && INFLUENCE_AXIS_IDS.has(clause.axis)
  ));
}

const SCOPE_DISPLAY_DEMONYMS: Readonly<Record<string, string>> =
  Object.freeze({
    brazil: "Brazilian",
    france: "French",
    germany: "German",
    ireland: "Irish",
    italy: "Italian",
    jamaica: "Jamaican",
    japan: "Japanese",
    nigeria: "Nigerian",
    spain: "Spanish",
    "united kingdom": "British",
    "united states": "American",
  });

function displayScopeValue(value: string): string | null {
  const normalized = value
    .normalize("NFKC")
    .replace(/^[^:]{1,40}:/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized || normalized.length > 48) return null;
  const demonym = SCOPE_DISPLAY_DEMONYMS[
    normalized.toLocaleLowerCase("en-US")
  ];
  if (demonym) return demonym;
  return normalized[0] === normalized[0]?.toLocaleLowerCase("en-US")
    ? `${normalized[0]!.toLocaleUpperCase("en-US")}${normalized.slice(1)}`
    : normalized;
}

function influenceSubjectScope(
  contract: PlaylistContractRevisionV1,
): { label: string; clauseId: string } | null {
  const hardMembership = contract.clauses.filter((clause) => (
    clause.hardness === "hard"
    && clause.operator !== "exclude"
    && (clause.kind === "membership" || clause.kind === "factual_relationship")
  ));
  for (const axis of INFLUENCE_SCOPE_AXES) {
    const clause = hardMembership.find((candidate) => candidate.axis === axis);
    const label = clause?.values
      .map(displayScopeValue)
      .find((value): value is string => value !== null);
    if (clause && label) return { label, clauseId: clause.id };
  }
  return null;
}

function influenceScopeDecision(
  baseContract: PlaylistContractRevisionV1,
): GuidanceDecisionV4 | null {
  if (!contractHasMaterialInfluenceIntent(baseContract)
    || baseContract.clauses.some(({ id }) => (
      id.startsWith("guidance:v5:influence-scope:")
    ))) {
    return null;
  }
  const subjectScope = influenceSubjectScope(baseContract);
  const scopeLabel = subjectScope?.label ?? "Within-scope";
  const options = [
    {
      id: "within_scope_cultural_impact",
      label: `${scopeLabel} cultural impact`,
      description: subjectScope
        ? `Prioritize recordings important within ${subjectScope.label} musical culture.`
        : "Prioritize recordings important within the request’s stated musical culture.",
      value: subjectScope
        ? `cultural impact within ${subjectScope.label} musical culture`
        : "cultural impact within the requested musical scope",
      recommended: false,
    },
    {
      id: "global_influence",
      label: "Global influence",
      description:
        "Prioritize in-scope recordings that changed music internationally.",
      value: "global musical influence and international impact",
      recommended: false,
    },
    {
      id: "balanced_influence",
      label: "Balanced",
      description: subjectScope
        ? `Combine ${subjectScope.label} cultural landmarks with globally influential recordings.`
        : "Combine within-scope cultural landmarks with globally influential recordings.",
      value: subjectScope
        ? `balance ${subjectScope.label} cultural impact with global influence`
        : "balance within-scope cultural impact with global influence",
      recommended: true,
      recommendationReason: subjectScope
        ? `The original wording leaves ${subjectScope.label} cultural impact versus global influence open, so a balanced emphasis preserves both readings.`
        : "The original wording leaves within-scope cultural impact versus global influence open, so a balanced emphasis preserves both readings.",
    },
  ] as const;
  return createGuidanceDecisionV4({
    mode: "nuance_optional",
    id: "v5-nuance:influence-scope",
    header: "Kind of influence",
    question: "Which kind of influence should lead the playlist?",
    axis: "influence_scope",
    trigger: "nuance",
    criticality: "optional",
    selectionMode: "single",
    allowCustom: false,
    baseContractRevisionId: baseContract.revisionId,
    baseContractSemanticHash: baseContract.semanticHash,
    whyMaterial:
      "Cultural importance inside the requested scope and influence beyond it produce different rankings while preserving the same membership and count.",
    allowedPatchOperations: ["add_clause"],
    affectedClauseIds: options.map(
      ({ id }) => `guidance:v5:influence-scope:${id}`,
    ),
    materialityScore: 94,
    options: [
      ...options.map((option) => {
        const clauseId = `guidance:v5:influence-scope:${option.id}`;
        return {
          id: option.id,
          label: option.label,
          description: option.description,
          recommended: option.recommended,
          ...("recommendationReason" in option
            ? { recommendationReason: option.recommendationReason }
            : {}),
          expectedFeasibilityDirection: "neutral" as const,
          patch: {
            affectedClauseIds: [clauseId],
            operations: [{
              op: "add_clause" as const,
              clause: rankingClause(
                clauseId,
                "influence",
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

const RELATIONSHIP_SCOPE_AXES = new Set([
  "relationship",
  "factual_relationship",
  "relationship_scope",
]);

const EXPLICIT_RELATIONSHIP_SCOPE_MARKERS = new Set([
  "artist_credit",
  "artist_collaboration",
  "artist_membership",
  "direct_recording",
  "recording_credit",
  "sample",
  "cover",
  "composition",
  "production",
  "scene_membership",
  "historical_influence",
]);

function relationshipScopeIsExplicit(
  clause: PlaylistContractRevisionV1["clauses"][number],
): boolean {
  if (clause.source.provenance === "guidance") return true;
  for (const value of clause.values) {
    const normalized = semanticWord(value)
      .replace(/\s+/gu, "_")
      .replace(/-+/gu, "_");
    const marker = normalized.startsWith("relationship:")
      ? normalized.slice("relationship:".length)
      : normalized.startsWith("relationship_")
        ? normalized.slice("relationship_".length)
        : null;
    if (marker && EXPLICIT_RELATIONSHIP_SCOPE_MARKERS.has(marker)) return true;
    const words = new Set(semanticWords(value));
    if (
      (words.has("artist") && (
        words.has("credit")
        || words.has("collaboration")
        || words.has("member")
      ))
      || (
        words.has("by")
        && [
          "music",
          "recording",
          "recordings",
          "song",
          "songs",
          "track",
          "tracks",
        ].some((word) => words.has(word))
      )
      || (words.has("recording") && (
        words.has("credit")
        || words.has("sample")
        || words.has("cover")
      ))
      || words.has("composed")
      || words.has("produced")
    ) {
      return true;
    }
  }
  return false;
}

function relationshipScopeDecision(
  baseContract: PlaylistContractRevisionV1,
): GuidanceDecisionV4 | null {
  if (contractHasMaterialInfluenceIntent(baseContract)
    || baseContract.clauses.some(({ axis, id }) => (
      axis === "relationship_scope"
      || id.startsWith("guidance:v5:relationship-scope:")
    ))) {
    return null;
  }
  const relationshipClauses = baseContract.clauses.filter((clause) => (
    clause.kind === "factual_relationship"
    || RELATIONSHIP_SCOPE_AXES.has(clause.axis)
  ));
  if (relationshipClauses.length === 0
    || relationshipClauses.every(relationshipScopeIsExplicit)) {
    return null;
  }
  const options = [
    {
      id: "direct_recording_links",
      label: "Direct recording links",
      description:
        "Prioritize documented track-level links such as performances, credits, samples, or covers.",
      value: "prioritize direct documented recording-level relationships",
    },
    {
      id: "artist_scene_links",
      label: "Artist and scene links",
      description:
        "Prioritize documented artist, group, label, or scene connections.",
      value: "prioritize documented artist and scene relationships",
    },
    {
      id: "broader_documented_influence",
      label: "Broader influence",
      description:
        "Prioritize broader documented historical or stylistic influence inside the confirmed scope.",
      value: "prioritize broader documented historical influence",
    },
  ] as const;
  return createGuidanceDecisionV4({
    mode: "nuance_optional",
    id: "v5-nuance:relationship-scope",
    header: "Relationship focus",
    question: "Which kind of documented relationship should lead the playlist?",
    axis: "relationship_scope",
    trigger: "nuance",
    criticality: "optional",
    selectionMode: "single",
    allowCustom: false,
    baseContractRevisionId: baseContract.revisionId,
    baseContractSemanticHash: baseContract.semanticHash,
    whyMaterial:
      "The canonical contract requires a documented relationship but does not yet say which supported relationship family should rank first.",
    allowedPatchOperations: ["add_clause"],
    affectedClauseIds: options.map(
      ({ id }) => `guidance:v5:relationship-scope:${id}`,
    ),
    materialityScore: 91,
    options: [
      ...options.map((option) => {
        const clauseId = `guidance:v5:relationship-scope:${option.id}`;
        return {
          id: option.id,
          label: option.label,
          description: option.description,
          recommended: false,
          expectedFeasibilityDirection: "neutral" as const,
          patch: {
            affectedClauseIds: [clauseId],
            operations: [{
              op: "add_clause" as const,
              clause: rankingClause(
                clauseId,
                "relationship_scope",
                option.value,
                option.description,
              ),
            }],
          },
        };
      }),
      keepOption(true),
    ],
  });
}

const MOOD_OR_ENERGY_AXES = new Set([
  "activity",
  "energy",
  "mood",
  "mood_activity",
  "vibe",
]);

const EXPLICIT_INTENSITY_WORDS = new Set([
  "aggressive",
  "calm",
  "driving",
  "energetic",
  "gentle",
  "high",
  "intense",
  "low",
  "mellow",
  "medium",
  "moderate",
  "quiet",
  "relaxed",
  "soft",
  "subdued",
]);

function energyMoodIntensityDecision(
  baseContract: PlaylistContractRevisionV1,
): GuidanceDecisionV4 | null {
  if (baseContract.clauses.some(({ axis, id }) => (
    axis === "energy_mood_intensity"
    || id.startsWith("guidance:v5:energy-mood-intensity:")
  ))) {
    return null;
  }
  const moodClauses = baseContract.clauses.filter((clause) => (
    MOOD_OR_ENERGY_AXES.has(clause.axis)
    && (
      clause.kind === "suitability"
      || clause.kind === "ranking_preference"
      || clause.kind === "membership"
    )
  ));
  if (moodClauses.length === 0) return null;
  const intensityAlreadyExplicit = moodClauses.some((clause) => (
    clause.values.some((value) => (
      semanticWords(value).some((word) => EXPLICIT_INTENSITY_WORDS.has(word))
    ))
  ));
  if (intensityAlreadyExplicit) return null;
  const options = [
    {
      id: "understated_intensity",
      label: "Understated",
      description:
        "Keep the confirmed mood restrained, spacious, and low-intensity.",
      value: "understated restrained low-intensity interpretation",
    },
    {
      id: "balanced_intensity",
      label: "Balanced",
      description:
        "Balance calmer passages with a few stronger peaks while preserving the confirmed mood.",
      value: "balanced dynamic intensity with selective peaks",
      recommended: true,
    },
    {
      id: "vivid_intensity",
      label: "More intense",
      description:
        "Favor vivid, driving recordings that express the confirmed mood more forcefully.",
      value: "vivid driving high-intensity interpretation",
    },
  ] as const;
  return createGuidanceDecisionV4({
    mode: "nuance_optional",
    id: "v5-nuance:energy-mood-intensity",
    header: "Mood intensity",
    question: "How intense should the playlist’s confirmed mood feel?",
    axis: "energy_mood_intensity",
    trigger: "nuance",
    criticality: "optional",
    selectionMode: "single",
    allowCustom: false,
    baseContractRevisionId: baseContract.revisionId,
    baseContractSemanticHash: baseContract.semanticHash,
    whyMaterial:
      "The canonical contract defines a mood or activity, but it does not yet set how strongly that quality should shape discovery and ranking.",
    allowedPatchOperations: ["add_clause"],
    affectedClauseIds: options.map(
      ({ id }) => `guidance:v5:energy-mood-intensity:${id}`,
    ),
    materialityScore: 89,
    options: [
      ...options.map((option) => {
        const clauseId = `guidance:v5:energy-mood-intensity:${option.id}`;
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
                "energy_mood_intensity",
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

const RECORDING_VERSION_LABELS: Readonly<Record<string, string>> =
  Object.freeze({
    acoustic: "Acoustic",
    canonical: "Original / canonical",
    clean: "Clean",
    explicit: "Explicit",
    extended: "Extended",
    instrumental: "Instrumental",
    live: "Live",
    radio_edit: "Radio edit",
    remaster: "Remastered",
    remix: "Remix",
  });

const DEFAULT_RECORDING_VERSION_ALTERNATIVES = new Set([
  "canonical",
  "remaster",
]);

function recordingVersionAlternatives(
  baseContract: PlaylistContractRevisionV1,
): string[] {
  const clauses = baseContract.clauses.filter((clause) => (
    clause.kind === "catalog_version"
    && clause.axis === "recording_version"
    && clause.operator === "require"
  ));
  const preferred: string[] = [];
  const allowed: string[] = [];
  for (const clause of clauses) {
    for (const value of clause.values) {
      const normalized = semanticWord(value)
        .replace(/\s+/gu, "_")
        .replace(/-+/gu, "_");
      if (normalized.startsWith("prefer:")) {
        preferred.push(normalized.slice("prefer:".length));
      } else if (normalized.startsWith("prefer_")) {
        preferred.push(normalized.slice("prefer_".length));
      } else if (normalized.startsWith("allow:")) {
        allowed.push(normalized.slice("allow:".length));
      } else if (normalized.startsWith("allow_")) {
        allowed.push(normalized.slice("allow_".length));
      }
    }
  }
  const supportedPreferred = unique(preferred)
    .filter((value) => RECORDING_VERSION_LABELS[value]);
  if (supportedPreferred.length >= 2) return supportedPreferred;
  const supportedAllowed = unique(allowed)
    .filter((value) => RECORDING_VERSION_LABELS[value]);
  const nonDefault = supportedAllowed.filter(
    (value) => !DEFAULT_RECORDING_VERSION_ALTERNATIVES.has(value),
  );
  return nonDefault.length >= 2 ? nonDefault : [];
}

function recordingVersionPreferenceDecision(
  baseContract: PlaylistContractRevisionV1,
): GuidanceDecisionV4 | null {
  if (baseContract.clauses.some(({ axis, id }) => (
    axis === "recording_version_preference"
    || id.startsWith("guidance:v5:recording-version:")
  ))) {
    return null;
  }
  const alternatives = recordingVersionAlternatives(baseContract).slice(0, 2);
  if (alternatives.length < 2) return null;
  const optionSpecs = alternatives.map((version) => ({
    id: `prefer_${version}`,
    label: RECORDING_VERSION_LABELS[version]!,
    description:
      `Favor ${RECORDING_VERSION_LABELS[version]!.toLocaleLowerCase("en-US")} recordings among versions already permitted by the contract.`,
    value:
      `prefer ${version} among recording versions already permitted by the contract`,
    recommended: false,
  }));
  optionSpecs.push({
    id: "balanced_allowed_versions",
    label: "Balanced version mix",
    description:
      "Use the strongest fit across the already permitted recording versions.",
    value: `balance the already permitted recording versions: ${alternatives.join(", ")}`,
    recommended: true,
  });
  return createGuidanceDecisionV4({
    mode: "nuance_optional",
    id: "v5-nuance:recording-version",
    header: "Recording versions",
    question: "Which already-allowed recording version should rank first?",
    axis: "recording_version_preference",
    trigger: "nuance",
    criticality: "optional",
    selectionMode: "single",
    allowCustom: false,
    baseContractRevisionId: baseContract.revisionId,
    baseContractSemanticHash: baseContract.semanticHash,
    whyMaterial:
      "The immutable catalog policy permits multiple recording versions but does not resolve which permitted version should lead ranking.",
    allowedPatchOperations: ["add_clause"],
    affectedClauseIds: optionSpecs.map(
      ({ id }) => `guidance:v5:recording-version:${id}`,
    ),
    materialityScore: alternatives.some(
      (version) => !DEFAULT_RECORDING_VERSION_ALTERNATIVES.has(version),
    ) ? 88 : 74,
    options: [
      ...optionSpecs.map((option) => {
        const clauseId = `guidance:v5:recording-version:${option.id}`;
        return {
          id: option.id,
          label: option.label,
          description: option.description,
          recommended: option.recommended,
          expectedFeasibilityDirection: "neutral" as const,
          patch: {
            affectedClauseIds: [clauseId],
            operations: [{
              op: "add_clause" as const,
              clause: rankingClause(
                clauseId,
                "recording_version_preference",
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

function generalizedArtifactDecisions(
  contract: PlaylistContractRevisionV1,
  requestShape: "fully_explicit" | "fixed_list" | "factual" | "curated",
): GuidanceDecisionV4[] {
  // Fixed lists and factual collections keep the deliberately selected flow
  // question first. Their membership/evidence scope is not changed by a
  // generated taste preference.
  if (requestShape === "fixed_list" || requestShape === "factual") return [];
  return [
    relationshipScopeDecision(contract),
    energyMoodIntensityDecision(contract),
    recordingVersionPreferenceDecision(contract),
  ].filter((decision): decision is GuidanceDecisionV4 => decision !== null);
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

function selectionTiebreakDecision(
  baseContract: PlaylistContractRevisionV1,
): GuidanceDecisionV4 {
  const options = [
    {
      id: "closest_musical_fit",
      label: "Closest musical fit",
      description:
        "Break close calls in favor of the recording that best satisfies the request’s stated musical preferences.",
      value: "break otherwise equal selections by closest overall musical fit",
      recommended: true,
    },
    {
      id: "strongest_playlist_cohesion",
      label: "Playlist cohesion",
      description:
        "Break close calls in favor of the recording that makes the completed playlist feel most coherent.",
      value: "break otherwise equal selections by whole-playlist cohesion",
      recommended: false,
    },
    {
      id: "more_discovery",
      label: "More discovery",
      description:
        "Break close calls in favor of the less obvious qualifying recording.",
      value: "break otherwise equal selections toward less obvious discoveries",
      recommended: false,
    },
  ] as const;
  return createGuidanceDecisionV4({
    mode: "nuance_optional",
    id: "v5-nuance:selection-tiebreak",
    header: "Close-call priority",
    question: "When several tracks fit equally well, what should break the tie?",
    axis: "selection_tiebreak",
    trigger: "nuance",
    criticality: "optional",
    selectionMode: "single",
    allowCustom: false,
    baseContractRevisionId: baseContract.revisionId,
    baseContractSemanticHash: baseContract.semanticHash,
    whyMaterial:
      "The request can be fully explicit while still leaving multiple equally eligible recordings; this choice changes ranking without weakening membership or count.",
    allowedPatchOperations: ["add_clause"],
    affectedClauseIds: options.map(
      ({ id }) => `guidance:v5:selection-tiebreak:${id}`,
    ),
    materialityScore: 72,
    options: [
      ...options.map((option) => {
        const clauseId = `guidance:v5:selection-tiebreak:${option.id}`;
        return {
          id: option.id,
          label: option.label,
          description: option.description,
          recommended: option.recommended,
          expectedFeasibilityDirection: "neutral" as const,
          patch: {
            affectedClauseIds: [clauseId],
            operations: [{
              op: "add_clause" as const,
              clause: rankingClause(
                clauseId,
                "selection_tiebreak",
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

function fallbackDecisions(
  contract: PlaylistContractRevisionV1,
  requestShape: "fully_explicit" | "fixed_list" | "factual" | "curated",
): GuidanceDecisionV4[] {
  const axes = new Set(
    contract.clauses.map(({ axis }) => guidanceAxisKey(axis)),
  );
  const decisions: GuidanceDecisionV4[] = [];
  // A fixed collection has already decided membership. Asking whether its
  // tracks should be more familiar cannot change the collection and is
  // therefore a quota-only question. Lead with the worker-consumed ordering
  // axis instead. Factual scopes likewise benefit from presentation/flow
  // before discovery bias once their evidence target is fixed.
  if (requestShape === "fixed_list" || requestShape === "factual") {
    if (contract.sequencingObjectives.length === 0
      && !axes.has("playlist_flow")) {
      decisions.push(flowDecision(contract));
    }
    return decisions;
  }
  if (![...axes].some((axis) => (
    axis === "familiarity_bias"
    || axis === "discovery"
    || axis === "novelty"
  ))) {
    decisions.push(familiarityDecision(contract));
  }
  if (contract.sequencingObjectives.length === 0
    && !axes.has("playlist_flow")) {
    decisions.push(flowDecision(contract));
  }
  if (!axes.has("artist_diversity")) {
    decisions.push(artistDiversityDecision(contract));
  }
  if (!axes.has("selection_tiebreak")) {
    decisions.push(selectionTiebreakDecision(contract));
  }
  return decisions;
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
  expectedRolloutGroup?: PipelineV3RolloutGroup;
  axisProposal?: GuidanceAxisProposalV5 | null;
  scoutFailure?: GuidanceScoutFailureV5 | null;
}): GuidanceCheckpointV5 {
  if (!/^[a-f0-9]{64}$/u.test(input.capabilitySnapshotHash)
    || !/^[a-f0-9]{64}$/u.test(input.semanticConfigurationHash)) {
    throw new Error("guidance_v5_capability_fence_invalid");
  }
  const answeredAxes = new Set(
    (input.answeredAxes ?? []).map(guidanceAxisKey),
  );
  // Do not ask V4 to re-simulate a correctness patch that is already present
  // on the successor contract. V5 filters displayed questions by answered
  // axis below, but V4 validates each candidate while constructing its
  // checkpoint; feeding an answered ambiguity into that validation would try
  // to add the same hard clause twice before V5 can discard it.
  const v4: GuidanceCheckpointV4 = guidanceCheckpointV4({
    ...input,
    criticalAmbiguities: (input.criticalAmbiguities ?? []).filter(
      ({ key }) => !answeredAxes.has(guidanceAxisKey(key)),
    ),
  });
  const priorQuestionHashes = new Set(input.priorQuestionHashes ?? []);
  const questionRoundLimitReached =
    priorQuestionHashes.size >= GUIDANCE_MAX_QUESTION_ROUNDS_V5;
  const rejectedDecisionReasons: Record<string, string> = {
    ...v4.rejectedDecisionReasons,
  };
  const influenceIntent = contractHasMaterialInfluenceIntent(
    input.baseContract,
  );
  const deterministicInfluence = influenceScopeDecision(input.baseContract);
  const deterministicArtifactAxes = generalizedArtifactDecisions(
    input.baseContract,
    input.requestShape,
  );
  const candidates = [
    ...v4.decisions.filter(({ mode }) => mode === "correctness_blocking"),
    ...(deterministicInfluence ? [deterministicInfluence] : []),
    ...deterministicArtifactAxes,
    ...v4.decisions.filter(({ mode }) => mode === "nuance_optional"),
    ...fallbackDecisions(input.baseContract, input.requestShape),
  ].filter((decision, index, all) => (
    all.findIndex(({ id }) => id === decision.id) === index
  ));
  const supportedDeterministicAxisIds = new Set(
    candidates
      .map(({ axis }) => axis)
      .filter((axis) => Object.hasOwn(GUIDANCE_AXIS_REGISTRY_V5, axis)),
  );
  const proposal = input.axisProposal;
  const validProposal = Boolean(proposal
    && proposal.schemaVersion === 1
    && proposal.source === "model_scout"
    && Number.isFinite(proposal.materialityScore)
    && proposal.materialityScore >= 0
    && proposal.materialityScore <= 100
    && supportedDeterministicAxisIds.has(proposal.axisId)
    && (
      proposal.axisId !== "influence_scope"
      || influenceIntent
    ));
  if (proposal && !validProposal) {
    rejectedDecisionReasons["v5-scout-axis-proposal"] =
      "unsupported_or_unconfirmed_server_axis";
  }
  // A missing or failed scout never suppresses a compiler-supported axis.
  // The proposal can nominate only the registry ID; all executable semantics
  // below remain server-owned and are identical across scout outcomes.
  if (input.scoutFailure
    && (
      deterministicInfluence
      || deterministicArtifactAxes.length > 0
    )) {
    rejectedDecisionReasons["v5-scout-failure"] =
      "deterministic_server_axis_used";
  }
  const correctnessCandidates = candidates.filter(
    ({ mode }) => mode === "correctness_blocking",
  );
  const consideredCandidates = correctnessCandidates.length > 0
    ? correctnessCandidates
    : candidates;
  if (correctnessCandidates.length > 0) {
    candidates
      .filter(({ mode }) => mode === "nuance_optional")
      .forEach(({ id }) => {
        rejectedDecisionReasons[id] = "correctness_axis_precedes_nuance";
      });
  }
  const v5CandidateById = new Map<string, GuidanceDecisionV5>();
  const eligible = consideredCandidates.filter((decision) => {
    if (questionRoundLimitReached) {
      rejectedDecisionReasons[decision.id] =
        "root_question_round_limit";
      return false;
    }
    if (answeredAxes.has(guidanceAxisKey(decision.axis))) {
      rejectedDecisionReasons[decision.id] = "axis_already_answered";
      return false;
    }
    const v5Candidate = createDecisionV5({
      decision,
      baseContract: input.baseContract,
      capabilitySnapshotHash: input.capabilitySnapshotHash,
      semanticConfigurationHash: input.semanticConfigurationHash,
      expectedRolloutGroup: input.expectedRolloutGroup,
    });
    v5CandidateById.set(decision.id, v5Candidate);
    if (priorQuestionHashes.has(v5Candidate.questionHash)) {
      rejectedDecisionReasons[decision.id] = "question_hash_already_used";
      return false;
    }
    const clarificationAttempts = Object.entries(
      input.clarificationAttemptsByAxis ?? {},
    ).reduce((count, [axis, attempts]) => (
      guidanceAxisKey(axis) === guidanceAxisKey(decision.axis)
        ? count + Math.max(0, attempts)
        : count
    ), 0);
    if (clarificationAttempts >= 2) {
      rejectedDecisionReasons[decision.id] =
        "clarification_attempt_limit";
      return false;
    }
    return true;
  });
  const blocking = eligible.find(
    ({ mode }) => mode === "correctness_blocking",
  );
  const unresolvedCorrectness = blocking === undefined
    && v4.correctnessCandidateAxes.some((axis) => !answeredAxes.has(axis));
  const optionalCandidates = eligible
    .filter(({ mode }) => mode === "nuance_optional")
    .sort((left, right) => (
      right.materialityScore - left.materialityScore
      || left.id.localeCompare(right.id)
    ));
  const proposedOptional = validProposal
    ? optionalCandidates.find(({ axis }) => (
        guidanceAxisKey(axis) === guidanceAxisKey(proposal!.axisId)
      ))
    : undefined;
  const optional = unresolvedCorrectness
    ? undefined
    : proposedOptional ?? optionalCandidates[0];
  // Guidance is progressive: resolve one correctness axis before offering a
  // nuance axis. Showing both at once lets a soft taste answer race ahead of a
  // contract-changing clarification and makes descendant invalidation
  // ambiguous.
  const selected = blocking ? [blocking] : optional ? [optional] : [];
  if (selected.length === 0) {
    const executionDecision = createExecutionDecisionV5({
      baseContract: input.baseContract,
      interpretationSummary: v4.interpretationSummary,
      capabilitySnapshotHash: input.capabilitySnapshotHash,
      semanticConfigurationHash: input.semanticConfigurationHash,
      unresolvedCorrectness,
    });
    if (priorQuestionHashes.has(executionDecision.decisionHash)) {
      throw new Error("guidance_v5_execution_decision_already_used");
    }
    const body = {
      policyVersion: ADAPTIVE_GUIDANCE_POLICY_VERSION_V5,
      mode: "execution_decision" as const,
      decisionHashes: [] as string[],
      executionDecisionHash: executionDecision.decisionHash,
      interpretationSummary: v4.interpretationSummary,
      rejectedDecisionReasons,
    };
    return {
      policyVersion: ADAPTIVE_GUIDANCE_POLICY_VERSION_V5,
      mode: "execution_decision",
      decisions: [],
      executionDecision,
      interpretationSummary: v4.interpretationSummary,
      rejectedDecisionReasons,
      checkpointHash: sha256Hex(stableStringify(body)),
    };
  }
  const decisions = selected.map((decision) => {
    const prepared = v5CandidateById.get(decision.id);
    if (!prepared) {
      throw new Error("guidance_v5_prepared_candidate_missing");
    }
    return prepared;
  });
  const mode = decisions.some(({ mode }) => mode === "correctness_blocking")
    ? "correctness_blocking" as const
    : "nuance_optional" as const;
  const body = {
    policyVersion: ADAPTIVE_GUIDANCE_POLICY_VERSION_V5,
    mode,
    decisionHashes: decisions.map(({ questionHash }) => questionHash),
    interpretationSummary: v4.interpretationSummary,
    rejectedDecisionReasons,
  };
  return {
    policyVersion: ADAPTIVE_GUIDANCE_POLICY_VERSION_V5,
    mode,
    decisions,
    interpretationSummary: v4.interpretationSummary,
    rejectedDecisionReasons,
    checkpointHash: sha256Hex(stableStringify(body)),
  };
}

export function assertGuidanceDecisionV5(
  decision: GuidanceDecisionV5,
  baseContract?: PlaylistContractRevisionV1,
): void {
  const consumerRegistry = guidanceRuntimeConsumerRegistryV5(
    decision.capabilitySnapshotHash,
  );
  if (decision.schemaVersion !== 5
    || decision.policyVersion !== ADAPTIVE_GUIDANCE_POLICY_VERSION_V5
    || decision.axisRegistryVersion !== GUIDANCE_AXIS_REGISTRY_VERSION_V5
    || decision.simulationPolicyVersion
      !== GUIDANCE_OPTION_SIMULATION_POLICY_VERSION_V5
    || !/^[a-f0-9]{64}$/u.test(decision.capabilitySnapshotHash)
    || !/^[a-f0-9]{64}$/u.test(decision.semanticConfigurationHash)
    || !decision.rolloutGroup
    || decision.consumerRegistryHash !== consumerRegistry.hash
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
  if (decision.options.some((option) => (
    option.recommended
      ? !option.recommendationReason?.trim()
      : option.recommendationReason !== undefined
  ))) {
    throw new Error("invalid_guidance_v5_recommendation_reason");
  }
  const simulationByOption = new Map(
    decision.simulations.map((simulation) => [
      simulation.optionId,
      simulation,
    ]),
  );
  const registered = GUIDANCE_AXIS_REGISTRY_V5[
    decision.axis as GuidanceAxisDefinitionV5["id"]
  ];
  const nonNoopEffects = new Set<string>();
  for (const option of decision.options) {
    const simulation = simulationByOption.get(option.id);
    if (!simulation) {
      throw new Error("invalid_guidance_v5_option_simulation");
    }
    const simulationReceiptBody = Object.fromEntries(
      Object.entries(simulation).filter(
        ([key]) => key !== "simulationReceiptHash",
      ),
    );
    if (simulation.successorRolloutGroup !== decision.rolloutGroup
      || (
        decision.mode === "nuance_optional"
        && simulation.baseRolloutGroup !== decision.rolloutGroup
      )
      || !/^[a-f0-9]{64}$/u.test(simulation.beforeQueryPlanHash)
      || !/^[a-f0-9]{64}$/u.test(simulation.afterQueryPlanHash)
      || simulation.simulationReceiptHash
        !== sha256Hex(stableStringify(simulationReceiptBody))) {
      throw new Error("guidance_v5_rollout_group_simulation_mismatch");
    }
    const noop = option.patch.operations.length === 0;
    if (noop) {
      if (simulation.successorSemanticHash !== null
        || simulation.beforeQueryPlanHash !== simulation.afterQueryPlanHash
        || simulation.executionEffect !== null
        || simulation.consumerReceipt !== null
        || (
          option.explicitNoop !== true
          && option.id !== "keep_current_interpretation"
        )) {
        throw new Error("guidance_v5_noop_simulation_invalid");
      }
      continue;
    }
    if (!simulation.successorSemanticHash
      || !/^[a-f0-9]{64}$/u.test(simulation.successorSemanticHash)
      || simulation.beforeQueryPlanHash === simulation.afterQueryPlanHash
      || !simulation.executionEffect
      || !simulation.consumerReceipt
      || !/^[a-f0-9]{64}$/u.test(
        simulation.executionEffect.beforeConsumerResultHash,
      )
      || !/^[a-f0-9]{64}$/u.test(
        simulation.executionEffect.afterConsumerResultHash,
      )
      || simulation.executionEffect.beforeConsumerResultHash
        === simulation.executionEffect.afterConsumerResultHash
      || !/^[a-f0-9]{64}$/u.test(simulation.executionEffect.effectHash)) {
      throw new Error("guidance_v5_non_noop_simulation_invalid");
    }
    const expectedConsumer = consumerForField(
      consumerRegistry,
      decision.axis,
      simulation.executionEffect.field,
    );
    const receiptBody = Object.fromEntries(
      Object.entries(simulation.consumerReceipt).filter(
        ([key]) => key !== "receiptHash",
      ),
    );
    if (simulation.consumerReceipt.receiptHash
        !== sha256Hex(stableStringify(receiptBody))
      || simulation.consumerReceipt.registryVersion
        !== GUIDANCE_RUNTIME_CONSUMER_REGISTRY_VERSION_V5
      || simulation.consumerReceipt.registryHash !== consumerRegistry.hash
      || simulation.consumerReceipt.capabilitySnapshotHash
        !== decision.capabilitySnapshotHash
      || simulation.consumerReceipt.axis !== decision.axis
      || simulation.consumerReceipt.field
        !== simulation.executionEffect.field
      || simulation.consumerReceipt.consumerId
        !== simulation.executionEffect.consumerId
      || simulation.executionEffect.consumerId
        !== expectedConsumer.consumerId) {
      throw new Error("guidance_v5_registered_consumer_mismatch");
    }
    if (registered
      && simulation.executionEffect.field !== registered.executionField) {
      throw new Error("guidance_v5_registered_execution_field_mismatch");
    }
    if (nonNoopEffects.has(simulation.executionEffect.effectHash)) {
      throw new Error("guidance_v5_duplicate_worker_effect");
    }
    nonNoopEffects.add(simulation.executionEffect.effectHash);
  }
  if (baseContract) {
    const expected = simulateOptions({
      baseContract,
      axis: decision.axis,
      mode: decision.mode,
      questionIdentity: decision.id,
      options: decision.options,
      consumerRegistry,
      expectedRolloutGroup: decision.rolloutGroup,
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
