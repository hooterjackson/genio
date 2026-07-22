import { createHash } from "node:crypto";
import type {
  CandidateQualificationV3,
  RawTrackCandidateV3,
  RetrievalStageCountersV3,
} from "./pipeline-v3-retrieval.ts";
import type {
  MembershipPredicateV3,
  SemanticPlanClauseV32,
  SelectionPlanV3,
} from "./selection-plan-v3.ts";
import { exactMusicConceptV3 } from "./music-concepts-v3.ts";

/**
 * Semantic recovery is intentionally narrow. It may remove only redundant
 * execution projections; it may never broaden the user's actual request.
 */
export const PIPELINE_V3_SEMANTIC_RECOVERY_POLICY =
  "pipeline-v3-semantic-recovery/v1" as const;
export const PIPELINE_V3_SEMANTIC_RECOVERY_DOMINANCE = 0.8;
export const PIPELINE_V3_SEMANTIC_RECOVERY_MAX_ATTEMPTS = 1;

export type SemanticRecoveryRootCauseV3 =
  | "under_discovery"
  | "evidence_shortfall"
  | "catalog_shortfall"
  | "provider_degraded"
  | "semantic_contract";

export type SemanticRecoveryTransformationKindV3 =
  | "context_geography_projection"
  | "generated_policy_projection"
  | "alias_projection"
  | "duplicate_projection";

export interface PredicateFailureDiagnosticV3 {
  readonly predicateId: string;
  readonly failures: number;
  readonly ratio: number;
}

export interface SemanticRecoveryStageSnapshotV3 {
  readonly discovered: number;
  readonly validCandidates: number;
  readonly scopeEligible: number;
  readonly hardConstraintEligible: number;
  readonly evidenceEligible: number;
  readonly versionCompatible: number;
  readonly storefrontPlayable: number;
  readonly canonicalUnique: number;
  readonly selected: number;
  readonly reserve: number;
  /** Candidate-level catalog-resolution attempts, retained for compatibility. */
  readonly appleLookupCount: number;
  /** Actual Apple provider read invocations made by the catalog adapter. */
  readonly appleProviderRequestCount: number;
}

export interface SemanticRecoveryTransformationV3 {
  readonly kind: SemanticRecoveryTransformationKindV3;
  readonly removedPredicateId: string;
  readonly retainedPredicateId: string;
  readonly reason: string;
}

export interface SemanticPlanRevisionArtifactV3 {
  readonly revision: 2;
  readonly parentRevision: 1;
  readonly equivalence: "semantic_equivalent_repair";
  readonly hardConstraintHash: string;
  readonly planHash: string;
  readonly plan: SelectionPlanV3;
  readonly transformations: readonly SemanticRecoveryTransformationV3[];
  /** Removed predicate id -> semantically-equivalent retained predicate id. */
  readonly predicateProjection: Readonly<Record<string, string>>;
}

export interface PipelineRecoveryAuditArtifactV3 {
  readonly generation: 1;
  readonly rootCause: SemanticRecoveryRootCauseV3;
  readonly action: "semantic_equivalent_requalification";
  readonly status: "complete" | "no_yield" | "blocked" | "failed";
  readonly before: SemanticRecoveryStageSnapshotV3;
  readonly after: SemanticRecoveryStageSnapshotV3;
  readonly beforeFailedMembershipPredicateIds: Readonly<Record<string, number>>;
  readonly afterFailedMembershipPredicateIds: Readonly<Record<string, number>>;
  readonly transformationKinds: readonly SemanticRecoveryTransformationKindV3[];
  readonly idempotencyKey: string;
}

export interface PipelineCandidateLeadArtifactV3 {
  readonly strategyId: string;
  readonly candidateKey: string;
  readonly artist: string;
  readonly title: string;
  readonly album: string | null;
  readonly sourceRecordIds: readonly string[];
  readonly citationHashes: readonly string[];
  readonly predicateCoverage: readonly string[];
  readonly rejectionCode: string | null;
}

export interface RetrievalPredicateDiagnosticsV3 {
  readonly qualificationsObserved: number;
  readonly scopeFailures: number;
  readonly failedMembershipPredicateIds: Readonly<Record<string, number>>;
  /** Candidate-level catalog-resolution attempts, retained for compatibility. */
  readonly appleLookupCount: number;
  /** Actual Apple provider read invocations made by the catalog adapter. */
  readonly appleProviderRequestCount: number;
  readonly rootCause: SemanticRecoveryRootCauseV3;
  readonly recoveryAttemptCount: number;
}

