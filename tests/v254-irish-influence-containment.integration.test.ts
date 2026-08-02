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
  collectV254IrishInfluenceContainmentSnapshot,
  executeV254IrishInfluenceContainment,
  pauseV254IrishInfluenceContainment,
  v254OwnerReviewInventoryRowHash,
  v254OwnerReviewRunIdHash,
  V254_CONTAINMENT_INTENT,
  V254_CONTAINMENT_ROUTE,
} from "../scripts/v254-irish-influence-containment.ts";
import {
  V254_IRISH_INFLUENCE_SYNTHETIC_BINDING,
} from "../scripts/v254-irish-influence-protected-binding.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseDescribe = databaseUrl ? describe.sequential : describe.skip;
const migrationDirectory = new URL("../postgres-migrations/", import.meta.url);
const migrationFiles = readdirSync(migrationDirectory)
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort();
const incidentRunId = V254_IRISH_INFLUENCE_SYNTHETIC_BINDING.runId;
const incidentAccessId = V254_IRISH_INFLUENCE_SYNTHETIC_BINDING.accessId;
const incidentContractRevisionId =
  V254_IRISH_INFLUENCE_SYNTHETIC_BINDING.contractRevisionId;
const incidentQueryPlanRevisionId =
  V254_IRISH_INFLUENCE_SYNTHETIC_BINDING.queryPlanRevisionId;
const incidentExecutionAttemptId =
  V254_IRISH_INFLUENCE_SYNTHETIC_BINDING.executionAttemptId;
const incidentBlockerId =
  V254_IRISH_INFLUENCE_SYNTHETIC_BINDING.blockerId;
const incidentReleaseRevision =
  "c5d76e9e84b6982826fcce462b049d3c05925f3b";
const incidentSemanticConfigurationHash =
  "3cad6fd7dd046292c5f19d2e19eff41422e3c5e1288639f6545ca4e7a04fa922";

