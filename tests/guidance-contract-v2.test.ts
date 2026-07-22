import { describe, expect, test } from "vitest";
import {
  compileGuidanceExecutionDeltaV2,
  contractTwoGuidanceQuestion,
  GUIDANCE_POLICY_VERSION,
  guidanceQuestionSetHashV2,
  guidanceRequestClassificationV2,
  planDeltaHasEffect,
} from "../server/guidance-contract-v2.ts";
import { createRunSpecV3 } from "../server/selection-plan-v3.ts";
import type { PlaylistGuidanceQuestion } from "../shared/types.ts";

const optionalQuestion: PlaylistGuidanceQuestion = {
  id: "guided:flow",
  header: "Flow",
  question: "How should the playlist move?",
  decisionKey: "playlist_flow",
  options: [
    {
      id: "flow_smooth",
      label: "Smooth",
      description: "Keep transitions gentle.",
      recommended: true,
      effect: { kind: "ordering_behavior", value: "smooth", orderingBehavior: "smooth" },
    },
    {
      id: "flow_contrast",
      label: "Contrast",
      description: "Use sharper changes.",
      recommended: false,
      effect: { kind: "ordering_behavior", value: "contrast", orderingBehavior: "contrast" },
    },
    {
      id: "flow_editorial",
      label: "Editorial",
      description: "Use an editorial arc.",
      recommended: false,
      effect: { kind: "ordering_behavior", value: "editorial", orderingBehavior: "editorial" },
    },
  ],
};

describe("intelligent guidance contract 2", () => {
  test("classifies precise, critical, broad, and preference requests deterministically", () => {
    const classify = (prompt: string) => guidanceRequestClassificationV2(createRunSpecV3({
      prompt,
      requestedTrackCount: 25,
      storefront: "us",
    }));
    expect(classify("Every track from the album Kind of Blue")).toBe("precise");
    expect(classify("25 house selections")).toBe("critical_ambiguity");
    expect(classify("25 disco songs")).toBe("broad_curated");
    expect(classify("25 essential disco deep cuts")).toBe("preference_ambiguity");
  });

  test("turns every accepted option into a non-empty typed execution delta", () => {
    const question = contractTwoGuidanceQuestion(optionalQuestion, "preference_ambiguity");
    expect(question).toMatchObject({
      selectionMode: "single",
      criticality: "optional",
      allowCustom: true,
      groundingMode: "inference",
    });
    expect(question.options).toHaveLength(3);
    expect(question.options.every((option) => option.planDelta && planDeltaHasEffect(option.planDelta))).toBe(true);
  });

  test("answer compilation is order-independent and explicit skips are inert", () => {
    const first = contractTwoGuidanceQuestion(optionalQuestion, "preference_ambiguity");
    const second = contractTwoGuidanceQuestion({
      ...optionalQuestion,
      id: "guided:depth",
      decisionKey: "playlist_depth",
      options: optionalQuestion.options.map((option, index) => ({
        ...option,
        id: `depth_${index}`,
        effect: {
          kind: "familiarity_bias" as const,
          value: index === 0 ? "deep cuts" : "familiar selections",
          orderingBehavior: null,
        },
      })),
    }, "preference_ambiguity");
    const left = compileGuidanceExecutionDeltaV2([first, second], [
      { questionId: second.id, skipped: true },
      { questionId: first.id, optionId: "flow_smooth" },
    ]);
    const right = compileGuidanceExecutionDeltaV2([first, second], [
      { questionId: first.id, optionId: "flow_smooth" },
      { questionId: second.id, skipped: true },
    ]);
    expect(left).toEqual(right);
    expect(left.delta.sequencingPreference).toBe("smooth");
    expect(left.hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("question-set hashes bind policy, scope, and question content", () => {
    const question = contractTwoGuidanceQuestion(optionalQuestion, "broad_curated");
    const input = {
      classification: "broad_curated" as const,
      prompt: "25 disco songs",
      targetTrackCount: 25,
      storefront: "us",
      locale: "en",
      explicitConstraintHash: "a".repeat(64),
      questions: [question],
    };
    const hash = guidanceQuestionSetHashV2(input);
    expect(hash).toBe(guidanceQuestionSetHashV2(input));
    expect(hash).not.toBe(guidanceQuestionSetHashV2({ ...input, targetTrackCount: 26 }));
    expect(GUIDANCE_POLICY_VERSION).toBe("intelligent_guidance_v2");
  });
});
