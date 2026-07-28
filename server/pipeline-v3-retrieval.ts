import { createHash } from "node:crypto";
import { EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS } from "../shared/product-policy.ts";
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
import { catalogEraConstraintFailuresV3 } from "./pipeline-v3-era-policy.ts";
import {
  appleLookupCountV3,
  appleProviderRequestCountV3,
  candidateLeadKeyV3,
  citationHashesV3,
  predicateFailureCountsV3,
  projectQualificationToOriginalPredicatesV3,
  proposeSemanticRecoveryV3,
  recoveryAuditIdempotencyKeyV3,
  recoveryStageSnapshotV3,
  semanticRecoveryRootCauseV3,
  type PipelineCandidateLeadArtifactV3,
  type PipelineRecoveryAuditArtifactV3,
  type RetrievalPredicateDiagnosticsV3,
  type SemanticPlanRevisionArtifactV3,
} from "./pipeline-v3-semantic-recovery.ts";
import type {
  CanonicalPlaylistContractClauseAssessmentV1,
  CanonicalPlaylistQualityPolicy,
  CanonicalPlaylistQuotaRule,
  SelectionConstraint,
} from "../shared/types.ts";
import { assertPublicHttpsUrl, stableStringify } from "./security.ts";
import {
  canonicalEvidenceGradeForBindingV1,
  evaluateCanonicalContractPredicateV1,
  evaluateCanonicalContractTrackV1,
} from "./canonical-contract-runtime-v1.ts";
import {
  playlistEvidenceGradeSatisfiesObligationV1,
  selectQualifyingPlaylistEvidenceGradeV1,
} from "./playlist-evidence-policy-v1.ts";
import {
  activePlaylistOptimizationBudgetV1,
  optimizePlaylistV1,
  PlaylistOptimizationBudgetExceededErrorV1,
  type PlaylistOptimizationCandidateV1,
  type PlaylistOptimizationConstraintsV1,
  type PlaylistOptimizationResultV1,
} from "./playlist-optimizer-v1.ts";
import {
  assertFixedContainerResolutionProofV1,
  fixedContainerDirectiveHashV1,
  type FixedContainerResolutionProofV1,
} from "./fixed-container-resolution-proof-v1.ts";
import { MAX_CITATION_EXCERPT_CHARS } from "./citation-attestation.ts";

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

/**
 * A stable identity for a genuinely independent upstream dependency.
 *
 * These ids describe infrastructure/corpus independence, not prompt
 * diversity. Two strategies that both use hosted search therefore share one
 * dependency even when their query wording differs. The portfolio scheduler
 * never runs strategies with an overlapping discovery dependency at the same
 * time.
 */
export type RetrievalUpstreamDependencyIdV3 =
  | "orchestration_local"
  | "apple_catalog"
  | "hosted_web"
  | "governed_evidence_graph";

export type RetrievalDependencyFailureClassV3 =
  | "transient"
  | "rate_limited"
  | "authorization"
  | "quota"
  | "invalid_request"
  | "configuration"
  | "permanent";

export function retrievalDependencyFailureIsRetryableV3(
  failureClass: RetrievalDependencyFailureClassV3,
): boolean {
  return failureClass === "transient" || failureClass === "rate_limited";
}

/**
 * Adapters must use this error when a composite strategy can identify a
 * failed upstream precisely. Untyped errors are technical faults and must
 * escape retrieval so the worker can retry or quarantine them; they must
 * never be laundered into provider scarcity.
 */
export class RetrievalDependencyErrorV3 extends Error {
  readonly dependencyIds: readonly RetrievalUpstreamDependencyIdV3[];
  readonly retryAfterUntil: Date | null;
  readonly failureClass: RetrievalDependencyFailureClassV3;
  readonly retriable: boolean;

  constructor(
    message: string,
    dependencyIds: readonly RetrievalUpstreamDependencyIdV3[],
    retryAfterUntil: Date | null = null,
    failureClass: RetrievalDependencyFailureClassV3 = "transient",
  ) {
    super(message);
    this.name = "RetrievalDependencyErrorV3";
    this.dependencyIds = Object.freeze([...new Set(dependencyIds)]);
    this.retryAfterUntil = retryAfterUntil
      && Number.isFinite(retryAfterUntil.getTime())
      ? new Date(retryAfterUntil)
      : null;
    this.failureClass = failureClass;
    this.retriable = retrievalDependencyFailureIsRetryableV3(failureClass);
  }
}

export interface RetrievalStrategyDefinitionV3 {
  readonly id: string;
  readonly engine: RetrievalEngineV3;
  readonly kind: RetrievalStrategyKindV3;
  readonly tier: number;
  readonly maximumRounds: number;
  readonly maximumBatchSize: number;
  readonly zeroQualifiedYieldLimit: 2;
  /** Dependencies exercised by the concurrent discovery call. */
  readonly discoveryDependencyIds: readonly RetrievalUpstreamDependencyIdV3[];
  /**
   * Dependencies exercised while qualifying the returned leads. Qualification
   * is intentionally committed in deterministic order after concurrent
   * discovery, so these dependencies are never called concurrently here.
   */
  readonly qualificationDependencyIds: readonly RetrievalUpstreamDependencyIdV3[];
}

function strategyDependencyIds(
  engine: RetrievalEngineV3,
  kind: RetrievalStrategyKindV3,
): {
  discovery: readonly RetrievalUpstreamDependencyIdV3[];
  qualification: readonly RetrievalUpstreamDependencyIdV3[];
} {
  if (kind === "scope_resolution" || kind === "gap_pass") {
    return { discovery: ["orchestration_local"], qualification: [] };
  }
  if (engine === "factual_relationship" || engine === "exhaustive") {
    return {
      discovery: ["governed_evidence_graph"],
      qualification: ["apple_catalog"],
    };
  }
  if (kind === "artist_identity"
    || kind === "release_enumeration"
    || kind === "container_enumeration"
    || kind === "trusted_containers") {
    return { discovery: ["apple_catalog"], qualification: ["apple_catalog"] };
  }
  if (kind === "qualified_expansion") {
    return {
      discovery: ["apple_catalog", "hosted_web"],
      qualification: ["apple_catalog"],
    };
  }
  return { discovery: ["hosted_web"], qualification: ["apple_catalog"] };
}

function strategy(
  engine: RetrievalEngineV3,
  id: string,
  kind: RetrievalStrategyKindV3,
  tier: number,
  maximumRounds: number,
  maximumBatchSize = 250,
): RetrievalStrategyDefinitionV3 {
  const dependencies = strategyDependencyIds(engine, kind);
  return Object.freeze({
    id: `${engine}:${id}`,
    engine,
    kind,
    tier,
    maximumRounds,
    maximumBatchSize,
    zeroQualifiedYieldLimit: 2 as const,
    discoveryDependencyIds: Object.freeze([...dependencies.discovery]),
    qualificationDependencyIds: Object.freeze([...dependencies.qualification]),
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

export const CENTRAL_QUALITY_CRITERION_OBSERVATION_SCHEMA =
  "genio-central-quality-criterion-observation/v2" as const;

export type CentralQualityCriterionVerdictV3 =
  CanonicalPlaylistContractClauseAssessmentV1["status"];

/**
 * Immutable, policy-bound observation of one server-owned suitability
 * criterion. The provider may choose only the tri-state verdict; the server
 * creates every identity and policy binding. These rows are ranking-quality
 * judgments, never factual membership evidence.
 */
export interface CentralQualityCriterionObservationV3 {
  readonly schemaVersion:
    typeof CENTRAL_QUALITY_CRITERION_OBSERVATION_SCHEMA;
  readonly policyVersion: "canonical_central_quality_v1";
  readonly policyHash: string;
  readonly criterion: string;
  readonly verdict: CentralQualityCriterionVerdictV3;
  readonly sourceKind:
    | "hosted_web_response"
    | "governed_evidence_snapshot"
    | "independent_curator_review";
  readonly sourceId: string;
  /**
   * Source-stage judgments are bound to an exact normalized
   * artist/title/album triple. Only catalog-bound rows may satisfy policy.
   */
  readonly bindingKind: "candidate" | "catalog";
  readonly candidateIdentityHash: string;
  /**
   * Hash of the candidate identity plus exact Apple song and recording-family
   * identities. Candidate-stage rows intentionally carry null here.
   */
  readonly catalogIdentityHash: string | null;
  readonly observationId: string;
}

function normalizeCentralQualityIdentityTextV3(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}

function centralQualityCandidateIdentityHashV3(
  artist: string,
  title: string,
  album: string | null,
): string {
  return createHash("sha256")
    .update(stableStringify({
      artist: normalizeCentralQualityIdentityTextV3(artist),
      title: normalizeCentralQualityIdentityTextV3(title),
      album: album === null
        ? null
        : normalizeCentralQualityIdentityTextV3(album) || null,
    }))
    .digest("hex");
}

function centralQualityCatalogIdentityHashV3(input: {
  candidateIdentityHash: string;
  appleSongId: string;
  recordingFamilyKey: string;
}): string {
  return createHash("sha256")
    .update(stableStringify({
      candidateIdentityHash: input.candidateIdentityHash,
      appleSongId: input.appleSongId.trim(),
      recordingFamilyKey: input.recordingFamilyKey.trim(),
    }))
    .digest("hex");
}

export function centralQualityPolicyHashV3(
  policy: CanonicalPlaylistQualityPolicy,
): string {
  return createHash("sha256")
    .update(stableStringify(policy))
    .digest("hex");
}

export function createCentralQualityCriterionObservationV3(input: {
  policy: CanonicalPlaylistQualityPolicy;
  criterion: string;
  verdict: CentralQualityCriterionVerdictV3;
  sourceKind: CentralQualityCriterionObservationV3["sourceKind"];
  sourceId: string;
  artist: string;
  title: string;
  album: string | null;
  catalogIdentity?: {
    readonly appleSongId: string;
    readonly recordingFamilyKey: string;
  } | null;
}): CentralQualityCriterionObservationV3 {
  const criterion = input.criterion.normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  const sourceId = input.sourceId.normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  if (
    !input.policy.criteria.includes(criterion)
    || !["pass", "fail", "unknown"].includes(input.verdict)
    || !sourceId
    || sourceId.length > 240
    || !normalizeCentralQualityIdentityTextV3(input.artist)
    || !normalizeCentralQualityIdentityTextV3(input.title)
  ) {
    throw new Error("central_quality_criterion_observation_invalid");
  }
  const candidateIdentityHash = centralQualityCandidateIdentityHashV3(
    input.artist,
    input.title,
    input.album,
  );
  const catalogIdentity = input.catalogIdentity ?? null;
  const appleSongId = catalogIdentity?.appleSongId.trim() ?? "";
  const recordingFamilyKey =
    catalogIdentity?.recordingFamilyKey.trim() ?? "";
  if (
    catalogIdentity
    && (
      input.album === null
      || !normalizeCentralQualityIdentityTextV3(input.album)
      || !appleSongId
      || appleSongId.length > 240
      || !recordingFamilyKey
      || recordingFamilyKey.length > 320
    )
  ) {
    throw new Error("central_quality_criterion_observation_invalid");
  }
  const material = {
    schemaVersion: CENTRAL_QUALITY_CRITERION_OBSERVATION_SCHEMA,
    policyVersion: input.policy.policyVersion,
    policyHash: centralQualityPolicyHashV3(input.policy),
    criterion,
    verdict: input.verdict,
    sourceKind: input.sourceKind,
    sourceId,
    bindingKind: catalogIdentity ? "catalog" : "candidate",
    candidateIdentityHash,
    catalogIdentityHash: catalogIdentity
      ? centralQualityCatalogIdentityHashV3({
          candidateIdentityHash,
          appleSongId,
          recordingFamilyKey,
        })
      : null,
  } as const;
  return Object.freeze({
    ...material,
    observationId: createHash("sha256")
      .update(stableStringify(material))
      .digest("hex"),
  });
}

function centralQualityCandidateCriterionObservationsForPolicyV3(input: {
  observations: unknown;
  policy: CanonicalPlaylistQualityPolicy;
  artist: string;
  title: string;
  album: string | null;
}): CentralQualityCriterionObservationV3[] {
  if (!Array.isArray(input.observations)) return [];
  const policyHash = centralQualityPolicyHashV3(input.policy);
  const candidateIdentityHash = centralQualityCandidateIdentityHashV3(
    input.artist,
    input.title,
    input.album,
  );
  const criteria = new Set(input.policy.criteria);
  // Retain one deterministic immutable representative for every
  // criterion/verdict/source-kind combination. This bounds persisted proof
  // without truncating by input order: a known failure anywhere in the
  // observation set is always retained.
  const output = new Map<string, CentralQualityCriterionObservationV3>();
  for (const value of input.observations) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Partial<CentralQualityCriterionObservationV3>;
    if (
      row.schemaVersion !== CENTRAL_QUALITY_CRITERION_OBSERVATION_SCHEMA
      || row.policyVersion !== input.policy.policyVersion
      || row.policyHash !== policyHash
      || typeof row.criterion !== "string"
      || !criteria.has(row.criterion)
      || !["pass", "fail", "unknown"].includes(String(row.verdict))
      || ![
        "hosted_web_response",
        "governed_evidence_snapshot",
        "independent_curator_review",
      ].includes(String(row.sourceKind))
      || typeof row.sourceId !== "string"
      || row.sourceId.length < 1
      || row.sourceId.length > 240
      || row.bindingKind !== "candidate"
      || row.candidateIdentityHash !== candidateIdentityHash
      || row.catalogIdentityHash !== null
      || typeof row.observationId !== "string"
    ) continue;
    let expected: CentralQualityCriterionObservationV3;
    try {
      expected = createCentralQualityCriterionObservationV3({
        policy: input.policy,
        criterion: row.criterion,
        verdict: row.verdict as CentralQualityCriterionVerdictV3,
        sourceKind:
          row.sourceKind as CentralQualityCriterionObservationV3["sourceKind"],
        sourceId: row.sourceId,
        artist: input.artist,
        title: input.title,
        album: input.album,
      });
    } catch {
      continue;
    }
    if (expected.observationId !== row.observationId) continue;
    const proofKey = stableStringify([
      expected.criterion,
      expected.verdict,
      expected.sourceKind,
    ]);
    const prior = output.get(proofKey);
    if (!prior || expected.observationId < prior.observationId) {
      output.set(proofKey, expected);
    }
  }
  return [...output.values()].sort((left, right) => (
    left.observationId.localeCompare(right.observationId)
  ));
}

/**
 * Reissue candidate-stage quality judgments only after the source identity
 * has been resolved without ambiguity to one Apple recording family. A
 * supplied album remains an exact requirement. An omitted album is accepted
 * only when the caller proved the complete exact artist/title result set has
 * one recording family; album mismatches and multi-family candidates remain
 * unknown.
 */
export function bindCentralQualityCriterionObservationsToCatalogV3(input: {
  observations: unknown;
  policy: CanonicalPlaylistQualityPolicy;
  candidate: {
    readonly artist: string;
    readonly title: string;
    readonly album: string | null;
  };
  catalog: {
    readonly artist: string;
    readonly title: string;
    readonly album: string | null;
    readonly appleSongId: string;
    readonly recordingFamilyKey: string;
  };
  unambiguous: boolean;
}): CentralQualityCriterionObservationV3[] {
  const candidateAlbum = input.candidate.album === null
    ? ""
    : normalizeCentralQualityIdentityTextV3(input.candidate.album);
  const catalogAlbum = input.catalog.album === null
    ? ""
    : normalizeCentralQualityIdentityTextV3(input.catalog.album);
  const appleSongId = input.catalog.appleSongId.trim();
  const recordingFamilyKey = input.catalog.recordingFamilyKey.trim();
  if (
    !input.unambiguous
    || !catalogAlbum
    || !appleSongId
    || appleSongId.length > 240
    || !recordingFamilyKey
    || recordingFamilyKey.length > 320
    || normalizeCentralQualityIdentityTextV3(input.candidate.artist)
      !== normalizeCentralQualityIdentityTextV3(input.catalog.artist)
    || normalizeCentralQualityIdentityTextV3(input.candidate.title)
      !== normalizeCentralQualityIdentityTextV3(input.catalog.title)
    || (candidateAlbum && candidateAlbum !== catalogAlbum)
  ) return [];
  const sourceObservations =
    centralQualityCandidateCriterionObservationsForPolicyV3({
      observations: input.observations,
      policy: input.policy,
      artist: input.candidate.artist,
      title: input.candidate.title,
      album: input.candidate.album,
    });
  return sourceObservations.map((observation) => (
    createCentralQualityCriterionObservationV3({
      policy: input.policy,
      criterion: observation.criterion,
      verdict: observation.verdict,
      sourceKind: observation.sourceKind,
      sourceId: observation.sourceId,
      artist: input.catalog.artist,
      title: input.catalog.title,
      album: input.catalog.album,
      catalogIdentity: {
        appleSongId,
        recordingFamilyKey,
      },
    })
  ));
}

/**
 * Downstream central-quality proof normalizer. Candidate-stage observations
 * are never accepted here: every row must match the exact catalog recording
 * that is being selected, persisted, resumed, or published.
 */
export function centralQualityCriterionObservationsForPolicyV3(input: {
  observations: unknown;
  policy: CanonicalPlaylistQualityPolicy;
  artist: string;
  title: string;
  album: string | null;
  appleSongId: string;
  recordingFamilyKey: string;
}): CentralQualityCriterionObservationV3[] {
  if (!Array.isArray(input.observations)) return [];
  const normalizedAlbum = input.album === null
    ? ""
    : normalizeCentralQualityIdentityTextV3(input.album);
  const appleSongId = input.appleSongId.trim();
  const recordingFamilyKey = input.recordingFamilyKey.trim();
  if (!normalizedAlbum || !appleSongId || !recordingFamilyKey) return [];
  const policyHash = centralQualityPolicyHashV3(input.policy);
  const candidateIdentityHash = centralQualityCandidateIdentityHashV3(
    input.artist,
    input.title,
    input.album,
  );
  const catalogIdentityHash = centralQualityCatalogIdentityHashV3({
    candidateIdentityHash,
    appleSongId,
    recordingFamilyKey,
  });
  const criteria = new Set(input.policy.criteria);
  const output = new Map<string, CentralQualityCriterionObservationV3>();
  for (const value of input.observations) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Partial<CentralQualityCriterionObservationV3>;
    if (
      row.schemaVersion !== CENTRAL_QUALITY_CRITERION_OBSERVATION_SCHEMA
      || row.policyVersion !== input.policy.policyVersion
      || row.policyHash !== policyHash
      || typeof row.criterion !== "string"
      || !criteria.has(row.criterion)
      || !["pass", "fail", "unknown"].includes(String(row.verdict))
      || ![
        "hosted_web_response",
        "governed_evidence_snapshot",
        "independent_curator_review",
      ].includes(String(row.sourceKind))
      || typeof row.sourceId !== "string"
      || row.sourceId.length < 1
      || row.sourceId.length > 240
      || row.bindingKind !== "catalog"
      || row.candidateIdentityHash !== candidateIdentityHash
      || row.catalogIdentityHash !== catalogIdentityHash
      || typeof row.observationId !== "string"
    ) continue;
    let expected: CentralQualityCriterionObservationV3;
    try {
      expected = createCentralQualityCriterionObservationV3({
        policy: input.policy,
        criterion: row.criterion,
        verdict: row.verdict as CentralQualityCriterionVerdictV3,
        sourceKind:
          row.sourceKind as CentralQualityCriterionObservationV3["sourceKind"],
        sourceId: row.sourceId,
        artist: input.artist,
        title: input.title,
        album: input.album,
        catalogIdentity: { appleSongId, recordingFamilyKey },
      });
    } catch {
      continue;
    }
    if (expected.observationId !== row.observationId) continue;
    const proofKey = stableStringify([
      expected.criterion,
      expected.verdict,
      expected.sourceKind,
    ]);
    const prior = output.get(proofKey);
    if (!prior || expected.observationId < prior.observationId) {
      output.set(proofKey, expected);
    }
  }
  return [...output.values()].sort((left, right) => (
    left.observationId.localeCompare(right.observationId)
  ));
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
    /** Catalog resolution was attempted, even if cached metadata avoided a provider read. */
    readonly lookupAttempted?: boolean;
    /** Actual Apple provider read invocations made during qualification. */
    readonly appleProviderRequestCount?: number;
    readonly storefrontPlayable: boolean;
    readonly appleSongId: string | null;
    readonly recordingFamilyKey: string | null;
    /** Authoritative resolved catalog identity for downstream evidence binding. */
    readonly artistName?: string;
    readonly trackName?: string;
    readonly albumName?: string | null;
    readonly confidence: number;
    /** Normalized Apple/catalog issue year used for immutable era checks. */
    readonly releaseYear?: number | null;
    /** Years observed on exact compatible recording-family catalog issues. */
    readonly compatibleReleaseYears?: readonly number[];
    /** Authoritative catalog genre labels used only for canonical quota proof. */
    readonly genreNames?: readonly string[];
  };
  /**
   * Server-created tri-state assessments for the immutable contract leaves.
   * A schema-4 worker ignores legacy flattened scope booleans and evaluates
   * the canonical Boolean predicate from these values.
   */
  readonly canonicalClauseAssessments?: Readonly<
    Record<string, CanonicalPlaylistContractClauseAssessmentV1>
  >;
  /**
   * Server-derived, ranking-only signals for constrained playlist assembly.
   * These values never satisfy membership or evidence obligations.
   */
  readonly playlistOptimizationSignals?: PlaylistOptimizationSignalsV3;
  /**
   * Sole proof input for the immutable central-suitability floor. Aggregate
   * central_quality scores remain ranking-only and cannot substitute for
   * these policy-bound tri-state observations.
   */
  readonly centralQualityCriterionObservations?:
    readonly CentralQualityCriterionObservationV3[];
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
   * Bounded provider-owned content retained for a selection-grade hosted-web
   * assertion. It intentionally contains no page body or full provider
   * response: only the exact cited output span and a safe locator survive.
   */
  readonly hostedEvidenceSnapshot?: HostedWebEvidenceSnapshotV3;
  /**
   * Server-issued proof that this binding is eligible to cross the selection
   * boundary. Governance metadata alone describes how a source may be used;
   * it does not prove that the source was returned by the provider for this
   * exact track or that a promoted assertion belongs to the frozen snapshot.
   */
  readonly eligibilityAttestation?: EvidenceEligibilityAttestationV3;
}

