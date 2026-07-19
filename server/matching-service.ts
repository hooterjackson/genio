import type { CatalogMatchResult, CatalogSong, EvidenceClaimInput, PlaylistBrief, TrackCandidateInput } from "../shared/types.ts";
import {
  AppleApiError,
  AppleAuthorizationRequiredError,
  lookupAppleCatalogByIsrc,
  searchAppleCatalog,
} from "./apple.ts";
import {
  hasDirectCatalogMatch,
  mergeCatalogSongs,
  normalizeMusicBaseTitle,
  normalizeMusicText,
  rankCatalogMatches,
} from "../lib/matching.ts";
import { resolveEvidenceSubjectBinding } from "./evidence-binding.ts";
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
  researchExecutionPolicy,
} from "./research-policy.ts";
import {
  desiredPlaylistArtistCount,
  playlistArtistKey,
} from "../lib/playlist-selection.ts";

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

export interface MatchingRepository {
  getRun(runId: string): Promise<{
    brief: PlaylistBrief;
    status: string;
    phase?: string;
    autoPublish?: boolean;
    createdAt?: string;
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
}

const MATCHING_OUTCOME_CHECKPOINT = "catalog_matching_outcome";
const AUTOMATIC_HANDOFF_TERMINAL_STATUSES = new Set([
  "publishing",
  "waiting_for_apple_authorization",
  "complete",
  "partial",
  "failed",
  "expired",
  "deleted",
]);

function isSafePrimaryMatch(match: ExistingMatch, automatic: boolean): boolean {
  // One Command has no visitor review step, so only strict accepted matches
  // are safe to publish automatically. Manual bulk review may still present a
  // concrete review-row primary as a selectable visitor choice.
  return (match.status === "accepted" || (!automatic && match.status === "review"))
    && Boolean(match.song?.id);
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
  run: { brief: PlaylistBrief; status: string; autoPublish?: boolean },
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
  const matches = await repository.listMatches(runId);
  const safePrimaryMatches = matches
    .filter((match) => isSafePrimaryMatch(match, latest.autoPublish === true));
  const uniqueSafePrimaryMatches = [...new Map(safePrimaryMatches.map((match) => [
    match.song!.id,
    match,
  ])).values()];
  const safePrimaryCount = uniqueSafePrimaryMatches.length;
  const configuredMinimum = Number(brief.targetSize?.min);
  const targetMinimum = brief.targetSize && Number.isFinite(configuredMinimum)
    ? Math.max(0, Math.floor(configuredMinimum))
    : null;
  const shortfall = targetMinimum === null ? 0 : Math.max(0, targetMinimum - safePrimaryCount);
  const candidates = await repository.listCandidates(runId);
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

  if (latest.autoPublish) {
    const exactTarget = targetMinimum !== null
      && Number(brief.targetSize?.max) === targetMinimum;
    const policy = researchExecutionPolicy(brief);
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

export function matchingConcurrency(): number {
  return boundedEnvironmentInteger("APPLE_MATCHING_CONCURRENCY", 8, 1, 12);
}

export function catalogRecoveryDeadlineMs(): number {
  // Recovery is the accuracy path after the bounded fast route. The old
  // 45-second ceiling could repeatedly time out the same tail of a 100-track
  // run before Apple's broader searches had a chance to complete.  Keep the
  // fast route bounded, but give one recovery generation enough time to
  // actually settle a medium playlist.
  return boundedEnvironmentInteger("APPLE_CATALOG_RECOVERY_TIMEOUT_MS", 90_000, 90_000, 180_000);
}

export function catalogLookupTimeoutMs(recovery: boolean): number {
  const fastTimeout = boundedEnvironmentInteger("FAST_MATCH_LOOKUP_TIMEOUT_MS", 7_000, 3_000, 12_000);
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
): Promise<CatalogSong[]> {
  let songs = candidate.isrc ? await lookupAppleCatalogByIsrc(storefront, candidate.isrc, signal) : [];
  if (hasDirectCatalogMatch(candidate, songs)) return songs;

  const maximumQueries = boundedEnvironmentInteger("APPLE_MATCH_MAX_QUERIES", 8, 1, 8);
  for (const query of catalogSearchQueries(candidate).slice(0, maximumQueries)) {
    signal?.throwIfAborted();
    const results = await searchAppleCatalog(storefront, query, signal);
    songs = mergeCatalogSongs(songs, results);
    if (hasDirectCatalogMatch(candidate, songs)) break;
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

function isEvidenceEligible(brief: PlaylistBrief, candidate: Candidate): boolean {
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
  return brief.mode === "curated"
    ? states.has("editorial") || states.has("verified") || states.has("corroborated")
    : states.has("verified") || states.has("corroborated");
}

function ineligibleEvidenceBasis(brief: PlaylistBrief, candidate: Candidate): string {
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
  if (brief.mode !== "curated" && states.has("editorial") && !states.has("verified") && !states.has("corroborated")) {
    return "Editorial evidence is eligible only for curated prompts";
  }
  return "Evidence does not meet this playlist's automatic inclusion policy";
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
  } = {},
): Promise<void> {
  if (!/^[a-z]{2}$/i.test(storefront)) throw new Error("Apple storefront must be a two-letter code");
  const normalizedStorefront = storefront.toLowerCase();
  const run = await repository.getRun(runId);
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
  const executionPolicy = researchExecutionPolicy(run.brief);
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
    ? new Date(Date.now() + catalogRecoveryDeadlineMs()).toISOString()
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
  const allCandidates = await repository.listCandidates(runId);
  const existingMatches = await repository.listMatches(runId);
  const retryableCandidateIds = new Set(existingMatches
    .filter((match) => isRetryableCatalogMatch(match))
    .map((match) => match.candidateId));
  const existingCandidateIds = new Set(existingMatches.map((match) => match.candidateId));
  const work = allCandidates.flatMap((candidate, originalIndex) => {
    const shouldProcess = recovery
      ? retryableCandidateIds.has(candidate.id)
      : originalIndex >= start && !existingCandidateIds.has(candidate.id);
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
  const concurrency = matchingConcurrency();
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
                  catalogLookupTimeoutMs(recovery),
                ))),
              ])
            : signal;
          try {
            return { songs: await lookupCandidateSongs(candidate, normalizedStorefront, lookupSignal), failure: null };
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
      const possibleDuplicate = Boolean(candidate.duplicateClusterKey && (clusterCounts.get(candidate.duplicateClusterKey) ?? 0) > 1);
      if (match.status === "accepted" && match.song && acceptedCatalogIds.has(match.song.id)) {
        match = {
          ...match,
          status: "duplicate",
          basis: `Stable Apple catalog ID ${match.song.id} was already accepted for this run`,
        };
      } else if (possibleDuplicate) {
        match = {
          ...match,
          status: "review",
          basis: `Possible duplicate cluster ${candidate.duplicateClusterKey}; metadata similarity does not prove recording identity`,
        };
      } else if (!isEvidenceEligible(run.brief, candidate)) {
        match = { ...match, status: "review", basis: ineligibleEvidenceBasis(run.brief, candidate) };
      }
      await repository.saveMatch(runId, match);
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
