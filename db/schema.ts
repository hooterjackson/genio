import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const settings = pgTable("settings", {
  key: varchar("key", { length: 160 }).primaryKey(),
  value: text("value").notNull(),
  ...timestamps,
});

export const briefRequests = pgTable("brief_requests", {
  id: uuid("id").primaryKey(),
  prompt: text("prompt").notNull(),
  requestedTrackCount: integer("requested_track_count"),
  model: varchar("model", { length: 120 }).notNull(),
  status: varchar("status", { length: 40 }).notNull().default("queued"),
  briefJson: jsonb("brief_json"),
  questionsJson: jsonb("questions_json"),
  answersJson: jsonb("answers_json"),
  guidanceSourceHintsJson: jsonb("guidance_source_hints_json").notNull().default([]),
  guidanceTelemetryJson: jsonb("guidance_telemetry_json"),
  guidancePreferencesJson: jsonb("guidance_preferences_json").notNull().default([]),
  briefContractVersion: integer("brief_contract_version").notNull().default(1),
  activeGuidanceQuestionSetId: uuid("active_guidance_question_set_id"),
  activePlaylistContractRevisionId: uuid("active_playlist_contract_revision_id"),
  publicRolloutAssignmentJson: jsonb("public_rollout_assignment_json"),
  pipelineVersion: varchar("pipeline_version", { length: 48 }).notNull().default("legacy_v1"),
  policyVersion: varchar("policy_version", { length: 80 }).notNull().default("legacy_v1"),
  selectionPlanJson: jsonb("selection_plan_json"),
  answersIdempotencyKey: varchar("answers_idempotency_key", { length: 160 }),
  answersHash: varchar("answers_hash", { length: 64 }),
  estimateUsd: numeric("estimate_usd", { precision: 12, scale: 6, mode: "number" }),
  error: text("error"),
  clientBucket: varchar("client_bucket", { length: 160 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 160 }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("brief_bucket_idempotency_idx").on(table.clientBucket, table.idempotencyKey),
  index("brief_status_created_idx").on(table.status, table.createdAt),
]);

export const capabilitySessions = pgTable("capability_sessions", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id"),
  accessId: uuid("access_id"),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
}, (table) => [index("capability_session_run_idx").on(table.runId)]);

