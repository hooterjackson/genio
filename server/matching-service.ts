import { createHash, randomUUID } from "node:crypto";
import type {
  AlternateCatalogIdentity,
  CandidateStage,
  CandidateStageEvent,
  CatalogDiscoveredCandidateInput,
  CatalogDiscoveredCandidateResult,
  CatalogMatchResult,
  CatalogSong,
  EvidenceClaimInput,
  PipelineDeficitLedgerEntry,
  PipelineOutcome,
  PipelinePolicySnapshot,
  PipelinePolicyVersion,
  PipelineVersion,
  PlaylistBrief,
  RecordingFamily,
  SelectionConstraint,
  SelectionPlan,
  TrackScopeBinding,
  TrackCandidateInput,
} from "../shared/types.ts";
import {
  AppleApiError,
  AppleAuthorizationRequiredError,
  lookupAppleCatalogByIsrc,
  searchAppleCatalog,
  type AppleCatalogPlaylist,
} from "./apple.ts";
import {
  hasDirectCatalogMatch,
  mergeCatalogSongs,
  normalizeMusicBaseTitle,
  normalizeMusicText,
  rankCatalogMatches,
} from "../lib/matching.ts";
import { resolveEvidenceSubjectBinding } from "./evidence-binding.ts";
import { requiresFactualFrontier } from "./factual-frontier-policy.ts";
import {
  isRetryableCatalogMatch,
  RETRYABLE_CATALOG_MATCH_BASES,
} from "./catalog-match-recovery.ts";
import {
  createFastRouteCheckpoint,
  fastArtistDiversityRefillPlan,
  fastPostMatchRefillPlan,
  FAST_MATCHING_FINALIZATION_RESERVE_MS,
  FAST_POST_MATCH_REFILL_LIMIT,
  parseFastPostMatchRefillRouteCheckpoint,
  parseFastRouteCheckpoint,
  researchExecutionPolicyForRun,
  storefrontForRun,
} from "./research-policy.ts";
import {
  desiredPlaylistArtistCount,
  playlistArtistKey,
} from "../lib/playlist-selection.ts";
import {
  buildPipelineOutcome,
  catalogDiscoveryOutcomeDisposition,
} from "./pipeline-outcome-v2.ts";
import {
  catalogContentRating,
  catalogRecordingVersionClass,
  catalogRecordingVersionSignature,
  classifyTrackScopeBindingEvidence,
  recordingFamilyKey,
  scopeBindingEligible,
  trackScopeBindingStrength,
} from "./pipeline-v2-policy.ts";
import {
  CATALOG_DISCOVERY_PROGRESS_VERSION,
  catalogDiscoverySizePolicy,
  discoverCuratedAppleCatalog,
  liveAppleCatalogDiscoveryProvider,
  type CatalogDiscoveryProgressSnapshot,
  type CatalogDiscoveryProvider,
  type CuratedCatalogDiscoveryRequest,
  type CuratedCatalogDiscoveryResult,
} from "./catalog-discovery-v2.ts";
import { pipelineV2Route } from "./selection-plan-v2.ts";
import { recordingFamilySatisfiesEraConstraint } from "./selection-era-policy.ts";
import { partitionUniqueRecordingFamilies } from "./recording-family-selection.ts";
import {
  proofSupportsSelectionGeography,
  selectionGeographyBindingsSatisfied,
} from "./selection-geography-policy.ts";
import {
  createCachedCatalogDiscoveryProvider,
  type AppleCatalogCacheRepository,
} from "./apple-catalog-cache.ts";
import {
  enrichMusicBrainzIdentity,
  type MusicBrainzIdentityEnrichment,
  type MusicBrainzEnrichmentRepository,
} from "./musicbrainz-enrichment-v2.ts";

interface Candidate extends TrackCandidateInput {
  id: string;
  evidence: EvidenceClaimInput[];
  duplicateClusterKey?: string | null;
}

interface ExistingMatch {
  candidateId: string;
  status: CatalogMatchResult["status"];
  basis: string;
  song: CatalogMatchResult["song"];
  alternatives?: CatalogSong[];
}

