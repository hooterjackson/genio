import type {
  PlaylistBrief,
  PlaylistGuidanceAnswer,
  PlaylistGuidanceQuestion,
  PublicBriefStatusView,
  ExplorePreferenceView,
  PartialPublicationActionView,
  PublicResearchRunView,
  ResearchRunView,
  RunGuidanceActionView,
  RunProgressView,
  RunResolutionView,
} from "../shared/types.ts";
import { EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS } from "../shared/product-policy.ts";
import { publicAdaptiveRunDecisionV1 } from "./adaptive-run-decision-v1.ts";
import {
  guidanceDecisionV3FromPublicQuestion,
  publicGuidanceQuestionV3,
} from "./adaptive-guidance-contract-bridge.ts";

function publicRunGuidanceAction(value: unknown): RunGuidanceActionView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const questionSetHash = publicProgressText(row.questionSetHash, 64).toLowerCase();
  const baseContractRevisionId = publicProgressText(row.baseContractRevisionId, 160);
  const baseContractSemanticHash = publicProgressText(
    row.baseContractSemanticHash,
    64,
  ).toLowerCase();
  const attemptsUsed = publicProgressOptionalCount(row.attemptsUsed);
  if (!/^[a-f0-9]{64}$/u.test(questionSetHash)
    || !baseContractRevisionId
    || !/^[a-f0-9]{64}$/u.test(baseContractSemanticHash)
    || attemptsUsed === null
    || attemptsUsed < 1
    || attemptsUsed > 2
    || row.maximumAttempts !== 2
    || !Array.isArray(row.questions)) {
    return null;
  }
  if (row.kind === "interpretation_summary") {
    const summary = row.interpretationSummary;
    const actions = row.actions;
    const reason = row.reason;
    const axis = row.axis === null
      ? null
      : publicProgressText(row.axis, 80);
    if (row.questions.length !== 0
      || row.showEditableInterpretationSummary !== true
      || !["clarification_attempt_limit", "rescue_question_limit"].includes(
        String(reason),
      )
      || (row.axis !== null && !axis)
      || !summary
      || typeof summary !== "object"
      || Array.isArray(summary)
      || !actions
      || typeof actions !== "object"
      || Array.isArray(actions)) {
      return null;
    }
    const summaryRow = summary as Record<string, unknown>;
    const actionRow = actions as Record<string, unknown>;
    const count = publicProgressOptionalCount(summaryRow.count);
    const textList = (value: unknown): string[] | null => {
      if (!Array.isArray(value) || value.length > 100) return null;
      const output = value.map((item) => publicProgressText(item, 500));
      return output.some((item) => !item) ? null : output;
    };
    const mustHave = textList(summaryRow.mustHave);
    const prefer = textList(summaryRow.prefer);
    const avoid = textList(summaryRow.avoid);
    const flow = textList(summaryRow.flow);
    if (count === null
      || count < 1
      || count > EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS
      || !mustHave || !prefer || !avoid || !flow
      || actionRow.changeEarlierAnswer !== true
      || actionRow.reviewContract !== true
      || actionRow.resumeLater !== true
      || actionRow.cancel !== true) {
      return null;
    }
    return {
      kind: "interpretation_summary",
      questionSetHash,
      baseContractRevisionId,
      baseContractSemanticHash,
      questions: [],
      attemptsUsed,
      maximumAttempts: 2,
      showEditableInterpretationSummary: true,
      reason: reason as "clarification_attempt_limit" | "rescue_question_limit",
      axis,
      interpretationSummary: {
        mustHave,
        prefer,
        avoid,
        flow,
        count,
      },
      actions: {
        changeEarlierAnswer: true,
        reviewContract: true,
        resumeLater: true,
        cancel: true,
      },
    };
  }
  if (row.kind !== "rescue_guidance"
    || row.showEditableInterpretationSummary !== false
    || row.questions.length < 1
    || row.questions.length > 1) {
    return null;
  }
  const questions: PlaylistGuidanceQuestion[] = [];
  try {
    for (const question of row.questions) {
      questions.push(publicGuidanceQuestionV3(
        guidanceDecisionV3FromPublicQuestion(
          question as PlaylistGuidanceQuestion,
        ),
      ));
    }
  } catch {
    return null;
  }
  if (questions.some((question) => (
    question.baseContractRevisionId !== baseContractRevisionId
    || question.baseContractSemanticHash !== baseContractSemanticHash
    || question.trigger !== "yield_risk"
  ))) {
    return null;
  }
  return {
    kind: "rescue_guidance",
    questionSetHash,
    baseContractRevisionId,
    baseContractSemanticHash,
    questions,
    attemptsUsed,
    maximumAttempts: 2,
    showEditableInterpretationSummary: false,
  };
}

