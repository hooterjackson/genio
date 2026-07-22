import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseDescribe = databaseUrl ? describe.sequential : describe.skip;
const migrationDirectory = new URL("../postgres-migrations/", import.meta.url);
const migrationFiles = readdirSync(migrationDirectory)
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort();
const legacyMigrationSql = migrationFiles
  // Reconstruct the database exactly as it existed immediately before 0012.
  // Excluding named migrations is not sufficient once later migrations are
  // added: those later files can advance the fixture all the way to the
  // current schema before the migration under test is applied.
  .filter((file) => file < "0012_")
  .map((file) => readFileSync(new URL(`../postgres-migrations/${file}`, import.meta.url), "utf8"))
  .join("\n-- statement-breakpoint\n");
const pipelineV2MigrationSql = readFileSync(
  new URL("../postgres-migrations/0012_pipeline_v2_foundation.sql", import.meta.url),
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

databaseDescribe("Pipeline V2 expand migration", () => {
  const schemaName = `genio_v2_upgrade_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: "genio-v2-upgrade-admin",
    });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 3,
      application_name: "genio-v2-upgrade-integration",
    });
    await applySql(pool, legacyMigrationSql);
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  }, 30_000);

  test("upgrades populated V12 state without losing legacy jobs or owner-hidden playlists", async () => {
    const runId = randomUUID();
    const briefRequestId = randomUUID();
    const runJobId = randomUUID();
    const briefJobId = randomUUID();
    const unboundJobId = randomUUID();
    const hiddenPlaylistId = randomUUID();
    const listedPlaylistId = randomUUID();

    await pool.query(
      `INSERT INTO research_runs(
         id,prompt,brief_json,brief_hash,status,phase,client_bucket,
         idempotency_key,retention_expires_at
       ) VALUES($1,'Legacy V1 run','{}'::jsonb,$2,'queued','scope','legacy-bucket',$3,now()+interval '1 day')`,
      [runId, "a".repeat(64), randomUUID()],
    );
    await pool.query(
      `INSERT INTO brief_requests(
         id,prompt,model,status,client_bucket,idempotency_key,expires_at
       ) VALUES($1,'Legacy V1 brief','legacy-model','queued','legacy-bucket',$2,now()+interval '1 day')`,
      [briefRequestId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO job_queue(id,run_id,kind,dedupe_key,payload_json)
       VALUES($1,$2,'research',$3,'{"pipelineVersion":"catalog_first_v2"}'::jsonb)`,
      [runJobId, runId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO job_queue(id,brief_request_id,kind,dedupe_key,payload_json)
       VALUES($1,$2,'brief',$3,'{"pipelineVersion":"catalog_first_v2"}'::jsonb)`,
      [briefJobId, briefRequestId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO job_queue(id,kind,dedupe_key,payload_json)
       VALUES($1,'maintenance',$2,'{"pipelineVersion":"catalog_first_v2"}'::jsonb)`,
      [unboundJobId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO public_playlists(
         id,run_id,manifest_hash,title,track_count,volume_count,status,published_at,hidden_at
       ) VALUES
         ($1,$2,$3,'Legacy hidden playlist',1,1,'hidden',now()-interval '1 day',now()),
         ($4,$2,$5,'Legacy listed playlist',1,1,'listed',now()-interval '1 day',NULL)`,
      [hiddenPlaylistId, runId, "b".repeat(64), listedPlaylistId, "c".repeat(64)],
    );

    expect((await pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key='schema_version'",
    )).rows[0]?.value).toBe("12");

    await applySql(pool, pipelineV2MigrationSql);

    expect((await pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key='schema_version'",
    )).rows[0]?.value).toBe("13");
    expect((await pool.query<{
      id: string;
      pipeline_version: string;
      minimum_worker_protocol: number;
    }>(
      `SELECT id,pipeline_version,minimum_worker_protocol
       FROM job_queue WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [[runJobId, briefJobId, unboundJobId]],
    )).rows).toEqual(expect.arrayContaining([
      { id: runJobId, pipeline_version: "legacy_v1", minimum_worker_protocol: 4 },
      { id: briefJobId, pipeline_version: "legacy_v1", minimum_worker_protocol: 4 },
      { id: unboundJobId, pipeline_version: "legacy_v1", minimum_worker_protocol: 4 },
    ]));
    expect((await pool.query<{ id: string; owner_hidden: boolean }>(
      `SELECT id,owner_hidden FROM public_playlists
       WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [[hiddenPlaylistId, listedPlaylistId]],
    )).rows).toEqual(expect.arrayContaining([
      { id: hiddenPlaylistId, owner_hidden: true },
      { id: listedPlaylistId, owner_hidden: false },
    ]));
    expect((await pool.query<{ pipeline_version: string; policy_version: string }>(
      "SELECT pipeline_version,policy_version FROM research_runs WHERE id=$1",
      [runId],
    )).rows[0]).toEqual({ pipeline_version: "legacy_v1", policy_version: "legacy_v1" });

    const v2RunId = randomUUID();
    const v2JobId = randomUUID();
    await pool.query(
      `INSERT INTO research_runs(
         id,prompt,brief_json,brief_hash,status,phase,client_bucket,
         idempotency_key,retention_expires_at,pipeline_version,policy_version
       ) VALUES($1,'V2 run','{}'::jsonb,$2,'queued','scope','v2-bucket',$3,
         now()+interval '1 day','catalog_first_v2','pipeline-v2-test')`,
      [v2RunId, "d".repeat(64), randomUUID()],
    );
    await pool.query(
      `INSERT INTO job_queue(
         id,run_id,kind,dedupe_key,pipeline_version,minimum_worker_protocol
       ) VALUES($1,$2,'research',$3,'legacy_v1',4)`,
      [v2JobId, v2RunId, randomUUID()],
    );
    expect((await pool.query<{ pipeline_version: string; minimum_worker_protocol: number }>(
      "SELECT pipeline_version,minimum_worker_protocol FROM job_queue WHERE id=$1",
      [v2JobId],
    )).rows[0]).toEqual({ pipeline_version: "catalog_first_v2", minimum_worker_protocol: 5 });

    await pool.query(
      "UPDATE job_queue SET pipeline_version='legacy_v1',minimum_worker_protocol=4 WHERE id=$1",
      [v2JobId],
    );
    expect((await pool.query<{ pipeline_version: string; minimum_worker_protocol: number }>(
      "SELECT pipeline_version,minimum_worker_protocol FROM job_queue WHERE id=$1",
      [v2JobId],
    )).rows[0]).toEqual({ pipeline_version: "catalog_first_v2", minimum_worker_protocol: 5 });

    await applySql(pool, pipelineV2MigrationSql);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM job_queue WHERE id=ANY($1::uuid[])",
      [[runJobId, briefJobId, unboundJobId, v2JobId]],
    )).rows[0]?.count).toBe(4);
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int count FROM pg_trigger
       WHERE tgrelid='job_queue'::regclass AND tgname='job_pipeline_protocol_stamp' AND NOT tgisinternal`,
    )).rows[0]?.count).toBe(1);
  }, 30_000);
});
