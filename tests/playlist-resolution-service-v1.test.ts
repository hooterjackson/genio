import { describe, expect, test } from "vitest";
import {
  assertPlaylistResolutionCompanionsV1,
  resolutionReconcilerActionV1,
} from "../server/playlist-resolution-service-v1.ts";
import { ADAPTIVE_RUN_DECISION_SCHEMA_V1 } from "../server/adaptive-run-decision-v1.ts";
import { sha256Hex, stableStringify } from "../server/security.ts";
import type { RunDecisionActionView } from "../shared/types.ts";

const companions = {
  activeContractRevisionId: null,
  executionAttemptId: null,
  blockerId: null,
  questionSetId: null,
  decision: null,
  manifestId: null,
  incidentReference: null,
};
const contractRevisionId = "pcr1:resolution-service";
const contractSemanticHash = "a".repeat(64);
const actionableDecisionBody: Omit<
  RunDecisionActionView,
  "kind" | "decisionHash"
> = {
  contractRevisionId,
  contractSemanticHash,
  reason: "runtime_feasibility_unknown",
  targetTrackCount: 50,
  verifiedTrackCount: 0,
  remainingStrategyCount: 0,
  consumedActiveComputeMs: 0,
  activeComputeLimitMs: 900_000,
  activeComputeExtensionsUsed: 0,
  namedPredicates: [{
    clauseId: "membership:irish",
    label: "Irish music",
  }],
  interpretationSummary: {
    mustHave: ["Irish music"],
    prefer: ["Influential recordings"],
    avoid: [],
    flow: [],
    count: 50,
  },
  actions: {
    anotherBoundedPass: false,
    reviseNamedPredicate: true,
    reduceCount: false,
    publishVerifiedPartial: false,
    pause: true,
    resumeLater: false,
    cancel: true,
  },
  reachedAt: "2026-08-02T00:00:00.000Z",
};
const actionableDecision: RunDecisionActionView = {
  kind: "research_boundary",
  decisionHash: sha256Hex(stableStringify({
    schemaVersion: ADAPTIVE_RUN_DECISION_SCHEMA_V1,
    ...actionableDecisionBody,
  })),
  ...actionableDecisionBody,
};