interface MatchingCheckpoint {
  nextIndex: number;
  storefront: string;
  complete: boolean;
  deadlineAt?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

interface MatchingOutcomeCheckpoint {
  storefront: string;
  targetMinimum: number | null;
  safePrimaryCount: number;
  shortfall: number;
  desiredArtistCount: number;
  representedArtistCount: number;
  artistShortfall: number;
  status: "complete" | "shortfall";
  updatedAt: string;
}

type AutomaticCatalogRecoveryState = "queued" | "in_flight" | "not_needed" | "exhausted";
type AutomaticCandidateRefillState = "queued" | "in_flight" | "not_needed" | "exhausted";

export interface MatchingRepository extends Partial<AppleCatalogCacheRepository>, MusicBrainzEnrichmentRepository {
  getRun(runId: string): Promise<{
    brief: PlaylistBrief;
    status: string;
    phase?: string;
    autoPublish?: boolean;
    createdAt?: string;
    pipelineVersion?: PipelineVersion;
    policyVersion?: PipelinePolicyVersion;
    selectionPlan?: SelectionPlan | null;
    pipelinePolicySnapshot?: PipelinePolicySnapshot | null;
  }>;
  updateRun(runId: string, patch: { status?: string; phase?: string; error?: string | null }): Promise<void>;
  listCandidates(runId: string): Promise<Candidate[]>;
  listMatches(runId: string): Promise<ExistingMatch[]>;
  saveMatch(runId: string, match: CatalogMatchResult): Promise<void>;
  saveTimeoutMatches(runId: string, candidateIds: string[], basis: string): Promise<void>;
  getResearchCheckpoint(runId: string, phase: string): Promise<unknown | null>;
  saveResearchCheckpoint(runId: string, phase: string, checkpoint: unknown): Promise<void>;
  queueAutomaticCatalogRecovery(
    runId: string,
    storefront: string,
    currentGeneration: number,
    currentRefillGeneration?: number,
  ): Promise<AutomaticCatalogRecoveryState>;
  queueAutomaticCandidateRefill(
    runId: string,
    storefront: string,
    additionalCandidateGoal: number,
    currentRefillGeneration: number,
    diversity?: { desiredArtistCount: number; representedArtists: string[] },
  ): Promise<AutomaticCandidateRefillState>;
  queueAutomaticPublication(runId: string): Promise<void>;
  savePipelineOutcome?(runId: string, outcome: PipelineOutcome): Promise<void>;
  getPipelineStageCounts?(runId: string): Promise<import("./pipeline-v2-observability.ts").PipelineStageCounts>;
  upsertRecordingFamily?(
    runId: string,
    input: Pick<
      RecordingFamily,
      "familyKey" | "canonicalArtist" | "canonicalTitle" | "versionClass" | "metadata" | "pipelineVersion" | "policyVersion"
    > & { id?: string },
  ): Promise<string>;
  attachCandidateToRecordingFamily?(
    runId: string,
    recordingFamilyId: string,
    candidateId: string,
    relationship?: string,
  ): Promise<void>;
  upsertAlternateCatalogIdentity?(runId: string, input: AlternateCatalogIdentity): Promise<string>;
  appendCandidateStageEvents?(
    runId: string,
    events: readonly CandidateStageEvent[],
    versions: Pick<SelectionPlan, "pipelineVersion" | "policyVersion">,
  ): Promise<void>;
  savePipelineDeficitLedger?(
    runId: string,
    entries: readonly PipelineDeficitLedgerEntry[],
    options: Pick<SelectionPlan, "pipelineVersion" | "policyVersion"> & { mode: "append" | "replace" },
  ): Promise<void>;
  persistCatalogDiscoveredCandidates?(
    runId: string,
    candidates: readonly CatalogDiscoveredCandidateInput[],
    versions: Pick<SelectionPlan, "pipelineVersion" | "policyVersion">,
  ): Promise<CatalogDiscoveredCandidateResult[]>;
}

function supportsAppleCatalogCache(
  repository: MatchingRepository,
): repository is MatchingRepository & AppleCatalogCacheRepository {
  return typeof repository.getAppleCatalogCacheEntry === "function"
    && typeof repository.putAppleCatalogCacheEntry === "function"
    && typeof repository.deleteAppleCatalogCacheEntry === "function"
    && typeof repository.recordAppleCatalogCacheEvent === "function"
    && typeof repository.tryAcquireAppleCatalogCacheLease === "function"
    && typeof repository.releaseAppleCatalogCacheLease === "function"
    && typeof repository.cleanupExpiredAppleCatalogCacheLeases === "function";
}

const MATCHING_OUTCOME_CHECKPOINT = "catalog_matching_outcome";
const V2_CATALOG_DISCOVERY_CHECKPOINT = "catalog_discovery_v2";
const AUTOMATIC_HANDOFF_TERMINAL_STATUSES = new Set([
  "publishing",
  "waiting_for_apple_authorization",
  "complete",
  "partial",
  "failed",
  "expired",
  "deleted",
]);

function catalogIdentityInput(
  familyId: string,
  song: CatalogSong,
  storefront: string,
  isPreferred: boolean,
  musicbrainzId: string | null = null,
): AlternateCatalogIdentity {
  return {
    id: randomUUID(),
    recordingFamilyId: familyId,
    provider: "apple",
    storefront,
    catalogId: song.id,
    isPreferred,
    identityConfidence: isPreferred ? 1 : 0.7,
    artist: song.artistName,
    title: song.name,
    album: song.albumName || null,
    isrc: song.isrc ?? null,
    musicbrainzId,
    durationMs: song.durationInMillis ?? null,
    versionLabel: song.versionLabel ?? null,
    metadata: {
      genreNames: song.genreNames ?? [],
      releaseDate: song.releaseDate ?? null,
      url: song.url ?? null,
      contentRating: catalogContentRating(song),
      versionSignature: catalogRecordingVersionSignature(song),
    },
  };
}

function compatibleCatalogAlternate(primary: CatalogSong, alternate: CatalogSong): boolean {
  if (primary.id === alternate.id) return false;
  // Stable identifiers never authorize crossing a structural or content
  // version boundary. Apple clean/explicit and live/studio variants remain
  // distinct even if upstream metadata accidentally reuses an ISRC.
  if (catalogRecordingVersionSignature(primary) !== catalogRecordingVersionSignature(alternate)) return false;
  if (primary.isrc && alternate.isrc) return primary.isrc === alternate.isrc;
  if (normalizeMusicText(primary.artistName) !== normalizeMusicText(alternate.artistName)) return false;
  if (normalizeMusicBaseTitle(primary.name) !== normalizeMusicBaseTitle(alternate.name)) return false;
  if (primary.durationInMillis && alternate.durationInMillis) {
    return Math.abs(primary.durationInMillis - alternate.durationInMillis) <= 10_000;
  }
  return true;
}

const VERSION_POLICY_CONFLICT_BASIS = "version_policy_conflict";

/**
 * The ordinary Apple matcher ranks identity compatibility, not the V2
 * selection policy. Apply that policy before an accepted row is persisted so
 * a disallowed primary cannot advance the version/playability ledger. When an
 * allowed alternative still clears the matcher's automatic-identity bar,
 * promote it deterministically; otherwise retain the catalog observations as
 * a non-publishable result for diagnostics and review.
 */
function applyV2VersionPolicy(
  run: Pick<
    Awaited<ReturnType<MatchingRepository["getRun"]>>,
    "pipelineVersion" | "selectionPlan"
  >,
  candidate: Candidate,
  match: CatalogMatchResult,
  observedCatalogSongs: readonly CatalogSong[] = [
    ...(match.song ? [match.song] : []),
    ...match.alternatives,
  ],
): CatalogMatchResult {
  const plan = run.selectionPlan;
  if (run.pipelineVersion !== "catalog_first_v2"
    || !plan
    || match.status !== "accepted"
    || !match.song) return match;

  const allowed = new Set(plan.versionPolicy.allowed);
  const primaryVersion = catalogRecordingVersionClass(match.song);
  if (allowed.has(primaryVersion)) {
    return {
      ...match,
      alternatives: match.alternatives.filter((song) => (
        allowed.has(catalogRecordingVersionClass(song))
      )),
    };
  }

  const observedSongs = mergeCatalogSongs([...observedCatalogSongs, match.song, ...match.alternatives]);
  const allowedSongs = observedSongs.filter((song) => allowed.has(catalogRecordingVersionClass(song)));
  if (allowedSongs.length === 0) {
    return {
      ...match,
      status: "unsupported",
      basis: `${VERSION_POLICY_CONFLICT_BASIS}; ${primaryVersion} is not allowed and no allowed catalog alternative was found`,
      song: null,
      alternatives: observedSongs.slice(0, 4),
    };
  }

  const promoted = rankCatalogMatches(candidate.id, candidate, allowedSongs);
  if (promoted.status === "accepted" && promoted.song) {
    return {
      ...promoted,
      basis: `${promoted.basis}; V2 version policy promoted an allowed ${catalogRecordingVersionClass(promoted.song)} alternative after rejecting ${primaryVersion}`,
      alternatives: promoted.alternatives.filter((song) => (
        allowed.has(catalogRecordingVersionClass(song))
      )),
    };
  }

  return {
    ...promoted,
    status: "review",
    basis: `${VERSION_POLICY_CONFLICT_BASIS}; ${primaryVersion} is not allowed and the allowed catalog alternatives did not meet the automatic identity threshold`,
    alternatives: allowedSongs.slice(0, 4),
  };
}

async function persistCatalogResolution(
  repository: MatchingRepository,
  runId: string,
  run: Pick<
    Awaited<ReturnType<MatchingRepository["getRun"]>>,
    "pipelineVersion" | "policyVersion" | "brief" | "selectionPlan"
  >,
  candidate: Candidate,
  match: CatalogMatchResult,
  storefront: string,
  musicBrainzIdentity: MusicBrainzIdentityEnrichment | null = null,
): Promise<void> {
  const versions = run.pipelineVersion && run.policyVersion
    ? { pipelineVersion: run.pipelineVersion, policyVersion: run.policyVersion }
    : null;
  if (!versions || !repository.appendCandidateStageEvents) return;
  const pipelineV2 = run.pipelineVersion === "catalog_first_v2";
  const stageRank: Partial<Record<CandidateStage, number>> = {
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
  const stageEvents = (
    targets: ReadonlyArray<{
      toStage: CandidateStage;
      reasonCode: string;
      detail?: Record<string, unknown>;
    }>,
  ): CandidateStageEvent[] => {
    let current = candidate.candidateStage ?? "scope_qualified";
    const events: CandidateStageEvent[] = [];
    const base = Date.now();
    for (const target of targets) {
      const currentRank = stageRank[current];
      const targetRank = stageRank[target.toStage];
      if (target.toStage !== "rejected"
        && currentRank != null
        && targetRank != null
        && currentRank >= targetRank) continue;
      events.push({
        candidateId: candidate.id,
        fromStage: current,
        toStage: target.toStage,
        reasonCode: target.reasonCode,
        detail: { storefront, ...(target.detail ?? {}) },
        occurredAt: new Date(base + events.length).toISOString(),
      });
      current = target.toStage;
    }
    return events;
  };

  if (match.status !== "accepted" || !match.song) {
    // A review result has not cleared catalog identity and must not appear to
    // have progressed. Terminally unavailable/duplicate candidates are kept
    // in durable history with an explicit bounded rejection reason.
    if (match.status !== "review") {
      await repository.appendCandidateStageEvents(runId, stageEvents([{
        toStage: "rejected",
        reasonCode: match.basis.includes(VERSION_POLICY_CONFLICT_BASIS)
          ? VERSION_POLICY_CONFLICT_BASIS
          : `catalog_${match.status}`,
        detail: { basis: match.basis },
      }]), versions);
    }
    return;
  }

  if (pipelineV2 && !isEvidenceEligible(run.brief, candidate, run.selectionPlan)) {
    await repository.appendCandidateStageEvents(runId, stageEvents([{
      toStage: "rejected",
      reasonCode: "catalog_match_missing_eligible_evidence",
      detail: { appleSongId: match.song.id, basis: match.basis },
    }]), versions);
    return;
  }

  if (!repository.upsertRecordingFamily
    || !repository.attachCandidateToRecordingFamily
    || !repository.upsertAlternateCatalogIdentity) {
    await repository.appendCandidateStageEvents(runId, pipelineV2
      ? stageEvents([
          { toStage: "claim_verified", reasonCode: "claim_evidence_eligible" },
          { toStage: "version_compatible", reasonCode: "catalog_version_compatible" },
          {
            toStage: "catalog_resolved",
            reasonCode: "catalog_identity_resolved",
            detail: { appleSongId: match.song.id },
          },
          {
            toStage: "playable",
            reasonCode: "storefront_playability_confirmed",
            detail: { appleSongId: match.song.id },
          },
        ])
      : stageEvents([{
          toStage: "eligible",
          reasonCode: "catalog_identity_accepted",
          detail: { appleSongId: match.song.id },
        }]), versions);
    return;
  }

  const musicBrainzRecordingId = musicBrainzIdentity?.recordingId ?? candidate.musicbrainzId;
  const familyId = await repository.upsertRecordingFamily(runId, {
    familyKey: recordingFamilyKey({
      song: match.song,
      musicBrainzRecordingId,
    }),
    canonicalArtist: match.song.artistName,
    canonicalTitle: match.song.name,
    versionClass: catalogRecordingVersionClass(match.song),
    metadata: {
      storefront,
      source: "apple_catalog_resolution",
      contentRating: catalogContentRating(match.song),
      versionSignature: catalogRecordingVersionSignature(match.song),
      ...(musicBrainzRecordingId ? { musicbrainzRecordingId: musicBrainzRecordingId } : {}),
      ...(musicBrainzIdentity?.releaseGroupId
        ? { musicbrainzReleaseGroupId: musicBrainzIdentity.releaseGroupId }
        : {}),
    },
    ...versions,
  });
  await repository.attachCandidateToRecordingFamily(runId, familyId, candidate.id, "primary_match");
  await repository.upsertAlternateCatalogIdentity(
    runId,
    catalogIdentityInput(familyId, match.song, storefront, true, musicBrainzRecordingId),
  );
  const compatibleAlternates = match.alternatives
    .filter((alternate) => compatibleCatalogAlternate(match.song!, alternate))
    .slice(0, 4);
  for (const alternate of compatibleAlternates) {
    await repository.upsertAlternateCatalogIdentity(
      runId,
      catalogIdentityInput(familyId, alternate, storefront, false, musicBrainzRecordingId),
    );
  }
  const identityDetail = {
    appleSongId: match.song.id,
    recordingFamilyId: familyId,
    alternateCount: compatibleAlternates.length,
    ...(musicBrainzRecordingId ? { musicbrainzRecordingId: musicBrainzRecordingId } : {}),
    ...(musicBrainzIdentity?.releaseGroupId
      ? { musicbrainzReleaseGroupId: musicBrainzIdentity.releaseGroupId }
      : {}),
  };
  await repository.appendCandidateStageEvents(runId, pipelineV2
    ? stageEvents([
        { toStage: "claim_verified", reasonCode: "claim_evidence_eligible" },
        { toStage: "version_compatible", reasonCode: "catalog_version_compatible" },
        { toStage: "catalog_resolved", reasonCode: "catalog_identity_resolved", detail: identityDetail },
        { toStage: "playable", reasonCode: "storefront_playability_confirmed", detail: identityDetail },
        { toStage: "canonicalized", reasonCode: "recording_family_canonicalized", detail: identityDetail },
      ])
    : stageEvents([{
        toStage: "eligible",
        reasonCode: "catalog_identity_accepted",
        detail: identityDetail,
      }]), versions);
}

function isSafePrimaryMatch(match: ExistingMatch, automatic: boolean): boolean {
  // One Command has no visitor review step, so only strict accepted matches
  // are safe to publish automatically. Manual bulk review may still present a
  // concrete review-row primary as a selectable visitor choice.
  return (match.status === "accepted" || (!automatic && match.status === "review"))
    && Boolean(match.song?.id);
}

function bindingSupportsRequiredScope(binding: TrackScopeBinding, constraint: SelectionConstraint): boolean {
  if (binding.eligibility !== "qualifying") return false;
  if (constraint.axis === "relationship") {
    return constraint.values.some((value) => matchingProofSupportsValue(
      `${binding.scopeValue} ${binding.relationship}`,
      value,
    ));
  }
  const expectedAxis = bindingAxisForConstraint(constraint.axis);
  if (!expectedAxis) return false;
  const compatibleAxes: Readonly<Record<string, readonly TrackScopeBinding["scopeAxis"][]>> = {
    genre: ["genre", "scene", "genre_scene"],
    scene: ["scene", "genre_scene"],
    era: ["era"],
    geography: ["geography", "scene", "genre_scene"],
    language: ["language"],
    mood: ["mood", "mood_theme_activity"],
    activity: ["activity", "mood_theme_activity"],
    theme: ["theme", "mood_theme_activity"],
  };
  if (!(compatibleAxes[expectedAxis] ?? [expectedAxis]).includes(binding.scopeAxis)) return false;
  const proof = `${binding.scopeValue} ${binding.relationship} ${binding.note}`;
  return constraint.values.some((value) => (
    scopeValueAliases(expectedAxis, value).some((alias) => musicScopePhraseMatches(proof, alias))
  ));
}

const MATCHING_CONSTRAINT_STOPWORDS = new Set([
  "a", "an", "and", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "with",
  "recording", "recordings", "song", "songs", "track", "tracks", "music",
]);

function matchingConstraintTokens(value: string): string[] {
  return normalizedPhrase(value).split(" ").filter((token) => (
    token.length >= 3 && !MATCHING_CONSTRAINT_STOPWORDS.has(token)
  ));
}

function matchingProofSupportsValue(proofText: string, value: string): boolean {
  const proofTokens = new Set(matchingConstraintTokens(proofText));
  const expected = [...new Set(matchingConstraintTokens(value))];
  if (expected.length === 0) return false;
  const overlap = expected.filter((token) => proofTokens.has(token)).length;
  const required = expected.length <= 2 ? expected.length : Math.max(2, Math.ceil(expected.length / 2));
  return overlap >= required;
}

function matchingMetadataContainsConstraintValue(
  candidate: Candidate,
  song: CatalogSong,
  constraint: SelectionConstraint,
): boolean {
  const metadata = normalizedPhrase([
    candidate.artist,
    candidate.title,
    candidate.album ?? "",
    song.artistName,
    song.name,
    song.albumName,
    ...(song.genreNames ?? []),
    song.versionLabel ?? "",
  ].join(" "));
  return constraint.values.some((rawValue) => {
    const value = normalizedPhrase(rawValue)
      .replace(/^(?:exclude|avoid|without|no|not)\s+/u, "")
      .trim();
    return value.length > 0 && musicScopePhraseMatches(metadata, value);
  });
}

function matchingConstraintSatisfied(
  candidate: Candidate,
  match: ExistingMatch,
  constraint: SelectionConstraint,
): boolean {
  const song = match.song;
  if (!song) return false;
  const bindings = candidate.scopeBindings ?? [];
  const qualifyingBindings = bindings.filter((binding) => binding.eligibility === "qualifying");
  if (constraint.axis === "evidence") return true;
  if (constraint.axis === "recording_version") return true;
  if (constraint.operator === "exclude" || constraint.operator === "avoid") {
    const scopeBound = constraint.axis === "relationship" || bindingAxisForConstraint(constraint.axis) !== null;
    return scopeBound
      ? !qualifyingBindings.some((binding) => bindingSupportsRequiredScope(binding, constraint))
      : !matchingMetadataContainsConstraintValue(candidate, song, constraint);
  }
  if (constraint.axis === "era") {
    const compatibleReleaseYears = (match.alternatives ?? [])
      .filter((alternate) => compatibleCatalogAlternate(song, alternate))
      .map((alternate) => Number.parseInt(alternate.releaseDate?.slice(0, 4) ?? "", 10))
      .filter((year) => Number.isInteger(year));
    return recordingFamilySatisfiesEraConstraint({
      candidateReleaseYear: candidate.releaseYear ?? null,
      appleReleaseDate: song.releaseDate,
      compatibleReleaseYears,
    }, constraint);
  }
  if (constraint.axis === "artist") {
    const artist = normalizedPhrase(song.artistName || candidate.artist);
    return constraint.values.some((value) => artist === normalizedPhrase(value));
  }
  if (constraint.axis === "track") {
    const title = normalizedPhrase(song.name || candidate.title);
    return constraint.values.some((value) => title === normalizedPhrase(value));
  }
  if (constraint.axis === "content") {
    const requested = normalizedPhrase(constraint.values.join(" "));
    const rating = catalogContentRating(song);
    if (requested.includes("clean")) return rating === "clean";
    if (requested.includes("explicit")) return rating === "explicit";
    if (requested.includes("instrumental")) {
      return /\binstrumental\b/iu.test(`${song.name} ${song.versionLabel ?? ""}`);
    }
    return matchingMetadataContainsConstraintValue(candidate, song, constraint);
  }
  if (constraint.axis === "relationship") {
    const combinedProof = qualifyingBindings
      .filter((binding) => matchingProofSupportsValue(binding.relationship, binding.scopeValue))
      .map((binding) => `${binding.scopeValue} ${binding.relationship}`)
      .join(" ");
    return constraint.values.some((value) => matchingProofSupportsValue(combinedProof, value));
  }
  return qualifyingBindings.some((binding) => bindingSupportsRequiredScope(binding, constraint));
}

/**
 * Count only matches that can survive the immutable V2 manifest floor. This
 * lets the adaptive refill controller react to evidence, era, and content
 * losses instead of mistaking a raw Apple identity for a publishable track.
 */
function matchSatisfiesV2HardEligibility(
  run: Pick<Awaited<ReturnType<MatchingRepository["getRun"]>>, "brief" | "pipelineVersion" | "selectionPlan">,
  candidate: Candidate | undefined,
  match: ExistingMatch,
): boolean {
  const plan = run.selectionPlan;
  if (run.pipelineVersion !== "catalog_first_v2" || !plan) return true;
  if (!candidate || !match.song || !isEvidenceEligible(run.brief, candidate, plan)) return false;
  if (!plan.versionPolicy.allowed.includes(catalogRecordingVersionClass(match.song))) return false;
  const bindings = candidate.scopeBindings ?? [];
  if (!selectionGeographyBindingsSatisfied(plan, bindings.filter((binding) => binding.eligibility === "qualifying"))) {
    return false;
  }
  for (const constraint of plan.constraints) {
    if (constraint.kind !== "hard") continue;
    if (!matchingConstraintSatisfied(candidate, match, constraint)) return false;
  }
  const rating = catalogContentRating(match.song);
  if (plan.contentPolicy.explicitContent === "clean_only" && rating !== "clean") return false;
  if (plan.contentPolicy.instrumental === "exclude"
    && /\binstrumental\b/iu.test(`${match.song.name} ${match.song.versionLabel ?? ""}`)) return false;
  return true;
}

async function resumeOrIgnoreAutomaticHandoff(
  repository: MatchingRepository,
  runId: string,
  run: { status: string; autoPublish?: boolean },
): Promise<boolean> {
  if (!run.autoPublish) return false;
  if (AUTOMATIC_HANDOFF_TERMINAL_STATUSES.has(run.status)) return true;
  if (run.status === "manifest_ready") {
    await repository.queueAutomaticPublication(runId);
    return true;
  }
  return false;
}

async function finalizeMatchingOutcome(
  repository: MatchingRepository,
  runId: string,
  run: {
    brief: PlaylistBrief;
    status: string;
    autoPublish?: boolean;
    pipelineVersion?: PipelineVersion;
    policyVersion?: PipelinePolicyVersion;
    selectionPlan?: SelectionPlan | null;
  },
  storefront: string,
  currentRecoveryGeneration = 0,
  currentRefillGeneration = 0,
): Promise<void> {
  // A matching lease may be replayed after its automatic handoff committed.
  // Re-read state before any mutation so the replay can never regress a
  // publishing or completed playlist back into visitor review.
  const latest = run.autoPublish ? await repository.getRun(runId) : run;
  if (await resumeOrIgnoreAutomaticHandoff(repository, runId, latest)) return;
  const brief = latest.brief;
  const candidates = await repository.listCandidates(runId);
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const matches = await repository.listMatches(runId);
  const safePrimaryMatches = matches
    .filter((match) => isSafePrimaryMatch(match, latest.autoPublish === true))
    .filter((match) => matchSatisfiesV2HardEligibility(
      latest,
      candidatesById.get(match.candidateId),
      match,
    ));
  const uniqueSafePrimaryMatches = partitionUniqueRecordingFamilies(safePrimaryMatches, (match) => {
    const candidate = candidatesById.get(match.candidateId);
    return recordingFamilyKey({
      song: match.song!,
      musicBrainzRecordingId: candidate?.musicbrainzId,
    });
  }).unique;
  const safePrimaryCount = uniqueSafePrimaryMatches.length;
  const configuredMinimum = Number(brief.targetSize?.min);
  const targetMinimum = brief.targetSize && Number.isFinite(configuredMinimum)
    ? Math.max(0, Math.floor(configuredMinimum))
    : null;
  const shortfall = targetMinimum === null ? 0 : Math.max(0, targetMinimum - safePrimaryCount);
  const candidateArtists = new Map(candidates.map((candidate) => [candidate.id, candidate.artist]));
  const safeArtists = uniqueSafePrimaryMatches.map((match) => (
    (match as ExistingMatch & { artist?: string }).artist
      ?? candidateArtists.get(match.candidateId)
      ?? match.song?.artistName
      ?? ""
  )).map((artist) => artist.trim()).filter(Boolean);
  // A legacy or synthetic repository may not expose candidate artist names.
  // Skip diversity recovery rather than inventing a deficit when the accepted
  // pool cannot be assessed. The production repository always joins them.
  const artistBreadthIsAssessable = safeArtists.length === uniqueSafePrimaryMatches.length;
  const desiredArtistCount = targetMinimum !== null && artistBreadthIsAssessable
    ? desiredPlaylistArtistCount(brief, targetMinimum)
    : 0;
  const representedArtists = [...new Set(safeArtists.map((artist) => playlistArtistKey(artist)))];
  const representedArtistLabels = [...new Map(safeArtists.map((artist) => [
    playlistArtistKey(artist),
    artist,
  ])).values()];
  const representedArtistCount = representedArtists.length;
  const artistShortfall = Math.max(0, desiredArtistCount - representedArtistCount);
  const checkpoint: MatchingOutcomeCheckpoint = {
    storefront,
    targetMinimum,
    safePrimaryCount,
    shortfall,
    desiredArtistCount,
    representedArtistCount,
    artistShortfall,
    status: shortfall > 0 || artistShortfall > 0 ? "shortfall" : "complete",
    updatedAt: new Date().toISOString(),
  };
  await repository.saveResearchCheckpoint(runId, MATCHING_OUTCOME_CHECKPOINT, checkpoint);
  if (latest.pipelineVersion && latest.policyVersion && repository.savePipelineDeficitLedger) {
    const observedAt = new Date().toISOString();
    const deficits: PipelineDeficitLedgerEntry[] = [];
    if (shortfall > 0 && targetMinimum !== null) {
      deficits.push({
        stage: "catalog_resolved",
        kind: "catalog_availability",
        status: "open",
        requiredCount: targetMinimum,
        actualCount: safePrimaryCount,
        deficitCount: shortfall,
        reasonCode: "catalog_exact_fill_shortfall",
        detail: { storefront, currentRecoveryGeneration, currentRefillGeneration },
        observedAt,
      });
    }
    if (artistShortfall > 0) {
      deficits.push({
        stage: "eligible",
        kind: "artist_breadth",
        status: "open",
        requiredCount: desiredArtistCount,
        actualCount: representedArtistCount,
        deficitCount: artistShortfall,
        reasonCode: "curated_artist_breadth_shortfall",
        detail: { representedArtists: representedArtistLabels },
        observedAt,
      });
    }
    await repository.savePipelineDeficitLedger(runId, deficits, {
      pipelineVersion: latest.pipelineVersion,
      policyVersion: latest.policyVersion,
      mode: "replace",
    });
  }

  if (latest.autoPublish) {
    const exactTarget = targetMinimum !== null
      && Number(brief.targetSize?.max) === targetMinimum;
    const policy = researchExecutionPolicyForRun({ ...latest, brief });
    const refillEligible = exactTarget && brief.mode === "curated" && policy.kind === "fast_curated";
    if (shortfall > 0) {
      const recovery = await repository.queueAutomaticCatalogRecovery(
        runId,
        storefront,
        currentRecoveryGeneration,
        currentRefillGeneration,
      );
      if (recovery === "queued" || recovery === "in_flight") return;
    }
    if (refillEligible && targetMinimum !== null) {
      const countRefillPlan = fastPostMatchRefillPlan({
        requestedMinimum: targetMinimum,
        selectableCount: safePrimaryCount,
        attemptedCandidateCount: matches.length,
        refillAttempts: currentRefillGeneration,
      });
      const diversityRefillPlan = fastArtistDiversityRefillPlan({
        requestedTrackCount: targetMinimum,
        desiredArtistCount,
        representedArtistCount,
        refillAttempts: currentRefillGeneration,
      });
      const additionalCandidateGoal = Math.max(
        countRefillPlan.state === "refill" ? countRefillPlan.additionalCandidateGoal : 0,
        diversityRefillPlan.state === "refill" ? diversityRefillPlan.additionalCandidateGoal : 0,
      );
      if (additionalCandidateGoal > 0) {
        const refill = await repository.queueAutomaticCandidateRefill(
          runId,
          storefront,
          additionalCandidateGoal,
          currentRefillGeneration,
          {
            desiredArtistCount,
            representedArtists: representedArtistLabels,
          },
        );
        if (refill === "queued" || refill === "in_flight") return;
      }
    }

    if (shortfall > 0) {
      // Count recovery is deliberately bounded, but exhausting that budget is
      // not a publication failure. Lock and publish every strict, unique Apple
      // match we did find; publication completeness will record the missing
      // target count and finish the run as `partial`.
      if (safePrimaryCount > 0) {
        await repository.updateRun(runId, {
          status: "visitor_review",
          phase: "exception_review",
          error: null,
        });
        await repository.queueAutomaticPublication(runId);
        return;
      }

      await repository.updateRun(runId, {
        status: "partial",
        phase: "catalog_matching_empty",
        error: null,
      });
      if (repository.savePipelineOutcome) {
        const stageCounts = latest.pipelineVersion === "catalog_first_v2"
          && repository.getPipelineStageCounts
          ? await repository.getPipelineStageCounts(runId)
          : undefined;
        const discoveredTrackCount = stageCounts?.discovered ?? candidates.length;
        const qualifiedTrackCount = Math.min(
          discoveredTrackCount,
          stageCounts?.claim_verified ?? 0,
        );
        await repository.savePipelineOutcome(runId, buildPipelineOutcome({
          pipelineVersion: latest.pipelineVersion ?? "legacy_v1",
          policyVersion: latest.policyVersion ?? "legacy_v1",
          status: "no_compatible_tracks",
          targetTrackCount: targetMinimum ?? 0,
          discoveredTrackCount,
          qualifiedTrackCount,
          selectedTrackCount: 0,
          publishedTrackCount: 0,
          frontierExhausted: true,
          reasonCodes: ["catalog_recovery_exhausted_without_compatible_tracks"],
          stageCounts,
        }));
      }
      return;
    }
  }

  if (shortfall > 0) {
    if (latest.autoPublish) {
      // The automatic branch above always returns for a count shortfall.
      return;
    }
    await repository.updateRun(runId, {
      status: "visitor_review",
      phase: "catalog_matching_shortfall",
      error: `Apple Music matching found ${safePrimaryCount} safe unique catalog ${safePrimaryCount === 1 ? "match" : "matches"} for the required ${targetMinimum}; ${shortfall} remain unresolved.`,
    });
    return;
  }
  await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review", error: null });
  if (latest.autoPublish) await repository.queueAutomaticPublication(runId);
}

function boundedEnvironmentInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : fallback;
}

export function matchingConcurrency(snapshot?: PipelinePolicySnapshot | null): number {
  if (snapshot) return snapshot.catalogLimits.appleConcurrencyInitial;
  return boundedEnvironmentInteger("APPLE_MATCHING_CONCURRENCY", 8, 1, 12);
}

export function catalogRecoveryDeadlineMs(snapshot?: PipelinePolicySnapshot | null): number {
  // Recovery is the accuracy path after the bounded fast route. The old
  // 45-second ceiling could repeatedly time out the same tail of a 100-track
  // run before Apple's broader searches had a chance to complete.  Keep the
  // fast route bounded, but give one recovery generation enough time to
  // actually settle a medium playlist.
  return snapshot?.catalogLimits.catalogRecoveryDeadlineMs
    ?? boundedEnvironmentInteger("APPLE_CATALOG_RECOVERY_TIMEOUT_MS", 90_000, 90_000, 180_000);
}

export function catalogLookupTimeoutMs(recovery: boolean, snapshot?: PipelinePolicySnapshot | null): number {
  const fastTimeout = snapshot?.catalogLimits.catalogLookupTimeoutMs
    ?? boundedEnvironmentInteger("FAST_MATCH_LOOKUP_TIMEOUT_MS", 7_000, 3_000, 12_000);
  // Apple may retry a safe GET after a transient 429/5xx. Recovery lookups
  // need room for that bounded retry; the initial fast pass does not.
  return recovery ? Math.max(20_000, fastTimeout) : fastTimeout;
}

export function catalogSearchQueries(candidate: Pick<Candidate, "artist" | "title" | "album">): string[] {
  const artist = candidate.artist.trim();
  const title = candidate.title.trim();
  const album = candidate.album?.trim() ?? "";
  const baseTitle = normalizeMusicBaseTitle(title);
  const queries: string[] = [];
  const seen = new Set<string>();
  const add = (...parts: string[]) => {
    const query = parts.map((part) => part.trim()).filter(Boolean).join(" ").slice(0, 300);
    const key = normalizeMusicText(query);
    if (!query || !key || seen.has(key)) return;
    seen.add(key);
    queries.push(query);
  };

  // Apple ranks song searches more reliably when the title leads. Start with
  // the two fields that identify the recording without over-constraining the
  // request to an album spelling or edition. The previous album-first query
  // commonly spent two requests on every otherwise-exact track, exhausting
  // the fast route before its tail was searched.
  add(title, artist);
  add(artist, title);
  // Keep the next fallback bound to a release container. Splitting a
  // collaboration into individual member searches can surface aliases,
  // side-projects, and unrelated member recordings; those are not safe
  // recording identity evidence.
  if (album) {
    add(title, album);
    add(album, title);
  }
  if (baseTitle && baseTitle !== normalizeMusicText(title)) {
    add(baseTitle, artist);
    add(artist, baseTitle);
  }
  add(title);
  if (baseTitle && baseTitle !== normalizeMusicText(title)) add(baseTitle);
  return queries;
}

export async function lookupCandidateSongs(
  candidate: Candidate,
  storefront: string,
  signal?: AbortSignal,
  allowedVersionClasses?: ReadonlySet<ReturnType<typeof catalogRecordingVersionClass>>,
): Promise<CatalogSong[]> {
  let songs = candidate.isrc ? await lookupAppleCatalogByIsrc(storefront, candidate.isrc, signal) : [];
  const hasAllowedDirectMatch = () => hasDirectCatalogMatch(
    candidate,
    allowedVersionClasses
      ? songs.filter((candidateSong) => allowedVersionClasses.has(catalogRecordingVersionClass(candidateSong)))
      : songs,
  );
  if (hasAllowedDirectMatch()) return songs;

  const maximumQueries = boundedEnvironmentInteger("APPLE_MATCH_MAX_QUERIES", 8, 1, 8);
  for (const query of catalogSearchQueries(candidate).slice(0, maximumQueries)) {
    signal?.throwIfAborted();
    const results = await searchAppleCatalog(storefront, query, signal);
    songs = mergeCatalogSongs(songs, results);
    if (hasAllowedDirectMatch()) break;
  }
  return songs;
}

type FastLookupFailure = "deadline" | "transient" | "permanent";

function fastLookupFailure(
  error: unknown,
  lookupSignal: AbortSignal | undefined,
  workerSignal: AbortSignal | undefined,
): FastLookupFailure | null {
  // Worker cancellation, owner controls, and authorization failures belong to
  // the durable job architecture and must never be converted into a visitor
  // review item.
  if (workerSignal?.aborted || error instanceof AppleAuthorizationRequiredError) return null;
  const abortReason = lookupSignal?.reason as { name?: unknown } | undefined;
  if (lookupSignal?.aborted && abortReason?.name === "TimeoutError") return "deadline";
  if (error instanceof AppleApiError && error.retriable) return "transient";
  // A malformed query or missing catalog resource is local to one candidate.
  // Persist it as an explicit unavailable outcome and keep matching the rest
  // of the playlist. Authentication/configuration failures still propagate.
  if (error instanceof AppleApiError && [400, 404, 422].includes(error.status ?? 0)) return "permanent";
  return null;
}

function isEvidenceEligible(
  brief: PlaylistBrief,
  candidate: Candidate,
  selectionPlan?: SelectionPlan | null,
): boolean {
  if (candidate.scopeBindings && candidate.scopeBindings.length > 0) {
    const qualifyingBindings = candidate.scopeBindings.filter((binding) => binding.eligibility === "qualifying");
    if (selectionPlan && !selectionGeographyBindingsSatisfied(selectionPlan, qualifyingBindings)) return false;
    return scopeBindingEligible(brief.mode, qualifyingBindings
      .map((binding) => {
        const evidence = classifyTrackScopeBindingEvidence({
          bindingKind: binding.bindingKind,
          scopeAxis: binding.scopeAxis,
          citationAttested: Boolean(binding.citationAttestationId),
        });
        return {
          strength: trackScopeBindingStrength(binding.confidence),
          provenanceRoot: binding.provenancePath.find((item) => item.kind === "provenance_root")?.id
            ?? binding.sourceRecordId
            ?? binding.sourceUrl
            ?? "",
          ...evidence,
          bindingKind: binding.bindingKind,
          scopeAxis: binding.scopeAxis,
        };
      }), selectionPlan?.intents);
  }
  // V2 eligibility is binding-based. Falling back to the legacy evidence-state
  // shortcut would let a broad editorial claim bypass the typed intent and
  // hard-axis checks simply because its binding failed to persist.
  if (selectionPlan?.pipelineVersion === "catalog_first_v2") return false;
  const boundClaims = candidate.evidence.filter((claim) => resolveEvidenceSubjectBinding(
    brief,
    claim.subjectEntity,
    claim.subjectRelationship,
  ));
  const attestedClaims = boundClaims.filter((claim) => claim.sourceClass === "web"
    && claim.citationSupport?.excerpt
    && claim.citationSupport.responseId
    && claim.citationSupport.outputItemId);
  const states = new Set(attestedClaims.map((claim) => claim.state));
  if (states.has("disputed")) return false;
  return requiresFactualFrontier(brief, selectionPlan)
    ? states.has("verified") || states.has("corroborated")
    : states.has("editorial") || states.has("verified") || states.has("corroborated");
}

function ineligibleEvidenceBasis(brief: PlaylistBrief, candidate: Candidate): string {
  if (candidate.scopeBindings && candidate.scopeBindings.length > 0) {
    return "Track-scope bindings do not meet the confirmed relevance and provenance threshold";
  }
  const boundClaims = candidate.evidence.filter((claim) => resolveEvidenceSubjectBinding(
    brief,
    claim.subjectEntity,
    claim.subjectRelationship,
  ));
  if (boundClaims.length === 0) {
    return "Evidence is not bound to the confirmed subject and relationship";
  }
  const states = new Set(boundClaims.map((claim) => claim.state));
  const hasAttestedStrongClaim = boundClaims.some((claim) => claim.sourceClass === "web"
    && Boolean(claim.citationSupport?.excerpt)
    && (claim.state === "verified" || claim.state === "corroborated" || claim.state === "editorial" || claim.state === "disputed"));
  if (!hasAttestedStrongClaim && [...states].some((state) => state !== "inferred")) {
    return "Hosted-web evidence lacks a server-attested citation span for this exact claim";
  }
  if (states.has("disputed")) {
    return "Sources disagree about the asserted track relationship; visitor review is required";
  }
  if (states.has("inferred") && !states.has("verified") && !states.has("corroborated")) {
    return "Inferred evidence requires visitor approval";
  }
  if (requiresFactualFrontier(brief) && states.has("editorial") && !states.has("verified") && !states.has("corroborated")) {
    return "Editorial evidence is eligible only for curated prompts";
  }
  return "Evidence does not meet this playlist's automatic inclusion policy";
}

function candidateCatalogKey(candidate: Pick<Candidate, "artist" | "title">): string {
  return `${normalizeMusicText(candidate.artist)}\u0000${normalizeMusicBaseTitle(candidate.title)}`;
}

function songCatalogKey(song: Pick<CatalogSong, "artistName" | "name">): string {
  return `${normalizeMusicText(song.artistName)}\u0000${normalizeMusicBaseTitle(song.name)}`;
}

function candidateScopeBindingRefs(candidate: Candidate): string[] {
  return [...new Set((candidate.scopeBindings ?? [])
    .filter((binding) => binding.eligibility === "qualifying")
    .flatMap((binding) => [
      binding.sourceRecordId,
      binding.citationAttestationId,
      binding.researchContainerId,
      binding.sourceUrl,
    ])
    .filter((value): value is string => Boolean(value?.trim())))]
    .slice(0, 32);
}

interface TrustedEditorialPlaylist {
  playlist: AppleCatalogPlaylist;
  reference: string;
  sourceUrl: string;
  provenanceRoot: string;
  bindings: Array<Pick<TrackScopeBinding, "scopeAxis" | "scopeValue" | "geographyRelationship">>;
}

interface V2CatalogDiscoveryCheckpoint {
  /** V2 envelopes distinguish durable in-flight progress from terminal summaries. */
  schemaVersion?: 2;
  state?: "running" | "terminal";
  complete?: boolean;
  retryable?: boolean;
  inputFingerprint?: string;
  attempt?: number;
  retryAttempt?: number;
  progress?: CatalogDiscoveryProgressSnapshot;
  stoppedBecause?: import("./catalog-discovery-v2.ts").CatalogDiscoveryStopReason;
  providerCallCount?: number;
  attemptedCount?: number;
  frontier?: import("./catalog-discovery-v2.ts").CatalogDiscoveryStrategyState[];
  trustedPlaylists?: TrustedEditorialPlaylist[];
}

function boundedCheckpointCounter(value: unknown, fallback: number, maximum: number): number {
  const numeric = Number(value);
  return Number.isInteger(numeric)
    ? Math.max(1, Math.min(maximum, numeric))
    : fallback;
}

function resumableRunningCatalogProgress(
  checkpoint: V2CatalogDiscoveryCheckpoint | null,
  inputFingerprint: string,
  storefront: string,
  target: number,
): CatalogDiscoveryProgressSnapshot | null {
  if (checkpoint?.schemaVersion !== 2
    || checkpoint.state !== "running"
    || checkpoint.inputFingerprint !== inputFingerprint) return null;
  const progress = checkpoint.progress;
  if (!progress || progress.version !== CATALOG_DISCOVERY_PROGRESS_VERSION
    || progress.storefront !== storefront
    || progress.target !== target
    || !Number.isInteger(progress.sequence)
    || !Number.isInteger(progress.providerCallCount)
    || !Array.isArray(progress.candidates)
    || !Array.isArray(progress.frontier)
    || !Array.isArray(progress.roundsCompleted)
    || !Array.isArray(progress.seedArtists)
    || !Array.isArray(progress.selectedAlbums)
    || !Array.isArray(progress.fullAlbums)) return null;
  return progress;
}

function invalidCatalogResumeError(error: unknown): boolean {
  return error instanceof Error
    && /(?:unsupported )?catalog discovery checkpoint|catalog discovery progress/iu.test(error.message);
}

function cancellationLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

const DISCOVERY_SCOPE_STOPWORDS = new Set([
  "a", "an", "and", "best", "curated", "essential", "essentials", "for", "from", "in", "influential",
  "music", "of", "playlist", "songs", "the", "tracks", "with", "your",
]);

function scopeTokens(run: Pick<Awaited<ReturnType<MatchingRepository["getRun"]>>, "brief" | "selectionPlan">): string[] {
  const planValues = run.selectionPlan?.constraints
    .filter((constraint) => ["genre", "scene", "subgenre", "geography", "language", "mood", "activity", "theme"].includes(constraint.axis))
    .flatMap((constraint) => constraint.values) ?? [];
  const normalized = normalizeMusicText([
    ...run.brief.subjectEntities,
    ...run.brief.include,
    run.brief.title,
    ...planValues,
  ].join(" "));
  return [...new Set(normalized.split(" ")
    .filter((token) => token.length >= 3 && !DISCOVERY_SCOPE_STOPWORDS.has(token)))]
    .slice(0, 16);
}

function catalogScopeQueries(
  run: Pick<Awaited<ReturnType<MatchingRepository["getRun"]>>, "brief" | "selectionPlan">,
): string[] {
  const scopedConstraints = run.selectionPlan?.constraints
    .filter((constraint) => !["exclude", "avoid", "maximum"].includes(constraint.operator)
      && ["genre", "scene", "subgenre", "geography", "language", "era", "label", "venue", "mood", "activity", "theme"].includes(constraint.axis))
    .flatMap((constraint) => constraint.values) ?? [];
  const values = [
    ...run.brief.subjectEntities,
    ...run.brief.include,
    ...scopedConstraints,
  ].map((value) => value.trim()).filter(Boolean);
  return [...new Map(values.map((value) => [normalizedPhrase(value), value])).values()].slice(0, 6);
}

export function catalogDeficitQueries(
  run: Pick<Awaited<ReturnType<MatchingRepository["getRun"]>>, "brief" | "selectionPlan">,
): string[] {
  const scopes = catalogScopeQueries(run);
  const genreTerms = run.selectionPlan?.constraints
    .filter((constraint) => constraint.axis === "genre" || constraint.axis === "scene" || constraint.axis === "subgenre")
    .flatMap((constraint) => constraint.values) ?? [];
  const localTerms = run.selectionPlan?.constraints
    .filter((constraint) => constraint.axis === "language" || constraint.axis === "geography")
    .flatMap((constraint) => constraint.values) ?? [];
  // Composite scope searches come first. Searching only `American` and
  // `drill` independently retrieved broad containers that could not prove
  // both hard axes, even when Apple had multiple explicitly scoped American
  // drill playlists. Keep the combinations bounded and deterministic.
  const composites = localTerms.flatMap((local) => genreTerms.flatMap((genre) => [
    `${local} ${genre}`,
    `${local} ${genre} essentials`,
    `${local} ${genre} classics`,
  ])).slice(0, 6);
  return [...new Map([
    ...composites,
    ...genreTerms,
    ...localTerms,
    ...scopes.map((scope) => `${scope} essentials`),
    ...scopes.map((scope) => `${scope} influential tracks`),
  ].map((value) => [normalizedPhrase(value), value.trim()])).values()]
    .filter(Boolean)
    .slice(0, 8);
}

function discoveryScopeAxis(plan: SelectionPlan): TrackScopeBinding["scopeAxis"] {
  const hardAxis = plan.constraints.find((constraint) => constraint.kind === "hard"
    && ["genre", "scene", "subgenre", "geography", "language", "mood", "activity", "theme"].includes(constraint.axis))?.axis;
  if (hardAxis === "subgenre") return "genre";
  if (hardAxis && ["genre", "scene", "geography", "language", "mood", "activity", "theme"].includes(hardAxis)) {
    return hardAxis as TrackScopeBinding["scopeAxis"];
  }
  if (plan.intents.includes("mood_activity")) return "mood";
  if (plan.intents.includes("theme")) return "theme";
  return "genre_scene";
}

function bindingAxisForConstraint(axis: SelectionConstraint["axis"]): TrackScopeBinding["scopeAxis"] | null {
  if (axis === "genre" || axis === "subgenre") return "genre";
  if (axis === "scene" || axis === "label" || axis === "venue") return "scene";
  if (axis === "era") return "era";
  if (axis === "geography") return "geography";
  if (axis === "language") return "language";
  if (axis === "mood") return "mood";
  if (axis === "activity") return "activity";
  if (axis === "theme") return "theme";
  return null;
}

const MUSIC_VALUE_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "baile funk": ["baile funk", "funk carioca"],
  "funk carioca": ["funk carioca", "baile funk"],
  "house music": ["house music", "house"],
  "hip hop": ["hip hop", "hip-hop"],
  "united states": ["united states", "american", "usa", "us"],
  american: ["american", "united states", "usa", "us"],
  brazilian: ["brazilian", "brazil", "brasil"],
  french: ["french", "france"],
  german: ["german", "germany"],
  japanese: ["japanese", "japan"],
  british: ["british", "united kingdom", "uk"],
});

