import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import * as databaseSchema from "../db/schema.ts";
import {
  compilePlaylistContractRevisionV1,
  type PlaylistContractPatchV1,
  type PlaylistContractRevisionV1,
} from "../server/playlist-contract-v1.ts";
import {
  createGuidanceDecisionV3,
  customGuidanceConfirmationDecisionV3,
  recompileCustomGuidanceTextV3,
  selectGuidanceRoundV3,
} from "../server/adaptive-guidance-v3.ts";
import {
  createAdaptiveRunDecisionV1,
  publicAdaptiveRunDecisionV1,
} from "../server/adaptive-run-decision-v1.ts";
import {
  compileGuidanceRoundPatchV3,
  publicGuidanceQuestionV3,
} from "../server/adaptive-guidance-contract-bridge.ts";
import {
  Repository,
  type CreateCanonicalRunSuccessorInput,
} from "../server/repository.ts";
import { pipelineV3ResearchJob } from "../server/research-resume.ts";
import {
  DEPENDENCY_RESUME_AUTHORIZATION_VERSION,
  dependencyResumeBlockerVersionV1,
} from "../server/dependency-resume-v1.ts";
import { createSelectionPlanV2 } from "../server/selection-plan-v2.ts";
import { sha256Hex, stableStringify } from "../server/security.ts";
import { WORKER_PIPELINE_CAPABILITY } from "../server/worker-protocol.ts";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  PUBLIC_ROLLOUT_ASSIGNMENT_VERSION,
  type PersistedPublicRolloutAssignmentV1,
} from "../server/public-rollout-assignment.ts";
import type { PublicRolloutConfiguration } from "../shared/public-rollout-evidence.ts";
import { signedArtifactSha256 } from "../shared/signed-artifact.ts";
import {
  CANONICAL_ACTIVATION_DATABASE_CAPABILITY_SETTING,
  CANONICAL_ACTIVATION_DATABASE_CAPABILITY_VERSION,
  CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_SETTING,
  CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_VERSION,
} from "../server/release-deployment-phase.ts";
import {
  AUTHENTICATED_OWNER_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
  PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
} from "../server/playlist-count-policy.ts";

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

function genreGuidanceRound(
  base: PlaylistContractRevisionV1,
  seed: string,
  selectedOptionId: "dembow" | "bachata" | "latin_pop",
  allowCustom = true,
) {
  const decision = createGuidanceDecisionV3({
    id: `guidance:genre:${seed}`,
    header: "Genre scope",
    question: `Which genre scope should ${seed} use?`,
    axis: `genre_scope_${seed}`,
    trigger: "correctness",
    criticality: "required",
    selectionMode: "single",
    allowCustom,
    baseContractRevisionId: base.revisionId,
    baseContractSemanticHash: base.semanticHash,
    whyMaterial: "Changes the hard genre membership rule.",
    allowedPatchOperations: ["replace_clause"],
    affectedClauseIds: ["membership:genre"],
    materialityScore: 100,
    options: ([
      ["dembow", "Dembow"],
      ["bachata", "Bachata"],
      ["latin_pop", "Latin pop"],
    ] as const).map(([id, label], index) => ({
      id,
      label,
      description: `Require ${label}.`,
      recommended: index === 0,
      expectedFeasibilityDirection: "neutral" as const,
      patch: {
        affectedClauseIds: ["membership:genre"],
        operations: [{
          op: "replace_clause" as const,
          clauseId: "membership:genre",
          clause: {
            id: "membership:genre",
            kind: "membership" as const,
            scope: "track" as const,
            hardness: "hard" as const,
            axis: "genre",
            operator: "require" as const,
            values: [label],
            source: { provenance: "guidance" as const, text: label },
            unknownPolicy: "reject" as const,
          },
        }],
      },
    })),
  });
  const question = publicGuidanceQuestionV3(decision);
  const questionSetHash = sha256Hex(`guidance-round:${seed}`);
  const answers = [{
    questionId: question.id,
    optionId: selectedOptionId,
  }];
  const patch = compileGuidanceRoundPatchV3({
    base,
    questionSetHash,
    questions: [question],
    answers,
  });
  if (!patch) throw new Error("expected genre guidance patch");
  return { question, questionSetHash, answers, patch };
}

