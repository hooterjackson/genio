import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import * as databaseSchema from "../db/schema.ts";
import { Repository } from "../server/repository.ts";
import { ResearchOrchestrator } from "../server/research.ts";
import type { PlaylistBrief } from "../shared/types.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseDescribe = databaseUrl ? describe.sequential : describe.skip;
const migrationDirectory = new URL("../postgres-migrations/", import.meta.url);
const migrationSql = readdirSync(migrationDirectory)
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort()
  .map((file) => readFileSync(new URL(`../postgres-migrations/${file}`, import.meta.url), "utf8"))
  .join("\n-- statement-breakpoint\n");

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

databaseDescribe("schema-14 durable worker queue isolation", () => {
  const schemaName = `genio_queue_lane_${randomUUID().replaceAll("-", "")}`;
  const snapshotId = randomUUID();
  let adminPool: Pool;
  let pool: Pool;
  let repository: Repository;
  let factualRunId: string;

  beforeAll(async () => {
    vi.stubEnv("PIPELINE_V3_ASSIGNMENT_ENABLED", "true");
    // This suite verifies queue isolation, not canary authentication. Admit
    // the factual run through an explicit public rollout so freshness cannot
    // silently act as owner route authority.
    vi.stubEnv("PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED", "true");
    vi.stubEnv("PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED", "true");
    vi.stubEnv("PIPELINE_V3_FACTUAL_PERCENT", "100");
    vi.stubEnv("APPLE_STOREFRONT", "us");
    adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 5,
    });
    await applySql(pool, migrationSql);
    await pool.query("INSERT INTO graph_snapshots(id,status) VALUES($1,'building')", [snapshotId]);
    await pool.query(
      `UPDATE graph_snapshots
       SET status='locked',content_hash=$2,assertion_count=0,catalog_identity_count=0,locked_at=now()
       WHERE id=$1`,
      [snapshotId, "a".repeat(64)],
    );
    repository = new Repository({
      pool,
      db: drizzle(pool, { schema: databaseSchema }),
    });
  }, 30_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  });

  test("enqueue stamps protected lanes and the database rejects reserved-class smuggling", async () => {
    const prompt = "Create 25 released recordings where Paulinho da Costa is explicitly credited as a percussion performer.";
    const brief: PlaylistBrief = {
      title: "Paulinho da Costa performance credits",
      description: "Exact recordings with a source-backed Paulinho da Costa percussion performance credit.",
      mode: "curated",
      subjectEntities: ["Paulinho da Costa"],
      relationship: "performed percussion on the exact recording",
      include: ["released recordings with explicit track-level performance evidence"],
      exclude: ["album-only claims and unsupported inferred credits"],
      versionPolicy: "prefer canonical studio recordings",
      evidencePolicy: "verified or independently corroborated exact track-level credit",
      orderingPolicy: "rank qualified recordings by documented importance",
      targetSize: { min: 25, max: 25 },
      ambiguities: [],
    };
    const clientBucket = `queue-factual-${randomUUID()}`;
    const created = await repository.createRunIdempotent({
      prompt,
      brief,
      estimateUsd: 0,
      approvedBudgetUsd: 0,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      autoPublish: false,
      reuseDays: 0,
      globalLimit: 10,
      forceFreshResearch: true,
    });
    factualRunId = created.runId;
    await new ResearchOrchestrator(repository).enqueue(factualRunId);

    await repository.enqueueJob({ kind: "publication", dedupeKey: "lane:publication" });
    await repository.enqueueJob({ kind: "notification", dedupeKey: "lane:notification" });
    await repository.enqueueJob({ kind: "brief", dedupeKey: "lane:brief" });
    await repository.enqueueJob({ kind: "research", queueClass: "interactive", dedupeKey: "lane:interactive" });

    const rows = await pool.query<{ kind: string; dedupe_key: string; queue_class: string }>(
      `SELECT kind,dedupe_key,queue_class FROM job_queue
       WHERE dedupe_key LIKE 'lane:%' OR run_id=$1 ORDER BY dedupe_key`,
      [factualRunId],
    );
    expect(Object.fromEntries(rows.rows.map((row) => [row.dedupe_key, row.queue_class]))).toEqual(expect.objectContaining({
      "lane:brief": "interactive",
      "lane:interactive": "interactive",
      "lane:notification": "system",
      "lane:publication": "publication",
    }));
    expect(rows.rows.find((row) => row.dedupe_key.startsWith(`research:${factualRunId}:`)))
      .toMatchObject({ kind: "research", queue_class: "deep" });

    await expect(pool.query(
      `INSERT INTO job_queue(id,kind,dedupe_key,queue_class)
       VALUES($1,'research','lane:smuggled','publication')`,
      [randomUUID()],
    )).rejects.toThrow(/cannot enter reserved queue class/u);
  });

  test("interactive workers prioritize publication and never lease deep jobs", async () => {
    const first = await repository.leaseNextJob("interactive-worker", 60_000, undefined, "interactive");
    expect(first).toMatchObject({ kind: "publication", queueClass: "publication" });
    await repository.completeJob(first!.id, "interactive-worker", first!.leaseEpoch);

    const second = await repository.leaseNextJob("interactive-worker", 60_000, undefined, "interactive");
    expect(second?.queueClass).not.toBe("deep");
    expect(second?.kind).toBe("brief");
  });

  test("deep workers lease only governed factual/exhaustive or cold-corpus lanes", async () => {
    const job = await repository.leaseNextJob("deep-worker", 60_000, undefined, "deep");
    expect(job).toMatchObject({ runId: factualRunId, kind: "research", queueClass: "deep" });
    const persisted = await pool.query<{ queue_class: string; lease_owner: string }>(
      "SELECT queue_class,lease_owner FROM job_queue WHERE id=$1",
      [job!.id],
    );
    expect(persisted.rows[0]).toEqual({ queue_class: "deep", lease_owner: "deep-worker" });
  });
});
