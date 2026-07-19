-- Expand-only persistence foundation for the versioned catalog-first pipeline.
-- No legacy column or constraint is removed, and every new column on an
-- existing table is nullable or has a backward-compatible legacy default.

ALTER TABLE brief_requests
  ADD COLUMN IF NOT EXISTS pipeline_version varchar(48) NOT NULL DEFAULT 'legacy_v1',
  ADD COLUMN IF NOT EXISTS policy_version varchar(80) NOT NULL DEFAULT 'legacy_v1',
  ADD COLUMN IF NOT EXISTS selection_plan_json jsonb;
--> statement-breakpoint

ALTER TABLE research_runs
  ADD COLUMN IF NOT EXISTS pipeline_version varchar(48) NOT NULL DEFAULT 'legacy_v1',
  ADD COLUMN IF NOT EXISTS policy_version varchar(80) NOT NULL DEFAULT 'legacy_v1',
  ADD COLUMN IF NOT EXISTS selection_plan_json jsonb,
  ADD COLUMN IF NOT EXISTS pipeline_policy_snapshot_json jsonb,
  ADD COLUMN IF NOT EXISTS pipeline_outcome_json jsonb;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS recording_families (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  family_key text NOT NULL,
  canonical_artist varchar(240) NOT NULL,
  canonical_title varchar(240) NOT NULL,
  version_class varchar(40) NOT NULL DEFAULT 'unknown',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  pipeline_version varchar(48) NOT NULL DEFAULT 'legacy_v1',
  policy_version varchar(80) NOT NULL DEFAULT 'legacy_v1',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS recording_family_run_key_idx
  ON recording_families(run_id,family_key);
CREATE INDEX IF NOT EXISTS recording_family_run_version_idx
  ON recording_families(run_id,version_class);
--> statement-breakpoint

ALTER TABLE track_candidates
  ADD COLUMN IF NOT EXISTS recording_family_id uuid,
  ADD COLUMN IF NOT EXISTS candidate_stage varchar(48) NOT NULL DEFAULT 'discovered',
  ADD COLUMN IF NOT EXISTS stage_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS pipeline_version varchar(48) NOT NULL DEFAULT 'legacy_v1',
  ADD COLUMN IF NOT EXISTS policy_version varchar(80) NOT NULL DEFAULT 'legacy_v1';
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE track_candidates ADD CONSTRAINT track_candidates_recording_family_fk
    FOREIGN KEY (recording_family_id) REFERENCES recording_families(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS candidate_recording_family_idx ON track_candidates(recording_family_id);
CREATE INDEX IF NOT EXISTS candidate_run_stage_idx ON track_candidates(run_id,candidate_stage);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS recording_family_candidates (
  recording_family_id uuid NOT NULL REFERENCES recording_families(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES track_candidates(id) ON DELETE CASCADE,
  relationship varchar(40) NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recording_family_candidates_pkey PRIMARY KEY(recording_family_id,candidate_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS recording_family_candidate_unique_idx
  ON recording_family_candidates(candidate_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS recording_catalog_identities (
  id uuid PRIMARY KEY,
  recording_family_id uuid NOT NULL REFERENCES recording_families(id) ON DELETE CASCADE,
  provider varchar(40) NOT NULL,
  storefront varchar(16),
  catalog_id varchar(160) NOT NULL,
  is_preferred boolean NOT NULL DEFAULT false,
  identity_confidence numeric(8,6) NOT NULL DEFAULT 0,
  artist varchar(240) NOT NULL,
  title varchar(240) NOT NULL,
  album varchar(240),
  isrc varchar(32),
  musicbrainz_id varchar(80),
  duration_ms integer,
  version_label varchar(120),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS recording_catalog_identity_unique_idx
  ON recording_catalog_identities(recording_family_id,provider,storefront,catalog_id);
CREATE INDEX IF NOT EXISTS recording_catalog_identity_lookup_idx
  ON recording_catalog_identities(provider,storefront,catalog_id);
CREATE INDEX IF NOT EXISTS recording_catalog_identity_isrc_idx
  ON recording_catalog_identities(isrc);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS track_scope_bindings (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES track_candidates(id) ON DELETE CASCADE,
  source_record_id uuid REFERENCES source_records(id) ON DELETE SET NULL,
  source_url text,
  research_container_id uuid REFERENCES research_containers(id) ON DELETE SET NULL,
  citation_attestation_id uuid REFERENCES citation_attestations(id) ON DELETE SET NULL,
  binding_kind varchar(64) NOT NULL,
  eligibility varchar(32) NOT NULL,
  scope_axis varchar(48) NOT NULL,
  scope_value varchar(240) NOT NULL,
  relationship varchar(240) NOT NULL,
  confidence numeric(8,6) NOT NULL DEFAULT 0,
  provenance_path_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  note varchar(500) NOT NULL,
  pipeline_version varchar(48) NOT NULL DEFAULT 'legacy_v1',
  policy_version varchar(80) NOT NULL DEFAULT 'legacy_v1',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scope_binding_run_candidate_idx
  ON track_scope_bindings(run_id,candidate_id);
CREATE INDEX IF NOT EXISTS scope_binding_run_eligibility_idx
  ON track_scope_bindings(run_id,eligibility);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'scope_binding_unique_key'
      AND conrelid = 'track_scope_bindings'::regclass
  ) THEN
    ALTER TABLE track_scope_bindings
      ADD CONSTRAINT scope_binding_unique_key UNIQUE NULLS NOT DISTINCT (
        candidate_id,binding_kind,scope_axis,scope_value,relationship,
        source_record_id,research_container_id
      );
  END IF;
END
$$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS candidate_stage_events (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES track_candidates(id) ON DELETE CASCADE,
  from_stage varchar(48),
  to_stage varchar(48) NOT NULL,
  reason_code varchar(120) NOT NULL,
  detail_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  pipeline_version varchar(48) NOT NULL DEFAULT 'legacy_v1',
  policy_version varchar(80) NOT NULL DEFAULT 'legacy_v1',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS candidate_stage_event_run_time_idx
  ON candidate_stage_events(run_id,occurred_at);
CREATE INDEX IF NOT EXISTS candidate_stage_event_candidate_time_idx
  ON candidate_stage_events(candidate_id,occurred_at);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS pipeline_deficit_ledger (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  stage varchar(48) NOT NULL,
  kind varchar(64) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'open',
  required_count integer NOT NULL DEFAULT 0,
  actual_count integer NOT NULL DEFAULT 0,
  deficit_count integer NOT NULL DEFAULT 0,
  reason_code varchar(120) NOT NULL,
  detail_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  pipeline_version varchar(48) NOT NULL DEFAULT 'legacy_v1',
  policy_version varchar(80) NOT NULL DEFAULT 'legacy_v1',
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipeline_deficit_run_time_idx
  ON pipeline_deficit_ledger(run_id,observed_at);
CREATE INDEX IF NOT EXISTS pipeline_deficit_run_status_idx
  ON pipeline_deficit_ledger(run_id,status);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS pipeline_outcomes (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL UNIQUE REFERENCES research_runs(id) ON DELETE CASCADE,
  status varchar(40) NOT NULL,
  target_track_count integer NOT NULL DEFAULT 0,
  discovered_track_count integer NOT NULL DEFAULT 0,
  qualified_track_count integer NOT NULL DEFAULT 0,
  selected_track_count integer NOT NULL DEFAULT 0,
  published_track_count integer NOT NULL DEFAULT 0,
  exact_count_satisfied boolean NOT NULL DEFAULT false,
  frontier_exhausted boolean NOT NULL DEFAULT false,
  provider_unavailable boolean NOT NULL DEFAULT false,
  reason_codes_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  deficit_snapshot_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcome_json jsonb NOT NULL,
  pipeline_version varchar(48) NOT NULL,
  policy_version varchar(80) NOT NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipeline_outcome_status_idx
  ON pipeline_outcomes(status,completed_at);
--> statement-breakpoint

-- Durable, storefront-scoped Apple catalog read cache. Provider failures are
-- recorded in the event stream but are never inserted into the cache table.
CREATE TABLE IF NOT EXISTS apple_catalog_cache_entries (
  storefront varchar(16) NOT NULL,
  resource_kind varchar(48) NOT NULL,
  request_fingerprint varchar(64) NOT NULL,
  payload_json jsonb NOT NULL,
  fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT apple_catalog_cache_entries_pkey PRIMARY KEY(storefront,resource_kind,request_fingerprint)
);
CREATE INDEX IF NOT EXISTS apple_catalog_cache_expiry_idx
  ON apple_catalog_cache_entries(expires_at);
--> statement-breakpoint

-- One short-lived lease per cache key coalesces misses across worker
-- processes. Expired rows are stealable and cleaned in bounded batches.
CREATE TABLE IF NOT EXISTS apple_catalog_cache_leases (
  storefront varchar(16) NOT NULL,
  resource_kind varchar(48) NOT NULL,
  request_fingerprint varchar(64) NOT NULL,
  owner_id uuid NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT apple_catalog_cache_leases_pkey PRIMARY KEY(storefront,resource_kind,request_fingerprint)
);
CREATE INDEX IF NOT EXISTS apple_catalog_cache_lease_expiry_idx
  ON apple_catalog_cache_leases(expires_at);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS apple_catalog_cache_events (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  storefront varchar(16) NOT NULL,
  resource_kind varchar(48) NOT NULL,
  request_fingerprint varchar(64) NOT NULL,
  cache_state varchar(32) NOT NULL,
  provider_state varchar(32) NOT NULL,
  detail_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS apple_catalog_cache_event_run_time_idx
  ON apple_catalog_cache_events(run_id,occurred_at);
CREATE INDEX IF NOT EXISTS apple_catalog_cache_event_state_idx
  ON apple_catalog_cache_events(cache_state,provider_state,occurred_at);
--> statement-breakpoint

ALTER TABLE manifests
  ADD COLUMN IF NOT EXISTS pipeline_version varchar(48) NOT NULL DEFAULT 'legacy_v1',
  ADD COLUMN IF NOT EXISTS policy_version varchar(80) NOT NULL DEFAULT 'legacy_v1',
  ADD COLUMN IF NOT EXISTS selection_plan_json jsonb;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS manifest_revisions (
  id uuid PRIMARY KEY,
  manifest_id uuid NOT NULL REFERENCES manifests(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  parent_revision_id uuid,
  status varchar(32) NOT NULL DEFAULT 'draft',
  reason varchar(500) NOT NULL,
  content_hash varchar(64) NOT NULL,
  pipeline_version varchar(48) NOT NULL,
  policy_version varchar(80) NOT NULL,
  selection_plan_snapshot_json jsonb,
  pipeline_policy_snapshot_json jsonb,
  outcome_snapshot_json jsonb,
  deficit_snapshot_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS manifest_revision_number_idx
  ON manifest_revisions(manifest_id,revision);
CREATE UNIQUE INDEX IF NOT EXISTS manifest_revision_hash_idx
  ON manifest_revisions(manifest_id,content_hash);
CREATE INDEX IF NOT EXISTS manifest_revision_parent_idx
  ON manifest_revisions(parent_revision_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS manifest_revision_tracks (
  manifest_revision_id uuid NOT NULL REFERENCES manifest_revisions(id) ON DELETE CASCADE,
  position integer NOT NULL,
  candidate_id uuid NOT NULL REFERENCES track_candidates(id),
  recording_family_id uuid REFERENCES recording_families(id) ON DELETE SET NULL,
  catalog_identity_id uuid REFERENCES recording_catalog_identities(id) ON DELETE SET NULL,
  catalog_id varchar(160) NOT NULL,
  artist varchar(240) NOT NULL,
  title varchar(240) NOT NULL,
  CONSTRAINT manifest_revision_tracks_pkey PRIMARY KEY(manifest_revision_id,position)
);
CREATE INDEX IF NOT EXISTS manifest_revision_track_candidate_idx
  ON manifest_revision_tracks(candidate_id);
CREATE INDEX IF NOT EXISTS manifest_revision_track_family_idx
  ON manifest_revision_tracks(recording_family_id);
--> statement-breakpoint

-- A locked revision also snapshots its qualified overflow. Publication may
-- consume one of these rows only by creating a new immutable revision; the
-- selected rows of the parent revision are never updated in place.
CREATE TABLE IF NOT EXISTS manifest_revision_reserve_tracks (
  manifest_revision_id uuid NOT NULL REFERENCES manifest_revisions(id) ON DELETE CASCADE,
  position integer NOT NULL,
  candidate_id uuid NOT NULL REFERENCES track_candidates(id),
  recording_family_id uuid NOT NULL REFERENCES recording_families(id) ON DELETE CASCADE,
  catalog_identity_id uuid NOT NULL REFERENCES recording_catalog_identities(id) ON DELETE CASCADE,
  catalog_id varchar(160) NOT NULL,
  artist varchar(240) NOT NULL,
  title varchar(240) NOT NULL,
  evidence_eligible boolean NOT NULL,
  hard_constraints_satisfied boolean NOT NULL,
  version_compatible boolean NOT NULL,
  qualified boolean NOT NULL,
  CONSTRAINT manifest_revision_reserve_tracks_pkey PRIMARY KEY(manifest_revision_id,position)
);
CREATE UNIQUE INDEX IF NOT EXISTS manifest_revision_reserve_candidate_idx
  ON manifest_revision_reserve_tracks(manifest_revision_id,candidate_id);
CREATE UNIQUE INDEX IF NOT EXISTS manifest_revision_reserve_family_idx
  ON manifest_revision_reserve_tracks(manifest_revision_id,recording_family_id);
--> statement-breakpoint

-- Legacy publication rows remain revisionless. Pipeline V2 binds every
-- publication volume to the immutable manifest revision whose exact ordered
-- tracks it publishes. The existing manifest/volume uniqueness constraint is
-- retained so a superseded row must be explicitly orphaned and removed before
-- a replacement revision can reuse that volume number.
ALTER TABLE publication_volumes
  ADD COLUMN IF NOT EXISTS manifest_revision_id uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE publication_volumes ADD CONSTRAINT publication_volumes_manifest_revision_fk
    FOREIGN KEY (manifest_revision_id) REFERENCES manifest_revisions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS publication_manifest_revision_idx
  ON publication_volumes(manifest_revision_id,volume_number);
--> statement-breakpoint

ALTER TABLE public_playlists
  ADD COLUMN IF NOT EXISTS owner_hidden boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Hidden rows pre-dating Pipeline V2 can only have been hidden explicitly by
-- the owner. Preserve that choice when automatic revision projection begins.
UPDATE public_playlists
SET owner_hidden=true
WHERE status='hidden' AND hidden_at IS NOT NULL AND owner_hidden=false;
--> statement-breakpoint

-- Queue execution metadata is server-derived from the persisted run/brief.
-- Existing and unbound operational jobs remain V1-compatible; V2 jobs require
-- the capability-aware v5 worker introduced with this expand migration.
ALTER TABLE job_queue
  ADD COLUMN IF NOT EXISTS pipeline_version varchar(48) NOT NULL DEFAULT 'legacy_v1',
  ADD COLUMN IF NOT EXISTS minimum_worker_protocol integer NOT NULL DEFAULT 4;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE job_queue ADD CONSTRAINT job_minimum_worker_protocol_valid
    CHECK (minimum_worker_protocol BETWEEN 1 AND 32767);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
UPDATE job_queue j
SET pipeline_version=r.pipeline_version,
    minimum_worker_protocol=CASE WHEN r.pipeline_version='catalog_first_v2' THEN 5 ELSE 4 END
FROM research_runs r
WHERE j.run_id=r.id;
--> statement-breakpoint
UPDATE job_queue j
SET pipeline_version=b.pipeline_version,
    minimum_worker_protocol=CASE WHEN b.pipeline_version='catalog_first_v2' THEN 5 ELSE 4 END
FROM brief_requests b
WHERE j.run_id IS NULL AND j.brief_request_id=b.id;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS job_protocol_lease_idx
  ON job_queue(status,minimum_worker_protocol,pipeline_version,available_at,lease_expires_at);
--> statement-breakpoint

-- Stamp every future insert/revival from authoritative persisted state. This
-- covers direct publication/recovery inserts as well as the generic helper and
-- prevents a caller payload from downgrading a V2 job to V1.
CREATE OR REPLACE FUNCTION stamp_job_pipeline_protocol()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE persisted_pipeline varchar(48);
BEGIN
  persisted_pipeline := 'legacy_v1';
  IF NEW.run_id IS NOT NULL THEN
    SELECT pipeline_version INTO persisted_pipeline FROM research_runs WHERE id=NEW.run_id;
  ELSIF NEW.brief_request_id IS NOT NULL THEN
    SELECT pipeline_version INTO persisted_pipeline FROM brief_requests WHERE id=NEW.brief_request_id;
  END IF;
  persisted_pipeline := COALESCE(persisted_pipeline,'legacy_v1');
  NEW.pipeline_version := persisted_pipeline;
  NEW.minimum_worker_protocol := CASE WHEN persisted_pipeline='catalog_first_v2' THEN 5 ELSE 4 END;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS job_pipeline_protocol_stamp ON job_queue;
CREATE TRIGGER job_pipeline_protocol_stamp
BEFORE INSERT OR UPDATE OF run_id,brief_request_id,pipeline_version,minimum_worker_protocol
ON job_queue FOR EACH ROW EXECUTE FUNCTION stamp_job_pipeline_protocol();
--> statement-breakpoint

INSERT INTO settings(key,value) VALUES('schema_version','13')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
