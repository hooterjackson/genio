import type {
  PlaylistGuidanceAnswer,
  PlaylistGuidanceEffect,
  PlaylistGuidancePlanDelta,
  PlaylistGuidanceQuestion,
  PlaylistGuidanceRequestClassification,
  SelectionConstraint,
} from "../shared/types.ts";
import type { RunSpecV3 } from "./selection-plan-v3.ts";
import { sha256Hex, stableStringify } from "./security.ts";

export const BRIEF_CONTRACT_VERSION = 2 as const;
export const GUIDANCE_POLICY_VERSION = "intelligent_guidance_v2" as const;
export const EVIDENCE_POLICY_VERSION = "governed_evidence_v1" as const;

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function emptyDelta(): PlaylistGuidancePlanDelta {
  return {
    version: 1,
    membershipConstraints: [],
    discoveryFocus: [],
    rankingObjectives: [],
    diversityGoals: {},
    sequencingPreference: null,
    versionContentPreferences: {},
  };
}

function criticalConstraint(
  question: PlaylistGuidanceQuestion,
  optionId: string,
  effect: PlaylistGuidanceEffect | undefined,
  value: string,
): SelectionConstraint | null {
  const id = `guided:${question.decisionKey ?? question.id}:${optionId}`.slice(0, 160);
  const option = optionId.toLocaleLowerCase("en-US");
  const geography = effect?.geographyConstraint ?? null;
  if (geography) {
    return {
      id,
      axis: geography.relationship === "language"
        ? "language"
        : geography.relationship === "label_or_venue_scene"
          ? "scene"
          : "geography",
      operator: "require",
      values: [geography.value],
      kind: "hard",
      geographyRelationship: geography.relationship,
      relaxationRank: null,
    };
  }
  if (option.includes("house_genre")) {
    return { id, axis: "genre", operator: "require", values: ["house"], kind: "hard", relaxationRank: null };
  }
  if (option.includes("house_theme")) {
    return { id, axis: "theme", operator: "require", values: ["houses and homes"], kind: "hard", relaxationRank: null };
  }
  if (option.includes("house_both")) {
    return { id, axis: "theme", operator: "require", values: ["house music about houses or homes"], kind: "hard", relaxationRank: null };
  }
  if (option.includes("language")) {
    return {
      id,
      axis: "language",
      operator: "require",
      values: [value],
      kind: "hard",
      geographyRelationship: "language",
      relaxationRank: null,
    };
  }
  if (option.includes("artist_origin") || option.includes("french_artist")) {
    return {
      id,
      axis: "geography",
      operator: "require",
      values: [value],
      kind: "hard",
      geographyRelationship: "artist_origin",
      relaxationRank: null,
    };
  }
  if (option.includes("scene")) {
    return {
      id,
      axis: "geography",
      operator: "require",
      values: [value],
      kind: "hard",
      geographyRelationship: "label_or_venue_scene",
      relaxationRank: null,
    };
  }
  if (option.includes("performed") || option.includes("created") || option.includes("influenced")) {
    return { id, axis: "relationship", operator: "require", values: [value], kind: "hard", relaxationRank: null };
  }
  if (option.includes("funk")) {
    return { id, axis: "genre", operator: "require", values: [value], kind: "hard", relaxationRank: null };
  }
  return null;
}

function deltaFromLegacyEffect(
  question: PlaylistGuidanceQuestion,
  optionId: string,
  effect: PlaylistGuidanceEffect | undefined,
  displayValue: string,
): PlaylistGuidancePlanDelta {
  const delta = emptyDelta();
  const value = normalized(effect?.value || displayValue).slice(0, 500);
  if (question.criticality === "required" || question.id.startsWith("v3-critical:")) {
    const constraint = criticalConstraint(question, optionId, effect, value);
    if (constraint) delta.membershipConstraints.push(constraint);
    else delta.discoveryFocus.push(value);
    return delta;
  }
  switch (effect?.kind) {
    case "ordering_behavior":
      delta.sequencingPreference = effect.orderingBehavior === "smooth"
        || effect.orderingBehavior === "contrast"
        || effect.orderingBehavior === "chronological"
        || effect.orderingBehavior === "editorial"
        ? effect.orderingBehavior
        : "editorial";
      break;
    case "familiarity_bias":
      delta.rankingObjectives.push({
        dimension: /obscur|deep cut/iu.test(value) ? "obscurity" : "popularity",
        weight: 1,
        values: [value],
      });
      break;
    case "version_preference":
      delta.discoveryFocus.push(`recording/version preference: ${value}`);
      break;
    case "subscene_focus":
    case "research_preference":
    default:
      delta.discoveryFocus.push(value);
      break;
  }
  return delta;
}