export interface SemanticRecoveryProposalV3 {
  readonly revision: SemanticPlanRevisionArtifactV3;
  readonly trigger: {
    readonly sampleSize: number;
    readonly scopeFailureRatio: number;
    readonly dominantPredicateId: string;
    readonly dominantPredicateRatio: number;
  };
}

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function semanticRecoveryHardConstraintHashV3(plan: SelectionPlanV3): string {
  return plan.semanticAudit?.hardConstraintHash
    ?? hash({
      prompt: plan.prompt,
      requestedTrackCount: plan.requestedTrackCount,
      storefront: plan.storefront,
      hardConstraints: plan.hardConstraints,
      recordingPolicy: plan.recordingPolicy,
      systemSafetyPredicates: plan.membershipPredicates.filter(({ source }) => source === "system_safety"),
    });
}

function predicateKey(predicate: MembershipPredicateV3): string {
  return [
    predicate.axis,
    predicate.operator,
    [...new Set(predicate.values.map(normalized))].sort().join("|"),
  ].join(":");
}

function governedAliasConceptId(predicate: MembershipPredicateV3): string | null {
  if (!["genre", "subgenre", "scene"].includes(predicate.axis)
    || predicate.operator === "exclude"
    || predicate.values.length === 0) return null;
  const concepts = predicate.values.map(exactMusicConceptV3);
  const concept = concepts[0];
  if (!concept || concept.ambiguity !== "none"
    || concepts.some((candidate) => candidate?.id !== concept.id)) return null;
  return concept.id;
}

function sceneContainsGeography(scene: MembershipPredicateV3, geography: MembershipPredicateV3): boolean {
  if (scene.axis !== "scene" || geography.axis !== "geography") return false;
  if (scene.operator === "exclude" || geography.operator === "exclude") return false;
  if (geography.geographyRelationship
    && !["unspecified", "sound_association", "label_or_venue_scene"].includes(geography.geographyRelationship)) {
    return false;
  }
  const sceneText = normalized([...scene.values, scene.reason].join(" "));
  return geography.values.length > 0
    && geography.values.every((value) => {
      const needle = normalized(value);
      return needle.length > 1 && (` ${sceneText} `).includes(` ${needle} `);
    });
}

function immutableContract(plan: SelectionPlanV3): unknown {
  return {
    prompt: plan.prompt,
    requestedTrackCount: plan.requestedTrackCount,
    storefront: plan.storefront,
    hardConstraints: plan.hardConstraints,
    recordingPolicy: plan.recordingPolicy,
    systemSafetyPredicates: plan.membershipPredicates.filter(({ source }) => source === "system_safety"),
  };
}

function sameClauseScope(
  predicate: MembershipPredicateV3,
  clause: SemanticPlanClauseV32,
): boolean {
  if (clause.axis !== predicate.axis) return false;
  const predicateValues = new Set(predicate.values.map(normalized));
  const clauseValues = new Set(clause.values.map(normalized));
  return clauseValues.size > 0
    && clauseValues.size === predicateValues.size
    && [...clauseValues].every((value) => predicateValues.has(value));
}

function audienceMarketClause(
  plan: SelectionPlanV3,
  predicate: MembershipPredicateV3,
): SemanticPlanClauseV32 | null {
  if (predicate.axis !== "geography" || predicate.operator === "exclude") return null;
  return plan.contextSignals.find((clause) => (
    clause.role === "context"
    && clause.axis === "geography"
    && sameClauseScope(predicate, clause)
    && (clause.geographyRelationship === "unspecified"
      || clause.geographyRelationship === "sound_association"
      || clause.geographyRelationship === null)
  )) ?? null;
}

function generatedPolicyClause(
  plan: SelectionPlanV3,
  predicate: MembershipPredicateV3,
): SemanticPlanClauseV32 | null {
  if (predicate.operator === "exclude" || predicate.source === "system_safety") return null;
  return plan.semanticClauses.find((clause) => (
    clause.role === "catalog_policy"
    && clause.explicitUserAuthored === false
    && sameClauseScope(predicate, clause)
  )) ?? null;
}

export function semanticRecoveryMinimumSampleV3(target: number): number {
  const safeTarget = Number.isFinite(target) ? Math.max(1, Math.floor(target)) : 1;
  return Math.max(10, Math.min(safeTarget, 20));
}

/**
 * Produce only a semantics-preserving execution projection. Standalone user
 * geography, unique genres, exclusions, and safety predicates are never
 * removed. Returning null means no safe automatic repair exists.
 */
