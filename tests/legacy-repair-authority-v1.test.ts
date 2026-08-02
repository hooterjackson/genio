import { describe, expect, it } from "vitest";
import {
  createLegacyRepairAuthorityConsumptionV1,
  createLegacyRepairAuthorityV1,
  createLegacyRepairRunAdmissionV1,
  decideLegacyRepairAuthorityUseV1,
  parseLegacyRepairAuthorityConsumptionV1,
  parseLegacyRepairAuthorityV1,
  parseLegacyRepairRunAdmissionV1,
  repairReplayPauseDecisionV1,
  validateLegacyRepairAuthorityFenceV1,
  type LegacyRepairAuthorityBodyV1,
  type ObservedLegacyRepairFenceV1,
} from "../server/legacy-repair-authority-v1.ts";
import {
  V254_IRISH_INFLUENCE_SYNTHETIC_BINDING,
} from "../scripts/v254-irish-influence-protected-binding.ts";

const RUN_ID = V254_IRISH_INFLUENCE_SYNTHETIC_BINDING.runId;
const ACCESS_ID = V254_IRISH_INFLUENCE_SYNTHETIC_BINDING.accessId;
const BRIEF_ID = V254_IRISH_INFLUENCE_SYNTHETIC_BINDING.briefRequestId;
const CONTRACT_ID =
  V254_IRISH_INFLUENCE_SYNTHETIC_BINDING.contractRevisionId;
const QUERY_PLAN_ID =
  V254_IRISH_INFLUENCE_SYNTHETIC_BINDING.queryPlanRevisionId;
const SOURCE_REVISION = "c5d76e9e84b6982826fcce462b049d3c05925f3b";
const REPAIR_REVISION = "d5d76e9e84b6982826fcce462b049d3c05925f3c";
const CONTRACT_HASH = "1".repeat(64);
const QUERY_PLAN_HASH = "2".repeat(64);
const SOURCE_CONFIGURATION_HASH = "3".repeat(64);
const REPAIR_CONFIGURATION_HASH = "4".repeat(64);
const CONTAINMENT_HASH = "5".repeat(64);
const AUTHORIZER_HASH = "6".repeat(64);

function body(
  patch: Partial<LegacyRepairAuthorityBodyV1> = {},
): LegacyRepairAuthorityBodyV1 {
  return {
    version: "legacy_repair_authority_v1",
    provenanceKind: "forward_owner_repair_not_historical_admission",
    authorizationKind: "authenticated_owner_control_plane",
    sourceRunId: RUN_ID,
    sourceAccessId: ACCESS_ID,
    sourceBriefRequestId: BRIEF_ID,
    sourceResolutionGeneration: 4,
    sourceResolutionState: "quarantined",
    sourceRunStatus: "failed_integrity",
    sourceRunPhase: "v254_evidence_persistence_quarantined",
    incidentReference: "v254-irish-influence-evidence-persistence",
    sourceContractRevisionId: CONTRACT_ID,
    sourceContractSemanticHash: CONTRACT_HASH,
    sourceContractStatus: "active",
    sourceQueryPlanRevisionId: QUERY_PLAN_ID,
    sourceQueryPlanHash: QUERY_PLAN_HASH,
    sourceQueryPlanSchema: 6,
    sourceExecutionRoute: "corpus_first_v3",
    sourceReleaseRevision: SOURCE_REVISION,
    sourceExecutorSemanticConfigurationHash: SOURCE_CONFIGURATION_HASH,
    sourcePublicAssignmentPresent: false,
    sourceRouteReceiptPresent: false,
    sourceReleaseCanaryMarkerPresent: false,
    containmentReceiptHash: CONTAINMENT_HASH,
    targetTrafficClass: "replay",
    targetSuccessorKind: "v5_1_planning_successor",
    targetGuidanceVersion: "adaptive_guidance_v5",
    targetExecutionRoute: "corpus_first_v3",
    targetIntentGroup: "editorial_influence",
    repairReleaseRevision: REPAIR_REVISION,
    repairExecutorSemanticConfigurationHash: REPAIR_CONFIGURATION_HASH,
    resultReuse: false,
    autoPublication: false,
    maximumUses: 1,
    authorizedBySubjectHash: AUTHORIZER_HASH,
    authorizedAt: "2026-08-01T12:00:00.000Z",
    expiresAt: "2026-08-02T12:00:00.000Z",
    ...patch,
  };
}

