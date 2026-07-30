import { describe, expect, test } from "vitest";
import {
  publicBriefStatusView,
  publicResearchRunView,
  publicRunResolutionView,
} from "../server/public-api-projections.ts";
import type {
  PartialPublicationActionView,
  PlaylistBrief,
  ResearchRunView,
  RunResolutionView,
} from "../shared/types.ts";
import { compilePlaylistContractRevisionV1 } from "../server/playlist-contract-v1.ts";
import { predicateYieldRescueGuidanceDecisionV3 } from "../server/adaptive-guidance-v3.ts";
import { publicGuidanceQuestionV3 } from "../server/adaptive-guidance-contract-bridge.ts";

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
  const resolution = (
    nextAction: RunResolutionView["nextAction"],
    state: RunResolutionView["state"] = "needs_decision",
  ): RunResolutionView => ({
    state,
    nextAction,
    terminal: false,
    contractRevisionId: "contract-id",
    contractRevision: 3,
    contractHash: "c".repeat(64),
    blocker: null,
  });

  test("preserves the V4 interpretation checkpoint without leaking unrelated brief internals", () => {
    const view = publicBriefStatusView({
      requestId: "brief-confirmation",
      prompt: "Exactly 25 studio recordings by Radiohead",
      requestedTrackCount: 25,
      status: "awaiting_answers",
      briefContractVersion: 3,
      questionSetHash: "a".repeat(64),
      checkpointMode: "interpretation_confirmation",
      interpretationSummary: {
        mustHave: ["Recordings by Radiohead", "Studio recordings"],
        prefer: [],
        avoid: ["Live recordings", "Remixes"],
        flow: ["Chronological"],
        count: 25,
      },
      questions: [],
      privateCompilerTrace: "must not be public",
    });
    expect(view).toMatchObject({
      status: "awaiting_answers",
      questions: [],
      checkpointMode: "interpretation_confirmation",
      interpretationSummary: {
        count: 25,
        flow: ["Chronological"],
      },
    });
    expect(view).not.toHaveProperty("privateCompilerTrace");
  });

  test("narrows owner-only and unimplemented run actions to visitor-supported paths", () => {
    expect(publicRunResolutionView(
      resolution("answer_rescue_guidance", "needs_input"),
      null,
    )).toMatchObject({
      state: "needs_decision",
      nextAction: "review_contract",
    });
    expect(publicRunResolutionView(
      resolution("authorize_apple", "blocked_dependency"),
      null,
    )).toMatchObject({
      state: "blocked_dependency",
      nextAction: "wait_for_dependency",
    });
    expect(publicRunResolutionView(
      resolution("resume_research", "blocked_dependency"),
      null,
    )).toMatchObject({
      state: "needs_decision",
      nextAction: "review_contract",
    });
  });

  test("preserves only a complete hash-bound rescue question action", () => {
    const contract = compilePlaylistContractRevisionV1({
      contractId: "public-rescue-action",
      rawPrompt: "50 French jazz tracks from the 1970s",
      requestedTrackCount: 50,
      locale: "en",
      storefront: "us",
      clauses: [
        {
          id: "genre:jazz",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "genre",
          operator: "require",
          values: ["jazz"],
          source: { provenance: "prompt", text: "Jazz" },
        },
        {
          id: "era:1970s",
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
          { op: "clause", clauseId: "genre:jazz" },
          { op: "clause", clauseId: "era:1970s" },
        ],
      },
    });
    const decision = predicateYieldRescueGuidanceDecisionV3({
      baseContract: contract,
      limitingClauseIds: ["era:1970s"],
    })!;
    const question = publicGuidanceQuestionV3(decision);
    const internal = {
      id: "canonical-run-id",
      prompt: "French jazz",
      brief,
      status: "needs_decision",
      phase: "rescue_guidance_required",
      error: null,
      candidateCount: 31,
      sourceCount: 4,
      unresolvedCount: 1,
      frontier: [],
      guidanceAction: {
        kind: "rescue_guidance",
        questionSetHash: "e".repeat(64),
        baseContractRevisionId: contract.revisionId,
        baseContractSemanticHash: contract.semanticHash,
        questions: [{ ...question, privatePrompt: "do not expose" }],
        attemptsUsed: 1,
        maximumAttempts: 2,
        showEditableInterpretationSummary: false,
        privateProviderState: "do not expose",
      },
      resolution: resolution("answer_rescue_guidance", "needs_input"),
    } as unknown as ResearchRunView & Record<string, unknown>;

    const view = publicResearchRunView(internal, { id: "public-access-id" });
    expect(view.guidanceAction).toMatchObject({
      kind: "rescue_guidance",
      questionSetHash: "e".repeat(64),
      questions: [{
        id: decision.id,
        trigger: "yield_risk",
      }],
      attemptsUsed: 1,
      maximumAttempts: 2,
    });
    expect(view.resolution).toMatchObject({
      state: "needs_input",
      nextAction: "answer_rescue_guidance",
    });
    expect(serializedKeys(view.guidanceAction)).not.toContain("privatePrompt");
    expect(serializedKeys(view.guidanceAction)).not.toContain("privateProviderState");
  });

  test("projects a zero-question clarification-limit summary as an explicit decision", () => {
    const internal = {
      id: "clarification-limit-run",
      prompt: "French jazz",
      brief,
      status: "needs_decision",
      phase: "interpretation_summary_required",
      error: null,
      candidateCount: 31,
      sourceCount: 4,
      unresolvedCount: 1,
      frontier: [],
      guidanceAction: {
        kind: "interpretation_summary",
        questionSetHash: "f".repeat(64),
        baseContractRevisionId: "pcr1:clarification-limit",
        baseContractSemanticHash: "d".repeat(64),
        questions: [],
        attemptsUsed: 2,
        maximumAttempts: 2,
        showEditableInterpretationSummary: true,
        reason: "clarification_attempt_limit",
        axis: "french_jazz_scope",
        interpretationSummary: {
          mustHave: ["Jazz", "Artists from France"],
          prefer: ["Editorial balance"],
          avoid: [],
          flow: ["Smooth"],
          count: 50,
          privatePrompt: "do not expose",
        },
        actions: {
          changeEarlierAnswer: true,
          reviewContract: true,
          resumeLater: true,
          cancel: true,
        },
        privateProviderState: "do not expose",
      },
      resolution: resolution("review_contract"),
    } as unknown as ResearchRunView & Record<string, unknown>;

    const view = publicResearchRunView(internal, { id: "public-access-id" });
    expect(view.guidanceAction).toEqual({
      kind: "interpretation_summary",
      questionSetHash: "f".repeat(64),
      baseContractRevisionId: "pcr1:clarification-limit",
      baseContractSemanticHash: "d".repeat(64),
      questions: [],
      attemptsUsed: 2,
      maximumAttempts: 2,
      showEditableInterpretationSummary: true,
      reason: "clarification_attempt_limit",
      axis: "french_jazz_scope",
      interpretationSummary: {
        mustHave: ["Jazz", "Artists from France"],
        prefer: ["Editorial balance"],
        avoid: [],
        flow: ["Smooth"],
        count: 50,
      },
      actions: {
        changeEarlierAnswer: true,
        reviewContract: true,
        resumeLater: true,
        cancel: true,
      },
    });
    expect(serializedKeys(view.guidanceAction)).not.toContain("privatePrompt");
    expect(serializedKeys(view.guidanceAction)).not.toContain(
      "privateProviderState",
    );
  });

  test("preserves an actionable canonical capability decision without exposing blocker internals", () => {
    expect(publicRunResolutionView({
      ...resolution("review_contract"),
      blocker: {
        kind: "scope_decision",
        nextRetryAt: null,
        automaticRetryUntil: null,
        retryCount: 0,
        versionHash: null,
      },
    }, null)).toEqual({
      state: "needs_decision",
      nextAction: "review_contract",
      terminal: false,
      contractRevisionId: "contract-id",
      contractRevision: 3,
      contractHash: "c".repeat(64),
      blocker: {
        kind: "scope_decision",
        nextRetryAt: null,
        automaticRetryUntil: null,
        retryCount: 0,
        versionHash: null,
      },
    });
  });

  test("preserves only a hash-bound retained provider resume action", () => {
    const versionHash = "9".repeat(64);
    expect(publicRunResolutionView({
      ...resolution("resume_research"),
      blocker: {
        kind: "provider",
        nextRetryAt: null,
        automaticRetryUntil: "2026-07-24T12:00:00.000Z",
        retryCount: 8,
        versionHash,
      },
    }, null)).toMatchObject({
      state: "needs_decision",
      nextAction: "resume_research",
      blocker: {
        kind: "provider",
        versionHash,
      },
    });
    expect(publicRunResolutionView({
      ...resolution("resume_research"),
      blocker: {
        kind: "provider",
        nextRetryAt: null,
        automaticRetryUntil: "2026-07-24T12:00:00.000Z",
        retryCount: 8,
        versionHash: null,
      },
    }, null)).toMatchObject({
      state: "needs_decision",
      nextAction: "review_contract",
    });
  });

  test("projects a retryable V2 provider failure as a visible dependency pause", () => {
    expect(publicRunResolutionView({
      ...resolution("wait_for_dependency", "blocked_dependency"),
      blocker: {
        kind: "provider",
        nextRetryAt: "2026-07-24T12:05:00.000Z",
        automaticRetryUntil: "2026-07-25T12:00:00.000Z",
        retryCount: 1,
        versionHash: null,
      },
    }, null)).toEqual({
      state: "blocked_dependency",
      nextAction: "wait_for_dependency",
      terminal: false,
      contractRevisionId: "contract-id",
      contractRevision: 3,
      contractHash: "c".repeat(64),
      blocker: {
        kind: "provider",
        nextRetryAt: "2026-07-24T12:05:00.000Z",
        automaticRetryUntil: "2026-07-25T12:00:00.000Z",
        retryCount: 1,
        versionHash: null,
      },
    });
  });

  test("advertises the partial decision only when its hash-bound payload is usable", () => {
    const partialAction: PartialPublicationActionView = {
      kind: "partial_publication",
      targetTrackCount: 50,
      qualifiedTrackCount: 42,
      remainingStrategyCount: 1,
      canContinueResearch: true,
      reasonCode: "frontier_exhausted_under_policy",
      outcomeVersion: 2,
      outcomeHash: "a".repeat(64),
    };
    expect(publicRunResolutionView(
      resolution("resume_research", "blocked_dependency"),
      partialAction,
    )).toMatchObject({
      state: "needs_decision",
      nextAction: "decide_verified_partial",
    });
    expect(publicRunResolutionView(
      resolution("decide_verified_partial"),
      null,
    )).toMatchObject({
      state: "needs_decision",
      nextAction: "review_contract",
    });
  });

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
      requestedTrackCount: 60,
      originalRequestedTrackCount: 50,
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
      requestedTrackCount: 60,
      originalRequestedTrackCount: 50,
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
      decisionAction: {
        schemaVersion: "genio-run-decision/v1",
        decisionHash: "c".repeat(64),
        contractRevisionId: "pcr1:revision",
        contractSemanticHash: "d".repeat(64),
        reason: "active_compute_limit",
        targetTrackCount: 50,
        verifiedTrackCount: 43,
        remainingStrategyCount: 1,
        consumedActiveComputeMs: 900_000,
        activeComputeLimitMs: 900_000,
        activeComputeExtensionsUsed: 0,
        namedPredicates: [{ clauseId: "prompt:era", label: "1970s only", privateEvidence: "secret" }],
        interpretationSummary: {
          mustHave: ["Brazilian disco"],
          prefer: [],
          avoid: [],
          flow: ["Smooth"],
          count: 50,
          rawPrompt: "private prompt",
        },
        actions: {
          anotherBoundedPass: true,
          reviseNamedPredicate: true,
          reduceCount: true,
          publishVerifiedPartial: true,
          pause: true,
          resumeLater: false,
          cancel: true,
          internalOverride: true,
        },
        reachedAt: "2026-07-23T12:00:00.000Z",
        privateProviderState: "secret",
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
    expect(view.decisionAction).toMatchObject({
      kind: "research_boundary",
      decisionHash: "c".repeat(64),
      reason: "active_compute_limit",
      verifiedTrackCount: 43,
      namedPredicates: [{ clauseId: "prompt:era", label: "1970s only" }],
      actions: {
        anotherBoundedPass: true,
        publishVerifiedPartial: true,
      },
    });
    const keys = serializedKeys(view);
    expect(keys).not.toContain("continuationJob");
    expect(keys).not.toContain("capabilitySessionId");
    expect(keys).not.toContain("ownerApproved");
    expect(keys).not.toContain("publicPlaylistId");
    expect(keys).not.toContain("privateProviderState");
    expect(keys).not.toContain("privateEvidence");
    expect(keys).not.toContain("rawPrompt");
    expect(keys).not.toContain("internalOverride");
    expect(keys.filter((key) => /cost|budget|estimate/iu.test(key))).toEqual([]);

    const expanded = publicResearchRunView({
      ...internal,
      partialAction: {
        ...(internal.partialAction as unknown as Record<string, unknown>),
        targetTrackCount: 1_000,
        qualifiedTrackCount: 999,
      },
      decisionAction: null,
    } as unknown as ResearchRunView & Record<string, unknown>, { id: "owner-access-id" });
    expect(expanded.partialAction).toMatchObject({
      targetTrackCount: 1_000,
      qualifiedTrackCount: 999,
    });
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
