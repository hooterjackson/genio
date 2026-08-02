import { sha256Hex, stableStringify } from "./security.ts";
import {
  fixedContainerResolutionProvesClosedSetV1,
  type FixedContainerResolutionProofV1,
} from "./fixed-container-resolution-proof-v1.ts";

export const PLAYLIST_FEASIBILITY_POLICY_VERSION = "playlist_feasibility_v1" as const;

export type PlaylistFeasibilityStateV1 =
  | "contradictory"
  | "known_ceiling"
  | "likely"
  | "at_risk"
  | "unknown"
  | "frontier_exhausted_under_policy";

export type PlaylistFeasibilityDependencyHealthV1 =
  | "healthy"
  | "degraded"
  | "unavailable";

export interface PlaylistFeasibilityFrontierV1 {
  /** Stable strategy identifier, for example `apple_editorial_container`. */
  id: string;
  /**
   * Strategies which ultimately rely on the same upstream dependency share
   * this key. Several prompts sent to one provider are therefore one frontier.
   */
  dependencyKey: string;
  /**
   * Complete dependency set for composite strategies. Frontier proof may
   * combine only strategies whose sets are disjoint; a hosted+catalog query
   * is not independent from either a hosted-only or catalog-only query.
   */
  dependencyKeys?: readonly string[];
  status: "not_started" | "active" | "complete" | "unavailable";
  discoveredCount: number;
  qualifiedCount: number;
}

export interface PlaylistRuntimeFeasibilityBudgetV1 {
  stopReason: string;
  activeComputeConsumedMs: number;
  activeComputeAllowanceMs: number;
  observedStrategyRounds: number;
  maximumGlobalRounds: number;
  maximumRawCandidates: number;
  maximumCostUnits: number;
  qualifiedPoolGoal: number | null;
  deadlineReached: boolean;
}

export interface PlaylistRuntimeFeasibilityEvidenceV1 {
  source: "pipeline_v3_retrieval";
  /** Distinct normalized candidate identities, never cumulative observations. */
  uniqueCandidateCount?: number;
  discoveredCount: number;
  qualifiedCount: number;
  storefrontSafeCount: number;
  activeResearchBudgetExhausted: boolean;
  dependencyOutages: readonly {
    dependencyKey: string;
    active: boolean;
    circuitOpen: boolean;
    failureAttempts: number;
    affectedFrontierIds: readonly string[];
  }[];
  frontiers: readonly PlaylistFeasibilityFrontierV1[];
  /** Added append-only; absent only on historical runtime reports. */
  fixedContainerResolution?: FixedContainerResolutionProofV1 | null;
  budgets: PlaylistRuntimeFeasibilityBudgetV1;
}

export interface PlaylistFeasibilityObservationV1 {
  contractRevisionId: string;
  contractSemanticHash: string;
  targetTrackCount: number;
  scope: "open_world" | "closed_set";
  phase: "preview" | "bounded_research";
  dependencyHealth: PlaylistFeasibilityDependencyHealthV1;
  /**
   * Conservative and optimistic estimates after identity, deduplication,
   * evidence, version, content, and storefront checks.
   */
  eligibleEstimateLower: number | null;
  eligibleEstimateUpper: number | null;
  /** Known unique capacity for a closed set such as one fixed release. */
  closedSetCapacity: number | null;
  discoveredCount: number;
  qualifiedCount: number;
  storefrontSafeCount: number;
  contradictions: readonly string[];
  limitingPredicateIds: readonly string[];
  frontiers: readonly PlaylistFeasibilityFrontierV1[];
  activeResearchBudgetExhausted: boolean;
  policyVersions: Readonly<Record<string, string>>;
  runtimeEvidence?: PlaylistRuntimeFeasibilityEvidenceV1 | null;
}

export interface PlaylistFeasibilityFrontierProofV1 {
  completedFrontierIds: string[];
  independentDependencyKeys: string[];
  discoveredCount: number;
  qualifiedCount: number;
  storefrontSafeCount: number;
  limitingPredicateIds: string[];
  policyVersions: Record<string, string>;
}

