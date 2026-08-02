import { describe, expect, test } from "vitest";
import {
  ADAPTIVE_GUIDANCE_POLICY_VERSION_V5,
  assertGuidanceDecisionV5,
  guidanceCheckpointV5,
} from "../server/adaptive-guidance-v5.ts";
import {
  compileGuidanceRoundPatchV3,
  publicGuidanceQuestionV5,
} from "../server/adaptive-guidance-contract-bridge.ts";
import {
  applyPlaylistContractPatchV1,
  compilePlaylistContractRevisionV1,
  type PlaylistContractRevisionV1,
} from "../server/playlist-contract-v1.ts";

function contract(
  softAxes: readonly string[] = [],
): PlaylistContractRevisionV1 {
  return compilePlaylistContractRevisionV1({
    contractId: "contract:guidance-v5",
    rawPrompt: "A nuanced Greek rap playlist for a late drive",
    requestedTrackCount: 25,
    locale: "en",
    storefront: "us",
    clauses: [
      {
        id: "membership:genre",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "genre",
        operator: "require",
        values: ["Greek rap"],
        source: {
          provenance: "prompt",
          text: "Greek rap",
        },
      },
      ...softAxes.map((axis) => ({
        id: `soft:${axis}`,
        kind: "ranking_preference" as const,
        scope: "track" as const,
        hardness: "soft" as const,
        axis,
        operator: "prefer" as const,
        values: [axis],
        source: {
          provenance: "prompt" as const,
          text: axis,
        },
      })),
    ],
    trackPredicate: { op: "clause", clauseId: "membership:genre" },
  });
}

function checkpoint(baseContract = contract()) {
  return guidanceCheckpointV5({
    prompt: baseContract.rawPrompt,
    baseContract,
    preservedTrackPredicate: baseContract.trackPredicate,
    ambiguousScopeClauseIds: [],
    criticalAmbiguities: [],
    requestShape: "curated",
    capabilitySnapshotHash: "a".repeat(64),
    semanticConfigurationHash: "b".repeat(64),
  });
}

describe("adaptive guidance v5", () => {
  test("never returns a questionless curated checkpoint", () => {
    const result = checkpoint();
    expect(result.policyVersion).toBe(
      ADAPTIVE_GUIDANCE_POLICY_VERSION_V5,
    );
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({
      schemaVersion: 5,
      axis: "familiarity_balance",
      mode: "nuance_optional",
      capabilitySnapshotHash: "a".repeat(64),
      semanticConfigurationHash: "b".repeat(64),
    });
    expect(result.decisions[0]!.options).toHaveLength(4);
    expect(result.decisions[0]!.options.some(
      ({ id }) => id === "keep_current_interpretation",
    )).toBe(true);
  });

  test("proves every non-noop successor and worker-consumed effect", () => {
    const base = contract();
    const decision = checkpoint(base).decisions[0]!;
    expect(() => assertGuidanceDecisionV5(decision, base)).not.toThrow();
    const nonNoop = decision.simulations.filter(
      ({ successorSemanticHash }) => successorSemanticHash !== null,
    );
    expect(nonNoop).toHaveLength(3);
    expect(new Set(nonNoop.map(
      ({ successorSemanticHash }) => successorSemanticHash,
    )).size).toBe(3);
    expect(nonNoop.every(({ executionEffect }) => (
      executionEffect?.field === "rankingObjectives"
      && executionEffect.consumerId
        === "pipeline_v3_retrieval:familiarityBoundsV3"
    ))).toBe(true);
  });

  test("round-trips the signed public question and compiles its patch", () => {
    const base = contract();
    const decision = checkpoint(base).decisions[0]!;
    const question = publicGuidanceQuestionV5(decision);
    const patch = compileGuidanceRoundPatchV3({
      base,
      questionSetHash: checkpoint(base).checkpointHash,
      questions: [question],
      answers: [{
        questionId: question.id,
        optionId: "balanced_discovery",
      }],
    });
    expect(patch).not.toBeNull();
    const successor = applyPlaylistContractPatchV1(base, patch!);
    expect(successor.requestedTrackCount).toBe(25);
    expect(successor.clauses).toContainEqual(expect.objectContaining({
      axis: "familiarity_bias",
      hardness: "soft",
    }));
  });

  test("chooses another registered axis when familiarity is explicit", () => {
    const base = contract(["familiarity_bias"]);
    const result = checkpoint(base);
    expect(result.decisions[0]?.axis).toBe("playlist_flow");
    expect(result.decisions[0]?.simulations.filter(
      ({ executionEffect }) => executionEffect !== null,
    ).every(({ executionEffect }) => (
      executionEffect?.field === "orderingPolicy"
    ))).toBe(true);
  });
});
