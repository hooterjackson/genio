import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  contractTwoGuidanceQuestion,
  GUIDANCE_POLICY_VERSION,
  guidanceQuestionSetHashV2,
} from "../server/guidance-contract-v2.ts";
import { Repository } from "../server/repository.ts";
import type { PlaylistBrief, PlaylistGuidanceQuestion } from "../shared/types.ts";

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

const brief: PlaylistBrief = {
  title: "Disco survey",
  description: "A documented disco survey.",
  mode: "curated",
  subjectEntities: ["disco"],
  relationship: "genre membership",
  include: ["released disco recordings"],
  exclude: [],
  versionPolicy: "prefer canonical studio recordings",
  evidencePolicy: "documented scope",
  orderingPolicy: "editorial",
  targetSize: { min: 25, max: 25 },
  ambiguities: [],
};

const legacyQuestion: PlaylistGuidanceQuestion = {
  id: "guided:depth",
  header: "Depth",
  question: "How deep should discovery go?",
  decisionKey: "disco_depth",
  options: [
    { id: "depth_balanced", label: "Balanced", description: "Mix landmarks and discoveries.", recommended: true, effect: { kind: "familiarity_bias", value: "balanced", orderingBehavior: null } },
    { id: "depth_obscure", label: "Deep cuts", description: "Favor lesser-known recordings.", recommended: false, effect: { kind: "familiarity_bias", value: "deep cuts", orderingBehavior: null } },
    { id: "depth_familiar", label: "Landmarks", description: "Favor well-known recordings.", recommended: false, effect: { kind: "familiarity_bias", value: "familiar selections", orderingBehavior: null } },
  ],
};

