/**
 * Compatibility contract between the API that enqueues pipeline work and the
 * worker that consumes it. Increment this only when a rollout changes the
 * meaning or shape of queued playlist-pipeline work.
 */
import type { PipelineVersion } from "../shared/types.ts";

export interface WorkerPipelineCapability {
  protocolVersion: string;
  protocolNumber: number;
  pipelineVersions: readonly PipelineVersion[];
}

/**
 * Release-A bridge capability. It must be deployed while V2 assignment is
 * still disabled, before a v5 worker is introduced. It can drain legacy work
 * after the expand migration but cannot lease catalog-first jobs.
 */
export const WORKER_PIPELINE_V4_BRIDGE_CAPABILITY: WorkerPipelineCapability = {
  protocolVersion: "playlist-pipeline-v4",
  protocolNumber: 4,
  pipelineVersions: ["legacy_v1"],
};

// v5 adds immutable pipeline/minimum-protocol queue stamping and makes every
// lease capability-aware. It remains an explicit bridge during the V3 expand
// rollout: it may drain V1/V2 work but can never lease corpus-first jobs.
export const WORKER_PIPELINE_V5_BRIDGE_CAPABILITY: WorkerPipelineCapability = {
  protocolVersion: "playlist-pipeline-v5",
  protocolNumber: 5,
  pipelineVersions: ["legacy_v1", "catalog_first_v2"],
};

// v6 understands the inert corpus-first routing contract. Assignment remains
// separately disabled; declaring capability does not opt a run into V3.
export const WORKER_PIPELINE_PROTOCOL_VERSION = "playlist-pipeline-v7";
export const WORKER_PIPELINE_PROTOCOL_NUMBER = 7;
export const WORKER_PIPELINE_CAPABILITY: WorkerPipelineCapability = {
  protocolVersion: WORKER_PIPELINE_PROTOCOL_VERSION,
  protocolNumber: WORKER_PIPELINE_PROTOCOL_NUMBER,
  pipelineVersions: ["legacy_v1", "catalog_first_v2", "corpus_first_v3"],
};

export const LEGACY_V1_MINIMUM_WORKER_PROTOCOL = 4;
export const CATALOG_FIRST_V2_MINIMUM_WORKER_PROTOCOL = 5;
export const CORPUS_FIRST_V3_MINIMUM_WORKER_PROTOCOL = 6;

export function minimumWorkerProtocolForPipeline(pipelineVersion: PipelineVersion): number {
  if (pipelineVersion === "corpus_first_v3") return CORPUS_FIRST_V3_MINIMUM_WORKER_PROTOCOL;
  if (pipelineVersion === "catalog_first_v2") return CATALOG_FIRST_V2_MINIMUM_WORKER_PROTOCOL;
  return LEGACY_V1_MINIMUM_WORKER_PROTOCOL;
}

export function workerPipelineProtocolNumber(value: unknown): number | null {
  const version = typeof value === "string"
    ? value
    : workerPipelineProtocolVersion(value);
  const match = version?.match(/^playlist-pipeline-v([1-9]\d*)$/u);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function isWorkerCapabilityValid(capability: WorkerPipelineCapability): boolean {
  return workerPipelineProtocolNumber(capability.protocolVersion) === capability.protocolNumber
    && Number.isSafeInteger(capability.protocolNumber)
    && capability.protocolNumber > 0
    && capability.pipelineVersions.length > 0
    && capability.pipelineVersions.every((value) => (
      value === "legacy_v1"
      || value === "catalog_first_v2"
      || value === "corpus_first_v3"
    ));
}

export function workerPipelineProtocolVersion(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).protocolVersion;
  return typeof value === "string" && value.length <= 64 ? value : null;
}

export function isWorkerPipelineProtocolCompatible(metadata: unknown): boolean {
  const actual = workerPipelineProtocolNumber(metadata);
  return actual !== null && actual >= WORKER_PIPELINE_PROTOCOL_NUMBER;
}
