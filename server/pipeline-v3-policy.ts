import type {
  CriticalAmbiguityV3,
  MembershipPredicateV3,
  RankingObjectiveV3,
  RunSpecV3,
} from "./selection-plan-v3.ts";
import type { SelectionPlanV3 } from "./selection-plan-v3.ts";
import type {
  PipelinePolicySnapshot,
  PlaylistGuidanceEffect,
  PlaylistGuidanceQuestion,
  PlaylistGuidanceSourceHint,
  PlaylistGuidanceTelemetry,
} from "../shared/types.ts";

export const GUIDED_SCOUT_V3_LIMITS = Object.freeze({
  maximumQuestions: 3,
  maximumSearches: 2,
  maximumDurationMs: 10_000,
  maximumCostUsd: 0.03,
});

/**
 * The production project's /v1/models catalog currently exposes these
 * provider-managed aliases and does not expose dated GPT-5.6 snapshot IDs.
 * Keep this allowlist deliberately narrow: a model catalog change must be
 * validated and released instead of silently changing the V3 router.
 */
export const PIPELINE_V3_DEFAULT_BASELINE_MODEL_ID = "gpt-5.6-luna";
export const PIPELINE_V3_DEFAULT_ESCALATION_MODEL_ID = "gpt-5.6-terra";
export const PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT = "2026-07-20T00:00:00.000Z";
export const PIPELINE_V3_MODEL_RESOLUTION_MODE = "provider_managed_alias" as const;
export const PIPELINE_V3_ALLOWED_PROVIDER_MODEL_IDS = Object.freeze([
  PIPELINE_V3_DEFAULT_BASELINE_MODEL_ID,
  PIPELINE_V3_DEFAULT_ESCALATION_MODEL_ID,
] as const);
export const PIPELINE_V3_PROMPT_VERSION = "grounded_recovery_v3_1_prompt_v1" as const;

export type PipelineV3InterpretationConfidence = "high" | "medium" | "low";

export interface PipelineV3ModelRoutingSignals {
  /** Numeric confidence uses the same frozen thresholds as the V2 bridge. */
  readonly interpretationConfidence?: PipelineV3InterpretationConfidence | number;
  /** A failed local structured repair, not a provider outage. */
  readonly structuredRepairFailures?: number;
}

export interface PipelineV3ModelRoute {
  readonly version: "pipeline_v3_model_route_v2";
  readonly tier: "baseline" | "escalation";
  /** Exact model IDs accepted by the provider when the run was created. */
  readonly providerModelId: string;
  readonly baselineProviderModelId: string;
  readonly escalationProviderModelId: string;
  /** Aliases are provider-managed; this is not a claim of dated model pinning. */
  readonly resolutionMode: typeof PIPELINE_V3_MODEL_RESOLUTION_MODE;
  /** Time the configured IDs were last verified against the provider catalog. */
  readonly modelCatalogValidatedAt: string;
  readonly reason: "baseline" | "interpretation_low_confidence" | "structured_repair_failed";
  readonly interpretationConfidence: PipelineV3InterpretationConfidence;
  readonly structuredRepairFailures: number;
  readonly escalationCount: 0 | 1;
}

type PipelineV3ScoutTelemetry = Pick<PlaylistGuidanceTelemetry,
  "generationMode" | "acceptedQuestionCount" | "validationIssues">;

/**
 * Translate durable scout diagnostics into provider-independent V3 routing
 * signals. Provider outages, timeouts, and budget failures stay on the
 * baseline route: a larger model cannot repair unavailable infrastructure.
 * Only a local structured-contract failure or explicit low confidence earns
 * the single escalation.
 */
