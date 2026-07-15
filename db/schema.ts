import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const settings = pgTable("settings", {
  key: varchar("key", { length: 160 }).primaryKey(),
  value: text("value").notNull(),
  ...timestamps,
});

export const briefRequests = pgTable("brief_requests", {
  id: uuid("id").primaryKey(),
  prompt: text("prompt").notNull(),
  model: varchar("model", { length: 120 }).notNull(),
  status: varchar("status", { length: 40 }).notNull().default("queued"),
  briefJson: jsonb("brief_json"),
  estimateUsd: numeric("estimate_usd", { precision: 12, scale: 6, mode: "number" }),
  error: text("error"),
  clientBucket: varchar("client_bucket", { length: 160 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 160 }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("brief_bucket_idempotency_idx").on(table.clientBucket, table.idempotencyKey),
  index("brief_status_created_idx").on(table.status, table.createdAt),
]);

export const capabilitySessions = pgTable("capability_sessions", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id"),
  accessId: uuid("access_id"),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
}, (table) => [index("capability_session_run_idx").on(table.runId)]);

export const researchRuns = pgTable("research_runs", {
  id: uuid("id").primaryKey(),
  prompt: text("prompt").notNull(),
  briefJson: jsonb("brief_json").notNull(),
  briefHash: varchar("brief_hash", { length: 64 }).notNull(),
  status: varchar("status", { length: 48 }).notNull(),
  phase: varchar("phase", { length: 80 }).notNull(),
  clientBucket: varchar("client_bucket", { length: 160 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
  estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
  actualCostUsd: numeric("actual_cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
  reservedCostUsd: numeric("reserved_cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
  approvedBudgetUsd: numeric("approved_budget_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
  budgetApprovalExpiresAt: timestamp("budget_approval_expires_at", { withTimezone: true }),
  noNewGapPasses: integer("no_new_gap_passes").notNull().default(0),
  error: text("error"),
  retentionExpiresAt: timestamp("retention_expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("run_bucket_idempotency_idx").on(table.clientBucket, table.idempotencyKey),
  index("run_status_created_idx").on(table.status, table.createdAt),
  index("run_brief_cache_idx").on(table.briefHash, table.completedAt),
  index("run_retention_idx").on(table.retentionExpiresAt),
]);

export const runAccesses = pgTable("run_accesses", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  prompt: text("prompt"),
  clientBucket: varchar("client_bucket", { length: 160 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("run_access_bucket_idempotency_idx").on(table.clientBucket, table.idempotencyKey),
  index("run_access_run_idx").on(table.runId),
]);

export const capabilitySessionAccesses = pgTable("capability_session_accesses", {
  sessionId: uuid("session_id").notNull().references(() => capabilitySessions.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  accessId: uuid("access_id").notNull().references(() => runAccesses.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.sessionId, table.accessId], name: "capability_session_accesses_pkey" }),
  index("capability_session_access_created_idx").on(table.sessionId, table.createdAt),
  index("capability_session_access_access_idx").on(table.accessId),
]);

export const capabilityTokens = pgTable("capability_tokens", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  accessId: uuid("access_id").notNull().references(() => runAccesses.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  purpose: varchar("purpose", { length: 32 }).notNull().default("exchange"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("capability_token_run_idx").on(table.runId)]);

export const sourceRecords = pgTable("source_records", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  title: varchar("title", { length: 240 }).notNull(),
  sourceClass: varchar("source_class", { length: 40 }).notNull(),
  provenanceRoot: varchar("provenance_root", { length: 240 }).notNull(),
  note: varchar("note", { length: 500 }).notNull(),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("source_run_url_idx").on(table.runId, table.url)]);

export const trackCandidates = pgTable("track_candidates", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  canonicalKey: text("canonical_key").notNull(),
  duplicateClusterKey: text("duplicate_cluster_key"),
  selectionRank: integer("selection_rank"),
  artist: varchar("artist", { length: 240 }).notNull(),
  title: varchar("title", { length: 240 }).notNull(),
  album: varchar("album", { length: 240 }),
  releaseYear: integer("release_year"),
  durationMs: integer("duration_ms"),
  isrc: varchar("isrc", { length: 32 }),
  musicbrainzId: varchar("musicbrainz_id", { length: 80 }),
  versionLabel: varchar("version_label", { length: 120 }),
  outcome: varchar("outcome", { length: 40 }).notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("candidate_run_key_idx").on(table.runId, table.canonicalKey),
  index("candidate_duplicate_cluster_idx").on(table.runId, table.duplicateClusterKey),
  index("candidate_selection_rank_idx").on(table.runId, table.selectionRank),
  index("candidate_run_outcome_idx").on(table.runId, table.outcome),
]);

export const citationAttestations = pgTable("citation_attestations", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  attestationKey: varchar("attestation_key", { length: 64 }).notNull(),
  sourceUrl: text("source_url").notNull(),
  responseId: varchar("response_id", { length: 240 }).notNull(),
  outputItemId: varchar("output_item_id", { length: 240 }).notNull(),
  contentIndex: integer("content_index").notNull(),
  startIndex: integer("start_index").notNull(),
  endIndex: integer("end_index").notNull(),
  excerpt: varchar("excerpt", { length: 1000 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("citation_attestation_run_key_idx").on(table.runId, table.attestationKey),
  index("citation_attestation_run_idx").on(table.runId),
]);

export const evidenceClaims = pgTable("evidence_claims", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  candidateId: uuid("candidate_id").notNull().references(() => trackCandidates.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id").notNull().references(() => sourceRecords.id, { onDelete: "cascade" }),
  citationAttestationId: uuid("citation_attestation_id").references(() => citationAttestations.id, { onDelete: "set null" }),
  state: varchar("state", { length: 32 }).notNull(),
  supportScope: varchar("support_scope", { length: 32 }).notNull().default("collection"),
  verificationPhase: varchar("verification_phase", { length: 80 }).notNull().default("unverified"),
  subjectEntity: varchar("subject_entity", { length: 240 }).notNull(),
  subjectRelationship: varchar("subject_relationship", { length: 240 }).notNull(),
  relationship: varchar("relationship", { length: 240 }).notNull(),
  note: varchar("note", { length: 500 }).notNull(),
}, (table) => [
  uniqueIndex("evidence_claim_unique_idx").on(
    table.candidateId,
    table.sourceId,
    table.subjectEntity,
    table.subjectRelationship,
    table.relationship,
  ),
  index("evidence_run_idx").on(table.runId),
  index("evidence_citation_attestation_idx").on(table.citationAttestationId),
]);

export const sourceFrontier = pgTable("source_frontier", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  sourceClass: varchar("source_class", { length: 80 }).notNull(),
  strategy: varchar("strategy", { length: 240 }).notNull(),
  cursor: text("cursor"),
  status: varchar("status", { length: 32 }).notNull(),
  discoveredCount: integer("discovered_count").notNull().default(0),
  recoveredCount: integer("recovered_count").notNull().default(0),
  note: varchar("note", { length: 500 }).notNull(),
}, (table) => [uniqueIndex("frontier_run_strategy_idx").on(table.runId, table.sourceClass, table.strategy)]);

export const researchContainers = pgTable("research_containers", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  sourceRecordId: uuid("source_record_id").references(() => sourceRecords.id, { onDelete: "set null" }),
  parentContainerId: uuid("parent_container_id"),
  containerType: varchar("container_type", { length: 48 }).notNull(),
  providerId: varchar("provider_id", { length: 240 }).notNull(),
  title: varchar("title", { length: 240 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default("discovered"),
  cursor: text("cursor"),
  advertisedTotal: integer("advertised_total"),
  recoveredTotal: integer("recovered_total").notNull().default(0),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("container_run_provider_idx").on(table.runId, table.containerType, table.providerId),
  index("container_run_status_idx").on(table.runId, table.status),
]);

export const researchCheckpoints = pgTable("research_checkpoints", {
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  phase: varchar("phase", { length: 80 }).notNull(),
  stateJson: jsonb("state_json").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("checkpoint_run_phase_idx").on(table.runId, table.phase)]);

export const catalogMatches = pgTable("catalog_matches", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  candidateId: uuid("candidate_id").notNull().references(() => trackCandidates.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 40 }).notNull(),
  basis: text("basis").notNull(),
  score: numeric("score", { precision: 8, scale: 6, mode: "number" }).notNull(),
  catalogId: varchar("catalog_id", { length: 100 }),
  songJson: jsonb("song_json"),
  alternativesJson: jsonb("alternatives_json").notNull().default([]),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  // Immutable first matcher decision. Final status fields above may change
  // during review or manifest overflow, so benchmark precision must never be
  // reconstructed from them.
  initialStatus: varchar("initial_status", { length: 40 }),
  initialBasis: text("initial_basis"),
  initialScore: numeric("initial_score", { precision: 8, scale: 6, mode: "number" }),
  initialCatalogId: varchar("initial_catalog_id", { length: 100 }),
  initialSongJson: jsonb("initial_song_json"),
  initialMatchedAt: timestamp("initial_matched_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("match_candidate_idx").on(table.candidateId),
  index("match_run_status_idx").on(table.runId, table.status),
]);

export const manifests = pgTable("manifests", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => researchRuns.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 240 }).notNull(),
  description: text("description").notNull(),
  contentHash: varchar("content_hash", { length: 64 }).notNull(),
  lockedAt: timestamp("locked_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("manifest_run_unique_idx").on(table.runId),
  uniqueIndex("manifest_run_hash_idx").on(table.runId, table.contentHash),
]);

export const manifestTracks = pgTable("manifest_tracks", {
  manifestId: uuid("manifest_id").notNull().references(() => manifests.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  candidateId: uuid("candidate_id").notNull().references(() => trackCandidates.id),
  catalogId: varchar("catalog_id", { length: 100 }).notNull(),
  artist: varchar("artist", { length: 240 }).notNull(),
  title: varchar("title", { length: 240 }).notNull(),
}, (table) => [
  uniqueIndex("manifest_track_position_idx").on(table.manifestId, table.position),
  index("manifest_track_candidate_idx").on(table.candidateId),
]);

export const publicationVolumes = pgTable("publication_volumes", {
  id: uuid("id").primaryKey(),
  manifestId: uuid("manifest_id").notNull().references(() => manifests.id, { onDelete: "cascade" }),
  volumeNumber: integer("volume_number").notNull(),
  volumeCount: integer("volume_count").notNull(),
  startPosition: integer("start_position").notNull(),
  endPosition: integer("end_position").notNull(),
  status: varchar("status", { length: 40 }).notNull().default("pending"),
  applePlaylistId: varchar("apple_playlist_id", { length: 160 }),
  appleShareUrl: text("apple_share_url"),
  appendedCount: integer("appended_count").notNull().default(0),
  attempt: integer("attempt").notNull().default(0),
  lastError: text("last_error"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [uniqueIndex("publication_manifest_volume_idx").on(table.manifestId, table.volumeNumber)]);

export const orphanPlaylists = pgTable("orphan_playlists", {
  id: uuid("id").primaryKey(),
  manifestId: uuid("manifest_id").references(() => manifests.id, { onDelete: "set null" }),
  publicationVolumeId: uuid("publication_volume_id").references(() => publicationVolumes.id, { onDelete: "set null" }),
  applePlaylistId: varchar("apple_playlist_id", { length: 160 }).notNull(),
  reason: text("reason").notNull(),
  cleanedAt: timestamp("cleaned_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobQueue = pgTable("job_queue", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").references(() => researchRuns.id, { onDelete: "cascade" }),
  briefRequestId: uuid("brief_request_id").references(() => briefRequests.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 64 }).notNull(),
  dedupeKey: varchar("dedupe_key", { length: 160 }).notNull().default("default"),
  status: varchar("status", { length: 32 }).notNull().default("queued"),
  payloadJson: jsonb("payload_json").notNull().default({}),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  leaseOwner: varchar("lease_owner", { length: 160 }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  lastError: text("last_error"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("job_dedupe_idx").on(table.kind, table.dedupeKey),
  index("job_lease_idx").on(table.status, table.availableAt, table.leaseExpiresAt),
  index("job_run_idx").on(table.runId),
]);

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: varchar("worker_id", { length: 160 }).primaryKey(),
  schemaVersion: varchar("schema_version", { length: 40 }).notNull(),
  capacity: integer("capacity").notNull().default(1),
  activeJobs: integer("active_jobs").notNull().default(0),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

export const costReservations = pgTable("cost_reservations", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").references(() => researchRuns.id, { onDelete: "cascade" }),
  briefRequestId: uuid("brief_request_id").references(() => briefRequests.id, { onDelete: "cascade" }),
  operation: varchar("operation", { length: 120 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 64 }).notNull().unique(),
  status: varchar("status", { length: 32 }).notNull().default("reserved"),
  reservedUsd: numeric("reserved_usd", { precision: 12, scale: 6, mode: "number" }).notNull(),
  actualUsd: numeric("actual_usd", { precision: 12, scale: 6, mode: "number" }),
  usageJson: jsonb("usage_json"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("cost_reservation_status_idx").on(table.status, table.expiresAt)]);

export const costLedger = pgTable("cost_ledger", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").references(() => researchRuns.id, { onDelete: "set null" }),
  briefRequestId: uuid("brief_request_id").references(() => briefRequests.id, { onDelete: "set null" }),
  reservationId: uuid("reservation_id").references(() => costReservations.id, { onDelete: "set null" }),
  operation: varchar("operation", { length: 120 }).notNull(),
  amountUsd: numeric("amount_usd", { precision: 12, scale: 6, mode: "number" }).notNull(),
  usageJson: jsonb("usage_json"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("cost_ledger_occurred_idx").on(table.occurredAt)]);

export const rateLimitEvents = pgTable("rate_limit_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  clientBucket: varchar("client_bucket", { length: 160 }).notNull(),
  action: varchar("action", { length: 64 }).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("rate_bucket_action_time_idx").on(table.clientBucket, table.action, table.occurredAt)]);

export const gatewayNonces = pgTable("gateway_nonces", {
  keyId: varchar("key_id", { length: 80 }).notNull(),
  nonce: varchar("nonce", { length: 160 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("gateway_key_nonce_idx").on(table.keyId, table.nonce),
  index("gateway_nonce_expiry_idx").on(table.expiresAt),
]);

export const appleAuthorizations = pgTable("apple_authorizations", {
  id: varchar("id", { length: 32 }).primaryKey().default("owner"),
  ciphertext: text("ciphertext").notNull(),
  iv: varchar("iv", { length: 64 }).notNull(),
  authTag: varchar("auth_tag", { length: 64 }).notNull(),
  keyVersion: varchar("key_version", { length: 40 }).notNull(),
  storefront: varchar("storefront", { length: 8 }).notNull(),
  status: varchar("status", { length: 40 }).notNull().default("unverified"),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  lastError: text("last_error"),
  ...timestamps,
});

export const notificationOutbox = pgTable("notification_outbox", {
  id: uuid("id").primaryKey(),
  kind: varchar("kind", { length: 80 }).notNull(),
  dedupeKey: varchar("dedupe_key", { length: 200 }).notNull().unique(),
  payloadJson: jsonb("payload_json").notNull(),
  status: varchar("status", { length: 32 }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  providerId: varchar("provider_id", { length: 200 }),
  lastError: text("last_error"),
  ...timestamps,
}, (table) => [index("notification_outbox_pending_idx").on(table.status, table.availableAt)]);

export const auditEvents = pgTable("audit_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  runId: uuid("run_id").references(() => researchRuns.id, { onDelete: "set null" }),
  actor: varchar("actor", { length: 80 }).notNull(),
  action: varchar("action", { length: 120 }).notNull(),
  detailJson: jsonb("detail_json").notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("audit_run_time_idx").on(table.runId, table.occurredAt)]);

export const retentionTombstones = pgTable("retention_tombstones", {
  runId: uuid("run_id").primaryKey(),
  manifestHash: varchar("manifest_hash", { length: 64 }),
  playlistTitle: varchar("playlist_title", { length: 240 }),
  appleLinksJson: jsonb("apple_links_json").notNull().default([]),
  outcomeCountsJson: jsonb("outcome_counts_json").notNull().default({}),
  aggregateCostUsd: numeric("aggregate_cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
  retainedAt: timestamp("retained_at", { withTimezone: true }).notNull().defaultNow(),
});
