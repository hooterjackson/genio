import type {
  PipelinePolicySnapshot,
  PlaylistBrief,
  PlaylistGuidanceTelemetry,
  SelectionPlan,
} from "../shared/types.ts";
import {
  EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS,
  executableCuratedResearchBudgetUsd,
  GUIDED_SCOUT_BUDGET_USD,
} from "../shared/product-policy.ts";
import {
  fastRunServiceLevel,
  isSupportedFastRouteTiming,
} from "../shared/fast-run-sla.ts";
import { stableStringify } from "./security.ts";
import {
  adaptiveDiscoveryPlan,
  SELECTION_PLAN_VERSION,
} from "./pipeline-v2-policy.ts";
import { APPLE_CATALOG_CACHE_TTL_MS } from "./apple-catalog-cache.ts";
import { requiresFactualFrontier } from "./factual-frontier-policy.ts";

type Environment = Record<string, string | undefined>;

/** Pipeline V2 has no MusicBrainz hot path; any future enrichment is capped. */
export const PIPELINE_V2_MUSICBRAINZ_MAX_UNCACHED_REQUESTS = 5;

export interface FastResearchPolicy {
  kind: "fast_curated";
  version: "fast_curated_v3";
  model: string;
  runDeadlineMs: number;
  matchingReserveMs: number;
  targetMinimum: number;
  targetMaximum: number;
  candidateGoal: number;
  candidateLimit: number;
  maxPasses: number;
  maxWebToolCalls: number;
  maxSynthesisTokens: number;
  maxExtractionTokens: number;
  searchContextSize: "low" | "medium";
  /** Durable explanation of the curated model selected for this run. */
  modelRoute: CuratedModelRouteDecision;
}

/**
 * One authoritative contract for every fast OpenAI Responses call. Keeping
 * request limits and the corresponding local validation limit in the same
 * value prevents a response that the provider was allowed to produce from
 * being rejected after the call completes.
 */
export interface FastOpenAIRequestPolicy {
  maxToolCalls: number;
  maxHostedSearchCalls: number;
  maxSynthesisTokens: number;
  maxExtractionTokens: number;
  candidateLimit: number;
}

export interface DeepResearchPolicy {
  kind: "deep";
  version: "deep_v1";
  model: string;
}

export type ResearchExecutionPolicy = FastResearchPolicy | DeepResearchPolicy;

export type CuratedScoutConfidence = "high" | "medium" | "low";

export interface CuratedModelRoutingSignals {
  /** Explicit confidence emitted by a V2 question scout or deterministic evaluator. */
  scoutConfidence?: CuratedScoutConfidence | number | null;
  /** Existing scout telemetry; legacy rows may omit it. */
  scoutTelemetry?: Pick<PlaylistGuidanceTelemetry,
    "generationMode" | "proposedQuestionCount" | "acceptedQuestionCount" | "validationIssues"> | null;
  /** Count of failed structured/schema repairs observed before research begins. */
  structuredRepairFailures?: number;
}

export type CuratedModelRouteReason =
  | "luna_baseline"
  | "scout_low_confidence"
  | "structured_repair_failed";

/**
 * Immutable, typed model-routing record. `modelSnapshot` deliberately records
 * the resolved environment value rather than the environment variable name so
 * a resumed run cannot silently move to another model after configuration
 * changes.
 */
export interface CuratedModelRouteDecision {
  version: "curated_model_route_v1";
  tier: "luna" | "terra";
  modelSnapshot: string;
  reason: CuratedModelRouteReason;
  scoutConfidence: CuratedScoutConfidence;
  structuredRepairFailures: number;
}

// Small curated requests keep the original two-minute route. Larger requests
// use the size-tiered service levels in shared/fast-run-sla.ts; they are never
// advertised as two-minute work.
export const FAST_RUN_DEADLINE_MS = 120_000;
// Catalog lookup now uses a precision-preserving query ladder. Reserve enough
// of the same two-minute route to finish that work instead of turning the tail
// of every medium playlist into timeout placeholders.
export const FAST_MATCHING_RESERVE_MS = 40_000;
export const FAST_MATCHING_FINALIZATION_RESERVE_MS = 5_000;
export const FAST_CURATED_TARGET_MAXIMUM = EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS;
export const FAST_EXTRACTION_CANDIDATE_LIMIT = 120;
export const FAST_POST_MATCH_REFILL_MAX_TOOL_CALLS = 3;
export const FAST_POST_MATCH_REFILL_MAX_SYNTHESIS_TOKENS = 3_000;
// A third bounded generation is a resilience allowance, not an invitation to
// loosen matching. Production canaries showed that one transient provider
// failure otherwise consumed half of the two-pass budget and forced a broad,
// evidence-rich request to publish 18/25. Every generation still has its own
// fixed time, candidate, and $0.35 ceilings; publication remains partial when
// all three safe recovery attempts are exhausted.
export const FAST_POST_MATCH_REFILL_LIMIT = 3;
// A refill is an accuracy recovery path after the original fast route has
// already finished, so it owns a separate, short durable deadline. Each
// generation performs at most one cited synthesis call and then matches only
// the newly saved candidates.
export const FAST_POST_MATCH_REFILL_RESEARCH_MS = 30_000;
export const FAST_POST_MATCH_REFILL_MINIMUM_MATCHING_RESERVE_MS = 60_000;
export const FAST_POST_MATCH_REFILL_MATCHING_RESERVE_MS = 120_000;
export const FAST_POST_MATCH_REFILL_RUN_MS = FAST_POST_MATCH_REFILL_RESEARCH_MS
  + FAST_POST_MATCH_REFILL_MATCHING_RESERVE_MS;
