import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  compilePlaylistContractRevisionV1,
  type PlaylistContractPatchV1,
  type PlaylistContractRevisionV1,
} from "../server/playlist-contract-v1.ts";
import {
  customGuidanceConfirmationDecisionV3,
  recompileCustomGuidanceTextV3,
  selectGuidanceRoundV3,
} from "../server/adaptive-guidance-v3.ts";
import { publicGuidanceQuestionV3 } from "../server/adaptive-guidance-contract-bridge.ts";
import {
  Repository,
  type CreateCanonicalRunSuccessorInput,
} from "../server/repository.ts";
import { pipelineV3ResearchJob } from "../server/research-resume.ts";
import { createSelectionPlanV2 } from "../server/selection-plan-v2.ts";
import { sha256Hex, stableStringify } from "../server/security.ts";
import { WORKER_PIPELINE_CAPABILITY } from "../server/worker-protocol.ts";
import type { PlaylistBrief } from "../shared/types.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseDescribe = databaseUrl ? describe.sequential : describe.skip;
const migrationDirectory = new URL("../postgres-migrations/", import.meta.url);
const migrationSql = readdirSync(migrationDirectory)
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort()
  .map((file) => readFileSync(
    new URL(`../postgres-migrations/${file}`, import.meta.url),
    "utf8",
  ))
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

function brief(count = 20): PlaylistBrief {
  return {
    title: "Canonical reggaeton",
    description: "A contract-authoritative reggaeton playlist.",
    mode: "curated",
    subjectEntities: ["reggaeton"],
    relationship: "genre membership",
    include: ["released reggaeton recordings"],
    exclude: [],
    versionPolicy: "canonical studio recordings",
    evidencePolicy: "selection-grade track evidence",
    orderingPolicy: "smooth editorial flow",
    targetSize: { min: count, max: count },
    ambiguities: [],
  };
}

function contract(
  prompt: string,
  count = 20,
  compiler = "playlist_contract_compiler_v1",
): PlaylistContractRevisionV1 {
  return compilePlaylistContractRevisionV1({
    contractId: `contract:test:${sha256Hex(prompt).slice(0, 16)}`,
    rawPrompt: prompt,
    requestedTrackCount: count,
    locale: "en-US",
    storefront: "us",
    versions: { compiler },
    clauses: [{
      id: "membership:genre",
      kind: "membership",
      scope: "track",
      hardness: "hard",
      axis: "genre",
      operator: "require",
      values: ["reggaeton"],
      source: { provenance: "prompt", text: "reggaeton" },
      unknownPolicy: "reject",
    }],
    trackPredicate: {
      op: "clause",
      clauseId: "membership:genre",
    },
  });
}

function genrePatch(
  base: PlaylistContractRevisionV1,
  genre: string,
  answerSeed: string,
): PlaylistContractPatchV1 {
  return {
    baseRevisionId: base.revisionId,
    baseSemanticHash: base.semanticHash,
    answerLineage: {
      questionSetHash: sha256Hex(`questions:${answerSeed}`),
      questionId: `rescue:${answerSeed}`,
      answerHash: sha256Hex(`answer:${answerSeed}`),
    },
    operations: [{
      op: "replace_clause",
      clauseId: "membership:genre",
      clause: {
        id: "membership:genre",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "genre",
        operator: "require",
        values: [genre],
        source: {
          provenance: "guidance",
          text: genre,
        },
        unknownPolicy: "reject",
      },
    }],
  };
}