export interface PlaylistOptimizationSignalsV3 {
  readonly familiarityScore?: number | null;
  readonly discoveryScore?: number | null;
  readonly eraKeys?: readonly string[];
  readonly sceneKeys?: readonly string[];
  readonly geographyKeys?: readonly string[];
  readonly energy?: number | null;
  readonly tempo?: number | null;
  readonly chronologyPosition?: number | null;
}

export const PIPELINE_V3_EVIDENCE_ATTESTATION_SCHEMA =
  "genio-pipeline-v3-evidence-attestation/v1" as const;

export const HOSTED_WEB_EVIDENCE_SNAPSHOT_SCHEMA =
  "genio-hosted-web-evidence-snapshot/v1" as const;

export const HOSTED_WEB_EVIDENCE_ACQUISITION_POLICY =
  "hosted-web-evidence-acquisition-v1" as const;

export interface HostedWebEvidenceSnapshotV3 {
  readonly schemaVersion: typeof HOSTED_WEB_EVIDENCE_SNAPSHOT_SCHEMA;
  readonly acquisitionPolicyVersion:
    typeof HOSTED_WEB_EVIDENCE_ACQUISITION_POLICY;
  readonly sourceUrl: string;
  readonly excerpt: string;
  readonly excerptHash: string;
  readonly providerLocator: {
    readonly responseId: string;
    readonly outputItemId: string;
    readonly contentIndex: number;
    readonly citationStartIndex: number;
    readonly citationEndIndex: number;
    readonly excerptStartIndex: number;
    readonly excerptEndIndex: number;
  };
  readonly acquiredAt: string;
  readonly storefront: string;
  readonly freshnessExpiresAt: string;
  readonly revokedAt: string | null;
  /** Exact immutable membership predicates supported by this one excerpt. */
  readonly predicateIds: readonly string[];
  /** Exact contract obligations this excerpt is allowed to satisfy. */
  readonly obligationIds: readonly string[];
  /** Hash of every field above, including the URL and acquisition policy. */
  readonly snapshotHash: string;
}

export type EvidenceEligibilityAttestationV3 =
  | {
    readonly schemaVersion: typeof PIPELINE_V3_EVIDENCE_ATTESTATION_SCHEMA;
    readonly kind: "approved_exact_track_scope_source";
    readonly exactTrackScope: true;
    readonly providerAttested: true;
    readonly sourcePolicyVersion: EvidenceSourceGovernanceV3["policyVersion"];
    readonly sourceUrlHash: string;
    /** Required when the attested source is a hosted-web evidence snapshot. */
    readonly sourceSnapshotHash?: string;
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
  /** Persisted provider/corpus expiry. New evidence producers always set it. */
  readonly freshnessExpiresAt?: string | null;
  /** Exact acquisition instant for bounded hosted evidence. */
  readonly acquiredAt?: string | null;
  /** A non-null timestamp revokes this source for all future selection. */
  readonly revokedAt?: string | null;
  readonly sourceHash: string;
  readonly sourceRevision: string;
}

function sha256EvidenceValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const SAFE_PROVIDER_LOCATOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SAFE_EVIDENCE_OBLIGATION_ID = /^[^\u0000-\u001f\u007f]{1,240}$/u;
const HOSTED_EVIDENCE_FUTURE_SKEW_MS = 5 * 60_000;
export const HOSTED_WEB_EVIDENCE_MAX_ID_COUNT = 32;
export const HOSTED_WEB_EVIDENCE_MAX_JSON_BYTES = 24 * 1_024;
export const HOSTED_WEB_EVIDENCE_MAX_FRESHNESS_MS =
  30 * 24 * 60 * 60_000;
export const EVIDENCE_GOVERNANCE_MAX_JSON_BYTES = 8 * 1_024;
export const EVIDENCE_ATTESTATION_MAX_JSON_BYTES = 4 * 1_024;
export const EVIDENCE_BINDING_MAX_JSON_BYTES = 48 * 1_024;
const HOSTED_WEB_EVIDENCE_SNAPSHOT_KEYS = [
  "schemaVersion",
  "acquisitionPolicyVersion",
  "sourceUrl",
  "excerpt",
  "excerptHash",
  "providerLocator",
  "acquiredAt",
  "storefront",
  "freshnessExpiresAt",
  "revokedAt",
  "predicateIds",
  "obligationIds",
  "snapshotHash",
] as const;
const HOSTED_WEB_EVIDENCE_PROVIDER_LOCATOR_KEYS = [
  "responseId",
  "outputItemId",
  "contentIndex",
  "citationStartIndex",
  "citationEndIndex",
  "excerptStartIndex",
  "excerptEndIndex",
] as const;
const EVIDENCE_GOVERNANCE_REQUIRED_KEYS = [
  "policyVersion",
  "useScope",
  "approvalState",
  "accessMethod",
  "licenseState",
  "licenseVersion",
  "termsVersion",
  "attribution",
  "cachePolicy",
  "retentionPolicy",
  "freshnessPolicy",
  "sourceHash",
  "sourceRevision",
] as const;
const EVIDENCE_GOVERNANCE_ALLOWED_KEYS = [
  ...EVIDENCE_GOVERNANCE_REQUIRED_KEYS,
  "freshnessExpiresAt",
  "acquiredAt",
  "revokedAt",
] as const;
const APPROVED_SOURCE_ATTESTATION_REQUIRED_KEYS = [
  "schemaVersion",
  "kind",
  "exactTrackScope",
  "providerAttested",
  "sourcePolicyVersion",
  "sourceUrlHash",
] as const;
const APPROVED_SOURCE_ATTESTATION_ALLOWED_KEYS = [
  ...APPROVED_SOURCE_ATTESTATION_REQUIRED_KEYS,
  "sourceSnapshotHash",
] as const;
const GRAPH_ASSERTION_ATTESTATION_KEYS = [
  "schemaVersion",
  "kind",
  "exactTrackScope",
  "promoted",
  "graphSnapshotId",
  "assertionId",
  "observationId",
] as const;
const EVIDENCE_BINDING_REQUIRED_KEYS = [
  "id",
  "url",
  "provenanceRoot",
  "strength",
  "sourceRank",
  "kind",
  "governance",
] as const;
const EVIDENCE_BINDING_ALLOWED_KEYS = [
  ...EVIDENCE_BINDING_REQUIRED_KEYS,
  "predicateIds",
  "supportedPredicateIds",
  "hostedEvidenceSnapshot",
  "eligibilityAttestation",
] as const;

function hasExactOwnKeys(
  value: object,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => (
      typeof key === "string" && expected.includes(key)
    ));
}

function hasOnlyOwnKeys(
  value: object,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => (
    typeof key === "string" && allowed.includes(key)
  )) && required.every((key) => Object.hasOwn(value, key));
}

function boundedJsonByteLength(value: unknown): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return null;
  }
}

function canonicalEvidenceIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => (
    SAFE_EVIDENCE_OBLIGATION_ID.test(value)
  )))].sort();
}

