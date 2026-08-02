import { describe, expect, test } from "vitest";
import {
  guidanceCheckpointV5,
} from "../server/adaptive-guidance-v5.ts";
import {
  compileGuidanceRoundPatchV3,
  publicGuidanceQuestionV5,
} from "../server/adaptive-guidance-contract-bridge.ts";
import {
  applyPlaylistContractPatchV1,
  compilePlaylistContractRevisionV1,
} from "../server/playlist-contract-v1.ts";
import { projectPlaylistContractExecutionV1 } from "../server/playlist-contract-execution-bridge-v1.ts";
import { canonicalExecutorCapabilityForSchemaV1 } from "../server/playlist-contract-backend-capability-v1.ts";
import {
  createQueryPlanV3,
  pipelineV3RolloutGroup,
  queryPlanV3Hash,
} from "../server/query-plan-v3.ts";
import { selectionPlanFromQueryPlanV3 } from "../server/pipeline-v3-worker-execution.ts";
import {
  assertGuidanceWorkerConsumptionReceiptV5,
  createGuidanceWorkerExecutionAuthorityV5,
  guidanceWorkerConsumptionCheckpointKeyV5,
  guidanceWorkerConsumptionTargetV5,
  verifyGuidanceWorkerConsumptionV5,
} from "../server/guidance-worker-consumption-v5.ts";
import { semanticExecutionConfigurationHash } from "../server/runtime-release.ts";
import {
  assertGuidanceRuntimeConsumerEffectV5,
} from "../server/pipeline-v3-retrieval.ts";
import type {
  PlaylistGuidanceAnswer,
  PlaylistGuidanceQuestion,
  QueryPlanV3,
} from "../shared/types.ts";
import type { PlaylistContractRevisionV1 } from "../server/playlist-contract-v1.ts";
import {
  createRunSpecV3,
  resolveRunSpecV3,
  type SelectionPlanV3,
} from "../server/selection-plan-v3.ts";

const GRAPH_SNAPSHOT_ID = "11111111-1111-4111-8111-111111111111";
const QUERY_PLAN_REVISION_ID = "22222222-2222-4222-8222-222222222222";

function fixture(optionId = "balanced_influence"): {
  base: PlaylistContractRevisionV1;
  successor: PlaylistContractRevisionV1;
  questionSetHash: string;
  question: PlaylistGuidanceQuestion;
  answer: PlaylistGuidanceAnswer;
  queryPlan: QueryPlanV3;
  rehydratedPlan: SelectionPlanV3;
  preGuidanceProjection: ReturnType<typeof projectPlaylistContractExecutionV1>;
  successorProjection: ReturnType<typeof projectPlaylistContractExecutionV1>;
} {
  const base = compilePlaylistContractRevisionV1({
    contractId: "contract:guidance-worker-consumption",
    rawPrompt: "Infuential irish music",
    requestedTrackCount: 25,
    locale: "en",
    storefront: "us",
    clauses: [
      {
        id: "membership:irish-origin",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "artist_origin",
        operator: "require",
        values: ["Irish"],
        source: { provenance: "prompt", text: "irish" },
      },
      {
        id: "quality:documented-influence",
        kind: "suitability",
        scope: "track",
        hardness: "soft",
        axis: "influence",
        operator: "prefer",
        values: ["documented historical influence"],
        source: { provenance: "prompt", text: "Infuential" },
        evidence: {
          required: true,
          minimumGrade: null,
          permittedGrades: [
            "track_specific_editorial_assertion",
            "independent_secondary_source",
          ],
        },
        unknownPolicy: "defer",
      },
      {
        id: "ranking:influence",
        kind: "ranking_preference",
        scope: "track",
        hardness: "soft",
        axis: "influence",
        operator: "prefer",
        values: ["documented historical influence"],
        source: { provenance: "prompt", text: "Infuential" },
      },
    ],
    trackPredicate: {
      op: "clause",
      clauseId: "membership:irish-origin",
    },
  });
  const capabilitySnapshotHash = canonicalExecutorCapabilityForSchemaV1({
    queryPlanSchemaVersion: 6,
  }).hash;
  const semanticConfigurationHash =
    semanticExecutionConfigurationHash(process.env);
  const checkpoint = guidanceCheckpointV5({
    prompt: base.rawPrompt,
    baseContract: base,
    preservedTrackPredicate: base.trackPredicate,
    ambiguousScopeClauseIds: [],
    criticalAmbiguities: [],
    requestShape: "curated",
    capabilitySnapshotHash,
    semanticConfigurationHash,
    expectedRolloutGroup: "editorial_influence",
  });
  const question = publicGuidanceQuestionV5(checkpoint.decisions[0]!);
  expect(question.axis).toBe("influence_scope");
  const answer: PlaylistGuidanceAnswer = {
    questionId: question.id,
    optionId,
  };
  const patch = compileGuidanceRoundPatchV3({
    base,
    questionSetHash: checkpoint.checkpointHash,
    questions: [question],
    answers: [answer],
  });
  const successor = patch
    ? applyPlaylistContractPatchV1(base, patch)
    : base;
  const preGuidanceProjection = projectPlaylistContractExecutionV1({
    contract: base,
    basePlan: {
      requestedTrackCount: base.requestedTrackCount,
      minimumQualifiedTrackCount: base.requestedTrackCount,
      storefront: base.storefront,
    },
  });
  const projection = projectPlaylistContractExecutionV1({
    contract: successor,
    basePlan: {
      requestedTrackCount: successor.requestedTrackCount,
      minimumQualifiedTrackCount: successor.requestedTrackCount,
      storefront: successor.storefront,
    },
  });
  const queryPlan = createQueryPlanV3(
    projection.selectionPlanV3,
    GRAPH_SNAPSHOT_ID,
    {
      schemaVersion: 6,
      briefContractVersion: 3,
      playlistContractRevisionId: successor.revisionId,
      playlistContractSemanticHash: successor.semanticHash,
      playlistContractCompilerVersion: successor.versions.compiler,
      guidancePolicyVersion: "adaptive_guidance_v5",
    },
  );
  return {
    base,
    successor,
    questionSetHash: checkpoint.checkpointHash,
    question,
    answer,
    queryPlan,
    rehydratedPlan: selectionPlanFromQueryPlanV3(queryPlan, {}),
    preGuidanceProjection,
    successorProjection: projection,
  };
}

