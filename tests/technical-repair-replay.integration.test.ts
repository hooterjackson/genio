import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import * as databaseSchema from "../db/schema.ts";
import {
  createExecutionRouteReceiptV1,
  EXECUTION_ROUTE_RECEIPT_PHASE_V1,
  EXECUTION_ROUTE_RECEIPT_VERSION_V1,
  type ExecutionRouteReceiptV1,
} from "../server/execution-route-receipt-v1.ts";
import {
  compilePlaylistContractRevisionV1,
} from "../server/playlist-contract-v1.ts";
import { Repository } from "../server/repository.ts";
import {
  TECHNICAL_REPAIR_REPLAY_CONSUMPTION_PHASE_V1,
} from "../server/technical-repair-replay-v1.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseDescribe = databaseUrl ? describe.sequential : describe.skip;
const migrationDirectory = new URL("../postgres-migrations/", import.meta.url);
const migrationFiles = readdirSync(migrationDirectory)
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort();

databaseDescribe("current technical repair replay", () => {
  const schemaName =
    `genio_technical_repair_${randomUUID().replaceAll("-", "")}`;
  const runId = randomUUID();
  const sourceAccessId = randomUUID();
  const sourceBriefRequestId = randomUUID();
  const sessionId = randomUUID();
  const contractRevisionId = randomUUID();
  const selectionPlanId = randomUUID();
  const queryPlanRevisionId = randomUUID();
  const graphSnapshotId = randomUUID();
  const contract = compilePlaylistContractRevisionV1({
    contractId: `contract:test:${runId}`,
    rawPrompt: "Influential Irish music",
    requestedTrackCount: 25,
    locale: "en-US",
    storefront: "us",
    clauses: [{
      id: "membership:origin",
      kind: "membership",
      scope: "track",
      hardness: "hard",
      axis: "artist_origin",
      operator: "require",
      values: ["Irish"],
      source: { provenance: "prompt", text: "Irish" },
    }],
    trackPredicate: {
      op: "clause",
      clauseId: "membership:origin",
    },
  });
  const contractSemanticHash = contract.semanticHash;
  const selectionPlanHash = "2".repeat(64);
  const queryPlanHash = "3".repeat(64);
  const capabilitySnapshotHash = "4".repeat(64);
  const sourceConfigurationHash = "5".repeat(64);
  const incidentReference = "incident:evidence-binding-defect";
  let adminPool: Pool | undefined;
  let pool: Pool | undefined;
  let repository: Repository | undefined;
  let publicRouteReceipt: ExecutionRouteReceiptV1;

  beforeAll(async () => {
    vi.stubEnv("APP_VERSION", "2.5.4");
    vi.stubEnv("SOURCE_COMMIT_SHA", "b".repeat(40));
    adminPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: "genio-technical-repair-admin",
    });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 4,
      application_name: "genio-technical-repair",
    });
    for (const file of migrationFiles) {
      await pool.query(readFileSync(
        new URL(`../postgres-migrations/${file}`, import.meta.url),
        "utf8",
      ));
    }
    repository = new Repository({
      pool,
      db: drizzle(pool, { schema: databaseSchema }),
    });

    await pool.query(
      `INSERT INTO brief_requests(
         id,prompt,requested_track_count,model,status,client_bucket,
         idempotency_key,brief_contract_version,expires_at
       ) VALUES(
         $1,'Influential Irish music',25,'gpt-test','complete',
         'repair-browser','source-brief',3,now()+interval '1 day'
       )`,
      [sourceBriefRequestId],
    );
    await pool.query(
      `INSERT INTO research_runs(
         id,prompt,brief_json,brief_hash,status,phase,client_bucket,
         idempotency_key,retention_expires_at,pipeline_version,
         policy_version,brief_contract_version
       ) VALUES(
         $1,'Influential Irish music',
         jsonb_build_object(
           'title','Influential Irish music',
           'description','Influential Irish recordings',
           'mode','curated',
           'subjectEntities',jsonb_build_array('Irish music'),
           'relationship','cultural influence',
           'include',jsonb_build_array(),
           'exclude',jsonb_build_array(),
           'versionPolicy','canonical studio recordings',
           'evidencePolicy','selection-grade evidence',
           'orderingPolicy','editorial flow',
           'targetSize',jsonb_build_object('min',25,'max',25),
           'ambiguities',jsonb_build_array()
         ),$2,'failed_integrity','canonical_integrity_quarantine',
         'repair-browser','source-run',now()+interval '1 day',
         'corpus_first_v3','corpus_first_v3_policy_v1',3
       )`,
      [runId, "6".repeat(64)],
    );
    await pool.query(
      `INSERT INTO run_accesses(
         id,run_id,brief_request_id,prompt,client_bucket,idempotency_key,
         expires_at
       ) VALUES(
         $1,$2,$3,'Influential Irish music','repair-browser',
         'source-access',now()+interval '1 day'
       )`,
      [sourceAccessId, runId, sourceBriefRequestId],
    );
    await pool.query(
      `INSERT INTO capability_sessions(
         id,token_hash,expires_at
       ) VALUES($1,$2,now()+interval '1 day')`,
      [sessionId, "7".repeat(64)],
    );
    await pool.query(
      `INSERT INTO capability_session_accesses(session_id,run_id,access_id)
       VALUES($1,$2,$3)`,
      [sessionId, runId, sourceAccessId],
    );

    await pool.query(
      `INSERT INTO playlist_contract_revisions(
         id,brief_request_id,run_id,revision,status,contract_hash,
         contract_json,compiler_version,ontology_version,
         evidence_policy_version,question_template_version,
         catalog_policy_version,locale,storefront,answer_lineage_hash
       ) VALUES(
         $1,NULL,$2,1,'active',$3::varchar,
         $4::jsonb,
         'compiler-v254','ontology-v254','evidence-v254',
         'guidance-v5-1','catalog-v254','en-US','us',$5
       )`,
      [
        contractRevisionId,
        runId,
        contractSemanticHash,
        JSON.stringify(contract),
        "8".repeat(64),
      ],
    );
    await pool.query(
      `UPDATE research_runs
       SET active_playlist_contract_revision_id=$2
       WHERE id=$1`,
      [runId, contractRevisionId],
    );
    await pool.query(
      `INSERT INTO selection_plans(
         id,run_id,revision,status,plan_hash,plan_json,pipeline_version,
         policy_version,confirmed_at
       ) VALUES(
         $1,$2,1,'active',$3,
         jsonb_build_object('requestedTrackCount',25),
         'corpus_first_v3','corpus_first_v3_policy_v1',now()
       )`,
      [selectionPlanId, runId, selectionPlanHash],
    );
    await pool.query(
      `INSERT INTO graph_snapshots(
         id,status,content_hash,locked_at
       ) VALUES($1,'locked',$2,now())`,
      [graphSnapshotId, "9".repeat(64)],
    );
    await pool.query(
      `INSERT INTO query_plan_revisions(
         id,run_id,selection_plan_id,revision,graph_snapshot_id,engine,
         status,plan_hash,plan_json,pipeline_version,policy_version,
         activated_at
       ) VALUES(
         $1,$2,$3,1,$4,'editorial_ranking','active',$5,
         jsonb_build_object(
           'schemaVersion',6,
           'selectionPlanHash',$6::text
         ),
         'corpus_first_v3','corpus_first_v3_policy_v1',now()
       )`,
      [
        queryPlanRevisionId,
        runId,
        selectionPlanId,
        graphSnapshotId,
        queryPlanHash,
        selectionPlanHash,
      ],
    );
    await pool.query(
      `INSERT INTO run_active_query_plans(run_id,query_plan_revision_id)
       VALUES($1,$2)`,
      [runId, queryPlanRevisionId],
    );
    await pool.query(
      `INSERT INTO playlist_run_resolutions(
         run_id,generation,state,next_action,active_contract_revision_id,
         state_json,provenance,incident_reference
       ) VALUES(
         $1,4,'quarantined','contact_support',$2,
         jsonb_build_object('reasonCode','evidence_binding_defect'),
         'resolution_service',$3
       )`,
      [runId, contractRevisionId, incidentReference],
    );
    const routeReceipt = createExecutionRouteReceiptV1({
      version: EXECUTION_ROUTE_RECEIPT_VERSION_V1,
      briefId: sourceBriefRequestId,
      rootLineageId: contract.contractId,
      trafficClass: "public",
      contractVersion: 3,
      guidanceVersion: "adaptive_guidance_v5",
      assignmentAuthority: {
        kind: "signed_public_rollout",
        receiptHash: "a".repeat(64),
        intentGroup: "editorial_influence",
        assignmentReason: "signed_public_rollout",
      },
      briefSelectionPipelineVersion: "catalog_first_v2",
      executionRoute: "corpus_first_v3",
      queryPlanSchema: 6,
      queryPlanHash,
      capabilitySnapshotHash,
      releaseRevision: "a".repeat(40),
      executorConfigurationHash: sourceConfigurationHash,
      createdAt: "2026-08-01T12:00:00.000Z",
    });
    publicRouteReceipt = routeReceipt;
    await pool.query(
      `INSERT INTO research_checkpoints(run_id,phase,state_json)
       VALUES($1,$2,$3::jsonb)`,
      [
        runId,
        EXECUTION_ROUTE_RECEIPT_PHASE_V1,
        JSON.stringify(routeReceipt),
      ],
    );
  }, 60_000);

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await repository?.close();
    if (adminPool) {
      await adminPool.query(
        `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`,
      );
      await adminPool.end();
    }
  });

  test("honors the exact intent public pause while preserving signed owner-canary bypass", async () => {
    const replayInput = {
      runId,
      sourceAccessId,
      capabilitySessionId: sessionId,
      expectedGeneration: 4,
      expectedIncidentReference: incidentReference,
      expectedContractRevisionId: contractRevisionId,
      expectedContractSemanticHash: contractSemanticHash,
      idempotencyKey: `technical-intent-pause-${randomUUID()}`,
    };
    const ownerIdempotencyKey =
      `technical-owner-bypass-${randomUUID()}`;
    const ownerRouteBody = structuredClone(publicRouteReceipt);
    const ownerReceiptInput = { ...ownerRouteBody };
    delete (ownerReceiptInput as { receiptHash?: string }).receiptHash;
    const ownerRouteReceipt = createExecutionRouteReceiptV1({
      ...ownerReceiptInput,
      trafficClass: "owner_canary",
      assignmentAuthority: {
        kind: "signed_owner_canary",
        receiptHash: "f".repeat(64),
        intentGroup: "editorial_influence",
        assignmentReason: "signed_owner_canary",
      },
    });
    let publicReplayError: unknown;
    let ownerReplayError: unknown;
    type RepairAction = {
      kind: string;
      available: boolean;
      availabilityReason: string;
    } | null;
    const replayProjection = repository as unknown as {
      getRunRepairReplayAction: (sourceRunId: string) => Promise<RepairAction>;
    };
    let publicAction: RepairAction | undefined;
    let ownerAction: RepairAction | undefined;

    await pool!.query(
      `INSERT INTO settings(key,value)
       VALUES
         ('research_paused','false'),
         ('pipeline_v3_public_assignment_paused','false'),
         ('pipeline_v3_public_assignment_paused:editorial_influence','true')
       ON CONFLICT(key) DO UPDATE
       SET value=excluded.value,updated_at=now()`,
    );
    await pool!.query(
      `CREATE FUNCTION reject_intent_pause_repair_planning_job_v1()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.kind='brief' THEN
           RAISE EXCEPTION 'injected intent-pause replay handoff';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await pool!.query(
      `CREATE TRIGGER reject_intent_pause_repair_planning_job_v1
       BEFORE INSERT ON job_queue
       FOR EACH ROW
       EXECUTE FUNCTION reject_intent_pause_repair_planning_job_v1()`,
    );
    try {
      publicAction = await replayProjection!.getRunRepairReplayAction(runId);
      try {
        await repository!.replayCanonicalRunAfterRepair(replayInput);
      } catch (error) {
        publicReplayError = error;
      }

      await pool!.query(
        `UPDATE research_checkpoints
         SET state_json=$3::jsonb,updated_at=now()
         WHERE run_id=$1 AND phase=$2`,
        [
          runId,
          EXECUTION_ROUTE_RECEIPT_PHASE_V1,
          JSON.stringify(ownerRouteReceipt),
        ],
      );
      ownerAction = await replayProjection!.getRunRepairReplayAction(runId);
      try {
        await repository!.replayCanonicalRunAfterRepair({
          ...replayInput,
          idempotencyKey: ownerIdempotencyKey,
        });
      } catch (error) {
        ownerReplayError = error;
      }
    } finally {
      await pool!.query(
        `UPDATE research_checkpoints
         SET state_json=$3::jsonb,updated_at=now()
         WHERE run_id=$1 AND phase=$2`,
        [
          runId,
          EXECUTION_ROUTE_RECEIPT_PHASE_V1,
          JSON.stringify(publicRouteReceipt),
        ],
      );
      await pool!.query(
        `UPDATE settings
         SET value='false',updated_at=now()
         WHERE key='pipeline_v3_public_assignment_paused:editorial_influence'`,
      );
      await pool!.query(
        `DROP TRIGGER IF EXISTS
           reject_intent_pause_repair_planning_job_v1 ON job_queue`,
      );
      await pool!.query(
        "DROP FUNCTION IF EXISTS reject_intent_pause_repair_planning_job_v1()",
      );
    }

    expect(publicAction).toMatchObject({
      kind: "repair_replay",
      available: false,
      availabilityReason: "route_paused",
    });
    expect(publicReplayError).toMatchObject({
      statusCode: 503,
      code: "repair_replay_route_paused",
    });
    expect(ownerAction).toMatchObject({
      kind: "repair_replay",
      available: true,
      availabilityReason: "ready",
    });
    expect(ownerReplayError).toBeInstanceOf(Error);
    expect((ownerReplayError as Error).message).toContain(
      "injected intent-pause replay handoff",
    );
    const durable = await pool!.query<{
      successor_count: number;
      consumption_count: number;
      job_count: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM brief_requests
          WHERE idempotency_key IN ($1,$2)) successor_count,
         (SELECT count(*)::int FROM research_checkpoints
          WHERE run_id=$3 AND phase=$4) consumption_count,
         (SELECT count(*)::int FROM job_queue
          WHERE kind='brief') job_count`,
      [
        replayInput.idempotencyKey,
        ownerIdempotencyKey,
        runId,
        TECHNICAL_REPAIR_REPLAY_CONSUMPTION_PHASE_V1,
      ],
    );
    expect(durable.rows[0]).toEqual({
      successor_count: 0,
      consumption_count: 0,
      job_count: 0,
    });
  });

  test("CAS-creates one guidance successor without reuse or publication", async () => {
    const idempotencyKey = `technical-replay-${randomUUID()}`;
    const input = {
      runId,
      sourceAccessId,
      capabilitySessionId: sessionId,
      expectedGeneration: 4,
      expectedIncidentReference: incidentReference,
      expectedContractRevisionId: contractRevisionId,
      expectedContractSemanticHash: contractSemanticHash,
      idempotencyKey,
    };
    await pool!.query(
      `CREATE FUNCTION reject_repair_planning_job_v1()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.kind='brief' THEN
           RAISE EXCEPTION 'injected repair planning handoff failure';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await pool!.query(
      `CREATE TRIGGER reject_repair_planning_job_v1
       BEFORE INSERT ON job_queue
       FOR EACH ROW EXECUTE FUNCTION reject_repair_planning_job_v1()`,
    );
    try {
      await expect(
        repository!.replayCanonicalRunAfterRepair(input),
      ).rejects.toThrow("injected repair planning handoff failure");
    } finally {
      await pool!.query(
        "DROP TRIGGER reject_repair_planning_job_v1 ON job_queue",
      );
      await pool!.query("DROP FUNCTION reject_repair_planning_job_v1()");
    }
    const rolledBack = await pool!.query<{
      successor_count: number;
      consumption_count: number;
      job_count: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM brief_requests
          WHERE idempotency_key=$1) successor_count,
         (SELECT count(*)::int FROM research_checkpoints
          WHERE run_id=$2 AND phase=$3) consumption_count,
         (SELECT count(*)::int FROM job_queue
          WHERE kind='brief') job_count`,
      [
        idempotencyKey,
        runId,
        TECHNICAL_REPAIR_REPLAY_CONSUMPTION_PHASE_V1,
      ],
    );
    expect(rolledBack.rows[0]).toEqual({
      successor_count: 0,
      consumption_count: 0,
      job_count: 0,
    });

    const created = await repository!.replayCanonicalRunAfterRepair(input);
    expect(created).toMatchObject({
      created: true,
      status: "queued",
      successorKind: "v5_1_planning_successor",
      resultReuse: false,
      autoPublication: false,
    });
    const replay = await repository!.replayCanonicalRunAfterRepair(input);
    expect(replay).toEqual({ ...created, created: false });

    const persisted = await pool!.query<{
      status: string;
      requested_track_count: number;
      public_rollout_assignment_json: unknown;
      run_count: number;
      job_count: number;
      job_status: string;
      job_pipeline_version: string;
      job_minimum_worker_protocol: number;
      job_payload: unknown;
      session_brief_count: number;
      consumption_count: number;
    }>(
      `SELECT brief.status,brief.requested_track_count,
              brief.public_rollout_assignment_json,
              (SELECT count(*)::int FROM research_runs candidate_run
               JOIN run_accesses candidate_access
                 ON candidate_access.run_id=candidate_run.id
               WHERE candidate_access.brief_request_id=brief.id) run_count,
              (SELECT count(*)::int FROM job_queue job
               WHERE job.brief_request_id=brief.id
                 AND job.kind='brief') job_count,
              (SELECT status FROM job_queue job
               WHERE job.brief_request_id=brief.id
                 AND job.kind='brief') job_status,
              (SELECT pipeline_version FROM job_queue job
               WHERE job.brief_request_id=brief.id
                 AND job.kind='brief') job_pipeline_version,
              (SELECT minimum_worker_protocol FROM job_queue job
               WHERE job.brief_request_id=brief.id
                 AND job.kind='brief') job_minimum_worker_protocol,
              (SELECT payload_json FROM job_queue job
               WHERE job.brief_request_id=brief.id
                 AND job.kind='brief') job_payload,
              (SELECT count(*)::int
               FROM capability_session_briefs session_brief
               WHERE session_brief.session_id=$2
                 AND session_brief.brief_request_id=brief.id)
                session_brief_count,
              (SELECT count(*)::int
               FROM research_checkpoints checkpoint
               WHERE checkpoint.run_id=$3 AND checkpoint.phase=$4)
                consumption_count
       FROM brief_requests brief
       WHERE brief.id=$1`,
      [
        created.briefRequestId,
        sessionId,
        runId,
        TECHNICAL_REPAIR_REPLAY_CONSUMPTION_PHASE_V1,
      ],
    );
    expect(persisted.rows[0]).toMatchObject({
      status: "queued",
      requested_track_count: 25,
      public_rollout_assignment_json: null,
      run_count: 0,
      job_count: 1,
      job_status: "queued",
      job_pipeline_version: "legacy_v1",
      job_minimum_worker_protocol: 10,
      job_payload: { briefRequestId: created.briefRequestId },
      session_brief_count: 1,
      consumption_count: 1,
    });

    // Simulate the pre-fix commit/response seam: the authority is consumed and
    // the planning successor exists, but its handoff disappeared. The exact
    // idempotent request must reconstruct one job without another successor or
    // consumption.
    await pool!.query(
      `DELETE FROM job_queue
       WHERE brief_request_id=$1 AND kind='brief'`,
      [created.briefRequestId],
    );
    const reconciled = await repository!.replayCanonicalRunAfterRepair(input);
    expect(reconciled).toEqual({ ...created, created: false });
    const afterReconcile = await pool!.query<{
      job_count: number;
      consumption_count: number;
      successor_count: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM job_queue
          WHERE brief_request_id=$1 AND kind='brief') job_count,
         (SELECT count(*)::int FROM research_checkpoints
          WHERE run_id=$2 AND phase=$3) consumption_count,
         (SELECT count(*)::int FROM brief_requests
          WHERE idempotency_key=$4) successor_count`,
      [
        created.briefRequestId,
        runId,
        TECHNICAL_REPAIR_REPLAY_CONSUMPTION_PHASE_V1,
        idempotencyKey,
      ],
    );
    expect(afterReconcile.rows[0]).toEqual({
      job_count: 1,
      consumption_count: 1,
      successor_count: 1,
    });

    await expect(repository!.replayCanonicalRunAfterRepair({
      ...input,
      idempotencyKey: `technical-replay-${randomUUID()}`,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "technical_repair_already_used",
    });
    await expect(repository!.replayCanonicalRunAfterRepair({
      ...input,
      expectedGeneration: 5,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "repair_replay_stale",
    });
  });
});
