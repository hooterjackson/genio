import { createHash } from "node:crypto";
import type { CatalogSong, PipelinePolicyVersion } from "../shared/types.ts";
import {
  AppleApiError,
  AppleAuthorizationRequiredError,
  getAppleCatalogAlbumTracks,
  getAppleCatalogArtistAlbums,
  getAppleCatalogArtistTopSongs,
  getAppleCatalogPlaylistTracks,
  getAppleCatalogSimilarArtists,
  searchAppleCatalogResources,
  type AppleArtistAlbumView,
  type AppleCatalogAlbum,
  type AppleCatalogArtist,
  type AppleCatalogPage,
  type AppleCatalogPlaylist,
  type AppleCatalogSearchResult,
  type AppleCatalogSearchType,
} from "./apple.ts";
import {
  createControlledCatalogDiscoveryProvider,
  wasAppleProviderCircuitOpening,
} from "./apple-provider-control.ts";
import { adaptiveDiscoveryPlan } from "./pipeline-v2-policy.ts";

export type CatalogDiscoveryRound = "A" | "B" | "C" | "D";

export type CatalogDiscoveryStrategyKind =
  | "direct_search"
  | "trusted_scoped_playlist"
  | "seed_artist_top_songs"
  | "artist_singles"
  | "selected_album_tracks"
  | "artist_full_albums"
  | "artist_appears_on"
  | "similar_artists"
  | "similar_artist_top_songs"
  | "deep_pagination"
  | "deficit_search";

export type CatalogDiscoveryStrategyStatus =
  | "pending"
  | "running"
  | "deferred"
  | "complete"
  | "exhausted"
  | "invalid_cursor"
  | "failed";

export interface CatalogDiscoverySeedArtist {
  id: string;
  name: string;
}

export interface CatalogDiscoverySeedAlbum {
  id: string;
  /** Scope bindings are external evidence identifiers, never Apple IDs. */
  scopeBindingRefs?: readonly string[];
}

export interface CatalogDiscoveryScopedPlaylist {
  id: string;
  /** Required: a playlist ID by itself is catalog metadata, not relevance evidence. */
  scopeBindingRefs: readonly string[];
}

export interface CatalogDiscoveryContext {
  round: CatalogDiscoveryRound;
  strategyId: string;
  strategyKind: CatalogDiscoveryStrategyKind;
  query: string | null;
  containerType: "search" | "playlist" | "album" | "artist";
  containerId: string | null;
  inheritedScopeBindingRefs: string[];
}

export interface CatalogEligibilityDecision {
  eligible: boolean;
  /** Auditable evidence IDs. Empty bindings always force ineligibility. */
  scopeBindingRefs: readonly string[];
  reasonCode: string;
}

export interface CatalogDiscoveryCandidate {
  song: CatalogSong;
  eligible: boolean;
  scopeBindingRefs: string[];
  contexts: CatalogDiscoveryContext[];
  reasonCodes: string[];
}

export interface CatalogDiscoveryStrategyState {
  id: string;
  round: CatalogDiscoveryRound;
  kind: CatalogDiscoveryStrategyKind;
  status: CatalogDiscoveryStrategyStatus;
  cursor: string | null;
  pagesAttempted: number;
  maxPages: number;
  zeroYieldPages: number;
  discoveredCount: number;
  qualifiedCount: number;
  lastReasonCode: string | null;
  /** Everything required to restart this exact frontier position. */
  resourceKind: WorkItem["resourceKind"];
  searchTypes?: AppleCatalogSearchType[];
  query: string | null;
  resourceId: string | null;
  artistAlbumView: AppleArtistAlbumView | null;
  inheritedScopeBindingRefs: string[];
  /** True only for a provider failure that a later run may safely retry. */
  retryable: boolean;
}

export const CATALOG_DISCOVERY_PROGRESS_VERSION = "catalog_discovery_progress_v1" as const;

/**
 * Serializable progress after a fully evaluated provider page. The snapshot
 * is deliberately bounded and versioned so durable workers can reject an
 * incompatible or truncated resume instead of silently replaying work.
 */
export interface CatalogDiscoveryProgressSnapshot {
  version: typeof CATALOG_DISCOVERY_PROGRESS_VERSION;
  sequence: number;
  storefront: string;
  target: number;
  requestFingerprint: string;
  providerCallCount: number;
  totalQualifiedCount: number;
  totalAttemptedCount: number;
  candidates: CatalogDiscoveryCandidate[];
  frontier: CatalogDiscoveryStrategyState[];
  roundsCompleted: CatalogDiscoveryRound[];
  seedArtists: CatalogDiscoverySeedArtist[];
  selectedAlbums: CatalogDiscoverySeedAlbum[];
  fullAlbums: CatalogDiscoverySeedAlbum[];
}

export interface CatalogDiscoverySizePolicy {
  policyVersion: PipelinePolicyVersion;
  tier: 25 | 50 | 100 | 200 | 300;
  deadlineMs: number;
  maxPagesPerStrategy: number;
  maxTotalProviderCalls: number;
}