export function buildSemanticEquivalentRecoveryPlanV3(
  original: SelectionPlanV3,
): SemanticPlanRevisionArtifactV3 | null {
  const predicates = original.membershipPredicates.map((predicate) => ({
    ...predicate,
    values: [...predicate.values],
  }));
  const removed = new Set<string>();
  const transformations: SemanticRecoveryTransformationV3[] = [];
  const projection: Record<string, string> = {};

  const retainedByKey = new Map<string, MembershipPredicateV3>();
  for (const predicate of predicates) {
    if (predicate.source === "system_safety") continue;
    const retained = retainedByKey.get(predicateKey(predicate));
    if (!retained) {
      retainedByKey.set(predicateKey(predicate), predicate);
      continue;
    }
    removed.add(predicate.id);
    projection[predicate.id] = retained.id;
    transformations.push({
      kind: "duplicate_projection",
      removedPredicateId: predicate.id,
      retainedPredicateId: retained.id,
      reason: "Exact duplicate membership projection",
    });
  }

  const aliasesByConcept = new Map<string, MembershipPredicateV3[]>();
  for (const predicate of predicates.filter((candidate) => !removed.has(candidate.id))) {
    const conceptId = governedAliasConceptId(predicate);
    if (!conceptId) continue;
    const group = aliasesByConcept.get(conceptId) ?? [];
    group.push(predicate);
    aliasesByConcept.set(conceptId, group);
  }
  for (const [conceptId, aliasPredicates] of aliasesByConcept) {
    if (aliasPredicates.length < 2) continue;
    const retained = aliasPredicates[0]!;
    for (const predicate of aliasPredicates.slice(1)) {
      if (predicate.source === "system_safety") continue;
      removed.add(predicate.id);
      projection[predicate.id] = retained.id;
      transformations.push({
        kind: "alias_projection",
        removedPredicateId: predicate.id,
        retainedPredicateId: retained.id,
        reason: `Governed music concept ${conceptId} projected to one evidence predicate`,
      });
    }
  }

  const scenes = predicates.filter((predicate) => !removed.has(predicate.id) && predicate.axis === "scene");
  for (const geography of predicates.filter((predicate) => !removed.has(predicate.id) && predicate.axis === "geography")) {
    if (geography.source === "system_safety") continue;
    const scene = scenes.find((candidate) => sceneContainsGeography(candidate, geography));
    if (scene) {
      removed.add(geography.id);
      projection[geography.id] = scene.id;
      transformations.push({
        kind: "context_geography_projection",
        removedPredicateId: geography.id,
        retainedPredicateId: scene.id,
        reason: "Geography is already encoded by the explicit scene predicate",
      });
      continue;
    }
    const context = audienceMarketClause(original, geography);
    if (!context) continue;
    removed.add(geography.id);
    transformations.push({
      kind: "context_geography_projection",
      removedPredicateId: geography.id,
      retainedPredicateId: context.id,
      reason: "Audience-market geography is context, not track membership",
    });
  }

  for (const predicate of predicates.filter((candidate) => !removed.has(candidate.id))) {
    const policy = generatedPolicyClause(original, predicate);
    if (!policy) continue;
    removed.add(predicate.id);
    transformations.push({
      kind: "generated_policy_projection",
      removedPredicateId: predicate.id,
      retainedPredicateId: policy.id,
      reason: "Generated catalog-policy prose is enforced by catalog policy, not source evidence",
    });
  }

  if (transformations.length === 0) return null;
  const repaired: SelectionPlanV3 = Object.freeze({
    ...original,
    membershipPredicates: Object.freeze(predicates.filter(({ id }) => !removed.has(id))),
  });
  if (hash(immutableContract(repaired)) !== hash(immutableContract(original))) {
    throw new Error("Semantic recovery attempted to change an immutable request constraint");
  }
  const hardConstraintHash = semanticRecoveryHardConstraintHashV3(original);
  if (hardConstraintHash !== semanticRecoveryHardConstraintHashV3(repaired)) {
    throw new Error("Semantic recovery attempted to change the hard-constraint hash");
  }
  return Object.freeze({
    revision: 2,
    parentRevision: 1,
    equivalence: "semantic_equivalent_repair",
    hardConstraintHash,
    planHash: hash(repaired),
    plan: repaired,
    transformations: Object.freeze([...transformations]),
    predicateProjection: Object.freeze({ ...projection }),
  });
}

export function predicateFailureCountsV3(
  qualifications: readonly CandidateQualificationV3[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const qualification of qualifications) {
    if (qualification.scope.passed) continue;
    for (const id of new Set(qualification.scope.failedMembershipPredicateIds)) {
      counts[id] = (counts[id] ?? 0) + 1;
    }
  }
  return Object.freeze(counts);
}

export function appleLookupCountV3(
  qualifications: readonly CandidateQualificationV3[],
): number {
  return qualifications.filter(({ catalog }) => catalog.lookupAttempted === true).length;
}

