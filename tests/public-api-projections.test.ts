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
      progress: {
        targetTrackCount: 50,
        latestActivityAt: "2026-07-19T00:00:45.000Z",
        sourceSummary: {
          total: 8,
          recentSources: [
            { title: "Scene history", domain: "history.example/private?token=secret", sourceClass: "web", url: "https://history.example/private?token=secret" },
            { title: "Label archive", domain: "label.example", sourceClass: "web", providerId: "private-provider-id" },
            { title: "Apple editorial", domain: "music.apple.com", sourceClass: "apple" },
            { title: "Fourth source is capped", domain: "fourth.example", sourceClass: "web" },
          ],
          rawQuery: "private query",
          model: "private model",
        },
        frontierSummary: {
          total: 4, complete: 2, active: 1, unresolved: 1, inaccessible: 0,
          discoveredCount: 70, recoveredCount: 55, cursor: "private cursor",
        },
        containerSummary: {
          total: 5, complete: 3, active: 1, unresolved: 1, inaccessible: 0,
          advertisedCount: 100, recoveredCount: 72, providerIds: ["private"],
        },
        matchSummary: {
          attempted: 52, accepted: 47, review: 2, unavailable: 1, duplicate: 1,
          rejected: 0, unsupported: 1, overflow: 0, shortfall: 3,
          estimatedCostUsd: 1.5,
        },
        publicationSummary: {
          volumeCount: 1, completedVolumes: 0, totalTracks: 50, appendedTracks: 25,
          currentVolume: 1, status: "appending", applePlaylistId: "private-apple-id",
        },
      },
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
      progress: {
        targetTrackCount: 50,
        sourceSummary: {
          total: 8,
          recentSources: [
            { title: "Scene history", domain: "history.example", sourceClass: "web" },
            { title: "Label archive", domain: "label.example", sourceClass: "web" },
            { title: "Apple editorial", domain: "music.apple.com", sourceClass: "apple" },
          ],
        },
        matchSummary: { accepted: 47, shortfall: 3 },
        publicationSummary: { status: "appending" },
      },
    });
    expect(keys.filter((key) => /cost|budget|estimate/iu.test(key))).toEqual([]);
    expect(keys.filter((key) => /query|cursor|model|providerId|applePlaylistId|url/iu.test(key))).toEqual([]);
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
      briefContractVersion: 2,
      questionSetHash: "a".repeat(64),
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
      briefContractVersion: 2,
      questionSetHash: "a".repeat(64),
    });
    expect(keys.filter((key) => /cost|budget|estimate/iu.test(key))).toEqual([]);
  });

  test("partial-publication and Explore actions expose only capability-safe fields", () => {
    const internal = {
      id: "canonical-run-id",
      prompt: "Brazilian disco",
      brief,
      status: "partial_ready",
      phase: "partial_ready",
      autoPublish: false,
      error: null,
      candidateCount: 43,
      sourceCount: 7,
      unresolvedCount: 2,
      frontier: [],
      partialAction: {
        kind: "partial_publication",
        targetTrackCount: 50,
        qualifiedTrackCount: 43,
        remainingStrategyCount: 1,
        canContinueResearch: true,
        reasonCode: "evidence_shortfall",
        outcomeVersion: 2,
        outcomeHash: "a".repeat(64),
        manifestId: "2c812cc4-ad02-4b98-91ee-0037223f28aa",
        manifestHash: "b".repeat(64),
        continuationJob: { kind: "research", payload: { secret: true } },
        capabilitySessionId: "private-session",
        costUsd: 0.75,
      },
      explore: {
        eligible: false,
        listed: false,
        canChange: true,
        reason: "Owner approval is required below 90% fill",
        ownerApproved: false,
        publicPlaylistId: "private-public-playlist-id",
      },
    } as unknown as ResearchRunView & Record<string, unknown>;

    const view = publicResearchRunView(internal, {
      id: "public-access-id",
      prompt: "Brazilian disco",
    });

    expect(view.partialAction).toEqual({
      kind: "partial_publication",
      targetTrackCount: 50,
      qualifiedTrackCount: 43,
      remainingStrategyCount: 1,
      canContinueResearch: true,
      reasonCode: "evidence_shortfall",
      outcomeVersion: 2,
      outcomeHash: "a".repeat(64),
      manifestId: "2c812cc4-ad02-4b98-91ee-0037223f28aa",
      manifestHash: "b".repeat(64),
    });
    expect(view.explore).toEqual({
      eligible: false,
      listed: false,
      canChange: true,
      reason: "Owner approval is required below 90% fill",
    });
    const keys = serializedKeys(view);
    expect(keys).not.toContain("continuationJob");
    expect(keys).not.toContain("capabilitySessionId");
    expect(keys).not.toContain("ownerApproved");
    expect(keys).not.toContain("publicPlaylistId");
    expect(keys.filter((key) => /cost|budget|estimate/iu.test(key))).toEqual([]);
  });

  test("invalid or stale-looking action payloads are omitted instead of repaired", () => {
    const internal = {
      id: "canonical-run-id",
      prompt: "Brazilian disco",
      brief,
      status: "partial_ready",
      phase: "partial_ready",
      autoPublish: false,
      error: null,
      candidateCount: 0,
      sourceCount: 0,
      unresolvedCount: 1,
      frontier: [],
      partialAction: {
        kind: "partial_publication",
        targetTrackCount: 50,
        qualifiedTrackCount: 50,
        remainingStrategyCount: 1,
        canContinueResearch: true,
        outcomeVersion: 1,
        outcomeHash: "not-a-content-hash",
      },
      explore: { eligible: "yes", listed: false, canChange: true },
    } as unknown as ResearchRunView & Record<string, unknown>;

    const view = publicResearchRunView(internal, { id: "public-access-id" });
    expect(view.partialAction).toBeNull();
    expect(view.explore).toBeNull();
  });
});