function canonicalIsoInstant(value: string): boolean {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function canonicalStorefront(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (!/^[a-z]{2}$/u.test(normalized)) {
    throw new Error("Hosted evidence storefront is invalid");
  }
  return normalized;
}

function hostedWebEvidenceSnapshotRevisionPayloadV3(
  snapshot: Omit<HostedWebEvidenceSnapshotV3, "snapshotHash">,
): readonly unknown[] {
  return [
    snapshot.schemaVersion,
    snapshot.acquisitionPolicyVersion,
    snapshot.sourceUrl,
    snapshot.excerpt,
    snapshot.excerptHash,
    [
      snapshot.providerLocator.responseId,
      snapshot.providerLocator.outputItemId,
      snapshot.providerLocator.contentIndex,
      snapshot.providerLocator.citationStartIndex,
      snapshot.providerLocator.citationEndIndex,
      snapshot.providerLocator.excerptStartIndex,
      snapshot.providerLocator.excerptEndIndex,
    ],
    snapshot.acquiredAt,
    snapshot.storefront,
    snapshot.freshnessExpiresAt,
    snapshot.revokedAt,
    snapshot.predicateIds,
    snapshot.obligationIds,
  ];
}

export function hostedWebEvidenceSnapshotHashV3(
  snapshot: Omit<HostedWebEvidenceSnapshotV3, "snapshotHash">,
): string {
  return sha256EvidenceValue(JSON.stringify(
    hostedWebEvidenceSnapshotRevisionPayloadV3(snapshot),
  ));
}

export function createHostedWebEvidenceSnapshotV3(input: {
  sourceUrl: string;
  excerpt: string;
  responseId: string;
  outputItemId: string;
  contentIndex: number;
  citationStartIndex: number;
  citationEndIndex: number;
  excerptStartIndex: number;
  excerptEndIndex: number;
  acquiredAt: string;
  storefront: string;
  freshnessExpiresAt: string;
  revokedAt?: string | null;
  predicateIds: readonly string[];
  obligationIds?: readonly string[];
}): HostedWebEvidenceSnapshotV3 {
  if (!Array.isArray(input.predicateIds)
    || !Array.isArray(input.obligationIds ?? input.predicateIds)
    || input.predicateIds.length > HOSTED_WEB_EVIDENCE_MAX_ID_COUNT
    || (input.obligationIds ?? input.predicateIds).length
      > HOSTED_WEB_EVIDENCE_MAX_ID_COUNT) {
    throw new Error("Hosted evidence snapshot is invalid");
  }
  const sourceUrl = assertPublicHttpsUrl(input.sourceUrl).toString();
  const excerpt = input.excerpt;
  const predicateIds = canonicalEvidenceIds(input.predicateIds);
  const obligationIds = canonicalEvidenceIds(
    input.obligationIds ?? input.predicateIds,
  );
  const storefront = canonicalStorefront(input.storefront);
  if (excerpt.length < 8 || excerpt.length > MAX_CITATION_EXCERPT_CHARS
    || excerpt.trim() !== excerpt
    || !SAFE_PROVIDER_LOCATOR_ID.test(input.responseId)
    || !SAFE_PROVIDER_LOCATOR_ID.test(input.outputItemId)
    || !Number.isSafeInteger(input.contentIndex)
    || input.contentIndex < 0
    || input.contentIndex > 1_000
    || !Number.isSafeInteger(input.citationStartIndex)
    || !Number.isSafeInteger(input.citationEndIndex)
    || !Number.isSafeInteger(input.excerptStartIndex)
    || !Number.isSafeInteger(input.excerptEndIndex)
    || input.citationStartIndex < input.excerptStartIndex
    || input.citationEndIndex <= input.citationStartIndex
    || input.citationEndIndex > input.excerptEndIndex
    || input.excerptEndIndex - input.excerptStartIndex !== excerpt.length
    // A canonical unknown-term discovery hint deliberately has no executable
    // membership obligation. Its exact-track citation may remain a lead with
    // two explicitly empty ID sets, but one side may never silently omit IDs
    // carried by the other.
    || (predicateIds.length === 0) !== (obligationIds.length === 0)
    || !canonicalIsoInstant(input.acquiredAt)
    || !canonicalIsoInstant(input.freshnessExpiresAt)
    || Date.parse(input.freshnessExpiresAt) <= Date.parse(input.acquiredAt)
    || Date.parse(input.freshnessExpiresAt) - Date.parse(input.acquiredAt)
      > HOSTED_WEB_EVIDENCE_MAX_FRESHNESS_MS
    || (input.revokedAt !== null && input.revokedAt !== undefined
      && !canonicalIsoInstant(input.revokedAt))) {
    throw new Error("Hosted evidence snapshot is invalid");
  }
  const snapshotWithoutHash: Omit<HostedWebEvidenceSnapshotV3, "snapshotHash"> = {
    schemaVersion: HOSTED_WEB_EVIDENCE_SNAPSHOT_SCHEMA,
    acquisitionPolicyVersion: HOSTED_WEB_EVIDENCE_ACQUISITION_POLICY,
    sourceUrl,
    excerpt,
    excerptHash: sha256EvidenceValue(excerpt),
    providerLocator: {
      responseId: input.responseId,
      outputItemId: input.outputItemId,
      contentIndex: input.contentIndex,
      citationStartIndex: input.citationStartIndex,
      citationEndIndex: input.citationEndIndex,
      excerptStartIndex: input.excerptStartIndex,
      excerptEndIndex: input.excerptEndIndex,
    },
    acquiredAt: input.acquiredAt,
    storefront,
    freshnessExpiresAt: input.freshnessExpiresAt,
    revokedAt: input.revokedAt ?? null,
    predicateIds,
    obligationIds,
  };
  const snapshot = {
    ...snapshotWithoutHash,
    providerLocator: Object.freeze({ ...snapshotWithoutHash.providerLocator }),
    predicateIds: Object.freeze([...predicateIds]),
    obligationIds: Object.freeze([...obligationIds]),
    snapshotHash: hostedWebEvidenceSnapshotHashV3(snapshotWithoutHash),
  };
  const byteLength = boundedJsonByteLength(snapshot);
  if (byteLength === null || byteLength > HOSTED_WEB_EVIDENCE_MAX_JSON_BYTES) {
    throw new Error("Hosted evidence snapshot is invalid");
  }
  return Object.freeze(snapshot);
}

export interface EvidenceAttestationValidationContextV3 {
  readonly requireHostedEvidenceSnapshot?: boolean;
  readonly storefront?: string;
  readonly requiredObligationIds?: readonly string[];
  readonly nowEpochMs?: number;
}

export function hostedWebEvidenceSnapshotIsValidV3(
  snapshot: HostedWebEvidenceSnapshotV3 | null | undefined,
  context: EvidenceAttestationValidationContextV3 = {},
): snapshot is HostedWebEvidenceSnapshotV3 {
  if (!snapshot
    || typeof snapshot !== "object"
    || Array.isArray(snapshot)
    || !hasExactOwnKeys(snapshot, HOSTED_WEB_EVIDENCE_SNAPSHOT_KEYS)
    || !snapshot.providerLocator
    || typeof snapshot.providerLocator !== "object"
    || Array.isArray(snapshot.providerLocator)
    || !hasExactOwnKeys(
      snapshot.providerLocator,
      HOSTED_WEB_EVIDENCE_PROVIDER_LOCATOR_KEYS,
    )
    || !Array.isArray(snapshot.predicateIds)
    || !Array.isArray(snapshot.obligationIds)
    || snapshot.predicateIds.length > HOSTED_WEB_EVIDENCE_MAX_ID_COUNT
    || snapshot.obligationIds.length > HOSTED_WEB_EVIDENCE_MAX_ID_COUNT
    || (boundedJsonByteLength(snapshot) ?? Number.POSITIVE_INFINITY)
      > HOSTED_WEB_EVIDENCE_MAX_JSON_BYTES
    || snapshot.schemaVersion !== HOSTED_WEB_EVIDENCE_SNAPSHOT_SCHEMA
    || snapshot.acquisitionPolicyVersion
      !== HOSTED_WEB_EVIDENCE_ACQUISITION_POLICY) return false;
  let recreated: HostedWebEvidenceSnapshotV3;
  try {
    recreated = createHostedWebEvidenceSnapshotV3({
      sourceUrl: snapshot.sourceUrl,
      excerpt: snapshot.excerpt,
      responseId: snapshot.providerLocator.responseId,
      outputItemId: snapshot.providerLocator.outputItemId,
      contentIndex: snapshot.providerLocator.contentIndex,
      citationStartIndex: snapshot.providerLocator.citationStartIndex,
      citationEndIndex: snapshot.providerLocator.citationEndIndex,
      excerptStartIndex: snapshot.providerLocator.excerptStartIndex,
      excerptEndIndex: snapshot.providerLocator.excerptEndIndex,
      acquiredAt: snapshot.acquiredAt,
      storefront: snapshot.storefront,
      freshnessExpiresAt: snapshot.freshnessExpiresAt,
      revokedAt: snapshot.revokedAt,
      predicateIds: snapshot.predicateIds,
      obligationIds: snapshot.obligationIds,
    });
  } catch {
    return false;
  }
  const now = context.nowEpochMs ?? Date.now();
  const requiredObligationIds = canonicalEvidenceIds(
    context.requiredObligationIds ?? [],
  );
  return snapshot.snapshotHash === recreated.snapshotHash
    && snapshot.excerptHash === recreated.excerptHash
    && JSON.stringify(snapshot.predicateIds)
      === JSON.stringify(recreated.predicateIds)
    && JSON.stringify(snapshot.obligationIds)
      === JSON.stringify(recreated.obligationIds)
    && (context.storefront === undefined
      || snapshot.storefront === canonicalStorefront(context.storefront))
    && requiredObligationIds.every((id) => (
      snapshot.obligationIds.includes(id)
      && snapshot.predicateIds.includes(id)
    ))
    && snapshot.revokedAt === null
    && Date.parse(snapshot.acquiredAt) <= now + HOSTED_EVIDENCE_FUTURE_SKEW_MS
    && Date.parse(snapshot.freshnessExpiresAt) > now;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalOptionalInstant(value: unknown): boolean {
  return value === undefined
    || value === null
    || (typeof value === "string" && canonicalIsoInstant(value));
}

export function evidenceEligibilityAttestationIsValidShapeV3(
  attestation: EvidenceEligibilityAttestationV3 | null | undefined,
): attestation is EvidenceEligibilityAttestationV3 {
  if (!attestation
    || typeof attestation !== "object"
    || Array.isArray(attestation)
    || (boundedJsonByteLength(attestation) ?? Number.POSITIVE_INFINITY)
      > EVIDENCE_ATTESTATION_MAX_JSON_BYTES
    || attestation.schemaVersion
      !== PIPELINE_V3_EVIDENCE_ATTESTATION_SCHEMA) return false;
  if (attestation.kind === "approved_exact_track_scope_source") {
    return hasOnlyOwnKeys(
      attestation,
      APPROVED_SOURCE_ATTESTATION_ALLOWED_KEYS,
      APPROVED_SOURCE_ATTESTATION_REQUIRED_KEYS,
    )
      && attestation.exactTrackScope === true
      && attestation.providerAttested === true
      && attestation.sourcePolicyVersion === "evidence-source-governance-v3"
      && /^[0-9a-f]{64}$/u.test(attestation.sourceUrlHash)
      && (attestation.sourceSnapshotHash === undefined
        || /^[0-9a-f]{64}$/u.test(attestation.sourceSnapshotHash));
  }
  if (attestation.kind === "frozen_promoted_graph_assertion") {
    return hasExactOwnKeys(attestation, GRAPH_ASSERTION_ATTESTATION_KEYS)
      && attestation.exactTrackScope === true
      && attestation.promoted === true
      && [attestation.graphSnapshotId, attestation.assertionId,
        attestation.observationId].every((value) => (
          typeof value === "string"
          && value.trim() === value
          && value.length > 0
          && value.length <= 160
        ));
  }
  return false;
}

function evidenceBindingHasBoundedShapeV3(
  binding: EvidenceBindingReferenceV3,
): boolean {
  const predicateIds = binding.predicateIds;
  const supportedPredicateIds = binding.supportedPredicateIds;
  return hasOnlyOwnKeys(
    binding,
    EVIDENCE_BINDING_ALLOWED_KEYS,
    EVIDENCE_BINDING_REQUIRED_KEYS,
  )
    && (boundedJsonByteLength(binding) ?? Number.POSITIVE_INFINITY)
      <= EVIDENCE_BINDING_MAX_JSON_BYTES
    && typeof binding.url !== "undefined"
    && typeof binding.strength === "number"
    && Number.isFinite(binding.strength)
    && typeof binding.sourceRank === "number"
    && Number.isFinite(binding.sourceRank)
    && nonEmpty(binding.kind)
    && binding.kind.length <= 160
    && (!predicateIds || (
      Array.isArray(predicateIds)
      && predicateIds.length <= HOSTED_WEB_EVIDENCE_MAX_ID_COUNT
      && predicateIds.every((id) => (
        typeof id === "string"
        && id.trim() === id
        && SAFE_EVIDENCE_OBLIGATION_ID.test(id)
      ))
    ))
    && (!supportedPredicateIds || (
      Array.isArray(supportedPredicateIds)
      && supportedPredicateIds.length <= HOSTED_WEB_EVIDENCE_MAX_ID_COUNT
      && supportedPredicateIds.every((id) => (
        typeof id === "string"
        && id.trim() === id
        && SAFE_EVIDENCE_OBLIGATION_ID.test(id)
      ))
    ));
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
  if (!governance
    || typeof governance !== "object"
    || Array.isArray(governance)
    || !hasOnlyOwnKeys(
      governance,
      EVIDENCE_GOVERNANCE_ALLOWED_KEYS,
      EVIDENCE_GOVERNANCE_REQUIRED_KEYS,
    )
    || (boundedJsonByteLength(governance) ?? Number.POSITIVE_INFINITY)
      > EVIDENCE_GOVERNANCE_MAX_JSON_BYTES
    || governance.policyVersion !== "evidence-source-governance-v3"
    || governance.approvalState !== "approved"
    || !["run_local", "durable_corpus"].includes(governance.useScope)
    || ![
      "hosted_web_search",
      "structured_adapter",
      "public_api",
      "owner_import",
      "manual_entry",
    ].includes(governance.accessMethod)
    || !["citation_only", "reusable", "permission_recorded"]
      .includes(governance.licenseState)
    || !nonEmpty(governance.licenseVersion)
    || governance.licenseVersion.length > 512
    || !nonEmpty(governance.termsVersion)
    || governance.termsVersion.length > 512
    || !nonEmpty(governance.attribution)
    || governance.attribution.length > 2_000
    || !["excerpt_only", "full_document_permitted"]
      .includes(governance.cachePolicy)
    || !["ninety_days", "durable_public_corpus", "license_term"]
      .includes(governance.retentionPolicy)
    || !["immutable_revision", "revalidate_30d", "revalidate_90d"]
      .includes(governance.freshnessPolicy)
    || !canonicalOptionalInstant(governance.freshnessExpiresAt)
    || !canonicalOptionalInstant(governance.acquiredAt)
    || !canonicalOptionalInstant(governance.revokedAt)
    || !/^[0-9a-f]{64}$/u.test(governance.sourceHash)
    || !/^[0-9a-f]{64}$/u.test(governance.sourceRevision)
    || governance.sourceRevision !== governance.sourceHash
    || (governance.revokedAt !== undefined
      && governance.revokedAt !== null)) return false;
  return governance.useScope === "durable_corpus"
    ? governance.licenseState !== "citation_only"
      && ["durable_public_corpus", "license_term"].includes(governance.retentionPolicy)
    : governance.retentionPolicy === "ninety_days";
}

export function publicTrackScopeAttestationV3(
  sourceUrl: string,
  hostedEvidenceSnapshot?: HostedWebEvidenceSnapshotV3,
): Extract<EvidenceEligibilityAttestationV3, { kind: "approved_exact_track_scope_source" }> {
  const normalizedUrl = assertPublicHttpsUrl(sourceUrl).toString();
  if (hostedEvidenceSnapshot
    && (!hostedWebEvidenceSnapshotIsValidV3(hostedEvidenceSnapshot)
      || hostedEvidenceSnapshot.sourceUrl !== normalizedUrl)) {
    throw new Error("Hosted evidence attestation snapshot is invalid");
  }
  return Object.freeze({
    schemaVersion: PIPELINE_V3_EVIDENCE_ATTESTATION_SCHEMA,
    kind: "approved_exact_track_scope_source",
    exactTrackScope: true,
    providerAttested: true,
    sourcePolicyVersion: "evidence-source-governance-v3",
    sourceUrlHash: sha256EvidenceValue(normalizedUrl),
    ...(hostedEvidenceSnapshot
      ? { sourceSnapshotHash: hostedEvidenceSnapshot.snapshotHash }
      : {}),
  });
}

export function evidenceBindingIsAttestedForSelectionV3(
  binding: EvidenceBindingReferenceV3 | null | undefined,
  context: EvidenceAttestationValidationContextV3 = {},
): binding is EvidenceBindingReferenceV3 & { eligibilityAttestation: EvidenceEligibilityAttestationV3 } {
  if (!binding
    || typeof binding !== "object"
    || Array.isArray(binding)
    || !evidenceBindingHasBoundedShapeV3(binding)
    || !nonEmpty(binding.id)
    || binding.id.length > 240
    || !nonEmpty(binding.provenanceRoot)
    || binding.provenanceRoot.length > 240
    || !evidenceSourceGovernanceIsApprovedV3(binding.governance)
    || !evidenceEligibilityAttestationIsValidShapeV3(
      binding.eligibilityAttestation,
    )) return false;
  const requiredObligationIds = canonicalEvidenceIds(
    context.requiredObligationIds ?? [],
  );
  const bindingObligationIds = canonicalEvidenceIds(
    binding.predicateIds ?? binding.supportedPredicateIds ?? [],
  );
  if (requiredObligationIds.some((id) => !bindingObligationIds.includes(id))) {
    return false;
  }
  if (binding.governance.freshnessPolicy !== "immutable_revision"
    && binding.governance.freshnessExpiresAt !== undefined) {
    const expiresAt = Date.parse(binding.governance.freshnessExpiresAt ?? "");
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
  }
  let normalizedUrl: string;
  try {
    if (!binding.url) return false;
    normalizedUrl = assertPublicHttpsUrl(binding.url).toString();
  } catch {
    return false;
  }
  const attestation = binding.eligibilityAttestation;
  if (attestation.kind === "approved_exact_track_scope_source") {
    const hostedSnapshotRequired = context.requireHostedEvidenceSnapshot === true
      && binding.governance.accessMethod === "hosted_web_search";
    const snapshot = binding.hostedEvidenceSnapshot;
    const hostedSnapshotValid = !hostedSnapshotRequired && !snapshot
      ? true
      : hostedWebEvidenceSnapshotIsValidV3(snapshot, context)
        && snapshot.sourceUrl === normalizedUrl
        && binding.governance.accessMethod === "hosted_web_search"
        && binding.governance.sourceHash === snapshot.snapshotHash
        && binding.governance.sourceRevision === snapshot.snapshotHash
        && binding.governance.acquiredAt === snapshot.acquiredAt
        && binding.governance.freshnessExpiresAt
          === snapshot.freshnessExpiresAt
        && binding.governance.revokedAt === snapshot.revokedAt
        && attestation.sourceSnapshotHash === snapshot.snapshotHash
        && JSON.stringify(canonicalEvidenceIds(
          binding.predicateIds ?? binding.supportedPredicateIds ?? [],
        )) === JSON.stringify(snapshot.predicateIds);
    return attestation.exactTrackScope === true
      && attestation.providerAttested === true
      && attestation.sourcePolicyVersion === binding.governance.policyVersion
      && attestation.sourceUrlHash === sha256EvidenceValue(normalizedUrl)
      && hostedSnapshotValid;
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
  context: EvidenceAttestationValidationContextV3 = {},
): Array<EvidenceBindingReferenceV3 & { eligibilityAttestation: EvidenceEligibilityAttestationV3 }> {
  const permittedIds = new Set(bindingIds.filter(nonEmpty));
  const attested = (bindings ?? []).filter(
    (binding): binding is EvidenceBindingReferenceV3 & { eligibilityAttestation: EvidenceEligibilityAttestationV3 } => (
      permittedIds.has(binding.id)
      && evidenceBindingIsAttestedForSelectionV3(binding, context)
    ),
  );
  return [...new Map(attested.map((binding) => [binding.id, binding])).values()];
}

export interface CanonicalRequiredEvidenceIntegrityV3 {
  readonly passed: boolean;
  readonly missingRequiredClauseIds: readonly string[];
  readonly unattestedEvidenceIds: readonly string[];
  readonly obligationMismatchClauseIds: readonly string[];
  readonly evidenceGradeMismatchClauseIds: readonly string[];
  readonly attestedBindings: readonly (
    EvidenceBindingReferenceV3 & {
      eligibilityAttestation: EvidenceEligibilityAttestationV3;
    }
  )[];
}

type CanonicalPredicateV3 = NonNullable<
  SelectionPlanV3["canonicalContractPolicy"]
>["trackPredicate"];
type CanonicalTriStateV3 = ReturnType<
  typeof evaluateCanonicalContractTrackV1
>["status"];

function canonicalInvertedStatusV3(
  status: CanonicalTriStateV3,
): CanonicalTriStateV3 {
  return status === "pass" ? "fail" : status === "fail" ? "pass" : "unknown";
}

function canonicalAllStatusV3(
  statuses: readonly CanonicalTriStateV3[],
): CanonicalTriStateV3 {
  if (statuses.includes("fail")) return "fail";
  return statuses.includes("unknown") ? "unknown" : "pass";
}

function canonicalAnyStatusV3(
  statuses: readonly CanonicalTriStateV3[],
): CanonicalTriStateV3 {
  if (statuses.includes("pass")) return "pass";
  return statuses.includes("unknown") ? "unknown" : "fail";
}

function canonicalPredicateStatusWithMaskedEvidenceProofV3(input: {
  predicate: CanonicalPredicateV3;
  clauseStatuses: Readonly<Record<string, CanonicalTriStateV3>>;
  unprovenClauseIds: ReadonlySet<string>;
  restoredClauseIds: ReadonlySet<string>;
}): CanonicalTriStateV3 {
  const evaluate = (predicate: CanonicalPredicateV3): CanonicalTriStateV3 => {
    if (predicate.op === "clause") {
      return input.unprovenClauseIds.has(predicate.clauseId)
        && !input.restoredClauseIds.has(predicate.clauseId)
        ? "unknown"
        : input.clauseStatuses[predicate.clauseId] ?? "unknown";
    }
    if (predicate.op === "not") {
      return canonicalInvertedStatusV3(evaluate(predicate.child));
    }
    if (predicate.op === "except") {
      return canonicalAllStatusV3([
        evaluate(predicate.base),
        canonicalInvertedStatusV3(canonicalAnyStatusV3(
          predicate.exceptions.map(evaluate),
        )),
      ]);
    }
    if (predicate.op === "alternative") {
      return canonicalAnyStatusV3(predicate.choices
        .slice()
        .sort((left, right) => (
          left.priority - right.priority || left.id.localeCompare(right.id)
        ))
        .map(({ predicate: choice }) => evaluate(choice)));
    }
    const children = predicate.children.map(evaluate);
    return predicate.op === "all"
      ? canonicalAllStatusV3(children)
      : canonicalAnyStatusV3(children);
  };
  return evaluate(input.predicate);
}

/**
 * Returns one inclusion-minimal set of unproven leaves whose facts the
 * currently passing Boolean tree actually relies on. Every unproven leaf is
 * masked simultaneously first. In particular, a policy-level reject/allow
 * cannot become a factual leaf that NOT or EXCEPT turns into proof.
 */
function canonicalEvidenceProofWitnessClauseIdsV3(input: {
  policy: NonNullable<SelectionPlanV3["canonicalContractPolicy"]>;
  assessments:
    | CandidateQualificationV3["canonicalClauseAssessments"]
    | QualifiedTrackV3["canonicalClauseAssessments"];
  unprovenClauseIds: ReadonlySet<string>;
}): Set<string> {
  const assessments = input.assessments ?? {};
  const baseline = evaluateCanonicalContractTrackV1({
    policy: input.policy,
    assessments,
  });
  if (!baseline.eligible || input.unprovenClauseIds.size === 0) {
    return new Set();
  }
  const ordered = input.policy.clauses
    .filter(({ id }) => input.unprovenClauseIds.has(id))
    // Prefer a branch where the caller supplied evidence, so a wrong
    // obligation is reported as such instead of an arbitrary empty sibling.
    .sort((left, right) => (
      (assessments[left.id]?.evidenceIds?.length ?? 0)
        - (assessments[right.id]?.evidenceIds?.length ?? 0)
      || left.id.localeCompare(right.id)
    ))
    .map(({ id }) => id);
  const statusWith = (
    restoredClauseIds: ReadonlySet<string>,
  ): CanonicalTriStateV3 => (
    canonicalPredicateStatusWithMaskedEvidenceProofV3({
      predicate: input.policy.trackPredicate,
      clauseStatuses: baseline.clauseStatuses,
      unprovenClauseIds: input.unprovenClauseIds,
      restoredClauseIds,
    })
  );
  if (statusWith(new Set()) === "pass") return new Set();
  let witness = new Set(ordered);
  for (const clauseId of ordered) {
    const withoutClause = new Set(witness);
    withoutClause.delete(clauseId);
    if (statusWith(withoutClause) === "pass") witness = withoutClause;
  }
  return witness;
}

/**
 * Proves every half of canonical external evidence: the assessment references
 * an attested binding, that exact binding is hash-bound to the clause it is
 * being used to satisfy, and its server-derived evidence grade is the exact
 * deterministic grade recorded by the assessment. A globally valid citation
 * cannot be borrowed for a different obligation or relabeled as a stronger
 * source class.
 */
export function canonicalRequiredEvidenceIntegrityV3(input: {
  policy: NonNullable<SelectionPlanV3["canonicalContractPolicy"]>;
  assessments:
    | CandidateQualificationV3["canonicalClauseAssessments"]
    | QualifiedTrackV3["canonicalClauseAssessments"];
  bindingIds: readonly string[];
  bindings: readonly EvidenceBindingReferenceV3[] | null | undefined;
  storefront: string;
}): CanonicalRequiredEvidenceIntegrityV3 {
  const attestedBindings = attestedEvidenceBindingsForSelectionV3(
    input.bindingIds,
    input.bindings,
    {
      requireHostedEvidenceSnapshot: true,
      storefront: input.storefront,
    },
  );
  const attestedIds = new Set(attestedBindings.map(({ id }) => id));
  const obligationBoundBindings = (
    clauseId: string,
    evidenceIds: readonly string[],
  ): typeof attestedBindings => {
    if (evidenceIds.length === 0) return [];
    const bound = attestedEvidenceBindingsForSelectionV3(
      evidenceIds,
      input.bindings,
      {
        requireHostedEvidenceSnapshot: true,
        storefront: input.storefront,
        requiredObligationIds: [clauseId],
      },
    );
    const byId = new Map(bound.map((binding) => [binding.id, binding]));
    return evidenceIds.every((evidenceId) => byId.has(evidenceId))
      ? evidenceIds.map((evidenceId) => byId.get(evidenceId)!)
      : [];
  };
  const assessments = input.assessments ?? {};
  const obligationBoundEvidence = (
    clauseId: string,
    evidenceIds: readonly string[],
  ): boolean => (
    evidenceIds.length > 0
    && obligationBoundBindings(clauseId, evidenceIds).length
      === evidenceIds.length
  );
  const evidenceIdsByClause = new Map<string, readonly string[]>();
  const derivedEvidenceGradeByClause = new Map<string, string | null>();
  const gradeEligibleClauseIds = new Set<string>();
  const unprovenClauseIds = new Set<string>();
  for (const clause of input.policy.clauses) {
    const assessment = assessments[clause.id];
    const evidenceIds = [...new Set(
      (assessment?.evidenceIds ?? [])
        .filter((id) => typeof id === "string" && id.trim().length > 0),
    )];
    evidenceIdsByClause.set(clause.id, evidenceIds);
    // The evidence-axis bridge clause is a meta-policy ("this selected track
    // has selection-grade evidence"), not a second factual claim about the
    // recording. Its cited binding must still be attested and grade-eligible,
    // while the factual leaf that makes the Boolean predicate pass remains
    // obligation-bound independently below.
    const evidencePolicyClause = clause.axis === "evidence";
    const gradeEligible = playlistEvidenceGradeSatisfiesObligationV1({
      grade: assessment?.evidenceGrade,
      obligation: clause.evidence,
      evidencePolicyVersion: input.policy.evidencePolicyVersion,
      strengthPolicyVersion: input.policy.evidenceStrengthPolicyVersion,
    });
    if (gradeEligible) gradeEligibleClauseIds.add(clause.id);
    const boundBindings = evidencePolicyClause
      ? evidenceIds.flatMap((evidenceId) => {
        const binding = attestedBindings.find(({ id }) => id === evidenceId);
        return binding ? [binding] : [];
      })
      : obligationBoundBindings(clause.id, evidenceIds);
    const derivedEvidenceGrade = boundBindings.length === evidenceIds.length
      && evidenceIds.length > 0
      ? selectQualifyingPlaylistEvidenceGradeV1({
          grades: boundBindings.map((binding) => (
            canonicalEvidenceGradeForBindingV1({
              kind: binding.kind,
              accessMethod: binding.governance.accessMethod,
            })
          )),
          obligation: clause.evidence,
          evidencePolicyVersion: input.policy.evidencePolicyVersion,
          strengthPolicyVersion:
            input.policy.evidenceStrengthPolicyVersion,
        })
      : null;
    derivedEvidenceGradeByClause.set(clause.id, derivedEvidenceGrade);
    const externalEvidenceGradeMatches = derivedEvidenceGrade !== null
      && derivedEvidenceGrade === assessment?.evidenceGrade;
    const permittedPositiveStructuredMetadataWithoutBinding =
      assessment?.status === "pass"
      && evidenceIds.length === 0
      && assessment.evidenceGrade
        === "authoritative_structured_metadata";
    const proofComplete = assessment?.status === "pass"
      ? gradeEligible && (
        permittedPositiveStructuredMetadataWithoutBinding
        || externalEvidenceGradeMatches
      )
      : assessment?.status === "fail"
        // A negative observation is never self-authenticating, including when
        // its asserted grade is structured/catalog metadata.
        ? gradeEligible && externalEvidenceGradeMatches
        : false;
    if (!proofComplete) unprovenClauseIds.add(clause.id);
  }
  const baseline = evaluateCanonicalContractTrackV1({
    policy: input.policy,
    assessments,
  });
  const evidentialPredicateStatus =
    canonicalPredicateStatusWithMaskedEvidenceProofV3({
      predicate: input.policy.trackPredicate,
      clauseStatuses: baseline.clauseStatuses,
      unprovenClauseIds,
      restoredClauseIds: new Set(),
    });
  const evidenceProofWitnessClauseIds =
    canonicalEvidenceProofWitnessClauseIdsV3({
      policy: input.policy,
      assessments,
      unprovenClauseIds,
    });
  const missingRequiredClauseIds: string[] = [];
  const unattestedEvidenceIds = new Set<string>();
  const obligationMismatchClauseIds: string[] = [];
  const evidenceGradeMismatchClauseIds: string[] = [];
  for (const clause of input.policy.clauses) {
    const assessment = assessments[clause.id];
    const evidenceIds = evidenceIdsByClause.get(clause.id) ?? [];
    for (const evidenceId of evidenceIds) {
      if (!attestedIds.has(evidenceId)) unattestedEvidenceIds.add(evidenceId);
    }
    const requiresExternalEvidence = (clause.evidence.required
      && assessment?.status === "pass"
      && !(assessment.evidenceGrade
          === "authoritative_structured_metadata"
        && evidenceIds.length === 0))
      || evidenceProofWitnessClauseIds.has(clause.id);
    if (!requiresExternalEvidence) continue;
    if (evidenceIds.length === 0
      || (evidenceProofWitnessClauseIds.has(clause.id)
        && !gradeEligibleClauseIds.has(clause.id))) {
      missingRequiredClauseIds.push(clause.id);
      continue;
    }
    if (clause.axis !== "evidence"
      && !obligationBoundEvidence(clause.id, evidenceIds)) {
      obligationMismatchClauseIds.push(clause.id);
      continue;
    }
    if (derivedEvidenceGradeByClause.get(clause.id)
      !== assessment?.evidenceGrade) {
      evidenceGradeMismatchClauseIds.push(clause.id);
    }
  }
  return {
    passed: evidentialPredicateStatus === "pass"
      && missingRequiredClauseIds.length === 0
      && unattestedEvidenceIds.size === 0
      && obligationMismatchClauseIds.length === 0
      && evidenceGradeMismatchClauseIds.length === 0,
    missingRequiredClauseIds,
    unattestedEvidenceIds: [...unattestedEvidenceIds],
    obligationMismatchClauseIds,
    evidenceGradeMismatchClauseIds,
    attestedBindings,
  };
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
  /** Catalog-derived year retained so resumed research rechecks hard eras. */
  readonly catalogReleaseYear?: number | null;
  /** Compatible issue years retained so resumed research preserves era proof. */
  readonly catalogCompatibleReleaseYears?: readonly number[];
  /** Frozen authoritative catalog labels used to re-evaluate quota rules. */
  readonly catalogGenreNames?: readonly string[];
  readonly sourceObservationIds: readonly string[];
  readonly evidenceBindingIds: readonly string[];
  readonly evidenceBindings?: readonly EvidenceBindingReferenceV3[];
  readonly discoveryDependencyIds?: readonly RetrievalUpstreamDependencyIdV3[];
  readonly provenanceRoots?: readonly string[];
  readonly cacheOrigin?:
    | "live"
    | "fresh_cache"
    | "governed_snapshot"
    | "orchestration_local"
    | "unknown";
  readonly sourceFreshUntil?: string | null;
  /** Retained so publication can re-evaluate the same immutable predicate. */
  readonly canonicalClauseAssessments?: Readonly<
    Record<string, CanonicalPlaylistContractClauseAssessmentV1>
  >;
  /** Ranking-only values retained so retries and publication revalidation are deterministic. */
  readonly playlistOptimizationSignals?: PlaylistOptimizationSignalsV3;
  /** Persisted verbatim through checkpoint, continuation, and publication. */
  readonly centralQualityCriterionObservations?:
    readonly CentralQualityCriterionObservationV3[];
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
  /**
   * The subset of qualified identities whose central-quality verdict remains
   * unknown. Keeping this separate from `qualifiedTrackSeeds` lets an
   * expansion retain its artist/catalog anchors after the quality evidence
   * gap has closed, without paying to judge the same recording twice.
   *
   * Optional only for protocol-compatible direct/test callers. The canonical
   * orchestrator always supplies it when a quality policy is active.
   */
  readonly qualityEvidenceTrackSeeds?: readonly {
    readonly artist: string;
    readonly title: string;
    readonly appleSongId: string;
    readonly recordingFamilyKey: string;
  }[];
  /**
   * Combines worker cancellation with the remaining active-compute window.
   * Live adapters must pass it to every provider request so one slow call
   * cannot run beyond the immutable contract's compute allowance.
   */
  readonly signal?: AbortSignal;
}

export interface DiscoveryBatchV3 {
  readonly candidates: readonly RawTrackCandidateV3[];
  readonly nextCursor: string | null;
  readonly exhausted: boolean;
  /** Hash-bound identity and enumeration truth for typed fixed containers. */
  readonly fixedContainerResolution?: FixedContainerResolutionProofV1;
  readonly providerCircuitOpen?: boolean;
  /** Opaque accounting units bounded by the orchestration policy. */
  readonly costUnits?: number;
  /**
   * Server-adapter-owned provenance. Candidate/provider metadata is untrusted
   * and cannot choose a cache classification or extend freshness.
   */
  readonly provenance?: {
    readonly cacheOrigin:
      | "live"
      | "fresh_cache"
      | "governed_snapshot"
      | "orchestration_local";
    readonly sourceFreshUntil: string | null;
  };
}

export interface QualificationRequestV3 {
  readonly runId: string;
  readonly executionMode: RetrievalExecutionModeV3;
  readonly appleWriteAccess: "forbidden";
  readonly plan: SelectionPlanV3;
  readonly engine: RetrievalEngineV3;
  readonly strategy: RetrievalStrategyDefinitionV3;
  readonly candidates: readonly RawTrackCandidateV3[];
  /** See DiscoveryRequestV3.signal. */
  readonly signal?: AbortSignal;
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
  | "stale_cache_lead"
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
  | "central_quality_failed"
  | "central_quality_unknown_excess"
  | "canonical_contract_failed"
  | "canonical_contract_unknown"
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
  | "central_quality_floor"
  | "playlist_optimization_constraints"
  | "integrity_failure";

export type RetrievalOutcomeStatusV3 =
  | "awaiting_guidance"
  | "exact_ready"
  | "partial_ready"
  | "needs_decision"
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
  readonly discoveryDependencyIds: readonly RetrievalUpstreamDependencyIdV3[];
  readonly qualificationDependencyIds: readonly RetrievalUpstreamDependencyIdV3[];
  readonly status: RetrievalStrategyStatusV3;
  readonly rounds: number;
  readonly rawCandidates: number;
  readonly newQualifiedFamilies: number;
  readonly consecutiveZeroQualifiedYieldRounds: number;
  readonly providerFailures: number;
  readonly cursor: string | null;
  readonly fixedContainerResolution?: FixedContainerResolutionProofV1;
}

export interface RetrievalDependencyOutageReportV3 {
  readonly dependencyId: RetrievalUpstreamDependencyIdV3;
  /** Typed cause retained through checkpoints and durable worker retries. */
  readonly failureClass?: RetrievalDependencyFailureClassV3;
  /**
   * Contiguous outages, not failed strategy calls. Repeated failures from
   * strategies sharing one still-unhealthy upstream remain one outage.
   */
  readonly outageCount: number;
  readonly failureAttempts: number;
  readonly active: boolean;
  readonly circuitOpen: boolean;
  /** Exact provider-owned retry boundary, retained as an absolute instant. */
  readonly retryAfterUntil?: string | null;
  readonly affectedStrategyIds: readonly string[];
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

export interface PlaylistOptimizationReportV3 {
  readonly policyVersion: PlaylistOptimizationResultV1["policyVersion"];
  readonly exact: boolean;
  readonly evidenceQualifiedCandidateCount: number;
  readonly unmetConstraints: readonly string[];
  readonly distinct: PlaylistOptimizationResultV1["distinct"];
  readonly familiarTrackCount: number;
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
  readonly dependencyOutages?: readonly RetrievalDependencyOutageReportV3[];
  readonly integrityEvents: readonly string[];
  readonly centralQuality?: CentralQualityReportV3;
  readonly playlistOptimization?: PlaylistOptimizationReportV3;
  readonly predicateDiagnostics?: RetrievalPredicateDiagnosticsV3;
  /** Immutable artifacts persisted with the retrieval boundary. */
  readonly semanticPlanRevisions?: readonly SemanticPlanRevisionArtifactV3[];
  readonly recoveryAudits?: readonly PipelineRecoveryAuditArtifactV3[];
  readonly candidateLeads?: readonly PipelineCandidateLeadArtifactV3[];
  readonly publicationBoundary: RetrievalPublicationBoundaryV3;
}

/**
 * Frozen input for the one permitted continuation pass. Only strategy ids
 * approved by the prior partial outcome may run, while already-qualified
 * recordings remain in the pool so the successor result is cumulative.
 */
export interface RetrievalContinuationSeedV3 {
  /** False for an optimizer-only successor lease; no discovery/qualification call may run. */
  readonly providerCallPermitted?: boolean;
  readonly approvedStrategyIds: readonly string[];
  /** Semantics-preserving active plan snapshot when recovery preceded compute retry. */
  readonly selectionPlan?: SelectionPlanV3;
  readonly qualifiedTracks: readonly QualifiedTrackV3[];
  readonly compatibleAlternatesByRecordingFamily: Readonly<Record<string, readonly QualifiedTrackV3[]>>;
  readonly stages: RetrievalStageCountersV3;
  readonly strategies: readonly RetrievalStrategyReportV3[];
}

export class RetrievalPlaylistOptimizationBudgetExceededErrorV3
  extends PlaylistOptimizationBudgetExceededErrorV1 {
  constructor(
    message: string,
    readonly retrySeed: RetrievalContinuationSeedV3,
  ) {
    super(message);
  }
}

export interface RetrievalPolicyV3 {
  readonly maximumGlobalRounds: number;
  /** Maximum genuinely independent discovery calls in one portfolio wave. */
  readonly maximumConcurrentDiscovery?: number;
  readonly maximumRawCandidates: number;
  /** Frozen pre-catalog/evidence discovery input target. */
  readonly candidateGoal?: number;
  /** Frozen qualified-pool goal; absent only on legacy/direct callers. */
  readonly qualifiedPoolGoal?: number;
  readonly maximumCostUnits: number;
  readonly deadlineAtEpochMs: number | null;
  readonly maximumProviderFailuresPerStrategy: number;
}

export const DEFAULT_RETRIEVAL_POLICY_V3: Readonly<RetrievalPolicyV3> = Object.freeze({
  maximumGlobalRounds: 60,
  maximumConcurrentDiscovery: 4,
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
  fixedContainerResolution: FixedContainerResolutionProofV1 | null;
}

interface MutableDependencyStateV3 {
  dependencyId: RetrievalUpstreamDependencyIdV3;
  outageCount: number;
  failureAttempts: number;
  active: boolean;
  circuitOpen: boolean;
  affectedStrategyIds: Set<string>;
  unresolvedStrategyIds: Set<string>;
  retryAfterUntilByStrategy: Map<string, Date>;
  failureClassByStrategy: Map<string, RetrievalDependencyFailureClassV3>;
}

type PendingDiscoveryAttemptV3 = {
  state: MutableStrategyStateV3;
  request: DiscoveryRequestV3;
  result:
    | { ok: true; batch: DiscoveryBatchV3 }
    | { ok: false; error: unknown };
};

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
  strategyId: string;
  discoveryDependencyIds: Set<RetrievalUpstreamDependencyIdV3>;
  provenanceRoots: Set<string>;
  cacheOrigin:
    | "live"
    | "fresh_cache"
    | "governed_snapshot"
    | "orchestration_local"
    | "unknown";
  sourceFreshUntil: string | null;
  predicateCoverage: Set<string>;
  rejectionCode: string | null;
}

const CACHE_ORIGINS_V3 = new Set([
  "live", "fresh_cache", "governed_snapshot", "orchestration_local",
]);

function discoveryCacheOriginV3(
  dependencyIds: readonly RetrievalUpstreamDependencyIdV3[],
  provenance: DiscoveryBatchV3["provenance"],
): RawCandidateLedgerEntryV3["cacheOrigin"] {
  if (dependencyIds.includes("governed_evidence_graph")) return "governed_snapshot";
  if (dependencyIds.length === 1 && dependencyIds[0] === "orchestration_local") {
    return "orchestration_local";
  }
  if (provenance && CACHE_ORIGINS_V3.has(provenance.cacheOrigin)) {
    return provenance.cacheOrigin;
  }
  // An adapter that omitted or malformed server-owned provenance has not
  // proved a live observation. Keep it explicitly unattributed so the
  // cache/concentration policy can fail closed; candidate-supplied metadata
  // is never consulted here.
  return "unknown";
}

function discoveryFreshUntilV3(
  provenance: DiscoveryBatchV3["provenance"],
  observedAtEpochMs = Date.now(),
): string | null {
  const value = provenance?.sourceFreshUntil;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > observedAtEpochMs
    ? new Date(parsed).toISOString()
    : null;
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

function normalizedOptimizationSignalKeys(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? [])
    .map((value) => value.normalize("NFKC").replace(/\s+/gu, " ").trim())
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

export function normalizePlaylistOptimizationSignalsV3(
  input: PlaylistOptimizationSignalsV3 | null | undefined,
): PlaylistOptimizationSignalsV3 | undefined {
  if (!input) return undefined;
  const bounded = (value: number | null | undefined): number | null => (
    typeof value === "number" && Number.isFinite(value)
      ? boundedFinite(value)
      : null
  );
  const chronologyPosition = typeof input.chronologyPosition === "number"
    && Number.isFinite(input.chronologyPosition)
    ? input.chronologyPosition
    : null;
  return {
    familiarityScore: bounded(input.familiarityScore),
    discoveryScore: bounded(input.discoveryScore),
    eraKeys: normalizedOptimizationSignalKeys(input.eraKeys),
    sceneKeys: normalizedOptimizationSignalKeys(input.sceneKeys),
    geographyKeys: normalizedOptimizationSignalKeys(input.geographyKeys),
    energy: bounded(input.energy),
    tempo: bounded(input.tempo),
    chronologyPosition,
  };
}

function mergePlaylistOptimizationSignalsV3(
  left: PlaylistOptimizationSignalsV3 | undefined,
  right: PlaylistOptimizationSignalsV3 | undefined,
): PlaylistOptimizationSignalsV3 | undefined {
  const normalizedLeft = normalizePlaylistOptimizationSignalsV3(left);
  const normalizedRight = normalizePlaylistOptimizationSignalsV3(right);
  if (!normalizedLeft) return normalizedRight;
  if (!normalizedRight) return normalizedLeft;
  const maximum = (a: number | null | undefined, b: number | null | undefined) => (
    a === null || a === undefined
      ? b ?? null
      : b === null || b === undefined
        ? a
        : Math.max(a, b)
  );
  const chronology = [normalizedLeft.chronologyPosition, normalizedRight.chronologyPosition]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b)[0] ?? null;
  return {
    familiarityScore: maximum(
      normalizedLeft.familiarityScore,
      normalizedRight.familiarityScore,
    ),
    discoveryScore: maximum(
      normalizedLeft.discoveryScore,
      normalizedRight.discoveryScore,
    ),
    eraKeys: normalizedOptimizationSignalKeys([
      ...(normalizedLeft.eraKeys ?? []),
      ...(normalizedRight.eraKeys ?? []),
    ]),
    sceneKeys: normalizedOptimizationSignalKeys([
      ...(normalizedLeft.sceneKeys ?? []),
      ...(normalizedRight.sceneKeys ?? []),
    ]),
    geographyKeys: normalizedOptimizationSignalKeys([
      ...(normalizedLeft.geographyKeys ?? []),
      ...(normalizedRight.geographyKeys ?? []),
    ]),
    energy: maximum(normalizedLeft.energy, normalizedRight.energy),
    tempo: maximum(normalizedLeft.tempo, normalizedRight.tempo),
    chronologyPosition: chronology,
  };
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
  if (track.cacheOrigin === "fresh_cache") {
    const expiresAt = Date.parse(track.sourceFreshUntil ?? "");
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return "stale_cache_lead";
    }
  }
  // Schema-4 catalog/version leaves are part of the canonical Boolean tree.
  // The legacy flattened version confidence is not an independent gate for
  // OR/NOT/EXCEPT contracts.
  if (!plan.canonicalContractPolicy && !(track.versionConfidence > 0)) {
    return "version_incompatible";
  }

  if (catalogEraConstraintFailuresV3(
    plan,
    track.catalogReleaseYear,
    track.catalogCompatibleReleaseYears,
  ).length > 0) {
    return "hard_constraint_failed";
  }

  const bindings = attestedEvidenceBindingsForSelectionV3(
    track.evidenceBindingIds,
    track.evidenceBindings,
    plan.canonicalContractPolicy ? {
      requireHostedEvidenceSnapshot: true,
      storefront: plan.storefront,
    } : {},
  );
  if (plan.canonicalContractPolicy) {
    const evaluation = evaluateCanonicalContractTrackV1({
      policy: plan.canonicalContractPolicy,
      assessments: track.canonicalClauseAssessments ?? {},
    });
    if (!evaluation.eligible) {
      return evaluation.status === "unknown"
        ? "canonical_contract_unknown"
        : "canonical_contract_failed";
    }
    const evidenceIntegrity = canonicalRequiredEvidenceIntegrityV3({
      policy: plan.canonicalContractPolicy,
      assessments: track.canonicalClauseAssessments,
      bindingIds: track.evidenceBindingIds,
      bindings: track.evidenceBindings,
      storefront: plan.storefront,
    });
    if (!evidenceIntegrity.passed) {
      return "evidence_attestation_missing";
    }
    return null;
  }
  if (bindings.length === 0) return "evidence_attestation_missing";
  const supportedPredicates = new Set(bindings.flatMap(bindingPredicateIds));
  if (positiveMembershipPredicateIds(plan).some((id) => !supportedPredicates.has(id))) {
    return "scope_membership_failed";
  }

  for (const constraint of plan.hardConstraints) {
    if (constraint.operator === "maximum") continue;
    // Era is fully evaluated from immutable catalog metadata above. It is not
    // source prose and must not fall through to artist/title matching.
    if (constraint.axis === "era") continue;
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
  const centralQualityCriterionObservations = [...new Map([
    ...(existing.centralQualityCriterionObservations ?? []),
    ...(incoming.centralQualityCriterionObservations ?? []),
  ].map((observation) => [observation.observationId, observation])).values()]
    .sort((left, right) => left.observationId.localeCompare(right.observationId));
  const provenanceRoots = new Set(bindings.map(({ provenanceRoot }) => provenanceRoot)).size;
  const canonicalReleaseYear = (candidateReleaseYear: number | null, compatibleReleaseYears: readonly number[]) => (
    [candidateReleaseYear, ...compatibleReleaseYears]
      .filter((year): year is number => Number.isInteger(year) && year !== null)
      .sort((left, right) => left - right)[0] ?? null
  );
  const beforeCanonicalReleaseYear = canonicalReleaseYear(
    existing.catalogReleaseYear ?? null,
    existing.catalogCompatibleReleaseYears ?? [],
  );
  const track: QualifiedTrackV3 = {
    ...existing,
    catalogReleaseYear: existing.catalogReleaseYear ?? incoming.catalogReleaseYear ?? null,
    catalogCompatibleReleaseYears: [...new Set([
      ...(existing.catalogCompatibleReleaseYears ?? []),
      ...(incoming.catalogCompatibleReleaseYears ?? []),
    ])].sort((left, right) => left - right),
    album: existing.album ?? incoming.album,
    sourceObservationIds: observations,
    evidenceBindingIds: bindingIds,
    evidenceBindings: bindings,
    discoveryDependencyIds: [...new Set([
      ...(existing.discoveryDependencyIds ?? []),
      ...(incoming.discoveryDependencyIds ?? []),
    ])].sort(),
    provenanceRoots: [...new Set([
      ...(existing.provenanceRoots ?? []),
      ...(incoming.provenanceRoots ?? []),
      ...bindings.map(({ provenanceRoot }) => provenanceRoot),
    ])].sort(),
    cacheOrigin: existing.cacheOrigin === "live" || incoming.cacheOrigin === "live"
      ? "live"
      : existing.cacheOrigin === "fresh_cache" || incoming.cacheOrigin === "fresh_cache"
        ? "fresh_cache"
        : existing.cacheOrigin === "governed_snapshot"
            || incoming.cacheOrigin === "governed_snapshot"
          ? "governed_snapshot"
          : existing.cacheOrigin === "orchestration_local"
              || incoming.cacheOrigin === "orchestration_local"
            ? "orchestration_local"
            : "unknown",
    sourceFreshUntil: [
      existing.sourceFreshUntil,
      incoming.sourceFreshUntil,
    ].filter((value): value is string => typeof value === "string")
      .sort()[0] ?? null,
    canonicalClauseAssessments: existing.canonicalClauseAssessments
      ? structuredClone(existing.canonicalClauseAssessments)
      : incoming.canonicalClauseAssessments
        ? structuredClone(incoming.canonicalClauseAssessments)
        : undefined,
    playlistOptimizationSignals: mergePlaylistOptimizationSignalsV3(
      existing.playlistOptimizationSignals,
      incoming.playlistOptimizationSignals,
    ),
    ...(centralQualityCriterionObservations.length > 0 ? {
      centralQualityCriterionObservations,
    } : {}),
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
  const afterCanonicalReleaseYear = canonicalReleaseYear(
    track.catalogReleaseYear ?? null,
    track.catalogCompatibleReleaseYears ?? [],
  );
  return {
    track,
    improved: observations.length > existing.sourceObservationIds.length
      || bindingIds.length > existing.evidenceBindingIds.length
      || (afterCanonicalReleaseYear !== null && (
        beforeCanonicalReleaseYear === null
        || afterCanonicalReleaseYear < beforeCanonicalReleaseYear
      ))
      || track.evidenceStrength > existing.evidenceStrength
      || track.scopeFit > existing.scopeFit
      || track.independentProvenanceRoots > existing.independentProvenanceRoots
      || track.versionConfidence > existing.versionConfidence
      || track.catalogConfidence > existing.catalogConfidence
      || track.sourceRank < existing.sourceRank
      || centralQualityCriterionObservations.length
        > (existing.centralQualityCriterionObservations?.length ?? 0)
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

function catalogQualityIdentityKey(
  appleSongId: string,
  recordingFamilyKey: string,
): string {
  return `${recordingFamilyKey}\u0000${appleSongId}`;
}

function mergeCatalogBoundQualityIntoFamily(
  families: Map<string, RecordingFamilyEntryV3>,
  input: {
    appleSongId: string;
    recordingFamilyKey: string;
    observations: readonly CentralQualityCriterionObservationV3[];
  },
): boolean {
  if (input.observations.length === 0) return false;
  const family = families.get(input.recordingFamilyKey);
  if (!family) return false;
  const variants = [family.primary, ...family.alternates];
  const index = variants.findIndex(({ appleSongId, recordingFamilyKey }) => (
    appleSongId === input.appleSongId
    && recordingFamilyKey === input.recordingFamilyKey
  ));
  if (index < 0) return false;
  const existing = variants[index]!;
  const observations = [...new Map([
    ...(existing.centralQualityCriterionObservations ?? []),
    ...input.observations,
  ].map((observation) => [observation.observationId, observation])).values()]
    .sort((left, right) => left.observationId.localeCompare(right.observationId));
  if (observations.length
    === (existing.centralQualityCriterionObservations?.length ?? 0)) {
    return false;
  }
  variants[index] = {
    ...existing,
    centralQualityCriterionObservations: observations,
  };
  family.primary = variants[0]!;
  family.alternates = variants.slice(1);
  return true;
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

function minimumNullable(...values: Array<number | null | undefined>): number | null {
  const candidates = values.filter(
    (value): value is number => Number.isSafeInteger(value) && Number(value) >= 0,
  );
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

function canonicalPassedValuesForAxesV3(
  track: QualifiedTrackV3,
  plan: SelectionPlanV3,
  axes: readonly string[],
): string[] {
  const acceptedAxes = new Set(axes);
  const assessments = track.canonicalClauseAssessments ?? {};
  return normalizedOptimizationSignalKeys(
    (plan.canonicalContractPolicy?.clauses ?? []).flatMap((clause) => (
      clause.operator === "require"
      && acceptedAxes.has(clause.axis)
      && assessments[clause.id]?.status === "pass"
        ? clause.values
        : []
    )),
  );
}

function familiarityBoundsV3(
  plan: SelectionPlanV3,
  target: number,
): { minimum: number; maximum: number } {
  const text = plan.rankingObjectives
    .flatMap(({ values }) => values)
    .join(" ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US");
  if (/\b(?:balanced|anchors?|recognizable anchors?)\b/u.test(text)) {
    return {
      minimum: Math.min(target, Math.max(1, Math.ceil(target * 0.2))),
      maximum: Math.max(1, Math.floor(target * 0.6)),
    };
  }
  if (/\b(?:obscure|deep cuts?|strict documented rarity|genuinely rare)\b/u.test(text)) {
    return { minimum: 0, maximum: Math.floor(target * 0.25) };
  }
  if (/\b(?:familiar|landmarks?|staples?|widely recognized|canonical hits?)\b/u.test(text)) {
    return { minimum: Math.ceil(target * 0.6), maximum: target };
  }
  return { minimum: 0, maximum: target };
}

function playlistOptimizationConstraintsV3(
  plan: SelectionPlanV3,
  target: number,
): PlaylistOptimizationConstraintsV1 {
  const hardArtistMaximum = maximumConstraint(plan.hardConstraints, "artist", "hard");
  const hardAlbumMaximum = maximumConstraint(plan.hardConstraints, "album", "hard");
  const familiarity = familiarityBoundsV3(plan, target);
  const quality = plan.playlistQualityPolicy;
  const openWorldCurated = plan.scopeKind === "broad_curated";
  // Canonical projections have no relaxation ladder: every non-null goal was
  // compiled from an immutable playlist clause. A legacy plan with a policy
  // overlaid during mixed-version drain keeps its historical soft goals.
  const immutableDiversity = plan.softGoalRelaxationOrder.length === 0;
  return {
    targetTrackCount: target,
    maximumTracksPerArtist: minimumNullable(
      hardArtistMaximum,
      immutableDiversity ? plan.diversityGoals.maximumTracksPerArtist : null,
    ),
    maximumTracksPerAlbum: minimumNullable(
      hardAlbumMaximum,
      immutableDiversity ? plan.diversityGoals.maximumTracksPerAlbum : null,
    ),
    // These portfolio concentration guards protect open-world curation. A
    // fixed container, artist catalogue, or factual enumeration can
    // legitimately come from one authoritative source/dependency and must not
    // be converted into a false policy shortfall for doing so.
    maximumTracksPerSource: openWorldCurated
      ? Math.max(2, Math.ceil(target * 0.6))
      : null,
    maximumTracksPerDependency: openWorldCurated
      ? Math.max(3, Math.ceil(target * 0.85))
      : null,
    maximumFreshCacheTracks: openWorldCurated
      ? Math.max(1, Math.floor(target * 0.5))
      : null,
    minimumDistinctArtists: immutableDiversity
      ? Math.max(0, plan.diversityGoals.minimumDistinctArtists ?? 0)
      : 0,
    minimumDistinctAlbums: immutableDiversity
      ? Math.max(0, plan.diversityGoals.minimumDistinctAlbums ?? 0)
      : 0,
    minimumDistinctEras: immutableDiversity
      ? Math.max(0, plan.diversityGoals.minimumDistinctEras ?? 0)
      : 0,
    minimumDistinctScenes: immutableDiversity
      ? Math.max(0, plan.diversityGoals.minimumDistinctScenes ?? 0)
      : 0,
    minimumDistinctGeographies: Math.max(
      0,
      immutableDiversity ? plan.diversityGoals.minimumDistinctGeographies ?? 0 : 0,
    ),
    minimumFamiliarTracks: familiarity.minimum,
    maximumFamiliarTracks: familiarity.maximum,
    minimumCentralQualityPassTracks: quality
      ? Math.ceil(target * quality.minimumPassRatio)
      : 0,
    maximumCentralQualityUnknownTracks: quality
      ? Math.floor(target * quality.maximumUnknownRatio)
      : target,
    zeroCentralQualityFailures: quality?.zeroKnownFailures ?? false,
    canonicalQuotaRules: (plan.playlistQuotaRules ?? []).map((rule) => ({
      id: rule.id,
      minimumCount: Math.max(
        rule.minimumCount ?? 0,
        rule.minimumRatio === null ? 0 : Math.ceil(target * rule.minimumRatio),
      ),
      maximumCount: Math.min(
        target,
        rule.maximumCount ?? target,
        rule.maximumRatio === null ? target : Math.floor(target * rule.maximumRatio),
      ),
    })),
    sequencingMode: plan.orderingPolicy.mode,
    avoidAdjacentSameArtist: plan.orderingPolicy.avoidAdjacentSameArtist,
    avoidAdjacentSameAlbum: plan.orderingPolicy.avoidAdjacentSameAlbum,
  };
}

function playlistOptimizationCandidateV3(
  track: QualifiedTrackV3,
  plan: SelectionPlanV3,
): PlaylistOptimizationCandidateV1 {
  const signals = normalizePlaylistOptimizationSignalsV3(track.playlistOptimizationSignals);
  const releaseYear = signals?.chronologyPosition
    ?? track.catalogReleaseYear
    ?? track.catalogCompatibleReleaseYears?.[0]
    ?? null;
  const derivedEra = typeof releaseYear === "number" && Number.isFinite(releaseYear)
    ? [`${Math.floor(releaseYear / 10) * 10}s`]
    : [];
  const familiarityScore = signals?.familiarityScore
    ?? (typeof track.rankingSignals.influence === "number"
      ? boundedFinite(track.rankingSignals.influence)
      : null);
  const provenanceRoots = normalizedOptimizationSignalKeys(
    track.provenanceRoots,
  );
  const evidenceProvenanceRoots = normalizedOptimizationSignalKeys(
    track.evidenceBindings?.map(({ provenanceRoot }) => provenanceRoot),
  );
  const dependencyIds = normalizedOptimizationSignalKeys(
    track.discoveryDependencyIds,
  );
  return {
    id: track.candidateId,
    recordingFamilyKey: track.recordingFamilyKey,
    sourceOrder: Number.isSafeInteger(track.sourceRank) && track.sourceRank >= 0
      ? track.sourceRank
      : Number.MAX_SAFE_INTEGER,
    artistKey: normalizeIdentity(track.artist),
    albumKey: track.album ? normalizeIdentity(`${track.artist}\u0000${track.album}`) : null,
    relevanceScore: boundedFinite(
      track.rankingSignals.relevance ?? track.scopeFit,
      track.scopeFit,
    ),
    familiarityScore,
    discoveryScore: signals?.discoveryScore
      ?? (familiarityScore === null ? null : 1 - familiarityScore),
    eraKeys: normalizedOptimizationSignalKeys([
      ...(signals?.eraKeys ?? []),
      ...derivedEra,
      ...canonicalPassedValuesForAxesV3(track, plan, ["era"]),
    ]),
    sceneKeys: normalizedOptimizationSignalKeys([
      ...(signals?.sceneKeys ?? []),
      ...canonicalPassedValuesForAxesV3(track, plan, ["scene", "subgenre"]),
    ]),
    geographyKeys: normalizedOptimizationSignalKeys([
      ...(signals?.geographyKeys ?? []),
      ...canonicalPassedValuesForAxesV3(track, plan, ["geography"]),
    ]),
    sourceKeys: provenanceRoots.length > 0
      ? provenanceRoots
      : evidenceProvenanceRoots.length > 0
        ? evidenceProvenanceRoots
        : ["__unattributed_source"],
    dependencyKeys: dependencyIds.length > 0
      ? dependencyIds
      : ["__unattributed_dependency"],
    cacheOrigin: track.cacheOrigin ?? "unknown",
    energy: signals?.energy ?? null,
    tempo: signals?.tempo ?? null,
    chronologyPosition: releaseYear,
    centralQualityVerdict: plan.playlistQualityPolicy
      ? centralQualityVerdictV3(track, plan.playlistQualityPolicy)
      : "pass",
    canonicalQuotaRuleIds: (plan.playlistQuotaRules ?? []).filter((rule) => (
      trackMatchesCanonicalQuotaV3(track, rule, plan.canonicalContractPolicy)
    )).map(({ id }) => id),
  };
}

function playlistOptimizationReportV3(
  result: PlaylistOptimizationResultV1,
  evidenceQualifiedCandidateCount: number,
  additionalUnmetConstraints: readonly string[] = [],
): PlaylistOptimizationReportV3 {
  const unmetConstraints = [...new Set([
    ...result.unmetConstraints,
    ...additionalUnmetConstraints,
  ])];
  return {
    policyVersion: result.policyVersion,
    exact: result.exact && additionalUnmetConstraints.length === 0,
    evidenceQualifiedCandidateCount,
    unmetConstraints,
    distinct: result.distinct,
    familiarTrackCount: result.familiarTrackCount,
  };
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
    .filter((value) => Number.isSafeInteger(value) && value >= 0);
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

function quotaText(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function trackMatchesCanonicalQuotaV3(
  track: QualifiedTrackV3,
  rule: CanonicalPlaylistQuotaRule,
  policy?: SelectionPlanV3["canonicalContractPolicy"],
): boolean {
  if (rule.predicate && policy) {
    return evaluateCanonicalContractPredicateV1({
      policy,
      predicate: rule.predicate,
      assessments: track.canonicalClauseAssessments ?? {},
    }) === "pass";
  }
  if (rule.axis !== "genre"
    || rule.evidenceGrade !== "authoritative_structured_metadata") {
    return false;
  }
  const genres = (track.catalogGenreNames ?? []).map(quotaText).filter(Boolean);
  return rule.values.some((value) => {
    const expected = quotaText(value);
    if (!expected) return false;
    return genres.some((genre) => (
      genre === expected
      || genre.startsWith(`${expected} `)
      || genre.endsWith(` ${expected}`)
      || genre.includes(` ${expected} `)
    ));
  });
}

export class CanonicalQuotaOptimizationBudgetExceededErrorV3
  extends PlaylistOptimizationBudgetExceededErrorV1 {
}

/**
 * Enforce the immutable distribution rules without filler. The deterministic
 * optimizer supports intersecting quotas; if the ranked pool cannot produce
 * the requested size, it returns the largest proven-compliant partial.
 *
 * Quota selection is a bounded 0/1 feasibility problem. A one-rule-at-a-time
 * swap repair can oscillate between overlapping rules (for example A-only and
 * B-only) even when A+B or an A/B intersection is feasible. The exact search
 * below considers the complete rule vector at every branch, includes stronger
 * ranked candidates first, and prunes branches that can no longer reach a
 * lower bound or avoid an upper bound. A bounded, strictly improving repair is
 * retained for unusually large/adversarial pools after the exact node budget
 * is exhausted. That fallback never returns a non-compliant set and cannot
 * oscillate because every accepted swap strictly decreases total violation.
 */
export function selectWithCanonicalQuotaV3(input: {
  ranked: readonly QualifiedTrackV3[];
  target: number;
  rules: readonly CanonicalPlaylistQuotaRule[];
  policy?: SelectionPlanV3["canonicalContractPolicy"];
}): QualifiedTrackV3[] {
  if (input.rules.length === 0) return input.ranked.slice(0, input.target);
  const matches = input.ranked.map((track) => (
    input.rules.map((rule) => trackMatchesCanonicalQuotaV3(track, rule, input.policy))
  ));
  const bounds = (total: number, rule: CanonicalPlaylistQuotaRule) => ({
    minimum: Math.max(
      rule.minimumCount ?? 0,
      rule.minimumRatio === null ? 0 : Math.ceil(total * rule.minimumRatio),
    ),
    maximum: Math.min(
      rule.maximumCount ?? total,
      rule.maximumRatio === null ? total : Math.floor(total * rule.maximumRatio),
    ),
  });
  const countsForIndices = (selected: readonly number[]) => input.rules.map((_, ruleIndex) => (
    selected.reduce(
      (count, trackIndex) => count + (matches[trackIndex]?.[ruleIndex] ? 1 : 0),
      0,
    )
  ));
  const compliant = (selected: readonly number[], total: number) => {
    const observed = countsForIndices(selected);
    return input.rules.every((rule, index) => {
      const limit = bounds(total, rule);
      return limit.minimum <= limit.maximum
        && observed[index]! >= limit.minimum
        && observed[index]! <= limit.maximum;
    });
  };

  const suffixMatches = input.rules.map((_, ruleIndex) => {
    const suffix = new Array<number>(input.ranked.length + 1).fill(0);
    for (let index = input.ranked.length - 1; index >= 0; index -= 1) {
      suffix[index] = suffix[index + 1]! + (matches[index]?.[ruleIndex] ? 1 : 0);
    }
    return suffix;
  });
  const activeBudget = activePlaylistOptimizationBudgetV1();
  let remainingExactNodes = activeBudget.maximumExactNodes;
  let remainingRepairEvaluations = activeBudget.maximumExactWorkUnits;
  let optimizationBudgetExhausted = false;

  const exactSelection = (total: number): {
    selected: number[] | null;
    exhausted: boolean;
  } => {
    const limits = input.rules.map((rule) => bounds(total, rule));
    if (limits.some(({ minimum, maximum }) => minimum > maximum)) {
      return { selected: null, exhausted: false };
    }
    const globallyInfeasible = limits.some((limit, ruleIndex) => {
      const matching = suffixMatches[ruleIndex]![0]!;
      const nonMatching = input.ranked.length - matching;
      return Math.min(total, matching) < limit.minimum
        || Math.max(0, total - nonMatching) > limit.maximum;
    });
    if (globallyInfeasible) return { selected: null, exhausted: false };
    const selected: number[] = [];
    const observed = input.rules.map(() => 0);
    let exhausted = false;

    const search = (index: number): boolean => {
      remainingExactNodes -= 1;
      if (remainingExactNodes < 0) {
        exhausted = true;
        optimizationBudgetExhausted = true;
        return false;
      }
      const needed = total - selected.length;
      const available = input.ranked.length - index;
      if (needed < 0 || available < needed) return false;
      for (let ruleIndex = 0; ruleIndex < input.rules.length; ruleIndex += 1) {
        const limit = limits[ruleIndex]!;
        const current = observed[ruleIndex]!;
        if (current > limit.maximum) return false;
        const matchingAvailable = suffixMatches[ruleIndex]![index]!;
        if (current + Math.min(needed, matchingAvailable) < limit.minimum) return false;
        const nonMatchingAvailable = available - matchingAvailable;
        const forcedAdditionalMatches = Math.max(0, needed - nonMatchingAvailable);
        if (current + forcedAdditionalMatches > limit.maximum) return false;
      }
      if (needed === 0) return true;
      if (index >= input.ranked.length) return false;

      // Include-first DFS returns the lexicographically earliest ranked
      // feasible subset, preserving the immutable rank preference exactly.
      selected.push(index);
      for (let ruleIndex = 0; ruleIndex < input.rules.length; ruleIndex += 1) {
        if (matches[index]?.[ruleIndex]) observed[ruleIndex]! += 1;
      }
      if (search(index + 1)) return true;
      for (let ruleIndex = 0; ruleIndex < input.rules.length; ruleIndex += 1) {
        if (matches[index]?.[ruleIndex]) observed[ruleIndex]! -= 1;
      }
      selected.pop();
      if (exhausted) return false;
      return search(index + 1);
    };

    return search(0)
      ? { selected: [...selected], exhausted: false }
      : { selected: null, exhausted };
  };

  const violation = (
    selected: readonly number[],
    total: number,
  ): number => {
    const observed = countsForIndices(selected);
    return input.rules.reduce((score, rule, index) => {
      const limit = bounds(total, rule);
      if (limit.minimum > limit.maximum) return score + total + 1;
      return score
        + Math.max(0, limit.minimum - observed[index]!)
        + Math.max(0, observed[index]! - limit.maximum);
    }, 0);
  };

  const deterministicRepair = (total: number): number[] | null => {
    const selected = Array.from({ length: total }, (_, index) => index);
    if (selected.length !== total) return null;
    let currentViolation = violation(selected, total);
    if (currentViolation === 0) return selected;
    const selectedSet = new Set(selected);
    const maximumRounds = Math.max(1, input.rules.length * total * 2);
    const MAX_SWAP_EVALUATIONS_PER_ROUND = 250_000;
    for (let round = 0; round < maximumRounds; round += 1) {
      if (remainingRepairEvaluations <= 0) break;
      let best: { outgoing: number; incoming: number; score: number } | null = null;
      let evaluated = 0;
      // Consider weaker selected ranks first for removal, while considering
      // stronger outside ranks first for admission. Ties therefore remain
      // deterministic and minimize rank loss.
      for (let outgoingIndex = selected.length - 1; outgoingIndex >= 0; outgoingIndex -= 1) {
        const outgoing = selected[outgoingIndex]!;
        for (let incoming = 0; incoming < input.ranked.length; incoming += 1) {
          if (selectedSet.has(incoming)) continue;
          evaluated += 1;
          remainingRepairEvaluations -= 1;
          if (evaluated > MAX_SWAP_EVALUATIONS_PER_ROUND
            || remainingRepairEvaluations < 0) break;
          const proposal = [...selected];
          proposal[outgoingIndex] = incoming;
          proposal.sort((left, right) => left - right);
          const score = violation(proposal, total);
          if (score < currentViolation && (
            best === null
            || score < best.score
            || (score === best.score && incoming < best.incoming)
            || (score === best.score && incoming === best.incoming && outgoing > best.outgoing)
          )) {
            best = { outgoing, incoming, score };
          }
        }
        if (evaluated > MAX_SWAP_EVALUATIONS_PER_ROUND
          || remainingRepairEvaluations < 0) break;
      }
      if (!best) break;
      selectedSet.delete(best.outgoing);
      selectedSet.add(best.incoming);
      const position = selected.indexOf(best.outgoing);
      selected[position] = best.incoming;
      selected.sort((left, right) => left - right);
      currentViolation = best.score;
      if (currentViolation === 0) return selected;
    }
    return null;
  };

  for (let total = Math.min(input.target, input.ranked.length); total > 0; total -= 1) {
    if (remainingExactNodes <= 0) optimizationBudgetExhausted = true;
    const exact = remainingExactNodes > 0
      ? exactSelection(total)
      : { selected: null, exhausted: true };
    if (exact.selected && compliant(exact.selected, total)) {
      return exact.selected.map((index) => input.ranked[index]!);
    }
    if (exact.exhausted || remainingExactNodes <= 0) {
      const repaired = deterministicRepair(total);
      if (repaired && compliant(repaired, total)) {
        return repaired.map((index) => input.ranked[index]!);
      }
    }
  }
  // An optimizer budget is an operational boundary, never evidence that the
  // musical contract is infeasible. Surface it as retryable/technical work
  // instead of falsely returning an empty policy result.
  if (optimizationBudgetExhausted) {
    throw new CanonicalQuotaOptimizationBudgetExceededErrorV3(
      "Canonical quota optimization exhausted its bounded search budget",
    );
  }
  return [];
}

export type CentralQualityVerdictV3 = "pass" | "fail" | "unknown";

export interface CentralQualityReportV3 {
  readonly policyVersion: "canonical_central_quality_v1";
  readonly criteria: readonly string[];
  readonly passed: boolean;
  readonly passCount: number;
  readonly failCount: number;
  readonly unknownCount: number;
  readonly passRatio: number;
  readonly unknownRatio: number;
  readonly reasonCodes: readonly string[];
}

export function centralQualityVerdictV3(
  track: QualifiedTrackV3,
  policy: CanonicalPlaylistQualityPolicy,
): CentralQualityVerdictV3 {
  const observations = centralQualityCriterionObservationsForPolicyV3({
    observations: track.centralQualityCriterionObservations,
    policy,
    artist: track.artist,
    title: track.title,
    album: track.album,
    appleSongId: track.appleSongId,
    recordingFamilyKey: track.recordingFamilyKey,
  });
  const byCriterion = new Map<string, CentralQualityCriterionVerdictV3[]>();
  for (const observation of observations) {
    byCriterion.set(observation.criterion, [
      ...(byCriterion.get(observation.criterion) ?? []),
      observation.verdict,
    ]);
  }
  let passedCriteria = 0;
  let unknownCriteria = 0;
  for (const criterion of policy.criteria) {
    const verdicts = byCriterion.get(criterion) ?? [];
    // Known failure dominates every later pass or aggregate score. This is
    // the zeroKnownFailures invariant at its lowest executable boundary.
    if (verdicts.includes("fail")) return "fail";
    if (verdicts.includes("pass")) passedCriteria += 1;
    else unknownCriteria += 1;
  }
  if (policy.criteria.length === 0) return "unknown";
  // Central suitability is a playlist-level objective, not six independent
  // hard evidence gates. Classify a recording as a quality pass when its
  // criterion coverage itself meets the immutable coverage/unknown policy;
  // one bounded unknown must not turn five independently verified positives
  // into an all-or-nothing failure. Known failures still fail closed above.
  return passedCriteria / policy.criteria.length >= policy.minimumPassRatio
    && unknownCriteria / policy.criteria.length <= policy.maximumUnknownRatio
    ? "pass"
    : "unknown";
}

export function evaluateCentralQualityV3(input: {
  tracks: readonly QualifiedTrackV3[];
  policy: CanonicalPlaylistQualityPolicy;
}): CentralQualityReportV3 {
  const verdicts = input.tracks.map((track) => centralQualityVerdictV3(track, input.policy));
  const passCount = verdicts.filter((verdict) => verdict === "pass").length;
  const failCount = verdicts.filter((verdict) => verdict === "fail").length;
  const unknownCount = verdicts.filter((verdict) => verdict === "unknown").length;
  const denominator = input.tracks.length;
  const passRatio = denominator === 0 ? 0 : passCount / denominator;
  const unknownRatio = denominator === 0 ? 1 : unknownCount / denominator;
  const reasonCodes = [
    ...(input.policy.zeroKnownFailures && failCount > 0
      ? ["central_quality_known_failure"]
      : []),
    ...(passRatio < input.policy.minimumPassRatio
      ? ["central_suitability_coverage_below_floor"]
      : []),
    ...(unknownRatio > input.policy.maximumUnknownRatio
      ? ["central_suitability_unknown_above_ceiling"]
      : []),
  ];
  return {
    policyVersion: input.policy.policyVersion,
    criteria: [...input.policy.criteria],
    passed: denominator > 0 && reasonCodes.length === 0,
    passCount,
    failCount,
    unknownCount,
    passRatio,
    unknownRatio,
    reasonCodes,
  };
}

/**
 * Remove known quality failures and cap unknown judgments so every returned
 * prefix can satisfy the immutable playlist-level quality ratios. The
 * original relative rank is preserved inside the chosen pass/unknown set.
 */
export function selectWithCentralQualityV3(input: {
  ranked: readonly QualifiedTrackV3[];
  target: number;
  policy: CanonicalPlaylistQualityPolicy | null | undefined;
}): {
  eligible: QualifiedTrackV3[];
  rejectedFailureCount: number;
  rejectedUnknownCount: number;
} {
  if (!input.policy) {
    return {
      eligible: [...input.ranked],
      rejectedFailureCount: 0,
      rejectedUnknownCount: 0,
    };
  }
  const passing = input.ranked.filter(
    (track) => centralQualityVerdictV3(track, input.policy!) === "pass",
  );
  const unknown = input.ranked.filter(
    (track) => centralQualityVerdictV3(track, input.policy!) === "unknown",
  );
  const failureCount = input.ranked.length - passing.length - unknown.length;
  let total = Math.min(input.target, passing.length + unknown.length);
  while (total > 0) {
    const minimumPass = Math.ceil(total * input.policy.minimumPassRatio);
    const maximumUnknown = Math.floor(total * input.policy.maximumUnknownRatio);
    const passCount = Math.min(passing.length, total);
    const unknownCount = total - passCount;
    if (passCount >= minimumPass
      && unknownCount <= maximumUnknown
      && unknownCount <= unknown.length) {
      const chosen = new Set([
        ...passing.slice(0, passCount).map(({ candidateId }) => candidateId),
        ...unknown.slice(0, unknownCount).map(({ candidateId }) => candidateId),
      ]);
      return {
        eligible: input.ranked.filter(({ candidateId }) => chosen.has(candidateId)),
        rejectedFailureCount: failureCount,
        rejectedUnknownCount: Math.max(0, unknown.length - unknownCount),
      };
    }
    total -= 1;
  }
  return {
    eligible: [],
    rejectedFailureCount: failureCount,
    rejectedUnknownCount: unknown.length,
  };
}

export interface CanonicalPublicationValidationReportV3 {
  readonly valid: boolean;
  readonly reasonCodes: readonly string[];
}

/**
 * Re-evaluate the immutable contract immediately before a canonical manifest
 * is allowed to cross the Apple write boundary. The manifest hash freezes the
 * order; this check proves that the frozen set still satisfies track gates,
 * exact count (unless separately consented), quotas, central quality, and the
 * deterministic sequencing rules the current executor can certify.
 */
export function validateCanonicalPublicationSetV3(input: {
  plan: SelectionPlanV3;
  tracks: readonly QualifiedTrackV3[];
  partialPublicationAuthorized?: boolean;
}): CanonicalPublicationValidationReportV3 {
  const policy = input.plan.canonicalContractPolicy;
  if (!policy) return { valid: true, reasonCodes: [] };
  const reasons: string[] = [];
  if (!input.partialPublicationAuthorized
    && input.tracks.length !== policy.requestedTrackCount) {
    reasons.push("canonical_exact_count_mismatch");
  }
  if (input.tracks.length > policy.requestedTrackCount) {
    reasons.push("canonical_count_overflow");
  }
  if (new Set(input.tracks.map(({ recordingFamilyKey }) => recordingFamilyKey)).size
    !== input.tracks.length) {
    reasons.push("canonical_recording_family_duplicate");
  }
  for (const track of input.tracks) {
    const evaluation = evaluateCanonicalContractTrackV1({
      policy,
      assessments: track.canonicalClauseAssessments ?? {},
    });
    if (!evaluation.eligible) {
      reasons.push(evaluation.status === "unknown"
        ? "canonical_track_unknown"
        : "canonical_track_failed");
      break;
    }
    if (!canonicalRequiredEvidenceIntegrityV3({
      policy,
      assessments: track.canonicalClauseAssessments,
      bindingIds: track.evidenceBindingIds,
      bindings: track.evidenceBindings,
      storefront: input.plan.storefront,
    }).passed) {
      reasons.push("canonical_track_evidence_invalid");
      break;
    }
  }
  for (const rule of input.plan.playlistQuotaRules ?? []) {
    const matches = input.tracks.filter((track) => (
      trackMatchesCanonicalQuotaV3(track, rule, policy)
    )).length;
    const ratio = input.tracks.length === 0 ? 0 : matches / input.tracks.length;
    if ((rule.minimumCount !== null && matches < rule.minimumCount)
      || (rule.maximumCount !== null && matches > rule.maximumCount)
      || (rule.minimumRatio !== null && ratio < rule.minimumRatio)
      || (rule.maximumRatio !== null && ratio > rule.maximumRatio)) {
      reasons.push(`canonical_quota_failed:${rule.id}`);
    }
  }
  if (input.plan.playlistQualityPolicy
    && !evaluateCentralQualityV3({
      tracks: input.tracks,
      policy: input.plan.playlistQualityPolicy,
    }).passed) {
    reasons.push("canonical_central_quality_failed");
  }
  if (shouldApplyPlaylistOptimizerV3(input.plan)) {
    const optimizationTarget = input.partialPublicationAuthorized
      ? input.tracks.length
      : policy.requestedTrackCount;
    if (optimizationTarget === 0) {
      reasons.push("canonical_playlist_optimization_failed:empty_selection");
    } else {
      const optimized = optimizeQualifiedPlaylistV3({
        ranked: input.tracks,
        target: optimizationTarget,
        plan: input.plan,
        validateFixedSelection: true,
      });
      if (!optimized.report.exact) {
        reasons.push(...optimized.report.unmetConstraints.map(
          (reason) => `canonical_playlist_optimization_failed:${reason}`,
        ));
      } else if (optimized.selected.some((track, index) => (
        track.candidateId !== input.tracks[index]?.candidateId
      ))) {
        reasons.push("canonical_sequence_optimizer_mismatch");
      }
    }
  }
  const ordering = input.plan.orderingPolicy;
  for (let index = 1; index < input.tracks.length; index += 1) {
    const previous = input.tracks[index - 1]!;
    const current = input.tracks[index]!;
    if (ordering.avoidAdjacentSameArtist
      && normalizeIdentity(previous.artist) === normalizeIdentity(current.artist)) {
      reasons.push("canonical_sequence_adjacent_artist");
      break;
    }
    if (ordering.avoidAdjacentSameAlbum
      && previous.album && current.album
      && normalizeIdentity(previous.album) === normalizeIdentity(current.album)) {
      reasons.push("canonical_sequence_adjacent_album");
      break;
    }
  }
  if (ordering.mode === "chronological") {
    const years = input.tracks.map(({ catalogReleaseYear }) => catalogReleaseYear ?? null);
    if (years.some((year) => year === null)
      || years.some((year, index) => (
        index > 0 && Number(year) < Number(years[index - 1])
      ))) {
      reasons.push("canonical_sequence_chronology_unproven");
    }
  }
  return { valid: reasons.length === 0, reasonCodes: [...new Set(reasons)] };
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

function shouldApplyPlaylistOptimizerV3(plan: SelectionPlanV3): boolean {
  // Contract-3 carries explicit (nullable) playlist-level constraints. Legacy
  // plans predate the optimizer and retain their recorded soft-relaxation
  // semantics while they drain.
  if (plan.canonicalContractPolicy?.policyVersion !== "canonical_contract_runtime_v1") {
    return false;
  }
  if (plan.scopeKind === "broad_curated"
    || (plan.playlistQuotaRules?.length ?? 0) > 0
    || plan.playlistQualityPolicy !== undefined) {
    return true;
  }
  const diversity = plan.diversityGoals;
  return diversity.maximumTracksPerArtist !== null
    || diversity.maximumTracksPerAlbum !== null
    || (diversity.minimumDistinctArtists ?? 0) > 0
    || (diversity.minimumDistinctAlbums ?? 0) > 0
    || (diversity.minimumDistinctEras ?? 0) > 0
    || (diversity.minimumDistinctScenes ?? 0) > 0
    || (diversity.minimumDistinctGeographies ?? 0) > 0;
}

function optimizeQualifiedPlaylistV3(input: {
  ranked: readonly QualifiedTrackV3[];
  target: number;
  plan: SelectionPlanV3;
  validateFixedSelection?: boolean;
}): {
  selected: QualifiedTrackV3[];
  report: PlaylistOptimizationReportV3;
} {
  const byId = new Map(input.ranked.map((track) => [track.candidateId, track]));
  const candidates = input.ranked.map((track) => (
    playlistOptimizationCandidateV3(track, input.plan)
  ));
  const constraints = playlistOptimizationConstraintsV3(input.plan, input.target);
  // Quotas are part of the same bounded search state as diversity,
  // concentration, quality, and sequencing. Solving a preferred diversity set
  // first and then replacing it with the first quota-compliant set can discard
  // the only jointly feasible composition and manufacture a false shortfall.
  const final = optimizePlaylistV1({
    candidates,
    constraints,
    validateFixedSelection: input.validateFixedSelection,
  });

  return {
    selected: final.selected.flatMap(({ id }) => {
      const track = byId.get(id);
      return track ? [track] : [];
    }),
    report: playlistOptimizationReportV3(
      final,
      new Set(input.ranked.map(({ recordingFamilyKey }) => recordingFamilyKey)).size,
    ),
  };
}

/** Recompute the deterministic optimizer report for an already ordered set. */
export function evaluatePlaylistOptimizationV3(input: {
  plan: SelectionPlanV3;
  tracks: readonly QualifiedTrackV3[];
}): PlaylistOptimizationReportV3 | null {
  if (!shouldApplyPlaylistOptimizerV3(input.plan) || input.tracks.length === 0) {
    return null;
  }
  return optimizeQualifiedPlaylistV3({
    ranked: input.tracks,
    target: input.tracks.length,
    plan: input.plan,
  }).report;
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

function availableStrategies(
  states: readonly MutableStrategyStateV3[],
): MutableStrategyStateV3[] {
  const available = states.filter((state) => state.status === "available"
    && state.rounds < state.definition.maximumRounds
    && state.consecutiveZeroQualifiedYieldRounds < state.definition.zeroQualifiedYieldLimit);
  available.sort((left, right) => left.definition.tier - right.definition.tier
    || left.rounds - right.rounds
    || left.ordinal - right.ordinal);
  return available;
}

/**
 * Select one deterministic portfolio wave from the lowest active tier.
 *
 * Query variants backed by the same provider/corpus are not independent and
 * therefore cannot occupy the same wave. Composite strategies reserve every
 * dependency they use, so an Apple+hosted expansion cannot overlap either an
 * Apple catalog traversal or another hosted-search strategy.
 */
function nextStrategyWave(
  states: readonly MutableStrategyStateV3[],
  maximumConcurrentDiscovery: number,
): MutableStrategyStateV3[] {
  const available = availableStrategies(states);
  const activeTier = available[0]?.definition.tier;
  if (activeTier === undefined) return [];
  const localBarrier = available.find((state) => (
    state.definition.tier === activeTier
    && state.definition.discoveryDependencyIds.length === 1
    && state.definition.discoveryDependencyIds[0] === "orchestration_local"
  ));
  // Server-local scope/gap transitions are deterministic phase barriers.
  // Complete them before launching provider work so no provider request is
  // based on a phase that has not yet committed.
  if (localBarrier) return [localBarrier];
  const dependenciesInUse = new Set<RetrievalUpstreamDependencyIdV3>();
  const selected: MutableStrategyStateV3[] = [];
  for (const state of available) {
    if (state.definition.tier !== activeTier) break;
    if (state.definition.discoveryDependencyIds.some((id) => dependenciesInUse.has(id))) continue;
    selected.push(state);
    state.definition.discoveryDependencyIds.forEach((id) => dependenciesInUse.add(id));
    if (selected.length >= maximumConcurrentDiscovery) break;
  }
  return selected;
}

function mutableDependencyState(
  dependencies: Map<RetrievalUpstreamDependencyIdV3, MutableDependencyStateV3>,
  dependencyId: RetrievalUpstreamDependencyIdV3,
): MutableDependencyStateV3 {
  const existing = dependencies.get(dependencyId);
  if (existing) return existing;
  const created: MutableDependencyStateV3 = {
    dependencyId,
    outageCount: 0,
    failureAttempts: 0,
    active: false,
    circuitOpen: false,
    affectedStrategyIds: new Set(),
    unresolvedStrategyIds: new Set(),
    retryAfterUntilByStrategy: new Map(),
    failureClassByStrategy: new Map(),
  };
  dependencies.set(dependencyId, created);
  return created;
}

function observeDependencyFailure(input: {
  dependencies: Map<RetrievalUpstreamDependencyIdV3, MutableDependencyStateV3>;
  dependencyIds: readonly RetrievalUpstreamDependencyIdV3[];
  strategyId: string;
  circuitOpen?: boolean;
  retryAfterUntil?: Date | null;
  failureClass?: RetrievalDependencyFailureClassV3;
}): void {
  for (const dependencyId of input.dependencyIds) {
    const dependency = mutableDependencyState(input.dependencies, dependencyId);
    dependency.failureAttempts += 1;
    if (dependency.unresolvedStrategyIds.size === 0) dependency.outageCount += 1;
    dependency.unresolvedStrategyIds.add(input.strategyId);
    dependency.active = true;
    dependency.circuitOpen ||= input.circuitOpen === true;
    dependency.affectedStrategyIds.add(input.strategyId);
    dependency.failureClassByStrategy.set(
      input.strategyId,
      input.failureClass ?? "transient",
    );
    if (input.retryAfterUntil !== undefined) {
      if (input.retryAfterUntil
        && Number.isFinite(input.retryAfterUntil.getTime())) {
        dependency.retryAfterUntilByStrategy.set(
          input.strategyId,
          new Date(input.retryAfterUntil),
        );
      } else {
        dependency.retryAfterUntilByStrategy.delete(input.strategyId);
      }
    }
  }
}

function observeDependencySuccess(input: {
  dependencies: Map<RetrievalUpstreamDependencyIdV3, MutableDependencyStateV3>;
  dependencyIds: readonly RetrievalUpstreamDependencyIdV3[];
  strategyId: string;
}): void {
  for (const dependencyId of input.dependencyIds) {
    const dependency = mutableDependencyState(input.dependencies, dependencyId);
    dependency.unresolvedStrategyIds.delete(input.strategyId);
    dependency.retryAfterUntilByStrategy.delete(input.strategyId);
    dependency.failureClassByStrategy.delete(input.strategyId);
    dependency.active = dependency.unresolvedStrategyIds.size > 0;
    if (!dependency.active) dependency.circuitOpen = false;
    dependency.affectedStrategyIds.add(input.strategyId);
  }
}

function retryAfterUntilFromError(error: RetrievalDependencyErrorV3): Date | null {
  return error.retryAfterUntil ? new Date(error.retryAfterUntil) : null;
}

function isRetrievalBudgetBoundary(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String((error as { code?: unknown }).code ?? "");
  return code === "run_budget_reached" || code === "monthly_budget_reached";
}

function latestDependencyRetryAfterUntil(
  state: MutableDependencyStateV3,
): Date | null {
  const latest = [...state.retryAfterUntilByStrategy.values()]
    .reduce<Date | null>((current, candidate) => (
      !current || candidate.getTime() > current.getTime()
        ? candidate
        : current
    ), null);
  return latest ? new Date(latest) : null;
}

function failedDependencyIds(
  error: RetrievalDependencyErrorV3,
  declared: readonly RetrievalUpstreamDependencyIdV3[],
): readonly RetrievalUpstreamDependencyIdV3[] {
  const declaredSet = new Set(declared);
  const specific = error.dependencyIds.filter((dependencyId) => declaredSet.has(dependencyId));
  return specific.length > 0 ? specific : declared;
}

function fixedContainerResolutionProgressValid(
  state: MutableStrategyStateV3,
  proof: FixedContainerResolutionProofV1,
  plan: SelectionPlanV3,
): boolean {
  try {
    assertFixedContainerResolutionProofV1(proof);
  } catch {
    return false;
  }
  if (state.definition.engine !== "fixed_container"
    || state.definition.kind !== "container_enumeration") return false;
  const directive = plan.executionDirectives?.fixedContainer;
  if (directive && (
    proof.contractSemanticHash !== plan.canonicalContractPolicy?.contractSemanticHash
    || proof.directiveHash !== fixedContainerDirectiveHashV1(directive)
    || proof.storefront !== plan.storefront.toLocaleLowerCase("en-US")
  )) return false;
  const prior = state.fixedContainerResolution;
  if (!prior) return true;
  return prior.contractSemanticHash === proof.contractSemanticHash
    && prior.directiveHash === proof.directiveHash
    && prior.storefront === proof.storefront
    && prior.exactMatchCardinality === proof.exactMatchCardinality
    && prior.resolvedResourceId === proof.resolvedResourceId
    && prior.resolvedResourceKind === proof.resolvedResourceKind
    && stableIdentity(prior.requested) === stableIdentity(proof.requested)
    && proof.pageCount >= prior.pageCount
    && proof.enumeratedTrackCount >= prior.enumeratedTrackCount
    && !(prior.enumerationComplete && !proof.enumerationComplete);
}

function stableIdentity(
  identity: FixedContainerResolutionProofV1["requested"],
): string {
  return [
    identity.kind,
    identity.name,
    identity.artistName ?? "",
  ].join("\u0000");
}

function strategyReport(state: MutableStrategyStateV3): RetrievalStrategyReportV3 {
  return {
    id: state.definition.id,
    engine: state.definition.engine,
    kind: state.definition.kind,
    discoveryDependencyIds: [...state.definition.discoveryDependencyIds],
    qualificationDependencyIds: [...state.definition.qualificationDependencyIds],
    status: state.status,
    rounds: state.rounds,
    rawCandidates: state.rawCandidates,
    newQualifiedFamilies: state.newQualifiedFamilies,
    consecutiveZeroQualifiedYieldRounds: state.consecutiveZeroQualifiedYieldRounds,
    providerFailures: state.providerFailures,
    cursor: state.cursor,
    ...(state.fixedContainerResolution ? {
      fixedContainerResolution: state.fixedContainerResolution,
    } : {}),
  };
}

function dependencyOutageReport(
  state: MutableDependencyStateV3,
): RetrievalDependencyOutageReportV3 {
  const retryAfterUntil = latestDependencyRetryAfterUntil(state);
  const activeFailureClasses = [...state.unresolvedStrategyIds]
    .flatMap((strategyId) => {
      const failureClass = state.failureClassByStrategy.get(strategyId);
      return failureClass ? [failureClass] : [];
    });
  const failureClass: RetrievalDependencyFailureClassV3 =
    activeFailureClasses.includes("rate_limited")
      ? "rate_limited"
      : activeFailureClasses[0] ?? "transient";
  return {
    dependencyId: state.dependencyId,
    failureClass,
    outageCount: state.outageCount,
    failureAttempts: state.failureAttempts,
    active: state.active,
    circuitOpen: state.circuitOpen,
    retryAfterUntil: retryAfterUntil?.toISOString() ?? null,
    affectedStrategyIds: [...state.affectedStrategyIds].sort(),
  };
}

function finalStopReason(input: {
  explicit: RetrievalStopReasonV3 | null;
  strategies: readonly MutableStrategyStateV3[];
  providerFailureCount: number;
  integrityFailureCount: number;
  qualifiedCount: number;
  dependencyOutages: readonly MutableDependencyStateV3[];
}): RetrievalStopReasonV3 {
  // Identity, checkpoint, cursor, or adapter integrity is a technical
  // quarantine condition. A coincident exact pool or provider outage cannot
  // make a corrupted retrieval result publishable.
  if (input.integrityFailureCount > 0) return "integrity_failure";
  // A completed exact reserve is valid even if an optional frontier was
  // briefly degraded; every other unresolved provider outage takes
  // precedence over generic time/round/budget boundaries.
  if (input.explicit === "qualified_reserve_satisfied") return input.explicit;
  // One failed hosted-search dependency remains one operational outage even
  // when several query strategies share it. A healthy independent frontier
  // cannot turn that unresolved outage into a scarcity claim.
  if (input.dependencyOutages.some((dependency) => dependency.active && dependency.circuitOpen)) {
    return "provider_circuit_open";
  }
  if (input.dependencyOutages.some((dependency) => dependency.active)) {
    return "provider_failure";
  }
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
  // A successful zero-result frontier may establish that no compatible
  // tracks exist. A provider failure cannot establish that claim, even when
  // other dependent zero-work strategies exhausted without seed material.
  if (input.qualifiedCount === 0 && input.providerFailureCount > 0) {
    return "provider_failure";
  }
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
    dependencyOutages: [],
    integrityEvents: input.integrityEvents ?? [],
    predicateDiagnostics: {
      qualificationsObserved: 0,
      scopeFailures: 0,
      failedMembershipPredicateIds: {},
      appleLookupCount: 0,
      appleProviderRequestCount: 0,
      rootCause: input.stopReason === "provider_failure" || input.stopReason === "provider_circuit_open"
        ? "provider_degraded"
        : "under_discovery",
      recoveryAttemptCount: 0,
    },
    semanticPlanRevisions: [],
    recoveryAudits: [],
    candidateLeads: [],
    publicationBoundary: publicationBoundary(input.mode, input.status),
  };
}

function validatePolicy(input: Partial<RetrievalPolicyV3>): RetrievalPolicyV3 {
  const merged = { ...DEFAULT_RETRIEVAL_POLICY_V3, ...input };
  return {
    maximumGlobalRounds: boundedInteger(merged.maximumGlobalRounds, "maximumGlobalRounds", 1, 1_000),
    maximumConcurrentDiscovery: boundedInteger(
      merged.maximumConcurrentDiscovery ?? DEFAULT_RETRIEVAL_POLICY_V3.maximumConcurrentDiscovery ?? 1,
      "maximumConcurrentDiscovery",
      1,
      16,
    ),
    maximumRawCandidates: boundedInteger(merged.maximumRawCandidates, "maximumRawCandidates", 1, 100_000),
    ...(merged.candidateGoal === undefined ? {} : {
      candidateGoal: boundedInteger(
        merged.candidateGoal,
        "candidateGoal",
        1,
        100_000,
      ),
    }),
    ...(merged.qualifiedPoolGoal === undefined ? {} : {
      qualifiedPoolGoal: boundedInteger(
        merged.qualifiedPoolGoal,
        "qualifiedPoolGoal",
        1,
        100_000,
      ),
    }),
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
  /**
   * Semantic recovery is activated only by query-plan schema 2. Direct unit
   * callers default to enabled so the recovery contract remains easy to test,
   * while workers explicitly fence schema-1 compatibility jobs out.
   */
  semanticRecoveryEnabled?: boolean;
  /** Persist and fence the one-shot repair claim before requalification. */
  claimSemanticRecovery?: (revision: SemanticPlanRevisionArtifactV3) => Promise<void>;
  executionMode?: RetrievalExecutionModeV3;
  routingHints?: RetrievalRoutingHintsV3;
  policy?: Partial<RetrievalPolicyV3>;
  continuation?: RetrievalContinuationSeedV3;
  modelRoute?: PipelineV3ModelRoute;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<RetrievalResultV3> {
  const requested = boundedInteger(
    input.plan.requestedTrackCount,
    "requestedTrackCount",
    1,
    EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS,
  );
  const continuationPlan = input.continuation?.selectionPlan;
  if (continuationPlan && (
    continuationPlan.requestedTrackCount !== input.plan.requestedTrackCount
    || continuationPlan.storefront !== input.plan.storefront
    || continuationPlan.explicitUserConstraintHash !== input.plan.explicitUserConstraintHash
    || stableStringify(continuationPlan.canonicalContractPolicy ?? null)
      !== stableStringify(input.plan.canonicalContractPolicy ?? null)
  )) {
    throw new Error("Compute continuation selection plan changed the immutable contract");
  }
  let activePlan = continuationPlan ?? input.plan;
  const mode = input.executionMode ?? "active";
  const policy = validatePolicy(input.policy ?? {});
  const now = input.now ?? Date.now;
  const engines = routeRetrievalEnginesV3(activePlan, input.routingHints);
  const legacyQualifiedPoolGoal = requested + Math.max(10, Math.ceil(requested * 0.2));
  const qualifiedPoolGoal = Math.max(
    requested,
    policy.qualifiedPoolGoal ?? legacyQualifiedPoolGoal,
  );
  const reserveGoal = qualifiedPoolGoal - requested;
  const continuationStrategies = new Map(
    (input.continuation?.strategies ?? []).map((strategy) => [strategy.id, strategy]),
  );
  const computeOnlyContinuation = input.continuation?.providerCallPermitted === false;
  const approvedContinuationStrategies = input.continuation && !computeOnlyContinuation
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
      status: computeOnlyContinuation
        ? "exhausted"
        : approved
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
      fixedContainerResolution: prior?.fixedContainerResolution ?? null,
    };
  });

  if (!activePlan.confirmed) {
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
  let integrityFailureCount = 0;
  const appleIdToFamily = new Map<string, string>();
  const rawSeedTracks = input.continuation?.qualifiedTracks ?? [];
  const seedTracks = rawSeedTracks.flatMap((track) => {
    const integrityReason = continuationTrackIntegrityReason(track, activePlan);
    if (integrityReason) {
      incrementReason(discardedByReason, integrityReason);
      integrityEvents.push(`continuation_seed_rejected:${integrityReason}:${track.candidateId}`);
      return [];
    }
    const existingFamily = appleIdToFamily.get(track.appleSongId);
    if (existingFamily && existingFamily !== track.recordingFamilyKey) {
      incrementReason(discardedByReason, "catalog_identity_conflict");
      integrityEvents.push(`continuation_seed_rejected:catalog_identity_conflict:${track.candidateId}`);
      integrityFailureCount += 1;
      return [];
    }
    appleIdToFamily.set(track.appleSongId, track.recordingFamilyKey);
    const bindings = attestedEvidenceBindingsForSelectionV3(
      track.evidenceBindingIds,
      track.evidenceBindings,
      activePlan.canonicalContractPolicy ? {
        requireHostedEvidenceSnapshot: true,
        storefront: activePlan.storefront,
      } : {},
    );
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
  const qualityObservationsByCatalogIdentity = new Map<
    string,
    CentralQualityCriterionObservationV3[]
  >();
  for (const track of seedTracks) {
    seenCandidateTracks.set(track.candidateId, { artist: track.artist, title: track.title });
    appleIdToFamily.set(track.appleSongId, track.recordingFamilyKey);
    const alternates = input.continuation?.compatibleAlternatesByRecordingFamily[track.recordingFamilyKey]
      ?.filter((alternate) => alternate.appleSongId !== track.appleSongId
        && continuationTrackIntegrityReason(alternate, activePlan) === null)
      .map((alternate) => {
        const bindings = attestedEvidenceBindingsForSelectionV3(
          alternate.evidenceBindingIds,
          alternate.evidenceBindings,
          activePlan.canonicalContractPolicy ? {
            requireHostedEvidenceSnapshot: true,
            storefront: activePlan.storefront,
          } : {},
        );
        return {
          ...alternate,
          evidenceBindingIds: bindings.map(({ id }) => id),
          evidenceBindings: bindings.map((binding) => ({ ...binding })),
        };
      }) ?? [];
    addQualifiedToFamily(families, { ...track }, activePlan.rankingObjectives);
    for (const alternate of alternates) {
      const existingFamily = appleIdToFamily.get(alternate.appleSongId);
      if (existingFamily && existingFamily !== alternate.recordingFamilyKey) {
        incrementReason(discardedByReason, "catalog_identity_conflict");
        integrityEvents.push(`continuation_alternate_rejected:catalog_identity_conflict:${alternate.candidateId}`);
        integrityFailureCount += 1;
        continue;
      }
      appleIdToFamily.set(alternate.appleSongId, alternate.recordingFamilyKey);
      addQualifiedToFamily(families, alternate, activePlan.rankingObjectives);
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
  let qualificationsObserved = 0;
  let scopeFailuresObserved = 0;
  let appleLookupCount = 0;
  let appleProviderRequestCount = 0;
  let semanticRecoveryAttemptCount = 0;
  const failedMembershipPredicateCounts = new Map<string, number>();
  const semanticRecoveryQualificationSample: CandidateQualificationV3[] = [];
  const semanticPlanRevisions: SemanticPlanRevisionArtifactV3[] = [];
  const recoveryAudits: PipelineRecoveryAuditArtifactV3[] = [];
  const dependencyStates = new Map<
    RetrievalUpstreamDependencyIdV3,
    MutableDependencyStateV3
  >();
  let pendingDiscoveries: PendingDiscoveryAttemptV3[] = [];

  const operationSignal = (): AbortSignal | undefined => {
    if (policy.deadlineAtEpochMs === null) return input.signal;
    const remainingMs = Math.max(1, Math.ceil(policy.deadlineAtEpochMs - now()));
    const deadlineSignal = AbortSignal.timeout(remainingMs);
    return input.signal
      ? AbortSignal.any([input.signal, deadlineSignal])
      : deadlineSignal;
  };

  const observeQualifications = (
    values: readonly CandidateQualificationV3[],
    options: { includeInRecoverySample?: boolean } = {},
  ) => {
    qualificationsObserved += values.length;
    scopeFailuresObserved += values.filter(({ scope }) => !scope.passed).length;
    appleLookupCount += appleLookupCountV3(values);
    appleProviderRequestCount += appleProviderRequestCountV3(values);
    for (const [predicateId, count] of Object.entries(predicateFailureCountsV3(values))) {
      failedMembershipPredicateCounts.set(
        predicateId,
        (failedMembershipPredicateCounts.get(predicateId) ?? 0) + count,
      );
    }
    if (options.includeInRecoverySample !== false) {
      semanticRecoveryQualificationSample.push(...values);
    }
  };

  const optimizeWithRetrySeed = (
    ranked: readonly QualifiedTrackV3[],
    target: number,
  ) => {
    try {
      return optimizeQualifiedPlaylistV3({ ranked, target, plan: activePlan });
    } catch (error) {
      if (!(error instanceof PlaylistOptimizationBudgetExceededErrorV1)) throw error;
      const qualifiedTracks = [...families.values()]
        .flatMap(({ primary, alternates }) => [primary, ...alternates])
        .sort((left, right) => compareQualified(
          left,
          right,
          activePlan.rankingObjectives,
        ));
      throw new RetrievalPlaylistOptimizationBudgetExceededErrorV3(
        error.message,
        {
          providerCallPermitted: false,
          approvedStrategyIds: [],
          selectionPlan: activePlan,
          qualifiedTracks,
          compatibleAlternatesByRecordingFamily: {},
          stages: {
            ...counters,
            selected: 0,
            reserve: 0,
          },
          strategies: states.map(strategyReport),
        },
      );
    }
  };

  while (true) {
    // A reservation can reach the immutable dollar ceiling while other
    // requests in the same bounded wave are already in flight. Drain those
    // successful responses deterministically, but do not start another wave.
    if (stopReason === "budget_reached" && pendingDiscoveries.length === 0) {
      break;
    }
    if (policy.deadlineAtEpochMs !== null && now() >= policy.deadlineAtEpochMs) {
      stopReason = "deadline_reached";
      break;
    }
    if (pendingDiscoveries.length === 0) {
      const optimizerActive = shouldApplyPlaylistOptimizerV3(activePlan);
      const currentRankedRepresentations = [...families.values()]
        .flatMap(({ primary, alternates }) => (
          optimizerActive ? [primary, ...alternates] : [primary]
        ))
        .sort((left, right) => compareQualified(left, right, activePlan.rankingObjectives));
      const currentQualityEligibleRepresentations =
        activePlan.playlistQualityPolicy
          ? currentRankedRepresentations.filter((track) => (
              centralQualityVerdictV3(
                track,
                activePlan.playlistQualityPolicy!,
              ) !== "fail"
            ))
          : currentRankedRepresentations;
      const currentHardEligible = new Set(applyHardAggregateConstraints(
        currentQualityEligibleRepresentations,
        activePlan.hardConstraints,
      ).eligible.map(({ recordingFamilyKey }) => recordingFamilyKey)).size;
      const fill = adaptiveFillPlanV3({
        target: requested,
        qualified: currentHardEligible,
        stageObservations: stageObservations(counters),
        reserve: reserveGoal,
        maximumRawDiscoveryGoal: policy.maximumRawCandidates,
      });
      if (fill.qualifiedPoolDeficit === 0) {
        // Playlist-level ratios and count ceilings are immutable at the
        // requested playlist size. The reserve is replacement inventory, not
        // an enlarged playlist: evaluating quota ratios against
        // requested+reserve can manufacture a contradiction (for example,
        // exactly one of two tracks but at least half of a 12-row pool).
        const diversityCapacity = optimizerActive
          ? optimizeWithRetrySeed(
              currentRankedRepresentations,
              requested,
            ).report.exact
          : true;
        if (diversityCapacity) {
          stopReason = "qualified_reserve_satisfied";
          break;
        }
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

      const remainingGlobalRounds = policy.maximumGlobalRounds - globalRounds;
      const remainingCostUnits = policy.maximumCostUnits - totalCostUnits;
      const concurrencyByKnownBudget = Math.max(1, Math.floor(remainingCostUnits));
      const maximumWaveSize = Math.min(
        policy.maximumConcurrentDiscovery ?? DEFAULT_RETRIEVAL_POLICY_V3.maximumConcurrentDiscovery ?? 1,
        remainingGlobalRounds,
        concurrencyByKnownBudget,
      );
      const wave = nextStrategyWave(states, maximumWaveSize);
      if (wave.length === 0) break;

      const remainingCapacity = policy.maximumRawCandidates - seenCandidateIds.size;
      const materialWave = wave.filter((state) => !(
        state.definition.discoveryDependencyIds.length === 1
        && state.definition.discoveryDependencyIds[0] === "orchestration_local"
      ));
      const remainingCandidateInputGoal = policy.candidateGoal === undefined
        ? fill.rawDiscoveryGoal
        : Math.max(0, policy.candidateGoal - rawCandidateLedger.size);
      // The P10 conversion target sizes evidence-eligible discovery input. It
      // is neither an Apple-safe pool requirement nor a reason to issue one
      // oversized wave. Observe yield incrementally and stop as soon as the
      // much smaller storefront-safe target plus repair reserve is satisfied.
      const boundedDiscoveryGoal = remainingCandidateInputGoal > 0
        ? Math.min(fill.rawDiscoveryGoal, remainingCandidateInputGoal)
        : fill.rawDiscoveryGoal;
      const totalWaveRawGoal = Math.min(
        remainingCapacity,
        Math.max(materialWave.length, boundedDiscoveryGoal),
      );
      let unallocatedRawGoal = totalWaveRawGoal;
      let unallocatedMaterialSlots = materialWave.length;
      const frozenAlreadyDiscoveredCandidateIds = [...seenCandidateIds];
      const frozenAlreadyDiscoveredTracks = [...seenCandidateTracks.values()];
      const frozenQualifiedRecordingFamilyKeys = [...families.keys()];
      const frozenQualifiedTrackSeeds = [...families.values()].map(({ primary }) => ({
        artist: primary.artist,
        title: primary.title,
        appleSongId: primary.appleSongId,
        recordingFamilyKey: primary.recordingFamilyKey,
      }));
      const frozenQualityEvidenceTrackSeeds = activePlan.playlistQualityPolicy
        ? [...families.values()]
            .map(({ primary }) => primary)
            .filter((track) => (
              centralQualityVerdictV3(
                track,
                activePlan.playlistQualityPolicy!,
              ) === "unknown"
            ))
            .map((track) => ({
              artist: track.artist,
              title: track.title,
              appleSongId: track.appleSongId,
              recordingFamilyKey: track.recordingFamilyKey,
            }))
        : [];
      const discoverySignal = operationSignal();
      const requests = wave.map((state): {
        state: MutableStrategyStateV3;
        request: DiscoveryRequestV3;
      } => {
        state.status = "running";
        state.rounds += 1;
        globalRounds += 1;
        const localOnly = state.definition.discoveryDependencyIds.length === 1
          && state.definition.discoveryDependencyIds[0] === "orchestration_local";
        const fairShare = localOnly
          ? Math.max(1, totalWaveRawGoal)
          : Math.max(1, Math.ceil(unallocatedRawGoal / unallocatedMaterialSlots));
        const qualityEvidenceGoal = !localOnly
          && state.definition.kind === "qualified_expansion"
          && activePlan.playlistQualityPolicy
          && frozenQualityEvidenceTrackSeeds.length > 0
          ? Math.min(75, frozenQualityEvidenceTrackSeeds.length)
          : 1;
        const requestedRawCandidateCount = localOnly
          ? Math.max(1, Math.min(
              fairShare,
              state.definition.maximumBatchSize,
              remainingCapacity,
            ))
          : Math.max(1, Math.min(
              Math.max(fairShare, qualityEvidenceGoal),
              state.definition.maximumBatchSize,
              Math.max(unallocatedRawGoal, qualityEvidenceGoal),
              // Qualified expansion can be a pure evidence-enrichment pass
              // over already-qualified Apple identities. Its rows are not new
              // discovery leads, so the remaining raw-lead capacity must not
              // truncate the exact quality window (for example 37/57).
              qualityEvidenceGoal > 1
                ? Math.max(remainingCapacity, qualityEvidenceGoal)
                : remainingCapacity,
            ));
        if (!localOnly) {
          unallocatedRawGoal = Math.max(
            0,
            unallocatedRawGoal - requestedRawCandidateCount,
          );
          unallocatedMaterialSlots -= 1;
        }
        return {
          state,
          request: {
            runId: input.runId,
            executionMode: mode,
            appleWriteAccess: "forbidden",
            ...(input.modelRoute ? { modelRoute: input.modelRoute } : {}),
            plan: activePlan,
            engine: state.definition.engine,
            strategy: state.definition,
            strategyRound: state.rounds,
            cursor: state.cursor,
            requestedRawCandidateCount,
            alreadyDiscoveredCandidateIds: frozenAlreadyDiscoveredCandidateIds,
            alreadyDiscoveredTracks: frozenAlreadyDiscoveredTracks,
            qualifiedRecordingFamilyKeys: frozenQualifiedRecordingFamilyKeys,
            qualifiedTrackSeeds: frozenQualifiedTrackSeeds,
            ...(activePlan.playlistQualityPolicy ? {
              qualityEvidenceTrackSeeds: frozenQualityEvidenceTrackSeeds,
            } : {}),
            ...(discoverySignal ? { signal: discoverySignal } : {}),
          },
        };
      });
      pendingDiscoveries = await Promise.all(requests.map(async ({ state, request }) => {
        try {
          return {
            state,
            request,
            result: { ok: true, batch: await input.adapters.discover(request) },
          } satisfies PendingDiscoveryAttemptV3;
        } catch (error) {
          return {
            state,
            request,
            result: { ok: false, error },
          } satisfies PendingDiscoveryAttemptV3;
        }
      }));
      // Promise completion order is irrelevant: all state mutation and
      // qualification commits below follow the frozen strategy ordinal.
      pendingDiscoveries.sort((left, right) => left.state.ordinal - right.state.ordinal);
    }

    const attempt = pendingDiscoveries.shift()!;
    const { state, request } = attempt;
    if (!attempt.result.ok) {
      const error = attempt.result.error;
      if (input.signal?.aborted) throw input.signal.reason ?? error;
      if (request.signal?.aborted && policy.deadlineAtEpochMs !== null) {
        stopReason = "deadline_reached";
        pendingDiscoveries = [];
        break;
      }
      if (isRetrievalBudgetBoundary(error)) {
        stopReason = "budget_reached";
        state.status = "available";
        continue;
      }
      if (!(error instanceof RetrievalDependencyErrorV3)) throw error;
      providerFailureCount += 1;
      state.providerFailures += 1;
      integrityEvents.push(`discover:${state.definition.id}:${error instanceof Error ? error.message : "unknown_error"}`);
      observeDependencyFailure({
        dependencies: dependencyStates,
        dependencyIds: failedDependencyIds(error, state.definition.discoveryDependencyIds),
        strategyId: state.definition.id,
        retryAfterUntil: retryAfterUntilFromError(error),
        failureClass: error.failureClass,
      });
      state.status = !error.retriable
        || state.providerFailures >= policy.maximumProviderFailuresPerStrategy
        ? "provider_error"
        : "available";
      continue;
    }
    const batch = attempt.result.batch;
    if (batch.providerCircuitOpen !== true) {
      observeDependencySuccess({
        dependencies: dependencyStates,
        dependencyIds: state.definition.discoveryDependencyIds,
        strategyId: state.definition.id,
      });
    }
    const typedFixedContainer = activePlan.executionDirectives?.fixedContainer;
    if (batch.fixedContainerResolution) {
      if (!fixedContainerResolutionProgressValid(
        state,
        batch.fixedContainerResolution,
        activePlan,
      )) {
        integrityFailureCount += 1;
        integrityEvents.push(`invalid_fixed_container_resolution_proof:${state.definition.id}`);
        state.status = "integrity_error";
        continue;
      }
      state.fixedContainerResolution = batch.fixedContainerResolution;
    } else if (typedFixedContainer
      && state.definition.engine === "fixed_container"
      && state.definition.kind === "container_enumeration") {
      integrityFailureCount += 1;
      integrityEvents.push(`missing_fixed_container_resolution_proof:${state.definition.id}`);
      state.status = "integrity_error";
      continue;
    }

    const costUnits = batch.costUnits ?? 0;
    if (!Number.isFinite(costUnits) || costUnits < 0) {
      integrityFailureCount += 1;
      integrityEvents.push(`invalid_cost_units:${state.definition.id}`);
    } else {
      totalCostUnits += costUnits;
    }
    const boundedBatch = batch.candidates.slice(0, request.requestedRawCandidateCount);
    const overflow = batch.candidates.length - boundedBatch.length;
    for (let index = 0; index < overflow; index += 1) incrementReason(discardedByReason, "adapter_response_overflow");
    if (overflow > 0) integrityEvents.push(`response_overflow:${state.definition.id}:${overflow}`);
    counters.discovered += batch.candidates.length;
    state.rawCandidates += batch.candidates.length;

    let candidates: RawTrackCandidateV3[] = [];
    let roundCandidateEvidenceProgress = 0;
    for (const candidate of boundedBatch) {
      if (!validCandidate(candidate)) {
        incrementReason(discardedByReason, "invalid_candidate_shape");
        continue;
      }
      const serverCacheOrigin = discoveryCacheOriginV3(
        state.definition.discoveryDependencyIds,
        batch.provenance,
      );
      const serverFreshUntil = discoveryFreshUntilV3(batch.provenance, now());
      if (serverCacheOrigin === "fresh_cache" && serverFreshUntil === null) {
        incrementReason(discardedByReason, "stale_cache_lead");
        continue;
      }
      const candidateIdWasSeen = seenCandidateIds.has(candidate.id);
      if (!candidateIdWasSeen) seenCandidateIds.add(candidate.id);
      const identityKey = rawCandidateIdentityKey(candidate);
      const existing = rawCandidateLedger.get(identityKey);
      if (existing) {
        existing.candidateIds.add(candidate.id);
        existing.strategyId = state.definition.id;
        state.definition.discoveryDependencyIds.forEach((id) => (
          existing.discoveryDependencyIds.add(id)
        ));
        const incomingOrigin = discoveryCacheOriginV3(
          state.definition.discoveryDependencyIds,
          batch.provenance,
        );
        if (incomingOrigin === "live") existing.cacheOrigin = "live";
        existing.sourceFreshUntil = existing.sourceFreshUntil
          ?? serverFreshUntil;
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
        strategyId: state.definition.id,
        discoveryDependencyIds: new Set(
          state.definition.discoveryDependencyIds,
        ),
        provenanceRoots: new Set(),
        cacheOrigin: discoveryCacheOriginV3(
          state.definition.discoveryDependencyIds,
          batch.provenance,
        ),
        sourceFreshUntil: serverFreshUntil,
        predicateCoverage: new Set(),
        rejectionCode: null,
      });
      seenCandidateTracks.set(candidate.id, {
        artist: candidate.artist.trim(),
        title: candidate.title.trim(),
      });
      counters.validCandidates += 1;
      candidates.push(candidate);
    }
    // One provider batch can repeat the same recording several times while
    // adding stronger observations. The ledger intentionally merges each
    // occurrence, but pushing every intermediate representation would send
    // duplicate candidate IDs to qualification and make the separated
    // recovery ledger reject an otherwise valid batch. Preserve the final
    // cumulative representation for each ID in first-seen order.
    candidates = [...new Map(
      candidates.map((candidate) => [candidate.id, candidate]),
    ).values()];

    let qualifications: readonly CandidateQualificationV3[];
    const qualificationSignal = operationSignal();
    try {
      qualifications = candidates.length === 0
        ? []
        : await input.adapters.qualify({
          runId: input.runId,
          executionMode: mode,
          appleWriteAccess: "forbidden",
          plan: activePlan,
          engine: state.definition.engine,
          strategy: state.definition,
          candidates,
          ...(qualificationSignal ? { signal: qualificationSignal } : {}),
        });
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason ?? error;
      if (qualificationSignal?.aborted && policy.deadlineAtEpochMs !== null) {
        stopReason = "deadline_reached";
        pendingDiscoveries = [];
        break;
      }
      if (isRetrievalBudgetBoundary(error)) {
        stopReason = "budget_reached";
        state.status = "available";
        continue;
      }
      if (!(error instanceof RetrievalDependencyErrorV3)) throw error;
      providerFailureCount += 1;
      state.providerFailures += 1;
      integrityEvents.push(`qualify:${state.definition.id}:${error instanceof Error ? error.message : "unknown_error"}`);
      observeDependencyFailure({
        dependencies: dependencyStates,
        dependencyIds: failedDependencyIds(error, state.definition.qualificationDependencyIds),
        strategyId: state.definition.id,
        retryAfterUntil: retryAfterUntilFromError(error),
        failureClass: error.failureClass,
      });
      for (let index = 0; index < candidates.length; index += 1) {
        incrementReason(discardedByReason, "qualification_missing");
      }
      state.status = !error.retriable
        || state.providerFailures >= policy.maximumProviderFailuresPerStrategy
        ? "provider_error"
        : "available";
      continue;
    }
    if (appleProviderRequestCountV3(qualifications) > 0) {
      observeDependencySuccess({
        dependencies: dependencyStates,
        dependencyIds: state.definition.qualificationDependencyIds,
        strategyId: state.definition.id,
      });
    }

    observeQualifications(qualifications);
    let pendingRecoveryAudit: {
      revision: SemanticPlanRevisionArtifactV3;
      before: ReturnType<typeof recoveryStageSnapshotV3>;
      beforeFailures: Readonly<Record<string, number>>;
      afterFailures: Readonly<Record<string, number>>;
      recoveredScopeCount: number;
    } | null = null;
    const recoveryProposal = input.semanticRecoveryEnabled === false
      || input.continuation
      || semanticRecoveryAttemptCount > 0
      ? null
      : proposeSemanticRecoveryV3({
        plan: activePlan,
        qualifications: semanticRecoveryQualificationSample,
        providerDegraded: providerFailureCount > 0 || batch.providerCircuitOpen === true,
        priorAttemptCount: semanticRecoveryAttemptCount,
      });
    if (recoveryProposal) {
      await input.claimSemanticRecovery?.(recoveryProposal.revision);
      semanticRecoveryAttemptCount += 1;
      const before = recoveryStageSnapshotV3({
        ...counters,
        selected: 0,
        reserve: 0,
      }, appleLookupCount, appleProviderRequestCount);
      const beforeFailures = predicateFailureCountsV3(semanticRecoveryQualificationSample);
      const replayCandidates = [...rawCandidateLedger.values()].map(({ candidate }) => candidate);
      const recoverySignal = operationSignal();
      try {
        const repairedQualifications = await input.adapters.qualify({
          runId: input.runId,
          executionMode: mode,
          appleWriteAccess: "forbidden",
          plan: recoveryProposal.revision.plan,
          engine: state.definition.engine,
          strategy: state.definition,
          candidates: replayCandidates,
          ...(recoverySignal ? { signal: recoverySignal } : {}),
        });
        if (appleProviderRequestCountV3(repairedQualifications) > 0) {
          observeDependencySuccess({
            dependencies: dependencyStates,
            dependencyIds: state.definition.qualificationDependencyIds,
            strategyId: state.definition.id,
          });
        }
        observeQualifications(repairedQualifications, { includeInRecoverySample: false });
        activePlan = recoveryProposal.revision.plan;
        semanticPlanRevisions.push(recoveryProposal.revision);
        candidates = replayCandidates;
        qualifications = repairedQualifications.map((qualification) => (
          projectQualificationToOriginalPredicatesV3(
            qualification,
            recoveryProposal.revision.predicateProjection,
          )
        ));
        pendingRecoveryAudit = {
          revision: recoveryProposal.revision,
          before,
          beforeFailures,
          afterFailures: predicateFailureCountsV3(repairedQualifications),
          recoveredScopeCount: repairedQualifications.filter(({ scope }) => scope.passed).length,
        };
        integrityEvents.push(
          `semantic_recovery:${recoveryProposal.trigger.dominantPredicateId}:${recoveryProposal.revision.transformations.map(({ kind }) => kind).join(",")}`,
        );
      } catch (error) {
        if (input.signal?.aborted) throw input.signal.reason ?? error;
        if (recoverySignal?.aborted && policy.deadlineAtEpochMs !== null) {
          stopReason = "deadline_reached";
          pendingDiscoveries = [];
          break;
        }
        if (isRetrievalBudgetBoundary(error)) {
          stopReason = "budget_reached";
          pendingDiscoveries = [];
        } else {
          if (!(error instanceof RetrievalDependencyErrorV3)) throw error;
          providerFailureCount += 1;
          state.providerFailures += 1;
          integrityEvents.push(`semantic_recovery_qualify:${state.definition.id}:${error instanceof Error ? error.message : "unknown_error"}`);
          observeDependencyFailure({
            dependencies: dependencyStates,
            dependencyIds: failedDependencyIds(error, state.definition.qualificationDependencyIds),
            strategyId: state.definition.id,
            retryAfterUntil: retryAfterUntilFromError(error),
            failureClass: error.failureClass,
          });
          if (!error.retriable) state.status = "provider_error";
          const idempotencyKey = recoveryAuditIdempotencyKeyV3({
            runId: input.runId,
            planHash: recoveryProposal.revision.planHash,
            transformations: recoveryProposal.revision.transformations,
          });
          recoveryAudits.push(Object.freeze({
            generation: 1,
            rootCause: "provider_degraded",
            action: "semantic_equivalent_requalification",
            status: "failed",
            before,
            after: recoveryStageSnapshotV3(
              { ...counters, selected: 0, reserve: 0 },
              appleLookupCount,
              appleProviderRequestCount,
            ),
            beforeFailedMembershipPredicateIds: beforeFailures,
            afterFailedMembershipPredicateIds: beforeFailures,
            transformationKinds: recoveryProposal.revision.transformations.map(({ kind }) => kind),
            idempotencyKey,
          }));
        }
      }
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
      const lead = rawCandidateLedger.get(rawCandidateIdentityKey(candidate));
      const rejectLead = (code: string) => {
        if (lead) lead.rejectionCode = code;
      };
      const qualification = byCandidate.get(candidate.id);
      if (!qualification) {
        incrementReason(discardedByReason, "qualification_missing");
        rejectLead("qualification_missing");
        continue;
      }
      const catalogQualityObservations = activePlan.playlistQualityPolicy
        && qualification.catalog.storefrontPlayable
        && qualification.catalog.appleSongId
        && qualification.catalog.recordingFamilyKey
        && qualification.catalog.artistName?.trim()
        && qualification.catalog.trackName?.trim()
        && qualification.catalog.albumName?.trim()
        ? centralQualityCriterionObservationsForPolicyV3({
            observations:
              qualification.centralQualityCriterionObservations,
            policy: activePlan.playlistQualityPolicy,
            artist: qualification.catalog.artistName,
            title: qualification.catalog.trackName,
            album: qualification.catalog.albumName,
            appleSongId: qualification.catalog.appleSongId,
            recordingFamilyKey:
              qualification.catalog.recordingFamilyKey,
          })
        : [];
      if (catalogQualityObservations.length > 0) {
        const qualityKey = catalogQualityIdentityKey(
          qualification.catalog.appleSongId!,
          qualification.catalog.recordingFamilyKey!,
        );
        const cumulativeQualityObservations = [...new Map([
          ...(qualityObservationsByCatalogIdentity.get(qualityKey) ?? []),
          ...catalogQualityObservations,
        ].map((observation) => [
          observation.observationId,
          observation,
        ])).values()].sort((left, right) => (
          left.observationId.localeCompare(right.observationId)
        ));
        qualityObservationsByCatalogIdentity.set(
          qualityKey,
          cumulativeQualityObservations,
        );
        if (mergeCatalogBoundQualityIntoFamily(families, {
          appleSongId: qualification.catalog.appleSongId!,
          recordingFamilyKey: qualification.catalog.recordingFamilyKey!,
          observations: cumulativeQualityObservations,
        })) {
          meaningfulProgress += 1;
        }
      }
      const failedPredicates = new Set(qualification.scope.failedMembershipPredicateIds);
      for (const predicate of activePlan.membershipPredicates) {
        if (!failedPredicates.has(predicate.id)) lead?.predicateCoverage.add(predicate.id);
      }
      const attestedBindings = attestedEvidenceBindingsForSelectionV3(
        qualification.evidence.bindingIds,
        qualification.evidence.bindings,
        activePlan.canonicalContractPolicy ? {
          requireHostedEvidenceSnapshot: true,
          storefront: activePlan.storefront,
        } : {},
      );
      const canonicalPolicy = activePlan.canonicalContractPolicy;
      if (canonicalPolicy) {
        const evaluation = evaluateCanonicalContractTrackV1({
          policy: canonicalPolicy,
          assessments: qualification.canonicalClauseAssessments ?? {},
        });
        if (!evaluation.eligible) {
          const reason = evaluation.status === "unknown"
            ? "canonical_contract_unknown"
            : "canonical_contract_failed";
          incrementReason(discardedByReason, reason);
          rejectLead(reason);
          continue;
        }
        counters.scopeEligible += 1;
        counters.hardConstraintEligible += 1;
        const evidenceIntegrity = canonicalRequiredEvidenceIntegrityV3({
          policy: canonicalPolicy,
          assessments: qualification.canonicalClauseAssessments,
          bindingIds: qualification.evidence.bindingIds,
          bindings: qualification.evidence.bindings,
          storefront: activePlan.storefront,
        });
        if (!evidenceIntegrity.passed) {
          incrementReason(discardedByReason, "evidence_attestation_missing");
          integrityEvents.push(`canonical_evidence_attestation_missing:${state.definition.id}:${candidate.id}`);
          rejectLead("evidence_attestation_missing");
          continue;
        }
      } else {
        if (!qualification.scope.passed) {
          incrementReason(discardedByReason, "scope_membership_failed");
          rejectLead("scope_membership_failed");
          continue;
        }
        counters.scopeEligible += 1;
        if (!qualification.hardConstraints.passed) {
          incrementReason(discardedByReason, "hard_constraint_failed");
          rejectLead("hard_constraint_failed");
          continue;
        }
        if (catalogEraConstraintFailuresV3(
          activePlan,
          qualification.catalog.releaseYear,
          qualification.catalog.compatibleReleaseYears,
        ).length > 0) {
          incrementReason(discardedByReason, "hard_constraint_failed");
          rejectLead("hard_constraint_failed");
          continue;
        }
        counters.hardConstraintEligible += 1;
        if (!qualification.evidence.passed || qualification.evidence.bindingIds.length === 0) {
          incrementReason(discardedByReason, "evidence_binding_missing");
          rejectLead("evidence_binding_missing");
          continue;
        }
        if (attestedBindings.length === 0) {
          incrementReason(discardedByReason, "evidence_attestation_missing");
          integrityEvents.push(`evidence_attestation_missing:${state.definition.id}:${candidate.id}`);
          rejectLead("evidence_attestation_missing");
          continue;
        }
      }
      for (const predicateId of attestedBindings.flatMap(bindingPredicateIds)) {
        lead?.predicateCoverage.add(predicateId);
      }
      attestedBindings.forEach(({ provenanceRoot }) => (
        lead?.provenanceRoots.add(provenanceRoot)
      ));
      counters.evidenceEligible += 1;
      if (!canonicalPolicy && !qualification.version.compatible) {
        incrementReason(discardedByReason, "version_incompatible");
        rejectLead("version_incompatible");
        continue;
      }
      counters.versionCompatible += 1;
      if (!qualification.catalog.storefrontPlayable) {
        incrementReason(discardedByReason, "storefront_unavailable");
        rejectLead("storefront_unavailable");
        continue;
      }
      if (!qualification.catalog.appleSongId || !qualification.catalog.recordingFamilyKey) {
        incrementReason(discardedByReason, "catalog_identity_missing");
        rejectLead("catalog_identity_missing");
        continue;
      }
      counters.storefrontPlayable += 1;
      const existingFamilyForAppleId = appleIdToFamily.get(qualification.catalog.appleSongId);
      if (existingFamilyForAppleId && existingFamilyForAppleId !== qualification.catalog.recordingFamilyKey) {
        incrementReason(discardedByReason, "catalog_identity_conflict");
        integrityEvents.push(`catalog_identity_conflict:${qualification.catalog.appleSongId}`);
        integrityFailureCount += 1;
        rejectLead("catalog_identity_conflict");
        continue;
      }

      const resolvedArtist = qualification.catalog.artistName?.trim()
        || candidate.artist.trim();
      const resolvedTitle = qualification.catalog.trackName?.trim()
        || candidate.title.trim();
      const resolvedAlbum = qualification.catalog.albumName === null
        ? null
        : qualification.catalog.albumName?.trim()
          || candidate.album?.trim()
          || null;
      const qualified: QualifiedTrackV3 = {
        candidateId: candidate.id,
        title: resolvedTitle,
        artist: resolvedArtist,
        album: resolvedAlbum,
        appleSongId: qualification.catalog.appleSongId,
        recordingFamilyKey: qualification.catalog.recordingFamilyKey,
        catalogReleaseYear: qualification.catalog.releaseYear ?? null,
        catalogCompatibleReleaseYears: [...new Set(
          qualification.catalog.compatibleReleaseYears ?? [],
        )].sort((left, right) => left - right),
        catalogGenreNames: [...new Set(
          (qualification.catalog.genreNames ?? [])
            .map((value) => value.normalize("NFKC").replace(/\s+/gu, " ").trim())
            .filter(Boolean),
        )],
        sourceObservationIds: [...new Set(candidate.sourceObservationIds)],
        evidenceBindingIds: attestedBindings.map(({ id }) => id),
        evidenceBindings: attestedBindings.map((binding) => ({ ...binding })),
        discoveryDependencyIds: [...(lead?.discoveryDependencyIds
          ?? state.definition.discoveryDependencyIds)].sort(),
        provenanceRoots: [...new Set(attestedBindings.map(
          ({ provenanceRoot }) => provenanceRoot,
        ))].sort(),
        cacheOrigin: lead?.cacheOrigin
          ?? discoveryCacheOriginV3(
            state.definition.discoveryDependencyIds,
            batch.provenance,
          ),
        sourceFreshUntil: [
          lead?.sourceFreshUntil ?? null,
          ...attestedBindings.map(
            ({ governance }) => governance.freshnessExpiresAt ?? null,
          ),
        ].filter((value): value is string => typeof value === "string")
          .sort()[0] ?? null,
        ...(qualification.canonicalClauseAssessments ? {
          canonicalClauseAssessments: structuredClone(qualification.canonicalClauseAssessments),
        } : {}),
        ...(qualification.playlistOptimizationSignals ? {
          playlistOptimizationSignals: normalizePlaylistOptimizationSignalsV3(
            qualification.playlistOptimizationSignals,
          ),
        } : {}),
        ...(activePlan.playlistQualityPolicy ? {
          centralQualityCriterionObservations:
            centralQualityCriterionObservationsForPolicyV3({
              observations: [
                ...(qualification.centralQualityCriterionObservations ?? []),
                ...(qualityObservationsByCatalogIdentity.get(
                  catalogQualityIdentityKey(
                    qualification.catalog.appleSongId,
                    qualification.catalog.recordingFamilyKey,
                  ),
                ) ?? []),
              ],
              policy: activePlan.playlistQualityPolicy,
              artist: resolvedArtist,
              title: resolvedTitle,
              album: resolvedAlbum,
              appleSongId: qualification.catalog.appleSongId,
              recordingFamilyKey:
                qualification.catalog.recordingFamilyKey,
            }),
        } : {}),
        evidenceStrength: boundedFinite(qualification.evidence.strength),
        scopeFit: boundedFinite(qualification.scope.fit),
        independentProvenanceRoots: Math.max(0, Math.floor(qualification.evidence.independentProvenanceRoots)),
        versionConfidence: boundedFinite(qualification.version.confidence),
        catalogConfidence: boundedFinite(qualification.catalog.confidence),
        rankingSignals: { ...qualification.rankingSignals },
        sourceRank: Number.isFinite(qualification.sourceRank) ? Math.max(0, qualification.sourceRank) : Number.MAX_SAFE_INTEGER,
      };
      appleIdToFamily.set(qualified.appleSongId, qualified.recordingFamilyKey);
      if (lead) lead.rejectionCode = null;
      const familyAlreadyExists = families.has(qualified.recordingFamilyKey);
      const merge = addQualifiedToFamily(families, qualified, activePlan.rankingObjectives);
      if (merge.newFamily) {
        newFamilies += 1;
        meaningfulProgress += 1;
        counters.canonicalUnique += 1;
        continue;
      }
      incrementReason(discardedByReason, "duplicate_recording_family");
      if (familyAlreadyExists && merge.meaningfulProgress) meaningfulProgress += 1;
    }

    if (pendingRecoveryAudit) {
      const idempotencyKey = recoveryAuditIdempotencyKeyV3({
        runId: input.runId,
        planHash: pendingRecoveryAudit.revision.planHash,
        transformations: pendingRecoveryAudit.revision.transformations,
      });
      recoveryAudits.push(Object.freeze({
        generation: 1,
        rootCause: "semantic_contract",
        action: "semantic_equivalent_requalification",
        status: pendingRecoveryAudit.recoveredScopeCount > 0 ? "complete" : "no_yield",
        before: pendingRecoveryAudit.before,
        after: recoveryStageSnapshotV3(
          { ...counters, selected: 0, reserve: 0 },
          appleLookupCount,
          appleProviderRequestCount,
        ),
        beforeFailedMembershipPredicateIds: pendingRecoveryAudit.beforeFailures,
        afterFailedMembershipPredicateIds: pendingRecoveryAudit.afterFailures,
        transformationKinds: pendingRecoveryAudit.revision.transformations.map(({ kind }) => kind),
        idempotencyKey,
      }));
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
    } else if (batch.providerCircuitOpen) {
      observeDependencyFailure({
        dependencies: dependencyStates,
        dependencyIds: state.definition.discoveryDependencyIds,
        strategyId: state.definition.id,
        circuitOpen: true,
      });
      state.status = "circuit_open";
    }
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
    dependencyOutages: [...dependencyStates.values()],
  });
  const optimizerActive = shouldApplyPlaylistOptimizerV3(activePlan);
  const rankedPool = [...families.values()]
    .flatMap(({ primary, alternates }) => (
      optimizerActive ? [primary, ...alternates] : [primary]
    ))
    .sort((left, right) => compareQualified(left, right, activePlan.rankingObjectives));
  const hardAggregate = optimizerActive
    ? { eligible: rankedPool, rejected: [] }
    : applyHardAggregateConstraints(rankedPool, activePlan.hardConstraints);
  for (const rejection of hardAggregate.rejected) {
    incrementReason(discardedByReason, "hard_constraint_failed");
    for (const reason of rejection.reasons) incrementReason(discardedByReason, reason);
  }
  // The canonical optimizer jointly enforces quality, quota, diversity, and
  // concentration constraints. Giving it only a rank-truncated quality
  // prefix can erase a lower-ranked quota/diversity-essential candidate even
  // though the complete evidence-qualified pool has an exact solution.
  // Remove only known quality failures here and let the joint optimizer choose
  // the permitted pass/unknown composition. Legacy selection retains its
  // historical bounded prefix behavior while draining.
  const qualitySelection = optimizerActive && activePlan.playlistQualityPolicy
    ? {
        eligible: hardAggregate.eligible.filter((track) => (
          centralQualityVerdictV3(track, activePlan.playlistQualityPolicy!)
            !== "fail"
        )),
        rejectedFailureCount: hardAggregate.eligible.filter((track) => (
          centralQualityVerdictV3(track, activePlan.playlistQualityPolicy!)
            === "fail"
        )).length,
        rejectedUnknownCount: 0,
      }
    : selectWithCentralQualityV3({
        ranked: hardAggregate.eligible,
        target: requested + reserveGoal,
        policy: activePlan.playlistQualityPolicy,
      });
  if (qualitySelection.rejectedFailureCount > 0) {
    discardedByReason.central_quality_failed = qualitySelection.rejectedFailureCount;
  }
  if (qualitySelection.rejectedUnknownCount > 0) {
    discardedByReason.central_quality_unknown_excess = qualitySelection.rejectedUnknownCount;
  }
  const broadCurated = shouldSequenceBroadCurated(engines, activePlan);
  let playlistOptimization: PlaylistOptimizationReportV3 | undefined;
  let selected: QualifiedTrackV3[];
  if (optimizerActive) {
    const optimized = optimizeWithRetrySeed(
      qualitySelection.eligible,
      requested,
    );
    selected = optimized.selected;
    playlistOptimization = optimized.report;
  } else {
    const quotaRules = activePlan.playlistQuotaRules ?? [];
    const quotaEligibleSelection = quotaRules.length > 0
      ? selectWithCanonicalQuotaV3({
          ranked: qualitySelection.eligible,
          target: requested,
          rules: quotaRules,
          policy: activePlan.canonicalContractPolicy,
        })
      : qualitySelection.eligible;
    const rankedSelected = broadCurated
      ? selectBroadCurated(quotaEligibleSelection, requested, activePlan)
      : quotaEligibleSelection.slice(0, requested);
    selected = broadCurated
      ? sequenceBroadCurated(rankedSelected, activePlan.orderingPolicy)
      : rankedSelected;
  }
  const selectedFamilies = new Set(selected.map(({ recordingFamilyKey }) => (
    recordingFamilyKey
  )));
  const reserveFamilies = new Set<string>();
  const reserve = qualitySelection.eligible.filter(({ recordingFamilyKey }) => {
    if (selectedFamilies.has(recordingFamilyKey)
      || reserveFamilies.has(recordingFamilyKey)) {
      return false;
    }
    reserveFamilies.add(recordingFamilyKey);
    return true;
  }).slice(0, reserveGoal);
  const shortfall = Math.max(0, requested - selected.length);
  const qualityOptimizerConstraint = playlistOptimization?.unmetConstraints.some(
    (reason) => reason.startsWith("minimum_central_quality_pass_tracks:")
      || reason.startsWith("maximum_central_quality_unknown_tracks:")
      || reason.startsWith("central_quality_known_failures:"),
  ) ?? false;
  const qualityConstrained = shortfall > 0
    && activePlan.playlistQualityPolicy !== undefined
    && (
      qualitySelection.eligible.length
        < Math.min(requested, hardAggregate.eligible.length)
      || qualityOptimizerConstraint
    );
  const optimizationConstrained = playlistOptimization !== undefined
    && !playlistOptimization.exact
    && !qualityConstrained;
  const outcomeStopReason: RetrievalStopReasonV3 = resolvedStopReason === "integrity_failure"
    ? "integrity_failure"
    : qualityConstrained
      ? "central_quality_floor"
    : optimizationConstrained
      ? "playlist_optimization_constraints"
    : shortfall > 0
      && (activePlan.playlistQuotaRules?.length ?? 0) > 0
      && resolvedStopReason === "qualified_reserve_satisfied"
        ? "frontier_exhausted"
        : resolvedStopReason;
  const centralQuality = activePlan.playlistQualityPolicy
    ? evaluateCentralQualityV3({
        tracks: selected,
        policy: activePlan.playlistQualityPolicy,
      })
    : undefined;
  const status: RetrievalOutcomeStatusV3 = (
    resolvedStopReason === "provider_failure" || resolvedStopReason === "provider_circuit_open"
  )
    ? "failed_system"
    : resolvedStopReason === "integrity_failure"
      ? "failed_integrity"
      : resolvedStopReason === "deadline_reached" && selected.length === 0
        ? "needs_decision"
        : optimizationConstrained
          ? "needs_decision"
        : outcomeStopReason === "central_quality_floor" && selected.length === 0
          ? "needs_decision"
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
  const selectedAppleIdByFamily = new Map(selected.map((track) => [
    track.recordingFamilyKey,
    track.appleSongId,
  ]));
  const compatibleAlternatesByRecordingFamily = Object.fromEntries(
    [...families.entries()].flatMap(([family, { primary, alternates }]) => {
      const selectedAppleId = selectedAppleIdByFamily.get(family);
      if (!selectedAppleId) return [];
      const compatible = [primary, ...alternates].filter(({ appleSongId }) => (
        appleSongId !== selectedAppleId
      ));
      return compatible.length > 0 ? [[family, compatible] as const] : [];
    }),
  );
  const candidateLeads: PipelineCandidateLeadArtifactV3[] = [...rawCandidateLedger.values()]
    .slice(0, policy.maximumRawCandidates)
    .map((entry) => Object.freeze({
      strategyId: entry.strategyId,
      candidateKey: candidateLeadKeyV3(entry.candidate),
      artist: entry.candidate.artist.trim().slice(0, 240),
      title: entry.candidate.title.trim().slice(0, 240),
      album: entry.candidate.album?.trim().slice(0, 240) || null,
      sourceRecordIds: [...new Set(entry.candidate.sourceObservationIds)].slice(0, 64),
      citationHashes: citationHashesV3(entry.candidate),
      predicateCoverage: [...entry.predicateCoverage].sort().slice(0, 64),
      rejectionCode: entry.rejectionCode,
      discoveryDependencyIds: [...entry.discoveryDependencyIds].sort(),
      provenanceRoots: [...entry.provenanceRoots].sort(),
      cacheOrigin: entry.cacheOrigin,
      sourceFreshUntil: entry.sourceFreshUntil,
    }));
  const diagnosticsRootCause = recoveryAudits.some(({ rootCause }) => rootCause === "semantic_contract")
    ? "semantic_contract" as const
    : semanticRecoveryRootCauseV3({
      stages,
      providerDegraded: providerFailureCount > 0
        || resolvedStopReason === "provider_failure"
        || resolvedStopReason === "provider_circuit_open",
    });
  return {
    schemaVersion: PIPELINE_V3_RETRIEVAL_SCHEMA,
    runId: input.runId,
    executionMode: mode,
    engines,
    outcome: {
      status,
      stopReason: outcomeStopReason,
      requestedTrackCount: requested,
      qualifiedTrackCount: qualitySelection.eligible.length,
      selectedTrackCount: selected.length,
      reserveTrackCount: reserve.length,
      shortfall,
      requiresPartialPublicationDecision: status === "partial_ready"
        || (status === "needs_decision" && selected.length > 0 && shortfall > 0),
    },
    selected,
    reserve,
    qualifiedPool: qualitySelection.eligible,
    compatibleAlternatesByRecordingFamily,
    stages,
    deficit: {
      ...stages,
      requested,
      qualifiedPoolGoal: requested + reserveGoal,
      targetShortfall: shortfall,
      reserveShortfall: Math.max(0, reserveGoal - reserve.length),
      discardedByReason,
      primaryShortfallReason: shortfall > 0 || optimizationConstrained
        ? outcomeStopReason
        : null,
    },
    strategies: strategyReports,
    dependencyOutages: [...dependencyStates.values()]
      .filter(({ outageCount }) => outageCount > 0)
      .sort((left, right) => left.dependencyId.localeCompare(right.dependencyId))
      .map(dependencyOutageReport),
    integrityEvents,
    ...(centralQuality ? { centralQuality } : {}),
    ...(playlistOptimization ? { playlistOptimization } : {}),
    predicateDiagnostics: {
      qualificationsObserved,
      scopeFailures: scopeFailuresObserved,
      failedMembershipPredicateIds: Object.fromEntries(
        [...failedMembershipPredicateCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
      appleLookupCount,
      appleProviderRequestCount,
      rootCause: diagnosticsRootCause,
      recoveryAttemptCount: semanticRecoveryAttemptCount,
    },
    semanticPlanRevisions,
    recoveryAudits,
    candidateLeads,
    publicationBoundary: publicationBoundary(mode, status),
  };
}
