import { createHash } from "node:crypto";
import {
  AppleApiError,
  AppleAuthorizationRequiredError,
  type AppleAuthorizationRecord,
  type AppleAuthorizationStore,
  authorizedAppleClient,
} from "./apple.ts";
import type {
  CandidateStageEvent,
  ManifestRevision,
  ManifestRevisionStatus,
  PipelineDeficitLedgerEntry,
  PipelineOutcome,
  PipelineOutcomeStatus,
  PipelinePolicyVersion,
  PipelinePolicySnapshot,
  PipelineVersion,
  PublicationStatus,
  SelectionPlan,
} from "../shared/types.ts";
import type { PipelineStageCounts } from "./pipeline-v2-observability.ts";
import { appendPlaylistTitleSuffix } from "./playlist-title.ts";
import type { PublicationCompleteness } from "./publication-completeness.ts";
import {
  preflightManifestRevision,
  type PreflightManifestTrack,
  type PreflightReserveTrack,
} from "./manifest-preflight-v2.ts";
import { buildPipelineOutcome } from "./pipeline-outcome-v2.ts";

const VOLUME_SIZE = 1_000;
const APPEND_BATCH_SIZE = 25;
const MAX_REPLACEMENTS = 3;
const SHARE_POLL_MS = process.env.NODE_ENV === "test" ? 0 : 3_000;
const CONSISTENCY_POLL_MS = process.env.NODE_ENV === "test" ? 0 : 1_000;

function sharePollAttempts(): number {
  const seconds = Number(process.env.APPLE_SHARE_URL_TIMEOUT_SECONDS ?? 300);
  const boundedSeconds = Number.isFinite(seconds) ? Math.min(Math.max(seconds, 15), 10 * 60) : 300;
  return Math.ceil(boundedSeconds * 1_000 / SHARE_POLL_MS);
}

export interface LockedManifestTrack {
  candidateId: string;
  catalogId: string;
  artist: string;
  title: string;
  position?: number;
  recordingFamilyId?: string | null;
  catalogIdentityId?: string | null;
}

export interface LockedManifest {
  id: string;
  runId: string;
  name: string;
  description: string;
  contentHash: string;
  lockedAt: string;
  tracks: LockedManifestTrack[];
  pipelineVersion?: PipelineVersion;
  policyVersion?: PipelinePolicyVersion;
  selectionPlan?: SelectionPlan | null;
  policySnapshot?: PipelinePolicySnapshot | null;
  outcomeSnapshot?: PipelineOutcome | null;
  deficitSnapshot?: PipelineDeficitLedgerEntry[];
  revisionId?: string | null;
  revision?: number | null;
}

export interface PublicationVolume {
  id: string;
  manifestId: string;
  manifestRevisionId?: string | null;
  runId: string;
  volumeIndex: number;
  volumeCount: number;
  attempt: number;
  name: string;
  description: string;
  playlistId: string | null;
  shareUrl: string | null;
  appendedCount: number;
  startPosition?: number;
  endPosition?: number;
  status: PublicationStatus;
}

export interface PublicationRepository extends Pick<AppleAuthorizationStore, "getAppleAuthorization" | "updateAppleAuthorizationStatus"> {
  getSetting(key: string): Promise<string | null>;
  getRunControlState(runId: string): Promise<{ status: string; phase: string } | null>;
  getPublicationCompleteness(runId: string, manifestId: string): Promise<PublicationCompleteness>;
  getManifestById(manifestId: string): Promise<LockedManifest | null>;
  listPublicationVolumes(manifestId: string, manifestRevisionId?: string | null): Promise<any[]>;
  createPublicationVolume(input: {
    manifestId: string;
    manifestRevisionId?: string | null;
    volumeNumber: number;
    volumeCount: number;
    startPosition: number;
    endPosition: number;
    status?: string;
  }): Promise<any>;
  retirePublicationVolume(input: {
    manifestId: string;
    publicationVolumeId: string;
    applePlaylistId?: string | null;
    reason: string;
  }): Promise<string | null>;
  hidePublicPlaylistsForRun(runId: string): Promise<number>;
  updatePublicationVolume(volumeId: string, patch: {
    status?: string;
    applePlaylistId?: string | null;
    appleShareUrl?: string | null;
    appendedCount?: number;
    attemptDelta?: number;
    lastError?: string | null;
    publishedAt?: Date | null;
  }): Promise<void>;
  markPlaylistOrphan(input: {
    manifestId?: string | null;
    publicationVolumeId?: string | null;
    applePlaylistId: string;
    reason: string;
  }): Promise<string>;
  updateRun(runId: string, patch: { status?: string; phase?: string; error?: string | null }): Promise<void>;
  enqueueNotification(kind: string, payload: Record<string, unknown>): Promise<string>;
  getManifestPreflightTracks?(manifestId: string, revisionId?: string | null, storefront?: string): Promise<PreflightManifestTrack[]>;
  getManifestPreflightReserveTracks?(manifestId: string, revisionId: string, storefront?: string): Promise<PreflightReserveTrack[]>;
  createManifestRevision?(runId: string, revision: ManifestRevision): Promise<string>;
  getManifestRevision?(runId: string, revisionId: string): Promise<ManifestRevision | null>;
  markManifestRevisionStatus?(runId: string, revisionId: string, status: ManifestRevisionStatus): Promise<void>;
  getPipelineOutcome?(runId: string): Promise<PipelineOutcome | null>;
  savePipelineOutcome?(runId: string, outcome: PipelineOutcome): Promise<void>;
  getPipelineStageCounts?(runId: string): Promise<PipelineStageCounts>;
  appendCandidateStageEvents?(
    runId: string,
    events: readonly CandidateStageEvent[],
    versions: Pick<SelectionPlan, "pipelineVersion" | "policyVersion">,
  ): Promise<void>;
  sealManifestRevisionPublication?(runId: string, revisionId: string, outcome: PipelineOutcome): Promise<void>;
}

export interface PublicationAppleClient {
  findLibraryPlaylistByMarker(marker: string, signal?: AbortSignal): Promise<any | null>;
  createLibraryPlaylist(name: string, description: string, signal?: AbortSignal): Promise<{ id: string; url: string | null }>;
  appendCatalogTracks(playlistId: string, catalogIds: readonly string[], signal?: AbortSignal): Promise<void>;
  getOrderedPlaylistCatalogIds(playlistId: string, signal?: AbortSignal): Promise<string[]>;
  getCatalogRecordingKeys?(catalogIds: readonly string[], signal?: AbortSignal): Promise<Record<string, string>>;
  pollStableShareUrl(playlistId: string, attempts?: number, delayMs?: number, signal?: AbortSignal): Promise<string>;
}