export interface PlaylistFeasibilityReportV1 {
  schemaVersion: 1;
  policyVersion: typeof PLAYLIST_FEASIBILITY_POLICY_VERSION;
  contractRevisionId: string;
  contractSemanticHash: string;
  state: PlaylistFeasibilityStateV1;
  targetTrackCount: number;
  reserveTrackCount: number;
  requiredInventoryCount: number;
  eligibleEstimateLower: number | null;
  eligibleEstimateUpper: number | null;
  dependencyHealth: PlaylistFeasibilityDependencyHealthV1;
  reasonCodes: string[];
  limitingPredicateIds: string[];
  frontierProof: PlaylistFeasibilityFrontierProofV1 | null;
  runtimeEvidence: PlaylistRuntimeFeasibilityEvidenceV1 | null;
  reportHash: string;
}

export interface PlaylistRuntimeFeasibilityInputV1 {
  contractRevisionId: string;
  contractSemanticHash: string;
  targetTrackCount: number;
  scope: "open_world" | "closed_set";
  stopReason: string;
  discoveredCount: number;
  /** Distinct normalized candidate identities, never cumulative observations. */
  uniqueCandidateCount?: number;
  qualifiedCount: number;
  storefrontSafeCount: number;
  contradictions: readonly string[];
  limitingPredicateIds: readonly string[];
  strategies: readonly {
    id: string;
    status:
      | "available"
      | "running"
      | "exhausted"
      | "circuit_open"
      | "provider_error"
      | "integrity_error";
    rounds: number;
    rawCandidates: number;
    newQualifiedFamilies: number;
    discoveryDependencyIds: readonly string[];
    fixedContainerResolution?: FixedContainerResolutionProofV1;
  }[];
  dependencyOutages: readonly {
    dependencyId: string;
    active: boolean;
    circuitOpen: boolean;
    failureAttempts: number;
    affectedStrategyIds: readonly string[];
  }[];
  budgets: Omit<
    PlaylistRuntimeFeasibilityBudgetV1,
    "stopReason" | "observedStrategyRounds" | "deadlineReached"
  >;
  policyVersions: Readonly<Record<string, string>>;
}

export type PlaylistRuntimeNoCompatibleDispositionV1 =
  | "allow"
  | "dependency_pause"
  | "coverage_audit"
  | "actionable_decision";

export type PlaylistCoverageAuditReasonV1 =
  | "candidate_rich_zero_qualification"
  | "catalog_safe_target_zero_qualification";

/**
 * Rich inventory with zero qualification is an evidence/capability signal,
 * not proof that the music does not exist. It must be audited before any
 * scarcity statement is allowed.
 */
export function playlistCoverageAuditReasonV1(input: {
  uniqueCandidateCount: number;
  qualifiedCount: number;
  storefrontSafeCount: number;
  targetTrackCount: number;
}): PlaylistCoverageAuditReasonV1 | null {
  const uniqueCandidateCount = Math.max(
    0,
    Math.floor(input.uniqueCandidateCount),
  );
  const qualifiedCount = Math.max(0, Math.floor(input.qualifiedCount));
  const storefrontSafeCount = Math.max(
    0,
    Math.floor(input.storefrontSafeCount),
  );
  const targetTrackCount = Math.max(1, Math.floor(input.targetTrackCount));
  if (qualifiedCount > 0) return null;
  if (storefrontSafeCount >= targetTrackCount) {
    return "catalog_safe_target_zero_qualification";
  }
  return uniqueCandidateCount >= 10
    ? "candidate_rich_zero_qualification"
    : null;
}

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`invalid_${field}`);
  }
}

function optionalNonNegativeInteger(value: number | null, field: string): void {
  if (value !== null) nonNegativeInteger(value, field);
}

function normalizedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export function playlistReserveTrackCountV1(targetTrackCount: number): number {
  if (!Number.isInteger(targetTrackCount) || targetTrackCount < 1) {
    throw new Error("invalid_target_track_count");
  }
  return Math.max(5, Math.ceil(targetTrackCount * 0.1));
}

