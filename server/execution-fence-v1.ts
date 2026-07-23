export interface ExecutionFenceV1 {
  attemptId: string;
  activeAttemptId: string;
  leaseGeneration: number;
  activeLeaseGeneration: number;
  fencingToken: string;
  activeFencingToken: string;
  contractRevisionId: string;
  activeContractRevisionId: string;
  contractSemanticHash: string;
  activeContractSemanticHash: string;
  cancelled: boolean;
}

export type ExecutionFenceDecisionV1 =
  | { state: "allowed" }
  | { state: "cancelled"; reasonCode: "run_cancelled" }
  | {
    state: "stale_attempt";
    reasonCode:
      | "attempt_superseded"
      | "lease_superseded"
      | "fencing_token_superseded"
      | "contract_revision_superseded";
  }
  | {
    state: "integrity_conflict";
    reasonCode: "invalid_fence_metadata" | "contract_hash_conflict";
  };

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

/**
 * A single fail-closed fence shared by research, retry, and publication
 * policy. Revision changes are ordinary stale-work discards. A semantic hash
 * change under the same immutable revision identity is an integrity conflict.
 */
export function evaluateExecutionFenceV1(
  fence: ExecutionFenceV1,
): ExecutionFenceDecisionV1 {
  if (fence.cancelled) {
    return { state: "cancelled", reasonCode: "run_cancelled" };
  }

  const validStrings = [
    fence.attemptId,
    fence.activeAttemptId,
    fence.fencingToken,
    fence.activeFencingToken,
    fence.contractRevisionId,
    fence.activeContractRevisionId,
    fence.contractSemanticHash,
    fence.activeContractSemanticHash,
  ].every(nonEmpty);
  if (!validStrings
    || !Number.isSafeInteger(fence.leaseGeneration)
    || !Number.isSafeInteger(fence.activeLeaseGeneration)
    || fence.leaseGeneration < 0
    || fence.activeLeaseGeneration < 0) {
    return { state: "integrity_conflict", reasonCode: "invalid_fence_metadata" };
  }

  if (fence.contractRevisionId === fence.activeContractRevisionId
    && fence.contractSemanticHash !== fence.activeContractSemanticHash) {
    return { state: "integrity_conflict", reasonCode: "contract_hash_conflict" };
  }
  if (fence.contractRevisionId !== fence.activeContractRevisionId) {
    return { state: "stale_attempt", reasonCode: "contract_revision_superseded" };
  }
  if (fence.attemptId !== fence.activeAttemptId) {
    return { state: "stale_attempt", reasonCode: "attempt_superseded" };
  }
  if (fence.leaseGeneration !== fence.activeLeaseGeneration) {
    return { state: "stale_attempt", reasonCode: "lease_superseded" };
  }
  if (fence.fencingToken !== fence.activeFencingToken) {
    return { state: "stale_attempt", reasonCode: "fencing_token_superseded" };
  }
  return { state: "allowed" };
}
