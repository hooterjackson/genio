import type {
  PlaylistGuidanceAnswer,
  PlaylistGuidanceQuestion,
  QueryPlanV3,
} from "../shared/types.ts";
import {
  ADAPTIVE_GUIDANCE_POLICY_VERSION_V5,
  guidanceRuntimeConsumerRegistryV5,
  type GuidanceConsumerReceiptV5,
  type GuidanceExecutionEffectV5,
  type GuidanceExecutionFieldV5,
} from "./adaptive-guidance-v5.ts";
import {
  compileGuidanceRoundPatchV3,
  guidanceDecisionV5FromPublicQuestion,
} from "./adaptive-guidance-contract-bridge.ts";
import {
  applyPlaylistContractPatchV1,
  assertPlaylistContractIntegrityV1,
  type PlaylistContractRevisionV1,
} from "./playlist-contract-v1.ts";
import { projectPlaylistContractExecutionV1 } from "./playlist-contract-execution-bridge-v1.ts";
import {
  createQueryPlanV3,
  queryPlanV3Hash,
} from "./query-plan-v3.ts";
import {
  selectionPlanV3Hash,
  type SelectionPlanV3,
} from "./selection-plan-v3.ts";
import {
  assertGuidanceRuntimeConsumerEffectV5,
  guidanceRuntimeConsumerResultV5,
  type GuidanceRuntimeAxisV5,
} from "./pipeline-v3-retrieval.ts";
import { sha256Hex, stableStringify } from "./security.ts";

export const GUIDANCE_V5_EXECUTION_AUTHORITY_CHECKPOINT =
  "v3:guidance:v5:execution-authority" as const;
export const GUIDANCE_V5_WORKER_CONSUMPTION_SCHEMA =
  "genio-guidance-v5-worker-consumption/v1" as const;

export interface GuidanceWorkerExecutionAuthorityV5 {
  readonly schemaVersion: typeof GUIDANCE_V5_WORKER_CONSUMPTION_SCHEMA;
  readonly kind: "execution_authority";
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
  readonly beforeQueryPlanHash: string;
  readonly afterQueryPlanHash: string;
  readonly queryPlanHash: string;
  readonly queryPlanRevisionId: string | null;
  readonly capabilitySnapshotHash: string;
  readonly semanticConfigurationHash: string;
  readonly patchHash: string;
  readonly affectedClauseIds: readonly string[];
  readonly beforeExecutionProjection: unknown;
  readonly afterExecutionProjection: unknown;
  readonly beforeConsumerResultHash: string;
  readonly afterConsumerResultHash: string;
  readonly resultEffectHash: string | null;
  readonly executionEffect: GuidanceExecutionEffectV5 | null;
  readonly consumerReceipt: GuidanceConsumerReceiptV5 | null;
  readonly authorityHash: string;
}

export interface GuidanceWorkerConsumptionReceiptV5 {
  readonly schemaVersion: typeof GUIDANCE_V5_WORKER_CONSUMPTION_SCHEMA;
  readonly kind: "worker_consumption";
  readonly status: "consumed" | "explicit_noop";
  readonly authorityHash: string;
  readonly questionSetHash: string;
  readonly questionHash: string;
  readonly selectedOptionId: string;
  readonly axis: string;
  readonly beforeQueryPlanHash: string;
  readonly afterQueryPlanHash: string;
  readonly queryPlanHash: string;
  readonly queryPlanRevisionId: string | null;
  readonly contractRevisionId: string;
  readonly contractSemanticHash: string;
  readonly capabilitySnapshotHash: string;
  readonly semanticConfigurationHash: string;
  readonly executionField: GuidanceExecutionFieldV5 | null;
  readonly effectHash: string | null;
  readonly consumerId: string | null;
  readonly beforeConsumerResultHash: string;
  readonly afterConsumerResultHash: string;
  readonly resultEffectHash: string | null;
  readonly workerProjectionHash: string;
  readonly receiptHash: string;
  /** Operational metadata is deliberately excluded from `receiptHash`. */
  readonly consumedAt: string;
  readonly jobId: string;
  readonly workerId: string;
  readonly leaseEpoch: number;
}