describe("playlist resolution service", () => {
  test("requires the companion payload for every action state", () => {
    expect(() => assertPlaylistResolutionCompanionsV1({
      state: "needs_decision",
      nextAction: "review_contract",
      companions,
      stateJson: {},
    })).toThrow("resolution_decision_missing");
    expect(() => assertPlaylistResolutionCompanionsV1({
      state: "blocked_dependency",
      nextAction: "wait_for_dependency",
      companions,
      stateJson: {},
    })).toThrow("resolution_blocker_missing");
    expect(() => assertPlaylistResolutionCompanionsV1({
      state: "quarantined",
      nextAction: "contact_support",
      companions,
      stateJson: {},
    })).toThrow("resolution_incident_reference_missing");
  });

  test("requires a parsed, contract-bound, genuinely advancing decision", () => {
    const decisionCompanions = {
      ...companions,
      decision: actionableDecision as unknown as Record<string, unknown>,
    };
    expect(() => assertPlaylistResolutionCompanionsV1({
      state: "needs_decision",
      nextAction: "review_contract",
      companions: decisionCompanions,
      stateJson: {
        activeContractSemanticRevisionId: contractRevisionId,
        activeContractSemanticHash: contractSemanticHash,
      },
    })).not.toThrow();
    expect(() => assertPlaylistResolutionCompanionsV1({
      state: "needs_decision",
      nextAction: "review_contract",
      companions: {
        ...decisionCompanions,
        decision: {
          ...actionableDecision,
          actions: {
            ...actionableDecision.actions,
            reviseNamedPredicate: false,
          },
        } as unknown as Record<string, unknown>,
      },
      stateJson: {
        activeContractSemanticRevisionId: contractRevisionId,
        activeContractSemanticHash: contractSemanticHash,
      },
    })).toThrow("resolution_decision_not_actionable");
    expect(() => assertPlaylistResolutionCompanionsV1({
      state: "needs_decision",
      nextAction: "review_contract",
      companions: decisionCompanions,
      stateJson: {
        activeContractSemanticRevisionId: contractRevisionId,
        activeContractSemanticHash: "c".repeat(64),
      },
    })).toThrow("resolution_decision_not_actionable");
  });

  test("cannot describe an unapproved partial playlist as completed", () => {
    expect(() => assertPlaylistResolutionCompanionsV1({
      state: "completed",
      nextAction: "none",
      companions: { ...companions, manifestId: "manifest" },
      stateJson: {
        requestedTrackCount: 50,
        publishedTrackCount: 50,
        reconciledPublishedTrackCount: 42,
      },
    })).toThrow("resolution_exact_completion_missing");
  });

  test("permits an explicitly approved partial after exact Apple reconciliation", () => {
    expect(() => assertPlaylistResolutionCompanionsV1({
      state: "completed",
      nextAction: "none",
      companions: { ...companions, manifestId: "manifest" },
      stateJson: {
        requestedTrackCount: 50,
        reconciledPublishedTrackCount: 42,
        approvedPartialPublication: true,
        resolutionReasonCode: "approved_partial_apple_reconciliation",
      },
    })).not.toThrow();
    expect(() => assertPlaylistResolutionCompanionsV1({
      state: "completed",
      nextAction: "none",
      companions: { ...companions, manifestId: "manifest" },
      stateJson: {
        requestedTrackCount: 50,
        reconciledPublishedTrackCount: 42,
        approvedPartialPublication: true,
        resolutionReasonCode: "some_other_reason",
      },
    })).toThrow("resolution_exact_completion_missing");
  });

  test("requires an exact native Apple reconciliation for completion", () => {
    expect(() => assertPlaylistResolutionCompanionsV1({
      state: "completed",
      nextAction: "none",
      companions: { ...companions, manifestId: "manifest" },
      stateJson: {
        requestedTrackCount: 50,
        publishedTrackCount: 50,
        reconciledPublishedTrackCount: null,
      },
    })).toThrow("resolution_exact_completion_missing");
    expect(() => assertPlaylistResolutionCompanionsV1({
      state: "completed",
      nextAction: "none",
      companions: { ...companions, manifestId: "manifest" },
      stateJson: {
        requestedTrackCount: 50,
        reconciledPublishedTrackCount: 50,
      },
    })).not.toThrow();
  });

  test("rejects browser actions that do not match the resolution state", () => {
    expect(() => assertPlaylistResolutionCompanionsV1({
      state: "accepted",
      nextAction: "review_contract",
      companions,
      stateJson: {},
    })).toThrow("resolution_state_action_mismatch");
    expect(() => assertPlaylistResolutionCompanionsV1({
      state: "quarantined",
      nextAction: "none",
      companions: { ...companions, incidentReference: "incident:1" },
      stateJson: {},
    })).toThrow("resolution_state_action_mismatch");
  });

  test("bounds reconciler repairs and never invents decisions", () => {
    expect(resolutionReconcilerActionV1({
      state: "accepted",
      hasExecutableJob: false,
      hasVerifiedExpiredCheckpoint: false,
      dependencyWakeDue: false,
      companionPayloadValid: true,
      priorRepairCount: 0,
    })).toBe("enqueue_missing_work");
    expect(resolutionReconcilerActionV1({
      state: "needs_decision",
      hasExecutableJob: false,
      hasVerifiedExpiredCheckpoint: false,
      dependencyWakeDue: false,
      companionPayloadValid: true,
      priorRepairCount: 0,
    })).toBe("none");
    expect(resolutionReconcilerActionV1({
      state: "executing",
      hasExecutableJob: false,
      hasVerifiedExpiredCheckpoint: true,
      dependencyWakeDue: false,
      companionPayloadValid: true,
      priorRepairCount: 3,
    })).toBe("quarantine");
  });
});
