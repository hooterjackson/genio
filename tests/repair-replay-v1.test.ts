import { describe, expect, it } from "vitest";
import {
  canonicalRepairReplayEligibilityV1,
} from "../server/repository.ts";

const eligible = {
  resolutionState: "quarantined",
  runStatus: "failed_integrity",
  runPhase: "canonical_integrity_quarantine",
  blockerKind: "integrity",
  reasonCode: "qualification_candidate_binding_missing",
  contractVersion: 3,
  contractStatus: "active",
  publicAssignmentActive: true,
  hasPublishedReconciliation: false,
};

describe("repair replay v1 eligibility", () => {
  it("admits only an unpublished, active Contract-3 technical quarantine", () => {
    expect(canonicalRepairReplayEligibilityV1(eligible)).toEqual({
      eligible: true,
    });
  });

  it("admits the receipt-backed v2.5.4 quarantine without inventing a blocker", () => {
    expect(canonicalRepairReplayEligibilityV1({
      ...eligible,
      runPhase: "v254_evidence_persistence_quarantined",
      blockerKind: null,
      reasonCode: null,
    })).toEqual({ eligible: true });
  });

  it.each([
    ["not quarantined", { resolutionState: "needs_decision" }],
    ["legacy contract", { contractVersion: 2 }],
    ["superseded contract", { contractStatus: "superseded" }],
    ["unsigned route", { publicAssignmentActive: false }],
    ["already published", { hasPublishedReconciliation: true }],
    ["provider outage", {
      runPhase: "dependency_retry_window_expired",
      blockerKind: "provider",
      reasonCode: "provider_timeout",
    }],
    ["user ambiguity", {
      runPhase: "interpretation_summary_required",
      blockerKind: "scope_decision",
      reasonCode: "user_scope_ambiguity",
    }],
    ["untyped quarantine without a blocker", {
      runPhase: "unknown_quarantine",
      blockerKind: null,
      reasonCode: null,
    }],
  ])("rejects %s", (_label, patch) => {
    expect(canonicalRepairReplayEligibilityV1({
      ...eligible,
      ...patch,
    }).eligible).toBe(false);
  });
});
