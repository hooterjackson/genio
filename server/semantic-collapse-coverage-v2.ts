import type {
  QueryPlanV3,
  VerificationLeafV1,
  VerificationProducerFamilyV1,
} from "../shared/types.ts";
import type {
  EvidenceAcquisitionAttemptV3,
  RetrievalResultV3,
  RetrievalUpstreamDependencyIdV3,
} from "./pipeline-v3-retrieval.ts";
import { sha256Hex, stableStringify } from "./security.ts";
import type {
  EvidenceProducerHealthV2,
  SemanticCollapseAuditInputV2,
  SemanticCollapseObligationObservationV2,
  SemanticCollapseProducerObservationV2,
} from "./semantic-collapse-audit-v2.ts";
import {
  centralQualityVerificationLeavesV1,
  verificationLeavesV1,
} from "./verification-expression-v1.ts";

export const SEMANTIC_COLLAPSE_COVERAGE_VERSION_V2 =
  "semantic_collapse_coverage_v2" as const;
export const SEMANTIC_COLLAPSE_DATABASE_FACTS_VERSION_V2 =
  "semantic_collapse_database_facts_v2" as const;

export interface SemanticCollapseDatabaseFactsV2 {
  readonly version: typeof SEMANTIC_COLLAPSE_DATABASE_FACTS_VERSION_V2;
  readonly queryPlanHash: string;
  readonly contractRevisionId: string;
  /** Persisted discovery observations, including repeated provider leads. */
  readonly observationCount: number;
  /** Distinct persisted lead identities; never inferred from observation count. */
  readonly uniqueLeadCount: number;
  readonly materializedCandidateCount: number;
  /** Distinct non-null recording-family identities in the candidate table. */
  readonly uniqueRecordingFamilyCount: number;
  readonly storefrontPlayableCount: number;
  readonly evidenceQualifiedCount: number;
  readonly nullCandidateQualificationCount: number;
  /**
   * Durable receipts for deficit-specific evidence calls. Generic discovery
   * and ordinary catalog matching never appear in this ledger.
   */
  readonly evidenceAcquisitionAttempts:
    readonly EvidenceAcquisitionAttemptV3[];
  readonly canonicalClauseDispositionCounts: Readonly<Record<
    string,
    Readonly<{ pass: number; fail: number; unknown: number }>
  >>;
  readonly capturedAt: string;
  readonly factsHash: string;
}

export interface PersistedSemanticCollapseCoverageV2
  extends SemanticCollapseAuditInputV2 {
  readonly version: typeof SEMANTIC_COLLAPSE_COVERAGE_VERSION_V2;
  readonly queryPlanHash: string;
  readonly observationCount: number;
  readonly nullCandidateQualificationCount: number;
  readonly databaseFactsHash: string;
  readonly telemetryDivergenceCodes:
    readonly SemanticCollapseTelemetryDivergenceCodeV2[];
  readonly capturedAt: string;
  readonly coverageHash: string;
}

export type SemanticCollapseTelemetryDivergenceCodeV2 =
  | "observation_count_mismatch"
  | "unique_lead_count_mismatch"
  | "materialized_candidate_count_mismatch"
  /** Legacy checkpoint value; V2 no longer compares unlike family counters. */
  | "recording_family_count_mismatch"
  | "storefront_playable_count_mismatch"
  | "evidence_qualified_count_mismatch"
  | "clause_disposition_mismatch"
  | "database_clause_assessments_missing";

const PRODUCER_ROOTS: Readonly<Record<
  VerificationProducerFamilyV1,
  readonly RetrievalUpstreamDependencyIdV3[]