export class PublicationPausedError extends Error {
  readonly name = "PublicationPausedError";

  constructor(readonly reason: "owner_pause" | "authorization_changing") {
    super(reason === "owner_pause" ? "Publication is paused by the owner" : "Apple authorization changed during publication");
  }
}

export class PublicationRunCancelledError extends Error {
  readonly name = "PublicationRunCancelledError";

  constructor() {
    super("The playlist run was cancelled or deleted");
  }
}

type AuthorizationIdentity = Pick<AppleAuthorizationRecord, "ciphertext" | "keyVersion">;

export async function assertPublicationControl(
  repository: PublicationRepository,
  expectedAuthorization?: AuthorizationIdentity,
  signal?: AbortSignal,
  runId?: string,
): Promise<AppleAuthorizationRecord> {
  signal?.throwIfAborted();
  const [paused, authorization, run] = await Promise.all([
    repository.getSetting("publishing_paused"),
    repository.getAppleAuthorization(),
    runId ? repository.getRunControlState(runId) : Promise.resolve(null),
  ]);
  signal?.throwIfAborted();
  if (runId && (!run || run.status === "deleted" || run.status === "expired"
    || run.phase === "owner_cancelled" || run.phase === "visitor_deleted")) {
    throw new PublicationRunCancelledError();
  }
  if (paused === "true") throw new PublicationPausedError("owner_pause");
  if (!authorization || authorization.status === "reauthorization_required") {
    throw new AppleAuthorizationRequiredError(401);
  }
  if (authorization.status !== "valid") throw new PublicationPausedError("authorization_changing");
  if (expectedAuthorization && (
    authorization.ciphertext !== expectedAuthorization.ciphertext
    || authorization.keyVersion !== expectedAuthorization.keyVersion
  )) {
    throw new PublicationPausedError("authorization_changing");
  }
  return authorization;
}

export interface PublicationResult {
  status: "complete" | "partial" | "no_compatible_tracks" | "waiting_for_apple_authorization";
  manifestId: string;
  volumes: Array<{ index: number; playlistId: string; shareUrl: string; trackCount: number }>;
}

export function publicationTerminalStatus(completeness: PublicationCompleteness): "complete" | "partial" {
  return completeness.omittedCandidateCount > 0 || completeness.unresolvedCoverageCount > 0 ? "partial" : "complete";
}

const PRESERVABLE_PARTIAL_OUTCOMES = new Set<PipelineOutcomeStatus>([
  "partial_frontier_exhausted",
  "partial_evidence_shortfall",
  "partial_catalog_degraded",
  "partial_timed_out",
  "partial_policy_conflict",
]);

type PartialPipelineOutcomeStatus = Exclude<
  PipelineOutcomeStatus,
  "complete" | "no_compatible_tracks" | "waiting_for_owner_authorization" | "cancelled" | "failed_system" | "failed_integrity"
>;

export function publicationPartialOutcomeStatus(input: {
  priorOutcome?: PipelineOutcome | null;
  preflightOmittedCount?: number;
  omittedCandidateCount?: number;
  unresolvedCoverageCount?: number;
  reasonCodes?: readonly string[];
}): PartialPipelineOutcomeStatus {
  const reasons = (input.reasonCodes ?? []).map((reason) => reason.toLowerCase());
  if ((input.preflightOmittedCount ?? 0) > 0
    || reasons.some((reason) => /(?:apple|catalog|storefront|playab|unavailable)/u.test(reason))) {
    return "partial_catalog_degraded";
  }
  const priorStatus = input.priorOutcome?.status;
  if (priorStatus && PRESERVABLE_PARTIAL_OUTCOMES.has(priorStatus)) {
    return priorStatus as PartialPipelineOutcomeStatus;
  }
  if (reasons.some((reason) => /(?:timeout|timed_out|deadline)/u.test(reason))) return "partial_timed_out";
  if (reasons.some((reason) => /(?:policy|hard_constraint|version_conflict)/u.test(reason))) return "partial_policy_conflict";
  if (reasons.some((reason) => /(?:frontier|source_exhaust|zero_yield)/u.test(reason))) return "partial_frontier_exhausted";
  if (reasons.some((reason) => /(?:evidence|scope|unsupported)/u.test(reason))) return "partial_evidence_shortfall";
  if ((input.unresolvedCoverageCount ?? 0) > 0) return "partial_frontier_exhausted";
  if ((input.omittedCandidateCount ?? 0) > 0) return "partial_evidence_shortfall";
  return "partial_evidence_shortfall";
}