export function appleProviderRequestCountV3(
  qualifications: readonly CandidateQualificationV3[],
): number {
  return qualifications.reduce((total, { catalog }) => {
    const count = catalog.appleProviderRequestCount;
    return total + (Number.isInteger(count) && (count ?? -1) >= 0 ? count! : 0);
  }, 0);
}

export function proposeSemanticRecoveryV3(input: {
  readonly plan: SelectionPlanV3;
  readonly qualifications: readonly CandidateQualificationV3[];
  readonly providerDegraded: boolean;
  readonly priorAttemptCount: number;
}): SemanticRecoveryProposalV3 | null {
  if (input.providerDegraded || input.priorAttemptCount >= PIPELINE_V3_SEMANTIC_RECOVERY_MAX_ATTEMPTS) return null;
  const sampleSize = input.qualifications.length;
  if (sampleSize < semanticRecoveryMinimumSampleV3(input.plan.requestedTrackCount)) return null;
  const scopeFailures = input.qualifications.filter(({ scope }) => !scope.passed).length;
  const scopeFailureRatio = scopeFailures / sampleSize;
  if (scopeFailureRatio < PIPELINE_V3_SEMANTIC_RECOVERY_DOMINANCE) return null;
  const counts = predicateFailureCountsV3(input.qualifications);
  const dominant = Object.entries(counts).sort((left, right) => right[1] - left[1])[0];
  if (!dominant) return null;
  const dominantPredicateRatio = dominant[1] / sampleSize;
  if (dominantPredicateRatio < PIPELINE_V3_SEMANTIC_RECOVERY_DOMINANCE) return null;
  const revision = buildSemanticEquivalentRecoveryPlanV3(input.plan);
  if (!revision) return null;
  // A repair is useful only if the dominant failed predicate participates in
  // the safe equivalence projection (as removed or retained). This prevents a
  // harmless duplicate elsewhere from becoming an excuse to relax the real
  // failing predicate.
  const relevant = revision.transformations.some(({ removedPredicateId, retainedPredicateId }) => (
    removedPredicateId === dominant[0] || retainedPredicateId === dominant[0]
  ));
  if (!relevant) return null;
  return Object.freeze({
    revision,
    trigger: Object.freeze({
      sampleSize,
      scopeFailureRatio,
      dominantPredicateId: dominant[0],
      dominantPredicateRatio,
    }),
  });
}

/** Restore original equivalent predicate ids so immutable-plan persistence can
 * retain explicit track bindings for every original predicate. */
export function projectQualificationToOriginalPredicatesV3(
  qualification: CandidateQualificationV3,
  projection: Readonly<Record<string, string>>,
): CandidateQualificationV3 {
  const bindings = qualification.evidence.bindings?.map((binding) => {
    const predicateIds = new Set(binding.predicateIds ?? binding.supportedPredicateIds ?? []);
    for (const [removed, retained] of Object.entries(projection)) {
      if (predicateIds.has(retained)) predicateIds.add(removed);
    }
    return { ...binding, predicateIds: [...predicateIds] };
  });
  return {
    ...qualification,
    evidence: { ...qualification.evidence, ...(bindings ? { bindings } : {}) },
  };
}

export function recoveryStageSnapshotV3(
  stages: RetrievalStageCountersV3,
  appleLookupCount: number,
  appleProviderRequestCount = 0,
): SemanticRecoveryStageSnapshotV3 {
  return Object.freeze({ ...stages, appleLookupCount, appleProviderRequestCount });
}

export function semanticRecoveryRootCauseV3(input: {
  readonly stages: Pick<RetrievalStageCountersV3,
    "validCandidates" | "scopeEligible" | "evidenceEligible" | "storefrontPlayable">;
  readonly providerDegraded: boolean;
}): SemanticRecoveryRootCauseV3 {
  if (input.providerDegraded) return "provider_degraded";
  if (input.stages.validCandidates > 0 && input.stages.scopeEligible === 0) return "semantic_contract";
  if (input.stages.scopeEligible > input.stages.evidenceEligible) return "evidence_shortfall";
  if (input.stages.evidenceEligible > input.stages.storefrontPlayable) return "catalog_shortfall";
  return "under_discovery";
}

export function candidateLeadKeyV3(candidate: RawTrackCandidateV3): string {
  return hash({
    artist: normalized(candidate.artist),
    title: normalized(candidate.title),
    album: normalized(candidate.album ?? ""),
  });
}

export function citationHashesV3(candidate: RawTrackCandidateV3): string[] {
  return [...new Set(candidate.sourceObservationIds.map((id) => hash(id)))].slice(0, 32);
}

export function recoveryAuditIdempotencyKeyV3(input: {
  readonly runId: string;
  readonly planHash: string;
  readonly transformations: readonly SemanticRecoveryTransformationV3[];
}): string {
  return `semantic-recovery:${hash(input)}`;
}