>> = {
  apple_catalog: ["apple_catalog"],
  recording_identity: ["apple_catalog"],
  content_metadata: ["apple_catalog"],
  structured_music_metadata: [
    "governed_evidence_graph",
    "hosted_web",
  ],
  trusted_container: ["governed_evidence_graph", "hosted_web"],
  track_editorial: ["governed_evidence_graph", "hosted_web"],
  factual_source: ["governed_evidence_graph", "hosted_web"],
  suitability_assessment: ["governed_evidence_graph", "hosted_web"],
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort();
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`semantic_collapse_database_${name}_invalid`);
  }
  return value;
}

export function createSemanticCollapseDatabaseFactsV2(input: Omit<
  SemanticCollapseDatabaseFactsV2,
  "version" | "factsHash" | "evidenceAcquisitionAttempts"
> & {
  readonly evidenceAcquisitionAttempts?:
    readonly EvidenceAcquisitionAttemptV3[];
}): SemanticCollapseDatabaseFactsV2 {
  if (!/^[a-f0-9]{64}$/u.test(input.queryPlanHash)
    || typeof input.contractRevisionId !== "string"
    || input.contractRevisionId.trim().length === 0
    || !Number.isFinite(Date.parse(input.capturedAt))) {
    throw new Error("semantic_collapse_database_identity_invalid");
  }
  const canonicalClauseDispositionCounts = Object.fromEntries(
    Object.entries(input.canonicalClauseDispositionCounts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([clauseId, counts]) => {
        if (!clauseId.trim()) {
          throw new Error("semantic_collapse_database_clause_id_invalid");
        }
        return [clauseId, {
          pass: nonNegativeInteger(counts.pass, "clause_pass"),
          fail: nonNegativeInteger(counts.fail, "clause_fail"),
          unknown: nonNegativeInteger(counts.unknown, "clause_unknown"),
        }];
      }),
  );
  const evidenceAcquisitionAttempts = (input.evidenceAcquisitionAttempts ?? [])
    .map((attempt) => {
      if (!attempt.obligationId.trim()
        || !attempt.producerFamily.trim()
        || !attempt.dependencyRootId.trim()
        || !["discover", "qualify"].includes(attempt.operation)
        || !Number.isFinite(Date.parse(attempt.attemptedAt))
        || ![
          "in_flight",
          "success",
          "provider_failure",
          "circuit_open",
        ].includes(attempt.outcome)
        || (
          attempt.retryAfterUntil !== undefined
          && attempt.retryAfterUntil !== null
          && !Number.isFinite(Date.parse(attempt.retryAfterUntil))
        )
        || !/^[a-f0-9]{64}$/u.test(attempt.strategyDeltaProofHash)
        || ![1, 2].includes(attempt.automaticRescueOrdinal)
        || !Number.isSafeInteger(attempt.attemptCount)
        || attempt.attemptCount < 1) {
        throw new Error(
          "semantic_collapse_database_evidence_acquisition_attempt_invalid",
        );
      }
      return {
        obligationId: attempt.obligationId,
        producerFamily: attempt.producerFamily,
        dependencyRootId: attempt.dependencyRootId,
        operation: attempt.operation,
        attemptedAt: attempt.attemptedAt,
        outcome: attempt.outcome,
        failureClass: attempt.failureClass ?? null,
        retryAfterUntil: attempt.retryAfterUntil ?? null,
        strategyDeltaProofHash: attempt.strategyDeltaProofHash,
        automaticRescueOrdinal: attempt.automaticRescueOrdinal,
        attemptCount: attempt.attemptCount,
      };
    })
    .sort((left, right) => (
      left.obligationId.localeCompare(right.obligationId)
      || left.producerFamily.localeCompare(right.producerFamily)
      || left.dependencyRootId.localeCompare(right.dependencyRootId)
      || left.operation.localeCompare(right.operation)
      || left.attemptedAt.localeCompare(right.attemptedAt)
      || left.strategyDeltaProofHash.localeCompare(
        right.strategyDeltaProofHash,
      )
      || left.automaticRescueOrdinal - right.automaticRescueOrdinal
    ));
  const body = {
    version: SEMANTIC_COLLAPSE_DATABASE_FACTS_VERSION_V2,
    queryPlanHash: input.queryPlanHash,
    contractRevisionId: input.contractRevisionId,
    observationCount: nonNegativeInteger(
      input.observationCount,
      "observation_count",
    ),
    uniqueLeadCount: nonNegativeInteger(
      input.uniqueLeadCount,
      "unique_lead_count",
    ),
    materializedCandidateCount: nonNegativeInteger(
      input.materializedCandidateCount,
      "materialized_candidate_count",
    ),
    uniqueRecordingFamilyCount: nonNegativeInteger(
      input.uniqueRecordingFamilyCount,
      "unique_recording_family_count",
    ),
    storefrontPlayableCount: nonNegativeInteger(
      input.storefrontPlayableCount,
      "storefront_playable_count",
    ),
    evidenceQualifiedCount: nonNegativeInteger(
      input.evidenceQualifiedCount,
      "evidence_qualified_count",
    ),
    nullCandidateQualificationCount: nonNegativeInteger(
      input.nullCandidateQualificationCount,
      "null_candidate_qualification_count",
    ),
    evidenceAcquisitionAttempts,
    canonicalClauseDispositionCounts,
    capturedAt: input.capturedAt,
  };
  return {
    ...body,
    factsHash: sha256Hex(stableStringify(body)),
  };
}

