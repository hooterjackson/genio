import type { Pool } from "pg";
import type { ReleaseCanaryEnvironment } from "./release-canary-metadata.ts";
import {
  CANONICAL_ACTIVATION_DATABASE_CAPABILITY_SETTING,
  CANONICAL_ACTIVATION_DATABASE_CAPABILITY_VERSION,
} from "./release-deployment-phase.ts";
import { HttpError } from "./security.ts";

export interface SafeReleaseCanaryExecutionProof {
  contractRevision: number;
  contractHash: string;
  attempts: Array<{
    stage: string;
    status: string;
    executorRevision: string;
    executorIdentityHash: string;
    configurationHash: string;
    startedAt: string;
    completedAt: string | null;
  }>;
  publicationReconciliation: {
    state: string;
    expectedCount: number;
    appendedCount: number;
    batchCursor: number;
    expectedOrderedIdsHash: string;
    observedOrderedIdsHash: string | null;
    orderedIdsVerified: boolean;
    completedAt: string | null;
  } | null;
}

export interface ReleaseCanaryInventory {
  schemaAvailable: boolean;
  canaryId: string;
  environment: ReleaseCanaryEnvironment;
  sourceRevision: string;
  readyForReleaseEvidence: boolean;
  operations: Array<{
    operation: "brief" | "run";
    cacheMode: "reuse_disabled";
    status: string;
    phase?: string;
    acceptedAt: string;
    executionProof?: SafeReleaseCanaryExecutionProof | null;
  }>;
}

interface InventoryRow {
  operation: "brief" | "run";
  cache_mode: "reuse_disabled";
  created_at: Date;
  request_status: string;
  run_phase: string | null;
  hidden_run_id: string | null;
  hidden_manifest_id: string | null;
}

function validateScope(input: {
  canaryId: string;
  environment: ReleaseCanaryEnvironment;
  sourceRevision: string;
}): void {
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{2,63}$/u.test(input.canaryId)
    || !["staging", "production"].includes(input.environment)
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(input.sourceRevision)) {
    throw new HttpError(
      400,
      "Release-canary inventory scope is invalid",
      "invalid_release_canary_scope",
    );
  }
}

/**
 * Reads the authenticated canary inventory without returning prompts, answer
 * text, brief/run/access IDs, capabilities, or Apple playlist identifiers.
 * The hidden database IDs exist only long enough to load the separately
 * sanitized execution proof.
 */
export async function readReleaseCanaryInventory(input: {
  pool: Pool;
  canaryId: string;
  environment: ReleaseCanaryEnvironment;
  sourceRevision: string;
  executionProof(
    runId: string,
    manifestId?: string | null,
  ): Promise<SafeReleaseCanaryExecutionProof | null>;
}): Promise<ReleaseCanaryInventory> {
  validateScope(input);
  const schema = await input.pool.query<{
    schema_version: string | null;
    capability_version: string | null;
  }>(
    `SELECT
       (SELECT value FROM settings WHERE key='schema_version') schema_version,
       (SELECT value FROM settings WHERE key=$1) capability_version`,
    [CANONICAL_ACTIVATION_DATABASE_CAPABILITY_SETTING],
  );
  if (
    Number(schema.rows[0]?.schema_version ?? 0) < 18
    || schema.rows[0]?.capability_version
      !== CANONICAL_ACTIVATION_DATABASE_CAPABILITY_VERSION
  ) {
    return {
      schemaAvailable: false,
      canaryId: input.canaryId,
      environment: input.environment,
      sourceRevision: input.sourceRevision,
      readyForReleaseEvidence: false,
      operations: [],
    };
  }
  const result = await input.pool.query<InventoryRow>(
    `SELECT marker.operation,marker.cache_mode,marker.created_at,
            CASE marker.operation
              WHEN 'brief' THEN brief.status
              ELSE run.status
            END request_status,
            run.phase run_phase,
            run.id hidden_run_id,
            manifest.id hidden_manifest_id
     FROM release_canary_markers marker
     LEFT JOIN brief_requests brief ON brief.id=marker.brief_request_id
     LEFT JOIN research_runs run
       ON run.id=marker.run_id AND run.deleted_at IS NULL
     LEFT JOIN LATERAL (
       SELECT candidate.id
       FROM manifests candidate
       WHERE candidate.run_id=run.id
       ORDER BY candidate.created_at DESC,candidate.id DESC
       LIMIT 1
     ) manifest ON true
     WHERE marker.canary_id=$1 AND marker.environment=$2
       AND marker.source_revision=$3
       AND marker.cache_mode='reuse_disabled'
     ORDER BY CASE marker.operation WHEN 'brief' THEN 0 ELSE 1 END`,
    [input.canaryId, input.environment, input.sourceRevision],
  );
  const operations = await Promise.all(result.rows.map(async (row) => {
    const executionProof = row.operation === "run" && row.hidden_run_id
      ? await input.executionProof(row.hidden_run_id, row.hidden_manifest_id)
      : undefined;
    return {
      operation: row.operation,
      cacheMode: row.cache_mode,
      status: row.request_status,
      ...(row.run_phase ? { phase: row.run_phase } : {}),
      acceptedAt: row.created_at.toISOString(),
      ...(row.operation === "run" ? { executionProof: executionProof ?? null } : {}),
    };
  }));
  const brief = operations.find(({ operation }) => operation === "brief");
  const run = operations.find(({ operation }) => operation === "run");
  const proof = run?.executionProof;
  const readyForReleaseEvidence = brief?.status === "complete"
    && brief.cacheMode === "reuse_disabled"
    && run?.status === "complete"
    && run.cacheMode === "reuse_disabled"
    && proof != null
    && proof.attempts.length > 0
    && proof.attempts.every((attempt) => (
      attempt.executorRevision === input.sourceRevision
      && /^[0-9a-f]{64}$/u.test(attempt.executorIdentityHash)
      && /^[0-9a-f]{64}$/u.test(attempt.configurationHash)
    ))
    && proof.publicationReconciliation?.orderedIdsVerified === true;
  return {
    schemaAvailable: true,
    canaryId: input.canaryId,
    environment: input.environment,
    sourceRevision: input.sourceRevision,
    readyForReleaseEvidence,
    operations,
  };
}
