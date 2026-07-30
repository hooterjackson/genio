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
  auditHash: string;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort();
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
}): SemanticCollapseAuditV1 {
  const expression = input.queryPlan.verificationExpression;
  const coverage = input.queryPlan.executionCoverageReport;
  const leaves = expression ? verificationLeavesV1(expression) : [];
  const failureCounts =
    input.result.predicateDiagnostics?.failedMembershipPredicateIds ?? {};
  const qualificationCount = Math.max(
    0,
    input.result.predicateDiagnostics?.qualificationsObserved
      ?? input.result.stages.validCandidates,
  );
  const attemptedClauseIds = new Set([
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
        input.unknownCandidateCountsByObligationId?.[obligationId] ?? 0,
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
  ]);
  const body = {
    version: SEMANTIC_COLLAPSE_AUDIT_VERSION,
    triggered,
    disposition,
    signalCodes: unique(signalCodes),
    limitingObligationIds,
    independentDependencyRootIds: dependencyRoots,
    dominantRejectionRatio,
  };
  return {
    ...body,
    auditHash: sha256Hex(stableStringify(body)),
  };
}
