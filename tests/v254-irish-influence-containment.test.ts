import { describe, expect, test } from "vitest";
import {
  evaluateV254IrishInfluenceContainment,
  evaluateV254OwnerReviewPromotionGate,
  v254OwnerReviewInventoryRowHash,
  v254OwnerReviewRunIdHash,
  V254_CONTAINMENT_INTENT,
  V254_CONTAINMENT_ROUTE,
} from "../scripts/v254-irish-influence-containment.ts";
import {
  V254_IRISH_INFLUENCE_SYNTHETIC_BINDING,
} from "../scripts/v254-irish-influence-protected-binding.ts";

const incidentRunId = V254_IRISH_INFLUENCE_SYNTHETIC_BINDING.runId;
const incidentAccessId = V254_IRISH_INFLUENCE_SYNTHETIC_BINDING.accessId;
const contractRevisionId =
  V254_IRISH_INFLUENCE_SYNTHETIC_BINDING.contractRevisionId;
const executionAttemptId =
  V254_IRISH_INFLUENCE_SYNTHETIC_BINDING.executionAttemptId;
const blockerId = V254_IRISH_INFLUENCE_SYNTHETIC_BINDING.blockerId;
const incidentReference = "v254-irish-influence-evidence-persistence";

function affectedRow(runId: string) {
  return {
    run_id: runId,
    run_status: "needs_decision",
    run_phase: "capability_evidence_coverage_audit",
    contract_revision_id: contractRevisionId,
    execution_attempt_id: executionAttemptId,
    resolution_generation: 3,
    resolution_state: "needs_decision",
    resolution_incident_reference: null as string | null,
    containment_receipt_hash: null as string | null,
    active_job_count: runId === incidentRunId ? 0 : 2,
    active_publication_job_count: 0,
    unresolved_publication_work_count: 0,
    reconciliation_count: 0,
    apple_side_effect_count: 0,
  };
}

function observed() {
  return {
    run: {
      access_id: incidentAccessId,
      run_id: incidentRunId,
      status: "needs_decision",
      phase: "capability_evidence_coverage_audit",
      pipeline_version: V254_CONTAINMENT_ROUTE,
      active_contract_revision_id: contractRevisionId,
    },
    resolution: {
      generation: 3,
      state: "needs_decision",
      next_action: "review_contract",
      execution_attempt_id: executionAttemptId,
      blocker_id: blockerId as string | null,
      manifest_id: null,
      incident_reference: null as string | null,
      containment_receipt_hash: null as string | null,
    },
    activeJobs: [],
    counts: {
      observation_count: 77,
      null_candidate_count: 77,
      candidate_count: 0,
      manifest_count: 0,
      reconciliation_count: 0,
      apple_side_effect_count: 0,
    },
    sameSignature: [affectedRow(incidentRunId)],
    reviewInventory: [
      affectedRow("11111111-1111-4111-8111-111111111111"),
    ],
    ownerReviewDispositions: [],
    switch: {
      cohort_key: "v254-irish-influence-containment",
      route: V254_CONTAINMENT_ROUTE,
      intent_group: V254_CONTAINMENT_INTENT,
      disabled: true,
      reason_code: "v254_evidence_persistence_containment",
    },
    pauses: [
      { key: "publishing_paused", value: "true" },
      { key: "research_paused", value: "true" },
    ],
    assignmentPauses: [
      { key: "pipeline_v3_public_assignment_paused", value: "true" },
      {
        key: "pipeline_v3_public_assignment_paused:editorial_influence",
        value: "true",
      },
    ],
  };
}

