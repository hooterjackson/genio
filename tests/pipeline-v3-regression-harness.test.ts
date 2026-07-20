import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parsePartialReadyCheckpoint } from "../server/partial-publication-policy.ts";
import {
  createPipelinePolicySnapshotV3,
  selectCandidatesV3,
  type SelectionCandidateV3,
} from "../server/pipeline-v3-policy.ts";
import {
  createRunSpecV3,
  resolveRunSpecV3,
  type CriticalAmbiguityAnswerV3,
  type CriticalAmbiguityV3,
  type IntentEngineV3,
  type IntentV3,
  type MembershipAxisV3,
  type MembershipOperatorV3,
  type RankingDimensionV3,
} from "../server/selection-plan-v3.ts";

interface ExpectedMembership {
  axis: MembershipAxisV3;
  operator: MembershipOperatorV3;
  value: string;
}

interface RegressionScenario {
  id: string;
  prompt: string;
  requestedTrackCount: number;
  answers?: CriticalAmbiguityAnswerV3[];
  expectedIntents: IntentV3[];
  expectedEngines: IntentEngineV3[];
  expectedMembership: ExpectedMembership[];
  expectedRanking: RankingDimensionV3[];
  expectedCriticalAmbiguities: CriticalAmbiguityV3["key"][];
}

const suite = JSON.parse(readFileSync(
  new URL("./fixtures/pipeline-v3-regression-scenarios.json", import.meta.url),
  "utf8",
)) as { fixtureVersion: string; scenarios: RegressionScenario[] };

function normalized(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("en-US").trim();
}

function exactCandidate(id: string, genre: string): SelectionCandidateV3<string> {
  return {
    id,
    value: id,
    artist: `Artist ${id}`,
    album: `Album ${id}`,
    year: 2000,
    scene: null,
    memberships: { genre: [genre] },
    objectiveScores: { relevance: 1 },
    sourceRank: Number(id),
  };
}

