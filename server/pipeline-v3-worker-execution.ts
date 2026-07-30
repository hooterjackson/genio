import { createHash } from "node:crypto";
import type { QueryPlanV3 } from "../shared/types.ts";
import type { PipelinePolicySnapshot } from "../shared/types.ts";
import { EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS } from "../shared/product-policy.ts";
import {
  pipelineV3ModelRouteFromPolicySnapshot,
  type PipelineV3ModelRoute,
} from "./pipeline-v3-policy.ts";
import type {
  SelectionConstraint,
  SelectionDiversityGoals,
  SelectionOrderingPolicy,
  SelectionScopeKind,
} from "../shared/types.ts";
import {
  evaluatePlaylistOptimizationV3,
  executeRetrievalV3,
  RetrievalDependencyErrorV3,
  RetrievalPlaylistOptimizationBudgetExceededErrorV3,
  type CandidateQualificationV3,
  type DiscoveryBatchV3,
  type DiscoveryRequestV3,
  type QualificationRequestV3,
  type QualifiedTrackV3,
  type RetrievalAdaptersV3,
  type RetrievalExecutionModeV3,
  type RetrievalContinuationSeedV3,
  type RetrievalDependencyFailureClassV3,
  type RetrievalPolicyV3,
  type RetrievalResultV3,
  type RetrievalRoutingHintsV3,
} from "./pipeline-v3-retrieval.ts";
import {
  playlistOptimizationBudgetForPassV1,
  PlaylistOptimizationBudgetExceededErrorV1,
  withPlaylistOptimizationBudgetV1,
} from "./playlist-optimizer-v1.ts";
import {
  isCanonicalQueryPlanV3SchemaVersion,
  queryPlanV3Hash,
  queryPlanV3RequiresLegacyCanonicalExecutor,
} from "./query-plan-v3.ts";
import {
  assertPipelineV3ConceptDiscoveryHints,
  clonePipelineV3ConceptDiscoveryHints,
  executableQueryPlanClauseIdsV3,
} from "./pipeline-v3-concept-discovery-hint.ts";
import { MUSIC_CONCEPT_POLICY_VERSION } from "./music-concepts-v3.ts";
import {
  PIPELINE_V3_VERSION,
  SEMANTIC_PLAN_V3_1_VERSION,
  SEMANTIC_SCOPE_POLICY_VERSION,
  SELECTION_PLAN_V3_SCHEMA_VERSION,
  SELECTION_PLAN_V3_VERSION,
  type IntentV3,
  type MembershipAxisV3,
  type MembershipOperatorV3,
  type RankingDimensionV3,
  type RankingObjectiveV3,
  type SemanticPlanClauseV32,
  type SelectionPlanV3,
} from "./selection-plan-v3.ts";
import { stableStringify } from "./security.ts";
import { assertCanonicalContractExecutionPolicyV1 } from "./canonical-contract-runtime-v1.ts";
import {
  createAdaptiveRunDecisionV1,
  MAX_ACTIVE_COMPUTE_EXTENSIONS_V1,
} from "./adaptive-run-decision-v1.ts";
import {
  assertPlaylistContractIntegrityV1,
  type PlaylistContractRevisionV1,
} from "./playlist-contract-v1.ts";
import type {
  ColdCorpusBuilderPortV3,
  ColdCorpusBuildResultV3,
} from "./pipeline-v3-corpus-builder.ts";
import type { SemanticPlanRevisionArtifactV3 } from "./pipeline-v3-semantic-recovery.ts";
import {
  assessPlaylistRuntimeFeasibilityV1,
  playlistRuntimeNoCompatibleDispositionV1,
  type PlaylistFeasibilityReportV1,
  type PlaylistRuntimeNoCompatibleDispositionV1,
} from "./playlist-feasibility-v1.ts";
import {
  canonicalExecutionIntegrityError,
  CanonicalExecutionIntegrityError,
} from "./canonical-execution-integrity.ts";
import {
  canonicalExecutorCapabilityForSchemaV1,
} from "./playlist-contract-backend-capability-v1.ts";
import {
  revalidateExecutionCoverageReportV1,
} from "./verification-expression-v1.ts";
import { auditSemanticCollapseV1 } from "./semantic-collapse-audit-v1.ts";

/**
 * Durable worker boundary for Pipeline V3 retrieval.
 *
 * The boundary intentionally contains no Apple mutation method and no generic
 * job enqueue method. A V3 retrieval worker can create a draft result, but it
 * cannot publish it or quietly hand it to a legacy matching path.
 */
export const PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA = "genio-pipeline-v3-worker/v1" as const;

/**
 * Every durable V3 write is tied to the exact lease that produced it. The
 * repository verifies this fence against job_queue before committing, which
 * prevents a reclaimed/stale worker from overwriting a successor's state.
 */
export interface PipelineV3WriteFence {
  jobId: string;
  workerId: string;
  leaseEpoch: number;
  queryPlanRevisionId: string;
  stageKey: string;
  /** Schema-17/18 contract-attempt identity supplied by WorkerRunner. */
  contractAttemptId?: string;
  contractRevisionDatabaseId?: string;
  contractRevisionId?: string;
  contractSemanticHash?: string;
}

export interface PipelineV3WorkerRepository {
  getResearchCheckpoint(runId: string, checkpointKey: string): Promise<unknown | null>;
  saveResearchCheckpoint(
    runId: string,
    checkpointKey: string,
    checkpoint: unknown,
    fence?: PipelineV3WriteFence,
  ): Promise<void>;
  updateRun(runId: string, patch: {
    status?: string;
    phase?: string;
    error?: string | null;
  }, fence?: PipelineV3WriteFence): Promise<void>;
  quarantineCanonicalExecution?(input: {
    runId: string;
    jobId: string;
    workerId: string;
    leaseGeneration: number;
    reasonCode: string;
  }): Promise<boolean>;
  getActivePlaylistContractRevision?(input: {
    runId: string;
  }): Promise<{
    id: string;
    contractHash: string;
    contract: Record<string, unknown>;
  } | null>;
  openPlaylistRunBlocker?(input: {
    runId: string;
    contractRevisionId: string;
    blockerKind: "scope_decision";
    dependencyKey?: string | null;
    retryCount?: number;
    nextRetryAt?: Date | null;
    automaticRetryUntil?: Date | null;
    state?: Record<string, unknown>;
    fence?: PipelineV3WriteFence;
  }): Promise<string>;
  preparePlaylistRunRescueGuidance?(input: {
    runId: string;
    contractRevisionId: string;
    contractSemanticHash: string;
    limitingClauseIds: readonly string[];
    fence: PipelineV3WriteFence;
  }): Promise<unknown | null>;
  /**
   * Claim the sole semantics-preserving recovery revision before any repaired
   * requalification begins. Exact replays are idempotent; conflicting replays
   * are integrity failures.
   */
  claimPipelineV3SemanticRecovery(input: {
    runId: string;
    queryPlan: QueryPlanV3;
    revision: SemanticPlanRevisionArtifactV3;
    fence: PipelineV3WriteFence;
  }): Promise<{ status: "claimed" | "replayed"; revision: 2 }>;
  /**
   * Persist untrusted discovery leads separately from any evidence or catalog
   * decision. Canonical schema-4 work fails closed when this boundary is not
   * available.
   */
  persistPipelineV3DiscoveryBatch?(input: {
    runId: string;
    queryPlan: QueryPlanV3;
    request: DiscoveryRequestV3;
    batch: DiscoveryBatchV3;
    fence: PipelineV3WriteFence;
  }): Promise<void>;
  /**
   * Persist the independently evaluated predicate, evidence/quality, and
   * catalog decision for each previously recorded discovery lead.
   */
  persistPipelineV3QualificationBatch?(input: {
    runId: string;
    queryPlan: QueryPlanV3;
    request: QualificationRequestV3;
    qualifications: readonly CandidateQualificationV3[];
    fence: PipelineV3WriteFence;
  }): Promise<void>;
  /**
   * Before a canonical continuation trusts checkpoint tracks, re-read the
   * authoritative final qualification rows and recompute their stable
   * identity and qualification hashes.
   */
  validatePipelineV3ContinuationQualifications?(input: {
    runId: string;
    queryPlan: QueryPlanV3;
    tracks: readonly QualifiedTrackV3[];
  }): Promise<void>;
  /**
   * Persist the observed retrieval frontier, dependency, and budget evidence
   * before a canonical run may describe an empty result as musical scarcity.
   */
  persistPipelineV3RuntimeFeasibilitySnapshot?(input: {
    runId: string;
    queryPlan: QueryPlanV3;
    phase: "initial" | "recovery";
    report: PlaylistFeasibilityReportV1;
    fence: PipelineV3WriteFence;
  }): Promise<{ id: string; created: boolean }>;
  /**
   * Persist the governed result as one immutable, revision-bound manifest.
   * The repository owns the exact-publication handoff; retrieval itself never
   * receives an Apple token, playlist client, or generic enqueue function.
   */
  persistPipelineV3RetrievalResult(input: {
    runId: string;
    queryPlan: QueryPlanV3;
    plan: SelectionPlanV3;
    result: RetrievalResultV3;
    fence: PipelineV3WriteFence;
  }): Promise<{
    manifestId: string | null;
    manifestRevisionId: string | null;
    manifestHash: string | null;
    publicationState: "not_applicable" | "partial_confirmation_required" | "queued" | "waiting_for_apple_authorization";
  }>;
  ingestPipelineV3ColdCorpus?(input: {
    runId: string;
    queryPlan: QueryPlanV3;
    result: ColdCorpusBuildResultV3;
    fence: PipelineV3WriteFence;
  }): Promise<{
    sourceDocumentCount: number;
    observationCount: number;
    enumerationComplete: boolean;
    unresolvedGapCount: number;
  }>;
}

export interface PipelineV3RetrievalExecutionInput {
  runId: string;
  plan: SelectionPlanV3;
  executionMode: RetrievalExecutionModeV3;
  routingHints: RetrievalRoutingHintsV3;
  modelRoute: PipelineV3ModelRoute;
  /**
   * Rehydrated exclusively from the immutable policy captured for this run.
   * Retrieval ports must not consult process defaults or retain a shared
   * policy because retries can execute on a different worker revision.
   */
  policy: RetrievalPolicyV3;
  /** True only for immutable query-plan schema-2 work. */
  semanticRecoveryEnabled: boolean;
  claimSemanticRecovery: (revision: SemanticPlanRevisionArtifactV3) => Promise<void>;
  continuation?: RetrievalContinuationSeedV3;
  recordDiscoveryBatch?: (
    request: DiscoveryRequestV3,
    batch: DiscoveryBatchV3,
  ) => Promise<void>;
  recordQualificationBatch?: (
    request: QualificationRequestV3,
    qualifications: readonly CandidateQualificationV3[],
  ) => Promise<void>;
  signal?: AbortSignal;
}

export interface PipelineV3RetrievalExecutionPort {
  execute(input: PipelineV3RetrievalExecutionInput): Promise<RetrievalResultV3>;
}

export interface PipelineV3WorkerPayload {
  v3ExecutionMode?: "active" | "shadow";
  stageExecutionKey?: string;
  __jobStageKey?: string;
  __jobLeaseEpoch?: number;
  __queryPlanRevisionId?: string | null;
  __jobId?: string;
  __jobWorkerId?: string;
  /** Cumulative active execution time for this immutable contract revision. */
  __contractActiveComputeConsumedMs?: number;
  /** User-authorized cumulative allowance; defaults to one 15-minute pass. */
  __contractActiveComputeAllowanceMs?: number;
  __contractAttemptId?: string;
  __contractRevisionDatabaseId?: string;
  __contractRevisionId?: string;
  __contractSemanticHash?: string;
  __executorRevision?: string;
  __executorConfigurationHash?: string;
  __executorSemanticConfigurationHash?: string;
}

export const PIPELINE_V3_ACTIVE_COMPUTE_LIMIT_MS = 15 * 60_000;

/**
 * Signals that V3 did not reach a musical result because an execution
 * dependency was unavailable. WorkerRunner recognizes this error and keeps
 * the same immutable contract on the bounded dependency-retry circuit.
 */
export class PipelineV3DependencyUnavailableError extends Error {
  readonly name = "PipelineV3DependencyUnavailableError";
  readonly code = "pipeline_v3_dependency_unavailable";
  readonly retryAfterUntil: Date | null;
  readonly retriable: boolean;

