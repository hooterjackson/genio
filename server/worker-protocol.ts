/**
 * Compatibility contract between the API that enqueues pipeline work and the
 * worker that consumes it. Increment this only when a rollout changes the
 * meaning or shape of queued playlist-pipeline work.
 */
export const WORKER_PIPELINE_PROTOCOL_VERSION = "playlist-pipeline-v2";

export function workerPipelineProtocolVersion(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).protocolVersion;
  return typeof value === "string" && value.length <= 64 ? value : null;
}

export function isWorkerPipelineProtocolCompatible(metadata: unknown): boolean {
  return workerPipelineProtocolVersion(metadata) === WORKER_PIPELINE_PROTOCOL_VERSION;
}