export function guidanceRequestClassificationV2(
  spec: Pick<RunSpecV3, "criticalAmbiguities" | "scopeKind" | "intents" | "prompt">,
): PlaylistGuidanceRequestClassification {
  if (spec.criticalAmbiguities.length > 0) return "critical_ambiguity";
  if (spec.scopeKind !== "broad_curated"
    || spec.intents.includes("artist_catalogue")
    || spec.intents.includes("factual_relationship")
    || spec.intents.includes("exhaustive")) return "precise";
  if (spec.intents.includes("similarity")
    || spec.intents.includes("mood_activity")
    || /\b(?:best|essential|influential|iconic|obscure|deep cuts?|smooth|chronological|late[- ]night)\b/iu.test(spec.prompt)) {
    return "preference_ambiguity";
  }
  return "broad_curated";
}

export function contractTwoGuidanceQuestion(
  question: PlaylistGuidanceQuestion,
  classification: PlaylistGuidanceRequestClassification,
): PlaylistGuidanceQuestion {
  const required = classification === "critical_ambiguity" && question.id.startsWith("v3-critical:");
  const groundingMode = question.grounding?.sourceUrls?.length ? "grounded" : "inference";
  return {
    ...question,
    selectionMode: "single",
    criticality: required ? "required" : "optional",
    allowCustom: true,
    groundingMode,
    options: question.options.map((option) => ({
      ...option,
      feasibility: option.feasibility ?? (option.recommended ? "broad" : "moderate"),
      planDelta: option.planDelta ?? deltaFromLegacyEffect(
        { ...question, criticality: required ? "required" : "optional" },
        option.id,
        option.effect,
        `${option.label}. ${option.description}`,
      ),
    })),
  };
}

export function guidanceQuestionSetHashV2(input: {
  classification: PlaylistGuidanceRequestClassification;
  prompt: string;
  targetTrackCount: number;
  storefront: string;
  locale: string;
  explicitConstraintHash: string;
  questions: readonly PlaylistGuidanceQuestion[];
}): string {
  return sha256Hex(stableStringify({
    policyVersion: GUIDANCE_POLICY_VERSION,
    classification: input.classification,
    prompt: normalized(input.prompt),
    targetTrackCount: input.targetTrackCount,
    storefront: input.storefront.toLocaleLowerCase("en-US"),
    locale: input.locale.toLocaleLowerCase("en-US"),
    explicitConstraintHash: input.explicitConstraintHash,
    questions: input.questions,
  }));
}

export function planDeltaHasEffect(delta: PlaylistGuidancePlanDelta): boolean {
  return delta.membershipConstraints.length > 0
    || delta.discoveryFocus.length > 0
    || delta.rankingObjectives.length > 0
    || Object.keys(delta.diversityGoals).length > 0
    || delta.sequencingPreference !== null
    || Object.keys(delta.versionContentPreferences).length > 0;
}

export function compileGuidanceExecutionDeltaV2(
  questions: readonly PlaylistGuidanceQuestion[],
  answers: readonly PlaylistGuidanceAnswer[],
): { delta: PlaylistGuidancePlanDelta; hash: string } {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const delta = emptyDelta();
  const orderedAnswers = [...answers].sort((left, right) => left.questionId.localeCompare(right.questionId));
  for (const answer of orderedAnswers) {
    if (answer.skipped) continue;
    const question = byId.get(answer.questionId);
    if (!question) throw new Error("unknown_guidance_question");
    let selected = answer.optionId
      ? question.options.find((option) => option.id === answer.optionId)?.planDelta
      : null;
    if (!selected && answer.customText) {
      selected = emptyDelta();
      if (question.criticality === "required") {
        selected.membershipConstraints.push({
          id: `guided:${question.decisionKey ?? question.id}:custom`.slice(0, 160),
          axis: question.decisionKey?.includes("relationship") ? "relationship" : "evidence",
          operator: "require",
          values: [normalized(answer.customText).slice(0, 500)],
          kind: "hard",
          relaxationRank: null,
        });
      } else {
        selected.discoveryFocus.push(normalized(answer.customText).slice(0, 500));
      }
    }
    if (!selected || !planDeltaHasEffect(selected)) throw new Error("empty_guidance_plan_delta");
    delta.membershipConstraints.push(...selected.membershipConstraints);
    delta.discoveryFocus.push(...selected.discoveryFocus);
    delta.rankingObjectives.push(...selected.rankingObjectives);
    Object.assign(delta.diversityGoals, selected.diversityGoals);
    if (selected.sequencingPreference) delta.sequencingPreference = selected.sequencingPreference;
    Object.assign(delta.versionContentPreferences, selected.versionContentPreferences);
  }
  delta.membershipConstraints = [...new Map(delta.membershipConstraints.map((value) => [value.id, value])).values()];
  delta.discoveryFocus = [...new Set(delta.discoveryFocus)].sort();
  delta.rankingObjectives = [...delta.rankingObjectives].sort((left, right) => (
    stableStringify(left).localeCompare(stableStringify(right))
  ));
  return { delta, hash: sha256Hex(stableStringify(delta)) };
}