  constructor(
    readonly dependencyKey: string,
    readonly reasonCode: string,
    retryAfterUntil: Date | null = null,
    readonly failureClass: RetrievalDependencyFailureClassV3 = "transient",
  ) {
    super("Pipeline V3 is waiting for a research dependency");
    this.retryAfterUntil = retryAfterUntil
      && Number.isFinite(retryAfterUntil.getTime())
      ? new Date(retryAfterUntil)
      : null;
    this.retriable = failureClass === "transient"
      || failureClass === "rate_limited";
  }
}

/**
 * A deterministic local-compute boundary, deliberately distinct from a
 * provider outage. The persisted pass number lets one successor lease run a
 * larger bounded search; exhaustion of that pass is a technical quarantine,
 * never evidence of musical scarcity or a dependency incident.
 */
export class PipelineV3OptimizerComputeBudgetError extends Error {
  readonly name = "PipelineV3OptimizerComputeBudgetError";
  readonly code = "optimizer_search_budget_exhausted";

  constructor(
    readonly budgetPass: number,
    readonly retriable: boolean,
  ) {
    super("Playlist optimization exhausted its bounded technical compute budget");
  }
}

function parsedRetryAfterUntil(value: unknown): Date | null {
  const timestamp = value instanceof Date
    ? value.getTime()
    : typeof value === "string"
      ? Date.parse(value)
      : Number.NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function parsedRetrievalDependencyFailureClass(
  value: unknown,
): RetrievalDependencyFailureClassV3 {
  return value === "transient"
    || value === "rate_limited"
    || value === "authorization"
    || value === "quota"
    || value === "invalid_request"
    || value === "configuration"
    || value === "permanent"
    ? value
    : "transient";
}

function retrievalFailureClass(
  result: RetrievalResultV3,
): RetrievalDependencyFailureClassV3 {
  const active = (result.dependencyOutages ?? [])
    .filter(({ active: isActive }) => isActive)
    .map(({ failureClass }) => (
      parsedRetrievalDependencyFailureClass(failureClass)
    ));
  const nonRetryable = active.find((failureClass) => (
    failureClass !== "transient" && failureClass !== "rate_limited"
  ));
  return nonRetryable
    ?? (active.includes("rate_limited")
    ? "rate_limited"
    : active[0] ?? "transient");
}

function retrievalRetryAfterUntil(result: RetrievalResultV3): Date | null {
  return (result.dependencyOutages ?? [])
    .filter(({ active }) => active)
    .reduce<Date | null>((latest, outage) => {
      const candidate = parsedRetryAfterUntil(outage.retryAfterUntil);
      return candidate && (!latest || candidate.getTime() > latest.getTime())
        ? candidate
        : latest;
    }, null);
}

export interface PipelineV3RuntimeFeasibilityAssessment {
  readonly report: PlaylistFeasibilityReportV1;
  readonly scope: "open_world" | "closed_set";
  readonly noCompatibleDisposition: PlaylistRuntimeNoCompatibleDispositionV1;
}

/**
 * Bind feasibility truth to the exact retrieval ledger that produced an
 * outcome. This helper is pure so the same rules are exercised by unit tests
 * and by the fenced repository boundary.
 */
export function assessPipelineV3RuntimeFeasibility(input: {
  queryPlan: QueryPlanV3;
  result: RetrievalResultV3;
  policy: RetrievalPolicyV3;
  activeComputeConsumedMs: number;
  activeComputeAllowanceMs: number;
}): PipelineV3RuntimeFeasibilityAssessment {
  if (input.queryPlan.schemaVersion < 4
    || !input.queryPlan.playlistContractRevisionId
    || !input.queryPlan.playlistContractSemanticHash
    || !Number.isSafeInteger(input.queryPlan.targetTrackCount)
    || Number(input.queryPlan.targetTrackCount) < 1) {
    throw new Error("Pipeline V3 runtime feasibility requires a canonical query plan");
  }
  const scope = input.queryPlan.engines.includes("fixed_container")
    ? "closed_set" as const
    : "open_world" as const;
  const limitingPredicateIds = Object.entries(
    input.result.predicateDiagnostics?.failedMembershipPredicateIds ?? {},
  ).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([predicateId]) => predicateId)
    .slice(0, 20);
  const report = assessPlaylistRuntimeFeasibilityV1({
    contractRevisionId: input.queryPlan.playlistContractRevisionId,
    contractSemanticHash: input.queryPlan.playlistContractSemanticHash,
    targetTrackCount: Number(input.queryPlan.targetTrackCount),
    scope,
    stopReason: input.result.outcome.stopReason,
    discoveredCount: input.result.stages.discovered,
    qualifiedCount: input.result.outcome.qualifiedTrackCount,
    storefrontSafeCount: input.result.stages.storefrontPlayable,
    contradictions: input.queryPlan.semanticAuditMetadata?.contradictions ?? [],
    limitingPredicateIds,
    strategies: input.result.strategies.map((strategy) => ({
      id: strategy.id,
      status: strategy.status,
      rounds: strategy.rounds,
      rawCandidates: strategy.rawCandidates,
      newQualifiedFamilies: strategy.newQualifiedFamilies,
      discoveryDependencyIds: strategy.discoveryDependencyIds,
      ...(strategy.fixedContainerResolution ? {
        fixedContainerResolution: strategy.fixedContainerResolution,
      } : {}),
    })),
    dependencyOutages: (input.result.dependencyOutages ?? []).map((outage) => ({
      dependencyId: outage.dependencyId,
      active: outage.active,
      circuitOpen: outage.circuitOpen,
      failureAttempts: outage.failureAttempts,
      affectedStrategyIds: outage.affectedStrategyIds,
    })),
    budgets: {
      activeComputeConsumedMs: Math.max(0, Math.floor(input.activeComputeConsumedMs)),
      activeComputeAllowanceMs: Math.max(1, Math.floor(input.activeComputeAllowanceMs)),
      maximumGlobalRounds: input.policy.maximumGlobalRounds,
      maximumRawCandidates: input.policy.maximumRawCandidates,
      maximumCostUnits: input.policy.maximumCostUnits,
      qualifiedPoolGoal: input.policy.qualifiedPoolGoal ?? null,
    },
    policyVersions: {
      queryPlanPolicy: input.queryPlan.policyVersion,
      semanticPolicy: input.queryPlan.semanticPolicyVersion ?? "legacy",
      musicConceptPolicy: input.queryPlan.musicConceptPolicyVersion ?? "legacy",
      guidancePolicy: input.queryPlan.guidancePolicyVersion ?? "legacy",
      evidencePolicy: input.queryPlan.evidencePolicyVersion ?? "legacy",
      playlistContractCompiler: input.queryPlan.playlistContractCompilerVersion ?? "unknown",
    },
  });
  return {
    report,
    scope,
    noCompatibleDisposition: playlistRuntimeNoCompatibleDispositionV1({
      report,
      scope,
    }),
  };
}

const MEMBERSHIP_AXES = new Set<MembershipAxisV3>([
  "genre",
  "subgenre",
  "scene",
  "era",
  "geography",
  "language",
  "theme",
  "mood",
  "activity",
  "artist",
  "album",
  "playlist",
  "track",
  "label",
  "venue",
  "factual_relationship",
  "recording_version",
  "content",
]);

const MEMBERSHIP_OPERATORS = new Set<MembershipOperatorV3>([
  "include",
  "exclude",
  "require",
]);

const RANKING_DIMENSIONS = new Set<RankingDimensionV3>([
  "influence",
  "relevance",
  "central_quality",
  "similarity",
  "source_rank",
  "artist_diversity",
  "album_diversity",
  "era_balance",
  "scene_balance",
  "geography_balance",
  "sequencing",
]);

function abortIfNeeded(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Pipeline V3 retrieval was cancelled");
}

function writeFence(
  payload: PipelineV3WorkerPayload | undefined,
  stageKey: string,
): PipelineV3WriteFence {
  const jobId = payload?.__jobId;
  const workerId = payload?.__jobWorkerId;
  const leaseEpoch = payload?.__jobLeaseEpoch;
  const queryPlanRevisionId = payload?.__queryPlanRevisionId;
  if (!jobId || !workerId || !stageKey || !Number.isSafeInteger(leaseEpoch) || Number(leaseEpoch) < 1
    || !queryPlanRevisionId) {
    throw new Error("Pipeline V3 execution is missing its durable lease fence");
  }
  return {
    jobId,
    workerId,
    leaseEpoch: Number(leaseEpoch),
    queryPlanRevisionId,
    stageKey,
    ...(payload?.__contractAttemptId
      ? { contractAttemptId: payload.__contractAttemptId }
      : {}),
    ...(payload?.__contractRevisionDatabaseId
      ? { contractRevisionDatabaseId: payload.__contractRevisionDatabaseId }
      : {}),
    ...(payload?.__contractRevisionId
      ? { contractRevisionId: payload.__contractRevisionId }
      : {}),
    ...(payload?.__contractSemanticHash
      ? { contractSemanticHash: payload.__contractSemanticHash }
      : {}),
  };
}

function safePrompt(run: { prompt?: string; brief?: { title?: string; description?: string } }): string {
  const raw = run.prompt?.trim()
    || run.brief?.title?.trim()
    || run.brief?.description?.trim()
    || "Confirmed playlist request";
  return raw.slice(0, 4_000);
}

function canonicalDiscoverySummary(queryPlan: QueryPlanV3): string {
  const policy = queryPlan.canonicalContractPolicy;
  if (!policy) return "";
  return [
    ...policy.clauses.map(
      (clause) => `${clause.axis} ${clause.operator} ${clause.values.join(" or ")}`,
    ),
    ...(queryPlan.executionDirectives?.fixedContainer
      ? [`fixed ${queryPlan.executionDirectives.fixedContainer.kind} ${queryPlan.executionDirectives.fixedContainer.name}`]
      : []),
    ...(queryPlan.executionDirectives?.fixedTrackList
      ? [`fixed track list ${queryPlan.executionDirectives.fixedTrackList.tracks
          .map(({ artist, title }) => `${artist} — ${title}`)
          .join("; ")}`]
      : []),
    ...(queryPlan.executionDirectives?.similarity
      ? [`similarity seeds ${queryPlan.executionDirectives.similarity.seedArtists.join(" or ")}`]
      : []),
  ].join("; ")
    .slice(0, 4_000);
}

function intentsFromQueryPlan(plan: QueryPlanV3): IntentV3[] {
  const intents = new Set<IntentV3>();
  for (const engine of plan.engines) {
    if (engine === "curated_genre_scene") intents.add("genre_scene");
    if (engine === "mood_activity_theme") intents.add("mood_activity");
    if (engine === "similarity") intents.add("similarity");
    if (engine === "artist_catalogue") intents.add("artist_catalogue");
    if (engine === "factual_relationship") intents.add("factual_relationship");
    if (engine === "exhaustive") intents.add("exhaustive");
  }
  if (plan.rankingObjectives.some((objective) => objective.kind === "influence")) {
    intents.add("editorial_ranking");
  }
  if (intents.size === 0) intents.add("genre_scene");
  return [...intents];
}

function rankingDirection(dimension: RankingDimensionV3): RankingObjectiveV3["direction"] {
  return dimension.endsWith("_balance") || dimension.endsWith("_diversity")
    ? "balance"
    : "maximize";
}

function cloneConstraints(values: readonly SelectionConstraint[]): SelectionConstraint[] {
  return values.map((value) => ({
    ...value,
    values: [...value.values],
    geographyRelationship: value.geographyRelationship ?? null,
  }));
}

function rehydratedScopeKind(queryPlan: QueryPlanV3): SelectionScopeKind {
  if (queryPlan.scopeKind) return queryPlan.scopeKind;
  if (queryPlan.engines.some((engine) => engine === "factual_relationship" || engine === "exhaustive")) {
    return "factual_frontier";
  }
  if (queryPlan.engines.includes("artist_catalogue")) return "artist_catalogue";
  if (queryPlan.engines.includes("fixed_container")) return "fixed_release_container";
  return "broad_curated";
}

