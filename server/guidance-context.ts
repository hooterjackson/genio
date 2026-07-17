import type {
  PlaylistGuidanceAnswer,
  PlaylistGuidanceEffectKind,
  PlaylistGuidanceOrderingBehavior,
  PlaylistGuidanceQuestion,
} from "../shared/types.ts";

export interface PlaylistGuidancePreference {
  questionId: string;
  decisionKey: string;
  kind: PlaylistGuidanceEffectKind;
  value: string;
  orderingBehavior: PlaylistGuidanceOrderingBehavior | null;
  source: "option" | "custom";
}

export interface GuidanceResearchContext {
  researchDirectives: string[];
  orderingBehavior: PlaylistGuidanceOrderingBehavior | null;
}

function boundedText(value: unknown, maximum: number): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, maximum)
    : "";
}

function legacyOptionValue(question: PlaylistGuidanceQuestion, option: PlaylistGuidanceQuestion["options"][number]): string {
  return boundedText(`${question.header}: ${option.label}. ${option.description}`, 500);
}

/**
 * Convert the visitor's answer into the bounded, machine-readable effects
 * that the research pipeline consumes. The immutable factual scope remains in
 * PlaylistBrief; these preferences are deliberately stored alongside it.
 */
export function deriveGuidancePreferences(
  questions: readonly PlaylistGuidanceQuestion[],
  answers: readonly PlaylistGuidanceAnswer[],
): PlaylistGuidancePreference[] {
  const questionsById = new Map(questions.map((question) => [question.id, question]));
  const preferences: PlaylistGuidancePreference[] = [];
  for (const answer of answers) {
    const question = questionsById.get(answer.questionId);
    if (!question) continue;
    const decisionKey = boundedText(question.decisionKey || question.id, 160) || question.id;
    if (answer.optionId) {
      const option = question.options.find((candidate) => candidate.id === answer.optionId);
      if (!option) continue;
      const effect = option.effect;
      preferences.push({
        questionId: question.id,
        decisionKey,
        kind: effect?.kind ?? "research_preference",
        value: boundedText(effect?.value || legacyOptionValue(question, option), 500),
        orderingBehavior: effect?.kind === "ordering_behavior"
          ? effect.orderingBehavior
          : null,
        source: "option",
      });
      continue;
    }
    const customText = boundedText(answer.customText, 500);
    if (!customText) continue;
    // Free-form answers cannot safely invent a sequencing enum. Keep their
    // text as a typed research preference tied to the scout's decision axis.
    preferences.push({
      questionId: question.id,
      decisionKey,
      kind: "research_preference",
      value: customText,
      orderingBehavior: null,
      source: "custom",
    });
  }
  return preferences;
}

/**
 * Render every typed effect into a distinct downstream instruction. This
 * makes each accepted preference affect candidate discovery/selection, while
 * ordering behavior additionally controls deterministic playlist sequencing.
 */
export function guidanceResearchContext(
  preferences: readonly PlaylistGuidancePreference[] | null | undefined,
): GuidanceResearchContext {
  const directives: string[] = [];
  let orderingBehavior: PlaylistGuidanceOrderingBehavior | null = null;
  for (const preference of preferences ?? []) {
    const value = boundedText(preference.value, 500);
    if (!value) continue;
    switch (preference.kind) {
      case "version_preference":
        directives.push(`Recording/version selection: ${value}`);
        break;
      case "familiarity_bias":
        directives.push(`Familiarity distribution for candidate selection: ${value}`);
        break;
      case "subscene_focus":
        directives.push(`Scene/geographic focus for discovery and candidate selection: ${value}`);
        break;
      case "ordering_behavior":
        directives.push(`Listening-flow preference: ${value}`);
        orderingBehavior = preference.orderingBehavior;
        break;
      case "research_preference":
      default:
        directives.push(`Research and candidate-selection preference: ${value}`);
        break;
    }
  }
  return { researchDirectives: directives, orderingBehavior };
}

export function guidanceOrderingPolicy(
  original: string,
  preferences: readonly PlaylistGuidancePreference[] | null | undefined,
): string {
  const { orderingBehavior } = guidanceResearchContext(preferences);
  switch (orderingBehavior) {
    case "chronological":
      return "chronological release order";
    case "contrast":
      return "high-contrast listening flow with artist and album intermixing";
    case "smooth":
      return "smooth listening flow with artist and album intermixing";
    case "editorial":
      return "editorial significance order";
    default:
      return original;
  }
}
