export type PlaylistMode = "exhaustive" | "curated" | "hybrid";
export type EvidenceState = "verified" | "corroborated" | "editorial" | "inferred";
export type RunStatus =
  | "draft"
  | "queued"
  | "awaiting_budget"
  | "researching"
  | "ready_for_matching"
  | "matching"
  | "review"
  | "visitor_review"
  | "manifest_ready"
  | "publishing"
  | "waiting_for_apple_authorization"
  | "complete"
  | "partial"
  | "failed"
  | "expired"
  | "deleted";

export type JobKind = "brief" | "research" | "matching" | "publication" | "retention" | "notification";
export type JobStatus = "queued" | "leased" | "retry" | "complete" | "failed" | "cancelled";
export type MatchStatus = "accepted" | "review" | "unavailable" | "rejected" | "duplicate" | "unsupported";
export type PublicationStatus = "queued" | "creating" | "appending" | "waiting_for_share_url" | "complete" | "orphaned" | "waiting_for_owner" | "failed";

export interface PlaylistBrief {
  title: string;
  description: string;
  mode: PlaylistMode;
  subjectEntities: string[];
  relationship: string;
  include: string[];
  exclude: string[];
  versionPolicy: string;
  evidencePolicy: string;
  orderingPolicy: string;
  targetSize: { min: number; max: number } | null;
  ambiguities: string[];
}

export interface SourceRecordInput {
  url: string;
  title: string;
  sourceClass: "web" | "musicbrainz" | "discogs" | "apple" | "import";
  provenanceRoot: string;
  note: string;
}

export interface EvidenceClaimInput {
  sourceUrl: string;
  state: EvidenceState;
  /**
   * Scope asserted when the claim was ingested. High-confidence evidence is
   * accepted only when the source explicitly supports the individual track.
   */
  supportScope: "track" | "album" | "session" | "collection" | "editorial";
  relationship: string;
  note: string;
}

export interface TrackCandidateInput {
  artist: string;
  title: string;
  album: string | null;
  releaseYear: number | null;
  durationMs: number | null;
  isrc: string | null;
  musicbrainzId: string | null;
  versionLabel: string | null;
  evidence: EvidenceClaimInput[];
}

export interface SourceFrontierItem {
  sourceClass: string;
  strategy: string;
  cursor: string | null;
  status: "pending" | "complete" | "inaccessible" | "unresolved";
  discoveredCount: number;
  recoveredCount: number;
  note: string;
}

export interface ResearchPassReport {
  phase:
    | "scope_resolution"
    | "source_discovery"
    | "container_discovery"
    | "container_enumeration"
    | "track_verification"
    | "catalog_enrichment"
    | "gap_analysis";
  summary: string;
  newCandidateCount: number;
  frontierItems: SourceFrontierItem[];
}

export interface CatalogSong {
  id: string;
  name: string;
  artistName: string;
  albumName: string;
  releaseDate?: string;
  durationInMillis?: number;
  isrc?: string;
  url?: string;
  artworkUrl?: string;
  versionLabel?: string;
}

export interface CatalogMatchResult {
  candidateId: string;
  status: MatchStatus;
  basis: string;
  score: number;
  song: CatalogSong | null;
  alternatives: CatalogSong[];
}

export interface ManifestTrack {
  position: number;
  candidateId: string;
  catalogId: string;
  artist: string;
  title: string;
}

export interface PlaylistManifest {
  id: string;
  runId: string;
  name: string;
  description: string;
  contentHash: string;
  lockedAt: string;
  createdAt: string;
  tracks: ManifestTrack[];
}

export interface PublicationVolume {
  id: string;
  manifestId: string;
  index: number;
  total: number;
  name: string;
  startPosition: number;
  endPosition: number;
  status: PublicationStatus;
  applePlaylistId: string | null;
  shareUrl: string | null;
  appendedCount: number;
  error: string | null;
}

export interface PublicationResult {
  manifestId: string;
  status: "publishing" | "complete" | "partial" | "waiting_for_owner" | "failed";
  volumes: PublicationVolume[];
}

export interface SetupStatus {
  openai: { connected: boolean; model: string };
  apple: { configured: boolean; authorized: boolean; storefront: string };
  requirements: string[];
}

export interface ResearchRunView {
  id: string;
  prompt: string;
  brief: PlaylistBrief;
  status: RunStatus;
  estimatedCostUsd: number;
  actualCostUsd: number;
  approvedBudgetUsd: number;
  phase: string;
  error: string | null;
  candidateCount: number;
  sourceCount: number;
  unresolvedCount: number;
  exceptionCount?: number;
  manifestId?: string | null;
  capabilityUrl?: string;
  frontier: SourceFrontierItem[];
}

