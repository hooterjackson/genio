import { describe, expect, test } from "vitest";
import {
  BRIDGE_API_MINIMUM_WORKER_PROTOCOL_NUMBER,
  BRIEF_CONTRACT_2_MINIMUM_WORKER_PROTOCOL,
  BRIEF_CONTRACT_3_MINIMUM_WORKER_PROTOCOL,
  isWorkerCapabilityValid,
  isWorkerPipelineProtocolCompatible,
  minimumWorkerProtocolForPipeline,
  minimumWorkerProtocolForQueryPlan,
  WORKER_PIPELINE_CAPABILITY,
  WORKER_PIPELINE_PROTOCOL_NUMBER,
  WORKER_PIPELINE_V4_BRIDGE_CAPABILITY,
  WORKER_PIPELINE_V5_BRIDGE_CAPABILITY,
  workerPipelineProtocolVersion,
  WORKER_PIPELINE_PROTOCOL_VERSION,
} from "../server/worker-protocol.ts";

describe("worker pipeline protocol", () => {
  test("advertises protocol 10 while accepting protocol 8 bridge capacity", () => {
    const current = { protocolVersion: WORKER_PIPELINE_PROTOCOL_VERSION };
    expect(workerPipelineProtocolVersion(current)).toBe(WORKER_PIPELINE_PROTOCOL_VERSION);
    expect(isWorkerPipelineProtocolCompatible(current)).toBe(true);
    expect(WORKER_PIPELINE_PROTOCOL_NUMBER).toBe(10);
    expect(BRIDGE_API_MINIMUM_WORKER_PROTOCOL_NUMBER).toBe(8);
    expect(isWorkerPipelineProtocolCompatible({ protocolVersion: "playlist-pipeline-v8" })).toBe(true);
    expect(isWorkerPipelineProtocolCompatible({ protocolVersion: "playlist-pipeline-v7" })).toBe(false);
    expect(isWorkerPipelineProtocolCompatible({ version: "matching-git-revision" })).toBe(false);
    expect(isWorkerPipelineProtocolCompatible(null)).toBe(false);
  });

  test("models the staged v4/v5 bridges and inert v6 V3 capability", () => {
    expect(isWorkerCapabilityValid(WORKER_PIPELINE_V4_BRIDGE_CAPABILITY)).toBe(true);
    expect(WORKER_PIPELINE_V4_BRIDGE_CAPABILITY.pipelineVersions).toEqual(["legacy_v1"]);
    expect(isWorkerCapabilityValid(WORKER_PIPELINE_V5_BRIDGE_CAPABILITY)).toBe(true);
    expect(WORKER_PIPELINE_V5_BRIDGE_CAPABILITY.pipelineVersions).toEqual(["legacy_v1", "catalog_first_v2"]);
    expect(isWorkerCapabilityValid(WORKER_PIPELINE_CAPABILITY)).toBe(true);
    expect(WORKER_PIPELINE_CAPABILITY.pipelineVersions).toEqual(["legacy_v1", "catalog_first_v2", "corpus_first_v3"]);
    expect(minimumWorkerProtocolForPipeline("legacy_v1")).toBe(4);
    expect(minimumWorkerProtocolForPipeline("catalog_first_v2")).toBe(5);
    expect(minimumWorkerProtocolForPipeline("corpus_first_v3")).toBe(6);
    expect(minimumWorkerProtocolForQueryPlan({ schemaVersion: 1 })).toBe(6);
    expect(minimumWorkerProtocolForQueryPlan({ schemaVersion: 2 })).toBe(8);
    expect(minimumWorkerProtocolForQueryPlan({ schemaVersion: 3 })).toBe(9);
    expect(minimumWorkerProtocolForQueryPlan({ schemaVersion: 4 })).toBe(10);
    expect(BRIEF_CONTRACT_2_MINIMUM_WORKER_PROTOCOL).toBe(9);
    expect(BRIEF_CONTRACT_3_MINIMUM_WORKER_PROTOCOL).toBe(10);
  });
});
