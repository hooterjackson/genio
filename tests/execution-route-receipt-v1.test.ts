import { describe, expect, it } from "vitest";
import {
  createExecutionRouteReceiptV1,
  EXECUTION_ROUTE_RECEIPT_VERSION_V1,
  parseExecutionRouteReceiptV1,
} from "../server/execution-route-receipt-v1.ts";

const HASH = "a".repeat(64);

function legacyRepairReceipt(overrides: Record<string, unknown> = {}) {
  return {
    version: EXECUTION_ROUTE_RECEIPT_VERSION_V1,
    briefId: "brief:repair-successor",
    rootLineageId: "run:legacy-root",
    trafficClass: "replay" as const,
    contractVersion: 3 as const,
    guidanceVersion: "adaptive_guidance_v5",
    assignmentAuthority: {
      kind: "authenticated_legacy_repair" as const,
      receiptHash: HASH,
      intentGroup: "editorial_influence",
      assignmentReason: "legacy_repair_authority_v1",
    },
    briefSelectionPipelineVersion: "catalog_first_v2",
    executionRoute: "corpus_first_v3",
    queryPlanSchema: 6,
    queryPlanHash: HASH,
    capabilitySnapshotHash: HASH,
    releaseRevision: "c5d76e9e84b6982826fcce462b049d3c05925f3b",
    executorConfigurationHash: HASH,
    createdAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("execution route receipt v1", () => {
  it("binds a Contract-3 owner canary to one explicit route", () => {
    const receipt = createExecutionRouteReceiptV1({
      version: EXECUTION_ROUTE_RECEIPT_VERSION_V1,
      briefId: "brief:test",
      rootLineageId: "brief:test",
      trafficClass: "owner_canary",
      contractVersion: 3,
      guidanceVersion: "adaptive_guidance_v5",
      assignmentAuthority: {
        kind: "signed_owner_canary",
        receiptHash: HASH,
        intentGroup: "genre_scene",
        assignmentReason: "owner_canary",
      },
      briefSelectionPipelineVersion: "catalog_first_v2",
      executionRoute: "corpus_first_v3",
      queryPlanSchema: 6,
      queryPlanHash: HASH,
      capabilitySnapshotHash: HASH,
      releaseRevision: "c5d76e9e84b6982826fcce462b049d3c05925f3b",
      executorConfigurationHash: HASH,
      createdAt: "2026-08-01T12:00:00.000Z",
    });

    expect(receipt.receiptHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.executionRoute).toBe("corpus_first_v3");
    expect(receipt.briefSelectionPipelineVersion).toBe("catalog_first_v2");
    expect(parseExecutionRouteReceiptV1(receipt)).toEqual(receipt);
  });

  it("keeps direct public exposure distinct from staged rollout authority", () => {
    const receipt = createExecutionRouteReceiptV1({
      version: EXECUTION_ROUTE_RECEIPT_VERSION_V1,
      briefId: "brief:direct-public",
      rootLineageId: "brief:direct-public",
      trafficClass: "public",
      contractVersion: 3,
      guidanceVersion: "adaptive_guidance_v5",
      assignmentAuthority: {
        kind: "signed_public_direct_exposure",
        receiptHash: HASH,
        intentGroup: "editorial_influence",
        assignmentReason: "sticky_rollout",
      },
      briefSelectionPipelineVersion: "corpus_first_v3",
      executionRoute: "corpus_first_v3",
      queryPlanSchema: 6,
      queryPlanHash: HASH,
      capabilitySnapshotHash: HASH,
      releaseRevision: "c5d76e9e84b6982826fcce462b049d3c05925f3b",
      executorConfigurationHash: HASH,
      createdAt: "2026-08-01T12:00:00.000Z",
    });
    expect(receipt.assignmentAuthority.kind).toBe(
      "signed_public_direct_exposure",
    );
    expect(parseExecutionRouteReceiptV1(receipt)).toEqual(receipt);
    expect(parseExecutionRouteReceiptV1({
      ...receipt,
      assignmentAuthority: {
        ...receipt.assignmentAuthority,
        kind: "signed_public_rollout",
      },
    })).toBeNull();
  });

  it("permits a signed zero-write synthetic probe of active direct exposure", () => {
    const receipt = createExecutionRouteReceiptV1({
      ...legacyRepairReceipt(),
      briefId: "brief:direct-synthetic",
      rootLineageId: "brief:direct-synthetic",
      trafficClass: "synthetic",
      assignmentAuthority: {
        kind: "signed_public_direct_exposure",
        receiptHash: HASH,
        intentGroup: "editorial_influence",
        assignmentReason: "sticky_rollout",
      },
    });
    expect(parseExecutionRouteReceiptV1(receipt)).toEqual(receipt);
  });

  it("binds a signed Contract-2 owner canary to its exact V2 route", () => {
    const receipt = createExecutionRouteReceiptV1({
      version: EXECUTION_ROUTE_RECEIPT_VERSION_V1,
      briefId: "brief:v2-owner-canary",
      rootLineageId: "brief:v2-owner-canary",
      trafficClass: "owner_canary",
      contractVersion: 2,
      guidanceVersion: "intelligent_guidance_v2",
      assignmentAuthority: {
        kind: "signed_owner_canary",
        receiptHash: HASH,
        intentGroup: "curated_core",
        assignmentReason: "owner_canary",
      },
      briefSelectionPipelineVersion: "catalog_first_v2",
      executionRoute: "catalog_first_v2",
      queryPlanSchema: null,
      queryPlanHash: null,
      capabilitySnapshotHash: null,
      releaseRevision: "c5d76e9e84b6982826fcce462b049d3c05925f3b",
      executorConfigurationHash: HASH,
      createdAt: "2026-08-01T12:00:00.000Z",
    });

    expect(receipt.assignmentAuthority.kind).toBe(
      "signed_owner_canary",
    );
    expect(parseExecutionRouteReceiptV1(receipt)).toEqual(receipt);
  });

  it("binds a synthetic release canary without granting public authority", () => {
    const receipt = createExecutionRouteReceiptV1({
      version: EXECUTION_ROUTE_RECEIPT_VERSION_V1,
      briefId: "brief:release-canary",
      rootLineageId: "brief:release-canary",
      trafficClass: "synthetic",
      contractVersion: 3,
      guidanceVersion: "adaptive_guidance_v5",
      assignmentAuthority: {
        kind: "signed_release_canary",
        receiptHash: HASH,
        intentGroup: "genre_scene",
        assignmentReason: "release_manifest_canary",
      },
      briefSelectionPipelineVersion: "catalog_first_v2",
      executionRoute: "corpus_first_v3",
      queryPlanSchema: 6,
      queryPlanHash: HASH,
      capabilitySnapshotHash: HASH,
      releaseRevision: "c5d76e9e84b6982826fcce462b049d3c05925f3b",
      executorConfigurationHash: HASH,
      createdAt: "2026-08-01T12:00:00.000Z",
    });

    expect(receipt.assignmentAuthority.kind).toBe(
      "signed_release_canary",
    );
    expect(parseExecutionRouteReceiptV1(receipt)).toEqual(receipt);
    expect(parseExecutionRouteReceiptV1({
      ...receipt,
      trafficClass: "public",
    })).toBeNull();
  });

  it("rejects an implicit Contract-3 route without assignment authority", () => {
    expect(() => createExecutionRouteReceiptV1({
      version: EXECUTION_ROUTE_RECEIPT_VERSION_V1,
      briefId: "brief:test",
      rootLineageId: "brief:test",
      trafficClass: "public",
      contractVersion: 3,
      guidanceVersion: "adaptive_guidance_v5",
      assignmentAuthority: {
        kind: "legacy_control",
        receiptHash: HASH,
        intentGroup: "genre_scene",
        assignmentReason: "control",
      },
      briefSelectionPipelineVersion: "catalog_first_v2",
      executionRoute: "corpus_first_v3",
      queryPlanSchema: 6,
      queryPlanHash: HASH,
      capabilitySnapshotHash: HASH,
      releaseRevision: "c5d76e9e84b6982826fcce462b049d3c05925f3b",
      executorConfigurationHash: HASH,
      createdAt: "2026-08-01T12:00:00.000Z",
    })).toThrow(/assignment/u);
  });

  it("rejects receipt drift", () => {
    const receipt = createExecutionRouteReceiptV1({
      version: EXECUTION_ROUTE_RECEIPT_VERSION_V1,
      briefId: "brief:test",
      rootLineageId: "brief:test",
      trafficClass: "public",
      contractVersion: 2,
      guidanceVersion: "adaptive_guidance_v4",
      assignmentAuthority: {
        kind: "legacy_control",
        receiptHash: HASH,
        intentGroup: null,
        assignmentReason: "control",
      },
      briefSelectionPipelineVersion: "catalog_first_v2",
      executionRoute: "catalog_first_v2",
      queryPlanSchema: null,
      queryPlanHash: null,
      capabilitySnapshotHash: null,
      releaseRevision: "c5d76e9e84b6982826fcce462b049d3c05925f3b",
      executorConfigurationHash: HASH,
      createdAt: "2026-08-01T12:00:00.000Z",
    });

    expect(() => createExecutionRouteReceiptV1({
      ...receipt,
      executionRoute: "legacy_v1",
    })).toThrow(/hash/u);
    expect(parseExecutionRouteReceiptV1({
      ...receipt,
      executionRoute: "legacy_v1",
    })).toBeNull();
  });

  it("binds a pre-Contract-3 V3 control to deterministic legacy authority", () => {
    const receipt = createExecutionRouteReceiptV1({
      version: EXECUTION_ROUTE_RECEIPT_VERSION_V1,
      briefId: "run:legacy",
      rootLineageId: "run:legacy",
      trafficClass: "public",
      contractVersion: 1,
      guidanceVersion: "legacy_guidance_v1",
      assignmentAuthority: {
        kind: "legacy_control",
        receiptHash: HASH,
        intentGroup: null,
        assignmentReason: "legacy_control",
      },
      briefSelectionPipelineVersion: "catalog_first_v2",
      executionRoute: "corpus_first_v3",
      queryPlanSchema: 2,
      queryPlanHash: HASH,
      capabilitySnapshotHash: HASH,
      releaseRevision: "c5d76e9e84b6982826fcce462b049d3c05925f3b",
      executorConfigurationHash: HASH,
      createdAt: "2026-08-01T12:00:00.000Z",
    });

    expect(receipt.assignmentAuthority.kind).toBe("legacy_control");
  });

  it("binds an authenticated legacy repair to a replay-only Contract-3 route", () => {
    const receipt = createExecutionRouteReceiptV1(legacyRepairReceipt());

    expect(receipt.trafficClass).toBe("replay");
    expect(receipt.contractVersion).toBe(3);
    expect(receipt.executionRoute).toBe("corpus_first_v3");
    expect(receipt.assignmentAuthority.kind).toBe(
      "authenticated_legacy_repair",
    );
    expect(parseExecutionRouteReceiptV1(receipt)).toEqual(receipt);
  });

  it.each([
    ["public traffic", { trafficClass: "public" }],
    ["owner-canary traffic", { trafficClass: "owner_canary" }],
    ["synthetic traffic", { trafficClass: "synthetic" }],
    ["a legacy contract", { contractVersion: 2 }],
  ])("rejects authenticated legacy repair authority for %s", (_label, patch) => {
    expect(() => createExecutionRouteReceiptV1(
      legacyRepairReceipt(patch),
    )).toThrow(/legacy_repair_scope_mismatch/u);
  });

  it("rejects authenticated legacy repair authority outside corpus-first V3", () => {
    expect(() => createExecutionRouteReceiptV1(legacyRepairReceipt({
      executionRoute: "catalog_first_v2",
      queryPlanSchema: null,
      queryPlanHash: null,
      capabilitySnapshotHash: null,
    }))).toThrow(/legacy_repair_route_mismatch/u);
  });

  it("requires a typed intent for authenticated legacy repair authority", () => {
    expect(() => createExecutionRouteReceiptV1(legacyRepairReceipt({
      assignmentAuthority: {
        kind: "authenticated_legacy_repair",
        receiptHash: HASH,
        intentGroup: null,
        assignmentReason: "legacy_repair_authority_v1",
      },
    }))).toThrow(/legacy_repair_intent_missing/u);
  });
});
