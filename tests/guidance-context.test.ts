import { describe, expect, test } from "vitest";
import {
  deriveGuidancePreferences,
  guidanceOrderingPolicy,
  guidanceResearchContext,
} from "../server/guidance-context.ts";
import type { PlaylistGuidanceQuestion } from "../shared/types.ts";

const questions: PlaylistGuidanceQuestion[] = [
  {
    id: "q1",
    decisionKey: "scene_focus",
    header: "Scene",
    question: "Which documented branch should lead?",
    options: [
      { id: "q1-o1", label: "Foundations", description: "Lead with the foundations.", recommended: true, effect: { kind: "subscene_focus", value: "Prioritize the documented founding scene.", orderingBehavior: null } },
      { id: "q1-o2", label: "Second wave", description: "Lead with the second wave.", recommended: false, effect: { kind: "subscene_focus", value: "Prioritize the documented second wave.", orderingBehavior: null } },
      { id: "q1-o3", label: "Diaspora", description: "Lead with its diaspora.", recommended: false, effect: { kind: "subscene_focus", value: "Prioritize the documented diaspora.", orderingBehavior: null } },
    ],
  },
  {
    id: "q2",
    decisionKey: "playlist_flow",
    header: "Flow",
    question: "How should it move?",
    options: [
      { id: "q2-o1", label: "Smooth", description: "Use smooth transitions.", recommended: true, effect: { kind: "ordering_behavior", value: "Use smooth transitions.", orderingBehavior: "smooth" } },
      { id: "q2-o2", label: "Contrast", description: "Use sharp contrasts.", recommended: false, effect: { kind: "ordering_behavior", value: "Use sharp contrasts.", orderingBehavior: "contrast" } },
      { id: "q2-o3", label: "Chronological", description: "Follow release dates.", recommended: false, effect: { kind: "ordering_behavior", value: "Follow release dates.", orderingBehavior: "chronological" } },
    ],
  },
];

describe("durable guidance context", () => {
  test("derives typed effects and applies each one to downstream behavior", () => {
    const preferences = deriveGuidancePreferences(questions, [
      { questionId: "q1", optionId: "q1-o2" },
      { questionId: "q2", optionId: "q2-o2" },
    ]);

    expect(preferences).toEqual([
      expect.objectContaining({ decisionKey: "scene_focus", kind: "subscene_focus", source: "option" }),
      expect.objectContaining({ decisionKey: "playlist_flow", kind: "ordering_behavior", orderingBehavior: "contrast" }),
    ]);
    expect(guidanceResearchContext(preferences)).toEqual({
      researchDirectives: [
        "Scene/geographic focus for discovery and candidate selection: Prioritize the documented second wave.",
        "Listening-flow preference: Use sharp contrasts.",
      ],
      orderingBehavior: "contrast",
    });
    expect(guidanceOrderingPolicy("editorial rank", preferences))
      .toBe("high-contrast listening flow with artist and album intermixing");
  });

  test("keeps custom text bounded and on a typed research-only axis", () => {
    const preferences = deriveGuidancePreferences(questions, [
      { questionId: "q1", customText: `  Focus on a tiny local branch ${"x".repeat(800)}  ` },
    ]);
    expect(preferences).toHaveLength(1);
    expect(preferences[0]).toMatchObject({
      questionId: "q1",
      decisionKey: "scene_focus",
      kind: "research_preference",
      source: "custom",
      orderingBehavior: null,
    });
    expect(preferences[0]!.value.length).toBeLessThanOrEqual(500);
    expect(guidanceOrderingPolicy("chronological", preferences)).toBe("chronological");
  });
});