export const FAST_POST_MATCH_REFILL_MAX_COST_USD = 0.35;
// Production catalog yield is intentionally strict: ambiguous versions stay
// out of automatic playlists. A 50% reserve left exact curated requests one
// safe match short at an observed 63% yield. Research 75% extra candidates so
// exact counts are recovered by additional evidence-backed recordings instead
// of weakening Apple version matching.
export const FAST_RESERVE_RATIO = 0.75;

export function boundedFastCandidateLimit(candidateLimit: number): number {
  const parsed = Number(candidateLimit);
  return Math.max(
    1,
    Math.min(
      FAST_EXTRACTION_CANDIDATE_LIMIT,
      Number.isFinite(parsed) ? Math.floor(parsed) : 1,
    ),
  );
}

export function fastOpenAIRequestPolicy(
  policy: FastResearchPolicy,
  candidateLimit = policy.candidateLimit,
  ceilings: {
    maxToolCalls?: number;
    maxSynthesisTokens?: number;
    maxExtractionTokens?: number;
  } = {},
): FastOpenAIRequestPolicy {
  const maxToolCalls = Math.max(
    1,
    Math.min(
      policy.maxWebToolCalls,
      Math.floor(ceilings.maxToolCalls ?? policy.maxWebToolCalls),
    ),
  );
  return {
    maxToolCalls,
    // Hosted searches are the billable/search-budget subset of tool calls.
    // They can never legitimately exceed the total tool-call allowance.
    maxHostedSearchCalls: maxToolCalls,
    maxSynthesisTokens: Math.max(
      1,
      Math.min(
        policy.maxSynthesisTokens,
        Math.floor(ceilings.maxSynthesisTokens ?? policy.maxSynthesisTokens),
      ),
    ),
    maxExtractionTokens: Math.max(
      1,
      Math.min(
        policy.maxExtractionTokens,
        Math.floor(ceilings.maxExtractionTokens ?? policy.maxExtractionTokens),
      ),
    ),
    candidateLimit: boundedFastCandidateLimit(candidateLimit),
  };
}

export function fastPostMatchRefillOpenAIRequestPolicy(
  policy: FastResearchPolicy,
  candidateLimit: number,
): FastOpenAIRequestPolicy {
  return fastOpenAIRequestPolicy(policy, candidateLimit, {
    maxToolCalls: FAST_POST_MATCH_REFILL_MAX_TOOL_CALLS,
    maxSynthesisTokens: FAST_POST_MATCH_REFILL_MAX_SYNTHESIS_TOKENS,
  });
}

/**
 * Build a source-backed reserve before Apple matching. Exact requests above
 * the fast-path ceiling still need spare candidates: otherwise one catalog
 * miss makes the requested count impossible even when more supported tracks
 * exist. The reserve is capped so very large requests remain bounded.
 */
export function catalogMatchingCandidateGoal(requestedMinimum: number): number {
  const minimum = Math.max(1, Math.floor(requestedMinimum));
  // Every size needs a reserve, but a one-track increase must not cause a
  // discontinuous jump in research volume. A smooth 75% curve preserves the
  // exact-count backfill margin while keeping tiny prompts cheap.
  const reserve = Math.min(
    1_000,
    Math.max(3, Math.ceil(minimum * FAST_RESERVE_RATIO)),
  );
  return minimum + reserve;
}

export interface FastPostMatchRefillPlan {
  state: "satisfied" | "refill" | "shortfall";
  requestedMinimum: number;
  selectableCount: number;
  shortfall: number;
  additionalCandidateGoal: number;
}

export interface FastArtistDiversityRefillPlan {
  state: "satisfied" | "refill" | "shortfall";
  requestedTrackCount: number;
  desiredArtistCount: number;
  representedArtistCount: number;
  artistShortfall: number;
  additionalCandidateGoal: number;
}

export interface FastPostMatchRefillRouteCheckpoint {
  status: "queued";
  profile: "fast_post_match_refill_v1";
  generation: number;
  model: string;
  confirmedAt: string;
  researchDeadlineAt: string;
  deadlineAt: string;
  matchingReserveMs: number;
  additionalCandidateGoal: number;
  storefront: string;
  baselineEligibleCount: number;
  targetEligibleCount: number;
  baselineSelectionRank: number;
  diversityTarget?: number;
  representedArtists?: string[];
}

