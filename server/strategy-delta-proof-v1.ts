import { sha256Hex, stableStringify } from "./security.ts";

export const STRATEGY_DELTA_PROOF_VERSION = "strategy_delta_proof_v1" as const;

export interface StrategyDeltaProofV1 {
  version: typeof STRATEGY_DELTA_PROOF_VERSION;
  sourceStrategySemanticHash: string;
  successorStrategySemanticHash: string;
  reason:
    | "retry_after_elapsed"
    | "scheduled_circuit_ordinal"
    | "half_open_health_epoch"
    | "new_deficit_producer"
    | "new_dependency_root"
    | "user_successor_contract";
  sourceProducerFamilies: readonly string[];
  successorProducerFamilies: readonly string[];
  sourceDependencyRootIds: readonly string[];
  successorDependencyRootIds: readonly string[];
  deficitObligationIds: readonly string[];
  automaticRescueOrdinal: 0 | 1 | 2;
  providerRetryAfter?: string | null;
  circuitOrdinal?: number | null;
  healthEpoch?: string | null;
  successorContractRevisionId?: string | null;
  proofHash: string;
}

function validHash(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function newValues(source: readonly string[], successor: readonly string[]): string[] {
  const seen = new Set(source);
  return [...new Set(successor)].filter((value) => !seen.has(value));
}

export function createStrategyDeltaProofV1(
  input: Omit<StrategyDeltaProofV1, "version" | "proofHash">,
): StrategyDeltaProofV1 {
  const body = {
    version: STRATEGY_DELTA_PROOF_VERSION,
    ...input,
    sourceProducerFamilies: [...new Set(input.sourceProducerFamilies)].sort(),
    successorProducerFamilies: [...new Set(input.successorProducerFamilies)].sort(),
    sourceDependencyRootIds: [...new Set(input.sourceDependencyRootIds)].sort(),
    successorDependencyRootIds: [...new Set(input.successorDependencyRootIds)].sort(),
    deficitObligationIds: [...new Set(input.deficitObligationIds)].sort(),
  };
  const proof = {
    ...body,
    proofHash: sha256Hex(stableStringify(body)),
  };
  assertStrategyDeltaProofV1(proof);
  return proof;
}

export function assertStrategyDeltaProofV1(proof: StrategyDeltaProofV1): void {
  if (proof.version !== STRATEGY_DELTA_PROOF_VERSION
    || !validHash(proof.sourceStrategySemanticHash)
    || !validHash(proof.successorStrategySemanticHash)
    || !Number.isSafeInteger(proof.automaticRescueOrdinal)
    || proof.automaticRescueOrdinal < 0
    || proof.automaticRescueOrdinal > 2) {
    throw new Error("invalid_strategy_delta_proof");
  }
  const repeat = proof.sourceStrategySemanticHash === proof.successorStrategySemanticHash;
  const newProducers = newValues(
    proof.sourceProducerFamilies,
    proof.successorProducerFamilies,
  );
  const newRoots = newValues(
    proof.sourceDependencyRootIds,
    proof.successorDependencyRootIds,
  );
  if (proof.reason === "retry_after_elapsed") {
    if (!repeat || !proof.providerRetryAfter
      || !Number.isFinite(Date.parse(proof.providerRetryAfter))) {
      throw new Error("strategy_repeat_requires_retry_after");
    }
  } else if (proof.reason === "scheduled_circuit_ordinal") {
    if (!repeat || !Number.isSafeInteger(proof.circuitOrdinal)
      || Number(proof.circuitOrdinal) < 1
      || Number(proof.circuitOrdinal) > 5) {
      throw new Error("strategy_repeat_requires_circuit_ordinal");
    }
  } else if (proof.reason === "half_open_health_epoch") {
    if (!repeat || !proof.healthEpoch?.trim()) {
      throw new Error("strategy_repeat_requires_health_epoch");
    }
  } else if (proof.reason === "new_deficit_producer") {
    if (!proof.deficitObligationIds.length || !newProducers.length || repeat) {
      throw new Error("semantic_rescue_requires_deficit_producer");
    }
  } else if (proof.reason === "new_dependency_root") {
    if (!newRoots.length || repeat) {
      throw new Error("semantic_rescue_requires_dependency_root");
    }
  } else if (proof.reason === "user_successor_contract") {
    if (!proof.successorContractRevisionId?.startsWith("pcr1:") || repeat) {
      throw new Error("semantic_rescue_requires_successor_contract");
    }
  }
  const expected = sha256Hex(stableStringify(Object.fromEntries(
    Object.entries(proof).filter(([key]) => key !== "proofHash"),
  )));
  if (proof.proofHash !== expected) throw new Error("strategy_delta_proof_hash_mismatch");
}

export function strategyDeltaAuthorizesRetryV1(
  proof: StrategyDeltaProofV1,
  now = new Date(),
): boolean {
  assertStrategyDeltaProofV1(proof);
  if (proof.automaticRescueOrdinal > 2) return false;
  if (proof.reason === "retry_after_elapsed") {
    return Date.parse(proof.providerRetryAfter!) <= now.getTime();
  }
  return true;
}