function defaultDiversityGoals(target: number, scopeKind: SelectionScopeKind): SelectionDiversityGoals {
  if (scopeKind !== "broad_curated") {
    return {
      minimumDistinctArtists: null,
      minimumDistinctAlbums: null,
      minimumDistinctEras: null,
      minimumDistinctScenes: null,
      minimumDistinctGeographies: null,
      maximumTracksPerArtist: null,
      maximumTracksPerAlbum: null,
    };
  }
  return {
    minimumDistinctArtists: Math.min(target, Math.max(5, Math.ceil(target * 0.2))),
    minimumDistinctAlbums: Math.min(target, Math.max(5, Math.ceil(target * 0.25))),
    minimumDistinctEras: 2,
    minimumDistinctScenes: 2,
    minimumDistinctGeographies: null,
    maximumTracksPerArtist: Math.max(1, Math.ceil(target * 0.15)),
    maximumTracksPerAlbum: Math.max(2, Math.ceil(target * 0.1)),
  };
}

function defaultOrderingPolicy(scopeKind: SelectionScopeKind): SelectionOrderingPolicy {
  const broad = scopeKind === "broad_curated";
  return {
    mode: "editorial",
    goals: [],
    avoidAdjacentSameArtist: broad,
    avoidAdjacentSameAlbum: broad,
  };
}

/**
 * Rehydrate only from the immutable normalized query plan. Prompt prose is
 * retained as opaque audit context; it is never reparsed to change membership.
 */
export function selectionPlanFromQueryPlanV3(
  queryPlan: QueryPlanV3,
  run: { prompt?: string; brief?: { title?: string; description?: string } },
): SelectionPlanV3 {
  assertPipelineV3ConceptDiscoveryHints(
    queryPlan.conceptDiscoveryHints ?? [],
    executableQueryPlanClauseIdsV3(queryPlan),
  );
  if (queryPlan.schemaVersion >= 2
    && (queryPlan.musicConceptPolicyVersion !== MUSIC_CONCEPT_POLICY_VERSION
      || queryPlan.semanticAuditMetadata?.musicConceptPolicyVersion !== MUSIC_CONCEPT_POLICY_VERSION)) {
    throw new Error("Pipeline V3 schema-2 query plan uses an unsupported music-concept policy");
  }
  const target = Number(queryPlan.targetTrackCount);
  if (!Number.isSafeInteger(target)
    || target < 1
    || target > EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS) {
    throw new Error("Pipeline V3 query plan has an invalid requested track count");
  }
  if (!/^[a-z]{2}$/u.test(queryPlan.storefront)) {
    throw new Error("Pipeline V3 query plan has an invalid storefront");
  }
  const legacyMembershipPredicates = queryPlan.membershipPredicates.map((predicate) => {
    const axis = MEMBERSHIP_AXES.has(predicate.kind as MembershipAxisV3)
      ? predicate.kind as MembershipAxisV3
      : predicate.kind === "relationship"
        ? "factual_relationship" as const
        : null;
    const operator = MEMBERSHIP_OPERATORS.has(predicate.relationship as MembershipOperatorV3)
      ? predicate.relationship as MembershipOperatorV3
      : null;
    if (!axis || !operator || predicate.hard !== true) {
      throw new Error(`Pipeline V3 query plan contains an unsupported membership predicate: ${predicate.id}`);
    }
    const values = predicate.subject.split(" | ").map((value) => value.trim()).filter(Boolean);
    if (values.length === 0) {
      throw new Error(`Pipeline V3 query plan contains an empty membership predicate: ${predicate.id}`);
    }
    return {
      id: predicate.id,
      axis,
      operator,
      values,
      source: "user" as const,
      reason: `Persisted query-plan membership predicate ${predicate.id}.`,
    };
  });
  const legacySemanticClauses: SemanticPlanClauseV32[] = legacyMembershipPredicates.map((predicate) => ({
    id: predicate.id,
    role: "membership",
    axis: predicate.axis,
    operator: predicate.operator,
    values: [...predicate.values],
    source: "v2_compatibility",
    explicitUserAuthored: false,
    geographyRelationship: null,
    reason: predicate.reason,
  }));
  const semanticClauses: SemanticPlanClauseV32[] = queryPlan.schemaVersion >= 2
    ? queryPlan.semanticClauses!.map((clause) => ({
        ...clause,
        axis: clause.axis as SemanticPlanClauseV32["axis"],
        operator: clause.operator as SemanticPlanClauseV32["operator"],
        values: [...clause.values],
      }))
    : legacySemanticClauses;
  const membershipPredicates = queryPlan.schemaVersion >= 2
    ? semanticClauses.filter((clause) => clause.role === "membership").map((clause) => {
        const axis = MEMBERSHIP_AXES.has(clause.axis as MembershipAxisV3)
          ? clause.axis as MembershipAxisV3
          : clause.axis === "relationship"
            ? "factual_relationship" as const
            : null;
        const operator = MEMBERSHIP_OPERATORS.has(clause.operator as MembershipOperatorV3)
          ? clause.operator as MembershipOperatorV3
          : null;
        if (!axis || !operator || clause.values.length === 0) {
          throw new Error(`Pipeline V3 schema-2 query plan contains an unsupported membership clause: ${clause.id}`);
        }
        return {
          id: clause.id,
          axis,
          operator,
          values: [...clause.values],
          source: clause.source === "guided_answer" ? "guided_answer" as const
            : clause.source === "raw_prompt" || clause.explicitUserAuthored ? "user" as const
              : "system_safety" as const,
          reason: clause.reason,
        };
      })
    : legacyMembershipPredicates;
  const rankingObjectives: RankingObjectiveV3[] = queryPlan.rankingObjectives.map((objective) => {
    const dimension = RANKING_DIMENSIONS.has(objective.kind as RankingDimensionV3)
      ? objective.kind as RankingDimensionV3
      : "relevance";
    const weight = Number.isFinite(objective.weight) ? Math.max(0, Math.min(100, objective.weight)) : 0;
    return {
      id: objective.id,
      dimension,
      direction: rankingDirection(dimension),
      weight,
      relaxationRank: dimension === "sequencing" ? 1
        : dimension === "album_diversity" ? 2
          : dimension === "artist_diversity" ? 3
            : null,
      values: [...(objective.values ?? [])],
      reason: objective.description,
    };
  });
  if (!rankingObjectives.some((objective) => objective.dimension === "relevance")) {
    rankingObjectives.unshift({
      id: "ranking:relevance:persisted_default",
      dimension: "relevance",
      direction: "maximize",
      weight: 1,
      relaxationRank: null,
      values: [],
      reason: "Prefer the strongest evidence-qualified fit to the immutable query plan.",
    });
  }
  const scopeKind = rehydratedScopeKind(queryPlan);
  const diversityGoals = queryPlan.diversityGoals
    ? { ...queryPlan.diversityGoals }
    : defaultDiversityGoals(target, scopeKind);
  const orderingPolicy = queryPlan.orderingPolicy
    ? { ...queryPlan.orderingPolicy, goals: [...queryPlan.orderingPolicy.goals] }
    : defaultOrderingPolicy(scopeKind);
  const semanticHardConstraintHash = queryPlan.schemaVersion >= 2
    ? queryPlan.hardConstraintHash!
    : createHash("sha256").update(stableStringify(membershipPredicates.map(({ axis, operator, values }) => ({
        axis,
        operator,
        values: values.map((value) => value.normalize("NFKC").trim().toLowerCase()).sort(),
      })))).digest("hex");
  const explicitUserConstraintHash = queryPlan.schemaVersion >= 2
    ? queryPlan.explicitUserConstraintHash!
    : createHash("sha256").update(stableStringify({
        schemaVersion: 1,
        selectionPlanHash: queryPlan.selectionPlanHash,
      })).digest("hex");
  const contextSignals = queryPlan.schemaVersion >= 2
    ? queryPlan.contextSignals!.map((clause) => ({
        ...clause,
        axis: clause.axis as SemanticPlanClauseV32["axis"],
        operator: clause.operator as SemanticPlanClauseV32["operator"],
        values: [...clause.values],
      }))
    : [];
  const catalogPolicies = queryPlan.schemaVersion >= 2
    ? queryPlan.catalogPolicies!.map((clause) => ({
        ...clause,
        axis: clause.axis as SemanticPlanClauseV32["axis"],
        operator: clause.operator as SemanticPlanClauseV32["operator"],
        values: [...clause.values],
      }))
    : [];
  const plan: SelectionPlanV3 = {
    schemaVersion: SELECTION_PLAN_V3_SCHEMA_VERSION,
    pipelineVersion: PIPELINE_V3_VERSION,
    selectionPlanVersion: SELECTION_PLAN_V3_VERSION,
    // Contract-3 workers never consume or reinterpret the mutable run prompt.
    // This generated discovery summary is derived exclusively from the
    // already-fenced typed clauses.
    prompt: isCanonicalQueryPlanV3SchemaVersion(queryPlan.schemaVersion)
      ? canonicalDiscoverySummary(queryPlan)
      : safePrompt(run),
    requestedTrackCount: target,
    storefront: queryPlan.storefront,
    intents: intentsFromQueryPlan(queryPlan),
    engines: [...queryPlan.engines],
    membershipPredicates,
    rankingObjectives,
    scopeKind,
    hardConstraints: cloneConstraints(queryPlan.hardConstraints),
    softPreferences: cloneConstraints(queryPlan.softPreferences),
    sourceDiscoveryHints: queryPlan.sourceDiscoveryHints.map((hint) => ({ ...hint })),
    conceptDiscoveryHints: clonePipelineV3ConceptDiscoveryHints(
      queryPlan.conceptDiscoveryHints,
    ),
    ...(isCanonicalQueryPlanV3SchemaVersion(queryPlan.schemaVersion) ? {
      playlistQuotaRules: (queryPlan.playlistQuotaRules ?? []).map((rule) => ({
        ...rule,
        values: [...rule.values],
        ...(rule.predicate ? { predicate: structuredClone(rule.predicate) } : {}),
      })),
      ...(queryPlan.playlistQualityPolicy ? {
        playlistQualityPolicy: {
          ...queryPlan.playlistQualityPolicy,
          clauseIds: [...queryPlan.playlistQualityPolicy.clauseIds],
          criteria: [...queryPlan.playlistQualityPolicy.criteria],
        },
      } : {}),
      canonicalContractPolicy: structuredClone(queryPlan.canonicalContractPolicy!),
      ...(queryPlan.executionDirectives ? {
        executionDirectives: structuredClone(queryPlan.executionDirectives),
      } : {}),
    } : {}),
    diversityGoals,
    orderingPolicy,
    softGoalRelaxationOrder: isCanonicalQueryPlanV3SchemaVersion(
      queryPlan.schemaVersion,
    )
      ? []
      : queryPlan.softGoalRelaxationOrder
        ? [...queryPlan.softGoalRelaxationOrder]
        : [
          "sequencing_preferences",
          "album_concentration",
          "artist_concentration",
          "era_balance",
          "subgenre_regional_representation",
        ],
    criticalAmbiguities: [],
    recordingPolicy: queryPlan.schemaVersion >= 2
      ? {
          allowedVersions: [...queryPlan.recordingPolicy!.allowedVersions],
          preferCanonicalStudio: queryPlan.recordingPolicy!.preferCanonicalStudio,
          excludeKaraokeTributeAndCovers: queryPlan.recordingPolicy!.excludeKaraokeTributeAndCovers,
        }
      : {
          allowedVersions: ["canonical", "clean", "explicit"],
          preferCanonicalStudio: true,
          excludeKaraokeTributeAndCovers: true,
        },
    semanticPolicyVersion: SEMANTIC_SCOPE_POLICY_VERSION,
    musicConceptPolicyVersion: MUSIC_CONCEPT_POLICY_VERSION,
    semanticClauses,
    contextSignals,
    catalogPolicies,
    explicitUserConstraintHash,
    semanticAudit: {
      version: SEMANTIC_PLAN_V3_1_VERSION,
      musicConceptPolicyVersion: MUSIC_CONCEPT_POLICY_VERSION,
      passed: true,
      hardConstraintHash: semanticHardConstraintHash,
      aliasCollapses: queryPlan.schemaVersion >= 2
        ? [...queryPlan.semanticAuditMetadata!.aliasCollapses]
        : [],
      contradictions: [],
    },
    confirmed: true,
    resolvedAmbiguityKeys: [],
  };
  if (isCanonicalQueryPlanV3SchemaVersion(queryPlan.schemaVersion)) {
    assertCanonicalContractExecutionPolicyV1(plan.canonicalContractPolicy!);
  }
  return Object.freeze(plan);
}