export function fastPostMatchRefillMatchingReserveMs(additionalCandidateGoal: number): number {
  const goal = Math.max(1, Math.min(FAST_EXTRACTION_CANDIDATE_LIMIT, Math.floor(additionalCandidateGoal)));
  // Matching runs eight candidates concurrently in production. Budget one
  // bounded seven-second lookup window per batch plus finalization headroom.
  return Math.min(
    FAST_POST_MATCH_REFILL_MATCHING_RESERVE_MS,
    Math.max(FAST_POST_MATCH_REFILL_MINIMUM_MATCHING_RESERVE_MS, Math.ceil(goal / 8) * 8_000 + 10_000),
  );
}

export function createFastPostMatchRefillRouteCheckpoint(
  generation: number,
  additionalCandidateGoal: number,
  storefront: string,
  confirmedAt = new Date(),
  environment: Environment = process.env,
  baseline: {
    eligibleCount?: number;
    selectionRank?: number;
    diversityTarget?: number;
    representedArtists?: readonly string[];
  } = {},
): FastPostMatchRefillRouteCheckpoint {
  const confirmedMs = confirmedAt.getTime();
  if (!Number.isFinite(confirmedMs)) throw new Error("Catalog refill confirmation time is invalid");
  const boundedGeneration = Math.max(1, Math.min(FAST_POST_MATCH_REFILL_LIMIT, Math.floor(generation)));
  const boundedGoal = Math.max(1, Math.min(FAST_EXTRACTION_CANDIDATE_LIMIT, Math.floor(additionalCandidateGoal)));
  const normalizedStorefront = storefront.toLowerCase();
  if (!/^[a-z]{2}$/u.test(normalizedStorefront)) throw new Error("Apple storefront must be a two-letter code");
  const matchingReserveMs = fastPostMatchRefillMatchingReserveMs(boundedGoal);
  const deadlineMs = confirmedMs + FAST_POST_MATCH_REFILL_RESEARCH_MS + matchingReserveMs;
  const baselineEligibleCount = Math.max(0, Math.floor(baseline.eligibleCount ?? 0));
  const baselineSelectionRank = Math.max(0, Math.floor(baseline.selectionRank ?? 0));
  const requestedDiversityTarget = Number(baseline.diversityTarget ?? 0);
  const diversityTarget = Number.isFinite(requestedDiversityTarget)
    ? Math.max(0, Math.min(boundedGoal + baselineEligibleCount, Math.floor(requestedDiversityTarget)))
    : 0;
  const representedArtists = [...new Set((baseline.representedArtists ?? [])
    .map((artist) => artist.trim())
    .filter(Boolean))].slice(0, 120);
  return {
    status: "queued",
    profile: "fast_post_match_refill_v1",
    generation: boundedGeneration,
    model: fastResearchModel(environment),
    confirmedAt: new Date(confirmedMs).toISOString(),
    researchDeadlineAt: new Date(deadlineMs - matchingReserveMs).toISOString(),
    deadlineAt: new Date(deadlineMs).toISOString(),
    matchingReserveMs,
    additionalCandidateGoal: boundedGoal,
    storefront: normalizedStorefront,
    baselineEligibleCount,
    targetEligibleCount: baselineEligibleCount + boundedGoal,
    baselineSelectionRank,
    ...(diversityTarget > 0 ? { diversityTarget } : {}),
    ...(representedArtists.length > 0 ? { representedArtists } : {}),
  };
}

