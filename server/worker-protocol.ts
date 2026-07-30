/**
 * Compatibility contract between the API that enqueues pipeline work and the
 * worker that consumes it. Increment this only when a rollout changes the
 * meaning or shape of queued playlist-pipeline work.
 */
import type { PipelineVersion, QueryPlanV3 } from "../shared/types.ts";
import {
  canonicalExecutorCapabilityEnvelopeIsValidV1,
  canonicalExecutorCapabilityForSchemaV1,
  type CanonicalExecutorCapabilityEnvelopeV1,
} from "./playlist-contract-backend-capability-v1.ts";

export interface WorkerPipelineCapability {
  protocolVersion: string;
  protocolNumber: number;
  pipelineVersions: readonly PipelineVersion[];
  /** Absent on workers released before exact canonical-executor fencing. */
  canonicalExecutorCapabilities?: readonly CanonicalExecutorCapabilityEnvelopeV1[];
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
  canonicalExecutorCapabilities: [],
};

// v5 adds immutable pipeline/minimum-protocol queue stamping and makes every
// lease capability-aware. It remains an explicit bridge during the V3 expand
// rollout: it may drain V1/V2 work but can never lease corpus-first jobs.
export const WORKER_PIPELINE_V5_BRIDGE_CAPABILITY: WorkerPipelineCapability = {
  protocolVersion: "playlist-pipeline-v5",
  protocolNumber: 5,
  pipelineVersions: ["legacy_v1", "catalog_first_v2"],
  canonicalExecutorCapabilities: [],
};

// v11 adds Boolean verification, route coverage, and schema-19 resolution
// fencing while retaining all v10 drain capabilities. Advertising it does not
// activate those contracts; feature gates
// and job stamping keep old work drainable.
export const WORKER_PIPELINE_PROTOCOL_VERSION = "playlist-pipeline-v11";
export const WORKER_PIPELINE_PROTOCOL_NUMBER = 11;
/** Old-contract bridge capacity remains healthy while v11 workers roll out. */
export const BRIDGE_API_MINIMUM_WORKER_PROTOCOL_VERSION = "playlist-pipeline-v8";
export const BRIDGE_API_MINIMUM_WORKER_PROTOCOL_NUMBER = 8;
export const WORKER_PIPELINE_CAPABILITY: WorkerPipelineCapability = {
  protocolVersion: WORKER_PIPELINE_PROTOCOL_VERSION,
  protocolNumber: WORKER_PIPELINE_PROTOCOL_NUMBER,
  pipelineVersions: ["legacy_v1", "catalog_first_v2", "corpus_first_v3"],
  canonicalExecutorCapabilities: [
    canonicalExecutorCapabilityForSchemaV1({ queryPlanSchemaVersion: 4 }),
    canonicalExecutorCapabilityForSchemaV1({ queryPlanSchemaVersion: 5 }),
    canonicalExecutorCapabilityForSchemaV1({ queryPlanSchemaVersion: 6 }),
  ],
};

export const LEGACY_V1_MINIMUM_WORKER_PROTOCOL = 4;
export const CATALOG_FIRST_V2_MINIMUM_WORKER_PROTOCOL = 5;
export const CORPUS_FIRST_V3_MINIMUM_WORKER_PROTOCOL = 6;
/** Schema-2 workers understand typed semantic clauses and their audit hashes. */
export const CORPUS_FIRST_V3_SCHEMA_2_MINIMUM_WORKER_PROTOCOL = 8;
/** Reserved fence for the inactive contract-2 guidance execution contract. */
export const BRIEF_CONTRACT_2_MINIMUM_WORKER_PROTOCOL = 9;
/** Reserved fence for the inactive query-plan schema-3 execution contract. */
export const CORPUS_FIRST_V3_SCHEMA_3_MINIMUM_WORKER_PROTOCOL = 9;
/** Immutable playlist-contract revisions require fencing-aware v10 workers. */
export const BRIEF_CONTRACT_3_MINIMUM_WORKER_PROTOCOL = 10;
/** Query-plan schemas 4+ carry the active playlist-contract revision hash. */
export const CORPUS_FIRST_V3_SCHEMA_4_MINIMUM_WORKER_PROTOCOL = 10;
/** Boolean verification/query-plan schema 6 requires protocol 11. */
export const CORPUS_FIRST_V3_SCHEMA_6_MINIMUM_WORKER_PROTOCOL = 11;

export function minimumWorkerProtocolForPipeline(pipelineVersion: PipelineVersion): number {
  if (pipelineVersion === "corpus_first_v3") return CORPUS_FIRST_V3_MINIMUM_WORKER_PROTOCOL;
  if (pipelineVersion === "catalog_first_v2") return CATALOG_FIRST_V2_MINIMUM_WORKER_PROTOCOL;
  return LEGACY_V1_MINIMUM_WORKER_PROTOCOL;
}

/**
 * Preserve the protocol-6 drain path for historical schema-1 plans while
 * fencing newly compiled schema-2 work to workers that execute typed clauses.
 */
export function minimumWorkerProtocolForQueryPlan(
  queryPlan: Pick<QueryPlanV3, "schemaVersion"> | { readonly schemaVersion: number } | null | undefined,
): number {
  if (typeof queryPlan?.schemaVersion === "number" && queryPlan.schemaVersion >= 6) {
    return CORPUS_FIRST_V3_SCHEMA_6_MINIMUM_WORKER_PROTOCOL;
  }
  if (typeof queryPlan?.schemaVersion === "number" && queryPlan.schemaVersion >= 4) {
    return CORPUS_FIRST_V3_SCHEMA_4_MINIMUM_WORKER_PROTOCOL;
  }
  if (queryPlan?.schemaVersion === 3) {
    return CORPUS_FIRST_V3_SCHEMA_3_MINIMUM_WORKER_PROTOCOL;
  }
  if (queryPlan?.schemaVersion === 2) return CORPUS_FIRST_V3_SCHEMA_2_MINIMUM_WORKER_PROTOCOL;
  return CORPUS_FIRST_V3_MINIMUM_WORKER_PROTOCOL;
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
    ))
    && (capability.canonicalExecutorCapabilities === undefined
      || Array.isArray(capability.canonicalExecutorCapabilities))
    && (capability.canonicalExecutorCapabilities ?? []).every(
      canonicalExecutorCapabilityEnvelopeIsValidV1,
    )
    && new Set((capability.canonicalExecutorCapabilities ?? []).map(({ hash }) => hash)).size
      === (capability.canonicalExecutorCapabilities ?? []).length;
}

export function workerPipelineProtocolVersion(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).protocolVersion;
  return typeof value === "string" && value.length <= 64 ? value : null;
}

export function isWorkerPipelineProtocolCompatible(metadata: unknown): boolean {
  const actual = workerPipelineProtocolNumber(metadata);
  return actual !== null && actual >= BRIDGE_API_MINIMUM_WORKER_PROTOCOL_NUMBER;
}