export function pipelineV3ModelRoutingSignalsFromScoutTelemetry(
  telemetry: PipelineV3ScoutTelemetry | null | undefined,
): PipelineV3ModelRoutingSignals {
  if (!telemetry) return {};
  const localStructuredFailures = telemetry.validationIssues.filter((issue) => (
    issue === "interpretation:invalid_structured_output"
    || /^response:(?:primary_)?(?:invalid_json|invalid_object|missing_output|incomplete_)/u.test(issue)
    || /^(?:schema|structured_output):(?:repair_)?(?:failed|invalid|missing|incomplete)/u.test(issue)
  )).length;
  const explicitlyLowConfidence = telemetry.validationIssues.includes("scout:low_confidence");
  const cleanGroundedResult = telemetry.generationMode === "grounded_scout"
    && telemetry.acceptedQuestionCount > 0;
  const cleanNoQuestionResult = telemetry.generationMode === "no_material_questions"
    && telemetry.validationIssues.length === 0;
  return {
    interpretationConfidence: explicitlyLowConfidence || localStructuredFailures > 0
      ? "low"
      : cleanGroundedResult || cleanNoQuestionResult
        ? "high"
        : "medium",
    structuredRepairFailures: localStructuredFailures,
  };
}

const ALLOWED_PROVIDER_MODEL_IDS = new Set<string>(PIPELINE_V3_ALLOWED_PROVIDER_MODEL_IDS);

function allowlistedProviderModelId(raw: string | undefined, fallback: string, variableName: string): string {
  const value = raw?.trim() || fallback;
  if (!ALLOWED_PROVIDER_MODEL_IDS.has(value)) {
    throw new Error(`${variableName} must be an exact Pipeline V3 provider model ID from the validated allowlist`);
  }
  return value;
}

function modelCatalogValidatedAt(raw: string | undefined): string {
  const value = raw?.trim() || PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT must be an ISO-8601 UTC timestamp");
  }
  return value;
}

function interpretationConfidence(
  value: PipelineV3ModelRoutingSignals["interpretationConfidence"],
): PipelineV3InterpretationConfidence {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "medium";
    if (value < 0.6) return "low";
    if (value >= 0.8) return "high";
    return "medium";
  }
  return value === "high" || value === "low" || value === "medium" ? value : "medium";
}

/**
 * Resolve the complete V3 route once and freeze it in the run policy. The
 * higher-capability provider model is a one-step local repair route only: repeated
 * repair failures never trigger an unbounded model cascade.
 */
export function pipelineV3ModelRoute(
  signals: PipelineV3ModelRoutingSignals = {},
  environment: NodeJS.ProcessEnv = process.env,
): PipelineV3ModelRoute {
  const baselineProviderModelId = allowlistedProviderModelId(
    environment.PIPELINE_V3_BASELINE_MODEL_ID,
    PIPELINE_V3_DEFAULT_BASELINE_MODEL_ID,
    "PIPELINE_V3_BASELINE_MODEL_ID",
  );
  const escalationProviderModelId = allowlistedProviderModelId(
    environment.PIPELINE_V3_ESCALATION_MODEL_ID,
    PIPELINE_V3_DEFAULT_ESCALATION_MODEL_ID,
    "PIPELINE_V3_ESCALATION_MODEL_ID",
  );
  if (baselineProviderModelId === escalationProviderModelId) {
    throw new Error("Pipeline V3 baseline and escalation provider model IDs must be distinct");
  }
  const catalogValidatedAt = modelCatalogValidatedAt(environment.PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT);
  const confidence = interpretationConfidence(signals.interpretationConfidence);
  const structuredRepairFailures = Number.isFinite(signals.structuredRepairFailures)
    ? Math.max(0, Math.floor(signals.structuredRepairFailures ?? 0))
    : 0;
  const reason: PipelineV3ModelRoute["reason"] = structuredRepairFailures > 0
    ? "structured_repair_failed"
    : confidence === "low"
      ? "interpretation_low_confidence"
      : "baseline";
  const escalated = reason !== "baseline";
  return Object.freeze({
    version: "pipeline_v3_model_route_v2",
    tier: escalated ? "escalation" : "baseline",
    providerModelId: escalated ? escalationProviderModelId : baselineProviderModelId,
    baselineProviderModelId,
    escalationProviderModelId,
    resolutionMode: PIPELINE_V3_MODEL_RESOLUTION_MODE,
    modelCatalogValidatedAt: catalogValidatedAt,
    reason,
    interpretationConfidence: confidence,
    structuredRepairFailures,
    escalationCount: escalated ? 1 : 0,
  });
}

/**
 * Rehydrate the provider route from the immutable run policy. Workers must
 * never consult their current environment for an already-created V3 run:
 * doing so would make retries and resumptions non-reproducible.
 */