export function parseFastPostMatchRefillRouteCheckpoint(
  value: unknown,
  expectedGeneration?: number,
): FastPostMatchRefillRouteCheckpoint | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<FastPostMatchRefillRouteCheckpoint>;
  const confirmedMs = typeof row.confirmedAt === "string" ? Date.parse(row.confirmedAt) : Number.NaN;
  const researchDeadlineMs = typeof row.researchDeadlineAt === "string" ? Date.parse(row.researchDeadlineAt) : Number.NaN;
  const deadlineMs = typeof row.deadlineAt === "string" ? Date.parse(row.deadlineAt) : Number.NaN;
  if (row.status !== "queued" || row.profile !== "fast_post_match_refill_v1") return null;
  if (!Number.isInteger(row.generation) || Number(row.generation) < 1 || Number(row.generation) > FAST_POST_MATCH_REFILL_LIMIT) return null;
  if (expectedGeneration !== undefined && row.generation !== expectedGeneration) return null;
  if (!Number.isFinite(confirmedMs) || !Number.isFinite(researchDeadlineMs) || !Number.isFinite(deadlineMs)) return null;
  if (!Number.isInteger(row.additionalCandidateGoal)
    || Number(row.additionalCandidateGoal) < 1
    || Number(row.additionalCandidateGoal) > FAST_EXTRACTION_CANDIDATE_LIMIT) return null;
  if (typeof row.model !== "string" || !row.model.trim()) return null;
  if (typeof row.storefront !== "string" || !/^[a-z]{2}$/u.test(row.storefront)) return null;
  if (!Number.isInteger(row.baselineEligibleCount) || Number(row.baselineEligibleCount) < 0) return null;
  if (!Number.isInteger(row.targetEligibleCount)
    || Number(row.targetEligibleCount) !== Number(row.baselineEligibleCount) + Number(row.additionalCandidateGoal)) return null;
  if (!Number.isInteger(row.baselineSelectionRank) || Number(row.baselineSelectionRank) < 0) return null;
  if (row.diversityTarget !== undefined
    && (!Number.isInteger(row.diversityTarget) || Number(row.diversityTarget) < 1)) return null;
  if (row.representedArtists !== undefined
    && (!Array.isArray(row.representedArtists)
      || row.representedArtists.some((artist) => typeof artist !== "string" || !artist.trim()))) return null;
  const expectedMatchingReserveMs = fastPostMatchRefillMatchingReserveMs(Number(row.additionalCandidateGoal));
  if (deadlineMs - confirmedMs !== FAST_POST_MATCH_REFILL_RESEARCH_MS + expectedMatchingReserveMs
    || deadlineMs - researchDeadlineMs !== expectedMatchingReserveMs
    || row.matchingReserveMs !== expectedMatchingReserveMs) return null;
  return {
    status: "queued",
    profile: "fast_post_match_refill_v1",
    generation: Number(row.generation),
    model: row.model,
    confirmedAt: new Date(confirmedMs).toISOString(),
    researchDeadlineAt: new Date(researchDeadlineMs).toISOString(),
    deadlineAt: new Date(deadlineMs).toISOString(),
    matchingReserveMs: expectedMatchingReserveMs,
    additionalCandidateGoal: Number(row.additionalCandidateGoal),
    storefront: row.storefront,
    baselineEligibleCount: Number(row.baselineEligibleCount),
    targetEligibleCount: Number(row.targetEligibleCount),
    baselineSelectionRank: Number(row.baselineSelectionRank),
    ...(row.diversityTarget !== undefined ? { diversityTarget: Number(row.diversityTarget) } : {}),
    ...(row.representedArtists !== undefined
      ? { representedArtists: [...new Set(row.representedArtists.map((artist) => artist.trim()))].slice(0, 120) }
      : {}),
  };
}

/**
 * Plan a bounded cited refill when Apple already has enough strict tracks but
 * the accepted pool is still concentrated in too few credited artists.
 * Each missing artist needs more than one research candidate because some
 * versions will fail strict catalog matching; a 75% target reserve keeps the
 * path useful without exceeding the existing per-generation ceiling.
 */
export function fastArtistDiversityRefillPlan(input: {
  requestedTrackCount: number;
  desiredArtistCount: number;
  representedArtistCount: number;
  refillAttempts: number;
}): FastArtistDiversityRefillPlan {
  const requestedTrackCount = Number.isFinite(input.requestedTrackCount)
    ? Math.max(1, Math.floor(input.requestedTrackCount))
    : 1;
  const requestedDesiredArtistCount = Number.isFinite(input.desiredArtistCount)
    ? Math.floor(input.desiredArtistCount)
    : 0;
  const desiredArtistCount = Math.max(0, Math.min(
    requestedTrackCount,
    requestedDesiredArtistCount,
  ));
  const representedArtistCount = Number.isFinite(input.representedArtistCount)
    ? Math.max(0, Math.floor(input.representedArtistCount))
    : 0;
  const artistShortfall = Math.max(0, desiredArtistCount - representedArtistCount);
  if (artistShortfall === 0 || desiredArtistCount === 0) {
    return {
      state: "satisfied",
      requestedTrackCount,
      desiredArtistCount,
      representedArtistCount,
      artistShortfall: 0,
      additionalCandidateGoal: 0,
    };
  }
  const refillAttempts = Number.isFinite(input.refillAttempts)
    ? Math.max(0, Math.floor(input.refillAttempts))
    : FAST_POST_MATCH_REFILL_LIMIT;
  if (refillAttempts >= FAST_POST_MATCH_REFILL_LIMIT) {
    return {
      state: "shortfall",
      requestedTrackCount,
      desiredArtistCount,
      representedArtistCount,
      artistShortfall,
      additionalCandidateGoal: 0,
    };
  }
  return {
    state: "refill",
    requestedTrackCount,
    desiredArtistCount,
    representedArtistCount,
    artistShortfall,
    additionalCandidateGoal: Math.min(
      FAST_EXTRACTION_CANDIDATE_LIMIT,
      Math.max(artistShortfall * 3, Math.ceil(requestedTrackCount * 0.75)),
    ),
  };
}

/**
 * Plan a bounded evidence-research refill after catalog matching. This helper
 * does not weaken the requested minimum: after the bounded refill limit, a
 * remaining deficit is an explicit terminal shortfall rather than a smaller
 * successful playlist.
 */
