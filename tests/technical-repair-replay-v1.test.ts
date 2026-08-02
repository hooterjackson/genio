import { describe, expect, it } from "vitest";
import {
  createTechnicalRepairReplayConsumptionV1,
  createTechnicalRepairRunAdmissionV1,
  decideTechnicalRepairReplayUseV1,
  parseTechnicalRepairReplayConsumptionV1,
  parseTechnicalRepairRunAdmissionV1,
  technicalRepairReplayAvailabilityV1,
} from "../server/technical-repair-replay-v1.ts";

const SOURCE_RUN_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_ACCESS_ID = "00000000-0000-4000-8000-000000000002";
const CONTRACT_REVISION_ID = "00000000-0000-4000-8000-000000000003";
const SUCCESSOR_BRIEF_ID = "00000000-0000-4000-8000-000000000004";
const CONTRACT_HASH = "a".repeat(64);
const ROUTE_RECEIPT_HASH = "b".repeat(64);
const REQUEST_HASH = "c".repeat(64);
const IDEMPOTENCY_HASH = "d".repeat(64);

function consumption() {
  return createTechnicalRepairReplayConsumptionV1({
    version: "technical_repair_replay_consumption_v1",
    sourceRunId: SOURCE_RUN_ID,
    sourceAccessId: SOURCE_ACCESS_ID,
    sourceResolutionGeneration: 4,
    incidentReference: "incident:evidence-binding-defect",
    sourceContractRevisionId: CONTRACT_REVISION_ID,
    sourceContractSemanticHash: CONTRACT_HASH,
    sourceRouteReceiptHash: ROUTE_RECEIPT_HASH,
    requestHash: REQUEST_HASH,
    idempotencyKeyHash: IDEMPOTENCY_HASH,
    successorBriefRequestId: SUCCESSOR_BRIEF_ID,
    successorKind: "v5_1_planning_successor",
    resultReuse: false,
    autoPublication: false,
    consumedAt: "2026-08-01T12:00:00.000Z",
  });
}

function useInput(existingConsumptions: readonly unknown[]) {
  return {
    existingConsumptions,
    requestHash: REQUEST_HASH,
    idempotencyKeyHash: IDEMPOTENCY_HASH,
    sourceResolutionGeneration: 4,
    incidentReference: "incident:evidence-binding-defect",
    sourceContractRevisionId: CONTRACT_REVISION_ID,
    sourceContractSemanticHash: CONTRACT_HASH,
    sourceRouteReceiptHash: ROUTE_RECEIPT_HASH,
  };
}

