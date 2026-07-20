import { createHash } from "node:crypto";
import type {
  CatalogSong,
  PlaylistMode,
  RecordingVersionClass,
  ResearchIntent,
  TrackScopeBinding,
  TrackScopeBindingKind,
} from "../shared/types.ts";
import {
  compareSelectionScores,
  type SelectionScore,
} from "../shared/selection-score-v2.ts";

export const PIPELINE_V2_VERSION = "catalog_first_v2" as const;
export const SELECTION_PLAN_VERSION = "selection_plan_v2" as const;
export const PIPELINE_POLICY_VERSION = "relevance_first_2026_07_r2" as const;

export const SOFT_CONSTRAINT_RELAXATION_ORDER = [
  "sequencing",
  "album_concentration",
  "artist_concentration",
  "era_balance",
  "subgenre_regional_representation",
] as const;

export type SoftConstraintId = typeof SOFT_CONSTRAINT_RELAXATION_ORDER[number];
export type PipelineFailureOrigin = "provider" | "catalog" | "policy" | "local_contract" | "integrity";

export interface PipelineStageCounts {
  discovered: number;
  scopeEligible: number;
  evidenceEligible: number;
  versionCompatible: number;
  playable: number;
  canonicalUnique: number;
  quotaEligible: number;
  sequenced: number;
  manifested: number;
  published: number;
}

export interface AdaptiveDiscoveryPlan {
  deficit: number;
  qualifiedReserve: number;
  conservativeYield: number;
  rawDiscoveryGoal: number;
}

export interface ConstraintRule {
  id: string;
  kind: "hard" | "soft";
  relaxationRank: number | null;
}

export interface ConstraintCandidate<T = unknown> {
  value: T;
  violations: string[];
  /** Optional auditable rank for broad curated selection; eligibility wins first. */
  selectionScore?: SelectionScore;
}

export interface ConstraintSelection<T = unknown> {
  outcome: "complete" | "partial_policy_conflict";
  selected: T[];
  relaxedSoftConstraints: string[];
}

export interface TrackScopeBindingSummary {
  strength: "strong" | "medium";
  provenanceRoot: string;
  layer: "scope_binding" | "track_claim" | "factual_claim";
  supportsRequestedRelationship: boolean;
  /** Exact persisted provenance class. Required by the V2 intent gate. */
  bindingKind?: TrackScopeBindingKind;
  /** The claim axis prevents one true assertion from proving another intent. */
  scopeAxis?: TrackScopeBinding["scopeAxis"];
}

export interface TrackScopeBindingEvidenceClassification {
  layer: TrackScopeBindingSummary["layer"];
  supportsRequestedRelationship: boolean;
}

/**
 * One confidence boundary is shared by catalog matching and manifest lock.
 * An attested exact-track editorial claim is intentionally strong enough to
 * stand on one independent source; lower-confidence claims still require two
 * independent provenance roots.
 */
export function trackScopeBindingStrength(confidence: number): TrackScopeBindingSummary["strength"] {
  return Number.isFinite(confidence) && confidence >= 0.8 ? "strong" : "medium";
}

/**
 * Classify one binding by the claim it actually proves. A composite request
 * must not turn every exact-track citation into a factual claim merely because
 * one of the run's other intents is factual.
 */
export function classifyTrackScopeBindingEvidence(input: {
  bindingKind: TrackScopeBindingKind;
  scopeAxis?: TrackScopeBinding["scopeAxis"];
  citationAttested: boolean;
}): TrackScopeBindingEvidenceClassification {
  if (input.bindingKind !== "track_specific_source") {
    return { layer: "scope_binding", supportsRequestedRelationship: true };
  }
  if (!input.citationAttested) {
    return { layer: "scope_binding", supportsRequestedRelationship: false };
  }
  return {
    layer: ["factual_relationship", "exhaustive"].includes(input.scopeAxis ?? "")
      ? "factual_claim"
      : "track_claim",
    supportsRequestedRelationship: true,
  };
}

