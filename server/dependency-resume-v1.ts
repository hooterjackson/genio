import type { RunDecisionActionView } from "../shared/types.ts";
import { sha256Hex, stableStringify } from "./security.ts";

export const DEPENDENCY_RESUME_AUTHORIZATION_VERSION =
  "genio-dependency-resume-authorization/v1" as const;

export interface DependencyResumeBlockerMaterialV1 {
  id: string;
  contractRevisionId: string;
  dependencyKey: string;
  retryCount: number;
  automaticRetryUntil: Date;
  retryAfterUntil: Date | null;
  stageKey: string;
  decisionHash: string;
  nextAction: string;
}

export interface DependencyResumeEligibilityInputV1 {
  now: Date;
  runStatus: string;
  runPhase: string;
  activeContractRevisionId: string;
  activeContractSemanticRevisionId: string;
  activeContractSemanticHash: string;
  expectedContractRevisionId: string;
  expectedContractSemanticHash: string;
  expectedDecisionHash: string;
  expectedBlockerVersion: string;
  blocker: DependencyResumeBlockerMaterialV1 & {
    kind: string;
    resolved: boolean;
  };
  decision: RunDecisionActionView | null;
  queryPlan: {
    status: string;
    schemaVersion: number;
    playlistContractRevisionId: string | null;
    playlistContractSemanticHash: string | null;
    stageKey: string;
    expectedStageKey: string;
    executorCapabilityHash: string | null;
    expectedExecutorCapabilityHash: string | null;
    executorCapabilityMatches: boolean;
  };
}

export type DependencyResumeEligibilityDecisionV1 =
  | {
    state: "eligible";
    blockerVersion: string;
    resumeAt: Date;
  }
  | {
    state: "ineligible";
    reasonCode:
      | "invalid_dependency_resume_state"
      | "dependency_resume_not_ready"
      | "dependency_resume_stale"
      | "dependency_resume_contract_conflict"
      | "dependency_resume_executor_conflict";
  };

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

export function dependencyResumeBlockerVersionV1(
  blocker: DependencyResumeBlockerMaterialV1,
): string {
  return sha256Hex(stableStringify({
    schemaVersion: "genio-dependency-resume-blocker/v1",
    id: blocker.id,
    contractRevisionId: blocker.contractRevisionId,
    dependencyKey: blocker.dependencyKey,
    retryCount: blocker.retryCount,
    automaticRetryUntil: blocker.automaticRetryUntil.toISOString(),
    retryAfterUntil: blocker.retryAfterUntil?.toISOString() ?? null,
    stageKey: blocker.stageKey,
    decisionHash: blocker.decisionHash,
    nextAction: blocker.nextAction,
  }));
}

export function dependencyResumeAuthorizationHashV1(input: {
  runId: string;
  sourceAccessId: string;
  capabilitySessionId: string;
  idempotencyKey: string;
  contractRevisionId: string;
  contractSemanticHash: string;
  queryPlanRevisionId: string;
  queryPlanHash: string;
  blockerId: string;
  blockerVersion: string;
  decisionHash: string;
  dependencyKey: string;
  stageKey: string;
  resumeAt: Date;
}): string {
  return sha256Hex(stableStringify({
    schemaVersion: DEPENDENCY_RESUME_AUTHORIZATION_VERSION,
    ...input,
    resumeAt: input.resumeAt.toISOString(),
  }));
}

/**
 * Fail-closed policy for the visitor-authorized retry after the automatic
 * dependency window. The policy deliberately receives only immutable
 * contract/query-plan identities and retained blocker state; raw prompt text
 * is neither accepted nor interpreted.
 */
export function decideDependencyResumeV1(
  input: DependencyResumeEligibilityInputV1,
): DependencyResumeEligibilityDecisionV1 {
  const blocker = input.blocker;
  const decision = input.decision;
  const plan = input.queryPlan;
  if (!validDate(input.now)
    || !validDate(blocker.automaticRetryUntil)
    || (blocker.retryAfterUntil !== null && !validDate(blocker.retryAfterUntil))
    || !Number.isSafeInteger(blocker.retryCount)
    || blocker.retryCount < 0
    || ![
      input.activeContractRevisionId,
      input.activeContractSemanticRevisionId,
      input.activeContractSemanticHash,
      input.expectedContractRevisionId,
      input.expectedContractSemanticHash,
      input.expectedDecisionHash,
      input.expectedBlockerVersion,
      blocker.id,
      blocker.contractRevisionId,
      blocker.dependencyKey,
      blocker.stageKey,
      blocker.decisionHash,
      blocker.nextAction,
      plan.stageKey,
      plan.expectedStageKey,
    ].every(nonEmpty)) {
    return { state: "ineligible", reasonCode: "invalid_dependency_resume_state" };
  }
  if (input.runStatus !== "needs_decision"
    || input.runPhase !== "dependency_retry_window_expired"
    || blocker.kind !== "provider"
    || blocker.resolved
    || blocker.automaticRetryUntil.getTime() > input.now.getTime()
    || blocker.nextAction !== "resume_revise_or_cancel"
    || !decision
    || decision.kind !== "research_boundary"
    || decision.reason !== "dependency_retry_window_expired"
    || decision.actions.resumeLater !== true) {
    return { state: "ineligible", reasonCode: "dependency_resume_not_ready" };
  }
  if (input.expectedContractRevisionId !== input.activeContractRevisionId
    || input.expectedContractSemanticHash !== input.activeContractSemanticHash
    || blocker.contractRevisionId !== input.activeContractRevisionId
    || decision.contractRevisionId !== input.activeContractSemanticRevisionId
    || decision.contractSemanticHash !== input.activeContractSemanticHash) {
    return {
      state: "ineligible",
      reasonCode: "dependency_resume_contract_conflict",
    };
  }
  const blockerVersion = dependencyResumeBlockerVersionV1(blocker);
  if (input.expectedDecisionHash !== decision.decisionHash
    || blocker.decisionHash !== decision.decisionHash
    || input.expectedBlockerVersion !== blockerVersion) {
    return { state: "ineligible", reasonCode: "dependency_resume_stale" };
  }
  if (plan.status !== "active"
    || plan.schemaVersion < 5
    || plan.playlistContractRevisionId !== input.activeContractSemanticRevisionId
    || plan.playlistContractSemanticHash !== input.activeContractSemanticHash
    || plan.stageKey !== plan.expectedStageKey
    || plan.stageKey !== blocker.stageKey
    || !plan.executorCapabilityHash
    || plan.executorCapabilityHash !== plan.expectedExecutorCapabilityHash
    || !plan.executorCapabilityMatches) {
    return {
      state: "ineligible",
      reasonCode: "dependency_resume_executor_conflict",
    };
  }
  const resumeAt = blocker.retryAfterUntil
    && blocker.retryAfterUntil.getTime() > input.now.getTime()
    ? blocker.retryAfterUntil
    : input.now;
  return { state: "eligible", blockerVersion, resumeAt };
}