export function v3RetrievalStageKey(
  queryPlan: QueryPlanV3,
  executionMode: RetrievalExecutionModeV3,
): string {
  return `v3-retrieval:${executionMode}:${queryPlanV3Hash(queryPlan).slice(0, 48)}`;
}

export function createPipelineV3RetrievalExecutionPort(input: {
  adapters: RetrievalAdaptersV3;
}): PipelineV3RetrievalExecutionPort {
  return Object.freeze({
    async execute(request: PipelineV3RetrievalExecutionInput): Promise<RetrievalResultV3> {
      abortIfNeeded(request.signal);
      const discoveryBatches: Array<{
        request: DiscoveryRequestV3;
        batch: DiscoveryBatchV3;
      }> = [];
      const qualificationBatches: Array<{
        request: QualificationRequestV3;
        qualifications: readonly CandidateQualificationV3[];
      }> = [];
      const adapters: RetrievalAdaptersV3 = {
        discover: async (discoveryRequest) => {
          abortIfNeeded(request.signal);
          const batch = await input.adapters.discover(discoveryRequest);
          abortIfNeeded(request.signal);
          if (request.recordDiscoveryBatch) {
            discoveryBatches.push({ request: discoveryRequest, batch });
          }
          return batch;
        },
        qualify: async (qualificationRequest) => {
          abortIfNeeded(request.signal);
          const qualifications = await input.adapters.qualify(qualificationRequest);
          abortIfNeeded(request.signal);
          if (request.recordQualificationBatch) {
            qualificationBatches.push({
              request: qualificationRequest,
              qualifications,
            });
          }
          return qualifications;
        },
      };
      // Flush outside the retrieval scheduler's provider try/catch. A durable
      // persistence/fence failure is an integrity failure, never a provider
      // outage or evidence scarcity signal. Flush successful observations even
      // when a later provider/budget operation fails so a durable retry can
      // resume from paid work instead of purchasing the same evidence again.
      const flushObservedBatches = async (): Promise<void> => {
        for (const observed of discoveryBatches) {
          await request.recordDiscoveryBatch?.(observed.request, observed.batch);
          abortIfNeeded(request.signal);
        }
        for (const observed of qualificationBatches) {
          await request.recordQualificationBatch?.(
            observed.request,
            observed.qualifications,
          );
          abortIfNeeded(request.signal);
        }
      };
      try {
        const result = await executeRetrievalV3({
          runId: request.runId,
          plan: request.plan,
          adapters,
          executionMode: request.executionMode,
          routingHints: request.routingHints,
          modelRoute: request.modelRoute,
          semanticRecoveryEnabled: request.semanticRecoveryEnabled,
          claimSemanticRecovery: request.claimSemanticRecovery,
          policy: request.policy,
          continuation: request.continuation,
          signal: request.signal,
        });
        abortIfNeeded(request.signal);
        await flushObservedBatches();
        return result;
      } catch (error) {
        await flushObservedBatches();
        throw error;
      }
    },
  });
}

const PIPELINE_V3_POLICY_V1_PROVIDER_FAILURES_PER_STRATEGY = 2;

function immutablePositiveInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`Pipeline V3 immutable retrieval policy has an invalid ${field}`);
  }
  return Number(value);
}

/**
 * Rehydrate the complete retrieval contract from the run snapshot.
 *
 * `maximumCostUnits` is the frozen total tool-call allowance: discovery
 * adapters report bounded provider work units, not dollars. Pipeline policy
 * v1 intentionally has no wall-clock retrieval deadline so durable jobs can
 * resume on another worker without expiring solely because they were queued.
 * The retry threshold is fixed by the persisted policy version, rather than a
 * mutable worker environment variable.
 */
export function retrievalPolicyV3FromPipelinePolicySnapshot(
  snapshot: PipelinePolicySnapshot | null | undefined,
): RetrievalPolicyV3 {
  if (!snapshot
    || snapshot.pipelineVersion !== "corpus_first_v3"
    || snapshot.policyVersion !== "corpus_first_v3_policy_v1"
    || snapshot.executionPolicy.kind !== "corpus_first_v3"
    || snapshot.executionPolicy.version !== "corpus_first_v3_policy_v1") {
    throw new Error("Pipeline V3 run is missing its immutable retrieval policy");
  }
  const execution = snapshot.executionPolicy;
  const maximumGlobalRounds = immutablePositiveInteger(
    execution.maximumGlobalRounds,
    "maximumGlobalRounds",
    1_000,
  );
  const maximumRawCandidates = immutablePositiveInteger(
    execution.maximumRawCandidates,
    "maximumRawCandidates",
    100_000,
  );
  const maximumRawDiscoveryGoal = immutablePositiveInteger(
    snapshot.catalogLimits.maximumRawDiscoveryGoal,
    "maximumRawDiscoveryGoal",
    100_000,
  );
  if (maximumRawCandidates !== maximumRawDiscoveryGoal) {
    throw new Error("Pipeline V3 immutable retrieval policy has conflicting candidate ceilings");
  }
  const maximumCostUnits = immutablePositiveInteger(
    snapshot.requestLimits.maxToolCalls,
    "maxToolCalls",
    200,
  );
  const candidateGoal = execution.candidateGoal === undefined
    ? undefined
    : immutablePositiveInteger(execution.candidateGoal, "candidateGoal", 100_000);
  const qualifiedPoolGoal = execution.qualifiedPoolGoal === undefined
    ? candidateGoal
    : immutablePositiveInteger(
        execution.qualifiedPoolGoal,
        "qualifiedPoolGoal",
        100_000,
      );
  if (candidateGoal !== undefined
    && qualifiedPoolGoal !== undefined
    && qualifiedPoolGoal > candidateGoal) {
    throw new Error("Pipeline V3 immutable retrieval policy has an inverted candidate reserve");
  }
  return Object.freeze({
    maximumGlobalRounds,
    maximumRawCandidates,
    // Snapshots emitted before qualifiedPoolGoal existed used candidateGoal as
    // the final safe pool. Preserve those in-flight contracts exactly. New
    // snapshots carry both values and use candidateGoal only for discovery.
    ...(execution.qualifiedPoolGoal === undefined || candidateGoal === undefined
      ? {}
      : { candidateGoal }),
    ...(qualifiedPoolGoal === undefined ? {} : { qualifiedPoolGoal }),
    maximumCostUnits,
    deadlineAtEpochMs: null,
    maximumProviderFailuresPerStrategy: PIPELINE_V3_POLICY_V1_PROVIDER_FAILURES_PER_STRATEGY,
  });
}

function fullCheckpointKey(stageKey: string): string {
  return stageKey.slice(0, 120);
}

function latestCheckpoint(
  result: RetrievalResultV3,
  plan: SelectionPlanV3,
  stageKey: string,
  queryPlanHash: string,
  queryPlanRevisionId: string | null,
): Record<string, unknown> {
  return {
    schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
    state: result.outcome.status === "failed_integrity"
      ? "failed_integrity"
      : "complete",
    stageKey,
    queryPlanHash,
    queryPlanRevisionId,
    executionMode: result.executionMode,
    outcome: result.outcome,
    publicationBoundary: result.publicationBoundary,
    stages: result.stages,
    deficit: result.deficit,
    strategies: result.strategies,
    selected: result.selected,
    reserve: result.reserve,
    centralQuality: result.centralQuality ?? null,
    playlistOptimization: evaluatePlaylistOptimizationV3({
      plan,
      tracks: result.selected,
    }),
    predicateDiagnostics: result.predicateDiagnostics ?? null,
    compatibleAlternatesByRecordingFamily: result.compatibleAlternatesByRecordingFamily,
    completedAt: new Date().toISOString(),
  };
}

function partialOutcomeHash(input: {
  runId: string;
  queryPlanHash: string;
  outcomeVersion: number;
  result: RetrievalResultV3;
}): string {
  return createHash("sha256").update(stableStringify({
    runId: input.runId,
    queryPlanHash: input.queryPlanHash,
    outcomeVersion: input.outcomeVersion,
    targetTrackCount: input.result.outcome.requestedTrackCount,
    stopReason: input.result.outcome.stopReason,
    tracks: input.result.selected.map((track) => [
      track.candidateId,
      track.appleSongId,
      track.recordingFamilyKey,
    ]),
  })).digest("hex");
}

export type GovernedCorpusActionReasonV3 =
  | "v3_exhaustive_frontier_builder_unavailable"
  | "v3_factual_graph_snapshot_has_no_qualified_candidates";

/**
 * Factual retrieval is intentionally warm-graph only until a licensed,
 * reviewable corpus-ingestion worker exists. Exhaustive retrieval needs an
 * additional source-frontier builder, so it must fail closed before the graph
 * adapter can misleadingly describe one empty snapshot traversal as complete.
 */
export function governedCorpusActionReasonV3(
  queryPlan: QueryPlanV3,
  result?: RetrievalResultV3,
): GovernedCorpusActionReasonV3 | null {
  if (queryPlan.engines.includes("exhaustive")
    && queryPlan.corpusReview?.enumerationComplete !== true) {
    return "v3_exhaustive_frontier_builder_unavailable";
  }
  if (!queryPlan.engines.includes("factual_relationship") || !result) return null;
  if (result.outcome.status !== "no_compatible_tracks") return null;
  const factualStrategies = result.strategies.filter((strategy) => (
    strategy.engine === "factual_relationship"
  ));
  const rawCandidates = factualStrategies.reduce((total, strategy) => (
    total + strategy.rawCandidates
  ), 0);
  return rawCandidates === 0
    ? "v3_factual_graph_snapshot_has_no_qualified_candidates"
    : null;
}

function governedCorpusPhase(reasonCode: GovernedCorpusActionReasonV3): string {
  return reasonCode === "v3_exhaustive_frontier_builder_unavailable"
    ? "v3_waiting_for_exhaustive_corpus_frontier"
    : "v3_waiting_for_factual_corpus_review";
}

async function settleGovernedCorpusActionRequired(input: {
  repository: PipelineV3WorkerRepository;
  runId: string;
  queryPlan: QueryPlanV3;
  stageKey: string;
  queryPlanHash: string;
  queryPlanRevisionId: string | null;
  executionMode: RetrievalExecutionModeV3;
  fence: PipelineV3WriteFence;
  reasonCode: GovernedCorpusActionReasonV3;
  result?: RetrievalResultV3;
  corpusBuild?: {
    sourceDocumentCount: number;
    observationCount: number;
    enumerationComplete: boolean;
    unresolvedGapCount: number;
  };
}): Promise<void> {
  const recordedAt = new Date().toISOString();
  const checkpoint = {
    schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
    state: "owner_action_required",
    actionKind: "corpus_review",
    reasonCode: input.reasonCode,
    stageKey: input.stageKey,
    queryPlanHash: input.queryPlanHash,
    queryPlanRevisionId: input.queryPlanRevisionId,
    graphSnapshotId: input.queryPlan.graphSnapshotId,
    executionMode: input.executionMode,
    engines: input.queryPlan.engines,
    requestedTrackCount: input.queryPlan.targetTrackCount,
    ...(input.corpusBuild ? { corpusBuild: input.corpusBuild } : {}),
    ...(input.result ? {
      outcome: input.result.outcome,
      publicationBoundary: input.result.publicationBoundary,
      stages: input.result.stages,
      deficit: input.result.deficit,
      strategies: input.result.strategies,
    } : {}),
    recordedAt,
  };
  await input.repository.saveResearchCheckpoint(
    input.runId,
    fullCheckpointKey(input.stageKey),
    checkpoint,
    input.fence,
  );
  await input.repository.saveResearchCheckpoint(
    input.runId,
    "v3:corpus:action-required",
    checkpoint,
    input.fence,
  );
  if (input.result) {
    await input.repository.saveResearchCheckpoint(input.runId, "v3:retrieval:latest", {
      ...checkpoint,
      manifestId: null,
      manifestRevisionId: null,
      manifestHash: null,
      publicationState: "not_applicable",
    }, input.fence);
  }
  await input.repository.updateRun(input.runId, {
    status: "waiting_for_corpus_review",
    phase: governedCorpusPhase(input.reasonCode),
    error: null,
  }, input.fence);
}

