import type { QueryPlanV3 } from "../shared/types.ts";
import { v3RetrievalStageKey } from "./pipeline-v3-worker-execution.ts";
import { minimumWorkerProtocolForQueryPlan } from "./worker-protocol.ts";

export interface ResearchResumeCheckpoint {
  phase?: string;
  gapAttempt?: number;
  generation?: number;
  segment?: number;
}

/**
 * Build the only valid durable handoff for a V3 retrieval stage. API-created
 * runs and worker-created resumptions must stamp the same plan revision,
 * stage key, queue class, and protocol requirement or the lease fence will
 * (correctly) reject the worker's first write.
 */
export function pipelineV3ResearchJob(
  runId: string,
  queryPlan: QueryPlanV3,
  executionMode: "active" | "shadow" = "active",
) {
  const stageKey = v3RetrievalStageKey(queryPlan, executionMode);
  const queueClass = queryPlan.engines.some((engine) => (
    engine === "factual_relationship" || engine === "exhaustive"
  )) ? "deep" as const : "interactive" as const;
  return {
    kind: "research",
    runId,
    payload: {
      runId,
      phase: "v3_retrieval",
      v3ExecutionMode: executionMode,
      stageExecutionKey: stageKey,
    },
    dedupeKey: `research:${runId}:${stageKey}`,
    pipelineVersion: "corpus_first_v3" as const,
    minimumWorkerProtocol: minimumWorkerProtocolForQueryPlan(queryPlan),
    stageKey,
    queueClass,
  };
}

export function researchResumeJob(
  runId: string,
  saved: ResearchResumeCheckpoint | null,
  options: {
    fast?: boolean;
    fastRoute?: { confirmedAt: string; researchDeadlineAt: string; deadlineAt: string } | null;
  } = {},
) {
  const phase = saved?.phase ?? "scope_resolution";
  const gapAttempt = Number.isInteger(saved?.gapAttempt) ? Number(saved!.gapAttempt) : 0;
  const generation = Number.isInteger(saved?.generation) ? Number(saved!.generation) : 0;
  const segment = Number.isInteger(saved?.segment) ? Number(saved!.segment) : 0;
  const checkpoint = phase === "gap_analysis" ? `${phase}:${gapAttempt}` : phase;
  return {
    kind: "research",
    runId,
    payload: {
      runId,
      phase,
      gapAttempt,
      generation,
      segment,
      ...(options.fast === true ? { fast: true } : {}),
      ...(options.fastRoute ? {
        fastConfirmedAt: options.fastRoute.confirmedAt,
        fastResearchDeadlineAt: options.fastRoute.researchDeadlineAt,
        fastDeadlineAt: options.fastRoute.deadlineAt,
      } : {}),
    },
    dedupeKey: `research:${runId}:${checkpoint}:g${generation}`,
  };
}