function withoutHash<T extends Record<string, unknown>>(
  value: T,
  hashKey: keyof T,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== hashKey),
  );
}

function hashValue(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

function safeHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function normalizedMembership(
  values: SelectionPlanV3["membershipPredicates"],
): unknown {
  return values.map(({ id, axis, operator, values: predicateValues }) => ({
    id,
    axis,
    operator,
    values: [...predicateValues],
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function normalizedRanking(
  values: SelectionPlanV3["rankingObjectives"],
): unknown {
  return values.map(({ id, dimension, direction, weight, values: objectiveValues }) => ({
    id,
    dimension,
    direction,
    weight,
    values: [...objectiveValues],
  })).sort((left, right) => left.id.localeCompare(right.id));
}

/** The exact normalized value consumed by the selected runtime field. */
export function selectionPlanGuidanceExecutionProjectionV5(
  plan: SelectionPlanV3,
  field: GuidanceExecutionFieldV5,
): unknown {
  if (field === "membershipPredicates") {
    return normalizedMembership(plan.membershipPredicates);
  }
  if (field === "rankingObjectives") {
    return normalizedRanking(plan.rankingObjectives);
  }
  if (field === "orderingPolicy") {
    return structuredClone(plan.orderingPolicy);
  }
  if (field === "playlistQuotaRules") {
    return structuredClone(plan.playlistQuotaRules ?? []);
  }
  return structuredClone(plan.playlistQualityPolicy ?? null);
}

function expectedSelectionPlan(
  contract: PlaylistContractRevisionV1,
): SelectionPlanV3 {
  return projectPlaylistContractExecutionV1({
    contract,
    basePlan: {
      requestedTrackCount: contract.requestedTrackCount,
      minimumQualifiedTrackCount: contract.requestedTrackCount,
      storefront: contract.storefront,
    },
  }).selectionPlanV3;
}

function counterfactualQueryPlanV5(input: {
  contract: PlaylistContractRevisionV1;
  graphSnapshotId: string;
}): QueryPlanV3 {
  const plan = expectedSelectionPlan(input.contract);
  return createQueryPlanV3(plan, input.graphSnapshotId, {
    schemaVersion: 6,
    briefContractVersion: 3,
    playlistContractRevisionId: input.contract.revisionId,
    playlistContractSemanticHash: input.contract.semanticHash,
    playlistContractCompilerVersion: input.contract.versions.compiler,
    guidancePolicyVersion: ADAPTIVE_GUIDANCE_POLICY_VERSION_V5,
  });
}

function assertQueryPlanAuthority(input: {
  queryPlan: QueryPlanV3;
  successor: PlaylistContractRevisionV1;
  capabilitySnapshotHash: string;
  semanticConfigurationHash: string;
}): void {
  const { queryPlan, successor } = input;
  if (queryPlan.schemaVersion !== 6
    || queryPlan.guidancePolicyVersion !== ADAPTIVE_GUIDANCE_POLICY_VERSION_V5
    || queryPlan.playlistContractRevisionId !== successor.revisionId
    || queryPlan.playlistContractSemanticHash !== successor.semanticHash
    || queryPlan.semanticHash !== successor.semanticHash
    || queryPlan.executorCapabilityHash !== input.capabilitySnapshotHash
    || queryPlan.executionCoverageReport?.workerCapabilityHash
      !== input.capabilitySnapshotHash
    || queryPlan.executionCoverageReport.configurationHash
      !== input.semanticConfigurationHash) {
    throw new Error("guidance_v5_execution_authority_query_plan_mismatch");
  }
}

function assertConsumerReceipt(input: {
  axis: string;
  capabilitySnapshotHash: string;
  effect: GuidanceExecutionEffectV5;
  receipt: GuidanceConsumerReceiptV5;
}): void {
  const registry = guidanceRuntimeConsumerRegistryV5(
    input.capabilitySnapshotHash,
  );
  const receiptBody = withoutHash(
    input.receipt as unknown as Record<string, unknown>,
    "receiptHash",
  );
  const registered = registry.consumers.find(({ consumerId, field, axes }) => (
    consumerId === input.effect.consumerId
    && field === input.effect.field
    && axes.includes(input.axis)
  ));
  if (!registered
    || input.receipt.receiptHash !== hashValue(receiptBody)
    || input.receipt.registryVersion !== registry.version
    || input.receipt.registryHash !== registry.hash
    || input.receipt.capabilitySnapshotHash !== input.capabilitySnapshotHash
    || input.receipt.axis !== input.axis
    || input.receipt.field !== input.effect.field
    || input.receipt.consumerId !== input.effect.consumerId) {
    throw new Error("guidance_v5_worker_consumer_receipt_mismatch");
  }
}

/**
 * Build the durable authority before enqueueing the canonical run. The caller
 * persists the returned value under `GUIDANCE_V5_EXECUTION_AUTHORITY_CHECKPOINT`.
 * No raw prompt, custom prose, or provider data enters this receipt.
 */
export function createGuidanceWorkerExecutionAuthorityV5(input: {
  questionSetHash: string;
  question: PlaylistGuidanceQuestion;
  answer: PlaylistGuidanceAnswer;
  baseContract: PlaylistContractRevisionV1;
  successorContract: PlaylistContractRevisionV1;
  queryPlan: QueryPlanV3;
  queryPlanRevisionId?: string | null;
}): GuidanceWorkerExecutionAuthorityV5 {
  if (!safeHash(input.questionSetHash)
    || input.question.schemaVersion !== 5
    || input.answer.questionId !== input.question.id
    || input.answer.customText
    || input.answer.skipped
    || input.answer.optionIds?.length
    || typeof input.answer.optionId !== "string") {
    throw new Error("guidance_v5_execution_authority_answer_invalid");
  }
  assertPlaylistContractIntegrityV1(input.baseContract);
  assertPlaylistContractIntegrityV1(input.successorContract);
  const decision = guidanceDecisionV5FromPublicQuestion(
    input.question,
    input.baseContract,
  );
  const option = input.question.options.find(
    ({ id }) => id === input.answer.optionId,
  );
  const simulation = decision.simulations.find(
    ({ optionId }) => optionId === input.answer.optionId,
  );
  if (!option || !simulation || !option.optionSimulation) {
    throw new Error("guidance_v5_execution_authority_option_missing");
  }
  const patch = compileGuidanceRoundPatchV3({
    base: input.baseContract,
    questionSetHash: input.questionSetHash,
    questions: [input.question],
    answers: [input.answer],
  });
  const expectedSuccessor = patch
    ? applyPlaylistContractPatchV1(input.baseContract, patch)
    : input.baseContract;
  if (expectedSuccessor.semanticHash !== input.successorContract.semanticHash
    || expectedSuccessor.revisionId !== input.successorContract.revisionId
    || stableStringify(expectedSuccessor)
      !== stableStringify(input.successorContract)) {
    throw new Error("guidance_v5_execution_authority_successor_mismatch");
  }
  assertQueryPlanAuthority({
    queryPlan: input.queryPlan,
    successor: input.successorContract,
    capabilitySnapshotHash: decision.capabilitySnapshotHash,
    semanticConfigurationHash: decision.semanticConfigurationHash,
  });
  const explicitNoop = option.contractPatch?.operations.length === 0
    && (
      option.explicitNoop === true
      || option.id === "keep_current_interpretation"
    );
  const field = simulation.executionEffect?.field ?? null;
  const beforePlan = expectedSelectionPlan(input.baseContract);
  const afterPlan = expectedSelectionPlan(input.successorContract);
  const beforeQueryPlan = counterfactualQueryPlanV5({
    contract: input.baseContract,
    graphSnapshotId: input.queryPlan.graphSnapshotId,
  });
  const expectedAfterQueryPlan = counterfactualQueryPlanV5({
    contract: input.successorContract,
    graphSnapshotId: input.queryPlan.graphSnapshotId,
  });
  const beforeQueryPlanHash = queryPlanV3Hash(beforeQueryPlan);
  const afterQueryPlanHash = queryPlanV3Hash(input.queryPlan);
  if (queryPlanV3Hash(expectedAfterQueryPlan) !== afterQueryPlanHash) {
    throw new Error("guidance_v5_execution_authority_query_plan_projection_mismatch");
  }
  const beforeExecutionProjection = guidanceRuntimeConsumerResultV5({
    plan: beforePlan,
    axis: decision.axis as GuidanceRuntimeAxisV5,
    field: field ?? "rankingObjectives",
  });
  const afterExecutionProjection = guidanceRuntimeConsumerResultV5({
    plan: afterPlan,
    axis: decision.axis as GuidanceRuntimeAxisV5,
    field: field ?? "rankingObjectives",
  });
  const beforeConsumerResultHash = hashValue(beforeExecutionProjection);
  const afterConsumerResultHash = hashValue(afterExecutionProjection);
  let resultEffectHash: string | null = null;
  if (explicitNoop) {
    if (simulation.executionEffect !== null
      || simulation.consumerReceipt !== null
      || simulation.successorSemanticHash !== null
      || beforeQueryPlanHash !== afterQueryPlanHash
      || stableStringify(beforeExecutionProjection)
        !== stableStringify(afterExecutionProjection)) {
      throw new Error("guidance_v5_execution_authority_noop_invalid");
    }
  } else {
    if (!simulation.executionEffect || !simulation.consumerReceipt) {
      throw new Error("guidance_v5_execution_authority_effect_missing");
    }
    assertConsumerReceipt({
      axis: decision.axis,
      capabilitySnapshotHash: decision.capabilitySnapshotHash,
      effect: simulation.executionEffect,
      receipt: simulation.consumerReceipt,
    });
    const actualConsumerEffect = assertGuidanceRuntimeConsumerEffectV5({
      beforePlan,
      afterPlan,
      axis: decision.axis as GuidanceRuntimeAxisV5,
      field: simulation.executionEffect.field,
    });
    const expectedEffectHash = hashValue({
      axis: decision.axis,
      field: simulation.executionEffect.field,
      consumerId: simulation.executionEffect.consumerId,
      beforeConsumerResultHash: hashValue(actualConsumerEffect.before),
      afterConsumerResultHash: hashValue(actualConsumerEffect.after),
    });
    if (expectedEffectHash !== simulation.executionEffect.effectHash) {
      throw new Error("guidance_v5_execution_authority_simulation_effect_mismatch");
    }
    if (simulation.executionEffect.beforeConsumerResultHash
        !== beforeConsumerResultHash
      || simulation.executionEffect.afterConsumerResultHash
        !== afterConsumerResultHash) {
      throw new Error("guidance_v5_execution_authority_consumer_result_mismatch");
    }
    if (beforeQueryPlanHash === afterQueryPlanHash
      || beforeConsumerResultHash === afterConsumerResultHash) {
      throw new Error("guidance_v5_execution_authority_zero_effect");
    }
    resultEffectHash = hashValue({
      axis: decision.axis,
      field: simulation.executionEffect.field,
      consumerId: simulation.executionEffect.consumerId,
      beforeQueryPlanHash,
      afterQueryPlanHash,
      beforeConsumerResultHash,
      afterConsumerResultHash,
    });
  }
  const selectionAnswerHash = hashValue({
    questionHash: input.question.questionHash,
    optionIds: [input.answer.optionId],
  });
  const body = {
    schemaVersion: GUIDANCE_V5_WORKER_CONSUMPTION_SCHEMA,
    kind: "execution_authority" as const,
    questionSetHash: input.questionSetHash,
    questionId: input.question.id,
    questionHash: input.question.questionHash!,
    selectedOptionId: input.answer.optionId,
    selectionAnswerHash,
    axis: decision.axis,
    explicitNoop,
    baseContractRevisionId: input.baseContract.revisionId,
    baseContractSemanticHash: input.baseContract.semanticHash,
    successorContractRevisionId: input.successorContract.revisionId,
    successorContractSemanticHash: input.successorContract.semanticHash,
    beforeSelectionPlanHash: selectionPlanV3Hash(beforePlan),
    afterSelectionPlanHash: selectionPlanV3Hash(afterPlan),
    beforeQueryPlanHash,
    afterQueryPlanHash,
    queryPlanHash: afterQueryPlanHash,
    queryPlanRevisionId: input.queryPlanRevisionId ?? null,
    capabilitySnapshotHash: decision.capabilitySnapshotHash,
    semanticConfigurationHash: decision.semanticConfigurationHash,
    patchHash: simulation.patchHash,
    affectedClauseIds: [...(option.contractPatch?.affectedClauseIds ?? [])],
    beforeExecutionProjection,
    afterExecutionProjection,
    beforeConsumerResultHash,
    afterConsumerResultHash,
    resultEffectHash,
    executionEffect: simulation.executionEffect
      ? { ...simulation.executionEffect }
      : null,
    consumerReceipt: simulation.consumerReceipt
      ? structuredClone(simulation.consumerReceipt)
      : null,
  };
  return Object.freeze({
    ...body,
    authorityHash: hashValue(body),
  });
}

export function assertGuidanceWorkerExecutionAuthorityV5(
  value: unknown,
): asserts value is GuidanceWorkerExecutionAuthorityV5 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("guidance_v5_worker_authority_missing");
  }
  const row = value as Partial<GuidanceWorkerExecutionAuthorityV5>;
  if (row.schemaVersion !== GUIDANCE_V5_WORKER_CONSUMPTION_SCHEMA
    || row.kind !== "execution_authority"
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
    || !safeHash(row.beforeQueryPlanHash)
    || !safeHash(row.afterQueryPlanHash)
    || !safeHash(row.queryPlanHash)
    || row.queryPlanHash !== row.afterQueryPlanHash
    || (row.queryPlanRevisionId !== null
      && typeof row.queryPlanRevisionId !== "string")
    || !safeHash(row.capabilitySnapshotHash)
    || !safeHash(row.semanticConfigurationHash)
    || !safeHash(row.patchHash)
    || !Array.isArray(row.affectedClauseIds)
    || !row.affectedClauseIds.every((id) => typeof id === "string")
    || !safeHash(row.beforeConsumerResultHash)
    || !safeHash(row.afterConsumerResultHash)
    || (row.resultEffectHash !== null && !safeHash(row.resultEffectHash))
    || !safeHash(row.authorityHash)) {
    throw new Error("guidance_v5_worker_authority_invalid");
  }
  const body = withoutHash(
    row as unknown as Record<string, unknown>,
    "authorityHash",
  );
  if (row.authorityHash !== hashValue(body)) {
    throw new Error("guidance_v5_worker_authority_hash_mismatch");
  }
  if (row.explicitNoop) {
    if (row.executionEffect !== null
      || row.consumerReceipt !== null
      || row.resultEffectHash !== null
      || row.beforeSelectionPlanHash !== row.afterSelectionPlanHash
      || row.beforeQueryPlanHash !== row.afterQueryPlanHash
      || row.beforeConsumerResultHash !== row.afterConsumerResultHash) {
      throw new Error("guidance_v5_worker_authority_noop_invalid");
    }
  } else {
    if (!row.executionEffect || !row.consumerReceipt
      || !safeHash(row.executionEffect.effectHash)
      || !safeHash(row.executionEffect.beforeConsumerResultHash)
      || !safeHash(row.executionEffect.afterConsumerResultHash)
      || row.executionEffect.beforeConsumerResultHash
        !== row.beforeConsumerResultHash
      || row.executionEffect.afterConsumerResultHash
        !== row.afterConsumerResultHash
      || row.beforeSelectionPlanHash === row.afterSelectionPlanHash
      || row.beforeQueryPlanHash === row.afterQueryPlanHash
      || row.beforeConsumerResultHash === row.afterConsumerResultHash
      || !safeHash(row.resultEffectHash)
      || row.executionEffect.field !== row.consumerReceipt.field
      || row.executionEffect.consumerId !== row.consumerReceipt.consumerId) {
      throw new Error("guidance_v5_worker_authority_effect_invalid");
    }
    assertConsumerReceipt({
      axis: row.axis,
      capabilitySnapshotHash: row.capabilitySnapshotHash,
      effect: row.executionEffect,
      receipt: row.consumerReceipt,
    });
    const expectedEffectHash = hashValue({
      axis: row.axis,
      field: row.executionEffect.field,
      consumerId: row.executionEffect.consumerId,
      beforeConsumerResultHash: row.beforeConsumerResultHash,
      afterConsumerResultHash: row.afterConsumerResultHash,
    });
    const expectedResultEffectHash = hashValue({
      axis: row.axis,
      field: row.executionEffect.field,
      consumerId: row.executionEffect.consumerId,
      beforeQueryPlanHash: row.beforeQueryPlanHash,
      afterQueryPlanHash: row.afterQueryPlanHash,
      beforeConsumerResultHash: row.beforeConsumerResultHash,
      afterConsumerResultHash: row.afterConsumerResultHash,
    });
    if (expectedEffectHash !== row.executionEffect.effectHash
      || hashValue(row.beforeExecutionProjection)
        !== row.beforeConsumerResultHash
      || hashValue(row.afterExecutionProjection)
        !== row.afterConsumerResultHash
      || expectedResultEffectHash !== row.resultEffectHash
      || stableStringify(row.beforeExecutionProjection)
        === stableStringify(row.afterExecutionProjection)) {
      throw new Error("guidance_v5_worker_authority_effect_mismatch");
    }
  }
}

export function guidanceWorkerConsumptionCheckpointKeyV5(
  queryPlanHash: string,
): string {
  if (!safeHash(queryPlanHash)) {
    throw new Error("guidance_v5_worker_query_plan_hash_invalid");
  }
  const prefix = "v3:guidance:v5:worker-consumption:";
  // `research_checkpoints.phase` is VARCHAR(80) through schema 20. Keep this
  // deterministic key within that immutable bridge contract; a longer hash
  // prefix made the first real database-backed V5 worker claim fail before
  // retrieval even though the in-memory receipt tests were green.
  return `${prefix}${queryPlanHash.slice(0, 80 - prefix.length)}`;
}

export interface GuidanceWorkerConsumptionTargetV5 {
  readonly queryPlan: QueryPlanV3;
  readonly queryPlanRevisionId: string | null;
  readonly checkpointQueryPlanHash: string;
  readonly requiresExistingReceipt: boolean;
}

/**
 * A bounded research continuation adds only authenticated continuation
 * metadata to the already-guided query plan. Guidance authority remains
 * bound to the source plan: changing the musical semantics would require a
 * new question/contract lineage, not a continuation.
 */
export function guidanceWorkerConsumptionTargetV5(input: {
  authority: unknown;
  queryPlan: QueryPlanV3;
  queryPlanRevisionId: string | null;
}): GuidanceWorkerConsumptionTargetV5 {
  assertGuidanceWorkerExecutionAuthorityV5(input.authority);
  const authority = input.authority;
  const continuation = input.queryPlan.continuation;
  if (!continuation) {
    return {
      queryPlan: input.queryPlan,
      queryPlanRevisionId: input.queryPlanRevisionId,
      checkpointQueryPlanHash: queryPlanV3Hash(input.queryPlan),
      requiresExistingReceipt: false,
    };
  }

  const sourcePlan = structuredClone(input.queryPlan);
  delete sourcePlan.continuation;
  const sourcePlanHash = queryPlanV3Hash(sourcePlan);
  if (sourcePlanHash !== authority.queryPlanHash
    || continuation.sourceQueryPlanHash !== authority.queryPlanHash
    || continuation.sourceQueryPlanRevisionId
      !== authority.queryPlanRevisionId) {
    throw new Error("guidance_v5_worker_continuation_authority_mismatch");
  }
  return {
    queryPlan: sourcePlan,
    queryPlanRevisionId: continuation.sourceQueryPlanRevisionId,
    checkpointQueryPlanHash: sourcePlanHash,
    requiresExistingReceipt: true,
  };
}

export function verifyGuidanceWorkerConsumptionV5(input: {
  authority: unknown;
  activeContract: PlaylistContractRevisionV1;
  queryPlan: QueryPlanV3;
  queryPlanRevisionId: string | null;
  rehydratedPlan: SelectionPlanV3;
  runtimeCapabilitySnapshotHash: string;
  runtimeSemanticConfigurationHash: string;
  jobId: string;
  workerId: string;
  leaseEpoch: number;
  consumedAt?: string;
}): GuidanceWorkerConsumptionReceiptV5 {
  assertGuidanceWorkerExecutionAuthorityV5(input.authority);
  const authority = input.authority;
  assertPlaylistContractIntegrityV1(input.activeContract);
  const actualQueryPlanHash = queryPlanV3Hash(input.queryPlan);
  assertQueryPlanAuthority({
    queryPlan: input.queryPlan,
    successor: input.activeContract,
    capabilitySnapshotHash: authority.capabilitySnapshotHash,
    semanticConfigurationHash: authority.semanticConfigurationHash,
  });
  if (authority.queryPlanHash !== actualQueryPlanHash
    || authority.afterQueryPlanHash !== actualQueryPlanHash
    || authority.queryPlanRevisionId !== input.queryPlanRevisionId
    || authority.successorContractRevisionId
      !== input.activeContract.revisionId
    || authority.successorContractSemanticHash
      !== input.activeContract.semanticHash
    || authority.capabilitySnapshotHash
      !== input.runtimeCapabilitySnapshotHash
    || authority.semanticConfigurationHash
      !== input.runtimeSemanticConfigurationHash
    || !Number.isSafeInteger(input.leaseEpoch)
    || input.leaseEpoch < 1
    || !input.jobId
    || !input.workerId) {
    throw new Error("guidance_v5_worker_claim_identity_mismatch");
  }
  if (!authority.explicitNoop
    && !input.activeContract.answerLineage.some(({ questionSetHash }) => (
      questionSetHash === authority.questionSetHash
    ))) {
    throw new Error("guidance_v5_worker_answer_lineage_missing");
  }
  const expectedPlan = expectedSelectionPlan(input.activeContract);
  const executionField = authority.executionEffect?.field ?? null;
  const workerProjection = selectionPlanGuidanceExecutionProjectionV5(
    input.rehydratedPlan,
    executionField ?? "rankingObjectives",
  );
  const expectedWorkerProjection = selectionPlanGuidanceExecutionProjectionV5(
    expectedPlan,
    executionField ?? "rankingObjectives",
  );
  if (stableStringify(workerProjection)
      !== stableStringify(expectedWorkerProjection)) {
    throw new Error("guidance_v5_worker_effect_not_consumed");
  }
  const deterministic = {
    schemaVersion: GUIDANCE_V5_WORKER_CONSUMPTION_SCHEMA,
    kind: "worker_consumption" as const,
    status: authority.explicitNoop
      ? "explicit_noop" as const
      : "consumed" as const,
    authorityHash: authority.authorityHash,
    questionSetHash: authority.questionSetHash,
    questionHash: authority.questionHash,
    selectedOptionId: authority.selectedOptionId,
    axis: authority.axis,
    beforeQueryPlanHash: authority.beforeQueryPlanHash,
    afterQueryPlanHash: authority.afterQueryPlanHash,
    queryPlanHash: actualQueryPlanHash,
    queryPlanRevisionId: input.queryPlanRevisionId,
    contractRevisionId: input.activeContract.revisionId,
    contractSemanticHash: input.activeContract.semanticHash,
    capabilitySnapshotHash: authority.capabilitySnapshotHash,
    semanticConfigurationHash: authority.semanticConfigurationHash,
    executionField,
    effectHash: authority.executionEffect?.effectHash ?? null,
    consumerId: authority.executionEffect?.consumerId ?? null,
    beforeConsumerResultHash: authority.beforeConsumerResultHash,
    afterConsumerResultHash: authority.afterConsumerResultHash,
    resultEffectHash: authority.resultEffectHash,
    workerProjectionHash: hashValue(workerProjection),
  };
  return Object.freeze({
    ...deterministic,
    receiptHash: hashValue(deterministic),
    consumedAt: input.consumedAt ?? new Date().toISOString(),
    jobId: input.jobId,
    workerId: input.workerId,
    leaseEpoch: input.leaseEpoch,
  });
}

export function assertGuidanceWorkerConsumptionReceiptV5(
  value: unknown,
  expectedReceiptHash?: string,
): asserts value is GuidanceWorkerConsumptionReceiptV5 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("guidance_v5_worker_consumption_receipt_missing");
  }
  const row = value as Partial<GuidanceWorkerConsumptionReceiptV5>;
  if (row.schemaVersion !== GUIDANCE_V5_WORKER_CONSUMPTION_SCHEMA
    || row.kind !== "worker_consumption"
    || (row.status !== "consumed" && row.status !== "explicit_noop")
    || !safeHash(row.authorityHash)
    || !safeHash(row.questionSetHash)
    || !safeHash(row.questionHash)
    || typeof row.selectedOptionId !== "string"
    || typeof row.axis !== "string"
    || !safeHash(row.beforeQueryPlanHash)
    || !safeHash(row.afterQueryPlanHash)
    || !safeHash(row.queryPlanHash)
    || row.queryPlanHash !== row.afterQueryPlanHash
    || (row.queryPlanRevisionId !== null
      && typeof row.queryPlanRevisionId !== "string")
    || typeof row.contractRevisionId !== "string"
    || !safeHash(row.contractSemanticHash)
    || !safeHash(row.capabilitySnapshotHash)
    || !safeHash(row.semanticConfigurationHash)
    || (row.executionField !== null
      && ![
        "membershipPredicates",
        "rankingObjectives",
        "orderingPolicy",
        "playlistQuotaRules",
        "playlistQualityPolicy",
      ].includes(row.executionField ?? ""))
    || (row.effectHash !== null && !safeHash(row.effectHash))
    || (row.consumerId !== null && typeof row.consumerId !== "string")
    || !safeHash(row.beforeConsumerResultHash)
    || !safeHash(row.afterConsumerResultHash)
    || (row.resultEffectHash !== null && !safeHash(row.resultEffectHash))
    || !safeHash(row.workerProjectionHash)
    || !safeHash(row.receiptHash)
    || typeof row.consumedAt !== "string"
    || typeof row.jobId !== "string"
    || typeof row.workerId !== "string"
    || !Number.isSafeInteger(row.leaseEpoch)
    || Number(row.leaseEpoch) < 1) {
    throw new Error("guidance_v5_worker_consumption_receipt_invalid");
  }
  const deterministic = {
    schemaVersion: row.schemaVersion,
    kind: row.kind,
    status: row.status,
    authorityHash: row.authorityHash,
    questionSetHash: row.questionSetHash,
    questionHash: row.questionHash,
    selectedOptionId: row.selectedOptionId,
    axis: row.axis,
    beforeQueryPlanHash: row.beforeQueryPlanHash,
    afterQueryPlanHash: row.afterQueryPlanHash,
    queryPlanHash: row.queryPlanHash,
    queryPlanRevisionId: row.queryPlanRevisionId,
    contractRevisionId: row.contractRevisionId,
    contractSemanticHash: row.contractSemanticHash,
    capabilitySnapshotHash: row.capabilitySnapshotHash,
    semanticConfigurationHash: row.semanticConfigurationHash,
    executionField: row.executionField,
    effectHash: row.effectHash,
    consumerId: row.consumerId,
    beforeConsumerResultHash: row.beforeConsumerResultHash,
    afterConsumerResultHash: row.afterConsumerResultHash,
    resultEffectHash: row.resultEffectHash,
    workerProjectionHash: row.workerProjectionHash,
  };
  if (row.receiptHash !== hashValue(deterministic)
    || (expectedReceiptHash && row.receiptHash !== expectedReceiptHash)
    || (row.status === "explicit_noop"
      && (row.executionField !== null
        || row.effectHash !== null
        || row.consumerId !== null
        || row.resultEffectHash !== null
        || row.beforeQueryPlanHash !== row.afterQueryPlanHash
        || row.beforeConsumerResultHash !== row.afterConsumerResultHash))
    || (row.status === "consumed"
      && (row.executionField === null
        || row.effectHash === null
        || row.consumerId === null
        || row.resultEffectHash === null
        || row.beforeQueryPlanHash === row.afterQueryPlanHash
        || row.beforeConsumerResultHash === row.afterConsumerResultHash))) {
    throw new Error("guidance_v5_worker_consumption_receipt_hash_mismatch");
  }
}
