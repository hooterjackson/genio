import { createHash } from "node:crypto";
import {
  adaptiveFillPlanV3,
  type StageYieldObservationV3,
} from "./adaptive-fill-v3.ts";
import {
  evidenceMembershipPredicateIdsV3,
  type RankingObjectiveV3,
  type SelectionPlanV3,
} from "./selection-plan-v3.ts";
import type { PipelineV3ModelRoute } from "./pipeline-v3-policy.ts";
import type { SelectionConstraint } from "../shared/types.ts";
import { assertPublicHttpsUrl } from "./security.ts";

/**
 * Provider-independent orchestration boundary for Pipeline V3 retrieval.
 *
 * This module deliberately exposes no Apple mutation port. It may discover
 * candidates, resolve read-only catalog identities, and produce a draft
 * selection. Publication remains a separate, manifest-gated subsystem.
 */
export const PIPELINE_V3_RETRIEVAL_SCHEMA = "genio-pipeline-v3-retrieval/v1" as const;

export type RetrievalEngineV3 =
  | "curated_genre_scene"
  | "mood_activity_theme"
  | "similarity"
  | "artist_catalogue"
  | "fixed_container"
  | "factual_relationship"
  | "exhaustive";

export type RetrievalExecutionModeV3 = "active" | "shadow";

export interface RetrievalRoutingHintsV3 {
  /** Explicit albums, soundtracks, charts, supplied lists, or other fixed containers. */
  readonly fixedContainer: boolean;
}

const ENGINE_ORDER: readonly RetrievalEngineV3[] = [
  "fixed_container",
  "artist_catalogue",
  "factual_relationship",
  "exhaustive",
  "similarity",
  "mood_activity_theme",
  "curated_genre_scene",
] as const;

/**
 * Route every relevant intent. Composite requests are intentionally allowed
 * to use more than one engine; hard predicates are ANDed only during the
 * qualification stage, never by unioning engine-specific eligibility.
 */
export function routeRetrievalEnginesV3(
  plan: SelectionPlanV3,
  hints: RetrievalRoutingHintsV3 = { fixedContainer: false },
): RetrievalEngineV3[] {
  const engines = new Set<RetrievalEngineV3>();
  if (hints.fixedContainer) engines.add("fixed_container");
  if (plan.intents.includes("artist_catalogue")) engines.add("artist_catalogue");
  if (plan.intents.includes("factual_relationship")) engines.add("factual_relationship");
  if (plan.intents.includes("exhaustive")) engines.add("exhaustive");
  if (plan.intents.includes("similarity")) engines.add("similarity");
  if (plan.intents.some((intent) => intent === "mood_activity" || intent === "theme")) {
    engines.add("mood_activity_theme");
  }
  if (plan.intents.some((intent) => intent === "genre_scene" || intent === "editorial_ranking")) {
    engines.add("curated_genre_scene");
  }
  if (engines.size === 0) engines.add("curated_genre_scene");
  return ENGINE_ORDER.filter((engine) => engines.has(engine));
}

export type RetrievalStrategyKindV3 =
  | "scope_resolution"
  | "trusted_containers"
  | "editorial_tracks"
  | "descriptive_tracks"
  | "stylistic_tracks"
  | "reference_neighborhood"
  | "artist_identity"
  | "release_enumeration"
  | "container_enumeration"
  | "graph_traversal"
  | "source_frontier"
  | "gap_pass"
  | "qualified_expansion"
  | "multilingual_aliases"
  | "deficit_query";

export interface RetrievalStrategyDefinitionV3 {
  readonly id: string;
  readonly engine: RetrievalEngineV3;
  readonly kind: RetrievalStrategyKindV3;
  readonly tier: number;
  readonly maximumRounds: number;
  readonly maximumBatchSize: number;
  readonly zeroQualifiedYieldLimit: 2;
}

function strategy(
  engine: RetrievalEngineV3,
  id: string,
  kind: RetrievalStrategyKindV3,
  tier: number,
  maximumRounds: number,
  maximumBatchSize = 250,
): RetrievalStrategyDefinitionV3 {
  return Object.freeze({
    id: `${engine}:${id}`,
    engine,
    kind,
    tier,
    maximumRounds,
    maximumBatchSize,
    zeroQualifiedYieldLimit: 2 as const,
  });
}

const ENGINE_STRATEGIES: Readonly<Record<RetrievalEngineV3, readonly RetrievalStrategyDefinitionV3[]>> = Object.freeze({
  curated_genre_scene: Object.freeze([
    strategy("curated_genre_scene", "resolve_scope", "scope_resolution", 1, 1, 80),
    strategy("curated_genre_scene", "trusted_scoped_containers", "trusted_containers", 1, 3),
    strategy("curated_genre_scene", "editorial_tracks", "editorial_tracks", 1, 3),
    strategy("curated_genre_scene", "qualified_artist_release_expansion", "qualified_expansion", 2, 4),
    strategy("curated_genre_scene", "multilingual_aliases", "multilingual_aliases", 2, 2),
    strategy("curated_genre_scene", "deficit_queries", "deficit_query", 3, 3),
  ]),
  mood_activity_theme: Object.freeze([
    strategy("mood_activity_theme", "scoped_editorial_descriptions", "descriptive_tracks", 1, 3),
    strategy("mood_activity_theme", "trusted_activity_containers", "trusted_containers", 1, 3),
    strategy("mood_activity_theme", "qualified_artist_expansion", "qualified_expansion", 2, 3),
    strategy("mood_activity_theme", "deficit_queries", "deficit_query", 3, 3),
  ]),
  similarity: Object.freeze([
    strategy("similarity", "track_style_sources", "stylistic_tracks", 1, 3),
    strategy("similarity", "reference_neighborhood", "reference_neighborhood", 1, 3),
    strategy("similarity", "qualified_related_recordings", "qualified_expansion", 2, 4),
    strategy("similarity", "deficit_queries", "deficit_query", 3, 3),
  ]),
  artist_catalogue: Object.freeze([
    strategy("artist_catalogue", "resolve_artist", "artist_identity", 1, 1, 25),
    strategy("artist_catalogue", "enumerate_releases", "release_enumeration", 1, 8, 300),
    strategy("artist_catalogue", "edition_deficits", "deficit_query", 2, 2),
  ]),
  fixed_container: Object.freeze([
    strategy("fixed_container", "enumerate_container", "container_enumeration", 1, 10, 300),
    strategy("fixed_container", "edition_deficits", "deficit_query", 2, 2),
  ]),
  factual_relationship: Object.freeze([
    strategy("factual_relationship", "promoted_graph_assertions", "graph_traversal", 1, 5, 300),
    strategy("factual_relationship", "primary_track_sources", "source_frontier", 1, 5, 200),
    strategy("factual_relationship", "corroboration_deficits", "deficit_query", 2, 4, 160),
  ]),
  exhaustive: Object.freeze([
    strategy("exhaustive", "source_frontier", "source_frontier", 1, 12, 300),
    strategy("exhaustive", "container_enumeration", "container_enumeration", 1, 20, 300),
    strategy("exhaustive", "gap_pass_one", "gap_pass", 2, 1, 200),
    strategy("exhaustive", "gap_pass_two", "gap_pass", 3, 1, 200),
  ]),
});

export function retrievalStrategiesForEnginesV3(
  engines: readonly RetrievalEngineV3[],
): RetrievalStrategyDefinitionV3[] {
  const unique = new Set(engines);
  return ENGINE_ORDER
    .filter((engine) => unique.has(engine))
    .flatMap((engine) => ENGINE_STRATEGIES[engine])
    .map((definition) => ({ ...definition }));
}

