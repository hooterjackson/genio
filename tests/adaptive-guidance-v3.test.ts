import { describe, expect, test } from "vitest";
import {
  compileCustomGuidanceAnswerV3,
  compileGuidanceSelectionV3,
  createGuidanceDecisionV3,
  customGuidanceConfirmationDecisionV3,
  deterministicGuidanceCandidatesV3,
  frenchJazzGuidanceDecisionV3,
  guidanceContractPatchV1,
  isSmoothReggaetonHeatRequestV3,
  playlistInterpretationSummaryV1,
  predicateYieldRescueGuidanceDecisionV3,
  rareScopeGuidanceDecisionV3,
  recompileCustomGuidanceTextV3,
  recommendedGuidanceAnswersV3,
  selectGuidanceRoundV3,
  SMOOTH_REGGAETON_HEAT_PROMPT,
  smoothReggaetonHeatGuidanceDecisionV3,
  type GuidanceCriticalityV3,
  type GuidanceDecisionV3,
  type GuidanceTriggerV3,
  type ServerCompiledCustomGuidanceV3,
} from "../server/adaptive-guidance-v3.ts";
import {
  applyPlaylistContractPatchV1,
  compilePlaylistContractRevisionV1,
} from "../server/playlist-contract-v1.ts";

function decision(input: {
  id: string;
  axis: string;
  trigger: GuidanceTriggerV3;
  criticality?: GuidanceCriticalityV3;
  materialityScore?: number;
}): GuidanceDecisionV3 {
  const clauseId = `clause:${input.axis}`;
  return createGuidanceDecisionV3({
    id: input.id,
    header: input.axis,
    question: `Choose ${input.axis}`,
    axis: input.axis,
    trigger: input.trigger,
    criticality: input.criticality ?? "optional",
    selectionMode: "single",
    allowCustom: true,
    baseContractRevisionId: "contract-revision-1",
    baseContractSemanticHash: "a".repeat(64),
    whyMaterial: `Changes ${input.axis}`,
    allowedPatchOperations: ["replace_clause"],
    affectedClauseIds: [clauseId],
    materialityScore: input.materialityScore ?? 50,
    options: [
      {
        id: `${input.id}:recommended`,
        label: "Recommended",
        description: "Use the recommended interpretation.",
        recommended: true,
        expectedFeasibilityDirection: "neutral",
        patch: {
          affectedClauseIds: [clauseId],
          operations: [{
            op: "replace_clause",
            clauseId,
            clause: {
              id: clauseId,
              kind: "ranking_preference",
              scope: "playlist",
              hardness: "soft",
              axis: input.axis,
              operator: "prefer",
              values: ["recommended"],
              source: { provenance: "guidance", text: "recommended" },
            },
          }],
        },
      },
      {
        id: `${input.id}:alternate`,
        label: "Alternate",
        description: "Use the alternate interpretation.",
        recommended: false,
        expectedFeasibilityDirection: "narrower",
        patch: {
          affectedClauseIds: [clauseId],
          operations: [{
            op: "replace_clause",
            clauseId,
            clause: {
              id: clauseId,
              kind: "ranking_preference",
              scope: "playlist",
              hardness: "soft",
              axis: input.axis,
              operator: "prefer",
              values: ["alternate"],
              source: { provenance: "guidance", text: "alternate" },
            },
          }],
        },
      },
    ],
  });
}