function publicPartialAction(value: unknown): PartialPublicationActionView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const targetTrackCount = publicProgressOptionalCount(row.targetTrackCount);
  const qualifiedTrackCount = publicProgressOptionalCount(row.qualifiedTrackCount);
  const remainingStrategyCount = publicProgressOptionalCount(row.remainingStrategyCount);
  const outcomeVersion = publicProgressOptionalCount(row.outcomeVersion);
  const outcomeHash = publicProgressText(row.outcomeHash, 64).toLowerCase();
  if (
    targetTrackCount === null
    || targetTrackCount < 1
    || targetTrackCount > EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS
    || qualifiedTrackCount === null || qualifiedTrackCount >= targetTrackCount
    || remainingStrategyCount === null
    || outcomeVersion === null || outcomeVersion < 1
    || !/^[a-f0-9]{64}$/u.test(outcomeHash)
  ) return null;
  const manifestId = publicProgressText(row.manifestId, 80);
  const manifestHash = publicProgressText(row.manifestHash, 64).toLowerCase();
  return {
    kind: "partial_publication",
    targetTrackCount,
    qualifiedTrackCount,
    remainingStrategyCount,
    canContinueResearch: row.canContinueResearch === true && remainingStrategyCount > 0,
    reasonCode: publicProgressText(row.reasonCode, 80) || null,
    outcomeVersion,
    outcomeHash,
    ...(manifestId ? { manifestId } : {}),
    ...(/^[a-f0-9]{64}$/u.test(manifestHash) ? { manifestHash } : {}),
  };
}

function publicExplore(value: unknown): ExplorePreferenceView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.eligible !== "boolean" || typeof row.listed !== "boolean"
    || typeof row.canChange !== "boolean") return null;
  return {
    eligible: row.eligible,
    listed: row.listed,
    canChange: row.canChange,
    reason: publicProgressText(row.reason, 200) || null,
  };
}

/**
 * The capability-authenticated visitor API must advertise only actions that
 * the visitor can actually complete. Rescue guidance is preserved only when
 * its complete hash-bound action is present. A dependency resume is preserved
 * only when the retained provider blocker carries its optimistic-lock hash;
 * generic manual resume and Apple authorization remain owner/orchestrator
 * operations.
 */
export function publicRunResolutionView(
  resolution: RunResolutionView,
  partialAction: PartialPublicationActionView | null,
  guidanceAction: RunGuidanceActionView | null = null,
): RunResolutionView {
  let state = resolution.state;
  let nextAction = resolution.nextAction;

  if (nextAction === "answer_initial_guidance"
    || (nextAction === "answer_rescue_guidance" && !guidanceAction)) {
    state = "needs_decision";
    nextAction = "review_contract";
  } else if (nextAction === "authorize_apple") {
    state = "blocked_dependency";
    nextAction = "wait_for_dependency";
  } else if (nextAction === "resume_research") {
    const dependencyResume = resolution.state === "needs_decision"
      && resolution.blocker?.kind === "provider"
      && typeof resolution.blocker.versionHash === "string"
      && /^[a-f0-9]{64}$/u.test(resolution.blocker.versionHash);
    if (!dependencyResume) {
      state = "needs_decision";
      nextAction = partialAction?.canContinueResearch
        ? "decide_verified_partial"
        : "review_contract";
    }
  } else if (nextAction === "decide_verified_partial" && !partialAction) {
    state = "needs_decision";
    nextAction = "review_contract";
  }

  return {
    ...(resolution.generation == null ? {} : {
      generation: resolution.generation,
    }),
    state,
    nextAction,
    terminal: resolution.terminal,
    contractRevisionId: resolution.contractRevisionId,
    contractRevision: resolution.contractRevision,
    contractHash: resolution.contractHash,
    blocker: resolution.blocker ? {
      kind: resolution.blocker.kind,
      nextRetryAt: resolution.blocker.nextRetryAt,
      automaticRetryUntil: resolution.blocker.automaticRetryUntil,
      retryCount: resolution.blocker.retryCount,
      versionHash: resolution.blocker.versionHash,
    } : null,
  };
}

type InternalResearchRunView = ResearchRunView & {
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  [key: string]: unknown;
};

const PUBLICATION_PROGRESS_STATUSES = new Set([
  "pending",
  "queued",
  "creating",
  "appending",
  "waiting_for_share_url",
  "waiting_for_owner",
  "complete",
  "orphaned",
  "failed",
]);

function publicProgressCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function publicProgressOptionalCount(value: unknown): number | null {
  if (value == null) return null;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
}

function publicProgressText(value: unknown, maximum: number): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maximum)
    : "";
}

