import { describe, expect, test } from "vitest";
import tapes from "./fixtures/guided-question-scout-tapes.json";

type TapeEffect = {
  kind: "research_preference" | "version_preference" | "familiarity_bias" | "subscene_focus" | "ordering_behavior";
  value: string;
  orderingBehavior: "smooth" | "contrast" | "chronological" | "editorial" | null;
};

type TapeOption = {
  id: string;
  label: string;
  description: string;
  recommended: boolean;
  effect: TapeEffect;
};

type TapeQuestion = {
  id: string;
  decisionKey: string;
  header: string;
  question: string;
  whyMaterial: string;
  grounding: { summary: string; sourceUrls: string[] };
  options: TapeOption[];
  candidatePoolProbe: Record<string, string[]>;
};

type ScoutTape = {
  id: string;
  prompt: string;
  scout: {
    status: string;
    sourceHints: Array<{ url: string; title: string; excerpt: string; providerAttested?: boolean }>;
  };
  questions: TapeQuestion[];
};

const scenarios = tapes.scenarios as ScoutTape[];

function questionFingerprint(scenario: ScoutTape): string {
  return scenario.questions.map((question) => [
    question.decisionKey,
    question.header,
    question.question,
    ...question.options.map((option) => `${option.label}:${option.effect.kind}:${option.effect.value}`),
  ].join("|").toLocaleLowerCase()).join("||");
}

describe("frozen subject-specific guidance scout tapes", () => {
  test("unrelated subjects produce different grounded question fingerprints", () => {
    const guided = scenarios.filter((scenario) => scenario.questions.length > 0);
    const fingerprints = guided.map(questionFingerprint);
    expect(guided.map((scenario) => scenario.id)).toEqual(expect.arrayContaining([
      "paulinho-da-costa-credit-scope",
      "berlin-techno-scene-lineage",
      "radiohead-adjacent-discovery",
      "wandelweiser-listening-mode",
      "funana-era-and-texture",
      "tamil-nadaswaram-context",
    ]));
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  test("a precise request produces zero questions instead of mandatory filler", () => {
    const precise = scenarios.find((scenario) => scenario.id === "precise-no-followup");
    expect(precise).toBeDefined();
    expect(precise!.questions).toEqual([]);
    expect(precise!.scout.status).toBe("skipped_precise");
    expect(precise!.scout.sourceHints).toEqual([]);
  });

  test("each answer has one distinct permitted typed effect and materially different candidate probes", () => {
    for (const scenario of scenarios.filter((item) => item.questions.length > 0)) {
      for (const question of scenario.questions) {
        expect(question.options).toHaveLength(3);
        expect(question.options.map((option) => option.recommended)).toEqual([true, false, false]);
        const typedEffects = question.options.map((option) => JSON.stringify(option.effect));
        expect(new Set(typedEffects).size, `${scenario.id}/${question.id} must expose distinct effects`).toBe(3);
        for (const effect of question.options.map((option) => option.effect)) {
          expect([
            "research_preference",
            "version_preference",
            "familiarity_bias",
            "subscene_focus",
            "ordering_behavior",
          ]).toContain(effect.kind);
          expect(effect.value.trim().length).toBeGreaterThan(8);
          expect(effect.kind === "ordering_behavior" ? effect.orderingBehavior : null)
            .toBe(effect.orderingBehavior);
        }

        const pools = question.options.map((option) => question.candidatePoolProbe[option.id] ?? []);
        expect(pools.every((pool) => pool.length > 0)).toBe(true);
        expect(new Set(pools.map((pool) => JSON.stringify(pool))).size).toBe(3);
        for (let left = 0; left < pools.length; left += 1) {
          for (let right = left + 1; right < pools.length; right += 1) {
            expect(pools[left]!.filter((track) => pools[right]!.includes(track))).toEqual([]);
          }
        }
      }
    }
  });

  test("every grounded question cites only provider-attested scout sources", () => {
    for (const scenario of scenarios.filter((item) => item.questions.length > 0)) {
      const attested = new Map(scenario.scout.sourceHints.map((source) => [source.url, source]));
      expect(attested.size).toBeGreaterThan(0);
      for (const question of scenario.questions) {
        expect(question.whyMaterial.trim().length).toBeGreaterThan(20);
        expect(question.grounding.summary.trim().length).toBeGreaterThan(20);
        expect(question.grounding.sourceUrls.length).toBeGreaterThan(0);
        for (const url of question.grounding.sourceUrls) {
          const source = attested.get(url);
          expect(source, `${scenario.id}/${question.id} cited an unattested source`).toBeDefined();
          expect(source!.providerAttested).toBe(true);
          expect(source!.title.trim().length).toBeGreaterThan(0);
          expect(source!.excerpt.trim().length).toBeGreaterThan(20);
        }
      }
    }
  });

  test("the corpus has no generic mandatory flow question", () => {
    const guided = scenarios.filter((scenario) => scenario.questions.length > 0);
    expect(guided.every((scenario) => scenario.questions.some((question) => question.decisionKey !== "ordering_behavior"))).toBe(true);
    expect(guided.flatMap((scenario) => scenario.questions)
      .some((question) => /^flow$/iu.test(question.header) || /^how should (?:the |this )?playlist (?:flow|move)/iu.test(question.question)))
      .toBe(false);
  });
});

describe("guidance degradation tape", () => {
  test.each(tapes.degradationCases)("$id degrades without inventing mandatory questions", (item) => {
    expect(item.expectedQuestionCount).toBeLessThanOrEqual(item.availableQuestions.length);
    if (item.failure === "timeout" || item.failure === "budget" || item.failure === "provider") {
      expect(item.expectedQuestionCount).toBe(0);
      expect(item.availableQuestions).toEqual([]);
      return;
    }
    const salvaged = item.availableQuestions.filter((question) => question.valid).map((question) => question.id);
    expect(item.expectedSalvagedQuestionIds).toEqual(salvaged);
    expect(item.expectedQuestionCount).toBe(salvaged.length);
  });
});
