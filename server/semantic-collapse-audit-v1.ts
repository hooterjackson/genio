import type { QueryPlanV3 } from "../shared/types.ts";
import type { RetrievalResultV3 } from "./pipeline-v3-retrieval.ts";
import { sha256Hex, stableStringify } from "./security.ts";
import {
  verificationLeavesV1,
} from "./verification-expression-v1.ts";

export const SEMANTIC_COLLAPSE_AUDIT_VERSION =
  "semantic_collapse_audit_v1" as const;

export type SemanticCollapseDispositionV1 =
  | "none"
  | "technical_quarantine"
  | "dependency_blocker"
  | "needs_input"
  | "deficit_research"
  | "scarcity_decision";

export interface SemanticCollapseAuditV1 {
  version: typeof SEMANTIC_COLLAPSE_AUDIT_VERSION;
  triggered: boolean;
  disposition: SemanticCollapseDispositionV1;
  signalCodes: string[];
  limitingObligationIds: string[];
  independentDependencyRootIds: string[];
  dominantRejectionRatio: number;
  qualificationCount: number;
  canonicalUnknownCandidateCount: number;
  dominantCanonicalUnknownRatio: number;
  unknownCandidateCountsByObligationId: Record<string, number>;
  auditHash: string;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort();
}

export interface SemanticCollapseObservationV1 {
  qualificationCount: number;
  canonicalUnknownCandidateCount: number;
  dominantCanonicalUnknownRatio: number;
  unknownCandidateCountsByObligationId: Record<string, number>;
}

function nonNegativeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function canonicalUnknownCandidateCount(
  result: RetrievalResultV3,
): number {
  return Math.max(
    nonNegativeCount(
      result.deficit?.discardedByReason?.canonical_contract_unknown,
    ),
    (result.candidateLeads ?? []).filter(
      ({ rejectionCode }) => rejectionCode === "canonical_contract_unknown",
    ).length,
  );
}

function isEvidenceVerificationAxis(axis: string): boolean {
  const normalized = axis.trim().toLowerCase();
  return normalized === "evidence"
    || normalized === "evidence_policy"
    || normalized === "factual_relationship"
    || normalized === "track_factual_relationship";
}

/**
 * The retrieval boundary deliberately does not retain raw provider prose, but
 * it does retain the aggregate canonical-unknown ledger. Convert that ledger
 * into a conservative per-obligation observation only where the remaining
 * typed counters identify the obligation unambiguously:
 *
 * - a query with one non-allowing unknown leaf has only one possible
 *   obligation;
 * - an evidence-axis leaf is limiting when canonical qualification ran,
 *   nothing passed the evidence gate, and the semantic-contract verifier
 *   reported canonical unknowns.
 *
 * This is diagnostic evidence about our verifier, not proof of musical
 * scarcity.
 */
