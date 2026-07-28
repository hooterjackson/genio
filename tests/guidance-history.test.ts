import { describe, expect, test } from "vitest";
import {
  createGuidanceDecisionV3,
} from "../server/adaptive-guidance-v3.ts";
import {
  publicGuidanceQuestionV3,
} from "../server/adaptive-guidance-contract-bridge.ts";
import {
  compilePlaylistContractRevisionV1,
} from "../server/playlist-contract-v1.ts";
import {
  regeneratedDependentGuidanceRound,
} from "../server/repository.ts";

function baseContract() {
  return compilePlaylistContractRevisionV1({
    contractId: "guidance-history-unit",
    rawPrompt: "Create a 20-track Latin playlist",
    requestedTrackCount: 20,
    locale: "en-US",
    storefront: "us",
    clauses: [{
      id: "membership:genre",
      kind: "membership",
      scope: "track",
      hardness: "hard",
      axis: "genre",
      operator: "require",
      values: ["Bachata"],
      source: { provenance: "guidance", text: "Bachata" },
      unknownPolicy: "reject",
    }],
    trackPredicate: { op: "clause", clauseId: "membership:genre" },
  });
}

function dependentQuestion(
  base: ReturnType<typeof baseContract>,
  values: readonly [string, string],
) {
  return publicGuidanceQuestionV3(createGuidanceDecisionV3({
    id: "guidance:dependent:genre",
    header: "Genre scope",
    question: "Which later genre scope should apply?",
    axis: "dependent_genre",
    trigger: "yield_risk",
    criticality: "required",
    selectionMode: "single",
    allowCustom: false,
    baseContractRevisionId: "stale-revision",
    baseContractSemanticHash: "a".repeat(64),
    whyMaterial: "Changes the later hard genre decision.",
    allowedPatchOperations: ["replace_clause"],
    affectedClauseIds: ["membership:genre"],
    materialityScore: 80,
    options: values.map((value, index) => ({
      id: `option-${index}`,
      label: value,
      description: `Require ${value}.`,
      recommended: index === 0,
      expectedFeasibilityDirection: "neutral" as const,
      patch: {
        affectedClauseIds: ["membership:genre"],
        operations: [{
          op: "replace_clause" as const,
          clauseId: "membership:genre",
          clause: {
            id: "membership:genre",
            kind: "membership" as const,
            scope: "track" as const,
            hardness: "hard" as const,
            axis: "genre",
            operator: "require" as const,
            values: [value],
            source: { provenance: "guidance" as const, text: value },
            unknownPolicy: "reject" as const,
          },
        }],
      },
    })),
  }));
}

describe("dependent guidance regeneration", () => {
  test("drops a later question whose options no longer produce distinct outcomes", () => {
    const base = baseContract();
    expect(regeneratedDependentGuidanceRound({
      base,
      questions: [dependentQuestion(base, ["Latin pop", "Latin pop"])],
      stage: "rescue",
    })).toBeNull();
  });

  test("reissues a still-material question with fresh contract-bound hashes", () => {
    const base = baseContract();
    const regenerated = regeneratedDependentGuidanceRound({
      base,
      questions: [dependentQuestion(base, ["Latin pop", "Dembow"])],
      stage: "rescue",
    });
    expect(regenerated).not.toBeNull();
    expect(regenerated?.questions[0]).toMatchObject({
      baseContractRevisionId: base.revisionId,
      baseContractSemanticHash: base.semanticHash,
    });
    expect(regenerated?.questionSetHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("returns an explicit zero-question summary after two attempts on the same axis", () => {
    const base = baseContract();
    expect(regeneratedDependentGuidanceRound({
      base,
      questions: [dependentQuestion(base, ["Latin pop", "Dembow"])],
      stage: "rescue",
      clarificationAttemptsByAxis: { dependent_genre: 2 },
    })).toMatchObject({
      questions: [],
      trigger: "yield_risk",
      axis: "dependent_genre",
      showEditableInterpretationSummary: true,
      summaryReason: "clarification_attempt_limit",
    });
  });
});