function normalizedPhrase(value: string): string {
  return normalizeMusicText(value).replace(/\s+/gu, " ").trim();
}

/** Exact normalized word/phrase boundaries: house never matches warehouse. */
export function musicScopePhraseMatches(text: string, phrase: string): boolean {
  const normalizedText = ` ${normalizedPhrase(text)} `;
  const normalizedValue = normalizedPhrase(phrase);
  if (!normalizedValue) return false;
  return normalizedText.includes(` ${normalizedValue} `);
}

function scopeValueAliases(axis: TrackScopeBinding["scopeAxis"], value: string): string[] {
  const normalizedValue = normalizedPhrase(value);
  if (!normalizedValue) return [];
  if (axis === "language") {
    // “French Jazz” is a geography/scene label, not evidence that lyrics are
    // in French. Language proof must be explicit in the editorial container.
    return [
      `${normalizedValue} language`,
      `${normalizedValue} language music`,
      `in ${normalizedValue}`,
      `${normalizedValue} lyrics`,
      ...(normalizedValue === "french" ? ["francophone", "francais"] : []),
    ];
  }
  const aliases = [...(MUSIC_VALUE_ALIASES[normalizedValue] ?? [normalizedValue])];
  if (axis === "genre" && normalizedValue.endsWith(" music")) {
    aliases.push(normalizedValue.slice(0, -" music".length));
  }
  if (axis === "era") {
    const decade = normalizedValue.match(/^((?:19|20)\d)0s$/u)?.[1];
    if (decade) aliases.push(`${decade.slice(2)}s`);
  }
  return [...new Set(aliases.map(normalizedPhrase).filter(Boolean))];
}

