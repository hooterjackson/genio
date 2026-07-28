import { describe, expect, test } from "vitest";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  applyExecutableRequestedTrackCount,
  applyRequestedTrackCount,
  canonicalBriefForRequest,
  canonicalBriefForPrompt,
  deterministicBriefFallback,
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
import { researchExecutionPolicy } from "../server/research-policy.ts";
import {
  curatedResearchBudgetUsd,
  executableCuratedResearchBudgetUsd,
  GUIDED_BRIEF_BUDGET_USD,
  PUBLIC_FAST_RESEARCH_BUDGET_USD,
  PUBLIC_PLAYLIST_DEFAULT_TRACKS,
  publicRunBudgetUsd,
} from "../shared/product-policy.ts";

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
    expect(preserveExplicitTrackCount(
      "40 Buchla tape works",
      interpreted,
    ).targetSize).toEqual({ min: 40, max: 40 });
    expect(preserveExplicitTrackCount(
      "35 Japanese environmental music pieces",
      interpreted,
    ).targetSize).toEqual({ min: 35, max: 35 });
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

  test("builds a bounded researchable brief for the exact baile-funk failure prompt", () => {
    const fallback = deterministicBriefFallback({
      prompt: "Iconic baile funk songs with drill inspiration",
      requestedTrackCount: 25,
    });

    expect(fallback).toMatchObject({
      mode: "curated",
      targetSize: { min: 25, max: 25 },
      subjectEntities: ["Iconic baile funk songs with drill inspiration"],
      relationship: "is an editorially significant example of the requested musical scope",
      ambiguities: [],
    });
    expect(fallback.title).toMatch(/baile funk/iu);
    expect(fallback.include.join(" ")).toMatch(/drill inspiration/iu);
    expect(isPlaylistBrief(fallback)).toBe(true);
  });

  test("keeps exhaustive intent and similarity exclusions in deterministic fallback briefs", () => {
    expect(deterministicBriefFallback({
      prompt: "Every released song by Michael Jackson",
    })).toMatchObject({
      mode: "exhaustive",
      targetSize: null,
    });

    const similarity = deterministicBriefFallback({
      prompt: "Music like Radiohead, but by other artists",
      requestedTrackCount: 50,
    });
    expect(similarity).toMatchObject({
      mode: "curated",
      relationship: "stylistically similar to the reference artist",
      subjectEntities: ["Radiohead"],
      targetSize: { min: 50, max: 50 },
    });
    expect(similarity.exclude.join(" ")).toMatch(/exclude recordings by: Radiohead/iu);
    expect(isPlaylistBrief(similarity)).toBe(true);
  });

  test("a public default count neutralizes exhaustive prompt/model drift and stays on the capped fast path", () => {
    const interpreted = {
      ...brief("exhaustive"),
      title: "Every Ambient Recording",
      description: "An adversarial unbounded model interpretation.",
      targetSize: null,
    };
    const canonical = canonicalBriefForRequest({
      prompt: "Give me every ambient recording in a very long playlist with 1000 songs",
      requestedTrackCount: PUBLIC_PLAYLIST_DEFAULT_TRACKS,
    }, interpreted);

    expect(canonical).toMatchObject({
      mode: "curated",
      targetSize: {
        min: PUBLIC_PLAYLIST_DEFAULT_TRACKS,
        max: PUBLIC_PLAYLIST_DEFAULT_TRACKS,
      },
    });
    expect(researchExecutionPolicy(canonical)).toMatchObject({
      kind: "fast_curated",
      targetMinimum: PUBLIC_PLAYLIST_DEFAULT_TRACKS,
      targetMaximum: PUBLIC_PLAYLIST_DEFAULT_TRACKS,
    });
    expect(estimateResearchCost(canonical)).toBeLessThanOrEqual(PUBLIC_FAST_RESEARCH_BUDGET_USD);
  });

  test("shares one hard ceiling between guided preflight and public research", () => {
    expect(publicRunBudgetUsd(0.75, 0.1)).toBe(0.75);
    expect(publicRunBudgetUsd(1.5, GUIDED_BRIEF_BUDGET_USD)).toBe(1.25);
    expect(
      GUIDED_BRIEF_BUDGET_USD + publicRunBudgetUsd(1.5, GUIDED_BRIEF_BUDGET_USD),
    ).toBe(curatedResearchBudgetUsd(100));
    expect(publicRunBudgetUsd(1.5, PUBLIC_FAST_RESEARCH_BUDGET_USD)).toBe(0);
    expect(publicRunBudgetUsd(1.5, PUBLIC_FAST_RESEARCH_BUDGET_USD + 0.01)).toBe(0);
    expect(publicRunBudgetUsd(Number.NaN, 0)).toBe(0);
    expect(publicRunBudgetUsd(1.5, -0.01)).toBe(0);
  });

  test("validates the server-owned requested track count", () => {
    expect(applyRequestedTrackCount(brief("curated"), 200).targetSize).toEqual({ min: 200, max: 200 });
    expect(() => applyRequestedTrackCount(brief("curated"), 0)).toThrow(/1 to 300/u);
    expect(() => applyRequestedTrackCount(brief("curated"), 301)).toThrow(/1 to 300/u);
    expect(applyExecutableRequestedTrackCount(brief("curated"), 301).targetSize)
      .toEqual({ min: 301, max: 301 });
    expect(applyExecutableRequestedTrackCount(brief("curated"), 1_000).targetSize)
      .toEqual({ min: 1_000, max: 1_000 });
    expect(() => applyExecutableRequestedTrackCount(brief("curated"), 1_001))
      .toThrow(/1 to 1000/u);
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

  test("normalizes adversarial model interpretations of the same missing-count prompt", () => {
    const prompt = "Glitch hop adjacent to Prefuse 73 — long playlist for studying";
    const variants: PlaylistBrief[] = [
      { ...brief("hybrid"), targetSize: { min: 73, max: 73 } },
      { ...brief("hybrid"), targetSize: { min: 75, max: 150 } },
      { ...brief("curated"), targetSize: { min: 50, max: 100 } },
    ];
    const normalized = variants.map((variant) => canonicalBriefForRequest({ prompt }, variant));

    expect(normalized.map((value) => ({ mode: value.mode, targetSize: value.targetSize })))
      .toEqual([
        { mode: "curated", targetSize: { min: 100, max: 100 } },
        { mode: "curated", targetSize: { min: 100, max: 100 } },
        { mode: "curated", targetSize: { min: 100, max: 100 } },
      ]);
    expect(new Set(normalized.map(estimateResearchCost))).toEqual(new Set([1.5]));
  });

  test("keeps explicit factual enumeration on the deep path when no count control is present", () => {
    const exhaustive = canonicalBriefForRequest(
      { prompt: "Every released song by Michael Jackson" },
      brief("exhaustive"),
    );
    expect(exhaustive).toMatchObject({ mode: "exhaustive", targetSize: null });
  });

  test("does not confuse music years or unrelated numbers with a track count", () => {
    expect(explicitTrackCount("Influential Berlin techno songs from 1990 to 1999")).toBeNull();
    expect(explicitTrackCount("Songs by artists with more than 100 releases")).toBeNull();
    expect(explicitTrackCount("A survey of 20 years of influential techno tracks")).toBeNull();
    expect(explicitTrackCount("Explore 12-tone serialist works")).toBeNull();
    expect(explicitTrackCount("A 60-minute arc of Japanese ambient tracks")).toBeNull();
    expect(explicitTrackCount("Recordings for a 30-piece chamber orchestra")).toBeNull();
    expect(explicitTrackCount("12 serialist works")).toBe(12);
    expect(explicitTrackCount(
      "Don't give me Prefuse 73 songs",
      ["Prefuse 73"],
    )).toBeNull();
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
      minimumUsd: 0.25,
      maximumUsd: 1.5,
      approvalUsd: 1.5,
      factors: [{ label: "bounded fast cited research", minimumUsd: 0.25, maximumUsd: 1.5 }],
    });
  });

  test("gives 201–300 track curated requests a fixed larger fast budget", () => {
    const estimate = estimateResearchCostRange({
      ...brief("curated"),
      relationship: "historically influential within techno",
      targetSize: { min: 300, max: 300 },
    });

    expect(estimate).toEqual({
      minimumUsd: 0.35,
      maximumUsd: 3,
      approvalUsd: 3,
      factors: [{ label: "large bounded fast cited research", minimumUsd: 0.35, maximumUsd: 3 }],
    });
  });

  test("uses explicit size-tier budgets without prompt-language escalation", () => {
    expect(curatedResearchBudgetUsd(25)).toBe(0.75);
    expect(curatedResearchBudgetUsd(50)).toBe(0.75);
    expect(curatedResearchBudgetUsd(51)).toBe(1.5);
    expect(curatedResearchBudgetUsd(100)).toBe(1.5);
    expect(curatedResearchBudgetUsd(101)).toBe(3);
    expect(curatedResearchBudgetUsd(300)).toBe(3);
    expect(curatedResearchBudgetUsd(301)).toBe(0);
    expect(executableCuratedResearchBudgetUsd(300)).toBe(3);
    expect(executableCuratedResearchBudgetUsd(301)).toBe(3.25);
    expect(executableCuratedResearchBudgetUsd(1_000)).toBe(10);
    expect(executableCuratedResearchBudgetUsd(1_001)).toBe(0);
  });

  test.each([
    [301, 3.25],
    [1_000, 10],
  ] as const)("scales the authenticated owner estimate for %i exact tracks", (count, cost) => {
    const estimate = estimateResearchCostRange({
      ...brief("curated"),
      targetSize: { min: count, max: count },
    });
    expect(estimate).toMatchObject({
      maximumUsd: cost,
      approvalUsd: cost,
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