export function manifestContentHash(tracks: readonly LockedManifestTrack[]): string {
  const ordered = tracks.map((track, index) => [index, track.candidateId, track.catalogId]);
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

async function appendPublicationCandidateStages(
  repository: PublicationRepository,
  manifest: LockedManifest,
  candidateIds: readonly string[],
  toStage: "published" | "rejected",
  reasonCode: string,
): Promise<void> {
  if (manifest.pipelineVersion !== "catalog_first_v2"
    || !manifest.policyVersion
    || !repository.appendCandidateStageEvents
    || candidateIds.length === 0) return;
  const base = Date.now();
  await repository.appendCandidateStageEvents(
    manifest.runId,
    [...new Set(candidateIds)].map((candidateId, index) => ({
      candidateId,
      fromStage: "manifested" as const,
      toStage,
      reasonCode,
      detail: {
        manifestId: manifest.id,
        revisionId: manifest.revisionId ?? null,
      },
      occurredAt: new Date(base + index).toISOString(),
    })),
    {
      pipelineVersion: manifest.pipelineVersion,
      policyVersion: manifest.policyVersion,
    },
  );
}

interface PublicationPreflight {
  manifest: LockedManifest | null;
  omittedCount: number;
  omittedCandidateIds: string[];
  reasonCodes: string[];
}

function lockedManifestFromRevision(base: LockedManifest, revision: ManifestRevision): LockedManifest {
  return {
    ...base,
    contentHash: revision.contentHash,
    lockedAt: revision.lockedAt ?? revision.createdAt,
    tracks: revision.tracks.map((track) => ({
      position: track.position,
      candidateId: track.candidateId,
      catalogId: track.catalogId,
      artist: track.artist,
      title: track.title,
      recordingFamilyId: track.recordingFamilyId,
      catalogIdentityId: track.catalogIdentityId,
    })),
    pipelineVersion: revision.pipelineVersion,
    policyVersion: revision.policyVersion,
    selectionPlan: revision.selectionPlanSnapshot,
    policySnapshot: revision.policySnapshot,
    outcomeSnapshot: revision.outcomeSnapshot,
    deficitSnapshot: revision.deficitSnapshot,
    revisionId: revision.id,
    revision: revision.revision,
  };
}

async function preflightLockedManifest(
  repository: PublicationRepository,
  client: PublicationAppleClient,
  manifest: LockedManifest,
  storefront: string,
  signal?: AbortSignal,
): Promise<PublicationPreflight> {
  // V1 remains readable while expand/contract rollout drains legacy jobs.
  if (!manifest.pipelineVersion || manifest.pipelineVersion === "legacy_v1") {
    return { manifest, omittedCount: 0, omittedCandidateIds: [], reasonCodes: [] };
  }
  // V2 must fail closed during staggered deploys. Publishing a V2 revision
  // without every preflight capability would silently bypass storefront
  // validation and violate the immutable manifest contract.
  const activeRevisionId = manifest.revisionId;
  const getManifestPreflightTracks = repository.getManifestPreflightTracks?.bind(repository);
  const getManifestPreflightReserveTracks = repository.getManifestPreflightReserveTracks?.bind(repository);
  const createManifestRevision = repository.createManifestRevision?.bind(repository);
  const getManifestRevision = repository.getManifestRevision?.bind(repository);
  const markManifestRevisionStatus = repository.markManifestRevisionStatus?.bind(repository);
  const getCatalogRecordingKeys = client.getCatalogRecordingKeys?.bind(client);
  const missingCapabilities = [
    !activeRevisionId ? "manifest.revisionId" : null,
    !getManifestPreflightTracks ? "repository.getManifestPreflightTracks" : null,
    !getManifestPreflightReserveTracks ? "repository.getManifestPreflightReserveTracks" : null,
    !createManifestRevision ? "repository.createManifestRevision" : null,
    !getManifestRevision ? "repository.getManifestRevision" : null,
    !markManifestRevisionStatus ? "repository.markManifestRevisionStatus" : null,
    !getCatalogRecordingKeys ? "apple.getCatalogRecordingKeys" : null,
  ].filter((value): value is string => value !== null);
  if (missingCapabilities.length > 0) {
    throw new Error(`Pipeline V2 publication preflight is unavailable: ${missingCapabilities.join(", ")}`);
  }
  const tracks = await getManifestPreflightTracks!(manifest.id, activeRevisionId!, storefront);
  const reserveTracks = (await getManifestPreflightReserveTracks!(manifest.id, activeRevisionId!, storefront)) ?? [];
  if (tracks.length === 0) return {
    manifest: null,
    omittedCount: manifest.tracks.length,
    omittedCandidateIds: manifest.tracks.map((track) => track.candidateId),
    reasonCodes: ["preflight_no_tracks"],
  };
  const catalogIds = [...new Set([...tracks, ...reserveTracks].flatMap((track) => [
      track.catalogId,
      ...track.alternates.filter((alternate) => alternate.compatible).map((alternate) => alternate.catalogId),
    ]))];
  const recordingKeys = await getCatalogRecordingKeys!(catalogIds, signal);
  const result = preflightManifestRevision(tracks, new Set(Object.keys(recordingKeys)), reserveTracks);
  if (result.state === "unchanged") return { manifest, omittedCount: 0, omittedCandidateIds: [], reasonCodes: [] };
  if (result.state === "no_compatible_tracks") {
    return {
      manifest: null,
      omittedCount: tracks.length,
      omittedCandidateIds: result.omittedCandidateIds.length > 0
        ? result.omittedCandidateIds
        : tracks.map((track) => track.candidateId),
      reasonCodes: result.reasonCodes,
    };
  }

  const now = new Date().toISOString();
  const nextRevisionNumber = Math.max(1, Number(manifest.revision ?? 0) + 1);
  const revisionId = await createManifestRevision!(manifest.runId, {
    id: "",
    manifestId: manifest.id,
    revision: nextRevisionNumber,
    parentRevisionId: activeRevisionId!,
    status: "locked",
    reason: result.reasonCodes.join(",").slice(0, 500) || "publication_preflight",
    contentHash: result.contentHash,
    pipelineVersion: manifest.pipelineVersion ?? "legacy_v1",
    policyVersion: manifest.policyVersion ?? "legacy_v1",
    selectionPlanSnapshot: manifest.selectionPlan ?? null,
    policySnapshot: manifest.policySnapshot ?? null,
    outcomeSnapshot: manifest.outcomeSnapshot ?? null,
    deficitSnapshot: manifest.deficitSnapshot ?? [],
    lockedAt: now,
    createdAt: now,
    tracks: result.tracks.map((track) => ({
      position: track.position,
      candidateId: track.candidateId,
      recordingFamilyId: track.recordingFamilyId,
      catalogIdentityId: track.catalogIdentityId,
      catalogId: track.catalogId,
      artist: track.artist,
      title: track.title,
    })),
    reserveTracks: result.reserveTracks.map((track) => ({
      position: track.position,
      candidateId: track.candidateId,
      recordingFamilyId: track.recordingFamilyId,
      catalogIdentityId: track.catalogIdentityId,
      catalogId: track.catalogId,
      artist: track.artist,
      title: track.title,
      evidenceEligible: track.evidenceEligible,
      hardConstraintsSatisfied: track.hardConstraintsSatisfied,
      versionCompatible: track.versionCompatible,
      qualified: track.qualified,
    })),
  });
  const persisted = await getManifestRevision!(manifest.runId, revisionId);
  if (!persisted || persisted.status !== "locked" || persisted.contentHash !== result.contentHash) {
    throw new Error("The replacement manifest revision was not durably locked");
  }
  await markManifestRevisionStatus!(manifest.runId, activeRevisionId!, "superseded");
  return {
    manifest: lockedManifestFromRevision(manifest, persisted),
    omittedCount: result.omittedCandidateIds.length,
    omittedCandidateIds: result.omittedCandidateIds,
    reasonCodes: result.reasonCodes,
  };
}

export function exactOrderedPrefix(existing: readonly string[], expected: readonly string[]): boolean {
  if (existing.length > expected.length) return false;
  return existing.every((catalogId, index) => catalogId === expected[index]);
}

export interface PlannedPublicationVolume {
  volumeIndex: number;
  volumeCount: number;
  startPosition: number;
  endPosition: number;
  catalogIds: string[];
}

export function planPublicationVolumes(tracks: readonly LockedManifestTrack[]): PlannedPublicationVolume[] {
  const volumeCount = Math.max(1, Math.ceil(tracks.length / VOLUME_SIZE));
  return Array.from({ length: volumeCount }, (_, volumeIndex) => {
    const startPosition = volumeIndex * VOLUME_SIZE;
    const catalogIds = tracks.slice(startPosition, startPosition + VOLUME_SIZE).map((track) => track.catalogId);
    return {
      volumeIndex,
      volumeCount,
      startPosition,
      endPosition: startPosition + catalogIds.length - 1,
      catalogIds,
    };
  });
}

export function nextPublicationAppendBatch(expected: readonly string[], appendedCount: number): string[] {
  const offset = Math.max(0, Math.min(Math.floor(appendedCount), expected.length));
  return expected.slice(offset, offset + APPEND_BATCH_SIZE);
}

const consistencyWait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error("Publication aborted"));
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error("Publication aborted"));
  }, { once: true });
});