const ONE_SIDED_95_PERCENT_Z = 1.6448536269514722;
const COLD_START_YIELD = 0.5;
const MINIMUM_PLANNING_YIELD = 0.2;
const MAXIMUM_PLANNING_YIELD = 0.95;

function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * One-sided Wilson lower bound for the final qualified/selectable yield.
 * The controller plans for the downside, not the point estimate. The product
 * contract intentionally floors planning yield at 20% so narrow prompts stay
 * bounded and terminate as transparent partial results rather than exploding.
 */
export function conservativeQualifiedYield(successes: number, attempts: number): number {
  const boundedAttempts = count(attempts);
  if (boundedAttempts === 0) return COLD_START_YIELD;
  const boundedSuccesses = Math.min(boundedAttempts, count(successes));
  const observed = boundedSuccesses / boundedAttempts;
  const zSquared = ONE_SIDED_95_PERCENT_Z ** 2;
  const denominator = 1 + zSquared / boundedAttempts;
  const center = observed + zSquared / (2 * boundedAttempts);
  const margin = ONE_SIDED_95_PERCENT_Z * Math.sqrt(
    (observed * (1 - observed) + zSquared / (4 * boundedAttempts)) / boundedAttempts,
  );
  return Math.min(
    MAXIMUM_PLANNING_YIELD,
    Math.max(MINIMUM_PLANNING_YIELD, (center - margin) / denominator),
  );
}

export function adaptiveDiscoveryPlan(input: {
  target: number;
  qualified: number;
  attempted: number;
  observedQualified: number;
  maximumRawGoal?: number;
}): AdaptiveDiscoveryPlan {
  const target = count(input.target);
  const qualified = count(input.qualified);
  const deficit = Math.max(0, target - qualified);
  const qualifiedReserve = target > 0 ? Math.max(5, Math.ceil(target * 0.1)) : 0;
  const conservativeYield = conservativeQualifiedYield(input.observedQualified, input.attempted);
  const maximumRawGoal = Math.max(1, count(input.maximumRawGoal ?? 1_000));
  return {
    deficit,
    qualifiedReserve,
    conservativeYield,
    rawDiscoveryGoal: deficit === 0
      ? 0
      : Math.min(maximumRawGoal, Math.ceil((deficit + qualifiedReserve) / conservativeYield)),
  };
}

export function emptyPipelineStageCounts(): PipelineStageCounts {
  return {
    discovered: 0,
    scopeEligible: 0,
    evidenceEligible: 0,
    versionCompatible: 0,
    playable: 0,
    canonicalUnique: 0,
    quotaEligible: 0,
    sequenced: 0,
    manifested: 0,
    published: 0,
  };
}

export function validatePipelineStageCounts(input: Partial<PipelineStageCounts>): PipelineStageCounts {
  const values = { ...emptyPipelineStageCounts(), ...input };
  const ordered = [
    values.discovered,
    values.scopeEligible,
    values.evidenceEligible,
    values.versionCompatible,
    values.playable,
    values.canonicalUnique,
    values.quotaEligible,
    values.sequenced,
    values.manifested,
    values.published,
  ].map(count);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]! > ordered[index - 1]!) {
      throw new Error("Pipeline stage counts must be monotonically non-increasing");
    }
  }
  return {
    discovered: ordered[0]!,
    scopeEligible: ordered[1]!,
    evidenceEligible: ordered[2]!,
    versionCompatible: ordered[3]!,
    playable: ordered[4]!,
    canonicalUnique: ordered[5]!,
    quotaEligible: ordered[6]!,
    sequenced: ordered[7]!,
    manifested: ordered[8]!,
    published: ordered[9]!,
  };
}