export function pipelineV3ModelRouteFromPolicySnapshot(
  snapshot: PipelinePolicySnapshot | null | undefined,
): PipelineV3ModelRoute {
  if (!snapshot
    || snapshot.pipelineVersion !== "corpus_first_v3"
    || snapshot.executionPolicy.kind !== "corpus_first_v3") {
    throw new Error("Pipeline V3 run is missing its immutable model route");
  }
  const route = snapshot.executionPolicy.modelRoute;
  if (route.version !== "pipeline_v3_model_route_v2"
    || snapshot.executionPolicy.model !== route.providerModelId
    || !ALLOWED_PROVIDER_MODEL_IDS.has(route.providerModelId)
    || !ALLOWED_PROVIDER_MODEL_IDS.has(route.baselineProviderModelId)
    || !ALLOWED_PROVIDER_MODEL_IDS.has(route.escalationProviderModelId)
    || route.baselineProviderModelId === route.escalationProviderModelId
    || route.resolutionMode !== PIPELINE_V3_MODEL_RESOLUTION_MODE
    || !Number.isFinite(Date.parse(route.modelCatalogValidatedAt))
    || new Date(Date.parse(route.modelCatalogValidatedAt)).toISOString() !== route.modelCatalogValidatedAt
    || !["baseline", "escalation"].includes(route.tier)
    || !["baseline", "interpretation_low_confidence", "structured_repair_failed"].includes(route.reason)
    || !["high", "medium", "low"].includes(route.interpretationConfidence)
    || !Number.isSafeInteger(route.structuredRepairFailures)
    || route.structuredRepairFailures < 0
    || (route.escalationCount !== 0 && route.escalationCount !== 1)) {
    throw new Error("Pipeline V3 immutable model route failed validation");
  }
  return Object.freeze({ ...route });
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, Math.floor(parsed)))
    : fallback;
}

function curatedCostCeiling(target: number): number {
  if (target <= 50) return 0.75;
  if (target <= 100) return 1.5;
  return 3;
}

/** Freeze every mutable V3 execution input at run creation. */
export function createPipelinePolicySnapshotV3(input: {
  plan: SelectionPlanV3;
  environment?: NodeJS.ProcessEnv;
  modelRoutingSignals?: PipelineV3ModelRoutingSignals;
  capturedAt?: string;
}): PipelinePolicySnapshot {
  const environment = input.environment ?? process.env;
  const modelRoute = pipelineV3ModelRoute(input.modelRoutingSignals, environment);
  const target = input.plan.requestedTrackCount;
  const maximumRawCandidates = boundedInteger(
    environment.PIPELINE_V3_MAX_RAW_CANDIDATES,
    Math.min(100_000, Math.max(500, target * 20)),
    target,
    100_000,
  );
  const factual = input.plan.intents.includes("factual_relationship")
    || input.plan.intents.includes("exhaustive");
  return {
    schemaVersion: 1,
    pipelineVersion: "corpus_first_v3",
    policyVersion: "corpus_first_v3_policy_v1",
    selectionPlanVersion: input.plan.selectionPlanVersion,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    storefront: input.plan.storefront,
    executionPolicy: {
      kind: "corpus_first_v3",
      version: "corpus_first_v3_policy_v1",
      model: modelRoute.providerModelId,
      modelRoute,
      maximumGlobalRounds: boundedInteger(environment.PIPELINE_V3_MAX_ROUNDS, 48, 1, 1_000),
      maximumRawCandidates,
      reservePercent: 20,
      maximumCostUsd: factual ? 5 : curatedCostCeiling(target),
    },
    requestLimits: {
      maxToolCalls: boundedInteger(environment.PIPELINE_V3_MAX_TOOL_CALLS, 48, 1, 200),
      maxHostedSearchCalls: boundedInteger(environment.PIPELINE_V3_MAX_SEARCH_CALLS, 16, 1, 100),
      maxSynthesisTokens: boundedInteger(environment.PIPELINE_V3_MAX_SYNTHESIS_TOKENS, 8_000, 1_000, 32_000),
      maxExtractionTokens: boundedInteger(environment.PIPELINE_V3_MAX_EXTRACTION_TOKENS, 12_000, 1_000, 64_000),
    },
    costLimits: {
      scoutUsd: GUIDED_SCOUT_V3_LIMITS.maximumCostUsd,
      curatedRunUsd: factual ? null : curatedCostCeiling(target),
      factualApprovalGateUsd: 5,
      postMatchRefillUsd: 0,
    },
    catalogLimits: {
      appleConcurrencyInitial: boundedInteger(environment.APPLE_MATCHING_CONCURRENCY, 6, 2, 8),
      appleConcurrencyMinimum: 2,
      appleConcurrencyMaximum: 8,
      catalogRecoveryDeadlineMs: boundedInteger(environment.APPLE_CATALOG_RECOVERY_TIMEOUT_MS, 90_000, 30_000, 180_000),
      catalogLookupTimeoutMs: boundedInteger(environment.FAST_MATCH_LOOKUP_TIMEOUT_MS, 7_000, 3_000, 12_000),
      musicBrainzMaxUncachedRequests: 5,
      maximumRawDiscoveryGoal: maximumRawCandidates,
      catalogResourceCacheTtlSeconds: 7 * 24 * 60 * 60,
      catalogSearchCacheTtlSeconds: 24 * 60 * 60,
      playlistMembershipCacheTtlSeconds: 6 * 60 * 60,
    },
    durableResearchLimits: {
      gapPasses: input.plan.intents.includes("exhaustive") ? 2 : 0,
      turnsPerSegment: 1,
      segmentsPerPass: 1,
    },
    evidencePolicy: "Pipeline V3 governed track-scope evidence floors; count and budget never relax eligibility.",
  };
}