export function fastPostMatchRefillPlan(input: {
  requestedMinimum: number;
  selectableCount: number;
  attemptedCandidateCount: number;
  refillAttempts: number;
}): FastPostMatchRefillPlan {
  const requestedMinimum = Math.max(1, Math.floor(input.requestedMinimum));
  const selectableCount = Math.max(0, Math.floor(input.selectableCount));
  const attemptedCandidateCount = Math.max(selectableCount, Math.floor(input.attemptedCandidateCount));
  const shortfall = Math.max(0, requestedMinimum - selectableCount);
  if (shortfall === 0) {
    return { state: "satisfied", requestedMinimum, selectableCount, shortfall: 0, additionalCandidateGoal: 0 };
  }
  if (Math.max(0, Math.floor(input.refillAttempts)) >= FAST_POST_MATCH_REFILL_LIMIT) {
    return { state: "shortfall", requestedMinimum, selectableCount, shortfall, additionalCandidateGoal: 0 };
  }

  // Size the next raw batch from the lower-confidence storefront yield after
  // every strict filter, not from the model's raw-candidate count. This is the
  // V2 exact-fill controller: it includes a qualified reserve, starts at a
  // 50% cold yield, and never plans below the bounded 20% floor.
  const additionalCandidateGoal = adaptiveDiscoveryPlan({
    target: requestedMinimum,
    qualified: selectableCount,
    attempted: attemptedCandidateCount,
    observedQualified: selectableCount,
    maximumRawGoal: FAST_EXTRACTION_CANDIDATE_LIMIT,
  }).rawDiscoveryGoal;
  return { state: "refill", requestedMinimum, selectableCount, shortfall, additionalCandidateGoal };
}

export interface FastRouteCheckpoint {
  status: "queued";
  profile: FastResearchPolicy["version"];
  model: string;
  modelRoute: CuratedModelRouteDecision;
  confirmedAt: string;
  researchDeadlineAt: string;
  deadlineAt: string;
  matchingReserveMs: number;
}

export function createFastRouteCheckpoint(
  policy: FastResearchPolicy,
  confirmedAt = new Date(),
): FastRouteCheckpoint {
  const confirmedMs = confirmedAt.getTime();
  if (!Number.isFinite(confirmedMs)) throw new Error("Fast-run confirmation time is invalid");
  const deadlineMs = confirmedMs + policy.runDeadlineMs;
  return {
    status: "queued",
    profile: policy.version,
    model: policy.model,
    modelRoute: policy.modelRoute,
    confirmedAt: new Date(confirmedMs).toISOString(),
    researchDeadlineAt: new Date(deadlineMs - policy.matchingReserveMs).toISOString(),
    deadlineAt: new Date(deadlineMs).toISOString(),
    matchingReserveMs: policy.matchingReserveMs,
  };
}

export function parseFastRouteCheckpoint(
  value: unknown,
  expectedVersion: FastResearchPolicy["version"] = "fast_curated_v3",
): FastRouteCheckpoint | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<FastRouteCheckpoint>;
  if (row.status !== "queued" || row.profile !== expectedVersion || typeof row.model !== "string") return null;
  // Legacy V1 checkpoints did not persist a route explanation. Preserve their
  // already-pinned model and deadline instead of reinterpreting the in-flight
  // run under V2 configuration.
  const modelRoute = row.modelRoute === undefined
    ? {
      version: "curated_model_route_v1" as const,
      tier: "luna" as const,
      modelSnapshot: row.model,
      reason: "luna_baseline" as const,
      scoutConfidence: "medium" as const,
      structuredRepairFailures: 0,
    }
    : parseCuratedModelRouteDecision(row.modelRoute);
  if (!modelRoute || modelRoute.modelSnapshot !== row.model) return null;
  const confirmedMs = typeof row.confirmedAt === "string" ? Date.parse(row.confirmedAt) : Number.NaN;
  const researchDeadlineMs = typeof row.researchDeadlineAt === "string" ? Date.parse(row.researchDeadlineAt) : Number.NaN;
  const deadlineMs = typeof row.deadlineAt === "string" ? Date.parse(row.deadlineAt) : Number.NaN;
  if (!Number.isFinite(confirmedMs) || !Number.isFinite(researchDeadlineMs) || !Number.isFinite(deadlineMs)) return null;
  const runDeadlineMs = deadlineMs - confirmedMs;
  const matchingReserveMs = deadlineMs - researchDeadlineMs;
  if (researchDeadlineMs <= confirmedMs || researchDeadlineMs >= deadlineMs) return null;
  if (row.matchingReserveMs !== matchingReserveMs
    || !isSupportedFastRouteTiming(runDeadlineMs, matchingReserveMs)) return null;
  return {
    status: "queued",
    profile: expectedVersion,
    model: row.model,
    modelRoute,
    confirmedAt: new Date(confirmedMs).toISOString(),
    researchDeadlineAt: new Date(researchDeadlineMs).toISOString(),
    deadlineAt: new Date(deadlineMs).toISOString(),
    matchingReserveMs: row.matchingReserveMs,
  };
}

