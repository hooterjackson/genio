import { describe, expect, it } from "vitest";
import {
  actionRequiredJobLabel,
  apiErrorCode,
  briefExecutionDecisionDisposition,
  evidenceCountSummary,
  partialDecisionHeading,
  partialDecisionSummary,
  partialReadyView,
  publishedTrackCountSummary,
  publishedResultHeading,
  runEvidenceDisplayCounts,
  runExecutionRouteAuthorityIssue,
  runResolutionControls,
  shouldKeepPollingBlockedRun,
  shouldPresentShortfallWithoutError,
  shouldQuietlyClearInitialRunRestore,
} from "../app/playlist-builder-ui-policy.ts";

const validRouteReceipt = {
  version: "execution_route_receipt_v1",
  executionRoute: "corpus_first_v3",
  receiptHash: "a".repeat(64),
  executorConfigurationHash: "b".repeat(64),
};

describe("run route authority and truthful display counts", () => {
  it("accepts a matching immutable execution route receipt", () => {
    expect(runExecutionRouteAuthorityIssue({
      status: "researching",
      pipelineVersion: "corpus_first_v3",
      executionRouteReceipt: validRouteReceipt,
    })).toBeNull();
  });

  it("fails active corpus-first work closed when its route receipt is missing", () => {
    const run = {
      status: "researching",
      pipelineVersion: "corpus_first_v3",
      resolution: {
        state: "executing",
        nextAction: "none",
        terminal: false,
      },
    };
    expect(runExecutionRouteAuthorityIssue(run))
      .toBe("missing_execution_route_receipt");
    expect(runResolutionControls(run)).toEqual([
      "contact_support",
      "cancel_job",
    ]);
  });

  it("fails a contradictory route receipt closed even when work claims to be live", () => {
    const run = {
      status: "researching",
      pipelineVersion: "catalog_first_v2",
      executionRouteReceipt: validRouteReceipt,
      resolution: {
        state: "executing",
        nextAction: "none",
        terminal: false,
      },
    };
    expect(runExecutionRouteAuthorityIssue(run))
      .toBe("execution_route_mismatch");
    expect(runResolutionControls(run)).toEqual([
      "contact_support",
      "cancel_job",
    ]);
  });

  it("keeps a terminal legacy corpus-first result readable without inventing a receipt", () => {
    expect(runExecutionRouteAuthorityIssue({
      status: "complete",
      pipelineVersion: "corpus_first_v3",
      executionRouteReceipt: null,
      resolution: {
        state: "completed",
        nextAction: "none",
        terminal: true,
      },
    })).toBeNull();
  });

  it("does not inflate unique leads or candidates with cumulative observations", () => {
    expect(runEvidenceDisplayCounts({
      sourceCount: 1_005,
      candidateCount: 1_005,
      evidenceCoverage: {
        observationCount: 1_005,
        uniqueLeadCount: 189,
        materializedCandidateCount: 77,
      },
    })).toEqual({
      observationCount: 1_005,
      uniqueLeadCount: 189,
      materializedCandidateCount: 77,
    });
  });
});

describe("brief execution-decision browser policy", () => {
  const action = {
    decisionHash: "a".repeat(64),
    actionHash: "b".repeat(64),
  };

  it("returns Review to the editor without polling or starting research", () => {
    expect(briefExecutionDecisionDisposition({
      status: "review_required",
      executionAction: {
        ...action,
        optionId: "review_interpretation",
        kind: "review_interpretation",
        startsResearch: false,
      },
    })).toBe("review");
  });

  it("renders a durable cancelled outcome without polling or starting research", () => {
    expect(briefExecutionDecisionDisposition({
      status: "cancelled",
      executionAction: {
        ...action,
        optionId: "cancel_request",
        kind: "cancel_request",
        startsResearch: false,
      },
    })).toBe("cancelled");
  });

  it("permits research only for the matching explicit execute action", () => {
    expect(briefExecutionDecisionDisposition({
      status: "finalizing",
      executionAction: {
        ...action,
        optionId: "execute_confirmed_contract",
        kind: "execute_confirmed_contract",
        startsResearch: true,
      },
    })).toBe("execute");
    expect(briefExecutionDecisionDisposition({
      status: "finalizing",
      executionAction: {
        ...action,
        optionId: "cancel_request",
        kind: "cancel_request",
        startsResearch: false,
      },
    })).toBeNull();
  });
});

