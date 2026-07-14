import { describe, expect, test } from "vitest";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  estimateResearchCost,
  estimateResearchCostRange,
  isPlaylistBrief,
  isValidBriefTarget,
  manifestDescriptionForBrief,
  materialAmbiguitiesAccepted,
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

  test("derives a transparent range from mode, size, breadth, relationship, and version complexity", () => {
    const bounded = estimateResearchCostRange({ ...brief("hybrid"), targetSize: { min: 3, max: 3 } });
    const broadBrief: PlaylistBrief = {
      ...brief("exhaustive"),
      title: "Every released performance",
      description: "An exhaustive career catalogue.",
      relationship: "performed on as a credited session musician",
      versionPolicy: "include every live, remix, edit, and regional version",
    };
    const broad = estimateResearchCostRange(broadBrief);

    expect(bounded).toMatchObject({ minimumUsd: 1.75, maximumUsd: 3.75, approvalUsd: 3.75 });
    expect(broad.maximumUsd).toBeGreaterThan(bounded.maximumUsd);
    expect(broad.factors.map((factor) => factor.label)).toEqual(expect.arrayContaining([
      "open-ended exhaustive research",
      "unbounded source frontier",
      "track-level relationship verification",
      "multi-version reconciliation",
      "broad catalogue language",
    ]));
    expect(estimateResearchCost(broadBrief)).toBe(broad.maximumUsd);
  });

  test("prices curated prompts from the fixed fast execution profile", () => {
    expect(estimateResearchCostRange({
      ...brief("curated"),
      relationship: "performed on as a session musician",
      versionPolicy: "all remixes, live versions, and edits",
    })).toEqual({
      minimumUsd: 0.15,
      maximumUsd: 0.5,
      approvalUsd: 0.5,
      factors: [{ label: "fast cited editorial research", minimumUsd: 0.15, maximumUsd: 0.5 }],
    });
  });

  test("uses the pessimistic edge of the range for the approval gate", () => {
    const small = { ...brief("hybrid"), targetSize: { min: 3, max: 3 } };
    const unbounded = brief("hybrid");
    expect(estimateResearchCost(small)).toBeLessThanOrEqual(5);
    expect(estimateResearchCost(unbounded)).toBeGreaterThan(5);
  });

  test("requires an exact acknowledgement of every interpreted material ambiguity", () => {
    const unambiguous = brief("hybrid");
    expect(materialAmbiguitiesAccepted(unambiguous, [])).toBe(true);

    const ambiguities = ["Include guest appearances", "Use original releases only"];
    const interpreted = { ...unambiguous, ambiguities };
    expect(materialAmbiguitiesAccepted(interpreted, ambiguities)).toBe(false);
    expect(materialAmbiguitiesAccepted({
      ...interpreted,
      ambiguityAcceptance: ambiguities,
    }, ambiguities)).toBe(true);
    expect(materialAmbiguitiesAccepted({
      ...interpreted,
      ambiguityAcceptance: [ambiguities[1]!, ambiguities[0]!],
    }, ambiguities)).toBe(false);
    expect(materialAmbiguitiesAccepted({
      ...interpreted,
      ambiguities: [],
      ambiguityAcceptance: [],
    }, ambiguities)).toBe(false);
  });
});
