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
    const first = await repository.acquireAppleWritePermit({
      runId: "run-one",
      manifestId: "manifest-one",
      publicationVolumeId: "volume-one",
      operation: "create_playlist",
    });
    let secondAcquired = false;
    const secondPromise = repository.acquireAppleWritePermit({
      runId: "run-two",
      manifestId: "manifest-two",
      publicationVolumeId: "volume-two",
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

    for (const operation of ["create_playlist", "append_tracks"] as const) {
      const permit = await repository.acquireAppleWritePermit({
        runId: "run-token",
        manifestId: "manifest-token",
        publicationVolumeId: `volume-${operation}`,
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
});