export interface CatalogDiscoveryProvider {
  search(
    storefront: string,
    query: string,
    types: readonly AppleCatalogSearchType[],
    limit: number,
    signal?: AbortSignal,
    cursor?: string | null,
  ): Promise<AppleCatalogSearchResult>;
  playlistTracks(
    storefront: string,
    playlistId: string,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<AppleCatalogPage<CatalogSong>>;
  albumTracks(
    storefront: string,
    albumId: string,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<AppleCatalogPage<CatalogSong>>;
  artistTopSongs(
    storefront: string,
    artistId: string,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<AppleCatalogPage<CatalogSong>>;
  artistAlbums(
    storefront: string,
    artistId: string,
    view: AppleArtistAlbumView,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<AppleCatalogPage<AppleCatalogAlbum>>;
  similarArtists(
    storefront: string,
    artistId: string,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<AppleCatalogPage<AppleCatalogArtist>>;
}

const unthrottledAppleCatalogDiscoveryProvider: CatalogDiscoveryProvider = {
  search: searchAppleCatalogResources,
  playlistTracks: getAppleCatalogPlaylistTracks,
  albumTracks: getAppleCatalogAlbumTracks,
  artistTopSongs: getAppleCatalogArtistTopSongs,
  artistAlbums: getAppleCatalogArtistAlbums,
  similarArtists: getAppleCatalogSimilarArtists,
};
export const liveAppleCatalogDiscoveryProvider: CatalogDiscoveryProvider =
  createControlledCatalogDiscoveryProvider(unthrottledAppleCatalogDiscoveryProvider);

export interface CuratedCatalogDiscoveryRequest {
  storefront: string;
  query: string;
  target: number;
  concurrency: number;
  aliases?: readonly string[];
  deficitQueries?: readonly string[];
  seedArtists?: readonly CatalogDiscoverySeedArtist[];
  selectedAlbums?: readonly CatalogDiscoverySeedAlbum[];
  fullAlbums?: readonly CatalogDiscoverySeedAlbum[];
  scopedPlaylists?: readonly CatalogDiscoveryScopedPlaylist[];
  maxPagesPerStrategy?: number;
  maxTotalProviderCalls?: number;
  /** Preferred durable resume contract. Cannot be mixed with legacy counters. */
  resumeProgress?: CatalogDiscoveryProgressSnapshot;
  /** Durable retry state. Cursors are validated again before any request. */
  resumeFrontier?: readonly CatalogDiscoveryStrategyState[];
  /** Already-qualified and already-attempted rows from prior passes. */
  initialQualifiedCount?: number;
  initialAttemptedCount?: number;
  signal?: AbortSignal;
  /** Optional constituent signal used to distinguish a deadline from a caller cancellation. */
  deadlineSignal?: AbortSignal;
  /**
   * Evaluates relevance/evidence outside Apple. The orchestrator intentionally
   * cannot infer relevance from an Apple identity, genre string, artist view,
   * or playlist membership on its own.
   */
  evaluate(
    song: CatalogSong,
    context: CatalogDiscoveryContext,
  ): Promise<CatalogEligibilityDecision> | CatalogEligibilityDecision;
  /** Optionally promotes a discovered Apple playlist only after external trust. */
  trustDiscoveredPlaylist?(
    playlist: AppleCatalogPlaylist,
    query: string,
  ): readonly string[] | null;
  /**
   * Called exactly once after each fetched page is fully applied to candidates
   * and frontier state. Rejection aborts discovery immediately; progress is
   * never acknowledged in memory after a failed durable write.
   */
  onCheckpoint?(
    snapshot: CatalogDiscoveryProgressSnapshot,
  ): Promise<void> | void;
}

export type CatalogDiscoveryStopReason =
  | "target_and_reserve"
  | "provider_call_limit"
  | "timed_out"
  | "aborted"
  | "provider_circuit_open"
  | "provider_degraded"
  | "policy_conflict"
  | "zero_yield_exhausted"
  | "frontier_exhausted";

export interface CuratedCatalogDiscoveryResult {
  target: number;
  qualifiedGoal: number;
  reserve: number;
  candidates: CatalogDiscoveryCandidate[];
  qualified: CatalogDiscoveryCandidate[];
  frontier: CatalogDiscoveryStrategyState[];
  roundsCompleted: CatalogDiscoveryRound[];
  providerCallCount: number;
  totalQualifiedCount: number;
  totalAttemptedCount: number;
  stoppedBecause: CatalogDiscoveryStopReason;
  progress: CatalogDiscoveryProgressSnapshot;
}

interface WorkItem {
  id: string;
  round: CatalogDiscoveryRound;
  kind: CatalogDiscoveryStrategyKind;
  resourceKind: "search" | "playlist" | "album" | "artist_top" | "artist_albums" | "similar_artists";
  searchTypes: AppleCatalogSearchType[];
  query: string | null;
  resourceId: string | null;
  artistAlbumView: AppleArtistAlbumView | null;
  cursor: string | null;
  inheritedScopeBindingRefs: string[];
  pagesAttempted: number;
  maxPages: number;
  zeroYieldPages: number;
  discoveredCount: number;
  qualifiedCount: number;
  status: CatalogDiscoveryStrategyStatus;
  lastReasonCode: string | null;
  retryable: boolean;
}

interface PageResult {
  item: WorkItem;
  songs: CatalogSong[];
  artists: AppleCatalogArtist[];
  albums: AppleCatalogAlbum[];
  playlists: AppleCatalogPlaylist[];
  next: string | null;
  searchNext: Partial<Record<AppleCatalogSearchType, string>>;
  failedReason: string | null;
  failureClass: "transient" | "permanent" | "invalid_cursor" | null;
}

const ROUND_ORDER: readonly CatalogDiscoveryRound[] = ["A", "B", "C", "D"];
const DEFAULT_MAX_PAGES = 4;
const DEFAULT_MAX_PROVIDER_CALLS = 80;
const ZERO_YIELD_PAGE_LIMIT = 2;
const MAX_SEED_ARTISTS = 8;
const MAX_DYNAMIC_ALBUMS = 16;
const MAX_CHECKPOINT_CANDIDATES = 50_000;
const MAX_CHECKPOINT_FRONTIER_ITEMS = 2_000;
const MAX_CHECKPOINT_CONTEXTS_PER_CANDIDATE = 64;
const MAX_CHECKPOINT_SEQUENCE = 1_000_000_000;
const STRATEGY_KINDS = new Set<CatalogDiscoveryStrategyKind>([
  "direct_search", "trusted_scoped_playlist", "seed_artist_top_songs", "artist_singles",
  "selected_album_tracks", "artist_full_albums", "artist_appears_on", "similar_artists",
  "similar_artist_top_songs", "deep_pagination", "deficit_search",
]);
const SEARCH_TYPES = new Set<AppleCatalogSearchType>(["songs", "artists", "albums", "playlists"]);
const ARTIST_ALBUM_VIEWS = new Set<AppleArtistAlbumView>([
  "appears-on-albums", "compilation-albums", "featured-albums", "full-albums",
  "latest-release", "live-albums", "singles",
]);

const CATALOG_SIZE_POLICIES: readonly CatalogDiscoverySizePolicy[] = Object.freeze([
  Object.freeze({ policyVersion: "relevance_first_2026_07", tier: 25, deadlineMs: 30_000, maxPagesPerStrategy: 4, maxTotalProviderCalls: 48 }),
  Object.freeze({ policyVersion: "relevance_first_2026_07", tier: 50, deadlineMs: 45_000, maxPagesPerStrategy: 5, maxTotalProviderCalls: 80 }),
  Object.freeze({ policyVersion: "relevance_first_2026_07", tier: 100, deadlineMs: 90_000, maxPagesPerStrategy: 6, maxTotalProviderCalls: 140 }),
  Object.freeze({ policyVersion: "relevance_first_2026_07", tier: 200, deadlineMs: 180_000, maxPagesPerStrategy: 8, maxTotalProviderCalls: 260 }),
  Object.freeze({ policyVersion: "relevance_first_2026_07", tier: 300, deadlineMs: 300_000, maxPagesPerStrategy: 10, maxTotalProviderCalls: 400 }),
]);

/** Immutable execution limits selected from the requested output tier. */
export function catalogDiscoverySizePolicy(
  target: number,
  policyVersion: PipelinePolicyVersion = "relevance_first_2026_07_r2",
): Readonly<CatalogDiscoverySizePolicy> {
  if (policyVersion !== "relevance_first_2026_07"
    && policyVersion !== "relevance_first_2026_07_r2") {
    throw new Error(`Unsupported catalog discovery policy: ${policyVersion}`);
  }
  const bounded = Math.max(1, Math.min(300, Math.floor(Number.isFinite(target) ? target : 50)));
  const policy = CATALOG_SIZE_POLICIES.find((candidate) => bounded <= candidate.tier) ?? CATALOG_SIZE_POLICIES.at(-1)!;
  return policy.policyVersion === policyVersion ? policy : Object.freeze({ ...policy, policyVersion });
}

export function boundedCatalogConcurrency(requested: number): number {
  if (!Number.isFinite(requested)) return 6;
  return Math.max(2, Math.min(8, Math.floor(requested)));
}

/** Deterministic, provider-free scheduler. Output order always matches input. */
export async function scheduleCatalogTasks<T, R>(
  items: readonly T[],
  requestedConcurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const concurrency = Math.min(items.length, boundedCatalogConcurrency(requestedConcurrency));
  if (concurrency === 0) return [];
  const output = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await worker(items[index]!, index);
    }
  }));
  return output;
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value!)));
}

function normalizedStorefront(value: string): string {
  const storefront = value.trim().toLowerCase();
  if (!/^[a-z]{2}$/u.test(storefront)) throw new Error("Apple storefront must be a two-letter code");
  return storefront;
}