export interface RawTrackCandidateV3 {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string | null;
  readonly sourceObservationIds: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CandidateQualificationV3 {
  readonly candidateId: string;
  readonly scope: {
    readonly passed: boolean;
    readonly failedMembershipPredicateIds: readonly string[];
    readonly fit: number;
  };
  readonly hardConstraints: {
    readonly passed: boolean;
    readonly failedConstraintIds: readonly string[];
  };
  readonly evidence: {
    readonly passed: boolean;
    readonly bindingIds: readonly string[];
    readonly strength: number;
    readonly independentProvenanceRoots: number;
    /** Bounded, server-created references used to retain auditable scope evidence. */
    readonly bindings?: readonly EvidenceBindingReferenceV3[];
  };
  readonly version: {
    readonly compatible: boolean;
    readonly confidence: number;
  };
  readonly catalog: {
    readonly storefrontPlayable: boolean;
    readonly appleSongId: string | null;
    readonly recordingFamilyKey: string | null;
    readonly confidence: number;
  };
  /** Ranking signals are consumed only after every eligibility stage passes. */
  readonly rankingSignals: Readonly<Partial<Record<RankingObjectiveV3["dimension"], number>>>;
  /** Lower values are stronger source positions. */
  readonly sourceRank: number;
}

export interface EvidenceBindingReferenceV3 {
  readonly id: string;
  readonly url: string | null;
  readonly provenanceRoot: string;
  readonly strength: number;
  readonly sourceRank: number;
  readonly kind: string;
  /** Exact positive membership predicates explicitly supported by this source binding. */
  readonly predicateIds?: readonly string[];
  /** Compatibility alias used by deterministic E2E fixtures. */
  readonly supportedPredicateIds?: readonly string[];
  /** Typed, fail-closed source policy. Generic candidate metadata cannot substitute for this contract. */
  readonly governance: EvidenceSourceGovernanceV3;
  /**
   * Server-issued proof that this binding is eligible to cross the selection
   * boundary. Governance metadata alone describes how a source may be used;
   * it does not prove that the source was returned by the provider for this
   * exact track or that a promoted assertion belongs to the frozen snapshot.
   */
  readonly eligibilityAttestation?: EvidenceEligibilityAttestationV3;
}

export const PIPELINE_V3_EVIDENCE_ATTESTATION_SCHEMA =
  "genio-pipeline-v3-evidence-attestation/v1" as const;

export type EvidenceEligibilityAttestationV3 =
  | {
    readonly schemaVersion: typeof PIPELINE_V3_EVIDENCE_ATTESTATION_SCHEMA;
    readonly kind: "approved_exact_track_scope_source";
    readonly exactTrackScope: true;
    readonly providerAttested: true;
    readonly sourcePolicyVersion: EvidenceSourceGovernanceV3["policyVersion"];
    readonly sourceUrlHash: string;
  }
  | {
    readonly schemaVersion: typeof PIPELINE_V3_EVIDENCE_ATTESTATION_SCHEMA;
    readonly kind: "frozen_promoted_graph_assertion";
    readonly exactTrackScope: true;
    readonly promoted: true;
    readonly graphSnapshotId: string;
    readonly assertionId: string;
    readonly observationId: string;
  };

export interface EvidenceSourceGovernanceV3 {
  readonly policyVersion: "evidence-source-governance-v3";
  readonly useScope: "run_local" | "durable_corpus";
  readonly approvalState: "approved";
  readonly accessMethod: "hosted_web_search" | "structured_adapter" | "public_api" | "owner_import" | "manual_entry";
  readonly licenseState: "citation_only" | "reusable" | "permission_recorded";
  readonly licenseVersion: string;
  readonly termsVersion: string;
  readonly attribution: string;
  readonly cachePolicy: "excerpt_only" | "full_document_permitted";
  readonly retentionPolicy: "ninety_days" | "durable_public_corpus" | "license_term";
  readonly freshnessPolicy: "immutable_revision" | "revalidate_30d" | "revalidate_90d";
  readonly sourceHash: string;
  readonly sourceRevision: string;
}

function sha256EvidenceValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Shared fail-closed governance predicate. This is deliberately duplicated at
 * persistence by database checks for frozen graph assertions; the in-memory
 * predicate prevents unsafe candidates from entering the qualified pool at
 * all.
 */
export function evidenceSourceGovernanceIsApprovedV3(
  governance: EvidenceSourceGovernanceV3 | null | undefined,
): governance is EvidenceSourceGovernanceV3 {
  if (!governance || governance.policyVersion !== "evidence-source-governance-v3"
    || governance.approvalState !== "approved"
    || !nonEmpty(governance.licenseVersion)
    || !nonEmpty(governance.termsVersion)
    || !nonEmpty(governance.attribution)
    || !/^[0-9a-f]{64}$/u.test(governance.sourceHash)
    || !nonEmpty(governance.sourceRevision)) return false;
  return governance.useScope === "durable_corpus"
    ? governance.licenseState !== "citation_only"
      && ["durable_public_corpus", "license_term"].includes(governance.retentionPolicy)
    : governance.retentionPolicy === "ninety_days";
}

export function publicTrackScopeAttestationV3(
  sourceUrl: string,
): Extract<EvidenceEligibilityAttestationV3, { kind: "approved_exact_track_scope_source" }> {
  const normalizedUrl = assertPublicHttpsUrl(sourceUrl).toString();
  return Object.freeze({
    schemaVersion: PIPELINE_V3_EVIDENCE_ATTESTATION_SCHEMA,
    kind: "approved_exact_track_scope_source",
    exactTrackScope: true,
    providerAttested: true,
    sourcePolicyVersion: "evidence-source-governance-v3",
    sourceUrlHash: sha256EvidenceValue(normalizedUrl),
  });
}

export function evidenceBindingIsAttestedForSelectionV3(
  binding: EvidenceBindingReferenceV3 | null | undefined,
): binding is EvidenceBindingReferenceV3 & { eligibilityAttestation: EvidenceEligibilityAttestationV3 } {
  if (!binding || !nonEmpty(binding.id) || !nonEmpty(binding.provenanceRoot)
    || !evidenceSourceGovernanceIsApprovedV3(binding.governance)
    || !binding.eligibilityAttestation
    || binding.eligibilityAttestation.schemaVersion !== PIPELINE_V3_EVIDENCE_ATTESTATION_SCHEMA) return false;
  let normalizedUrl: string;
  try {
    if (!binding.url) return false;
    normalizedUrl = assertPublicHttpsUrl(binding.url).toString();
  } catch {
    return false;
  }
  const attestation = binding.eligibilityAttestation;
  if (attestation.kind === "approved_exact_track_scope_source") {
    return attestation.exactTrackScope === true
      && attestation.providerAttested === true
      && attestation.sourcePolicyVersion === binding.governance.policyVersion
      && attestation.sourceUrlHash === sha256EvidenceValue(normalizedUrl);
  }
  return binding.kind === "governed_graph"
    && binding.governance.useScope === "durable_corpus"
    && attestation.exactTrackScope === true
    && attestation.promoted === true
    && nonEmpty(attestation.graphSnapshotId)
    && nonEmpty(attestation.assertionId)
    && nonEmpty(attestation.observationId);
}

export function attestedEvidenceBindingsForSelectionV3(
  bindingIds: readonly string[],
  bindings: readonly EvidenceBindingReferenceV3[] | null | undefined,
): Array<EvidenceBindingReferenceV3 & { eligibilityAttestation: EvidenceEligibilityAttestationV3 }> {
  const permittedIds = new Set(bindingIds.filter(nonEmpty));
  const attested = (bindings ?? []).filter(
    (binding): binding is EvidenceBindingReferenceV3 & { eligibilityAttestation: EvidenceEligibilityAttestationV3 } => (
      permittedIds.has(binding.id) && evidenceBindingIsAttestedForSelectionV3(binding)
    ),
  );
  return [...new Map(attested.map((binding) => [binding.id, binding])).values()];
}

export function qualifiedTrackHasAttestedEvidenceV3(track: QualifiedTrackV3): boolean {
  return attestedEvidenceBindingsForSelectionV3(
    track.evidenceBindingIds,
    track.evidenceBindings,
  ).length > 0;
}

export interface QualifiedTrackV3 {
  readonly candidateId: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string | null;
  readonly appleSongId: string;
  readonly recordingFamilyKey: string;
  readonly sourceObservationIds: readonly string[];
  readonly evidenceBindingIds: readonly string[];
  readonly evidenceBindings?: readonly EvidenceBindingReferenceV3[];
  readonly evidenceStrength: number;
  readonly scopeFit: number;
  readonly independentProvenanceRoots: number;
  readonly versionConfidence: number;
  readonly catalogConfidence: number;
  readonly rankingSignals: Readonly<Partial<Record<RankingObjectiveV3["dimension"], number>>>;
  readonly sourceRank: number;
}

export interface DiscoveryRequestV3 {
  readonly runId: string;
  readonly executionMode: RetrievalExecutionModeV3;
  readonly appleWriteAccess: "forbidden";
  /** Frozen at run creation; live adapters prefer this over process config. */
  readonly modelRoute?: PipelineV3ModelRoute;
  readonly plan: SelectionPlanV3;
  readonly engine: RetrievalEngineV3;
  readonly strategy: RetrievalStrategyDefinitionV3;
  readonly strategyRound: number;
  readonly cursor: string | null;
  readonly requestedRawCandidateCount: number;
  readonly alreadyDiscoveredCandidateIds: readonly string[];
  readonly alreadyDiscoveredTracks: readonly {
    readonly artist: string;
    readonly title: string;
  }[];
  readonly qualifiedRecordingFamilyKeys: readonly string[];
  /**
   * Qualified, playable identities from earlier rounds. Read-only discovery
   * adapters may use these as bounded artist/release expansion seeds. Passing
   * the display identity explicitly avoids trying to reverse an ISRC family
   * key and keeps later rounds from re-querying the same opaque IDs.
   */
  readonly qualifiedTrackSeeds: readonly {
    readonly artist: string;
    readonly title: string;
    readonly appleSongId: string;
    readonly recordingFamilyKey: string;
  }[];
}

export interface DiscoveryBatchV3 {
  readonly candidates: readonly RawTrackCandidateV3[];
  readonly nextCursor: string | null;
  readonly exhausted: boolean;
  readonly providerCircuitOpen?: boolean;
  /** Opaque accounting units bounded by the orchestration policy. */
  readonly costUnits?: number;
}

export interface QualificationRequestV3 {
  readonly runId: string;
  readonly executionMode: RetrievalExecutionModeV3;
  readonly appleWriteAccess: "forbidden";
  readonly plan: SelectionPlanV3;
  readonly engine: RetrievalEngineV3;
  readonly strategy: RetrievalStrategyDefinitionV3;
  readonly candidates: readonly RawTrackCandidateV3[];
}

export interface RetrievalAdaptersV3 {
  /** Read-only discovery. Implementations may call web/catalog adapters. */
  discover(request: DiscoveryRequestV3): Promise<DiscoveryBatchV3>;
  /** Read-only evidence and Apple-storefront resolution. */
  qualify(request: QualificationRequestV3): Promise<readonly CandidateQualificationV3[]>;
}

export type CandidateDeficitReasonV3 =
  | "invalid_candidate_shape"
  | "candidate_already_seen"
  | "qualification_missing"
  | "scope_membership_failed"
  | "hard_constraint_failed"
  | "hard_artist_maximum_exceeded"
  | "hard_album_maximum_exceeded"
  | "evidence_binding_missing"
  | "evidence_attestation_missing"
  | "version_incompatible"
  | "storefront_unavailable"
  | "catalog_identity_missing"
  | "catalog_identity_conflict"
  | "duplicate_recording_family"
  | "adapter_response_overflow"
  | "unknown_qualification_result";

export type RetrievalStopReasonV3 =
  | "awaiting_guidance"
  | "qualified_reserve_satisfied"
  | "frontier_exhausted"
  | "deadline_reached"
  | "budget_reached"
  | "provider_circuit_open"
  | "maximum_rounds_reached"
  | "maximum_candidates_reached"
  | "provider_failure"
  | "integrity_failure";

export type RetrievalOutcomeStatusV3 =
  | "awaiting_guidance"
  | "exact_ready"
  | "partial_ready"
  | "no_compatible_tracks"
  | "failed_system"
  | "failed_integrity";

export type RetrievalStrategyStatusV3 =
  | "available"
  | "running"
  | "exhausted"
  | "circuit_open"
  | "provider_error"
  | "integrity_error";

export interface RetrievalStrategyReportV3 {
  readonly id: string;
  readonly engine: RetrievalEngineV3;
  readonly kind: RetrievalStrategyKindV3;
  readonly status: RetrievalStrategyStatusV3;
  readonly rounds: number;
  readonly rawCandidates: number;
  readonly newQualifiedFamilies: number;
  readonly consecutiveZeroQualifiedYieldRounds: number;
  readonly providerFailures: number;
  readonly cursor: string | null;
}

export interface RetrievalStageCountersV3 {
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
}

export interface RetrievalDeficitLedgerV3 extends RetrievalStageCountersV3 {
  readonly requested: number;
  readonly qualifiedPoolGoal: number;
  readonly targetShortfall: number;
  readonly reserveShortfall: number;
  readonly discardedByReason: Readonly<Partial<Record<CandidateDeficitReasonV3, number>>>;
  readonly primaryShortfallReason: RetrievalStopReasonV3 | null;
}

export interface RetrievalOutcomeV3 {
  readonly status: RetrievalOutcomeStatusV3;
  readonly stopReason: RetrievalStopReasonV3;
  readonly requestedTrackCount: number;
  readonly qualifiedTrackCount: number;
  readonly selectedTrackCount: number;
  readonly reserveTrackCount: number;
  readonly shortfall: number;
  readonly requiresPartialPublicationDecision: boolean;
}

export interface RetrievalPublicationBoundaryV3 {
  readonly appleWriteAccess: "forbidden";
  readonly manifestDisposition:
    | "blocked_awaiting_guidance"
    | "exact_draft_ready"
    | "partial_confirmation_required"
    | "no_manifest"
    | "shadow_manifest_only"
    | "blocked_operational_failure";
}

export interface RetrievalResultV3 {
  readonly schemaVersion: typeof PIPELINE_V3_RETRIEVAL_SCHEMA;
  readonly runId: string;
  readonly executionMode: RetrievalExecutionModeV3;
  readonly engines: readonly RetrievalEngineV3[];
  readonly outcome: RetrievalOutcomeV3;
  readonly selected: readonly QualifiedTrackV3[];
  readonly reserve: readonly QualifiedTrackV3[];
  readonly qualifiedPool: readonly QualifiedTrackV3[];
  readonly compatibleAlternatesByRecordingFamily: Readonly<Record<string, readonly QualifiedTrackV3[]>>;
  readonly stages: RetrievalStageCountersV3;
  readonly deficit: RetrievalDeficitLedgerV3;
  readonly strategies: readonly RetrievalStrategyReportV3[];
  readonly integrityEvents: readonly string[];
  readonly publicationBoundary: RetrievalPublicationBoundaryV3;
}

/**
 * Frozen input for the one permitted continuation pass. Only strategy ids
 * approved by the prior partial outcome may run, while already-qualified
 * recordings remain in the pool so the successor result is cumulative.
 */
export interface RetrievalContinuationSeedV3 {
  readonly approvedStrategyIds: readonly string[];
  readonly qualifiedTracks: readonly QualifiedTrackV3[];
  readonly compatibleAlternatesByRecordingFamily: Readonly<Record<string, readonly QualifiedTrackV3[]>>;
  readonly stages: RetrievalStageCountersV3;
  readonly strategies: readonly RetrievalStrategyReportV3[];
}

export interface RetrievalPolicyV3 {
  readonly maximumGlobalRounds: number;
  readonly maximumRawCandidates: number;
  readonly maximumCostUnits: number;
  readonly deadlineAtEpochMs: number | null;
  readonly maximumProviderFailuresPerStrategy: number;
}

export const DEFAULT_RETRIEVAL_POLICY_V3: Readonly<RetrievalPolicyV3> = Object.freeze({
  maximumGlobalRounds: 60,
  maximumRawCandidates: 5_000,
  maximumCostUnits: 100,
  deadlineAtEpochMs: null,
  maximumProviderFailuresPerStrategy: 2,
});

interface MutableStrategyStateV3 {
  definition: RetrievalStrategyDefinitionV3;
  ordinal: number;
  status: RetrievalStrategyStatusV3;
  rounds: number;
  rawCandidates: number;
  newQualifiedFamilies: number;
  consecutiveZeroQualifiedYieldRounds: number;
  providerFailures: number;
  cursor: string | null;
  seenCursors: Set<string>;
}

interface MutableCountersV3 {
  discovered: number;
  validCandidates: number;
  scopeEligible: number;
  hardConstraintEligible: number;
  evidenceEligible: number;
  versionCompatible: number;
  storefrontPlayable: number;
  canonicalUnique: number;
}

interface RecordingFamilyEntryV3 {
  primary: QualifiedTrackV3;
  alternates: QualifiedTrackV3[];
}

interface RawCandidateLedgerEntryV3 {
  candidate: RawTrackCandidateV3;
  candidateIds: Set<string>;
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function boundedFinite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function validCandidate(candidate: RawTrackCandidateV3): boolean {
  return typeof candidate.id === "string" && candidate.id.trim().length > 0
    && typeof candidate.title === "string" && candidate.title.trim().length > 0
    && typeof candidate.artist === "string" && candidate.artist.trim().length > 0
    && (candidate.album === null || typeof candidate.album === "string")
    && Array.isArray(candidate.sourceObservationIds);
}

function rawCandidateIdentityKey(candidate: RawTrackCandidateV3): string {
  return [candidate.artist, candidate.title, candidate.album ?? ""]
    .map(normalizeIdentity)
    .join("\u0000");
}

function mergeMetadataValue(left: unknown, right: unknown): unknown {
  if (Array.isArray(left) && Array.isArray(right)) {
    const seen = new Set<string>();
    return [...left, ...right].filter((value) => {
      const key = JSON.stringify(value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (left && right && typeof left === "object" && typeof right === "object"
    && !Array.isArray(left) && !Array.isArray(right)) {
    const output: Record<string, unknown> = { ...(left as Record<string, unknown>) };
    for (const [key, value] of Object.entries(right as Record<string, unknown>)) {
      output[key] = key in output ? mergeMetadataValue(output[key], value) : value;
    }
    return output;
  }
  return right ?? left;
}

function mergeRawCandidate(
  existing: RawTrackCandidateV3,
  incoming: RawTrackCandidateV3,
): { candidate: RawTrackCandidateV3; improved: boolean } {
  const observations = [...new Set([
    ...existing.sourceObservationIds,
    ...incoming.sourceObservationIds,
  ])];
  const mergedMetadata = mergeMetadataValue(existing.metadata, incoming.metadata) as
    | Readonly<Record<string, unknown>>
    | undefined;
  const previousMetadata = JSON.stringify(existing.metadata ?? null);
  const nextMetadata = JSON.stringify(mergedMetadata ?? null);
  return {
    candidate: {
      ...existing,
      album: existing.album ?? incoming.album,
      sourceObservationIds: observations,
      ...(mergedMetadata ? { metadata: mergedMetadata } : {}),
    },
    improved: observations.length > existing.sourceObservationIds.length
      || previousMetadata !== nextMetadata,
  };
}

function bindingPredicateIds(binding: EvidenceBindingReferenceV3): readonly string[] {
  return binding.predicateIds ?? binding.supportedPredicateIds ?? [];
}

function positiveMembershipPredicateIds(plan: SelectionPlanV3): string[] {
  return evidenceMembershipPredicateIdsV3(plan);
}

function trackMatchesConstraintValue(
  track: QualifiedTrackV3,
  constraint: SelectionConstraint,
): boolean | null {
  const values = new Set(constraint.values.map(normalizeIdentity));
  if (constraint.axis === "artist") return values.has(normalizeIdentity(track.artist));
  if (constraint.axis === "album") return track.album !== null
    && values.has(normalizeIdentity(track.album));
  if (constraint.axis === "track") return values.has(normalizeIdentity(track.title));
  return null;
}

function continuationTrackIntegrityReason(
  track: QualifiedTrackV3,
  plan: SelectionPlanV3,
): CandidateDeficitReasonV3 | null {
  if (!nonEmpty(track.candidateId)
    || !nonEmpty(track.title)
    || !nonEmpty(track.artist)
    || !nonEmpty(track.appleSongId)
    || !nonEmpty(track.recordingFamilyKey)) return "catalog_identity_missing";
  if (!(track.catalogConfidence > 0)) return "storefront_unavailable";
  if (!(track.versionConfidence > 0)) return "version_incompatible";

  const bindings = attestedEvidenceBindingsForSelectionV3(
    track.evidenceBindingIds,
    track.evidenceBindings,
  );
  if (bindings.length === 0) return "evidence_attestation_missing";
  const supportedPredicates = new Set(bindings.flatMap(bindingPredicateIds));
  if (positiveMembershipPredicateIds(plan).some((id) => !supportedPredicates.has(id))) {
    return "scope_membership_failed";
  }

  for (const constraint of plan.hardConstraints) {
    if (constraint.operator === "maximum") continue;
    if (supportedPredicates.has(constraint.id)) continue;
    const matches = trackMatchesConstraintValue(track, constraint);
    if (constraint.operator === "exclude") {
      if (matches === true) return "hard_constraint_failed";
      if (matches === false) continue;
    } else if (constraint.operator === "include" || constraint.operator === "require") {
      if (matches === true) continue;
      return "hard_constraint_failed";
    } else {
      return "hard_constraint_failed";
    }
  }
  return null;
}

function mergeQualifiedTrack(
  existing: QualifiedTrackV3,
  incoming: QualifiedTrackV3,
): { track: QualifiedTrackV3; improved: boolean } {
  const observations = [...new Set([
    ...existing.sourceObservationIds,
    ...incoming.sourceObservationIds,
  ])];
  const bindings = [...new Map([
    ...(existing.evidenceBindings ?? []),
    ...(incoming.evidenceBindings ?? []),
  ].map((binding) => [binding.id, binding])).values()];
  const bindingIds = [...new Set([
    ...existing.evidenceBindingIds,
    ...incoming.evidenceBindingIds,
    ...bindings.map(({ id }) => id),
  ])];
  const rankingSignals = { ...existing.rankingSignals };
  for (const [dimension, value] of Object.entries(incoming.rankingSignals)) {
    const key = dimension as RankingObjectiveV3["dimension"];
    rankingSignals[key] = Math.max(rankingSignals[key] ?? 0, value ?? 0);
  }
  const provenanceRoots = new Set(bindings.map(({ provenanceRoot }) => provenanceRoot)).size;
  const track: QualifiedTrackV3 = {
    ...existing,
    album: existing.album ?? incoming.album,
    sourceObservationIds: observations,
    evidenceBindingIds: bindingIds,
    evidenceBindings: bindings,
    evidenceStrength: Math.max(existing.evidenceStrength, incoming.evidenceStrength),
    scopeFit: Math.max(existing.scopeFit, incoming.scopeFit),
    independentProvenanceRoots: Math.max(
      existing.independentProvenanceRoots,
      incoming.independentProvenanceRoots,
      provenanceRoots,
    ),
    versionConfidence: Math.max(existing.versionConfidence, incoming.versionConfidence),
    catalogConfidence: Math.max(existing.catalogConfidence, incoming.catalogConfidence),
    rankingSignals,
    sourceRank: Math.min(existing.sourceRank, incoming.sourceRank),
  };
  return {
    track,
    improved: observations.length > existing.sourceObservationIds.length
      || bindingIds.length > existing.evidenceBindingIds.length
      || track.evidenceStrength > existing.evidenceStrength
      || track.scopeFit > existing.scopeFit
      || track.independentProvenanceRoots > existing.independentProvenanceRoots
      || track.versionConfidence > existing.versionConfidence
      || track.catalogConfidence > existing.catalogConfidence
      || track.sourceRank < existing.sourceRank
      || Object.entries(track.rankingSignals).some(([dimension, value]) => (
        (value ?? 0) > (existing.rankingSignals[dimension as RankingObjectiveV3["dimension"]] ?? 0)
      )),
  };
}

function addQualifiedToFamily(
  families: Map<string, RecordingFamilyEntryV3>,
  qualified: QualifiedTrackV3,
  objectives: readonly RankingObjectiveV3[],
): { newFamily: boolean; meaningfulProgress: boolean } {
  const family = families.get(qualified.recordingFamilyKey);
  if (!family) {
    families.set(qualified.recordingFamilyKey, { primary: qualified, alternates: [] });
    return { newFamily: true, meaningfulProgress: true };
  }
  const variants = [family.primary, ...family.alternates];
  const existingIndex = variants.findIndex(({ appleSongId }) => appleSongId === qualified.appleSongId);
  let meaningfulProgress = false;
  if (existingIndex >= 0) {
    const merged = mergeQualifiedTrack(variants[existingIndex]!, qualified);
    variants[existingIndex] = merged.track;
    meaningfulProgress = merged.improved;
  } else {
    variants.push(qualified);
    meaningfulProgress = true;
  }
  variants.sort((left, right) => compareQualified(left, right, objectives));
  family.primary = variants[0]!;
  family.alternates = variants.slice(1);
  return { newFamily: false, meaningfulProgress };
}

function incrementReason(
  reasons: Partial<Record<CandidateDeficitReasonV3, number>>,
  reason: CandidateDeficitReasonV3,
): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

function weightedObjectiveScore(
  track: QualifiedTrackV3,
  objectives: readonly RankingObjectiveV3[],
): number {
  return objectives.reduce((total, objective) => {
    const raw = boundedFinite(track.rankingSignals[objective.dimension] ?? 0);
    const directed = objective.direction === "minimize" ? 1 - raw : raw;
    return total + directed * Math.max(0, objective.weight);
  }, 0);
}

function compareQualified(
  left: QualifiedTrackV3,
  right: QualifiedTrackV3,
  objectives: readonly RankingObjectiveV3[],
): number {
  return right.evidenceStrength - left.evidenceStrength
    || right.scopeFit - left.scopeFit
    || right.independentProvenanceRoots - left.independentProvenanceRoots
    || weightedObjectiveScore(right, objectives) - weightedObjectiveScore(left, objectives)
    || left.sourceRank - right.sourceRank
    || right.catalogConfidence - left.catalogConfidence
    || right.versionConfidence - left.versionConfidence
    || left.candidateId.localeCompare(right.candidateId);
}

function normalizeIdentity(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function maximumConstraint(
  constraints: readonly SelectionConstraint[],
  axis: SelectionConstraint["axis"],
  kind: SelectionConstraint["kind"],
): number | null {
  const limits = constraints
    .filter((constraint) => constraint.kind === kind
      && constraint.axis === axis
      && constraint.operator === "maximum")
    .flatMap((constraint) => constraint.values)
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value >= 1);
  return limits.length > 0 ? Math.min(...limits) : null;
}

function applyHardAggregateConstraints(
  tracks: readonly QualifiedTrackV3[],
  constraints: readonly SelectionConstraint[],
): {
  eligible: QualifiedTrackV3[];
  rejected: {
    track: QualifiedTrackV3;
    reasons: ("hard_artist_maximum_exceeded" | "hard_album_maximum_exceeded")[];
  }[];
} {
  const maximumPerArtist = maximumConstraint(constraints, "artist", "hard");
  const maximumPerAlbum = maximumConstraint(constraints, "album", "hard");
  if (maximumPerArtist === null && maximumPerAlbum === null) return { eligible: [...tracks], rejected: [] };
  const artistCounts = new Map<string, number>();
  const albumCounts = new Map<string, number>();
  const eligible: QualifiedTrackV3[] = [];
  const rejected: {
    track: QualifiedTrackV3;
    reasons: ("hard_artist_maximum_exceeded" | "hard_album_maximum_exceeded")[];
  }[] = [];
  for (const track of tracks) {
    const artist = normalizeIdentity(track.artist);
    const album = normalizedAlbum(track);
    const reasons: ("hard_artist_maximum_exceeded" | "hard_album_maximum_exceeded")[] = [];
    if (maximumPerArtist !== null && (artistCounts.get(artist) ?? 0) >= maximumPerArtist) {
      reasons.push("hard_artist_maximum_exceeded");
    }
    if (maximumPerAlbum !== null && album && (albumCounts.get(album) ?? 0) >= maximumPerAlbum) {
      reasons.push("hard_album_maximum_exceeded");
    }
    if (reasons.length > 0) {
      rejected.push({ track, reasons });
      continue;
    }
    artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
    if (album) albumCounts.set(album, (albumCounts.get(album) ?? 0) + 1);
    eligible.push(track);
  }
  return { eligible, rejected };
}

function normalizedAlbum(track: QualifiedTrackV3): string {
  return track.album ? normalizeIdentity(`${track.artist}\u0000${track.album}`) : "";
}

function selectBroadCurated(
  tracks: readonly QualifiedTrackV3[],
  target: number,
  plan: SelectionPlanV3,
): QualifiedTrackV3[] {
  const selected: QualifiedTrackV3[] = [];
  const selectedIds = new Set<string>();
  const artistCounts = new Map<string, number>();
  const albumCounts = new Map<string, number>();
  const explicitSoftArtistMaximum = maximumConstraint(plan.softPreferences, "artist", "soft");
  let maximumPerArtist = explicitSoftArtistMaximum ?? plan.diversityGoals.maximumTracksPerArtist;
  let maximumPerAlbum = plan.diversityGoals.maximumTracksPerAlbum;

  const canSelect = (track: QualifiedTrackV3): boolean => {
    const artist = normalizeIdentity(track.artist);
    const album = normalizedAlbum(track);
    return (maximumPerArtist === null || (artistCounts.get(artist) ?? 0) < maximumPerArtist)
      && (maximumPerAlbum === null || !album || (albumCounts.get(album) ?? 0) < maximumPerAlbum);
  };
  const add = (track: QualifiedTrackV3): void => {
    selected.push(track);
    selectedIds.add(track.candidateId);
    const artist = normalizeIdentity(track.artist);
    const album = normalizedAlbum(track);
    artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
    if (album) albumCounts.set(album, (albumCounts.get(album) ?? 0) + 1);
  };
  const fill = (predicate: (track: QualifiedTrackV3) => boolean = () => true): void => {
    for (const track of tracks) {
      if (selected.length >= target) break;
      if (selectedIds.has(track.candidateId) || !predicate(track) || !canSelect(track)) continue;
      add(track);
    }
  };

  const minimumArtists = Math.max(0, plan.diversityGoals.minimumDistinctArtists ?? 0);
  const minimumAlbums = Math.max(0, plan.diversityGoals.minimumDistinctAlbums ?? 0);
  fill((track) => !artistCounts.has(normalizeIdentity(track.artist)) && artistCounts.size < minimumArtists);
  fill((track) => {
    const album = normalizedAlbum(track);
    return Boolean(album) && !albumCounts.has(album) && albumCounts.size < minimumAlbums;
  });
  fill();

  // Soft concentration goals relax only in the immutable recorded order.
  // Hard maximum constraints were already applied to the eligible pool and
  // are therefore never relaxed here.
  for (const goal of plan.softGoalRelaxationOrder) {
    if (selected.length >= target) break;
    if (goal === "album_concentration") maximumPerAlbum = null;
    if (goal === "artist_concentration") maximumPerArtist = null;
    fill();
  }
  // Unknown or legacy relaxation labels cannot turn a soft preference into a
  // hard count shortfall. Once the recorded order is exhausted, exact fill
  // wins over remaining soft preferences.
  if (selected.length < target) {
    maximumPerArtist = null;
    maximumPerAlbum = null;
    fill();
  }
  return selected;
}

function sequenceBroadCurated(
  tracks: readonly QualifiedTrackV3[],
  ordering: SelectionPlanV3["orderingPolicy"],
): QualifiedTrackV3[] {
  const remaining = [...tracks];
  const output: QualifiedTrackV3[] = [];
  while (remaining.length > 0) {
    const previous = output.at(-1);
    let index = remaining.findIndex((candidate) => !previous || (
      (!ordering.avoidAdjacentSameArtist
        || normalizeIdentity(candidate.artist) !== normalizeIdentity(previous.artist))
      && (!ordering.avoidAdjacentSameAlbum
        || !candidate.album
        || !previous.album
        || normalizeIdentity(candidate.album) !== normalizeIdentity(previous.album))
    ));
    if (index < 0 && ordering.avoidAdjacentSameArtist) {
      index = remaining.findIndex((candidate) => !previous
        || normalizeIdentity(candidate.artist) !== normalizeIdentity(previous.artist));
    }
    if (index < 0) index = 0;
    output.push(remaining.splice(index, 1)[0]!);
  }
  return output;
}

function shouldSequenceBroadCurated(
  engines: readonly RetrievalEngineV3[],
  plan: SelectionPlanV3,
): boolean {
  return plan.scopeKind === "broad_curated"
    && (plan.orderingPolicy.avoidAdjacentSameArtist || plan.orderingPolicy.avoidAdjacentSameAlbum)
    && engines.some((engine) => [
    "curated_genre_scene", "mood_activity_theme", "similarity",
  ].includes(engine))
    && !engines.some((engine) => [
      "artist_catalogue", "fixed_container", "factual_relationship", "exhaustive",
    ].includes(engine));
}

function stageObservations(counters: MutableCountersV3): StageYieldObservationV3[] {
  return [
    { stage: "discovered", entered: counters.discovered, passed: counters.validCandidates },
    { stage: "scope_eligible", entered: counters.validCandidates, passed: counters.hardConstraintEligible },
    { stage: "evidence_eligible", entered: counters.hardConstraintEligible, passed: counters.evidenceEligible },
    { stage: "version_compatible", entered: counters.evidenceEligible, passed: counters.versionCompatible },
    { stage: "playable", entered: counters.versionCompatible, passed: counters.storefrontPlayable },
    { stage: "canonical_unique", entered: counters.storefrontPlayable, passed: counters.canonicalUnique },
    { stage: "quota_eligible", entered: counters.canonicalUnique, passed: counters.canonicalUnique },
  ];
}

function nextStrategy(states: readonly MutableStrategyStateV3[]): MutableStrategyStateV3 | null {
  const available = states.filter((state) => state.status === "available"
    && state.rounds < state.definition.maximumRounds
    && state.consecutiveZeroQualifiedYieldRounds < state.definition.zeroQualifiedYieldLimit);
  available.sort((left, right) => left.definition.tier - right.definition.tier
    || left.rounds - right.rounds
    || left.ordinal - right.ordinal);
  return available[0] ?? null;
}

function strategyReport(state: MutableStrategyStateV3): RetrievalStrategyReportV3 {
  return {
    id: state.definition.id,
    engine: state.definition.engine,
    kind: state.definition.kind,
    status: state.status,
    rounds: state.rounds,
    rawCandidates: state.rawCandidates,
    newQualifiedFamilies: state.newQualifiedFamilies,
    consecutiveZeroQualifiedYieldRounds: state.consecutiveZeroQualifiedYieldRounds,
    providerFailures: state.providerFailures,
    cursor: state.cursor,
  };
}

function finalStopReason(input: {
  explicit: RetrievalStopReasonV3 | null;
  strategies: readonly MutableStrategyStateV3[];
  providerFailureCount: number;
  integrityFailureCount: number;
  qualifiedCount: number;
}): RetrievalStopReasonV3 {
  if (input.explicit) return input.explicit;
  // Scope resolution and gap-pass definitions are orchestration markers in
  // the live adapter. They deliberately return an exhausted zero-work page
  // and therefore cannot establish that a provider-backed frontier was
  // successfully searched. Ignore those markers when deciding whether a
  // zero-result run was actually caused by provider loss.
  const materialStrategies = input.strategies.filter((state) => !(
    (state.definition.kind === "scope_resolution" || state.definition.kind === "gap_pass")
    && state.status === "exhausted"
    && state.rounds > 0
    && state.rawCandidates === 0
    && state.providerFailures === 0
  ));
  if (input.qualifiedCount === 0 && input.providerFailureCount > 0
    && materialStrategies.length > 0
    && materialStrategies.every((state) => state.status === "provider_error" || state.status === "circuit_open")) {
    return "provider_failure";
  }
  if (input.qualifiedCount === 0 && input.integrityFailureCount > 0
    && materialStrategies.length > 0
    && materialStrategies.every((state) => state.status === "integrity_error" || state.status === "exhausted")) {
    return "integrity_failure";
  }
  if (materialStrategies.length > 0 && materialStrategies.every((state) => state.status === "circuit_open")) {
    return "provider_circuit_open";
  }
  return "frontier_exhausted";
}

function publicationBoundary(
  mode: RetrievalExecutionModeV3,
  status: RetrievalOutcomeStatusV3,
): RetrievalPublicationBoundaryV3 {
  if (status === "awaiting_guidance") {
    return { appleWriteAccess: "forbidden", manifestDisposition: "blocked_awaiting_guidance" };
  }
  if (status === "failed_system" || status === "failed_integrity") {
    return { appleWriteAccess: "forbidden", manifestDisposition: "blocked_operational_failure" };
  }
  if (status === "no_compatible_tracks") {
    return { appleWriteAccess: "forbidden", manifestDisposition: "no_manifest" };
  }
  if (mode === "shadow") return { appleWriteAccess: "forbidden", manifestDisposition: "shadow_manifest_only" };
  if (status === "exact_ready") return { appleWriteAccess: "forbidden", manifestDisposition: "exact_draft_ready" };
  if (status === "partial_ready") {
    return { appleWriteAccess: "forbidden", manifestDisposition: "partial_confirmation_required" };
  }
  return { appleWriteAccess: "forbidden", manifestDisposition: "no_manifest" };
}

function emptyResult(input: {
  runId: string;
  mode: RetrievalExecutionModeV3;
  engines: readonly RetrievalEngineV3[];
  requested: number;
  reserveGoal: number;
  status: RetrievalOutcomeStatusV3;
  stopReason: RetrievalStopReasonV3;
  strategies: readonly RetrievalStrategyReportV3[];
  integrityEvents?: readonly string[];
}): RetrievalResultV3 {
  const stages: RetrievalStageCountersV3 = {
    discovered: 0,
    validCandidates: 0,
    scopeEligible: 0,
    hardConstraintEligible: 0,
    evidenceEligible: 0,
    versionCompatible: 0,
    storefrontPlayable: 0,
    canonicalUnique: 0,
    selected: 0,
    reserve: 0,
  };
  return {
    schemaVersion: PIPELINE_V3_RETRIEVAL_SCHEMA,
    runId: input.runId,
    executionMode: input.mode,
    engines: input.engines,
    outcome: {
      status: input.status,
      stopReason: input.stopReason,
      requestedTrackCount: input.requested,
      qualifiedTrackCount: 0,
      selectedTrackCount: 0,
      reserveTrackCount: 0,
      shortfall: input.requested,
      requiresPartialPublicationDecision: false,
    },
    selected: [],
    reserve: [],
    qualifiedPool: [],
    compatibleAlternatesByRecordingFamily: {},
    stages,
    deficit: {
      ...stages,
      requested: input.requested,
      qualifiedPoolGoal: input.requested + input.reserveGoal,
      targetShortfall: input.requested,
      reserveShortfall: input.reserveGoal,
      discardedByReason: {},
      primaryShortfallReason: input.stopReason,
    },
    strategies: input.strategies,
    integrityEvents: input.integrityEvents ?? [],
    publicationBoundary: publicationBoundary(input.mode, input.status),
  };
}

function validatePolicy(input: Partial<RetrievalPolicyV3>): RetrievalPolicyV3 {
  const merged = { ...DEFAULT_RETRIEVAL_POLICY_V3, ...input };
  return {
    maximumGlobalRounds: boundedInteger(merged.maximumGlobalRounds, "maximumGlobalRounds", 1, 1_000),
    maximumRawCandidates: boundedInteger(merged.maximumRawCandidates, "maximumRawCandidates", 1, 100_000),
    maximumCostUnits: Number.isFinite(merged.maximumCostUnits) && merged.maximumCostUnits >= 0
      ? merged.maximumCostUnits
      : (() => { throw new Error("maximumCostUnits must be a non-negative finite number"); })(),
    deadlineAtEpochMs: merged.deadlineAtEpochMs === null
      ? null
      : Number.isFinite(merged.deadlineAtEpochMs)
        ? merged.deadlineAtEpochMs
        : (() => { throw new Error("deadlineAtEpochMs must be null or a finite epoch"); })(),
    maximumProviderFailuresPerStrategy: boundedInteger(
      merged.maximumProviderFailuresPerStrategy,
      "maximumProviderFailuresPerStrategy",
      1,
      10,
    ),
  };
}

export async function executeRetrievalV3(input: {
  runId: string;
  plan: SelectionPlanV3;
  adapters: RetrievalAdaptersV3;
  executionMode?: RetrievalExecutionModeV3;
  routingHints?: RetrievalRoutingHintsV3;
  policy?: Partial<RetrievalPolicyV3>;
  continuation?: RetrievalContinuationSeedV3;
  modelRoute?: PipelineV3ModelRoute;
  now?: () => number;
}): Promise<RetrievalResultV3> {
  const requested = boundedInteger(input.plan.requestedTrackCount, "requestedTrackCount", 1, 300);
  const mode = input.executionMode ?? "active";
  const policy = validatePolicy(input.policy ?? {});
  const now = input.now ?? Date.now;
  const engines = routeRetrievalEnginesV3(input.plan, input.routingHints);
  const reserveGoal = Math.max(10, Math.ceil(requested * 0.2));
  const continuationStrategies = new Map(
    (input.continuation?.strategies ?? []).map((strategy) => [strategy.id, strategy]),
  );
  const approvedContinuationStrategies = input.continuation
    ? new Set(input.continuation.approvedStrategyIds)
    : null;
  const definitions = retrievalStrategiesForEnginesV3(engines);
  if (approvedContinuationStrategies) {
    const known = new Set(definitions.map(({ id }) => id));
    if (approvedContinuationStrategies.size === 0
      || [...approvedContinuationStrategies].some((id) => !known.has(id))) {
      throw new Error("Continuation contains an unknown or empty approved strategy set");
    }
  }
  const states: MutableStrategyStateV3[] = definitions.map((definition, ordinal) => {
    const prior = continuationStrategies.get(definition.id);
    const approved = approvedContinuationStrategies?.has(definition.id) ?? false;
    return {
      definition,
      ordinal,
      status: approved
        ? "available"
        : approvedContinuationStrategies
          ? (prior?.status === "available" || prior?.status === "running" ? "exhausted" : prior?.status ?? "exhausted")
          : prior?.status ?? "available",
      rounds: prior?.rounds ?? 0,
      rawCandidates: prior?.rawCandidates ?? 0,
      newQualifiedFamilies: prior?.newQualifiedFamilies ?? 0,
      consecutiveZeroQualifiedYieldRounds: prior?.consecutiveZeroQualifiedYieldRounds ?? 0,
      providerFailures: prior?.providerFailures ?? 0,
      cursor: prior?.cursor ?? null,
      seenCursors: new Set<string>(prior?.cursor ? [prior.cursor] : []),
    };
  });

  if (!input.plan.confirmed) {
    return emptyResult({
      runId: input.runId,
      mode,
      engines,
      requested,
      reserveGoal,
      status: "awaiting_guidance",
      stopReason: "awaiting_guidance",
      strategies: states.map(strategyReport),
    });
  }

  const discardedByReason: Partial<Record<CandidateDeficitReasonV3, number>> = {};
  const integrityEvents: string[] = [];
  const appleIdToFamily = new Map<string, string>();
  const rawSeedTracks = input.continuation?.qualifiedTracks ?? [];
  const seedTracks = rawSeedTracks.flatMap((track) => {
    const integrityReason = continuationTrackIntegrityReason(track, input.plan);
    if (integrityReason) {
      incrementReason(discardedByReason, integrityReason);
      integrityEvents.push(`continuation_seed_rejected:${integrityReason}:${track.candidateId}`);
      return [];
    }
    const existingFamily = appleIdToFamily.get(track.appleSongId);
    if (existingFamily && existingFamily !== track.recordingFamilyKey) {
      incrementReason(discardedByReason, "catalog_identity_conflict");
      integrityEvents.push(`continuation_seed_rejected:catalog_identity_conflict:${track.candidateId}`);
      return [];
    }
    appleIdToFamily.set(track.appleSongId, track.recordingFamilyKey);
    const bindings = attestedEvidenceBindingsForSelectionV3(track.evidenceBindingIds, track.evidenceBindings);
    return [{
      ...track,
      evidenceBindingIds: bindings.map(({ id }) => id),
      evidenceBindings: bindings.map((binding) => ({ ...binding })),
    }];
  });
  const seenCandidateIds = new Set<string>(seedTracks.map(({ candidateId }) => candidateId));
  const seenCandidateTracks = new Map<string, { artist: string; title: string }>();
  const rawCandidateLedger = new Map<string, RawCandidateLedgerEntryV3>();
  const families = new Map<string, RecordingFamilyEntryV3>();
  for (const track of seedTracks) {
    seenCandidateTracks.set(track.candidateId, { artist: track.artist, title: track.title });
    appleIdToFamily.set(track.appleSongId, track.recordingFamilyKey);
    const alternates = input.continuation?.compatibleAlternatesByRecordingFamily[track.recordingFamilyKey]
      ?.filter((alternate) => alternate.appleSongId !== track.appleSongId
        && continuationTrackIntegrityReason(alternate, input.plan) === null)
      .map((alternate) => {
        const bindings = attestedEvidenceBindingsForSelectionV3(
          alternate.evidenceBindingIds,
          alternate.evidenceBindings,
        );
        return {
          ...alternate,
          evidenceBindingIds: bindings.map(({ id }) => id),
          evidenceBindings: bindings.map((binding) => ({ ...binding })),
        };
      }) ?? [];
    addQualifiedToFamily(families, { ...track }, input.plan.rankingObjectives);
    for (const alternate of alternates) {
      const existingFamily = appleIdToFamily.get(alternate.appleSongId);
      if (existingFamily && existingFamily !== alternate.recordingFamilyKey) {
        incrementReason(discardedByReason, "catalog_identity_conflict");
        integrityEvents.push(`continuation_alternate_rejected:catalog_identity_conflict:${alternate.candidateId}`);
        continue;
      }
      appleIdToFamily.set(alternate.appleSongId, alternate.recordingFamilyKey);
      addQualifiedToFamily(families, alternate, input.plan.rankingObjectives);
    }
  }
  const priorStages = input.continuation?.stages;
  const counters: MutableCountersV3 = {
    discovered: priorStages?.discovered ?? 0,
    validCandidates: priorStages?.validCandidates ?? 0,
    scopeEligible: priorStages?.scopeEligible ?? 0,
    hardConstraintEligible: priorStages?.hardConstraintEligible ?? 0,
    evidenceEligible: priorStages?.evidenceEligible ?? 0,
    versionCompatible: priorStages?.versionCompatible ?? 0,
    storefrontPlayable: priorStages?.storefrontPlayable ?? 0,
    canonicalUnique: Math.max(priorStages?.canonicalUnique ?? 0, families.size),
  };
  let globalRounds = 0;
  let totalCostUnits = 0;
  let stopReason: RetrievalStopReasonV3 | null = null;
  let providerFailureCount = 0;
  let integrityFailureCount = 0;

  while (true) {
    const currentRankedFamilies = [...families.values()]
      .map(({ primary }) => primary)
      .sort((left, right) => compareQualified(left, right, input.plan.rankingObjectives));
    const currentHardEligible = applyHardAggregateConstraints(
      currentRankedFamilies,
      input.plan.hardConstraints,
    ).eligible.length;
    const fill = adaptiveFillPlanV3({
      target: requested,
      qualified: currentHardEligible,
      stageObservations: stageObservations(counters),
      reserve: reserveGoal,
      maximumRawDiscoveryGoal: policy.maximumRawCandidates,
    });
    if (fill.qualifiedPoolDeficit === 0) {
      stopReason = "qualified_reserve_satisfied";
      break;
    }
    if (policy.deadlineAtEpochMs !== null && now() >= policy.deadlineAtEpochMs) {
      stopReason = "deadline_reached";
      break;
    }
    if (totalCostUnits >= policy.maximumCostUnits) {
      stopReason = "budget_reached";
      break;
    }
    if (globalRounds >= policy.maximumGlobalRounds) {
      stopReason = "maximum_rounds_reached";
      break;
    }
    if (seenCandidateIds.size >= policy.maximumRawCandidates) {
      stopReason = "maximum_candidates_reached";
      break;
    }
    const state = nextStrategy(states);
    if (!state) break;

    state.status = "running";
    state.rounds += 1;
    globalRounds += 1;
    const remainingCapacity = policy.maximumRawCandidates - seenCandidateIds.size;
    const requestedRawCandidateCount = Math.max(1, Math.min(
      fill.rawDiscoveryGoal,
      state.definition.maximumBatchSize,
      remainingCapacity,
    ));
    const request: DiscoveryRequestV3 = {
      runId: input.runId,
      executionMode: mode,
      appleWriteAccess: "forbidden",
      ...(input.modelRoute ? { modelRoute: input.modelRoute } : {}),
      plan: input.plan,
      engine: state.definition.engine,
      strategy: state.definition,
      strategyRound: state.rounds,
      cursor: state.cursor,
      requestedRawCandidateCount,
      alreadyDiscoveredCandidateIds: [...seenCandidateIds],
      alreadyDiscoveredTracks: [...seenCandidateTracks.values()],
      qualifiedRecordingFamilyKeys: [...families.keys()],
      qualifiedTrackSeeds: [...families.values()].map(({ primary }) => ({
        artist: primary.artist,
        title: primary.title,
        appleSongId: primary.appleSongId,
        recordingFamilyKey: primary.recordingFamilyKey,
      })),
    };

    let batch: DiscoveryBatchV3;
    try {
      batch = await input.adapters.discover(request);
    } catch (error) {
      providerFailureCount += 1;
      state.providerFailures += 1;
      integrityEvents.push(`discover:${state.definition.id}:${error instanceof Error ? error.message : "unknown_error"}`);
      state.status = state.providerFailures >= policy.maximumProviderFailuresPerStrategy
        ? "provider_error"
        : "available";
      continue;
    }

    const costUnits = batch.costUnits ?? 0;
    if (!Number.isFinite(costUnits) || costUnits < 0) {
      integrityFailureCount += 1;
      integrityEvents.push(`invalid_cost_units:${state.definition.id}`);
    } else {
      totalCostUnits += costUnits;
    }
    const boundedBatch = batch.candidates.slice(0, requestedRawCandidateCount);
    const overflow = batch.candidates.length - boundedBatch.length;
    for (let index = 0; index < overflow; index += 1) incrementReason(discardedByReason, "adapter_response_overflow");
    if (overflow > 0) integrityEvents.push(`response_overflow:${state.definition.id}:${overflow}`);
    counters.discovered += batch.candidates.length;
    state.rawCandidates += batch.candidates.length;

    const candidates: RawTrackCandidateV3[] = [];
    let roundCandidateEvidenceProgress = 0;
    for (const candidate of boundedBatch) {
      if (!validCandidate(candidate)) {
        incrementReason(discardedByReason, "invalid_candidate_shape");
        continue;
      }
      const candidateIdWasSeen = seenCandidateIds.has(candidate.id);
      if (!candidateIdWasSeen) seenCandidateIds.add(candidate.id);
      const identityKey = rawCandidateIdentityKey(candidate);
      const existing = rawCandidateLedger.get(identityKey);
      if (existing) {
        existing.candidateIds.add(candidate.id);
        const merged = mergeRawCandidate(existing.candidate, candidate);
        existing.candidate = merged.candidate;
        if (!merged.improved) {
          incrementReason(discardedByReason, "candidate_already_seen");
          continue;
        }
        // A later source may strengthen a candidate that did not previously
        // clear the evidence floor. Re-qualify the cumulative candidate and
        // keep the strategy alive for this meaningful frontier advance even
        // when it has not yet produced a new recording family.
        roundCandidateEvidenceProgress += 1;
        seenCandidateTracks.set(existing.candidate.id, {
          artist: existing.candidate.artist.trim(),
          title: existing.candidate.title.trim(),
        });
        // Stage counters represent validation attempts, whereas the separate
        // candidate/family ledgers retain unique identities. Counting the
        // cumulative re-qualification attempt keeps each adaptive-yield stage
        // denominator monotonic without inflating unique-family totals.
        counters.validCandidates += 1;
        candidates.push(existing.candidate);
        continue;
      }
      if (candidateIdWasSeen) {
        incrementReason(discardedByReason, "candidate_already_seen");
        continue;
      }
      rawCandidateLedger.set(identityKey, {
        candidate: { ...candidate, sourceObservationIds: [...new Set(candidate.sourceObservationIds)] },
        candidateIds: new Set([candidate.id]),
      });
      seenCandidateTracks.set(candidate.id, {
        artist: candidate.artist.trim(),
        title: candidate.title.trim(),
      });
      counters.validCandidates += 1;
      candidates.push(candidate);
    }

    let qualifications: readonly CandidateQualificationV3[];
    try {
      qualifications = candidates.length === 0
        ? []
        : await input.adapters.qualify({
          runId: input.runId,
          executionMode: mode,
          appleWriteAccess: "forbidden",
          plan: input.plan,
          engine: state.definition.engine,
          strategy: state.definition,
          candidates,
        });
    } catch (error) {
      providerFailureCount += 1;
      state.providerFailures += 1;
      integrityEvents.push(`qualify:${state.definition.id}:${error instanceof Error ? error.message : "unknown_error"}`);
      for (let index = 0; index < candidates.length; index += 1) {
        incrementReason(discardedByReason, "qualification_missing");
      }
      state.status = state.providerFailures >= policy.maximumProviderFailuresPerStrategy
        ? "provider_error"
        : "available";
      continue;
    }

    const candidateIds = new Set(candidates.map(({ id }) => id));
    const byCandidate = new Map<string, CandidateQualificationV3>();
    for (const qualification of qualifications) {
      if (!candidateIds.has(qualification.candidateId)) {
        incrementReason(discardedByReason, "unknown_qualification_result");
        integrityEvents.push(`unknown_qualification:${state.definition.id}:${qualification.candidateId}`);
        integrityFailureCount += 1;
        continue;
      }
      if (byCandidate.has(qualification.candidateId)) {
        integrityEvents.push(`duplicate_qualification:${state.definition.id}:${qualification.candidateId}`);
        integrityFailureCount += 1;
        continue;
      }
      byCandidate.set(qualification.candidateId, qualification);
    }

    let newFamilies = 0;
    let meaningfulProgress = roundCandidateEvidenceProgress;
    for (const candidate of candidates) {
      const qualification = byCandidate.get(candidate.id);
      if (!qualification) {
        incrementReason(discardedByReason, "qualification_missing");
        continue;
      }
      if (!qualification.scope.passed) {
        incrementReason(discardedByReason, "scope_membership_failed");
        continue;
      }
      counters.scopeEligible += 1;
      if (!qualification.hardConstraints.passed) {
        incrementReason(discardedByReason, "hard_constraint_failed");
        continue;
      }
      counters.hardConstraintEligible += 1;
      if (!qualification.evidence.passed || qualification.evidence.bindingIds.length === 0) {
        incrementReason(discardedByReason, "evidence_binding_missing");
        continue;
      }
      const attestedBindings = attestedEvidenceBindingsForSelectionV3(
        qualification.evidence.bindingIds,
        qualification.evidence.bindings,
      );
      if (attestedBindings.length === 0) {
        incrementReason(discardedByReason, "evidence_attestation_missing");
        integrityEvents.push(`evidence_attestation_missing:${state.definition.id}:${candidate.id}`);
        continue;
      }
      counters.evidenceEligible += 1;
      if (!qualification.version.compatible) {
        incrementReason(discardedByReason, "version_incompatible");
        continue;
      }
      counters.versionCompatible += 1;
      if (!qualification.catalog.storefrontPlayable) {
        incrementReason(discardedByReason, "storefront_unavailable");
        continue;
      }
      if (!qualification.catalog.appleSongId || !qualification.catalog.recordingFamilyKey) {
        incrementReason(discardedByReason, "catalog_identity_missing");
        continue;
      }
      counters.storefrontPlayable += 1;
      const existingFamilyForAppleId = appleIdToFamily.get(qualification.catalog.appleSongId);
      if (existingFamilyForAppleId && existingFamilyForAppleId !== qualification.catalog.recordingFamilyKey) {
        incrementReason(discardedByReason, "catalog_identity_conflict");
        integrityEvents.push(`catalog_identity_conflict:${qualification.catalog.appleSongId}`);
        integrityFailureCount += 1;
        continue;
      }

      const qualified: QualifiedTrackV3 = {
        candidateId: candidate.id,
        title: candidate.title.trim(),
        artist: candidate.artist.trim(),
        album: candidate.album?.trim() || null,
        appleSongId: qualification.catalog.appleSongId,
        recordingFamilyKey: qualification.catalog.recordingFamilyKey,
        sourceObservationIds: [...new Set(candidate.sourceObservationIds)],
        evidenceBindingIds: attestedBindings.map(({ id }) => id),
        evidenceBindings: attestedBindings.map((binding) => ({ ...binding })),
        evidenceStrength: boundedFinite(qualification.evidence.strength),
        scopeFit: boundedFinite(qualification.scope.fit),
        independentProvenanceRoots: Math.max(0, Math.floor(qualification.evidence.independentProvenanceRoots)),
        versionConfidence: boundedFinite(qualification.version.confidence),
        catalogConfidence: boundedFinite(qualification.catalog.confidence),
        rankingSignals: { ...qualification.rankingSignals },
        sourceRank: Number.isFinite(qualification.sourceRank) ? Math.max(0, qualification.sourceRank) : Number.MAX_SAFE_INTEGER,
      };
      appleIdToFamily.set(qualified.appleSongId, qualified.recordingFamilyKey);
      const familyAlreadyExists = families.has(qualified.recordingFamilyKey);
      const merge = addQualifiedToFamily(families, qualified, input.plan.rankingObjectives);
      if (merge.newFamily) {
        newFamilies += 1;
        meaningfulProgress += 1;
        counters.canonicalUnique += 1;
        continue;
      }
      incrementReason(discardedByReason, "duplicate_recording_family");
      if (familyAlreadyExists && merge.meaningfulProgress) meaningfulProgress += 1;
    }

    state.newQualifiedFamilies += newFamilies;
    state.consecutiveZeroQualifiedYieldRounds = meaningfulProgress === 0
      ? state.consecutiveZeroQualifiedYieldRounds + 1
      : 0;
    const cursorLoop = batch.nextCursor !== null && state.seenCursors.has(batch.nextCursor);
    if (batch.nextCursor !== null) state.seenCursors.add(batch.nextCursor);
    state.cursor = batch.nextCursor;
    if (cursorLoop && !batch.exhausted) {
      integrityFailureCount += 1;
      integrityEvents.push(`pagination_cursor_loop:${state.definition.id}:${batch.nextCursor}`);
      state.status = "integrity_error";
    } else if (batch.providerCircuitOpen) state.status = "circuit_open";
    else if (batch.exhausted
      || state.rounds >= state.definition.maximumRounds
      || state.consecutiveZeroQualifiedYieldRounds >= state.definition.zeroQualifiedYieldLimit) {
      state.status = "exhausted";
    } else {
      state.status = "available";
    }
  }

  const resolvedStopReason = finalStopReason({
    explicit: stopReason,
    strategies: states,
    providerFailureCount,
    integrityFailureCount,
    qualifiedCount: families.size,
  });
  const rankedPool = [...families.values()]
    .map(({ primary }) => primary)
    .sort((left, right) => compareQualified(left, right, input.plan.rankingObjectives));
  const hardAggregate = applyHardAggregateConstraints(rankedPool, input.plan.hardConstraints);
  for (const rejection of hardAggregate.rejected) {
    incrementReason(discardedByReason, "hard_constraint_failed");
    for (const reason of rejection.reasons) incrementReason(discardedByReason, reason);
  }
  const broadCurated = shouldSequenceBroadCurated(engines, input.plan);
  const rankedSelected = broadCurated
    ? selectBroadCurated(hardAggregate.eligible, requested, input.plan)
    : hardAggregate.eligible.slice(0, requested);
  const selected = broadCurated
    ? sequenceBroadCurated(rankedSelected, input.plan.orderingPolicy)
    : rankedSelected;
  const selectedIds = new Set(selected.map(({ candidateId }) => candidateId));
  const reserve = hardAggregate.eligible
    .filter(({ candidateId }) => !selectedIds.has(candidateId))
    .slice(0, reserveGoal);
  const shortfall = Math.max(0, requested - selected.length);
  const status: RetrievalOutcomeStatusV3 = resolvedStopReason === "provider_failure" && selected.length === 0
    ? "failed_system"
    : resolvedStopReason === "integrity_failure" && selected.length === 0
      ? "failed_integrity"
      : selected.length === 0
        ? "no_compatible_tracks"
        : shortfall > 0
          ? "partial_ready"
          : "exact_ready";
  const strategyReports: RetrievalStrategyReportV3[] = states.map(strategyReport);
  const stages: RetrievalStageCountersV3 = {
    ...counters,
    selected: selected.length,
    reserve: reserve.length,
  };
  const compatibleAlternatesByRecordingFamily = Object.fromEntries(
    [...families.entries()]
      .filter(([, { alternates }]) => alternates.length > 0)
      .map(([family, { alternates }]) => [family, alternates]),
  );
  return {
    schemaVersion: PIPELINE_V3_RETRIEVAL_SCHEMA,
    runId: input.runId,
    executionMode: mode,
    engines,
    outcome: {
      status,
      stopReason: resolvedStopReason,
      requestedTrackCount: requested,
      qualifiedTrackCount: hardAggregate.eligible.length,
      selectedTrackCount: selected.length,
      reserveTrackCount: reserve.length,
      shortfall,
      requiresPartialPublicationDecision: status === "partial_ready",
    },
    selected,
    reserve,
    qualifiedPool: hardAggregate.eligible,
    compatibleAlternatesByRecordingFamily,
    stages,
    deficit: {
      ...stages,
      requested,
      qualifiedPoolGoal: requested + reserveGoal,
      targetShortfall: shortfall,
      reserveShortfall: Math.max(0, reserveGoal - reserve.length),
      discardedByReason,
      primaryShortfallReason: shortfall > 0 ? resolvedStopReason : null,
    },
    strategies: strategyReports,
    integrityEvents,
    publicationBoundary: publicationBoundary(mode, status),
  };
}
