import { describe, expect, test } from "vitest";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  assignPipelineV2,
  createSelectionPlanV2,
  pipelineRolloutStickyKey,
  pipelineV2Route,
  pipelineV2RolloutGroup,
} from "../server/selection-plan-v2.ts";

function brief(overrides: Partial<PlaylistBrief> = {}): PlaylistBrief {
  return {
    title: "House music",
    description: "A broad, source-backed house music survey.",
    mode: "curated",
    subjectEntities: ["House music"],
    relationship: "is a recording in the house music genre",
    include: ["Recordings musically classified as house music."],
    exclude: ["Do not include songs merely about physical houses."],
    versionPolicy: "Prefer one canonical studio recording.",
    evidencePolicy: "Require track-scope editorial evidence.",
    orderingPolicy: "Smooth listening flow with artists intermixed.",
    targetSize: { min: 50, max: 50 },
    ambiguities: [],
    ...overrides,
  };
}

describe("Pipeline V2 selection plan", () => {
  test("house music remains a genre and receives broad-playlist diversity goals", () => {
    const plan = createSelectionPlanV2({ prompt: "50 essential house music tracks", brief: brief() });
    expect(plan.intents).toEqual(expect.arrayContaining(["genre_scene", "editorial_ranking"]));
    expect(plan.constraints.some((constraint) => constraint.values.some((value) => value.includes("physical houses")))).toBe(true);
    expect(plan.diversityGoals.maximumTracksPerArtist).toBe(8);
    expect(pipelineV2Route(plan)).toBe("curated_catalog");
  });

  test("composite similarity constraints survive without including the reference artist by default", () => {
    const plan = createSelectionPlanV2({
      prompt: "Songs like Radiohead, focused on production and harmony, but no Radiohead and only clean versions",
      brief: brief({
        title: "Radiohead-adjacent",
        subjectEntities: ["Radiohead"],
        relationship: "stylistically similar to the reference artist",
        include: ["Production and harmonic similarity."],
        exclude: ["Reference artist is a style seed; exclude recordings by: Radiohead"],
        versionPolicy: "Clean versions only.",
      }),
    });
    expect(plan.intents).toContain("similarity");
    expect(plan.similarityDimensions).toEqual(expect.arrayContaining(["production", "harmony"]));
    expect(plan.referenceRecordings).toEqual(["Radiohead"]);
    expect(plan.contentPolicy.explicitContent).toBe("clean_only");
  });

  test("preserves genre, geography, language, and era as independent hard constraints", () => {
    const plan = createSelectionPlanV2({
      prompt: "American house music from the 1990s, sung in French",
      brief: brief({
        title: "French-language American house",
        subjectEntities: ["American French-language house music"],
        relationship: "is a house music recording from the American scene sung in French",
        include: ["American house music from the 1990s", "French-language recordings"],
        exclude: [],
      }),
    });
    const hard = plan.constraints.filter((constraint) => constraint.kind === "hard");
    expect(hard).toEqual(expect.arrayContaining([
      expect.objectContaining({ axis: "genre", operator: "require", values: expect.arrayContaining(["house music"]) }),
      expect.objectContaining({
        axis: "geography",
        operator: "require",
        values: expect.arrayContaining(["American"]),
        geographyRelationship: "unspecified",
      }),
      expect.objectContaining({
        axis: "language",
        operator: "require",
        values: expect.arrayContaining(["French"]),
        geographyRelationship: "language",
      }),
      expect.objectContaining({ axis: "era", operator: "within", values: ["1990s"] }),
      expect.objectContaining({ axis: "relationship", operator: "require", values: ["is a house music recording from the American scene sung in French"] }),
    ]));
    expect(hard.filter((constraint) => constraint.axis === "genre")).toHaveLength(1);
    expect(hard.filter((constraint) => constraint.axis === "geography")).toHaveLength(1);
    expect(hard.filter((constraint) => constraint.axis === "language")).toHaveLength(1);
    expect(hard.filter((constraint) => constraint.axis === "era")).toHaveLength(1);
    expect(plan.geographyConstraints).toEqual(expect.arrayContaining([
      { value: "French", relationship: "language" },
      { value: "American", relationship: "unspecified" },
    ]));
  });

  test.each([
    ["Jazz from the French scene", "label_or_venue_scene"],
    ["Jazz recorded in France", "recording_location"],
    ["Jazz by artists residing in France", "artist_residence"],
  ] as const)("retains the exact geography relation for %s", (prompt, relationship) => {
    const plan = createSelectionPlanV2({
      prompt,
      brief: brief({
        title: prompt,
        subjectEntities: [prompt],
        relationship: "matches the requested French jazz relationship",
        include: [prompt],
        exclude: [],
      }),
    });
    expect(plan.geographyConstraints).toContainEqual({ value: "French", relationship });
    expect(plan.constraints).toContainEqual(expect.objectContaining({
      kind: "hard",
      values: ["French"],
      geographyRelationship: relationship,
    }));
  });

  test("a guided relationship answer replaces only the matching ambiguous geography rule", () => {
    const plan = createSelectionPlanV2({
      prompt: "French jazz",
      brief: brief({
        title: "French jazz",
        subjectEntities: ["French jazz"],
        relationship: "matches the confirmed French relationship",
        include: [],
        exclude: [],
      }),
      guidancePreferences: [{
        questionId: "q1",
        decisionKey: "french_jazz_relationship_boundary",
        kind: "research_preference",
        value: "Require recordings documented as recorded in France.",
        orderingBehavior: null,
        geographyConstraint: { value: "French", relationship: "recording_location" },
        source: "option",
      }],
    });
    expect(plan.geographyConstraints).toContainEqual({ value: "French", relationship: "recording_location" });
    expect(plan.geographyConstraints).not.toContainEqual({ value: "French", relationship: "unspecified" });
  });

  test("represents explicit year ranges independently from decades", () => {
    const rangePlan = createSelectionPlanV2({
      prompt: "Detroit techno from 1992–1998",
      brief: brief({
        title: "Detroit techno 1992–1998",
        subjectEntities: ["Detroit techno"],
        include: ["Released from 1992–1998"],
        exclude: [],
      }),
    });
    expect(rangePlan.constraints).toContainEqual(expect.objectContaining({
      axis: "era",
      operator: "between",
      values: ["1992", "1998"],
      kind: "hard",
    }));
  });

  test("factual credits route to the claim-first frontier and disable generic caps", () => {
    const plan = createSelectionPlanV2({
      prompt: "Every released song Paulinho da Costa performed on",
      brief: brief({
        title: "Paulinho da Costa credits",
        mode: "exhaustive",
        subjectEntities: ["Paulinho da Costa"],
        relationship: "performed percussion on the released recording",
        targetSize: null,
      }),
    });
    expect(plan.intents).toEqual(expect.arrayContaining(["exhaustive", "factual_relationship"]));
    expect(plan.diversityGoals.maximumTracksPerArtist).toBeNull();
    expect(pipelineV2Route(plan)).toBe("factual_frontier");
  });

  test("guided answers become typed, soft constraints without weakening hard rules", () => {
    const plan = createSelectionPlanV2({
      prompt: "French jazz",
      brief: brief({ title: "French jazz", subjectEntities: ["French jazz"], include: ["Artists in the French jazz scene."] }),
      guidancePreferences: [{
        questionId: "scene",
        decisionKey: "scene_definition",
        kind: "subscene_focus",
        value: "Prioritize the Paris postwar scene.",
        orderingBehavior: null,
        source: "option",
      }],
    });
    expect(plan.constraints.some((constraint) => constraint.kind === "hard" && constraint.axis === "evidence")).toBe(true);
    expect(plan.constraints.some((constraint) => constraint.kind === "soft" && constraint.axis === "scene")).toBe(true);
  });

  test("rollout enables owner curated canaries only after the explicit worker-safety gate", () => {
    const plan = createSelectionPlanV2({ prompt: "House music", brief: brief() });
    expect(assignPipelineV2({ plan, owner: true, stickyKey: "owner", env: {} })).toMatchObject({
      assigned: false,
      reason: "legacy_control",
    });
    expect(assignPipelineV2({
      plan,
      owner: true,
      stickyKey: "owner",
      env: { PIPELINE_V2_OWNER_CANARY: "true" },
    })).toMatchObject({
      assigned: true,
      reason: "owner_canary",
    });
    const first = assignPipelineV2({
      plan,
      owner: false,
      stickyKey: "visitor-a",
      env: { PIPELINE_V2_CURATED_PERCENT: "25" },
    });
    const repeated = assignPipelineV2({
      plan,
      owner: false,
      stickyKey: "visitor-a",
      env: { PIPELINE_V2_CURATED_PERCENT: "25" },
    });
    expect(repeated).toEqual(first);
    expect(first.percentage).toBe(25);
  });

  test("rollout identity stays stable across prompts within one route and policy", () => {
    const housePlan = createSelectionPlanV2({ prompt: "House music", brief: brief() });
    const drillPlan = createSelectionPlanV2({
      prompt: "American drill",
      brief: brief({
        title: "American drill",
        subjectEntities: ["American drill"],
        relationship: "is a recording in the American drill genre",
      }),
    });
    expect(pipelineRolloutStickyKey("visitor-a", housePlan))
      .toBe(pipelineRolloutStickyKey("visitor-a", drillPlan));
    expect(pipelineRolloutStickyKey("visitor-b", housePlan))
      .not.toBe(pipelineRolloutStickyKey("visitor-a", housePlan));
  });

  test("similarity public traffic graduates independently from core curated traffic", () => {
    const housePlan = createSelectionPlanV2({ prompt: "House music", brief: brief() });
    const similarityPlan = createSelectionPlanV2({
      prompt: "Songs like Radiohead but do not include Radiohead",
      brief: brief({
        title: "Radiohead-adjacent",
        subjectEntities: ["Radiohead"],
        relationship: "is stylistically similar to Radiohead",
        include: ["Similar production, harmony, and vocal style."],
        exclude: ["Reference artist is a style seed; exclude recordings by: Radiohead"],
      }),
    });

    expect(pipelineV2RolloutGroup(housePlan)).toBe("curated_core");
    expect(pipelineV2RolloutGroup(similarityPlan)).toBe("curated_similarity");
    expect(pipelineRolloutStickyKey("visitor-a", housePlan))
      .not.toBe(pipelineRolloutStickyKey("visitor-a", similarityPlan));

    expect(assignPipelineV2({
      plan: similarityPlan,
      owner: false,
      stickyKey: pipelineRolloutStickyKey("visitor-a", similarityPlan),
      env: { PIPELINE_V2_CURATED_PERCENT: "100", PIPELINE_V2_SIMILARITY_PERCENT: "0" },
    })).toMatchObject({ assigned: false, percentage: 0, reason: "legacy_control" });
    expect(assignPipelineV2({
      plan: similarityPlan,
      owner: false,
      stickyKey: pipelineRolloutStickyKey("visitor-a", similarityPlan),
      env: { PIPELINE_V2_CURATED_PERCENT: "0", PIPELINE_V2_SIMILARITY_PERCENT: "100" },
    })).toMatchObject({ assigned: true, percentage: 100, reason: "sticky_rollout" });
  });

  test("factual V2 uses independent owner and sticky rollout gates", () => {
    const plan = createSelectionPlanV2({
      prompt: "Every Paulinho da Costa credit",
      brief: brief({
        mode: "exhaustive",
        subjectEntities: ["Paulinho da Costa"],
        relationship: "performed percussion on the released recording",
        targetSize: null,
      }),
    });
    expect(assignPipelineV2({ plan, owner: true, stickyKey: "owner", env: {} })).toMatchObject({
      assigned: false,
      reason: "legacy_control",
    });
    expect(assignPipelineV2({
      plan,
      owner: true,
      stickyKey: "owner",
      env: { PIPELINE_V2_FACTUAL_CANARY: "1" },
    })).toMatchObject({ assigned: false, percentage: 0, reason: "legacy_control" });
    expect(assignPipelineV2({
      plan,
      owner: true,
      stickyKey: "owner",
      env: { PIPELINE_V2_FACTUAL_OWNER_CANARY: "true" },
    })).toMatchObject({ assigned: true, percentage: 100, reason: "owner_canary" });
    expect(assignPipelineV2({
      plan,
      owner: false,
      stickyKey: "public-factual",
      env: { PIPELINE_V2_FACTUAL_PERCENT: "100", PIPELINE_V2_CURATED_PERCENT: "0" },
    })).toMatchObject({ assigned: true, percentage: 100, reason: "sticky_rollout" });
  });
});
