import { describe, expect, test } from "vitest";
import {
  compileCustomGuidanceAnswerV3,
  compileGuidanceSelectionV3,
  createGuidanceDecisionV3,
  customGuidanceConfirmationDecisionV3,
  criticalAmbiguityGuidanceDecisionV3,
  deterministicGuidanceCandidatesV3,
  exactArtistIdentityAmbiguityGuidanceDecisionV3,
  flowNuanceGuidanceDecisionV3,
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
import {
  projectPlaylistContractExecutionV1,
} from "../server/playlist-contract-execution-bridge-v1.ts";
import {
  AUTHENTICATED_OWNER_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
} from "../server/playlist-count-policy.ts";
import {
  evaluateCanonicalContractTrackV1,
} from "../server/canonical-contract-runtime-v1.ts";
import {
  compileGuidanceRoundPatchV3,
  publicGuidanceQuestionV3,
} from "../server/adaptive-guidance-contract-bridge.ts";
import {
  compilePlaylistContractShadowV1,
} from "../server/playlist-contract-shadow-bridge-v1.ts";
import {
  createSelectionPlanV2,
} from "../server/selection-plan-v2.ts";
import {
  createRunSpecV3,
} from "../server/selection-plan-v3.ts";
import type {
  PlaylistBrief,
} from "../shared/types.ts";

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
      allowCustom: false,
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

  test("projects a bare-house ambiguity into one required typed contract revision", () => {
    const prompt = "Make me a 25-track house playlist";
    const base = compilePlaylistContractRevisionV1({
      contractId: "ambiguous-house",
      rawPrompt: prompt,
      requestedTrackCount: 25,
      locale: "en",
      storefront: "us",
      clauses: [
        {
          id: "prompt:ambiguous-house",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "genre",
          operator: "require",
          values: ["house"],
          source: { provenance: "prompt", text: "house" },
        },
        {
          id: "prompt:era",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "era",
          operator: "require",
          values: ["1990s onward"],
          source: { provenance: "migration", text: "1990s onward" },
        },
      ],
      trackPredicate: {
        op: "all",
        children: [
          { op: "clause", clauseId: "prompt:ambiguous-house" },
          { op: "clause", clauseId: "prompt:era" },
        ],
      },
    });
    const spec = createRunSpecV3({ prompt, requestedTrackCount: 25 });
    const candidates = deterministicGuidanceCandidatesV3({
      prompt,
      baseContractRevisionId: base.revisionId,
      baseContractSemanticHash: base.semanticHash,
      preservedTrackPredicate: base.trackPredicate,
      ambiguousScopeClauseIds: ["prompt:ambiguous-house"],
      baseContract: base,
      criticalAmbiguities: spec.criticalAmbiguities,
    });
    const round = selectGuidanceRoundV3({
      stage: "initial",
      requestShape: "curated",
      candidates,
    });
    expect(round.decisions).toHaveLength(1);
    expect(round.decisions[0]).toMatchObject({
      id: "v3-critical:house_semantics",
      axis: "house_semantics",
      trigger: "correctness",
      criticality: "required",
      options: [
        expect.objectContaining({ id: "house_genre", recommended: true }),
        expect.objectContaining({ id: "house_theme" }),
        expect.objectContaining({ id: "house_both" }),
      ],
    });

    const selected = compileGuidanceSelectionV3(round.decisions[0]!, {
      optionIds: ["house_theme"],
    });
    const revised = applyPlaylistContractPatchV1(base, guidanceContractPatchV1({
      decision: round.decisions[0]!,
      questionSetHash: round.roundHash,
      accepted: {
        answerHash: selected.answerHash,
        executableOperations: selected.operations,
      },
    })!);
    expect(revised.requestedTrackCount).toBe(25);
    expect(revised.clauses.map(({ id }) => id)).not.toContain(
      "prompt:ambiguous-house",
    );
    expect(revised.clauses).toContainEqual(expect.objectContaining({
      id: "guidance:critical:house-semantics:theme",
      axis: "theme",
      hardness: "hard",
      values: ["houses and homes"],
    }));
    expect(JSON.stringify(revised.trackPredicate)).toContain("prompt:era");
    expect(JSON.stringify(revised.trackPredicate)).toContain(
      "guidance:critical:house-semantics:theme",
    );
    expect(JSON.stringify(revised.trackPredicate)).not.toContain(
      "prompt:ambiguous-house",
    );
  });

  test("keeps a factual possessive blocker while suppressing its optional flow question", () => {
    const prompt = "Paulinho da Costa's 25 most influential songs with a listening flow";
    const base = compilePlaylistContractRevisionV1({
      contractId: "possessive-factual",
      rawPrompt: prompt,
      requestedTrackCount: 25,
      locale: "en",
      storefront: "us",
      clauses: [{
        id: "prompt:ambiguous-relationship",
        kind: "factual_relationship",
        scope: "track",
        hardness: "hard",
        axis: "relationship",
        operator: "require",
        values: ["Paulinho da Costa's influential songs"],
        source: {
          provenance: "prompt",
          text: "Paulinho da Costa's 25 most influential songs",
        },
      }],
      trackPredicate: {
        op: "clause",
        clauseId: "prompt:ambiguous-relationship",
      },
    });
    const spec = createRunSpecV3({ prompt, requestedTrackCount: 25 });
    const candidates = deterministicGuidanceCandidatesV3({
      prompt,
      baseContractRevisionId: base.revisionId,
      baseContractSemanticHash: base.semanticHash,
      preservedTrackPredicate: base.trackPredicate,
      ambiguousScopeClauseIds: [],
      baseContract: base,
      criticalAmbiguities: spec.criticalAmbiguities,
    });
    expect(candidates.map(({ id }) => id)).toEqual([
      "v3-critical:possessive_relationship",
      "guidance:flow:shape",
    ]);
    const round = selectGuidanceRoundV3({
      stage: "initial",
      requestShape: "factual",
      candidates,
    });
    expect(round.decisions.map(({ id }) => id)).toEqual([
      "v3-critical:possessive_relationship",
    ]);
    expect(round.rejectedDecisionReasons).toMatchObject({
      "guidance:flow:shape": "request_needs_no_guidance",
    });

    const decision = criticalAmbiguityGuidanceDecisionV3({
      ambiguity: spec.criticalAmbiguities[0]!,
      baseContract: base,
    });
    expect(decision.allowCustom).toBe(false);
    const selected = compileGuidanceSelectionV3(decision, {
      optionIds: ["subject_created"],
    });
    const revised = applyPlaylistContractPatchV1(base, guidanceContractPatchV1({
      decision,
      questionSetHash: round.roundHash,
      accepted: {
        answerHash: selected.answerHash,
        executableOperations: selected.operations,
      },
    })!);
    expect(revised.clauses.map(({ id }) => id)).not.toContain(
      "prompt:ambiguous-relationship",
    );
    expect(revised.clauses).toContainEqual(expect.objectContaining({
      id: "guidance:critical:possessive-relationship:created",
      kind: "factual_relationship",
      axis: "factual_relationship",
      values: expect.arrayContaining([
        "paulinho da costa: wrote, composed, arranged, or produced the exact recording",
      ]),
    }));
  });

  test("composes two required correctness answers without reviving either removed ambiguity", () => {
    const prompt =
      "French jazz: Paulinho da Costa's 25 most influential songs";
    const base = compilePlaylistContractRevisionV1({
      contractId: "multi-critical-round",
      rawPrompt: prompt,
      requestedTrackCount: 25,
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
      }, {
        id: "prompt:ambiguous-french",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "geography",
        operator: "require",
        values: ["French"],
        source: { provenance: "prompt", text: "French jazz" },
      }, {
        id: "prompt:ambiguous-relationship",
        kind: "factual_relationship",
        scope: "track",
        hardness: "hard",
        axis: "relationship",
        operator: "require",
        values: ["Paulinho da Costa's influential songs"],
        source: {
          provenance: "prompt",
          text: "Paulinho da Costa's 25 most influential songs",
        },
      }],
      trackPredicate: {
        op: "all",
        children: [
          { op: "clause", clauseId: "prompt:jazz" },
          { op: "clause", clauseId: "prompt:ambiguous-french" },
          { op: "clause", clauseId: "prompt:ambiguous-relationship" },
        ],
      },
    });
    const spec = createRunSpecV3({ prompt, requestedTrackCount: 25 });
    expect(spec.criticalAmbiguities.map(({ key }) => key)).toEqual([
      "french_jazz_scope",
      "possessive_relationship",
    ]);
    const candidates = deterministicGuidanceCandidatesV3({
      prompt,
      baseContractRevisionId: base.revisionId,
      baseContractSemanticHash: base.semanticHash,
      preservedTrackPredicate: base.trackPredicate,
      ambiguousScopeClauseIds: [],
      baseContract: base,
      criticalAmbiguities: spec.criticalAmbiguities,
    });
    const round = selectGuidanceRoundV3({
      stage: "initial",
      requestShape: "factual",
      candidates,
    });
    expect(round.decisions.map(({ id }) => id)).toEqual([
      "v3-critical:french_jazz_scope",
      "v3-critical:possessive_relationship",
    ]);
    const patch = compileGuidanceRoundPatchV3({
      base,
      questionSetHash: round.roundHash,
      questions: round.decisions.map(publicGuidanceQuestionV3),
      answers: [{
        questionId: "v3-critical:french_jazz_scope",
        optionId: "french_artist_origin",
      }, {
        questionId: "v3-critical:possessive_relationship",
        optionId: "subject_performed",
      }],
    });
    const revised = applyPlaylistContractPatchV1(base, patch!);
    expect(revised.clauses.map(({ id }) => id)).not.toEqual(
      expect.arrayContaining([
        "prompt:ambiguous-french",
        "prompt:ambiguous-relationship",
      ]),
    );
    expect(revised.clauses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "guidance:critical:french-jazz-scope:artist-origin",
        axis: "geography",
      }),
      expect.objectContaining({
        id: "guidance:critical:possessive-relationship:performed",
        axis: "factual_relationship",
      }),
    ]));
    const predicate = JSON.stringify(revised.trackPredicate);
    expect(predicate).toContain("prompt:jazz");
    expect(predicate).toContain(
      "guidance:critical:french-jazz-scope:artist-origin",
    );
    expect(predicate).toContain(
      "guidance:critical:possessive-relationship:performed",
    );
    expect(predicate).not.toContain("prompt:ambiguous-french");
    expect(predicate).not.toContain("prompt:ambiguous-relationship");
  });

  test("replaces every bare Brazilian scope gate before projecting the chosen funk tradition", () => {
    const prompt = "Brazilian funk essentials";
    const requestBrief: PlaylistBrief = {
      title: "Brazilian funk essentials",
      description: "An essential survey of Brazilian funk.",
      mode: "curated",
      subjectEntities: ["Brazilian funk", "Brazil"],
      relationship: "is documented as Brazilian funk",
      include: ["Brazilian funk recordings"],
      exclude: [],
      versionPolicy: "Prefer canonical studio recordings.",
      evidencePolicy: "Require documented genre membership.",
      orderingPolicy: "Use an editorial sequence.",
      targetSize: { min: 50, max: 50 },
      ambiguities: [],
    };
    const selectionPlan = createSelectionPlanV2({
      prompt,
      brief: requestBrief,
      storefront: "us",
    });
    const shadow = compilePlaylistContractShadowV1({
      contractId: "ambiguous-brazilian-funk",
      prompt,
      brief: requestBrief,
      selectionPlan,
      locale: "en",
    });
    expect(shadow.contract.clauses).toContainEqual(expect.objectContaining({
      axis: "geography",
      hardness: "hard",
      values: expect.arrayContaining(["Brazilian"]),
    }));
    const spec = createRunSpecV3({ prompt, requestedTrackCount: 50 });
    const question = deterministicGuidanceCandidatesV3({
      prompt,
      baseContractRevisionId: shadow.contract.revisionId,
      baseContractSemanticHash: shadow.contract.semanticHash,
      preservedTrackPredicate: shadow.preservedTrackPredicate,
      ambiguousScopeClauseIds: shadow.ambiguousScopeClauseIds,
      baseContract: shadow.contract,
      criticalAmbiguities: spec.criticalAmbiguities,
    }).find(({ id }) => id === "v3-critical:brazilian_funk_semantics");
    expect(question).toBeDefined();
    const selected = compileGuidanceSelectionV3(question!, {
      optionIds: ["funk_carioca"],
    });
    const revised = applyPlaylistContractPatchV1(
      shadow.contract,
      guidanceContractPatchV1({
        decision: question!,
        questionSetHash: "b".repeat(64),
        accepted: {
          answerHash: selected.answerHash,
          executableOperations: selected.operations,
        },
      })!,
    );
    expect(revised.clauses).toContainEqual(expect.objectContaining({
      id: "guidance:critical:brazilian-funk:funk-carioca",
      axis: "genre",
      hardness: "hard",
      values: ["funk carioca"],
    }));
    expect(revised.clauses.some((clause) => (
      clause.scope === "track"
      && ["geography", "relationship", "factual_relationship"].includes(
        clause.axis,
      )
      && /\bbrazil(?:ian)?\b/iu.test([
        ...clause.values,
        clause.source.text,
      ].join(" "))
    ))).toBe(false);

    const projected = projectPlaylistContractExecutionV1({
      contract: revised,
      basePlan: selectionPlan,
    });
    expect(projected.selectionPlanV3.membershipPredicates).toContainEqual(
      expect.objectContaining({
        axis: "genre",
        operator: "require",
        values: ["funk carioca"],
      }),
    );
    expect(projected.selectionPlanV3.membershipPredicates.some((predicate) => (
      ["geography", "factual_relationship"].includes(predicate.axis)
      && /\bbrazil(?:ian)?\b/iu.test(predicate.values.join(" "))
    ))).toBe(false);
    expect(projected.plan.constraints.some((constraint) => (
      ["geography", "relationship"].includes(constraint.axis)
      && /\bbrazil(?:ian)?\b/iu.test(constraint.values.join(" "))
    ))).toBe(false);
  });

  test.each([
    ["french_artist_origin", "geography", "France"],
    ["french_scene", "scene", "French jazz scene"],
    ["french_language", "language", "French"],
  ] as const)(
    "projects realistic French-jazz answer %s without retaining a fabricated content-language gate",
    (optionId, expectedAxis, expectedValue) => {
      const prompt = "Build exactly 50 French jazz tracks across eras and scenes.";
      const requestBrief: PlaylistBrief = {
        title: "French Jazz Across Eras",
        description: "A broad survey of French jazz across eras and scenes.",
        mode: "curated",
        subjectEntities: ["French jazz"],
        relationship: "is representative of French jazz",
        include: [
          "French jazz artists across multiple eras, cities, and stylistic scenes.",
        ],
        exclude: [],
        versionPolicy: "Prefer canonical studio recordings.",
        evidencePolicy: "Require documented track-level scope evidence.",
        orderingPolicy: "Use a coherent editorial sequence.",
        targetSize: { min: 50, max: 50 },
        ambiguities: [],
      };
      const selectionPlan = createSelectionPlanV2({
        prompt,
        brief: requestBrief,
        storefront: "fr",
      });
      expect(selectionPlan.contentPolicy.languages).toEqual([]);
      const shadow = compilePlaylistContractShadowV1({
        contractId: `french-jazz-${optionId}`,
        prompt,
        brief: requestBrief,
        selectionPlan,
        locale: "en",
      });
      expect(shadow.contract.clauses.some((clause) => (
        clause.axis === "content"
        && clause.values.some((value) => value.startsWith("language:"))
      ))).toBe(false);

      // Exercise already-persisted Contract-3 revisions from the buggy
      // compiler as well as newly compiled shadows. The answer must remove
      // this migrated false gate before adding the chosen typed relationship.
      const legacyBuggyContract = applyPlaylistContractPatchV1(shadow.contract, {
        baseRevisionId: shadow.contract.revisionId,
        baseSemanticHash: shadow.contract.semanticHash,
        answerLineage: {
          questionSetHash: "c".repeat(64),
          questionId: "legacy:migration",
          answerHash: "d".repeat(64),
        },
        operations: [{
          op: "add_clause",
          clause: {
            id: "bridge:catalog:content-policy",
            kind: "catalog_version",
            scope: "track",
            hardness: "hard",
            axis: "content",
            operator: "require",
            values: [
              "explicit-content:allow",
              "instrumental:allow",
              "language:French jazz",
            ],
            source: {
              provenance: "migration",
              text: requestBrief.include[0]!,
            },
            evidence: {
              required: true,
              minimumGrade: "authoritative_structured_metadata",
              permittedGrades: ["authoritative_structured_metadata"],
            },
            unknownPolicy: "reject",
          },
        }, {
          op: "replace_track_predicate",
          predicate: {
            op: "all",
            children: [
              shadow.contract.trackPredicate,
              {
                op: "clause",
                clauseId: "bridge:catalog:content-policy",
              },
            ],
          },
        }],
      });
      const spec = createRunSpecV3({
        prompt,
        requestedTrackCount: 50,
        storefront: "fr",
      });
      const question = criticalAmbiguityGuidanceDecisionV3({
        ambiguity: spec.criticalAmbiguities.find(
          ({ key }) => key === "french_jazz_scope",
        )!,
        baseContract: legacyBuggyContract,
        ambiguousScopeClauseIds: shadow.ambiguousScopeClauseIds,
      });
      const selected = compileGuidanceSelectionV3(question, {
        optionIds: [optionId],
      });
      const revised = applyPlaylistContractPatchV1(
        legacyBuggyContract,
        guidanceContractPatchV1({
          decision: question,
          questionSetHash: "e".repeat(64),
          accepted: {
            answerHash: selected.answerHash,
            executableOperations: selected.operations,
          },
        })!,
      );
      expect(revised.clauses.some((clause) => (
        clause.axis === "content"
        && clause.values.some((value) => value.startsWith("language:"))
      ))).toBe(false);
      const guided = revised.clauses.find((clause) => (
        clause.id.startsWith("guidance:critical:french-jazz-scope:")
      ));
      expect(guided).toMatchObject({
        axis: expectedAxis,
        hardness: "hard",
        values: expect.arrayContaining([expectedValue]),
      });

      const projection = projectPlaylistContractExecutionV1({
        contract: revised,
        basePlan: selectionPlan,
      });
      const runtimeLanguageClauses = projection.canonicalContractPolicy.clauses
        .filter(({ axis }) => axis === "language");
      expect(runtimeLanguageClauses).toHaveLength(
        optionId === "french_language" ? 1 : 0,
      );
      if (optionId === "french_language") {
        expect(runtimeLanguageClauses[0]).toMatchObject({
          values: expect.arrayContaining(["French"]),
          evidence: {
            minimumGrade: "trusted_scoped_container",
            permittedGrades: expect.arrayContaining([
              "trusted_scoped_container",
              "track_specific_editorial_assertion",
            ]),
          },
        });
      }
      expect(projection.selectionPlanV3.membershipPredicates).toContainEqual(
        expect.objectContaining({
          axis: expectedAxis,
          values: [expectedValue],
          source: "guided_answer",
        }),
      );
      expect(projection.selectionPlanV3.catalogPolicies.some((policy) => (
        policy.values.some((value) => value.startsWith("language:"))
      ))).toBe(false);

      const assessments = Object.fromEntries(
        projection.canonicalContractPolicy.clauses.map((clause) => [
          clause.id,
          {
            status: "pass" as const,
            evidenceGrade: clause.evidence.minimumGrade
              ?? clause.evidence.permittedGrades[0]!,
          },
        ]),
      );
      expect(evaluateCanonicalContractTrackV1({
        policy: projection.canonicalContractPolicy,
        assessments,
      })).toMatchObject({ status: "pass", eligible: true });
    },
  );

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

  test("suppresses optional guidance but preserves required correctness blockers for precise requests", () => {
    const optional = decision({
      id: "depth",
      axis: "depth",
      trigger: "nuance",
    });
    const required = decision({
      id: "scope",
      axis: "scope",
      trigger: "correctness",
      criticality: "required",
    });
    for (const requestShape of ["fixed_list", "factual", "fully_explicit"] as const) {
      const round = selectGuidanceRoundV3({
        stage: "initial",
        requestShape,
        candidates: [optional, required],
      });
      expect(round.decisions.map(({ id }) => id)).toEqual(["scope"]);
      expect(round.rejectedDecisionReasons).toEqual({
        depth: "request_needs_no_guidance",
      });
    }
  });

  test("uses a third initial slot only for a required correctness ambiguity", () => {
    const first = decision({
      id: "scope",
      axis: "scope",
      trigger: "correctness",
      criticality: "required",
      materialityScore: 100,
    });
    const second = decision({
      id: "geography",
      axis: "geography",
      trigger: "correctness",
      criticality: "required",
      materialityScore: 90,
    });
    const optionalThird = decision({
      id: "depth",
      axis: "depth",
      trigger: "nuance",
      materialityScore: 80,
    });
    const optionalRound = selectGuidanceRoundV3({
      stage: "initial",
      requestShape: "curated",
      candidates: [first, second, optionalThird],
    });
    expect(optionalRound.decisions.map(({ id }) => id)).toEqual([
      "scope",
      "geography",
    ]);
    expect(optionalRound.rejectedDecisionReasons.depth).toBe(
      "round_question_limit",
    );

    const blockingThird = decision({
      id: "language",
      axis: "language",
      trigger: "correctness",
      criticality: "required",
      materialityScore: 80,
    });
    expect(selectGuidanceRoundV3({
      stage: "initial",
      requestShape: "curated",
      candidates: [first, second, blockingThird],
    }).decisions.map(({ id }) => id)).toEqual([
      "scope",
      "geography",
      "language",
    ]);
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
      allowCustom: false,
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
      allowCustom: false,
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

  test("offers custom input only on a production axis backed by typed compilation", () => {
    const base = compilePlaylistContractRevisionV1({
      contractId: "custom-flow-axis",
      rawPrompt: "Build 25 disco tracks with a listening journey",
      requestedTrackCount: 25,
      locale: "en",
      storefront: "us",
      clauses: [{
        id: "prompt:disco",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "genre",
        operator: "require",
        values: ["disco"],
        source: { provenance: "prompt", text: "disco" },
      }],
      trackPredicate: { op: "clause", clauseId: "prompt:disco" },
    });
    const flow = flowNuanceGuidanceDecisionV3({
      prompt: base.rawPrompt,
      baseContract: base,
    });
    expect(flow).toMatchObject({
      axis: "playlist_flow",
      criticality: "optional",
      allowCustom: true,
      allowedPatchOperations: expect.arrayContaining([
        "add_clause",
        "set_sequencing_objectives",
      ]),
      affectedClauseIds: ["guidance:flow:objective"],
    });
    expect(compileCustomGuidanceAnswerV3({
      decision: flow!,
      customText: "Use a smooth flow",
      serverCompiled: null,
      confirmed: false,
    })).toMatchObject({
      state: "needs_recompile",
      executableOperations: null,
    });
    const compiledFlow = recompileCustomGuidanceTextV3({
      base,
      customText: "Use a smooth flow",
    });
    expect(compiledFlow).toMatchObject({
      affectedClauseIds: ["guidance:flow:objective"],
      hardChangeReasons: [],
      operations: [
        expect.objectContaining({
          op: "add_clause",
          clause: expect.objectContaining({
            id: "guidance:flow:objective",
          }),
        }),
        expect.objectContaining({
          op: "set_sequencing_objectives",
          objectives: [expect.objectContaining({
            id: "guidance:flow:sequence",
            clauseId: "guidance:flow:objective",
            direction: "smooth",
          })],
        }),
      ],
    });
    const compiledAnswer = compileCustomGuidanceAnswerV3({
      decision: flow!,
      customText: "Use a smooth flow",
      serverCompiled: compiledFlow,
      confirmed: false,
    });
    expect(compiledAnswer).toMatchObject({
      state: "accepted",
      hardChangeReasons: [],
      executableOperations: compiledFlow.operations,
    });

    // The persisted custom-answer path still presents the server-owned
    // interpretation summary for explicit confirmation before creating the
    // successor, even though flow itself is a soft change.
    const confirmation = customGuidanceConfirmationDecisionV3({
      base,
      compiled: compiledFlow,
    });
    const confirmed = compileGuidanceSelectionV3(confirmation, {
      optionIds: ["apply_revised_interpretation"],
    });
    const successor = applyPlaylistContractPatchV1(
      base,
      guidanceContractPatchV1({
        decision: confirmation,
        questionSetHash: "9".repeat(64),
        accepted: {
          answerHash: confirmed.answerHash,
          executableOperations: confirmed.operations,
        },
      })!,
    );
    expect(successor).toMatchObject({
      revision: 2,
      sequencingObjectives: [{
        id: "guidance:flow:sequence",
        clauseId: "guidance:flow:objective",
        direction: "smooth",
      }],
    });

    const repeatedFlow = flowNuanceGuidanceDecisionV3({
      prompt: "Keep shaping this listening journey",
      baseContract: successor,
    })!;
    expect(repeatedFlow).toMatchObject({
      allowCustom: true,
      allowedPatchOperations: expect.arrayContaining([
        "replace_clause",
        "set_sequencing_objectives",
      ]),
      affectedClauseIds: ["guidance:flow:objective"],
    });
    const repeatedCompiled = recompileCustomGuidanceTextV3({
      base: successor,
      customText: "Use a high-contrast flow",
    });
    expect(repeatedCompiled).toMatchObject({
      affectedClauseIds: ["guidance:flow:objective"],
      operations: [
        expect.objectContaining({
          op: "replace_clause",
          clauseId: "guidance:flow:objective",
          clause: expect.objectContaining({
            id: "guidance:flow:objective",
          }),
        }),
        expect.objectContaining({
          op: "set_sequencing_objectives",
          objectives: [expect.objectContaining({
            id: "guidance:flow:sequence",
            clauseId: "guidance:flow:objective",
            direction: "contrast",
          })],
        }),
      ],
    });
    expect(() => compileCustomGuidanceAnswerV3({
      decision: repeatedFlow,
      customText: "Use a high-contrast flow",
      serverCompiled: repeatedCompiled,
      confirmed: false,
    })).not.toThrow();
    for (const { decision, compiled } of [
      { decision: flow!, compiled: compiledFlow },
      { decision: repeatedFlow, compiled: repeatedCompiled },
    ]) {
      expect(compiled.operations.every(({ op }) => (
        decision.allowedPatchOperations.includes(op)
      ))).toBe(true);
      expect(compiled.affectedClauseIds.every((clauseId) => (
        decision.affectedClauseIds.includes(clauseId)
      ))).toBe(true);
    }
    const repeatedConfirmation = customGuidanceConfirmationDecisionV3({
      base: successor,
      compiled: repeatedCompiled,
    });
    const repeatedConfirmed = compileGuidanceSelectionV3(
      repeatedConfirmation,
      { optionIds: ["apply_revised_interpretation"] },
    );
    const repeatedSuccessor = applyPlaylistContractPatchV1(
      successor,
      guidanceContractPatchV1({
        decision: repeatedConfirmation,
        questionSetHash: "8".repeat(64),
        accepted: {
          answerHash: repeatedConfirmed.answerHash,
          executableOperations: repeatedConfirmed.operations,
        },
      })!,
    );
    expect(repeatedSuccessor).toMatchObject({
      revision: 3,
      sequencingObjectives: [{
        id: "guidance:flow:sequence",
        clauseId: "guidance:flow:objective",
        direction: "contrast",
      }],
    });
    expect(repeatedSuccessor.clauses.filter(
      ({ id }) => id === "guidance:flow:objective",
    )).toHaveLength(1);

    const unsupported = [
      smoothReggaetonHeatGuidanceDecisionV3({
        prompt: SMOOTH_REGGAETON_HEAT_PROMPT,
        baseContractRevisionId: base.revisionId,
        baseContractSemanticHash: base.semanticHash,
        preservedTrackPredicate: base.trackPredicate,
        ambiguousScopeClauseIds: [],
      }),
      rareScopeGuidanceDecisionV3({
        prompt: "100 rare disco deep cuts",
        baseContract: compilePlaylistContractRevisionV1({
          contractId: "unsupported-rare-custom-axis",
          rawPrompt: "100 rare disco deep cuts",
          requestedTrackCount: 100,
          locale: "en",
          storefront: "us",
          clauses: base.clauses.map((clause) => ({
            id: clause.id,
            kind: clause.kind,
            scope: clause.scope,
            hardness: clause.hardness,
            axis: clause.axis,
            operator: clause.operator,
            values: clause.values,
            source: clause.source,
          })),
          trackPredicate: base.trackPredicate,
        }),
      }),
    ];
    expect(unsupported.every((decision) => decision?.allowCustom === false)).toBe(true);
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
    expect(recompileCustomGuidanceTextV3({
      base,
      customText: "300 tracks with smooth flow",
    }).previewContract.requestedTrackCount).toBe(300);
    for (const count of [301, 999, 1_000, 1_001]) {
      expect(() => recompileCustomGuidanceTextV3({
        base,
        customText: `${count} tracks with smooth flow`,
      })).toThrow("invalid_custom_requested_count");
    }
    for (const count of [301, 999, 1_000]) {
      expect(recompileCustomGuidanceTextV3({
        base,
        customText: `${count} tracks with smooth flow`,
        trackCountAuthority:
          AUTHENTICATED_OWNER_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
      }).previewContract.requestedTrackCount).toBe(count);
    }
    expect(() => recompileCustomGuidanceTextV3({
      base,
      customText: "1001 tracks with smooth flow",
      trackCountAuthority:
        AUTHENTICATED_OWNER_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
    })).toThrow("invalid_custom_requested_count");
    const compiled = recompileCustomGuidanceTextV3({
      base,
      customText: "mostly women, clean, no Bad Bunny",
      resolvedExactArtistIdentities: [{
        inputText: "Bad Bunny",
        catalogArtistId: "1126808565",
        displayName: "Bad Bunny",
        storefront: "us",
      }],
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
    expect(compiled.previewContract.executionDirectives
      ?.exactArtistIdentityExclusions).toEqual({
      bindings: [{
        clauseId: expect.stringMatching(/^guidance:custom:exclude:/u),
        catalogArtistId: "1126808565",
        displayName: "Bad Bunny",
        storefront: "us",
      }],
    });

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

  test("compiles stable artist ambiguity profiles into fenced full custom patches", () => {
    const base = compilePlaylistContractRevisionV1({
      contractId: "custom-artist-ambiguity",
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
        values: ["reggaeton"],
        source: { provenance: "prompt", text: "reggaeton" },
      }],
      trackPredicate: { op: "clause", clauseId: "prompt:reggaeton" },
    });
    const originalSemanticHash = base.semanticHash;
    const decision = exactArtistIdentityAmbiguityGuidanceDecisionV3({
      base,
      customText: "mostly women, clean, no Bad Bunny.",
      inputText: "Bad Bunny",
      candidates: [
        {
          catalogArtistId: "1126808565",
          displayName: "Bad Bunny",
          storefront: "us",
          genreNames: ["Latin"],
        },
        {
          catalogArtistId: "998877",
          displayName: "Bad Bunny",
          storefront: "us",
        },
      ],
    });

    expect(decision).toMatchObject({
      axis: "exact_artist_identity",
      trigger: "correctness",
      criticality: "required",
      allowCustom: false,
      interpretationSummary: {
        avoid: ["No recordings by Bad Bunny"],
        mustHave: expect.arrayContaining([
          "Clean versions only",
          "At least 51% Tracks by women artists",
        ]),
      },
      options: [
        {
          id: "keep_current_interpretation",
          recommended: true,
          patch: { operations: [] },
        },
        {
          recommended: false,
          patch: {
            operations: expect.arrayContaining([
              expect.objectContaining({
                op: "set_exact_artist_identity_exclusions",
                directive: {
                  bindings: [expect.objectContaining({
                    catalogArtistId: "1126808565",
                    storefront: "us",
                  })],
                },
              }),
            ]),
          },
        },
        {
          recommended: false,
          patch: {
            operations: expect.arrayContaining([
              expect.objectContaining({
                op: "set_exact_artist_identity_exclusions",
                directive: {
                  bindings: [expect.objectContaining({
                    catalogArtistId: "998877",
                    storefront: "us",
                  })],
                },
              }),
            ]),
          },
        },
      ],
    });
    expect(base.semanticHash).toBe(originalSemanticHash);

    const selected = compileGuidanceSelectionV3(decision, {
      optionIds: [decision.options[1]!.id],
    });
    const revised = applyPlaylistContractPatchV1(
      base,
      guidanceContractPatchV1({
        decision,
        questionSetHash: "a".repeat(64),
        accepted: {
          answerHash: selected.answerHash,
          executableOperations: selected.operations,
        },
      })!,
    );
    expect(revised.executionDirectives?.exactArtistIdentityExclusions)
      .toMatchObject({
        bindings: [{
          catalogArtistId: "1126808565",
          displayName: "Bad Bunny",
          storefront: "us",
        }],
      });
  });
});
