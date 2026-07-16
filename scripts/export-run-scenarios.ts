import { createDatabase } from "../db/index.ts";
import {
  assessProductionScenario,
  type ProductionScenarioObservation,
} from "../server/production-scenario-qa.ts";

function date(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function durationMs(start: Date | null, end: Date | null): number | null {
  if (!start || !end) return null;
  return Math.max(0, end.getTime() - start.getTime());
}

function exactTarget(brief: unknown, requested: number | null): number | null {
  if (Number.isInteger(requested) && Number(requested) > 0) return Number(requested);
  if (!brief || typeof brief !== "object") return null;
  const target = (brief as { targetSize?: { min?: unknown; max?: unknown } | null }).targetSize;
  const minimum = Number(target?.min);
  const maximum = Number(target?.max);
  return Number.isInteger(minimum) && minimum > 0 && minimum === maximum ? maximum : null;
}

const database = createDatabase({ max: 1 });

try {
  const result = await database.pool.query<{
    created_at: Date;
    brief_updated_at: Date;
    prompt: string;
    requested_track_count: number | null;
    model: string;
    status: string;
    brief_json: unknown;
    questions_json: unknown;
    answers_json: unknown;
    estimate_usd: number | null;
    error: string | null;
    run_id: string | null;
    run_created_at: Date | null;
    run_completed_at: Date | null;
    run_status: string | null;
    phase: string | null;
    actual_cost_usd: number | null;
    total_cost_usd: number;
    candidate_count: number;
    accounted_candidate_count: number;
    matched_count: number;
    safe_match_count: number | null;
    manifest_count: number;
    appended_count: number;
    public_link_count: number;
    active_started_at: Date | null;
    active_completed_at: Date | null;
    candidate_outcomes: unknown;
    catalog_outcomes: unknown;
    job_events: unknown;
    cost_events: unknown;
  }>(
    `SELECT b.created_at,b.updated_at AS brief_updated_at,b.prompt,b.requested_track_count,b.model,b.status,b.brief_json,
       b.questions_json,b.answers_json,
       b.estimate_usd,b.error,r.id AS run_id,r.created_at AS run_created_at,
       r.completed_at AS run_completed_at,r.status AS run_status,r.phase,r.actual_cost_usd,
       (SELECT COALESCE(sum(ledger.amount_usd),0)::float8
        FROM cost_ledger ledger
        WHERE ledger.brief_request_id=b.id OR ledger.run_id=r.id) AS total_cost_usd,
       (SELECT count(*)::int FROM track_candidates c WHERE c.run_id=r.id) AS candidate_count,
       (SELECT count(*)::int FROM track_candidates c
        WHERE c.run_id=r.id AND c.outcome<>'pending') AS accounted_candidate_count,
       (SELECT count(*)::int FROM catalog_matches m
          WHERE m.run_id=r.id AND m.status='accepted') AS matched_count,
       (SELECT CASE
          WHEN checkpoint.state_json->>'safePrimaryCount' ~ '^[0-9]+$'
          THEN (checkpoint.state_json->>'safePrimaryCount')::int
          ELSE NULL
        END
        FROM research_checkpoints checkpoint
        WHERE checkpoint.run_id=r.id AND checkpoint.phase='catalog_matching_outcome'
        LIMIT 1) AS safe_match_count,
       (SELECT count(*)::int FROM manifest_tracks mt
          JOIN manifests manifest ON manifest.id=mt.manifest_id
          WHERE manifest.run_id=r.id) AS manifest_count,
       (SELECT COALESCE(sum(volume.appended_count),0)::int FROM publication_volumes volume
          JOIN manifests manifest ON manifest.id=volume.manifest_id
          WHERE manifest.run_id=r.id) AS appended_count,
       (SELECT count(*)::int FROM publication_volumes volume
          JOIN manifests manifest ON manifest.id=volume.manifest_id
          WHERE manifest.run_id=r.id AND volume.apple_share_url IS NOT NULL) AS public_link_count,
       (SELECT min(job.created_at) FROM job_queue job
          WHERE job.run_id=r.id AND job.kind IN ('research','matching')) AS active_started_at,
       (SELECT CASE
          WHEN count(*)>0 AND bool_and(job.status IN ('complete','failed','cancelled'))
          THEN max(job.completed_at)
          ELSE NULL
        END
        FROM job_queue job
        WHERE job.run_id=r.id AND job.kind IN ('research','matching')) AS active_completed_at,
       (SELECT COALESCE(jsonb_object_agg(outcomes.outcome,outcomes.count),'{}'::jsonb)
        FROM (
          SELECT c.outcome,count(*)::int count
          FROM track_candidates c WHERE c.run_id=r.id GROUP BY c.outcome
        ) outcomes) AS candidate_outcomes,
       (SELECT COALESCE(jsonb_object_agg(outcomes.status,outcomes.count),'{}'::jsonb)
        FROM (
          SELECT m.status,count(*)::int count
          FROM catalog_matches m WHERE m.run_id=r.id GROUP BY m.status
        ) outcomes) AS catalog_outcomes,
       (SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'kind',job.kind,
          'status',job.status,
          'attempts',job.attempts,
          'createdAt',job.created_at,
          'completedAt',job.completed_at,
          'lastError',job.last_error
        )) ORDER BY job.created_at),'[]'::jsonb)
        FROM job_queue job
        WHERE job.brief_request_id=b.id OR job.run_id=r.id) AS job_events,
       (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'operation',ledger.operation,
          'amountUsd',ledger.amount_usd,
          'usage',ledger.usage_json,
          'occurredAt',ledger.occurred_at
        ) ORDER BY ledger.occurred_at),'[]'::jsonb)
        FROM cost_ledger ledger
        WHERE ledger.brief_request_id=b.id OR ledger.run_id=r.id) AS cost_events
     FROM brief_requests b
     LEFT JOIN LATERAL (
       SELECT candidate_run.* FROM research_runs candidate_run
       JOIN run_accesses access ON access.run_id=candidate_run.id
       WHERE access.brief_request_id=b.id
       ORDER BY access.created_at
       LIMIT 1
     ) r ON true
     WHERE b.created_at>=now()-interval '90 days'
     ORDER BY b.created_at`,
  );

  const exported = result.rows.map((row, index) => {
    const requestedTrackCount = exactTarget(row.brief_json, row.requested_track_count);
    const activeWorkDurationMs = durationMs(row.active_started_at, row.active_completed_at);
    const strictMatchedCount = row.safe_match_count ?? Number(row.matched_count);
    const observation: ProductionScenarioObservation | null = requestedTrackCount
      && activeWorkDurationMs !== null
      && row.run_status !== null
      && row.phase !== null
      ? {
          requestedTrackCount,
          candidateCount: Number(row.candidate_count),
          strictMatchedCount,
          accountedCandidateCount: Number(row.accounted_candidate_count),
          manifestTrackCount: Number(row.manifest_count),
          publishedTrackCount: Number(row.appended_count),
          totalCostUsd: Number(row.total_cost_usd),
          activeWorkDurationMs,
          terminalStatus: row.run_status,
          terminalPhase: row.phase,
        }
      : null;
    const assessment = observation
      ? assessProductionScenario(observation, "exact_playlist")
      : null;
    return {
      id: `${row.created_at.toISOString().slice(0, 10)}-${String(index + 1).padStart(3, "0")}`,
      createdAt: row.created_at.toISOString(),
      briefUpdatedAt: row.brief_updated_at.toISOString(),
      prompt: row.prompt,
      requestedTrackCount: row.requested_track_count,
      model: row.model,
      briefStatus: row.status,
      preflightOutcome: row.questions_json ? "questions_generated" : row.status === "failed" ? "failed" : "not_completed",
      finalizationOutcome: row.answers_json
        ? row.status === "complete" ? "completed" : row.status
        : "not_answered",
      brief: row.brief_json,
      questions: row.questions_json,
      answers: row.answers_json,
      estimatedCostUsd: row.estimate_usd == null ? null : Number(row.estimate_usd),
      briefError: row.error,
      runId: row.run_id,
      runCreatedAt: date(row.run_created_at),
      runCompletedAt: date(row.run_completed_at),
      runStatus: row.run_status,
      terminalPhase: row.phase,
      runActualCostUsd: row.actual_cost_usd == null ? null : Number(row.actual_cost_usd),
      totalBriefAndRunCostUsd: Number(row.total_cost_usd),
      candidateCount: Number(row.candidate_count),
      accountedCandidateCount: Number(row.accounted_candidate_count),
      strictMatchedCount,
      finalAcceptedMatchCount: Number(row.matched_count),
      manifestTrackCount: Number(row.manifest_count),
      appendedTrackCount: Number(row.appended_count),
      publicLinkCount: Number(row.public_link_count),
      candidateYield: requestedTrackCount
        ? Number(row.candidate_count) / requestedTrackCount
        : null,
      catalogYield: Number(row.candidate_count) > 0
        ? strictMatchedCount / Number(row.candidate_count)
        : null,
      activeWorkStartedAt: date(row.active_started_at),
      activeWorkCompletedAt: date(row.active_completed_at),
      activeWorkDurationMs,
      candidateOutcomes: row.candidate_outcomes,
      catalogOutcomes: row.catalog_outcomes,
      jobEvents: row.job_events,
      releaseAssessment: assessment,
      costEvents: row.cost_events,
    };
  });

  process.stdout.write(`${JSON.stringify({
    generatedAt: new Date().toISOString(),
    warning: "Contains visitor prompt text. Keep private and redact before promotion to a permanent fixture.",
    scenarioCount: result.rows.length,
    scenarios: exported,
  }, null, 2)}\n`);
} finally {
  await database.pool.end();
}