async function observeStablePrefix(
  client: PublicationAppleClient,
  playlistId: string,
  expected: readonly string[],
  signal?: AbortSignal,
  minimumVisibleCount = 0,
): Promise<{ ids: string[]; diverged: boolean }> {
  const requiredVisibleCount = Math.max(0, Math.min(Math.floor(minimumVisibleCount), expected.length));
  let previousCompatible: string[] | null = null;
  let compatibleStableReads = 0;
  let previousDivergent: string[] | null = null;
  let divergentStableReads = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    signal?.throwIfAborted();
    let ids: string[];
    try {
      ids = await client.getOrderedPlaylistCatalogIds(playlistId, signal);
    } catch (error) {
      if (error instanceof AppleApiError && error.status === 404 && attempt < 5) {
        await consistencyWait(CONSISTENCY_POLL_MS, signal);
        continue;
      }
      throw error;
    }
    let compatible = exactOrderedPrefix(ids, expected);
    if (!compatible && client.getCatalogRecordingKeys && ids.length <= expected.length) {
      const expectedPrefix = expected.slice(0, ids.length);
      const keys = await client.getCatalogRecordingKeys([...ids, ...expectedPrefix], signal);
      compatible = ids.every((catalogId, index) => {
        const observedKey = keys[catalogId];
        const expectedKey = keys[expectedPrefix[index]!];
        return Boolean(observedKey && expectedKey && observedKey === expectedKey);
      });
    }

    if (compatible) {
      divergentStableReads = 0;
      previousDivergent = null;
      if (previousCompatible && ids.length === previousCompatible.length
        && ids.every((id, index) => id === previousCompatible![index])) compatibleStableReads += 1;
      else compatibleStableReads = 1;
      previousCompatible = ids;
      if (ids.length === expected.length
        || (requiredVisibleCount > 0 && ids.length >= requiredVisibleCount)
        || (ids.length >= requiredVisibleCount && compatibleStableReads >= 3)) {
        return { ids, diverged: false };
      }
    } else {
      compatibleStableReads = 0;
      previousCompatible = null;
      if (previousDivergent && ids.length === previousDivergent.length
        && ids.every((id, index) => id === previousDivergent![index])) divergentStableReads += 1;
      else divergentStableReads = 1;
      previousDivergent = ids;
      if (divergentStableReads >= 3) return { ids, diverged: true };
    }
    await consistencyWait(CONSISTENCY_POLL_MS, signal);
  }
  throw new AppleApiError(
    requiredVisibleCount > 0
      ? "Apple playlist did not expose the submitted prefix before reconciliation timed out"
      : "Apple playlist reads did not become stable",
    null,
    true,
    false,
  );
}

function volumeName(manifest: LockedManifest, index: number, count: number): string {
  return count === 1 ? manifest.name : appendPlaylistTitleSuffix(manifest.name, `[${index + 1}/${count}]`);
}

function volumeMarker(volume: PublicationVolume): string {
  return `gênio publication ${volume.id}:${volume.attempt}`;
}

function previousVolumeMarker(volume: PublicationVolume): string {
  return `9ênio publication ${volume.id}:${volume.attempt}`;
}

function legacyVolumeMarker(volume: PublicationVolume): string {
  return `Needle publication ${volume.id}:${volume.attempt}`;
}

async function findPlaylistForVolume(
  client: PublicationAppleClient,
  volume: PublicationVolume,
  signal?: AbortSignal,
): Promise<any | null> {
  for (const marker of [volumeMarker(volume), previousVolumeMarker(volume), legacyVolumeMarker(volume)]) {
    const recovered = await client.findLibraryPlaylistByMarker(marker, signal);
    if (recovered?.id) return recovered;
  }
  return null;
}

function volumeDescription(manifest: LockedManifest, marker: string): string {
  const room = Math.max(0, 980 - marker.length);
  return `${manifest.description.slice(0, room)}\n\n${marker}`;
}

function normalizeVolume(raw: any, manifest: LockedManifest): PublicationVolume {
  const volumeNumber = Number(raw.volumeNumber ?? raw.volume_number ?? 1);
  const volumeCount = Number(raw.volumeCount ?? raw.volume_count ?? 1);
  const index = Math.max(0, volumeNumber - 1);
  return {
    id: String(raw.id),
    manifestId: manifest.id,
    manifestRevisionId: raw.manifestRevisionId ?? raw.manifest_revision_id ?? null,
    runId: manifest.runId,
    volumeIndex: index,
    volumeCount,
    attempt: Number(raw.attempt ?? 0),
    name: volumeName(manifest, index, volumeCount),
    description: manifest.description,
    playlistId: raw.applePlaylistId ?? raw.apple_playlist_id ?? null,
    shareUrl: raw.appleShareUrl ?? raw.apple_share_url ?? null,
    appendedCount: Number(raw.appendedCount ?? raw.appended_count ?? 0),
    startPosition: Number(raw.startPosition ?? raw.start_position ?? index * VOLUME_SIZE),
    endPosition: Number(raw.endPosition ?? raw.end_position ?? -1),
    status: normalizePublicationStatus(raw.status),
  };
}

function normalizePublicationStatus(value: unknown): PublicationStatus {
  if (value === "pending") return "queued";
  if (value === "publishing") return "appending";
  if (["queued", "creating", "appending", "waiting_for_share_url", "complete", "orphaned", "waiting_for_owner", "failed"].includes(String(value))) {
    return value as PublicationStatus;
  }
  return "queued";
}

async function loadVolumes(
  repository: PublicationRepository,
  manifest: LockedManifest,
  manifestRevisionId?: string | null,
): Promise<PublicationVolume[]> {
  return (await repository.listPublicationVolumes(manifest.id, manifestRevisionId))
    .map((row) => normalizeVolume(row, manifest));
}

