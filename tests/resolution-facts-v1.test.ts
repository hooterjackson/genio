import { describe, expect, test } from "vitest";
import {
  reduceResolutionFactsV1,
  type ResolutionFactsV1,
} from "../server/resolution-facts-v1.ts";

function facts(
  overrides: Partial<ResolutionFactsV1> = {},
): ResolutionFactsV1 {
  return {
    legacyStatus: "researching",
    legacyPhase: "research",
    blockerKind: null,
    blockerId: null,
    questionSetId: null,
    manifestId: null,
    requestedTrackCount: 50,
    reconciledPublishedTrackCount: null,
    exactAppleReconciliation: false,
    workMotion: "running",
    integrityIncident: false,
    cancellationRequested: false,
    decisionAvailable: false,
    ...overrides,
  };
}

describe("ResolutionFactsV1", () => {
  test("never allows progress or legacy complete to outrank integrity", () => {
    expect(reduceResolutionFactsV1(facts({
      legacyStatus: "complete",
      manifestId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      reconciledPublishedTrackCount: 50,
      exactAppleReconciliation: true,
      integrityIncident: true,
      workMotion: "none",
    }))).toMatchObject({
      state: "quarantined",
      reasonCode: "active_integrity_incident",
    });
  });

  test("requires exact ordered Apple reconciliation for completion", () => {
    const manifestId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    expect(reduceResolutionFactsV1(facts({
      legacyStatus: "complete",
      manifestId,
      reconciledPublishedTrackCount: 50,
      exactAppleReconciliation: false,
      workMotion: "none",
    }))).toMatchObject({
      state: "needs_decision",
      reasonCode: "legacy_completion_missing_exact_apple_reconciliation",
    });
    expect(reduceResolutionFactsV1(facts({
      legacyStatus: "complete",
      manifestId,
      reconciledPublishedTrackCount: 50,
      exactAppleReconciliation: true,
      workMotion: "none",
    }))).toMatchObject({
      state: "completed",
      reasonCode: "exact_apple_reconciliation",
    });
  });

  test("keeps cancellation distinct while retaining Apple side effects", () => {
    expect(reduceResolutionFactsV1(facts({
      legacyStatus: "cancelled",
      cancellationRequested: true,
      reconciledPublishedTrackCount: 3,
      workMotion: "none",
    }))).toMatchObject({
      state: "cancelled",
      observedAppleSideEffect: true,
      incidentRequired: true,
    });
  });

  test("provider and local-budget failures cannot become scarcity", () => {
    expect(reduceResolutionFactsV1(facts({
      legacyStatus: "no_compatible_tracks",
      blockerKind: "provider",
      blockerId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      workMotion: "waiting_dependency",
    }))).toMatchObject({
      state: "blocked_dependency",
      nextAction: "wait_for_dependency",
    });
    expect(reduceResolutionFactsV1(facts({
      legacyStatus: "no_compatible_tracks",
      blockerKind: "budget",
      blockerId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      workMotion: "none",
    }))).toMatchObject({
      state: "needs_decision",
      reasonCode: "compatibility_or_scarcity_decision_required",
    });
  });

  test("quarantines a decision that still has executable work", () => {
    expect(reduceResolutionFactsV1(facts({
      legacyStatus: "needs_decision",
      decisionAvailable: true,
      workMotion: "retry_scheduled",
    }))).toMatchObject({
      state: "quarantined",
      reasonCode: "decision_state_has_executable_work",
    });
  });
});
