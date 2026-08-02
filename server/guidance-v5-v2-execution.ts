import type {
  PlaylistGuidanceAnswer,
  PlaylistGuidanceQuestion,
  SelectionPlan,
} from "../shared/types.ts";
import {
  ADAPTIVE_GUIDANCE_POLICY_VERSION_V5,
  type GuidanceExecutionFieldV5,
} from "./adaptive-guidance-v5.ts";
import {
  compileGuidanceExecutionActionV5,
  compileGuidanceRoundPatchV3,
  guidanceDecisionV5FromPublicQuestion,
  guidanceExecutionDecisionV5FromPublicQuestion,
} from "./adaptive-guidance-contract-bridge.ts";
import {
  applyPlaylistContractPatchV1,
  assertPlaylistContractIntegrityV1,
  type PlaylistContractRevisionV1,
} from "./playlist-contract-v1.ts";
import {
  projectPlaylistContractExecutionV1,
} from "./playlist-contract-execution-bridge-v1.ts";
import { selectionPlanResearchContext } from "./selection-plan-v2.ts";
import { sha256Hex, stableStringify } from "./security.ts";

export const GUIDANCE_V5_V2_EXECUTION_AUTHORITY_CHECKPOINT =
  "v2:guidance:v5:execution-authority" as const;
export const GUIDANCE_V5_V2_WORKER_CONSUMPTION_CHECKPOINT =
  "v2:guidance:v5:worker-consumption" as const;
export const GUIDANCE_V5_V2_EXECUTION_SCHEMA =
  "genio-guidance-v5-v2-worker-consumption/v1" as const;

const V2_CONSUMERS: Readonly<Record<GuidanceExecutionFieldV5, string>> =
  Object.freeze({
    membershipPredicates: "catalog_first_v2:selectionPlanResearchContext.hardConstraints",
    rankingObjectives: "catalog_first_v2:selectionPlanResearchContext.softGoals",
    orderingPolicy: "catalog_first_v2:selectionPlanResearchContext.orderingPolicy",
    playlistQuotaRules: "catalog_first_v2:selectionPlanResearchContext.diversityGoals",
    playlistQualityPolicy: "catalog_first_v2:selectionPlanResearchContext.evidencePolicy",
  });

const V2_CONSUMER_AXES: Readonly<
  Partial<Record<GuidanceExecutionFieldV5, readonly string[]>>
> = Object.freeze({
  rankingObjectives: Object.freeze([
    "influence_scope",
    "relationship_scope",
    "energy_mood_intensity",
    "recording_version_preference",
    "familiarity_balance",
    "artist_diversity",
    "selection_tiebreak",
  ]),
  orderingPolicy: Object.freeze(["playlist_flow"]),
});

export interface GuidanceV5V2ExecutionAuthority {
  readonly schemaVersion: typeof GUIDANCE_V5_V2_EXECUTION_SCHEMA;
  readonly kind: "execution_authority";
  readonly route: "catalog_first_v2";
  readonly questionSetHash: string;
  readonly questionId: string;
  readonly questionHash: string;
  readonly selectedOptionId: string;
  readonly selectionAnswerHash: string;
  readonly axis: string;
  readonly explicitNoop: boolean;
  readonly baseContractRevisionId: string;
  readonly baseContractSemanticHash: string;
  readonly successorContractRevisionId: string;
  readonly successorContractSemanticHash: string;
  readonly beforeSelectionPlanHash: string;
  readonly afterSelectionPlanHash: string;
  readonly selectionPlanHash: string;
  readonly executionField: GuidanceExecutionFieldV5 | null;
  readonly upstreamConsumerId: string | null;
  readonly v2ConsumerId: string | null;
  readonly beforeWorkerProjectionHash: string;
  readonly afterWorkerProjectionHash: string;
  readonly expectedWorkerProjectionHash: string;
  readonly resultEffectHash: string | null;
  readonly authorityHash: string;
}

