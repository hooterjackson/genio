import { createDatabase } from "../db/index.ts";

const accessId = process.argv[2]?.trim();
if (!accessId || !/^[0-9a-f-]{36}$/iu.test(accessId)) {
  throw new Error("Usage: diagnose-access-run.ts <access-id>");
}

// `railway run --no-local` exposes both URLs, but the private hostname is only
// reachable from a deployed Railway service. Prefer the public URL for this
// intentionally read-only operator diagnostic.
if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

const database = createDatabase({ max: 1 });
try {
  const result = await database.pool.query(
    `SELECT
       access.id access_id,
       run.id run_id,
       COALESCE(access.prompt,run.prompt) prompt,
       run.status,
       run.phase,
       run.pipeline_version,
       run.brief_json->>'title' title,
       run.brief_json->'targetSize' target,
       run.pipeline_outcome_json->>'stopReason' stop_reason,
       run.pipeline_outcome_json->>'rootCause' root_cause,
       run.created_at
     FROM run_accesses access
     JOIN research_runs run ON run.id=access.run_id
     WHERE access.id=$1`,
    [accessId],
  );
  if (!result.rows[0]) throw new Error(`Access ${accessId} was not found`);
  const runId = result.rows[0].run_id as string;
  const [
    pipelineOutcome,
    candidateStages,
    matchStatuses,
    frontierStatuses,
    jobs,
    manifest,
  ] = await Promise.all([
    database.pool.query(
      `SELECT status,target_track_count,discovered_track_count,
              qualified_track_count,selected_track_count,published_track_count,
              exact_count_satisfied,frontier_exhausted,provider_unavailable,
              reason_codes_json,deficit_snapshot_json
       FROM pipeline_outcomes WHERE run_id=$1`,
      [runId],
    ),
    database.pool.query(
      `SELECT candidate_stage,count(*)::int count
       FROM track_candidates WHERE run_id=$1
       GROUP BY candidate_stage ORDER BY candidate_stage`,
      [runId],
    ),
    database.pool.query(
      `SELECT status,count(*)::int count
       FROM catalog_matches WHERE run_id=$1
       GROUP BY status ORDER BY status`,
      [runId],
    ),
    database.pool.query(
      `SELECT source_class,status,count(*)::int strategies,
              sum(discovered_count)::int discovered,
              sum(recovered_count)::int recovered
       FROM source_frontier WHERE run_id=$1
       GROUP BY source_class,status ORDER BY source_class,status`,
      [runId],
    ),
    database.pool.query(
      `SELECT kind,status,attempts,max_attempts,minimum_worker_protocol,
              pipeline_version,stage_key,created_at,completed_at
       FROM job_queue WHERE run_id=$1
       ORDER BY created_at`,
      [runId],
    ),
    database.pool.query(
      `SELECT m.id IS NOT NULL manifest_exists,
              count(mt.*)::int track_count,
              m.pipeline_version,m.policy_version
       FROM research_runs r
       LEFT JOIN manifests m ON m.run_id=r.id
       LEFT JOIN manifest_tracks mt ON mt.manifest_id=m.id
       WHERE r.id=$1
       GROUP BY m.id,m.pipeline_version,m.policy_version`,
      [runId],
    ),
  ]);
  process.stdout.write(`${JSON.stringify({
    ...result.rows[0],
    pipeline_outcome: pipelineOutcome.rows[0] ?? null,
    candidate_stages: candidateStages.rows,
    catalog_match_statuses: matchStatuses.rows,
    frontier_statuses: frontierStatuses.rows,
    jobs: jobs.rows,
    manifest: manifest.rows[0] ?? null,
  }, null, 2)}\n`);
} finally {
  await database.pool.end();
}
