import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  IRISH_INFLUENCE_RELEASE_PROOF_SCHEMA_V1,
  validateIrishInfluenceReleaseProofV1,
  type IrishInfluenceReleaseProofV1,
} from "./irish-influence-release-proof.ts";
import {
  assertGuidanceWorkerConsumptionReceiptV5,
  type GuidanceWorkerConsumptionReceiptV5,
} from "../server/guidance-worker-consumption-v5.ts";

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const PRODUCTION_ORIGIN = "https://9enio.com";

type JsonRecord = Record<string, unknown>;

export interface IrishInfluenceReleaseProofDatabase {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<pg.QueryResult<T>, "rows" | "rowCount">>;
}

export interface IrishInfluenceReleaseProofRuntime {
  fetchJson(
    url: string,
    cookie?: string,
  ): Promise<{ status: number; value: unknown }>;
  now(): Date;
}

interface PublicationProofRow extends pg.QueryResultRow {
  run_id: string;
  run_status: string;
  requested_track_count: number;
  question_set_hash: string;
  questions_json: unknown;
  normalized_answers_json: unknown;
  base_contract_hash: string;
  successor_contract_hash: string;
  successor_contract_json: unknown;
  query_plan_hash: string;
  query_plan_revision_id: string;
  route_receipt: unknown;
  worker_consumption: unknown;
  worker_configuration_hash: string;
  selected_count: number;
  manifested_count: number;
  reconciliation_state: string;
  appended_count: number;
  reconciliation_expected_count: number;
  expected_ordered_ids_hash: string;
  observed_ordered_ids_hash: string | null;
}

interface RecoveryProofRow extends pg.QueryResultRow {
  run_id: string;
  run_status: string;
  resolution_state: string | null;
  resolution_next_action: string | null;
  discovery_observation_count: number;
  lead_count: number;
  qualification_count: number;
  legacy_unbound_qualification_count: number;
  qualification_bindings: unknown;
  candidate_count: number;
  apple_identity_count: number;
  evidence_qualified_count: number;
  unknown_count: number;
  fail_count: number;
  coverage: unknown;
  audit: unknown;
}

interface QualificationBindingProofV1 {
  qualificationId: string;
  qualificationRunId: string;
  qualificationContractRevisionId: string;
  discoveryLeadId: string;
  leadId: string;
  leadRunId: string;
  leadContractRevisionId: string;
  leadExecutionAttemptId: string;
  executionAttemptId: string;
  executionAttemptRunId: string;
  executionAttemptContractRevisionId: string;
  executionAttemptJobId: string;
  executionAttemptQueryPlanRevisionId: string;
  jobId: string;
  jobRunId: string;
  jobQueryPlanRevisionId: string;
  jobMinimumWorkerProtocol: number;
  jobPipelineVersion: string;
  candidateId: string;
  materializedCandidateId: string;
  candidateRunId: string;
  candidatePipelineVersion: string;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function onlyRow<T>(
  rows: readonly T[],
  label: string,
): T {
  if (rows.length !== 1) {
    throw new Error(`${label} must resolve to exactly one durable row`);
  }
  return rows[0]!;
}

function hash(value: string, label: string): string {
  if (!SHA256.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function count(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]),
  );
}

function evidenceHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function qualificationBindingProof(
  row: RecoveryProofRow,
): {
  candidateBoundQualificationCount: number;
  legacyUnboundQualificationCount: number;
  qualificationBindingMismatchCount: 0;
  qualificationBindingSetHash: string;
} {
  if (!Array.isArray(row.qualification_bindings)) {
    throw new Error("Irish qualification bindings must be a durable array");
  }
  const runId = uuid(row.run_id, "Irish recovery run ID");
  const bindings = row.qualification_bindings.map((value, index) => {
    const binding = record(
      value,
      `Irish qualification binding ${index + 1}`,
    );
    const parsed: QualificationBindingProofV1 = {
      qualificationId: uuid(
        binding.qualificationId,
        "Irish qualification ID",
      ),
      qualificationRunId: uuid(
        binding.qualificationRunId,
        "Irish qualification run ID",
      ),
      qualificationContractRevisionId: uuid(
        binding.qualificationContractRevisionId,
        "Irish qualification contract revision ID",
      ),
      discoveryLeadId: uuid(
        binding.discoveryLeadId,
        "Irish qualification discovery-lead ID",
      ),
      leadId: uuid(binding.leadId, "Irish bound discovery-lead ID"),
      leadRunId: uuid(
        binding.leadRunId,
        "Irish bound discovery-lead run ID",
      ),
      leadContractRevisionId: uuid(
        binding.leadContractRevisionId,
        "Irish bound discovery-lead contract revision ID",
      ),
      leadExecutionAttemptId: uuid(
        binding.leadExecutionAttemptId,
        "Irish discovery-lead execution-attempt ID",
      ),
      executionAttemptId: uuid(
        binding.executionAttemptId,
        "Irish bound execution-attempt ID",
      ),
      executionAttemptRunId: uuid(
        binding.executionAttemptRunId,
        "Irish bound execution-attempt run ID",
      ),
      executionAttemptContractRevisionId: uuid(
        binding.executionAttemptContractRevisionId,
        "Irish bound execution-attempt contract revision ID",
      ),
      executionAttemptJobId: uuid(
        binding.executionAttemptJobId,
        "Irish execution-attempt job ID",
      ),
      executionAttemptQueryPlanRevisionId: uuid(
        binding.executionAttemptQueryPlanRevisionId,
        "Irish execution-attempt query-plan revision ID",
      ),
      jobId: uuid(binding.jobId, "Irish protocol-12 job ID"),
      jobRunId: uuid(binding.jobRunId, "Irish protocol-12 job run ID"),
      jobQueryPlanRevisionId: uuid(
        binding.jobQueryPlanRevisionId,
        "Irish protocol-12 job query-plan revision ID",
      ),
      jobMinimumWorkerProtocol: count(
        binding.jobMinimumWorkerProtocol,
        "Irish job minimum worker protocol",
      ),
      jobPipelineVersion: String(binding.jobPipelineVersion ?? ""),
      candidateId: uuid(
        binding.candidateId,
        "Irish qualification candidate ID",
      ),
      materializedCandidateId: uuid(
        binding.materializedCandidateId,
        "Irish materialized candidate ID",
      ),
      candidateRunId: uuid(
        binding.candidateRunId,
        "Irish materialized candidate run ID",
      ),
      candidatePipelineVersion: String(
        binding.candidatePipelineVersion ?? "",
      ),
    };
    if (
      parsed.qualificationRunId !== runId
      || parsed.leadRunId !== runId
      || parsed.executionAttemptRunId !== runId
      || parsed.jobRunId !== runId
      || parsed.candidateRunId !== runId
      || parsed.discoveryLeadId !== parsed.leadId
      || parsed.leadExecutionAttemptId !== parsed.executionAttemptId
      || parsed.executionAttemptJobId !== parsed.jobId
      || parsed.executionAttemptQueryPlanRevisionId
        !== parsed.jobQueryPlanRevisionId
      || parsed.candidateId !== parsed.materializedCandidateId
      || parsed.qualificationContractRevisionId
        !== parsed.leadContractRevisionId
      || parsed.qualificationContractRevisionId
        !== parsed.executionAttemptContractRevisionId
      || parsed.candidatePipelineVersion !== "corpus_first_v3"
      || parsed.jobMinimumWorkerProtocol < 12
      || parsed.jobPipelineVersion !== "corpus_first_v3"
    ) {
      throw new Error(
        "Irish active protocol-12 qualification has an unrelated binding",
      );
    }
    return parsed;
  });
  const qualificationCount = count(
    row.qualification_count,
    "Irish qualification count",
  );
  const legacyUnboundQualificationCount = count(
    row.legacy_unbound_qualification_count,
    "Irish legacy-unbound qualification count",
  );
  if (
    legacyUnboundQualificationCount !== 0
    || bindings.length !== qualificationCount
    || new Set(bindings.map(({ qualificationId }) => qualificationId)).size
      !== qualificationCount
    || new Set(bindings.map(({ candidateId }) => candidateId)).size
      !== qualificationCount
  ) {
    throw new Error(
      "Irish active protocol-12 qualifications are not fully candidate-bound",
    );
  }
  return {
    candidateBoundQualificationCount: bindings.length,
    legacyUnboundQualificationCount,
    qualificationBindingMismatchCount: 0,
    qualificationBindingSetHash: evidenceHash(
      bindings
        .map((binding) => ({
          qualificationId: binding.qualificationId,
          runId: binding.qualificationRunId,
          contractRevisionId: binding.qualificationContractRevisionId,
          discoveryLeadId: binding.discoveryLeadId,
          executionAttemptId: binding.executionAttemptId,
          jobId: binding.jobId,
          queryPlanRevisionId: binding.jobQueryPlanRevisionId,
          candidateId: binding.candidateId,
        }))
        .sort(({ qualificationId: left }, { qualificationId: right }) => (
          left.localeCompare(right)
        )),
    ),
  };
}

function publicRun(value: unknown): JsonRecord {
  const root = record(value, "run API response");
  return root.run && typeof root.run === "object" && !Array.isArray(root.run)
    ? record(root.run, "run API response run")
    : root;
}