export interface GuidanceV5V2WorkerConsumptionReceipt {
  readonly schemaVersion: typeof GUIDANCE_V5_V2_EXECUTION_SCHEMA;
  readonly kind: "worker_consumption";
  readonly status: "consumed" | "explicit_noop";
  readonly route: "catalog_first_v2";
  readonly authorityHash: string;
  readonly questionSetHash: string;
  readonly questionHash: string;
  readonly selectedOptionId: string;
  readonly axis: string;
  readonly successorContractRevisionId: string;
  readonly successorContractSemanticHash: string;
  readonly selectionPlanHash: string;
  readonly executionField: GuidanceExecutionFieldV5 | null;
  readonly v2ConsumerId: string | null;
  readonly beforeWorkerProjectionHash: string;
  readonly afterWorkerProjectionHash: string;
  readonly resultEffectHash: string | null;
  readonly workerProjectionHash: string;
  readonly receiptHash: string;
  /** Operational fields are deliberately excluded from `receiptHash`. */
  readonly consumedAt: string;
  readonly jobId: string;
  readonly workerId: string;
  readonly leaseEpoch: number;
}

function hash(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

function safeHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isGuidanceExecutionFieldV5(
  value: unknown,
): value is GuidanceExecutionFieldV5 {
  return typeof value === "string" && [
    "membershipPredicates",
    "rankingObjectives",
    "orderingPolicy",
    "playlistQuotaRules",
    "playlistQualityPolicy",
  ].includes(value);
}

function withoutHash(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([candidate]) => candidate !== key),
  );
}

/**
 * The exact V2 field passed by `selectionPlanResearchContext` to discovery.
 * This is intentionally narrower than the whole SelectionPlan so the receipt
 * proves the selected answer reached the declared runtime consumer.
 */
export function selectionPlanGuidanceProjectionV5V2(
  plan: SelectionPlan,
  field: GuidanceExecutionFieldV5 | null,
): unknown {
  const context = selectionPlanResearchContext(plan);
  if (!context) {
    throw new Error("guidance_v5_v2_research_context_missing");
  }
  if (field === "membershipPredicates") {
    return context.hardConstraints;
  }
  if (field === "rankingObjectives") {
    return {
      intents: [...context.intents].sort(),
      softGoals: [...context.softGoals].sort((left, right) => (
        left.id.localeCompare(right.id)
      )),
    };
  }
  if (field === "orderingPolicy") {
    return structuredClone(context.orderingPolicy);
  }
  if (field === "playlistQuotaRules") {
    return structuredClone(context.diversityGoals);
  }
  if (field === "playlistQualityPolicy") {
    return {
      evidencePolicy: context.evidencePolicy,
      versionPolicy: structuredClone(context.versionPolicy),
      contentPolicy: structuredClone(context.contentPolicy),
    };
  }
  // An explicit no-op still binds the complete plan so a worker cannot run a
  // different contract while claiming it honored the user's confirmation.
  return structuredClone(plan);
}

function v2ConsumerId(
  axis: string,
  field: GuidanceExecutionFieldV5,
): string {
  if (!V2_CONSUMER_AXES[field]?.includes(axis)) {
    throw new Error("guidance_v5_v2_axis_consumer_missing");
  }
  return V2_CONSUMERS[field];
}

export function projectGuidanceV5SuccessorToSelectionPlanV2(input: {
  successorContract: PlaylistContractRevisionV1;
  basePlan: Pick<
    SelectionPlan,
    "requestedTrackCount" | "minimumQualifiedTrackCount" | "storefront"
  >;
}): SelectionPlan {
  const projected = projectPlaylistContractExecutionV1({
    contract: input.successorContract,
    basePlan: input.basePlan,
  }).plan;
  const sequencingClauseIds = new Set(
    input.successorContract.sequencingObjectives.map(({ clauseId }) => clauseId),
  );
  const centralQualityClauseIds = new Set(
    input.successorContract.qualityPolicy.centralSuitabilityClauseIds,
  );
  const axisForV2 = (
    axis: string,
  ): SelectionPlan["constraints"][number]["axis"] => {
    if ([
      "genre", "scene", "subgenre", "era", "geography", "language",
      "mood", "activity", "theme", "artist", "album", "track", "label",
      "venue", "recording_version", "content", "evidence", "relationship",
    ].includes(axis)) {
      return axis as SelectionPlan["constraints"][number]["axis"];
    }
    if (axis === "relationship_scope") return "relationship";
    if (axis === "recording_version_preference") return "recording_version";
    if (axis === "energy_mood_intensity") return "mood";
    // Influence, familiarity, discovery and tie-break axes are ranking data,
    // not hard musical membership. V2's typed `evidence` soft-goal channel is
    // the lossless compatibility carrier consumed by its research context.
    return "evidence";
  };
  const softConstraints = input.successorContract.clauses.flatMap((clause) => {
    if (clause.hardness !== "soft"
      || !["ranking_preference", "suitability"].includes(clause.kind)
      || sequencingClauseIds.has(clause.id)
      || centralQualityClauseIds.has(clause.id)
      || clause.values.length === 0) {
      return [];
    }
    return [{
      id: clause.id,
      axis: axisForV2(clause.axis),
      operator: "prefer" as const,
      values: [...clause.values],
      kind: "soft" as const,
      relaxationRank: 1,
    }];
  });
  const constraints = [
    ...new Map(
      [...projected.constraints, ...softConstraints]
        .map((constraint) => [constraint.id, constraint]),
    ).values(),
  ];
  return {
    ...projected,
    constraints,
    softGoalRelaxationOrder: constraints
      .filter(({ kind }) => kind === "soft")
      .map(({ id }) => id),
  };
}

