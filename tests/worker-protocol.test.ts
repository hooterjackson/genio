import { describe, expect, test } from "vitest";
import {
  isWorkerCapabilityValid,
  isWorkerPipelineProtocolCompatible,
  minimumWorkerProtocolForPipeline,
  WORKER_PIPELINE_CAPABILITY,
  WORKER_PIPELINE_PROTOCOL_NUMBER,
  WORKER_PIPELINE_V4_BRIDGE_CAPABILITY,
  WORKER_PIPELINE_V5_BRIDGE_CAPABILITY,
  workerPipelineProtocolVersion,
  WORKER_PIPELINE_PROTOCOL_VERSION,
} from "../server/worker-protocol.ts";

describe("worker pipeline protocol", () => {
  test("accepts only the current explicit protocol", () => {
    const current = { protocolVersion: WORKER_PIPELINE_PROTOCOL_VERSION };
    expect(workerPipelineProtocolVersion(current)).toBe(WORKER_PIPELINE_PROTOCOL_VERSION);
    expect(isWorkerPipelineProtocolCompatible(current)).toBe(true);
    expect(WORKER_PIPELINE_PROTOCOL_NUMBER).toBe(7);
    expect(isWorkerPipelineProtocolCompatible({ protocolVersion: "playlist-pipeline-v5" })).toBe(false);
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
  });
});
