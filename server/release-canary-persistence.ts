import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { UnsignedReleaseCanaryMetadata } from "./release-canary-metadata.ts";
import { HttpError } from "./security.ts";

export interface ReleaseCanaryMarkerOwner {
  operation: "brief" | "run";
  id: string;
}

interface StoredReleaseCanaryMarker {
  canary_id: string;
  environment: string;
  operation: string;
  source_revision: string;
  cache_mode: string;
  brief_request_id: string | null;
  run_id: string | null;
}

function ownerId(row: StoredReleaseCanaryMarker): string | null {
  return row.operation === "brief" ? row.brief_request_id : row.run_id;
}

function matches(
  row: StoredReleaseCanaryMarker,
  marker: UnsignedReleaseCanaryMetadata,
  owner: ReleaseCanaryMarkerOwner,
): boolean {
  return row.canary_id === marker.canaryId
    && row.environment === marker.environment
    && row.operation === marker.operation
    && row.source_revision === marker.sourceRevision
    && row.cache_mode === marker.cacheMode
    && row.operation === owner.operation
    && ownerId(row) === owner.id;
}

function conflict(): never {
  throw new HttpError(
    409,
    "Release-canary metadata conflicts with an earlier idempotent request",
    "release_canary_conflict",
  );
}

/**
 * Records authenticated synthetic traffic in the same transaction that owns
 * the brief/run insert. On an idempotent replay the marker must match exactly:
 * a request cannot be relabeled between synthetic and user traffic after the
 * fact, and one signed canary scope cannot be attached to two requests.
 */
export async function persistReleaseCanaryMarker(
  client: PoolClient,
  marker: UnsignedReleaseCanaryMetadata | null | undefined,
  owner: ReleaseCanaryMarkerOwner,
  linkedBriefRequestId?: string | null,
): Promise<void> {
  if (marker && marker.operation !== owner.operation) conflict();
  const schema = await client.query<{ available: boolean }>(
    `SELECT to_regclass(
       quote_ident(current_schema()) || '.release_canary_markers'
     ) IS NOT NULL available`,
  );
  if (!schema.rows[0]?.available) {
    if (marker) {
      throw new HttpError(
        503,
        "Release-canary persistence is not available",
        "release_canary_unavailable",
      );
    }
    return;
  }
  if (owner.operation === "run") {
    if (!linkedBriefRequestId) {
      if (marker) conflict();
    } else {
      const linkedBrief = await client.query<StoredReleaseCanaryMarker>(
        `SELECT canary_id,environment,operation,source_revision,cache_mode,
                brief_request_id,run_id
         FROM release_canary_markers
         WHERE brief_request_id=$1
         FOR SHARE`,
        [linkedBriefRequestId],
      );
      const briefMarker = linkedBrief.rows[0];
      if (Boolean(briefMarker) !== Boolean(marker)) conflict();
      if (briefMarker && marker && (
        briefMarker.operation !== "brief"
        || briefMarker.canary_id !== marker.canaryId
        || briefMarker.environment !== marker.environment
        || briefMarker.source_revision !== marker.sourceRevision
        || briefMarker.cache_mode !== marker.cacheMode
      )) {
        conflict();
      }
    }
  }
  const target = owner.operation === "brief"
    ? await client.query<StoredReleaseCanaryMarker>(
      `SELECT canary_id,environment,operation,source_revision,cache_mode,
              brief_request_id,run_id
       FROM release_canary_markers
       WHERE brief_request_id=$1
       FOR UPDATE`,
      [owner.id],
    )
    : await client.query<StoredReleaseCanaryMarker>(
      `SELECT canary_id,environment,operation,source_revision,cache_mode,
              brief_request_id,run_id
       FROM release_canary_markers
       WHERE run_id=$1
       FOR UPDATE`,
      [owner.id],
    );
  const targetRow = target.rows[0];
  if (targetRow) {
    if (!marker || !matches(targetRow, marker, owner)) conflict();
    return;
  }
  if (!marker) return;

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO release_canary_markers(
       id,canary_id,environment,operation,source_revision,cache_mode,
       brief_request_id,run_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(canary_id,environment,operation,source_revision) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      marker.canaryId,
      marker.environment,
      marker.operation,
      marker.sourceRevision,
      marker.cacheMode,
      owner.operation === "brief" ? owner.id : null,
      owner.operation === "run" ? owner.id : null,
    ],
  );
  if (inserted.rows[0]) return;

  const scoped = await client.query<StoredReleaseCanaryMarker>(
    `SELECT canary_id,environment,operation,source_revision,cache_mode,
            brief_request_id,run_id
     FROM release_canary_markers
     WHERE canary_id=$1 AND environment=$2 AND operation=$3
       AND source_revision=$4
     FOR UPDATE`,
    [
      marker.canaryId,
      marker.environment,
      marker.operation,
      marker.sourceRevision,
    ],
  );
  if (!scoped.rows[0] || !matches(scoped.rows[0], marker, owner)) conflict();
}
