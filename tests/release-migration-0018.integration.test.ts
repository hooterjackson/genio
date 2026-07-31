import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as databaseSchema from "../db/schema.ts";
import {
  persistReleaseCanaryMarker,
} from "../server/release-canary-persistence.ts";
import { readReleaseCanaryInventory } from "../server/release-canary-inventory.ts";
import { Repository } from "../server/repository.ts";
import { createPublicRolloutAssignmentV1 } from "../server/public-rollout-assignment.ts";
import type { PublicRolloutConfiguration } from "../shared/public-rollout-evidence.ts";
import { signedArtifactSha256 } from "../shared/signed-artifact.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseDescribe = databaseUrl ? describe.sequential : describe.skip;
const migrationDirectory = new URL("../postgres-migrations/", import.meta.url);
const migrationFiles = readdirSync(migrationDirectory)
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort();
const through0017 = migrationFiles
  .filter((file) => file <= "0017_playlist_recovery_foundation.sql")
  .map((file) => readFileSync(
    new URL(`../postgres-migrations/${file}`, import.meta.url),
    "utf8",
  ))
  .join("\n-- statement-breakpoint\n");
const migration0018 = readFileSync(
  new URL(
    "../postgres-migrations/0018_release_manifest_canary_guards.sql",
    import.meta.url,
  ),
  "utf8",
);

async function applySql(pool: Pool, source: string): Promise<void> {
  for (const statement of source
    .split(/\s*-- statement-breakpoint\s*/u)
    .map((value) => value.trim())
    .filter(Boolean)) {
    await pool.query(statement);
  }
}