interface RequiredEditorialScope {
  constraintId: string;
  axis: TrackScopeBinding["scopeAxis"];
  values: string[];
  geographyRelationship: SelectionConstraint["geographyRelationship"];
}

function requiredEditorialScopes(plan: SelectionPlan): RequiredEditorialScope[] {
  return plan.constraints.flatMap((constraint): RequiredEditorialScope[] => {
    if (constraint.kind !== "hard" || ["exclude", "avoid", "maximum"].includes(constraint.operator)) return [];
    const axis = bindingAxisForConstraint(constraint.axis);
    if (!axis) return [];
    const values = constraint.values.map((value) => value.trim()).filter(Boolean);
    return values.length ? [{
      constraintId: constraint.id,
      axis,
      values,
      geographyRelationship: constraint.geographyRelationship ?? (constraint.axis === "language" ? "language" : null),
    }] : [];
  });
}

function trustedEditorialPlaylist(
  playlist: AppleCatalogPlaylist,
  run: Pick<Awaited<ReturnType<MatchingRepository["getRun"]>>, "brief" | "selectionPlan">,
): TrustedEditorialPlaylist | null {
  const plan = run.selectionPlan;
  if (!plan || !playlist.url?.startsWith("https://music.apple.com/")) return null;
  const editorial = normalizeMusicText(playlist.curatorName).includes("apple music")
    || normalizeMusicText(playlist.playlistType ?? "") === "editorial";
  if (!editorial) return null;
  const editorialText = normalizeMusicText(`${playlist.name} ${playlist.description}`);
  const requirements = requiredEditorialScopes(plan);
  const bindings: TrustedEditorialPlaylist["bindings"] = [];
  if (requirements.length > 0) {
    for (const requirement of requirements) {
      const matchedValues = requirement.values.filter((value) => (
        scopeValueAliases(requirement.axis, value).some((alias) => musicScopePhraseMatches(editorialText, alias))
        && (!requirement.geographyRelationship
          || requirement.geographyRelationship === "unspecified"
          || proofSupportsSelectionGeography(editorialText, {
            value,
            relationship: requirement.geographyRelationship,
          }))
      ));
      // Every applicable hard axis must be proven by this exact container.
      // A genre-only playlist cannot silently satisfy geography or language.
      if (matchedValues.length === 0) return null;
      for (const value of matchedValues) {
        bindings.push({
          scopeAxis: requirement.axis,
          scopeValue: value,
          geographyRelationship: requirement.geographyRelationship,
        });
      }
    }
  } else {
    const tokens = scopeTokens(run);
    if (tokens.length === 0) return null;
    const matched = tokens.filter((token) => musicScopePhraseMatches(editorialText, token));
    const musicScopeToken = /^(?:ambient|bossa|country|disco|drill|electronic|footwork|funk|garage|grime|house|jazz|metal|punk|rap|reggae|rock|samba|soul|techno)$/u;
    const threshold = matched.some((token) => musicScopeToken.test(token)) ? 1 : Math.min(2, tokens.length);
    if (matched.length < threshold) return null;
    bindings.push({
      scopeAxis: discoveryScopeAxis(plan),
      scopeValue: [...run.brief.subjectEntities, ...run.brief.include].join(", ").slice(0, 240) || run.brief.title.slice(0, 240),
      geographyRelationship: null,
    });
  }
  return {
    playlist,
    reference: `apple-editorial:${playlist.id}`,
    sourceUrl: playlist.url,
    provenanceRoot: `apple_music_editorial:${playlist.id}`,
    bindings: [...new Map(bindings.map((binding) => [
      `${binding.scopeAxis}:${normalizedPhrase(binding.scopeValue)}:${binding.geographyRelationship ?? ""}`,
      binding,
    ])).values()],
  };
}

