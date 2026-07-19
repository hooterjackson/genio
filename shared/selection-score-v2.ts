import type { PlaylistMode, ResearchIntent } from "./types.ts";

/**
 * Auditable, deterministic scoring for broad curated playlists.
 *
 * This score is a selection aid only. It never establishes eligibility:
 * callers must apply evidence, hard-constraint, version, playability, and
 * recording-family gates before passing a candidate here.
 */
export const SELECTION_SCORE_V2_VERSION = "selection_score_v2_2026_07" as const;

export type SelectionScoreDimension =
  | "source_evidence"
  | "source_rank"
  | "artist_diversity"
  | "album_diversity"
  | "era_diversity"
  | "scene_diversity"
  | "geography_diversity";

export interface SelectionScoreComponent {
  dimension: SelectionScoreDimension;
  /** False means the candidate supplied no trustworthy value for this axis. */
  available: boolean;
  /** Input value before normalization, retained for audit and replay. */
  rawValue: number | null;
  /** Deterministic value in the inclusive range 0..1. */
  normalizedValue: number;
  /** Configured weight before the available-component re-normalization. */
  weight: number;
  /** Contribution to the final 0..100 total after re-normalization. */
  contribution: number;
  reasonCode: string;
}

export interface SelectionScore {
  version: typeof SELECTION_SCORE_V2_VERSION;
  total: number;
  components: SelectionScoreComponent[];
  /** Stable, normalized final tie-break. It is not a score component. */
  tieBreakKey: string;
}

export interface BroadCuratedCandidate<T = unknown> {
  id: string;
  artist: string;
  title: string;
  album?: string | null;
  releaseYear?: number | null;
  scenes?: readonly string[];
  geographies?: readonly string[];
  /** One-based editorial/source position. Lower is stronger. */
  sourceRank?: number | null;
  /** Provenance-validated evidence confidence in the inclusive range 0..1. */
  evidenceConfidence: number;
  /** Independent origins only; mirrors/copies must already be collapsed. */
  independentProvenanceRoots: readonly string[];
  value: T;
}

export interface BroadCuratedSelectionContext {
  selected: readonly BroadCuratedCandidate[];
}

export interface ScoredBroadCuratedCandidate<T = unknown> {
  candidate: BroadCuratedCandidate<T>;
  score: SelectionScore;
}

export interface BroadCuratedSelection<T = unknown> {
  selected: ScoredBroadCuratedCandidate<T>[];
  overflow: BroadCuratedCandidate<T>[];
}

const WEIGHTS: Readonly<Record<SelectionScoreDimension, number>> = Object.freeze({
  source_evidence: 0.32,
  source_rank: 0.18,
  artist_diversity: 0.16,
  album_diversity: 0.1,
  era_diversity: 0.08,
  scene_diversity: 0.08,
  geography_diversity: 0.08,
});

const BROAD_CURATED_INTENTS: ReadonlySet<ResearchIntent> = new Set([
  "genre_scene",
  "similarity",
  "mood_activity",
  "theme",
  "editorial_ranking",
]);

const DIRECT_OR_FACTUAL_INTENTS: ReadonlySet<ResearchIntent> = new Set([
  "artist_catalogue",
  "factual_relationship",
  "exhaustive",
]);

/**
 * Broad-playlist scoring must never reshape a direct catalogue, factual, or
 * exhaustive result. Composite plans containing either class stay on the
 * claim/source order path because their requested relationship outranks
 * generic diversity goals.
 */
export function shouldScoreBroadCuratedSelection(
  mode: PlaylistMode,
  intents: readonly ResearchIntent[],
): boolean {
  return mode === "curated"
    && intents.some((intent) => BROAD_CURATED_INTENTS.has(intent))
    && !intents.some((intent) => DIRECT_OR_FACTUAL_INTENTS.has(intent));
}

function normalizedText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function bounded(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function uniqueNormalized(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizedText).filter(Boolean))].sort();
}

function decadeFor(year: number | null | undefined): string | null {
  if (!Number.isInteger(year) || year! < 1000 || year! > 3000) return null;
  return `${Math.floor(year! / 10) * 10}s`;
}

function occurrenceScore(selectedCount: number): number {
  return 1 / (1 + Math.max(0, selectedCount));
}

function overlapNovelty(values: readonly string[], seen: ReadonlySet<string>): number | null {
  const normalized = uniqueNormalized(values);
  if (normalized.length === 0) return null;
  const unseen = normalized.filter((value) => !seen.has(value)).length;
  return unseen > 0 ? 1 : 0.35;
}

function component(
  dimension: SelectionScoreDimension,
  value: number | null,
  reasonCode: string,
): Omit<SelectionScoreComponent, "contribution"> {
  return {
    dimension,
    available: value !== null,
    rawValue: value === null ? null : rounded(value),
    normalizedValue: value === null ? 0 : rounded(bounded(value)),
    weight: WEIGHTS[dimension],
    reasonCode,
  };
}