function questionProof(row: PublicationProofRow): {
  questionHash: string;
  selectedOptionId: "balanced_influence";
  optionSimulationReceiptHash: string;
  executionEffectHash: string;
} {
  const questions = Array.isArray(row.questions_json)
    ? row.questions_json.map((item) => record(item, "guidance question"))
    : [];
  if (questions.length !== 1) {
    throw new Error("Irish proof requires exactly one durable guidance question");
  }
  const question = questions[0]!;
  if (
    question.axis !== "influence_scope"
    || question.policyVersion !== "adaptive_guidance_v5"
  ) {
    throw new Error("Irish proof question is not the V5 influence axis");
  }
  const answers = Array.isArray(row.normalized_answers_json)
    ? row.normalized_answers_json.map((item) => record(item, "guidance answer"))
    : [];
  if (
    answers.length !== 1
    || answers[0]!.optionId !== "balanced_influence"
  ) {
    throw new Error("Irish proof did not persist the balanced influence answer");
  }
  const options = Array.isArray(question.options)
    ? question.options.map((item) => record(item, "guidance option"))
    : [];
  const option = options.find(({ id }) => id === "balanced_influence");
  if (!option) throw new Error("Irish proof balanced option is missing");
  const simulation = record(
    option.optionSimulation,
    "Irish option simulation",
  );
  if (simulation.valid !== true) {
    throw new Error("Irish option simulation is not valid");
  }
  const consumer = record(
    simulation.consumerReceipt,
    "Irish option simulation consumer",
  );
  const effect = record(option.executionEffect, "Irish execution effect");
  return {
    questionHash: hash(
      String(question.questionHash ?? ""),
      "Irish question hash",
    ),
    selectedOptionId: "balanced_influence",
    optionSimulationReceiptHash: hash(
      String(consumer.receiptHash ?? ""),
      "Irish option simulation receipt hash",
    ),
    executionEffectHash: hash(
      String(effect.effectHash ?? ""),
      "Irish execution effect hash",
    ),
  };
}

function contractProof(row: PublicationProofRow): void {
  const contract = record(
    row.successor_contract_json,
    "Irish successor contract",
  );
  const clauses = Array.isArray(contract.clauses)
    ? contract.clauses.map((item) => record(item, "Irish contract clause"))
    : [];
  const membership = clauses.find((clause) => (
    clause.hardness === "hard"
    && clause.axis === "geography"
    && Array.isArray(clause.values)
    && clause.values.includes("Irish")
  ));
  const influence = clauses.find((clause) => (
    clause.axis === "influence"
    && clause.hardness === "soft"
  ));
  if (!membership || !influence) {
    throw new Error(
      "Irish successor contract lacks exact origin membership or influence semantics",
    );
  }
}

function recoveryDisposition(
  row: RecoveryProofRow,
  api: JsonRecord,
): {
  disposition: IrishInfluenceReleaseProofV1["recoveryInjection"]["disposition"];
  nextActionKind:
    IrishInfluenceReleaseProofV1["recoveryInjection"]["nextActionKind"];
  acquisitionAttemptCount: number;
} {
  const coverage = record(row.coverage, "Irish recovery coverage");
  const audit = record(row.audit, "Irish recovery audit");
  const obligations = Array.isArray(coverage.obligations)
    ? coverage.obligations.map((item) => record(item, "coverage obligation"))
    : [];
  const limiting = new Set(
    Array.isArray(audit.limitingObligationIds)
      ? audit.limitingObligationIds.map(String)
      : [],
  );
  const relevant = obligations.filter(({ obligationId }) => (
    limiting.size === 0 || limiting.has(String(obligationId))
  ));
  const acquisitionAttemptCount = relevant.reduce(
    (sum, item) => sum + count(
      item.acquisitionAttemptCount ?? 0,
      "Irish acquisition attempt count",
    ),
    0,
  );
  const resolution = record(api.resolution, "Irish recovery API resolution");
  if (
    row.resolution_state === "blocked_dependency"
    && resolution.nextAction === "resume_at"
  ) {
    return {
      disposition: "blocked_dependency",
      nextActionKind: "resume_at",
      acquisitionAttemptCount,
    };
  }
  const repair = record(
    api.repairReplayAction,
    "Irish recovery API repair action",
  );
  if (
    row.resolution_state !== "quarantined"
    || repair.kind !== "repair_replay"
    || repair.available !== true
  ) {
    throw new Error(
      "Irish recovery result has no durable advancing repair action",
    );
  }
  const hasBindingDefect = relevant.some((item) => (
    count(item.malformedEvidenceCount ?? 0, "malformed evidence count") > 0
    || count(item.wrongAxisEvidenceCount ?? 0, "wrong-axis evidence count") > 0
  ));
  return {
    disposition: hasBindingDefect
      ? "quarantined_evidence_binding_defect"
      : "quarantined_capability_gap",
    nextActionKind: "replay_after_repair",
    acquisitionAttemptCount,
  };
}

