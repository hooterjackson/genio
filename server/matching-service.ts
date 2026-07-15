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
  FAST_MATCHING_FINALIZATION_RESERVE_MS,
  parseFastRouteCheckpoint,
  researchExecutionPolicy,
} from "./research-policy.ts";

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

export interface MatchingRepository {
  getRun(runId: string): Promise<{ brief: PlaylistBrief; createdAt?: string }>;
  updateRun(runId: string, patch: { status?: string; phase?: string; error?: string | null }): Promise<void>;
  listCandidates(runId: string): Promise<Candidate[]>;
  listMatches(runId: string): Promise<ExistingMatch[]>;
  saveMatch(runId: string, match: CatalogMatchResult): Promise<void>;
  saveTimeoutMatches(runId: string, candidateIds: string[], basis: string): Promise<void>;
  getResearchCheckpoint(runId: string, phase: string): Promise<unknown | null>;
  saveResearchCheckpoint(runId: string, phase: string, checkpoint: unknown): Promise<void>;
}

function boundedEnvironmentInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : fallback;
}

export function matchingConcurrency(): number {
  return boundedEnvironmentInteger("APPLE_MATCHING_CONCURRENCY", 8, 1, 12);
}

export function catalogRecoveryDeadlineMs(): number {
  return boundedEnvironmentInteger("APPLE_CATALOG_RECOVERY_TIMEOUT_MS", 45_000, 10_000, 60_000);
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

  // Start with the most discriminating metadata, then progressively remove
  // fields that research sources commonly misattribute or omit.
  add(artist, title, album);
  add(artist, title);
  if (baseTitle && baseTitle !== normalizeMusicText(title)) add(artist, baseTitle);
  if (album) add(title, album);
  add(title);
  return queries;
}

export async function lookupCandidateSongs(
  candidate: Candidate,
  storefront: string,
  signal?: AbortSignal,
): Promise<CatalogSong[]> {
  let songs = candidate.isrc ? await lookupAppleCatalogByIsrc(storefront, candidate.isrc, signal) : [];
  if (hasDirectCatalogMatch(candidate, songs)) return songs;

  const maximumQueries = boundedEnvironmentInteger("APPLE_MATCH_MAX_QUERIES", 5, 1, 5);
  for (const query of catalogSearchQueries(candidate).slice(0, maximumQueries)) {
    signal?.throwIfAborted();
    const results = await searchAppleCatalog(storefront, query, signal);
    songs = mergeCatalogSongs(songs, results);
    if (hasDirectCatalogMatch(candidate, songs)) break;
  }
  return songs;
}

type FastLookupFailure = "deadline" | "transient";

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
  } = {},
): Promise<void> {
  if (!/^[a-z]{2}$/i.test(storefront)) throw new Error("Apple storefront must be a two-letter code");
  const normalizedStorefront = storefront.toLowerCase();
  const run = await repository.getRun(runId);
  const recovery = options.retryIncomplete === true;
  const checkpointPhase = recovery ? "catalog_matching_recovery" : "catalog_matching";
  const checkpoint = recovery
    ? null
    : await repository.getResearchCheckpoint(runId, checkpointPhase) as MatchingCheckpoint | null;
  if (!recovery && checkpoint?.complete && checkpoint.storefront === normalizedStorefront) {
    await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review", error: null });
    return;
  }
  const start = checkpoint?.storefront === normalizedStorefront ? checkpoint.nextIndex : 0;
  const executionPolicy = researchExecutionPolicy(run.brief);
  let routeKey: string | null = null;
  let route = null;
  if (executionPolicy.kind === "fast_curated") {
    routeKey = `fast:route:${executionPolicy.version}`;
    route = parseFastRouteCheckpoint(
      await repository.getResearchCheckpoint(runId, routeKey),
      executionPolicy.version,
    );
  }
  const fast = options.fast === true || Boolean(route);
  let routeDeadlineAt: string | undefined;
  if (fast) {
    if (executionPolicy.kind !== "fast_curated" || !routeKey) throw new Error("Fast matching requires a curated brief");
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
                  boundedEnvironmentInteger("FAST_MATCH_LOOKUP_TIMEOUT_MS", 7_000, 3_000, 12_000),
                ))),
              ])
            : signal;
          try {
            return { songs: await lookupCandidateSongs(candidate, normalizedStorefront, lookupSignal), failure: null };
          } catch (error) {
            if (signal?.aborted) throw error;
            if (!boundedByDeadline) throw error;
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
            status: "review" as const,
            basis: lookup.failure === "deadline"
              ? RETRYABLE_CATALOG_MATCH_BASES[1]
              : RETRYABLE_CATALOG_MATCH_BASES[2],
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
  await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review" });
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
  });
}