export interface GuidedScoutUsageV3 {
  readonly searchCount: number;
  readonly durationMs: number;
  readonly costUsd: number;
}

export interface GuidedScoutSourceV3 {
  readonly url: string;
  readonly title: string;
}

export type GuidedEffectV3 =
  | { readonly kind: "membership"; readonly predicate: MembershipPredicateV3 }
  | { readonly kind: "ranking"; readonly objective: RankingObjectiveV3 };

export interface GuidedOptionV3 {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly recommended: boolean;
  readonly effects: readonly GuidedEffectV3[];
}

export interface GuidedQuestionV3 {
  readonly id: string;
  readonly decisionKey: string;
  readonly header: string;
  readonly question: string;
  readonly whyMaterial: string;
  readonly groundingSourceUrls: readonly string[];
  /** The interface supplies custom input separately from these three options. */
  readonly options: readonly GuidedOptionV3[];
}

export interface GuidedQuestionValidationV3 {
  readonly questionId: string;
  readonly accepted: boolean;
  readonly issues: readonly string[];
}

export interface GuidedScoutValidationV3 {
  readonly acceptedQuestions: readonly GuidedQuestionV3[];
  readonly questionResults: readonly GuidedQuestionValidationV3[];
  readonly blockingAmbiguityKeys: readonly CriticalAmbiguityV3["key"][];
  readonly usageIssues: readonly string[];
  readonly canStartResearch: boolean;
}

export interface ProductionGuidedScoutValidationV3 {
  /** Original public API questions that passed the V3 contract. */
  readonly acceptedQuestions: readonly PlaylistGuidanceQuestion[];
  readonly questionResults: readonly GuidedQuestionValidationV3[];
  readonly blockingAmbiguityKeys: readonly CriticalAmbiguityV3["key"][];
  readonly usageIssues: readonly string[];
  readonly canStartResearch: boolean;
}

function normalized(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function validPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && ![
      "localhost", "127.0.0.1", "0.0.0.0", "::1",
    ].includes(url.hostname.toLocaleLowerCase());
  } catch {
    return false;
  }
}

export function validateGuidedScoutUsageV3(usage: GuidedScoutUsageV3): string[] {
  const issues: string[] = [];
  if (!Number.isSafeInteger(usage.searchCount) || usage.searchCount < 0
    || usage.searchCount > GUIDED_SCOUT_V3_LIMITS.maximumSearches) issues.push("search_limit_exceeded");
  if (!Number.isFinite(usage.durationMs) || usage.durationMs < 0
    || usage.durationMs > GUIDED_SCOUT_V3_LIMITS.maximumDurationMs) issues.push("duration_limit_exceeded");
  if (!Number.isFinite(usage.costUsd) || usage.costUsd < 0
    || usage.costUsd > GUIDED_SCOUT_V3_LIMITS.maximumCostUsd + Number.EPSILON) issues.push("cost_limit_exceeded");
  return issues;
}

