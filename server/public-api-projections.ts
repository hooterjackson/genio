import type {
  PlaylistBrief,
  PlaylistGuidanceAnswer,
  PlaylistGuidanceQuestion,
  PublicBriefStatusView,
  PublicResearchRunView,
  ResearchRunView,
} from "../shared/types.ts";

type InternalResearchRunView = ResearchRunView & {
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  [key: string]: unknown;
};

/**
 * Copies only fields approved for a capability-authenticated browser. Keeping
 * the projection here prevents repository additions from becoming public by
 * accident through object spreading.
 */
export function publicResearchRunView(
  run: InternalResearchRunView,
  identity?: { id?: string; prompt?: string },
): PublicResearchRunView {
  return {
    id: identity?.id ?? run.id,
    prompt: identity?.prompt ?? run.prompt,
    brief: run.brief,
    status: run.status,
    phase: run.phase,
    autoPublish: run.autoPublish,
    error: run.error,
    candidateCount: run.candidateCount,
    sourceCount: run.sourceCount,
    unresolvedCount: run.unresolvedCount,
    frontier: run.frontier,
    pipelineVersion: run.pipelineVersion,
    policyVersion: run.policyVersion,
    selectionPlan: run.selectionPlan,
    pipelineOutcome: run.pipelineOutcome,
    candidateStageCounts: run.candidateStageCounts,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  };
}

export function publicBriefStatusView(input: {
  requestId: string;
  prompt: string;
  requestedTrackCount: number | null;
  status: string;
  brief?: PlaylistBrief;
  questions?: PlaylistGuidanceQuestion[];
  answers?: PlaylistGuidanceAnswer[];
  error?: string;
  [key: string]: unknown;
}): PublicBriefStatusView {
  return {
    requestId: input.requestId,
    prompt: input.prompt,
    requestedTrackCount: input.requestedTrackCount,
    status: input.status,
    brief: input.brief,
    questions: input.questions ?? [],
    answers: input.answers,
    error: input.error,
  };
}
