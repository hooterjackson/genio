import { describe, expect, test } from "vitest";
import {
  assertPlaylistResolutionCompanionsV1,
  resolutionReconcilerActionV1,
} from "../server/playlist-resolution-service-v1.ts";

const companions = {
  activeContractRevisionId: null,
  executionAttemptId: null,
  blockerId: null,
  questionSetId: null,
  decision: null,
  manifestId: null,
  incidentReference: null,
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

  test("cannot describe a partial playlist as completed", () => {
    expect(() => assertPlaylistResolutionCompanionsV1({
      state: "completed",
      nextAction: "none",
      companions: { ...companions, manifestId: "manifest" },
      stateJson: { requestedTrackCount: 50, publishedTrackCount: 42 },
    })).toThrow("resolution_exact_completion_missing");
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