function effectSignature(effect: GuidedEffectV3): string {
  if (effect.kind === "membership") {
    const predicate = effect.predicate;
    return [effect.kind, predicate.axis, predicate.operator, ...predicate.values.map(normalized).sort()].join(":");
  }
  const objective = effect.objective;
  return [effect.kind, objective.dimension, objective.direction, ...objective.values.map(normalized).sort()].join(":");
}

function questionValidationIssues(
  question: GuidedQuestionV3,
  knownSourceUrls: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  if (!/^[a-z0-9][a-z0-9:_-]{1,119}$/u.test(question.id)) issues.push("invalid_question_id");
  if (!/^[a-z0-9][a-z0-9:_-]{1,119}$/u.test(question.decisionKey)) issues.push("invalid_decision_key");
  if (question.header.trim().length < 2 || question.header.length > 60) issues.push("invalid_header");
  if (question.question.trim().length < 8 || question.question.length > 240) issues.push("invalid_question_text");
  if (question.whyMaterial.trim().length < 12 || question.whyMaterial.length > 360) issues.push("missing_material_explanation");
  if (question.groundingSourceUrls.length < 1 || question.groundingSourceUrls.length > 2
    || question.groundingSourceUrls.some((url) => !validPublicHttpsUrl(url) || !knownSourceUrls.has(url))) {
    issues.push("invalid_source_grounding");
  }
  if (question.options.length !== 3) issues.push("option_count_must_be_three");
  if (new Set(question.options.map(({ id }) => id)).size !== question.options.length) issues.push("duplicate_option_id");
  if (question.options.filter(({ recommended }) => recommended).length !== 1) issues.push("exactly_one_recommended_option_required");
  const signatures = new Set<string>();
  for (const option of question.options) {
    if (!/^[a-z0-9][a-z0-9:_-]{1,119}$/u.test(option.id)
      || option.label.trim().length < 1 || option.label.length > 80
      || option.description.trim().length < 4 || option.description.length > 180) {
      issues.push("invalid_option_shape");
    }
    if (option.effects.length < 1 || option.effects.length > 4) issues.push("option_must_change_candidate_pool_or_rank");
    const signature = option.effects.map(effectSignature).sort().join("|");
    if (signature && signatures.has(signature)) issues.push("options_have_identical_effects");
    signatures.add(signature);
  }
  return [...new Set(issues)];
}

/**
 * Validate questions independently. One malformed question never discards a
 * valid sibling. Unanswered critical ambiguities remain blocking.
 */
export function validateGuidedScoutV3(input: {
  spec: RunSpecV3;
  questions: readonly GuidedQuestionV3[];
  sources: readonly GuidedScoutSourceV3[];
  usage: GuidedScoutUsageV3;
}): GuidedScoutValidationV3 {
  const usageIssues = validateGuidedScoutUsageV3(input.usage);
  const sourceUrls = new Set(input.sources
    .map(({ url }) => url)
    .filter(validPublicHttpsUrl));
  const proposed = input.questions.slice(0, GUIDED_SCOUT_V3_LIMITS.maximumQuestions);
  const duplicateDecisionKeys = new Set<string>();
  const seenDecisionKeys = new Set<string>();
  for (const question of proposed) {
    if (seenDecisionKeys.has(question.decisionKey)) duplicateDecisionKeys.add(question.decisionKey);
    seenDecisionKeys.add(question.decisionKey);
  }
  const questionResults = proposed.map((question) => {
    const issues = questionValidationIssues(question, sourceUrls);
    if (duplicateDecisionKeys.has(question.decisionKey)) issues.push("duplicate_decision_key");
    return { questionId: question.id, accepted: issues.length === 0, issues } satisfies GuidedQuestionValidationV3;
  });
  if (input.questions.length > GUIDED_SCOUT_V3_LIMITS.maximumQuestions) {
    questionResults.push({
      questionId: "scout:overflow",
      accepted: false,
      issues: ["question_limit_exceeded"],
    });
  }
  const acceptedQuestions = proposed.filter((_, index) => questionResults[index]?.accepted === true);
  const acceptedKeys = new Set(acceptedQuestions.map(({ decisionKey }) => decisionKey));
  const blockingAmbiguityKeys = input.spec.criticalAmbiguities
    .filter(({ key }) => !acceptedKeys.has(key))
    .map(({ key }) => key);
  return {
    acceptedQuestions,
    questionResults,
    blockingAmbiguityKeys,
    usageIssues,
    canStartResearch: usageIssues.length === 0 && blockingAmbiguityKeys.length === 0,
  };
}