function selectedAnswer(input: {
  question: PlaylistGuidanceQuestion;
  answer: PlaylistGuidanceAnswer;
}): {
  optionId: string;
  explicitNoop: boolean;
  field: GuidanceExecutionFieldV5 | null;
  upstreamConsumerId: string | null;
  axis: string;
} {
  if (input.answer.questionId !== input.question.id
    || input.answer.customText
    || input.answer.optionIds?.length) {
    throw new Error("guidance_v5_v2_execution_answer_invalid");
  }
  if (input.question.guidanceMode === "execution_decision") {
    if (typeof input.answer.optionId !== "string") {
      throw new Error("guidance_v5_v2_execution_decision_missing");
    }
    const decision = guidanceExecutionDecisionV5FromPublicQuestion(
      input.question,
    );
    const action = compileGuidanceExecutionActionV5(decision, {
      decisionHash: decision.decisionHash,
      optionId: input.answer.optionId,
    });
    if (!action.startsResearch) {
      throw new Error("guidance_v5_v2_execution_not_authorized");
    }
    return {
      optionId: input.answer.optionId,
      explicitNoop: true,
      field: null,
      upstreamConsumerId: null,
      axis: decision.axis,
    };
  }
  const decision = guidanceDecisionV5FromPublicQuestion(input.question);
  if (input.answer.skipped === true) {
    if (input.question.criticality === "required") {
      throw new Error("guidance_v5_v2_required_answer_skipped");
    }
    return {
      optionId: "__skipped__",
      explicitNoop: true,
      field: null,
      upstreamConsumerId: null,
      axis: decision.axis,
    };
  }
  if (typeof input.answer.optionId !== "string") {
    throw new Error("guidance_v5_v2_execution_option_missing");
  }
  const option = input.question.options.find(
    ({ id }) => id === input.answer.optionId,
  );
  const simulation = decision.simulations.find(
    ({ optionId }) => optionId === input.answer.optionId,
  );
  if (!option || !simulation || !option.optionSimulation) {
    throw new Error("guidance_v5_v2_execution_option_invalid");
  }
  const explicitNoop = option.contractPatch?.operations.length === 0
    && (
      option.explicitNoop === true
      || option.id === "keep_current_interpretation"
    );
  if (explicitNoop !== (simulation.executionEffect === null)) {
    throw new Error("guidance_v5_v2_execution_effect_shape_mismatch");
  }
  return {
    optionId: input.answer.optionId,
    explicitNoop,
    field: simulation.executionEffect?.field ?? null,
    upstreamConsumerId: simulation.executionEffect?.consumerId ?? null,
    axis: decision.axis,
  };
}

