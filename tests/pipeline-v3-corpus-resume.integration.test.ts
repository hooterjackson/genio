import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { PgEvidenceGraphRepositoryV3 } from "../server/evidence-graph-repository-v3.ts";
import { EvidenceGraphServiceV3 } from "../server/evidence-graph-service-v3.ts";
import { COLD_CORPUS_BUILDER_SCHEMA_V3 } from "../server/pipeline-v3-corpus-builder.ts";
import type { PipelineV3WriteFence } from "../server/pipeline-v3-worker-execution.ts";
import { queryPlanV3Hash } from "../server/query-plan-v3.ts";
import { Repository } from "../server/repository.ts";
import { ResearchOrchestrator } from "../server/research.ts";
import { sha256Hex, stableStringify } from "../server/security.ts";
import { WORKER_PIPELINE_CAPABILITY } from "../server/worker-protocol.ts";
import type { PlaylistBrief, QueryPlanV3 } from "../shared/types.ts";

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
      .filter(Boolean)) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function factualBrief(): PlaylistBrief {
  return {
    title: "Paulinho da Costa exact recording credits",
    description: "Every released exact recording on which Paulinho da Costa is explicitly credited as percussionist.",
    mode: "exhaustive",
    subjectEntities: ["Paulinho da Costa"],
    relationship: "performed on the exact recording",
    include: ["released exact recordings with track-level performance evidence"],
    exclude: ["album-only and unspecified-release credits"],
    versionPolicy: "preserve exact recording versions",
    evidencePolicy: "promoted exact-track factual assertions only",
    orderingPolicy: "chronological when evidence supports it",
    targetSize: { min: 1, max: 1 },
    ambiguities: [],
  };
}

