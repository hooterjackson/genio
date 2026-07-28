import { AsyncLocalStorage } from "node:async_hooks";

export const PLAYLIST_OPTIMIZER_POLICY_VERSION = "playlist_optimizer_v2" as const;

export interface PlaylistOptimizationCandidateV1 {
  id: string;
  recordingFamilyKey: string;
  /** Immutable position supplied by a fixed/source-ordered container. */
  sourceOrder: number;
  artistKey: string;
  albumKey: string | null;
  relevanceScore: number;
  familiarityScore: number | null;
  discoveryScore: number | null;
  eraKeys: readonly string[];
  sceneKeys: readonly string[];
  geographyKeys: readonly string[];
  sourceKeys: readonly string[];
  dependencyKeys: readonly string[];
  cacheOrigin:
    | "live"
    | "fresh_cache"
    | "governed_snapshot"
    | "orchestration_local"
    | "unknown";
  energy: number | null;
  tempo: number | null;
  chronologyPosition: number | null;
  centralQualityVerdict: "pass" | "fail" | "unknown";
  /**
   * Canonical playlist quota rules this already-qualified track satisfies.
   * Optional only for legacy callers; canonical V3 always supplies it.
   */
  canonicalQuotaRuleIds?: readonly string[];
}

export interface PlaylistOptimizationQuotaConstraintV1 {
  readonly id: string;
  readonly minimumCount: number;
  readonly maximumCount: number;
}

export interface PlaylistOptimizationConstraintsV1 {
  targetTrackCount: number;
  maximumTracksPerArtist: number | null;
  maximumTracksPerAlbum: number | null;
  maximumTracksPerSource: number | null;
  maximumTracksPerDependency: number | null;
  maximumFreshCacheTracks: number | null;
  minimumDistinctArtists: number;
  minimumDistinctAlbums: number;
  minimumDistinctEras: number;
  minimumDistinctScenes: number;
  minimumDistinctGeographies: number;
  minimumFamiliarTracks: number;
  maximumFamiliarTracks: number;
  minimumCentralQualityPassTracks: number;
  maximumCentralQualityUnknownTracks: number;
  zeroCentralQualityFailures: boolean;
  /** Count bounds derived from immutable canonical quota rules at the target size. */
  canonicalQuotaRules?: readonly PlaylistOptimizationQuotaConstraintV1[];
  sequencingMode: "editorial" | "smooth" | "contrast" | "chronological" | "source_order";
  avoidAdjacentSameArtist: boolean;
  avoidAdjacentSameAlbum: boolean;
}

export interface PlaylistOptimizationResultV1 {
  policyVersion: typeof PLAYLIST_OPTIMIZER_POLICY_VERSION;
  exact: boolean;
  selected: PlaylistOptimizationCandidateV1[];
  unmetConstraints: string[];
  distinct: {
    artists: number;
    albums: number;
    eras: number;
    scenes: number;
    geographies: number;
  };
  familiarTrackCount: number;
}

export interface PlaylistOptimizationBudgetV1 {
  /**
   * Deterministic work allowance for the bounded beam. Work units count
   * candidate rows inspected, rather than wall-clock time, so replaying the
   * same immutable contract cannot change the result with machine load.
   */
  maximumHeuristicWorkUnits?: number;
  /** Maximum exact-search states visited after a heuristic miss. */
  maximumExactNodes?: number;
  /** Candidate rows inspected by the exact rescue. */
  maximumExactWorkUnits?: number;
}

export class PlaylistOptimizationBudgetExceededErrorV1 extends Error {
  readonly name = "PlaylistOptimizationBudgetExceededErrorV1";
  readonly code = "optimizer_search_budget_exhausted";
}

type CoverageAxis = "eraKeys" | "sceneKeys" | "geographyKeys";

const FAMILIARITY_THRESHOLD = 0.6;
const SMALL_PLAYLIST_BEAM_WIDTH = 16;
// A single greedy path can strand two individually reachable coverage axes:
// the optimistic feasibility guard proves each axis separately, but cannot
// prove that one remaining track covers both. Retain a bounded portfolio for
// large pools so a high-scoring trap cannot manufacture a false shortfall.
const LARGE_PLAYLIST_BEAM_WIDTH = 8;
const SMALL_PLAYLIST_BRANCH_WIDTH = 6;
const LARGE_PLAYLIST_BRANCH_WIDTH = 6;
const DEFAULT_HEURISTIC_WORK_BUDGET = 30_000_000;
const DEFAULT_EXACT_NODE_BUDGET = 300_000;
const DEFAULT_EXACT_WORK_BUDGET = 20_000_000;
const MAXIMUM_AUTOMATIC_OPTIMIZER_BUDGET_PASS = 2;
const optimizerBudgetContext =
  new AsyncLocalStorage<PlaylistOptimizationBudgetV1>();

/**
 * A successor lease may spend one larger, still-deterministic pass after the
 * default optimizer budget is exhausted. The pass number is persisted by the
 * worker; AsyncLocalStorage carries it through the retrieval port without
 * changing the immutable query plan or sharing state between concurrent runs.
 */
export function playlistOptimizationBudgetForPassV1(
  pass: number,
): Required<PlaylistOptimizationBudgetV1> {
  if (!Number.isSafeInteger(pass)
    || pass < 1
    || pass > MAXIMUM_AUTOMATIC_OPTIMIZER_BUDGET_PASS) {
    throw new Error("invalid_playlist_optimization_budget_pass");
  }
  const multiplier = pass;
  return {
    maximumHeuristicWorkUnits: DEFAULT_HEURISTIC_WORK_BUDGET * multiplier,
    maximumExactNodes: DEFAULT_EXACT_NODE_BUDGET * multiplier,
    maximumExactWorkUnits: DEFAULT_EXACT_WORK_BUDGET * multiplier,
  };
}

export function withPlaylistOptimizationBudgetV1<T>(
  budget: PlaylistOptimizationBudgetV1,
  operation: () => T,
): T {
  return optimizerBudgetContext.run({ ...budget }, operation);
}

