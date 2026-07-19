import { describe, expect, test } from "vitest";
import {
  buildPipelineOutcome,
  catalogDiscoveryOutcomeDisposition,
  mergePipelineOutcomes,
} from "../server/pipeline-outcome-v2.ts";

const versions = {
  pipelineVersion: "catalog_first_v2" as const,
  policyVersion: "relevance_first_2026_07" as const,
};

describe("Pipeline V2 terminal outcomes", () => {
  test.each([
    ["provider_call_limit", 10, "partial_catalog_degraded", "catalog_provider_call_limit", false, false],
    ["timed_out", 10, "partial_timed_out", "catalog_discovery_timed_out", false, false],
    ["provider_circuit_open", 10, "partial_catalog_degraded", "apple_provider_circuit_open", false, true],
    ["provider_degraded", 10, "partial_catalog_degraded", "apple_provider_degraded", false, true],
    ["policy_conflict", 10, "partial_policy_conflict", "catalog_version_policy_conflict", true, false],
    ["zero_yield_exhausted", 10, "partial_frontier_exhausted", "catalog_zero_yield_frontier_exhausted", true, false],
    ["frontier_exhausted", 10, "partial_frontier_exhausted", "catalog_frontier_exhausted", true, false],
    ["aborted", 10, "cancelled", "catalog_discovery_aborted", false, false],
  ] as const)(
    "maps catalog stop %s to a deterministic outcome",
    (stoppedBecause, safeTrackCount, status, reasonCode, frontierExhausted, providerUnavailable) => {
      expect(catalogDiscoveryOutcomeDisposition({
        stoppedBecause,
        safeTrackCount,
        targetTrackCount: 25,
      })).toEqual({ status, reasonCode, frontierExhausted, providerUnavailable });
    },
  );

  test("keeps a zero-track catalog result non-fatal without losing its typed cause", () => {
    expect(catalogDiscoveryOutcomeDisposition({
      stoppedBecause: "provider_circuit_open",
      safeTrackCount: 0,
      targetTrackCount: 25,
    })).toEqual({
      status: "no_compatible_tracks",
      reasonCode: "apple_provider_circuit_open",
      frontierExhausted: false,
      providerUnavailable: true,
    });
  });

  test("persists a safe catalog shortfall as a typed partial", () => {
    const outcome = buildPipelineOutcome({
      ...versions,
      status: "partial_catalog_degraded",
      targetTrackCount: 50,
      discoveredTrackCount: 90,
      qualifiedTrackCount: 31,
      selectedTrackCount: 23,
      publishedTrackCount: 23,
      frontierExhausted: true,
      reasonCodes: ["catalog_refill_exhausted"],
      completedAt: "2026-07-19T12:00:00.000Z",
    });

    expect(outcome).toMatchObject({
      status: "partial_catalog_degraded",
      exactCountSatisfied: false,
      publishedTrackCount: 23,
      reasonCodes: ["catalog_refill_exhausted"],
    });
    expect(outcome.deficits.find((entry) => entry.stage === "published")).toEqual(expect.objectContaining({
      kind: "catalog_availability",
      status: "exhausted",
      requiredCount: 50,
      actualCount: 23,
      deficitCount: 27,
    }));
    expect(outcome.deficits).toHaveLength(11);
  });

  test("zero compatible tracks is a successful non-error outcome with a deficit ledger", () => {
    const outcome = buildPipelineOutcome({
      ...versions,
      status: "no_compatible_tracks",
      targetTrackCount: 25,
      discoveredTrackCount: 40,
      qualifiedTrackCount: 0,
      selectedTrackCount: 0,
      publishedTrackCount: 0,
      frontierExhausted: true,
      reasonCodes: ["catalog_identity_unavailable"],
    });

    expect(outcome.status).toBe("no_compatible_tracks");
    expect(outcome.publishedTrackCount).toBe(0);
    expect(outcome.deficits.find((entry) => entry.stage === "published"))
      .toMatchObject({ requiredCount: 25, actualCount: 0, deficitCount: 25 });
  });

  test("a complete publication retains a resolved stage ledger", () => {
    const outcome = buildPipelineOutcome({
      ...versions,
      status: "complete",
      targetTrackCount: 25,
      discoveredTrackCount: 35,
      qualifiedTrackCount: 28,
      selectedTrackCount: 25,
      publishedTrackCount: 25,
    });

    expect(outcome.exactCountSatisfied).toBe(true);
    expect(outcome.deficits).toHaveLength(11);
    expect(outcome.deficits.every((entry) => entry.status === "resolved" && entry.deficitCount === 0)).toBe(true);
  });

  test("normalizes impossible stage counts without inventing tracks", () => {
    const outcome = buildPipelineOutcome({
      ...versions,
      status: "partial_evidence_shortfall",
      targetTrackCount: 25,
      discoveredTrackCount: 5,
      qualifiedTrackCount: 10,
      selectedTrackCount: 9,
      publishedTrackCount: 8,
    });

    expect(outcome).toMatchObject({
      discoveredTrackCount: 5,
      qualifiedTrackCount: 5,
      selectedTrackCount: 5,
      publishedTrackCount: 5,
    });
  });

  test("does not synthesize unobserved stages when durable counts are supplied", () => {
    const outcome = buildPipelineOutcome({
      ...versions,
      status: "partial_evidence_shortfall",
      targetTrackCount: 25,
      discoveredTrackCount: 10,
      qualifiedTrackCount: 6,
      selectedTrackCount: 4,
      publishedTrackCount: 3,
      stageCounts: {
        discovered: 10,
        scope_qualified: 8,
        claim_verified: 6,
      },
    });

    expect(outcome.deficits.map((entry) => [entry.stage, entry.actualCount])).toEqual([
      ["discovered", 10],
      ["scope_qualified", 8],
      ["claim_verified", 6],
      ["version_compatible", 0],
      ["catalog_resolved", 0],
      ["playable", 0],
      ["canonicalized", 0],
      ["quota_eligible", 0],
      ["sequenced", 0],
      ["manifested", 0],
      ["published", 0],
    ]);
  });

  test("late partial retries cannot regress an exact published outcome", () => {
    const complete = buildPipelineOutcome({
      ...versions,
      status: "complete",
      targetTrackCount: 25,
      discoveredTrackCount: 40,
      qualifiedTrackCount: 30,
      selectedTrackCount: 25,
      publishedTrackCount: 25,
      completedAt: "2026-07-19T12:00:00.000Z",
    });
    const latePartial = buildPipelineOutcome({
      ...versions,
      status: "partial_timed_out",
      targetTrackCount: 25,
      discoveredTrackCount: 18,
      qualifiedTrackCount: 12,
      selectedTrackCount: 10,
      publishedTrackCount: 0,
      reasonCodes: ["stale_worker_timeout"],
      completedAt: "2026-07-19T12:01:00.000Z",
    });

    expect(mergePipelineOutcomes(complete, latePartial)).toMatchObject({
      status: "complete",
      exactCountSatisfied: true,
      publishedTrackCount: 25,
      deficits: expect.arrayContaining([
        expect.objectContaining({ stage: "published", status: "resolved", deficitCount: 0 }),
      ]),
    });
  });

  test("out-of-order merges are deterministic and commutative", () => {
    const catalogPartial = buildPipelineOutcome({
      ...versions,
      status: "partial_catalog_degraded",
      targetTrackCount: 50,
      discoveredTrackCount: 80,
      qualifiedTrackCount: 31,
      selectedTrackCount: 23,
      publishedTrackCount: 18,
      providerUnavailable: true,
      reasonCodes: ["apple_circuit_open"],
    });
    const frontierPartial = buildPipelineOutcome({
      ...versions,
      status: "partial_frontier_exhausted",
      targetTrackCount: 50,
      discoveredTrackCount: 92,
      qualifiedTrackCount: 28,
      selectedTrackCount: 24,
      publishedTrackCount: 20,
      frontierExhausted: true,
      reasonCodes: ["two_zero_yield_rounds"],
    });

    expect(mergePipelineOutcomes(catalogPartial, frontierPartial))
      .toEqual(mergePipelineOutcomes(frontierPartial, catalogPartial));
  });

  test("rejects version and target drift", () => {
    const stored = buildPipelineOutcome({
      ...versions,
      status: "partial_evidence_shortfall",
      targetTrackCount: 25,
      discoveredTrackCount: 30,
      qualifiedTrackCount: 20,
      selectedTrackCount: 20,
      publishedTrackCount: 20,
    });
    const driftedTarget = { ...stored, targetTrackCount: 50 };
    const driftedPolicy = { ...stored, policyVersion: "legacy_v1" as const };

    expect(() => mergePipelineOutcomes(stored, driftedTarget)).toThrow(/target/iu);
    expect(() => mergePipelineOutcomes(stored, driftedPolicy)).toThrow(/version/iu);
  });
});