export function selectWithConstraintLadder<T>(input: {
  target: number;
  constraints: readonly ConstraintRule[];
  candidates: readonly ConstraintCandidate<T>[];
  /**
   * Optional dynamic ordering for candidates that already cleared the active
   * hard/soft gate. It may return a selected subset but cannot introduce or
   * repeat candidates. This keeps relevance/diversity ranking downstream of
   * eligibility and makes direct/factual callers retain their source order.
   */
  rankQualifiedCandidates?: (
    candidates: readonly ConstraintCandidate<T>[],
    target: number,
  ) => readonly ConstraintCandidate<T>[];
}): ConstraintSelection<T> {
  const target = count(input.target);
  const hard = new Set(input.constraints.filter((rule) => rule.kind === "hard").map((rule) => rule.id));
  const soft = input.constraints
    .filter((rule) => rule.kind === "soft")
    .sort((left, right) => (left.relaxationRank ?? Number.MAX_SAFE_INTEGER) - (right.relaxationRank ?? Number.MAX_SAFE_INTEGER));
  const relaxedSoftConstraints: string[] = [];
  const eligible = (): ConstraintCandidate<T>[] => {
    const activeSoft = new Set(soft
      .filter((rule) => !relaxedSoftConstraints.includes(rule.id))
      .map((rule) => rule.id));
    return input.candidates.filter((candidate) => candidate.violations.every((violation) => (
      !hard.has(violation) && !activeSoft.has(violation)
    ))).sort((left, right) => compareSelectionScores(left.selectionScore, right.selectionScore));
  };

  let qualified = eligible();
  for (const rule of soft) {
    if (qualified.length >= target) break;
    relaxedSoftConstraints.push(rule.id);
    qualified = eligible();
  }
  const ranked = input.rankQualifiedCandidates
    ? [...input.rankQualifiedCandidates(qualified, target)]
    : qualified;
  if (input.rankQualifiedCandidates) {
    const qualifiedCandidates = new Set(qualified);
    const seen = new Set<ConstraintCandidate<T>>();
    for (const candidate of ranked) {
      if (!qualifiedCandidates.has(candidate)) {
        throw new Error("Qualified-candidate ranker returned an ineligible candidate");
      }
      if (seen.has(candidate)) {
        throw new Error("Qualified-candidate ranker returned a duplicate candidate");
      }
      seen.add(candidate);
    }
  }
  const selected = ranked.slice(0, target).map((candidate) => candidate.value);
  return {
    outcome: selected.length >= target ? "complete" : "partial_policy_conflict",
    selected,
    relaxedSoftConstraints,
  };
}

function independentEvidenceThreshold(
  bindings: readonly TrackScopeBindingSummary[],
  predicate: (binding: TrackScopeBindingSummary) => boolean,
): boolean {
  const supporting = bindings.filter((binding) => (
    binding.supportsRequestedRelationship
      && Boolean(binding.provenanceRoot.trim())
      && predicate(binding)
  ));
  if (supporting.some((binding) => binding.strength === "strong")) return true;
  const mediumRoots = new Set(supporting
    .filter((binding) => binding.strength === "medium")
    .map((binding) => binding.provenanceRoot.trim().toLocaleLowerCase())
    .filter(Boolean));
  return mediumRoots.size >= 2;
}

const INTENT_TRACK_CLAIM_AXES: Readonly<Partial<Record<ResearchIntent, readonly TrackScopeBinding["scopeAxis"][]>>> = Object.freeze({
  similarity: ["similarity"],
  mood_activity: ["mood", "activity", "mood_theme_activity"],
  theme: ["theme", "mood_theme_activity"],
  artist_catalogue: ["artist_catalog"],
  editorial_ranking: ["editorial_ranked"],
});

function genreSceneBinding(binding: TrackScopeBindingSummary): boolean {
  if (!["genre", "scene", "genre_scene"].includes(binding.scopeAxis ?? "")) return false;
  if (binding.layer === "track_claim") return true;
  return binding.layer === "scope_binding"
    && (binding.bindingKind === "catalog_editorial_membership"
      || binding.bindingKind === "scoped_container_membership");
}