function productionGuidanceEffectV3(
  question: PlaylistGuidanceQuestion,
  optionId: string,
  effect: PlaylistGuidanceEffect | undefined,
): readonly GuidedEffectV3[] {
  if (!effect) return [];
  const decisionKey = question.decisionKey?.trim() || question.id;
  const objectiveDimension: RankingObjectiveV3["dimension"] = effect.kind === "ordering_behavior"
    ? "sequencing"
    : effect.kind === "familiarity_bias"
      ? "source_rank"
      : effect.kind === "subscene_focus"
        ? "scene_balance"
        : "relevance";
  const values = [
    effect.value,
    effect.orderingBehavior ?? "",
    effect.geographyConstraint
      ? `${effect.geographyConstraint.relationship}:${effect.geographyConstraint.value}`
      : "",
  ].map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) return [];
  return [{
    kind: "ranking",
    objective: {
      id: `guided:${decisionKey}:${optionId}`.replace(/[^a-z0-9:_-]+/giu, "-").slice(0, 120),
      dimension: objectiveDimension,
      direction: "maximize",
      weight: 1,
      relaxationRank: 1,
      values,
      reason: "The typed guided answer changes downstream discovery, selection, or sequencing.",
    },
  }];
}

function productionGuidanceQuestionV3(question: PlaylistGuidanceQuestion): GuidedQuestionV3 {
  const decisionKey = question.decisionKey?.trim() || question.id;
  return {
    id: question.id,
    decisionKey,
    header: question.header,
    question: question.question,
    whyMaterial: question.whyMaterial ?? "The answer materially changes the recordings selected for this playlist.",
    groundingSourceUrls: question.grounding?.sourceUrls ?? [],
    options: question.options.map((option) => ({
      id: option.id,
      label: option.label,
      description: option.description,
      recommended: option.recommended,
      effects: productionGuidanceEffectV3(question, option.id, option.effect),
    })),
  };
}

/**
 * Apply the V3 contract to the legacy/public guidance shape returned by the
 * real Responses API scout. Validation remains per-question: one malformed
 * sibling never erases a valid, grounded, typed question.
 */
export function validateProductionGuidedScoutV3(input: {
  spec: RunSpecV3;
  questions: readonly PlaylistGuidanceQuestion[];
  sourceHints: readonly PlaylistGuidanceSourceHint[];
  usage: GuidedScoutUsageV3;
}): ProductionGuidedScoutValidationV3 {
  const validation = validateGuidedScoutV3({
    spec: input.spec,
    questions: input.questions.map(productionGuidanceQuestionV3),
    sources: input.sourceHints.map(({ url, title }) => ({ url, title })),
    usage: input.usage,
  });
  const withinUsageContract = validation.usageIssues.length === 0;
  const acceptedQuestions = withinUsageContract
    ? input.questions
      .slice(0, GUIDED_SCOUT_V3_LIMITS.maximumQuestions)
      .filter((_, index) => validation.questionResults[index]?.accepted === true)
    : [];
  return {
    acceptedQuestions,
    questionResults: validation.questionResults,
    blockingAmbiguityKeys: validation.blockingAmbiguityKeys,
    usageIssues: validation.usageIssues,
    canStartResearch: withinUsageContract
      && validation.blockingAmbiguityKeys.length === 0,
  };
}

export interface SelectionCandidateV3<T = unknown> {
  readonly id: string;
  readonly value: T;
  readonly artist: string;
  readonly album: string | null;
  readonly year: number | null;
  readonly scene: string | null;
  /** Candidate values that have already been proven by eligible evidence. */
  readonly memberships: Readonly<Partial<Record<MembershipPredicateV3["axis"], readonly string[]>>>;
  /** Scores are meaningful only after every membership predicate passes. */
  readonly objectiveScores: Readonly<Partial<Record<RankingObjectiveV3["dimension"], number>>>;
  readonly sourceRank: number;
}

