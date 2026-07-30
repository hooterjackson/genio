import { describe, expect, test } from "vitest";
import {
  createStrategyDeltaProofV1,
  strategyDeltaAuthorizesRetryV1,
} from "../server/strategy-delta-proof-v1.ts";

const base = {
  sourceStrategySemanticHash: "a".repeat(64),
  successorStrategySemanticHash: "b".repeat(64),
  sourceProducerFamilies: ["metadata"],
  successorProducerFamilies: ["metadata", "editorial"],
  sourceDependencyRootIds: ["provider-a"],
  successorDependencyRootIds: ["provider-a"],
  deficitObligationIds: ["verification:genre"],
  automaticRescueOrdinal: 1 as const,
  providerRetryAfter: null,
  circuitOrdinal: null,
  healthEpoch: null,
  successorContractRevisionId: null,
};

describe("StrategyDeltaProofV1", () => {
  test("authorizes a semantic rescue only when it adds a deficit-capable producer", () => {
    const proof = createStrategyDeltaProofV1({
      ...base,
      reason: "new_deficit_producer",
    });
    expect(strategyDeltaAuthorizesRetryV1(proof)).toBe(true);
  });

  test("does not treat a changed hash alone as a strategy delta", () => {
    expect(() => createStrategyDeltaProofV1({
      ...base,
      reason: "new_deficit_producer",
      successorProducerFamilies: ["metadata"],
    })).toThrow("semantic_rescue_requires_deficit_producer");
  });

  test("allows an unchanged provider strategy only after its retry-after", () => {
    const proof = createStrategyDeltaProofV1({
      ...base,
      sourceStrategySemanticHash: "a".repeat(64),
      successorStrategySemanticHash: "a".repeat(64),
      sourceProducerFamilies: ["metadata"],
      successorProducerFamilies: ["metadata"],
      reason: "retry_after_elapsed",
      providerRetryAfter: "2026-07-29T12:00:00.000Z",
    });
    expect(strategyDeltaAuthorizesRetryV1(
      proof,
      new Date("2026-07-29T11:59:59.000Z"),
    )).toBe(false);
    expect(strategyDeltaAuthorizesRetryV1(
      proof,
      new Date("2026-07-29T12:00:00.000Z"),
    )).toBe(true);
  });
});
