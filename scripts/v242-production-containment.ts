import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

type ContainmentMode =
  | "status"
  | "pause"
  | "inventory"
  | "contain-dry-run"
  | "contain-apply";
const DEFAULT_INCIDENT_RUN_ID = "870791f6-03d1-47fa-a0d7-e71e4f7972ad";
const EXPECTED_INCIDENT = Object.freeze({
  runId: DEFAULT_INCIDENT_RUN_ID,
  runStatus: "researching",
  runPhase: "v3_retrieval",
  pipelineVersion: "corpus_first_v3",
  resolutionGeneration: 4,
  resolutionState: "executing",
  contractRevisionId: "8910f5b5-9302-4a6c-9597-32eb3b718cc1",
  manifestId: "c02f0bb9-5d26-446e-ae37-d4bd5efa8bff",
  queryPlanRevisionId: "6abd72f1-bebc-40e5-8f86-4c59558aa91b",
  jobId: "2bffceff-a18d-4a94-acb4-36bd48d1a9e0",
  latestAttemptId: "e226f038-7833-4794-8a3a-9d64a4a02e06",
  executorRevision: "b6051ef9c7594cffdbb9bb4afa9b90b154b20d9f",
  candidateCount: 55,
  activeQualifiedCount: 56,
  activeUnboundQualifiedCount: 56,
  manifestedTrackCount: 50,
  reserveTrackCount: 5,
  activeJobCount: 1,
  attemptCount: 3,
});

function parseMode(argv: readonly string[]): ContainmentMode {
  const mode = argv[2] ?? "status";
  if (![
    "status",
    "pause",
    "inventory",
    "contain-dry-run",
    "contain-apply",
  ].includes(mode)) {
    throw new Error(
      "usage: v242-production-containment.ts "
      + "[status|pause|inventory|contain-dry-run|contain-apply] [receipt-hash]",
    );
  }
  return mode as ContainmentMode;
}

function databaseUrl(): string {
  const value = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
  if (!value) throw new Error("database_url_missing");
  return value;
}

async function snapshot(client: pg.Client) {
  const settings = await client.query<{
    key: string;
    value: string;
    updated_at: Date;
  }>(
    `SELECT key,value,updated_at
     FROM settings
     WHERE key IN ('research_paused','publishing_paused')
     ORDER BY key`,
  );
  const killSwitches = await client.query<{
    route: string;
    intent_group: string | null;
    disabled: boolean;
    reason_code: string | null;
    changed_by: string;
    changed_at: Date;
  }>(
    `SELECT route,intent_group,disabled,reason_code,changed_by,changed_at
     FROM pipeline_cohort_kill_switches
     WHERE route='corpus_first_v3'
     ORDER BY intent_group NULLS FIRST`,
  );
  return {
    settings: settings.rows,
    killSwitches: killSwitches.rows,
  };
}

