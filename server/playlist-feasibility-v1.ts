import { sha256Hex, stableStringify } from "./security.ts";

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
  status: "not_started" | "active" | "complete" | "unavailable";
  discoveredCount: number;
  qualifiedCount: number;
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
  reportHash: string;
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
  }
}

function buildFrontierProof(
  input: PlaylistFeasibilityObservationV1,
): PlaylistFeasibilityFrontierProofV1 | null {
  const completed = input.frontiers.filter((frontier) => frontier.status === "complete");
  const dependencyKeys = normalizedUnique(completed.map((frontier) => frontier.dependencyKey));
  if (
    input.phase !== "bounded_research"
    || !input.activeResearchBudgetExhausted
    || input.dependencyHealth !== "healthy"
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
  };
  return {
    ...body,
    reportHash: sha256Hex(stableStringify(body)),
  };
}
