import type { PlaylistBrief } from "../shared/types.ts";
import { PLAYLIST_TITLE_MAX_LENGTH } from "./playlist-title.ts";

const CURATED_DEFAULT_MINIMUM = 50;
const CURATED_DEFAULT_MAXIMUM = 100;
const ABSOLUTE_MAXIMUM = 10_000;

const TRACK_COUNT_PATTERN = /\b(\d{1,5}|\d{1,3}(?:,\d{3})+)\+?\s*(?:[-\u2013\u2014]\s*)?(?:(?:[\p{L}][\p{L}'\u2019.-]*|&)\s+){0,8}(?:songs?|tracks?|recordings?|titles?)\b/giu;

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

  if (brief.mode === "curated") {
    // Curated requests use the fixed fast profile: bounded Luna research
    // passes, low-context hosted search, and no exhaustive frontier passes.
    // Keep this estimate aligned with researchExecutionPolicy rather than the
    // semantic complexity table used by open-ended deep research.
    add("fast cited editorial research", 0.15, 0.5);
    return { minimumUsd: 0.15, maximumUsd: 0.5, approvalUsd: 0.5, factors };
  }

  if (brief.mode === "hybrid") add("bounded exhaustive research", 1.5, 2.5);
  else add("open-ended exhaustive research", 2.5, 4);

  const maximumTracks = brief.targetSize?.max ?? null;
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
export function explicitTrackCount(prompt: string): number | null {
  TRACK_COUNT_PATTERN.lastIndex = 0;
  for (const match of prompt.matchAll(TRACK_COUNT_PATTERN)) {
    const value = Number(match[1]!.replaceAll(",", ""));
    if (!Number.isInteger(value) || value < 1 || value > ABSOLUTE_MAXIMUM) continue;
    if (value >= 1900 && value <= 2099) continue;
    return value;
  }
  return null;
}

/** Preserve an explicit supported quantity after model-output normalization. */
export function preserveExplicitTrackCount(prompt: string, brief: PlaylistBrief): PlaylistBrief {
  const count = explicitTrackCount(prompt);
  if (count === null || brief.mode === "exhaustive") return brief;
  return { ...brief, targetSize: { min: count, max: count } };
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
  return `Built by gênio. ${brief.description.trim()} ${scope}`.trim();
}
