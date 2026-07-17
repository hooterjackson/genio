import { describe, expect, test } from "vitest";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  fastRunServiceLevel,
  fastRunWindowLabel,
} from "../shared/fast-run-sla.ts";
import {
  briefInterpretationModel,
  catalogMatchingCandidateGoal,
  createFastRouteCheckpoint,
  FAST_MATCHING_RESERVE_MS,
  fastPostMatchRefillPlan,
  FAST_RUN_DEADLINE_MS,
  parseFastRouteCheckpoint,
  researchExecutionPolicy,
  researchPolicyFingerprint,
} from "../server/research-policy.ts";

function brief(mode: PlaylistBrief["mode"], maximum = 100): PlaylistBrief {
  return {
    title: "Fixture",
    description: "Fixture",
    mode,
    subjectEntities: ["Fixture"],
    relationship: "is influential",
    include: [],
    exclude: [],
    versionPolicy: "one canonical recording",
    evidencePolicy: "cited editorial sources",
    orderingPolicy: "editorial",
    targetSize: mode === "exhaustive" ? null : { min: Math.min(50, maximum), max: maximum },
    ambiguities: [],
  };
}

describe("research execution policy", () => {
  test("keeps a bounded Apple-matching reserve even for very short playlists", () => {
    expect(catalogMatchingCandidateGoal(1)).toBe(4);
    expect(catalogMatchingCandidateGoal(10)).toBe(15);
    expect(catalogMatchingCandidateGoal(19)).toBe(29);
    expect(catalogMatchingCandidateGoal(20)).toBe(30);
    expect(catalogMatchingCandidateGoal(50)).toBe(75);
  });

  test("grows the catalog reserve smoothly without a small-playlist cost cliff", () => {
    const goals = Array.from({ length: 300 }, (_, index) => catalogMatchingCandidateGoal(index + 1));
    for (let index = 1; index < goals.length; index += 1) {
      expect(goals[index]).toBeGreaterThanOrEqual(goals[index - 1]!);
      expect(goals[index]! - goals[index - 1]!).toBeLessThanOrEqual(2);
    }
  });

  test("uses Luna and a bounded parallel fast path for curated prompts", () => {
    const policy = researchExecutionPolicy(brief("curated"), {});
    expect(policy).toMatchObject({
      kind: "fast_curated",
      version: "fast_curated_v3",
      model: "gpt-5.6-luna",
      runDeadlineMs: 120_000,
      matchingReserveMs: 40_000,
      targetMinimum: 50,
      targetMaximum: 100,
      candidateGoal: 75,
      candidateLimit: 75,
      maxPasses: 3,
      maxWebToolCalls: 5,
      maxSynthesisTokens: 6_000,
      maxExtractionTokens: 8_000,
      searchContextSize: "low",
    });
  });

  test("keeps exhaustive and hybrid prompts on a separate deep policy", () => {
    expect(researchExecutionPolicy(brief("exhaustive"), {})).toEqual({ kind: "deep", version: "deep_v1", model: "gpt-5.6-terra" });
    expect(researchExecutionPolicy(brief("hybrid"), { OPENAI_DEEP_MODEL: "deep-snapshot" }))
      .toEqual({ kind: "deep", version: "deep_v1", model: "deep-snapshot" });
  });

  test("plans bounded post-match refills without accepting a smaller successful playlist", () => {
    expect(fastPostMatchRefillPlan({
      requestedMinimum: 50,
      selectableCount: 28,
      attemptedCandidateCount: 63,
      refillAttempts: 0,
    })).toEqual({
      state: "refill",
      requestedMinimum: 50,
      selectableCount: 28,
      shortfall: 22,
      additionalCandidateGoal: 62,
    });
    expect(fastPostMatchRefillPlan({
      requestedMinimum: 50,
      selectableCount: 50,
      attemptedCandidateCount: 63,
      refillAttempts: 1,
    }).state).toBe("satisfied");
    expect(fastPostMatchRefillPlan({
      requestedMinimum: 50,
      selectableCount: 49,
      attemptedCandidateCount: 120,
      refillAttempts: 2,
    })).toMatchObject({ state: "shortfall", shortfall: 1, additionalCandidateGoal: 0 });
  });

  test("keeps an explicit 200-track editorial request on the bounded multi-pass fast path", () => {
    const exact200 = { ...brief("curated", 200), targetSize: { min: 200, max: 200 } };
    expect(researchExecutionPolicy(exact200, {})).toMatchObject({
      kind: "fast_curated",
      targetMinimum: 200,
      targetMaximum: 200,
      candidateGoal: 300,
      candidateLimit: 120,
      maxPasses: 4,
      runDeadlineMs: 240_000,
      matchingReserveMs: 60_000,
    });
    expect(researchExecutionPolicy({ ...exact200, targetSize: { min: 201, max: 201 } }, {}))
      .toMatchObject({
        kind: "fast_curated",
        targetMinimum: 201,
        targetMaximum: 201,
        runDeadlineMs: 360_000,
        matchingReserveMs: 90_000,
      });
  });

  test("keeps 300-track curated requests bounded and routes only larger work to deep research", () => {
    const exact300 = { ...brief("curated", 300), targetSize: { min: 300, max: 300 } };

    expect(researchExecutionPolicy(exact300, {})).toMatchObject({
      kind: "fast_curated",
      targetMinimum: 300,
      targetMaximum: 300,
      candidateGoal: 450,
      maxPasses: 5,
      runDeadlineMs: 360_000,
      matchingReserveMs: 90_000,
    });
    expect(researchExecutionPolicy({ ...exact300, targetSize: { min: 301, max: 301 } }, {})).toEqual({
      kind: "deep",
      version: "deep_v1",
      model: "gpt-5.6-terra",
    });
  });

  test("binds cache identity to the complete effective fast and deep policies", () => {
    expect(JSON.parse(researchPolicyFingerprint(brief("curated"), {}))).toEqual({
      fingerprintVersion: 2,
      kind: "fast_curated",
      version: "fast_curated_v3",
      model: "gpt-5.6-luna",
      runDeadlineMs: 120_000,
      matchingReserveMs: 40_000,
      targetMinimum: 50,
      targetMaximum: 100,
      candidateGoal: 75,
      candidateLimit: 75,
      maxPasses: 3,
      maxWebToolCalls: 5,
      maxSynthesisTokens: 6_000,
      maxExtractionTokens: 8_000,
      searchContextSize: "low",
    });
    expect(JSON.parse(researchPolicyFingerprint(brief("exhaustive"), {}))).toEqual({
      fingerprintVersion: 2,
      kind: "deep",
      version: "deep_v1",
      model: "gpt-5.6-terra",
    });
  });

  test.each([
    ["resolved fast model", { OPENAI_FAST_MODEL: "fast-snapshot" }],
    ["web-call limit", { FAST_RESEARCH_MAX_WEB_CALLS: "4" }],
    ["synthesis-token limit", { FAST_RESEARCH_MAX_SYNTHESIS_TOKENS: "5000" }],
    ["extraction-token limit", { FAST_RESEARCH_MAX_EXTRACTION_TOKENS: "7000" }],
    ["search context", { FAST_RESEARCH_SEARCH_CONTEXT: "medium" }],
  ])("changes fast cache identity when the effective %s changes", (_label, environment) => {
    expect(researchPolicyFingerprint(brief("curated"), environment)).not.toBe(
      researchPolicyFingerprint(brief("curated"), {}),
    );
  });

  test("binds the derived candidate limit and resolved deep model, but ignores unrelated environment", () => {
    const fastBaseline = researchPolicyFingerprint(brief("curated", 100), {});
    expect(researchPolicyFingerprint(brief("curated", 50), {})).not.toBe(fastBaseline);
    expect(researchPolicyFingerprint(brief("curated", 100), { UNRELATED_SETTING: "changed" })).toBe(fastBaseline);
    expect(researchPolicyFingerprint(brief("curated", 100), { FAST_RESEARCH_DEADLINE_MS: "999999", FAST_MATCHING_DEADLINE_MS: "999999" })).toBe(fastBaseline);
    expect(researchPolicyFingerprint(brief("curated", 100), { OPENAI_DEEP_MODEL: "deep-only" })).toBe(fastBaseline);

    const deepBaseline = researchPolicyFingerprint(brief("exhaustive"), {});
    expect(researchPolicyFingerprint(brief("exhaustive"), { OPENAI_DEEP_MODEL: "deep-snapshot" })).not.toBe(deepBaseline);
    expect(researchPolicyFingerprint(brief("exhaustive"), { OPENAI_MODEL: "legacy-deep-snapshot" })).toBe(deepBaseline);
    expect(researchPolicyFingerprint(brief("exhaustive"), { UNRELATED_SETTING: "changed" })).toBe(deepBaseline);
    expect(researchPolicyFingerprint(brief("exhaustive"), { OPENAI_FAST_MODEL: "fast-only" })).toBe(deepBaseline);
    expect(researchPolicyFingerprint(brief("exhaustive"), {
      OPENAI_DEEP_MODEL: "deep-snapshot",
      OPENAI_MODEL: "ignored-legacy-model",
    })).toBe(researchPolicyFingerprint(brief("exhaustive"), { OPENAI_DEEP_MODEL: "deep-snapshot" }));
  });

  test("bounds operator overrides and keeps brief interpretation on its cheaper model", () => {
    const environment = {
      OPENAI_FAST_MODEL: "fast-snapshot",
      FAST_RESEARCH_MAX_WEB_CALLS: "99",
      FAST_RESEARCH_SEARCH_CONTEXT: "medium",
    };
    expect(briefInterpretationModel(environment)).toBe("gpt-5.4-mini");
    expect(briefInterpretationModel({ ...environment, OPENAI_BRIEF_MODEL: "brief-snapshot" }))
      .toBe("brief-snapshot");
    expect(researchExecutionPolicy(brief("curated", 50), environment)).toMatchObject({
      model: "fast-snapshot",
      runDeadlineMs: 120_000,
      matchingReserveMs: 40_000,
      maxWebToolCalls: 6,
      searchContextSize: "medium",
    });
  });

  test("creates one immutable two-minute route with a fixed matching reserve", () => {
    const policy = researchExecutionPolicy(brief("curated"), {});
    if (policy.kind !== "fast_curated") throw new Error("Fixture policy must be fast");
    const confirmedAt = new Date("2026-07-14T12:00:00.000Z");
    const route = createFastRouteCheckpoint(policy, confirmedAt);

    expect(Date.parse(route.deadlineAt) - Date.parse(route.confirmedAt)).toBe(FAST_RUN_DEADLINE_MS);
    expect(Date.parse(route.deadlineAt) - Date.parse(route.researchDeadlineAt)).toBe(FAST_MATCHING_RESERVE_MS);
    expect(parseFastRouteCheckpoint(route)).toEqual(route);
    expect(parseFastRouteCheckpoint({
      ...route,
      deadlineAt: new Date(confirmedAt.getTime() + FAST_RUN_DEADLINE_MS + 1).toISOString(),
    })).toBeNull();
  });

  test("uses honest size-tiered windows without weakening the exact requested minimum", () => {
    expect(fastRunServiceLevel(1)).toMatchObject({
      tier: "standard",
      windowMinutes: 2,
      runDeadlineMs: 120_000,
      matchingReserveMs: 40_000,
    });
    expect(fastRunServiceLevel(100)).toEqual(fastRunServiceLevel(1));
    expect(fastRunServiceLevel(101)).toMatchObject({
      tier: "extended",
      windowMinutes: 4,
      runDeadlineMs: 240_000,
      matchingReserveMs: 60_000,
    });
    expect(fastRunServiceLevel(200)).toEqual(fastRunServiceLevel(101));
    expect(fastRunServiceLevel(201)).toMatchObject({
      tier: "large",
      windowMinutes: 6,
      runDeadlineMs: 360_000,
      matchingReserveMs: 90_000,
    });
    expect(fastRunWindowLabel(300)).toBe("6 MIN");

    for (const count of [100, 101, 200, 201, 300]) {
      const exact = { ...brief("curated", count), targetSize: { min: count, max: count } };
      const policy = researchExecutionPolicy(exact, {});
      expect(policy).toMatchObject({
        kind: "fast_curated",
        targetMinimum: count,
        targetMaximum: count,
      });
    }
  });

  test("accepts every server-owned timing tier and rejects mismatched deadline/reserve pairs", () => {
    const confirmedAt = new Date("2026-07-14T12:00:00.000Z");
    for (const count of [100, 200, 300]) {
      const exact = { ...brief("curated", count), targetSize: { min: count, max: count } };
      const policy = researchExecutionPolicy(exact, {});
      if (policy.kind !== "fast_curated") throw new Error("Fixture policy must be fast");
      const route = createFastRouteCheckpoint(policy, confirmedAt);
      expect(parseFastRouteCheckpoint(route)).toEqual(route);
    }

    const largePolicy = researchExecutionPolicy(
      { ...brief("curated", 300), targetSize: { min: 300, max: 300 } },
      {},
    );
    if (largePolicy.kind !== "fast_curated") throw new Error("Fixture policy must be fast");
    const largeRoute = createFastRouteCheckpoint(largePolicy, confirmedAt);
    expect(parseFastRouteCheckpoint({
      ...largeRoute,
      researchDeadlineAt: new Date(Date.parse(largeRoute.deadlineAt) - 60_000).toISOString(),
      matchingReserveMs: 60_000,
    })).toBeNull();
  });
});
