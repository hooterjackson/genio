import { describe, expect, test } from "vitest";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  briefInterpretationModel,
  createFastRouteCheckpoint,
  FAST_MATCHING_RESERVE_MS,
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
  test("uses Luna and a bounded parallel fast path for curated prompts", () => {
    const policy = researchExecutionPolicy(brief("curated"), {});
    expect(policy).toMatchObject({
      kind: "fast_curated",
      version: "fast_curated_v1",
      model: "gpt-5.6-luna",
      runDeadlineMs: 120_000,
      matchingReserveMs: 40_000,
      candidateLimit: 120,
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

  test("binds cache identity to the complete effective fast and deep policies", () => {
    expect(JSON.parse(researchPolicyFingerprint(brief("curated"), {}))).toEqual({
      fingerprintVersion: 2,
      kind: "fast_curated",
      version: "fast_curated_v1",
      model: "gpt-5.6-luna",
      runDeadlineMs: 120_000,
      matchingReserveMs: 40_000,
      candidateLimit: 120,
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
    expect(researchPolicyFingerprint(brief("exhaustive"), { OPENAI_MODEL: "legacy-deep-snapshot" })).not.toBe(deepBaseline);
    expect(researchPolicyFingerprint(brief("exhaustive"), { UNRELATED_SETTING: "changed" })).toBe(deepBaseline);
    expect(researchPolicyFingerprint(brief("exhaustive"), { OPENAI_FAST_MODEL: "fast-only" })).toBe(deepBaseline);
    expect(researchPolicyFingerprint(brief("exhaustive"), {
      OPENAI_DEEP_MODEL: "deep-snapshot",
      OPENAI_MODEL: "ignored-legacy-model",
    })).toBe(researchPolicyFingerprint(brief("exhaustive"), { OPENAI_DEEP_MODEL: "deep-snapshot" }));
  });

  test("bounds operator overrides and uses the fast model for brief interpretation", () => {
    const environment = {
      OPENAI_FAST_MODEL: "fast-snapshot",
      FAST_RESEARCH_MAX_WEB_CALLS: "99",
      FAST_RESEARCH_SEARCH_CONTEXT: "medium",
    };
    expect(briefInterpretationModel(environment)).toBe("fast-snapshot");
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
});
