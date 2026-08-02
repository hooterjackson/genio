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
import {
  canonicalExecutorCapabilityForSchemaV1,
} from "../server/playlist-contract-backend-capability-v1.ts";
import {
  semanticExecutionConfigurationHash,
} from "../server/runtime-release.ts";
import {
  assertGuidanceV5V2WorkerConsumptionReceipt,
  createGuidanceV5V2ExecutionAuthority,
  projectGuidanceV5SuccessorToSelectionPlanV2,
  verifyGuidanceV5V2WorkerConsumption,
} from "../server/guidance-v5-v2-execution.ts";
import type {
  PlaylistGuidanceAnswer,
} from "../shared/types.ts";

function fixture(optionId = "balanced_influence") {
  const base = compilePlaylistContractRevisionV1({
    contractId: "brief:v2-guidance-v5",
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
  const checkpoint = guidanceCheckpointV5({
    prompt: base.rawPrompt,
    baseContract: base,
    preservedTrackPredicate: base.trackPredicate,
    ambiguousScopeClauseIds: [],
    criticalAmbiguities: [],
    requestShape: "curated",
    capabilitySnapshotHash: canonicalExecutorCapabilityForSchemaV1({
      queryPlanSchemaVersion: 6,
    }).hash,
    semanticConfigurationHash:
      semanticExecutionConfigurationHash(process.env),
  });
  const question = publicGuidanceQuestionV5(checkpoint.decisions[0]!);
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
  const selectionPlan = projectGuidanceV5SuccessorToSelectionPlanV2({
    successorContract: successor,
    basePlan: {
      requestedTrackCount: successor.requestedTrackCount,
      minimumQualifiedTrackCount: successor.requestedTrackCount,
      storefront: successor.storefront,
    },
  });
  return {
    base,
    successor,
    selectionPlan,
    questionSetHash: checkpoint.checkpointHash,
    question,
    answer,
  };
}

describe("Guidance V5.1 Contract-2 execution", () => {
  test("projects the Irish influence answer into the V2 worker plan", () => {
    const value = fixture();
    const authority = createGuidanceV5V2ExecutionAuthority({
      ...value,
      baseContract: value.base,
      successorContract: value.successor,
    });
    const receipt = verifyGuidanceV5V2WorkerConsumption({
      authority,
      selectionPlan: value.selectionPlan,
      jobId: "11111111-1111-4111-8111-111111111111",
      workerId: "worker-v2-guidance-a",
      leaseEpoch: 3,
      consumedAt: "2026-08-01T12:00:00.000Z",
    });

    expect(value.selectionPlan.pipelineVersion).toBe("catalog_first_v2");
    expect(value.selectionPlan.intents).toContain("editorial_ranking");
    expect(value.selectionPlan.constraints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "guidance:v5:influence-scope:balanced_influence",
        kind: "soft",
        operator: "prefer",
      }),
    ]));
    expect(authority).toMatchObject({
      route: "catalog_first_v2",
      axis: "influence_scope",
      executionField: "rankingObjectives",
      v2ConsumerId:
        "catalog_first_v2:selectionPlanResearchContext.softGoals",
    });
    expect(authority.beforeSelectionPlanHash).not.toBe(
      authority.afterSelectionPlanHash,
    );
    expect(authority.beforeWorkerProjectionHash).not.toBe(
      authority.afterWorkerProjectionHash,
    );
    expect(authority.resultEffectHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt).toMatchObject({
      status: "consumed",
      selectionPlanHash: authority.selectionPlanHash,
    });
    expect(() => assertGuidanceV5V2WorkerConsumptionReceipt(receipt))
      .not.toThrow();
  });

  test("rejects a worker plan that dropped the selected answer", () => {
    const value = fixture();
    const authority = createGuidanceV5V2ExecutionAuthority({
      ...value,
      baseContract: value.base,
      successorContract: value.successor,
    });
    const stalePlan = projectGuidanceV5SuccessorToSelectionPlanV2({
      successorContract: value.base,
      basePlan: value.selectionPlan,
    });

    expect(() => verifyGuidanceV5V2WorkerConsumption({
      authority,
      selectionPlan: stalePlan,
      jobId: "22222222-2222-4222-8222-222222222222",
      workerId: "worker-v2-guidance-b",
      leaseEpoch: 1,
    })).toThrow("guidance_v5_v2_worker_claim_identity_mismatch");
  });

  test("keeps an explicit no-op answer fenced without fabricating semantics", () => {
    const value = fixture("keep_current_interpretation");
    const authority = createGuidanceV5V2ExecutionAuthority({
      ...value,
      baseContract: value.base,
      successorContract: value.successor,
    });
    const receipt = verifyGuidanceV5V2WorkerConsumption({
      authority,
      selectionPlan: value.selectionPlan,
      jobId: "33333333-3333-4333-8333-333333333333",
      workerId: "worker-v2-guidance-c",
      leaseEpoch: 2,
    });

    expect(value.successor.semanticHash).toBe(value.base.semanticHash);
    expect(authority.executionField).toBeNull();
    expect(receipt.status).toBe("explicit_noop");
  });
});