function stableUnique(values: readonly string[], maximum = 32): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLocaleLowerCase("en-US");
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= maximum) break;
  }
  return output;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function discoveryRequestFingerprint(input: {
  queryTerms: readonly string[];
  deficitQueries: readonly string[];
  seedArtists: readonly CatalogDiscoverySeedArtist[];
  selectedAlbums: readonly CatalogDiscoverySeedAlbum[];
  fullAlbums: readonly CatalogDiscoverySeedAlbum[];
  scopedPlaylists: readonly CatalogDiscoveryScopedPlaylist[];
  maxPages: number;
  maxProviderCalls: number;
}): string {
  const payload = {
    queryTerms: [...input.queryTerms],
    deficitQueries: [...input.deficitQueries],
    seedArtists: input.seedArtists.map((artist) => ({ id: artist.id, name: artist.name })),
    selectedAlbums: input.selectedAlbums.map((album) => ({
      id: album.id,
      scopeBindingRefs: stableUnique(album.scopeBindingRefs ?? [], 64),
    })),
    fullAlbums: input.fullAlbums.map((album) => ({
      id: album.id,
      scopeBindingRefs: stableUnique(album.scopeBindingRefs ?? [], 64),
    })),
    scopedPlaylists: input.scopedPlaylists.map((playlist) => ({
      id: playlist.id,
      scopeBindingRefs: stableUnique(playlist.scopeBindingRefs, 64),
    })),
    maxPages: input.maxPages,
    maxProviderCalls: input.maxProviderCalls,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function copySeedAlbum(album: CatalogDiscoverySeedAlbum): CatalogDiscoverySeedAlbum {
  return {
    id: album.id,
    scopeBindingRefs: stableUnique(album.scopeBindingRefs ?? [], 64),
  };
}

function mergeSeedAlbum(
  existing: CatalogDiscoverySeedAlbum | undefined,
  incoming: CatalogDiscoverySeedAlbum,
): CatalogDiscoverySeedAlbum {
  return {
    id: incoming.id,
    scopeBindingRefs: stableUnique([
      ...(existing?.scopeBindingRefs ?? []),
      ...(incoming.scopeBindingRefs ?? []),
    ], 64),
  };
}

function checkpointInteger(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`Invalid catalog discovery checkpoint ${field}`);
  }
  return value;
}

function contextKey(context: CatalogDiscoveryContext): string {
  return [
    context.round,
    context.strategyId,
    context.strategyKind,
    context.containerType,
    context.containerId ?? "",
    context.query ?? "",
    ...context.inheritedScopeBindingRefs,
  ].join("\u0000");
}

function boundedCandidateContexts(
  contexts: readonly CatalogDiscoveryContext[],
): CatalogDiscoveryContext[] {
  const seen = new Set<string>();
  const output: CatalogDiscoveryContext[] = [];
  for (const context of contexts) {
    const copy: CatalogDiscoveryContext = {
      ...context,
      inheritedScopeBindingRefs: stableUnique(context.inheritedScopeBindingRefs ?? [], 64),
    };
    const key = contextKey(copy);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(copy);
    if (output.length >= MAX_CHECKPOINT_CONTEXTS_PER_CANDIDATE) break;
  }
  return output;
}

function copyCheckpointCandidate(candidate: CatalogDiscoveryCandidate): CatalogDiscoveryCandidate {
  return {
    song: {
      ...candidate.song,
      ...(candidate.song.genreNames ? { genreNames: [...candidate.song.genreNames] } : {}),
    },
    eligible: candidate.eligible,
    scopeBindingRefs: stableUnique(candidate.scopeBindingRefs ?? [], 64),
    contexts: boundedCandidateContexts(candidate.contexts ?? []),
    reasonCodes: stableUnique(candidate.reasonCodes ?? [], 64),
  };
}

function assertResumeProgress(
  snapshot: CatalogDiscoveryProgressSnapshot,
  storefront: string,
  target: number,
  requestFingerprint: string,
): void {
  if (snapshot.version !== CATALOG_DISCOVERY_PROGRESS_VERSION) {
    throw new Error("Unsupported catalog discovery checkpoint version");
  }
  if (snapshot.storefront !== storefront || snapshot.target !== target
    || snapshot.requestFingerprint !== requestFingerprint) {
    throw new Error("Catalog discovery checkpoint does not match the request");
  }
  checkpointInteger(snapshot.sequence, "sequence", MAX_CHECKPOINT_SEQUENCE);
  checkpointInteger(snapshot.providerCallCount, "providerCallCount", 500);
  checkpointInteger(snapshot.totalAttemptedCount, "totalAttemptedCount", Number.MAX_SAFE_INTEGER);
  checkpointInteger(snapshot.totalQualifiedCount, "totalQualifiedCount", Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(snapshot.candidates) || snapshot.candidates.length > MAX_CHECKPOINT_CANDIDATES) {
    throw new Error("Catalog discovery checkpoint candidate bound exceeded");
  }
  if (!Array.isArray(snapshot.frontier) || snapshot.frontier.length > MAX_CHECKPOINT_FRONTIER_ITEMS) {
    throw new Error("Catalog discovery checkpoint frontier bound exceeded");
  }
  if (!Array.isArray(snapshot.roundsCompleted)
    || snapshot.roundsCompleted.some((round) => !ROUND_ORDER.includes(round))) {
    throw new Error("Catalog discovery checkpoint rounds are invalid");
  }
  if (!Array.isArray(snapshot.seedArtists) || snapshot.seedArtists.length > MAX_SEED_ARTISTS
    || snapshot.seedArtists.some((artist) => typeof artist?.id !== "string" || !artist.id
      || typeof artist.name !== "string" || !artist.name)
    || !Array.isArray(snapshot.selectedAlbums) || snapshot.selectedAlbums.length > MAX_DYNAMIC_ALBUMS
    || snapshot.selectedAlbums.some((album) => typeof album?.id !== "string" || !album.id
      || !isStringArray(album.scopeBindingRefs))
    || !Array.isArray(snapshot.fullAlbums) || snapshot.fullAlbums.length > MAX_DYNAMIC_ALBUMS
    || snapshot.fullAlbums.some((album) => typeof album?.id !== "string" || !album.id
      || !isStringArray(album.scopeBindingRefs))) {
    throw new Error("Catalog discovery checkpoint resources are invalid");
  }
  const candidateIds = new Set<string>();
  let eligibleCandidates = 0;
  for (const candidate of snapshot.candidates) {
    if (typeof candidate?.song?.id !== "string" || !candidate.song.id
      || candidateIds.has(candidate.song.id)
      || typeof candidate.eligible !== "boolean"
      || !Array.isArray(candidate.contexts)
      || candidate.contexts.length > MAX_CHECKPOINT_CONTEXTS_PER_CANDIDATE
      || candidate.contexts.some((context) => !context
        || !ROUND_ORDER.includes(context.round)
        || typeof context.strategyId !== "string" || !context.strategyId
        || !STRATEGY_KINDS.has(context.strategyKind)
        || !["search", "playlist", "album", "artist"].includes(context.containerType)
        || !(context.query === null || typeof context.query === "string")
        || !(context.containerId === null || typeof context.containerId === "string")
        || !isStringArray(context.inheritedScopeBindingRefs))
      || !isStringArray(candidate.scopeBindingRefs)
      || !isStringArray(candidate.reasonCodes)) {
      throw new Error("Catalog discovery checkpoint candidates are invalid");
    }
    candidateIds.add(candidate.song.id);
    if (candidate.eligible) eligibleCandidates += 1;
  }
  if (snapshot.totalAttemptedCount < snapshot.candidates.length
    || snapshot.totalQualifiedCount < eligibleCandidates
    || snapshot.totalQualifiedCount > snapshot.totalAttemptedCount) {
    throw new Error("Catalog discovery checkpoint counters are inconsistent");
  }
  const frontierIds = new Set<string>();
  for (const state of snapshot.frontier) {
    if (frontierIds.has(state.id) || !resumableWorkItem(state)) {
      throw new Error("Catalog discovery checkpoint frontier is invalid");
    }
    frontierIds.add(state.id);
  }
}

