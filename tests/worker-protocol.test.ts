import { describe, expect, test } from "vitest";
import {
  isWorkerPipelineProtocolCompatible,
  workerPipelineProtocolVersion,
  WORKER_PIPELINE_PROTOCOL_VERSION,
} from "../server/worker-protocol.ts";

describe("worker pipeline protocol", () => {
  test("accepts only the current explicit protocol", () => {
    const current = { protocolVersion: WORKER_PIPELINE_PROTOCOL_VERSION };
    expect(workerPipelineProtocolVersion(current)).toBe(WORKER_PIPELINE_PROTOCOL_VERSION);
    expect(isWorkerPipelineProtocolCompatible(current)).toBe(true);
    expect(isWorkerPipelineProtocolCompatible({ protocolVersion: "playlist-pipeline-v1" })).toBe(false);
    expect(isWorkerPipelineProtocolCompatible({ version: "matching-git-revision" })).toBe(false);
    expect(isWorkerPipelineProtocolCompatible(null)).toBe(false);
  });
});