function parseCuratedModelRouteDecision(value: unknown): CuratedModelRouteDecision | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<CuratedModelRouteDecision>;
  const validReason = row.reason === "luna_baseline"
    || row.reason === "scout_low_confidence"
    || row.reason === "structured_repair_failed";
  const validConfidence = row.scoutConfidence === "high"
    || row.scoutConfidence === "medium"
    || row.scoutConfidence === "low";
  if (row.version !== "curated_model_route_v1"
    || (row.tier !== "luna" && row.tier !== "terra")
    || typeof row.modelSnapshot !== "string"
    || row.modelSnapshot.trim() === ""
    || !validReason
    || !validConfidence
    || !Number.isInteger(row.structuredRepairFailures)
    || (row.structuredRepairFailures ?? -1) < 0) return null;
  if ((row.reason === "luna_baseline") !== (row.tier === "luna")) return null;
  if (row.reason === "structured_repair_failed" && row.structuredRepairFailures === 0) return null;
  if (row.reason === "scout_low_confidence" && row.scoutConfidence !== "low") return null;
  return {
    version: "curated_model_route_v1",
    tier: row.tier,
    modelSnapshot: row.modelSnapshot,
    reason: row.reason as CuratedModelRouteReason,
    scoutConfidence: row.scoutConfidence as CuratedScoutConfidence,
    structuredRepairFailures: row.structuredRepairFailures as number,
  };
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

export function fastResearchModel(environment: Environment = process.env): string {
  return curatedLunaModelSnapshot(environment);
}

export function deepResearchModel(environment: Environment = process.env): string {
  return curatedTerraModelSnapshot(environment);
}

/**
 * Resolve the snapshot once at job creation. The Pipeline V2 variables are
 * intentionally more specific than the legacy aliases, while the legacy
 * fallbacks keep existing deployments backward compatible.
 */
export function curatedLunaModelSnapshot(environment: Environment = process.env): string {
  return environment.OPENAI_CURATED_LUNA_SNAPSHOT?.trim()
    || environment.OPENAI_FAST_MODEL?.trim()
    || "gpt-5.6-luna";
}

export function curatedTerraModelSnapshot(environment: Environment = process.env): string {
  return environment.OPENAI_CURATED_TERRA_SNAPSHOT?.trim()
    || environment.OPENAI_DEEP_MODEL?.trim()
    || "gpt-5.6-terra";
}

function normalizedScoutConfidence(signals: CuratedModelRoutingSignals): CuratedScoutConfidence {
  if (typeof signals.scoutConfidence === "number") {
    if (!Number.isFinite(signals.scoutConfidence)) return "medium";
    if (signals.scoutConfidence < 0.6) return "low";
    if (signals.scoutConfidence >= 0.8) return "high";
    return "medium";
  }
  if (signals.scoutConfidence === "high"
    || signals.scoutConfidence === "medium"
    || signals.scoutConfidence === "low") return signals.scoutConfidence;

  const telemetry = signals.scoutTelemetry;
  if (!telemetry) return "medium";
  if (telemetry.validationIssues.includes("scout:low_confidence")) return "low";
  // A local structured-output rejection means the scout did not establish a
  // dependable subject interpretation. Provider outages, timeouts, and budget
  // failures are deliberately excluded: escalating models cannot repair an
  // unavailable provider and would only increase cost.
  const localValidationFailure = telemetry.validationIssues.some((issue) => (
    /^response:(?:primary_)?(?:invalid_json|invalid_object|missing_output|incomplete_)/u.test(issue)
    || /^(?:schema|structured_output):/u.test(issue)
  ));
  if (telemetry.generationMode === "scout_unavailable" && localValidationFailure) return "low";
  if (telemetry.generationMode === "grounded_scout" && telemetry.acceptedQuestionCount > 0) return "high";
  return "medium";
}

function telemetryRepairFailures(telemetry: CuratedModelRoutingSignals["scoutTelemetry"]): number {
  if (!telemetry) return 0;
  return telemetry.validationIssues.filter((issue) => (
    issue !== "response:repaired_structured_output"
    && (
      /^response:repair_(?:invalid|missing|incomplete|timeout|provider|unavailable)/u.test(issue)
      || /^(?:schema|structured_output):repair_(?:failed|invalid|unavailable)/u.test(issue)
    )
  )).length;
}

/**
 * Route high-volume curated work to Luna. Terra is an evidence-preserving
 * repair route, never a generic retry: it is selected only when the scout
 * explicitly/locally establishes low confidence or a structured repair has
 * already failed once.
 */
export function curatedResearchModelRoute(
  signals: CuratedModelRoutingSignals = {},
  environment: Environment = process.env,
): CuratedModelRouteDecision {
  const scoutConfidence = normalizedScoutConfidence(signals);
  const explicitRepairFailures = Number.isFinite(signals.structuredRepairFailures)
    ? Math.max(0, Math.floor(signals.structuredRepairFailures ?? 0))
    : 0;
  const structuredRepairFailures = Math.max(
    explicitRepairFailures,
    telemetryRepairFailures(signals.scoutTelemetry),
  );
  const reason: CuratedModelRouteReason = structuredRepairFailures > 0
    ? "structured_repair_failed"
    : scoutConfidence === "low"
      ? "scout_low_confidence"
      : "luna_baseline";
  const tier = reason === "luna_baseline" ? "luna" : "terra";
  return {
    version: "curated_model_route_v1",
    tier,
    modelSnapshot: tier === "luna"
      ? curatedLunaModelSnapshot(environment)
      : curatedTerraModelSnapshot(environment),
    reason,
    scoutConfidence,
    structuredRepairFailures,
  };
}