describe("initial run restoration", () => {
  it("quietly clears a stale or inaccessible run only during initial run restoration", () => {
    for (const status of [400, 401, 404, 410]) {
      expect(shouldQuietlyClearInitialRunRestore({ hasRunId: true, status })).toBe(true);
    }
    expect(shouldQuietlyClearInitialRunRestore({
      hasRunId: true,
      status: 403,
      code: "capability_scope_mismatch",
    })).toBe(true);
  });

  it("preserves unrelated and explicit-operation errors", () => {
    expect(shouldQuietlyClearInitialRunRestore({
      hasRunId: false,
      status: 403,
      code: "capability_scope_mismatch",
    })).toBe(false);
    expect(shouldQuietlyClearInitialRunRestore({
      hasRunId: true,
      status: 403,
      code: "forbidden",
    })).toBe(false);
    expect(shouldQuietlyClearInitialRunRestore({ hasRunId: true, status: 500 })).toBe(false);
  });

  it("reads top-level and nested API error codes", () => {
    expect(apiErrorCode({ code: "capability_scope_mismatch" })).toBe("capability_scope_mismatch");
    expect(apiErrorCode({ error: { code: "capability_scope_mismatch" } })).toBe("capability_scope_mismatch");
    expect(apiErrorCode({ error: "not found" })).toBeNull();
  });
});

describe("published playlist result copy", () => {
  it("foregrounds the exact published track count", () => {
    expect(publishedTrackCountSummary(50, 50)).toBe("50 tracks published.");
    expect(publishedTrackCountSummary(1, 1)).toBe("1 track published.");
  });

  it("states a partial result against the requested count", () => {
    expect(publishedTrackCountSummary(23, 50)).toBe("23 of 50 requested tracks published.");
    expect(publishedTrackCountSummary(1, 50)).toBe("1 of 50 requested tracks published.");
  });

  it("keeps evidence counts separate and explicitly labeled", () => {
    expect(evidenceCountSummary(8, 0)).toBe("Evidence: 8 documented sources; 0 open gaps.");
    expect(evidenceCountSummary(1, 1)).toBe("Evidence: 1 documented source; 1 open gap.");
  });

  it("never describes an empty partial result as a published playlist", () => {
    expect(publishedResultHeading(0, true)).toBe("No compatible tracks found");
    expect(publishedResultHeading(23, true)).toBe("Playlist published with gaps");
    expect(publishedResultHeading(50, false)).toBe("Playlist published");
  });
});

describe("Pipeline V3 partial publication decisions", () => {
  it("adapts the preferred partialAction payload into a durable decision", () => {
    const run = {
      status: "partial_ready",
      partialAction: {
        kind: "partial_publication",
        targetTrackCount: 50,
        qualifiedTrackCount: 37,
        remainingStrategyCount: 2,
        canContinueResearch: true,
        reasonCode: "partial_evidence_shortfall",
        outcomeHash: "outcome-37",
        manifestId: "manifest-37",
        manifestHash: "manifest-hash-37",
      },
    };

    expect(partialReadyView(run)).toEqual({
      targetTrackCount: 50,
      qualifiedTrackCount: 37,
      deficit: 13,
      remainingStrategyCount: 2,
      canContinueResearch: true,
      outcomeVersion: null,
      outcomeHash: "outcome-37",
      manifestId: "manifest-37",
      manifestHash: "manifest-hash-37",
      reasonCode: "partial_evidence_shortfall",
    });
    expect(actionRequiredJobLabel(run)).toBe("ACTION NEEDED");
    expect(shouldPresentShortfallWithoutError(run)).toBe(true);
  });

  it("adapts a zero-compatible outcome and disables unsupported continuation by default", () => {
    expect(partialReadyView({
      status: "no_compatible_tracks",
      pipelineOutcome: {
        status: "no_compatible_tracks",
        targetTrackCount: 25,
        qualifiedTrackCount: 0,
      },
    })).toMatchObject({
      targetTrackCount: 25,
      qualifiedTrackCount: 0,
      deficit: 25,
      canContinueResearch: false,
    });
    expect(partialDecisionHeading(0)).toBe("No verified tracks are ready yet");
    expect(partialDecisionSummary(0, 25)).toContain("has not found a safe Apple Music match");
  });

  it("does not reinterpret a legacy review state as an action-required shortfall", () => {
    expect(partialReadyView({
      status: "visitor_review",
      phase: "partial_confirmation",
      pipelineVersion: "pipeline_v2",
      pipelineOutcome: { targetTrackCount: 50, qualifiedTrackCount: 12 },
    })).toBeNull();
  });

  it("recognizes the persisted corpus-first V3 pipeline during the compatibility bridge", () => {
    expect(partialReadyView({
      status: "visitor_review",
      phase: "partial_confirmation_required",
      pipelineVersion: "corpus_first_v3",
      pipelineOutcome: { targetTrackCount: 100, selectedTrackCount: 84 },
    })).toMatchObject({
      targetTrackCount: 100,
      qualifiedTrackCount: 84,
      deficit: 16,
    });
  });

  it("does not reuse retained partial consent as an action after publication handoff", () => {
    const retainedAction = {
      kind: "partial_publication",
      targetTrackCount: 25,
      qualifiedTrackCount: 20,
      remainingStrategyCount: 0,
      canContinueResearch: false,
      outcomeHash: "a".repeat(64),
    };
    for (const status of [
      "manifest_ready",
      "publishing",
      "waiting_for_apple_authorization",
      "complete",
      "partial",
    ]) {
      expect(partialReadyView({
        status,
        partialAction: retainedAction,
      })).toBeNull();
    }
  });

  it("keeps typed completeness shortfalls out of the red error treatment", () => {
    expect(shouldPresentShortfallWithoutError({
      status: "partial",
      pipelineOutcome: { status: "partial_timed_out" },
    })).toBe(true);
    expect(shouldPresentShortfallWithoutError({
      status: "failed",
      pipelineOutcome: { status: "failed_system" },
    })).toBe(false);
    expect(partialDecisionHeading(1)).toBe("1 verified track is ready");
    expect(partialDecisionHeading(8)).toBe("8 verified tracks are ready");
  });
});

