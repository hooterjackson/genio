import type { PlaylistBrief } from "../shared/types.ts";

const CURATED_MINIMUM = 50;
const CURATED_MAXIMUM = 100;
const ABSOLUTE_MAXIMUM = 10_000;

export function normalizeBriefTarget(
  mode: PlaylistBrief["mode"],
  target: PlaylistBrief["targetSize"],
): PlaylistBrief["targetSize"] {
  if (mode === "exhaustive") return null;
  if (mode === "curated") {
    if (!target) return { min: CURATED_MINIMUM, max: CURATED_MAXIMUM };
    const min = Math.min(CURATED_MAXIMUM, Math.max(CURATED_MINIMUM, target.min));
    const max = Math.min(CURATED_MAXIMUM, Math.max(min, target.max));
    return { min, max };
  }
  return target;
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
      && target.min >= CURATED_MINIMUM
      && target.max >= target.min
      && target.max <= CURATED_MAXIMUM;
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
  return typeof brief.title === "string" && brief.title.trim().length > 0 && brief.title.length <= 240
    && typeof brief.description === "string" && brief.description.trim().length > 0 && brief.description.length <= 2_000 && validMode
    && strings(brief.subjectEntities, 50, 240, 1)
    && typeof brief.relationship === "string" && brief.relationship.trim().length > 0 && brief.relationship.length <= 500
    && strings(brief.include, 100, 500) && strings(brief.exclude, 100, 500)
    && typeof brief.versionPolicy === "string" && brief.versionPolicy.trim().length > 0 && brief.versionPolicy.length <= 500
    && typeof brief.evidencePolicy === "string" && brief.evidencePolicy.trim().length > 0 && brief.evidencePolicy.length <= 500
    && typeof brief.orderingPolicy === "string" && brief.orderingPolicy.trim().length > 0 && brief.orderingPolicy.length <= 500
    && strings(brief.ambiguities, 50, 500) && validTarget;
}

export function manifestDescriptionForBrief(brief: PlaylistBrief): string {
  const scope = brief.mode === "exhaustive"
    ? "Exhaustive across the documented sources completed in this run; unresolved gaps remain in the evidence report."
    : brief.mode === "hybrid"
      ? "Exhaustive within the confirmed constraints and documented sources completed in this run."
      : "A cited editorial selection from the documented sources completed in this run.";
  return `Built by Needle. ${brief.description.trim()} ${scope}`.trim();
}