export function briefInterpretationModel(environment: Environment = process.env): string {
  // Brief interpretation is a short, schema-constrained classification task.
  // GPT-5.4 mini is faster and 25% cheaper than Luna at the published rates;
  // cited web synthesis stays on Luna.
  return environment.OPENAI_BRIEF_MODEL?.trim() || "gpt-5.4-mini";
}

/**
 * Curated prompts are intentionally time-boxed. They produce a cited editorial
 * selection, not a claim of exhaustive source-frontier completion. Factual
 * exhaustive and constrained-hybrid prompts retain the durable deep pipeline.
 */
export function researchExecutionPolicy(
  brief: Pick<PlaylistBrief, "mode" | "targetSize">,
  environment: Environment = process.env,
  selectionPlan?: Pick<SelectionPlan, "intents"> | null,
  modelRoutingSignals: CuratedModelRoutingSignals = {},
): ResearchExecutionPolicy {
  const requestedMinimum = Math.max(1, Math.floor(brief.targetSize?.min ?? 50));
  const requestedMaximum = Math.max(requestedMinimum, Math.floor(brief.targetSize?.max ?? 100));
  const claimFirst = requiresFactualFrontier(brief, selectionPlan);
  if (claimFirst || brief.mode !== "curated" || requestedMaximum > FAST_CURATED_TARGET_MAXIMUM) {
    return { kind: "deep", version: "deep_v1", model: deepResearchModel(environment) };
  }

  const targetMaximum = Math.max(50, requestedMaximum);
  const targetMinimum = requestedMinimum;
  const candidateGoal = catalogMatchingCandidateGoal(targetMinimum);
  const serviceLevel = fastRunServiceLevel(targetMinimum);
  const modelRoute = curatedResearchModelRoute(modelRoutingSignals, environment);

  return {
    kind: "fast_curated",
    version: "fast_curated_v3",
    model: modelRoute.modelSnapshot,
    modelRoute,
    // One immutable, size-tiered wall-clock budget begins when the run is
    // confirmed. The research cutoff leaves a fixed tail for Apple catalog
    // matching; phases never start independent countdowns.
    runDeadlineMs: serviceLevel.runDeadlineMs,
    matchingReserveMs: serviceLevel.matchingReserveMs,
    targetMinimum,
    targetMaximum,
    // Research a reserve so catalog misses can be backfilled while the
    // immutable manifest still respects targetMaximum.
    candidateGoal,
    // The ceiling is per extraction response, not per playlist. Larger fast
    // requests are filled by independently cited, deduplicated passes.
    candidateLimit: Math.min(FAST_EXTRACTION_CANDIDATE_LIMIT, candidateGoal),
    // A short first answer is a refill signal, never a successful completion.
    // Independently checkpointed passes include one refill opportunity after
    // the minimum number needed to fill the reserve.
    maxPasses: Math.max(3, Math.ceil(candidateGoal / FAST_EXTRACTION_CANDIDATE_LIMIT) + 1),
    maxWebToolCalls: boundedInteger(environment.FAST_RESEARCH_MAX_WEB_CALLS, 5, 1, 6),
    maxSynthesisTokens: boundedInteger(environment.FAST_RESEARCH_MAX_SYNTHESIS_TOKENS, 6_000, 2_000, 8_000),
    maxExtractionTokens: boundedInteger(environment.FAST_RESEARCH_MAX_EXTRACTION_TOKENS, 8_000, 2_000, 12_000),
    searchContextSize: environment.FAST_RESEARCH_SEARCH_CONTEXT === "medium" ? "medium" : "low",
  };
}

function curatedRunCostCeiling(target: number): number {
  return executableCuratedResearchBudgetUsd(target);
}