describe("Pipeline V3 frozen historical regression suite", () => {
  test("freezes every historically problematic prompt and count tier", () => {
    expect(suite.fixtureVersion).toBe("pipeline-v3-regressions-2026-07-20");
    expect(suite.scenarios.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "disco_25",
      "brazilian_disco_50",
      "american_drill_100",
      "house_semantic_25",
      "french_jazz_diversity_50",
      "similarity_excludes_seed_100",
      "paulinho_factual_176",
    ]));
    expect(new Set(suite.scenarios.map(({ requestedTrackCount }) => requestedTrackCount)))
      .toEqual(new Set([25, 50, 100, 150, 176, 300]));
  });

  test.each(suite.scenarios)("interprets $id without truncating or weakening its typed contract", (scenario) => {
    const spec = createRunSpecV3({
      prompt: scenario.prompt,
      requestedTrackCount: scenario.requestedTrackCount,
      storefront: "us",
    });
    expect(spec.prompt).toBe(scenario.prompt);
    expect(spec.requestedTrackCount).toBe(scenario.requestedTrackCount);
    expect(spec.criticalAmbiguities.map(({ key }) => key)).toEqual(scenario.expectedCriticalAmbiguities);

    const plan = resolveRunSpecV3(spec, scenario.answers ?? []);
    expect(plan.confirmed).toBe(true);
    expect(plan.requestedTrackCount).toBe(scenario.requestedTrackCount);
    expect(plan.intents).toEqual(expect.arrayContaining(scenario.expectedIntents));
    expect(plan.engines).toEqual(expect.arrayContaining(scenario.expectedEngines));
    for (const expected of scenario.expectedMembership) {
      expect(plan.membershipPredicates.some((predicate) => (
        predicate.axis === expected.axis
        && predicate.operator === expected.operator
        && predicate.values.some((value) => normalized(value) === normalized(expected.value))
      ))).toBe(true);
    }
    expect(plan.rankingObjectives.map(({ dimension }) => dimension))
      .toEqual(expect.arrayContaining(scenario.expectedRanking));
  });

  test("keeps influence and importance downstream from factual membership", () => {
    const scenario = suite.scenarios.find(({ id }) => id === "paulinho_factual_176")!;
    const plan = resolveRunSpecV3(
      createRunSpecV3({ prompt: scenario.prompt, requestedTrackCount: scenario.requestedTrackCount }),
      scenario.answers ?? [],
    );
    expect(plan.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "factual_relationship",
      values: ["subject_performed"],
    }));
    expect(plan.membershipPredicates).toContainEqual(expect.objectContaining({
      axis: "artist",
      operator: "require",
      values: ["Paulinho da Costa"],
    }));
    expect(plan.membershipPredicates.some(({ axis, values }) => (
      axis === "theme" && values.some((value) => /influential|important/iu.test(value))
    ))).toBe(false);
    expect(plan.rankingObjectives).toContainEqual(expect.objectContaining({ dimension: "influence" }));
  });

  test.each([
    ["french_artist_origin", "geography", "France"],
    ["french_scene", "scene", "French jazz scene"],
    ["french_language", "language", "French"],
  ] as const)("maps French jazz guidance %s to semantic %s evidence scope", (optionId, axis, value) => {
    const spec = createRunSpecV3({ prompt: "50 French jazz tracks", requestedTrackCount: 50 });
    const plan = resolveRunSpecV3(spec, [{ key: "french_jazz_scope", optionId }]);
    expect(plan.membershipPredicates).toContainEqual(expect.objectContaining({
      axis,
      operator: "require",
      values: [value],
      source: "guided_answer",
    }));
    expect(plan.membershipPredicates.flatMap(({ values }) => values)).not.toContain(optionId);
  });

  test("never interprets a qualified shortfall as an exception or a completed exact result", () => {
    const result = selectCandidatesV3({
      candidates: [exactCandidate("1", "disco")],
      membershipPredicates: [{
        id: "genre:disco",
        axis: "genre",
        operator: "require",
        values: ["disco"],
        source: "user",
        reason: "The user requested disco.",
      }],
      rankingObjectives: [],
      target: 50,
    });
    expect(result.selected).toHaveLength(1);
    expect(result.shortfall).toBe(49);
    expect(parsePartialReadyCheckpoint({
      outcomeHash: "a".repeat(64),
      outcomeVersion: 1,
      targetTrackCount: 50,
      verifiedTrackCount: result.selected.length,
      remainingStrategyCount: 2,
      continueAvailable: true,
      preparedAt: "2026-07-20T12:00:00.000Z",
    })).toMatchObject({
      targetTrackCount: 50,
      verifiedTrackCount: 1,
      shortfall: 49,
      continueAvailable: true,
    });
  });

  test("freezes a catalog-validated provider model route and count-tier budget into the run policy", () => {
    const plan = resolveRunSpecV3(
      createRunSpecV3({ prompt: "150 influential Berlin techno tracks", requestedTrackCount: 150 }),
      [],
    );
    const env = {
      PIPELINE_V3_BASELINE_MODEL_ID: "gpt-5.6-luna",
      PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT: "2026-07-20T14:30:00.000Z",
      PIPELINE_V3_MAX_ROUNDS: "48",
    } as NodeJS.ProcessEnv;
    const policy = createPipelinePolicySnapshotV3({
      plan,
      environment: env,
      capturedAt: "2026-07-20T12:00:00.000Z",
    });
    env.PIPELINE_V3_BASELINE_MODEL_ID = "gpt-5.6-terra";
    expect(policy.executionPolicy).toMatchObject({
      model: "gpt-5.6-luna",
      modelRoute: {
        resolutionMode: "provider_managed_alias",
        modelCatalogValidatedAt: "2026-07-20T14:30:00.000Z",
      },
      maximumCostUsd: 3,
    });
    expect(policy.capturedAt).toBe("2026-07-20T12:00:00.000Z");
  });
});
