import { describe, expect, it } from "vitest";
import {
  actionRequiredJobLabel,
  apiErrorCode,
  evidenceCountSummary,
  partialDecisionHeading,
  partialDecisionSummary,
  partialReadyView,
  publishedTrackCountSummary,
  publishedResultHeading,
  runResolutionControls,
  shouldKeepPollingBlockedRun,
  shouldPresentShortfallWithoutError,
  shouldQuietlyClearInitialRunRestore,
} from "../app/playlist-builder-ui-policy.ts";

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
  it("keeps dependency recovery automatic while exposing revision and cancellation exits", () => {
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
      "refine_request",
      "cancel_job",
    ]);
    expect(shouldKeepPollingBlockedRun(run)).toBe(true);
  });

  it("routes quarantine to a real support link and retains safe exits", () => {
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
      "refine_request",
      "cancel_job",
    ]);
    expect(shouldKeepPollingBlockedRun(run)).toBe(false);
  });

  it("does not expose a fake partial action when the signed decision is absent", () => {
    expect(runResolutionControls({
      status: "partial_ready",
      resolution: {
        state: "needs_decision",
        nextAction: "decide_verified_partial",
        terminal: false,
      },
    })).toEqual(["refine_request", "cancel_job"]);
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