databaseDescribe("v2.5.4 Irish-influence containment SQL", () => {
  const schemaName =
    `genio_v254_containment_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool | undefined;
  let client: Client | undefined;

  beforeAll(async () => {
    adminPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: "genio-v254-containment-admin",
    });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    const migrationPool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 2,
      application_name: "genio-v254-containment-migrations",
    });
    try {
      for (const file of migrationFiles) {
        await migrationPool.query(readFileSync(
          new URL(`../postgres-migrations/${file}`, import.meta.url),
          "utf8",
        ));
      }
    } finally {
      await migrationPool.end();
    }
    client = new Client({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      application_name: "genio-v254-containment",
    });
    await client.connect();
    await client.query(
      `INSERT INTO settings(key,value)
       VALUES
         ('research_paused','true'),
         ('publishing_paused','true'),
         ('pipeline_v3_public_assignment_paused','true'),
         ('pipeline_v3_public_assignment_paused:editorial_influence','true')`,
    );
    await client.query(
      `INSERT INTO pipeline_cohort_kill_switches(
         cohort_key,route,intent_group,disabled,reason_code,changed_by)
       VALUES
         ('v254-irish-influence-containment',$1,'genre_scene',true,'test',
          'integration-test'),
         ('affected-switch',$1,$2,true,'test','integration-test')`,
      [V254_CONTAINMENT_ROUTE, V254_CONTAINMENT_INTENT],
    );
  }, 60_000);

  afterAll(async () => {
    await client?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  }, 30_000);

  async function insertProductionShapedIncident(database: Client) {
    const selectionPlanId = randomUUID();
    const graphSnapshotId = randomUUID();
    const sourceJobId = randomUUID();
    const selectionPlanHash = "c".repeat(64);
    await database.query(
      `INSERT INTO research_runs(
         id,prompt,brief_json,brief_hash,status,phase,client_bucket,
         idempotency_key,retention_expires_at,pipeline_version,
         policy_version,brief_contract_version)
       VALUES(
         $1,'sanitized Irish influence incident',
         jsonb_build_object(
           'title','Irish influence',
           'targetSize',jsonb_build_object('min',25,'max',25)
         ),
         $2,'needs_decision','capability_evidence_coverage_audit',
         'containment-integration','incident-production-shape',
         now()+interval '1 day',$3,'corpus_first_v3_policy_v1',3
       )`,
      [
        incidentRunId,
        "a".repeat(64),
        V254_CONTAINMENT_ROUTE,
      ],
    );
    await database.query(
      `INSERT INTO run_accesses(
         id,run_id,prompt,client_bucket,idempotency_key,expires_at)
       VALUES(
         $1,$2,'sanitized Irish influence incident',
         'containment-integration','incident-production-shape',
         now()+interval '1 day'
       )`,
      [incidentAccessId, incidentRunId],
    );
    await database.query(
      `INSERT INTO playlist_contract_revisions(
         id,run_id,revision,status,contract_hash,contract_json,
         compiler_version,ontology_version,evidence_policy_version,
         question_template_version,catalog_policy_version,locale,storefront,
         answer_lineage_hash)
       VALUES(
         $1,$2,1,'active',$3,
         jsonb_build_object('desiredCount',25),
         'compiler-v253','ontology-v253','evidence-v253',
         'guidance-v4','catalog-v253','en-US','us',$4
       )`,
      [
        incidentContractRevisionId,
        incidentRunId,
        "b".repeat(64),
        "d".repeat(64),
      ],
    );
    await database.query(
      `UPDATE research_runs
       SET active_playlist_contract_revision_id=$2
       WHERE id=$1`,
      [incidentRunId, incidentContractRevisionId],
    );
    await database.query(
      `INSERT INTO selection_plans(
         id,run_id,revision,status,plan_hash,plan_json,pipeline_version,
         policy_version,confirmed_at)
       VALUES(
         $1,$2,1,'active',$3,
         jsonb_build_object('requestedTrackCount',25),
         'corpus_first_v3','corpus_first_v3_policy_v1',now()
       )`,
      [selectionPlanId, incidentRunId, selectionPlanHash],
    );
    await database.query(
      `INSERT INTO graph_snapshots(
         id,status,content_hash,assertion_count,catalog_identity_count,locked_at)
       VALUES($1,'locked',$2,0,0,now())`,
      [graphSnapshotId, "e".repeat(64)],
    );
    await database.query(
      `INSERT INTO query_plan_revisions(
         id,run_id,selection_plan_id,revision,graph_snapshot_id,engine,status,
         plan_hash,plan_json,pipeline_version,policy_version,activated_at)
       VALUES(
         $1,$2,$3,1,$4,'editorial_ranking','active',$5,
         jsonb_build_object(
           'schemaVersion',6,
           'selectionPlanHash',$6::text,
           'executorCapabilityHash',$7::text,
           'executorCapabilityVector',
             jsonb_build_object(
               'protocolNumber',12,
               'queryPlanSchemas',jsonb_build_array(6)
             ),
           'rankingObjectives',
             jsonb_build_array(
               jsonb_build_object(
                 'kind','relevance',
                 'description','typed influence relationship'
               )
             )
         ),
         'corpus_first_v3','corpus_first_v3_policy_v1',now()
       )`,
      [
        incidentQueryPlanRevisionId,
        incidentRunId,
        selectionPlanId,
        graphSnapshotId,
        "f".repeat(64),
        selectionPlanHash,
        "3".repeat(64),
      ],
    );
    await database.query(
      `INSERT INTO run_active_query_plans(run_id,query_plan_revision_id)
       VALUES($1,$2)`,
      [incidentRunId, incidentQueryPlanRevisionId],
    );
    await database.query(
      `INSERT INTO job_queue(
         id,run_id,kind,queue_class,dedupe_key,pipeline_version,
         minimum_worker_protocol,query_plan_revision_id,stage_key,status,
         payload_json,required_executor_revision,
         required_executor_semantic_configuration_hash,completed_at)
       VALUES(
         $1,$2,'research','interactive',$3,'corpus_first_v3',12,$4,
         'v3-retrieval:incident','complete','{}'::jsonb,$5,$6,now()
       )`,
      [
        sourceJobId,
        incidentRunId,
        `incident-source:${incidentRunId}`,
        incidentQueryPlanRevisionId,
        incidentReleaseRevision,
        incidentSemanticConfigurationHash,
      ],
    );
    await database.query(
      `INSERT INTO playlist_execution_attempts(
         id,run_id,contract_revision_id,query_plan_revision_id,stage,
         attempt_number,lease_generation,executor_revision,
         executor_identity_hash,configuration_hash,
         semantic_execution_configuration_hash,idempotency_key,status,
         last_active_at,completed_at)
       VALUES(
         $1,$2,$3,$4,'qualification',1,1,$5,$6,$7,$8,$9,'failed',
         now(),now()
       )`,
      [
        incidentExecutionAttemptId,
        incidentRunId,
        incidentContractRevisionId,
        incidentQueryPlanRevisionId,
        incidentReleaseRevision,
        "1".repeat(64),
        "2".repeat(64),
        incidentSemanticConfigurationHash,
        `incident-attempt:${incidentRunId}`,
      ],
    );
    await database.query(
      `INSERT INTO playlist_run_blockers(
         id,run_id,contract_revision_id,blocker_kind,dependency_key,
         state_json)
       VALUES(
         $1,$2,$3,'integrity','evidence_persistence',
         jsonb_build_object('reasonCode','candidate_binding_defect')
       )`,
      [
        incidentBlockerId,
        incidentRunId,
        incidentContractRevisionId,
      ],
    );
    await database.query(
      `INSERT INTO playlist_run_resolutions(
         run_id,generation,state,next_action,active_contract_revision_id,
         execution_attempt_id,blocker_id,decision_json,state_json,provenance)
       VALUES(
         $1,3,'needs_decision','review_contract',$2,$3,$4,
         jsonb_build_object('kind','legacy_actionless_decision'),
         jsonb_build_object(
           'observationCount',77,
           'appleResolvedCount',73,
           'evidenceQualifiedCount',0
         ),
         'resolution_service'
       )`,
      [
        incidentRunId,
        incidentContractRevisionId,
        incidentExecutionAttemptId,
        incidentBlockerId,
      ],
    );
    await database.query(
      `INSERT INTO playlist_qualification_records(
         id,run_id,contract_revision_id,candidate_id,stable_identity_hash,
         storefront,predicate_results_json,evidence_record_ids_json,
         quality_result_json,catalog_result_json,decision,qualification_hash)
       SELECT
         gen_random_uuid(),$1,$2,NULL,
         repeat('a',60)||lpad(series::text,4,'0'),
         'us',
         jsonb_build_object(
           'historical_influence',
           jsonb_build_object('disposition','unknown')
         ),
         '[]'::jsonb,'{}'::jsonb,
         jsonb_build_object('applePlayable',true),
         'unknown',
         repeat('b',60)||lpad(series::text,4,'0')
       FROM generate_series(1,77) series`,
      [incidentRunId, incidentContractRevisionId],
    );
  }

  async function insertOwnerReviewCandidate(database: Client) {
    const runId = randomUUID();
    const contractId = randomUUID();
    const selectionPlanId = randomUUID();
    const graphSnapshotId = randomUUID();
    const queryPlanId = randomUUID();
    const executionAttemptId = randomUUID();
    await database.query(
      `INSERT INTO research_runs(
         id,prompt,brief_json,brief_hash,status,phase,client_bucket,
         idempotency_key,retention_expires_at,pipeline_version,
         policy_version,brief_contract_version)
       VALUES(
         $1,'sanitized historical influence review candidate',
         jsonb_build_object(
           'title','Historical influence review',
           'targetSize',jsonb_build_object('min',25,'max',25)
         ),
         $2,'needs_decision','capability_evidence_coverage_audit',
         'containment-integration',$3,now()+interval '1 day',$4,
         'corpus_first_v3_policy_v1',3
       )`,
      [
        runId,
        "1".repeat(64),
        `review-candidate:${runId}`,
        V254_CONTAINMENT_ROUTE,
      ],
    );
    await database.query(
      `INSERT INTO playlist_contract_revisions(
         id,run_id,revision,status,contract_hash,contract_json,
         compiler_version,ontology_version,evidence_policy_version,
         question_template_version,catalog_policy_version,locale,storefront,
         answer_lineage_hash)
       VALUES(
         $1,$2,1,'active',$3,jsonb_build_object('desiredCount',25),
         'compiler-v253','ontology-v253','evidence-v253',
         'guidance-v4','catalog-v253','en-US','us',$4
       )`,
      [contractId, runId, "2".repeat(64), "3".repeat(64)],
    );
    await database.query(
      `UPDATE research_runs
       SET active_playlist_contract_revision_id=$2
       WHERE id=$1`,
      [runId, contractId],
    );
    await database.query(
      `INSERT INTO selection_plans(
         id,run_id,revision,status,plan_hash,plan_json,pipeline_version,
         policy_version,confirmed_at)
       VALUES(
         $1,$2,1,'active',$3,
         jsonb_build_object('requestedTrackCount',25),
         'corpus_first_v3','corpus_first_v3_policy_v1',now()
       )`,
      [selectionPlanId, runId, "4".repeat(64)],
    );
    await database.query(
      `INSERT INTO graph_snapshots(
         id,status,content_hash,assertion_count,catalog_identity_count,locked_at)
       VALUES($1,'locked',$2,0,0,now())`,
      [graphSnapshotId, "5".repeat(64)],
    );
    await database.query(
      `INSERT INTO query_plan_revisions(
         id,run_id,selection_plan_id,revision,graph_snapshot_id,engine,status,
         plan_hash,plan_json,pipeline_version,policy_version,activated_at)
       VALUES(
         $1,$2,$3,1,$4,'editorial_ranking','active',$5,
         jsonb_build_object(
           'schemaVersion',6,
           'selectionPlanHash',$6::text,
           'executorCapabilityHash',$7::text,
           'executorCapabilityVector',
             jsonb_build_object(
               'protocolNumber',12,
               'queryPlanSchemas',jsonb_build_array(6)
             ),
           'rankingObjectives',
             jsonb_build_array(jsonb_build_object('kind','influence'))
         ),
         'corpus_first_v3','corpus_first_v3_policy_v1',now()
       )`,
      [
        queryPlanId,
        runId,
        selectionPlanId,
        graphSnapshotId,
        "6".repeat(64),
        "4".repeat(64),
        "7".repeat(64),
      ],
    );
    await database.query(
      `INSERT INTO run_active_query_plans(run_id,query_plan_revision_id)
       VALUES($1,$2)`,
      [runId, queryPlanId],
    );
    await database.query(
      `INSERT INTO job_queue(
         id,run_id,kind,queue_class,dedupe_key,pipeline_version,
         minimum_worker_protocol,query_plan_revision_id,stage_key,status,
         payload_json,required_executor_revision,
         required_executor_semantic_configuration_hash,completed_at)
       VALUES(
         $1,$2,'research','interactive',$3,'corpus_first_v3',12,$4,
         'v3-retrieval:review','complete','{}'::jsonb,$5,$6,now()
       )`,
      [
        randomUUID(),
        runId,
        `review-source:${runId}`,
        queryPlanId,
        incidentReleaseRevision,
        incidentSemanticConfigurationHash,
      ],
    );
    await database.query(
      `INSERT INTO playlist_execution_attempts(
         id,run_id,contract_revision_id,query_plan_revision_id,stage,
         attempt_number,lease_generation,executor_revision,
         executor_identity_hash,configuration_hash,
         semantic_execution_configuration_hash,idempotency_key,status,
         last_active_at,completed_at)
       VALUES(
         $1,$2,$3,$4,'qualification',1,1,$5,$6,$7,$8,$9,'failed',
         now(),now()
       )`,
      [
        executionAttemptId,
        runId,
        contractId,
        queryPlanId,
        incidentReleaseRevision,
        "8".repeat(64),
        "9".repeat(64),
        incidentSemanticConfigurationHash,
        `review-attempt:${runId}`,
      ],
    );
    await database.query(
      `INSERT INTO playlist_run_resolutions(
         run_id,generation,state,next_action,active_contract_revision_id,
         execution_attempt_id,decision_json,state_json,provenance)
       VALUES(
         $1,1,'needs_decision','review_contract',$2,$3,
         jsonb_build_object('kind','legacy_actionless_decision'),
         jsonb_build_object('observationCount',10),
         'resolution_service'
       )`,
      [runId, contractId, executionAttemptId],
    );
    await database.query(
      `INSERT INTO playlist_qualification_records(
         id,run_id,contract_revision_id,candidate_id,stable_identity_hash,
         storefront,predicate_results_json,evidence_record_ids_json,
         quality_result_json,catalog_result_json,decision,qualification_hash)
       SELECT
         gen_random_uuid(),$1,$2,NULL,
         repeat('c',60)||lpad(series::text,4,'0'),
         'us',
         jsonb_build_object(
           'historical_influence',
           jsonb_build_object('disposition','unknown')
         ),
         '[]'::jsonb,'{}'::jsonb,
         jsonb_build_object('applePlayable',true),
         'unknown',
         repeat('d',60)||lpad(series::text,4,'0')
       FROM generate_series(1,10) series`,
      [runId, contractId],
    );
    return runId;
  }

  test("PostgreSQL parses and executes every snapshot query under row locks", async () => {
    const database = client!;
    await database.query("BEGIN");
    try {
      const snapshot = await collectV254IrishInfluenceContainmentSnapshot(
        database,
        true,
      );
      expect(snapshot.run).toBeNull();
      expect(snapshot.sameSignature).toEqual([]);
      expect(snapshot.switch).toMatchObject({
        route: V254_CONTAINMENT_ROUTE,
        intent_group: V254_CONTAINMENT_INTENT,
        disabled: true,
      });
      expect(snapshot.pauses).toEqual([
        { key: "publishing_paused", value: "true" },
        { key: "research_paused", value: "true" },
      ]);
      expect(snapshot.assignmentPauses).toEqual([
        { key: "pipeline_v3_public_assignment_paused", value: "true" },
        {
          key: "pipeline_v3_public_assignment_paused:editorial_influence",
          value: "true",
        },
      ]);
    } finally {
      await database.query("ROLLBACK");
    }
  });

  test("counts an unresolved orphan as an Apple side effect even after its volume is gone", async () => {
    const database = client!;
    const manifestId = randomUUID();
    try {
      await database.query(
        `INSERT INTO research_runs(
           id,prompt,brief_json,brief_hash,status,phase,client_bucket,
           idempotency_key,retention_expires_at,pipeline_version)
         VALUES($1,'sanitized incident','{}'::jsonb,$2,'needs_decision',
           'capability_evidence_coverage_audit','test','incident',
           now()+interval '1 day',$3)`,
        [
          incidentRunId,
          "a".repeat(64),
          V254_CONTAINMENT_ROUTE,
        ],
      );
      await database.query(
        `INSERT INTO run_accesses(
           id,run_id,client_bucket,idempotency_key,expires_at)
         VALUES($1,$2,'test','incident',now()+interval '1 day')`,
        [incidentAccessId, incidentRunId],
      );
      await database.query(
        `INSERT INTO manifests(id,run_id,name,description,content_hash)
         VALUES($1,$2,'test','test',$3)`,
        [manifestId, incidentRunId, "b".repeat(64)],
      );
      await database.query(
        `INSERT INTO orphan_playlists(
           id,manifest_id,publication_volume_id,apple_playlist_id,reason)
         VALUES($1,$2,NULL,'pl.orphan-only','ambiguous publication commit')`,
        [randomUUID(), manifestId],
      );

      const snapshot = await collectV254IrishInfluenceContainmentSnapshot(
        database,
      );
      expect(snapshot.counts).toMatchObject({
        manifest_count: 1,
        reconciliation_count: 0,
        apple_side_effect_count: 1,
      });
      expect(snapshot.sameSignature).toEqual([]);
    } finally {
      await database.query(
        "DELETE FROM research_runs WHERE id=$1",
        [incidentRunId],
      );
    }
  });

  test("pauses, preserves the exact dry-run receipt, applies once, and proves an idempotent replay", async () => {
    const database = client!;
    await insertProductionShapedIncident(database);
    const ownerReviewRunId = await insertOwnerReviewCandidate(database);
    await database.query(
      `UPDATE settings SET value='false',updated_at=now()
       WHERE key IN (
         'research_paused',
         'publishing_paused',
         'pipeline_v3_public_assignment_paused',
         'pipeline_v3_public_assignment_paused:editorial_influence'
       )`,
    );

    const paused = await pauseV254IrishInfluenceContainment(database);
    expect(paused.pauses).toEqual([
      { key: "publishing_paused", value: "true" },
      { key: "research_paused", value: "true" },
    ]);
    expect(paused.assignmentPauses).toEqual([
      { key: "pipeline_v3_public_assignment_paused", value: "true" },
      {
        key: "pipeline_v3_public_assignment_paused:editorial_influence",
        value: "true",
      },
    ]);

    const dryRun = await executeV254IrishInfluenceContainment(
      database,
      "contain-dry-run",
      undefined,
    );
    expect(dryRun).toMatchObject({
      mode: "contain-dry-run",
      safeToApply: true,
      alreadyApplied: false,
      ownerReviewCandidateCount: 1,
      ownerReviewDispositionCount: 0,
      ownerReviewUndispositionedCount: 1,
      ownerReviewUnresolvedExecutableWorkCount: 0,
      ownerReviewUnresolvedPublicationWorkCount: 0,
      ownerReviewPromotionSafe: false,
      ownerReviewPromotionProofHash:
        expect.stringMatching(/^[0-9a-f]{64}$/u),
      receiptHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      affectedRunCount: 1,
      affectedRunSetHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      observedCounts: {
        observation_count: 77,
        null_candidate_count: 77,
        candidate_count: 0,
        manifest_count: 0,
        reconciliation_count: 0,
        apple_side_effect_count: 0,
      },
      observedCountsHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      expectedMutationCounts: {
        jobsCancelled: 0,
        blockerResolved: 1,
        transitionInserted: 1,
        resolutionUpdated: 1,
        outboxInserted: 1,
        runUpdated: 1,
        auditInserted: 1,
        pausesCleared: 2,
      },
      expectedMutationCountsHash:
        expect.stringMatching(/^[0-9a-f]{64}$/u),
      actualMutationCounts: {
        jobsCancelled: 0,
        blockerResolved: 0,
        transitionInserted: 0,
        resolutionUpdated: 0,
        outboxInserted: 0,
        runUpdated: 0,
        auditInserted: 0,
        pausesCleared: 0,
      },
      actualMutationCountsHash:
        expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    const serializedDryRun = JSON.stringify(dryRun);
    for (const protectedIdentifier of [
      incidentRunId,
      incidentAccessId,
      V254_IRISH_INFLUENCE_SYNTHETIC_BINDING.briefRequestId,
      incidentContractRevisionId,
      incidentQueryPlanRevisionId,
      incidentExecutionAttemptId,
      incidentBlockerId,
      V254_IRISH_INFLUENCE_SYNTHETIC_BINDING.sourceJobId,
    ]) {
      expect(serializedDryRun).not.toContain(protectedIdentifier);
    }
    expect(serializedDryRun).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/u,
    );
    expect(serializedDryRun).not.toContain('"observed"');
    expect(serializedDryRun).not.toContain('"expected"');

    const applied = await executeV254IrishInfluenceContainment(
      database,
      "contain-apply",
      dryRun.receiptHash,
    );
    expect(applied).toMatchObject({
      mode: "contain-apply",
      applied: true,
      receiptHash: dryRun.receiptHash,
      affectedRunCount: 1,
      affectedRunSetHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      ownerReviewCandidateCount: 1,
      ownerReviewDispositionCount: 0,
      ownerReviewUndispositionedCount: 1,
      ownerReviewPromotionSafe: false,
      observedCountsHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      mutationCounts: {
        jobsCancelled: 0,
        blockerResolved: 1,
        transitionInserted: 1,
        resolutionUpdated: 1,
        outboxInserted: 1,
        runUpdated: 1,
        auditInserted: 1,
        pausesCleared: 2,
      },
      mutationCountsHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      expectedMutationCounts: {
        jobsCancelled: 0,
        blockerResolved: 1,
        transitionInserted: 1,
        resolutionUpdated: 1,
        outboxInserted: 1,
        runUpdated: 1,
        auditInserted: 1,
        pausesCleared: 2,
      },
      expectedMutationCountsHash:
        dryRun.expectedMutationCountsHash,
      actualMutationCounts: {
        jobsCancelled: 0,
        blockerResolved: 1,
        transitionInserted: 1,
        resolutionUpdated: 1,
        outboxInserted: 1,
        runUpdated: 1,
        auditInserted: 1,
        pausesCleared: 2,
      },
      actualMutationCountsHash:
        dryRun.expectedMutationCountsHash,
      hardSwitchRemainsEngaged: true,
      intentPublicPauseRemainsEngaged: true,
      safeRoutesResumed: true,
    });
    expect((await database.query(
      `SELECT run.status,run.phase,resolution.generation,resolution.state,
              resolution.next_action,resolution.incident_reference,
              blocker.resolved_at IS NOT NULL blocker_resolved
       FROM research_runs run
       JOIN playlist_run_resolutions resolution ON resolution.run_id=run.id
       LEFT JOIN playlist_run_blockers blocker ON blocker.id=$2
       WHERE run.id=$1`,
      [incidentRunId, incidentBlockerId],
    )).rows).toEqual([{
      status: "failed_integrity",
      phase: "v254_evidence_persistence_quarantined",
      generation: 4,
      state: "quarantined",
      next_action: "contact_support",
      incident_reference: "v254-irish-influence-evidence-persistence",
      blocker_resolved: true,
    }]);
    expect((await database.query(
      `SELECT key,value FROM settings
       WHERE key IN ('research_paused','publishing_paused')
       ORDER BY key`,
    )).rows).toEqual([
      { key: "publishing_paused", value: "false" },
      { key: "research_paused", value: "false" },
    ]);
    expect((await database.query(
      `SELECT
         (SELECT count(*)::int
          FROM playlist_run_resolution_transitions
          WHERE run_id=$1) transition_count,
         (SELECT count(*)::int
          FROM playlist_resolution_outbox
          WHERE run_id=$1) outbox_count,
         (SELECT count(*)::int
          FROM audit_events
          WHERE run_id=$1
            AND action='run.technical_quarantined') audit_count`,
      [incidentRunId],
    )).rows[0]).toEqual({
      transition_count: 1,
      outbox_count: 1,
      audit_count: 1,
    });

    const reviewSnapshot =
      await collectV254IrishInfluenceContainmentSnapshot(database);
    const reviewRow = reviewSnapshot.reviewInventory.find(
      ({ run_id }) => run_id === ownerReviewRunId,
    );
    expect(reviewRow).toBeDefined();
    await database.query(
      `INSERT INTO audit_events(run_id,actor,action,detail_json)
       VALUES(
         $1,'owner_authorized','run.v254_owner_review_disposition',$2::jsonb
       )`,
      [
        ownerReviewRunId,
        JSON.stringify({
          schemaVersion: "genio-v254-owner-review-disposition/v1",
          incidentReference:
            "v254-irish-influence-evidence-persistence",
          route: V254_CONTAINMENT_ROUTE,
          intentGroup: V254_CONTAINMENT_INTENT,
          releaseRevision: incidentReleaseRevision,
          semanticConfigurationHash:
            incidentSemanticConfigurationHash,
          runIdHash: v254OwnerReviewRunIdHash(ownerReviewRunId),
          inventoryRowHash:
            v254OwnerReviewInventoryRowHash(reviewRow!),
          disposition: "hold_immutable_no_execution",
          ownerAuthorized: true,
          reasonCode: "owner_reviewed_hold_immutable",
        }),
      ],
    );

    await pauseV254IrishInfluenceContainment(database);
    const repeatedDryRun = await executeV254IrishInfluenceContainment(
      database,
      "contain-dry-run",
      undefined,
    );
    expect(repeatedDryRun).toMatchObject({
      mode: "contain-dry-run",
      safeToApply: true,
      alreadyApplied: true,
      receiptHash: dryRun.receiptHash,
      ownerReviewCandidateCount: 1,
      ownerReviewDispositionCount: 1,
      ownerReviewUndispositionedCount: 0,
      ownerReviewUnresolvedExecutableWorkCount: 0,
      ownerReviewUnresolvedPublicationWorkCount: 0,
      ownerReviewPromotionSafe: true,
    });
    const repeatedApply = await executeV254IrishInfluenceContainment(
      database,
      "contain-apply",
      repeatedDryRun.receiptHash,
    );
    const appliedReceipt = applied as {
      affectedRunSetHash: string;
      observedCountsHash: string;
    };
    expect(repeatedApply).toMatchObject({
      mode: "contain-apply",
      applied: false,
      receiptHash: dryRun.receiptHash,
      affectedRunCount: 1,
      affectedRunSetHash: appliedReceipt.affectedRunSetHash,
      ownerReviewCandidateCount: 1,
      ownerReviewDispositionCount: 1,
      ownerReviewUndispositionedCount: 0,
      ownerReviewPromotionSafe: true,
      observedCountsHash: appliedReceipt.observedCountsHash,
      mutationCounts: {
        jobsCancelled: 0,
        blockerResolved: 0,
        transitionInserted: 0,
        resolutionUpdated: 0,
        outboxInserted: 0,
        runUpdated: 0,
        auditInserted: 0,
        pausesCleared: 2,
      },
      mutationCountsHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      expectedMutationCounts: {
        jobsCancelled: 0,
        blockerResolved: 0,
        transitionInserted: 0,
        resolutionUpdated: 0,
        outboxInserted: 0,
        runUpdated: 0,
        auditInserted: 0,
        pausesCleared: 2,
      },
      expectedMutationCountsHash:
        expect.stringMatching(/^[0-9a-f]{64}$/u),
      actualMutationCounts: {
        jobsCancelled: 0,
        blockerResolved: 0,
        transitionInserted: 0,
        resolutionUpdated: 0,
        outboxInserted: 0,
        runUpdated: 0,
        auditInserted: 0,
        pausesCleared: 2,
      },
      actualMutationCountsHash:
        expect.stringMatching(/^[0-9a-f]{64}$/u),
      hardSwitchRemainsEngaged: true,
      safeRoutesResumed: true,
    });
    expect((await database.query(
      `SELECT
         (SELECT count(*)::int
          FROM playlist_run_resolution_transitions
          WHERE run_id=$1) transition_count,
         (SELECT count(*)::int
          FROM playlist_resolution_outbox
          WHERE run_id=$1) outbox_count,
         (SELECT count(*)::int
          FROM audit_events
          WHERE run_id=$1
            AND action='run.technical_quarantined') audit_count`,
      [incidentRunId],
    )).rows[0]).toEqual({
      transition_count: 1,
      outbox_count: 1,
      audit_count: 1,
    });
  });
});