describe("technical repair replay v1", () => {
  it("creates and verifies an immutable one-use consumption receipt", () => {
    const receipt = consumption();
    expect(parseTechnicalRepairReplayConsumptionV1(receipt)).toEqual(receipt);
    expect(parseTechnicalRepairReplayConsumptionV1({
      ...receipt,
      autoPublication: true,
    })).toBeNull();
  });

  it("binds downstream execution to no reuse and no automatic publication", () => {
    const admission = createTechnicalRepairRunAdmissionV1({
      version: "technical_repair_run_admission_v1",
      sourceRunId: SOURCE_RUN_ID,
      consumptionHash: consumption().consumptionHash,
      successorBriefRequestId: SUCCESSOR_BRIEF_ID,
      admittedRunId: "00000000-0000-4000-8000-000000000005",
      targetIntentGroup: "editorial_influence",
      targetExecutionRoute: "corpus_first_v3",
      targetGuidanceVersion: "adaptive_guidance_v5",
      repairReleaseRevision: "release-b",
      repairExecutorConfigurationHash: "e".repeat(64),
      resultReuse: false,
      autoPublication: false,
      admittedAt: "2026-08-01T12:05:00.000Z",
    });
    expect(admission).toMatchObject({
      resultReuse: false,
      autoPublication: false,
    });
    expect(admission.admissionHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(parseTechnicalRepairRunAdmissionV1(admission)).toEqual(admission);
    expect(parseTechnicalRepairRunAdmissionV1({
      ...admission,
      targetIntentGroup: "genre_scene",
    })).toBeNull();
    expect(() => createTechnicalRepairRunAdmissionV1({
      ...admission,
      admittedAt: "not-a-time",
    })).toThrow("technical_repair_run_admission_invalid");
  });

  it("creates once and returns only the byte-identical endpoint retry", () => {
    expect(decideTechnicalRepairReplayUseV1(useInput([]))).toEqual({
      kind: "create_planning_successor",
    });
    expect(decideTechnicalRepairReplayUseV1(
      useInput([consumption()]),
    )).toEqual({
      kind: "return_existing",
      successorBriefRequestId: SUCCESSOR_BRIEF_ID,
    });
    expect(decideTechnicalRepairReplayUseV1({
      ...useInput([consumption()]),
      idempotencyKeyHash: "e".repeat(64),
    })).toEqual({
      kind: "reject",
      reasonCode: "technical_repair_already_used",
    });
  });

  it("fails closed on malformed, duplicated, or stale consumption state", () => {
    expect(decideTechnicalRepairReplayUseV1(
      useInput([{ malformed: true }]),
    )).toMatchObject({
      kind: "reject",
      reasonCode: "technical_repair_consumption_integrity",
    });
    expect(decideTechnicalRepairReplayUseV1(
      useInput([consumption(), consumption()]),
    )).toMatchObject({
      kind: "reject",
      reasonCode: "technical_repair_consumption_integrity",
    });
    expect(decideTechnicalRepairReplayUseV1({
      ...useInput([consumption()]),
      sourceResolutionGeneration: 5,
    })).toMatchObject({
      kind: "reject",
      reasonCode: "technical_repair_consumption_integrity",
    });
  });

  it("requires a changed repaired release or semantic configuration", () => {
    const base = {
      sourceReleaseRevision: "release-a",
      sourceExecutorConfigurationHash: "1".repeat(64),
      activeReleaseRevision: "release-a",
      activeExecutorConfigurationHash: "1".repeat(64),
      globalResearchPaused: false,
      publicAssignmentPaused: false,
      hardRouteDisabled: false,
      assignmentKind: "signed_public_rollout" as const,
      successorBriefRequestId: null,
    };
    expect(technicalRepairReplayAvailabilityV1(base)).toEqual({
      available: false,
      reason: "repair_pending",
    });
    expect(technicalRepairReplayAvailabilityV1({
      ...base,
      activeReleaseRevision: "release-b",
    })).toEqual({
      available: true,
      reason: "ready",
    });
    expect(technicalRepairReplayAvailabilityV1({
      ...base,
      activeExecutorConfigurationHash: "2".repeat(64),
    })).toEqual({
      available: true,
      reason: "ready",
    });
  });

  it("never bypasses a hard/global pause and only owner canaries bypass the public pause", () => {
    const repaired = {
      sourceReleaseRevision: "release-a",
      sourceExecutorConfigurationHash: "1".repeat(64),
      activeReleaseRevision: "release-b",
      activeExecutorConfigurationHash: "1".repeat(64),
      globalResearchPaused: false,
      publicAssignmentPaused: true,
      hardRouteDisabled: false,
      assignmentKind: "signed_public_rollout" as const,
      successorBriefRequestId: null,
    };
    expect(technicalRepairReplayAvailabilityV1(repaired)).toEqual({
      available: false,
      reason: "route_paused",
    });
    expect(technicalRepairReplayAvailabilityV1({
      ...repaired,
      assignmentKind: "signed_owner_canary",
    })).toEqual({
      available: true,
      reason: "ready",
    });
    expect(technicalRepairReplayAvailabilityV1({
      ...repaired,
      assignmentKind: "signed_owner_canary",
      hardRouteDisabled: true,
    })).toEqual({
      available: false,
      reason: "route_paused",
    });
  });

  it("projects a consumed authority as a resumable planning successor", () => {
    expect(technicalRepairReplayAvailabilityV1({
      sourceReleaseRevision: "release-a",
      sourceExecutorConfigurationHash: "1".repeat(64),
      activeReleaseRevision: "release-b",
      activeExecutorConfigurationHash: "1".repeat(64),
      globalResearchPaused: true,
      publicAssignmentPaused: true,
      hardRouteDisabled: true,
      assignmentKind: "signed_public_rollout",
      successorBriefRequestId: SUCCESSOR_BRIEF_ID,
    })).toEqual({
      available: false,
      reason: "already_started",
    });
  });
});