/**
 * Score one already-qualified candidate against the current broad-playlist
 * membership. Missing scene/geography/era metadata is neutral rather than
 * guessed. Dynamic diversity components are recalculated after every pick.
 */
export function scoreBroadCuratedCandidate<T>(
  candidate: BroadCuratedCandidate<T>,
  context: BroadCuratedSelectionContext,
): SelectionScore {
  const artistKey = normalizedText(candidate.artist);
  const albumKey = normalizedText(candidate.album);
  const selectedArtistCount = context.selected.filter(
    (selected) => normalizedText(selected.artist) === artistKey,
  ).length;
  const selectedAlbumCount = albumKey
    ? context.selected.filter((selected) => normalizedText(selected.album) === albumKey).length
    : 0;
  const seenEras = new Set(context.selected.map((selected) => decadeFor(selected.releaseYear)).filter(Boolean) as string[]);
  const seenScenes = new Set(context.selected.flatMap((selected) => uniqueNormalized(selected.scenes ?? [])));
  const seenGeographies = new Set(context.selected.flatMap(
    (selected) => uniqueNormalized(selected.geographies ?? []),
  ));
  const provenanceCount = uniqueNormalized(candidate.independentProvenanceRoots).length;
  const evidenceValue = provenanceCount > 0
    ? bounded(candidate.evidenceConfidence) * Math.min(1, 0.75 + provenanceCount * 0.125)
    : null;
  const sourceRank = Number.isInteger(candidate.sourceRank) && candidate.sourceRank! > 0
    ? candidate.sourceRank!
    : null;
  const era = decadeFor(candidate.releaseYear);

  const base = [
    component(
      "source_evidence",
      evidenceValue,
      provenanceCount > 1 ? "independent_evidence_corroborated" : "source_evidence_supported",
    ),
    component("source_rank", sourceRank === null ? null : 1 / Math.sqrt(sourceRank), "source_rank_preserved"),
    component("artist_diversity", occurrenceScore(selectedArtistCount), selectedArtistCount === 0
      ? "artist_not_yet_represented"
      : "artist_already_represented"),
    component("album_diversity", albumKey ? occurrenceScore(selectedAlbumCount) : null, selectedAlbumCount === 0
      ? "album_not_yet_represented"
      : "album_already_represented"),
    component("era_diversity", era ? (seenEras.has(era) ? 0.35 : 1) : null, era && !seenEras.has(era)
      ? "era_not_yet_represented"
      : "era_already_represented"),
    component("scene_diversity", overlapNovelty(candidate.scenes ?? [], seenScenes), "scene_coverage"),
    component(
      "geography_diversity",
      overlapNovelty(candidate.geographies ?? [], seenGeographies),
      "geography_coverage",
    ),
  ];
  const availableWeight = base.reduce((sum, item) => sum + (item.available ? item.weight : 0), 0);
  const components: SelectionScoreComponent[] = base.map((item) => ({
    ...item,
    contribution: item.available && availableWeight > 0
      ? rounded(item.normalizedValue * item.weight / availableWeight * 100)
      : 0,
  }));
  return {
    version: SELECTION_SCORE_V2_VERSION,
    total: rounded(components.reduce((sum, item) => sum + item.contribution, 0)),
    components,
    tieBreakKey: [
      String(sourceRank ?? Number.MAX_SAFE_INTEGER).padStart(16, "0"),
      artistKey,
      normalizedText(candidate.title),
      candidate.id,
    ].join("|"),
  };
}

export function compareSelectionScores(left: SelectionScore | undefined, right: SelectionScore | undefined): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return right.total - left.total || left.tieBreakKey.localeCompare(right.tieBreakKey);
}

/**
 * Greedy selection is intentional: artist/album/era/scene/geography novelty
 * changes after each pick. Re-scoring the remaining qualified pool makes that
 * state transition explicit and replayable instead of hiding it in a sort.
 */
export function selectBroadCuratedCandidates<T>(
  candidates: readonly BroadCuratedCandidate<T>[],
  target: number,
): BroadCuratedSelection<T> {
  const limit = Number.isFinite(target) ? Math.max(0, Math.floor(target)) : 0;
  const remaining = [...candidates];
  const selected: ScoredBroadCuratedCandidate<T>[] = [];
  while (selected.length < limit && remaining.length > 0) {
    const context = { selected: selected.map((item) => item.candidate) };
    const ranked = remaining
      .map((candidate) => ({ candidate, score: scoreBroadCuratedCandidate(candidate, context) }))
      .sort((left, right) => compareSelectionScores(left.score, right.score));
    const next = ranked[0]!;
    selected.push(next);
    const index = remaining.findIndex((candidate) => candidate.id === next.candidate.id);
    remaining.splice(index, 1);
  }
  return { selected, overflow: remaining };
}