async function retirePublicationVolume(
  repository: PublicationRepository,
  manifest: LockedManifest,
  volume: PublicationVolume,
  reason: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const orphanId = await repository.retirePublicationVolume({
    manifestId: manifest.id,
    publicationVolumeId: volume.id,
    applePlaylistId: volume.playlistId,
    reason,
  });
  // A null result means another publisher already retired this row while this
  // worker was refreshing its view. Treat that as successful reconciliation.
  if (orphanId && volume.playlistId) {
    await repository.enqueueNotification("publication_orphaned", {
      deduplicationKey: `publication-revision-retired:${volume.id}:${manifest.revisionId ?? "legacy"}`,
      orphanId,
      runId: manifest.runId,
      manifestId: manifest.id,
      publicationVolumeId: volume.id,
      applePlaylistId: volume.playlistId,
      reasonCode: "manifest_revision_retired",
    });
  }
}

function publicationConflictCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function volumeMatchesPlan(
  volume: PublicationVolume,
  planned: PlannedPublicationVolume,
  manifestRevisionId: string | null,
): boolean {
  return volume.volumeIndex === planned.volumeIndex
    && volume.manifestRevisionId === manifestRevisionId
    && volume.volumeCount === planned.volumeCount
    && volume.startPosition === planned.startPosition
    && volume.endPosition === planned.endPosition;
}

async function persistPlannedPublicationVolume(
  repository: PublicationRepository,
  manifest: LockedManifest,
  planned: PlannedPublicationVolume,
  manifestRevisionId: string | null,
  signal?: AbortSignal,
): Promise<PublicationVolume> {
  let conflict: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal?.throwIfAborted();
    try {
      await repository.createPublicationVolume({
        manifestId: manifest.id,
        manifestRevisionId,
        volumeNumber: planned.volumeIndex + 1,
        volumeCount: planned.volumeCount,
        startPosition: planned.startPosition,
        endPosition: planned.endPosition,
        status: "queued",
      });
    } catch (error) {
      if (publicationConflictCode(error) !== "publication_revision_conflict") throw error;
      conflict = error;
    }

    const refreshed = await loadVolumes(repository, manifest);
    const exact = refreshed.find((volume) => volumeMatchesPlan(volume, planned, manifestRevisionId));
    if (exact) return exact;
    const occupying = refreshed.find((volume) => volume.volumeIndex === planned.volumeIndex);
    if (occupying) {
      await repository.hidePublicPlaylistsForRun(manifest.runId);
      await retirePublicationVolume(
        repository,
        manifest,
        occupying,
        "Publication volume conflicted with the active immutable manifest revision",
        signal,
      );
    }
  }
  if (conflict instanceof Error) throw conflict;
  throw new Error(`Publication volume ${planned.volumeIndex + 1} could not be reconciled`);
}

async function getOrCreateVolumes(
  repository: PublicationRepository,
  manifest: LockedManifest,
  plan: readonly PlannedPublicationVolume[],
  signal?: AbortSignal,
): Promise<PublicationVolume[]> {
  const isV2 = Boolean(manifest.pipelineVersion && manifest.pipelineVersion !== "legacy_v1");
  if (isV2 && !manifest.revisionId) {
    throw new Error("Pipeline V2 publication requires an immutable manifest revision ID");
  }
  const activeRevisionId = isV2 ? manifest.revisionId! : null;
  const plannedByIndex = new Map(plan.map((volume) => [volume.volumeIndex, volume]));
  const existing = await loadVolumes(repository, manifest);
  const obsolete = existing.filter((volume) => {
    const planned = plannedByIndex.get(volume.volumeIndex);
    const revisionMatches = volume.manifestRevisionId === activeRevisionId;
    const rangeMatches = Boolean(planned)
      && volume.volumeCount === planned!.volumeCount
      && volume.startPosition === planned!.startPosition
      && volume.endPosition === planned!.endPosition;
    return !(revisionMatches && rangeMatches);
  });
  if (obsolete.length > 0) await repository.hidePublicPlaylistsForRun(manifest.runId);
  for (const volume of obsolete) {
    const revisionMatches = volume.manifestRevisionId === activeRevisionId;
    await retirePublicationVolume(
      repository,
      manifest,
      volume,
      revisionMatches
        ? "Publication volume is outside the immutable manifest revision plan"
        : "Publication volume belongs to a superseded manifest revision",
      signal,
    );
  }

  const current = await loadVolumes(repository, manifest, activeRevisionId);
  const byIndex = new Map(current.map((volume) => [volume.volumeIndex, volume]));
  const result: PublicationVolume[] = [];
  for (const planned of plan) {
    signal?.throwIfAborted();
    let volume = byIndex.get(planned.volumeIndex);
    if (!volume) {
      volume = await persistPlannedPublicationVolume(
        repository,
        manifest,
        planned,
        activeRevisionId,
        signal,
      );
    }
    result.push(volume);
  }
  return result.sort((a, b) => a.volumeIndex - b.volumeIndex);
}

async function ensureApplePlaylist(
  repository: PublicationRepository,
  client: PublicationAppleClient,
  manifest: LockedManifest,
  volume: PublicationVolume,
  expectedAuthorization: AuthorizationIdentity,
  signal?: AbortSignal,
): Promise<PublicationVolume> {
  await assertPublicationControl(repository, expectedAuthorization, signal, manifest.runId);
  if (volume.playlistId) return volume;
  const marker = volumeMarker(volume);
  const recovered = await findPlaylistForVolume(client, volume, signal);
  if (recovered?.id) {
    const playlistId = String(recovered.id);
    signal?.throwIfAborted();
    await repository.updatePublicationVolume(volume.id, { applePlaylistId: playlistId, status: "appending" });
    return { ...volume, playlistId, status: "appending" };
  }

  const description = volumeDescription(manifest, marker);
  try {
    await assertPublicationControl(repository, expectedAuthorization, signal, manifest.runId);
    const created = await client.createLibraryPlaylist(volume.name, description, signal);
    signal?.throwIfAborted();
    await repository.updatePublicationVolume(volume.id, {
      applePlaylistId: created.id,
      appleShareUrl: created.url,
      status: "appending",
    });
    return { ...volume, playlistId: created.id, shareUrl: created.url, description, status: "appending" };
  } catch (error) {
    if (error instanceof AppleApiError && error.uncertainMutation) {
      const afterFailure = await findPlaylistForVolume(client, volume, signal);
      if (afterFailure?.id) {
        const playlistId = String(afterFailure.id);
        signal?.throwIfAborted();
        await repository.updatePublicationVolume(volume.id, { applePlaylistId: playlistId, status: "appending" });
        return { ...volume, playlistId, description, status: "appending" };
      }
    }
    throw error;
  }
}

