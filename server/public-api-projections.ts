import type {
  PlaylistBrief,
  PlaylistGuidanceAnswer,
  PlaylistGuidanceQuestion,
  PublicBriefStatusView,
  ExplorePreferenceView,
  PartialPublicationActionView,
  PublicResearchRunView,
  ResearchRunView,
  RunProgressView,
} from "../shared/types.ts";

function publicPartialAction(value: unknown): PartialPublicationActionView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const targetTrackCount = publicProgressOptionalCount(row.targetTrackCount);
  const qualifiedTrackCount = publicProgressOptionalCount(row.qualifiedTrackCount);
  const remainingStrategyCount = publicProgressOptionalCount(row.remainingStrategyCount);
  const outcomeVersion = publicProgressOptionalCount(row.outcomeVersion);
  const outcomeHash = publicProgressText(row.outcomeHash, 64).toLowerCase();
  if (
    targetTrackCount === null || targetTrackCount < 1 || targetTrackCount > 300
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
    partialAction: publicPartialAction(run.partialAction),
    explore: publicExplore(run.explore),
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