/** Resolve and freeze every mutable policy input used by a Pipeline V2 run. */
export function createPipelinePolicySnapshot(input: {
  brief: Pick<PlaylistBrief, "mode" | "targetSize">;
  selectionPlan: SelectionPlan;
  environment?: Environment;
  modelRoutingSignals?: CuratedModelRoutingSignals;
  capturedAt?: string;
}): PipelinePolicySnapshot {
  const environment = input.environment ?? process.env;
  const executionPolicy = researchExecutionPolicy(
    input.brief,
    environment,
    input.selectionPlan,
    input.modelRoutingSignals,
  );
  const requestPolicy = executionPolicy.kind === "fast_curated"
    ? fastOpenAIRequestPolicy(executionPolicy)
    : null;
  const requested = Math.max(1, Math.floor(
    input.selectionPlan.requestedTrackCount
      || input.brief.targetSize?.max
      || input.brief.targetSize?.min
      || 50,
  ));
  const storefront = input.selectionPlan.storefront.trim().toLowerCase();
  const catalogConcurrency = boundedInteger(environment.APPLE_MATCHING_CONCURRENCY, 6, 2, 8);
  const recoveryDeadlineMs = boundedInteger(
    environment.APPLE_CATALOG_RECOVERY_TIMEOUT_MS,
    90_000,
    90_000,
    180_000,
  );
  const lookupTimeoutMs = boundedInteger(environment.FAST_MATCH_LOOKUP_TIMEOUT_MS, 7_000, 3_000, 12_000);
  const maximumRawDiscoveryGoal = adaptiveDiscoveryPlan({
    target: requested,
    qualified: 0,
    attempted: 0,
    observedQualified: 0,
    maximumRawGoal: Math.min(100_000, Math.max(1_000, requested * 20)),
  }).rawDiscoveryGoal;
  return {
    schemaVersion: 1,
    pipelineVersion: input.selectionPlan.pipelineVersion,
    policyVersion: input.selectionPlan.policyVersion,
    selectionPlanVersion: SELECTION_PLAN_VERSION,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    storefront,
    executionPolicy,
    requestLimits: {
      maxToolCalls: requestPolicy?.maxToolCalls ?? null,
      maxHostedSearchCalls: requestPolicy?.maxHostedSearchCalls ?? null,
      maxSynthesisTokens: requestPolicy?.maxSynthesisTokens ?? null,
      maxExtractionTokens: requestPolicy?.maxExtractionTokens ?? null,
    },
    costLimits: {
      scoutUsd: GUIDED_SCOUT_BUDGET_USD,
      curatedRunUsd: input.brief.mode === "curated" ? curatedRunCostCeiling(requested) : null,
      factualApprovalGateUsd: 5,
      postMatchRefillUsd: FAST_POST_MATCH_REFILL_MAX_COST_USD,
    },
    catalogLimits: {
      appleConcurrencyInitial: catalogConcurrency,
      appleConcurrencyMinimum: 2,
      appleConcurrencyMaximum: 8,
      catalogRecoveryDeadlineMs: recoveryDeadlineMs,
      catalogLookupTimeoutMs: lookupTimeoutMs,
      musicBrainzMaxUncachedRequests: PIPELINE_V2_MUSICBRAINZ_MAX_UNCACHED_REQUESTS,
      maximumRawDiscoveryGoal,
      catalogResourceCacheTtlSeconds: APPLE_CATALOG_CACHE_TTL_MS.catalog_resource / 1_000,
      catalogSearchCacheTtlSeconds: APPLE_CATALOG_CACHE_TTL_MS.search_view / 1_000,
      playlistMembershipCacheTtlSeconds: APPLE_CATALOG_CACHE_TTL_MS.playlist_membership / 1_000,
    },
    durableResearchLimits: {
      gapPasses: boundedInteger(environment.RESEARCH_MAX_GAP_PASSES, 6, 2, 20),
      turnsPerSegment: boundedInteger(environment.RESEARCH_TURNS_PER_SEGMENT, 5, 1, 20),
      segmentsPerPass: boundedInteger(environment.RESEARCH_MAX_SEGMENTS_PER_PASS, 3, 1, 100),
    },
    evidencePolicy: input.selectionPlan.evidencePolicy,
  };
}

export function researchExecutionPolicyForRun(
  run: {
    brief: Pick<PlaylistBrief, "mode" | "targetSize">;
    selectionPlan?: SelectionPlan | null;
    pipelineVersion?: string;
    policyVersion?: string;
    pipelinePolicySnapshot?: PipelinePolicySnapshot | null;
  },
  environment: Environment = process.env,
  modelRoutingSignals: CuratedModelRoutingSignals = {},
): ResearchExecutionPolicy {
  const snapshot = run.pipelinePolicySnapshot;
  if (!snapshot) {
    // Legacy V1 rows predate policy snapshots and remain readable until the
    // compatibility path is retired.
    return researchExecutionPolicy(run.brief, environment, run.selectionPlan, modelRoutingSignals);
  }
  if (snapshot.pipelineVersion !== run.pipelineVersion
    || snapshot.policyVersion !== run.policyVersion
    || (run.selectionPlan && (
      snapshot.pipelineVersion !== run.selectionPlan.pipelineVersion
      || snapshot.policyVersion !== run.selectionPlan.policyVersion
    ))) {
    throw new Error("Persisted pipeline policy snapshot does not match this run");
  }
  return snapshot.executionPolicy as ResearchExecutionPolicy;
}

export function storefrontForRun(
  run: { pipelinePolicySnapshot?: PipelinePolicySnapshot | null; selectionPlan?: SelectionPlan | null },
  environment: Environment = process.env,
): string {
  return run.pipelinePolicySnapshot?.storefront
    ?? run.selectionPlan?.storefront
    ?? environment.APPLE_STOREFRONT
    ?? "us";
}

export function researchPolicyFingerprint(
  brief: Pick<PlaylistBrief, "mode" | "targetSize">,
  environment: Environment = process.env,
  selectionPlan?: Pick<SelectionPlan, "intents"> | null,
  modelRoutingSignals: CuratedModelRoutingSignals = {},
): string {
  const policy = researchExecutionPolicy(brief, environment, selectionPlan, modelRoutingSignals);
  // Spread the complete effective policy so newly introduced execution knobs
  // cannot silently reuse results produced under an older configuration.
  return stableStringify({ fingerprintVersion: 4, intents: selectionPlan?.intents ?? [], ...policy });
}