const PUBLICATION_QUERY = `
  SELECT run.id run_id,run.status run_status,spec.requested_track_count,
         questions.question_set_hash,questions.questions_json,
         answers.normalized_answers_json,
         base.contract_hash base_contract_hash,
         successor.contract_hash successor_contract_hash,
         successor.contract_json successor_contract_json,
         query.plan_hash query_plan_hash,
         query.id::text query_plan_revision_id,
         route.state_json route_receipt,
         consumption.state_json worker_consumption,
         attempt.configuration_hash worker_configuration_hash,
         COALESCE(selection.selected_count,legacy.selected_count,0)::int
           selected_count,
         COALESCE(selection.manifested_count,legacy.selected_count,0)::int
           manifested_count,
         reconciliation.state reconciliation_state,
         reconciliation.appended_count,
         reconciliation.expected_count reconciliation_expected_count,
         reconciliation.expected_ordered_ids_hash,
         reconciliation.observed_ordered_ids_hash
  FROM run_accesses access
  JOIN research_runs run ON run.id=access.run_id
  JOIN run_specs spec ON spec.run_id=run.id
  JOIN brief_requests brief ON brief.id=access.brief_request_id
  JOIN guidance_answer_sets answers
    ON answers.brief_request_id=brief.id
  JOIN guidance_question_sets questions
    ON questions.id=answers.question_set_id
  JOIN playlist_contract_revisions base
    ON base.id=questions.base_contract_revision_id
  JOIN playlist_contract_revisions successor
    ON successor.id=run.active_playlist_contract_revision_id
  JOIN run_active_query_plans active ON active.run_id=run.id
  JOIN query_plan_revisions query ON query.id=active.query_plan_revision_id
  JOIN research_checkpoints route
    ON route.run_id=run.id AND route.phase='execution_route_receipt_v1'
  JOIN LATERAL (
    SELECT checkpoint.state_json
    FROM research_checkpoints checkpoint
    WHERE checkpoint.run_id=run.id
      AND checkpoint.phase=
        'v3:guidance:v5:worker-consumption:' || left(query.plan_hash,46)
    ORDER BY checkpoint.updated_at DESC
    LIMIT 1
  ) consumption ON true
  JOIN LATERAL (
    SELECT execution.configuration_hash
    FROM playlist_execution_attempts execution
    WHERE execution.run_id=run.id AND execution.status='complete'
    ORDER BY execution.completed_at DESC NULLS LAST,execution.id DESC
    LIMIT 1
  ) attempt ON true
  JOIN playlist_run_resolutions resolution
    ON resolution.run_id=run.id
   AND resolution.state='completed'
  JOIN LATERAL (
    SELECT revision.id manifest_revision_id,
           manifest.id manifest_id,
           immutable.selected_count,
           count(track.id)::int manifested_count
    FROM manifest_revisions revision
    JOIN manifests manifest ON manifest.id=revision.manifest_id
    JOIN immutable_selection_sets immutable
      ON immutable.id=revision.selection_set_id
     AND immutable.attestation_set_hash=revision.attestation_set_hash
    JOIN manifest_revision_tracks track
      ON track.manifest_revision_id=revision.id
    WHERE manifest.id=resolution.manifest_id
      AND revision.status='published'
    GROUP BY revision.id,manifest.id,immutable.selected_count,revision.revision
    ORDER BY revision.revision DESC
    LIMIT 1
  ) selection ON true
  LEFT JOIN LATERAL (
    SELECT count(track.id)::int selected_count
    FROM manifests manifest
    JOIN manifest_tracks track ON track.manifest_id=manifest.id
    WHERE manifest.run_id=run.id
  ) legacy ON true
  JOIN LATERAL (
    SELECT state,appended_count,expected_count,
           expected_ordered_ids_hash,observed_ordered_ids_hash
    FROM playlist_publication_reconciliations value
    WHERE value.run_id=run.id
      AND value.manifest_id=selection.manifest_id
      AND value.manifest_revision_id=selection.manifest_revision_id
    ORDER BY value.updated_at DESC,value.id DESC
    LIMIT 1
  ) reconciliation ON true
  WHERE access.id=$1
  ORDER BY answers.accepted_at DESC
  LIMIT 1`;