databaseDescribe("intelligent guidance contract persistence", () => {
  const schemaName = `genio_guidance_v2_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool;
  let pool: Pool;
  let repository: Repository;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl, max: 2, application_name: "guidance-v2-admin" });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 4,
      application_name: "guidance-v2-integration",
    });
    await applySql(pool, migrationSql);
    repository = new Repository({ pool, db: {} } as never);
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  }, 30_000);

  test("persists immutable question and answer revisions and fences contract-2 work to protocol 9", async () => {
    const clientBucket = `guidance-v2-${randomUUID()}`;
    const created = await repository.createBriefRequest({
      prompt: "25 disco songs",
      requestedTrackCount: 25,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      briefContractVersion: 2,
    });
    const queued = await repository.enqueueJob({
      kind: "brief",
      briefRequestId: created.id,
      payload: { briefRequestId: created.id },
      dedupeKey: `brief:${created.id}`,
    });
    expect((await pool.query<{ minimum_worker_protocol: number }>(
      "SELECT minimum_worker_protocol FROM job_queue WHERE id=$1",
      [queued.id],
    )).rows[0]?.minimum_worker_protocol).toBe(9);

    const questions = [contractTwoGuidanceQuestion(legacyQuestion, "preference_ambiguity")];
    const explicitConstraintHash = "a".repeat(64);
    const questionSetHash = guidanceQuestionSetHashV2({
      classification: "preference_ambiguity",
      prompt: "25 disco songs",
      targetTrackCount: 25,
      storefront: "us",
      locale: "en",
      explicitConstraintHash,
      questions,
    });
    await repository.saveBriefResult(created.id, {
      status: "awaiting_answers",
      expectedStatus: "queued",
      brief,
      questions,
      guidanceTelemetry: {
        generationMode: "grounded_scout",
        requestClassification: "preference_ambiguity",
        guidancePolicyVersion: GUIDANCE_POLICY_VERSION,
        questionSetHash,
        proposedQuestionCount: 1,
        acceptedQuestionCount: 1,
        webSearchCalls: 1,
        validationIssues: [],
      },
      guidanceContract: {
        questionSetHash,
        requestClassification: "preference_ambiguity",
        generationMode: "grounded_scout",
        guidancePolicyVersion: GUIDANCE_POLICY_VERSION,
        locale: "en",
        storefront: "us",
        targetTrackCount: 25,
        explicitConstraintHash,
        rejectedQuestionReasons: [],
      },
    });
    expect(await repository.getBriefRequest(created.id)).toMatchObject({
      briefContractVersion: 2,
      questionSetHash,
      status: "awaiting_answers",
    });

    const stale = await repository.submitBriefAnswers({
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: "b".repeat(64),
      answers: [{ questionId: questions[0]!.id, optionId: "depth_obscure" }],
    });
    expect(stale).toMatchObject({ status: "stale_question_set", questionSetHash });

    const answerKey = randomUUID();
    await expect(repository.submitBriefAnswers({
      briefRequestId: created.id,
      idempotencyKey: answerKey,
      questionSetHash,
      answers: [{ questionId: questions[0]!.id, optionId: "depth_obscure" }],
    })).resolves.toEqual({ status: "finalizing", created: true });
    await expect(repository.submitBriefAnswers({
      briefRequestId: created.id,
      idempotencyKey: answerKey,
      questionSetHash,
      answers: [{ questionId: questions[0]!.id, optionId: "depth_obscure" }],
    })).resolves.toEqual({ status: "finalizing", created: false });

    const answerSet = (await pool.query<{
      question_set_hash: string;
      execution_delta_hash: string;
      normalized_answers_json: unknown;
    }>("SELECT question_set_hash,execution_delta_hash,normalized_answers_json FROM guidance_answer_sets WHERE brief_request_id=$1", [created.id])).rows[0]!;
    expect(answerSet.question_set_hash).toBe(questionSetHash);
    expect(answerSet.execution_delta_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(answerSet.normalized_answers_json).toEqual([{ questionId: "guided:depth", optionId: "depth_obscure" }]);
    await expect(pool.query(
      "UPDATE guidance_answer_sets SET execution_delta_hash=$2 WHERE brief_request_id=$1",
      [created.id, "c".repeat(64)],
    )).rejects.toThrow(/append-only/iu);

    await repository.saveBriefResult(created.id, {
      status: "complete",
      expectedStatus: "finalizing",
      brief,
      estimateUsd: 0,
    });
    const run = await repository.createRunIdempotent({
      prompt: "25 disco songs",
      briefRequestId: created.id,
      brief,
      estimateUsd: 0,
      approvedBudgetUsd: 0,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      reuseDays: 0,
      globalLimit: 100,
    });
    expect((await pool.query<{ brief_contract_version: number }>(
      "SELECT brief_contract_version FROM research_runs WHERE id=$1",
      [run.runId],
    )).rows[0]?.brief_contract_version).toBe(2);
    expect((await pool.query<{ brief_contract_version: number }>(
      "SELECT brief_contract_version FROM run_specs WHERE run_id=$1",
      [run.runId],
    )).rows[0]?.brief_contract_version).toBe(2);
  }, 40_000);

  test("deduplicates normalized terminal incidents and keeps detailed diagnostics prompt-free", async () => {
    const clientBucket = `quality-incident-${randomUUID()}`;
    const created = await repository.createRunIdempotent({
      prompt: "A private quality incident fixture prompt",
      brief,
      estimateUsd: 0,
      approvedBudgetUsd: 0,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      reuseDays: 0,
      globalLimit: 100,
    });
    for (const error of ["provider failed once", "provider failed again"]) {
      await repository.updateRun(created.runId, {
        status: "failed_system",
        phase: "catalog_provider_failure",
        error,
      });
    }
    const groups = await pool.query<{
      incident_class: string;
      total_count: string;
      overflow_count: string;
    }>("SELECT incident_class,total_count,overflow_count FROM quality_incident_groups");
    expect(groups.rows).toContainEqual({
      incident_class: "failed_system",
      total_count: "1",
      overflow_count: "0",
    });
    const occurrences = await pool.query<{ diagnostics_json: Record<string, unknown> }>(
      "SELECT diagnostics_json FROM quality_incident_occurrences WHERE run_id=$1",
      [created.runId],
    );
    expect(occurrences.rows).toHaveLength(1);
    expect(occurrences.rows[0]?.diagnostics_json).toMatchObject({
      targetTrackCount: 25,
      candidateCount: 0,
      appleResolutionAttempts: 0,
    });
    expect(JSON.stringify(occurrences.rows)).not.toContain("private quality incident fixture");
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM run_stage_metric_summaries WHERE run_id=$1 AND terminal",
      [created.runId],
    )).rows[0]?.count).toBe(1);
  }, 50_000);

  test("aggregates provider metrics exactly once per idempotency key", async () => {
    const idempotencyKey = `provider-metric-${randomUUID()}`;
    const metric = {
      provider: "apple",
      operation: "search_view",
      stageKey: "catalog_resolution",
      metricName: "provider_requests",
      metricValue: 1,
      requestOutcome: "success",
      cacheOutcome: "miss",
      idempotencyKey,
    };
    await repository.recordProviderMetric(metric);
    await repository.recordProviderMetric(metric);
    expect((await pool.query<{ events: number; metric_value: string; event_count: string }>(
      `SELECT (SELECT count(*)::int FROM provider_metric_events WHERE idempotency_key=$1) events,
              metric_value,event_count
       FROM provider_metric_daily_aggregates
       WHERE provider='apple' AND operation='search_view' AND metric_name='provider_requests'`,
      [idempotencyKey],
    )).rows[0]).toEqual({ events: 1, metric_value: "1", event_count: "1" });
  }, 20_000);
});