export class PipelineV3WorkerExecution {
  constructor(
    private readonly repository: PipelineV3WorkerRepository,
    private readonly retrieval: PipelineV3RetrievalExecutionPort | null = null,
    private readonly corpusBuilder: ColdCorpusBuilderPortV3 | null = null,
  ) {}

  private async continuationSeed(
    runId: string,
    queryPlan: QueryPlanV3,
  ): Promise<RetrievalContinuationSeedV3 | undefined> {
    const continuation = queryPlan.continuation;
    if (!continuation) return undefined;
    const [sourceValue, partialValue] = await Promise.all([
      this.repository.getResearchCheckpoint(runId, fullCheckpointKey(continuation.sourceStageKey)),
      this.repository.getResearchCheckpoint(runId, "partial_ready"),
    ]);
    const source = sourceValue && typeof sourceValue === "object" && !Array.isArray(sourceValue)
      ? sourceValue as Record<string, unknown>
      : null;
    const partial = partialValue && typeof partialValue === "object" && !Array.isArray(partialValue)
      ? partialValue as Record<string, unknown>
      : null;
    if (!source
      || source.state !== "complete"
      || source.stageKey !== continuation.sourceStageKey
      || source.queryPlanHash !== continuation.sourceQueryPlanHash
      || source.queryPlanRevisionId !== continuation.sourceQueryPlanRevisionId
      || partial?.outcomeHash !== continuation.sourceOutcomeHash
      || Number(partial?.outcomeVersion) !== continuation.sourceOutcomeVersion
      || !Array.isArray(source.selected)
      || !Array.isArray(source.reserve)
      || !Array.isArray(source.strategies)
      || !source.stages || typeof source.stages !== "object" || Array.isArray(source.stages)
      || !source.compatibleAlternatesByRecordingFamily
      || typeof source.compatibleAlternatesByRecordingFamily !== "object"
      || Array.isArray(source.compatibleAlternatesByRecordingFamily)) {
      throw new Error("Pipeline V3 continuation source failed integrity validation");
    }
    const qualifiedTracks = [
      ...source.selected,
      ...source.reserve,
    ] as RetrievalContinuationSeedV3["qualifiedTracks"];
    if (queryPlan.schemaVersion >= 4) {
      if (!this.repository.validatePipelineV3ContinuationQualifications) {
        throw new Error(
          "Pipeline V3 continuation qualification integrity is unavailable",
        );
      }
      await this.repository.validatePipelineV3ContinuationQualifications({
        runId,
        queryPlan,
        tracks: qualifiedTracks,
      });
    }
    return {
      approvedStrategyIds: [...continuation.strategyIds],
      qualifiedTracks,
      // Canonical continuation validation currently authenticates only the
      // selected/reserve qualification rows. Older checkpoints may contain
      // convenience alternates that were never persisted or hash-bound. Do
      // not let those untrusted rows re-enter ranking for schema-4+ work.
      compatibleAlternatesByRecordingFamily: queryPlan.schemaVersion >= 4
        ? {}
        : source.compatibleAlternatesByRecordingFamily as RetrievalContinuationSeedV3["compatibleAlternatesByRecordingFamily"],
      stages: source.stages as unknown as RetrievalContinuationSeedV3["stages"],
      strategies: source.strategies as RetrievalContinuationSeedV3["strategies"],
    };
  }