describe("v2.5.4 Irish-influence containment", () => {
  test("contains only the exact incident but blocks promotion on an unreviewed near match", () => {
    const result = evaluateV254IrishInfluenceContainment(observed());
    expect(result.safeToApply).toBe(true);
    expect(result.alreadyApplied).toBe(false);
    expect(result.receipt.observed.sameSignature).toHaveLength(1);
    expect(result.receipt.observed.reviewInventory).toHaveLength(1);
    expect(result.ownerReviewPromotionProof).toMatchObject({
      candidateCount: 1,
      dispositionCount: 0,
      undispositionedCount: 1,
      unresolvedExecutableWorkCount: 2,
      unresolvedPublicationWorkCount: 0,
      promotionSafe: false,
    });
    expect(result.receiptHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("accepts an explicit auditable owner disposition only when no work remains", () => {
    const row = {
      ...affectedRow("11111111-1111-4111-8111-111111111111"),
      active_job_count: 0,
    };
    const audit = {
      run_id: row.run_id,
      actor: "owner_authorized",
      occurred_at: "2026-08-02 00:00:00+00",
      detail_json: {
        schemaVersion: "genio-v254-owner-review-disposition/v1",
        incidentReference: incidentReference,
        route: V254_CONTAINMENT_ROUTE,
        intentGroup: V254_CONTAINMENT_INTENT,
        releaseRevision:
          "c5d76e9e84b6982826fcce462b049d3c05925f3b",
        semanticConfigurationHash:
          "3cad6fd7dd046292c5f19d2e19eff41422e3c5e1288639f6545ca4e7a04fa922",
        runIdHash: v254OwnerReviewRunIdHash(row.run_id),
        inventoryRowHash: v254OwnerReviewInventoryRowHash(row),
        disposition: "hold_immutable_no_execution",
        ownerAuthorized: true,
        reasonCode: "owner_reviewed_hold_immutable",
      },
    };
    const proof = evaluateV254OwnerReviewPromotionGate([row], [audit]);
    expect(proof).toMatchObject({
      candidateCount: 1,
      dispositionCount: 1,
      undispositionedCount: 0,
      unresolvedExecutableWorkCount: 0,
      unresolvedPublicationWorkCount: 0,
      promotionSafe: true,
    });
    expect(proof.candidateSetHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(proof.dispositionSetHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("an owner disposition cannot waive executable or publication work", () => {
    const row = {
      ...affectedRow("11111111-1111-4111-8111-111111111111"),
      active_job_count: 1,
      active_publication_job_count: 1,
      unresolved_publication_work_count: 2,
    };
    const proof = evaluateV254OwnerReviewPromotionGate([row], []);
    expect(proof).toMatchObject({
      unresolvedExecutableWorkCount: 1,
      unresolvedPublicationWorkCount: 3,
      promotionSafe: false,
    });
  });

  test("fails closed when the exact incident has an Apple side effect", () => {
    const value = observed();
    value.sameSignature[0]!.apple_side_effect_count = 1;
    const result = evaluateV254IrishInfluenceContainment(value);
    expect(result.safeToApply).toBe(false);
    expect(result.receipt.violations).toContain(
      "affected_signature_set_changed",
    );
  });

  test("fails closed unless the editorial intent pause is independently engaged", () => {
    const value = observed();
    value.assignmentPauses = value.assignmentPauses.slice(0, 1);
    const result = evaluateV254IrishInfluenceContainment(value);
    expect(result.safeToApply).toBe(false);
    expect(result.receipt.violations).toContain(
      "editorial_influence_public_pause_not_engaged",
    );
  });

  test("recognizes an idempotently contained run set only when every job is fenced", () => {
    const value = observed();
    value.run.status = "failed_integrity";
    value.run.phase = "v254_evidence_persistence_quarantined";
    value.resolution.generation = 4;
    value.resolution.state = "quarantined";
    value.resolution.blocker_id = null;
    value.resolution.incident_reference = incidentReference;
    value.resolution.containment_receipt_hash = "a".repeat(64);
    value.sameSignature = value.sameSignature.map((row) => ({
      ...row,
      run_status: "failed_integrity",
      run_phase: "v254_evidence_persistence_quarantined",
      resolution_generation: 4,
      resolution_state: "quarantined",
      resolution_incident_reference: incidentReference,
      containment_receipt_hash: "a".repeat(64),
      active_job_count: 0,
    }));
    const result = evaluateV254IrishInfluenceContainment(value);
    expect(result).toMatchObject({
      safeToApply: true,
      alreadyApplied: true,
      receiptHash: "a".repeat(64),
    });
  });
});
