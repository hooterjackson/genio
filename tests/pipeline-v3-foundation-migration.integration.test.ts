import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Repository } from "../server/repository.ts";
import { createQueryPlanV3, queryPlanV3Hash } from "../server/query-plan-v3.ts";
import {
  createRunSpecV3,
  resolveRunSpecV3,
  selectionPlanV3Hash,
  type SelectionPlanV3,
} from "../server/selection-plan-v3.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseDescribe = databaseUrl ? describe.sequential : describe.skip;
const migrationDirectory = new URL("../postgres-migrations/", import.meta.url);
const migrationFiles = readdirSync(migrationDirectory)
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort();
const schema13MigrationSql = migrationFiles
  // Reconstruct the schema immediately before 0013. A name-based exclusion
  // accidentally included later migrations after schema 14/15 were added.
  .filter((file) => file < "0013_")
  .map((file) => readFileSync(new URL(`../postgres-migrations/${file}`, import.meta.url), "utf8"))
  .join("\n-- statement-breakpoint\n");
const pipelineV3MigrationSql = readFileSync(
  new URL("../postgres-migrations/0013_corpus_first_v3_foundation.sql", import.meta.url),
  "utf8",
);

async function applySql(pool: Pool, sql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of sql
      .split(/\s*-- statement-breakpoint\s*/u)
      .map((value) => value.trim())
      .filter(Boolean)) {
      await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

databaseDescribe("Pipeline V3 expand foundation", () => {
  const schemaName = `genio_v3_upgrade_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: "genio-v3-upgrade-admin",
    });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 3,
      application_name: "genio-v3-upgrade-integration",
    });
    await applySql(pool, schema13MigrationSql);
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  }, 30_000);

  test("preserves V1/V2 jobs and creates fenced, revision-bound V3 state", async () => {
    const legacyRunId = randomUUID();
    const v2RunId = randomUUID();
    const legacyJobId = randomUUID();
    const v2JobId = randomUUID();

    for (const [runId, pipelineVersion, policyVersion, marker] of [
      [legacyRunId, "legacy_v1", "legacy_v1", "a"],
      [v2RunId, "catalog_first_v2", "relevance_first_2026_07_r2", "b"],
    ] as const) {
      await pool.query(
        `INSERT INTO research_runs(
           id,prompt,brief_json,brief_hash,status,phase,client_bucket,
           idempotency_key,retention_expires_at,pipeline_version,policy_version
         ) VALUES($1,$2,'{}'::jsonb,$3,'queued','scope','upgrade-bucket',$4,
           now()+interval '1 day',$5,$6)`,
        [runId, `${pipelineVersion} run`, marker.repeat(64), randomUUID(), pipelineVersion, policyVersion],
      );
    }
    await pool.query(
      "INSERT INTO job_queue(id,run_id,kind,dedupe_key) VALUES($1,$2,'research',$3),($4,$5,'research',$6)",
      [legacyJobId, legacyRunId, randomUUID(), v2JobId, v2RunId, randomUUID()],
    );

    expect((await pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key='schema_version'",
    )).rows[0]?.value).toBe("13");

    await applySql(pool, pipelineV3MigrationSql);

    expect((await pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key='schema_version'",
    )).rows[0]?.value).toBe("14");
    expect((await pool.query(
      `SELECT id,status,content_hash,assertion_count,catalog_identity_count,locked_at
       FROM graph_snapshots WHERE id='00000000-0000-4000-8000-000000000014'`,
    )).rows).toEqual([expect.objectContaining({
      id: "00000000-0000-4000-8000-000000000014",
      status: "locked",
      content_hash: "f2b3e01c5bcbe9c259875fbd592e71bfd7fe4aa4e6399e212ee42fad8feb006a",
      assertion_count: 0,
      catalog_identity_count: 0,
    })]);
    expect((await pool.query<{
      id: string;
      pipeline_version: string;
      minimum_worker_protocol: number;
      lease_epoch: string;
      stage_key: string;
      query_plan_revision_id: string | null;
    }>(
      `SELECT id,pipeline_version,minimum_worker_protocol,lease_epoch::text,stage_key,query_plan_revision_id
       FROM job_queue WHERE id=ANY($1::uuid[])`,
      [[legacyJobId, v2JobId]],
    )).rows).toEqual(expect.arrayContaining([
      {
        id: legacyJobId,
        pipeline_version: "legacy_v1",
        minimum_worker_protocol: 4,
        lease_epoch: "0",
        stage_key: "default",
        query_plan_revision_id: null,
      },
      {
        id: v2JobId,
        pipeline_version: "catalog_first_v2",
        minimum_worker_protocol: 5,
        lease_epoch: "0",
        stage_key: "default",
        query_plan_revision_id: null,
      },
    ]));

    const runId = randomUUID();
    const snapshotId = randomUUID();
    const mismatchedSnapshotId = randomUUID();
    const selectionPlanId = randomUUID();
    const queryPlanId = randomUUID();
    const artistId = randomUUID();
    const recordingId = randomUUID();
    const sourceId = randomUUID();
    const observationId = randomUUID();
    const assertionId = randomUUID();
    const catalogIdentityId = randomUUID();
    const candidateId = randomUUID();
    const manifestId = randomUUID();
    const manifestRevisionId = randomUUID();
    const capabilitySessionId = randomUUID();
    const decisionId = randomUUID();
    const seriesId = randomUUID();
    const attemptId = randomUUID();
    const volumeId = randomUUID();
    const jobId = randomUUID();

    await pool.query(
      `INSERT INTO research_runs(
         id,prompt,brief_json,brief_hash,status,phase,client_bucket,
         idempotency_key,retention_expires_at,pipeline_version,policy_version
       ) VALUES($1,'V3 canonical title','{}'::jsonb,$2,'queued','planning','v3-bucket',$3,
         now()+interval '1 day','corpus_first_v3','corpus_first_v3_policy_v1')`,
      [runId, "c".repeat(64), randomUUID()],
    );
    await pool.query(
      `INSERT INTO run_specs(
         run_id,raw_prompt,requested_track_count,storefront,guidance_answers_json,
         spec_hash,pipeline_version,policy_version
       ) VALUES($1,'25 essential house music tracks',25,'us','[]'::jsonb,$2,
         'corpus_first_v3','corpus_first_v3_policy_v1')`,
      [runId, "d".repeat(64)],
    );
    await expect(pool.query(
      "UPDATE run_specs SET raw_prompt='mutated' WHERE run_id=$1",
      [runId],
    )).rejects.toThrow(/immutable/u);

    await pool.query(
      "INSERT INTO graph_snapshots(id,status) VALUES($1,'building')",
      [snapshotId],
    );
    await pool.query(
      `INSERT INTO corpus_entities(id,entity_type,canonical_key,canonical_name)
       VALUES($1,'artist','artist:example','Example Artist')`,
      [artistId],
    );
    await pool.query(
      `INSERT INTO corpus_recordings(id,canonical_key,primary_artist_entity_id,title,version_class)
       VALUES($1,'recording:example',$2,'Example Track','studio')`,
      [recordingId, artistId],
    );
    await pool.query(
      `INSERT INTO corpus_source_documents(
         id,url,content_hash,title,source_class,provenance_root,access_method,source_revision,retrieved_at
       ) VALUES($1,'https://example.test/source',$2,'Example source','editorial','example.test',
         'manual_entry',$2,now())`,
      [sourceId, "e".repeat(64)],
    );
    await pool.query(
      `INSERT INTO corpus_assertion_observations(
         id,observation_key,source_document_id,recording_id,predicate,object_json,
         support_excerpt,confidence,status,pipeline_version,policy_version
       ) VALUES($1,$2,$3,$4,'genre_membership','{"genre":"house"}'::jsonb,
         'The source explicitly classifies the track as house.',0.9,'promoted',
         'corpus_first_v3','corpus_first_v3_policy_v1')`,
      [observationId, "f".repeat(64), sourceId, recordingId],
    );
    await pool.query(
      `INSERT INTO corpus_promoted_assertions(
         id,assertion_key,recording_id,predicate,object_json,evidence_tier,promoted_by
       ) VALUES($1,$2,$3,'genre_membership','{"genre":"house"}'::jsonb,'verified','migration-test')`,
      [assertionId, "1".repeat(64), recordingId],
    );
    await pool.query(
      `INSERT INTO corpus_assertion_evidence(promoted_assertion_id,observation_id) VALUES($1,$2)`,
      [assertionId, observationId],
    );
    await pool.query(
      `INSERT INTO corpus_catalog_identities(
         id,recording_id,provider,storefront,catalog_id,is_preferred,identity_confidence
       ) VALUES($1,$2,'apple','us','apple-song-1',true,1)`,
      [catalogIdentityId, recordingId],
    );
    await pool.query(
      "INSERT INTO graph_snapshot_assertions(graph_snapshot_id,assertion_id) VALUES($1,$2)",
      [snapshotId, assertionId],
    );
    await pool.query(
      "INSERT INTO graph_snapshot_catalog_identities(graph_snapshot_id,catalog_identity_id) VALUES($1,$2)",
      [snapshotId, catalogIdentityId],
    );
    await pool.query(
      `UPDATE graph_snapshots SET status='locked',content_hash=$2,assertion_count=1,
         catalog_identity_count=1,locked_at=now() WHERE id=$1`,
      [snapshotId, "2".repeat(64)],
    );
    await pool.query(
      "INSERT INTO graph_snapshots(id,status) VALUES($1,'building')",
      [mismatchedSnapshotId],
    );
    await pool.query(
      `UPDATE graph_snapshots SET status='locked',content_hash=$2,assertion_count=0,
         catalog_identity_count=0,locked_at=now() WHERE id=$1`,
      [mismatchedSnapshotId, "8".repeat(64)],
    );
    expect((await pool.query<{
      assertion_id: string;
      observation_id: string;
      source_document_id: string;
    }>(
      `SELECT assertion_revision_json->>'id' assertion_id,
              assertion_revision_json#>>'{evidence,0,observation,id}' observation_id,
              assertion_revision_json#>>'{evidence,0,sourceDocument,id}' source_document_id
       FROM graph_snapshot_assertions
       WHERE graph_snapshot_id=$1 AND assertion_id=$2`,
      [snapshotId, assertionId],
    )).rows[0]).toEqual({ assertion_id: assertionId, observation_id: observationId, source_document_id: sourceId });
    expect((await pool.query<{ catalog_identity_id: string }>(
      `SELECT catalog_identity_revision_json->>'id' catalog_identity_id
       FROM graph_snapshot_catalog_identities
       WHERE graph_snapshot_id=$1 AND catalog_identity_id=$2`,
      [snapshotId, catalogIdentityId],
    )).rows[0]).toEqual({ catalog_identity_id: catalogIdentityId });
    await expect(pool.query(
      "DELETE FROM graph_snapshot_assertions WHERE graph_snapshot_id=$1 AND assertion_id=$2",
      [snapshotId, assertionId],
    )).rejects.toThrow(/immutable/u);

    const selectionPlanJson = {
      ...resolveRunSpecV3(createRunSpecV3({
        prompt: "25 essential house music tracks",
        requestedTrackCount: 25,
        storefront: "us",
      }), []),
      diversityGoals: {
        minimumDistinctArtists: 5,
        minimumDistinctAlbums: 7,
        minimumDistinctEras: 2,
        minimumDistinctScenes: 2,
        minimumDistinctGeographies: null,
        maximumTracksPerArtist: 4,
        maximumTracksPerAlbum: 3,
      },
      orderingPolicy: {
        mode: "editorial",
        goals: [],
        avoidAdjacentSameArtist: true,
        avoidAdjacentSameAlbum: true,
      },
      softGoalRelaxationOrder: ["album_concentration", "artist_concentration"],
    } satisfies SelectionPlanV3;
    const selectionPlanHash = selectionPlanV3Hash(selectionPlanJson);
    await pool.query(
      `INSERT INTO selection_plans(
         id,run_id,revision,status,plan_hash,plan_json,pipeline_version,policy_version,confirmed_at
       ) VALUES($1,$2,1,'active',$3,$4::jsonb,'corpus_first_v3','corpus_first_v3_policy_v1',now())`,
      [selectionPlanId, runId, selectionPlanHash, JSON.stringify(selectionPlanJson)],
    );
    const queryPlanJson = createQueryPlanV3(selectionPlanJson, snapshotId);
    await pool.query(
      `INSERT INTO query_plan_revisions(
         id,run_id,selection_plan_id,revision,graph_snapshot_id,engine,status,plan_hash,plan_json,
         pipeline_version,policy_version,activated_at
       ) VALUES($1,$2,$3,1,$4,'curated_genre_scene','active',$5,$6::jsonb,
         'corpus_first_v3','corpus_first_v3_policy_v1',now())`,
      [
        queryPlanId,
        runId,
        selectionPlanId,
        snapshotId,
        queryPlanV3Hash(queryPlanJson),
        JSON.stringify(queryPlanJson),
      ],
    );
    await pool.query(
      "INSERT INTO run_active_query_plans(run_id,query_plan_revision_id) VALUES($1,$2)",
      [runId, queryPlanId],
    );
    await expect(pool.query(
      "UPDATE query_plan_revisions SET graph_snapshot_id=$2 WHERE id=$1",
      [queryPlanId, mismatchedSnapshotId],
    )).rejects.toThrow(/query plan contract is immutable/u);
    await pool.query(
      `INSERT INTO track_candidates(id,run_id,canonical_key,artist,title)
       VALUES($1,$2,'candidate:example','Example Artist','Example Track')`,
      [candidateId, runId],
    );
    await pool.query(
      `INSERT INTO run_corpus_recording_links(
         run_id,candidate_id,query_plan_revision_id,graph_snapshot_id,corpus_recording_id,
         corpus_catalog_identity_id,identity_status,membership_status,relevance_status,selection_status
       ) VALUES($1,$2,$3,$4,$5,$6,'resolved','eligible','eligible','selected')`,
      [runId, candidateId, queryPlanId, snapshotId, recordingId, catalogIdentityId],
    );

    await pool.query(
      `INSERT INTO manifests(id,run_id,name,description,content_hash,pipeline_version,policy_version)
       VALUES($1,$2,'V3 test','V3 migration test',$3,'corpus_first_v3','corpus_first_v3_policy_v1')`,
      [manifestId, runId, "4".repeat(64)],
    );

    await expect(pool.query(
      `INSERT INTO manifest_revisions(
         id,manifest_id,revision,status,reason,content_hash,pipeline_version,policy_version,locked_at
       ) VALUES($1,$2,97,'locked','missing V3 bindings',$3,
         'corpus_first_v3','corpus_first_v3_policy_v1',now())`,
      [randomUUID(), manifestId, "9".repeat(64)],
    )).rejects.toThrow(/binding is incomplete/u);
    await expect(pool.query(
      `INSERT INTO manifest_revisions(
         id,manifest_id,revision,status,reason,content_hash,pipeline_version,policy_version,
         selection_plan_id,query_plan_revision_id,graph_snapshot_id,run_spec_hash,locked_at
       ) VALUES($1,$2,98,'locked','wrong run spec',$3,
         'corpus_first_v3','corpus_first_v3_policy_v1',$4,$5,$6,$7,now())`,
      [
        randomUUID(),
        manifestId,
        "a".repeat(64),
        selectionPlanId,
        queryPlanId,
        snapshotId,
        "0".repeat(64),
      ],
    )).rejects.toThrow(/run-spec hash/u);
    await expect(pool.query(
      `INSERT INTO manifest_revisions(
         id,manifest_id,revision,status,reason,content_hash,pipeline_version,policy_version,
         selection_plan_id,query_plan_revision_id,graph_snapshot_id,run_spec_hash,locked_at
       ) VALUES($1,$2,99,'locked','mismatched graph',$3,
         'corpus_first_v3','corpus_first_v3_policy_v1',$4,$5,$6,$7,now())`,
      [
        randomUUID(),
        manifestId,
        "b".repeat(64),
        selectionPlanId,
        queryPlanId,
        mismatchedSnapshotId,
        "d".repeat(64),
      ],
    )).rejects.toThrow(/query, selection, and graph bindings disagree/u);

    await pool.query(
      `INSERT INTO manifest_revisions(
         id,manifest_id,revision,status,reason,content_hash,pipeline_version,policy_version,
         selection_plan_id,query_plan_revision_id,graph_snapshot_id,run_spec_hash,locked_at
       ) VALUES($1,$2,1,'locked','initial',$3,'corpus_first_v3','corpus_first_v3_policy_v1',
         $4,$5,$6,$7,now())`,
      [
        manifestRevisionId,
        manifestId,
        "5".repeat(64),
        selectionPlanId,
        queryPlanId,
        snapshotId,
        "d".repeat(64),
      ],
    );
    expect((await pool.query<{
      selection_plan_id: string;
      query_plan_revision_id: string;
      graph_snapshot_id: string;
      run_spec_hash: string;
    }>(
      `SELECT selection_plan_id,query_plan_revision_id,graph_snapshot_id,run_spec_hash
       FROM manifest_revisions WHERE id=$1`,
      [manifestRevisionId],
    )).rows[0]).toEqual({
      selection_plan_id: selectionPlanId,
      query_plan_revision_id: queryPlanId,
      graph_snapshot_id: snapshotId,
      run_spec_hash: "d".repeat(64),
    });
    await expect(pool.query(
      "UPDATE manifest_revisions SET graph_snapshot_id=$2 WHERE id=$1",
      [manifestRevisionId, mismatchedSnapshotId],
    )).rejects.toThrow(/binding is immutable/u);
    await pool.query(
      `INSERT INTO capability_sessions(id,run_id,token_hash,expires_at)
       VALUES($1,$2,$3,now()+interval '1 hour')`,
      [capabilitySessionId, runId, "6".repeat(64)],
    );
    await pool.query(
      `INSERT INTO partial_publication_decisions(
         id,run_id,manifest_revision_id,manifest_revision_hash,query_plan_revision_id,
         capability_session_id,outcome_hash,decision,target_count,selected_count,
         idempotency_key,expires_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',25,1,$8,now()+interval '1 hour')`,
      [
        decisionId,
        runId,
        manifestRevisionId,
        "5".repeat(64),
        queryPlanId,
        capabilitySessionId,
        "7".repeat(64),
        randomUUID(),
      ],
    );
    await pool.query(
      "UPDATE partial_publication_decisions SET decision='publish_partial',decided_at=now() WHERE id=$1",
      [decisionId],
    );

    await pool.query(
      "INSERT INTO publication_series(id,run_id,title) VALUES($1,$2,'V3 test series')",
      [seriesId, runId],
    );
    await pool.query(
      `INSERT INTO publication_revision_attempts(
         id,series_id,manifest_revision_id,attempt,idempotency_key,status,content_hash
       ) VALUES($1,$2,$3,1,$4,'complete',$5)`,
      [attemptId, seriesId, manifestRevisionId, randomUUID(), "5".repeat(64)],
    );
    await pool.query(
      `INSERT INTO publication_revision_volumes(
         id,publication_attempt_id,volume_number,volume_count,start_position,end_position,status,appended_count
       ) VALUES($1,$2,1,1,1,1,'complete',1)`,
      [volumeId, attemptId],
    );
    await pool.query(
      `INSERT INTO publication_series_active_revisions(series_id,publication_attempt_id) VALUES($1,$2)`,
      [seriesId, attemptId],
    );

    await pool.query(
      `INSERT INTO job_queue(
         id,run_id,kind,dedupe_key,pipeline_version,minimum_worker_protocol,
         query_plan_revision_id,stage_key
       ) VALUES($1,$2,'research',$3,'legacy_v1',4,$4,'discovery:round-a')`,
      [jobId, runId, randomUUID(), queryPlanId],
    );
    expect((await pool.query<{
      pipeline_version: string;
      minimum_worker_protocol: number;
      lease_epoch: string;
      stage_key: string;
    }>(
      "SELECT pipeline_version,minimum_worker_protocol,lease_epoch::text,stage_key FROM job_queue WHERE id=$1",
      [jobId],
    )).rows[0]).toEqual({
      pipeline_version: "corpus_first_v3",
      minimum_worker_protocol: 6,
      lease_epoch: "0",
      stage_key: "discovery:round-a",
    });

    await pool.query(
      "UPDATE job_queue SET status='leased',lease_owner='worker-a',lease_expires_at=now()+interval '1 minute' WHERE id=$1",
      [jobId],
    );
    expect((await pool.query<{ lease_epoch: string }>(
      "SELECT lease_epoch::text FROM job_queue WHERE id=$1",
      [jobId],
    )).rows[0]?.lease_epoch).toBe("1");
    await pool.query(
      "UPDATE job_queue SET lease_expires_at=now()+interval '2 minutes' WHERE id=$1",
      [jobId],
    );
    expect((await pool.query<{ lease_epoch: string }>(
      "SELECT lease_epoch::text FROM job_queue WHERE id=$1",
      [jobId],
    )).rows[0]?.lease_epoch).toBe("1");
    await pool.query(
      "UPDATE job_queue SET status='retry',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
      [jobId],
    );
    await pool.query(
      "UPDATE job_queue SET status='leased',lease_owner='worker-b',lease_expires_at=now()+interval '1 minute' WHERE id=$1",
      [jobId],
    );
    expect((await pool.query<{ lease_epoch: string }>(
      "SELECT lease_epoch::text FROM job_queue WHERE id=$1",
      [jobId],
    )).rows[0]?.lease_epoch).toBe("2");

    const repository = new Repository({ pool, db: {} } as never);
    const currentFence = {
      jobId,
      workerId: "worker-b",
      leaseEpoch: 2,
      queryPlanRevisionId: queryPlanId,
      stageKey: "discovery:round-a",
    };
    const staleFence = { ...currentFence, leaseEpoch: 1 };

    await repository.saveResearchCheckpoint(runId, "v3:fenced", { owner: "current" }, currentFence);
    await expect(repository.saveResearchCheckpoint(
      runId,
      "v3:fenced",
      { owner: "stale" },
      staleFence,
    )).rejects.toMatchObject({ code: "job_lease_lost" });
    expect((await pool.query<{ state_json: unknown }>(
      "SELECT state_json FROM research_checkpoints WHERE run_id=$1 AND phase='v3:fenced'",
      [runId],
    )).rows[0]?.state_json).toEqual({ owner: "current" });

    await expect(repository.updateRun(runId, {
      status: "researching",
      phase: "stale-worker-write",
    }, staleFence)).rejects.toMatchObject({ code: "job_lease_lost" });
    await repository.updateRun(runId, {
      status: "researching",
      phase: "current-worker-write",
    }, currentFence);
    expect((await pool.query<{ phase: string }>(
      "SELECT phase FROM research_runs WHERE id=$1",
      [runId],
    )).rows[0]?.phase).toBe("current-worker-write");

    await expect(repository.completeJob(jobId, "worker-b", 1))
      .rejects.toMatchObject({ code: "job_lease_lost" });
    await repository.completeJob(jobId, "worker-b", 2);
    expect((await pool.query<{ status: string }>(
      "SELECT status FROM job_queue WHERE id=$1",
      [jobId],
    )).rows[0]?.status).toBe("complete");

    await applySql(pool, pipelineV3MigrationSql);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM run_specs WHERE run_id=$1",
      [runId],
    )).rows[0]?.count).toBe(1);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM publication_series_active_revisions WHERE series_id=$1",
      [seriesId],
    )).rows[0]?.count).toBe(1);
  }, 30_000);
});