export function parseSemanticCollapseDatabaseFactsV2(
  value: unknown,
): SemanticCollapseDatabaseFactsV2 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const candidate = structuredClone(value) as SemanticCollapseDatabaseFactsV2;
    const { factsHash, ...body } = candidate;
    const { version, ...input } = body;
    const expected = createSemanticCollapseDatabaseFactsV2(input);
    return version === SEMANTIC_COLLAPSE_DATABASE_FACTS_VERSION_V2
      && factsHash === expected.factsHash
      ? candidate
      : null;
  } catch {
    return null;
  }
}

function normalizedClauseCounts(
  value: Readonly<Record<
    string,
    Readonly<{ pass: number; fail: number; unknown: number }>
  >>,
): Record<string, { pass: number; fail: number; unknown: number }> {
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([clauseId, counts]) => [
      clauseId,
      {
        pass: Math.max(0, Math.floor(Number(counts.pass ?? 0))),
        fail: Math.max(0, Math.floor(Number(counts.fail ?? 0))),
        unknown: Math.max(0, Math.floor(Number(counts.unknown ?? 0))),
      },
    ]));
}

/**
 * Compares the retrieval attempt's telemetry with the independently reread
 * database projection. These counters describe the same completed fenced
 * attempt, so a mismatch is an integrity defect rather than eventual
 * consistency. Provider-health telemetry is intentionally excluded because it
 * has no equivalent relational projection.
 */
