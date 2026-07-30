import type { PlaylistBrief } from "../shared/types.ts";
import { fastRunServiceLevel } from "../shared/fast-run-sla.ts";
import {
  PUBLIC_FAST_RESEARCH_BUDGET_USD,
} from "../shared/product-policy.ts";
import {
  FAST_POST_MATCH_REFILL_LIMIT,
  FAST_POST_MATCH_REFILL_MAX_COST_USD,
  FAST_POST_MATCH_REFILL_RESEARCH_MS,
  fastPostMatchRefillMatchingReserveMs,
  fastPostMatchRefillPlan,
  researchExecutionPolicy,
  type FastResearchPolicy,
} from "./research-policy.ts";

export type ProductionScenarioExpectedOutcome = "exact_playlist" | "explicit_failure";

export type ProductionScenarioFailureClass =
  | "catalog_shortfall"
  | "cost_explosion"
  | "research_under_yield"
  | "semantic_scope"
  | "target_truncation"
  | "latency_regression";

export interface ProductionScenarioReplayProfile {
  candidateYieldRate: number;
  initialStrictMatchRate: number;
  retryableCatalogRate: number;
  recoverySuccessRate: number;
  /** Yield from each bounded evidence-research refill request. */
  refillCandidateYieldRate?: number;
  /** Aggregate strict Apple yield for candidates added by a refill. */
  refillStrictMatchRate?: number;
  /** Explicit ordered-ID reconciliation result; manifest creation is not publication. */
  publicationReconciliationSucceeds?: boolean;
}

export interface ProductionScenarioObservation {
  requestedTrackCount: number;
  candidateCount: number;
  strictMatchedCount: number;
  accountedCandidateCount: number;
  manifestTrackCount: number;
  publishedTrackCount: number;
  totalCostUsd: number;
  activeWorkDurationMs: number;
  terminalStatus: string;
  terminalPhase: string;
  postMatchRefillGenerations?: number;
}

export interface ProductionScenarioAssessment {
  releaseReady: boolean;
  failClosed: boolean;
  violations: string[];
}

export interface ProductionScenarioReplay {
  observation: ProductionScenarioObservation;
  policy: FastResearchPolicy;
  researchPasses: number;
  candidateGoal: number;
  initialStrictMatchedCount: number;
  retryableCatalogCount: number;
  recoveredCatalogCount: number;
  unavailableCatalogCount: number;
  postMatchRefillGenerations: number;
  refillCandidateGoals: number[];
  refillCandidateCount: number;
  refillStrictMatchedCount: number;
  refillCostUsd: number;
  refillDurationMs: number;
  candidateYieldRate: number;
  finalCatalogYieldRate: number;
}

/**
 * Frozen deterministic provider tape. These values are deliberately
 * conservative enough to exercise multi-pass research, Apple timeout
 * recovery, cost accounting, and the public latency contract without making
 * a paid or networked provider call in CI.
 */
export const PRODUCTION_SCENARIO_REPLAY_TAPE = Object.freeze({
  guidedBriefCostUsd: 0.12,
  researchPassCostUsd: 0.10,
  researchPassDurationMs: 12_000,
  initialCatalogBaseDurationMs: 3_000,
  initialCatalogCandidateDurationMs: 45,
  recoveryCatalogBaseDurationMs: 4_000,
  recoveryCatalogCandidateDurationMs: 90,
});

