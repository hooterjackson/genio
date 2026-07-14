import { describe, expect, test } from "vitest";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  estimateResearchCost,
  isPlaylistBrief,
  isValidBriefTarget,
  manifestDescriptionForBrief,
  normalizeBriefTarget,
} from "../server/brief-policy.ts";

function brief(mode: PlaylistBrief["mode"]): PlaylistBrief {
  return {
    title: "Test",
    description: "A source-backed playlist.",
    mode,
    subjectEntities: ["Test"],
    relationship: "recorded by",
    include: [],
    exclude: [],
    versionPolicy: "original releases",
    evidencePolicy: "documented sources",
    orderingPolicy: "chronological",
    targetSize: mode === "curated" ? { min: 50, max: 100 } : null,
    ambiguities: [],
  };
}

describe("playlist brief policy", () => {
  test("defaults and clamps curated prompts to the promised 50-100 range", () => {
    expect(normalizeBriefTarget("curated", null)).toEqual({ min: 50, max: 100 });
    expect(normalizeBriefTarget("curated", { min: 10, max: 200 })).toEqual({ min: 50, max: 100 });
    expect(normalizeBriefTarget("curated", { min: 75, max: 90 })).toEqual({ min: 75, max: 90 });
  });

  test("prevents target caps from silently weakening exhaustive prompts", () => {
    expect(normalizeBriefTarget("exhaustive", { min: 25, max: 25 })).toBeNull();
    expect(isValidBriefTarget("exhaustive", null)).toBe(true);
    expect(isValidBriefTarget("exhaustive", { min: 25, max: 25 })).toBe(false);
  });

  test("validates curated and hybrid ranges independently", () => {
    expect(isValidBriefTarget("curated", { min: 50, max: 100 })).toBe(true);
    expect(isValidBriefTarget("curated", { min: 49, max: 100 })).toBe(false);
    expect(isValidBriefTarget("hybrid", { min: 1, max: 500 })).toBe(true);
    expect(isValidBriefTarget("hybrid", null)).toBe(true);
  });

  test("requires targetSize to be present and validates its actual value", () => {
    const valid = brief("exhaustive");
    expect(isPlaylistBrief(valid)).toBe(true);

    const omitted = { ...valid } as Partial<PlaylistBrief>;
    delete omitted.targetSize;
    expect(isPlaylistBrief(omitted)).toBe(false);
    expect(isPlaylistBrief({ ...valid, targetSize: undefined })).toBe(false);
    expect(isPlaylistBrief({ ...valid, targetSize: { min: 1, max: 100 } })).toBe(false);
    expect(isPlaylistBrief({ ...brief("curated"), targetSize: null })).toBe(false);
    expect(isPlaylistBrief({ ...brief("hybrid"), targetSize: { min: 0, max: 100 } })).toBe(false);
    expect(isPlaylistBrief({ ...valid, subjectEntities: [] })).toBe(false);
    expect(isPlaylistBrief({ ...valid, relationship: "   " })).toBe(false);
  });

  test("describes each manifest mode without claiming every playlist is exhaustive", () => {
    expect(manifestDescriptionForBrief(brief("exhaustive"))).toContain("Exhaustive across");
    expect(manifestDescriptionForBrief(brief("hybrid"))).toContain("within the confirmed constraints");
    expect(manifestDescriptionForBrief(brief("curated"))).toContain("editorial selection");
    expect(manifestDescriptionForBrief(brief("curated"))).not.toContain("Exhaustive across");
  });

  test("prices the confirmed brief mode rather than trusting a stale interpretation estimate", () => {
    expect(estimateResearchCost(brief("curated"))).toBe(1.5);
    expect(estimateResearchCost(brief("hybrid"))).toBe(3);
    expect(estimateResearchCost(brief("exhaustive"))).toBe(8);
  });
});