describe("adaptive guidance v3", () => {
  test("asks exactly one semantic question for the production Smooth Reggaeton Heat request", () => {
    expect(isSmoothReggaetonHeatRequestV3(SMOOTH_REGGAETON_HEAT_PROMPT)).toBe(true);
    const input = {
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      baseContractRevisionId: "contract-reggaeton-1",
      baseContractSemanticHash: "b".repeat(64),
      preservedTrackPredicate: null,
      ambiguousScopeClauseIds: [],
    };
    const candidates = deterministicGuidanceCandidatesV3(input);
    expect(candidates).toHaveLength(1);
    const question = smoothReggaetonHeatGuidanceDecisionV3(input);
    expect(question).toMatchObject({
      question: "How far should “adjacent Latin urban” extend?",
      axis: "adjacent_latin_urban_scope",
      trigger: "correctness",
      criticality: "required",
      options: [
        {
          id: "core_reggaeton_only",
          recommended: false,
          expectedFeasibilityDirection: "narrower",
        },
        {
          id: "reggaeton_dembow_latin_urban",
          recommended: true,
          expectedFeasibilityDirection: "neutral",
        },
        {
          id: "broader_latin_crossover",
          recommended: false,
          expectedFeasibilityDirection: "broader",
        },
      ],
    });
    const serialized = JSON.stringify(question);
    expect(serialized).toContain('"minimumRatio":0.7');
    expect(serialized).toContain('"selectedConceptId":"genre:reggaeton"');
    expect(serialized).toContain('"selectedConceptId":"genre:dembow"');
    expect(serialized).toContain('"selectedConceptId":"genre:latin-urban"');
    expect(serialized).toContain('"selectedConceptId":"genre:latin-pop"');
    expect(serialized).not.toContain("smoothness");
    expect(serialized).not.toContain("sensuality");
  });

  test("applies the recommended reggaeton answer atomically to the canonical contract", () => {
    const ambiguousClauseId = "prompt:membership:adjacent-latin-urban";
    const base = compilePlaylistContractRevisionV1({
      contractId: "smooth-reggaeton-heat",
      rawPrompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      requestedTrackCount: 50,
      locale: "en",
      storefront: "us",
      clauses: [{
        id: ambiguousClauseId,
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "genre",
        operator: "require",
        conceptInputs: [{
          text: "Latin urban",
          expectedKind: "genre",
          selectedConceptId: "genre:latin-urban",
        }],
        source: { provenance: "prompt", text: "adjacent Latin urban" },
      }],
      trackPredicate: { op: "clause", clauseId: ambiguousClauseId },
    });
    const question = smoothReggaetonHeatGuidanceDecisionV3({
      prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
      baseContractRevisionId: base.revisionId,
      baseContractSemanticHash: base.semanticHash,
      preservedTrackPredicate: null,
      ambiguousScopeClauseIds: [ambiguousClauseId],
    })!;
    const selected = compileGuidanceSelectionV3(question, {
      optionIds: ["reggaeton_dembow_latin_urban"],
    });
    const patch = guidanceContractPatchV1({
      decision: question,
      questionSetHash: "d".repeat(64),
      accepted: {
        answerHash: selected.answerHash,
        executableOperations: selected.operations,
      },
    });
    const revised = applyPlaylistContractPatchV1(base, patch!);
    expect(revised).toMatchObject({
      revision: 2,
      requestedTrackCount: 50,
      parentRevisionId: base.revisionId,
      playlistConstraints: [{
        id: "quota:genre:core-reggaeton-share",
        minimumRatio: 0.7,
        maximumRatio: 1,
      }],
      trackPredicate: {
        op: "any",
      },
    });
    expect(revised.clauses.map(({ id }) => id)).not.toContain(ambiguousClauseId);
    expect(revised.clauses.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "guidance:membership:core-reggaeton",
      "guidance:membership:dembow",
      "guidance:membership:latin-urban",
      "guidance:quota:core-reggaeton-share",
    ]));
  });

  test("creates deterministic hash-bound server-owned decisions", () => {
    const first = decision({ id: "depth", axis: "discovery_depth", trigger: "nuance" });
    const second = decision({ id: "depth", axis: "discovery_depth", trigger: "nuance" });
    expect(first).toEqual(second);
    expect(first.questionHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(() => createGuidanceDecisionV3({
      ...first,
      id: "invalid",
      questionHash: undefined,
      allowedPatchOperations: [],
    } as never)).toThrow();
  });

  test("asks correctness first, keeps ordinary initial rounds to two, and allows only one nuance question", () => {
    const correctness = decision({
      id: "scope",
      axis: "scope",
      trigger: "correctness",
      criticality: "required",
      materialityScore: 100,
    });
    const yieldRisk = decision({
      id: "breadth",
      axis: "breadth",
      trigger: "yield_risk",
      materialityScore: 90,
    });
    const nuance = decision({
      id: "depth",
      axis: "depth",
      trigger: "nuance",
      materialityScore: 80,
    });
    const secondNuance = decision({
      id: "flow",
      axis: "flow",
      trigger: "nuance",
      materialityScore: 70,
    });
    const round = selectGuidanceRoundV3({
      stage: "initial",
      requestShape: "curated",
      candidates: [secondNuance, nuance, yieldRisk, correctness],
    });
    expect(round.decisions.map(({ id }) => id)).toEqual(["scope", "breadth"]);
    expect(round.rejectedDecisionReasons).toMatchObject({
      depth: "round_question_limit",
      flow: "optional_nuance_limit",
    });
  });

  test("asks no optional questions for fixed, factual, or fully explicit requests", () => {
    const optional = decision({
      id: "depth",
      axis: "depth",
      trigger: "nuance",
    });
    for (const requestShape of ["fixed_list", "factual", "fully_explicit"] as const) {
      expect(selectGuidanceRoundV3({
        stage: "initial",
        requestShape,
        candidates: [optional],
      }).decisions).toEqual([]);
    }
  });

  test("does not repeat explicit/answered axes and stops after two failed clarification attempts", () => {
    const depth = decision({ id: "depth", axis: "depth", trigger: "nuance" });
    const scope = decision({
      id: "scope",
      axis: "scope",
      trigger: "correctness",
      criticality: "required",
    });
    const round = selectGuidanceRoundV3({
      stage: "initial",
      requestShape: "curated",
      candidates: [depth, scope],
      explicitAxes: ["depth"],
      clarificationAttemptsByAxis: { scope: 2 },
    });
    expect(round.decisions).toEqual([]);
    expect(round.showEditableInterpretationSummary).toBe(true);
    expect(round.rejectedDecisionReasons).toEqual({
      depth: "axis_already_explicit",
      scope: "clarification_attempt_limit",
    });
  });

  test("limits rescue guidance to one question per revision and two questions overall", () => {
    const breadth = decision({
      id: "breadth",
      axis: "breadth",
      trigger: "yield_risk",
      materialityScore: 90,
    });
    const depth = decision({
      id: "depth",
      axis: "depth",
      trigger: "nuance",
      materialityScore: 80,
    });
    expect(selectGuidanceRoundV3({
      stage: "rescue",
      requestShape: "curated",
      candidates: [depth, breadth],
      rescueQuestionsAlreadyAsked: 1,
    }).decisions.map(({ id }) => id)).toEqual(["breadth"]);
    const exhausted = selectGuidanceRoundV3({
      stage: "rescue",
      requestShape: "curated",
      candidates: [breadth],
      rescueQuestionsAlreadyAsked: 2,
    });
    expect(exhausted.decisions).toEqual([]);
    expect(exhausted.showDecisionPanel).toBe(true);
  });

  test("offers one named-predicate rescue without changing count or unrelated hard rules", () => {
    const base = compilePlaylistContractRevisionV1({
      contractId: "rare-french-jazz-rescue",
      rawPrompt: "100 rare French jazz recordings from the 1970s",
      requestedTrackCount: 100,
      locale: "en",
      storefront: "us",
      clauses: [
        {
          id: "prompt:genre:jazz",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "genre",
          operator: "require",
          values: ["jazz"],
          source: { provenance: "prompt", text: "Jazz" },
        },
        {
          id: "prompt:era:1970s",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "era",
          operator: "require",
          values: ["1970s"],
          source: { provenance: "prompt", text: "Recorded in the 1970s" },
        },
      ],
      trackPredicate: {
        op: "all",
        children: [
          { op: "clause", clauseId: "prompt:genre:jazz" },
          { op: "clause", clauseId: "prompt:era:1970s" },
        ],
      },
    });
    const rescue = predicateYieldRescueGuidanceDecisionV3({
      baseContract: base,
      limitingClauseIds: ["prompt:era:1970s"],
    });
    expect(rescue).toMatchObject({
      axis: "rescue_predicate:prompt:era:1970s",
      trigger: "yield_risk",
      criticality: "optional",
      options: [
        { id: "keep_as_preference", recommended: true },
        { id: "remove_named_rule", recommended: false },
      ],
    });
    const round = selectGuidanceRoundV3({
      stage: "rescue",
      requestShape: "curated",
      candidates: [rescue!],
      rescueQuestionsAlreadyAsked: 0,
    });
    expect(round.decisions).toHaveLength(1);
    const compiled = compileGuidanceSelectionV3(rescue!, {
      optionIds: ["keep_as_preference"],
    });
    const revised = applyPlaylistContractPatchV1(base, guidanceContractPatchV1({
      decision: rescue!,
      questionSetHash: round.roundHash,
      accepted: {
        answerHash: compiled.answerHash,
        executableOperations: compiled.operations,
      },
    })!);
    expect(revised.requestedTrackCount).toBe(100);
    expect(revised.trackPredicate).toEqual({
      op: "clause",
      clauseId: "prompt:genre:jazz",
    });
    expect(revised.clauses.find(({ id }) => id === "prompt:genre:jazz")?.hardness).toBe("hard");
    expect(revised.clauses.find(({ id }) => id === "prompt:era:1970s")).toMatchObject({
      hardness: "soft",
      kind: "ranking_preference",
      operator: "prefer",
    });
  });

  test("applies recommended defaults only to optional questions", () => {
    const required = decision({
      id: "scope",
      axis: "scope",
      trigger: "correctness",
      criticality: "required",
    });
    const optional = decision({ id: "depth", axis: "depth", trigger: "nuance" });
    const defaults = recommendedGuidanceAnswersV3([required, optional]);
    expect(defaults.answers).toEqual([{
      questionHash: optional.questionHash,
      optionIds: ["depth:recommended"],
    }]);
    expect(defaults.unresolvedRequiredQuestionHashes).toEqual([required.questionHash]);
    expect(compileGuidanceSelectionV3(required, { skipped: true }).state).toBe("required_answer_missing");
    expect(compileGuidanceSelectionV3(optional, { skipped: true })).toMatchObject({
      state: "accepted",
      operations: [],
    });
  });

  test("compiles selected options deterministically and rejects cross-question options", () => {
    const depth = decision({ id: "depth", axis: "depth", trigger: "nuance" });
    const accepted = compileGuidanceSelectionV3(depth, {
      optionIds: ["depth:recommended"],
    });
    expect(accepted).toMatchObject({
      state: "accepted",
      selectedOptionIds: ["depth:recommended"],
      affectedClauseIds: ["clause:depth"],
    });
    expect(accepted.answerHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(guidanceContractPatchV1({
      decision: depth,
      questionSetHash: "c".repeat(64),
      accepted: {
        answerHash: accepted.answerHash,
        executableOperations: accepted.operations,
      },
    })).toMatchObject({
      baseRevisionId: "contract-revision-1",
      baseSemanticHash: "a".repeat(64),
      answerLineage: {
        questionSetHash: "c".repeat(64),
        questionId: "depth",
        answerHash: accepted.answerHash,
      },
    });
    expect(() => compileGuidanceSelectionV3(depth, {
      optionIds: ["different-question:recommended"],
    })).toThrow("unknown_guidance_option");
  });

  test("never executes custom prose and requires confirmation for hard contract changes", () => {
    const scope = decision({
      id: "scope",
      axis: "scope",
      trigger: "correctness",
      criticality: "required",
    });
    expect(compileCustomGuidanceAnswerV3({
      decision: scope,
      customText: "Only core reggaeton",
      serverCompiled: null,
      confirmed: false,
    })).toMatchObject({
      state: "needs_recompile",
      executableOperations: null,
    });
    const hardPatch: ServerCompiledCustomGuidanceV3 = {
      affectedClauseIds: ["clause:scope"],
      operations: [{
        op: "replace_clause",
        clauseId: "clause:scope",
        clause: {
          id: "clause:scope",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "genre",
          operator: "require",
          conceptInputs: [{
            text: "reggaeton",
            expectedKind: "genre",
            selectedConceptId: "genre:reggaeton",
          }],
          source: { provenance: "guidance", text: "Only core reggaeton" },
        },
      }],
    };
    expect(compileCustomGuidanceAnswerV3({
      decision: scope,
      customText: "Only core reggaeton",
      serverCompiled: hardPatch,
      confirmed: false,
    })).toMatchObject({
      state: "needs_confirmation",
      hardChangeReasons: ["hard_clause_changed"],
      executableOperations: null,
    });
    expect(compileCustomGuidanceAnswerV3({
      decision: scope,
      customText: "Only core reggaeton",
      serverCompiled: hardPatch,
      confirmed: true,
    })).toMatchObject({
      state: "accepted",
      hardChangeReasons: ["hard_clause_changed"],
      executableOperations: hardPatch.operations,
    });
  });

  test("asks a generic typed French-jazz relationship question instead of matching one exact prompt", () => {
    const base = compilePlaylistContractRevisionV1({
      contractId: "french-jazz",
      rawPrompt: "Build me 50 French jazz essentials across eras",
      requestedTrackCount: 50,
      locale: "en",
      storefront: "fr",
      clauses: [
        {
          id: "prompt:jazz",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "genre",
          operator: "require",
          values: ["jazz"],
          source: { provenance: "prompt", text: "jazz" },
        },
        {
          id: "prompt:french",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "geography",
          operator: "require",
          values: ["French"],
          source: { provenance: "prompt", text: "French" },
        },
      ],
      trackPredicate: {
        op: "all",
        children: [
          { op: "clause", clauseId: "prompt:jazz" },
          { op: "clause", clauseId: "prompt:french" },
        ],
      },
    });
    const question = frenchJazzGuidanceDecisionV3({
      prompt: base.rawPrompt,
      baseContract: base,
    });
    expect(question).toMatchObject({
      question: "What should “French” mean for this jazz playlist?",
      trigger: "correctness",
      criticality: "required",
      options: [
        { id: "french_jazz_scene", recommended: true },
        { id: "french_artist_origin" },
        { id: "recorded_in_france" },
        { id: "french_language_jazz" },
      ],
    });
    const selected = compileGuidanceSelectionV3(question!, {
      optionIds: ["french_artist_origin"],
    });
    const revised = applyPlaylistContractPatchV1(base, guidanceContractPatchV1({
      decision: question!,
      questionSetHash: "e".repeat(64),
      accepted: {
        answerHash: selected.answerHash,
        executableOperations: selected.operations,
      },
    })!);
    expect(revised.clauses.map(({ id }) => id)).not.toContain("prompt:french");
    expect(revised.clauses).toContainEqual(expect.objectContaining({
      id: "guidance:french-jazz:relationship",
      axis: "geography",
      values: ["France", "relationship:artist_origin"],
    }));
    expect(revised.trackPredicate).toEqual(expect.objectContaining({ op: "all" }));
  });

  test("offers count-preserving yield guidance for rare 100-track scopes", () => {
    const base = compilePlaylistContractRevisionV1({
      contractId: "rare-scope",
      rawPrompt: "100 rare spiritual jazz deep cuts",
      requestedTrackCount: 100,
      locale: "en",
      storefront: "us",
      clauses: [{
        id: "prompt:jazz",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "genre",
        operator: "require",
        values: ["jazz"],
        source: { provenance: "prompt", text: "jazz" },
      }],
      trackPredicate: { op: "clause", clauseId: "prompt:jazz" },
    });
    const question = rareScopeGuidanceDecisionV3({
      prompt: base.rawPrompt,
      baseContract: base,
    });
    expect(question).toMatchObject({
      trigger: "yield_risk",
      criticality: "optional",
    });
    expect(question?.options[0]).toMatchObject({
      id: "strict_documented_rarity",
      recommended: true,
    });
    expect(JSON.stringify(question)).not.toContain("set_requested_track_count");
    expect(deterministicGuidanceCandidatesV3({
      prompt: base.rawPrompt,
      baseContractRevisionId: base.revisionId,
      baseContractSemanticHash: base.semanticHash,
      preservedTrackPredicate: base.trackPredicate,
      ambiguousScopeClauseIds: [],
      baseContract: base,
    }).map(({ id }) => id)).toContain("guidance:rare-scope:breadth");
  });

  test("recompiles custom hard rules into a reviewable successor summary before execution", () => {
    const base = compilePlaylistContractRevisionV1({
      contractId: "custom-guidance",
      rawPrompt: "50 polished reggaeton tracks",
      requestedTrackCount: 50,
      locale: "en",
      storefront: "us",
      clauses: [{
        id: "prompt:reggaeton",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "genre",
        operator: "require",
        conceptInputs: [{
          text: "reggaeton",
          expectedKind: "genre",
          selectedConceptId: "genre:reggaeton",
        }],
        source: { provenance: "prompt", text: "reggaeton" },
      }],
      trackPredicate: { op: "clause", clauseId: "prompt:reggaeton" },
    });
    const compiled = recompileCustomGuidanceTextV3({
      base,
      customText: "mostly women, clean, no Bad Bunny",
    });
    expect(compiled.hardChangeReasons).toEqual([
      "content_policy_changed",
      "exclusion_changed",
      "playlist_quota_changed",
    ]);
    expect(compiled.summary).toMatchObject({
      count: 50,
      avoid: ["No recordings by Bad Bunny"],
    });
    expect(compiled.summary.mustHave).toEqual(expect.arrayContaining([
      "Clean versions only",
      "At least 51% Tracks by women artists",
    ]));

    const confirmation = customGuidanceConfirmationDecisionV3({ base, compiled });
    expect(confirmation).toMatchObject({
      question: "Apply this revised playlist contract?",
      allowCustom: false,
      interpretationSummary: compiled.summary,
      options: [
        { id: "apply_revised_interpretation", recommended: true },
        { id: "keep_current_interpretation", recommended: false },
      ],
    });
    const selected = compileGuidanceSelectionV3(confirmation, {
      optionIds: ["apply_revised_interpretation"],
    });
    const revised = applyPlaylistContractPatchV1(base, guidanceContractPatchV1({
      decision: confirmation,
      questionSetHash: "f".repeat(64),
      accepted: {
        answerHash: selected.answerHash,
        executableOperations: selected.operations,
      },
    })!);
    expect(playlistInterpretationSummaryV1(revised)).toEqual(compiled.summary);
    expect(revised.requestedTrackCount).toBe(50);

    const kept = compileGuidanceSelectionV3(confirmation, {
      optionIds: ["keep_current_interpretation"],
    });
    expect(kept).toMatchObject({
      state: "accepted",
      selectedOptionIds: ["keep_current_interpretation"],
      operations: [],
      affectedClauseIds: [],
    });
    expect(guidanceContractPatchV1({
      decision: confirmation,
      questionSetHash: "e".repeat(64),
      accepted: {
        answerHash: kept.answerHash,
        executableOperations: kept.operations,
      },
    })).toBeNull();
  });
});
