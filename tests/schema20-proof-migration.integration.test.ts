import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  executeSchema20ProofAuthorityTransition,
} from "../scripts/activate-schema20-proof-authority.ts";
import {
  executeSchema20ProofBackfill,
} from "../scripts/backfill-schema20-proof-architecture.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseDescribe = databaseUrl ? describe.sequential : describe.skip;
const migrationDirectory = new URL("../postgres-migrations/", import.meta.url);
const migrationFiles = readdirSync(migrationDirectory)
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort();

databaseDescribe("schema-20 immutable proof migration", () => {
  const schemaName =
    `genio_schema20_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool | undefined;
  let pool: Pool | undefined;
  let activationClient: Client | undefined;

  beforeAll(async () => {
    adminPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: "genio-schema20-admin",
    });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 4,
      application_name: "genio-schema20-proof",
    });
    for (const file of migrationFiles) {
      await pool.query(readFileSync(
        new URL(`../postgres-migrations/${file}`, import.meta.url),
        "utf8",
      ));
    }
    activationClient = new Client({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      application_name: "genio-schema20-activation",
    });
    await activationClient.connect();
  }, 60_000);

  afterAll(async () => {
    await activationClient?.end();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  }, 30_000);

  test("expands schema 19 additively and leaves proof authority in shadow", async () => {
    const database = pool!;
    const settings = await database.query<{ key: string; value: string }>(
      `SELECT key,value FROM settings
       WHERE key IN (
         'schema_version','proof_architecture_version',
         'proof_architecture_authority'
       )
       ORDER BY key`,
    );
    expect(settings.rows).toEqual([
      { key: "proof_architecture_authority", value: "shadow" },
      { key: "proof_architecture_version", value: "1" },
      { key: "schema_version", value: "20" },
    ]);
    expect((await database.query(
      `SELECT to_regclass('canonical_track_identities') identity,
              to_regclass('immutable_selection_sets') selection_set,
              to_regclass('selection_attempt_output_attestations') output`,
    )).rows[0]).toEqual({
      identity: "canonical_track_identities",
      selection_set: "immutable_selection_sets",
      output: "selection_attempt_output_attestations",
    });
    expect((await database.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname=current_schema()
         AND indexname IN (
           'manifest_revision_hash_idx',
           'manifest_revision_content_attestation_shadow_idx'
         )
       ORDER BY indexname`,
    )).rows.map(({ indexname }) => indexname)).toEqual([
      "manifest_revision_content_attestation_shadow_idx",
      "manifest_revision_hash_idx",
    ]);
  });

  test("stores one immutable, attempt-fenced selected proof graph", async () => {
    const database = pool!;
    const runId = randomUUID();
    const contractId = randomUUID();
    const selectionPlanId = randomUUID();
    const graphSnapshotId = randomUUID();
    const queryPlanId = randomUUID();
    const attemptId = randomUUID();
    const familyId = randomUUID();
    const candidateId = randomUUID();
    const sourceQualificationId = randomUUID();
    const identityId = randomUUID();
    const observationId = randomUUID();
    const selectionQualificationId = randomUUID();
    const selectionSetId = randomUUID();
    const contractHash = "1".repeat(64);
    const queryPlanHash = "2".repeat(64);
    const identityHash = "3".repeat(64);
    const observationHash = "4".repeat(64);
    const qualificationHash = "5".repeat(64);
    const attestationSetHash = "6".repeat(64);
    const outputHash = "7".repeat(64);

    await database.query(
      `INSERT INTO research_runs(
         id,prompt,brief_json,brief_hash,status,phase,client_bucket,
         idempotency_key,retention_expires_at,pipeline_version,policy_version
       ) VALUES(
         $1,'schema20 proof','{}'::jsonb,$2,'researching','qualification',
         'schema20-test',$3,now()+interval '1 day','corpus_first_v3',
         'corpus_first_v3_policy_v1'
       )`,
      [runId, "a".repeat(64), randomUUID()],
    );
    await database.query(
      `INSERT INTO playlist_contract_revisions(
         id,run_id,revision,status,contract_hash,contract_json,
         compiler_version,ontology_version,evidence_policy_version,
         question_template_version,catalog_policy_version,locale,storefront,
         answer_lineage_hash)
       VALUES($1,$2,1,'active',$3,'{}'::jsonb,'compiler','ontology',
         'evidence','questions','catalog','en','us',$4)`,
      [contractId, runId, contractHash, "b".repeat(64)],
    );
    await database.query(
      `UPDATE research_runs
       SET active_playlist_contract_revision_id=$2 WHERE id=$1`,
      [runId, contractId],
    );
    await database.query(
      `INSERT INTO selection_plans(
         id,run_id,revision,status,plan_hash,plan_json,pipeline_version,
         policy_version,confirmed_at)
       VALUES($1,$2,1,'active',$3,'{}'::jsonb,'corpus_first_v3',
         'corpus_first_v3_policy_v1',now())`,
      [selectionPlanId, runId, "c".repeat(64)],
    );
    await database.query(
      `INSERT INTO graph_snapshots(
         id,status,content_hash,assertion_count,catalog_identity_count,locked_at)
       VALUES($1,'locked',$2,0,0,now())`,
      [graphSnapshotId, "d".repeat(64)],
    );
    await database.query(
      `INSERT INTO query_plan_revisions(
         id,run_id,selection_plan_id,revision,graph_snapshot_id,engine,status,
         plan_hash,plan_json,pipeline_version,policy_version,activated_at)
       VALUES($1,$2,$3,1,$4,'portfolio','active',$5,'{}'::jsonb,
         'corpus_first_v3','corpus_first_v3_policy_v1',now())`,
      [queryPlanId, runId, selectionPlanId, graphSnapshotId, queryPlanHash],
    );
    await database.query(
      `INSERT INTO playlist_execution_attempts(
         id,run_id,contract_revision_id,query_plan_revision_id,stage,
         attempt_number,lease_generation,executor_revision,
         executor_identity_hash,configuration_hash,idempotency_key,status,
         last_active_at)
       VALUES($1,$2,$3,$4,'qualification',1,1,'revision',
         $5,$6,$7,'complete',now())`,
      [
        attemptId,
        runId,
        contractId,
        queryPlanId,
        "e".repeat(64),
        "f".repeat(64),
        randomUUID(),
      ],
    );
    await database.query(
      `INSERT INTO recording_families(
         id,run_id,family_key,canonical_artist,canonical_title,
         pipeline_version,policy_version)
       VALUES($1,$2,'isrc:TEST','Artist','Track','corpus_first_v3',
         'corpus_first_v3_policy_v1')`,
      [familyId, runId],
    );
    await database.query(
      `INSERT INTO track_candidates(
         id,run_id,canonical_key,recording_family_id,pipeline_version,
         policy_version,artist,title)
       VALUES($1,$2,'candidate:test',$3,'corpus_first_v3',
         'corpus_first_v3_policy_v1','Artist','Track')`,
      [candidateId, runId, familyId],
    );
    await database.query(
      `INSERT INTO playlist_qualification_records(
         id,run_id,contract_revision_id,candidate_id,stable_identity_hash,
         storefront,predicate_results_json,evidence_record_ids_json,
         quality_result_json,catalog_result_json,decision,qualification_hash)
       VALUES($1,$2,$3,$4,$5,'us','{}'::jsonb,'[]'::jsonb,'{}'::jsonb,
         '{}'::jsonb,'qualified',$6)`,
      [
        sourceQualificationId,
        runId,
        contractId,
        candidateId,
        identityHash,
        qualificationHash,
      ],
    );
    await database.query(
      `INSERT INTO canonical_track_identities(
         id,identity_policy_version,provider,storefront,recording_family_key,
         recording_family_policy_version,apple_stable_id,identity_hash)
       VALUES($1,'canonical_track_identity_v1','apple','us','isrc:TEST',
         'recording_family_v2','1440891293',$2)`,
      [identityId, identityHash],
    );
    await database.query(
      `INSERT INTO selection_qualification_observations(
         id,run_id,contract_revision_id,query_plan_revision_id,
         execution_attempt_id,candidate_id,canonical_track_identity_id,
         source_qualification_record_id,observation_hash,observation_json,
         observed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}'::jsonb,now())`,
      [
        observationId,
        runId,
        contractId,
        queryPlanId,
        attemptId,
        candidateId,
        identityId,
        sourceQualificationId,
        observationHash,
      ],
    );
    await database.query(
      `INSERT INTO immutable_selection_qualifications(
         id,run_id,contract_revision_id,query_plan_revision_id,
         execution_attempt_id,candidate_id,canonical_track_identity_id,
         qualification_observation_id,contract_hash,query_plan_hash,
         evidence_policy_hash,catalog_policy_hash,qualification_hash,decision)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'qualified')`,
      [
        selectionQualificationId,
        runId,
        contractId,
        queryPlanId,
        attemptId,
        candidateId,
        identityId,
        observationId,
        contractHash,
        queryPlanHash,
        "8".repeat(64),
        "9".repeat(64),
        qualificationHash,
      ],
    );
    await database.query(
      `INSERT INTO immutable_selection_sets(
         id,run_id,contract_revision_id,query_plan_revision_id,
         execution_attempt_id,proof_mode,requested_count,selected_count,
         reserve_count,selected_attestation_hash,reserve_attestation_hash,
         attestation_set_hash,output_hash)
       VALUES($1,$2,$3,$4,$5,'shadow',1,1,0,$6,$7,$8,$9)`,
      [
        selectionSetId,
        runId,
        contractId,
        queryPlanId,
        attemptId,
        "a".repeat(64),
        "b".repeat(64),
        attestationSetHash,
        outputHash,
      ],
    );
    await database.query(
      `INSERT INTO immutable_selection_set_items(
         selection_set_id,role,position,selection_qualification_id,
         canonical_track_identity_id,apple_stable_id)
       VALUES($1,'selected',0,$2,$3,'1440891293')`,
      [selectionSetId, selectionQualificationId, identityId],
    );
    await database.query(
      `INSERT INTO selection_attempt_output_attestations(
         execution_attempt_id,selection_set_id,output_hash,
         attestation_set_hash)
       VALUES($1,$2,$3,$4)`,
      [attemptId, selectionSetId, outputHash, attestationSetHash],
    );

    expect((await database.query(
      `SELECT selected_count,reserve_count,attestation_set_hash
       FROM immutable_selection_sets WHERE id=$1`,
      [selectionSetId],
    )).rows[0]).toEqual({
      selected_count: 1,
      reserve_count: 0,
      attestation_set_hash: attestationSetHash,
    });
    await expect(database.query(
      `UPDATE immutable_selection_sets SET selected_count=0 WHERE id=$1`,
      [selectionSetId],
    )).rejects.toThrow(/immutable/u);
    await expect(database.query(
      `INSERT INTO selection_attempt_output_attestations(
         execution_attempt_id,selection_set_id,output_hash,
         attestation_set_hash)
       VALUES($1,$2,$3,$4)`,
      [attemptId, selectionSetId, "c".repeat(64), attestationSetHash],
    )).rejects.toThrow();
  });

  test("requires receipt-bound backfill before native authority activation", async () => {
    const database = pool!;
    const client = activationClient!;
    const legacyRunId = randomUUID();
    const legacyContractId = randomUUID();
    const legacySelectionPlanId = randomUUID();
    const legacyGraphSnapshotId = randomUUID();
    const legacyQueryPlanId = randomUUID();
    const legacyAttemptId = randomUUID();
    const legacyContractHash = "1".repeat(64);
    await database.query(
      `INSERT INTO research_runs(
         id,prompt,brief_json,brief_hash,status,phase,client_bucket,
         idempotency_key,retention_expires_at,pipeline_version,policy_version
       ) VALUES(
         $1,'legacy published fixture','{}'::jsonb,$2,'complete','complete',
         'schema20-backfill-test',$3,now()+interval '1 day',
         'corpus_first_v3','corpus_first_v3_policy_v1'
       )`,
      [legacyRunId, "a".repeat(64), randomUUID()],
    );
    await database.query(
      `INSERT INTO playlist_contract_revisions(
         id,run_id,revision,status,contract_hash,contract_json,
         compiler_version,ontology_version,evidence_policy_version,
         question_template_version,catalog_policy_version,locale,storefront,
         answer_lineage_hash)
       VALUES($1,$2,1,'active',$3,'{}'::jsonb,'compiler','ontology',
         'evidence','questions','catalog','en','us',$4)`,
      [
        legacyContractId,
        legacyRunId,
        legacyContractHash,
        "b".repeat(64),
      ],
    );
    await database.query(
      `UPDATE research_runs
       SET active_playlist_contract_revision_id=$2 WHERE id=$1`,
      [legacyRunId, legacyContractId],
    );
    await database.query(
      `INSERT INTO selection_plans(
         id,run_id,revision,status,plan_hash,plan_json,pipeline_version,
         policy_version,confirmed_at)
       VALUES($1,$2,1,'active',$3,'{}'::jsonb,'corpus_first_v3',
         'corpus_first_v3_policy_v1',now())`,
      [legacySelectionPlanId, legacyRunId, "c".repeat(64)],
    );
    await database.query(
      `INSERT INTO graph_snapshots(
         id,status,content_hash,assertion_count,catalog_identity_count,locked_at)
       VALUES($1,'locked',$2,0,0,now())`,
      [legacyGraphSnapshotId, "0".repeat(64)],
    );
    await database.query(
      `INSERT INTO query_plan_revisions(
         id,run_id,selection_plan_id,revision,graph_snapshot_id,engine,status,
         plan_hash,plan_json,pipeline_version,policy_version,activated_at)
       VALUES($1,$2,$3,1,$4,'portfolio','active',$5,'{}'::jsonb,
         'corpus_first_v3','corpus_first_v3_policy_v1',now())`,
      [
        legacyQueryPlanId,
        legacyRunId,
        legacySelectionPlanId,
        legacyGraphSnapshotId,
        "e".repeat(64),
      ],
    );
    await database.query(
      `INSERT INTO playlist_execution_attempts(
         id,run_id,contract_revision_id,query_plan_revision_id,stage,
         attempt_number,lease_generation,executor_revision,
         executor_identity_hash,configuration_hash,idempotency_key,status,
         last_active_at)
       VALUES($1,$2,$3,$4,'publication',1,1,'legacy-revision',
         $5,$6,$7,'complete',now())`,
      [
        legacyAttemptId,
        legacyRunId,
        legacyContractId,
        legacyQueryPlanId,
        "f".repeat(64),
        "0".repeat(64),
        randomUUID(),
      ],
    );
    const legacyManifestId = randomUUID();
    const legacyRevisionId = randomUUID();
    const legacyContentHash = "d".repeat(64);
    const orderedIdsHash = "e".repeat(64);
    await database.query(
      `INSERT INTO manifests(
         id,run_id,name,description,content_hash,pipeline_version,
         policy_version,contract_revision_id,contract_hash)
       VALUES($1,$2,'Legacy published','Legacy schema-19 publication',$3,
         'corpus_first_v3','corpus_first_v3_policy_v1',$4,$5)`,
      [
        legacyManifestId,
        legacyRunId,
        legacyContentHash,
        legacyContractId,
        legacyContractHash,
      ],
    );
    await database.query(
      "ALTER TABLE manifest_revisions DISABLE TRIGGER USER",
    );
    try {
      await database.query(
        `INSERT INTO manifest_revisions(
           id,manifest_id,revision,status,reason,content_hash,
           pipeline_version,policy_version,selection_plan_id,
           query_plan_revision_id,graph_snapshot_id,run_spec_hash,locked_at)
         VALUES($1,$2,1,'locked','legacy schema-19 publication',$3,
           'corpus_first_v3','corpus_first_v3_policy_v1',$4,$5,$6,$7,now())`,
        [
          legacyRevisionId,
          legacyManifestId,
          legacyContentHash,
          legacySelectionPlanId,
          legacyQueryPlanId,
          legacyGraphSnapshotId,
          "f".repeat(64),
        ],
      );
    } finally {
      await database.query(
        "ALTER TABLE manifest_revisions ENABLE TRIGGER USER",
      );
    }
    await database.query(
      `INSERT INTO playlist_publication_reconciliations(
         id,run_id,contract_revision_id,execution_attempt_id,manifest_id,
         manifest_revision_id,apple_playlist_id,state,
         expected_ordered_ids_hash,observed_ordered_ids_hash,
         appended_count,expected_count,batch_cursor,idempotency_key,
         completed_at)
       VALUES($1,$2,$3,$4,$5,$6,'legacy-apple-playlist','complete',
         $7,$7,1,1,1,$8,now())`,
      [
        randomUUID(),
        legacyRunId,
        legacyContractId,
        legacyAttemptId,
        legacyManifestId,
        legacyRevisionId,
        orderedIdsHash,
        randomUUID(),
      ],
    );
    const terminalRunId = randomUUID();
    const terminalContractId = randomUUID();
    const terminalSelectionPlanId = randomUUID();
    const terminalGraphSnapshotId = randomUUID();
    const terminalQueryPlanId = randomUUID();
    const terminalManifestId = randomUUID();
    const terminalRevisionId = randomUUID();
    await database.query(
      `INSERT INTO research_runs(
         id,prompt,brief_json,brief_hash,status,phase,client_bucket,
         idempotency_key,retention_expires_at,pipeline_version,policy_version
       ) VALUES(
         $1,'terminal unpublished fixture','{}'::jsonb,$2,'quarantined',
         'canonical_integrity_quarantine','schema20-terminal-test',$3,
         now()+interval '1 day','corpus_first_v3',
         'corpus_first_v3_policy_v1'
       )`,
      [terminalRunId, "1".repeat(64), randomUUID()],
    );
    await database.query(
      `INSERT INTO playlist_contract_revisions(
         id,run_id,revision,status,contract_hash,contract_json,
         compiler_version,ontology_version,evidence_policy_version,
         question_template_version,catalog_policy_version,locale,storefront,
         answer_lineage_hash)
       VALUES($1,$2,1,'active',$3,'{}'::jsonb,'compiler','ontology',
         'evidence','questions','catalog','en','us',$4)`,
      [
        terminalContractId,
        terminalRunId,
        "2".repeat(64),
        "3".repeat(64),
      ],
    );
    await database.query(
      `UPDATE research_runs
       SET active_playlist_contract_revision_id=$2 WHERE id=$1`,
      [terminalRunId, terminalContractId],
    );
    await database.query(
      `INSERT INTO selection_plans(
         id,run_id,revision,status,plan_hash,plan_json,pipeline_version,
         policy_version,confirmed_at)
       VALUES($1,$2,1,'active',$3,'{}'::jsonb,'corpus_first_v3',
         'corpus_first_v3_policy_v1',now())`,
      [terminalSelectionPlanId, terminalRunId, "4".repeat(64)],
    );
    await database.query(
      `INSERT INTO graph_snapshots(
         id,status,content_hash,assertion_count,catalog_identity_count,locked_at)
       VALUES($1,'locked',$2,0,0,now())`,
      [terminalGraphSnapshotId, "5".repeat(64)],
    );
    await database.query(
      `INSERT INTO query_plan_revisions(
         id,run_id,selection_plan_id,revision,graph_snapshot_id,engine,status,
         plan_hash,plan_json,pipeline_version,policy_version,activated_at)
       VALUES($1,$2,$3,1,$4,'portfolio','active',$5,'{}'::jsonb,
         'corpus_first_v3','corpus_first_v3_policy_v1',now())`,
      [
        terminalQueryPlanId,
        terminalRunId,
        terminalSelectionPlanId,
        terminalGraphSnapshotId,
        "6".repeat(64),
      ],
    );
    await database.query(
      `INSERT INTO manifests(
         id,run_id,name,description,content_hash,pipeline_version,
         policy_version,contract_revision_id,contract_hash)
       VALUES($1,$2,'Terminal unpublished','Never publication-authoritative',
         $3,'corpus_first_v3','corpus_first_v3_policy_v1',$4,$5)`,
      [
        terminalManifestId,
        terminalRunId,
        "7".repeat(64),
        terminalContractId,
        "2".repeat(64),
      ],
    );
    await database.query(
      `INSERT INTO playlist_run_resolutions(
         run_id,generation,state,next_action,active_contract_revision_id,
         state_json,provenance,incident_reference)
       VALUES($1,1,'quarantined','contact_support',$2,'{}'::jsonb,
         'owner_repair','schema20-terminal-fixture')`,
      [terminalRunId, terminalContractId],
    );
    await database.query(
      "ALTER TABLE manifest_revisions DISABLE TRIGGER USER",
    );
    try {
      await database.query(
        `INSERT INTO manifest_revisions(
           id,manifest_id,revision,status,reason,content_hash,
           pipeline_version,policy_version,selection_plan_id,
           query_plan_revision_id,graph_snapshot_id,run_spec_hash,locked_at)
         VALUES($1,$2,1,'locked','terminal unpublished schema-19 manifest',$3,
           'corpus_first_v3','corpus_first_v3_policy_v1',$4,$5,$6,$7,now())`,
        [
          terminalRevisionId,
          terminalManifestId,
          "7".repeat(64),
          terminalSelectionPlanId,
          terminalQueryPlanId,
          terminalGraphSnapshotId,
          "8".repeat(64),
        ],
      );
    } finally {
      await database.query(
        "ALTER TABLE manifest_revisions ENABLE TRIGGER USER",
      );
    }
    await database.query(
      `INSERT INTO settings(key,value)
       VALUES('pipeline_v3_public_assignment_paused','true')
       ON CONFLICT(key) DO UPDATE SET
         value=excluded.value,updated_at=now()`,
    );
    await database.query(
      `INSERT INTO pipeline_cohort_kill_switches(
         cohort_key,route,intent_group,disabled,reason_code,changed_by
       ) VALUES(
         'schema20-native-test','corpus_first_v3',NULL,true,
         'schema20_native_activation','schema20-test'
       )
       ON CONFLICT(route,intent_group) DO UPDATE SET
         disabled=excluded.disabled,
         reason_code=excluded.reason_code,
         changed_by=excluded.changed_by,
         changed_at=now()`,
    );
    for (const [workerId, queueClass] of [
      ["schema20-interactive", "interactive"],
      ["schema20-deep", "deep"],
    ] as const) {
      await database.query(
        `INSERT INTO worker_heartbeats(
           worker_id,schema_version,capacity,active_jobs,metadata_json,
           started_at,last_seen_at
         ) VALUES($1,'20',1,0,$2::jsonb,now(),now())
         ON CONFLICT(worker_id) DO UPDATE SET
           schema_version=excluded.schema_version,
           capacity=excluded.capacity,
           active_jobs=excluded.active_jobs,
           metadata_json=excluded.metadata_json,
           last_seen_at=excluded.last_seen_at`,
        [
          workerId,
          JSON.stringify({
            protocolVersion: "playlist-pipeline-v12",
            queueClass,
          }),
        ],
      );
    }

    await expect(executeSchema20ProofAuthorityTransition(
      client,
      "dry-run",
      null,
    )).rejects.toThrow("schema20_backfill_not_complete");

    const backfillDryRun = await executeSchema20ProofBackfill(
      client,
      "dry-run",
      null,
      null,
    );
    expect(backfillDryRun).toMatchObject({
      mode: "dry-run",
      safeToApply: true,
      plan: {
        legacyPublishedVerifiedCount: 1,
        legacyPublishedUnverifiedCount: 0,
        terminalUnpublishedCount: 1,
        successorRequiredCount: 0,
        ambiguousOrTamperedCount: 0,
        plannedReceiptCount: 1,
      },
    });
    expect(backfillDryRun.planHash).toMatch(/^[0-9a-f]{64}$/u);
    await expect(executeSchema20ProofBackfill(
      client,
      "apply",
      "0".repeat(64),
      "schema20-proof-migration-test",
    )).rejects.toThrow("schema20_backfill_plan_hash_mismatch");
    await expect(executeSchema20ProofBackfill(
      client,
      "apply",
      backfillDryRun.planHash as string,
      "short",
    )).rejects.toThrow("schema20_backfill_idempotency_key_invalid");
    const backfillApplied = await executeSchema20ProofBackfill(
      client,
      "apply",
      backfillDryRun.planHash as string,
      "schema20-proof-migration-test",
    );
    expect(backfillApplied).toMatchObject({
      mode: "apply",
      applied: true,
      planHash: backfillDryRun.planHash,
      receiptCount: 1,
    });
    expect((await database.query<{
      expected_ordered_ids_hash: string | null;
      observed_ordered_ids_hash: string | null;
      reconciled_count: number | null;
      verification: string;
    }>(
      `SELECT expected_ordered_ids_hash,observed_ordered_ids_hash,
              reconciled_count,receipt_json->>'verification' verification
       FROM legacy_published_receipts
       WHERE manifest_revision_id=$1`,
      [legacyRevisionId],
    )).rows[0]).toEqual({
      expected_ordered_ids_hash: orderedIdsHash,
      observed_ordered_ids_hash: orderedIdsHash,
      reconciled_count: 1,
      verification: "verified_ordered_apple_readback",
    });
    expect((await database.query(
      `SELECT value::jsonb->>'receiptVersion' receipt_version
       FROM settings
       WHERE key='schema20_backfill_complete_receipt'`,
    )).rows[0]?.receipt_version).toBe(
      "schema20-proof-backfill-completion/v1",
    );

    const dryRun = await executeSchema20ProofAuthorityTransition(
      client,
      "dry-run",
      null,
    );
    expect(dryRun).toMatchObject({
      mode: "dry-run",
      safeToApply: true,
    });
    expect(dryRun.receiptHash).toMatch(/^[0-9a-f]{64}$/u);
    expect((await database.query(
      `SELECT value FROM settings
       WHERE key='proof_architecture_authority'`,
    )).rows[0]?.value).toBe("shadow");

    await expect(executeSchema20ProofAuthorityTransition(
      client,
      "apply",
      "0".repeat(64),
    )).rejects.toThrow("schema20_native_receipt_hash_mismatch");
    expect((await database.query(
      `SELECT value FROM settings
       WHERE key='proof_architecture_authority'`,
    )).rows[0]?.value).toBe("shadow");

    const applied = await executeSchema20ProofAuthorityTransition(
      client,
      "apply",
      dryRun.receiptHash as string,
    );
    expect(applied).toMatchObject({
      mode: "apply",
      applied: true,
      receiptHash: dryRun.receiptHash,
      proofAuthority: "native",
    });
    expect((await database.query(
      `SELECT value FROM settings
       WHERE key='proof_architecture_authority'`,
    )).rows[0]?.value).toBe("native");
    expect((await database.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname=current_schema()
         AND indexname IN (
           'manifest_revision_hash_idx',
           'manifest_revision_content_attestation_idx'
         )
       ORDER BY indexname`,
    )).rows.map(({ indexname }) => indexname)).toEqual([
      "manifest_revision_content_attestation_idx",
    ]);
    expect((await database.query(
      `SELECT value::jsonb->>'schemaVersion' schema
       FROM settings
       WHERE key=$1`,
      [`schema20_native_activation_receipt:${dryRun.receiptHash as string}`],
    )).rows[0]?.schema).toBe(
      "schema20-native-proof-authority-receipt/v1",
    );
  });
});