const RECOVERY_QUERY = `
  WITH authority AS (
    SELECT run.id run_id,run.status run_status,
           COALESCE(
             resolution.active_contract_revision_id,
             run.active_playlist_contract_revision_id
           ) active_contract_revision_id,
           resolution.state resolution_state,
           resolution.next_action resolution_next_action
    FROM run_accesses access
    JOIN research_runs run ON run.id=access.run_id
    LEFT JOIN playlist_run_resolutions resolution ON resolution.run_id=run.id
    WHERE access.id=$1
  ),
  active_leads AS (
    SELECT lead.*
    FROM playlist_discovery_leads lead
    JOIN authority
      ON authority.run_id=lead.run_id
     AND authority.active_contract_revision_id=lead.contract_revision_id
  ),
  active_qualifications AS (
    SELECT qualification.*
    FROM playlist_qualification_records qualification
    JOIN authority
      ON authority.run_id=qualification.run_id
     AND authority.active_contract_revision_id=
       qualification.contract_revision_id
    WHERE qualification.revoked_at IS NULL
  ),
  qualification_bindings AS (
    SELECT qualification.id qualification_id,
           qualification.run_id qualification_run_id,
           qualification.contract_revision_id
             qualification_contract_revision_id,
           qualification.discovery_lead_id,
           lead.id lead_id,
           lead.run_id lead_run_id,
           lead.contract_revision_id lead_contract_revision_id,
           lead.execution_attempt_id lead_execution_attempt_id,
           attempt.id execution_attempt_id,
           attempt.run_id execution_attempt_run_id,
           attempt.contract_revision_id
             execution_attempt_contract_revision_id,
           attempt.job_id execution_attempt_job_id,
           attempt.query_plan_revision_id
             execution_attempt_query_plan_revision_id,
           job.id job_id,
           job.run_id job_run_id,
           job.query_plan_revision_id job_query_plan_revision_id,
           job.minimum_worker_protocol job_minimum_worker_protocol,
           job.pipeline_version job_pipeline_version,
           qualification.candidate_id,
           candidate.id materialized_candidate_id,
           candidate.run_id candidate_run_id,
           candidate.pipeline_version candidate_pipeline_version
    FROM active_qualifications qualification
    LEFT JOIN playlist_discovery_leads lead
      ON lead.id=qualification.discovery_lead_id
    LEFT JOIN playlist_execution_attempts attempt
      ON attempt.id=lead.execution_attempt_id
    LEFT JOIN job_queue job ON job.id=attempt.job_id
    LEFT JOIN track_candidates candidate
      ON candidate.id=qualification.candidate_id
  )
  SELECT authority.run_id,authority.run_status,
         authority.resolution_state,authority.resolution_next_action,
         (SELECT COALESCE(sum(
           CASE
             WHEN jsonb_typeof(
               lead.lead_json->'observationReceiptHashes'
             )='array'
             THEN GREATEST(
               jsonb_array_length(
                 lead.lead_json->'observationReceiptHashes'
               ),
               1
             )
             ELSE 1
           END
         ),0)::int FROM active_leads lead) discovery_observation_count,
         (SELECT count(*)::int FROM active_leads) lead_count,
         (SELECT count(*)::int FROM active_qualifications)
           qualification_count,
         (SELECT count(*)::int FROM active_qualifications qualification
          WHERE qualification.candidate_id IS NULL)
           legacy_unbound_qualification_count,
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'qualificationId',binding.qualification_id::text,
           'qualificationRunId',binding.qualification_run_id::text,
           'qualificationContractRevisionId',
             binding.qualification_contract_revision_id::text,
           'discoveryLeadId',binding.discovery_lead_id::text,
           'leadId',binding.lead_id::text,
           'leadRunId',binding.lead_run_id::text,
           'leadContractRevisionId',
             binding.lead_contract_revision_id::text,
           'leadExecutionAttemptId',
             binding.lead_execution_attempt_id::text,
           'executionAttemptId',binding.execution_attempt_id::text,
           'executionAttemptRunId',
             binding.execution_attempt_run_id::text,
           'executionAttemptContractRevisionId',
             binding.execution_attempt_contract_revision_id::text,
           'executionAttemptJobId',
             binding.execution_attempt_job_id::text,
           'executionAttemptQueryPlanRevisionId',
             binding.execution_attempt_query_plan_revision_id::text,
           'jobId',binding.job_id::text,
           'jobRunId',binding.job_run_id::text,
           'jobQueryPlanRevisionId',
             binding.job_query_plan_revision_id::text,
           'jobMinimumWorkerProtocol',
             binding.job_minimum_worker_protocol,
           'jobPipelineVersion',binding.job_pipeline_version,
           'candidateId',binding.candidate_id::text,
           'materializedCandidateId',
             binding.materialized_candidate_id::text,
           'candidateRunId',binding.candidate_run_id::text,
           'candidatePipelineVersion',binding.candidate_pipeline_version
         ) ORDER BY binding.qualification_id),'[]'::jsonb)
          FROM qualification_bindings binding) qualification_bindings,
         (SELECT count(*)::int FROM track_candidates candidate
          WHERE candidate.run_id=authority.run_id
            AND candidate.pipeline_version='corpus_first_v3')
           candidate_count,
         (SELECT count(*)::int
          FROM recording_catalog_identities identity
          JOIN recording_families family
            ON family.id=identity.recording_family_id
          WHERE family.run_id=authority.run_id AND identity.provider='apple')
           apple_identity_count,
         (SELECT count(*)::int FROM active_qualifications value
          WHERE value.decision='qualified') evidence_qualified_count,
         (SELECT count(*)::int FROM active_qualifications value
          WHERE value.decision='unknown') unknown_count,
         (SELECT count(*)::int FROM active_qualifications value
          WHERE value.decision='failed') fail_count,
         coverage.state_json coverage,audit.state_json audit
  FROM authority
  JOIN LATERAL (
    SELECT checkpoint.state_json
    FROM research_checkpoints checkpoint
    WHERE checkpoint.run_id=authority.run_id
      AND checkpoint.phase='v3:semantic-collapse:coverage:v2'
    ORDER BY checkpoint.updated_at DESC
    LIMIT 1
  ) coverage ON true
  JOIN LATERAL (
    SELECT checkpoint.state_json
    FROM research_checkpoints checkpoint
    WHERE checkpoint.run_id=authority.run_id
      AND checkpoint.phase='v3:semantic-collapse:audit:v2'
    ORDER BY checkpoint.updated_at DESC
    LIMIT 1
  ) audit ON true`;