function safeIdPart(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 80) || "item";
}

function workIdentity(item: WorkItem): string {
  return JSON.stringify({
    round: item.round,
    kind: item.kind,
    resourceKind: item.resourceKind,
    searchTypes: item.searchTypes,
    query: item.query,
    resourceId: item.resourceId,
    artistAlbumView: item.artistAlbumView,
    inheritedScopeBindingRefs: [...item.inheritedScopeBindingRefs].sort(),
  });
}

function workIdentitySuffix(item: WorkItem): string {
  return createHash("sha256").update(workIdentity(item)).digest("hex").slice(0, 10);
}

function workItem(input: Omit<WorkItem, "cursor" | "pagesAttempted" | "zeroYieldPages" | "discoveredCount" | "qualifiedCount" | "status" | "lastReasonCode" | "retryable" | "searchTypes"> & {
  searchTypes?: readonly AppleCatalogSearchType[];
}): WorkItem {
  return {
    ...input,
    searchTypes: [...(input.searchTypes ?? [])],
    cursor: null,
    pagesAttempted: 0,
    zeroYieldPages: 0,
    discoveredCount: 0,
    qualifiedCount: 0,
    status: "pending",
    lastReasonCode: null,
    retryable: false,
  };
}

function resumableWorkItem(state: CatalogDiscoveryStrategyState): WorkItem | null {
  const validStatuses: readonly CatalogDiscoveryStrategyStatus[] = [
    "pending", "running", "deferred", "complete", "exhausted", "invalid_cursor", "failed",
  ];
  const validResources: readonly WorkItem["resourceKind"][] = [
    "search", "playlist", "album", "artist_top", "artist_albums", "similar_artists",
  ];
  if (!state.resourceKind || typeof state.id !== "string" || !state.id
    || !ROUND_ORDER.includes(state.round) || !STRATEGY_KINDS.has(state.kind)
    || !validStatuses.includes(state.status) || !validResources.includes(state.resourceKind)
    || !Number.isSafeInteger(state.pagesAttempted) || state.pagesAttempted < 0
    || !Number.isSafeInteger(state.maxPages) || state.maxPages < 1 || state.maxPages > 20
    || !Number.isSafeInteger(state.zeroYieldPages) || state.zeroYieldPages < 0
    || !Number.isSafeInteger(state.discoveredCount) || state.discoveredCount < 0
    || !Number.isSafeInteger(state.qualifiedCount) || state.qualifiedCount < 0
    || typeof state.retryable !== "boolean"
    || !(state.lastReasonCode === null || typeof state.lastReasonCode === "string")
    || !(state.cursor === null || typeof state.cursor === "string")
    || !(state.query === null || typeof state.query === "string")
    || !(state.resourceId === null || typeof state.resourceId === "string")
    || !(state.artistAlbumView === null || ARTIST_ALBUM_VIEWS.has(state.artistAlbumView))
    || !isStringArray(state.inheritedScopeBindingRefs)
    || (state.searchTypes !== undefined
      && (!isStringArray(state.searchTypes)
        || state.searchTypes.some((type) => !SEARCH_TYPES.has(type as AppleCatalogSearchType))))
    || (state.resourceKind === "search" && (!state.query || state.resourceId !== null))
    || (state.resourceKind !== "search" && !state.resourceId)
    || (state.resourceKind === "artist_albums" && !state.artistAlbumView)
    || (state.resourceKind !== "artist_albums" && state.artistAlbumView !== null)) return null;
  const retryTransient = state.status === "failed" && state.retryable;
  const interrupted = state.status === "running";
  return {
    id: state.id,
    round: state.round,
    kind: state.kind,
    resourceKind: state.resourceKind,
    searchTypes: state.searchTypes?.length
      ? [...state.searchTypes]
      : state.resourceKind === "search"
        ? ["songs", "artists", "albums", "playlists"]
        : [],
    query: state.query,
    resourceId: state.resourceId,
    artistAlbumView: state.artistAlbumView,
    cursor: state.cursor,
    inheritedScopeBindingRefs: stableUnique(state.inheritedScopeBindingRefs ?? [], 64),
    pagesAttempted: Math.max(0, state.pagesAttempted),
    maxPages: Math.max(1, state.maxPages),
    zeroYieldPages: Math.max(0, state.zeroYieldPages),
    discoveredCount: Math.max(0, state.discoveredCount),
    qualifiedCount: Math.max(0, state.qualifiedCount),
    status: retryTransient || interrupted ? "pending" : state.status,
    lastReasonCode: state.lastReasonCode,
    retryable: retryTransient || interrupted,
  };
}

function contextFor(item: WorkItem): CatalogDiscoveryContext {
  const containerType = item.resourceKind === "search"
    ? "search"
    : item.resourceKind === "playlist"
      ? "playlist"
      : item.resourceKind === "album"
        ? "album"
        : "artist";
  return {
    round: item.round,
    strategyId: item.id,
    strategyKind: item.kind,
    query: item.query,
    containerType,
    containerId: item.resourceId,
    inheritedScopeBindingRefs: [...item.inheritedScopeBindingRefs],
  };
}

function cursorPrefix(storefront: string, item: WorkItem): string | null {
  const id = item.resourceId;
  if (item.resourceKind === "search") return `/v1/catalog/${storefront}/search?`;
  if (!id) return null;
  if (item.resourceKind === "playlist") return `/v1/catalog/${storefront}/playlists/${encodeURIComponent(id)}/tracks`;
  if (item.resourceKind === "album") return `/v1/catalog/${storefront}/albums/${id}/tracks`;
  if (item.resourceKind === "artist_top") return `/v1/catalog/${storefront}/artists/${id}/view/top-songs`;
  if (item.resourceKind === "similar_artists") return `/v1/catalog/${storefront}/artists/${id}/view/similar-artists`;
  if (item.resourceKind === "artist_albums" && item.artistAlbumView) {
    return `/v1/catalog/${storefront}/artists/${id}/view/${item.artistAlbumView}`;
  }
  return null;
}

export function isSafeAppleCatalogCursor(
  storefront: string,
  item: Pick<WorkItem, "resourceKind" | "resourceId" | "artistAlbumView" | "query" | "searchTypes">,
  cursor: string,
): boolean {
  if (!cursor.startsWith("/") || cursor.startsWith("//") || cursor.includes("://") || cursor.includes("\\")) return false;
  const comparable = { ...item } as WorkItem;
  const prefix = cursorPrefix(storefront, comparable);
  if (!prefix) return false;
  const parsed = new URL(cursor, "https://api.music.apple.com");
  if (item.resourceKind !== "search") return parsed.pathname === prefix;
  if (parsed.pathname !== `/v1/catalog/${storefront}/search`) return false;
  const cursorTypes = (parsed.searchParams.get("types") ?? "").split(",").filter(Boolean);
  return parsed.searchParams.get("term") === item.query
    && cursorTypes.length > 0
    && cursorTypes.every((type) => item.searchTypes.includes(type as AppleCatalogSearchType));
}

function frontierState(item: WorkItem): CatalogDiscoveryStrategyState {
  return {
    id: item.id,
    round: item.round,
    kind: item.kind,
    status: item.status,
    cursor: item.cursor,
    pagesAttempted: item.pagesAttempted,
    maxPages: item.maxPages,
    zeroYieldPages: item.zeroYieldPages,
    discoveredCount: item.discoveredCount,
    qualifiedCount: item.qualifiedCount,
    lastReasonCode: item.lastReasonCode,
    resourceKind: item.resourceKind,
    searchTypes: [...item.searchTypes],
    query: item.query,
    resourceId: item.resourceId,
    artistAlbumView: item.artistAlbumView,
    inheritedScopeBindingRefs: [...item.inheritedScopeBindingRefs],
    retryable: item.retryable,
  };
}