function boundedScore(value: number | null, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function keys(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function candidate(input: PlaylistOptimizationCandidateV1): PlaylistOptimizationCandidateV1 {
  if (!input.id.trim() || !input.recordingFamilyKey.trim() || !input.artistKey.trim()) {
    throw new Error("invalid_playlist_optimization_candidate");
  }
  const sourceKeys = keys(input.sourceKeys);
  const dependencyKeys = keys(input.dependencyKeys);
  return {
    ...input,
    id: input.id.trim(),
    recordingFamilyKey: input.recordingFamilyKey.trim(),
    sourceOrder: Number.isSafeInteger(input.sourceOrder) && input.sourceOrder >= 0
      ? input.sourceOrder
      : Number.MAX_SAFE_INTEGER,
    artistKey: input.artistKey.trim(),
    albumKey: input.albumKey?.trim() || null,
    relevanceScore: boundedScore(input.relevanceScore),
    familiarityScore: input.familiarityScore === null
      ? null
      : boundedScore(input.familiarityScore),
    discoveryScore: input.discoveryScore === null
      ? null
      : boundedScore(input.discoveryScore),
    eraKeys: keys(input.eraKeys),
    sceneKeys: keys(input.sceneKeys),
    geographyKeys: keys(input.geographyKeys),
    // Missing provenance must share one conservative bucket. Empty arrays
    // otherwise consume no concentration capacity and can silently evade the
    // source/dependency caps.
    sourceKeys: sourceKeys.length > 0 ? sourceKeys : ["__unattributed_source"],
    dependencyKeys: dependencyKeys.length > 0
      ? dependencyKeys
      : ["__unattributed_dependency"],
    cacheOrigin: [
      "live", "fresh_cache", "governed_snapshot", "orchestration_local", "unknown",
    ].includes(input.cacheOrigin)
      ? input.cacheOrigin
      : "unknown",
    energy: input.energy === null ? null : boundedScore(input.energy),
    tempo: input.tempo === null ? null : boundedScore(input.tempo),
    chronologyPosition: input.chronologyPosition === null
      || !Number.isFinite(input.chronologyPosition)
      ? null
      : input.chronologyPosition,
    centralQualityVerdict: ["pass", "fail", "unknown"].includes(input.centralQualityVerdict)
      ? input.centralQualityVerdict
      : "unknown",
    canonicalQuotaRuleIds: keys(input.canonicalQuotaRuleIds ?? []),
  };
}

function validateConstraints(input: PlaylistOptimizationConstraintsV1): void {
  const integers = [
    input.targetTrackCount,
    input.minimumDistinctArtists,
    input.minimumDistinctAlbums,
    input.minimumDistinctEras,
    input.minimumDistinctScenes,
    input.minimumDistinctGeographies,
    input.minimumFamiliarTracks,
    input.maximumFamiliarTracks,
    input.minimumCentralQualityPassTracks,
    input.maximumCentralQualityUnknownTracks,
  ];
  if (integers.some((value) => !Number.isSafeInteger(value) || value < 0)
    || input.targetTrackCount < 1
    || input.minimumFamiliarTracks > input.maximumFamiliarTracks
    || input.maximumFamiliarTracks > input.targetTrackCount
    || input.minimumCentralQualityPassTracks > input.targetTrackCount
    || input.maximumCentralQualityUnknownTracks > input.targetTrackCount) {
    throw new Error("invalid_playlist_optimization_constraints");
  }
  for (const maximum of [
    input.maximumTracksPerArtist,
    input.maximumTracksPerAlbum,
    input.maximumTracksPerSource,
    input.maximumTracksPerDependency,
    input.maximumFreshCacheTracks,
  ]) {
    if (maximum !== null && (!Number.isSafeInteger(maximum) || maximum < 1)) {
      throw new Error("invalid_playlist_optimization_constraints");
    }
  }
  const quotaRules = input.canonicalQuotaRules ?? [];
  if (new Set(quotaRules.map(({ id }) => id)).size !== quotaRules.length
    || quotaRules.some(({ id, minimumCount, maximumCount }) => (
      !id.trim()
      || !Number.isSafeInteger(minimumCount)
      || !Number.isSafeInteger(maximumCount)
      || minimumCount < 0
      || maximumCount < 0
      || minimumCount > maximumCount
      || maximumCount > input.targetTrackCount
    ))) {
    throw new Error("invalid_playlist_optimization_constraints");
  }
}

function isFamiliar(value: PlaylistOptimizationCandidateV1): boolean {
  return boundedScore(value.familiarityScore) >= FAMILIARITY_THRESHOLD;
}

function baseUtility(value: PlaylistOptimizationCandidateV1): number {
  return (boundedScore(value.relevanceScore) * 1_000)
    + (boundedScore(value.discoveryScore) * 100)
    + (boundedScore(value.familiarityScore) * 10);
}

function compareCandidate(
  left: PlaylistOptimizationCandidateV1,
  right: PlaylistOptimizationCandidateV1,
): number {
  return baseUtility(right) - baseUtility(left) || left.id.localeCompare(right.id);
}

function normalizedCandidateRepresentations(
  input: readonly PlaylistOptimizationCandidateV1[],
): PlaylistOptimizationCandidateV1[] {
  const bestById = new Map<string, PlaylistOptimizationCandidateV1>();
  for (const value of input.map(candidate)) {
    const existing = bestById.get(value.id);
    if (!existing || compareCandidate(value, existing) < 0) {
      bestById.set(value.id, value);
    }
  }
  // Do not collapse alternate catalog/evidence representations of the same
  // recording family before joint optimization. A lower-ranked representation
  // can carry the only source, dependency, quota, or catalog binding that makes
  // the immutable playlist constraints jointly feasible. SelectionContext
  // enforces one representation per recording family in the final set.
  return [...bestById.values()].sort(compareCandidate);
}

function countBy(values: readonly PlaylistOptimizationCandidateV1[], field: "artistKey" | "albumKey"): Map<string, number> {
  const output = new Map<string, number>();
  for (const value of values) {
    const key = value[field];
    if (!key) continue;
    output.set(key, (output.get(key) ?? 0) + 1);
  }
  return output;
}

function distinctKeys(
  values: readonly PlaylistOptimizationCandidateV1[],
  field: CoverageAxis,
): Set<string> {
  return new Set(values.flatMap((value) => value[field]));
}

interface SelectionContext {
  artistCounts: Map<string, number>;
  albumCounts: Map<string, number>;
  sourceCounts: Map<string, number>;
  dependencyCounts: Map<string, number>;
  freshCacheCount: number;
  artists: Set<string>;
  albums: Set<string>;
  recordingFamilies: Set<string>;
  covered: Record<CoverageAxis, Set<string>>;
  familiarCount: number;
  centralQualityPassCount: number;
  centralQualityUnknownCount: number;
  canonicalQuotaCounts: Map<string, number>;
}

function selectionContext(
  selected: readonly PlaylistOptimizationCandidateV1[],
): SelectionContext {
  return {
    artistCounts: countBy(selected, "artistKey"),
    albumCounts: countBy(selected, "albumKey"),
    sourceCounts: countKeys(selected, "sourceKeys"),
    dependencyCounts: countKeys(selected, "dependencyKeys"),
    freshCacheCount: selected.filter(({ cacheOrigin }) => (
      cacheOrigin === "fresh_cache" || cacheOrigin === "unknown"
    )).length,
    artists: new Set(selected.map(({ artistKey }) => artistKey)),
    albums: new Set(selected.flatMap(({ albumKey }) => albumKey ? [albumKey] : [])),
    recordingFamilies: new Set(selected.map(({ recordingFamilyKey }) => recordingFamilyKey)),
    covered: {
      eraKeys: distinctKeys(selected, "eraKeys"),
      sceneKeys: distinctKeys(selected, "sceneKeys"),
      geographyKeys: distinctKeys(selected, "geographyKeys"),
    },
    familiarCount: selected.filter(isFamiliar).length,
    centralQualityPassCount: selected.filter(
      ({ centralQualityVerdict }) => centralQualityVerdict === "pass",
    ).length,
    centralQualityUnknownCount: selected.filter(
      ({ centralQualityVerdict }) => centralQualityVerdict === "unknown",
    ).length,
    canonicalQuotaCounts: countCanonicalQuotaRules(selected),
  };
}

function countKeys(
  values: readonly PlaylistOptimizationCandidateV1[],
  field: "sourceKeys" | "dependencyKeys",
): Map<string, number> {
  const output = new Map<string, number>();
  for (const value of values) {
    for (const key of value[field]) {
      output.set(key, (output.get(key) ?? 0) + 1);
    }
  }
  return output;
}

function countCanonicalQuotaRules(
  values: readonly PlaylistOptimizationCandidateV1[],
): Map<string, number> {
  const output = new Map<string, number>();
  for (const value of values) {
    for (const ruleId of value.canonicalQuotaRuleIds ?? []) {
      output.set(ruleId, (output.get(ruleId) ?? 0) + 1);
    }
  }
  return output;
}

function canAddWithContext(
  value: PlaylistOptimizationCandidateV1,
  context: SelectionContext,
  constraints: PlaylistOptimizationConstraintsV1,
): boolean {
  return !context.recordingFamilies.has(value.recordingFamilyKey)
    && (constraints.maximumTracksPerArtist === null
      || (context.artistCounts.get(value.artistKey) ?? 0) < constraints.maximumTracksPerArtist)
    && (constraints.maximumTracksPerAlbum === null
      || value.albumKey === null
      || (context.albumCounts.get(value.albumKey) ?? 0) < constraints.maximumTracksPerAlbum)
    && (constraints.maximumTracksPerSource === null
      || value.sourceKeys.every((key) => (
        (context.sourceCounts.get(key) ?? 0) < constraints.maximumTracksPerSource!
      )))
    && (constraints.maximumTracksPerDependency === null
      || value.dependencyKeys.every((key) => (
        (context.dependencyCounts.get(key) ?? 0)
          < constraints.maximumTracksPerDependency!
      )))
    && (constraints.maximumFreshCacheTracks === null
      || (value.cacheOrigin !== "fresh_cache" && value.cacheOrigin !== "unknown")
      || context.freshCacheCount < constraints.maximumFreshCacheTracks)
    && (constraints.canonicalQuotaRules ?? []).every((rule) => (
      !(value.canonicalQuotaRuleIds ?? []).includes(rule.id)
      || (context.canonicalQuotaCounts.get(rule.id) ?? 0) < rule.maximumCount
    ));
}

function requirements(input: PlaylistOptimizationConstraintsV1): Record<CoverageAxis, number> {
  return {
    eraKeys: input.minimumDistinctEras,
    sceneKeys: input.minimumDistinctScenes,
    geographyKeys: input.minimumDistinctGeographies,
  };
}

function coverageGain(
  value: PlaylistOptimizationCandidateV1,
  context: SelectionContext,
  constraints: PlaylistOptimizationConstraintsV1,
): number {
  const required = requirements(constraints);
  const axisGain = (Object.keys(required) as CoverageAxis[]).reduce((sum, axis) => {
    const covered = context.covered[axis];
    if (covered.size >= required[axis]) return sum;
    return sum + value[axis].filter((key) => !covered.has(key)).length;
  }, 0);
  const artistGain = !context.artists.has(value.artistKey)
    && context.artists.size < constraints.minimumDistinctArtists
    ? 1
    : 0;
  const albumGain = value.albumKey
    && !context.albums.has(value.albumKey)
    && context.albums.size < constraints.minimumDistinctAlbums
    ? 1
    : 0;
  const quotaGain = (constraints.canonicalQuotaRules ?? []).filter((rule) => (
    (value.canonicalQuotaRuleIds ?? []).includes(rule.id)
    && (context.canonicalQuotaCounts.get(rule.id) ?? 0) < rule.minimumCount
  )).length;
  return axisGain + artistGain + Number(albumGain) + quotaGain;
}

/**
 * Exact constant-time check for the static minima when `value` would occupy
 * the final immutable slot. The general optimistic feasibility guard treats
 * each coverage axis independently, which is correct while several slots
 * remain but can make the exact rescue evaluate thousands of terminal sets
 * that one last track cannot jointly complete.
 */
function completesStaticMinimums(
  value: PlaylistOptimizationCandidateV1,
  context: SelectionContext,
  constraints: PlaylistOptimizationConstraintsV1,
): boolean {
  if (context.artists.size + Number(!context.artists.has(value.artistKey))
    < constraints.minimumDistinctArtists) {
    return false;
  }
  if (context.albums.size + Number(
    value.albumKey !== null && !context.albums.has(value.albumKey),
  ) < constraints.minimumDistinctAlbums) {
    return false;
  }
  const required = requirements(constraints);
  for (const axis of Object.keys(required) as CoverageAxis[]) {
    let possible = context.covered[axis].size;
    for (const key of value[axis]) {
      if (!context.covered[axis].has(key)) possible += 1;
    }
    if (possible < required[axis]) return false;
  }
  return (constraints.canonicalQuotaRules ?? []).every((rule) => (
    (context.canonicalQuotaCounts.get(rule.id) ?? 0)
      + Number((value.canonicalQuotaRuleIds ?? []).includes(rule.id))
      >= rule.minimumCount
  ));
}

function selectionUtility(
  value: PlaylistOptimizationCandidateV1,
  selected: readonly PlaylistOptimizationCandidateV1[],
  constraints: PlaylistOptimizationConstraintsV1,
  context = selectionContext(selected),
): number {
  const familiarCount = context.familiarCount;
  const centralQualityPassCount = context.centralQualityPassCount;
  const centralQualityUnknownCount = context.centralQualityUnknownCount;
  const remainingAfter = constraints.targetTrackCount - selected.length - 1;
  const familiarNeededAfter = Math.max(
    0,
    constraints.minimumFamiliarTracks - familiarCount - (isFamiliar(value) ? 1 : 0),
  );
  if (familiarNeededAfter > remainingAfter) return Number.NEGATIVE_INFINITY;
  if (isFamiliar(value) && familiarCount >= constraints.maximumFamiliarTracks) {
    return Number.NEGATIVE_INFINITY;
  }
  if (constraints.zeroCentralQualityFailures && value.centralQualityVerdict === "fail") {
    return Number.NEGATIVE_INFINITY;
  }
  if (constraints.sequencingMode === "chronological"
    && value.chronologyPosition === null) {
    return Number.NEGATIVE_INFINITY;
  }
  const qualityPassNeededAfter = Math.max(
    0,
    constraints.minimumCentralQualityPassTracks
      - centralQualityPassCount
      - (value.centralQualityVerdict === "pass" ? 1 : 0),
  );
  if (qualityPassNeededAfter > remainingAfter) return Number.NEGATIVE_INFINITY;
  if (value.centralQualityVerdict === "unknown"
    && centralQualityUnknownCount >= constraints.maximumCentralQualityUnknownTracks) {
    return Number.NEGATIVE_INFINITY;
  }
  const newArtist = context.artists.has(value.artistKey) ? 0 : 1;
  const newAlbum = value.albumKey
    && !context.albums.has(value.albumKey) ? 1 : 0;
  return baseUtility(value)
    + coverageGain(value, context, constraints) * 1_000_000
    + newArtist * 1_000
    + Number(newAlbum) * 300;
}

function remainingCapacityBy(
  selected: readonly PlaylistOptimizationCandidateV1[],
  remaining: readonly PlaylistOptimizationCandidateV1[],
  field: "artistKey" | "albumKey",
  maximum: number | null,
): number {
  if (maximum === null) return remaining.length;
  const selectedCounts = countBy(selected, field);
  const remainingCounts = countBy(remaining, field);
  let capacity = field === "albumKey"
    ? remaining.filter(({ albumKey }) => albumKey === null).length
    : 0;
  for (const [key, count] of remainingCounts) {
    capacity += Math.min(count, Math.max(0, maximum - (selectedCounts.get(key) ?? 0)));
  }
  return capacity;
}

/**
 * Optimistic upper bound for a cap whose candidates may consume several keys.
 *
 * It deliberately ignores cross-key assignment interactions, so it can never
 * reject a feasible set. It does account for both the total residual capacity
 * consumed by multi-key candidates and the residual capacity of each
 * individual key. This prevents a greedy path from using one extra
 * multi-source/dependency candidate and stranding an otherwise feasible exact
 * large playlist.
 */
function remainingCapacityByKeys(
  selected: readonly PlaylistOptimizationCandidateV1[],
  remaining: readonly PlaylistOptimizationCandidateV1[],
  field: "sourceKeys" | "dependencyKeys",
  maximum: number | null,
): number {
  if (maximum === null) return remaining.length;
  const selectedCounts = countKeys(selected, field);
  const remainingCounts = countKeys(remaining, field);
  let totalResidualCapacity = 0;
  let upperBound = remaining.length;
  for (const [key, candidatesUsingKey] of remainingCounts) {
    const residual = Math.max(0, maximum - (selectedCounts.get(key) ?? 0));
    totalResidualCapacity += residual;
    const candidatesNotUsingKey = remaining.length - candidatesUsingKey;
    upperBound = Math.min(upperBound, candidatesNotUsingKey + residual);
  }
  const demands = remaining
    .map((value) => Math.max(1, value[field].length))
    .sort((left, right) => left - right);
  let consumed = 0;
  let totalCapacityBound = 0;
  for (const demand of demands) {
    if (consumed + demand > totalResidualCapacity) break;
    consumed += demand;
    totalCapacityBound += 1;
  }
  return Math.min(upperBound, totalCapacityBound);
}

/**
 * Cheap optimistic feasibility check used while exploring selections.
 *
 * It deliberately never claims impossibility from interactions it cannot
 * prove. Instead, it prevents a locally attractive pick from consuming the
 * last slot/capacity needed by an immutable count, quality, familiarity, or
 * diversity requirement. A bounded beam then retains alternative set
 * compositions for the intersecting requirements that this check treats
 * optimistically.
 */
function canStillSatisfy(
  selected: readonly PlaylistOptimizationCandidateV1[],
  remaining: readonly PlaylistOptimizationCandidateV1[],
  constraints: PlaylistOptimizationConstraintsV1,
): boolean {
  const slots = constraints.targetTrackCount - selected.length;
  if (slots < 0) return false;
  const context = selectionContext(selected);
  const eligible = remaining.filter((value) => (
    canAddWithContext(value, context, constraints)
    && (!constraints.zeroCentralQualityFailures || value.centralQualityVerdict !== "fail")
    && (constraints.sequencingMode !== "chronological" || value.chronologyPosition !== null)
  ));
  if (eligible.length < slots) return false;
  if (remainingCapacityBy(
    selected,
    eligible,
    "artistKey",
    constraints.maximumTracksPerArtist,
  ) < slots) return false;
  if (remainingCapacityBy(
    selected,
    eligible,
    "albumKey",
    constraints.maximumTracksPerAlbum,
  ) < slots) return false;
  if (remainingCapacityByKeys(
    selected,
    eligible,
    "sourceKeys",
    constraints.maximumTracksPerSource,
  ) < slots) return false;
  if (remainingCapacityByKeys(
    selected,
    eligible,
    "dependencyKeys",
    constraints.maximumTracksPerDependency,
  ) < slots) return false;
  if (constraints.maximumFreshCacheTracks !== null) {
    const selectedFreshCache = selected.filter(({ cacheOrigin }) => (
      cacheOrigin === "fresh_cache" || cacheOrigin === "unknown"
    )).length;
    const residualFreshCache = Math.max(
      0,
      constraints.maximumFreshCacheTracks - selectedFreshCache,
    );
    const eligibleLive = eligible.filter(({ cacheOrigin }) => (
      cacheOrigin !== "fresh_cache" && cacheOrigin !== "unknown"
    )).length;
    const eligibleFreshCache = eligible.length - eligibleLive;
    if (eligibleLive + Math.min(eligibleFreshCache, residualFreshCache) < slots) {
      return false;
    }
  }

  const selectedArtists = new Set(selected.map(({ artistKey }) => artistKey));
  const possibleArtists = new Set([
    ...selectedArtists,
    ...eligible.map(({ artistKey }) => artistKey),
  ]);
  const selectedAlbums = new Set(selected.flatMap(
    ({ albumKey }) => albumKey ? [albumKey] : [],
  ));
  const possibleAlbums = new Set([
    ...selectedAlbums,
    ...eligible.flatMap(({ albumKey }) => albumKey ? [albumKey] : []),
  ]);
  if (possibleArtists.size < constraints.minimumDistinctArtists
    || constraints.minimumDistinctArtists - selectedArtists.size > slots
    || possibleAlbums.size < constraints.minimumDistinctAlbums
    || constraints.minimumDistinctAlbums - selectedAlbums.size > slots) {
    return false;
  }
  const required = requirements(constraints);
  for (const axis of Object.keys(required) as CoverageAxis[]) {
    const covered = distinctKeys(selected, axis);
    const possible = new Set([...covered, ...eligible.flatMap((value) => value[axis])]);
    if (possible.size < required[axis] || required[axis] - covered.size > slots) {
      return false;
    }
  }

  const familiar = selected.filter(isFamiliar).length;
  const eligibleFamiliar = eligible.filter(isFamiliar).length;
  const eligibleUnfamiliar = eligible.length - eligibleFamiliar;
  const forcedFamiliar = Math.max(0, slots - eligibleUnfamiliar);
  if (familiar > constraints.maximumFamiliarTracks
    || familiar + Math.min(slots, eligibleFamiliar) < constraints.minimumFamiliarTracks
    || familiar + forcedFamiliar > constraints.maximumFamiliarTracks) {
    return false;
  }

  const selectedQuotaCounts = countCanonicalQuotaRules(selected);
  for (const rule of constraints.canonicalQuotaRules ?? []) {
    const observed = selectedQuotaCounts.get(rule.id) ?? 0;
    if (observed > rule.maximumCount) return false;
    const matching = eligible.filter(({ canonicalQuotaRuleIds = [] }) => (
      canonicalQuotaRuleIds.includes(rule.id)
    )).length;
    const nonMatching = eligible.length - matching;
    const forcedAdditionalMatches = Math.max(0, slots - nonMatching);
    if (observed + Math.min(slots, matching) < rule.minimumCount
      || observed + forcedAdditionalMatches > rule.maximumCount) {
      return false;
    }
  }

  const passing = selected.filter(
    ({ centralQualityVerdict }) => centralQualityVerdict === "pass",
  ).length;
  const eligiblePassing = eligible.filter(
    ({ centralQualityVerdict }) => centralQualityVerdict === "pass",
  ).length;
  const unknown = selected.filter(
    ({ centralQualityVerdict }) => centralQualityVerdict === "unknown",
  ).length;
  const eligibleKnown = eligible.filter(
    ({ centralQualityVerdict }) => centralQualityVerdict !== "unknown",
  ).length;
  const forcedUnknown = Math.max(0, slots - eligibleKnown);
  return passing + Math.min(slots, eligiblePassing)
      >= constraints.minimumCentralQualityPassTracks
    && unknown + forcedUnknown <= constraints.maximumCentralQualityUnknownTracks;
}

interface SelectionState {
  selected: PlaylistOptimizationCandidateV1[];
  selectedIds: Set<string>;
}

interface OptimizationBudgetCounter {
  heuristicWorkRemaining: number;
  exactNodesRemaining: number;
  exactWorkRemaining: number;
}

type OptimizationBudgetLane = "heuristic" | "exact";

function boundedBudget(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("invalid_playlist_optimization_budget");
  }
  return value;
}

/**
 * Read the deterministic allowance for sibling canonical optimizers running
 * inside the same worker budget pass. Callers receive values only, never the
 * mutable core-optimizer counters.
 */
export function activePlaylistOptimizationBudgetV1(): Required<PlaylistOptimizationBudgetV1> {
  const configured = optimizerBudgetContext.getStore();
  return {
    maximumHeuristicWorkUnits: boundedBudget(
      configured?.maximumHeuristicWorkUnits,
      DEFAULT_HEURISTIC_WORK_BUDGET,
    ),
    maximumExactNodes: boundedBudget(
      configured?.maximumExactNodes,
      DEFAULT_EXACT_NODE_BUDGET,
    ),
    maximumExactWorkUnits: boundedBudget(
      configured?.maximumExactWorkUnits,
      DEFAULT_EXACT_WORK_BUDGET,
    ),
  };
}

function optimizationBudget(
  input: PlaylistOptimizationBudgetV1 | undefined,
): OptimizationBudgetCounter {
  const configured = input ?? optimizerBudgetContext.getStore();
  return {
    heuristicWorkRemaining: boundedBudget(
      configured?.maximumHeuristicWorkUnits,
      DEFAULT_HEURISTIC_WORK_BUDGET,
    ),
    exactNodesRemaining: boundedBudget(
      configured?.maximumExactNodes,
      DEFAULT_EXACT_NODE_BUDGET,
    ),
    exactWorkRemaining: boundedBudget(
      configured?.maximumExactWorkUnits,
      DEFAULT_EXACT_WORK_BUDGET,
    ),
  };
}

function consumeOptimizationWork(
  budget: OptimizationBudgetCounter,
  lane: OptimizationBudgetLane,
  units: number,
): void {
  const amount = Math.max(1, Math.floor(units));
  if (lane === "heuristic") {
    budget.heuristicWorkRemaining -= amount;
    if (budget.heuristicWorkRemaining < 0) {
      throw new PlaylistOptimizationBudgetExceededErrorV1(
        "Playlist heuristic exhausted its deterministic work budget",
      );
    }
    return;
  }
  budget.exactWorkRemaining -= amount;
  if (budget.exactWorkRemaining < 0) {
    throw new PlaylistOptimizationBudgetExceededErrorV1(
      "Playlist exact rescue exhausted its deterministic work budget",
    );
  }
}

function stateProgressScore(
  selected: readonly PlaylistOptimizationCandidateV1[],
  constraints: PlaylistOptimizationConstraintsV1,
): number {
  const required = requirements(constraints);
  const coveredAxes = (Object.keys(required) as CoverageAxis[]).reduce((sum, axis) => (
    sum + Math.min(required[axis], distinctKeys(selected, axis).size)
  ), 0);
  const artists = Math.min(
    constraints.minimumDistinctArtists,
    new Set(selected.map(({ artistKey }) => artistKey)).size,
  );
  const albums = Math.min(
    constraints.minimumDistinctAlbums,
    new Set(selected.flatMap(({ albumKey }) => albumKey ? [albumKey] : [])).size,
  );
  const familiar = Math.min(
    constraints.minimumFamiliarTracks,
    selected.filter(isFamiliar).length,
  );
  const quality = Math.min(
    constraints.minimumCentralQualityPassTracks,
    selected.filter(({ centralQualityVerdict }) => centralQualityVerdict === "pass").length,
  );
  const quotaCounts = countCanonicalQuotaRules(selected);
  const quotas = (constraints.canonicalQuotaRules ?? []).reduce((sum, rule) => (
    sum + Math.min(rule.minimumCount, quotaCounts.get(rule.id) ?? 0)
  ), 0);
  return (coveredAxes + artists + albums + familiar + quality + quotas) * 1_000_000_000
    + selected.reduce((sum, value) => sum + baseUtility(value), 0);
}

function compareState(
  left: SelectionState,
  right: SelectionState,
  constraints: PlaylistOptimizationConstraintsV1,
): number {
  return stateProgressScore(right.selected, constraints)
    - stateProgressScore(left.selected, constraints)
    || left.selected.map(({ id }) => id).join("\u0000")
      .localeCompare(right.selected.map(({ id }) => id).join("\u0000"));
}

function selectionSignature(selected: readonly PlaylistOptimizationCandidateV1[]): string {
  return selected.map(({ id }) => id).sort().join("\u0000");
}

function constraintSummary(
  selected: readonly PlaylistOptimizationCandidateV1[],
  constraints: PlaylistOptimizationConstraintsV1,
  budget?: OptimizationBudgetCounter,
  lane: OptimizationBudgetLane = "heuristic",
): Pick<PlaylistOptimizationResultV1, "unmetConstraints" | "distinct" | "familiarTrackCount"> {
  if (budget) {
    const keyCount = selected.reduce((total, value) => (
      total
      + value.eraKeys.length
      + value.sceneKeys.length
      + value.geographyKeys.length
      + value.sourceKeys.length
      + value.dependencyKeys.length
      + (value.canonicalQuotaRuleIds?.length ?? 0)
    ), 0);
    // The summary performs several complete passes plus keyed-set inserts.
    // Charge them before doing the work so a terminal leaf cannot bypass the
    // deterministic budget merely by reaching sequencing/validation.
    consumeOptimizationWork(
      budget,
      lane,
      Math.max(1, selected.length * 18 + keyCount),
    );
  }
  const artists = countBy(selected, "artistKey");
  const albums = countBy(selected, "albumKey");
  const sources = countKeys(selected, "sourceKeys");
  const dependencies = countKeys(selected, "dependencyKeys");
  const freshCacheTrackCount = selected.filter(
    ({ cacheOrigin }) => cacheOrigin === "fresh_cache" || cacheOrigin === "unknown",
  ).length;
  const eras = distinctKeys(selected, "eraKeys");
  const scenes = distinctKeys(selected, "sceneKeys");
  const geographies = distinctKeys(selected, "geographyKeys");
  const familiarTrackCount = selected.filter(isFamiliar).length;
  const centralQualityPassCount = selected.filter(
    ({ centralQualityVerdict }) => centralQualityVerdict === "pass",
  ).length;
  const centralQualityUnknownCount = selected.filter(
    ({ centralQualityVerdict }) => centralQualityVerdict === "unknown",
  ).length;
  const centralQualityFailureCount = selected.filter(
    ({ centralQualityVerdict }) => centralQualityVerdict === "fail",
  ).length;
  const canonicalQuotaCounts = countCanonicalQuotaRules(selected);
  const duplicateRecordingFamily = new Set(
    selected.map(({ recordingFamilyKey }) => recordingFamilyKey),
  ).size !== selected.length;
  const unmetConstraints = [
    ...(selected.length !== constraints.targetTrackCount
      ? [`exact_count:${selected.length}/${constraints.targetTrackCount}`]
      : []),
    ...(duplicateRecordingFamily ? ["duplicate_recording_family"] : []),
    ...(artists.size < constraints.minimumDistinctArtists
      ? [`minimum_distinct_artists:${artists.size}/${constraints.minimumDistinctArtists}`]
      : []),
    ...(albums.size < constraints.minimumDistinctAlbums
      ? [`minimum_distinct_albums:${albums.size}/${constraints.minimumDistinctAlbums}`]
      : []),
    ...(eras.size < constraints.minimumDistinctEras
      ? [`minimum_distinct_eras:${eras.size}/${constraints.minimumDistinctEras}`]
      : []),
    ...(scenes.size < constraints.minimumDistinctScenes
      ? [`minimum_distinct_scenes:${scenes.size}/${constraints.minimumDistinctScenes}`]
      : []),
    ...(geographies.size < constraints.minimumDistinctGeographies
      ? [`minimum_distinct_geographies:${geographies.size}/${constraints.minimumDistinctGeographies}`]
      : []),
    ...(familiarTrackCount < constraints.minimumFamiliarTracks
      ? [`minimum_familiar_tracks:${familiarTrackCount}/${constraints.minimumFamiliarTracks}`]
      : []),
    ...(familiarTrackCount > constraints.maximumFamiliarTracks
      ? [`maximum_familiar_tracks:${familiarTrackCount}/${constraints.maximumFamiliarTracks}`]
      : []),
    ...(centralQualityPassCount < constraints.minimumCentralQualityPassTracks
      ? [
        `minimum_central_quality_pass_tracks:${centralQualityPassCount}/${constraints.minimumCentralQualityPassTracks}`,
      ]
      : []),
    ...(centralQualityUnknownCount > constraints.maximumCentralQualityUnknownTracks
      ? [
        `maximum_central_quality_unknown_tracks:${centralQualityUnknownCount}/${constraints.maximumCentralQualityUnknownTracks}`,
      ]
      : []),
    ...(constraints.zeroCentralQualityFailures && centralQualityFailureCount > 0
      ? [`central_quality_known_failures:${centralQualityFailureCount}`]
      : []),
    ...(constraints.canonicalQuotaRules ?? []).flatMap((rule) => {
      const observed = canonicalQuotaCounts.get(rule.id) ?? 0;
      return [
        ...(observed < rule.minimumCount
          ? [`canonical_quota_minimum:${rule.id}:${observed}/${rule.minimumCount}`]
          : []),
        ...(observed > rule.maximumCount
          ? [`canonical_quota_maximum:${rule.id}:${observed}/${rule.maximumCount}`]
          : []),
      ];
    }),
    ...(constraints.maximumTracksPerArtist !== null
      && [...artists.values()].some((count) => count > constraints.maximumTracksPerArtist!)
      ? ["maximum_tracks_per_artist"]
      : []),
    ...(constraints.maximumTracksPerAlbum !== null
      && [...albums.values()].some((count) => count > constraints.maximumTracksPerAlbum!)
      ? ["maximum_tracks_per_album"]
      : []),
    ...(constraints.maximumTracksPerSource !== null
      && [...sources.values()].some((count) => count > constraints.maximumTracksPerSource!)
      ? ["maximum_tracks_per_source"]
      : []),
    ...(constraints.maximumTracksPerDependency !== null
      && [...dependencies.values()].some((count) => (
        count > constraints.maximumTracksPerDependency!
      ))
      ? ["maximum_tracks_per_dependency"]
      : []),
    ...(constraints.maximumFreshCacheTracks !== null
      && freshCacheTrackCount > constraints.maximumFreshCacheTracks
      ? ["maximum_fresh_cache_tracks"]
      : []),
    ...(constraints.avoidAdjacentSameArtist
      && selected.some((value, index) => (
        index > 0 && selected[index - 1]!.artistKey === value.artistKey
      ))
      ? ["adjacent_same_artist"]
      : []),
    ...(constraints.avoidAdjacentSameAlbum
      && selected.some((value, index) => (
        index > 0
        && value.albumKey !== null
        && selected[index - 1]!.albumKey === value.albumKey
      ))
      ? ["adjacent_same_album"]
      : []),
    ...(constraints.sequencingMode === "chronological"
      && (selected.some(({ chronologyPosition }) => chronologyPosition === null)
        || selected.some((value, index) => (
          index > 0
          && Number(value.chronologyPosition)
            < Number(selected[index - 1]!.chronologyPosition)
        )))
      ? ["chronology_unproven"]
      : []),
  ];
  return {
    unmetConstraints,
    distinct: {
      artists: artists.size,
      albums: albums.size,
      eras: eras.size,
      scenes: scenes.size,
      geographies: geographies.size,
    },
    familiarTrackCount,
  };
}

function distance(
  left: PlaylistOptimizationCandidateV1,
  right: PlaylistOptimizationCandidateV1,
): number {
  const values = [
    left.energy === null || right.energy === null ? null : Math.abs(left.energy - right.energy),
    left.tempo === null || right.tempo === null ? null : Math.abs(left.tempo - right.tempo),
  ].filter((value): value is number => value !== null);
  return values.length === 0 ? 0.5 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function adjacencyPenalty(
  previous: PlaylistOptimizationCandidateV1 | undefined,
  next: PlaylistOptimizationCandidateV1,
  constraints: PlaylistOptimizationConstraintsV1,
): number {
  if (!previous) return 0;
  return (constraints.avoidAdjacentSameArtist && previous.artistKey === next.artistKey ? 10 : 0)
    + (constraints.avoidAdjacentSameAlbum
      && previous.albumKey !== null
      && previous.albumKey === next.albumKey ? 5 : 0);
}

function adjacencyAxisCanFinish(
  previousKey: string | null,
  remainingKeys: readonly (string | null)[],
): boolean {
  const counts = new Map<string, number>();
  for (const key of remainingKeys) {
    if (key === null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = remainingKeys.length;
  for (const [key, count] of counts) {
    const separators = total - count;
    const boundaryAllowance = key === previousKey ? 0 : 1;
    if (count > separators + boundaryAllowance) return false;
  }
  return true;
}

function adjacencyCanFinish(
  previous: PlaylistOptimizationCandidateV1,
  remaining: readonly PlaylistOptimizationCandidateV1[],
  constraints: PlaylistOptimizationConstraintsV1,
): boolean {
  return (!constraints.avoidAdjacentSameArtist || adjacencyAxisCanFinish(
    previous.artistKey,
    remaining.map(({ artistKey }) => artistKey),
  ))
    && (!constraints.avoidAdjacentSameAlbum || adjacencyAxisCanFinish(
      previous.albumKey,
      remaining.map(({ albumKey }) => albumKey),
    ));
}

function sequenceSortWork(length: number): number {
  return Math.max(
    1,
    Math.ceil(length * Math.log2(Math.max(2, length))),
  );
}

function rankedSequenceCandidates(
  remaining: readonly PlaylistOptimizationCandidateV1[],
  previous: PlaylistOptimizationCandidateV1 | undefined,
  constraints: PlaylistOptimizationConstraintsV1,
  budget: OptimizationBudgetCounter,
  lane: OptimizationBudgetLane,
): PlaylistOptimizationCandidateV1[] {
  consumeOptimizationWork(budget, lane, sequenceSortWork(remaining.length));
  return [...remaining].sort((left, right) => {
    const leftDistance = previous ? distance(previous, left) : 0;
    const rightDistance = previous ? distance(previous, right) : 0;
    const direction = constraints.sequencingMode === "contrast" ? -1 : 1;
    return adjacencyPenalty(previous, left, constraints)
      - adjacencyPenalty(previous, right, constraints)
      || direction * (leftDistance - rightDistance)
      || compareCandidate(left, right);
  });
}

function sequence(
  values: readonly PlaylistOptimizationCandidateV1[],
  constraints: PlaylistOptimizationConstraintsV1,
  budget: OptimizationBudgetCounter,
  lane: OptimizationBudgetLane,
): PlaylistOptimizationCandidateV1[] {
  if (constraints.sequencingMode === "source_order") {
    consumeOptimizationWork(budget, lane, sequenceSortWork(values.length));
    return [...values].sort((left, right) => (
      left.sourceOrder - right.sourceOrder || compareCandidate(left, right)
    ));
  }
  if (constraints.sequencingMode === "chronological") {
    consumeOptimizationWork(budget, lane, sequenceSortWork(values.length));
    return [...values].sort((left, right) => {
      const leftPosition = left.chronologyPosition ?? Number.MAX_SAFE_INTEGER;
      const rightPosition = right.chronologyPosition ?? Number.MAX_SAFE_INTEGER;
      return leftPosition - rightPosition
        || compareCandidate(left, right);
    });
  }
  const remaining = [...values];
  const output: PlaylistOptimizationCandidateV1[] = [];
  while (remaining.length > 0) {
    const previous = output.at(-1);
    const ranked = rankedSequenceCandidates(
      remaining,
      previous,
      constraints,
      budget,
      lane,
    );
    let next: PlaylistOptimizationCandidateV1 | undefined;
    for (const value of ranked) {
      // Building the suffix and checking both adjacency axes are linear in
      // the remaining set. Charge before each probe; a hostile ordering can
      // no longer hide cubic work outside the configured budget.
      consumeOptimizationWork(budget, lane, remaining.length * 4 + 1);
      const after = remaining.filter(({ id }) => id !== value.id);
      if (adjacencyPenalty(previous, value, constraints) === 0
        && adjacencyCanFinish(value, after, constraints)) {
        next = value;
        break;
      }
    }
    next ??= ranked[0]!;
    output.push(next);
    remaining.splice(remaining.findIndex(({ id }) => id === next.id), 1);
  }
  return output;
}

/**
 * Backtracking adjacency rescue for a set that passed every non-sequencing
 * constraint but whose preferred greedy order was trapped by intersecting
 * artist and album boundaries. Unlike the cheap independent-axis guard, this
 * searches the joint ordering frontier and shares the exact node/work budget.
 */
function exactAdjacencySequence(
  values: readonly PlaylistOptimizationCandidateV1[],
  constraints: PlaylistOptimizationConstraintsV1,
  budget: OptimizationBudgetCounter,
): PlaylistOptimizationCandidateV1[] | null {
  if (constraints.sequencingMode === "source_order"
    || constraints.sequencingMode === "chronological"
    || (!constraints.avoidAdjacentSameArtist
      && !constraints.avoidAdjacentSameAlbum)) {
    return null;
  }
  const output: PlaylistOptimizationCandidateV1[] = [];
  const remaining = [...values];

  const search = (): boolean => {
    budget.exactNodesRemaining -= 1;
    if (budget.exactNodesRemaining < 0) {
      throw new PlaylistOptimizationBudgetExceededErrorV1(
        "Playlist exact sequencing exhausted its deterministic node budget",
      );
    }
    if (remaining.length === 0) return true;
    const previous = output.at(-1);
    const ranked = rankedSequenceCandidates(
      remaining,
      previous,
      constraints,
      budget,
      "exact",
    );
    for (const value of ranked) {
      consumeOptimizationWork(budget, "exact", remaining.length * 4 + 1);
      if (adjacencyPenalty(previous, value, constraints) !== 0) continue;
      const index = remaining.findIndex(({ id }) => id === value.id);
      const [next] = remaining.splice(index, 1);
      if (!next) continue;
      if (adjacencyCanFinish(next, remaining, constraints)) {
        output.push(next);
        if (search()) return true;
        output.pop();
      }
      remaining.splice(index, 0, next);
    }
    return false;
  };

  return search() ? [...output] : null;
}

/**
 * Exhaustive include-first rescue after a bounded beam miss.
 *
 * The beam is permitted to find a solution, never to prove there is none.
 * This search either finds the strongest ranked exact set, exhausts the full
 * combination frontier (a real infeasibility proof for this closed pool), or
 * throws a retryable technical budget error. It therefore cannot turn a
 * heuristic miss into a musical scarcity or contract-relaxation claim.
 */
function exactPlaylistRescue(
  candidates: readonly PlaylistOptimizationCandidateV1[],
  constraints: PlaylistOptimizationConstraintsV1,
  budget: OptimizationBudgetCounter,
): PlaylistOptimizationResultV1 | null {
  const selected: PlaylistOptimizationCandidateV1[] = [];
  let result: PlaylistOptimizationResultV1 | null = null;

  const search = (startIndex: number): boolean => {
    budget.exactNodesRemaining -= 1;
    if (budget.exactNodesRemaining < 0) {
      throw new PlaylistOptimizationBudgetExceededErrorV1(
        "Playlist exact rescue exhausted its deterministic node budget",
      );
    }
    if (selected.length === constraints.targetTrackCount) {
      let sequenced = sequence(selected, constraints, budget, "exact");
      let summary = constraintSummary(
        sequenced,
        constraints,
        budget,
        "exact",
      );
      const adjacencyReasons = new Set([
        "adjacent_same_artist",
        "adjacent_same_album",
      ]);
      if (summary.unmetConstraints.some((reason) => adjacencyReasons.has(reason))
        && summary.unmetConstraints.every((reason) => (
          adjacencyReasons.has(reason)
        ))) {
        const rescuedSequence = exactAdjacencySequence(
          selected,
          constraints,
          budget,
        );
        if (rescuedSequence) {
          sequenced = rescuedSequence;
          summary = constraintSummary(
            sequenced,
            constraints,
            budget,
            "exact",
          );
        }
      }
      if (summary.unmetConstraints.length !== 0) return false;
      result = {
        policyVersion: PLAYLIST_OPTIMIZER_POLICY_VERSION,
        exact: true,
        selected: sequenced,
        ...summary,
      };
      return true;
    }
    const slots = constraints.targetTrackCount - selected.length;
    const available = candidates.length - startIndex;
    if (available < slots) return false;
    const context = selectionContext(selected);
    consumeOptimizationWork(budget, "exact", available);
    for (let index = startIndex; index < candidates.length; index += 1) {
      const value = candidates[index]!;
      if (!canAddWithContext(value, context, constraints)
        || !Number.isFinite(selectionUtility(
          value,
          selected,
          constraints,
          context,
        ))
        || (selected.length + 1 === constraints.targetTrackCount
          && !completesStaticMinimums(value, context, constraints))) {
        continue;
      }
      selected.push(value);
      // Once this pick fills the immutable count, there is no residual
      // frontier to prove feasible. Re-enter the terminal branch directly so
      // it performs the exact sequence and constraint summary without
      // repeatedly scanning every lower-ranked row that can no longer be
      // selected. The terminal recursive call still consumes the same exact
      // node and summary budgets.
      if (selected.length === constraints.targetTrackCount) {
        if (search(index + 1)) return true;
        selected.pop();
        continue;
      }
      const remaining = candidates.slice(index + 1);
      consumeOptimizationWork(budget, "exact", remaining.length + 1);
      const viable = canStillSatisfy(selected, remaining, constraints);
      if (viable && search(index + 1)) return true;
      selected.pop();
    }
    return false;
  };

  search(0);
  return result;
}

/**
 * Deterministic constrained selection for already-qualified tracks. It never
 * weakens a hard cap or inserts filler: if the eligible pool cannot satisfy
 * exact count, coverage, and familiarity bounds together, the result remains
 * explicitly infeasible for the decision layer.
 */
export function optimizePlaylistV1(input: {
  candidates: readonly PlaylistOptimizationCandidateV1[];
  constraints: PlaylistOptimizationConstraintsV1;
  budget?: PlaylistOptimizationBudgetV1;
  /**
   * Publication preflight may validate a frozen optimizer output directly.
   * Retrieval selection must leave this false so its bounded search and
   * retry semantics remain unchanged.
   */
  validateFixedSelection?: boolean;
}): PlaylistOptimizationResultV1 {
  validateConstraints(input.constraints);
  // Publication preflight commonly receives the optimizer's already ordered
  // exact selection: there are no alternate rows to choose, so rerunning a
  // bounded beam can only manufacture false infeasibility. Validate that
  // fixed set directly in its frozen order before spending any search budget.
  // This is linear/bounded by the public playlist maximum and does not weaken
  // a constraint—any mismatch falls through to the normal optimizer.
  const fixedSet = input.candidates.map(candidate);
  if (input.validateFixedSelection === true
    && input.constraints.sequencingMode !== "source_order"
    && fixedSet.length === input.constraints.targetTrackCount
    && new Set(fixedSet.map(({ id }) => id)).size === fixedSet.length) {
    const fixedSummary = constraintSummary(fixedSet, input.constraints);
    if (fixedSummary.unmetConstraints.length === 0) {
      return {
        policyVersion: PLAYLIST_OPTIMIZER_POLICY_VERSION,
        exact: true,
        selected: fixedSet,
        ...fixedSummary,
      };
    }
  }
  const candidates = normalizedCandidateRepresentations(input.candidates);
  const budget = optimizationBudget(input.budget);
  const large = input.constraints.targetTrackCount > 100 || candidates.length > 1_000;
  const beamWidth = large ? LARGE_PLAYLIST_BEAM_WIDTH : SMALL_PLAYLIST_BEAM_WIDTH;
  const branchWidth = large ? LARGE_PLAYLIST_BRANCH_WIDTH : SMALL_PLAYLIST_BRANCH_WIDTH;
  let states: SelectionState[] = [{ selected: [], selectedIds: new Set() }];

  for (let depth = 0; depth < input.constraints.targetTrackCount; depth += 1) {
    const expanded = new Map<string, SelectionState>();
    for (const state of states) {
      const context = selectionContext(state.selected);
      consumeOptimizationWork(budget, "heuristic", candidates.length);
      const ranked = candidates
        .filter((value) => !state.selectedIds.has(value.id)
          && canAddWithContext(value, context, input.constraints))
        .map((value) => ({
          value,
          utility: selectionUtility(value, state.selected, input.constraints, context),
        }))
        .filter(({ utility }) => Number.isFinite(utility))
        .sort((left, right) => right.utility - left.utility
          || compareCandidate(left.value, right.value));
      const viable: typeof ranked = [];
      for (const rankedCandidate of ranked) {
        const { value } = rankedCandidate;
        const selected = [...state.selected, value];
        // A final-slot candidate either completes every static minimum now or
        // it never can; no lower-ranked row is eligible to join this set.
        // Avoid rebuilding and rescanning the entire residual pool for a
        // zero-slot optimistic-feasibility query.
        if (selected.length === input.constraints.targetTrackCount) {
          if (completesStaticMinimums(value, context, input.constraints)) {
            viable.push(rankedCandidate);
            if (viable.length >= branchWidth) break;
          }
          continue;
        }
        const remaining = candidates.filter((candidateValue) => (
          !state.selectedIds.has(candidateValue.id) && candidateValue.id !== value.id
        ));
        consumeOptimizationWork(budget, "heuristic", remaining.length + 1);
        if (canStillSatisfy(selected, remaining, input.constraints)) {
          viable.push(rankedCandidate);
          if (viable.length >= branchWidth) break;
        }
      }
      const choices = (viable.length > 0 ? viable : ranked).slice(0, branchWidth);
      for (const { value } of choices) {
        const next: SelectionState = {
          selected: [...state.selected, value],
          selectedIds: new Set([...state.selectedIds, value.id]),
        };
        const signature = selectionSignature(next.selected);
        const existing = expanded.get(signature);
        if (!existing || compareState(next, existing, input.constraints) < 0) {
          expanded.set(signature, next);
        }
      }
    }
    if (expanded.size === 0) break;
    states = [...expanded.values()]
      .sort((left, right) => compareState(left, right, input.constraints))
      .slice(0, beamWidth);
  }

  const results = states.map(({ selected }) => {
    const sequenced = sequence(
      selected,
      input.constraints,
      budget,
      "heuristic",
    );
    const summary = constraintSummary(
      sequenced,
      input.constraints,
      budget,
      "heuristic",
    );
    return {
      policyVersion: PLAYLIST_OPTIMIZER_POLICY_VERSION,
      exact: summary.unmetConstraints.length === 0,
      selected: sequenced,
      ...summary,
    } satisfies PlaylistOptimizationResultV1;
  });
  const heuristic = results.sort((left, right) => Number(right.exact) - Number(left.exact)
    || right.selected.length - left.selected.length
    || left.unmetConstraints.length - right.unmetConstraints.length
    || right.selected.reduce((sum, value) => sum + baseUtility(value), 0)
      - left.selected.reduce((sum, value) => sum + baseUtility(value), 0)
    || left.selected.map(({ id }) => id).join("\u0000")
      .localeCompare(right.selected.map(({ id }) => id).join("\u0000")))[0] ?? {
    policyVersion: PLAYLIST_OPTIMIZER_POLICY_VERSION,
    exact: false,
    selected: [],
    ...constraintSummary([], input.constraints, budget, "heuristic"),
  };
  if (heuristic.exact) return heuristic;
  return exactPlaylistRescue(candidates, input.constraints, budget) ?? heuristic;
}