databaseDescribe("Pipeline V3 cold corpus review and resume", () => {
  const schemaName = `genio_v3_corpus_resume_${randomUUID().replaceAll("-", "")}`;
  const rootSnapshotId = randomUUID();
  let adminPool: Pool;
  let pool: Pool;
  let repository: Repository;
  let graph: EvidenceGraphServiceV3;

  beforeAll(async () => {
    vi.stubEnv("PIPELINE_V3_ASSIGNMENT_ENABLED", "true");
    vi.stubEnv("PIPELINE_V3_OWNER_CANARY", "true");
    vi.stubEnv("PIPELINE_V3_OWNER_CANARY_GROUPS", "exhaustive");
    vi.stubEnv("PIPELINE_V3_OWNER_CANARY_MAX_TRACKS", "300");
    vi.stubEnv("APPLE_STOREFRONT", "us");
    vi.stubEnv("WORKER_CONCURRENCY", "2");
    adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 4,
    });
    await applySql(pool, migrationSql);
    await pool.query("INSERT INTO graph_snapshots(id,status) VALUES($1,'building')", [rootSnapshotId]);
    await pool.query(
      `UPDATE graph_snapshots SET status='locked',content_hash=$2,
         assertion_count=0,catalog_identity_count=0,locked_at=now() WHERE id=$1`,
      [rootSnapshotId, "a".repeat(64)],
    );
    repository = new Repository({ pool, db: {} } as never);
    graph = new EvidenceGraphServiceV3(new PgEvidenceGraphRepositoryV3(pool));
  }, 30_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  }, 30_000);

  test("quarantines cold evidence and resumes only from a complete reviewed successor snapshot", async () => {
    const prompt = "Every released recording explicitly performed on by Paulinho da Costa";
    const bucket = `v3-corpus-owner-${randomUUID()}`;
    const created = await repository.createRunIdempotent({
      prompt,
      brief: factualBrief(),
      estimateUsd: 0,
      approvedBudgetUsd: 0,
      clientBucket: bucket,
      clientBucketAliases: [bucket],
      idempotencyKey: randomUUID(),
      autoPublish: false,
      reuseDays: 0,
      globalLimit: 10,
      forceFreshResearch: true,
    });
    const active = (await pool.query<{ id: string; plan_hash: string; plan_json: QueryPlanV3 }>(
      `SELECT q.id,q.plan_hash,q.plan_json FROM run_active_query_plans active
       JOIN query_plan_revisions q ON q.id=active.query_plan_revision_id WHERE active.run_id=$1`,
      [created.runId],
    )).rows[0]!;
    expect(active.plan_json.engines).toContain("exhaustive");

    await new ResearchOrchestrator(repository).enqueue(created.runId);
    const leased = await repository.leaseNextJob(
      "v3-corpus-integration-worker",
      120_000,
      WORKER_PIPELINE_CAPABILITY,
      "deep",
    );
    expect(leased).not.toBeNull();
    const fence: PipelineV3WriteFence = {
      jobId: leased!.id,
      workerId: leased!.leaseOwner!,
      leaseEpoch: leased!.leaseEpoch,
      queryPlanRevisionId: leased!.queryPlanRevisionId!,
      stageKey: leased!.stageKey,
    };
    const sourceUrl = "https://credits.example.test/recording-one";
    await repository.ingestPipelineV3ColdCorpus({
      runId: created.runId,
      queryPlan: active.plan_json,
      fence,
      result: {
        schema: COLD_CORPUS_BUILDER_SCHEMA_V3,
        responseId: "resp_test_cold_corpus",
        observations: [{
          artist: "Example Artist",
          title: "Example Recording",
          album: "Example Album",
          predicate: "performed_on",
          relationship: "percussion performance",
          role: "percussion",
          creditScope: "exact_recording",
          sourceUrl,
          sourceTitle: "Official recording credits",
          supportExcerpt: "The official credits identify Paulinho da Costa on percussion for this exact recording.",
          confidence: 0.99,
        }],
        sourceCount: 1,
        advertisedTotal: 1,
        recoveredTotal: 1,
        nextCursor: null,
        enumerationComplete: true,
        zeroNewEvidenceGapPasses: 2,
        gaps: [],
      },
    });
    const checkpoint = {
      schemaVersion: "genio-pipeline-v3-worker/v1",
      state: "owner_action_required",
      actionKind: "corpus_review",
      reasonCode: "cold_graph_requires_corpus_build",
      stageKey: leased!.stageKey,
      queryPlanHash: active.plan_hash,
      queryPlanRevisionId: active.id,
      graphSnapshotId: active.plan_json.graphSnapshotId,
      executionMode: "active",
      engines: active.plan_json.engines,
      requestedTrackCount: active.plan_json.targetTrackCount,
      recordedAt: new Date().toISOString(),
    };
    await repository.saveResearchCheckpoint(created.runId, "v3:corpus:action-required", checkpoint, fence);
    await repository.updateRun(created.runId, {
      status: "waiting_for_corpus_review",
      phase: "v3_corpus_review_required",
      error: null,
    }, fence);

    await expect(repository.preparePipelineV3CorpusResume(created.runId))
      .rejects.toMatchObject({ code: "corpus_review_pending" });
    const rows = await pool.query<{
      observation_id: string;
      source_document_id: string;
      content_hash: string;
      access_method: "hosted_web_search";
    }>(
      `SELECT observation.id observation_id,observation.source_document_id,
              source.content_hash,source.access_method
       FROM corpus_assertion_observations observation
       JOIN corpus_source_documents source ON source.id=observation.source_document_id
       WHERE observation.object_json->>'ingestionRunId'=$1`,
      [created.runId],
    );
    const evidence = rows.rows[0]!;
    const emptySuccessor = await graph.createLockedSnapshot({ parentSnapshotId: rootSnapshotId });
    await graph.approveSourcePolicy({
      sourceDocumentId: evidence.source_document_id,
      authority: "primary_track_credit",
      accessMethod: evidence.access_method,
      licenseState: "permission_recorded",
      licenseVersion: "owner-review-v1",
      termsVersion: "owner-terms-v1",
      attribution: "Official recording credits",
      cachePolicy: "excerpt_only",
      retentionPolicy: "durable_public_corpus",
      freshnessPolicy: "immutable_revision",
      sourceRevision: evidence.content_hash,
      approvedBy: "owner@example.test",
    });
    await graph.promoteObservations({ observationIds: [evidence.observation_id], promotedBy: "owner@example.test" });
    const review = await repository.preparePipelineV3CorpusResume(created.runId);
    expect(review).toMatchObject({ enumerationComplete: true, promotedAssertionCount: 1 });

    await expect(repository.resumePipelineV3CorpusResearch({
      runId: created.runId,
      reviewedGraphSnapshotId: emptySuccessor.id,
      expectedSourceQueryPlanRevisionId: review.sourceQueryPlanRevisionId,
      expectedSourceCheckpointHash: review.sourceCheckpointHash,
      idempotencyKey: "resume-empty-snapshot",
    })).rejects.toMatchObject({ code: "corpus_snapshot_incomplete" });

    const reviewedSnapshot = await graph.createLockedSnapshot({ parentSnapshotId: rootSnapshotId });
    const idempotencyKey = `resume-${randomUUID()}`;
    const resumed = await repository.resumePipelineV3CorpusResearch({
      runId: created.runId,
      reviewedGraphSnapshotId: reviewedSnapshot.id,
      expectedSourceQueryPlanRevisionId: review.sourceQueryPlanRevisionId,
      expectedSourceCheckpointHash: review.sourceCheckpointHash,
      idempotencyKey,
    });
    expect(resumed).toMatchObject({ queued: true, graphSnapshotId: reviewedSnapshot.id });
    await expect(repository.getPipelineV3CorpusResumeReplay(created.runId, idempotencyKey))
      .resolves.toEqual(resumed);

    const successor = (await pool.query<{
      id: string;
      parent_revision_id: string;
      graph_snapshot_id: string;
      plan_hash: string;
      plan_json: QueryPlanV3;
    }>(
      `SELECT q.id,q.parent_revision_id,q.graph_snapshot_id,q.plan_hash,q.plan_json
       FROM run_active_query_plans active JOIN query_plan_revisions q
         ON q.id=active.query_plan_revision_id WHERE active.run_id=$1`,
      [created.runId],
    )).rows[0]!;
    expect(successor).toMatchObject({
      id: resumed.queryPlanRevisionId,
      parent_revision_id: active.id,
      graph_snapshot_id: reviewedSnapshot.id,
    });
    expect(successor.plan_hash).toBe(queryPlanV3Hash(successor.plan_json));
    expect(successor.plan_json.corpusReview).toMatchObject({
      sourceQueryPlanRevisionId: active.id,
      sourceQueryPlanHash: active.plan_hash,
      reviewedGraphSnapshotId: reviewedSnapshot.id,
      enumerationComplete: true,
    });
    const queued = (await pool.query<{
      kind: string;
      queue_class: string;
      query_plan_revision_id: string;
      stage_key: string;
    }>("SELECT kind,queue_class,query_plan_revision_id,stage_key FROM job_queue WHERE id=$1", [resumed.jobId])).rows[0]!;
    expect(queued).toMatchObject({
      kind: "research",
      queue_class: "deep",
      query_plan_revision_id: successor.id,
    });
    expect(queued.stage_key).toMatch(/^v3-retrieval:active:/u);
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int count FROM job_queue
       WHERE run_id=$1 AND kind IN ('matching','publication')`,
      [created.runId],
    )).rows[0]?.count).toBe(0);
    expect(review.sourceCheckpointHash).toBe(sha256Hex(stableStringify(checkpoint)));
  }, 30_000);
});