function publicProgressDate(value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function publicSourceDomain(value: unknown): string | null {
  const text = publicProgressText(value, 300).toLowerCase();
  if (!text) return null;
  try {
    const hostname = new URL(`https://${text}`).hostname.toLowerCase();
    return hostname ? hostname.slice(0, 253) : null;
  } catch {
    return null;
  }
}

/** Positive nested allowlist for live progress; never spread internal state. */
export function publicRunProgressView(progress: RunProgressView): RunProgressView {
  const targetTrackCount = publicProgressOptionalCount(progress.targetTrackCount);
  const recentSources = Array.isArray(progress.sourceSummary?.recentSources)
    ? progress.sourceSummary.recentSources.flatMap((source) => {
      const title = publicProgressText(source?.title, 160);
      const domain = publicSourceDomain(source?.domain);
      const sourceClass = publicProgressText(source?.sourceClass, 40).replace(/[^a-z0-9_-]/giu, "");
      return title && domain && sourceClass ? [{ title, domain, sourceClass }] : [];
    }).slice(0, 3)
    : [];
  const publicationStatus = publicProgressText(progress.publicationSummary?.status, 40);
  return {
    targetTrackCount: targetTrackCount && targetTrackCount > 0 ? targetTrackCount : null,
    latestActivityAt: publicProgressDate(progress.latestActivityAt),
    sourceSummary: {
      total: publicProgressCount(progress.sourceSummary?.total),
      recentSources,
    },
    frontierSummary: {
      total: publicProgressCount(progress.frontierSummary?.total),
      complete: publicProgressCount(progress.frontierSummary?.complete),
      active: publicProgressCount(progress.frontierSummary?.active),
      unresolved: publicProgressCount(progress.frontierSummary?.unresolved),
      inaccessible: publicProgressCount(progress.frontierSummary?.inaccessible),
      discoveredCount: publicProgressCount(progress.frontierSummary?.discoveredCount),
      recoveredCount: publicProgressCount(progress.frontierSummary?.recoveredCount),
    },
    containerSummary: {
      total: publicProgressCount(progress.containerSummary?.total),
      complete: publicProgressCount(progress.containerSummary?.complete),
      active: publicProgressCount(progress.containerSummary?.active),
      unresolved: publicProgressCount(progress.containerSummary?.unresolved),
      inaccessible: publicProgressCount(progress.containerSummary?.inaccessible),
      advertisedCount: publicProgressCount(progress.containerSummary?.advertisedCount),
      recoveredCount: publicProgressCount(progress.containerSummary?.recoveredCount),
    },
    matchSummary: {
      attempted: publicProgressCount(progress.matchSummary?.attempted),
      accepted: publicProgressCount(progress.matchSummary?.accepted),
      review: publicProgressCount(progress.matchSummary?.review),
      unavailable: publicProgressCount(progress.matchSummary?.unavailable),
      duplicate: publicProgressCount(progress.matchSummary?.duplicate),
      rejected: publicProgressCount(progress.matchSummary?.rejected),
      unsupported: publicProgressCount(progress.matchSummary?.unsupported),
      overflow: publicProgressCount(progress.matchSummary?.overflow),
      shortfall: publicProgressOptionalCount(progress.matchSummary?.shortfall),
    },
    publicationSummary: {
      volumeCount: publicProgressCount(progress.publicationSummary?.volumeCount),
      completedVolumes: publicProgressCount(progress.publicationSummary?.completedVolumes),
      totalTracks: publicProgressCount(progress.publicationSummary?.totalTracks),
      appendedTracks: publicProgressCount(progress.publicationSummary?.appendedTracks),
      currentVolume: publicProgressOptionalCount(progress.publicationSummary?.currentVolume),
      status: PUBLICATION_PROGRESS_STATUSES.has(publicationStatus) ? publicationStatus : null,
    },
  };
}

/**
 * Copies only fields approved for a capability-authenticated browser. Keeping
 * the projection here prevents repository additions from becoming public by
 * accident through object spreading.
 */
export function publicResearchRunView(
  run: InternalResearchRunView,
  identity?: { id?: string; prompt?: string },
): PublicResearchRunView {
  const partialAction = publicPartialAction(run.partialAction);
  const guidanceAction = publicRunGuidanceAction(run.guidanceAction);
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
    progress: run.progress ? publicRunProgressView(run.progress) : undefined,
    partialAction,
    decisionAction: publicAdaptiveRunDecisionV1(run.decisionAction),
    guidanceAction,
    explore: publicExplore(run.explore),
    resolution: run.resolution
      ? publicRunResolutionView(run.resolution, partialAction, guidanceAction)
      : undefined,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  };
}

export function publicBriefStatusView(input: {
  requestId: string;
  prompt: string;
  requestedTrackCount: number | null;
  originalRequestedTrackCount?: number | null;
  status: string;
  briefContractVersion?: 1 | 2 | 3;
  questionSetHash?: string | null;
  checkpointMode?:
    | "correctness_blocking"
    | "nuance_optional"
    | "interpretation_confirmation"
    | null;
  interpretationSummary?: PublicBriefStatusView["interpretationSummary"];
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
    originalRequestedTrackCount: input.originalRequestedTrackCount,
    status: input.status,
    briefContractVersion: input.briefContractVersion,
    questionSetHash: input.questionSetHash,
    checkpointMode: input.checkpointMode,
    interpretationSummary: input.interpretationSummary,
    brief: input.brief,
    questions: input.questions ?? [],
    answers: input.answers,
    error: input.error,
  };
}