export function semanticCollapseTelemetryDivergenceV2(input: {
  result: RetrievalResultV3;
  databaseFacts: SemanticCollapseDatabaseFactsV2;
  queryPlan: QueryPlanV3;
  /**
   * Set only by the worker after it has parsed and validated the proof-bound
   * rescue/provider-wait checkpoint. A result-declared scope marker is not
   * sufficient to relax cumulative telemetry comparisons.
   */
  authenticatedEvidenceRepairContinuation?: {
    readonly strategyDeltaProofHash: string;
    readonly automaticRescueOrdinal: 1 | 2;
  };
}): SemanticCollapseTelemetryDivergenceCodeV2[] {
  const codes: SemanticCollapseTelemetryDivergenceCodeV2[] = [];
  const diagnostics = input.result.predicateDiagnostics;
  const expectedRepair = input.authenticatedEvidenceRepairContinuation;
  const evidenceRepair = Boolean(
    expectedRepair
    && /^[a-f0-9]{64}$/u.test(expectedRepair.strategyDeltaProofHash)
    && (expectedRepair.automaticRescueOrdinal === 1
      || expectedRepair.automaticRescueOrdinal === 2)
    && (diagnostics?.evidenceAcquisitionAttempts ?? []).some((attempt) => (
      attempt.strategyDeltaProofHash
        === expectedRepair.strategyDeltaProofHash
      && attempt.automaticRescueOrdinal
        === expectedRepair.automaticRescueOrdinal
    )),
  );
  const authenticatedPassLocalContinuation =
    evidenceRepair
    && input.result.continuationTelemetryScope
      === "pass_local_qualification_projection";
  const uniqueResultLeads = new Set(
    (input.result.candidateLeads ?? []).map(({ candidateKey }) => candidateKey),
  ).size;
  if (input.databaseFacts.observationCount !== input.result.stages.discovered) {
    codes.push("observation_count_mismatch");
  }
  if (input.databaseFacts.uniqueLeadCount !== uniqueResultLeads) {
    codes.push("unique_lead_count_mismatch");
  }
  const reportedDistinctQualifications = Math.max(0, Math.floor(
    diagnostics?.uniqueQualificationsObserved
      ?? diagnostics?.qualificationsObserved
      ?? input.result.stages.validCandidates,
  ));
  if (!authenticatedPassLocalContinuation
    && input.databaseFacts.materializedCandidateCount
      !== reportedDistinctQualifications) {
    codes.push("materialized_candidate_count_mismatch");
  }
  // The database value counts recording families materialized before evidence
  // qualification. `canonicalUnique` counts only families that survived the
  // retrieval evidence gates. They intentionally diverge when every
  // materialized candidate remains unknown on a required evidence obligation,
  // so comparing them would quarantine the exact semantic collapse this audit
  // is meant to classify. Keep the database family count as the authoritative
  // observational fact; RetrievalResultV3 currently has no equivalent
  // pre-evidence family counter.
  if (!authenticatedPassLocalContinuation
    && input.databaseFacts.storefrontPlayableCount
      !== input.result.stages.storefrontPlayable) {
    codes.push("storefront_playable_count_mismatch");
  }
  if (!authenticatedPassLocalContinuation
    && input.databaseFacts.evidenceQualifiedCount
      !== input.result.stages.evidenceEligible) {
    codes.push("evidence_qualified_count_mismatch");
  }
  const databaseClauseCounts = normalizedClauseCounts(
    input.databaseFacts.canonicalClauseDispositionCounts,
  );
  const telemetryClauseCounts = normalizedClauseCounts(
    diagnostics?.canonicalClauseDispositionCounts ?? {},
  );
  const clauseCountsAgree = stableStringify(databaseClauseCounts)
    === stableStringify(telemetryClauseCounts);
  if ((input.databaseFacts.evidenceQualifiedCount === 0
      || diagnostics?.canonicalClauseDispositionCounts !== undefined)
    && !authenticatedPassLocalContinuation
    && !clauseCountsAgree) {
    codes.push("clause_disposition_mismatch");
  }
  const requiredClauseIds = [
    ...verificationLeavesV1(input.queryPlan.verificationExpression!),
    ...(input.queryPlan.canonicalContractPolicy
      ? centralQualityVerificationLeavesV1({
          policy: input.queryPlan.canonicalContractPolicy,
          qualityPolicy: input.queryPlan.playlistQualityPolicy,
        })
      : []),
  ].filter(({ unknownPolicy }) => unknownPolicy !== "allow")
    .map(({ clauseId }) => clauseId);
  if (input.databaseFacts.materializedCandidateCount > 0
    && input.databaseFacts.evidenceQualifiedCount === 0
    && requiredClauseIds.some((clauseId) => {
      const counts = databaseClauseCounts[clauseId];
      return !counts || counts.pass + counts.fail + counts.unknown === 0;
    })) {
    codes.push("database_clause_assessments_missing");
  }
  return unique(codes) as SemanticCollapseTelemetryDivergenceCodeV2[];
}

