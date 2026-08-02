import { sha256Hex, stableStringify } from "./security.ts";

export const SEMANTIC_COLLAPSE_AUDIT_VERSION_V2 =
  "semantic_collapse_audit_v2" as const;

export type SemanticCollapseDispositionV2 =
  | "none"
  | "technical_quarantine"
  | "dependency_blocker"
  | "needs_input"
  | "deficit_research"
  | "actionable_decision"
  | "scarcity_decision";

export type EvidenceProducerHealthV2 =
  | "healthy"
  | "degraded"
  | "unhealthy"
  | "unknown";

export interface SemanticCollapseObligationObservationV2 {
  readonly obligationId: string;
  readonly required: boolean;
  readonly pass: number;
  readonly fail: number;
  readonly unknown: number;
  readonly acquisitionAttemptCount: number;
  readonly capableProducerFamilies: readonly string[];
  readonly attemptedProducerFamilies: readonly string[];
  readonly attemptedProducerRoots: readonly {
    readonly producerFamily: string;
    readonly dependencyRootId: string;
  }[];
  readonly malformedEvidenceCount: number;
  readonly wrongAxisEvidenceCount: number;
}

export interface SemanticCollapseProducerObservationV2 {
  readonly producerFamily: string;
  readonly dependencyRootId: string;
  readonly health: EvidenceProducerHealthV2;
  readonly retryAfterAt: string | null;
}

export interface SemanticCollapseAuditInputV2 {
  readonly requestedTrackCount: number;
  readonly uniqueLeadCount: number;
  readonly materializedCandidateCount: number;
  readonly uniqueRecordingFamilyCount: number;
  readonly storefrontPlayableCount: number;
  readonly evidenceQualifiedCount: number;
  readonly obligations: readonly SemanticCollapseObligationObservationV2[];
  readonly producers: readonly SemanticCollapseProducerObservationV2[];
  readonly unresolvedUserSemanticClauseIds: readonly string[];
  readonly frontierExhausted: boolean;
  readonly localBudgetExhausted: boolean;
}

export interface SemanticCollapseAuditV2 {
  readonly version: typeof SEMANTIC_COLLAPSE_AUDIT_VERSION_V2;
  readonly triggered: boolean;
  readonly disposition: SemanticCollapseDispositionV2;
  readonly reasonCode: string | null;
  readonly signalCodes: readonly string[];
  readonly limitingObligationIds: readonly string[];
  readonly independentDependencyRootIds: readonly string[];
  readonly nextRetryAt: string | null;
  readonly auditHash: string;
}

function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort();
}

function earliestRetryAt(
  producers: readonly SemanticCollapseProducerObservationV2[],
): string | null {
  const values = producers
    .map(({ retryAfterAt }) => retryAfterAt)
    .filter((value): value is string => (
      typeof value === "string" && Number.isFinite(Date.parse(value))
    ))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return values[0] ?? null;
}

/**
 * Classifies candidate-rich zero-yield states from persisted observations.
 *
 * The audit is intentionally incapable of inferring musical scarcity from
 * unknown evidence. A scarcity decision is reachable only when every
 * limiting obligation contains observed failures, every capable producer was
 * attempted while healthy, at least two independent dependency roots were
 * exhausted, and no unknown remains on a limiting obligation.
 */