export function deriveSemanticCollapseObservationV1(input: {
  queryPlan: QueryPlanV3;
  result: RetrievalResultV3;
}): SemanticCollapseObservationV1 {
  const leaves = input.queryPlan.verificationExpression
    ? verificationLeavesV1(input.queryPlan.verificationExpression)
    : [];
  const qualificationCount = Math.max(
    0,
    nonNegativeCount(
      input.result.predicateDiagnostics?.qualificationsObserved
        ?? input.result.stages.validCandidates,
    ),
  );
  const unknownCount = Math.min(
    qualificationCount,
    canonicalUnknownCandidateCount(input.result),
  );
  const unknownCandidateCountsByObligationId: Record<string, number> = {};
  if (qualificationCount > 0 && unknownCount > 0) {
    const blockingUnknownLeaves = leaves.filter(
      ({ unknownPolicy }) => unknownPolicy !== "allow",
    );
    const exactClauseCounts =
      input.result.predicateDiagnostics?.canonicalClauseDispositionCounts
      ?? {};
    for (const leaf of blockingUnknownLeaves) {
      const exactUnknown = nonNegativeCount(
        exactClauseCounts[leaf.clauseId]?.unknown,
      );
      if (exactUnknown > 0) {
        unknownCandidateCountsByObligationId[leaf.obligationId] = Math.min(
          qualificationCount,
          exactUnknown,
        );
      }
    }
    if (Object.keys(unknownCandidateCountsByObligationId).length > 0) {
      // Exact per-clause tri-state observations are authoritative. Do not add
      // conservative inferred obligations beside them.
    } else if (blockingUnknownLeaves.length === 1) {
      unknownCandidateCountsByObligationId[
        blockingUnknownLeaves[0]!.obligationId
      ] = unknownCount;
    } else if (
      input.result.predicateDiagnostics?.rootCause === "semantic_contract"
      && input.result.stages.evidenceEligible === 0
    ) {
      for (const leaf of blockingUnknownLeaves) {
        if (isEvidenceVerificationAxis(leaf.axis)) {
          unknownCandidateCountsByObligationId[leaf.obligationId] =
            unknownCount;
        }
      }
    }
  }
  return {
    qualificationCount,
    canonicalUnknownCandidateCount: unknownCount,
    dominantCanonicalUnknownRatio: qualificationCount > 0
      ? unknownCount / qualificationCount
      : 0,
    unknownCandidateCountsByObligationId,
  };
}

/**
 * Collapse signals diagnose the execution system; they do not prove that
 * music is scarce. Only a capability-complete, independently exhausted
 * frontier may resolve to a scarcity decision.
 */
