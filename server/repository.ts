import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Pool, PoolClient } from "pg";
import {
  createDatabase,
  DATABASE_SCHEMA_SUPPORT,
  DATABASE_SCHEMA_VERSION,
  isDatabaseSchemaVersionCompatible,
  type DatabaseHandle,
  type DatabaseSchemaSupport,
} from "../db/index.ts";
import { settings } from "../db/schema.ts";
import type {
  AlternateCatalogIdentity,
  CandidateStage,
  CandidateStageEvent,
  CatalogDiscoveredCandidateInput,
  CatalogDiscoveredCandidateResult,
  CatalogMatchResult,
  CatalogSong,
  EvidenceClaimInput,
  ManifestRevision,
  ManifestRevisionReserveTrack,
  ManifestRevisionStatus,
  ManifestRevisionTrack,
  PipelineDeficitLedgerEntry,
  PipelineOutcome,
  PipelinePolicyVersion,
  PipelinePolicySnapshot,
  PipelineVersion,
  PlaylistBrief,
  PlaylistGuidanceAnswer,
  PlaylistGuidanceQuestion,
  PlaylistGuidanceQuestionSetContract,
  PlaylistGuidanceSourceHint,
  PlaylistGuidanceTelemetry,
  PlaylistManifest,
  PublicResearchRunView,
  PublicPlaylistDirectoryItem,
  PublicPlaylistDirectoryPage,
  QueryPlanV3,
  RecordingFamily,
  RunProgressRecentSource,
  RunProgressView,
  RunGuidanceActionView,
  RunResolutionView,
  RunStatus,
  ResearchRunView,
  SelectionConstraint,
  SelectionPlan,
  SourceFrontierItem,
  SourceRecordInput,
  TrackScopeBinding,
  TrackCandidateInput,
} from "../shared/types.ts";
import {
  assignPipelineV3,
  createQueryPlanV3,
  isQueryPlanV3,
  queryPlanV3EmissionSchemaVersion,
  queryPlanV3Hash,
} from "./query-plan-v3.ts";
import {
  createRunSpecV3,
  criticalAmbiguityAnswersFromGuidanceV3,
  evidenceMembershipPredicatesV3,
  resolveRunSpecV3,
  selectionPlanV3Hash,
  type SelectionPlanV3,
} from "./selection-plan-v3.ts";
import {
  createPipelinePolicySnapshotV3,
  pipelineV3ModelRoutingSignalsFromScoutTelemetry,
  pipelineV3SizeTier,
  type PipelineV3ConversionObservation,
} from "./pipeline-v3-policy.ts";
import {
  v3RetrievalStageKey,
  type PipelineV3WriteFence,
} from "./pipeline-v3-worker-execution.ts";
import type { ColdCorpusBuildResultV3 } from "./pipeline-v3-corpus-builder.ts";
import {
  buildSemanticEquivalentRecoveryPlanV3,
  candidateLeadKeyV3,
  PIPELINE_V3_SEMANTIC_RECOVERY_POLICY,
  type SemanticPlanRevisionArtifactV3,
} from "./pipeline-v3-semantic-recovery.ts";
import {
  APPLE_WRITE_GATEWAY_EVENT_ACTION,
  APPLE_WRITE_GATEWAY_EVENT_BUCKET,
  APPLE_WRITE_GATEWAY_LOCK,
  APPLE_WRITE_GATEWAY_STATE_KEY,
  appleWriteTokenWaitMs,
  readAppleWriteRatePolicy,
  refillAppleWriteTokenBucket,
  type AppleWritePermit,
  type AppleWritePermitRequest,
  type AppleWriteTokenBucketState,
} from "./apple-write-gateway.ts";
import {
  attestedEvidenceBindingsForSelectionV3,
  normalizePlaylistOptimizationSignalsV3,
  validateCanonicalPublicationSetV3,
} from "./pipeline-v3-retrieval.ts";
import type {
  CandidateQualificationV3,
  DiscoveryBatchV3,
  DiscoveryRequestV3,
  EvidenceEligibilityAttestationV3,
  EvidenceBindingReferenceV3,
  QualificationRequestV3,
  QualifiedTrackV3,
  RawTrackCandidateV3,
  RetrievalResultV3,
} from "./pipeline-v3-retrieval.ts";
import {
  defaultJobQueueClass,
  isColdCorpusWork,
  isDeepQueryPlan,
  queueClassesForWorker,
  type JobQueueClass,
  type WorkerQueueClass,
} from "./job-queue-class.ts";
import {
  createPipelineV3ActivationContract,
  pipelineV3ActivationPreconditionFailure,
} from "./v3-activation-bridge.ts";
import { publicResearchRunView } from "./public-api-projections.ts";
import {
  partialDecisionExpiresAt,
  partialExploreEligibility,
  parsePartialReadyCheckpoint,
  requireCurrentPartialOutcome,
  shortManifestRequiresDecision,
} from "./partial-publication-policy.ts";
import {
  selectBroadCuratedCandidates,
  shouldScoreBroadCuratedSelection,
  type BroadCuratedCandidate,
} from "../shared/selection-score-v2.ts";
import {
  EXECUTABLE_PLAYLIST_MAXIMUM_RESERVE_TRACKS,
  EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS,
  GUIDED_BRIEF_BUDGET_USD,
  GUIDED_SCOUT_BUDGET_USD,
  PUBLIC_PLAYLIST_MAXIMUM_TRACKS,
  PUBLIC_PLAYLIST_MINIMUM_TRACKS,
} from "../shared/product-policy.ts";
import {
  candidateIdentityKey,
  compactEvidenceNote,
  duplicateClusterKey,
  HttpError,
  assertPublicHttpsUrl,
  sha256Hex,
  stableStringify,
} from "./security.ts";
import {
  applyPlaylistContractPatchV1,
  assertPlaylistContractIntegrityV1,
  type PlaylistContractPatchV1,
  type PlaylistContractRevisionV1,
} from "./playlist-contract-v1.ts";
import {
  ACTIVE_COMPUTE_EXTENSION_MS_V1,
  MAX_ACTIVE_COMPUTE_EXTENSIONS_V1,
  publicAdaptiveRunDecisionV1,
} from "./adaptive-run-decision-v1.ts";
import { evaluateCanonicalContractTrackV1 } from "./canonical-contract-runtime-v1.ts";
import {
  compileGuidanceRoundPatchV3,
  publicGuidanceQuestionV3,
} from "./adaptive-guidance-contract-bridge.ts";
import {
  customGuidanceConfirmationDecisionV3,
  predicateYieldRescueGuidanceDecisionV3,
  recompileCustomGuidanceTextV3,
  selectGuidanceRoundV3,
} from "./adaptive-guidance-v3.ts";
import { projectPlaylistContractExecutionV1 } from "./playlist-contract-execution-bridge-v1.ts";
import {
  CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY,
  negotiatePlaylistContractBackendV1,
} from "./playlist-contract-backend-capability-v1.ts";
import { normalizeMusicText } from "../lib/matching.ts";
import { manifestContentHash } from "./manifest-integrity.ts";
import type { PublicationCompletionFence } from "./publication-completion-fence.ts";
import {
  orderedAppleStableIdsHash,
  type AdvancePublicationReconciliationInput,
  type BeginPublicationReconciliationInput,
  type DurablePublicationReconciliation,
  type DurablePublicationReconciliationState,
} from "./publication-reconciliation-persistence.ts";
import {
  assertCanonicalManifestRevisionV1,
  CanonicalPublicationRevalidationRequiredErrorV1,
  type PersistedCanonicalQualificationV1,
} from "./canonical-publication-revalidation-v1.ts";
import {
  briefShouldDiversifyArtists,
  desiredPlaylistArtistCount,
  selectRankedPlaylistRows,
} from "../lib/playlist-selection.ts";
import { sequencePlaylist, shouldSequencePlaylist } from "../lib/playlist-sequencing.ts";
import { manifestDescriptionForBrief } from "./brief-policy.ts";
import { appendPlaylistTitleSuffix, normalizePlaylistTitle } from "./playlist-title.ts";
import { resolvePublicationCompleteness } from "./publication-completeness.ts";
import { selectionFallsBelowRequiredMinimum } from "./catalog-selection-policy.ts";
import {
  failureContextForJob,
  failureContextForRun,
  sanitizeFailure,
  sanitizeOptionalFailure,
} from "./error-sanitizer.ts";
import { readCostConfiguration } from "./cost-config.ts";
import { resolveEvidenceIntegrity } from "./evidence-integrity.ts";
import { evidenceRelationshipIsMaterial } from "./evidence-relationship-policy.ts";
import {
  createFastPostMatchRefillRouteCheckpoint,
  FAST_POST_MATCH_REFILL_MAX_COST_USD,
  createFastRouteCheckpoint,
  createPipelinePolicySnapshot,
  FAST_POST_MATCH_REFILL_LIMIT,
  researchExecutionPolicy,
  researchPolicyFingerprint,
} from "./research-policy.ts";
import type { PreflightManifestTrack, PreflightReserveTrack } from "./manifest-preflight-v2.ts";
import { resolveEvidenceSubjectBinding } from "./evidence-binding.ts";
import {
  CATALOG_RECOVERY_UNRESOLVED_BASIS,
  RETRYABLE_CATALOG_MATCH_BASES,
} from "./catalog-match-recovery.ts";
import {
  citationAttestationKey,
  citationTextIsLocalToClaim,
  MAX_CITATION_EXCERPT_CHARS,
  type HostedCitationAttestation,
} from "./citation-attestation.ts";
import { appleAuthorizationGeneration } from "./apple.ts";
import type {
  AppleCatalogCacheEntry,
  AppleCatalogCacheEvent,
  AppleCatalogCacheResourceKind,
  AppleCatalogCacheWrite,
} from "./apple-catalog-cache.ts";
import { excludedReferenceArtists } from "./similarity-policy.ts";
import {
  BRIEF_CONTRACT_2_MINIMUM_WORKER_PROTOCOL,
  BRIEF_CONTRACT_3_MINIMUM_WORKER_PROTOCOL,
  CORPUS_FIRST_V3_SCHEMA_2_MINIMUM_WORKER_PROTOCOL,
  CORPUS_FIRST_V3_SCHEMA_3_MINIMUM_WORKER_PROTOCOL,
  CORPUS_FIRST_V3_SCHEMA_4_MINIMUM_WORKER_PROTOCOL,
  isWorkerCapabilityValid,
  isWorkerPipelineProtocolCompatible,
  minimumWorkerProtocolForPipeline,
  minimumWorkerProtocolForQueryPlan,
  WORKER_PIPELINE_CAPABILITY,
  type WorkerPipelineCapability,
  workerPipelineProtocolVersion,
} from "./worker-protocol.ts";
import { projectNeverDeadEndRun } from "./never-dead-end-policy.ts";
import {
  automaticFailureFingerprint,
  classifyAutomaticBriefFailure,
  classifyAutomaticRunFailure,
  createAutomaticQaScenario,
  feedbackListItem,
  feedbackPayloadHash,
  redactSensitiveDiagnosticText,
  type AutomaticFailureDiagnostics,
  type FeedbackKind,
  type FeedbackListItem,
  type FeedbackStatus,
  type FeedbackSubmissionInput,
  type FeedbackSubmissionRecord,
} from "./feedback.ts";
import { buildInformation } from "./build-info.ts";
import { runtimeReleaseContract } from "./runtime-release.ts";
import type { UnsignedReleaseCanaryMetadata } from "./release-canary-metadata.ts";
import { persistReleaseCanaryMarker } from "./release-canary-persistence.ts";
import {
  deriveGuidancePreferences,
  guidanceOrderingPolicy,
  safeCustomGuidanceText,
  type PlaylistGuidancePreference,
} from "./guidance-context.ts";
import { compileGuidanceExecutionDeltaV2 } from "./guidance-contract-v2.ts";
import { assignPipelineV2, createSelectionPlanV2, pipelineRolloutStickyKey } from "./selection-plan-v2.ts";
import {
  catalogContentRating,
  catalogRecordingVersionClass,
  classifyTrackScopeBindingEvidence,
  recordingFamilyKey,
  scopeBindingEligible,
  selectWithConstraintLadder,
  trackScopeBindingStrength,
  type ConstraintCandidate,
  type ConstraintRule,
  type ConstraintSelection,
} from "./pipeline-v2-policy.ts";
import { buildPipelineOutcome, mergePipelineOutcomes } from "./pipeline-outcome-v2.ts";
import {
  evaluatePipelineOperationalWindow,
  PIPELINE_LEDGER_STAGES,
  type PipelineOperationalSweepResult,
  type PipelineOperationalWindow,
  type PipelineStageCounts,
} from "./pipeline-v2-observability.ts";
import {
  assertsFactualTrackRelationship,
  requiresFactualFrontier,
} from "./factual-frontier-policy.ts";
import {
  bindingGeographyRelationship,
  proofSupportsSelectionGeography,
  provenancePathWithGeographyRelationship,
  selectionGeographyBindingsSatisfied,
} from "./selection-geography-policy.ts";
import { deriveAttestedHardScopeDescriptors } from "./evidence-scope-binding.ts";
import {
  canonicalRecordingFamilyReleaseYear,
  recordingFamilySatisfiesEraConstraint,
} from "./selection-era-policy.ts";
import { partitionUniqueRecordingFamilies } from "./recording-family-selection.ts";

// Global capacity protects paid/worker work, not saved visitor state. A run
// waiting on scope review, budget approval, track selection, or Apple
// reauthorization consumes no worker slot and must not prevent another
// anonymous visitor from starting research.
const CAPACITY_RUN_STATUSES = [
  "queued",
  "researching",
  "ready_for_matching",
  "matching",
  "publishing",
];

export function isGuidanceScoutOperation(operation: string): boolean {
  return operation === "brief.question_scout"
    || operation.startsWith("brief.question_scout:")
    // Read legacy development reservations safely during rollout.
    || operation === "brief.scout"
    || operation.startsWith("brief.scout:");
}
const TERMINAL_RUN_STATUSES = [
  "complete",
  "partial",
  "no_compatible_tracks",
  "cancelled",
  "failed",
  "failed_system",
  "failed_integrity",
  "expired",
  "deleted",
];
const JOB_ADVISORY_LOCK = 694_207_551;
const BUDGET_ADVISORY_LOCK = 694_207_552;
const RUN_CAPACITY_ADVISORY_LOCK = 694_207_553;
const CONTRACT_CAPABILITY_DEPENDENCY_KEY = "contract_execution_capability";
const CONTRACT_CAPABILITY_DECISION_REASON = "unsupported_contract_capability";
const FEEDBACK_SUBMISSION_PREFIX = "feedback-submission:";
const FEEDBACK_IDEMPOTENCY_PREFIX = "feedback-idempotency:";
const FEEDBACK_AUTOMATIC_EVENT_PREFIX = "feedback-automatic-event:";
const FEEDBACK_AUTOMATIC_SOURCE_LOCK_PREFIX = "feedback-automatic-source:";
const FEEDBACK_AUTOMATIC_RECONCILIATION_KEY = "feedback-automatic-reconciliation:last";
const FEEDBACK_AUTOMATIC_RECONCILIATION_LOCK = "feedback-automatic-reconciliation";
const FEEDBACK_AUTOMATIC_RECONCILIATION_TOUCH_PREFIX = "feedback-automatic-reconciliation-touch:";
const FEEDBACK_AUTOMATIC_RECONCILIATION_INTERVAL_MS = 60_000;
const FEEDBACK_AUTOMATIC_RECONCILIATION_LIMIT = 20;
const FEEDBACK_GLOBAL_BUCKET = "feedback-global";
const FEEDBACK_GLOBAL_DAILY_LIMIT = Math.max(1, Math.min(1_000, Number(process.env.FEEDBACK_GLOBAL_DAILY_LIMIT ?? 100) || 100));
const FEEDBACK_STORAGE_LIMIT_BYTES = Math.max(
  5 * 1024 * 1024,
  Math.min(1024 * 1024 * 1024, Number(process.env.FEEDBACK_STORAGE_LIMIT_BYTES ?? 100 * 1024 * 1024) || 100 * 1024 * 1024),
);
const AUTOMATIC_FAILURE_DIAGNOSTIC_LIMIT_BYTES = 128 * 1024;

const PRIVATE_DIAGNOSTIC_KEY = /(authorization|bearer|bucket|cookie|credential|email|header|key|password|provider.?body|raw.?response|secret|stack|token)/iu;

/**
 * Keep automatic reports useful without turning them into a second raw-log
 * sink. Exact request text is stored in the dedicated prompt field; nested
 * operational metadata is bounded and keys likely to contain secrets or
 * gateway identity are removed recursively.
 */
function boundedOwnerDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === undefined) return null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return redactSensitiveDiagnosticText(value, 1_000);
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => boundedOwnerDiagnosticValue(item, depth + 1));
  }
  if (typeof value !== "object") return String(value).slice(0, 1_000);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !PRIVATE_DIAGNOSTIC_KEY.test(key))
      .slice(0, 50)
      .map(([key, item]) => [key.slice(0, 120), boundedOwnerDiagnosticValue(item, depth + 1)]),
  );
}

function boundedAutomaticFailureDiagnostics(
  diagnostics: AutomaticFailureDiagnostics,
): AutomaticFailureDiagnostics {
  const sanitized: AutomaticFailureDiagnostics = {
    ...diagnostics,
    prompt: redactSensitiveDiagnosticText(diagnostics.prompt),
    rootCause: diagnostics.rootCause == null
      ? null
      : redactSensitiveDiagnosticText(diagnostics.rootCause, 240),
    errorCode: diagnostics.errorCode == null
      ? null
      : automaticFailureErrorCode(diagnostics.errorCode, "terminal_failure"),
    errorMessage: diagnostics.errorMessage == null
      ? null
      : redactSensitiveDiagnosticText(diagnostics.errorMessage),
    runtime: boundedOwnerDiagnosticValue(diagnostics.runtime) as AutomaticFailureDiagnostics["runtime"],
    plan: boundedOwnerDiagnosticValue(diagnostics.plan) as AutomaticFailureDiagnostics["plan"],
    counters: Object.fromEntries(
      Object.entries(diagnostics.counters).flatMap(([key, value]) => Number.isFinite(value) && value >= 0
        ? [[key.slice(0, 80), Math.floor(value)]]
        : []),
    ),
    details: boundedOwnerDiagnosticValue(diagnostics.details) as Record<string, unknown>,
  };
  if (Buffer.byteLength(JSON.stringify(sanitized), "utf8") <= AUTOMATIC_FAILURE_DIAGNOSTIC_LIMIT_BYTES) {
    return sanitized;
  }
  // Stage snapshots can contain many bounded branches. Preserve the replay
  // contract and high-value counters while dropping bulky lower-priority
  // checkpoint detail so a failure reporter can never become a storage DoS.
  return {
    ...sanitized,
    details: {
      truncated: true,
      reason: "automatic_failure_diagnostic_size_limit",
      originalByteSize: Buffer.byteLength(JSON.stringify(sanitized), "utf8"),
    },
  };
}

function countDiagnosticItems(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).length;
  return 0;
}

function diagnosticOutcomeSummary(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const allowedKeys = [
    "outcome",
    "status",
    "reason",
    "reasonCode",
    "rootCause",
    "shortfall",
    "requested",
    "qualified",
    "published",
    "completeness",
  ];
  const summary = Object.fromEntries(
    allowedKeys.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]),
  );
  return Object.keys(summary).length > 0
    ? boundedOwnerDiagnosticValue(summary) as Record<string, unknown>
    : null;
}

function requestedTrackCountFromRunMetadata(row: Record<string, unknown>): number | null {
  const direct = Number(row.requested_track_count);
  if (Number.isInteger(direct)
    && direct >= 1
    && direct <= EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS) return direct;
  const selection = row.selection_plan_json && typeof row.selection_plan_json === "object"
    ? row.selection_plan_json as Record<string, unknown>
    : {};
  const fromSelection = Number(selection.requestedTrackCount);
  if (Number.isInteger(fromSelection)
    && fromSelection >= 1
    && fromSelection <= EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS) {
    return fromSelection;
  }
  const brief = row.brief_json && typeof row.brief_json === "object"
    ? row.brief_json as Record<string, unknown>
    : {};
  const targetSize = brief.targetSize && typeof brief.targetSize === "object"
    ? brief.targetSize as Record<string, unknown>
    : {};
  const fromBrief = Number(targetSize.max ?? targetSize.min);
  return Number.isInteger(fromBrief)
    && fromBrief >= 1
    && fromBrief <= EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS
    ? fromBrief
    : null;
}

function automaticFailureErrorCode(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const normalizedFallback = fallback.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "_").replace(/^_+|_+$/gu, "") || "terminal_failure";
  if (!raw) return normalizedFallback.slice(0, 120);

  const redacted = redactSensitiveDiagnosticText(raw, 240);
  const normalized = raw.toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "_").replace(/^_+|_+$/gu, "");
  // Only known server-owned diagnostic namespaces may remain readable. An
  // arbitrary provider/root-cause string is represented by a stable hash so
  // an opaque credential can never leak through the error-code field.
  const controlledNamespace = /^(?:apple|brief|catalog|evidence|failure|integrity|manifest|matching|openai|pipeline|provider|publication|research|schema|semantic|system|timeout|worker)(?:[._-][a-z0-9._-]+)*$/u;
  if (redacted === raw && controlledNamespace.test(normalized)) return normalized.slice(0, 120);
  return `failure_${sha256Hex(raw).slice(0, 16)}`;
}

/**
 * Serialize operations that inspect all aliases for one client identity.
 *
 * Daily privacy buckets overlap during rotation (current + previous). A
 * single advisory key made from the whole alias list does not protect two
 * requests whose lists merely overlap, for example [today, yesterday] and
 * [yesterday, two-days-ago]. Locking each alias in stable order preserves the
 * rolling limit and idempotency boundary without introducing deadlocks.
 */
async function lockClientAliases(
  client: PoolClient,
  scope: string,
  clientBucketAliases: readonly string[],
): Promise<void> {
  const aliases = [...new Set(clientBucketAliases.map((value) => value.trim()).filter(Boolean))].sort();
  if (aliases.length === 0) {
    throw new HttpError(401, "Client bucket is required", "invalid_gateway_identity");
  }
  for (const alias of aliases) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${scope}:${alias}`]);
  }
}

export function isStableApplePlaylistShareUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_000) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "music.apple.com"
      && url.port === ""
      && url.username === ""
      && url.password === ""
      && url.hash === ""
      && /^\/[a-z]{2}\/playlist\/[^/]+\/pl\.[A-Za-z0-9._-]+$/iu.test(url.pathname);
  } catch {
    return false;
  }
}

function canonicalApplePlaylistShareUrl(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

type CandidateRow = TrackCandidateInput & {
  id: string;
  runId: string;
  outcome: string;
  duplicateClusterKey: string | null;
  pipelineVersion: PipelineVersion;
  policyVersion: SelectionPlan["policyVersion"];
};

export interface JobView {
  id: string;
  runId: string | null;
  briefRequestId: string | null;
  kind: string;
  queueClass: JobQueueClass;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  pipelineVersion: PipelineVersion;
  minimumWorkerProtocol: number;
  queryPlanRevisionId: string | null;
  stageKey: string;
  leaseEpoch: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
}

export interface ResearchRunHistoryItem {
  id: string;
  prompt: string;
  brief: PlaylistBrief;
  status: string;
  phase: string;
  candidateCount: number;
  sourceCount: number;
  unresolvedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogTrackRow {
  position: number;
  candidateId: string;
  selectionRank: number | null;
  artist: string;
  title: string;
  album: string | null;
  releaseYear: number | null;
  durationMs: number | null;
  isrc: string | null;
  versionLabel: string | null;
  duplicateClusterKey: string | null;
  status: CatalogMatchResult["status"] | "pending";
  basis: string | null;
  score: number;
  catalogId: string | null;
  song: CatalogSong | null;
  alternatives: CatalogSong[];
  evidenceEligible: boolean;
  selected: boolean;
  selectable: boolean;
  retryable: boolean;
}

export interface CatalogTrackPage {
  items: CatalogTrackRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  selectableCount: number;
  unmatchedCount: number;
  retryableCount: number;
  matchingComplete: boolean;
  requestedTrackCount: number | null;
}

export interface CatalogSelectionInput {
  selected?: Array<{ candidateId: string; catalogId: string }>;
  useRecommended?: boolean;
  excludedCandidateIds?: string[];
  overrides?: Array<{ candidateId: string; catalogId: string }>;
  automatic?: boolean;
}

export interface PublicationVolumeInput {
  manifestId: string;
  manifestRevisionId?: string | null;
  volumeNumber: number;
  volumeCount: number;
  startPosition: number;
  endPosition: number;
  status?: string;
}

export interface PublicationQueueResult {
  queued: boolean;
  state: "queued" | "in_flight" | "waiting_for_apple_authorization" | "terminal";
  runStatus: string;
  jobId: string | null;
}

export interface EncryptedAppleAuthorizationInput {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
  storefront: string;
  status?: string;
  lastValidatedAt?: Date | null;
  lastError?: string | null;
}

export interface ResearchContainerInput {
  id?: string;
  sourceRecordId?: string | null;
  parentContainerId?: string | null;
  containerType: "artist" | "release" | "session" | "collection" | string;
  providerId: string;
  title: string;
  status: "discovered" | "enumerating" | "complete" | "inaccessible" | "unresolved" | string;
  cursor?: string | null;
  advertisedTotal?: number | null;
  recoveredTotal?: number;
  metadata?: Record<string, unknown>;
}

export interface CostSubject {
  runId?: string | null;
  briefRequestId?: string | null;
}

function finiteMoney(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 10_000) throw new HttpError(400, `${field} is invalid`, "invalid_cost");
  return Math.round(value * 1_000_000) / 1_000_000;
}

function date(value: unknown): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(String(value));
}

function progressCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function progressOptionalCount(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function progressText(value: unknown, maximum: number): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maximum)
    : "";
}

function recentPublicSources(value: unknown): RunProgressRecentSource[] {
  if (!Array.isArray(value)) return [];
  const sources: RunProgressRecentSource[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const title = progressText(row.title, 160);
    const sourceClass = progressText(row.source_class, 40);
    if (!title || !sourceClass || typeof row.url !== "string") continue;
    try {
      const url = new URL(row.url);
      if (url.protocol !== "https:") continue;
      const domain = url.hostname.toLowerCase().slice(0, 253);
      if (!domain) continue;
      const key = `${domain}\u0000${title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({ title, domain, sourceClass });
      if (sources.length >= 3) break;
    } catch {
      // Legacy/import source URLs are intentionally omitted from the public
      // live feed instead of attempting to repair or expose them.
    }
  }
  return sources;
}

function heartbeatSchemaSupport(row: {
  schema_version: string;
  metadata_json?: unknown;
}): DatabaseSchemaSupport {
  const metadata = row.metadata_json && typeof row.metadata_json === "object" && !Array.isArray(row.metadata_json)
    ? row.metadata_json as Record<string, unknown>
    : {};
  const minimum = typeof metadata.schemaMinimum === "string" ? metadata.schemaMinimum : row.schema_version;
  const maximum = typeof metadata.schemaMaximum === "string" ? metadata.schemaMaximum : row.schema_version;
  const preferred = typeof metadata.schemaPreferred === "string" ? metadata.schemaPreferred : row.schema_version;
  return { minimum, maximum, preferred };
}

function heartbeatObservedSchemaVersion(row: {
  schema_version: string;
  metadata_json?: unknown;
}): string {
  const metadata = row.metadata_json && typeof row.metadata_json === "object" && !Array.isArray(row.metadata_json)
    ? row.metadata_json as Record<string, unknown>
    : {};
  return typeof metadata.observedSchemaVersion === "string"
    ? metadata.observedSchemaVersion
    : row.schema_version;
}

function heartbeatSchemaCompatible(
  row: { schema_version: string; metadata_json?: unknown },
  databaseSchemaVersion: string | null,
): boolean {
  return isDatabaseSchemaVersionCompatible(databaseSchemaVersion, heartbeatSchemaSupport(row))
    && heartbeatObservedSchemaVersion(row) === databaseSchemaVersion;
}

function heartbeatQueueClass(metadata: unknown): WorkerQueueClass {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "interactive";
  const queueClass = (metadata as Record<string, unknown>).queueClass;
  return queueClass === "deep" || queueClass === "all" ? queueClass : "interactive";
}

function heartbeatExecutorRevision(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).version;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-z][0-9a-z._+-]{0,127}$/u.test(normalized) ? normalized : null;
}

function heartbeatConfigurationHash(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).configurationHash;
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : null;
}

function deterministicUuid(value: unknown): string {
  const hex = sha256Hex(stableStringify(value));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

interface CanonicalCapabilityDecision {
  missingCapabilities: string[];
  requirementsHash: string;
}

function canonicalCapabilityDecision(
  contract: PlaylistContractRevisionV1,
): CanonicalCapabilityDecision | null {
  const negotiation = negotiatePlaylistContractBackendV1({
    contract,
    backends: [CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY],
  });
  if (negotiation.backend && negotiation.result.supported) return null;
  return {
    missingCapabilities: negotiation.result.missing
      .slice(0, 64)
      .map((value) => value.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 240)),
    requirementsHash: sha256Hex(stableStringify(negotiation.requirements)),
  };
}

function canonicalCapabilityBlockerState(
  decision: CanonicalCapabilityDecision,
): Record<string, unknown> {
  return {
    reasonCode: CONTRACT_CAPABILITY_DECISION_REASON,
    requirementsHash: decision.requirementsHash,
    missingCapabilities: decision.missingCapabilities,
    actions: [
      "review_contract",
      "wait_for_compatible_executor",
      "cancel",
    ],
  };
}

function pipelineV3LeadIdentityHash(candidate: Pick<
  RawTrackCandidateV3,
  "artist" | "title" | "album"
>): string {
  return candidateLeadKeyV3({
    id: "identity-only",
    artist: candidate.artist,
    title: candidate.title,
    album: candidate.album,
    sourceObservationIds: [],
  });
}

function pipelineV3QualificationStableIdentityHash(
  candidate: RawTrackCandidateV3,
  qualification: CandidateQualificationV3,
): string {
  return qualification.catalog.recordingFamilyKey
    ? sha256Hex(stableStringify({
        kind: "recording_family",
        recordingFamilyKey: qualification.catalog.recordingFamilyKey,
      }))
    : pipelineV3LeadIdentityHash(candidate);
}

function pipelineV3CanonicalPredicateProjection(
  policy: NonNullable<QueryPlanV3["canonicalContractPolicy"]>,
  assessments:
    | CandidateQualificationV3["canonicalClauseAssessments"]
    | QualifiedTrackV3["canonicalClauseAssessments"],
  selectionGradeEvidenceIds: readonly string[],
): {
  policyVersion: string;
  policyProjectionHash: string;
  assessments: Record<string, unknown>;
  evaluation: {
    status: "pass" | "fail" | "unknown";
    eligible: boolean;
    clauseStatuses: Record<string, "pass" | "fail" | "unknown">;
  };
  evidenceIntegrity: {
    passed: boolean;
    missingRequiredClauseIds: string[];
    unattestedEvidenceIds: string[];
  };
} {
  // Only immutable contract leaves may enter the persisted assessment. Extra
  // adapter keys are untrusted diagnostics and must not influence the hash.
  const boundedAssessments = Object.fromEntries(policy.clauses.flatMap((clause) => {
    const assessment = assessments?.[clause.id];
    return assessment ? [[clause.id, structuredClone(assessment)]] : [];
  }));
  const evaluation = evaluateCanonicalContractTrackV1({
    policy,
    assessments: boundedAssessments,
  });
  const attestedIds = new Set(selectionGradeEvidenceIds);
  const referencedEvidenceIds = [...new Set(
    Object.values(boundedAssessments)
      .flatMap((assessment) => (
        assessment && typeof assessment === "object"
          && Array.isArray((assessment as { evidenceIds?: unknown }).evidenceIds)
          ? (assessment as { evidenceIds: unknown[] }).evidenceIds
            .filter((value): value is string => (
              typeof value === "string" && value.trim().length > 0
            ))
          : []
      )),
  )];
  const missingRequiredClauseIds = policy.clauses.flatMap((clause) => {
    const assessment = assessments?.[clause.id];
    return clause.evidence.required
      && assessment?.status === "pass"
      && assessment.evidenceGrade !== "authoritative_structured_metadata"
      && (assessment.evidenceIds?.length ?? 0) === 0
      ? [clause.id]
      : [];
  });
  const unattestedEvidenceIds = referencedEvidenceIds
    .filter((id) => !attestedIds.has(id));
  return {
    policyVersion: policy.policyVersion,
    policyProjectionHash: policy.projectionHash,
    assessments: boundedAssessments,
    evaluation: {
      status: evaluation.status,
      eligible: evaluation.eligible,
      clauseStatuses: { ...evaluation.clauseStatuses },
    },
    evidenceIntegrity: {
      passed:
        missingRequiredClauseIds.length === 0
        && unattestedEvidenceIds.length === 0,
      missingRequiredClauseIds,
      unattestedEvidenceIds,
    },
  };
}

function pipelineV3QualificationDecision(
  qualification: CandidateQualificationV3,
  queryPlan: QueryPlanV3,
  canonical: ReturnType<
    typeof pipelineV3CanonicalPredicateProjection
  > | null,
): "qualified" | "failed" | "unknown" {
  const attestedBindings = attestedEvidenceBindingsForSelectionV3(
    qualification.evidence.bindingIds,
    qualification.evidence.bindings,
  );
  const membershipPassed = canonical
    ? canonical.evaluation.eligible && canonical.evidenceIntegrity.passed
    : qualification.scope.passed
      && qualification.hardConstraints.passed
      && qualification.evidence.passed
      && qualification.evidence.bindingIds.length > 0
      && attestedBindings.length > 0;
  const passed = membershipPassed
    && qualification.version.compatible
    && qualification.catalog.storefrontPlayable
    && Boolean(qualification.catalog.appleSongId)
    && Boolean(qualification.catalog.recordingFamilyKey);
  if (passed) return "qualified";
  const decisiveMembershipFailure = canonical
    ? canonical.evaluation.status === "fail"
      || !canonical.evidenceIntegrity.passed
    : !qualification.scope.passed
      || !qualification.hardConstraints.passed
      || !qualification.evidence.passed
      || qualification.evidence.bindingIds.length === 0
      || (qualification.evidence.passed && attestedBindings.length === 0);
  const decisiveFailure = decisiveMembershipFailure
    || !qualification.version.compatible
    || qualification.catalog.lookupAttempted === true
    || qualification.catalog.storefrontPlayable === false;
  // A passing OR/NOT canonical tree is authoritative for schema 4. Legacy
  // flattened booleans are retained below as observations only and cannot
  // turn that pass into a rejection.
  void queryPlan;
  return decisiveFailure ? "failed" : "unknown";
}

function pipelineV3QualificationProjection(
  candidate: RawTrackCandidateV3,
  qualification: CandidateQualificationV3,
  queryPlan: QueryPlanV3,
): {
  decision: "qualified" | "failed" | "unknown";
  stableIdentityHash: string;
  predicateResults: Record<string, unknown>;
  evidenceRecordIds: string[];
  qualityResult: Record<string, unknown>;
  catalogResult: Record<string, unknown>;
  qualificationHash: string;
} {
  const attestedBindings = attestedEvidenceBindingsForSelectionV3(
    qualification.evidence.bindingIds,
    qualification.evidence.bindings,
  );
  const canonical = queryPlan.canonicalContractPolicy
    ? pipelineV3CanonicalPredicateProjection(
        queryPlan.canonicalContractPolicy,
        qualification.canonicalClauseAssessments,
        attestedBindings.map(({ id }) => id),
      )
    : null;
  const decision = pipelineV3QualificationDecision(
    qualification,
    queryPlan,
    canonical,
  );
  const stableIdentityHash = pipelineV3QualificationStableIdentityHash(
    candidate,
    qualification,
  );
  const predicateResults = {
    scope: qualification.scope,
    hardConstraints: qualification.hardConstraints,
    ...(canonical ? {
      canonicalContract: canonical,
      legacyFlattenedAuthoritative: false,
    } : {}),
  };
  const evidenceRecordIds = [...new Set(qualification.evidence.bindingIds)]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .slice(0, 128);
  const qualityResult = {
    evidence: {
      passed: qualification.evidence.passed,
      strength: qualification.evidence.strength,
      independentProvenanceRoots:
        qualification.evidence.independentProvenanceRoots,
    },
    rankingSignals: qualification.rankingSignals,
    sourceRank: qualification.sourceRank,
    ...(qualification.playlistOptimizationSignals ? {
      playlistOptimizationSignals: normalizePlaylistOptimizationSignalsV3(
        qualification.playlistOptimizationSignals,
      ),
    } : {}),
  };
  const catalogResult = {
    version: qualification.version,
    catalog: qualification.catalog,
  };
  const qualificationHash = sha256Hex(stableStringify({
    decision,
    stableIdentityHash,
    predicateResults,
    evidenceRecordIds,
    qualityResult,
    catalogResult,
  }));
  return {
    decision,
    stableIdentityHash,
    predicateResults,
    evidenceRecordIds,
    qualityResult,
    catalogResult,
    qualificationHash,
  };
}

function semanticPlanRevisionAuditJson(
  revision: SemanticPlanRevisionArtifactV3,
): Record<string, unknown> {
  return {
    policyVersion: PIPELINE_V3_SEMANTIC_RECOVERY_POLICY,
    planHash: revision.planHash,
    transformations: revision.transformations,
    predicateProjection: revision.predicateProjection,
  };
}

function semanticPlanRevisionMatches(input: {
  revision: SemanticPlanRevisionArtifactV3;
  stored: {
    equivalence: string;
    hard_constraint_hash: string;
    plan_json: SelectionPlanV3;
    audit_json: unknown;
  };
}): boolean {
  return input.stored.equivalence === input.revision.equivalence
    && input.stored.hard_constraint_hash === input.revision.hardConstraintHash
    && stableStringify(input.stored.plan_json) === stableStringify(input.revision.plan)
    && stableStringify(input.stored.audit_json) === stableStringify(
      semanticPlanRevisionAuditJson(input.revision),
    );
}

const APPLE_CATALOG_CACHE_RESOURCE_KINDS = new Set<AppleCatalogCacheResourceKind>([
  "catalog_resource",
  "search_view",
  "artist_view",
  "playlist_membership",
  "musicbrainz_identity",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function frozenGraphAssertionContainsAttestation(input: {
  revision: unknown;
  attestation: Extract<EvidenceEligibilityAttestationV3, { kind: "frozen_promoted_graph_assertion" }>;
  sourceUrl: string;
}): boolean {
  const assertion = objectRecord(input.revision);
  if (!assertion || assertion.id !== input.attestation.assertionId
    || assertion.status !== "active"
    || !["verified", "corroborated"].includes(String(assertion.evidence_tier ?? ""))) return false;
  return (Array.isArray(assertion.evidence) ? assertion.evidence : []).some((raw) => {
    const pair = objectRecord(raw);
    const observation = objectRecord(pair?.observation);
    const source = objectRecord(pair?.sourceDocument);
    return observation?.id === input.attestation.observationId
      && observation.status === "promoted"
      && observation.credit_scope === "exact_recording"
      && source?.url === input.sourceUrl
      && source.approval_state === "approved"
      && ["reusable", "permission_recorded"].includes(String(source.license_state ?? ""))
      && !source.taken_down_at;
  });
}

function assertAppleCatalogCacheIdentity(
  storefront: string,
  resourceKind: AppleCatalogCacheResourceKind,
  requestFingerprint: string,
): void {
  if (!/^[a-z]{2}$/u.test(storefront.toLowerCase())
    || !APPLE_CATALOG_CACHE_RESOURCE_KINDS.has(resourceKind)
    || !/^[a-f0-9]{64}$/u.test(requestFingerprint)) {
    throw new HttpError(400, "Apple catalog cache identity is invalid", "invalid_catalog_cache_identity");
  }
}

async function persistPipelineOutcomeTransaction(
  client: PoolClient,
  runId: string,
  incoming: PipelineOutcome,
): Promise<PipelineOutcome> {
  const selectedRun = await client.query<{
    pipeline_version: string;
    policy_version: string;
  }>(
    `SELECT pipeline_version,policy_version FROM research_runs
     WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
    [runId],
  );
  const run = selectedRun.rows[0];
  if (!run) throw new HttpError(404, "Research run not found", "run_not_found");
  if (run.pipeline_version !== incoming.pipelineVersion || run.policy_version !== incoming.policyVersion) {
    throw new HttpError(409, "Pipeline outcome versions do not match the immutable run", "pipeline_policy_mismatch");
  }
  const selectedOutcome = await client.query<{ outcome_json: PipelineOutcome }>(
    "SELECT outcome_json FROM pipeline_outcomes WHERE run_id=$1 FOR UPDATE",
    [runId],
  );
  let merged: PipelineOutcome;
  try {
    merged = selectedOutcome.rows[0]
      ? mergePipelineOutcomes(selectedOutcome.rows[0].outcome_json, incoming)
      : incoming;
  } catch (error) {
    throw new HttpError(
      409,
      error instanceof Error ? error.message : "Pipeline outcome conflicts with persisted state",
      "pipeline_outcome_immutable",
    );
  }
  const serializedOutcome = JSON.stringify(merged);
  await client.query(
    `INSERT INTO pipeline_outcomes(
       id,run_id,status,target_track_count,discovered_track_count,qualified_track_count,
       selected_track_count,published_track_count,exact_count_satisfied,frontier_exhausted,
       provider_unavailable,reason_codes_json,deficit_snapshot_json,outcome_json,
       pipeline_version,policy_version,completed_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT(run_id) DO UPDATE SET
       status=EXCLUDED.status,target_track_count=EXCLUDED.target_track_count,
       discovered_track_count=EXCLUDED.discovered_track_count,
       qualified_track_count=EXCLUDED.qualified_track_count,
       selected_track_count=EXCLUDED.selected_track_count,
       published_track_count=EXCLUDED.published_track_count,
       exact_count_satisfied=EXCLUDED.exact_count_satisfied,
       frontier_exhausted=EXCLUDED.frontier_exhausted,
       provider_unavailable=EXCLUDED.provider_unavailable,
       reason_codes_json=EXCLUDED.reason_codes_json,
       deficit_snapshot_json=EXCLUDED.deficit_snapshot_json,
       outcome_json=EXCLUDED.outcome_json,completed_at=EXCLUDED.completed_at,updated_at=now()`,
    [
      randomUUID(),
      runId,
      merged.status,
      merged.targetTrackCount,
      merged.discoveredTrackCount,
      merged.qualifiedTrackCount,
      merged.selectedTrackCount,
      merged.publishedTrackCount,
      merged.exactCountSatisfied,
      merged.frontierExhausted,
      merged.providerUnavailable,
      JSON.stringify(merged.reasonCodes),
      JSON.stringify(merged.deficits),
      serializedOutcome,
      merged.pipelineVersion,
      merged.policyVersion,
      merged.completedAt,
    ],
  );
  // Version columns are immutable after run creation. Outcome retries may only
  // advance the monotonic projection stored on the run.
  await client.query(
    "UPDATE research_runs SET pipeline_outcome_json=$2,updated_at=now() WHERE id=$1",
    [runId, serializedOutcome],
  );
  return merged;
}

function boundedPipelineBatch<T>(items: readonly T[], maximum: number, field: string): readonly T[] {
  if (items.length > maximum) {
    throw new HttpError(400, `${field} exceeds the ${maximum}-item persistence limit`, "pipeline_batch_too_large");
  }
  return items;
}

const MAX_CATALOG_MATCH_SCORE = 99.999999;

function normalizedCatalogMatchScore(score: number): number {
  if (!Number.isFinite(score)) {
    throw new HttpError(400, "Catalog match score must be finite", "invalid_catalog_match_score");
  }
  return Math.min(MAX_CATALOG_MATCH_SCORE, Math.max(0, score));
}

interface CandidateStageProgression {
  candidateId: string;
  stages: ReadonlyArray<{
    toStage: CandidateStage;
    reasonCode: string;
    detail?: Record<string, unknown>;
  }>;
}

const CANDIDATE_STAGE_RANK: Partial<Record<CandidateStage, number>> = {
  discovered: 0,
  identity_resolved: 1,
  scope_qualified: 2,
  claim_verified: 3,
  version_compatible: 4,
  catalog_resolved: 5,
  playable: 6,
  canonicalized: 7,
  eligible: 7,
  quota_eligible: 8,
  sequenced: 9,
  selected: 9,
  manifested: 10,
  published: 11,
};

const TERMINAL_CANDIDATE_STAGES = new Set<CandidateStage>(["rejected", "exhausted"]);

/**
 * Advance candidate history inside an existing transaction. Events are
 * inserted in one bounded batch and use stable IDs that deliberately exclude
 * their timestamp, so a reclaimed worker cannot create a second copy of the
 * same semantic transition.
 */
async function advanceCandidateStagesTransaction(
  client: PoolClient,
  runId: string,
  progressions: readonly CandidateStageProgression[],
  versions: Pick<SelectionPlan, "pipelineVersion" | "policyVersion">,
): Promise<CandidateStageEvent[]> {
  const targetCount = progressions.reduce((count, progression) => count + progression.stages.length, 0);
  if (targetCount === 0) return [];
  if (targetCount > 50_000) {
    throw new HttpError(400, "Candidate stage transitions exceed the 50000-item persistence limit", "pipeline_batch_too_large");
  }
  const candidateIds = [...new Set(progressions.map((progression) => progression.candidateId))];
  const selected = await client.query<{
    id: string;
    candidate_stage: CandidateStage;
    stage_updated_at: Date;
  }>(
    `SELECT id,candidate_stage,stage_updated_at FROM track_candidates
     WHERE run_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE`,
    [runId, candidateIds],
  );
  if (selected.rows.length !== candidateIds.length) {
    throw new HttpError(400, "Stage transition references a candidate outside this research run", "invalid_candidate_stage_event");
  }
  const currentById = new Map(selected.rows.map((row) => [row.id, {
    stage: row.candidate_stage,
    occurredAt: date(row.stage_updated_at) ?? new Date(0),
  }]));
  const base = Date.now();
  const events: CandidateStageEvent[] = [];
  for (const progression of progressions) {
    const current = currentById.get(progression.candidateId)!;
    for (const target of progression.stages) {
      if (TERMINAL_CANDIDATE_STAGES.has(current.stage)) break;
      const currentRank = CANDIDATE_STAGE_RANK[current.stage];
      const targetRank = CANDIDATE_STAGE_RANK[target.toStage];
      if (target.toStage !== "rejected"
        && currentRank != null
        && targetRank != null
        && currentRank >= targetRank) continue;
      if (target.toStage === current.stage) continue;
      const occurredAt = new Date(Math.max(
        base + events.length,
        current.occurredAt.getTime() + 1,
      ));
      events.push({
        candidateId: progression.candidateId,
        fromStage: current.stage,
        toStage: target.toStage,
        reasonCode: target.reasonCode.slice(0, 120),
        detail: { ...(target.detail ?? {}) },
        occurredAt: occurredAt.toISOString(),
      });
      current.stage = target.toStage;
      current.occurredAt = occurredAt;
    }
  }
  if (events.length === 0) return [];
  const input = events.map((event) => ({
    id: deterministicUuid({
      runId,
      candidateId: event.candidateId,
      fromStage: event.fromStage,
      toStage: event.toStage,
      reasonCode: event.reasonCode,
      detail: event.detail,
    }),
    candidate_id: event.candidateId,
    from_stage: event.fromStage,
    to_stage: event.toStage,
    reason_code: event.reasonCode,
    detail_json: event.detail,
    occurred_at: event.occurredAt,
  }));
  await client.query(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($2::jsonb) AS item(
         id uuid,candidate_id uuid,from_stage varchar,to_stage varchar,
         reason_code varchar,detail_json jsonb,occurred_at timestamptz
       )
     )
     INSERT INTO candidate_stage_events(
       id,run_id,candidate_id,from_stage,to_stage,reason_code,detail_json,
       pipeline_version,policy_version,occurred_at)
     SELECT id,$1,candidate_id,from_stage,to_stage,reason_code,detail_json,$3,$4,occurred_at
     FROM input ON CONFLICT(id) DO NOTHING`,
    [runId, JSON.stringify(input), versions.pipelineVersion, versions.policyVersion],
  );
  await client.query(
    `UPDATE track_candidates tc SET candidate_stage=latest.to_stage,
       stage_updated_at=latest.occurred_at,pipeline_version=$2,policy_version=$3
     FROM (
       SELECT DISTINCT ON (candidate_id) candidate_id,to_stage,occurred_at
       FROM candidate_stage_events WHERE run_id=$1
       ORDER BY candidate_id,occurred_at DESC,id DESC
     ) latest
     WHERE tc.id=latest.candidate_id AND tc.run_id=$1
       AND tc.stage_updated_at<=latest.occurred_at`,
    [runId, versions.pipelineVersion, versions.policyVersion],
  );
  return events;
}

async function getPipelineStageCountsTransaction(
  client: Pick<PoolClient, "query">,
  runId: string,
): Promise<PipelineStageCounts> {
  const [candidateCount, reached] = await Promise.all([
    client.query<{ count: number }>(
      "SELECT count(*)::int count FROM track_candidates WHERE run_id=$1",
      [runId],
    ),
    client.query<{ stage: string; count: number }>(
      `SELECT CASE
         WHEN to_stage='eligible' THEN 'canonicalized'
         WHEN to_stage='selected' THEN 'sequenced'
         ELSE to_stage
       END stage,count(DISTINCT candidate_id)::int count
       FROM candidate_stage_events WHERE run_id=$1
       GROUP BY 1`,
      [runId],
    ),
  ]);
  const counts: PipelineStageCounts = {
    discovered: Number(candidateCount.rows[0]?.count ?? 0),
  };
  for (const row of reached.rows) {
    if ((PIPELINE_LEDGER_STAGES as readonly string[]).includes(row.stage)) {
      counts[row.stage as keyof PipelineStageCounts] = Number(row.count ?? 0);
    }
  }
  return counts;
}

function primaryEvidenceScopeAxis(
  plan: SelectionPlan | null,
): TrackScopeBinding["scopeAxis"] {
  if (plan?.intents.includes("factual_relationship")) return "factual_relationship";
  if (plan?.intents.includes("similarity")) return "similarity";
  if (plan?.intents.includes("mood_activity")) return "mood_theme_activity";
  if (plan?.intents.includes("theme")) return "theme";
  if (plan?.intents.includes("artist_catalogue")) return "artist_catalog";
  if (plan?.intents.includes("editorial_ranking")) return "editorial_ranked";
  if (plan?.intents.includes("exhaustive")) return "exhaustive";
  const scopedConstraint = plan?.constraints.find((constraint) => [
    "genre", "scene", "era", "geography", "language", "mood", "theme", "activity",
  ].includes(constraint.axis));
  if (scopedConstraint && [
    "genre", "scene", "era", "geography", "language", "mood", "theme", "activity",
  ].includes(scopedConstraint.axis)) {
    return scopedConstraint.axis as TrackScopeBinding["scopeAxis"];
  }
  return "genre_scene";
}

const EDITORIAL_RANKING_PROOF = /\b(?:best|essential|influential|important|definitive|iconic|foundational|representative|historical(?:ly)?|cultural(?:ly)?|shaped|impact)\b/iu;
const SIMILARITY_PROOF = /\b(?:sounds?\s+like|similar(?:ity|\s+to)?|resembl|adjacent\s+to|style\s+of|vein\s+of|production|tempo|harmony|vocal\s+style)\b/iu;
const ARTIST_CATALOG_PROOF = /\b(?:primary\s+artist|recorded\s+by|performed\s+by|songs?\s+by|tracks?\s+by|artist\s+catalog(?:ue)?|discograph)\b/iu;

function evidenceIntentScopeAxis(
  plan: SelectionPlan,
  intent: SelectionPlan["intents"][number],
): TrackScopeBinding["scopeAxis"] {
  if (intent === "factual_relationship") return "factual_relationship";
  if (intent === "exhaustive") return "exhaustive";
  if (intent === "similarity") return "similarity";
  if (intent === "mood_activity") return "mood_theme_activity";
  if (intent === "theme") return "theme";
  if (intent === "artist_catalogue") return "artist_catalog";
  if (intent === "editorial_ranking") return "editorial_ranked";
  const scoped = plan.constraints.find((constraint) => (
    constraint.axis === "genre" || constraint.axis === "scene"
  ));
  return scoped?.axis === "genre" || scoped?.axis === "scene"
    ? scoped.axis
    : "genre_scene";
}

/**
 * One evidence row may prove one or several explicit intent axes, but it must
 * never inherit every axis just because the run is composite. This lets two
 * independent citations jointly prove "performed on" + "influential" while
 * retaining two auditable claims through manifest lock.
 */
function evidenceIntentScopeAxes(
  plan: SelectionPlan,
  relationshipProofText: string,
  requestedRelationship: string,
): TrackScopeBinding["scopeAxis"][] {
  // Intent axes must be asserted by the exact relationship claim. The subject
  // entity and explanatory note describe the requested scope; allowing either
  // to prove an axis makes an unrelated citation look relevant merely because
  // it repeats the prompt.
  const text = relationshipProofText;
  const exactRelationship = proofTextSupportsValue(relationshipProofText, requestedRelationship);
  const axes: TrackScopeBinding["scopeAxis"][] = [];
  for (const intent of plan.intents) {
    const supported = intent === "factual_relationship"
      ? assertsFactualTrackRelationship(text)
      : intent === "exhaustive"
        ? exactRelationship || assertsFactualTrackRelationship(text)
        : intent === "editorial_ranking"
          ? EDITORIAL_RANKING_PROOF.test(text)
          : intent === "similarity"
            ? SIMILARITY_PROOF.test(text)
            : intent === "artist_catalogue"
              ? exactRelationship || ARTIST_CATALOG_PROOF.test(text)
              : intent === "genre_scene"
                ? exactRelationship || plan.constraints.some((constraint) => (
                  (constraint.axis === "genre" || constraint.axis === "scene")
                    && constraint.values.some((value) => proofTextSupportsValue(relationshipProofText, value))
                ))
                : intent === "mood_activity"
                  ? plan.constraints.some((constraint) => (
                    (constraint.axis === "mood" || constraint.axis === "activity")
                      && constraint.values.some((value) => proofTextSupportsValue(relationshipProofText, value))
                  ))
                  : intent === "theme"
                    ? plan.constraints.some((constraint) => (
                      constraint.axis === "theme"
                        && constraint.values.some((value) => proofTextSupportsValue(relationshipProofText, value))
                    ))
                    : false;
    if (supported) axes.push(evidenceIntentScopeAxis(plan, intent));
  }
  return [...new Set(axes)];
}

const CONSTRAINT_PROOF_STOPWORDS = new Set([
  "a", "an", "and", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "with",
  "recording", "recordings", "song", "songs", "track", "tracks", "music",
]);

function meaningfulConstraintTokens(value: string): string[] {
  return normalizedPolicyText(value).split(" ").filter((token) => (
    token.length >= 3 && !CONSTRAINT_PROOF_STOPWORDS.has(token)
  ));
}

function proofTextSupportsValue(proofText: string, value: string): boolean {
  const proofTokens = new Set(meaningfulConstraintTokens(proofText));
  const expected = [...new Set(meaningfulConstraintTokens(value))];
  if (expected.length === 0) return false;
  const overlap = expected.filter((token) => proofTokens.has(token)).length;
  const required = expected.length <= 2 ? expected.length : Math.max(2, Math.ceil(expected.length / 2));
  return overlap >= required;
}

interface EvidenceScopeDescriptor {
  scopeAxis: TrackScopeBinding["scopeAxis"];
  scopeValue: string;
  geographyRelationship: TrackScopeBinding["geographyRelationship"];
}

function constraintScopeAxis(axis: SelectionConstraint["axis"]): TrackScopeBinding["scopeAxis"] | null {
  if (axis === "genre" || axis === "subgenre") return "genre";
  if (axis === "scene" || axis === "label" || axis === "venue") return "scene";
  if (axis === "geography") return "geography";
  if (axis === "language") return "language";
  if (axis === "mood") return "mood";
  if (axis === "activity") return "activity";
  if (axis === "theme") return "theme";
  return null;
}

export function deriveEvidenceScopeDescriptors(
  plan: SelectionPlan | null,
  brief: PlaylistBrief,
  relationshipProofText: string,
): EvidenceScopeDescriptor[] {
  if (plan && !evidenceRelationshipIsMaterial(relationshipProofText)) return [];
  const descriptors: EvidenceScopeDescriptor[] = [];
  const seen = new Set<string>();
  const add = (
    scopeAxis: TrackScopeBinding["scopeAxis"],
    scopeValue: string,
    geographyRelationship: TrackScopeBinding["geographyRelationship"] = null,
  ) => {
    const clean = scopeValue.trim().slice(0, 240);
    const key = `${scopeAxis}:${normalizedPolicyText(clean)}:${geographyRelationship ?? ""}`;
    if (!clean || seen.has(key)) return;
    seen.add(key);
    descriptors.push({ scopeAxis, scopeValue: clean, geographyRelationship });
  };

  for (const constraint of plan?.constraints ?? []) {
    if (constraint.operator === "exclude" || constraint.operator === "avoid") continue;
    if (constraint.axis === "relationship") {
      // A curated brief's model-authored relationship is intentionally a soft
      // selection preference, but an exact source assertion may still use it
      // to establish the typed intent axis. Ignoring soft relationship rows
      // here left otherwise authoritative track citations with no scope
      // binding at all. Whether the relationship is a non-relaxable manifest
      // requirement remains controlled by the constraint's hard/soft kind.
      for (const value of constraint.values) {
        if (!plan) {
          if (proofTextSupportsValue(relationshipProofText, value)) add(primaryEvidenceScopeAxis(null), value);
          continue;
        }
        for (const scopeAxis of evidenceIntentScopeAxes(plan, relationshipProofText, value)) {
          add(scopeAxis, relationshipProofText);
        }
      }
      continue;
    }
    if (constraint.kind !== "hard") continue;
    const scopeAxis = constraintScopeAxis(constraint.axis);
    if (!scopeAxis) continue;
    for (const value of constraint.values) {
      const geographyRelationship = constraint.geographyRelationship
        ?? (constraint.axis === "language" ? "language" : null);
      const exactRelationshipSupported = !geographyRelationship
        || geographyRelationship === "unspecified"
        || proofSupportsSelectionGeography(relationshipProofText, {
          value,
          relationship: geographyRelationship,
        });
      // The brief subject and evidence note routinely repeat the requested
      // scope. They are context, not proof. Only the source-specific
      // relationship assertion may establish a hard scope axis; otherwise a
      // citation described as "unrelated" can qualify simply because its
      // canonical subject contains words such as "American house".
      if (proofTextSupportsValue(relationshipProofText, value) && exactRelationshipSupported) {
        add(scopeAxis, value, geographyRelationship);
      }
    }
  }

  // Legacy V1 runs do not persist typed constraints. Preserve their one-axis
  // binding shape without weakening V2, whose relationship constraint must be
  // proven explicitly above.
  if (!plan && descriptors.length === 0) {
    add(primaryEvidenceScopeAxis(null), brief.subjectEntities.join(", ") || brief.title);
  }
  return descriptors;
}

interface ManifestScopeBindingProof {
  bindingKind: TrackScopeBinding["bindingKind"];
  scopeAxis: TrackScopeBinding["scopeAxis"];
  scopeValue: string;
  geographyRelationship: TrackScopeBinding["geographyRelationship"];
  relationship: string;
  note: string;
  confidence: number;
  provenanceRoot: string;
  sourceRecordId: string;
  sourceUrl: string;
  citationAttestationId: string | null;
  provenancePath: Array<{ kind: string; id: string; label?: string }>;
}

interface ManifestSelectionRow {
  candidate_id: string;
  recording_family_id: string | null;
  selection_rank: number | null;
  catalog_id: string;
  song_json: CatalogSong;
  artist: string;
  title: string;
  album: string | null;
  release_year: number | null;
  /**
   * Edition dates from the compatible Apple identities attached to the same
   * recording family. A modern reissue date must not erase an older,
   * compatible issue of the exact recording when enforcing a hard era.
   */
  compatible_release_years: number[] | null;
  duration_ms: number | null;
}

function normalizedPolicyText(value: unknown): string {
  return normalizeMusicText(typeof value === "string" ? value : "");
}

function authoritativeScopeBinding(
  binding: ManifestScopeBindingProof,
  pipelineVersion: string,
  policyVersion: string,
  storedPipelineVersion: string,
  storedPolicyVersion: string,
): boolean {
  if (storedPipelineVersion !== pipelineVersion || storedPolicyVersion !== policyVersion) return false;
  const root = normalizedPolicyText(binding.provenanceRoot);
  if (!root || root === "unknown") return false;
  if (!binding.sourceRecordId || !binding.sourceUrl.startsWith("https://")) return false;
  const rootStep = binding.provenancePath.some((step) => (
    step.kind === "provenance_root" && normalizedPolicyText(step.id) === root
  ));
  const sourceStep = binding.provenancePath.some((step) => (
    step.kind === "source_record" && step.id === binding.sourceRecordId
  ));
  if (!rootStep || !sourceStep) return false;
  const lineageUnclassified = root === "unclassified";
  if (lineageUnclassified && (
    binding.bindingKind !== "track_specific_source"
    || !binding.citationAttestationId
    || !Number.isFinite(binding.confidence)
    || binding.confidence < 0.8
  )) return false;
  // `unclassified` is a shared lineage bucket, not automatically an invalid
  // source. Hosted search often cannot prove an upstream origin independently
  // of the page carrying an exact track claim. Permit only strong,
  // citation-attested track-specific bindings in that bucket. Medium claims
  // and generic container memberships still cannot use unknown lineage, and
  // all unclassified claims continue to collapse into one provenance root so
  // they cannot masquerade as independent corroboration.
  // A track-specific hosted-web assertion is authoritative only when its
  // citation attestation survived persistence. Scoped adapter/editorial
  // membership may instead be bound by its stored source/container record.
  if (binding.bindingKind === "track_specific_source" && !binding.citationAttestationId) return false;
  return Number.isFinite(binding.confidence) && binding.confidence >= 0.7;
}

function bindingSupportsConstraint(
  binding: ManifestScopeBindingProof,
  constraint: SelectionConstraint,
): boolean {
  if (constraint.axis === "evidence") return false;
  if (constraint.axis === "relationship") {
    return constraint.values.some((value) => proofTextSupportsValue(
      `${binding.scopeValue} ${binding.relationship}`,
      value,
    ));
  }
  const compatibleAxes: Record<SelectionConstraint["axis"], TrackScopeBinding["scopeAxis"][]> = {
    genre: ["genre", "scene", "genre_scene"],
    scene: ["scene", "genre_scene"],
    subgenre: ["genre", "scene", "genre_scene"],
    era: ["era"],
    geography: ["geography", "scene", "genre_scene"],
    language: ["language"],
    mood: ["mood", "mood_theme_activity"],
    activity: ["activity", "mood_theme_activity"],
    theme: ["theme", "mood_theme_activity"],
    artist: ["artist_catalog"],
    album: [],
    track: [],
    label: ["scene", "genre_scene"],
    venue: ["scene", "genre_scene"],
    recording_version: [],
    content: [],
    evidence: [],
    relationship: [],
  };
  if (!compatibleAxes[constraint.axis].includes(binding.scopeAxis)) return false;
  const requiredGeographyRelationship = constraint.geographyRelationship
    ?? (constraint.axis === "language" ? "language" : null);
  if (requiredGeographyRelationship
    && requiredGeographyRelationship !== "unspecified"
    && bindingGeographyRelationship(binding) !== requiredGeographyRelationship) {
    return false;
  }
  const proofText = [
    binding.scopeValue,
    binding.relationship,
    binding.note,
  ].join(" ");
  return constraint.values.some((value) => proofTextSupportsValue(proofText, value));
}

function metadataContainsConstraintValue(
  row: ManifestSelectionRow,
  constraint: SelectionConstraint,
): boolean {
  const song = row.song_json;
  const metadata = normalizedPolicyText([
    row.artist,
    row.title,
    row.album ?? "",
    song.artistName,
    song.name,
    song.albumName,
    ...(song.genreNames ?? []),
    song.versionLabel ?? "",
  ].join(" "));
  return constraint.values.some((rawValue) => {
    const value = normalizedPolicyText(rawValue)
      .replace(/^(?:exclude|avoid|without|no|not)\s+/u, "")
      .trim();
    return value.length > 0 && metadata.includes(value);
  });
}

function manifestCanonicalReleaseYear(row: ManifestSelectionRow): number | null {
  return canonicalRecordingFamilyReleaseYear({
    candidateReleaseYear: row.release_year,
    appleReleaseDate: row.song_json.releaseDate,
    compatibleReleaseYears: row.compatible_release_years,
  });
}

/**
 * Enforce an era against evidence attached to the exact recording family,
 * rather than treating one Apple edition date as the recording's origin.
 *
 * This remains a hard floor: an in-range year must come from the candidate or
 * a catalog identity already canonicalized into the same compatible recording
 * family. Metadata-neighbor search results and unrelated covers/remixes never
 * reach this list.
 */
export function manifestEraConstraintSatisfied(
  input: {
    candidateReleaseYear: number | null;
    appleReleaseDate?: string | null;
    compatibleReleaseYears?: readonly number[] | null;
  },
  constraint: Pick<SelectionConstraint, "operator" | "values">,
): boolean {
  return recordingFamilySatisfiesEraConstraint(input, constraint);
}

export interface PersistedPlaylistContractRevision {
  id: string;
  revision: number;
  parentRevisionId: string | null;
  contractHash: string;
  contract: Record<string, unknown>;
  compilerVersion: string;
  ontologyVersion: string;
  evidencePolicyVersion: string;
  questionTemplateVersion: string;
  catalogPolicyVersion: string;
  locale: string;
  storefront: string;
  answerLineageHash: string;
  createdAt: string;
}

export interface SavePlaylistContractRevisionInput {
  briefRequestId?: string | null;
  runId?: string | null;
  expectedParentRevisionId?: string | null;
  contractHash: string;
  contract: Record<string, unknown>;
  compilerVersion: string;
  ontologyVersion: string;
  evidencePolicyVersion: string;
  questionTemplateVersion: string;
  catalogPolicyVersion: string;
  locale: string;
  storefront: string;
  answerLineageHash: string;
  guidanceAnswerSetId?: string | null;
}

export interface SavePlaylistFeasibilitySnapshotInput {
  contractRevisionId: string;
  phase: "initial" | "post_guidance" | "recovery";
  assessment:
    | "contradictory"
    | "known_ceiling"
    | "likely"
    | "at_risk"
    | "unknown"
    | "frontier_exhausted_under_policy";
  targetCount: number;
  observedQualifiedCount: number;
  projectedLowerCount: number | null;
  projectedUpperCount: number | null;
  confidence: number | null;
  reportHash: string;
  report: Record<string, unknown>;
}

export interface BeginPlaylistExecutionAttemptInput {
  runId: string;
  contractRevisionId: string;
  stage: string;
  dependencyKey?: string | null;
  attemptNumber: number;
  leaseGeneration: number;
  executorRevision: string;
  executorIdentityHash: string;
  configurationHash: string;
  idempotencyKey: string;
  checkpointCursor?: string | null;
}

export interface OpenPlaylistRunBlockerInput {
  runId: string;
  contractRevisionId: string;
  blockerKind:
    | "guidance"
    | "scope_decision"
    | "provider"
    | "apple_authorization"
    | "budget"
    | "integrity"
    | "publication_reconciliation";
  dependencyKey?: string | null;
  retryCount?: number;
  nextRetryAt?: Date | null;
  automaticRetryUntil?: Date | null;
  state?: Record<string, unknown>;
}

export interface CreateCanonicalRunSuccessorInput {
  /** Canonical source run being superseded. */
  runId: string;
  /** Authenticated visitor access that is authorized to receive the successor. */
  sourceAccessId: string;
  /** Optimistic database-row fence, not the semantic pcr1 revision identifier. */
  expectedContractRevisionId: string;
  expectedContractSemanticHash: string;
  patch: PlaylistContractPatchV1;
  idempotencyKey: string;
  trigger:
    | "rescue_guidance"
    | "named_predicate_revision"
    | "count_revision";
}

export interface CanonicalRunSuccessorResult {
  runId: string;
  accessId: string;
  contractRevisionId: string;
  queryPlanRevisionId: string | null;
  created: boolean;
  status: "queued" | "awaiting_budget" | "needs_decision";
}

function eraConstraintSatisfied(row: ManifestSelectionRow, constraint: SelectionConstraint): boolean {
  return manifestEraConstraintSatisfied({
    candidateReleaseYear: row.release_year,
    appleReleaseDate: row.song_json.releaseDate,
    compatibleReleaseYears: row.compatible_release_years,
  }, constraint);
}

function manifestConstraintViolations(input: {
  row: ManifestSelectionRow;
  plan: SelectionPlan;
  bindings: readonly ManifestScopeBindingProof[];
  scopeEligible: boolean;
}): string[] {
  const { row, plan, bindings } = input;
  const versionClass = catalogRecordingVersionClass(row.song_json);
  const contentRating = catalogContentRating(row.song_json);
  const violations: string[] = [];
  for (const constraint of plan.constraints) {
    // Aggregate maxima are evaluated against the ordered candidate pool
    // below. They cannot be answered from one row's metadata or evidence.
    if (constraint.operator === "maximum" && constraint.axis === "artist") {
      continue;
    }
    let satisfied = false;
    if (constraint.axis === "evidence") {
      satisfied = input.scopeEligible;
    } else if (constraint.axis === "recording_version") {
      satisfied = plan.versionPolicy.allowed.includes(versionClass);
    } else if (constraint.operator === "exclude" || constraint.operator === "avoid") {
      const scopeBound = constraint.axis === "relationship" || constraintScopeAxis(constraint.axis) !== null;
      satisfied = scopeBound
        ? !bindings.some((binding) => bindingSupportsConstraint(binding, constraint))
        : !metadataContainsConstraintValue(row, constraint);
    } else if (constraint.axis === "era") {
      satisfied = eraConstraintSatisfied(row, constraint);
    } else if (constraint.axis === "artist") {
      const artist = normalizedPolicyText(row.song_json.artistName || row.artist);
      satisfied = constraint.values.some((value) => artist === normalizedPolicyText(value));
    } else if (constraint.axis === "track") {
      const title = normalizedPolicyText(row.song_json.name || row.title);
      satisfied = constraint.values.some((value) => title === normalizedPolicyText(value));
    } else if (constraint.axis === "content") {
      const requested = normalizedPolicyText(constraint.values.join(" "));
      satisfied = requested.includes("clean")
        ? contentRating === "clean"
        : requested.includes("explicit")
          ? contentRating === "explicit"
          : requested.includes("instrumental")
            ? /\binstrumental\b/iu.test(`${row.song_json.name} ${row.song_json.versionLabel ?? ""}`)
            : metadataContainsConstraintValue(row, constraint);
    } else if (constraint.axis === "relationship") {
      // Composite relationships may be proved across multiple independent
      // intent-axis bindings, but only when each binding's explicit
      // relationship supports its own scope value. Never borrow subject or
      // note prose: those fields often repeat the requested prompt verbatim.
      const combinedProof = bindings
        .filter((binding) => proofTextSupportsValue(binding.relationship, binding.scopeValue))
        .map((binding) => `${binding.scopeValue} ${binding.relationship}`)
        .join(" ");
      satisfied = constraint.values.some((value) => (
        proofTextSupportsValue(combinedProof, value)
      ));
    } else {
      satisfied = bindings.some((binding) => bindingSupportsConstraint(binding, constraint));
    }
    if (!satisfied) violations.push(constraint.id);
  }
  if (!input.scopeEligible) violations.push("scope_evidence_eligibility");
  if (!plan.versionPolicy.allowed.includes(versionClass)) violations.push("recording_version_policy");
  if (plan.contentPolicy.explicitContent === "clean_only" && contentRating !== "clean") {
    violations.push("clean_content_policy");
  }
  if (plan.contentPolicy.instrumental === "exclude"
    && /\binstrumental\b/iu.test(`${row.song_json.name} ${row.song_json.versionLabel ?? ""}`)) {
    violations.push("instrumental_content_policy");
  }
  return [...new Set(violations)];
}

function manifestConstraintRules(plan: SelectionPlan): ConstraintRule[] {
  const byId = new Map<string, ConstraintRule>();
  const add = (rule: ConstraintRule) => {
    if (!byId.has(rule.id)) byId.set(rule.id, rule);
  };
  for (const constraint of plan.constraints) {
    add({ id: constraint.id, kind: constraint.kind, relaxationRank: constraint.relaxationRank });
  }
  add({ id: "scope_evidence_eligibility", kind: "hard", relaxationRank: null });
  add({ id: "recording_version_policy", kind: "hard", relaxationRank: null });
  if (plan.contentPolicy.explicitContent === "clean_only") {
    add({ id: "clean_content_policy", kind: "hard", relaxationRank: null });
  }
  if (plan.contentPolicy.instrumental === "exclude") {
    add({ id: "instrumental_content_policy", kind: "hard", relaxationRank: null });
  }
  plan.softGoalRelaxationOrder.forEach((id, index) => {
    add({ id, kind: "soft", relaxationRank: index });
  });
  return [...byId.values()];
}

function normalizedGuidanceAnswers(
  questions: readonly PlaylistGuidanceQuestion[],
  submitted: readonly PlaylistGuidanceAnswer[],
  contractVersion: 1 | 2 | 3 = 1,
): PlaylistGuidanceAnswer[] {
  if (questions.length < 1 || questions.length > 3
    || submitted.length > questions.length
    || (contractVersion === 1 && submitted.length !== questions.length)) {
    throw new HttpError(400, "Answer every playlist question", "invalid_guidance_answers");
  }
  const submittedByQuestion = new Map<string, PlaylistGuidanceAnswer>();
  for (const answer of submitted) {
    if (!answer || typeof answer !== "object" || typeof answer.questionId !== "string") {
      throw new HttpError(400, "Playlist answers are invalid", "invalid_guidance_answers");
    }
    if (submittedByQuestion.has(answer.questionId)) {
      throw new HttpError(400, "Each playlist question can be answered once", "invalid_guidance_answers");
    }
    submittedByQuestion.set(answer.questionId, answer);
  }
  return questions.map((question) => {
    const answer = submittedByQuestion.get(question.id);
    if (!answer || answer.skipped === true) {
      if (contractVersion >= 2 && question.criticality !== "required") {
        return { questionId: question.id, skipped: true };
      }
      throw new HttpError(400, "Answer every required playlist question", "invalid_guidance_answers");
    }
    const submittedOptionIds = [
      ...(typeof answer.optionId === "string" ? [answer.optionId] : []),
      ...(Array.isArray(answer.optionIds) ? answer.optionIds : []),
    ].map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean);
    const optionIds = [...new Set(submittedOptionIds)];
    const customText = typeof answer.customText === "string" ? answer.customText.trim() : "";
    if ((optionIds.length > 0) === Boolean(customText)) {
      throw new HttpError(400, "Choose playlist options or enter one custom answer", "invalid_guidance_answers");
    }
    if (customText && contractVersion >= 2 && question.allowCustom === false) {
      throw new HttpError(400, "This playlist question does not accept a custom answer", "invalid_guidance_answers");
    }
    if (optionIds.length > 0) {
      if (question.selectionMode !== "multiple" && optionIds.length !== 1) {
        throw new HttpError(400, "Choose exactly one playlist option", "invalid_guidance_answers");
      }
      if (optionIds.some((optionId) => !question.options.some((option) => option.id === optionId))) {
        throw new HttpError(400, "A selected playlist option is invalid", "invalid_guidance_answers");
      }
      return optionIds.length === 1
        ? { questionId: question.id, optionId: optionIds[0] }
        : { questionId: question.id, optionIds };
    }
    if (Array.from(customText).length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(customText)) {
      throw new HttpError(400, "Custom playlist answers must be 1–500 characters", "invalid_guidance_answers");
    }
    const safeCustomText = safeCustomGuidanceText(customText);
    if (!safeCustomText) {
      throw new HttpError(
        400,
        "Custom answers must describe a music preference for this question",
        "invalid_guidance_answers",
      );
    }
    return { questionId: question.id, customText: safeCustomText };
  });
}

async function markTerminalPublicationVolumes(
  client: Pick<PoolClient, "query">,
  payload: Record<string, unknown> | null,
  error: string,
): Promise<void> {
  const manifestId = typeof payload?.manifestId === "string" ? payload.manifestId : "";
  if (!manifestId) return;
  const publicError = sanitizeFailure(error, "publication");
  // A terminal worker failure does not prove that Apple's playlist contents
  // diverged from the manifest. Preserve the resource ID so an explicit retry
  // can reconcile it. Confirmed divergence and persistent 404s are orphaned by
  // the deterministic publisher before they cross this generic failure path.
  await client.query(
    `UPDATE publication_volumes pv SET status='failed',last_error=$2,updated_at=now()
     WHERE pv.manifest_id=$1 AND pv.status NOT IN ('complete','waiting_for_owner')
       AND EXISTS (
         SELECT 1 FROM manifests m JOIN research_runs r ON r.id=m.run_id
         WHERE m.id=pv.manifest_id AND r.status<>'waiting_for_apple_authorization'
       )`,
    [manifestId, publicError],
  );
}

function isCatalogRecoveryJob(payload: Record<string, unknown> | null): boolean {
  return payload?.retryIncomplete === true;
}

function catalogRecoveryGeneration(payload: Record<string, unknown> | null): number {
  const value = Number(payload?.recoveryGeneration);
  return Number.isInteger(value) && value >= 1 && value <= 3 ? value : 3;
}

async function settleCatalogRecoveryFailure(
  client: Pick<PoolClient, "query">,
  runId: string,
  generation: number,
): Promise<void> {
  if (generation >= 3) {
    await client.query(
      `UPDATE catalog_matches SET basis=$3
       WHERE run_id=$1 AND status='review' AND song_json IS NULL AND basis=ANY($2::text[])
         AND EXISTS (
           SELECT 1 FROM research_runs r WHERE r.id=$1
             AND r.status IN ('matching','review','visitor_review')
         )`,
      [runId, [...RETRYABLE_CATALOG_MATCH_BASES], CATALOG_RECOVERY_UNRESOLVED_BASIS],
    );
  }
  await client.query(
    `UPDATE research_runs SET status='visitor_review',phase='exception_review',error=NULL,
       completed_at=NULL,updated_at=now()
     WHERE id=$1 AND status IN ('matching','review','visitor_review')`,
    [runId],
  );
}

export function manifestOrderSql(brief: Pick<PlaylistBrief, "mode" | "orderingPolicy">): string {
  // Curated extraction persists the model's reviewed editorial sequence as a
  // one-based rank. Use the strict brief mode—not free-form model wording—to
  // decide whether that rank governs truncation and the immutable manifest.
  if (brief.mode === "curated") {
    return "c.selection_rank NULLS LAST,c.artist,c.title,c.id";
  }
  const normalized = brief.orderingPolicy.toLowerCase();
  if (normalized.includes("evidence") || normalized.includes("confidence")) {
    return `(SELECT COALESCE(max(CASE
        WHEN e.state='verified' AND e.support_scope='track' AND e.verification_phase='track_verification' THEN 4
        WHEN e.state='corroborated' AND e.support_scope='track' AND e.verification_phase='track_verification' THEN 3
        WHEN e.state='editorial' THEN 2 ELSE 1 END),0)
      FROM evidence_claims e
      JOIN source_records es ON es.id=e.source_id AND es.source_class='web'
      JOIN citation_attestations ca ON ca.id=e.citation_attestation_id
        AND ca.run_id=e.run_id AND ca.source_url=es.url
      WHERE e.candidate_id=c.id) DESC,c.artist,c.title,c.id`;
  }
  if (normalized.includes("discover")) return "c.created_at,c.id";
  if (normalized.includes("chronolog") || normalized.includes("release") || normalized.includes("year")) {
    return "c.release_year NULLS LAST,c.artist,c.album NULLS LAST,c.title,c.id";
  }
  if (normalized.startsWith("title") || normalized.includes("title first")) return "c.title,c.artist,c.id";
  return "c.artist,c.title,c.release_year NULLS LAST,c.album NULLS LAST,c.id";
}

function fixedPlaylistOrder<T extends {
  candidate_id: string;
  artist: string;
  title: string;
  album: string | null;
  releaseYear: number | null;
}>(rows: readonly T[], orderingPolicy: string): T[] {
  const policy = orderingPolicy.toLocaleLowerCase();
  const ordered = [...rows];
  const text = (value: string | null) => (value ?? "").toLocaleLowerCase();
  const stable = (left: T, right: T) => left.candidate_id.localeCompare(right.candidate_id);
  if (policy.includes("chronolog") || policy.includes("release year") || policy.includes("release date")) {
    return ordered.sort((left, right) => (
      (left.releaseYear ?? Number.MAX_SAFE_INTEGER) - (right.releaseYear ?? Number.MAX_SAFE_INTEGER)
      || text(left.artist).localeCompare(text(right.artist))
      || text(left.album).localeCompare(text(right.album))
      || text(left.title).localeCompare(text(right.title))
      || stable(left, right)
    ));
  }
  if (policy.includes("alphabet") || policy.includes("by title") || policy.includes("title order")) {
    return ordered.sort((left, right) => (
      text(left.title).localeCompare(text(right.title))
      || text(left.artist).localeCompare(text(right.artist))
      || stable(left, right)
    ));
  }
  // Rank, evidence, source, and explicitly preserved orders already arrived in
  // the deterministic membership order used to choose the top N.
  return ordered;
}

/**
 * Revision metadata (continuation/corpus-review lineage) is intentionally not
 * part of this comparison. Everything that changes candidate eligibility,
 * ranking, count, or ordering is. Optional selection-policy fields use the
 * canonical plan only as a compatibility default for query revisions written
 * before those fields were persisted.
 */
function normalizedQueryPlanV3Invariant(
  queryPlan: QueryPlanV3,
  compatibilityFallback?: QueryPlanV3,
): unknown {
  return {
    schemaVersion: queryPlan.schemaVersion,
    pipelineVersion: queryPlan.pipelineVersion,
    policyVersion: queryPlan.policyVersion,
    engine: queryPlan.engine,
    engines: [...queryPlan.engines],
    membershipPredicates: queryPlan.membershipPredicates.map((predicate) => ({ ...predicate })),
    rankingObjectives: queryPlan.rankingObjectives.map((objective) => ({
      ...objective,
      values: [...(objective.values ?? [])],
    })),
    targetTrackCount: queryPlan.targetTrackCount,
    storefront: queryPlan.storefront,
    hardConstraints: queryPlan.hardConstraints.map((constraint) => ({
      ...constraint,
      values: [...constraint.values],
      geographyRelationship: constraint.geographyRelationship ?? null,
    })),
    softPreferences: queryPlan.softPreferences.map((constraint) => ({
      ...constraint,
      values: [...constraint.values],
      geographyRelationship: constraint.geographyRelationship ?? null,
    })),
    sourceDiscoveryHints: queryPlan.sourceDiscoveryHints.map((hint) => ({ ...hint })),
    scopeKind: queryPlan.scopeKind ?? compatibilityFallback?.scopeKind ?? null,
    diversityGoals: queryPlan.diversityGoals ?? compatibilityFallback?.diversityGoals ?? null,
    orderingPolicy: queryPlan.orderingPolicy ?? compatibilityFallback?.orderingPolicy ?? null,
    softGoalRelaxationOrder: [
      ...(queryPlan.softGoalRelaxationOrder
        ?? compatibilityFallback?.softGoalRelaxationOrder
        ?? []),
    ],
    semanticPolicyVersion: queryPlan.semanticPolicyVersion
      ?? compatibilityFallback?.semanticPolicyVersion
      ?? null,
    semanticClauses: (queryPlan.semanticClauses
      ?? compatibilityFallback?.semanticClauses
      ?? []).map((clause) => ({ ...clause, values: [...clause.values] })),
    contextSignals: (queryPlan.contextSignals
      ?? compatibilityFallback?.contextSignals
      ?? []).map((clause) => ({ ...clause, values: [...clause.values] })),
    catalogPolicies: (queryPlan.catalogPolicies
      ?? compatibilityFallback?.catalogPolicies
      ?? []).map((clause) => ({ ...clause, values: [...clause.values] })),
    recordingPolicy: queryPlan.recordingPolicy
      ? { ...queryPlan.recordingPolicy, allowedVersions: [...queryPlan.recordingPolicy.allowedVersions] }
      : compatibilityFallback?.recordingPolicy
        ? {
          ...compatibilityFallback.recordingPolicy,
          allowedVersions: [...compatibilityFallback.recordingPolicy.allowedVersions],
        }
        : null,
    explicitUserConstraintHash: queryPlan.explicitUserConstraintHash
      ?? compatibilityFallback?.explicitUserConstraintHash
      ?? null,
    hardConstraintHash: queryPlan.hardConstraintHash
      ?? compatibilityFallback?.hardConstraintHash
      ?? null,
    semanticAuditMetadata: queryPlan.semanticAuditMetadata
      ? { ...queryPlan.semanticAuditMetadata }
      : compatibilityFallback?.semanticAuditMetadata
        ? { ...compatibilityFallback.semanticAuditMetadata }
        : null,
    briefContractVersion: queryPlan.briefContractVersion ?? null,
    guidancePolicyVersion: queryPlan.guidancePolicyVersion ?? null,
    evidencePolicyVersion: queryPlan.evidencePolicyVersion ?? null,
    executionDeltaHash: queryPlan.executionDeltaHash ?? null,
    playlistContractRevisionId: queryPlan.playlistContractRevisionId ?? null,
    playlistContractSemanticHash: queryPlan.playlistContractSemanticHash ?? null,
    playlistContractCompilerVersion: queryPlan.playlistContractCompilerVersion ?? null,
    playlistQuotaRules: (queryPlan.playlistQuotaRules
      ?? compatibilityFallback?.playlistQuotaRules
      ?? []).map((rule) => ({ ...rule, values: [...rule.values] })),
    playlistQualityPolicy: queryPlan.playlistQualityPolicy
      ? {
        ...queryPlan.playlistQualityPolicy,
        clauseIds: [...queryPlan.playlistQualityPolicy.clauseIds],
        criteria: [...queryPlan.playlistQualityPolicy.criteria],
      }
      : compatibilityFallback?.playlistQualityPolicy
        ? {
          ...compatibilityFallback.playlistQualityPolicy,
          clauseIds: [...compatibilityFallback.playlistQualityPolicy.clauseIds],
          criteria: [...compatibilityFallback.playlistQualityPolicy.criteria],
        }
        : null,
  };
}

function queryPlanV3ExecutionProjection(
  plan: SelectionPlanV3,
  template: QueryPlanV3,
): QueryPlanV3 {
  return {
    ...template,
    engine: plan.engines[0] ?? template.engine,
    engines: [...plan.engines],
    membershipPredicates: plan.membershipPredicates.map((predicate) => ({
      id: predicate.id,
      kind: predicate.axis,
      subject: predicate.values.join(" | "),
      relationship: predicate.operator,
      hard: true,
    })),
    rankingObjectives: plan.rankingObjectives
      .filter((objective) => objective.id !== "ranking:relevance:persisted_default")
      .map((objective) => ({
        id: objective.id,
        kind: objective.dimension,
        description: objective.reason,
        weight: objective.weight,
        values: [...objective.values],
      })),
    targetTrackCount: plan.requestedTrackCount,
    storefront: plan.storefront,
    hardConstraints: plan.hardConstraints.map((constraint) => ({
      ...constraint,
      values: [...constraint.values],
      geographyRelationship: constraint.geographyRelationship ?? null,
    })),
    softPreferences: plan.softPreferences.map((constraint) => ({
      ...constraint,
      values: [...constraint.values],
      geographyRelationship: constraint.geographyRelationship ?? null,
    })),
    sourceDiscoveryHints: plan.sourceDiscoveryHints.map((hint) => ({ ...hint })),
    scopeKind: plan.scopeKind,
    diversityGoals: { ...plan.diversityGoals },
    orderingPolicy: { ...plan.orderingPolicy, goals: [...plan.orderingPolicy.goals] },
    softGoalRelaxationOrder: [...plan.softGoalRelaxationOrder],
    // Schema-1 plans are immutable historical contracts. Never project the
    // newer semantic shape onto them while they drain: doing so changes the
    // normalized execution invariant even though their stored hash is valid.
    ...(template.schemaVersion >= 2 ? {
      semanticPolicyVersion: plan.semanticPolicyVersion,
      semanticClauses: plan.semanticClauses.map((clause) => ({
        ...clause,
        values: [...clause.values],
        geographyRelationship: clause.geographyRelationship ?? null,
      })),
      contextSignals: plan.contextSignals.map((clause) => ({
        ...clause,
        values: [...clause.values],
        geographyRelationship: clause.geographyRelationship ?? null,
      })),
      catalogPolicies: plan.catalogPolicies.map((clause) => ({
        ...clause,
        values: [...clause.values],
        geographyRelationship: clause.geographyRelationship ?? null,
      })),
      recordingPolicy: {
        ...plan.recordingPolicy,
        allowedVersions: [...plan.recordingPolicy.allowedVersions],
      },
      explicitUserConstraintHash: plan.explicitUserConstraintHash,
      hardConstraintHash: plan.semanticAudit?.hardConstraintHash ?? template.hardConstraintHash,
      semanticAuditMetadata: template.semanticAuditMetadata == null
        ? undefined
        : {
          ...template.semanticAuditMetadata,
          semanticPolicyVersion: plan.semanticPolicyVersion,
          explicitUserConstraintHash: plan.explicitUserConstraintHash,
          hardConstraintHash: plan.semanticAudit?.hardConstraintHash
            ?? template.semanticAuditMetadata.hardConstraintHash,
          clauseCount: plan.semanticClauses.length,
          membershipClauseCount: plan.semanticClauses.filter(({ role }) => role === "membership").length,
          contextClauseCount: plan.contextSignals.length,
          catalogPolicyClauseCount: plan.catalogPolicies.length,
          aliasCollapses: [...(plan.semanticAudit?.aliasCollapses ?? [])],
          contradictions: [...(plan.semanticAudit?.contradictions ?? [])],
        },
      ...(template.schemaVersion === 4 ? {
        playlistQuotaRules: (plan.playlistQuotaRules ?? []).map((rule) => ({
          ...rule,
          values: [...rule.values],
        })),
        ...(plan.playlistQualityPolicy ? {
          playlistQualityPolicy: {
            ...plan.playlistQualityPolicy,
            clauseIds: [...plan.playlistQualityPolicy.clauseIds],
            criteria: [...plan.playlistQualityPolicy.criteria],
          },
        } : {}),
      } : {}),
    } : {}),
  };
}

export class Repository {
  readonly pool: Pool;
  readonly db: DatabaseHandle["db"];

  constructor(handle: DatabaseHandle = createDatabase()) {
    this.pool = handle.pool;
    this.db = handle.db;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Estimate the lower-decile evidence-qualified → storefront-playable
   * conversion from recent runs in the same immutable routing segment.
   * Missing telemetry is not a request failure: the policy compiler freezes
   * its conservative 0.5 fallback and records a zero sample count.
   */
  private async pipelineV3ConversionObservation(
    storefront: string,
    targetTrackCount: number,
  ): Promise<PipelineV3ConversionObservation | null> {
    if (Number(await this.getSchemaVersion() ?? 0) < 14) return null;
    const sizeTier = pipelineV3SizeTier(targetTrackCount);
    const [minimumTarget, maximumTarget] = sizeTier === "1_50"
      ? [1, 50]
      : sizeTier === "51_100"
        ? [51, 100]
        : sizeTier === "101_300"
          ? [101, 300]
          : [301, EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS];
    try {
      const result = await this.pool.query<{
        sample_count: number;
        p10_conversion_rate: number | null;
      }>(
        `SELECT count(*)::int sample_count,
                percentile_cont(0.1) WITHIN GROUP (ORDER BY sample.conversion_rate)
                  AS p10_conversion_rate
         FROM (
           SELECT LEAST(
                    1::numeric,
                    GREATEST(
                      0::numeric,
                      (outcome.outcome_json #>> '{stages,storefrontPlayable}')::numeric
                        / NULLIF(
                            (outcome.outcome_json #>> '{stages,evidenceEligible}')::numeric,
                            0
                          )
                    )
                  ) conversion_rate
           FROM pipeline_outcomes outcome
           JOIN research_runs run ON run.id=outcome.run_id
           WHERE outcome.pipeline_version='corpus_first_v3'
             AND run.pipeline_version='corpus_first_v3'
             AND lower(COALESCE(
                   run.pipeline_policy_snapshot_json->>'storefront',
                   run.selection_plan_json->>'storefront',
                   ''
                 ))=$1
             AND outcome.target_track_count BETWEEN $2 AND $3
             AND outcome.completed_at >= now()-interval '180 days'
             AND outcome.provider_unavailable=false
             AND (outcome.outcome_json #>> '{stages,evidenceEligible}') ~ '^[0-9]+$'
             AND (outcome.outcome_json #>> '{stages,storefrontPlayable}') ~ '^[0-9]+$'
             AND (outcome.outcome_json #>> '{stages,evidenceEligible}')::numeric > 0
           ORDER BY outcome.completed_at DESC
           LIMIT 500
         ) sample`,
        [storefront.trim().toLowerCase(), minimumTarget, maximumTarget],
      );
      const row = result.rows[0];
      const rate = Number(row?.p10_conversion_rate);
      const sampleCount = Math.max(0, Number(row?.sample_count ?? 0));
      return Number.isFinite(rate) && sampleCount > 0
        ? {
            p10QualifiedToAppleSafeConversionRate: rate,
            sampleCount,
          }
        : null;
    } catch {
      return null;
    }
  }

  async getActivePlaylistContractRevision(input: {
    briefRequestId?: string | null;
    runId?: string | null;
  }): Promise<PersistedPlaylistContractRevision | null> {
    if (Number(await this.getSchemaVersion() ?? 0) < 17) return null;
    const ownerCount = Number(Boolean(input.briefRequestId)) + Number(Boolean(input.runId));
    if (ownerCount !== 1) throw new HttpError(400, "Playlist contract owner is invalid", "invalid_contract_owner");
    const ownerTable = input.briefRequestId ? "brief_requests" : "research_runs";
    const ownerId = input.briefRequestId ?? input.runId!;
    const result = await this.pool.query<{
      id: string;
      revision: number;
      parent_revision_id: string | null;
      contract_hash: string;
      contract_json: Record<string, unknown>;
      compiler_version: string;
      ontology_version: string;
      evidence_policy_version: string;
      question_template_version: string;
      catalog_policy_version: string;
      locale: string;
      storefront: string;
      answer_lineage_hash: string;
      created_at: Date;
    }>(
      `SELECT contract.id,contract.revision,contract.parent_revision_id,
              contract.contract_hash,contract.contract_json,
              contract.compiler_version,contract.ontology_version,
              contract.evidence_policy_version,contract.question_template_version,
              contract.catalog_policy_version,contract.locale,contract.storefront,
              contract.answer_lineage_hash,contract.created_at
       FROM ${ownerTable} owner
       JOIN playlist_contract_revisions contract
         ON contract.id=owner.active_playlist_contract_revision_id
       WHERE owner.id=$1 AND contract.status='active'`,
      [ownerId],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      revision: Number(row.revision),
      parentRevisionId: row.parent_revision_id,
      contractHash: row.contract_hash,
      contract: row.contract_json,
      compilerVersion: row.compiler_version,
      ontologyVersion: row.ontology_version,
      evidencePolicyVersion: row.evidence_policy_version,
      questionTemplateVersion: row.question_template_version,
      catalogPolicyVersion: row.catalog_policy_version,
      locale: row.locale,
      storefront: row.storefront,
      answerLineageHash: row.answer_lineage_hash,
      createdAt: row.created_at.toISOString(),
    } : null;
  }

  async savePlaylistContractRevision(
    input: SavePlaylistContractRevisionInput,
  ): Promise<PersistedPlaylistContractRevision & { created: boolean }> {
    if (Number(await this.getSchemaVersion() ?? 0) < 17) {
      throw new HttpError(503, "Playlist contract storage is not ready", "playlist_contract_schema_unavailable");
    }
    const ownerCount = Number(Boolean(input.briefRequestId)) + Number(Boolean(input.runId));
    if (ownerCount !== 1) throw new HttpError(400, "Playlist contract owner is invalid", "invalid_contract_owner");
    if (!/^[a-f0-9]{64}$/u.test(input.contractHash)
      || !/^[a-f0-9]{64}$/u.test(input.answerLineageHash)) {
      throw new HttpError(400, "Playlist contract hashes are invalid", "invalid_contract_hash");
    }
    if (!input.contract || Array.isArray(input.contract)) {
      throw new HttpError(400, "Playlist contract is invalid", "invalid_playlist_contract");
    }
    const briefRequestId = input.briefRequestId ?? null;
    const runId = input.runId ?? null;
    return this.transaction(async (client) => {
      const lockKey = `playlist-contract:${briefRequestId ? `brief:${briefRequestId}` : `run:${runId}`}`;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
      const owner = briefRequestId
        ? await client.query<{ active_playlist_contract_revision_id: string | null }>(
            `SELECT active_playlist_contract_revision_id
             FROM brief_requests WHERE id=$1 AND expires_at>now() FOR UPDATE`,
            [briefRequestId],
          )
        : await client.query<{ active_playlist_contract_revision_id: string | null }>(
            `SELECT active_playlist_contract_revision_id
             FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
            [runId],
          );
      if (!owner.rows[0]) throw new HttpError(404, "Playlist contract owner was not found", "contract_owner_not_found");
      const activeRevisionId = owner.rows[0].active_playlist_contract_revision_id;
      if ((input.expectedParentRevisionId ?? null) !== activeRevisionId) {
        throw new HttpError(409, "Playlist interpretation changed; review the current revision", "stale_playlist_contract");
      }
      const duplicate = await client.query<{
        id: string;
        revision: number;
        parent_revision_id: string | null;
        contract_hash: string;
        contract_json: Record<string, unknown>;
        compiler_version: string;
        ontology_version: string;
        evidence_policy_version: string;
        question_template_version: string;
        catalog_policy_version: string;
        locale: string;
        storefront: string;
        answer_lineage_hash: string;
        created_at: Date;
        status: string;
      }>(
        `SELECT id,revision,parent_revision_id,contract_hash,contract_json,
                compiler_version,ontology_version,evidence_policy_version,
                question_template_version,catalog_policy_version,locale,storefront,
                answer_lineage_hash,created_at,status
         FROM playlist_contract_revisions
         WHERE ${briefRequestId ? "brief_request_id=$1" : "run_id=$1"} AND contract_hash=$2
         LIMIT 1`,
        [briefRequestId ?? runId, input.contractHash],
      );
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].id !== activeRevisionId || duplicate.rows[0].status !== "active") {
          throw new HttpError(
            409,
            "A superseded semantic contract cannot be reactivated; create a successor revision",
            "superseded_contract_hash",
          );
        }
        const row = duplicate.rows[0];
        return {
          id: row.id,
          revision: Number(row.revision),
          parentRevisionId: row.parent_revision_id,
          contractHash: row.contract_hash,
          contract: row.contract_json,
          compilerVersion: row.compiler_version,
          ontologyVersion: row.ontology_version,
          evidencePolicyVersion: row.evidence_policy_version,
          questionTemplateVersion: row.question_template_version,
          catalogPolicyVersion: row.catalog_policy_version,
          locale: row.locale,
          storefront: row.storefront,
          answerLineageHash: row.answer_lineage_hash,
          createdAt: row.created_at.toISOString(),
          created: false,
        };
      }
      const next = await client.query<{ revision: number }>(
        `SELECT COALESCE(max(revision),0)+1 revision
         FROM playlist_contract_revisions
         WHERE ${briefRequestId ? "brief_request_id=$1" : "run_id=$1"}`,
        [briefRequestId ?? runId],
      );
      const id = randomUUID();
      const revision = Number(next.rows[0]?.revision ?? 1);
      const inserted = await client.query<{ created_at: Date }>(
        `INSERT INTO playlist_contract_revisions(
           id,brief_request_id,run_id,revision,parent_revision_id,status,
           contract_hash,contract_json,compiler_version,ontology_version,
           evidence_policy_version,question_template_version,catalog_policy_version,
           locale,storefront,answer_lineage_hash)
         VALUES($1,$2,$3,$4,$5,'active',$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING created_at`,
        [
          id,
          briefRequestId,
          runId,
          revision,
          activeRevisionId,
          input.contractHash,
          JSON.stringify(input.contract),
          input.compilerVersion,
          input.ontologyVersion,
          input.evidencePolicyVersion,
          input.questionTemplateVersion,
          input.catalogPolicyVersion,
          input.locale,
          input.storefront,
          input.answerLineageHash,
        ],
      );
      if (activeRevisionId) {
        await client.query(
          "UPDATE playlist_contract_revisions SET status='superseded' WHERE id=$1 AND status='active'",
          [activeRevisionId],
        );
        await client.query(
          `UPDATE playlist_feasibility_snapshots
           SET invalidated_at=now()
           WHERE contract_revision_id=$1 AND invalidated_at IS NULL`,
          [activeRevisionId],
        );
      }
      if (briefRequestId) {
        await client.query(
          "UPDATE brief_requests SET active_playlist_contract_revision_id=$2,updated_at=now() WHERE id=$1",
          [briefRequestId, id],
        );
      } else {
        await client.query(
          "UPDATE research_runs SET active_playlist_contract_revision_id=$2,updated_at=now() WHERE id=$1",
          [runId, id],
        );
      }
      if (input.guidanceAnswerSetId) {
        const bound = await client.query(
          `UPDATE guidance_answer_sets SET resulting_contract_revision_id=$2
           WHERE id=$1 AND resulting_contract_revision_id IS NULL AND invalidated_at IS NULL`,
          [input.guidanceAnswerSetId, id],
        );
        if ((bound.rowCount ?? 0) !== 1) {
          throw new HttpError(409, "Guidance answer binding is stale", "stale_guidance_answer_binding");
        }
      }
      return {
        id,
        revision,
        parentRevisionId: activeRevisionId,
        contractHash: input.contractHash,
        contract: input.contract,
        compilerVersion: input.compilerVersion,
        ontologyVersion: input.ontologyVersion,
        evidencePolicyVersion: input.evidencePolicyVersion,
        questionTemplateVersion: input.questionTemplateVersion,
        catalogPolicyVersion: input.catalogPolicyVersion,
        locale: input.locale,
        storefront: input.storefront,
        answerLineageHash: input.answerLineageHash,
        createdAt: inserted.rows[0]!.created_at.toISOString(),
        created: true,
      };
    });
  }

  async attachPlaylistContractToRun(input: {
    runId: string;
    contractRevisionId: string;
  }): Promise<void> {
    if (Number(await this.getSchemaVersion() ?? 0) < 17) return;
    const updated = await this.pool.query(
      `UPDATE research_runs run
       SET active_playlist_contract_revision_id=contract.id,updated_at=now()
       FROM playlist_contract_revisions contract
       WHERE run.id=$1 AND contract.id=$2
         AND contract.status='active'
         AND (
           contract.run_id=run.id
           OR (
             contract.brief_request_id IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM run_accesses access
               WHERE access.run_id=run.id
                 AND access.brief_request_id=contract.brief_request_id
             )
           )
         )`,
      [input.runId, input.contractRevisionId],
    );
    if ((updated.rowCount ?? 0) !== 1) {
      throw new HttpError(409, "Playlist contract cannot be attached to this run", "contract_run_mismatch");
    }
  }

  async savePlaylistFeasibilitySnapshot(
    input: SavePlaylistFeasibilitySnapshotInput,
  ): Promise<{ id: string; created: boolean }> {
    if (Number(await this.getSchemaVersion() ?? 0) < 17) {
      throw new HttpError(503, "Playlist feasibility storage is not ready", "playlist_contract_schema_unavailable");
    }
    if (!/^[a-f0-9]{64}$/u.test(input.reportHash)) {
      throw new HttpError(400, "Playlist feasibility hash is invalid", "invalid_feasibility_hash");
    }
    const id = randomUUID();
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO playlist_feasibility_snapshots(
         id,contract_revision_id,phase,assessment,target_count,
         observed_qualified_count,projected_lower_count,projected_upper_count,
         confidence,report_hash,report_json)
       SELECT $1,contract.id,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb
       FROM playlist_contract_revisions contract
       WHERE contract.id=$2 AND contract.status='active'
         AND (
           EXISTS (
             SELECT 1 FROM brief_requests brief
             WHERE brief.active_playlist_contract_revision_id=contract.id
           )
           OR EXISTS (
             SELECT 1 FROM research_runs run
             WHERE run.active_playlist_contract_revision_id=contract.id
           )
         )
       ON CONFLICT(contract_revision_id,report_hash) DO NOTHING
       RETURNING id`,
      [
        id,
        input.contractRevisionId,
        input.phase,
        input.assessment,
        input.targetCount,
        input.observedQualifiedCount,
        input.projectedLowerCount,
        input.projectedUpperCount,
        input.confidence,
        input.reportHash,
        JSON.stringify(input.report),
      ],
    );
    if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id FROM playlist_feasibility_snapshots
       WHERE contract_revision_id=$1 AND report_hash=$2`,
      [input.contractRevisionId, input.reportHash],
    );
    if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
    throw new HttpError(409, "Playlist feasibility revision is stale", "stale_playlist_contract");
  }

  async getPlaylistActiveComputeAllowanceMs(input: {
    runId: string;
    contractRevisionId: string;
  }): Promise<number> {
    if (Number(await this.getSchemaVersion() ?? 0) < 17) {
      return ACTIVE_COMPUTE_EXTENSION_MS_V1;
    }
    const result = await this.pool.query<{ state_json: Record<string, unknown> | null }>(
      `SELECT checkpoint.state_json
       FROM research_runs run
       LEFT JOIN research_checkpoints checkpoint
         ON checkpoint.run_id=run.id AND checkpoint.phase='active_compute_extension'
       WHERE run.id=$1 AND run.active_playlist_contract_revision_id=$2
         AND run.deleted_at IS NULL`,
      [input.runId, input.contractRevisionId],
    );
    const state = result.rows[0]?.state_json;
    if (!state || state.contractRevisionId !== input.contractRevisionId) {
      return ACTIVE_COMPUTE_EXTENSION_MS_V1;
    }
    const extensions = Number(state.extensions);
    const validExtensions = Number.isSafeInteger(extensions)
      ? Math.max(0, Math.min(MAX_ACTIVE_COMPUTE_EXTENSIONS_V1, extensions))
      : 0;
    return ACTIVE_COMPUTE_EXTENSION_MS_V1 * (1 + validExtensions);
  }

  async beginPlaylistExecutionAttempt(
    input: BeginPlaylistExecutionAttemptInput,
  ): Promise<{ id: string; created: boolean; activeComputeMs: number }> {
    if (Number(await this.getSchemaVersion() ?? 0) < 17) {
      throw new HttpError(503, "Playlist execution fencing is not ready", "playlist_contract_schema_unavailable");
    }
    if (!/^[a-f0-9]{64}$/u.test(input.configurationHash)) {
      throw new HttpError(400, "Execution configuration hash is invalid", "invalid_configuration_hash");
    }
    if (!/^[a-f0-9]{64}$/u.test(input.executorIdentityHash)) {
      throw new HttpError(400, "Executor identity hash is invalid", "invalid_executor_identity_hash");
    }
    const id = randomUUID();
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO playlist_execution_attempts(
         id,run_id,contract_revision_id,stage,dependency_key,attempt_number,
         lease_generation,executor_revision,executor_identity_hash,configuration_hash,
         idempotency_key,checkpoint_cursor,status)
       SELECT $1,run.id,contract.id,$4,$5,$6,$7,$8,$9,$10,$11,$12,'running'
       FROM research_runs run
       JOIN playlist_contract_revisions contract
         ON contract.id=run.active_playlist_contract_revision_id
       WHERE run.id=$2 AND contract.id=$3 AND run.deleted_at IS NULL
       ON CONFLICT(idempotency_key) DO NOTHING
       RETURNING id`,
      [
        id,
        input.runId,
        input.contractRevisionId,
        input.stage,
        input.dependencyKey ?? null,
        input.attemptNumber,
        input.leaseGeneration,
        input.executorRevision,
        input.executorIdentityHash,
        input.configurationHash,
        input.idempotencyKey,
        input.checkpointCursor ?? null,
      ],
    );
    const activeComputeMs = async (): Promise<number> => {
      const usage = await this.pool.query<{ active_compute_ms: number }>(
        `SELECT COALESCE(sum(
           EXTRACT(EPOCH FROM (COALESCE(completed_at,now())-started_at))*1000
         ),0)::float8 active_compute_ms
         FROM playlist_execution_attempts
         WHERE run_id=$1 AND contract_revision_id=$2`,
        [input.runId, input.contractRevisionId],
      );
      return Math.max(0, Number(usage.rows[0]?.active_compute_ms ?? 0));
    };
    if (inserted.rows[0]) {
      return {
        id: inserted.rows[0].id,
        created: true,
        activeComputeMs: await activeComputeMs(),
      };
    }
    const existing = await this.pool.query<{
      id: string;
      run_id: string;
      contract_revision_id: string;
      stage: string;
      lease_generation: number;
      executor_identity_hash: string;
      configuration_hash: string;
    }>(
      `SELECT id,run_id,contract_revision_id,stage,lease_generation,
              executor_identity_hash,configuration_hash
       FROM playlist_execution_attempts WHERE idempotency_key=$1`,
      [input.idempotencyKey],
    );
    const row = existing.rows[0];
    if (!row) throw new HttpError(409, "Execution contract revision is stale", "stale_playlist_contract");
    if (row.run_id !== input.runId
      || row.contract_revision_id !== input.contractRevisionId
      || row.stage !== input.stage
      || Number(row.lease_generation) !== input.leaseGeneration
      || row.executor_identity_hash !== input.executorIdentityHash
      || row.configuration_hash !== input.configurationHash) {
      throw new HttpError(409, "Execution idempotency key was reused", "execution_idempotency_conflict");
    }
    return {
      id: row.id,
      created: false,
      activeComputeMs: await activeComputeMs(),
    };
  }

  async completePlaylistExecutionAttempt(input: {
    attemptId: string;
    runId: string;
    contractRevisionId: string;
    leaseGeneration: number;
    status: "blocked" | "complete" | "cancelled" | "failed";
    blockerKind?: string | null;
    checkpointCursor?: string | null;
  }): Promise<{ accepted: boolean; discarded: boolean }> {
    if (Number(await this.getSchemaVersion() ?? 0) < 17) return { accepted: true, discarded: false };
    const result = await this.pool.query(
      `UPDATE playlist_execution_attempts attempt
       SET status=$5,blocker_kind=$6,checkpoint_cursor=COALESCE($7,checkpoint_cursor),
           completed_at=now()
       FROM research_runs run
       WHERE attempt.id=$1 AND attempt.run_id=$2 AND attempt.contract_revision_id=$3
         AND attempt.lease_generation=$4 AND attempt.status='running'
         AND run.id=attempt.run_id
         AND run.active_playlist_contract_revision_id=attempt.contract_revision_id`,
      [
        input.attemptId,
        input.runId,
        input.contractRevisionId,
        input.leaseGeneration,
        input.status,
        input.blockerKind ?? null,
        input.checkpointCursor ?? null,
      ],
    );
    if ((result.rowCount ?? 0) === 1) return { accepted: true, discarded: false };
    const discarded = await this.pool.query(
      `UPDATE playlist_execution_attempts
       SET status='discarded',completed_at=now()
       WHERE id=$1 AND run_id=$2 AND contract_revision_id=$3
         AND lease_generation=$4 AND status='running'`,
      [input.attemptId, input.runId, input.contractRevisionId, input.leaseGeneration],
    );
    return { accepted: false, discarded: (discarded.rowCount ?? 0) === 1 };
  }

  async discardPlaylistExecutionAttempt(input: {
    attemptId: string;
    runId: string;
    contractRevisionId: string;
    leaseGeneration: number;
  }): Promise<boolean> {
    if (Number(await this.getSchemaVersion() ?? 0) < 17) return true;
    const result = await this.pool.query(
      `UPDATE playlist_execution_attempts
       SET status='discarded',completed_at=now()
       WHERE id=$1 AND run_id=$2 AND contract_revision_id=$3
         AND lease_generation=$4 AND status='running'`,
      [input.attemptId, input.runId, input.contractRevisionId, input.leaseGeneration],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async getActivePlaylistRunBlocker(input: {
    runId: string;
    contractRevisionId: string;
    blockerKind: "provider";
    dependencyKey: string;
  }): Promise<{
    id: string;
    retryCount: number;
    nextRetryAt: Date | null;
    automaticRetryUntil: Date | null;
    createdAt: Date;
    state: Record<string, unknown>;
  } | null> {
    if (Number(await this.getSchemaVersion() ?? 0) < 17) return null;
    const result = await this.pool.query<{
      id: string;
      retry_count: number;
      next_retry_at: Date | null;
      automatic_retry_until: Date | null;
      created_at: Date;
      state_json: Record<string, unknown>;
    }>(
      `SELECT blocker.id,blocker.retry_count,blocker.next_retry_at,
              blocker.automatic_retry_until,blocker.created_at,blocker.state_json
       FROM playlist_run_blockers blocker
       JOIN research_runs run
         ON run.id=blocker.run_id
        AND run.active_playlist_contract_revision_id=blocker.contract_revision_id
       WHERE blocker.run_id=$1 AND blocker.contract_revision_id=$2
         AND blocker.blocker_kind=$3
         AND blocker.dependency_key IS NOT DISTINCT FROM $4::varchar
         AND blocker.resolved_at IS NULL AND run.deleted_at IS NULL
       ORDER BY blocker.created_at,id
       LIMIT 1`,
      [input.runId, input.contractRevisionId, input.blockerKind, input.dependencyKey],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      retryCount: Number(row.retry_count),
      nextRetryAt: row.next_retry_at,
      automaticRetryUntil: row.automatic_retry_until,
      createdAt: row.created_at,
      state: row.state_json ?? {},
    } : null;
  }

  async openPlaylistRunBlocker(
    input: OpenPlaylistRunBlockerInput,
  ): Promise<string> {
    if (Number(await this.getSchemaVersion() ?? 0) < 17) {
      throw new HttpError(503, "Playlist blocker storage is not ready", "playlist_contract_schema_unavailable");
    }
    return this.transaction(async (client) => {
      const active = await client.query<{ id: string }>(
        `SELECT run.id
         FROM research_runs run
         WHERE run.id=$1 AND run.active_playlist_contract_revision_id=$2
           AND run.deleted_at IS NULL
         FOR UPDATE`,
        [input.runId, input.contractRevisionId],
      );
      if (!active.rows[0]) {
        throw new HttpError(409, "Playlist blocker revision is stale", "stale_playlist_contract");
      }
      const existing = await client.query<{ id: string }>(
        `SELECT id
         FROM playlist_run_blockers
         WHERE run_id=$1 AND contract_revision_id=$2 AND blocker_kind=$3
           AND dependency_key IS NOT DISTINCT FROM $4::varchar
           AND resolved_at IS NULL
         ORDER BY created_at,id
         LIMIT 1
         FOR UPDATE`,
        [
          input.runId,
          input.contractRevisionId,
          input.blockerKind,
          input.dependencyKey ?? null,
        ],
      );
      if (existing.rows[0]) {
        const updated = await client.query<{ id: string }>(
          `UPDATE playlist_run_blockers
           SET retry_count=GREATEST(retry_count,$2),
               next_retry_at=$3,
               automatic_retry_until=CASE
                 WHEN automatic_retry_until IS NULL THEN $4
                 WHEN $4::timestamptz IS NULL THEN automatic_retry_until
                 ELSE LEAST(automatic_retry_until,$4)
               END,
               state_json=state_json || $5::jsonb,
               updated_at=now()
           WHERE id=$1
           RETURNING id`,
          [
            existing.rows[0].id,
            input.retryCount ?? 0,
            input.nextRetryAt ?? null,
            input.automaticRetryUntil ?? null,
            JSON.stringify(input.state ?? {}),
          ],
        );
        return updated.rows[0]!.id;
      }
      const id = randomUUID();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO playlist_run_blockers(
           id,run_id,contract_revision_id,blocker_kind,dependency_key,retry_count,
           next_retry_at,automatic_retry_until,state_json)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         RETURNING id`,
        [
          id,
          input.runId,
          input.contractRevisionId,
          input.blockerKind,
          input.dependencyKey ?? null,
          input.retryCount ?? 0,
          input.nextRetryAt ?? null,
          input.automaticRetryUntil ?? null,
          JSON.stringify(input.state ?? {}),
        ],
      );
      return inserted.rows[0]!.id;
    });
  }

  async resolvePlaylistRunBlockers(input: {
    runId: string;
    contractRevisionId: string;
    blockerKind?: OpenPlaylistRunBlockerInput["blockerKind"];
  }): Promise<number> {
    if (Number(await this.getSchemaVersion() ?? 0) < 17) return 0;
    const result = await this.pool.query(
      `UPDATE playlist_run_blockers SET resolved_at=now(),updated_at=now()
       WHERE run_id=$1 AND contract_revision_id=$2 AND resolved_at IS NULL
         AND ($3::varchar IS NULL OR blocker_kind=$3)`,
      [input.runId, input.contractRevisionId, input.blockerKind ?? null],
    );
    return result.rowCount ?? 0;
  }

  private async assertPipelineV3WriteFence(
    client: PoolClient,
    runId: string,
    fence: PipelineV3WriteFence,
  ): Promise<void> {
    const current = await client.query<{ id: string }>(
      `SELECT id FROM job_queue
       WHERE id=$1 AND run_id=$2 AND lease_owner=$3 AND lease_epoch=$4
         AND query_plan_revision_id=$5 AND stage_key=$6
         AND status='leased' AND lease_expires_at>now()
       FOR UPDATE`,
      [
        fence.jobId,
        runId,
        fence.workerId,
        fence.leaseEpoch,
        fence.queryPlanRevisionId,
        fence.stageKey,
      ],
    );
    if (!current.rows[0]) {
      if (process.env.NODE_ENV === "test" && process.env.GENIO_SYSTEM_E2E === "1") {
        const observed = await client.query(
          `SELECT id,run_id,lease_owner,lease_epoch,query_plan_revision_id,stage_key,status,
                  lease_expires_at,now() AS observed_at
           FROM job_queue WHERE id=$1`,
          [fence.jobId],
        );
        throw new Error(`Pipeline V3 worker lease fence mismatch: ${JSON.stringify({
          expected: { runId, ...fence },
          observed: observed.rows[0] ?? null,
        })}`);
      }
      throw new HttpError(409, "Pipeline V3 worker lease was lost", "job_lease_lost");
    }
  }

  /**
   * Schema-18 discovery and qualification writes require both the leased job
   * and the schema-17 contract execution attempt. This is intentionally
   * stricter than the legacy checkpoint fence: a successor contract can never
   * inherit untrusted leads or qualification decisions from its predecessor.
   */
  private async assertPipelineV3RecoveryPersistenceFence(
    client: PoolClient,
    input: {
      runId: string;
      queryPlan: QueryPlanV3;
      fence: PipelineV3WriteFence;
    },
  ): Promise<{
    contractRevisionId: string;
    executionAttemptId: string;
  }> {
    await this.assertPipelineV3WriteFence(client, input.runId, input.fence);
    const fence = input.fence;
    if (input.queryPlan.schemaVersion < 4
      || !fence.contractAttemptId
      || !fence.contractRevisionDatabaseId
      || !fence.contractRevisionId
      || !fence.contractSemanticHash) {
      throw new HttpError(
        409,
        "Pipeline V3 recovery persistence is missing its canonical execution fence",
        "pipeline_v3_recovery_fence_missing",
      );
    }
    const authoritative = await client.query<{
      active_playlist_contract_revision_id: string;
      contract_hash: string;
      contract_json: PlaylistContractRevisionV1;
      query_plan_id: string;
      query_plan_hash: string;
      query_plan_json: QueryPlanV3;
      execution_attempt_id: string;
      attempt_contract_revision_id: string;
      attempt_stage: string;
      attempt_lease_generation: number;
      attempt_status: string;
    }>(
      `SELECT run.active_playlist_contract_revision_id,
              contract.contract_hash,contract.contract_json,
              query.id query_plan_id,query.plan_hash query_plan_hash,
              query.plan_json query_plan_json,
              attempt.id execution_attempt_id,
              attempt.contract_revision_id attempt_contract_revision_id,
              attempt.stage attempt_stage,
              attempt.lease_generation attempt_lease_generation,
              attempt.status attempt_status
       FROM research_runs run
       JOIN playlist_contract_revisions contract
         ON contract.id=run.active_playlist_contract_revision_id
        AND contract.status='active'
       JOIN run_active_query_plans active ON active.run_id=run.id
       JOIN query_plan_revisions query
         ON query.id=active.query_plan_revision_id AND query.status='active'
       JOIN playlist_execution_attempts attempt
         ON attempt.id=$3 AND attempt.run_id=run.id
       WHERE run.id=$1 AND contract.id=$2 AND run.deleted_at IS NULL
       FOR UPDATE OF run,contract,query,attempt`,
      [
        input.runId,
        fence.contractRevisionDatabaseId,
        fence.contractAttemptId,
      ],
    );
    const row = authoritative.rows[0];
    const queryHash = queryPlanV3Hash(input.queryPlan);
    if (!row
      || row.active_playlist_contract_revision_id
        !== fence.contractRevisionDatabaseId
      || row.contract_hash !== fence.contractSemanticHash
      || row.contract_json.revisionId !== fence.contractRevisionId
      || row.contract_json.semanticHash !== fence.contractSemanticHash
      || row.query_plan_id !== fence.queryPlanRevisionId
      || row.query_plan_hash !== queryHash
      || queryPlanV3Hash(row.query_plan_json) !== queryHash
      || row.query_plan_json.playlistContractRevisionId
        !== fence.contractRevisionId
      || row.query_plan_json.playlistContractSemanticHash
        !== fence.contractSemanticHash
      || row.execution_attempt_id !== fence.contractAttemptId
      || row.attempt_contract_revision_id
        !== fence.contractRevisionDatabaseId
      || row.attempt_stage !== fence.stageKey
      || Number(row.attempt_lease_generation) !== fence.leaseEpoch
      || row.attempt_status !== "running") {
      throw new HttpError(
        409,
        "Pipeline V3 recovery write belongs to a stale contract or execution attempt",
        "pipeline_v3_recovery_fence_stale",
      );
    }
    return {
      contractRevisionId: row.active_playlist_contract_revision_id,
      executionAttemptId: row.execution_attempt_id,
    };
  }

  async persistPipelineV3DiscoveryBatch(input: {
    runId: string;
    queryPlan: QueryPlanV3;
    request: DiscoveryRequestV3;
    batch: DiscoveryBatchV3;
    fence: PipelineV3WriteFence;
  }): Promise<void> {
    if (Number(await this.getSchemaVersion() ?? 0) < 18) {
      throw new HttpError(
        503,
        "Separated discovery persistence is unavailable",
        "pipeline_v3_recovery_schema_unavailable",
      );
    }
    if (input.request.runId !== input.runId
      || input.request.executionMode !== "active"
      || input.request.strategy.id.length < 1
      || input.request.strategy.id.length > 120
      || input.batch.candidates.length > input.request.requestedRawCandidateCount) {
      throw new HttpError(
        409,
        "Pipeline V3 discovery batch does not match its immutable request",
        "pipeline_v3_recovery_batch_invalid",
      );
    }
    boundedPipelineBatch(
      input.batch.candidates,
      Math.min(500, input.request.requestedRawCandidateCount),
      "Pipeline V3 discovery leads",
    );
    await this.transaction(async (client) => {
      const authority = await this.assertPipelineV3RecoveryPersistenceFence(
        client,
        input,
      );
      const dependencyKey = input.request.strategy.discoveryDependencyIds
        .join("+")
        .slice(0, 120) || "orchestration_local";
      const provider = input.request.strategy.discoveryDependencyIds[0]
        ?.slice(0, 80) || "orchestration_local";
      for (const candidate of input.batch.candidates) {
        if (!candidate.id?.trim()
          || !candidate.artist?.trim()
          || !candidate.title?.trim()
          || (candidate.album !== null && typeof candidate.album !== "string")
          || !Array.isArray(candidate.sourceObservationIds)) {
          throw new HttpError(
            409,
            "Pipeline V3 discovery lead is malformed",
            "pipeline_v3_recovery_batch_invalid",
          );
        }
        const identityHintHash = pipelineV3LeadIdentityHash(candidate);
        const leadId = deterministicUuid({
          kind: "playlist_discovery_lead",
          runId: input.runId,
          contractRevisionId: authority.contractRevisionId,
          provider,
          strategyId: input.request.strategy.id,
          identityHintHash,
        });
        const lead = {
          schemaVersion: "genio-playlist-discovery-lead/v1",
          untrusted: true,
          sourceCandidateId: candidate.id.slice(0, 240),
          artist: candidate.artist.trim().slice(0, 240),
          title: candidate.title.trim().slice(0, 240),
          album: candidate.album?.trim().slice(0, 240) || null,
          sourceObservationIds: [...new Set(candidate.sourceObservationIds)]
            .filter((value) => typeof value === "string")
            .map((value) => value.slice(0, 240))
            .slice(0, 64),
          strategyRound: input.request.strategyRound,
        };
        await client.query(
          `INSERT INTO playlist_discovery_leads(
             id,run_id,contract_revision_id,execution_attempt_id,provider,
             dependency_key,strategy_id,identity_hint_hash,lead_json,status,
             evidence_eligible)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'discovered',false)
           ON CONFLICT(
             run_id,contract_revision_id,provider,strategy_id,identity_hint_hash
           ) DO UPDATE SET
             execution_attempt_id=EXCLUDED.execution_attempt_id,
             lead_json=EXCLUDED.lead_json,
             updated_at=now()
           WHERE playlist_discovery_leads.evidence_eligible=false`,
          [
            leadId,
            input.runId,
            authority.contractRevisionId,
            authority.executionAttemptId,
            provider,
            dependencyKey,
            input.request.strategy.id,
            identityHintHash,
            JSON.stringify(lead),
          ],
        );
      }
    });
  }

  async persistPipelineV3QualificationBatch(input: {
    runId: string;
    queryPlan: QueryPlanV3;
    request: QualificationRequestV3;
    qualifications: readonly CandidateQualificationV3[];
    fence: PipelineV3WriteFence;
  }): Promise<void> {
    if (Number(await this.getSchemaVersion() ?? 0) < 18) {
      throw new HttpError(
        503,
        "Separated qualification persistence is unavailable",
        "pipeline_v3_recovery_schema_unavailable",
      );
    }
    if (input.request.runId !== input.runId
      || input.request.executionMode !== "active") {
      throw new HttpError(
        409,
        "Pipeline V3 qualification batch does not match its immutable request",
        "pipeline_v3_recovery_batch_invalid",
      );
    }
    boundedPipelineBatch(input.request.candidates, 500, "Pipeline V3 qualification candidates");
    boundedPipelineBatch(input.qualifications, 500, "Pipeline V3 qualification decisions");
    const candidateById = new Map(
      input.request.candidates.map((candidate) => [candidate.id, candidate]),
    );
    if (candidateById.size !== input.request.candidates.length
      || input.qualifications.some((value) => !candidateById.has(value.candidateId))
      || new Set(input.qualifications.map(({ candidateId }) => candidateId)).size
        !== input.qualifications.length) {
      throw new HttpError(
        409,
        "Pipeline V3 qualification contains an unknown or duplicate candidate",
        "pipeline_v3_recovery_batch_invalid",
      );
    }
    await this.transaction(async (client) => {
      const authority = await this.assertPipelineV3RecoveryPersistenceFence(
        client,
        input,
      );
      for (const qualification of input.qualifications) {
        const candidate = candidateById.get(qualification.candidateId)!;
        const identityHintHash = pipelineV3LeadIdentityHash(candidate);
        const lead = await client.query<{ id: string }>(
          `SELECT id FROM playlist_discovery_leads
           WHERE run_id=$1 AND contract_revision_id=$2
             AND identity_hint_hash=$3 AND evidence_eligible=false
           ORDER BY updated_at DESC,id DESC LIMIT 1 FOR UPDATE`,
          [input.runId, authority.contractRevisionId, identityHintHash],
        );
        if (!lead.rows[0]) {
          throw new HttpError(
            409,
            "Qualification cannot create evidence from an unrecorded lead",
            "pipeline_v3_qualification_lead_missing",
          );
        }
        const projection = pipelineV3QualificationProjection(
          candidate,
          qualification,
          input.queryPlan,
        );
        await client.query(
          `INSERT INTO playlist_qualification_records(
             id,run_id,contract_revision_id,discovery_lead_id,candidate_id,
             stable_identity_hash,storefront,predicate_results_json,
             evidence_record_ids_json,quality_result_json,catalog_result_json,
             decision,qualification_hash)
           VALUES($1,$2,$3,$4,NULL,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,
             $10::jsonb,$11,$12)
           ON CONFLICT(
             run_id,contract_revision_id,stable_identity_hash,qualification_hash
           ) DO NOTHING`,
          [
            deterministicUuid({
              kind: "playlist_qualification_record",
              runId: input.runId,
              contractRevisionId: authority.contractRevisionId,
              stableIdentityHash: projection.stableIdentityHash,
              qualificationHash: projection.qualificationHash,
            }),
            input.runId,
            authority.contractRevisionId,
            lead.rows[0].id,
            projection.stableIdentityHash,
            input.request.plan.storefront,
            JSON.stringify(projection.predicateResults),
            JSON.stringify(projection.evidenceRecordIds),
            JSON.stringify(projection.qualityResult),
            JSON.stringify(projection.catalogResult),
            projection.decision,
            projection.qualificationHash,
          ],
        );
        await client.query(
          `UPDATE playlist_discovery_leads
           SET status=$2,execution_attempt_id=$3,updated_at=now()
           WHERE id=$1 AND evidence_eligible=false`,
          [
            lead.rows[0].id,
            projection.decision === "qualified" ? "qualified" : "rejected",
            authority.executionAttemptId,
          ],
        );
      }
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async getSchemaVersion(): Promise<string | null> {
    try {
      const result = await this.pool.query<{ value: string }>("SELECT value FROM settings WHERE key = 'schema_version'");
      return result.rows[0]?.value ?? null;
    } catch {
      return null;
    }
  }

  async ensureSchemaVersion(support: DatabaseSchemaSupport = DATABASE_SCHEMA_SUPPORT): Promise<void> {
    const actual = await this.getSchemaVersion();
    if (!isDatabaseSchemaVersionCompatible(actual, support)) {
      throw new Error(
        `Database schema mismatch: supported ${support.minimum}-${support.maximum}, found ${actual ?? "uninitialized"}`,
      );
    }
  }

  async getSetting(key: string): Promise<string | null> {
    const rows = await this.db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
    return rows[0]?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.insert(settings).values({ key, value }).onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: new Date() },
    });
  }

  async deleteSetting(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key));
  }

  async isPipelineCohortDisabled(input: {
    route: string;
    intentGroup?: string | null;
  }): Promise<boolean> {
    if (Number(await this.getSchemaVersion() ?? 0) < 18) return false;
    const result = await this.pool.query<{ disabled: boolean }>(
      `SELECT disabled
       FROM pipeline_cohort_kill_switches
       WHERE route=$1 AND disabled
         AND (intent_group IS NULL OR intent_group=$2)
       ORDER BY (intent_group IS NOT NULL) DESC
       LIMIT 1`,
      [input.route, input.intentGroup ?? null],
    );
    return result.rows[0]?.disabled === true;
  }

  async setPipelineCohortKillSwitch(input: {
    cohortKey: string;
    route: string;
    intentGroup?: string | null;
    disabled: boolean;
    reasonCode?: string | null;
    changedBy: string;
  }): Promise<void> {
    if (Number(await this.getSchemaVersion() ?? 0) < 18) {
      throw new HttpError(503, "Pipeline cohort controls are not ready", "cohort_control_unavailable");
    }
    const cohortKey = input.cohortKey.normalize("NFKC").trim().slice(0, 160);
    const route = input.route.normalize("NFKC").trim().slice(0, 48);
    const intentGroup = input.intentGroup?.normalize("NFKC").trim().slice(0, 80) || null;
    const reasonCode = input.disabled
      ? input.reasonCode?.normalize("NFKC").trim().slice(0, 120) || "owner_disabled"
      : null;
    const changedBy = input.changedBy.normalize("NFKC").trim().slice(0, 80);
    if (!cohortKey || !route || !changedBy) {
      throw new HttpError(400, "Pipeline cohort control is invalid", "invalid_cohort_control");
    }
    await this.pool.query(
      `INSERT INTO pipeline_cohort_kill_switches(
         cohort_key,route,intent_group,disabled,reason_code,changed_by,changed_at)
       VALUES($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT(route,intent_group) DO UPDATE SET
         cohort_key=excluded.cohort_key,
         disabled=excluded.disabled,reason_code=excluded.reason_code,
         changed_by=excluded.changed_by,changed_at=now()`,
      [cohortKey, route, intentGroup, input.disabled, reasonCode, changedBy],
    );
  }

  private async assertPublicationReconciliationAuthority(
    client: PoolClient,
    input: BeginPublicationReconciliationInput,
  ): Promise<void> {
    const authority = await client.query<{
      run_status: string;
      run_phase: string;
      active_contract_revision_id: string | null;
      contract_hash: string;
      contract_status: string;
      manifest_contract_revision_id: string | null;
      manifest_contract_hash: string | null;
      revision_content_hash: string;
      revision_status: string;
      revision_count: number;
      is_latest: boolean;
      execution_attempt_id: string;
      attempt_contract_revision_id: string;
      attempt_status: string;
      attempt_stage: string;
      attempt_lease_generation: number;
      job_id: string;
      job_status: string;
      job_lease_owner: string | null;
      job_lease_epoch: number;
      job_stage_key: string;
    }>(
      `SELECT run.status run_status,run.phase run_phase,
              run.active_playlist_contract_revision_id active_contract_revision_id,
              contract.contract_hash,contract.status contract_status,
              manifest.contract_revision_id manifest_contract_revision_id,
              manifest.contract_hash manifest_contract_hash,
              revision.content_hash revision_content_hash,
              revision.status revision_status,
              (SELECT count(*)::int FROM manifest_revision_tracks track
               WHERE track.manifest_revision_id=revision.id) revision_count,
              NOT EXISTS (
                SELECT 1 FROM manifest_revisions successor
                WHERE successor.manifest_id=revision.manifest_id
                  AND successor.revision>revision.revision
                  AND successor.status IN ('locked','published')
              ) is_latest,
              attempt.id execution_attempt_id,
              attempt.contract_revision_id attempt_contract_revision_id,
              attempt.status attempt_status,attempt.stage attempt_stage,
              attempt.lease_generation attempt_lease_generation,
              job.id job_id,job.status job_status,
              job.lease_owner job_lease_owner,
              job.lease_epoch job_lease_epoch,job.stage_key job_stage_key
       FROM research_runs run
       JOIN playlist_contract_revisions contract
         ON contract.id=run.active_playlist_contract_revision_id
       JOIN manifests manifest ON manifest.id=$2 AND manifest.run_id=run.id
       JOIN manifest_revisions revision
         ON revision.id=$3 AND revision.manifest_id=manifest.id
       JOIN playlist_execution_attempts attempt
         ON attempt.id=$4 AND attempt.run_id=run.id
       JOIN job_queue job ON job.id=$5 AND job.run_id=run.id
         AND job.lease_expires_at>now()
       WHERE run.id=$1 AND run.deleted_at IS NULL
       FOR UPDATE OF run,contract,manifest,revision,attempt,job`,
      [
        input.runId,
        input.manifestId,
        input.manifestRevisionId,
        input.executionAttemptId,
        input.jobId,
      ],
    );
    const row = authority.rows[0];
    const cancelled = !row
      || ["cancelled", "deleted", "expired"].includes(row.run_status)
      || ["visitor_cancelled", "owner_cancelled", "visitor_deleted"]
        .includes(row.run_phase);
    if (cancelled) {
      throw new HttpError(
        409,
        "Publication reconciliation belongs to a cancelled run",
        "publication_run_cancelled",
      );
    }
    if (row.active_contract_revision_id !== input.contractRevisionId
      || row.contract_hash !== input.contractHash
      || row.contract_status !== "active"
      || row.manifest_contract_revision_id !== input.contractRevisionId
      || row.manifest_contract_hash !== input.contractHash
      || row.revision_content_hash !== input.manifestRevisionHash
      || !["locked", "published"].includes(row.revision_status)
      || row.is_latest !== true
      || Number(row.revision_count) !== input.expectedCount
      || row.execution_attempt_id !== input.executionAttemptId
      || row.attempt_contract_revision_id !== input.contractRevisionId
      || row.attempt_status !== "running"
      || row.attempt_stage !== input.stageKey
      || Number(row.attempt_lease_generation) !== input.leaseGeneration
      || row.job_id !== input.jobId
      || row.job_status !== "leased"
      || row.job_lease_owner !== input.workerId
      || Number(row.job_lease_epoch) !== input.leaseGeneration
      || row.job_stage_key !== input.stageKey) {
      throw new HttpError(
        409,
        "Publication reconciliation is fenced to stale immutable authority",
        "publication_reconciliation_stale",
      );
    }
    const ordered = await client.query<{ catalog_id: string }>(
      `SELECT catalog_id FROM manifest_revision_tracks
       WHERE manifest_revision_id=$1 ORDER BY position`,
      [input.manifestRevisionId],
    );
    if (orderedAppleStableIdsHash(
      ordered.rows.map(({ catalog_id }) => catalog_id),
    ) !== input.expectedOrderedIdsHash) {
      throw new HttpError(
        409,
        "Publication reconciliation ordered payload changed",
        "publication_reconciliation_stale",
      );
    }
  }

  async beginPublicationReconciliation(
    input: BeginPublicationReconciliationInput,
  ): Promise<DurablePublicationReconciliation> {
    if (Number(await this.getSchemaVersion() ?? 0) < 18) {
      throw new HttpError(
        503,
        "Publication reconciliation persistence is unavailable",
        "publication_reconciliation_schema_unavailable",
      );
    }
    if (!UUID_PATTERN.test(input.runId)
      || !UUID_PATTERN.test(input.contractRevisionId)
      || !UUID_PATTERN.test(input.executionAttemptId)
      || !UUID_PATTERN.test(input.jobId)
      || !UUID_PATTERN.test(input.manifestId)
      || !UUID_PATTERN.test(input.manifestRevisionId)
      || !/^[0-9a-f]{64}$/u.test(input.contractHash)
      || !/^[0-9a-f]{64}$/u.test(input.manifestRevisionHash)
      || !/^[0-9a-f]{64}$/u.test(input.expectedOrderedIdsHash)
      || !Number.isSafeInteger(input.expectedCount)
      || input.expectedCount < 1
      || input.expectedCount > EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS
      || input.idempotencyKey.length < 1
      || input.idempotencyKey.length > 160
      || !input.workerId.trim()
      || input.workerId.length > 160
      || !input.stageKey.trim()
      || input.stageKey.length > 160
      || !Number.isSafeInteger(input.leaseGeneration)
      || input.leaseGeneration < 1) {
      throw new HttpError(
        400,
        "Publication reconciliation fence is invalid",
        "invalid_publication_reconciliation",
      );
    }
    return this.transaction(async (client) => {
      await this.assertPublicationReconciliationAuthority(client, input);
      const id = deterministicUuid({
        kind: "playlist_publication_reconciliation",
        idempotencyKey: input.idempotencyKey,
      });
      await client.query(
        `INSERT INTO playlist_publication_reconciliations(
           id,run_id,contract_revision_id,execution_attempt_id,
           manifest_id,manifest_revision_id,
           state,expected_ordered_ids_hash,appended_count,expected_count,
           batch_cursor,idempotency_key,reconciliation_json)
         VALUES($1,$2,$3,$4,$5,$6,'preflight',$7,0,$8,0,$9,$10::jsonb)
         ON CONFLICT(idempotency_key) DO NOTHING`,
        [
          id,
          input.runId,
          input.contractRevisionId,
          input.executionAttemptId,
          input.manifestId,
          input.manifestRevisionId,
          input.expectedOrderedIdsHash,
          input.expectedCount,
          input.idempotencyKey,
          JSON.stringify({
            schemaVersion: "genio-publication-reconciliation/v1",
            manifestRevisionHash: input.manifestRevisionHash,
            contractHash: input.contractHash,
            jobId: input.jobId,
            workerId: input.workerId,
            leaseGeneration: input.leaseGeneration,
            stageKey: input.stageKey,
          }),
        ],
      );
      const stored = await client.query<{
        id: string;
        run_id: string;
        contract_revision_id: string;
        execution_attempt_id: string;
        manifest_id: string;
        manifest_revision_id: string | null;
        state: DurablePublicationReconciliationState;
        expected_ordered_ids_hash: string;
        expected_count: number;
        appended_count: number;
        batch_cursor: number;
        reconciliation_json: Record<string, unknown>;
      }>(
        `SELECT id,run_id,contract_revision_id,execution_attempt_id,manifest_id,
                manifest_revision_id,state,expected_ordered_ids_hash,
                expected_count,appended_count,batch_cursor,reconciliation_json
         FROM playlist_publication_reconciliations
         WHERE idempotency_key=$1 FOR UPDATE`,
        [input.idempotencyKey],
      );
      const row = stored.rows[0];
      if (!row
        || row.run_id !== input.runId
        || row.contract_revision_id !== input.contractRevisionId
        || row.execution_attempt_id !== input.executionAttemptId
        || row.manifest_id !== input.manifestId
        || row.manifest_revision_id !== input.manifestRevisionId
        || row.expected_ordered_ids_hash !== input.expectedOrderedIdsHash
        || Number(row.expected_count) !== input.expectedCount
        || row.reconciliation_json.manifestRevisionHash
          !== input.manifestRevisionHash
        || row.reconciliation_json.contractHash !== input.contractHash
        || row.reconciliation_json.jobId !== input.jobId
        || row.reconciliation_json.workerId !== input.workerId
        || Number(row.reconciliation_json.leaseGeneration)
          !== input.leaseGeneration
        || row.reconciliation_json.stageKey !== input.stageKey) {
        throw new HttpError(
          409,
          "Publication reconciliation idempotency key was reused",
          "publication_reconciliation_conflict",
        );
      }
      return {
        id: row.id,
        state: row.state,
        appendedCount: Number(row.appended_count),
        batchCursor: Number(row.batch_cursor),
      };
    });
  }

  async advancePublicationReconciliation(
    input: AdvancePublicationReconciliationInput,
  ): Promise<DurablePublicationReconciliation> {
    if (!Number.isSafeInteger(input.appendedCount)
      || !Number.isSafeInteger(input.batchCursor)
      || input.appendedCount < 0
      || input.appendedCount > input.expectedCount
      || input.batchCursor < 0
      || input.batchCursor > input.expectedCount
      || (input.observedOrderedIdsHash != null
        && !/^[0-9a-f]{64}$/u.test(input.observedOrderedIdsHash))
      || (input.applePlaylistId != null
        && !/^[A-Za-z0-9._-]{1,160}$/u.test(input.applePlaylistId))) {
      throw new HttpError(
        400,
        "Publication reconciliation progress is invalid",
        "invalid_publication_reconciliation",
      );
    }
    const transitions: Readonly<Record<
      DurablePublicationReconciliationState,
      readonly DurablePublicationReconciliationState[]
    >> = {
      preflight: [
        "preflight",
        "create_pending",
        "append_pending",
        "reconciling",
        "authorization_blocked",
        "cancelled",
        "quarantined",
      ],
      create_pending: [
        "create_pending",
        "append_pending",
        "reconciling",
        "authorization_blocked",
        "cancelled",
        "quarantined",
      ],
      append_pending: [
        "append_pending",
        "reconciling",
        "authorization_blocked",
        "cancelled",
        "quarantined",
      ],
      reconciling: [
        "append_pending",
        "reconciling",
        "complete",
        "authorization_blocked",
        "cancelled",
        "quarantined",
      ],
      authorization_blocked: [
        "authorization_blocked",
        "preflight",
        "create_pending",
        "append_pending",
        "cancelled",
        "quarantined",
      ],
      complete: ["complete"],
      cancelled: ["cancelled"],
      quarantined: ["quarantined"],
    };
    return this.transaction(async (client) => {
      await this.assertPublicationReconciliationAuthority(client, input);
      const current = await client.query<{
        id: string;
        state: DurablePublicationReconciliationState;
        appended_count: number;
        batch_cursor: number;
        apple_playlist_id: string | null;
      }>(
        `SELECT id,state,appended_count,batch_cursor,apple_playlist_id
         FROM playlist_publication_reconciliations
         WHERE idempotency_key=$1 AND run_id=$2
           AND contract_revision_id=$3 AND manifest_id=$4
           AND manifest_revision_id=$5
           AND expected_ordered_ids_hash=$6 AND expected_count=$7
           AND execution_attempt_id=$8
         FOR UPDATE`,
        [
          input.idempotencyKey,
          input.runId,
          input.contractRevisionId,
          input.manifestId,
          input.manifestRevisionId,
          input.expectedOrderedIdsHash,
          input.expectedCount,
          input.executionAttemptId,
        ],
      );
      const row = current.rows[0];
      if (!row || !transitions[row.state].includes(input.state)) {
        throw new HttpError(
          409,
          "Publication reconciliation transition is stale or invalid",
          "publication_reconciliation_conflict",
        );
      }
      if (input.state === "complete"
        && (input.appendedCount !== input.expectedCount
          || input.batchCursor !== input.expectedCount
          || input.observedOrderedIdsHash !== input.expectedOrderedIdsHash)) {
        throw new HttpError(
          409,
          "Publication reconciliation cannot complete before exact membership",
          "publication_reconciliation_incomplete",
        );
      }
      const detail = input.detail ?? {};
      if (stableStringify(detail).length > 16_000) {
        throw new HttpError(
          400,
          "Publication reconciliation detail is too large",
          "invalid_publication_reconciliation",
        );
      }
      const updated = await client.query<{
        id: string;
        state: DurablePublicationReconciliationState;
        appended_count: number;
        batch_cursor: number;
      }>(
        `UPDATE playlist_publication_reconciliations
         SET state=$2::varchar,apple_playlist_id=COALESCE($3,apple_playlist_id),
             observed_ordered_ids_hash=$4,appended_count=$5,batch_cursor=$6,
             next_retry_at=$7,reconciliation_json=
               reconciliation_json || $8::jsonb,
             completed_at=CASE WHEN $2::varchar='complete'
               THEN COALESCE(completed_at,now()) ELSE completed_at END,
             updated_at=now()
         WHERE id=$1
         RETURNING id,state,appended_count,batch_cursor`,
        [
          row.id,
          input.state,
          input.applePlaylistId ?? null,
          input.observedOrderedIdsHash ?? null,
          input.appendedCount,
          input.batchCursor,
          input.nextRetryAt ?? null,
          JSON.stringify({
            ...detail,
            manifestRevisionHash: input.manifestRevisionHash,
            contractHash: input.contractHash,
          }),
        ],
      );
      const value = updated.rows[0]!;
      return {
        id: value.id,
        state: value.state,
        appendedCount: Number(value.appended_count),
        batchCursor: Number(value.batch_cursor),
      };
    });
  }

  /**
   * Reserve one Apple mutation token and retain a database session advisory
   * lock until the caller finishes the external write. The lock serializes
   * mutations across every API/worker replica; the token state lives in the
   * schema-1 settings table so V1/V2 jobs remain safe during the 13→14 bridge.
   */
  async acquireAppleWritePermit(
    input: AppleWritePermitRequest,
    signal?: AbortSignal,
  ): Promise<AppleWritePermit> {
    if (!input.runId || !input.manifestId || !input.publicationVolumeId
      || !/^[a-f0-9]{64}$/iu.test(input.manifestRevisionHash)
      || (input.manifestRevisionId !== null
        && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(input.manifestRevisionId))
      || (input.contractRevisionId !== null
        && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(input.contractRevisionId))
      || (input.contractHash !== null && !/^[a-f0-9]{64}$/iu.test(input.contractHash))
      || !["create_playlist", "append_tracks"].includes(input.operation)) {
      throw new Error("Apple write permit request is invalid");
    }
    const policy = readAppleWriteRatePolicy();
    const deadline = Date.now() + policy.lockWaitMs;
    const wait = (milliseconds: number) => new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error("Apple publication aborted"));
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Apple publication aborted"));
      }, { once: true });
    });

    for (;;) {
      signal?.throwIfAborted();
      const client = await this.pool.connect();
      let locked = false;
      try {
        const lock = await client.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) acquired",
          [APPLE_WRITE_GATEWAY_LOCK],
        );
        locked = lock.rows[0]?.acquired === true;
        if (!locked) {
          client.release();
          if (Date.now() >= deadline) {
            const error = new Error("Apple write gateway remained busy beyond the bounded wait");
            Object.assign(error, { code: "apple_write_gateway_busy" });
            throw error;
          }
          await wait(Math.min(100, Math.max(1, deadline - Date.now())));
          continue;
        }

        let tokenWaitMs = 0;
        await client.query("BEGIN");
        try {
          const publication = await client.query<{
            run_status: string;
            run_phase: string;
            brief_contract_version: number;
            active_contract_revision_id: string | null;
            active_contract_hash: string | null;
            manifest_revision_id: string | null;
            manifest_revision_hash: string;
            manifest_contract_revision_id: string | null;
            manifest_contract_hash: string | null;
            volume_revision_id: string | null;
          }>(
            `SELECT run.status run_status,run.phase run_phase,run.brief_contract_version,
                    run.active_playlist_contract_revision_id active_contract_revision_id,
                    active_contract.contract_hash active_contract_hash,
                    revision.id manifest_revision_id,
                    COALESCE(revision.content_hash,manifest.content_hash) manifest_revision_hash,
                    manifest.contract_revision_id manifest_contract_revision_id,
                    manifest.contract_hash manifest_contract_hash,
                    volume.manifest_revision_id volume_revision_id
             FROM research_runs run
             JOIN manifests manifest ON manifest.id=$2 AND manifest.run_id=run.id
             JOIN publication_volumes volume
               ON volume.id=$4 AND volume.manifest_id=manifest.id
             LEFT JOIN manifest_revisions revision
               ON revision.id=$3 AND revision.manifest_id=manifest.id
                 AND revision.status IN ('locked','published')
             LEFT JOIN playlist_contract_revisions active_contract
               ON active_contract.id=run.active_playlist_contract_revision_id
                 AND active_contract.status='active'
             WHERE run.id=$1 AND run.deleted_at IS NULL
             FOR SHARE OF run,manifest,volume`,
            [
              input.runId,
              input.manifestId,
              input.manifestRevisionId,
              input.publicationVolumeId,
            ],
          );
          const fence = publication.rows[0];
          const cancelled = !fence
            || ["cancelled", "deleted", "expired"].includes(fence.run_status)
            || ["visitor_cancelled", "owner_cancelled", "visitor_deleted"].includes(fence.run_phase);
          if (cancelled) {
            throw Object.assign(new Error("Playlist publication was cancelled"), {
              code: "publication_run_cancelled",
            });
          }
          const revisionMatches = fence.manifest_revision_id === input.manifestRevisionId
            && fence.manifest_revision_hash === input.manifestRevisionHash
            && fence.volume_revision_id === input.manifestRevisionId;
          const contractRequired = Number(fence.brief_contract_version) === 3
            || input.contractRevisionId !== null
            || input.contractHash !== null;
          const contractMatches = !contractRequired || (
            input.contractRevisionId !== null
            && input.contractHash !== null
            && fence.manifest_contract_revision_id === input.contractRevisionId
            && fence.manifest_contract_hash === input.contractHash
            && fence.active_contract_revision_id === input.contractRevisionId
            && fence.active_contract_hash === input.contractHash
          );
          if (!revisionMatches || !contractMatches) {
            throw Object.assign(new Error("Playlist publication fence is stale"), {
              code: "manifest_contract_stale",
            });
          }
          const stored = await client.query<{ value: string }>(
            "SELECT value FROM settings WHERE key=$1 FOR UPDATE",
            [APPLE_WRITE_GATEWAY_STATE_KEY],
          );
          let prior: AppleWriteTokenBucketState | null = null;
          try {
            const parsed = JSON.parse(stored.rows[0]?.value ?? "null") as Partial<AppleWriteTokenBucketState> | null;
            if (parsed && typeof parsed.tokens === "number" && typeof parsed.updatedAtMs === "number") {
              prior = { tokens: parsed.tokens, updatedAtMs: parsed.updatedAtMs };
            }
          } catch {
            // A malformed operational setting fails safe by resetting to the
            // bounded server-owned capacity, never to an unlimited state.
          }
          const refilled = refillAppleWriteTokenBucket({
            state: prior,
            nowMs: Date.now(),
            policy,
          });
          tokenWaitMs = appleWriteTokenWaitMs(refilled.tokens, policy.refillPerSecond);
          const nextState = {
            tokens: tokenWaitMs === 0 ? Math.max(0, refilled.tokens - 1) : refilled.tokens,
            updatedAtMs: refilled.updatedAtMs,
          };
          await client.query(
            `INSERT INTO settings(key,value) VALUES($1,$2)
             ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
            [APPLE_WRITE_GATEWAY_STATE_KEY, JSON.stringify(nextState)],
          );
          if (tokenWaitMs === 0) {
            await client.query(
              "INSERT INTO rate_limit_events(client_bucket,action) VALUES($1,$2)",
              [APPLE_WRITE_GATEWAY_EVENT_BUCKET, APPLE_WRITE_GATEWAY_EVENT_ACTION],
            );
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }

        if (tokenWaitMs > 0) {
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [APPLE_WRITE_GATEWAY_LOCK]);
          locked = false;
          client.release();
          if (Date.now() + tokenWaitMs > deadline) {
            const error = new Error("Apple write rate gate could not issue a token within the bounded wait");
            Object.assign(error, { code: "apple_write_rate_limited" });
            throw error;
          }
          await wait(tokenWaitMs);
          continue;
        }

        let released = false;
        return {
          release: async () => {
            if (released) return;
            released = true;
            try {
              await client.query(
                "SELECT pg_advisory_unlock(hashtextextended($1,0))",
                [APPLE_WRITE_GATEWAY_LOCK],
              );
            } finally {
              client.release();
            }
          },
        };
      } catch (error) {
        if (locked) {
          try {
            await client.query(
              "SELECT pg_advisory_unlock(hashtextextended($1,0))",
              [APPLE_WRITE_GATEWAY_LOCK],
            );
          } catch {
            // Releasing the client also releases session advisory locks if the
            // connection was lost while handling the primary error.
          }
          client.release();
        }
        throw error;
      }
    }
  }

  async createFeedbackSubmission(input: {
    submission: FeedbackSubmissionInput;
    idempotencyKey: string;
    clientBucket: string;
    clientBucketAliases: string[];
    ownerRateLimitExempt: boolean;
  }): Promise<{ id: string; created: boolean }> {
    const aliases = [...new Set(input.clientBucketAliases.map((value) => value.trim()).filter(Boolean))];
    const primary = input.clientBucket.trim();
    if (!primary || aliases.length === 0 || !aliases.includes(primary)) {
      throw new HttpError(401, "Client bucket is required", "invalid_gateway_identity");
    }
    const payloadHash = feedbackPayloadHash(input.submission);
    const mappingKeys = aliases.map((alias) => `${FEEDBACK_IDEMPOTENCY_PREFIX}${sha256Hex(`${alias}:${input.idempotencyKey}`)}`);
    return this.transaction(async (client) => {
      // The global lock makes the application-wide daily and storage ceilings
      // atomic even when submissions arrive from unrelated client buckets.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["feedback:global"]);
      // Lock every HMAC-derived alias in a stable order. This keeps both the
      // current and previous daily bucket safe across the midnight rollover.
      for (const alias of [...aliases].sort()) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`feedback:${alias}`]);
      }
      const pause = await client.query<{ paused: boolean }>(
        "SELECT COALESCE((SELECT value='true' FROM settings WHERE key='feedback_paused'),false) paused",
      );
      if (pause.rows[0]?.paused) {
        throw new HttpError(503, "Feedback is temporarily paused", "feedback_paused");
      }
      const existingMappings = await client.query<{ value: string }>(
        "SELECT value FROM settings WHERE key=ANY($1::text[]) FOR UPDATE",
        [mappingKeys],
      );
      let mappedId: string | null = null;
      for (const row of existingMappings.rows) {
        let mapping: { id?: unknown; payloadHash?: unknown } = {};
        try {
          mapping = JSON.parse(row.value) as { id?: unknown; payloadHash?: unknown };
        } catch {
          // A malformed internal mapping is unusable and will be replaced
          // while this transaction holds every relevant advisory lock.
        }
        if (typeof mapping.id !== "string") continue;
        if (mapping.payloadHash !== payloadHash) {
          throw new HttpError(409, "Idempotency key was already used for different feedback", "idempotency_conflict");
        }
        if (mappedId && mappedId !== mapping.id) {
          throw new HttpError(409, "Idempotency mappings disagree", "idempotency_conflict");
        }
        mappedId = mapping.id;
      }
      if (mappedId) {
        const submission = await client.query(
          "SELECT 1 FROM settings WHERE key=$1",
          [`${FEEDBACK_SUBMISSION_PREFIX}${mappedId}`],
        );
        if (submission.rows[0]) return { id: mappedId, created: false };
      }

      if (!input.ownerRateLimitExempt) {
        const rateCounts = await client.query<{ hourly: number; daily: number }>(
          `SELECT
             count(*) FILTER (WHERE action='feedback_hour' AND occurred_at>now()-interval '1 hour')::int hourly,
             count(*) FILTER (WHERE action='feedback_day' AND occurred_at>now()-interval '24 hours')::int daily
           FROM rate_limit_events
           WHERE client_bucket=ANY($1::text[]) AND action=ANY($2::text[])`,
          [aliases, ["feedback_hour", "feedback_day"]],
        );
        if ((rateCounts.rows[0]?.hourly ?? 0) >= 2 || (rateCounts.rows[0]?.daily ?? 0) >= 5) {
          throw new HttpError(429, "Feedback limit reached; try again later", "feedback_rate_limited");
        }
      }

      const globalCapacity = await client.query<{ daily: number; stored_bytes: string }>(
        `SELECT
           (SELECT count(*)::int
              FROM rate_limit_events
             WHERE client_bucket=$1 AND action='feedback_global_day'
               AND occurred_at>now()-interval '24 hours') daily,
           (SELECT COALESCE(sum(
             CASE
               WHEN jsonb_typeof(value::jsonb->'image'->'byteSize')='number'
               THEN (value::jsonb->'image'->>'byteSize')::bigint
               ELSE 0
             END
           ),0)::text
              FROM settings
             WHERE key LIKE 'feedback-submission:%') stored_bytes`,
        [FEEDBACK_GLOBAL_BUCKET],
      );
      if ((globalCapacity.rows[0]?.daily ?? 0) >= FEEDBACK_GLOBAL_DAILY_LIMIT) {
        throw new HttpError(503, "Feedback is temporarily at capacity", "feedback_global_limit");
      }
      const storedBytes = Number(globalCapacity.rows[0]?.stored_bytes ?? 0);
      const incomingBytes = input.submission.image?.byteSize ?? 0;
      if (incomingBytes > 0 && (!Number.isFinite(storedBytes) || storedBytes + incomingBytes > FEEDBACK_STORAGE_LIMIT_BYTES)) {
        throw new HttpError(503, "Screenshot storage is temporarily at capacity; submit without an image", "feedback_storage_limit");
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      const record: FeedbackSubmissionRecord = {
        id,
        origin: "manual",
        kind: input.submission.kind,
        message: input.submission.message,
        pagePath: input.submission.pagePath,
        appVersion: input.submission.appVersion,
        image: input.submission.image,
        status: "new",
        createdAt: now,
        updatedAt: now,
      };
      await client.query(
        "INSERT INTO settings(key,value) VALUES($1,$2)",
        [`${FEEDBACK_SUBMISSION_PREFIX}${id}`, JSON.stringify(record)],
      );
      const mappingValue = JSON.stringify({ id, payloadHash });
      for (const key of mappingKeys) {
        await client.query(
          `INSERT INTO settings(key,value) VALUES($1,$2)
           ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
          [key, mappingValue],
        );
      }
      if (input.ownerRateLimitExempt) {
        // Owner submissions are exempt only from the per-client convenience
        // limits. They still consume the application-wide daily ceiling so a
        // signed-in owner cannot bypass operational capacity safeguards.
        await client.query(
          "INSERT INTO rate_limit_events(client_bucket,action) VALUES($1,'feedback_global_day')",
          [FEEDBACK_GLOBAL_BUCKET],
        );
      } else {
        await client.query(
          `INSERT INTO rate_limit_events(client_bucket,action)
           VALUES($1,'feedback_hour'),($1,'feedback_day'),($2,'feedback_global_day')`,
          [primary, FEEDBACK_GLOBAL_BUCKET],
        );
      }
      return { id, created: true };
    });
  }

  private async persistAutomaticFailureFeedback(
    inputDiagnostics: AutomaticFailureDiagnostics,
  ): Promise<{ id: string; created: boolean } | null> {
    const diagnostics = boundedAutomaticFailureDiagnostics(inputDiagnostics);
    const mappingKey = `${FEEDBACK_AUTOMATIC_EVENT_PREFIX}${diagnostics.eventFingerprint}`;
    return this.transaction(async (client) => {
      // Capture reads the diagnostic snapshot before opening this transaction.
      // Revalidate and lock the source here so visitor deletion cannot win the
      // race and then have this insert recreate an owner-visible copy of the
      // deleted prompt. Lock the retained access row using the same lock mode
      // and row order as deleteRunAccess. A KEY SHARE lock is insufficient
      // here because it does not block that method's non-key deleted_at update.
      // If capture wins, deletion waits and removes the new report; if deletion
      // wins, this query resumes after commit and returns no retained source.
      if (diagnostics.runId) {
        if (!diagnostics.runAccessId) return null;
        // Retention otherwise locks the parent run before cascading into its
        // accesses while capture locks an access before its audit FK touches
        // the parent. Serialize those opposite row-lock paths at the source.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          [`${FEEDBACK_AUTOMATIC_SOURCE_LOCK_PREFIX}run:${diagnostics.runId}`],
        );
        const retained = await client.query(
          `SELECT 1
           FROM research_runs r
           JOIN run_accesses a ON a.run_id=r.id
           WHERE r.id=$1
             AND a.id=$2
             AND r.deleted_at IS NULL
             AND a.deleted_at IS NULL
             AND a.expires_at>now()
           FOR UPDATE OF a`,
          [diagnostics.runId, diagnostics.runAccessId],
        );
        if (!retained.rows[0]) return null;
      } else if (diagnostics.briefRequestId) {
        const retained = await client.query(
          `SELECT 1 FROM brief_requests
           WHERE id=$1 AND prompt<>''
           FOR UPDATE`,
          [diagnostics.briefRequestId],
        );
        if (!retained.rows[0]) return null;
      } else {
        return null;
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [mappingKey]);
      const mapping = await client.query<{ value: string }>(
        "SELECT value FROM settings WHERE key=$1 FOR UPDATE",
        [mappingKey],
      );
      if (mapping.rows[0]) {
        try {
          const parsed = JSON.parse(mapping.rows[0].value) as { id?: unknown; suppressed?: unknown };
          // Owner deletion and an emergency-pause suppression are durable for
          // the lifetime of the source. Reconciliation revisits retained
          // terminal sources, so this check must happen before the pause path
          // or every heartbeat would append another suppression audit.
          if (parsed.suppressed === true) return null;
          if (typeof parsed.id === "string") {
            const existing = await client.query<{ value: string }>(
              "SELECT value FROM settings WHERE key=$1 FOR UPDATE",
              [`${FEEDBACK_SUBMISSION_PREFIX}${parsed.id}`],
            );
            if (existing.rows[0]) {
              // The same terminal transition can be delivered by the direct
              // hook and heartbeat reconciliation. Treat that replay as
              // idempotent rather than inflating a user-visible occurrence
              // count. Genuinely different root causes/generations have a
              // different fingerprint and create their own report.
              return { id: parsed.id, created: false };
            }
          }
        } catch {
          // Replace a malformed internal mapping while holding its lock.
        }
      }
      const pause = await client.query<{ paused: boolean }>(
        "SELECT COALESCE((SELECT value='true' FROM settings WHERE key='feedback_paused'),false) paused",
      );
      if (pause.rows[0]?.paused) {
        await client.query(
          `INSERT INTO settings(key,value) VALUES($1,$2)
           ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
          [mappingKey, JSON.stringify({
            eventFingerprint: diagnostics.eventFingerprint,
            runId: diagnostics.runId,
            runAccessId: diagnostics.runAccessId,
            briefRequestId: diagnostics.briefRequestId,
            terminalGeneration: diagnostics.terminalGeneration,
            suppressed: true,
            suppressionReason: "feedback_paused",
            deletedAt: new Date().toISOString(),
          })],
        );
        await client.query(
          `INSERT INTO audit_events(run_id,actor,action,detail_json)
           VALUES($1,'system','feedback.automatic_failure_suppressed',$2::jsonb)`,
          [diagnostics.runId, JSON.stringify({
            briefRequestId: diagnostics.briefRequestId,
            runAccessId: diagnostics.runAccessId,
            failureClass: diagnostics.failureClass,
            status: diagnostics.status,
            phase: diagnostics.phase,
            activePlanRevision: diagnostics.plan.queryPlanRevision
              ?? diagnostics.plan.selectionPlanRevision ?? null,
            errorCode: diagnostics.errorCode,
            terminalGeneration: diagnostics.terminalGeneration,
            eventFingerprint: diagnostics.eventFingerprint,
            reason: "feedback_paused",
          })],
        );
        return null;
      }

      const id = randomUUID();
      const now = diagnostics.occurredAt;
      const qaScenario = createAutomaticQaScenario(diagnostics);
      const report: FeedbackSubmissionRecord = {
        id,
        origin: "automatic_failure",
        kind: "bug",
        status: "new",
        message: [
          `Automatic ${diagnostics.failureClass.replaceAll("_", " ")} report.`,
          diagnostics.prompt ? `Request: ${diagnostics.prompt}` : "Request text was unavailable.",
          `${diagnostics.status}${diagnostics.phase ? ` / ${diagnostics.phase}` : ""}.`,
          diagnostics.errorMessage ?? "No additional error detail was persisted.",
        ].join(" ").slice(0, 4_000),
        pagePath: diagnostics.runId ? "/jobs" : "/",
        appVersion: typeof diagnostics.runtime.appVersion === "string"
          ? diagnostics.runtime.appVersion
          : null,
        image: null,
        automaticFailure: diagnostics,
        qaScenario,
        qaStatus: "quarantined",
        occurrenceCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      };
      await client.query(
        "INSERT INTO settings(key,value) VALUES($1,$2)",
        [`${FEEDBACK_SUBMISSION_PREFIX}${id}`, JSON.stringify(report)],
      );
      await client.query(
        `INSERT INTO settings(key,value) VALUES($1,$2)
         ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
        [mappingKey, JSON.stringify({
          id,
          eventFingerprint: diagnostics.eventFingerprint,
          runId: diagnostics.runId,
          runAccessId: diagnostics.runAccessId,
          briefRequestId: diagnostics.briefRequestId,
          terminalGeneration: diagnostics.terminalGeneration,
          suppressed: false,
        })],
      );
      await client.query(
        `INSERT INTO audit_events(run_id,actor,action,detail_json)
         VALUES($1,'system','feedback.automatic_failure_captured',$2::jsonb)`,
        [
          diagnostics.runId,
          JSON.stringify({
            feedbackId: id,
            briefRequestId: diagnostics.briefRequestId,
            runAccessId: diagnostics.runAccessId,
            failureClass: diagnostics.failureClass,
            status: diagnostics.status,
            phase: diagnostics.phase,
            activePlanRevision: diagnostics.plan.queryPlanRevision
              ?? diagnostics.plan.selectionPlanRevision ?? null,
            errorCode: diagnostics.errorCode,
            terminalGeneration: diagnostics.terminalGeneration,
            eventFingerprint: diagnostics.eventFingerprint,
          }),
        ],
      );
      return { id, created: true };
    });
  }

  async captureAutomaticRunFailure(runId: string): Promise<{ id: string; created: boolean } | null> {
    const schemaVersion = Number(await this.getSchemaVersion() ?? 0);
    const result = await this.pool.query<Record<string, unknown>>(schemaVersion >= 14
      ? `SELECT r.id,r.status,r.phase,r.error,r.brief_json,r.selection_plan_json,
                r.pipeline_version,r.policy_version,r.pipeline_policy_snapshot_json,
                r.pipeline_outcome_json,r.estimated_cost_usd,r.actual_cost_usd,
                r.approved_budget_usd,r.created_at,r.updated_at,r.completed_at,
                spec.raw_prompt,spec.requested_track_count,spec.storefront,spec.spec_hash,
                spec.guidance_answers_json,
                access.id AS access_id,access.prompt AS access_prompt,access.model AS brief_model,
                selection.id AS selection_plan_id,selection.revision AS selection_plan_revision,
                selection.plan_hash AS selection_plan_hash,
                query.id AS query_plan_id,query.revision AS query_plan_revision,
                query.plan_hash AS query_plan_hash,query.plan_json AS query_plan_json
         FROM research_runs r
         LEFT JOIN run_specs spec ON spec.run_id=r.id
         LEFT JOIN run_active_query_plans active ON active.run_id=r.id
         LEFT JOIN query_plan_revisions query ON query.id=active.query_plan_revision_id
         LEFT JOIN selection_plans selection ON selection.id=query.selection_plan_id
         LEFT JOIN LATERAL (
           SELECT a.id,a.prompt,b.model
           FROM run_accesses a
           LEFT JOIN brief_requests b ON b.id=a.brief_request_id
           WHERE a.run_id=r.id AND a.deleted_at IS NULL AND a.expires_at>now()
           ORDER BY a.created_at DESC LIMIT 1
         ) access ON true
         WHERE r.id=$1 AND r.deleted_at IS NULL`
      : `SELECT r.id,r.status,r.phase,r.error,r.brief_json,r.selection_plan_json,
                r.pipeline_version,r.policy_version,r.pipeline_policy_snapshot_json,
                r.pipeline_outcome_json,r.estimated_cost_usd,r.actual_cost_usd,
                r.approved_budget_usd,r.created_at,r.updated_at,r.completed_at,
                NULL::text raw_prompt,NULL::int requested_track_count,NULL::text storefront,
                NULL::text spec_hash,NULL::jsonb guidance_answers_json,
                access.id AS access_id,access.prompt AS access_prompt,access.model AS brief_model,
                NULL::uuid selection_plan_id,NULL::int selection_plan_revision,
                NULL::text selection_plan_hash,NULL::uuid query_plan_id,
                NULL::int query_plan_revision,NULL::text query_plan_hash,NULL::jsonb query_plan_json
         FROM research_runs r
         LEFT JOIN LATERAL (
           SELECT a.id,a.prompt,b.model
           FROM run_accesses a
           LEFT JOIN brief_requests b ON b.id=a.brief_request_id
           WHERE a.run_id=r.id AND a.deleted_at IS NULL AND a.expires_at>now()
           ORDER BY a.created_at DESC LIMIT 1
         ) access ON true
         WHERE r.id=$1 AND r.deleted_at IS NULL`,
    [runId]);
    const row = result.rows[0];
    if (!row) return null;
    const status = String(row.status ?? "");
    const phase = row.phase == null ? null : String(row.phase);
    const failureClass = classifyAutomaticRunFailure(status, phase);
    if (!failureClass) return null;

    const counts = await this.pool.query<Record<string, unknown>>(
      `SELECT
         (SELECT count(*)::int FROM track_candidates WHERE run_id=$1) discovered,
         (SELECT count(*)::int FROM source_records WHERE run_id=$1) sources,
         (SELECT count(*)::int FROM evidence_claims WHERE run_id=$1) evidence,
         (SELECT count(*)::int FROM catalog_matches WHERE run_id=$1) apple_lookups,
         (SELECT count(*)::int FROM catalog_matches WHERE run_id=$1 AND status='accepted') accepted,
         (SELECT count(*)::int FROM manifest_tracks mt JOIN manifests m ON m.id=mt.manifest_id WHERE m.run_id=$1) manifested,
         (SELECT COALESCE(sum(pv.appended_count),0)::int FROM publication_volumes pv JOIN manifests m ON m.id=pv.manifest_id WHERE m.run_id=$1) published`,
      [runId],
    );
    const checkpointRows = await this.pool.query<{ phase: string; state_json: unknown }>(
      `SELECT phase,state_json FROM research_checkpoints
       WHERE run_id=$1 AND (
         phase ILIKE '%semantic%' OR phase ILIKE '%outcome%'
         OR phase ILIKE '%recovery%' OR phase='partial_ready'
       ) ORDER BY updated_at DESC LIMIT 8`,
      [runId],
    );
    const rawCounts = counts.rows[0] ?? {};
    const counters = Object.fromEntries(
      Object.entries(rawCounts).map(([key, value]) => [key, Math.max(0, Number(value) || 0)]),
    );
    const build = buildInformation();
    const release = runtimeReleaseContract();
    const queryPlan = row.query_plan_json && typeof row.query_plan_json === "object"
      ? row.query_plan_json as Record<string, unknown>
      : {};
    const occurredAt = date(row.completed_at ?? row.updated_at)?.toISOString() ?? new Date().toISOString();
    const terminalGeneration = date(row.completed_at)?.getTime().toString() ?? null;
    const rootCause = checkpointRows.rows
      .map(({ state_json }) => state_json && typeof state_json === "object"
        ? (state_json as Record<string, unknown>).rootCause
        : null)
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)
      ?? (row.pipeline_outcome_json && typeof row.pipeline_outcome_json === "object"
        && typeof (row.pipeline_outcome_json as Record<string, unknown>).rootCause === "string"
        ? String((row.pipeline_outcome_json as Record<string, unknown>).rootCause)
        : null);
    const errorCode = automaticFailureErrorCode(rootCause, `${failureClass}_terminal`);
    const activePlanRevision = row.query_plan_revision ?? row.selection_plan_revision ?? null;
    const eventFingerprint = automaticFailureFingerprint({
      source: "run",
      sourceId: runId,
      status,
      phase,
      failureClass,
      activePlanRevision: typeof activePlanRevision === "string" || typeof activePlanRevision === "number"
        ? activePlanRevision
        : null,
      errorCode,
      terminalGeneration,
    });
    const diagnostics: AutomaticFailureDiagnostics = {
      schemaVersion: 1,
      failureClass,
      eventFingerprint,
      runId,
      runAccessId: typeof row.access_id === "string" ? row.access_id : null,
      briefRequestId: null,
      // A canonical run may be shared by several capability sessions. Never
      // copy the run-global immutable spec prompt into owner feedback; bind the
      // diagnostic to the one retained access whose prompt is being captured.
      prompt: String(row.access_prompt ?? "").slice(0, 2_000),
      requestedTrackCount: requestedTrackCountFromRunMetadata(row),
      storefront: typeof row.storefront === "string" ? row.storefront.slice(0, 16) : null,
      status,
      phase,
      rootCause: rootCause?.slice(0, 240) ?? null,
      errorCode,
      errorMessage: row.error == null ? null : sanitizeFailure(String(row.error), failureContextForRun(phase)).slice(0, 2_000),
      terminalGeneration,
      occurredAt,
      runtime: {
        appVersion: build.identifier,
        buildRevision: build.revision,
        databaseSchemaVersion: String(schemaVersion),
        workerProtocol: release.workerProtocol,
        promptVersion: release.promptVersion,
        baselineModel: release.baselineProviderModelId,
        actualBriefModel: typeof row.brief_model === "string" ? row.brief_model.slice(0, 120) : null,
      },
      plan: {
        pipelineVersion: typeof row.pipeline_version === "string" ? row.pipeline_version : "unknown",
        policyVersion: typeof row.policy_version === "string" ? row.policy_version : "unknown",
        specHash: typeof row.spec_hash === "string" ? row.spec_hash : null,
        selectionPlanId: typeof row.selection_plan_id === "string" ? row.selection_plan_id : null,
        selectionPlanRevision: typeof row.selection_plan_revision === "number" ? row.selection_plan_revision : null,
        selectionPlanHash: typeof row.selection_plan_hash === "string" ? row.selection_plan_hash : null,
        queryPlanId: typeof row.query_plan_id === "string" ? row.query_plan_id : null,
        queryPlanRevision: typeof row.query_plan_revision === "number" ? row.query_plan_revision : null,
        queryPlanHash: typeof row.query_plan_hash === "string" ? row.query_plan_hash : null,
        queryPlanSchemaVersion: typeof queryPlan.schemaVersion === "number" ? queryPlan.schemaVersion : null,
      },
      counters,
      details: boundedOwnerDiagnosticValue({
        guidanceAnswerCount: countDiagnosticItems(row.guidance_answers_json),
        pipelinePolicyPresent: Boolean(row.pipeline_policy_snapshot_json),
        pipelineOutcome: diagnosticOutcomeSummary(row.pipeline_outcome_json),
        checkpoints: checkpointRows.rows.map((checkpoint) => ({
          phase: checkpoint.phase,
          outcome: diagnosticOutcomeSummary(checkpoint.state_json),
        })),
        cost: {
          estimatedUsd: Number(row.estimated_cost_usd ?? 0),
          actualUsd: Number(row.actual_cost_usd ?? 0),
          approvedUsd: Number(row.approved_budget_usd ?? 0),
        },
        timestamps: {
          createdAt: date(row.created_at)?.toISOString() ?? null,
          completedAt: date(row.completed_at)?.toISOString() ?? null,
        },
      }) as Record<string, unknown>,
    };
    return this.persistAutomaticFailureFeedback(diagnostics);
  }

  async captureAutomaticBriefFailure(briefRequestId: string): Promise<{ id: string; created: boolean } | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT id,prompt,requested_track_count,model,status,error,brief_json,
              questions_json,answers_json,guidance_source_hints_json,guidance_telemetry_json,
              guidance_preferences_json,pipeline_version,policy_version,selection_plan_json,
              estimate_usd,created_at,updated_at
       FROM brief_requests WHERE id=$1`,
      [briefRequestId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const status = String(row.status ?? "");
    const failureClass = classifyAutomaticBriefFailure(status);
    if (!failureClass) return null;
    const build = buildInformation();
    const release = runtimeReleaseContract();
    const terminalGeneration = date(row.updated_at)?.getTime().toString() ?? null;
    const eventFingerprint = automaticFailureFingerprint({
      source: "brief",
      sourceId: briefRequestId,
      status,
      phase: "brief_failed",
      failureClass,
      errorCode: "brief_interpretation_failed",
      terminalGeneration,
    });
    const requestedTrackCount = Number(row.requested_track_count);
    const diagnostics: AutomaticFailureDiagnostics = {
      schemaVersion: 1,
      failureClass,
      eventFingerprint,
      runId: null,
      runAccessId: null,
      briefRequestId,
      prompt: String(row.prompt ?? "").slice(0, 2_000),
      requestedTrackCount: Number.isInteger(requestedTrackCount) ? requestedTrackCount : null,
      storefront: null,
      status,
      phase: "brief_failed",
      rootCause: "brief_interpretation_failed",
      errorCode: "brief_interpretation_failed",
      errorMessage: row.error == null ? null : sanitizeFailure(String(row.error), "brief").slice(0, 2_000),
      terminalGeneration,
      occurredAt: date(row.updated_at)?.toISOString() ?? new Date().toISOString(),
      runtime: {
        appVersion: build.identifier,
        buildRevision: build.revision,
        databaseSchemaVersion: String(await this.getSchemaVersion() ?? "unknown"),
        workerProtocol: release.workerProtocol,
        promptVersion: release.promptVersion,
        configuredModel: typeof row.model === "string" ? row.model.slice(0, 120) : null,
      },
      plan: {
        pipelineVersion: typeof row.pipeline_version === "string" ? row.pipeline_version : "unknown",
        policyVersion: typeof row.policy_version === "string" ? row.policy_version : "unknown",
        selectionPlanPresent: Boolean(row.selection_plan_json),
      },
      counters: {},
      details: boundedOwnerDiagnosticValue({
        guidance: {
          questionCount: countDiagnosticItems(row.questions_json),
          answerCount: countDiagnosticItems(row.answers_json),
          sourceHintCount: countDiagnosticItems(row.guidance_source_hints_json),
          preferenceCount: countDiagnosticItems(row.guidance_preferences_json),
          telemetryPresent: Boolean(row.guidance_telemetry_json),
          briefPresent: Boolean(row.brief_json),
        },
        estimateUsd: Number(row.estimate_usd ?? 0),
        createdAt: date(row.created_at)?.toISOString() ?? null,
      }) as Record<string, unknown>,
    };
    return this.persistAutomaticFailureFeedback(diagnostics);
  }

  private async captureAutomaticRunFailureSafely(runId: string): Promise<void> {
    try {
      await this.captureAutomaticRunFailure(runId);
    } catch (error) {
      console.error("[automatic-failure-feedback] run capture failed", {
        runId,
        message: error instanceof Error ? error.message.slice(0, 500) : "unknown error",
      });
    }
  }

  private async captureAutomaticBriefFailureSafely(briefRequestId: string): Promise<void> {
    try {
      await this.captureAutomaticBriefFailure(briefRequestId);
    } catch (error) {
      console.error("[automatic-failure-feedback] brief capture failed", {
        briefRequestId,
        message: error instanceof Error ? error.message.slice(0, 500) : "unknown error",
      });
    }
  }

  /**
   * Terminal transitions try to capture their diagnostic immediately, but the
   * report is deliberately best-effort so a reporting outage can never mask
   * the original search outcome. Worker heartbeats reconcile any uncaptured
   * recent failures, making the side effect eventually durable after a
   * transient database/process failure without adding another queue service.
   */
  private async reconcileAutomaticFailureFeedback(): Promise<void> {
    let pending: Array<{ source: "run" | "brief"; id: string }> = [];
    try {
      pending = await this.transaction(async (client) => {
        const lock = await client.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_xact_lock(hashtext($1)) acquired",
          [FEEDBACK_AUTOMATIC_RECONCILIATION_LOCK],
        );
        if (lock.rows[0]?.acquired !== true) return [];

        const previous = await client.query<{ value: string }>(
          "SELECT value FROM settings WHERE key=$1 FOR UPDATE",
          [FEEDBACK_AUTOMATIC_RECONCILIATION_KEY],
        );
        const lastAttemptAt = previous.rows[0]
          ? Date.parse(previous.rows[0].value)
          : Number.NaN;
        if (Number.isFinite(lastAttemptAt)
          && Date.now() - lastAttemptAt < FEEDBACK_AUTOMATIC_RECONCILIATION_INTERVAL_MS) {
          return [];
        }
        await client.query(
          `INSERT INTO settings(key,value) VALUES($1,$2)
           ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
          [FEEDBACK_AUTOMATIC_RECONCILIATION_KEY, new Date().toISOString()],
        );

        // Reserve half of every reconciliation pass for each source type so
        // a backlog of terminal runs can never starve failed brief captures.
        const perSourceLimit = Math.max(1, Math.floor(FEEDBACK_AUTOMATIC_RECONCILIATION_LIMIT / 2));
        const runs = await client.query<{ id: string }>(
          `SELECT r.id
           FROM research_runs r
           LEFT JOIN settings touch
             ON touch.key=$2||'run:'||r.id::text
           WHERE r.deleted_at IS NULL
             AND r.updated_at>now()-interval '90 days'
             AND (r.status IN ('failed_system','failed_integrity') OR (
               r.status='failed'
               AND COALESCE(r.phase,'') NOT IN (
                 'owner_cancelled','visitor_deleted','cancelled','deleted','expired',
                 'apple_authorization','apple_reauthorization','waiting_for_apple_authorization'
               )
             ))
             AND EXISTS (
               SELECT 1 FROM run_accesses access
               WHERE access.run_id=r.id
                 AND access.deleted_at IS NULL
                 AND access.expires_at>now()
             )
           ORDER BY touch.updated_at ASC NULLS FIRST,r.updated_at DESC,r.id
           LIMIT $1`,
          [perSourceLimit, FEEDBACK_AUTOMATIC_RECONCILIATION_TOUCH_PREFIX],
        );
        const briefs = await client.query<{ id: string }>(
            `SELECT brief.id
             FROM brief_requests brief
             LEFT JOIN settings touch
               ON touch.key=$2||'brief:'||brief.id::text
             WHERE brief.status='failed'
               AND brief.prompt<>''
               AND brief.updated_at>now()-interval '90 days'
             ORDER BY touch.updated_at ASC NULLS FIRST,brief.updated_at DESC,brief.id
             LIMIT $1`,
            [perSourceLimit, FEEDBACK_AUTOMATIC_RECONCILIATION_TOUCH_PREFIX],
          );
        const selected = [
          ...runs.rows.map(({ id }) => ({ source: "run" as const, id })),
          ...briefs.rows.map(({ id }) => ({ source: "brief" as const, id })),
        ];
        // Reconciliation rotates through every retained terminal event rather
        // than relying on a weaker subset of the event fingerprint in SQL.
        // The capture path computes the authoritative fingerprint (including
        // root-cause code, active plan, and terminal generation) and remains
        // idempotent for exact replays. This prevents an older audit or owner
        // suppression from masking a genuinely different later failure.
        for (const failure of selected) {
          await client.query(
            `INSERT INTO settings(key,value) VALUES($1,$2)
             ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
            [
              `${FEEDBACK_AUTOMATIC_RECONCILIATION_TOUCH_PREFIX}${failure.source}:${failure.id}`,
              new Date().toISOString(),
            ],
          );
        }
        return selected;
      });
    } catch (error) {
      console.error("[automatic-failure-feedback] reconciliation scan failed", {
        message: error instanceof Error ? error.message.slice(0, 500) : "unknown error",
      });
      return;
    }

    for (const failure of pending) {
      if (failure.source === "run") await this.captureAutomaticRunFailureSafely(failure.id);
      else await this.captureAutomaticBriefFailureSafely(failure.id);
    }
  }

  /**
   * Automatic failure reports deliberately contain the visitor request after
   * credential-like values are redacted so it can be replayed in QA. Keep
   * that private diagnostic bound to the source record's deletion lifecycle
   * rather than retaining it as unrelated owner feedback.
   */
  private async deleteAutomaticFailureFeedbackForSource(
    client: PoolClient,
    source: { runId?: string | null; runAccessId?: string | null; briefRequestId?: string | null },
  ): Promise<number> {
    const runId = source.runId?.trim() || null;
    const runAccessId = source.runAccessId?.trim() || null;
    const briefRequestId = source.briefRequestId?.trim() || null;
    if (!runId && !runAccessId && !briefRequestId) return 0;
    const deleted = await client.query<{ value: string }>(
      `DELETE FROM settings
       WHERE key LIKE 'feedback-submission:%'
         AND value::jsonb->>'origin'='automatic_failure'
         AND (
           ($1::text IS NOT NULL AND value::jsonb #>> '{automaticFailure,runId}'=$1)
           OR ($2::text IS NOT NULL AND value::jsonb #>> '{automaticFailure,runAccessId}'=$2)
           OR ($3::text IS NOT NULL AND value::jsonb #>> '{automaticFailure,briefRequestId}'=$3)
         )
       RETURNING value`,
      [runId, runAccessId, briefRequestId],
    );
    const ids = deleted.rows.flatMap((row) => {
      try {
        const id = (JSON.parse(row.value) as { id?: unknown }).id;
        return typeof id === "string" ? [id] : [];
      } catch {
        return [];
      }
    });
    await client.query(
      `DELETE FROM settings
       WHERE (key LIKE 'feedback-idempotency:%' OR key LIKE 'feedback-automatic-event:%')
         AND (
           value::jsonb->>'id'=ANY($4::text[])
            OR ($1::text IS NOT NULL AND value::jsonb->>'runId'=$1)
            OR ($2::text IS NOT NULL AND value::jsonb->>'runAccessId'=$2)
            OR ($3::text IS NOT NULL AND value::jsonb->>'briefRequestId'=$3)
         )`,
      [runId, runAccessId, briefRequestId, ids],
    );
    await client.query(
      `DELETE FROM audit_events
       WHERE action IN (
         'feedback.automatic_failure_captured',
         'feedback.automatic_failure_suppressed'
       )
         AND (
           detail_json->>'feedbackId'=ANY($4::text[])
           OR ($1::text IS NOT NULL AND run_id=$1::uuid)
           OR ($2::text IS NOT NULL AND detail_json->>'runAccessId'=$2)
           OR ($3::text IS NOT NULL AND detail_json->>'briefRequestId'=$3)
         )`,
      [runId, runAccessId, briefRequestId, ids],
    );
    const reconciliationTouches = [
      runId ? `${FEEDBACK_AUTOMATIC_RECONCILIATION_TOUCH_PREFIX}run:${runId}` : null,
      briefRequestId ? `${FEEDBACK_AUTOMATIC_RECONCILIATION_TOUCH_PREFIX}brief:${briefRequestId}` : null,
    ].filter((key): key is string => key !== null);
    if (reconciliationTouches.length > 0) {
      await client.query("DELETE FROM settings WHERE key=ANY($1::text[])", [reconciliationTouches]);
    }
    return deleted.rowCount ?? 0;
  }

  async listFeedbackSubmissions(input: {
    limit?: number;
    offset?: number;
    kind?: FeedbackKind | null;
    status?: FeedbackStatus | null;
  } = {}): Promise<{
    items: FeedbackListItem[];
    total: number;
    counts: { new: number; reviewed: number; resolved: number };
  }> {
    const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(Math.floor(input.limit as number), 100)) : 50;
    const offset = Number.isFinite(input.offset) ? Math.max(0, Math.min(Math.floor(input.offset as number), 1_000_000)) : 0;
    const [result, summary] = await Promise.all([
      this.pool.query<{ value: string; total: number }>(
        `SELECT value,count(*) OVER()::int total FROM settings
         WHERE key LIKE 'feedback-submission:%'
           AND ($1::text IS NULL OR value::jsonb->>'kind'=$1)
           AND ($2::text IS NULL OR value::jsonb->>'status'=$2)
         ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
        [input.kind ?? null, input.status ?? null, limit, offset],
      ),
      this.pool.query<{ new: number; reviewed: number; resolved: number; filtered_total: number }>(
        `SELECT
           count(*) FILTER (WHERE value::jsonb->>'status'='new')::int new,
           count(*) FILTER (WHERE value::jsonb->>'status'='reviewed')::int reviewed,
           count(*) FILTER (WHERE value::jsonb->>'status'='resolved')::int resolved,
           count(*) FILTER (WHERE ($1::text IS NULL OR value::jsonb->>'kind'=$1)
                              AND ($2::text IS NULL OR value::jsonb->>'status'=$2))::int filtered_total
         FROM settings WHERE key LIKE 'feedback-submission:%'`,
        [input.kind ?? null, input.status ?? null],
      ),
    ]);
    const items = result.rows.flatMap((row) => {
      try {
        return [feedbackListItem(JSON.parse(row.value) as FeedbackSubmissionRecord)];
      } catch {
        return [];
      }
    });
    const counts = summary.rows[0] ?? { new: 0, reviewed: 0, resolved: 0 };
    return {
      items,
      total: result.rows[0]?.total ?? Number(counts.filtered_total ?? 0),
      counts: {
        new: Number(counts.new ?? 0),
        reviewed: Number(counts.reviewed ?? 0),
        resolved: Number(counts.resolved ?? 0),
      },
    };
  }

  async getFeedbackImage(id: string): Promise<{ mimeType: "image/png" | "image/jpeg"; data: Buffer } | null> {
    const result = await this.pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key=$1",
      [`${FEEDBACK_SUBMISSION_PREFIX}${id}`],
    );
    if (!result.rows[0]) return null;
    try {
      const record = JSON.parse(result.rows[0].value) as FeedbackSubmissionRecord;
      if (!record.image || !["image/png", "image/jpeg"].includes(record.image.mimeType)) return null;
      const data = Buffer.from(record.image.dataBase64, "base64");
      if (data.length !== record.image.byteSize || sha256Hex(data) !== record.image.sha256) return null;
      return { mimeType: record.image.mimeType, data };
    } catch {
      return null;
    }
  }

  async updateFeedbackStatus(id: string, status: FeedbackStatus, actor: string): Promise<FeedbackListItem> {
    return this.transaction(async (client) => {
      const result = await client.query<{ value: string }>(
        "SELECT value FROM settings WHERE key=$1 FOR UPDATE",
        [`${FEEDBACK_SUBMISSION_PREFIX}${id}`],
      );
      if (!result.rows[0]) throw new HttpError(404, "Feedback was not found", "feedback_not_found");
      let record: FeedbackSubmissionRecord;
      try {
        record = JSON.parse(result.rows[0].value) as FeedbackSubmissionRecord;
      } catch {
        throw new HttpError(500, "Feedback record is invalid", "feedback_record_invalid");
      }
      record = { ...record, status, updatedAt: new Date().toISOString() };
      await client.query(
        "UPDATE settings SET value=$2,updated_at=now() WHERE key=$1",
        [`${FEEDBACK_SUBMISSION_PREFIX}${id}`, JSON.stringify(record)],
      );
      await client.query(
        "INSERT INTO audit_events(actor,action,detail_json) VALUES($1,'feedback.status_changed',$2)",
        [actor.slice(0, 80), { feedbackId: id, status }],
      );
      return feedbackListItem(record);
    });
  }

  async deleteFeedbackSubmission(id: string, actor: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const reportKey = `${FEEDBACK_SUBMISSION_PREFIX}${id}`;
      const preview = await client.query<{ value: string }>(
        "SELECT value FROM settings WHERE key=$1",
        [reportKey],
      );
      if (!preview.rows[0]) return false;
      let previewRecord: FeedbackSubmissionRecord | null = null;
      try {
        previewRecord = JSON.parse(preview.rows[0].value) as FeedbackSubmissionRecord;
      } catch {
        // A malformed private record remains deletable, but cannot create a
        // suppression key because it has no trustworthy fingerprint.
      }
      const fingerprint = previewRecord?.origin === "automatic_failure"
        ? previewRecord.automaticFailure?.eventFingerprint?.trim() || null
        : null;
      const mappingKey = fingerprint ? `${FEEDBACK_AUTOMATIC_EVENT_PREFIX}${fingerprint}` : null;
      if (mappingKey) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [mappingKey]);
      const locked = await client.query<{ value: string }>(
        "SELECT value FROM settings WHERE key=$1 FOR UPDATE",
        [reportKey],
      );
      if (!locked.rows[0]) return false;
      let record = previewRecord;
      try {
        record = JSON.parse(locked.rows[0].value) as FeedbackSubmissionRecord;
      } catch {
        record = null;
      }
      await client.query("DELETE FROM settings WHERE key=$1", [reportKey]);
      if (mappingKey && record?.origin === "automatic_failure" && record.automaticFailure) {
        await client.query(
          `INSERT INTO settings(key,value) VALUES($1,$2)
           ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
          [mappingKey, JSON.stringify({
            id,
            eventFingerprint: fingerprint,
            runId: record.automaticFailure.runId,
            runAccessId: record.automaticFailure.runAccessId,
            briefRequestId: record.automaticFailure.briefRequestId,
            terminalGeneration: record.automaticFailure.terminalGeneration,
            suppressed: true,
            deletedAt: new Date().toISOString(),
          })],
        );
        await client.query(
          `DELETE FROM settings
           WHERE key LIKE 'feedback-idempotency:%' AND value::jsonb->>'id'=$1`,
          [id],
        );
      } else {
        await client.query(
          `DELETE FROM settings
           WHERE (key LIKE 'feedback-idempotency:%' OR key LIKE 'feedback-automatic-event:%')
             AND value::jsonb->>'id'=$1`,
          [id],
        );
      }
      await client.query(
        "INSERT INTO audit_events(actor,action,detail_json) VALUES($1,'feedback.deleted',$2)",
        [actor.slice(0, 80), { feedbackId: id }],
      );
      return true;
    });
  }

  async createBriefRequest(input: {
    prompt: string;
    requestedTrackCount?: number | null;
    model: string;
    clientBucket: string;
    clientBucketAliases: string[];
    idempotencyKey?: string | null;
    briefContractVersion?: 1 | 2 | 3;
    releaseCanary?: UnsignedReleaseCanaryMetadata | null;
    /** Set only after authenticated owner + activated-schema admission. */
    allowExecutableTrackCount?: boolean;
  }): Promise<{ id: string; status: string; created: boolean }> {
    const prompt = input.prompt.trim();
    if (prompt.length < 4 || prompt.length > 2_000) throw new HttpError(400, "Describe the playlist in 4–2,000 characters", "invalid_prompt");
    const requestedTrackCount = input.requestedTrackCount ?? null;
    const maximumTrackCount = input.allowExecutableTrackCount === true
      ? EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS
      : PUBLIC_PLAYLIST_MAXIMUM_TRACKS;
    const briefContractVersion = input.briefContractVersion === 3
      ? 3
      : input.briefContractVersion === 2
        ? 2
        : 1;
    const expandedTrackCount = requestedTrackCount !== null
      && Number.isSafeInteger(requestedTrackCount)
      && requestedTrackCount > PUBLIC_PLAYLIST_MAXIMUM_TRACKS;
    if (requestedTrackCount !== null && (
      !Number.isInteger(requestedTrackCount)
      || requestedTrackCount < PUBLIC_PLAYLIST_MINIMUM_TRACKS
      || requestedTrackCount > maximumTrackCount
    )) {
      throw new HttpError(
        400,
        `Track count must be an integer from ${PUBLIC_PLAYLIST_MINIMUM_TRACKS} to ${maximumTrackCount}`,
        "invalid_track_count",
      );
    }
    if (expandedTrackCount && briefContractVersion !== 3) {
      throw new HttpError(
        409,
        "Playlist sizes above 300 require a canonical contract-3 brief",
        "expanded_track_count_contract_required",
      );
    }
    if (expandedTrackCount && Number(await this.getSchemaVersion() ?? 0) < 18) {
      throw new HttpError(
        503,
        "Playlist sizes above 300 are paused until schema 18 is active",
        "expanded_track_count_activation_not_ready",
      );
    }
    return this.transaction(async (client) => {
      if (input.idempotencyKey) {
        await lockClientAliases(client, `brief:${input.idempotencyKey}`, input.clientBucketAliases);
        const existing = await client.query<{ id: string; status: string; prompt: string; requested_track_count: number | null; brief_contract_version: number }>(
          "SELECT id,status,prompt,requested_track_count,brief_contract_version FROM brief_requests WHERE client_bucket = ANY($1::text[]) AND idempotency_key = $2 AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
          [input.clientBucketAliases, input.idempotencyKey],
        );
        if (existing.rows[0]) {
          const prior = existing.rows[0];
          const priorTrackCount = prior.requested_track_count == null ? null : Number(prior.requested_track_count);
          if (prior.prompt !== prompt || priorTrackCount !== requestedTrackCount
            || Number(prior.brief_contract_version) !== briefContractVersion) {
            throw new HttpError(409, "Idempotency key was already used for a different playlist request", "idempotency_conflict");
          }
          await persistReleaseCanaryMarker(
            client,
            input.releaseCanary,
            { operation: "brief", id: prior.id },
          );
          return { id: prior.id, status: prior.status, created: false };
        }
      }
      const id = randomUUID();
      await client.query(
        `INSERT INTO brief_requests(id,prompt,requested_track_count,model,status,client_bucket,idempotency_key,
           brief_contract_version,expires_at)
         VALUES($1,$2,$3,$4,'queued',$5,$6,$7,now()+interval '24 hours')`,
        [id, prompt, requestedTrackCount, input.model, input.clientBucket, input.idempotencyKey ?? null, briefContractVersion],
      );
      await persistReleaseCanaryMarker(
        client,
        input.releaseCanary,
        { operation: "brief", id },
      );
      return { id, status: "queued", created: true };
    });
  }

  async getBriefRequest(id: string): Promise<any | null> {
    const result = await this.pool.query(
      `SELECT id,prompt,requested_track_count,model,status,brief_json,questions_json,answers_json,
              guidance_source_hints_json,guidance_telemetry_json,guidance_preferences_json,
              brief_contract_version,active_guidance_question_set_id,
              (SELECT question_set_hash FROM guidance_question_sets
               WHERE id=brief_requests.active_guidance_question_set_id) question_set_hash,
              pipeline_version,policy_version,selection_plan_json,
              estimate_usd,error,client_bucket,expires_at,created_at,updated_at
       FROM brief_requests WHERE id=$1 AND expires_at>now()`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      prompt: row.prompt,
      requestedTrackCount: row.requested_track_count == null ? null : Number(row.requested_track_count),
      model: row.model,
      status: row.status,
      brief: row.brief_json,
      questions: row.questions_json ?? [],
      answers: row.answers_json ?? [],
      guidanceSourceHints: row.guidance_source_hints_json ?? [],
      guidanceTelemetry: row.guidance_telemetry_json ?? null,
      guidancePreferences: row.guidance_preferences_json ?? [],
      briefContractVersion: Number(row.brief_contract_version ?? 1) === 3
        ? 3
        : Number(row.brief_contract_version ?? 1) === 2
          ? 2
          : 1,
      questionSetHash: typeof row.question_set_hash === "string" ? row.question_set_hash : null,
      pipelineVersion: row.pipeline_version ?? "legacy_v1",
      policyVersion: row.policy_version ?? "legacy_v1",
      selectionPlan: row.selection_plan_json ?? null,
      estimateUsd: row.estimate_usd == null ? null : Number(row.estimate_usd),
      error: sanitizeOptionalFailure(row.error, "brief"),
      clientBucket: row.client_bucket,
      expiresAt: date(row.expires_at),
      createdAt: date(row.created_at),
      updatedAt: date(row.updated_at),
    };
  }

  async getBriefActualCostUsd(id: string): Promise<number> {
    const result = await this.pool.query<{ actual: number }>(
      `SELECT COALESCE(sum(amount_usd),0)::float8 actual
       FROM cost_ledger
       WHERE brief_request_id=$1
         AND operation NOT LIKE 'brief.question_scout%'
         AND operation NOT LIKE 'brief.scout%'`,
      [id],
    );
    return Number(result.rows[0]?.actual ?? 0);
  }

  async deleteBriefRequest(id: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const selected = await client.query(
        "SELECT 1 FROM brief_requests WHERE id=$1 FOR UPDATE",
        [id],
      );
      if (!selected.rows[0]) return false;
      const activeReservations = await client.query<{ count: number }>(
        `SELECT count(*)::int count
         FROM cost_reservations
         WHERE brief_request_id=$1 AND status='reserved'`,
        [id],
      );
      if ((activeReservations.rows[0]?.count ?? 0) > 0) {
        // The provider call may already be billable. Scrub visitor content and
        // revoke access immediately, but retain only the opaque brief row until
        // reconciliation can write the aggregate charge. A late worker result
        // cannot restore content because saveBriefResult requires live expiry.
        await client.query("DELETE FROM guidance_answer_sets WHERE brief_request_id=$1", [id]);
        await client.query("DELETE FROM guidance_question_sets WHERE brief_request_id=$1", [id]);
        await client.query(
          `UPDATE brief_requests SET prompt='',status='failed',brief_json=NULL,
             questions_json=NULL,answers_json=NULL,answers_idempotency_key=NULL,
             answers_hash=NULL,guidance_source_hints_json='[]'::jsonb,
             guidance_telemetry_json=NULL,guidance_preferences_json='[]'::jsonb,
             estimate_usd=NULL,error=NULL,expires_at=now(),updated_at=now()
           WHERE id=$1`,
          [id],
        );
        await this.deleteAutomaticFailureFeedbackForSource(client, { briefRequestId: id });
        await client.query("DELETE FROM capability_session_briefs WHERE brief_request_id=$1", [id]);
        await client.query(
          `UPDATE job_queue SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,
             last_error=NULL,completed_at=now(),updated_at=now()
           WHERE brief_request_id=$1 AND status IN ('queued','leased')`,
          [id],
        );
        return true;
      }
      // Preserve only aggregate billing amounts so visitor deletion cannot
      // reset application spend accounting. The brief FK and request-specific
      // usage detail are removed.
      await client.query(
        "UPDATE cost_ledger SET brief_request_id=NULL,usage_json=NULL WHERE brief_request_id=$1",
        [id],
      );
      await this.deleteAutomaticFailureFeedbackForSource(client, { briefRequestId: id });
      await client.query("DELETE FROM brief_requests WHERE id=$1", [id]);
      return true;
    });
  }

  async saveBriefResult(id: string, result: {
    status: "awaiting_answers" | "complete" | "failed";
    expectedStatus?: "queued" | "finalizing";
    brief?: PlaylistBrief;
    questions?: PlaylistGuidanceQuestion[];
    guidanceSourceHints?: PlaylistGuidanceSourceHint[];
    guidanceTelemetry?: PlaylistGuidanceTelemetry | null;
    guidanceContract?: PlaylistGuidanceQuestionSetContract;
    estimateUsd?: number;
    error?: string | null;
  }): Promise<void> {
    const persistedError = result.status === "failed"
      ? sanitizeFailure(result.error, "brief")
      : null;
    const saved = await this.transaction(async (client) => {
      const updated = await client.query<{
        brief_contract_version: number;
        active_playlist_contract_revision_id: string | null;
      }>(
        `UPDATE brief_requests SET status=$2,brief_json=$3,questions_json=COALESCE($4,questions_json),
                guidance_source_hints_json=COALESCE($5,guidance_source_hints_json),
                guidance_telemetry_json=CASE WHEN $6::boolean THEN $7 ELSE guidance_telemetry_json END,
                estimate_usd=$8,error=$9,updated_at=now()
         WHERE id=$1 AND expires_at>now() AND ($10::varchar IS NULL OR status=$10::varchar)
         RETURNING brief_contract_version,active_playlist_contract_revision_id`,
        [
          id,
          result.status,
          result.brief ?? null,
          result.questions === undefined ? null : JSON.stringify(result.questions),
          result.guidanceSourceHints === undefined ? null : JSON.stringify(result.guidanceSourceHints),
          result.guidanceTelemetry !== undefined,
          result.guidanceTelemetry === undefined ? null : JSON.stringify(result.guidanceTelemetry),
          result.estimateUsd == null ? null : finiteMoney(result.estimateUsd, "Estimate"),
          persistedError,
          result.expectedStatus ?? null,
        ],
      );
      if (!updated.rows[0] || !result.guidanceContract) return updated.rowCount ?? 0;
      const briefContractVersion = Number(updated.rows[0].brief_contract_version);
      if ((briefContractVersion !== 2 && briefContractVersion !== 3)
        || !Array.isArray(result.questions)) {
        throw new Error("A guidance question-set contract requires a contract-2/3 brief and questions");
      }
      if (briefContractVersion === 3 && (
        !updated.rows[0].active_playlist_contract_revision_id
        || !result.guidanceContract.baseContractRevisionId
        || !result.guidanceContract.baseContractSemanticHash
      )) {
        throw new Error("Contract-3 guidance requires an active canonical contract revision");
      }
      await client.query(
        "UPDATE guidance_question_sets SET active=false WHERE brief_request_id=$1 AND active",
        [id],
      );
      const revision = await client.query<{ revision: number }>(
        "SELECT COALESCE(max(revision),0)+1 AS revision FROM guidance_question_sets WHERE brief_request_id=$1",
        [id],
      );
      const questionSetId = randomUUID();
      await client.query(
         `INSERT INTO guidance_question_sets(
           id,brief_request_id,revision,question_set_hash,request_classification,generation_mode,
           guidance_policy_version,locale,storefront,target_track_count,explicit_constraint_hash,
           rejected_question_reasons_json,questions_json,active,base_contract_revision_id,
           feasibility_snapshot_id,guidance_round,trigger,axis)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,true,
                $14,$15,$16,$17,$18)`,
        [
          questionSetId,
          id,
          Number(revision.rows[0]?.revision ?? 1),
          result.guidanceContract.questionSetHash,
          result.guidanceContract.requestClassification,
          result.guidanceContract.generationMode,
          result.guidanceContract.guidancePolicyVersion,
          result.guidanceContract.locale,
          result.guidanceContract.storefront,
          result.guidanceContract.targetTrackCount,
          result.guidanceContract.explicitConstraintHash,
          JSON.stringify(result.guidanceContract.rejectedQuestionReasons),
          JSON.stringify(result.questions),
          briefContractVersion === 3
            ? updated.rows[0].active_playlist_contract_revision_id
            : null,
          result.guidanceContract.feasibilitySnapshotId ?? null,
          result.guidanceContract.guidanceRound ?? "initial",
          result.guidanceContract.trigger ?? "nuance",
          result.guidanceContract.axis ?? null,
        ],
      );
      await client.query(
        "UPDATE brief_requests SET active_guidance_question_set_id=$2 WHERE id=$1",
        [id, questionSetId],
      );
      return updated.rowCount ?? 0;
    });
    if (saved > 0 && result.status === "failed") {
      await this.captureAutomaticBriefFailureSafely(id);
    }
  }

  async saveBriefSelectionPlan(id: string, plan: SelectionPlan): Promise<void> {
    const result = await this.pool.query(
      `UPDATE brief_requests SET pipeline_version=$2,policy_version=$3,
         selection_plan_json=$4,updated_at=now()
       WHERE id=$1 AND expires_at>now()`,
      [id, plan.pipelineVersion, plan.policyVersion, JSON.stringify(plan)],
    );
    if (result.rowCount === 0) throw new HttpError(404, "Brief request not found", "brief_not_found");
  }

  async submitBriefAnswers(input: {
    briefRequestId: string;
    idempotencyKey: string;
    questionSetHash?: string;
    answers: PlaylistGuidanceAnswer[];
  }): Promise<
    | {
        status: "awaiting_answers";
        created: true;
        questionSetHash: string;
        questions: PlaylistGuidanceQuestion[];
      }
    | { status: "finalizing" | "complete"; created: boolean }
    | { status: "stale_question_set"; created: false; questionSetHash: string; questions: PlaylistGuidanceQuestion[] }
  > {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`brief-answers:${input.briefRequestId}`]);
      const selected = await client.query<{
        status: string;
        questions_json: PlaylistGuidanceQuestion[] | null;
        answers_idempotency_key: string | null;
        answers_hash: string | null;
        brief_contract_version: number;
        active_guidance_question_set_id: string | null;
        question_set_hash: string | null;
        contract_questions_json: PlaylistGuidanceQuestion[] | null;
        active_playlist_contract_revision_id: string | null;
        playlist_contract_json: PlaylistContractRevisionV1 | null;
      }>(
        `SELECT brief.status,brief.questions_json,brief.answers_idempotency_key,brief.answers_hash,
                brief.brief_contract_version,brief.active_guidance_question_set_id,
                question_set.question_set_hash,question_set.questions_json contract_questions_json,
                brief.active_playlist_contract_revision_id,
                playlist_contract.contract_json playlist_contract_json
         FROM brief_requests brief
         LEFT JOIN guidance_question_sets question_set
           ON question_set.id=brief.active_guidance_question_set_id AND question_set.active
         LEFT JOIN playlist_contract_revisions playlist_contract
           ON playlist_contract.id=brief.active_playlist_contract_revision_id
             AND playlist_contract.status='active'
         WHERE brief.id=$1 AND brief.expires_at>now()
         FOR UPDATE OF brief`,
        [input.briefRequestId],
      );
      const brief = selected.rows[0];
      if (!brief) throw new HttpError(404, "Brief request not found", "brief_not_found");
      const contractVersion = Number(brief.brief_contract_version) === 3
        ? 3
        : Number(brief.brief_contract_version) === 2
          ? 2
          : 1;
      const questions = contractVersion >= 2 && Array.isArray(brief.contract_questions_json)
        ? brief.contract_questions_json
        : Array.isArray(brief.questions_json) ? brief.questions_json : [];
      if (contractVersion >= 2) {
        if (!brief.question_set_hash || input.questionSetHash !== brief.question_set_hash) {
          return {
            status: "stale_question_set",
            created: false,
            questionSetHash: brief.question_set_hash ?? "",
            questions,
          };
        }
      }
      const answers = normalizedGuidanceAnswers(questions, input.answers, contractVersion);
      const guidancePreferences = deriveGuidancePreferences(questions, answers);
      const answersHash = sha256Hex(stableStringify({
        questionSetHash: contractVersion >= 2 ? brief.question_set_hash : null,
        answers,
      }));
      if (brief.answers_idempotency_key !== null) {
        if (brief.answers_idempotency_key !== input.idempotencyKey || brief.answers_hash !== answersHash) {
          throw new HttpError(
            409,
            "Idempotency key was already used for different playlist answers",
            "idempotency_conflict",
          );
        }
        if (brief.status !== "finalizing" && brief.status !== "complete") {
          throw new HttpError(409, "Playlist answers cannot be submitted in this state", "brief_not_ready");
        }
        return { status: brief.status, created: false };
      }
      if (brief.status !== "awaiting_answers") {
        throw new HttpError(409, "Playlist questions are not ready for answers", "brief_not_ready");
      }
      if (contractVersion === 2) {
        if (!brief.active_guidance_question_set_id || !brief.question_set_hash) {
          throw new HttpError(409, "Playlist guidance contract is incomplete", "guidance_contract_incomplete");
        }
        const execution = compileGuidanceExecutionDeltaV2(questions, answers);
        await client.query(
          `INSERT INTO guidance_answer_sets(
             id,brief_request_id,question_set_id,question_set_hash,normalized_answers_json,
             raw_custom_answers_json,answer_hash,execution_delta_json,execution_delta_hash,idempotency_key)
           VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9,$10)`,
          [
            randomUUID(),
            input.briefRequestId,
            brief.active_guidance_question_set_id,
            brief.question_set_hash,
            JSON.stringify(answers),
            JSON.stringify(answers.flatMap((answer) => answer.customText
              ? [{ questionId: answer.questionId, customText: answer.customText }]
              : [])),
            answersHash,
            JSON.stringify(execution.delta),
            execution.hash,
            input.idempotencyKey,
          ],
        );
      } else if (contractVersion === 3) {
        if (!brief.active_guidance_question_set_id
          || !brief.question_set_hash
          || !brief.active_playlist_contract_revision_id
          || !brief.playlist_contract_json) {
          throw new HttpError(409, "Playlist guidance contract is incomplete", "guidance_contract_incomplete");
        }
        const baseContract = brief.playlist_contract_json;
        assertPlaylistContractIntegrityV1(baseContract);
        const customAnswers = answers.filter((answer) => Boolean(answer.customText));
        if (customAnswers.length > 0) {
          if (customAnswers.length !== 1) {
            throw new HttpError(
              400,
              "Review one custom playlist change at a time",
              "custom_guidance_one_axis_required",
            );
          }
          let confirmation;
          try {
            const compiled = recompileCustomGuidanceTextV3({
              base: baseContract,
              customText: customAnswers[0]!.customText!,
            });
            confirmation = customGuidanceConfirmationDecisionV3({
              base: baseContract,
              compiled,
            });
          } catch (error) {
            const reason = error instanceof Error ? error.message : "";
            if (reason
              === "custom_guidance_conflicts_with_existing_hard_predicate") {
              throw new HttpError(
                409,
                "That custom answer conflicts with an existing required playlist rule. Review the interpretation before changing either rule.",
                "custom_guidance_conflicts_with_existing_hard_predicate",
              );
            }
            throw new HttpError(
              400,
              reason === "custom_guidance_requires_supported_music_terms"
                ? "That custom answer needs a clearer music rule. Edit the interpretation or choose one of the provided options."
                : "That custom answer could not be compiled safely",
              "custom_guidance_not_compilable",
            );
          }
          const confirmationRound = selectGuidanceRoundV3({
            stage: "initial",
            requestShape: "curated",
            candidates: [confirmation],
          });
          const confirmationQuestions = confirmationRound.decisions.map(publicGuidanceQuestionV3);
          if (confirmationQuestions.length !== 1) {
            throw new HttpError(
              409,
              "The custom interpretation could not be confirmed",
              "custom_guidance_confirmation_unavailable",
            );
          }
          await client.query(
            "UPDATE guidance_question_sets SET active=false WHERE id=$1 AND active",
            [brief.active_guidance_question_set_id],
          );
          const nextQuestionSetRevision = await client.query<{ revision: number }>(
            "SELECT COALESCE(max(revision),0)+1 revision FROM guidance_question_sets WHERE brief_request_id=$1",
            [input.briefRequestId],
          );
          const nextQuestionSetId = randomUUID();
          const inserted = await client.query(
            `INSERT INTO guidance_question_sets(
               id,brief_request_id,revision,question_set_hash,request_classification,
               generation_mode,guidance_policy_version,locale,storefront,target_track_count,
               explicit_constraint_hash,rejected_question_reasons_json,questions_json,active,
               base_contract_revision_id,parent_question_set_id,feasibility_snapshot_id,
               guidance_round,trigger,axis)
             SELECT $2,brief_request_id,$3,$4,request_classification,'deterministic_critical',
                    guidance_policy_version,locale,storefront,target_track_count,
                    explicit_constraint_hash,'[]'::jsonb,$5::jsonb,true,
                    base_contract_revision_id,id,feasibility_snapshot_id,
                    guidance_round,'correctness','custom_contract_revision'
             FROM guidance_question_sets
             WHERE id=$1 AND brief_request_id=$6
             RETURNING id`,
            [
              brief.active_guidance_question_set_id,
              nextQuestionSetId,
              Number(nextQuestionSetRevision.rows[0]?.revision ?? 1),
              confirmationRound.roundHash,
              JSON.stringify(confirmationQuestions),
              input.briefRequestId,
            ],
          );
          if (!inserted.rows[0]) {
            throw new HttpError(
              409,
              "The custom interpretation changed while it was being compiled",
              "stale_guidance_question_set",
            );
          }
          await client.query(
            `UPDATE brief_requests
             SET active_guidance_question_set_id=$2,questions_json=$3::jsonb,
                 guidance_telemetry_json=COALESCE(guidance_telemetry_json,'{}'::jsonb)
                   || jsonb_build_object(
                        'questionSetHash',$4::text,
                        'generationMode','deterministic_critical',
                        'guidancePolicyVersion','adaptive_guidance_v3',
                        'proposedQuestionCount',1,
                        'acceptedQuestionCount',1
                      ),
                 status='awaiting_answers',updated_at=now()
             WHERE id=$1 AND active_playlist_contract_revision_id=$5`,
            [
              input.briefRequestId,
              nextQuestionSetId,
              JSON.stringify(confirmationQuestions),
              confirmationRound.roundHash,
              brief.active_playlist_contract_revision_id,
            ],
          );
          return {
            status: "awaiting_answers",
            created: true,
            questionSetHash: confirmationRound.roundHash,
            questions: confirmationQuestions,
          };
        }
        let patch;
        try {
          patch = compileGuidanceRoundPatchV3({
            base: baseContract,
            questionSetHash: brief.question_set_hash,
            questions,
            answers,
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : "";
          if (reason === "custom_contract3_answer_requires_recompile") {
            throw new HttpError(
              409,
              "Review the revised interpretation before confirming this custom answer",
              "custom_guidance_confirmation_required",
            );
          }
          throw new HttpError(409, "Playlist guidance is stale or invalid", "stale_guidance_question_set");
        }
        const nextContract = patch
          ? applyPlaylistContractPatchV1(baseContract, patch)
          : baseContract;
        const executionDelta = patch?.operations ?? [];
        const executionDeltaHash = sha256Hex(stableStringify(executionDelta));
        const answerSetId = randomUUID();
        await client.query(
          `INSERT INTO guidance_answer_sets(
             id,brief_request_id,question_set_id,question_set_hash,normalized_answers_json,
             raw_custom_answers_json,answer_hash,execution_delta_json,execution_delta_hash,
             idempotency_key,base_contract_revision_id,resulting_contract_revision_id)
           VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9,$10,$11,$12)`,
          [
            answerSetId,
            input.briefRequestId,
            brief.active_guidance_question_set_id,
            brief.question_set_hash,
            JSON.stringify(answers),
            JSON.stringify([]),
            answersHash,
            JSON.stringify(executionDelta),
            executionDeltaHash,
            input.idempotencyKey,
            brief.active_playlist_contract_revision_id,
            patch ? null : brief.active_playlist_contract_revision_id,
          ],
        );
        if (patch) {
          const revision = await client.query<{ revision: number }>(
            `SELECT COALESCE(max(revision),0)+1 revision
             FROM playlist_contract_revisions WHERE brief_request_id=$1`,
            [input.briefRequestId],
          );
          const nextId = randomUUID();
          await client.query(
            `INSERT INTO playlist_contract_revisions(
               id,brief_request_id,revision,parent_revision_id,status,contract_hash,
               contract_json,compiler_version,ontology_version,evidence_policy_version,
               question_template_version,catalog_policy_version,locale,storefront,
               answer_lineage_hash)
             VALUES($1,$2,$3,$4,'active',$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              nextId,
              input.briefRequestId,
              Number(revision.rows[0]?.revision ?? 1),
              brief.active_playlist_contract_revision_id,
              nextContract.semanticHash,
              JSON.stringify(nextContract),
              nextContract.versions.compiler,
              nextContract.versions.ontology,
              nextContract.versions.evidencePolicy,
              nextContract.versions.questionTemplates,
              nextContract.versions.catalogPolicy,
              nextContract.locale,
              nextContract.storefront,
              sha256Hex(stableStringify(nextContract.answerLineage)),
            ],
          );
          await client.query(
            "UPDATE playlist_contract_revisions SET status='superseded' WHERE id=$1 AND status='active'",
            [brief.active_playlist_contract_revision_id],
          );
          await client.query(
            `UPDATE playlist_feasibility_snapshots SET invalidated_at=now()
             WHERE contract_revision_id=$1 AND invalidated_at IS NULL`,
            [brief.active_playlist_contract_revision_id],
          );
          await client.query(
            `UPDATE guidance_answer_sets SET resulting_contract_revision_id=$2
             WHERE id=$1 AND resulting_contract_revision_id IS NULL`,
            [answerSetId, nextId],
          );
          await client.query(
            `UPDATE brief_requests SET active_playlist_contract_revision_id=$2
             WHERE id=$1`,
            [input.briefRequestId, nextId],
          );
        }
      }
      await client.query(
        `UPDATE brief_requests SET status='finalizing',answers_json=$2,
             guidance_preferences_json=$3,answers_idempotency_key=$4,answers_hash=$5,
             error=NULL,updated_at=now()
         WHERE id=$1`,
        [input.briefRequestId, JSON.stringify(answers), JSON.stringify(guidancePreferences), input.idempotencyKey, answersHash],
      );
      return { status: "finalizing", created: true };
    });
  }

  private async attachCapabilitySessionAccess(
    client: PoolClient,
    sessionId: string,
    runId: string,
    accessId: string,
  ): Promise<void> {
    const attached = await client.query(
      `INSERT INTO capability_session_accesses(session_id,run_id,access_id)
       SELECT s.id,a.run_id,a.id
       FROM capability_sessions s
       JOIN run_accesses a ON a.id=$3 AND a.run_id=$2
       JOIN research_runs r ON r.id=a.run_id AND r.deleted_at IS NULL
       WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
         AND a.deleted_at IS NULL AND a.expires_at>now()
       ON CONFLICT(session_id,access_id) DO UPDATE SET run_id=EXCLUDED.run_id
       RETURNING access_id`,
      [sessionId, runId, accessId],
    );
    if (!attached.rows[0]) {
      throw new HttpError(401, "Session has expired", "capability_required");
    }
  }

  async createRunIdempotent(input: {
    prompt: string;
    briefRequestId?: string | null;
    brief: PlaylistBrief;
    estimateUsd: number;
    approvedBudgetUsd: number;
    clientBucket: string;
    clientBucketAliases: string[];
    idempotencyKey: string;
    autoPublish?: boolean;
    reuseDays?: number;
    globalLimit?: number;
    capabilitySessionId?: string;
    forceFreshResearch?: boolean;
    releaseCanary?: UnsignedReleaseCanaryMetadata | null;
  }): Promise<{ runId: string; accessId: string; created: boolean; reused: boolean; status: string }> {
    const estimate = finiteMoney(input.estimateUsd, "Estimate");
    const approved = finiteMoney(input.approvedBudgetUsd, "Approved budget");
    let guidanceSourceHints: PlaylistGuidanceSourceHint[] = [];
    let guidanceTelemetry: PlaylistGuidanceTelemetry | null = null;
    let guidancePreferences: PlaylistGuidancePreference[] = [];
    let guidanceAnswers: PlaylistGuidanceAnswer[] = [];
    let briefRequestedTrackCount: number | null = null;
    let selectionPlan: SelectionPlan | null = null;
    let briefContractVersion: 1 | 2 | 3 = 1;
    let activePlaylistContractDatabaseId: string | null = null;
    let activePlaylistContract: PlaylistContractRevisionV1 | null = null;
    let guidanceExecutionDeltaHash = compileGuidanceExecutionDeltaV2([], []).hash;
    let repairedStoredSelectionPlan = false;
    if (input.briefRequestId) {
      const context = await this.pool.query<{
        guidance_source_hints_json: PlaylistGuidanceSourceHint[] | null;
        guidance_telemetry_json: PlaylistGuidanceTelemetry | null;
        guidance_preferences_json: PlaylistGuidancePreference[] | null;
        answers_json: PlaylistGuidanceAnswer[] | null;
        selection_plan_json: SelectionPlan | null;
        requested_track_count: number | null;
        brief_contract_version: number;
        execution_delta_hash: string | null;
        active_playlist_contract_revision_id: string | null;
        playlist_contract_json: PlaylistContractRevisionV1 | null;
      }>(
        `SELECT guidance_source_hints_json,guidance_telemetry_json,guidance_preferences_json,
           answers_json,selection_plan_json,requested_track_count,brief_contract_version,
           (SELECT execution_delta_hash FROM guidance_answer_sets
            WHERE brief_request_id=brief_requests.id ORDER BY accepted_at DESC LIMIT 1) execution_delta_hash,
           active_playlist_contract_revision_id,
           (SELECT contract_json FROM playlist_contract_revisions
            WHERE id=brief_requests.active_playlist_contract_revision_id
              AND status='active') playlist_contract_json
         FROM brief_requests WHERE id=$1 AND expires_at>now()`,
        [input.briefRequestId],
      );
      const row = context.rows[0];
      if (!row) throw new HttpError(404, "Brief request not found", "brief_not_found");
      guidanceSourceHints = Array.isArray(row.guidance_source_hints_json)
        ? row.guidance_source_hints_json
        : [];
      guidanceTelemetry = row.guidance_telemetry_json ?? null;
      guidancePreferences = Array.isArray(row.guidance_preferences_json)
        ? row.guidance_preferences_json
        : [];
      guidanceAnswers = Array.isArray(row.answers_json) ? row.answers_json : [];
      selectionPlan = row.selection_plan_json ?? null;
      briefRequestedTrackCount = row.requested_track_count == null
        ? null
        : Number(row.requested_track_count);
      briefContractVersion = Number(row.brief_contract_version) === 3
        ? 3
        : Number(row.brief_contract_version) === 2
          ? 2
          : 1;
      if (briefContractVersion === 2 && typeof row.execution_delta_hash === "string") {
        guidanceExecutionDeltaHash = row.execution_delta_hash;
      }
      activePlaylistContractDatabaseId = row.active_playlist_contract_revision_id;
      activePlaylistContract = row.playlist_contract_json;
      if (briefContractVersion === 3) {
        if (!activePlaylistContractDatabaseId || !activePlaylistContract) {
          throw new HttpError(
            409,
            "The canonical playlist interpretation is not ready",
            "playlist_contract_not_ready",
          );
        }
        assertPlaylistContractIntegrityV1(activePlaylistContract);
      }
    }
    const exactRequestedTrackCount = (() => {
      if (Number.isInteger(briefRequestedTrackCount)
        && Number(briefRequestedTrackCount) >= PUBLIC_PLAYLIST_MINIMUM_TRACKS
        && Number(briefRequestedTrackCount) <= EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS) {
        return Number(briefRequestedTrackCount);
      }
      const minimum = Number(input.brief.targetSize?.min);
      const maximum = Number(input.brief.targetSize?.max);
      return input.brief.targetSize
        && Number.isInteger(minimum)
        && Number.isInteger(maximum)
        && minimum === maximum
        && minimum >= PUBLIC_PLAYLIST_MINIMUM_TRACKS
        && minimum <= EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS
          ? minimum
          : null;
    })();
    // Rebuild a stale typed plan before constructing V3. The immutable V3
    // request consumes this confirmed parser output so geographic, language,
    // era, inclusion, exclusion, subject, and relationship axes survive the
    // compatibility bridge without changing the authoritative count.
    if (selectionPlan && exactRequestedTrackCount !== null && (
      selectionPlan.requestedTrackCount !== exactRequestedTrackCount
      || selectionPlan.minimumQualifiedTrackCount !== exactRequestedTrackCount
    )) {
      selectionPlan = null;
      repairedStoredSelectionPlan = true;
    }
    if (briefContractVersion === 3 && !selectionPlan) {
      throw new HttpError(
        409,
        "The canonical playlist contract is missing its typed execution base",
        "playlist_contract_execution_plan_missing",
      );
    }
    const baseSelectionPlan = selectionPlan ?? createSelectionPlanV2({
      prompt: input.prompt,
      brief: input.brief,
      guidancePreferences,
      storefront: process.env.APPLE_STOREFRONT ?? "us",
    });
    const contractCapabilityDecision = briefContractVersion === 3 && activePlaylistContract
      ? canonicalCapabilityDecision(activePlaylistContract)
      : null;
    const contractExecutionProjection = briefContractVersion === 3
      && activePlaylistContract
      && contractCapabilityDecision === null
      ? projectPlaylistContractExecutionV1({
          contract: activePlaylistContract,
          basePlan: baseSelectionPlan,
        })
      : null;
    const proposedSelectionPlan = contractExecutionProjection?.plan ?? baseSelectionPlan;
    if (exactRequestedTrackCount !== null && (
      proposedSelectionPlan.requestedTrackCount !== exactRequestedTrackCount
      || proposedSelectionPlan.minimumQualifiedTrackCount !== exactRequestedTrackCount
    )) {
      throw new HttpError(
        409,
        "The selected playlist size is inconsistent with its research plan",
        "track_count_mismatch",
      );
    }
    const schemaVersion = Number(await this.getSchemaVersion() ?? 0);
    const supportsImmutableRunSpec = schemaVersion >= 14;
    const supportsGroundedRecoveryAudit = schemaVersion >= 15;
    let selectionPlanV3: SelectionPlanV3 | null = null;
    let contractExecutionPause: {
      dependencyKey: string;
      state: Record<string, unknown>;
    } | null = null;
    if (supportsImmutableRunSpec
      && exactRequestedTrackCount !== null
      && contractCapabilityDecision === null) {
      try {
        // Contract-v3 is already the immutable, confirmed semantic authority.
        // Its execution bridge compiled the complete Boolean predicate tree,
        // evidence obligations, quotas, catalog/content policy, central
        // quality floor, and sequencing rules into this hash-bound plan.
        // Re-running the raw prompt/brief compiler here would silently create
        // a second interpretation and could weaken or contradict that
        // contract. Only legacy runs are allowed through createRunSpecV3.
        const confirmedV3 = contractExecutionProjection
          ? contractExecutionProjection.selectionPlanV3
          : (() => {
              const specV3 = createRunSpecV3({
                prompt: input.prompt,
                requestedTrackCount: exactRequestedTrackCount,
                storefront: process.env.APPLE_STOREFRONT ?? "us",
                brief: input.brief,
                typedSelectionPlan: proposedSelectionPlan,
                guidanceSourceHints,
              });
              return resolveRunSpecV3(
                specV3,
                criticalAmbiguityAnswersFromGuidanceV3(specV3, guidanceAnswers),
              );
            })();
        const assignmentV3 = assignPipelineV3({
          plan: confirmedV3,
          owner: input.forceFreshResearch === true,
          stickyKey: input.clientBucket,
          env: process.env,
        });
        if ((process.env.PIPELINE_V3_ASSIGNMENT_ENABLED === "true"
          || briefContractVersion === 3) && !confirmedV3.confirmed) {
          throw new HttpError(
            409,
            "This playlist has a material ambiguity that must be answered before research starts",
            "v3_guidance_required",
          );
        }
        // Contract-3 has already been accepted as the user's immutable
        // execution contract and the bridge above proved that the shipped V3
        // backend supports every capability it uses. Do not then strand that
        // accepted contract behind the unrelated public V3 percentage/master
        // rollout. The database kill switch remains authoritative and can
        // still stop this intent cohort immediately.
        const canonicalBackendAssigned = briefContractVersion === 3
          && contractExecutionProjection?.backend === "corpus_first_v3";
        const cohortDisabled = await this.isPipelineCohortDisabled({
          route: "corpus_first_v3",
          intentGroup: assignmentV3.group,
        });
        if (canonicalBackendAssigned && cohortDisabled) {
          // The contract remains valid and fully projected. Persist it as a
          // visible dependency pause rather than discarding the plan and
          // returning a transient 503 after the user already accepted it.
          selectionPlanV3 = confirmedV3;
          contractExecutionPause = {
            dependencyKey: "pipeline_cohort:corpus_first_v3",
            state: {
              reasonCode: "contract_execution_cohort_paused",
              route: "corpus_first_v3",
              intentGroup: assignmentV3.group,
              actions: ["wait_for_dependency", "cancel"],
            },
          };
        } else if ((canonicalBackendAssigned || assignmentV3.assigned)
          && !cohortDisabled) {
          selectionPlanV3 = confirmedV3;
        }
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(
          409,
          error instanceof Error ? error.message : "The confirmed playlist request is not valid for Pipeline V3",
          "v3_run_spec_invalid",
        );
      }
    }
    if (briefContractVersion === 3
      && contractCapabilityDecision === null
      && selectionPlanV3 === null) {
      throw new HttpError(
        503,
        "The active playlist contract requires a compatible corpus-first executor",
        "playlist_contract_backend_unavailable",
      );
    }
    const pipelineAssignment = selectionPlanV3 === null
      && contractCapabilityDecision === null ? assignPipelineV2({
      plan: proposedSelectionPlan,
      owner: input.forceFreshResearch === true,
      // A visitor remains in the same rollout cohort across prompts. Scope
      // text must not reshuffle one browser between V1 and V2; only a new
      // pipeline route or policy version intentionally creates a new cohort.
      stickyKey: pipelineRolloutStickyKey(input.clientBucket, proposedSelectionPlan),
      env: process.env,
    }) : null;
    selectionPlan = contractCapabilityDecision === null
      && pipelineAssignment?.assigned
      && !await this.isPipelineCohortDisabled({
        route: "catalog_first_v2",
        intentGroup: proposedSelectionPlan.scopeKind ?? "broad_curated",
      })
      ? proposedSelectionPlan
      : null;
    const modelRoutingSignals = { scoutTelemetry: guidanceTelemetry };
    const briefHash = briefContractVersion === 3 && activePlaylistContract
      ? sha256Hex(stableStringify({
          executionAuthority: "playlist_contract_revision_v1",
          briefContractVersion,
          playlistContractRevisionId: activePlaylistContract.revisionId,
          playlistContractSemanticHash: activePlaylistContract.semanticHash,
          requestedTrackCount: activePlaylistContract.requestedTrackCount,
          storefront: activePlaylistContract.storefront,
        }))
      : sha256Hex(stableStringify({
          brief: input.brief,
          guidancePreferences,
          selectionPlan,
          selectionPlanV3,
          ...(briefContractVersion === 2 ? {
            briefContractVersion,
            guidanceExecutionDeltaHash,
          } : {}),
          researchPolicy: researchPolicyFingerprint(
            input.brief,
            process.env,
            selectionPlan,
            modelRoutingSignals,
          ),
        }));
    const v3ConversionObservation = selectionPlanV3
      ? await this.pipelineV3ConversionObservation(
          selectionPlanV3.storefront,
          selectionPlanV3.requestedTrackCount,
        )
      : null;
    const pipelinePolicySnapshot = selectionPlanV3
      ? createPipelinePolicySnapshotV3({
        plan: selectionPlanV3,
        environment: process.env,
        modelRoutingSignals: pipelineV3ModelRoutingSignalsFromScoutTelemetry(guidanceTelemetry),
        conversionObservation: v3ConversionObservation,
      })
      : selectionPlan == null ? null : createPipelinePolicySnapshot({
        brief: input.brief,
        selectionPlan,
        environment: process.env,
        modelRoutingSignals,
      });
    // V3 owns a separate execution contract and never enters the legacy/V2
    // fast-route checkpoint path below. Keeping that policy out of this
    // variable also prevents the V3 policy shape from being mistaken for a
    // FastResearchPolicy by downstream helpers.
    const executionPolicy = selectionPlanV3 || contractCapabilityDecision
      ? null
      : researchExecutionPolicy(input.brief, process.env, selectionPlan, modelRoutingSignals);
    const v3ApprovedBudgetUsd = pipelinePolicySnapshot?.executionPolicy.kind === "corpus_first_v3"
      ? pipelinePolicySnapshot.executionPolicy.maximumCostUsd
      : null;
    const runSpecPipelineVersion = contractCapabilityDecision
      ? "corpus_first_v3"
      : selectionPlanV3?.pipelineVersion ?? selectionPlan?.pipelineVersion ?? "legacy_v1";
    const runSpecPolicyVersion = contractCapabilityDecision
      ? "corpus_first_v3_policy_v1"
      : selectionPlanV3?.selectionPlanVersion === "selection_plan_v3"
      ? "corpus_first_v3_policy_v1"
      : selectionPlan?.policyVersion ?? "legacy_v1";
    const runSpecStorefront = (process.env.APPLE_STOREFRONT ?? "us").trim().toLowerCase();
    const runSpecGuidanceSourceHints = selectionPlanV3?.sourceDiscoveryHints ?? [];
    const runSpecHash = briefContractVersion === 3 && activePlaylistContract
      ? sha256Hex(stableStringify({
          executionAuthority: "playlist_contract_revision_v1",
          briefContractVersion,
          playlistContractRevisionId: activePlaylistContract.revisionId,
          playlistContractSemanticHash: activePlaylistContract.semanticHash,
          requestedTrackCount: activePlaylistContract.requestedTrackCount,
          storefront: activePlaylistContract.storefront,
          pipelineVersion: runSpecPipelineVersion,
          policyVersion: runSpecPolicyVersion,
        }))
      : sha256Hex(stableStringify({
          rawPrompt: input.prompt,
          requestedTrackCount: exactRequestedTrackCount,
          storefront: runSpecStorefront,
          guidanceAnswers,
          guidanceSourceHints: runSpecGuidanceSourceHints,
          ...(briefContractVersion === 2 ? { briefContractVersion } : {}),
          pipelineVersion: runSpecPipelineVersion,
          policyVersion: runSpecPolicyVersion,
        }));
    // Owner requests are deliberate test/refresh runs. Never attach them to a
    // prior visitor result, even when the confirmed brief hashes identically.
    const reuseDays = input.forceFreshResearch || input.releaseCanary
      ? 0
      : Math.max(0, Math.min(input.reuseDays ?? 30, 30));
    return this.transaction(async (client) => {
      await lockClientAliases(client, `run:${input.idempotencyKey}`, input.clientBucketAliases);
      if (briefContractVersion === 3) {
        if (!input.briefRequestId
          || !activePlaylistContractDatabaseId
          || !activePlaylistContract) {
          throw new HttpError(
            409,
            "The canonical playlist interpretation is not ready",
            "playlist_contract_not_ready",
          );
        }
        const currentContract = await client.query<{
          active_playlist_contract_revision_id: string | null;
          status: string | null;
          contract_hash: string | null;
          contract_json: PlaylistContractRevisionV1 | null;
        }>(
          `SELECT brief.active_playlist_contract_revision_id,
                  contract.status,contract.contract_hash,contract.contract_json
           FROM brief_requests brief
           JOIN playlist_contract_revisions contract
             ON contract.id=brief.active_playlist_contract_revision_id
           WHERE brief.id=$1 AND brief.expires_at>now()
           FOR SHARE OF brief,contract`,
          [input.briefRequestId],
        );
        const lockedContract = currentContract.rows[0];
        if (!lockedContract
          || lockedContract.status !== "active"
          || lockedContract.active_playlist_contract_revision_id !== activePlaylistContractDatabaseId
          || lockedContract.contract_hash !== activePlaylistContract.semanticHash
          || lockedContract.contract_json?.semanticHash !== activePlaylistContract.semanticHash
          || lockedContract.contract_json?.revisionId !== activePlaylistContract.revisionId) {
          throw new HttpError(
            409,
            "The playlist interpretation changed before research could start",
            "stale_playlist_contract",
          );
        }
      }
      if (repairedStoredSelectionPlan && input.briefRequestId && selectionPlanV3 === null) {
        await client.query(
          `UPDATE brief_requests SET pipeline_version=$2,policy_version=$3,
             selection_plan_json=$4,updated_at=now()
           WHERE id=$1 AND expires_at>now()`,
          [
            input.briefRequestId,
            proposedSelectionPlan.pipelineVersion,
            proposedSelectionPlan.policyVersion,
            JSON.stringify(proposedSelectionPlan),
          ],
        );
      }
      const existing = await client.query<{
        access_id: string;
        run_id: string;
        status: string;
        prompt: string | null;
        brief_hash: string;
        auto_publish: boolean;
        brief_request_id: string | null;
      }>(
        `SELECT a.id AS access_id,a.run_id,a.prompt,a.brief_request_id,r.status,r.brief_hash,r.auto_publish
         FROM run_accesses a JOIN research_runs r ON r.id=a.run_id
         WHERE a.client_bucket=ANY($1::text[]) AND a.idempotency_key=$2 AND a.deleted_at IS NULL ORDER BY a.created_at DESC LIMIT 1`,
        [input.clientBucketAliases, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        const prior = existing.rows[0];
        if (prior.prompt !== input.prompt
          || prior.brief_hash !== briefHash
          || prior.auto_publish !== (input.autoPublish === true)
          || prior.brief_request_id !== (input.briefRequestId ?? null)) {
          throw new HttpError(
            409,
            "Idempotency key was already used for a different playlist run",
            "idempotency_conflict",
          );
        }
        if (input.capabilitySessionId) {
          await this.attachCapabilitySessionAccess(
            client,
            input.capabilitySessionId,
            prior.run_id,
            prior.access_id,
          );
        }
        await persistReleaseCanaryMarker(
          client,
          input.releaseCanary,
          { operation: "run", id: prior.run_id },
          prior.brief_request_id,
        );
        return {
          runId: prior.run_id,
          accessId: prior.access_id,
          status: prior.status,
          created: false,
          reused: false,
        };
      }

      let runId: string | null = null;
      if (reuseDays > 0) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`brief:${briefHash}`]);
        const cached = await client.query<{ id: string; status: string }>(
          `SELECT id,status FROM research_runs
           WHERE brief_hash=$1 AND status='complete' AND completed_at >= now()-($2::text || ' days')::interval
             AND completed_at >= COALESCE(
               (SELECT value::timestamptz FROM settings WHERE key='reuse_not_before:' || $1),
               '-infinity'::timestamptz
             )
             AND (
               COALESCE((brief_json #>> '{targetSize,min}')::int,0)=0
               OR (SELECT count(*)::int
                   FROM manifests m
                   JOIN manifest_tracks mt ON mt.manifest_id=m.id
                   WHERE m.run_id=research_runs.id) >= (brief_json #>> '{targetSize,min}')::int
             )
             AND deleted_at IS NULL ORDER BY completed_at DESC LIMIT 1`,
          [briefHash, String(reuseDays)],
        );
        runId = cached.rows[0]?.id ?? null;
      }

      const reused = Boolean(runId);
      let status = "complete";
      if (!runId) {
        // Capacity is a system-wide invariant. A plain count followed by an
        // insert lets requests from different client buckets race past the
        // limit, so serialize only this short count-and-create section.
        await client.query("SELECT pg_advisory_xact_lock($1)", [RUN_CAPACITY_ADVISORY_LOCK]);
        const active = await client.query<{ count: number }>(
          "SELECT count(*)::int count FROM research_runs WHERE status=ANY($1::text[]) AND deleted_at IS NULL",
          [CAPACITY_RUN_STATUSES],
        );
        if (active.rows[0]!.count >= (input.globalLimit ?? 10)) throw new HttpError(503, "gênio is at capacity; try again soon", "global_capacity_reached");
        runId = randomUUID();
        const gate = readCostConfiguration().autoRunCostLimitUsd;
        status = contractCapabilityDecision || contractExecutionPause
          ? "needs_decision"
          : estimate > gate && approved < estimate
            ? "awaiting_budget"
            : "queued";
        const phase = contractCapabilityDecision
          ? "capability_decision_required"
          : contractExecutionPause
            ? "contract_execution_paused"
          : status === "awaiting_budget"
            ? "budget_gate"
            : "queued";
        const canonicalPrompt = `${input.brief.title}: ${input.brief.description}`.slice(0, 2_000);
        let v3GraphSnapshotId: string | null = null;
        let v3QueryPlan: QueryPlanV3 | null = null;
        if (selectionPlanV3) {
          const snapshot = await client.query<{ id: string }>(
            `SELECT id FROM graph_snapshots
             WHERE status='locked'
             ORDER BY sequence DESC LIMIT 1 FOR SHARE`,
          );
          v3GraphSnapshotId = snapshot.rows[0]?.id ?? null;
          if (!v3GraphSnapshotId) {
            throw new HttpError(
              503,
              "Pipeline V3 is waiting for its first locked evidence graph snapshot",
              "v3_snapshot_unavailable",
            );
          }
          const emittedSchema = queryPlanV3EmissionSchemaVersion(process.env);
          v3QueryPlan = briefContractVersion === 3 && activePlaylistContract
            ? createQueryPlanV3(selectionPlanV3, v3GraphSnapshotId, {
              schemaVersion: 4,
              briefContractVersion,
              playlistContractRevisionId: activePlaylistContract.revisionId,
              playlistContractSemanticHash: activePlaylistContract.semanticHash,
              playlistContractCompilerVersion: activePlaylistContract.versions.compiler,
            })
            : briefContractVersion === 2
            ? createQueryPlanV3(selectionPlanV3, v3GraphSnapshotId, {
              schemaVersion: 3,
              briefContractVersion,
              executionDeltaHash: guidanceExecutionDeltaHash,
            })
            : createQueryPlanV3(selectionPlanV3, v3GraphSnapshotId, {
              schemaVersion: emittedSchema >= 3 ? 2 : emittedSchema,
            });
        }
        const insertedRun = await client.query<{ created_at: Date }>(
         `INSERT INTO research_runs(
             id,prompt,brief_json,guidance_source_hints_json,guidance_telemetry_json,
             guidance_preferences_json,brief_hash,status,phase,client_bucket,idempotency_key,auto_publish,
             estimated_cost_usd,approved_budget_usd,pipeline_version,policy_version,selection_plan_json,
             pipeline_policy_snapshot_json,brief_contract_version,active_playlist_contract_revision_id,
             budget_approval_expires_at,retention_expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::varchar,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             CASE WHEN $8::varchar='awaiting_budget' THEN now()+interval '7 days' ELSE NULL END,
             now()+interval '90 days')
           RETURNING created_at`,
          [
            runId,
            canonicalPrompt,
            input.brief,
            JSON.stringify(guidanceSourceHints),
            guidanceTelemetry == null ? null : JSON.stringify(guidanceTelemetry),
            JSON.stringify(guidancePreferences),
            briefHash,
            status,
            phase,
            input.clientBucket,
            input.idempotencyKey,
            input.autoPublish === true,
            estimate,
            Math.max(approved, status === "queued" ? (v3ApprovedBudgetUsd ?? estimate) : 0),
            selectionPlanV3 || contractCapabilityDecision
              ? "corpus_first_v3"
              : selectionPlan?.pipelineVersion ?? "legacy_v1",
            selectionPlanV3 || contractCapabilityDecision
              ? "corpus_first_v3_policy_v1"
              : selectionPlan?.policyVersion ?? "legacy_v1",
            selectionPlanV3 ? null : selectionPlan == null ? null : JSON.stringify(selectionPlan),
            pipelinePolicySnapshot == null ? null : JSON.stringify(pipelinePolicySnapshot),
            briefContractVersion,
            activePlaylistContractDatabaseId,
          ],
        );
        if (supportsImmutableRunSpec) {
          await client.query(
            `INSERT INTO run_specs(
               run_id,raw_prompt,requested_track_count,storefront,guidance_answers_json,
               guidance_source_hints_json,spec_hash,pipeline_version,policy_version,brief_contract_version)
             VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10)`,
            [
              runId,
              input.prompt,
              exactRequestedTrackCount,
              runSpecStorefront,
              JSON.stringify(guidanceAnswers),
              JSON.stringify(runSpecGuidanceSourceHints),
              runSpecHash,
              runSpecPipelineVersion,
              runSpecPolicyVersion,
              briefContractVersion,
            ],
          );
        }
        if (contractCapabilityDecision && activePlaylistContractDatabaseId) {
          await client.query(
            `INSERT INTO playlist_run_blockers(
               id,run_id,contract_revision_id,blocker_kind,dependency_key,retry_count,
               next_retry_at,automatic_retry_until,state_json)
             VALUES($1,$2,$3,'scope_decision',$4,0,NULL,NULL,$5::jsonb)`,
            [
              randomUUID(),
              runId,
              activePlaylistContractDatabaseId,
              CONTRACT_CAPABILITY_DEPENDENCY_KEY,
              JSON.stringify(canonicalCapabilityBlockerState(contractCapabilityDecision)),
            ],
          );
        } else if (contractExecutionPause && activePlaylistContractDatabaseId) {
          await client.query(
            `INSERT INTO playlist_run_blockers(
               id,run_id,contract_revision_id,blocker_kind,dependency_key,retry_count,
               next_retry_at,automatic_retry_until,state_json)
             VALUES($1,$2,$3,'provider',$4,0,NULL,NULL,$5::jsonb)`,
            [
              randomUUID(),
              runId,
              activePlaylistContractDatabaseId,
              contractExecutionPause.dependencyKey,
              JSON.stringify(contractExecutionPause.state),
            ],
          );
        }
        if (selectionPlanV3 && v3QueryPlan && v3GraphSnapshotId) {
          const selectionPlanId = randomUUID();
          const queryPlanRevisionId = randomUUID();
          const selectionHash = selectionPlanV3Hash(selectionPlanV3);
          const queryHash = queryPlanV3Hash(v3QueryPlan);
          await client.query(
            `INSERT INTO selection_plans(
               id,run_id,revision,status,plan_hash,plan_json,pipeline_version,policy_version,confirmed_at)
             VALUES($1,$2,1,'active',$3,$4::jsonb,'corpus_first_v3','corpus_first_v3_policy_v1',now())`,
            [selectionPlanId, runId, selectionHash, JSON.stringify(selectionPlanV3)],
          );
          await client.query(
            `INSERT INTO query_plan_revisions(
               id,run_id,selection_plan_id,revision,parent_revision_id,graph_snapshot_id,engine,status,
               plan_hash,plan_json,pipeline_version,policy_version,activated_at)
             VALUES($1,$2,$3,1,NULL,$4,$5,'active',$6,$7::jsonb,
               'corpus_first_v3','corpus_first_v3_policy_v1',now())`,
            [
              queryPlanRevisionId,
              runId,
              selectionPlanId,
              v3GraphSnapshotId,
              v3QueryPlan.engine,
              queryHash,
              JSON.stringify(v3QueryPlan),
            ],
          );
          await client.query(
            `INSERT INTO run_active_query_plans(run_id,query_plan_revision_id,activated_at)
             VALUES($1,$2,now())`,
            [runId, queryPlanRevisionId],
          );
          if (supportsGroundedRecoveryAudit && selectionPlanV3.userGoal && selectionPlanV3.semanticAudit) {
            const goalJson = JSON.stringify(selectionPlanV3.userGoal);
            const goalHash = createHash("sha256").update(goalJson).digest("hex");
            await client.query(
              `INSERT INTO user_goals(run_id,goal_hash,goal_json,semantic_plan_version,policy_version)
               VALUES($1,$2,$3::jsonb,'semantic_plan_v3_1','grounded_recovery_v3_1_policy_v1')
               ON CONFLICT(run_id) DO NOTHING`,
              [runId, goalHash, goalJson],
            );
            await client.query(
              `INSERT INTO semantic_plan_revisions(
                 id,run_id,revision,parent_revision,equivalence,hard_constraint_hash,plan_json,audit_json)
               VALUES($1,$2,1,NULL,'initial',$3,$4::jsonb,$5::jsonb)
               ON CONFLICT(run_id,revision) DO NOTHING`,
              [
                randomUUID(),
                runId,
                selectionPlanV3.semanticAudit.hardConstraintHash,
                JSON.stringify(selectionPlanV3),
                JSON.stringify(selectionPlanV3.semanticAudit),
              ],
            );
          }
        }
        if (!selectionPlanV3 && executionPolicy?.kind === "fast_curated") {
          const route = createFastRouteCheckpoint(executionPolicy, insertedRun.rows[0]!.created_at);
          await client.query(
            `INSERT INTO research_checkpoints(run_id,phase,state_json)
             VALUES($1,$2,$3)`,
            [runId, `fast:route:${executionPolicy.version}`, route],
          );
        }
      } else {
        const reusedRun = await client.query<{ status: string }>("SELECT status FROM research_runs WHERE id=$1", [runId]);
        status = reusedRun.rows[0]!.status;
      }

      const accessId = randomUUID();
      await client.query(
        `INSERT INTO run_accesses(id,run_id,brief_request_id,prompt,client_bucket,idempotency_key,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,now()+interval '90 days')`,
        [accessId, runId, input.briefRequestId ?? null, input.prompt.slice(0, 2_000), input.clientBucket, input.idempotencyKey],
      );
      if (input.capabilitySessionId) {
        await this.attachCapabilitySessionAccess(client, input.capabilitySessionId, runId, accessId);
      }
      await persistReleaseCanaryMarker(
        client,
        input.releaseCanary,
        { operation: "run", id: runId },
        input.briefRequestId,
      );
      return { runId, accessId, status, created: !reused, reused };
    });
  }

  /**
   * A run spec is database-trigger immutable, so a semantic rescue cannot
   * rewrite an in-flight run. Create a linked successor run instead:
   *
   * - the new run owns the patched contract revision;
   * - the contract's DB parent points at the prior (possibly brief-owned) row;
   * - the old run/query/job/attempt authority is atomically fenced;
   * - only a capability-compatible successor receives a research job.
   */
  async preparePlaylistRunRescueGuidance(input: {
    runId: string;
    contractRevisionId: string;
    contractSemanticHash: string;
    limitingClauseIds: readonly string[];
    fence: PipelineV3WriteFence;
  }): Promise<RunGuidanceActionView | null> {
    if (Number(await this.getSchemaVersion() ?? 0) < 17) return null;
    if (!/^[a-f0-9]{64}$/u.test(input.contractSemanticHash)) return null;
    return this.transaction(async (client) => {
      await this.assertPipelineV3WriteFence(client, input.runId, input.fence);
      const selected = await client.query<{
        status: string;
        contract_id: string | null;
        contract_hash: string | null;
        contract_json: PlaylistContractRevisionV1 | null;
      }>(
        `SELECT run.status,contract.id contract_id,
                contract.contract_hash,contract.contract_json
         FROM research_runs run
         LEFT JOIN playlist_contract_revisions contract
           ON contract.id=run.active_playlist_contract_revision_id
             AND contract.status='active'
         WHERE run.id=$1 AND run.deleted_at IS NULL
         FOR UPDATE OF run`,
        [input.runId],
      );
      const row = selected.rows[0];
      if (!row?.contract_json
        || row.contract_id !== input.contractRevisionId
        || row.contract_hash !== input.contractSemanticHash
        || row.contract_json.semanticHash !== input.contractSemanticHash
        || !["researching", "continuing_research", "needs_decision"].includes(row.status)) {
        return null;
      }
      assertPlaylistContractIntegrityV1(row.contract_json);
      const history = await client.query<{
        id: string;
        run_id: string;
        revision: number;
        question_set_hash: string;
        questions_json: PlaylistGuidanceQuestion[];
        active: boolean;
        base_contract_revision_id: string | null;
        created_at: Date;
      }>(
        `WITH RECURSIVE lineage(run_id) AS (
           SELECT $1::uuid
           UNION
           SELECT predecessor.id
           FROM lineage current
           JOIN research_checkpoints checkpoint
             ON checkpoint.run_id=current.run_id
            AND checkpoint.phase='canonical_predecessor'
           JOIN research_runs predecessor
             ON predecessor.id::text=checkpoint.state_json->>'sourceRunId'
         )
         SELECT questions.id,questions.run_id,questions.revision,
                questions.question_set_hash,questions.questions_json,
                questions.active,questions.base_contract_revision_id,
                questions.created_at
         FROM guidance_question_sets questions
         JOIN lineage ON lineage.run_id=questions.run_id
         WHERE questions.guidance_round='rescue'
         ORDER BY questions.created_at DESC,questions.id DESC
         FOR UPDATE OF questions`,
        [input.runId],
      );
      const attemptsUsed = history.rows.length;
      const current = history.rows.find((questionSet) => (
        questionSet.run_id === input.runId
        &&
        questionSet.active
        && questionSet.base_contract_revision_id === input.contractRevisionId
      ));
      if (current) {
        return {
          kind: "rescue_guidance",
          questionSetHash: current.question_set_hash,
          baseContractRevisionId: row.contract_json.revisionId,
          baseContractSemanticHash: row.contract_json.semanticHash,
          questions: structuredClone(current.questions_json),
          attemptsUsed: Math.min(2, Math.max(1, attemptsUsed)),
          maximumAttempts: 2,
          showEditableInterpretationSummary: false,
        };
      }
      const alreadyAskedForRevision = history.rows.some(
        (questionSet) => questionSet.base_contract_revision_id === input.contractRevisionId,
      );
      if (attemptsUsed >= 2 || alreadyAskedForRevision) return null;
      const candidate = predicateYieldRescueGuidanceDecisionV3({
        baseContract: row.contract_json,
        limitingClauseIds: input.limitingClauseIds,
      });
      if (!candidate) return null;
      const round = selectGuidanceRoundV3({
        stage: "rescue",
        requestShape: "curated",
        candidates: [candidate],
        rescueQuestionsAlreadyAsked: attemptsUsed,
      });
      if (round.decisions.length !== 1) return null;
      const questions = round.decisions.map(publicGuidanceQuestionV3);
      const questionSetId = randomUUID();
      const revision = Math.max(
        0,
        ...history.rows
          .filter((questionSet) => questionSet.run_id === input.runId)
          .map((questionSet) => Number(questionSet.revision)),
      ) + 1;
      await client.query(
        "UPDATE guidance_question_sets SET active=false WHERE run_id=$1 AND active",
        [input.runId],
      );
      await client.query(
        `INSERT INTO guidance_question_sets(
           id,brief_request_id,run_id,revision,question_set_hash,
           request_classification,generation_mode,guidance_policy_version,
           locale,storefront,target_track_count,explicit_constraint_hash,
           rejected_question_reasons_json,questions_json,active,
           base_contract_revision_id,parent_question_set_id,
           feasibility_snapshot_id,guidance_round,trigger,axis)
         VALUES($1,NULL,$2,$3,$4,'broad_curated','deterministic_critical',
                $5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,true,$12,$13,NULL,
                'rescue','yield_risk',$14)`,
        [
          questionSetId,
          input.runId,
          revision,
          round.roundHash,
          candidate.policyVersion,
          row.contract_json.locale,
          row.contract_json.storefront,
          row.contract_json.requestedTrackCount,
          sha256Hex(stableStringify({
            trackPredicate: row.contract_json.trackPredicate,
            playlistConstraints: row.contract_json.playlistConstraints,
            requestedTrackCount: row.contract_json.requestedTrackCount,
          })),
          JSON.stringify(round.rejectedDecisionReasons),
          JSON.stringify(questions),
          input.contractRevisionId,
          history.rows[0]?.id ?? null,
          candidate.axis,
        ],
      );
      await client.query(
        `UPDATE playlist_run_blockers
         SET resolved_at=now(),updated_at=now()
         WHERE run_id=$1 AND resolved_at IS NULL
           AND blocker_kind IN ('guidance','scope_decision')`,
        [input.runId],
      );
      await client.query(
        `INSERT INTO playlist_run_blockers(
           id,run_id,contract_revision_id,blocker_kind,dependency_key,
           retry_count,next_retry_at,automatic_retry_until,state_json)
         VALUES($1,$2,$3,'guidance',$4,0,NULL,NULL,$5::jsonb)`,
        [
          randomUUID(),
          input.runId,
          input.contractRevisionId,
          `rescue:${candidate.axis}`.slice(0, 120),
          JSON.stringify({
            guidanceRound: "rescue",
            trigger: "yield_risk",
            axis: candidate.axis,
            questionSetHash: round.roundHash,
            contractSemanticHash: row.contract_json.semanticHash,
            attemptsUsed: attemptsUsed + 1,
          }),
        ],
      );
      await client.query(
        `UPDATE research_runs
         SET status='needs_decision',phase='rescue_guidance_required',
             error=NULL,updated_at=now()
         WHERE id=$1`,
        [input.runId],
      );
      return {
        kind: "rescue_guidance",
        questionSetHash: round.roundHash,
        baseContractRevisionId: row.contract_json.revisionId,
        baseContractSemanticHash: row.contract_json.semanticHash,
        questions,
        attemptsUsed: attemptsUsed + 1,
        maximumAttempts: 2,
        showEditableInterpretationSummary: round.showEditableInterpretationSummary,
      };
    });
  }

  private async getPlaylistRunRescueGuidance(
    runId: string,
  ): Promise<RunGuidanceActionView | null> {
    if (Number(await this.getSchemaVersion() ?? 0) < 17) return null;
    const result = await this.pool.query<{
      question_set_hash: string;
      questions_json: PlaylistGuidanceQuestion[];
      contract_revision_id: string;
      contract_json: PlaylistContractRevisionV1;
      attempts_used: number;
    }>(
      `SELECT questions.question_set_hash,questions.questions_json,
              contract.id contract_revision_id,contract.contract_json,
              (
                WITH RECURSIVE lineage(run_id) AS (
                  SELECT run.id
                  UNION
                  SELECT predecessor.id
                  FROM lineage current
                  JOIN research_checkpoints checkpoint
                    ON checkpoint.run_id=current.run_id
                   AND checkpoint.phase='canonical_predecessor'
                  JOIN research_runs predecessor
                    ON predecessor.id::text
                     =checkpoint.state_json->>'sourceRunId'
                )
                SELECT count(*)::int
                FROM guidance_question_sets history
                JOIN lineage ON lineage.run_id=history.run_id
                WHERE history.guidance_round='rescue'
              ) attempts_used
       FROM research_runs run
       JOIN playlist_contract_revisions contract
         ON contract.id=run.active_playlist_contract_revision_id
       JOIN guidance_question_sets questions
         ON questions.run_id=run.id AND questions.active
           AND questions.guidance_round='rescue'
           AND questions.base_contract_revision_id=contract.id
       WHERE run.id=$1 AND run.deleted_at IS NULL
       ORDER BY questions.revision DESC
       LIMIT 1`,
      [runId],
    );
    const row = result.rows[0];
    if (!row) return null;
    try {
      assertPlaylistContractIntegrityV1(row.contract_json);
    } catch {
      return null;
    }
    return {
      kind: "rescue_guidance",
      questionSetHash: row.question_set_hash,
      baseContractRevisionId: row.contract_json.revisionId,
      baseContractSemanticHash: row.contract_json.semanticHash,
      questions: structuredClone(row.questions_json),
      attemptsUsed: Math.min(2, Math.max(1, Number(row.attempts_used))),
      maximumAttempts: 2,
      showEditableInterpretationSummary: false,
    };
  }

  async submitPlaylistRunRescueGuidance(input: {
    runId: string;
    sourceAccessId: string;
    questionSetHash: string;
    answers: PlaylistGuidanceAnswer[];
    idempotencyKey: string;
  }): Promise<{
    runId: string;
    accessId: string;
    created: boolean;
    revised: boolean;
  }> {
    if (!/^[a-f0-9]{64}$/u.test(input.questionSetHash)) {
      throw new HttpError(
        400,
        "Playlist guidance question set is invalid",
        "invalid_guidance_question_set",
      );
    }
    const selected = await this.pool.query<{
      id: string;
      active: boolean;
      questions_json: PlaylistGuidanceQuestion[];
      base_contract_revision_id: string;
      contract_hash: string;
      contract_json: PlaylistContractRevisionV1;
      access_run_id: string;
      prior_idempotency_key: string | null;
      prior_answer_hash: string | null;
    }>(
      `SELECT questions.id,questions.active,questions.questions_json,
              questions.base_contract_revision_id,contract.contract_hash,
              contract.contract_json,access.run_id access_run_id,
              prior.idempotency_key prior_idempotency_key,
              prior.answer_hash prior_answer_hash
       FROM guidance_question_sets questions
       JOIN playlist_contract_revisions contract
         ON contract.id=questions.base_contract_revision_id
       JOIN run_accesses access
         ON access.id=$3 AND access.run_id=questions.run_id
           AND access.deleted_at IS NULL AND access.expires_at>now()
       LEFT JOIN guidance_answer_sets prior
         ON prior.run_id=questions.run_id AND prior.idempotency_key=$4
       WHERE questions.run_id=$1
         AND questions.question_set_hash=$2
         AND questions.guidance_round='rescue'
       ORDER BY questions.revision DESC
       LIMIT 1`,
      [
        input.runId,
        input.questionSetHash,
        input.sourceAccessId,
        input.idempotencyKey,
      ],
    );
    const row = selected.rows[0];
    if (!row || row.access_run_id !== input.runId) {
      throw new HttpError(
        409,
        "Playlist guidance changed before this answer was submitted",
        "stale_guidance_question_set",
      );
    }
    assertPlaylistContractIntegrityV1(row.contract_json);
    const answers = normalizedGuidanceAnswers(
      row.questions_json,
      input.answers,
      3,
    );
    let patch: PlaylistContractPatchV1 | null;
    try {
      patch = compileGuidanceRoundPatchV3({
        base: row.contract_json,
        questionSetHash: input.questionSetHash,
        questions: row.questions_json,
        answers,
      });
    } catch {
      throw new HttpError(
        409,
        "Playlist guidance changed before this answer was submitted",
        "stale_guidance_question_set",
      );
    }
    const answerHash = patch?.answerLineage.answerHash
      ?? sha256Hex(stableStringify({
        questionSetHash: input.questionSetHash,
        answers,
      }));
    if (row.prior_idempotency_key
      && row.prior_answer_hash !== answerHash) {
      throw new HttpError(
        409,
        "Idempotency key was already used for different playlist guidance",
        "idempotency_conflict",
      );
    }
    const executionDelta = patch?.operations ?? [];
    const executionDeltaHash = sha256Hex(stableStringify(executionDelta));
    if (!patch) {
      const created = await this.transaction(async (client) => {
        const authority = await client.query<{
          active: boolean;
          active_playlist_contract_revision_id: string | null;
          status: string;
          prior_answer_hash: string | null;
        }>(
          `SELECT questions.active,
                  run.active_playlist_contract_revision_id,
                  run.status,
                  prior.answer_hash prior_answer_hash
           FROM guidance_question_sets questions
           JOIN research_runs run
             ON run.id=questions.run_id AND run.deleted_at IS NULL
           LEFT JOIN guidance_answer_sets prior
             ON prior.run_id=questions.run_id
            AND prior.idempotency_key=$3
           WHERE questions.id=$1 AND questions.run_id=$2
           FOR UPDATE OF questions,run`,
          [row.id, input.runId, input.idempotencyKey],
        );
        const current = authority.rows[0];
        if (current?.prior_answer_hash !== null
          && current?.prior_answer_hash !== undefined) {
          if (current.prior_answer_hash !== answerHash) {
            throw new HttpError(
              409,
              "Idempotency key was already used for different playlist guidance",
              "idempotency_conflict",
            );
          }
          return false;
        }
        if (!current?.active
          || current.active_playlist_contract_revision_id
            !== row.base_contract_revision_id
          || current.status !== "needs_decision") {
          throw new HttpError(
            409,
            "Playlist guidance changed before this answer was submitted",
            "stale_guidance_question_set",
          );
        }
        const inserted = await client.query(
          `INSERT INTO guidance_answer_sets(
             id,brief_request_id,run_id,question_set_id,question_set_hash,
             normalized_answers_json,raw_custom_answers_json,answer_hash,
             execution_delta_json,execution_delta_hash,idempotency_key,
             base_contract_revision_id,resulting_contract_revision_id)
           VALUES($1,NULL,$2,$3,$4,$5::jsonb,'[]'::jsonb,$6,
                  '[]'::jsonb,$7,$8,$9,$9)
           ON CONFLICT(run_id,idempotency_key) DO NOTHING
           RETURNING id`,
          [
            randomUUID(),
            input.runId,
            row.id,
            input.questionSetHash,
            JSON.stringify(answers),
            answerHash,
            executionDeltaHash,
            input.idempotencyKey,
            row.base_contract_revision_id,
          ],
        );
        await client.query(
          "UPDATE guidance_question_sets SET active=false WHERE id=$1",
          [row.id],
        );
        await client.query(
          `UPDATE playlist_run_blockers SET resolved_at=now(),updated_at=now()
           WHERE run_id=$1 AND blocker_kind='guidance' AND resolved_at IS NULL`,
          [input.runId],
        );
        await client.query(
          `INSERT INTO playlist_run_blockers(
             id,run_id,contract_revision_id,blocker_kind,dependency_key,
             retry_count,state_json)
           SELECT $1,$2,$3,'scope_decision','rescue_skipped',0,
                  jsonb_build_object(
                    'reasonCode','rescue_guidance_skipped',
                    'questionSetHash',$4::text
                  )
           WHERE NOT EXISTS (
             SELECT 1 FROM playlist_run_blockers
             WHERE run_id=$2 AND blocker_kind='scope_decision'
               AND resolved_at IS NULL
           )`,
          [
            randomUUID(),
            input.runId,
            row.base_contract_revision_id,
            input.questionSetHash,
          ],
        );
        await client.query(
          `UPDATE research_runs
           SET status='needs_decision',phase='rescue_guidance_skipped',
               error=NULL,updated_at=now()
           WHERE id=$1`,
          [input.runId],
        );
        return Boolean(inserted.rows[0]);
      });
      return {
        runId: input.runId,
        accessId: input.sourceAccessId,
        created,
        revised: false,
      };
    }
    const successor = await this.createCanonicalRunSuccessor({
      runId: input.runId,
      sourceAccessId: input.sourceAccessId,
      expectedContractRevisionId: row.base_contract_revision_id,
      expectedContractSemanticHash: row.contract_hash,
      patch,
      idempotencyKey: input.idempotencyKey,
      trigger: "rescue_guidance",
    });
    await this.pool.query(
      `INSERT INTO guidance_answer_sets(
         id,brief_request_id,run_id,question_set_id,question_set_hash,
         normalized_answers_json,raw_custom_answers_json,answer_hash,
         execution_delta_json,execution_delta_hash,idempotency_key,
         base_contract_revision_id,resulting_contract_revision_id,
         resulting_query_plan_revision_id)
       VALUES($1,NULL,$2,$3,$4,$5::jsonb,'[]'::jsonb,$6,$7::jsonb,$8,$9,
              $10,$11,$12)
       ON CONFLICT(run_id,idempotency_key) DO NOTHING`,
      [
        randomUUID(),
        input.runId,
        row.id,
        input.questionSetHash,
        JSON.stringify(answers),
        answerHash,
        JSON.stringify(executionDelta),
        executionDeltaHash,
        input.idempotencyKey,
        row.base_contract_revision_id,
        successor.contractRevisionId,
        successor.queryPlanRevisionId,
      ],
    );
    return {
      runId: successor.runId,
      accessId: successor.accessId,
      created: successor.created,
      revised: true,
    };
  }

  async createCanonicalRunSuccessor(
    input: CreateCanonicalRunSuccessorInput,
  ): Promise<CanonicalRunSuccessorResult> {
    const idempotencyKey = input.idempotencyKey.normalize("NFKC").trim();
    if (!idempotencyKey || idempotencyKey.length > 160) {
      throw new HttpError(
        400,
        "Canonical successor idempotency key is invalid",
        "invalid_idempotency_key",
      );
    }
    if (!/^[a-f0-9]{64}$/u.test(input.expectedContractSemanticHash)) {
      throw new HttpError(
        400,
        "Canonical successor contract hash is invalid",
        "invalid_contract_hash",
      );
    }
    const patch = structuredClone(input.patch);
    const requestHash = sha256Hex(stableStringify({
      operation: "canonical_run_successor_v1",
      sourceRunId: input.runId,
      sourceAccessId: input.sourceAccessId,
      expectedContractRevisionId: input.expectedContractRevisionId,
      expectedContractSemanticHash: input.expectedContractSemanticHash,
      trigger: input.trigger,
      patch,
    }));

    return this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`canonical-successor:${input.runId}:${input.sourceAccessId}`],
      );
      const source = await client.query<{
        access_id: string;
        access_run_id: string;
        access_prompt: string | null;
        client_bucket: string;
        status: string;
        phase: string;
        canonical_prompt: string;
        brief_json: PlaylistBrief;
        guidance_source_hints_json: PlaylistGuidanceSourceHint[] | null;
        guidance_telemetry_json: PlaylistGuidanceTelemetry | null;
        guidance_preferences_json: PlaylistGuidancePreference[] | null;
        auto_publish: boolean;
        estimated_cost_usd: string;
        approved_budget_usd: string;
        active_playlist_contract_revision_id: string;
        pipeline_version: string;
        policy_version: string;
        contract_status: string;
        contract_hash: string;
        contract_json: PlaylistContractRevisionV1;
        contract_run_id: string | null;
        contract_brief_request_id: string | null;
        raw_prompt: string;
        guidance_answers_json: PlaylistGuidanceAnswer[] | null;
      }>(
        `SELECT access_row.id access_id,access_row.run_id access_run_id,
                access_row.prompt access_prompt,access_row.client_bucket,
                run.status,run.phase,run.prompt canonical_prompt,run.brief_json,
                run.guidance_source_hints_json,run.guidance_telemetry_json,
                run.guidance_preferences_json,run.auto_publish,
                run.estimated_cost_usd,run.approved_budget_usd,
                run.active_playlist_contract_revision_id,
                run.pipeline_version,run.policy_version,
                contract.status contract_status,contract.contract_hash,
                contract.contract_json,contract.run_id contract_run_id,
                contract.brief_request_id contract_brief_request_id,
                spec.raw_prompt,spec.guidance_answers_json
         FROM run_accesses access_row
         JOIN research_runs run ON run.id=access_row.run_id
         JOIN run_specs spec ON spec.run_id=run.id AND spec.brief_contract_version=3
         JOIN playlist_contract_revisions contract
           ON contract.id=run.active_playlist_contract_revision_id
         WHERE access_row.id=$1 AND access_row.run_id=$2
           AND access_row.deleted_at IS NULL AND access_row.expires_at>now()
           AND run.deleted_at IS NULL AND run.brief_contract_version=3
         FOR UPDATE OF access_row,run,contract`,
        [input.sourceAccessId, input.runId],
      );
      const row = source.rows[0];
      if (!row) {
        throw new HttpError(
          409,
          "The source access no longer maps to the canonical run",
          "stale_source_run_access",
        );
      }

      // An idempotent retry must continue to succeed after the first call has
      // deliberately cancelled/fenced the source run.
      const existing = await client.query<{
        access_id: string;
        run_id: string;
        status: string;
        active_playlist_contract_revision_id: string;
        query_plan_revision_id: string | null;
        state_json: Record<string, unknown> | null;
      }>(
        `SELECT access_row.id access_id,run.id run_id,run.status,
                run.active_playlist_contract_revision_id,
                active.query_plan_revision_id,checkpoint.state_json
         FROM run_accesses access_row
         JOIN research_runs run ON run.id=access_row.run_id
         LEFT JOIN run_active_query_plans active ON active.run_id=run.id
         LEFT JOIN research_checkpoints checkpoint
           ON checkpoint.run_id=run.id AND checkpoint.phase='canonical_predecessor'
         WHERE access_row.client_bucket=$1 AND access_row.idempotency_key=$2
           AND access_row.deleted_at IS NULL AND run.deleted_at IS NULL
         ORDER BY access_row.created_at DESC
         LIMIT 1
         FOR UPDATE OF access_row,run`,
        [row.client_bucket, idempotencyKey],
      );
      if (existing.rows[0]) {
        const prior = existing.rows[0];
        if (prior.state_json?.requestHash !== requestHash
          || prior.state_json?.sourceRunId !== input.runId
          || prior.state_json?.sourceAccessId !== input.sourceAccessId) {
          throw new HttpError(
            409,
            "Idempotency key was already used for another canonical revision",
            "idempotency_conflict",
          );
        }
        return {
          runId: prior.run_id,
          accessId: prior.access_id,
          contractRevisionId: prior.active_playlist_contract_revision_id,
          queryPlanRevisionId: prior.query_plan_revision_id,
          created: false,
          status: prior.status as CanonicalRunSuccessorResult["status"],
        };
      }

      const revisableStatuses = new Set([
        "awaiting_guidance",
        "researching",
        "partial_ready",
        "needs_decision",
        "continuing_research",
        "no_compatible_tracks",
        "waiting_for_corpus_review",
        "failed",
        "failed_system",
      ]);
      if (!revisableStatuses.has(row.status)
        || row.active_playlist_contract_revision_id
          !== input.expectedContractRevisionId
        || row.contract_hash !== input.expectedContractSemanticHash
        || row.contract_json.semanticHash !== input.expectedContractSemanticHash
        || row.contract_status !== "active") {
        throw new HttpError(
          409,
          "The canonical run changed before its revision was applied",
          "stale_playlist_contract",
        );
      }
      assertPlaylistContractIntegrityV1(row.contract_json);

      let successorContract: PlaylistContractRevisionV1;
      try {
        successorContract = applyPlaylistContractPatchV1(row.contract_json, patch);
      } catch (error) {
        if (error instanceof Error
          && error.message === "stale_playlist_contract_revision") {
          throw new HttpError(
            409,
            "The canonical run changed before its revision was applied",
            "stale_playlist_contract",
          );
        }
        throw new HttpError(
          409,
          "The requested canonical revision is not executable",
          "playlist_contract_patch_invalid",
        );
      }
      if (successorContract.requestedTrackCount < PUBLIC_PLAYLIST_MINIMUM_TRACKS
        || successorContract.requestedTrackCount > EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS) {
        throw new HttpError(
          400,
          `Track count must be from ${PUBLIC_PLAYLIST_MINIMUM_TRACKS} to ${EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS}`,
          "invalid_track_count",
        );
      }

      const sourcePlan = await client.query<{
        id: string;
        revision: number;
        status: string;
        plan_hash: string;
        plan_json: unknown;
        selection_plan_id: string;
      }>(
        `SELECT query.id,query.revision,query.status,query.plan_hash,
                query.plan_json,query.selection_plan_id
         FROM run_active_query_plans active
         JOIN query_plan_revisions query
           ON query.id=active.query_plan_revision_id
         WHERE active.run_id=$1
         FOR UPDATE OF active,query`,
        [input.runId],
      );
      const sourceQuery = sourcePlan.rows[0] ?? null;
      if (sourceQuery && (
        sourceQuery.status !== "active"
        || !isQueryPlanV3(sourceQuery.plan_json)
        || queryPlanV3Hash(sourceQuery.plan_json) !== sourceQuery.plan_hash
      )) {
        throw new HttpError(
          409,
          "The source run's active plan failed integrity validation",
          "v3_query_plan_integrity",
        );
      }
      if (!sourceQuery
        && row.phase !== "capability_decision_required"
        && row.pipeline_version === "corpus_first_v3") {
        throw new HttpError(
          409,
          "The source run has no canonical query plan to supersede",
          "v3_query_plan_integrity",
        );
      }

      const capabilityDecision = canonicalCapabilityDecision(successorContract);
      const projection = capabilityDecision
        ? null
        : projectPlaylistContractExecutionV1({
            contract: successorContract,
            basePlan: {
              requestedTrackCount: successorContract.requestedTrackCount,
              minimumQualifiedTrackCount: successorContract.requestedTrackCount,
              storefront: successorContract.storefront,
            },
          });
      let graphSnapshotId: string | null = null;
      let selectionPlanV3: SelectionPlanV3 | null = null;
      let queryPlan: QueryPlanV3 | null = null;
      if (projection) {
        const snapshot = await client.query<{ id: string }>(
          `SELECT id FROM graph_snapshots
           WHERE status='locked'
           ORDER BY sequence DESC LIMIT 1 FOR SHARE`,
        );
        graphSnapshotId = snapshot.rows[0]?.id ?? null;
        if (!graphSnapshotId) {
          throw new HttpError(
            503,
            "Pipeline V3 is waiting for its first locked evidence graph snapshot",
            "v3_snapshot_unavailable",
          );
        }
        selectionPlanV3 = projection.selectionPlanV3;
        queryPlan = createQueryPlanV3(selectionPlanV3, graphSnapshotId, {
          schemaVersion: 4,
          briefContractVersion: 3,
          playlistContractRevisionId: successorContract.revisionId,
          playlistContractSemanticHash: successorContract.semanticHash,
          playlistContractCompilerVersion: successorContract.versions.compiler,
        });
      }

      const pipelinePolicySnapshot = selectionPlanV3
        ? createPipelinePolicySnapshotV3({
            plan: selectionPlanV3,
            environment: process.env,
            modelRoutingSignals: pipelineV3ModelRoutingSignalsFromScoutTelemetry(
              row.guidance_telemetry_json,
            ),
            conversionObservation: null,
          })
        : null;
      const requiredBudgetUsd = pipelinePolicySnapshot?.executionPolicy.kind
        === "corpus_first_v3"
        ? pipelinePolicySnapshot.executionPolicy.maximumCostUsd
        : Number(row.estimated_cost_usd);
      const approvedBudgetUsd = Number(row.approved_budget_usd);
      const successorStatus: CanonicalRunSuccessorResult["status"] =
        capabilityDecision
          ? "needs_decision"
          : approvedBudgetUsd + 0.000001 < requiredBudgetUsd
            ? "awaiting_budget"
            : "queued";
      const successorPhase = capabilityDecision
        ? "capability_decision_required"
        : successorStatus === "awaiting_budget"
          ? "budget_gate"
          : "queued";

      if (successorStatus === "queued") {
        await client.query(
          "SELECT pg_advisory_xact_lock($1)",
          [RUN_CAPACITY_ADVISORY_LOCK],
        );
        const active = await client.query<{ count: number }>(
          `SELECT count(*)::int count FROM research_runs
           WHERE id<>$1 AND status=ANY($2::text[]) AND deleted_at IS NULL`,
          [input.runId, CAPACITY_RUN_STATUSES],
        );
        if (Number(active.rows[0]?.count ?? 0) >= 10) {
          throw new HttpError(
            503,
            "gênio is at capacity; try again soon",
            "global_capacity_reached",
          );
        }
      }

      const successorRunId = randomUUID();
      const successorAccessId = randomUUID();
      const successorContractDatabaseId = randomUUID();
      const selectionPlanId = selectionPlanV3 ? randomUUID() : null;
      const queryPlanRevisionId = queryPlan ? randomUUID() : null;
      const nextBrief: PlaylistBrief = {
        ...structuredClone(row.brief_json),
        targetSize: {
          min: successorContract.requestedTrackCount,
          max: successorContract.requestedTrackCount,
        },
      };
      const contractBriefHash = sha256Hex(stableStringify({
        executionAuthority: "playlist_contract_revision_v1",
        briefContractVersion: 3,
        playlistContractRevisionId: successorContract.revisionId,
        playlistContractSemanticHash: successorContract.semanticHash,
        requestedTrackCount: successorContract.requestedTrackCount,
        storefront: successorContract.storefront,
      }));
      const runSpecHash = sha256Hex(stableStringify({
        executionAuthority: "playlist_contract_revision_v1",
        briefContractVersion: 3,
        playlistContractRevisionId: successorContract.revisionId,
        playlistContractSemanticHash: successorContract.semanticHash,
        requestedTrackCount: successorContract.requestedTrackCount,
        storefront: successorContract.storefront,
        pipelineVersion: "corpus_first_v3",
        policyVersion: "corpus_first_v3_policy_v1",
      }));
      const canonicalPrompt =
        `${nextBrief.title}: ${nextBrief.description}`.slice(0, 2_000);

      await client.query(
        `INSERT INTO research_runs(
           id,prompt,brief_json,guidance_source_hints_json,guidance_telemetry_json,
           guidance_preferences_json,brief_hash,status,phase,client_bucket,
           idempotency_key,auto_publish,estimated_cost_usd,approved_budget_usd,
           pipeline_version,policy_version,selection_plan_json,
           pipeline_policy_snapshot_json,brief_contract_version,
           active_playlist_contract_revision_id,budget_approval_expires_at,
           retention_expires_at)
         VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8::varchar,$9,$10,
           $11,$12,$13,$14,'corpus_first_v3','corpus_first_v3_policy_v1',NULL,
           $15::jsonb,3,NULL,
           CASE WHEN $8::varchar='awaiting_budget' THEN now()+interval '7 days' ELSE NULL END,
           now()+interval '90 days')`,
        [
          successorRunId,
          canonicalPrompt,
          JSON.stringify(nextBrief),
          JSON.stringify(row.guidance_source_hints_json ?? []),
          row.guidance_telemetry_json == null
            ? null
            : JSON.stringify(row.guidance_telemetry_json),
          JSON.stringify(row.guidance_preferences_json ?? []),
          contractBriefHash,
          successorStatus,
          successorPhase,
          row.client_bucket,
          idempotencyKey,
          row.auto_publish,
          requiredBudgetUsd,
          approvedBudgetUsd,
          pipelinePolicySnapshot == null
            ? null
            : JSON.stringify(pipelinePolicySnapshot),
        ],
      );
      await client.query(
        `INSERT INTO playlist_contract_revisions(
           id,brief_request_id,run_id,revision,parent_revision_id,status,
           contract_hash,contract_json,compiler_version,ontology_version,
           evidence_policy_version,question_template_version,
           catalog_policy_version,locale,storefront,answer_lineage_hash)
         VALUES($1,NULL,$2,$3,$4,'active',$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          successorContractDatabaseId,
          successorRunId,
          successorContract.revision,
          input.expectedContractRevisionId,
          successorContract.semanticHash,
          JSON.stringify(successorContract),
          successorContract.versions.compiler,
          successorContract.versions.ontology,
          successorContract.versions.evidencePolicy,
          successorContract.versions.questionTemplates,
          successorContract.versions.catalogPolicy,
          successorContract.locale,
          successorContract.storefront,
          sha256Hex(stableStringify(successorContract.answerLineage)),
        ],
      );
      await client.query(
        `UPDATE research_runs
         SET active_playlist_contract_revision_id=$2,updated_at=now()
         WHERE id=$1`,
        [successorRunId, successorContractDatabaseId],
      );
      await client.query(
        `INSERT INTO run_specs(
           run_id,raw_prompt,requested_track_count,storefront,
           guidance_answers_json,guidance_source_hints_json,spec_hash,
           pipeline_version,policy_version,brief_contract_version)
         VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,
           'corpus_first_v3','corpus_first_v3_policy_v1',3)`,
        [
          successorRunId,
          row.raw_prompt,
          successorContract.requestedTrackCount,
          successorContract.storefront,
          JSON.stringify(row.guidance_answers_json ?? []),
          JSON.stringify(selectionPlanV3?.sourceDiscoveryHints ?? []),
          runSpecHash,
        ],
      );

      if (selectionPlanV3 && queryPlan && graphSnapshotId
        && selectionPlanId && queryPlanRevisionId) {
        const selectionHash = selectionPlanV3Hash(selectionPlanV3);
        const queryHash = queryPlanV3Hash(queryPlan);
        await client.query(
          `INSERT INTO selection_plans(
             id,run_id,revision,status,plan_hash,plan_json,pipeline_version,
             policy_version,confirmed_at)
           VALUES($1,$2,1,'active',$3,$4::jsonb,'corpus_first_v3',
             'corpus_first_v3_policy_v1',now())`,
          [
            selectionPlanId,
            successorRunId,
            selectionHash,
            JSON.stringify(selectionPlanV3),
          ],
        );
        await client.query(
          `INSERT INTO query_plan_revisions(
             id,run_id,selection_plan_id,revision,parent_revision_id,
             graph_snapshot_id,engine,status,plan_hash,plan_json,
             pipeline_version,policy_version,activated_at)
           VALUES($1,$2,$3,1,$4,$5,$6,'active',$7,$8::jsonb,
             'corpus_first_v3','corpus_first_v3_policy_v1',now())`,
          [
            queryPlanRevisionId,
            successorRunId,
            selectionPlanId,
            sourceQuery?.id ?? null,
            graphSnapshotId,
            queryPlan.engine,
            queryHash,
            JSON.stringify(queryPlan),
          ],
        );
        await client.query(
          `INSERT INTO run_active_query_plans(
             run_id,query_plan_revision_id,activated_at)
           VALUES($1,$2,now())`,
          [successorRunId, queryPlanRevisionId],
        );
      }

      await client.query(
        `INSERT INTO run_accesses(
           id,run_id,brief_request_id,prompt,client_bucket,idempotency_key,expires_at)
         VALUES($1,$2,NULL,$3,$4,$5,now()+interval '90 days')`,
        [
          successorAccessId,
          successorRunId,
          row.access_prompt ?? row.raw_prompt,
          row.client_bucket,
          idempotencyKey,
        ],
      );
      await client.query(
        `INSERT INTO capability_session_accesses(session_id,run_id,access_id)
         SELECT link.session_id,$2,$3
         FROM capability_session_accesses link
         JOIN capability_sessions session ON session.id=link.session_id
         WHERE link.run_id=$1 AND link.access_id=$4
           AND session.revoked_at IS NULL AND session.expires_at>now()
         ON CONFLICT(session_id,access_id) DO NOTHING`,
        [
          input.runId,
          successorRunId,
          successorAccessId,
          input.sourceAccessId,
        ],
      );

      await client.query(
        `INSERT INTO research_checkpoints(run_id,phase,state_json)
         VALUES($1,'canonical_predecessor',$2::jsonb)`,
        [
          successorRunId,
          JSON.stringify({
            requestHash,
            sourceRunId: input.runId,
            sourceAccessId: input.sourceAccessId,
            sourceContractRevisionId: input.expectedContractRevisionId,
            sourceContractSemanticHash: input.expectedContractSemanticHash,
            sourceQueryPlanRevisionId: sourceQuery?.id ?? null,
            trigger: input.trigger,
          }),
        ],
      );
      await client.query(
        `INSERT INTO research_checkpoints(run_id,phase,state_json)
         VALUES($1,'canonical_successor',$2::jsonb)
         ON CONFLICT(run_id,phase) DO UPDATE SET
           state_json=EXCLUDED.state_json,updated_at=now()`,
        [
          input.runId,
          JSON.stringify({
            requestHash,
            successorRunId,
            successorAccessId,
            successorContractRevisionId: successorContractDatabaseId,
            successorContractSemanticHash: successorContract.semanticHash,
            successorQueryPlanRevisionId: queryPlanRevisionId,
            trigger: input.trigger,
          }),
        ],
      );

      // Preserve answer rows as append-only history. Keep only answer hashes
      // that are part of the successor's lineage valid; stale dependent
      // answers and feasibility estimates can no longer govern execution.
      const lineageAnswerHashes = successorContract.answerLineage
        .map(({ answerHash }) => answerHash);
      await client.query(
        `UPDATE guidance_answer_sets SET invalidated_at=now()
         WHERE run_id=$1 AND invalidated_at IS NULL
           AND NOT (answer_hash=ANY($2::text[]))`,
        [input.runId, lineageAnswerHashes],
      );
      await client.query(
        `UPDATE guidance_answer_sets SET
           resulting_contract_revision_id=COALESCE(
             resulting_contract_revision_id,$2
           ),
           resulting_selection_plan_id=COALESCE(
             resulting_selection_plan_id,$3
           ),
           resulting_query_plan_revision_id=COALESCE(
             resulting_query_plan_revision_id,$4
           )
         WHERE run_id=$1 AND answer_hash=$5 AND invalidated_at IS NULL`,
        [
          input.runId,
          successorContractDatabaseId,
          selectionPlanId,
          queryPlanRevisionId,
          patch.answerLineage.answerHash,
        ],
      );
      await client.query(
        "UPDATE guidance_question_sets SET active=false WHERE run_id=$1 AND active",
        [input.runId],
      );
      await client.query(
        `UPDATE playlist_feasibility_snapshots SET invalidated_at=now()
         WHERE contract_revision_id=$1 AND invalidated_at IS NULL`,
        [input.expectedContractRevisionId],
      );

      if (row.contract_run_id === input.runId) {
        await client.query(
          `UPDATE playlist_contract_revisions SET status='superseded'
           WHERE id=$1 AND status='active'`,
          [input.expectedContractRevisionId],
        );
      }
      await client.query(
        `UPDATE selection_plans SET status='superseded'
         WHERE run_id=$1 AND status='active'`,
        [input.runId],
      );
      await client.query(
        `UPDATE query_plan_revisions SET status='superseded'
         WHERE run_id=$1 AND status='active'`,
        [input.runId],
      );
      await client.query(
        "DELETE FROM run_active_query_plans WHERE run_id=$1",
        [input.runId],
      );
      await client.query(
        `UPDATE playlist_execution_attempts
         SET status='discarded',completed_at=now()
         WHERE run_id=$1 AND status IN ('queued','running','blocked')`,
        [input.runId],
      );
      await client.query(
        `UPDATE playlist_run_blockers
         SET resolved_at=now(),updated_at=now()
         WHERE run_id=$1 AND resolved_at IS NULL`,
        [input.runId],
      );
      await client.query(
        `UPDATE job_queue
         SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,
             completed_at=now(),last_error='superseded_contract_revision',
             updated_at=now()
         WHERE run_id=$1 AND status IN ('queued','leased')`,
        [input.runId],
      );
      await client.query(
        `UPDATE research_runs SET status='cancelled',
             phase='superseded_by_contract_revision',
             active_playlist_contract_revision_id=$2,error=NULL,
             completed_at=now(),updated_at=now()
         WHERE id=$1`,
        [input.runId, successorContractDatabaseId],
      );

      if (capabilityDecision) {
        await client.query(
          `INSERT INTO playlist_run_blockers(
             id,run_id,contract_revision_id,blocker_kind,dependency_key,
             retry_count,next_retry_at,automatic_retry_until,state_json)
           VALUES($1,$2,$3,'scope_decision',$4,0,NULL,NULL,$5::jsonb)`,
          [
            randomUUID(),
            successorRunId,
            successorContractDatabaseId,
            CONTRACT_CAPABILITY_DEPENDENCY_KEY,
            JSON.stringify(canonicalCapabilityBlockerState(capabilityDecision)),
          ],
        );
      } else if (successorStatus === "awaiting_budget") {
        await client.query(
          `INSERT INTO playlist_run_blockers(
             id,run_id,contract_revision_id,blocker_kind,dependency_key,
             retry_count,next_retry_at,automatic_retry_until,state_json)
           VALUES($1,$2,$3,'budget',NULL,0,NULL,NULL,$4::jsonb)`,
          [
            randomUUID(),
            successorRunId,
            successorContractDatabaseId,
            JSON.stringify({
              reasonCode: "successor_budget_approval_required",
              requiredBudgetUsd,
              approvedBudgetUsd,
            }),
          ],
        );
      } else if (queryPlan && queryPlanRevisionId) {
        const stageKey = v3RetrievalStageKey(queryPlan, "active");
        const queueClass: JobQueueClass = isDeepQueryPlan(queryPlan)
          ? "deep"
          : "interactive";
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO job_queue(
             id,run_id,kind,dedupe_key,payload_json,max_attempts,
             pipeline_version,minimum_worker_protocol,query_plan_revision_id,
             stage_key,queue_class)
           VALUES($1,$2,'research',$3,$4::jsonb,10,'corpus_first_v3',
             $5,$6,$7,$8)
           ON CONFLICT(kind,dedupe_key) DO NOTHING RETURNING id`,
          [
            randomUUID(),
            successorRunId,
            `research:${successorRunId}:${stageKey}`.slice(0, 160),
            JSON.stringify({
              runId: successorRunId,
              phase: "v3_retrieval",
              v3ExecutionMode: "active",
              stageExecutionKey: stageKey,
              predecessorRunId: input.runId,
            }),
            minimumWorkerProtocolForQueryPlan(queryPlan),
            queryPlanRevisionId,
            stageKey,
            queueClass,
          ],
        );
        if (!inserted.rows[0]) {
          throw new HttpError(
            409,
            "The canonical successor job could not be created",
            "canonical_successor_job_conflict",
          );
        }
      }

      return {
        runId: successorRunId,
        accessId: successorAccessId,
        contractRevisionId: successorContractDatabaseId,
        queryPlanRevisionId,
        created: true,
        status: successorStatus,
      };
    });
  }

  async createRun(prompt: string, brief: PlaylistBrief, estimate: number, approvedBudget: number): Promise<string> {
    const clientBucket = `legacy.${sha256Hex(randomUUID()).slice(0, 32)}`;
    const result = await this.createRunIdempotent({
      prompt,
      brief,
      estimateUsd: estimate,
      approvedBudgetUsd: approvedBudget,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      reuseDays: 0,
    });
    return result.runId;
  }

  async recordProviderMetric(input: {
    runId?: string | null;
    provider: string;
    operation: string;
    stageKey: string;
    metricName: string;
    metricValue: number;
    requestOutcome: string;
    cacheOutcome?: string | null;
    idempotencyKey: string;
    occurredAt?: Date;
  }): Promise<void> {
    if (Number(await this.getSchemaVersion() ?? 0) < 16) return;
    const metricValue = Math.max(0, Math.floor(input.metricValue));
    if (!Number.isSafeInteger(metricValue)) throw new HttpError(400, "Provider metric value is invalid", "invalid_provider_metric");
    const bounded = (value: string, maximum: number) => value.normalize("NFKC").trim().slice(0, maximum);
    const provider = bounded(input.provider, 80);
    const operation = bounded(input.operation, 120);
    const stageKey = bounded(input.stageKey, 120);
    const metricName = bounded(input.metricName, 120);
    const requestOutcome = bounded(input.requestOutcome, 48);
    const cacheOutcome = input.cacheOutcome == null ? null : bounded(input.cacheOutcome, 48);
    const idempotencyKey = bounded(input.idempotencyKey, 160);
    if (![provider, operation, stageKey, metricName, requestOutcome, idempotencyKey].every(Boolean)) {
      throw new HttpError(400, "Provider metric dimensions are invalid", "invalid_provider_metric");
    }
    const occurredAt = input.occurredAt ?? new Date();
    await this.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO provider_metric_events(
           id,run_id,provider,operation,stage_key,metric_name,metric_value,
           request_outcome,cache_outcome,idempotency_key,occurred_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,
        [randomUUID(), input.runId ?? null, provider, operation, stageKey, metricName,
          metricValue, requestOutcome, cacheOutcome, idempotencyKey, occurredAt],
      );
      if (!inserted.rows[0]) return;
      await client.query(
        `INSERT INTO provider_metric_daily_aggregates(
           metric_date,provider,operation,metric_name,metric_value,event_count,expires_at)
         VALUES(($1::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date,$2,$3,$4,$5,1,
           (($1::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date + interval '13 months'))
         ON CONFLICT(metric_date,provider,operation,metric_name) DO UPDATE SET
           metric_value=provider_metric_daily_aggregates.metric_value+EXCLUDED.metric_value,
           event_count=provider_metric_daily_aggregates.event_count+1,
           updated_at=now(),expires_at=GREATEST(provider_metric_daily_aggregates.expires_at,EXCLUDED.expires_at)`,
        [occurredAt, provider, operation, metricName, metricValue],
      );
    });
  }

  async recordRunSourceObservation(input: {
    runId: string;
    queryPlanRevisionId?: string | null;
    providerMetricEventId?: string | null;
    idempotencyKey: string;
    allowedHost: string;
    resourceType: string;
    extractionMethod: string;
    attemptOutcome: string;
    locator: string;
    providerRows?: number;
    uniqueValidLeads?: number;
    citationBearingLeads?: number;
    exactPairAttestations?: number;
    startedAt: Date;
    completedAt?: Date | null;
  }): Promise<void> {
    if (Number(await this.getSchemaVersion() ?? 0) < 16) return;
    const count = (value: number | undefined) => Math.max(0, Math.floor(value ?? 0));
    await this.pool.query(
      `INSERT INTO run_source_observations(
         id,run_id,query_plan_revision_id,provider_metric_event_id,idempotency_key,
         allowed_host,resource_type,extraction_method,attempt_outcome,locator_hash,
         provider_rows,unique_valid_leads,citation_bearing_leads,exact_pair_attestations,
         started_at,completed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT(idempotency_key) DO NOTHING`,
      [
        randomUUID(), input.runId, input.queryPlanRevisionId ?? null,
        input.providerMetricEventId ?? null, input.idempotencyKey.slice(0, 160),
        input.allowedHost.toLowerCase().slice(0, 240), input.resourceType.slice(0, 80),
        input.extractionMethod.slice(0, 80), input.attemptOutcome.slice(0, 80),
        sha256Hex(input.locator), count(input.providerRows), count(input.uniqueValidLeads),
        count(input.citationBearingLeads), count(input.exactPairAttestations),
        input.startedAt, input.completedAt ?? null,
      ],
    );
  }

  private async persistTerminalStageMetricSummary(runId: string): Promise<void> {
    if (Number(await this.getSchemaVersion() ?? 0) < 16) return;
    const summary = await this.pool.query<Record<string, unknown>>(
      `SELECT r.status,r.phase,r.pipeline_outcome_json,active.query_plan_revision_id,
         COALESCE((SELECT sum(provider_rows)::int FROM run_source_observations WHERE run_id=r.id),0) provider_rows,
         COALESCE((SELECT sum(unique_valid_leads)::int FROM run_source_observations WHERE run_id=r.id),0) unique_valid_leads,
         COALESCE((SELECT sum(citation_bearing_leads)::int FROM run_source_observations WHERE run_id=r.id),0) citation_bearing_leads,
         COALESCE((SELECT sum(exact_pair_attestations)::int FROM run_source_observations WHERE run_id=r.id),0) exact_pair_attestations,
         (SELECT count(*)::int FROM research_containers WHERE run_id=r.id) containers_discovered,
         (SELECT count(*)::int FROM research_containers WHERE run_id=r.id AND status='complete') containers_enumerated,
         (SELECT count(*)::int FROM track_candidates WHERE run_id=r.id AND candidate_stage NOT IN ('discovered','identity_resolved')) scope_bound_candidates,
         (SELECT count(*)::int FROM track_candidates WHERE run_id=r.id AND candidate_stage IN ('claim_verified','version_compatible','catalog_resolved','playable','canonicalized','quota_eligible','sequenced','manifested','published')) evidence_qualified_candidates,
         (SELECT count(*)::int FROM catalog_matches WHERE run_id=r.id) apple_resolution_attempts,
         COALESCE((SELECT sum(metric_value)::int FROM provider_metric_events WHERE run_id=r.id AND provider='apple' AND metric_name='provider_requests'),0) apple_provider_requests,
         (SELECT count(*)::int FROM catalog_matches WHERE run_id=r.id AND status='accepted') apple_matches,
         (SELECT count(*)::int FROM recording_families WHERE run_id=r.id) recording_families,
         (SELECT count(*)::int FROM manifest_tracks mt JOIN manifests m ON m.id=mt.manifest_id WHERE m.run_id=r.id) selected_count,
         (SELECT count(*)::int FROM manifest_revision_reserve_tracks reserve JOIN manifest_revisions revision ON revision.id=reserve.manifest_revision_id JOIN manifests m ON m.id=revision.manifest_id WHERE m.run_id=r.id) reserve_count,
         (SELECT count(*)::int FROM manifest_revision_tracks track JOIN manifest_revisions revision ON revision.id=track.manifest_revision_id JOIN manifests m ON m.id=revision.manifest_id WHERE m.run_id=r.id) manifested_count,
         COALESCE((SELECT sum(volume.appended_count)::int FROM publication_volumes volume JOIN manifests m ON m.id=volume.manifest_id WHERE m.run_id=r.id),0) published_count
       FROM research_runs r
       LEFT JOIN run_active_query_plans active ON active.run_id=r.id
       WHERE r.id=$1`,
      [runId],
    );
    const row = summary.rows[0];
    if (!row) return;
    const outcome = row.pipeline_outcome_json && typeof row.pipeline_outcome_json === "object"
      ? row.pipeline_outcome_json as Record<string, unknown>
      : {};
    const integer = (key: string) => Math.max(0, Math.floor(Number(row[key] ?? 0) || 0));
    const stageKey = String(row.phase ?? "terminal").slice(0, 120);
    const stopReason = typeof outcome.stopReason === "string" ? outcome.stopReason.slice(0, 120) : null;
    const rootCause = typeof outcome.rootCause === "string" ? outcome.rootCause.slice(0, 160) : null;
    await this.pool.query(
      `INSERT INTO run_stage_metric_summaries(
         id,run_id,query_plan_revision_id,stage_key,metric_revision,provider_rows,
         unique_valid_leads,citation_bearing_leads,exact_pair_attestations,containers_discovered,
         containers_enumerated,scope_bound_candidates,evidence_qualified_candidates,
         apple_resolution_attempts,apple_provider_requests,apple_matches,recording_families,
         selected_count,reserve_count,manifested_count,published_count,stop_reason,root_cause,
         downstream_state,terminal)
       VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,true)
       ON CONFLICT DO NOTHING`,
      [
        deterministicUuid({ runId, stageKey, metricRevision: 1 }), runId,
        row.query_plan_revision_id ?? null, stageKey, integer("provider_rows"),
        integer("unique_valid_leads"), integer("citation_bearing_leads"),
        integer("exact_pair_attestations"), integer("containers_discovered"),
        integer("containers_enumerated"), integer("scope_bound_candidates"),
        integer("evidence_qualified_candidates"), integer("apple_resolution_attempts"),
        integer("apple_provider_requests"), integer("apple_matches"),
        integer("recording_families"), integer("selected_count"), integer("reserve_count"),
        integer("manifested_count"), integer("published_count"), stopReason, rootCause,
        String(row.status ?? "terminal").slice(0, 160),
      ],
    );
  }

  private async captureNormalizedQualityIncident(runId: string): Promise<void> {
    if (Number(await this.getSchemaVersion() ?? 0) < 16) return;
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT r.status,r.phase,r.pipeline_version,r.pipeline_outcome_json,r.brief_json,
         active.query_plan_revision_id,query.revision plan_revision,query.plan_json,
         access.id run_access_id,
         (SELECT count(*)::int FROM track_candidates WHERE run_id=r.id) candidate_count,
         (SELECT count(*)::int FROM catalog_matches WHERE run_id=r.id) apple_attempts,
         (SELECT count(*)::int FROM catalog_matches WHERE run_id=r.id AND status='accepted') apple_matches,
         (SELECT count(*)::int FROM manifest_tracks track JOIN manifests manifest ON manifest.id=track.manifest_id WHERE manifest.run_id=r.id) selected_count,
         COALESCE((SELECT sum(volume.appended_count)::int FROM publication_volumes volume JOIN manifests manifest ON manifest.id=volume.manifest_id WHERE manifest.run_id=r.id),0) published_count
       FROM research_runs r
       LEFT JOIN run_active_query_plans active ON active.run_id=r.id
       LEFT JOIN query_plan_revisions query ON query.id=active.query_plan_revision_id
       LEFT JOIN LATERAL (
         SELECT id FROM run_accesses WHERE run_id=r.id AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 1
       ) access ON true
       WHERE r.id=$1 AND r.deleted_at IS NULL`,
      [runId],
    );
    const row = result.rows[0];
    if (!row) return;
    const status = String(row.status ?? "");
    const phase = String(row.phase ?? "");
    if (!TERMINAL_RUN_STATUSES.includes(status) || phase === "owner_cancelled") return;
    const brief = row.brief_json && typeof row.brief_json === "object"
      ? row.brief_json as Record<string, unknown>
      : {};
    const targetSize = brief.targetSize && typeof brief.targetSize === "object"
      ? brief.targetSize as Record<string, unknown>
      : {};
    const target = Math.max(0, Math.floor(Number(targetSize.max ?? targetSize.min ?? 0) || 0));
    const candidates = Math.max(0, Number(row.candidate_count ?? 0) || 0);
    const appleAttempts = Math.max(0, Number(row.apple_attempts ?? 0) || 0);
    const selected = Math.max(0, Number(row.selected_count ?? 0) || 0);
    const catalogRichUnderfill = target > 0 && selected < Math.ceil(target * 0.9)
      && candidates >= target && appleAttempts >= target;
    let incidentClass: string | null = null;
    if (status === "failed_integrity") incidentClass = "failed_integrity";
    else if (status === "failed_system" || status === "failed") incidentClass = "failed_system";
    else if (status === "no_compatible_tracks") incidentClass = "no_compatible_tracks";
    else if (catalogRichUnderfill) incidentClass = "catastrophic_underfill";
    if (!incidentClass) return;
    const outcome = row.pipeline_outcome_json && typeof row.pipeline_outcome_json === "object"
      ? row.pipeline_outcome_json as Record<string, unknown>
      : {};
    const plan = row.plan_json && typeof row.plan_json === "object"
      ? row.plan_json as Record<string, unknown>
      : {};
    const zeroAppleUpstream = candidates > 0 && appleAttempts === 0;
    const stopReason = (typeof outcome.stopReason === "string" ? outcome.stopReason : phase || status).slice(0, 120);
    const rootCause = (zeroAppleUpstream
      ? "zero_apple_provider_requests_after_upstream_candidates"
      : typeof outcome.rootCause === "string" ? outcome.rootCause : incidentClass).slice(0, 160);
    const downstreamState = `${status}:${phase || "terminal"}`.slice(0, 160);
    const terminalOutcomeHash = sha256Hex(stableStringify({
      status, phase, target, candidates, appleAttempts, selected,
      published: Number(row.published_count ?? 0) || 0,
      planRevision: row.plan_revision ?? null,
    }));
    const signature = sha256Hex(stableStringify({
      incidentClass, stopReason, rootCause, downstreamState,
      pipelineVersion: row.pipeline_version ?? "unknown",
      queryPlanSchemaVersion: plan.schemaVersion ?? null,
    }));
    const eventHash = sha256Hex(`quality-incident\n${runId}\n${terminalOutcomeHash}`);
    const occurredAt = new Date();
    await this.transaction(async (client) => {
      const deduped = await client.query(
        `INSERT INTO quality_incident_event_keys(event_hash,incident_date)
         VALUES($1,($2::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date)
         ON CONFLICT(event_hash) DO NOTHING RETURNING event_hash`,
        [eventHash, occurredAt],
      );
      if (!deduped.rows[0]) return;
      const counter = await client.query<{ detailed_count: number }>(
        `INSERT INTO quality_incident_daily_counters(incident_date)
         VALUES(($1::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date)
         ON CONFLICT(incident_date) DO UPDATE SET updated_at=now()
         RETURNING detailed_count`,
        [occurredAt],
      );
      const detailed = Number(counter.rows[0]?.detailed_count ?? 0) < 100;
      const groupId = deterministicUuid({ kind: "quality_incident_group", signature });
      await client.query(
        `INSERT INTO quality_incident_groups(
           id,incident_signature,incident_class,stop_reason,root_cause,downstream_state,
           first_seen_at,last_seen_at,total_count,overflow_count,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz,$7::timestamptz,1,$8,
           $7::timestamptz+interval '13 months')
         ON CONFLICT(incident_signature) DO UPDATE SET
           last_seen_at=EXCLUDED.last_seen_at,total_count=quality_incident_groups.total_count+1,
           overflow_count=quality_incident_groups.overflow_count+EXCLUDED.overflow_count,
           expires_at=GREATEST(quality_incident_groups.expires_at,EXCLUDED.expires_at),updated_at=now()`,
        [groupId, signature, incidentClass, stopReason, rootCause, downstreamState,
          occurredAt, detailed ? 0 : 1],
      );
      await client.query(
        `UPDATE quality_incident_daily_counters SET
           detailed_count=detailed_count+$2,overflow_count=overflow_count+$3,updated_at=now()
         WHERE incident_date=($1::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date`,
        [occurredAt, detailed ? 1 : 0, detailed ? 0 : 1],
      );
      if (!detailed) return;
      await client.query(
        `INSERT INTO quality_incident_occurrences(
           id,group_id,run_id,run_access_id,plan_revision,terminal_outcome_hash,
           stop_reason,root_cause,downstream_state,diagnostics_json,idempotency_key,occurred_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
        [
          randomUUID(), groupId, runId, row.run_access_id ?? null,
          row.plan_revision ?? null, terminalOutcomeHash, stopReason, rootCause, downstreamState,
          JSON.stringify({
            targetTrackCount: target,
            candidateCount: candidates,
            appleResolutionAttempts: appleAttempts,
            appleMatches: Number(row.apple_matches ?? 0) || 0,
            selectedCount: selected,
            publishedCount: Number(row.published_count ?? 0) || 0,
            queryPlanSchemaVersion: typeof plan.schemaVersion === "number" ? plan.schemaVersion : null,
          }),
          `quality:${eventHash}`.slice(0, 160), occurredAt,
        ],
      );
    });
  }

  private async captureTerminalDiagnosticsSafely(runId: string): Promise<void> {
    try {
      await this.persistTerminalStageMetricSummary(runId);
      await this.captureNormalizedQualityIncident(runId);
    } catch (error) {
      console.error("[quality-diagnostics] terminal capture failed", {
        runId,
        message: error instanceof Error ? error.message.slice(0, 500) : "unknown error",
      });
    }
  }

  async updateRun(id: string, values: {
    status?: string;
    phase?: string;
    costDelta?: number;
    approvedBudget?: number;
    noNewGapPasses?: number;
    error?: string | null;
  }, fence?: PipelineV3WriteFence): Promise<void> {
    const costDelta = values.costDelta == null ? 0 : finiteMoney(values.costDelta, "Cost delta");
    const persistedError = values.error === undefined
      ? undefined
      : sanitizeOptionalFailure(values.error, failureContextForRun(values.phase));
    const sql = `UPDATE research_runs SET
         status=COALESCE($2,status), phase=COALESCE($3,phase), actual_cost_usd=actual_cost_usd+$4,
         approved_budget_usd=COALESCE($5,approved_budget_usd), no_new_gap_passes=COALESCE($6,no_new_gap_passes),
         error=CASE WHEN $7::boolean THEN $8 ELSE error END,
         budget_approval_expires_at=CASE
           WHEN $2::varchar='awaiting_budget' THEN now()+interval '7 days'
           WHEN $2::varchar='queued' THEN NULL
           ELSE budget_approval_expires_at
         END,
         completed_at=CASE WHEN COALESCE($2,status) IN (
           'complete','partial','no_compatible_tracks','cancelled',
           'failed','failed_system','failed_integrity','expired','deleted'
         ) THEN COALESCE(completed_at,now()) ELSE completed_at END,
         updated_at=now()
       WHERE id=$1
         AND NOT (status='failed' AND phase='owner_cancelled')
         AND NOT (status='cancelled' OR phase='visitor_cancelled')
         AND NOT (status='deleted' OR phase='visitor_deleted')`;
    const parameters = [
      id,
      values.status ?? null,
      values.phase ?? null,
      costDelta,
      values.approvedBudget ?? null,
      values.noNewGapPasses ?? null,
      values.error !== undefined,
      persistedError ?? null,
    ];
    const result = fence
      ? await this.transaction(async (client) => {
        await this.assertPipelineV3WriteFence(client, id, fence);
        return await client.query(sql, parameters);
      })
      : await this.pool.query(sql, parameters);
    if (result.rowCount === 0) throw new HttpError(404, "Research run not found", "run_not_found");
    if (values.status && classifyAutomaticRunFailure(values.status, values.phase ?? null)) {
      await this.captureAutomaticRunFailureSafely(id);
    }
    if (values.status && TERMINAL_RUN_STATUSES.includes(values.status)) {
      await this.captureTerminalDiagnosticsSafely(id);
    }
    if (values.status === "complete" || values.status === "partial") {
      // Publication is already durable at this point. Project only a complete,
      // stable, public-safe subset into the browseable directory. A failure to
      // satisfy every invariant returns null and leaves any prior listing
      // untouched; no operational run fields cross this boundary.
      await this.upsertPublicPlaylistDirectoryForRun(id);
    }
  }

  private async getRunRow(id: string): Promise<any | null> {
    const result = await this.pool.query("SELECT * FROM research_runs WHERE id=$1 AND deleted_at IS NULL", [id]);
    return result.rows[0] ?? null;
  }

  /**
   * Load the immutable, active V3 execution contract.  A run is never
   * interpreted from mutable prompt prose here: both the query-plan hash and
   * its locked evidence snapshot are verified before the worker may see it.
   */
  async getActiveQueryPlan(runId: string): Promise<QueryPlanV3 | null> {
    const schemaVersion = Number(await this.getSchemaVersion() ?? 0);
    if (schemaVersion < 14) return null;
    const result = await this.pool.query<{
      plan_json: unknown;
      plan_hash: string;
      graph_snapshot_id: string;
      plan_status: string;
      snapshot_status: string;
      selection_status: string;
      selection_plan_hash: string;
      pipeline_version: string;
      policy_version: string;
    }>(
      `SELECT q.plan_json,q.plan_hash,q.graph_snapshot_id,
              q.status AS plan_status,g.status AS snapshot_status,
              s.status AS selection_status,s.plan_hash AS selection_plan_hash,
              q.pipeline_version,q.policy_version
       FROM run_active_query_plans a
       JOIN query_plan_revisions q ON q.id=a.query_plan_revision_id
       JOIN selection_plans s ON s.id=q.selection_plan_id
       JOIN graph_snapshots g ON g.id=q.graph_snapshot_id
       WHERE a.run_id=$1`,
      [runId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.plan_status !== "active" || row.snapshot_status !== "locked"
      || row.selection_status !== "active"
      || row.pipeline_version !== "corpus_first_v3"
      || row.policy_version !== "corpus_first_v3_policy_v1"
      || !isQueryPlanV3(row.plan_json)
      || row.plan_json.selectionPlanHash !== row.selection_plan_hash
      || row.plan_json.graphSnapshotId !== row.graph_snapshot_id
      || queryPlanV3Hash(row.plan_json) !== row.plan_hash) {
      throw new HttpError(500, "Pipeline V3 query plan failed integrity validation", "v3_query_plan_integrity");
    }
    return row.plan_json;
  }

  /**
   * Explicitly attach a confirmed corpus-first plan to a run that has not
   * started paid work. This bridge is intentionally not called by public run
   * creation or rollout assignment: activation remains an owner/canary action
   * until the V3 worker path is proven.
   *
   * The V2 selection_plan_json column is deliberately untouched. V3 workers
   * consume only the active query-plan revision and its locked graph snapshot.
   */
  async activatePipelineV3Run(input: {
    runId: string;
    selectionPlan: SelectionPlanV3;
    graphSnapshotId: string;
  }): Promise<{
    runId: string;
    queryPlanRevisionId: string;
    revision: number;
    queryPlan: QueryPlanV3;
    planHash: string;
    idempotent: boolean;
  }> {
    return this.transaction(async (client) => {
      const schema = await client.query<{ value: string }>(
        "SELECT value FROM settings WHERE key='schema_version' FOR SHARE",
      );
      const schemaVersion = Number(schema.rows[0]?.value ?? 0);
      if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 14) {
        throw new HttpError(503, "Pipeline V3 requires database schema 14", "v3_schema_unavailable");
      }

      const selected = await client.query<{
        status: string;
        phase: string;
        deleted_at: Date | null;
        selection_plan_json: SelectionPlan | null;
        raw_prompt: string | null;
        requested_track_count: number | null;
        storefront: string | null;
        guidance_answers_json: PlaylistGuidanceAnswer[] | null;
        guidance_source_hints_json: unknown[] | null;
        spec_hash: string | null;
        spec_pipeline_version: string | null;
        spec_policy_version: string | null;
        brief_contract_version: number;
        active_playlist_contract_revision_id: string | null;
        playlist_contract_json: PlaylistContractRevisionV1 | null;
      }>(
        `SELECT r.status,r.phase,r.deleted_at,r.selection_plan_json,
                s.raw_prompt,s.requested_track_count,s.storefront,s.guidance_answers_json,
                s.guidance_source_hints_json,
                s.spec_hash,s.pipeline_version spec_pipeline_version,
                s.policy_version spec_policy_version,
                ${schemaVersion >= 16 ? "s.brief_contract_version" : "1::integer AS brief_contract_version"},
                ${schemaVersion >= 17
                  ? "r.active_playlist_contract_revision_id,playlist_contract.contract_json playlist_contract_json"
                  : "NULL::uuid active_playlist_contract_revision_id,NULL::jsonb playlist_contract_json"}
         FROM research_runs r
         LEFT JOIN run_specs s ON s.run_id=r.id
         ${schemaVersion >= 17
           ? `LEFT JOIN playlist_contract_revisions playlist_contract
                ON playlist_contract.id=r.active_playlist_contract_revision_id
                  AND playlist_contract.status='active'`
           : ""}
         WHERE r.id=$1 FOR UPDATE OF r`,
        [input.runId],
      );
      const run = selected.rows[0];
      if (!run || run.deleted_at) {
        throw new HttpError(404, "Research run not found", "run_not_found");
      }
      if (!run.raw_prompt || !Number.isInteger(run.requested_track_count)
        || !run.storefront || !run.spec_hash
        || run.spec_pipeline_version !== "corpus_first_v3"
        || run.spec_policy_version !== "corpus_first_v3_policy_v1") {
        throw new HttpError(
          409,
          "Pipeline V3 cannot reinterpret a legacy or incomplete immutable run specification",
          "v3_run_spec_incompatible",
        );
      }
      const immutableSpecHash = sha256Hex(stableStringify({
        rawPrompt: run.raw_prompt,
        requestedTrackCount: Number(run.requested_track_count),
        storefront: run.storefront,
        guidanceAnswers: Array.isArray(run.guidance_answers_json) ? run.guidance_answers_json : [],
        guidanceSourceHints: Array.isArray(run.guidance_source_hints_json) ? run.guidance_source_hints_json : [],
        ...(Number(run.brief_contract_version) === 3
          ? {
              briefContractVersion: 3 as const,
              playlistContractRevisionId: run.playlist_contract_json?.revisionId,
              playlistContractSemanticHash: run.playlist_contract_json?.semanticHash,
            }
          : Number(run.brief_contract_version) === 2
            ? { briefContractVersion: 2 as const }
            : {}),
        pipelineVersion: run.spec_pipeline_version,
        policyVersion: run.spec_policy_version,
      }));
      if (immutableSpecHash !== run.spec_hash
        || input.selectionPlan.prompt.trim() !== run.raw_prompt.trim()
        || input.selectionPlan.requestedTrackCount !== Number(run.requested_track_count)
        || input.selectionPlan.storefront !== run.storefront
        || stableStringify(input.selectionPlan.sourceDiscoveryHints)
          !== stableStringify(Array.isArray(run.guidance_source_hints_json) ? run.guidance_source_hints_json : [])) {
        throw new HttpError(
          409,
          "Confirmed V3 plan does not match the immutable run specification",
          "v3_run_spec_mismatch",
        );
      }
      let contract: ReturnType<typeof createPipelineV3ActivationContract>;
      try {
        if (Number(run.brief_contract_version) === 3
          && (!run.active_playlist_contract_revision_id
            || !run.playlist_contract_json
            || run.playlist_contract_json.revisionId.length < 1
            || run.playlist_contract_json.semanticHash.length < 1)) {
          throw new Error("Canonical playlist contract is not active");
        }
        contract = createPipelineV3ActivationContract(
          input.selectionPlan,
          input.graphSnapshotId,
          Number(run.brief_contract_version) === 3 && run.playlist_contract_json
            ? {
                briefContractVersion: 3,
                playlistContractRevisionId: run.playlist_contract_json.revisionId,
                playlistContractSemanticHash: run.playlist_contract_json.semanticHash,
                playlistContractCompilerVersion: run.playlist_contract_json.versions.compiler,
              }
            : {},
        );
      } catch (error) {
        throw new HttpError(
          409,
          error instanceof Error ? error.message : "Pipeline V3 selection plan is not confirmed",
          "v3_activation_plan_invalid",
        );
      }
      const selectionPlanHash = selectionPlanV3Hash(input.selectionPlan);
      if (contract.queryPlan.selectionPlanHash !== selectionPlanHash) {
        throw new HttpError(500, "Pipeline V3 selection/query plan binding failed", "v3_selection_plan_integrity");
      }

      const snapshot = await client.query<{ status: string }>(
        "SELECT status FROM graph_snapshots WHERE id=$1 FOR SHARE",
        [input.graphSnapshotId],
      );
      const precondition = pipelineV3ActivationPreconditionFailure({
        schemaVersion,
        runStatus: run.status,
        deleted: false,
        snapshotStatus: snapshot.rows[0]?.status ?? null,
      });
      if (precondition === "run_in_flight") {
        throw new HttpError(
          409,
          `Pipeline V3 can be activated only while a run is queued or awaiting guidance (current status: ${run.status})`,
          "v3_activation_run_in_flight",
        );
      }
      if (precondition === "snapshot_not_locked") {
        throw new HttpError(409, "Pipeline V3 requires a locked evidence graph snapshot", "v3_snapshot_not_locked");
      }
      if (precondition) {
        throw new HttpError(409, "Pipeline V3 activation preconditions failed", `v3_activation_${precondition}`);
      }

      // A worker that already owns the run is in flight even if a stale run
      // status still reads queued during its first transition.
      const leased = await client.query(
        `SELECT 1 FROM job_queue
         WHERE run_id=$1 AND status='leased' AND lease_expires_at>now()
         LIMIT 1 FOR UPDATE`,
        [input.runId],
      );
      if (leased.rows[0]) {
        throw new HttpError(409, "Pipeline V3 cannot replace a plan leased by a worker", "v3_activation_run_in_flight");
      }

      const active = await client.query<{
        id: string;
        revision: number;
        graph_snapshot_id: string;
        status: string;
        plan_hash: string;
        plan_json: unknown;
        selection_plan_hash: string;
      }>(
        `SELECT q.id,q.revision,q.graph_snapshot_id,q.status,q.plan_hash,q.plan_json,
                s.plan_hash selection_plan_hash
         FROM run_active_query_plans a
         JOIN query_plan_revisions q ON q.id=a.query_plan_revision_id
         JOIN selection_plans s ON s.id=q.selection_plan_id
         WHERE a.run_id=$1
         FOR UPDATE OF a,q`,
        [input.runId],
      );
      const current = active.rows[0];
      // A global schema-emission switch must never reinterpret an immutable
      // active run. If the confirmed selection plan and graph snapshot are the
      // same, the stored query plan remains authoritative even when the current
      // compiler would emit a newer schema.
      if (current
        && current.selection_plan_hash === selectionPlanHash
        && current.graph_snapshot_id === input.graphSnapshotId) {
        if (current.status !== "active"
          || !isQueryPlanV3(current.plan_json)
          || queryPlanV3Hash(current.plan_json) !== current.plan_hash) {
          throw new HttpError(500, "Existing Pipeline V3 plan failed integrity validation", "v3_query_plan_integrity");
        }
        await client.query(
          `UPDATE research_runs SET pipeline_version='corpus_first_v3',
             policy_version='corpus_first_v3_policy_v1',updated_at=now()
           WHERE id=$1`,
          [input.runId],
        );
        return {
          runId: input.runId,
          queryPlanRevisionId: current.id,
          revision: current.revision,
          queryPlan: current.plan_json,
          planHash: current.plan_hash,
          idempotent: true,
        };
      }
      if (current?.plan_hash === contract.planHash) {
        if (current.status !== "active"
          || current.graph_snapshot_id !== input.graphSnapshotId
          || current.selection_plan_hash !== selectionPlanHash
          || !isQueryPlanV3(current.plan_json)
          || queryPlanV3Hash(current.plan_json) !== contract.planHash) {
          throw new HttpError(500, "Existing Pipeline V3 plan failed integrity validation", "v3_query_plan_integrity");
        }
        await client.query(
          `UPDATE research_runs SET pipeline_version='corpus_first_v3',
             policy_version='corpus_first_v3_policy_v1',updated_at=now()
           WHERE id=$1`,
          [input.runId],
        );
        return {
          runId: input.runId,
          queryPlanRevisionId: current.id,
          revision: current.revision,
          queryPlan: contract.queryPlan,
          planHash: contract.planHash,
          idempotent: true,
        };
      }

      const latest = await client.query<{ id: string; revision: number }>(
        `SELECT id,revision FROM query_plan_revisions
         WHERE run_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
        [input.runId],
      );
      const duplicate = await client.query<{ id: string }>(
        "SELECT id FROM query_plan_revisions WHERE run_id=$1 AND plan_hash=$2 LIMIT 1 FOR UPDATE",
        [input.runId, contract.planHash],
      );
      if (duplicate.rows[0]) {
        throw new HttpError(
          409,
          "This immutable Pipeline V3 plan already exists as an inactive revision",
          "v3_query_plan_revision_inactive",
        );
      }

      const revision = (latest.rows[0]?.revision ?? 0) + 1;
      const priorSelection = await client.query<{ id: string; revision: number; status: string }>(
        `SELECT id,revision,status FROM selection_plans
         WHERE run_id=$1 AND plan_hash=$2 LIMIT 1 FOR UPDATE`,
        [input.runId, selectionPlanHash],
      );
      let selectionPlanId = priorSelection.rows[0]?.id ?? null;
      if (!selectionPlanId) {
        const latestSelection = await client.query<{ revision: number }>(
          `SELECT revision FROM selection_plans
           WHERE run_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
          [input.runId],
        );
        selectionPlanId = randomUUID();
        await client.query(
          `INSERT INTO selection_plans(
             id,run_id,revision,status,plan_hash,plan_json,pipeline_version,policy_version,confirmed_at)
           VALUES($1,$2,$3,'active',$4,$5::jsonb,'corpus_first_v3','corpus_first_v3_policy_v1',now())`,
          [
            selectionPlanId,
            input.runId,
            (latestSelection.rows[0]?.revision ?? 0) + 1,
            selectionPlanHash,
            JSON.stringify(input.selectionPlan),
          ],
        );
      } else if (priorSelection.rows[0]?.status !== "active") {
        await client.query("UPDATE selection_plans SET status='active' WHERE id=$1", [selectionPlanId]);
      }
      await client.query(
        "UPDATE selection_plans SET status='superseded' WHERE run_id=$1 AND id<>$2 AND status='active'",
        [input.runId, selectionPlanId],
      );
      const revisionId = randomUUID();
      await client.query(
        `INSERT INTO query_plan_revisions(
           id,run_id,selection_plan_id,revision,parent_revision_id,graph_snapshot_id,engine,status,
           plan_hash,plan_json,pipeline_version,policy_version,activated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$9::jsonb,
           'corpus_first_v3','corpus_first_v3_policy_v1',now())`,
        [
          revisionId,
          input.runId,
          selectionPlanId,
          revision,
          latest.rows[0]?.id ?? null,
          input.graphSnapshotId,
          contract.queryPlan.engine,
          contract.planHash,
          JSON.stringify(contract.queryPlan),
        ],
      );
      await client.query(
        `INSERT INTO run_active_query_plans(run_id,query_plan_revision_id,activated_at)
         VALUES($1,$2,now())
         ON CONFLICT(run_id) DO UPDATE SET
           query_plan_revision_id=EXCLUDED.query_plan_revision_id,activated_at=EXCLUDED.activated_at`,
        [input.runId, revisionId],
      );
      await client.query(
        `UPDATE query_plan_revisions SET status='superseded'
         WHERE run_id=$1 AND id<>$2 AND status='active'`,
        [input.runId, revisionId],
      );
      const updated = await client.query<{ selection_plan_json: SelectionPlan | null }>(
        `UPDATE research_runs SET pipeline_version='corpus_first_v3',
           policy_version='corpus_first_v3_policy_v1',updated_at=now()
         WHERE id=$1 RETURNING selection_plan_json`,
        [input.runId],
      );
      if (stableStringify(updated.rows[0]?.selection_plan_json ?? null)
        !== stableStringify(run.selection_plan_json ?? null)) {
        throw new HttpError(500, "V3 activation modified the legacy selection plan", "v3_activation_selection_plan_changed");
      }

      return {
        runId: input.runId,
        queryPlanRevisionId: revisionId,
        revision,
        queryPlan: contract.queryPlan,
        planHash: contract.planHash,
        idempotent: false,
      };
    });
  }

  async getRunControlState(id: string): Promise<{ status: string; phase: string } | null> {
    const result = await this.pool.query<{ status: string; phase: string }>(
      "SELECT status,phase FROM research_runs WHERE id=$1 AND deleted_at IS NULL",
      [id],
    );
    return result.rows[0] ?? null;
  }

  private async getRunResolution(
    runId: string,
    status: RunStatus,
    phase: string,
  ): Promise<RunResolutionView> {
    const schemaVersion = Number(await this.getSchemaVersion() ?? 0);
    if (schemaVersion < 17) {
      const projected = projectNeverDeadEndRun({ status, phase });
      return {
        ...projected,
        contractRevisionId: null,
        contractRevision: null,
        contractHash: null,
        blocker: null,
      };
    }
    const result = await this.pool.query<{
      contract_revision_id: string | null;
      contract_revision: number | null;
      contract_hash: string | null;
      blocker_kind: string | null;
      retry_count: number | null;
      next_retry_at: Date | null;
      automatic_retry_until: Date | null;
      blocker_state_json: Record<string, unknown> | null;
    }>(
      `SELECT
         contract.id contract_revision_id,
         contract.revision contract_revision,
         contract.contract_hash,
         blocker.blocker_kind,
         blocker.retry_count,
         blocker.next_retry_at,
         blocker.automatic_retry_until,
         blocker.state_json blocker_state_json
       FROM research_runs run
       LEFT JOIN playlist_contract_revisions contract
         ON contract.id=run.active_playlist_contract_revision_id
       LEFT JOIN LATERAL (
         SELECT blocker_kind,retry_count,next_retry_at,automatic_retry_until,state_json
         FROM playlist_run_blockers
         WHERE run_id=run.id AND resolved_at IS NULL
           AND (
             contract.id IS NULL
             OR contract_revision_id=contract.id
           )
         ORDER BY created_at DESC,id DESC
         LIMIT 1
       ) blocker ON true
       WHERE run.id=$1`,
      [runId],
    );
    const row = result.rows[0];
    const blockerKind = row?.blocker_kind ?? null;
    const guidanceRound = row?.blocker_state_json?.guidanceRound === "rescue"
      ? "rescue"
      : "initial";
    const projected = blockerKind === "provider"
      ? { state: "blocked_dependency" as const, nextAction: "wait_for_dependency" as const, terminal: false }
      : blockerKind === "apple_authorization"
        ? { state: "blocked_dependency" as const, nextAction: "authorize_apple" as const, terminal: false }
        : blockerKind === "guidance"
          ? {
              state: "needs_input" as const,
              nextAction: guidanceRound === "rescue"
                ? "answer_rescue_guidance" as const
                : "answer_initial_guidance" as const,
              terminal: false,
            }
          : blockerKind === "scope_decision" || blockerKind === "budget"
            ? { state: "needs_decision" as const, nextAction: "review_contract" as const, terminal: false }
            : blockerKind === "integrity" || blockerKind === "publication_reconciliation"
              ? { state: "quarantined" as const, nextAction: "contact_support" as const, terminal: false }
              : projectNeverDeadEndRun({
                  status,
                  phase,
                  retryableDependency: false,
                  rescueQuestionsAvailable: true,
                });
    return {
      ...projected,
      contractRevisionId: row?.contract_revision_id ?? null,
      contractRevision: row?.contract_revision == null ? null : Number(row.contract_revision),
      contractHash: row?.contract_hash ?? null,
      blocker: blockerKind ? {
        kind: blockerKind,
        nextRetryAt: row?.next_retry_at?.toISOString() ?? null,
        automaticRetryUntil: row?.automatic_retry_until?.toISOString() ?? null,
        retryCount: Number(row?.retry_count ?? 0),
      } : null,
    };
  }

  private async getRunDecisionState(runId: string): Promise<unknown | null> {
    if (Number(await this.getSchemaVersion() ?? 0) < 17) return null;
    const result = await this.pool.query<{
      contract_json: PlaylistContractRevisionV1 | null;
      checkpoint_state: unknown | null;
      blocker_state: unknown | null;
    }>(
      `SELECT contract.contract_json,
              checkpoint.state_json checkpoint_state,
              blocker.state_json blocker_state
       FROM research_runs run
       LEFT JOIN playlist_contract_revisions contract
         ON contract.id=run.active_playlist_contract_revision_id
           AND contract.status='active'
       LEFT JOIN research_checkpoints checkpoint
         ON checkpoint.run_id=run.id AND checkpoint.phase='run_decision'
       LEFT JOIN LATERAL (
         SELECT state_json
         FROM playlist_run_blockers
         WHERE run_id=run.id
           AND contract_revision_id=run.active_playlist_contract_revision_id
           AND blocker_kind='scope_decision'
           AND resolved_at IS NULL
         ORDER BY created_at DESC,id DESC
         LIMIT 1
       ) blocker ON true
       WHERE run.id=$1 AND run.deleted_at IS NULL`,
      [runId],
    );
    const row = result.rows[0];
    const semanticHash = row?.contract_json?.semanticHash;
    for (const value of [row?.checkpoint_state, row?.blocker_state]) {
      const decision = publicAdaptiveRunDecisionV1(value);
      if (decision && decision.contractSemanticHash === semanticHash) return decision;
    }
    return null;
  }

  async getPublicationCompleteness(runId: string, manifestId: string): Promise<{
    omittedCandidateCount: number;
    unresolvedCoverageCount: number;
  }> {
    const result = await this.pool.query<{
      mode: string;
      target_minimum: number | null;
      manifest_track_count: number;
      omitted_candidate_count: number;
      unresolved_coverage_count: number;
      curated_quality_gap_count: number;
    }>(
      `SELECT
         r.brief_json->>'mode' AS mode,
         NULLIF(r.brief_json #>> '{targetSize,min}','')::int AS target_minimum,
         (SELECT count(*)::int FROM manifest_tracks mt
          WHERE mt.manifest_id=$2) AS manifest_track_count,
         (SELECT count(*)::int FROM track_candidates c
          WHERE c.run_id=$1 AND c.outcome<>'duplicate'
            AND NOT EXISTS (
              SELECT 1 FROM manifest_tracks mt WHERE mt.manifest_id=$2 AND mt.candidate_id=c.id
            )) AS omitted_candidate_count,
         ((SELECT count(*)::int FROM source_frontier f
           WHERE f.run_id=$1 AND (
             f.status IN ('pending','unresolved','inaccessible') OR f.discovered_count>f.recovered_count
           ))
          +
          (SELECT count(*)::int FROM research_containers c
           WHERE c.run_id=$1 AND (
             c.status IN ('discovered','enumerating','inaccessible','unresolved')
             OR (c.advertised_total IS NOT NULL AND c.advertised_total>c.recovered_total)
           ))) AS unresolved_coverage_count,
         COALESCE((SELECT CASE
           WHEN COALESCE((rc.state_json->>'artistShortfall')::int,0)>0 THEN 1 ELSE 0 END
           FROM research_checkpoints rc
           WHERE rc.run_id=$1 AND rc.phase='catalog_matching_outcome'),0)::int AS curated_quality_gap_count
       FROM research_runs r
       WHERE r.id=$1`,
      [runId, manifestId],
    );
    const row = result.rows[0];
    const mode = row?.mode === "curated" || row?.mode === "hybrid"
      ? row.mode
      : "exhaustive";
    return resolvePublicationCompleteness({
      mode,
      targetMinimum: row?.target_minimum == null ? null : Number(row.target_minimum),
      manifestTrackCount: Number(row?.manifest_track_count ?? 0),
      omittedCandidateCount: Number(row?.omitted_candidate_count ?? 0),
      unresolvedCoverageCount: Number(row?.unresolved_coverage_count ?? 0),
      curatedQualityGapCount: Number(row?.curated_quality_gap_count ?? 0),
    });
  }

  async getRun(id: string): Promise<ResearchRunView & Record<string, unknown>> {
    const row = await this.getRunRow(id);
    if (!row) throw new HttpError(404, "Research run not found", "run_not_found");
    const [
      counts,
      frontier,
      partialCheckpoint,
      semanticCheckpoint,
      decisionCheckpoint,
      explore,
      queryPlan,
      resolution,
      guidanceAction,
    ] = await Promise.all([
      this.pool.query(
        `SELECT
          (SELECT count(*)::int FROM track_candidates WHERE run_id=$1) candidate_count,
          (SELECT count(*)::int FROM source_records WHERE run_id=$1) source_count,
          (SELECT COALESCE(jsonb_agg(to_jsonb(recent) - 'retrieved_at' ORDER BY recent.retrieved_at DESC),'[]'::jsonb)
           FROM (
             SELECT title,url,source_class,retrieved_at
             FROM source_records
             WHERE run_id=$1 AND url LIKE 'https://%'
             ORDER BY retrieved_at DESC,id DESC LIMIT 8
           ) recent) recent_sources,
          COALESCE((
            SELECT jsonb_object_agg(staged.candidate_stage,staged.stage_count)
            FROM (
              SELECT candidate_stage,count(*)::int stage_count
              FROM track_candidates WHERE run_id=$1 GROUP BY candidate_stage
            ) staged
          ),'{}'::jsonb) candidate_stage_counts,
          (SELECT count(*)::int FROM source_frontier WHERE run_id=$1) frontier_total,
          (SELECT count(*) FILTER (WHERE status='complete')::int FROM source_frontier WHERE run_id=$1) frontier_complete,
          (SELECT count(*) FILTER (WHERE status='pending')::int FROM source_frontier WHERE run_id=$1) frontier_active,
          (SELECT count(*) FILTER (WHERE status='unresolved')::int FROM source_frontier WHERE run_id=$1) frontier_unresolved,
          (SELECT count(*) FILTER (WHERE status='inaccessible')::int FROM source_frontier WHERE run_id=$1) frontier_inaccessible,
          (SELECT COALESCE(sum(discovered_count),0)::int FROM source_frontier WHERE run_id=$1) frontier_discovered_count,
          (SELECT COALESCE(sum(recovered_count),0)::int FROM source_frontier WHERE run_id=$1) frontier_recovered_count,
          (SELECT count(*)::int FROM research_containers WHERE run_id=$1) container_total,
          (SELECT count(*) FILTER (WHERE status='complete')::int FROM research_containers WHERE run_id=$1) container_complete,
          (SELECT count(*) FILTER (WHERE status IN ('discovered','enumerating'))::int FROM research_containers WHERE run_id=$1) container_active,
          (SELECT count(*) FILTER (WHERE status='unresolved')::int FROM research_containers WHERE run_id=$1) container_unresolved,
          (SELECT count(*) FILTER (WHERE status='inaccessible')::int FROM research_containers WHERE run_id=$1) container_inaccessible,
          (SELECT COALESCE(sum(advertised_total),0)::int FROM research_containers WHERE run_id=$1) container_advertised_count,
          (SELECT COALESCE(sum(recovered_total),0)::int FROM research_containers WHERE run_id=$1) container_recovered_count,
          (SELECT count(*)::int FROM catalog_matches WHERE run_id=$1) match_attempted,
          (SELECT count(*) FILTER (WHERE status='accepted')::int FROM catalog_matches WHERE run_id=$1) match_accepted,
          (SELECT count(*) FILTER (WHERE status='review')::int FROM catalog_matches WHERE run_id=$1) match_review,
          (SELECT count(*) FILTER (WHERE status='unavailable')::int FROM catalog_matches WHERE run_id=$1) match_unavailable,
          (SELECT count(*) FILTER (WHERE status='duplicate')::int FROM catalog_matches WHERE run_id=$1) match_duplicate,
          (SELECT count(*) FILTER (WHERE status='rejected')::int FROM catalog_matches WHERE run_id=$1) match_rejected,
          (SELECT count(*) FILTER (WHERE status='unsupported')::int FROM catalog_matches WHERE run_id=$1) match_unsupported,
          (SELECT count(*) FILTER (WHERE status='overflow')::int FROM catalog_matches WHERE run_id=$1) match_overflow,
          (SELECT count(*)::int FROM publication_volumes pv
             JOIN manifests m ON m.id=pv.manifest_id WHERE m.run_id=$1) publication_volume_count,
          (SELECT count(*) FILTER (WHERE pv.status='complete')::int FROM publication_volumes pv
             JOIN manifests m ON m.id=pv.manifest_id WHERE m.run_id=$1) publication_completed_volumes,
          (SELECT COALESCE(sum(GREATEST(pv.end_position-pv.start_position+1,0)),0)::int FROM publication_volumes pv
             JOIN manifests m ON m.id=pv.manifest_id WHERE m.run_id=$1) publication_total_tracks,
          (SELECT COALESCE(sum(pv.appended_count),0)::int FROM publication_volumes pv
             JOIN manifests m ON m.id=pv.manifest_id WHERE m.run_id=$1) publication_appended_tracks,
          (SELECT pv.volume_number FROM publication_volumes pv
             JOIN manifests m ON m.id=pv.manifest_id
             WHERE m.run_id=$1 AND pv.status<>'complete'
             ORDER BY pv.volume_number LIMIT 1) publication_current_volume,
          (SELECT pv.status FROM publication_volumes pv
             JOIN manifests m ON m.id=pv.manifest_id WHERE m.run_id=$1
             ORDER BY CASE WHEN pv.status='complete' THEN 1 ELSE 0 END,pv.volume_number LIMIT 1) publication_status,
          (SELECT max(activity_at) FROM (
             SELECT updated_at activity_at FROM research_runs WHERE id=$1
             UNION ALL SELECT retrieved_at FROM source_records WHERE run_id=$1
             UNION ALL SELECT updated_at FROM research_containers WHERE run_id=$1
             UNION ALL SELECT stage_updated_at FROM track_candidates WHERE run_id=$1
             UNION ALL SELECT updated_at FROM research_checkpoints WHERE run_id=$1
             UNION ALL SELECT created_at FROM manifests WHERE run_id=$1
             UNION ALL SELECT pv.updated_at FROM publication_volumes pv
               JOIN manifests m ON m.id=pv.manifest_id WHERE m.run_id=$1
           ) activity) latest_activity_at,
          ((SELECT count(*)::int FROM source_frontier
             WHERE run_id=$1 AND status IN ('pending','unresolved','inaccessible')) +
          (SELECT count(*)::int FROM research_containers
             WHERE run_id=$1 AND status IN ('discovered','enumerating','inaccessible','unresolved'))
          + COALESCE((SELECT CASE
              WHEN COALESCE((state_json->>'artistShortfall')::int,0)>0 THEN 1 ELSE 0 END
            FROM research_checkpoints
            WHERE run_id=$1 AND phase='catalog_matching_outcome'),0)) unresolved_count`,
        [id],
      ),
      this.getFrontier(id),
      this.getResearchCheckpoint(id, "partial_ready"),
      this.getResearchCheckpoint(id, "semantic_diagnostics"),
      this.getRunDecisionState(id),
      this.getRunExplorePreference(id),
      this.getActiveQueryPlan(id),
      this.getRunResolution(id, row.status, row.phase),
      this.getPlaylistRunRescueGuidance(id),
    ]);
    const count = counts.rows[0];
    const requestedTrackCount = progressOptionalCount(
      row.selection_plan_json?.requestedTrackCount
        ?? row.brief_json?.targetSize?.max
        ?? row.brief_json?.targetSize?.min,
    );
    const targetTrackCount = requestedTrackCount && requestedTrackCount > 0
      ? requestedTrackCount
      : null;
    const matchAccepted = progressCount(count.match_accepted);
    const semanticDiagnostics = objectRecord(semanticCheckpoint);
    const recovery = objectRecord(semanticDiagnostics?.semanticRecovery);
    const rejectedByPredicate = objectRecord(semanticDiagnostics?.rejectedByPredicate);
    const progress: RunProgressView = {
      targetTrackCount,
      latestActivityAt: date(count.latest_activity_at)?.toISOString() ?? null,
      sourceSummary: {
        total: progressCount(count.source_count),
        recentSources: recentPublicSources(count.recent_sources),
      },
      frontierSummary: {
        total: progressCount(count.frontier_total),
        complete: progressCount(count.frontier_complete),
        active: progressCount(count.frontier_active),
        unresolved: progressCount(count.frontier_unresolved),
        inaccessible: progressCount(count.frontier_inaccessible),
        discoveredCount: progressCount(count.frontier_discovered_count),
        recoveredCount: progressCount(count.frontier_recovered_count),
      },
      containerSummary: {
        total: progressCount(count.container_total),
        complete: progressCount(count.container_complete),
        active: progressCount(count.container_active),
        unresolved: progressCount(count.container_unresolved),
        inaccessible: progressCount(count.container_inaccessible),
        advertisedCount: progressCount(count.container_advertised_count),
        recoveredCount: progressCount(count.container_recovered_count),
      },
      matchSummary: {
        attempted: progressCount(count.match_attempted),
        accepted: matchAccepted,
        review: progressCount(count.match_review),
        unavailable: progressCount(count.match_unavailable),
        duplicate: progressCount(count.match_duplicate),
        rejected: progressCount(count.match_rejected),
        unsupported: progressCount(count.match_unsupported),
        overflow: progressCount(count.match_overflow),
        shortfall: targetTrackCount == null ? null : Math.max(targetTrackCount - matchAccepted, 0),
      },
      publicationSummary: {
        volumeCount: progressCount(count.publication_volume_count),
        completedVolumes: progressCount(count.publication_completed_volumes),
        totalTracks: progressCount(count.publication_total_tracks),
        appendedTracks: progressCount(count.publication_appended_tracks),
        currentVolume: progressOptionalCount(count.publication_current_volume),
        status: progressText(count.publication_status, 40) || null,
      },
      ...(semanticDiagnostics ? {
        semanticPolicyVersion: progressText(semanticDiagnostics.semanticPolicyVersion, 80) || undefined,
        queryPlanSchemaVersion: progressOptionalCount(semanticDiagnostics.queryPlanSchemaVersion) ?? undefined,
        explicitConstraintHash: typeof semanticDiagnostics.explicitConstraintHash === "string"
          && /^[a-f0-9]{64}$/u.test(semanticDiagnostics.explicitConstraintHash)
          ? semanticDiagnostics.explicitConstraintHash
          : undefined,
        contextSignals: Array.isArray(semanticDiagnostics.contextSignals)
          ? semanticDiagnostics.contextSignals.slice(0, 20) as QueryPlanV3["contextSignals"]
          : undefined,
        rejectedByPredicate: rejectedByPredicate
          ? Object.fromEntries(Object.entries(rejectedByPredicate).flatMap(([key, value]) => (
            typeof value === "number" && Number.isSafeInteger(value) && value >= 0
              ? [[key.slice(0, 160), value] as const]
              : []
          )))
          : undefined,
        appleLookupCount: progressOptionalCount(semanticDiagnostics.appleLookupCount) ?? undefined,
        appleProviderRequestCount: progressOptionalCount(semanticDiagnostics.appleProviderRequestCount) ?? undefined,
        rootCause: progressText(semanticDiagnostics.rootCause, 80) || null,
        semanticRecovery: recovery ? {
          attempted: recovery.attempted === true,
          attemptCount: progressCount(recovery.attemptCount),
          repaired: recovery.repaired === true,
        } : undefined,
        activePlanRevision: progressOptionalCount(semanticDiagnostics.activePlanRevision) ?? undefined,
      } : {}),
    };
    const partial = parsePartialReadyCheckpoint(partialCheckpoint);
    const partialAction = partial
      && ["partial_ready", "no_compatible_tracks", "needs_decision"].includes(row.status)
      ? {
          kind: "partial_publication" as const,
          targetTrackCount: partial.targetTrackCount,
          qualifiedTrackCount: partial.verifiedTrackCount,
          remainingStrategyCount: partial.remainingStrategyCount,
          canContinueResearch: partial.continueAvailable,
          reasonCode: Array.isArray(row.pipeline_outcome_json?.reasonCodes)
            && typeof row.pipeline_outcome_json.reasonCodes[0] === "string"
            ? row.pipeline_outcome_json.reasonCodes[0]
            : null,
          outcomeVersion: partial.outcomeVersion,
          outcomeHash: partial.outcomeHash,
          ...(partialCheckpoint && typeof partialCheckpoint === "object" && !Array.isArray(partialCheckpoint)
            && typeof (partialCheckpoint as Record<string, unknown>).manifestId === "string"
            ? { manifestId: (partialCheckpoint as Record<string, unknown>).manifestId as string }
            : {}),
          ...(partialCheckpoint && typeof partialCheckpoint === "object" && !Array.isArray(partialCheckpoint)
            && typeof (partialCheckpoint as Record<string, unknown>).manifestHash === "string"
            ? { manifestHash: (partialCheckpoint as Record<string, unknown>).manifestHash as string }
            : {}),
        }
      : null;
    const decisionAction = row.status === "needs_decision"
      ? publicAdaptiveRunDecisionV1(decisionCheckpoint)
      : null;
    return {
      id: row.id,
      prompt: row.prompt,
      brief: row.brief_json,
      guidanceSourceHints: row.guidance_source_hints_json ?? [],
      guidanceTelemetry: row.guidance_telemetry_json ?? null,
      guidancePreferences: row.guidance_preferences_json ?? [],
      pipelineVersion: row.pipeline_version ?? "legacy_v1",
      policyVersion: row.policy_version ?? "legacy_v1",
      selectionPlan: row.selection_plan_json ?? null,
      queryPlan,
      pipelinePolicySnapshot: row.pipeline_policy_snapshot_json ?? null,
      pipelineOutcome: row.pipeline_outcome_json ?? null,
      status: row.status,
      phase: row.phase,
      autoPublish: row.auto_publish === true,
      estimatedCostUsd: Number(row.estimated_cost_usd),
      actualCostUsd: Number(row.actual_cost_usd),
      approvedBudgetUsd: Number(row.approved_budget_usd),
      reservedCostUsd: Number(row.reserved_cost_usd),
      noNewGapPasses: Number(row.no_new_gap_passes),
      error: sanitizeOptionalFailure(row.error, failureContextForRun(row.phase)),
      candidateCount: count.candidate_count,
      candidateStageCounts: count.candidate_stage_counts ?? {},
      sourceCount: count.source_count,
      unresolvedCount: count.unresolved_count,
      frontier,
      progress,
      partialAction,
      decisionAction,
      guidanceAction,
      explore,
      resolution,
      createdAt: date(row.created_at)?.toISOString(),
      updatedAt: date(row.updated_at)?.toISOString(),
      completedAt: date(row.completed_at)?.toISOString() ?? null,
      budgetApprovalExpiresAt: date(row.budget_approval_expires_at)?.toISOString() ?? null,
    } as ResearchRunView & Record<string, unknown>;
  }

  async getRunByAccess(accessId: string): Promise<PublicResearchRunView | null> {
    const result = await this.pool.query<{ run_id: string; prompt: string | null }>(
      "SELECT run_id,prompt FROM run_accesses WHERE id=$1 AND deleted_at IS NULL AND expires_at>now()",
      [accessId],
    );
    if (!result.rows[0]) return null;
    const run = await this.getRun(result.rows[0].run_id);
    return publicResearchRunView(run, {
      id: accessId,
      prompt: result.rows[0].prompt ?? run.prompt,
    });
  }

  async listRunsForCapabilitySession(sessionId: string, limit = 50): Promise<ResearchRunHistoryItem[]> {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 50));
    const result = await this.pool.query(
      `SELECT
         a.id AS access_id,
         COALESCE(a.prompt,r.prompt) AS prompt,
         r.brief_json,
         r.status,
         r.phase,
         a.created_at,
         r.updated_at,
         (SELECT count(*)::int FROM track_candidates tc WHERE tc.run_id=r.id) AS candidate_count,
         (SELECT count(*)::int FROM source_records sr WHERE sr.run_id=r.id) AS source_count,
         ((SELECT count(*)::int FROM source_frontier sf
            WHERE sf.run_id=r.id AND sf.status IN ('pending','unresolved','inaccessible'))
          +
          (SELECT count(*)::int FROM research_containers rc
            WHERE rc.run_id=r.id AND rc.status IN ('discovered','enumerating','inaccessible','unresolved'))
          + COALESCE((SELECT CASE
              WHEN COALESCE((cp.state_json->>'artistShortfall')::int,0)>0 THEN 1 ELSE 0 END
            FROM research_checkpoints cp
            WHERE cp.run_id=r.id AND cp.phase='catalog_matching_outcome'),0)) AS unresolved_count
       FROM capability_session_accesses csa
       JOIN capability_sessions s ON s.id=csa.session_id
       JOIN run_accesses a ON a.id=csa.access_id AND a.run_id=csa.run_id
       JOIN research_runs r ON r.id=csa.run_id
       WHERE csa.session_id=$1
         AND s.revoked_at IS NULL AND s.expires_at>now()
         AND a.deleted_at IS NULL AND a.expires_at>now()
         AND r.deleted_at IS NULL
       ORDER BY a.created_at DESC,a.id DESC
       LIMIT $2`,
      [sessionId, boundedLimit],
    );
    return result.rows.map((row) => ({
      id: row.access_id,
      prompt: row.prompt,
      brief: row.brief_json,
      status: row.status,
      phase: row.phase,
      candidateCount: Number(row.candidate_count),
      sourceCount: Number(row.source_count),
      unresolvedCount: Number(row.unresolved_count),
      createdAt: date(row.created_at)!.toISOString(),
      updatedAt: date(row.updated_at)!.toISOString(),
    }));
  }

  async getCanonicalRunId(accessId: string): Promise<string | null> {
    const result = await this.pool.query<{ run_id: string }>(
      "SELECT run_id FROM run_accesses WHERE id=$1 AND deleted_at IS NULL AND expires_at>now()",
      [accessId],
    );
    return result.rows[0]?.run_id ?? null;
  }

  async deleteRunAccess(accessId: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const access = await client.query<{ run_id: string; brief_request_id: string | null }>(
        "SELECT run_id,brief_request_id FROM run_accesses WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [accessId],
      );
      if (!access.rows[0]) return false;
      const runId = access.rows[0].run_id;
      await client.query("UPDATE run_accesses SET prompt=NULL,deleted_at=now(),updated_at=now() WHERE id=$1", [accessId]);
      // A reused canonical run can outlive one visitor's access. Remove only
      // the automatic diagnostic bound to this deleted access immediately so
      // its prompt cannot remain visible merely because another visitor still
      // has a separate access to the shared run.
      await this.deleteAutomaticFailureFeedbackForSource(client, { runAccessId: accessId });
      const affectedSessions = await client.query<{ session_id: string }>(
        "DELETE FROM capability_session_accesses WHERE access_id=$1 RETURNING session_id",
        [accessId],
      );
      if (affectedSessions.rows.length > 0) await client.query(
        `UPDATE capability_sessions s SET revoked_at=now(),updated_at=now()
         WHERE s.id=ANY($1::uuid[])
           AND NOT EXISTS (
             SELECT 1 FROM capability_session_accesses csa
             JOIN run_accesses a ON a.id=csa.access_id AND a.run_id=csa.run_id
             WHERE csa.session_id=s.id AND a.deleted_at IS NULL AND a.expires_at>now()
           )
           AND NOT EXISTS (
             SELECT 1 FROM capability_session_briefs csb
             JOIN brief_requests b ON b.id=csb.brief_request_id
             WHERE csb.session_id=s.id AND b.expires_at>now()
           )`,
        [affectedSessions.rows.map((row) => row.session_id)],
      );
      await client.query(
        "UPDATE capability_sessions SET access_id=NULL,updated_at=now() WHERE access_id=$1",
        [accessId],
      );
      await client.query("DELETE FROM capability_tokens WHERE access_id=$1", [accessId]);
      if (access.rows[0].brief_request_id) {
        await this.deleteAutomaticFailureFeedbackForSource(client, {
          briefRequestId: access.rows[0].brief_request_id,
        });
        await client.query("DELETE FROM brief_requests WHERE id=$1", [access.rows[0].brief_request_id]);
      }
      const remaining = await client.query<{ count: number }>("SELECT count(*)::int count FROM run_accesses WHERE run_id=$1 AND deleted_at IS NULL", [runId]);
      if (remaining.rows[0]!.count === 0) {
        await this.deleteAutomaticFailureFeedbackForSource(client, { runId });
        const run = await client.query<{ status: string; actual_cost_usd: string }>("SELECT status,actual_cost_usd FROM research_runs WHERE id=$1 FOR UPDATE", [runId]);
        if (run.rows[0] && !TERMINAL_RUN_STATUSES.includes(run.rows[0].status)) {
          await client.query("UPDATE research_runs SET status='deleted',phase='visitor_deleted',completed_at=now(),updated_at=now() WHERE id=$1", [runId]);
          await client.query("UPDATE job_queue SET status='cancelled',completed_at=now(),updated_at=now() WHERE run_id=$1 AND status IN ('queued','leased')", [runId]);
        }
        if (run.rows[0]) {
          const manifest = await client.query("SELECT id,content_hash,name FROM manifests WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1", [runId]);
          const volumes = manifest.rows[0]
            ? await client.query(
              `SELECT pv.apple_share_url FROM publication_volumes pv
               WHERE pv.manifest_id=$1 AND pv.status='complete' AND pv.apple_share_url IS NOT NULL
                 AND pv.manifest_revision_id IS NOT DISTINCT FROM (
                   SELECT mr.id FROM manifest_revisions mr
                   WHERE mr.manifest_id=$1 AND mr.status IN ('locked','published')
                   ORDER BY mr.revision DESC LIMIT 1
                 )
               ORDER BY pv.volume_number`,
              [manifest.rows[0].id],
            )
            : { rows: [] };
          const counts = await client.query("SELECT outcome,count(*)::int count FROM track_candidates WHERE run_id=$1 GROUP BY outcome", [runId]);
          const appleLinks = volumes.rows.map((volume) => volume.apple_share_url);
          const outcomeCounts = Object.fromEntries(counts.rows.map((entry) => [entry.outcome, entry.count]));
          await client.query(
            `INSERT INTO retention_tombstones(run_id,manifest_hash,playlist_title,apple_links_json,outcome_counts_json,aggregate_cost_usd)
             VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6) ON CONFLICT(run_id) DO NOTHING`,
            [runId, manifest.rows[0]?.content_hash ?? null, manifest.rows[0]?.name ?? null, JSON.stringify(appleLinks), JSON.stringify(outcomeCounts), Number(run.rows[0].actual_cost_usd)],
          );
          const notificationIds = await client.query<{ id: string }>(
            `SELECT id FROM notification_outbox
             WHERE payload_json->>'runId'=$1
                OR ($2::text IS NOT NULL AND payload_json->>'manifestId'=$2::text)`,
            [runId, manifest.rows[0]?.id ?? null],
          );
          if (notificationIds.rows.length > 0) {
            const ids = notificationIds.rows.map((item) => item.id);
            await client.query(
              "DELETE FROM job_queue WHERE kind='notification' AND payload_json->>'notificationId'=ANY($1::text[])",
              [ids],
            );
            await client.query("DELETE FROM notification_outbox WHERE id=ANY($1::uuid[])", [ids]);
          }
          await client.query("DELETE FROM cost_ledger WHERE run_id=$1", [runId]);
          await client.query("DELETE FROM audit_events WHERE run_id=$1", [runId]);
          await client.query(
            "UPDATE capability_sessions SET run_id=NULL,access_id=NULL,updated_at=now() WHERE run_id=$1",
            [runId],
          );
          // Remove the manifest graph before the run cascade deletes its candidates.
          // manifest_tracks intentionally protects candidate references, so relying on
          // the two independent research_runs cascades can violate that foreign key.
          await client.query("DELETE FROM manifests WHERE run_id=$1", [runId]);
          await client.query("DELETE FROM research_runs WHERE id=$1", [runId]);
        }
      }
      return true;
    });
  }

  private async addSourcesInTransaction(client: PoolClient, runId: string, sources: SourceRecordInput[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const source of sources) {
      const id = randomUUID();
      const result = await client.query<{ id: string }>(
        `INSERT INTO source_records(id,run_id,url,title,source_class,provenance_root,note)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(run_id,url) DO UPDATE SET
           title=CASE WHEN source_records.source_class<>'import' AND EXCLUDED.source_class='import'
             THEN source_records.title ELSE EXCLUDED.title END,
           note=CASE WHEN source_records.source_class<>'import' AND EXCLUDED.source_class='import'
             THEN source_records.note ELSE EXCLUDED.note END,
           source_class=CASE WHEN source_records.source_class='import' AND EXCLUDED.source_class<>'import'
             THEN EXCLUDED.source_class ELSE source_records.source_class END,
           provenance_root=CASE WHEN source_records.source_class='import' AND EXCLUDED.source_class<>'import'
             THEN EXCLUDED.provenance_root ELSE source_records.provenance_root END
         WHERE (source_records.source_class=EXCLUDED.source_class
             AND source_records.provenance_root=EXCLUDED.provenance_root)
           OR (source_records.source_class='import' AND EXCLUDED.source_class<>'import')
           OR (source_records.source_class<>'import' AND EXCLUDED.source_class='import')
         RETURNING id`,
        [id, runId, source.url, source.title.slice(0, 240), source.sourceClass, source.provenanceRoot.slice(0, 240), compactEvidenceNote(source.note)],
      );
      if (!result.rows[0]) {
        throw new HttpError(409, "A stored source URL has conflicting class or provenance", "source_provenance_conflict");
      }
      ids.set(source.url, result.rows[0].id);
    }
    return ids;
  }

  async addSources(runId: string, sources: SourceRecordInput[]): Promise<Map<string, string>> {
    return this.transaction((client) => this.addSourcesInTransaction(client, runId, sources));
  }

  async addCitationAttestations(runId: string, attestations: readonly HostedCitationAttestation[]): Promise<void> {
    if (attestations.length === 0) return;
    await this.transaction(async (client) => {
      for (const raw of attestations.slice(0, 1_000)) {
        const sourceUrl = assertPublicHttpsUrl(raw.sourceUrl).toString();
        if (!raw.responseId || raw.responseId.length > 240 || !raw.outputItemId || raw.outputItemId.length > 240
          || !Number.isInteger(raw.contentIndex) || raw.contentIndex < 0
          || !Number.isInteger(raw.startIndex) || raw.startIndex < 0
          || !Number.isInteger(raw.endIndex) || raw.endIndex <= raw.startIndex
          || typeof raw.excerpt !== "string" || raw.excerpt.trim().length < 8
          || raw.excerpt.length > MAX_CITATION_EXCERPT_CHARS
          || raw.endIndex - raw.startIndex !== raw.excerpt.length
          || /[\uD800-\uDFFF]/.test(raw.excerpt)) {
          throw new HttpError(400, "Citation attestation is invalid", "invalid_citation_attestation");
        }
        const attestation: HostedCitationAttestation = { ...raw, sourceUrl };
        await client.query(
          `INSERT INTO citation_attestations(
             id,run_id,attestation_key,source_url,response_id,output_item_id,
             content_index,start_index,end_index,excerpt)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT(run_id,attestation_key) DO NOTHING`,
          [
            randomUUID(), runId, citationAttestationKey(attestation), sourceUrl,
            attestation.responseId, attestation.outputItemId, attestation.contentIndex,
            attestation.startIndex, attestation.endIndex, attestation.excerpt,
          ],
        );
      }
    });
  }

  private async addCandidatesInTransaction(client: PoolClient, runId: string, candidates: TrackCandidateInput[], sourceIds: Map<string, string>, verificationPhase = "unverified"): Promise<number> {
    const allowedPhases = new Set([
      "scope_resolution", "source_discovery", "container_discovery", "container_enumeration",
      "track_verification", "catalog_enrichment", "gap_analysis",
    ]);
    const storedPhase = allowedPhases.has(verificationPhase) ? verificationPhase : "unverified";
    const briefResult = await client.query<{
      brief_json: PlaylistBrief;
      selection_plan_json: SelectionPlan | null;
      pipeline_version: SelectionPlan["pipelineVersion"] | null;
      policy_version: SelectionPlan["policyVersion"] | null;
    }>(
      `SELECT brief_json,selection_plan_json,pipeline_version,policy_version
       FROM research_runs WHERE id=$1 AND deleted_at IS NULL`,
      [runId],
    );
    const run = briefResult.rows[0];
    const brief = run?.brief_json;
    if (!brief) throw new HttpError(404, "Research run not found", "run_not_found");
    const selectionPlan = run.selection_plan_json ?? null;
    const versions = {
      pipelineVersion: selectionPlan?.pipelineVersion ?? run.pipeline_version ?? "legacy_v1",
      policyVersion: selectionPlan?.policyVersion ?? run.policy_version ?? "legacy_v1",
    } satisfies Pick<SelectionPlan, "pipelineVersion" | "policyVersion">;
    let added = 0;
    for (const candidate of candidates) {
        const boundEvidence = candidate.evidence.map((evidence) => {
          const binding = resolveEvidenceSubjectBinding(
            brief,
            evidence.subjectEntity,
            evidence.subjectRelationship,
          );
          if (!binding) {
            throw new HttpError(
              400,
              "Evidence claim subject does not match the confirmed playlist scope",
              "evidence_subject_mismatch",
            );
          }
          return { ...evidence, ...binding };
        });
        const identityKey = candidateIdentityKey(candidate);
        const candidateId = randomUUID();
        const selectionRank = Number.isInteger(candidate.selectionRank)
          && Number(candidate.selectionRank) > 0
          && Number(candidate.selectionRank) <= 10_000
          ? Number(candidate.selectionRank)
          : null;
        const inserted = await client.query<{ id: string; inserted: boolean }>(
          `INSERT INTO track_candidates(
             id,run_id,canonical_key,duplicate_cluster_key,candidate_stage,pipeline_version,policy_version,
             selection_rank,artist,title,album,release_year,duration_ms,isrc,musicbrainz_id,version_label)
           VALUES($1,$2,$3,$4,'discovered',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT(run_id,canonical_key) DO UPDATE SET
             selection_rank=CASE
               WHEN EXCLUDED.selection_rank IS NULL THEN track_candidates.selection_rank
               WHEN track_candidates.selection_rank IS NULL THEN EXCLUDED.selection_rank
               ELSE LEAST(track_candidates.selection_rank,EXCLUDED.selection_rank)
             END,
             pipeline_version=EXCLUDED.pipeline_version,
             policy_version=EXCLUDED.policy_version
           RETURNING id,(xmax=0) inserted`,
          [candidateId, runId, identityKey, duplicateClusterKey(candidate),
            versions.pipelineVersion, versions.policyVersion, selectionRank,
            candidate.artist.slice(0, 240), candidate.title.slice(0, 240), candidate.album?.slice(0, 240) ?? null,
            candidate.releaseYear, candidate.durationMs, candidate.isrc, candidate.musicbrainzId,
            candidate.versionLabel?.slice(0, 120) ?? null],
        );
        const storedId = inserted.rows[0]?.id;
        if (!storedId) throw new Error("Candidate upsert did not return an identifier");
        if (inserted.rows[0]!.inserted) added += 1;
        if (inserted.rows[0]!.inserted) {
          const discoveredAt = new Date();
          await client.query(
            `INSERT INTO candidate_stage_events(
               id,run_id,candidate_id,from_stage,to_stage,reason_code,detail_json,
               pipeline_version,policy_version,occurred_at)
             VALUES($1,$2,$3,NULL,'discovered','candidate_persisted',$4::jsonb,$5,$6,$7)
             ON CONFLICT(id) DO NOTHING`,
            [
              deterministicUuid({ runId, candidateId: storedId, toStage: "discovered", reasonCode: "candidate_persisted" }),
              runId,
              storedId,
              JSON.stringify({ verificationPhase: storedPhase }),
              versions.pipelineVersion,
              versions.policyVersion,
              discoveredAt,
            ],
          );
        }
        if (!inserted.rows[0]!.inserted) {
          const existing = await client.query<{ id: string; artist: string; title: string; version_label: string | null }>(
            "SELECT id,artist,title,version_label FROM track_candidates WHERE run_id=$1 AND canonical_key=$2",
            [runId, identityKey],
          );
          const prior = existing.rows[0]!;
          const versionConflict = Boolean(prior.version_label && candidate.versionLabel
            && normalizeMusicText(prior.version_label) !== normalizeMusicText(candidate.versionLabel));
          if (normalizeMusicText(prior.artist) !== normalizeMusicText(candidate.artist)
            || normalizeMusicText(prior.title) !== normalizeMusicText(candidate.title)
            || versionConflict) {
            throw new HttpError(409, "A stable recording identifier has conflicting artist, title, or version metadata", "recording_identifier_conflict");
          }
        }
        if (storedPhase === "track_verification") {
          const verifiedSourceIds = [...new Set(boundEvidence
            .map((evidence) => sourceIds.get(evidence.sourceUrl))
            .filter((sourceId): sourceId is string => Boolean(sourceId)))];
          if (verifiedSourceIds.length > 0) {
            // A dedicated verification batch replaces prior conclusions from
            // the same sources, even if the model phrases the relationship
            // differently on the later pass.
            await client.query(
              "UPDATE evidence_claims SET state='inferred' WHERE candidate_id=$1 AND source_id=ANY($2::uuid[]) AND state IN ('verified','corroborated')",
              [storedId, verifiedSourceIds],
            );
          }
        }
        for (const evidence of boundEvidence) {
          const sourceId = sourceIds.get(evidence.sourceUrl);
          if (!sourceId) continue;
          const sourceResult = await client.query<{ source_class: SourceRecordInput["sourceClass"]; url: string }>(
            "SELECT source_class,url FROM source_records WHERE id=$1 AND run_id=$2",
            [sourceId, runId],
          );
          const storedSource = sourceResult.rows[0];
          if (!storedSource || storedSource.url !== evidence.sourceUrl) continue;
          const supportScope = ["track", "album", "session", "collection", "editorial"].includes(evidence.supportScope ?? "")
            ? evidence.supportScope
            : "collection";
          let citationAttestationId: string | null = null;
          if (storedSource.source_class === "web" && evidence.citationSupport
            && citationTextIsLocalToClaim(
              evidence.citationSupport.excerpt,
              candidate.title,
              evidence.subjectEntity,
              evidence.relationship,
            )) {
            const attestation: HostedCitationAttestation = {
              sourceUrl: storedSource.url,
              ...evidence.citationSupport,
            };
            const citation = await client.query<{ id: string }>(
              `SELECT id FROM citation_attestations
               WHERE run_id=$1 AND attestation_key=$2 AND source_url=$3
                 AND response_id=$4 AND output_item_id=$5 AND content_index=$6
                 AND start_index=$7 AND end_index=$8 AND excerpt=$9`,
              [
                runId, citationAttestationKey(attestation), storedSource.url,
                attestation.responseId, attestation.outputItemId, attestation.contentIndex,
                attestation.startIndex, attestation.endIndex, attestation.excerpt,
              ],
            );
            citationAttestationId = citation.rows[0]?.id ?? null;
          }
          const needsStrongSupport = evidence.state === "verified" || evidence.state === "corroborated"
            || evidence.state === "editorial" || evidence.state === "disputed";
          const sourceCannotAttestRelationship = storedSource.source_class !== "web";
          const missingWebAttestation = storedSource.source_class === "web" && !citationAttestationId;
          const storedState = ((evidence.state === "verified" || evidence.state === "corroborated" || evidence.state === "disputed")
            && (storedPhase !== "track_verification" || supportScope !== "track")
            || (needsStrongSupport && (sourceCannotAttestRelationship || missingWebAttestation)))
            ? "inferred"
            : evidence.state;
          await client.query(
            `INSERT INTO evidence_claims(
               id,run_id,candidate_id,source_id,citation_attestation_id,state,support_scope,verification_phase,
               subject_entity,subject_relationship,relationship,note)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT(candidate_id,source_id,subject_entity,subject_relationship,relationship) DO UPDATE SET
               state=CASE WHEN EXCLUDED.verification_phase='track_verification' THEN EXCLUDED.state ELSE evidence_claims.state END,
               support_scope=CASE WHEN EXCLUDED.verification_phase='track_verification' THEN EXCLUDED.support_scope ELSE evidence_claims.support_scope END,
               verification_phase=CASE WHEN EXCLUDED.verification_phase='track_verification' THEN EXCLUDED.verification_phase ELSE evidence_claims.verification_phase END,
               citation_attestation_id=CASE WHEN EXCLUDED.verification_phase='track_verification' THEN EXCLUDED.citation_attestation_id ELSE evidence_claims.citation_attestation_id END,
               note=CASE WHEN EXCLUDED.verification_phase='track_verification' THEN EXCLUDED.note ELSE evidence_claims.note END`,
            [randomUUID(), runId, storedId, sourceId, citationAttestationId, storedState, supportScope, storedPhase,
              evidence.subjectEntity, evidence.subjectRelationship,
              evidence.relationship.slice(0, 240), compactEvidenceNote(evidence.note)],
          );
        }
        const storedEvidence = await client.query<{
          id: string;
          source_id: string;
          source_url: string;
          source_title: string;
          source_class: SourceRecordInput["sourceClass"];
          provenance_root: string;
          citation_attestation_id: string | null;
          citation_excerpt: string | null;
          state: EvidenceClaimInput["state"];
          support_scope: EvidenceClaimInput["supportScope"];
          verification_phase: string;
          subject_entity: string;
          subject_relationship: string;
          relationship: string;
          note: string;
        }>(
          `SELECT e.id,e.source_id,s.url source_url,s.title source_title,s.source_class,s.provenance_root,
             e.citation_attestation_id,ca.excerpt citation_excerpt,e.state,e.support_scope,e.verification_phase,
             e.subject_entity,e.subject_relationship,e.relationship,e.note
           FROM evidence_claims e JOIN source_records s ON s.id=e.source_id
           LEFT JOIN citation_attestations ca ON ca.id=e.citation_attestation_id
             AND ca.run_id=e.run_id AND ca.source_url=s.url
           WHERE e.candidate_id=$1 ORDER BY e.id`,
          [storedId],
        );
        const integrity = resolveEvidenceIntegrity(
          storedEvidence.rows.map((row) => ({
            sourceUrl: row.source_url,
            state: row.state,
            supportScope: row.support_scope,
            subjectEntity: row.subject_entity,
            subjectRelationship: row.subject_relationship,
            relationship: row.relationship,
            note: row.note,
          })),
          storedEvidence.rows.map((row) => ({
            url: row.source_url,
            sourceClass: row.source_class,
            provenanceRoot: row.provenance_root,
          })),
        );
        for (let index = 0; index < storedEvidence.rows.length; index += 1) {
          const row = storedEvidence.rows[index]!;
          const effective = integrity.evidence[index]!;
          if (row.state !== effective.state) {
            await client.query("UPDATE evidence_claims SET state=$2 WHERE id=$1", [row.id, effective.state]);
          }
        }
        const qualifyingBindings = storedEvidence.rows.flatMap((row, index): TrackScopeBinding[] => {
          const effective = integrity.evidence[index]!;
          // Catalog metadata is identity evidence only. A qualifying scope
          // binding must originate in an attested exact-track web claim (or a
          // subject-specific editorial claim for curated work).
          if (row.source_class !== "web" || !row.citation_attestation_id) return [];
          const qualifiesTrackClaim = row.support_scope === "track"
            && (effective.state === "verified" || effective.state === "corroborated");
          const qualifiesEditorialClaim = (row.support_scope === "track" || row.support_scope === "editorial")
            && effective.state === "editorial";
          if (!qualifiesTrackClaim && !qualifiesEditorialClaim) return [];
          const legacyAndIntentDescriptors = deriveEvidenceScopeDescriptors(
            selectionPlan,
            brief,
            row.relationship,
          );
          const attestedHardDescriptors = deriveAttestedHardScopeDescriptors(selectionPlan, {
            citationAttestationId: row.citation_attestation_id,
            sourceMetadataText: row.source_title,
            relationship: row.relationship,
          });
          const descriptorKeys = new Set<string>();
          const descriptors = [...attestedHardDescriptors, ...legacyAndIntentDescriptors].filter((descriptor) => {
            const key = `${descriptor.scopeAxis}:${normalizedPolicyText(descriptor.scopeValue)}:${descriptor.geographyRelationship ?? ""}`;
            if (descriptorKeys.has(key)) return false;
            descriptorKeys.add(key);
            return true;
          });
          return descriptors
            .map(({ scopeAxis, scopeValue, geographyRelationship }) => ({
            bindingKind: "track_specific_source" as const,
            eligibility: "qualifying" as const,
            scopeAxis,
            scopeValue,
            geographyRelationship,
            relationship: row.relationship.slice(0, 240),
            confidence: effective.state === "verified"
              ? 0.99
              : effective.state === "corroborated"
                ? 0.94
                : 0.86,
            sourceUrl: row.source_url,
            sourceRecordId: row.source_id,
            researchContainerId: null,
            citationAttestationId: row.citation_attestation_id,
            provenancePath: provenancePathWithGeographyRelationship([
              { kind: "provenance_root", id: row.provenance_root },
              { kind: "source_record", id: row.source_id },
              { kind: "evidence_claim", id: row.id },
            ], geographyRelationship),
            note: compactEvidenceNote(row.note),
            }));
        });
        const activeBindingIds: string[] = [];
        for (const binding of qualifyingBindings) {
          const bindingId = deterministicUuid({
            runId,
            candidateId: storedId,
            bindingKind: binding.bindingKind,
            scopeAxis: binding.scopeAxis,
            scopeValue: binding.scopeValue,
            geographyRelationship: binding.geographyRelationship ?? null,
            relationship: binding.relationship,
            sourceRecordId: binding.sourceRecordId,
            researchContainerId: binding.researchContainerId,
          });
          const persisted = await client.query<{ id: string }>(
            `INSERT INTO track_scope_bindings(
               id,run_id,candidate_id,source_record_id,source_url,research_container_id,
               citation_attestation_id,binding_kind,eligibility,scope_axis,scope_value,
               relationship,confidence,provenance_path_json,note,pipeline_version,policy_version)
             SELECT $1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16
             FROM track_candidates tc
             WHERE tc.id=$3 AND tc.run_id=$2
               AND EXISTS(SELECT 1 FROM source_records sr WHERE sr.id=$4 AND sr.run_id=$2)
               AND EXISTS(SELECT 1 FROM citation_attestations ca WHERE ca.id=$6 AND ca.run_id=$2)
             ON CONFLICT ON CONSTRAINT scope_binding_unique_key DO UPDATE SET
               source_record_id=EXCLUDED.source_record_id,source_url=EXCLUDED.source_url,
               citation_attestation_id=EXCLUDED.citation_attestation_id,
               eligibility=EXCLUDED.eligibility,confidence=EXCLUDED.confidence,
               provenance_path_json=EXCLUDED.provenance_path_json,note=EXCLUDED.note,
               pipeline_version=EXCLUDED.pipeline_version,policy_version=EXCLUDED.policy_version
             RETURNING id`,
            [
              bindingId,
              runId,
              storedId,
              binding.sourceRecordId,
              binding.sourceUrl,
              binding.citationAttestationId,
              binding.bindingKind,
              binding.eligibility,
              binding.scopeAxis,
              binding.scopeValue,
              binding.relationship,
              binding.confidence,
              JSON.stringify(binding.provenancePath),
              binding.note,
              versions.pipelineVersion,
              versions.policyVersion,
            ],
          );
          if (!persisted.rows[0]) {
            throw new HttpError(400, "Scope binding references data outside this research run", "invalid_scope_binding");
          }
          activeBindingIds.push(persisted.rows[0].id);
        }
        await client.query(
          `DELETE FROM track_scope_bindings
           WHERE run_id=$1 AND candidate_id=$2 AND binding_kind='track_specific_source'
             AND provenance_path_json @> '[{"kind":"evidence_claim"}]'::jsonb
             AND NOT (id=ANY($3::uuid[]))`,
          [runId, storedId, activeBindingIds],
        );
        if (qualifyingBindings.length > 0) {
          const priorStage = await client.query<{
            candidate_stage: "discovered" | "identity_resolved" | "scope_qualified" | "claim_verified";
            stage_updated_at: Date;
          }>(
            `SELECT candidate_stage,stage_updated_at FROM track_candidates
             WHERE id=$1 AND run_id=$2 FOR UPDATE`,
            [storedId, runId],
          );
          const prior = priorStage.rows[0];
          if (prior && (prior.candidate_stage === "discovered" || prior.candidate_stage === "identity_resolved")) {
            const stageAt = new Date(Math.max(Date.now(), prior.stage_updated_at.getTime() + 1));
            await client.query(
              `INSERT INTO candidate_stage_events(
                 id,run_id,candidate_id,from_stage,to_stage,reason_code,detail_json,
                 pipeline_version,policy_version,occurred_at)
               VALUES($1,$2,$3,$4,'scope_qualified','qualifying_scope_binding',$5::jsonb,$6,$7,$8)
               ON CONFLICT(id) DO NOTHING`,
              [
                deterministicUuid({
                  runId,
                  candidateId: storedId,
                  fromStage: prior.candidate_stage,
                  fromStageUpdatedAt: prior.stage_updated_at.toISOString(),
                  toStage: "scope_qualified",
                  reasonCode: "qualifying_scope_binding",
                  bindingIds: activeBindingIds.sort(),
                }),
                runId,
                storedId,
                prior.candidate_stage,
                JSON.stringify({ bindingCount: qualifyingBindings.length }),
                versions.pipelineVersion,
                versions.policyVersion,
                stageAt,
              ],
            );
            await client.query(
              `UPDATE track_candidates SET candidate_stage='scope_qualified',stage_updated_at=$3,
                 pipeline_version=$4,policy_version=$5
               WHERE id=$1 AND run_id=$2 AND candidate_stage=$6`,
              [storedId, runId, stageAt, versions.pipelineVersion, versions.policyVersion, prior.candidate_stage],
            );
          }
        } else {
          const resetAt = new Date(Date.now() + 1);
          const priorStage = await client.query<{ candidate_stage: "scope_qualified" | "claim_verified" }>(
            `SELECT candidate_stage FROM track_candidates
             WHERE id=$1 AND run_id=$2 AND candidate_stage IN ('scope_qualified','claim_verified')
             FOR UPDATE`,
            [storedId, runId],
          );
          const reset = await client.query(
            `UPDATE track_candidates SET candidate_stage='discovered',stage_updated_at=$3,
               pipeline_version=$4,policy_version=$5
             WHERE id=$1 AND run_id=$2 AND candidate_stage IN ('scope_qualified','claim_verified')`,
            [storedId, runId, resetAt, versions.pipelineVersion, versions.policyVersion],
          );
          if (reset.rowCount && priorStage.rows[0]) {
            await client.query(
              `INSERT INTO candidate_stage_events(
                 id,run_id,candidate_id,from_stage,to_stage,reason_code,detail_json,
                 pipeline_version,policy_version,occurred_at)
               VALUES($1,$2,$3,$4,'discovered','qualifying_scope_binding_withdrawn',$5::jsonb,$6,$7,$8)
               ON CONFLICT(id) DO NOTHING`,
              [
                deterministicUuid({
                  runId,
                  candidateId: storedId,
                  toStage: "discovered",
                  reasonCode: "qualifying_scope_binding_withdrawn",
                  evidenceIds: storedEvidence.rows.map((row) => row.id),
                }),
                runId,
                storedId,
                priorStage.rows[0].candidate_stage,
                JSON.stringify({ verificationPhase: storedPhase }),
                versions.pipelineVersion,
                versions.policyVersion,
                resetAt,
              ],
            );
          }
        }
        if (integrity.hasDisagreement) {
          await client.query(
            `INSERT INTO source_frontier(id,run_id,source_class,strategy,cursor,status,discovered_count,recovered_count,note)
             VALUES($1,$2,'evidence',$3,NULL,'unresolved',1,0,$4)
             ON CONFLICT(run_id,source_class,strategy) DO UPDATE SET
               status='unresolved',discovered_count=1,recovered_count=0,note=EXCLUDED.note`,
            [
              randomUUID(),
              runId,
              `source disagreement:${storedId}`,
              compactEvidenceNote(`Sources disagree about the track-level relationship for ${candidate.artist} — ${candidate.title}; automatic inclusion is blocked pending visitor review.`),
            ],
          );
        }
    }
    return added;
  }

  async addCandidates(runId: string, candidates: TrackCandidateInput[], sourceIds: Map<string, string>, verificationPhase = "unverified"): Promise<number> {
    return this.transaction((client) => this.addCandidatesInTransaction(client, runId, candidates, sourceIds, verificationPhase));
  }

  private async upsertFrontierInTransaction(client: PoolClient, runId: string, items: SourceFrontierItem[]): Promise<void> {
    for (const item of items) {
      await client.query(
        `INSERT INTO source_frontier(id,run_id,source_class,strategy,cursor,status,discovered_count,recovered_count,note)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT(run_id,source_class,strategy) DO UPDATE SET cursor=EXCLUDED.cursor,status=EXCLUDED.status,
           discovered_count=EXCLUDED.discovered_count,recovered_count=EXCLUDED.recovered_count,note=EXCLUDED.note`,
        [randomUUID(), runId, item.sourceClass.slice(0, 80), item.strategy.slice(0, 240), item.cursor, item.status, item.discoveredCount, item.recoveredCount, compactEvidenceNote(item.note)],
      );
    }
  }

  async upsertFrontier(runId: string, items: SourceFrontierItem[]): Promise<void> {
    await this.transaction((client) => this.upsertFrontierInTransaction(client, runId, items));
  }

  /**
   * Append-only cold-corpus ingestion. Hosted-search output is deliberately
   * quarantined here; this method never writes promoted assertions, graph
   * snapshot membership, catalog matches, manifests, or Apple jobs.
   */
  async ingestPipelineV3ColdCorpus(input: {
    runId: string;
    queryPlan: QueryPlanV3;
    result: ColdCorpusBuildResultV3;
    fence: PipelineV3WriteFence;
  }): Promise<{
    sourceDocumentCount: number;
    observationCount: number;
    enumerationComplete: boolean;
    unresolvedGapCount: number;
  }> {
    return this.transaction(async (client) => {
      await this.assertPipelineV3WriteFence(client, input.runId, input.fence);
      const immutable = await client.query<{
        id: string;
        plan_hash: string;
        plan_json: QueryPlanV3;
        graph_snapshot_id: string;
      }>(
        `SELECT q.id,q.plan_hash,q.plan_json,q.graph_snapshot_id
         FROM run_active_query_plans active
         JOIN query_plan_revisions q ON q.id=active.query_plan_revision_id
         WHERE active.run_id=$1 FOR UPDATE`,
        [input.runId],
      );
      const active = immutable.rows[0];
      const queryHash = queryPlanV3Hash(input.queryPlan);
      if (!active || active.id !== input.fence.queryPlanRevisionId
        || active.plan_hash !== queryHash || active.graph_snapshot_id !== input.queryPlan.graphSnapshotId
        || !isQueryPlanV3(active.plan_json) || queryPlanV3Hash(active.plan_json) !== queryHash) {
        throw new HttpError(409, "Pipeline V3 corpus write is not bound to the active query plan", "v3_corpus_plan_mismatch");
      }

      const subjectName = input.queryPlan.membershipPredicates.find((predicate) => (
        predicate.kind === "factual_relationship" || predicate.kind === "artist"
      ))?.subject?.split(" | ")[0]?.trim()
        || input.queryPlan.membershipPredicates[0]?.subject?.split(" | ")[0]?.trim()
        || "Unknown subject";
      const subjectKey = subjectName.normalize("NFKC").toLocaleLowerCase("en-US");
      const subjectId = deterministicUuid({ kind: "corpus_entity", entityType: "person_or_organization", canonicalKey: subjectKey });
      await client.query(
        `INSERT INTO corpus_entities(id,entity_type,canonical_key,canonical_name,state,metadata_json)
         VALUES($1,'person_or_organization',$2,$3,'active',$4::jsonb)
         ON CONFLICT(entity_type,canonical_key) DO UPDATE SET
           canonical_name=EXCLUDED.canonical_name,updated_at=now()`,
        [subjectId, subjectKey, subjectName.slice(0, 240), JSON.stringify({ discoveredByRunId: input.runId })],
      );
      const subject = await client.query<{ id: string }>(
        `SELECT id FROM corpus_entities WHERE entity_type='person_or_organization' AND canonical_key=$1`,
        [subjectKey],
      );
      const resolvedSubjectId = subject.rows[0]!.id;

      const bySource = new Map<string, typeof input.result.observations>();
      for (const observation of input.result.observations) {
        const rows = bySource.get(observation.sourceUrl) ?? [];
        rows.push(observation);
        bySource.set(observation.sourceUrl, rows);
      }
      const sourceIds = new Map<string, string>();
      for (const [url, observations] of bySource) {
        const contentHash = sha256Hex(stableStringify(observations.map((row) => ({
          artist: row.artist,
          title: row.title,
          excerpt: row.supportExcerpt,
        }))));
        const sourceId = deterministicUuid({ kind: "corpus_source_document", url, contentHash });
        const hostname = new URL(url).hostname.toLowerCase();
        await client.query(
          `INSERT INTO corpus_source_documents(
             id,url,content_hash,title,source_class,provenance_root,access_method,
             approval_state,authority,license_state,cache_policy,retention_policy,
             freshness_policy,freshness_expires_at,source_revision,status,
             retrieved_at,last_verified_at,metadata_json)
           VALUES($1,$2,$3,$4,'hosted_web',$5,'hosted_web_search',
             'pending','unknown','unknown','excerpt_only','ninety_days',
             'revalidate_30d',now()+interval '30 days',$3,'active',now(),now(),$6::jsonb)
           ON CONFLICT(url,content_hash) DO NOTHING`,
          [
            sourceId,
            url,
            contentHash,
            observations[0]!.sourceTitle.slice(0, 240),
            hostname.slice(0, 240),
            JSON.stringify({
              ingestionRunId: input.runId,
              queryPlanRevisionId: input.fence.queryPlanRevisionId,
              responseId: input.result.responseId,
              extractionMethod: "hosted_search",
              policyState: "pending_owner_review",
              reusable: false,
            }),
          ],
        );
        const stored = await client.query<{ id: string }>(
          `SELECT id FROM corpus_source_documents WHERE url=$1 AND content_hash=$2`,
          [url, contentHash],
        );
        sourceIds.set(url, stored.rows[0]!.id);
      }

      let observationCount = 0;
      for (const row of input.result.observations) {
        const artistKey = row.artist.normalize("NFKC").toLocaleLowerCase("en-US");
        const artistId = deterministicUuid({ kind: "corpus_entity", entityType: "artist", canonicalKey: artistKey });
        await client.query(
          `INSERT INTO corpus_entities(id,entity_type,canonical_key,canonical_name,state,metadata_json)
           VALUES($1,'artist',$2,$3,'active','{}'::jsonb)
           ON CONFLICT(entity_type,canonical_key) DO UPDATE SET canonical_name=EXCLUDED.canonical_name,updated_at=now()`,
          [artistId, artistKey, row.artist],
        );
        const storedArtist = await client.query<{ id: string }>(
          `SELECT id FROM corpus_entities WHERE entity_type='artist' AND canonical_key=$1`,
          [artistKey],
        );
        // PostgreSQL text rejects NUL bytes. Keep the canonical key compact and
        // deterministic without persisting an in-memory tuple separator.
        const recordingKey = sha256Hex(stableStringify({
          artist: artistKey,
          title: row.title.normalize("NFKC").toLocaleLowerCase("en-US"),
        }));
        const recordingId = deterministicUuid({ kind: "corpus_recording", canonicalKey: recordingKey });
        await client.query(
          `INSERT INTO corpus_recordings(id,canonical_key,primary_artist_entity_id,title,version_class,state,metadata_json)
           VALUES($1,$2,$3,$4,'unknown','active',$5::jsonb)
           ON CONFLICT(canonical_key) DO UPDATE SET updated_at=now()`,
          [recordingId, recordingKey, storedArtist.rows[0]!.id, row.title, JSON.stringify({ album: row.album })],
        );
        const storedRecording = await client.query<{ id: string }>(
          `SELECT id FROM corpus_recordings WHERE canonical_key=$1`, [recordingKey],
        );
        const observationKey = sha256Hex(stableStringify({
          sourceDocumentId: sourceIds.get(row.sourceUrl),
          subjectEntityId: resolvedSubjectId,
          recordingId: storedRecording.rows[0]!.id,
          predicate: row.predicate,
          relationship: row.relationship,
          excerpt: row.supportExcerpt,
        }));
        const inserted = await client.query(
          `INSERT INTO corpus_assertion_observations(
             id,observation_key,source_document_id,subject_entity_id,recording_id,predicate,
             object_json,credit_scope,support_excerpt,confidence,status,pipeline_version,policy_version)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,'quarantined','corpus_first_v3','corpus_first_v3_policy_v1')
           ON CONFLICT(observation_key) DO NOTHING`,
          [
            deterministicUuid({ kind: "corpus_observation", observationKey }),
            observationKey,
            sourceIds.get(row.sourceUrl),
            resolvedSubjectId,
            storedRecording.rows[0]!.id,
            row.predicate,
            JSON.stringify({
              relationship: row.relationship,
              role: row.role,
              artist: row.artist,
              title: row.title,
              album: row.album,
              polarity: "supports",
              ingestionRunId: input.runId,
              queryPlanRevisionId: input.fence.queryPlanRevisionId,
            }),
            row.creditScope === "unknown" ? null : row.creditScope,
            row.supportExcerpt,
            row.confidence,
          ],
        );
        observationCount += inserted.rowCount ?? 0;
      }

      const isExhaustive = input.queryPlan.engines.includes("exhaustive");
      const frontierStatus = input.result.enumerationComplete ? "complete" : "unresolved";
      await this.upsertFrontierInTransaction(client, input.runId, [{
        sourceClass: "v3_cold_corpus",
        strategy: isExhaustive ? "exhaustive_source_frontier" : "factual_relationship_discovery",
        cursor: input.result.nextCursor,
        status: frontierStatus,
        discoveredCount: input.result.recoveredTotal,
        recoveredCount: input.result.observations.length,
        note: input.result.enumerationComplete
          ? "Hosted corpus frontier was reconciled; observations remain quarantined pending review."
          : `Corpus discovery is incomplete and quarantined pending review. ${input.result.gaps.join(" ")}`,
      }]);
      await client.query(
         `INSERT INTO research_containers(
           id,run_id,container_type,provider_id,title,status,cursor,advertised_total,recovered_total,metadata_json,completed_at)
         VALUES($1,$2,'collection',$3,$4,$5::varchar,$6,$7,$8,$9::jsonb,
           CASE WHEN $5::varchar='complete' THEN now() ELSE NULL END)
         ON CONFLICT(run_id,container_type,provider_id) DO UPDATE SET
           status=EXCLUDED.status,cursor=EXCLUDED.cursor,advertised_total=EXCLUDED.advertised_total,
           recovered_total=GREATEST(research_containers.recovered_total,EXCLUDED.recovered_total),
           metadata_json=research_containers.metadata_json||EXCLUDED.metadata_json,
           completed_at=CASE WHEN EXCLUDED.status='complete' THEN now() ELSE NULL END,updated_at=now()`,
        [
          deterministicUuid({ kind: "v3_corpus_container", runId: input.runId }),
          input.runId,
          `v3-corpus:${input.fence.queryPlanRevisionId}`,
          isExhaustive ? "Exhaustive source frontier" : "Factual source discovery",
          frontierStatus,
          input.result.nextCursor,
          input.result.advertisedTotal,
          input.result.recoveredTotal,
          JSON.stringify({
            responseId: input.result.responseId,
            sourceDocumentCount: sourceIds.size,
            observationCount,
            zeroNewEvidenceGapPasses: input.result.zeroNewEvidenceGapPasses,
            gaps: input.result.gaps,
            ownerReviewRequired: true,
          }),
        ],
      );
      return {
        sourceDocumentCount: sourceIds.size,
        observationCount,
        enumerationComplete: input.result.enumerationComplete,
        unresolvedGapCount: input.result.gaps.length + (input.result.enumerationComplete ? 0 : 1),
      };
    });
  }

  /**
   * Read-only owner gate for a cold factual/exhaustive run. A run cannot move
   * forward while any observation from the active plan is still quarantined,
   * and it needs at least one reviewed active assertion. Exhaustive work also
   * needs a reconciled, cursor-free frontier with two zero-new-evidence passes.
   */
  async getPipelineV3CorpusResumeReplay(runId: string, idempotencyKey: string): Promise<{
    queued: true;
    graphSnapshotId: string;
    queryPlanRevisionId: string;
    jobId: string;
  } | null> {
    const result = await this.pool.query<{ state_json: Record<string, unknown> }>(
      `SELECT state_json FROM research_checkpoints
       WHERE run_id=$1 AND phase='v3:corpus:resume'`,
      [runId],
    );
    const state = result.rows[0]?.state_json;
    if (!state) return null;
    if (state.idempotencyKey !== idempotencyKey) {
      throw new HttpError(409, "This corpus review has already been resumed", "corpus_review_already_resumed");
    }
    if (typeof state.reviewedGraphSnapshotId !== "string"
      || typeof state.successorQueryPlanRevisionId !== "string"
      || typeof state.jobId !== "string") {
      throw new HttpError(409, "The corpus resume checkpoint failed integrity validation", "v3_corpus_checkpoint_integrity");
    }
    return {
      queued: true,
      graphSnapshotId: state.reviewedGraphSnapshotId,
      queryPlanRevisionId: state.successorQueryPlanRevisionId,
      jobId: state.jobId,
    };
  }

  async preparePipelineV3CorpusResume(runId: string): Promise<{
    parentGraphSnapshotId: string;
    sourceQueryPlanRevisionId: string;
    sourceQueryPlanHash: string;
    sourceStageKey: string;
    sourceCheckpointHash: string;
    enumerationComplete: boolean;
    promotedAssertionCount: number;
  }> {
    const activeResult = await this.pool.query<{
      run_status: string;
      id: string;
      plan_hash: string;
      plan_json: unknown;
      graph_snapshot_id: string;
      checkpoint: unknown;
    }>(
      `SELECT r.status run_status,q.id,q.plan_hash,q.plan_json,q.graph_snapshot_id,
              checkpoint.state_json checkpoint
       FROM research_runs r
       JOIN run_active_query_plans active ON active.run_id=r.id
       JOIN query_plan_revisions q ON q.id=active.query_plan_revision_id
       LEFT JOIN research_checkpoints checkpoint
         ON checkpoint.run_id=r.id AND checkpoint.phase='v3:corpus:action-required'
       WHERE r.id=$1 AND r.deleted_at IS NULL`,
      [runId],
    );
    const active = activeResult.rows[0];
    if (!active) throw new HttpError(404, "Pipeline V3 corpus run was not found", "run_not_found");
    if (active.run_status !== "waiting_for_corpus_review") {
      throw new HttpError(409, "The run is not waiting for corpus review", "corpus_review_not_ready");
    }
    if (!isQueryPlanV3(active.plan_json) || queryPlanV3Hash(active.plan_json) !== active.plan_hash) {
      throw new HttpError(409, "The active corpus plan failed integrity validation", "v3_query_plan_integrity");
    }
    const checkpoint = active.checkpoint && typeof active.checkpoint === "object" && !Array.isArray(active.checkpoint)
      ? active.checkpoint as Record<string, unknown>
      : null;
    if (!checkpoint
      || checkpoint.state !== "owner_action_required"
      || checkpoint.actionKind !== "corpus_review"
      || checkpoint.queryPlanRevisionId !== active.id
      || checkpoint.queryPlanHash !== active.plan_hash
      || typeof checkpoint.stageKey !== "string") {
      throw new HttpError(409, "The corpus review checkpoint failed integrity validation", "v3_corpus_checkpoint_integrity");
    }
    const observationResult = await this.pool.query<{
      observation_count: number;
      quarantined_count: number;
      promoted_count: number;
      promoted_assertion_count: number;
    }>(
      `SELECT count(DISTINCT observation.id)::int observation_count,
              count(DISTINCT observation.id) FILTER (WHERE observation.status='quarantined')::int quarantined_count,
              count(DISTINCT observation.id) FILTER (WHERE observation.status='promoted')::int promoted_count,
              count(DISTINCT assertion.id) FILTER (WHERE assertion.status='active')::int promoted_assertion_count
       FROM corpus_assertion_observations observation
       LEFT JOIN corpus_assertion_evidence evidence ON evidence.observation_id=observation.id
       LEFT JOIN corpus_promoted_assertions assertion ON assertion.id=evidence.promoted_assertion_id
       WHERE observation.object_json->>'ingestionRunId'=$1
         AND observation.object_json->>'queryPlanRevisionId'=$2`,
      [runId, active.id],
    );
    const counts = observationResult.rows[0];
    if (!counts || Number(counts.observation_count) === 0) {
      throw new HttpError(409, "No source-bound corpus observations are ready for review", "corpus_review_empty");
    }
    if (Number(counts.quarantined_count) > 0) {
      throw new HttpError(409, "Every corpus observation must be promoted or rejected before resuming", "corpus_review_pending");
    }
    if (Number(counts.promoted_count) === 0 || Number(counts.promoted_assertion_count) === 0) {
      throw new HttpError(409, "Resume requires at least one promoted corpus assertion", "corpus_review_no_promoted_evidence");
    }

    let enumerationComplete = !active.plan_json.engines.includes("exhaustive");
    if (active.plan_json.engines.includes("exhaustive")) {
      const frontier = await this.pool.query<{
        status: string;
        cursor: string | null;
        advertised_total: number | null;
        recovered_total: number;
        zero_new_passes: number;
        gaps: unknown;
      }>(
        `SELECT container.status,container.cursor,container.advertised_total,container.recovered_total,
                COALESCE((container.metadata_json->>'zeroNewEvidenceGapPasses')::int,0) zero_new_passes,
                container.metadata_json->'gaps' gaps
         FROM research_containers container
         JOIN source_frontier frontier ON frontier.run_id=container.run_id
           AND frontier.source_class='v3_cold_corpus'
           AND frontier.strategy='exhaustive_source_frontier'
         WHERE container.run_id=$1 AND container.provider_id=$2
           AND frontier.status='complete' AND frontier.cursor IS NULL
         LIMIT 1`,
        [runId, `v3-corpus:${active.id}`],
      );
      const row = frontier.rows[0];
      const gaps = Array.isArray(row?.gaps) ? row.gaps.filter(Boolean) : [];
      enumerationComplete = Boolean(row
        && row.status === "complete"
        && row.cursor === null
        && row.advertised_total !== null
        && Number(row.recovered_total) >= Number(row.advertised_total)
        && Number(row.zero_new_passes) >= 2
        && gaps.length === 0);
      if (!enumerationComplete) {
        throw new HttpError(
          409,
          "Exhaustive corpus enumeration is incomplete; resolve its cursors, totals, and gaps before resuming",
          "v3_exhaustive_frontier_incomplete",
        );
      }
    }
    return {
      parentGraphSnapshotId: active.graph_snapshot_id,
      sourceQueryPlanRevisionId: active.id,
      sourceQueryPlanHash: active.plan_hash,
      sourceStageKey: checkpoint.stageKey,
      sourceCheckpointHash: sha256Hex(stableStringify(checkpoint)),
      enumerationComplete,
      promotedAssertionCount: Number(counts.promoted_assertion_count),
    };
  }

  /**
   * Activate a reviewed successor snapshot/query revision and enqueue only a
   * deep research job. The active source revision and owner checkpoint are
   * revalidated under row locks so a stale review cannot authorize work.
   */
  async resumePipelineV3CorpusResearch(input: {
    runId: string;
    reviewedGraphSnapshotId: string;
    expectedSourceQueryPlanRevisionId: string;
    expectedSourceCheckpointHash: string;
    idempotencyKey: string;
  }): Promise<{
    queued: boolean;
    graphSnapshotId: string;
    queryPlanRevisionId: string;
    jobId: string;
  }> {
    return this.transaction(async (client) => {
      const priorResult = await client.query<{ state_json: Record<string, unknown> }>(
        `SELECT state_json FROM research_checkpoints
         WHERE run_id=$1 AND phase='v3:corpus:resume' FOR UPDATE`,
        [input.runId],
      );
      const prior = priorResult.rows[0]?.state_json;
      if (prior) {
        if (prior.idempotencyKey === input.idempotencyKey
          && prior.reviewedGraphSnapshotId === input.reviewedGraphSnapshotId
          && typeof prior.successorQueryPlanRevisionId === "string"
          && typeof prior.jobId === "string") {
          return {
            queued: true,
            graphSnapshotId: input.reviewedGraphSnapshotId,
            queryPlanRevisionId: prior.successorQueryPlanRevisionId,
            jobId: prior.jobId,
          };
        }
        throw new HttpError(409, "This corpus review has already been resumed", "corpus_review_already_resumed");
      }
      const activeResult = await client.query<{
        run_status: string;
        id: string;
        revision: number;
        selection_plan_id: string;
        graph_snapshot_id: string;
        engine: string;
        plan_hash: string;
        plan_json: unknown;
        checkpoint: unknown;
      }>(
        `SELECT r.status run_status,q.id,q.revision,q.selection_plan_id,q.graph_snapshot_id,
                q.engine,q.plan_hash,q.plan_json,checkpoint.state_json checkpoint
         FROM research_runs r
         JOIN run_active_query_plans active ON active.run_id=r.id
         JOIN query_plan_revisions q ON q.id=active.query_plan_revision_id
         LEFT JOIN research_checkpoints checkpoint
           ON checkpoint.run_id=r.id AND checkpoint.phase='v3:corpus:action-required'
         WHERE r.id=$1 AND r.deleted_at IS NULL FOR UPDATE OF r,active,q`,
        [input.runId],
      );
      const source = activeResult.rows[0];
      if (!source) throw new HttpError(404, "Pipeline V3 corpus run was not found", "run_not_found");
      if (source.run_status !== "waiting_for_corpus_review"
        || source.id !== input.expectedSourceQueryPlanRevisionId
        || !isQueryPlanV3(source.plan_json)
        || queryPlanV3Hash(source.plan_json) !== source.plan_hash) {
        throw new HttpError(409, "The active corpus plan changed during review", "corpus_review_stale");
      }
      const checkpoint = source.checkpoint && typeof source.checkpoint === "object" && !Array.isArray(source.checkpoint)
        ? source.checkpoint as Record<string, unknown>
        : null;
      if (!checkpoint
        || checkpoint.state !== "owner_action_required"
        || checkpoint.actionKind !== "corpus_review"
        || checkpoint.queryPlanRevisionId !== source.id
        || checkpoint.queryPlanHash !== source.plan_hash
        || typeof checkpoint.stageKey !== "string"
        || sha256Hex(stableStringify(checkpoint)) !== input.expectedSourceCheckpointHash) {
        throw new HttpError(409, "The corpus review checkpoint changed during review", "corpus_review_stale");
      }
      const reviewed = await client.query<{ status: string; parent_snapshot_id: string | null }>(
        "SELECT status,parent_snapshot_id FROM graph_snapshots WHERE id=$1 FOR SHARE",
        [input.reviewedGraphSnapshotId],
      );
      if (reviewed.rows[0]?.status !== "locked"
        || reviewed.rows[0].parent_snapshot_id !== source.graph_snapshot_id) {
        throw new HttpError(409, "Corpus resume requires a locked direct-successor graph snapshot", "corpus_snapshot_invalid");
      }
      const reviewedObservations = await client.query<{
        observation_count: number;
        quarantined_count: number;
        promoted_assertion_count: number;
        snapshot_assertion_count: number;
      }>(
        `SELECT count(DISTINCT observation.id)::int observation_count,
                count(DISTINCT observation.id) FILTER (WHERE observation.status='quarantined')::int quarantined_count,
                count(DISTINCT assertion.id) FILTER (WHERE assertion.status='active')::int promoted_assertion_count,
                count(DISTINCT snapshot_assertion.assertion_id)
                  FILTER (WHERE assertion.status='active')::int snapshot_assertion_count
         FROM corpus_assertion_observations observation
         LEFT JOIN corpus_assertion_evidence evidence ON evidence.observation_id=observation.id
         LEFT JOIN corpus_promoted_assertions assertion ON assertion.id=evidence.promoted_assertion_id
         LEFT JOIN graph_snapshot_assertions snapshot_assertion
           ON snapshot_assertion.assertion_id=assertion.id
          AND snapshot_assertion.graph_snapshot_id=$3
         WHERE observation.object_json->>'ingestionRunId'=$1
           AND observation.object_json->>'queryPlanRevisionId'=$2`,
        [input.runId, source.id, input.reviewedGraphSnapshotId],
      );
      const reviewCounts = reviewedObservations.rows[0];
      if (!reviewCounts || Number(reviewCounts.observation_count) === 0
        || Number(reviewCounts.quarantined_count) > 0
        || Number(reviewCounts.promoted_assertion_count) === 0) {
        throw new HttpError(409, "Corpus review is incomplete", "corpus_review_pending");
      }
      if (Number(reviewCounts.snapshot_assertion_count) !== Number(reviewCounts.promoted_assertion_count)) {
        throw new HttpError(
          409,
          "The reviewed graph snapshot does not contain every promoted assertion from this run",
          "corpus_snapshot_incomplete",
        );
      }
      let enumerationComplete = !source.plan_json.engines.includes("exhaustive");
      if (source.plan_json.engines.includes("exhaustive")) {
        const frontier = await client.query<{
          status: string;
          cursor: string | null;
          advertised_total: number | null;
          recovered_total: number;
          zero_new_passes: number;
          gaps: unknown;
        }>(
          `SELECT container.status,container.cursor,container.advertised_total,container.recovered_total,
                  COALESCE((container.metadata_json->>'zeroNewEvidenceGapPasses')::int,0) zero_new_passes,
                  container.metadata_json->'gaps' gaps
           FROM research_containers container
           JOIN source_frontier frontier ON frontier.run_id=container.run_id
             AND frontier.source_class='v3_cold_corpus'
             AND frontier.strategy='exhaustive_source_frontier'
           WHERE container.run_id=$1 AND container.provider_id=$2
             AND frontier.status='complete' AND frontier.cursor IS NULL
           LIMIT 1 FOR UPDATE OF container,frontier`,
          [input.runId, `v3-corpus:${source.id}`],
        );
        const row = frontier.rows[0];
        const gaps = Array.isArray(row?.gaps) ? row.gaps.filter(Boolean) : [];
        enumerationComplete = Boolean(row
          && row.status === "complete"
          && row.cursor === null
          && row.advertised_total !== null
          && Number(row.recovered_total) >= Number(row.advertised_total)
          && Number(row.zero_new_passes) >= 2
          && gaps.length === 0);
        if (!enumerationComplete) {
          throw new HttpError(409, "Exhaustive corpus enumeration is incomplete", "v3_exhaustive_frontier_incomplete");
        }
      }
      const reviewedAt = new Date().toISOString();
      const successorPlan: QueryPlanV3 = {
        ...source.plan_json,
        graphSnapshotId: input.reviewedGraphSnapshotId,
        corpusReview: {
          sourceQueryPlanRevisionId: source.id,
          sourceQueryPlanHash: source.plan_hash,
          sourceStageKey: checkpoint.stageKey,
          sourceCheckpointHash: input.expectedSourceCheckpointHash,
          reviewedGraphSnapshotId: input.reviewedGraphSnapshotId,
          enumerationComplete,
          reviewedAt,
        },
      };
      if (!isQueryPlanV3(successorPlan)) {
        throw new HttpError(409, "The reviewed successor plan is invalid", "v3_query_plan_integrity");
      }
      const successorHash = queryPlanV3Hash(successorPlan);
      const successorId = randomUUID();
      const successorStageKey = `v3-retrieval:active:${successorHash.slice(0, 48)}`;
      await client.query(
        `INSERT INTO query_plan_revisions(
           id,run_id,selection_plan_id,revision,parent_revision_id,graph_snapshot_id,
           engine,status,plan_hash,plan_json,pipeline_version,policy_version,activated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$9::jsonb,
           'corpus_first_v3','corpus_first_v3_policy_v1',now())`,
        [
          successorId,
          input.runId,
          source.selection_plan_id,
          source.revision + 1,
          source.id,
          input.reviewedGraphSnapshotId,
          source.engine,
          successorHash,
          JSON.stringify(successorPlan),
        ],
      );
      await client.query(
        `UPDATE run_active_query_plans
         SET query_plan_revision_id=$2,activated_at=now() WHERE run_id=$1`,
        [input.runId, successorId],
      );
      await client.query(
        "UPDATE query_plan_revisions SET status='superseded' WHERE id=$1 AND status='active'",
        [source.id],
      );
      const jobId = randomUUID();
      const dedupeKey = `v3-corpus-resume:${input.runId}:${source.id}:${successorHash}`;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO job_queue(
           id,run_id,kind,dedupe_key,payload_json,max_attempts,pipeline_version,
           minimum_worker_protocol,query_plan_revision_id,stage_key,queue_class)
         VALUES($1,$2,'research',$3,$4::jsonb,10,'corpus_first_v3',$5,$6,$7,'deep')
         ON CONFLICT(kind,dedupe_key) DO NOTHING RETURNING id`,
        [
          jobId,
          input.runId,
          dedupeKey,
          JSON.stringify({
            runId: input.runId,
            phase: "v3_corpus_review_resume",
            v3ExecutionMode: "active",
            stageExecutionKey: successorStageKey,
            reviewedGraphSnapshotId: input.reviewedGraphSnapshotId,
          }),
          minimumWorkerProtocolForQueryPlan(successorPlan),
          successorId,
          successorStageKey,
        ],
      );
      if (!inserted.rows[0]) {
        throw new HttpError(409, "The corpus resume job could not be created", "corpus_resume_conflict");
      }
      await client.query(
        `INSERT INTO research_checkpoints(run_id,phase,state_json)
         VALUES($1,'v3:corpus:resume',$2::jsonb)`,
        [input.runId, JSON.stringify({
          idempotencyKey: input.idempotencyKey,
          sourceQueryPlanRevisionId: source.id,
          sourceQueryPlanHash: source.plan_hash,
          sourceCheckpointHash: input.expectedSourceCheckpointHash,
          reviewedGraphSnapshotId: input.reviewedGraphSnapshotId,
          successorQueryPlanRevisionId: successorId,
          successorQueryPlanHash: successorHash,
          successorStageKey,
          jobId: inserted.rows[0].id,
          enumerationComplete,
          promotedAssertionCount: Number(reviewCounts.promoted_assertion_count),
          queuedAt: reviewedAt,
        })],
      );
      await client.query(
        `UPDATE research_runs SET status='queued',phase='v3_corpus_review_resume',
           error=NULL,completed_at=NULL,updated_at=now() WHERE id=$1`,
        [input.runId],
      );
      return {
        queued: true,
        graphSnapshotId: input.reviewedGraphSnapshotId,
        queryPlanRevisionId: successorId,
        jobId: inserted.rows[0].id,
      };
    });
  }

  async getFrontier(runId: string): Promise<SourceFrontierItem[]> {
    const result = await this.pool.query("SELECT * FROM source_frontier WHERE run_id=$1 ORDER BY source_class,strategy", [runId]);
    return result.rows.map((row) => ({
      sourceClass: row.source_class,
      strategy: row.strategy,
      cursor: row.cursor,
      status: row.status,
      discoveredCount: row.discovered_count,
      recoveredCount: row.recovered_count,
      note: row.note,
    }));
  }

  async getCoverage(runId: string): Promise<Record<string, unknown>> {
    const run = await this.getRun(runId);
    const [keys, containers, eligibility] = await Promise.all([
      this.pool.query<{ canonical_key: string }>("SELECT canonical_key FROM track_candidates WHERE run_id=$1 ORDER BY created_at LIMIT 250", [runId]),
      this.listResearchContainers(runId),
      this.pool.query<{ verified_count: number; editorial_count: number }>(
        `SELECT
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM evidence_claims e
             JOIN source_records es ON es.id=e.source_id AND es.source_class='web'
             JOIN citation_attestations ca ON ca.id=e.citation_attestation_id
               AND ca.run_id=e.run_id AND ca.source_url=es.url
             WHERE e.candidate_id=c.id
             AND e.state IN ('verified','corroborated')
             AND e.support_scope='track' AND e.verification_phase='track_verification'
             AND e.subject_entity=ANY($2::text[]) AND e.subject_relationship=$3
           ))::int verified_count,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM evidence_claims e
             JOIN source_records es ON es.id=e.source_id AND es.source_class='web'
             JOIN citation_attestations ca ON ca.id=e.citation_attestation_id
               AND ca.run_id=e.run_id AND ca.source_url=es.url
             WHERE e.candidate_id=c.id
             AND ((e.state IN ('verified','corroborated') AND e.support_scope='track' AND e.verification_phase='track_verification')
               OR e.state='editorial')
             AND e.subject_entity=ANY($2::text[]) AND e.subject_relationship=$3
           ))::int editorial_count
         FROM track_candidates c WHERE c.run_id=$1`,
        [runId, run.brief.subjectEntities, run.brief.relationship],
      ),
    ]);
    const eligibleCandidateCount = requiresFactualFrontier(run.brief, run.selectionPlan)
      ? Number(eligibility.rows[0]?.verified_count ?? 0)
      : Number(eligibility.rows[0]?.editorial_count ?? 0);
    return { candidateCount: run.candidateCount, eligibleCandidateCount, sourceCount: run.sourceCount, unresolvedCount: run.unresolvedCount, frontier: run.frontier, containers, existingKeys: keys.rows.map((row) => row.canonical_key) };
  }

  async upsertResearchContainers(runId: string, items: ResearchContainerInput[]): Promise<void> {
    await this.transaction(async (client) => {
      for (const item of items) {
        await client.query(
          `INSERT INTO research_containers(
             id,run_id,source_record_id,parent_container_id,container_type,provider_id,title,status,cursor,
             advertised_total,recovered_total,metadata_json,completed_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::varchar,$9,$10,$11,$12,CASE WHEN $8::varchar='complete' THEN now() ELSE NULL END)
           ON CONFLICT(run_id,container_type,provider_id) DO UPDATE SET source_record_id=COALESCE(EXCLUDED.source_record_id,research_containers.source_record_id),
             parent_container_id=COALESCE(EXCLUDED.parent_container_id,research_containers.parent_container_id),title=EXCLUDED.title,
             status=CASE WHEN EXCLUDED.status='discovered' THEN research_containers.status ELSE EXCLUDED.status END,
             cursor=CASE
               WHEN EXCLUDED.status='discovered' AND research_containers.status<>'discovered' THEN research_containers.cursor
               WHEN EXCLUDED.status='discovered' THEN COALESCE(research_containers.cursor,EXCLUDED.cursor)
               ELSE EXCLUDED.cursor END,
             advertised_total=CASE
               WHEN EXCLUDED.status='discovered' AND research_containers.status<>'discovered' THEN research_containers.advertised_total
               WHEN EXCLUDED.status='discovered' THEN COALESCE(research_containers.advertised_total,EXCLUDED.advertised_total)
               ELSE EXCLUDED.advertised_total END,
             recovered_total=CASE
               WHEN EXCLUDED.status='discovered' AND research_containers.status<>'discovered' THEN research_containers.recovered_total
               WHEN EXCLUDED.status='discovered' THEN GREATEST(research_containers.recovered_total,EXCLUDED.recovered_total)
               ELSE EXCLUDED.recovered_total END,
             metadata_json=CASE WHEN EXCLUDED.status='discovered'
               THEN COALESCE(EXCLUDED.metadata_json,'{}'::jsonb)||COALESCE(research_containers.metadata_json,'{}'::jsonb)
               ELSE EXCLUDED.metadata_json END,
             completed_at=CASE
               WHEN EXCLUDED.status='discovered' THEN research_containers.completed_at
               WHEN EXCLUDED.status='complete' THEN COALESCE(research_containers.completed_at,now())
               ELSE NULL END,updated_at=now()`,
          [item.id ?? randomUUID(), runId, item.sourceRecordId ?? null, item.parentContainerId ?? null, item.containerType.slice(0, 48), item.providerId.slice(0, 240), item.title.slice(0, 240), item.status.slice(0, 32), item.cursor ?? null, item.advertisedTotal ?? null, item.recoveredTotal ?? 0, item.metadata ?? {}],
        );
      }
    });
  }

  async listResearchContainers(runId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT id,source_record_id,parent_container_id,container_type,provider_id,title,status,cursor,
       advertised_total,recovered_total,metadata_json,completed_at FROM research_containers
       WHERE run_id=$1 ORDER BY container_type,title,provider_id`,
      [runId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      sourceRecordId: row.source_record_id,
      parentContainerId: row.parent_container_id,
      containerType: row.container_type,
      providerId: row.provider_id,
      title: row.title,
      status: row.status,
      cursor: row.cursor,
      advertisedTotal: row.advertised_total,
      recoveredTotal: row.recovered_total,
      metadata: row.metadata_json,
      completedAt: date(row.completed_at)?.toISOString() ?? null,
    }));
  }

  async listCandidates(runId: string): Promise<CandidateRow[]> {
    const [result, evidenceResult, scopeBindingResult] = await Promise.all([
      this.pool.query(
        "SELECT * FROM track_candidates WHERE run_id=$1 ORDER BY selection_rank NULLS LAST,artist,release_year NULLS LAST,album NULLS LAST,title,id",
        [runId],
      ),
      this.pool.query(
        `SELECT e.candidate_id,s.url source_url,s.source_class,e.state,e.support_scope,e.verification_phase,
           e.subject_entity,e.subject_relationship,e.relationship,e.note,
           ca.response_id,ca.output_item_id,ca.content_index,ca.start_index,ca.end_index,ca.excerpt
         FROM evidence_claims e
         JOIN source_records s ON s.id=e.source_id
         LEFT JOIN citation_attestations ca ON ca.id=e.citation_attestation_id
           AND ca.run_id=e.run_id AND ca.source_url=s.url
         WHERE e.run_id=$1 ORDER BY e.candidate_id,e.state,s.url`,
        [runId],
      ),
      this.pool.query(
        `SELECT candidate_id,source_record_id,source_url,research_container_id,citation_attestation_id,
           binding_kind,eligibility,scope_axis,scope_value,relationship,confidence,
           provenance_path_json,note
         FROM track_scope_bindings WHERE run_id=$1
         ORDER BY candidate_id,eligibility,binding_kind,scope_axis,scope_value,relationship`,
        [runId],
      ),
    ]);
    const evidenceByCandidate = new Map<string, any[]>();
    for (const row of evidenceResult.rows) {
      const evidence = evidenceByCandidate.get(row.candidate_id) ?? [];
      evidence.push({
        sourceUrl: row.source_url,
        sourceClass: row.source_class,
        state: ((row.state === "verified" || row.state === "corroborated" || row.state === "disputed")
            && (row.support_scope !== "track" || row.verification_phase !== "track_verification"
              || row.source_class !== "web" || !row.response_id))
          || (row.state === "editorial" && (row.source_class !== "web" || !row.response_id))
          ? "inferred"
          : row.state,
        supportScope: row.support_scope,
        verificationPhase: row.verification_phase,
        subjectEntity: row.subject_entity,
        subjectRelationship: row.subject_relationship,
        relationship: row.relationship,
        note: row.note,
        citationSupport: row.response_id ? {
          responseId: row.response_id,
          outputItemId: row.output_item_id,
          contentIndex: row.content_index,
          startIndex: row.start_index,
          endIndex: row.end_index,
          excerpt: row.excerpt,
        } : null,
      });
      evidenceByCandidate.set(row.candidate_id, evidence);
    }
    const scopeBindingsByCandidate = new Map<string, TrackScopeBinding[]>();
    for (const row of scopeBindingResult.rows) {
      const bindings = scopeBindingsByCandidate.get(row.candidate_id) ?? [];
      const provenancePath = Array.isArray(row.provenance_path_json) ? row.provenance_path_json : [];
      const binding: TrackScopeBinding = {
        bindingKind: row.binding_kind,
        eligibility: row.eligibility,
        scopeAxis: row.scope_axis,
        scopeValue: row.scope_value,
        geographyRelationship: null,
        relationship: row.relationship,
        confidence: Number(row.confidence),
        sourceUrl: row.source_url,
        sourceRecordId: row.source_record_id,
        researchContainerId: row.research_container_id,
        citationAttestationId: row.citation_attestation_id,
        provenancePath,
        note: row.note,
      };
      binding.geographyRelationship = bindingGeographyRelationship(binding);
      bindings.push(binding);
      scopeBindingsByCandidate.set(row.candidate_id, bindings);
    }
    return result.rows.map((row): CandidateRow => ({
        id: row.id,
        runId: row.run_id,
        selectionRank: row.selection_rank,
        artist: row.artist,
        title: row.title,
        album: row.album,
        releaseYear: row.release_year,
        durationMs: row.duration_ms,
        isrc: row.isrc,
        musicbrainzId: row.musicbrainz_id,
        versionLabel: row.version_label,
        candidateStage: row.candidate_stage ?? "discovered",
        recordingFamilyId: row.recording_family_id ?? null,
        scopeBindings: scopeBindingsByCandidate.get(row.id) ?? [],
        outcome: row.outcome,
        duplicateClusterKey: row.duplicate_cluster_key,
        pipelineVersion: row.pipeline_version ?? "legacy_v1",
        policyVersion: row.policy_version ?? "legacy_v1",
        evidence: evidenceByCandidate.get(row.id) ?? [],
      }));
  }

  async saveMatch(runId: string, match: CatalogMatchResult): Promise<void> {
    const normalizedScore = normalizedCatalogMatchScore(match.score);
    await this.transaction(async (client) => {
      const run = await client.query("SELECT id FROM research_runs WHERE id=$1 FOR UPDATE", [runId]);
      if (!run.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
      const candidate = await client.query(
        "SELECT id FROM track_candidates WHERE id=$1 AND run_id=$2 FOR UPDATE",
        [match.candidateId, runId],
      );
      if (!candidate.rows[0]) {
        throw new HttpError(409, "Catalog match candidate does not belong to this run", "catalog_candidate_scope_mismatch");
      }
      let resultingStatus = match.status;
      if (match.status === "accepted" && match.song?.id) {
        const duplicate = await client.query(
          "SELECT 1 FROM catalog_matches WHERE run_id=$1 AND catalog_id=$2 AND status='accepted' AND candidate_id<>$3 LIMIT 1",
          [runId, match.song.id, match.candidateId],
        );
        if (duplicate.rows[0]) resultingStatus = "duplicate";
      }
      await client.query(
        `INSERT INTO catalog_matches(
           id,run_id,candidate_id,status,basis,score,catalog_id,song_json,alternatives_json,
           initial_status,initial_basis,initial_score,initial_catalog_id,initial_song_json,initial_matched_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$4,$5,$6,$7,$8,now())
         ON CONFLICT(candidate_id) DO UPDATE SET status=EXCLUDED.status,basis=EXCLUDED.basis,score=EXCLUDED.score,
           catalog_id=EXCLUDED.catalog_id,song_json=EXCLUDED.song_json,alternatives_json=EXCLUDED.alternatives_json`,
        [
          randomUUID(),
          runId,
          match.candidateId,
          resultingStatus,
          match.basis,
          normalizedScore,
          match.song?.id ?? null,
          match.song ? JSON.stringify(match.song) : null,
          JSON.stringify(match.alternatives ?? []),
        ],
      );
      await client.query("UPDATE track_candidates SET outcome=$1 WHERE id=$2 AND run_id=$3", [resultingStatus, match.candidateId, runId]);
    });
  }

  async saveTimeoutMatches(runId: string, candidateIds: string[], basis: string): Promise<void> {
    if (candidateIds.length === 0) return;
    const uniqueCandidateIds = [...new Set(candidateIds)];
    if (uniqueCandidateIds.length !== candidateIds.length) {
      throw new HttpError(409, "Timed-out catalog candidates must be unique", "catalog_candidate_duplicate");
    }
    await this.transaction(async (client) => {
      const run = await client.query("SELECT id FROM research_runs WHERE id=$1 FOR UPDATE", [runId]);
      if (!run.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
      const scoped = await client.query<{ id: string }>(
        "SELECT id FROM track_candidates WHERE run_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE",
        [runId, uniqueCandidateIds],
      );
      if (scoped.rows.length !== uniqueCandidateIds.length) {
        throw new HttpError(409, "Catalog match candidate does not belong to this run", "catalog_candidate_scope_mismatch");
      }
      const existing = await client.query(
        "SELECT candidate_id FROM catalog_matches WHERE run_id=$1 AND candidate_id=ANY($2::uuid[]) LIMIT 1",
        [runId, uniqueCandidateIds],
      );
      if (existing.rows[0]) {
        throw new HttpError(409, "A timed-out catalog candidate already has an outcome", "catalog_candidate_already_matched");
      }
      const matchIds = uniqueCandidateIds.map(() => randomUUID());
      await client.query(
        `INSERT INTO catalog_matches(
           id,run_id,candidate_id,status,basis,score,catalog_id,song_json,alternatives_json,
           initial_status,initial_basis,initial_score,initial_catalog_id,initial_song_json,initial_matched_at)
         SELECT batch.match_id,$1,batch.candidate_id,'review',$4,0,NULL,NULL,'[]'::jsonb,
                'review',$4,0,NULL,NULL,now()
         FROM unnest($2::uuid[],$3::uuid[]) AS batch(match_id,candidate_id)`,
        [runId, matchIds, uniqueCandidateIds, basis],
      );
      await client.query(
        "UPDATE track_candidates SET outcome='review' WHERE run_id=$1 AND id=ANY($2::uuid[])",
        [runId, uniqueCandidateIds],
      );
    });
  }

  async listMatches(runId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT m.*,c.artist,c.title,c.album,c.duplicate_cluster_key FROM catalog_matches m
       JOIN track_candidates c ON c.id=m.candidate_id WHERE m.run_id=$1 ORDER BY c.artist,c.title,c.id`,
      [runId],
    );
    return result.rows.map((row) => ({
      candidateId: row.candidate_id,
      artist: row.artist,
      title: row.title,
      album: row.album,
      duplicateClusterKey: row.duplicate_cluster_key,
      status: row.status,
      basis: row.basis,
      score: Number(row.score),
      song: row.song_json,
      alternatives: row.alternatives_json ?? [],
      reviewedAt: date(row.reviewed_at)?.toISOString() ?? null,
    }));
  }

  async listExceptions(runId: string, page: number, pageSize = 20): Promise<{ items: any[]; page: number; pageSize: number; total: number; totalPages: number; unresolvedCount: number }> {
    const safePage = Math.max(1, Math.floor(page));
    const size = Math.max(1, Math.min(Math.floor(pageSize), 20));
    const offset = (safePage - 1) * size;
    const count = await this.pool.query<{ total: number }>(
      "SELECT count(*)::int total FROM catalog_matches WHERE run_id=$1 AND status IN ('review','unavailable')",
      [runId],
    );
    const rows = await this.pool.query(
      `SELECT m.*,c.artist,c.title,c.album,c.version_label,c.duplicate_cluster_key
       FROM catalog_matches m JOIN track_candidates c ON c.id=m.candidate_id
       WHERE m.run_id=$1 AND m.status IN ('review','unavailable') ORDER BY c.artist,c.title,c.id LIMIT $2 OFFSET $3`,
      [runId, size, offset],
    );
    const total = count.rows[0]!.total;
    return { items: rows.rows.map((row) => ({
      candidateId: row.candidate_id,
      artist: row.artist,
      title: row.title,
      album: row.album,
      versionLabel: row.version_label,
      duplicateClusterKey: row.duplicate_cluster_key,
      status: row.status,
      basis: row.basis,
      score: Number(row.score),
      song: row.song_json,
      alternatives: row.alternatives_json ?? [],
    })), page: safePage, pageSize: size, total, totalPages: Math.ceil(total / size), unresolvedCount: total };
  }

  async listCatalogTracks(runId: string, page = 1, pageSize = 200): Promise<CatalogTrackPage> {
    const run = await this.getRunRow(runId);
    if (!run) throw new HttpError(404, "Research run not found", "run_not_found");
    const brief = run.brief_json as PlaylistBrief;
    const safePage = Math.max(1, Math.floor(page));
    const size = Math.max(1, Math.min(Math.floor(pageSize), 500));
    const offset = (safePage - 1) * size;
    const orderSql = manifestOrderSql(brief);
    const evidenceStates = requiresFactualFrontier(brief, run.selection_plan_json as SelectionPlan | null)
      ? ["verified", "corroborated"]
      : ["verified", "corroborated", "editorial"];
    // Alternatives are evidence for an ambiguity screen, not proof that a
    // catalog recording is safe to include. A row is selectable by default
    // only when matching produced a plausible primary song.
    const choiceSql = `m.song_json IS NOT NULL AND NULLIF(m.song_json->>'id','') IS NOT NULL`;
    const recoverySlotsSql = `(SELECT count(*) FROM job_queue recovery_jobs
      WHERE recovery_jobs.run_id=c.run_id AND recovery_jobs.kind='matching'
        AND recovery_jobs.payload_json->>'retryIncomplete'='true') < 3`;
    const retryableSql = `m.status='review' AND m.song_json IS NULL
      AND (m.basis=ANY($2::text[]) OR m.basis=$3)
      AND ${recoverySlotsSql}`;
    const summary = await this.pool.query<{
      total: number;
      selectable_count: number;
      unmatched_count: number;
      retryable_count: number;
      matching_complete: boolean;
    }>(
      `SELECT count(*)::int total,
         count(*) FILTER (WHERE ${choiceSql})::int selectable_count,
         count(*) FILTER (WHERE NOT (${choiceSql}))::int unmatched_count,
         count(*) FILTER (WHERE ${retryableSql})::int retryable_count,
         COALESCE(bool_and(m.status IS NOT NULL AND NOT (${retryableSql})),true) matching_complete
       FROM track_candidates c
       LEFT JOIN catalog_matches m ON m.candidate_id=c.id AND m.run_id=c.run_id
       WHERE c.run_id=$1`,
      [runId, [...RETRYABLE_CATALOG_MATCH_BASES], CATALOG_RECOVERY_UNRESOLVED_BASIS],
    );
    const rows = await this.pool.query(
      `SELECT
         row_number() OVER (ORDER BY ${orderSql})-1 AS position,
         c.id AS candidate_id,c.selection_rank,c.artist,c.title,c.album,c.release_year,c.duration_ms,
         c.isrc,c.version_label,c.duplicate_cluster_key,
         COALESCE(m.status,'pending') AS status,m.basis,m.score,m.catalog_id,m.song_json,m.alternatives_json,
         (${choiceSql}) AS selectable,
         (m.status='review' AND m.song_json IS NULL
           AND (m.basis=ANY($5::text[]) OR m.basis=$6)
           AND ${recoverySlotsSql}) AS retryable,
         EXISTS (
           SELECT 1 FROM evidence_claims e
           JOIN source_records es ON es.id=e.source_id AND es.source_class='web'
           JOIN citation_attestations ca ON ca.id=e.citation_attestation_id
             AND ca.run_id=e.run_id AND ca.source_url=es.url
           WHERE e.candidate_id=c.id AND e.state=ANY($2::text[])
             AND e.support_scope='track' AND e.verification_phase='track_verification'
             AND e.subject_entity=ANY($3::text[]) AND e.subject_relationship=$4
         ) AS evidence_eligible
       FROM track_candidates c
       LEFT JOIN catalog_matches m ON m.candidate_id=c.id AND m.run_id=c.run_id
       WHERE c.run_id=$1
       ORDER BY ${orderSql}
       LIMIT $7 OFFSET $8`,
      [
        runId,
        evidenceStates,
        brief.subjectEntities,
        brief.relationship,
        [...RETRYABLE_CATALOG_MATCH_BASES],
        CATALOG_RECOVERY_UNRESOLVED_BASIS,
        size,
        offset,
      ],
    );
    const totals = summary.rows[0] ?? {
      total: 0,
      selectable_count: 0,
      unmatched_count: 0,
      retryable_count: 0,
      matching_complete: true,
    };
    return {
      items: rows.rows.map((row): CatalogTrackRow => ({
        position: Number(row.position),
        candidateId: row.candidate_id,
        selectionRank: row.selection_rank == null ? null : Number(row.selection_rank),
        artist: row.artist,
        title: row.title,
        album: row.album,
        releaseYear: row.release_year == null ? null : Number(row.release_year),
        durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
        isrc: row.isrc,
        versionLabel: row.version_label,
        duplicateClusterKey: row.duplicate_cluster_key,
        status: row.status,
        basis: row.basis,
        score: Number(row.score ?? 0),
        catalogId: row.catalog_id,
        song: row.song_json,
        alternatives: Array.isArray(row.alternatives_json) ? row.alternatives_json : [],
        evidenceEligible: Boolean(row.evidence_eligible),
        selected: row.status === "accepted",
        selectable: Boolean(row.selectable),
        retryable: Boolean(row.retryable),
      })),
      page: safePage,
      pageSize: size,
      total: Number(totals.total),
      totalPages: Math.ceil(Number(totals.total) / size),
      selectableCount: Number(totals.selectable_count),
      unmatchedCount: Number(totals.unmatched_count),
      retryableCount: Number(totals.retryable_count),
      matchingComplete: Boolean(totals.matching_complete),
      requestedTrackCount: (() => {
        const minimum = Number(brief.targetSize?.min);
        const maximum = Number(brief.targetSize?.max);
        return brief.mode === "curated"
          && brief.targetSize
          && Number.isInteger(minimum)
          && Number.isInteger(maximum)
          && minimum === maximum
          ? maximum
          : null;
      })(),
    };
  }

  async queueCatalogRecovery(runId: string, storefront: string): Promise<{
    queued: boolean;
    state: "queued" | "in_flight" | "ready";
    retryableCount: number;
  }> {
    if (!/^[a-z]{2}$/iu.test(storefront)) throw new HttpError(400, "Apple storefront is invalid", "invalid_storefront");
    return this.transaction(async (client) => {
      const run = await client.query<{ status: string }>(
        "SELECT status FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [runId],
      );
      if (!run.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
      const prior = await client.query<{ count: number }>(
        `SELECT count(*)::int count FROM job_queue WHERE run_id=$1 AND kind='matching'
           AND payload_json->>'retryIncomplete'='true'`,
        [runId],
      );
      const priorGenerationCount = Number(prior.rows[0]?.count ?? 0);
      const retryable = await client.query<{ count: number }>(
        `SELECT count(*)::int count FROM catalog_matches
         WHERE run_id=$1 AND status='review' AND song_json IS NULL
           AND (basis=ANY($2::text[]) OR basis=$3) AND $4::int<3`,
        [
          runId,
          [...RETRYABLE_CATALOG_MATCH_BASES],
          CATALOG_RECOVERY_UNRESOLVED_BASIS,
          priorGenerationCount,
        ],
      );
      const retryableCount = Number(retryable.rows[0]?.count ?? 0);
      const active = await client.query<{ id: string; recovery: boolean }>(
        `SELECT id,(payload_json->>'retryIncomplete'='true') AS recovery
         FROM job_queue WHERE run_id=$1 AND kind='matching' AND status IN ('queued','leased')
         ORDER BY created_at DESC LIMIT 1`,
        [runId],
      );
      if (active.rows[0]?.recovery) return { queued: false, state: "in_flight", retryableCount };
      if (active.rows[0] || !["review", "visitor_review"].includes(run.rows[0].status)) {
        throw new HttpError(409, "Run is not ready for catalog recovery", "catalog_recovery_not_ready");
      }
      if (priorGenerationCount >= 3) {
        await settleCatalogRecoveryFailure(client, runId, 3);
        return { queued: false, state: "ready", retryableCount: 0 };
      }
      if (retryableCount === 0) return { queued: false, state: "ready", retryableCount };
      const generation = priorGenerationCount + 1;
      // Builds before bounded generations terminalized every failed recovery.
      // Reopen those rows only while the run still has a recovery generation
      // available. Normalize legacy malformed JSON at the same atomic boundary
      // so the new job can never observe node-postgres' old `{}` encoding.
      await client.query(
        `UPDATE catalog_matches SET
           alternatives_json=CASE WHEN jsonb_typeof(alternatives_json)='array'
             THEN alternatives_json ELSE '[]'::jsonb END,
           basis=$3
         WHERE run_id=$1 AND status='review' AND song_json IS NULL AND basis=$2
        `,
        [runId, CATALOG_RECOVERY_UNRESOLVED_BASIS, RETRYABLE_CATALOG_MATCH_BASES[0]],
      );
      await client.query(
        `INSERT INTO job_queue(id,run_id,kind,dedupe_key,payload_json,max_attempts)
         VALUES($1,$2,'matching',$3,$4,2)`,
        [
          randomUUID(),
          runId,
          `matching-recovery:${runId}:${generation}`,
          { runId, storefront: storefront.toLowerCase(), retryIncomplete: true, recoveryGeneration: generation },
        ],
      );
      await client.query(
        "UPDATE research_runs SET status='matching',phase='catalog_matching_recovery',error=NULL,completed_at=NULL,updated_at=now() WHERE id=$1",
        [runId],
      );
      return { queued: true, state: "queued", retryableCount };
    });
  }

  /**
   * Schedules the next bounded retry generation from inside the currently
   * leased One Command matching job. Unlike the visitor endpoint, this method
   * intentionally ignores the current recovery lease while preventing a
   * later generation from being queued twice.
   */
  async queueAutomaticCatalogRecovery(
    runId: string,
    storefront: string,
    currentGeneration: number,
    currentRefillGeneration = 0,
  ): Promise<"queued" | "in_flight" | "not_needed" | "exhausted"> {
    if (!/^[a-z]{2}$/iu.test(storefront)) throw new HttpError(400, "Apple storefront is invalid", "invalid_storefront");
    const generation = Number.isInteger(currentGeneration)
      ? Math.max(0, Math.min(3, currentGeneration))
      : 0;
    const refillGeneration = Number.isInteger(currentRefillGeneration)
      ? Math.max(0, Math.min(FAST_POST_MATCH_REFILL_LIMIT, currentRefillGeneration))
      : 0;
    return this.transaction(async (client) => {
      const run = await client.query<{ auto_publish: boolean; status: string; brief_json: PlaylistBrief }>(
        "SELECT auto_publish,status,brief_json FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [runId],
      );
      if (!run.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
      if (!run.rows[0].auto_publish) return "not_needed";
      if (!["matching", "researching", "ready_for_matching"].includes(run.rows[0].status)) return "not_needed";

      const laterActive = await client.query<{ id: string }>(
        `SELECT id FROM job_queue
         WHERE run_id=$1 AND kind='matching' AND status IN ('queued','leased')
           AND payload_json->>'retryIncomplete'='true'
           AND (
             CASE
               WHEN COALESCE(payload_json->>'refillGeneration','') ~ '^[0-9]+$'
               THEN (payload_json->>'refillGeneration')::int ELSE 0 END > $3
             OR (
               CASE
                 WHEN COALESCE(payload_json->>'refillGeneration','') ~ '^[0-9]+$'
                 THEN (payload_json->>'refillGeneration')::int ELSE 0 END = $3
               AND CASE
                 WHEN COALESCE(payload_json->>'recoveryGeneration','') ~ '^[0-9]+$'
                 THEN (payload_json->>'recoveryGeneration')::int ELSE 0 END > $2
             )
           )
         LIMIT 1`,
        [runId, generation, refillGeneration],
      );
      if (laterActive.rows[0]) return "in_flight";

      const prior = await client.query<{ count: number }>(
        `SELECT count(*)::int count FROM job_queue
         WHERE run_id=$1 AND kind='matching' AND payload_json->>'retryIncomplete'='true'
           AND CASE
             WHEN COALESCE(payload_json->>'refillGeneration','') ~ '^[0-9]+$'
             THEN (payload_json->>'refillGeneration')::int ELSE 0 END = $2`,
        [runId, refillGeneration],
      );
      const priorGenerationCount = Number(prior.rows[0]?.count ?? 0);
      if (priorGenerationCount >= 3) return "exhausted";

      const retryable = await client.query<{ count: number }>(
        `SELECT count(*)::int count FROM catalog_matches
         WHERE run_id=$1 AND status='review' AND song_json IS NULL
           AND (basis=ANY($2::text[]) OR basis=$3)`,
        [runId, [...RETRYABLE_CATALOG_MATCH_BASES], CATALOG_RECOVERY_UNRESOLVED_BASIS],
      );
      if (Number(retryable.rows[0]?.count ?? 0) === 0) return "not_needed";

      const nextGeneration = priorGenerationCount + 1;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO job_queue(id,run_id,kind,dedupe_key,payload_json,max_attempts)
         VALUES($1,$2,'matching',$3,$4,2)
         ON CONFLICT(kind,dedupe_key) DO NOTHING
         RETURNING id`,
        [
          randomUUID(),
          runId,
          `matching-recovery:${runId}:${nextGeneration}:refill:${refillGeneration}`,
          {
            runId,
            storefront: storefront.toLowerCase(),
            retryIncomplete: true,
            recoveryGeneration: nextGeneration,
            refillGeneration,
            automatic: true,
          },
        ],
      );
      if (!inserted.rows[0]) return "in_flight";
      await client.query(
        "UPDATE research_runs SET status='matching',phase='catalog_matching_recovery',error=NULL,completed_at=NULL,updated_at=now() WHERE id=$1",
        [runId],
      );
      return "queued";
    });
  }

  /**
   * Queue a bounded evidence-backed candidate refill when strict Apple
   * matching leaves an exact curated playlist short. The durable route and
   * job are committed together so a worker restart cannot reset the clock or
   * enqueue an unbounded loop.
   */
  async queueAutomaticCandidateRefill(
    runId: string,
    storefront: string,
    additionalCandidateGoal: number,
    currentRefillGeneration: number,
    diversity: { desiredArtistCount: number; representedArtists: string[] } = {
      desiredArtistCount: 0,
      representedArtists: [],
    },
  ): Promise<"queued" | "in_flight" | "not_needed" | "exhausted"> {
    if (!/^[a-z]{2}$/iu.test(storefront)) throw new HttpError(400, "Apple storefront is invalid", "invalid_storefront");
    const boundedGoal = Math.max(1, Math.min(120, Math.floor(additionalCandidateGoal)));
    const suppliedGeneration = Number.isInteger(currentRefillGeneration)
      ? Math.max(0, Math.min(FAST_POST_MATCH_REFILL_LIMIT, currentRefillGeneration))
      : 0;
    return this.transaction(async (client) => {
      const run = await client.query<{ auto_publish: boolean; status: string; brief_json: PlaylistBrief }>(
        "SELECT auto_publish,status,brief_json FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [runId],
      );
      if (!run.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
      if (!run.rows[0].auto_publish) return "not_needed";
      if (!["matching", "researching", "ready_for_matching"].includes(run.rows[0].status)) return "not_needed";

      const prior = await client.query<{ count: number }>(
        `SELECT count(*)::int count FROM job_queue
         WHERE run_id=$1 AND kind='research' AND payload_json->>'postMatchRefill'='true'`,
        [runId],
      );
      const priorCount = Number(prior.rows[0]?.count ?? 0);
      // A caller that has already consumed the configured generation ceiling
      // is terminal even if an earlier durable handoff is still being
      // acknowledged. Returning in_flight here would keep a finished refill
      // controller polling forever instead of recording frontier exhaustion.
      if (suppliedGeneration >= FAST_POST_MATCH_REFILL_LIMIT) return "exhausted";
      // Exact-generation CAS: a replay of generation zero must not queue
      // generation two merely because generation one already exists.
      if (priorCount !== suppliedGeneration) return "in_flight";
      if (priorCount >= FAST_POST_MATCH_REFILL_LIMIT) return "exhausted";
      const generation = suppliedGeneration + 1;
      if (generation > FAST_POST_MATCH_REFILL_LIMIT) return "exhausted";

      const active = await client.query<{ id: string }>(
        `SELECT id FROM job_queue
         WHERE run_id=$1 AND status IN ('queued','leased')
           AND (
             (kind='research' AND payload_json->>'postMatchRefill'='true' AND CASE
               WHEN COALESCE(payload_json->>'refillGeneration','') ~ '^[0-9]+$'
               THEN (payload_json->>'refillGeneration')::int ELSE 0 END > $2)
             OR (kind='matching' AND CASE
               WHEN COALESCE(payload_json->>'refillGeneration','') ~ '^[0-9]+$'
               THEN (payload_json->>'refillGeneration')::int ELSE 0 END > $2)
           )
         LIMIT 1`,
        [runId, suppliedGeneration],
      );
      if (active.rows[0]) return "in_flight";

      const brief = run.rows[0].brief_json;
      const baseline = await client.query<{ eligible_count: number; selection_rank: number }>(
        `SELECT
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM evidence_claims e
             JOIN source_records es ON es.id=e.source_id AND es.source_class='web'
             JOIN citation_attestations ca ON ca.id=e.citation_attestation_id
               AND ca.run_id=e.run_id AND ca.source_url=es.url
             WHERE e.candidate_id=c.id
               AND ((e.state IN ('verified','corroborated') AND e.support_scope='track' AND e.verification_phase='track_verification')
                 OR e.state='editorial')
               AND e.subject_entity=ANY($2::text[]) AND e.subject_relationship=$3
           ))::int eligible_count,
           COALESCE(max(c.selection_rank),0)::int selection_rank
         FROM track_candidates c WHERE c.run_id=$1`,
        [runId, brief.subjectEntities, brief.relationship],
      );
      const route = createFastPostMatchRefillRouteCheckpoint(
        generation,
        boundedGoal,
        storefront,
        new Date(),
        process.env,
        {
          eligibleCount: Number(baseline.rows[0]?.eligible_count ?? 0),
          selectionRank: Number(baseline.rows[0]?.selection_rank ?? 0),
          diversityTarget: diversity.desiredArtistCount,
          representedArtists: diversity.representedArtists,
        },
      );
      await client.query(
        `INSERT INTO research_checkpoints(run_id,phase,state_json) VALUES($1,$2,$3)
         ON CONFLICT(run_id,phase) DO UPDATE SET state_json=EXCLUDED.state_json,updated_at=now()`,
        [runId, `fast:post-match-refill:${generation}:route`, route],
      );
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO job_queue(id,run_id,kind,dedupe_key,payload_json,max_attempts)
         VALUES($1,$2,'research',$3,$4,2)
         ON CONFLICT(kind,dedupe_key) DO NOTHING
         RETURNING id`,
        [
          randomUUID(),
          runId,
          `research-refill:${runId}:${generation}`,
          {
            runId,
            fast: true,
            postMatchRefill: true,
            refillGeneration: generation,
            additionalCandidateGoal: route.additionalCandidateGoal,
            storefront: route.storefront,
            refillConfirmedAt: route.confirmedAt,
            refillResearchDeadlineAt: route.researchDeadlineAt,
            refillDeadlineAt: route.deadlineAt,
          },
        ],
      );
      if (!inserted.rows[0]) return "in_flight";
      await client.query(
        `UPDATE research_runs SET status='researching',phase='catalog_refill_research',error=NULL,
           approved_budget_usd=GREATEST(approved_budget_usd,actual_cost_usd+reserved_cost_usd+$2),
           completed_at=NULL,updated_at=now() WHERE id=$1`,
        [runId, FAST_POST_MATCH_REFILL_MAX_COST_USD],
      );
      return "queued";
    });
  }

  async reviewMatch(runId: string, candidateId: string, status: "accepted" | "rejected", catalogSong?: unknown): Promise<"accepted" | "rejected" | "duplicate"> {
    const requestedCatalogId = (catalogSong as { id?: string } | undefined)?.id ?? null;
    const result = await this.transaction(async (client) => {
      const run = await client.query<{ status: string }>("SELECT status FROM research_runs WHERE id=$1 FOR UPDATE", [runId]);
      if (!run.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
      if (!["review", "visitor_review"].includes(run.rows[0].status)) {
        throw new HttpError(409, "The immutable manifest is already locked", "manifest_already_locked");
      }
      const current = await client.query(
        "SELECT song_json,alternatives_json FROM catalog_matches WHERE candidate_id=$1 AND run_id=$2 FOR UPDATE",
        [candidateId, runId],
      );
      if (!current.rows[0]) return 0;
      let selectedSong: unknown = null;
      let selectedCatalogId: string | null = null;
      let resultingStatus: "accepted" | "rejected" | "duplicate" = status;
      if (status === "accepted") {
        if (!requestedCatalogId) throw new HttpError(400, "Choose one of the Apple Music matches", "catalog_match_required");
        const options = [current.rows[0].song_json, ...(Array.isArray(current.rows[0].alternatives_json) ? current.rows[0].alternatives_json : [])]
          .filter((song) => song && typeof song === "object" && typeof song.id === "string");
        selectedSong = options.find((song) => song.id === requestedCatalogId) ?? null;
        if (!selectedSong) throw new HttpError(400, "That Apple Music recording was not among the verified match options", "catalog_match_not_permitted");
        selectedCatalogId = requestedCatalogId;
        const duplicate = await client.query(
          "SELECT 1 FROM catalog_matches WHERE run_id=$1 AND catalog_id=$2 AND status='accepted' AND candidate_id<>$3 LIMIT 1",
          [runId, selectedCatalogId, candidateId],
        );
        if (duplicate.rows[0]) resultingStatus = "duplicate";
      }
      const updated = await client.query(
        `UPDATE catalog_matches SET status=$1::varchar,catalog_id=CASE WHEN $1::varchar IN ('accepted','duplicate') THEN $2 ELSE catalog_id END,
         song_json=CASE WHEN $1::varchar IN ('accepted','duplicate') THEN $3 ELSE song_json END,reviewed_at=now()
         WHERE candidate_id=$4 AND run_id=$5`,
        [resultingStatus, selectedCatalogId, selectedSong, candidateId, runId],
      );
      if (updated.rowCount) await client.query("UPDATE track_candidates SET outcome=$1 WHERE id=$2 AND run_id=$3", [resultingStatus, candidateId, runId]);
      return updated.rowCount ? resultingStatus : null;
    });
    if (!result) throw new HttpError(404, "Candidate match not found", "candidate_not_found");
    return result;
  }

  async finalizeCatalogSelection(
    runId: string,
    input: CatalogSelectionInput,
  ): Promise<PlaylistManifest & { contentHash: string; lockedAt: string }> {
    return this.transaction(async (client) => {
      const runResult = await client.query<{ status: string; phase: string; brief_json: PlaylistBrief }>(
        "SELECT status,phase,brief_json FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [runId],
      );
      const run = runResult.rows[0];
      if (!run) throw new HttpError(404, "Research run not found", "run_not_found");
      const existingManifest = await client.query("SELECT id FROM manifests WHERE run_id=$1 LIMIT 1", [runId]);
      if (existingManifest.rows[0]) return this.createManifestInTransaction(client, runId);
      if (!["review", "visitor_review"].includes(run.status)) {
        throw new HttpError(409, "Run is not ready for playlist selection", "selection_not_ready");
      }
      const explicitMode = Array.isArray(input.selected);
      const recommendedMode = input.useRecommended === true;
      if (explicitMode === recommendedMode) {
        throw new HttpError(400, "Choose either explicit tracks or recommended tracks", "invalid_selection");
      }
      const selected = explicitMode ? input.selected! : [];
      const excluded = recommendedMode ? (input.excludedCandidateIds ?? []) : [];
      const overrides = recommendedMode ? (input.overrides ?? []) : [];
      if (selected.length > 10_000 || excluded.length > 10_000 || overrides.length > 10_000) {
        throw new HttpError(413, "Playlist selection is too large", "selection_too_large");
      }
      const uniqueValues = (values: string[]) => new Set(values).size === values.length;
      if (!uniqueValues(selected.map((item) => item.candidateId))
        || !uniqueValues(excluded)
        || !uniqueValues(overrides.map((item) => item.candidateId))) {
        throw new HttpError(400, "Playlist selection contains duplicate candidates", "invalid_selection");
      }
      const excludedSet = new Set(excluded);
      if (overrides.some((item) => excludedSet.has(item.candidateId))) {
        throw new HttpError(400, "An excluded track cannot also override its Apple match", "invalid_selection");
      }
      const orderSql = manifestOrderSql(run.brief_json);
      const candidates = await client.query(
        `SELECT c.id,c.artist,c.title,m.status,m.basis,m.song_json,m.alternatives_json
         FROM track_candidates c
         JOIN catalog_matches m ON m.candidate_id=c.id AND m.run_id=c.run_id
         WHERE c.run_id=$1 ORDER BY ${orderSql} FOR UPDATE OF c,m`,
        [runId],
      );
      const candidateCount = await client.query<{ count: number }>(
        "SELECT count(*)::int count FROM track_candidates WHERE run_id=$1",
        [runId],
      );
      if (candidates.rows.length !== Number(candidateCount.rows[0]?.count ?? 0)) {
        throw new HttpError(409, "Apple catalog matching is still in progress", "matching_incomplete");
      }
      const accountedStatuses = new Set(["accepted", "review", "unavailable", "rejected", "duplicate", "unsupported", "overflow"]);
      if (candidates.rows.some((row) => !accountedStatuses.has(row.status))) {
        throw new HttpError(409, "Apple catalog matching is still in progress", "matching_incomplete");
      }
      const rowsByCandidate = new Map<string, (typeof candidates.rows)[number]>(
        candidates.rows.map((row) => [row.id, row]),
      );
      for (const candidateId of excluded) {
        if (!rowsByCandidate.has(candidateId)) throw new HttpError(400, "An excluded track is not part of this run", "invalid_selection");
      }
      const choicesByCandidate = new Map<string, Map<string, CatalogSong>>();
      for (const row of candidates.rows) {
        const hasPrimary = Boolean(
          row.song_json
          && typeof row.song_json === "object"
          && typeof row.song_json.id === "string",
        );
        const choices = [
          row.song_json,
          ...((hasPrimary || row.status === "review") && Array.isArray(row.alternatives_json)
            ? row.alternatives_json
            : []),
        ]
          .filter((song): song is CatalogSong => Boolean(song && typeof song === "object" && typeof song.id === "string"));
        choicesByCandidate.set(row.id, new Map(choices.map((song) => [song.id, song])));
      }
      const requested = new Map<string, string>();
      if (explicitMode) {
        for (const item of selected) requested.set(item.candidateId, item.catalogId);
      } else {
        for (const row of candidates.rows) {
          if (!excludedSet.has(row.id)
            && (input.automatic === true ? row.status === "accepted" : ["accepted", "review"].includes(row.status))
            && row.song_json
            && typeof row.song_json.id === "string") {
            requested.set(row.id, row.song_json.id);
          }
        }
        for (const item of overrides) requested.set(item.candidateId, item.catalogId);
      }
      const selectedSongs = new Map<string, CatalogSong>();
      for (const [candidateId, catalogId] of requested) {
        const choice = choicesByCandidate.get(candidateId)?.get(catalogId);
        if (!choice) {
          throw new HttpError(400, "A selected Apple recording was not one of the server-provided choices", "catalog_match_not_permitted");
        }
        selectedSongs.set(candidateId, choice);
      }
      const requestedMinimum = run.brief_json.targetSize?.min;
      const initiallySelectableCatalogIds = new Set(candidates.rows
        .filter((row) => ["accepted", "review"].includes(row.status)
          && row.song_json
          && typeof row.song_json.id === "string")
        .map((row) => row.song_json.id));
      const initialRequestSatisfied = typeof requestedMinimum !== "number"
        || initiallySelectableCatalogIds.size >= requestedMinimum;
      // Automatic One Command publication may deliberately proceed below the
      // requested minimum after bounded catalog recovery and evidence refill
      // are exhausted. The immutable manifest still contains only strict,
      // unique accepted Apple IDs; publication completeness records the count
      // deficit and terminalizes the published run as `partial`.
      if (selectionFallsBelowRequiredMinimum({
        automatic: input.automatic === true,
        initialRequestSatisfied: initialRequestSatisfied,
        requestedMinimum: typeof requestedMinimum === "number" ? requestedMinimum : null,
        selectedUniqueCount: new Set([...selectedSongs.values()].map((song) => song.id)).size,
      })) {
        throw new HttpError(
          409,
          `Resolve enough Apple Music matches to reach the requested ${requestedMinimum} tracks before generating the playlist`,
          "playlist_target_shortfall",
        );
      }
      if (selectedSongs.size === 0) throw new HttpError(409, "Select at least one Apple Music track", "empty_selection");
      const acceptedCatalogIds = new Set<string>();
      const automaticSelection = input.automatic === true;
      const updates = candidates.rows.map((row) => {
        const song = selectedSongs.get(row.id) ?? null;
        if (song) {
          const status = acceptedCatalogIds.has(song.id) ? "duplicate" : "accepted";
          acceptedCatalogIds.add(song.id);
          return {
            candidate_id: row.id,
            status,
            catalog_id: song.id,
            song_json: song,
            basis: status === "duplicate"
              ? automaticSelection
                ? `One Command primary match duplicated Apple catalog ID ${song.id}`
                : `Visitor selection duplicated Apple catalog ID ${song.id}`
              : automaticSelection
                ? `One Command selected the primary Apple catalog match ${song.id}`
                : `Visitor selected Apple catalog ID ${song.id} in bulk review`,
          };
        }
        // Alternatives remain review aids; their presence does not make a
        // track available or supported when no Apple recording was selected.
        const status = ["unavailable", "unsupported"].includes(row.status)
          ? row.status
          : "rejected";
        return {
          candidate_id: row.id,
          status,
          catalog_id: null,
          song_json: null,
          basis: status === row.status
            ? row.basis
            : automaticSelection
              ? "One Command omitted this track because no primary Apple catalog match was selected"
              : "Visitor excluded this track in bulk review",
        };
      });
      const updated = await client.query(
        `UPDATE catalog_matches m SET
           status=u.status,
           basis=u.basis,
           catalog_id=CASE WHEN u.status IN ('accepted','duplicate') THEN u.catalog_id ELSE NULL END,
           song_json=CASE WHEN u.status IN ('accepted','duplicate') THEN u.song_json ELSE m.song_json END,
           reviewed_at=now()
         FROM jsonb_to_recordset($2::jsonb) AS u(
           candidate_id uuid,status varchar,basis text,catalog_id text,song_json jsonb
         )
         WHERE m.run_id=$1 AND m.candidate_id=u.candidate_id`,
        [runId, JSON.stringify(updates)],
      );
      if (updated.rowCount !== updates.length) {
        throw new HttpError(409, "Playlist selection changed while it was being saved", "selection_conflict");
      }
      await client.query(
        `UPDATE track_candidates c SET outcome=m.status FROM catalog_matches m
         WHERE c.run_id=$1 AND m.run_id=$1 AND m.candidate_id=c.id`,
        [runId],
      );
      return this.createManifestInTransaction(client, runId, { allowUnavailable: true });
    });
  }

  private async createManifestInTransaction(
    client: PoolClient,
    runId: string,
    options: { verifiedOnly?: boolean; allowUnavailable?: boolean } = {},
  ): Promise<PlaylistManifest & { contentHash: string; lockedAt: string }> {
      const runResult = await client.query("SELECT * FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [runId]);
      const run = runResult.rows[0];
      if (!run) throw new HttpError(404, "Research run not found", "run_not_found");
      const contractBinding = run.active_playlist_contract_revision_id
        ? (await client.query<{
          id: string;
          contract_hash: string;
          contract_json: PlaylistContractRevisionV1;
        }>(
          `SELECT id,contract_hash,contract_json
           FROM playlist_contract_revisions
           WHERE id=$1 AND status='active'`,
          [run.active_playlist_contract_revision_id],
        )).rows[0] ?? null
        : null;
      if (Number(run.brief_contract_version) === 3 && !contractBinding) {
        throw new HttpError(
          409,
          "The active canonical playlist contract is unavailable",
          "playlist_contract_not_ready",
        );
      }
      if (contractBinding) assertPlaylistContractIntegrityV1(contractBinding.contract_json);
      const alreadyLocked = await client.query("SELECT * FROM manifests WHERE run_id=$1 LIMIT 1", [runId]);
      if (alreadyLocked.rows[0]) {
        const stored = alreadyLocked.rows[0];
        if (contractBinding && (
          stored.contract_revision_id !== contractBinding.id
          || stored.contract_hash !== contractBinding.contract_hash
        )) {
          throw new HttpError(
            409,
            "The locked manifest belongs to a superseded playlist contract",
            "manifest_contract_stale",
          );
        }
        const storedTracks = await client.query(
          "SELECT position,candidate_id,catalog_id,artist,title FROM manifest_tracks WHERE manifest_id=$1 ORDER BY position",
          [stored.id],
        );
        return {
          id: stored.id,
          runId,
          name: stored.name,
          description: stored.description,
          contentHash: stored.content_hash,
          lockedAt: date(stored.locked_at)!.toISOString(),
          createdAt: date(stored.created_at)!.toISOString(),
          tracks: storedTracks.rows.map((track) => ({ position: track.position, candidateId: track.candidate_id, catalogId: track.catalog_id, artist: track.artist, title: track.title })),
        };
      }
      if (!["review", "visitor_review"].includes(run.status)) throw new HttpError(409, "Run is not ready for a manifest", "manifest_not_ready");
      const brief = run.brief_json as PlaylistBrief;
      const selectionPlan = run.selection_plan_json as SelectionPlan | null;
      const pipelineVersion = run.pipeline_version ?? "legacy_v1";
      const policyVersion = run.policy_version ?? "legacy_v1";
      const pipelineV2 = selectionPlan != null && pipelineVersion !== "legacy_v1";
      const guidancePreferences = Array.isArray(run.guidance_preferences_json)
        ? run.guidance_preferences_json as PlaylistGuidancePreference[]
        : [];
      const effectiveOrderingPolicy = guidanceOrderingPolicy(
        brief.orderingPolicy,
        guidancePreferences,
      );
      const accounting = await client.query<{
        id: string;
        outcome: string;
        match_status: string | null;
        catalog_id: string | null;
        evidence_eligible: boolean;
      }>(
        `SELECT c.id,c.outcome,m.status match_status,m.catalog_id,
           EXISTS (
             SELECT 1 FROM evidence_claims e
             JOIN source_records es ON es.id=e.source_id AND es.source_class='web'
             JOIN citation_attestations ca ON ca.id=e.citation_attestation_id
               AND ca.run_id=e.run_id AND ca.source_url=es.url
             WHERE e.candidate_id=c.id
               AND e.state IN ('verified','corroborated') AND e.support_scope='track'
               AND e.verification_phase='track_verification'
               AND e.subject_entity=ANY($2::text[]) AND e.subject_relationship=$3
           ) evidence_eligible
         FROM track_candidates c
         LEFT JOIN catalog_matches m ON m.candidate_id=c.id AND m.run_id=c.run_id
         WHERE c.run_id=$1 ORDER BY c.id`,
        [runId, brief.subjectEntities, brief.relationship],
      );
      const matchStatuses = new Set(["accepted", "review", "unavailable", "rejected", "duplicate", "unsupported", "overflow"]);
      const incomplete = accounting.rows.some((candidate) => (
        !candidate.match_status
        || !matchStatuses.has(candidate.match_status)
        || candidate.outcome === "pending"
        || candidate.outcome !== candidate.match_status
        || (candidate.match_status === "accepted" && !candidate.catalog_id)
      ));
      if (incomplete) {
        throw new HttpError(409, "Catalog matching has not accounted for every candidate", "matching_incomplete");
      }
      if (!options.verifiedOnly && accounting.rows.some((candidate) => candidate.match_status === "review"
        || (!options.allowUnavailable && candidate.match_status === "unavailable"))) {
        throw new HttpError(409, "Resolve every exception or choose Publish verified tracks", "unresolved_exceptions");
      }
      if (options.verifiedOnly) {
        // Choosing "Publish verified tracks" is itself the visitor's explicit
        // disposition for unresolved or evidence-ineligible candidates. Keep
        // every candidate accounted for before the immutable manifest locks.
        const rejected = accounting.rows.filter((candidate) => candidate.match_status === "review").map((candidate) => candidate.id);
        const unsupported = pipelineV2 ? [] : accounting.rows
          .filter((candidate) => candidate.match_status === "accepted" && !candidate.evidence_eligible)
          .map((candidate) => candidate.id);
        if (rejected.length > 0) {
          await client.query(
            "UPDATE catalog_matches SET status='rejected',reviewed_at=now() WHERE run_id=$1 AND candidate_id=ANY($2::uuid[])",
            [runId, rejected],
          );
        }
        if (unsupported.length > 0) {
          await client.query(
            "UPDATE catalog_matches SET status='unsupported',reviewed_at=now() WHERE run_id=$1 AND candidate_id=ANY($2::uuid[])",
            [runId, unsupported],
          );
        }
        if (rejected.length > 0 || unsupported.length > 0) {
          await client.query(
            `UPDATE track_candidates c SET outcome=m.status FROM catalog_matches m
             WHERE c.run_id=$1 AND m.run_id=$1 AND m.candidate_id=c.id`,
            [runId],
          );
        }
      }
      // V2 never falls back to the legacy evidence_claims EXISTS predicate.
      // Its authoritative eligibility gate is the provenance-validated
      // track_scope_bindings evaluation below, for both automatic and
      // "verified only" publication.
      const verifiedClause = options.verifiedOnly && !pipelineV2
        ? `AND EXISTS (
             SELECT 1 FROM evidence_claims e
             JOIN source_records es ON es.id=e.source_id AND es.source_class='web'
             JOIN citation_attestations ca ON ca.id=e.citation_attestation_id
               AND ca.run_id=e.run_id AND ca.source_url=es.url
             WHERE e.candidate_id=c.id AND e.state IN ('verified','corroborated')
               AND e.support_scope='track' AND e.verification_phase='track_verification'
               AND e.subject_entity=ANY($2::text[]) AND e.subject_relationship=$3
           )`
        : "";
      const orderSql = manifestOrderSql({ ...brief, orderingPolicy: effectiveOrderingPolicy });
      const matches = await client.query<ManifestSelectionRow>(
        `SELECT m.candidate_id,c.recording_family_id,c.selection_rank,m.catalog_id,m.song_json,c.artist,c.title,c.album,c.release_year,
           ARRAY(
             SELECT DISTINCT left(identity.metadata_json->>'releaseDate',4)::integer release_year
             FROM recording_catalog_identities identity
             WHERE identity.recording_family_id=c.recording_family_id
               AND identity.provider='apple'
               AND identity.metadata_json->>'releaseDate' ~ '^(19|20)[0-9]{2}'
             ORDER BY release_year
           ) compatible_release_years,
           c.duration_ms
         FROM catalog_matches m
         JOIN track_candidates c ON c.id=m.candidate_id
         WHERE m.run_id=$1 AND m.status='accepted' AND m.catalog_id IS NOT NULL ${verifiedClause}
         ORDER BY ${orderSql}`,
        options.verifiedOnly ? [runId, brief.subjectEntities, brief.relationship] : [runId],
      );
      const maximumTracks = brief.mode === "curated"
        ? Math.max(1, Math.floor(brief.targetSize?.max ?? 100))
        : Number.POSITIVE_INFINITY;
      const familyPartition = pipelineV2
        ? partitionUniqueRecordingFamilies(matches.rows, (row) => (
          row.recording_family_id ?? recordingFamilyKey({ song: row.song_json })
        ))
        : { unique: matches.rows, duplicates: [] as ManifestSelectionRow[] };
      const familyDuplicateMatches = familyPartition.duplicates;
      const manifestEligibleMatches = familyPartition.unique;
      let constraintSelection: ConstraintSelection<ManifestSelectionRow> = {
        outcome: "complete",
        selected: manifestEligibleMatches,
        relaxedSoftConstraints: [] as string[],
      };
      let hardRejectedMatches: ManifestSelectionRow[] = [];
      let ladderOverflowMatches: ManifestSelectionRow[] = familyDuplicateMatches;
      if (selectionPlan && pipelineVersion !== "legacy_v1") {
        const bindingResult = await client.query<{
          candidate_id: string;
          binding_kind: TrackScopeBinding["bindingKind"];
          scope_axis: TrackScopeBinding["scopeAxis"];
          scope_value: string;
          relationship: string;
          note: string;
          confidence: string | number;
          provenance_root: string;
          source_record_id: string;
          source_url: string;
          citation_attestation_id: string | null;
          provenance_path_json: Array<{ kind: string; id: string; label?: string }>;
          pipeline_version: string;
          policy_version: string;
        }>(
          `SELECT b.candidate_id,b.binding_kind,b.scope_axis,b.scope_value,b.relationship,b.note,
             b.confidence,s.provenance_root,b.source_record_id,b.source_url,
             b.citation_attestation_id,b.provenance_path_json,b.pipeline_version,b.policy_version
           FROM track_scope_bindings b
           JOIN source_records s ON s.id=b.source_record_id AND s.run_id=b.run_id
             AND s.url=b.source_url
           LEFT JOIN citation_attestations ca ON ca.id=b.citation_attestation_id
             AND ca.run_id=b.run_id AND ca.source_url=s.url
           WHERE b.run_id=$1 AND b.eligibility='qualifying'
             AND (b.binding_kind<>'track_specific_source' OR ca.id IS NOT NULL)
           ORDER BY b.candidate_id,b.confidence DESC,b.id`,
          [runId],
        );
        const bindingsByCandidate = new Map<string, ManifestScopeBindingProof[]>();
        for (const binding of bindingResult.rows) {
          const provenancePath = Array.isArray(binding.provenance_path_json) ? binding.provenance_path_json : [];
          const proof: ManifestScopeBindingProof = {
            bindingKind: binding.binding_kind,
            scopeAxis: binding.scope_axis,
            scopeValue: binding.scope_value,
            geographyRelationship: null,
            relationship: binding.relationship,
            note: binding.note,
            confidence: Number(binding.confidence),
            provenanceRoot: binding.provenance_root,
            sourceRecordId: binding.source_record_id,
            sourceUrl: binding.source_url,
            citationAttestationId: binding.citation_attestation_id,
            provenancePath,
          };
          proof.geographyRelationship = bindingGeographyRelationship(proof);
          if (!authoritativeScopeBinding(
            proof,
            selectionPlan.pipelineVersion,
            selectionPlan.policyVersion,
            binding.pipeline_version,
            binding.policy_version,
          )) continue;
          const candidateBindings = bindingsByCandidate.get(binding.candidate_id) ?? [];
          candidateBindings.push(proof);
          bindingsByCandidate.set(binding.candidate_id, candidateBindings);
        }
        const rules = manifestConstraintRules(selectionPlan);
        const hardRuleIds = new Set(rules.filter((rule) => rule.kind === "hard").map((rule) => rule.id));
        const artistOccurrences = new Map<string, number>();
        const albumOccurrences = new Map<string, number>();
        const hardArtistConcentration = selectionPlan.constraints.find((constraint) => (
          constraint.kind === "hard"
          && constraint.axis === "artist"
          && constraint.operator === "maximum"
        ));
        const candidates: ConstraintCandidate<ManifestSelectionRow>[] = manifestEligibleMatches.map((row) => {
          const bindings = bindingsByCandidate.get(row.candidate_id) ?? [];
          const summaries = bindings.map((binding) => {
            const evidence = classifyTrackScopeBindingEvidence({
              bindingKind: binding.bindingKind,
              scopeAxis: binding.scopeAxis,
              citationAttested: Boolean(binding.citationAttestationId),
            });
            return {
              strength: trackScopeBindingStrength(binding.confidence),
              provenanceRoot: binding.provenanceRoot,
              ...evidence,
              bindingKind: binding.bindingKind,
              scopeAxis: binding.scopeAxis,
            };
          });
          const candidateScopeEligible = scopeBindingEligible(brief.mode, summaries, selectionPlan.intents)
            && selectionGeographyBindingsSatisfied(selectionPlan, bindings);
          const violations = manifestConstraintViolations({
            row,
            plan: selectionPlan,
            bindings,
            scopeEligible: candidateScopeEligible,
          });
          const artistKey = normalizedPolicyText(row.song_json.artistName || row.artist);
          const albumKey = normalizedPolicyText(row.song_json.albumName || row.album || "");
          const artistCount = (artistOccurrences.get(artistKey) ?? 0) + 1;
          const albumCount = (albumOccurrences.get(albumKey) ?? 0) + 1;
          artistOccurrences.set(artistKey, artistCount);
          if (albumKey) albumOccurrences.set(albumKey, albumCount);
          if (selectionPlan.diversityGoals.maximumTracksPerArtist != null
            && artistCount > selectionPlan.diversityGoals.maximumTracksPerArtist) {
            violations.push(hardArtistConcentration?.id ?? "artist_concentration");
          }
          if (albumKey && selectionPlan.diversityGoals.maximumTracksPerAlbum != null
            && albumCount > selectionPlan.diversityGoals.maximumTracksPerAlbum) {
            violations.push("album_concentration");
          }
          return { value: row, violations: [...new Set(violations)] };
        });
        const target = Number.isFinite(maximumTracks) ? maximumTracks : matches.rows.length;
        const rankQualifiedCandidates = shouldScoreBroadCuratedSelection(brief.mode, selectionPlan.intents)
          ? (qualified: readonly ConstraintCandidate<ManifestSelectionRow>[]) => {
            const broadCandidates = qualified.map((candidate): BroadCuratedCandidate<ConstraintCandidate<ManifestSelectionRow>> => {
              const row = candidate.value;
              const bindings = bindingsByCandidate.get(row.candidate_id) ?? [];
              return {
                id: row.candidate_id,
                artist: row.song_json.artistName || row.artist,
                title: row.song_json.name || row.title,
                album: row.song_json.albumName || row.album,
                releaseYear: manifestCanonicalReleaseYear(row),
                scenes: bindings
                  .filter((binding) => binding.scopeAxis === "scene" || binding.scopeAxis === "genre_scene")
                  .map((binding) => binding.scopeValue),
                geographies: bindings
                  .filter((binding) => binding.scopeAxis === "geography")
                  .map((binding) => binding.scopeValue),
                sourceRank: row.selection_rank,
                evidenceConfidence: bindings.reduce((maximum, binding) => (
                  Math.max(maximum, binding.confidence)
                ), 0),
                independentProvenanceRoots: bindings.map((binding) => binding.provenanceRoot),
                value: candidate,
              };
            });
            return selectBroadCuratedCandidates(broadCandidates, target).selected.map((item) => {
              item.candidate.value.selectionScore = item.score;
              return item.candidate.value;
            });
          }
          : undefined;
        constraintSelection = selectWithConstraintLadder({
          target,
          constraints: rules,
          candidates,
          ...(rankQualifiedCandidates ? { rankQualifiedCandidates } : {}),
        });
        const selectedIds = new Set(constraintSelection.selected.map((row) => row.candidate_id));
        hardRejectedMatches = candidates
          .filter((candidate) => candidate.violations.some((violation) => hardRuleIds.has(violation)))
          .map((candidate) => candidate.value);
        const hardRejectedIds = new Set(hardRejectedMatches.map((row) => row.candidate_id));
        ladderOverflowMatches = [
          ...familyDuplicateMatches,
          ...manifestEligibleMatches.filter((row) => (
          !selectedIds.has(row.candidate_id) && !hardRejectedIds.has(row.candidate_id)
          )),
        ];
        if (hardRejectedMatches.length > 0) {
          const rejectedIds = hardRejectedMatches.map((match) => match.candidate_id);
          await client.query(
            `UPDATE catalog_matches SET status='unsupported',
               basis='Pipeline V2 manifest lock rejected an unproven hard constraint',reviewed_at=now()
             WHERE run_id=$1 AND candidate_id=ANY($2::uuid[]) AND status='accepted'`,
            [runId, rejectedIds],
          );
          await client.query(
            "UPDATE track_candidates SET outcome='unsupported' WHERE run_id=$1 AND id=ANY($2::uuid[])",
            [runId, rejectedIds],
          );
        }
        if (constraintSelection.outcome === "partial_policy_conflict") {
          const observedAt = new Date();
          const deficitCount = Math.max(0, target - constraintSelection.selected.length);
          await client.query(
            `INSERT INTO pipeline_deficit_ledger(
               id,run_id,stage,kind,status,required_count,actual_count,deficit_count,
               reason_code,detail_json,pipeline_version,policy_version,observed_at)
             VALUES($1,$2,'quota_eligible','version_policy','open',$3,$4,$5,
               'manifest_hard_constraint_shortfall',$6::jsonb,$7,$8,$9)`,
            [
              deterministicUuid({ runId, stage: "quota_eligible", reason: "manifest_hard_constraint_shortfall" }),
              runId,
              target,
              constraintSelection.selected.length,
              deficitCount,
              JSON.stringify({
                hardRejectedCount: hardRejectedMatches.length,
                relaxedSoftConstraints: constraintSelection.relaxedSoftConstraints,
              }),
              selectionPlan.pipelineVersion,
              selectionPlan.policyVersion,
              observedAt,
            ],
          );
        }
      }
      const diversifyArtists = excludedReferenceArtists(brief).length > 0
        || briefShouldDiversifyArtists(brief);
      const selection = selectRankedPlaylistRows(constraintSelection.selected, maximumTracks, {
        // “Sounds like X” uses X only as a reference. Prefer a genuinely
        // exploratory set from the accepted reserve instead of allowing the
        // first adjacent artist returned by research to dominate the result.
        // The progressive cap still fills the exact target when the available
        // catalog has only a few qualifying artists.
        diversifyArtists,
        minimumDistinctArtists: diversifyArtists && Number.isFinite(maximumTracks)
          ? desiredPlaylistArtistCount(brief, maximumTracks)
          : 0,
      });
      const selectedMatches = selection.selected;
      const overflowMatches = [
        ...ladderOverflowMatches,
        ...selection.overflow,
      ].filter((match, index, values) => (
        values.findIndex((candidate) => candidate.candidate_id === match.candidate_id) === index
      ));
      if (overflowMatches.length > 0) {
        const overflowIds = overflowMatches.map((match) => match.candidate_id);
        await client.query(
          `UPDATE catalog_matches SET status='overflow',
             basis=$3,reviewed_at=now()
           WHERE run_id=$1 AND candidate_id=ANY($2::uuid[]) AND status='accepted'`,
          [
            runId,
            overflowIds,
            selectionPlan && constraintSelection.relaxedSoftConstraints.length > 0
              ? `Excluded after Pipeline V2 relaxed soft goals in order (${constraintSelection.relaxedSoftConstraints.join(", ")}) and applied the confirmed target of ${maximumTracks} tracks`
              : `Excluded by the confirmed curated target maximum of ${maximumTracks} tracks after deterministic ${brief.orderingPolicy || "artist/title"} ordering`,
          ],
        );
        await client.query(
          "UPDATE track_candidates SET outcome='overflow' WHERE run_id=$1 AND id=ANY($2::uuid[])",
          [runId, overflowIds],
        );
      }
      const sequencingRows = selectedMatches.map((match) => {
        const song = match.song_json && typeof match.song_json === "object"
          ? match.song_json as Partial<CatalogSong>
          : null;
        return {
          ...match,
          artist: match.artist,
          album: song?.albumName || match.album,
          genre: song?.genreNames,
          // Broad scoring and chronological sequencing use the canonical
          // compatible recording-family year. A selected 2024 remaster must
          // not be treated as a new-era recording when its family contains
          // the supported 1978 issue.
          releaseYear: manifestCanonicalReleaseYear(match),
          durationMs: song?.durationInMillis ?? match.duration_ms,
        };
      });
      const sequencedMatches = shouldSequencePlaylist(effectiveOrderingPolicy, brief.mode)
        ? sequencePlaylist(sequencingRows, {
          transitionPreference: /\b(?:high[- ]?contrast|contrast|surpris|eclectic)\b/iu
            .test(effectiveOrderingPolicy)
            ? "contrast"
            : "smooth",
        })
        : fixedPlaylistOrder(sequencingRows, effectiveOrderingPolicy);
      const tracks = sequencedMatches.map((match, index) => ({
        position: index,
        candidateId: match.candidate_id,
        catalogId: match.catalog_id,
        artist: match.artist,
        title: match.title,
      }));
      if (tracks.length === 0) throw new HttpError(409, "No accepted Apple Music matches are ready", "empty_manifest");
      const contentHash = sha256Hex(JSON.stringify(tracks.map((track) => [track.position, track.candidateId, track.catalogId])));
      const id = randomUUID();
      const now = new Date();
      const normalizedTitle = normalizePlaylistTitle(brief.title, brief);
      const name = appendPlaylistTitleSuffix(normalizedTitle, `· ${now.toISOString().slice(0, 10)}`);
      const description = manifestDescriptionForBrief(brief);
      const partialConsentAnswerHash = options.verifiedOnly
        ? sha256Hex(stableStringify({
          action: "publish_verified_partial",
          runId,
          contractRevisionId: contractBinding?.contract_json.revisionId ?? null,
          selectedTrackCount: tracks.length,
          requestedTrackCount: selectionPlan?.requestedTrackCount ?? brief.targetSize?.min ?? null,
        }))
        : null;
      await client.query(
        `INSERT INTO manifests(
           id,run_id,name,description,content_hash,pipeline_version,policy_version,
           selection_plan_json,contract_revision_id,contract_hash,partial_consent_answer_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
        [id, runId, name, description, contentHash, pipelineVersion, policyVersion,
          selectionPlan == null ? null : JSON.stringify(selectionPlan),
          contractBinding?.id ?? null,
          contractBinding?.contract_hash ?? null,
          partialConsentAnswerHash],
      );
      for (const track of tracks) {
        await client.query(
          "INSERT INTO manifest_tracks(manifest_id,position,candidate_id,catalog_id,artist,title) VALUES($1,$2,$3,$4,$5,$6)",
          [id, track.position, track.candidateId, track.catalogId, track.artist, track.title],
        );
      }
      // V2 locks an initial revision alongside the compatibility projection.
      // Future Apple preflight changes create a child revision; these base
      // rows are never rewritten.
      if (pipelineVersion !== "legacy_v1") {
        const policySnapshot = run.pipeline_policy_snapshot_json as PipelinePolicySnapshot | null;
        if (!selectionPlan || !policySnapshot
          || policySnapshot.pipelineVersion !== pipelineVersion
          || policySnapshot.policyVersion !== policyVersion) {
          throw new HttpError(
            409,
            "Pipeline V2 manifest lock requires its immutable policy snapshot",
            "pipeline_policy_snapshot_missing",
          );
        }
        let qualifiedReserveCandidateIds: string[] = [];
        if (overflowMatches.length > 0) {
          const reserveInput = overflowMatches.map((match, sourcePosition) => ({
            source_position: sourcePosition,
            candidate_id: match.candidate_id,
            catalog_id: match.catalog_id,
          }));
          const qualifiedReserve = await client.query<{ candidate_id: string }>(
            `WITH input AS (
               SELECT * FROM jsonb_to_recordset($2::jsonb) AS item(
                 source_position integer,candidate_id uuid,catalog_id text
               )
             ), qualified AS (
               SELECT DISTINCT ON (candidate.recording_family_id)
                 item.source_position,item.candidate_id,candidate.recording_family_id
               FROM input item
               JOIN track_candidates candidate ON candidate.id=item.candidate_id
                 AND candidate.run_id=$1 AND candidate.recording_family_id IS NOT NULL
               JOIN LATERAL (
                 SELECT identity.id FROM recording_catalog_identities identity
                 WHERE identity.recording_family_id=candidate.recording_family_id
                   AND identity.provider='apple' AND identity.catalog_id=item.catalog_id
                 ORDER BY identity.is_preferred DESC,identity.identity_confidence DESC,identity.id
                 LIMIT 1
               ) identity ON true
               WHERE NOT EXISTS (
                 SELECT 1 FROM track_candidates selected
                 WHERE selected.run_id=$1 AND selected.id=ANY($3::uuid[])
                   AND selected.recording_family_id=candidate.recording_family_id
               )
               ORDER BY candidate.recording_family_id,item.source_position,item.candidate_id
             )
             SELECT candidate_id FROM qualified ORDER BY source_position,candidate_id`,
            [runId, JSON.stringify(reserveInput), tracks.map((track) => track.candidateId)],
          );
          qualifiedReserveCandidateIds = qualifiedReserve.rows.map((row) => row.candidate_id);
        }
        const qualifiedReserveSet = new Set(qualifiedReserveCandidateIds);
        const rejectedOverflowIds = overflowMatches
          .map((match) => match.candidate_id)
          .filter((candidateId) => !qualifiedReserveSet.has(candidateId));
        await advanceCandidateStagesTransaction(client, runId, [
          ...hardRejectedMatches.map((match) => ({
            candidateId: match.candidate_id,
            stages: [{
              toStage: "rejected" as const,
              reasonCode: "manifest_hard_constraint_rejected",
              detail: { manifestId: id },
            }],
          })),
          ...rejectedOverflowIds.map((candidateId) => ({
            candidateId,
            stages: [{
              toStage: "rejected" as const,
              reasonCode: "manifest_reserve_identity_rejected",
              detail: { manifestId: id },
            }],
          })),
          ...qualifiedReserveCandidateIds.map((candidateId) => ({
            candidateId,
            stages: [{
              toStage: "quota_eligible" as const,
              reasonCode: "qualified_manifest_reserve",
              detail: { manifestId: id },
            }],
          })),
          ...tracks.map((track) => ({
            candidateId: track.candidateId,
            stages: [
              {
                toStage: "quota_eligible" as const,
                reasonCode: "manifest_quota_selected",
                detail: { manifestId: id, position: track.position },
              },
              {
                toStage: "sequenced" as const,
                reasonCode: "playlist_sequence_assigned",
                detail: { manifestId: id, position: track.position },
              },
              {
                toStage: "manifested" as const,
                reasonCode: "manifest_revision_locked",
                detail: { manifestId: id, position: track.position, revision: 1 },
              },
            ],
          })),
        ], { pipelineVersion, policyVersion });
        const stageCounts = await getPipelineStageCountsTransaction(client, runId);
        const targetTrackCount = Math.max(1, selectionPlan.requestedTrackCount);
        const lockOutcome = buildPipelineOutcome({
          pipelineVersion,
          policyVersion,
          status: "partial_catalog_degraded",
          targetTrackCount,
          discoveredTrackCount: stageCounts.discovered ?? accounting.rows.length,
          qualifiedTrackCount: Math.min(
            stageCounts.discovered ?? accounting.rows.length,
            stageCounts.claim_verified ?? matches.rows.length,
          ),
          selectedTrackCount: tracks.length,
          publishedTrackCount: 0,
          reasonCodes: ["manifest_locked_pending_publication"],
          stageCounts,
        });
        const outcomeSnapshot = await persistPipelineOutcomeTransaction(client, runId, lockOutcome);
        const revisionId = randomUUID();
        await client.query(
          `INSERT INTO manifest_revisions(
             id,manifest_id,revision,parent_revision_id,status,reason,content_hash,pipeline_version,
             policy_version,selection_plan_snapshot_json,pipeline_policy_snapshot_json,
             outcome_snapshot_json,deficit_snapshot_json,locked_at,created_at)
           VALUES($1,$2,1,NULL,'locked','initial_manifest_lock',$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$10)`,
          [revisionId, id, contentHash, pipelineVersion, policyVersion,
            JSON.stringify(selectionPlan),
            JSON.stringify(policySnapshot),
            JSON.stringify(outcomeSnapshot),
            JSON.stringify(outcomeSnapshot.deficits),
            now],
        );
        for (const track of tracks) {
          const family = await client.query<{ recording_family_id: string | null; catalog_identity_id: string | null }>(
            `SELECT tc.recording_family_id,
               (SELECT rci.id FROM recording_catalog_identities rci
                WHERE rci.recording_family_id=tc.recording_family_id AND rci.provider='apple'
                  AND rci.catalog_id=$3 ORDER BY rci.is_preferred DESC,rci.identity_confidence DESC LIMIT 1) catalog_identity_id
             FROM track_candidates tc WHERE tc.id=$1 AND tc.run_id=$2`,
            [track.candidateId, runId, track.catalogId],
          );
          await client.query(
            `INSERT INTO manifest_revision_tracks(
               manifest_revision_id,position,candidate_id,recording_family_id,catalog_identity_id,
               catalog_id,artist,title) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              revisionId,
              track.position,
              track.candidateId,
              family.rows[0]?.recording_family_id ?? null,
              family.rows[0]?.catalog_identity_id ?? null,
              track.catalogId,
              track.artist,
              track.title,
            ],
          );
        }
        if (overflowMatches.length > 0) {
          const reserveInput = overflowMatches.map((match, sourcePosition) => ({
            source_position: sourcePosition,
            candidate_id: match.candidate_id,
            catalog_id: match.catalog_id,
            artist: match.artist,
            title: match.title,
          }));
          // Snapshot only stable, canonical recording identities that already
          // cleared the V2 evidence, hard-constraint, and version-policy gate.
          // Same-family overflow is an alternate identity, not a reserve
          // recording, so it remains available through the selected track's
          // alternate identity list instead.
          await client.query(
            `WITH input AS (
               SELECT * FROM jsonb_to_recordset($3::jsonb) AS item(
                 source_position integer,candidate_id uuid,catalog_id text,artist text,title text
               )
             ), qualified AS (
               SELECT DISTINCT ON (tc.recording_family_id)
                 item.source_position,item.candidate_id,item.catalog_id,item.artist,item.title,
                 tc.recording_family_id,rci.id catalog_identity_id
               FROM input item
               JOIN track_candidates tc ON tc.id=item.candidate_id AND tc.run_id=$2
                 AND tc.recording_family_id IS NOT NULL
               JOIN LATERAL (
                 SELECT identity.id FROM recording_catalog_identities identity
                 WHERE identity.recording_family_id=tc.recording_family_id
                   AND identity.provider='apple' AND identity.catalog_id=item.catalog_id
                 ORDER BY identity.is_preferred DESC,identity.identity_confidence DESC,identity.id
                 LIMIT 1
               ) rci ON true
               WHERE NOT EXISTS (
                 SELECT 1 FROM manifest_revision_tracks selected
                 WHERE selected.manifest_revision_id=$1
                   AND selected.recording_family_id=tc.recording_family_id
               )
               ORDER BY tc.recording_family_id,item.source_position,item.candidate_id
             ), ranked AS (
               SELECT row_number() OVER (ORDER BY source_position,candidate_id)-1 position,qualified.*
               FROM qualified
             )
             INSERT INTO manifest_revision_reserve_tracks(
               manifest_revision_id,position,candidate_id,recording_family_id,catalog_identity_id,
               catalog_id,artist,title,evidence_eligible,hard_constraints_satisfied,
               version_compatible,qualified)
             SELECT $1,position,candidate_id,recording_family_id,catalog_identity_id,
               catalog_id,artist,title,true,true,true,true
             FROM ranked ORDER BY position`,
            [revisionId, runId, JSON.stringify(reserveInput)],
          );
        }
      }
      await client.query("UPDATE research_runs SET status='manifest_ready',phase='manifest',updated_at=now() WHERE id=$1", [runId]);
      return { id, runId, name, description, createdAt: now.toISOString(), tracks, contentHash, lockedAt: now.toISOString() };
  }

  async createManifest(runId: string, options: { verifiedOnly?: boolean } = {}): Promise<PlaylistManifest & { contentHash: string; lockedAt: string }> {
    return this.transaction((client) => this.createManifestInTransaction(client, runId, options));
  }

  async getManifestById(id: string): Promise<any | null> {
    const manifest = await this.pool.query("SELECT * FROM manifests WHERE id=$1", [id]);
    if (!manifest.rows[0]) return null;
    const row = manifest.rows[0];
    const revision = await this.pool.query(
      `SELECT * FROM manifest_revisions
       WHERE manifest_id=$1 AND status IN ('locked','published')
       ORDER BY revision DESC LIMIT 1`,
      [id],
    );
    const activeRevision = revision.rows[0] ?? null;
    const tracks = activeRevision
      ? await this.pool.query(
        `SELECT position,candidate_id,catalog_id,artist,title,recording_family_id,catalog_identity_id
         FROM manifest_revision_tracks WHERE manifest_revision_id=$1 ORDER BY position`,
        [activeRevision.id],
      )
      : await this.pool.query(
        `SELECT position,candidate_id,catalog_id,artist,title,
           NULL::uuid recording_family_id,NULL::uuid catalog_identity_id
         FROM manifest_tracks WHERE manifest_id=$1 ORDER BY position`,
        [id],
      );
    return {
      id: row.id,
      runId: row.run_id,
      name: row.name,
      description: row.description,
      contentHash: activeRevision?.content_hash ?? row.content_hash,
      lockedAt: date(activeRevision?.locked_at ?? row.locked_at)?.toISOString(),
      createdAt: date(row.created_at)?.toISOString(),
      pipelineVersion: activeRevision?.pipeline_version ?? row.pipeline_version ?? "legacy_v1",
      policyVersion: activeRevision?.policy_version ?? row.policy_version ?? "legacy_v1",
      selectionPlan: activeRevision?.selection_plan_snapshot_json ?? row.selection_plan_json ?? null,
      policySnapshot: activeRevision?.pipeline_policy_snapshot_json ?? null,
      outcomeSnapshot: activeRevision?.outcome_snapshot_json ?? null,
      deficitSnapshot: Array.isArray(activeRevision?.deficit_snapshot_json)
        ? activeRevision.deficit_snapshot_json
        : [],
      revisionId: activeRevision?.id ?? null,
      revision: activeRevision ? Number(activeRevision.revision) : null,
      contractRevisionId: row.contract_revision_id ?? null,
      contractHash: row.contract_hash ?? null,
      tracks: tracks.rows.map((track) => ({
        position: Number(track.position),
        candidateId: track.candidate_id,
        catalogId: track.catalog_id,
        artist: track.artist,
        title: track.title,
        recordingFamilyId: track.recording_family_id,
        catalogIdentityId: track.catalog_identity_id,
      })),
    };
  }

  /**
   * Load exact locked rows plus explicitly compatible Apple identities for
   * publication preflight. Metadata-neighbor candidates are deliberately not
   * returned as substitutes.
   */
  async getManifestPreflightTracks(
    manifestId: string,
    revisionId: string | null = null,
    storefront = process.env.APPLE_STOREFRONT ?? "us",
  ): Promise<PreflightManifestTrack[]> {
    if (!/^[a-z]{2}$/iu.test(storefront)) throw new HttpError(400, "Apple storefront must be a two-letter code", "invalid_storefront");
    const manifest = await this.pool.query("SELECT id FROM manifests WHERE id=$1", [manifestId]);
    if (!manifest.rows[0]) throw new HttpError(404, "Manifest not found", "manifest_not_found");
    const tracks = revisionId
      ? await this.pool.query(
        `SELECT mrt.position,mrt.candidate_id,mrt.catalog_id,mrt.artist,mrt.title,
           COALESCE(mrt.recording_family_id,tc.recording_family_id) recording_family_id,
           mrt.catalog_identity_id
         FROM manifest_revision_tracks mrt
         JOIN manifest_revisions mr ON mr.id=mrt.manifest_revision_id AND mr.manifest_id=$1
         JOIN track_candidates tc ON tc.id=mrt.candidate_id
         WHERE mrt.manifest_revision_id=$2 ORDER BY mrt.position`,
        [manifestId, revisionId],
      )
      : await this.pool.query(
        `SELECT mt.position,mt.candidate_id,mt.catalog_id,mt.artist,mt.title,
           tc.recording_family_id,NULL::uuid catalog_identity_id
         FROM manifest_tracks mt JOIN track_candidates tc ON tc.id=mt.candidate_id
         WHERE mt.manifest_id=$1 ORDER BY mt.position`,
        [manifestId],
      );
    const familyIds = [...new Set(tracks.rows
      .map((track) => track.recording_family_id as string | null)
      .filter((id): id is string => Boolean(id)))];
    const identities = familyIds.length > 0
      ? await this.pool.query(
        `SELECT id,recording_family_id,catalog_id,is_preferred,identity_confidence,metadata_json
         FROM recording_catalog_identities
         WHERE recording_family_id=ANY($1::uuid[]) AND provider='apple'
           AND (storefront IS NULL OR lower(storefront)=lower($2))
         ORDER BY recording_family_id,is_preferred DESC,identity_confidence DESC,catalog_id`,
        [familyIds, storefront],
      )
      : { rows: [] as any[] };
    const byFamily = new Map<string, typeof identities.rows>();
    for (const identity of identities.rows) {
      const list = byFamily.get(identity.recording_family_id) ?? [];
      list.push(identity);
      byFamily.set(identity.recording_family_id, list);
    }
    return tracks.rows.map((track): PreflightManifestTrack => {
      const familyId = track.recording_family_id as string | null;
      const familyIdentities = familyId ? byFamily.get(familyId) ?? [] : [];
      const currentIdentity = track.catalog_identity_id
        ?? familyIdentities.find((identity) => identity.catalog_id === track.catalog_id)?.id
        ?? null;
      return {
        position: Number(track.position),
        candidateId: track.candidate_id,
        catalogId: track.catalog_id,
        artist: track.artist,
        title: track.title,
        recordingFamilyId: familyId,
        catalogIdentityId: currentIdentity,
        alternates: familyIdentities.map((identity) => {
          const metadata = identity.metadata_json && typeof identity.metadata_json === "object"
            ? identity.metadata_json as Record<string, unknown>
            : {};
          return {
            id: identity.id,
            catalogId: identity.catalog_id,
            recordingFamilyId: identity.recording_family_id,
            identityConfidence: Number(identity.identity_confidence),
            isPreferred: identity.is_preferred === true,
            compatible: identity.is_preferred === true
              || metadata.compatible === true
              || metadata.versionCompatible === true,
          };
        }),
      };
    });
  }

  /**
   * Load the immutable qualified overflow captured with a locked revision.
   * This is intentionally separate from mutable catalog-match status: once a
   * revision is locked, only its own reserve snapshot may refill it.
   */
  async getManifestPreflightReserveTracks(
    manifestId: string,
    revisionId: string,
    storefront = process.env.APPLE_STOREFRONT ?? "us",
  ): Promise<PreflightReserveTrack[]> {
    if (!/^[a-z]{2}$/iu.test(storefront)) throw new HttpError(400, "Apple storefront must be a two-letter code", "invalid_storefront");
    const reserves = await this.pool.query(
      `SELECT reserve.position,reserve.candidate_id,reserve.catalog_id,reserve.artist,reserve.title,
         reserve.recording_family_id,reserve.catalog_identity_id,reserve.evidence_eligible,
         reserve.hard_constraints_satisfied,reserve.version_compatible,reserve.qualified
       FROM manifest_revision_reserve_tracks reserve
       JOIN manifest_revisions revision ON revision.id=reserve.manifest_revision_id
         AND revision.manifest_id=$1
       WHERE reserve.manifest_revision_id=$2 ORDER BY reserve.position`,
      [manifestId, revisionId],
    );
    const revision = await this.pool.query(
      "SELECT 1 FROM manifest_revisions WHERE id=$2 AND manifest_id=$1",
      [manifestId, revisionId],
    );
    if (!revision.rows[0]) throw new HttpError(404, "Manifest revision not found", "manifest_revision_not_found");
    const familyIds = [...new Set(reserves.rows.map((reserve) => reserve.recording_family_id as string))];
    const identities = familyIds.length > 0
      ? await this.pool.query(
        `SELECT id,recording_family_id,catalog_id,is_preferred,identity_confidence,metadata_json
         FROM recording_catalog_identities
         WHERE recording_family_id=ANY($1::uuid[]) AND provider='apple'
           AND (storefront IS NULL OR lower(storefront)=lower($2))
         ORDER BY recording_family_id,is_preferred DESC,identity_confidence DESC,catalog_id`,
        [familyIds, storefront],
      )
      : { rows: [] as any[] };
    const byFamily = new Map<string, typeof identities.rows>();
    for (const identity of identities.rows) {
      const list = byFamily.get(identity.recording_family_id) ?? [];
      list.push(identity);
      byFamily.set(identity.recording_family_id, list);
    }
    return reserves.rows.map((reserve): PreflightReserveTrack => {
      const familyIdentities = byFamily.get(reserve.recording_family_id) ?? [];
      return {
        position: Number(reserve.position),
        candidateId: reserve.candidate_id,
        catalogId: reserve.catalog_id,
        artist: reserve.artist,
        title: reserve.title,
        recordingFamilyId: reserve.recording_family_id,
        catalogIdentityId: reserve.catalog_identity_id,
        evidenceEligible: reserve.evidence_eligible === true,
        hardConstraintsSatisfied: reserve.hard_constraints_satisfied === true,
        versionCompatible: reserve.version_compatible === true,
        qualified: reserve.qualified === true,
        alternates: familyIdentities.map((identity) => {
          const metadata = identity.metadata_json && typeof identity.metadata_json === "object"
            ? identity.metadata_json as Record<string, unknown>
            : {};
          return {
            id: identity.id,
            catalogId: identity.catalog_id,
            recordingFamilyId: identity.recording_family_id,
            identityConfidence: Number(identity.identity_confidence),
            isPreferred: identity.is_preferred === true,
            compatible: identity.is_preferred === true
              || metadata.compatible === true
              || metadata.versionCompatible === true,
          };
        }),
      };
    });
  }

  /**
   * Rebuild and validate the exact canonical selection from current,
   * non-revoked qualification rows immediately before Apple mutation.
   *
   * Storefront preflight can legitimately leave a manifest unchanged. That
   * does not make the older qualification projection current: evidence may
   * have been revoked, a contract may have been superseded, or the active
   * query plan may have changed since the revision was locked. All of those
   * cases fail closed into the publisher's explicit decision state.
   */
  async revalidateCanonicalPublicationManifest(input: {
    runId: string;
    manifestId: string;
    manifestRevisionId: string;
    manifestRevisionHash: string;
    partialPublicationAuthorized: boolean;
  }): Promise<void> {
    const fail = (...reasonCodes: string[]): never => {
      throw new CanonicalPublicationRevalidationRequiredErrorV1(reasonCodes);
    };
    if (Number(await this.getSchemaVersion() ?? 0) < 18) {
      fail("canonical_qualification_projection_unavailable");
    }
    await this.transaction(async (client) => {
      const authority = await client.query<{
        active_contract_revision_id: string;
        manifest_contract_revision_id: string;
        manifest_contract_hash: string;
        active_contract_hash: string;
        active_contract_json: PlaylistContractRevisionV1;
        revision_content_hash: string;
        revision_selection_plan_json: SelectionPlanV3 | null;
        selection_plan_json: SelectionPlanV3;
        query_plan_json: QueryPlanV3;
      }>(
        `SELECT
           run.active_playlist_contract_revision_id active_contract_revision_id,
           manifest.contract_revision_id manifest_contract_revision_id,
           manifest.contract_hash manifest_contract_hash,
           contract.contract_hash active_contract_hash,
           contract.contract_json active_contract_json,
           revision.content_hash revision_content_hash,
           revision.selection_plan_snapshot_json revision_selection_plan_json,
           selection.plan_json selection_plan_json,
           query.plan_json query_plan_json
         FROM research_runs run
         JOIN manifests manifest
           ON manifest.run_id=run.id
         JOIN manifest_revisions revision
           ON revision.manifest_id=manifest.id
         JOIN playlist_contract_revisions contract
           ON contract.id=run.active_playlist_contract_revision_id
          AND contract.status='active'
         JOIN run_active_query_plans active
           ON active.run_id=run.id
         JOIN query_plan_revisions query
           ON query.id=active.query_plan_revision_id
          AND query.id=revision.query_plan_revision_id
          AND query.status='active'
         JOIN selection_plans selection
           ON selection.id=query.selection_plan_id
          AND selection.id=revision.selection_plan_id
          AND selection.status='active'
         WHERE run.id=$1
           AND manifest.id=$2
           AND revision.id=$3
           AND revision.status='locked'
           AND revision.pipeline_version='corpus_first_v3'
           AND run.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM manifest_revisions newer
             WHERE newer.manifest_id=manifest.id
               AND newer.status IN ('locked','published')
               AND newer.revision>revision.revision
           )
         FOR SHARE OF run,manifest,revision,contract,active,query,selection`,
        [
          input.runId,
          input.manifestId,
          input.manifestRevisionId,
        ],
      );
      const row = authority.rows[0];
      if (!row) fail("canonical_publication_authority_stale");
      const plan = row.selection_plan_json;
      const queryPlan = row.query_plan_json;
      const contract = row.active_contract_json;
      try {
        assertPlaylistContractIntegrityV1(contract);
      } catch {
        fail("canonical_contract_integrity_invalid");
      }
      const contractPolicy = plan?.canonicalContractPolicy;
      const queryContractPolicy = queryPlan?.canonicalContractPolicy;
      const contractBound = Boolean(
        queryPlan?.schemaVersion === 4
        && contractPolicy
        && queryContractPolicy
        && row.active_contract_revision_id
          === row.manifest_contract_revision_id
        && row.active_contract_hash === row.manifest_contract_hash
        && row.active_contract_hash === contract.semanticHash
        && queryPlan.playlistContractRevisionId === contract.revisionId
        && queryPlan.playlistContractSemanticHash === contract.semanticHash
        && queryPlan.playlistContractCompilerVersion
          === contract.versions.compiler
        && queryPlan.targetTrackCount === contract.requestedTrackCount
        && queryPlan.storefront === contract.storefront
        && contractPolicy.contractRevisionId === contract.revisionId
        && contractPolicy.contractSemanticHash === contract.semanticHash
        && contractPolicy.contractCompilerVersion
          === contract.versions.compiler
        && contractPolicy.requestedTrackCount
          === contract.requestedTrackCount
        && contractPolicy.storefront === contract.storefront
        && stableStringify(contractPolicy)
          === stableStringify(queryContractPolicy)
        && stableStringify(plan.playlistQuotaRules ?? [])
          === stableStringify(queryPlan.playlistQuotaRules ?? [])
        && stableStringify(plan.playlistQualityPolicy ?? null)
          === stableStringify(queryPlan.playlistQualityPolicy ?? null)
        && stableStringify(row.revision_selection_plan_json)
          === stableStringify(plan),
      );
      if (!contractBound) fail("canonical_publication_contract_stale");
      if (row.revision_content_hash !== input.manifestRevisionHash) {
        fail("canonical_manifest_revision_hash_stale");
      }

      const tracks = await client.query<{
        position: number;
        candidate_id: string;
        recording_family_id: string | null;
        catalog_identity_id: string | null;
        catalog_id: string;
        artist: string;
        title: string;
      }>(
        `SELECT track.position,track.candidate_id,
                track.recording_family_id,track.catalog_identity_id,
                track.catalog_id,track.artist,track.title
         FROM manifest_revision_tracks track
         WHERE track.manifest_revision_id=$1
         ORDER BY track.position
         FOR SHARE OF track`,
        [input.manifestRevisionId],
      );
      const manifestTracks: ManifestRevisionTrack[] = tracks.rows.map(
        (track) => ({
          position: Number(track.position),
          candidateId: track.candidate_id,
          recordingFamilyId: track.recording_family_id,
          catalogIdentityId: track.catalog_identity_id,
          catalogId: track.catalog_id,
          artist: track.artist,
          title: track.title,
        }),
      );
      if (manifestContentHash(manifestTracks) !== input.manifestRevisionHash) {
        fail("canonical_manifest_revision_content_invalid");
      }

      const qualifications = await client.query<{
        candidate_id: string;
        artist: string;
        title: string;
        album: string | null;
        family_key: string;
        decision: string;
        revoked_at: Date | null;
        predicate_results_json: unknown;
        evidence_record_ids_json: unknown;
        quality_result_json: unknown;
        catalog_result_json: unknown;
      }>(
        `SELECT qualification.candidate_id,candidate.artist,candidate.title,
                candidate.album,family.family_key,qualification.decision,
                qualification.revoked_at,
                qualification.predicate_results_json,
                qualification.evidence_record_ids_json,
                qualification.quality_result_json,
                qualification.catalog_result_json
         FROM playlist_qualification_records qualification
         JOIN track_candidates candidate
           ON candidate.id=qualification.candidate_id
          AND candidate.run_id=qualification.run_id
         JOIN recording_families family
           ON family.id=candidate.recording_family_id
          AND family.run_id=qualification.run_id
         WHERE qualification.run_id=$1
           AND qualification.contract_revision_id=$2
           AND qualification.candidate_id=ANY($3::uuid[])
           AND lower(qualification.storefront)=lower($4)
           AND qualification.decision='qualified'
           AND qualification.revoked_at IS NULL
           AND qualification.quality_result_json->>'verdict'='pass'
           AND qualification.catalog_result_json->>'verdict'='pass'
         ORDER BY qualification.candidate_id,
                  qualification.qualified_at DESC,qualification.id DESC
         FOR SHARE OF qualification,candidate,family`,
        [
          input.runId,
          row.active_contract_revision_id,
          manifestTracks.map(({ candidateId }) => candidateId),
          plan.storefront,
        ],
      );
      const currentQualifications: PersistedCanonicalQualificationV1[] =
        qualifications.rows.map((qualification) => ({
          candidateId: qualification.candidate_id,
          artist: qualification.artist,
          title: qualification.title,
          album: qualification.album,
          recordingFamilyKey: qualification.family_key,
          decision: qualification.decision,
          revokedAt: qualification.revoked_at,
          predicateResults: qualification.predicate_results_json,
          evidenceRecordIds: qualification.evidence_record_ids_json,
          qualityResult: qualification.quality_result_json,
          catalogResult: qualification.catalog_result_json,
        }));
      assertCanonicalManifestRevisionV1({
        plan,
        manifestTracks,
        qualifications: currentQualifications,
        partialPublicationAuthorized: input.partialPublicationAuthorized,
      });
    });
  }

  async getLatestManifestForRun(runId: string): Promise<any | null> {
    const result = await this.pool.query<{ id: string }>("SELECT id FROM manifests WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1", [runId]);
    return result.rows[0] ? this.getManifestById(result.rows[0].id) : null;
  }

  async getPublicationGuard(input: {
    runId: string;
    manifestId: string;
    manifestRevisionId: string | null;
    manifestRevisionHash: string;
    selectedCount: number;
  }): Promise<{
    requestedTrackCount: number | null;
    enforcement: "required" | "legacy_compat";
    currentOutcomeHash: string | null;
    decision: null | {
      decision: "accepted";
      manifestRevisionId: string;
      manifestRevisionHash: string;
      targetCount: number;
      selectedCount: number;
      outcomeHash: string;
      expiresAt: string | Date;
    };
  }> {
    const schemaVersion = Number(await this.getSchemaVersion() ?? 0);
    const runResult = await this.pool.query<{
      pipeline_version: string;
      status: string;
      phase: string;
      requested_track_count: number | null;
    }>(schemaVersion >= 14
      ? `SELECT r.pipeline_version,r.status,r.phase,
           COALESCE(spec.requested_track_count,
             NULLIF(r.selection_plan_json->>'requestedTrackCount','')::int,
             CASE
               WHEN NULLIF(r.brief_json #>> '{targetSize,min}','')::int
                  = NULLIF(r.brief_json #>> '{targetSize,max}','')::int
               THEN NULLIF(r.brief_json #>> '{targetSize,max}','')::int
               ELSE NULL
             END) requested_track_count
         FROM research_runs r
         LEFT JOIN run_specs spec ON spec.run_id=r.id
         WHERE r.id=$1 AND r.deleted_at IS NULL`
      : `SELECT r.pipeline_version,r.status,r.phase,
           COALESCE(NULLIF(r.selection_plan_json->>'requestedTrackCount','')::int,
             CASE
               WHEN NULLIF(r.brief_json #>> '{targetSize,min}','')::int
                  = NULLIF(r.brief_json #>> '{targetSize,max}','')::int
               THEN NULLIF(r.brief_json #>> '{targetSize,max}','')::int
               ELSE NULL
             END) requested_track_count
         FROM research_runs r WHERE r.id=$1 AND r.deleted_at IS NULL`,
    [input.runId]);
    const run = runResult.rows[0];
    if (!run) throw new HttpError(404, "Research run not found", "run_not_found");
    if (schemaVersion >= 18) {
      const binding = await this.pool.query<{
        brief_contract_version: number;
        active_playlist_contract_revision_id: string | null;
        manifest_contract_revision_id: string | null;
        manifest_contract_hash: string | null;
        active_contract_hash: string | null;
      }>(
        `SELECT run.brief_contract_version,run.active_playlist_contract_revision_id,
                manifest.contract_revision_id manifest_contract_revision_id,
                manifest.contract_hash manifest_contract_hash,
                contract.contract_hash active_contract_hash
         FROM research_runs run
         JOIN manifests manifest ON manifest.id=$2 AND manifest.run_id=run.id
         LEFT JOIN playlist_contract_revisions contract
           ON contract.id=run.active_playlist_contract_revision_id
             AND contract.status='active'
         WHERE run.id=$1 AND run.deleted_at IS NULL`,
        [input.runId, input.manifestId],
      );
      const row = binding.rows[0];
      if (!row) throw new HttpError(404, "Playlist manifest not found", "manifest_not_found");
      const contractRequired = Number(row.brief_contract_version) === 3;
      const contractPresent = row.manifest_contract_revision_id !== null
        && row.manifest_contract_hash !== null;
      if ((contractRequired && !contractPresent)
        || (contractPresent && (
          row.manifest_contract_revision_id !== row.active_playlist_contract_revision_id
          || row.manifest_contract_hash !== row.active_contract_hash
        ))) {
        throw new HttpError(
          409,
          "Publication is fenced to a superseded playlist contract",
          "manifest_contract_stale",
        );
      }
    }
    const requestedTrackCount = run.requested_track_count == null
      ? null
      : Math.max(1, Math.floor(Number(run.requested_track_count)));
    const enforcement = requestedTrackCount !== null
      ? "required" as const
      : "legacy_compat" as const;
    const partialCheckpoint = await this.getResearchCheckpoint(input.runId, "partial_ready") as Record<string, unknown> | null;
    const currentOutcomeHash = typeof partialCheckpoint?.outcomeHash === "string"
      && /^[a-f0-9]{64}$/iu.test(partialCheckpoint.outcomeHash)
      ? partialCheckpoint.outcomeHash.toLowerCase()
      : null;
    if (run.pipeline_version === "corpus_first_v3") {
      if (schemaVersion < 14 || !input.manifestRevisionId) {
        throw new HttpError(
          409,
          "Pipeline V3 publication requires an attested manifest revision",
          "pipeline_v3_evidence_attestation_missing",
        );
      }
      const revisionContract = await this.pool.query<{
        selection_plan_snapshot_json: SelectionPlanV3;
      }>(
        `SELECT selection_plan_snapshot_json
         FROM manifest_revisions
         WHERE id=$1 AND manifest_id=$2 AND pipeline_version='corpus_first_v3'`,
        [input.manifestRevisionId, input.manifestId],
      );
      const selectionPlan = revisionContract.rows[0]?.selection_plan_snapshot_json;
      const requiredPredicates = selectionPlan
        ? evidenceMembershipPredicatesV3(selectionPlan)
        : [];
      if (!selectionPlan || requiredPredicates.length === 0) {
        throw new HttpError(
          409,
          "Pipeline V3 publication is blocked because its immutable membership contract is missing",
          "pipeline_v3_evidence_attestation_missing",
        );
      }
      const evidence = await this.pool.query<{
        position: number;
        candidate_id: string;
        binding_id: string | null;
        scope_axis: string | null;
        scope_value: string | null;
        relationship: string | null;
        provenance_path_json: unknown;
      }>(
        `SELECT track.position,track.candidate_id,binding.id binding_id,
                binding.scope_axis,binding.scope_value,binding.relationship,
                binding.provenance_path_json
         FROM manifest_revision_tracks track
         LEFT JOIN track_scope_bindings binding
           ON binding.run_id=$1
          AND binding.candidate_id=track.candidate_id
          AND binding.eligibility='qualifying'
          AND binding.pipeline_version='corpus_first_v3'
          AND binding.source_url LIKE 'https://%'
         WHERE track.manifest_revision_id=$2
         ORDER BY track.position,binding.id`,
        [input.runId, input.manifestRevisionId],
      );
      const bindingsByCandidate = new Map<string, typeof evidence.rows>();
      const manifestCandidates = new Set<string>();
      for (const row of evidence.rows) {
        manifestCandidates.add(row.candidate_id);
        if (!row.binding_id) continue;
        const bindings = bindingsByCandidate.get(row.candidate_id) ?? [];
        bindings.push(row);
        bindingsByCandidate.set(row.candidate_id, bindings);
      }
      const bindingPredicateIds = (row: typeof evidence.rows[number]): Set<string> => {
        if (!Array.isArray(row.provenance_path_json)) return new Set();
        const path = row.provenance_path_json.filter((item): item is Record<string, unknown> => (
          item !== null && typeof item === "object" && !Array.isArray(item)
        ));
        const attested = path.some((item) => {
          if (item.kind !== "evidence_eligibility_attestation"
            || !item.attestation || typeof item.attestation !== "object"
            || Array.isArray(item.attestation)) return false;
          const attestation = item.attestation as Record<string, unknown>;
          return attestation.schemaVersion === "genio-pipeline-v3-evidence-attestation/v1"
            && ["approved_exact_track_scope_source", "frozen_promoted_graph_assertion"]
              .includes(String(attestation.kind ?? ""));
        });
        if (!attested) return new Set();
        const explicitIds = path.flatMap((item) => (
          item.kind === "pipeline_v3_binding" && Array.isArray(item.predicateIds)
            ? item.predicateIds.filter((id): id is string => typeof id === "string")
            : []
        ));
        if (explicitIds.length > 0) return new Set(explicitIds);
        // Conservative compatibility for manifests created before predicate
        // ids were embedded in the provenance path. A row may cover only the
        // one immutable predicate whose complete scope tuple it matches.
        const compatible = requiredPredicates.filter((predicate) => (
          predicate.axis === row.scope_axis
          && predicate.operator === row.relationship
          && predicate.values.join(" | ") === row.scope_value
        ));
        return new Set(compatible.map((predicate) => predicate.id));
      };
      const fullyAttested = manifestCandidates.size === input.selectedCount
        && [...manifestCandidates].every((candidateId) => {
          const covered = new Set<string>();
          for (const binding of bindingsByCandidate.get(candidateId) ?? []) {
            for (const predicateId of bindingPredicateIds(binding)) covered.add(predicateId);
          }
          return requiredPredicates.every((predicate) => covered.has(predicate.id));
        });
      if (!fullyAttested) {
        throw new HttpError(
          409,
          "Pipeline V3 publication is blocked because every manifest track must attest every required membership predicate",
          "pipeline_v3_evidence_attestation_missing",
        );
      }
    }
    if (!shortManifestRequiresDecision(requestedTrackCount, input.selectedCount)) {
      return { requestedTrackCount, enforcement, currentOutcomeHash, decision: null };
    }
    if (schemaVersion >= 14 && input.manifestRevisionId) {
      const decision = await this.pool.query<{
        manifest_revision_id: string;
        manifest_revision_hash: string;
        capability_session_id: string | null;
        target_count: number;
        selected_count: number;
        outcome_hash: string;
        idempotency_key: string;
        expires_at: string | Date;
      }>(
        `SELECT manifest_revision_id,manifest_revision_hash,target_count,selected_count,
           capability_session_id,outcome_hash,idempotency_key,expires_at
         FROM partial_publication_decisions
         WHERE run_id=$1 AND manifest_revision_id=$2 AND manifest_revision_hash=$3
           AND decision='publish_partial' AND target_count=$4 AND selected_count=$5
           AND expires_at>now() ORDER BY decided_at DESC LIMIT 1`,
        [
          input.runId,
          input.manifestRevisionId,
          input.manifestRevisionHash,
          requestedTrackCount,
          input.selectedCount,
        ],
      );
      let row: typeof decision.rows[number] | undefined = decision.rows[0];
      if (row && schemaVersion >= 18) {
        const consent = await this.pool.query<{ partial_consent_answer_hash: string | null }>(
          "SELECT partial_consent_answer_hash FROM manifests WHERE id=$1 AND run_id=$2",
          [input.manifestId, input.runId],
        );
        const expectedConsentHash = sha256Hex(stableStringify({
          decision: "publish_partial",
          runId: input.runId,
          capabilitySessionId: row.capability_session_id,
          outcomeHash: row.outcome_hash,
          manifestId: input.manifestId,
          manifestRevisionId: row.manifest_revision_id,
          manifestRevisionHash: row.manifest_revision_hash,
          targetTrackCount: Number(row.target_count),
          selectedTrackCount: Number(row.selected_count),
          idempotencyKey: row.idempotency_key,
        }));
        if (consent.rows[0]?.partial_consent_answer_hash !== expectedConsentHash) {
          row = undefined;
        }
      }
      return {
        requestedTrackCount,
        enforcement,
        currentOutcomeHash,
        decision: row ? {
          decision: "accepted",
          manifestRevisionId: row.manifest_revision_id,
          manifestRevisionHash: row.manifest_revision_hash,
          targetCount: Number(row.target_count),
          selectedCount: Number(row.selected_count),
          outcomeHash: row.outcome_hash,
          expiresAt: row.expires_at,
        } : null,
      };
    }
    const bridge = await this.getResearchCheckpoint(input.runId, "partial_publication_consent") as Record<string, unknown> | null;
    const bridgeExpiresAt = typeof bridge?.expiresAt === "string" ? new Date(bridge.expiresAt) : null;
    const bridgeMatches = bridge?.decision === "confirmed"
      && bridge?.manifestId === input.manifestId
      && bridge?.manifestRevisionId === input.manifestRevisionId
      && bridge?.manifestHash === input.manifestRevisionHash
      && Number(bridge?.targetTrackCount) === requestedTrackCount
      && Number(bridge?.selectedTrackCount) === input.selectedCount
      && bridgeExpiresAt !== null
      && bridgeExpiresAt.getTime() > Date.now();
    return {
      requestedTrackCount,
      enforcement,
      currentOutcomeHash,
      decision: bridgeMatches ? {
        decision: "accepted",
        manifestRevisionId: String(bridge!.manifestRevisionId),
        manifestRevisionHash: String(bridge!.manifestHash),
        targetCount: Number(bridge!.targetTrackCount),
        selectedCount: Number(bridge!.selectedTrackCount),
        outcomeHash: String(bridge!.outcomeHash),
        expiresAt: bridgeExpiresAt!,
      } : null,
    };
  }

  async createPublicationVolume(input: PublicationVolumeInput): Promise<any> {
    const id = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO publication_volumes(
         id,manifest_id,manifest_revision_id,volume_number,volume_count,start_position,end_position,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(manifest_id,volume_number) DO UPDATE SET updated_at=now()
       WHERE publication_volumes.manifest_revision_id IS NOT DISTINCT FROM EXCLUDED.manifest_revision_id
         AND publication_volumes.volume_count=EXCLUDED.volume_count
         AND publication_volumes.start_position=EXCLUDED.start_position
         AND publication_volumes.end_position=EXCLUDED.end_position
       RETURNING *`,
      [
        id,
        input.manifestId,
        input.manifestRevisionId ?? null,
        input.volumeNumber,
        input.volumeCount,
        input.startPosition,
        input.endPosition,
        input.status ?? "queued",
      ],
    );
    if (!result.rows[0]) {
      throw new HttpError(
        409,
        "Publication volume belongs to a different manifest revision or immutable range",
        "publication_revision_conflict",
      );
    }
    return result.rows[0];
  }

  async retirePublicationVolume(input: {
    manifestId: string;
    publicationVolumeId: string;
    applePlaylistId?: string | null;
    reason: string;
  }): Promise<string | null> {
    return this.transaction(async (client) => {
      const locked = await client.query<{ apple_playlist_id: string | null }>(
        `SELECT apple_playlist_id FROM publication_volumes
         WHERE id=$1 AND manifest_id=$2 FOR UPDATE`,
        [input.publicationVolumeId, input.manifestId],
      );
      if (!locked.rows[0]) return null;
      const applePlaylistId = locked.rows[0].apple_playlist_id ?? input.applePlaylistId;
      let orphanId: string | null = null;
      if (applePlaylistId) {
        orphanId = randomUUID();
        await client.query(
          `INSERT INTO orphan_playlists(
             id,manifest_id,publication_volume_id,apple_playlist_id,reason)
           VALUES($1,$2,$3,$4,$5)`,
          [
            orphanId,
            input.manifestId,
            input.publicationVolumeId,
            applePlaylistId,
            sanitizeFailure(input.reason, "publication"),
          ],
        );
      }
      await client.query("DELETE FROM publication_volumes WHERE id=$1", [input.publicationVolumeId]);
      return orphanId;
    });
  }

  async hidePublicPlaylistsForRun(runId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE public_playlists SET status='hidden',hidden_at=COALESCE(hidden_at,now()),updated_at=now()
       WHERE run_id=$1 AND status='listed' AND hidden_at IS NULL`,
      [runId],
    );
    return result.rowCount ?? 0;
  }

  async updatePublicationVolume(id: string, patch: {
    status?: string;
    applePlaylistId?: string | null;
    appleShareUrl?: string | null;
    appendedCount?: number;
    attemptDelta?: number;
    lastError?: string | null;
    publishedAt?: Date | null;
  }): Promise<void> {
    const persistedLastError = sanitizeOptionalFailure(patch.lastError, "publication");
    const result = await this.pool.query(
      `UPDATE publication_volumes SET status=COALESCE($2,status),apple_playlist_id=CASE WHEN $3::boolean THEN $4 ELSE apple_playlist_id END,
       apple_share_url=CASE WHEN $5::boolean THEN $6 ELSE apple_share_url END,appended_count=COALESCE($7,appended_count),
       attempt=attempt+$8,last_error=CASE WHEN $9::boolean THEN $10 ELSE last_error END,
       published_at=CASE WHEN $11::boolean THEN $12 ELSE published_at END,updated_at=now() WHERE id=$1`,
      [id, patch.status ?? null, patch.applePlaylistId !== undefined, patch.applePlaylistId ?? null, patch.appleShareUrl !== undefined, patch.appleShareUrl ?? null, patch.appendedCount ?? null, patch.attemptDelta ?? 0, patch.lastError !== undefined, persistedLastError ?? null, patch.publishedAt !== undefined, patch.publishedAt ?? null],
    );
    if (!result.rowCount) throw new HttpError(404, "Publication volume not found", "publication_not_found");
  }

  /**
   * Make publication terminal only while every mutable authority is locked and
   * still matches the exact reconciled Apple attempt. This closes the gap
   * between a read-only publication guard and a later generic updateRun call.
   */
  async commitPublicationCompletion(input: PublicationCompletionFence): Promise<void> {
    const supportsPublicationReconciliation =
      Number(await this.getSchemaVersion() ?? 0) >= 18;
    const contractPairComplete = (input.contractRevisionId === null) === (input.contractHash === null);
    const validVolumes = input.publicationVolumes.length > 0
      && input.publicationVolumes.every((volume) => (
        /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(volume.publicationVolumeId)
        && Number.isInteger(volume.attempt)
        && volume.attempt >= 0
        && Boolean(volume.applePlaylistId)
        && Number.isInteger(volume.appendedCount)
        && Number.isInteger(volume.startPosition)
        && Number.isInteger(volume.endPosition)
        && volume.startPosition >= 0
        && volume.endPosition >= volume.startPosition
      ))
      && new Set(input.publicationVolumes.map((volume) => volume.publicationVolumeId)).size
        === input.publicationVolumes.length;
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(input.runId)
      || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(input.manifestId)
      || (input.manifestRevisionId !== null
        && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(input.manifestRevisionId))
      || !/^[a-f0-9]{64}$/iu.test(input.manifestRevisionHash)
      || (input.contractRevisionId !== null
        && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(input.contractRevisionId))
      || (input.contractHash !== null && !/^[a-f0-9]{64}$/iu.test(input.contractHash))
      || !contractPairComplete
      || !Number.isInteger(input.selectedCount)
      || input.selectedCount < 1
      || input.selectedCount > EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS
      || !["complete", "partial"].includes(input.terminalStatus)
      || !validVolumes) {
      throw new HttpError(400, "Publication completion fence is invalid", "invalid_publication_completion_fence");
    }

    await this.transaction(async (client) => {
      // Contract successors and manifest revisions both lock the run before
      // changing authority. Lock it first here as well, then read every other
      // fence under the same transaction snapshot.
      const runResult = await client.query<{
        status: string;
        phase: string;
        brief_contract_version: number;
        active_playlist_contract_revision_id: string | null;
        pipeline_version: PipelineVersion;
        policy_version: PipelinePolicyVersion;
        requested_track_count: number | null;
      }>(
        `SELECT run.status,run.phase,run.brief_contract_version,
                run.active_playlist_contract_revision_id,
                run.pipeline_version,run.policy_version,
                COALESCE(spec.requested_track_count,
                  NULLIF(run.selection_plan_json->>'requestedTrackCount','')::int,
                  CASE
                    WHEN NULLIF(run.brief_json #>> '{targetSize,min}','')::int
                       = NULLIF(run.brief_json #>> '{targetSize,max}','')::int
                    THEN NULLIF(run.brief_json #>> '{targetSize,max}','')::int
                    ELSE NULL
                  END) requested_track_count
         FROM research_runs run
         LEFT JOIN run_specs spec ON spec.run_id=run.id
         WHERE run.id=$1 AND run.deleted_at IS NULL
         FOR UPDATE OF run`,
        [input.runId],
      );
      const run = runResult.rows[0];
      const cancelled = !run
        || ["cancelled", "deleted", "expired"].includes(run.status)
        || ["visitor_cancelled", "owner_cancelled", "visitor_deleted"].includes(run.phase);
      if (cancelled) {
        throw new HttpError(
          409,
          "Playlist publication was cancelled before completion",
          "publication_run_cancelled",
        );
      }
      const terminalPhase = input.terminalStatus === "partial" ? "published_partial" : "published";
      const idempotentTerminal = run.status === input.terminalStatus && run.phase === terminalPhase;
      if (!(run.status === "publishing" && run.phase === "apple_publication") && !idempotentTerminal) {
        throw new HttpError(
          409,
          "Publication attempt is no longer the active run operation",
          "publication_attempt_stale",
        );
      }

      const manifestResult = await client.query<{
        content_hash: string;
        contract_revision_id: string | null;
        contract_hash: string | null;
        partial_consent_answer_hash: string | null;
      }>(
        `SELECT content_hash,contract_revision_id,contract_hash,partial_consent_answer_hash
         FROM manifests WHERE id=$2 AND run_id=$1 FOR UPDATE`,
        [input.runId, input.manifestId],
      );
      const manifest = manifestResult.rows[0];
      if (!manifest) throw new HttpError(404, "Playlist manifest not found", "manifest_not_found");

      let selectedTrackCount: number;
      let revisionPipelineVersion = run.pipeline_version;
      let revisionPolicyVersion = run.policy_version;
      if (input.manifestRevisionId) {
        const revisionResult = await client.query<{
          content_hash: string;
          pipeline_version: PipelineVersion;
          policy_version: PipelinePolicyVersion;
          status: ManifestRevisionStatus;
          selected_count: number;
          is_latest: boolean;
        }>(
          `SELECT revision.content_hash,revision.pipeline_version,revision.policy_version,
                  revision.status,
                  (SELECT count(*)::int FROM manifest_revision_tracks track
                   WHERE track.manifest_revision_id=revision.id) selected_count,
                  NOT EXISTS (
                    SELECT 1 FROM manifest_revisions successor
                    WHERE successor.manifest_id=revision.manifest_id
                      AND successor.status IN ('locked','published')
                      AND successor.revision>revision.revision
                  ) is_latest
           FROM manifest_revisions revision
           WHERE revision.id=$2 AND revision.manifest_id=$1
           FOR UPDATE`,
          [input.manifestId, input.manifestRevisionId],
        );
        const revision = revisionResult.rows[0];
        if (!revision
          || !["locked", "published"].includes(revision.status)
          || !revision.is_latest
          || revision.content_hash !== input.manifestRevisionHash) {
          throw new HttpError(
            409,
            "Publication manifest revision is stale",
            "manifest_revision_stale",
          );
        }
        selectedTrackCount = Number(revision.selected_count);
        revisionPipelineVersion = revision.pipeline_version;
        revisionPolicyVersion = revision.policy_version;
      } else {
        const successor = await client.query<{ exists: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM manifest_revisions
             WHERE manifest_id=$1 AND status IN ('locked','published')
           ) exists`,
          [input.manifestId],
        );
        if (successor.rows[0]?.exists === true
          || manifest.content_hash !== input.manifestRevisionHash) {
          throw new HttpError(
            409,
            "Publication manifest revision is stale",
            "manifest_revision_stale",
          );
        }
        const trackCount = await client.query<{ count: number }>(
          "SELECT count(*)::int count FROM manifest_tracks WHERE manifest_id=$1",
          [input.manifestId],
        );
        selectedTrackCount = Number(trackCount.rows[0]?.count ?? 0);
      }
      if (selectedTrackCount !== input.selectedCount) {
        throw new HttpError(
          409,
          "Publication manifest count changed before completion",
          "manifest_revision_stale",
        );
      }

      const contractRequired = Number(run.brief_contract_version) === 3
        || input.contractRevisionId !== null
        || input.contractHash !== null;
      if (contractRequired) {
        const contract = input.contractRevisionId
          ? await client.query<{ contract_hash: string; status: string }>(
            `SELECT contract_hash,status FROM playlist_contract_revisions
             WHERE id=$1 FOR SHARE`,
            [input.contractRevisionId],
          )
          : { rows: [] as Array<{ contract_hash: string; status: string }> };
        const active = contract.rows[0];
        if (!input.contractRevisionId
          || !input.contractHash
          || run.active_playlist_contract_revision_id !== input.contractRevisionId
          || manifest.contract_revision_id !== input.contractRevisionId
          || manifest.contract_hash !== input.contractHash
          || active?.status !== "active"
          || active.contract_hash !== input.contractHash) {
          throw new HttpError(
            409,
            "Publication is fenced to a superseded playlist contract",
            "manifest_contract_stale",
          );
        }
      } else if (manifest.contract_revision_id !== null || manifest.contract_hash !== null) {
        throw new HttpError(
          409,
          "Publication contract binding is incomplete",
          "manifest_contract_stale",
        );
      }

      const volumeResult = await client.query<{
        id: string;
        manifest_revision_id: string | null;
        volume_number: number;
        volume_count: number;
        start_position: number;
        end_position: number;
        status: string;
        apple_playlist_id: string | null;
        apple_share_url: string | null;
        appended_count: number;
        attempt: number;
        published_at: Date | null;
      }>(
        `SELECT id,manifest_revision_id,volume_number,volume_count,
                start_position,end_position,status,apple_playlist_id,
                apple_share_url,appended_count,attempt,published_at
         FROM publication_volumes
         WHERE manifest_id=$1
         ORDER BY volume_number
         FOR UPDATE`,
        [input.manifestId],
      );
      const storedVolumes = volumeResult.rows;
      const expectedById = new Map(input.publicationVolumes.map((volume) => (
        [volume.publicationVolumeId, volume] as const
      )));
      const exactAttempt = storedVolumes.length === input.publicationVolumes.length
        && storedVolumes.every((volume, index) => {
          const expected = expectedById.get(volume.id);
          const expectedLength = volume.end_position - volume.start_position + 1;
          return Boolean(expected)
            && volume.manifest_revision_id === input.manifestRevisionId
            && Number(volume.volume_number) === index + 1
            && Number(volume.volume_count) === storedVolumes.length
            && Number(volume.start_position) === expected!.startPosition
            && Number(volume.end_position) === expected!.endPosition
            && Number(volume.attempt) === expected!.attempt
            && volume.apple_playlist_id === expected!.applePlaylistId
            && Number(volume.appended_count) === expected!.appendedCount
            && Number(volume.appended_count) === expectedLength
            && volume.status === "complete"
            && Boolean(volume.apple_share_url)
            && volume.published_at !== null;
        })
        && storedVolumes[0]?.start_position === 0
        && storedVolumes.every((volume, index) => (
          index === 0 || volume.start_position === storedVolumes[index - 1]!.end_position + 1
        ))
        && storedVolumes.at(-1)?.end_position === input.selectedCount - 1;
      if (!exactAttempt) {
        throw new HttpError(
          409,
          "Publication attempt changed before completion",
          "publication_attempt_stale",
        );
      }

      const requestedTrackCount = run.requested_track_count === null
        ? null
        : Math.max(1, Math.floor(Number(run.requested_track_count)));
      if (requestedTrackCount !== null && input.selectedCount > requestedTrackCount) {
        throw new HttpError(
          409,
          "Publication exceeds the immutable requested count",
          "publication_count_conflict",
        );
      }
      if (requestedTrackCount !== null && input.selectedCount < requestedTrackCount) {
        if (!input.manifestRevisionId) {
          throw new HttpError(
            409,
            "Partial publication consent is not bound to a manifest revision",
            "partial_publication_decision_required",
          );
        }
        const checkpoint = await client.query<{ state_json: Record<string, unknown> }>(
          `SELECT state_json FROM research_checkpoints
           WHERE run_id=$1 AND phase='partial_ready' FOR SHARE`,
          [input.runId],
        );
        const outcomeHash = typeof checkpoint.rows[0]?.state_json?.outcomeHash === "string"
          ? checkpoint.rows[0].state_json.outcomeHash
          : null;
        const decision = await client.query<{
          capability_session_id: string | null;
          outcome_hash: string;
          idempotency_key: string;
          expires_at: Date;
        }>(
          `SELECT capability_session_id,outcome_hash,idempotency_key,expires_at
           FROM partial_publication_decisions
           WHERE run_id=$1 AND manifest_revision_id=$2
             AND manifest_revision_hash=$3 AND decision='publish_partial'
             AND target_count=$4 AND selected_count=$5
             AND expires_at>now()
           ORDER BY decided_at DESC LIMIT 1 FOR SHARE`,
          [
            input.runId,
            input.manifestRevisionId,
            input.manifestRevisionHash,
            requestedTrackCount,
            input.selectedCount,
          ],
        );
        const consent = decision.rows[0];
        const consentHash = consent && outcomeHash === consent.outcome_hash
          ? sha256Hex(stableStringify({
            decision: "publish_partial",
            runId: input.runId,
            capabilitySessionId: consent.capability_session_id,
            outcomeHash: consent.outcome_hash,
            manifestId: input.manifestId,
            manifestRevisionId: input.manifestRevisionId,
            manifestRevisionHash: input.manifestRevisionHash,
            targetTrackCount: requestedTrackCount,
            selectedTrackCount: input.selectedCount,
            idempotencyKey: consent.idempotency_key,
          }))
          : null;
        if (!consentHash || manifest.partial_consent_answer_hash !== consentHash) {
          throw new HttpError(
            409,
            "A current partial-publication decision is required",
            "partial_publication_decision_required",
          );
        }
      }

      if (input.pipelineOutcome) {
        if (input.pipelineOutcome.pipelineVersion !== revisionPipelineVersion
          || input.pipelineOutcome.policyVersion !== revisionPolicyVersion
          || input.pipelineOutcome.publishedTrackCount !== input.selectedCount) {
          throw new HttpError(
            409,
            "Publication outcome does not match the reconciled manifest",
            "pipeline_policy_mismatch",
          );
        }
        const merged = await persistPipelineOutcomeTransaction(client, input.runId, input.pipelineOutcome);
        if (input.manifestRevisionId) {
          await client.query(
            `UPDATE manifest_revisions SET status='published',
               outcome_snapshot_json=$3::jsonb,deficit_snapshot_json=$4::jsonb,
               locked_at=COALESCE(locked_at,now())
             WHERE id=$2 AND manifest_id=$1`,
            [
              input.manifestId,
              input.manifestRevisionId,
              JSON.stringify(merged),
              JSON.stringify(merged.deficits),
            ],
          );
        }
      } else if (input.manifestRevisionId) {
        await client.query(
          `UPDATE manifest_revisions SET status='published',
             locked_at=COALESCE(locked_at,now())
           WHERE id=$2 AND manifest_id=$1`,
          [input.manifestId, input.manifestRevisionId],
        );
      }

      if (supportsPublicationReconciliation
        && input.contractRevisionId
        && input.manifestRevisionId) {
        await client.query(
          `UPDATE playlist_publication_reconciliations
           SET state='complete',
               observed_ordered_ids_hash=expected_ordered_ids_hash,
               appended_count=expected_count,batch_cursor=expected_count,
               completed_at=COALESCE(completed_at,now()),updated_at=now(),
               reconciliation_json=reconciliation_json
                 || $4::jsonb
           WHERE run_id=$1 AND contract_revision_id=$2
             AND manifest_id=$3 AND manifest_revision_id=$5
             AND state NOT IN ('cancelled','quarantined')`,
          [
            input.runId,
            input.contractRevisionId,
            input.manifestId,
            JSON.stringify({
              terminalFence: "commit_publication_completion",
              manifestRevisionHash: input.manifestRevisionHash,
              publicationVolumeIds: input.publicationVolumes
                .map(({ publicationVolumeId }) => publicationVolumeId),
            }),
            input.manifestRevisionId,
          ],
        );
      }

      await client.query(
        `UPDATE research_runs SET status=$2,phase=$3,error=NULL,
           completed_at=COALESCE(completed_at,now()),updated_at=now()
         WHERE id=$1`,
        [input.runId, input.terminalStatus, terminalPhase],
      );
    });

    await this.captureTerminalDiagnosticsSafely(input.runId);
    await this.upsertPublicPlaylistDirectoryForRun(input.runId);
  }

  async listPublicationVolumes(manifestId: string, manifestRevisionId?: string | null): Promise<any[]> {
    const result = manifestRevisionId === undefined
      ? await this.pool.query("SELECT * FROM publication_volumes WHERE manifest_id=$1 ORDER BY volume_number", [manifestId])
      : await this.pool.query(
        `SELECT * FROM publication_volumes
         WHERE manifest_id=$1 AND manifest_revision_id IS NOT DISTINCT FROM $2::uuid
         ORDER BY volume_number`,
        [manifestId, manifestRevisionId],
      );
    return result.rows.map((row) => ({
      id: row.id,
      manifestId: row.manifest_id,
      manifestRevisionId: row.manifest_revision_id,
      volumeNumber: row.volume_number,
      volumeCount: row.volume_count,
      startPosition: row.start_position,
      endPosition: row.end_position,
      status: row.status,
      applePlaylistId: row.apple_playlist_id,
      appleShareUrl: row.apple_share_url,
      appendedCount: row.appended_count,
      attempt: row.attempt,
      lastError: sanitizeOptionalFailure(row.last_error, "publication"),
    }));
  }

  async upsertPublicPlaylistDirectoryForRun(
    runId: string,
    options: { listed?: boolean } = {},
  ): Promise<PublicPlaylistDirectoryItem | null> {
    return this.transaction(async (client) => {
      const manifest = await client.query<{
        id: string;
        run_id: string;
        content_hash: string;
        name: string;
        run_status: string;
        track_count: number;
        manifest_revision_id: string | null;
      }>(
        `SELECT m.id,m.run_id,COALESCE(active_revision.content_hash,m.content_hash) content_hash,
           m.name,r.status run_status,active_revision.id manifest_revision_id,
           CASE WHEN active_revision.id IS NULL
             THEN (SELECT count(*)::int FROM manifest_tracks mt WHERE mt.manifest_id=m.id)
             ELSE (SELECT count(*)::int FROM manifest_revision_tracks mrt
                   WHERE mrt.manifest_revision_id=active_revision.id)
           END track_count
         FROM manifests m JOIN research_runs r ON r.id=m.run_id
         LEFT JOIN LATERAL (
           SELECT mr.id,mr.content_hash FROM manifest_revisions mr
           WHERE mr.manifest_id=m.id AND mr.status IN ('locked','published')
           ORDER BY mr.revision DESC LIMIT 1
         ) active_revision ON true
         WHERE m.run_id=$1
         ORDER BY m.created_at DESC,m.id DESC LIMIT 1
         FOR UPDATE OF m,r`,
        [runId],
      );
      const source = manifest.rows[0];
      if (!source || !["complete", "partial"].includes(source.run_status)) return null;

      const title = source.name
        .normalize("NFKC")
        .replace(/[\p{Cc}\p{Cf}]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 240);
      const manifestTrackCount = Number(source.track_count);
      if (!title || !/^[a-f0-9]{64}$/iu.test(source.content_hash) || manifestTrackCount < 1) return null;

      const volumeResult = await client.query<{
        volume_number: number;
        volume_count: number;
        start_position: number;
        end_position: number;
        status: string;
        apple_share_url: string | null;
        appended_count: number;
        published_at: Date | string | null;
      }>(
        `SELECT volume_number,volume_count,start_position,end_position,status,
           apple_share_url,appended_count,published_at
         FROM publication_volumes
         WHERE manifest_id=$1 AND manifest_revision_id IS NOT DISTINCT FROM $2::uuid
         ORDER BY volume_number FOR UPDATE`,
        [source.id, source.manifest_revision_id],
      );
      const volumes = volumeResult.rows;
      const volumeCount = volumes[0]?.volume_count ?? 0;
      const stable = volumeCount > 0
        && volumes.length === volumeCount
        && volumes.every((volume, index) => {
          const expectedTrackCount = volume.end_position - volume.start_position + 1;
          const volumePublishedAt = date(volume.published_at);
          return volume.volume_number === index + 1
            && volume.volume_count === volumeCount
            && expectedTrackCount > 0
            && volume.status === "complete"
            && volume.appended_count === expectedTrackCount
            && volumePublishedAt !== null
            && Number.isFinite(volumePublishedAt.getTime())
            && isStableApplePlaylistShareUrl(volume.apple_share_url);
        })
        && volumes.reduce((sum, volume) => sum + volume.end_position - volume.start_position + 1, 0) === manifestTrackCount;
      if (!stable) return null;

      const publishedAt = new Date(Math.max(...volumes.map((volume) => date(volume.published_at)!.getTime())));
      const shareUrls = volumes.map((volume) => canonicalApplePlaylistShareUrl(volume.apple_share_url!));
      const collision = await client.query(
        `SELECT 1 FROM public_playlist_volumes v
         JOIN public_playlists p ON p.id=v.public_playlist_id
         WHERE v.share_url=ANY($1::text[]) AND p.manifest_hash<>$2 LIMIT 1`,
        [shareUrls, source.content_hash],
      );
      if (collision.rows[0]) return null;
      const directoryId = randomUUID();
      const inserted = await client.query<{ id: string; status: string; hidden_at: Date | string | null }>(
        `INSERT INTO public_playlists(
           id,run_id,manifest_hash,title,track_count,volume_count,status,published_at,hidden_at
         ) VALUES(
           $1,$2,$3,$4,$5,$6,
           CASE WHEN $8::boolean THEN 'listed' ELSE 'hidden' END,
           $7,
           CASE WHEN $8::boolean THEN NULL ELSE now() END
         )
         ON CONFLICT(manifest_hash) DO UPDATE SET
           run_id=EXCLUDED.run_id,title=EXCLUDED.title,track_count=EXCLUDED.track_count,
           volume_count=EXCLUDED.volume_count,
           status=CASE
             WHEN public_playlists.owner_hidden THEN 'hidden'
             WHEN $9::boolean THEN CASE WHEN $8::boolean THEN 'listed' ELSE 'hidden' END
             ELSE public_playlists.status
           END,
           hidden_at=CASE
             WHEN public_playlists.owner_hidden THEN COALESCE(public_playlists.hidden_at,now())
             WHEN $9::boolean AND NOT $8::boolean THEN COALESCE(public_playlists.hidden_at,now())
             WHEN $9::boolean AND $8::boolean THEN NULL
             ELSE public_playlists.hidden_at
           END,
           published_at=EXCLUDED.published_at,updated_at=now()
         RETURNING id,status,hidden_at`,
        [
          directoryId,
          source.run_id,
          source.content_hash,
          title,
          manifestTrackCount,
          volumeCount,
          publishedAt,
          options.listed === true,
          options.listed !== undefined,
        ],
      );
      const publicPlaylistId = inserted.rows[0]!.id;
      await client.query("DELETE FROM public_playlist_volumes WHERE public_playlist_id=$1", [publicPlaylistId]);
      const directoryVolumes = [];
      for (const [index, volume] of volumes.entries()) {
        const trackCount = volume.end_position - volume.start_position + 1;
        const shareUrl = shareUrls[index]!;
        const name = volumeCount === 1
          ? title
          : appendPlaylistTitleSuffix(title, `[${volume.volume_number}/${volumeCount}]`);
        await client.query(
          `INSERT INTO public_playlist_volumes(public_playlist_id,volume_number,name,track_count,share_url)
           VALUES($1,$2,$3,$4,$5)`,
          [publicPlaylistId, volume.volume_number, name, trackCount, shareUrl],
        );
        directoryVolumes.push({
          volumeNumber: volume.volume_number,
          name,
          trackCount,
          shareUrl,
        });
      }
      return {
        id: publicPlaylistId,
        title,
        trackCount: manifestTrackCount,
        volumeCount,
        publishedAt: publishedAt.toISOString(),
        volumes: directoryVolumes,
      };
    });
  }

  async listPublicPlaylists(page = 1, pageSize = 24): Promise<PublicPlaylistDirectoryPage> {
    const safePage = Number.isInteger(page) ? Math.max(1, page) : 1;
    const safePageSize = Number.isInteger(pageSize) ? Math.max(1, Math.min(pageSize, 100)) : 24;
    const eligibleSql = `
      FROM public_playlists p JOIN public_playlist_volumes v ON v.public_playlist_id=p.id
      WHERE p.status='listed' AND p.hidden_at IS NULL
      GROUP BY p.id
      HAVING count(*)=p.volume_count
         AND min(v.volume_number)=1
         AND max(v.volume_number)=p.volume_count
         AND count(DISTINCT v.volume_number)=count(*)
         AND sum(v.track_count)=p.track_count
         AND bool_and(v.share_url ~ '^https://music[.]apple[.]com/[A-Za-z]{2}/playlist/.+/pl[.][A-Za-z0-9._-]+$')`;
    const [countResult, itemResult] = await Promise.all([
      this.pool.query<{ count: number }>(`SELECT count(*)::int count FROM (SELECT p.id ${eligibleSql}) eligible`),
      this.pool.query<{
        id: string;
        title: string;
        track_count: number;
        volume_count: number;
        published_at: Date | string;
        volumes: Array<{ volumeNumber: number; name: string; trackCount: number; shareUrl: string }>;
      }>(
        `SELECT p.id,p.title,p.track_count,p.volume_count,p.published_at,
           json_agg(json_build_object(
             'volumeNumber',v.volume_number,
             'name',v.name,
             'trackCount',v.track_count,
             'shareUrl',v.share_url
           ) ORDER BY v.volume_number) volumes
         ${eligibleSql}
         ORDER BY p.published_at DESC,p.id DESC LIMIT $1 OFFSET $2`,
        [safePageSize, (safePage - 1) * safePageSize],
      ),
    ]);
    const total = Number(countResult.rows[0]?.count ?? 0);
    return {
      items: itemResult.rows.map((row) => ({
        id: row.id,
        title: row.title,
        trackCount: Number(row.track_count),
        volumeCount: Number(row.volume_count),
        publishedAt: date(row.published_at)!.toISOString(),
        volumes: row.volumes.map((volume) => ({
          volumeNumber: Number(volume.volumeNumber),
          name: String(volume.name),
          trackCount: Number(volume.trackCount),
          shareUrl: String(volume.shareUrl),
        })),
      })),
      page: safePage,
      pageSize: safePageSize,
      total,
      totalPages: Math.ceil(total / safePageSize),
    };
  }

  async setPublicPlaylistVisibility(id: string, listed: boolean): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE public_playlists SET
         status=CASE WHEN $2::boolean THEN 'listed' ELSE 'hidden' END,
         owner_hidden=NOT $2::boolean,
         hidden_at=CASE WHEN $2::boolean THEN NULL ELSE now() END,
         updated_at=now()
       WHERE id=$1`,
      [id, listed],
    );
    return Boolean(result.rowCount);
  }

  async bulkHidePublicPlaylists(input: {
    scope: "all_listed" | "ids";
    playlistIds?: readonly string[];
  }): Promise<number> {
    const ids = [...new Set(input.playlistIds ?? [])];
    if (input.scope === "ids" && ids.length === 0) return 0;
    const result = input.scope === "all_listed"
      ? await this.pool.query(
        `UPDATE public_playlists SET status='hidden',owner_hidden=true,
           hidden_at=COALESCE(hidden_at,now()),updated_at=now()
         WHERE status='listed' AND hidden_at IS NULL`,
      )
      : await this.pool.query(
        `UPDATE public_playlists SET status='hidden',owner_hidden=true,
           hidden_at=COALESCE(hidden_at,now()),updated_at=now()
         WHERE id=ANY($1::uuid[]) AND (status<>'hidden' OR owner_hidden=false OR hidden_at IS NULL)`,
        [ids],
      );
    return result.rowCount ?? 0;
  }

  async markPlaylistOrphan(input: { manifestId?: string | null; publicationVolumeId?: string | null; applePlaylistId: string; reason: string }): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      "INSERT INTO orphan_playlists(id,manifest_id,publication_volume_id,apple_playlist_id,reason) VALUES($1,$2,$3,$4,$5)",
      [id, input.manifestId ?? null, input.publicationVolumeId ?? null, input.applePlaylistId, sanitizeFailure(input.reason, "publication")],
    );
    return id;
  }

  async listOrphanPlaylists(): Promise<any[]> {
    const result = await this.pool.query("SELECT * FROM orphan_playlists WHERE cleaned_at IS NULL ORDER BY created_at DESC");
    return result.rows.map((row) => ({
      ...row,
      reason: sanitizeFailure(row.reason, "publication"),
    }));
  }

  async listWaitingPublicationManifests(): Promise<Array<{ manifestId: string; runId: string }>> {
    const result = await this.pool.query<{ id: string; run_id: string }>(
      `SELECT DISTINCT ON (m.run_id) m.id,m.run_id FROM manifests m
       JOIN research_runs r ON r.id=m.run_id
       WHERE r.status='waiting_for_apple_authorization' AND r.deleted_at IS NULL
       ORDER BY m.run_id,m.created_at DESC`,
    );
    return result.rows.map((row) => ({ manifestId: row.id, runId: row.run_id }));
  }

  /**
   * Queue one publication recovery for this exact authorization-validation
   * epoch. Completed, cancelled, and terminally failed recoveries are never
   * revived by a heartbeat; a later successful reauthorization uses a new
   * epoch and therefore a new durable job.
   */
  async enqueueWaitingPublicationRecovery(input: {
    manifestId: string;
    runId: string;
    dedupeKey: string;
  }): Promise<boolean> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO job_queue(id,run_id,kind,dedupe_key,payload_json,max_attempts)
       SELECT $1,m.run_id,'publication',$4,$5,6
       FROM manifests m JOIN research_runs r ON r.id=m.run_id
       WHERE m.id=$2 AND m.run_id=$3 AND r.status='waiting_for_apple_authorization' AND r.deleted_at IS NULL
       ON CONFLICT(kind,dedupe_key) DO NOTHING RETURNING id`,
      [randomUUID(), input.manifestId, input.runId, input.dedupeKey.slice(0, 160), { manifestId: input.manifestId }],
    );
    return Boolean(result.rowCount);
  }

  /**
   * Atomically transitions a locked manifest into publication and creates its
   * durable job. The run row is the serialization boundary, so a retry that
   * races with the worker can never move a terminal run back to `publishing`.
   */
  async queueManifestPublication(input: {
    runId: string;
    manifestId: string;
    appleAuthorized: boolean;
    clientBucket: string;
    clientBucketAliases: string[];
    rateLimit?: number;
  }): Promise<PublicationQueueResult> {
    // Refuse a short manifest before it can even enter the Apple write queue.
    // The publisher repeats this check immediately before every write because
    // preflight can create a successor revision after an Apple ID disappears.
    const lockedManifest = await this.getManifestById(input.manifestId);
    if (!lockedManifest || lockedManifest.runId !== input.runId) {
      throw new HttpError(409, "Lock a manifest before publishing", "manifest_not_ready");
    }
    const guard = await this.getPublicationGuard({
      runId: input.runId,
      manifestId: lockedManifest.id,
      manifestRevisionId: lockedManifest.revisionId ?? null,
      manifestRevisionHash: lockedManifest.contentHash,
      selectedCount: lockedManifest.tracks.length,
    });
    const target = guard.requestedTrackCount;
    if (guard.enforcement === "required") {
      if (!Number.isInteger(target)
        || target === null
        || target < 1
        || target > EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS) {
        throw new HttpError(409, "The immutable playlist target is unavailable", "publication_integrity_error");
      }
      if (lockedManifest.tracks.length > target) {
        throw new HttpError(409, "The manifest exceeds the immutable playlist target", "publication_integrity_error");
      }
      if (lockedManifest.tracks.length < target) {
        const decision = guard.decision;
        const expiresAt = decision ? new Date(decision.expiresAt).getTime() : Number.NaN;
        const validDecision = decision?.decision === "accepted"
          && Boolean(lockedManifest.revisionId)
          && decision.manifestRevisionId === lockedManifest.revisionId
          && decision.manifestRevisionHash === lockedManifest.contentHash
          && decision.targetCount === target
          && decision.selectedCount === lockedManifest.tracks.length
          && typeof guard.currentOutcomeHash === "string"
          && guard.currentOutcomeHash.length > 0
          && decision.outcomeHash === guard.currentOutcomeHash
          && Number.isFinite(expiresAt)
          && expiresAt > Date.now();
        if (!validDecision) {
          throw new HttpError(
            409,
            `${lockedManifest.tracks.length} verified tracks are ready; confirm the partial playlist before publishing`,
            "partial_publication_decision_required",
          );
        }
      }
    }
    return this.transaction(async (client) => {
      const runResult = await client.query<{ status: string; phase: string }>(
        "SELECT status,phase FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [input.runId],
      );
      const run = runResult.rows[0];
      if (!run) throw new HttpError(404, "Research run not found", "run_not_found");

      const manifest = await client.query<{ id: string }>(
        "SELECT id FROM manifests WHERE id=$1 AND run_id=$2",
        [input.manifestId, input.runId],
      );
      if (!manifest.rows[0]) throw new HttpError(409, "Lock a manifest before publishing", "manifest_not_ready");

      const dedupeKey = `publication:${input.manifestId}`;
      const existingJob = await client.query<{ id: string; status: string }>(
        `SELECT id,status FROM job_queue
         WHERE kind='publication' AND run_id=$1 AND payload_json->>'manifestId'=$2
         ORDER BY CASE
           WHEN status IN ('queued','retry','leased') THEN 0
           WHEN status IN ('failed','cancelled') THEN 1
           ELSE 2 END,created_at DESC
         LIMIT 1 FOR UPDATE`,
        [input.runId, input.manifestId],
      );
      const job = existingJob.rows[0] ?? null;

      if (["complete", "partial"].includes(run.status)) {
        return { queued: false, state: "terminal", runStatus: run.status, jobId: job?.id ?? null };
      }
      if (run.status === "waiting_for_apple_authorization") {
        return {
          queued: false,
          state: "waiting_for_apple_authorization",
          runStatus: run.status,
          jobId: job?.id ?? null,
        };
      }
      if (job && ["queued", "retry", "leased"].includes(job.status)) {
        if (run.status !== "publishing") {
          await client.query(
            "UPDATE research_runs SET status='publishing',phase='publication_queued',error=NULL,completed_at=NULL,updated_at=now() WHERE id=$1",
            [input.runId],
          );
        }
        return { queued: false, state: "in_flight", runStatus: "publishing", jobId: job.id };
      }
      if (job?.status === "complete") {
        // A completed worker job must have committed the terminal run state
        // first. Refuse to regress an inconsistent legacy row; the health and
        // owner surfaces can expose it for repair without creating duplicates.
        throw new HttpError(409, "Publication already completed; refresh the run result", "publication_already_complete");
      }

      if (!input.appleAuthorized) {
        await client.query(
          "UPDATE research_runs SET status='waiting_for_apple_authorization',phase='apple_authorization',error=NULL,completed_at=NULL,updated_at=now() WHERE id=$1",
          [input.runId],
        );
        return {
          queued: false,
          state: "waiting_for_apple_authorization",
          runStatus: "waiting_for_apple_authorization",
          jobId: job?.id ?? null,
        };
      }

      const retryableFailure = run.status === "failed" && run.phase === "publication_failed";
      if (run.status !== "manifest_ready" && run.status !== "publishing" && !retryableFailure) {
        throw new HttpError(409, "Run is not ready for publication", "publication_not_ready");
      }

      const aliases = [...new Set(input.clientBucketAliases)].sort();
      await lockClientAliases(client, "rate:publish", aliases);
      const rate = await client.query<{ count: number }>(
        "SELECT count(*)::int count FROM rate_limit_events WHERE client_bucket=ANY($1::text[]) AND action='publish' AND occurred_at>now()-interval '24 hours'",
        [aliases],
      );
      if (rate.rows[0]!.count >= (input.rateLimit ?? 10)) {
        throw new HttpError(429, "Publication limit reached; try again later", "rate_limited");
      }

      const jobId = job?.id ?? randomUUID();
      if (job) {
        await client.query(
          `UPDATE job_queue SET run_id=$2,payload_json=$3,status='queued',attempts=0,max_attempts=6,
             available_at=now(),lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,completed_at=NULL,updated_at=now()
           WHERE id=$1 AND status IN ('failed','cancelled')`,
          [jobId, input.runId, { runId: input.runId, manifestId: input.manifestId }],
        );
      } else {
        await client.query(
          `INSERT INTO job_queue(id,run_id,kind,dedupe_key,payload_json,max_attempts)
           VALUES($1,$2,'publication',$3,$4,6)`,
          [jobId, input.runId, dedupeKey, { runId: input.runId, manifestId: input.manifestId }],
        );
      }
      await client.query("INSERT INTO rate_limit_events(client_bucket,action) VALUES($1,'publish')", [input.clientBucket]);
      await client.query(
        "UPDATE research_runs SET status='publishing',phase='publication_queued',error=NULL,completed_at=NULL,updated_at=now() WHERE id=$1",
        [input.runId],
      );
      return { queued: true, state: "queued", runStatus: "publishing", jobId };
    });
  }

  /**
   * Deterministically accepts the primary Apple match for every recommended
   * candidate, locks the exact manifest, and hands only that manifest to the
   * isolated publication worker. This is the durable server-side continuation
   * for One Command runs, so closing the browser cannot interrupt publication.
   */
  async queueAutomaticPublication(runId: string): Promise<void> {
    let manifest: Awaited<ReturnType<Repository["finalizeCatalogSelection"]>>;
    try {
      manifest = await this.finalizeCatalogSelection(runId, {
        useRecommended: true,
        excludedCandidateIds: [],
        overrides: [],
        automatic: true,
      });
    } catch (error) {
      if (error instanceof HttpError && error.code === "empty_manifest") {
        const run = await this.getRunRow(runId);
        const plan = run?.selection_plan_json as SelectionPlan | null | undefined;
        if (run && plan && run.pipeline_version !== "legacy_v1") {
          // Catalog identity and manifest eligibility are deliberately separate
          // in V2. An exact Apple match can still fail a non-relaxable scope,
          // evidence, content, or version rule. That is a valid zero-result
          // completeness outcome, not an operational publication failure.
          const stageCounts = await this.getPipelineStageCounts(runId);
          const discoveredTrackCount = Number(stageCounts.discovered ?? 0);
          const qualifiedTrackCount = Math.min(
            discoveredTrackCount,
            Number(stageCounts.claim_verified ?? stageCounts.scope_qualified ?? 0),
          );
          await this.pool.query(
            `WITH rejected AS (
               UPDATE catalog_matches SET status='unsupported',
                 basis='Pipeline V2 manifest eligibility rejected every catalog match',
                 reviewed_at=now()
               WHERE run_id=$1 AND status='accepted'
               RETURNING candidate_id
             )
             UPDATE track_candidates SET outcome='unsupported'
             WHERE run_id=$1 AND id IN (SELECT candidate_id FROM rejected)`,
            [runId],
          );
          const outcome = buildPipelineOutcome({
            pipelineVersion: plan.pipelineVersion,
            policyVersion: plan.policyVersion,
            status: "no_compatible_tracks",
            targetTrackCount: plan.requestedTrackCount,
            discoveredTrackCount,
            qualifiedTrackCount,
            selectedTrackCount: 0,
            publishedTrackCount: 0,
            frontierExhausted: true,
            reasonCodes: ["manifest_hard_constraints_rejected_all"],
            stageCounts,
          });
          await this.savePipelineOutcome(runId, outcome);
          await this.savePipelineDeficitLedger(runId, outcome.deficits, {
            pipelineVersion: plan.pipelineVersion,
            policyVersion: plan.policyVersion,
            mode: "append",
          });
          await this.updateRun(runId, {
            status: "no_compatible_tracks",
            phase: "manifest_policy_empty",
            error: null,
          });
          return;
        }
      }
      throw error;
    }
    const run = await this.getRunRow(runId);
    if (!run) throw new HttpError(404, "Research run not found", "run_not_found");
    const publicationManifest = await this.getManifestById(manifest.id);
    if (!publicationManifest) {
      throw new HttpError(409, "The locked manifest is no longer available", "manifest_not_found");
    }
    const publicationGuard = await this.getPublicationGuard({
      runId,
      manifestId: publicationManifest.id,
      manifestRevisionId: publicationManifest.revisionId ?? null,
      manifestRevisionHash: publicationManifest.contentHash,
      selectedCount: publicationManifest.tracks.length,
    });
    if (publicationGuard.enforcement === "required"
      && publicationGuard.requestedTrackCount !== null
      && publicationManifest.tracks.length < publicationGuard.requestedTrackCount
      && publicationGuard.decision === null) {
      await this.preparePartialPublication(runId, {
        targetTrackCount: publicationGuard.requestedTrackCount,
        verifiedTrackCount: publicationManifest.tracks.length,
        remainingStrategyCount: 0,
      });
      return;
    }
    const apple = await this.getAppleAuthorization();
    const publication = await this.queueManifestPublication({
      runId,
      manifestId: manifest.id,
      appleAuthorized: apple?.status === "valid",
      clientBucket: run.client_bucket,
      clientBucketAliases: [run.client_bucket],
      // Automatic runs are already admitted by the global-capacity and budget
      // gates. Reapplying the manual 10/day publication bucket would strand a
      // completed research run after manifest lock without adding abuse value.
      rateLimit: Number.POSITIVE_INFINITY,
    });
    if (publication.state === "waiting_for_apple_authorization") {
      await this.enqueueNotification("apple_reauthorization_required", {
        deduplicationKey: `apple-reauthorization:${manifest.id}`,
        runId,
        manifestId: manifest.id,
      });
    }
  }

  /**
   * Freeze the verified Apple-selection outcome for a below-target automatic
   * run without authorizing an Apple write. The visitor may continue research
   * while no manifest exists; confirmation later locks a manifest and binds
   * consent to both the outcome and manifest hashes.
   */
  async preparePartialPublication(
    runId: string,
    input: {
      targetTrackCount: number;
      verifiedTrackCount: number;
      remainingStrategyCount?: number;
    },
  ): Promise<void> {
    const targetTrackCount = Math.max(1, Math.floor(input.targetTrackCount));
    await this.transaction(async (client) => {
      const run = await client.query<{ status: string }>(
        "SELECT status FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [runId],
      );
      if (!run.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
      if (["publishing", "complete", "partial"].includes(run.rows[0].status)) {
        throw new HttpError(409, "Playlist publication has already started", "publication_already_started");
      }
      const selection = await client.query<{ candidate_id: string; catalog_id: string }>(
        `SELECT candidate_id,catalog_id FROM catalog_matches
         WHERE run_id=$1 AND status='accepted' AND catalog_id IS NOT NULL
         ORDER BY candidate_id,catalog_id`,
        [runId],
      );
      const verifiedTrackCount = Math.max(0, Math.min(
        selection.rows.length,
        Math.floor(input.verifiedTrackCount),
      ));
      const prior = await client.query<{ state_json: Record<string, unknown> }>(
        "SELECT state_json FROM research_checkpoints WHERE run_id=$1 AND phase='partial_ready' FOR UPDATE",
        [runId],
      );
      const priorVersion = Number(prior.rows[0]?.state_json?.outcomeVersion ?? 0);
      const outcomeVersion = Number.isSafeInteger(priorVersion) && priorVersion >= 0
        ? priorVersion + 1
        : 1;
      const remainingStrategyCount = Math.max(0, Math.floor(input.remainingStrategyCount ?? 0));
      const outcomeHash = sha256Hex(stableStringify({
        runId,
        outcomeVersion,
        targetTrackCount,
        tracks: selection.rows.map((row) => [row.candidate_id, row.catalog_id]),
      }));
      await client.query(
        `INSERT INTO research_checkpoints(run_id,phase,state_json) VALUES($1,'partial_ready',$2::jsonb)
         ON CONFLICT(run_id,phase) DO UPDATE SET state_json=EXCLUDED.state_json,updated_at=now()`,
        [runId, JSON.stringify({
          outcomeHash,
          outcomeVersion,
          targetTrackCount,
          verifiedTrackCount,
          shortfall: Math.max(0, targetTrackCount - verifiedTrackCount),
          remainingStrategyCount,
          continueAvailable: remainingStrategyCount > 0,
          preparedAt: new Date().toISOString(),
        })],
      );
      await client.query(
        `UPDATE research_runs SET status='partial_ready',phase='partial_confirmation_required',
           error=NULL,completed_at=NULL,updated_at=now() WHERE id=$1`,
        [runId],
      );
    });
  }

  /**
   * Convert a capability-confirmed shortfall into a locked, hash-bound
   * publication decision. No caller may infer consent from a button click
   * alone: the current partial outcome, immutable manifest revision, and
   * capability session are all persisted before publication can be queued.
   */
  async confirmPartialPublication(input: {
    runId: string;
    capabilitySessionId: string;
    idempotencyKey: string;
    outcomeHash: string;
    manifestId?: string | null;
    manifestHash?: string | null;
  }): Promise<any> {
    const existing = await this.pool.query<{
      run_id: string;
      manifest_id: string;
      manifest_revision_id: string;
      outcome_hash: string;
      manifest_revision_hash: string;
      capability_session_id: string | null;
      target_count: number;
      selected_count: number;
      expires_at: Date;
    }>(
      `SELECT d.run_id,mr.manifest_id,d.manifest_revision_id,d.outcome_hash,
              d.manifest_revision_hash,d.capability_session_id,d.target_count,
              d.selected_count,d.expires_at
       FROM partial_publication_decisions d
       JOIN manifest_revisions mr ON mr.id=d.manifest_revision_id
       WHERE d.idempotency_key=$1 AND d.decision='publish_partial'`,
      [input.idempotencyKey],
    ).catch(() => ({ rows: [] as Array<{
      run_id: string;
      manifest_id: string;
      manifest_revision_id: string;
      outcome_hash: string;
      manifest_revision_hash: string;
      capability_session_id: string | null;
      target_count: number;
      selected_count: number;
      expires_at: Date;
    }> }));
    if (existing.rows[0]) {
      const prior = existing.rows[0];
      if (prior.run_id !== input.runId
        || prior.capability_session_id !== input.capabilitySessionId
        || prior.outcome_hash !== input.outcomeHash
        || (input.manifestId && input.manifestId !== prior.manifest_id)
        || (input.manifestHash && input.manifestHash !== prior.manifest_revision_hash)) {
        throw new HttpError(409, "Idempotency key was used for another partial playlist result", "idempotency_conflict");
      }
      if (prior.expires_at.getTime() <= Date.now()) {
        throw new HttpError(409, "The partial publication decision has expired", "partial_decision_expired");
      }
      return this.getManifestById(prior.manifest_id);
    }

    const checkpointValue = await this.getResearchCheckpoint(input.runId, "partial_ready");
    const checkpoint = requireCurrentPartialOutcome({
      checkpoint: checkpointValue,
      outcomeHash: input.outcomeHash,
    });
    let manifest = await this.getLatestManifestForRun(input.runId);
    if (!manifest) {
      const prepared = await this.pool.query(
        `UPDATE research_runs SET status='visitor_review',phase='partial_manifest_locking',
           error=NULL,updated_at=now()
         WHERE id=$1 AND status IN ('partial_ready','needs_decision')`,
        [input.runId],
      );
      if (!prepared.rowCount) {
        throw new HttpError(409, "The partial playlist is no longer ready", "partial_outcome_not_ready");
      }
      manifest = await this.finalizeCatalogSelection(input.runId, {
        useRecommended: true,
        excludedCandidateIds: [],
        overrides: [],
        automatic: true,
      });
      manifest = await this.getManifestById(manifest.id);
    }
    if (!manifest?.revisionId || !manifest?.contentHash || !Array.isArray(manifest.tracks)) {
      throw new HttpError(409, "The partial manifest revision is not ready", "manifest_revision_not_ready");
    }
    if (input.manifestId && input.manifestId !== manifest.id) {
      throw new HttpError(409, "The playlist result changed; review the latest result", "partial_outcome_stale");
    }
    if (input.manifestHash && input.manifestHash !== manifest.contentHash) {
      throw new HttpError(409, "The playlist result changed; review the latest result", "partial_outcome_stale");
    }
    const checkpointRecord = checkpointValue && typeof checkpointValue === "object" && !Array.isArray(checkpointValue)
      ? checkpointValue as Record<string, unknown>
      : null;
    if ((typeof checkpointRecord?.manifestId === "string" && checkpointRecord.manifestId !== manifest.id)
      || (typeof checkpointRecord?.manifestRevisionId === "string" && checkpointRecord.manifestRevisionId !== manifest.revisionId)
      || (typeof checkpointRecord?.manifestHash === "string" && checkpointRecord.manifestHash !== manifest.contentHash)) {
      throw new HttpError(409, "The playlist result changed; review the latest result", "partial_outcome_stale");
    }
    if (manifest.tracks.length !== checkpoint.verifiedTrackCount) {
      const outcomeVersion = checkpoint.outcomeVersion + 1;
      const outcomeHash = sha256Hex(stableStringify({
        runId: input.runId,
        outcomeVersion,
        targetTrackCount: checkpoint.targetTrackCount,
        manifestId: manifest.id,
        manifestHash: manifest.contentHash,
        tracks: manifest.tracks.map((track: { candidateId: string; catalogId: string }) => (
          [track.candidateId, track.catalogId]
        )),
      }));
      await this.saveResearchCheckpoint(input.runId, "partial_ready", {
        ...checkpoint,
        outcomeHash,
        outcomeVersion,
        verifiedTrackCount: manifest.tracks.length,
        shortfall: checkpoint.targetTrackCount - manifest.tracks.length,
        continueAvailable: false,
        remainingStrategyCount: 0,
        manifestId: manifest.id,
        manifestHash: manifest.contentHash,
        preparedAt: new Date().toISOString(),
      });
      await this.updateRun(input.runId, {
        status: "partial_ready",
        phase: "partial_confirmation_required",
        error: null,
      });
      throw new HttpError(409, "The verified track count changed; review the latest result", "partial_outcome_stale");
    }

    await this.transaction(async (client) => {
      const lockedRun = await client.query<{ status: string }>(
        "SELECT status FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [input.runId],
      );
      if (!lockedRun.rows[0]
        || !["manifest_ready", "partial_ready", "needs_decision"].includes(lockedRun.rows[0].status)) {
        throw new HttpError(409, "The partial playlist is no longer ready", "partial_outcome_not_ready");
      }
      if (lockedRun.rows[0].status === "needs_decision") {
        const decisionState = await client.query<{ state_json: unknown }>(
          `SELECT state_json FROM research_checkpoints
           WHERE run_id=$1 AND phase='run_decision' FOR UPDATE`,
          [input.runId],
        );
        const decision = publicAdaptiveRunDecisionV1(decisionState.rows[0]?.state_json);
        if (!decision
          || !decision.actions.publishVerifiedPartial
          || decision.verifiedTrackCount !== checkpoint.verifiedTrackCount
          || decision.targetTrackCount !== checkpoint.targetTrackCount) {
          throw new HttpError(
            409,
            "This research boundary does not permit partial publication",
            "partial_publication_not_permitted",
          );
        }
      }
      const currentCheckpoint = await client.query<{ state_json: unknown }>(
        "SELECT state_json FROM research_checkpoints WHERE run_id=$1 AND phase='partial_ready' FOR UPDATE",
        [input.runId],
      );
      requireCurrentPartialOutcome({
        checkpoint: currentCheckpoint.rows[0]?.state_json,
        outcomeHash: checkpoint.outcomeHash,
        outcomeVersion: checkpoint.outcomeVersion,
      });
      const session = await client.query(
        `SELECT 1 FROM capability_sessions s
         JOIN capability_session_accesses a ON a.session_id=s.id AND a.run_id=$2
         WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at>now() LIMIT 1`,
        [input.capabilitySessionId, input.runId],
      );
      if (!session.rows[0]) throw new HttpError(401, "Session has expired", "capability_required");
      const schema = await client.query<{ value: string }>(
        "SELECT value FROM settings WHERE key='schema_version'",
      );
      if (Number(schema.rows[0]?.value ?? 0) >= 14) {
        const activePlan = await client.query<{ query_plan_revision_id: string }>(
          "SELECT query_plan_revision_id FROM run_active_query_plans WHERE run_id=$1",
          [input.runId],
        );
        const insertedDecision = await client.query<{ id: string }>(
          `INSERT INTO partial_publication_decisions(
             id,run_id,manifest_revision_id,manifest_revision_hash,query_plan_revision_id,
             capability_session_id,outcome_hash,decision,target_count,selected_count,
             idempotency_key,expires_at,decided_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,'publish_partial',$8,$9,$10,$11,now())
           ON CONFLICT DO NOTHING RETURNING id`,
          [
            randomUUID(), input.runId, manifest.revisionId, manifest.contentHash,
            activePlan.rows[0]?.query_plan_revision_id ?? null,
            input.capabilitySessionId, checkpoint.outcomeHash,
            checkpoint.targetTrackCount, manifest.tracks.length,
            input.idempotencyKey, partialDecisionExpiresAt(),
          ],
        );
        if (!insertedDecision.rows[0]) {
          const conflicting = await client.query<{
            run_id: string;
            manifest_revision_id: string;
            manifest_revision_hash: string;
            capability_session_id: string | null;
            outcome_hash: string;
            target_count: number;
            selected_count: number;
            expires_at: Date;
          }>(
            `SELECT run_id,manifest_revision_id,manifest_revision_hash,
                    capability_session_id,outcome_hash,target_count,selected_count,expires_at
             FROM partial_publication_decisions
             WHERE idempotency_key=$1
                OR (manifest_revision_id=$2 AND outcome_hash=$3 AND decision='publish_partial')
             ORDER BY (idempotency_key=$1) DESC
             LIMIT 1 FOR UPDATE`,
            [input.idempotencyKey, manifest.revisionId, checkpoint.outcomeHash],
          );
          const prior = conflicting.rows[0];
          if (!prior
            || prior.run_id !== input.runId
            || prior.manifest_revision_id !== manifest.revisionId
            || prior.manifest_revision_hash !== manifest.contentHash
            || prior.capability_session_id !== input.capabilitySessionId
            || prior.outcome_hash !== checkpoint.outcomeHash
            || Number(prior.target_count) !== checkpoint.targetTrackCount
            || Number(prior.selected_count) !== manifest.tracks.length) {
            throw new HttpError(409, "Idempotency key was used for another partial playlist result", "idempotency_conflict");
          }
          if (prior.expires_at.getTime() <= Date.now()) {
            throw new HttpError(409, "The partial publication decision has expired", "partial_decision_expired");
          }
        }
      } else {
        await client.query(
          `INSERT INTO research_checkpoints(run_id,phase,state_json)
           VALUES($1,'partial_publication_consent',$2::jsonb)
           ON CONFLICT(run_id,phase) DO UPDATE SET state_json=EXCLUDED.state_json,updated_at=now()`,
          [input.runId, JSON.stringify({
            decision: "confirmed",
            capabilitySessionId: input.capabilitySessionId,
            outcomeHash: checkpoint.outcomeHash,
            manifestId: manifest.id,
            manifestRevisionId: manifest.revisionId,
            manifestHash: manifest.contentHash,
            targetTrackCount: checkpoint.targetTrackCount,
            selectedTrackCount: manifest.tracks.length,
            idempotencyKey: input.idempotencyKey,
            expiresAt: partialDecisionExpiresAt().toISOString(),
          })],
        );
      }
      if (Number(schema.rows[0]?.value ?? 0) >= 18) {
        const consentHash = sha256Hex(stableStringify({
          decision: "publish_partial",
          runId: input.runId,
          capabilitySessionId: input.capabilitySessionId,
          outcomeHash: checkpoint.outcomeHash,
          manifestId: manifest.id,
          manifestRevisionId: manifest.revisionId,
          manifestRevisionHash: manifest.contentHash,
          targetTrackCount: checkpoint.targetTrackCount,
          selectedTrackCount: manifest.tracks.length,
          idempotencyKey: input.idempotencyKey,
        }));
        const bound = await client.query(
          `UPDATE manifests SET partial_consent_answer_hash=$2
           WHERE id=$1
             AND (
               partial_consent_answer_hash IS NULL
               OR partial_consent_answer_hash=$2
             )`,
          [manifest.id, consentHash],
        );
        if ((bound.rowCount ?? 0) !== 1) {
          throw new HttpError(
            409,
            "Partial publication consent conflicts with the locked manifest",
            "partial_outcome_stale",
          );
        }
      }
      await client.query(
        "UPDATE research_runs SET status='manifest_ready',phase='partial_confirmed',error=NULL,updated_at=now() WHERE id=$1",
        [input.runId],
      );
      await client.query(
        `UPDATE playlist_run_blockers SET resolved_at=now(),updated_at=now()
         WHERE run_id=$1 AND blocker_kind='scope_decision' AND resolved_at IS NULL`,
        [input.runId],
      );
    });
    return manifest;
  }

  /**
   * Consume one server-approved continuation strategy. The public request can
   * select only the frozen outcome version; the durable checkpoint owns the
   * job kind and payload so a visitor cannot manufacture research work.
   */
  async continuePartialResearch(input: {
    runId: string;
    outcomeVersion: number;
    idempotencyKey: string;
    decisionHash?: string | null;
  }): Promise<{ queued: boolean }> {
    return this.transaction(async (client) => {
      const run = await client.query<{
        status: string;
        phase: string;
        pipeline_version: PipelineVersion;
        active_playlist_contract_revision_id: string | null;
      }>(
        `SELECT status,phase,pipeline_version,active_playlist_contract_revision_id
         FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [input.runId],
      );
      if (!run.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
      const activeComputeDecision = run.rows[0].status === "needs_decision"
        && run.rows[0].phase === "active_compute_limit_reached";
      let runDecision: ReturnType<typeof publicAdaptiveRunDecisionV1> = null;
      if (activeComputeDecision) {
        const decisionCheckpoint = await client.query<{ state_json: unknown }>(
          `SELECT state_json FROM research_checkpoints
           WHERE run_id=$1 AND phase='run_decision' FOR UPDATE`,
          [input.runId],
        );
        runDecision = publicAdaptiveRunDecisionV1(
          decisionCheckpoint.rows[0]?.state_json,
        );
        if (!runDecision
          || runDecision.reason !== "active_compute_limit"
          || !runDecision.actions.anotherBoundedPass
          || input.decisionHash !== runDecision.decisionHash
          || run.rows[0].active_playlist_contract_revision_id === null) {
          throw new HttpError(
            409,
            "The bounded research decision changed; review the latest options",
            "run_decision_stale",
          );
        }
      }
      const prior = await client.query<{ state_json: Record<string, unknown> }>(
        "SELECT state_json FROM research_checkpoints WHERE run_id=$1 AND phase='partial_research_continuation' FOR UPDATE",
        [input.runId],
      );
      const priorState = prior.rows[0]?.state_json;
      if (priorState?.idempotencyKey === input.idempotencyKey
        && Number(priorState?.outcomeVersion) === input.outcomeVersion) {
        return { queued: true };
      }
      if (priorState) {
        throw new HttpError(
          409,
          "The approved continuation strategy has already been consumed",
          "research_continuation_already_used",
        );
      }
      if (run.rows[0].status !== "partial_ready" && !activeComputeDecision) {
        throw new HttpError(409, "The partial playlist is no longer awaiting a decision", "partial_outcome_not_ready");
      }
      const current = await client.query<{ state_json: unknown }>(
        "SELECT state_json FROM research_checkpoints WHERE run_id=$1 AND phase='partial_ready' FOR UPDATE",
        [input.runId],
      );
      const checkpoint = requireCurrentPartialOutcome({
        checkpoint: current.rows[0]?.state_json,
        outcomeVersion: input.outcomeVersion,
      });
      if (!checkpoint.continueAvailable) {
        throw new HttpError(409, "No additional approved research strategy remains", "research_frontier_exhausted");
      }
      const raw = current.rows[0]?.state_json as Record<string, unknown>;
      if (run.rows[0].pipeline_version === "corpus_first_v3") {
        const strategyIds = Array.isArray(raw.continuationStrategyIds)
          ? [...new Set(raw.continuationStrategyIds.filter((value): value is string => (
              typeof value === "string" && /^[A-Za-z0-9._:-]{1,160}$/u.test(value)
            )))]
          : [];
        if (strategyIds.length === 0
          || strategyIds.length !== checkpoint.remainingStrategyCount) {
          throw new HttpError(
            409,
            "No additional approved research strategy remains",
            "research_frontier_exhausted",
          );
        }
        const active = await client.query<{
          id: string;
          revision: number;
          selection_plan_id: string;
          graph_snapshot_id: string;
          engine: string;
          status: string;
          plan_hash: string;
          plan_json: unknown;
        }>(
          `SELECT q.id,q.revision,q.selection_plan_id,q.graph_snapshot_id,q.engine,q.status,
                  q.plan_hash,q.plan_json
           FROM run_active_query_plans active
           JOIN query_plan_revisions q ON q.id=active.query_plan_revision_id
           WHERE active.run_id=$1
           FOR UPDATE OF active,q`,
          [input.runId],
        );
        const source = active.rows[0];
        if (!source || source.status !== "active" || !isQueryPlanV3(source.plan_json)
          || queryPlanV3Hash(source.plan_json) !== source.plan_hash) {
          throw new HttpError(409, "The active research plan failed integrity validation", "v3_query_plan_integrity");
        }
        const sourceStageKey = `v3-retrieval:active:${source.plan_hash.slice(0, 48)}`;
        if (raw.queryPlanRevisionId !== source.id
          || raw.queryPlanHash !== source.plan_hash
          || raw.stageKey !== sourceStageKey) {
          throw new HttpError(
            409,
            "The playlist result changed; review the latest result",
            "partial_outcome_stale",
          );
        }
        const successorPlan: QueryPlanV3 = {
          ...source.plan_json,
          continuation: {
            sourceQueryPlanRevisionId: source.id,
            sourceQueryPlanHash: source.plan_hash,
            sourceStageKey,
            sourceOutcomeHash: checkpoint.outcomeHash,
            sourceOutcomeVersion: checkpoint.outcomeVersion,
            strategyIds,
          },
        };
        if (!isQueryPlanV3(successorPlan)) {
          throw new HttpError(409, "The approved continuation strategy is invalid", "research_strategy_invalid");
        }
        const successorHash = queryPlanV3Hash(successorPlan);
        const successorId = randomUUID();
        const successorStageKey = `v3-retrieval:active:${successorHash.slice(0, 48)}`;
        await client.query(
          `INSERT INTO query_plan_revisions(
             id,run_id,selection_plan_id,revision,parent_revision_id,graph_snapshot_id,
             engine,status,plan_hash,plan_json,pipeline_version,policy_version,activated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$9::jsonb,
             'corpus_first_v3','corpus_first_v3_policy_v1',now())`,
          [
            successorId,
            input.runId,
            source.selection_plan_id,
            source.revision + 1,
            source.id,
            source.graph_snapshot_id,
            source.engine,
            successorHash,
            JSON.stringify(successorPlan),
          ],
        );
        await client.query(
          `UPDATE run_active_query_plans
           SET query_plan_revision_id=$2,activated_at=now() WHERE run_id=$1`,
          [input.runId, successorId],
        );
        await client.query(
          "UPDATE query_plan_revisions SET status='superseded' WHERE id=$1 AND status='active'",
          [source.id],
        );
        const jobId = randomUUID();
        const dedupeKey = `v3-partial-continue:${input.runId}:${checkpoint.outcomeVersion}:${successorHash}`;
        const queueClass: JobQueueClass = isDeepQueryPlan(successorPlan) ? "deep" : "interactive";
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO job_queue(
             id,run_id,kind,dedupe_key,payload_json,max_attempts,pipeline_version,
             minimum_worker_protocol,query_plan_revision_id,stage_key,queue_class)
           VALUES($1,$2,'research',$3,$4::jsonb,10,'corpus_first_v3',$5,$6,$7,$8)
           ON CONFLICT(kind,dedupe_key) DO NOTHING RETURNING id`,
          [
            jobId,
            input.runId,
            dedupeKey,
            JSON.stringify({
              runId: input.runId,
              phase: "v3_continuing_research",
              v3ExecutionMode: "active",
              stageExecutionKey: successorStageKey,
              continuationOutcomeHash: checkpoint.outcomeHash,
            }),
            minimumWorkerProtocolForQueryPlan(successorPlan),
            successorId,
            successorStageKey,
            queueClass,
          ],
        );
        if (!inserted.rows[0]) {
          throw new HttpError(409, "The continuation job could not be created", "research_continuation_conflict");
        }
        if (activeComputeDecision && runDecision) {
          const contractRevisionId = run.rows[0].active_playlist_contract_revision_id!;
          const extension = await client.query<{ state_json: Record<string, unknown> }>(
            `SELECT state_json FROM research_checkpoints
             WHERE run_id=$1 AND phase='active_compute_extension' FOR UPDATE`,
            [input.runId],
          );
          if (extension.rows[0]) {
            throw new HttpError(
              409,
              "The bounded research extension has already been used",
              "active_compute_extension_used",
            );
          }
          await client.query(
            `INSERT INTO research_checkpoints(run_id,phase,state_json)
             VALUES($1,'active_compute_extension',$2::jsonb)`,
            [input.runId, JSON.stringify({
              schemaVersion: "genio-active-compute-extension/v1",
              contractRevisionId,
              extensions: 1,
              additionalComputeMs: ACTIVE_COMPUTE_EXTENSION_MS_V1,
              decisionHash: runDecision.decisionHash,
              outcomeHash: checkpoint.outcomeHash,
              outcomeVersion: checkpoint.outcomeVersion,
              idempotencyKey: input.idempotencyKey,
              approvedAt: new Date().toISOString(),
            })],
          );
          await client.query(
            `UPDATE playlist_run_blockers SET resolved_at=now(),updated_at=now()
             WHERE run_id=$1 AND contract_revision_id=$2
               AND blocker_kind='scope_decision' AND resolved_at IS NULL`,
            [input.runId, contractRevisionId],
          );
        }
        await client.query(
          `UPDATE research_checkpoints SET state_json=$3::jsonb,updated_at=now()
           WHERE run_id=$1 AND phase=$2`,
          [input.runId, "partial_ready", JSON.stringify({
            ...raw,
            remainingStrategyCount: 0,
            continueAvailable: false,
            continuationStrategyIds: [],
          })],
        );
        await client.query(
          `INSERT INTO research_checkpoints(run_id,phase,state_json)
           VALUES($1,'partial_research_continuation',$2::jsonb)`,
          [input.runId, JSON.stringify({
            idempotencyKey: input.idempotencyKey,
            outcomeHash: checkpoint.outcomeHash,
            outcomeVersion: checkpoint.outcomeVersion,
            sourceQueryPlanRevisionId: source.id,
            sourceQueryPlanHash: source.plan_hash,
            sourceStageKey,
            successorQueryPlanRevisionId: successorId,
            successorQueryPlanHash: successorHash,
            successorStageKey,
            strategyIds,
            jobId: inserted.rows[0].id,
            queuedAt: new Date().toISOString(),
          })],
        );
        await client.query(
          `UPDATE research_runs SET status='continuing_research',phase='continuing_research',
             error=NULL,completed_at=NULL,updated_at=now() WHERE id=$1`,
          [input.runId],
        );
        return { queued: true };
      }
      const strategy = raw.continuationJob;
      if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) {
        throw new HttpError(409, "No additional approved research strategy remains", "research_frontier_exhausted");
      }
      const job = strategy as Record<string, unknown>;
      const kind = job.kind === "research" || job.kind === "matching" ? job.kind : null;
      const payload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
        ? job.payload as Record<string, unknown>
        : null;
      const strategyKey = typeof job.strategyKey === "string"
        ? job.strategyKey.normalize("NFKC").replace(/[^A-Za-z0-9._:-]/gu, "").slice(0, 100)
        : "";
      if (!kind || !payload || !strategyKey) {
        throw new HttpError(409, "The approved continuation strategy is invalid", "research_strategy_invalid");
      }
      const jobId = randomUUID();
      const dedupeKey = `partial-continue:${input.runId}:${checkpoint.outcomeVersion}:${strategyKey}`;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO job_queue(id,run_id,kind,dedupe_key,payload_json,max_attempts)
         VALUES($1,$2,$3,$4,$5,2) ON CONFLICT(kind,dedupe_key) DO NOTHING RETURNING id`,
        [jobId, input.runId, kind, dedupeKey, { ...payload, runId: input.runId }],
      );
      const nextPartialState = {
        ...raw,
        remainingStrategyCount: Math.max(0, checkpoint.remainingStrategyCount - 1),
        continueAvailable: false,
      };
      await client.query(
        "UPDATE research_checkpoints SET state_json=$3::jsonb,updated_at=now() WHERE run_id=$1 AND phase=$2",
        [input.runId, "partial_ready", JSON.stringify(nextPartialState)],
      );
      await client.query(
        `INSERT INTO research_checkpoints(run_id,phase,state_json)
         VALUES($1,'partial_research_continuation',$2::jsonb)
         ON CONFLICT(run_id,phase) DO UPDATE SET state_json=EXCLUDED.state_json,updated_at=now()`,
        [input.runId, JSON.stringify({
          idempotencyKey: input.idempotencyKey,
          outcomeHash: checkpoint.outcomeHash,
          outcomeVersion: checkpoint.outcomeVersion,
          jobId: inserted.rows[0]?.id ?? null,
          strategyKey,
          queuedAt: new Date().toISOString(),
        })],
      );
      await client.query(
        `UPDATE research_runs SET status='continuing_research',phase='continuing_research',
           error=NULL,completed_at=NULL,updated_at=now() WHERE id=$1`,
        [input.runId],
      );
      return { queued: Boolean(inserted.rows[0]) };
    });
  }

  async cancelRunByVisitor(runId: string): Promise<void> {
    await this.transaction(async (client) => {
      const current = await client.query<{ status: string }>(
        "SELECT status FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [runId],
      );
      if (!current.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
      if (current.rows[0].status === "cancelled") return;
      const updated = await client.query(
        `UPDATE research_runs SET status='cancelled',phase='visitor_cancelled',error=NULL,
           completed_at=COALESCE(completed_at,now()),updated_at=now()
         WHERE id=$1 AND status NOT IN ('complete','partial','cancelled','deleted')`,
        [runId],
      );
      if (!updated.rowCount) throw new HttpError(409, "Run cannot be cancelled", "run_not_cancellable");
      await client.query(
        `UPDATE job_queue SET status='cancelled',completed_at=now(),lease_owner=NULL,
           lease_expires_at=NULL,updated_at=now()
         WHERE run_id=$1 AND status IN ('queued','retry')`,
        [runId],
      );
    });
  }

  async getRunExplorePreference(runId: string): Promise<{
    eligible: boolean;
    listed: boolean;
    canChange: boolean;
    reason: string | null;
  } | null> {
    const result = await this.pool.query<{
      run_status: string;
      target_count: number | null;
      owner_approved: boolean;
      public_status: string | null;
      owner_hidden: boolean | null;
      track_count: number | null;
      stable_volume_count: number;
    }>(
      `SELECT r.status run_status,
         COALESCE(NULLIF(r.selection_plan_json->>'requestedTrackCount','')::int,
           NULLIF(r.brief_json #>> '{targetSize,max}','')::int) target_count,
         COALESCE((SELECT (state_json->>'ownerApproved')::boolean FROM research_checkpoints
           WHERE run_id=r.id AND phase='partial_explore_approval'),false) owner_approved,
         p.status public_status,p.owner_hidden,p.track_count,
         COALESCE((SELECT count(*)::int FROM public_playlist_volumes v
           WHERE v.public_playlist_id=p.id),0) stable_volume_count
       FROM research_runs r
       LEFT JOIN LATERAL (
         SELECT directory.* FROM public_playlists directory
         WHERE directory.run_id=r.id ORDER BY directory.published_at DESC,directory.id DESC LIMIT 1
       ) p ON true
       WHERE r.id=$1 AND r.deleted_at IS NULL`,
      [runId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const published = row.public_status !== null && Number(row.stable_volume_count) > 0;
    if (!published) {
      return {
        eligible: false,
        listed: false,
        canChange: false,
        reason: ["complete", "partial"].includes(row.run_status)
          ? "Apple has not returned a stable public playlist link yet"
          : "Publish the playlist before changing Explore visibility",
      };
    }
    const selected = Math.max(0, Number(row.track_count ?? 0));
    const target = Math.max(1, Number(row.target_count ?? selected));
    const eligibility = partialExploreEligibility({
      targetTrackCount: target,
      selectedTrackCount: selected,
      ownerApproved: row.owner_approved,
    });
    const ownerHidden = row.owner_hidden === true;
    return {
      eligible: eligibility.eligible && !ownerHidden,
      listed: row.public_status === "listed" && !ownerHidden,
      canChange: !ownerHidden,
      reason: ownerHidden ? "This playlist was hidden by the owner" : eligibility.reason,
    };
  }

  async setRunExplorePreference(runId: string, listed: boolean): Promise<{
    eligible: boolean;
    listed: boolean;
    canChange: boolean;
    reason: string | null;
  }> {
    const result = await this.pool.query<{
      status: string;
      target_count: number | null;
      selected_count: number;
      owner_approved: boolean;
      public_id: string | null;
    }>(
      `SELECT r.status,
         COALESCE(NULLIF(r.selection_plan_json->>'requestedTrackCount','')::int,
           NULLIF(r.brief_json #>> '{targetSize,max}','')::int) target_count,
         COALESCE((SELECT count(*)::int FROM manifests m
           JOIN manifest_tracks mt ON mt.manifest_id=m.id WHERE m.run_id=r.id),0) selected_count,
         COALESCE((SELECT (state_json->>'ownerApproved')::boolean FROM research_checkpoints
           WHERE run_id=r.id AND phase='partial_explore_approval'),false) owner_approved,
         (SELECT id FROM public_playlists WHERE run_id=r.id ORDER BY created_at DESC LIMIT 1) public_id
       FROM research_runs r WHERE r.id=$1 AND r.deleted_at IS NULL`,
      [runId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Research run not found", "run_not_found");
    if (!["complete", "partial"].includes(row.status)) {
      throw new HttpError(409, "Publish the playlist before changing Explore visibility", "explore_not_ready");
    }
    const target = Number(row.target_count ?? row.selected_count);
    const eligibility = partialExploreEligibility({
      targetTrackCount: target,
      selectedTrackCount: Number(row.selected_count),
      ownerApproved: row.owner_approved,
    });
    if (listed && !eligibility.eligible) {
      return { eligible: false, listed: false, canChange: true, reason: eligibility.reason };
    }
    const directory = await this.upsertPublicPlaylistDirectoryForRun(runId, { listed });
    if (!directory) {
      throw new HttpError(409, "Apple has not returned a stable public playlist link yet", "explore_not_ready");
    }
    return await this.getRunExplorePreference(runId)
      ?? { eligible: false, listed: false, canChange: false, reason: "Research run not found" };
  }

  async enqueueJob(input: {
    kind: string;
    runId?: string | null;
    briefRequestId?: string | null;
    payload?: Record<string, unknown>;
    dedupeKey?: string;
    availableAt?: Date;
    maxAttempts?: number;
    pipelineVersion?: PipelineVersion;
    minimumWorkerProtocol?: number;
    queryPlanRevisionId?: string | null;
    stageKey?: string;
    queueClass?: JobQueueClass;
  }): Promise<{ id: string; created: boolean }> {
    const id = randomUUID();
    const dedupeKey = input.dedupeKey ?? input.runId ?? input.briefRequestId ?? randomUUID();
    const schemaVersion = Number(await this.getSchemaVersion() ?? 0);
    if (schemaVersion >= 14) {
      let pipelineVersion = input.pipelineVersion ?? "legacy_v1";
      let queryPlanRevisionId = input.queryPlanRevisionId ?? null;
      let activeQueryPlan: QueryPlanV3 | null = null;
      let queueClass = defaultJobQueueClass({
        kind: input.kind,
        requested: input.queueClass,
        payload: input.payload,
      });
      if (input.runId) {
        const run = await this.pool.query<{
          pipeline_version: PipelineVersion;
          query_plan_revision_id: string | null;
          query_plan_json: unknown;
        }>(
          `SELECT r.pipeline_version,a.query_plan_revision_id,q.plan_json query_plan_json
           FROM research_runs r
           LEFT JOIN run_active_query_plans a ON a.run_id=r.id
           LEFT JOIN query_plan_revisions q ON q.id=a.query_plan_revision_id
           WHERE r.id=$1`,
          [input.runId],
        );
        if (run.rows[0]) {
          pipelineVersion = run.rows[0].pipeline_version;
          queryPlanRevisionId ??= run.rows[0].query_plan_revision_id;
          if (pipelineVersion === "corpus_first_v3" && isQueryPlanV3(run.rows[0].query_plan_json)) {
            activeQueryPlan = run.rows[0].query_plan_json;
          }
          if (["research", "matching"].includes(input.kind)) {
            // The persisted plan is authoritative. Callers cannot smuggle a
            // curated or historical run onto the privileged deep lane merely
            // by supplying queueClass in the enqueue payload.
            queueClass = pipelineVersion === "corpus_first_v3" && isDeepQueryPlan(run.rows[0].query_plan_json)
              ? "deep"
              : "interactive";
          }
        }
      }
      if (!input.runId && ["research", "matching"].includes(input.kind)) {
        queueClass = isColdCorpusWork(input.payload) ? "deep" : "interactive";
      }
      if (pipelineVersion === "corpus_first_v3" && !queryPlanRevisionId) {
        throw new HttpError(
          409,
          "Pipeline V3 work requires an active query-plan revision",
          "v3_query_plan_required",
        );
      }
      const pipelineMinimum = minimumWorkerProtocolForPipeline(pipelineVersion);
      const planMinimum = pipelineVersion === "corpus_first_v3"
        ? minimumWorkerProtocolForQueryPlan(activeQueryPlan)
        : pipelineMinimum;
      // A caller may request a newer worker for another reason, but can never
      // downgrade schema-2 semantic work below protocol 8.
      const minimumWorkerProtocol = Math.max(
        input.minimumWorkerProtocol ?? pipelineMinimum,
        planMinimum,
      );
      const result = await this.pool.query<{
        id: string;
        inserted: boolean;
      }>(
        `INSERT INTO job_queue(
           id,run_id,brief_request_id,kind,dedupe_key,payload_json,available_at,max_attempts,
           pipeline_version,minimum_worker_protocol,query_plan_revision_id,stage_key,queue_class
         )
         VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,now()),$8,$9,$10,$11,$12,$13)
         ON CONFLICT(kind,dedupe_key) DO UPDATE SET
           run_id=EXCLUDED.run_id,
           brief_request_id=EXCLUDED.brief_request_id,
           payload_json=EXCLUDED.payload_json,
           pipeline_version=EXCLUDED.pipeline_version,
           minimum_worker_protocol=EXCLUDED.minimum_worker_protocol,
           query_plan_revision_id=EXCLUDED.query_plan_revision_id,
           stage_key=EXCLUDED.stage_key,
           queue_class=EXCLUDED.queue_class,
           status='queued',
           attempts=0,
           max_attempts=EXCLUDED.max_attempts,
           available_at=EXCLUDED.available_at,
           lease_owner=NULL,
           lease_expires_at=NULL,
           last_error=NULL,
           completed_at=NULL,
           updated_at=now()
         WHERE job_queue.status IN ('failed','cancelled')
            OR (job_queue.status='complete' AND EXCLUDED.kind='apple_authorization')
         RETURNING id,(xmax=0) AS inserted`,
        [
          id,
          input.runId ?? null,
          input.briefRequestId ?? null,
          input.kind,
          dedupeKey.slice(0, 160),
          input.payload ?? {},
          input.availableAt ?? null,
          input.maxAttempts ?? 3,
          pipelineVersion,
          minimumWorkerProtocol,
          queryPlanRevisionId,
          (input.stageKey ?? "default").slice(0, 160),
          queueClass,
        ],
      );
      if (result.rows[0]) return { id: result.rows[0].id, created: result.rows[0].inserted };
      const existing = await this.pool.query<{ id: string }>(
        "SELECT id FROM job_queue WHERE kind=$1 AND dedupe_key=$2",
        [input.kind, dedupeKey.slice(0, 160)],
      );
      return { id: existing.rows[0]!.id, created: false };
    }
    const result = await this.pool.query<{ id: string; inserted: boolean }>(
      `INSERT INTO job_queue(id,run_id,brief_request_id,kind,dedupe_key,payload_json,available_at,max_attempts)
       VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,now()),$8)
       ON CONFLICT(kind,dedupe_key) DO UPDATE SET
         run_id=EXCLUDED.run_id,
         brief_request_id=EXCLUDED.brief_request_id,
         payload_json=EXCLUDED.payload_json,
         status='queued',
         attempts=0,
         max_attempts=EXCLUDED.max_attempts,
         available_at=EXCLUDED.available_at,
         lease_owner=NULL,
         lease_expires_at=NULL,
         last_error=NULL,
         completed_at=NULL,
         updated_at=now()
       WHERE job_queue.status IN ('failed','cancelled')
          OR (job_queue.status='complete' AND EXCLUDED.kind='apple_authorization')
       RETURNING id,(xmax=0) AS inserted`,
      [id, input.runId ?? null, input.briefRequestId ?? null, input.kind, dedupeKey.slice(0, 160), input.payload ?? {}, input.availableAt ?? null, input.maxAttempts ?? 3],
    );
    if (result.rows[0]) return { id: result.rows[0].id, created: result.rows[0].inserted };
    const existing = await this.pool.query<{ id: string }>("SELECT id FROM job_queue WHERE kind=$1 AND dedupe_key=$2", [input.kind, dedupeKey.slice(0, 160)]);
    return { id: existing.rows[0]!.id, created: false };
  }

  async leaseNextJob(
    workerId: string,
    leaseMs: number,
    capability: WorkerPipelineCapability = WORKER_PIPELINE_CAPABILITY,
    workerQueueClass: WorkerQueueClass = "all",
  ): Promise<JobView | null> {
    if (!isWorkerCapabilityValid(capability)) {
      throw new HttpError(400, "Worker lease capability is invalid", "invalid_worker_capability");
    }
    const schemaVersion = Number(await this.getSchemaVersion() ?? 0);
    const queueClasses = queueClassesForWorker(workerQueueClass);
    if (schemaVersion < 14 && workerQueueClass === "deep") return null;
    const queuePredicate = schemaVersion >= 14 ? " AND queue_class=ANY($10::varchar[])" : "";
    const candidateQueuePredicate = schemaVersion >= 14
      ? " AND candidate.queue_class=ANY($3::varchar[])"
      : "";
    const publicationPriority = schemaVersion >= 14
      ? "WHEN candidate.queue_class='publication' THEN -1"
      : "";
    // Derive the effective fence from both immutable contracts at lease time.
    // This protects work queued during a rolling migration even if an older
    // trigger physically stamped a lower number on the row.
    const effectiveMinimumWorkerProtocol = schemaVersion >= 15
      ? `GREATEST(
           candidate.minimum_worker_protocol,
           CASE WHEN EXISTS (
             SELECT 1 FROM query_plan_revisions protocol_plan
             WHERE protocol_plan.id=candidate.query_plan_revision_id
               AND COALESCE((protocol_plan.plan_json->>'schemaVersion')::int,1)>=4
           ) THEN ${CORPUS_FIRST_V3_SCHEMA_4_MINIMUM_WORKER_PROTOCOL}
           WHEN EXISTS (
             SELECT 1 FROM query_plan_revisions protocol_plan
             WHERE protocol_plan.id=candidate.query_plan_revision_id
               AND COALESCE((protocol_plan.plan_json->>'schemaVersion')::int,1)=3
           ) THEN ${CORPUS_FIRST_V3_SCHEMA_3_MINIMUM_WORKER_PROTOCOL}
           WHEN EXISTS (
             SELECT 1 FROM query_plan_revisions protocol_plan
             WHERE protocol_plan.id=candidate.query_plan_revision_id
               AND COALESCE((protocol_plan.plan_json->>'schemaVersion')::int,1)=2
           ) THEN ${CORPUS_FIRST_V3_SCHEMA_2_MINIMUM_WORKER_PROTOCOL}
           ELSE 0 END,
           CASE WHEN ${schemaVersion >= 17 ? `EXISTS (
             SELECT 1 FROM research_runs protocol_run
             WHERE protocol_run.id=candidate.run_id AND protocol_run.brief_contract_version>=3
           ) OR EXISTS (
             SELECT 1 FROM brief_requests protocol_brief
             WHERE protocol_brief.id=candidate.brief_request_id AND protocol_brief.brief_contract_version>=3
           )` : "false"}
           THEN ${BRIEF_CONTRACT_3_MINIMUM_WORKER_PROTOCOL}
           WHEN ${schemaVersion >= 16 ? `EXISTS (
             SELECT 1 FROM research_runs protocol_run
             WHERE protocol_run.id=candidate.run_id AND protocol_run.brief_contract_version>=2
           ) OR EXISTS (
             SELECT 1 FROM brief_requests protocol_brief
             WHERE protocol_brief.id=candidate.brief_request_id AND protocol_brief.brief_contract_version>=2
           )` : "false"}
           THEN ${BRIEF_CONTRACT_2_MINIMUM_WORKER_PROTOCOL} ELSE 0 END
         )`
      : "candidate.minimum_worker_protocol";
    const exhaustedEffectiveMinimumWorkerProtocol = schemaVersion >= 15
      ? `GREATEST(
           job_queue.minimum_worker_protocol,
           CASE WHEN EXISTS (
             SELECT 1 FROM query_plan_revisions protocol_plan
             WHERE protocol_plan.id=job_queue.query_plan_revision_id
               AND COALESCE((protocol_plan.plan_json->>'schemaVersion')::int,1)>=4
           ) THEN ${CORPUS_FIRST_V3_SCHEMA_4_MINIMUM_WORKER_PROTOCOL}
           WHEN EXISTS (
             SELECT 1 FROM query_plan_revisions protocol_plan
             WHERE protocol_plan.id=job_queue.query_plan_revision_id
               AND COALESCE((protocol_plan.plan_json->>'schemaVersion')::int,1)=3
           ) THEN ${CORPUS_FIRST_V3_SCHEMA_3_MINIMUM_WORKER_PROTOCOL}
           WHEN EXISTS (
             SELECT 1 FROM query_plan_revisions protocol_plan
             WHERE protocol_plan.id=job_queue.query_plan_revision_id
               AND COALESCE((protocol_plan.plan_json->>'schemaVersion')::int,1)=2
           ) THEN ${CORPUS_FIRST_V3_SCHEMA_2_MINIMUM_WORKER_PROTOCOL}
           ELSE 0 END,
           CASE WHEN ${schemaVersion >= 17 ? `EXISTS (
             SELECT 1 FROM research_runs protocol_run
             WHERE protocol_run.id=job_queue.run_id AND protocol_run.brief_contract_version>=3
           ) OR EXISTS (
             SELECT 1 FROM brief_requests protocol_brief
             WHERE protocol_brief.id=job_queue.brief_request_id AND protocol_brief.brief_contract_version>=3
           )` : "false"}
           THEN ${BRIEF_CONTRACT_3_MINIMUM_WORKER_PROTOCOL}
           WHEN ${schemaVersion >= 16 ? `EXISTS (
             SELECT 1 FROM research_runs protocol_run
             WHERE protocol_run.id=job_queue.run_id AND protocol_run.brief_contract_version>=2
           ) OR EXISTS (
             SELECT 1 FROM brief_requests protocol_brief
             WHERE protocol_brief.id=job_queue.brief_request_id AND protocol_brief.brief_contract_version>=2
           )` : "false"}
           THEN ${BRIEF_CONTRACT_2_MINIMUM_WORKER_PROTOCOL} ELSE 0 END
         )`
      : "job_queue.minimum_worker_protocol";
    const terminalFailures: Array<{ source: "run" | "brief"; id: string }> = [];
    const leasedJob = await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [JOB_ADVISORY_LOCK]);
      const exhausted = await client.query<{ run_id: string | null; brief_request_id: string | null; kind: string; payload_json: Record<string, unknown> | null }>(
        `WITH exhausted_candidates AS (
           SELECT id FROM job_queue
           WHERE status='leased' AND lease_expires_at<=now() AND attempts>=max_attempts
             AND ${exhaustedEffectiveMinimumWorkerProtocol}<=$8
             AND pipeline_version=ANY($9::varchar[])
             ${queuePredicate}
           ORDER BY lease_expires_at,id
           FOR UPDATE SKIP LOCKED
           LIMIT 20
         )
         UPDATE job_queue SET status='failed',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL,
         last_error=CASE kind
           WHEN 'brief' THEN $1
           WHEN 'research' THEN $2
           WHEN 'matching' THEN $3
           WHEN 'publication' THEN $4
           WHEN 'notification' THEN $5
           WHEN 'apple_authorization' THEN $6
           ELSE $7 END,
         updated_at=now()
         FROM exhausted_candidates
         WHERE job_queue.id=exhausted_candidates.id
         RETURNING run_id,brief_request_id,kind,payload_json`,
        [
          sanitizeFailure(null, "brief"),
          sanitizeFailure(null, "research"),
          sanitizeFailure(null, "matching"),
          sanitizeFailure("Worker lease expired after the final attempt", "publication"),
          sanitizeFailure(null, "notification"),
          sanitizeFailure(null, "apple_authorization"),
          sanitizeFailure(null, "background"),
          capability.protocolNumber,
          [...capability.pipelineVersions],
          ...(schemaVersion >= 14 ? [queueClasses] : []),
        ],
      );
      for (const job of exhausted.rows) {
        if (job.kind === "apple_authorization") {
          const authorization = await client.query<{ ciphertext: string; key_version: string }>(
            "SELECT ciphertext,key_version FROM apple_authorizations WHERE id='owner' FOR UPDATE",
          );
          const row = authorization.rows[0];
          const expectedGeneration = typeof job.payload_json?.authorizationGeneration === "string"
            ? job.payload_json.authorizationGeneration
            : null;
          if (row && expectedGeneration === appleAuthorizationGeneration({
            ciphertext: row.ciphertext,
            keyVersion: row.key_version,
          })) {
            await client.query(
              `UPDATE apple_authorizations SET status='validation_failed',last_error=$1,updated_at=now()
               WHERE id='owner' AND status<>'valid'`,
              [sanitizeFailure(null, "apple_authorization")],
            );
          }
        }
        const recoveryFailure = Boolean(job.run_id && job.kind === "matching" && isCatalogRecoveryJob(job.payload_json));
        if (recoveryFailure) {
          await settleCatalogRecoveryFailure(
            client,
            job.run_id!,
            catalogRecoveryGeneration(job.payload_json),
          );
        } else if (job.run_id && ["research", "matching", "publication"].includes(job.kind)) {
          const failedRun = await client.query(
            `UPDATE research_runs SET status='failed',phase=$2,error=$3,
             completed_at=COALESCE(completed_at,now()),updated_at=now()
             WHERE id=$1 AND status NOT IN ('complete','partial','failed','expired','deleted','waiting_for_apple_authorization')`,
            [job.run_id, `${job.kind}_failed`, sanitizeFailure(
              job.kind === "publication" ? "Worker lease expired after the final attempt" : null,
              failureContextForJob(job.kind),
            )],
          );
          if (failedRun.rowCount) terminalFailures.push({ source: "run", id: job.run_id });
        }
        if (job.brief_request_id && job.kind === "brief") {
          const failedBrief = await client.query(
            "UPDATE brief_requests SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status<>'complete'",
            [job.brief_request_id, sanitizeFailure(null, "brief")],
          );
          if (failedBrief.rowCount) terminalFailures.push({ source: "brief", id: job.brief_request_id });
        }
        if (job.kind === "publication") {
          await markTerminalPublicationVolumes(client, job.payload_json, "Worker lease expired after the final attempt");
        }
        const notificationId = job.kind === "notification" && typeof job.payload_json?.notificationId === "string"
          ? job.payload_json.notificationId
          : null;
        if (notificationId) {
          await client.query(
            `UPDATE notification_outbox SET status='failed',last_error=$2,updated_at=now()
             WHERE id=$1 AND status<>'sent'`,
            [notificationId, sanitizeFailure(null, "notification")],
          );
        }
      }
      const capacity = Math.max(1, Math.min(Number(process.env.WORKER_CONCURRENCY ?? process.env.MAX_WORKER_JOBS ?? 2), 10));
      const active = await client.query<{ count: number }>(
        `SELECT count(*)::int count FROM job_queue
         WHERE status='leased' AND lease_expires_at>now()
         ${schemaVersion >= 14 ? "AND queue_class=ANY($1::varchar[])" : ""}`,
        schemaVersion >= 14 ? [queueClasses] : [],
      );
      if (active.rows[0]!.count >= capacity) return null;
      // Brief and explicitly marked fast jobs normally lead the queue. Once an
      // operational job has been runnable for 30 seconds it is promoted above
      // that lane, preventing an endless stream of fast jobs from starving it.
      const selected = await client.query(
        `SELECT candidate.*,
                ${effectiveMinimumWorkerProtocol} AS effective_minimum_worker_protocol
         FROM job_queue candidate WHERE
           ((candidate.status='queued' AND candidate.available_at<=now()) OR (candidate.status='leased' AND candidate.lease_expires_at<=now()))
           AND ${effectiveMinimumWorkerProtocol}<=$1
           AND candidate.pipeline_version=ANY($2::varchar[])
           ${candidateQueuePredicate}
           AND NOT (candidate.kind IN ('brief','research','matching') AND COALESCE((SELECT value='true' FROM settings WHERE key='research_paused'),false))
           AND NOT (candidate.kind='publication' AND COALESCE((SELECT value='true' FROM settings WHERE key='publishing_paused'),false))
           AND NOT (
             candidate.kind='publication'
             AND candidate.payload_json->>'manifestId' IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM job_queue active_publication
               WHERE active_publication.id<>candidate.id
                 AND active_publication.kind='publication'
                 AND active_publication.status='leased'
                 AND active_publication.lease_expires_at>now()
               AND active_publication.payload_json->>'manifestId'=candidate.payload_json->>'manifestId'
             )
           )
           AND NOT (
             candidate.kind IN ('research','matching')
             AND NOT (candidate.payload_json @> '{"fast":true}'::jsonb)
             AND EXISTS (
               SELECT 1 FROM job_queue active_deep
               WHERE active_deep.status='leased'
                 AND active_deep.lease_expires_at>now()
                 AND active_deep.kind IN ('research','matching')
                 AND NOT (active_deep.payload_json @> '{"fast":true}'::jsonb)
             )
           )
           AND candidate.attempts<candidate.max_attempts
           ORDER BY CASE
             ${publicationPriority}
             WHEN candidate.kind NOT IN ('brief','research','matching')
               AND candidate.available_at<=now()-interval '30 seconds' THEN 0
             WHEN candidate.kind='matching'
               AND candidate.payload_json @> '{"fast":true}'::jsonb THEN 0
             WHEN candidate.kind='brief' THEN 1
             WHEN candidate.kind IN ('research','matching')
               AND candidate.payload_json @> '{"fast":true}'::jsonb THEN 1
             ELSE 2
           END,
           candidate.available_at,candidate.created_at FOR UPDATE OF candidate SKIP LOCKED LIMIT 1`,
        [
          capability.protocolNumber,
          [...capability.pipelineVersions],
          ...(schemaVersion >= 14 ? [queueClasses] : []),
        ],
      );
      const job = selected.rows[0];
      if (!job) return null;
      const expiresAt = new Date(Date.now() + Math.max(30_000, leaseMs));
      const updated = await client.query(
        `UPDATE job_queue SET status='leased',lease_owner=$2,lease_expires_at=$3,attempts=attempts+1,updated_at=now()
         WHERE id=$1 RETURNING *`,
        [job.id, workerId, expiresAt],
      );
      const row = updated.rows[0];
      return {
        id: row.id,
        runId: row.run_id,
        briefRequestId: row.brief_request_id,
        kind: row.kind,
        queueClass: schemaVersion >= 14 ? row.queue_class : "interactive",
        payload: row.payload_json ?? {},
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        pipelineVersion: row.pipeline_version,
        minimumWorkerProtocol: Number(job.effective_minimum_worker_protocol ?? row.minimum_worker_protocol),
        queryPlanRevisionId: row.query_plan_revision_id ?? null,
        stageKey: typeof row.stage_key === "string" ? row.stage_key : "default",
        leaseEpoch: Number(row.lease_epoch ?? 0),
        leaseOwner: row.lease_owner,
        leaseExpiresAt: date(row.lease_expires_at),
      };
    });
    // Do not hold up the newly leased job while reporting an unrelated
    // exhausted backlog. The direct capture is best-effort and heartbeat
    // reconciliation will recover anything interrupted by process shutdown.
    void (async () => {
      for (const failure of terminalFailures) {
        if (failure.source === "run") await this.captureAutomaticRunFailureSafely(failure.id);
        else await this.captureAutomaticBriefFailureSafely(failure.id);
      }
    })();
    return leasedJob;
  }

  async renewJobLease(jobId: string, workerId: string, leaseMs: number, leaseEpoch?: number): Promise<boolean> {
    const schemaVersion = Number(await this.getSchemaVersion() ?? 0);
    const expiresAt = new Date(Date.now() + Math.max(30_000, leaseMs));
    const result = schemaVersion >= 14
      ? await this.pool.query(
        `UPDATE job_queue SET lease_expires_at=$3,updated_at=now()
         WHERE id=$1 AND lease_owner=$2 AND status='leased' AND lease_expires_at>now()
           AND (pipeline_version<>'corpus_first_v3' OR ($4::bigint IS NOT NULL AND lease_epoch=$4))`,
        [jobId, workerId, expiresAt, Number.isSafeInteger(leaseEpoch) ? leaseEpoch : null],
      )
      : await this.pool.query(
        "UPDATE job_queue SET lease_expires_at=$3,updated_at=now() WHERE id=$1 AND lease_owner=$2 AND status='leased' AND lease_expires_at>now()",
        [jobId, workerId, expiresAt],
      );
    return Boolean(result.rowCount);
  }

  async deferJob(
    jobId: string,
    workerId: string,
    availableAt: Date,
    reason: string,
    leaseEpoch?: number,
  ): Promise<void> {
    const schemaVersion = Number(await this.getSchemaVersion() ?? 0);
    const result = schemaVersion >= 14
      ? await this.pool.query(
        `UPDATE job_queue SET status='queued',attempts=GREATEST(0,attempts-1),available_at=$3,
         lease_owner=NULL,lease_expires_at=NULL,last_error=$4,completed_at=NULL,updated_at=now()
         WHERE id=$1 AND lease_owner=$2 AND status='leased'
           AND (pipeline_version<>'corpus_first_v3' OR ($5::bigint IS NOT NULL AND lease_epoch=$5))`,
        [jobId, workerId, availableAt, sanitizeFailure(reason, "background"), Number.isSafeInteger(leaseEpoch) ? leaseEpoch : null],
      )
      : await this.pool.query(
        `UPDATE job_queue SET status='queued',attempts=GREATEST(0,attempts-1),available_at=$3,
         lease_owner=NULL,lease_expires_at=NULL,last_error=$4,completed_at=NULL,updated_at=now()
         WHERE id=$1 AND lease_owner=$2 AND status='leased'`,
        [jobId, workerId, availableAt, sanitizeFailure(reason, "background")],
      );
    if (!result.rowCount) throw new HttpError(409, "Job lease was lost", "job_lease_lost");
  }

  async cancelLeasedJob(jobId: string, workerId: string, reason: string, leaseEpoch?: number): Promise<void> {
    const schemaVersion = Number(await this.getSchemaVersion() ?? 0);
    const result = schemaVersion >= 14
      ? await this.pool.query(
        `UPDATE job_queue SET status='cancelled',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL,
         last_error=$3,updated_at=now()
         WHERE id=$1 AND lease_owner=$2 AND status='leased'
           AND (pipeline_version<>'corpus_first_v3' OR ($4::bigint IS NOT NULL AND lease_epoch=$4))`,
        [jobId, workerId, sanitizeFailure(reason, "background"), Number.isSafeInteger(leaseEpoch) ? leaseEpoch : null],
      )
      : await this.pool.query(
        `UPDATE job_queue SET status='cancelled',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL,
         last_error=$3,updated_at=now()
         WHERE id=$1 AND lease_owner=$2 AND status='leased'`,
        [jobId, workerId, sanitizeFailure(reason, "background")],
      );
    if (!result.rowCount) throw new HttpError(409, "Job lease was lost", "job_lease_lost");
  }

  async completeJob(jobId: string, workerId: string, leaseEpoch?: number): Promise<void> {
    await this.transaction(async (client) => {
      const schemaVersion = Number(await this.getSchemaVersion() ?? 0);
      const current = await client.query<{
        run_id: string | null;
        kind: string;
        payload_json: Record<string, unknown> | null;
      }>(schemaVersion >= 14
        ? `SELECT run_id,kind,payload_json FROM job_queue
           WHERE id=$1 AND lease_owner=$2 AND status='leased'
             AND (pipeline_version<>'corpus_first_v3' OR ($3::bigint IS NOT NULL AND lease_epoch=$3))
           FOR UPDATE`
        : "SELECT run_id,kind,payload_json FROM job_queue WHERE id=$1 AND lease_owner=$2 AND status='leased' FOR UPDATE",
      schemaVersion >= 14
        ? [jobId, workerId, Number.isSafeInteger(leaseEpoch) ? leaseEpoch : null]
        : [jobId, workerId]);
      if (!current.rows[0]) throw new HttpError(409, "Job lease was lost", "job_lease_lost");
      const job = current.rows[0];
      if (job.run_id && job.kind === "matching" && isCatalogRecoveryJob(job.payload_json)
        && catalogRecoveryGeneration(job.payload_json) >= 3) {
        await settleCatalogRecoveryFailure(client, job.run_id, 3);
      }
      const completed = schemaVersion >= 14
        ? await client.query(
          `UPDATE job_queue SET status='complete',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
           WHERE id=$1 AND lease_owner=$2 AND status='leased'
             AND (pipeline_version<>'corpus_first_v3' OR ($3::bigint IS NOT NULL AND lease_epoch=$3))`,
          [jobId, workerId, Number.isSafeInteger(leaseEpoch) ? leaseEpoch : null],
        )
        : await client.query(
          `UPDATE job_queue SET status='complete',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
           WHERE id=$1 AND lease_owner=$2 AND status='leased'`,
          [jobId, workerId],
        );
      if (!completed.rowCount) throw new HttpError(409, "Job lease was lost", "job_lease_lost");
    });
  }

  async failJob(
    jobId: string,
    workerId: string,
    error: string,
    retryAt: Date | null = null,
    leaseEpoch?: number,
  ): Promise<void> {
    const terminalFailures = await this.transaction(async (client) => {
      const captured: Array<{ source: "run" | "brief"; id: string }> = [];
      const schemaVersion = Number(await this.getSchemaVersion() ?? 0);
      const current = await client.query<{ attempts: number; max_attempts: number; run_id: string | null; brief_request_id: string | null; kind: string; payload_json: Record<string, unknown> | null }>(
        schemaVersion >= 14
          ? `SELECT attempts,max_attempts,run_id,brief_request_id,kind,payload_json FROM job_queue
             WHERE id=$1 AND lease_owner=$2 AND status='leased'
               AND (pipeline_version<>'corpus_first_v3' OR ($3::bigint IS NOT NULL AND lease_epoch=$3))
             FOR UPDATE`
          : "SELECT attempts,max_attempts,run_id,brief_request_id,kind,payload_json FROM job_queue WHERE id=$1 AND lease_owner=$2 AND status='leased' FOR UPDATE",
        schemaVersion >= 14
          ? [jobId, workerId, Number.isSafeInteger(leaseEpoch) ? leaseEpoch : null]
          : [jobId, workerId],
      );
      if (!current.rows[0]) throw new HttpError(409, "Job lease was lost", "job_lease_lost");
      const retry = retryAt && current.rows[0].attempts < current.rows[0].max_attempts;
      const context = failureContextForJob(current.rows[0].kind);
      const persistedError = sanitizeFailure(error, context);
      const failed = schemaVersion >= 14
        ? await client.query(
          `UPDATE job_queue SET status=$3::varchar,available_at=COALESCE($4::timestamptz,available_at),last_error=$5,
           completed_at=CASE WHEN $3::varchar='failed' THEN now() ELSE NULL END,lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
           WHERE id=$1 AND lease_owner=$2
             AND (pipeline_version<>'corpus_first_v3' OR ($6::bigint IS NOT NULL AND lease_epoch=$6))`,
          [jobId, workerId, retry ? "queued" : "failed", retry ? retryAt : null, persistedError, Number.isSafeInteger(leaseEpoch) ? leaseEpoch : null],
        )
        : await client.query(
          `UPDATE job_queue SET status=$3::varchar,available_at=COALESCE($4::timestamptz,available_at),last_error=$5,
           completed_at=CASE WHEN $3::varchar='failed' THEN now() ELSE NULL END,lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
           WHERE id=$1 AND lease_owner=$2`,
          [jobId, workerId, retry ? "queued" : "failed", retry ? retryAt : null, persistedError],
        );
      if (!failed.rowCount) throw new HttpError(409, "Job lease was lost", "job_lease_lost");
      if (!retry && current.rows[0].kind === "apple_authorization") {
        const authorization = await client.query<{ ciphertext: string; key_version: string }>(
          "SELECT ciphertext,key_version FROM apple_authorizations WHERE id='owner' FOR UPDATE",
        );
        const row = authorization.rows[0];
        const expectedGeneration = typeof current.rows[0].payload_json?.authorizationGeneration === "string"
          ? current.rows[0].payload_json.authorizationGeneration
          : null;
        if (row && expectedGeneration === appleAuthorizationGeneration({
          ciphertext: row.ciphertext,
          keyVersion: row.key_version,
        })) {
          await client.query(
            `UPDATE apple_authorizations SET status='validation_failed',last_error=$1,updated_at=now()
             WHERE id='owner' AND status<>'valid'`,
            [persistedError],
          );
        }
      }
      const recoveryFailure = !retry
        && Boolean(current.rows[0].run_id)
        && current.rows[0].kind === "matching"
        && isCatalogRecoveryJob(current.rows[0].payload_json);
      if (recoveryFailure) {
        await settleCatalogRecoveryFailure(
          client,
          current.rows[0].run_id!,
          catalogRecoveryGeneration(current.rows[0].payload_json),
        );
      } else if (!retry && current.rows[0].run_id && ["research", "matching", "publication"].includes(current.rows[0].kind)) {
        const failedRun = await client.query(
          `UPDATE research_runs SET status='failed',phase=$2,error=$3,completed_at=COALESCE(completed_at,now()),updated_at=now()
           WHERE id=$1 AND status NOT IN ('complete','partial','failed','expired','deleted','waiting_for_apple_authorization')`,
          [current.rows[0].run_id, `${current.rows[0].kind}_failed`, persistedError.slice(0, 2_000)],
        );
        if (failedRun.rowCount) captured.push({ source: "run", id: current.rows[0].run_id });
      }
      if (!retry && current.rows[0].kind === "publication") {
        await markTerminalPublicationVolumes(client, current.rows[0].payload_json, error);
      }
      if (!retry && current.rows[0].brief_request_id && current.rows[0].kind === "brief") {
        const failedBrief = await client.query(
          "UPDATE brief_requests SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status<>'complete'",
          [current.rows[0].brief_request_id, sanitizeFailure(error, "brief")],
        );
        if (failedBrief.rowCount) captured.push({ source: "brief", id: current.rows[0].brief_request_id });
      }
      const notificationId = !retry && current.rows[0].kind === "notification" && typeof current.rows[0].payload_json?.notificationId === "string"
        ? current.rows[0].payload_json.notificationId
        : null;
      if (notificationId) {
        await client.query(
          "UPDATE notification_outbox SET status='failed',last_error=$2,updated_at=now() WHERE id=$1 AND status<>'sent'",
          [notificationId, sanitizeFailure(error, "notification")],
        );
      }
      return captured;
    });
    for (const failure of terminalFailures) {
      if (failure.source === "run") await this.captureAutomaticRunFailureSafely(failure.id);
      else await this.captureAutomaticBriefFailureSafely(failure.id);
    }
  }

  async updateWorkerHeartbeat(workerId: string, metadata: { schemaVersion?: string; capacity?: number; activeJobs?: number; [key: string]: unknown }): Promise<void> {
    const { schemaVersion = DATABASE_SCHEMA_VERSION, capacity = 1, activeJobs = 0, ...rest } = metadata;
    await this.pool.query(
      `INSERT INTO worker_heartbeats(worker_id,schema_version,capacity,active_jobs,metadata_json)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(worker_id) DO UPDATE SET schema_version=EXCLUDED.schema_version,
       capacity=EXCLUDED.capacity,active_jobs=EXCLUDED.active_jobs,metadata_json=EXCLUDED.metadata_json,last_seen_at=now()`,
      [workerId, schemaVersion, capacity, activeJobs, rest],
    );
    await this.reconcileAutomaticFailureFeedback();
  }

  async getResearchCheckpoint(runId: string, phase: string): Promise<unknown | null> {
    const result = await this.pool.query<{ state_json: unknown }>("SELECT state_json FROM research_checkpoints WHERE run_id=$1 AND phase=$2", [runId, phase]);
    return result.rows[0]?.state_json ?? null;
  }

  async saveResearchCheckpoint(
    runId: string,
    phase: string,
    state: unknown,
    fence?: PipelineV3WriteFence,
  ): Promise<void> {
    const persist = async (client: PoolClient | Pool) => {
      await client.query(
        `INSERT INTO research_checkpoints(run_id,phase,state_json) VALUES($1,$2,$3)
         ON CONFLICT(run_id,phase) DO UPDATE SET state_json=EXCLUDED.state_json,updated_at=now()`,
        [runId, phase, state],
      );
    };
    if (!fence) {
      await persist(this.pool);
      return;
    }
    await this.transaction(async (client) => {
      await this.assertPipelineV3WriteFence(client, runId, fence);
      await persist(client);
    });
  }

  /**
   * Atomically reserves one uncached MusicBrainz HTTP request. A checkpoint is
   * used instead of an in-memory counter so worker restarts and retries cannot
   * reset the five-request Pipeline V2 ceiling.
   */
  async reserveMusicBrainzEnrichmentRequest(runId: string, maximum: number): Promise<number | null> {
    const boundedMaximum = Math.min(5, Math.max(0, Math.floor(maximum)));
    if (!Number.isFinite(boundedMaximum) || boundedMaximum < 1) return null;
    return this.transaction(async (client) => {
      const run = await client.query(
        "SELECT id FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [runId],
      );
      if (!run.rows[0]) return null;
      const phase = "musicbrainz_identity_budget_v1";
      const current = await client.query<{ state_json: unknown }>(
        "SELECT state_json FROM research_checkpoints WHERE run_id=$1 AND phase=$2 FOR UPDATE",
        [runId, phase],
      );
      const state = current.rows[0]?.state_json && typeof current.rows[0].state_json === "object"
        && !Array.isArray(current.rows[0].state_json)
        ? current.rows[0].state_json as Record<string, unknown>
        : {};
      const observed = Number(state.uncachedRequests);
      const used = Number.isInteger(observed) && observed >= 0 ? observed : 0;
      if (used >= boundedMaximum) return null;
      const next = used + 1;
      const checkpoint = {
        version: "musicbrainz_identity_budget_v1",
        uncachedRequests: next,
        maximum: boundedMaximum,
        updatedAt: new Date().toISOString(),
      };
      if (current.rows[0]) {
        await client.query(
          "UPDATE research_checkpoints SET state_json=$3::jsonb,updated_at=now() WHERE run_id=$1 AND phase=$2",
          [runId, phase, JSON.stringify(checkpoint)],
        );
      } else {
        await client.query(
          "INSERT INTO research_checkpoints(run_id,phase,state_json) VALUES($1,$2,$3::jsonb)",
          [runId, phase, JSON.stringify(checkpoint)],
        );
      }
      return next;
    });
  }

  async updateCandidateMusicBrainzIdentity(
    runId: string,
    candidateId: string,
    recordingId: string,
  ): Promise<void> {
    if (!UUID_PATTERN.test(recordingId)) return;
    await this.pool.query(
      `UPDATE track_candidates SET musicbrainz_id=$3
       WHERE id=$2 AND run_id=$1 AND (musicbrainz_id IS NULL OR musicbrainz_id=$3)`,
      [runId, candidateId, recordingId.toLowerCase()],
    );
  }

  async getAppleCatalogCacheEntry(
    storefront: string,
    resourceKind: AppleCatalogCacheResourceKind,
    requestFingerprint: string,
  ): Promise<AppleCatalogCacheEntry | null> {
    assertAppleCatalogCacheIdentity(storefront, resourceKind, requestFingerprint);
    const result = await this.pool.query<{
      storefront: string;
      resource_kind: AppleCatalogCacheResourceKind;
      request_fingerprint: string;
      payload_json: unknown;
      fetched_at: Date;
      expires_at: Date;
    }>(
      `SELECT storefront,resource_kind,request_fingerprint,payload_json,fetched_at,expires_at
       FROM apple_catalog_cache_entries
       WHERE storefront=$1 AND resource_kind=$2 AND request_fingerprint=$3`,
      [storefront.toLowerCase(), resourceKind, requestFingerprint],
    );
    const row = result.rows[0];
    return row ? {
      storefront: row.storefront,
      resourceKind: row.resource_kind,
      requestFingerprint: row.request_fingerprint,
      payload: row.payload_json,
      fetchedAt: row.fetched_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    } : null;
  }

  async putAppleCatalogCacheEntry(entry: AppleCatalogCacheWrite): Promise<void> {
    assertAppleCatalogCacheIdentity(entry.storefront, entry.resourceKind, entry.requestFingerprint);
    const fetchedAt = new Date(entry.fetchedAt);
    const expiresAt = new Date(entry.expiresAt);
    if (!Number.isFinite(fetchedAt.getTime()) || !Number.isFinite(expiresAt.getTime())) {
      throw new HttpError(400, "Apple catalog cache timestamps are invalid", "invalid_catalog_cache_entry");
    }
    const payload = JSON.stringify(entry.payload);
    if (payload === undefined || payload.length > 8 * 1024 * 1024) {
      throw new HttpError(400, "Apple catalog cache payload is invalid", "invalid_catalog_cache_entry");
    }
    await this.pool.query(
      `INSERT INTO apple_catalog_cache_entries(
         storefront,resource_kind,request_fingerprint,payload_json,fetched_at,expires_at)
       VALUES($1,$2,$3,$4::jsonb,$5,$6)
       ON CONFLICT(storefront,resource_kind,request_fingerprint) DO UPDATE SET
         payload_json=EXCLUDED.payload_json,fetched_at=EXCLUDED.fetched_at,
         expires_at=EXCLUDED.expires_at,updated_at=now()`,
      [
        entry.storefront.toLowerCase(),
        entry.resourceKind,
        entry.requestFingerprint,
        payload,
        fetchedAt,
        expiresAt,
      ],
    );
  }

  async deleteAppleCatalogCacheEntry(
    storefront: string,
    resourceKind: AppleCatalogCacheResourceKind,
    requestFingerprint: string,
  ): Promise<void> {
    assertAppleCatalogCacheIdentity(storefront, resourceKind, requestFingerprint);
    await this.pool.query(
      `DELETE FROM apple_catalog_cache_entries
       WHERE storefront=$1 AND resource_kind=$2 AND request_fingerprint=$3`,
      [storefront.toLowerCase(), resourceKind, requestFingerprint],
    );
  }

  async recordAppleCatalogCacheEvent(event: AppleCatalogCacheEvent): Promise<void> {
    assertAppleCatalogCacheIdentity(event.storefront, event.resourceKind, event.requestFingerprint);
    const occurredAt = new Date(event.occurredAt);
    if (!Number.isFinite(occurredAt.getTime())) {
      throw new HttpError(400, "Apple catalog cache event timestamp is invalid", "invalid_catalog_cache_event");
    }
    const detail = JSON.stringify(event.detail);
    if (detail === undefined || detail.length > 20_000) {
      throw new HttpError(400, "Apple catalog cache event detail is invalid", "invalid_catalog_cache_event");
    }
    await this.pool.query(
      `INSERT INTO apple_catalog_cache_events(
         id,run_id,storefront,resource_kind,request_fingerprint,
         cache_state,provider_state,detail_json,occurred_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
      [
        randomUUID(),
        event.runId,
        event.storefront.toLowerCase(),
        event.resourceKind,
        event.requestFingerprint,
        event.cacheState,
        event.providerState,
        detail,
        occurredAt,
      ],
    );
    if (Number(await this.getSchemaVersion() ?? 0) >= 16) {
      const eventIdentity = sha256Hex(stableStringify({
        runId: event.runId,
        storefront: event.storefront.toLowerCase(),
        resourceKind: event.resourceKind,
        requestFingerprint: event.requestFingerprint,
        cacheState: event.cacheState,
        providerState: event.providerState,
        occurredAt: occurredAt.toISOString(),
      }));
      await this.recordProviderMetric({
        runId: event.runId,
        provider: "apple",
        operation: event.resourceKind,
        stageKey: "catalog_resolution",
        metricName: "provider_requests",
        metricValue: event.providerState === "skipped" ? 0 : 1,
        requestOutcome: event.providerState,
        cacheOutcome: event.cacheState,
        idempotencyKey: `apple:${eventIdentity}`,
        occurredAt,
      });
      await this.recordRunSourceObservation({
        runId: event.runId,
        idempotencyKey: `apple-source:${eventIdentity}`,
        allowedHost: "api.music.apple.com",
        resourceType: event.resourceKind,
        extractionMethod: "apple_catalog_api",
        attemptOutcome: `${event.cacheState}:${event.providerState}`,
        locator: event.requestFingerprint,
        startedAt: occurredAt,
        completedAt: occurredAt,
      });
    }
  }

  async tryAcquireAppleCatalogCacheLease(
    storefront: string,
    resourceKind: AppleCatalogCacheResourceKind,
    requestFingerprint: string,
    ownerId: string,
    leaseMs: number,
  ): Promise<boolean> {
    assertAppleCatalogCacheIdentity(storefront, resourceKind, requestFingerprint);
    if (!UUID_PATTERN.test(ownerId)) {
      throw new HttpError(400, "Apple catalog cache lease owner is invalid", "invalid_catalog_cache_lease");
    }
    const boundedLeaseMs = Math.min(120_000, Math.max(5_000, Math.floor(leaseMs)));
    if (!Number.isFinite(boundedLeaseMs)) {
      throw new HttpError(400, "Apple catalog cache lease duration is invalid", "invalid_catalog_cache_lease");
    }
    const result = await this.pool.query<{ owner_id: string }>(
      `INSERT INTO apple_catalog_cache_leases(
         storefront,resource_kind,request_fingerprint,owner_id,acquired_at,expires_at,updated_at)
       VALUES($1,$2,$3,$4,now(),now()+($5::text || ' milliseconds')::interval,now())
       ON CONFLICT(storefront,resource_kind,request_fingerprint) DO UPDATE SET
         owner_id=EXCLUDED.owner_id,acquired_at=EXCLUDED.acquired_at,
         expires_at=EXCLUDED.expires_at,updated_at=now()
       WHERE apple_catalog_cache_leases.expires_at <= now()
          OR apple_catalog_cache_leases.owner_id=EXCLUDED.owner_id
       RETURNING owner_id`,
      [storefront.toLowerCase(), resourceKind, requestFingerprint, ownerId, boundedLeaseMs],
    );
    return result.rows[0]?.owner_id === ownerId;
  }

  async releaseAppleCatalogCacheLease(
    storefront: string,
    resourceKind: AppleCatalogCacheResourceKind,
    requestFingerprint: string,
    ownerId: string,
  ): Promise<void> {
    assertAppleCatalogCacheIdentity(storefront, resourceKind, requestFingerprint);
    if (!UUID_PATTERN.test(ownerId)) {
      throw new HttpError(400, "Apple catalog cache lease owner is invalid", "invalid_catalog_cache_lease");
    }
    await this.pool.query(
      `DELETE FROM apple_catalog_cache_leases
       WHERE storefront=$1 AND resource_kind=$2 AND request_fingerprint=$3 AND owner_id=$4`,
      [storefront.toLowerCase(), resourceKind, requestFingerprint, ownerId],
    );
  }

  async cleanupExpiredAppleCatalogCacheLeases(limit = 1_000): Promise<number> {
    const boundedLimit = Math.min(10_000, Math.max(1, Math.floor(limit)));
    if (!Number.isFinite(boundedLimit)) {
      throw new HttpError(400, "Apple catalog cache cleanup limit is invalid", "invalid_catalog_cache_lease");
    }
    const result = await this.pool.query(
      `WITH expired AS (
         SELECT storefront,resource_kind,request_fingerprint
         FROM apple_catalog_cache_leases
         WHERE expires_at <= now()
         ORDER BY expires_at ASC
         LIMIT $1
       )
       DELETE FROM apple_catalog_cache_leases target
       USING expired
       WHERE target.storefront=expired.storefront
         AND target.resource_kind=expired.resource_kind
         AND target.request_fingerprint=expired.request_fingerprint`,
      [boundedLimit],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Persist the immutable, versioned interpretation consumed by Pipeline V2.
   * This is intentionally separate from brief_json so legacy workers can keep
   * reading the confirmed brief during an expand/contract rollout.
   */
  async savePipelineSelectionPlan(runId: string, plan: SelectionPlan): Promise<void> {
    await this.transaction(async (client) => {
      const selected = await client.query<{
        brief_json: PlaylistBrief;
        guidance_telemetry_json: PlaylistGuidanceTelemetry | null;
        pipeline_version: string;
        policy_version: string;
        selection_plan_json: SelectionPlan | null;
        pipeline_policy_snapshot_json: PipelinePolicySnapshot | null;
      }>(
        `SELECT brief_json,guidance_telemetry_json,pipeline_version,policy_version,
                selection_plan_json,pipeline_policy_snapshot_json
         FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [runId],
      );
      const run = selected.rows[0];
      if (!run) throw new HttpError(404, "Research run not found", "run_not_found");
      if (run.pipeline_version !== "legacy_v1" && (
        run.pipeline_version !== plan.pipelineVersion || run.policy_version !== plan.policyVersion
      )) {
        throw new HttpError(409, "Pipeline versions are immutable after assignment", "pipeline_policy_mismatch");
      }
      if (run.selection_plan_json
        && stableStringify(run.selection_plan_json) !== stableStringify(plan)) {
        throw new HttpError(409, "Pipeline selection plan is immutable after assignment", "pipeline_plan_immutable");
      }
      const policySnapshot = run.pipeline_policy_snapshot_json ?? createPipelinePolicySnapshot({
        brief: run.brief_json,
        selectionPlan: plan,
        environment: process.env,
        modelRoutingSignals: { scoutTelemetry: run.guidance_telemetry_json },
      });
      if (policySnapshot.pipelineVersion !== plan.pipelineVersion
        || policySnapshot.policyVersion !== plan.policyVersion) {
        throw new HttpError(409, "Pipeline policy snapshot does not match the selection plan", "pipeline_policy_mismatch");
      }
      await client.query(
        `UPDATE research_runs SET pipeline_version=$2,policy_version=$3,
           selection_plan_json=$4,pipeline_policy_snapshot_json=$5,updated_at=now()
         WHERE id=$1`,
        [
          runId,
          plan.pipelineVersion,
          plan.policyVersion,
          JSON.stringify(plan),
          JSON.stringify(policySnapshot),
        ],
      );
    });
  }

  async getPipelineOutcome(runId: string): Promise<PipelineOutcome | null> {
    const result = await this.pool.query<{ outcome_json: PipelineOutcome }>(
      "SELECT outcome_json FROM pipeline_outcomes WHERE run_id=$1",
      [runId],
    );
    return result.rows[0]?.outcome_json ?? null;
  }

  /** Store a final or partial outcome without collapsing its deficit history. */
  async savePipelineOutcome(runId: string, outcome: PipelineOutcome): Promise<void> {
    await this.transaction(async (client) => {
      await persistPipelineOutcomeTransaction(client, runId, outcome);
    });
  }

  /**
   * Summarize one completed UTC window of durable Pipeline V2 telemetry and
   * enqueue owner alerts. Notification dedupe keys are tied to the closed
   * window, so retries and overlapping workers remain idempotent.
   */
  async runPipelineV2OperationalAlertSweep(input: {
    windowHours?: number;
    windowEndedAt?: Date;
  } = {}): Promise<PipelineOperationalSweepResult> {
    const windowHours = Number.isFinite(input.windowHours)
      ? Math.max(1, Math.min(24, Math.floor(input.windowHours!)))
      : 1;
    const requestedEnd = input.windowEndedAt ?? new Date();
    if (!Number.isFinite(requestedEnd.getTime())) {
      throw new HttpError(400, "Pipeline alert window is invalid", "invalid_pipeline_alert_window");
    }
    const windowEnd = new Date(requestedEnd);
    windowEnd.setUTCMinutes(0, 0, 0);
    const windowStart = new Date(windowEnd.getTime() - windowHours * 60 * 60 * 1_000);

    const result = await this.pool.query<{
      terminal_runs: number;
      zero_result_runs: number;
      partial_runs: number;
      shortfall_runs: number;
      system_failure_runs: number;
      integrity_failure_runs: number;
      brief_failures: number;
      guidance_failures: number;
      stuck_work_items: number;
      local_contract_rejections: number;
      provider_circuit_openings: number;
      pagination_loops: number;
      endpoint_drift_events: number;
      publication_divergences: number;
    }>(
      `WITH recent_outcomes AS (
         SELECT r.id,po.id outcome_id,coalesce(po.status,r.status) status,
                r.status run_status,r.phase run_phase,
                coalesce(po.published_track_count,0) published_track_count,
                coalesce(po.reason_codes_json,'[]'::jsonb) reason_codes_json
         FROM research_runs r
         LEFT JOIN pipeline_outcomes po ON po.run_id=r.id
         WHERE r.pipeline_version<>'legacy_v1'
           AND coalesce(r.completed_at,r.updated_at) >= $1
           AND coalesce(r.completed_at,r.updated_at) < $2
           AND r.status IN (
             'complete','partial','no_compatible_tracks','failed',
             'failed_system','failed_integrity','expired','deleted'
           )
       ), outcome_signals AS (
         SELECT 'outcome:' || ro.id::text || ':' || reason signal_id,lower(reason) signal
         FROM recent_outcomes ro
         CROSS JOIN LATERAL jsonb_array_elements_text(ro.reason_codes_json) AS reasons(reason)
       ), recent_brief_failures AS (
         SELECT id,brief_contract_version,questions_json,guidance_telemetry_json,error
         FROM brief_requests
         WHERE status='failed' AND updated_at >= $1 AND updated_at < $2
       ), stuck_work AS (
         SELECT 'run:'||id::text work_id
         FROM research_runs
         WHERE deleted_at IS NULL
           AND created_at < $2
           AND updated_at < least($2,now())-interval '30 minutes'
           AND status IN (
             'queued','researching','ready_for_matching','matching',
             'manifest_ready','publishing'
           )
         UNION
         SELECT 'brief:'||id::text work_id
         FROM brief_requests
         WHERE created_at < $2
           AND updated_at < least($2,now())-interval '15 minutes'
           AND status IN ('queued','finalizing')
         UNION
         SELECT 'job:'||id::text work_id
         FROM job_queue
         WHERE created_at < $2
           AND (
             (status='queued' AND created_at < least($2,now())-interval '15 minutes')
             OR (status='leased' AND lease_expires_at < least($2,now()))
           )
       ), audit_signals AS (
         SELECT 'audit:' || ae.id::text signal_id,
                lower(ae.action || ':' || coalesce(
                  ae.detail_json->>'reasonCode',ae.detail_json->>'reason_code',
                  ae.detail_json->>'code',ae.detail_json->>'kind','')) signal
         FROM audit_events ae
         JOIN research_runs r ON r.id=ae.run_id
         WHERE r.pipeline_version<>'legacy_v1'
           AND ae.occurred_at >= $1 AND ae.occurred_at < $2
       ), checkpoint_signals AS (
         SELECT 'checkpoint:' || rc.run_id::text || ':' || rc.phase signal_id,
                lower(rc.phase || ':' || coalesce(
                  rc.state_json->>'status',rc.state_json->>'contractCode',
                  rc.state_json->>'reasonCode',rc.state_json->>'error','')) signal
         FROM research_checkpoints rc
         JOIN research_runs r ON r.id=rc.run_id
         WHERE r.pipeline_version<>'legacy_v1'
           AND rc.updated_at >= $1 AND rc.updated_at < $2
           AND (rc.state_json->>'status'='contract_error'
             OR rc.state_json ? 'contractError'
             OR lower(coalesce(rc.state_json->>'error','')) LIKE '%pagination%loop%'
             OR lower(coalesce(rc.state_json->>'error','')) LIKE '%cursor%loop%')
       ), durable_signals AS (
         SELECT * FROM outcome_signals
         UNION ALL
         SELECT * FROM audit_signals
         UNION ALL
         SELECT * FROM checkpoint_signals
       ), cache_signals AS (
         SELECT ace.id,ace.provider_state,
                lower(coalesce(ace.detail_json->>'errorName','')) error_name,
                lower(coalesce(ace.detail_json->>'errorMessage','')) error_message
         FROM apple_catalog_cache_events ace
         JOIN research_runs r ON r.id=ace.run_id
         WHERE r.pipeline_version<>'legacy_v1'
           AND ace.occurred_at >= $1 AND ace.occurred_at < $2
       ), publication_signals AS (
         SELECT n.id FROM notification_outbox n
         JOIN research_runs r ON r.id::text=n.payload_json->>'runId'
         WHERE r.pipeline_version<>'legacy_v1'
           AND n.kind='publication_orphaned' AND n.created_at >= $1 AND n.created_at < $2
       )
       SELECT
         (SELECT count(*)::int FROM recent_outcomes) terminal_runs,
         (SELECT count(*)::int FROM recent_outcomes
          WHERE status='no_compatible_tracks' OR run_status='no_compatible_tracks') zero_result_runs,
         (SELECT count(*)::int FROM recent_outcomes
          WHERE status LIKE 'partial_%'
             OR (run_status='partial' AND outcome_id IS NULL)) partial_runs,
         (SELECT count(*)::int FROM recent_outcomes
          WHERE status LIKE 'partial_%'
             OR status='no_compatible_tracks'
             OR (run_status='partial' AND outcome_id IS NULL)) shortfall_runs,
         (SELECT count(*)::int FROM recent_outcomes
          WHERE run_status='failed_system'
             OR (run_status='failed' AND coalesce(run_phase,'') NOT IN (
               'owner_cancelled','visitor_deleted','cancelled','deleted','expired',
               'apple_authorization','apple_reauthorization','waiting_for_apple_authorization'
             ))) system_failure_runs,
         (SELECT count(*)::int FROM recent_outcomes
          WHERE run_status='failed_integrity' OR status='failed_integrity') integrity_failure_runs,
         (SELECT count(*)::int FROM recent_brief_failures) brief_failures,
         (SELECT count(*)::int FROM recent_brief_failures
          WHERE brief_contract_version>=2
            AND (
              questions_json IS NOT NULL OR guidance_telemetry_json IS NOT NULL
              OR lower(coalesce(error,'')) LIKE '%guidance%'
              OR lower(coalesce(error,'')) LIKE '%question%'
              OR lower(coalesce(error,'')) LIKE '%scout%'
            )) guidance_failures,
         (SELECT count(*)::int FROM stuck_work) stuck_work_items,
         (SELECT count(*)::int FROM durable_signals
          WHERE signal LIKE '%local_contract%' OR signal LIKE '%contract_reject%') local_contract_rejections,
         ((SELECT count(*)::int FROM durable_signals
           WHERE signal LIKE '%circuit_open%')
          + (SELECT count(*)::int FROM cache_signals
             WHERE provider_state='circuit_open'
                OR error_name LIKE '%circuit%open%'
                OR error_message LIKE '%circuit%open%')) provider_circuit_openings,
         ((SELECT count(*)::int FROM durable_signals
           WHERE signal LIKE '%pagination_loop%' OR signal LIKE '%cursor_loop%')
          + (SELECT count(*)::int FROM cache_signals
             WHERE error_message LIKE '%pagination%loop%' OR error_message LIKE '%cursor%loop%')) pagination_loops,
         ((SELECT count(*)::int FROM durable_signals
           WHERE signal LIKE '%endpoint_drift%')
          + (SELECT count(*)::int FROM cache_signals
             WHERE provider_state='invalid')) endpoint_drift_events,
         ((SELECT count(*)::int FROM publication_signals)
          + (SELECT count(*)::int FROM durable_signals
             WHERE signal LIKE '%publication_divergence%')) publication_divergences`,
      [windowStart, windowEnd],
    );
    const row = result.rows[0] ?? {
      terminal_runs: 0,
      zero_result_runs: 0,
      partial_runs: 0,
      shortfall_runs: 0,
      system_failure_runs: 0,
      integrity_failure_runs: 0,
      brief_failures: 0,
      guidance_failures: 0,
      stuck_work_items: 0,
      local_contract_rejections: 0,
      provider_circuit_openings: 0,
      pagination_loops: 0,
      endpoint_drift_events: 0,
      publication_divergences: 0,
    };
    const window: PipelineOperationalWindow = {
      windowStartedAt: windowStart.toISOString(),
      windowEndedAt: windowEnd.toISOString(),
      terminalRuns: Number(row.terminal_runs ?? 0),
      zeroResultRuns: Number(row.zero_result_runs ?? 0),
      partialRuns: Number(row.partial_runs ?? 0),
      shortfallRuns: Number(row.shortfall_runs ?? 0),
      systemFailureRuns: Number(row.system_failure_runs ?? 0),
      integrityFailureRuns: Number(row.integrity_failure_runs ?? 0),
      briefFailures: Number(row.brief_failures ?? 0),
      guidanceFailures: Number(row.guidance_failures ?? 0),
      stuckWorkItems: Number(row.stuck_work_items ?? 0),
      localContractRejections: Number(row.local_contract_rejections ?? 0),
      providerCircuitOpenings: Number(row.provider_circuit_openings ?? 0),
      paginationLoops: Number(row.pagination_loops ?? 0),
      endpointDriftEvents: Number(row.endpoint_drift_events ?? 0),
      publicationDivergences: Number(row.publication_divergences ?? 0),
    };
    const alerts = evaluatePipelineOperationalWindow(window);
    const notificationIds: string[] = [];
    for (const alert of alerts) {
      notificationIds.push(await this.enqueueNotification(alert.kind, {
        deduplicationKey: `pipeline-v2-alert:${alert.kind}:${window.windowStartedAt}`,
        ...alert,
        terminalRuns: window.terminalRuns,
        pipelineVersion: "catalog_first_v2",
      }));
    }
    await this.pool.query(
      `INSERT INTO settings(key,value) VALUES('pipeline_v2_alert_last_window_end',$1)
       ON CONFLICT(key) DO UPDATE SET value=GREATEST(settings.value,EXCLUDED.value),updated_at=now()`,
      [window.windowEndedAt],
    );
    return { window, alerts, notificationIds };
  }

  /**
   * Seal publication state and its monotonic outcome projection atomically.
   * The revision's ordered tracks and content hash are deliberately excluded
   * from this update: publication may annotate a locked revision, never mutate it.
   */
  async sealManifestRevisionPublication(
    runId: string,
    revisionId: string,
    outcome: PipelineOutcome,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const merged = await persistPipelineOutcomeTransaction(client, runId, outcome);
      const revision = await client.query<{
        pipeline_version: PipelineVersion;
        policy_version: PipelinePolicyVersion;
        status: ManifestRevisionStatus;
      }>(
        `SELECT mr.pipeline_version,mr.policy_version,mr.status
         FROM manifest_revisions mr
         JOIN manifests m ON m.id=mr.manifest_id
         WHERE mr.id=$2 AND m.run_id=$1 FOR UPDATE OF mr`,
        [runId, revisionId],
      );
      const row = revision.rows[0];
      if (!row) throw new HttpError(404, "Manifest revision not found", "manifest_revision_not_found");
      if (row.pipeline_version !== outcome.pipelineVersion || row.policy_version !== outcome.policyVersion) {
        throw new HttpError(409, "Publication outcome versions do not match the locked revision", "pipeline_policy_mismatch");
      }
      if (row.status !== "locked" && row.status !== "published") {
        throw new HttpError(409, "Only a locked manifest revision can be published", "manifest_revision_not_locked");
      }
      await client.query(
        `UPDATE manifest_revisions SET status='published',
           outcome_snapshot_json=$3::jsonb,deficit_snapshot_json=$4::jsonb,
           locked_at=COALESCE(locked_at,now())
         WHERE id=$2 AND manifest_id IN (SELECT id FROM manifests WHERE run_id=$1)`,
        [runId, revisionId, JSON.stringify(merged), JSON.stringify(merged.deficits)],
      );
    });
  }

  async upsertRecordingFamily(
    runId: string,
    input: Pick<
      RecordingFamily,
      "familyKey" | "canonicalArtist" | "canonicalTitle" | "versionClass" | "metadata" | "pipelineVersion" | "policyVersion"
    > & { id?: string },
  ): Promise<string> {
    const id = input.id ?? randomUUID();
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO recording_families(
         id,run_id,family_key,canonical_artist,canonical_title,version_class,metadata_json,
         pipeline_version,policy_version)
       SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9
       FROM research_runs r WHERE r.id=$2 AND r.deleted_at IS NULL
       ON CONFLICT(run_id,family_key) DO UPDATE SET
         canonical_artist=EXCLUDED.canonical_artist,canonical_title=EXCLUDED.canonical_title,
         version_class=EXCLUDED.version_class,metadata_json=EXCLUDED.metadata_json,
         pipeline_version=EXCLUDED.pipeline_version,policy_version=EXCLUDED.policy_version,updated_at=now()
       RETURNING id`,
      [
        id,
        runId,
        input.familyKey,
        input.canonicalArtist,
        input.canonicalTitle,
        input.versionClass,
        JSON.stringify(input.metadata),
        input.pipelineVersion,
        input.policyVersion,
      ],
    );
    if (!result.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
    return result.rows[0].id;
  }

  async attachCandidateToRecordingFamily(
    runId: string,
    recordingFamilyId: string,
    candidateId: string,
    relationship = "member",
  ): Promise<void> {
    await this.transaction(async (client) => {
      const owned = await client.query(
        `SELECT rf.id FROM recording_families rf
         JOIN track_candidates tc ON tc.id=$3 AND tc.run_id=rf.run_id
         WHERE rf.id=$2 AND rf.run_id=$1 FOR UPDATE OF rf,tc`,
        [runId, recordingFamilyId, candidateId],
      );
      if (!owned.rows[0]) throw new HttpError(404, "Recording family or candidate not found", "recording_identity_not_found");
      await client.query(
        `INSERT INTO recording_family_candidates(recording_family_id,candidate_id,relationship)
         VALUES($1,$2,$3)
         ON CONFLICT(candidate_id) DO UPDATE SET
           recording_family_id=EXCLUDED.recording_family_id,relationship=EXCLUDED.relationship`,
        [recordingFamilyId, candidateId, relationship],
      );
      await client.query(
        "UPDATE track_candidates SET recording_family_id=$2 WHERE id=$1 AND run_id=$3",
        [candidateId, recordingFamilyId, runId],
      );
    });
  }

  async upsertAlternateCatalogIdentity(runId: string, input: AlternateCatalogIdentity): Promise<string> {
    if (!Number.isFinite(input.identityConfidence) || input.identityConfidence < 0 || input.identityConfidence > 1) {
      throw new HttpError(400, "Catalog identity confidence must be between zero and one", "invalid_catalog_identity");
    }
    return this.transaction(async (client) => {
      const family = await client.query(
        "SELECT id FROM recording_families WHERE id=$1 AND run_id=$2 FOR UPDATE",
        [input.recordingFamilyId, runId],
      );
      if (!family.rows[0]) throw new HttpError(404, "Recording family not found", "recording_family_not_found");
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM recording_catalog_identities
         WHERE recording_family_id=$1 AND provider=$2 AND storefront IS NOT DISTINCT FROM $3 AND catalog_id=$4`,
        [input.recordingFamilyId, input.provider, input.storefront, input.catalogId],
      );
      const id = existing.rows[0]?.id ?? input.id ?? randomUUID();
      if (input.isPreferred) {
        await client.query(
          "UPDATE recording_catalog_identities SET is_preferred=false,updated_at=now() WHERE recording_family_id=$1 AND provider=$2 AND id<>$3",
          [input.recordingFamilyId, input.provider, id],
        );
      }
      if (existing.rows[0]) {
        await client.query(
          `UPDATE recording_catalog_identities SET is_preferred=$2,identity_confidence=$3,
             artist=$4,title=$5,album=$6,isrc=$7,musicbrainz_id=$8,duration_ms=$9,
             version_label=$10,metadata_json=$11::jsonb,updated_at=now() WHERE id=$1`,
          [
            id,
            input.isPreferred,
            input.identityConfidence,
            input.artist,
            input.title,
            input.album,
            input.isrc,
            input.musicbrainzId,
            input.durationMs,
            input.versionLabel,
            JSON.stringify(input.metadata),
          ],
        );
      } else {
        await client.query(
          `INSERT INTO recording_catalog_identities(
             id,recording_family_id,provider,storefront,catalog_id,is_preferred,identity_confidence,
             artist,title,album,isrc,musicbrainz_id,duration_ms,version_label,metadata_json)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
          [
            id,
            input.recordingFamilyId,
            input.provider,
            input.storefront,
            input.catalogId,
            input.isPreferred,
            input.identityConfidence,
            input.artist,
            input.title,
            input.album,
            input.isrc,
            input.musicbrainzId,
            input.durationMs,
            input.versionLabel,
            JSON.stringify(input.metadata),
          ],
        );
      }
      return id;
    });
  }

  async saveTrackScopeBindings(
    runId: string,
    candidateId: string,
    bindings: readonly TrackScopeBinding[],
    versions: Pick<SelectionPlan, "pipelineVersion" | "policyVersion">,
  ): Promise<void> {
    boundedPipelineBatch(bindings, 200, "Track scope bindings");
    await this.transaction(async (client) => {
      for (const binding of bindings) {
        if (!Number.isFinite(binding.confidence) || binding.confidence < 0 || binding.confidence > 1) {
          throw new HttpError(400, "Scope-binding confidence must be between zero and one", "invalid_scope_binding");
        }
        if (binding.sourceUrl) assertPublicHttpsUrl(binding.sourceUrl);
        const provenancePath = provenancePathWithGeographyRelationship(
          binding.provenancePath,
          binding.geographyRelationship,
        );
        const id = deterministicUuid({
          runId,
          candidateId,
          bindingKind: binding.bindingKind,
          scopeAxis: binding.scopeAxis,
          scopeValue: binding.scopeValue,
          geographyRelationship: binding.geographyRelationship ?? null,
          relationship: binding.relationship,
          sourceRecordId: binding.sourceRecordId,
          researchContainerId: binding.researchContainerId,
        });
        const inserted = await client.query(
          `INSERT INTO track_scope_bindings(
             id,run_id,candidate_id,source_record_id,source_url,research_container_id,
             citation_attestation_id,binding_kind,eligibility,scope_axis,scope_value,
             relationship,confidence,provenance_path_json,note,pipeline_version,policy_version)
           SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17
           FROM track_candidates tc
           WHERE tc.id=$3 AND tc.run_id=$2
             AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM source_records sr WHERE sr.id=$4 AND sr.run_id=$2))
             AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM research_containers rc WHERE rc.id=$6 AND rc.run_id=$2))
             AND ($7::uuid IS NULL OR EXISTS(SELECT 1 FROM citation_attestations ca WHERE ca.id=$7 AND ca.run_id=$2))
           ON CONFLICT ON CONSTRAINT scope_binding_unique_key DO UPDATE SET
             source_record_id=EXCLUDED.source_record_id,source_url=EXCLUDED.source_url,
             research_container_id=EXCLUDED.research_container_id,
             citation_attestation_id=EXCLUDED.citation_attestation_id,
             eligibility=EXCLUDED.eligibility,confidence=EXCLUDED.confidence,
             provenance_path_json=EXCLUDED.provenance_path_json,note=EXCLUDED.note,
             pipeline_version=EXCLUDED.pipeline_version,policy_version=EXCLUDED.policy_version
           RETURNING id`,
          [
            id,
            runId,
            candidateId,
            binding.sourceRecordId,
            binding.sourceUrl,
            binding.researchContainerId,
            binding.citationAttestationId,
            binding.bindingKind,
            binding.eligibility,
            binding.scopeAxis,
            binding.scopeValue,
            binding.relationship,
            binding.confidence,
            JSON.stringify(provenancePath),
            binding.note,
            versions.pipelineVersion,
            versions.policyVersion,
          ],
        );
        if (!inserted.rows[0]) {
          throw new HttpError(400, "Scope binding references data outside this research run", "invalid_scope_binding");
        }
      }
    });
  }

  /**
   * Atomically promote exact Apple identities discovered inside a trusted,
   * scoped editorial container. Search results alone cannot call this path:
   * every row must carry a durable Apple source and qualifying container
   * membership, which are persisted before the candidate becomes eligible.
   */
  async persistCatalogDiscoveredCandidates(
    runId: string,
    candidates: readonly CatalogDiscoveredCandidateInput[],
    versions: Pick<SelectionPlan, "pipelineVersion" | "policyVersion">,
  ): Promise<CatalogDiscoveredCandidateResult[]> {
    boundedPipelineBatch(candidates, 200, "Catalog-discovered candidates");
    if (candidates.length === 0) return [];
    return this.transaction(async (client) => {
      const run = await client.query<{
        pipeline_version: string | null;
        policy_version: string | null;
        selection_plan_json: SelectionPlan | null;
      }>(
        `SELECT pipeline_version,policy_version,selection_plan_json
         FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [runId],
      );
      const stored = run.rows[0];
      const plan = stored?.selection_plan_json;
      if (!stored || !plan) throw new HttpError(404, "Pipeline V2 research run not found", "run_not_found");
      if (plan.pipelineVersion !== versions.pipelineVersion
        || plan.policyVersion !== versions.policyVersion
        || stored.pipeline_version !== versions.pipelineVersion
        || stored.policy_version !== versions.policyVersion) {
        throw new HttpError(409, "Catalog discovery policy does not match the persisted run", "pipeline_policy_mismatch");
      }

      const normalizedByIdentity = new Map<string, CatalogDiscoveredCandidateInput & { candidate: TrackCandidateInput }>();
      for (const input of candidates) {
        const sourceUrl = assertPublicHttpsUrl(input.source.url).toString();
        if (input.source.sourceClass !== "apple"
          || !sourceUrl.startsWith("https://music.apple.com/")) {
          throw new HttpError(400, "Catalog discovery requires an Apple Music editorial source", "invalid_catalog_scope_source");
        }
        if (!/^pl\.[A-Za-z0-9_-]{1,200}$/u.test(input.container.providerId)
          || !new URL(sourceUrl).pathname.split("/").includes(input.container.providerId)
          || input.source.provenanceRoot !== `apple_music_editorial:${input.container.providerId}`
          || input.bindings.length === 0
          || input.bindings.length > 16
          || input.bindings.some((binding) => (
            binding.bindingKind !== "catalog_editorial_membership"
            || binding.eligibility !== "qualifying"
            || binding.sourceUrl !== sourceUrl
            || !binding.scopeValue.trim()
            || !binding.relationship.trim()
            || !Number.isFinite(binding.confidence)
            || binding.confidence < 0.7
            || binding.confidence > 1
          ))
          || !input.song.id.trim()
          || !input.song.artistName.trim()
          || !input.song.name.trim()) {
          throw new HttpError(400, "Catalog discovery scope binding is invalid", "invalid_catalog_scope_binding");
        }
        const candidate: TrackCandidateInput = {
          artist: input.song.artistName,
          title: input.song.name,
          album: input.song.albumName || null,
          releaseYear: input.song.releaseDate ? Number.parseInt(input.song.releaseDate.slice(0, 4), 10) || null : null,
          durationMs: input.song.durationInMillis ?? null,
          isrc: input.song.isrc ?? null,
          musicbrainzId: null,
          versionLabel: input.song.versionLabel ?? null,
          candidateStage: "scope_qualified",
          evidence: [],
        };
        const normalized = { ...input, source: { ...input.source, url: sourceUrl }, candidate };
        // Multiple Apple catalog rows may describe the same stable recording
        // (most commonly the same ISRC on several releases). Candidate growth
        // is recording-oriented, so persist one deterministic row per identity
        // and let catalog-identity enrichment retain compatible alternates.
        const identityKey = candidateIdentityKey(candidate);
        if (!normalizedByIdentity.has(identityKey)) normalizedByIdentity.set(identityKey, normalized);
      }
      const normalized = [...normalizedByIdentity.values()];
      const keys = normalized.map((input) => candidateIdentityKey(input.candidate));
      const before = await client.query<{ canonical_key: string }>(
        "SELECT canonical_key FROM track_candidates WHERE run_id=$1 AND canonical_key=ANY($2::text[])",
        [runId, keys],
      );
      const existingKeys = new Set(before.rows.map((row) => row.canonical_key));
      const sourceIds = await this.addSourcesInTransaction(
        client,
        runId,
        [...new Map(normalized.map((input) => [input.source.url, input.source])).values()],
      );
      await this.addCandidatesInTransaction(
        client,
        runId,
        normalized.map((input) => input.candidate),
        sourceIds,
        "catalog_enrichment",
      );

      const output: CatalogDiscoveredCandidateResult[] = [];
      for (const input of normalized) {
        const canonicalKey = candidateIdentityKey(input.candidate);
        const candidate = await client.query<{
          id: string;
          candidate_stage: TrackCandidateInput["candidateStage"];
          stage_updated_at: Date;
        }>(
          `SELECT id,candidate_stage,stage_updated_at FROM track_candidates
           WHERE run_id=$1 AND canonical_key=$2 FOR UPDATE`,
          [runId, canonicalKey],
        );
        const row = candidate.rows[0];
        const sourceRecordId = sourceIds.get(input.source.url);
        if (!row || !sourceRecordId) throw new Error("Catalog-discovered candidate persistence lost its source identity");
        const containerId = randomUUID();
        const container = await client.query<{ id: string }>(
          `INSERT INTO research_containers(
             id,run_id,source_record_id,container_type,provider_id,title,status,
             recovered_total,metadata_json,completed_at)
           VALUES($1,$2,$3,'collection',$4,$5,'complete',1,$6::jsonb,now())
           ON CONFLICT(run_id,container_type,provider_id) DO UPDATE SET
             source_record_id=EXCLUDED.source_record_id,title=EXCLUDED.title,status='complete',
             recovered_total=GREATEST(research_containers.recovered_total,EXCLUDED.recovered_total),
             metadata_json=research_containers.metadata_json||EXCLUDED.metadata_json,
             completed_at=COALESCE(research_containers.completed_at,now()),updated_at=now()
           RETURNING id`,
          [containerId, runId, sourceRecordId, input.container.providerId, input.container.title.slice(0, 240), JSON.stringify(input.container.metadata)],
        );
        const storedContainerId = container.rows[0]!.id;
        const scopeBindings: TrackScopeBinding[] = [];
        const bindingIds: string[] = [];
        for (const inputBinding of input.bindings) {
          const geographyRelationship = inputBinding.geographyRelationship
            ?? (inputBinding.scopeAxis === "language" ? "language" : null);
          const scopeBinding: TrackScopeBinding = {
            ...inputBinding,
            geographyRelationship,
            sourceRecordId,
            researchContainerId: storedContainerId,
            citationAttestationId: null,
            provenancePath: provenancePathWithGeographyRelationship([
              { kind: "provenance_root", id: input.source.provenanceRoot },
              { kind: "source_record", id: sourceRecordId },
              { kind: "research_container", id: storedContainerId, label: input.container.providerId },
              { kind: "catalog_recording", id: input.song.id, label: input.song.name },
            ], geographyRelationship),
          };
          const bindingId = deterministicUuid({
            runId,
            candidateId: row.id,
            bindingKind: scopeBinding.bindingKind,
            scopeAxis: scopeBinding.scopeAxis,
            scopeValue: scopeBinding.scopeValue,
            geographyRelationship: scopeBinding.geographyRelationship ?? null,
            relationship: scopeBinding.relationship,
            sourceRecordId,
            researchContainerId: storedContainerId,
          });
          await client.query(
            `INSERT INTO track_scope_bindings(
               id,run_id,candidate_id,source_record_id,source_url,research_container_id,
               citation_attestation_id,binding_kind,eligibility,scope_axis,scope_value,
               relationship,confidence,provenance_path_json,note,pipeline_version,policy_version)
             VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)
             ON CONFLICT ON CONSTRAINT scope_binding_unique_key DO UPDATE SET
               source_url=EXCLUDED.source_url,eligibility=EXCLUDED.eligibility,
               confidence=EXCLUDED.confidence,provenance_path_json=EXCLUDED.provenance_path_json,
               note=EXCLUDED.note,pipeline_version=EXCLUDED.pipeline_version,
               policy_version=EXCLUDED.policy_version`,
            [
              bindingId, runId, row.id, sourceRecordId, scopeBinding.sourceUrl, storedContainerId,
              scopeBinding.bindingKind, scopeBinding.eligibility, scopeBinding.scopeAxis,
              scopeBinding.scopeValue.slice(0, 240), scopeBinding.relationship.slice(0, 240),
              scopeBinding.confidence, JSON.stringify(scopeBinding.provenancePath),
              compactEvidenceNote(scopeBinding.note), versions.pipelineVersion, versions.policyVersion,
            ],
          );
          scopeBindings.push(scopeBinding);
          bindingIds.push(bindingId);
        }
        if (row.candidate_stage === "discovered" || row.candidate_stage === "identity_resolved") {
          const occurredAt = new Date(Math.max(Date.now(), row.stage_updated_at.getTime() + 1));
          await client.query(
            `INSERT INTO candidate_stage_events(
               id,run_id,candidate_id,from_stage,to_stage,reason_code,detail_json,
               pipeline_version,policy_version,occurred_at)
             VALUES($1,$2,$3,$4,'scope_qualified','catalog_editorial_membership',$5::jsonb,$6,$7,$8)
             ON CONFLICT(id) DO NOTHING`,
            [
              deterministicUuid({ runId, candidateId: row.id, bindingIds, toStage: "scope_qualified" }),
              runId, row.id, row.candidate_stage,
              JSON.stringify({ bindingIds, appleSongId: input.song.id, containerId: storedContainerId }),
              versions.pipelineVersion, versions.policyVersion, occurredAt,
            ],
          );
          await client.query(
            `UPDATE track_candidates SET candidate_stage='scope_qualified',stage_updated_at=$3,
               pipeline_version=$4,policy_version=$5
             WHERE id=$1 AND run_id=$2 AND candidate_stage IN ('discovered','identity_resolved')`,
            [row.id, runId, occurredAt, versions.pipelineVersion, versions.policyVersion],
          );
        }
        // The trusted editorial-container row already is an exact Apple
        // catalog identity. Persist that identity in the same transaction as
        // its source, container membership, scope binding, and candidate. A
        // worker can therefore be interrupted immediately after this method
        // returns without leaving a qualified candidate stranded between the
        // discovery and matching phases.
        const duplicate = await client.query(
          `SELECT 1 FROM catalog_matches
           WHERE run_id=$1 AND catalog_id=$2 AND status='accepted' AND candidate_id<>$3
           LIMIT 1`,
          [runId, input.song.id, row.id],
        );
        const matchStatus: CatalogMatchResult["status"] = duplicate.rows[0]
          ? "duplicate"
          : "accepted";
        const matchBasis = "Pipeline V2 exact Apple editorial-container identity";
        const exactMatchScore = normalizedCatalogMatchScore(100);
        await client.query(
          `INSERT INTO catalog_matches(
             id,run_id,candidate_id,status,basis,score,catalog_id,song_json,alternatives_json,
             initial_status,initial_basis,initial_score,initial_catalog_id,initial_song_json,initial_matched_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'[]'::jsonb,
                  $4,$5,$6,$7,$8::jsonb,now())
           ON CONFLICT(candidate_id) DO UPDATE SET
             status=EXCLUDED.status,basis=EXCLUDED.basis,score=EXCLUDED.score,
             catalog_id=EXCLUDED.catalog_id,song_json=EXCLUDED.song_json,
             alternatives_json=EXCLUDED.alternatives_json`,
          [
            randomUUID(),
            runId,
            row.id,
            matchStatus,
            matchBasis,
            exactMatchScore,
            input.song.id,
            JSON.stringify(input.song),
          ],
        );
        await client.query(
          "UPDATE track_candidates SET outcome=$1 WHERE id=$2 AND run_id=$3",
          [matchStatus, row.id, runId],
        );
        output.push({
          candidateId: row.id,
          appleSongId: input.song.id,
          inserted: !existingKeys.has(canonicalKey),
          scopeBindings,
        });
        existingKeys.add(canonicalKey);
      }
      return output;
    });
  }

  async appendCandidateStageEvents(
    runId: string,
    events: readonly CandidateStageEvent[],
    versions: Pick<SelectionPlan, "pipelineVersion" | "policyVersion">,
  ): Promise<void> {
    boundedPipelineBatch(events, 500, "Candidate stage events");
    await this.transaction(async (client) => {
      const candidateIds = [...new Set(events.map((event) => event.candidateId))];
      if (candidateIds.length > 0) {
        const owned = await client.query<{ count: number }>(
          "SELECT count(*)::int count FROM track_candidates WHERE run_id=$1 AND id=ANY($2::uuid[])",
          [runId, candidateIds],
        );
        if (Number(owned.rows[0]?.count ?? 0) !== candidateIds.length) {
          throw new HttpError(400, "Stage event references a candidate outside this research run", "invalid_candidate_stage_event");
        }
      }
      for (const event of events) {
        const occurredAt = date(event.occurredAt);
        if (!occurredAt || Number.isNaN(occurredAt.getTime())) {
          throw new HttpError(400, "Stage event timestamp is invalid", "invalid_candidate_stage_event");
        }
        // The semantic transition is the idempotency key. Excluding the
        // timestamp means a reclaimed worker cannot duplicate the same stage
        // transition merely because it retried at a later wall-clock time.
        const id = deterministicUuid({
          runId,
          candidateId: event.candidateId,
          fromStage: event.fromStage,
          toStage: event.toStage,
          reasonCode: event.reasonCode,
          detail: event.detail,
        });
        await client.query(
          `INSERT INTO candidate_stage_events(
             id,run_id,candidate_id,from_stage,to_stage,reason_code,detail_json,
             pipeline_version,policy_version,occurred_at)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
           ON CONFLICT(id) DO NOTHING`,
          [
            id,
            runId,
            event.candidateId,
            event.fromStage,
            event.toStage,
            event.reasonCode,
            JSON.stringify(event.detail),
            versions.pipelineVersion,
            versions.policyVersion,
            occurredAt,
          ],
        );
      }
      await client.query(
        `UPDATE track_candidates tc SET candidate_stage=latest.to_stage,
           stage_updated_at=latest.occurred_at,pipeline_version=$2,policy_version=$3
         FROM (
           SELECT DISTINCT ON (candidate_id) candidate_id,to_stage,occurred_at
           FROM candidate_stage_events WHERE run_id=$1
           ORDER BY candidate_id,occurred_at DESC,id DESC
         ) latest
         WHERE tc.id=latest.candidate_id AND tc.run_id=$1 AND tc.stage_updated_at<=latest.occurred_at`,
        [runId, versions.pipelineVersion, versions.policyVersion],
      );
    });
  }

  async getPipelineStageCounts(runId: string): Promise<PipelineStageCounts> {
    return getPipelineStageCountsTransaction(this.pool, runId);
  }

  async savePipelineDeficitLedger(
    runId: string,
    entries: readonly PipelineDeficitLedgerEntry[],
    options: Pick<SelectionPlan, "pipelineVersion" | "policyVersion"> & { mode: "append" | "replace" },
  ): Promise<void> {
    boundedPipelineBatch(entries, 200, "Pipeline deficit ledger");
    await this.transaction(async (client) => {
      const run = await client.query("SELECT id FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [runId]);
      if (!run.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
      if (options.mode === "replace") {
        await client.query("DELETE FROM pipeline_deficit_ledger WHERE run_id=$1", [runId]);
      }
      for (const entry of entries) {
        const observedAt = date(entry.observedAt);
        if (!observedAt || Number.isNaN(observedAt.getTime())) {
          throw new HttpError(400, "Deficit timestamp is invalid", "invalid_pipeline_deficit");
        }
        const id = deterministicUuid({ runId, ...entry });
        await client.query(
          `INSERT INTO pipeline_deficit_ledger(
             id,run_id,stage,kind,status,required_count,actual_count,deficit_count,
             reason_code,detail_json,pipeline_version,policy_version,observed_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
           ON CONFLICT(id) DO NOTHING`,
          [
            id,
            runId,
            entry.stage,
            entry.kind,
            entry.status,
            entry.requiredCount,
            entry.actualCount,
            entry.deficitCount,
            entry.reasonCode,
            JSON.stringify(entry.detail),
            options.pipelineVersion,
            options.policyVersion,
            observedAt,
          ],
        );
      }
    });
  }

  /**
   * Atomically claim the one permitted semantic-equivalent repair before the
   * worker requalifies any retained leads. The existing schema-15 immutable
   * revision table is the crash/restart fence: an identical replay is safe,
   * while a conflicting replay is an integrity failure.
   */
  async claimPipelineV3SemanticRecovery(input: {
    runId: string;
    queryPlan: QueryPlanV3;
    revision: SemanticPlanRevisionArtifactV3;
    fence: PipelineV3WriteFence;
  }): Promise<{ status: "claimed" | "replayed"; revision: 2 }> {
    const { runId, queryPlan, revision, fence } = input;
    if (queryPlan.schemaVersion < 2 || !isQueryPlanV3(queryPlan)) {
      throw new HttpError(
        409,
        "Semantic recovery requires an immutable schema-2 query plan",
        "pipeline_v3_semantic_recovery_conflict",
      );
    }
    if (Number(await this.getSchemaVersion() ?? 0) < 15) {
      throw new HttpError(
        409,
        "Semantic recovery persistence is unavailable for this database schema",
        "pipeline_v3_semantic_recovery_conflict",
      );
    }

    return this.transaction(async (client) => {
      // The lease fence is deliberately the first authoritative read. A stale
      // worker must not be able to observe or claim a recovery revision.
      await this.assertPipelineV3WriteFence(client, runId, fence);
      const contract = await client.query<{
        query_plan_id: string;
        query_plan_status: string;
        query_plan_hash: string;
        query_plan_json: QueryPlanV3;
        selection_plan_status: string;
        selection_plan_hash: string;
        selection_plan_json: SelectionPlanV3;
        initial_equivalence: string | null;
        initial_hard_constraint_hash: string | null;
        initial_plan_json: SelectionPlanV3 | null;
      }>(
        `SELECT qp.id query_plan_id,qp.status query_plan_status,
                qp.plan_hash query_plan_hash,qp.plan_json query_plan_json,
                sp.status selection_plan_status,sp.plan_hash selection_plan_hash,
                sp.plan_json selection_plan_json,
                initial.equivalence initial_equivalence,
                initial.hard_constraint_hash initial_hard_constraint_hash,
                initial.plan_json initial_plan_json
         FROM run_active_query_plans active
         JOIN query_plan_revisions qp ON qp.id=active.query_plan_revision_id
         JOIN selection_plans sp ON sp.id=qp.selection_plan_id
         LEFT JOIN semantic_plan_revisions initial
           ON initial.run_id=active.run_id AND initial.revision=1
         WHERE active.run_id=$1
         FOR UPDATE OF qp,sp`,
        [runId],
      );
      const immutable = contract.rows[0];
      const queryHash = queryPlanV3Hash(queryPlan);
      if (!immutable
        || immutable.query_plan_id !== fence.queryPlanRevisionId
        || immutable.query_plan_status !== "active"
        || immutable.selection_plan_status !== "active"
        || immutable.query_plan_hash !== queryHash
        || queryPlanV3Hash(immutable.query_plan_json) !== queryHash
        || immutable.selection_plan_hash !== queryPlan.selectionPlanHash
        || selectionPlanV3Hash(immutable.selection_plan_json) !== queryPlan.selectionPlanHash
        || immutable.query_plan_json.schemaVersion < 2) {
        throw new HttpError(
          409,
          "Semantic recovery no longer matches the active immutable plan",
          "pipeline_v3_semantic_recovery_conflict",
        );
      }

      const canonicalQueryPlan = createQueryPlanV3(
        immutable.selection_plan_json,
        immutable.query_plan_json.graphSnapshotId,
        {
          schemaVersion: immutable.query_plan_json.schemaVersion,
          briefContractVersion: immutable.query_plan_json.briefContractVersion,
          executionDeltaHash: immutable.query_plan_json.executionDeltaHash,
          playlistContractRevisionId: immutable.query_plan_json.playlistContractRevisionId,
          playlistContractSemanticHash: immutable.query_plan_json.playlistContractSemanticHash,
          playlistContractCompilerVersion: immutable.query_plan_json.playlistContractCompilerVersion,
        },
      );
      if (stableStringify(normalizedQueryPlanV3Invariant(
        immutable.query_plan_json,
        canonicalQueryPlan,
      )) !== stableStringify(normalizedQueryPlanV3Invariant(canonicalQueryPlan))) {
        throw new HttpError(
          409,
          "Semantic recovery query-plan projection failed integrity validation",
          "pipeline_v3_semantic_recovery_conflict",
        );
      }

      const expected = buildSemanticEquivalentRecoveryPlanV3(immutable.selection_plan_json);
      if (!expected || stableStringify(expected) !== stableStringify(revision)
        || immutable.initial_equivalence !== "initial"
        || immutable.initial_hard_constraint_hash !== revision.hardConstraintHash
        || stableStringify(immutable.initial_plan_json) !== stableStringify(immutable.selection_plan_json)) {
        throw new HttpError(
          409,
          "Semantic recovery claim is not the server-attested equivalent revision",
          "pipeline_v3_semantic_recovery_conflict",
        );
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO semantic_plan_revisions(
           id,run_id,revision,parent_revision,equivalence,hard_constraint_hash,plan_json,audit_json)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
         ON CONFLICT(run_id,revision) DO NOTHING
         RETURNING id`,
        [
          deterministicUuid({ runId, kind: "semantic_plan_revision", revision: revision.revision }),
          runId,
          revision.revision,
          revision.parentRevision,
          revision.equivalence,
          revision.hardConstraintHash,
          JSON.stringify(revision.plan),
          JSON.stringify(semanticPlanRevisionAuditJson(revision)),
        ],
      );
      const stored = await client.query<{
        equivalence: string;
        hard_constraint_hash: string;
        plan_json: SelectionPlanV3;
        audit_json: unknown;
      }>(
        `SELECT equivalence,hard_constraint_hash,plan_json,audit_json
         FROM semantic_plan_revisions
         WHERE run_id=$1 AND revision=$2`,
        [runId, revision.revision],
      );
      if (!stored.rows[0] || !semanticPlanRevisionMatches({ revision, stored: stored.rows[0] })) {
        throw new HttpError(
          409,
          "Semantic recovery retry conflicts with its immutable revision",
          "pipeline_v3_semantic_recovery_conflict",
        );
      }
      return {
        status: inserted.rows[0] ? "claimed" : "replayed",
        revision: 2 as const,
      };
    });
  }

  /**
   * Persist the complete, governed V3 retrieval boundary under the lease that
   * produced it.  Candidate evidence and the immutable manifest revision are
   * intentionally committed together: a reclaimed worker can leave neither
   * an orphan manifest nor partially-qualified rows behind.
   */
  async persistPipelineV3RetrievalResult(input: {
    runId: string;
    queryPlan: QueryPlanV3;
    plan: SelectionPlanV3;
    result: RetrievalResultV3;
    fence: PipelineV3WriteFence;
  }): Promise<{
    manifestId: string | null;
    manifestRevisionId: string | null;
    manifestHash: string | null;
    publicationState: "not_applicable" | "partial_confirmation_required" | "queued" | "waiting_for_apple_authorization";
  }> {
    const { runId, queryPlan, plan, result, fence } = input;
    const originalSelectionPlanProvided = selectionPlanV3Hash(plan) === queryPlan.selectionPlanHash;
    const expectedQueryPlan = queryPlan.schemaVersion === 1
      ? queryPlan
      : originalSelectionPlanProvided
      ? createQueryPlanV3(plan, queryPlan.graphSnapshotId, {
        schemaVersion: queryPlan.schemaVersion,
        briefContractVersion: queryPlan.briefContractVersion,
        executionDeltaHash: queryPlan.executionDeltaHash,
        playlistContractRevisionId: queryPlan.playlistContractRevisionId,
        playlistContractSemanticHash: queryPlan.playlistContractSemanticHash,
        playlistContractCompilerVersion: queryPlan.playlistContractCompilerVersion,
      })
      : queryPlanV3ExecutionProjection(plan, queryPlan);
    const executionProjectionMatches = stableStringify(normalizedQueryPlanV3Invariant(
      queryPlan,
      expectedQueryPlan,
    )) === stableStringify(normalizedQueryPlanV3Invariant(expectedQueryPlan));
    if (result.runId !== runId || result.executionMode !== "active"
      || !isQueryPlanV3(queryPlan)
      || queryPlan.pipelineVersion !== "corpus_first_v3"
      || queryPlan.policyVersion !== "corpus_first_v3_policy_v1"
      || plan.pipelineVersion !== "corpus_first_v3"
      || result.outcome.requestedTrackCount !== plan.requestedTrackCount
      || queryPlan.targetTrackCount !== plan.requestedTrackCount
      || queryPlan.storefront !== plan.storefront
      || !executionProjectionMatches
      || queryPlanV3Hash(queryPlan).length !== 64) {
      throw new HttpError(409, "Pipeline V3 retrieval contract does not match the immutable run", "pipeline_policy_mismatch");
    }
    const target = plan.requestedTrackCount;
    const schemaVersion = Number(await this.getSchemaVersion() ?? 0);
    const supportsGroundedRecoveryAudit = schemaVersion >= 15;
    const supportsSeparatedRecoveryPersistence = schemaVersion >= 18;
    const finalSemanticPlan = result.semanticPlanRevisions?.at(-1)?.plan ?? plan;
    if (finalSemanticPlan.prompt !== plan.prompt
      || finalSemanticPlan.requestedTrackCount !== plan.requestedTrackCount
      || finalSemanticPlan.storefront !== plan.storefront
      || stableStringify(finalSemanticPlan.hardConstraints) !== stableStringify(plan.hardConstraints)
      || stableStringify(finalSemanticPlan.recordingPolicy) !== stableStringify(plan.recordingPolicy)) {
      throw new HttpError(
        409,
        "Pipeline V3 semantic recovery changed an immutable request constraint",
        "pipeline_v3_result_invalid",
      );
    }
    if (result.selected.length !== result.outcome.selectedTrackCount
      || result.reserve.length !== result.outcome.reserveTrackCount
      || result.selected.length > target
      || (result.outcome.status === "exact_ready" && result.selected.length !== target)
      || (result.outcome.status === "partial_ready" && (result.selected.length < 1 || result.selected.length >= target))
      || (result.outcome.status === "no_compatible_tracks" && result.selected.length !== 0)) {
      throw new HttpError(409, "Pipeline V3 retrieval counts are internally inconsistent", "pipeline_v3_result_invalid");
    }
    boundedPipelineBatch(
      result.selected,
      EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS,
      "Pipeline V3 selected tracks",
    );
    boundedPipelineBatch(
      result.reserve,
      EXECUTABLE_PLAYLIST_MAXIMUM_RESERVE_TRACKS,
      "Pipeline V3 reserve tracks",
    );
    const allTracks = [...result.selected, ...result.reserve];
    const attestedBindingsByTrack = new Map<QualifiedTrackV3, Array<EvidenceBindingReferenceV3 & {
      eligibilityAttestation: EvidenceEligibilityAttestationV3;
    }>>();
    for (const track of allTracks) {
      const bindings = attestedEvidenceBindingsForSelectionV3(
        track.evidenceBindingIds,
        track.evidenceBindings,
      );
      if (bindings.length === 0) {
        throw new HttpError(
          409,
          "A qualified V3 track has no attested exact track-scope evidence",
          "pipeline_v3_evidence_attestation_missing",
        );
      }
      attestedBindingsByTrack.set(track, bindings);
    }
    const selectedFamilyKeys = new Set(result.selected.map((track) => track.recordingFamilyKey));
    if (selectedFamilyKeys.size !== result.selected.length
      || new Set(result.reserve.map((track) => track.recordingFamilyKey)).size !== result.reserve.length
      || result.reserve.some((track) => selectedFamilyKeys.has(track.recordingFamilyKey))) {
      throw new HttpError(409, "Pipeline V3 manifest tracks must be recording-family unique", "pipeline_v3_result_invalid");
    }
    if (queryPlan.schemaVersion === 4) {
      const publicationValidation = validateCanonicalPublicationSetV3({
        plan,
        tracks: result.selected,
        // A partial-ready manifest is only a decision artifact. The publisher
        // still requires the separately persisted consent hash before it can
        // cross the Apple write boundary.
        partialPublicationAuthorized:
          result.outcome.status === "partial_ready",
      });
      if (!publicationValidation.valid) {
        throw new HttpError(
          409,
          `Pipeline V3 canonical publication preflight failed: ${
            publicationValidation.reasonCodes.join(",")
          }`,
          "pipeline_v3_result_invalid",
        );
      }
    }

    // The manifest content hash is the publisher's integrity boundary, so it
    // must cover the exact ordered Apple payload and use the same canonical
    // algorithm at persistence and publication time. The wider immutable
    // research contract remains frozen in run_specs, selection_plans,
    // query_plan_revisions, graph snapshots, and the revision snapshots.
    const manifestHash = result.selected.length === 0 ? null : manifestContentHash(
      result.selected.map((track) => ({
        // V3 persists a run-owned UUID for every discovered candidate. The
        // publisher loads and hashes that persisted UUID, not the adapter's
        // source-local candidate key, so bind the revision to the same
        // deterministic identity before the transaction begins.
        candidateId: deterministicUuid({
          runId,
          pipelineVersion: "corpus_first_v3",
          candidateId: track.candidateId,
          familyKey: track.recordingFamilyKey,
        }),
        catalogId: track.appleSongId,
      })),
    );
    const manifestId = manifestHash ? deterministicUuid({ runId, kind: "pipeline_v3_manifest" }) : null;
    const manifestRevisionId = manifestHash
      ? deterministicUuid({ runId, kind: "pipeline_v3_manifest_revision", manifestHash })
      : null;

    const persisted = await this.transaction(async (client) => {
      // This must be the first database read with mutation authority.  A stale
      // worker is rejected before it can persist even a candidate row.
      await this.assertPipelineV3WriteFence(client, runId, fence);
      const recoveryAuthority = supportsSeparatedRecoveryPersistence
        && queryPlan.schemaVersion >= 4
        ? await this.assertPipelineV3RecoveryPersistenceFence(client, {
            runId,
            queryPlan,
            fence,
          })
        : null;
      const contract = await client.query<{
        status: string;
        phase: string;
        brief_json: PlaylistBrief;
        client_bucket: string;
        pipeline_policy_snapshot_json: PipelinePolicySnapshot;
        run_spec_hash: string;
        requested_track_count: number;
        storefront: string;
        selection_plan_id: string;
        selection_plan_status: string;
        selection_plan_hash: string;
        selection_plan_json: SelectionPlanV3;
        query_plan_id: string;
        query_plan_revision: number;
        query_plan_status: string;
        query_plan_hash: string;
        query_plan_json: QueryPlanV3;
        graph_snapshot_id: string;
        graph_snapshot_status: string;
        active_playlist_contract_revision_id: string | null;
        playlist_contract_json: PlaylistContractRevisionV1 | null;
      }>(
        `SELECT r.status,r.phase,r.brief_json,r.client_bucket,r.pipeline_policy_snapshot_json,
                r.active_playlist_contract_revision_id,
                playlist_contract.contract_json playlist_contract_json,
                spec.spec_hash run_spec_hash,spec.requested_track_count,spec.storefront,
                selection.id selection_plan_id,selection.status selection_plan_status,
                selection.plan_hash selection_plan_hash,
                selection.plan_json selection_plan_json,
                query.id query_plan_id,query.revision query_plan_revision,query.status query_plan_status,
                query.plan_hash query_plan_hash,query.plan_json query_plan_json,
                query.graph_snapshot_id,graph.status graph_snapshot_status
         FROM research_runs r
         JOIN run_specs spec ON spec.run_id=r.id
         JOIN run_active_query_plans active ON active.run_id=r.id
         JOIN query_plan_revisions query ON query.id=active.query_plan_revision_id
         JOIN selection_plans selection ON selection.id=query.selection_plan_id
         JOIN graph_snapshots graph ON graph.id=query.graph_snapshot_id
         LEFT JOIN playlist_contract_revisions playlist_contract
           ON playlist_contract.id=r.active_playlist_contract_revision_id
             AND playlist_contract.status='active'
         WHERE r.id=$1 AND r.deleted_at IS NULL FOR UPDATE OF r,query,selection,graph`,
        [runId],
      );
      const immutable = contract.rows[0];
      if (!immutable) throw new HttpError(404, "Research run not found", "run_not_found");
      const selectionHash = queryPlan.selectionPlanHash;
      const queryHash = queryPlanV3Hash(queryPlan);
      // Schema-1 plans predate typed semantic clauses, so they must not be run
      // back through the schema-2 compiler. They still have a deterministic
      // execution projection from their own immutable selection plan, though.
      // Rebuilding that legacy projection lets the selection plan remain the
      // trust anchor and catches a forged query payload whose attacker also
      // recomputed the query hash.
      const canonicalStoredQueryPlan = immutable.query_plan_json.schemaVersion === 1
        ? queryPlanV3ExecutionProjection(
          immutable.selection_plan_json,
          immutable.query_plan_json,
        )
        : createQueryPlanV3(
          immutable.selection_plan_json,
          immutable.graph_snapshot_id,
          {
            schemaVersion: immutable.query_plan_json.schemaVersion,
            briefContractVersion: immutable.query_plan_json.briefContractVersion,
            executionDeltaHash: immutable.query_plan_json.executionDeltaHash,
            playlistContractRevisionId: immutable.query_plan_json.playlistContractRevisionId,
            playlistContractSemanticHash: immutable.query_plan_json.playlistContractSemanticHash,
            playlistContractCompilerVersion: immutable.query_plan_json.playlistContractCompilerVersion,
          },
        );
      const canonicalContractMatches = immutable.query_plan_json.schemaVersion !== 4
        || (
          immutable.active_playlist_contract_revision_id !== null
          && immutable.playlist_contract_json !== null
          && immutable.playlist_contract_json.revisionId
            === immutable.query_plan_json.playlistContractRevisionId
          && immutable.playlist_contract_json.semanticHash
            === immutable.query_plan_json.playlistContractSemanticHash
          && immutable.playlist_contract_json.versions.compiler
            === immutable.query_plan_json.playlistContractCompilerVersion
        );
      const storedQueryInvariantMatchesSelection = stableStringify(normalizedQueryPlanV3Invariant(
        immutable.query_plan_json,
        canonicalStoredQueryPlan,
      )) === stableStringify(normalizedQueryPlanV3Invariant(canonicalStoredQueryPlan));
      if (immutable.query_plan_id !== fence.queryPlanRevisionId
        || immutable.query_plan_status !== "active"
        || immutable.selection_plan_status !== "active"
        || immutable.query_plan_hash !== queryHash
        || queryPlanV3Hash(immutable.query_plan_json) !== queryHash
        || immutable.selection_plan_hash !== selectionHash
        || selectionPlanV3Hash(immutable.selection_plan_json) !== selectionHash
        || !storedQueryInvariantMatchesSelection
        || immutable.graph_snapshot_id !== queryPlan.graphSnapshotId
        || immutable.graph_snapshot_status !== "locked"
        || !canonicalContractMatches
        || Number(immutable.requested_track_count) !== target
        || immutable.storefront !== plan.storefront) {
        throw new HttpError(409, "Pipeline V3 retrieval no longer matches the active immutable plan", "pipeline_v3_plan_stale");
      }

      const graphBindings = [...attestedBindingsByTrack.values()]
        .flat()
        .filter((binding): binding is typeof binding & {
          eligibilityAttestation: Extract<EvidenceEligibilityAttestationV3, { kind: "frozen_promoted_graph_assertion" }>;
        } => binding.eligibilityAttestation.kind === "frozen_promoted_graph_assertion");
      const graphAssertionIds = [...new Set(graphBindings.map((binding) => (
        binding.eligibilityAttestation.assertionId
      )))];
      if (graphBindings.some((binding) => (
        binding.eligibilityAttestation.graphSnapshotId !== immutable.graph_snapshot_id
        || !UUID_PATTERN.test(binding.eligibilityAttestation.assertionId)
        || !UUID_PATTERN.test(binding.eligibilityAttestation.observationId)
      ))) {
        throw new HttpError(
          409,
          "Pipeline V3 graph evidence does not belong to the frozen graph snapshot",
          "pipeline_v3_evidence_attestation_missing",
        );
      }
      if (graphAssertionIds.length > 0) {
        const frozenAssertions = await client.query<{
          assertion_id: string;
          assertion_revision_json: unknown;
        }>(
          `SELECT assertion_id,assertion_revision_json
           FROM graph_snapshot_assertions
           WHERE graph_snapshot_id=$1 AND assertion_id=ANY($2::uuid[])`,
          [immutable.graph_snapshot_id, graphAssertionIds],
        );
        const revisions = new Map(frozenAssertions.rows.map((row) => [
          row.assertion_id,
          row.assertion_revision_json,
        ]));
        if (graphBindings.some((binding) => !frozenGraphAssertionContainsAttestation({
          revision: revisions.get(binding.eligibilityAttestation.assertionId),
          attestation: binding.eligibilityAttestation,
          sourceUrl: binding.url!,
        }))) {
          throw new HttpError(
            409,
            "Pipeline V3 graph evidence is not a promoted assertion in the frozen graph snapshot",
            "pipeline_v3_evidence_attestation_missing",
          );
        }
      }

      let manifestSelectionPlan = immutable.selection_plan_json;
      if (supportsGroundedRecoveryAudit) {
        const revisions = result.semanticPlanRevisions ?? [];
        if (revisions.length > 1) {
          throw new HttpError(409, "Pipeline V3 recovery exceeded its single-repair boundary", "pipeline_v3_result_invalid");
        }
        for (const revision of revisions) {
          const existing = await client.query<{
            equivalence: string;
            hard_constraint_hash: string;
            plan_json: SelectionPlanV3;
            audit_json: unknown;
          }>(
            `SELECT equivalence,hard_constraint_hash,plan_json,audit_json
             FROM semantic_plan_revisions WHERE run_id=$1 AND revision=$2`,
            [runId, revision.revision],
          );
          if (existing.rows[0]) {
            if (!semanticPlanRevisionMatches({ revision, stored: existing.rows[0] })) {
              throw new HttpError(409, "Semantic recovery retry conflicts with its immutable revision", "pipeline_v3_plan_stale");
            }
            // Snapshot the already-claimed durable revision, never the
            // worker-supplied copy. The equality check above proves that the
            // result references the same immutable recovery artifact.
            manifestSelectionPlan = existing.rows[0].plan_json;
          } else {
            // Recovery must be claimed before requalification. Persistence is
            // not allowed to turn an untrusted worker result into a durable
            // semantic revision after the fact.
            throw new HttpError(
              409,
              "Pipeline V3 semantic recovery was not durably claimed before persistence",
              "pipeline_v3_plan_stale",
            );
          }
        }
        const semanticRevision = revisions.at(-1)?.revision ?? 1;
        for (const lead of result.candidateLeads ?? []) {
          const strategy = result.strategies.find(({ id }) => id === lead.strategyId);
          const provider = strategy?.discoveryDependencyIds[0] ?? "orchestration_local";
          const dependencyKey = strategy?.discoveryDependencyIds.join("+")
            || "orchestration_local";
          await client.query(
            `INSERT INTO pipeline_candidate_leads(
               id,run_id,query_plan_revision_id,semantic_revision,strategy_id,candidate_key,
               artist,title,album,source_record_ids,citation_hashes,predicate_coverage,rejection_code)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13)
             ON CONFLICT(run_id,semantic_revision,strategy_id,candidate_key) DO NOTHING`,
            [
              deterministicUuid({
                runId,
                kind: "pipeline_candidate_lead",
                semanticRevision,
                strategyId: lead.strategyId,
                candidateKey: lead.candidateKey,
              }),
              runId,
              immutable.query_plan_id,
              semanticRevision,
              lead.strategyId.slice(0, 160),
              lead.candidateKey,
              lead.artist.slice(0, 240),
              lead.title.slice(0, 240),
              lead.album?.slice(0, 240) ?? null,
              JSON.stringify(lead.sourceRecordIds),
              JSON.stringify(lead.citationHashes),
              JSON.stringify(lead.predicateCoverage),
              lead.rejectionCode?.slice(0, 120) ?? null,
            ],
          );
          if (recoveryAuthority) {
            const discoveryLeadId = deterministicUuid({
              kind: "playlist_discovery_lead",
              runId,
              contractRevisionId: recoveryAuthority.contractRevisionId,
              provider,
              strategyId: lead.strategyId,
              identityHintHash: lead.candidateKey,
            });
            await client.query(
              `INSERT INTO playlist_discovery_leads(
                 id,run_id,contract_revision_id,execution_attempt_id,provider,
                 dependency_key,strategy_id,identity_hint_hash,lead_json,status,
                 evidence_eligible)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,false)
               ON CONFLICT(
                 run_id,contract_revision_id,provider,strategy_id,identity_hint_hash
               ) DO UPDATE SET
                 execution_attempt_id=EXCLUDED.execution_attempt_id,
                 lead_json=EXCLUDED.lead_json,
                 status=CASE
                   WHEN playlist_discovery_leads.status IN ('qualified','rejected','revoked')
                   THEN playlist_discovery_leads.status
                   ELSE EXCLUDED.status
                 END,
                 updated_at=now()
               WHERE playlist_discovery_leads.evidence_eligible=false`,
              [
                discoveryLeadId,
                runId,
                recoveryAuthority.contractRevisionId,
                recoveryAuthority.executionAttemptId,
                provider.slice(0, 80),
                dependencyKey.slice(0, 120),
                lead.strategyId.slice(0, 120),
                lead.candidateKey,
                JSON.stringify({
                  schemaVersion: "genio-playlist-discovery-lead/v1",
                  untrusted: true,
                  artist: lead.artist.slice(0, 240),
                  title: lead.title.slice(0, 240),
                  album: lead.album?.slice(0, 240) ?? null,
                  sourceRecordIds: lead.sourceRecordIds.slice(0, 64),
                  citationHashes: lead.citationHashes.slice(0, 32),
                  predicateCoverage: lead.predicateCoverage.slice(0, 64),
                  semanticRevision,
                }),
                lead.rejectionCode === null ? "qualifying" : "rejected",
              ],
            );
            if (lead.rejectionCode !== null) {
              const qualificationHash = sha256Hex(stableStringify({
                kind: "scheduler_rejection",
                rejectionCode: lead.rejectionCode,
                predicateCoverage: lead.predicateCoverage,
              }));
              await client.query(
                `INSERT INTO playlist_qualification_records(
                   id,run_id,contract_revision_id,discovery_lead_id,candidate_id,
                   stable_identity_hash,storefront,predicate_results_json,
                   evidence_record_ids_json,quality_result_json,catalog_result_json,
                   decision,qualification_hash)
                 VALUES($1,$2,$3,$4,NULL,$5,$6,$7::jsonb,'[]'::jsonb,
                   $8::jsonb,$9::jsonb,'failed',$10)
                 ON CONFLICT(
                   run_id,contract_revision_id,stable_identity_hash,qualification_hash
                 ) DO NOTHING`,
                [
                  deterministicUuid({
                    kind: "playlist_qualification_record",
                    runId,
                    contractRevisionId: recoveryAuthority.contractRevisionId,
                    stableIdentityHash: lead.candidateKey,
                    qualificationHash,
                  }),
                  runId,
                  recoveryAuthority.contractRevisionId,
                  discoveryLeadId,
                  lead.candidateKey,
                  plan.storefront,
                  JSON.stringify({
                    rejectionCode: lead.rejectionCode,
                    predicateCoverage: lead.predicateCoverage,
                  }),
                  JSON.stringify({
                    evidence: "not_selection_eligible",
                    centralQuality: "not_evaluated",
                  }),
                  JSON.stringify({
                    catalog: "not_selection_eligible",
                  }),
                  qualificationHash,
                ],
              );
            }
          }
        }
        for (const audit of result.recoveryAudits ?? []) {
          await client.query(
            `INSERT INTO pipeline_recovery_audits(
               id,run_id,query_plan_revision_id,generation,root_cause,action,status,
               counters,envelope,idempotency_key)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)
             ON CONFLICT(idempotency_key) DO NOTHING`,
            [
              deterministicUuid({ runId, kind: "pipeline_recovery_audit", idempotencyKey: audit.idempotencyKey }),
              runId,
              immutable.query_plan_id,
              audit.generation,
              audit.rootCause,
              audit.action,
              audit.status,
              JSON.stringify({
                before: audit.before,
                after: audit.after,
                beforeFailedMembershipPredicateIds: audit.beforeFailedMembershipPredicateIds,
                afterFailedMembershipPredicateIds: audit.afterFailedMembershipPredicateIds,
              }),
              JSON.stringify({
                policyVersion: "pipeline-v3-semantic-recovery/v1",
                transformationKinds: audit.transformationKinds,
                semanticPlanRevision: semanticRevision,
                predicateDiagnostics: result.predicateDiagnostics ?? null,
              }),
              audit.idempotencyKey,
            ],
          );
        }
        if (recoveryAuthority) {
          boundedPipelineBatch(
            result.qualifiedPool,
            5_000,
            "Pipeline V3 separated qualification records",
          );
          const passedPredicateIds = evidenceMembershipPredicatesV3(
            finalSemanticPlan,
          ).map(({ id }) => id);
          for (const track of result.qualifiedPool) {
            const stableIdentityHash = sha256Hex(stableStringify({
              kind: "recording_family",
              recordingFamilyKey: track.recordingFamilyKey,
            }));
            const identityHintHash = pipelineV3LeadIdentityHash({
              artist: track.artist,
              title: track.title,
              album: track.album,
            });
            const lead = await client.query<{ id: string }>(
              `SELECT id FROM playlist_discovery_leads
               WHERE run_id=$1 AND contract_revision_id=$2
                 AND identity_hint_hash=$3 AND evidence_eligible=false
               ORDER BY updated_at DESC,id DESC LIMIT 1`,
              [runId, recoveryAuthority.contractRevisionId, identityHintHash],
            );
            const evidenceRecordIds = [...new Set(track.evidenceBindingIds)]
              .slice(0, 128);
            const canonical = queryPlan.canonicalContractPolicy
              ? pipelineV3CanonicalPredicateProjection(
                  queryPlan.canonicalContractPolicy,
                  track.canonicalClauseAssessments,
                  evidenceRecordIds,
                )
              : null;
            if (canonical
              && (!canonical.evaluation.eligible
                || !canonical.evidenceIntegrity.passed)) {
              throw new HttpError(
                409,
                "A schema-4 qualified track does not satisfy its canonical contract",
                "pipeline_v3_result_invalid",
              );
            }
            const predicateResults = canonical
              ? {
                  canonicalContract: canonical,
                  scope: {
                    verdict: "legacy_observation_not_authoritative",
                    fit: track.scopeFit,
                  },
                  hardConstraints: {
                    verdict: "legacy_observation_not_authoritative",
                  },
                  legacyFlattenedAuthoritative: false,
                }
              : {
                  scope: {
                    verdict: "pass",
                    passedPredicateIds,
                    fit: track.scopeFit,
                  },
                  hardConstraints: { verdict: "pass" },
                };
            const qualityResult = {
              verdict: "pass",
              evidenceStrength: track.evidenceStrength,
              independentProvenanceRoots: track.independentProvenanceRoots,
              rankingSignals: track.rankingSignals,
              sourceRank: track.sourceRank,
              ...(track.playlistOptimizationSignals ? {
                playlistOptimizationSignals:
                  normalizePlaylistOptimizationSignalsV3(
                    track.playlistOptimizationSignals,
                  ),
              } : {}),
            };
            const catalogResult = {
              verdict: "pass",
              storefrontPlayable: true,
              appleSongId: track.appleSongId,
              recordingFamilyKey: track.recordingFamilyKey,
              releaseYear: track.catalogReleaseYear ?? null,
              compatibleReleaseYears:
                track.catalogCompatibleReleaseYears ?? [],
              genreNames: track.catalogGenreNames ?? [],
              versionCompatible: true,
              versionConfidence: track.versionConfidence,
              catalogConfidence: track.catalogConfidence,
            };
            const qualificationHash = sha256Hex(stableStringify({
              decision: "qualified",
              stableIdentityHash,
              predicateResults,
              evidenceRecordIds,
              qualityResult,
              catalogResult,
            }));
            await client.query(
              `INSERT INTO playlist_qualification_records(
                 id,run_id,contract_revision_id,discovery_lead_id,candidate_id,
                 stable_identity_hash,storefront,predicate_results_json,
                 evidence_record_ids_json,quality_result_json,catalog_result_json,
                 decision,qualification_hash)
               VALUES($1,$2,$3,$4,NULL,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,
                 $10::jsonb,'qualified',$11)
               ON CONFLICT(
                 run_id,contract_revision_id,stable_identity_hash,qualification_hash
               ) DO NOTHING`,
              [
                deterministicUuid({
                  kind: "playlist_qualification_record",
                  runId,
                  contractRevisionId: recoveryAuthority.contractRevisionId,
                  stableIdentityHash,
                  qualificationHash,
                }),
                runId,
                recoveryAuthority.contractRevisionId,
                lead.rows[0]?.id ?? null,
                stableIdentityHash,
                plan.storefront,
                JSON.stringify(predicateResults),
                JSON.stringify(evidenceRecordIds),
                JSON.stringify(qualityResult),
                JSON.stringify(catalogResult),
                qualificationHash,
              ],
            );
            if (lead.rows[0]) {
              await client.query(
                `UPDATE playlist_discovery_leads
                 SET status='qualified',execution_attempt_id=$2,updated_at=now()
                 WHERE id=$1 AND evidence_eligible=false`,
                [lead.rows[0].id, recoveryAuthority.executionAttemptId],
              );
            }
          }
        }
      }

      // Persist a bounded, public-safe diagnostic projection for every V3.2
      // result, including runs where no semantic repair was attempted. This
      // lets the UI and owner tooling distinguish semantic rejection from an
      // Apple/provider failure without exposing provider payloads or costs.
      await client.query(
        `INSERT INTO research_checkpoints(run_id,phase,state_json)
         VALUES($1,'semantic_diagnostics',$2::jsonb)
         ON CONFLICT(run_id,phase) DO UPDATE
           SET state_json=EXCLUDED.state_json,updated_at=now()`,
        [runId, JSON.stringify({
          semanticPolicyVersion: queryPlan.semanticPolicyVersion ?? null,
          queryPlanSchemaVersion: queryPlan.schemaVersion,
          explicitConstraintHash: queryPlan.explicitUserConstraintHash ?? null,
          contextSignals: (queryPlan.contextSignals ?? []).slice(0, 20),
          rejectedByPredicate: result.predicateDiagnostics?.failedMembershipPredicateIds ?? {},
          appleLookupCount: result.predicateDiagnostics?.appleLookupCount ?? 0,
          appleProviderRequestCount: result.predicateDiagnostics?.appleProviderRequestCount ?? 0,
          rootCause: result.predicateDiagnostics?.rootCause ?? null,
          semanticRecovery: {
            attempted: (result.predicateDiagnostics?.recoveryAttemptCount ?? 0) > 0,
            attemptCount: result.predicateDiagnostics?.recoveryAttemptCount ?? 0,
            repaired: (result.semanticPlanRevisions?.length ?? 0) > 0,
          },
          activePlanRevision: Number(immutable.query_plan_revision),
        })],
      );

      if (manifestRevisionId) {
        const existing = await client.query<{ manifest_id: string; content_hash: string }>(
          `SELECT manifest_id,content_hash FROM manifest_revisions
           WHERE id=$1 AND pipeline_version='corpus_first_v3'`,
          [manifestRevisionId],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].manifest_id !== manifestId || existing.rows[0].content_hash !== manifestHash) {
            throw new HttpError(409, "Pipeline V3 manifest retry conflicts with immutable content", "manifest_revision_conflict");
          }
          return {
            manifestId,
            manifestRevisionId,
            manifestHash,
            clientBucket: immutable.client_bucket,
            exact: result.outcome.status === "exact_ready",
            existing: true,
          };
        }
      }

      const persistedTracks: Array<{
        track: QualifiedTrackV3;
        candidateId: string;
        familyId: string;
        catalogIdentityId: string;
        reserve: boolean;
      }> = [];
      for (const [index, track] of allTracks.entries()) {
        if (!track.title.trim() || !track.artist.trim() || !track.appleSongId.trim()
          || !track.recordingFamilyKey.trim() || !Array.isArray(track.evidenceBindingIds)
          || track.evidenceBindingIds.length < 1) {
          throw new HttpError(409, "A qualified V3 track is missing identity or evidence", "pipeline_v3_result_invalid");
        }
        const familyId = deterministicUuid({ runId, pipelineVersion: "corpus_first_v3", familyKey: track.recordingFamilyKey });
        const candidateId = deterministicUuid({ runId, pipelineVersion: "corpus_first_v3", candidateId: track.candidateId, familyKey: track.recordingFamilyKey });
        const catalogIdentityId = deterministicUuid({ familyId, provider: "apple", storefront: plan.storefront, catalogId: track.appleSongId });
        const canonicalKey = `v3:${sha256Hex(stableStringify({ runId, sourceCandidateId: track.candidateId, familyKey: track.recordingFamilyKey }))}`;
        await client.query(
          `INSERT INTO recording_families(
             id,run_id,family_key,canonical_artist,canonical_title,version_class,metadata_json,
             pipeline_version,policy_version)
           VALUES($1,$2,$3,$4,$5,'canonical',$6::jsonb,'corpus_first_v3','corpus_first_v3_policy_v1')
           ON CONFLICT(run_id,family_key) DO UPDATE SET
             canonical_artist=EXCLUDED.canonical_artist,canonical_title=EXCLUDED.canonical_title,
             metadata_json=EXCLUDED.metadata_json,updated_at=now()`,
          [familyId, runId, track.recordingFamilyKey, track.artist.slice(0, 240), track.title.slice(0, 240), JSON.stringify({ album: track.album, sourceRank: track.sourceRank })],
        );
        await client.query(
          `INSERT INTO track_candidates(
             id,run_id,canonical_key,duplicate_cluster_key,artist,title,album,outcome,
             recording_family_id,candidate_stage,pipeline_version,policy_version)
           VALUES($1,$2,$3,$4,$5,$6,$7,'accepted',$8,'discovered','corpus_first_v3','corpus_first_v3_policy_v1')
           ON CONFLICT(run_id,canonical_key) DO UPDATE SET
             artist=EXCLUDED.artist,title=EXCLUDED.title,album=EXCLUDED.album,
             recording_family_id=EXCLUDED.recording_family_id,outcome='accepted'`,
          [candidateId, runId, canonicalKey, track.recordingFamilyKey.slice(0, 500), track.artist.slice(0, 240), track.title.slice(0, 240), track.album?.slice(0, 240) ?? null, familyId],
        );
        await client.query(
          `INSERT INTO recording_family_candidates(recording_family_id,candidate_id,relationship)
           VALUES($1,$2,'qualified_member') ON CONFLICT(candidate_id) DO NOTHING`,
          [familyId, candidateId],
        );
        await client.query(
          `INSERT INTO recording_catalog_identities(
             id,recording_family_id,provider,storefront,catalog_id,is_preferred,identity_confidence,
             artist,title,album,metadata_json)
           VALUES($1,$2,'apple',$3,$4,true,$5,$6,$7,$8,$9::jsonb)
           ON CONFLICT(recording_family_id,provider,storefront,catalog_id) DO UPDATE SET
             is_preferred=true,identity_confidence=GREATEST(recording_catalog_identities.identity_confidence,EXCLUDED.identity_confidence),
             metadata_json=EXCLUDED.metadata_json,updated_at=now()`,
          [catalogIdentityId, familyId, plan.storefront, track.appleSongId.slice(0, 160), Math.max(0, Math.min(1, track.catalogConfidence)), track.artist.slice(0, 240), track.title.slice(0, 240), track.album?.slice(0, 240) ?? null, JSON.stringify({ compatible: true, versionCompatible: true })],
        );
        await client.query(
          `INSERT INTO catalog_matches(
             id,run_id,candidate_id,status,basis,score,catalog_id,song_json,alternatives_json,reviewed_at)
           VALUES($1,$2,$3,'accepted','Pipeline V3 governed catalog identity',$4,$5,$6::jsonb,'[]'::jsonb,now())
           ON CONFLICT(candidate_id) DO UPDATE SET status='accepted',basis=EXCLUDED.basis,
             score=EXCLUDED.score,catalog_id=EXCLUDED.catalog_id,song_json=EXCLUDED.song_json,reviewed_at=now()`,
          [deterministicUuid({ runId, candidateId, kind: "catalog_match" }), runId, candidateId, Math.max(0, Math.min(1, track.catalogConfidence)), track.appleSongId.slice(0, 100), JSON.stringify({ id: track.appleSongId, name: track.title, artistName: track.artist, albumName: track.album ?? "" })],
        );
        if (recoveryAuthority) {
          const stableIdentityHash = sha256Hex(stableStringify({
            kind: "recording_family",
            recordingFamilyKey: track.recordingFamilyKey,
          }));
          await client.query(
            `UPDATE playlist_qualification_records
             SET candidate_id=$4
             WHERE run_id=$1 AND contract_revision_id=$2
               AND stable_identity_hash=$3
               AND (candidate_id IS NULL OR candidate_id=$4)`,
            [
              runId,
              recoveryAuthority.contractRevisionId,
              stableIdentityHash,
              candidateId,
            ],
          );
        }

        const bindings = attestedBindingsByTrack.get(track)!;
        for (const binding of bindings) {
          const normalizedUrl = assertPublicHttpsUrl(binding.url!).toString();
          let sourceRecordId = deterministicUuid({ runId, url: normalizedUrl });
          const source = await client.query<{ id: string }>(
            `INSERT INTO source_records(id,run_id,url,title,source_class,provenance_root,note)
             VALUES($1,$2,$3,$4,'web',$5,$6)
             ON CONFLICT(run_id,url) DO UPDATE SET title=EXCLUDED.title,
               provenance_root=EXCLUDED.provenance_root,note=EXCLUDED.note RETURNING id`,
            [sourceRecordId, runId, normalizedUrl, `${track.artist} — ${track.title}`.slice(0, 240), binding.provenanceRoot.slice(0, 240), compactEvidenceNote(`Pipeline V3 exact track-scope evidence (${binding.kind}).`)],
          );
          sourceRecordId = source.rows[0]!.id;
          const positivePredicates = evidenceMembershipPredicatesV3(finalSemanticPlan);
          const explicitPredicateIds = binding.predicateIds ?? binding.supportedPredicateIds;
          const supportedPredicates = positivePredicates.filter((predicate) => (
            explicitPredicateIds?.includes(predicate.id)
          ));
          // Compatibility is intentionally limited to a single-axis run. A
          // composite binding without typed axis attribution must fail closed.
          const persistedPredicates = supportedPredicates.length > 0
            ? supportedPredicates
            : positivePredicates.length === 1 && explicitPredicateIds === undefined
              ? positivePredicates
              : [];
          if (persistedPredicates.length === 0) {
            throw new HttpError(
              409,
              "A qualified V3 evidence binding has no explicit membership-predicate scope",
              "pipeline_v3_evidence_predicate_missing",
            );
          }
          for (const predicate of persistedPredicates) {
            const scopeAxis = predicate.axis.slice(0, 48);
            const scopeValue = predicate.values.join(" | ").slice(0, 240);
            const relationship = predicate.operator.slice(0, 240);
            const bindingId = deterministicUuid({
              runId,
              candidateId,
              sourceRecordId,
              sourceBindingId: binding.id,
              predicateId: predicate.id,
            });
            await client.query(
              `INSERT INTO track_scope_bindings(
                 id,run_id,candidate_id,source_record_id,source_url,research_container_id,
                 citation_attestation_id,binding_kind,eligibility,scope_axis,scope_value,relationship,
                 confidence,provenance_path_json,note,pipeline_version,policy_version)
               VALUES($1,$2,$3,$4,$5,NULL,NULL,$6,'qualifying',$7,$8,$9,$10,$11::jsonb,$12,
                 'corpus_first_v3','corpus_first_v3_policy_v1')
               ON CONFLICT(id) DO NOTHING`,
              [bindingId, runId, candidateId, sourceRecordId, normalizedUrl, binding.kind.slice(0, 64), scopeAxis, scopeValue, relationship, Math.max(0, Math.min(1, binding.strength)), JSON.stringify([
                { kind: "evidence_eligibility_attestation", attestation: binding.eligibilityAttestation },
                { kind: "evidence_source_governance", governance: binding.governance },
                {
                  kind: "pipeline_v3_binding",
                  id: binding.id,
                  label: binding.provenanceRoot,
                  predicateIds: [predicate.id],
                  sourcePredicateIds: explicitPredicateIds ?? [predicate.id],
                },
                ...track.sourceObservationIds.map((id) => ({ kind: "source_observation", id })),
              ]), compactEvidenceNote(`Qualified ${predicate.id} by ${binding.kind}; source rank ${binding.sourceRank}.`)],
            );
          }
        }
        persistedTracks.push({ track, candidateId, familyId, catalogIdentityId, reserve: index >= result.selected.length });
      }

      await advanceCandidateStagesTransaction(
        client,
        runId,
        persistedTracks.map((item) => ({
          candidateId: item.candidateId,
          stages: [
            { toStage: "identity_resolved", reasonCode: "pipeline_v3_identity_resolved" },
            { toStage: "scope_qualified", reasonCode: "pipeline_v3_scope_qualified" },
            { toStage: "claim_verified", reasonCode: "pipeline_v3_evidence_verified" },
            { toStage: "version_compatible", reasonCode: "pipeline_v3_version_compatible" },
            { toStage: "catalog_resolved", reasonCode: "pipeline_v3_catalog_resolved" },
            { toStage: "playable", reasonCode: "pipeline_v3_storefront_playable" },
            { toStage: "canonicalized", reasonCode: "pipeline_v3_recording_family_canonicalized" },
            { toStage: "quota_eligible", reasonCode: item.reserve ? "pipeline_v3_qualified_reserve" : "pipeline_v3_selected" },
            ...(item.reserve ? [] : [
              { toStage: "sequenced" as const, reasonCode: "pipeline_v3_sequence_assigned" },
              { toStage: "manifested" as const, reasonCode: "pipeline_v3_manifest_locked" },
            ]),
          ],
        })),
        { pipelineVersion: "corpus_first_v3", policyVersion: "corpus_first_v3_policy_v1" },
      );

      const stopReason = result.outcome.stopReason;
      const outcomeStatus: PipelineOutcome["status"] = result.outcome.status === "no_compatible_tracks"
        ? "no_compatible_tracks"
        : result.outcome.status === "failed_integrity"
          ? "failed_integrity"
          : stopReason === "deadline_reached"
            ? "partial_timed_out"
            : stopReason === "provider_circuit_open" || stopReason === "provider_failure"
              ? "partial_catalog_degraded"
              : stopReason === "frontier_exhausted" || stopReason === "maximum_rounds_reached" || stopReason === "maximum_candidates_reached"
                ? "partial_frontier_exhausted"
                : "partial_evidence_shortfall";
      const stageCounts: PipelineStageCounts = {
        discovered: result.stages.discovered,
        scope_qualified: result.stages.scopeEligible,
        claim_verified: result.stages.evidenceEligible,
        version_compatible: result.stages.versionCompatible,
        catalog_resolved: result.stages.storefrontPlayable,
        playable: result.stages.storefrontPlayable,
        canonicalized: result.stages.canonicalUnique,
        quota_eligible: result.selected.length + result.reserve.length,
        sequenced: result.selected.length,
        manifested: result.selected.length,
        published: 0,
      };
      const outcome = buildPipelineOutcome({
        pipelineVersion: "corpus_first_v3",
        policyVersion: "corpus_first_v3_policy_v1",
        status: outcomeStatus,
        targetTrackCount: target,
        discoveredTrackCount: result.stages.discovered,
        qualifiedTrackCount: result.qualifiedPool.length,
        selectedTrackCount: result.selected.length,
        publishedTrackCount: 0,
        frontierExhausted: ["frontier_exhausted", "maximum_rounds_reached", "maximum_candidates_reached"].includes(stopReason),
        providerUnavailable: stopReason === "provider_circuit_open" || stopReason === "provider_failure",
        reasonCodes: [`pipeline_v3_${stopReason}`],
        stageCounts,
      });
      await persistPipelineOutcomeTransaction(client, runId, outcome);
      for (const entry of outcome.deficits) {
        await client.query(
          `INSERT INTO pipeline_deficit_ledger(
             id,run_id,stage,kind,status,required_count,actual_count,deficit_count,
             reason_code,detail_json,pipeline_version,policy_version,observed_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,
             'corpus_first_v3','corpus_first_v3_policy_v1',$11)
           ON CONFLICT(id) DO NOTHING`,
          [deterministicUuid({ runId, entry }), runId, entry.stage, entry.kind, entry.status, entry.requiredCount, entry.actualCount, entry.deficitCount, entry.reasonCode, JSON.stringify(entry.detail), entry.observedAt],
        );
      }

      if (!manifestId || !manifestRevisionId || !manifestHash) {
        await client.query(
          `UPDATE research_runs SET status='no_compatible_tracks',phase='pipeline_v3_no_compatible_tracks',
             error=NULL,completed_at=COALESCE(completed_at,now()),updated_at=now() WHERE id=$1`,
          [runId],
        );
        return { manifestId: null, manifestRevisionId: null, manifestHash: null, clientBucket: immutable.client_bucket, exact: false, existing: false };
      }

      const brief = immutable.brief_json;
      const normalizedTitle = normalizePlaylistTitle(brief.title, brief);
      const name = appendPlaylistTitleSuffix(normalizedTitle, `· ${new Date().toISOString().slice(0, 10)}`);
      const description = manifestDescriptionForBrief(brief);
      const manifestContractDatabaseId = immutable.active_playlist_contract_revision_id;
      const manifestContractHash = immutable.playlist_contract_json?.semanticHash ?? null;
      if (queryPlan.schemaVersion === 4 && (!manifestContractDatabaseId || !manifestContractHash)) {
        throw new HttpError(
          409,
          "Pipeline V3 manifest is missing its canonical contract binding",
          "manifest_contract_stale",
        );
      }
      const savedManifest = await client.query(
        `INSERT INTO manifests(
           id,run_id,name,description,content_hash,pipeline_version,policy_version,
           selection_plan_json,contract_revision_id,contract_hash)
         VALUES($1,$2,$3,$4,$5,'corpus_first_v3','corpus_first_v3_policy_v1',$6::jsonb,$7,$8)
         ON CONFLICT(run_id) DO UPDATE SET
           content_hash=EXCLUDED.content_hash,selection_plan_json=EXCLUDED.selection_plan_json
         WHERE manifests.contract_revision_id IS NOT DISTINCT FROM EXCLUDED.contract_revision_id
           AND manifests.contract_hash IS NOT DISTINCT FROM EXCLUDED.contract_hash`,
        [
          manifestId,
          runId,
          name,
          description,
          manifestHash,
          JSON.stringify(manifestSelectionPlan),
          manifestContractDatabaseId,
          manifestContractHash,
        ],
      );
      if ((savedManifest.rowCount ?? 0) !== 1) {
        throw new HttpError(
          409,
          "Pipeline V3 manifest retry conflicts with its canonical contract",
          "manifest_contract_stale",
        );
      }
      const latestRevision = await client.query<{ id: string; revision: number }>(
        `SELECT id,revision FROM manifest_revisions
         WHERE manifest_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
        [manifestId],
      );
      const parentRevisionId = latestRevision.rows[0]?.id ?? null;
      const manifestRevisionNumber = Number(latestRevision.rows[0]?.revision ?? 0) + 1;
      await client.query(
        `INSERT INTO manifest_revisions(
           id,manifest_id,revision,parent_revision_id,status,reason,content_hash,pipeline_version,
           policy_version,selection_plan_id,query_plan_revision_id,graph_snapshot_id,run_spec_hash,
           selection_plan_snapshot_json,pipeline_policy_snapshot_json,outcome_snapshot_json,
           deficit_snapshot_json,locked_at)
         VALUES($1,$2,$3,$4,'locked','Pipeline V3 governed retrieval result',$5,
           'corpus_first_v3','corpus_first_v3_policy_v1',$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,now())`,
        [
          manifestRevisionId,
          manifestId,
          manifestRevisionNumber,
          parentRevisionId,
          manifestHash,
          immutable.selection_plan_id,
          immutable.query_plan_id,
          immutable.graph_snapshot_id,
          immutable.run_spec_hash,
          JSON.stringify(manifestSelectionPlan),
          JSON.stringify(immutable.pipeline_policy_snapshot_json),
          JSON.stringify(outcome),
          JSON.stringify(outcome.deficits),
        ],
      );
      // `manifest_tracks` is the backward-compatible projection of the active
      // immutable revision. Historical revision rows remain untouched.
      await client.query("DELETE FROM manifest_tracks WHERE manifest_id=$1", [manifestId]);
      for (const [position, item] of persistedTracks.filter((item) => !item.reserve).entries()) {
        await client.query(
          `INSERT INTO manifest_revision_tracks(
             manifest_revision_id,position,candidate_id,recording_family_id,catalog_identity_id,
             catalog_id,artist,title) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [manifestRevisionId, position, item.candidateId, item.familyId, item.catalogIdentityId, item.track.appleSongId, item.track.artist.slice(0, 240), item.track.title.slice(0, 240)],
        );
        await client.query(
          `INSERT INTO manifest_tracks(manifest_id,position,candidate_id,catalog_id,artist,title)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [manifestId, position, item.candidateId, item.track.appleSongId.slice(0, 100), item.track.artist.slice(0, 240), item.track.title.slice(0, 240)],
        );
      }
      for (const [position, item] of persistedTracks.filter((item) => item.reserve).entries()) {
        await client.query(
          `INSERT INTO manifest_revision_reserve_tracks(
             manifest_revision_id,position,candidate_id,recording_family_id,catalog_identity_id,
             catalog_id,artist,title,evidence_eligible,hard_constraints_satisfied,version_compatible,qualified)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,true,true,true)`,
          [manifestRevisionId, position, item.candidateId, item.familyId, item.catalogIdentityId, item.track.appleSongId, item.track.artist.slice(0, 240), item.track.title.slice(0, 240)],
        );
      }

      if (result.outcome.status === "partial_ready") {
        const priorPartial = await client.query<{ state_json: Record<string, unknown> }>(
          `SELECT state_json FROM research_checkpoints
           WHERE run_id=$1 AND phase='partial_ready' FOR UPDATE`,
          [runId],
        );
        const priorState = priorPartial.rows[0]?.state_json;
        const priorVersion = Number(priorState?.outcomeVersion ?? 0);
        const sameOutcome = priorState?.queryPlanHash === queryHash
          && priorState?.manifestHash === manifestHash;
        const outcomeVersion = sameOutcome && Number.isSafeInteger(priorVersion) && priorVersion >= 1
          ? priorVersion
          : Number.isSafeInteger(priorVersion) && priorVersion >= 0 ? priorVersion + 1 : 1;
        const continuationStrategyIds = queryPlan.continuation
          ? []
          : result.strategies.filter((strategy) => (
              strategy.status === "available" || strategy.status === "running"
            )).map((strategy) => strategy.id);
        const outcomeHash = sha256Hex(stableStringify({
          runId,
          queryPlanHash: queryHash,
          outcomeVersion,
          targetTrackCount: result.outcome.requestedTrackCount,
          stopReason: result.outcome.stopReason,
          tracks: result.selected.map((track) => [
            track.candidateId,
            track.appleSongId,
            track.recordingFamilyKey,
          ]),
        }));
        await client.query(
          `INSERT INTO research_checkpoints(run_id,phase,state_json)
           VALUES($1,'partial_ready',$2::jsonb)
           ON CONFLICT(run_id,phase) DO UPDATE SET state_json=EXCLUDED.state_json,updated_at=now()`,
          [runId, JSON.stringify({
            outcomeHash,
            outcomeVersion,
            targetTrackCount: target,
            verifiedTrackCount: result.selected.length,
            shortfall: target - result.selected.length,
            remainingStrategyCount: continuationStrategyIds.length,
            continueAvailable: continuationStrategyIds.length > 0,
            continuationStrategyIds,
            preparedAt: new Date().toISOString(),
            pipelineVersion: "corpus_first_v3",
            stageKey: fence.stageKey,
            queryPlanHash: queryHash,
            queryPlanRevisionId: fence.queryPlanRevisionId,
            manifestId,
            manifestRevisionId,
            manifestHash,
          })],
        );
        await client.query(
          `UPDATE research_runs SET status='partial_ready',phase='partial_confirmation_required',
             error=NULL,completed_at=NULL,updated_at=now() WHERE id=$1`,
          [runId],
        );
      } else {
        await client.query(
          `UPDATE research_runs SET status='manifest_ready',phase='pipeline_v3_manifest_ready',
             error=NULL,completed_at=NULL,updated_at=now() WHERE id=$1`,
          [runId],
        );
      }
      return { manifestId, manifestRevisionId, manifestHash, clientBucket: immutable.client_bucket, exact: result.outcome.status === "exact_ready", existing: false };
    });

    if (!persisted.manifestId || !persisted.manifestRevisionId || !persisted.manifestHash) {
      await this.captureTerminalDiagnosticsSafely(runId);
      return { manifestId: null, manifestRevisionId: null, manifestHash: null, publicationState: "not_applicable" };
    }
    if (!persisted.exact) {
      return {
        manifestId: persisted.manifestId,
        manifestRevisionId: persisted.manifestRevisionId,
        manifestHash: persisted.manifestHash,
        publicationState: "partial_confirmation_required",
      };
    }
    const apple = await this.getAppleAuthorization();
    const publication = await this.queueManifestPublication({
      runId,
      manifestId: persisted.manifestId,
      appleAuthorized: apple?.status === "valid",
      clientBucket: persisted.clientBucket,
      clientBucketAliases: [persisted.clientBucket],
      rateLimit: Number.POSITIVE_INFINITY,
    });
    return {
      manifestId: persisted.manifestId,
      manifestRevisionId: persisted.manifestRevisionId,
      manifestHash: persisted.manifestHash,
      publicationState: publication.state === "waiting_for_apple_authorization"
        ? "waiting_for_apple_authorization"
        : "queued",
    };
  }

  async createManifestRevision(runId: string, revision: ManifestRevision): Promise<string> {
    boundedPipelineBatch(revision.tracks, 10_000, "Manifest revision tracks");
    const reserveTracks = revision.reserveTracks ?? [];
    boundedPipelineBatch(reserveTracks, 10_000, "Manifest revision reserve tracks");
    return this.transaction(async (client) => {
      const manifest = await client.query<{
        id: string;
        pipeline_version: PipelineVersion;
        policy_version: PipelinePolicyVersion;
        selection_plan_json: SelectionPlan | null;
        pipeline_policy_snapshot_json: PipelinePolicySnapshot | null;
        manifest_contract_revision_id: string | null;
        manifest_contract_hash: string | null;
        active_contract_revision_id: string | null;
        active_contract_hash: string | null;
        active_contract_json: PlaylistContractRevisionV1 | null;
      }>(
        `SELECT m.id,r.pipeline_version,r.policy_version,r.selection_plan_json,
                r.pipeline_policy_snapshot_json,
                m.contract_revision_id manifest_contract_revision_id,
                m.contract_hash manifest_contract_hash,
                r.active_playlist_contract_revision_id active_contract_revision_id,
                contract.contract_hash active_contract_hash,
                contract.contract_json active_contract_json
         FROM manifests m JOIN research_runs r ON r.id=m.run_id
         LEFT JOIN playlist_contract_revisions contract
           ON contract.id=r.active_playlist_contract_revision_id
             AND contract.status='active'
         WHERE m.id=$2 AND m.run_id=$1 AND r.deleted_at IS NULL FOR UPDATE OF m,r`,
        [runId, revision.manifestId],
      );
      const run = manifest.rows[0];
      if (!run) throw new HttpError(404, "Manifest not found", "manifest_not_found");
      if (run.pipeline_version !== revision.pipelineVersion || run.policy_version !== revision.policyVersion) {
        throw new HttpError(409, "Manifest revision versions do not match the immutable run", "pipeline_policy_mismatch");
      }
      let selectionPlanId: string | null = null;
      let queryPlanRevisionId: string | null = null;
      let graphSnapshotId: string | null = null;
      let runSpecHash: string | null = null;
      let v3SelectionPlanSnapshot: SelectionPlanV3 | null = null;
      let v3QueryPlanSnapshot: QueryPlanV3 | null = null;
      if (revision.pipelineVersion === "corpus_first_v3") {
        const immutable = await client.query<{
          selection_plan_id: string;
          query_plan_revision_id: string;
          graph_snapshot_id: string;
          run_spec_hash: string;
          selection_plan_json: SelectionPlanV3;
          query_plan_json: QueryPlanV3;
        }>(
          `SELECT selection.id selection_plan_id,query.id query_plan_revision_id,
                  query.graph_snapshot_id,spec.spec_hash run_spec_hash,
                  selection.plan_json selection_plan_json,
                  query.plan_json query_plan_json
           FROM run_specs spec
           JOIN run_active_query_plans active ON active.run_id=spec.run_id
           JOIN query_plan_revisions query ON query.id=active.query_plan_revision_id
           JOIN selection_plans selection ON selection.id=query.selection_plan_id
           JOIN graph_snapshots snapshot ON snapshot.id=query.graph_snapshot_id
           WHERE spec.run_id=$1 AND query.status='active' AND snapshot.status='locked'
           FOR SHARE OF spec,query,selection,snapshot`,
          [runId],
        );
        const binding = immutable.rows[0];
        if (!binding) {
          throw new HttpError(409, "Pipeline V3 manifest binding is incomplete", "manifest_revision_snapshot_missing");
        }
        selectionPlanId = binding.selection_plan_id;
        queryPlanRevisionId = binding.query_plan_revision_id;
        graphSnapshotId = binding.graph_snapshot_id;
        runSpecHash = binding.run_spec_hash;
        v3SelectionPlanSnapshot = binding.selection_plan_json;
        v3QueryPlanSnapshot = binding.query_plan_json;
        const suppliedBindings = [
          [revision.selectionPlanId, selectionPlanId],
          [revision.queryPlanRevisionId, queryPlanRevisionId],
          [revision.graphSnapshotId, graphSnapshotId],
          [revision.runSpecHash, runSpecHash],
        ] as const;
        if (suppliedBindings.some(([supplied, stored]) => supplied != null && supplied !== stored)) {
          throw new HttpError(409, "Pipeline V3 manifest bindings do not match the immutable run", "pipeline_v3_plan_stale");
        }
      }
      const existing = await client.query<{ id: string; revision: number; content_hash: string }>(
        `SELECT id,revision,content_hash FROM manifest_revisions
         WHERE manifest_id=$1 AND (revision=$2 OR content_hash=$3)`,
        [revision.manifestId, revision.revision, revision.contentHash],
      );
      if (existing.rows[0]) {
        if (Number(existing.rows[0].revision) !== revision.revision || existing.rows[0].content_hash !== revision.contentHash) {
          throw new HttpError(409, "Manifest revision conflicts with an existing immutable revision", "manifest_revision_conflict");
        }
        return existing.rows[0].id;
      }
      if (revision.parentRevisionId) {
        const parent = await client.query(
          "SELECT id FROM manifest_revisions WHERE id=$1 AND manifest_id=$2",
          [revision.parentRevisionId, revision.manifestId],
        );
        if (!parent.rows[0]) throw new HttpError(400, "Manifest revision parent is invalid", "manifest_revision_parent_invalid");
      }
      const candidateIds = [...new Set([
        ...revision.tracks.map((track) => track.candidateId),
        ...reserveTracks.map((track) => track.candidateId),
      ])];
      if (candidateIds.length > 0) {
        const owned = await client.query<{ count: number }>(
          "SELECT count(*)::int count FROM track_candidates WHERE run_id=$1 AND id=ANY($2::uuid[])",
          [runId, candidateIds],
        );
        if (Number(owned.rows[0]?.count ?? 0) !== candidateIds.length) {
          throw new HttpError(400, "Manifest revision references a candidate outside this research run", "manifest_revision_track_invalid");
        }
      }
      const familyIds = [...new Set([
        ...revision.tracks.map((track) => track.recordingFamilyId),
        ...reserveTracks.map((track) => track.recordingFamilyId),
      ].filter((id): id is string => Boolean(id)))];
      if (familyIds.length > 0) {
        const owned = await client.query<{ count: number }>(
          "SELECT count(*)::int count FROM recording_families WHERE run_id=$1 AND id=ANY($2::uuid[])",
          [runId, familyIds],
        );
        if (Number(owned.rows[0]?.count ?? 0) !== familyIds.length) {
          throw new HttpError(400, "Manifest revision references a recording family outside this research run", "manifest_revision_track_invalid");
        }
      }
      const identityIds = [...new Set([
        ...revision.tracks.map((track) => track.catalogIdentityId),
        ...reserveTracks.map((track) => track.catalogIdentityId),
      ].filter((id): id is string => Boolean(id)))];
      if (identityIds.length > 0) {
        const owned = await client.query<{ count: number }>(
          `SELECT count(*)::int count FROM recording_catalog_identities rci
           JOIN recording_families rf ON rf.id=rci.recording_family_id
           WHERE rf.run_id=$1 AND rci.id=ANY($2::uuid[])`,
          [runId, identityIds],
        );
        if (Number(owned.rows[0]?.count ?? 0) !== identityIds.length) {
          throw new HttpError(400, "Manifest revision references a catalog identity outside this research run", "manifest_revision_track_invalid");
        }
      }
      const positions = new Set<number>();
      for (const track of revision.tracks) {
        if (!Number.isInteger(track.position) || track.position < 0 || positions.has(track.position)) {
          throw new HttpError(400, "Manifest revision positions must be unique non-negative integers", "manifest_revision_track_invalid");
        }
        positions.add(track.position);
      }
      const selectedCandidateIds = new Set(revision.tracks.map((track) => track.candidateId));
      const selectedFamilyIds = new Set(revision.tracks
        .map((track) => track.recordingFamilyId)
        .filter((id): id is string => Boolean(id)));
      const reservePositions = new Set<number>();
      const reserveCandidateIds = new Set<string>();
      const reserveFamilyIds = new Set<string>();
      for (const reserve of reserveTracks) {
        if (!Number.isInteger(reserve.position) || reserve.position < 0 || reservePositions.has(reserve.position)
          || !reserve.candidateId || selectedCandidateIds.has(reserve.candidateId)
          || reserveCandidateIds.has(reserve.candidateId)
          || !reserve.recordingFamilyId || selectedFamilyIds.has(reserve.recordingFamilyId)
          || reserveFamilyIds.has(reserve.recordingFamilyId)
          || !reserve.catalogIdentityId || !reserve.catalogId.trim()
          || typeof reserve.evidenceEligible !== "boolean"
          || typeof reserve.hardConstraintsSatisfied !== "boolean"
          || typeof reserve.versionCompatible !== "boolean"
          || typeof reserve.qualified !== "boolean") {
          throw new HttpError(400, "Manifest revision reserve rows are invalid or not recording-unique", "manifest_revision_reserve_invalid");
        }
        reservePositions.add(reserve.position);
        reserveCandidateIds.add(reserve.candidateId);
        reserveFamilyIds.add(reserve.recordingFamilyId);
      }
      if (reserveTracks.length > 0) {
        const verified = await client.query<{ count: number }>(
          `WITH input AS (
             SELECT * FROM jsonb_to_recordset($2::jsonb) AS item(
               candidate_id uuid,recording_family_id uuid,catalog_identity_id uuid,catalog_id text
             )
           )
           SELECT count(*)::int count FROM input item
           JOIN track_candidates candidate ON candidate.id=item.candidate_id
             AND candidate.run_id=$1 AND candidate.recording_family_id=item.recording_family_id
           JOIN recording_catalog_identities identity ON identity.id=item.catalog_identity_id
             AND identity.recording_family_id=item.recording_family_id
             AND identity.provider='apple' AND identity.catalog_id=item.catalog_id`,
          [runId, JSON.stringify(reserveTracks.map((reserve) => ({
            candidate_id: reserve.candidateId,
            recording_family_id: reserve.recordingFamilyId,
            catalog_identity_id: reserve.catalogIdentityId,
            catalog_id: reserve.catalogId,
          })))],
        );
        if (Number(verified.rows[0]?.count ?? 0) !== reserveTracks.length) {
          throw new HttpError(400, "Manifest revision reserve identity is not an exact Apple recording for this run", "manifest_revision_reserve_invalid");
        }
      }
      if (revision.pipelineVersion === "corpus_first_v3"
        && v3QueryPlanSnapshot?.schemaVersion === 4) {
        const activeContract = run.active_contract_json;
        const activeContractBound = Boolean(
          run.active_contract_revision_id
          && run.active_contract_hash
          && activeContract
          && activeContract.revisionId
            === v3QueryPlanSnapshot.playlistContractRevisionId
          && activeContract.semanticHash
            === v3QueryPlanSnapshot.playlistContractSemanticHash
          && activeContract.versions.compiler
            === v3QueryPlanSnapshot.playlistContractCompilerVersion
          && run.manifest_contract_revision_id
            === run.active_contract_revision_id
          && run.manifest_contract_hash === run.active_contract_hash,
        );
        if (!activeContractBound || !v3SelectionPlanSnapshot) {
          throw new HttpError(
            409,
            "Canonical publication repair no longer belongs to the active contract",
            "manifest_contract_stale",
          );
        }
        const qualificationRows = await client.query<{
          candidate_id: string;
          artist: string;
          title: string;
          album: string | null;
          family_key: string;
          decision: string;
          revoked_at: Date | null;
          predicate_results_json: unknown;
          evidence_record_ids_json: unknown;
          quality_result_json: unknown;
          catalog_result_json: unknown;
        }>(
          `SELECT qualification.candidate_id,candidate.artist,candidate.title,
                  candidate.album,family.family_key,qualification.decision,
                  qualification.revoked_at,
                  qualification.predicate_results_json,
                  qualification.evidence_record_ids_json,
                  qualification.quality_result_json,
                  qualification.catalog_result_json
           FROM playlist_qualification_records qualification
           JOIN track_candidates candidate
             ON candidate.id=qualification.candidate_id
            AND candidate.run_id=qualification.run_id
           JOIN recording_families family
             ON family.id=candidate.recording_family_id
            AND family.run_id=qualification.run_id
           WHERE qualification.run_id=$1
             AND qualification.contract_revision_id=$2
             AND qualification.candidate_id=ANY($3::uuid[])
             AND lower(qualification.storefront)=lower($4)
             AND qualification.decision='qualified'
             AND qualification.revoked_at IS NULL
             AND qualification.quality_result_json->>'verdict'='pass'
             AND qualification.catalog_result_json->>'verdict'='pass'
           ORDER BY qualification.candidate_id,
                    qualification.qualified_at DESC,qualification.id DESC`,
          [
            runId,
            run.active_contract_revision_id,
            revision.tracks.map(({ candidateId }) => candidateId),
            v3SelectionPlanSnapshot.storefront,
          ],
        );
        const qualifications: PersistedCanonicalQualificationV1[] =
          qualificationRows.rows.map((row) => ({
            candidateId: row.candidate_id,
            artist: row.artist,
            title: row.title,
            album: row.album,
            recordingFamilyKey: row.family_key,
            decision: row.decision,
            revokedAt: row.revoked_at,
            predicateResults: row.predicate_results_json,
            evidenceRecordIds: row.evidence_record_ids_json,
            qualityResult: row.quality_result_json,
            catalogResult: row.catalog_result_json,
          }));
        assertCanonicalManifestRevisionV1({
          plan: v3SelectionPlanSnapshot,
          manifestTracks: revision.tracks,
          qualifications,
          partialPublicationAuthorized: false,
        });
      }
      let selectionPlanSnapshot = revision.selectionPlanSnapshot;
      let policySnapshot = revision.policySnapshot;
      let outcomeSnapshot = revision.outcomeSnapshot;
      let deficitSnapshot = revision.deficitSnapshot;
      if (revision.pipelineVersion !== "legacy_v1" && revision.status !== "draft") {
        const storedOutcome = await client.query<{ outcome_json: PipelineOutcome }>(
          "SELECT outcome_json FROM pipeline_outcomes WHERE run_id=$1 FOR SHARE",
          [runId],
        );
        selectionPlanSnapshot = revision.pipelineVersion === "corpus_first_v3"
          ? v3SelectionPlanSnapshot as unknown as SelectionPlan
          : run.selection_plan_json;
        policySnapshot = run.pipeline_policy_snapshot_json;
        outcomeSnapshot = storedOutcome.rows[0]?.outcome_json ?? null;
        deficitSnapshot = outcomeSnapshot?.deficits ?? [];
        if (!selectionPlanSnapshot || !policySnapshot || !outcomeSnapshot) {
          throw new HttpError(
            409,
            "Pipeline manifest revisions require persisted plan, policy, and outcome snapshots",
            "manifest_revision_snapshot_missing",
          );
        }
      }
      const id = revision.id || randomUUID();
      await client.query(
        `INSERT INTO manifest_revisions(
           id,manifest_id,revision,parent_revision_id,status,reason,content_hash,pipeline_version,
           policy_version,selection_plan_id,query_plan_revision_id,graph_snapshot_id,run_spec_hash,
           selection_plan_snapshot_json,pipeline_policy_snapshot_json,
           outcome_snapshot_json,deficit_snapshot_json,locked_at,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,
           $16::jsonb,$17::jsonb,$18,$19)`,
        [
          id,
          revision.manifestId,
          revision.revision,
          revision.parentRevisionId,
          revision.status,
          revision.reason,
          revision.contentHash,
          revision.pipelineVersion,
          revision.policyVersion,
          selectionPlanId,
          queryPlanRevisionId,
          graphSnapshotId,
          runSpecHash,
          selectionPlanSnapshot == null ? null : JSON.stringify(selectionPlanSnapshot),
          policySnapshot == null ? null : JSON.stringify(policySnapshot),
          outcomeSnapshot == null ? null : JSON.stringify(outcomeSnapshot),
          JSON.stringify(deficitSnapshot),
          revision.lockedAt == null ? null : date(revision.lockedAt),
          date(revision.createdAt) ?? new Date(),
        ],
      );
      for (const track of revision.tracks) {
        await client.query(
          `INSERT INTO manifest_revision_tracks(
             manifest_revision_id,position,candidate_id,recording_family_id,catalog_identity_id,
             catalog_id,artist,title) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            track.position,
            track.candidateId,
            track.recordingFamilyId,
            track.catalogIdentityId,
            track.catalogId,
            track.artist,
            track.title,
          ],
        );
      }
      for (const reserve of reserveTracks) {
        await client.query(
          `INSERT INTO manifest_revision_reserve_tracks(
             manifest_revision_id,position,candidate_id,recording_family_id,catalog_identity_id,
             catalog_id,artist,title,evidence_eligible,hard_constraints_satisfied,
             version_compatible,qualified)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            id,
            reserve.position,
            reserve.candidateId,
            reserve.recordingFamilyId,
            reserve.catalogIdentityId,
            reserve.catalogId,
            reserve.artist,
            reserve.title,
            reserve.evidenceEligible,
            reserve.hardConstraintsSatisfied,
            reserve.versionCompatible,
            reserve.qualified,
          ],
        );
      }
      if (revision.pipelineVersion !== "legacy_v1" && revision.tracks.length > 0) {
        await advanceCandidateStagesTransaction(
          client,
          runId,
          revision.tracks.map((track) => ({
            candidateId: track.candidateId,
            stages: [
              {
                toStage: "quota_eligible",
                reasonCode: "manifest_revision_quota_selected",
                detail: { manifestId: revision.manifestId, revision: revision.revision, position: track.position },
              },
              {
                toStage: "sequenced",
                reasonCode: "manifest_revision_sequence_assigned",
                detail: { manifestId: revision.manifestId, revision: revision.revision, position: track.position },
              },
              {
                toStage: "manifested",
                reasonCode: "manifest_revision_locked",
                detail: { manifestId: revision.manifestId, revision: revision.revision, position: track.position },
              },
            ],
          })),
          { pipelineVersion: revision.pipelineVersion, policyVersion: revision.policyVersion },
        );
      }
      return id;
    });
  }

  async getManifestRevision(runId: string, revisionId: string): Promise<ManifestRevision | null> {
    const [revision, tracks, reserveTracks] = await Promise.all([
      this.pool.query(
        `SELECT mr.* FROM manifest_revisions mr
         JOIN manifests m ON m.id=mr.manifest_id
         JOIN research_runs r ON r.id=m.run_id
         WHERE mr.id=$2 AND m.run_id=$1 AND r.deleted_at IS NULL`,
        [runId, revisionId],
      ),
      this.pool.query(
        `SELECT mrt.* FROM manifest_revision_tracks mrt
         JOIN manifest_revisions mr ON mr.id=mrt.manifest_revision_id
         JOIN manifests m ON m.id=mr.manifest_id
         WHERE mrt.manifest_revision_id=$2 AND m.run_id=$1 ORDER BY mrt.position`,
        [runId, revisionId],
      ),
      this.pool.query(
        `SELECT reserve.* FROM manifest_revision_reserve_tracks reserve
         JOIN manifest_revisions revision ON revision.id=reserve.manifest_revision_id
         JOIN manifests manifest ON manifest.id=revision.manifest_id
         WHERE reserve.manifest_revision_id=$2 AND manifest.run_id=$1 ORDER BY reserve.position`,
        [runId, revisionId],
      ),
    ]);
    const row = revision.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      manifestId: row.manifest_id,
      revision: Number(row.revision),
      parentRevisionId: row.parent_revision_id,
      status: row.status,
      reason: row.reason,
      contentHash: row.content_hash,
      pipelineVersion: row.pipeline_version,
      policyVersion: row.policy_version,
      selectionPlanId: row.selection_plan_id ?? null,
      queryPlanRevisionId: row.query_plan_revision_id ?? null,
      graphSnapshotId: row.graph_snapshot_id ?? null,
      runSpecHash: row.run_spec_hash ?? null,
      selectionPlanSnapshot: row.selection_plan_snapshot_json ?? null,
      policySnapshot: row.pipeline_policy_snapshot_json ?? null,
      outcomeSnapshot: row.outcome_snapshot_json ?? null,
      deficitSnapshot: Array.isArray(row.deficit_snapshot_json) ? row.deficit_snapshot_json : [],
      lockedAt: date(row.locked_at)?.toISOString() ?? null,
      createdAt: date(row.created_at)?.toISOString() ?? new Date(0).toISOString(),
      tracks: tracks.rows.map((track): ManifestRevisionTrack => ({
        position: Number(track.position),
        candidateId: track.candidate_id,
        recordingFamilyId: track.recording_family_id,
        catalogIdentityId: track.catalog_identity_id,
        catalogId: track.catalog_id,
        artist: track.artist,
        title: track.title,
      })),
      reserveTracks: reserveTracks.rows.map((reserve): ManifestRevisionReserveTrack => ({
        position: Number(reserve.position),
        candidateId: reserve.candidate_id,
        recordingFamilyId: reserve.recording_family_id,
        catalogIdentityId: reserve.catalog_identity_id,
        catalogId: reserve.catalog_id,
        artist: reserve.artist,
        title: reserve.title,
        evidenceEligible: reserve.evidence_eligible === true,
        hardConstraintsSatisfied: reserve.hard_constraints_satisfied === true,
        versionCompatible: reserve.version_compatible === true,
        qualified: reserve.qualified === true,
      })),
    };
  }

  async markManifestRevisionStatus(
    runId: string,
    revisionId: string,
    status: ManifestRevisionStatus,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE manifest_revisions mr SET status=$3,
         locked_at=CASE WHEN $3 IN ('locked','published') THEN COALESCE(mr.locked_at,now()) ELSE mr.locked_at END
       FROM manifests m
       WHERE mr.id=$2 AND m.id=mr.manifest_id AND m.run_id=$1
       RETURNING mr.id`,
      [runId, revisionId, status],
    );
    if (!result.rows[0]) throw new HttpError(404, "Manifest revision not found", "manifest_revision_not_found");
  }

  async consumeRateLimit(clientBucketAliases: string[], action: string, limit: number, windowHours = 24): Promise<{ remaining: number }> {
    const primary = clientBucketAliases[0];
    if (!primary) throw new HttpError(401, "Client bucket is required", "invalid_gateway_identity");
    return this.transaction(async (client) => {
      await lockClientAliases(client, `rate:${action}`, clientBucketAliases);
      const count = await client.query<{ count: number }>(
        `SELECT count(*)::int count FROM rate_limit_events
         WHERE client_bucket=ANY($1::text[]) AND action=$2 AND occurred_at>now()-($3::text || ' hours')::interval`,
        [clientBucketAliases, action, String(windowHours)],
      );
      if (count.rows[0]!.count >= limit) throw new HttpError(429, "Rate limit reached; try again later", "rate_limited");
      await client.query("INSERT INTO rate_limit_events(client_bucket,action) VALUES($1,$2)", [primary, action]);
      return { remaining: Math.max(0, limit - count.rows[0]!.count - 1) };
    });
  }

  async assertGlobalRunCapacity(limit = 10): Promise<void> {
    const result = await this.pool.query<{ count: number }>("SELECT count(*)::int count FROM research_runs WHERE status=ANY($1::text[]) AND deleted_at IS NULL", [CAPACITY_RUN_STATUSES]);
    if (result.rows[0]!.count >= limit) throw new HttpError(503, "gênio is at capacity; try again soon", "global_capacity_reached");
  }

  async claimGatewayNonce(keyId: string, nonce: string, expiresAt: Date): Promise<boolean> {
    const result = await this.transaction(async (client) => {
      await client.query("DELETE FROM gateway_nonces WHERE expires_at<now()");
      return client.query(
        "INSERT INTO gateway_nonces(key_id,nonce,expires_at) VALUES($1,$2,$3) ON CONFLICT(key_id,nonce) DO NOTHING RETURNING nonce",
        [keyId, nonce, expiresAt],
      );
    });
    return Boolean(result.rows[0]);
  }

  async createCapabilityToken(runId: string, accessId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      "INSERT INTO capability_tokens(id,run_id,access_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), runId, accessId, tokenHash, expiresAt],
    );
  }

  async attachCapabilitySessionToBrief(briefRequestId: string, session: {
    id: string;
    tokenHash?: string;
    expiresAt?: Date;
    reuseExisting?: boolean;
  }): Promise<any | null> {
    return this.transaction(async (client) => {
      const brief = await client.query(
        "SELECT 1 FROM brief_requests WHERE id=$1 AND expires_at>now() FOR KEY SHARE",
        [briefRequestId],
      );
      if (!brief.rows[0]) return null;

      let expiresAt: Date;
      if (session.reuseExisting) {
        const existing = await client.query<{ expires_at: Date }>(
          `SELECT expires_at FROM capability_sessions
           WHERE id=$1 AND revoked_at IS NULL AND expires_at>now()
           FOR UPDATE`,
          [session.id],
        );
        if (!existing.rows[0]) return null;
        expiresAt = date(existing.rows[0].expires_at)!;
      } else {
        if (!session.tokenHash || !session.expiresAt) {
          throw new Error("New capability sessions require a token and expiry");
        }
        expiresAt = session.expiresAt;
        await client.query(
          `INSERT INTO capability_sessions(id,run_id,access_id,token_hash,expires_at)
           VALUES($1,NULL,NULL,$2,$3)`,
          [session.id, session.tokenHash, expiresAt],
        );
      }
      await client.query(
        `INSERT INTO capability_session_briefs(session_id,brief_request_id)
         VALUES($1,$2) ON CONFLICT(session_id,brief_request_id) DO NOTHING`,
        [session.id, briefRequestId],
      );
      const latestRun = await client.query<{ run_id: string; access_id: string }>(
        `SELECT csa.run_id,csa.access_id
         FROM capability_session_accesses csa
         JOIN run_accesses a ON a.id=csa.access_id AND a.run_id=csa.run_id
         JOIN research_runs r ON r.id=csa.run_id
         WHERE csa.session_id=$1
           AND a.deleted_at IS NULL AND a.expires_at>now() AND r.deleted_at IS NULL
         ORDER BY csa.created_at DESC,csa.access_id DESC LIMIT 1`,
        [session.id],
      );
      return {
        id: session.id,
        runId: latestRun.rows[0]?.run_id ?? null,
        accessId: latestRun.rows[0]?.access_id ?? null,
        expiresAt,
      };
    });
  }

  async exchangeCapabilityToken(tokenHash: string, session: {
    id: string;
    tokenHash?: string;
    expiresAt?: Date;
    reuseExisting?: boolean;
  }): Promise<any | null> {
    return this.transaction(async (client) => {
      const token = await client.query<{ id: string; run_id: string; access_id: string }>(
        `SELECT id,run_id,access_id FROM capability_tokens WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`,
        [tokenHash],
      );
      if (!token.rows[0]) return null;
      const access = await client.query(
        "SELECT 1 FROM run_accesses WHERE id=$1 AND deleted_at IS NULL AND expires_at>now() FOR KEY SHARE",
        [token.rows[0].access_id],
      );
      if (!access.rows[0]) return null;
      let expiresAt: Date;
      if (session.reuseExisting) {
        const existing = await client.query<{ expires_at: Date }>(
          `SELECT s.expires_at FROM capability_sessions s
           WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
             AND (
               EXISTS (
                 SELECT 1 FROM capability_session_accesses csa
                 JOIN run_accesses a ON a.id=csa.access_id AND a.run_id=csa.run_id
                 WHERE csa.session_id=s.id AND a.deleted_at IS NULL AND a.expires_at>now()
               )
               OR EXISTS (
                 SELECT 1 FROM capability_session_briefs csb
                 JOIN brief_requests b ON b.id=csb.brief_request_id
                 WHERE csb.session_id=s.id AND b.expires_at>now()
               )
             )
           FOR UPDATE`,
          [session.id],
        );
        if (!existing.rows[0]) return null;
        expiresAt = date(existing.rows[0].expires_at)!;
      } else {
        if (!session.tokenHash || !session.expiresAt) throw new Error("New capability sessions require a token and expiry");
        expiresAt = session.expiresAt;
        await client.query(
          "INSERT INTO capability_sessions(id,run_id,access_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5)",
          [session.id, token.rows[0].run_id, token.rows[0].access_id, session.tokenHash, expiresAt],
        );
      }
      await client.query("UPDATE capability_tokens SET consumed_at=now() WHERE id=$1", [token.rows[0].id]);
      await this.attachCapabilitySessionAccess(client, session.id, token.rows[0].run_id, token.rows[0].access_id);
      return { id: session.id, runId: token.rows[0].run_id, accessId: token.rows[0].access_id, expiresAt };
    });
  }

  async getCapabilitySession(tokenHash: string): Promise<any | null> {
    const result = await this.pool.query(
      `WITH live_session AS (
         UPDATE capability_sessions s SET last_seen_at=now(),updated_at=now()
         WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
           AND (
             EXISTS (
               SELECT 1 FROM capability_session_accesses csa
               JOIN run_accesses a ON a.id=csa.access_id AND a.run_id=csa.run_id
               JOIN research_runs r ON r.id=csa.run_id
               WHERE csa.session_id=s.id
                 AND a.deleted_at IS NULL AND a.expires_at>now() AND r.deleted_at IS NULL
             )
             OR EXISTS (
               SELECT 1 FROM capability_session_briefs csb
               JOIN brief_requests b ON b.id=csb.brief_request_id
               WHERE csb.session_id=s.id AND b.expires_at>now()
             )
           )
         RETURNING s.id,s.expires_at
       )
       SELECT ls.id,aa.run_id,aa.access_id,ls.expires_at
       FROM live_session ls
       LEFT JOIN LATERAL (
         SELECT csa.run_id,csa.access_id
         FROM capability_session_accesses csa
         JOIN run_accesses a ON a.id=csa.access_id AND a.run_id=csa.run_id
         JOIN research_runs r ON r.id=csa.run_id
         WHERE csa.session_id=ls.id
           AND a.deleted_at IS NULL AND a.expires_at>now() AND r.deleted_at IS NULL
         ORDER BY csa.created_at DESC,csa.access_id DESC LIMIT 1
       ) aa ON true`,
      [tokenHash],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      runId: row.run_id ?? null,
      accessId: row.access_id ?? null,
      expiresAt: date(row.expires_at)!,
    } : null;
  }

  async getCapabilitySessionAccess(sessionId: string, accessId: string): Promise<{ runId: string; accessId: string } | null> {
    const result = await this.pool.query<{ run_id: string; access_id: string }>(
      `SELECT csa.run_id,csa.access_id
       FROM capability_session_accesses csa
       JOIN capability_sessions s ON s.id=csa.session_id
       JOIN run_accesses a ON a.id=csa.access_id AND a.run_id=csa.run_id
       JOIN research_runs r ON r.id=csa.run_id
       WHERE csa.session_id=$1 AND csa.access_id=$2
         AND s.revoked_at IS NULL AND s.expires_at>now()
         AND a.deleted_at IS NULL AND a.expires_at>now()
         AND r.deleted_at IS NULL`,
      [sessionId, accessId],
    );
    return result.rows[0]
      ? { runId: result.rows[0].run_id, accessId: result.rows[0].access_id }
      : null;
  }

  async getCapabilitySessionBrief(sessionId: string, briefRequestId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
       FROM capability_session_briefs csb
       JOIN capability_sessions s ON s.id=csb.session_id
       JOIN brief_requests b ON b.id=csb.brief_request_id
       WHERE csb.session_id=$1 AND csb.brief_request_id=$2
         AND s.revoked_at IS NULL AND s.expires_at>now()
         AND b.expires_at>now()`,
      [sessionId, briefRequestId],
    );
    return Boolean(result.rows[0]);
  }

  async revokeCapabilitySession(sessionId: string): Promise<void> {
    await this.pool.query("UPDATE capability_sessions SET revoked_at=now(),updated_at=now() WHERE id=$1", [sessionId]);
  }

  async reserveProviderCost(subjectOrRunId: CostSubject | string | null, operation: string, maxUsd: number): Promise<{ reservationId: string }> {
    const subject: CostSubject = typeof subjectOrRunId === "string" ? { runId: subjectOrRunId } : subjectOrRunId ?? {};
    const amount = finiteMoney(maxUsd, "Reserved cost");
    if (!subject.runId && !subject.briefRequestId) throw new HttpError(400, "Cost reservation requires a run or brief", "invalid_cost_subject");
    const idempotencyKey = sha256Hex(`${subject.runId ?? ""}\n${subject.briefRequestId ?? ""}\n${operation}`);
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [BUDGET_ADVISORY_LOCK]);
      const expired = await client.query<{ run_id: string | null; reserved_usd: string }>(
        "UPDATE cost_reservations SET status='released',reconciled_at=now() WHERE status='reserved' AND expires_at<=now() RETURNING run_id,reserved_usd",
      );
      for (const item of expired.rows) {
        if (item.run_id) await client.query("UPDATE research_runs SET reserved_cost_usd=GREATEST(0,reserved_cost_usd-$2),updated_at=now() WHERE id=$1", [item.run_id, Number(item.reserved_usd)]);
      }
      const existing = await client.query<{ id: string; status: string }>("SELECT id,status FROM cost_reservations WHERE idempotency_key=$1 FOR UPDATE", [idempotencyKey]);
      if (existing.rows[0] && existing.rows[0].status !== "released") return { reservationId: existing.rows[0].id };
      if (subject.briefRequestId) {
        const scoutOperation = isGuidanceScoutOperation(operation);
        const briefCeiling = scoutOperation ? GUIDED_SCOUT_BUDGET_USD : GUIDED_BRIEF_BUDGET_USD;
        const briefBudget = await client.query<{ spent: number; reserved: number; exists: boolean }>(
          `SELECT
             EXISTS(SELECT 1 FROM brief_requests WHERE id=$1 AND expires_at>now()) exists,
             COALESCE((
               SELECT sum(amount_usd) FROM cost_ledger
               WHERE brief_request_id=$1
                 AND (($2::boolean AND (operation LIKE 'brief.question_scout%' OR operation LIKE 'brief.scout%'))
                   OR (NOT $2::boolean AND operation NOT LIKE 'brief.question_scout%' AND operation NOT LIKE 'brief.scout%'))
             ),0)::float8 spent,
             COALESCE((
               SELECT sum(reserved_usd)
               FROM cost_reservations
               WHERE brief_request_id=$1 AND status='reserved' AND expires_at>now()
                 AND (($2::boolean AND (operation LIKE 'brief.question_scout%' OR operation LIKE 'brief.scout%'))
                   OR (NOT $2::boolean AND operation NOT LIKE 'brief.question_scout%' AND operation NOT LIKE 'brief.scout%'))
             ),0)::float8 reserved`,
          [subject.briefRequestId, scoutOperation],
        );
        if (!briefBudget.rows[0]?.exists) {
          throw new HttpError(404, "Brief request not found", "brief_not_found");
        }
        const projected = briefBudget.rows[0].spent + briefBudget.rows[0].reserved + amount;
        if (projected > briefCeiling + 0.000001) {
          throw new HttpError(
            402,
            "Playlist guidance reached its cost limit",
            "brief_budget_reached",
          );
        }
      }
      const monthly = await client.query<{ spent: number; reserved: number }>(
        `SELECT
          COALESCE((SELECT sum(amount_usd) FROM cost_ledger WHERE occurred_at >= date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'),0)::float8 spent,
          COALESCE((SELECT sum(reserved_usd) FROM cost_reservations WHERE status='reserved' AND expires_at>now()),0)::float8 reserved`,
      );
      const ceiling = readCostConfiguration().monthlyCostLimitUsd;
      if (monthly.rows[0]!.spent + monthly.rows[0]!.reserved + amount > ceiling) {
        throw new HttpError(402, "Monthly research budget has been reached", "monthly_budget_reached");
      }
      if (subject.runId) {
        const run = await client.query("SELECT actual_cost_usd,reserved_cost_usd,approved_budget_usd FROM research_runs WHERE id=$1 FOR UPDATE", [subject.runId]);
        if (!run.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
        const projected = Number(run.rows[0].actual_cost_usd) + Number(run.rows[0].reserved_cost_usd) + amount;
        if (projected > Number(run.rows[0].approved_budget_usd)) throw new HttpError(402, "Run needs additional budget approval", "run_budget_reached");
      }
      const id = existing.rows[0]?.id ?? randomUUID();
      if (existing.rows[0]) {
        await client.query(
          `UPDATE cost_reservations SET status='reserved',reserved_usd=$2,actual_usd=NULL,usage_json=NULL,expires_at=now()+interval '30 minutes',reconciled_at=NULL WHERE id=$1`,
          [id, amount],
        );
      } else {
        await client.query(
          `INSERT INTO cost_reservations(id,run_id,brief_request_id,operation,idempotency_key,reserved_usd,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,now()+interval '30 minutes')`,
          [id, subject.runId ?? null, subject.briefRequestId ?? null, operation.slice(0, 120), idempotencyKey, amount],
        );
      }
      if (subject.runId) await client.query("UPDATE research_runs SET reserved_cost_usd=reserved_cost_usd+$2,updated_at=now() WHERE id=$1", [subject.runId, amount]);
      return { reservationId: id };
    });
  }

  async reconcileProviderCost(reservationId: string, actualUsd: number, usage: unknown = null): Promise<void> {
    const actual = finiteMoney(actualUsd, "Actual cost");
    const overrun = await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [BUDGET_ADVISORY_LOCK]);
      const reservation = await client.query("SELECT * FROM cost_reservations WHERE id=$1 FOR UPDATE", [reservationId]);
      const row = reservation.rows[0];
      if (!row) throw new HttpError(404, "Cost reservation not found", "reservation_not_found");
      if (row.status === "reconciled" || row.status === "reconciled_overrun") return false;
      if (row.status !== "reserved") throw new HttpError(409, "Cost reservation is no longer active", "reservation_inactive");
      const reserved = Number(row.reserved_usd);
      const monthly = await client.query<{ spent: number; reserved: number }>(
        `SELECT
          COALESCE((SELECT sum(amount_usd) FROM cost_ledger WHERE occurred_at >= date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'),0)::float8 spent,
          COALESCE((SELECT sum(reserved_usd) FROM cost_reservations WHERE status='reserved'),0)::float8 reserved`,
      );
      const monthlyCeiling = readCostConfiguration().monthlyCostLimitUsd;
      const monthlyProjected = monthly.rows[0]!.spent + Math.max(0, monthly.rows[0]!.reserved - reserved) + actual;
      let runCeilingExceeded = false;
      let briefCeilingExceeded = false;
      if (row.run_id) {
        const run = await client.query(
          "SELECT actual_cost_usd,reserved_cost_usd,approved_budget_usd FROM research_runs WHERE id=$1 FOR UPDATE",
          [row.run_id],
        );
        if (!run.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
        const projected = Number(run.rows[0].actual_cost_usd)
          + Math.max(0, Number(run.rows[0].reserved_cost_usd) - reserved)
          + actual;
        runCeilingExceeded = projected > Number(run.rows[0].approved_budget_usd) + 0.000001;
      }
      if (row.brief_request_id) {
        const scoutOperation = isGuidanceScoutOperation(row.operation);
        const briefCeiling = scoutOperation ? GUIDED_SCOUT_BUDGET_USD : GUIDED_BRIEF_BUDGET_USD;
        const brief = await client.query<{ spent: number; reserved: number }>(
          `SELECT
             COALESCE((
               SELECT sum(amount_usd) FROM cost_ledger
               WHERE brief_request_id=$1
                 AND (($3::boolean AND (operation LIKE 'brief.question_scout%' OR operation LIKE 'brief.scout%'))
                   OR (NOT $3::boolean AND operation NOT LIKE 'brief.question_scout%' AND operation NOT LIKE 'brief.scout%'))
             ),0)::float8 spent,
             COALESCE((
               SELECT sum(reserved_usd)
               FROM cost_reservations
               WHERE brief_request_id=$1 AND status='reserved' AND expires_at>now() AND id<>$2
                 AND (($3::boolean AND (operation LIKE 'brief.question_scout%' OR operation LIKE 'brief.scout%'))
                   OR (NOT $3::boolean AND operation NOT LIKE 'brief.question_scout%' AND operation NOT LIKE 'brief.scout%'))
             ),0)::float8 reserved`,
          [row.brief_request_id, reservationId, scoutOperation],
        );
        const projected = (brief.rows[0]?.spent ?? 0)
          + (brief.rows[0]?.reserved ?? 0)
          + actual;
        briefCeilingExceeded = projected > briefCeiling + 0.000001;
      }
      const exceededCeiling = monthlyProjected > monthlyCeiling + 0.000001
        || runCeilingExceeded
        || briefCeilingExceeded;
      await client.query(
        "UPDATE cost_reservations SET status=$2,actual_usd=$3,usage_json=$4,reconciled_at=now() WHERE id=$1",
        [reservationId, exceededCeiling ? "reconciled_overrun" : "reconciled", actual, usage],
      );
      await client.query(
        `INSERT INTO cost_ledger(id,run_id,brief_request_id,reservation_id,operation,amount_usd,usage_json)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), row.run_id, row.brief_request_id, reservationId, row.operation, actual, usage],
      );
      if (row.run_id) {
        await client.query(
          `UPDATE research_runs SET
             reserved_cost_usd=GREATEST(0,reserved_cost_usd-$2),
             actual_cost_usd=actual_cost_usd+$3,
             status=CASE WHEN $4 THEN 'awaiting_budget' ELSE status END,
             error=CASE WHEN $4 THEN 'Actual provider usage crossed an approved cost ceiling; owner budget review is required before resuming.' ELSE error END,
             budget_approval_expires_at=CASE WHEN $4 THEN now()+interval '7 days' ELSE budget_approval_expires_at END,
             updated_at=now()
           WHERE id=$1`,
          [row.run_id, reserved, actual, exceededCeiling],
        );
      }
      return exceededCeiling;
    });
    try {
      if (Number(await this.getSchemaVersion() ?? 0) >= 16) {
        const metric = await this.pool.query<{
          run_id: string | null;
          operation: string;
          status: string;
          usage_json: Record<string, unknown> | null;
        }>(
          "SELECT run_id,operation,status,usage_json FROM cost_reservations WHERE id=$1",
          [reservationId],
        );
        const row = metric.rows[0];
        if (row) {
          await this.recordProviderMetric({
            runId: row.run_id,
            provider: "openai",
            operation: row.operation,
            stageKey: row.operation.split(".")[0] || "provider",
            metricName: "provider_requests",
            metricValue: 1,
            requestOutcome: row.status,
            idempotencyKey: `openai:${reservationId}:request`,
          });
          const latencyMs = Math.max(0, Math.floor(Number(row.usage_json?.latencyMs ?? 0) || 0));
          if (latencyMs > 0) {
            await this.recordProviderMetric({
              runId: row.run_id,
              provider: "openai",
              operation: row.operation,
              stageKey: row.operation.split(".")[0] || "provider",
              metricName: "latency_ms",
              metricValue: latencyMs,
              requestOutcome: row.status,
              idempotencyKey: `openai:${reservationId}:latency`,
            });
          }
        }
      }
    } catch (error) {
      console.error("[provider-metrics] reconciliation telemetry failed", {
        reservationId,
        message: error instanceof Error ? error.message.slice(0, 500) : "unknown error",
      });
    }
    if (overrun) {
      throw new HttpError(
        402,
        "Actual provider usage crossed an approved cost ceiling; further paid work is paused",
        "provider_cost_overrun",
      );
    }
  }

  async releaseProviderCost(reservationId: string): Promise<void> {
    await this.transaction(async (client) => {
      const reservation = await client.query("SELECT * FROM cost_reservations WHERE id=$1 FOR UPDATE", [reservationId]);
      const row = reservation.rows[0];
      if (!row || row.status !== "reserved") return;
      await client.query("UPDATE cost_reservations SET status='released',reconciled_at=now() WHERE id=$1", [reservationId]);
      if (row.run_id) await client.query("UPDATE research_runs SET reserved_cost_usd=GREATEST(0,reserved_cost_usd-$2),updated_at=now() WHERE id=$1", [row.run_id, Number(row.reserved_usd)]);
    });
  }

  async appendCostLedger(subject: CostSubject, operation: string, amountUsd: number, usage: unknown = null): Promise<void> {
    const amount = finiteMoney(amountUsd, "Cost");
    await this.transaction(async (client) => {
      await client.query(
        "INSERT INTO cost_ledger(id,run_id,brief_request_id,operation,amount_usd,usage_json) VALUES($1,$2,$3,$4,$5,$6)",
        [randomUUID(), subject.runId ?? null, subject.briefRequestId ?? null, operation.slice(0, 120), amount, usage],
      );
      if (subject.runId) await client.query("UPDATE research_runs SET actual_cost_usd=actual_cost_usd+$2,updated_at=now() WHERE id=$1", [subject.runId, amount]);
    });
  }

  async getAppleAuthorization(): Promise<any | null> {
    const result = await this.pool.query("SELECT * FROM apple_authorizations WHERE id='owner'");
    const row = result.rows[0];
    if (!row) return null;
    return {
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.auth_tag,
      keyVersion: row.key_version,
      storefront: row.storefront,
      status: row.status,
      lastValidatedAt: date(row.last_validated_at),
      lastError: sanitizeOptionalFailure(row.last_error, "apple_authorization"),
      updatedAt: date(row.updated_at),
    };
  }

  async saveAppleAuthorization(input: EncryptedAppleAuthorizationInput): Promise<void> {
    const persistedLastError = sanitizeOptionalFailure(input.lastError, "apple_authorization");
    await this.pool.query(
      `INSERT INTO apple_authorizations(id,ciphertext,iv,auth_tag,key_version,storefront,status,last_validated_at,last_error)
       VALUES('owner',$1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,
       iv=EXCLUDED.iv,auth_tag=EXCLUDED.auth_tag,key_version=EXCLUDED.key_version,storefront=EXCLUDED.storefront,
       status=EXCLUDED.status,last_validated_at=EXCLUDED.last_validated_at,last_error=EXCLUDED.last_error,updated_at=now()`,
      [input.ciphertext, input.iv, input.authTag, input.keyVersion, input.storefront, input.status ?? "unverified", input.lastValidatedAt ?? null, persistedLastError],
    );
  }

  async setEncryptedAppleAuthorization(input: EncryptedAppleAuthorizationInput): Promise<void> {
    await this.saveAppleAuthorization(input);
  }

  async updateAppleAuthorizationStatus(status: string, lastError: string | null = null): Promise<void> {
    await this.pool.query(
      "UPDATE apple_authorizations SET status=$1::varchar,last_error=$2,last_validated_at=CASE WHEN $1::varchar='valid' THEN now() ELSE last_validated_at END,updated_at=now() WHERE id='owner'",
      [status, sanitizeOptionalFailure(lastError, "apple_authorization")],
    );
  }

  async updateAppleAuthorizationValidation(input: {
    expectedCiphertext: string;
    expectedKeyVersion: string;
    storefront?: string;
    status: "valid" | "reauthorization_required";
    lastError?: string | null;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE apple_authorizations SET storefront=COALESCE($3,storefront),status=$4::varchar,last_error=$5,
       last_validated_at=CASE WHEN $4::varchar='valid' THEN now() ELSE last_validated_at END,updated_at=now()
       WHERE id='owner' AND ciphertext=$1 AND key_version=$2`,
      [
        input.expectedCiphertext,
        input.expectedKeyVersion,
        input.storefront ?? null,
        input.status,
        sanitizeOptionalFailure(input.lastError, "apple_authorization"),
      ],
    );
    return Boolean(result.rowCount);
  }

  async revokeAppleAuthorization(): Promise<void> {
    await this.pool.query("DELETE FROM apple_authorizations WHERE id='owner'");
  }

  async enqueueNotification(kind: string, payload: Record<string, unknown>): Promise<string> {
    const id = randomUUID();
    const supplied = typeof payload.deduplicationKey === "string" ? payload.deduplicationKey : null;
    const dedupeKey = (supplied ?? `${kind}:${sha256Hex(stableStringify(payload))}`).slice(0, 200);
    return this.transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO notification_outbox(id,kind,dedupe_key,payload_json) VALUES($1,$2,$3,$4)
         ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
        [id, kind.slice(0, 80), dedupeKey, payload],
      );
      if (!inserted.rows[0]) {
        const existing = await client.query<{ id: string }>("SELECT id FROM notification_outbox WHERE dedupe_key=$1", [dedupeKey]);
        return existing.rows[0]!.id;
      }
      await client.query(
        `INSERT INTO job_queue(id,kind,dedupe_key,payload_json) VALUES($1,'notification',$2,$3)
         ON CONFLICT(kind,dedupe_key) DO NOTHING`,
        [randomUUID(), `notification:${id}`, { notificationId: id }],
      );
      return id;
    });
  }

  async getNotification(id: string): Promise<any | null> {
    const result = await this.pool.query("SELECT * FROM notification_outbox WHERE id=$1", [id]);
    const row = result.rows[0];
    return row ? { id: row.id, kind: row.kind, payload: row.payload_json, status: row.status, attempts: row.attempts, availableAt: date(row.available_at), sentAt: date(row.sent_at)?.toISOString() ?? null, lastError: sanitizeOptionalFailure(row.last_error, "notification") } : null;
  }

  async markNotificationSent(id: string, providerId: string | null = null): Promise<void> {
    await this.pool.query(
      "UPDATE notification_outbox SET status='sent',sent_at=now(),provider_id=$2,last_error=NULL,updated_at=now() WHERE id=$1",
      [id, providerId?.slice(0, 200) ?? null],
    );
  }

  async markNotificationFailed(id: string, error: string, retryAt: Date | null): Promise<void> {
    await this.pool.query(
      `UPDATE notification_outbox SET status=$2,attempts=attempts+1,available_at=COALESCE($3,available_at),last_error=$4,updated_at=now() WHERE id=$1`,
      [id, retryAt ? "pending" : "failed", retryAt, sanitizeFailure(error, "notification")],
    );
  }

  async recordAudit(actor: string, action: string, detail: Record<string, unknown> = {}, runId: string | null = null): Promise<void> {
    await this.pool.query("INSERT INTO audit_events(run_id,actor,action,detail_json) VALUES($1,$2,$3,$4)", [runId, actor.slice(0, 80), action.slice(0, 120), detail]);
  }

  async listAwaitingBudgets(): Promise<any[]> {
    await this.pool.query(
      `UPDATE research_runs SET status='expired',phase='budget_approval_expired',error='Budget approval expired after seven days',completed_at=now(),updated_at=now()
       WHERE status='awaiting_budget' AND budget_approval_expires_at<=now()`,
    );
    const result = await this.pool.query(
      `SELECT id,brief_json,estimated_cost_usd,actual_cost_usd,reserved_cost_usd,approved_budget_usd,
              budget_approval_expires_at,created_at
       FROM research_runs WHERE status='awaiting_budget' AND budget_approval_expires_at>now() AND deleted_at IS NULL ORDER BY created_at`,
    );
    const monthlyCeiling = readCostConfiguration().monthlyCostLimitUsd;
    return result.rows.map((row) => ({
      id: row.id,
      brief: row.brief_json,
      estimatedCostUsd: Number(row.estimated_cost_usd),
      actualCostUsd: Number(row.actual_cost_usd),
      approvedBudgetUsd: Number(row.approved_budget_usd),
      requestedBudgetUsd: Math.min(
        monthlyCeiling,
        Math.max(
          Number(row.estimated_cost_usd),
          Number(row.approved_budget_usd) * 2,
          Number(row.actual_cost_usd) + Number(row.reserved_cost_usd) + 5,
        ),
      ),
      expiresAt: date(row.budget_approval_expires_at)?.toISOString(),
      createdAt: date(row.created_at)?.toISOString(),
    }));
  }

  async listRecentRuns(limit = 50): Promise<Array<{
    id: string;
    title: string;
    status: string;
    phase: string;
    completedAt: string | null;
    createdAt: string;
  }>> {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 100)) : 50;
    const result = await this.pool.query(
      `SELECT id,brief_json->>'title' title,status,phase,completed_at,created_at
       FROM research_runs WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT $1`,
      [safeLimit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      title: row.title || "Untitled run",
      status: row.status,
      phase: row.phase,
      completedAt: date(row.completed_at)?.toISOString() ?? null,
      createdAt: date(row.created_at)!.toISOString(),
    }));
  }

  async invalidateRunReuse(runId: string, actor: string): Promise<{ briefHash: string; invalidatedAt: string }> {
    return this.transaction(async (client) => {
      const initial = await client.query<{ brief_hash: string }>(
        "SELECT brief_hash FROM research_runs WHERE id=$1 AND deleted_at IS NULL",
        [runId],
      );
      if (!initial.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`brief:${initial.rows[0].brief_hash}`]);
      const run = await client.query<{ brief_hash: string }>(
        "SELECT brief_hash FROM research_runs WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [runId],
      );
      if (!run.rows[0]) throw new HttpError(404, "Research run not found", "run_not_found");
      const timestamp = await client.query<{ invalidated_at: Date }>("SELECT clock_timestamp() invalidated_at");
      const invalidatedAt = timestamp.rows[0]!.invalidated_at.toISOString();
      await client.query(
        `INSERT INTO settings(key,value) VALUES($1,$2)
         ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
        [`reuse_not_before:${run.rows[0].brief_hash}`, invalidatedAt],
      );
      await client.query(
        "INSERT INTO audit_events(run_id,actor,action,detail_json) VALUES($1,$2,$3,$4)",
        [runId, actor.slice(0, 80), "run.cache_invalidated", { invalidatedAt }],
      );
      return { briefHash: run.rows[0].brief_hash, invalidatedAt };
    });
  }

  async importOwnerCatalog(input: {
    runId: string;
    actor: string;
    importHash: string;
    sources: SourceRecordInput[];
    candidates: TrackCandidateInput[];
  }): Promise<{ newlyAdded: number }> {
    return this.transaction(async (client) => {
      const pause = await client.query<{ value: string }>(
        "SELECT value FROM settings WHERE key='research_paused' FOR UPDATE",
      );
      if (pause.rows[0]?.value !== "true") {
        throw new HttpError(409, "Pause research before importing a specialist catalogue", "catalog_import_requires_pause");
      }
      const result = await client.query<{ status: string; phase: string; brief_json: PlaylistBrief; leased: boolean; locked: boolean }>(
        `SELECT r.status,r.phase,r.brief_json,
          EXISTS(SELECT 1 FROM job_queue j WHERE j.run_id=r.id AND j.status='leased') leased,
          EXISTS(SELECT 1 FROM manifests m WHERE m.run_id=r.id) locked
         FROM research_runs r WHERE r.id=$1 AND r.deleted_at IS NULL FOR UPDATE OF r`,
        [input.runId],
      );
      const run = result.rows[0];
      if (!run) throw new HttpError(404, "Research run not found", "run_not_found");
      if (run.locked) throw new HttpError(409, "The immutable manifest is already locked", "manifest_already_locked");
      if (run.leased) throw new HttpError(409, "Wait for the active worker lease to stop before importing", "run_not_quiescent");
      if (!["queued", "awaiting_budget", "researching", "ready_for_matching"].includes(run.status)) {
        throw new HttpError(409, "Catalogue imports are allowed only before matching begins", "catalog_import_too_late");
      }

      const candidates = input.candidates.map((candidate) => ({
        ...candidate,
        evidence: candidate.evidence.map((claim) => {
          if (claim.subjectEntity.trim() || claim.subjectRelationship.trim()) return claim;
          if (run.brief_json.subjectEntities.length !== 1) {
            throw new HttpError(
              400,
              "Multi-subject catalogue imports must name the confirmed subject and relationship",
              "evidence_subject_mismatch",
            );
          }
          return {
            ...claim,
            subjectEntity: run.brief_json.subjectEntities[0]!,
            subjectRelationship: run.brief_json.relationship,
          };
        }),
      }));

      const sourceIds = await this.addSourcesInTransaction(client, input.runId, input.sources);
      const newlyAdded = await this.addCandidatesInTransaction(client, input.runId, candidates, sourceIds, "unverified");
      await this.upsertFrontierInTransaction(client, input.runId, [{
        sourceClass: "import",
        strategy: `owner catalogue ${input.importHash.slice(0, 16)}`,
        cursor: null,
        status: "complete",
        discoveredCount: input.candidates.length,
        recoveredCount: input.candidates.length,
        note: `Owner-imported specialist catalogue (${input.sources.length} sources); claims remain inferred.`,
      }]);
      await client.query(
        "INSERT INTO audit_events(run_id,actor,action,detail_json) VALUES($1,$2,$3,$4)",
        [input.runId, input.actor.slice(0, 80), "run.catalog_imported", {
          importHash: input.importHash,
          sourceCount: input.sources.length,
          candidateCount: input.candidates.length,
          newlyAdded,
          evidenceState: "inferred",
        }],
      );
      return { newlyAdded };
    });
  }

  async approveRunBudget(runId: string, approvedBudgetUsd: number): Promise<void> {
    const amount = finiteMoney(approvedBudgetUsd, "Approved budget");
    const result = await this.pool.query(
      `UPDATE research_runs SET approved_budget_usd=$2,status='queued',phase='queued',error=NULL,budget_approval_expires_at=NULL,updated_at=now()
       WHERE id=$1 AND status='awaiting_budget' AND budget_approval_expires_at>now() AND $2>actual_cost_usd+reserved_cost_usd`,
      [runId, amount],
    );
    if (!result.rowCount) throw new HttpError(409, "Run cannot be approved at that budget", "budget_approval_invalid");
  }

  async cancelRun(runId: string): Promise<void> {
    await this.transaction(async (client) => {
      const updated = await client.query(
        "UPDATE research_runs SET status='failed',phase='owner_cancelled',error='Cancelled by owner',completed_at=now(),updated_at=now() WHERE id=$1 AND status NOT IN ('complete','partial','deleted')",
        [runId],
      );
      if (!updated.rowCount) throw new HttpError(409, "Run cannot be cancelled", "run_not_cancellable");
      await client.query("UPDATE job_queue SET status='cancelled',completed_at=now(),updated_at=now() WHERE run_id=$1 AND status='queued'", [runId]);
    });
  }

  async getSystemHealth(): Promise<any> {
    const [worker, queue, costs, apple, notifications, publications, orphans, retention, researchPaused, publishingPaused, feedbackPaused] = await Promise.all([
      this.pool.query("SELECT worker_id,schema_version,capacity,active_jobs,metadata_json,last_seen_at FROM worker_heartbeats ORDER BY last_seen_at DESC"),
      this.pool.query(
        `SELECT
          count(*) FILTER (WHERE status='queued')::int queued,
          count(*) FILTER (WHERE status='leased' AND lease_expires_at>now())::int leased,
          count(*) FILTER (WHERE status='leased' AND lease_expires_at<=now())::int expired_leases,
          count(*) FILTER (WHERE status='failed')::int failed,
          COALESCE(EXTRACT(EPOCH FROM (now()-min(created_at) FILTER (WHERE status='queued'))),0)::float8 oldest_queued_seconds
         FROM job_queue`,
      ),
      this.pool.query(
        `SELECT
          COALESCE((SELECT sum(amount_usd) FROM cost_ledger WHERE occurred_at >= date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'),0)::float8 month_spend,
          COALESCE((SELECT sum(reserved_usd) FROM cost_reservations WHERE status='reserved' AND expires_at>now()),0)::float8 month_reserved`,
      ),
      this.pool.query("SELECT status,storefront,last_validated_at,last_error,updated_at FROM apple_authorizations WHERE id='owner'"),
      this.pool.query(
        `SELECT
          count(*) FILTER (WHERE status='pending')::int pending,
          count(*) FILTER (WHERE status='failed')::int failed,
          COALESCE(EXTRACT(EPOCH FROM (now()-min(created_at) FILTER (WHERE status='pending'))),0)::float8 oldest_pending_seconds
         FROM notification_outbox`,
      ),
      this.pool.query(
        `SELECT
          (SELECT count(*)::int FROM research_runs WHERE status='failed' AND phase LIKE 'publication%') failed_runs,
          (SELECT count(*)::int FROM publication_volumes WHERE status='failed') failed_volumes`,
      ),
      this.pool.query<{ count: number }>("SELECT count(*)::int count FROM orphan_playlists WHERE cleaned_at IS NULL"),
      this.pool.query(
        `SELECT
          (SELECT count(*)::int FROM research_runs WHERE retention_expires_at<=now()) due_runs,
          (SELECT value FROM settings WHERE key='retention_last_run_at') last_run_at,
          (SELECT value FROM settings WHERE key='retention_last_purged') last_purged`,
      ),
      this.getSetting("research_paused"),
      this.getSetting("publishing_paused"),
      this.getSetting("feedback_paused"),
    ]);
    const queueRow = queue.rows[0] ?? {};
    const notificationRow = notifications.rows[0] ?? {};
    const publicationRow = publications.rows[0] ?? {};
    const retentionRow = retention.rows[0] ?? {};
    const configuredStaleSeconds = Number(process.env.WORKER_STALE_SECONDS ?? 90);
    const staleAfterMs = (Number.isFinite(configuredStaleSeconds) ? Math.max(30, configuredStaleSeconds) : 90) * 1_000;
    const databaseSchemaVersion = await this.getSchemaVersion();
    const evaluatedWorkers = worker.rows.map((row) => {
      const lastSeenAt = date(row.last_seen_at);
      const stale = !lastSeenAt || Date.now() - lastSeenAt.getTime() > staleAfterMs;
      return {
        ...row,
        lastSeenAt: lastSeenAt?.toISOString(),
        stale,
        schemaCompatible: heartbeatSchemaCompatible(row, databaseSchemaVersion),
        protocolVersion: workerPipelineProtocolVersion(row.metadata_json),
        protocolCompatible: isWorkerPipelineProtocolCompatible(row.metadata_json),
        queueClass: heartbeatQueueClass(row.metadata_json),
        executorRevision: heartbeatExecutorRevision(row.metadata_json),
        configurationHash: heartbeatConfigurationHash(row.metadata_json),
      };
    });
    // A newer bridge heartbeat must not hide healthy v5 capacity during a
    // mixed rollout. Prefer a fully compatible fresh worker, then any fresh
    // worker for actionable diagnostics, then the newest stale heartbeat.
    const heartbeat = evaluatedWorkers.find((row) => (
      !row.stale && row.schemaCompatible && row.protocolCompatible
    )) ?? evaluatedWorkers.find((row) => !row.stale) ?? evaluatedWorkers[0];
    const compatibleCapacity = evaluatedWorkers
      .filter((row) => !row.stale && row.schemaCompatible && row.protocolCompatible)
      .reduce((sum, row) => sum + Number(row.capacity ?? 0), 0);
    const laneHealth = (lane: Exclude<WorkerQueueClass, "all">) => {
      const workers = evaluatedWorkers.filter((row) => row.queueClass === lane || row.queueClass === "all");
      const eligibleWorkers = workers.filter((row) => (
        !row.stale && row.schemaCompatible && row.protocolCompatible
      ));
      const representative = workers.find((row) => (
        !row.stale && row.schemaCompatible && row.protocolCompatible
      )) ?? workers.find((row) => !row.stale) ?? workers[0];
      const laneCompatibleCapacity = eligibleWorkers
        .reduce((sum, row) => sum + Number(row.capacity ?? 0), 0);
      const eligibleRevisions = [...new Set(eligibleWorkers
        .map((row) => row.executorRevision)
        .filter((value): value is string => Boolean(value)))]
        .sort();
      const eligibleConfigurationHashes = [...new Set(eligibleWorkers
        .map((row) => row.configurationHash)
        .filter((value): value is string => Boolean(value)))]
        .sort();
      return representative ? {
        ...representative,
        compatibleCapacity: laneCompatibleCapacity,
        eligibleWorkerCount: eligibleWorkers.length,
        eligibleRevisions,
        eligibleConfigurationHashes,
        ready: laneCompatibleCapacity > 0,
      } : {
        stale: true,
        schemaCompatible: false,
        protocolVersion: null,
        protocolCompatible: false,
        queueClass: lane,
        compatibleCapacity: 0,
        eligibleWorkerCount: 0,
        eligibleRevisions: [],
        eligibleConfigurationHashes: [],
        ready: false,
      };
    };
    const workerLanes = {
      interactive: laneHealth("interactive"),
      deep: laneHealth("deep"),
    };
    return {
      database: {
        ok: true,
        schemaVersion: databaseSchemaVersion,
        schemaCompatible: isDatabaseSchemaVersionCompatible(databaseSchemaVersion),
      },
      worker: heartbeat ? {
        ...heartbeat,
        compatibleCapacity,
      } : {
        stale: true,
        schemaCompatible: false,
        protocolVersion: null,
        protocolCompatible: false,
        compatibleCapacity: 0,
      },
      workerLanes,
      queue: {
        queued: Number(queueRow.queued ?? 0),
        leased: Number(queueRow.leased ?? 0),
        expiredLeases: Number(queueRow.expired_leases ?? 0),
        failed: Number(queueRow.failed ?? 0),
        oldestQueuedSeconds: Number(queueRow.oldest_queued_seconds ?? 0),
      },
      monthSpendUsd: Number(costs.rows[0]?.month_spend ?? 0),
      monthReservedUsd: Number(costs.rows[0]?.month_reserved ?? 0),
      monthCeilingUsd: readCostConfiguration().monthlyCostLimitUsd,
      apple: apple.rows[0] ? { status: apple.rows[0].status, storefront: apple.rows[0].storefront, lastValidatedAt: date(apple.rows[0].last_validated_at)?.toISOString() ?? null, lastError: sanitizeOptionalFailure(apple.rows[0].last_error, "apple_authorization") } : { status: "missing" },
      notificationBacklog: Number(notificationRow.pending ?? 0),
      notificationFailures: Number(notificationRow.failed ?? 0),
      oldestNotificationSeconds: Number(notificationRow.oldest_pending_seconds ?? 0),
      publicationFailures: {
        runs: Number(publicationRow.failed_runs ?? 0),
        volumes: Number(publicationRow.failed_volumes ?? 0),
      },
      orphanedPlaylists: orphans.rows[0]?.count ?? 0,
      retention: {
        dueRuns: Number(retentionRow.due_runs ?? 0),
        lastRunAt: typeof retentionRow.last_run_at === "string" ? retentionRow.last_run_at : null,
        lastPurged: Number(retentionRow.last_purged ?? 0),
      },
      paused: {
        research: researchPaused === "true",
        publishing: publishingPaused === "true",
        feedback: feedbackPaused === "true",
      },
    };
  }

  /**
   * Secret-free proof that a run was executed by the promoted worker artifact
   * and that Apple returned the exact ordered manifest. Job, run, capability,
   * and Apple playlist identifiers are intentionally omitted.
   */
  async getPublicRunExecutionProof(
    runId: string,
    manifestId?: string | null,
  ): Promise<{
    contractRevision: number;
    contractHash: string;
    attempts: Array<{
      stage: string;
      status: string;
      executorRevision: string;
      executorIdentityHash: string;
      configurationHash: string;
      startedAt: string;
      completedAt: string | null;
    }>;
    publicationReconciliation: {
      state: string;
      expectedCount: number;
      appendedCount: number;
      batchCursor: number;
      expectedOrderedIdsHash: string;
      observedOrderedIdsHash: string | null;
      orderedIdsVerified: boolean;
      completedAt: string | null;
    } | null;
  } | null> {
    if (Number(await this.getSchemaVersion() ?? 0) < 18) return null;
    const contract = await this.pool.query<{
      id: string;
      revision: number;
      contract_hash: string;
    }>(
      `SELECT contract.id,contract.revision,contract.contract_hash
       FROM research_runs run
       JOIN playlist_contract_revisions contract
         ON contract.id=run.active_playlist_contract_revision_id
       WHERE run.id=$1 AND run.deleted_at IS NULL`,
      [runId],
    );
    const active = contract.rows[0];
    if (!active) return null;
    const [attempts, reconciliation] = await Promise.all([
      this.pool.query<{
        stage: string;
        status: string;
        executor_revision: string;
        executor_identity_hash: string;
        configuration_hash: string;
        started_at: Date;
        completed_at: Date | null;
      }>(
        `SELECT stage,status,executor_revision,executor_identity_hash,
                configuration_hash,started_at,completed_at
         FROM playlist_execution_attempts
         WHERE run_id=$1 AND contract_revision_id=$2
         ORDER BY started_at,id`,
        [runId, active.id],
      ),
      manifestId
        ? this.pool.query<{
            state: string;
            expected_count: number;
            appended_count: number;
            batch_cursor: number;
            expected_ordered_ids_hash: string;
            observed_ordered_ids_hash: string | null;
            completed_at: Date | null;
          }>(
            `SELECT state,expected_count,appended_count,batch_cursor,
                    expected_ordered_ids_hash,observed_ordered_ids_hash,completed_at
             FROM playlist_publication_reconciliations
             WHERE run_id=$1 AND contract_revision_id=$2 AND manifest_id=$3
             ORDER BY created_at DESC,id DESC LIMIT 1`,
            [runId, active.id, manifestId],
          )
        : Promise.resolve({ rows: [] }),
    ]);
    const publication = reconciliation.rows[0] ?? null;
    const expectedCount = Number(publication?.expected_count ?? 0);
    const appendedCount = Number(publication?.appended_count ?? 0);
    const batchCursor = Number(publication?.batch_cursor ?? 0);
    const safeHash = (value: unknown): string | null => (
      typeof value === "string" && /^[0-9a-f]{64}$/u.test(value)
        ? value
        : null
    );
    const safeRevision = (value: unknown): string => (
      typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)
        ? value
        : "unverified"
    );
    const expectedHash = safeHash(publication?.expected_ordered_ids_hash)
      ?? "unverified";
    const observedHash = safeHash(publication?.observed_ordered_ids_hash);
    const contractHash = safeHash(active.contract_hash) ?? "unverified";
    return {
      contractRevision: Number(active.revision),
      contractHash,
      attempts: attempts.rows.map((attempt) => ({
        stage: /^[0-9A-Za-z._:-]{1,80}$/u.test(attempt.stage)
          ? attempt.stage
          : "unknown",
        status: new Set([
          "queued",
          "running",
          "blocked",
          "complete",
          "cancelled",
          "discarded",
          "failed",
        ]).has(attempt.status) ? attempt.status : "unknown",
        executorRevision: safeRevision(attempt.executor_revision),
        executorIdentityHash: safeHash(attempt.executor_identity_hash)
          ?? "unverified",
        configurationHash: safeHash(attempt.configuration_hash) ?? "unverified",
        startedAt: attempt.started_at.toISOString(),
        completedAt: attempt.completed_at?.toISOString() ?? null,
      })),
      publicationReconciliation: publication ? {
        state: publication.state,
        expectedCount,
        appendedCount,
        batchCursor,
        expectedOrderedIdsHash: expectedHash,
        observedOrderedIdsHash: observedHash,
        orderedIdsVerified: publication.state === "complete"
          && expectedCount > 0
          && appendedCount === expectedCount
          && batchCursor === expectedCount
          && expectedHash !== "unverified"
          && observedHash === expectedHash,
        completedAt: publication.completed_at?.toISOString() ?? null,
      } : null,
    };
  }

  async getPublicResult(runId: string): Promise<any> {
    const [manifest, run, outcomeCounts, explore] = await Promise.all([
      this.getLatestManifestForRun(runId),
      this.getRun(runId),
      this.getOutcomeCounts(runId),
      this.getRunExplorePreference(runId),
    ]);
    if (!manifest) return {
      status: run.status,
      manifest: null,
      volumes: [],
      outcomeCounts,
      completedTracks: 0,
      totalTracks: 0,
      explore,
      executionProof: await this.getPublicRunExecutionProof(runId),
    };
    const [rawVolumes, executionProof] = await Promise.all([
      this.listPublicationVolumes(manifest.id, manifest.revisionId ?? null),
      this.getPublicRunExecutionProof(runId, manifest.id),
    ]);
    const volumes = rawVolumes.map((volume) => ({
      ...volume,
      index: volume.volumeNumber,
      total: volume.volumeCount,
      playlistId: volume.applePlaylistId,
      shareUrl: volume.appleShareUrl,
      trackCount: Math.max(0, volume.endPosition - volume.startPosition + 1),
    }));
    return {
      status: run.status,
      manifest: { id: manifest.id, name: manifest.name, contentHash: manifest.contentHash, trackCount: manifest.tracks.length },
      volumes,
      outcomeCounts,
      completedTracks: volumes.reduce((sum, volume) => sum + volume.appendedCount, 0),
      totalTracks: manifest.tracks.length,
      error: run.error,
      explore,
      executionProof,
    };
  }

  async getOutcomeCounts(runId: string): Promise<Record<string, number>> {
    const result = await this.pool.query<{ outcome: string; count: number }>("SELECT outcome,count(*)::int count FROM track_candidates WHERE run_id=$1 GROUP BY outcome", [runId]);
    return Object.fromEntries(result.rows.map((row) => [row.outcome, row.count]));
  }

  /**
   * Product-resolution metrics with explicit, non-overloaded denominators.
   * Authenticated release canaries are excluded at the source and no prompt,
   * answer text, capability, access, or run identifier is returned as a label.
   */
  async getPlaylistResolutionMetrics(input: {
    windowStartedAt: Date;
    windowEndedAt: Date;
  }): Promise<Record<string, unknown>> {
    if (!Number.isFinite(input.windowStartedAt.getTime())
      || !Number.isFinite(input.windowEndedAt.getTime())
      || input.windowStartedAt >= input.windowEndedAt) {
      throw new HttpError(400, "Playlist metrics window is invalid", "invalid_metrics_window");
    }
    if (Number(await this.getSchemaVersion() ?? 0) < 18) {
      return {
        schemaAvailable: false,
        windowStartedAt: input.windowStartedAt.toISOString(),
        windowEndedAt: input.windowEndedAt.toISOString(),
      };
    }
    const result = await this.pool.query<{
      accepted_valid_submissions: number;
      guidance_offered: number;
      guidance_answered: number;
      guidance_skipped: number;
      guidance_abandoned: number;
      research_started_exact_confirmed: number;
      user_authorized_scope_or_count_changes: number;
      original_request_exact_success: number;
      guided_exact_resolution: number;
      approved_partial_publication: number;
      actionable_decision: number;
      dependency_paused: number;
      technical_quarantine: number;
      user_cancellation: number;
    }>(
      `WITH accepted_briefs AS (
         SELECT brief.id,brief.status,brief.expires_at
         FROM brief_requests brief
         WHERE brief.created_at >= $1 AND brief.created_at < $2
           AND NOT EXISTS (
             SELECT 1 FROM release_canary_markers marker
             WHERE marker.brief_request_id=brief.id
           )
       ), eligible_runs AS (
         SELECT run.id,run.status,run.phase,run.completed_at,
                run.active_playlist_contract_revision_id,
                spec.requested_track_count,
                contract.revision contract_revision,
                COALESCE(contract.brief_request_id,access.brief_request_id)
                  contract_brief_request_id,
                COALESCE(outcome.exact_count_satisfied,false) exact_count_satisfied
         FROM research_runs run
         JOIN run_specs spec ON spec.run_id=run.id
         LEFT JOIN playlist_contract_revisions contract
           ON contract.id=run.active_playlist_contract_revision_id
         LEFT JOIN LATERAL (
           SELECT candidate.brief_request_id
           FROM run_accesses candidate
           WHERE candidate.run_id=run.id
             AND candidate.brief_request_id IS NOT NULL
           ORDER BY candidate.created_at,candidate.id
           LIMIT 1
         ) access ON true
         LEFT JOIN pipeline_outcomes outcome ON outcome.run_id=run.id
         WHERE run.created_at >= $1 AND run.created_at < $2
           AND spec.requested_track_count IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM release_canary_markers marker
             WHERE marker.run_id=run.id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM run_accesses candidate
             JOIN release_canary_markers marker
               ON marker.brief_request_id=candidate.brief_request_id
             WHERE candidate.run_id=run.id
           )
       ), offered_raw AS (
         SELECT 'brief:' || questions.brief_request_id owner_key,
                brief.expires_at abandoned_at
         FROM guidance_question_sets questions
         JOIN accepted_briefs brief ON brief.id=questions.brief_request_id
         UNION ALL
         SELECT 'run:' || questions.run_id owner_key,
                CASE
                  WHEN run.completed_at IS NOT NULL THEN run.completed_at
                  WHEN run.status IN ('cancelled','deleted','expired')
                    THEN COALESCE(run.completed_at,$2)
                  ELSE NULL
                END abandoned_at
         FROM guidance_question_sets questions
         JOIN eligible_runs run ON run.id=questions.run_id
       ), offered AS (
         SELECT owner_key,max(abandoned_at) abandoned_at
         FROM offered_raw
         GROUP BY owner_key
       ), answered AS (
         SELECT
           CASE
             WHEN answers.brief_request_id IS NOT NULL
               THEN 'brief:' || answers.brief_request_id
             ELSE 'run:' || answers.run_id
           END owner_key,
           answers.normalized_answers_json,
           answers.execution_delta_json
         FROM guidance_answer_sets answers
         JOIN offered ON offered.owner_key=CASE
           WHEN answers.brief_request_id IS NOT NULL
             THEN 'brief:' || answers.brief_request_id
           ELSE 'run:' || answers.run_id
         END
         WHERE answers.invalidated_at IS NULL
       ), run_guidance AS (
         SELECT run.id,
                EXISTS (
                  SELECT 1 FROM guidance_answer_sets answers
                  WHERE (
                      answers.brief_request_id=run.contract_brief_request_id
                      OR answers.run_id=run.id
                    )
                    AND answers.invalidated_at IS NULL
                    AND answers.base_contract_revision_id IS NOT NULL
                    AND answers.resulting_contract_revision_id IS NOT NULL
                    AND answers.resulting_contract_revision_id
                      <> answers.base_contract_revision_id
                ) guided,
                EXISTS (
                  SELECT 1 FROM guidance_answer_sets answers
                  WHERE (
                      answers.brief_request_id=run.contract_brief_request_id
                      OR answers.run_id=run.id
                    )
                    AND answers.invalidated_at IS NULL
                    AND jsonb_path_exists(
                      answers.execution_delta_json,
                      '$[*] ? (
                        @.op == "add_clause"
                        || @.op == "replace_clause"
                        || @.op == "remove_clause"
                        || @.op == "replace_track_predicate"
                        || @.op == "set_requested_track_count"
                        || @.op == "set_playlist_constraints"
                      )'
                    )
                ) scope_or_count_changed
         FROM eligible_runs run
       )
       SELECT
         (SELECT count(*)::int FROM accepted_briefs) accepted_valid_submissions,
         (SELECT count(*)::int FROM offered) guidance_offered,
         (SELECT count(DISTINCT owner_key)::int FROM answered) guidance_answered,
         (SELECT count(DISTINCT owner_key)::int FROM answered
          WHERE jsonb_path_exists(
            normalized_answers_json,
            '$[*] ? (@.skipped == true)'
          )) guidance_skipped,
         (SELECT count(*)::int
          FROM offered
          WHERE offered.abandoned_at <= LEAST($2,now())
            AND NOT EXISTS (
              SELECT 1 FROM answered
              WHERE answered.owner_key=offered.owner_key
            )) guidance_abandoned,
         (SELECT count(*)::int FROM eligible_runs) research_started_exact_confirmed,
         (SELECT count(*)::int FROM run_guidance
          WHERE scope_or_count_changed) user_authorized_scope_or_count_changes,
         (SELECT count(*)::int
          FROM eligible_runs run JOIN run_guidance guidance ON guidance.id=run.id
          WHERE run.status='complete' AND run.exact_count_satisfied
            AND NOT guidance.guided) original_request_exact_success,
         (SELECT count(*)::int
          FROM eligible_runs run JOIN run_guidance guidance ON guidance.id=run.id
          WHERE run.status='complete' AND run.exact_count_satisfied
            AND guidance.guided) guided_exact_resolution,
         (SELECT count(*)::int FROM eligible_runs run
          WHERE run.status='partial'
            AND EXISTS (
              SELECT 1 FROM partial_publication_decisions decision
              WHERE decision.run_id=run.id AND decision.decision='publish_partial'
            )) approved_partial_publication,
         (SELECT count(*)::int FROM eligible_runs
          WHERE status='needs_decision'
             OR status IN ('partial_ready','no_compatible_tracks')) actionable_decision,
         (SELECT count(*)::int FROM eligible_runs run
          WHERE EXISTS (
            SELECT 1 FROM playlist_run_blockers blocker
            WHERE blocker.run_id=run.id AND blocker.resolved_at IS NULL
              AND blocker.blocker_kind IN ('provider','apple_authorization')
          )) dependency_paused,
         (SELECT count(*)::int FROM eligible_runs run
          WHERE run.status='failed_integrity'
             OR EXISTS (
               SELECT 1 FROM playlist_run_blockers blocker
               WHERE blocker.run_id=run.id AND blocker.resolved_at IS NULL
                 AND blocker.blocker_kind IN ('integrity','publication_reconciliation')
             )) technical_quarantine,
         (SELECT count(*)::int FROM eligible_runs
          WHERE status IN ('cancelled','deleted','expired')
             OR phase IN ('visitor_cancelled','owner_cancelled')) user_cancellation`,
      [input.windowStartedAt, input.windowEndedAt],
    );
    const row = result.rows[0]!;
    return {
      schemaAvailable: true,
      syntheticTrafficExcluded: true,
      windowStartedAt: input.windowStartedAt.toISOString(),
      windowEndedAt: input.windowEndedAt.toISOString(),
      denominators: {
        acceptedValidSubmissions: Number(row.accepted_valid_submissions),
        guidance: {
          offered: Number(row.guidance_offered),
          answered: Number(row.guidance_answered),
          skipped: Number(row.guidance_skipped),
          abandoned: Number(row.guidance_abandoned),
        },
        researchStartedExactConfirmed: Number(row.research_started_exact_confirmed),
        userAuthorizedScopeOrCountChanges: Number(row.user_authorized_scope_or_count_changes),
      },
      outcomes: {
        originalRequestExactSuccess: Number(row.original_request_exact_success),
        guidedExactResolution: Number(row.guided_exact_resolution),
        approvedPartialPublication: Number(row.approved_partial_publication),
        actionableDecision: Number(row.actionable_decision),
        dependencyPaused: Number(row.dependency_paused),
        technicalQuarantine: Number(row.technical_quarantine),
        userCancellation: Number(row.user_cancellation),
      },
    };
  }

  async getEvidenceReport(runId: string, page = 1, pageSize = 50): Promise<any> {
    const safePage = Math.max(1, Math.floor(page));
    const size = Math.max(1, Math.min(Math.floor(pageSize), 100));
    const totalResult = await this.pool.query<{ count: number }>("SELECT count(*)::int count FROM track_candidates WHERE run_id=$1", [runId]);
    const candidates = await this.pool.query(
      `SELECT c.id,c.artist,c.title,c.album,c.outcome,
       COALESCE(json_agg(json_build_object('state',CASE
           WHEN e.state IN ('verified','corroborated','disputed') AND (
             e.support_scope<>'track' OR e.verification_phase<>'track_verification'
             OR s.source_class<>'web' OR ca.id IS NULL
           ) THEN 'inferred'
           WHEN e.state='editorial' AND (s.source_class<>'web' OR ca.id IS NULL) THEN 'inferred'
           ELSE e.state END,'supportScope',e.support_scope,
         'verificationPhase',e.verification_phase,'relationship',e.relationship,'note',e.note,
         'subjectEntity',e.subject_entity,'subjectRelationship',e.subject_relationship,
         'citationSupport',CASE WHEN ca.id IS NULL THEN NULL ELSE json_build_object(
           'responseId',ca.response_id,'outputItemId',ca.output_item_id,'contentIndex',ca.content_index,
           'startIndex',ca.start_index,'endIndex',ca.end_index,'excerpt',ca.excerpt) END,
         'source',json_build_object('url',s.url,'title',s.title,'class',s.source_class,'provenanceRoot',s.provenance_root))
         ORDER BY e.state,s.url) FILTER (WHERE e.id IS NOT NULL),'[]'::json) evidence
       FROM track_candidates c LEFT JOIN evidence_claims e ON e.candidate_id=c.id
       LEFT JOIN source_records s ON s.id=e.source_id
       LEFT JOIN citation_attestations ca ON ca.id=e.citation_attestation_id
         AND ca.run_id=e.run_id AND ca.source_url=s.url
       WHERE c.run_id=$1
       GROUP BY c.id ORDER BY c.artist,c.title,c.id LIMIT $2 OFFSET $3`,
      [runId, size, (safePage - 1) * size],
    );
    const total = totalResult.rows[0]!.count;
    return {
      coverage: await this.getCoverage(runId),
      outcomes: await this.getOutcomeCounts(runId),
      page: safePage,
      pageSize: size,
      total,
      totalPages: Math.ceil(total / size),
      candidates: candidates.rows,
    };
  }

  async getQualityDiagnosticsSummary(days = 30): Promise<Record<string, unknown>> {
    if (Number(await this.getSchemaVersion() ?? 0) < 16) {
      return { schemaAvailable: false, days: 0, incidents: [], daily: [], providers: [], stages: [] };
    }
    const boundedDays = Math.max(1, Math.min(90, Math.floor(days)));
    const [incidents, daily, providers, stages] = await Promise.all([
      this.pool.query(
        `SELECT incident_signature,incident_class,stop_reason,root_cause,downstream_state,
                first_seen_at,last_seen_at,total_count,overflow_count,qa_promoted,qa_promoted_at
         FROM quality_incident_groups
         WHERE last_seen_at>=now()-($1::text||' days')::interval
         ORDER BY total_count DESC,last_seen_at DESC LIMIT 100`,
        [String(boundedDays)],
      ),
      this.pool.query(
        `SELECT incident_date,detailed_count,overflow_count
         FROM quality_incident_daily_counters
         WHERE incident_date>=(now() AT TIME ZONE 'America/Sao_Paulo')::date-$1::int
         ORDER BY incident_date`,
        [boundedDays],
      ),
      this.pool.query(
        `SELECT metric_date,provider,operation,metric_name,metric_value,event_count
         FROM provider_metric_daily_aggregates
         WHERE metric_date>=(now() AT TIME ZONE 'America/Sao_Paulo')::date-$1::int
         ORDER BY metric_date,provider,operation,metric_name`,
        [boundedDays],
      ),
      this.pool.query(
        `SELECT run_id,query_plan_revision_id,stage_key,provider_rows,unique_valid_leads,
                citation_bearing_leads,exact_pair_attestations,containers_discovered,
                containers_enumerated,scope_bound_candidates,evidence_qualified_candidates,
                apple_resolution_attempts,apple_provider_requests,apple_matches,recording_families,
                selected_count,reserve_count,manifested_count,published_count,stop_reason,
                root_cause,downstream_state,created_at
         FROM run_stage_metric_summaries
         WHERE created_at>=now()-($1::text||' days')::interval
         ORDER BY created_at DESC LIMIT 200`,
        [String(boundedDays)],
      ),
    ]);
    return {
      schemaAvailable: true,
      days: boundedDays,
      incidents: incidents.rows,
      daily: daily.rows,
      providers: providers.rows,
      stages: stages.rows,
    };
  }

  async runRetentionSweep(limit = 50): Promise<number> {
    const detailCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000);
    if (Number(await this.getSchemaVersion() ?? 0) >= 16) {
      await this.pool.query("DELETE FROM provider_metric_events WHERE expires_at<=now()");
      await this.pool.query("DELETE FROM quality_incident_occurrences WHERE expires_at<=now()");
      await this.pool.query("DELETE FROM quality_incident_event_keys WHERE expires_at<=now()");
      await this.pool.query("DELETE FROM provider_metric_daily_aggregates WHERE expires_at<=now()");
      await this.pool.query("DELETE FROM quality_incident_groups WHERE expires_at<=now()");
      await this.pool.query(
        "DELETE FROM quality_incident_daily_counters WHERE incident_date<(now() AT TIME ZONE 'America/Sao_Paulo')::date-interval '13 months'",
      );
    }
    await this.pool.query(
      `UPDATE research_runs SET status='expired',phase='budget_approval_expired',error='Budget approval expired after seven days',completed_at=now(),updated_at=now()
       WHERE status='awaiting_budget' AND budget_approval_expires_at<=now()`,
    );
    // Capability expiry is also a prompt-retention boundary. Scrub expired
    // accesses even when their canonical run remains reusable or a broader
    // run-retention batch is delayed; deleteRunAccess also removes the exact
    // automatic diagnostic tied to that visitor access.
    const expiredAccesses = await this.pool.query<{ id: string }>(
      `SELECT id FROM run_accesses
       WHERE deleted_at IS NULL AND expires_at<=now()
       ORDER BY expires_at,id
       LIMIT $1`,
      [Math.max(1, Math.min(limit, 500))],
    );
    for (const access of expiredAccesses.rows) await this.deleteRunAccess(access.id);
    const expired = await this.pool.query<{ id: string }>(
      "SELECT id FROM research_runs WHERE retention_expires_at<=now() ORDER BY retention_expires_at FOR UPDATE SKIP LOCKED LIMIT $1",
      [Math.max(1, Math.min(limit, 500))],
    );
    for (const row of expired.rows) await this.purgeRunToTombstone(row.id);
    // Defensive cleanup for reports left orphaned by older retention sweeps.
    // The source lock in purgeRunToTombstone prevents new run orphans, but a
    // sweep must also repair data written before that serialization existed.
    await this.pool.query(
      `DELETE FROM settings report
       WHERE report.key LIKE 'feedback-submission:%'
         AND report.value::jsonb->>'origin'='automatic_failure'
         AND report.value::jsonb #>> '{automaticFailure,runId}' IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM research_runs run
           WHERE run.id::text=report.value::jsonb #>> '{automaticFailure,runId}'
         )`,
    );
    // A brief's 24-hour expiry controls visitor access and idempotent reuse,
    // not operational retention. Keep every attempt—including abandoned and
    // budget-gated ones—for the same 90-day QA window as detailed run data.
    await this.pool.query(
      "DELETE FROM cost_ledger WHERE brief_request_id IN (SELECT id FROM brief_requests WHERE created_at<=$1)",
      [detailCutoff],
    );
    await this.pool.query(
      `DELETE FROM settings
       WHERE key LIKE 'feedback-submission:%'
         AND value::jsonb->>'origin'='automatic_failure'
         AND value::jsonb #>> '{automaticFailure,briefRequestId}' IN (
           SELECT id::text FROM brief_requests WHERE created_at<=$1
         )`,
      [detailCutoff],
    );
    await this.pool.query("DELETE FROM brief_requests WHERE created_at<=$1", [detailCutoff]);
    // A capture that had already locked an expiring brief may commit between
    // the pre-delete cleanup and the brief deletion. Remove any such orphan in
    // a second pass so deletion/retention can never be followed by prompt
    // resurrection in the private diagnostics store.
    await this.pool.query(
      `DELETE FROM settings report
       WHERE report.key LIKE 'feedback-submission:%'
         AND report.value::jsonb->>'origin'='automatic_failure'
         AND report.value::jsonb #>> '{automaticFailure,briefRequestId}' IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM brief_requests brief
           WHERE brief.id::text=report.value::jsonb #>> '{automaticFailure,briefRequestId}'
         )`,
    );
    await this.pool.query(
      `DELETE FROM job_queue j USING notification_outbox n
       WHERE j.kind='notification' AND j.payload_json->>'notificationId'=n.id::text AND n.created_at<=$1`,
      [detailCutoff],
    );
    await this.pool.query("DELETE FROM notification_outbox WHERE created_at<=$1", [detailCutoff]);
    await this.pool.query("DELETE FROM cost_ledger WHERE occurred_at<=$1", [detailCutoff]);
    await this.pool.query("DELETE FROM audit_events WHERE occurred_at<=$1", [detailCutoff]);
    await this.pool.query("DELETE FROM rate_limit_events WHERE occurred_at<now()-interval '48 hours'");
    await this.pool.query("DELETE FROM gateway_nonces WHERE expires_at<=now()");
    // Manual feedback remains available until it is resolved. Automatic
    // failure diagnostics always follow the 90-day detailed-data window from
    // their immutable creation time. Owner triage updates `updated_at`, but it
    // must never extend retention of a copied visitor prompt.
    await this.pool.query(
      `DELETE FROM settings
       WHERE key LIKE 'feedback-submission:%'
         AND (
           (value::jsonb->>'origin'='automatic_failure' AND created_at<=$1)
           OR (
             value::jsonb->>'origin' IS DISTINCT FROM 'automatic_failure'
             AND value::jsonb->>'status'='resolved'
             AND updated_at<=$1
           )
         )`,
      [detailCutoff],
    );
    await this.pool.query(
      `DELETE FROM settings mapping
       WHERE NOT EXISTS (
           SELECT 1 FROM settings report
           WHERE report.key='feedback-submission:' || (mapping.value::jsonb->>'id')
         )
         AND (
           mapping.key LIKE 'feedback-idempotency:%'
           OR (
             mapping.key LIKE 'feedback-automatic-event:%'
             AND (
               mapping.value::jsonb->>'suppressed' IS DISTINCT FROM 'true'
               OR NOT (
                 (mapping.value::jsonb->>'runId' IS NOT NULL AND EXISTS (
                   SELECT 1 FROM research_runs run
                   WHERE run.id::text=mapping.value::jsonb->>'runId'
                 ))
                 OR (mapping.value::jsonb->>'briefRequestId' IS NOT NULL AND EXISTS (
                   SELECT 1 FROM brief_requests brief
                   WHERE brief.id::text=mapping.value::jsonb->>'briefRequestId'
                 ))
               )
             )
           )
         )`,
    );
    await this.pool.query(
      `DELETE FROM settings touch
       WHERE touch.key LIKE $1||'%'
         AND (
           (touch.key LIKE $1||'run:%' AND NOT EXISTS (
             SELECT 1 FROM research_runs run
             WHERE run.id::text=substring(touch.key FROM char_length($1||'run:')+1)
           ))
           OR (touch.key LIKE $1||'brief:%' AND NOT EXISTS (
             SELECT 1 FROM brief_requests brief
             WHERE brief.id::text=substring(touch.key FROM char_length($1||'brief:')+1)
           ))
         )`,
      [FEEDBACK_AUTOMATIC_RECONCILIATION_TOUCH_PREFIX],
    );
    await this.pool.query(
      `INSERT INTO settings(key,value) VALUES
         ('retention_last_run_at',$1),('retention_last_purged',$2)
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
      [new Date().toISOString(), String(expired.rows.length)],
    );
    return expired.rows.length;
  }

  private async purgeRunToTombstone(runId: string): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`${FEEDBACK_AUTOMATIC_SOURCE_LOCK_PREFIX}run:${runId}`],
      );
      const run = await client.query("SELECT actual_cost_usd FROM research_runs WHERE id=$1 FOR UPDATE", [runId]);
      if (!run.rows[0]) return;
      const manifest = await client.query("SELECT id,content_hash,name FROM manifests WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1", [runId]);
      const volumes = manifest.rows[0]
        ? await client.query(
          `SELECT pv.apple_share_url FROM publication_volumes pv
           WHERE pv.manifest_id=$1 AND pv.status='complete' AND pv.apple_share_url IS NOT NULL
             AND pv.manifest_revision_id IS NOT DISTINCT FROM (
               SELECT mr.id FROM manifest_revisions mr
               WHERE mr.manifest_id=$1 AND mr.status IN ('locked','published')
               ORDER BY mr.revision DESC LIMIT 1
             )
           ORDER BY pv.volume_number`,
          [manifest.rows[0].id],
        )
        : { rows: [] };
      const counts = await client.query("SELECT outcome,count(*)::int count FROM track_candidates WHERE run_id=$1 GROUP BY outcome", [runId]);
      const appleLinks = volumes.rows.map((volume) => volume.apple_share_url);
      const outcomeCounts = Object.fromEntries(counts.rows.map((entry) => [entry.outcome, entry.count]));
      await client.query(
        `INSERT INTO retention_tombstones(run_id,manifest_hash,playlist_title,apple_links_json,outcome_counts_json,aggregate_cost_usd)
         VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6) ON CONFLICT(run_id) DO NOTHING`,
        [runId, manifest.rows[0]?.content_hash ?? null, manifest.rows[0]?.name ?? null, JSON.stringify(appleLinks), JSON.stringify(outcomeCounts), Number(run.rows[0].actual_cost_usd)],
      );
      const notificationIds = await client.query<{ id: string }>(
        `SELECT id FROM notification_outbox
         WHERE payload_json->>'runId'=$1
            OR ($2::text IS NOT NULL AND payload_json->>'manifestId'=$2::text)`,
        [runId, manifest.rows[0]?.id ?? null],
      );
      if (notificationIds.rows.length > 0) {
        const ids = notificationIds.rows.map((item) => item.id);
        await client.query(
          "DELETE FROM job_queue WHERE kind='notification' AND payload_json->>'notificationId'=ANY($1::text[])",
          [ids],
        );
        await client.query("DELETE FROM notification_outbox WHERE id=ANY($1::uuid[])", [ids]);
      }
      await client.query("DELETE FROM cost_ledger WHERE run_id=$1", [runId]);
      await client.query("DELETE FROM audit_events WHERE run_id=$1", [runId]);
      await client.query("DELETE FROM research_runs WHERE id=$1", [runId]);
      // Delete the source first. Its access cascade is then a barrier against
      // any capture that reached source validation before this transaction.
      await this.deleteAutomaticFailureFeedbackForSource(client, { runId });
    });
  }
}