export function createGuidanceV5V2ExecutionAuthority(input: {
  questionSetHash: string;
  question: PlaylistGuidanceQuestion;
  answer: PlaylistGuidanceAnswer;
  baseContract: PlaylistContractRevisionV1;
  successorContract: PlaylistContractRevisionV1;
  selectionPlan: SelectionPlan;
}): GuidanceV5V2ExecutionAuthority {
  if (!safeHash(input.questionSetHash)
    || input.question.schemaVersion !== 5
    || input.question.policyVersion !== ADAPTIVE_GUIDANCE_POLICY_VERSION_V5
    || !safeHash(input.question.questionHash)) {
    throw new Error("guidance_v5_v2_execution_authority_invalid");
  }
  assertPlaylistContractIntegrityV1(input.baseContract);
  assertPlaylistContractIntegrityV1(input.successorContract);
  const selected = selectedAnswer(input);
  let expectedSuccessor = input.baseContract;
  if (input.question.guidanceMode !== "execution_decision"
    && input.answer.skipped !== true) {
    const patch = compileGuidanceRoundPatchV3({
      base: input.baseContract,
      questionSetHash: input.questionSetHash,
      questions: [input.question],
      answers: [input.answer],
    });
    expectedSuccessor = patch
      ? applyPlaylistContractPatchV1(input.baseContract, patch)
      : input.baseContract;
  }
  if (expectedSuccessor.revisionId !== input.successorContract.revisionId
    || expectedSuccessor.semanticHash
      !== input.successorContract.semanticHash
    || stableStringify(expectedSuccessor)
      !== stableStringify(input.successorContract)) {
    throw new Error("guidance_v5_v2_execution_successor_mismatch");
  }
  const basePlanSeed = {
    requestedTrackCount: input.selectionPlan.requestedTrackCount,
    minimumQualifiedTrackCount: input.selectionPlan.minimumQualifiedTrackCount,
    storefront: input.selectionPlan.storefront,
  };
  const beforePlan = projectGuidanceV5SuccessorToSelectionPlanV2({
    successorContract: input.baseContract,
    basePlan: basePlanSeed,
  });
  const expectedPlan = projectGuidanceV5SuccessorToSelectionPlanV2({
    successorContract: input.successorContract,
    basePlan: basePlanSeed,
  });
  if (stableStringify(expectedPlan) !== stableStringify(input.selectionPlan)) {
    throw new Error("guidance_v5_v2_execution_plan_mismatch");
  }
  const beforeProjection = selectionPlanGuidanceProjectionV5V2(
    beforePlan,
    selected.field,
  );
  const afterProjection = selectionPlanGuidanceProjectionV5V2(
    input.selectionPlan,
    selected.field,
  );
  const beforeSelectionPlanHash = hash(beforePlan);
  const afterSelectionPlanHash = hash(input.selectionPlan);
  const beforeWorkerProjectionHash = hash(beforeProjection);
  const afterWorkerProjectionHash = hash(afterProjection);
  let consumerId: string | null = null;
  let resultEffectHash: string | null = null;
  if (selected.field === null) {
    if (!selected.explicitNoop
      || beforeSelectionPlanHash !== afterSelectionPlanHash
      || beforeWorkerProjectionHash !== afterWorkerProjectionHash) {
      throw new Error("guidance_v5_v2_execution_noop_effect_invalid");
    }
  } else {
    consumerId = v2ConsumerId(selected.axis, selected.field);
    if (beforeSelectionPlanHash === afterSelectionPlanHash
      || beforeWorkerProjectionHash === afterWorkerProjectionHash) {
      throw new Error("guidance_v5_v2_execution_zero_consumer_effect");
    }
    resultEffectHash = hash({
      axis: selected.axis,
      field: selected.field,
      consumerId,
      beforeSelectionPlanHash,
      afterSelectionPlanHash,
      beforeWorkerProjectionHash,
      afterWorkerProjectionHash,
    });
  }
  const body = {
    schemaVersion: GUIDANCE_V5_V2_EXECUTION_SCHEMA,
    kind: "execution_authority" as const,
    route: "catalog_first_v2" as const,
    questionSetHash: input.questionSetHash,
    questionId: input.question.id,
    questionHash: input.question.questionHash,
    selectedOptionId: selected.optionId,
    selectionAnswerHash: hash({
      questionHash: input.question.questionHash,
      optionId: selected.optionId,
    }),
    axis: selected.axis,
    explicitNoop: selected.explicitNoop,
    baseContractRevisionId: input.baseContract.revisionId,
    baseContractSemanticHash: input.baseContract.semanticHash,
    successorContractRevisionId: input.successorContract.revisionId,
    successorContractSemanticHash: input.successorContract.semanticHash,
    beforeSelectionPlanHash,
    afterSelectionPlanHash,
    selectionPlanHash: afterSelectionPlanHash,
    executionField: selected.field,
    upstreamConsumerId: selected.upstreamConsumerId,
    v2ConsumerId: consumerId,
    beforeWorkerProjectionHash,
    afterWorkerProjectionHash,
    expectedWorkerProjectionHash: afterWorkerProjectionHash,
    resultEffectHash,
  };
  return Object.freeze({
    ...body,
    authorityHash: hash(body),
  });
}

