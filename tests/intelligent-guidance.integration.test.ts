import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  contractTwoGuidanceQuestion,
  GUIDANCE_POLICY_VERSION,
  guidanceQuestionSetHashV2,
} from "../server/guidance-contract-v2.ts";
import {
  createGuidanceDecisionV3,
  deterministicGuidanceCandidatesV3,
  flowNuanceGuidanceDecisionV3,
  playlistInterpretationSummaryV1,
  selectGuidanceRoundV3,
  SMOOTH_REGGAETON_HEAT_PROMPT,
} from "../server/adaptive-guidance-v3.ts";
import { publicGuidanceQuestionV3 } from "../server/adaptive-guidance-contract-bridge.ts";
import {
  AUTHENTICATED_OWNER_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
  PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
} from "../server/playlist-count-policy.ts";
import { compilePlaylistContractShadowV1 } from "../server/playlist-contract-shadow-bridge-v1.ts";
import { Repository } from "../server/repository.ts";
import { createSelectionPlanV2 } from "../server/selection-plan-v2.ts";
import {
  createRunSpecV3,
  selectionPlanV3Hash,
  type SelectionPlanV3,
} from "../server/selection-plan-v3.ts";
import { queryPlanV3Hash } from "../server/query-plan-v3.ts";
import { processBriefInterpretationJob } from "../server/research.ts";
import {
  submitBriefGuidanceAnswersV1,
} from "../server/brief-guidance-submission-v1.ts";
import { sha256Hex, stableStringify } from "../server/security.ts";
import {
  compilePlaylistContractRevisionV1,
  type PlaylistContractRevisionV1,
} from "../server/playlist-contract-v1.ts";
import type {
  PlaylistBrief,
  PlaylistGuidanceQuestion,
  QueryPlanV3,
} from "../shared/types.ts";

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

const smoothReggaetonBrief: PlaylistBrief = {
  title: "Smooth Reggaeton Heat",
  description: "A 50-track smooth reggaeton playlist centered on polished, sensual, danceable reggaeton and adjacent Latin urban tracks with a flirtatious, crowd-pleasing vibe.",
  mode: "curated",
  subjectEntities: ["reggaeton", "Latin urban"],
  relationship: "centered on reggaeton and adjacent Latin urban music",
  include: [
    "polished reggaeton",
    "sensual reggaeton",
    "danceable reggaeton",
    "adjacent Latin urban tracks",
    "flirtatious vibe",
    "crowd-pleasing club-friendly tracks",
  ],
  exclude: [],
  versionPolicy: "Prefer one canonical studio recording; exclude live recordings and remixes.",
  evidencePolicy: "Require track-scope editorial or authoritative metadata evidence.",
  orderingPolicy: "Use a smooth editorial flow with artists intermixed.",
  targetSize: { min: 50, max: 50 },
  ambiguities: [],
};

