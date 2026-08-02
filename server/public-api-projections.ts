import type {
  PlaylistBrief,
  PlaylistGuidanceAnswer,
  PlaylistGuidanceQuestion,
  PublicBriefStatusView,
  ExplorePreferenceView,
  PartialPublicationActionView,
  PublicResearchRunView,
  ResearchRunView,
  RunEvidenceCoverageView,
  RunExecutionRouteReceiptView,
  RunGuidanceActionView,
  RunProgressView,
  RunRepairReplayActionView,
  RunResolutionView,
} from "../shared/types.ts";
import { EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS } from "../shared/product-policy.ts";
import {
  advancingAdaptiveRunDecisionActionV1,
  publicAdaptiveRunDecisionV1,
} from "./adaptive-run-decision-v1.ts";
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

function publicRepairReplayAction(
  value: unknown,
): RunRepairReplayActionView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const expectedGeneration = publicProgressOptionalCount(
    row.expectedGeneration,
  );
  const incidentReference = publicProgressText(row.incidentReference, 160);
  const contractRevisionId = publicProgressText(row.contractRevisionId, 80);
  const contractSemanticHash = publicProgressText(
    row.contractSemanticHash,
    64,
  ).toLowerCase();
  const availabilityReason = publicProgressText(
    row.availabilityReason,
    40,
  );
  const successorBriefRequestId = publicProgressText(
    row.successorBriefRequestId,
    80,
  );
  if (row.kind !== "repair_replay"
    || expectedGeneration === null
    || expectedGeneration < 1
    || !incidentReference
    || !contractRevisionId
    || !/^[a-f0-9]{64}$/u.test(contractSemanticHash)
    || typeof row.available !== "boolean"
    || !new Set([
      "ready",
      "repair_pending",
      "route_paused",
      "already_started",
    ]).has(availabilityReason)
    || (row.available && availabilityReason !== "ready")
    || (!row.available && availabilityReason === "ready")
    || (availabilityReason === "already_started"
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        successorBriefRequestId,
      ))
    || row.resultReuse !== false
    || row.autoPublication !== false) {
    return null;
  }
  return {
    kind: "repair_replay",
    expectedGeneration,
    incidentReference,
    contractRevisionId,
    contractSemanticHash,
    available: row.available,
    availabilityReason: availabilityReason as
      RunRepairReplayActionView["availabilityReason"],
    ...(successorBriefRequestId ? { successorBriefRequestId } : {}),
    resultReuse: false,
    autoPublication: false,
  };
}

function publicExecutionRouteReceipt(
  value: unknown,
): RunExecutionRouteReceiptView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const trafficClass = publicProgressText(row.trafficClass, 32);
  const assignmentKind = publicProgressText(row.assignmentKind, 40);
  const guidanceVersion = publicProgressText(row.guidanceVersion, 80);
  const executionRoute = publicProgressText(row.executionRoute, 80);
  const releaseRevision = publicProgressText(row.releaseRevision, 80);
  const executorConfigurationHash = publicProgressText(
    row.executorConfigurationHash,
    64,
  ).toLowerCase();
  const intentGroup = row.intentGroup === null
    ? null
    : publicProgressText(row.intentGroup, 80);
  const receiptHash = publicProgressText(row.receiptHash, 64).toLowerCase();
  const queryPlanSchema = publicProgressOptionalCount(row.queryPlanSchema);
  const contractVersion = Number(row.contractVersion);
  const queryPlanHash = row.queryPlanHash === null
    ? null
    : publicProgressText(row.queryPlanHash, 64).toLowerCase();
  const capabilitySnapshotHash = row.capabilitySnapshotHash === null
    ? null
    : publicProgressText(row.capabilitySnapshotHash, 64).toLowerCase();
  if (row.version !== "execution_route_receipt_v1"
    || !["public", "owner_canary", "synthetic", "replay"].includes(
      trafficClass,
    )
    || ![
      "signed_public_rollout",
      "signed_public_direct_exposure",
      "signed_owner_canary",
      "signed_release_canary",
      "authenticated_legacy_repair",
      "legacy_control",
    ].includes(assignmentKind)
    || !guidanceVersion
    || !executionRoute
    || !releaseRevision
    || !Number.isInteger(contractVersion)
    || contractVersion < 1
    || contractVersion > 3
    || (row.intentGroup !== null && !intentGroup)
    || (row.queryPlanSchema !== null
      && (queryPlanSchema === null || queryPlanSchema < 1))
    || (queryPlanHash !== null && !/^[a-f0-9]{64}$/u.test(queryPlanHash))
    || (capabilitySnapshotHash !== null
      && !/^[a-f0-9]{64}$/u.test(capabilitySnapshotHash))
    || !/^[a-f0-9]{64}$/u.test(executorConfigurationHash)
    || !/^[a-f0-9]{64}$/u.test(receiptHash)) {
    return null;
  }
  return {
    version: "execution_route_receipt_v1",
    trafficClass:
      trafficClass as RunExecutionRouteReceiptView["trafficClass"],
    contractVersion: contractVersion as 1 | 2 | 3,
    guidanceVersion,
    executionRoute,
    queryPlanSchema,
    queryPlanHash,
    capabilitySnapshotHash,
    releaseRevision,
    executorConfigurationHash,
    assignmentKind:
      assignmentKind as RunExecutionRouteReceiptView["assignmentKind"],
    intentGroup,
    receiptHash,
  };
}

