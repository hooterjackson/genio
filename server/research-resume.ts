export interface ResearchResumeCheckpoint {
  phase?: string;
  gapAttempt?: number;
  generation?: number;
  segment?: number;
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