export function assertGuidanceV5V2ExecutionAuthority(
  value: unknown,
): asserts value is GuidanceV5V2ExecutionAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("guidance_v5_v2_execution_authority_missing");
  }
  const row = value as Partial<GuidanceV5V2ExecutionAuthority>;
  if (row.schemaVersion !== GUIDANCE_V5_V2_EXECUTION_SCHEMA
    || row.kind !== "execution_authority"
    || row.route !== "catalog_first_v2"
    || !safeHash(row.questionSetHash)
    || typeof row.questionId !== "string"
    || !safeHash(row.questionHash)
    || typeof row.selectedOptionId !== "string"
    || !safeHash(row.selectionAnswerHash)
    || typeof row.axis !== "string"
    || typeof row.explicitNoop !== "boolean"
    || typeof row.baseContractRevisionId !== "string"
    || !safeHash(row.baseContractSemanticHash)
    || typeof row.successorContractRevisionId !== "string"
    || !safeHash(row.successorContractSemanticHash)
    || !safeHash(row.beforeSelectionPlanHash)
    || !safeHash(row.afterSelectionPlanHash)
    || !safeHash(row.selectionPlanHash)
    || row.selectionPlanHash !== row.afterSelectionPlanHash
    || !safeHash(row.beforeWorkerProjectionHash)
    || !safeHash(row.afterWorkerProjectionHash)
    || !safeHash(row.expectedWorkerProjectionHash)
    || row.expectedWorkerProjectionHash !== row.afterWorkerProjectionHash
    || (row.resultEffectHash !== null && !safeHash(row.resultEffectHash))
    || !safeHash(row.authorityHash)) {
    throw new Error("guidance_v5_v2_execution_authority_invalid");
  }
  if (row.executionField === null) {
    if (!row.explicitNoop
      || row.upstreamConsumerId !== null
      || row.v2ConsumerId !== null
      || row.resultEffectHash !== null
      || row.beforeSelectionPlanHash !== row.afterSelectionPlanHash
      || row.beforeWorkerProjectionHash !== row.afterWorkerProjectionHash) {
      throw new Error("guidance_v5_v2_execution_noop_invalid");
    }
  } else if (!isGuidanceExecutionFieldV5(row.executionField)
    || typeof row.upstreamConsumerId !== "string"
    || row.v2ConsumerId !== v2ConsumerId(row.axis, row.executionField)
    || !safeHash(row.resultEffectHash)
    || row.beforeSelectionPlanHash === row.afterSelectionPlanHash
    || row.beforeWorkerProjectionHash === row.afterWorkerProjectionHash
    || row.resultEffectHash !== hash({
      axis: row.axis,
      field: row.executionField,
      consumerId: row.v2ConsumerId,
      beforeSelectionPlanHash: row.beforeSelectionPlanHash,
      afterSelectionPlanHash: row.afterSelectionPlanHash,
      beforeWorkerProjectionHash: row.beforeWorkerProjectionHash,
      afterWorkerProjectionHash: row.afterWorkerProjectionHash,
    })) {
    throw new Error("guidance_v5_v2_execution_consumer_invalid");
  }
  const body = withoutHash(
    row as unknown as Record<string, unknown>,
    "authorityHash",
  );
  if (row.authorityHash !== hash(body)) {
    throw new Error("guidance_v5_v2_execution_authority_hash_mismatch");
  }
}

export function verifyGuidanceV5V2WorkerConsumption(input: {
  authority: unknown;
  selectionPlan: SelectionPlan;
  jobId: string;
  workerId: string;
  leaseEpoch: number;
  consumedAt?: string;
}): GuidanceV5V2WorkerConsumptionReceipt {
  assertGuidanceV5V2ExecutionAuthority(input.authority);
  const authority = input.authority;
  if (!input.jobId
    || !input.workerId
    || !Number.isSafeInteger(input.leaseEpoch)
    || input.leaseEpoch < 1
    || input.selectionPlan.pipelineVersion !== "catalog_first_v2"
    || hash(input.selectionPlan) !== authority.selectionPlanHash) {
    throw new Error("guidance_v5_v2_worker_claim_identity_mismatch");
  }
  const workerProjection = selectionPlanGuidanceProjectionV5V2(
    input.selectionPlan,
    authority.executionField,
  );
  const workerProjectionHash = hash(workerProjection);
  if (workerProjectionHash !== authority.expectedWorkerProjectionHash) {
    throw new Error("guidance_v5_v2_worker_effect_not_consumed");
  }
  const deterministic = {
    schemaVersion: GUIDANCE_V5_V2_EXECUTION_SCHEMA,
    kind: "worker_consumption" as const,
    status: authority.explicitNoop
      ? "explicit_noop" as const
      : "consumed" as const,
    route: "catalog_first_v2" as const,
    authorityHash: authority.authorityHash,
    questionSetHash: authority.questionSetHash,
    questionHash: authority.questionHash,
    selectedOptionId: authority.selectedOptionId,
    axis: authority.axis,
    successorContractRevisionId: authority.successorContractRevisionId,
    successorContractSemanticHash: authority.successorContractSemanticHash,
    selectionPlanHash: authority.selectionPlanHash,
    executionField: authority.executionField,
    v2ConsumerId: authority.v2ConsumerId,
    beforeWorkerProjectionHash: authority.beforeWorkerProjectionHash,
    afterWorkerProjectionHash: authority.afterWorkerProjectionHash,
    resultEffectHash: authority.resultEffectHash,
    workerProjectionHash,
  };
  return Object.freeze({
    ...deterministic,
    receiptHash: hash(deterministic),
    consumedAt: input.consumedAt ?? new Date().toISOString(),
    jobId: input.jobId,
    workerId: input.workerId,
    leaseEpoch: input.leaseEpoch,
  });
}