export async function collectIrishInfluenceReleaseProofV1(input: {
  database: IrishInfluenceReleaseProofDatabase;
  runtime: IrishInfluenceReleaseProofRuntime;
  origin: typeof PRODUCTION_ORIGIN;
  publicationAccessId: string;
  publicationCookie: string;
  recoveryAccessId: string;
  recoveryCookie: string;
  expectedVersion: string;
  expectedRevision: string;
}): Promise<IrishInfluenceReleaseProofV1> {
  if (
    !UUID.test(input.publicationAccessId)
    || !UUID.test(input.recoveryAccessId)
    || !VERSION.test(input.expectedVersion)
    || !SHA1.test(input.expectedRevision)
  ) {
    throw new Error("Irish release-proof selectors are invalid");
  }
  const [liveResponse, publicationApiResponse, recoveryApiResponse] =
    await Promise.all([
      input.runtime.fetchJson(`${input.origin}/health/live`),
      input.runtime.fetchJson(
        `${input.origin}/api/v1/runs/${input.publicationAccessId}`,
        input.publicationCookie,
      ),
      input.runtime.fetchJson(
        `${input.origin}/api/v1/runs/${input.recoveryAccessId}`,
        input.recoveryCookie,
      ),
    ]);
  if (
    liveResponse.status !== 200
    || publicationApiResponse.status !== 200
    || recoveryApiResponse.status !== 200
  ) {
    throw new Error("Irish release proof could not reread durable API state");
  }
  const liveRoot = record(liveResponse.value, "liveness response");
  const build = record(liveRoot.build ?? liveRoot, "liveness build");
  if (
    build.version !== input.expectedVersion
    || build.revision !== input.expectedRevision
  ) {
    throw new Error("Irish release proof API identity mismatch");
  }
  const [publicationResult, recoveryResult] = await Promise.all([
    input.database.query<PublicationProofRow>(
      PUBLICATION_QUERY,
      [input.publicationAccessId],
    ),
    input.database.query<RecoveryProofRow>(
      RECOVERY_QUERY,
      [input.recoveryAccessId],
    ),
  ]);
  const publication = onlyRow(
    publicationResult.rows,
    "Irish publication access",
  );
  const recovery = onlyRow(
    recoveryResult.rows,
    "Irish recovery access",
  );
  const publicationApi = publicRun(publicationApiResponse.value);
  const recoveryApi = publicRun(recoveryApiResponse.value);
  const route = record(publication.route_receipt, "Irish route receipt");
  const assignment = record(
    route.assignmentAuthority,
    "Irish assignment authority",
  );
  const publicRoute = record(
    publicationApi.executionRouteReceipt,
    "Irish public route receipt",
  );
  if (
    publication.run_status !== "complete"
    || publicationApi.status !== "complete"
    || publication.requested_track_count !== 25
    || route.trafficClass !== "owner_canary"
    || assignment.kind !== "signed_owner_canary"
    || assignment.intentGroup !== "editorial_influence"
    || route.executionRoute !== "corpus_first_v3"
    || route.contractVersion !== 3
    || route.guidanceVersion !== "adaptive_guidance_v5"
    || route.queryPlanSchema !== 6
    || route.queryPlanHash !== publication.query_plan_hash
    || publicRoute.receiptHash !== route.receiptHash
    || publicRoute.executionRoute !== route.executionRoute
  ) {
    throw new Error("Irish release proof route or API projection diverged");
  }
  const worker = structuredClone(
    publication.worker_consumption,
  ) as GuidanceWorkerConsumptionReceiptV5;
  assertGuidanceWorkerConsumptionReceiptV5(worker);
  const question = questionProof(publication);
  contractProof(publication);
  if (
    worker.status !== "consumed"
    || worker.questionSetHash !== publication.question_set_hash
    || worker.questionHash !== question.questionHash
    || worker.selectedOptionId !== question.selectedOptionId
    || worker.axis !== "influence_scope"
    || worker.queryPlanHash !== publication.query_plan_hash
    || worker.contractSemanticHash !== publication.successor_contract_hash
    || worker.effectHash !== question.executionEffectHash
  ) {
    throw new Error("Irish worker did not consume the selected guidance");
  }
  const apiCoverage = record(
    recoveryApi.evidenceCoverage,
    "Irish recovery API evidence coverage",
  );
  const bindingProof = qualificationBindingProof(recovery);
  const recoveryCounts = {
    discoveryObservationCount: count(
      recovery.discovery_observation_count,
      "Irish discovery observation count",
    ),
    uniqueLeadCount: count(recovery.lead_count, "Irish unique lead count"),
    qualificationObservationCount: count(
      recovery.qualification_count,
      "Irish qualification count",
    ),
    ...bindingProof,
    materializedCandidateCount: count(
      recovery.candidate_count,
      "Irish candidate count",
    ),
    applePlayableCount: count(
      recovery.apple_identity_count,
      "Irish Apple identity count",
    ),
    evidenceQualifiedCount: count(
      recovery.evidence_qualified_count,
      "Irish evidence-qualified count",
    ),
    limitingObligationUnknownCount: count(
      recovery.unknown_count,
      "Irish unknown count",
    ),
    limitingObligationFailCount: count(
      recovery.fail_count,
      "Irish fail count",
    ),
  } as const;
  if (
    Number(apiCoverage.observationCount) !==
      recoveryCounts.discoveryObservationCount
    || Number(apiCoverage.uniqueLeadCount) !==
      recoveryCounts.uniqueLeadCount
    || Number(apiCoverage.qualificationObservationCount) !==
      recoveryCounts.qualificationObservationCount
    || Number(apiCoverage.legacyUnboundQualificationCount) !== 0
    || recoveryCounts.legacyUnboundQualificationCount !== 0
    || Number(apiCoverage.candidates) !==
      recoveryCounts.materializedCandidateCount
    || Number(apiCoverage.storefrontPlayable) !==
      recoveryCounts.applePlayableCount
    || Number(apiCoverage.evidencePassed) !==
      recoveryCounts.evidenceQualifiedCount
    || Number(apiCoverage.evidenceUnknown) !==
      recoveryCounts.limitingObligationUnknownCount
    || Number(apiCoverage.evidenceFailed) !==
      recoveryCounts.limitingObligationFailCount
  ) {
    throw new Error("Irish recovery DB and API counters diverged");
  }
  const recoveryState = recoveryDisposition(recovery, recoveryApi);
  const selectedCount = count(
    publication.selected_count,
    "Irish selected count",
  );
  const manifestedCount = count(
    publication.manifested_count,
    "Irish manifested count",
  );
  const appendedCount = count(
    publication.appended_count,
    "Irish appended count",
  );
  const reconciledPublishedCount =
    publication.reconciliation_state === "complete"
      && publication.expected_ordered_ids_hash
        === publication.observed_ordered_ids_hash
      ? count(
          publication.reconciliation_expected_count,
          "Irish reconciled count",
        )
      : 0;
  const unsigned = {
    schemaVersion: IRISH_INFLUENCE_RELEASE_PROOF_SCHEMA_V1,
    fixtureId: "irish-influence-recovery-25-v1" as const,
    candidate: {
      version: input.expectedVersion,
      sourceRevision: input.expectedRevision,
      workerConfigurationHash: hash(
        publication.worker_configuration_hash,
        "Irish worker configuration hash",
      ),
    },
    ownerAcceptance: {
      trafficClass: "owner_canary" as const,
      assignmentKind: "signed_owner_canary" as const,
      intentGroup: "editorial_influence" as const,
      executionRoute: "corpus_first_v3" as const,
      contractVersion: 3 as const,
      guidanceVersion: "adaptive_guidance_v5" as const,
      hardMembershipAxis: "geography" as const,
      hardMembershipValue: "Irish" as const,
      influenceKind: "influence" as const,
      assignmentReceiptHash: hash(
        String(assignment.receiptHash ?? ""),
        "Irish assignment receipt hash",
      ),
      routeReceiptHash: hash(
        String(route.receiptHash ?? ""),
        "Irish route receipt hash",
      ),
      questionSetHash: hash(
        publication.question_set_hash,
        "Irish question-set hash",
      ),
      questionHash: question.questionHash,
      axis: "influence_scope" as const,
      selectedOptionId: question.selectedOptionId,
      baseContractSemanticHash: hash(
        publication.base_contract_hash,
        "Irish base contract hash",
      ),
      successorContractSemanticHash: hash(
        publication.successor_contract_hash,
        "Irish successor contract hash",
      ),
      queryPlanSchema: 6 as const,
      queryPlanHash: hash(
        publication.query_plan_hash,
        "Irish query-plan hash",
      ),
      queryPlanRevisionHash: sha256(publication.query_plan_revision_id),
      optionSimulationReceiptHash:
        question.optionSimulationReceiptHash,
      executionEffectHash: question.executionEffectHash,
      workerConsumptionReceiptHash: worker.receiptHash,
      workerConsumptionStatus: "consumed" as const,
    },
    recoveryInjection: {
      ...recoveryCounts,
      acquisitionAttemptCount: recoveryState.acquisitionAttemptCount,
      disposition: recoveryState.disposition,
      nextActionKind: recoveryState.nextActionKind,
      scarcityReported: false as const,
      actionless: false as const,
    },
    publication: {
      selectedCount,
      manifestedCount,
      appendedCount,
      reconciledPublishedCount,
      expectedOrderedAppleIdsHash: hash(
        publication.expected_ordered_ids_hash,
        "Irish expected ordered Apple IDs hash",
      ),
      observedOrderedAppleIdsHash: hash(
        publication.observed_ordered_ids_hash ?? "",
        "Irish observed ordered Apple IDs hash",
      ),
    },
    observedAt: input.runtime.now().toISOString(),
  };
  const proof = {
    ...unsigned,
    evidenceHash: evidenceHash(unsigned),
  };
  return validateIrishInfluenceReleaseProofV1(proof, {
    version: input.expectedVersion,
    sourceRevision: input.expectedRevision,
    workerConfigurationHashes: [publication.worker_configuration_hash],
    contractHash: publication.successor_contract_hash,
    questionSetHash: publication.question_set_hash,
    questionHash: question.questionHash,
    queryPlanRevisionHash: sha256(publication.query_plan_revision_id),
    orderedAppleIdsHash: publication.observed_ordered_ids_hash ?? "",
  });
}

