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
  executionRouteReceipt?: {
    version?: string;
    executionRoute?: string;
    receiptHash?: string;
    executorConfigurationHash?: string;
  } | null;
  evidenceCoverage?: {
    observationCount?: number;
    uniqueLeadCount?: number;
    materializedCandidateCount?: number;
  } | null;
  candidateCount?: number;
  sourceCount?: number;
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
  decisionAction?: {
    reason?: string;
    decisionHash?: string;
    actions?: {
      anotherBoundedPass?: boolean;
      reviseNamedPredicate?: boolean;
      reduceCount?: boolean;
      publishVerifiedPartial?: boolean;
      pause?: boolean;
      resumeLater?: boolean;
      cancel?: boolean;
    };
  } | null;
  resolution?: {
    generation?: number | null;
    state?: string;
    nextAction?: string;
    terminal?: boolean;
    contractRevisionId?: string | null;
    contractHash?: string | null;
    blocker?: {
      kind?: string;
      nextRetryAt?: string | null;
      automaticRetryUntil?: string | null;
      versionHash?: string | null;
    } | null;
  } | null;
  repairReplayAction?: {
    kind?: string;
    expectedGeneration?: number;
    incidentReference?: string;
    contractRevisionId?: string;
    contractSemanticHash?: string;
    available?: boolean;
    availabilityReason?: string;
    successorBriefRequestId?: string | null;
    resultReuse?: boolean;
    autoPublication?: boolean;
  } | null;
};

export type BriefExecutionDecisionResponse = {
  status?: string;
  executionAction?: {
    decisionHash?: string;
    optionId?: string;
    kind?: string;
    startsResearch?: boolean;
    actionHash?: string;
  } | null;
};

export type BriefExecutionDecisionDisposition =
  | "execute"
  | "review"
  | "cancelled";

/**
 * Converts the hash-bound server action into one browser disposition. Review
 * and cancel are deliberately terminal for polling/research admission.
 */
export function briefExecutionDecisionDisposition(
  response: BriefExecutionDecisionResponse | null | undefined,
): BriefExecutionDecisionDisposition | null {
  const action = response?.executionAction;
  if (!action
    || !validDecisionHash(action.decisionHash)
    || !validDecisionHash(action.actionHash)
    || typeof action.optionId !== "string") {
    return null;
  }
  if (action.kind === "execute_confirmed_contract"
    && action.startsResearch === true
    && ["finalizing", "complete"].includes(response?.status ?? "")) {
    return "execute";
  }
  if (action.kind === "review_interpretation"
    && action.startsResearch === false
    && response?.status === "review_required") {
    return "review";
  }
  if (action.kind === "cancel_request"
    && action.startsResearch === false
    && response?.status === "cancelled") {
    return "cancelled";
  }
  return null;
}

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
  | "resume_dependency"
  | "replay_after_repair"
  | "continue_repair"
  | "repair_pending"
  | "refine_request"
  | "contact_support"
  | "cancel_job";

export type RunExecutionRouteAuthorityIssue =
  | "missing_execution_route_receipt"
  | "invalid_execution_route_receipt"
  | "execution_route_mismatch";

export type RunEvidenceDisplayCounts = {
  observationCount: number | null;
  uniqueLeadCount: number;
  materializedCandidateCount: number;
};

function validDecisionHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function finiteNonNegativeCount(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0
    ? Math.floor(numeric)
    : null;
}

function legacyTerminalRun(
  run: PartialReadyRun | null | undefined,
): boolean {
  return run?.resolution?.terminal === true
    || [
      "complete",
      "partial",
      "cancelled",
      "expired",
      "deleted",
    ].includes(run?.status ?? "");
}

/**
 * The route receipt is authoritative for admitted work. Legacy terminal runs
 * remain readable without one, but active corpus-first work may never render
 * as healthy when its receipt is absent, malformed, or contradicts the
 * compatibility pipeline label.
 */
export function runExecutionRouteAuthorityIssue(
  run: PartialReadyRun | null | undefined,
): RunExecutionRouteAuthorityIssue | null {
  if (!run) return null;
  const receipt = run.executionRouteReceipt;
  if (!receipt) {
    return run.pipelineVersion === "corpus_first_v3"
      && !legacyTerminalRun(run)
      ? "missing_execution_route_receipt"
      : null;
  }
  if (receipt.version !== "execution_route_receipt_v1"
    || typeof receipt.executionRoute !== "string"
    || receipt.executionRoute.length === 0
    || !validDecisionHash(receipt.receiptHash)
    || !validDecisionHash(receipt.executorConfigurationHash)) {
    return "invalid_execution_route_receipt";
  }
  return typeof run.pipelineVersion === "string"
    && run.pipelineVersion.length > 0
    && run.pipelineVersion !== receipt.executionRoute
    ? "execution_route_mismatch"
    : null;
}

/**
 * Preserve the three different units exposed by execution truth. Cumulative
 * provider observations must never inflate deduplicated leads or materialized
 * candidates in the browser.
 */
export function runEvidenceDisplayCounts(
  run: PartialReadyRun | null | undefined,
): RunEvidenceDisplayCounts {
  const coverage = run?.evidenceCoverage;
  return {
    observationCount: coverage
      ? finiteNonNegativeCount(coverage.observationCount)
      : null,
    uniqueLeadCount: coverage
      ? finiteNonNegativeCount(coverage.uniqueLeadCount) ?? 0
      : finiteNonNegativeCount(run?.sourceCount) ?? 0,
    materializedCandidateCount: coverage
      ? finiteNonNegativeCount(coverage.materializedCandidateCount) ?? 0
      : finiteNonNegativeCount(run?.candidateCount) ?? 0,
  };
}