  async process(input: {
    runId: string;
    run: {
      prompt?: string;
      brief?: { title?: string; description?: string };
      pipelinePolicySnapshot?: PipelinePolicySnapshot | null;
    };
    queryPlan: QueryPlanV3;
    payload?: PipelineV3WorkerPayload;
    signal?: AbortSignal;
  }): Promise<void> {
    const mode: RetrievalExecutionModeV3 = input.payload?.v3ExecutionMode === "shadow" ? "shadow" : "active";
    const stageKey = v3RetrievalStageKey(input.queryPlan, mode);
    const queryPlanHash = queryPlanV3Hash(input.queryPlan);
    const suppliedStageKey = input.payload?.__jobStageKey ?? input.payload?.stageExecutionKey;
    // Durable writes are fenced by the stage identity that was actually
    // leased from job_queue.  If it differs from the recomputed query-plan
    // stage, use that supplied identity to record the integrity failure; a
    // fence built from the recomputed key would itself be rejected as a lost
    // lease and hide the real corruption signal.
    const fence = writeFence(input.payload, suppliedStageKey ?? "");
    abortIfNeeded(input.signal);
    if (suppliedStageKey && suppliedStageKey !== stageKey) {
      await this.repository.saveResearchCheckpoint(input.runId, fullCheckpointKey(stageKey), {
        schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
        state: "failed_integrity",
        stageKey,
        suppliedStageKey,
        code: "v3_stage_execution_key_mismatch",
        failedAt: new Date().toISOString(),
      }, fence);
      abortIfNeeded(input.signal);
      await this.repository.updateRun(input.runId, {
        status: "failed_integrity",
        phase: "v3_stage_execution_key_mismatch",
        error: null,
      }, fence);
      return;
    }

    let optimizerBudgetPass = 1;
    let optimizerRetryContinuation: RetrievalContinuationSeedV3 | undefined;
    const prior = await this.repository.getResearchCheckpoint(input.runId, fullCheckpointKey(stageKey));
    if (prior && typeof prior === "object" && !Array.isArray(prior)) {
      const priorRecord = prior as Record<string, unknown>;
      const priorState = priorRecord.state;
      if (priorState === "failed_integrity"
        && priorRecord.code === "v3_retrieval_provider_non_retryable") {
        const parsedFailureClass = parsedRetrievalDependencyFailureClass(
          priorRecord.failureClass,
        );
        const failureClass: RetrievalDependencyFailureClassV3 =
          parsedFailureClass === "transient"
            || parsedFailureClass === "rate_limited"
            ? "permanent"
            : parsedFailureClass;
        // A crash may occur after the fenced checkpoint but before the run
        // status/quarantine writes. Re-drive only the durable quarantine on
        // the successor lease; never call the provider or report this
        // operator fault as a completed stage.
        throw new PipelineV3DependencyUnavailableError(
          "v3_retrieval_provider",
          typeof priorRecord.reasonCode === "string"
            ? priorRecord.reasonCode
            : `v3_retrieval_provider_${failureClass}`,
          null,
          failureClass,
        );
      }
      if (priorState === "complete"
        || priorState === "owner_action_required" || priorState === "failed_integrity") {
        return;
      }
      if (priorState === "waiting_compute"
        && priorRecord.code === "optimizer_search_budget_exhausted") {
        const priorBudgetPass = Number(priorRecord.budgetPass);
        if (!Number.isSafeInteger(priorBudgetPass)
          || priorBudgetPass < 1
          || priorBudgetPass > 2) {
          throw new Error("Pipeline V3 optimizer budget checkpoint is invalid");
        }
        if (priorBudgetPass >= 2) {
          throw new PipelineV3OptimizerComputeBudgetError(2, false);
        }
        const retrySeed = priorRecord.optimizerRetrySeed;
        if (priorRecord.stageKey !== stageKey
          || priorRecord.queryPlanHash !== queryPlanHash
          || !retrySeed
          || typeof retrySeed !== "object"
          || Array.isArray(retrySeed)) {
          throw new Error("Pipeline V3 optimizer retry checkpoint is invalid");
        }
        const retryRecord = retrySeed as Record<string, unknown>;
        if (retryRecord.providerCallPermitted !== false
          || !Array.isArray(retryRecord.approvedStrategyIds)
          || retryRecord.approvedStrategyIds.length !== 0
          || !Array.isArray(retryRecord.qualifiedTracks)
          || retryRecord.qualifiedTracks.length === 0
          || retryRecord.qualifiedTracks.length > 5_000
          || !Array.isArray(retryRecord.strategies)
          || !retryRecord.stages
          || typeof retryRecord.stages !== "object"
          || Array.isArray(retryRecord.stages)
          || !retryRecord.compatibleAlternatesByRecordingFamily
          || typeof retryRecord.compatibleAlternatesByRecordingFamily !== "object"
          || Array.isArray(retryRecord.compatibleAlternatesByRecordingFamily)) {
          throw new Error("Pipeline V3 optimizer retry checkpoint is invalid");
        }
        optimizerRetryContinuation = retrySeed as RetrievalContinuationSeedV3;
        optimizerBudgetPass = priorBudgetPass + 1;
      }
      if (priorState === "waiting_provider") {
        const priorLeaseEpoch = Number(priorRecord.leaseEpoch);
        const currentLeaseEpoch = Number(input.payload?.__jobLeaseEpoch);
        // An incomplete dependency wait must never look like a successful
        // handler return. Only a successor lease with a configured provider
        // may resume; all other deliveries stay on the durable retry circuit.
        if (!this.retrieval || (Number.isSafeInteger(priorLeaseEpoch)
          && currentLeaseEpoch <= priorLeaseEpoch)) {
          throw new PipelineV3DependencyUnavailableError(
            "v3_retrieval_provider",
            typeof priorRecord.reasonCode === "string"
              ? priorRecord.reasonCode
              : "v3_retrieval_provider_unavailable",
            parsedRetryAfterUntil(priorRecord.retryAfterUntil),
            parsedRetrievalDependencyFailureClass(priorRecord.failureClass),
          );
        }
      }
    }

    if (queryPlanV3RequiresLegacyCanonicalExecutor(input.queryPlan)) {
      const recordedAt = new Date().toISOString();
      const checkpoint = {
        schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
        state: "owner_action_required",
        actionKind: "canonical_successor",
        reasonCode: "legacy_canonical_executor_required",
        stageKey,
        queryPlanHash,
        queryPlanRevisionId: input.payload?.__queryPlanRevisionId ?? null,
        executionMode: mode,
        engines: input.queryPlan.engines,
        requestedTrackCount: input.queryPlan.targetTrackCount,
        requiredQueryPlanSchemaVersion: 5,
        actions: ["create_user_authored_revision", "cancel"],
        automaticResume: false,
        recordedAt,
      };
      await this.repository.saveResearchCheckpoint(
        input.runId,
        fullCheckpointKey(stageKey),
        checkpoint,
        fence,
      );
      if (mode === "active") {
        const contractRevisionDatabaseId =
          input.payload?.__contractRevisionDatabaseId;
        if (!contractRevisionDatabaseId || !this.repository.openPlaylistRunBlocker) {
          await this.repository.updateRun(input.runId, {
            status: "failed_integrity",
            phase: "legacy_canonical_executor_fence_unavailable",
            error: null,
          }, fence);
          return;
        }
        await this.repository.openPlaylistRunBlocker({
          runId: input.runId,
          contractRevisionId: contractRevisionDatabaseId,
          blockerKind: "scope_decision",
          dependencyKey: "legacy_schema4_executor",
          retryCount: 0,
          nextRetryAt: null,
          automaticRetryUntil: null,
          state: checkpoint,
          fence,
        });
        await this.repository.updateRun(input.runId, {
          status: "needs_decision",
          phase: "legacy_canonical_successor_required",
          error: null,
        }, fence);
      }
      return;
    }
    if (input.queryPlan.schemaVersion === 6) {
      const recordedAt = new Date().toISOString();
      try {
        const expression = input.queryPlan.verificationExpression;
        const persistedCoverage = input.queryPlan.executionCoverageReport;
        const executionEvidencePolicyVersion =
          input.queryPlan.canonicalContractPolicy?.evidencePolicyVersion ?? "";
        const runtimeConfigurationHash =
          input.payload?.__executorSemanticConfigurationHash?.trim() ?? "";
        const runtimeCapability = canonicalExecutorCapabilityForSchemaV1({
          queryPlanSchemaVersion: 6,
        });
        if (!expression
          || !persistedCoverage
          || !/^[0-9a-f]{64}$/u.test(runtimeConfigurationHash)
          || input.queryPlan.executorCapabilityHash !== runtimeCapability.hash
          || persistedCoverage.workerCapabilityHash !== runtimeCapability.hash
          || persistedCoverage.configurationHash !== runtimeConfigurationHash
          || persistedCoverage.ontologyVersion !== MUSIC_CONCEPT_POLICY_VERSION
          || persistedCoverage.evidencePolicyVersion
            !== executionEvidencePolicyVersion) {
          throw new Error("execution_coverage_runtime_identity_mismatch");
        }
        const workerClaimCoverage = revalidateExecutionCoverageReportV1({
          expression,
          persisted: persistedCoverage,
          stage: "worker_claim",
          workerCapabilityHash: runtimeCapability.hash,
          configurationHash: runtimeConfigurationHash,
          ontologyVersion: MUSIC_CONCEPT_POLICY_VERSION,
          evidencePolicyVersion: executionEvidencePolicyVersion,
        });
        if (!workerClaimCoverage.complete) {
          throw new Error("execution_coverage_incomplete");
        }
        await this.repository.saveResearchCheckpoint(
          input.runId,
          "v3:coverage:worker-claim",
          {
            ...workerClaimCoverage,
            queryPlanHash,
            queryPlanRevisionId:
              input.payload?.__queryPlanRevisionId ?? null,
            recordedAt,
          },
          fence,
        );
      } catch (error) {
        const reason = error instanceof Error
          ? error.message
          : "execution_coverage_worker_claim_failed";
        await this.repository.saveResearchCheckpoint(
          input.runId,
          fullCheckpointKey(stageKey),
          {
            schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
            state: "failed_integrity",
            stageKey,
            queryPlanHash,
            code: "v3_execution_coverage_worker_claim_failed",
            reason,
            failedAt: recordedAt,
          },
          fence,
        );
        await this.repository.updateRun(input.runId, {
          status: "failed_integrity",
          phase: "v3_execution_coverage_worker_claim_failed",
          error: null,
        }, fence);
        return;
      }
    }
    let modelRoute: PipelineV3ModelRoute;
    try {
      modelRoute = pipelineV3ModelRouteFromPolicySnapshot(input.run.pipelinePolicySnapshot);
    } catch {
      await this.repository.saveResearchCheckpoint(input.runId, fullCheckpointKey(stageKey), {
        schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
        state: "failed_integrity",
        stageKey,
        queryPlanHash,
        code: "v3_model_route_snapshot_invalid",
        failedAt: new Date().toISOString(),
      }, fence);
      await this.repository.updateRun(input.runId, {
        status: "failed_integrity",
        phase: "v3_model_route_snapshot_invalid",
        error: null,
      }, fence);
      return;
    }
    const startedAt = new Date().toISOString();
    await this.repository.saveResearchCheckpoint(input.runId, fullCheckpointKey(stageKey), {
      schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
      state: "in_progress",
      stageKey,
      queryPlanHash,
      graphSnapshotId: input.queryPlan.graphSnapshotId,
      executionMode: mode,
      leaseEpoch: Number.isSafeInteger(input.payload?.__jobLeaseEpoch)
        ? input.payload?.__jobLeaseEpoch
        : null,
      queryPlanRevisionId: input.payload?.__queryPlanRevisionId ?? null,
      startedAt,
    }, fence);
    abortIfNeeded(input.signal);
    await this.repository.updateRun(input.runId, {
      status: "researching",
      phase: mode === "shadow" ? "v3_shadow_retrieval" : "v3_retrieval",
      error: null,
    }, fence);

    let plan: SelectionPlanV3;
    try {
      plan = selectionPlanFromQueryPlanV3(input.queryPlan, input.run);
    } catch {
      abortIfNeeded(input.signal);
      await this.repository.saveResearchCheckpoint(input.runId, fullCheckpointKey(stageKey), {
        schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
        state: "failed_integrity",
        stageKey,
        queryPlanHash,
        code: "v3_query_plan_rehydration_failed",
        failedAt: new Date().toISOString(),
      }, fence);
      abortIfNeeded(input.signal);
      await this.repository.updateRun(input.runId, {
        status: "failed_integrity",
        phase: "v3_query_plan_rehydration_failed",
        error: null,
      }, fence);
      return;
    }

    const preflightCorpusReason = governedCorpusActionReasonV3(input.queryPlan);
    if (preflightCorpusReason) {
      if (!this.corpusBuilder) {
        await settleGovernedCorpusActionRequired({
          repository: this.repository,
          runId: input.runId,
          queryPlan: input.queryPlan,
          stageKey,
          queryPlanHash,
          queryPlanRevisionId: input.payload?.__queryPlanRevisionId ?? null,
          executionMode: mode,
          fence,
          reasonCode: preflightCorpusReason,
        });
        return;
      }
      if (!this.repository.ingestPipelineV3ColdCorpus) {
        throw new Error("Pipeline V3 cold-corpus persistence is unavailable");
      }
      const corpus = await this.corpusBuilder.build({
        runId: input.runId,
        plan,
        queryPlan: input.queryPlan,
        modelRoute,
        signal: input.signal,
      });
      abortIfNeeded(input.signal);
      const corpusBuild = await this.repository.ingestPipelineV3ColdCorpus({
        runId: input.runId,
        queryPlan: input.queryPlan,
        result: corpus,
        fence,
      });
      abortIfNeeded(input.signal);
      await settleGovernedCorpusActionRequired({
        repository: this.repository,
        runId: input.runId,
        queryPlan: input.queryPlan,
        stageKey,
        queryPlanHash,
        queryPlanRevisionId: input.payload?.__queryPlanRevisionId ?? null,
        executionMode: mode,
        fence,
        reasonCode: preflightCorpusReason,
        corpusBuild,
      });
      return;
    }
    let retrievalPolicy: RetrievalPolicyV3;
    try {
      retrievalPolicy = retrievalPolicyV3FromPipelinePolicySnapshot(input.run.pipelinePolicySnapshot);
    } catch {
      await this.repository.saveResearchCheckpoint(input.runId, fullCheckpointKey(stageKey), {
        schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
        state: "failed_integrity",
        stageKey,
        queryPlanHash,
        code: "v3_retrieval_policy_snapshot_invalid",
        failedAt: new Date().toISOString(),
      }, fence);
      await this.repository.updateRun(input.runId, {
        status: "failed_integrity",
        phase: "v3_retrieval_policy_snapshot_invalid",
        error: null,
      }, fence);
      return;
    }
    if (Number.isFinite(input.payload?.__contractActiveComputeConsumedMs)) {
      const consumed = Math.max(
        0,
        Number(input.payload?.__contractActiveComputeConsumedMs ?? 0),
      );
      const allowance = Number.isFinite(input.payload?.__contractActiveComputeAllowanceMs)
        ? Math.max(
            PIPELINE_V3_ACTIVE_COMPUTE_LIMIT_MS,
            Number(input.payload?.__contractActiveComputeAllowanceMs),
          )
        : PIPELINE_V3_ACTIVE_COMPUTE_LIMIT_MS;
      retrievalPolicy = Object.freeze({
        ...retrievalPolicy,
        deadlineAtEpochMs: Date.now()
          + Math.max(0, allowance - consumed),
      });
    }

    if (!this.retrieval) {
      abortIfNeeded(input.signal);
      await this.repository.saveResearchCheckpoint(input.runId, fullCheckpointKey(stageKey), {
        schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
        state: "waiting_provider",
        stageKey,
        queryPlanHash,
        graphSnapshotId: input.queryPlan.graphSnapshotId,
        executionMode: mode,
        reasonCode: "v3_retrieval_provider_unavailable",
        failureClass: "transient",
        leaseEpoch: Number.isSafeInteger(input.payload?.__jobLeaseEpoch)
          ? input.payload?.__jobLeaseEpoch
          : null,
        startedAt,
        waitingAt: new Date().toISOString(),
      }, fence);
      abortIfNeeded(input.signal);
      await this.repository.updateRun(input.runId, {
        status: "queued",
        phase: "v3_waiting_for_retrieval_provider",
        error: null,
      }, fence);
      throw new PipelineV3DependencyUnavailableError(
        "v3_retrieval_provider",
        "v3_retrieval_provider_unavailable",
      );
    }

    let continuation: RetrievalContinuationSeedV3 | undefined;
    try {
      continuation = optimizerRetryContinuation
        ?? await this.continuationSeed(input.runId, input.queryPlan);
    } catch {
      abortIfNeeded(input.signal);
      await this.repository.saveResearchCheckpoint(input.runId, fullCheckpointKey(stageKey), {
        schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
        state: "failed_integrity",
        stageKey,
        queryPlanHash,
        code: "v3_continuation_source_invalid",
        failedAt: new Date().toISOString(),
      }, fence);
      await this.repository.updateRun(input.runId, {
        status: "failed_integrity",
        phase: "v3_continuation_source_invalid",
        error: null,
      }, fence);
      return;
    }
    const requiresSeparatedRecoveryPersistence = mode === "active"
      && input.queryPlan.schemaVersion >= 4;
    if (requiresSeparatedRecoveryPersistence
      && (!this.repository.persistPipelineV3DiscoveryBatch
        || !this.repository.persistPipelineV3QualificationBatch)) {
      await this.repository.saveResearchCheckpoint(input.runId, fullCheckpointKey(stageKey), {
        schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
        state: "failed_integrity",
        stageKey,
        queryPlanHash,
        code: "v3_recovery_persistence_unavailable",
        failedAt: new Date().toISOString(),
      }, fence);
      await this.repository.updateRun(input.runId, {
        status: "failed_integrity",
        phase: "v3_recovery_persistence_unavailable",
        error: null,
      }, fence);
      return;
    }
    if (requiresSeparatedRecoveryPersistence
      && !this.repository.persistPipelineV3RuntimeFeasibilitySnapshot) {
      await this.repository.saveResearchCheckpoint(input.runId, fullCheckpointKey(stageKey), {
        schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
        state: "failed_integrity",
        stageKey,
        queryPlanHash,
        code: "v3_runtime_feasibility_persistence_unavailable",
        failedAt: new Date().toISOString(),
      }, fence);
      await this.repository.updateRun(input.runId, {
        status: "failed_integrity",
        phase: "v3_runtime_feasibility_persistence_unavailable",
        error: null,
      }, fence);
      return;
    }
    const recordNonRetryableProviderFailure = async (
      failureClass: RetrievalDependencyFailureClassV3,
      reasonCode: string,
    ): Promise<void> => {
      const checkpoint = {
        schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
        state: "failed_integrity",
        stageKey,
        queryPlanHash,
        queryPlanRevisionId: input.payload?.__queryPlanRevisionId ?? null,
        graphSnapshotId: input.queryPlan.graphSnapshotId,
        executionMode: mode,
        code: "v3_retrieval_provider_non_retryable",
        reasonCode,
        failureClass,
        retryable: false,
        nextAction: "contact_support",
        failedAt: new Date().toISOString(),
      };
      abortIfNeeded(input.signal);
      await this.repository.saveResearchCheckpoint(
        input.runId,
        fullCheckpointKey(stageKey),
        checkpoint,
        fence,
      );
      await this.repository.saveResearchCheckpoint(
        input.runId,
        "v3:retrieval:latest",
        checkpoint,
        fence,
      );
      abortIfNeeded(input.signal);
      await this.repository.updateRun(input.runId, {
        status: "failed_integrity",
        phase: `v3_retrieval_provider_${failureClass}`,
        error: null,
      }, fence);
    };
    let result: RetrievalResultV3;
    try {
      result = await withPlaylistOptimizationBudgetV1(
        playlistOptimizationBudgetForPassV1(optimizerBudgetPass),
        () => this.retrieval!.execute({
          runId: input.runId,
          plan,
          executionMode: mode,
          routingHints: { fixedContainer: input.queryPlan.engines.includes("fixed_container") },
          modelRoute,
          semanticRecoveryEnabled: input.queryPlan.schemaVersion >= 2,
          policy: retrievalPolicy,
          continuation,
          ...(requiresSeparatedRecoveryPersistence ? {
            recordDiscoveryBatch: async (request, batch) => {
              await this.repository.persistPipelineV3DiscoveryBatch!({
                runId: input.runId,
                queryPlan: input.queryPlan,
                request,
                batch,
                fence,
              });
            },
            recordQualificationBatch: async (request, qualifications) => {
              await this.repository.persistPipelineV3QualificationBatch!({
                runId: input.runId,
                queryPlan: input.queryPlan,
                request,
                qualifications,
                fence,
              });
            },
          } : {}),
          claimSemanticRecovery: async (revision) => {
            abortIfNeeded(input.signal);
            await this.repository.claimPipelineV3SemanticRecovery({
              runId: input.runId,
              queryPlan: input.queryPlan,
              revision,
              fence,
            });
            abortIfNeeded(input.signal);
          },
          signal: input.signal,
        }),
      );
    } catch (error) {
      if (error instanceof PlaylistOptimizationBudgetExceededErrorV1) {
        const optimizerRetrySeed =
          error instanceof RetrievalPlaylistOptimizationBudgetExceededErrorV3
            ? error.retrySeed
            : null;
        const retryable = optimizerBudgetPass < 2 && optimizerRetrySeed !== null;
        abortIfNeeded(input.signal);
        await this.repository.saveResearchCheckpoint(
          input.runId,
          fullCheckpointKey(stageKey),
          {
            schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
            state: "waiting_compute",
            stageKey,
            queryPlanHash,
            code: error.code,
            retryable,
            budgetPass: optimizerBudgetPass,
            maximumBudgetPasses: 2,
            nextBudgetPass: retryable
              ? optimizerBudgetPass + 1
              : null,
            providerCallPermitted: false,
            optimizerRetrySeed,
            failedAt: new Date().toISOString(),
          },
          fence,
        );
        abortIfNeeded(input.signal);
        await this.repository.updateRun(input.runId, {
          status: "recovering",
          phase: error.code,
          error: null,
        }, fence);
        throw new PipelineV3OptimizerComputeBudgetError(
          optimizerBudgetPass,
          retryable,
        );
      }
      if (error instanceof RetrievalDependencyErrorV3) {
        if (!error.retriable) {
          await recordNonRetryableProviderFailure(
            error.failureClass,
            `v3_retrieval_provider_${error.failureClass}`,
          );
        }
        throw new PipelineV3DependencyUnavailableError(
          "v3_retrieval_provider",
          `v3_retrieval_provider_${error.failureClass}`,
          error.retryAfterUntil,
          error.failureClass,
        );
      }
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
      if (code !== "pipeline_v3_semantic_recovery_conflict" && code !== "pipeline_v3_plan_stale") {
        throw error;
      }
      abortIfNeeded(input.signal);
      await this.repository.saveResearchCheckpoint(input.runId, fullCheckpointKey(stageKey), {
        schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
        state: "failed_integrity",
        stageKey,
        queryPlanHash,
        code: "v3_semantic_recovery_claim_conflict",
        claimErrorCode: code,
        failedAt: new Date().toISOString(),
      }, fence);
      abortIfNeeded(input.signal);
      await this.repository.updateRun(input.runId, {
        status: "failed_integrity",
        phase: "v3_semantic_recovery_claim_conflict",
        error: null,
      }, fence);
      return;
    }
    abortIfNeeded(input.signal);
    const governedCorpusActionPending = governedCorpusActionReasonV3(
      input.queryPlan,
      result,
    );
    if (input.queryPlan.schemaVersion === 6
      && result.outcome.status === "no_compatible_tracks"
      && !governedCorpusActionPending) {
      const collapseAudit = auditSemanticCollapseV1({
        queryPlan: input.queryPlan,
        result,
      });
      await this.repository.saveResearchCheckpoint(
        input.runId,
        "v3:semantic-collapse:audit",
        {
          ...collapseAudit,
          queryPlanHash,
          queryPlanRevisionId:
            input.payload?.__queryPlanRevisionId ?? null,
          recordedAt: new Date().toISOString(),
        },
        fence,
      );
      if (collapseAudit.disposition === "technical_quarantine") {
        await this.repository.saveResearchCheckpoint(
          input.runId,
          fullCheckpointKey(stageKey),
          {
            schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
            state: "failed_integrity",
            code: "v3_semantic_collapse_technical_quarantine",
            stageKey,
            queryPlanHash,
            auditHash: collapseAudit.auditHash,
            signalCodes: collapseAudit.signalCodes,
            limitingObligationIds:
              collapseAudit.limitingObligationIds,
            failedAt: new Date().toISOString(),
          },
          fence,
        );
        const quarantined = Boolean(
          this.repository.quarantineCanonicalExecution
          && typeof input.payload?.__jobId === "string"
          && typeof input.payload?.__jobWorkerId === "string"
          && Number.isSafeInteger(input.payload?.__jobLeaseEpoch)
          && await this.repository.quarantineCanonicalExecution({
            runId: input.runId,
            jobId: input.payload.__jobId,
            workerId: input.payload.__jobWorkerId,
            leaseGeneration: Number(input.payload.__jobLeaseEpoch),
            reasonCode:
              "v3_semantic_collapse_technical_quarantine",
          }),
        );
        if (!quarantined) {
          await this.repository.updateRun(input.runId, {
            status: "failed_integrity",
            phase: "v3_semantic_collapse_technical_quarantine",
            error: null,
          }, fence);
        }
        return;
      }
    }
    let runtimeFeasibility: PipelineV3RuntimeFeasibilityAssessment | null = null;
    let runtimeFeasibilityDecisionRequired = false;
    if (requiresSeparatedRecoveryPersistence) {
      const activeComputeAllowanceMs = Number.isFinite(
        input.payload?.__contractActiveComputeAllowanceMs,
      )
        ? Math.max(
            PIPELINE_V3_ACTIVE_COMPUTE_LIMIT_MS,
            Number(input.payload?.__contractActiveComputeAllowanceMs),
          )
        : PIPELINE_V3_ACTIVE_COMPUTE_LIMIT_MS;
      const priorActiveComputeMs = Math.max(
        0,
        Number(input.payload?.__contractActiveComputeConsumedMs ?? 0),
      );
      runtimeFeasibility = assessPipelineV3RuntimeFeasibility({
        queryPlan: input.queryPlan,
        result,
        policy: retrievalPolicy,
        activeComputeConsumedMs: priorActiveComputeMs
          + Math.max(0, Date.now() - Date.parse(startedAt)),
        activeComputeAllowanceMs,
      });
      await this.repository.persistPipelineV3RuntimeFeasibilitySnapshot!({
        runId: input.runId,
        queryPlan: input.queryPlan,
        phase: input.queryPlan.continuation
          || (result.semanticPlanRevisions?.length ?? 0) > 0
          || (result.recoveryAudits?.length ?? 0) > 0
          ? "recovery"
          : "initial",
        report: runtimeFeasibility.report,
        fence,
      });
      if (result.outcome.status === "no_compatible_tracks"
        && !governedCorpusActionPending) {
        if (runtimeFeasibility.noCompatibleDisposition === "dependency_pause") {
          result = {
            ...result,
            outcome: {
              ...result.outcome,
              status: "failed_system",
              stopReason: runtimeFeasibility.report.dependencyHealth === "unavailable"
                ? "provider_circuit_open"
                : "provider_failure",
            },
            publicationBoundary: {
              appleWriteAccess: "forbidden",
              manifestDisposition: "blocked_operational_failure",
            },
          };
        } else if (runtimeFeasibility.noCompatibleDisposition === "actionable_decision") {
          runtimeFeasibilityDecisionRequired = true;
          result = {
            ...result,
            outcome: {
              ...result.outcome,
              status: "needs_decision",
              stopReason: "frontier_exhausted",
              requiresPartialPublicationDecision: false,
            },
            publicationBoundary: {
              appleWriteAccess: "forbidden",
              manifestDisposition: "no_manifest",
            },
          };
        }
      }
    }
    if (result.outcome.status === "failed_system") {
      const retryAfterUntil = retrievalRetryAfterUntil(result);
      const failureClass = retrievalFailureClass(result);
      if (failureClass !== "transient" && failureClass !== "rate_limited") {
        await recordNonRetryableProviderFailure(
          failureClass,
          `v3_retrieval_provider_${failureClass}`,
        );
        throw new PipelineV3DependencyUnavailableError(
          "v3_retrieval_provider",
          `v3_retrieval_provider_${failureClass}`,
          retryAfterUntil,
          failureClass,
        );
      }
      const waitingCheckpoint = {
        schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
        state: "waiting_provider",
        stageKey,
        queryPlanHash,
        queryPlanRevisionId: input.payload?.__queryPlanRevisionId ?? null,
        graphSnapshotId: input.queryPlan.graphSnapshotId,
        executionMode: mode,
        reasonCode: "v3_retrieval_provider_failed",
        leaseEpoch: Number.isSafeInteger(input.payload?.__jobLeaseEpoch)
          ? input.payload?.__jobLeaseEpoch
          : null,
        outcome: result.outcome,
        publicationBoundary: result.publicationBoundary,
        stages: result.stages,
        deficit: result.deficit,
        strategies: result.strategies,
        dependencyOutages: result.dependencyOutages ?? [],
        retryAfterUntil: retryAfterUntil?.toISOString() ?? null,
        failureClass,
        waitingAt: new Date().toISOString(),
      };
      await this.repository.saveResearchCheckpoint(
        input.runId,
        fullCheckpointKey(stageKey),
        waitingCheckpoint,
        fence,
      );
      await this.repository.saveResearchCheckpoint(
        input.runId,
        "v3:retrieval:latest",
        waitingCheckpoint,
        fence,
      );
      await this.repository.updateRun(input.runId, {
        status: "queued",
        phase: "v3_waiting_for_retrieval_provider",
        error: null,
      }, fence);
      throw new PipelineV3DependencyUnavailableError(
        "v3_retrieval_provider",
        "v3_retrieval_provider_failed",
        retryAfterUntil,
        failureClass,
      );
    }
    const postflightCorpusReason = governedCorpusActionPending
      ?? governedCorpusActionReasonV3(input.queryPlan, result);
    if (postflightCorpusReason) {
      let corpusBuild: {
        sourceDocumentCount: number;
        observationCount: number;
        enumerationComplete: boolean;
        unresolvedGapCount: number;
      } | undefined;
      if (this.corpusBuilder) {
        if (!this.repository.ingestPipelineV3ColdCorpus) {
          throw new Error("Pipeline V3 cold-corpus persistence is unavailable");
        }
        const corpus = await this.corpusBuilder.build({
          runId: input.runId,
          plan,
          queryPlan: input.queryPlan,
          modelRoute,
          signal: input.signal,
        });
        abortIfNeeded(input.signal);
        corpusBuild = await this.repository.ingestPipelineV3ColdCorpus({
          runId: input.runId,
          queryPlan: input.queryPlan,
          result: corpus,
          fence,
        });
      }
      await settleGovernedCorpusActionRequired({
        repository: this.repository,
        runId: input.runId,
        queryPlan: input.queryPlan,
        stageKey,
        queryPlanHash,
        queryPlanRevisionId: input.payload?.__queryPlanRevisionId ?? null,
        executionMode: mode,
        fence,
        reasonCode: postflightCorpusReason,
        result,
        corpusBuild,
      });
      return;
    }
    if (mode === "active" && (
      result.outcome.status === "needs_decision"
      || (
        result.outcome.status === "partial_ready"
        && isCanonicalQueryPlanV3SchemaVersion(input.queryPlan.schemaVersion)
      )
    )) {
      await this.repository.saveResearchCheckpoint(
        input.runId,
        fullCheckpointKey(stageKey),
        latestCheckpoint(
          result,
          plan,
          stageKey,
          queryPlanHash,
          input.payload?.__queryPlanRevisionId ?? null,
        ),
        fence,
      );
      const computeLimitReached = result.outcome.stopReason === "deadline_reached";
      const playlistConstraintsMissed =
        result.outcome.stopReason === "playlist_optimization_constraints";
      const activeComputeAllowanceMs = Number.isFinite(
        input.payload?.__contractActiveComputeAllowanceMs,
      )
        ? Math.max(
            PIPELINE_V3_ACTIVE_COMPUTE_LIMIT_MS,
            Number(input.payload?.__contractActiveComputeAllowanceMs),
          )
        : PIPELINE_V3_ACTIVE_COMPUTE_LIMIT_MS;
      const continuationStrategyIds = computeLimitReached && !input.queryPlan.continuation
        ? result.strategies.filter((strategy) => (
            strategy.status === "available" || strategy.status === "running"
          )).map(({ id }) => id)
        : [];
      // A selected subset is evidence for the decision panel, never a
      // publishable manifest under the unchanged exact-count contract.
      // Publication requires an explicit user-authorized successor revision;
      // freezing a partial here would silently weaken count and any
      // count-derived quota/diversity constraints.
      const activeContract = this.repository.getActivePlaylistContractRevision
        ? await this.repository.getActivePlaylistContractRevision({ runId: input.runId })
        : null;
      const canonicalDecision = isCanonicalQueryPlanV3SchemaVersion(
        input.queryPlan.schemaVersion,
      );
      if (canonicalDecision && !activeContract) {
        throw new CanonicalExecutionIntegrityError(
          "decision_active_contract_missing",
        );
      }
      let decisionState: Record<string, unknown> | null = null;
      let rescueGuidanceOffered = false;
      if (activeContract) {
          const contract = activeContract.contract as unknown as PlaylistContractRevisionV1;
          try {
            assertPlaylistContractIntegrityV1(contract);
          } catch (error) {
            throw canonicalExecutionIntegrityError(
              error,
              "decision_contract_integrity_invalid",
            );
          }
          const extensionsUsed = Math.min(
            MAX_ACTIVE_COMPUTE_EXTENSIONS_V1,
            Math.max(0, Math.floor(
              (activeComputeAllowanceMs - PIPELINE_V3_ACTIVE_COMPUTE_LIMIT_MS)
                / PIPELINE_V3_ACTIVE_COMPUTE_LIMIT_MS,
            )),
          );
          const diagnosticLimitingClauseIds = Object.entries(
            result.predicateDiagnostics?.failedMembershipPredicateIds ?? {},
          ).sort(([, left], [, right]) => right - left)
            .map(([clauseId]) => clauseId)
            .slice(0, 5);
          const limitingClauseIds = runtimeFeasibilityDecisionRequired
            ? (runtimeFeasibility?.report.limitingPredicateIds ?? []).slice(0, 5)
            : playlistConstraintsMissed
            ? contract.clauses
              .filter((clause) => (
                clause.kind === "quota_diversity"
                || clause.scope === "playlist"
                || contract.playlistConstraints.some(
                  (constraint) => constraint.clauseId === clause.id,
                )
                || contract.sequencingObjectives.some(
                  (objective) => objective.clauseId === clause.id,
                )
              ))
              .map(({ id }) => id)
              .slice(0, 5)
            : diagnosticLimitingClauseIds;
          decisionState = createAdaptiveRunDecisionV1({
            contract,
            reason: runtimeFeasibilityDecisionRequired
              ? "runtime_feasibility_unknown"
              : computeLimitReached
              ? "active_compute_limit"
              : playlistConstraintsMissed
                ? "playlist_optimization_constraints"
              : "central_quality_floor",
            verifiedTrackCount: result.selected.length,
            remainingStrategyCount: continuationStrategyIds.length,
            consumedActiveComputeMs: runtimeFeasibilityDecisionRequired
              ? runtimeFeasibility?.report.runtimeEvidence?.budgets
                .activeComputeConsumedMs ?? 0
              : Math.max(
                  activeComputeAllowanceMs,
                  Number(input.payload?.__contractActiveComputeConsumedMs ?? 0),
                ),
            activeComputeLimitMs: activeComputeAllowanceMs,
            activeComputeExtensionsUsed: extensionsUsed,
            limitingClauseIds,
          }) as unknown as Record<string, unknown>;
          await this.repository.saveResearchCheckpoint(
            input.runId,
            "run_decision",
            decisionState,
            fence,
          );
          if (computeLimitReached
            && limitingClauseIds.length > 0
            && this.repository.preparePlaylistRunRescueGuidance
            && input.payload?.__contractRevisionDatabaseId === activeContract.id) {
            rescueGuidanceOffered = Boolean(
              await this.repository.preparePlaylistRunRescueGuidance({
                runId: input.runId,
                contractRevisionId: activeContract.id,
                contractSemanticHash: contract.semanticHash,
                limitingClauseIds,
                fence,
              }),
            );
          }
          if (this.repository.openPlaylistRunBlocker
            && !rescueGuidanceOffered
            && input.payload?.__contractRevisionDatabaseId === activeContract.id) {
            await this.repository.openPlaylistRunBlocker({
              runId: input.runId,
              contractRevisionId: activeContract.id,
              blockerKind: "scope_decision",
              dependencyKey: runtimeFeasibilityDecisionRequired
                ? "runtime_feasibility"
                : computeLimitReached
                ? "active_compute"
                : playlistConstraintsMissed
                  ? "playlist_constraints"
                  : "central_quality",
              state: decisionState,
              fence,
            });
          }
      }
      await this.repository.saveResearchCheckpoint(
        input.runId,
        runtimeFeasibilityDecisionRequired
          ? "runtime_feasibility_decision"
          : computeLimitReached
          ? "active_compute_limit"
          : playlistConstraintsMissed
            ? "playlist_constraints_decision"
            : "playlist_quality_decision",
        {
          schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
          state: "needs_decision",
          reasonCode: result.outcome.stopReason,
          ...(runtimeFeasibilityDecisionRequired ? {
            feasibilityState: runtimeFeasibility?.report.state ?? "unknown",
            feasibilityReportHash: runtimeFeasibility?.report.reportHash ?? null,
            limitingPredicateIds:
              runtimeFeasibility?.report.limitingPredicateIds ?? [],
          } : {}),
          ...(computeLimitReached ? {
            activeComputeLimitMs: activeComputeAllowanceMs,
            consumedActiveComputeMs: Math.max(
              activeComputeAllowanceMs,
              Number(input.payload?.__contractActiveComputeConsumedMs ?? 0),
            ),
          } : {
            centralQuality: result.centralQuality ?? null,
            ...(playlistConstraintsMissed ? {
              playlistOptimization: result.playlistOptimization ?? null,
            } : {}),
          }),
          queryPlanHash,
          ...(decisionState ? {
            decisionHash: decisionState.decisionHash,
          } : {}),
          reachedAt: new Date().toISOString(),
        },
        fence,
      );
      await this.repository.updateRun(input.runId, {
        status: "needs_decision",
        phase: rescueGuidanceOffered
          ? "rescue_guidance_required"
          : runtimeFeasibilityDecisionRequired
            ? "runtime_feasibility_unknown"
          : computeLimitReached
          ? "active_compute_limit_reached"
          : playlistConstraintsMissed
            ? "playlist_optimization_constraints_missed"
            : "central_quality_floor_missed",
        error: null,
      }, fence);
      return;
    }
    const persisted = mode === "active"
      ? await this.repository.persistPipelineV3RetrievalResult({
        runId: input.runId,
        queryPlan: input.queryPlan,
        plan,
        result,
        fence,
      })
      : {
        manifestId: null,
        manifestRevisionId: null,
        manifestHash: null,
        publicationState: "not_applicable" as const,
      };
    abortIfNeeded(input.signal);
    await this.repository.saveResearchCheckpoint(
      input.runId,
      fullCheckpointKey(stageKey),
      latestCheckpoint(
        result,
        plan,
        stageKey,
        queryPlanHash,
        input.payload?.__queryPlanRevisionId ?? null,
      ),
      fence,
    );
    abortIfNeeded(input.signal);
    await this.repository.saveResearchCheckpoint(input.runId, "v3:retrieval:latest", {
      schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
      state: result.outcome.status === "failed_integrity"
        ? "failed_integrity"
        : "complete",
      stageKey,
      queryPlanHash,
      graphSnapshotId: input.queryPlan.graphSnapshotId,
      executionMode: mode,
      outcome: result.outcome,
      publicationBoundary: result.publicationBoundary,
      stages: result.stages,
      deficit: result.deficit,
      manifestId: persisted.manifestId,
      manifestRevisionId: persisted.manifestRevisionId,
      manifestHash: persisted.manifestHash,
      publicationState: persisted.publicationState,
      completedAt: new Date().toISOString(),
    }, fence);

    let canonicalIntegrityQuarantined = false;
    if (mode === "active"
      && result.outcome.status === "failed_integrity"
      && isCanonicalQueryPlanV3SchemaVersion(input.queryPlan.schemaVersion)
      && this.repository.quarantineCanonicalExecution
      && typeof input.payload?.__jobId === "string"
      && typeof input.payload?.__jobWorkerId === "string"
      && Number.isSafeInteger(input.payload?.__jobLeaseEpoch)) {
      canonicalIntegrityQuarantined = await this.repository
        .quarantineCanonicalExecution({
          runId: input.runId,
          jobId: input.payload.__jobId,
          workerId: input.payload.__jobWorkerId,
          leaseGeneration: Number(input.payload.__jobLeaseEpoch),
          reasonCode: "v3_retrieval_integrity_failure",
        });
    }

    if (mode === "shadow") {
      abortIfNeeded(input.signal);
      await this.repository.updateRun(input.runId, {
        status: "complete",
        phase: `v3_shadow_${result.outcome.status}`,
        error: null,
      }, fence);
      return;
    }

    if (result.outcome.status === "partial_ready") {
      const priorPartial = await this.repository.getResearchCheckpoint(input.runId, "partial_ready");
      const priorRow = priorPartial && typeof priorPartial === "object" && !Array.isArray(priorPartial)
        ? priorPartial as Record<string, unknown>
        : null;
      const priorVersion = priorRow
        ? Number((priorPartial as Record<string, unknown>).outcomeVersion ?? 0)
        : 0;
      const samePersistedOutcome = priorRow?.queryPlanHash === queryPlanHash
        && priorRow?.manifestHash === persisted.manifestHash;
      const outcomeVersion = samePersistedOutcome && Number.isSafeInteger(priorVersion) && priorVersion >= 1
        ? priorVersion
        : Number.isSafeInteger(priorVersion) && priorVersion >= 0 ? priorVersion + 1 : 1;
      const continuationStrategyIds = input.queryPlan.continuation
        ? []
        : result.strategies.filter((strategy) => (
          strategy.status === "available" || strategy.status === "running"
        )).map(({ id }) => id);
      const remaining = continuationStrategyIds.length;
      await this.repository.saveResearchCheckpoint(input.runId, "partial_ready", {
        outcomeHash: partialOutcomeHash({ runId: input.runId, queryPlanHash, outcomeVersion, result }),
        outcomeVersion,
        targetTrackCount: result.outcome.requestedTrackCount,
        verifiedTrackCount: result.outcome.selectedTrackCount,
        shortfall: result.outcome.shortfall,
        remainingStrategyCount: remaining,
        continueAvailable: remaining > 0,
        continuationStrategyIds,
        preparedAt: new Date().toISOString(),
        pipelineVersion: PIPELINE_V3_VERSION,
        stageKey,
        queryPlanHash,
        queryPlanRevisionId: input.payload?.__queryPlanRevisionId ?? null,
        manifestId: persisted.manifestId,
        manifestRevisionId: persisted.manifestRevisionId,
        manifestHash: persisted.manifestHash,
      }, fence);
    }

    const state = result.outcome.status;
    abortIfNeeded(input.signal);
    if (state === "exact_ready") {
      await this.repository.updateRun(input.runId, {
        status: persisted.publicationState === "waiting_for_apple_authorization"
          ? "waiting_for_apple_authorization"
          : "publishing",
        phase: persisted.publicationState === "waiting_for_apple_authorization"
          ? "apple_authorization"
          : "publication_queued",
        error: null,
      }, fence);
    } else if (state === "partial_ready") {
      await this.repository.updateRun(input.runId, {
        status: "partial_ready",
        phase: "partial_confirmation_required",
        error: null,
      }, fence);
    } else if (state === "no_compatible_tracks") {
      await this.repository.updateRun(input.runId, {
        status: "no_compatible_tracks",
        phase: "v3_no_compatible_tracks",
        error: null,
      }, fence);
    } else if (state === "awaiting_guidance") {
      await this.repository.updateRun(input.runId, {
        status: "awaiting_guidance",
        phase: "v3_awaiting_guidance",
        error: null,
      }, fence);
    } else if (state === "failed_integrity") {
      if (!canonicalIntegrityQuarantined) {
        await this.repository.updateRun(input.runId, {
          status: "failed_integrity",
          phase: "v3_retrieval_integrity_failure",
          error: null,
        }, fence);
      }
    } else {
      await this.repository.updateRun(input.runId, {
        status: "failed_system",
        phase: "v3_retrieval_system_failure",
        error: null,
      }, fence);
    }
  }
}