function catalogDiscoveryFingerprint(plan: SelectionPlan, candidates: readonly Candidate[]): string {
  return createHash("sha256").update(JSON.stringify({
    pipelineVersion: plan.pipelineVersion,
    policyVersion: plan.policyVersion,
    requestedTrackCount: plan.requestedTrackCount,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      key: candidateCatalogKey(candidate),
      bindings: candidateScopeBindingRefs(candidate).sort(),
    })).sort((left, right) => left.id.localeCompare(right.id)),
  })).digest("hex");
}

function discoveredCandidateInput(
  candidate: { song: CatalogSong; contexts: Array<{ containerId: string | null; inheritedScopeBindingRefs: string[] }> },
  trustedPlaylists: ReadonlyMap<string, TrustedEditorialPlaylist>,
  run: Pick<Awaited<ReturnType<MatchingRepository["getRun"]>>, "brief" | "selectionPlan">,
): CatalogDiscoveredCandidateInput | null {
  const trusted = candidate.contexts.flatMap((context) => context.inheritedScopeBindingRefs)
    .map((reference) => trustedPlaylists.get(reference))
    .find((value): value is TrustedEditorialPlaylist => Boolean(value));
  if (!trusted || !run.selectionPlan) return null;
  const editorialScopeEligible = scopeBindingEligible(run.brief.mode, trusted.bindings.map((binding) => ({
    strength: "strong" as const,
    provenanceRoot: trusted.provenanceRoot,
    layer: "scope_binding" as const,
    supportsRequestedRelationship: true,
    bindingKind: "catalog_editorial_membership" as const,
    scopeAxis: binding.scopeAxis,
  })), run.selectionPlan.intents);
  if (!editorialScopeEligible) return null;
  return {
    song: candidate.song,
    source: {
      url: trusted.sourceUrl,
      title: trusted.playlist.name,
      sourceClass: "apple",
      provenanceRoot: trusted.provenanceRoot,
      note: `Apple Music editorial playlist with explicit scope: ${trusted.bindings.map((binding) => `${binding.scopeAxis}=${binding.scopeValue}`).join(", ")}.`,
    },
    container: {
      providerId: trusted.playlist.id,
      title: trusted.playlist.name,
      metadata: {
        curatorName: trusted.playlist.curatorName,
        playlistType: trusted.playlist.playlistType ?? null,
        scopeReference: trusted.reference,
      },
    },
    bindings: trusted.bindings.map((binding) => ({
      bindingKind: "catalog_editorial_membership",
      eligibility: "qualifying",
      scopeAxis: binding.scopeAxis,
      scopeValue: binding.scopeValue,
      geographyRelationship: binding.geographyRelationship ?? null,
      relationship: `Exact member of Apple Music editorial playlist ${trusted.playlist.name}; container explicitly scopes ${binding.scopeAxis}=${binding.scopeValue}`.slice(0, 240),
      confidence: 0.9,
      sourceUrl: trusted.sourceUrl,
      note: `Exact Apple recording is a member of “${trusted.playlist.name}”, which explicitly supports ${binding.scopeAxis}=${binding.scopeValue}.`,
    })),
  };
}

