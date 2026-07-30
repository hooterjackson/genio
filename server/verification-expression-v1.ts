import type {
  CanonicalPlaylistContractExecutionPolicyV1,
  CanonicalPlaylistContractPredicateV1,
  ExecutionCoverageReportV1,
  VerificationExpressionV1,
  VerificationLeafV1,
  VerificationProducerFamilyV1,
} from "../shared/types.ts";
import { sha256Hex, stableStringify } from "./security.ts";

export const VERIFICATION_EXPRESSION_VERSION = "verification_expression_v1" as const;

function producerFamilies(input: {
  kind: string;
  axis: string;
}): VerificationProducerFamilyV1[] {
  if (input.kind === "catalog_version") return ["apple_catalog", "recording_identity"];
  if (input.kind === "factual_relationship") return ["structured_music_metadata", "factual_source"];
  if (input.kind === "suitability") return ["track_editorial", "suitability_assessment"];
  if (input.kind === "exclusion" && input.axis === "content") return ["content_metadata"];
  if (input.axis === "genre" || input.axis === "scene") {
    return ["structured_music_metadata", "trusted_container", "track_editorial"];
  }
  if (input.axis === "era") return ["recording_identity", "structured_music_metadata"];
  if (input.axis === "content") return ["content_metadata"];
  return ["structured_music_metadata", "track_editorial"];
}

function negativeScope(input: {
  kind: string;
  axis: string;
  operator: string;
}): VerificationLeafV1["negativeScope"] {
  if (input.operator !== "exclude") return null;
  if (["artist_identity", "recording_identity"].includes(input.axis)) return "catalog_identity";
  if (["content", "recording_version"].includes(input.axis)
    || input.kind === "catalog_version") return "bounded_metadata";
  throw new Error(`unscoped_negative_verification:${input.axis}`);
}

function leaf(
  policy: CanonicalPlaylistContractExecutionPolicyV1,
  clauseId: string,
): VerificationLeafV1 {
  const clause = policy.clauses.find(({ id }) => id === clauseId);
  if (!clause) throw new Error(`verification_clause_missing:${clauseId}`);
  const producers = producerFamilies(clause);
  return {
    op: "leaf",
    obligationId: `verification:${clause.id}`,
    clauseId: clause.id,
    polarity: clause.operator === "exclude" ? "negative" : "positive",
    axis: clause.axis,
    verifierFamilies: producers,
    permittedEvidenceGrades: [...clause.evidence.permittedGrades],
    unknownPolicy: clause.unknownPolicy,
    storefront: policy.storefront,
    versionPolicy: policy.catalogPolicyVersion,
    evidencePolicyVersion: policy.evidencePolicyVersion,
    capableProducerFamilies: producers,
    negativeScope: negativeScope(clause),
  };
}

function expression(
  policy: CanonicalPlaylistContractExecutionPolicyV1,
  predicate: CanonicalPlaylistContractPredicateV1,
): VerificationExpressionV1 {
  if (predicate.op === "clause") return leaf(policy, predicate.clauseId);
  if (predicate.op === "not") {
    const child = expression(policy, predicate.child);
    if (child.op !== "leaf" || child.negativeScope === null) {
      throw new Error("verification_not_requires_declared_scope");
    }
    return { op: "not", scope: child.negativeScope, child };
  }
  if (predicate.op === "except") {
    const exceptions = predicate.exceptions.map((child) => expression(policy, child));
    const scoped = exceptions.map((child) => {
      if (child.op !== "leaf" || child.negativeScope === null) {
        throw new Error("verification_exception_requires_declared_scope");
      }
      return { op: "not" as const, scope: child.negativeScope, child };
    });
    return {
      op: "allOf",
      children: [expression(policy, predicate.base), ...scoped],
    };
  }
  if (predicate.op === "alternative") {
    return {
      op: "anyOf",
      children: predicate.choices
        .sort((left, right) => left.priority - right.priority)
        .map(({ predicate: child }) => expression(policy, child)),
    };
  }
  return {
    op: predicate.op === "all" ? "allOf" : "anyOf",
    children: predicate.children.map((child) => expression(policy, child)),
  };
}

export function verificationExpressionV1(
  policy: CanonicalPlaylistContractExecutionPolicyV1,
): VerificationExpressionV1 {
  const result = expression(policy, policy.trackPredicate);
  assertVerificationExpressionV1(result);
  return result;
}

export function verificationLeavesV1(
  value: VerificationExpressionV1,
): VerificationLeafV1[] {
  if (value.op === "leaf") return [value];
  if (value.op === "not") return verificationLeavesV1(value.child);
  return value.children.flatMap(verificationLeavesV1);
}

