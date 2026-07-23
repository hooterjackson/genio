type UnknownObject = Record<string, unknown>;

export type PartialPublicationAction = {
  kind?: string;
  targetTrackCount?: number;
  qualifiedTrackCount?: number;
  remainingStrategyCount?: number;
  canContinueResearch?: boolean;
  reasonCode?: string;
  outcomeVersion?: string | number;
  outcomeHash?: string;
  manifestId?: string;
  manifestHash?: string;
};

export type PartialReadyRun = {
  status?: string;
  phase?: string;
  pipelineVersion?: string;
  error?: string | null;
  actionRequired?: PartialPublicationAction | null;
  partialAction?: PartialPublicationAction | null;
  pipelineOutcome?: {
    status?: string;
    targetTrackCount?: number;
    qualifiedTrackCount?: number;
    selectedTrackCount?: number;
    reasonCodes?: string[];
  } | null;
  resolution?: {
    state?: string;
    nextAction?: string;
    terminal?: boolean;
    blocker?: {
      kind?: string;
      nextRetryAt?: string | null;
    } | null;
  } | null;
};

export type PartialReadyView = {
  targetTrackCount: number;
  qualifiedTrackCount: number;
  deficit: number;
  remainingStrategyCount: number;
  canContinueResearch: boolean;
  outcomeVersion: string | number | null;
  outcomeHash: string | null;
  manifestId: string | null;
  manifestHash: string | null;
  reasonCode: string | null;
};

export type RunResolutionControl =
  | "wait_for_retry"
  | "refine_request"
  | "contact_support"
  | "cancel_job";

/**
 * Controls rendered for a public run resolution. This is deliberately based
 * on supported visitor behavior, not on aspirational orchestration actions.
 * A typed partial decision has its own screen and is handled separately.
 */
export function runResolutionControls(
  run: PartialReadyRun | null | undefined,
): RunResolutionControl[] {
  const resolution = run?.resolution;
  if (!resolution || resolution.terminal || partialReadyView(run)) return [];

  switch (resolution.nextAction) {
    case "wait_for_dependency":
    case "authorize_apple":
      return ["wait_for_retry", "refine_request", "cancel_job"];
    case "contact_support":
      return ["contact_support", "refine_request", "cancel_job"];
    case "review_contract":
    case "answer_initial_guidance":
    case "answer_rescue_guidance":
    case "resume_research":
      return ["refine_request", "cancel_job"];
    case "decide_verified_partial":
      // A malformed or stale partial action cannot power the explicit
      // decision API, so fall back to a fresh contract revision.
      return ["refine_request", "cancel_job"];
    default:
      if (resolution.state === "quarantined") {
        return ["contact_support", "refine_request", "cancel_job"];
      }
      if (resolution.state === "needs_input" || resolution.state === "needs_decision") {
        return ["refine_request", "cancel_job"];
      }
      return [];
  }
}

export function shouldKeepPollingBlockedRun(
  run: PartialReadyRun | null | undefined,
): boolean {
  return run?.resolution?.state === "blocked_dependency";
}

function asObject(value: unknown): UnknownObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownObject
    : {};
}

export function apiErrorCode(payload: unknown): string | null {
  const object = asObject(payload);
  if (typeof object.code === "string") return object.code;
  const nested = asObject(object.error);
  return typeof nested.code === "string" ? nested.code : null;
}

export function shouldQuietlyClearInitialRunRestore({
  hasRunId,
  status,
  code,
}: {
  hasRunId: boolean;
  status: number;
  code?: string | null;
}): boolean {
  if (!hasRunId) return false;
  if (code === "capability_scope_mismatch") return true;
  return [400, 401, 404, 410].includes(status);
}

export function publishedTrackCountSummary(
  publishedTrackCount: number,
  requestedTrackCount?: number | null,
): string {
  const published = Math.max(0, Math.floor(publishedTrackCount));
  const requested = typeof requestedTrackCount === "number" && Number.isFinite(requestedTrackCount)
    ? Math.max(0, Math.floor(requestedTrackCount))
    : null;
  if (requested !== null && published !== requested) {
    return `${published.toLocaleString()} of ${requested.toLocaleString()} requested ${requested === 1 ? "track" : "tracks"} published.`;
  }
  return `${published.toLocaleString()} ${published === 1 ? "track" : "tracks"} published.`;
}

