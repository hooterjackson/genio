import type {
  PipelinePolicyVersion,
  PipelineVersion,
  QueryPlanV3,
  SelectionPlan,
} from "../shared/types.ts";
import { pipelineV2Route } from "./selection-plan-v2.ts";

export type PersistedWorkerPipelineRoute =
  | "legacy_v1"
  | "catalog_first_v2_curated"
  | "catalog_first_v2_factual"
  | "corpus_first_v3";

export interface PersistedWorkerPipelineDecision {
  route: PersistedWorkerPipelineRoute;
  pipelineVersion: "legacy_v1" | "catalog_first_v2" | "corpus_first_v3";
  policyVersion: PipelinePolicyVersion;
  selectionPlan: SelectionPlan | null;
  queryPlan: QueryPlanV3 | null;
}

export class WorkerPipelineIntegrityError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "WorkerPipelineIntegrityError";
  }
}

/**
 * Resolve execution only from the immutable version persisted on the run.
 * Environment rollout changes and a stray selection-plan payload must never
 * reinterpret in-flight or historical V1 work as Pipeline V2.
 *
 * Curated and factual/exhaustive V2 share the immutable worker protocol but
 * remain distinct routes. The factual route reuses the proven durable,
 * claim-first source-frontier engine and never enters catalog-first curated
 * discovery. Assignment stays independently gated by its benchmark rollout.
 */
export function persistedWorkerPipeline(input: {
  pipelineVersion?: PipelineVersion | string | null;
  policyVersion?: PipelinePolicyVersion | string | null;
  selectionPlan?: SelectionPlan | null;
  queryPlan?: QueryPlanV3 | null;
}): PersistedWorkerPipelineDecision {
  const pipelineVersion = input.pipelineVersion ?? "legacy_v1";
  if (pipelineVersion === "legacy_v1") {
    return {
      route: "legacy_v1",
      pipelineVersion: "legacy_v1",
      policyVersion: "legacy_v1",
      // Ignore a stale or accidentally attached V2 plan. Rollback means V1
      // semantics, not V1 code with V2 prompt constraints mixed into it.
      selectionPlan: null,
      queryPlan: null,
    };
  }
  if (pipelineVersion === "corpus_first_v3") {
    const plan = input.queryPlan;
    if (!plan || plan.pipelineVersion !== "corpus_first_v3") {
      throw new WorkerPipelineIntegrityError(
        "Pipeline V3 run is missing its immutable corpus-first query plan",
        "missing_v3_query_plan",
      );
    }
    if (input.policyVersion !== "corpus_first_v3_policy_v1" || plan.policyVersion !== input.policyVersion) {
      throw new WorkerPipelineIntegrityError(
        "Pipeline V3 run and query plan have different policy versions",
        "v3_policy_version_mismatch",
      );
    }
    return {
      route: "corpus_first_v3",
      pipelineVersion: "corpus_first_v3",
      policyVersion: "corpus_first_v3_policy_v1",
      selectionPlan: null,
      queryPlan: plan,
    };
  }
  if (pipelineVersion !== "catalog_first_v2") {
    throw new WorkerPipelineIntegrityError(
      `Worker does not support persisted pipeline version ${pipelineVersion}`,
      "unsupported_pipeline_version",
    );
  }

  const plan = input.selectionPlan;
  if (!plan || plan.pipelineVersion !== "catalog_first_v2") {
    throw new WorkerPipelineIntegrityError(
      "Pipeline V2 run is missing its immutable V2 selection plan",
      "missing_v2_selection_plan",
    );
  }
  if (!input.policyVersion || input.policyVersion === "legacy_v1" || plan.policyVersion !== input.policyVersion) {
    throw new WorkerPipelineIntegrityError(
      "Pipeline V2 run and selection plan have different policy versions",
      "v2_policy_version_mismatch",
    );
  }
  const route = pipelineV2Route(plan) === "curated_catalog"
    ? "catalog_first_v2_curated"
    : "catalog_first_v2_factual";

  return {
    route,
    pipelineVersion: "catalog_first_v2",
    policyVersion: input.policyVersion as PipelinePolicyVersion,
    selectionPlan: plan,
    queryPlan: null,
  };
}