export interface RunResultView {
  run: ResearchRunView;
  publication: PublicationResult | null;
  outcomes: Record<MatchStatus, number>;
  evidenceExpiresAt: string | null;
}

export interface JobLease {
  id: string;
  runId: string | null;
  kind: JobKind;
  status: JobStatus;
  payload: Record<string, unknown>;
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  availableAt: string;
}

export interface CostReservation {
  id: string;
  runId: string | null;
  provider: "openai" | "apple" | "discogs";
  category: string;
  reservedUsd: number;
  actualUsd: number | null;
  status: "reserved" | "reconciled" | "reconciled_overrun" | "released";
}

export interface AppleAuthorizationView {
  configured: boolean;
  authorized: boolean;
  storefront: string | null;
  validatedAt: string | null;
  needsReauthorization: boolean;
}

export interface OwnerHealthView {
  ok: boolean;
  paused: boolean;
  database: "ready" | "down";
  worker: "healthy" | "stale" | "missing";
  apple: AppleAuthorizationView;
  queuedJobs: number;
  activeJobs: number;
  monthSpendUsd: number;
  monthReservedUsd: number;
  notificationBacklog: number;
  orphanedPlaylists: number;
}

export interface CapabilityExchangeResponse {
  runId: string;
  expiresAt: string;
}

export interface PaginatedExceptions {
  page: number;
  pageSize: number;
  total: number;
  items: Array<{
    candidateId: string;
    artist: string;
    title: string;
    album: string | null;
    status: MatchStatus;
    basis: string;
    song: CatalogSong | null;
    alternatives: CatalogSong[];
  }>;
}

export interface SourceAdapterResult {
  records: SourceRecordInput[];
  items: unknown[];
  nextCursor: string | null;
  complete: boolean;
  note: string;
  advertisedTotal: number;
  /** Containers discovered by a structured source. These are persisted by
   * the server before the model sees the tool result. */
  containers: SourceAdapterContainer[];
  /** Server-normalized evidence capabilities. Structured metadata is never
   * silently upgraded into relationship proof. */
  evidence: SourceAdapterEvidence[];
}

export type SourceAdapterId = "musicbrainz" | "discogs" | "apple";
export type SourceAdapterAction = "discover" | "enumerate" | "lookup";
export type SourceAdapterEntity = "artist" | "release" | "recording" | "catalog";

export interface SourceAdapterContainer {
  containerType: "artist" | "release" | "session" | "collection";
  /** Provider-stable and adapter-namespaced, so IDs from different providers
   * cannot collide in the research frontier. */
  providerId: string;
  title: string;
  advertisedTotal: number | null;
  metadata: Record<string, unknown>;
}

export interface SourceAdapterContainerRef extends SourceAdapterContainer {
  id: string;
  status: "discovered" | "enumerating" | "complete" | "inaccessible" | "unresolved";
  cursor: string | null;
  recoveredTotal: number;
}

export interface SourceAdapterEvidence {
  sourceUrl: string;
  evidenceKind: "metadata" | "track_credit" | "container_credit";
  supportScope: "track" | "album" | "session" | "collection" | "editorial";
  subject: string | null;
  relationship: string;
  trackTitle: string | null;
  note: string;
  /** Structured adapter evidence remains inferred until a claim-bound policy
   * explicitly promotes it. Generic search metadata is always false. */
  eligibleForAutomaticVerification: boolean;
}

export interface SourceAdapterContext {
  action: SourceAdapterAction;
  entity: SourceAdapterEntity;
  query: string | null;
  container: SourceAdapterContainerRef | null;
  providerId: string | null;
}

export interface SourceAdapter {
  id: SourceAdapterId;
  supports(brief: PlaylistBrief): number;
  discover(entity: SourceAdapterEntity, query: string, cursor: string | null, signal?: AbortSignal): Promise<SourceAdapterResult>;
  enumerate(container: SourceAdapterContainerRef, cursor: string | null, signal?: AbortSignal): Promise<SourceAdapterResult>;
  lookup(entity: SourceAdapterEntity, providerId: string, signal?: AbortSignal): Promise<SourceAdapterResult>;
  normalizeEvidence(result: SourceAdapterResult, context: SourceAdapterContext): SourceAdapterEvidence[];
}

export interface ApiErrorPayload {
  error: string;
  code?: string;
  retryAfterSeconds?: number;
}
