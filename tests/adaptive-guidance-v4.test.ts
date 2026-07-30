import { describe, expect, test } from "vitest";
import {
  assertGuidanceDecisionV4,
  compileGuidanceSelectionV4,
  createGuidanceDecisionV4,
  guidanceCheckpointV4,
} from "../server/adaptive-guidance-v4.ts";
import {
  publicGuidanceQuestionV4,
  compileGuidanceRoundPatchV3,
} from "../server/adaptive-guidance-contract-bridge.ts";
import {
  applyPlaylistContractPatchV1,
  compilePlaylistContractRevisionV1,
  type PlaylistContractRevisionV1,
} from "../server/playlist-contract-v1.ts";
import { createRunSpecV3 } from "../server/selection-plan-v3.ts";

function baseContract(prompt: string, count = 25): PlaylistContractRevisionV1 {
  return compilePlaylistContractRevisionV1({
    contractId: `test-${prompt.replace(/[^a-z0-9]+/giu, "-").slice(0, 40)}`,
    rawPrompt: prompt,
    requestedTrackCount: count,
    locale: "en",
    storefront: "us",
    clauses: [{
      id: "prompt:membership:music",
      kind: "membership",
      scope: "track",
      hardness: "hard",
      axis: "genre",
      operator: "require",
      values: ["music"],
      source: { provenance: "prompt", text: "music" },
      unknownPolicy: "defer",
    }],
    trackPredicate: { op: "clause", clauseId: "prompt:membership:music" },
  });
}

function checkpoint(prompt: string, requestShape: "fully_explicit" | "fixed_list" | "factual" | "curated" = "curated") {
  const contract = baseContract(prompt);
  const spec = createRunSpecV3({
    prompt,
    requestedTrackCount: contract.requestedTrackCount,
    storefront: contract.storefront,
  });
  return {
    contract,
    value: guidanceCheckpointV4({
      prompt,
      baseContract: contract,
      preservedTrackPredicate: contract.trackPredicate,
      ambiguousScopeClauseIds: [],
      criticalAmbiguities: spec.criticalAmbiguities,
      requestShape,
      compilationTimestamp: "2026-07-29T12:00:00.000Z",
    }),
  };
}

describe("GuidanceDecisionV4", () => {
  test("asks a neutral blocking question for an ambiguous bare year", () => {
    const { contract, value } = checkpoint("25 influential 2010 rap songs");
    expect(value.mode).toBe("correctness_blocking");
    expect(value.decisions[0]).toMatchObject({
      axis: "temporal_width",
      question: "What time span should “2010” cover?",
      criticality: "required",
    });
    expect(value.decisions[0]!.options).toHaveLength(3);
    expect(value.decisions[0]!.options.every(({ recommended }) => !recommended)).toBe(true);

    const question = publicGuidanceQuestionV4(value.decisions[0]!);
    const patch = compileGuidanceRoundPatchV3({
      base: contract,
      questionSetHash: value.checkpointHash,
      questions: [question],
      answers: [{ questionId: question.id, optionId: "era_year_only" }],
    });
    expect(patch).not.toBeNull();
    const successor = applyPlaylistContractPatchV1(contract, patch!);
    expect(successor.requestedTrackCount).toBe(25);
    expect(successor.clauses).toContainEqual(expect.objectContaining({
      axis: "era",
      values: ["2010"],
      hardness: "hard",
    }));
  });

  test("uses an editable confirmation instead of manufacturing a fixed-list question", () => {
    const { value } = checkpoint(
      "Use the three exact tracks So What, Freddie Freeloader, and Blue in Green",
      "fixed_list",
    );
    expect(value).toMatchObject({
      mode: "interpretation_confirmation",
      decisions: [],
      showEditableInterpretationSummary: true,
    });
    expect(value.interpretationSummary.count).toBe(25);
  });

  test("offers a protected optional sonic anchor with a no-op keep choice", () => {
    const { value } = checkpoint("Late-Night Smoke: hazy music for a slow midnight drive");
    const decision = value.decisions.find(({ axis }) => axis === "sonic_anchor");
    expect(decision).toBeDefined();
    expect(decision).toMatchObject({
      mode: "nuance_optional",
      criticality: "optional",
    });
    expect(decision!.options.map(({ id }) => id)).toContain("keep_current_interpretation");
    expect(() => assertGuidanceDecisionV4(decision!)).not.toThrow();
    const skipped = compileGuidanceSelectionV4(decision!, { skipped: true });
    expect(skipped).toMatchObject({ state: "accepted", operations: [] });
  });

  test("keeps narrative places out of executable geography and asks about time", () => {
    const prompt = "R&B for my partner and me, inspired by when we met 10 years ago between Long Island and Del Mar";
    const { value } = checkpoint(prompt);
    const decision = value.decisions.find(({ axis }) => axis === "narrative_date_window");
    expect(decision?.question).toBe("How tightly should the music follow when you met?");
    expect(JSON.stringify(decision)).not.toContain("artist_origin");
    expect(JSON.stringify(decision)).not.toContain("recording_location");
    expect(decision?.options).toContainEqual(expect.objectContaining({
      id: "around_meeting_year",
      recommended: true,
    }));
  });

  test("rejects options whose server-owned executable effects collapse", () => {
    expect(() => createGuidanceDecisionV4({
      mode: "correctness_blocking",
      id: "duplicate-effects",
      header: "Scope",
      question: "Which scope?",
      axis: "scope",
      trigger: "correctness",
      criticality: "required",
      selectionMode: "single",
      allowCustom: false,
      baseContractRevisionId: "revision",
      baseContractSemanticHash: "a".repeat(64),
      whyMaterial: "Changes membership.",
      allowedPatchOperations: ["add_clause"],
      affectedClauseIds: ["x"],
      materialityScore: 100,
      options: ["a", "b"].map((id) => ({
        id,
        label: id,
        description: `Option ${id}`,
        recommended: false,
        expectedFeasibilityDirection: "neutral" as const,
        patch: {
          affectedClauseIds: ["x"],
          operations: [{
            op: "add_clause" as const,
            clause: {
              id: "x",
              kind: "ranking_preference" as const,
              scope: "track" as const,
              hardness: "soft" as const,
              axis: "scope",
              operator: "prefer" as const,
              values: ["same"],
              source: { provenance: "guidance" as const, text: "same" },
            },
          }],
        },
      })),
    })).toThrow("guidance_v4_duplicate_option_effect");
  });
});
