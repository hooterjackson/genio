export type DurablePublicationReconciliationState =
  | "preflight"
  | "create_pending"
  | "append_pending"
  | "reconciling"
  | "complete"
  | "authorization_blocked"
  | "cancelled"
  | "quarantined";

/**
 * Immutable authority for one Apple publication lifecycle. The repository
 * rechecks every field against the active run, contract, manifest revision,
 * and ordered payload before accepting a state transition.
 */
export interface PublicationExecutionFence {
  executionAttemptId: string;
  jobId: string;
  workerId: string;
  leaseGeneration: number;
  stageKey: string;
}

export interface BeginPublicationReconciliationInput
  extends PublicationExecutionFence {
  runId: string;
  contractRevisionId: string;
  contractHash: string;
  manifestId: string;
  manifestRevisionId: string;
  manifestRevisionHash: string;
  expectedOrderedIdsHash: string;
  expectedCount: number;
  idempotencyKey: string;
}

export interface AdvancePublicationReconciliationInput
  extends BeginPublicationReconciliationInput {
  state: DurablePublicationReconciliationState;
  applePlaylistId?: string | null;
  observedOrderedIdsHash?: string | null;
  appendedCount: number;
  batchCursor: number;
  nextRetryAt?: Date | null;
  detail?: Readonly<Record<string, unknown>>;
}

export interface DurablePublicationReconciliation {
  id: string;
  state: DurablePublicationReconciliationState;
  appendedCount: number;
  batchCursor: number;
}

export function orderedAppleStableIdsHash(
  orderedIds: readonly string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify([...orderedIds]))
    .digest("hex");
}
import { createHash } from "node:crypto";
