import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  contractTwoGuidanceQuestion,
  GUIDANCE_POLICY_VERSION,
  guidanceQuestionSetHashV2,
} from "../server/guidance-contract-v2.ts";
import {
  createGuidanceDecisionV3,
  deterministicGuidanceCandidatesV3,
  playlistInterpretationSummaryV1,
  selectGuidanceRoundV3,
  SMOOTH_REGGAETON_HEAT_PROMPT,
} from "../server/adaptive-guidance-v3.ts";
import { publicGuidanceQuestionV3 } from "../server/adaptive-guidance-contract-bridge.ts";
import { compilePlaylistContractShadowV1 } from "../server/playlist-contract-shadow-bridge-v1.ts";
import { Repository } from "../server/repository.ts";
import { createSelectionPlanV2 } from "../server/selection-plan-v2.ts";
import { sha256Hex, stableStringify } from "../server/security.ts";
import {
  compilePlaylistContractRevisionV1,
  type PlaylistContractRevisionV1,
} from "../server/playlist-contract-v1.ts";
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

    const stale = await repository.submitBriefAnswers({
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
    const run = await repository.createRunIdempotent({
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
    expect((await pool.query<{
      brief_contract_version: number;
      active_playlist_contract_revision_id: string;
      run_spec_contract_version: number;
    }>(
      `SELECT run.brief_contract_version,run.active_playlist_contract_revision_id,
              spec.brief_contract_version run_spec_contract_version
       FROM research_runs run
       JOIN run_specs spec ON spec.run_id=run.id
       WHERE run.id=$1`,
      [run.runId],
    )).rows[0]).toEqual({
      brief_contract_version: 3,
      active_playlist_contract_revision_id: successor.id,
      run_spec_contract_version: 3,
    });
  }, 50_000);

  test("turns a custom hard-rule answer into a persisted confirmation revision and rejects the stale tab", async () => {
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
    const candidates = deterministicGuidanceCandidatesV3({
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      baseContractRevisionId: shadow.contract.revisionId,
      baseContractSemanticHash: shadow.contract.semanticHash,
      preservedTrackPredicate: shadow.preservedTrackPredicate,
      ambiguousScopeClauseIds: shadow.ambiguousScopeClauseIds,
      baseContract: shadow.contract,
    });
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
        requestClassification: "critical_ambiguity",
        guidancePolicyVersion: "adaptive_guidance_v3",
        questionSetHash: round.roundHash,
        proposedQuestionCount: 1,
        acceptedQuestionCount: 1,
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
        explicitConstraintHash: sha256Hex("custom-hard-rules"),
        rejectedQuestionReasons: [],
        baseContractRevisionId: shadow.contract.revisionId,
        baseContractSemanticHash: shadow.contract.semanticHash,
        guidanceRound: "initial",
        trigger: "correctness",
        axis: "adjacent_latin_urban_scope",
      },
    });

    const custom = await repository.submitBriefAnswers({
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: round.roundHash,
      answers: [{
        questionId: questions[0]!.id,
        customText: "mostly women, clean, no Bad Bunny",
      }],
    });
    expect(custom).toMatchObject({
      status: "awaiting_answers",
      created: true,
      questionSetHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      questions: [{
        question: "Apply this revised playlist contract?",
        interpretationSummary: {
          count: 50,
          avoid: ["No recordings by Bad Bunny"],
          mustHave: expect.arrayContaining([
            "Clean versions only",
            "At least 51% Tracks by women artists",
          ]),
        },
      }],
    });
    if (custom.status !== "awaiting_answers") throw new Error("confirmation question was not persisted");

    const staleTab = await repository.submitBriefAnswers({
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: round.roundHash,
      answers: [{
        questionId: questions[0]!.id,
        optionId: "core_reggaeton_only",
      }],
    });
    expect(staleTab).toMatchObject({
      status: "stale_question_set",
      questionSetHash: custom.questionSetHash,
      questions: [{
        question: "Apply this revised playlist contract?",
      }],
    });

    await expect(repository.submitBriefAnswers({
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: custom.questionSetHash,
      answers: [{
        questionId: custom.questions[0]!.id,
        optionId: "apply_revised_interpretation",
      }],
    })).resolves.toEqual({ status: "finalizing", created: true });

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
    const questionSets = await pool.query<{
      revision: number;
      active: boolean;
      parent_question_set_id: string | null;
    }>(
      `SELECT revision,active,parent_question_set_id
       FROM guidance_question_sets
       WHERE brief_request_id=$1 ORDER BY revision`,
      [created.id],
    );
    expect(questionSets.rows).toEqual([
      { revision: 1, active: false, parent_question_set_id: null },
      { revision: 2, active: true, parent_question_set_id: expect.any(String) },
    ]);
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
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: round.roundHash,
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
      candidates: deterministicGuidanceCandidatesV3({
        prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
        baseContractRevisionId: shadow.contract.revisionId,
        baseContractSemanticHash: shadow.contract.semanticHash,
        preservedTrackPredicate: shadow.preservedTrackPredicate,
        ambiguousScopeClauseIds: shadow.ambiguousScopeClauseIds,
        baseContract: shadow.contract,
      }),
    });
    const questions = round.decisions.map(publicGuidanceQuestionV3);
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
        proposedQuestionCount: 1,
        acceptedQuestionCount: 1,
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
        explicitConstraintHash: sha256Hex("custom-hard-rules-keep"),
        rejectedQuestionReasons: [],
        baseContractRevisionId: shadow.contract.revisionId,
        baseContractSemanticHash: shadow.contract.semanticHash,
        guidanceRound: "initial",
        trigger: "correctness",
        axis: "adjacent_latin_urban_scope",
      },
    });

    const confirmation = await repository.submitBriefAnswers({
      briefRequestId: created.id,
      idempotencyKey: randomUUID(),
      questionSetHash: round.roundHash,
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
      briefRequestId: created.id,
      idempotencyKey: keepKey,
      questionSetHash: confirmation.questionSetHash,
      answers: keepAnswer,
    })).resolves.toEqual({ status: "finalizing", created: true });
    await expect(repository.submitBriefAnswers({
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