/**
 * Pipeline V2 resolves already-evidenced recording candidates and grows the
 * durable pool from trusted, scope-matched Apple editorial containers through
 * a bounded A-D frontier. The evaluator only promotes exact identities with
 * an authoritative track-scope binding; arbitrary Apple search, artist views,
 * and untrusted playlist placement cannot make an unsupported song eligible.
 */
async function resolveV2CatalogFrontier(
  repository: MatchingRepository,
  runId: string,
  run: Awaited<ReturnType<MatchingRepository["getRun"]>>,
  candidates: Candidate[],
  existingMatches: ExistingMatch[],
  storefront: string,
  provider: CatalogDiscoveryProvider,
  signal?: AbortSignal,
): Promise<void> {
  const plan = run.selectionPlan;
  if (!plan || plan.pipelineVersion !== "catalog_first_v2" || pipelineV2Route(plan) !== "curated_catalog") return;
  const inputFingerprint = catalogDiscoveryFingerprint(plan, candidates);
  const prior = await repository.getResearchCheckpoint(runId, V2_CATALOG_DISCOVERY_CHECKPOINT) as V2CatalogDiscoveryCheckpoint | null;
  const sameFingerprint = prior?.inputFingerprint === inputFingerprint;
  const priorIsRunning = prior?.state === "running";
  const priorIsTerminal = Boolean(prior) && !priorIsRunning;
  // Checkpoints written before schemaVersion/state existed are terminal
  // summaries. Continue to honor their complete/retryable contract.
  if (priorIsTerminal && prior?.complete && !prior.retryable && sameFingerprint) return;
  const runningProgress = resumableRunningCatalogProgress(
    prior,
    inputFingerprint,
    storefront,
    plan.requestedTrackCount,
  );
  const sameRunningAttempt = priorIsRunning && sameFingerprint;
  const terminalRetryPrior = priorIsTerminal && prior?.retryable && sameFingerprint ? prior : null;
  // Reclaiming an in-flight lease continues the same logical provider attempt.
  // Only a terminal provider retry consumes retryAttempt budget.
  const attempt = sameRunningAttempt
    ? boundedCheckpointCounter(prior?.attempt, 1, 20)
    : Math.max(1, Math.min(20, Number(prior?.attempt ?? 0) + 1));
  const retryAttempt = sameRunningAttempt
    ? boundedCheckpointCounter(prior?.retryAttempt, 1, 3)
    : terminalRetryPrior
      ? Math.max(1, Math.min(3, Number(terminalRetryPrior.retryAttempt ?? 0) + 1))
      : 1;

  const eligibleCandidates = candidates.filter((candidate) => (
    isEvidenceEligible(run.brief, candidate, plan) && candidateScopeBindingRefs(candidate).length > 0
  ));

  const byKey = new Map<string, Candidate[]>();
  for (const candidate of eligibleCandidates) {
    const list = byKey.get(candidateCatalogKey(candidate)) ?? [];
    list.push(candidate);
    byKey.set(candidateCatalogKey(candidate), list);
  }
  // Negative and ambiguous catalog outcomes are observations, not permanent
  // identity decisions. A later exact, evidence-bound discovery may safely
  // replace them (catalog availability and search recall can change). Preserve
  // only already accepted identities and intentional duplicate exclusions.
  const existingCandidateIds = new Set(existingMatches
    .filter((match) => match.status === "accepted" || match.status === "duplicate")
    .map((match) => match.candidateId));
  const acceptedCatalogIds = new Set(existingMatches
    .filter((match) => match.status === "accepted" && match.song?.id)
    .map((match) => match.song!.id));
  const discoveryPolicy = catalogDiscoverySizePolicy(plan.requestedTrackCount, plan.policyVersion);
  const deadlineSignal = AbortSignal.timeout(discoveryPolicy.deadlineMs);
  const discoverySignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
  const trustedPlaylists = new Map<string, TrustedEditorialPlaylist>();
  if (sameFingerprint) {
    for (const trusted of prior?.trustedPlaylists ?? []) trustedPlaylists.set(trusted.reference, trusted);
  }
  let lastRunningProgress = runningProgress;
  let checkpointWriteFailed = false;

  try {
    const runDiscovery = async (
      resumeProgress: CatalogDiscoveryProgressSnapshot | null,
    ): Promise<CuratedCatalogDiscoveryResult> => {
      const commonRequest: CuratedCatalogDiscoveryRequest = {
        storefront,
        query: run.brief.title,
        aliases: [
          ...catalogScopeQueries(run),
          ...eligibleCandidates.map((candidate) => `${candidate.artist} ${candidate.title}`),
        ],
        deficitQueries: catalogDeficitQueries(run),
        target: plan.requestedTrackCount,
        concurrency: 6,
        maxPagesPerStrategy: discoveryPolicy.maxPagesPerStrategy,
        maxTotalProviderCalls: discoveryPolicy.maxTotalProviderCalls,
        signal: discoverySignal,
        deadlineSignal,
        trustDiscoveredPlaylist(playlist) {
          const trusted = trustedEditorialPlaylist(playlist, run);
          if (!trusted) return null;
          trustedPlaylists.set(trusted.reference, trusted);
          return [trusted.reference];
        },
        evaluate(song, context) {
          // Existing accepted identities seed adaptive planning. They must not
          // also count as newly-qualified yield when Apple returns them again in
          // a search or editorial container, or exact-fill can stop too early.
          if (acceptedCatalogIds.has(song.id)) {
            return { eligible: false, scopeBindingRefs: [], reasonCode: "catalog_identity_already_accepted" };
          }
          const candidatesForSong = byKey.get(songCatalogKey(song)) ?? [];
          const inheritedEditorialRefs = context.inheritedScopeBindingRefs
            .filter((reference) => trustedPlaylists.has(reference));
          const bindingRefs = [...new Set([
            ...candidatesForSong.flatMap(candidateScopeBindingRefs),
            ...inheritedEditorialRefs,
          ])];
          if (!bindingRefs.length) return { eligible: false, scopeBindingRefs: [], reasonCode: "missing_scope_binding" };
          if (!plan.versionPolicy.allowed.includes(catalogRecordingVersionClass(song))) {
            return { eligible: false, scopeBindingRefs: bindingRefs, reasonCode: "version_policy_conflict" };
          }
          return { eligible: true, scopeBindingRefs: bindingRefs, reasonCode: "exact_evidence_bound_identity" };
        },
        async onCheckpoint(progress) {
          try {
            await repository.saveResearchCheckpoint(runId, V2_CATALOG_DISCOVERY_CHECKPOINT, {
              schemaVersion: 2,
              state: "running",
              complete: false,
              retryable: true,
              inputFingerprint,
              attempt,
              retryAttempt,
              progress,
              trustedPlaylists: [...trustedPlaylists.values()],
              updatedAt: new Date().toISOString(),
            });
            // A page only becomes resumable after its durable write succeeds.
            lastRunningProgress = progress;
          } catch (error) {
            checkpointWriteFailed = true;
            throw error;
          }
        },
      };
      if (resumeProgress) {
        return discoverCuratedAppleCatalog(provider, { ...commonRequest, resumeProgress });
      }
      return discoverCuratedAppleCatalog(provider, {
        ...commonRequest,
        ...(terminalRetryPrior?.frontier ? { resumeFrontier: terminalRetryPrior.frontier } : {}),
        initialQualifiedCount: acceptedCatalogIds.size,
        initialAttemptedCount: Math.max(candidates.length, Number(terminalRetryPrior?.attemptedCount ?? 0)),
      });
    };

    let discovery: CuratedCatalogDiscoveryResult;
    try {
      discovery = await runDiscovery(runningProgress);
    } catch (error) {
      // An envelope can pass shallow persistence checks but fail the engine's
      // full invariant validation. Such stale/corrupt progress is discarded
      // before any provider call and safely restarted as the same attempt.
      if (!runningProgress || !invalidCatalogResumeError(error)) throw error;
      lastRunningProgress = null;
      discovery = await runDiscovery(null);
    }

    const songsByKey = new Map<string, CatalogSong[]>();
    for (const candidate of discovery.qualified) {
      const key = songCatalogKey(candidate.song);
      const songs = songsByKey.get(key) ?? [];
      songs.push(candidate.song);
      songsByKey.set(key, songs);
    }

    const discoveredInputs = discovery.qualified.flatMap((candidate) => {
      if (byKey.has(songCatalogKey(candidate.song))) return [];
      const input = discoveredCandidateInput(candidate, trustedPlaylists, run);
      return input ? [input] : [];
    });
    const persistedDiscoveries = repository.persistCatalogDiscoveredCandidates && discoveredInputs.length > 0
      ? await repository.persistCatalogDiscoveredCandidates(runId, discoveredInputs, {
        pipelineVersion: plan.pipelineVersion,
        policyVersion: plan.policyVersion,
      })
      : [];
    const persistedCandidates: Candidate[] = persistedDiscoveries.flatMap((persisted) => {
      const input = discoveredInputs.find((item) => item.song.id === persisted.appleSongId);
      if (!input) return [];
      return [{
        id: persisted.candidateId,
        artist: input.song.artistName,
        title: input.song.name,
        album: input.song.albumName || null,
        releaseYear: input.song.releaseDate ? Number.parseInt(input.song.releaseDate.slice(0, 4), 10) || null : null,
        durationMs: input.song.durationInMillis ?? null,
        isrc: input.song.isrc ?? null,
        musicbrainzId: null,
        versionLabel: input.song.versionLabel ?? null,
        candidateStage: "scope_qualified",
        scopeBindings: persisted.scopeBindings,
        evidence: [],
      }];
    });
    let resolvedCount = 0;
    for (const candidate of persistedCandidates) {
      const input = discoveredInputs.find((item) => item.song.id === persistedDiscoveries
        .find((persisted) => persisted.candidateId === candidate.id)?.appleSongId);
      if (!input || existingCandidateIds.has(candidate.id) || acceptedCatalogIds.has(input.song.id)) continue;
      let match: CatalogMatchResult = {
        candidateId: candidate.id,
        status: "accepted",
        basis: "Pipeline V2 exact Apple editorial-container identity",
        score: 100,
        song: input.song,
        alternatives: [],
      };
      match = applyV2VersionPolicy(run, candidate, match, [input.song]);
      await repository.saveMatch(runId, match);
      await persistCatalogResolution(repository, runId, run, candidate, match, storefront);
      existingCandidateIds.add(candidate.id);
      if (match.status === "accepted" && match.song) {
        acceptedCatalogIds.add(match.song.id);
        resolvedCount += 1;
      }
    }
    for (const candidate of eligibleCandidates) {
      if (existingCandidateIds.has(candidate.id)) continue;
      const songs = songsByKey.get(candidateCatalogKey(candidate)) ?? [];
      if (songs.length === 0) continue;
      let match = rankCatalogMatches(candidate.id, candidate, songs);
      if (match.status !== "accepted" || !match.song) continue;
      match = { ...match, basis: `Pipeline V2 evidence-bound Apple discovery: ${match.basis}` };
      match = applyV2VersionPolicy(run, candidate, match, songs);
      if (match.status === "accepted" && match.song && acceptedCatalogIds.has(match.song.id)) continue;
      await repository.saveMatch(runId, match);
      await persistCatalogResolution(repository, runId, run, candidate, match, storefront);
      existingCandidateIds.add(candidate.id);
      if (match.status === "accepted" && match.song) {
        acceptedCatalogIds.add(match.song.id);
        resolvedCount += 1;
      }
    }
    const transientFailureCount = discovery.frontier.filter((item) => item.status === "failed" && item.retryable).length;
    const permanentFailureCount = discovery.frontier.filter((item) => item.status === "failed" && !item.retryable).length;
    const goalSatisfied = discovery.totalQualifiedCount >= discovery.qualifiedGoal;
    const retryable = retryAttempt < 3 && !goalSatisfied
      && (transientFailureCount > 0
        || discovery.stoppedBecause === "provider_call_limit"
        || discovery.stoppedBecause === "provider_degraded"
        || discovery.stoppedBecause === "provider_circuit_open");
    const finalCandidates = await repository.listCandidates(runId);
    await repository.saveResearchCheckpoint(runId, V2_CATALOG_DISCOVERY_CHECKPOINT, {
      schemaVersion: 2,
      state: "terminal",
      complete: !retryable,
      retryable,
      attempt,
      retryAttempt,
      inputFingerprint: catalogDiscoveryFingerprint(plan, finalCandidates),
      progress: discovery.progress,
      stoppedBecause: discovery.stoppedBecause,
      providerCallCount: discovery.providerCallCount,
      attemptedCount: discovery.totalAttemptedCount,
      roundsCompleted: discovery.roundsCompleted,
      discoveredCount: discovery.candidates.length,
      qualifiedCount: discovery.totalQualifiedCount,
      resolvedCount,
      persistedCandidateCount: persistedCandidates.length,
      transientFailureCount,
      permanentFailureCount,
      frontier: discovery.frontier,
      trustedPlaylists: [...trustedPlaylists.values()],
      updatedAt: new Date().toISOString(),
    });
    if (!goalSatisfied && repository.savePipelineOutcome) {
      const disposition = catalogDiscoveryOutcomeDisposition({
        stoppedBecause: discovery.stoppedBecause,
        safeTrackCount: acceptedCatalogIds.size,
        targetTrackCount: plan.requestedTrackCount,
      });
      await repository.savePipelineOutcome(runId, buildPipelineOutcome({
        pipelineVersion: plan.pipelineVersion,
        policyVersion: plan.policyVersion,
        status: disposition.status,
        targetTrackCount: plan.requestedTrackCount,
        discoveredTrackCount: Math.max(candidates.length, discovery.totalAttemptedCount),
        qualifiedTrackCount: Math.min(
          Math.max(candidates.length, discovery.totalAttemptedCount),
          discovery.totalQualifiedCount,
        ),
        selectedTrackCount: acceptedCatalogIds.size,
        publishedTrackCount: 0,
        frontierExhausted: disposition.frontierExhausted,
        providerUnavailable: disposition.providerUnavailable,
        reasonCodes: [disposition.reasonCode],
      }));
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // Never replace the last acknowledged page with a coarse summary when a
    // worker lease/cancellation ends, or when acknowledging the next page
    // itself failed. The durable running envelope remains the resume point.
    if (checkpointWriteFailed || (cancellationLikeError(error) && !deadlineSignal.aborted)) throw error;
    await repository.saveResearchCheckpoint(runId, V2_CATALOG_DISCOVERY_CHECKPOINT, {
      schemaVersion: 2,
      state: "terminal",
      complete: retryAttempt >= 3,
      retryable: retryAttempt < 3,
      attempt,
      retryAttempt,
      inputFingerprint,
      ...(lastRunningProgress ? {
        progress: lastRunningProgress,
        providerCallCount: lastRunningProgress.providerCallCount,
        attemptedCount: lastRunningProgress.totalAttemptedCount,
        frontier: lastRunningProgress.frontier,
      } : {}),
      stoppedBecause: discoverySignal.aborted ? "timed_out" : "provider_degraded",
      resolvedCount: 0,
      errorOrigin: "catalog",
      trustedPlaylists: [...trustedPlaylists.values()],
      updatedAt: new Date().toISOString(),
    });
  }
}

export async function matchResearchRun(
  repository: MatchingRepository,
  runId: string,
  storefront: string,
  signal?: AbortSignal,
  options: {
    fast?: boolean;
    fastConfirmedAt?: string;
    fastResearchDeadlineAt?: string;
    fastDeadlineAt?: string;
    retryIncomplete?: boolean;
    recoveryGeneration?: number;
    refillGeneration?: number;
    catalogDiscoveryProvider?: CatalogDiscoveryProvider;
    musicBrainzEnricher?: typeof enrichMusicBrainzIdentity;
  } = {},
): Promise<void> {
  const run = await repository.getRun(runId);
  const persistedStorefront = storefrontForRun(run);
  const normalizedStorefront = run.pipelinePolicySnapshot
    ? persistedStorefront.toLowerCase()
    : storefront.toLowerCase();
  if (!/^[a-z]{2}$/i.test(normalizedStorefront)) throw new Error("Apple storefront must be a two-letter code");
  if (await resumeOrIgnoreAutomaticHandoff(repository, runId, run)) return;
  const recovery = options.retryIncomplete === true;
  const refillGeneration = Number.isInteger(options.refillGeneration)
    ? Math.max(0, Math.min(FAST_POST_MATCH_REFILL_LIMIT, Number(options.refillGeneration)))
    : 0;
  const refill = refillGeneration > 0;
  const checkpointPhase = recovery
    ? "catalog_matching_recovery"
    : refill
      ? `catalog_matching_refill:${refillGeneration}`
      : "catalog_matching";
  const checkpoint = recovery
    ? null
    : await repository.getResearchCheckpoint(runId, checkpointPhase) as MatchingCheckpoint | null;
  if (!recovery && checkpoint?.complete && checkpoint.storefront === normalizedStorefront) {
    await finalizeMatchingOutcome(
      repository,
      runId,
      run,
      normalizedStorefront,
      options.recoveryGeneration,
      refillGeneration,
    );
    return;
  }
  const start = checkpoint?.storefront === normalizedStorefront ? checkpoint.nextIndex : 0;
  const executionPolicy = researchExecutionPolicyForRun(run);
  let routeKey: string | null = null;
  let route = null;
  if (executionPolicy.kind === "fast_curated" && !refill) {
    routeKey = `fast:route:${executionPolicy.version}`;
    route = parseFastRouteCheckpoint(
      await repository.getResearchCheckpoint(runId, routeKey),
      executionPolicy.version,
    );
  }
  const fast = options.fast === true || refill || Boolean(route);
  let routeDeadlineAt: string | undefined;
  if (fast) {
    if (executionPolicy.kind !== "fast_curated") throw new Error("Fast matching requires a curated brief");
    if (refill) {
      const refillRoute = parseFastPostMatchRefillRouteCheckpoint(
        await repository.getResearchCheckpoint(runId, `fast:post-match-refill:${refillGeneration}:route`),
        refillGeneration,
      );
      if (!refillRoute || refillRoute.storefront !== normalizedStorefront) {
        throw new Error("Catalog refill matching is missing its durable route");
      }
      routeDeadlineAt = refillRoute.deadlineAt;
    } else {
      if (!routeKey) throw new Error("Fast matching requires a curated route");
    if (!route && run.createdAt) {
      const confirmedAt = new Date(run.createdAt);
      if (Number.isFinite(confirmedAt.getTime())) {
        route = createFastRouteCheckpoint(executionPolicy, confirmedAt);
        await repository.saveResearchCheckpoint(runId, routeKey, route);
      }
    }
    if (!route) throw new Error("Fast matching is missing its immutable confirmation deadline");
    for (const [provided, expected] of [
      [options.fastConfirmedAt, route.confirmedAt],
      [options.fastResearchDeadlineAt, route.researchDeadlineAt],
      [options.fastDeadlineAt, route.deadlineAt],
    ] as const) {
      if (provided && provided !== expected) throw new Error("Fast matching job deadline does not match its durable route");
    }
      routeDeadlineAt = route.deadlineAt;
    }
  }
  const startedAt = checkpoint?.startedAt ?? new Date().toISOString();
  const deadlineAt = recovery
    ? new Date(Date.now() + catalogRecoveryDeadlineMs(run.pipelinePolicySnapshot)).toISOString()
    : fast
      ? routeDeadlineAt
      : undefined;
  let deadlineExhausted = false;

  signal?.throwIfAborted();
  await repository.updateRun(runId, {
    status: "matching",
    phase: recovery ? "catalog_matching_recovery" : "catalog_matching",
    error: null,
  });
  let allCandidates = await repository.listCandidates(runId);
  let existingMatches = await repository.listMatches(runId);
  if (run.selectionPlan?.pipelineVersion === "catalog_first_v2"
    && pipelineV2Route(run.selectionPlan) === "curated_catalog") {
    const baseDiscoveryProvider = options.catalogDiscoveryProvider ?? liveAppleCatalogDiscoveryProvider;
    const discoveryProvider = supportsAppleCatalogCache(repository)
      ? createCachedCatalogDiscoveryProvider(repository, runId, baseDiscoveryProvider, {
        ttlMs: run.pipelinePolicySnapshot ? {
          catalog_resource: run.pipelinePolicySnapshot.catalogLimits.catalogResourceCacheTtlSeconds * 1_000,
          search_view: run.pipelinePolicySnapshot.catalogLimits.catalogSearchCacheTtlSeconds * 1_000,
          artist_view: run.pipelinePolicySnapshot.catalogLimits.catalogSearchCacheTtlSeconds * 1_000,
          playlist_membership: run.pipelinePolicySnapshot.catalogLimits.playlistMembershipCacheTtlSeconds * 1_000,
        } : undefined,
      })
      : baseDiscoveryProvider;
    await resolveV2CatalogFrontier(
      repository,
      runId,
      run,
      allCandidates,
      existingMatches,
      normalizedStorefront,
      discoveryProvider,
      signal,
    );
    // Discovery can atomically grow the candidate pool. Refresh both sides of
    // the join before the ordinary matcher calculates its remaining work.
    allCandidates = await repository.listCandidates(runId);
    existingMatches = await repository.listMatches(runId);
  }
  const retryableCandidateIds = new Set(existingMatches
    .filter((match) => isRetryableCatalogMatch(match))
    .map((match) => match.candidateId));
  const versionPolicyRetryCandidateIds = new Set(existingMatches
    .filter((match) => match.basis.includes(VERSION_POLICY_CONFLICT_BASIS))
    .map((match) => match.candidateId));
  const existingCandidateIds = new Set(existingMatches.map((match) => match.candidateId));
  const work = allCandidates.flatMap((candidate, originalIndex) => {
    const shouldProcess = recovery
      ? retryableCandidateIds.has(candidate.id)
      : originalIndex >= start
        && (!existingCandidateIds.has(candidate.id) || versionPolicyRetryCandidateIds.has(candidate.id));
    return shouldProcess ? [{ candidate, originalIndex }] : [];
  });
  const acceptedCatalogIds = new Set(existingMatches
    .filter((match) => match.status === "accepted" && match.song?.id)
    .map((match) => match.song!.id));
  const clusterCounts = new Map<string, number>();
  for (const candidate of allCandidates) {
    if (candidate.duplicateClusterKey) {
      clusterCounts.set(candidate.duplicateClusterKey, (clusterCounts.get(candidate.duplicateClusterKey) ?? 0) + 1);
    }
  }
  const concurrency = matchingConcurrency(run.pipelinePolicySnapshot);
  for (let batchStart = 0; batchStart < work.length; batchStart += concurrency) {
    signal?.throwIfAborted();
    const batch = work.slice(batchStart, batchStart + concurrency);
    const remaining = deadlineAt ? Date.parse(deadlineAt) - Date.now() : Number.POSITIVE_INFINITY;
    const lookupBudget = remaining - FAST_MATCHING_FINALIZATION_RESERVE_MS;
    if (lookupBudget <= 0) {
      const timeoutCandidates = work.slice(batchStart).map(({ candidate }) => candidate);
      // Recovery rows already carry an explicit timeout-to-review outcome.
      // Leave them retryable for the next visitor-requested recovery generation.
      if (!recovery) {
        await repository.saveTimeoutMatches(
          runId,
          timeoutCandidates.map((candidate) => candidate.id),
          RETRYABLE_CATALOG_MATCH_BASES[0],
        );
      }
      await repository.saveResearchCheckpoint(runId, checkpointPhase, {
        nextIndex: recovery ? work.length : allCandidates.length,
        storefront: normalizedStorefront,
        complete: true,
        deadlineAt,
        startedAt,
        completedAt: new Date().toISOString(),
        timedOutCandidateCount: timeoutCandidates.length,
        updatedAt: new Date().toISOString(),
      });
      deadlineExhausted = true;
      break;
    }
    const lookups = await Promise.all(batch.map(async ({ candidate }) => {
          const boundedByDeadline = Boolean(deadlineAt);
          const lookupSignal = boundedByDeadline
            ? AbortSignal.any([
                ...(signal ? [signal] : []),
                AbortSignal.timeout(Math.max(1, Math.min(
                  lookupBudget,
                  catalogLookupTimeoutMs(recovery, run.pipelinePolicySnapshot),
                ))),
              ])
            : signal;
          try {
            return {
              songs: await lookupCandidateSongs(
                candidate,
                normalizedStorefront,
                lookupSignal,
                run.pipelineVersion === "catalog_first_v2" && run.selectionPlan
                  ? new Set(run.selectionPlan.versionPolicy.allowed)
                  : undefined,
              ),
              failure: null,
            };
          } catch (error) {
            if (signal?.aborted) throw error;
            const failure = fastLookupFailure(error, lookupSignal, signal);
            if (!failure) throw error;
            return { songs: [] as CatalogSong[], failure };
          }
        }));

    // Ranking, duplicate decisions, and persistence remain serial in the
    // stable candidate order even though the independent catalog reads above
    // run concurrently.
    for (let offset = 0; offset < batch.length; offset += 1) {
      const workIndex = batchStart + offset;
      const { candidate, originalIndex } = batch[offset]!;
      const lookup = lookups[offset]!;
      let match = lookup.failure
        ? {
            candidateId: candidate.id,
            status: lookup.failure === "permanent" ? "unavailable" as const : "review" as const,
            basis: lookup.failure === "deadline"
              ? RETRYABLE_CATALOG_MATCH_BASES[1]
              : lookup.failure === "transient"
                ? RETRYABLE_CATALOG_MATCH_BASES[2]
                : "Apple Music rejected this candidate lookup; the remaining candidates were still matched",
            score: 0,
            song: null,
            alternatives: [],
          }
        : rankCatalogMatches(candidate.id, candidate, lookup.songs);
      match = applyV2VersionPolicy(run, candidate, match, lookup.songs);
      const possibleDuplicate = Boolean(candidate.duplicateClusterKey && (clusterCounts.get(candidate.duplicateClusterKey) ?? 0) > 1);
      const versionPolicyConflict = match.basis.includes(VERSION_POLICY_CONFLICT_BASIS);
      if (!versionPolicyConflict && match.status === "accepted" && match.song && acceptedCatalogIds.has(match.song.id)) {
        match = {
          ...match,
          status: "duplicate",
          basis: `Stable Apple catalog ID ${match.song.id} was already accepted for this run`,
        };
      } else if (!versionPolicyConflict && possibleDuplicate) {
        match = {
          ...match,
          status: "review",
          basis: `Possible duplicate cluster ${candidate.duplicateClusterKey}; metadata similarity does not prove recording identity`,
        };
      } else if (!versionPolicyConflict && !isEvidenceEligible(run.brief, candidate, run.selectionPlan)) {
        match = { ...match, status: "review", basis: ineligibleEvidenceBasis(run.brief, candidate) };
      }
      await repository.saveMatch(runId, match);
      const musicBrainzIdentity = run.pipelineVersion === "catalog_first_v2"
        ? await (options.musicBrainzEnricher ?? enrichMusicBrainzIdentity)(
          repository,
          runId,
          candidate,
          match,
          signal,
        )
        : null;
      if (musicBrainzIdentity) candidate.musicbrainzId = musicBrainzIdentity.recordingId;
      await persistCatalogResolution(
        repository,
        runId,
        run,
        candidate,
        match,
        normalizedStorefront,
        musicBrainzIdentity,
      );
      if (match.status === "accepted" && match.song) acceptedCatalogIds.add(match.song.id);
      await repository.saveResearchCheckpoint(runId, checkpointPhase, {
        nextIndex: recovery ? workIndex + 1 : originalIndex + 1,
        storefront: normalizedStorefront,
        complete: false,
        deadlineAt,
        startedAt,
        updatedAt: new Date().toISOString(),
      });
    }
  }
  if (!deadlineExhausted) {
    await repository.saveResearchCheckpoint(runId, checkpointPhase, {
      nextIndex: recovery ? work.length : allCandidates.length,
      storefront: normalizedStorefront,
      complete: true,
      deadlineAt,
      startedAt,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  await finalizeMatchingOutcome(
    repository,
    runId,
    run,
    normalizedStorefront,
    options.recoveryGeneration,
    refillGeneration,
  );
}

export async function processMatchingJob(repository: MatchingRepository, payload: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
  const runId = typeof payload.runId === "string" ? payload.runId : "";
  const storefront = typeof payload.storefront === "string" ? payload.storefront : process.env.APPLE_STOREFRONT ?? "br";
  if (!runId) throw new Error("Matching job payload is invalid");
  await matchResearchRun(repository, runId, storefront, signal, {
    fast: payload.fast === true,
    fastConfirmedAt: typeof payload.fastConfirmedAt === "string" ? payload.fastConfirmedAt : undefined,
    fastResearchDeadlineAt: typeof payload.fastResearchDeadlineAt === "string" ? payload.fastResearchDeadlineAt : undefined,
    fastDeadlineAt: typeof payload.fastDeadlineAt === "string" ? payload.fastDeadlineAt : undefined,
    retryIncomplete: payload.retryIncomplete === true,
    recoveryGeneration: Number.isInteger(payload.recoveryGeneration)
      ? Math.max(0, Math.min(3, Number(payload.recoveryGeneration)))
      : 0,
    refillGeneration: Number.isInteger(payload.refillGeneration)
      ? Math.max(0, Math.min(FAST_POST_MATCH_REFILL_LIMIT, Number(payload.refillGeneration)))
      : 0,
  });
}