function option(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1]?.trim() ?? "" : "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const allowed = new Set([
    "--origin",
    "--publication-access-id",
    "--recovery-access-id",
    "--expected-version",
    "--expected-revision",
    "--output",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    if (!allowed.has(argv[index] ?? "")) {
      throw new Error(`unknown argument: ${argv[index] ?? ""}`);
    }
  }
  const origin = option(argv, "--origin");
  if (origin !== PRODUCTION_ORIGIN) {
    throw new Error("Irish release proof is production-only");
  }
  const databaseUrl =
    process.env.RELEASE_PRODUCTION_DATABASE_URL?.trim() ?? "";
  const publicationCookie =
    process.env.RELEASE_IRISH_PUBLICATION_COOKIE?.trim() ?? "";
  const recoveryCookie =
    process.env.RELEASE_IRISH_RECOVERY_COOKIE?.trim() ?? "";
  if (!databaseUrl || !publicationCookie || !recoveryCookie) {
    throw new Error(
      "protected production database and scoped run cookies are required",
    );
  }
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("railway.internal")
      ? undefined
      : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const proof = await collectIrishInfluenceReleaseProofV1({
      database: client,
      runtime: {
        async fetchJson(url, cookie) {
          const response = await fetch(url, {
            cache: "no-store",
            redirect: "error",
            headers: {
              "cache-control": "no-cache",
              pragma: "no-cache",
              ...(cookie ? { cookie } : {}),
            },
            signal: AbortSignal.timeout(20_000),
          });
          let value: unknown = {};
          try {
            value = JSON.parse(await response.text());
          } catch {
            value = {};
          }
          return { status: response.status, value };
        },
        now: () => new Date(),
      },
      origin: PRODUCTION_ORIGIN,
      publicationAccessId: option(argv, "--publication-access-id"),
      publicationCookie,
      recoveryAccessId: option(argv, "--recovery-access-id"),
      recoveryCookie,
      expectedVersion: option(argv, "--expected-version"),
      expectedRevision: option(argv, "--expected-revision"),
    });
    await writeFile(
      option(argv, "--output"),
      `${JSON.stringify(proof, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      evidenceHash: proof.evidenceHash,
    })}\n`);
  } finally {
    await client.end();
  }
}

if (process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "irish_influence_release_proof_failed",
      message:
        "Irish release proof could not be derived from production DB/API state",
    })}\n`);
    process.exitCode = 1;
  });
}