function addWork(queue: WorkItem[], seen: Set<string>, item: WorkItem): void {
  if (seen.has(item.id)) {
    const existing = queue.find((queued) => queued.id === item.id);
    if (existing && workIdentity(existing) === workIdentity(item)) return;
    const baseId = item.id;
    item.id = `${baseId}:${workIdentitySuffix(item)}`;
    let collision = 1;
    while (seen.has(item.id)) {
      const colliding = queue.find((queued) => queued.id === item.id);
      if (colliding && workIdentity(colliding) === workIdentity(item)) return;
      item.id = `${baseId}:${workIdentitySuffix(item)}:${collision}`;
      collision += 1;
    }
  }
  seen.add(item.id);
  queue.push(item);
}

function mergeCatalogSong(existing: CatalogSong, incoming: CatalogSong): CatalogSong {
  const genreNames = stableUnique([
    ...(existing.genreNames ?? []),
    ...(incoming.genreNames ?? []),
  ], 64);
  return {
    id: existing.id,
    name: existing.name || incoming.name,
    artistName: existing.artistName || incoming.artistName,
    albumName: existing.albumName || incoming.albumName,
    ...(genreNames.length ? { genreNames } : {}),
    ...(existing.releaseDate || incoming.releaseDate ? { releaseDate: existing.releaseDate ?? incoming.releaseDate } : {}),
    ...(existing.durationInMillis !== undefined || incoming.durationInMillis !== undefined
      ? { durationInMillis: existing.durationInMillis ?? incoming.durationInMillis }
      : {}),
    ...(existing.isrc || incoming.isrc ? { isrc: existing.isrc ?? incoming.isrc } : {}),
    ...(existing.url || incoming.url ? { url: existing.url ?? incoming.url } : {}),
    ...(existing.artworkUrl || incoming.artworkUrl ? { artworkUrl: existing.artworkUrl ?? incoming.artworkUrl } : {}),
    ...(existing.versionLabel || incoming.versionLabel ? { versionLabel: existing.versionLabel ?? incoming.versionLabel } : {}),
    ...(existing.contentRating || incoming.contentRating ? { contentRating: existing.contentRating ?? incoming.contentRating } : {}),
  };
}

function qualifiedGoalFor(target: number, qualified: number, attempts: number): { reserve: number; goal: number; rawGoal: number } {
  const base = adaptiveDiscoveryPlan({ target, qualified, attempted: attempts, observedQualified: qualified });
  const goal = target + base.qualifiedReserve;
  const goalPlan = adaptiveDiscoveryPlan({ target: goal, qualified, attempted: attempts, observedQualified: qualified });
  const remaining = Math.max(0, goal - qualified);
  return {
    reserve: base.qualifiedReserve,
    goal,
    rawGoal: remaining === 0 ? 0 : Math.ceil(remaining / goalPlan.conservativeYield),
  };
}

async function fetchPage(
  provider: CatalogDiscoveryProvider,
  storefront: string,
  item: WorkItem,
  signal?: AbortSignal,
): Promise<PageResult> {
  try {
    if (item.cursor && !isSafeAppleCatalogCursor(storefront, item, item.cursor)) {
      return {
        item, songs: [], artists: [], albums: [], playlists: [], next: null,
        searchNext: {},
        failedReason: "invalid_cursor", failureClass: "invalid_cursor",
      };
    }
    if (item.resourceKind === "search") {
      const result = await provider.search(
        storefront,
        item.query ?? "",
        item.searchTypes,
        25,
        signal,
        item.cursor,
      );
      const continuedType = item.searchTypes.length === 1 ? item.searchTypes[0] : null;
      return {
        item,
        songs: result.songs,
        artists: result.artists,
        albums: result.albums,
        playlists: result.playlists,
        next: continuedType ? result.next?.[continuedType] ?? null : null,
        searchNext: result.next ?? {},
        failedReason: null,
        failureClass: null,
      };
    }
    if (item.resourceKind === "playlist") {
      const page = await provider.playlistTracks(storefront, item.resourceId!, item.cursor, signal);
      return { item, songs: page.items, artists: [], albums: [], playlists: [], next: page.next, searchNext: {}, failedReason: null, failureClass: null };
    }
    if (item.resourceKind === "album") {
      const page = await provider.albumTracks(storefront, item.resourceId!, item.cursor, signal);
      return { item, songs: page.items, artists: [], albums: [], playlists: [], next: page.next, searchNext: {}, failedReason: null, failureClass: null };
    }
    if (item.resourceKind === "artist_top") {
      const page = await provider.artistTopSongs(storefront, item.resourceId!, item.cursor, signal);
      return { item, songs: page.items, artists: [], albums: [], playlists: [], next: page.next, searchNext: {}, failedReason: null, failureClass: null };
    }
    if (item.resourceKind === "artist_albums") {
      const page = await provider.artistAlbums(storefront, item.resourceId!, item.artistAlbumView!, item.cursor, signal);
      return { item, songs: [], artists: [], albums: page.items, playlists: [], next: page.next, searchNext: {}, failedReason: null, failureClass: null };
    }
    const page = await provider.similarArtists(storefront, item.resourceId!, item.cursor, signal);
    return { item, songs: [], artists: page.items, albums: [], playlists: [], next: page.next, searchNext: {}, failedReason: null, failureClass: null };
  } catch (error) {
    const classified = classifyCatalogProviderFailure(error, signal);
    return {
      item,
      songs: [],
      artists: [],
      albums: [],
      playlists: [],
      next: null,
      searchNext: {},
      failedReason: classified.reasonCode,
      failureClass: classified.failureClass,
    };
  }
}

export function classifyCatalogProviderFailure(
  error: unknown,
  signal?: AbortSignal,
): { reasonCode: string; failureClass: "transient" | "permanent" } {
  if (wasAppleProviderCircuitOpening(error)) {
    return { reasonCode: "apple_provider_circuit_open", failureClass: "transient" };
  }
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
    return { reasonCode: "apple_request_timeout", failureClass: "transient" };
  }
  if (error instanceof AppleAuthorizationRequiredError) {
    return { reasonCode: "apple_authorization_required", failureClass: "permanent" };
  }
  if (error instanceof AppleApiError) {
    if (error.status === 400) return { reasonCode: "apple_bad_request", failureClass: "permanent" };
    if (error.status === 404) return { reasonCode: "apple_not_found", failureClass: "permanent" };
    if (error.status === 422) return { reasonCode: "apple_unprocessable", failureClass: "permanent" };
    if (error.status === 401 || error.status === 403) {
      return { reasonCode: "apple_unauthorized", failureClass: "permanent" };
    }
    if (error.status === 429) return { reasonCode: "apple_rate_limited", failureClass: "transient" };
    if (error.status !== null && error.status >= 500) {
      return { reasonCode: "apple_server_error", failureClass: "transient" };
    }
    return error.retriable
      ? { reasonCode: "apple_provider_transient", failureClass: "transient" }
      : { reasonCode: "apple_provider_permanent", failureClass: "permanent" };
  }
  // Adapters may throw a plain network error. It is safe to retry the whole
  // idempotent GET frontier, while malformed/4xx Apple responses above are not.
  return { reasonCode: "apple_network_error", failureClass: "transient" };
}