/**
 * Apple identity is required but is deliberately not counted as relevance
 * evidence. An exact Apple editorial container may establish genre/scene
 * membership only. It cannot be reused as evidence of similarity, mood,
 * theme, influence/ranking, artist-credit, or another factual relationship.
 * Every evidentiary intent in a composite plan must clear its own threshold.
 */
export function scopeBindingEligible(
  mode: PlaylistMode,
  bindings: readonly TrackScopeBindingSummary[],
  intents?: readonly ResearchIntent[],
): boolean {
  const supporting = bindings.filter((binding) => binding.supportsRequestedRelationship);
  const requestedIntents = [...new Set(intents ?? [])];

  // Legacy callers have no typed intent contract. Preserve their prior
  // behavior while all V1 jobs drain; Pipeline V2 always passes intents.
  if (requestedIntents.length === 0) {
    if (mode === "exhaustive" || mode === "hybrid") {
      return independentEvidenceThreshold(supporting, (binding) => binding.layer === "factual_claim");
    }
    return independentEvidenceThreshold(supporting, () => true);
  }

  if (mode === "exhaustive"
    || requestedIntents.includes("factual_relationship")
    || requestedIntents.includes("exhaustive")) {
    if (!independentEvidenceThreshold(supporting, (binding) => binding.layer === "factual_claim"
      && ["factual_relationship", "exhaustive"].includes(binding.scopeAxis ?? ""))) return false;
  }

  for (const intent of requestedIntents) {
    // The factual threshold above is necessary but not sufficient for a
    // composite request. For example, a verified percussion credit cannot by
    // itself prove that the track was influential or stylistically similar.
    if (intent === "factual_relationship" || intent === "exhaustive") continue;
    if (intent === "genre_scene") {
      if (!independentEvidenceThreshold(supporting, genreSceneBinding)) return false;
      continue;
    }
    const allowedAxes = INTENT_TRACK_CLAIM_AXES[intent];
    if (!allowedAxes) continue;
    if (!independentEvidenceThreshold(supporting, (binding) => (
      binding.layer === "track_claim" && allowedAxes.includes(binding.scopeAxis!)
    ))) return false;
  }
  return true;
}

function normalizedRecordingText(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/\b(feat(?:uring)?|ft)\.?\s+[^()[\]{}]+/gu, " ")
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Catalog-facing version classification shared by matching, selection, and
 * manifest preflight. Keep it deterministic: Apple title/version metadata is
 * identity evidence, not a reason to silently relax a requested version.
 */
export function catalogContentRating(
  song: Pick<CatalogSong, "contentRating">,
): "clean" | "explicit" | null {
  return song.contentRating === "clean" || song.contentRating === "explicit"
    ? song.contentRating
    : null;
}

function catalogRecordingVersionMarkerClass(value: string): RecordingVersionClass | null {
  if (/\b(karaoke)\b/u.test(value)) return "karaoke";
  if (/\b(cover|tribute)\b/u.test(value)) return "cover";
  if (/\b(instrumental)\b/u.test(value)) return "instrumental";
  if (/\b(remix|mix)\b/u.test(value)) return "remix";
  if (/\b(live|ao vivo|en vivo)\b/u.test(value)) return "live";
  if (/\b(remaster(?:ed)?)\b/u.test(value)) return "remaster";
  if (/\b(?:(?:radio|single)\s+)?edit\b/u.test(value)) return "radio_edit";
  if (/\b(extended)\b/u.test(value)) return "extended";
  if (/\b(acoustic)\b/u.test(value)) return "acoustic";
  return null;
}

