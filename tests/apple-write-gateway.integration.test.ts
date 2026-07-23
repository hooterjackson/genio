import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDatabase } from "../db/index.ts";
import {
  APPLE_WRITE_GATEWAY_EVENT_ACTION,
  APPLE_WRITE_GATEWAY_EVENT_BUCKET,
  APPLE_WRITE_GATEWAY_STATE_KEY,
} from "../server/apple-write-gateway.ts";
import { Repository } from "../server/repository.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseDescribe = databaseUrl ? describe.sequential : describe.skip;
const migrationDirectory = new URL("../postgres-migrations/", import.meta.url);
const migrationSql = readdirSync(migrationDirectory)
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort()
  .map((file) => readFileSync(new URL(`../postgres-migrations/${file}`, import.meta.url), "utf8"))
  .join("\n-- statement-breakpoint\n");

async function applyMigration(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of migrationSql
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

const delay = (milliseconds: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, milliseconds);
});

databaseDescribe("database-backed Apple write gateway", () => {
  const schemaName = `genio_apple_write_${randomUUID().replaceAll("-", "")}`;
  const originalEnvironment = {
    capacity: process.env.APPLE_WRITE_TOKEN_CAPACITY,
    refill: process.env.APPLE_WRITE_TOKEN_REFILL_PER_SECOND,
    wait: process.env.APPLE_WRITE_LOCK_WAIT_MS,
  };
  let adminPool: Pool;
  let repository: Repository;

  const createPublicationFenceFixture = async (label: string) => {
    const runId = randomUUID();
    const manifestId = randomUUID();
    const publicationVolumeId = randomUUID();
    const manifestRevisionHash = "a".repeat(64);
    await repository.pool.query(
      `INSERT INTO research_runs(
         id,prompt,brief_json,brief_hash,status,phase,client_bucket,idempotency_key,
         retention_expires_at)
       VALUES($1,$2,'{}'::jsonb,$3,'publishing','apple_publication',$4,$5,
         now()+interval '1 day')`,
      [
        runId,
        `Apple write gateway fixture ${label}`,
        "b".repeat(64),
        `apple-write:${label}:${runId}`,
        `apple-write:${label}:${runId}`,
      ],
    );
    await repository.pool.query(
      `INSERT INTO manifests(id,run_id,name,description,content_hash)
       VALUES($1,$2,$3,$4,$5)`,
      [manifestId, runId, label, label, manifestRevisionHash],
    );
    await repository.pool.query(
      `INSERT INTO publication_volumes(
         id,manifest_id,manifest_revision_id,volume_number,volume_count,
         start_position,end_position,status)
       VALUES($1,$2,NULL,1,1,0,0,'queued')`,
      [publicationVolumeId, manifestId],
    );
    return {
      runId,
      manifestId,
      manifestRevisionId: null,
      manifestRevisionHash,
      contractRevisionId: null,
      contractHash: null,
      publicationVolumeId,
    } as const;
  };

  const createCompletionFenceFixture = async (label: string) => {
    const runId = randomUUID();
    const contractRevisionId = randomUUID();
    const manifestId = randomUUID();
    const manifestRevisionId = randomUUID();
    const candidateId = randomUUID();
    const publicationVolumeId = randomUUID();
    const manifestRevisionHash = "c".repeat(64);
    const contractHash = "d".repeat(64);
    await repository.pool.query(
      `INSERT INTO research_runs(
         id,prompt,brief_json,brief_hash,brief_contract_version,status,phase,
         pipeline_version,policy_version,selection_plan_json,client_bucket,
         idempotency_key,retention_expires_at)
       VALUES($1,$2,'{}'::jsonb,$3,3,'publishing','apple_publication',
         'catalog_first_v2','relevance_first_2026_07',
         '{"requestedTrackCount":1}'::jsonb,$4,$5,now()+interval '1 day')`,
      [
        runId,
        `Publication completion fixture ${label}`,
        "b".repeat(64),
        `publication-completion:${label}:${runId}`,
        `publication-completion:${label}:${runId}`,
      ],
    );
    await repository.pool.query(
      `INSERT INTO playlist_contract_revisions(
         id,run_id,revision,status,contract_hash,contract_json,
         compiler_version,ontology_version,evidence_policy_version,
         question_template_version,catalog_policy_version,locale,storefront,
         answer_lineage_hash)
       VALUES($1,$2,1,'active',$3,'{}'::jsonb,
         'test-compiler','test-ontology','test-evidence','test-questions',
         'test-catalog','en-US','us',$4)`,
      [contractRevisionId, runId, contractHash, "e".repeat(64)],
    );
    await repository.pool.query(
      `UPDATE research_runs SET active_playlist_contract_revision_id=$2
       WHERE id=$1`,
      [runId, contractRevisionId],
    );
    await repository.pool.query(
      `INSERT INTO manifests(
         id,run_id,name,description,content_hash,pipeline_version,
         policy_version,contract_revision_id,contract_hash)
       VALUES($1,$2,$3,$4,$5,'catalog_first_v2','relevance_first_2026_07',$6,$7)`,
      [manifestId, runId, label, label, manifestRevisionHash, contractRevisionId, contractHash],
    );
    await repository.pool.query(
      `INSERT INTO track_candidates(id,run_id,canonical_key,artist,title,outcome)
       VALUES($1,$2,$3,'Test Artist','Test Track','accepted')`,
      [candidateId, runId, `publication-completion:${label}`],
    );
    await repository.pool.query(
      `INSERT INTO manifest_revisions(
         id,manifest_id,revision,status,reason,content_hash,pipeline_version,
         policy_version,locked_at)
       VALUES($1,$2,1,'locked','completion fence test',$3,
         'catalog_first_v2','relevance_first_2026_07',now())`,
      [manifestRevisionId, manifestId, manifestRevisionHash],
    );
    await repository.pool.query(
      `INSERT INTO manifest_revision_tracks(
         manifest_revision_id,position,candidate_id,catalog_id,artist,title)
       VALUES($1,0,$2,'101','Test Artist','Test Track')`,
      [manifestRevisionId, candidateId],
    );
    await repository.pool.query(
      `INSERT INTO publication_volumes(
         id,manifest_id,manifest_revision_id,volume_number,volume_count,
         start_position,end_position,status,apple_playlist_id,apple_share_url,
         appended_count,attempt,published_at)
       VALUES($1,$2,$3,1,1,0,0,'complete','p.completion',
         'https://music.apple.com/us/playlist/completion/pl.completion',1,2,now())`,
      [publicationVolumeId, manifestId, manifestRevisionId],
    );
    return {
      runId,
      manifestId,
      manifestRevisionId,
      manifestRevisionHash,
      contractRevisionId,
      contractHash,
      selectedCount: 1,
      terminalStatus: "complete" as const,
      publicationVolumes: [{
        publicationVolumeId,
        attempt: 2,
        applePlaylistId: "p.completion",
        appendedCount: 1,
        startPosition: 0,
        endPosition: 0,
      }],
      pipelineOutcome: null,
    };
  };

  beforeAll(async () => {
    process.env.APPLE_WRITE_TOKEN_CAPACITY = "20";
    process.env.APPLE_WRITE_TOKEN_REFILL_PER_SECOND = "10";
    process.env.APPLE_WRITE_LOCK_WAIT_MS = "5000";
    adminPool = new Pool({ connectionString: databaseUrl, max: 2, application_name: "genio-apple-write-admin" });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    const handle = createDatabase({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 6,
      application_name: "genio-apple-write-integration",
    });
    await applyMigration(handle.pool);
    repository = new Repository(handle);
  }, 30_000);

  afterAll(async () => {
    if (originalEnvironment.capacity === undefined) delete process.env.APPLE_WRITE_TOKEN_CAPACITY;
    else process.env.APPLE_WRITE_TOKEN_CAPACITY = originalEnvironment.capacity;
    if (originalEnvironment.refill === undefined) delete process.env.APPLE_WRITE_TOKEN_REFILL_PER_SECOND;
    else process.env.APPLE_WRITE_TOKEN_REFILL_PER_SECOND = originalEnvironment.refill;
    if (originalEnvironment.wait === undefined) delete process.env.APPLE_WRITE_LOCK_WAIT_MS;
    else process.env.APPLE_WRITE_LOCK_WAIT_MS = originalEnvironment.wait;
    if (repository) await repository.close();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  }, 30_000);

  test("globally fences concurrent Apple mutations until the active permit is released", async () => {
    const firstFixture = await createPublicationFenceFixture("first");
    const secondFixture = await createPublicationFenceFixture("second");
    const first = await repository.acquireAppleWritePermit({
      ...firstFixture,
      operation: "create_playlist",
    });
    let secondAcquired = false;
    const secondPromise = repository.acquireAppleWritePermit({
      ...secondFixture,
      operation: "append_tracks",
    }).then((permit) => {
      secondAcquired = true;
      return permit;
    });

    await delay(150);
    expect(secondAcquired).toBe(false);
    await first.release();
    await first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    await second.release();
  }, 10_000);

  test("durably consumes bounded global tokens and records each issued permit", async () => {
    await repository.pool.query(
      "DELETE FROM settings WHERE key=$1",
      [APPLE_WRITE_GATEWAY_STATE_KEY],
    );
    await repository.pool.query(
      "DELETE FROM rate_limit_events WHERE client_bucket=$1 AND action=$2",
      [APPLE_WRITE_GATEWAY_EVENT_BUCKET, APPLE_WRITE_GATEWAY_EVENT_ACTION],
    );
    process.env.APPLE_WRITE_TOKEN_CAPACITY = "2";
    process.env.APPLE_WRITE_TOKEN_REFILL_PER_SECOND = "0.25";
    const fixture = await createPublicationFenceFixture("tokens");

    for (const operation of ["create_playlist", "append_tracks"] as const) {
      const permit = await repository.acquireAppleWritePermit({
        ...fixture,
        operation,
      });
      await permit.release();
    }

    const stateRow = await repository.pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key=$1",
      [APPLE_WRITE_GATEWAY_STATE_KEY],
    );
    const state = JSON.parse(stateRow.rows[0]!.value) as { tokens: number; updatedAtMs: number };
    expect(state.tokens).toBeGreaterThanOrEqual(0);
    expect(state.tokens).toBeLessThan(0.1);
    expect(state.updatedAtMs).toBeGreaterThan(0);
    const events = await repository.pool.query<{ count: number }>(
      `SELECT count(*)::int count FROM rate_limit_events
       WHERE client_bucket=$1 AND action=$2`,
      [APPLE_WRITE_GATEWAY_EVENT_BUCKET, APPLE_WRITE_GATEWAY_EVENT_ACTION],
    );
    expect(events.rows[0]?.count).toBe(2);
  });

  test("atomically completes only the active reconciled publication attempt", async () => {
    const fixture = await createCompletionFenceFixture("authorized");
    await repository.commitPublicationCompletion(fixture);

    const [run, revision] = await Promise.all([
      repository.pool.query<{ status: string; phase: string }>(
        "SELECT status,phase FROM research_runs WHERE id=$1",
        [fixture.runId],
      ),
      repository.pool.query<{ status: string }>(
        "SELECT status FROM manifest_revisions WHERE id=$1",
        [fixture.manifestRevisionId],
      ),
    ]);
    expect(run.rows[0]).toMatchObject({ status: "complete", phase: "published" });
    expect(revision.rows[0]?.status).toBe("published");
  });

  test("rejects terminal completion when a successor contract wins the race", async () => {
    const fixture = await createCompletionFenceFixture("successor-race");
    const successorId = randomUUID();
    const successorHash = "f".repeat(64);
    await repository.pool.query("UPDATE playlist_contract_revisions SET status='superseded' WHERE id=$1", [
      fixture.contractRevisionId,
    ]);
    await repository.pool.query(
      `INSERT INTO playlist_contract_revisions(
         id,run_id,revision,parent_revision_id,status,contract_hash,contract_json,
         compiler_version,ontology_version,evidence_policy_version,
         question_template_version,catalog_policy_version,locale,storefront,
         answer_lineage_hash)
       VALUES($1,$2,2,$3,'active',$4,'{}'::jsonb,
         'test-compiler','test-ontology','test-evidence','test-questions',
         'test-catalog','en-US','us',$5)`,
      [successorId, fixture.runId, fixture.contractRevisionId, successorHash, "1".repeat(64)],
    );
    await repository.pool.query(
      "UPDATE research_runs SET active_playlist_contract_revision_id=$2 WHERE id=$1",
      [fixture.runId, successorId],
    );

    await expect(repository.commitPublicationCompletion(fixture))
      .rejects.toMatchObject({ code: "manifest_contract_stale" });
    const run = await repository.pool.query<{ status: string; phase: string }>(
      "SELECT status,phase FROM research_runs WHERE id=$1",
      [fixture.runId],
    );
    expect(run.rows[0]).toMatchObject({ status: "publishing", phase: "apple_publication" });
  });

  test("rejects terminal completion when visitor cancellation wins the race", async () => {
    const fixture = await createCompletionFenceFixture("cancellation-race");
    await repository.pool.query(
      `UPDATE research_runs SET status='cancelled',phase='visitor_cancelled'
       WHERE id=$1`,
      [fixture.runId],
    );

    await expect(repository.commitPublicationCompletion(fixture))
      .rejects.toMatchObject({ code: "publication_run_cancelled" });
    const run = await repository.pool.query<{ status: string; phase: string }>(
      "SELECT status,phase FROM research_runs WHERE id=$1",
      [fixture.runId],
    );
    expect(run.rows[0]).toMatchObject({ status: "cancelled", phase: "visitor_cancelled" });
  });

  test("rejects terminal completion from a superseded Apple publication attempt", async () => {
    const fixture = await createCompletionFenceFixture("attempt-race");
    await repository.pool.query(
      "UPDATE publication_volumes SET attempt=attempt+1 WHERE id=$1",
      [fixture.publicationVolumes[0]!.publicationVolumeId],
    );

    await expect(repository.commitPublicationCompletion(fixture))
      .rejects.toMatchObject({ code: "publication_attempt_stale" });
    const run = await repository.pool.query<{ status: string; phase: string }>(
      "SELECT status,phase FROM research_runs WHERE id=$1",
      [fixture.runId],
    );
    expect(run.rows[0]).toMatchObject({ status: "publishing", phase: "apple_publication" });
  });
});
