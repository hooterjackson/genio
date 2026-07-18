import type { PlaylistBrief } from "../shared/types.ts";
import {
  fastRunServiceLevel,
  isSupportedFastRouteTiming,
} from "../shared/fast-run-sla.ts";
import { stableStringify } from "./security.ts";

type Environment = Record<string, string | undefined>;

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
}

export interface DeepResearchPolicy {
  kind: "deep";
  version: "deep_v1";
  model: string;
}

export type ResearchExecutionPolicy = FastResearchPolicy | DeepResearchPolicy;

// Small curated requests keep the original two-minute route. Larger requests
// use the size-tiered service levels in shared/fast-run-sla.ts; they are never
// advertised as two-minute work.
export const FAST_RUN_DEADLINE_MS = 120_000;
// Catalog lookup now uses a precision-preserving query ladder. Reserve enough
// of the same two-minute route to finish that work instead of turning the tail
// of every medium playlist into timeout placeholders.
export const FAST_MATCHING_RESERVE_MS = 40_000;
export const FAST_MATCHING_FINALIZATION_RESERVE_MS = 5_000;
export const FAST_CURATED_TARGET_MAXIMUM = 300;
export const FAST_EXTRACTION_CANDIDATE_LIMIT = 120;
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
  baseline: { eligibleCount?: number; selectionRank?: number } = {},
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

  // Use observed storefront yield but keep the estimate bounded when the
  // first pass is exceptionally good or bad. The extra 25% is a reserve for
  // the refill itself; the per-pass ceiling preserves the fast-route bound.
  const observedYield = attemptedCandidateCount > 0 ? selectableCount / attemptedCandidateCount : 0;
  const planningYield = Math.min(0.95, Math.max(0.25, observedYield));
  const additionalCandidateGoal = Math.min(
    FAST_EXTRACTION_CANDIDATE_LIMIT,
    Math.max(shortfall, Math.ceil((shortfall / planningYield) * 1.25)),
  );
  return { state: "refill", requestedMinimum, selectableCount, shortfall, additionalCandidateGoal };
}

export interface FastRouteCheckpoint {
  status: "queued";
  profile: FastResearchPolicy["version"];
  model: string;
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
    confirmedAt: new Date(confirmedMs).toISOString(),
    researchDeadlineAt: new Date(researchDeadlineMs).toISOString(),
    deadlineAt: new Date(deadlineMs).toISOString(),
    matchingReserveMs: row.matchingReserveMs,
  };
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

export function fastResearchModel(environment: Environment = process.env): string {
  return environment.OPENAI_FAST_MODEL?.trim() || "gpt-5.6-luna";
}

export function deepResearchModel(environment: Environment = process.env): string {
  return environment.OPENAI_DEEP_MODEL?.trim()
    || "gpt-5.6-terra";
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
): ResearchExecutionPolicy {
  const requestedMinimum = Math.max(1, Math.floor(brief.targetSize?.min ?? 50));
  const requestedMaximum = Math.max(requestedMinimum, Math.floor(brief.targetSize?.max ?? 100));
  if (brief.mode !== "curated" || requestedMaximum > FAST_CURATED_TARGET_MAXIMUM) {
    return { kind: "deep", version: "deep_v1", model: deepResearchModel(environment) };
  }

  const targetMaximum = Math.max(50, requestedMaximum);
  const targetMinimum = requestedMinimum;
  const candidateGoal = catalogMatchingCandidateGoal(targetMinimum);
  const serviceLevel = fastRunServiceLevel(targetMinimum);

  return {
    kind: "fast_curated",
    version: "fast_curated_v3",
    model: fastResearchModel(environment),
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

export function researchPolicyFingerprint(
  brief: Pick<PlaylistBrief, "mode" | "targetSize">,
  environment: Environment = process.env,
): string {
  const policy = researchExecutionPolicy(brief, environment);
  // Spread the complete effective policy so newly introduced execution knobs
  // cannot silently reuse results produced under an older configuration.
  return stableStringify({ fingerprintVersion: 2, ...policy });
}