/**
 * Candidate inventory is sized from the conservative observed conversion
 * rate. The clamp prevents a cold or tiny cohort from requesting an
 * unbounded corpus, while still requiring substantially more than the target.
 */
export function playlistCandidateGoalV1(
  targetTrackCount: number,
  p10QualifiedToStorefrontSafeConversionRate: number,
): {
  candidateGoal: number;
  reserveTrackCount: number;
  clampedConversionRate: number;
} {
  const reserveTrackCount = playlistReserveTrackCountV1(targetTrackCount);
  if (!Number.isFinite(p10QualifiedToStorefrontSafeConversionRate)) {
    throw new Error("invalid_conversion_rate");
  }
  const clampedConversionRate = Math.min(
    0.9,
    Math.max(0.25, p10QualifiedToStorefrontSafeConversionRate),
  );
  return {
    candidateGoal: Math.ceil(targetTrackCount / clampedConversionRate) + reserveTrackCount,
    reserveTrackCount,
    clampedConversionRate,
  };
}

function validateObservation(input: PlaylistFeasibilityObservationV1): void {
  if (!input.contractRevisionId.trim()) throw new Error("missing_contract_revision_id");
  if (!/^[0-9a-f]{64}$/u.test(input.contractSemanticHash)) {
    throw new Error("invalid_contract_semantic_hash");
  }
  nonNegativeInteger(input.targetTrackCount, "target_track_count");
  if (input.targetTrackCount < 1) throw new Error("invalid_target_track_count");
  optionalNonNegativeInteger(input.eligibleEstimateLower, "eligible_estimate_lower");
  optionalNonNegativeInteger(input.eligibleEstimateUpper, "eligible_estimate_upper");
  optionalNonNegativeInteger(input.closedSetCapacity, "closed_set_capacity");
  nonNegativeInteger(input.discoveredCount, "discovered_count");
  nonNegativeInteger(input.qualifiedCount, "qualified_count");
  nonNegativeInteger(input.storefrontSafeCount, "storefront_safe_count");
  if (
    input.eligibleEstimateLower !== null
    && input.eligibleEstimateUpper !== null
    && input.eligibleEstimateLower > input.eligibleEstimateUpper
  ) {
    throw new Error("inverted_eligible_estimate");
  }
  if (input.scope === "open_world" && input.closedSetCapacity !== null) {
    throw new Error("open_world_cannot_have_closed_set_capacity");
  }
  for (const frontier of input.frontiers) {
    if (!frontier.id.trim() || !frontier.dependencyKey.trim()) {
      throw new Error("invalid_frontier_identity");
    }
    nonNegativeInteger(frontier.discoveredCount, "frontier_discovered_count");
    nonNegativeInteger(frontier.qualifiedCount, "frontier_qualified_count");
    if ((frontier.dependencyKeys ?? [frontier.dependencyKey])
      .some((value) => !value.trim())) {
      throw new Error("invalid_frontier_dependency");
    }
  }
}

function independentCompletedFrontiers(
  frontiers: readonly PlaylistFeasibilityFrontierV1[],
): PlaylistFeasibilityFrontierV1[] {
  const completed = [...frontiers]
    .filter((frontier) => frontier.status === "complete")
    .sort((left, right) => left.id.localeCompare(right.id));
  let best: PlaylistFeasibilityFrontierV1[] = [];
  const search = (
    index: number,
    selected: PlaylistFeasibilityFrontierV1[],
    usedDependencies: Set<string>,
  ): void => {
    if (selected.length + completed.length - index <= best.length) return;
    if (index >= completed.length) {
      if (selected.length > best.length) best = [...selected];
      return;
    }
    const frontier = completed[index]!;
    const keys = normalizedUnique(
      frontier.dependencyKeys ?? [frontier.dependencyKey],
    ).filter((key) => key !== "orchestration_local");
    if (keys.length > 0 && keys.every((key) => !usedDependencies.has(key))) {
      const nextDependencies = new Set(usedDependencies);
      keys.forEach((key) => nextDependencies.add(key));
      search(index + 1, [...selected, frontier], nextDependencies);
    }
    search(index + 1, selected, usedDependencies);
  };
  search(0, [], new Set());
  return best;
}

