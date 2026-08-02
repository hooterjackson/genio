import { describe, expect, test } from "vitest";
import {
  createLegacyExecutionRouteDrainV1,
  legacyExecutionRouteDrainAuthorizesJobV1,
  LEGACY_EXECUTION_ROUTE_DRAIN_VERSION_V1,
  parseLegacyExecutionRouteDrainV1,
} from "../server/legacy-execution-route-drain-v1.ts";
import {
  createLegacyExecutionRouteDrainInventoryV1,
  legacyExecutionRouteDrainDatabaseConfig,
  parseLegacyExecutionRouteDrainInventoryV1,
} from "../scripts/inventory-legacy-execution-route-drain.ts";

const runId = "11111111-1111-4111-8111-111111111111";
const contractRevisionId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const queryPlanRevisionId = "44444444-4444-4444-8444-444444444444";
const queryPlanHash = "5".repeat(64);
const targetReleaseRevision = "6".repeat(40);
const targetSemanticConfigurationHash = "7".repeat(64);
const cutoff = "2026-08-02T20:00:00.000Z";
const createdAt = "2026-08-02T19:59:00.000Z";

function drain() {
  return createLegacyExecutionRouteDrainV1({
    version: LEGACY_EXECUTION_ROUTE_DRAIN_VERSION_V1,
    runId,
    contractRevisionId,
    executionRoute: "corpus_first_v3",
    targetReleaseRevision,
    targetSemanticConfigurationHash,
    acceptedBefore: cutoff,
    inventoriedAt: cutoff,
    jobs: [{
      jobId,
      kind: "research",
      queryPlanRevisionId,
      queryPlanHash,
      stageKey: "v3-retrieval:active:test",
      createdAt,
      sourceExecutorRevision: "2.5.3",
      sourceSemanticConfigurationHash: "8".repeat(64),
    }],
  });
}

describe("legacy execution route drain v1", () => {
  test("uses the public database with TLS and internal database without override", () => {
    expect(legacyExecutionRouteDrainDatabaseConfig({
      DATABASE_PUBLIC_URL: "postgresql://public.example/needle",
      DATABASE_URL: "postgresql://postgres.railway.internal/needle",
    })).toEqual({
      connectionString: "postgresql://public.example/needle",
      ssl: { rejectUnauthorized: false },
    });
    expect(legacyExecutionRouteDrainDatabaseConfig({
      DATABASE_PUBLIC_URL: "",
      DATABASE_URL: "postgresql://postgres.railway.internal/needle",
    })).toEqual({
      connectionString: "postgresql://postgres.railway.internal/needle",
    });
    expect(() => legacyExecutionRouteDrainDatabaseConfig({})).toThrow(
      "database_url_missing",
    );
  });

  test("authorizes only the exact inventoried job on the target release", () => {
    const value = drain();
    const input = {
      value,
      runId,
      contractRevisionId,
      executionRoute: "corpus_first_v3",
      targetReleaseRevision,
      targetSemanticConfigurationHash,
      jobId,
      kind: "research",
      queryPlanRevisionId,
      queryPlanHash,
      stageKey: "v3-retrieval:active:test",
      createdAt,
    };
    expect(legacyExecutionRouteDrainAuthorizesJobV1(input)).toBe(true);
    expect(legacyExecutionRouteDrainAuthorizesJobV1({
      ...input,
      jobId: "99999999-9999-4999-8999-999999999999",
    })).toBe(false);
    expect(legacyExecutionRouteDrainAuthorizesJobV1({
      ...input,
      targetReleaseRevision: "a".repeat(40),
    })).toBe(false);
    expect(legacyExecutionRouteDrainAuthorizesJobV1({
      ...input,
      createdAt: "2026-08-02T20:00:01.000Z",
    })).toBe(false);
  });

  test("rejects mutation and binds a canonical global inventory", () => {
    const value = drain();
    expect(parseLegacyExecutionRouteDrainV1({
      ...value,
      jobs: [{
        ...value.jobs[0],
        queryPlanHash: "9".repeat(64),
      }],
    })).toBeNull();
    const inventory = createLegacyExecutionRouteDrainInventoryV1({
      version: "legacy_execution_route_drain_inventory_v1",
      acceptedBefore: cutoff,
      inventoriedAt: cutoff,
      targetReleaseRevision,
      targetSemanticConfigurationHash,
      drains: [value],
      jobCount: 1,
    });
    expect(parseLegacyExecutionRouteDrainInventoryV1(inventory))
      .toEqual(inventory);
    expect(parseLegacyExecutionRouteDrainInventoryV1({
      ...inventory,
      jobCount: 2,
    })).toBeNull();
  });

  test("explicitly inventories a pre-receipt legacy route without a query plan", () => {
    const legacy = createLegacyExecutionRouteDrainV1({
      version: LEGACY_EXECUTION_ROUTE_DRAIN_VERSION_V1,
      runId,
      contractRevisionId: null,
      executionRoute: "pipeline_v2",
      targetReleaseRevision,
      targetSemanticConfigurationHash,
      acceptedBefore: cutoff,
      inventoriedAt: cutoff,
      jobs: [{
        jobId,
        kind: "research",
        queryPlanRevisionId: null,
        queryPlanHash: null,
        stageKey: "legacy-v2-research",
        createdAt,
        sourceExecutorRevision: null,
        sourceSemanticConfigurationHash: null,
      }],
    });
    expect(legacyExecutionRouteDrainAuthorizesJobV1({
      value: legacy,
      runId,
      contractRevisionId: null,
      executionRoute: "pipeline_v2",
      targetReleaseRevision,
      targetSemanticConfigurationHash,
      jobId,
      kind: "research",
      queryPlanRevisionId: null,
      queryPlanHash: null,
      stageKey: "legacy-v2-research",
      createdAt,
    })).toBe(true);
    expect(parseLegacyExecutionRouteDrainV1({
      ...legacy,
      jobs: [{ ...legacy.jobs[0], queryPlanHash: queryPlanHash }],
    })).toBeNull();
  });
});