export const researchRuns = pgTable("research_runs", {
  id: uuid("id").primaryKey(),
  prompt: text("prompt").notNull(),
  briefJson: jsonb("brief_json").notNull(),
  guidanceSourceHintsJson: jsonb("guidance_source_hints_json").notNull().default([]),
  guidanceTelemetryJson: jsonb("guidance_telemetry_json"),
  guidancePreferencesJson: jsonb("guidance_preferences_json").notNull().default([]),
  briefContractVersion: integer("brief_contract_version").notNull().default(1),
  activePlaylistContractRevisionId: uuid("active_playlist_contract_revision_id"),
  pipelineVersion: varchar("pipeline_version", { length: 48 }).notNull().default("legacy_v1"),
  policyVersion: varchar("policy_version", { length: 80 }).notNull().default("legacy_v1"),
  selectionPlanJson: jsonb("selection_plan_json"),
  pipelinePolicySnapshotJson: jsonb("pipeline_policy_snapshot_json"),
  pipelineOutcomeJson: jsonb("pipeline_outcome_json"),
  briefHash: varchar("brief_hash", { length: 64 }).notNull(),
  status: varchar("status", { length: 48 }).notNull(),
  phase: varchar("phase", { length: 80 }).notNull(),
  clientBucket: varchar("client_bucket", { length: 160 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
  autoPublish: boolean("auto_publish").notNull().default(false),
  estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
  actualCostUsd: numeric("actual_cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
  reservedCostUsd: numeric("reserved_cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
  approvedBudgetUsd: numeric("approved_budget_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
  budgetApprovalExpiresAt: timestamp("budget_approval_expires_at", { withTimezone: true }),
  noNewGapPasses: integer("no_new_gap_passes").notNull().default(0),
  error: text("error"),
  retentionExpiresAt: timestamp("retention_expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("run_bucket_idempotency_idx").on(table.clientBucket, table.idempotencyKey),
  index("run_status_created_idx").on(table.status, table.createdAt),
  index("run_brief_cache_idx").on(table.briefHash, table.completedAt),
  index("run_retention_idx").on(table.retentionExpiresAt),
]);

/** Immutable caller intent. Mutable orchestration state remains on research_runs. */
export const runSpecs = pgTable("run_specs", {
  runId: uuid("run_id").primaryKey().references(() => researchRuns.id, { onDelete: "cascade" }),
  rawPrompt: text("raw_prompt").notNull(),
  requestedTrackCount: integer("requested_track_count"),
  storefront: varchar("storefront", { length: 16 }).notNull(),
  guidanceAnswersJson: jsonb("guidance_answers_json").notNull().default([]),
  guidanceSourceHintsJson: jsonb("guidance_source_hints_json").notNull().default([]),
  briefContractVersion: integer("brief_contract_version").notNull().default(1),
  specHash: varchar("spec_hash", { length: 64 }).notNull(),
  pipelineVersion: varchar("pipeline_version", { length: 48 }).notNull(),
  policyVersion: varchar("policy_version", { length: 80 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("run_spec_hash_idx").on(table.specHash),
  check("run_spec_requested_track_count_valid", sql`${table.requestedTrackCount} IS NULL OR ${table.requestedTrackCount} BETWEEN 1 AND 1000`),
]);

/** Confirmed V3 membership/ranking contracts; only lifecycle status may change. */
export const selectionPlans = pgTable("selection_plans", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  status: varchar("status", { length: 32 }).notNull().default("active"),
  planHash: varchar("plan_hash", { length: 64 }).notNull(),
  planJson: jsonb("plan_json").notNull(),
  pipelineVersion: varchar("pipeline_version", { length: 48 }).notNull(),
  policyVersion: varchar("policy_version", { length: 80 }).notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("selection_plan_run_revision_idx").on(table.runId, table.revision),
  uniqueIndex("selection_plan_run_hash_idx").on(table.runId, table.planHash),
  index("selection_plan_status_idx").on(table.runId, table.status, table.createdAt),
  check("selection_plan_revision_positive", sql`${table.revision} > 0`),
]);

/** Locked graph views make a V3 query plan reproducible as the corpus evolves. */
export const graphSnapshots = pgTable("graph_snapshots", {
  id: uuid("id").primaryKey(),
  sequence: bigint("sequence", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
  parentSnapshotId: uuid("parent_snapshot_id"),
  status: varchar("status", { length: 32 }).notNull().default("building"),
  contentHash: varchar("content_hash", { length: 64 }),
  assertionCount: integer("assertion_count").notNull().default(0),
  catalogIdentityCount: integer("catalog_identity_count").notNull().default(0),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("graph_snapshot_sequence_idx").on(table.sequence),
  uniqueIndex("graph_snapshot_content_hash_idx").on(table.contentHash),
  index("graph_snapshot_status_idx").on(table.status, table.createdAt),
  check("graph_snapshot_status_valid", sql`${table.status} IN ('building','locked','superseded')`),
  check("graph_snapshot_locked_state_valid", sql`(
    (${table.status}='building' AND ${table.lockedAt} IS NULL AND ${table.contentHash} IS NULL)
    OR (${table.status} IN ('locked','superseded') AND ${table.lockedAt} IS NOT NULL AND ${table.contentHash} IS NOT NULL)
  )`),
  check("graph_snapshot_content_hash_valid", sql`${table.contentHash} IS NULL OR ${table.contentHash} ~ '^[0-9a-f]{64}$'`),
  check("graph_snapshot_counts_valid", sql`${table.assertionCount} >= 0 AND ${table.catalogIdentityCount} >= 0`),
]);

export const queryPlanRevisions = pgTable("query_plan_revisions", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  selectionPlanId: uuid("selection_plan_id").notNull().references(() => selectionPlans.id),
  revision: integer("revision").notNull(),
  parentRevisionId: uuid("parent_revision_id"),
  graphSnapshotId: uuid("graph_snapshot_id").notNull().references(() => graphSnapshots.id),
  engine: varchar("engine", { length: 48 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default("draft"),
  planHash: varchar("plan_hash", { length: 64 }).notNull(),
  planJson: jsonb("plan_json").notNull(),
  pipelineVersion: varchar("pipeline_version", { length: 48 }).notNull(),
  policyVersion: varchar("policy_version", { length: 80 }).notNull(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("query_plan_run_revision_idx").on(table.runId, table.revision),
  uniqueIndex("query_plan_run_hash_idx").on(table.runId, table.planHash),
  index("query_plan_graph_snapshot_idx").on(table.graphSnapshotId),
  index("query_plan_selection_plan_idx").on(table.selectionPlanId),
]);

export const runActiveQueryPlans = pgTable("run_active_query_plans", {
  runId: uuid("run_id").primaryKey().references(() => researchRuns.id, { onDelete: "cascade" }),
  queryPlanRevisionId: uuid("query_plan_revision_id").notNull().references(() => queryPlanRevisions.id),
  activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("run_active_query_plan_revision_idx").on(table.queryPlanRevisionId)]);

/**
 * Immutable, replayable interpretation of a playlist request. A revision is
 * owned by either a pre-run brief or a direct run, while a run created from a
 * brief may point at the brief-owned revision without mutating it.
 */
export const playlistContractRevisions = pgTable("playlist_contract_revisions", {
  id: uuid("id").primaryKey(),
  briefRequestId: uuid("brief_request_id").references(() => briefRequests.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => researchRuns.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  parentRevisionId: uuid("parent_revision_id"),
  status: varchar("status", { length: 32 }).notNull().default("active"),
  contractHash: varchar("contract_hash", { length: 64 }).notNull(),
  contractJson: jsonb("contract_json").notNull(),
  compilerVersion: varchar("compiler_version", { length: 80 }).notNull(),
  ontologyVersion: varchar("ontology_version", { length: 80 }).notNull(),
  evidencePolicyVersion: varchar("evidence_policy_version", { length: 80 }).notNull(),
  questionTemplateVersion: varchar("question_template_version", { length: 80 }).notNull(),
  catalogPolicyVersion: varchar("catalog_policy_version", { length: 80 }).notNull(),
  locale: varchar("locale", { length: 32 }).notNull(),
  storefront: varchar("storefront", { length: 16 }).notNull(),
  answerLineageHash: varchar("answer_lineage_hash", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("playlist_contract_brief_revision_idx").on(table.briefRequestId, table.revision),
  uniqueIndex("playlist_contract_run_revision_idx").on(table.runId, table.revision),
  uniqueIndex("playlist_contract_brief_hash_idx").on(table.briefRequestId, table.contractHash),
  uniqueIndex("playlist_contract_run_hash_idx").on(table.runId, table.contractHash),
  index("playlist_contract_parent_idx").on(table.parentRevisionId),
  index("playlist_contract_status_idx").on(table.status, table.createdAt),
  check("playlist_contract_owner_valid", sql`num_nonnulls(${table.briefRequestId}, ${table.runId}) = 1`),
  check("playlist_contract_revision_positive", sql`${table.revision} > 0`),
  check("playlist_contract_status_valid", sql`${table.status} IN ('active','superseded','legacy_import')`),
]);

/** Immutable preflight or recovery estimate bound to one contract revision. */
export const playlistFeasibilitySnapshots = pgTable("playlist_feasibility_snapshots", {
  id: uuid("id").primaryKey(),
  contractRevisionId: uuid("contract_revision_id").notNull().references(() => playlistContractRevisions.id, { onDelete: "cascade" }),
  phase: varchar("phase", { length: 40 }).notNull(),
  assessment: varchar("assessment", { length: 40 }).notNull(),
  targetCount: integer("target_count").notNull(),
  observedQualifiedCount: integer("observed_qualified_count").notNull().default(0),
  projectedLowerCount: integer("projected_lower_count"),
  projectedUpperCount: integer("projected_upper_count"),
  confidence: numeric("confidence", { precision: 5, scale: 4, mode: "number" }),
  reportHash: varchar("report_hash", { length: 64 }).notNull(),
  reportJson: jsonb("report_json").notNull(),
  invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("playlist_feasibility_contract_hash_idx").on(table.contractRevisionId, table.reportHash),
  index("playlist_feasibility_contract_idx").on(table.contractRevisionId, table.createdAt),
  check("playlist_feasibility_phase_valid", sql`${table.phase} IN ('initial','post_guidance','recovery')`),
  check("playlist_feasibility_assessment_valid", sql`${table.assessment} IN ('contradictory','known_ceiling','likely','at_risk','unknown','frontier_exhausted_under_policy')`),
  check("playlist_feasibility_counts_valid", sql`
    ${table.targetCount} BETWEEN 1 AND 1000
    AND ${table.observedQualifiedCount} >= 0
    AND (${table.projectedLowerCount} IS NULL OR ${table.projectedLowerCount} >= 0)
    AND (${table.projectedUpperCount} IS NULL OR ${table.projectedUpperCount} >= 0)
    AND (${table.projectedLowerCount} IS NULL OR ${table.projectedUpperCount} IS NULL OR ${table.projectedLowerCount} <= ${table.projectedUpperCount})
  `),
  check("playlist_feasibility_confidence_valid", sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 1)`),
]);

/**
 * Orthogonal worker-attempt ledger. Fencing data lives here rather than being
 * inferred from the user-facing run state.
 */
export const playlistExecutionAttempts = pgTable("playlist_execution_attempts", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  contractRevisionId: uuid("contract_revision_id").notNull().references(() => playlistContractRevisions.id, { onDelete: "cascade" }),
  jobId: uuid("job_id"),
  queryPlanRevisionId: uuid("query_plan_revision_id")
    .references(() => queryPlanRevisions.id, { onDelete: "cascade" }),
  stage: varchar("stage", { length: 80 }).notNull(),
  dependencyKey: varchar("dependency_key", { length: 120 }),
  attemptNumber: integer("attempt_number").notNull(),
  leaseGeneration: integer("lease_generation").notNull(),
  executorRevision: varchar("executor_revision", { length: 160 }).notNull(),
  executorIdentityHash: varchar("executor_identity_hash", { length: 64 }).notNull(),
  executorCapabilityHash: varchar("executor_capability_hash", { length: 64 }),
  executorCapabilityVector: jsonb("executor_capability_vector"),
  configurationHash: varchar("configuration_hash", { length: 64 }).notNull(),
  semanticExecutionConfigurationHash: varchar(
    "semantic_execution_configuration_hash",
    { length: 64 },
  ),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
  checkpointCursor: varchar("checkpoint_cursor", { length: 240 }),
  status: varchar("status", { length: 40 }).notNull(),
  blockerKind: varchar("blocker_kind", { length: 64 }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull(),
  activeComputeMs: bigint("active_compute_ms", { mode: "number" }).notNull().default(0),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("playlist_execution_attempt_idempotency_idx").on(table.idempotencyKey),
  uniqueIndex("playlist_execution_attempt_generation_idx").on(
    table.runId,
    table.contractRevisionId,
    table.stage,
    table.attemptNumber,
    table.leaseGeneration,
  ),
  index("playlist_execution_attempt_run_idx").on(table.runId, table.startedAt),
  index("playlist_execution_attempt_job_generation_idx").on(
    table.jobId,
    table.leaseGeneration,
    table.status,
  ),
  index("playlist_execution_attempt_query_plan_idx").on(
    table.runId,
    table.contractRevisionId,
    table.queryPlanRevisionId,
    table.stage,
    table.status,
  ),
  check("playlist_execution_attempt_numbers_valid", sql`${table.attemptNumber} > 0 AND ${table.leaseGeneration} >= 0`),
  check("playlist_execution_attempt_identity_valid", sql`${table.executorIdentityHash} ~ '^[0-9a-f]{64}$'`),
  check(
    "playlist_execution_attempt_semantic_identity_valid",
    sql`${table.semanticExecutionConfigurationHash} IS NULL OR ${table.semanticExecutionConfigurationHash} ~ '^[0-9a-f]{64}$'`,
  ),
  check("playlist_execution_attempt_status_valid", sql`${table.status} IN ('queued','running','blocked','complete','cancelled','discarded','failed')`),
]);

/** Durable dependency or user-input blocker with a bounded retry horizon. */
export const playlistRunBlockers = pgTable("playlist_run_blockers", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  contractRevisionId: uuid("contract_revision_id").notNull().references(() => playlistContractRevisions.id, { onDelete: "cascade" }),
  blockerKind: varchar("blocker_kind", { length: 64 }).notNull(),
  dependencyKey: varchar("dependency_key", { length: 120 }),
  retryCount: integer("retry_count").notNull().default(0),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  automaticRetryUntil: timestamp("automatic_retry_until", { withTimezone: true }),
  stateJson: jsonb("state_json").notNull().default({}),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("playlist_run_blocker_active_idx").on(table.runId, table.resolvedAt, table.nextRetryAt),
  check("playlist_run_blocker_retry_valid", sql`${table.retryCount} >= 0`),
  check("playlist_run_blocker_kind_valid", sql`${table.blockerKind} IN ('guidance','scope_decision','provider','apple_authorization','budget','integrity','publication_reconciliation')`),
]);

export const guidanceQuestionSets = pgTable("guidance_question_sets", {
  id: uuid("id").primaryKey(),
  briefRequestId: uuid("brief_request_id").references(() => briefRequests.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => researchRuns.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  questionSetHash: varchar("question_set_hash", { length: 64 }).notNull(),
  requestClassification: varchar("request_classification", { length: 40 }).notNull(),
  generationMode: varchar("generation_mode", { length: 40 }).notNull(),
  guidancePolicyVersion: varchar("guidance_policy_version", { length: 80 }).notNull(),
  locale: varchar("locale", { length: 32 }).notNull(),
  storefront: varchar("storefront", { length: 16 }).notNull(),
  targetTrackCount: integer("target_track_count").notNull(),
  explicitConstraintHash: varchar("explicit_constraint_hash", { length: 64 }).notNull(),
  baseContractRevisionId: uuid("base_contract_revision_id").references(() => playlistContractRevisions.id, { onDelete: "set null" }),
  parentQuestionSetId: uuid("parent_question_set_id"),
  feasibilitySnapshotId: uuid("feasibility_snapshot_id").references(() => playlistFeasibilitySnapshots.id, { onDelete: "set null" }),
  guidanceRound: varchar("guidance_round", { length: 24 }).notNull().default("initial"),
  trigger: varchar("trigger", { length: 24 }).notNull().default("nuance"),
  axis: varchar("axis", { length: 80 }),
  rejectedQuestionReasonsJson: jsonb("rejected_question_reasons_json").notNull().default([]),
  questionsJson: jsonb("questions_json").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("guidance_question_sets_revision_idx").on(table.briefRequestId, table.revision),
  uniqueIndex("guidance_question_sets_run_revision_idx").on(table.runId, table.revision),
  uniqueIndex("guidance_question_sets_hash_idx").on(table.briefRequestId, table.questionSetHash),
  uniqueIndex("guidance_question_sets_run_hash_idx").on(table.runId, table.questionSetHash),
  uniqueIndex("guidance_question_sets_active_idx").on(table.briefRequestId).where(sql`${table.active}`),
  uniqueIndex("guidance_question_sets_run_active_idx").on(table.runId).where(sql`${table.active}`),
  index("guidance_question_sets_policy_idx").on(table.guidancePolicyVersion, table.createdAt),
  check("guidance_question_sets_owner_valid", sql`num_nonnulls(${table.briefRequestId}, ${table.runId}) = 1`),
  check("guidance_question_sets_round_valid", sql`${table.guidanceRound} IN ('initial','rescue')`),
  check("guidance_question_sets_trigger_valid", sql`${table.trigger} IN ('correctness','yield_risk','nuance')`),
]);

export const guidanceAnswerSets = pgTable("guidance_answer_sets", {
  id: uuid("id").primaryKey(),
  briefRequestId: uuid("brief_request_id").references(() => briefRequests.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => researchRuns.id, { onDelete: "cascade" }),
  questionSetId: uuid("question_set_id").notNull().references(() => guidanceQuestionSets.id, { onDelete: "cascade" }),
  questionSetHash: varchar("question_set_hash", { length: 64 }).notNull(),
  normalizedAnswersJson: jsonb("normalized_answers_json").notNull(),
  rawCustomAnswersJson: jsonb("raw_custom_answers_json").notNull().default([]),
  answerHash: varchar("answer_hash", { length: 64 }).notNull(),
  executionDeltaJson: jsonb("execution_delta_json").notNull(),
  executionDeltaHash: varchar("execution_delta_hash", { length: 64 }).notNull(),
  baseContractRevisionId: uuid("base_contract_revision_id").references(() => playlistContractRevisions.id, { onDelete: "set null" }),
  resultingContractRevisionId: uuid("resulting_contract_revision_id").references(() => playlistContractRevisions.id, { onDelete: "set null" }),
  resultingSelectionPlanId: uuid("resulting_selection_plan_id").references(() => selectionPlans.id, { onDelete: "set null" }),
  resultingQueryPlanRevisionId: uuid("resulting_query_plan_revision_id").references(() => queryPlanRevisions.id, { onDelete: "set null" }),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
  invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("guidance_answer_sets_idempotency_idx").on(table.briefRequestId, table.idempotencyKey),
  uniqueIndex("guidance_answer_sets_run_idempotency_idx").on(table.runId, table.idempotencyKey),
  uniqueIndex("guidance_answer_sets_hash_idx").on(table.briefRequestId, table.answerHash),
  uniqueIndex("guidance_answer_sets_run_hash_idx").on(table.runId, table.answerHash),
  index("guidance_answer_sets_question_set_idx").on(table.questionSetId, table.acceptedAt),
  check("guidance_answer_sets_owner_valid", sql`num_nonnulls(${table.briefRequestId}, ${table.runId}) = 1`),
]);

export const runStageMetricSummaries = pgTable("run_stage_metric_summaries", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  queryPlanRevisionId: uuid("query_plan_revision_id").references(() => queryPlanRevisions.id, { onDelete: "cascade" }),
  stageKey: varchar("stage_key", { length: 120 }).notNull(),
  metricRevision: integer("metric_revision").notNull().default(1),
  providerRows: integer("provider_rows").notNull().default(0),
  uniqueValidLeads: integer("unique_valid_leads").notNull().default(0),
  requalificationAttempts: integer("requalification_attempts").notNull().default(0),
  citationBearingLeads: integer("citation_bearing_leads").notNull().default(0),
  exactPairAttestations: integer("exact_pair_attestations").notNull().default(0),
  containersDiscovered: integer("containers_discovered").notNull().default(0),
  containersEnumerated: integer("containers_enumerated").notNull().default(0),
  scopeBoundCandidates: integer("scope_bound_candidates").notNull().default(0),
  evidenceQualifiedCandidates: integer("evidence_qualified_candidates").notNull().default(0),
  appleResolutionAttempts: integer("apple_resolution_attempts").notNull().default(0),
  appleProviderRequests: integer("apple_provider_requests").notNull().default(0),
  appleMatches: integer("apple_matches").notNull().default(0),
  recordingFamilies: integer("recording_families").notNull().default(0),
  selectedCount: integer("selected_count").notNull().default(0),
  reserveCount: integer("reserve_count").notNull().default(0),
  manifestedCount: integer("manifested_count").notNull().default(0),
  publishedCount: integer("published_count").notNull().default(0),
  stopReason: varchar("stop_reason", { length: 120 }),
  rootCause: varchar("root_cause", { length: 160 }),
  downstreamState: varchar("downstream_state", { length: 160 }),
  terminal: boolean("terminal").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("run_stage_metric_summaries_revision_idx").on(
    table.runId,
    table.queryPlanRevisionId,
    table.stageKey,
    table.metricRevision,
  ),
  index("run_stage_metric_summaries_run_idx").on(table.runId, table.createdAt),
]);

export const providerMetricEvents = pgTable("provider_metric_events", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").references(() => researchRuns.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 80 }).notNull(),
  operation: varchar("operation", { length: 120 }).notNull(),
  stageKey: varchar("stage_key", { length: 120 }).notNull(),
  metricName: varchar("metric_name", { length: 120 }).notNull(),
  metricValue: integer("metric_value").notNull(),
  requestOutcome: varchar("request_outcome", { length: 48 }).notNull(),
  cacheOutcome: varchar("cache_outcome", { length: 48 }),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull().unique(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("provider_metric_events_run_idx").on(table.runId, table.occurredAt),
  index("provider_metric_events_expiry_idx").on(table.expiresAt),
]);

export const runSourceObservations = pgTable("run_source_observations", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  queryPlanRevisionId: uuid("query_plan_revision_id").references(() => queryPlanRevisions.id, { onDelete: "cascade" }),
  providerMetricEventId: uuid("provider_metric_event_id").references(() => providerMetricEvents.id, { onDelete: "set null" }),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull().unique(),
  allowedHost: varchar("allowed_host", { length: 240 }).notNull(),
  resourceType: varchar("resource_type", { length: 80 }).notNull(),
  extractionMethod: varchar("extraction_method", { length: 80 }).notNull(),
  attemptOutcome: varchar("attempt_outcome", { length: 80 }).notNull(),
  locatorHash: varchar("locator_hash", { length: 64 }).notNull(),
  providerRows: integer("provider_rows").notNull().default(0),
  uniqueValidLeads: integer("unique_valid_leads").notNull().default(0),
  citationBearingLeads: integer("citation_bearing_leads").notNull().default(0),
  exactPairAttestations: integer("exact_pair_attestations").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("run_source_observations_run_idx").on(table.runId, table.createdAt)]);

export const providerMetricDailyAggregates = pgTable("provider_metric_daily_aggregates", {
  metricDate: date("metric_date").notNull(),
  provider: varchar("provider", { length: 80 }).notNull(),
  operation: varchar("operation", { length: 120 }).notNull(),
  metricName: varchar("metric_name", { length: 120 }).notNull(),
  metricValue: bigint("metric_value", { mode: "number" }).notNull().default(0),
  eventCount: bigint("event_count", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.metricDate, table.provider, table.operation, table.metricName] }),
  index("provider_metric_daily_expiry_idx").on(table.expiresAt),
]);

export const qualityIncidentGroups = pgTable("quality_incident_groups", {
  id: uuid("id").primaryKey(),
  incidentSignature: varchar("incident_signature", { length: 64 }).notNull().unique(),
  incidentClass: varchar("incident_class", { length: 80 }).notNull(),
  stopReason: varchar("stop_reason", { length: 120 }),
  rootCause: varchar("root_cause", { length: 160 }),
  downstreamState: varchar("downstream_state", { length: 160 }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  totalCount: bigint("total_count", { mode: "number" }).notNull().default(0),
  overflowCount: bigint("overflow_count", { mode: "number" }).notNull().default(0),
  qaPromoted: boolean("qa_promoted").notNull().default(false),
  qaPromotedAt: timestamp("qa_promoted_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ...timestamps,
}, (table) => [index("quality_incident_groups_expiry_idx").on(table.expiresAt)]);

export const qualityIncidentDailyCounters = pgTable("quality_incident_daily_counters", {
  incidentDate: date("incident_date").primaryKey(),
  detailedCount: integer("detailed_count").notNull().default(0),
  overflowCount: integer("overflow_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const qualityIncidentEventKeys = pgTable("quality_incident_event_keys", {
  eventHash: varchar("event_hash", { length: 64 }).primaryKey(),
  incidentDate: date("incident_date").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("quality_incident_event_keys_expiry_idx").on(table.expiresAt)]);

export const qualityIncidentOccurrences = pgTable("quality_incident_occurrences", {
  id: uuid("id").primaryKey(),
  groupId: uuid("group_id").notNull().references(() => qualityIncidentGroups.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => researchRuns.id, { onDelete: "cascade" }),
  runAccessId: uuid("run_access_id").references(() => runAccesses.id, { onDelete: "cascade" }),
  briefRequestId: uuid("brief_request_id").references(() => briefRequests.id, { onDelete: "cascade" }),
  planRevision: integer("plan_revision"),
  terminalOutcomeHash: varchar("terminal_outcome_hash", { length: 64 }).notNull(),
  stopReason: varchar("stop_reason", { length: 120 }),
  rootCause: varchar("root_cause", { length: 160 }),
  downstreamState: varchar("downstream_state", { length: 160 }),
  diagnosticsJson: jsonb("diagnostics_json").notNull().default({}),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull().unique(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("quality_incident_occurrences_group_idx").on(table.groupId, table.occurredAt),
  index("quality_incident_occurrences_run_idx").on(table.runId, table.occurredAt),
  index("quality_incident_occurrences_expiry_idx").on(table.expiresAt),
]);

export const runAccesses = pgTable("run_accesses", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  briefRequestId: uuid("brief_request_id").references(() => briefRequests.id, { onDelete: "set null" }),
  prompt: text("prompt"),
  clientBucket: varchar("client_bucket", { length: 160 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("run_access_bucket_idempotency_idx").on(table.clientBucket, table.idempotencyKey),
  index("run_access_run_idx").on(table.runId),
  index("run_access_brief_request_idx").on(table.briefRequestId),
]);

export const capabilitySessionAccesses = pgTable("capability_session_accesses", {
  sessionId: uuid("session_id").notNull().references(() => capabilitySessions.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  accessId: uuid("access_id").notNull().references(() => runAccesses.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.sessionId, table.accessId], name: "capability_session_accesses_pkey" }),
  index("capability_session_access_created_idx").on(table.sessionId, table.createdAt),
  index("capability_session_access_access_idx").on(table.accessId),
]);

export const capabilitySessionBriefs = pgTable("capability_session_briefs", {
  sessionId: uuid("session_id").notNull().references(() => capabilitySessions.id, { onDelete: "cascade" }),
  briefRequestId: uuid("brief_request_id").notNull().references(() => briefRequests.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.sessionId, table.briefRequestId], name: "capability_session_briefs_pkey" }),
  index("capability_session_brief_request_idx").on(table.briefRequestId),
]);

export const capabilityTokens = pgTable("capability_tokens", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  accessId: uuid("access_id").notNull().references(() => runAccesses.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  purpose: varchar("purpose", { length: 32 }).notNull().default("exchange"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("capability_token_run_idx").on(table.runId)]);

/** Governed, cross-run corpus. New observations enter quarantine first. */
export const corpusEntities = pgTable("corpus_entities", {
  id: uuid("id").primaryKey(),
  entityType: varchar("entity_type", { length: 48 }).notNull(),
  canonicalKey: text("canonical_key").notNull(),
  canonicalName: varchar("canonical_name", { length: 240 }).notNull(),
  state: varchar("state", { length: 32 }).notNull().default("active"),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  ...timestamps,
}, (table) => [
  uniqueIndex("corpus_entity_type_key_idx").on(table.entityType, table.canonicalKey),
  index("corpus_entity_name_idx").on(table.canonicalName),
]);

export const corpusEntityAliases = pgTable("corpus_entity_aliases", {
  id: uuid("id").primaryKey(),
  entityId: uuid("entity_id").notNull().references(() => corpusEntities.id, { onDelete: "cascade" }),
  alias: varchar("alias", { length: 240 }).notNull(),
  normalizedAlias: varchar("normalized_alias", { length: 240 }).notNull(),
  locale: varchar("locale", { length: 32 }),
  provider: varchar("provider", { length: 48 }).notNull().default("internal"),
  confidence: numeric("confidence", { precision: 8, scale: 6, mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("corpus_entity_alias_unique_idx").on(table.entityId, table.normalizedAlias, table.provider),
  index("corpus_entity_alias_lookup_idx").on(table.normalizedAlias),
]);

export const corpusRecordings = pgTable("corpus_recordings", {
  id: uuid("id").primaryKey(),
  canonicalKey: text("canonical_key").notNull().unique(),
  primaryArtistEntityId: uuid("primary_artist_entity_id").references(() => corpusEntities.id, { onDelete: "set null" }),
  title: varchar("title", { length: 240 }).notNull(),
  versionClass: varchar("version_class", { length: 48 }).notNull().default("unknown"),
  state: varchar("state", { length: 32 }).notNull().default("active"),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  ...timestamps,
}, (table) => [
  index("corpus_recording_artist_title_idx").on(table.primaryArtistEntityId, table.title),
]);

export const corpusReleases = pgTable("corpus_releases", {
  id: uuid("id").primaryKey(),
  canonicalKey: text("canonical_key").notNull().unique(),
  primaryArtistEntityId: uuid("primary_artist_entity_id").references(() => corpusEntities.id, { onDelete: "set null" }),
  title: varchar("title", { length: 240 }).notNull(),
  releaseDate: varchar("release_date", { length: 40 }),
  state: varchar("state", { length: 32 }).notNull().default("active"),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  ...timestamps,
}, (table) => [index("corpus_release_artist_title_idx").on(table.primaryArtistEntityId, table.title)]);

export const corpusReleaseRecordings = pgTable("corpus_release_recordings", {
  releaseId: uuid("release_id").notNull().references(() => corpusReleases.id, { onDelete: "cascade" }),
  recordingId: uuid("recording_id").notNull().references(() => corpusRecordings.id, { onDelete: "cascade" }),
  discNumber: integer("disc_number"),
  trackNumber: integer("track_number"),
  scope: varchar("scope", { length: 32 }).notNull().default("track"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.releaseId, table.recordingId], name: "corpus_release_recordings_pkey" }),
  index("corpus_release_recording_recording_idx").on(table.recordingId),
]);

export const corpusSourceDocuments = pgTable("corpus_source_documents", {
  id: uuid("id").primaryKey(),
  url: text("url").notNull(),
  contentHash: varchar("content_hash", { length: 64 }).notNull(),
  title: varchar("title", { length: 240 }).notNull(),
  sourceClass: varchar("source_class", { length: 48 }).notNull(),
  provenanceRoot: varchar("provenance_root", { length: 240 }).notNull(),
  accessMethod: varchar("access_method", { length: 40 }).notNull(),
  approvalState: varchar("approval_state", { length: 24 }).notNull().default("pending"),
  authority: varchar("authority", { length: 48 }).notNull().default("unknown"),
  licenseState: varchar("license_state", { length: 32 }).notNull().default("unknown"),
  licenseVersion: varchar("license_version", { length: 160 }),
  termsVersion: varchar("terms_version", { length: 160 }),
  attribution: text("attribution"),
  cachePolicy: varchar("cache_policy", { length: 40 }).notNull().default("excerpt_only"),
  retentionPolicy: varchar("retention_policy", { length: 40 }).notNull().default("ninety_days"),
  freshnessPolicy: varchar("freshness_policy", { length: 40 }).notNull().default("revalidate_30d"),
  freshnessExpiresAt: timestamp("freshness_expires_at", { withTimezone: true }),
  sourceRevision: varchar("source_revision", { length: 160 }).notNull(),
  approvedBy: varchar("approved_by", { length: 120 }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  takedownReason: varchar("takedown_reason", { length: 500 }),
  takenDownAt: timestamp("taken_down_at", { withTimezone: true }),
  status: varchar("status", { length: 32 }).notNull().default("active"),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("corpus_source_url_hash_idx").on(table.url, table.contentHash),
  index("corpus_source_provenance_idx").on(table.provenanceRoot),
  index("corpus_source_governance_idx").on(table.approvalState, table.status, table.freshnessExpiresAt),
  check("corpus_source_content_hash_valid", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
  check("corpus_source_status_valid", sql`${table.status} IN ('active','stale','takedown','revoked')`),
  check("corpus_source_access_method_valid", sql`${table.accessMethod} IN ('hosted_web_search','structured_adapter','public_api','owner_import','manual_entry')`),
  check("corpus_source_approval_state_valid", sql`${table.approvalState} IN ('pending','approved','rejected')`),
  check("corpus_source_authority_valid", sql`${table.authority} IN ('primary_track_credit','official_track_credit','specialist_track_credit','trusted_editorial_container','secondary_database','catalog_metadata','unknown')`),
  check("corpus_source_license_state_valid", sql`${table.licenseState} IN ('reusable','permission_recorded','unknown','prohibited')`),
  check("corpus_source_cache_policy_valid", sql`${table.cachePolicy} IN ('no_store','metadata_only','excerpt_only','full_document_permitted')`),
  check("corpus_source_retention_policy_valid", sql`${table.retentionPolicy} IN ('run_only','ninety_days','durable_public_corpus','license_term')`),
  check("corpus_source_freshness_policy_valid", sql`${table.freshnessPolicy} IN ('immutable_revision','revalidate_30d','revalidate_90d')`),
]);

export const corpusAssertionObservations = pgTable("corpus_assertion_observations", {
  id: uuid("id").primaryKey(),
  observationKey: varchar("observation_key", { length: 64 }).notNull().unique(),
  sourceDocumentId: uuid("source_document_id").notNull().references(() => corpusSourceDocuments.id),
  subjectEntityId: uuid("subject_entity_id").references(() => corpusEntities.id, { onDelete: "set null" }),
  recordingId: uuid("recording_id").references(() => corpusRecordings.id, { onDelete: "set null" }),
  releaseId: uuid("release_id").references(() => corpusReleases.id, { onDelete: "set null" }),
  predicate: varchar("predicate", { length: 160 }).notNull(),
  objectJson: jsonb("object_json").notNull(),
  creditScope: varchar("credit_scope", { length: 48 }),
  supportExcerpt: varchar("support_excerpt", { length: 1000 }).notNull(),
  confidence: numeric("confidence", { precision: 8, scale: 6, mode: "number" }).notNull().default(0),
  status: varchar("status", { length: 32 }).notNull().default("quarantined"),
  pipelineVersion: varchar("pipeline_version", { length: 48 }).notNull(),
  policyVersion: varchar("policy_version", { length: 80 }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("corpus_observation_status_time_idx").on(table.status, table.observedAt),
  index("corpus_observation_recording_idx").on(table.recordingId, table.predicate),
]);

export const corpusPromotedAssertions = pgTable("corpus_promoted_assertions", {
  id: uuid("id").primaryKey(),
  assertionKey: varchar("assertion_key", { length: 64 }).notNull().unique(),
  subjectEntityId: uuid("subject_entity_id").references(() => corpusEntities.id, { onDelete: "set null" }),
  recordingId: uuid("recording_id").references(() => corpusRecordings.id, { onDelete: "set null" }),
  releaseId: uuid("release_id").references(() => corpusReleases.id, { onDelete: "set null" }),
  predicate: varchar("predicate", { length: 160 }).notNull(),
  objectJson: jsonb("object_json").notNull(),
  evidenceTier: varchar("evidence_tier", { length: 32 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default("active"),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
  validTo: timestamp("valid_to", { withTimezone: true }),
  promotedAt: timestamp("promoted_at", { withTimezone: true }).notNull().defaultNow(),
  retractedAt: timestamp("retracted_at", { withTimezone: true }),
  promotedBy: varchar("promoted_by", { length: 120 }).notNull(),
  metadataJson: jsonb("metadata_json").notNull().default({}),
}, (table) => [
  index("corpus_assertion_recording_idx").on(table.recordingId, table.predicate, table.status),
  index("corpus_assertion_subject_idx").on(table.subjectEntityId, table.predicate, table.status),
]);

export const corpusAssertionEvidence = pgTable("corpus_assertion_evidence", {
  promotedAssertionId: uuid("promoted_assertion_id").notNull().references(() => corpusPromotedAssertions.id, { onDelete: "cascade" }),
  observationId: uuid("observation_id").notNull().references(() => corpusAssertionObservations.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.promotedAssertionId, table.observationId], name: "corpus_assertion_evidence_pkey" }),
  index("corpus_assertion_evidence_observation_idx").on(table.observationId),
]);

export const corpusCatalogIdentities = pgTable("corpus_catalog_identities", {
  id: uuid("id").primaryKey(),
  recordingId: uuid("recording_id").notNull().references(() => corpusRecordings.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 40 }).notNull(),
  storefront: varchar("storefront", { length: 16 }).notNull(),
  catalogId: varchar("catalog_id", { length: 160 }).notNull(),
  isPreferred: boolean("is_preferred").notNull().default(false),
  isAvailable: boolean("is_available").notNull().default(true),
  identityConfidence: numeric("identity_confidence", { precision: 8, scale: 6, mode: "number" }).notNull().default(0),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("corpus_catalog_identity_unique_idx").on(table.recordingId, table.provider, table.storefront, table.catalogId),
  index("corpus_catalog_identity_lookup_idx").on(table.provider, table.storefront, table.catalogId),
]);

export const graphSnapshotAssertions = pgTable("graph_snapshot_assertions", {
  graphSnapshotId: uuid("graph_snapshot_id").notNull().references(() => graphSnapshots.id, { onDelete: "cascade" }),
  assertionId: uuid("assertion_id").notNull().references(() => corpusPromotedAssertions.id),
  assertionRevisionJson: jsonb("assertion_revision_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.graphSnapshotId, table.assertionId], name: "graph_snapshot_assertions_pkey" }),
  index("graph_snapshot_assertion_assertion_idx").on(table.assertionId),
]);

export const graphSnapshotCatalogIdentities = pgTable("graph_snapshot_catalog_identities", {
  graphSnapshotId: uuid("graph_snapshot_id").notNull().references(() => graphSnapshots.id, { onDelete: "cascade" }),
  catalogIdentityId: uuid("catalog_identity_id").notNull().references(() => corpusCatalogIdentities.id),
  catalogIdentityRevisionJson: jsonb("catalog_identity_revision_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.graphSnapshotId, table.catalogIdentityId], name: "graph_snapshot_catalog_identities_pkey" }),
  index("graph_snapshot_catalog_identity_identity_idx").on(table.catalogIdentityId),
]);

export const sourceRecords = pgTable("source_records", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  title: varchar("title", { length: 240 }).notNull(),
  sourceClass: varchar("source_class", { length: 40 }).notNull(),
  provenanceRoot: varchar("provenance_root", { length: 240 }).notNull(),
  note: varchar("note", { length: 500 }).notNull(),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("source_run_url_idx").on(table.runId, table.url)]);

export const recordingFamilies = pgTable("recording_families", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  familyKey: text("family_key").notNull(),
  canonicalArtist: varchar("canonical_artist", { length: 240 }).notNull(),
  canonicalTitle: varchar("canonical_title", { length: 240 }).notNull(),
  versionClass: varchar("version_class", { length: 40 }).notNull().default("unknown"),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  pipelineVersion: varchar("pipeline_version", { length: 48 }).notNull().default("legacy_v1"),
  policyVersion: varchar("policy_version", { length: 80 }).notNull().default("legacy_v1"),
  ...timestamps,
}, (table) => [
  uniqueIndex("recording_family_run_key_idx").on(table.runId, table.familyKey),
  index("recording_family_run_version_idx").on(table.runId, table.versionClass),
]);

export const trackCandidates = pgTable("track_candidates", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  canonicalKey: text("canonical_key").notNull(),
  duplicateClusterKey: text("duplicate_cluster_key"),
  recordingFamilyId: uuid("recording_family_id").references(() => recordingFamilies.id, { onDelete: "set null" }),
  candidateStage: varchar("candidate_stage", { length: 48 }).notNull().default("discovered"),
  stageUpdatedAt: timestamp("stage_updated_at", { withTimezone: true }).notNull().defaultNow(),
  pipelineVersion: varchar("pipeline_version", { length: 48 }).notNull().default("legacy_v1"),
  policyVersion: varchar("policy_version", { length: 80 }).notNull().default("legacy_v1"),
  selectionRank: integer("selection_rank"),
  artist: varchar("artist", { length: 240 }).notNull(),
  title: varchar("title", { length: 240 }).notNull(),
  album: varchar("album", { length: 240 }),
  releaseYear: integer("release_year"),
  durationMs: integer("duration_ms"),
  isrc: varchar("isrc", { length: 32 }),
  musicbrainzId: varchar("musicbrainz_id", { length: 80 }),
  versionLabel: varchar("version_label", { length: 120 }),
  outcome: varchar("outcome", { length: 40 }).notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("candidate_run_key_idx").on(table.runId, table.canonicalKey),
  index("candidate_duplicate_cluster_idx").on(table.runId, table.duplicateClusterKey),
  index("candidate_recording_family_idx").on(table.recordingFamilyId),
  index("candidate_run_stage_idx").on(table.runId, table.candidateStage),
  index("candidate_selection_rank_idx").on(table.runId, table.selectionRank),
  index("candidate_run_outcome_idx").on(table.runId, table.outcome),
]);

export const recordingFamilyCandidates = pgTable("recording_family_candidates", {
  recordingFamilyId: uuid("recording_family_id").notNull().references(() => recordingFamilies.id, { onDelete: "cascade" }),
  candidateId: uuid("candidate_id").notNull().references(() => trackCandidates.id, { onDelete: "cascade" }),
  relationship: varchar("relationship", { length: 40 }).notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.recordingFamilyId, table.candidateId], name: "recording_family_candidates_pkey" }),
  uniqueIndex("recording_family_candidate_unique_idx").on(table.candidateId),
]);

export const recordingCatalogIdentities = pgTable("recording_catalog_identities", {
  id: uuid("id").primaryKey(),
  recordingFamilyId: uuid("recording_family_id").notNull().references(() => recordingFamilies.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 40 }).notNull(),
  storefront: varchar("storefront", { length: 16 }),
  catalogId: varchar("catalog_id", { length: 160 }).notNull(),
  isPreferred: boolean("is_preferred").notNull().default(false),
  identityConfidence: numeric("identity_confidence", { precision: 8, scale: 6, mode: "number" }).notNull().default(0),
  artist: varchar("artist", { length: 240 }).notNull(),
  title: varchar("title", { length: 240 }).notNull(),
  album: varchar("album", { length: 240 }),
  isrc: varchar("isrc", { length: 32 }),
  musicbrainzId: varchar("musicbrainz_id", { length: 80 }),
  durationMs: integer("duration_ms"),
  versionLabel: varchar("version_label", { length: 120 }),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  ...timestamps,
}, (table) => [
  uniqueIndex("recording_catalog_identity_unique_idx").on(table.recordingFamilyId, table.provider, table.storefront, table.catalogId),
  index("recording_catalog_identity_lookup_idx").on(table.provider, table.storefront, table.catalogId),
  index("recording_catalog_identity_isrc_idx").on(table.isrc),
]);

/** Run-local evaluation linked to immutable global corpus identities. */
export const runCorpusRecordingLinks = pgTable("run_corpus_recording_links", {
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  candidateId: uuid("candidate_id").notNull().references(() => trackCandidates.id, { onDelete: "cascade" }),
  queryPlanRevisionId: uuid("query_plan_revision_id").notNull().references(() => queryPlanRevisions.id),
  graphSnapshotId: uuid("graph_snapshot_id").notNull().references(() => graphSnapshots.id),
  corpusRecordingId: uuid("corpus_recording_id").notNull().references(() => corpusRecordings.id),
  corpusCatalogIdentityId: uuid("corpus_catalog_identity_id").references(() => corpusCatalogIdentities.id),
  identityStatus: varchar("identity_status", { length: 32 }).notNull().default("pending"),
  membershipStatus: varchar("membership_status", { length: 32 }).notNull().default("pending"),
  relevanceStatus: varchar("relevance_status", { length: 32 }).notNull().default("pending"),
  selectionStatus: varchar("selection_status", { length: 32 }).notNull().default("pending"),
  publicationStatus: varchar("publication_status", { length: 32 }).notNull().default("pending"),
  rankingScore: numeric("ranking_score", { precision: 12, scale: 8, mode: "number" }),
  confidence: numeric("confidence", { precision: 8, scale: 6, mode: "number" }).notNull().default(0),
  reasonCodesJson: jsonb("reason_codes_json").notNull().default([]),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.candidateId], name: "run_corpus_recording_links_pkey" }),
  index("run_corpus_link_plan_status_idx").on(table.queryPlanRevisionId, table.selectionStatus),
  index("run_corpus_link_recording_idx").on(table.corpusRecordingId),
]);

export const citationAttestations = pgTable("citation_attestations", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  attestationKey: varchar("attestation_key", { length: 64 }).notNull(),
  sourceUrl: text("source_url").notNull(),
  responseId: varchar("response_id", { length: 240 }).notNull(),
  outputItemId: varchar("output_item_id", { length: 240 }).notNull(),
  contentIndex: integer("content_index").notNull(),
  startIndex: integer("start_index").notNull(),
  endIndex: integer("end_index").notNull(),
  excerpt: varchar("excerpt", { length: 1000 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("citation_attestation_run_key_idx").on(table.runId, table.attestationKey),
  index("citation_attestation_run_idx").on(table.runId),
]);

export const evidenceClaims = pgTable("evidence_claims", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  candidateId: uuid("candidate_id").notNull().references(() => trackCandidates.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id").notNull().references(() => sourceRecords.id, { onDelete: "cascade" }),
  citationAttestationId: uuid("citation_attestation_id").references(() => citationAttestations.id, { onDelete: "set null" }),
  state: varchar("state", { length: 32 }).notNull(),
  supportScope: varchar("support_scope", { length: 32 }).notNull().default("collection"),
  verificationPhase: varchar("verification_phase", { length: 80 }).notNull().default("unverified"),
  subjectEntity: varchar("subject_entity", { length: 240 }).notNull(),
  subjectRelationship: varchar("subject_relationship", { length: 240 }).notNull(),
  relationship: varchar("relationship", { length: 240 }).notNull(),
  note: varchar("note", { length: 500 }).notNull(),
}, (table) => [
  uniqueIndex("evidence_claim_unique_idx").on(
    table.candidateId,
    table.sourceId,
    table.subjectEntity,
    table.subjectRelationship,
    table.relationship,
  ),
  index("evidence_run_idx").on(table.runId),
  index("evidence_citation_attestation_idx").on(table.citationAttestationId),
]);

export const sourceFrontier = pgTable("source_frontier", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  sourceClass: varchar("source_class", { length: 80 }).notNull(),
  strategy: varchar("strategy", { length: 240 }).notNull(),
  cursor: text("cursor"),
  status: varchar("status", { length: 32 }).notNull(),
  discoveredCount: integer("discovered_count").notNull().default(0),
  recoveredCount: integer("recovered_count").notNull().default(0),
  note: varchar("note", { length: 500 }).notNull(),
}, (table) => [uniqueIndex("frontier_run_strategy_idx").on(table.runId, table.sourceClass, table.strategy)]);

export const researchContainers = pgTable("research_containers", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  sourceRecordId: uuid("source_record_id").references(() => sourceRecords.id, { onDelete: "set null" }),
  parentContainerId: uuid("parent_container_id"),
  containerType: varchar("container_type", { length: 48 }).notNull(),
  providerId: varchar("provider_id", { length: 240 }).notNull(),
  title: varchar("title", { length: 240 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default("discovered"),
  cursor: text("cursor"),
  advertisedTotal: integer("advertised_total"),
  recoveredTotal: integer("recovered_total").notNull().default(0),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("container_run_provider_idx").on(table.runId, table.containerType, table.providerId),
  index("container_run_status_idx").on(table.runId, table.status),
]);

export const trackScopeBindings = pgTable("track_scope_bindings", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  candidateId: uuid("candidate_id").notNull().references(() => trackCandidates.id, { onDelete: "cascade" }),
  sourceRecordId: uuid("source_record_id").references(() => sourceRecords.id, { onDelete: "set null" }),
  sourceUrl: text("source_url"),
  researchContainerId: uuid("research_container_id").references(() => researchContainers.id, { onDelete: "set null" }),
  citationAttestationId: uuid("citation_attestation_id").references(() => citationAttestations.id, { onDelete: "set null" }),
  bindingKind: varchar("binding_kind", { length: 64 }).notNull(),
  eligibility: varchar("eligibility", { length: 32 }).notNull(),
  scopeAxis: varchar("scope_axis", { length: 48 }).notNull(),
  scopeValue: varchar("scope_value", { length: 240 }).notNull(),
  relationship: varchar("relationship", { length: 240 }).notNull(),
  confidence: numeric("confidence", { precision: 8, scale: 6, mode: "number" }).notNull().default(0),
  provenancePathJson: jsonb("provenance_path_json").notNull().default([]),
  note: varchar("note", { length: 500 }).notNull(),
  pipelineVersion: varchar("pipeline_version", { length: 48 }).notNull().default("legacy_v1"),
  policyVersion: varchar("policy_version", { length: 80 }).notNull().default("legacy_v1"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("scope_binding_run_candidate_idx").on(table.runId, table.candidateId),
  index("scope_binding_run_eligibility_idx").on(table.runId, table.eligibility),
  unique("scope_binding_unique_key").on(
    table.candidateId,
    table.bindingKind,
    table.scopeAxis,
    table.scopeValue,
    table.relationship,
    table.sourceRecordId,
    table.researchContainerId,
  ).nullsNotDistinct(),
]);

export const candidateStageEvents = pgTable("candidate_stage_events", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  candidateId: uuid("candidate_id").notNull().references(() => trackCandidates.id, { onDelete: "cascade" }),
  fromStage: varchar("from_stage", { length: 48 }),
  toStage: varchar("to_stage", { length: 48 }).notNull(),
  reasonCode: varchar("reason_code", { length: 120 }).notNull(),
  detailJson: jsonb("detail_json").notNull().default({}),
  pipelineVersion: varchar("pipeline_version", { length: 48 }).notNull().default("legacy_v1"),
  policyVersion: varchar("policy_version", { length: 80 }).notNull().default("legacy_v1"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("candidate_stage_event_run_time_idx").on(table.runId, table.occurredAt),
  index("candidate_stage_event_candidate_time_idx").on(table.candidateId, table.occurredAt),
]);

export const pipelineDeficitLedger = pgTable("pipeline_deficit_ledger", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  stage: varchar("stage", { length: 48 }).notNull(),
  kind: varchar("kind", { length: 64 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default("open"),
  requiredCount: integer("required_count").notNull().default(0),
  actualCount: integer("actual_count").notNull().default(0),
  deficitCount: integer("deficit_count").notNull().default(0),
  reasonCode: varchar("reason_code", { length: 120 }).notNull(),
  detailJson: jsonb("detail_json").notNull().default({}),
  pipelineVersion: varchar("pipeline_version", { length: 48 }).notNull().default("legacy_v1"),
  policyVersion: varchar("policy_version", { length: 80 }).notNull().default("legacy_v1"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("pipeline_deficit_run_time_idx").on(table.runId, table.observedAt),
  index("pipeline_deficit_run_status_idx").on(table.runId, table.status),
]);

export const pipelineOutcomes = pgTable("pipeline_outcomes", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }).unique(),
  status: varchar("status", { length: 40 }).notNull(),
  targetTrackCount: integer("target_track_count").notNull().default(0),
  discoveredTrackCount: integer("discovered_track_count").notNull().default(0),
  qualifiedTrackCount: integer("qualified_track_count").notNull().default(0),
  selectedTrackCount: integer("selected_track_count").notNull().default(0),
  publishedTrackCount: integer("published_track_count").notNull().default(0),
  exactCountSatisfied: boolean("exact_count_satisfied").notNull().default(false),
  frontierExhausted: boolean("frontier_exhausted").notNull().default(false),
  providerUnavailable: boolean("provider_unavailable").notNull().default(false),
  reasonCodesJson: jsonb("reason_codes_json").notNull().default([]),
  deficitSnapshotJson: jsonb("deficit_snapshot_json").notNull().default([]),
  outcomeJson: jsonb("outcome_json").notNull(),
  pipelineVersion: varchar("pipeline_version", { length: 48 }).notNull(),
  policyVersion: varchar("policy_version", { length: 80 }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
  ...timestamps,
}, (table) => [index("pipeline_outcome_status_idx").on(table.status, table.completedAt)]);

export const researchCheckpoints = pgTable("research_checkpoints", {
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  phase: varchar("phase", { length: 80 }).notNull(),
  stateJson: jsonb("state_json").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("checkpoint_run_phase_idx").on(table.runId, table.phase)]);

/** Storefront-scoped, provider-response cache used only by Pipeline V2 reads. */
export const appleCatalogCacheEntries = pgTable("apple_catalog_cache_entries", {
  storefront: varchar("storefront", { length: 16 }).notNull(),
  resourceKind: varchar("resource_kind", { length: 48 }).notNull(),
  requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull(),
  payloadJson: jsonb("payload_json").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({
    columns: [table.storefront, table.resourceKind, table.requestFingerprint],
    name: "apple_catalog_cache_entries_pkey",
  }),
  index("apple_catalog_cache_expiry_idx").on(table.expiresAt),
]);

/** Cross-worker cache-fill leases; an expired owner can always be replaced. */
export const appleCatalogCacheLeases = pgTable("apple_catalog_cache_leases", {
  storefront: varchar("storefront", { length: 16 }).notNull(),
  resourceKind: varchar("resource_kind", { length: 48 }).notNull(),
  requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull(),
  ownerId: uuid("owner_id").notNull(),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({
    columns: [table.storefront, table.resourceKind, table.requestFingerprint],
    name: "apple_catalog_cache_leases_pkey",
  }),
  index("apple_catalog_cache_lease_expiry_idx").on(table.expiresAt),
]);

/** Per-run hit/miss and upstream-state telemetry; never stores provider secrets. */
export const appleCatalogCacheEvents = pgTable("apple_catalog_cache_events", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  storefront: varchar("storefront", { length: 16 }).notNull(),
  resourceKind: varchar("resource_kind", { length: 48 }).notNull(),
  requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull(),
  cacheState: varchar("cache_state", { length: 32 }).notNull(),
  providerState: varchar("provider_state", { length: 32 }).notNull(),
  detailJson: jsonb("detail_json").notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("apple_catalog_cache_event_run_time_idx").on(table.runId, table.occurredAt),
  index("apple_catalog_cache_event_state_idx").on(table.cacheState, table.providerState, table.occurredAt),
]);

export const catalogMatches = pgTable("catalog_matches", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  candidateId: uuid("candidate_id").notNull().references(() => trackCandidates.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 40 }).notNull(),
  basis: text("basis").notNull(),
  score: numeric("score", { precision: 8, scale: 6, mode: "number" }).notNull(),
  catalogId: varchar("catalog_id", { length: 100 }),
  songJson: jsonb("song_json"),
  alternativesJson: jsonb("alternatives_json").notNull().default([]),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  // Immutable first matcher decision. Final status fields above may change
  // during review or manifest overflow, so benchmark precision must never be
  // reconstructed from them.
  initialStatus: varchar("initial_status", { length: 40 }),
  initialBasis: text("initial_basis"),
  initialScore: numeric("initial_score", { precision: 8, scale: 6, mode: "number" }),
  initialCatalogId: varchar("initial_catalog_id", { length: 100 }),
  initialSongJson: jsonb("initial_song_json"),
  initialMatchedAt: timestamp("initial_matched_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("match_candidate_idx").on(table.candidateId),
  index("match_run_status_idx").on(table.runId, table.status),
]);

export const manifests = pgTable("manifests", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 240 }).notNull(),
  description: text("description").notNull(),
  contentHash: varchar("content_hash", { length: 64 }).notNull(),
  pipelineVersion: varchar("pipeline_version", { length: 48 }).notNull().default("legacy_v1"),
  policyVersion: varchar("policy_version", { length: 80 }).notNull().default("legacy_v1"),
  selectionPlanJson: jsonb("selection_plan_json"),
  contractRevisionId: uuid("contract_revision_id")
    .references(() => playlistContractRevisions.id, { onDelete: "restrict" }),
  contractHash: varchar("contract_hash", { length: 64 }),
  partialConsentAnswerHash: varchar("partial_consent_answer_hash", { length: 64 }),
  lockedAt: timestamp("locked_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("manifest_run_unique_idx").on(table.runId),
  uniqueIndex("manifest_run_hash_idx").on(table.runId, table.contentHash),
]);

export const manifestTracks = pgTable("manifest_tracks", {
  manifestId: uuid("manifest_id").notNull().references(() => manifests.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  candidateId: uuid("candidate_id").notNull().references(() => trackCandidates.id),
  catalogId: varchar("catalog_id", { length: 100 }).notNull(),
  artist: varchar("artist", { length: 240 }).notNull(),
  title: varchar("title", { length: 240 }).notNull(),
}, (table) => [
  uniqueIndex("manifest_track_position_idx").on(table.manifestId, table.position),
  index("manifest_track_candidate_idx").on(table.candidateId),
]);

export const manifestRevisions = pgTable("manifest_revisions", {
  id: uuid("id").primaryKey(),
  manifestId: uuid("manifest_id").notNull().references(() => manifests.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  parentRevisionId: uuid("parent_revision_id"),
  status: varchar("status", { length: 32 }).notNull().default("draft"),
  reason: varchar("reason", { length: 500 }).notNull(),
  contentHash: varchar("content_hash", { length: 64 }).notNull(),
  pipelineVersion: varchar("pipeline_version", { length: 48 }).notNull(),
  policyVersion: varchar("policy_version", { length: 80 }).notNull(),
  /** Immutable V3 provenance bindings. Legacy V1/V2 revisions leave these null. */
  selectionPlanId: uuid("selection_plan_id").references(() => selectionPlans.id),
  queryPlanRevisionId: uuid("query_plan_revision_id").references(() => queryPlanRevisions.id),
  graphSnapshotId: uuid("graph_snapshot_id").references(() => graphSnapshots.id),
  runSpecHash: varchar("run_spec_hash", { length: 64 }),
  selectionPlanSnapshotJson: jsonb("selection_plan_snapshot_json"),
  pipelinePolicySnapshotJson: jsonb("pipeline_policy_snapshot_json"),
  outcomeSnapshotJson: jsonb("outcome_snapshot_json"),
  deficitSnapshotJson: jsonb("deficit_snapshot_json").notNull().default([]),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("manifest_revision_number_idx").on(table.manifestId, table.revision),
  uniqueIndex("manifest_revision_hash_idx").on(table.manifestId, table.contentHash),
  index("manifest_revision_parent_idx").on(table.parentRevisionId),
  index("manifest_revision_selection_plan_idx").on(table.selectionPlanId),
  index("manifest_revision_query_plan_idx").on(table.queryPlanRevisionId),
  index("manifest_revision_graph_snapshot_idx").on(table.graphSnapshotId),
  check("manifest_revision_v3_binding_presence_valid", sql`(
    (
      ${table.pipelineVersion}='corpus_first_v3'
      AND ${table.selectionPlanId} IS NOT NULL
      AND ${table.queryPlanRevisionId} IS NOT NULL
      AND ${table.graphSnapshotId} IS NOT NULL
      AND ${table.runSpecHash} IS NOT NULL
    ) OR (
      ${table.pipelineVersion}<>'corpus_first_v3'
      AND ${table.selectionPlanId} IS NULL
      AND ${table.queryPlanRevisionId} IS NULL
      AND ${table.graphSnapshotId} IS NULL
      AND ${table.runSpecHash} IS NULL
    )
  )`),
  check(
    "manifest_revision_run_spec_hash_valid",
    sql`${table.runSpecHash} IS NULL OR ${table.runSpecHash} ~ '^[0-9a-f]{64}$'`,
  ),
]);

export const manifestRevisionTracks = pgTable("manifest_revision_tracks", {
  manifestRevisionId: uuid("manifest_revision_id").notNull().references(() => manifestRevisions.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  candidateId: uuid("candidate_id").notNull().references(() => trackCandidates.id),
  recordingFamilyId: uuid("recording_family_id").references(() => recordingFamilies.id, { onDelete: "set null" }),
  catalogIdentityId: uuid("catalog_identity_id").references(() => recordingCatalogIdentities.id, { onDelete: "set null" }),
  catalogId: varchar("catalog_id", { length: 160 }).notNull(),
  artist: varchar("artist", { length: 240 }).notNull(),
  title: varchar("title", { length: 240 }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.manifestRevisionId, table.position], name: "manifest_revision_tracks_pkey" }),
  index("manifest_revision_track_candidate_idx").on(table.candidateId),
  index("manifest_revision_track_family_idx").on(table.recordingFamilyId),
]);

export const manifestRevisionReserveTracks = pgTable("manifest_revision_reserve_tracks", {
  manifestRevisionId: uuid("manifest_revision_id").notNull().references(() => manifestRevisions.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  candidateId: uuid("candidate_id").notNull().references(() => trackCandidates.id),
  recordingFamilyId: uuid("recording_family_id").notNull().references(() => recordingFamilies.id, { onDelete: "cascade" }),
  catalogIdentityId: uuid("catalog_identity_id").notNull().references(() => recordingCatalogIdentities.id, { onDelete: "cascade" }),
  catalogId: varchar("catalog_id", { length: 160 }).notNull(),
  artist: varchar("artist", { length: 240 }).notNull(),
  title: varchar("title", { length: 240 }).notNull(),
  evidenceEligible: boolean("evidence_eligible").notNull(),
  hardConstraintsSatisfied: boolean("hard_constraints_satisfied").notNull(),
  versionCompatible: boolean("version_compatible").notNull(),
  qualified: boolean("qualified").notNull(),
}, (table) => [
  primaryKey({ columns: [table.manifestRevisionId, table.position], name: "manifest_revision_reserve_tracks_pkey" }),
  uniqueIndex("manifest_revision_reserve_candidate_idx").on(table.manifestRevisionId, table.candidateId),
  uniqueIndex("manifest_revision_reserve_family_idx").on(table.manifestRevisionId, table.recordingFamilyId),
]);

/** Explicit capability-scoped consent for publishing a shortfall. */
export const partialPublicationDecisions = pgTable("partial_publication_decisions", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  manifestRevisionId: uuid("manifest_revision_id").notNull().references(() => manifestRevisions.id, { onDelete: "cascade" }),
  manifestRevisionHash: varchar("manifest_revision_hash", { length: 64 }).notNull(),
  queryPlanRevisionId: uuid("query_plan_revision_id").references(() => queryPlanRevisions.id),
  capabilitySessionId: uuid("capability_session_id").references(() => capabilitySessions.id, { onDelete: "set null" }),
  outcomeHash: varchar("outcome_hash", { length: 64 }).notNull(),
  decision: varchar("decision", { length: 32 }).notNull().default("pending"),
  targetCount: integer("target_count").notNull(),
  selectedCount: integer("selected_count").notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("partial_publication_decision_outcome_idx").on(
    table.manifestRevisionId,
    table.outcomeHash,
    table.decision,
  ),
  index("partial_publication_decision_run_expiry_idx").on(table.runId, table.expiresAt),
  check("partial_publication_decision_counts_valid", sql`${table.targetCount} BETWEEN 1 AND 1000 AND ${table.selectedCount} BETWEEN 0 AND ${table.targetCount}`),
]);

/** A durable logical playlist whose active Apple revision changes atomically. */
export const publicationSeries = pgTable("publication_series", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").references(() => researchRuns.id, { onDelete: "set null" }),
  title: varchar("title", { length: 240 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default("active"),
  ...timestamps,
}, (table) => [index("publication_series_run_idx").on(table.runId)]);

export const publicationRevisionAttempts = pgTable("publication_revision_attempts", {
  id: uuid("id").primaryKey(),
  seriesId: uuid("series_id").notNull().references(() => publicationSeries.id, { onDelete: "cascade" }),
  manifestRevisionId: uuid("manifest_revision_id").notNull().references(() => manifestRevisions.id),
  attempt: integer("attempt").notNull().default(1),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull().unique(),
  status: varchar("status", { length: 40 }).notNull().default("pending"),
  contentHash: varchar("content_hash", { length: 64 }).notNull(),
  lastError: text("last_error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("publication_attempt_series_revision_number_idx").on(table.seriesId, table.manifestRevisionId, table.attempt),
  index("publication_attempt_manifest_revision_idx").on(table.manifestRevisionId, table.status),
]);

export const publicationRevisionVolumes = pgTable("publication_revision_volumes", {
  id: uuid("id").primaryKey(),
  publicationAttemptId: uuid("publication_attempt_id").notNull().references(() => publicationRevisionAttempts.id, { onDelete: "cascade" }),
  volumeNumber: integer("volume_number").notNull(),
  volumeCount: integer("volume_count").notNull(),
  startPosition: integer("start_position").notNull(),
  endPosition: integer("end_position").notNull(),
  status: varchar("status", { length: 40 }).notNull().default("pending"),
  applePlaylistId: varchar("apple_playlist_id", { length: 160 }),
  appleShareUrl: text("apple_share_url"),
  appendedCount: integer("appended_count").notNull().default(0),
  lastError: text("last_error"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("publication_revision_volume_number_idx").on(table.publicationAttemptId, table.volumeNumber),
  index("publication_revision_volume_apple_idx").on(table.applePlaylistId),
]);

export const publicationSeriesActiveRevisions = pgTable("publication_series_active_revisions", {
  seriesId: uuid("series_id").primaryKey().references(() => publicationSeries.id, { onDelete: "cascade" }),
  publicationAttemptId: uuid("publication_attempt_id").notNull().references(() => publicationRevisionAttempts.id),
  activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("publication_series_active_attempt_idx").on(table.publicationAttemptId)]);

export const publicationVolumes = pgTable("publication_volumes", {
  id: uuid("id").primaryKey(),
  manifestId: uuid("manifest_id").notNull().references(() => manifests.id, { onDelete: "cascade" }),
  manifestRevisionId: uuid("manifest_revision_id").references(() => manifestRevisions.id, { onDelete: "set null" }),
  volumeNumber: integer("volume_number").notNull(),
  volumeCount: integer("volume_count").notNull(),
  startPosition: integer("start_position").notNull(),
  endPosition: integer("end_position").notNull(),
  status: varchar("status", { length: 40 }).notNull().default("pending"),
  applePlaylistId: varchar("apple_playlist_id", { length: 160 }),
  appleShareUrl: text("apple_share_url"),
  appendedCount: integer("appended_count").notNull().default(0),
  attempt: integer("attempt").notNull().default(0),
  lastError: text("last_error"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("publication_manifest_volume_idx").on(table.manifestId, table.volumeNumber),
  index("publication_manifest_revision_idx").on(table.manifestRevisionId, table.volumeNumber),
]);

/**
 * A deliberately small, public-safe projection of successfully published
 * playlists. Operational run data is deleted after the retention window, but
 * this projection keeps the Apple links browseable without exposing prompts,
 * evidence, costs, client buckets, or provider diagnostics.
 */
export const publicPlaylists = pgTable("public_playlists", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").references(() => researchRuns.id, { onDelete: "set null" }),
  manifestHash: varchar("manifest_hash", { length: 64 }).notNull().unique(),
  title: varchar("title", { length: 240 }).notNull(),
  trackCount: integer("track_count").notNull(),
  volumeCount: integer("volume_count").notNull(),
  status: varchar("status", { length: 32 }).notNull().default("listed"),
  // Owner visibility is durable across automatic publication projections.
  // The publisher may temporarily hide a stale revision, but only an explicit
  // owner action may set or clear this flag.
  ownerHidden: boolean("owner_hidden").notNull().default(false),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  hiddenAt: timestamp("hidden_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  index("public_playlist_status_published_idx").on(table.status, table.publishedAt.desc(), table.id.desc()),
]);

export const publicPlaylistVolumes = pgTable("public_playlist_volumes", {
  publicPlaylistId: uuid("public_playlist_id").notNull().references(() => publicPlaylists.id, { onDelete: "cascade" }),
  volumeNumber: integer("volume_number").notNull(),
  name: varchar("name", { length: 240 }).notNull(),
  trackCount: integer("track_count").notNull(),
  shareUrl: text("share_url").notNull().unique(),
}, (table) => [
  primaryKey({ columns: [table.publicPlaylistId, table.volumeNumber], name: "public_playlist_volumes_pkey" }),
]);

export const orphanPlaylists = pgTable("orphan_playlists", {
  id: uuid("id").primaryKey(),
  manifestId: uuid("manifest_id").references(() => manifests.id, { onDelete: "set null" }),
  publicationVolumeId: uuid("publication_volume_id").references(() => publicationVolumes.id, { onDelete: "set null" }),
  applePlaylistId: varchar("apple_playlist_id", { length: 160 }).notNull(),
  reason: text("reason").notNull(),
  cleanedAt: timestamp("cleaned_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobQueue = pgTable("job_queue", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").references(() => researchRuns.id, { onDelete: "cascade" }),
  briefRequestId: uuid("brief_request_id").references(() => briefRequests.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 64 }).notNull(),
  queueClass: varchar("queue_class", { length: 24 }).notNull().default("interactive"),
  dedupeKey: varchar("dedupe_key", { length: 160 }).notNull().default("default"),
  pipelineVersion: varchar("pipeline_version", { length: 48 }).notNull().default("legacy_v1"),
  minimumWorkerProtocol: integer("minimum_worker_protocol").notNull().default(4),
  queryPlanRevisionId: uuid("query_plan_revision_id").references(() => queryPlanRevisions.id, { onDelete: "set null" }),
  requiredExecutorCapabilityHash: varchar("required_executor_capability_hash", { length: 64 }),
  requiredExecutorCapabilityVector: jsonb("required_executor_capability_vector"),
  requiredExecutorRevision: varchar("required_executor_revision", { length: 160 }),
  requiredExecutorSemanticConfigurationHash: varchar(
    "required_executor_semantic_configuration_hash",
    { length: 64 },
  ),
  stageKey: varchar("stage_key", { length: 160 }).notNull().default("default"),
  status: varchar("status", { length: 32 }).notNull().default("queued"),
  payloadJson: jsonb("payload_json").notNull().default({}),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  leaseOwner: varchar("lease_owner", { length: 160 }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  leaseEpoch: bigint("lease_epoch", { mode: "number" }).notNull().default(0),
  lastError: text("last_error"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("job_dedupe_idx").on(table.kind, table.dedupeKey),
  index("job_lease_idx").on(table.status, table.availableAt, table.leaseExpiresAt),
  index("job_protocol_lease_idx").on(
    table.status,
    table.minimumWorkerProtocol,
    table.pipelineVersion,
    table.availableAt,
    table.leaseExpiresAt,
  ),
  index("job_queue_class_lease_idx").on(
    table.queueClass,
    table.status,
    table.availableAt,
    table.leaseExpiresAt,
  ),
  index("job_executor_capability_lease_idx").on(
    table.status,
    table.requiredExecutorCapabilityHash,
    table.availableAt,
    table.leaseExpiresAt,
  ),
  index("job_executor_release_identity_lease_idx").on(
    table.status,
    table.requiredExecutorRevision,
    table.requiredExecutorSemanticConfigurationHash,
    table.availableAt,
    table.leaseExpiresAt,
  ),
  index("job_plan_stage_status_idx").on(table.runId, table.queryPlanRevisionId, table.stageKey, table.status),
  index("job_run_idx").on(table.runId),
  check("job_lease_epoch_valid", sql`${table.leaseEpoch} >= 0`),
  check("job_queue_class_valid", sql`${table.queueClass} IN ('interactive','deep','publication','system')`),
  check(
    "job_required_executor_release_identity_complete",
    sql`(
      (${table.requiredExecutorRevision} IS NULL AND ${table.requiredExecutorSemanticConfigurationHash} IS NULL)
      OR (
        ${table.requiredExecutorRevision} ~ '^[0-9A-Za-z][0-9A-Za-z._:+-]{0,159}$'
        AND ${table.requiredExecutorSemanticConfigurationHash} ~ '^[0-9a-f]{64}$'
      )
    )`,
  ),
]);

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: varchar("worker_id", { length: 160 }).primaryKey(),
  schemaVersion: varchar("schema_version", { length: 40 }).notNull(),
  capacity: integer("capacity").notNull().default(1),
  activeJobs: integer("active_jobs").notNull().default(0),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

export const costReservations = pgTable("cost_reservations", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").references(() => researchRuns.id, { onDelete: "cascade" }),
  briefRequestId: uuid("brief_request_id").references(() => briefRequests.id, { onDelete: "cascade" }),
  operation: varchar("operation", { length: 120 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 64 }).notNull().unique(),
  status: varchar("status", { length: 32 }).notNull().default("reserved"),
  reservedUsd: numeric("reserved_usd", { precision: 12, scale: 6, mode: "number" }).notNull(),
  actualUsd: numeric("actual_usd", { precision: 12, scale: 6, mode: "number" }),
  usageJson: jsonb("usage_json"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("cost_reservation_status_idx").on(table.status, table.expiresAt)]);

export const costLedger = pgTable("cost_ledger", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").references(() => researchRuns.id, { onDelete: "set null" }),
  briefRequestId: uuid("brief_request_id").references(() => briefRequests.id, { onDelete: "set null" }),
  reservationId: uuid("reservation_id").references(() => costReservations.id, { onDelete: "set null" }),
  operation: varchar("operation", { length: 120 }).notNull(),
  amountUsd: numeric("amount_usd", { precision: 12, scale: 6, mode: "number" }).notNull(),
  usageJson: jsonb("usage_json"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("cost_ledger_occurred_idx").on(table.occurredAt)]);

export const rateLimitEvents = pgTable("rate_limit_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  clientBucket: varchar("client_bucket", { length: 160 }).notNull(),
  action: varchar("action", { length: 64 }).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("rate_bucket_action_time_idx").on(table.clientBucket, table.action, table.occurredAt)]);

export const gatewayNonces = pgTable("gateway_nonces", {
  keyId: varchar("key_id", { length: 80 }).notNull(),
  nonce: varchar("nonce", { length: 160 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("gateway_key_nonce_idx").on(table.keyId, table.nonce),
  index("gateway_nonce_expiry_idx").on(table.expiresAt),
]);

export const appleAuthorizations = pgTable("apple_authorizations", {
  id: varchar("id", { length: 32 }).primaryKey().default("owner"),
  ciphertext: text("ciphertext").notNull(),
  iv: varchar("iv", { length: 64 }).notNull(),
  authTag: varchar("auth_tag", { length: 64 }).notNull(),
  keyVersion: varchar("key_version", { length: 40 }).notNull(),
  storefront: varchar("storefront", { length: 8 }).notNull(),
  status: varchar("status", { length: 40 }).notNull().default("unverified"),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  lastError: text("last_error"),
  ...timestamps,
});

export const notificationOutbox = pgTable("notification_outbox", {
  id: uuid("id").primaryKey(),
  kind: varchar("kind", { length: 80 }).notNull(),
  dedupeKey: varchar("dedupe_key", { length: 200 }).notNull().unique(),
  payloadJson: jsonb("payload_json").notNull(),
  status: varchar("status", { length: 32 }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  providerId: varchar("provider_id", { length: 200 }),
  lastError: text("last_error"),
  ...timestamps,
}, (table) => [index("notification_outbox_pending_idx").on(table.status, table.availableAt)]);

export const auditEvents = pgTable("audit_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  runId: uuid("run_id").references(() => researchRuns.id, { onDelete: "set null" }),
  actor: varchar("actor", { length: 80 }).notNull(),
  action: varchar("action", { length: 120 }).notNull(),
  detailJson: jsonb("detail_json").notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("audit_run_time_idx").on(table.runId, table.occurredAt)]);

export const retentionTombstones = pgTable("retention_tombstones", {
  runId: uuid("run_id").primaryKey(),
  manifestHash: varchar("manifest_hash", { length: 64 }),
  playlistTitle: varchar("playlist_title", { length: 240 }),
  appleLinksJson: jsonb("apple_links_json").notNull().default([]),
  outcomeCountsJson: jsonb("outcome_counts_json").notNull().default({}),
  aggregateCostUsd: numeric("aggregate_cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
  retainedAt: timestamp("retained_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Provider results are untrusted discovery leads until a separate,
 * contract-fenced qualification record binds identity and evidence.
 */
export const playlistDiscoveryLeads = pgTable("playlist_discovery_leads", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  contractRevisionId: uuid("contract_revision_id").notNull()
    .references(() => playlistContractRevisions.id, { onDelete: "cascade" }),
  executionAttemptId: uuid("execution_attempt_id")
    .references(() => playlistExecutionAttempts.id, { onDelete: "set null" }),
  provider: varchar("provider", { length: 80 }).notNull(),
  dependencyKey: varchar("dependency_key", { length: 120 }).notNull(),
  dependencyIds: text("dependency_ids").array().notNull().default(sql`'{}'::text[]`),
  provenanceRoots: text("provenance_roots").array().notNull().default(sql`'{}'::text[]`),
  cacheOrigin: varchar("cache_origin", { length: 32 }).notNull().default("unknown"),
  sourceFreshUntil: timestamp("source_fresh_until", { withTimezone: true }),
  strategyId: varchar("strategy_id", { length: 120 }).notNull(),
  identityHintHash: varchar("identity_hint_hash", { length: 64 }).notNull(),
  leadJson: jsonb("lead_json").notNull(),
  status: varchar("status", { length: 32 }).notNull().default("discovered"),
  evidenceEligible: boolean("evidence_eligible").notNull().default(false),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("playlist_discovery_lead_identity_idx").on(
    table.runId,
    table.contractRevisionId,
    table.provider,
    table.strategyId,
    table.identityHintHash,
  ),
  index("playlist_discovery_lead_attempt_idx").on(table.executionAttemptId, table.status),
  index("playlist_discovery_lead_dependency_idx").on(table.runId, table.dependencyKey, table.status),
  check("playlist_discovery_lead_not_evidence", sql`${table.evidenceEligible}=false`),
]);

export const playlistQualificationRecords = pgTable("playlist_qualification_records", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  contractRevisionId: uuid("contract_revision_id").notNull()
    .references(() => playlistContractRevisions.id, { onDelete: "cascade" }),
  discoveryLeadId: uuid("discovery_lead_id")
    .references(() => playlistDiscoveryLeads.id, { onDelete: "set null" }),
  candidateId: uuid("candidate_id").references(() => trackCandidates.id, { onDelete: "cascade" }),
  stableIdentityHash: varchar("stable_identity_hash", { length: 64 }).notNull(),
  storefront: varchar("storefront", { length: 16 }).notNull(),
  predicateResultsJson: jsonb("predicate_results_json").notNull(),
  evidenceRecordIdsJson: jsonb("evidence_record_ids_json").notNull().default([]),
  qualityResultJson: jsonb("quality_result_json").notNull(),
  catalogResultJson: jsonb("catalog_result_json").notNull(),
  decision: varchar("decision", { length: 32 }).notNull(),
  qualificationHash: varchar("qualification_hash", { length: 64 }).notNull(),
  qualifiedAt: timestamp("qualified_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("playlist_qualification_identity_idx").on(
    table.runId,
    table.contractRevisionId,
    table.stableIdentityHash,
    table.qualificationHash,
  ),
  index("playlist_qualification_contract_idx").on(
    table.runId,
    table.contractRevisionId,
    table.decision,
    table.qualifiedAt,
  ),
  index("playlist_qualification_candidate_idx").on(table.candidateId, table.decision),
]);

export const playlistPublicationReconciliations = pgTable("playlist_publication_reconciliations", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  contractRevisionId: uuid("contract_revision_id").notNull()
    .references(() => playlistContractRevisions.id, { onDelete: "restrict" }),
  executionAttemptId: uuid("execution_attempt_id").notNull()
    .references(() => playlistExecutionAttempts.id, { onDelete: "restrict" }),
  manifestId: uuid("manifest_id").notNull().references(() => manifests.id, { onDelete: "restrict" }),
  manifestRevisionId: uuid("manifest_revision_id")
    .references(() => manifestRevisions.id, { onDelete: "restrict" }),
  applePlaylistId: varchar("apple_playlist_id", { length: 160 }),
  state: varchar("state", { length: 40 }).notNull(),
  expectedOrderedIdsHash: varchar("expected_ordered_ids_hash", { length: 64 }).notNull(),
  observedOrderedIdsHash: varchar("observed_ordered_ids_hash", { length: 64 }),
  appendedCount: integer("appended_count").notNull().default(0),
  expectedCount: integer("expected_count").notNull(),
  batchCursor: integer("batch_cursor").notNull().default(0),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull().unique(),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  blockerId: uuid("blocker_id").references(() => playlistRunBlockers.id, { onDelete: "set null" }),
  reconciliationJson: jsonb("reconciliation_json").notNull().default({}),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  index("playlist_publication_reconcile_run_idx").on(table.runId, table.state, table.nextRetryAt),
]);

export const pipelineCohortKillSwitches = pgTable("pipeline_cohort_kill_switches", {
  cohortKey: varchar("cohort_key", { length: 160 }).primaryKey(),
  route: varchar("route", { length: 48 }).notNull(),
  intentGroup: varchar("intent_group", { length: 80 }),
  disabled: boolean("disabled").notNull().default(false),
  reasonCode: varchar("reason_code", { length: 120 }),
  changedBy: varchar("changed_by", { length: 80 }).notNull(),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("pipeline_cohort_kill_switch_route_idx").on(table.route, table.disabled, table.intentGroup),
  unique("pipeline_cohort_kill_switch_authority_idx")
    .on(table.route, table.intentGroup)
    .nullsNotDistinct(),
]);

/**
 * Authenticated release-canary inventory. It deliberately stores no prompt,
 * answer, public access ID, or capability identifier, and therefore supports
 * synthetic-traffic exclusion without making those values metric labels.
 */
export const releaseCanaryMarkers = pgTable("release_canary_markers", {
  id: uuid("id").primaryKey(),
  canaryId: varchar("canary_id", { length: 64 }).notNull(),
  environment: varchar("environment", { length: 16 }).notNull(),
  audience: varchar("audience", { length: 512 }).notNull(),
  operation: varchar("operation", { length: 16 }).notNull(),
  sourceRevision: varchar("source_revision", { length: 64 }).notNull(),
  cacheMode: varchar("cache_mode", { length: 16 }).notNull(),
  briefRequestId: uuid("brief_request_id")
    .references(() => briefRequests.id, { onDelete: "cascade" }),
  runId: uuid("run_id")
    .references(() => researchRuns.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("release_canary_marker_scope_idx").on(
    table.canaryId,
    table.environment,
    table.operation,
    table.sourceRevision,
  ),
  uniqueIndex("release_canary_marker_brief_idx")
    .on(table.briefRequestId)
    .where(sql`${table.briefRequestId} IS NOT NULL`),
  uniqueIndex("release_canary_marker_run_idx")
    .on(table.runId)
    .where(sql`${table.runId} IS NOT NULL`),
  check("release_canary_marker_environment_valid", sql`${table.environment} IN ('staging','production')`),
  check("release_canary_marker_operation_valid", sql`${table.operation} IN ('brief','run')`),
  check("release_canary_marker_audience_valid", sql`${table.audience} ~ '^https://[^/@?#[:space:]]+$'`),
  check("release_canary_marker_cache_mode_valid", sql`${table.cacheMode} IN ('reuse_disabled','legacy_unknown')`),
  check("release_canary_marker_source_revision_valid", sql`${table.sourceRevision} ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'`),
  check("release_canary_marker_owner_valid", sql`(
    (${table.operation}='brief' AND ${table.briefRequestId} IS NOT NULL AND ${table.runId} IS NULL)
    OR (${table.operation}='run' AND ${table.runId} IS NOT NULL AND ${table.briefRequestId} IS NULL)
  )`),
]);