async function abandonDivergedPlaylist(
  repository: PublicationRepository,
  volume: PublicationVolume,
  observedIds: readonly string[],
  expectedIds: readonly string[],
  signal?: AbortSignal,
): Promise<PublicationVolume> {
  const mismatchIndex = observedIds.findIndex((catalogId, index) => catalogId !== expectedIds[index]);
  const position = mismatchIndex >= 0 ? mismatchIndex : Math.min(observedIds.length, expectedIds.length);
  const safeId = (value: string | undefined) => /^[A-Za-z0-9._-]{1,200}$/u.test(value ?? "") ? value : "missing";
  const reason = `Apple playlist catalog mismatch at position ${position + 1}: expected ${safeId(expectedIds[position])}, observed ${safeId(observedIds[position])} (observed ${observedIds.length} tracks)`;
  process.stderr.write(`[needle-worker] ${reason}\n`);
  return abandonPlaylist(repository, volume,
    reason,
    signal);
}

async function abandonPlaylist(
  repository: PublicationRepository,
  volume: PublicationVolume,
  reason: string,
  signal?: AbortSignal,
): Promise<PublicationVolume> {
  signal?.throwIfAborted();
  if (!volume.playlistId) throw new Error("Cannot orphan a publication without an Apple playlist ID");
  const orphanId = await repository.markPlaylistOrphan({
    manifestId: volume.manifestId,
    publicationVolumeId: volume.id,
    applePlaylistId: volume.playlistId,
    reason,
  });
  await repository.enqueueNotification("publication_orphaned", {
    deduplicationKey: `publication-orphaned:${volume.playlistId}`,
    orphanId,
    runId: volume.runId,
    manifestId: volume.manifestId,
    publicationVolumeId: volume.id,
    applePlaylistId: volume.playlistId,
  });
  signal?.throwIfAborted();
  const attempt = volume.attempt + 1;
  if (attempt > MAX_REPLACEMENTS) throw new Error(`Publication volume ${volume.volumeIndex + 1} diverged too many times`);
  await repository.updatePublicationVolume(volume.id, {
    attemptDelta: 1,
    applePlaylistId: null,
    appleShareUrl: null,
    appendedCount: 0,
    status: "queued",
  });
  return { ...volume, attempt, playlistId: null, shareUrl: null, appendedCount: 0, status: "queued" };
}

export async function appendExactVolume(
  repository: PublicationRepository,
  client: PublicationAppleClient,
  manifest: LockedManifest,
  originalVolume: PublicationVolume,
  expected: readonly string[],
  expectedAuthorization: AuthorizationIdentity,
  signal?: AbortSignal,
): Promise<PublicationVolume> {
  let volume = originalVolume;

  for (;;) {
    await assertPublicationControl(repository, expectedAuthorization, signal, manifest.runId);
    volume = await ensureApplePlaylist(repository, client, manifest, volume, expectedAuthorization, signal);
    const playlistId = volume.playlistId!;
    let submittedCount = Math.max(0, Math.min(Math.floor(volume.appendedCount), expected.length));
    let initial: { ids: string[]; diverged: boolean };
    try {
      initial = await observeStablePrefix(client, playlistId, expected, signal, submittedCount);
    } catch (error) {
      if (error instanceof AppleApiError && error.status === 404) {
        volume = await abandonPlaylist(
          repository,
          volume,
          "Apple no longer returned the stored library playlist resource",
          signal,
        );
        continue;
      }
      throw error;
    }
    let visible = initial.ids;
    if (initial.diverged) {
      volume = await abandonDivergedPlaylist(repository, volume, initial.ids, expected, signal);
      continue;
    }

    const advanceSubmittedCount = async (nextCount: number): Promise<void> => {
      const boundedCount = Math.max(0, Math.min(Math.floor(nextCount), expected.length));
      if (boundedCount <= submittedCount) return;
      await repository.updatePublicationVolume(volume.id, { appendedCount: boundedCount, status: "appending" });
      submittedCount = boundedCount;
      volume = { ...volume, appendedCount: boundedCount, status: "appending" };
    };
    await advanceSubmittedCount(visible.length);

    let stalledAttempts = 0;
    while (submittedCount < expected.length) {
      await assertPublicationControl(repository, expectedAuthorization, signal, manifest.runId);
      const batch = nextPublicationAppendBatch(expected, submittedCount);
      try {
        await client.appendCatalogTracks(playlistId, batch, signal);
        await advanceSubmittedCount(submittedCount + batch.length);
        stalledAttempts = 0;
      } catch (error) {
        if (error instanceof AppleAuthorizationRequiredError) throw error;

        // A mutation failure marked uncertain can occur after Apple accepted
        // the write. Do not reconcile it against the old high-water mark: that
        // would make a lagging GET look safe to retry and could duplicate the
        // whole batch.
        // Require the complete attempted prefix instead. If Apple cannot prove
        // that outcome within the bounded read window, abandon this playlist
        // and retry only on a clean replacement resource.
        if (error instanceof AppleApiError && error.uncertainMutation) {
          const targetCount = Math.min(submittedCount + batch.length, expected.length);
          let observation: { ids: string[]; diverged: boolean };
          try {
            observation = await observeStablePrefix(client, playlistId, expected, signal, targetCount);
          } catch (reconciliationError) {
            if (reconciliationError instanceof AppleAuthorizationRequiredError) throw reconciliationError;
            signal?.throwIfAborted();
            volume = await abandonPlaylist(
              repository,
              volume,
              "Apple append outcome remained uncertain after bounded reconciliation",
              signal,
            );
            break;
          }
          visible = observation.ids;
          if (observation.diverged) {
            volume = await abandonDivergedPlaylist(repository, volume, visible, expected, signal);
            break;
          }
          await advanceSubmittedCount(visible.length);
          stalledAttempts = 0;
          continue;
        }

        const observation = await observeStablePrefix(client, playlistId, expected, signal, submittedCount);
        const reconciled = observation.ids;
        if (observation.diverged) {
          volume = await abandonDivergedPlaylist(repository, volume, reconciled, expected, signal);
          break;
        }
        visible = reconciled;
        if (visible.length > submittedCount) {
          await advanceSubmittedCount(visible.length);
          stalledAttempts = 0;
          continue;
        }
        if (error instanceof AppleApiError && error.retriable && error.status !== null) {
          stalledAttempts += 1;
          if (stalledAttempts < 3) continue;
        }
        throw error;
      }

      const observation = await observeStablePrefix(client, playlistId, expected, signal, submittedCount);
      visible = observation.ids;
      if (observation.diverged) {
        volume = await abandonDivergedPlaylist(repository, volume, visible, expected, signal);
        break;
      }
      await advanceSubmittedCount(visible.length);
    }

    if (volume.playlistId !== playlistId) continue;
    if (visible.length < submittedCount || visible.length < expected.length) {
      throw new AppleApiError("Apple playlist did not expose the submitted prefix before reconciliation timed out", null, true, false);
    }
    await assertPublicationControl(repository, expectedAuthorization, signal, manifest.runId);
    let shareUrl: string;
    try {
      shareUrl = await client.pollStableShareUrl(playlistId, sharePollAttempts(), SHARE_POLL_MS, signal);
    } catch (error) {
      await repository.updatePublicationVolume(volume.id, {
        appendedCount: submittedCount,
        status: "waiting_for_share_url",
        lastError: error instanceof Error ? error.message : "Apple did not expose a stable share link",
      });
      throw error;
    }
    signal?.throwIfAborted();
    await repository.updatePublicationVolume(volume.id, {
      appendedCount: submittedCount,
      appleShareUrl: shareUrl,
      status: "complete",
      lastError: null,
      publishedAt: new Date(),
    });
    return { ...volume, appendedCount: submittedCount, shareUrl, status: "complete" };
  }
}

