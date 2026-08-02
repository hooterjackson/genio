import type {
  RunNextAction,
  RunStatus,
  RunWorkMotion,
} from "../shared/types.ts";
import type {
  PlaylistResolutionStateV1,
} from "./playlist-resolution-service-v1.ts";

/**
 * Orthogonal, fenced facts used to derive the one user-visible resolution.
 * Attempt outcomes are observations only: callers must first discard stale
 * attempts and bind every fact to the active contract before invoking this
 * reducer.
 */
export interface ResolutionFactsV1 {
  legacyStatus: RunStatus;
  legacyPhase: string;
  blockerKind: string | null;
  blockerId: string | null;
  questionSetId: string | null;
  manifestId: string | null;
  requestedTrackCount: number | null;
  reconciledPublishedTrackCount: number | null;
  exactAppleReconciliation: boolean;
  workMotion: RunWorkMotion;
  integrityIncident: boolean;
  cancellationRequested: boolean;
  decisionAvailable: boolean;
}

export interface ResolutionReductionV1 {
  state: PlaylistResolutionStateV1;
  nextAction: RunNextAction;
  reasonCode: string;
  /**
   * Cancellation is the user's resolution, but it cannot erase a publication
   * that Apple already observed. The projection retains this facet so the
   * incident/reconciliation path remains visible.
   */
  observedAppleSideEffect: boolean;
  incidentRequired: boolean;
}

function exactCompletion(input: ResolutionFactsV1): boolean {
  return input.manifestId !== null
    && input.exactAppleReconciliation
    && Number.isSafeInteger(input.requestedTrackCount)
    && input.requestedTrackCount! > 0
    && input.reconciledPublishedTrackCount === input.requestedTrackCount;
}

function executableMotion(motion: RunWorkMotion): boolean {
  return motion === "running" || motion === "retry_scheduled";
}

/**
 * Resolution is deliberately not a scalar precedence ranking. Integrity,
 * cancellation, dependency, completeness, and work motion are independent
 * facts whose invalid combinations fail closed.
 */
export function reduceResolutionFactsV1(
  input: ResolutionFactsV1,
): ResolutionReductionV1 {
  const observedAppleSideEffect =
    Number(input.reconciledPublishedTrackCount ?? 0) > 0;

  if (input.integrityIncident) {
    return {
      state: "quarantined",
      nextAction: "contact_support",
      reasonCode: "active_integrity_incident",
      observedAppleSideEffect,
      incidentRequired: true,
    };
  }

  if (input.cancellationRequested) {
    return {
      state: "cancelled",
      nextAction: "none",
      reasonCode: observedAppleSideEffect
        ? "cancelled_with_observed_apple_side_effect"
        : "cancelled_without_publication",
      observedAppleSideEffect,
      incidentRequired: observedAppleSideEffect,
    };
  }

  if (exactCompletion(input)) {
    return {
      state: "completed",
      nextAction: "none",
      reasonCode: "exact_apple_reconciliation",
      observedAppleSideEffect: true,
      incidentRequired: false,
    };
  }

  if (input.legacyStatus === "complete") {
    return {
      state: "needs_decision",
      nextAction: "review_contract",
      reasonCode: "legacy_completion_missing_exact_apple_reconciliation",
      observedAppleSideEffect,
      incidentRequired: observedAppleSideEffect,
    };
  }

  if (input.blockerKind === "publication_reconciliation"
    || input.blockerKind === "integrity") {
    return {
      state: "quarantined",
      nextAction: "contact_support",
      reasonCode: `${input.blockerKind}_blocker`,
      observedAppleSideEffect,
      incidentRequired: true,
    };
  }
  if (input.blockerKind === "provider") {
    return {
      state: "blocked_dependency",
      nextAction: "wait_for_dependency",
      reasonCode: "provider_dependency_blocker",
      observedAppleSideEffect,
      incidentRequired: false,
    };
  }
  if (input.blockerKind === "apple_authorization") {
    return {
      state: "blocked_dependency",
      nextAction: "authorize_apple",
      reasonCode: "apple_authorization_blocker",
      observedAppleSideEffect,
      incidentRequired: false,
    };
  }
  if (input.blockerKind === "guidance") {
    return {
      state: "needs_input",
      nextAction: "answer_initial_guidance",
      reasonCode: "guidance_blocker",
      observedAppleSideEffect,
      incidentRequired: false,
    };
  }

  const decisionState = input.decisionAvailable
    || input.blockerKind === "budget"
    || input.blockerKind === "scope_decision"
    || input.legacyStatus === "needs_decision"
    || input.legacyStatus === "awaiting_budget"
    || input.legacyStatus === "partial_ready"
    || input.legacyStatus === "partial"
    || input.legacyStatus === "no_compatible_tracks";
  if (decisionState) {
    if (executableMotion(input.workMotion)) {
      return {
        state: "quarantined",
        nextAction: "contact_support",
        reasonCode: "decision_state_has_executable_work",
        observedAppleSideEffect,
        incidentRequired: true,
      };
    }
    return {
      state: "needs_decision",
      nextAction: "review_contract",
      reasonCode: input.legacyStatus === "no_compatible_tracks"
        ? "compatibility_or_scarcity_decision_required"
        : "explicit_user_decision_required",
      observedAppleSideEffect,
      incidentRequired: false,
    };
  }

  if (input.legacyStatus === "manifest_ready") {
    return {
      state: input.manifestId ? "ready" : "quarantined",
      nextAction: input.manifestId ? "none" : "contact_support",
      reasonCode: input.manifestId
        ? "manifest_ready"
        : "ready_state_missing_manifest",
      observedAppleSideEffect,
      incidentRequired: input.manifestId === null,
    };
  }
  if (input.legacyStatus === "publishing") {
    return {
      state: input.manifestId ? "publishing" : "quarantined",
      nextAction: input.manifestId ? "none" : "contact_support",
      reasonCode: input.manifestId
        ? "publication_in_progress"
        : "publication_state_missing_manifest",
      observedAppleSideEffect,
      incidentRequired: input.manifestId === null,
    };
  }

  if (input.legacyStatus === "failed"
    || input.legacyStatus === "failed_system"
    || input.legacyStatus === "failed_integrity") {
    return {
      state: "quarantined",
      nextAction: "contact_support",
      reasonCode: "technical_attempt_failure",
      observedAppleSideEffect,
      incidentRequired: true,
    };
  }

  if (input.workMotion === "waiting_dependency") {
    return {
      state: "blocked_dependency",
      nextAction: "wait_for_dependency",
      reasonCode: "dependency_wait",
      observedAppleSideEffect,
      incidentRequired: false,
    };
  }
  if (input.workMotion === "running"
    || input.workMotion === "retry_scheduled"
    || input.workMotion === "paused"
    || input.workMotion === "stalled") {
    return {
      state: "executing",
      nextAction: "none",
      reasonCode: `work_${input.workMotion}`,
      observedAppleSideEffect,
      incidentRequired: false,
    };
  }

  return {
    state: "accepted",
    nextAction: "none",
    reasonCode: "accepted_without_executable_observation",
    observedAppleSideEffect,
    incidentRequired: false,
  };
}