databaseDescribe("canonical contract capability decisions and successor runs", () => {
  const schemaName =
    `genio_contract_successor_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool;
  let pool: Pool;
  let repository: Repository;

  beforeAll(async () => {
    vi.stubEnv("APPLE_STOREFRONT", "us");
    vi.stubEnv("PIPELINE_V3_ASSIGNMENT_ENABLED", "true");
    vi.stubEnv("PIPELINE_V3_OWNER_CANARY", "true");
    vi.stubEnv("PIPELINE_V3_OWNER_CANARY_MAX_TRACKS", "300");
    adminPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: "genio-contract-successor-admin",
    });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 8,
      application_name: "genio-contract-successor-integration",
    });
    await applySql(pool, migrationSql);
    const snapshotId = randomUUID();
    await pool.query(
      "INSERT INTO graph_snapshots(id,status) VALUES($1,'building')",
      [snapshotId],
    );
    await pool.query(
      `UPDATE graph_snapshots SET status='locked',content_hash=$2,
         assertion_count=0,catalog_identity_count=0,locked_at=now()
       WHERE id=$1`,
      [snapshotId, sha256Hex("canonical-successor-snapshot")],
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

  async function createCanonicalRun(input: {
    compiler?: string;
    idempotencyKey?: string;
  } = {}) {
    const rawPrompt =
      `Create 20 reggaeton tracks ${randomUUID().slice(0, 8)}`;
    const clientBucket = `contract-successor-${randomUUID()}`;
    const value = contract(
      rawPrompt,
      20,
      input.compiler ?? "playlist_contract_compiler_v1",
    );
    const playlistBrief = brief();
    const briefRequest = await repository.createBriefRequest({
      prompt: rawPrompt,
      requestedTrackCount: 20,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      briefContractVersion: 3,
    });
    const compatibilityPlan = createSelectionPlanV2({
      prompt: rawPrompt,
      brief: playlistBrief,
      storefront: "us",
    });
    const persisted = await repository.savePlaylistContractRevision({
      briefRequestId: briefRequest.id,
      expectedParentRevisionId: null,
      contractHash: value.semanticHash,
      contract: structuredClone(value) as unknown as Record<string, unknown>,
      compilerVersion: value.versions.compiler,
      ontologyVersion: value.versions.ontology,
      evidencePolicyVersion: value.versions.evidencePolicy,
      questionTemplateVersion: value.versions.questionTemplates,
      catalogPolicyVersion: value.versions.catalogPolicy,
      locale: value.locale,
      storefront: value.storefront,
      answerLineageHash: sha256Hex(stableStringify(value.answerLineage)),
    });
    await repository.saveBriefSelectionPlan(briefRequest.id, compatibilityPlan);
    await repository.saveBriefResult(briefRequest.id, {
      status: "complete",
      expectedStatus: "queued",
      brief: playlistBrief,
      estimateUsd: 0,
    });
    const runIdempotencyKey = input.idempotencyKey ?? randomUUID();
    const createInput = {
      prompt: rawPrompt,
      briefRequestId: briefRequest.id,
      brief: playlistBrief,
      estimateUsd: 0,
      approvedBudgetUsd: 3,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: runIdempotencyKey,
      autoPublish: false,
      reuseDays: 0,
      globalLimit: 100,
      forceFreshResearch: true,
    };
    const created = await repository.createRunIdempotent(createInput);
    return {
      rawPrompt,
      clientBucket,
      contract: value,
      contractDatabaseId: persisted.id,
      briefRequestId: briefRequest.id,
      createInput,
      created,
    };
  }

  test("accepts an unsupported future contract as an actionable decision with no execution job", async () => {
    const fixture = await createCanonicalRun({
      compiler: "playlist_contract_compiler_v99",
    });
    expect(fixture.created).toMatchObject({
      created: true,
      reused: false,
      status: "needs_decision",
    });

    const persisted = (await pool.query<{
      status: string;
      phase: string;
      pipeline_version: string;
      brief_contract_version: number;
      active_playlist_contract_revision_id: string;
    }>(
      `SELECT status,phase,pipeline_version,brief_contract_version,
              active_playlist_contract_revision_id
       FROM research_runs WHERE id=$1`,
      [fixture.created.runId],
    )).rows[0]!;
    expect(persisted).toEqual({
      status: "needs_decision",
      phase: "capability_decision_required",
      pipeline_version: "corpus_first_v3",
      brief_contract_version: 3,
      active_playlist_contract_revision_id: fixture.contractDatabaseId,
    });
    const blockers = await pool.query<{
      blocker_kind: string;
      dependency_key: string;
      state_json: Record<string, unknown>;
    }>(
      `SELECT blocker_kind,dependency_key,state_json
       FROM playlist_run_blockers WHERE run_id=$1 AND resolved_at IS NULL`,
      [fixture.created.runId],
    );
    expect(blockers.rows).toHaveLength(1);
    expect(blockers.rows[0]).toMatchObject({
      blocker_kind: "scope_decision",
      dependency_key: "contract_execution_capability",
      state_json: {
        reasonCode: "unsupported_contract_capability",
        actions: [
          "review_contract",
          "wait_for_compatible_executor",
          "cancel",
        ],
      },
    });
    expect(blockers.rows[0]!.state_json.missingCapabilities).toEqual(
      expect.arrayContaining([
        "corpus_first_v3:compiler:playlist_contract_compiler_v99",
      ]),
    );
    expect((await pool.query<{ count: number }>(
      `SELECT (
         (SELECT count(*) FROM selection_plans WHERE run_id=$1)
         +(SELECT count(*) FROM query_plan_revisions WHERE run_id=$1)
         +(SELECT count(*) FROM job_queue WHERE run_id=$1)
       )::int count`,
      [fixture.created.runId],
    )).rows[0]?.count).toBe(0);

    const publicRun = await repository.getRunByAccess(
      fixture.created.accessId,
    );
    expect(publicRun).toMatchObject({
      status: "needs_decision",
      phase: "capability_decision_required",
      resolution: {
        state: "needs_decision",
        nextAction: "review_contract",
        terminal: false,
        contractRevisionId: fixture.contractDatabaseId,
        blocker: {
          kind: "scope_decision",
          nextRetryAt: null,
          automaticRetryUntil: null,
          retryCount: 0,
        },
      },
    });
    await expect(repository.createRunIdempotent(fixture.createInput))
      .resolves.toMatchObject({
        runId: fixture.created.runId,
        accessId: fixture.created.accessId,
        created: false,
        status: "needs_decision",
      });
  }, 30_000);

  test("persists an accepted contract behind the cohort kill switch as a visible dependency pause", async () => {
    await repository.setPipelineCohortKillSwitch({
      cohortKey: `contract-pause:${randomUUID()}`,
      route: "corpus_first_v3",
      disabled: true,
      reasonCode: "integration_pause",
      changedBy: "integration",
    });
    try {
      const fixture = await createCanonicalRun();
      expect(fixture.created).toMatchObject({
        created: true,
        status: "needs_decision",
      });
      expect((await pool.query<{
        status: string;
        phase: string;
        selection_count: number;
        query_count: number;
        job_count: number;
      }>(
        `SELECT run.status,run.phase,
                (SELECT count(*)::int FROM selection_plans
                 WHERE run_id=run.id) selection_count,
                (SELECT count(*)::int FROM query_plan_revisions
                 WHERE run_id=run.id) query_count,
                (SELECT count(*)::int FROM job_queue
                 WHERE run_id=run.id) job_count
         FROM research_runs run WHERE run.id=$1`,
        [fixture.created.runId],
      )).rows[0]).toEqual({
        status: "needs_decision",
        phase: "contract_execution_paused",
        selection_count: 1,
        query_count: 1,
        job_count: 0,
      });
      expect((await pool.query<{
        blocker_kind: string;
        dependency_key: string;
        state_json: Record<string, unknown>;
      }>(
        `SELECT blocker_kind,dependency_key,state_json
         FROM playlist_run_blockers
         WHERE run_id=$1 AND resolved_at IS NULL`,
        [fixture.created.runId],
      )).rows[0]).toMatchObject({
        blocker_kind: "provider",
        dependency_key: "pipeline_cohort:corpus_first_v3",
        state_json: {
          reasonCode: "contract_execution_cohort_paused",
          route: "corpus_first_v3",
          actions: ["wait_for_dependency", "cancel"],
        },
      });
      expect(await repository.getRunByAccess(fixture.created.accessId))
        .toMatchObject({
          resolution: {
            state: "blocked_dependency",
            nextAction: "wait_for_dependency",
            terminal: false,
            blocker: {
              kind: "provider",
            },
          },
        });
    } finally {
      await repository.setPipelineCohortKillSwitch({
        cohortKey: `contract-resume:${randomUUID()}`,
        route: "corpus_first_v3",
        disabled: false,
        changedBy: "integration",
      });
    }
  }, 30_000);

  test("creates one linked successor, fences a leased old worker, and preserves immutable history", async () => {
    const fixture = await createCanonicalRun();
    const sourceQueryPlan = await repository.getActiveQueryPlan(
      fixture.created.runId,
    );
    expect(sourceQueryPlan).not.toBeNull();
    const queued = await repository.enqueueJob(
      pipelineV3ResearchJob(fixture.created.runId, sourceQueryPlan!),
    );
    const leased = await repository.leaseNextJob(
      "late-old-worker",
      120_000,
      WORKER_PIPELINE_CAPABILITY,
      "all",
    );
    expect(leased?.id).toBe(queued.id);
    await repository.updateRun(fixture.created.runId, {
      status: "researching",
      phase: "v3_retrieval",
    });
    const sourceQuery = (await pool.query<{
      id: string;
      selection_plan_id: string;
    }>(
      `SELECT query.id,query.selection_plan_id
       FROM run_active_query_plans active
       JOIN query_plan_revisions query
         ON query.id=active.query_plan_revision_id
       WHERE active.run_id=$1`,
      [fixture.created.runId],
    )).rows[0]!;

    const successorInput: CreateCanonicalRunSuccessorInput = {
      runId: fixture.created.runId,
      sourceAccessId: fixture.created.accessId,
      expectedContractRevisionId: fixture.contractDatabaseId,
      expectedContractSemanticHash: fixture.contract.semanticHash,
      patch: genrePatch(fixture.contract, "dembow", "dembow"),
      idempotencyKey: randomUUID(),
      trigger: "rescue_guidance",
    };
    const successor = await repository.createCanonicalRunSuccessor(
      successorInput,
    );
    expect(successor).toMatchObject({
      created: true,
      status: "queued",
    });
    expect(successor.runId).not.toBe(fixture.created.runId);
    expect(successor.accessId).not.toBe(fixture.created.accessId);
    expect(successor.queryPlanRevisionId).toMatch(
      /^[a-f0-9-]{36}$/u,
    );

    const oldRun = (await pool.query<{
      status: string;
      phase: string;
      active_playlist_contract_revision_id: string;
    }>(
      `SELECT status,phase,active_playlist_contract_revision_id
       FROM research_runs WHERE id=$1`,
      [fixture.created.runId],
    )).rows[0]!;
    expect(oldRun).toEqual({
      status: "cancelled",
      phase: "superseded_by_contract_revision",
      active_playlist_contract_revision_id: successor.contractRevisionId,
    });
    expect((await pool.query<{
      status: string;
      lease_owner: string | null;
    }>(
      "SELECT status,lease_owner FROM job_queue WHERE id=$1",
      [queued.id],
    )).rows[0]).toEqual({
      status: "cancelled",
      lease_owner: null,
    });
    await expect(repository.completeJob(
      queued.id,
      "late-old-worker",
      leased!.leaseEpoch,
    )).rejects.toMatchObject({
      statusCode: 409,
      code: "job_lease_lost",
    });

    const successorRows = await pool.query<{
      contract_run_id: string;
      parent_revision_id: string;
      contract_hash: string;
      query_parent_revision_id: string | null;
      query_schema_version: number | null;
      query_contract_revision_id: string | null;
      job_count: number;
    }>(
      `SELECT contract.run_id contract_run_id,
              contract.parent_revision_id,contract.contract_hash,
              query.parent_revision_id query_parent_revision_id,
              (query.plan_json->>'schemaVersion')::int query_schema_version,
              query.plan_json->>'playlistContractRevisionId'
                query_contract_revision_id,
              (SELECT count(*)::int FROM job_queue job
               WHERE job.run_id=run.id AND job.status='queued') job_count
       FROM research_runs run
       JOIN playlist_contract_revisions contract
         ON contract.id=run.active_playlist_contract_revision_id
       LEFT JOIN run_active_query_plans active ON active.run_id=run.id
       LEFT JOIN query_plan_revisions query
         ON query.id=active.query_plan_revision_id
       WHERE run.id=$1`,
      [successor.runId],
    );
    expect(successorRows.rows[0]).toMatchObject({
      contract_run_id: successor.runId,
      parent_revision_id: fixture.contractDatabaseId,
      query_parent_revision_id: sourceQuery.id,
      query_schema_version: 4,
      job_count: 1,
    });
    expect(successorRows.rows[0]?.contract_hash)
      .not.toBe(fixture.contract.semanticHash);
    expect(successorRows.rows[0]?.query_contract_revision_id)
      .not.toBe(fixture.contract.revisionId);

    const oldHistory = (await pool.query<{
      contract_status: string;
      brief_active_revision_id: string;
      selection_status: string;
      query_status: string;
      active_query_count: number;
    }>(
      `SELECT contract.status contract_status,
              brief.active_playlist_contract_revision_id brief_active_revision_id,
              selection.status selection_status,query.status query_status,
              (SELECT count(*)::int FROM run_active_query_plans
               WHERE run_id=$1) active_query_count
       FROM playlist_contract_revisions contract
       JOIN brief_requests brief
         ON brief.active_playlist_contract_revision_id=contract.id
       JOIN selection_plans selection
         ON selection.run_id=$1 AND selection.id=$2
       JOIN query_plan_revisions query ON query.id=$3
       WHERE contract.id=$4`,
      [
        fixture.created.runId,
        sourceQuery.selection_plan_id,
        sourceQuery.id,
        fixture.contractDatabaseId,
      ],
    )).rows[0]!;
    expect(oldHistory).toEqual({
      contract_status: "active",
      brief_active_revision_id: fixture.contractDatabaseId,
      selection_status: "superseded",
      query_status: "superseded",
      active_query_count: 0,
    });

    await expect(repository.createCanonicalRunSuccessor(successorInput))
      .resolves.toMatchObject({
        ...successor,
        created: false,
      });
  }, 30_000);

  test("optimistic fencing permits only one of two conflicting rescue submissions", async () => {
    const fixture = await createCanonicalRun();
    await repository.updateRun(fixture.created.runId, {
      status: "researching",
      phase: "v3_retrieval",
    });
    const base = {
      runId: fixture.created.runId,
      sourceAccessId: fixture.created.accessId,
      expectedContractRevisionId: fixture.contractDatabaseId,
      expectedContractSemanticHash: fixture.contract.semanticHash,
      trigger: "named_predicate_revision" as const,
    };
    const [left, right] = await Promise.allSettled([
      repository.createCanonicalRunSuccessor({
        ...base,
        patch: genrePatch(fixture.contract, "dembow", "left"),
        idempotencyKey: randomUUID(),
      }),
      repository.createCanonicalRunSuccessor({
        ...base,
        patch: genrePatch(fixture.contract, "latin urban", "right"),
        idempotencyKey: randomUUID(),
      }),
    ]);
    const fulfilled = [left, right].filter(
      (value) => value.status === "fulfilled",
    );
    const rejected = [left, right].filter(
      (value) => value.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409,
      code: "stale_playlist_contract",
    });
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int count
       FROM playlist_contract_revisions
       WHERE parent_revision_id=$1`,
      [fixture.contractDatabaseId],
    )).rows[0]?.count).toBe(1);
  }, 30_000);

  test("caps rescue questions at two across the canonical predecessor lineage", async () => {
    await pool.query(
      "UPDATE job_queue SET status='cancelled',completed_at=now() WHERE status IN ('queued','leased')",
    );
    const fixture = await createCanonicalRun();
    await repository.updateRun(fixture.created.runId, {
      status: "researching",
      phase: "v3_retrieval",
    });
    for (const revision of [1, 2]) {
      await pool.query(
        `INSERT INTO guidance_question_sets(
           id,brief_request_id,run_id,revision,question_set_hash,
           request_classification,generation_mode,guidance_policy_version,
           locale,storefront,target_track_count,explicit_constraint_hash,
           rejected_question_reasons_json,questions_json,active,
           base_contract_revision_id,parent_question_set_id,
           feasibility_snapshot_id,guidance_round,trigger,axis)
         VALUES($1,NULL,$2,$3,$4,'broad_curated','deterministic_critical',
                'adaptive_guidance_v3','en-US','us',20,$5,
                '[]'::jsonb,'[]'::jsonb,false,$6,NULL,NULL,
                'rescue','yield_risk','genre')`,
        [
          randomUUID(),
          fixture.created.runId,
          revision,
          sha256Hex(`lineage-rescue:${revision}:${fixture.created.runId}`),
          sha256Hex(`constraints:${fixture.created.runId}`),
          fixture.contractDatabaseId,
        ],
      );
    }
    const successor = await repository.createCanonicalRunSuccessor({
      runId: fixture.created.runId,
      sourceAccessId: fixture.created.accessId,
      expectedContractRevisionId: fixture.contractDatabaseId,
      expectedContractSemanticHash: fixture.contract.semanticHash,
      patch: genrePatch(fixture.contract, "dembow", "lineage"),
      idempotencyKey: randomUUID(),
      trigger: "rescue_guidance",
    });
    const workerId = `lineage-worker-${randomUUID()}`;
    const leased = (await pool.query<{
      id: string;
      lease_epoch: number;
      query_plan_revision_id: string;
      stage_key: string;
    }>(
      `UPDATE job_queue
       SET status='leased',lease_owner=$2,
           lease_expires_at=now()+interval '5 minutes',
           lease_epoch=lease_epoch+1,updated_at=now()
       WHERE id=(
         SELECT id FROM job_queue
         WHERE run_id=$1 AND kind='research' AND status='queued'
         ORDER BY created_at,id LIMIT 1
       )
       RETURNING id,lease_epoch,query_plan_revision_id,stage_key`,
      [successor.runId, workerId],
    )).rows[0]!;
    expect(leased).toBeTruthy();
    await repository.updateRun(successor.runId, {
      status: "researching",
      phase: "v3_retrieval",
    });
    const active = await repository.getActivePlaylistContractRevision({
      runId: successor.runId,
    });
    expect(active).toBeTruthy();
    const activeContract =
      active!.contract as unknown as PlaylistContractRevisionV1;
    await expect(repository.preparePlaylistRunRescueGuidance({
      runId: successor.runId,
      contractRevisionId: active!.id,
      contractSemanticHash: active!.contractHash,
      limitingClauseIds: [activeContract.clauses[0]!.id],
      fence: {
        jobId: leased.id,
        workerId,
        leaseEpoch: Number(leased.lease_epoch),
        queryPlanRevisionId: leased.query_plan_revision_id,
        stageKey: leased.stage_key,
      },
    })).resolves.toBeNull();
  }, 30_000);

  test("a losing no-op rescue tab cannot revive a superseded source run", async () => {
    const fixture = await createCanonicalRun();
    await repository.updateRun(fixture.created.runId, {
      status: "needs_decision",
      phase: "rescue_guidance_required",
    });
    const compiled = recompileCustomGuidanceTextV3({
      base: fixture.contract,
      customText: "clean versions only",
    });
    const confirmation = customGuidanceConfirmationDecisionV3({
      base: fixture.contract,
      compiled,
    });
    const round = selectGuidanceRoundV3({
      stage: "rescue",
      requestShape: "curated",
      candidates: [confirmation],
    });
    const questions = round.decisions.map(publicGuidanceQuestionV3);
    const questionSetId = randomUUID();
    await pool.query(
      `INSERT INTO guidance_question_sets(
         id,brief_request_id,run_id,revision,question_set_hash,
         request_classification,generation_mode,guidance_policy_version,
         locale,storefront,target_track_count,explicit_constraint_hash,
         rejected_question_reasons_json,questions_json,active,
         base_contract_revision_id,parent_question_set_id,
         feasibility_snapshot_id,guidance_round,trigger,axis)
       VALUES($1,NULL,$2,1,$3,'broad_curated','deterministic_critical',
              'adaptive_guidance_v3','en-US','us',20,$4,
              '[]'::jsonb,$5::jsonb,true,$6,NULL,NULL,
              'rescue','correctness','custom_contract_revision')`,
      [
        questionSetId,
        fixture.created.runId,
        round.roundHash,
        sha256Hex(`constraints:${fixture.created.runId}`),
        JSON.stringify(questions),
        fixture.contractDatabaseId,
      ],
    );
    await repository.createCanonicalRunSuccessor({
      runId: fixture.created.runId,
      sourceAccessId: fixture.created.accessId,
      expectedContractRevisionId: fixture.contractDatabaseId,
      expectedContractSemanticHash: fixture.contract.semanticHash,
      patch: genrePatch(fixture.contract, "dembow", "winning-tab"),
      idempotencyKey: randomUUID(),
      trigger: "rescue_guidance",
    });

    await expect(repository.submitPlaylistRunRescueGuidance({
      runId: fixture.created.runId,
      sourceAccessId: fixture.created.accessId,
      questionSetHash: round.roundHash,
      answers: [{
        questionId: questions[0]!.id,
        optionId: "keep_current_interpretation",
      }],
      idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "stale_guidance_question_set",
    });
    expect((await pool.query<{ status: string; phase: string }>(
      "SELECT status,phase FROM research_runs WHERE id=$1",
      [fixture.created.runId],
    )).rows[0]).toEqual({
      status: "cancelled",
      phase: "superseded_by_contract_revision",
    });
  }, 30_000);
});