export function catalogRecordingVersionClass(
  song: Pick<CatalogSong, "name" | "versionLabel" | "contentRating">,
): RecordingVersionClass {
  const value = `${song.name} ${song.versionLabel ?? ""}`.normalize("NFKD").toLowerCase();
  // Dance catalogs commonly use “Original Mix” (and “Original Club Mix”)
  // for the canonical recording, not a later remix. Remove only that exact
  // phrase before checking for another version marker so “Original Mix -
  // Live” cannot launder a derived recording into the canonical class.
  const originalMixPattern = /\boriginal(?:\s+club)?\s+mix\b/u;
  if (originalMixPattern.test(value)) {
    const remainingVersionText = value.replace(/\boriginal(?:\s+club)?\s+mix\b/gu, " ");
    const conflictingVersion = catalogRecordingVersionMarkerClass(
      remainingVersionText,
    );
    if (conflictingVersion) return conflictingVersion;
    if (/\b(clean)\b/u.test(remainingVersionText)) return "clean";
    if (/\b(explicit)\b/u.test(remainingVersionText)) return "explicit";
    return "canonical";
  }
  const markerClass = catalogRecordingVersionMarkerClass(value);
  if (markerClass) return markerClass;
  const rating = catalogContentRating(song);
  if (rating) return rating;
  if (/\b(clean)\b/u.test(value)) return "clean";
  if (/\b(explicit)\b/u.test(value)) return "explicit";
  return "canonical";
}

export function catalogRecordingVersionSignature(
  song: Pick<CatalogSong, "name" | "versionLabel" | "contentRating">,
): string {
  return `${catalogRecordingVersionClass(song)}:${catalogContentRating(song) ?? "unrated"}`;
}

export function recordingFamilyKey(input: {
  song: CatalogSong;
  musicBrainzRecordingId?: string | null;
}): string {
  // A stable recording identifier is authoritative only inside a compatible
  // version boundary. Providers occasionally reuse an ISRC (and, more
  // rarely, an upstream recording mapping) across clean/explicit or derived
  // versions. Preserve those distinctions before canonical deduplication.
  const versionSignature = catalogRecordingVersionSignature(input.song);
  const versionSuffix = versionSignature === "canonical:unrated"
    ? ""
    : `:${versionSignature}`;
  const isrc = input.song.isrc?.trim().toUpperCase().replace(/[^A-Z0-9]/gu, "") ?? "";
  if (/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/u.test(isrc)) return `isrc:${isrc}${versionSuffix}`;
  const mbid = input.musicBrainzRecordingId?.trim().toLowerCase() ?? "";
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(mbid)) {
    return `mbid:${mbid}${versionSuffix}`;
  }
  const durationBucket = Number.isFinite(input.song.durationInMillis)
    ? Math.round(Number(input.song.durationInMillis) / 2_000)
    : 0;
  const stable = [
    normalizedRecordingText(input.song.artistName),
    normalizedRecordingText(input.song.name),
    durationBucket,
    catalogRecordingVersionSignature(input.song),
  ].join(":");
  return `metadata:${createHash("sha256").update(stable).digest("hex").slice(0, 24)}`;
}

export function terminalPipelineOutcome(input: {
  failureOrigin: PipelineFailureOrigin;
  safeTrackCount: number;
  frontierExhausted?: boolean;
  timedOut?: boolean;
}):
  | "complete"
  | "partial_frontier_exhausted"
  | "partial_evidence_shortfall"
  | "partial_catalog_degraded"
  | "partial_timed_out"
  | "partial_policy_conflict"
  | "no_compatible_tracks"
  | "failed_system"
  | "failed_integrity" {
  const safeTrackCount = count(input.safeTrackCount);
  if (input.failureOrigin === "integrity") return "failed_integrity";
  if (input.failureOrigin === "local_contract") return "failed_system";
  if (safeTrackCount === 0) return "no_compatible_tracks";
  if (input.timedOut) return "partial_timed_out";
  if (input.failureOrigin === "catalog") return "partial_catalog_degraded";
  if (input.failureOrigin === "policy") return "partial_policy_conflict";
  if (input.frontierExhausted) return "partial_frontier_exhausted";
  return "partial_evidence_shortfall";
}