export function assertVerificationExpressionV1(value: VerificationExpressionV1): void {
  const leaves = verificationLeavesV1(value);
  if (!leaves.length) throw new Error("empty_verification_expression");
  if (new Set(leaves.map(({ obligationId }) => obligationId)).size !== leaves.length) {
    throw new Error("duplicate_verification_obligation");
  }
  for (const leaf of leaves) {
    if (!leaf.obligationId || !leaf.clauseId || !leaf.axis
      || !leaf.capableProducerFamilies.length
      || !leaf.verifierFamilies.length) {
      throw new Error("invalid_verification_leaf");
    }
    if (leaf.polarity === "negative" && leaf.negativeScope === null) {
      throw new Error("unscoped_negative_verification");
    }
  }
}

export function executionCoverageReportV1(input: {
  expression: VerificationExpressionV1;
  stage: ExecutionCoverageReportV1["stage"];
  routeId: string;
  dependencyRootIds: readonly string[];
  workerCapabilityHash: string;
  configurationHash: string;
  ontologyVersion: string;
  evidencePolicyVersion: string;
  producerFamilies: readonly VerificationProducerFamilyV1[];
}): ExecutionCoverageReportV1 {
  assertVerificationExpressionV1(input.expression);
  const producers = [...new Set(input.producerFamilies)].sort();
  const supported = new Set(producers);
  const leaves = verificationLeavesV1(input.expression);
  const covered = leaves
    .filter(({ capableProducerFamilies }) => capableProducerFamilies.some((family) => supported.has(family)))
    .map(({ obligationId }) => obligationId)
    .sort();
  const uncovered = leaves
    .filter(({ obligationId }) => !covered.includes(obligationId))
    .map(({ obligationId }) => obligationId)
    .sort();
  const body = {
    version: "execution_coverage_report_v1" as const,
    stage: input.stage,
    routeId: input.routeId,
    dependencyRootIds: [...new Set(input.dependencyRootIds)].sort(),
    workerCapabilityHash: input.workerCapabilityHash,
    configurationHash: input.configurationHash,
    ontologyVersion: input.ontologyVersion,
    evidencePolicyVersion: input.evidencePolicyVersion,
    coveredObligationIds: covered,
    uncoveredObligationIds: uncovered,
    producerFamilies: producers,
    complete: uncovered.length === 0,
  };
  return {
    ...body,
    reportHash: sha256Hex(stableStringify(body)),
  };
}

/**
 * Recompute a persisted report before trusting it, then bind the same
 * verification expression to the capability and semantic configuration that
 * are actually executing this stage. A persisted hash is evidence of neither
 * integrity nor current capability until both checks pass.
 */
export function revalidateExecutionCoverageReportV1(input: {
  expression: VerificationExpressionV1;
  persisted: ExecutionCoverageReportV1;
  stage: ExecutionCoverageReportV1["stage"];
  routeId?: string;
  dependencyRootIds?: readonly string[];
  workerCapabilityHash: string;
  configurationHash: string;
  ontologyVersion: string;
  evidencePolicyVersion: string;
  producerFamilies?: readonly VerificationProducerFamilyV1[];
}): ExecutionCoverageReportV1 {
  const persistedRecomputed = executionCoverageReportV1({
    expression: input.expression,
    stage: input.persisted.stage,
    routeId: input.persisted.routeId,
    dependencyRootIds: input.persisted.dependencyRootIds,
    workerCapabilityHash: input.persisted.workerCapabilityHash,
    configurationHash: input.persisted.configurationHash,
    ontologyVersion: input.persisted.ontologyVersion,
    evidencePolicyVersion: input.persisted.evidencePolicyVersion,
    producerFamilies: input.persisted.producerFamilies,
  });
  if (stableStringify(persistedRecomputed) !== stableStringify(input.persisted)) {
    throw new Error("execution_coverage_report_integrity_failed");
  }
  return executionCoverageReportV1({
    expression: input.expression,
    stage: input.stage,
    routeId: input.routeId ?? input.persisted.routeId,
    dependencyRootIds: input.dependencyRootIds
      ?? input.persisted.dependencyRootIds,
    workerCapabilityHash: input.workerCapabilityHash,
    configurationHash: input.configurationHash,
    ontologyVersion: input.ontologyVersion,
    evidencePolicyVersion: input.evidencePolicyVersion,
    producerFamilies: input.producerFamilies
      ?? input.persisted.producerFamilies,
  });
}
