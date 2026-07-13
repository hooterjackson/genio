CREATE TABLE IF NOT EXISTS settings (
  key varchar(160) PRIMARY KEY,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings(key,value) VALUES('schema_version','1')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS brief_requests (
  id uuid PRIMARY KEY,
  prompt text NOT NULL,
  model varchar(120) NOT NULL,
  status varchar(40) NOT NULL DEFAULT 'queued',
  brief_json jsonb,
  estimate_usd numeric(12,6),
  error text,
  client_bucket varchar(160) NOT NULL,
  idempotency_key varchar(160),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS brief_bucket_idempotency_idx ON brief_requests(client_bucket, idempotency_key);
CREATE INDEX IF NOT EXISTS brief_status_created_idx ON brief_requests(status, created_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS capability_sessions (
  id uuid PRIMARY KEY,
  run_id uuid,
  access_id uuid,
  token_hash varchar(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS capability_session_run_idx ON capability_sessions(run_id);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS research_runs (
  id uuid PRIMARY KEY,
  prompt text NOT NULL,
  brief_json jsonb NOT NULL,
  brief_hash varchar(64) NOT NULL,
  status varchar(48) NOT NULL,
  phase varchar(80) NOT NULL,
  client_bucket varchar(160) NOT NULL,
  idempotency_key varchar(160) NOT NULL,
  estimated_cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  actual_cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  reserved_cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  approved_budget_usd numeric(12,6) NOT NULL DEFAULT 0,
  budget_approval_expires_at timestamptz,
  no_new_gap_passes integer NOT NULL DEFAULT 0,
  error text,
  retention_expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS run_bucket_idempotency_idx ON research_runs(client_bucket, idempotency_key);
CREATE INDEX IF NOT EXISTS run_status_created_idx ON research_runs(status, created_at);
CREATE INDEX IF NOT EXISTS run_brief_cache_idx ON research_runs(brief_hash, completed_at);
CREATE INDEX IF NOT EXISTS run_retention_idx ON research_runs(retention_expires_at);
-- statement-breakpoint
DO $$ BEGIN
  ALTER TABLE capability_sessions ADD CONSTRAINT capability_sessions_run_fk
    FOREIGN KEY (run_id) REFERENCES research_runs(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS run_accesses (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  prompt text,
  client_bucket varchar(160) NOT NULL,
  idempotency_key varchar(160) NOT NULL,
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS run_access_bucket_idempotency_idx ON run_accesses(client_bucket, idempotency_key);
CREATE INDEX IF NOT EXISTS run_access_run_idx ON run_accesses(run_id);
-- statement-breakpoint
DO $$ BEGIN
  ALTER TABLE capability_sessions ADD CONSTRAINT capability_sessions_access_fk
    FOREIGN KEY (access_id) REFERENCES run_accesses(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS capability_tokens (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  access_id uuid NOT NULL REFERENCES run_accesses(id) ON DELETE CASCADE,
  token_hash varchar(64) NOT NULL UNIQUE,
  purpose varchar(32) NOT NULL DEFAULT 'exchange',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS capability_token_run_idx ON capability_tokens(run_id);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS source_records (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  url text NOT NULL,
  title varchar(240) NOT NULL,
  source_class varchar(40) NOT NULL,
  provenance_root varchar(240) NOT NULL,
  note varchar(500) NOT NULL,
  retrieved_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS source_run_url_idx ON source_records(run_id, url);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS track_candidates (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  canonical_key text NOT NULL,
  duplicate_cluster_key text,
  artist varchar(240) NOT NULL,
  title varchar(240) NOT NULL,
  album varchar(240),
  release_year integer,
  duration_ms integer,
  isrc varchar(32),
  musicbrainz_id varchar(80),
  version_label varchar(120),
  outcome varchar(40) NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS candidate_run_key_idx ON track_candidates(run_id, canonical_key);
CREATE INDEX IF NOT EXISTS candidate_duplicate_cluster_idx ON track_candidates(run_id, duplicate_cluster_key);
CREATE INDEX IF NOT EXISTS candidate_run_outcome_idx ON track_candidates(run_id, outcome);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS evidence_claims (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES track_candidates(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  state varchar(32) NOT NULL,
  support_scope varchar(32) NOT NULL DEFAULT 'collection',
  verification_phase varchar(80) NOT NULL DEFAULT 'unverified',
  relationship varchar(240) NOT NULL,
  note varchar(500) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS evidence_claim_unique_idx ON evidence_claims(candidate_id, source_id, relationship);
CREATE INDEX IF NOT EXISTS evidence_run_idx ON evidence_claims(run_id);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS source_frontier (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  source_class varchar(80) NOT NULL,
  strategy varchar(240) NOT NULL,
  cursor text,
  status varchar(32) NOT NULL,
  discovered_count integer NOT NULL DEFAULT 0,
  recovered_count integer NOT NULL DEFAULT 0,
  note varchar(500) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS frontier_run_strategy_idx ON source_frontier(run_id, source_class, strategy);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS research_containers (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  source_record_id uuid REFERENCES source_records(id) ON DELETE SET NULL,
  parent_container_id uuid,
  container_type varchar(48) NOT NULL,
  provider_id varchar(240) NOT NULL,
  title varchar(240) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'discovered',
  cursor text,
  advertised_total integer,
  recovered_total integer NOT NULL DEFAULT 0,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS container_run_provider_idx ON research_containers(run_id,container_type,provider_id);
CREATE INDEX IF NOT EXISTS container_run_status_idx ON research_containers(run_id,status);
DO $$ BEGIN
  ALTER TABLE research_containers ADD CONSTRAINT research_container_parent_fk
    FOREIGN KEY (parent_container_id) REFERENCES research_containers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS research_checkpoints (
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  phase varchar(80) NOT NULL,
  state_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS checkpoint_run_phase_idx ON research_checkpoints(run_id, phase);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS catalog_matches (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES track_candidates(id) ON DELETE CASCADE,
  status varchar(40) NOT NULL,
  basis text NOT NULL,
  score numeric(8,6) NOT NULL,
  catalog_id varchar(100),
  song_json jsonb,
  alternatives_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  reviewed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS match_candidate_idx ON catalog_matches(candidate_id);
CREATE INDEX IF NOT EXISTS match_run_status_idx ON catalog_matches(run_id, status);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS manifests (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  name varchar(240) NOT NULL,
  description text NOT NULL,
  content_hash varchar(64) NOT NULL,
  locked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS manifest_run_hash_idx ON manifests(run_id, content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS manifest_run_unique_idx ON manifests(run_id);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS manifest_tracks (
  manifest_id uuid NOT NULL REFERENCES manifests(id) ON DELETE CASCADE,
  position integer NOT NULL,
  candidate_id uuid NOT NULL REFERENCES track_candidates(id),
  catalog_id varchar(100) NOT NULL,
  artist varchar(240) NOT NULL,
  title varchar(240) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS manifest_track_position_idx ON manifest_tracks(manifest_id, position);
CREATE INDEX IF NOT EXISTS manifest_track_candidate_idx ON manifest_tracks(candidate_id);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS publication_volumes (
  id uuid PRIMARY KEY,
  manifest_id uuid NOT NULL REFERENCES manifests(id) ON DELETE CASCADE,
  volume_number integer NOT NULL,
  volume_count integer NOT NULL,
  start_position integer NOT NULL,
  end_position integer NOT NULL,
  status varchar(40) NOT NULL DEFAULT 'pending',
  apple_playlist_id varchar(160),
  apple_share_url text,
  appended_count integer NOT NULL DEFAULT 0,
  attempt integer NOT NULL DEFAULT 0,
  last_error text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS publication_manifest_volume_idx ON publication_volumes(manifest_id, volume_number);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS orphan_playlists (
  id uuid PRIMARY KEY,
  manifest_id uuid REFERENCES manifests(id) ON DELETE SET NULL,
  publication_volume_id uuid REFERENCES publication_volumes(id) ON DELETE SET NULL,
  apple_playlist_id varchar(160) NOT NULL,
  reason text NOT NULL,
  cleaned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS job_queue (
  id uuid PRIMARY KEY,
  run_id uuid REFERENCES research_runs(id) ON DELETE CASCADE,
  brief_request_id uuid REFERENCES brief_requests(id) ON DELETE CASCADE,
  kind varchar(64) NOT NULL,
  dedupe_key varchar(160) NOT NULL DEFAULT 'default',
  status varchar(32) NOT NULL DEFAULT 'queued',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner varchar(160),
  lease_expires_at timestamptz,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS job_dedupe_idx ON job_queue(kind, dedupe_key);
CREATE INDEX IF NOT EXISTS job_lease_idx ON job_queue(status, available_at, lease_expires_at);
CREATE INDEX IF NOT EXISTS job_run_idx ON job_queue(run_id);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id varchar(160) PRIMARY KEY,
  schema_version varchar(40) NOT NULL,
  capacity integer NOT NULL DEFAULT 1,
  active_jobs integer NOT NULL DEFAULT 0,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS cost_reservations (
  id uuid PRIMARY KEY,
  run_id uuid REFERENCES research_runs(id) ON DELETE CASCADE,
  brief_request_id uuid REFERENCES brief_requests(id) ON DELETE CASCADE,
  operation varchar(120) NOT NULL,
  idempotency_key varchar(64) NOT NULL UNIQUE,
  status varchar(32) NOT NULL DEFAULT 'reserved',
  reserved_usd numeric(12,6) NOT NULL,
  actual_usd numeric(12,6),
  usage_json jsonb,
  expires_at timestamptz NOT NULL,
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cost_reservation_status_idx ON cost_reservations(status, expires_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS cost_ledger (
  id uuid PRIMARY KEY,
  run_id uuid REFERENCES research_runs(id) ON DELETE SET NULL,
  brief_request_id uuid REFERENCES brief_requests(id) ON DELETE SET NULL,
  reservation_id uuid REFERENCES cost_reservations(id) ON DELETE SET NULL,
  operation varchar(120) NOT NULL,
  amount_usd numeric(12,6) NOT NULL,
  usage_json jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cost_ledger_occurred_idx ON cost_ledger(occurred_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS rate_limit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_bucket varchar(160) NOT NULL,
  action varchar(64) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rate_bucket_action_time_idx ON rate_limit_events(client_bucket, action, occurred_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS gateway_nonces (
  key_id varchar(80) NOT NULL,
  nonce varchar(160) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_key_nonce_idx ON gateway_nonces(key_id, nonce);
CREATE INDEX IF NOT EXISTS gateway_nonce_expiry_idx ON gateway_nonces(expires_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS apple_authorizations (
  id varchar(32) PRIMARY KEY DEFAULT 'owner',
  ciphertext text NOT NULL,
  iv varchar(64) NOT NULL,
  auth_tag varchar(64) NOT NULL,
  key_version varchar(40) NOT NULL,
  storefront varchar(8) NOT NULL,
  status varchar(40) NOT NULL DEFAULT 'unverified',
  last_validated_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS notification_outbox (
  id uuid PRIMARY KEY,
  kind varchar(80) NOT NULL,
  dedupe_key varchar(200) NOT NULL UNIQUE,
  payload_json jsonb NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  provider_id varchar(200),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_outbox_pending_idx ON notification_outbox(status, available_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid REFERENCES research_runs(id) ON DELETE SET NULL,
  actor varchar(80) NOT NULL,
  action varchar(120) NOT NULL,
  detail_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_run_time_idx ON audit_events(run_id, occurred_at);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS retention_tombstones (
  run_id uuid PRIMARY KEY,
  manifest_hash varchar(64),
  playlist_title varchar(240),
  apple_links_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcome_counts_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  aggregate_cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  retained_at timestamptz NOT NULL DEFAULT now()
);