async function inventory(client: pg.Client, incidentRunId: string) {
  const run = await client.query(
    `SELECT id,status,phase,pipeline_version,policy_version,
            brief_contract_version,active_playlist_contract_revision_id,
            auto_publish,created_at,updated_at
     FROM research_runs
     WHERE id=$1`,
    [incidentRunId],
  );
  const resolution = await client.query(
    `SELECT run_id,generation,state,next_action,active_contract_revision_id,
            execution_attempt_id,blocker_id,question_set_id,manifest_id,
            provenance,incident_reference,state_json,created_at,updated_at
     FROM playlist_run_resolutions
     WHERE run_id=$1`,
    [incidentRunId],
  );
  const jobs = await client.query(
    `SELECT id,kind,status,attempts,max_attempts,available_at,
            lease_owner IS NOT NULL has_lease,lease_expires_at,completed_at,
            pipeline_version,minimum_worker_protocol,query_plan_revision_id,
            stage_key,lease_epoch,queue_class,required_executor_revision,
            required_executor_semantic_configuration_hash,
            last_error LIKE '%pipeline_v3_evidence_attestation_missing%'
              has_attestation_error,
            created_at,updated_at
     FROM job_queue
     WHERE run_id=$1
     ORDER BY created_at,id`,
    [incidentRunId],
  );
  const attempts = await client.query(
    `SELECT id,contract_revision_id,stage,dependency_key,attempt_number,
            lease_generation,executor_revision,configuration_hash,
            checkpoint_cursor,status,blocker_kind,query_plan_revision_id,
            job_id,lease_expires_at,last_active_at,active_compute_ms,
            semantic_execution_configuration_hash,started_at,completed_at
     FROM playlist_execution_attempts
     WHERE run_id=$1
     ORDER BY created_at,id`,
    [incidentRunId],
  );
  const blockers = await client.query(
    `SELECT id,contract_revision_id,blocker_kind,dependency_key,retry_count,
            next_retry_at,automatic_retry_until,resolved_at,state_json,
            created_at,updated_at
     FROM playlist_run_blockers
     WHERE run_id=$1
     ORDER BY created_at,id`,
    [incidentRunId],
  );
  const publication = await client.query(
    `SELECT reconciliation.id,reconciliation.manifest_id,
            reconciliation.manifest_revision_id,reconciliation.state,
            reconciliation.apple_playlist_id IS NOT NULL has_apple_playlist,
            reconciliation.expected_ordered_ids_hash,
            reconciliation.observed_ordered_ids_hash,
            reconciliation.appended_count,reconciliation.expected_count,
            reconciliation.batch_cursor,reconciliation.next_retry_at,
            reconciliation.completed_at,reconciliation.created_at,
            reconciliation.updated_at
     FROM playlist_publication_reconciliations reconciliation
     WHERE reconciliation.run_id=$1
     ORDER BY reconciliation.created_at,reconciliation.id`,
    [incidentRunId],
  );
  const volumes = await client.query(
    `SELECT volume.id,volume.manifest_id,volume.manifest_revision_id,
            volume.volume_number,volume.volume_count,volume.start_position,
            volume.end_position,volume.status,
            volume.apple_playlist_id IS NOT NULL has_apple_playlist,
            volume.apple_share_url IS NOT NULL has_share_url,
            volume.appended_count,volume.attempt,volume.published_at,
            volume.created_at,volume.updated_at
     FROM publication_volumes volume
     JOIN manifests manifest ON manifest.id=volume.manifest_id
     WHERE manifest.run_id=$1
     ORDER BY volume.created_at,volume.id`,
    [incidentRunId],
  );
  const counts = await client.query(
    `SELECT
       (SELECT count(*)::int FROM track_candidates
        WHERE run_id=$1) candidate_count,
       (SELECT count(*)::int FROM playlist_qualification_records
        WHERE run_id=$1 AND decision='qualified' AND revoked_at IS NULL)
         active_qualified_count,
       (SELECT count(*)::int FROM playlist_qualification_records
        WHERE run_id=$1 AND decision='qualified' AND revoked_at IS NULL
          AND candidate_id IS NULL) active_unbound_qualified_count,
       (SELECT count(*)::int FROM manifest_revision_tracks track
        JOIN manifest_revisions revision
          ON revision.id=track.manifest_revision_id
        JOIN manifests manifest ON manifest.id=revision.manifest_id
        WHERE manifest.run_id=$1) manifested_track_count,
       (SELECT count(*)::int FROM manifest_revision_reserve_tracks reserve
        JOIN manifest_revisions revision
          ON revision.id=reserve.manifest_revision_id
        JOIN manifests manifest ON manifest.id=revision.manifest_id
        WHERE manifest.run_id=$1) reserve_track_count`,
    [incidentRunId],
  );
  const activeV3Jobs = await client.query(
    `SELECT job.id,job.run_id,job.kind,job.status,job.attempts,
            job.available_at,job.lease_expires_at,job.stage_key,
            job.required_executor_revision,
            job.last_error LIKE '%pipeline_v3_evidence_attestation_missing%'
              has_attestation_error,
            run.status run_status,run.phase run_phase,
            run.updated_at run_updated_at
     FROM job_queue job
     JOIN research_runs run ON run.id=job.run_id
     WHERE job.pipeline_version='corpus_first_v3'
       AND job.status IN ('queued','leased')
     ORDER BY job.created_at,job.id`,
  );
  return {
    incidentRunId,
    run: run.rows,
    resolution: resolution.rows,
    jobs: jobs.rows,
    attempts: attempts.rows,
    blockers: blockers.rows,
    publication: publication.rows,
    volumes: volumes.rows,
    counts: counts.rows[0] ?? null,
    activeV3Jobs: activeV3Jobs.rows,
  };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function incidentPreflight(client: pg.Client) {
  const run = await client.query<{
    id: string;
    status: string;
    phase: string;
    pipeline_version: string;
    active_playlist_contract_revision_id: string | null;
  }>(
    `SELECT id,status,phase,pipeline_version,
            active_playlist_contract_revision_id
     FROM research_runs
     WHERE id=$1
     FOR UPDATE`,
    [EXPECTED_INCIDENT.runId],
  );
  const resolution = await client.query<{
    generation: number;
    state: string;
    manifest_id: string | null;
  }>(
    `SELECT generation,state,manifest_id
     FROM playlist_run_resolutions
     WHERE run_id=$1
     FOR UPDATE`,
    [EXPECTED_INCIDENT.runId],
  );
  const jobs = await client.query<{
    id: string;
    status: string;
    query_plan_revision_id: string | null;
    required_executor_revision: string | null;
  }>(
    `SELECT id,status,query_plan_revision_id,required_executor_revision
     FROM job_queue
     WHERE run_id=$1 AND status IN ('queued','leased')
     ORDER BY id
     FOR UPDATE`,
    [EXPECTED_INCIDENT.runId],
  );
  const attempts = await client.query<{
    id: string;
    status: string;
    executor_revision: string;
  }>(
    `SELECT id,status,executor_revision
     FROM playlist_execution_attempts
     WHERE run_id=$1
     ORDER BY attempt_number,id
     FOR UPDATE`,
    [EXPECTED_INCIDENT.runId],
  );
  const counts = await client.query<{
    candidate_count: number;
    active_qualified_count: number;
    active_unbound_qualified_count: number;
    manifested_track_count: number;
    reserve_track_count: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM track_candidates
        WHERE run_id=$1) candidate_count,
       (SELECT count(*)::int FROM playlist_qualification_records
        WHERE run_id=$1 AND decision='qualified' AND revoked_at IS NULL)
         active_qualified_count,
       (SELECT count(*)::int FROM playlist_qualification_records
        WHERE run_id=$1 AND decision='qualified' AND revoked_at IS NULL
          AND candidate_id IS NULL) active_unbound_qualified_count,
       (SELECT count(*)::int FROM manifest_revision_tracks track
        JOIN manifest_revisions revision
          ON revision.id=track.manifest_revision_id
        JOIN manifests manifest ON manifest.id=revision.manifest_id
        WHERE manifest.run_id=$1) manifested_track_count,
       (SELECT count(*)::int FROM manifest_revision_reserve_tracks reserve
        JOIN manifest_revisions revision
          ON revision.id=reserve.manifest_revision_id
        JOIN manifests manifest ON manifest.id=revision.manifest_id
        WHERE manifest.run_id=$1) reserve_track_count`,
    [EXPECTED_INCIDENT.runId],
  );
  const apple = await client.query<{
    reconciliation_count: number;
    completed_reconciliation_count: number;
    appended_count: number;
    apple_bound_count: number;
    volume_count: number;
  }>(
    `SELECT
       (SELECT count(*)::int
        FROM playlist_publication_reconciliations
        WHERE run_id=$1) reconciliation_count,
       (SELECT count(*)::int
        FROM playlist_publication_reconciliations
        WHERE run_id=$1 AND state='complete'
          AND observed_ordered_ids_hash=expected_ordered_ids_hash)
         completed_reconciliation_count,
       COALESCE((SELECT sum(appended_count)::int
        FROM playlist_publication_reconciliations
        WHERE run_id=$1),0) appended_count,
       (SELECT count(*)::int
        FROM playlist_publication_reconciliations
        WHERE run_id=$1 AND apple_playlist_id IS NOT NULL)
         apple_bound_count,
       (SELECT count(*)::int
        FROM publication_volumes volume
        JOIN manifests manifest ON manifest.id=volume.manifest_id
        WHERE manifest.run_id=$1) volume_count`,
    [EXPECTED_INCIDENT.runId],
  );
  const pauses = await client.query<{ key: string; value: string }>(
    `SELECT key,value FROM settings
     WHERE key IN ('research_paused','publishing_paused')
     ORDER BY key
     FOR UPDATE`,
  );
  const switchRow = await client.query<{
    disabled: boolean;
    reason_code: string | null;
  }>(
    `SELECT disabled,reason_code
     FROM pipeline_cohort_kill_switches
     WHERE route='corpus_first_v3' AND intent_group IS NULL
     FOR UPDATE`,
  );

  const observed = {
    run: run.rows[0] ?? null,
    resolution: resolution.rows[0] ?? null,
    jobs: jobs.rows,
    attempts: attempts.rows,
    counts: counts.rows[0] ?? null,
    apple: apple.rows[0] ?? null,
    pauses: pauses.rows,
    hardSwitch: switchRow.rows[0] ?? null,
  };
  const violations: string[] = [];
  if (observed.run?.id !== EXPECTED_INCIDENT.runId
    || observed.run.status !== EXPECTED_INCIDENT.runStatus
    || observed.run.phase !== EXPECTED_INCIDENT.runPhase
    || observed.run.pipeline_version !== EXPECTED_INCIDENT.pipelineVersion
    || observed.run.active_playlist_contract_revision_id
      !== EXPECTED_INCIDENT.contractRevisionId) {
    violations.push("run_identity_or_state_changed");
  }
  if (Number(observed.resolution?.generation)
      !== EXPECTED_INCIDENT.resolutionGeneration
    || observed.resolution?.state !== EXPECTED_INCIDENT.resolutionState
    || observed.resolution?.manifest_id !== EXPECTED_INCIDENT.manifestId) {
    violations.push("resolution_generation_or_state_changed");
  }
  if (observed.jobs.length !== EXPECTED_INCIDENT.activeJobCount
    || observed.jobs[0]?.id !== EXPECTED_INCIDENT.jobId
    || observed.jobs[0]?.query_plan_revision_id
      !== EXPECTED_INCIDENT.queryPlanRevisionId
    || observed.jobs[0]?.required_executor_revision
      !== EXPECTED_INCIDENT.executorRevision) {
    violations.push("active_job_set_changed");
  }
  if (observed.attempts.length !== EXPECTED_INCIDENT.attemptCount
    || observed.attempts.at(-1)?.id !== EXPECTED_INCIDENT.latestAttemptId
    || observed.attempts.some(({ status }) => status !== "failed")
    || observed.attempts.some(({ executor_revision }) => (
      executor_revision !== EXPECTED_INCIDENT.executorRevision
    ))) {
    violations.push("attempt_set_changed");
  }
  const observedCounts = observed.counts;
  if (!observedCounts
    || Number(observedCounts.candidate_count)
      !== EXPECTED_INCIDENT.candidateCount
    || Number(observedCounts.active_qualified_count)
      !== EXPECTED_INCIDENT.activeQualifiedCount
    || Number(observedCounts.active_unbound_qualified_count)
      !== EXPECTED_INCIDENT.activeUnboundQualifiedCount
    || Number(observedCounts.manifested_track_count)
      !== EXPECTED_INCIDENT.manifestedTrackCount
    || Number(observedCounts.reserve_track_count)
      !== EXPECTED_INCIDENT.reserveTrackCount) {
    violations.push("candidate_qualification_or_manifest_counts_changed");
  }
  if (!observed.apple
    || Number(observed.apple.reconciliation_count) !== 0
    || Number(observed.apple.completed_reconciliation_count) !== 0
    || Number(observed.apple.appended_count) !== 0
    || Number(observed.apple.apple_bound_count) !== 0
    || Number(observed.apple.volume_count) !== 0) {
    violations.push("apple_side_effect_detected");
  }
  if (observed.pauses.length !== 2
    || observed.pauses.some(({ value }) => value !== "true")
    || observed.hardSwitch?.disabled !== true) {
    violations.push("containment_controls_not_active");
  }
  const receipt = {
    incidentVersion: "v242-echo-park-containment-v1",
    expected: EXPECTED_INCIDENT,
    observed,
    violations,
  };
  return {
    receipt,
    receiptHash: sha256(receipt),
    safeToApply: violations.length === 0,
  };
}

async function containIncident(
  client: pg.Client,
  mode: "contain-dry-run" | "contain-apply",
  expectedReceiptHash: string | undefined,
) {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('v242-echo-park-containment-v1'))",
    );
    const preflight = await incidentPreflight(client);
    if (!preflight.safeToApply) {
      throw new Error(
        `containment_preflight_failed:${preflight.receipt.violations.join(",")}`,
      );
    }
    if (mode === "contain-dry-run") {
      await client.query("ROLLBACK");
      return { mode, ...preflight };
    }
    if (!expectedReceiptHash
      || expectedReceiptHash !== preflight.receiptHash) {
      throw new Error("containment_receipt_hash_mismatch");
    }

    const transitionId = randomUUID();
    const incidentReference = "v242-echo-park-evidence-replay";
    await client.query(
      `UPDATE job_queue
       SET status='cancelled',completed_at=now(),updated_at=now(),
           lease_owner=NULL,lease_expires_at=NULL,
           last_error='v242_integrity_quarantine'
       WHERE run_id=$1 AND status IN ('queued','leased')
         AND kind IN ('research','matching','publication')`,
      [EXPECTED_INCIDENT.runId],
    );
    await client.query(
      `UPDATE query_plan_revisions
       SET status='superseded'
       WHERE run_id=$1 AND status='active'`,
      [EXPECTED_INCIDENT.runId],
    );
    await client.query(
      "DELETE FROM run_active_query_plans WHERE run_id=$1",
      [EXPECTED_INCIDENT.runId],
    );
    await client.query(
      `UPDATE playlist_run_blockers
       SET resolved_at=now(),updated_at=now()
       WHERE run_id=$1 AND resolved_at IS NULL`,
      [EXPECTED_INCIDENT.runId],
    );
    await client.query(
      `INSERT INTO playlist_run_resolution_transitions(
         id,run_id,expected_generation,successor_generation,
         from_state,to_state,contract_revision_id,execution_attempt_id,
         companion_artifact_kind,transition_kind,transition_json,
         idempotency_key)
       VALUES(
         $1,$2,$3,$4,'executing','quarantined',$5,$6,
         'incident_reference','owner_integrity_quarantine',$7::jsonb,$8)
       ON CONFLICT(idempotency_key) DO NOTHING`,
      [
        transitionId,
        EXPECTED_INCIDENT.runId,
        EXPECTED_INCIDENT.resolutionGeneration,
        EXPECTED_INCIDENT.resolutionGeneration + 1,
        EXPECTED_INCIDENT.contractRevisionId,
        EXPECTED_INCIDENT.latestAttemptId,
        JSON.stringify({
          incidentReference,
          receiptHash: preflight.receiptHash,
          manifestedTrackCount: EXPECTED_INCIDENT.manifestedTrackCount,
          reconciledPublishedTrackCount: 0,
        }),
        `v242-containment:${EXPECTED_INCIDENT.runId}`,
      ],
    );
    await client.query(
      `UPDATE playlist_run_resolutions
       SET generation=$2,state='quarantined',next_action='contact_support',
           active_contract_revision_id=$3,execution_attempt_id=$4,
           blocker_id=NULL,question_set_id=NULL,decision_json=NULL,
           manifest_id=$5,
           state_json=$6::jsonb,provenance='owner_repair',
           incident_reference=$7,completed_at=NULL,cancelled_at=NULL,
           updated_at=now()
       WHERE run_id=$1 AND generation=$8 AND state='executing'`,
      [
        EXPECTED_INCIDENT.runId,
        EXPECTED_INCIDENT.resolutionGeneration + 1,
        EXPECTED_INCIDENT.contractRevisionId,
        EXPECTED_INCIDENT.latestAttemptId,
        EXPECTED_INCIDENT.manifestId,
        JSON.stringify({
          requestedTrackCount: 50,
          selectedTrackCount: 50,
          manifestedTrackCount: 50,
          appendedTrackCount: 0,
          reconciledPublishedTrackCount: 0,
          publishedTrackCount: 0,
          workMotion: "none",
          incidentCode: "canonical_evidence_replay_invalidated_bindings",
          containmentReceiptHash: preflight.receiptHash,
        }),
        incidentReference,
        EXPECTED_INCIDENT.resolutionGeneration,
      ],
    );
    await client.query(
      `UPDATE research_runs
       SET status='failed_integrity',
           phase='v242_evidence_replay_quarantined',
           error='Canonical evidence binding was invalidated during replay.',
           completed_at=now(),updated_at=now()
       WHERE id=$1`,
      [EXPECTED_INCIDENT.runId],
    );
    await client.query(
      `INSERT INTO audit_events(run_id,actor,action,detail_json)
       VALUES($1,'codex_owner_approved','run.integrity_quarantined',$2::jsonb)`,
      [
        EXPECTED_INCIDENT.runId,
        JSON.stringify({
          incidentReference,
          receiptHash: preflight.receiptHash,
          jobId: EXPECTED_INCIDENT.jobId,
          manifestId: EXPECTED_INCIDENT.manifestId,
          manifestedTrackCount: 50,
          reconciledPublishedTrackCount: 0,
        }),
      ],
    );
    const activeV3 = await client.query<{ count: number }>(
      `SELECT count(*)::int count
       FROM job_queue
       WHERE pipeline_version='corpus_first_v3'
         AND status IN ('queued','leased')`,
    );
    if (Number(activeV3.rows[0]?.count ?? -1) !== 0) {
      throw new Error("active_v3_work_remains");
    }
    await client.query(
      `UPDATE settings
       SET value='false',updated_at=now()
       WHERE key IN ('research_paused','publishing_paused')`,
    );
    await client.query("COMMIT");
    return {
      mode,
      receiptHash: preflight.receiptHash,
      incidentReference,
      safeRoutesResumed: true,
      hardSwitchRemainsEngaged: true,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

const mode = parseMode(process.argv);
const incidentRunId = process.argv[3] ?? DEFAULT_INCIDENT_RUN_ID;
const client = new pg.Client({
  connectionString: databaseUrl(),
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  if (mode === "contain-dry-run" || mode === "contain-apply") {
    console.log(JSON.stringify(
      await containIncident(client, mode, process.argv[3]),
      null,
      2,
    ));
  } else {
  if (mode === "pause") {
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO settings(key,value,updated_at)
         VALUES
           ('research_paused','true',now()),
           ('publishing_paused','true',now())
         ON CONFLICT(key) DO UPDATE SET
           value=excluded.value,
           updated_at=now()`,
      );
      await client.query(
        `INSERT INTO pipeline_cohort_kill_switches(
           cohort_key,route,intent_group,disabled,reason_code,changed_by,changed_at)
         VALUES(
           'v242-incident-containment',
           'corpus_first_v3',
           NULL,
           true,
           'v242_integrity_containment',
           'codex_owner_approved',
           now())
         ON CONFLICT(route,intent_group) DO UPDATE SET
           cohort_key=excluded.cohort_key,
           disabled=true,
           reason_code=excluded.reason_code,
           changed_by=excluded.changed_by,
           changed_at=now()`,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  console.log(JSON.stringify(
    mode === "inventory"
      ? await inventory(client, incidentRunId)
      : await snapshot(client),
    null,
    2,
  ));
  }
} finally {
  await client.end();
}
