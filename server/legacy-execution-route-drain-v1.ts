import { sha256Hex, stableStringify } from "./security.ts";

export const LEGACY_EXECUTION_ROUTE_DRAIN_PHASE_V1 =
  "legacy_execution_route_drain_v1" as const;
export const LEGACY_EXECUTION_ROUTE_DRAIN_VERSION_V1 =
  "legacy_execution_route_drain_v1" as const;

const SHA256 = /^[0-9a-f]{64}$/u;
const RELEASE_REVISION =
  /^[0-9A-Za-z][0-9A-Za-z._:+-]{0,159}$/u;
const EXECUTION_ROUTE = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,79}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const JOB_KINDS = new Set(["research", "matching", "publication"]);

export interface LegacyExecutionRouteDrainJobV1 {
  readonly jobId: string;
  readonly kind: "research" | "matching" | "publication";
  readonly queryPlanRevisionId: string | null;
  readonly queryPlanHash: string | null;
  readonly stageKey: string;
  readonly createdAt: string;
  readonly sourceExecutorRevision: string | null;
  readonly sourceSemanticConfigurationHash: string | null;
}

export interface LegacyExecutionRouteDrainV1 {
  readonly version: typeof LEGACY_EXECUTION_ROUTE_DRAIN_VERSION_V1;
  readonly runId: string;
  readonly contractRevisionId: string | null;
  readonly executionRoute: string;
  readonly targetReleaseRevision: string;
  readonly targetSemanticConfigurationHash: string;
  readonly acceptedBefore: string;
  readonly inventoriedAt: string;
  readonly jobs: readonly LegacyExecutionRouteDrainJobV1[];
  readonly receiptHash: string;
}

type LegacyExecutionRouteDrainBodyV1 =
  Omit<LegacyExecutionRouteDrainV1, "receiptHash">;

function assertTimestamp(value: string, name: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`legacy_execution_route_drain_${name}_invalid`);
  }
}

export function createLegacyExecutionRouteDrainV1(
  input: LegacyExecutionRouteDrainBodyV1,
): LegacyExecutionRouteDrainV1 {
  const body = structuredClone(input);
  const value: LegacyExecutionRouteDrainV1 = {
    ...body,
    receiptHash: sha256Hex(stableStringify(body)),
  };
  assertLegacyExecutionRouteDrainV1(value);
  return Object.freeze(value);
}

export function assertLegacyExecutionRouteDrainV1(
  value: LegacyExecutionRouteDrainV1,
): void {
  if (value.version !== LEGACY_EXECUTION_ROUTE_DRAIN_VERSION_V1) {
    throw new Error("legacy_execution_route_drain_version_invalid");
  }
  if (!UUID.test(value.runId)
    || (value.contractRevisionId !== null
      && !UUID.test(value.contractRevisionId))) {
    throw new Error("legacy_execution_route_drain_identity_invalid");
  }
  if (!EXECUTION_ROUTE.test(value.executionRoute)) {
    throw new Error("legacy_execution_route_drain_route_invalid");
  }
  if (!RELEASE_REVISION.test(value.targetReleaseRevision)
    || !SHA256.test(value.targetSemanticConfigurationHash)) {
    throw new Error("legacy_execution_route_drain_target_invalid");
  }
  assertTimestamp(value.acceptedBefore, "cutoff");
  assertTimestamp(value.inventoriedAt, "inventory_time");
  if (Date.parse(value.acceptedBefore) > Date.parse(value.inventoriedAt)) {
    throw new Error("legacy_execution_route_drain_cutoff_invalid");
  }
  if (!Array.isArray(value.jobs)
    || value.jobs.length < 1
    || value.jobs.length > 500) {
    throw new Error("legacy_execution_route_drain_jobs_invalid");
  }
  const jobIds = new Set<string>();
  for (const job of value.jobs) {
    if (!UUID.test(job.jobId)
      || !JOB_KINDS.has(job.kind)
      || (job.queryPlanRevisionId !== null
        && !UUID.test(job.queryPlanRevisionId))
      || (job.queryPlanHash !== null && !SHA256.test(job.queryPlanHash))
      || ((job.queryPlanRevisionId === null) !== (job.queryPlanHash === null))
      || !job.stageKey
      || job.stageKey.length > 160
      || (
        job.sourceExecutorRevision !== null
        && !RELEASE_REVISION.test(job.sourceExecutorRevision)
      )
      || (
        job.sourceSemanticConfigurationHash !== null
        && !SHA256.test(job.sourceSemanticConfigurationHash)
      )
      || (
        (job.sourceExecutorRevision === null)
        !== (job.sourceSemanticConfigurationHash === null)
      )) {
      throw new Error("legacy_execution_route_drain_job_invalid");
    }
    assertTimestamp(job.createdAt, "job_created_at");
    if (Date.parse(job.createdAt) > Date.parse(value.acceptedBefore)
      || jobIds.has(job.jobId)) {
      throw new Error("legacy_execution_route_drain_job_invalid");
    }
    jobIds.add(job.jobId);
  }
  const sorted = [...value.jobs].sort((left, right) => (
    left.jobId.localeCompare(right.jobId)
  ));
  if (stableStringify(sorted) !== stableStringify(value.jobs)) {
    throw new Error("legacy_execution_route_drain_jobs_not_canonical");
  }
  if (!SHA256.test(value.receiptHash)) {
    throw new Error("legacy_execution_route_drain_hash_invalid");
  }
  const { receiptHash, ...body } = value;
  if (sha256Hex(stableStringify(body)) !== receiptHash) {
    throw new Error("legacy_execution_route_drain_hash_mismatch");
  }
}

export function parseLegacyExecutionRouteDrainV1(
  value: unknown,
): LegacyExecutionRouteDrainV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const drain = structuredClone(value) as LegacyExecutionRouteDrainV1;
    assertLegacyExecutionRouteDrainV1(drain);
    return drain;
  } catch {
    return null;
  }
}

export function legacyExecutionRouteDrainAuthorizesJobV1(input: {
  value: unknown;
  runId: string;
  contractRevisionId: string | null;
  executionRoute: string;
  targetReleaseRevision: string;
  targetSemanticConfigurationHash: string;
  jobId: string;
  kind: string;
  queryPlanRevisionId: string | null;
  queryPlanHash: string | null;
  stageKey: string;
  createdAt: Date | string;
}): boolean {
  const drain = parseLegacyExecutionRouteDrainV1(input.value);
  if (!drain
    || drain.runId !== input.runId
    || drain.contractRevisionId !== input.contractRevisionId
    || drain.executionRoute !== input.executionRoute
    || drain.targetReleaseRevision !== input.targetReleaseRevision
    || drain.targetSemanticConfigurationHash
      !== input.targetSemanticConfigurationHash
    || (input.queryPlanRevisionId === null) !== (input.queryPlanHash === null)) {
    return false;
  }
  const createdAt = input.createdAt instanceof Date
    ? input.createdAt.toISOString()
    : input.createdAt;
  if (!Number.isFinite(Date.parse(createdAt))
    || Date.parse(createdAt) > Date.parse(drain.acceptedBefore)) {
    return false;
  }
  return drain.jobs.some((job) => (
    job.jobId === input.jobId
    && job.kind === input.kind
    && job.queryPlanRevisionId === input.queryPlanRevisionId
    && job.queryPlanHash === input.queryPlanHash
    && job.stageKey === input.stageKey
    && job.createdAt === createdAt
  ));
}
