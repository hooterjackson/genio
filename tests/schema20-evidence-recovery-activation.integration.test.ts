import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Client, Pool } from "pg";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "vitest";
import {
  executeSchema20EvidenceRecoveryTransition,
  schema20EvidenceRecoveryPreflight,
} from "../scripts/activate-schema20-evidence-recovery.ts";
import {
  executeLegacyExecutionRouteDrainInventoryV1,
} from "../scripts/inventory-legacy-execution-route-drain.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseDescribe = databaseUrl ? describe.sequential : describe.skip;
const migrationDirectory = new URL("../postgres-migrations/", import.meta.url);
const migrationFiles = readdirSync(migrationDirectory)
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort();

databaseDescribe("schema-20 evidence recovery activation", () => {
  const schemaName =
    `genio_schema20_evidence_recovery_${
      randomUUID().replaceAll("-", "")
    }`;
  const expectedRevision = "c".repeat(40);
  const expectedSemanticConfigurationHash = "d".repeat(64);
  const legacyQualificationId = randomUUID();
  const runId = randomUUID();
  const contractRevisionId = randomUUID();
  const candidateId = randomUUID();
  let adminPool: Pool | undefined;
  let pool: Pool | undefined;
  let activationClient: Client | undefined;

  beforeAll(async () => {
    adminPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: "genio-schema20-evidence-recovery-admin",
    });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 4,
      application_name: "genio-schema20-evidence-recovery",
    });
    for (const file of migrationFiles) {
      await pool.query(readFileSync(
        new URL(`../postgres-migrations/${file}`, import.meta.url),
        "utf8",
      ));
    }

    await pool.query(
      `INSERT INTO settings(key,value)
       VALUES('pipeline_v3_public_assignment_paused','true')
       ON CONFLICT(key) DO UPDATE
       SET value=EXCLUDED.value,updated_at=now()`,
    );
    await pool.query(
      `DELETE FROM pipeline_cohort_kill_switches
       WHERE route='corpus_first_v3'
         AND intent_group='editorial_influence'`,
    );
    await pool.query(
      `INSERT INTO pipeline_cohort_kill_switches(
         cohort_key,route,intent_group,disabled,reason_code,changed_by
       ) VALUES(
         'schema20-evidence-recovery-test','corpus_first_v3',
         'editorial_influence',true,
         'schema20_evidence_recovery_test','integration-test'
       )`,
    );
    await pool.query("DELETE FROM worker_heartbeats");
    await pool.query(
      `INSERT INTO worker_heartbeats(
         worker_id,schema_version,capacity,active_jobs,metadata_json,
         started_at,last_seen_at
       ) VALUES
       (
         'schema20-recovery-interactive','20',1,0,
         jsonb_build_object(
           'protocolNumber',12,
           'queueClass','interactive',
           'observedSchemaVersion','20',
           'version',$1::text,
           'semanticExecutionConfigurationHash',$2::text
         ),
         now(),now()
       ),
       (
         'schema20-recovery-deep','20',1,0,
         jsonb_build_object(
           'protocolNumber',12,
           'queueClass','deep',
           'observedSchemaVersion','20',
           'version',$1::text,
           'semanticExecutionConfigurationHash',$2::text
         ),
         now(),now()
       ),
       (
         'schema20-recovery-old-interactive','20',1,0,
         jsonb_build_object(
           'protocolNumber',12,
           'queueClass','interactive',
           'observedSchemaVersion','20',
           'version',$1::text,
           'semanticExecutionConfigurationHash',$2::text
         ),
         now()-interval '2 minutes',now()-interval '2 minutes'
       )`,
      [expectedRevision, expectedSemanticConfigurationHash],
    );

    await pool.query(
      `INSERT INTO research_runs(
         id,prompt,brief_json,brief_hash,status,phase,client_bucket,
         idempotency_key,retention_expires_at,pipeline_version,policy_version
       ) VALUES(
         $1,'schema20 evidence recovery','{}'::jsonb,$2,'needs_decision',
         'capability_evidence_coverage_audit','schema20-recovery-test',$3,
         now()+interval '1 day','corpus_first_v3',
         'corpus_first_v3_policy_v1'
       )`,
      [runId, "1".repeat(64), `schema20-recovery:${runId}`],
    );
    await pool.query(
      `INSERT INTO playlist_contract_revisions(
         id,run_id,revision,status,contract_hash,contract_json,
         compiler_version,ontology_version,evidence_policy_version,
         question_template_version,catalog_policy_version,locale,storefront,
         answer_lineage_hash
       ) VALUES(
         $1,$2,1,'active',$3,'{}'::jsonb,'compiler-test','ontology-test',
         'evidence-test','questions-test','catalog-test','en-US','us',$4
       )`,
      [
        contractRevisionId,
        runId,
        "2".repeat(64),
        "3".repeat(64),
      ],
    );
    await pool.query(
      `UPDATE research_runs
       SET active_playlist_contract_revision_id=$2
       WHERE id=$1`,
      [runId, contractRevisionId],
    );
    await pool.query(
      `INSERT INTO playlist_qualification_records(
         id,run_id,contract_revision_id,candidate_id,stable_identity_hash,
         storefront,predicate_results_json,evidence_record_ids_json,
         quality_result_json,catalog_result_json,decision,qualification_hash
       ) VALUES(
         $1,$2,$3,NULL,$4,'us','{}'::jsonb,'[]'::jsonb,'{}'::jsonb,
         '{}'::jsonb,'unknown',$5
       )`,
      [
        legacyQualificationId,
        runId,
        contractRevisionId,
        "4".repeat(64),
        "5".repeat(64),
      ],
    );
    await pool.query(
      `INSERT INTO track_candidates(
         id,run_id,canonical_key,artist,title,pipeline_version,policy_version
       ) VALUES(
         $1,$2,'schema20-recovery:candidate','Test Artist','Test Track',
         'corpus_first_v3','corpus_first_v3_policy_v1'
       )`,
      [candidateId, runId],
    );

    activationClient = new Client({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      application_name: "genio-schema20-evidence-recovery-activation",
    });
    await activationClient.connect();
  }, 60_000);

  afterAll(async () => {
    await activationClient?.end();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(
        `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`,
      );
      await adminPool.end();
    }
  }, 30_000);

  test("rejects worker schema drift and non-exclusive eligible lanes", async () => {
    const database = pool!;
    const client = activationClient!;
    await database.query(
      `UPDATE worker_heartbeats
       SET metadata_json=jsonb_set(
         metadata_json,'{observedSchemaVersion}','"19"'::jsonb
       )
       WHERE worker_id='schema20-recovery-deep'`,
    );
    expect((await schema20EvidenceRecoveryPreflight(
      client,
      expectedRevision,
      expectedSemanticConfigurationHash,
    )).violations).toContain("worker_observed_schema_mismatch");
    await database.query(
      `UPDATE worker_heartbeats
       SET metadata_json=jsonb_set(
         metadata_json,'{observedSchemaVersion}','"20"'::jsonb
       )
       WHERE worker_id='schema20-recovery-deep'`,
    );
    await database.query(
      `INSERT INTO worker_heartbeats(
         worker_id,schema_version,capacity,active_jobs,metadata_json,
         started_at,last_seen_at
       ) VALUES(
         'schema20-recovery-extra','20',1,0,
         jsonb_build_object(
           'protocolNumber',12,
           'queueClass','interactive',
           'observedSchemaVersion','20',
           'version',$1::text,
           'semanticExecutionConfigurationHash',$2::text
         ),
         now(),now()
       )`,
      [expectedRevision, expectedSemanticConfigurationHash],
    );
    expect((await schema20EvidenceRecoveryPreflight(
      client,
      expectedRevision,
      expectedSemanticConfigurationHash,
    )).violations).toContain(
      "eligible_worker_lane_cardinality_mismatch",
    );
    await database.query(
      "DELETE FROM worker_heartbeats WHERE worker_id=$1",
      ["schema20-recovery-extra"],
    );
  });

  test("fences queued and retry legacy jobs whose query plan is null", async () => {
    const database = pool!;
    const client = activationClient!;
    const queuedRunId = randomUUID();
    const retryRunId = randomUUID();
    const queuedJobId = randomUUID();
    const retryJobId = randomUUID();
    for (const [legacyRunId, legacyJobId, status] of [
      [queuedRunId, queuedJobId, "queued"],
      [retryRunId, retryJobId, "retry"],
    ] as const) {
      await database.query(
        `INSERT INTO research_runs(
           id,prompt,brief_json,brief_hash,status,phase,client_bucket,
           idempotency_key,retention_expires_at,pipeline_version,policy_version
         ) VALUES(
           $1,'legacy route drain','{}'::jsonb,$2,'queued','queued',
           'schema20-recovery-test',$3,now()+interval '1 day','pipeline_v2',
           'pipeline_v2_policy_v1'
         )`,
        [legacyRunId, "a".repeat(64), `legacy-drain:${legacyRunId}`],
      );
      await database.query(
        `INSERT INTO job_queue(
           id,run_id,kind,status,dedupe_key,payload_json,pipeline_version,
           minimum_worker_protocol,stage_key
         ) VALUES(
           $1,$2,'research',$3,$4,'{}'::jsonb,'pipeline_v2',7,$5
         )`,
        [
          legacyJobId,
          legacyRunId,
          status,
          `legacy-drain:${legacyJobId}`,
          `legacy-v2-${status}`,
        ],
      );
    }
    const inventoriedAt = new Date(Date.now() + 60_000).toISOString();
    const common = {
      acceptedBefore: inventoriedAt,
      inventoriedAt,
      targetReleaseRevision: expectedRevision,
      targetSemanticConfigurationHash:
        expectedSemanticConfigurationHash,
    };
    const dryRun = await executeLegacyExecutionRouteDrainInventoryV1(
      client,
      {
        mode: "dry-run",
        expectedReceiptHash: null,
        ...common,
      },
    );
    expect(dryRun).toMatchObject({
      mode: "dry-run",
      safeToApply: true,
      runCount: 2,
      jobCount: 2,
    });
    const receiptHash = String(dryRun.receiptHash);
    await expect(executeLegacyExecutionRouteDrainInventoryV1(client, {
      mode: "apply",
      expectedReceiptHash: receiptHash,
      ...common,
    })).resolves.toMatchObject({
      mode: "apply",
      applied: true,
      receiptHash,
      runCount: 2,
      jobCount: 2,
    });
    expect((await database.query(
      `SELECT id,status,query_plan_revision_id,
              required_executor_revision,
              required_executor_semantic_configuration_hash
       FROM job_queue
       WHERE id=ANY($1::uuid[])
       ORDER BY status,id`,
      [[queuedJobId, retryJobId]],
    )).rows).toEqual([
      {
        id: queuedJobId,
        status: "queued",
        query_plan_revision_id: null,
        required_executor_revision: expectedRevision,
        required_executor_semantic_configuration_hash:
          expectedSemanticConfigurationHash,
      },
      {
        id: retryJobId,
        status: "retry",
        query_plan_revision_id: null,
        required_executor_revision: expectedRevision,
        required_executor_semantic_configuration_hash:
          expectedSemanticConfigurationHash,
      },
    ]);
  });

  test("rejects an already validated candidate binding constraint", async () => {
    const database = pool!;
    const client = activationClient!;
    await database.query(
      `UPDATE playlist_qualification_records
       SET candidate_id=$2
       WHERE id=$1`,
      [legacyQualificationId, candidateId],
    );
    await database.query(
      `ALTER TABLE playlist_qualification_records
       ADD CONSTRAINT playlist_qualification_candidate_required_v1
       CHECK (candidate_id IS NOT NULL)`,
    );
    try {
      const preflight = await schema20EvidenceRecoveryPreflight(
        client,
        expectedRevision,
        expectedSemanticConfigurationHash,
      );
      expect(preflight.constraintPresent).toBe(true);
      expect(preflight.constraintValidated).toBe(true);
      expect(preflight.constraintDefinitionValid).toBe(true);
      expect(preflight.violations).toContain(
        "candidate_constraint_unexpectedly_validated",
      );
      await expect(executeSchema20EvidenceRecoveryTransition(
        client,
        "apply",
        null,
        expectedRevision,
        expectedSemanticConfigurationHash,
      )).rejects.toThrow(
        "schema20_evidence_recovery_preflight_failed:"
          + "candidate_constraint_unexpectedly_validated",
      );
    } finally {
      await database.query(
        `ALTER TABLE playlist_qualification_records
         DROP CONSTRAINT playlist_qualification_candidate_required_v1`,
      );
      await database.query(
        `UPDATE playlist_qualification_records
         SET candidate_id=NULL
         WHERE id=$1`,
        [legacyQualificationId],
      );
    }
  });

  test("preserves legacy null-bound rows as immutable and requires bindings for new rows", async () => {
    const database = pool!;
    const client = activationClient!;
    const preflight = await schema20EvidenceRecoveryPreflight(
      client,
      expectedRevision,
      expectedSemanticConfigurationHash,
    );
    expect(preflight).toMatchObject({
      schemaVersion: "20",
      recoveryVersion: null,
      constraintPresent: false,
      constraintValidated: false,
      constraintDefinitionValid: false,
      routeTriggerPresent: false,
      routeTriggerDefinitionValid: false,
      legacyUnboundImmutabilityTriggerPresent: false,
      legacyUnboundImmutabilityTriggerDefinitionValid: false,
      publicAssignmentPaused: true,
      hardSwitchEngaged: true,
      activeV3Jobs: 0,
      activeV3Attempts: 0,
      activePublicationReconciliations: 0,
      workerStaleSeconds: 90,
      violations: [],
      liveWorkers: [
        {
          protocolNumber: 12,
          queueClass: "deep",
          observedSchemaVersion: "20",
          executorRevision: expectedRevision,
          semanticConfigurationHash:
            expectedSemanticConfigurationHash,
        },
        {
          protocolNumber: 12,
          queueClass: "interactive",
          observedSchemaVersion: "20",
          executorRevision: expectedRevision,
          semanticConfigurationHash:
            expectedSemanticConfigurationHash,
        },
      ],
    });

    const dryRun = await executeSchema20EvidenceRecoveryTransition(
      client,
      "dry-run",
      null,
      expectedRevision,
      expectedSemanticConfigurationHash,
    );
    expect(dryRun).toMatchObject({
      mode: "dry-run",
      safeToApply: true,
      receipt: {
        receiptVersion: "schema20-evidence-recovery-receipt/v3",
        target: {
          legacyUnboundImmutabilityTrigger:
            "legacy_unbound_qualification_immutable_v1",
          legacyRows:
            "preserved_read_only_recovery_requires_linked_successor",
        },
      },
    });
    const receiptHash = dryRun.receiptHash;
    expect(receiptHash).toMatch(/^[0-9a-f]{64}$/u);
    expect((await database.query(
      `SELECT count(*)::int count
       FROM pg_constraint
       WHERE conrelid='playlist_qualification_records'::regclass
         AND conname='playlist_qualification_candidate_required_v1'`,
    )).rows[0]?.count).toBe(0);
    expect((await database.query(
      `SELECT value FROM settings
       WHERE key='schema20_evidence_recovery_version'`,
    )).rowCount).toBe(0);

    await expect(executeSchema20EvidenceRecoveryTransition(
      client,
      "apply",
      "0".repeat(64),
      expectedRevision,
      expectedSemanticConfigurationHash,
    )).rejects.toThrow(
      "schema20_evidence_recovery_receipt_hash_mismatch",
    );
    expect((await database.query(
      `SELECT count(*)::int count
       FROM pg_constraint
       WHERE conrelid='playlist_qualification_records'::regclass
         AND conname='playlist_qualification_candidate_required_v1'`,
    )).rows[0]?.count).toBe(0);

    await database.query(
      `INSERT INTO settings(key,value)
       VALUES($1,$2)`,
      [
        `schema20_evidence_recovery_receipt:${receiptHash}`,
        JSON.stringify({
          ...(dryRun.receipt as Record<string, unknown>),
          conflictingValue: true,
        }),
      ],
    );
    await expect(executeSchema20EvidenceRecoveryTransition(
      client,
      "apply",
      String(receiptHash),
      expectedRevision,
      expectedSemanticConfigurationHash,
    )).rejects.toThrow("schema20_evidence_recovery_receipt_conflict");
    expect((await database.query(
      `SELECT value FROM settings
       WHERE key='schema20_evidence_recovery_active_receipt_hash'`,
    )).rowCount).toBe(0);
    expect((await database.query(
      `SELECT value FROM settings
       WHERE key='schema20_evidence_recovery_version'`,
    )).rowCount).toBe(0);
    await database.query(
      `DELETE FROM settings WHERE key=$1`,
      [`schema20_evidence_recovery_receipt:${receiptHash}`],
    );

    await expect(executeSchema20EvidenceRecoveryTransition(
      client,
      "apply",
      String(receiptHash),
      expectedRevision,
      expectedSemanticConfigurationHash,
    )).resolves.toMatchObject({
      mode: "apply",
      applied: true,
      receiptHash,
      constraint:
        "playlist_qualification_candidate_required_v1",
      constraintValidated: false,
      routeTrigger: "contract3_execution_route_receipt_required_v1",
      legacyUnboundImmutabilityTrigger:
        "legacy_unbound_qualification_immutable_v1",
    });

    expect((await database.query<{
      convalidated: boolean;
    }>(
      `SELECT convalidated
       FROM pg_constraint
       WHERE conrelid='playlist_qualification_records'::regclass
         AND conname='playlist_qualification_candidate_required_v1'`,
    )).rows[0]?.convalidated).toBe(false);
    expect((await database.query(
      `SELECT count(*)::int count
       FROM pg_trigger
       WHERE tgrelid='job_queue'::regclass
         AND tgname='contract3_execution_route_receipt_required_v1'
       AND NOT tgisinternal`,
    )).rows[0]?.count).toBe(1);
    expect((await database.query(
      `SELECT count(*)::int count
       FROM pg_trigger trigger
       JOIN pg_proc procedure ON procedure.oid=trigger.tgfoid
       WHERE trigger.tgrelid='playlist_qualification_records'::regclass
         AND trigger.tgname='legacy_unbound_qualification_immutable_v1'
         AND trigger.tgtype=19
         AND trigger.tgqual IS NOT NULL
         AND procedure.proname=
           'enforce_legacy_unbound_qualification_immutable_v1'
         AND NOT trigger.tgisinternal`,
    )).rows[0]?.count).toBe(1);
    expect((await database.query(
      `SELECT id,candidate_id
       FROM playlist_qualification_records
       WHERE id=$1`,
      [legacyQualificationId],
    )).rows).toEqual([{
      id: legacyQualificationId,
      candidate_id: null,
    }]);
    await expect(database.query(
      `UPDATE playlist_qualification_records
       SET decision=decision
       WHERE id=$1`,
      [legacyQualificationId],
    )).rejects.toMatchObject({
      code: "23514",
      constraint:
        "legacy_unbound_qualification_immutable_v1",
    });
    await expect(database.query(
      `UPDATE playlist_qualification_records
       SET candidate_id=$2
       WHERE id=$1`,
      [legacyQualificationId, candidateId],
    )).rejects.toMatchObject({
      code: "23514",
      constraint:
        "legacy_unbound_qualification_immutable_v1",
    });
    expect((await database.query(
      `SELECT candidate_id
       FROM playlist_qualification_records
       WHERE id=$1`,
      [legacyQualificationId],
    )).rows[0]?.candidate_id).toBeNull();
    expect((await database.query<{ value: string }>(
      `SELECT value FROM settings
       WHERE key='schema20_evidence_recovery_version'`,
    )).rows[0]?.value).toBe("3");
    expect((await database.query<{ value: string }>(
      `SELECT value FROM settings
       WHERE key=$1`,
      [`schema20_evidence_recovery_receipt:${receiptHash}`],
    )).rowCount).toBe(1);
    expect((await database.query<{ value: string }>(
      `SELECT value FROM settings
       WHERE key='schema20_evidence_recovery_active_receipt_hash'`,
    )).rows[0]?.value).toBe(receiptHash);

    await expect(executeSchema20EvidenceRecoveryTransition(
      client,
      "dry-run",
      null,
      expectedRevision,
      expectedSemanticConfigurationHash,
    )).resolves.toMatchObject({
      mode: "dry-run",
      safeToApply: true,
      alreadyApplied: true,
      receiptHash,
    });
    await expect(executeSchema20EvidenceRecoveryTransition(
      client,
      "apply",
      String(receiptHash),
      expectedRevision,
      expectedSemanticConfigurationHash,
    )).resolves.toMatchObject({
      mode: "apply",
      applied: true,
      alreadyApplied: true,
      receiptHash,
    });
    await expect(executeSchema20EvidenceRecoveryTransition(
      client,
      "apply",
      "a".repeat(64),
      expectedRevision,
      expectedSemanticConfigurationHash,
    )).rejects.toThrow(
      "schema20_evidence_recovery_receipt_hash_mismatch",
    );

    await expect(database.query(
      `INSERT INTO playlist_qualification_records(
         id,run_id,contract_revision_id,candidate_id,stable_identity_hash,
         storefront,predicate_results_json,evidence_record_ids_json,
         quality_result_json,catalog_result_json,decision,qualification_hash
       ) VALUES(
         $1,$2,$3,NULL,$4,'us','{}'::jsonb,'[]'::jsonb,'{}'::jsonb,
         '{}'::jsonb,'unknown',$5
       )`,
      [
        randomUUID(),
        runId,
        contractRevisionId,
        "6".repeat(64),
        "7".repeat(64),
      ],
    )).rejects.toMatchObject({
      code: "23514",
      constraint:
        "playlist_qualification_candidate_required_v1",
    });

    const boundQualificationId = randomUUID();
    await expect(database.query(
      `INSERT INTO playlist_qualification_records(
         id,run_id,contract_revision_id,candidate_id,stable_identity_hash,
         storefront,predicate_results_json,evidence_record_ids_json,
         quality_result_json,catalog_result_json,decision,qualification_hash
       ) VALUES(
         $1,$2,$3,$4,$5,'us','{}'::jsonb,'[]'::jsonb,'{}'::jsonb,
         '{}'::jsonb,'qualified',$6
       )`,
      [
        boundQualificationId,
        runId,
        contractRevisionId,
        candidateId,
        "8".repeat(64),
        "9".repeat(64),
      ],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(database.query(
      `UPDATE playlist_qualification_records
       SET decision=decision
       WHERE id=$1`,
      [boundQualificationId],
    )).resolves.toMatchObject({ rowCount: 1 });
    expect((await database.query(
      `SELECT candidate_id
       FROM playlist_qualification_records
       WHERE id=$1`,
      [boundQualificationId],
    )).rows[0]?.candidate_id).toBe(candidateId);

    await expect(database.query(
      `INSERT INTO job_queue(
         id,run_id,kind,dedupe_key,payload_json,pipeline_version,
         minimum_worker_protocol,stage_key)
       VALUES(
         $1,$2,'research',$3,'{}'::jsonb,'pipeline_v2',7,'test-v2'
       )`,
      [randomUUID(), runId, `missing-v2-route:${randomUUID()}`],
    )).rejects.toMatchObject({
      code: "23514",
      constraint: "contract3_execution_route_receipt_required_v1",
    });

    await database.query(
      "UPDATE research_runs SET brief_contract_version=3 WHERE id=$1",
      [runId],
    );
    await expect(database.query(
      `INSERT INTO job_queue(
         id,run_id,kind,dedupe_key,payload_json,pipeline_version,
         minimum_worker_protocol,stage_key)
       VALUES(
         $1,$2,'research',$3,'{}'::jsonb,'corpus_first_v3',12,'test'
       )`,
      [randomUUID(), runId, `missing-route:${randomUUID()}`],
    )).rejects.toMatchObject({
      code: "23514",
      constraint: "contract3_execution_route_receipt_required_v1",
    });

    const stagedJobId = randomUUID();
    await expect(database.query(
      `INSERT INTO job_queue(
         id,run_id,kind,dedupe_key,payload_json,pipeline_version,
         minimum_worker_protocol,stage_key)
       VALUES(
         $1,$2,'retention',$3,'{}'::jsonb,'corpus_first_v3',12,
         'staged-non-executable'
       )`,
      [stagedJobId, runId, `staged-route:${randomUUID()}`],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(database.query(
      `UPDATE job_queue SET kind='research' WHERE id=$1`,
      [stagedJobId],
    )).rejects.toMatchObject({
      code: "23514",
      constraint: "contract3_execution_route_receipt_required_v1",
    });

    const activated = await schema20EvidenceRecoveryPreflight(
      client,
      expectedRevision,
      expectedSemanticConfigurationHash,
    );
    expect(activated).toMatchObject({
      constraintDefinitionValid: true,
      routeTriggerDefinitionValid: true,
      legacyUnboundImmutabilityTriggerDefinitionValid: true,
    });
    await database.query(
      `DROP TRIGGER legacy_unbound_qualification_immutable_v1
       ON playlist_qualification_records;
       CREATE TRIGGER legacy_unbound_qualification_immutable_v1
       BEFORE UPDATE ON playlist_qualification_records
       FOR EACH ROW
       WHEN (OLD.candidate_id IS NOT NULL)
       EXECUTE FUNCTION enforce_legacy_unbound_qualification_immutable_v1()`,
    );
    const conditionDrift = await schema20EvidenceRecoveryPreflight(
      client,
      expectedRevision,
      expectedSemanticConfigurationHash,
    );
    expect(
      conditionDrift.legacyUnboundImmutabilityTriggerPresent,
    ).toBe(true);
    expect(
      conditionDrift.legacyUnboundImmutabilityTriggerDefinitionValid,
    ).toBe(false);
    expect(conditionDrift.violations).toContain(
      "legacy_unbound_trigger_definition_mismatch",
    );
    await database.query(
      `DROP TRIGGER legacy_unbound_qualification_immutable_v1
       ON playlist_qualification_records;
       CREATE TRIGGER legacy_unbound_qualification_immutable_v1
       BEFORE UPDATE ON playlist_qualification_records
       FOR EACH ROW
       WHEN (OLD.candidate_id IS NULL)
       EXECUTE FUNCTION enforce_legacy_unbound_qualification_immutable_v1()`,
    );
    await database.query(
      `CREATE OR REPLACE FUNCTION
         enforce_contract3_execution_route_receipt_v1()
       RETURNS trigger LANGUAGE plpgsql
       AS $function$BEGIN RETURN NEW; END$function$`,
    );
    const drifted = await schema20EvidenceRecoveryPreflight(
      client,
      expectedRevision,
      expectedSemanticConfigurationHash,
    );
    expect(drifted.routeTriggerPresent).toBe(true);
    expect(drifted.routeTriggerDefinitionValid).toBe(false);
    expect(drifted.violations).toContain(
      "route_trigger_definition_mismatch",
    );
    await expect(executeSchema20EvidenceRecoveryTransition(
      client,
      "status",
      null,
      expectedRevision,
      expectedSemanticConfigurationHash,
    )).rejects.toThrow(
      "schema20_evidence_recovery_existing_activation_invalid",
    );
  });
});