function observed(
  patch: Partial<ObservedLegacyRepairFenceV1> = {},
): ObservedLegacyRepairFenceV1 {
  return {
    sourceRunId: RUN_ID,
    sourceAccessId: ACCESS_ID,
    sourceBriefRequestId: BRIEF_ID,
    sourceResolutionGeneration: 4,
    sourceResolutionState: "quarantined",
    sourceRunStatus: "failed_integrity",
    sourceRunPhase: "v254_evidence_persistence_quarantined",
    incidentReference: "v254-irish-influence-evidence-persistence",
    sourceContractRevisionId: CONTRACT_ID,
    sourceContractSemanticHash: CONTRACT_HASH,
    sourceContractStatus: "active",
    sourceQueryPlanRevisionId: QUERY_PLAN_ID,
    sourceQueryPlanHash: QUERY_PLAN_HASH,
    sourceQueryPlanSchema: 6,
    sourceExecutionRoute: "corpus_first_v3",
    sourceReleaseRevision: SOURCE_REVISION,
    sourceExecutorSemanticConfigurationHash: SOURCE_CONFIGURATION_HASH,
    sourcePublicAssignmentPresent: false,
    sourceRouteReceiptPresent: false,
    sourceReleaseCanaryMarkerPresent: false,
    containmentReceiptHash: CONTAINMENT_HASH,
    activeRepairReleaseRevision: REPAIR_REVISION,
    activeRepairExecutorSemanticConfigurationHash: REPAIR_CONFIGURATION_HASH,
    activeExecutableJobCount: 0,
    appleSideEffectCount: 0,
    hasPublishedReconciliation: false,
    ...patch,
  };
}