function mismatchedRolloutAuthority(): {
  assignment: PersistedPublicRolloutAssignmentV1;
  authority: Record<string, unknown>;
} {
  const configuration = {
    PIPELINE_V2_OWNER_CANARY: "false",
    PIPELINE_V2_CURATED_PERCENT: "0",
    PIPELINE_V2_SIMILARITY_PERCENT: "0",
    PIPELINE_V2_FACTUAL_OWNER_CANARY: "false",
    PIPELINE_V2_FACTUAL_PERCENT: "0",
    PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
    PIPELINE_V3_OWNER_CANARY: "true",
    PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_OWNER_CANARY_GROUPS: "genre_scene",
    PIPELINE_V3_OWNER_CANARY_MAX_TRACKS: "50",
    PIPELINE_V3_GENRE_SCENE_PERCENT: "0",
    PIPELINE_V3_MOOD_ACTIVITY_PERCENT: "0",
    PIPELINE_V3_SIMILARITY_PERCENT: "100",
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
    PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "6",
    GUIDANCE_CONTRACT_V3_ENABLED: "false",
    GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
    GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "false",
  } as PublicRolloutConfiguration;
  const evidenceHash = "8".repeat(64);
  const stage = "similarity:50->100";
  const material = {
    version: PUBLIC_ROLLOUT_ASSIGNMENT_VERSION,
    rolloutEvidenceHash: evidenceHash,
    rolloutStage: stage,
    intentGroup: "similarity",
    cohort: 0,
    percentage: 100,
    assigned: true,
  } as const;
  const assignment = {
    ...material,
    assignmentHash: sha256Hex(stableStringify(material)),
  } satisfies PersistedPublicRolloutAssignmentV1;
  return {
    assignment,
    authority: {
      schemaVersion: "genio-public-rollout-database-authority/v1",
      evidenceHash,
      rollbackWarrantHash: "f".repeat(64),
      intentCanaryHash: "e".repeat(64),
      stage,
      intentGroup: "similarity",
      fromPercent: "50",
      toPercent: "100",
      targetConfigurationHash: signedArtifactSha256(configuration),
      targetConfiguration: configuration,
    },
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
    repository = new Repository({
      pool,
      db: drizzle(pool, { schema: databaseSchema }),
    });
  }, 30_000);

  beforeEach(async () => {
    // This suite owns its unique PostgreSQL schema, but earlier cases may
    // intentionally leave work queued. Drain only those suite-local rows so a
    // lease assertion can never select another case's older job.
    await pool.query(
      `UPDATE job_queue
       SET status='complete',completed_at=COALESCE(completed_at,now()),
           lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE status IN ('queued','retry','leased')`,
    );
  });

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
    rolloutIntentMismatch?: boolean;
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
    const rollout = input.rolloutIntentMismatch
      ? mismatchedRolloutAuthority()
      : null;
    const briefRequest = await repository.createBriefRequest({
      prompt: rawPrompt,
      requestedTrackCount: 20,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      briefContractVersion: 3,
      publicRolloutAssignment: rollout?.assignment ?? null,
    });
    if (rollout) {
      await pool.query(
        `INSERT INTO settings(key,value)
         VALUES($1,$2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        [
          `public_rollout_authority:${rollout.assignment.rolloutEvidenceHash}`,
          JSON.stringify(rollout.authority),
        ],
      );
    }
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
      forceFreshResearch: !input.rolloutIntentMismatch,
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

  async function createDependencyResumeFixture() {
    const fixture = await createCanonicalRun();
    const queryPlan = await repository.getActiveQueryPlan(
      fixture.created.runId,
    );
    if (!queryPlan || queryPlan.schemaVersion !== 5) {
      throw new Error("expected a schema-5 canonical query plan");
    }
    const activePlan = (await pool.query<{
      id: string;
      plan_hash: string;
    }>(
      `SELECT plan.id,plan.plan_hash
       FROM run_active_query_plans active
       JOIN query_plan_revisions plan
         ON plan.id=active.query_plan_revision_id
       WHERE active.run_id=$1`,
      [fixture.created.runId],
    )).rows[0]!;
    await pool.query(
      `UPDATE job_queue
       SET status='complete',completed_at=now(),lease_owner=NULL,
           lease_expires_at=NULL,updated_at=now()
       WHERE run_id=$1 AND status IN ('queued','retry')`,
      [fixture.created.runId],
    );
    const decision = createAdaptiveRunDecisionV1({
      contract: fixture.contract,
      reason: "dependency_retry_window_expired",
      verifiedTrackCount: 0,
      remainingStrategyCount: 0,
      reachedAt: new Date(Date.now() - 60_000),
    });
    const automaticRetryUntil = new Date(Date.now() - 60_000);
    const retryAfterUntil = new Date(Date.now() + 15 * 60_000);
    const stageKey = `v3-retrieval:active:${activePlan.plan_hash.slice(0, 48)}`;
    const blockerId = await repository.openPlaylistRunBlocker({
      runId: fixture.created.runId,
      contractRevisionId: fixture.contractDatabaseId,
      blockerKind: "provider",
      dependencyKey: "v3_retrieval_provider",
      retryCount: 8,
      nextRetryAt: null,
      automaticRetryUntil,
      state: {
        ...decision,
        stage: stageKey,
        reasonCode: "v3_retrieval_provider_failed",
        firstFailureAt: new Date(
          automaticRetryUntil.getTime() - 24 * 60 * 60_000,
        ).toISOString(),
        circuitOpenedAt: new Date(
          automaticRetryUntil.getTime() - 24 * 60 * 60_000,
        ).toISOString(),
        retryAfterUntil: retryAfterUntil.toISOString(),
        nextAction: "resume_revise_or_cancel",
        automaticResume: false,
      },
    });
    await repository.updateRun(fixture.created.runId, {
      status: "needs_decision",
      phase: "dependency_retry_window_expired",
      error: null,
    });
    const sessionId = randomUUID();
    await pool.query(
      `INSERT INTO capability_sessions(
         id,run_id,access_id,token_hash,expires_at)
       VALUES($1,$2,$3,$4,now()+interval '1 day')`,
      [
        sessionId,
        fixture.created.runId,
        fixture.created.accessId,
        sha256Hex(`dependency-session:${sessionId}`),
      ],
    );
    await pool.query(
      `INSERT INTO capability_session_accesses(session_id,run_id,access_id)
       VALUES($1,$2,$3)`,
      [sessionId, fixture.created.runId, fixture.created.accessId],
    );
    const blockerVersion = dependencyResumeBlockerVersionV1({
      id: blockerId,
      contractRevisionId: fixture.contractDatabaseId,
      dependencyKey: "v3_retrieval_provider",
      retryCount: 8,
      automaticRetryUntil,
      retryAfterUntil,
      stageKey,
      decisionHash: decision.decisionHash,
      nextAction: "resume_revise_or_cancel",
    });
    return {
      fixture,
      queryPlan,
      activePlan,
      blockerId,
      blockerVersion,
      decision,
      automaticRetryUntil,
      retryAfterUntil,
      stageKey,
      sessionId,
    };
  }

  async function createAnsweredGuidanceSuccessor(input: {
    corruptExecutionDeltaHash?: boolean;
    allowCustom?: boolean;
  } = {}) {
    const fixture = await createCanonicalRun();
    await repository.updateRun(fixture.created.runId, {
      status: "researching",
      phase: "v3_retrieval",
    });
    const round = genreGuidanceRound(
      fixture.contract,
      `integrity-${randomUUID().slice(0, 8)}`,
      "dembow",
      input.allowCustom ?? true,
    );
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
              '[]'::jsonb,$5::jsonb,false,$6,NULL,NULL,
              'initial','correctness','integrity_scope')`,
      [
        questionSetId,
        fixture.created.runId,
        round.questionSetHash,
        sha256Hex(`integrity:${fixture.created.runId}`),
        JSON.stringify([round.question]),
        fixture.contractDatabaseId,
      ],
    );
    const successor = await repository.createCanonicalRunSuccessor({
      runId: fixture.created.runId,
      sourceAccessId: fixture.created.accessId,
      expectedContractRevisionId: fixture.contractDatabaseId,
      expectedContractSemanticHash: fixture.contract.semanticHash,
      patch: round.patch,
      idempotencyKey: randomUUID(),
      trigger: "rescue_guidance",
    });
    const answerSetId = randomUUID();
    await pool.query(
      `INSERT INTO guidance_answer_sets(
         id,brief_request_id,run_id,question_set_id,question_set_hash,
         normalized_answers_json,raw_custom_answers_json,answer_hash,
         execution_delta_json,execution_delta_hash,idempotency_key,
         base_contract_revision_id,resulting_contract_revision_id,
         resulting_query_plan_revision_id)
       VALUES($1,NULL,$2,$3,$4,$5::jsonb,'[]'::jsonb,$6,$7::jsonb,$8,$9,
              $10,$11,$12)`,
      [
        answerSetId,
        fixture.created.runId,
        questionSetId,
        round.questionSetHash,
        JSON.stringify(round.answers),
        round.patch.answerLineage.answerHash,
        JSON.stringify(round.patch.operations),
        input.corruptExecutionDeltaHash
          ? "0".repeat(64)
          : sha256Hex(stableStringify(round.patch.operations)),
        randomUUID(),
        fixture.contractDatabaseId,
        successor.contractRevisionId,
        successor.queryPlanRevisionId,
      ],
    );
    await repository.updateRun(successor.runId, {
      status: "needs_decision",
      phase: "research_boundary",
    });
    const history = await repository.getPlaylistGuidanceHistory({
      runId: successor.runId,
      sourceAccessId: successor.accessId,
    });
    return { fixture, round, successor, answerSetId, history };
  }

  async function createActiveRescueConfirmation() {
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
    return {
      fixture,
      compiled,
      round,
      questions,
      questionSetId,
    };
  }

  test("applies the custom-count admission fence to historical guidance revisions", async () => {
    const value = await createAnsweredGuidanceSuccessor();
    const target = value.history.items[0]!;
    const common = {
      runId: value.successor.runId,
      sourceAccessId: value.successor.accessId,
      answerSetId: target.answerSetId,
      questionId: target.question.id,
      expectedContractRevisionId:
        value.history.activeContractRevisionId,
      expectedContractSemanticHash:
        value.history.activeContractSemanticHash,
      historyVersion: value.history.historyVersion,
    };
    for (const requestedTrackCount of [301, 1_000]) {
      await expect(repository.revisePlaylistGuidanceAnswer({
        ...common,
        customTrackCountAuthority:
          PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
        answer: {
          questionId: target.question.id,
          customText: `${requestedTrackCount} tracks with smooth flow`,
        },
        idempotencyKey: randomUUID(),
      })).rejects.toMatchObject({
        statusCode: 400,
        code: "invalid_track_count",
      });
    }
    await expect(repository.revisePlaylistGuidanceAnswer({
      ...common,
      customTrackCountAuthority:
        AUTHENTICATED_OWNER_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      answer: {
        questionId: target.question.id,
        customText: "1000 tracks with smooth flow",
      },
      idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "count_revision_required",
    });
    expect((await pool.query<{ status: string; phase: string }>(
      "SELECT status,phase FROM research_runs WHERE id=$1",
      [value.successor.runId],
    )).rows[0]).toEqual({
      status: "needs_decision",
      phase: "research_boundary",
    });
  }, 30_000);

  test("authorizes the historical target and custom axis before provider eligibility", async () => {
    const value = await createAnsweredGuidanceSuccessor();
    const target = value.history.items[0]!;
    const common = {
      runId: value.successor.runId,
      sourceAccessId: value.successor.accessId,
      expectedContractRevisionId:
        value.history.activeContractRevisionId,
      expectedContractSemanticHash:
        value.history.activeContractSemanticHash,
      historyVersion: value.history.historyVersion,
      idempotencyKey: randomUUID(),
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
    };
    await expect(repository.preflightPlaylistGuidanceRevision({
      ...common,
      answerSetId: randomUUID(),
      questionId: target.question.id,
      answer: {
        questionId: target.question.id,
        customText: "no Bad Bunny",
      },
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "stale_guidance_history",
    });
    await expect(repository.preflightPlaylistGuidanceRevision({
      ...common,
      idempotencyKey: randomUUID(),
      answerSetId: target.answerSetId,
      questionId: target.question.id,
      answer: {
        questionId: "guidance:another-axis",
        customText: "no Bad Bunny",
      },
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "stale_guidance_history",
    });
    await expect(repository.preflightPlaylistGuidanceRevision({
      ...common,
      idempotencyKey: randomUUID(),
      answerSetId: target.answerSetId,
      questionId: target.question.id,
      answer: {
        questionId: target.question.id,
        customText: "1001 tracks with smooth flow",
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "invalid_track_count",
    });

    const locked = await createAnsweredGuidanceSuccessor({
      allowCustom: false,
    });
    const lockedTarget = locked.history.items[0]!;
    await expect(repository.preflightPlaylistGuidanceRevision({
      runId: locked.successor.runId,
      sourceAccessId: locked.successor.accessId,
      answerSetId: lockedTarget.answerSetId,
      questionId: lockedTarget.question.id,
      answer: {
        questionId: lockedTarget.question.id,
        customText: "no Bad Bunny",
      },
      expectedContractRevisionId:
        locked.history.activeContractRevisionId,
      expectedContractSemanticHash:
        locked.history.activeContractSemanticHash,
      historyVersion: locked.history.historyVersion,
      idempotencyKey: randomUUID(),
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "custom_guidance_not_allowed",
    });

    expect((await pool.query<{ status: string; phase: string }>(
      `SELECT status,phase FROM research_runs
       WHERE id IN ($1,$2) ORDER BY id`,
      [value.successor.runId, locked.successor.runId],
    )).rows).toEqual([
      { status: "needs_decision", phase: "research_boundary" },
      { status: "needs_decision", phase: "research_boundary" },
    ]);
  }, 30_000);

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

  test("persists a rollout intent change as a durable immutable decision instead of a 409 or downgrade", async () => {
    const fixture = await createCanonicalRun({
      rolloutIntentMismatch: true,
    });
    expect(fixture.created).toMatchObject({
      created: true,
      status: "needs_decision",
    });
    const persisted = (await pool.query<{
      status: string;
      phase: string;
      contract_hash: string;
      job_count: number;
      blocker_kind: string;
      state_json: Record<string, unknown>;
    }>(
      `SELECT run.status,run.phase,contract.contract_hash,
              (SELECT count(*)::int FROM job_queue
               WHERE run_id=run.id) job_count,
              blocker.blocker_kind,blocker.state_json
       FROM research_runs run
       JOIN playlist_contract_revisions contract
         ON contract.id=run.active_playlist_contract_revision_id
       JOIN playlist_run_blockers blocker
         ON blocker.run_id=run.id AND blocker.resolved_at IS NULL
       WHERE run.id=$1`,
      [fixture.created.runId],
    )).rows[0]!;
    expect(persisted).toMatchObject({
      status: "needs_decision",
      phase: "public_rollout_successor_required",
      contract_hash: fixture.contract.semanticHash,
      job_count: 0,
      blocker_kind: "scope_decision",
      state_json: {
        reasonCode: "public_rollout_successor_required",
        assignedIntentGroup: "similarity",
        confirmedIntentGroup: "genre_scene",
        sourceRolloutAssignment: {
          assigned: true,
          intentGroup: "similarity",
        },
        actions: [
          "create_user_authored_revision",
          "cancel",
        ],
        automaticResume: false,
      },
    });
    await pool.query(
      "UPDATE brief_requests SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [fixture.briefRequestId],
    );
    expect(await repository.getRunByAccess(fixture.created.accessId))
      .toMatchObject({
        status: "needs_decision",
        phase: "public_rollout_successor_required",
        resolution: {
          state: "needs_decision",
          nextAction: "review_contract",
          blocker: { kind: "scope_decision" },
        },
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
        blocker_kind: "scope_decision",
        dependency_key: "pipeline_cohort:corpus_first_v3",
        state_json: {
          reasonCode: "contract_execution_cohort_paused",
          route: "corpus_first_v3",
          actions: [
            "create_user_authored_revision",
            "cancel",
          ],
          automaticResume: false,
        },
      });
      expect(await repository.getRunByAccess(fixture.created.accessId))
        .toMatchObject({
          resolution: {
            state: "needs_decision",
            nextAction: "review_contract",
            terminal: false,
            blocker: {
              kind: "scope_decision",
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
    const queuedAuthority = (await pool.query<{
      required_executor_revision: string;
      required_executor_semantic_configuration_hash: string;
    }>(
      `SELECT required_executor_revision,
              required_executor_semantic_configuration_hash
       FROM job_queue WHERE id=$1`,
      [queued.id],
    )).rows[0]!;
    await repository.updateWorkerHeartbeat("late-old-worker", {
      version: queuedAuthority.required_executor_revision,
      semanticExecutionConfigurationHash:
        queuedAuthority.required_executor_semantic_configuration_hash,
      protocolVersion: "playlist-pipeline-v10",
      capacity: 1,
      activeJobs: 0,
    });
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
      query_schema_version: 5,
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
    const queuedAuthority = (await pool.query<{
      required_executor_revision: string;
      required_executor_semantic_configuration_hash: string;
    }>(
      `SELECT required_executor_revision,
              required_executor_semantic_configuration_hash
       FROM job_queue
       WHERE run_id=$1 AND kind='research' AND status='queued'
       ORDER BY created_at,id LIMIT 1`,
      [successor.runId],
    )).rows[0]!;
    await repository.updateWorkerHeartbeat(workerId, {
      version: queuedAuthority.required_executor_revision,
      semanticExecutionConfigurationHash:
        queuedAuthority.required_executor_semantic_configuration_hash,
      protocolVersion: "playlist-pipeline-v10",
      capacity: 1,
      activeJobs: 0,
    });
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
    })).resolves.toMatchObject({
      kind: "interpretation_summary",
      questions: [],
      attemptsUsed: 2,
      maximumAttempts: 2,
      showEditableInterpretationSummary: true,
      reason: "clarification_attempt_limit",
      interpretationSummary: {
        count: 20,
      },
      actions: {
        changeEarlierAnswer: true,
        reviewContract: true,
        resumeLater: true,
        cancel: true,
      },
    });
    expect((await pool.query<{
      status: string;
      phase: string;
      generation_mode: string;
      questions_json: unknown[];
      blocker_kind: string;
    }>(
      `SELECT run.status,run.phase,questions.generation_mode,
              questions.questions_json,blocker.blocker_kind
       FROM research_runs run
       JOIN guidance_question_sets questions
         ON questions.run_id=run.id AND questions.active
       JOIN playlist_run_blockers blocker
         ON blocker.run_id=run.id AND blocker.resolved_at IS NULL
       WHERE run.id=$1`,
      [successor.runId],
    )).rows[0]).toMatchObject({
      status: "needs_decision",
      phase: "interpretation_summary_required",
      generation_mode: "interpretation_summary",
      questions_json: [],
      blocker_kind: "scope_decision",
    });
  }, 30_000);

  test("a losing no-op rescue tab cannot revive a superseded source run", async () => {
    const { fixture, round, questions } =
      await createActiveRescueConfirmation();
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

  test("a skipped rescue question fences a stale patch tab without creating a successor", async () => {
    const { fixture, round, questions } =
      await createActiveRescueConfirmation();
    await expect(repository.submitPlaylistRunRescueGuidance({
      runId: fixture.created.runId,
      sourceAccessId: fixture.created.accessId,
      questionSetHash: round.roundHash,
      answers: [{
        questionId: questions[0]!.id,
        optionId: "keep_current_interpretation",
      }],
      idempotencyKey: randomUUID(),
    })).resolves.toMatchObject({
      runId: fixture.created.runId,
      accessId: fixture.created.accessId,
      created: true,
      revised: false,
    });

    await expect(repository.submitPlaylistRunRescueGuidance({
      runId: fixture.created.runId,
      sourceAccessId: fixture.created.accessId,
      questionSetHash: round.roundHash,
      answers: [{
        questionId: questions[0]!.id,
        optionId: "apply_revised_interpretation",
      }],
      idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "stale_guidance_question_set",
    });

    expect((await pool.query<{
      status: string;
      phase: string;
      active: boolean;
      successor_count: number;
    }>(
      `SELECT run.status,run.phase,questions.active,
              (
                SELECT count(*)::int
                FROM playlist_contract_revisions successor
                WHERE successor.parent_revision_id=$2
              ) successor_count
       FROM research_runs run
       JOIN guidance_question_sets questions
         ON questions.run_id=run.id AND questions.question_set_hash=$3
       WHERE run.id=$1`,
      [
        fixture.created.runId,
        fixture.contractDatabaseId,
        round.roundHash,
      ],
    )).rows[0]).toEqual({
      status: "needs_decision",
      phase: "rescue_guidance_skipped",
      active: false,
      successor_count: 0,
    });
  }, 30_000);

  test("persists rescue answer authority and lineage in the successor transaction", async () => {
    const { fixture, round, questions, questionSetId } =
      await createActiveRescueConfirmation();
    const answers = [{
      questionId: questions[0]!.id,
      optionId: "apply_revised_interpretation",
    }];
    const expectedPatch = compileGuidanceRoundPatchV3({
      base: fixture.contract,
      questionSetHash: round.roundHash,
      questions,
      answers,
    });
    if (!expectedPatch) throw new Error("expected executable rescue patch");
    const idempotencyKey = randomUUID();
    const submitted = await repository.submitPlaylistRunRescueGuidance({
      runId: fixture.created.runId,
      sourceAccessId: fixture.created.accessId,
      questionSetHash: round.roundHash,
      answers,
      idempotencyKey,
    });
    expect(submitted).toMatchObject({
      created: true,
      revised: true,
    });

    const persisted = (await pool.query<{
      active: boolean;
      question_set_id: string;
      answer_hash: string;
      question_set_hash: string;
      base_contract_revision_id: string;
      resulting_contract_revision_id: string;
      resulting_selection_plan_id: string | null;
      resulting_query_plan_revision_id: string | null;
      active_query_plan_revision_id: string | null;
      execution_delta_hash: string;
      contract_json: PlaylistContractRevisionV1;
    }>(
      `SELECT questions.active,answers.question_set_id,answers.answer_hash,
              answers.question_set_hash,answers.base_contract_revision_id,
              answers.resulting_contract_revision_id,
              answers.resulting_selection_plan_id,
              answers.resulting_query_plan_revision_id,
              active.query_plan_revision_id active_query_plan_revision_id,
              answers.execution_delta_hash,contract.contract_json
       FROM guidance_answer_sets answers
       JOIN guidance_question_sets questions
         ON questions.id=answers.question_set_id
       JOIN playlist_contract_revisions contract
         ON contract.id=answers.resulting_contract_revision_id
       LEFT JOIN run_active_query_plans active
         ON active.run_id=contract.run_id
       WHERE answers.run_id=$1 AND answers.idempotency_key=$2`,
      [fixture.created.runId, idempotencyKey],
    )).rows[0]!;
    const activeContract =
      await repository.getActivePlaylistContractRevision({
        runId: submitted.runId,
      });
    expect(activeContract).toBeTruthy();
    expect(persisted).toMatchObject({
      active: false,
      question_set_id: questionSetId,
      answer_hash: expectedPatch.answerLineage.answerHash,
      question_set_hash: round.roundHash,
      base_contract_revision_id: fixture.contractDatabaseId,
      resulting_contract_revision_id: activeContract!.id,
      execution_delta_hash: sha256Hex(stableStringify(
        expectedPatch.operations,
      )),
    });
    expect(persisted.resulting_selection_plan_id).not.toBeNull();
    expect(persisted.resulting_query_plan_revision_id).toBe(
      persisted.active_query_plan_revision_id,
    );
    expect(persisted.contract_json.answerLineage.at(-1)).toEqual(
      expectedPatch.answerLineage,
    );

    await expect(repository.submitPlaylistRunRescueGuidance({
      runId: fixture.created.runId,
      sourceAccessId: fixture.created.accessId,
      questionSetHash: round.roundHash,
      answers,
      idempotencyKey,
    })).resolves.toMatchObject({
      ...submitted,
      created: false,
    });
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int count
       FROM guidance_answer_sets
       WHERE run_id=$1 AND idempotency_key=$2`,
      [fixture.created.runId, idempotencyKey],
    )).rows[0]?.count).toBe(1);
  }, 30_000);

  test("revises an earlier answer, invalidates later authority, reoffers a still-material question, and fences stale tabs", async () => {
    const fixture = await createCanonicalRun();
    await repository.updateRun(fixture.created.runId, {
      status: "researching",
      phase: "v3_retrieval",
    });
    const firstRound = genreGuidanceRound(
      fixture.contract,
      "initial-scope",
      "dembow",
    );
    const firstQuestionSetId = randomUUID();
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
              '[]'::jsonb,$5::jsonb,false,$6,NULL,NULL,
              'initial','correctness','genre_scope_initial')`,
      [
        firstQuestionSetId,
        fixture.created.runId,
        firstRound.questionSetHash,
        sha256Hex("initial-scope-constraints"),
        JSON.stringify([firstRound.question]),
        fixture.contractDatabaseId,
      ],
    );
    const firstSuccessor = await repository.createCanonicalRunSuccessor({
      runId: fixture.created.runId,
      sourceAccessId: fixture.created.accessId,
      expectedContractRevisionId: fixture.contractDatabaseId,
      expectedContractSemanticHash: fixture.contract.semanticHash,
      patch: firstRound.patch,
      idempotencyKey: randomUUID(),
      trigger: "rescue_guidance",
    });
    const firstAnswerSetId = randomUUID();
    await pool.query(
      `INSERT INTO guidance_answer_sets(
         id,brief_request_id,run_id,question_set_id,question_set_hash,
         normalized_answers_json,raw_custom_answers_json,answer_hash,
         execution_delta_json,execution_delta_hash,idempotency_key,
         base_contract_revision_id,resulting_contract_revision_id,
         resulting_query_plan_revision_id)
       VALUES($1,NULL,$2,$3,$4,$5::jsonb,'[]'::jsonb,$6,$7::jsonb,$8,$9,
              $10,$11,$12)`,
      [
        firstAnswerSetId,
        fixture.created.runId,
        firstQuestionSetId,
        firstRound.questionSetHash,
        JSON.stringify(firstRound.answers),
        firstRound.patch.answerLineage.answerHash,
        JSON.stringify(firstRound.patch.operations),
        sha256Hex(stableStringify(firstRound.patch.operations)),
        randomUUID(),
        fixture.contractDatabaseId,
        firstSuccessor.contractRevisionId,
        firstSuccessor.queryPlanRevisionId,
      ],
    );
    const firstContract = (await pool.query<{
      contract_json: PlaylistContractRevisionV1;
    }>(
      "SELECT contract_json FROM playlist_contract_revisions WHERE id=$1",
      [firstSuccessor.contractRevisionId],
    )).rows[0]!.contract_json;
    await repository.updateRun(firstSuccessor.runId, {
      status: "researching",
      phase: "v3_retrieval",
    });
    const laterRound = genreGuidanceRound(
      firstContract,
      "later-scope",
      "latin_pop",
    );
    const laterQuestionSetId = randomUUID();
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
              '[]'::jsonb,$5::jsonb,false,$6,NULL,NULL,
              'rescue','yield_risk','genre_scope_later')`,
      [
        laterQuestionSetId,
        firstSuccessor.runId,
        laterRound.questionSetHash,
        sha256Hex("later-scope-constraints"),
        JSON.stringify([laterRound.question]),
        firstSuccessor.contractRevisionId,
      ],
    );
    const laterSuccessor = await repository.createCanonicalRunSuccessor({
      runId: firstSuccessor.runId,
      sourceAccessId: firstSuccessor.accessId,
      expectedContractRevisionId: firstSuccessor.contractRevisionId,
      expectedContractSemanticHash: firstContract.semanticHash,
      patch: laterRound.patch,
      idempotencyKey: randomUUID(),
      trigger: "rescue_guidance",
    });
    const laterAnswerSetId = randomUUID();
    await pool.query(
      `INSERT INTO guidance_answer_sets(
         id,brief_request_id,run_id,question_set_id,question_set_hash,
         normalized_answers_json,raw_custom_answers_json,answer_hash,
         execution_delta_json,execution_delta_hash,idempotency_key,
         base_contract_revision_id,resulting_contract_revision_id,
         resulting_query_plan_revision_id)
       VALUES($1,NULL,$2,$3,$4,$5::jsonb,'[]'::jsonb,$6,$7::jsonb,$8,$9,
              $10,$11,$12)`,
      [
        laterAnswerSetId,
        firstSuccessor.runId,
        laterQuestionSetId,
        laterRound.questionSetHash,
        JSON.stringify(laterRound.answers),
        laterRound.patch.answerLineage.answerHash,
        JSON.stringify(laterRound.patch.operations),
        sha256Hex(stableStringify(laterRound.patch.operations)),
        randomUUID(),
        firstSuccessor.contractRevisionId,
        laterSuccessor.contractRevisionId,
        laterSuccessor.queryPlanRevisionId,
      ],
    );
    await repository.updateRun(laterSuccessor.runId, {
      status: "needs_decision",
      phase: "research_boundary",
    });
    const history = await repository.getPlaylistGuidanceHistory({
      runId: laterSuccessor.runId,
      sourceAccessId: laterSuccessor.accessId,
    });
    expect(history.items.map((item) => item.question.id)).toEqual([
      firstRound.question.id,
      laterRound.question.id,
    ]);
    expect(JSON.stringify(history)).not.toContain(fixture.rawPrompt);
    const target = history.items[0]!;
    const revisionKey = randomUUID();
    const revisionInput = {
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      runId: laterSuccessor.runId,
      sourceAccessId: laterSuccessor.accessId,
      answerSetId: target.answerSetId,
      questionId: target.question.id,
      answer: {
        questionId: target.question.id,
        optionId: "bachata",
      },
      expectedContractRevisionId: history.activeContractRevisionId,
      expectedContractSemanticHash: history.activeContractSemanticHash,
      historyVersion: history.historyVersion,
      idempotencyKey: revisionKey,
    };
    const revised = await repository.revisePlaylistGuidanceAnswer(
      revisionInput,
    );
    expect(revised).toMatchObject({
      status: "revised",
      created: true,
    });
    if (revised.status !== "revised") throw new Error("expected revision");
    const successorRun = (await pool.query<{
      status: string;
      phase: string;
      active_playlist_contract_revision_id: string;
      contract_json: PlaylistContractRevisionV1;
    }>(
      `SELECT run.status,run.phase,
              run.active_playlist_contract_revision_id,
              contract.contract_json
       FROM research_runs run
       JOIN playlist_contract_revisions contract
         ON contract.id=run.active_playlist_contract_revision_id
       WHERE run.id=$1`,
      [revised.runId],
    )).rows[0]!;
    expect(successorRun).toMatchObject({
      status: "needs_decision",
      phase: "dependent_guidance_required",
    });
    expect(successorRun.contract_json.answerLineage).toHaveLength(1);
    expect(successorRun.contract_json.clauses.find(
      ({ id }) => id === "membership:genre",
    )?.values).toEqual(["Bachata"]);
    expect((await pool.query<{
      id: string;
      invalidated_at: Date | null;
    }>(
      `SELECT id,invalidated_at FROM guidance_answer_sets
       WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [[firstAnswerSetId, laterAnswerSetId]],
    )).rows.every((row) => row.invalidated_at instanceof Date)).toBe(true);
    const reoffered = (await pool.query<{
      question_set_hash: string;
      questions_json: Array<{
        baseContractRevisionId?: string;
        baseContractSemanticHash?: string;
      }>;
    }>(
      `SELECT question_set_hash,questions_json
       FROM guidance_question_sets
       WHERE run_id=$1 AND active`,
      [revised.runId],
    )).rows[0]!;
    expect(reoffered.question_set_hash).not.toBe(laterRound.questionSetHash);
    expect(reoffered.questions_json[0]).toMatchObject({
      baseContractRevisionId: successorRun.contract_json.revisionId,
      baseContractSemanticHash: successorRun.contract_json.semanticHash,
    });
    await expect(repository.revisePlaylistGuidanceAnswer(revisionInput))
      .resolves.toMatchObject({
        status: "revised",
        runId: revised.runId,
        accessId: revised.accessId,
        created: false,
      });
    await expect(repository.revisePlaylistGuidanceAnswer({
      ...revisionInput,
      idempotencyKey: randomUUID(),
      answer: {
        questionId: target.question.id,
        optionId: "latin_pop",
      },
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "stale_guidance_history",
    });
  }, 30_000);

  test("resumes one retained 24-hour dependency decision idempotently under the exact executor fence", async () => {
    const value = await createDependencyResumeFixture();
    const rawDecision = (await pool.query<{
      state_json: Record<string, unknown>;
      semantic_hash: string;
    }>(
      `SELECT blocker.state_json,
              contract.contract_json->>'semanticHash' semantic_hash
       FROM playlist_run_blockers blocker
       JOIN playlist_contract_revisions contract
         ON contract.id=blocker.contract_revision_id
       WHERE blocker.id=$1`,
      [value.blockerId],
    )).rows[0]!;
    expect(rawDecision.semantic_hash)
      .toBe(value.decision.contractSemanticHash);
    expect(publicAdaptiveRunDecisionV1(rawDecision.state_json))
      .toMatchObject({
        decisionHash: value.decision.decisionHash,
        reason: "dependency_retry_window_expired",
      });
    const projected = await repository.getRunByAccess(
      value.fixture.created.accessId,
    );
    expect(projected).toMatchObject({
      resolution: {
        state: "needs_decision",
        nextAction: "resume_research",
        blocker: {
          kind: "provider",
          versionHash: value.blockerVersion,
        },
      },
      decisionAction: {
        decisionHash: value.decision.decisionHash,
        reason: "dependency_retry_window_expired",
      },
    });

    const idempotencyKey = randomUUID();
    const input = {
      runId: value.fixture.created.runId,
      sourceAccessId: value.fixture.created.accessId,
      capabilitySessionId: value.sessionId,
      idempotencyKey,
      expectedContractRevisionId: value.fixture.contractDatabaseId,
      expectedContractSemanticHash: value.fixture.contract.semanticHash,
      expectedDecisionHash: value.decision.decisionHash,
      expectedBlockerVersion: value.blockerVersion,
    };
    const resumed = await repository.resumePlaylistDependencyDecision(input);
    expect(resumed).toMatchObject({
      queued: true,
    });
    expect(resumed.authorizationHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(resumed.resumeAt.getTime()).toBe(value.retryAfterUntil.getTime());

    const persisted = (await pool.query<{
      status: string;
      phase: string;
      job_id: string;
      job_status: string;
      available_at: Date;
      query_plan_revision_id: string;
      required_executor_capability_hash: string;
      payload_json: Record<string, unknown>;
      blocker_resolved_at: Date | null;
      checkpoint: Record<string, unknown>;
    }>(
      `SELECT run.status,run.phase,job.id job_id,job.status job_status,
              job.available_at,job.query_plan_revision_id,
              job.required_executor_capability_hash,job.payload_json,
              blocker.resolved_at blocker_resolved_at,
              checkpoint.state_json checkpoint
       FROM research_runs run
       JOIN job_queue job
         ON job.run_id=run.id
        AND job.payload_json->>'dependencyResumeAuthorizationHash'=$2
       JOIN playlist_run_blockers blocker ON blocker.id=$3
       JOIN research_checkpoints checkpoint
         ON checkpoint.run_id=run.id
        AND checkpoint.phase LIKE 'dependency_resume_v1:%'
       WHERE run.id=$1`,
      [
        value.fixture.created.runId,
        resumed.authorizationHash,
        value.blockerId,
      ],
    )).rows[0]!;
    expect(persisted).toMatchObject({
      status: "queued",
      phase: "dependency_resume_scheduled",
      job_id: resumed.jobId,
      job_status: "queued",
      query_plan_revision_id: value.activePlan.id,
      required_executor_capability_hash:
        value.queryPlan.executorCapabilityHash,
      payload_json: {
        dependencyResumeAuthorizationHash: resumed.authorizationHash,
        dependencyKey: "v3_retrieval_provider",
        stageExecutionKey: value.stageKey,
      },
    });
    expect(persisted.available_at.getTime())
      .toBe(value.retryAfterUntil.getTime());
    expect(persisted.blocker_resolved_at).toBeInstanceOf(Date);
    expect(persisted.checkpoint).toMatchObject({
      schemaVersion: DEPENDENCY_RESUME_AUTHORIZATION_VERSION,
      runId: value.fixture.created.runId,
      sourceAccessId: value.fixture.created.accessId,
      capabilitySessionId: value.sessionId,
      idempotencyKey,
      contractRevisionId: value.fixture.contractDatabaseId,
      contractSemanticHash: value.fixture.contract.semanticHash,
      queryPlanRevisionId: value.activePlan.id,
      blockerId: value.blockerId,
      blockerVersion: value.blockerVersion,
      decisionHash: value.decision.decisionHash,
      authorizationHash: resumed.authorizationHash,
      dependencyKey: "v3_retrieval_provider",
      stageKey: value.stageKey,
      jobId: resumed.jobId,
      resumeAt: value.retryAfterUntil.toISOString(),
    });
    expect(JSON.stringify(persisted.checkpoint))
      .not.toContain(value.fixture.rawPrompt);

    await expect(repository.resumePlaylistDependencyDecision(input))
      .resolves.toEqual({
        queued: false,
        jobId: resumed.jobId,
        authorizationHash: resumed.authorizationHash,
        resumeAt: resumed.resumeAt,
      });
    await expect(repository.resumePlaylistDependencyDecision({
      ...input,
      idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "dependency_resume_stale",
    });
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int count
       FROM job_queue
       WHERE run_id=$1
         AND payload_json ? 'dependencyResumeAuthorizationHash'`,
      [value.fixture.created.runId],
    )).rows[0]?.count).toBe(1);
  }, 30_000);

  test("cancellation, quarantine, and a successor winner prevent dependency resume from reviving stale work", async () => {
    expect(Object.fromEntries((await pool.query<{
      key: string;
      value: string;
    }>(
      "SELECT key,value FROM settings WHERE key=ANY($1::text[])",
      [[
        "schema_version",
        CANONICAL_ACTIVATION_DATABASE_CAPABILITY_SETTING,
        CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_SETTING,
      ]],
    )).rows.map(({ key, value }) => [key, value]))).toEqual({
      schema_version: "19",
      [CANONICAL_ACTIVATION_DATABASE_CAPABILITY_SETTING]:
        CANONICAL_ACTIVATION_DATABASE_CAPABILITY_VERSION,
      [CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_SETTING]:
        CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_VERSION,
    });
    const unhardened = await createDependencyResumeFixture();
    await pool.query(
      "DELETE FROM settings WHERE key=$1",
      [CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_SETTING],
    );
    try {
      await expect(repository.resumePlaylistDependencyDecision({
        runId: unhardened.fixture.created.runId,
        sourceAccessId: unhardened.fixture.created.accessId,
        capabilitySessionId: unhardened.sessionId,
        idempotencyKey: randomUUID(),
        expectedContractRevisionId:
          unhardened.fixture.contractDatabaseId,
        expectedContractSemanticHash:
          unhardened.fixture.contract.semanticHash,
        expectedDecisionHash: unhardened.decision.decisionHash,
        expectedBlockerVersion: unhardened.blockerVersion,
      })).rejects.toMatchObject({
        statusCode: 503,
        code: "dependency_resume_unavailable",
      });
    } finally {
      await pool.query(
        `INSERT INTO settings(key,value)
         VALUES($1,$2)
         ON CONFLICT(key)
         DO UPDATE SET value=excluded.value,updated_at=now()`,
        [
          CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_SETTING,
          CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_VERSION,
        ],
      );
    }

    const cancelled = await createDependencyResumeFixture();
    await repository.cancelRunByVisitor(cancelled.fixture.created.runId);
    await expect(repository.resumePlaylistDependencyDecision({
      runId: cancelled.fixture.created.runId,
      sourceAccessId: cancelled.fixture.created.accessId,
      capabilitySessionId: cancelled.sessionId,
      idempotencyKey: randomUUID(),
      expectedContractRevisionId: cancelled.fixture.contractDatabaseId,
      expectedContractSemanticHash: cancelled.fixture.contract.semanticHash,
      expectedDecisionHash: cancelled.decision.decisionHash,
      expectedBlockerVersion: cancelled.blockerVersion,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "dependency_resume_cancelled",
    });

    const quarantined = await createDependencyResumeFixture();
    await repository.updateRun(quarantined.fixture.created.runId, {
      status: "failed_integrity",
      phase: "dependency_resume_integrity_quarantine",
    });
    await expect(repository.resumePlaylistDependencyDecision({
      runId: quarantined.fixture.created.runId,
      sourceAccessId: quarantined.fixture.created.accessId,
      capabilitySessionId: quarantined.sessionId,
      idempotencyKey: randomUUID(),
      expectedContractRevisionId: quarantined.fixture.contractDatabaseId,
      expectedContractSemanticHash: quarantined.fixture.contract.semanticHash,
      expectedDecisionHash: quarantined.decision.decisionHash,
      expectedBlockerVersion: quarantined.blockerVersion,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "dependency_resume_quarantined",
    });

    const superseded = await createDependencyResumeFixture();
    const successor = await repository.createCanonicalRunSuccessor({
      runId: superseded.fixture.created.runId,
      sourceAccessId: superseded.fixture.created.accessId,
      expectedContractRevisionId:
        superseded.fixture.contractDatabaseId,
      expectedContractSemanticHash:
        superseded.fixture.contract.semanticHash,
      patch: genrePatch(
        superseded.fixture.contract,
        "dembow",
        `dependency-successor-${randomUUID()}`,
      ),
      idempotencyKey: randomUUID(),
      trigger: "named_predicate_revision",
    });
    await expect(repository.resumePlaylistDependencyDecision({
      runId: superseded.fixture.created.runId,
      sourceAccessId: superseded.fixture.created.accessId,
      capabilitySessionId: superseded.sessionId,
      idempotencyKey: randomUUID(),
      expectedContractRevisionId:
        superseded.fixture.contractDatabaseId,
      expectedContractSemanticHash:
        superseded.fixture.contract.semanticHash,
      expectedDecisionHash: superseded.decision.decisionHash,
      expectedBlockerVersion: superseded.blockerVersion,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "dependency_resume_stale",
    });
    expect((await pool.query<{ status: string; phase: string }>(
      "SELECT status,phase FROM research_runs WHERE id=$1",
      [superseded.fixture.created.runId],
    )).rows[0]).toEqual({
      status: "cancelled",
      phase: "superseded_by_contract_revision",
    });
    expect((await pool.query<{ status: string; phase: string }>(
      "SELECT status,phase FROM research_runs WHERE id=$1",
      [successor.runId],
    )).rows[0]).toMatchObject({
      status: "queued",
      phase: "queued",
    });
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int count
       FROM job_queue
       WHERE run_id=$1
         AND payload_json ? 'dependencyResumeAuthorizationHash'`,
      [superseded.fixture.created.runId],
    )).rows[0]?.count).toBe(0);
  }, 30_000);

  test("quarantines corrupt guidance only under the expected active fence and never after a concurrent successor", async () => {
    const corrupt = await createAnsweredGuidanceSuccessor({
      corruptExecutionDeltaHash: true,
    });
    const corruptTarget = corrupt.history.items[0]!;
    await expect(repository.revisePlaylistGuidanceAnswer({
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      runId: corrupt.successor.runId,
      sourceAccessId: corrupt.successor.accessId,
      answerSetId: corruptTarget.answerSetId,
      questionId: corruptTarget.question.id,
      answer: {
        questionId: corruptTarget.question.id,
        optionId: "bachata",
      },
      expectedContractRevisionId:
        corrupt.history.activeContractRevisionId,
      expectedContractSemanticHash:
        corrupt.history.activeContractSemanticHash,
      historyVersion: corrupt.history.historyVersion,
      idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "guidance_history_integrity",
    });
    expect((await pool.query<{ status: string; phase: string }>(
      "SELECT status,phase FROM research_runs WHERE id=$1",
      [corrupt.successor.runId],
    )).rows[0]).toEqual({
      status: "failed_integrity",
      phase: "guidance_history_integrity_quarantine",
    });

    const raced = await createAnsweredGuidanceSuccessor({
      corruptExecutionDeltaHash: true,
    });
    const racedActive = (await pool.query<{
      contract_json: PlaylistContractRevisionV1;
    }>(
      "SELECT contract_json FROM playlist_contract_revisions WHERE id=$1",
      [raced.successor.contractRevisionId],
    )).rows[0]!.contract_json;
    await repository.updateRun(raced.successor.runId, {
      status: "researching",
      phase: "v3_retrieval",
    });
    const validWinner = await repository.createCanonicalRunSuccessor({
      runId: raced.successor.runId,
      sourceAccessId: raced.successor.accessId,
      expectedContractRevisionId: raced.successor.contractRevisionId,
      expectedContractSemanticHash: racedActive.semanticHash,
      patch: genrePatch(
        racedActive,
        "merengue",
        `valid-winner-${randomUUID()}`,
      ),
      idempotencyKey: randomUUID(),
      trigger: "named_predicate_revision",
    });
    const racedTarget = raced.history.items[0]!;
    await expect(repository.revisePlaylistGuidanceAnswer({
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      runId: raced.successor.runId,
      sourceAccessId: raced.successor.accessId,
      answerSetId: racedTarget.answerSetId,
      questionId: racedTarget.question.id,
      answer: {
        questionId: racedTarget.question.id,
        optionId: "bachata",
      },
      expectedContractRevisionId: raced.history.activeContractRevisionId,
      expectedContractSemanticHash:
        raced.history.activeContractSemanticHash,
      historyVersion: raced.history.historyVersion,
      idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "stale_guidance_history",
    });
    expect((await pool.query<{ status: string; phase: string }>(
      "SELECT status,phase FROM research_runs WHERE id=$1",
      [validWinner.runId],
    )).rows[0]).toMatchObject({
      status: "queued",
      phase: "queued",
    });
  }, 30_000);
});