export function evidenceCountSummary(sourceCount: number, unresolvedGapCount: number): string {
  const sources = Math.max(0, Math.floor(sourceCount));
  const gaps = Math.max(0, Math.floor(unresolvedGapCount));
  return `Evidence: ${sources.toLocaleString()} documented ${sources === 1 ? "source" : "sources"}; ${gaps.toLocaleString()} open ${gaps === 1 ? "gap" : "gaps"}.`;
}

export function publishedResultHeading(
  publishedTrackCount: number,
  publishedWithGaps: boolean,
): string {
  if (publishedTrackCount <= 0) return "No compatible tracks found";
  return publishedWithGaps ? "Playlist published with gaps" : "Playlist published";
}

function finiteCount(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }
  }
  return null;
}

/**
 * Adapts both the explicit V3 action payload and the temporary phase-based
 * compatibility shape into one frontend-only decision view. The compatibility
 * branch is deliberately gated to Pipeline V3 so legacy visitor_review runs
 * keep their existing behavior until the backend migration is complete.
 */
export function partialReadyView(run: PartialReadyRun | null | undefined): PartialReadyView | null {
  if (!run) return null;
  const action = run.partialAction ?? run.actionRequired;
  const explicitAction = action?.kind === "partial_publication"
    || action?.kind === "partial_confirmation";
  const explicitV3Status = run.status === "partial_ready"
    || run.status === "no_compatible_tracks";
  const compatibleV3Phase = run.pipelineVersion === "corpus_first_v3"
    && /(?:partial|shortfall).*(?:ready|confirmation|decision)|awaiting_partial/iu.test(run.phase ?? "");
  if (!explicitAction && !explicitV3Status && !compatibleV3Phase) return null;

  const targetTrackCount = finiteCount(
    action?.targetTrackCount,
    run.pipelineOutcome?.targetTrackCount,
  );
  const qualifiedTrackCount = finiteCount(
    action?.qualifiedTrackCount,
    run.pipelineOutcome?.selectedTrackCount,
    run.pipelineOutcome?.qualifiedTrackCount,
  );
  if (targetTrackCount === null || qualifiedTrackCount === null || qualifiedTrackCount >= targetTrackCount) {
    return null;
  }

  const remainingStrategyCount = finiteCount(action?.remainingStrategyCount) ?? 0;
  return {
    targetTrackCount,
    qualifiedTrackCount,
    deficit: targetTrackCount - qualifiedTrackCount,
    remainingStrategyCount,
    canContinueResearch: action?.canContinueResearch ?? remainingStrategyCount > 0,
    outcomeVersion: action?.outcomeVersion ?? null,
    outcomeHash: action?.outcomeHash ?? null,
    manifestId: action?.manifestId ?? null,
    manifestHash: action?.manifestHash ?? null,
    reasonCode: action?.reasonCode
      ?? run.pipelineOutcome?.reasonCodes?.[0]
      ?? null,
  };
}

export function actionRequiredJobLabel(run: PartialReadyRun | null | undefined): string | null {
  return partialReadyView(run) ? "ACTION NEEDED" : null;
}

export function shouldPresentShortfallWithoutError(run: PartialReadyRun | null | undefined): boolean {
  if (!run) return false;
  if (partialReadyView(run)) return true;
  return [
    "partial_frontier_exhausted",
    "partial_evidence_shortfall",
    "partial_catalog_degraded",
    "partial_timed_out",
    "partial_policy_conflict",
    "no_compatible_tracks",
  ].includes(run.pipelineOutcome?.status ?? "");
}

export function partialDecisionHeading(qualifiedTrackCount: number): string {
  return qualifiedTrackCount > 0
    ? `${qualifiedTrackCount.toLocaleString()} verified ${qualifiedTrackCount === 1 ? "track is" : "tracks are"} ready`
    : "No verified tracks are ready yet";
}

export function partialDecisionSummary(qualifiedTrackCount: number, targetTrackCount: number): string {
  const qualified = Math.max(0, Math.floor(qualifiedTrackCount));
  const target = Math.max(0, Math.floor(targetTrackCount));
  if (qualified === 0) {
    return `Research has not found a safe Apple Music match for any of the ${target.toLocaleString()} requested tracks yet.`;
  }
  return `You requested ${target.toLocaleString()} tracks. gênio can publish ${qualified.toLocaleString()} now without lowering the evidence or matching standard.`;
}