describe("never-dead-end run controls", () => {
  it("keeps dependency recovery automatic without implying that prompt revision repairs an outage", () => {
    const run = {
      status: "failed_system",
      resolution: {
        state: "blocked_dependency",
        nextAction: "wait_for_dependency",
        terminal: false,
        blocker: {
          kind: "provider",
          nextRetryAt: "2026-07-23T12:00:00.000Z",
        },
      },
    };
    expect(runResolutionControls(run)).toEqual([
      "wait_for_retry",
      "cancel_job",
    ]);
    expect(shouldKeepPollingBlockedRun(run)).toBe(true);
  });

  it("routes durable quarantine to a real support link without polling forever", () => {
    const run = {
      status: "failed_integrity",
      resolution: {
        state: "quarantined",
        nextAction: "contact_support",
        terminal: false,
      },
    };
    expect(runResolutionControls(run)).toEqual([
      "contact_support",
      "cancel_job",
    ]);
    expect(shouldKeepPollingBlockedRun(run)).toBe(false);
  });

  it("keeps polling a provisional quarantine emitted during an active handoff", () => {
    const run = {
      status: "publishing",
      resolution: {
        state: "quarantined",
        nextAction: "contact_support",
        terminal: false,
      },
    };
    expect(shouldKeepPollingBlockedRun(run)).toBe(true);
    expect(shouldKeepPollingBlockedRun({
      ...run,
      resolution: {
        ...run.resolution,
        terminal: true,
      },
    })).toBe(false);
  });

  it("offers a clean replay only with the complete immutable repair fence", () => {
    const eligible = {
      status: "failed_integrity",
      repairReplayAction: {
        kind: "repair_replay",
        expectedGeneration: 4,
        incidentReference: "incident:technical:4",
        contractRevisionId: "contract-revision-id",
        contractSemanticHash: "a".repeat(64),
        available: true,
        availabilityReason: "ready",
        resultReuse: false,
        autoPublication: false,
      },
      resolution: {
        generation: 4,
        state: "quarantined",
        nextAction: "replay_after_repair",
        terminal: false,
        contractRevisionId: "contract-revision-id",
        contractHash: "a".repeat(64),
      },
    };
    expect(runResolutionControls(eligible)).toEqual([
      "replay_after_repair",
      "cancel_job",
    ]);
    expect(runResolutionControls({
      ...eligible,
      repairReplayAction: {
        ...eligible.repairReplayAction,
        autoPublication: true,
      },
    })).toEqual(["contact_support", "cancel_job"]);
    expect(runResolutionControls({
      ...eligible,
      resolution: {
        ...eligible.resolution,
        generation: 5,
      },
    })).toEqual(["contact_support", "cancel_job"]);
    expect(runResolutionControls({
      ...eligible,
      repairReplayAction: null,
    })).toEqual(["contact_support", "cancel_job"]);
  });

  it("shows the incident repair path while a repaired build is pending", () => {
    const pending = {
      status: "failed_integrity",
      repairReplayAction: {
        kind: "repair_replay",
        expectedGeneration: 4,
        incidentReference: "incident:evidence-binding",
        contractRevisionId: "contract-revision-id",
        contractSemanticHash: "a".repeat(64),
        available: false,
        availabilityReason: "repair_pending",
        resultReuse: false,
        autoPublication: false,
      },
      resolution: {
        generation: 4,
        state: "quarantined",
        nextAction: "contact_support",
        terminal: false,
        contractRevisionId: "contract-revision-id",
        contractHash: "a".repeat(64),
      },
    };
    expect(runResolutionControls(pending)).toEqual([
      "repair_pending",
      "contact_support",
      "cancel_job",
    ]);
    expect(runResolutionControls({
      ...pending,
      repairReplayAction: {
        ...pending.repairReplayAction,
        availabilityReason: "route_paused",
      },
    })).toEqual([
      "repair_pending",
      "contact_support",
      "cancel_job",
    ]);
  });

  it("continues the single already-created planning successor", () => {
    expect(runResolutionControls({
      status: "failed_integrity",
      repairReplayAction: {
        kind: "repair_replay",
        expectedGeneration: 4,
        incidentReference: "incident:evidence-binding",
        contractRevisionId: "contract-revision-id",
        contractSemanticHash: "a".repeat(64),
        available: false,
        availabilityReason: "already_started",
        successorBriefRequestId:
          "00000000-0000-4000-8000-000000000004",
        resultReuse: false,
        autoPublication: false,
      },
      resolution: {
        generation: 4,
        state: "quarantined",
        nextAction: "contact_support",
        terminal: false,
        contractRevisionId: "contract-revision-id",
        contractHash: "a".repeat(64),
      },
    })).toEqual(["continue_repair", "cancel_job"]);
  });

  it("offers Resume later only for a hash-bound retained dependency decision", () => {
    const eligible = {
      status: "needs_decision",
      phase: "dependency_retry_window_expired",
      decisionAction: {
        reason: "dependency_retry_window_expired",
        decisionHash: "a".repeat(64),
        actions: { resumeLater: true },
      },
      resolution: {
        state: "needs_decision",
        nextAction: "resume_research",
        terminal: false,
        blocker: {
          kind: "provider",
          nextRetryAt: null,
          automaticRetryUntil: "2026-07-24T12:00:00.000Z",
          versionHash: "b".repeat(64),
        },
      },
    };
    expect(runResolutionControls(eligible)).toEqual([
      "resume_dependency",
      "cancel_job",
    ]);
    expect(runResolutionControls({
      ...eligible,
      resolution: {
        ...eligible.resolution,
        blocker: {
          ...eligible.resolution.blocker,
          versionHash: null,
        },
      },
    })).toEqual(["contact_support", "cancel_job"]);
    expect(runResolutionControls({
      ...eligible,
      resolution: {
        ...eligible.resolution,
        blocker: {
          ...eligible.resolution.blocker,
          kind: "scope_decision",
        },
      },
    })).toEqual(["contact_support", "cancel_job"]);
  });

  it("does not expose a fake user repair when the signed partial decision is absent", () => {
    expect(runResolutionControls({
      status: "partial_ready",
      resolution: {
        state: "needs_decision",
        nextAction: "decide_verified_partial",
        terminal: false,
      },
    })).toEqual(["contact_support", "cancel_job"]);
  });

  it("offers contract refinement only when a signed decision contains a supported advancing action", () => {
    expect(runResolutionControls({
      status: "needs_decision",
      decisionAction: {
        decisionHash: "c".repeat(64),
        actions: { reviseNamedPredicate: true },
      },
      resolution: {
        state: "needs_decision",
        nextAction: "review_contract",
        terminal: false,
      },
    })).toEqual(["refine_request", "cancel_job"]);
    expect(runResolutionControls({
      status: "needs_decision",
      resolution: {
        state: "needs_decision",
        nextAction: "review_contract",
        terminal: false,
      },
    })).toEqual(["contact_support", "cancel_job"]);
  });

  it("leaves a valid explicit partial decision to the dedicated decision screen", () => {
    expect(runResolutionControls({
      status: "partial_ready",
      partialAction: {
        kind: "partial_publication",
        targetTrackCount: 50,
        qualifiedTrackCount: 42,
        remainingStrategyCount: 1,
        canContinueResearch: true,
        outcomeVersion: 2,
        outcomeHash: "a".repeat(64),
      },
      resolution: {
        state: "needs_decision",
        nextAction: "decide_verified_partial",
        terminal: false,
      },
    })).toEqual([]);
  });
});