databaseDescribe("release migration 0018 upgrade", () => {
  const schemaName =
    `genio_release_0018_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool | undefined;
  let pool: Pool | undefined;

  beforeAll(async () => {
    adminPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: "genio-release-0018-admin",
    });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 4,
      application_name: "genio-release-0018",
    });
    await applySql(pool, through0017);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  });

  test("upgrades an already-schema-18 database without relabeling legacy cache claims", async () => {
    const database = pool!;
    expect((await database.query<{ value: string }>(
      "SELECT value FROM settings WHERE key='schema_version'",
    )).rows[0]?.value).toBe("18");
    expect((await database.query(
      "SELECT value FROM settings WHERE key='release_manifest_canary_guards_version'",
    )).rowCount).toBe(0);
    await expect(readReleaseCanaryInventory({
      pool: database,
      canaryId: "bridge-inventory",
      environment: "staging",
      sourceRevision: "e".repeat(40),
      executionProof: async () => null,
    })).resolves.toMatchObject({
      schemaAvailable: false,
      readyForReleaseEvidence: false,
      operations: [],
    });
    const compatibilityClient = await database.connect();
    try {
      await expect(persistReleaseCanaryMarker(
        compatibilityClient,
        null,
        { operation: "brief", id: randomUUID() },
      )).resolves.toBeUndefined();
      await expect(persistReleaseCanaryMarker(
        compatibilityClient,
        {
          version: "genio-release-canary/v1",
          canaryId: "bridge-explicit-canary",
          environment: "staging",
          audience: "https://staging.9enio.example",
          operation: "brief",
          sourceRevision: "f".repeat(40),
          issuedAt: new Date().toISOString(),
          cacheMode: "reuse_disabled",
        },
        { operation: "brief", id: randomUUID() },
      )).rejects.toMatchObject({
        statusCode: 503,
        code: "release_canary_unavailable",
      });
    } finally {
      compatibilityClient.release();
    }

    for (const cacheMode of ["cold", "warm", "mixed"] as const) {
      const briefId = randomUUID();
      await database.query(
        `INSERT INTO brief_requests(
           id,prompt,model,status,client_bucket,expires_at)
         VALUES($1,$2,'migration-test','complete',$3,now()+interval '1 day')`,
        [briefId, `legacy ${cacheMode}`, `legacy-${cacheMode}`],
      );
      await database.query(
        `INSERT INTO release_canary_markers(
           id,canary_id,environment,operation,source_revision,cache_mode,
           brief_request_id)
         VALUES($1,$2,'staging','brief',$3,$4,$5)`,
        [
          randomUUID(),
          `legacy-${cacheMode}`,
          "a".repeat(40),
          cacheMode,
          briefId,
        ],
      );
    }

    const runId = randomUUID();
    const contractId = randomUUID();
    const selectionPlanId = randomUUID();
    const graphSnapshotId = randomUUID();
    const queryPlanId = randomUUID();
    const selectionPlanHash = "1".repeat(64);
    await database.query(
      `INSERT INTO research_runs(
         id,prompt,brief_json,brief_hash,status,phase,client_bucket,
         idempotency_key,retention_expires_at)
       VALUES($1,'bridge attempt','{}'::jsonb,$2,'queued','queued',
         'bridge-attempt','bridge-attempt',now()+interval '1 day')`,
      [runId, "2".repeat(64)],
    );
    await database.query(
      `INSERT INTO playlist_contract_revisions(
         id,run_id,revision,status,contract_hash,contract_json,
         compiler_version,ontology_version,evidence_policy_version,
         question_template_version,catalog_policy_version,locale,storefront,
         answer_lineage_hash)
       VALUES($1,$2,1,'active',$3,'{}'::jsonb,'compiler-test',
         'ontology-test','evidence-test','questions-test','catalog-test',
         'en-US','us',$4)`,
      [contractId, runId, "3".repeat(64), "4".repeat(64)],
    );
    await database.query(
      "UPDATE research_runs SET active_playlist_contract_revision_id=$2 WHERE id=$1",
      [runId, contractId],
    );
    await database.query(
      `INSERT INTO selection_plans(
         id,run_id,revision,status,plan_hash,plan_json,pipeline_version,
         policy_version,confirmed_at)
       VALUES($1,$2,1,'active',$3,'{}'::jsonb,'corpus_first_v3',
         'corpus_first_v3_policy_v1',now())`,
      [selectionPlanId, runId, selectionPlanHash],
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
       VALUES($1,$2,$3,1,$4,'portfolio','active',$5,$6::jsonb,
         'corpus_first_v3','corpus_first_v3_policy_v1',now())`,
      [
        queryPlanId,
        runId,
        selectionPlanId,
        graphSnapshotId,
        "6".repeat(64),
        JSON.stringify({ selectionPlanHash }),
      ],
    );
    await database.query(
      `INSERT INTO run_active_query_plans(run_id,query_plan_revision_id)
       VALUES($1,$2)`,
      [runId, queryPlanId],
    );
    const repository = new Repository({
      pool: database,
      db: drizzle(database, { schema: databaseSchema }),
    });
    const bridgeAttemptInput = {
      runId,
      contractRevisionId: contractId,
      queryPlanRevisionId: queryPlanId,
      stage: "bridge-stage",
      dependencyKey: "provider",
      attemptNumber: 1,
      leaseGeneration: 1,
      executorRevision: "7".repeat(40),
      executorIdentityHash: "8".repeat(64),
      configurationHash: "9".repeat(64),
      idempotencyKey: `bridge-attempt:${runId}`,
      checkpointCursor: null,
    };
    const bridgeAttempt = await repository.beginPlaylistExecutionAttempt(
      bridgeAttemptInput,
    );
    expect(bridgeAttempt).toMatchObject({ created: true });
    await expect(repository.beginPlaylistExecutionAttempt(
      bridgeAttemptInput,
    )).resolves.toMatchObject({
      id: bridgeAttempt.id,
      created: false,
    });

    await applySql(database, migration0018);

    expect((await database.query<{
      cache_mode: string;
      audience: string;
    }>(
      `SELECT cache_mode,audience
       FROM release_canary_markers
       ORDER BY canary_id`,
    )).rows).toEqual([
      {
        cache_mode: "legacy_unknown",
        audience: "https://legacy-canary.invalid",
      },
      {
        cache_mode: "legacy_unknown",
        audience: "https://legacy-canary.invalid",
      },
      {
        cache_mode: "legacy_unknown",
        audience: "https://legacy-canary.invalid",
      },
    ]);
    expect((await database.query<{ value: string }>(
      "SELECT value FROM settings WHERE key='release_manifest_canary_guards_version'",
    )).rows[0]?.value).toBe("1");
    expect((await database.query(
      "SELECT value FROM settings WHERE key='canonical_execution_hardening_version'",
    )).rowCount).toBe(0);
    expect((await database.query<{ delete_action: string }>(
      `SELECT confdeltype::text delete_action
       FROM pg_constraint
       WHERE conrelid='playlist_execution_attempts'::regclass
         AND conname='playlist_execution_attempts_query_plan_revision_id_fkey'`,
    )).rows[0]?.delete_action).toBe("c");
    // 0018 adds the nullable query-plan column but intentionally does not
    // activate schema-19 executor fencing. A bridge attempt therefore
    // remains legacy/null until 0019's independent capability marker exists.
    const post0018BridgeAttempt = await repository.beginPlaylistExecutionAttempt({
      ...bridgeAttemptInput,
      attemptNumber: 2,
      idempotencyKey: `fenced-attempt:${runId}`,
    });
    expect(post0018BridgeAttempt.created).toBe(true);
    expect((await database.query<{
      id: string;
      query_plan_revision_id: string | null;
    }>(
      `SELECT id,query_plan_revision_id
       FROM playlist_execution_attempts
       WHERE id=ANY($1::uuid[])
       ORDER BY id`,
      [[bridgeAttempt.id, post0018BridgeAttempt.id]],
    )).rows).toEqual(expect.arrayContaining([
      { id: bridgeAttempt.id, query_plan_revision_id: null },
      { id: post0018BridgeAttempt.id, query_plan_revision_id: null },
    ]));

    const newBriefId = randomUUID();
    await database.query(
      `INSERT INTO brief_requests(
         id,prompt,model,status,client_bucket,expires_at)
       VALUES($1,'new canary','migration-test','complete','new-canary',
         now()+interval '1 day')`,
      [newBriefId],
    );
    await expect(database.query(
      `INSERT INTO release_canary_markers(
         id,canary_id,environment,audience,operation,source_revision,cache_mode,
         brief_request_id)
       VALUES($1,'new-canary','staging','https://staging.9enio.example',
         'brief',$2,'reuse_disabled',$3)`,
      [randomUUID(), "b".repeat(40), newBriefId],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(database.query(
      `UPDATE release_canary_markers
       SET cache_mode='cold'
       WHERE canary_id='new-canary'`,
    )).rejects.toThrow();

    const rolloutBriefId = randomUUID();
    const rolloutEnvironment: NodeJS.ProcessEnv = {
      RELEASE_ENVIRONMENT: "production",
      RELEASE_DEPLOYMENT_PHASE: "activate",
      RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "19",
      RELEASE_EXECUTION_ENABLED: "true",
      RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
      RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
      RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
      RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION: "1",
      PIPELINE_V3_PROOF_ARCHITECTURE_MODE: "native",
      PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "6",
      RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH: "c".repeat(64),
      RELEASE_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_HASH: "f".repeat(64),
      RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_HASH: "e".repeat(64),
      RELEASE_PUBLIC_ROLLOUT_STAGE: "genre_scene:50->100",
      PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
      PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED: "true",
      PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED: "true",
      PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED: "true",
      PIPELINE_V3_GENRE_SCENE_PERCENT: "100",
    };
    const targetConfiguration: PublicRolloutConfiguration = {
      PIPELINE_V2_OWNER_CANARY: "false",
      PIPELINE_V2_CURATED_PERCENT: "100",
      PIPELINE_V2_SIMILARITY_PERCENT: "0",
      PIPELINE_V2_FACTUAL_OWNER_CANARY: "false",
      PIPELINE_V2_FACTUAL_PERCENT: "0",
      PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
      PIPELINE_V3_OWNER_CANARY: "true",
      PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED: "true",
      PIPELINE_V3_OWNER_CANARY_GROUPS: "genre_scene",
      PIPELINE_V3_OWNER_CANARY_MAX_TRACKS: "50",
      PIPELINE_V3_GENRE_SCENE_PERCENT: "100",
      PIPELINE_V3_MOOD_ACTIVITY_PERCENT: "0",
      PIPELINE_V3_SIMILARITY_PERCENT: "0",
      PIPELINE_V3_ARTIST_CATALOGUE_PERCENT: "0",
      PIPELINE_V3_FIXED_CONTAINER_PERCENT: "0",
      PIPELINE_V3_FACTUAL_PERCENT: "0",
      PIPELINE_V3_EXHAUSTIVE_PERCENT: "0",
      PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED: "true",
      PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED: "true",
      PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED: "false",
      PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED: "false",
      RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
      RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
      RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
      RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION: "1",
      PIPELINE_V3_PROOF_ARCHITECTURE_MODE: "native",
      PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "6",
      GUIDANCE_CONTRACT_V3_ENABLED: "false",
      GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
      GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "false",
    };
    const authorityState = {
      schemaVersion: "genio-public-rollout-database-authority/v1",
      evidenceHash: "c".repeat(64),
      rollbackWarrantHash: "f".repeat(64),
      intentCanaryHash: "e".repeat(64),
      intentGroup: "genre_scene",
      toPercent: "100",
      stage: "genre_scene:50->100",
      targetConfigurationHash: signedArtifactSha256(targetConfiguration),
      targetConfiguration,
    };
    const rolloutAssignment = createPublicRolloutAssignmentV1({
      prompt: "Smooth reggaeton for a late-night dance floor",
      requestedTrackCount: 50,
      stickyKey: "release-migration-rollout",
      environment: rolloutEnvironment,
      databaseAuthority: {
        global: authorityState,
        intents: { genre_scene: authorityState },
      },
    });
    expect(rolloutAssignment?.assigned).toBe(true);
    await database.query(
      `INSERT INTO brief_requests(
         id,prompt,model,status,client_bucket,brief_contract_version,
         public_rollout_assignment_json,expires_at)
       VALUES($1,'rollout immutable','migration-test','complete',
         'rollout-immutable',3,$2,now()+interval '1 day')`,
      [rolloutBriefId, rolloutAssignment],
    );
    await expect(database.query(
      `UPDATE brief_requests SET public_rollout_assignment_json=$2 WHERE id=$1`,
      [rolloutBriefId, rolloutAssignment],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(database.query(
      `UPDATE brief_requests
       SET public_rollout_assignment_json=
         jsonb_set(public_rollout_assignment_json,'{assigned}','false'::jsonb)
       WHERE id=$1`,
      [rolloutBriefId],
    )).rejects.toThrow(/public_rollout_assignment_immutable/u);
    await expect(database.query(
      "UPDATE brief_requests SET public_rollout_assignment_json=NULL WHERE id=$1",
      [rolloutBriefId],
    )).rejects.toThrow(/public_rollout_assignment_immutable/u);

    await applySql(database, migration0018);
    expect((await database.query<{ count: number }>(
      "SELECT count(*)::int count FROM release_canary_markers",
    )).rows[0]?.count).toBe(4);
  }, 30_000);
});