export async function discoverCuratedAppleCatalog(
  provider: CatalogDiscoveryProvider,
  request: CuratedCatalogDiscoveryRequest,
): Promise<CuratedCatalogDiscoveryResult> {
  const storefront = normalizedStorefront(request.storefront);
  const target = positiveInteger(request.target, 50, 1_000);
  if (request.resumeProgress && (
    request.resumeFrontier !== undefined
    || request.initialQualifiedCount !== undefined
    || request.initialAttemptedCount !== undefined
  )) {
    throw new Error("Catalog discovery progress cannot be mixed with legacy resume fields");
  }
  const maxPages = positiveInteger(request.maxPagesPerStrategy, DEFAULT_MAX_PAGES, 20);
  const maxProviderCalls = positiveInteger(request.maxTotalProviderCalls, DEFAULT_MAX_PROVIDER_CALLS, 500);
  const concurrency = boundedCatalogConcurrency(request.concurrency);
  const queryTerms = stableUnique([request.query, ...(request.aliases ?? [])], 8);
  const deficitQueries = stableUnique(request.deficitQueries ?? [], 8);
  const requestSeedArtists = (request.seedArtists ?? []).slice(0, MAX_SEED_ARTISTS);
  const requestSelectedAlbums = (request.selectedAlbums ?? []).slice(0, MAX_DYNAMIC_ALBUMS);
  const requestFullAlbums = (request.fullAlbums ?? []).slice(0, MAX_DYNAMIC_ALBUMS);
  const requestScopedPlaylists = [...(request.scopedPlaylists ?? [])];
  const requestFingerprint = discoveryRequestFingerprint({
    queryTerms,
    deficitQueries,
    seedArtists: requestSeedArtists,
    selectedAlbums: requestSelectedAlbums,
    fullAlbums: requestFullAlbums,
    scopedPlaylists: requestScopedPlaylists,
    maxPages,
    maxProviderCalls,
  });
  if (request.resumeProgress) {
    assertResumeProgress(request.resumeProgress, storefront, target, requestFingerprint);
  }
  const candidates = new Map<string, CatalogDiscoveryCandidate>();
  const allWork: WorkItem[] = [];
  const seenWork = new Set<string>();
  const seedArtists = new Map<string, CatalogDiscoverySeedArtist>();
  const selectedAlbums = new Map<string, CatalogDiscoverySeedAlbum>();
  const fullAlbums = new Map<string, CatalogDiscoverySeedAlbum>();
  for (const artist of request.resumeProgress?.seedArtists ?? []) seedArtists.set(artist.id, { ...artist });
  for (const album of request.resumeProgress?.selectedAlbums ?? []) {
    selectedAlbums.set(album.id, mergeSeedAlbum(selectedAlbums.get(album.id), album));
  }
  for (const album of request.resumeProgress?.fullAlbums ?? []) {
    fullAlbums.set(album.id, mergeSeedAlbum(fullAlbums.get(album.id), album));
  }
  for (const candidate of request.resumeProgress?.candidates ?? []) {
    const restored = copyCheckpointCandidate(candidate);
    candidates.set(restored.song.id, restored);
  }
  let providerCallCount = request.resumeProgress?.providerCallCount ?? 0;
  let checkpointSequence = request.resumeProgress?.sequence ?? 0;
  const roundsCompleted: CatalogDiscoveryRound[] = [...(request.resumeProgress?.roundsCompleted ?? [])];
  const restoredEligibleCount = [...candidates.values()].filter((candidate) => candidate.eligible).length;
  const initialQualifiedCount = request.resumeProgress
    ? request.resumeProgress.totalQualifiedCount - restoredEligibleCount
    : Math.max(0, Math.floor(request.initialQualifiedCount ?? 0));
  const initialAttemptedCount = request.resumeProgress
    ? request.resumeProgress.totalAttemptedCount - candidates.size
    : Math.max(initialQualifiedCount, Math.floor(request.initialAttemptedCount ?? 0));

  // A retry restores the exact page/cursor and the dynamically discovered
  // resources from the prior pass. Old checkpoints without resource details
  // are deliberately ignored instead of guessing an endpoint from an ID.
  for (const state of request.resumeProgress?.frontier ?? request.resumeFrontier ?? []) {
    const restored = resumableWorkItem(state);
    if (!restored) {
      if (request.resumeProgress) throw new Error("Catalog discovery checkpoint frontier is invalid");
      continue;
    }
    addWork(allWork, seenWork, restored);
  }

  const progressSnapshot = (sequence: number): CatalogDiscoveryProgressSnapshot => {
    if (candidates.size > MAX_CHECKPOINT_CANDIDATES || allWork.length > MAX_CHECKPOINT_FRONTIER_ITEMS) {
      throw new Error("Catalog discovery checkpoint bound exceeded");
    }
    const restoredQualified = [...candidates.values()].filter((candidate) => candidate.eligible).length;
    return {
      version: CATALOG_DISCOVERY_PROGRESS_VERSION,
      sequence,
      storefront,
      target,
      requestFingerprint,
      providerCallCount,
      totalQualifiedCount: initialQualifiedCount + restoredQualified,
      totalAttemptedCount: initialAttemptedCount + candidates.size,
      candidates: [...candidates.values()].map(copyCheckpointCandidate),
      frontier: allWork.map(frontierState),
      roundsCompleted: ROUND_ORDER.filter((round) => roundsCompleted.includes(round)),
      seedArtists: [...seedArtists.values()].map((artist) => ({ ...artist })),
      selectedAlbums: [...selectedAlbums.values()].map(copySeedAlbum),
      fullAlbums: [...fullAlbums.values()].map(copySeedAlbum),
    };
  };

  const checkpointPage = async (): Promise<void> => {
    const nextSequence = checkpointSequence + 1;
    checkpointInteger(nextSequence, "sequence", MAX_CHECKPOINT_SEQUENCE);
    const snapshot = progressSnapshot(nextSequence);
    if (request.onCheckpoint) await request.onCheckpoint(snapshot);
    checkpointSequence = nextSequence;
  };

  for (const artist of requestSeedArtists) seedArtists.set(artist.id, { ...artist });
  for (const album of requestSelectedAlbums) {
    selectedAlbums.set(album.id, mergeSeedAlbum(selectedAlbums.get(album.id), album));
  }
  for (const album of requestFullAlbums) {
    fullAlbums.set(album.id, mergeSeedAlbum(fullAlbums.get(album.id), album));
  }

  const qualifySongs = async (item: WorkItem, songs: readonly CatalogSong[]): Promise<{ discovered: number; qualified: number }> => {
    let discovered = 0;
    let qualified = 0;
    const context = contextFor(item);
    for (const song of songs) {
      if (!song.id) continue;
      const wasKnown = candidates.has(song.id);
      let decision: CatalogEligibilityDecision;
      let evaluationFailure: "eligibility_evaluation_failed" | "eligibility_evaluation_invalid" | null = null;
      try {
        const evaluated = await request.evaluate(song, context);
        if (!evaluated || typeof evaluated !== "object"
          || typeof evaluated.eligible !== "boolean"
          || !Array.isArray(evaluated.scopeBindingRefs)
          || evaluated.scopeBindingRefs.some((reference) => typeof reference !== "string")
          || typeof evaluated.reasonCode !== "string"
          || !evaluated.reasonCode.trim()) {
          evaluationFailure = "eligibility_evaluation_invalid";
          decision = { eligible: false, scopeBindingRefs: [], reasonCode: evaluationFailure };
        } else {
          decision = evaluated;
        }
      } catch (error) {
        if (request.signal?.aborted
          || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))) throw error;
        evaluationFailure = "eligibility_evaluation_failed";
        decision = { eligible: false, scopeBindingRefs: [], reasonCode: evaluationFailure };
      }
      const bindingRefs = stableUnique([
        ...item.inheritedScopeBindingRefs,
        ...decision.scopeBindingRefs,
      ], 64);
      // Catalog identity is necessary, but it can never qualify itself.
      const eligible = decision.eligible && bindingRefs.length > 0;
      const existing = candidates.get(song.id);
      const wasEligible = existing?.eligible ?? false;
      if (!existing) {
        candidates.set(song.id, {
          song,
          eligible,
          scopeBindingRefs: bindingRefs,
          contexts: [context],
          reasonCodes: [evaluationFailure
            ?? (eligible ? decision.reasonCode : bindingRefs.length === 0 ? "missing_scope_binding" : decision.reasonCode)],
        });
        discovered += 1;
      } else {
        existing.song = mergeCatalogSong(existing.song, song);
        existing.eligible ||= eligible;
        existing.scopeBindingRefs = stableUnique([...existing.scopeBindingRefs, ...bindingRefs], 64);
        existing.contexts = boundedCandidateContexts([...existing.contexts, context]);
        existing.reasonCodes = stableUnique([
          ...existing.reasonCodes,
          evaluationFailure ?? (eligible ? decision.reasonCode : bindingRefs.length === 0 ? "missing_scope_binding" : decision.reasonCode),
        ], 64);
      }
      if (eligible && (!wasKnown || !wasEligible)) qualified += 1;
    }
    return { discovered, qualified };
  };

  const goalReached = (): boolean => {
    const newlyQualified = [...candidates.values()].filter((candidate) => candidate.eligible).length;
    const qualified = initialQualifiedCount + newlyQualified;
    return qualified >= qualifiedGoalFor(target, qualified, initialAttemptedCount + candidates.size).goal;
  };

  const runRound = async (round: CatalogDiscoveryRound, work: WorkItem[], deep = false): Promise<void> => {
    const roundWasRunnable = !goalReached() && providerCallCount < maxProviderCalls && !request.signal?.aborted;
    let pending = work.filter((item) => item.round === round && item.status === "pending");
    while (pending.length > 0 && !goalReached() && providerCallCount < maxProviderCalls && !request.signal?.aborted) {
      const allowance = maxProviderCalls - providerCallCount;
      const newlyQualifiedCount = [...candidates.values()].filter((candidate) => candidate.eligible).length;
      const qualifiedCount = initialQualifiedCount + newlyQualifiedCount;
      const plan = qualifiedGoalFor(target, qualifiedCount, initialAttemptedCount + candidates.size);
      // Every Apple page contains at most 100 resources. Re-plan after this
      // bounded wave rather than eagerly draining a large frontier.
      const adaptiveTaskWave = Math.max(1, Math.ceil(plan.rawGoal / 100));
      const batch = pending.slice(0, Math.min(allowance, adaptiveTaskWave));
      providerCallCount += batch.length;
      for (const item of batch) item.status = "running";
      const pages = await scheduleCatalogTasks(batch, concurrency, (item) => fetchPage(provider, storefront, item, request.signal));

      for (const page of pages) {
        const item = page.item;
        item.pagesAttempted += 1;
        if (page.failedReason) {
          item.status = page.failureClass === "invalid_cursor" ? "invalid_cursor" : "failed";
          item.lastReasonCode = page.failedReason;
          item.retryable = page.failureClass === "transient";
          await checkpointPage();
          continue;
        }
        item.retryable = false;
        const beforeQualified = [...candidates.values()].filter((candidate) => candidate.eligible).length;
        const counts = await qualifySongs(item, page.songs);
        item.discoveredCount += counts.discovered;
        const afterQualified = [...candidates.values()].filter((candidate) => candidate.eligible).length;
        item.qualifiedCount += Math.max(0, afterQualified - beforeQualified);
        item.zeroYieldPages = counts.qualified === 0 ? item.zeroYieldPages + 1 : 0;

        if (item.resourceKind === "search") {
          for (const artist of page.artists) {
            if (seedArtists.size >= MAX_SEED_ARTISTS) break;
            seedArtists.set(artist.id, { id: artist.id, name: artist.name });
          }
          for (const album of page.albums) {
            if (selectedAlbums.size >= MAX_DYNAMIC_ALBUMS) break;
            selectedAlbums.set(album.id, mergeSeedAlbum(selectedAlbums.get(album.id), { id: album.id }));
          }
          if (request.trustDiscoveredPlaylist && item.query) {
            for (const playlist of page.playlists) {
              const bindings = request.trustDiscoveredPlaylist(playlist, item.query);
              if (!bindings?.length) continue;
              // A trusted editorial container discovered during a deficit
              // search belongs to the active round. Assigning every playlist
              // back to Round A stranded playlists found in Round D because
              // Round A had already completed, silently suppressing a large
              // source-backed reserve.
              addWork(allWork, seenWork, workItem({
                id: `${item.round}:trusted-playlist:${safeIdPart(playlist.id)}`,
                round: item.round,
                kind: "trusted_scoped_playlist",
                resourceKind: "playlist",
                query: item.query,
                resourceId: playlist.id,
                artistAlbumView: null,
                inheritedScopeBindingRefs: stableUnique(bindings),
                maxPages,
              }));
            }
          }
          // Apple's search response paginates songs, artists, albums, and
          // playlists independently. Preserve each safe continuation as its
          // own deficit-specific Round D strategy; no collection cursor is
          // ever reused for another resource class.
          if (item.searchTypes.length > 1 && item.query) {
            for (const type of item.searchTypes) {
              const cursor = page.searchNext[type];
              if (!cursor) continue;
              const continuation = workItem({
                id: `D:search-continue:${safeIdPart(item.query)}:${type}`,
                round: "D",
                kind: "deep_pagination",
                resourceKind: "search",
                searchTypes: [type],
                query: item.query,
                resourceId: null,
                artistAlbumView: null,
                inheritedScopeBindingRefs: [],
                maxPages,
              });
              continuation.cursor = cursor;
              addWork(allWork, seenWork, continuation);
            }
          }
        }

        if (item.resourceKind === "artist_albums") {
          const destination = item.artistAlbumView === "full-albums" || item.artistAlbumView === "appears-on-albums"
            ? fullAlbums
            : selectedAlbums;
          for (const album of page.albums) {
            if (destination.size >= MAX_DYNAMIC_ALBUMS) break;
            destination.set(album.id, mergeSeedAlbum(destination.get(album.id), {
              id: album.id,
              scopeBindingRefs: item.inheritedScopeBindingRefs,
            }));
            const albumRound = item.artistAlbumView === "singles" ? "B" : "C";
            addWork(allWork, seenWork, workItem({
              id: `${albumRound}:album:${safeIdPart(album.id)}`,
              round: albumRound,
              kind: "selected_album_tracks",
              resourceKind: "album",
              query: item.query,
              resourceId: album.id,
              artistAlbumView: null,
              inheritedScopeBindingRefs: [...item.inheritedScopeBindingRefs],
              maxPages,
            }));
          }
        }

        if (item.resourceKind === "similar_artists") {
          for (const artist of page.artists.slice(0, MAX_SEED_ARTISTS)) {
            addWork(allWork, seenWork, workItem({
              id: `C:similar-top:${safeIdPart(artist.id)}`,
              round: "C",
              kind: "similar_artist_top_songs",
              resourceKind: "artist_top",
              query: item.query,
              resourceId: artist.id,
              artistAlbumView: null,
              inheritedScopeBindingRefs: [],
              maxPages,
            }));
          }
        }

        item.cursor = page.next;
        if (item.zeroYieldPages >= ZERO_YIELD_PAGE_LIMIT) {
          item.status = "exhausted";
          item.lastReasonCode = "two_zero_yield_pages";
        } else if (!page.next) {
          item.status = "complete";
          item.lastReasonCode = "pagination_complete";
        } else if (!deep || item.pagesAttempted >= item.maxPages) {
          item.status = item.pagesAttempted >= item.maxPages ? "exhausted" : "deferred";
          item.lastReasonCode = item.pagesAttempted >= item.maxPages ? "page_limit" : "deferred_to_round_d";
        } else {
          item.status = "pending";
        }
        await checkpointPage();
      }
      pending = work.filter((item) => item.round === round && item.status === "pending");
    }
    const unresolved = work.some((item) => item.round === round
      && (item.status === "pending" || item.status === "running" || (item.status === "failed" && item.retryable)));
    if (roundWasRunnable && !unresolved) roundsCompleted.push(round);
  };

  for (const term of queryTerms) {
    addWork(allWork, seenWork, workItem({
      id: `A:search:${safeIdPart(term)}`,
      round: "A",
      kind: "direct_search",
      resourceKind: "search",
      searchTypes: ["songs", "artists", "albums", "playlists"],
      query: term,
      resourceId: null,
      artistAlbumView: null,
      inheritedScopeBindingRefs: [],
      maxPages: 1,
    }));
  }
  for (const playlist of requestScopedPlaylists) {
    if (!playlist.scopeBindingRefs.length) continue;
    addWork(allWork, seenWork, workItem({
      id: `A:trusted-playlist:${safeIdPart(playlist.id)}`,
      round: "A",
      kind: "trusted_scoped_playlist",
      resourceKind: "playlist",
      query: request.query,
      resourceId: playlist.id,
      artistAlbumView: null,
      inheritedScopeBindingRefs: stableUnique(playlist.scopeBindingRefs),
      maxPages,
    }));
  }
  await runRound("A", allWork);

  for (const artist of seedArtists.values()) {
    addWork(allWork, seenWork, workItem({
      id: `B:artist-top:${safeIdPart(artist.id)}`,
      round: "B",
      kind: "seed_artist_top_songs",
      resourceKind: "artist_top",
      query: request.query,
      resourceId: artist.id,
      artistAlbumView: null,
      inheritedScopeBindingRefs: [],
      maxPages,
    }));
    addWork(allWork, seenWork, workItem({
      id: `B:artist-singles:${safeIdPart(artist.id)}`,
      round: "B",
      kind: "artist_singles",
      resourceKind: "artist_albums",
      query: request.query,
      resourceId: artist.id,
      artistAlbumView: "singles",
      inheritedScopeBindingRefs: [],
      maxPages,
    }));
  }
  for (const album of selectedAlbums.values()) {
    addWork(allWork, seenWork, workItem({
      id: `B:album:${safeIdPart(album.id)}`,
      round: "B",
      kind: "selected_album_tracks",
      resourceKind: "album",
      query: request.query,
      resourceId: album.id,
      artistAlbumView: null,
      inheritedScopeBindingRefs: stableUnique(album.scopeBindingRefs ?? []),
      maxPages,
    }));
  }
  await runRound("B", allWork);

  for (const artist of seedArtists.values()) {
    for (const [kind, view] of [
      ["artist_full_albums", "full-albums"],
      ["artist_appears_on", "appears-on-albums"],
    ] as const) {
      addWork(allWork, seenWork, workItem({
        id: `C:${kind}:${safeIdPart(artist.id)}`,
        round: "C",
        kind,
        resourceKind: "artist_albums",
        query: request.query,
        resourceId: artist.id,
        artistAlbumView: view,
        inheritedScopeBindingRefs: [],
        maxPages,
      }));
    }
    addWork(allWork, seenWork, workItem({
      id: `C:similar:${safeIdPart(artist.id)}`,
      round: "C",
      kind: "similar_artists",
      resourceKind: "similar_artists",
      query: request.query,
      resourceId: artist.id,
      artistAlbumView: null,
      inheritedScopeBindingRefs: [],
      maxPages,
    }));
  }
  for (const album of fullAlbums.values()) {
    addWork(allWork, seenWork, workItem({
      id: `C:album:${safeIdPart(album.id)}`,
      round: "C",
      kind: "selected_album_tracks",
      resourceKind: "album",
      query: request.query,
      resourceId: album.id,
      artistAlbumView: null,
      inheritedScopeBindingRefs: stableUnique(album.scopeBindingRefs ?? []),
      maxPages,
    }));
  }
  await runRound("C", allWork);

  const continuations = allWork.filter((item) => item.status === "deferred" && item.cursor).map((item) => ({
    ...item,
    id: `D:continue:${item.id}`,
    round: "D" as const,
    kind: "deep_pagination" as const,
    status: "pending" as const,
  }));
  for (const item of continuations) addWork(allWork, seenWork, item);
  for (const term of deficitQueries) {
    addWork(allWork, seenWork, workItem({
      id: `D:deficit:${safeIdPart(term)}`,
      round: "D",
      kind: "deficit_search",
      resourceKind: "search",
      searchTypes: ["songs", "artists", "albums", "playlists"],
      query: term,
      resourceId: null,
      artistAlbumView: null,
      inheritedScopeBindingRefs: [],
      maxPages: 1,
    }));
  }
  await runRound("D", allWork, true);

  const qualified = [...candidates.values()].filter((candidate) => candidate.eligible);
  const totalQualifiedCount = initialQualifiedCount + qualified.length;
  const totalAttemptedCount = initialAttemptedCount + candidates.size;
  const goal = qualifiedGoalFor(target, totalQualifiedCount, totalAttemptedCount);
  const transientFailures = allWork.filter((item) => item.status === "failed" && item.retryable);
  const circuitOpened = transientFailures.some((item) => item.lastReasonCode === "apple_provider_circuit_open");
  const policyConflictCandidates = [...candidates.values()].filter((candidate) => (
    !candidate.eligible && candidate.reasonCodes.includes("version_policy_conflict")
  ));
  const policyConflictOnly = candidates.size > 0
    && policyConflictCandidates.length === candidates.size;
  const zeroYieldExhausted = allWork.some((item) => item.lastReasonCode === "two_zero_yield_pages");
  const stoppedBecause: CatalogDiscoveryStopReason = request.signal?.aborted
    ? request.deadlineSignal?.aborted ? "timed_out" : "aborted"
    : totalQualifiedCount >= goal.goal
      ? "target_and_reserve"
      : providerCallCount >= maxProviderCalls
        ? "provider_call_limit"
        : circuitOpened
          ? "provider_circuit_open"
          : transientFailures.length > 0
            ? "provider_degraded"
            : policyConflictOnly
              ? "policy_conflict"
              : zeroYieldExhausted
                ? "zero_yield_exhausted"
                : "frontier_exhausted";
  const finalSequence = checkpointSequence + 1;
  checkpointInteger(finalSequence, "sequence", MAX_CHECKPOINT_SEQUENCE);
  const progress = progressSnapshot(finalSequence);
  return {
    target,
    qualifiedGoal: goal.goal,
    reserve: goal.reserve,
    candidates: [...candidates.values()],
    qualified,
    frontier: allWork.map(frontierState),
    roundsCompleted: ROUND_ORDER.filter((round) => roundsCompleted.includes(round)),
    providerCallCount,
    totalQualifiedCount,
    totalAttemptedCount,
    stoppedBecause,
    progress,
  };
}
