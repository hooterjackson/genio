import { describe, expect, test } from "vitest";
import {
  publicBriefStatusView,
  publicResearchRunView,
} from "../server/public-api-projections.ts";
import type { PlaylistBrief, ResearchRunView } from "../shared/types.ts";

const brief: PlaylistBrief = {
  title: "French jazz",
  description: "A broad survey of French jazz.",
  mode: "curated",
  subjectEntities: ["French jazz"],
  relationship: "genre and scene",
  include: [],
  exclude: [],
  versionPolicy: "studio recordings",
  evidencePolicy: "documented scope",
  orderingPolicy: "editorial",
  targetSize: { min: 50, max: 50 },
  ambiguities: [],
};

function serializedKeys(value: unknown): string[] {
  const keys: string[] = [];
  const visit = (current: unknown) => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) {
      keys.push(key);
      visit(child);
    }
  };
  visit(JSON.parse(JSON.stringify(value)));
  return keys;
}

describe("public API projections", () => {
  test("the capability run payload cannot expose accounting or owner policy fields", () => {
    const internal = {
      id: "canonical-run-id",
      prompt: "French jazz",
      brief,
      status: "researching",
      phase: "catalog_discovery",
      autoPublish: true,
      error: null,
      candidateCount: 73,
      sourceCount: 8,
      unresolvedCount: 1,
      frontier: [],
      estimatedCostUsd: 1.5,
      actualCostUsd: 0.42,
      approvedBudgetUsd: 1.5,
      reservedCostUsd: 0.18,
      budgetApprovalExpiresAt: "2026-07-20T00:00:00.000Z",
      pipelineVersion: "pipeline_v2",
      policyVersion: "relevance_first_2026_07",
      selectionPlan: null,
      pipelinePolicySnapshot: {
        costLimits: {
          curatedRunCeilingUsd: 1.5,
          scoutCeilingUsd: 0.03,
        },
      },
      pipelineOutcome: null,
      candidateStageCounts: { discovered: 73 },
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:01:00.000Z",
      completedAt: null,
    } as unknown as ResearchRunView & Record<string, unknown>;

    const source = structuredClone(internal);
    const view = publicResearchRunView(internal, {
      id: "public-access-id",
      prompt: "My French jazz request",
    });
    const keys = serializedKeys(view);

    expect(view).toMatchObject({
      id: "public-access-id",
      prompt: "My French jazz request",
      candidateCount: 73,
      pipelineVersion: "pipeline_v2",
    });
    expect(keys.filter((key) => /cost|budget|estimate/iu.test(key))).toEqual([]);
    expect(keys).not.toContain("pipelinePolicySnapshot");
    expect(keys).not.toContain("canonicalRunId");
    expect(source).toMatchObject({
      estimatedCostUsd: 1.5,
      actualCostUsd: 0.42,
      approvedBudgetUsd: 1.5,
      reservedCostUsd: 0.18,
      pipelinePolicySnapshot: expect.any(Object),
    });
  });

  test("the public brief payload cannot expose estimates supplied by an internal row", () => {
    const view = publicBriefStatusView({
      requestId: "brief-id",
      prompt: "French jazz",
      requestedTrackCount: 50,
      status: "complete",
      brief,
      questions: [],
      estimateUsd: 1.5,
      estimate: "$0.75–$1.50",
      approvedBudgetUsd: 1.5,
      actualCostUsd: 0.02,
    });
    const keys = serializedKeys(view);

    expect(view).toMatchObject({
      requestId: "brief-id",
      prompt: "French jazz",
      requestedTrackCount: 50,
      status: "complete",
    });
    expect(keys.filter((key) => /cost|budget|estimate/iu.test(key))).toEqual([]);
  });
});
