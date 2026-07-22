import { createHash } from "node:crypto";
import type { QueryPlanV3 } from "../shared/types.ts";
import type { PipelinePolicySnapshot } from "../shared/types.ts";
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
  executeRetrievalV3,
  type RetrievalAdaptersV3,
  type RetrievalExecutionModeV3,
  type RetrievalContinuationSeedV3,
  type RetrievalPolicyV3,
  type RetrievalResultV3,
  type RetrievalRoutingHintsV3,
} from "./pipeline-v3-retrieval.ts";
import { queryPlanV3Hash } from "./query-plan-v3.ts";
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
import type {
  ColdCorpusBuilderPortV3,
  ColdCorpusBuildResultV3,
} from "./pipeline-v3-corpus-builder.ts";
import type { SemanticPlanRevisionArtifactV3 } from "./pipeline-v3-semantic-recovery.ts";

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
  };
}

function safePrompt(run: { prompt?: string; brief?: { title?: string; description?: string } }): string {
  const raw = run.prompt?.trim()
    || run.brief?.title?.trim()
    || run.brief?.description?.trim()
    || "Confirmed playlist request";
  return raw.slice(0, 4_000);
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
  if (queryPlan.schemaVersion === 2
    && (queryPlan.musicConceptPolicyVersion !== MUSIC_CONCEPT_POLICY_VERSION
      || queryPlan.semanticAuditMetadata?.musicConceptPolicyVersion !== MUSIC_CONCEPT_POLICY_VERSION)) {
    throw new Error("Pipeline V3 schema-2 query plan uses an unsupported music-concept policy");
  }
  const target = Number(queryPlan.targetTrackCount);
  if (!Number.isSafeInteger(target) || target < 1 || target > 300) {
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
  const semanticClauses: SemanticPlanClauseV32[] = queryPlan.schemaVersion === 2
    ? queryPlan.semanticClauses!.map((clause) => ({
        ...clause,
        axis: clause.axis as SemanticPlanClauseV32["axis"],
        operator: clause.operator as SemanticPlanClauseV32["operator"],
        values: [...clause.values],
      }))
    : legacySemanticClauses;
  const membershipPredicates = queryPlan.schemaVersion === 2
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
  const semanticHardConstraintHash = queryPlan.schemaVersion === 2
    ? queryPlan.hardConstraintHash!
    : createHash("sha256").update(stableStringify(membershipPredicates.map(({ axis, operator, values }) => ({
        axis,
        operator,
        values: values.map((value) => value.normalize("NFKC").trim().toLowerCase()).sort(),
      })))).digest("hex");
  const explicitUserConstraintHash = queryPlan.schemaVersion === 2
    ? queryPlan.explicitUserConstraintHash!
    : createHash("sha256").update(stableStringify({
        schemaVersion: 1,
        selectionPlanHash: queryPlan.selectionPlanHash,
      })).digest("hex");
  const contextSignals = queryPlan.schemaVersion === 2
    ? queryPlan.contextSignals!.map((clause) => ({
        ...clause,
        axis: clause.axis as SemanticPlanClauseV32["axis"],
        operator: clause.operator as SemanticPlanClauseV32["operator"],
        values: [...clause.values],
      }))
    : [];
  const catalogPolicies = queryPlan.schemaVersion === 2
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
    prompt: safePrompt(run),
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
    diversityGoals,
    orderingPolicy,
    softGoalRelaxationOrder: queryPlan.softGoalRelaxationOrder
      ? [...queryPlan.softGoalRelaxationOrder]
      : [
          "sequencing_preferences",
          "album_concentration",
          "artist_concentration",
          "era_balance",
          "subgenre_regional_representation",
        ],
    criticalAmbiguities: [],
    recordingPolicy: queryPlan.schemaVersion === 2
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
      aliasCollapses: queryPlan.schemaVersion === 2
        ? [...queryPlan.semanticAuditMetadata!.aliasCollapses]
        : [],
      contradictions: [],
    },
    confirmed: true,
    resolvedAmbiguityKeys: [],
  };
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
      const adapters: RetrievalAdaptersV3 = {
        discover: async (discoveryRequest) => {
          abortIfNeeded(request.signal);
          const batch = await input.adapters.discover(discoveryRequest);
          abortIfNeeded(request.signal);
          return batch;
        },
        qualify: async (qualificationRequest) => {
          abortIfNeeded(request.signal);
          const qualifications = await input.adapters.qualify(qualificationRequest);
          abortIfNeeded(request.signal);
          return qualifications;
        },
      };
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
      });
      abortIfNeeded(request.signal);
      return result;
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
  return Object.freeze({
    maximumGlobalRounds,
    maximumRawCandidates,
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
  stageKey: string,
  queryPlanHash: string,
  queryPlanRevisionId: string | null,
): Record<string, unknown> {
  return {
    schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
    state: "complete",
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
    return {
      approvedStrategyIds: [...continuation.strategyIds],
      qualifiedTracks: [...source.selected, ...source.reserve] as RetrievalContinuationSeedV3["qualifiedTracks"],
      compatibleAlternatesByRecordingFamily: source.compatibleAlternatesByRecordingFamily as RetrievalContinuationSeedV3["compatibleAlternatesByRecordingFamily"],
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

    const prior = await this.repository.getResearchCheckpoint(input.runId, fullCheckpointKey(stageKey));
    if (prior && typeof prior === "object" && !Array.isArray(prior)) {
      const priorRecord = prior as Record<string, unknown>;
      const priorState = priorRecord.state;
      if (priorState === "complete"
        || priorState === "owner_action_required" || priorState === "failed_integrity") {
        return;
      }
      if (priorState === "waiting_provider") {
        const priorLeaseEpoch = Number(priorRecord.leaseEpoch);
        const currentLeaseEpoch = Number(input.payload?.__jobLeaseEpoch);
        // Re-delivery of the same leased attempt is idempotent. A reclaimed
        // successor lease may resume once a provider becomes available; the
        // repository fence still prevents the old worker from committing.
        if (!this.retrieval || (Number.isSafeInteger(priorLeaseEpoch)
          && currentLeaseEpoch <= priorLeaseEpoch)) return;
      }
    }

    const queryPlanHash = queryPlanV3Hash(input.queryPlan);
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
      return;
    }

    let continuation: RetrievalContinuationSeedV3 | undefined;
    try {
      continuation = await this.continuationSeed(input.runId, input.queryPlan);
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
    let result: RetrievalResultV3;
    try {
      result = await this.retrieval.execute({
        runId: input.runId,
        plan,
        executionMode: mode,
        routingHints: { fixedContainer: input.queryPlan.engines.includes("fixed_container") },
        modelRoute,
        semanticRecoveryEnabled: input.queryPlan.schemaVersion === 2,
        policy: retrievalPolicy,
        continuation,
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
      });
    } catch (error) {
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
    const postflightCorpusReason = governedCorpusActionReasonV3(input.queryPlan, result);
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
        stageKey,
        queryPlanHash,
        input.payload?.__queryPlanRevisionId ?? null,
      ),
      fence,
    );
    abortIfNeeded(input.signal);
    await this.repository.saveResearchCheckpoint(input.runId, "v3:retrieval:latest", {
      schemaVersion: PIPELINE_V3_WORKER_CHECKPOINT_SCHEMA,
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
      await this.repository.updateRun(input.runId, {
        status: "failed_integrity",
        phase: "v3_retrieval_integrity_failure",
        error: null,
      }, fence);
    } else {
      await this.repository.updateRun(input.runId, {
        status: "failed_system",
        phase: "v3_retrieval_system_failure",
        error: null,
      }, fence);
    }
  }
}