function producerHealth(input: {
  dependencyRootId: RetrievalUpstreamDependencyIdV3;
  result: RetrievalResultV3;
}): EvidenceProducerHealthV2 {
  const roots = new Set([input.dependencyRootId]);
  const matchingOutages = (input.result.dependencyOutages ?? []).filter(
    ({ dependencyId }) => roots.has(dependencyId),
  );
  if (matchingOutages.some(({ active }) => active)) return "unhealthy";
  const matchingStrategies = input.result.strategies.filter((strategy) => (
    [...strategy.discoveryDependencyIds, ...strategy.qualificationDependencyIds]
      .some((root) => roots.has(root))
  ));
  if (matchingStrategies.length === 0) return "unknown";
  if (matchingStrategies.every(({ status }) => (
    status === "provider_error" || status === "circuit_open"
  ))) return "unhealthy";
  if (matchingStrategies.some(({ status }) => status === "provider_error")) {
    return "degraded";
  }
  return "healthy";
}

function retryAfterAt(input: {
  dependencyRootId: RetrievalUpstreamDependencyIdV3;
  result: RetrievalResultV3;
}): string | null {
  const roots = new Set([input.dependencyRootId]);
  const retries = (input.result.dependencyOutages ?? [])
    .filter(({ active, dependencyId }) => active && roots.has(dependencyId))
    .map(({ retryAfterUntil }) => retryAfterUntil)
    .filter((value): value is string => (
      typeof value === "string" && Number.isFinite(Date.parse(value))
    ))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return retries[0] ?? null;
}

function producerDependencies(
  producer: VerificationProducerFamilyV1,
  result: RetrievalResultV3,
): RetrievalUpstreamDependencyIdV3[] {
  const roots = new Set(PRODUCER_ROOTS[producer]);
  return [...new Set(result.strategies.flatMap((strategy) => (
    [...strategy.discoveryDependencyIds, ...strategy.qualificationDependencyIds]
      .filter((root) => roots.has(root))
  )))].sort();
}

function explicitAcquisitionAttempts(
  leaf: VerificationLeafV1,
  databaseFacts: SemanticCollapseDatabaseFactsV2,
): {
  count: number;
  families: VerificationProducerFamilyV1[];
  roots: Array<{
    producerFamily: VerificationProducerFamilyV1;
    dependencyRootId: string;
  }>;
} {
  const capable = new Set(leaf.capableProducerFamilies);
  const rows = databaseFacts.evidenceAcquisitionAttempts
    .filter(({
      obligationId,
      producerFamily,
      dependencyRootId,
      attemptCount,
    }) => (
      obligationId === leaf.obligationId
      && capable.has(producerFamily as VerificationProducerFamilyV1)
      && typeof dependencyRootId === "string"
      && dependencyRootId.trim().length > 0
      && Number.isSafeInteger(attemptCount)
      && attemptCount > 0
    ));
  return {
    count: rows.reduce((sum, { attemptCount }) => sum + attemptCount, 0),
    families: unique(rows.map(({ producerFamily }) => producerFamily)) as
      VerificationProducerFamilyV1[],
    roots: [...new Map(rows.map(({ producerFamily, dependencyRootId }) => [
      `${producerFamily}\u0000${dependencyRootId}`,
      {
        producerFamily: producerFamily as VerificationProducerFamilyV1,
        dependencyRootId,
      },
    ])).values()].sort((left, right) => (
      left.producerFamily.localeCompare(right.producerFamily)
      || left.dependencyRootId.localeCompare(right.dependencyRootId)
    )),
  };
}

/**
 * Creates the typed input that must be persisted before collapse
 * classification. It uses only durable query-plan semantics and
 * provider/candidate observations returned by the fenced retrieval attempt.
 * Absence of an explicit producer attempt is retained as zero; the builder
 * never invents a successful frontier from a prompt or model claim.
 */
