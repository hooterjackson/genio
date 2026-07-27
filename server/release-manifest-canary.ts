import { createHash } from "node:crypto";
import type { QueryPlanV3 } from "../shared/types.ts";
import { evaluateCanonicalContractTrackV1 } from "./canonical-contract-runtime-v1.ts";
import {
  centralQualityCriterionObservationsForPolicyV3,
  evidenceBindingIsAttestedForSelectionV3,
  evaluateCentralQualityV3,
  evaluatePlaylistOptimizationV3,
  validateCanonicalPublicationSetV3,
  type QualifiedTrackV3,
} from "./pipeline-v3-retrieval.ts";
import {
  CANONICAL_CONTRACT_QUERY_PLAN_V3_VERSION,
  queryPlanV3Hash,
} from "./query-plan-v3.ts";
import { stableStringify } from "./security.ts";
import type { SelectionPlanV3 } from "./selection-plan-v3.ts";

export const RELEASE_MANIFEST_CANARY_MARKER_PHASE =
  "v3:release-canary:manifest-only" as const;
export const RELEASE_MANIFEST_CANARY_MARKER_SCHEMA =
  "genio-release-manifest-canary-marker/v1" as const;
export const RELEASE_MANIFEST_CANARY_EVIDENCE_SCHEMA =
  "genio-release-manifest-canary-evidence/v1" as const;
export const RELEASE_MANIFEST_CANARY_MAX_TRACKS = 300;

