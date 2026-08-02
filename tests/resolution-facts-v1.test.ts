import { describe, expect, test } from "vitest";
import {
  reduceResolutionFactsV1,
  type ResolutionFactsV1,
} from "../server/resolution-facts-v1.ts";
import type { RunDecisionActionView } from "../shared/types.ts";

const contractRevisionId = "pcr1:resolution-facts";
const contractSemanticHash = "a".repeat(64);

function decision(
  actions: Partial<RunDecisionActionView["actions"]> = {},
): RunDecisionActionView {
  return {
    kind: "research_boundary",
    decisionHash: "b".repeat(64),
    contractRevisionId,
    contractSemanticHash,
    reason: "runtime_feasibility_unknown",
    targetTrackCount: 50,
    verifiedTrackCount: 0,
    remainingStrategyCount: 0,
    consumedActiveComputeMs: 0,
    activeComputeLimitMs: 900_000,
    activeComputeExtensionsUsed: 0,
    namedPredicates: [],
    interpretationSummary: {
      mustHave: [],
      prefer: [],
      avoid: [],
      flow: [],
      count: 50,
    },
    actions: {
      anotherBoundedPass: false,
      reviseNamedPredicate: false,
      reduceCount: false,
      publishVerifiedPartial: false,
      pause: true,
      resumeLater: false,
      cancel: true,
      ...actions,
    },
    reachedAt: "2026-08-02T00:00:00.000Z",
  };
}

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
    approvedPartialPublication: false,
    workMotion: "running",
    integrityIncident: false,
    cancellationRequested: false,
    activeContractSemanticRevisionId: contractRevisionId,
    activeContractSemanticHash: contractSemanticHash,
    decision: null,
    verifiedPartialDecisionAvailable: false,
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
      state: "quarantined",
      nextAction: "contact_support",
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

  test("completes an explicitly approved partial only after exact Apple reconciliation", () => {
    const manifestId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    expect(reduceResolutionFactsV1(facts({
      legacyStatus: "partial",
      manifestId,
      requestedTrackCount: 25,
      reconciledPublishedTrackCount: 20,
      exactAppleReconciliation: true,
      approvedPartialPublication: false,
      workMotion: "none",
    }))).toMatchObject({
      state: "quarantined",
      nextAction: "contact_support",
    });
    expect(reduceResolutionFactsV1(facts({
      legacyStatus: "partial",
      manifestId,
      requestedTrackCount: 25,
      reconciledPublishedTrackCount: 20,
      exactAppleReconciliation: false,
      approvedPartialPublication: true,
      workMotion: "none",
    }))).toMatchObject({
      state: "quarantined",
      nextAction: "contact_support",
    });
    expect(reduceResolutionFactsV1(facts({
      legacyStatus: "partial",
      manifestId,
      requestedTrackCount: 25,
      reconciledPublishedTrackCount: 20,
      exactAppleReconciliation: true,
      approvedPartialPublication: true,
      workMotion: "none",
    }))).toMatchObject({
      state: "completed",
      nextAction: "none",
      reasonCode: "approved_partial_apple_reconciliation",
      incidentRequired: false,
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
      decision: decision({ reviseNamedPredicate: true }),
    }))).toMatchObject({
      state: "needs_decision",
      nextAction: "review_contract",
      reasonCode: "explicit_bound_user_decision_required",
    });
  });

  test("quarantines a decision that still has nonquiescent work", () => {
    expect(reduceResolutionFactsV1(facts({
      legacyStatus: "needs_decision",
      decision: decision({ anotherBoundedPass: true }),
      workMotion: "retry_scheduled",
    }))).toMatchObject({
      state: "quarantined",
      reasonCode: "decision_state_has_nonquiescent_work",
    });
  });

  test("requires a contract-bound decision with a genuinely advancing action", () => {
    expect(reduceResolutionFactsV1(facts({
      legacyStatus: "needs_decision",
      workMotion: "none",
      decision: decision(),
    }))).toMatchObject({
      state: "quarantined",
      nextAction: "contact_support",
      reasonCode: "decision_missing_advancing_contract_action",
    });
    expect(reduceResolutionFactsV1(facts({
      legacyStatus: "needs_decision",
      workMotion: "none",
      activeContractSemanticHash: "c".repeat(64),
      decision: decision({ reviseNamedPredicate: true }),
    }))).toMatchObject({
      state: "quarantined",
      reasonCode: "decision_missing_advancing_contract_action",
    });
    expect(reduceResolutionFactsV1(facts({
      legacyStatus: "needs_decision",
      workMotion: "none",
      decision: decision({ reviseNamedPredicate: true }),
    }))).toMatchObject({
      state: "needs_decision",
      nextAction: "review_contract",
    });
  });

  test("only fresh fenced running work renders executing", () => {
    expect(reduceResolutionFactsV1(facts({
      workMotion: "running",
    }))).toMatchObject({
      state: "executing",
      nextAction: "none",
    });
    for (const workMotion of [
      "retry_scheduled",
      "paused",
      "stalled",
    ] as const) {
      expect(reduceResolutionFactsV1(facts({
        workMotion,
      }))).toMatchObject({
        state: "quarantined",
        nextAction: "contact_support",
        reasonCode: `work_${workMotion}_without_actionable_blocker`,
      });
    }
  });

  test("does not present paused, retrying, or stalled publication as active", () => {
    for (const workMotion of [
      "retry_scheduled",
      "paused",
      "stalled",
    ] as const) {
      expect(reduceResolutionFactsV1(facts({
        legacyStatus: "publishing",
        manifestId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        workMotion,
      }))).toMatchObject({
        state: "quarantined",
        nextAction: "contact_support",
        reasonCode: `work_${workMotion}_without_actionable_blocker`,
      });
    }
  });

  test("ignores a retained decision checkpoint after publication starts", () => {
    expect(reduceResolutionFactsV1(facts({
      legacyStatus: "publishing",
      legacyPhase: "publication_queued",
      manifestId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      decision: decision({ reviseNamedPredicate: true }),
      workMotion: "none",
    }))).toMatchObject({
      state: "publishing",
      nextAction: "none",
      reasonCode: "publication_in_progress",
    });
  });

  test("offers only manifest-bound verified partial consent", () => {
    expect(reduceResolutionFactsV1(facts({
      legacyStatus: "partial_ready",
      manifestId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      workMotion: "none",
      verifiedPartialDecisionAvailable: true,
    }))).toMatchObject({
      state: "needs_decision",
      nextAction: "decide_verified_partial",
      reasonCode: "verified_partial_consent_required",
    });
    expect(reduceResolutionFactsV1(facts({
      legacyStatus: "partial_ready",
      manifestId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      workMotion: "none",
      verifiedPartialDecisionAvailable: false,
    }))).toMatchObject({
      state: "quarantined",
      nextAction: "contact_support",
      reasonCode: "partial_ready_missing_verified_manifest_proof",
    });
  });
});