function publicEvidenceCoverage(value: unknown): RunEvidenceCoverageView {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawObligations = row.obligationCounts
    && typeof row.obligationCounts === "object"
    && !Array.isArray(row.obligationCounts)
    ? row.obligationCounts as Record<string, unknown>
    : {};
  const obligationCounts = Object.fromEntries(
    Object.entries(rawObligations).flatMap(([obligationId, raw]) => {
      if (!/^[0-9A-Za-z._:-]{1,160}$/u.test(obligationId)
        || !raw
        || typeof raw !== "object"
        || Array.isArray(raw)) return [];
      const counts = raw as Record<string, unknown>;
      return [[obligationId, {
        pass: publicProgressCount(counts.pass),
        fail: publicProgressCount(counts.fail),
        unknown: publicProgressCount(counts.unknown),
      }]];
    }),
  );
  const qualificationObservationCount = publicProgressCount(
    row.qualificationObservationCount,
  );
  const observationCount = publicProgressCount(
    row.observationCount ?? row.qualificationObservationCount,
  );
  const materializedCandidateCount = publicProgressCount(
    row.materializedCandidateCount ?? row.candidates,
  );
  return {
    observationCount,
    qualificationObservationCount,
    legacyUnboundQualificationCount: publicProgressCount(
      row.legacyUnboundQualificationCount,
    ),
    uniqueLeadCount: publicProgressCount(row.uniqueLeadCount),
    candidates: materializedCandidateCount,
    materializedCandidateCount,
    identityBound: publicProgressCount(row.identityBound),
    appleResolvedCount: publicProgressCount(row.appleResolvedCount),
    versionCompatible: publicProgressCount(row.versionCompatible),
    storefrontPlayable: publicProgressCount(row.storefrontPlayable),
    obligationCounts,
    evidencePassed: publicProgressCount(row.evidencePassed),
    evidenceUnknown: publicProgressCount(row.evidenceUnknown),
    evidenceFailed: publicProgressCount(row.evidenceFailed),
    selected: publicProgressCount(row.selected),
    manifested: publicProgressCount(row.manifested),
    appendedCount: publicProgressCount(row.appendedCount),
    reconciledPublished: publicProgressOptionalCount(
      row.reconciledPublished,
    ),
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
  decisionAction: ReturnType<typeof publicAdaptiveRunDecisionV1> = null,
): RunResolutionView {
  let state = resolution.state;
  let nextAction = resolution.nextAction;
  const workMotion = resolution.workMotion;
  const validWorkMotion = workMotion === "running"
    || workMotion === "retry_scheduled"
    || workMotion === "waiting_dependency"
    || workMotion === "paused"
    || workMotion === "stalled"
    || workMotion === "none"
    ? workMotion
    : undefined;
  const dependencyMotion = validWorkMotion === "retry_scheduled"
    || validWorkMotion === "waiting_dependency";

  if (dependencyMotion
    && (resolution.blocker?.kind === "provider"
      || resolution.blocker?.kind === "apple_authorization")) {
    state = "blocked_dependency";
    nextAction = "wait_for_dependency";
  } else if (validWorkMotion === "paused"
    || validWorkMotion === "stalled"
    || dependencyMotion) {
    state = "quarantined";
    nextAction = "contact_support";
  }

  if (nextAction === "answer_initial_guidance"
    || (nextAction === "answer_rescue_guidance" && !guidanceAction)) {
    state = "quarantined";
    nextAction = "contact_support";
  } else if (nextAction === "authorize_apple") {
    state = "blocked_dependency";
    nextAction = "wait_for_dependency";
  } else if (nextAction === "resume_research") {
    const dependencyResume = resolution.state === "needs_decision"
      && resolution.blocker?.kind === "provider"
      && typeof resolution.blocker.versionHash === "string"
      && /^[a-f0-9]{64}$/u.test(resolution.blocker.versionHash);
    if (!dependencyResume) {
      if (partialAction?.canContinueResearch) {
        state = "needs_decision";
        nextAction = "decide_verified_partial";
      } else {
        state = "quarantined";
        nextAction = "contact_support";
      }
    }
  } else if (nextAction === "decide_verified_partial" && !partialAction) {
    state = "quarantined";
    nextAction = "contact_support";
  }

  if (state === "needs_decision"
    && (nextAction === "review_contract" || nextAction === "resume_research")) {
    const guidanceReview = nextAction === "review_contract"
      && guidanceAction?.kind === "interpretation_summary";
    const adaptiveAction = decisionAction
      && typeof resolution.contractSemanticRevisionId === "string"
      && decisionAction.contractRevisionId
        === resolution.contractSemanticRevisionId
      && decisionAction.contractSemanticHash === resolution.contractHash
      ? advancingAdaptiveRunDecisionActionV1(decisionAction)
      : null;
    if (!guidanceReview && adaptiveAction !== nextAction) {
      state = "quarantined";
      nextAction = "contact_support";
    }
  }

  return {
    ...(resolution.generation == null ? {} : {
      generation: resolution.generation,
    }),
    state,
    nextAction,
    terminal: state === "completed" || state === "cancelled",
    contractRevisionId: resolution.contractRevisionId,
    ...(resolution.contractSemanticRevisionId === undefined
      ? {}
      : {
          contractSemanticRevisionId:
            resolution.contractSemanticRevisionId,
        }),
    contractRevision: resolution.contractRevision,
    contractHash: resolution.contractHash,
    ...(validWorkMotion === undefined ? {} : { workMotion: validWorkMotion }),
    ...(resolution.wallClockMs === undefined
      ? {}
      : { wallClockMs: publicProgressOptionalCount(resolution.wallClockMs) }),
    ...(resolution.activeComputeMs === undefined
      ? {}
      : { activeComputeMs: publicProgressCount(resolution.activeComputeMs) }),
    ...(resolution.lastWorkerHeartbeatAt === undefined
      ? {}
      : {
          lastWorkerHeartbeatAt: publicProgressDate(
            resolution.lastWorkerHeartbeatAt,
          ),
        }),
    ...(resolution.lastProgressAt === undefined
      ? {}
      : { lastProgressAt: publicProgressDate(resolution.lastProgressAt) }),
    ...(resolution.nextRetryAt === undefined
      ? {}
      : { nextRetryAt: publicProgressDate(resolution.nextRetryAt) }),
    ...(resolution.stageDeadlineAt === undefined
      ? {}
      : { stageDeadlineAt: publicProgressDate(resolution.stageDeadlineAt) }),
    ...(resolution.selectedTrackCount === undefined
      ? {}
      : {
          selectedTrackCount: publicProgressOptionalCount(
            resolution.selectedTrackCount,
          ),
        }),
    ...(resolution.manifestedTrackCount === undefined
      ? {}
      : {
          manifestedTrackCount: publicProgressOptionalCount(
            resolution.manifestedTrackCount,
          ),
        }),
    ...(resolution.appendedTrackCount === undefined
      ? {}
      : {
          appendedTrackCount: publicProgressOptionalCount(
            resolution.appendedTrackCount,
          ),
        }),
    ...(resolution.reconciledPublishedTrackCount === undefined
      ? {}
      : {
          reconciledPublishedTrackCount: publicProgressOptionalCount(
            resolution.reconciledPublishedTrackCount,
          ),
        }),
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
  const repairReplayAction = publicRepairReplayAction(
    run.repairReplayAction,
  );
  const decisionAction = publicAdaptiveRunDecisionV1(run.decisionAction);
  const resolution = run.resolution
    ? publicRunResolutionView(
        run.resolution,
        partialAction,
        guidanceAction,
        decisionAction,
      )
    : undefined;
  const repairFenceMatchesResolution = resolution?.state === "quarantined"
    && repairReplayAction !== null
    && resolution.contractRevisionId === repairReplayAction.contractRevisionId
    && resolution.contractHash === repairReplayAction.contractSemanticHash
    && (
      resolution.generation == null
      || resolution.generation === repairReplayAction.expectedGeneration
    );
  if (resolution
    && repairReplayAction
    && repairFenceMatchesResolution) {
    // During the schema-19 compatibility shadow, the public resolution is
    // still projected from legacy status and therefore has no generation.
    // The authenticated repair receipt is loaded from the authoritative
    // resolution row, so expose that exact generation to let the browser
    // verify the same optimistic-lock fence before rendering an action.
    resolution.generation = repairReplayAction.expectedGeneration;
  }
  if (resolution
    && repairReplayAction
    && repairFenceMatchesResolution
    && (repairReplayAction.available
      || (repairReplayAction.availabilityReason === "already_started"
        && Boolean(repairReplayAction.successorBriefRequestId)))) {
    resolution.nextAction = "replay_after_repair";
  }
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
    decisionAction,
    guidanceAction,
    explore: publicExplore(run.explore),
    resolution,
    repairReplayAction,
    executionRouteReceipt: publicExecutionRouteReceipt(
      run.executionRouteReceipt,
    ),
    evidenceCoverage: publicEvidenceCoverage(run.evidenceCoverage),
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
    | "execution_decision"
    | null;
  confirmationKind?: "unresolved_review" | null;
  interpretationSummary?: PublicBriefStatusView["interpretationSummary"];
  executionAction?: PublicBriefStatusView["executionAction"];
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
    confirmationKind: input.confirmationKind,
    interpretationSummary: input.interpretationSummary,
    executionAction: input.executionAction,
    brief: input.brief,
    questions: input.questions ?? [],
    answers: input.answers,
    error: input.error,
  };
}
