import { describe, expect, test } from "vitest";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  applyRequestedTrackCount,
  canonicalBriefForRequest,
  canonicalBriefForPrompt,
  estimateResearchCost,
  estimateResearchCostRange,
  isPlaylistBrief,
  isValidBriefTarget,
  manifestDescriptionForBrief,
  materialAmbiguitiesAccepted,
  normalizeBriefTarget,
  explicitTrackCount,
  preserveExplicitTrackCount,
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
  test("uses 50-100 as the curated default without treating 100 as a hard ceiling", () => {
    expect(normalizeBriefTarget("curated", null)).toEqual({ min: 50, max: 100 });
    expect(normalizeBriefTarget("curated", { min: 10, max: 200 })).toEqual({ min: 50, max: 200 });
    expect(normalizeBriefTarget("curated", { min: 75, max: 90 })).toEqual({ min: 75, max: 90 });
  });

  test("preserves an explicit requested song count instead of the model's broad range", () => {
    const interpreted = { ...brief("curated"), targetSize: { min: 50, max: 100 } };

    expect(preserveExplicitTrackCount(
      "Paulinho da Costa's 100 most influential songs",
      interpreted,
    ).targetSize).toEqual({ min: 100, max: 100 });
    expect(preserveExplicitTrackCount(
      "50 influential Berlin techno songs",
      interpreted,
    ).targetSize).toEqual({ min: 50, max: 50 });
    expect(preserveExplicitTrackCount(
      "Make a 25-track introduction to Detroit techno",
      interpreted,
    ).targetSize).toEqual({ min: 25, max: 25 });
    expect(preserveExplicitTrackCount(
      "Paulinho da Costa's 200 most influential songs",
      interpreted,
    ).targetSize).toEqual({ min: 200, max: 200 });
  });

  test("repairs a stale 100-track brief when the original prompt explicitly requests 300", () => {
    const storedBrief = { ...brief("curated"), targetSize: { min: 100, max: 100 } };

    expect(preserveExplicitTrackCount(
      "300 influential techno tracks",
      storedBrief,
    ).targetSize).toEqual({ min: 300, max: 300 });
  });

  test("the explicit size control overrides both prompt text and model scope", () => {
    const interpreted = {
      ...brief("exhaustive"),
      title: "Every released recording",
      relationship: "released by",
      targetSize: null,
    };

    expect(canonicalBriefForRequest({
      prompt: "Give me 300 influential techno tracks",
      requestedTrackCount: 50,
    }, interpreted)).toMatchObject({
      mode: "curated",
      title: "Test: 50 Essential Tracks",
      targetSize: { min: 50, max: 50 },
    });
  });

  test("validates the server-owned requested track count", () => {
    expect(applyRequestedTrackCount(brief("curated"), 200).targetSize).toEqual({ min: 200, max: 200 });
    expect(() => applyRequestedTrackCount(brief("curated"), 0)).toThrow(/1 to 10,000/u);
    expect(() => applyRequestedTrackCount(brief("curated"), 10_001)).toThrow(/1 to 10,000/u);
  });

  test("keeps stored scope authoritative while accepting only ambiguity acknowledgement", () => {
    const storedBrief = {
      ...brief("curated"),
      title: "Techno",
      targetSize: { min: 100, max: 100 },
      ambiguities: ["Use one canonical version"],
    };

    expect(canonicalBriefForPrompt(
      "300 influential techno tracks",
      storedBrief,
      { ambiguityAcceptance: ["Use one canonical version"] },
    )).toMatchObject({
      title: "Techno",
      targetSize: { min: 300, max: 300 },
      ambiguities: ["Use one canonical version"],
      ambiguityAcceptance: ["Use one canonical version"],
    });
  });

  test("ignores browser-supplied ambiguity acknowledgement for One Command", () => {
    const storedBrief = {
      ...brief("curated"),
      ambiguities: ["Use one canonical version"],
    };

    expect(canonicalBriefForRequest({
      prompt: "Influential techno",
      requestedTrackCount: 50,
    }, storedBrief, {
      ambiguityAcceptance: ["An invented browser acknowledgement"],
    }).ambiguityAcceptance).toBeUndefined();
  });

  test("does not confuse music years or unrelated numbers with a track count", () => {
    expect(explicitTrackCount("Influential Berlin techno songs from 1990 to 1999")).toBeNull();
    expect(explicitTrackCount("Songs by artists with more than 100 releases")).toBeNull();
  });

  test("prevents target caps from silently weakening exhaustive prompts", () => {
    expect(normalizeBriefTarget("exhaustive", { min: 25, max: 25 })).toBeNull();
    expect(isValidBriefTarget("exhaustive", null)).toBe(true);
    expect(isValidBriefTarget("exhaustive", { min: 25, max: 25 })).toBe(false);
  });

  test("validates curated and hybrid ranges independently", () => {
    expect(isValidBriefTarget("curated", { min: 50, max: 100 })).toBe(true);
    expect(isValidBriefTarget("curated", { min: 25, max: 25 })).toBe(true);
    expect(isValidBriefTarget("curated", { min: 200, max: 200 })).toBe(true);
    expect(isValidBriefTarget("curated", { min: 0, max: 100 })).toBe(false);
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
    expect(isPlaylistBrief({ ...valid, title: "x".repeat(60) })).toBe(true);
    expect(isPlaylistBrief({ ...valid, title: "x".repeat(61) })).toBe(false);
  });

  test("describes each manifest mode without claiming every playlist is exhaustive", () => {
    expect(manifestDescriptionForBrief(brief("exhaustive"))).toContain("Exhaustive across");
    expect(manifestDescriptionForBrief(brief("hybrid"))).toContain("within the confirmed constraints");
    expect(manifestDescriptionForBrief(brief("curated"))).toContain("editorial selection");
    expect(manifestDescriptionForBrief(brief("curated"))).not.toContain("Exhaustive across");
    const repaired = manifestDescriptionForBrief({
      ...brief("curated"),
      title: "Berlin techno: 50 Influential Tracks",
      description: "A stale request for 300 tracks.",
      targetSize: { min: 50, max: 50 },
    });
    expect(repaired).toContain("50 source-backed tracks");
    expect(repaired).not.toContain("300");
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

  test("prices curated requests above the fast-route ceiling as larger research", () => {
    const estimate = estimateResearchCostRange({
      ...brief("curated"),
      relationship: "historically influential within techno",
      targetSize: { min: 300, max: 300 },
    });

    expect(estimate.maximumUsd).toBeGreaterThan(0.5);
    expect(estimate.factors[0]?.label).toBe("large cited editorial research");
    expect(estimate.factors.map((factor) => factor.label)).not.toContain("fast cited editorial research");
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