export async function publishManifest(
  repository: PublicationRepository,
  manifestId: string,
  signal?: AbortSignal,
): Promise<PublicationResult> {
  signal?.throwIfAborted();
  const lockedManifest = await repository.getManifestById(manifestId);
  if (!lockedManifest) throw new Error("Approved playlist manifest was not found");
  if (!lockedManifest.lockedAt || !lockedManifest.contentHash) throw new Error("Only an immutable locked manifest can be published");
  if (manifestContentHash(lockedManifest.tracks) !== lockedManifest.contentHash) throw new Error("Manifest content hash does not match its ordered tracks");
  if (lockedManifest.tracks.length === 0) throw new Error("A zero-track manifest cannot be published");
  if (lockedManifest.tracks.some((track) => !track.catalogId)) throw new Error("Manifest contains a track without an Apple catalog ID");
  const priorPipelineOutcome = repository.getPipelineOutcome
    ? await repository.getPipelineOutcome(lockedManifest.runId)
    : null;

  let activeAuthorization: AuthorizationIdentity | null = null;
  let manifest = lockedManifest;
  let preflightOmittedCount = 0;
  let preflightReasonCodes: string[] = [];
  try {
    await assertPublicationControl(repository, undefined, signal, manifest.runId);
    const { client, authorization } = await authorizedAppleClient(repository);
    activeAuthorization = authorization;
    await assertPublicationControl(repository, authorization, signal, manifest.runId);
    const preflight = await preflightLockedManifest(repository, client, manifest, authorization.storefront, signal);
    preflightOmittedCount = preflight.omittedCount;
    preflightReasonCodes = preflight.reasonCodes;
    if (!preflight.manifest) {
      await appendPublicationCandidateStages(
        repository,
        manifest,
        preflight.omittedCandidateIds,
        "rejected",
        "publication_preflight_no_compatible_identity",
      );
      const target = manifest.selectionPlan?.requestedTrackCount ?? manifest.tracks.length;
      const priorVolumes = await loadVolumes(repository, manifest);
      if (priorVolumes.length > 0) {
        await repository.hidePublicPlaylistsForRun(manifest.runId);
        for (const volume of priorVolumes) {
          await retirePublicationVolume(
            repository,
            manifest,
            volume,
            "The active manifest revision has no compatible storefront tracks",
            signal,
          );
        }
      }
      if (manifest.revisionId && repository.markManifestRevisionStatus) {
        await repository.markManifestRevisionStatus(manifest.runId, manifest.revisionId, "abandoned");
      }
      await repository.updateRun(manifest.runId, {
        status: "partial",
        phase: "no_compatible_tracks",
        error: null,
      });
      if (repository.savePipelineOutcome) {
        const stageCounts = manifest.pipelineVersion === "catalog_first_v2"
          && repository.getPipelineStageCounts
          ? await repository.getPipelineStageCounts(manifest.runId)
          : undefined;
        const discoveredTrackCount = stageCounts?.discovered ?? Math.max(
          manifest.tracks.length,
          priorPipelineOutcome?.discoveredTrackCount ?? 0,
        );
        const qualifiedTrackCount = stageCounts?.claim_verified ?? Math.max(
          manifest.tracks.length,
          Math.min(discoveredTrackCount, priorPipelineOutcome?.qualifiedTrackCount ?? 0),
        );
        await repository.savePipelineOutcome(manifest.runId, buildPipelineOutcome({
          pipelineVersion: manifest.pipelineVersion ?? "legacy_v1",
          policyVersion: manifest.policyVersion ?? "legacy_v1",
          status: "no_compatible_tracks",
          targetTrackCount: target,
          discoveredTrackCount,
          qualifiedTrackCount,
          selectedTrackCount: stageCounts?.manifested ?? Math.max(
            manifest.tracks.length,
            Math.min(qualifiedTrackCount, priorPipelineOutcome?.selectedTrackCount ?? 0),
          ),
          publishedTrackCount: 0,
          frontierExhausted: true,
          reasonCodes: preflightReasonCodes.length > 0 ? preflightReasonCodes : ["preflight_no_compatible_tracks"],
          stageCounts,
        }));
      }
      return { status: "no_compatible_tracks", manifestId, volumes: [] };
    }
    manifest = preflight.manifest;
    await appendPublicationCandidateStages(
      repository,
      manifest,
      preflight.omittedCandidateIds,
      "rejected",
      "publication_preflight_catalog_identity_omitted",
    );
    if (manifestContentHash(manifest.tracks) !== manifest.contentHash) {
      throw new Error("Locked manifest revision content hash does not match its ordered tracks");
    }
    await repository.updateRun(manifest.runId, { status: "publishing", phase: "apple_publication", error: null });
    const plan = planPublicationVolumes(manifest.tracks);
    const volumes = await getOrCreateVolumes(repository, manifest, plan, signal);
    const completed: PublicationVolume[] = [];
    for (const volume of volumes) {
      await assertPublicationControl(repository, authorization, signal, manifest.runId);
      const expected = plan[volume.volumeIndex]?.catalogIds;
      if (!expected) throw new Error(`Publication volume ${volume.volumeIndex + 1} is outside the immutable manifest plan`);
      completed.push(await appendExactVolume(repository, client, manifest, volume, expected, authorization, signal));
    }
    await assertPublicationControl(repository, authorization, signal, manifest.runId);
    await appendPublicationCandidateStages(
      repository,
      manifest,
      manifest.tracks.map((track) => track.candidateId),
      "published",
      "apple_publication_membership_verified",
    );
    const durableStageCounts = manifest.pipelineVersion === "catalog_first_v2"
      && repository.getPipelineStageCounts
      ? await repository.getPipelineStageCounts(manifest.runId)
      : undefined;
    const storedCompleteness = await repository.getPublicationCompleteness(manifest.runId, manifest.id);
    const completeness = {
      omittedCandidateCount: storedCompleteness.omittedCandidateCount + preflightOmittedCount,
      unresolvedCoverageCount: storedCompleteness.unresolvedCoverageCount,
    };
    const terminalStatus = publicationTerminalStatus(completeness);
    await repository.updateRun(manifest.runId, {
      status: terminalStatus,
      phase: terminalStatus === "partial" ? "published_partial" : "published",
      error: null,
    });
    signal?.throwIfAborted();
    await repository.enqueueNotification("publication_complete", {
      deduplicationKey: `publication-complete:${manifest.id}`,
      manifestId: manifest.id,
      runId: manifest.runId,
      volumeCount: completed.length,
      status: terminalStatus,
      omittedCandidateCount: completeness.omittedCandidateCount,
      unresolvedCoverageCount: completeness.unresolvedCoverageCount,
    });
    let finalPipelineOutcome: PipelineOutcome | null = null;
    if (repository.savePipelineOutcome || repository.sealManifestRevisionPublication) {
      const target = manifest.selectionPlan?.requestedTrackCount
        ?? manifest.tracks.length + completeness.omittedCandidateCount;
      const reasonCodes = [
        ...(priorPipelineOutcome?.reasonCodes ?? []),
        ...preflightReasonCodes,
        ...(completeness.unresolvedCoverageCount > 0 ? ["source_frontier_unresolved"] : []),
        ...(completeness.omittedCandidateCount > preflightOmittedCount ? ["evidence_eligible_count_shortfall"] : []),
        ...(terminalStatus === "partial" ? ["publication_completed_below_target"] : []),
      ];
      const discoveredTrackCount = durableStageCounts?.discovered ?? Math.max(
        manifest.tracks.length + completeness.omittedCandidateCount,
        priorPipelineOutcome?.discoveredTrackCount ?? 0,
      );
      const qualifiedTrackCount = durableStageCounts?.claim_verified ?? Math.max(
        manifest.tracks.length + preflightOmittedCount,
        Math.min(discoveredTrackCount, priorPipelineOutcome?.qualifiedTrackCount ?? 0),
      );
      const selectedTrackCount = durableStageCounts?.manifested
        ?? durableStageCounts?.sequenced
        ?? Math.max(
          manifest.tracks.length + preflightOmittedCount,
          Math.min(qualifiedTrackCount, priorPipelineOutcome?.selectedTrackCount ?? 0),
        );
      const publishedTrackCount = durableStageCounts?.published ?? manifest.tracks.length;
      const partialStatus = publicationPartialOutcomeStatus({
        priorOutcome: priorPipelineOutcome,
        preflightOmittedCount,
        omittedCandidateCount: completeness.omittedCandidateCount,
        unresolvedCoverageCount: completeness.unresolvedCoverageCount,
        reasonCodes,
      });
      finalPipelineOutcome = buildPipelineOutcome({
        pipelineVersion: manifest.pipelineVersion ?? "legacy_v1",
        policyVersion: manifest.policyVersion ?? "legacy_v1",
        status: terminalStatus === "complete" ? "complete" : partialStatus,
        targetTrackCount: target,
        discoveredTrackCount,
        qualifiedTrackCount,
        selectedTrackCount,
        publishedTrackCount,
        frontierExhausted: partialStatus === "partial_frontier_exhausted"
          || priorPipelineOutcome?.frontierExhausted === true,
        providerUnavailable: priorPipelineOutcome?.providerUnavailable === true,
        reasonCodes: terminalStatus === "partial" ? reasonCodes : [],
        stageCounts: durableStageCounts,
      });
    }
    if (manifest.pipelineVersion !== "legacy_v1"
      && manifest.revisionId
      && finalPipelineOutcome
      && repository.sealManifestRevisionPublication) {
      await repository.sealManifestRevisionPublication(manifest.runId, manifest.revisionId, finalPipelineOutcome);
    } else {
      if (finalPipelineOutcome && repository.savePipelineOutcome) {
        await repository.savePipelineOutcome(manifest.runId, finalPipelineOutcome);
      }
      if (manifest.revisionId && repository.markManifestRevisionStatus) {
        await repository.markManifestRevisionStatus(manifest.runId, manifest.revisionId, "published");
      }
    }
    return {
      status: terminalStatus,
      manifestId,
      volumes: completed.map((volume, index) => ({
        index,
        playlistId: volume.playlistId!,
        shareUrl: volume.shareUrl!,
        trackCount: Math.min(VOLUME_SIZE, Math.max(0, manifest.tracks.length - index * VOLUME_SIZE)),
      })),
    };
  } catch (error) {
    if (error instanceof AppleAuthorizationRequiredError) {
      if (activeAuthorization) {
        const currentAuthorization = await repository.getAppleAuthorization();
        if (currentAuthorization && (
          currentAuthorization.ciphertext !== activeAuthorization.ciphertext
          || currentAuthorization.keyVersion !== activeAuthorization.keyVersion
        )) {
          throw new PublicationPausedError("authorization_changing");
        }
      }
      await repository.updateAppleAuthorizationStatus("reauthorization_required", error.message);
      await repository.updateRun(manifest.runId, {
        status: "waiting_for_apple_authorization",
        phase: "apple_reauthorization",
        error: null,
      });
      for (const volume of await loadVolumes(repository, manifest)) {
        if (volume.status !== "complete") {
          await repository.updatePublicationVolume(volume.id, { status: "waiting_for_owner" });
        }
      }
      await repository.enqueueNotification("apple_reauthorization_required", {
        deduplicationKey: `apple-reauthorization:${manifest.id}`,
        manifestId: manifest.id,
        runId: manifest.runId,
      });
      return { status: "waiting_for_apple_authorization", manifestId, volumes: [] };
    }
    throw error;
  }
}

export async function processPublicationJob(repository: PublicationRepository, payload: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
  const manifestId = typeof payload.manifestId === "string" ? payload.manifestId : "";
  if (!manifestId) throw new Error("Publication job payload is invalid");
  await publishManifest(repository, manifestId, signal);
}