export interface CandidateMembershipDecisionV3 {
  readonly eligible: boolean;
  readonly failedPredicateIds: readonly string[];
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  const normalizedRight = new Set(right.map(normalized));
  return left.some((value) => normalizedRight.has(normalized(value)));
}

export function evaluateCandidateMembershipV3<T>(
  candidate: SelectionCandidateV3<T>,
  predicates: readonly MembershipPredicateV3[],
): CandidateMembershipDecisionV3 {
  const failedPredicateIds: string[] = [];
  for (const predicate of predicates) {
    const proven = candidate.memberships[predicate.axis] ?? [];
    const hasMatch = intersects(proven, predicate.values);
    if ((predicate.operator === "include" || predicate.operator === "require") && !hasMatch) {
      failedPredicateIds.push(predicate.id);
    }
    if (predicate.operator === "exclude" && hasMatch) failedPredicateIds.push(predicate.id);
  }
  return { eligible: failedPredicateIds.length === 0, failedPredicateIds };
}

function finiteUnit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function rankingScore<T>(candidate: SelectionCandidateV3<T>, objectives: readonly RankingObjectiveV3[]): number {
  return objectives.reduce((total, objective) => {
    const raw = finiteUnit(candidate.objectiveScores[objective.dimension]);
    const contribution = objective.direction === "minimize" ? 1 - raw : raw;
    return total + contribution * Math.max(0, objective.weight);
  }, 0);
}

export interface SelectionResultV3<T = unknown> {
  readonly selected: readonly SelectionCandidateV3<T>[];
  readonly rejected: readonly { candidate: SelectionCandidateV3<T>; failedPredicateIds: readonly string[] }[];
  readonly shortfall: number;
}

/** Eligibility is complete before ranking begins; no objective is a gate. */
export function selectCandidatesV3<T>(input: {
  candidates: readonly SelectionCandidateV3<T>[];
  membershipPredicates: readonly MembershipPredicateV3[];
  rankingObjectives: readonly RankingObjectiveV3[];
  target: number;
}): SelectionResultV3<T> {
  if (!Number.isSafeInteger(input.target) || input.target < 0) throw new Error("Selection target must be a non-negative integer");
  const eligible: SelectionCandidateV3<T>[] = [];
  const rejected: Array<{ candidate: SelectionCandidateV3<T>; failedPredicateIds: readonly string[] }> = [];
  for (const candidate of input.candidates) {
    const decision = evaluateCandidateMembershipV3(candidate, input.membershipPredicates);
    if (decision.eligible) eligible.push(candidate);
    else rejected.push({ candidate, failedPredicateIds: decision.failedPredicateIds });
  }
  eligible.sort((left, right) => (
    rankingScore(right, input.rankingObjectives) - rankingScore(left, input.rankingObjectives)
    || left.sourceRank - right.sourceRank
    || left.id.localeCompare(right.id)
  ));
  const selected = eligible.slice(0, input.target);
  return { selected, rejected, shortfall: Math.max(0, input.target - selected.length) };
}

/**
 * Greedy deterministic spacing. It uses only stored metadata and objective
 * scores; it deliberately makes no BPM/key/music-theory claim.
 */
export function sequenceCandidatesV3<T>(
  candidates: readonly SelectionCandidateV3<T>[],
): SelectionCandidateV3<T>[] {
  const remaining = [...candidates];
  const output: SelectionCandidateV3<T>[] = [];
  while (remaining.length > 0) {
    const previous = output.at(-1);
    let index = remaining.findIndex((candidate) => (
      !previous
      || (normalized(candidate.artist) !== normalized(previous.artist)
        && (!candidate.album || !previous.album || normalized(candidate.album) !== normalized(previous.album)))
    ));
    if (index < 0) index = remaining.findIndex((candidate) => (
      !previous || normalized(candidate.artist) !== normalized(previous.artist)
    ));
    if (index < 0) index = 0;
    output.push(remaining.splice(index, 1)[0]!);
  }
  return output;
}