function buildFrontierProof(
  input: PlaylistFeasibilityObservationV1,
): PlaylistFeasibilityFrontierProofV1 | null {
  const completed = independentCompletedFrontiers(input.frontiers);
  const dependencyKeys = normalizedUnique(completed.flatMap((frontier) => (
    frontier.dependencyKeys ?? [frontier.dependencyKey]
  )).filter((key) => key !== "orchestration_local"));
  if (
    input.phase !== "bounded_research"
    || !input.activeResearchBudgetExhausted
    || input.dependencyHealth !== "healthy"
    || completed.length < 2
    || dependencyKeys.length < 2
    || input.storefrontSafeCount >= input.targetTrackCount
  ) {
    return null;
  }
  return {
    completedFrontierIds: normalizedUnique(completed.map((frontier) => frontier.id)),
    independentDependencyKeys: dependencyKeys,
    discoveredCount: input.discoveredCount,
    qualifiedCount: input.qualifiedCount,
    storefrontSafeCount: input.storefrontSafeCount,
    limitingPredicateIds: normalizedUnique(input.limitingPredicateIds),
    policyVersions: Object.fromEntries(
      Object.entries(input.policyVersions).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

/**
 * Honest feasibility never turns incomplete open-world research into
 * "impossible". A healthy, bounded search may prove only that the configured
 * frontier was exhausted under the recorded policies.
 */
export function assessPlaylistFeasibilityV1(
  input: PlaylistFeasibilityObservationV1,
): PlaylistFeasibilityReportV1 {
  validateObservation(input);
  const reserveTrackCount = playlistReserveTrackCountV1(input.targetTrackCount);
  const requiredInventoryCount = input.targetTrackCount + reserveTrackCount;
  const contradictions = normalizedUnique(input.contradictions);
  const limitingPredicateIds = normalizedUnique(input.limitingPredicateIds);
  const frontierProof = buildFrontierProof(input);
  let state: PlaylistFeasibilityStateV1;
  let reasonCodes: string[];

  if (contradictions.length > 0) {
    state = "contradictory";
    reasonCodes = ["contract_predicates_conflict", ...contradictions.map((value) => `conflict:${value}`)];
  } else if (
    input.scope === "closed_set"
    && input.closedSetCapacity !== null
    && input.closedSetCapacity < input.targetTrackCount
  ) {
    state = "known_ceiling";
    reasonCodes = ["closed_set_below_requested_count"];
  } else if (input.dependencyHealth !== "healthy") {
    state = "unknown";
    reasonCodes = [`dependency_${input.dependencyHealth}`];
  } else if (frontierProof) {
    state = "frontier_exhausted_under_policy";
    reasonCodes = ["healthy_independent_frontiers_exhausted", "qualified_inventory_below_target"];
  } else if (
    input.eligibleEstimateLower === null
    || input.eligibleEstimateUpper === null
  ) {
    state = "unknown";
    reasonCodes = ["insufficient_inventory_coverage"];
  } else if (
    input.eligibleEstimateLower >= input.targetTrackCount
    && input.eligibleEstimateUpper >= requiredInventoryCount
  ) {
    state = "likely";
    reasonCodes = input.eligibleEstimateLower >= requiredInventoryCount
      ? ["conservative_inventory_covers_target_and_reserve"]
      : ["conservative_inventory_covers_target", "projected_inventory_covers_reserve"];
  } else {
    state = "at_risk";
    reasonCodes = input.eligibleEstimateUpper < input.targetTrackCount
      ? ["projected_inventory_below_target"]
      : input.eligibleEstimateUpper < requiredInventoryCount
        ? ["projected_inventory_below_reserve"]
        : ["conservative_inventory_below_target"];
  }

  const body = {
    schemaVersion: 1 as const,
    policyVersion: PLAYLIST_FEASIBILITY_POLICY_VERSION,
    contractRevisionId: input.contractRevisionId,
    contractSemanticHash: input.contractSemanticHash,
    state,
    targetTrackCount: input.targetTrackCount,
    reserveTrackCount,
    requiredInventoryCount,
    eligibleEstimateLower: input.eligibleEstimateLower,
    eligibleEstimateUpper: input.eligibleEstimateUpper,
    dependencyHealth: input.dependencyHealth,
    reasonCodes: normalizedUnique(reasonCodes),
    limitingPredicateIds,
    frontierProof,
    runtimeEvidence: input.runtimeEvidence ?? null,
  };
  return {
    ...body,
    reportHash: sha256Hex(stableStringify(body)),
  };
}

function runtimeFrontierStatus(
  input: PlaylistRuntimeFeasibilityInputV1["strategies"][number],
): PlaylistFeasibilityFrontierV1["status"] {
  if (input.status === "exhausted") return "complete";
  if (input.status === "available" || input.status === "running") {
    return input.rounds > 0 ? "active" : "not_started";
  }
  return "unavailable";
}

function runtimeDependencyHealth(
  input: PlaylistRuntimeFeasibilityInputV1,
): PlaylistFeasibilityDependencyHealthV1 {
  if (input.dependencyOutages.some((outage) => outage.active && outage.circuitOpen)
    || input.strategies.some((strategy) => strategy.status === "circuit_open")) {
    return "unavailable";
  }
  if (input.dependencyOutages.some((outage) => outage.active)
    || input.strategies.some((strategy) => strategy.status === "provider_error")) {
    return "degraded";
  }
  return "healthy";
}

function runtimeBudgetExhausted(stopReason: string): boolean {
  return [
    "frontier_exhausted",
    "budget_reached",
    "deadline_reached",
    "maximum_rounds_reached",
    "maximum_candidates_reached",
  ].includes(stopReason);
}

/**
 * Convert the actual V3 retrieval ledger into the same immutable feasibility
 * report used by guidance. Observed counts are never promoted to open-world
 * inventory estimates unless they already cover the requested count.
 */
export function assessPlaylistRuntimeFeasibilityV1(
  input: PlaylistRuntimeFeasibilityInputV1,
): PlaylistFeasibilityReportV1 {
  const frontiers: PlaylistFeasibilityFrontierV1[] = input.strategies.map(
    (strategy) => {
      const dependencyKeys = normalizedUnique(strategy.discoveryDependencyIds);
      return {
        id: strategy.id,
        dependencyKey: dependencyKeys.join("+") || "orchestration_local",
        dependencyKeys,
        status: runtimeFrontierStatus(strategy),
        discoveredCount: strategy.rawCandidates,
        qualifiedCount: strategy.newQualifiedFamilies,
      };
    },
  );
  const dependencyHealth = runtimeDependencyHealth(input);
  const activeResearchBudgetExhausted = runtimeBudgetExhausted(input.stopReason);
  const materialFrontiers = frontiers
    .filter((frontier) => !frontier.dependencyKeys?.includes("orchestration_local"));
  const everyMaterialFrontierComplete = materialFrontiers.length > 0
    && materialFrontiers.every((frontier) => frontier.status === "complete");
  const fixedContainerResolution = input.strategies
    .map((strategy) => strategy.fixedContainerResolution ?? null)
    .find((proof): proof is FixedContainerResolutionProofV1 => proof !== null)
    ?? null;
  const fixedContainerClosedSetProven = input.scope === "closed_set"
    && fixedContainerResolutionProvesClosedSetV1(
      fixedContainerResolution,
      input.contractSemanticHash,
    );
  const closedSetCapacity = input.scope === "closed_set"
    && fixedContainerClosedSetProven
    && everyMaterialFrontierComplete
    && activeResearchBudgetExhausted
    ? input.storefrontSafeCount
    : null;
  const observedInventoryCoversTarget =
    input.storefrontSafeCount >= input.targetTrackCount;
  const eligibleEstimateLower = observedInventoryCoversTarget
    || closedSetCapacity !== null
    ? input.storefrontSafeCount
    : null;
  const eligibleEstimateUpper = observedInventoryCoversTarget
    || closedSetCapacity !== null
    ? input.storefrontSafeCount
    : null;
  const observedStrategyRounds = input.strategies.reduce(
    (total, strategy) => total + strategy.rounds,
    0,
  );
  const runtimeEvidence: PlaylistRuntimeFeasibilityEvidenceV1 = {
    source: "pipeline_v3_retrieval",
    uniqueCandidateCount: Math.max(
      0,
      Math.floor(input.uniqueCandidateCount ?? input.discoveredCount),
    ),
    discoveredCount: input.discoveredCount,
    qualifiedCount: input.qualifiedCount,
    storefrontSafeCount: input.storefrontSafeCount,
    activeResearchBudgetExhausted,
    dependencyOutages: input.dependencyOutages.map((outage) => ({
      dependencyKey: outage.dependencyId,
      active: outage.active,
      circuitOpen: outage.circuitOpen,
      failureAttempts: outage.failureAttempts,
      affectedFrontierIds: normalizedUnique(outage.affectedStrategyIds),
    })).sort((left, right) => left.dependencyKey.localeCompare(right.dependencyKey)),
    frontiers,
    budgets: {
      ...input.budgets,
      stopReason: input.stopReason,
      observedStrategyRounds,
      deadlineReached: input.stopReason === "deadline_reached",
    },
    fixedContainerResolution,
  };
  return assessPlaylistFeasibilityV1({
    contractRevisionId: input.contractRevisionId,
    contractSemanticHash: input.contractSemanticHash,
    targetTrackCount: input.targetTrackCount,
    scope: input.scope,
    phase: "bounded_research",
    dependencyHealth,
    eligibleEstimateLower,
    eligibleEstimateUpper,
    closedSetCapacity,
    discoveredCount: input.discoveredCount,
    qualifiedCount: input.qualifiedCount,
    storefrontSafeCount: input.storefrontSafeCount,
    contradictions: input.contradictions,
    limitingPredicateIds: input.limitingPredicateIds,
    frontiers,
    activeResearchBudgetExhausted,
    policyVersions: input.policyVersions,
    runtimeEvidence,
  });
}

export function playlistRuntimeNoCompatibleDispositionV1(input: {
  report: PlaylistFeasibilityReportV1;
  scope: "open_world" | "closed_set";
}): PlaylistRuntimeNoCompatibleDispositionV1 {
  if (input.report.dependencyHealth !== "healthy") return "dependency_pause";
  const evidence = input.report.runtimeEvidence;
  if (evidence && playlistCoverageAuditReasonV1({
    uniqueCandidateCount:
      evidence.uniqueCandidateCount ?? evidence.discoveredCount,
    qualifiedCount: evidence.qualifiedCount,
    storefrontSafeCount: evidence.storefrontSafeCount,
    targetTrackCount: input.report.targetTrackCount,
  })) {
    return "coverage_audit";
  }
  if (input.scope === "open_world"
    && input.report.state === "frontier_exhausted_under_policy"
    && input.report.frontierProof !== null) {
    return "allow";
  }
  if (input.scope === "closed_set"
    && input.report.state === "known_ceiling"
    && input.report.runtimeEvidence?.activeResearchBudgetExhausted === true) {
    return "allow";
  }
  return "actionable_decision";
}

export function assertPlaylistFeasibilityReportIntegrityV1(
  report: PlaylistFeasibilityReportV1,
): void {
  const { reportHash, ...body } = report;
  if (!/^[a-f0-9]{64}$/u.test(reportHash)
    || sha256Hex(stableStringify(body)) !== reportHash) {
    throw new Error("invalid_playlist_feasibility_report_hash");
  }
  if (!report.runtimeEvidence
    || report.runtimeEvidence.source !== "pipeline_v3_retrieval") {
    throw new Error("runtime_feasibility_evidence_required");
  }
}
