import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { Repository } from "../server/repository.ts";
import { ResearchOrchestrator } from "../server/research.ts";
import { sha256Hex, stableStringify } from "../server/security.ts";
import { selectionPlanV3Hash, type SelectionPlanV3 } from "../server/selection-plan-v3.ts";
import { WORKER_PIPELINE_CAPABILITY } from "../server/worker-protocol.ts";
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

function curatedBrief(title: string, count: number): PlaylistBrief {
  return {
    title,
    description: `A source-qualified ${count}-track playlist for Pipeline V3 activation testing.`,
    mode: "curated",
    subjectEntities: [title],
    relationship: "genre membership",
    include: ["released recordings in the requested music genre"],
    exclude: ["karaoke, tribute, and incompatible versions"],
    versionPolicy: "prefer canonical studio recordings",
    evidencePolicy: "auditable exact track-scope evidence",
    orderingPolicy: "rank by relevance, then interleave artists and albums",
    targetSize: { min: count, max: count },
    ambiguities: [],
  };
}

databaseDescribe("Pipeline V3 direct run activation", () => {
  const schemaName = `genio_v3_activation_${randomUUID().replaceAll("-", "")}`;
  const snapshotId = randomUUID();
  let adminPool: Pool;
  let pool: Pool;
  let repository: Repository;

  beforeAll(async () => {
    vi.stubEnv("PIPELINE_V3_ASSIGNMENT_ENABLED", "true");
    vi.stubEnv("PIPELINE_V3_OWNER_CANARY", "true");
    vi.stubEnv("PIPELINE_V3_OWNER_CANARY_MAX_TRACKS", "300");
    vi.stubEnv("PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION", "2");
    vi.stubEnv("APPLE_STOREFRONT", "us");
    adminPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: "genio-v3-activation-admin",
    });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 4,
      application_name: "genio-v3-activation-integration",
    });
    await applySql(pool, migrationSql);
    await pool.query("INSERT INTO graph_snapshots(id,status) VALUES($1,'building')", [snapshotId]);
    await pool.query(
      `UPDATE graph_snapshots
       SET status='locked',content_hash=$2,assertion_count=0,catalog_identity_count=0,locked_at=now()
       WHERE id=$1`,
      [snapshotId, "a".repeat(64)],
    );
    repository = new Repository({ pool, db: {} } as never);
  }, 30_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  }, 30_000);

  test("atomically preserves a 150-track RunSpec and binds protocol-8 work to its active graph plan", async () => {
    expect(process.env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION).toBe("2");
    const rawPrompt = "Create a 150-track playlist of recordings in the disco music genre";
    const clientBucket = `v3-owner-150-${randomUUID()}`;
    const brief = curatedBrief("Disco music", 150);
    const briefRequest = await repository.createBriefRequest({
      prompt: rawPrompt,
      requestedTrackCount: 150,
      model: "gpt-5.6-luna-2026-07-15",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
    });
    await repository.saveBriefResult(briefRequest.id, {
      status: "complete",
      brief,
      guidanceSourceHints: [{
        url: "https://example.org/disco-history#provider-source",
        title: "  Disco   history  ",
        excerpt: "  Provider-attested source context.  ",
      }],
      estimateUsd: 0,
    });
    const created = await repository.createRunIdempotent({
      prompt: rawPrompt,
      brief,
      briefRequestId: briefRequest.id,
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

    expect(created).toMatchObject({ created: true, reused: false, status: "queued" });

    const run = (await pool.query<{
      pipeline_version: string;
      policy_version: string;
      status: string;
      phase: string;
      approved_budget_usd: number;
      selection_plan_json: unknown;
      pipeline_policy_snapshot_json: {
        executionPolicy: {
          kind: string;
          model: string;
          modelRoute: {
            baselineProviderModelId: string;
            escalationProviderModelId: string;
            resolutionMode: string;
            modelCatalogValidatedAt: string;
            escalationCount: number;
          };
        };
      };
    }>(
      `SELECT pipeline_version,policy_version,status,phase,approved_budget_usd::float8,selection_plan_json,
              pipeline_policy_snapshot_json
       FROM research_runs WHERE id=$1`,
      [created.runId],
    )).rows[0]!;
    expect(run).toMatchObject({
      pipeline_version: "corpus_first_v3",
      policy_version: "corpus_first_v3_policy_v1",
      status: "queued",
      phase: "queued",
      approved_budget_usd: 3,
      selection_plan_json: null,
      pipeline_policy_snapshot_json: {
        executionPolicy: {
          kind: "corpus_first_v3",
          model: "gpt-5.6-luna",
          modelRoute: {
            baselineProviderModelId: "gpt-5.6-luna",
            escalationProviderModelId: "gpt-5.6-terra",
            resolutionMode: "provider_managed_alias",
            modelCatalogValidatedAt: "2026-07-20T00:00:00.000Z",
            escalationCount: 0,
          },
        },
      },
    });

    const spec = (await pool.query<{
      raw_prompt: string;
      requested_track_count: number;
      storefront: string;
      guidance_answers_json: unknown[];
      guidance_source_hints_json: unknown[];
      spec_hash: string;
      pipeline_version: string;
      policy_version: string;
    }>("SELECT * FROM run_specs WHERE run_id=$1", [created.runId])).rows[0]!;
    expect(spec.raw_prompt).toBe(rawPrompt);
    expect(spec.requested_track_count).toBe(150);
    expect(spec.storefront).toBe("us");
    expect(spec.guidance_answers_json).toEqual([]);
    const expectedSourceHints = [{
      url: "https://example.org/disco-history",
      title: "Disco history",
      excerpt: "Provider-attested source context.",
      attestation: "guidance_scout_provider_response",
    }];
    expect(spec.guidance_source_hints_json).toEqual(expectedSourceHints);
    expect(spec.pipeline_version).toBe("corpus_first_v3");
    expect(spec.policy_version).toBe("corpus_first_v3_policy_v1");
    expect(spec.spec_hash).toBe(sha256Hex(stableStringify({
      rawPrompt,
      requestedTrackCount: 150,
      storefront: "us",
      guidanceAnswers: [],
      guidanceSourceHints: expectedSourceHints,
      pipelineVersion: "corpus_first_v3",
      policyVersion: "corpus_first_v3_policy_v1",
    })));
    await expect(pool.query(
      "UPDATE run_specs SET requested_track_count=100 WHERE run_id=$1",
      [created.runId],
    )).rejects.toThrow(/immutable/u);

    const selection = (await pool.query<{
      id: string;
      plan_hash: string;
      plan_json: SelectionPlanV3;
      pipeline_version: string;
      policy_version: string;
      status: string;
    }>("SELECT id,plan_hash,plan_json,pipeline_version,policy_version,status FROM selection_plans WHERE run_id=$1", [created.runId])).rows[0]!;
    expect(selection.plan_json).toMatchObject({
      prompt: rawPrompt,
      requestedTrackCount: 150,
      storefront: "us",
      confirmed: true,
      pipelineVersion: "corpus_first_v3",
      sourceDiscoveryHints: expectedSourceHints,
    });
    expect(selection.plan_hash).toBe(selectionPlanV3Hash(selection.plan_json));
    expect(selection).toMatchObject({
      pipeline_version: "corpus_first_v3",
      policy_version: "corpus_first_v3_policy_v1",
      status: "active",
    });

    const queryPlan = (await pool.query<{
      id: string;
      selection_plan_id: string;
      graph_snapshot_id: string;
      plan_json: {
        schemaVersion: number;
        targetTrackCount: number;
        storefront: string;
        graphSnapshotId: string;
        selectionPlanHash: string;
      };
      pipeline_version: string;
      policy_version: string;
      status: string;
    }>("SELECT * FROM query_plan_revisions WHERE run_id=$1", [created.runId])).rows[0]!;
    expect(queryPlan.selection_plan_id).toBe(selection.id);
    expect(queryPlan.graph_snapshot_id).toBe(snapshotId);
    expect(queryPlan.plan_json).toMatchObject({
      schemaVersion: 2,
      targetTrackCount: 150,
      storefront: "us",
      graphSnapshotId: snapshotId,
      selectionPlanHash: selection.plan_hash,
      sourceDiscoveryHints: expectedSourceHints,
    });
    expect(queryPlan).toMatchObject({
      pipeline_version: "corpus_first_v3",
      policy_version: "corpus_first_v3_policy_v1",
      status: "active",
    });
    expect((await pool.query<{ query_plan_revision_id: string }>(
      "SELECT query_plan_revision_id FROM run_active_query_plans WHERE run_id=$1",
      [created.runId],
    )).rows[0]?.query_plan_revision_id).toBe(queryPlan.id);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM research_checkpoints WHERE run_id=$1 AND phase LIKE 'fast:%'",
      [created.runId],
    )).rows[0]?.count).toBe(0);

    await new ResearchOrchestrator(repository).enqueue(created.runId);
    const queuedJob = (await pool.query<{
      id: string;
      status: string;
      payload_json: Record<string, unknown>;
      pipeline_version: string;
      minimum_worker_protocol: number;
      query_plan_revision_id: string;
      stage_key: string;
      lease_epoch: string;
    }>(
      `SELECT id,status,payload_json,pipeline_version,minimum_worker_protocol,
              query_plan_revision_id,stage_key,lease_epoch::text
       FROM job_queue WHERE run_id=$1 AND kind='research'`,
      [created.runId],
    )).rows[0]!;
    expect(queuedJob).toMatchObject({
      status: "queued",
      pipeline_version: "corpus_first_v3",
      // The existing schema-15 trigger physically normalizes V3 rows to 6.
      // The repository must recover schema 2's effective protocol requirement
      // from this immutable query-plan revision before any lease is granted.
      minimum_worker_protocol: 8,
      query_plan_revision_id: queryPlan.id,
      lease_epoch: "0",
    });
    expect(queuedJob.stage_key).toMatch(/^v3-retrieval:active:/u);
    expect(queuedJob.payload_json).toMatchObject({
      runId: created.runId,
      phase: "v3_retrieval",
      v3ExecutionMode: "active",
      stageExecutionKey: queuedJob.stage_key,
    });

    const protocol6Lease = await repository.leaseNextJob(
      "v3-schema-1-worker",
      60_000,
      {
        protocolVersion: "playlist-pipeline-v6",
        protocolNumber: 6,
        pipelineVersions: ["legacy_v1", "catalog_first_v2", "corpus_first_v3"],
      },
    );
    expect(protocol6Lease).toBeNull();

    expect((await pool.query<{ status: string; attempts: number }>(
      "SELECT status,attempts FROM job_queue WHERE id=$1",
      [queuedJob.id],
    )).rows[0]).toEqual({ status: "queued", attempts: 0 });

    const leased = await repository.leaseNextJob(
      "v3-activation-worker",
      60_000,
      WORKER_PIPELINE_CAPABILITY,
    );
    expect(leased).toMatchObject({
      id: queuedJob.id,
      runId: created.runId,
      pipelineVersion: "corpus_first_v3",
      minimumWorkerProtocol: 8,
      queryPlanRevisionId: queryPlan.id,
      stageKey: queuedJob.stage_key,
      leaseEpoch: 1,
      leaseOwner: "v3-activation-worker",
    });
  }, 30_000);

  test("keeps an active schema-1 plan authoritative after schema-2 emission activates", async () => {
    vi.stubEnv("PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION", "1");
    const rawPrompt = "Create 25 released disco recordings";
    const clientBucket = `v3-schema-flip-${randomUUID()}`;
    const created = await repository.createRunIdempotent({
      prompt: rawPrompt,
      brief: curatedBrief("Disco music", 25),
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
    const before = (await pool.query<{
      query_plan_revision_id: string;
      revision: number;
      plan_hash: string;
      query_plan: { schemaVersion: number };
      selection_plan: SelectionPlanV3;
    }>(
      `SELECT active.query_plan_revision_id,query.revision,query.plan_hash,
              query.plan_json query_plan,selection.plan_json selection_plan
       FROM run_active_query_plans active
       JOIN query_plan_revisions query ON query.id=active.query_plan_revision_id
       JOIN selection_plans selection ON selection.id=query.selection_plan_id
       WHERE active.run_id=$1`,
      [created.runId],
    )).rows[0]!;
    expect(before.query_plan.schemaVersion).toBe(1);

    vi.stubEnv("PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION", "2");
    const activated = await repository.activatePipelineV3Run({
      runId: created.runId,
      selectionPlan: before.selection_plan,
      graphSnapshotId: snapshotId,
    });
    expect(activated).toMatchObject({
      idempotent: true,
      queryPlanRevisionId: before.query_plan_revision_id,
      revision: before.revision,
      planHash: before.plan_hash,
      queryPlan: { schemaVersion: 1 },
    });
    const after = (await pool.query<{
      active_id: string;
      revision_count: number;
      schema_version: number;
    }>(
      `SELECT active.query_plan_revision_id active_id,
              (SELECT count(*)::int FROM query_plan_revisions WHERE run_id=$1) revision_count,
              (query.plan_json->>'schemaVersion')::int schema_version
       FROM run_active_query_plans active
       JOIN query_plan_revisions query ON query.id=active.query_plan_revision_id
       WHERE active.run_id=$1`,
      [created.runId],
    )).rows[0]!;
    expect(after).toEqual({
      active_id: before.query_plan_revision_id,
      revision_count: 1,
      schema_version: 1,
    });
  }, 30_000);

  test("blocks unresolved critical ambiguity before creating a run or job", async () => {
    const before = (await pool.query<{
      runs: number;
      specs: number;
      jobs: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM research_runs) runs,
         (SELECT count(*)::int FROM run_specs) specs,
         (SELECT count(*)::int FROM job_queue) jobs`,
    )).rows[0]!;
    const clientBucket = `v3-owner-ambiguous-${randomUUID()}`;

    await expect(repository.createRunIdempotent({
      prompt: "Make me a 25-track house playlist",
      brief: curatedBrief("House", 25),
      estimateUsd: 0,
      approvedBudgetUsd: 0,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      autoPublish: false,
      reuseDays: 0,
      globalLimit: 10,
      forceFreshResearch: true,
    })).rejects.toMatchObject({ statusCode: 409, code: "v3_guidance_required" });

    const after = (await pool.query<{
      runs: number;
      specs: number;
      jobs: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM research_runs) runs,
         (SELECT count(*)::int FROM run_specs) specs,
         (SELECT count(*)::int FROM job_queue) jobs`,
    )).rows[0]!;
    expect(after).toEqual(before);
  });

  test("preserves the public maximum of 300 through RunSpec, selection plan, and query plan", async () => {
    const rawPrompt = "Create a 300-track playlist of recordings in the American drill music genre";
    const clientBucket = `v3-owner-300-${randomUUID()}`;
    const created = await repository.createRunIdempotent({
      prompt: rawPrompt,
      brief: curatedBrief("American drill", 300),
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

    const result = (await pool.query<{
      requested_track_count: number;
      selection_count: number;
      query_count: number;
      storefront: string;
      graph_snapshot_id: string;
    }>(
      `SELECT s.requested_track_count,
              (p.plan_json->>'requestedTrackCount')::int selection_count,
              (q.plan_json->>'targetTrackCount')::int query_count,
              s.storefront,q.graph_snapshot_id
       FROM run_specs s
       JOIN selection_plans p ON p.run_id=s.run_id AND p.status='active'
       JOIN run_active_query_plans a ON a.run_id=s.run_id
       JOIN query_plan_revisions q ON q.id=a.query_plan_revision_id
       WHERE s.run_id=$1`,
      [created.runId],
    )).rows[0]!;
    expect(result).toEqual({
      requested_track_count: 300,
      selection_count: 300,
      query_count: 300,
      storefront: "us",
      graph_snapshot_id: snapshotId,
    });
  });
});
