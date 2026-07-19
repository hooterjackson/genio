import { randomUUID } from "node:crypto";
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
  PlaylistGuidanceSourceHint,
  PlaylistGuidanceTelemetry,
  PlaylistManifest,
  PublicResearchRunView,
  PublicPlaylistDirectoryItem,
  PublicPlaylistDirectoryPage,
  RecordingFamily,
  RunProgressRecentSource,
  RunProgressView,
  ResearchRunView,
  SelectionConstraint,
  SelectionPlan,
  SourceFrontierItem,
  SourceRecordInput,
  TrackScopeBinding,
  TrackCandidateInput,
} from "../shared/types.ts";
import { publicResearchRunView } from "./public-api-projections.ts";
import {
  selectBroadCuratedCandidates,
  shouldScoreBroadCuratedSelection,
  type BroadCuratedCandidate,
} from "../shared/selection-score-v2.ts";
import {
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
import { normalizeMusicText } from "../lib/matching.ts";
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
  isWorkerCapabilityValid,
  isWorkerPipelineProtocolCompatible,
  WORKER_PIPELINE_CAPABILITY,
  type WorkerPipelineCapability,
  workerPipelineProtocolVersion,
} from "./worker-protocol.ts";
import {
  feedbackListItem,
  feedbackPayloadHash,
  type FeedbackKind,
  type FeedbackListItem,
  type FeedbackStatus,
  type FeedbackSubmissionInput,
  type FeedbackSubmissionRecord,
} from "./feedback.ts";
import {
  deriveGuidancePreferences,
  guidanceOrderingPolicy,
  safeCustomGuidanceText,
  type PlaylistGuidancePreference,
} from "./guidance-context.ts";
import { assignPipelineV2, createSelectionPlanV2, pipelineRolloutStickyKey } from "./selection-plan-v2.ts";
import {
  catalogContentRating,
  catalogRecordingVersionClass,
  classifyTrackScopeBindingEvidence,
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
const TERMINAL_RUN_STATUSES = ["complete", "partial", "failed", "expired", "deleted"];
const JOB_ADVISORY_LOCK = 694_207_551;
const BUDGET_ADVISORY_LOCK = 694_207_552;
const RUN_CAPACITY_ADVISORY_LOCK = 694_207_553;
const FEEDBACK_SUBMISSION_PREFIX = "feedback-submission:";
const FEEDBACK_IDEMPOTENCY_PREFIX = "feedback-idempotency:";
const FEEDBACK_GLOBAL_BUCKET = "feedback-global";
const FEEDBACK_GLOBAL_DAILY_LIMIT = Math.max(1, Math.min(1_000, Number(process.env.FEEDBACK_GLOBAL_DAILY_LIMIT ?? 100) || 100));
const FEEDBACK_STORAGE_LIMIT_BYTES = Math.max(
  5 * 1024 * 1024,
  Math.min(1024 * 1024 * 1024, Number(process.env.FEEDBACK_STORAGE_LIMIT_BYTES ?? 100 * 1024 * 1024) || 100 * 1024 * 1024),
);

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
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  pipelineVersion: PipelineVersion;
  minimumWorkerProtocol: number;
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

function deterministicUuid(value: unknown): string {
  const hex = sha256Hex(stableStringify(value));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const APPLE_CATALOG_CACHE_RESOURCE_KINDS = new Set<AppleCatalogCacheResourceKind>([
  "catalog_resource",
  "search_view",
  "artist_view",
  "playlist_membership",
  "musicbrainz_identity",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
  _proofText: string,
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

function evidenceScopeDescriptors(
  plan: SelectionPlan | null,
  brief: PlaylistBrief,
  proofText: string,
  relationshipProofText: string,
): EvidenceScopeDescriptor[] {
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
    if (constraint.kind !== "hard" || constraint.operator === "exclude" || constraint.operator === "avoid") continue;
    if (constraint.axis === "relationship") {
      for (const value of constraint.values) {
        if (!plan) {
          if (proofTextSupportsValue(relationshipProofText, value)) add(primaryEvidenceScopeAxis(null), value);
          continue;
        }
        for (const scopeAxis of evidenceIntentScopeAxes(plan, proofText, relationshipProofText, value)) {
          add(scopeAxis, relationshipProofText);
        }
      }
      continue;
    }
    const scopeAxis = constraintScopeAxis(constraint.axis);
    if (!scopeAxis) continue;
    for (const value of constraint.values) {
      const geographyRelationship = constraint.geographyRelationship
        ?? (constraint.axis === "language" ? "language" : null);
      const exactRelationshipSupported = !geographyRelationship
        || geographyRelationship === "unspecified"
        || proofSupportsSelectionGeography(proofText, {
          value,
          relationship: geographyRelationship,
        });
      if (proofTextSupportsValue(proofText, value) && exactRelationshipSupported) {
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
  selection_rank: number | null;
  catalog_id: string;
  song_json: CatalogSong;
  artist: string;
  title: string;
  album: string | null;
  release_year: number | null;
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
  if (!root || root === "unclassified" || root === "unknown") return false;
  if (!binding.sourceRecordId || !binding.sourceUrl.startsWith("https://")) return false;
  const rootStep = binding.provenancePath.some((step) => (
    step.kind === "provenance_root" && normalizedPolicyText(step.id) === root
  ));
  const sourceStep = binding.provenancePath.some((step) => (
    step.kind === "source_record" && step.id === binding.sourceRecordId
  ));
  if (!rootStep || !sourceStep) return false;
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

function eraConstraintSatisfied(row: ManifestSelectionRow, constraint: SelectionConstraint): boolean {
  const releaseYear = row.release_year
    ?? (typeof row.song_json.releaseDate === "string"
      ? Number.parseInt(row.song_json.releaseDate.slice(0, 4), 10)
      : Number.NaN);
  if (!Number.isInteger(releaseYear)) return false;
  const ranges = constraint.values.flatMap((value): Array<{ start: number; end: number }> => {
    const decade = value.match(/\b(?:(early|mid|late)[ -]?)?((?:19|20)\d0)s\b/iu);
    if (decade) {
      const start = Number(decade[2]);
      if (decade[1]?.toLocaleLowerCase("en-US") === "early") return [{ start, end: start + 3 }];
      if (decade[1]?.toLocaleLowerCase("en-US") === "mid") return [{ start: start + 3, end: start + 6 }];
      if (decade[1]?.toLocaleLowerCase("en-US") === "late") return [{ start: start + 7, end: start + 9 }];
      return [{ start, end: start + 9 }];
    }
    const explicitRange = value.match(/\b((?:19|20)\d{2})\s*(?:-|\u2013|\u2014|to|through)\s*((?:19|20)\d{2})\b/iu);
    if (explicitRange) return [{
      start: Math.min(Number(explicitRange[1]), Number(explicitRange[2])),
      end: Math.max(Number(explicitRange[1]), Number(explicitRange[2])),
    }];
    return [...value.matchAll(/\b(?:19|20)\d{2}\b/gu)]
      .map((match) => ({ start: Number(match[0]), end: Number(match[0]) }));
  });
  if (ranges.length === 0) return false;
  const start = Math.min(...ranges.map((range) => range.start));
  const end = Math.max(...ranges.map((range) => range.end));
  if (constraint.operator === "before") return releaseYear < start;
  if (constraint.operator === "after") return releaseYear > end;
  if (constraint.operator === "between" || constraint.operator === "within" || ranges.length > 1) {
    return releaseYear >= start && releaseYear <= end;
  }
  return ranges.some((range) => releaseYear >= range.start && releaseYear <= range.end);
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
): PlaylistGuidanceAnswer[] {
  if (questions.length < 1 || questions.length > 3 || submitted.length !== questions.length) {
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
    if (!answer) throw new HttpError(400, "Answer every playlist question", "invalid_guidance_answers");
    const optionId = typeof answer.optionId === "string" ? answer.optionId.trim() : "";
    const customText = typeof answer.customText === "string" ? answer.customText.trim() : "";
    if (Boolean(optionId) === Boolean(customText)) {
      throw new HttpError(400, "Choose one option or enter one custom answer", "invalid_guidance_answers");
    }
    if (optionId) {
      if (!question.options.some((option) => option.id === optionId)) {
        throw new HttpError(400, "A selected playlist option is invalid", "invalid_guidance_answers");
      }
      return { questionId: question.id, optionId };
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
      const deleted = await client.query(
        "DELETE FROM settings WHERE key=$1 RETURNING key",
        [`${FEEDBACK_SUBMISSION_PREFIX}${id}`],
      );
      if (!deleted.rows[0]) return false;
      await client.query(
        `DELETE FROM settings
         WHERE key LIKE 'feedback-idempotency:%' AND value::jsonb->>'id'=$1`,
        [id],
      );
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
  }): Promise<{ id: string; status: string; created: boolean }> {
    const prompt = input.prompt.trim();
    if (prompt.length < 4 || prompt.length > 2_000) throw new HttpError(400, "Describe the playlist in 4–2,000 characters", "invalid_prompt");
    const requestedTrackCount = input.requestedTrackCount ?? null;
    if (requestedTrackCount !== null && (
      !Number.isInteger(requestedTrackCount)
      || requestedTrackCount < PUBLIC_PLAYLIST_MINIMUM_TRACKS
      || requestedTrackCount > PUBLIC_PLAYLIST_MAXIMUM_TRACKS
    )) {
      throw new HttpError(
        400,
        `Track count must be an integer from ${PUBLIC_PLAYLIST_MINIMUM_TRACKS} to ${PUBLIC_PLAYLIST_MAXIMUM_TRACKS}`,
        "invalid_track_count",
      );
    }
    return this.transaction(async (client) => {
      if (input.idempotencyKey) {
        await lockClientAliases(client, `brief:${input.idempotencyKey}`, input.clientBucketAliases);
        const existing = await client.query<{ id: string; status: string; prompt: string; requested_track_count: number | null }>(
          "SELECT id,status,prompt,requested_track_count FROM brief_requests WHERE client_bucket = ANY($1::text[]) AND idempotency_key = $2 AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
          [input.clientBucketAliases, input.idempotencyKey],
        );
        if (existing.rows[0]) {
          const prior = existing.rows[0];
          const priorTrackCount = prior.requested_track_count == null ? null : Number(prior.requested_track_count);
          if (prior.prompt !== prompt || priorTrackCount !== requestedTrackCount) {
            throw new HttpError(409, "Idempotency key was already used for a different playlist request", "idempotency_conflict");
          }
          return { id: prior.id, status: prior.status, created: false };
        }
      }
      const id = randomUUID();
      await client.query(
        `INSERT INTO brief_requests(id,prompt,requested_track_count,model,status,client_bucket,idempotency_key,expires_at)
         VALUES($1,$2,$3,$4,'queued',$5,$6,now()+interval '24 hours')`,
        [id, prompt, requestedTrackCount, input.model, input.clientBucket, input.idempotencyKey ?? null],
      );
      return { id, status: "queued", created: true };
    });
  }

  async getBriefRequest(id: string): Promise<any | null> {
    const result = await this.pool.query(
      `SELECT id,prompt,requested_track_count,model,status,brief_json,questions_json,answers_json,
              guidance_source_hints_json,guidance_telemetry_json,guidance_preferences_json,
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
        await client.query(
          `UPDATE brief_requests SET prompt='',status='failed',brief_json=NULL,
             questions_json=NULL,answers_json=NULL,answers_idempotency_key=NULL,
             answers_hash=NULL,guidance_source_hints_json='[]'::jsonb,
             guidance_telemetry_json=NULL,guidance_preferences_json='[]'::jsonb,
             estimate_usd=NULL,error=NULL,expires_at=now(),updated_at=now()
           WHERE id=$1`,
          [id],
        );
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
    estimateUsd?: number;
    error?: string | null;
  }): Promise<void> {
    const persistedError = result.status === "failed"
      ? sanitizeFailure(result.error, "brief")
      : null;
    await this.pool.query(
      `UPDATE brief_requests SET status=$2,brief_json=$3,questions_json=COALESCE($4,questions_json),
              guidance_source_hints_json=COALESCE($5,guidance_source_hints_json),
              guidance_telemetry_json=CASE WHEN $6::boolean THEN $7 ELSE guidance_telemetry_json END,
              estimate_usd=$8,error=$9,updated_at=now()
       WHERE id=$1 AND expires_at>now() AND ($10::varchar IS NULL OR status=$10::varchar)`,
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
    answers: PlaylistGuidanceAnswer[];
  }): Promise<{ status: "finalizing" | "complete"; created: boolean }> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`brief-answers:${input.briefRequestId}`]);
      const selected = await client.query<{
        status: string;
        questions_json: PlaylistGuidanceQuestion[] | null;
        answers_idempotency_key: string | null;
        answers_hash: string | null;
      }>(
        `SELECT status,questions_json,answers_idempotency_key,answers_hash
         FROM brief_requests
         WHERE id=$1 AND expires_at>now()
         FOR UPDATE`,
        [input.briefRequestId],
      );
      const brief = selected.rows[0];
      if (!brief) throw new HttpError(404, "Brief request not found", "brief_not_found");
      const questions = Array.isArray(brief.questions_json) ? brief.questions_json : [];
      const answers = normalizedGuidanceAnswers(questions, input.answers);
      const guidancePreferences = deriveGuidancePreferences(questions, answers);
      const answersHash = sha256Hex(stableStringify(answers));
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
  }): Promise<{ runId: string; accessId: string; created: boolean; reused: boolean; status: string }> {
    const estimate = finiteMoney(input.estimateUsd, "Estimate");
    const approved = finiteMoney(input.approvedBudgetUsd, "Approved budget");
    let guidanceSourceHints: PlaylistGuidanceSourceHint[] = [];
    let guidanceTelemetry: PlaylistGuidanceTelemetry | null = null;
    let guidancePreferences: PlaylistGuidancePreference[] = [];
    let selectionPlan: SelectionPlan | null = null;
    if (input.briefRequestId) {
      const context = await this.pool.query<{
        guidance_source_hints_json: PlaylistGuidanceSourceHint[] | null;
        guidance_telemetry_json: PlaylistGuidanceTelemetry | null;
        guidance_preferences_json: PlaylistGuidancePreference[] | null;
        selection_plan_json: SelectionPlan | null;
      }>(
        `SELECT guidance_source_hints_json,guidance_telemetry_json,guidance_preferences_json,selection_plan_json
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
      selectionPlan = row.selection_plan_json ?? null;
    }
    const proposedSelectionPlan = selectionPlan ?? createSelectionPlanV2({
      prompt: input.prompt,
      brief: input.brief,
      guidancePreferences,
      storefront: process.env.APPLE_STOREFRONT ?? "us",
    });
    const pipelineAssignment = assignPipelineV2({
      plan: proposedSelectionPlan,
      owner: input.forceFreshResearch === true,
      // A visitor remains in the same rollout cohort across prompts. Scope
      // text must not reshuffle one browser between V1 and V2; only a new
      // pipeline route or policy version intentionally creates a new cohort.
      stickyKey: pipelineRolloutStickyKey(input.clientBucket, proposedSelectionPlan),
      env: process.env,
    });
    selectionPlan = pipelineAssignment.assigned ? proposedSelectionPlan : null;
    const modelRoutingSignals = { scoutTelemetry: guidanceTelemetry };
    const briefHash = sha256Hex(stableStringify({
      brief: input.brief,
      guidancePreferences,
      selectionPlan,
      researchPolicy: researchPolicyFingerprint(input.brief, process.env, selectionPlan, modelRoutingSignals),
    }));
    const pipelinePolicySnapshot = selectionPlan == null ? null : createPipelinePolicySnapshot({
      brief: input.brief,
      selectionPlan,
      environment: process.env,
      modelRoutingSignals,
    });
    const executionPolicy = researchExecutionPolicy(input.brief, process.env, selectionPlan, modelRoutingSignals);
    // Owner requests are deliberate test/refresh runs. Never attach them to a
    // prior visitor result, even when the confirmed brief hashes identically.
    const reuseDays = input.forceFreshResearch
      ? 0
      : Math.max(0, Math.min(input.reuseDays ?? 30, 30));
    return this.transaction(async (client) => {
      await lockClientAliases(client, `run:${input.idempotencyKey}`, input.clientBucketAliases);
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
        status = estimate > gate && approved < estimate ? "awaiting_budget" : "queued";
        const phase = status === "awaiting_budget" ? "budget_gate" : "queued";
        const canonicalPrompt = `${input.brief.title}: ${input.brief.description}`.slice(0, 2_000);
        const insertedRun = await client.query<{ created_at: Date }>(
          `INSERT INTO research_runs(
             id,prompt,brief_json,guidance_source_hints_json,guidance_telemetry_json,
             guidance_preferences_json,brief_hash,status,phase,client_bucket,idempotency_key,auto_publish,
             estimated_cost_usd,approved_budget_usd,pipeline_version,policy_version,selection_plan_json,
             pipeline_policy_snapshot_json,
             budget_approval_expires_at,retention_expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::varchar,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
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
            Math.max(approved, status === "queued" ? estimate : 0),
            selectionPlan?.pipelineVersion ?? "legacy_v1",
            selectionPlan?.policyVersion ?? "legacy_v1",
            selectionPlan == null ? null : JSON.stringify(selectionPlan),
            pipelinePolicySnapshot == null ? null : JSON.stringify(pipelinePolicySnapshot),
          ],
        );
        if (executionPolicy.kind === "fast_curated") {
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
      return { runId, accessId, status, created: !reused, reused };
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

  async updateRun(id: string, values: {
    status?: string;
    phase?: string;
    costDelta?: number;
    approvedBudget?: number;
    noNewGapPasses?: number;
    error?: string | null;
  }): Promise<void> {
    const costDelta = values.costDelta == null ? 0 : finiteMoney(values.costDelta, "Cost delta");
    const persistedError = values.error === undefined
      ? undefined
      : sanitizeOptionalFailure(values.error, failureContextForRun(values.phase));
    const result = await this.pool.query(
      `UPDATE research_runs SET
         status=COALESCE($2,status), phase=COALESCE($3,phase), actual_cost_usd=actual_cost_usd+$4,
         approved_budget_usd=COALESCE($5,approved_budget_usd), no_new_gap_passes=COALESCE($6,no_new_gap_passes),
         error=CASE WHEN $7::boolean THEN $8 ELSE error END,
         budget_approval_expires_at=CASE
           WHEN $2::varchar='awaiting_budget' THEN now()+interval '7 days'
           WHEN $2::varchar='queued' THEN NULL
           ELSE budget_approval_expires_at
         END,
         completed_at=CASE WHEN COALESCE($2,status) IN ('complete','partial','failed','expired','deleted') THEN COALESCE(completed_at,now()) ELSE completed_at END,
         updated_at=now()
       WHERE id=$1
         AND NOT (status='failed' AND phase='owner_cancelled')
         AND NOT (status='deleted' OR phase='visitor_deleted')`,
      [id, values.status ?? null, values.phase ?? null, costDelta, values.approvedBudget ?? null, values.noNewGapPasses ?? null, values.error !== undefined, persistedError ?? null],
    );
    if (result.rowCount === 0) throw new HttpError(404, "Research run not found", "run_not_found");
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

  async getRunControlState(id: string): Promise<{ status: string; phase: string } | null> {
    const result = await this.pool.query<{ status: string; phase: string }>(
      "SELECT status,phase FROM research_runs WHERE id=$1 AND deleted_at IS NULL",
      [id],
    );
    return result.rows[0] ?? null;
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
    const [counts, frontier] = await Promise.all([
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
    };
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
        await client.query("DELETE FROM brief_requests WHERE id=$1", [access.rows[0].brief_request_id]);
      }
      const remaining = await client.query<{ count: number }>("SELECT count(*)::int count FROM run_accesses WHERE run_id=$1 AND deleted_at IS NULL", [runId]);
      if (remaining.rows[0]!.count === 0) {
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
          `SELECT e.id,e.source_id,s.url source_url,s.source_class,s.provenance_root,
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
          const proofText = [
            row.citation_excerpt ?? "",
            row.subject_entity,
            row.relationship,
            row.note,
          ].join(" ");
          return evidenceScopeDescriptors(selectionPlan, brief, proofText, row.relationship)
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
          match.score,
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
      const alreadyLocked = await client.query("SELECT * FROM manifests WHERE run_id=$1 LIMIT 1", [runId]);
      if (alreadyLocked.rows[0]) {
        const stored = alreadyLocked.rows[0];
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
        `SELECT m.candidate_id,c.selection_rank,m.catalog_id,m.song_json,c.artist,c.title,c.album,c.release_year,c.duration_ms
         FROM catalog_matches m
         JOIN track_candidates c ON c.id=m.candidate_id
         WHERE m.run_id=$1 AND m.status='accepted' AND m.catalog_id IS NOT NULL ${verifiedClause}
         ORDER BY ${orderSql}`,
        options.verifiedOnly ? [runId, brief.subjectEntities, brief.relationship] : [runId],
      );
      const maximumTracks = brief.mode === "curated"
        ? Math.max(1, Math.floor(brief.targetSize?.max ?? 100))
        : Number.POSITIVE_INFINITY;
      let constraintSelection: ConstraintSelection<ManifestSelectionRow> = {
        outcome: "complete",
        selected: matches.rows,
        relaxedSoftConstraints: [] as string[],
      };
      let hardRejectedMatches: ManifestSelectionRow[] = [];
      let ladderOverflowMatches: ManifestSelectionRow[] = [];
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
        const candidates: ConstraintCandidate<ManifestSelectionRow>[] = matches.rows.map((row) => {
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
            violations.push("artist_concentration");
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
              const appleReleaseYear = Number.parseInt(row.song_json.releaseDate?.slice(0, 4) ?? "", 10);
              return {
                id: row.candidate_id,
                artist: row.song_json.artistName || row.artist,
                title: row.song_json.name || row.title,
                album: row.song_json.albumName || row.album,
                releaseYear: row.release_year ?? (Number.isInteger(appleReleaseYear) ? appleReleaseYear : null),
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
        ladderOverflowMatches = matches.rows.filter((row) => (
          !selectedIds.has(row.candidate_id) && !hardRejectedIds.has(row.candidate_id)
        ));
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
        const appleYear = typeof song?.releaseDate === "string"
          ? Number.parseInt(song.releaseDate.slice(0, 4), 10)
          : null;
        return {
          ...match,
          artist: match.artist,
          album: song?.albumName || match.album,
          genre: song?.genreNames,
          releaseYear: Number.isInteger(appleYear) ? appleYear : match.release_year,
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
      await client.query(
        `INSERT INTO manifests(
           id,run_id,name,description,content_hash,pipeline_version,policy_version,selection_plan_json)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [id, runId, name, description, contentHash, pipelineVersion, policyVersion,
          selectionPlan == null ? null : JSON.stringify(selectionPlan)],
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

  async getLatestManifestForRun(runId: string): Promise<any | null> {
    const result = await this.pool.query<{ id: string }>("SELECT id FROM manifests WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1", [runId]);
    return result.rows[0] ? this.getManifestById(result.rows[0].id) : null;
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

  async upsertPublicPlaylistDirectoryForRun(runId: string): Promise<PublicPlaylistDirectoryItem | null> {
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
           id,run_id,manifest_hash,title,track_count,volume_count,status,published_at
         ) VALUES($1,$2,$3,$4,$5,$6,'listed',$7)
         ON CONFLICT(manifest_hash) DO UPDATE SET
           run_id=EXCLUDED.run_id,title=EXCLUDED.title,track_count=EXCLUDED.track_count,
           volume_count=EXCLUDED.volume_count,
           status=CASE WHEN public_playlists.owner_hidden THEN 'hidden' ELSE 'listed' END,
           hidden_at=CASE
             WHEN public_playlists.owner_hidden THEN COALESCE(public_playlists.hidden_at,now())
             ELSE NULL
           END,
           published_at=EXCLUDED.published_at,updated_at=now()
         RETURNING id,status,hidden_at`,
        [directoryId, source.run_id, source.content_hash, title, manifestTrackCount, volumeCount, publishedAt],
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
       SELECT $1,m.run_id,'publication',$4,$5,3
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
          `UPDATE job_queue SET run_id=$2,payload_json=$3,status='queued',attempts=0,max_attempts=3,
             available_at=now(),lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,completed_at=NULL,updated_at=now()
           WHERE id=$1 AND status IN ('failed','cancelled')`,
          [jobId, input.runId, { runId: input.runId, manifestId: input.manifestId }],
        );
      } else {
        await client.query(
          `INSERT INTO job_queue(id,run_id,kind,dedupe_key,payload_json,max_attempts)
           VALUES($1,$2,'publication',$3,$4,3)`,
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
          const counts = await this.pool.query<{ discovered_count: number }>(
            "SELECT count(*)::int discovered_count FROM track_candidates WHERE run_id=$1",
            [runId],
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
            discoveredTrackCount: Number(counts.rows[0]?.discovered_count ?? 0),
            qualifiedTrackCount: 0,
            selectedTrackCount: 0,
            publishedTrackCount: 0,
            frontierExhausted: true,
            reasonCodes: ["manifest_hard_constraints_rejected_all"],
          });
          await this.savePipelineOutcome(runId, outcome);
          await this.savePipelineDeficitLedger(runId, outcome.deficits, {
            pipelineVersion: plan.pipelineVersion,
            policyVersion: plan.policyVersion,
            mode: "append",
          });
          await this.updateRun(runId, {
            status: "partial",
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

  async enqueueJob(input: {
    kind: string;
    runId?: string | null;
    briefRequestId?: string | null;
    payload?: Record<string, unknown>;
    dedupeKey?: string;
    availableAt?: Date;
    maxAttempts?: number;
  }): Promise<{ id: string; created: boolean }> {
    const id = randomUUID();
    const dedupeKey = input.dedupeKey ?? input.runId ?? input.briefRequestId ?? randomUUID();
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
  ): Promise<JobView | null> {
    if (!isWorkerCapabilityValid(capability)) {
      throw new HttpError(400, "Worker lease capability is invalid", "invalid_worker_capability");
    }
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [JOB_ADVISORY_LOCK]);
      const exhausted = await client.query<{ run_id: string | null; brief_request_id: string | null; kind: string; payload_json: Record<string, unknown> | null }>(
        `UPDATE job_queue SET status='failed',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL,
         last_error=CASE kind
           WHEN 'brief' THEN $1
           WHEN 'research' THEN $2
           WHEN 'matching' THEN $3
           WHEN 'publication' THEN $4
           WHEN 'notification' THEN $5
           WHEN 'apple_authorization' THEN $6
           ELSE $7 END,
         updated_at=now()
         WHERE status='leased' AND lease_expires_at<=now() AND attempts>=max_attempts
           AND minimum_worker_protocol<=$8
           AND pipeline_version=ANY($9::varchar[])
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
          await client.query(
            `UPDATE research_runs SET status='failed',phase=$2,error=$3,
             completed_at=COALESCE(completed_at,now()),updated_at=now()
             WHERE id=$1 AND status NOT IN ('complete','partial','failed','expired','deleted','waiting_for_apple_authorization')`,
            [job.run_id, `${job.kind}_failed`, sanitizeFailure(
              job.kind === "publication" ? "Worker lease expired after the final attempt" : null,
              failureContextForJob(job.kind),
            )],
          );
        }
        if (job.brief_request_id && job.kind === "brief") {
          await client.query(
            "UPDATE brief_requests SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status<>'complete'",
            [job.brief_request_id, sanitizeFailure(null, "brief")],
          );
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
      const active = await client.query<{ count: number }>("SELECT count(*)::int count FROM job_queue WHERE status='leased' AND lease_expires_at>now()");
      if (active.rows[0]!.count >= capacity) return null;
      // Brief and explicitly marked fast jobs normally lead the queue. Once an
      // operational job has been runnable for 30 seconds it is promoted above
      // that lane, preventing an endless stream of fast jobs from starving it.
      const selected = await client.query(
        `SELECT candidate.* FROM job_queue candidate WHERE
           ((candidate.status='queued' AND candidate.available_at<=now()) OR (candidate.status='leased' AND candidate.lease_expires_at<=now()))
           AND candidate.minimum_worker_protocol<=$1
           AND candidate.pipeline_version=ANY($2::varchar[])
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
        [capability.protocolNumber, [...capability.pipelineVersions]],
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
        payload: row.payload_json ?? {},
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        pipelineVersion: row.pipeline_version,
        minimumWorkerProtocol: Number(row.minimum_worker_protocol),
        leaseOwner: row.lease_owner,
        leaseExpiresAt: date(row.lease_expires_at),
      };
    });
  }

  async renewJobLease(jobId: string, workerId: string, leaseMs: number): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE job_queue SET lease_expires_at=$3,updated_at=now() WHERE id=$1 AND lease_owner=$2 AND status='leased' AND lease_expires_at>now()",
      [jobId, workerId, new Date(Date.now() + Math.max(30_000, leaseMs))],
    );
    return Boolean(result.rowCount);
  }

  async deferJob(jobId: string, workerId: string, availableAt: Date, reason: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE job_queue SET status='queued',attempts=GREATEST(0,attempts-1),available_at=$3,
       lease_owner=NULL,lease_expires_at=NULL,last_error=$4,completed_at=NULL,updated_at=now()
       WHERE id=$1 AND lease_owner=$2 AND status='leased'`,
      [jobId, workerId, availableAt, sanitizeFailure(reason, "background")],
    );
    if (!result.rowCount) throw new HttpError(409, "Job lease was lost", "job_lease_lost");
  }

  async cancelLeasedJob(jobId: string, workerId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE job_queue SET status='cancelled',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL,
       last_error=$3,updated_at=now()
       WHERE id=$1 AND lease_owner=$2 AND status='leased'`,
      [jobId, workerId, sanitizeFailure(reason, "background")],
    );
  }

  async completeJob(jobId: string, workerId: string): Promise<void> {
    await this.transaction(async (client) => {
      const current = await client.query<{
        run_id: string | null;
        kind: string;
        payload_json: Record<string, unknown> | null;
      }>(
        "SELECT run_id,kind,payload_json FROM job_queue WHERE id=$1 AND lease_owner=$2 AND status='leased' FOR UPDATE",
        [jobId, workerId],
      );
      if (!current.rows[0]) throw new HttpError(409, "Job lease was lost", "job_lease_lost");
      const job = current.rows[0];
      if (job.run_id && job.kind === "matching" && isCatalogRecoveryJob(job.payload_json)
        && catalogRecoveryGeneration(job.payload_json) >= 3) {
        await settleCatalogRecoveryFailure(client, job.run_id, 3);
      }
      await client.query(
        `UPDATE job_queue SET status='complete',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
         WHERE id=$1 AND lease_owner=$2 AND status='leased'`,
        [jobId, workerId],
      );
    });
  }

  async failJob(jobId: string, workerId: string, error: string, retryAt: Date | null = null): Promise<void> {
    await this.transaction(async (client) => {
      const current = await client.query<{ attempts: number; max_attempts: number; run_id: string | null; brief_request_id: string | null; kind: string; payload_json: Record<string, unknown> | null }>(
        "SELECT attempts,max_attempts,run_id,brief_request_id,kind,payload_json FROM job_queue WHERE id=$1 AND lease_owner=$2 AND status='leased' FOR UPDATE",
        [jobId, workerId],
      );
      if (!current.rows[0]) throw new HttpError(409, "Job lease was lost", "job_lease_lost");
      const retry = retryAt && current.rows[0].attempts < current.rows[0].max_attempts;
      const context = failureContextForJob(current.rows[0].kind);
      const persistedError = sanitizeFailure(error, context);
      await client.query(
        `UPDATE job_queue SET status=$3::varchar,available_at=COALESCE($4::timestamptz,available_at),last_error=$5,
         completed_at=CASE WHEN $3::varchar='failed' THEN now() ELSE NULL END,lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
         WHERE id=$1 AND lease_owner=$2`,
        [jobId, workerId, retry ? "queued" : "failed", retry ? retryAt : null, persistedError],
      );
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
        await client.query(
          `UPDATE research_runs SET status='failed',phase=$2,error=$3,completed_at=COALESCE(completed_at,now()),updated_at=now()
           WHERE id=$1 AND status NOT IN ('complete','partial','failed','expired','deleted','waiting_for_apple_authorization')`,
          [current.rows[0].run_id, `${current.rows[0].kind}_failed`, persistedError.slice(0, 2_000)],
        );
      }
      if (!retry && current.rows[0].kind === "publication") {
        await markTerminalPublicationVolumes(client, current.rows[0].payload_json, error);
      }
      if (!retry && current.rows[0].brief_request_id && current.rows[0].kind === "brief") {
        await client.query(
          "UPDATE brief_requests SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status<>'complete'",
          [current.rows[0].brief_request_id, sanitizeFailure(error, "brief")],
        );
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
    });
  }

  async updateWorkerHeartbeat(workerId: string, metadata: { schemaVersion?: string; capacity?: number; activeJobs?: number; [key: string]: unknown }): Promise<void> {
    const { schemaVersion = DATABASE_SCHEMA_VERSION, capacity = 1, activeJobs = 0, ...rest } = metadata;
    await this.pool.query(
      `INSERT INTO worker_heartbeats(worker_id,schema_version,capacity,active_jobs,metadata_json)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(worker_id) DO UPDATE SET schema_version=EXCLUDED.schema_version,
       capacity=EXCLUDED.capacity,active_jobs=EXCLUDED.active_jobs,metadata_json=EXCLUDED.metadata_json,last_seen_at=now()`,
      [workerId, schemaVersion, capacity, activeJobs, rest],
    );
  }

  async getResearchCheckpoint(runId: string, phase: string): Promise<unknown | null> {
    const result = await this.pool.query<{ state_json: unknown }>("SELECT state_json FROM research_checkpoints WHERE run_id=$1 AND phase=$2", [runId, phase]);
    return result.rows[0]?.state_json ?? null;
  }

  async saveResearchCheckpoint(runId: string, phase: string, state: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO research_checkpoints(run_id,phase,state_json) VALUES($1,$2,$3)
       ON CONFLICT(run_id,phase) DO UPDATE SET state_json=EXCLUDED.state_json,updated_at=now()`,
      [runId, phase, state],
    );
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
      local_contract_rejections: number;
      provider_circuit_openings: number;
      pagination_loops: number;
      endpoint_drift_events: number;
      publication_divergences: number;
    }>(
      `WITH recent_outcomes AS (
         SELECT po.id,po.status,po.published_track_count,po.reason_codes_json
         FROM pipeline_outcomes po
         JOIN research_runs r ON r.id=po.run_id
         WHERE po.pipeline_version<>'legacy_v1'
           AND po.completed_at >= $1 AND po.completed_at < $2
           AND r.status IN ('complete','partial','failed','expired','deleted')
       ), outcome_signals AS (
         SELECT 'outcome:' || ro.id::text || ':' || reason signal_id,lower(reason) signal
         FROM recent_outcomes ro
         CROSS JOIN LATERAL jsonb_array_elements_text(ro.reason_codes_json) AS reasons(reason)
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
          WHERE status='no_compatible_tracks') zero_result_runs,
         (SELECT count(*)::int FROM recent_outcomes
          WHERE status LIKE 'partial_%') partial_runs,
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
      }>(
        `SELECT m.id,r.pipeline_version,r.policy_version,r.selection_plan_json,
                r.pipeline_policy_snapshot_json
         FROM manifests m JOIN research_runs r ON r.id=m.run_id
         WHERE m.id=$2 AND m.run_id=$1 AND r.deleted_at IS NULL FOR UPDATE OF m,r`,
        [runId, revision.manifestId],
      );
      const run = manifest.rows[0];
      if (!run) throw new HttpError(404, "Manifest not found", "manifest_not_found");
      if (run.pipeline_version !== revision.pipelineVersion || run.policy_version !== revision.policyVersion) {
        throw new HttpError(409, "Manifest revision versions do not match the immutable run", "pipeline_policy_mismatch");
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
      let selectionPlanSnapshot = revision.selectionPlanSnapshot;
      let policySnapshot = revision.policySnapshot;
      let outcomeSnapshot = revision.outcomeSnapshot;
      let deficitSnapshot = revision.deficitSnapshot;
      if (revision.pipelineVersion !== "legacy_v1" && revision.status !== "draft") {
        const storedOutcome = await client.query<{ outcome_json: PipelineOutcome }>(
          "SELECT outcome_json FROM pipeline_outcomes WHERE run_id=$1 FOR SHARE",
          [runId],
        );
        selectionPlanSnapshot = run.selection_plan_json;
        policySnapshot = run.pipeline_policy_snapshot_json;
        outcomeSnapshot = storedOutcome.rows[0]?.outcome_json ?? null;
        deficitSnapshot = outcomeSnapshot?.deficits ?? [];
        if (!selectionPlanSnapshot || !policySnapshot || !outcomeSnapshot) {
          throw new HttpError(
            409,
            "Pipeline V2 manifest revisions require persisted plan, policy, and outcome snapshots",
            "manifest_revision_snapshot_missing",
          );
        }
      }
      const id = revision.id || randomUUID();
      await client.query(
        `INSERT INTO manifest_revisions(
           id,manifest_id,revision,parent_revision_id,status,reason,content_hash,pipeline_version,
           policy_version,selection_plan_snapshot_json,pipeline_policy_snapshot_json,
           outcome_snapshot_json,deficit_snapshot_json,locked_at,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15)`,
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

  async getPublicResult(runId: string): Promise<any> {
    const [manifest, run, outcomeCounts] = await Promise.all([
      this.getLatestManifestForRun(runId),
      this.getRun(runId),
      this.getOutcomeCounts(runId),
    ]);
    if (!manifest) return { status: run.status, manifest: null, volumes: [], outcomeCounts, completedTracks: 0, totalTracks: 0 };
    const rawVolumes = await this.listPublicationVolumes(manifest.id, manifest.revisionId ?? null);
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
    };
  }

  async getOutcomeCounts(runId: string): Promise<Record<string, number>> {
    const result = await this.pool.query<{ outcome: string; count: number }>("SELECT outcome,count(*)::int count FROM track_candidates WHERE run_id=$1 GROUP BY outcome", [runId]);
    return Object.fromEntries(result.rows.map((row) => [row.outcome, row.count]));
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

  async runRetentionSweep(limit = 50): Promise<number> {
    const detailCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000);
    await this.pool.query(
      `UPDATE research_runs SET status='expired',phase='budget_approval_expired',error='Budget approval expired after seven days',completed_at=now(),updated_at=now()
       WHERE status='awaiting_budget' AND budget_approval_expires_at<=now()`,
    );
    const expired = await this.pool.query<{ id: string }>(
      "SELECT id FROM research_runs WHERE retention_expires_at<=now() ORDER BY retention_expires_at FOR UPDATE SKIP LOCKED LIMIT $1",
      [Math.max(1, Math.min(limit, 500))],
    );
    for (const row of expired.rows) await this.purgeRunToTombstone(row.id);
    // A brief's 24-hour expiry controls visitor access and idempotent reuse,
    // not operational retention. Keep every attempt—including abandoned and
    // budget-gated ones—for the same 90-day QA window as detailed run data.
    await this.pool.query(
      "DELETE FROM cost_ledger WHERE brief_request_id IN (SELECT id FROM brief_requests WHERE created_at<=$1)",
      [detailCutoff],
    );
    await this.pool.query("DELETE FROM brief_requests WHERE created_at<=$1", [detailCutoff]);
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
    // Open feedback remains available to the owner. Once resolved, both its
    // text and private screenshot are removed after the normal 90-day window.
    await this.pool.query(
      `DELETE FROM settings
       WHERE key LIKE 'feedback-submission:%'
         AND value::jsonb->>'status'='resolved'
         AND updated_at<=$1`,
      [detailCutoff],
    );
    await this.pool.query(
      `DELETE FROM settings mapping
       WHERE mapping.key LIKE 'feedback-idempotency:%'
         AND NOT EXISTS (
           SELECT 1 FROM settings report
           WHERE report.key='feedback-submission:' || (mapping.value::jsonb->>'id')
         )`,
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
    });
  }
}
