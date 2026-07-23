export const PLAYLIST_OPTIMIZER_POLICY_VERSION = "playlist_optimizer_v1" as const;

export interface PlaylistOptimizationCandidateV1 {
  id: string;
  recordingFamilyKey: string;
  artistKey: string;
  albumKey: string | null;
  relevanceScore: number;
  familiarityScore: number | null;
  discoveryScore: number | null;
  eraKeys: readonly string[];
  sceneKeys: readonly string[];
  geographyKeys: readonly string[];
  energy: number | null;
  tempo: number | null;
  chronologyPosition: number | null;
  centralQualityVerdict: "pass" | "fail" | "unknown";
}

export interface PlaylistOptimizationConstraintsV1 {
  targetTrackCount: number;
  maximumTracksPerArtist: number | null;
  maximumTracksPerAlbum: number | null;
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

type CoverageAxis = "eraKeys" | "sceneKeys" | "geographyKeys";

const FAMILIARITY_THRESHOLD = 0.6;
const SMALL_PLAYLIST_BEAM_WIDTH = 16;
// Large 100–300-track requests have substantial slack and a much larger
// qualified pool. Keep the look-ahead guard but use a single deterministic
// path so optimization remains a bounded fraction of the 15-minute budget.
const LARGE_PLAYLIST_BEAM_WIDTH = 1;
const SMALL_PLAYLIST_BRANCH_WIDTH = 6;
const LARGE_PLAYLIST_BRANCH_WIDTH = 1;

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
  return {
    ...input,
    id: input.id.trim(),
    recordingFamilyKey: input.recordingFamilyKey.trim(),
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
    energy: input.energy === null ? null : boundedScore(input.energy),
    tempo: input.tempo === null ? null : boundedScore(input.tempo),
    chronologyPosition: input.chronologyPosition === null
      || !Number.isFinite(input.chronologyPosition)
      ? null
      : input.chronologyPosition,
    centralQualityVerdict: ["pass", "fail", "unknown"].includes(input.centralQualityVerdict)
      ? input.centralQualityVerdict
      : "unknown",
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
  for (const maximum of [input.maximumTracksPerArtist, input.maximumTracksPerAlbum]) {
    if (maximum !== null && (!Number.isSafeInteger(maximum) || maximum < 1)) {
      throw new Error("invalid_playlist_optimization_constraints");
    }
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

function deduplicate(
  input: readonly PlaylistOptimizationCandidateV1[],
): PlaylistOptimizationCandidateV1[] {
  const best = new Map<string, PlaylistOptimizationCandidateV1>();
  for (const value of input.map(candidate)) {
    const existing = best.get(value.recordingFamilyKey);
    if (!existing || compareCandidate(value, existing) < 0) {
      best.set(value.recordingFamilyKey, value);
    }
  }
  return [...best.values()].sort(compareCandidate);
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
  artists: Set<string>;
  albums: Set<string>;
  covered: Record<CoverageAxis, Set<string>>;
  familiarCount: number;
  centralQualityPassCount: number;
  centralQualityUnknownCount: number;
}

function selectionContext(
  selected: readonly PlaylistOptimizationCandidateV1[],
): SelectionContext {
  return {
    artistCounts: countBy(selected, "artistKey"),
    albumCounts: countBy(selected, "albumKey"),
    artists: new Set(selected.map(({ artistKey }) => artistKey)),
    albums: new Set(selected.flatMap(({ albumKey }) => albumKey ? [albumKey] : [])),
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
  };
}

function canAddWithContext(
  value: PlaylistOptimizationCandidateV1,
  context: SelectionContext,
  constraints: PlaylistOptimizationConstraintsV1,
): boolean {
  return (constraints.maximumTracksPerArtist === null
      || (context.artistCounts.get(value.artistKey) ?? 0) < constraints.maximumTracksPerArtist)
    && (constraints.maximumTracksPerAlbum === null
      || value.albumKey === null
      || (context.albumCounts.get(value.albumKey) ?? 0) < constraints.maximumTracksPerAlbum);
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
  return axisGain + artistGain + Number(albumGain);
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
  return (coveredAxes + artists + albums + familiar + quality) * 1_000_000_000
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
): Pick<PlaylistOptimizationResultV1, "unmetConstraints" | "distinct" | "familiarTrackCount"> {
  const artists = countBy(selected, "artistKey");
  const albums = countBy(selected, "albumKey");
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
  const unmetConstraints = [
    ...(selected.length !== constraints.targetTrackCount
      ? [`exact_count:${selected.length}/${constraints.targetTrackCount}`]
      : []),
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
    ...(constraints.maximumTracksPerArtist !== null
      && [...artists.values()].some((count) => count > constraints.maximumTracksPerArtist!)
      ? ["maximum_tracks_per_artist"]
      : []),
    ...(constraints.maximumTracksPerAlbum !== null
      && [...albums.values()].some((count) => count > constraints.maximumTracksPerAlbum!)
      ? ["maximum_tracks_per_album"]
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

function sequence(
  values: readonly PlaylistOptimizationCandidateV1[],
  constraints: PlaylistOptimizationConstraintsV1,
): PlaylistOptimizationCandidateV1[] {
  if (constraints.sequencingMode === "source_order") return [...values];
  if (constraints.sequencingMode === "chronological") {
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
    const ranked = [...remaining].sort((left, right) => {
      const leftDistance = previous ? distance(previous, left) : 0;
      const rightDistance = previous ? distance(previous, right) : 0;
      const direction = constraints.sequencingMode === "contrast" ? -1 : 1;
      return adjacencyPenalty(previous, left, constraints)
        - adjacencyPenalty(previous, right, constraints)
        || direction * (leftDistance - rightDistance)
        || compareCandidate(left, right);
    });
    const next = ranked.find((value) => {
      const after = remaining.filter(({ id }) => id !== value.id);
      return adjacencyPenalty(previous, value, constraints) === 0
        && adjacencyCanFinish(value, after, constraints);
    }) ?? ranked[0]!;
    output.push(next);
    remaining.splice(remaining.findIndex(({ id }) => id === next.id), 1);
  }
  return output;
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
}): PlaylistOptimizationResultV1 {
  validateConstraints(input.constraints);
  const candidates = deduplicate(input.candidates);
  const large = input.constraints.targetTrackCount > 100 || candidates.length > 1_000;
  const beamWidth = large ? LARGE_PLAYLIST_BEAM_WIDTH : SMALL_PLAYLIST_BEAM_WIDTH;
  const branchWidth = large ? LARGE_PLAYLIST_BRANCH_WIDTH : SMALL_PLAYLIST_BRANCH_WIDTH;
  let states: SelectionState[] = [{ selected: [], selectedIds: new Set() }];

  for (let depth = 0; depth < input.constraints.targetTrackCount; depth += 1) {
    const expanded = new Map<string, SelectionState>();
    for (const state of states) {
      const context = selectionContext(state.selected);
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
      const probes = ranked.slice(0, large ? 4 : Math.max(branchWidth * 3, 24));
      const viable = probes.filter(({ value }) => {
        const selected = [...state.selected, value];
        const remaining = candidates.filter((candidateValue) => (
          !state.selectedIds.has(candidateValue.id) && candidateValue.id !== value.id
        ));
        return canStillSatisfy(selected, remaining, input.constraints);
      });
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
    const sequenced = sequence(selected, input.constraints);
    const summary = constraintSummary(sequenced, input.constraints);
    return {
      policyVersion: PLAYLIST_OPTIMIZER_POLICY_VERSION,
      exact: summary.unmetConstraints.length === 0,
      selected: sequenced,
      ...summary,
    } satisfies PlaylistOptimizationResultV1;
  });
  return results.sort((left, right) => Number(right.exact) - Number(left.exact)
    || right.selected.length - left.selected.length
    || left.unmetConstraints.length - right.unmetConstraints.length
    || right.selected.reduce((sum, value) => sum + baseUtility(value), 0)
      - left.selected.reduce((sum, value) => sum + baseUtility(value), 0)
    || left.selected.map(({ id }) => id).join("\u0000")
      .localeCompare(right.selected.map(({ id }) => id).join("\u0000")))[0] ?? {
    policyVersion: PLAYLIST_OPTIMIZER_POLICY_VERSION,
    exact: false,
    selected: [],
    ...constraintSummary([], input.constraints),
  };
}
