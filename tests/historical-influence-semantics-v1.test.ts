import { describe, expect, test } from "vitest";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  classifyHistoricalInfluenceSemanticsV1,
  HISTORICAL_INFLUENCE_SEMANTIC_CLASSIFIER_VERSION_V1,
} from "../server/historical-influence-semantics-v1.ts";
import {
  createSelectionPlanV2,
  selectionPromptHasInfluenceScopeSignalV1,
} from "../server/selection-plan-v2.ts";
import {
  createRunSpecV3,
  resolveRunSpecV3,
} from "../server/selection-plan-v3.ts";
import { pipelineV3RolloutGroup } from "../server/query-plan-v3.ts";

function brief(prompt: string): PlaylistBrief {
  return {
    title: "Curated music",
    description: prompt,
    mode: "curated",
    subjectEntities: [],
    relationship: "recordings within the requested musical scope",
    include: [],
    exclude: [],
    versionPolicy: "Prefer canonical studio recordings.",
    evidencePolicy: "Use policy-valid evidence.",
    orderingPolicy: "Use a coherent editorial flow.",
    targetSize: { min: 25, max: 25 },
    ambiguities: [],
  };
}

describe("historical influence semantic classifier v1", () => {
  test.each([
    "Infuential Irish music",
    "Influential Irish music",
    "Foundational Detroit techno",
    "Landmark Nigerian recordings",
    "Seminal Japanese jazz",
    "Music that changed the world",
    "Sounds that shaped a scene",
    "Women who shaped Detroit techno",
    "A history of Irish music",
  ])("keeps genuine influence semantics aligned across compilers for %s", (
    prompt,
  ) => {
    const classification = classifyHistoricalInfluenceSemanticsV1(prompt);
    const v2 = createSelectionPlanV2({
      prompt,
      brief: brief(prompt),
      storefront: "us",
    });
    const v3 = resolveRunSpecV3(createRunSpecV3({
      prompt,
      requestedTrackCount: 25,
      storefront: "us",
      typedSelectionPlan: v2,
    }), []);

    expect(classification).toMatchObject({
      version: HISTORICAL_INFLUENCE_SEMANTIC_CLASSIFIER_VERSION_V1,
      matched: true,
    });
    expect(selectionPromptHasInfluenceScopeSignalV1(prompt)).toBe(true);
    expect(v2.intents).toContain("editorial_ranking");
    expect(v3.intents).toContain("editorial_ranking");
    expect(v3.rankingObjectives).toContainEqual(expect.objectContaining({
      dimension: "influence",
    }));
    expect(pipelineV3RolloutGroup(v3)).toBe("editorial_influence");
  });

  test.each([
    "Essential Irish music",
    "Iconic Irish music",
    "Canonical Irish recordings",
    "Best Irish music",
    "Top 25 Irish songs",
    "Greatest Irish tracks",
    "Important Irish music",
  ])("keeps soft editorial descriptors out of historical influence for %s", (
    prompt,
  ) => {
    const classification = classifyHistoricalInfluenceSemanticsV1(prompt);
    const v2 = createSelectionPlanV2({
      prompt,
      brief: brief(prompt),
      storefront: "us",
    });
    const v3 = resolveRunSpecV3(createRunSpecV3({
      prompt,
      requestedTrackCount: 25,
      storefront: "us",
      typedSelectionPlan: v2,
    }), []);

    expect(classification).toEqual({
      version: HISTORICAL_INFLUENCE_SEMANTIC_CLASSIFIER_VERSION_V1,
      matched: false,
      match: "none",
    });
    expect(selectionPromptHasInfluenceScopeSignalV1(prompt)).toBe(false);
    expect(v2.intents).not.toContain("editorial_ranking");
    expect(v3.intents).not.toContain("editorial_ranking");
    expect(v3.rankingObjectives).not.toContainEqual(expect.objectContaining({
      dimension: "influence",
    }));
    expect(pipelineV3RolloutGroup(v3)).toBe("genre_scene");
  });
});