const SHA256 = /^[0-9a-f]{64}$/u;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SAFE_CANARY_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{2,63}$/u;
const SAFE_APPLE_ID = /^\d{1,32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTRACT_REVISION_ID = /^pcr1:[0-9a-f]{64}$/u;

type JsonRecord = Record<string, unknown>;

export interface ReleaseManifestCanaryMarkerV1 {
  schemaVersion: typeof RELEASE_MANIFEST_CANARY_MARKER_SCHEMA;
  canaryId: string;
  cacheMode: "reuse_disabled";
  environment: "staging";
  executionMode: "shadow";
  publicationBoundary: "database_fenced";
  appleWriteAccess: "forbidden";
  sourceRevision: string;
  queryPlanHash: string;
  queryPlanRevisionId: string;
  contractRevisionDatabaseId: string;
  contractRevisionId: string;
  contractSemanticHash: string;
  stageKey: string;
  requestedTrackCount: number;
  createdAt: string;
}

export interface ReleaseManifestCanaryAttemptProofV1 {
  stage: string;
  contractRevisionDatabaseId: string;
  queryPlanRevisionId: string;
  executorRevision: string;
  executorIdentityHash: string;
  configurationHash: string;
  status: "complete";
  completedAt: string;
}

export interface ReleaseManifestCanaryZeroWriteCountsV1 {
  autoPublish: boolean;
  manifestRows: number;
  matchingJobs: number;
  publicationJobs: number;
  publicationVolumeRows: number;
}

export interface ReleaseManifestCanaryEvidenceV1 {
  schemaVersion: typeof RELEASE_MANIFEST_CANARY_EVIDENCE_SCHEMA;
  canaryId: string;
  cacheMode: "reuse_disabled";
  environment: "staging";
  sourceRevision: string;
  executionMode: "shadow";
  publicationBoundary: "database_fenced";
  appleWriteAccess: "forbidden";
  outcome: "exact_ready";
  requestedTrackCount: number;
  selectedTrackCount: number;
  reserveTrackCount: number;
  queryPlanHash: string;
  queryPlanRevisionId: string;
  contractRevisionDatabaseId: string;
  contractRevisionId: string;
  contractSemanticHash: string;
  qualifiedManifestHash: string;
  qualifiedReserveHash: string;
  selectionValidation: {
    canonicalPublicationValid: true;
    centralQualityRequired: boolean;
    centralQualityPassed: boolean | null;
    playlistOptimizationRequired: boolean;
    playlistOptimizationExact: boolean | null;
    usefulReserveTrackCount: number;
  };
  attempts: ReleaseManifestCanaryAttemptProofV1[];
  executorIdentityHashes: string[];
  configurationHashes: string[];
  zeroWriteProof: {
    autoPublish: false;
    manifestRows: 0;
    matchingJobs: 0;
    publicationJobs: 0;
    publicationVolumeRows: 0;
  };
  completedAt: string;
  evidenceHash: string;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function count(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function parseReleaseManifestCanaryMarker(
  value: unknown,
): ReleaseManifestCanaryMarkerV1 | null {
  const input = record(value);
  if (!input || !exactKeys(input, [
    "schemaVersion",
    "canaryId",
    "cacheMode",
    "environment",
    "executionMode",
    "publicationBoundary",
    "appleWriteAccess",
    "sourceRevision",
    "queryPlanHash",
    "queryPlanRevisionId",
    "contractRevisionDatabaseId",
    "contractRevisionId",
    "contractSemanticHash",
    "stageKey",
    "requestedTrackCount",
    "createdAt",
  ])) return null;
  const requestedTrackCount = count(input.requestedTrackCount);
  if (
    input.schemaVersion !== RELEASE_MANIFEST_CANARY_MARKER_SCHEMA
    || typeof input.canaryId !== "string"
    || !SAFE_CANARY_ID.test(input.canaryId)
    || input.cacheMode !== "reuse_disabled"
    || input.environment !== "staging"
    || input.executionMode !== "shadow"
    || input.publicationBoundary !== "database_fenced"
    || input.appleWriteAccess !== "forbidden"
    || typeof input.sourceRevision !== "string"
    || !REVISION.test(input.sourceRevision)
    || typeof input.queryPlanHash !== "string"
    || !SHA256.test(input.queryPlanHash)
    || typeof input.queryPlanRevisionId !== "string"
    || !UUID.test(input.queryPlanRevisionId)
    || typeof input.contractRevisionDatabaseId !== "string"
    || !UUID.test(input.contractRevisionDatabaseId)
    || typeof input.contractRevisionId !== "string"
    || !CONTRACT_REVISION_ID.test(input.contractRevisionId)
    || typeof input.contractSemanticHash !== "string"
    || !SHA256.test(input.contractSemanticHash)
    || typeof input.stageKey !== "string"
    || !input.stageKey.startsWith("v3-retrieval:shadow:")
    || input.stageKey.length > 120
    || requestedTrackCount === null
    || requestedTrackCount < 1
    || requestedTrackCount > RELEASE_MANIFEST_CANARY_MAX_TRACKS
    || !timestamp(input.createdAt)
  ) return null;
  return input as unknown as ReleaseManifestCanaryMarkerV1;
}

export function createReleaseManifestCanaryMarker(input: {
  canaryId: string;
  cacheMode: "reuse_disabled";
  sourceRevision: string;
  queryPlanHash: string;
  queryPlanRevisionId: string;
  contractRevisionDatabaseId: string;
  contractRevisionId: string;
  contractSemanticHash: string;
  stageKey: string;
  requestedTrackCount: number;
  createdAt?: string;
}): ReleaseManifestCanaryMarkerV1 {
  const marker = {
    schemaVersion: RELEASE_MANIFEST_CANARY_MARKER_SCHEMA,
    canaryId: input.canaryId,
    cacheMode: input.cacheMode,
    environment: "staging",
    executionMode: "shadow",
    publicationBoundary: "database_fenced",
    appleWriteAccess: "forbidden",
    sourceRevision: input.sourceRevision.toLowerCase(),
    queryPlanHash: input.queryPlanHash,
    queryPlanRevisionId: input.queryPlanRevisionId,
    contractRevisionDatabaseId: input.contractRevisionDatabaseId,
    contractRevisionId: input.contractRevisionId,
    contractSemanticHash: input.contractSemanticHash,
    stageKey: input.stageKey,
    requestedTrackCount: input.requestedTrackCount,
    createdAt: input.createdAt ?? new Date().toISOString(),
  } as const;
  const parsed = parseReleaseManifestCanaryMarker(marker);
  if (!parsed) throw new Error("invalid_release_manifest_canary_marker");
  return parsed;
}

export function releaseManifestCanaryExecutionMode(value: unknown): "shadow" | null {
  return parseReleaseManifestCanaryMarker(value) ? "shadow" : null;
}

function qualifiedManifestMaterial(
  tracks: readonly QualifiedTrackV3[],
  qualityPolicy: SelectionPlanV3["playlistQualityPolicy"],
): unknown[] {
  return tracks.map((track, index) => {
    const appleSongId = typeof track.appleSongId === "string" ? track.appleSongId : "";
    const recordingFamilyKey = typeof track.recordingFamilyKey === "string"
      ? track.recordingFamilyKey.trim()
      : "";
    const evidenceBindingIds = Array.isArray(track.evidenceBindingIds)
      ? [...new Set(track.evidenceBindingIds.filter((item): item is string => (
          typeof item === "string" && item.trim().length > 0
        )))].sort()
      : [];
    if (!SAFE_APPLE_ID.test(appleSongId)
      || !recordingFamilyKey
      || recordingFamilyKey.length > 320
      || evidenceBindingIds.length < 1) {
      throw new Error("release_manifest_canary_track_is_not_qualified");
    }
    return {
      position: index,
      appleSongId,
      recordingFamilyKey,
      evidenceBindingIds,
      evidenceBindingsHash: hash(track.evidenceBindings ?? []),
      canonicalClauseAssessments: record(track.canonicalClauseAssessments) ?? {},
      centralQualityCriterionObservations: qualityPolicy
        ? centralQualityCriterionObservationsForPolicyV3({
            observations: track.centralQualityCriterionObservations,
            policy: qualityPolicy,
            artist: track.artist,
            title: track.title,
            album: track.album,
            appleSongId,
            recordingFamilyKey,
          })
        : [],
      playlistOptimizationSignals: record(track.playlistOptimizationSignals) ?? null,
      rankingSignals: record(track.rankingSignals) ?? {},
    };
  });
}

function validationPlan(queryPlan: QueryPlanV3): SelectionPlanV3 {
  const targetTrackCount = count(queryPlan.targetTrackCount);
  if (
    targetTrackCount === null
    || targetTrackCount < 1
    || queryPlan.schemaVersion !== CANONICAL_CONTRACT_QUERY_PLAN_V3_VERSION
    || !queryPlan.canonicalContractPolicy
    || !queryPlan.scopeKind
    || !queryPlan.diversityGoals
    || !queryPlan.orderingPolicy
    || !Array.isArray(queryPlan.softGoalRelaxationOrder)
  ) {
    throw new Error("release_manifest_canary_query_plan_is_not_selection_complete");
  }
  return {
    pipelineVersion: queryPlan.pipelineVersion,
    requestedTrackCount: targetTrackCount,
    storefront: queryPlan.storefront,
    scopeKind: queryPlan.scopeKind,
    hardConstraints: queryPlan.hardConstraints,
    rankingObjectives: queryPlan.rankingObjectives,
    diversityGoals: queryPlan.diversityGoals,
    orderingPolicy: queryPlan.orderingPolicy,
    softGoalRelaxationOrder: queryPlan.softGoalRelaxationOrder,
    playlistQuotaRules: queryPlan.playlistQuotaRules ?? [],
    ...(queryPlan.playlistQualityPolicy ? {
      playlistQualityPolicy: queryPlan.playlistQualityPolicy,
    } : {}),
    canonicalContractPolicy: queryPlan.canonicalContractPolicy,
  } as unknown as SelectionPlanV3;
}

function qualifiedTracks(values: readonly unknown[]): QualifiedTrackV3[] {
  return values.map((value) => {
    const track = record(value);
    if (!track) throw new Error("release_manifest_canary_track_is_not_qualified");
    return track as unknown as QualifiedTrackV3;
  });
}

function optimizerRequired(plan: SelectionPlanV3): boolean {
  return plan.scopeKind === "broad_curated"
    && plan.canonicalContractPolicy?.policyVersion
      === "canonical_contract_runtime_v1";
}

function canonicalEvidenceIds(values: readonly string[] | undefined): string[] | null {
  if (!Array.isArray(values)
    || values.some((value) => typeof value !== "string"
      || value.length === 0
      || value.trim() !== value)) return null;
  const ids = [...new Set(values)].sort();
  return ids.length === values.length ? ids : null;
}

/**
 * A release canary is intended to prove the live hosted-evidence route, not
 * merely that an adapter can attach an otherwise well-formed URL
 * attestation. Bind each referenced assessment back to its exact contract
 * clause and require the frozen snapshot to carry exactly those obligations
 * for this track.
 */
function canonicalCanaryTrackHasBoundHostedEvidence(input: {
  plan: SelectionPlanV3;
  track: QualifiedTrackV3;
}): boolean {
  const policy = input.plan.canonicalContractPolicy;
  if (!policy || policy.storefront !== input.plan.storefront) return false;
  const declaredBindingIds = canonicalEvidenceIds(input.track.evidenceBindingIds);
  const bindings = input.track.evidenceBindings;
  if (!declaredBindingIds
    || declaredBindingIds.length === 0
    || !Array.isArray(bindings)
    || bindings.length !== declaredBindingIds.length) return false;
  const bindingById = new Map(bindings.map((binding) => [binding.id, binding]));
  if (bindingById.size !== bindings.length
    || declaredBindingIds.some((id) => !bindingById.has(id))) return false;

  const assessments = input.track.canonicalClauseAssessments ?? {};
  const obligationsByBindingId = new Map<string, Set<string>>();
  for (const clause of policy.clauses) {
    const assessment = assessments[clause.id];
    const evidenceIds = canonicalEvidenceIds(assessment?.evidenceIds ?? []);
    if (!evidenceIds) return false;
    const requiresExternalEvidence = clause.evidence.required
      && (assessment?.status === "pass" || assessment?.status === "fail")
      && assessment.evidenceGrade !== "authoritative_structured_metadata";
    if (requiresExternalEvidence && evidenceIds.length === 0) return false;
    for (const evidenceId of evidenceIds) {
      if (!declaredBindingIds.includes(evidenceId)) return false;
      const obligations = obligationsByBindingId.get(evidenceId) ?? new Set<string>();
      obligations.add(clause.id);
      obligationsByBindingId.set(evidenceId, obligations);
    }
    // Catalog metadata may independently satisfy the clause and therefore
    // omit evidenceIds. The canary still proves that every hosted binding it
    // carries is scoped to a passing canonical clause, rather than accepting
    // an unrelated exact-track citation.
    if (assessment?.status === "pass") {
      for (const binding of bindings) {
        const predicateIds = binding.predicateIds
          ?? binding.supportedPredicateIds
          ?? [];
        if (!predicateIds.includes(clause.id)) continue;
        const obligations = obligationsByBindingId.get(binding.id)
          ?? new Set<string>();
        obligations.add(clause.id);
        obligationsByBindingId.set(binding.id, obligations);
      }
    }
  }
  if (obligationsByBindingId.size !== declaredBindingIds.length) return false;

  for (const bindingId of declaredBindingIds) {
    const binding = bindingById.get(bindingId);
    const obligationIds = [...(obligationsByBindingId.get(bindingId) ?? [])].sort();
    if (!binding
      || binding.governance.accessMethod !== "hosted_web_search"
      || !binding.hostedEvidenceSnapshot
      || stableStringify(binding.hostedEvidenceSnapshot.obligationIds)
        !== stableStringify(obligationIds)
      || !evidenceBindingIsAttestedForSelectionV3(binding, {
        requireHostedEvidenceSnapshot: true,
        storefront: input.plan.storefront,
        requiredObligationIds: obligationIds,
      })) return false;
  }
  return true;
}

function usefulReserveTrackCount(input: {
  plan: SelectionPlanV3;
  selected: readonly QualifiedTrackV3[];
  reserve: readonly QualifiedTrackV3[];
}): number {
  const policy = input.plan.canonicalContractPolicy;
  if (!policy) return 0;
  return input.reserve.filter((reserveTrack) => {
    if (!canonicalCanaryTrackHasBoundHostedEvidence({
      plan: input.plan,
      track: reserveTrack,
    })
      || !evaluateCanonicalContractTrackV1({
        policy,
        assessments: reserveTrack.canonicalClauseAssessments ?? {},
      }).eligible) return false;
    return input.selected.some((_selectedTrack, index) => {
      const repaired = [...input.selected];
      repaired[index] = reserveTrack;
      return validateCanonicalPublicationSetV3({
        plan: input.plan,
        tracks: repaired,
      }).valid;
    });
  }).length;
}

export function buildReleaseManifestCanaryEvidence(input: {
  marker: unknown;
  runStatus: unknown;
  runPhase: unknown;
  pipelineVersion: unknown;
  autoPublish: unknown;
  queryPlan: QueryPlanV3 | null;
  activeQueryPlanRevisionId: unknown;
  storedQueryPlanHash: unknown;
  activeContractRevisionDatabaseId: unknown;
  activeContractRevisionId: unknown;
  activeContractSemanticHash: unknown;
  checkpoint: unknown;
  attempts: readonly ReleaseManifestCanaryAttemptProofV1[];
  zeroWriteCounts: ReleaseManifestCanaryZeroWriteCountsV1;
}): ReleaseManifestCanaryEvidenceV1 {
  const marker = parseReleaseManifestCanaryMarker(input.marker);
  const checkpoint = record(input.checkpoint);
  const outcome = record(checkpoint?.outcome);
  const publicationBoundary = record(checkpoint?.publicationBoundary);
  const selectedValues = Array.isArray(checkpoint?.selected) ? checkpoint.selected : [];
  const reserveValues = Array.isArray(checkpoint?.reserve) ? checkpoint.reserve : [];
  if (!marker
    || input.runStatus !== "complete"
    || input.runPhase !== "v3_shadow_exact_ready"
    || input.pipelineVersion !== "corpus_first_v3"
    || input.autoPublish !== false
    || !input.queryPlan
    || input.queryPlan.schemaVersion !== CANONICAL_CONTRACT_QUERY_PLAN_V3_VERSION
    || input.queryPlan.briefContractVersion !== 3
    || queryPlanV3Hash(input.queryPlan) !== marker.queryPlanHash
    || input.activeQueryPlanRevisionId !== marker.queryPlanRevisionId
    || input.storedQueryPlanHash !== marker.queryPlanHash
    || input.activeContractRevisionDatabaseId !== marker.contractRevisionDatabaseId
    || input.activeContractRevisionId !== marker.contractRevisionId
    || input.activeContractSemanticHash !== marker.contractSemanticHash
    || input.queryPlan.playlistContractRevisionId !== marker.contractRevisionId
    || input.queryPlan.playlistContractSemanticHash !== marker.contractSemanticHash
    || checkpoint?.schemaVersion !== "genio-pipeline-v3-worker/v1"
    || checkpoint.state !== "complete"
    || checkpoint.executionMode !== "shadow"
    || checkpoint.stageKey !== marker.stageKey
    || checkpoint.queryPlanHash !== marker.queryPlanHash
    || checkpoint.queryPlanRevisionId !== marker.queryPlanRevisionId
    || outcome?.status !== "exact_ready"
    || count(outcome.requestedTrackCount) !== marker.requestedTrackCount
    || count(outcome.selectedTrackCount) !== marker.requestedTrackCount
    || count(outcome.reserveTrackCount) !== reserveValues.length
    || selectedValues.length !== marker.requestedTrackCount
    || publicationBoundary?.appleWriteAccess !== "forbidden"
    || publicationBoundary.manifestDisposition !== "shadow_manifest_only"
    || !timestamp(checkpoint.completedAt)
  ) {
    throw new Error("release_manifest_canary_did_not_reach_an_exact_shadow_manifest");
  }
  const selected = qualifiedTracks(selectedValues);
  const reserve = qualifiedTracks(reserveValues);
  const allTracks = [...selected, ...reserve];
  if (new Set(allTracks.map(({ appleSongId }) => appleSongId)).size !== allTracks.length
    || new Set(allTracks.map(({ recordingFamilyKey }) => recordingFamilyKey)).size !== allTracks.length) {
    throw new Error("release_manifest_canary_manifest_contains_duplicates");
  }
  if (
    input.zeroWriteCounts.autoPublish !== false
    || input.zeroWriteCounts.manifestRows !== 0
    || input.zeroWriteCounts.matchingJobs !== 0
    || input.zeroWriteCounts.publicationJobs !== 0
    || input.zeroWriteCounts.publicationVolumeRows !== 0
  ) {
    throw new Error("release_manifest_canary_crossed_the_apple_write_boundary");
  }
  if (input.attempts.length < 1
    || input.attempts.some((attempt) => (
    attempt.stage !== marker.stageKey
    || attempt.contractRevisionDatabaseId !== marker.contractRevisionDatabaseId
    || attempt.queryPlanRevisionId !== marker.queryPlanRevisionId
    || attempt.executorRevision.toLowerCase() !== marker.sourceRevision
    || !SHA256.test(attempt.executorIdentityHash)
    || !SHA256.test(attempt.configurationHash)
    || attempt.status !== "complete"
    || !timestamp(attempt.completedAt)
  ))) {
    throw new Error("release_manifest_canary_executor_identity_is_unproven");
  }
  const executorIdentityHashes = [...new Set(
    input.attempts.map(({ executorIdentityHash }) => executorIdentityHash),
  )].sort();
  const configurationHashes = [...new Set(
    input.attempts.map(({ configurationHash }) => configurationHash),
  )].sort();
  if (executorIdentityHashes.length !== 1 || configurationHashes.length !== 1) {
    throw new Error("release_manifest_canary_executor_identity_is_incoherent");
  }
  const plan = validationPlan(input.queryPlan);
  if (allTracks.some((track) => !canonicalCanaryTrackHasBoundHostedEvidence({
    plan,
    track,
  }))) {
    throw new Error("release_manifest_canary_canonical_evidence_is_unproven");
  }
  const publicationValidation = validateCanonicalPublicationSetV3({
    plan,
    tracks: selected,
  });
  if (!publicationValidation.valid) {
    throw new Error(
      `release_manifest_canary_selection_is_invalid:${
        publicationValidation.reasonCodes.join(",")
      }`,
    );
  }
  const centralQuality = input.queryPlan.playlistQualityPolicy
    ? evaluateCentralQualityV3({
      tracks: selected,
      policy: input.queryPlan.playlistQualityPolicy,
    })
    : null;
  const checkpointCentralQuality = record(checkpoint.centralQuality);
  if (centralQuality
    && (!centralQuality.passed
      || stableStringify(checkpointCentralQuality) !== stableStringify(centralQuality))) {
    throw new Error("release_manifest_canary_central_quality_is_unproven");
  }
  const requiresOptimizer = optimizerRequired(plan);
  const checkpointOptimization = record(checkpoint.playlistOptimization);
  const recomputedOptimization = evaluatePlaylistOptimizationV3({
    plan,
    tracks: selected,
  });
  if (
    requiresOptimizer
    && (
      !recomputedOptimization?.exact
      || stableStringify(checkpointOptimization)
        !== stableStringify(recomputedOptimization)
    )
  ) {
    throw new Error("release_manifest_canary_playlist_optimization_is_unproven");
  }
  const usefulReserveCount = usefulReserveTrackCount({
    plan,
    selected,
    reserve,
  });
  if (usefulReserveCount !== reserve.length) {
    throw new Error("release_manifest_canary_reserve_is_not_usable");
  }
  const manifestMaterial = qualifiedManifestMaterial(
    selected,
    plan.playlistQualityPolicy,
  );
  const reserveMaterial = qualifiedManifestMaterial(
    reserve,
    plan.playlistQualityPolicy,
  );
  const attempts = input.attempts
    .map((attempt) => ({
      stage: attempt.stage,
      contractRevisionDatabaseId: attempt.contractRevisionDatabaseId,
      queryPlanRevisionId: attempt.queryPlanRevisionId,
      executorRevision: attempt.executorRevision.toLowerCase(),
      executorIdentityHash: attempt.executorIdentityHash,
      configurationHash: attempt.configurationHash,
      status: "complete" as const,
      completedAt: attempt.completedAt,
    }))
    .sort((left, right) => left.completedAt.localeCompare(right.completedAt)
      || left.executorIdentityHash.localeCompare(right.executorIdentityHash));
  const unsigned = {
    schemaVersion: RELEASE_MANIFEST_CANARY_EVIDENCE_SCHEMA,
    canaryId: marker.canaryId,
    cacheMode: marker.cacheMode,
    environment: "staging",
    sourceRevision: marker.sourceRevision,
    executionMode: "shadow",
    publicationBoundary: "database_fenced",
    appleWriteAccess: "forbidden",
    outcome: "exact_ready",
    requestedTrackCount: marker.requestedTrackCount,
    selectedTrackCount: selected.length,
    reserveTrackCount: reserve.length,
    queryPlanHash: marker.queryPlanHash,
    queryPlanRevisionId: marker.queryPlanRevisionId,
    contractRevisionDatabaseId: marker.contractRevisionDatabaseId,
    contractRevisionId: marker.contractRevisionId,
    contractSemanticHash: marker.contractSemanticHash,
    qualifiedManifestHash: hash(manifestMaterial),
    qualifiedReserveHash: hash(reserveMaterial),
    selectionValidation: {
      canonicalPublicationValid: true,
      centralQualityRequired: centralQuality !== null,
      centralQualityPassed: centralQuality?.passed ?? null,
      playlistOptimizationRequired: requiresOptimizer,
      playlistOptimizationExact: requiresOptimizer ? true : null,
      usefulReserveTrackCount: usefulReserveCount,
    },
    attempts,
    executorIdentityHashes,
    configurationHashes,
    zeroWriteProof: {
      autoPublish: false,
      manifestRows: 0,
      matchingJobs: 0,
      publicationJobs: 0,
      publicationVolumeRows: 0,
    },
    completedAt: checkpoint.completedAt,
  } as const;
  return {
    ...unsigned,
    evidenceHash: hash(unsigned),
  };
}