const ambiguousHouseBrief: PlaylistBrief = {
  title: "House playlist",
  description: "A focused playlist built around house.",
  mode: "curated",
  subjectEntities: ["house"],
  relationship: "matches the requested house scope",
  include: ["house recordings"],
  exclude: [],
  versionPolicy: "Prefer canonical studio recordings.",
  evidencePolicy: "Require track-specific evidence for the selected meaning.",
  orderingPolicy: "Use an editorial sequence.",
  targetSize: { min: 25, max: 25 },
  ambiguities: [],
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
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: "b".repeat(64),
      answers: [{ questionId: questions[0]!.id, optionId: "depth_obscure" }],
    });
    expect(stale).toMatchObject({ status: "stale_question_set", questionSetHash });

    const answerKey = randomUUID();
    await expect(repository.submitBriefAnswers({
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      briefRequestId: created.id,
      idempotencyKey: answerKey,
      questionSetHash,
      answers: [{ questionId: questions[0]!.id, optionId: "depth_obscure" }],
    })).resolves.toEqual({ status: "finalizing", created: true });
    await expect(repository.submitBriefAnswers({
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
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

  test("atomically persists Smooth Reggaeton contract-3 guidance and fences it to protocol 10", async () => {
    const clientBucket = `guidance-v3-${randomUUID()}`;
    const created = await repository.createBriefRequest({
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      requestedTrackCount: 50,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      briefContractVersion: 3,
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
    )).rows[0]?.minimum_worker_protocol).toBe(10);

    const selectionPlan = createSelectionPlanV2({
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      brief: smoothReggaetonBrief,
      storefront: "us",
    });
    const shadow = compilePlaylistContractShadowV1({
      contractId: `brief:${created.id}`,
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      brief: smoothReggaetonBrief,
      selectionPlan,
      locale: "en",
    });
    const persistedBase = await repository.savePlaylistContractRevision({
      briefRequestId: created.id,
      expectedParentRevisionId: null,
      contractHash: shadow.contract.semanticHash,
      contract: structuredClone(shadow.contract) as unknown as Record<string, unknown>,
      compilerVersion: shadow.contract.versions.compiler,
      ontologyVersion: shadow.contract.versions.ontology,
      evidencePolicyVersion: shadow.contract.versions.evidencePolicy,
      questionTemplateVersion: shadow.contract.versions.questionTemplates,
      catalogPolicyVersion: shadow.contract.versions.catalogPolicy,
      locale: shadow.contract.locale,
      storefront: shadow.contract.storefront,
      answerLineageHash: sha256Hex(stableStringify(shadow.contract.answerLineage)),
    });
    await repository.saveBriefSelectionPlan(created.id, selectionPlan);
    const feasibilityReport = {
      state: "unknown",
      contractRevisionId: shadow.contract.revisionId,
      targetTrackCount: 50,
      reason: "pre-guidance open-world inventory has not been measured",
    };
    const feasibilitySnapshot = await repository.savePlaylistFeasibilitySnapshot({
      contractRevisionId: persistedBase.id,
      phase: "initial",
      assessment: "unknown",
      targetCount: 50,
      observedQualifiedCount: 0,
      projectedLowerCount: null,
      projectedUpperCount: null,
      confidence: null,
      reportHash: sha256Hex(stableStringify(feasibilityReport)),
      report: feasibilityReport,
    });

    const candidates = deterministicGuidanceCandidatesV3({
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      baseContractRevisionId: shadow.contract.revisionId,
      baseContractSemanticHash: shadow.contract.semanticHash,
      preservedTrackPredicate: shadow.preservedTrackPredicate,
      ambiguousScopeClauseIds: shadow.ambiguousScopeClauseIds,
    });
    const round = selectGuidanceRoundV3({
      stage: "initial",
      requestShape: "curated",
      candidates,
    });
    const questions = round.decisions.map(publicGuidanceQuestionV3);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      question: "How far should “adjacent Latin urban” extend?",
      criticality: "required",
      allowCustom: false,
      options: expect.arrayContaining([
        expect.objectContaining({
          id: "reggaeton_dembow_latin_urban",
          recommended: true,
        }),
      ]),
    });
    const explicitConstraintHash = sha256Hex("smooth-reggaeton-hard-constraints");
    await repository.saveBriefResult(created.id, {
      status: "awaiting_answers",
      expectedStatus: "queued",
      brief: smoothReggaetonBrief,
      questions,
      guidanceTelemetry: {
        generationMode: "deterministic_critical",
        requestClassification: "critical_ambiguity",
        guidancePolicyVersion: "adaptive_guidance_v3",
        questionSetHash: round.roundHash,
        proposedQuestionCount: candidates.length,
        acceptedQuestionCount: questions.length,
        webSearchCalls: 0,
        validationIssues: [],
      },
      guidanceContract: {
        questionSetHash: round.roundHash,
        requestClassification: "critical_ambiguity",
        generationMode: "deterministic_critical",
        guidancePolicyVersion: "adaptive_guidance_v3",
        locale: "en",
        storefront: "us",
        targetTrackCount: 50,
        explicitConstraintHash,
        rejectedQuestionReasons: [],
        baseContractRevisionId: shadow.contract.revisionId,
        baseContractSemanticHash: shadow.contract.semanticHash,
        guidanceRound: "initial",
        trigger: "correctness",
        axis: "adjacent_latin_urban_scope",
        feasibilitySnapshotId: feasibilitySnapshot.id,
      },
    });

    const persistedQuestionSet = (await pool.query<{
      id: string;
      base_contract_revision_id: string;
      feasibility_snapshot_id: string;
      question_set_hash: string;
    }>(
      `SELECT id,base_contract_revision_id,feasibility_snapshot_id,question_set_hash
       FROM guidance_question_sets WHERE brief_request_id=$1 AND active`,
      [created.id],
    )).rows[0]!;
    expect(persistedQuestionSet).toMatchObject({
      base_contract_revision_id: persistedBase.id,
      feasibility_snapshot_id: feasibilitySnapshot.id,
      question_set_hash: round.roundHash,
    });
    await expect(repository.submitBriefAnswers({
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: round.roundHash,
      answers: [{
        questionId: questions[0]!.id,
        customText: "Use a different adjacent genre boundary",
      }],
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "invalid_guidance_answers",
    });

    const stale = await repository.submitBriefAnswers({
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: "f".repeat(64),
      answers: [{
        questionId: questions[0]!.id,
        optionId: "reggaeton_dembow_latin_urban",
      }],
    });
    expect(stale).toMatchObject({
      status: "stale_question_set",
      questionSetHash: round.roundHash,
      questions: [expect.objectContaining({ id: questions[0]!.id })],
    });

    await expect(repository.submitBriefAnswers({
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: round.roundHash,
      answers: [{
        questionId: questions[0]!.id,
        optionId: "reggaeton_dembow_latin_urban",
      }],
    })).resolves.toEqual({ status: "finalizing", created: true });

    const revisions = await pool.query<{
      id: string;
      revision: number;
      parent_revision_id: string | null;
      status: string;
      contract_json: PlaylistContractRevisionV1;
    }>(
      `SELECT id,revision,parent_revision_id,status,contract_json
       FROM playlist_contract_revisions
       WHERE brief_request_id=$1 ORDER BY revision`,
      [created.id],
    );
    expect(revisions.rows).toHaveLength(2);
    expect(revisions.rows[0]).toMatchObject({
      id: persistedBase.id,
      revision: 1,
      parent_revision_id: null,
      status: "superseded",
    });
    const successor = revisions.rows[1]!;
    expect(successor).toMatchObject({
      revision: 2,
      parent_revision_id: persistedBase.id,
      status: "active",
    });
    expect(successor.contract_json).toMatchObject({
      revision: 2,
      parentRevisionId: shadow.contract.revisionId,
      requestedTrackCount: 50,
      playlistConstraints: [{
        id: "quota:genre:core-reggaeton-share",
        minimumRatio: 0.7,
        maximumRatio: 1,
      }],
    });
    expect((await pool.query<{ invalidated: boolean }>(
      "SELECT invalidated_at IS NOT NULL invalidated FROM playlist_feasibility_snapshots WHERE id=$1",
      [feasibilitySnapshot.id],
    )).rows[0]?.invalidated).toBe(true);
    expect((await pool.query<{
      base_contract_revision_id: string;
      resulting_contract_revision_id: string;
    }>(
      `SELECT base_contract_revision_id,resulting_contract_revision_id
       FROM guidance_answer_sets WHERE question_set_id=$1`,
      [persistedQuestionSet.id],
    )).rows[0]).toEqual({
      base_contract_revision_id: persistedBase.id,
      resulting_contract_revision_id: successor.id,
    });

    await expect(repository.submitBriefAnswers({
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: round.roundHash,
      answers: [{
        questionId: questions[0]!.id,
        optionId: "core_reggaeton_only",
      }],
    })).rejects.toMatchObject({ statusCode: 409, code: "idempotency_conflict" });

    await repository.saveBriefResult(created.id, {
      status: "complete",
      expectedStatus: "finalizing",
      brief: smoothReggaetonBrief,
      estimateUsd: 0,
    });
    const run = await (async () => {
      const originalStorefront = process.env.APPLE_STOREFRONT;
      process.env.APPLE_STOREFRONT = "br";
      try {
        return await repository.createRunIdempotent({
          prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
          briefRequestId: created.id,
          brief: smoothReggaetonBrief,
          estimateUsd: 0,
          approvedBudgetUsd: 0,
          clientBucket,
          clientBucketAliases: [clientBucket],
          idempotencyKey: randomUUID(),
          reuseDays: 0,
          globalLimit: 100,
        });
      } finally {
        if (originalStorefront === undefined) delete process.env.APPLE_STOREFRONT;
        else process.env.APPLE_STOREFRONT = originalStorefront;
      }
    })();
    const authority = (await pool.query<{
      brief_contract_version: number;
      active_playlist_contract_revision_id: string;
      run_spec_contract_version: number;
      spec_storefront: string;
      spec_hash: string;
      spec_pipeline_version: string;
      spec_policy_version: string;
      selection_plan_hash: string;
      selection_plan_json: SelectionPlanV3;
      query_plan_hash: string;
      query_plan_json: QueryPlanV3;
    }>(
      `SELECT run.brief_contract_version,run.active_playlist_contract_revision_id,
              spec.brief_contract_version run_spec_contract_version,
              spec.storefront spec_storefront,spec.spec_hash,
              spec.pipeline_version spec_pipeline_version,
              spec.policy_version spec_policy_version,
              selection.plan_hash selection_plan_hash,
              selection.plan_json selection_plan_json,
              query.plan_hash query_plan_hash,
              query.plan_json query_plan_json
       FROM research_runs run
       JOIN run_specs spec ON spec.run_id=run.id
       JOIN selection_plans selection
         ON selection.run_id=run.id AND selection.status='active'
       JOIN run_active_query_plans active ON active.run_id=run.id
       JOIN query_plan_revisions query
         ON query.id=active.query_plan_revision_id
       WHERE run.id=$1`,
      [run.runId],
    )).rows[0];
    expect(authority).toMatchObject({
      brief_contract_version: 3,
      active_playlist_contract_revision_id: successor.id,
      run_spec_contract_version: 3,
      spec_storefront: successor.contract_json.storefront,
      selection_plan_json: {
        storefront: successor.contract_json.storefront,
      },
      query_plan_json: {
        storefront: successor.contract_json.storefront,
        selectionPlanHash: authority?.selection_plan_hash,
        playlistContractRevisionId: successor.contract_json.revisionId,
        playlistContractSemanticHash: successor.contract_json.semanticHash,
      },
    });
    expect(authority?.selection_plan_hash).toBe(
      selectionPlanV3Hash(authority!.selection_plan_json),
    );
    expect(authority?.query_plan_hash).toBe(
      queryPlanV3Hash(authority!.query_plan_json),
    );
    expect(authority?.spec_hash).toBe(sha256Hex(stableStringify({
      executionAuthority: "playlist_contract_revision_v1",
      briefContractVersion: 3,
      playlistContractRevisionId: successor.contract_json.revisionId,
      playlistContractSemanticHash: successor.contract_json.semanticHash,
      requestedTrackCount: successor.contract_json.requestedTrackCount,
      storefront: successor.contract_json.storefront,
      pipelineVersion: authority?.spec_pipeline_version,
      policyVersion: authority?.spec_policy_version,
    })));
  }, 50_000);

  test("keeps bare house blocking until its chosen typed delta becomes the active contract", async () => {
    const prompt = "Make me a 25-track house playlist";
    const clientBucket = `guidance-v3-house-${randomUUID()}`;
    const created = await repository.createBriefRequest({
      prompt,
      requestedTrackCount: 25,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      briefContractVersion: 3,
    });
    const selectionPlan = createSelectionPlanV2({
      prompt,
      brief: ambiguousHouseBrief,
      storefront: "us",
    });
    const shadow = compilePlaylistContractShadowV1({
      contractId: `brief:${created.id}`,
      prompt,
      brief: ambiguousHouseBrief,
      selectionPlan,
      locale: "en",
    });
    const persistedBase = await repository.savePlaylistContractRevision({
      briefRequestId: created.id,
      expectedParentRevisionId: null,
      contractHash: shadow.contract.semanticHash,
      contract: structuredClone(shadow.contract) as unknown as Record<string, unknown>,
      compilerVersion: shadow.contract.versions.compiler,
      ontologyVersion: shadow.contract.versions.ontology,
      evidencePolicyVersion: shadow.contract.versions.evidencePolicy,
      questionTemplateVersion: shadow.contract.versions.questionTemplates,
      catalogPolicyVersion: shadow.contract.versions.catalogPolicy,
      locale: shadow.contract.locale,
      storefront: shadow.contract.storefront,
      answerLineageHash: sha256Hex(stableStringify(
        shadow.contract.answerLineage,
      )),
    });
    await repository.saveBriefSelectionPlan(created.id, selectionPlan);
    const spec = createRunSpecV3({
      prompt,
      requestedTrackCount: 25,
      storefront: "us",
    });
    const candidates = deterministicGuidanceCandidatesV3({
      prompt,
      baseContractRevisionId: shadow.contract.revisionId,
      baseContractSemanticHash: shadow.contract.semanticHash,
      preservedTrackPredicate: shadow.preservedTrackPredicate,
      ambiguousScopeClauseIds: shadow.ambiguousScopeClauseIds,
      baseContract: shadow.contract,
      criticalAmbiguities: spec.criticalAmbiguities,
    });
    const round = selectGuidanceRoundV3({
      stage: "initial",
      requestShape: "curated",
      candidates,
    });
    const questions = round.decisions.map(publicGuidanceQuestionV3);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      id: "v3-critical:house_semantics",
      axis: "house_semantics",
      trigger: "correctness",
      criticality: "required",
    });
    await repository.saveBriefResult(created.id, {
      status: "awaiting_answers",
      expectedStatus: "queued",
      brief: ambiguousHouseBrief,
      questions,
      guidanceTelemetry: {
        generationMode: "deterministic_critical",
        requestClassification: "critical_ambiguity",
        guidancePolicyVersion: "adaptive_guidance_v3",
        questionSetHash: round.roundHash,
        proposedQuestionCount: candidates.length,
        acceptedQuestionCount: questions.length,
        webSearchCalls: 0,
        validationIssues: [],
      },
      guidanceContract: {
        questionSetHash: round.roundHash,
        requestClassification: "critical_ambiguity",
        generationMode: "deterministic_critical",
        guidancePolicyVersion: "adaptive_guidance_v3",
        locale: "en",
        storefront: "us",
        targetTrackCount: 25,
        explicitConstraintHash: spec.explicitUserConstraintHash,
        rejectedQuestionReasons: [],
        baseContractRevisionId: shadow.contract.revisionId,
        baseContractSemanticHash: shadow.contract.semanticHash,
        guidanceRound: "initial",
        trigger: "correctness",
        axis: "house_semantics",
      },
    });

    await expect(repository.submitBriefAnswers({
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: round.roundHash,
      answers: [],
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "invalid_guidance_answers",
    });
    expect(await repository.getBriefRequest(created.id)).toMatchObject({
      status: "awaiting_answers",
      questionSetHash: round.roundHash,
    });

    await expect(repository.submitBriefAnswers({
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: round.roundHash,
      answers: [{
        questionId: questions[0]!.id,
        optionId: "house_theme",
      }],
    })).resolves.toEqual({ status: "finalizing", created: true });

    const active = (await pool.query<{
      status: string;
      active_playlist_contract_revision_id: string;
      parent_revision_id: string;
      contract_json: PlaylistContractRevisionV1;
    }>(
      `SELECT brief.status,brief.active_playlist_contract_revision_id,
              contract.parent_revision_id,contract.contract_json
       FROM brief_requests brief
       JOIN playlist_contract_revisions contract
         ON contract.id=brief.active_playlist_contract_revision_id
       WHERE brief.id=$1`,
      [created.id],
    )).rows[0]!;
    expect(active).toMatchObject({
      status: "finalizing",
      parent_revision_id: persistedBase.id,
    });
    expect(active.active_playlist_contract_revision_id).not.toBe(
      persistedBase.id,
    );
    expect(active.contract_json.requestedTrackCount).toBe(25);
    expect(active.contract_json.clauses).toContainEqual(
      expect.objectContaining({
        id: "guidance:critical:house-semantics:theme",
        axis: "theme",
        hardness: "hard",
        values: ["houses and homes"],
      }),
    );
    expect(JSON.stringify(active.contract_json.trackPredicate)).toContain(
      "guidance:critical:house-semantics:theme",
    );
    expect(JSON.stringify(active.contract_json.trackPredicate)).not.toMatch(
      /bridge:constraint:[^"]*house/iu,
    );
    expect((await pool.query<{
      execution_delta_json: Array<{ op: string }>;
      resulting_contract_revision_id: string;
    }>(
      `SELECT execution_delta_json,resulting_contract_revision_id
       FROM guidance_answer_sets WHERE brief_request_id=$1`,
      [created.id],
    )).rows[0]).toMatchObject({
      execution_delta_json: expect.arrayContaining([
        expect.objectContaining({ op: "add_clause" }),
        expect.objectContaining({ op: "replace_track_predicate" }),
      ]),
      resulting_contract_revision_id:
        active.active_playlist_contract_revision_id,
    });
  }, 50_000);

  test("persists exact-artist ambiguity without mutation and applies the selected stable identity", async () => {
    const clientBucket = `guidance-v3-custom-${randomUUID()}`;
    const created = await repository.createBriefRequest({
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      requestedTrackCount: 50,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      briefContractVersion: 3,
    });
    const selectionPlan = createSelectionPlanV2({
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      brief: smoothReggaetonBrief,
      storefront: "us",
    });
    const shadow = compilePlaylistContractShadowV1({
      contractId: `brief:${created.id}`,
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      brief: smoothReggaetonBrief,
      selectionPlan,
      locale: "en",
    });
    const persistedBase = await repository.savePlaylistContractRevision({
      briefRequestId: created.id,
      expectedParentRevisionId: null,
      contractHash: shadow.contract.semanticHash,
      contract: structuredClone(shadow.contract) as unknown as Record<string, unknown>,
      compilerVersion: shadow.contract.versions.compiler,
      ontologyVersion: shadow.contract.versions.ontology,
      evidencePolicyVersion: shadow.contract.versions.evidencePolicy,
      questionTemplateVersion: shadow.contract.versions.questionTemplates,
      catalogPolicyVersion: shadow.contract.versions.catalogPolicy,
      locale: shadow.contract.locale,
      storefront: shadow.contract.storefront,
      answerLineageHash: sha256Hex(stableStringify(shadow.contract.answerLineage)),
    });
    await repository.saveBriefSelectionPlan(created.id, selectionPlan);
    const candidates = [flowNuanceGuidanceDecisionV3({
      prompt: "Create a listening journey.",
      baseContract: shadow.contract,
    })!];
    const round = selectGuidanceRoundV3({
      stage: "initial",
      requestShape: "curated",
      candidates,
    });
    const questions = round.decisions.map(publicGuidanceQuestionV3);
    await repository.saveBriefResult(created.id, {
      status: "awaiting_answers",
      expectedStatus: "queued",
      brief: smoothReggaetonBrief,
      questions,
      guidanceTelemetry: {
        generationMode: "deterministic_critical",
        requestClassification: "preference_ambiguity",
        guidancePolicyVersion: "adaptive_guidance_v3",
        questionSetHash: round.roundHash,
        proposedQuestionCount: 1,
        acceptedQuestionCount: 1,
        webSearchCalls: 0,
        validationIssues: [],
      },
      guidanceContract: {
        questionSetHash: round.roundHash,
        requestClassification: "preference_ambiguity",
        generationMode: "deterministic_critical",
        guidancePolicyVersion: "adaptive_guidance_v3",
        locale: "en",
        storefront: "us",
        targetTrackCount: 50,
        explicitConstraintHash: sha256Hex("custom-hard-rules"),
        rejectedQuestionReasons: [],
        baseContractRevisionId: shadow.contract.revisionId,
        baseContractSemanticHash: shadow.contract.semanticHash,
        guidanceRound: "initial",
        trigger: "nuance",
        axis: "playlist_flow",
      },
    });

    const customKey = randomUUID();
    const customAnswers = [{
      questionId: questions[0]!.id,
      customText: "mostly women, clean, no Bad Bunny",
    }];
    const resolveCustomArtistIdentities = vi.fn(async () => ({
      status: "needs_input" as const,
      reason: "artist_identity_ambiguous" as const,
      inputText: "Bad Bunny",
      candidates: [
        {
          catalogArtistId: "1126808565",
          displayName: "Bad Bunny",
          storefront: "us",
          genreNames: ["Latin"],
        },
        {
          catalogArtistId: "998877",
          displayName: "Bad Bunny",
          storefront: "us",
        },
      ],
    }));
    const customOutcome = await submitBriefGuidanceAnswersV1({
      customTexts: customAnswers.map(({ customText }) => customText),
      preflight: (customTrackCountAuthority) => (
        repository.preflightBriefAnswers({
          briefRequestId: created.id,
          idempotencyKey: customKey,
          questionSetHash: round.roundHash,
          answers: customAnswers,
          ...(customTrackCountAuthority
            ? { customTrackCountAuthority }
            : {}),
        })
      ),
      authorizeNewWork: async () => (
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1
      ),
      resolveCustomArtistIdentities,
      submit: async () => {
        throw new Error("ambiguous identity must not use resolved submission");
      },
      submitAmbiguity: ({ authority, ambiguity }) => (
        repository.submitBriefAnswers({
          customTrackCountAuthority: authority,
          briefRequestId: created.id,
          idempotencyKey: customKey,
          questionSetHash: round.roundHash,
          exactArtistIdentityAmbiguity: {
            inputText: ambiguity.inputText,
            candidates: ambiguity.candidates ?? [],
          },
          answers: customAnswers,
        })
      ),
    });
    if (customOutcome.status !== "submitted") {
      throw new Error("custom guidance service did not submit");
    }
    const custom = customOutcome.submission;
    expect(custom).toMatchObject({
      status: "awaiting_answers",
      created: true,
      questionSetHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      questions: [{
        axis: "exact_artist_identity",
        trigger: "correctness",
        criticality: "required",
        question:
          "Which Apple Music artist named “Bad Bunny” should be excluded?",
        interpretationSummary: {
          count: 50,
          avoid: ["No recordings by Bad Bunny"],
          mustHave: expect.arrayContaining([
            "Clean versions only",
            "At least 51% Tracks by women artists",
          ]),
        },
        options: [
          {
            id: "keep_current_interpretation",
            recommended: true,
          },
          expect.objectContaining({
            label: "Bad Bunny · 1126808565",
            recommended: false,
          }),
          expect.objectContaining({
            label: "Bad Bunny · 998877",
            recommended: false,
          }),
        ],
      }],
    });
    if (custom.status !== "awaiting_answers") throw new Error("confirmation question was not persisted");
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM playlist_contract_revisions WHERE brief_request_id=$1",
      [created.id],
    )).rows[0]?.count).toBe(1);
    const proposals = await pool.query<{
      question_set_id: string;
      question_set_hash: string;
      normalized_answers_json: Array<Record<string, unknown>>;
      raw_custom_answers_json: Array<Record<string, unknown>>;
      execution_delta_json: {
        schema: string;
        questionHash: string;
        options: Array<{
          optionId: string;
          operations: Array<Record<string, unknown>>;
        }>;
      };
      idempotency_key: string;
      base_contract_revision_id: string;
      resulting_contract_revision_id: string | null;
    }>(
      `SELECT question_set_id,question_set_hash,normalized_answers_json,
              raw_custom_answers_json,execution_delta_json,idempotency_key,
              base_contract_revision_id,resulting_contract_revision_id
       FROM guidance_answer_sets
       WHERE brief_request_id=$1
         AND execution_delta_json->>'schema'
           ='exact_artist_identity_ambiguity/v1'`,
      [created.id],
    );
    expect(proposals.rows).toHaveLength(1);
    expect(proposals.rows[0]).toMatchObject({
      question_set_hash: round.roundHash,
      normalized_answers_json: customAnswers,
      raw_custom_answers_json: customAnswers,
      execution_delta_json: {
        schema: "exact_artist_identity_ambiguity/v1",
        questionHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        options: expect.arrayContaining([
          expect.objectContaining({
            optionId: "keep_current_interpretation",
            operations: [],
          }),
          expect.objectContaining({
            operations: expect.arrayContaining([
              expect.objectContaining({
                op: "set_exact_artist_identity_exclusions",
              }),
            ]),
          }),
        ]),
      },
      idempotency_key: customKey,
      base_contract_revision_id: persistedBase.id,
      resulting_contract_revision_id: null,
    });
    expect(JSON.stringify(proposals.rows[0]!.execution_delta_json))
      .not.toContain(customAnswers[0]!.customText);
    expect((await pool.query<{ id: string }>(
      `SELECT id FROM playlist_contract_revisions
       WHERE brief_request_id=$1 AND status='active'`,
      [created.id],
    )).rows[0]?.id).toBe(persistedBase.id);
    expect((await pool.query<{
      active_playlist_contract_revision_id: string;
      active_guidance_question_set_id: string;
    }>(
      `SELECT active_playlist_contract_revision_id,
              active_guidance_question_set_id
       FROM brief_requests WHERE id=$1`,
      [created.id],
    )).rows[0]).toMatchObject({
      active_playlist_contract_revision_id: persistedBase.id,
      active_guidance_question_set_id: expect.any(String),
    });

    const lostResponseAuthorize = vi.fn();
    const lostResponseResolver = vi.fn();
    const lostResponse = await submitBriefGuidanceAnswersV1({
      customTexts: customAnswers.map(({ customText }) => customText),
      preflight: (customTrackCountAuthority) => (
        repository.preflightBriefAnswers({
          briefRequestId: created.id,
          idempotencyKey: customKey,
          questionSetHash: round.roundHash,
          answers: customAnswers,
          ...(customTrackCountAuthority
            ? { customTrackCountAuthority }
            : {}),
        })
      ),
      authorizeNewWork: lostResponseAuthorize,
      resolveCustomArtistIdentities: lostResponseResolver,
      submit: async () => {
        throw new Error("lost response must adopt the persisted child");
      },
    });
    expect(lostResponse).toEqual({
      status: "submitted",
      submission: {
        status: "awaiting_answers",
        created: false,
        questionSetHash: custom.questionSetHash,
        questions: custom.questions,
      },
    });
    expect(lostResponseAuthorize).not.toHaveBeenCalled();
    expect(lostResponseResolver).not.toHaveBeenCalled();
    await expect(repository.preflightBriefAnswers({
      briefRequestId: created.id,
      idempotencyKey: customKey,
      questionSetHash: round.roundHash,
      answers: [{
        questionId: questions[0]!.id,
        customText: "mostly women, clean, no Drake",
      }],
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "idempotency_conflict",
    });

    const staleTab = await repository.submitBriefAnswers({
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: round.roundHash,
      answers: [{
        questionId: questions[0]!.id,
        optionId: "smooth_arc",
      }],
    });
    expect(staleTab).toMatchObject({
      status: "stale_question_set",
      questionSetHash: custom.questionSetHash,
      questions: [{
        axis: "exact_artist_identity",
      }],
    });
    expect((await pool.query<{
      total: number;
      active: number;
      linked_children: number;
    }>(
      `SELECT count(*)::int total,
              count(*) FILTER (WHERE active)::int active,
              count(*) FILTER (
                WHERE parent_question_set_id=$2
                  AND base_contract_revision_id=$3
              )::int linked_children
       FROM guidance_question_sets WHERE brief_request_id=$1`,
      [
        created.id,
        proposals.rows[0]!.question_set_id,
        persistedBase.id,
      ],
    )).rows[0]).toEqual({
      total: 2,
      active: 1,
      linked_children: 1,
    });

    const selectedIdentityOption = custom.questions[0]!.options.find((option) => (
      option.label === "Bad Bunny · 1126808565"
    ));
    expect(selectedIdentityOption).toBeDefined();
    await expect(repository.submitBriefAnswers({
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: custom.questionSetHash,
      answers: [{
        questionId: custom.questions[0]!.id,
        optionId: selectedIdentityOption!.id,
      }],
    })).resolves.toEqual({ status: "finalizing", created: true });
    expect(resolveCustomArtistIdentities).toHaveBeenCalledTimes(1);

    const active = (await pool.query<{
      id: string;
      parent_revision_id: string;
      contract_json: PlaylistContractRevisionV1;
    }>(
      `SELECT id,parent_revision_id,contract_json
       FROM playlist_contract_revisions
       WHERE brief_request_id=$1 AND status='active'`,
      [created.id],
    )).rows[0]!;
    expect(active.parent_revision_id).toBe(persistedBase.id);
    expect(playlistInterpretationSummaryV1(active.contract_json)).toMatchObject({
      count: 50,
      avoid: ["No recordings by Bad Bunny"],
      mustHave: expect.arrayContaining([
        "Clean versions only",
        "At least 51% Tracks by women artists",
      ]),
    });
    expect(active.contract_json.executionDirectives
      ?.exactArtistIdentityExclusions).toMatchObject({
      bindings: [{
        catalogArtistId: "1126808565",
        displayName: "Bad Bunny",
        storefront: "us",
      }],
    });
    const questionSets = await pool.query<{
      revision: number;
      active: boolean;
      parent_question_set_id: string | null;
      trigger: string;
      axis: string | null;
    }>(
      `SELECT revision,active,parent_question_set_id,trigger,axis
       FROM guidance_question_sets
       WHERE brief_request_id=$1 ORDER BY revision`,
      [created.id],
    );
    expect(questionSets.rows).toEqual([
      {
        revision: 1,
        active: false,
        parent_question_set_id: null,
        trigger: "nuance",
        axis: "playlist_flow",
      },
      {
        revision: 2,
        active: true,
        parent_question_set_id: expect.any(String),
        trigger: "correctness",
        axis: "exact_artist_identity",
      },
    ]);
    const answerRows = await pool.query<{
      execution_delta_json:
        | Array<Record<string, unknown>>
        | { schema: string };
      resulting_contract_revision_id: string;
    }>(
      `SELECT execution_delta_json,resulting_contract_revision_id
       FROM guidance_answer_sets WHERE brief_request_id=$1
       ORDER BY accepted_at,id`,
      [created.id],
    );
    expect(answerRows.rows).toHaveLength(2);
    expect(answerRows.rows.find((row) => (
      Array.isArray(row.execution_delta_json)
    ))).toMatchObject({
      execution_delta_json: expect.arrayContaining([
        expect.objectContaining({
          op: "set_exact_artist_identity_exclusions",
        }),
      ]),
      resulting_contract_revision_id: active.id,
    });
    expect(answerRows.rows.find((row) => (
      !Array.isArray(row.execution_delta_json)
    ))).toMatchObject({
      execution_delta_json: {
        schema: "exact_artist_identity_ambiguity/v1",
      },
      resulting_contract_revision_id: active.id,
    });
  }, 50_000);

  test("finalizes an exact-artist ambiguity through the explicit keep-current no-op", async () => {
    const prompt = "Create 25 disco songs with an editorial flow.";
    const clientBucket = `guidance-v3-artist-noop-${randomUUID()}`;
    const created = await repository.createBriefRequest({
      prompt,
      requestedTrackCount: 25,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      briefContractVersion: 3,
    });
    const selectionPlan = createSelectionPlanV2({
      prompt,
      brief,
      storefront: "us",
    });
    const shadow = compilePlaylistContractShadowV1({
      contractId: `brief:${created.id}`,
      prompt,
      brief,
      selectionPlan,
      locale: "en",
    });
    const persistedBase = await repository.savePlaylistContractRevision({
      briefRequestId: created.id,
      expectedParentRevisionId: null,
      contractHash: shadow.contract.semanticHash,
      contract: structuredClone(shadow.contract) as unknown as Record<string, unknown>,
      compilerVersion: shadow.contract.versions.compiler,
      ontologyVersion: shadow.contract.versions.ontology,
      evidencePolicyVersion: shadow.contract.versions.evidencePolicy,
      questionTemplateVersion: shadow.contract.versions.questionTemplates,
      catalogPolicyVersion: shadow.contract.versions.catalogPolicy,
      locale: shadow.contract.locale,
      storefront: shadow.contract.storefront,
      answerLineageHash: sha256Hex(stableStringify(
        shadow.contract.answerLineage,
      )),
    });
    await repository.saveBriefSelectionPlan(created.id, selectionPlan);
    const decision = flowNuanceGuidanceDecisionV3({
      prompt: "Create a listening journey.",
      baseContract: shadow.contract,
    })!;
    const round = selectGuidanceRoundV3({
      stage: "initial",
      requestShape: "curated",
      candidates: [decision],
    });
    const questions = round.decisions.map(publicGuidanceQuestionV3);
    await repository.saveBriefResult(created.id, {
      status: "awaiting_answers",
      expectedStatus: "queued",
      brief,
      questions,
      guidanceTelemetry: {
        generationMode: "deterministic_critical",
        requestClassification: "preference_ambiguity",
        guidancePolicyVersion: "adaptive_guidance_v3",
        questionSetHash: round.roundHash,
        proposedQuestionCount: 1,
        acceptedQuestionCount: 1,
        webSearchCalls: 0,
        validationIssues: [],
      },
      guidanceContract: {
        questionSetHash: round.roundHash,
        requestClassification: "preference_ambiguity",
        generationMode: "deterministic_critical",
        guidancePolicyVersion: "adaptive_guidance_v3",
        locale: "en",
        storefront: "us",
        targetTrackCount: 25,
        explicitConstraintHash: sha256Hex("artist-noop"),
        rejectedQuestionReasons: [],
        baseContractRevisionId: shadow.contract.revisionId,
        baseContractSemanticHash: shadow.contract.semanticHash,
        guidanceRound: "initial",
        trigger: "nuance",
        axis: "playlist_flow",
      },
    });
    const customAnswers = [{
      questionId: questions[0]!.id,
      customText: "no Bad Bunny",
    }];
    const ambiguity = await repository.submitBriefAnswers({
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: round.roundHash,
      answers: customAnswers,
      exactArtistIdentityAmbiguity: {
        inputText: "Bad Bunny",
        candidates: [
          {
            catalogArtistId: "1126808565",
            displayName: "Bad Bunny",
            storefront: "us",
          },
          {
            catalogArtistId: "998877",
            displayName: "Bad Bunny",
            storefront: "us",
          },
        ],
      },
    });
    if (ambiguity.status !== "awaiting_answers") {
      throw new Error("artist ambiguity child was not created");
    }
    const keep = ambiguity.questions[0]!.options.find((option) => (
      option.id === "keep_current_interpretation"
    ));
    expect(keep).toMatchObject({ recommended: true });
    const stableProfile = ambiguity.questions[0]!.options.find((option) => (
      option.id !== "keep_current_interpretation"
    ));
    expect(stableProfile).toBeDefined();
    const proposal = (await pool.query<{
      id: string;
      question_set_id: string;
      question_set_hash: string;
      normalized_answers_json: Array<Record<string, unknown>>;
      raw_custom_answers_json: Array<Record<string, unknown>>;
      answer_hash: string;
      execution_delta_json: Record<string, unknown>;
      execution_delta_hash: string;
      idempotency_key: string;
      base_contract_revision_id: string;
    }>(
      `SELECT id,question_set_id,question_set_hash,
              normalized_answers_json,raw_custom_answers_json,answer_hash,
              execution_delta_json,execution_delta_hash,idempotency_key,
              base_contract_revision_id
       FROM guidance_answer_sets
       WHERE brief_request_id=$1
         AND execution_delta_json->>'schema'
           ='exact_artist_identity_ambiguity/v1'`,
      [created.id],
    )).rows[0]!;
    const stableAnswer = [{
      questionId: ambiguity.questions[0]!.id,
      optionId: stableProfile!.id,
    }];
    await pool.query(
      "DELETE FROM guidance_answer_sets WHERE id=$1",
      [proposal.id],
    );
    await expect(repository.submitBriefAnswers({
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: ambiguity.questionSetHash,
      answers: stableAnswer,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "guidance_history_integrity",
    });
    expect((await pool.query<{
      contract_count: number;
      status: string;
      active_contract: string;
      answer_count: number;
    }>(
      `SELECT (
         SELECT count(*)::int FROM playlist_contract_revisions
         WHERE brief_request_id=$1
       ) contract_count,status,
       active_playlist_contract_revision_id active_contract,(
         SELECT count(*)::int FROM guidance_answer_sets
         WHERE brief_request_id=$1
       ) answer_count
       FROM brief_requests WHERE id=$1`,
      [created.id],
    )).rows[0]).toEqual({
      contract_count: 1,
      status: "awaiting_answers",
      active_contract: persistedBase.id,
      answer_count: 0,
    });
    await pool.query(
      `INSERT INTO guidance_answer_sets(
         id,brief_request_id,question_set_id,question_set_hash,
         normalized_answers_json,raw_custom_answers_json,answer_hash,
         execution_delta_json,execution_delta_hash,idempotency_key,
         base_contract_revision_id)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9,$10,$11)`,
      [
        proposal.id,
        created.id,
        proposal.question_set_id,
        proposal.question_set_hash,
        JSON.stringify(proposal.normalized_answers_json),
        JSON.stringify(proposal.raw_custom_answers_json),
        proposal.answer_hash,
        JSON.stringify(proposal.execution_delta_json),
        proposal.execution_delta_hash,
        proposal.idempotency_key,
        proposal.base_contract_revision_id,
      ],
    );
    const duplicateProposalId = randomUUID();
    await pool.query(
      `INSERT INTO guidance_answer_sets(
         id,brief_request_id,question_set_id,question_set_hash,
         normalized_answers_json,raw_custom_answers_json,answer_hash,
         execution_delta_json,execution_delta_hash,idempotency_key,
         base_contract_revision_id)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9,$10,$11)`,
      [
        duplicateProposalId,
        created.id,
        proposal.question_set_id,
        proposal.question_set_hash,
        JSON.stringify(proposal.normalized_answers_json),
        JSON.stringify(proposal.raw_custom_answers_json),
        sha256Hex(`duplicate-proposal:${created.id}`),
        JSON.stringify(proposal.execution_delta_json),
        proposal.execution_delta_hash,
        randomUUID(),
        proposal.base_contract_revision_id,
      ],
    );
    await expect(repository.submitBriefAnswers({
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: ambiguity.questionSetHash,
      answers: stableAnswer,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "guidance_history_integrity",
    });
    expect((await pool.query<{
      contract_count: number;
      active_contract: string;
      answer_count: number;
    }>(
      `SELECT (
         SELECT count(*)::int FROM playlist_contract_revisions
         WHERE brief_request_id=$1
       ) contract_count,active_playlist_contract_revision_id active_contract,(
         SELECT count(*)::int FROM guidance_answer_sets
         WHERE brief_request_id=$1
       ) answer_count
       FROM brief_requests WHERE id=$1`,
      [created.id],
    )).rows[0]).toEqual({
      contract_count: 1,
      active_contract: persistedBase.id,
      answer_count: 2,
    });
    await pool.query(
      "DELETE FROM guidance_answer_sets WHERE id=$1",
      [duplicateProposalId],
    );
    await expect(repository.submitBriefAnswers({
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: ambiguity.questionSetHash,
      answers: [{
        questionId: ambiguity.questions[0]!.id,
        optionId: keep!.id,
      }],
    })).resolves.toEqual({ status: "finalizing", created: true });

    expect((await pool.query<{
      contract_count: number;
      active_contract: string;
    }>(
      `SELECT (
         SELECT count(*)::int FROM playlist_contract_revisions
         WHERE brief_request_id=$1
       ) contract_count,active_playlist_contract_revision_id active_contract
       FROM brief_requests WHERE id=$1`,
      [created.id],
    )).rows[0]).toEqual({
      contract_count: 1,
      active_contract: persistedBase.id,
    });
    const rows = await pool.query<{
      execution_delta_json:
        | Array<Record<string, unknown>>
        | { schema: string };
      resulting_contract_revision_id: string;
    }>(
      `SELECT execution_delta_json,resulting_contract_revision_id
       FROM guidance_answer_sets WHERE brief_request_id=$1
       ORDER BY accepted_at,id`,
      [created.id],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((row) => (
      row.resulting_contract_revision_id === persistedBase.id
    ))).toBe(true);
    expect(rows.rows.find((row) => (
      Array.isArray(row.execution_delta_json)
    ))?.execution_delta_json).toEqual([]);

    await processBriefInterpretationJob(repository, {
      briefRequestId: created.id,
    });
    expect(await repository.getBriefRequest(created.id)).toMatchObject({
      status: "complete",
      brief: {
        targetSize: { min: 25, max: 25 },
      },
      selectionPlan: {
        requestedTrackCount: 25,
      },
    });
  }, 50_000);

  test("rejects a custom exclusion that conflicts with an existing required artist without mutating guidance", async () => {
    const clientBucket = `guidance-v3-custom-conflict-${randomUUID()}`;
    const requestBrief: PlaylistBrief = {
      title: "Bad Bunny only",
      description: "A reggaeton playlist containing only Bad Bunny recordings.",
      mode: "curated",
      subjectEntities: ["Bad Bunny", "reggaeton"],
      relationship: "is a reggaeton recording by Bad Bunny",
      include: ["Only recordings by Bad Bunny"],
      exclude: [],
      versionPolicy: "Prefer canonical studio recordings.",
      evidencePolicy: "Require authoritative artist identity and genre evidence.",
      orderingPolicy: "Use an editorial flow.",
      targetSize: { min: 20, max: 20 },
      ambiguities: [],
    };
    const prompt = "Make 20 reggaeton tracks only by Bad Bunny.";
    const created = await repository.createBriefRequest({
      prompt,
      requestedTrackCount: 20,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      briefContractVersion: 3,
    });
    const contract = compilePlaylistContractRevisionV1({
      contractId: `brief:${created.id}`,
      rawPrompt: prompt,
      requestedTrackCount: 20,
      locale: "en",
      storefront: "us",
      clauses: [
        {
          id: "prompt:genre:reggaeton",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "genre",
          operator: "require",
          values: ["reggaeton"],
          source: { provenance: "prompt", text: "reggaeton" },
        },
        {
          id: "prompt:artist:bad-bunny",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "artist",
          operator: "require",
          values: ["Bad Bunny"],
          source: { provenance: "prompt", text: "only by Bad Bunny" },
        },
      ],
      trackPredicate: {
        op: "all",
        children: [
          { op: "clause", clauseId: "prompt:genre:reggaeton" },
          { op: "clause", clauseId: "prompt:artist:bad-bunny" },
        ],
      },
    });
    const persisted = await repository.savePlaylistContractRevision({
      briefRequestId: created.id,
      expectedParentRevisionId: null,
      contractHash: contract.semanticHash,
      contract: structuredClone(contract) as unknown as Record<string, unknown>,
      compilerVersion: contract.versions.compiler,
      ontologyVersion: contract.versions.ontology,
      evidencePolicyVersion: contract.versions.evidencePolicy,
      questionTemplateVersion: contract.versions.questionTemplates,
      catalogPolicyVersion: contract.versions.catalogPolicy,
      locale: contract.locale,
      storefront: contract.storefront,
      answerLineageHash: sha256Hex(stableStringify(contract.answerLineage)),
    });
    await repository.saveBriefSelectionPlan(created.id, createSelectionPlanV2({
      prompt,
      brief: requestBrief,
      storefront: "us",
    }));

    const decision = createGuidanceDecisionV3({
      id: "guidance:acceptance:custom-conflict",
      header: "Optional revision",
      question: "Would you like to revise the exact count?",
      axis: "count_revision",
      trigger: "nuance",
      criticality: "optional",
      selectionMode: "single",
      allowCustom: true,
      baseContractRevisionId: contract.revisionId,
      baseContractSemanticHash: contract.semanticHash,
      whyMaterial: "A custom answer is recompiled as a typed successor before execution.",
      allowedPatchOperations: ["set_requested_track_count"],
      affectedClauseIds: [],
      materialityScore: 25,
      options: [
        {
          id: "keep_current_interpretation",
          label: "Keep 20",
          description: "Keep the exact requested count.",
          recommended: true,
          expectedFeasibilityDirection: "neutral",
          patch: { operations: [], affectedClauseIds: [] },
        },
        {
          id: "revise_to_25",
          label: "Use 25",
          description: "Create a new revision requesting exactly 25 tracks.",
          recommended: false,
          expectedFeasibilityDirection: "narrower",
          patch: {
            operations: [{ op: "set_requested_track_count", count: 25 }],
            affectedClauseIds: [],
          },
        },
      ],
    });
    const round = selectGuidanceRoundV3({
      stage: "initial",
      requestShape: "curated",
      candidates: [decision],
    });
    const questions = round.decisions.map(publicGuidanceQuestionV3);
    await repository.saveBriefResult(created.id, {
      status: "awaiting_answers",
      expectedStatus: "queued",
      brief: requestBrief,
      questions,
      guidanceTelemetry: {
        generationMode: "deterministic_critical",
        requestClassification: "preference_ambiguity",
        guidancePolicyVersion: "adaptive_guidance_v3",
        questionSetHash: round.roundHash,
        proposedQuestionCount: 1,
        acceptedQuestionCount: 1,
        webSearchCalls: 0,
        validationIssues: [],
      },
      guidanceContract: {
        questionSetHash: round.roundHash,
        requestClassification: "preference_ambiguity",
        generationMode: "deterministic_critical",
        guidancePolicyVersion: "adaptive_guidance_v3",
        locale: "en",
        storefront: "us",
        targetTrackCount: 20,
        explicitConstraintHash: sha256Hex("required-bad-bunny"),
        rejectedQuestionReasons: [],
        baseContractRevisionId: contract.revisionId,
        baseContractSemanticHash: contract.semanticHash,
        guidanceRound: "initial",
        trigger: "nuance",
        axis: "count_revision",
      },
    });

    await expect(repository.submitBriefAnswers({
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: round.roundHash,
      resolvedExactArtistIdentities: [{
        inputText: "Bad Bunny",
        catalogArtistId: "1126808565",
        displayName: "Bad Bunny",
        storefront: "us",
      }],
      answers: [{
        questionId: questions[0]!.id,
        customText: "No Bad Bunny",
      }],
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "custom_guidance_conflicts_with_existing_hard_predicate",
      message: "That custom answer conflicts with an existing required playlist rule. Review the interpretation before changing either rule.",
    });

    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM guidance_answer_sets WHERE brief_request_id=$1",
      [created.id],
    )).rows[0]?.count).toBe(0);
    expect((await pool.query<{
      active_playlist_contract_revision_id: string;
      active_guidance_question_set_id: string;
      status: string;
    }>(
      `SELECT active_playlist_contract_revision_id,active_guidance_question_set_id,status
       FROM brief_requests WHERE id=$1`,
      [created.id],
    )).rows[0]).toMatchObject({
      active_playlist_contract_revision_id: persisted.id,
      active_guidance_question_set_id: expect.any(String),
      status: "awaiting_answers",
    });
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM playlist_contract_revisions WHERE brief_request_id=$1",
      [created.id],
    )).rows[0]?.count).toBe(1);
  }, 50_000);

  test.each([
    [
      "public",
      300,
      PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
    ],
    [
      "activated owner",
      1_000,
      AUTHENTICATED_OWNER_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
    ],
  ] as const)(
    "makes a confirmed %s custom count successor authoritative without erasing the submitted count",
    async (_authorityLabel, customCount, customTrackCountAuthority) => {
    const clientBucket = `guidance-v3-custom-count-${randomUUID()}`;
    const prompt = "Make 20 disco tracks.";
    const originalBrief: PlaylistBrief = {
      title: "20 Disco Tracks",
      description: "A documented disco playlist.",
      mode: "curated",
      subjectEntities: ["disco"],
      relationship: "genre membership",
      include: ["disco recordings"],
      exclude: [],
      versionPolicy: "Prefer canonical studio recordings.",
      evidencePolicy: "Require documented genre evidence.",
      orderingPolicy: "Use an editorial sequence.",
      targetSize: { min: 20, max: 20 },
      ambiguities: [],
    };
    const created = await repository.createBriefRequest({
      prompt,
      requestedTrackCount: 20,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      briefContractVersion: 3,
    });
    const baseContract = compilePlaylistContractRevisionV1({
      contractId: `brief:${created.id}`,
      rawPrompt: prompt,
      requestedTrackCount: 20,
      locale: "en",
      storefront: "us",
      clauses: [{
        id: "prompt:genre:disco",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "genre",
        operator: "require",
        values: ["disco"],
        source: { provenance: "prompt", text: "disco" },
      }],
      trackPredicate: { op: "clause", clauseId: "prompt:genre:disco" },
    });
    const persistedBase = await repository.savePlaylistContractRevision({
      briefRequestId: created.id,
      expectedParentRevisionId: null,
      contractHash: baseContract.semanticHash,
      contract: structuredClone(baseContract) as unknown as Record<string, unknown>,
      compilerVersion: baseContract.versions.compiler,
      ontologyVersion: baseContract.versions.ontology,
      evidencePolicyVersion: baseContract.versions.evidencePolicy,
      questionTemplateVersion: baseContract.versions.questionTemplates,
      catalogPolicyVersion: baseContract.versions.catalogPolicy,
      locale: baseContract.locale,
      storefront: baseContract.storefront,
      answerLineageHash: sha256Hex(stableStringify(baseContract.answerLineage)),
    });
    const originalPlan = createSelectionPlanV2({
      prompt,
      brief: originalBrief,
      storefront: "us",
    });
    await repository.saveBriefSelectionPlan(created.id, originalPlan);

    const countDecision = createGuidanceDecisionV3({
      id: "guidance:test:custom-count",
      header: "Playlist count",
      question: "Would you like to revise the exact count?",
      axis: "count_revision",
      trigger: "nuance",
      criticality: "optional",
      selectionMode: "single",
      allowCustom: true,
      baseContractRevisionId: baseContract.revisionId,
      baseContractSemanticHash: baseContract.semanticHash,
      whyMaterial: "A different exact count creates a successor contract.",
      allowedPatchOperations: ["set_requested_track_count"],
      affectedClauseIds: [],
      materialityScore: 40,
      options: [{
        id: "keep_current_interpretation",
        label: "Keep 20",
        description: "Keep exactly 20 tracks.",
        recommended: true,
        expectedFeasibilityDirection: "neutral",
        patch: { operations: [], affectedClauseIds: [] },
      }, {
        id: `use_${customCount}`,
        label: `Use ${customCount}`,
        description: `Create a successor requesting exactly ${customCount} tracks.`,
        recommended: false,
        expectedFeasibilityDirection: "narrower",
        patch: {
          operations: [{
            op: "set_requested_track_count",
            count: customCount,
          }],
          affectedClauseIds: [],
        },
      }],
    });
    const round = selectGuidanceRoundV3({
      stage: "initial",
      requestShape: "curated",
      candidates: [countDecision],
    });
    const questions = round.decisions.map(publicGuidanceQuestionV3);
    await repository.saveBriefResult(created.id, {
      status: "awaiting_answers",
      expectedStatus: "queued",
      brief: originalBrief,
      questions,
      guidanceTelemetry: {
        generationMode: "deterministic_critical",
        requestClassification: "preference_ambiguity",
        guidancePolicyVersion: "adaptive_guidance_v3",
        questionSetHash: round.roundHash,
        proposedQuestionCount: 1,
        acceptedQuestionCount: 1,
        webSearchCalls: 0,
        validationIssues: [],
      },
      guidanceContract: {
        questionSetHash: round.roundHash,
        requestClassification: "preference_ambiguity",
        generationMode: "deterministic_critical",
        guidancePolicyVersion: "adaptive_guidance_v3",
        locale: "en",
        storefront: "us",
        targetTrackCount: 20,
        explicitConstraintHash: sha256Hex("custom-count-authority"),
        rejectedQuestionReasons: [],
        baseContractRevisionId: baseContract.revisionId,
        baseContractSemanticHash: baseContract.semanticHash,
        guidanceRound: "initial",
        trigger: "nuance",
        axis: "count_revision",
      },
    });

    for (const disallowedPublicCount of [301, 999, 1_000, 1_001]) {
      await expect(repository.submitBriefAnswers({
        customTrackCountAuthority:
          PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
        briefRequestId: created.id,
        idempotencyKey: randomUUID(),
        questionSetHash: round.roundHash,
        answers: [{
          questionId: questions[0]!.id,
          customText: `${disallowedPublicCount} tracks with smooth flow`,
        }],
      })).rejects.toMatchObject({
        statusCode: 400,
        code: "invalid_track_count",
      });
    }

    const confirmation = await repository.submitBriefAnswers({
      customTrackCountAuthority,
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: round.roundHash,
      answers: [{
        questionId: questions[0]!.id,
        customText: `${customCount} tracks`,
      }],
    });
    if (confirmation.status !== "awaiting_answers") {
      throw new Error("custom count confirmation was not persisted");
    }
    await expect(repository.submitBriefAnswers({
      customTrackCountAuthority,
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: round.roundHash,
      answers: [{
        questionId: questions[0]!.id,
        customText: `${customCount} tracks`,
      }],
    })).resolves.toMatchObject({
      status: "stale_question_set",
      questionSetHash: confirmation.questionSetHash,
    });
    const confirmationKey = randomUUID();
    const confirmationAnswer = [{
      questionId: confirmation.questions[0]!.id,
      optionId: "apply_revised_interpretation",
    }];
    if (customCount > 300) {
      await expect(repository.submitBriefAnswers({
        customTrackCountAuthority:
          PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
        briefRequestId: created.id,
        idempotencyKey: confirmationKey,
        questionSetHash: confirmation.questionSetHash,
        answers: confirmationAnswer,
      })).rejects.toMatchObject({
        statusCode: 400,
        code: "invalid_track_count",
      });
    }
    await expect(repository.submitBriefAnswers({
      customTrackCountAuthority,
      briefRequestId: created.id,
      idempotencyKey: confirmationKey,
      questionSetHash: confirmation.questionSetHash,
      answers: confirmationAnswer,
    })).resolves.toEqual({ status: "finalizing", created: true });
    await expect(repository.submitBriefAnswers({
      customTrackCountAuthority,
      briefRequestId: created.id,
      idempotencyKey: confirmationKey,
      questionSetHash: confirmation.questionSetHash,
      answers: confirmationAnswer,
    })).resolves.toEqual({ status: "finalizing", created: false });
    if (customCount > 300) {
      await expect(repository.submitBriefAnswers({
        customTrackCountAuthority:
          PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
        briefRequestId: created.id,
        idempotencyKey: confirmationKey,
        questionSetHash: confirmation.questionSetHash,
        answers: confirmationAnswer,
      })).resolves.toEqual({ status: "finalizing", created: false });
    }

    expect(await repository.getBriefRequest(created.id)).toMatchObject({
      status: "finalizing",
      requestedTrackCount: 20,
      originalRequestedTrackCount: 20,
      executionRequestedTrackCount: customCount,
      brief: { targetSize: { min: 20, max: 20 } },
    });
    const successor = (await pool.query<{
      id: string;
      parent_revision_id: string;
      contract_json: PlaylistContractRevisionV1;
    }>(
      `SELECT id,parent_revision_id,contract_json
       FROM playlist_contract_revisions
       WHERE brief_request_id=$1 AND status='active'`,
      [created.id],
    )).rows[0]!;
    expect(successor).toMatchObject({
      parent_revision_id: persistedBase.id,
      contract_json: {
        requestedTrackCount: customCount,
        parentRevisionId: baseContract.revisionId,
      },
    });
    expect((await pool.query<{ requested_track_count: number }>(
      "SELECT requested_track_count FROM brief_requests WHERE id=$1",
      [created.id],
    )).rows[0]?.requested_track_count).toBe(20);

    await processBriefInterpretationJob(repository, {
      briefRequestId: created.id,
    });
    expect(await repository.getBriefRequest(created.id)).toMatchObject({
      status: "complete",
      requestedTrackCount: 20,
      originalRequestedTrackCount: 20,
      executionRequestedTrackCount: customCount,
      brief: { targetSize: { min: customCount, max: customCount } },
      selectionPlan: {
        requestedTrackCount: customCount,
        minimumQualifiedTrackCount: customCount,
      },
    });

    // Simulate a rolling-overlap API that left the pre-revision plan behind.
    // Run creation must repair it from the locked active contract, not reject
    // the confirmed successor or reinterpret the raw prompt.
    await pool.query(
      "UPDATE brief_requests SET selection_plan_json=$2::jsonb WHERE id=$1",
      [created.id, JSON.stringify(originalPlan)],
    );
    const runKey = randomUUID();
    const runInput = {
      prompt,
      briefRequestId: created.id,
      brief: originalBrief,
      estimateUsd: 0,
      approvedBudgetUsd: 0,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: runKey,
      autoPublish: false,
      reuseDays: 0,
      globalLimit: 100,
    };
    const run = await repository.createRunIdempotent(runInput);
    const authority = (await pool.query<{
      submitted_count: number;
      active_plan_count: number;
      run_brief_count: number;
      spec_count: number;
      selection_count: number;
      query_count: number;
      active_contract_revision_id: string;
    }>(
      `SELECT brief.requested_track_count submitted_count,
              (brief.selection_plan_json->>'requestedTrackCount')::int active_plan_count,
              (run.brief_json #>> '{targetSize,min}')::int run_brief_count,
              spec.requested_track_count spec_count,
              (selection.plan_json->>'requestedTrackCount')::int selection_count,
              (query.plan_json->>'targetTrackCount')::int query_count,
              run.active_playlist_contract_revision_id active_contract_revision_id
       FROM brief_requests brief
       JOIN research_runs run ON run.id=$2
       JOIN run_specs spec ON spec.run_id=run.id
       JOIN selection_plans selection ON selection.run_id=run.id AND selection.status='active'
       JOIN run_active_query_plans active_query ON active_query.run_id=run.id
       JOIN query_plan_revisions query ON query.id=active_query.query_plan_revision_id
       WHERE brief.id=$1`,
      [created.id, run.runId],
    )).rows[0]!;
    expect(authority).toEqual({
      submitted_count: 20,
      active_plan_count: customCount,
      run_brief_count: customCount,
      spec_count: customCount,
      selection_count: customCount,
      query_count: customCount,
      active_contract_revision_id: successor.id,
    });
    await expect(pool.query(
      "UPDATE run_specs SET requested_track_count=20 WHERE run_id=$1",
      [run.runId],
    )).rejects.toThrow(/immutable/iu);
    await expect(repository.createRunIdempotent(runInput)).resolves.toMatchObject({
      runId: run.runId,
      created: false,
    });
    await expect(repository.createRunIdempotent({
      ...runInput,
      autoPublish: true,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "idempotency_conflict",
    });
    },
    90_000,
  );

  test("keeps the current interpretation as an idempotent no-op after custom-answer confirmation", async () => {
    const clientBucket = `guidance-v3-custom-keep-${randomUUID()}`;
    const created = await repository.createBriefRequest({
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      requestedTrackCount: 50,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      briefContractVersion: 3,
    });
    const selectionPlan = createSelectionPlanV2({
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      brief: smoothReggaetonBrief,
      storefront: "us",
    });
    const shadow = compilePlaylistContractShadowV1({
      contractId: `brief:${created.id}`,
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      brief: smoothReggaetonBrief,
      selectionPlan,
      locale: "en",
    });
    const persistedBase = await repository.savePlaylistContractRevision({
      briefRequestId: created.id,
      expectedParentRevisionId: null,
      contractHash: shadow.contract.semanticHash,
      contract: structuredClone(shadow.contract) as unknown as Record<string, unknown>,
      compilerVersion: shadow.contract.versions.compiler,
      ontologyVersion: shadow.contract.versions.ontology,
      evidencePolicyVersion: shadow.contract.versions.evidencePolicy,
      questionTemplateVersion: shadow.contract.versions.questionTemplates,
      catalogPolicyVersion: shadow.contract.versions.catalogPolicy,
      locale: shadow.contract.locale,
      storefront: shadow.contract.storefront,
      answerLineageHash: sha256Hex(stableStringify(shadow.contract.answerLineage)),
    });
    await repository.saveBriefSelectionPlan(created.id, selectionPlan);
    const round = selectGuidanceRoundV3({
      stage: "initial",
      requestShape: "curated",
      candidates: [flowNuanceGuidanceDecisionV3({
        prompt: "Create a listening journey.",
        baseContract: shadow.contract,
      })!],
    });
    const questions = round.decisions.map(publicGuidanceQuestionV3);
    await repository.saveBriefResult(created.id, {
      status: "awaiting_answers",
      expectedStatus: "queued",
      brief: smoothReggaetonBrief,
      questions,
      guidanceTelemetry: {
        generationMode: "deterministic_critical",
        requestClassification: "preference_ambiguity",
        guidancePolicyVersion: "adaptive_guidance_v3",
        questionSetHash: round.roundHash,
        proposedQuestionCount: 1,
        acceptedQuestionCount: 1,
        webSearchCalls: 0,
        validationIssues: [],
      },
      guidanceContract: {
        questionSetHash: round.roundHash,
        requestClassification: "preference_ambiguity",
        generationMode: "deterministic_critical",
        guidancePolicyVersion: "adaptive_guidance_v3",
        locale: "en",
        storefront: "us",
        targetTrackCount: 50,
        explicitConstraintHash: sha256Hex("custom-hard-rules-keep"),
        rejectedQuestionReasons: [],
        baseContractRevisionId: shadow.contract.revisionId,
        baseContractSemanticHash: shadow.contract.semanticHash,
        guidanceRound: "initial",
        trigger: "nuance",
        axis: "playlist_flow",
      },
    });

    const confirmation = await repository.submitBriefAnswers({
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: round.roundHash,
      resolvedExactArtistIdentities: [{
        inputText: "Bad Bunny",
        catalogArtistId: "1126808565",
        displayName: "Bad Bunny",
        storefront: "us",
      }],
      answers: [{
        questionId: questions[0]!.id,
        customText: "mostly women, clean, no Bad Bunny",
      }],
    });
    if (confirmation.status !== "awaiting_answers") {
      throw new Error("confirmation question was not persisted");
    }
    const keepKey = randomUUID();
    const keepAnswer = [{
      questionId: confirmation.questions[0]!.id,
      optionId: "keep_current_interpretation",
    }];
    await expect(repository.submitBriefAnswers({
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      briefRequestId: created.id,
      idempotencyKey: keepKey,
      questionSetHash: confirmation.questionSetHash,
      answers: keepAnswer,
    })).resolves.toEqual({ status: "finalizing", created: true });
    await expect(repository.submitBriefAnswers({
      customTrackCountAuthority:
        PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      briefRequestId: created.id,
      idempotencyKey: keepKey,
      questionSetHash: confirmation.questionSetHash,
      answers: keepAnswer,
    })).resolves.toEqual({ status: "finalizing", created: false });

    const revisions = await pool.query<{
      id: string;
      parent_revision_id: string | null;
      status: string;
    }>(
      `SELECT id,parent_revision_id,status
       FROM playlist_contract_revisions
       WHERE brief_request_id=$1 ORDER BY revision`,
      [created.id],
    );
    expect(revisions.rows).toEqual([{
      id: persistedBase.id,
      parent_revision_id: null,
      status: "active",
    }]);
    const answerSet = (await pool.query<{
      base_contract_revision_id: string;
      resulting_contract_revision_id: string;
      execution_delta_json: unknown[];
      normalized_answers_json: unknown[];
    }>(
      `SELECT base_contract_revision_id,resulting_contract_revision_id,
              execution_delta_json,normalized_answers_json
       FROM guidance_answer_sets
       WHERE brief_request_id=$1 AND question_set_hash=$2`,
      [created.id, confirmation.questionSetHash],
    )).rows[0]!;
    expect(answerSet).toEqual({
      base_contract_revision_id: persistedBase.id,
      resulting_contract_revision_id: persistedBase.id,
      execution_delta_json: [],
      normalized_answers_json: [{
        questionId: confirmation.questions[0]!.id,
        optionId: "keep_current_interpretation",
      }],
    });
    expect(await repository.getBriefRequest(created.id)).toMatchObject({
      status: "finalizing",
    });
    expect((await pool.query<{ active_playlist_contract_revision_id: string }>(
      "SELECT active_playlist_contract_revision_id FROM brief_requests WHERE id=$1",
      [created.id],
    )).rows[0]?.active_playlist_contract_revision_id).toBe(persistedBase.id);
  }, 50_000);

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