function boundedRate(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite rate from 0 through 1`);
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function fastPolicy(brief: PlaylistBrief): FastResearchPolicy {
  const policy = researchExecutionPolicy(brief, {});
  if (policy.kind !== "fast_curated") {
    throw new Error("Production scenario replay requires the public fast-curated policy");
  }
  return policy;
}

function simulateCandidateResearch(
  policy: FastResearchPolicy,
  candidateYieldRate: number,
): { candidateCount: number; passes: number } {
  let candidateCount = 0;
  let passes = 0;
  while (candidateCount < policy.candidateGoal && passes < policy.maxPasses) {
    const remainingNeeded = policy.candidateGoal - candidateCount;
    // Mirrors processFastCuratedJob: the model may see a slightly larger
    // extraction ceiling, but the authoritative minimum remains the remaining
    // candidate shortfall.
    const passCandidateLimit = Math.min(
      policy.candidateLimit,
      Math.max(remainingNeeded, Math.ceil(remainingNeeded * 1.25)),
    );
    const passMinimumCandidateCount = Math.min(remainingNeeded, passCandidateLimit);
    const returned = Math.min(
      passCandidateLimit,
      Math.floor(passMinimumCandidateCount * candidateYieldRate),
    );
    candidateCount += returned;
    passes += 1;
    if (returned === 0) break;
  }
  return { candidateCount, passes };
}

export function maximumScenarioActiveDurationMs(
  requestedTrackCount: number,
  postMatchRefillGenerations = 0,
): number {
  const boundedRefillGenerations = Math.max(
    0,
    Math.min(FAST_POST_MATCH_REFILL_LIMIT, Math.floor(postMatchRefillGenerations)),
  );
  return fastRunServiceLevel(
    positiveInteger(requestedTrackCount, "requestedTrackCount"),
  ).runDeadlineMs + boundedRefillGenerations * (
    FAST_POST_MATCH_REFILL_RESEARCH_MS + fastPostMatchRefillMatchingReserveMs(120)
  );
}

/**
 * Replay an archived request against the actual deterministic fast-route
 * policy. This models pre-match evidence oversampling, strict unique Apple
 * matches, bounded recovery of retryable Apple lookups, and the implemented
 * post-match evidence-research refill. The refill uses the same planner,
 * generation ceiling, cost ceiling, and immutable research/matching windows
 * as production.
 */
export function replayProductionScenario(
  brief: PlaylistBrief,
  profile: ProductionScenarioReplayProfile,
): ProductionScenarioReplay {
  const policy = fastPolicy(brief);
  const requestedTrackCount = positiveInteger(
    brief.targetSize?.min ?? 0,
    "brief.targetSize.min",
  );
  if (brief.targetSize?.max !== requestedTrackCount) {
    throw new Error("Production scenario replay requires an exact track target");
  }

  const candidateYieldRate = boundedRate(profile.candidateYieldRate, "candidateYieldRate");
  const initialStrictMatchRate = boundedRate(profile.initialStrictMatchRate, "initialStrictMatchRate");
  const retryableCatalogRate = boundedRate(profile.retryableCatalogRate, "retryableCatalogRate");
  const recoverySuccessRate = boundedRate(profile.recoverySuccessRate, "recoverySuccessRate");
  const refillCandidateYieldRate = boundedRate(
    profile.refillCandidateYieldRate ?? profile.candidateYieldRate,
    "refillCandidateYieldRate",
  );
  const refillStrictMatchRate = boundedRate(
    profile.refillStrictMatchRate ?? profile.initialStrictMatchRate,
    "refillStrictMatchRate",
  );
  if (initialStrictMatchRate + retryableCatalogRate > 1) {
    throw new Error("Initial strict and retryable catalog rates cannot exceed 1 in total");
  }

  const research = simulateCandidateResearch(policy, candidateYieldRate);
  const initialStrictMatchedCount = Math.floor(research.candidateCount * initialStrictMatchRate);
  const retryableCatalogCount = Math.min(
    research.candidateCount - initialStrictMatchedCount,
    Math.floor(research.candidateCount * retryableCatalogRate),
  );
  const recoveredCatalogCount = Math.floor(retryableCatalogCount * recoverySuccessRate);
  let strictMatchedCount = Math.min(
    research.candidateCount,
    initialStrictMatchedCount + recoveredCatalogCount,
  );
  let candidateCount = research.candidateCount;
  let refillCandidateCount = 0;
  let refillStrictMatchedCount = 0;
  let refillDurationMs = 0;
  let refillCostUsd = 0;
  const refillCandidateGoals: number[] = [];

  for (let refillAttempts = 0; refillAttempts < FAST_POST_MATCH_REFILL_LIMIT; refillAttempts += 1) {
    const refillPlan = fastPostMatchRefillPlan({
      requestedMinimum: requestedTrackCount,
      selectableCount: strictMatchedCount,
      attemptedCandidateCount: candidateCount,
      refillAttempts,
    });
    if (refillPlan.state !== "refill") break;
    const goal = refillPlan.additionalCandidateGoal;
    refillCandidateGoals.push(goal);
    const returnedCandidates = Math.min(goal, Math.floor(goal * refillCandidateYieldRate));
    const newStrictMatches = Math.min(
      returnedCandidates,
      Math.floor(returnedCandidates * refillStrictMatchRate),
    );
    candidateCount += returnedCandidates;
    strictMatchedCount += newStrictMatches;
    refillCandidateCount += returnedCandidates;
    refillStrictMatchedCount += newStrictMatches;
    refillCostUsd += FAST_POST_MATCH_REFILL_MAX_COST_USD;
    refillDurationMs += FAST_POST_MATCH_REFILL_RESEARCH_MS
      + fastPostMatchRefillMatchingReserveMs(goal);
  }

  const unavailableCatalogCount = Math.max(0, candidateCount - strictMatchedCount);
  const complete = strictMatchedCount >= requestedTrackCount;
  // After bounded research and catalog recovery, production publishes every
  // strict unique match it safely found. Missing the requested count is a
  // transparent partial outcome, never a count-driven task failure.
  const manifestTrackCount = complete
    ? requestedTrackCount
    : Math.max(0, strictMatchedCount);
  const publicationReconciled =
    profile.publicationReconciliationSucceeds !== false;
  const reconciledPublishedTrackCount = publicationReconciled
    ? manifestTrackCount
    : 0;

  const researchDurationMs = research.passes * PRODUCTION_SCENARIO_REPLAY_TAPE.researchPassDurationMs;
  const initialCatalogDurationMs = PRODUCTION_SCENARIO_REPLAY_TAPE.initialCatalogBaseDurationMs
    + research.candidateCount * PRODUCTION_SCENARIO_REPLAY_TAPE.initialCatalogCandidateDurationMs;
  const recoveryDurationMs = retryableCatalogCount === 0
    ? 0
    : PRODUCTION_SCENARIO_REPLAY_TAPE.recoveryCatalogBaseDurationMs
      + retryableCatalogCount * PRODUCTION_SCENARIO_REPLAY_TAPE.recoveryCatalogCandidateDurationMs;

  const observation: ProductionScenarioObservation = {
    requestedTrackCount,
    candidateCount,
    strictMatchedCount,
    accountedCandidateCount: candidateCount,
    manifestTrackCount,
    publishedTrackCount: reconciledPublishedTrackCount,
    totalCostUsd: PRODUCTION_SCENARIO_REPLAY_TAPE.guidedBriefCostUsd
      + research.passes * PRODUCTION_SCENARIO_REPLAY_TAPE.researchPassCostUsd
      + refillCostUsd,
    activeWorkDurationMs: researchDurationMs + initialCatalogDurationMs + recoveryDurationMs + refillDurationMs,
    terminalStatus: complete && publicationReconciled
      ? "complete"
      : publicationReconciled
        ? "partial"
        : "failed",
    terminalPhase: complete && publicationReconciled
      ? "publication_complete"
      : !publicationReconciled
        ? "publication_reconciliation_failed"
        : manifestTrackCount > 0
        ? "publication_partial"
        : "catalog_matching_empty",
    postMatchRefillGenerations: refillCandidateGoals.length,
  };

  return {
    observation,
    policy,
    researchPasses: research.passes,
    candidateGoal: policy.candidateGoal,
    initialStrictMatchedCount,
    retryableCatalogCount,
    recoveredCatalogCount,
    unavailableCatalogCount,
    postMatchRefillGenerations: refillCandidateGoals.length,
    refillCandidateGoals,
    refillCandidateCount,
    refillStrictMatchedCount,
    refillCostUsd,
    refillDurationMs,
    candidateYieldRate: policy.candidateGoal === 0 ? 0 : research.candidateCount / policy.candidateGoal,
    finalCatalogYieldRate: candidateCount === 0 ? 0 : strictMatchedCount / candidateCount,
  };
}

/**
 * Release gate for a promoted production observation or deterministic replay.
 * Genuine terminal failures are fail-closed only when they produced no
 * manifest or published tracks. Count shortfalls are modeled as partial
 * outcomes and remain visible quality violations for scenarios that expect an
 * exact playlist.
 */
export function assessProductionScenario(
  observation: ProductionScenarioObservation,
  expectedOutcome: ProductionScenarioExpectedOutcome,
): ProductionScenarioAssessment {
  const requested = positiveInteger(observation.requestedTrackCount, "requestedTrackCount");
  const violations: string[] = [];
  const failClosed = observation.terminalStatus === "failed"
    && observation.manifestTrackCount === 0
    && observation.publishedTrackCount === 0;

  if (observation.candidateCount < requested) {
    violations.push(`research_under_yield:${observation.candidateCount}/${requested}`);
  }
  if (observation.accountedCandidateCount !== observation.candidateCount) {
    violations.push(`candidate_accounting:${observation.accountedCandidateCount}/${observation.candidateCount}`);
  }
  if (observation.totalCostUsd > PUBLIC_FAST_RESEARCH_BUDGET_USD + Number.EPSILON) {
    violations.push(`cost_explosion:${observation.totalCostUsd.toFixed(6)}`);
  }
  const latencyLimit = maximumScenarioActiveDurationMs(
    requested,
    observation.postMatchRefillGenerations ?? 0,
  );
  if (observation.activeWorkDurationMs > latencyLimit) {
    violations.push(`latency_regression:${observation.activeWorkDurationMs}/${latencyLimit}`);
  }

  if (expectedOutcome === "exact_playlist") {
    if (observation.strictMatchedCount < requested) {
      violations.push(`catalog_shortfall:${observation.strictMatchedCount}/${requested}`);
    }
    if (observation.manifestTrackCount !== requested) {
      violations.push(`manifest_count:${observation.manifestTrackCount}/${requested}`);
    }
    if (observation.publishedTrackCount !== requested) {
      violations.push(`published_count:${observation.publishedTrackCount}/${requested}`);
    }
    if (observation.terminalStatus !== "complete") {
      violations.push(`terminal_status:${observation.terminalStatus}`);
    }
  } else if (!failClosed) {
    violations.push("failure_not_fail_closed");
  }

  return {
    releaseReady: violations.length === 0,
    failClosed,
    violations,
  };
}