describe("legacy repair authority v1", () => {
  it("creates a content-bound forward authority without claiming historical admission", () => {
    const authority = createLegacyRepairAuthorityV1(body());
    expect(parseLegacyRepairAuthorityV1(authority)).toEqual(authority);
    expect(authority).toMatchObject({
      provenanceKind: "forward_owner_repair_not_historical_admission",
      targetTrafficClass: "replay",
      targetSuccessorKind: "v5_1_planning_successor",
      targetGuidanceVersion: "adaptive_guidance_v5",
      sourcePublicAssignmentPresent: false,
      sourceRouteReceiptPresent: false,
      sourceReleaseCanaryMarkerPresent: false,
      resultReuse: false,
      autoPublication: false,
      maximumUses: 1,
    });
    expect(authority.authorityHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects tampering, extra authority material, and a non-replay target", () => {
    const authority = createLegacyRepairAuthorityV1(body());
    expect(parseLegacyRepairAuthorityV1({
      ...authority,
      sourceContractSemanticHash: "7".repeat(64),
    })).toBeNull();
    expect(parseLegacyRepairAuthorityV1({
      ...authority,
      rawPrompt: "must never enter authority material",
    })).toBeNull();
    expect(parseLegacyRepairAuthorityV1({
      ...authority,
      targetTrafficClass: "public",
    })).toBeNull();
  });

  it("validates every immutable source and repaired-release fence", () => {
    const authority = createLegacyRepairAuthorityV1(body());
    expect(validateLegacyRepairAuthorityFenceV1({
      authority,
      observed: observed(),
      now: "2026-08-01T18:00:00.000Z",
    })).toEqual({ eligible: true, authority });

    for (const patch of [
      { sourceResolutionGeneration: 5 },
      { incidentReference: "another-incident" },
      { sourceContractSemanticHash: "8".repeat(64) },
      { sourceQueryPlanHash: "9".repeat(64) },
      { sourceReleaseRevision: REPAIR_REVISION },
      { sourceExecutorSemanticConfigurationHash: "a".repeat(64) },
      { sourcePublicAssignmentPresent: true },
      { sourceRouteReceiptPresent: true },
      { sourceReleaseCanaryMarkerPresent: true },
      { containmentReceiptHash: "b".repeat(64) },
      { activeRepairReleaseRevision: SOURCE_REVISION },
      { activeRepairExecutorSemanticConfigurationHash: "c".repeat(64) },
    ] satisfies Array<Partial<ObservedLegacyRepairFenceV1>>) {
      expect(validateLegacyRepairAuthorityFenceV1({
        authority,
        observed: observed(patch),
        now: "2026-08-01T18:00:00.000Z",
      })).toEqual({
        eligible: false,
        reasonCode: "legacy_repair_authority_stale",
      });
    }
  });

  it("rejects expired authority, active work, and every Apple side effect", () => {
    const authority = createLegacyRepairAuthorityV1(body());
    expect(validateLegacyRepairAuthorityFenceV1({
      authority,
      observed: observed(),
      now: "2026-08-01T11:59:59.999Z",
    })).toEqual({
      eligible: false,
      reasonCode: "legacy_repair_authority_not_yet_valid",
    });
    expect(validateLegacyRepairAuthorityFenceV1({
      authority,
      observed: observed(),
      now: authority.expiresAt,
    })).toEqual({
      eligible: false,
      reasonCode: "legacy_repair_authority_expired",
    });
    expect(validateLegacyRepairAuthorityFenceV1({
      authority,
      observed: observed({ activeExecutableJobCount: 1 }),
      now: "2026-08-01T18:00:00.000Z",
    })).toEqual({
      eligible: false,
      reasonCode: "legacy_repair_work_still_active",
    });
    expect(validateLegacyRepairAuthorityFenceV1({
      authority,
      observed: observed({ appleSideEffectCount: -1 }),
      now: "2026-08-01T18:00:00.000Z",
    })).toEqual({
      eligible: false,
      reasonCode: "legacy_repair_observation_invalid",
    });
    for (const publication of [
      { appleSideEffectCount: 1 },
      { hasPublishedReconciliation: true },
    ]) {
      expect(validateLegacyRepairAuthorityFenceV1({
        authority,
        observed: observed(publication),
        now: "2026-08-01T18:00:00.000Z",
      })).toEqual({
        eligible: false,
        reasonCode: "legacy_repair_already_published",
      });
    }
  });

  it("never bypasses the global pause or route hard switch", () => {
    expect(repairReplayPauseDecisionV1({
      authorityKind: "authenticated_legacy_repair",
      globalResearchPaused: true,
      publicAssignmentPaused: true,
      hardRouteDisabled: false,
    })).toEqual({ allowed: false, reasonCode: "research_paused" });
    expect(repairReplayPauseDecisionV1({
      authorityKind: "authenticated_legacy_repair",
      globalResearchPaused: false,
      publicAssignmentPaused: false,
      hardRouteDisabled: true,
    })).toEqual({
      allowed: false,
      reasonCode: "repair_replay_route_disabled",
    });
  });

  it("lets authenticated legacy repair bypass only the public-only pause", () => {
    expect(repairReplayPauseDecisionV1({
      authorityKind: "signed_public_rollout",
      globalResearchPaused: false,
      publicAssignmentPaused: true,
      hardRouteDisabled: false,
    })).toEqual({
      allowed: false,
      reasonCode: "repair_replay_public_assignment_paused",
    });
    expect(repairReplayPauseDecisionV1({
      authorityKind: "authenticated_legacy_repair",
      globalResearchPaused: false,
      publicAssignmentPaused: true,
      hardRouteDisabled: false,
    })).toEqual({
      allowed: true,
      bypassedPublicAssignmentPause: true,
    });
  });

  it("consumes an authority once while preserving idempotent return", () => {
    const authority = createLegacyRepairAuthorityV1(body());
    const requestHash = "d".repeat(64);
    const idempotencyKeyHash = "e".repeat(64);
    expect(decideLegacyRepairAuthorityUseV1({
      authority,
      existingConsumptions: [],
      requestHash,
      idempotencyKeyHash,
    })).toEqual({ kind: "create_planning_successor" });

    const consumption = createLegacyRepairAuthorityConsumptionV1({
      version: "legacy_repair_authority_consumption_v1",
      authorityHash: authority.authorityHash,
      requestHash,
      idempotencyKeyHash,
      successorBriefRequestId: "42e5e1fe-3db2-47de-9093-954d36de1a21",
      successorKind: "v5_1_planning_successor",
      consumedAt: "2026-08-01T18:01:00.000Z",
    });
    expect(parseLegacyRepairAuthorityConsumptionV1(consumption))
      .toEqual(consumption);
    expect(decideLegacyRepairAuthorityUseV1({
      authority,
      existingConsumptions: [consumption],
      requestHash,
      idempotencyKeyHash,
    })).toEqual({
      kind: "return_existing",
      successorBriefRequestId: consumption.successorBriefRequestId,
    });
    expect(decideLegacyRepairAuthorityUseV1({
      authority,
      existingConsumptions: [consumption],
      requestHash: "f".repeat(64),
      idempotencyKeyHash,
    })).toEqual({
      kind: "reject",
      reasonCode: "legacy_repair_authority_already_used",
    });
  });

  it("fails closed for malformed or duplicate consumption state", () => {
    const authority = createLegacyRepairAuthorityV1(body());
    const consumption = createLegacyRepairAuthorityConsumptionV1({
      version: "legacy_repair_authority_consumption_v1",
      authorityHash: authority.authorityHash,
      requestHash: "d".repeat(64),
      idempotencyKeyHash: "e".repeat(64),
      successorBriefRequestId: "42e5e1fe-3db2-47de-9093-954d36de1a21",
      successorKind: "v5_1_planning_successor",
      consumedAt: "2026-08-01T18:01:00.000Z",
    });
    expect(decideLegacyRepairAuthorityUseV1({
      authority,
      existingConsumptions: [{ ...consumption, consumedAt: "tampered" }],
      requestHash: "d".repeat(64),
      idempotencyKeyHash: "e".repeat(64),
    })).toEqual({
      kind: "reject",
      reasonCode: "legacy_repair_consumption_integrity",
    });
    expect(decideLegacyRepairAuthorityUseV1({
      authority,
      existingConsumptions: [consumption, consumption],
      requestHash: "d".repeat(64),
      idempotencyKeyHash: "e".repeat(64),
    })).toEqual({
      kind: "reject",
      reasonCode: "legacy_repair_consumption_integrity",
    });
  });

  it("binds the exact one-use authority and consumption into run admission", () => {
    const authority = createLegacyRepairAuthorityV1(body());
    const consumption = createLegacyRepairAuthorityConsumptionV1({
      version: "legacy_repair_authority_consumption_v1",
      authorityHash: authority.authorityHash,
      requestHash: "d".repeat(64),
      idempotencyKeyHash: "e".repeat(64),
      successorBriefRequestId: "42e5e1fe-3db2-47de-9093-954d36de1a21",
      successorKind: "v5_1_planning_successor",
      consumedAt: "2026-08-01T18:01:00.000Z",
    });
    const admission = createLegacyRepairRunAdmissionV1({
      version: "legacy_repair_run_admission_v1",
      authority,
      consumption,
      sourceRunId: authority.sourceRunId,
      successorBriefRequestId: consumption.successorBriefRequestId,
      trafficClass: "replay",
      resultReuse: false,
      autoPublication: false,
      admittedAt: "2026-08-01T18:02:00.000Z",
    });
    expect(parseLegacyRepairRunAdmissionV1(admission)).toEqual(admission);
    expect(parseLegacyRepairRunAdmissionV1({
      ...admission,
      successorBriefRequestId: BRIEF_ID,
    })).toBeNull();
  });
});