export function semanticCollapseCoverageV2(input: {
  queryPlan: QueryPlanV3;
  queryPlanHash: string;
  result: RetrievalResultV3;
  databaseFacts: SemanticCollapseDatabaseFactsV2;
  capturedAt: string;
  unresolvedUserSemanticClauseIds?: readonly string[];
  authenticatedEvidenceRepairContinuation?: {
    readonly strategyDeltaProofHash: string;
    readonly automaticRescueOrdinal: 1 | 2;
  };
}): PersistedSemanticCollapseCoverageV2 {
  if (!Number.isFinite(Date.parse(input.capturedAt))) {
    throw new Error("semantic_collapse_coverage_timestamp_invalid");
  }
  const leaves = input.queryPlan.verificationExpression
    ? verificationLeavesV1(input.queryPlan.verificationExpression)
    : [];
  const qualityLeaves = input.queryPlan.canonicalContractPolicy
    ? centralQualityVerificationLeavesV1({
        policy: input.queryPlan.canonicalContractPolicy,
        qualityPolicy: input.queryPlan.playlistQualityPolicy,
      })
    : [];
  const auditLeaves = [...leaves, ...qualityLeaves];
  const databaseFacts = parseSemanticCollapseDatabaseFactsV2(
    input.databaseFacts,
  );
  if (!databaseFacts
    || databaseFacts.queryPlanHash !== input.queryPlanHash
    || databaseFacts.capturedAt !== input.capturedAt) {
    throw new Error("semantic_collapse_database_facts_invalid");
  }
  const telemetryDivergenceCodes = semanticCollapseTelemetryDivergenceV2({
    result: input.result,
    databaseFacts,
    queryPlan: input.queryPlan,
    authenticatedEvidenceRepairContinuation:
      input.authenticatedEvidenceRepairContinuation,
  });
  const clauseCounts = databaseFacts.canonicalClauseDispositionCounts;
  const bindingDefectsByObligation = new Map(
    (input.result.predicateDiagnostics?.evidenceBindingDefects ?? [])
      .filter(({ obligationId }) => (
        typeof obligationId === "string" && obligationId.trim().length > 0
      ))
      .map((row) => [row.obligationId, row] as const),
  );
  const producerFamilies = unique(auditLeaves.flatMap(
    ({ capableProducerFamilies }) => capableProducerFamilies,
  )) as VerificationProducerFamilyV1[];
  const liveProducerRoots = new Map(
    producerFamilies.map((producer) => [
      producer,
      producerDependencies(producer, input.result),
    ] as const),
  );
  const obligations: SemanticCollapseObligationObservationV2[] = auditLeaves.map(
    (leaf) => {
      const dispositions = clauseCounts[leaf.clauseId];
      const attempted = explicitAcquisitionAttempts(leaf, databaseFacts);
      const defects = bindingDefectsByObligation.get(leaf.obligationId);
      const malformedEvidenceCount = Math.max(
        0,
        Math.floor(Number(defects?.malformedEvidenceCount ?? 0)),
      );
      const wrongAxisEvidenceCount = Math.max(
        0,
        Math.floor(Number(defects?.wrongAxisEvidenceCount ?? 0)),
      );
      const observedPass = Math.max(0, Number(dispositions?.pass ?? 0));
      // A structurally invalid proof cannot remain a pass in the persisted
      // semantic coverage. Preserve it as unknown while retaining the exact
      // defect counters that force technical quarantine.
      const invalidPassCount = Math.min(
        observedPass,
        malformedEvidenceCount + wrongAxisEvidenceCount,
      );
      const capableProducerFamilies = unique(
        leaf.capableProducerFamilies.filter((producer) => (
          (liveProducerRoots.get(producer)?.length ?? 0) > 0
        )),
      ) as VerificationProducerFamilyV1[];
      return {
        obligationId: leaf.obligationId,
        required: leaf.unknownPolicy !== "allow",
        pass: observedPass - invalidPassCount,
        fail: Math.max(0, Number(dispositions?.fail ?? 0)),
        unknown:
          Math.max(0, Number(dispositions?.unknown ?? 0))
          + invalidPassCount,
        acquisitionAttemptCount: attempted.count,
        capableProducerFamilies,
        attemptedProducerFamilies: attempted.families.filter((producer) => (
          capableProducerFamilies.includes(producer)
        )),
        attemptedProducerRoots: attempted.roots.filter(
          ({ producerFamily, dependencyRootId }) => (
            capableProducerFamilies.includes(producerFamily)
            && (liveProducerRoots.get(producerFamily) ?? [])
              .includes(dependencyRootId as RetrievalUpstreamDependencyIdV3)
          ),
        ),
        malformedEvidenceCount,
        wrongAxisEvidenceCount,
      };
    },
  );
  const producers: SemanticCollapseProducerObservationV2[] =
    producerFamilies.flatMap((producer) => {
      const roots = liveProducerRoots.get(producer) ?? [];
      return roots.map((dependencyRootId) => ({
        producerFamily: producer,
        dependencyRootId,
        health: producerHealth({
          dependencyRootId,
          result: input.result,
        }),
        retryAfterAt: retryAfterAt({
          dependencyRootId,
          result: input.result,
        }),
      }));
    });
  const body = {
    version: SEMANTIC_COLLAPSE_COVERAGE_VERSION_V2,
    queryPlanHash: input.queryPlanHash,
    observationCount: databaseFacts.observationCount,
    nullCandidateQualificationCount:
      databaseFacts.nullCandidateQualificationCount,
    databaseFactsHash: databaseFacts.factsHash,
    telemetryDivergenceCodes,
    requestedTrackCount: input.result.outcome.requestedTrackCount,
    uniqueLeadCount: databaseFacts.uniqueLeadCount,
    materializedCandidateCount: databaseFacts.materializedCandidateCount,
    uniqueRecordingFamilyCount: databaseFacts.uniqueRecordingFamilyCount,
    storefrontPlayableCount: databaseFacts.storefrontPlayableCount,
    evidenceQualifiedCount: databaseFacts.evidenceQualifiedCount,
    obligations,
    producers,
    unresolvedUserSemanticClauseIds: unique(
      input.unresolvedUserSemanticClauseIds ?? [],
    ),
    frontierExhausted: input.result.strategies.length > 0
      && input.result.strategies.every(({ status }) => (
        status !== "available" && status !== "running"
      )),
    localBudgetExhausted:
      input.result.outcome.stopReason === "budget_reached",
    capturedAt: input.capturedAt,
  };
  return {
    ...body,
    coverageHash: sha256Hex(stableStringify(body)),
  };
}

export function parseSemanticCollapseCoverageV2(
  value: unknown,
): PersistedSemanticCollapseCoverageV2 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = structuredClone(value) as PersistedSemanticCollapseCoverageV2;
  try {
    const { coverageHash, ...body } = candidate;
    if (
      candidate.version !== SEMANTIC_COLLAPSE_COVERAGE_VERSION_V2
      || !/^[a-f0-9]{64}$/u.test(candidate.queryPlanHash)
      || !/^[a-f0-9]{64}$/u.test(candidate.databaseFactsHash)
      || !/^[a-f0-9]{64}$/u.test(coverageHash)
      || !Number.isFinite(Date.parse(candidate.capturedAt))
      || !Number.isSafeInteger(candidate.observationCount)
      || candidate.observationCount < 0
      || !Number.isSafeInteger(candidate.nullCandidateQualificationCount)
      || candidate.nullCandidateQualificationCount < 0
      || !Array.isArray(candidate.telemetryDivergenceCodes)
      || !Array.isArray(candidate.obligations)
      || !Array.isArray(candidate.producers)
      || sha256Hex(stableStringify(body)) !== coverageHash
    ) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}
