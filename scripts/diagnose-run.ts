import { createDatabase } from "../db/index.ts";

const runId = process.argv[2]?.trim();
if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) {
  throw new Error("Usage: diagnose-run.ts <run-id>");
}

const database = createDatabase({ max: 1 });

try {
  const result = await database.pool.query(
    `SELECT r.id,r.prompt,r.status,r.phase,r.error,r.created_at,r.updated_at,r.completed_at,
       r.brief_json,
       (SELECT count(*)::int FROM track_candidates c WHERE c.run_id=r.id) AS candidate_count,
       (SELECT COALESCE(jsonb_object_agg(grouped.status,grouped.count),'{}'::jsonb)
        FROM (SELECT m.status,count(*)::int AS count FROM catalog_matches m
              WHERE m.run_id=r.id GROUP BY m.status) grouped) AS match_statuses,
       (SELECT COALESCE(jsonb_object_agg(grouped.basis,grouped.count),'{}'::jsonb)
        FROM (SELECT m.basis,count(*)::int AS count FROM catalog_matches m
              WHERE m.run_id=r.id GROUP BY m.basis) grouped) AS match_bases,
       (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'kind',j.kind,'status',j.status,'attempts',j.attempts,
          'maxAttempts',j.max_attempts,'lastError',j.last_error,
          'createdAt',j.created_at,'completedAt',j.completed_at
        ) ORDER BY j.created_at),'[]'::jsonb)
        FROM job_queue j WHERE j.run_id=r.id) AS jobs,
       (SELECT COALESCE(jsonb_object_agg(c.phase,c.state_json),'{}'::jsonb)
        FROM research_checkpoints c WHERE c.run_id=r.id) AS checkpoints,
       (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'artist',sample.artist,'title',sample.title,'album',sample.album,
          'matchStatus',sample.match_status,'matchBasis',sample.match_basis,
          'catalogId',sample.catalog_id
        ) ORDER BY sample.selection_rank NULLS LAST),'[]'::jsonb)
        FROM (
          SELECT c.artist,c.title,c.album,c.selection_rank,m.status AS match_status,
                 m.basis AS match_basis,m.catalog_id
          FROM track_candidates c
          LEFT JOIN catalog_matches m ON m.candidate_id=c.id
          WHERE c.run_id=r.id
          ORDER BY c.selection_rank NULLS LAST
          LIMIT 25
        ) sample) AS candidate_sample
     FROM research_runs r WHERE r.id=$1`,
    [runId],
  );
  if (!result.rows[0]) throw new Error(`Run ${runId} was not found`);
  process.stdout.write(`${JSON.stringify(result.rows[0], null, 2)}\n`);
} finally {
  await database.pool.end();
}
