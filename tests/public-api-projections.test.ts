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
  RunDecisionActionView,
  RunResolutionView,
} from "../shared/types.ts";
import {
  ADAPTIVE_RUN_DECISION_SCHEMA_V1,
} from "../server/adaptive-run-decision-v1.ts";
import { compilePlaylistContractRevisionV1 } from "../server/playlist-contract-v1.ts";
import { predicateYieldRescueGuidanceDecisionV3 } from "../server/adaptive-guidance-v3.ts";
import { publicGuidanceQuestionV3 } from "../server/adaptive-guidance-contract-bridge.ts";
import { sha256Hex, stableStringify } from "../server/security.ts";

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
  const hashedAdaptiveDecision = (
    body: Omit<RunDecisionActionView, "kind" | "decisionHash">,
  ): RunDecisionActionView => ({
    kind: "research_boundary",
    decisionHash: sha256Hex(stableStringify({
      schemaVersion: ADAPTIVE_RUN_DECISION_SCHEMA_V1,
      ...body,
    })),
    ...body,
  });
  const adaptiveDecision = (
    action: "review_contract" | "resume_research",
  ): RunDecisionActionView => hashedAdaptiveDecision({
    contractRevisionId: "pcr1:public-projection",
    contractSemanticHash: "c".repeat(64),
    reason: action === "resume_research"
      ? "dependency_retry_window_expired" as const
      : "runtime_feasibility_unknown" as const,
    targetTrackCount: 50,
    verifiedTrackCount: 0,
    remainingStrategyCount: 0,
    consumedActiveComputeMs: 0,
    activeComputeLimitMs: 900_000,
    activeComputeExtensionsUsed: 0,
    namedPredicates: action === "review_contract"
      ? [{ clauseId: "membership:irish", label: "Irish music" }]
      : [],
    interpretationSummary: {
      mustHave: ["Irish music"],
      prefer: [],
      avoid: [],
      flow: [],
      count: 50,
    },
    actions: {
      anotherBoundedPass: false,
      reviseNamedPredicate: action === "review_contract",
      reduceCount: false,
      publishVerifiedPartial: false,
      pause: true,
      resumeLater: action === "resume_research",
      cancel: true,
    },
    reachedAt: "2026-08-02T00:00:00.000Z",
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

  test("projects only the hash-bound execution-decision action", () => {
    const executionAction = {
      decisionHash: "a".repeat(64),
      optionId: "review_interpretation",
      kind: "review_interpretation" as const,
      startsResearch: false,
      actionHash: "b".repeat(64),
    };
    const view = publicBriefStatusView({
      requestId: "brief-review",
      prompt: "Kind of Blue in order",
      requestedTrackCount: 25,
      status: "review_required",
      briefContractVersion: 3,
      executionAction,
      questions: [],
      internalIdempotencyKey: "must-not-leak",
    });
    expect(view).toMatchObject({
      status: "review_required",
      executionAction,
      questions: [],
    });
    expect(view).not.toHaveProperty("internalIdempotencyKey");
  });

  test("narrows owner-only and unimplemented run actions to visitor-supported paths", () => {
    expect(publicRunResolutionView(
      resolution("answer_rescue_guidance", "needs_input"),
      null,
    )).toMatchObject({
      state: "quarantined",
      nextAction: "contact_support",
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
      state: "quarantined",
      nextAction: "contact_support",
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
      contractSemanticRevisionId: "pcr1:public-projection",
      blocker: {
        kind: "scope_decision",
        nextRetryAt: null,
        automaticRetryUntil: null,
        retryCount: 0,
        versionHash: null,
      },
    }, null, null, adaptiveDecision("review_contract"))).toEqual({
      state: "needs_decision",
      nextAction: "review_contract",
      terminal: false,
      contractRevisionId: "contract-id",
      contractSemanticRevisionId: "pcr1:public-projection",
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
    expect(publicRunResolutionView({
      ...resolution("review_contract"),
      contractSemanticRevisionId: "pcr1:other",
    }, null, null, adaptiveDecision("review_contract"))).toMatchObject({
      state: "quarantined",
      nextAction: "contact_support",
      contractRevisionId: "contract-id",
      contractSemanticRevisionId: "pcr1:other",
    });
    expect(publicRunResolutionView(
      resolution("review_contract"),
      null,
      null,
      adaptiveDecision("review_contract"),
    )).toMatchObject({
      state: "quarantined",
      nextAction: "contact_support",
      contractRevisionId: "contract-id",
    });
  });

  test("fails closed for paused or stalled work and preserves truthful motion", () => {
    expect(publicRunResolutionView({
      ...resolution("none", "publishing"),
      workMotion: "paused",
      selectedTrackCount: 25,
      manifestedTrackCount: 25,
      appendedTrackCount: 0,
      reconciledPublishedTrackCount: null,
    }, null)).toMatchObject({
      state: "quarantined",
      nextAction: "contact_support",
      workMotion: "paused",
      selectedTrackCount: 25,
      manifestedTrackCount: 25,
      appendedTrackCount: 0,
      reconciledPublishedTrackCount: null,
    });
    expect(publicRunResolutionView({
      ...resolution("none", "executing"),
      workMotion: "stalled",
    }, null)).toMatchObject({
      state: "quarantined",
      nextAction: "contact_support",
      workMotion: "stalled",
    });
    expect(publicRunResolutionView({
      ...resolution("none", "executing"),
      workMotion: "running",
      activeComputeMs: 15_000,
    }, null)).toMatchObject({
      state: "executing",
      nextAction: "none",
      workMotion: "running",
      activeComputeMs: 15_000,
    });
  });

  test("preserves only a hash-bound retained provider resume action", () => {
    const versionHash = "9".repeat(64);
    expect(publicRunResolutionView({
      ...resolution("resume_research"),
      contractSemanticRevisionId: "pcr1:public-projection",
      blocker: {
        kind: "provider",
        nextRetryAt: null,
        automaticRetryUntil: "2026-07-24T12:00:00.000Z",
        retryCount: 8,
        versionHash,
      },
    }, null, null, adaptiveDecision("resume_research"))).toMatchObject({
      state: "needs_decision",
      nextAction: "resume_research",
      blocker: {
        kind: "provider",
        versionHash,
      },
    });
    expect(publicRunResolutionView({
      ...resolution("resume_research"),
      contractSemanticRevisionId: "pcr1:public-projection",
      blocker: {
        kind: "provider",
        nextRetryAt: null,
        automaticRetryUntil: "2026-07-24T12:00:00.000Z",
        retryCount: 8,
        versionHash: null,
      },
    }, null, null, adaptiveDecision("resume_research"))).toMatchObject({
      state: "quarantined",
      nextAction: "contact_support",
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
      state: "quarantined",
      nextAction: "contact_support",
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
    const decision = hashedAdaptiveDecision({
      contractRevisionId: "pcr1:revision",
      contractSemanticHash: "d".repeat(64),
      reason: "active_compute_limit",
      targetTrackCount: 50,
      verifiedTrackCount: 43,
      remainingStrategyCount: 1,
      consumedActiveComputeMs: 900_000,
      activeComputeLimitMs: 900_000,
      activeComputeExtensionsUsed: 0,
      namedPredicates: [{ clauseId: "prompt:era", label: "1970s only" }],
      interpretationSummary: {
        mustHave: ["Brazilian disco"],
        prefer: [],
        avoid: [],
        flow: ["Smooth"],
        count: 50,
      },
      actions: {
        anotherBoundedPass: true,
        reviseNamedPredicate: true,
        reduceCount: true,
        publishVerifiedPartial: true,
        pause: true,
        resumeLater: false,
        cancel: true,
      },
      reachedAt: "2026-07-23T12:00:00.000Z",
    });
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
        ...decision,
        namedPredicates: [{ clauseId: "prompt:era", label: "1970s only", privateEvidence: "secret" }],
        interpretationSummary: {
          ...decision.interpretationSummary,
          rawPrompt: "private prompt",
        },
        actions: {
          ...decision.actions,
          internalOverride: true,
        },
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
      decisionHash: decision.decisionHash,
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

  test("projects a repair replay and execution truth without private authority material", () => {
    const internal = {
      id: "canonical-run-id",
      prompt: "Private prompt",
      brief,
      status: "failed_integrity",
      phase: "canonical_integrity_quarantine",
      error: null,
      candidateCount: 55,
      sourceCount: 4,
      unresolvedCount: 0,
      frontier: [],
      resolution: {
        generation: 7,
        state: "quarantined",
        nextAction: "contact_support",
        terminal: false,
        contractRevisionId: "contract-row-id",
        contractRevision: 2,
        contractHash: "a".repeat(64),
        blocker: { kind: "integrity", nextRetryAt: null,
          automaticRetryUntil: null, retryCount: 0, versionHash: null },
      },
      repairReplayAction: {
        kind: "repair_replay",
        expectedGeneration: 7,
        incidentReference: "incident:qualification-binding",
        contractRevisionId: "contract-row-id",
        contractSemanticHash: "a".repeat(64),
        available: true,
        availabilityReason: "ready",
        resultReuse: false,
        autoPublication: false,
        privateRepairKey: "never public",
      },
      executionRouteReceipt: {
        version: "execution_route_receipt_v1",
        trafficClass: "public",
        contractVersion: 3,
        guidanceVersion: "adaptive_guidance_v5",
        executionRoute: "corpus_first_v3",
        queryPlanSchema: 6,
        queryPlanHash: "d".repeat(64),
        capabilitySnapshotHash: "e".repeat(64),
        releaseRevision: "b".repeat(40),
        executorConfigurationHash: "f".repeat(64),
        assignmentKind: "signed_public_rollout",
        intentGroup: "genre_scene",
        receiptHash: "c".repeat(64),
        assignmentReceiptHash: "private-authority-hash",
      },
      evidenceCoverage: {
        observationCount: 80,
        qualificationObservationCount: 77,
        legacyUnboundQualificationCount: 5,
        uniqueLeadCount: 80,
        candidates: 55,
        materializedCandidateCount: 55,
        identityBound: 55,
        appleResolvedCount: 51,
        versionCompatible: 52,
        storefrontPlayable: 50,
        obligationCounts: {
          "verification:historical_influence": {
            pass: 0,
            fail: 0,
            unknown: 77,
          },
        },
        evidencePassed: 48,
        evidenceUnknown: 5,
        evidenceFailed: 2,
        selected: 0,
        manifested: 0,
        appendedCount: 0,
        reconciledPublished: null,
        rawEvidence: "private evidence",
      },
    } as unknown as ResearchRunView & Record<string, unknown>;

    const view = publicResearchRunView(internal, {
      id: "public-access-id",
      prompt: "Public prompt",
    });
    expect(view.resolution?.nextAction).toBe("replay_after_repair");
    expect(view.repairReplayAction).toEqual({
      kind: "repair_replay",
      expectedGeneration: 7,
      incidentReference: "incident:qualification-binding",
      contractRevisionId: "contract-row-id",
      contractSemanticHash: "a".repeat(64),
      available: true,
      availabilityReason: "ready",
      resultReuse: false,
      autoPublication: false,
    });
    expect(view.executionRouteReceipt).toEqual({
      version: "execution_route_receipt_v1",
      trafficClass: "public",
      contractVersion: 3,
      guidanceVersion: "adaptive_guidance_v5",
      executionRoute: "corpus_first_v3",
      queryPlanSchema: 6,
      queryPlanHash: "d".repeat(64),
      capabilitySnapshotHash: "e".repeat(64),
      releaseRevision: "b".repeat(40),
      executorConfigurationHash: "f".repeat(64),
      assignmentKind: "signed_public_rollout",
      intentGroup: "genre_scene",
      receiptHash: "c".repeat(64),
    });
    expect(view.evidenceCoverage).toEqual({
      observationCount: 80,
      qualificationObservationCount: 77,
      legacyUnboundQualificationCount: 5,
      uniqueLeadCount: 80,
      candidates: 55,
      materializedCandidateCount: 55,
      identityBound: 55,
      appleResolvedCount: 51,
      versionCompatible: 52,
      storefrontPlayable: 50,
      obligationCounts: {
        "verification:historical_influence": {
          pass: 0,
          fail: 0,
          unknown: 77,
        },
      },
      evidencePassed: 48,
      evidenceUnknown: 5,
      evidenceFailed: 2,
      selected: 0,
      manifested: 0,
      appendedCount: 0,
      reconciledPublished: null,
    });
    const keys = serializedKeys(view);
    expect(keys).not.toContain("privateRepairKey");
    expect(keys).not.toContain("assignmentReceiptHash");
    expect(keys).not.toContain("rawEvidence");
  });

  test("binds a compatibility-shadow resolution to the authenticated repair generation", () => {
    const internal = {
      id: "canonical-run-id",
      prompt: "Request",
      brief,
      status: "failed_integrity",
      phase: "canonical_integrity_quarantine",
      error: null,
      candidateCount: 0,
      sourceCount: 0,
      unresolvedCount: 0,
      frontier: [],
      resolution: {
        state: "quarantined",
        nextAction: "contact_support",
        terminal: false,
        contractRevisionId: "contract-row-id",
        contractRevision: 1,
        contractHash: "a".repeat(64),
        blocker: null,
      },
      repairReplayAction: {
        kind: "repair_replay",
        expectedGeneration: 5,
        incidentReference: "incident:compatibility-shadow",
        contractRevisionId: "contract-row-id",
        contractSemanticHash: "a".repeat(64),
        available: true,
        availabilityReason: "ready",
        resultReuse: false,
        autoPublication: false,
      },
    } as unknown as ResearchRunView & Record<string, unknown>;

    const view = publicResearchRunView(internal);
    expect(view.resolution).toMatchObject({
      generation: 5,
      state: "quarantined",
      nextAction: "replay_after_repair",
      contractRevisionId: "contract-row-id",
      contractHash: "a".repeat(64),
    });

    const mismatched = publicResearchRunView({
      ...internal,
      resolution: {
        ...internal.resolution,
        contractHash: "b".repeat(64),
      },
    } as unknown as ResearchRunView & Record<string, unknown>);
    expect(mismatched.resolution).toMatchObject({
      nextAction: "contact_support",
      contractHash: "b".repeat(64),
    });
    expect(mismatched.resolution?.generation).toBeUndefined();
  });

  test("does not advertise replay when the repair fence is malformed", () => {
    const internal = {
      id: "canonical-run-id",
      prompt: "Request",
      brief,
      status: "failed_integrity",
      phase: "canonical_integrity_quarantine",
      error: null,
      candidateCount: 0,
      sourceCount: 0,
      unresolvedCount: 0,
      frontier: [],
      resolution: {
        generation: 1,
        state: "quarantined",
        nextAction: "contact_support",
        terminal: false,
        contractRevisionId: "contract-row-id",
        contractRevision: 1,
        contractHash: "a".repeat(64),
        blocker: null,
      },
      repairReplayAction: {
        kind: "repair_replay",
        expectedGeneration: 1,
        incidentReference: "incident",
        contractRevisionId: "contract-row-id",
        contractSemanticHash: "not-a-hash",
        available: true,
        availabilityReason: "ready",
        resultReuse: false,
        autoPublication: false,
      },
    } as unknown as ResearchRunView & Record<string, unknown>;
    const view = publicResearchRunView(internal);
    expect(view.repairReplayAction).toBeNull();
    expect(view.resolution?.nextAction).toBe("contact_support");
  });

  test("retains the authoritative quarantine action while repair is pending", () => {
    const internal = {
      id: "canonical-run-id",
      prompt: "Request",
      brief,
      status: "failed_integrity",
      phase: "evidence_verification_unknown",
      error: null,
      candidateCount: 73,
      sourceCount: 80,
      unresolvedCount: 0,
      frontier: [],
      resolution: {
        generation: 3,
        state: "quarantined",
        nextAction: "contact_support",
        terminal: false,
        contractRevisionId: "contract-row-id",
        contractRevision: 1,
        contractHash: "a".repeat(64),
        blocker: null,
      },
      repairReplayAction: {
        kind: "repair_replay",
        expectedGeneration: 3,
        incidentReference: "incident:evidence-binding",
        contractRevisionId: "contract-row-id",
        contractSemanticHash: "a".repeat(64),
        available: false,
        availabilityReason: "repair_pending",
        resultReuse: false,
        autoPublication: false,
      },
    } as unknown as ResearchRunView & Record<string, unknown>;
    const view = publicResearchRunView(internal);
    expect(view.resolution?.nextAction).toBe("contact_support");
    expect(view.repairReplayAction).toMatchObject({
      available: false,
      availabilityReason: "repair_pending",
      incidentReference: "incident:evidence-binding",
    });
  });

  test("projects the already-created repair successor as the current action", () => {
    const successorBriefRequestId =
      "99999999-9999-4999-8999-999999999999";
    const internal = {
      id: "canonical-run-id",
      prompt: "Request",
      brief,
      status: "failed_integrity",
      phase: "evidence_verification_unknown",
      error: null,
      candidateCount: 73,
      sourceCount: 80,
      unresolvedCount: 0,
      frontier: [],
      resolution: {
        generation: 3,
        state: "quarantined",
        nextAction: "contact_support",
        terminal: false,
        contractRevisionId: "contract-row-id",
        contractRevision: 1,
        contractHash: "a".repeat(64),
        blocker: null,
      },
      repairReplayAction: {
        kind: "repair_replay",
        expectedGeneration: 3,
        incidentReference: "incident:evidence-binding",
        contractRevisionId: "contract-row-id",
        contractSemanticHash: "a".repeat(64),
        available: false,
        availabilityReason: "already_started",
        successorBriefRequestId,
        resultReuse: false,
        autoPublication: false,
      },
    } as unknown as ResearchRunView & Record<string, unknown>;
    const view = publicResearchRunView(internal);
    expect(view.resolution?.nextAction).toBe("replay_after_repair");
    expect(view.repairReplayAction).toMatchObject({
      available: false,
      availabilityReason: "already_started",
      successorBriefRequestId,
    });
  });
});
