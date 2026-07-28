import { describe, expect, test } from "vitest";
import {
  buildPipelineStageLedger,
  evaluatePipelineOperationalWindow,
} from "../server/pipeline-v2-observability.ts";

describe("Pipeline V2 stage observability", () => {
  test("records every required stage and pinpoints losses without allowing counts to grow", () => {
    const ledger = buildPipelineStageLedger({
      targetTrackCount: 50,
      stageCounts: {
        discovered: 90,
        scope_qualified: 72,
        claim_verified: 61,
        version_compatible: 58,
        catalog_resolved: 47,
        playable: 46,
        canonicalized: 45,
        quota_eligible: 46,
        sequenced: 44,
        manifested: 44,
        published: 43,
      },
      exhausted: true,
      observedAt: "2026-07-19T12:00:00.000Z",
    });

    expect(ledger.map((entry) => entry.stage)).toEqual([
      "discovered",
      "scope_qualified",
      "claim_verified",
      "version_compatible",
      "catalog_resolved",
      "playable",
      "canonicalized",
      "quota_eligible",
      "sequenced",
      "manifested",
      "published",
    ]);
    expect(ledger.find((entry) => entry.stage === "catalog_resolved")).toMatchObject({
      actualCount: 47,
      deficitCount: 3,
      status: "exhausted",
    });
    expect(ledger.find((entry) => entry.stage === "quota_eligible")?.actualCount).toBe(45);
    expect(ledger.at(-1)).toMatchObject({ actualCount: 43, deficitCount: 7 });
  });

  test("resolved and waived stages are explicit", () => {
    const ledger = buildPipelineStageLedger({
      targetTrackCount: 25,
      stageCounts: {
        discovered: 40,
        scope_qualified: 30,
        claim_verified: 30,
        version_compatible: 30,
        catalog_resolved: 28,
        playable: 28,
        canonicalized: 27,
        quota_eligible: 25,
        sequenced: 25,
        manifested: 25,
        published: 25,
      },
      waivedStages: ["quota_eligible"],
    });
    expect(ledger.every((entry) => entry.deficitCount === 0)).toBe(true);
    expect(ledger.find((entry) => entry.stage === "quota_eligible")?.status).toBe("waived");
    expect(ledger.find((entry) => entry.stage === "published")?.status).toBe("resolved");
  });
});

describe("Pipeline V2 operational alert policy", () => {
  const baseline = {
    windowStartedAt: "2026-07-19T11:00:00.000Z",
    windowEndedAt: "2026-07-19T12:00:00.000Z",
    terminalRuns: 20,
    zeroResultRuns: 0,
    partialRuns: 0,
    shortfallRuns: 0,
    systemFailureRuns: 0,
    integrityFailureRuns: 0,
    briefFailures: 0,
    guidanceFailures: 0,
    stuckWorkItems: 0,
    localContractRejections: 0,
    providerCircuitOpenings: 0,
    paginationLoops: 0,
    endpointDriftEvents: 0,
    publicationDivergences: 0,
  };

  test("stays quiet for healthy windows", () => {
    expect(evaluatePipelineOperationalWindow({ ...baseline, partialRuns: 4 })).toEqual([]);
  });

  test("detects every required alert class with bounded thresholds", () => {
    expect(evaluatePipelineOperationalWindow({
      ...baseline,
      zeroResultRuns: 3,
      partialRuns: 6,
      shortfallRuns: 7,
      systemFailureRuns: 1,
      integrityFailureRuns: 1,
      briefFailures: 2,
      guidanceFailures: 1,
      stuckWorkItems: 1,
      localContractRejections: 2,
      providerCircuitOpenings: 3,
      paginationLoops: 1,
      endpointDriftEvents: 1,
      publicationDivergences: 1,
    }).map((alert) => alert.kind)).toEqual([
      "pipeline_zero_result_spike",
      "pipeline_partial_rate_elevated",
      "pipeline_shortfall_rate_elevated",
      "pipeline_system_failure",
      "pipeline_integrity_failure",
      "pipeline_brief_failure",
      "pipeline_guidance_failure",
      "pipeline_stuck_work",
      "pipeline_local_contract_rejections",
      "pipeline_provider_circuit_repeated",
      "pipeline_pagination_loop",
      "pipeline_endpoint_drift",
      "pipeline_publication_divergence",
    ]);
  });

  test("routes guidance failures to one alert class instead of double-notifying as generic brief failures", () => {
    expect(evaluatePipelineOperationalWindow({
      ...baseline,
      briefFailures: 1,
      guidanceFailures: 1,
    }).map((alert) => alert.kind)).toEqual(["pipeline_guidance_failure"]);
  });
});