export function auditSemanticCollapseV2(
  raw: SemanticCollapseAuditInputV2,
): SemanticCollapseAuditV2 {
  const input: SemanticCollapseAuditInputV2 = {
    ...raw,
    requestedTrackCount: Math.max(1, count(raw.requestedTrackCount)),
    uniqueLeadCount: count(raw.uniqueLeadCount),
    materializedCandidateCount: count(raw.materializedCandidateCount),
    uniqueRecordingFamilyCount: count(raw.uniqueRecordingFamilyCount),
    storefrontPlayableCount: count(raw.storefrontPlayableCount),
    evidenceQualifiedCount: count(raw.evidenceQualifiedCount),
  };
  const producersByFamily = new Map<
    string,
    SemanticCollapseProducerObservationV2[]
  >();
  for (const producer of input.producers) {
    producersByFamily.set(producer.producerFamily, [
      ...(producersByFamily.get(producer.producerFamily) ?? []),
      producer,
    ]);
  }
  const required = input.obligations
    .filter((obligation) => obligation.required)
    .map((obligation) => ({
      ...obligation,
      pass: count(obligation.pass),
      fail: count(obligation.fail),
      unknown: count(obligation.unknown),
      acquisitionAttemptCount: count(obligation.acquisitionAttemptCount),
      malformedEvidenceCount: count(obligation.malformedEvidenceCount),
      wrongAxisEvidenceCount: count(obligation.wrongAxisEvidenceCount),
      capableProducerFamilies: unique(obligation.capableProducerFamilies),
      attemptedProducerFamilies: unique(obligation.attemptedProducerFamilies),
      attemptedProducerRoots: obligation.attemptedProducerRoots
        .map(({ producerFamily, dependencyRootId }) => ({
          producerFamily: producerFamily.trim(),
          dependencyRootId: dependencyRootId.trim(),
        }))
        .filter(({ producerFamily, dependencyRootId }) => (
          producerFamily.length > 0 && dependencyRootId.length > 0
        ))
        .sort((left, right) => (
          left.producerFamily.localeCompare(right.producerFamily)
          || left.dependencyRootId.localeCompare(right.dependencyRootId)
        )),
    }));
  const limiting = required.filter(({ pass }) => pass === 0);
  const noCapableProducer = limiting.filter(
    ({ capableProducerFamilies }) => capableProducerFamilies.length === 0,
  );
  const structurallyDefective = limiting.filter(
    ({ malformedEvidenceCount, wrongAxisEvidenceCount }) => (
      malformedEvidenceCount > 0 || wrongAxisEvidenceCount > 0
    ),
  );
  const rootWasAttempted = (
    obligation: (typeof limiting)[number],
    producer: SemanticCollapseProducerObservationV2,
  ): boolean => obligation.attemptedProducerRoots.some((attempted) => (
    attempted.producerFamily === producer.producerFamily
    && attempted.dependencyRootId === producer.dependencyRootId
  ));
  const healthyUnattempted = limiting.filter((obligation) => (
    obligation.capableProducerFamilies.some((family) => (
      (producersByFamily.get(family) ?? []).some((producer) => (
        producer.health === "healthy"
        && !rootWasAttempted(obligation, producer)
      ))
    ))
  ));
  const unhealthyRequiredProducers = limiting.flatMap((obligation) => (
    obligation.capableProducerFamilies
      // Prefer an immediately usable, unattempted root over waiting for an
      // unhealthy sibling. Once every healthy root has already been tried,
      // however, the remaining unhealthy frontier is a dependency blocker.
      .flatMap((family) => {
        const producers = producersByFamily.get(family) ?? [];
        const healthyUnattemptedRoot = producers.some((producer) => (
          producer.health === "healthy"
          && !rootWasAttempted(obligation, producer)
        ));
        return healthyUnattemptedRoot
          ? []
          : producers.filter((producer) => (
              producer.health === "unhealthy"
              || producer.health === "degraded"
            ));
      })
  ));
  const unknownEverywhere = limiting.filter(({ unknown }) => (
    input.materializedCandidateCount > 0
    && unknown >= input.materializedCandidateCount
  ));
  const limitingHealthyAttemptedDependencyRoots = unique(
    limiting.flatMap((obligation) => (
      obligation.attemptedProducerRoots
        .filter(({ producerFamily, dependencyRootId }) => (
          obligation.capableProducerFamilies.includes(producerFamily)
          && (producersByFamily.get(producerFamily) ?? []).some((producer) => (
            producer.dependencyRootId === dependencyRootId
            && producer.health === "healthy"
          ))
        ))
        .map(({ dependencyRootId }) => dependencyRootId)
    )),
  );
  const candidateRich = input.materializedCandidateCount >= 10
    || input.uniqueRecordingFamilyCount >= 10;
  const catalogSafeTarget = input.storefrontPlayableCount
    >= input.requestedTrackCount;
  const zeroQualified = input.evidenceQualifiedCount === 0;
  const signalCodes: string[] = [];
  if (noCapableProducer.length > 0) {
    signalCodes.push("hard_obligation_has_no_certified_producer");
  }
  if (healthyUnattempted.length > 0) {
    signalCodes.push("required_evidence_axis_has_no_acquisition_attempt");
  }
  if (catalogSafeTarget && zeroQualified) {
    signalCodes.push("catalog_safe_target_with_zero_qualification");
  }
  if (unknownEverywhere.length > 0) {
    signalCodes.push("hard_obligation_unknown_for_every_candidate");
  }
  if (zeroQualified && limiting.some(({ unknown }) => unknown > 0)) {
    signalCodes.push("required_obligation_unknown_without_qualification");
  }
  if (candidateRich && zeroQualified && limiting.length > 0) {
    signalCodes.push("candidate_rich_zero_qualification");
  }
  if (structurallyDefective.length > 0) {
    signalCodes.push("evidence_binding_structural_defect");
  }
  const triggered = signalCodes.length > 0;

  let disposition: SemanticCollapseDispositionV2 = "none";
  let reasonCode: string | null = null;
  let nextRetryAt: string | null = null;
  if (triggered) {
    if (structurallyDefective.length > 0) {
      disposition = "technical_quarantine";
      reasonCode = "evidence_binding_defect";
    } else if (noCapableProducer.length > 0) {
      disposition = "technical_quarantine";
      reasonCode = "capability_gap";
    } else if (unhealthyRequiredProducers.length > 0) {
      disposition = "dependency_blocker";
      reasonCode = "evidence_dependency_unhealthy";
      nextRetryAt = earliestRetryAt(unhealthyRequiredProducers);
    } else if (healthyUnattempted.length > 0) {
      disposition = "deficit_research";
      reasonCode = "bounded_evidence_enrichment_required";
    } else if (input.unresolvedUserSemanticClauseIds.length > 0) {
      disposition = "needs_input";
      reasonCode = "unresolved_user_semantics";
    } else if (input.localBudgetExhausted) {
      disposition = "actionable_decision";
      reasonCode = "local_budget_exhausted";
    } else {
      const allLimitingObservedFail = limiting.length > 0
        && limiting.every(({ fail, unknown }) => fail > 0 && unknown === 0);
      const allCapableAttemptedHealthy = limiting.every((obligation) => (
        obligation.capableProducerFamilies.length > 0
        && obligation.capableProducerFamilies.every((family) => (
          obligation.attemptedProducerFamilies.includes(family)
          && (producersByFamily.get(family) ?? []).some((producer) => (
            producer.health === "healthy"
            && rootWasAttempted(obligation, producer)
          ))
        ))
      ));
      if (
        input.frontierExhausted
        && limitingHealthyAttemptedDependencyRoots.length >= 2
        && allLimitingObservedFail
        && allCapableAttemptedHealthy
      ) {
        disposition = "scarcity_decision";
        reasonCode = "frontier_exhausted_under_policy";
      } else {
        disposition = "deficit_research";
        reasonCode = "bounded_evidence_enrichment_required";
      }
    }
  }
  const limitingObligationIds = unique(limiting.map(
    ({ obligationId }) => obligationId,
  ));
  const body = {
    version: SEMANTIC_COLLAPSE_AUDIT_VERSION_V2,
    triggered,
    disposition,
    reasonCode,
    signalCodes: unique(signalCodes),
    limitingObligationIds,
    independentDependencyRootIds: limitingHealthyAttemptedDependencyRoots,
    nextRetryAt,
  };
  return {
    ...body,
    auditHash: sha256Hex(stableStringify(body)),
  };
}