export function assertGuidanceV5V2WorkerConsumptionReceipt(
  value: unknown,
): asserts value is GuidanceV5V2WorkerConsumptionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("guidance_v5_v2_worker_consumption_receipt_missing");
  }
  const row = value as Partial<GuidanceV5V2WorkerConsumptionReceipt>;
  if (row.schemaVersion !== GUIDANCE_V5_V2_EXECUTION_SCHEMA
    || row.kind !== "worker_consumption"
    || (row.status !== "consumed" && row.status !== "explicit_noop")
    || row.route !== "catalog_first_v2"
    || !safeHash(row.authorityHash)
    || !safeHash(row.questionSetHash)
    || !safeHash(row.questionHash)
    || typeof row.selectedOptionId !== "string"
    || typeof row.axis !== "string"
    || typeof row.successorContractRevisionId !== "string"
    || !safeHash(row.successorContractSemanticHash)
    || !safeHash(row.selectionPlanHash)
    || !safeHash(row.beforeWorkerProjectionHash)
    || !safeHash(row.afterWorkerProjectionHash)
    || (row.resultEffectHash !== null && !safeHash(row.resultEffectHash))
    || !safeHash(row.workerProjectionHash)
    || !safeHash(row.receiptHash)
    || typeof row.consumedAt !== "string"
    || typeof row.jobId !== "string"
    || typeof row.workerId !== "string"
    || !Number.isSafeInteger(row.leaseEpoch)
    || Number(row.leaseEpoch) < 1) {
    throw new Error("guidance_v5_v2_worker_consumption_receipt_invalid");
  }
  if (row.executionField === null) {
    if (row.status !== "explicit_noop"
      || row.v2ConsumerId !== null
      || row.resultEffectHash !== null
      || row.beforeWorkerProjectionHash !== row.afterWorkerProjectionHash) {
      throw new Error("guidance_v5_v2_worker_consumption_noop_invalid");
    }
  } else if (!isGuidanceExecutionFieldV5(row.executionField)
    || row.v2ConsumerId !== v2ConsumerId(row.axis, row.executionField)
    || !safeHash(row.resultEffectHash)
    || row.beforeWorkerProjectionHash === row.afterWorkerProjectionHash) {
    throw new Error("guidance_v5_v2_worker_consumption_consumer_invalid");
  }
  const deterministic = {
    schemaVersion: row.schemaVersion,
    kind: row.kind,
    status: row.status,
    route: row.route,
    authorityHash: row.authorityHash,
    questionSetHash: row.questionSetHash,
    questionHash: row.questionHash,
    selectedOptionId: row.selectedOptionId,
    axis: row.axis,
    successorContractRevisionId: row.successorContractRevisionId,
    successorContractSemanticHash: row.successorContractSemanticHash,
    selectionPlanHash: row.selectionPlanHash,
    executionField: row.executionField,
    v2ConsumerId: row.v2ConsumerId,
    beforeWorkerProjectionHash: row.beforeWorkerProjectionHash,
    afterWorkerProjectionHash: row.afterWorkerProjectionHash,
    resultEffectHash: row.resultEffectHash,
    workerProjectionHash: row.workerProjectionHash,
  };
  if (row.receiptHash !== hash(deterministic)) {
    throw new Error("guidance_v5_v2_worker_consumption_receipt_hash_mismatch");
  }
}