export function auditSemanticCollapseV1(input: {
  queryPlan: QueryPlanV3;
  result: RetrievalResultV3;
  unresolvedUserSemanticClauseIds?: readonly string[];
  unknownCandidateCountsByObligationId?: Readonly<Record<string, number>>;
  canonicalUnknownCandidateCount?: number;
}): SemanticCollapseAuditV1 {
  const expression = input.queryPlan.verificationExpression;
  const coverage = input.queryPlan.executionCoverageReport;
  const leaves = expression ? verificationLeavesV1(expression) : [];
  const derivedObservation = deriveSemanticCollapseObservationV1({
    queryPlan: input.queryPlan,
    result: input.result,
  });
  const mergedUnknownCandidateCounts = {
    ...derivedObservation.unknownCandidateCountsByObligationId,
    ...(input.unknownCandidateCountsByObligationId ?? {}),
  };
  const unknownCandidateCountsByObligationId: Record<string, number> = {};
  for (const obligationId of Object.keys(mergedUnknownCandidateCounts).sort()) {
    const count = Math.min(
      derivedObservation.qualificationCount,
      nonNegativeCount(mergedUnknownCandidateCounts[obligationId]),
    );
    if (count > 0) {
      unknownCandidateCountsByObligationId[obligationId] = count;
    }
  }
  const failureCounts =
    input.result.predicateDiagnostics?.failedMembershipPredicateIds ?? {};
  const qualificationCount = derivedObservation.qualificationCount;
  const canonicalUnknownCount = Math.min(
    qualificationCount,
    Math.max(
      derivedObservation.canonicalUnknownCandidateCount,
      nonNegativeCount(input.canonicalUnknownCandidateCount),
      ...Object.values(unknownCandidateCountsByObligationId),
    ),
  );
  const dominantCanonicalUnknownRatio = qualificationCount > 0
    ? canonicalUnknownCount / qualificationCount
    : 0;
  const attemptedClauseIds = new Set([
    ...(input.result.predicateDiagnostics?.attemptedCanonicalClauseIds ?? []),
    ...Object.keys(failureCounts),
    ...(input.result.candidateLeads ?? [])
      .flatMap(({ predicateCoverage }) => predicateCoverage),
  ]);
  const unattempted = leaves
    .filter(({ clauseId }) => qualificationCount > 0
      && !attemptedClauseIds.has(clauseId))
    .map(({ obligationId }) => obligationId)
    .sort();
  const uncovered = unique(coverage?.uncoveredObligationIds ?? []);
  const unknownEverywhere = leaves.flatMap(({ obligationId }) => (
    qualificationCount > 0
      && Number(
        unknownCandidateCountsByObligationId[obligationId] ?? 0,
      ) >= qualificationCount
      ? [obligationId]
      : []
  ));
  const dependencyRoots = unique(input.result.strategies.flatMap(
    (strategy) => [
      ...strategy.discoveryDependencyIds,
      ...strategy.qualificationDependencyIds,
    ],
  ));
  const exhausted = input.result.strategies.length > 0
    && input.result.strategies.every(({ status }) => (
      status !== "available"
      && status !== "running"
    ));
  const activeDependencyOutage = (input.result.dependencyOutages ?? [])
    .some(({ active }) => active);
  const totalRejections = Object.values(failureCounts)
    .reduce((total, count) => total + Math.max(0, count), 0);
  const dominantRejections = Math.max(0, ...Object.values(failureCounts));
  const dominantRejectionRatio = totalRejections > 0
    ? dominantRejections / totalRejections
    : 0;
  const zeroQualified =
    input.result.outcome.qualifiedTrackCount === 0;
  const target = Math.max(1, input.result.outcome.requestedTrackCount);
  const signalCodes: string[] = [];
  if (uncovered.length > 0) signalCodes.push("hard_obligation_has_no_certified_producer");
  if (unattempted.length > 0) signalCodes.push("required_evidence_axis_has_no_acquisition_attempt");
  if (input.result.stages.storefrontPlayable >= target && zeroQualified) {
    signalCodes.push("catalog_safe_target_with_zero_qualification");
  }
  if (unknownEverywhere.length > 0) {
    signalCodes.push("hard_obligation_unknown_for_every_candidate");
  }
  if (qualificationCount >= 10
    && zeroQualified
    && input.result.predicateDiagnostics?.rootCause === "semantic_contract"
    && dominantCanonicalUnknownRatio >= 0.8) {
    signalCodes.push("candidate_rich_semantic_contract_collapse");
  }
  if (input.result.stages.canonicalUnique >= 10
    && dependencyRoots.length >= 2
    && zeroQualified
    && dominantRejectionRatio >= 0.8) {
    signalCodes.push("independent_frontiers_dominantly_rejected");
  }
  if (input.queryPlan.engines.includes("fixed_container")
    && exhausted
    && zeroQualified
    && dominantRejectionRatio >= 0.8) {
    signalCodes.push("closed_set_structural_mismatch");
  }
  const triggered = signalCodes.length > 0;
  const unresolved = unique(
    input.unresolvedUserSemanticClauseIds ?? [],
  );
  let disposition: SemanticCollapseDispositionV1 = "none";
  if (triggered) {
    if (activeDependencyOutage) disposition = "dependency_blocker";
    else if (uncovered.length > 0
      || unattempted.length > 0
      || input.result.predicateDiagnostics?.rootCause
        === "semantic_contract") {
      disposition = "technical_quarantine";
    } else if (unresolved.length > 0) disposition = "needs_input";
    else if (!exhausted) disposition = "deficit_research";
    else disposition = "scarcity_decision";
  }
  const limitingObligationIds = unique([
    ...uncovered,
    ...unattempted,
    ...unknownEverywhere,
    ...Object.entries(unknownCandidateCountsByObligationId)
      .filter(([, count]) => (
        qualificationCount > 0
        && count / qualificationCount >= 0.8
      ))
      .map(([obligationId]) => obligationId),
  ]);
  const body = {
    version: SEMANTIC_COLLAPSE_AUDIT_VERSION,
    triggered,
    disposition,
    signalCodes: unique(signalCodes),
    limitingObligationIds,
    independentDependencyRootIds: dependencyRoots,
    dominantRejectionRatio,
    qualificationCount,
    canonicalUnknownCandidateCount: canonicalUnknownCount,
    dominantCanonicalUnknownRatio,
    unknownCandidateCountsByObligationId,
  };
  return {
    ...body,
    auditHash: sha256Hex(stableStringify(body)),
  };
}
