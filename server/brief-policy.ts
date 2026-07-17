import type { PlaylistBrief } from "../shared/types.ts";
import {
  PUBLIC_FAST_RESEARCH_BUDGET_USD,
  PUBLIC_PLAYLIST_MAXIMUM_TRACKS,
  PUBLIC_PLAYLIST_MISSING_COUNT_TRACKS,
  PUBLIC_PLAYLIST_MINIMUM_TRACKS,
} from "../shared/product-policy.ts";
import { normalizePlaylistTitle, PLAYLIST_TITLE_MAX_LENGTH } from "./playlist-title.ts";
import { FAST_CURATED_TARGET_MAXIMUM } from "./research-policy.ts";
import { applySimilaritySeedPolicy } from "./similarity-policy.ts";

const CURATED_DEFAULT_MINIMUM = 50;
const CURATED_DEFAULT_MAXIMUM = 100;
const ABSOLUTE_MAXIMUM = 10_000;

export interface PlaylistBriefRequestContext {
  prompt: string;
  requestedTrackCount?: number | null;
}

const TRACK_COUNT_PATTERN = /\b(\d{1,5}|\d{1,3}(?:,\d{3})+)\+?\s*(?:[-\u2013\u2014]\s*)?(?:(?:[\p{L}][\p{L}'\u2019.-]*|&)\s+){0,8}(?:songs?|tracks?|recordings?|titles?|pieces?|works?|compositions?|cuts?|selections?|collaborations?)\b/giu;
const NON_TRACK_QUANTITY_SUFFIX = /^(?:\s*[-\u2013\u2014]\s*pieces?\b|\s*(?:[-\u2013\u2014]\s*)?(?:years?|months?|weeks?|days?|hours?|minutes?|seconds?|decades?|centur(?:y|ies)|people|persons?|listeners?|artists?|albums?|releases?|records?|discs?|volumes?|tones?|bars?|beats?|bpm|rpm|hertz|hz|khz|bits?|strings?|members?)\b)/iu;
const SUBJECTIVE_PLAYLIST_INTENT = /\b(?:playlist|mix|mixtape|best|essential|influential|important|representative|favorite|favourite|similar|resembl|sounds?\s+like|in\s+the\s+(?:style|vein)\s+of|for\s+fans\s+of|adjacent|mood|vibe|party|study|studying|work|working|background|churrasco|gathering|dinner|road\s+trip|workout)\b/iu;
const EXPLICIT_FACTUAL_EXHAUSTIVE_INTENT = /(?:\b(?:every|all)\b.{0,100}\b(?:songs?|tracks?|recordings?|releases?|credits?|versions?)\b|\b(?:complete|entire|full|exhaustive)\b.{0,60}\b(?:discograph(?:y|ies)|catalog(?:ue)?|recordings?|credits?|releases?)\b)/iu;

export interface ResearchCostFactor {
  label: string;
  minimumUsd: number;
  maximumUsd: number;
}

export interface ResearchCostEstimate {
  minimumUsd: number;
  maximumUsd: number;
  approvalUsd: number;
  factors: ResearchCostFactor[];
}

function quarter(value: number, direction: "up" | "down"): number {
  const scaled = value * 4;
  return (direction === "up" ? Math.ceil(scaled) : Math.floor(scaled)) / 4;
}

export function estimateResearchCostRange(brief: PlaylistBrief): ResearchCostEstimate {
  const factors: ResearchCostFactor[] = [];
  const add = (label: string, minimumUsd: number, maximumUsd: number) => {
    factors.push({ label, minimumUsd, maximumUsd });
  };
  const maximumTracks = brief.targetSize?.max ?? null;

  if (brief.mode === "curated" && maximumTracks !== null && maximumTracks <= FAST_CURATED_TARGET_MAXIMUM) {
    // Curated requests use the fixed fast profile: bounded Luna research
    // passes, low-context hosted search, and no exhaustive frontier passes.
    // Keep this estimate aligned with researchExecutionPolicy rather than the
    // semantic complexity table used by open-ended deep research.
    if (maximumTracks <= 200) {
      add("bounded fast cited research", 0.15, 0.75);
      return { minimumUsd: 0.15, maximumUsd: 0.75, approvalUsd: 0.75, factors };
    }
    add("large bounded fast cited research", 0.35, PUBLIC_FAST_RESEARCH_BUDGET_USD);
    return {
      minimumUsd: 0.35,
      maximumUsd: PUBLIC_FAST_RESEARCH_BUDGET_USD,
      approvalUsd: PUBLIC_FAST_RESEARCH_BUDGET_USD,
      factors,
    };
  }

  if (brief.mode === "curated") add("large cited editorial research", 0.75, 1.5);
  else if (brief.mode === "hybrid") add("bounded exhaustive research", 1.5, 2.5);
  else add("open-ended exhaustive research", 2.5, 4);

  if (maximumTracks === null) add("unbounded source frontier", 1.5, 3);
  else if (maximumTracks <= 25) add("up to 25 requested tracks", 0, 0.25);
  else if (maximumTracks <= 100) add("up to 100 requested tracks", 0.25, 0.75);
  else if (maximumTracks <= 500) add("up to 500 requested tracks", 0.75, 1.5);
  else if (maximumTracks <= 2_000) add("up to 2,000 requested tracks", 1.5, 2.5);
  else add("more than 2,000 requested tracks", 2.5, 4);

  if (brief.subjectEntities.length >= 16) add("many subject entities", 1.5, 2.5);
  else if (brief.subjectEntities.length >= 6) add("several subject entities", 0.75, 1.5);
  else if (brief.subjectEntities.length >= 2) add("multiple subject entities", 0.25, 0.5);

  const relationship = brief.relationship.toLowerCase();
  if (/perform|played on|session|credit|contribut|produced|wrote|composed|featured|sampled/u.test(relationship)) {
    add("track-level relationship verification", 0.75, 1.75);
  } else if (/influenc|important|essential|scene|genre/u.test(relationship)) {
    add("editorial influence verification", 0.5, 1.25);
  } else if (/recorded by|released by|primary artist|discograph|songs? by/u.test(relationship)) {
    add("release-discography verification", 0.25, 0.75);
  } else {
    add("relationship verification", 0.5, 1);
  }

  const versionPolicy = brief.versionPolicy.toLowerCase();
  if (/all versions|every version|remix|live|edit|demo|regional|language|reissue|alternate|deluxe|bonus/u.test(versionPolicy)) {
    add("multi-version reconciliation", 0.75, 1.75);
  } else if (/original|canonical|one entry|studio recording/u.test(versionPolicy)) {
    add("single-version reconciliation", 0, 0.25);
  } else {
    add("version reconciliation", 0.25, 0.75);
  }

  const breadth = [brief.title, brief.description, ...brief.include].join(" ").toLowerCase();
  if (/\b(every|all|entire|complete|worldwide|career|exhaustive)\b/u.test(breadth)) {
    add("broad catalogue language", 0.75, 1.5);
  }

  const ruleCount = brief.include.length + brief.exclude.length;
  if (ruleCount >= 20) add("many inclusion and exclusion rules", 0.5, 1);
  else if (ruleCount >= 12) add("additional inclusion and exclusion rules", 0.25, 0.75);

  const minimumUsd = quarter(factors.reduce((sum, factor) => sum + factor.minimumUsd, 0), "down");
  const maximumUsd = quarter(factors.reduce((sum, factor) => sum + factor.maximumUsd, 0), "up");
  return { minimumUsd, maximumUsd, approvalUsd: maximumUsd, factors };
}

export function estimateResearchCost(brief: PlaylistBrief): number {
  // The upper edge is persisted and used by the approval gate. This is
  // intentionally fail-closed: the UI may show a range, but work is never
  // admitted against its optimistic lower edge.
  return estimateResearchCostRange(brief).approvalUsd;
}

export function normalizeBriefTarget(
  mode: PlaylistBrief["mode"],
  target: PlaylistBrief["targetSize"],
): PlaylistBrief["targetSize"] {
  if (mode === "exhaustive") return null;
  if (mode === "curated") {
    if (!target) return { min: CURATED_DEFAULT_MINIMUM, max: CURATED_DEFAULT_MAXIMUM };
    // 50-100 is the adaptive default, not a ceiling on an explicit request.
    // The deterministic prompt pass below can still restore smaller explicit
    // counts (for example, "25 tracks") after this model-output normalization.
    const min = Math.min(ABSOLUTE_MAXIMUM, Math.max(CURATED_DEFAULT_MINIMUM, target.min));
    const max = Math.min(ABSOLUTE_MAXIMUM, Math.max(min, target.max));
    return { min, max };
  }
  return target;
}

/**
 * Recover a track quantity that the user wrote explicitly. This is kept
 * deterministic because a model can otherwise turn "50 songs" into the
 * product's broad 50-100 default. Four-digit years are deliberately ignored
 * unless they are outside the plausible year range.
 */
function countIsPartOfSubjectEntity(
  prompt: string,
  countIndex: number,
  countText: string,
  subjectEntities: readonly string[],
): boolean {
  const normalizedPrompt = prompt.toLocaleLowerCase();
  return subjectEntities.some((entity) => {
    const normalizedEntity = entity.toLocaleLowerCase().trim();
    if (!normalizedEntity.includes(countText)) return false;
    let entityIndex = normalizedPrompt.indexOf(normalizedEntity);
    while (entityIndex >= 0) {
      if (countIndex >= entityIndex && countIndex + countText.length <= entityIndex + normalizedEntity.length) {
        return true;
      }
      entityIndex = normalizedPrompt.indexOf(normalizedEntity, entityIndex + normalizedEntity.length);
    }
    return false;
  });
}

function countDescribesSomethingElse(prompt: string, countIndex: number, countText: string): boolean {
  return NON_TRACK_QUANTITY_SUFFIX.test(prompt.slice(countIndex + countText.length));
}

export function explicitTrackCount(
  prompt: string,
  subjectEntities: readonly string[] = [],
): number | null {
  TRACK_COUNT_PATTERN.lastIndex = 0;
  for (const match of prompt.matchAll(TRACK_COUNT_PATTERN)) {
    const rawCount = match[1]!;
    const value = Number(rawCount.replaceAll(",", ""));
    if (!Number.isInteger(value) || value < 1 || value > ABSOLUTE_MAXIMUM) continue;
    if (value >= 1900 && value <= 2099) continue;
    const countOffset = match[0].indexOf(rawCount);
    const countIndex = (match.index ?? 0) + Math.max(0, countOffset);
    if (countDescribesSomethingElse(prompt, countIndex, rawCount)) continue;
    if (countIsPartOfSubjectEntity(prompt, countIndex, rawCount.toLocaleLowerCase(), subjectEntities)) continue;
    return value;
  }
  return null;
}

/** Preserve an explicit supported quantity after model-output normalization. */
export function preserveExplicitTrackCount(prompt: string, brief: PlaylistBrief): PlaylistBrief {
  const count = explicitTrackCount(prompt, brief.subjectEntities);
  if (count === null) return brief;
  return {
    ...brief,
    // A finite public target is a bounded selection. Model wording such as
    // "hybrid" must not turn the same numeric request into a different cost
    // profile.
    mode: count <= PUBLIC_PLAYLIST_MAXIMUM_TRACKS ? "curated" : brief.mode,
    targetSize: { min: count, max: count },
  };
}

/** Apply the explicit size control. It wins over the model and prompt text. */
export function applyRequestedTrackCount(brief: PlaylistBrief, count: number): PlaylistBrief {
  if (
    !Number.isInteger(count)
    || count < PUBLIC_PLAYLIST_MINIMUM_TRACKS
    || count > PUBLIC_PLAYLIST_MAXIMUM_TRACKS
  ) {
    throw new Error(
      `Requested track count must be an integer from ${PUBLIC_PLAYLIST_MINIMUM_TRACKS} to ${PUBLIC_PLAYLIST_MAXIMUM_TRACKS}`,
    );
  }
  const constrained: PlaylistBrief = {
    ...brief,
    // A fixed result size is a curated selection, even when the prose uses
    // exhaustive language. Omitting this control remains the exhaustive path.
    mode: "curated",
    targetSize: { min: count, max: count },
  };
  return {
    ...constrained,
    title: normalizePlaylistTitle(constrained.title, constrained),
  };
}

function boundedSubjectiveBrief(prompt: string, brief: PlaylistBrief): PlaylistBrief {
  // Explicit factual enumeration is the only prose-only route into the deep
  // source-frontier workflow. Adjectives such as "long" never qualify.
  if (EXPLICIT_FACTUAL_EXHAUSTIVE_INTENT.test(prompt)) return brief;
  if (explicitTrackCount(prompt, brief.subjectEntities) !== null) return brief;
  if (brief.mode !== "curated" && !SUBJECTIVE_PLAYLIST_INTENT.test(prompt)) return brief;
  // This path exists for stale clients and prose-only API callers. Never let
  // model-invented target ranges decide workload or spend.
  const targetMinimum = PUBLIC_PLAYLIST_MISSING_COUNT_TRACKS;
  const targetMaximum = PUBLIC_PLAYLIST_MISSING_COUNT_TRACKS;
  return {
    ...brief,
    mode: "curated",
    targetSize: { min: targetMinimum, max: targetMaximum },
  };
}

export function canonicalBriefForRequest(
  request: PlaylistBriefRequestContext,
  interpreted: PlaylistBrief,
  confirmation?: Pick<PlaylistBrief, "ambiguityAcceptance"> | null,
): PlaylistBrief {
  const workloadScoped = request.requestedTrackCount == null
    ? boundedSubjectiveBrief(
      request.prompt,
      preserveExplicitTrackCount(request.prompt, interpreted),
    )
    : applyRequestedTrackCount(interpreted, request.requestedTrackCount);
  // Similarity semantics depend on the final workload mode. Apply them after
  // exact-count/default normalization so a model's incorrect "exhaustive"
  // label cannot bypass reference-artist exclusion.
  const canonical = applySimilaritySeedPolicy(request.prompt, workloadScoped);
  // One Command has no scope-confirmation screen. Never copy browser-supplied
  // ambiguity acknowledgements into an automatic run; the interpreted scope
  // remains server-authoritative and the automatic policy decides whether it
  // can proceed.
  if (request.requestedTrackCount != null || confirmation?.ambiguityAcceptance === undefined) return canonical;
  return {
    ...canonical,
    ambiguityAcceptance: [...confirmation.ambiguityAcceptance],
  };
}

/**
 * Rebuild the server-authoritative brief at an API boundary.
 *
 * Brief results live for 24 hours, so a result produced by an older worker can
 * survive a rollout. Reapplying deterministic prompt policy here repairs those
 * stored results. The browser may acknowledge the interpreted ambiguities, but
 * it cannot replace the title, scope, relationship, or requested track count.
 */
export function canonicalBriefForPrompt(
  prompt: string,
  interpreted: PlaylistBrief,
  confirmation?: Pick<PlaylistBrief, "ambiguityAcceptance"> | null,
): PlaylistBrief {
  return canonicalBriefForRequest({ prompt }, interpreted, confirmation);
}

export function isValidBriefTarget(
  mode: PlaylistBrief["mode"],
  target: PlaylistBrief["targetSize"],
): boolean {
  if (mode === "exhaustive") return target === null;
  if (mode === "curated") {
    return target !== null
      && Number.isInteger(target.min)
      && Number.isInteger(target.max)
      && target.min >= 1
      && target.max >= target.min
      && target.max <= ABSOLUTE_MAXIMUM;
  }
  return target === null || (
    Number.isInteger(target.min)
    && Number.isInteger(target.max)
    && target.min >= 1
    && target.max >= target.min
    && target.max <= ABSOLUTE_MAXIMUM
  );
}

export function isPlaylistBrief(value: unknown): value is PlaylistBrief {
  if (!value || typeof value !== "object") return false;
  const brief = value as Partial<PlaylistBrief>;
  const strings = (candidate: unknown, maxItems: number, maxLength: number, minimumItems = 0) => Array.isArray(candidate)
    && candidate.length >= minimumItems
    && candidate.length <= maxItems
    && candidate.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= maxLength);
  const validMode = ["exhaustive", "curated", "hybrid"].includes(String(brief.mode));
  const hasTargetSize = Object.hasOwn(value, "targetSize") && brief.targetSize !== undefined;
  const validTarget = validMode
    && hasTargetSize
    && isValidBriefTarget(brief.mode!, brief.targetSize!);
  return typeof brief.title === "string" && brief.title.trim().length > 0 && Array.from(brief.title).length <= PLAYLIST_TITLE_MAX_LENGTH
    && typeof brief.description === "string" && brief.description.trim().length > 0 && brief.description.length <= 2_000 && validMode
    && strings(brief.subjectEntities, 50, 240, 1)
    && typeof brief.relationship === "string" && brief.relationship.trim().length > 0 && brief.relationship.length <= 500
    && strings(brief.include, 100, 500) && strings(brief.exclude, 100, 500)
    && typeof brief.versionPolicy === "string" && brief.versionPolicy.trim().length > 0 && brief.versionPolicy.length <= 500
    && typeof brief.evidencePolicy === "string" && brief.evidencePolicy.trim().length > 0 && brief.evidencePolicy.length <= 500
    && typeof brief.orderingPolicy === "string" && brief.orderingPolicy.trim().length > 0 && brief.orderingPolicy.length <= 500
    && strings(brief.ambiguities, 50, 500)
    && (brief.ambiguityAcceptance === undefined || strings(brief.ambiguityAcceptance, 50, 500))
    && validTarget;
}

function exactStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function materialAmbiguitiesAccepted(
  brief: PlaylistBrief,
  interpretedAmbiguities: readonly string[] = brief.ambiguities,
): boolean {
  if (!exactStrings(brief.ambiguities, interpretedAmbiguities)) return false;
  if (interpretedAmbiguities.length === 0) return true;
  return Array.isArray(brief.ambiguityAcceptance)
    && exactStrings(brief.ambiguityAcceptance, interpretedAmbiguities);
}

export function manifestDescriptionForBrief(brief: PlaylistBrief): string {
  const scope = brief.mode === "exhaustive"
    ? "Exhaustive across the documented sources completed in this run; unresolved gaps remain in the evidence report."
    : brief.mode === "hybrid"
      ? "Exhaustive within the confirmed constraints and documented sources completed in this run."
      : "A cited editorial selection from the documented sources completed in this run.";
  const exactCount = brief.targetSize && brief.targetSize.min === brief.targetSize.max
    ? `${brief.targetSize.min.toLocaleString("en-US")} source-backed tracks`
    : "Source-backed tracks";
  return `Built by 9ênio. ${exactCount} for “${brief.title}.” ${scope}`.trim();
}