function hasSupportedContractRevisionAction(
  run: PartialReadyRun | null | undefined,
): boolean {
  return validDecisionHash(run?.decisionAction?.decisionHash)
    && (
      run?.decisionAction?.actions?.reviseNamedPredicate === true
      || run?.decisionAction?.actions?.reduceCount === true
    );
}

/**
 * Controls rendered for a public run resolution. This is deliberately based
 * on supported visitor behavior, not on aspirational orchestration actions.
 * A typed partial decision has its own screen and is handled separately.
 */
export function runResolutionControls(
  run: PartialReadyRun | null | undefined,
): RunResolutionControl[] {
  if (runExecutionRouteAuthorityIssue(run)) {
    return legacyTerminalRun(run)
      ? ["contact_support"]
      : ["contact_support", "cancel_job"];
  }
  const resolution = run?.resolution;
  if (!resolution || resolution.terminal || partialReadyView(run)) return [];
  const repairAction = run?.repairReplayAction;
  const repairFenceValid = repairAction?.kind === "repair_replay"
    && Number.isSafeInteger(repairAction.expectedGeneration)
    && Number(repairAction.expectedGeneration) > 0
    && typeof repairAction.incidentReference === "string"
    && repairAction.incidentReference.length > 0
    && typeof repairAction.contractRevisionId === "string"
    && /^[a-f0-9]{64}$/u.test(
      repairAction.contractSemanticHash ?? "",
    )
    && repairAction.resultReuse === false
    && repairAction.autoPublication === false
    && resolution.generation === repairAction.expectedGeneration
    && resolution.contractRevisionId === repairAction.contractRevisionId
    && resolution.contractHash === repairAction.contractSemanticHash;
  if (resolution.state === "quarantined" && repairFenceValid) {
    if (repairAction?.availabilityReason === "already_started"
      && typeof repairAction.successorBriefRequestId === "string"
      && repairAction.successorBriefRequestId.length > 0) {
      return ["continue_repair", "cancel_job"];
    }
    if (repairAction?.available === false
      && ["repair_pending", "route_paused"].includes(
        repairAction.availabilityReason ?? "",
      )) {
      return ["repair_pending", "contact_support", "cancel_job"];
    }
  }

  switch (resolution.nextAction) {
    case "wait_for_dependency":
    case "authorize_apple":
      return ["wait_for_retry", "cancel_job"];
    case "contact_support":
      return ["contact_support", "cancel_job"];
    case "replay_after_repair": {
      const action = repairAction;
      return resolution.state === "quarantined"
        && repairFenceValid
        && action?.available === true
        && action.availabilityReason === "ready"
        ? ["replay_after_repair", "cancel_job"]
        : ["contact_support", "cancel_job"];
    }
    case "review_contract":
      return hasSupportedContractRevisionAction(run)
        ? ["refine_request", "cancel_job"]
        : ["contact_support", "cancel_job"];
    case "answer_initial_guidance":
    case "answer_rescue_guidance":
      return ["refine_request", "cancel_job"];
    case "resume_research":
      return resolution.state === "needs_decision"
        && resolution.blocker?.kind === "provider"
        && typeof resolution.blocker.versionHash === "string"
        && /^[a-f0-9]{64}$/u.test(resolution.blocker.versionHash)
        && run?.decisionAction?.reason === "dependency_retry_window_expired"
        && run.decisionAction.actions?.resumeLater === true
        && validDecisionHash(run.decisionAction.decisionHash)
        ? ["resume_dependency", "cancel_job"]
        : ["contact_support", "cancel_job"];
    case "decide_verified_partial":
      // A malformed or stale partial action cannot power the explicit
      // decision API. Treat that as a technical repair instead of implying
      // that rewriting the user's request will repair our state.
      return ["contact_support", "cancel_job"];
    default:
      if (resolution.state === "quarantined") {
        return ["contact_support", "cancel_job"];
      }
      if (resolution.state === "needs_input" || resolution.state === "needs_decision") {
        return ["contact_support", "cancel_job"];
      }
      return [];
  }
}

export function shouldKeepPollingBlockedRun(
  run: PartialReadyRun | null | undefined,
): boolean {
  const resolution = run?.resolution;
  return resolution?.state === "blocked_dependency"
    || (
      resolution?.state === "quarantined"
      && resolution.terminal !== true
      && ![
        "complete",
        "partial",
        "failed",
        "no_compatible_tracks",
        "cancelled",
        "failed_system",
        "failed_integrity",
        "expired",
        "deleted",
      ].includes(run?.status ?? "")
    );
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
  // The partial-decision payload remains attached to the run as immutable
  // consent lineage after the visitor accepts it. It is no longer actionable
  // once manifest handoff or Apple publication begins. Treating that retained
  // payload as a live decision tears down polling before the authoritative
  // publishing/completed resolution can arrive.
  if ([
    "manifest_ready",
    "publishing",
    "waiting_for_apple_authorization",
    "complete",
    "partial",
  ].includes(run.status ?? "")) {
    return null;
  }
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