describe("Guidance V5 worker consumption", () => {
  test("keeps the deterministic receipt checkpoint within schema-20 phase storage", () => {
    const key = guidanceWorkerConsumptionCheckpointKeyV5("a".repeat(64));

    expect(key).toHaveLength(80);
    expect(key).toBe(
      `v3:guidance:v5:worker-consumption:${"a".repeat(46)}`,
    );
  });

  test.each([
    "within_scope_cultural_impact",
    "global_influence",
    "balanced_influence",
  ])("keeps the editorial-influence route stable through %s projection", (
    optionId,
  ) => {
    const preliminaryPlan = resolveRunSpecV3(createRunSpecV3({
      prompt: "Infuential irish music",
      requestedTrackCount: 25,
      storefront: "us",
    }), []);
    const value = fixture(optionId);
    const groups = [
      pipelineV3RolloutGroup(preliminaryPlan),
      pipelineV3RolloutGroup(
        value.preGuidanceProjection.selectionPlanV3,
      ),
      pipelineV3RolloutGroup(
        value.successorProjection.selectionPlanV3,
      ),
      value.question.rolloutGroup,
      pipelineV3RolloutGroup(value.rehydratedPlan),
    ];

    expect(groups).toEqual(Array(5).fill("editorial_influence"));
    const checkpoint = guidanceCheckpointV5({
      prompt: value.base.rawPrompt,
      baseContract: value.base,
      preservedTrackPredicate: value.base.trackPredicate,
      ambiguousScopeClauseIds: [],
      criticalAmbiguities: [],
      requestShape: "curated",
      capabilitySnapshotHash: canonicalExecutorCapabilityForSchemaV1({
        queryPlanSchemaVersion: 6,
      }).hash,
      semanticConfigurationHash:
        semanticExecutionConfigurationHash(process.env),
      expectedRolloutGroup: "editorial_influence",
    });
    expect(checkpoint.decisions[0]).toMatchObject({
      rolloutGroup: "editorial_influence",
      simulations: expect.arrayContaining([
        expect.objectContaining({
          optionId,
          baseRolloutGroup: "editorial_influence",
          successorRolloutGroup: "editorial_influence",
        }),
      ]),
    });
    expect(value.preGuidanceProjection.plan.intents).toContain("editorial_ranking");
    expect(value.successorProjection.plan.intents).toContain("editorial_ranking");
    expect(value.successorProjection.selectionPlanV3.intents).toContain(
      "editorial_ranking",
    );
    const authority = createGuidanceWorkerExecutionAuthorityV5({
      ...value,
      baseContract: value.base,
      successorContract: value.successor,
      queryPlanRevisionId: QUERY_PLAN_REVISION_ID,
    });
    expect(authority.beforeQueryPlanHash).not.toBe(
      authority.afterQueryPlanHash,
    );
    expect(authority.beforeConsumerResultHash).not.toBe(
      authority.afterConsumerResultHash,
    );
    expect(authority.resultEffectHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("rejects certification when an axis has zero terminal-consumer effect", () => {
    const value = fixture();
    expect(() => assertGuidanceRuntimeConsumerEffectV5({
      beforePlan: value.preGuidanceProjection.selectionPlanV3,
      afterPlan: value.preGuidanceProjection.selectionPlanV3,
      axis: "influence_scope",
      field: "rankingObjectives",
    })).toThrow("guidance_v5_runtime_consumer_zero_effect");
  });

  test("rejects a persisted assignment group that differs from the canonical base", () => {
    const value = fixture();
    expect(() => guidanceCheckpointV5({
      prompt: value.base.rawPrompt,
      baseContract: value.base,
      preservedTrackPredicate: value.base.trackPredicate,
      ambiguousScopeClauseIds: [],
      criticalAmbiguities: [],
      requestShape: "curated",
      capabilitySnapshotHash: canonicalExecutorCapabilityForSchemaV1({
        queryPlanSchemaVersion: 6,
      }).hash,
      semanticConfigurationHash:
        semanticExecutionConfigurationHash(process.env),
      expectedRolloutGroup: "genre_scene",
    })).toThrow("guidance_v5_assignment_rollout_group_mismatch");
  });

  test("persists a deterministic receipt only after the declared ranking effect reaches the worker plan", () => {
    const value = fixture();
    const authority = createGuidanceWorkerExecutionAuthorityV5({
      ...value,
      baseContract: value.base,
      successorContract: value.successor,
      queryPlanRevisionId: QUERY_PLAN_REVISION_ID,
    });
    const first = verifyGuidanceWorkerConsumptionV5({
      authority,
      activeContract: value.successor,
      queryPlan: value.queryPlan,
      queryPlanRevisionId: QUERY_PLAN_REVISION_ID,
      rehydratedPlan: value.rehydratedPlan,
      runtimeCapabilitySnapshotHash:
        value.queryPlan.executorCapabilityHash!,
      runtimeSemanticConfigurationHash:
        value.queryPlan.executionCoverageReport!.configurationHash,
      jobId: "33333333-3333-4333-8333-333333333333",
      workerId: "worker-guidance-v5-a",
      leaseEpoch: 7,
      consumedAt: "2026-08-01T12:00:00.000Z",
    });
    const replay = verifyGuidanceWorkerConsumptionV5({
      authority,
      activeContract: value.successor,
      queryPlan: value.queryPlan,
      queryPlanRevisionId: QUERY_PLAN_REVISION_ID,
      rehydratedPlan: value.rehydratedPlan,
      runtimeCapabilitySnapshotHash:
        value.queryPlan.executorCapabilityHash!,
      runtimeSemanticConfigurationHash:
        value.queryPlan.executionCoverageReport!.configurationHash,
      jobId: "44444444-4444-4444-8444-444444444444",
      workerId: "worker-guidance-v5-b",
      leaseEpoch: 8,
      consumedAt: "2026-08-01T12:01:00.000Z",
    });

    expect(authority).toMatchObject({
      explicitNoop: false,
      axis: "influence_scope",
      executionEffect: {
        field: "rankingObjectives",
        consumerId:
          "pipeline_v3_live_adapters:hostedDiscoveryRankingObjectivesV5",
      },
    });
    expect(first).toMatchObject({
      status: "consumed",
      executionField: "rankingObjectives",
      effectHash: authority.executionEffect!.effectHash,
      beforeQueryPlanHash: authority.beforeQueryPlanHash,
      afterQueryPlanHash: authority.afterQueryPlanHash,
      resultEffectHash: authority.resultEffectHash,
    });
    expect(replay.receiptHash).toBe(first.receiptHash);
    expect(replay.workerId).not.toBe(first.workerId);
    expect(() => assertGuidanceWorkerConsumptionReceiptV5(first))
      .not.toThrow();
  });

  test("reuses the source guidance receipt for an exact bounded continuation and rejects semantic drift", () => {
    const value = fixture();
    const authority = createGuidanceWorkerExecutionAuthorityV5({
      ...value,
      baseContract: value.base,
      successorContract: value.successor,
      queryPlanRevisionId: QUERY_PLAN_REVISION_ID,
    });
    const continuationPlan: QueryPlanV3 = {
      ...value.queryPlan,
      continuation: {
        sourceQueryPlanRevisionId: QUERY_PLAN_REVISION_ID,
        sourceQueryPlanHash: authority.queryPlanHash,
        sourceStageKey:
          `v3-retrieval:active:${authority.queryPlanHash.slice(0, 48)}`,
        sourceOutcomeHash: "a".repeat(64),
        sourceOutcomeVersion: 1,
        strategyIds: ["editorial_influence:historical_sources"],
      },
    };
    const target = guidanceWorkerConsumptionTargetV5({
      authority,
      queryPlan: continuationPlan,
      queryPlanRevisionId: "33333333-3333-4333-8333-333333333333",
    });

    expect(target).toMatchObject({
      queryPlanRevisionId: QUERY_PLAN_REVISION_ID,
      checkpointQueryPlanHash: authority.queryPlanHash,
      requiresExistingReceipt: true,
    });
    expect(queryPlanV3Hash(target.queryPlan)).toBe(authority.queryPlanHash);

    const driftedPlan: QueryPlanV3 = {
      ...continuationPlan,
      rankingObjectives: [
        ...continuationPlan.rankingObjectives,
        {
          id: "tampered-continuation-ranking",
          kind: "relevance",
          description: "Unauthorized semantic drift",
          weight: 1,
          values: ["unauthorized semantic drift"],
        },
      ],
    };
    expect(() => guidanceWorkerConsumptionTargetV5({
      authority,
      queryPlan: driftedPlan,
      queryPlanRevisionId: "33333333-3333-4333-8333-333333333333",
    })).toThrow("guidance_v5_worker_continuation_authority_mismatch");
  });

  test("fails closed when the rehydrated worker field omits the declared option effect", () => {
    const value = fixture();
    const authority = createGuidanceWorkerExecutionAuthorityV5({
      ...value,
      baseContract: value.base,
      successorContract: value.successor,
      queryPlanRevisionId: QUERY_PLAN_REVISION_ID,
    });
    const tamperedPlan: SelectionPlanV3 = {
      ...value.rehydratedPlan,
      rankingObjectives: value.rehydratedPlan.rankingObjectives.filter(
        ({ id }) => !id.startsWith("guidance:v5:influence-scope:"),
      ),
    };

    expect(() => verifyGuidanceWorkerConsumptionV5({
      authority,
      activeContract: value.successor,
      queryPlan: value.queryPlan,
      queryPlanRevisionId: QUERY_PLAN_REVISION_ID,
      rehydratedPlan: tamperedPlan,
      runtimeCapabilitySnapshotHash:
        value.queryPlan.executorCapabilityHash!,
      runtimeSemanticConfigurationHash:
        value.queryPlan.executionCoverageReport!.configurationHash,
      jobId: "33333333-3333-4333-8333-333333333333",
      workerId: "worker-guidance-v5",
      leaseEpoch: 7,
    })).toThrow("guidance_v5_worker_effect_not_consumed");
  });

  test("records an explicit noop without inventing an execution effect", () => {
    const value = fixture("keep_current_interpretation");
    const authority = createGuidanceWorkerExecutionAuthorityV5({
      ...value,
      baseContract: value.base,
      successorContract: value.successor,
      queryPlanRevisionId: QUERY_PLAN_REVISION_ID,
    });
    const receipt = verifyGuidanceWorkerConsumptionV5({
      authority,
      activeContract: value.successor,
      queryPlan: value.queryPlan,
      queryPlanRevisionId: QUERY_PLAN_REVISION_ID,
      rehydratedPlan: value.rehydratedPlan,
      runtimeCapabilitySnapshotHash:
        value.queryPlan.executorCapabilityHash!,
      runtimeSemanticConfigurationHash:
        value.queryPlan.executionCoverageReport!.configurationHash,
      jobId: "33333333-3333-4333-8333-333333333333",
      workerId: "worker-guidance-v5",
      leaseEpoch: 7,
    });

    expect(authority).toMatchObject({
      explicitNoop: true,
      executionEffect: null,
      consumerReceipt: null,
    });
    expect(receipt).toMatchObject({
      status: "explicit_noop",
      executionField: null,
      effectHash: null,
      consumerId: null,
    });
  });
});
