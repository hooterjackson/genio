import type { QueryPlanV3 } from "../shared/types.ts";
import {
  createRuntimeQueryPlanV3,
  queryPlanV3Hash,
} from "./query-plan-v3.ts";
import type { SelectionPlanV3 } from "./selection-plan-v3.ts";

/**
 * V3 activation is deliberately narrower than ordinary run resumption. An
 * explicit bridge may attach a frozen query plan only before paid work has
 * started; automatic rollout and worker execution are separate concerns.
 */
export const PIPELINE_V3_ACTIVATION_SAFE_STATUSES = [
  "awaiting_guidance",
  "queued",
] as const;

export type PipelineV3ActivationSafeStatus = typeof PIPELINE_V3_ACTIVATION_SAFE_STATUSES[number];

export interface PipelineV3ActivationContract {
  queryPlan: QueryPlanV3;
  planHash: string;
}

export type PipelineV3ActivationPreconditionFailure =
  | "schema_unavailable"
  | "run_deleted"
  | "run_in_flight"
  | "snapshot_not_locked";

export function pipelineV3ActivationPreconditionFailure(input: {
  schemaVersion: number;
  runStatus: string;
  deleted: boolean;
  snapshotStatus: string | null;
}): PipelineV3ActivationPreconditionFailure | null {
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 14) return "schema_unavailable";
  if (input.deleted) return "run_deleted";
  if (!(PIPELINE_V3_ACTIVATION_SAFE_STATUSES as readonly string[]).includes(input.runStatus)) {
    return "run_in_flight";
  }
  if (input.snapshotStatus !== "locked") return "snapshot_not_locked";
  return null;
}

/** Build the immutable execution value using the one canonical V3 factory. */
export function createPipelineV3ActivationContract(
  selectionPlan: SelectionPlanV3,
  graphSnapshotId: string,
  contract: {
    readonly briefContractVersion?: 1 | 2 | 3;
    readonly executionDeltaHash?: string;
    readonly playlistContractRevisionId?: string;
    readonly playlistContractSemanticHash?: string;
    readonly playlistContractCompilerVersion?: string;
  } = {},
): PipelineV3ActivationContract {
  const queryPlan = createRuntimeQueryPlanV3(
    selectionPlan,
    graphSnapshotId,
    process.env,
    contract,
  );
  return Object.freeze({
    queryPlan,
    planHash: queryPlanV3Hash(queryPlan),
  });
}
