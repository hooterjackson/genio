-- Expand-only foundation for corpus-first Pipeline V3.
--
-- This migration deliberately does not assign any run to V3. Existing V1/V2
-- tables and rows remain intact. New global corpus observations enter a
-- quarantine table and become queryable only after explicit promotion into a
-- locked graph snapshot.

CREATE TABLE IF NOT EXISTS run_specs (
  run_id uuid PRIMARY KEY REFERENCES research_runs(id) ON DELETE CASCADE,
  raw_prompt text NOT NULL,
  requested_track_count integer,
  storefront varchar(16) NOT NULL,
  guidance_answers_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  guidance_source_hints_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  spec_hash varchar(64) NOT NULL,
  pipeline_version varchar(48) NOT NULL,
  policy_version varchar(80) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_spec_requested_track_count_valid
    CHECK (requested_track_count IS NULL OR requested_track_count BETWEEN 1 AND 300),
  CONSTRAINT run_spec_guidance_source_hints_valid CHECK (
    jsonb_typeof(guidance_source_hints_json)='array'
    AND jsonb_array_length(guidance_source_hints_json) <= 12
  )
);
CREATE INDEX IF NOT EXISTS run_spec_hash_idx ON run_specs(spec_hash);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_run_spec_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'run_specs rows are immutable; create a new run instead'
    USING ERRCODE='integrity_constraint_violation';
END $$;
DROP TRIGGER IF EXISTS run_spec_immutable ON run_specs;
CREATE TRIGGER run_spec_immutable
BEFORE UPDATE ON run_specs FOR EACH ROW EXECUTE FUNCTION reject_run_spec_update();
--> statement-breakpoint

-- Confirmed selection plans are append-only revisions.  Mutable execution
-- state belongs to query plans and jobs; the membership/ranking contract that
-- the visitor confirmed must remain independently auditable.
CREATE TABLE IF NOT EXISTS selection_plans (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'active',
  plan_hash varchar(64) NOT NULL,
  plan_json jsonb NOT NULL,
  pipeline_version varchar(48) NOT NULL,
  policy_version varchar(80) NOT NULL,
  confirmed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT selection_plan_revision_positive CHECK (revision > 0),
  CONSTRAINT selection_plan_status_valid CHECK (status IN ('active','superseded')),
  CONSTRAINT selection_plan_v3_version_valid CHECK (
    pipeline_version='corpus_first_v3' AND policy_version='corpus_first_v3_policy_v1'
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS selection_plan_run_revision_idx ON selection_plans(run_id,revision);
CREATE UNIQUE INDEX IF NOT EXISTS selection_plan_run_hash_idx ON selection_plans(run_id,plan_hash);
CREATE INDEX IF NOT EXISTS selection_plan_status_idx ON selection_plans(run_id,status,created_at);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION preserve_selection_plan_contract()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.plan_hash IS DISTINCT FROM OLD.plan_hash
     OR NEW.plan_json IS DISTINCT FROM OLD.plan_json
     OR NEW.pipeline_version IS DISTINCT FROM OLD.pipeline_version
     OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
     OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'selection plan contract is immutable; create a successor revision'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS selection_plan_contract_immutable ON selection_plans;
CREATE TRIGGER selection_plan_contract_immutable
BEFORE UPDATE ON selection_plans FOR EACH ROW EXECUTE FUNCTION preserve_selection_plan_contract();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS graph_snapshots (
  id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  parent_snapshot_id uuid,
  status varchar(32) NOT NULL DEFAULT 'building',
  content_hash varchar(64),
  assertion_count integer NOT NULL DEFAULT 0,
  catalog_identity_count integer NOT NULL DEFAULT 0,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT graph_snapshot_status_valid CHECK (status IN ('building','locked','superseded')),
  CONSTRAINT graph_snapshot_locked_state_valid CHECK (
    (status='building' AND locked_at IS NULL AND content_hash IS NULL)
    OR (status IN ('locked','superseded') AND locked_at IS NOT NULL AND content_hash IS NOT NULL)
  ),
  CONSTRAINT graph_snapshot_content_hash_valid CHECK (
    content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT graph_snapshot_counts_valid CHECK (assertion_count >= 0 AND catalog_identity_count >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS graph_snapshot_sequence_idx ON graph_snapshots(sequence);
CREATE UNIQUE INDEX IF NOT EXISTS graph_snapshot_content_hash_idx ON graph_snapshots(content_hash);
CREATE INDEX IF NOT EXISTS graph_snapshot_status_idx ON graph_snapshots(status,created_at);
DO $$ BEGIN
  ALTER TABLE graph_snapshots ADD CONSTRAINT graph_snapshots_parent_fk
    FOREIGN KEY(parent_snapshot_id) REFERENCES graph_snapshots(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS query_plan_revisions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  selection_plan_id uuid NOT NULL REFERENCES selection_plans(id),
  revision integer NOT NULL,
  parent_revision_id uuid,
  graph_snapshot_id uuid NOT NULL REFERENCES graph_snapshots(id),
  engine varchar(48) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'draft',
  plan_hash varchar(64) NOT NULL,
  plan_json jsonb NOT NULL,
  pipeline_version varchar(48) NOT NULL,
  policy_version varchar(80) NOT NULL,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT query_plan_revision_positive CHECK (revision > 0),
  CONSTRAINT query_plan_status_valid CHECK (status IN ('draft','active','superseded')),
  CONSTRAINT query_plan_v3_version_valid CHECK (
    pipeline_version='corpus_first_v3' AND policy_version='corpus_first_v3_policy_v1'
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS query_plan_run_revision_idx ON query_plan_revisions(run_id,revision);
CREATE UNIQUE INDEX IF NOT EXISTS query_plan_run_hash_idx ON query_plan_revisions(run_id,plan_hash);
CREATE INDEX IF NOT EXISTS query_plan_graph_snapshot_idx ON query_plan_revisions(graph_snapshot_id);
CREATE INDEX IF NOT EXISTS query_plan_selection_plan_idx ON query_plan_revisions(selection_plan_id);
DO $$ BEGIN
  ALTER TABLE query_plan_revisions ADD CONSTRAINT query_plan_revisions_parent_fk
    FOREIGN KEY(parent_revision_id) REFERENCES query_plan_revisions(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- Query-plan revisions are content-addressed execution contracts. Lifecycle
-- fields may advance, but changing their run, selection contract, graph view,
-- engine, or payload would retroactively change every bound manifest.
CREATE OR REPLACE FUNCTION preserve_query_plan_revision_contract()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.selection_plan_id IS DISTINCT FROM OLD.selection_plan_id
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id
     OR NEW.graph_snapshot_id IS DISTINCT FROM OLD.graph_snapshot_id
     OR NEW.engine IS DISTINCT FROM OLD.engine
     OR NEW.plan_hash IS DISTINCT FROM OLD.plan_hash
     OR NEW.plan_json IS DISTINCT FROM OLD.plan_json
     OR NEW.pipeline_version IS DISTINCT FROM OLD.pipeline_version
     OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'query plan contract is immutable; create a successor revision'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS query_plan_revision_contract_immutable ON query_plan_revisions;
CREATE TRIGGER query_plan_revision_contract_immutable
BEFORE UPDATE ON query_plan_revisions
FOR EACH ROW EXECUTE FUNCTION preserve_query_plan_revision_contract();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS run_active_query_plans (
  run_id uuid PRIMARY KEY REFERENCES research_runs(id) ON DELETE CASCADE,
  query_plan_revision_id uuid NOT NULL UNIQUE REFERENCES query_plan_revisions(id),
  activated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_run_active_query_plan()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE plan_run uuid; selection_run uuid; selection_status varchar(32); selection_hash varchar(64); query_selection_hash varchar(64); plan_status varchar(32); snapshot_status varchar(32);
BEGIN
  SELECT q.run_id,s.run_id,s.status,s.plan_hash,q.plan_json->>'selectionPlanHash',q.status,g.status
    INTO plan_run,selection_run,selection_status,selection_hash,query_selection_hash,plan_status,snapshot_status
  FROM query_plan_revisions q
  JOIN selection_plans s ON s.id=q.selection_plan_id
  JOIN graph_snapshots g ON g.id=q.graph_snapshot_id
  WHERE q.id=NEW.query_plan_revision_id;
  IF plan_run IS DISTINCT FROM NEW.run_id OR selection_run IS DISTINCT FROM NEW.run_id THEN
    RAISE EXCEPTION 'active query plan belongs to another run'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF selection_hash IS DISTINCT FROM query_selection_hash THEN
    RAISE EXCEPTION 'query plan selection-plan hash does not match its immutable selection revision'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF selection_status <> 'active' OR plan_status <> 'active' OR snapshot_status <> 'locked' THEN
    RAISE EXCEPTION 'active query plans require active selection/query revisions and a locked graph snapshot'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS run_active_query_plan_validate ON run_active_query_plans;
CREATE TRIGGER run_active_query_plan_validate
BEFORE INSERT OR UPDATE ON run_active_query_plans
FOR EACH ROW EXECUTE FUNCTION validate_run_active_query_plan();
--> statement-breakpoint

-- A V3 manifest revision is reproducible only when it names the immutable
-- caller intent, confirmed selection contract, executable query revision, and
-- evidence graph snapshot that produced its ordered rows. Legacy revisions
-- remain nullable and are never silently upgraded into this contract.
ALTER TABLE manifest_revisions
  ADD COLUMN IF NOT EXISTS selection_plan_id uuid,
  ADD COLUMN IF NOT EXISTS query_plan_revision_id uuid,
  ADD COLUMN IF NOT EXISTS graph_snapshot_id uuid,
  ADD COLUMN IF NOT EXISTS run_spec_hash varchar(64);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE manifest_revisions ADD CONSTRAINT manifest_revision_selection_plan_fk
    FOREIGN KEY(selection_plan_id) REFERENCES selection_plans(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE manifest_revisions ADD CONSTRAINT manifest_revision_query_plan_fk
    FOREIGN KEY(query_plan_revision_id) REFERENCES query_plan_revisions(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE manifest_revisions ADD CONSTRAINT manifest_revision_graph_snapshot_fk
    FOREIGN KEY(graph_snapshot_id) REFERENCES graph_snapshots(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE manifest_revisions ADD CONSTRAINT manifest_revision_v3_binding_presence_valid CHECK (
    (
      pipeline_version='corpus_first_v3'
      AND selection_plan_id IS NOT NULL
      AND query_plan_revision_id IS NOT NULL
      AND graph_snapshot_id IS NOT NULL
      AND run_spec_hash IS NOT NULL
    ) OR (
      pipeline_version<>'corpus_first_v3'
      AND selection_plan_id IS NULL
      AND query_plan_revision_id IS NULL
      AND graph_snapshot_id IS NULL
      AND run_spec_hash IS NULL
    )
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE manifest_revisions ADD CONSTRAINT manifest_revision_run_spec_hash_valid CHECK (
    run_spec_hash IS NULL OR run_spec_hash ~ '^[0-9a-f]{64}$'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS manifest_revision_selection_plan_idx
  ON manifest_revisions(selection_plan_id);
CREATE INDEX IF NOT EXISTS manifest_revision_query_plan_idx
  ON manifest_revisions(query_plan_revision_id);
CREATE INDEX IF NOT EXISTS manifest_revision_graph_snapshot_idx
  ON manifest_revisions(graph_snapshot_id);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_manifest_revision_v3_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  manifest_run_id uuid;
  manifest_pipeline_version varchar(48);
  manifest_policy_version varchar(80);
  run_pipeline_version varchar(48);
  run_policy_version varchar(80);
  stored_run_spec_hash varchar(64);
  run_spec_pipeline_version varchar(48);
  run_spec_policy_version varchar(80);
  selection_run_id uuid;
  selection_status varchar(32);
  selection_hash varchar(64);
  selection_pipeline_version varchar(48);
  selection_policy_version varchar(80);
  query_run_id uuid;
  query_selection_plan_id uuid;
  query_graph_snapshot_id uuid;
  query_status varchar(32);
  query_selection_hash varchar(64);
  query_pipeline_version varchar(48);
  query_policy_version varchar(80);
  snapshot_status varchar(32);
  active_query_plan_id uuid;
BEGIN
  IF NEW.pipeline_version <> 'corpus_first_v3' THEN
    RETURN NEW;
  END IF;

  SELECT
    manifest.run_id,manifest.pipeline_version,manifest.policy_version,
    run.pipeline_version,run.policy_version,
    spec.spec_hash,spec.pipeline_version,spec.policy_version,
    selection.run_id,selection.status,selection.plan_hash,
    selection.pipeline_version,selection.policy_version,
    query.run_id,query.selection_plan_id,query.graph_snapshot_id,query.status,
    query.plan_json->>'selectionPlanHash',query.pipeline_version,query.policy_version,
    snapshot.status,active.query_plan_revision_id
  INTO
    manifest_run_id,manifest_pipeline_version,manifest_policy_version,
    run_pipeline_version,run_policy_version,
    stored_run_spec_hash,run_spec_pipeline_version,run_spec_policy_version,
    selection_run_id,selection_status,selection_hash,
    selection_pipeline_version,selection_policy_version,
    query_run_id,query_selection_plan_id,query_graph_snapshot_id,query_status,
    query_selection_hash,query_pipeline_version,query_policy_version,
    snapshot_status,active_query_plan_id
  FROM manifests manifest
  JOIN research_runs run ON run.id=manifest.run_id
  JOIN run_specs spec ON spec.run_id=run.id
  JOIN selection_plans selection ON selection.id=NEW.selection_plan_id
  JOIN query_plan_revisions query ON query.id=NEW.query_plan_revision_id
  JOIN graph_snapshots snapshot ON snapshot.id=NEW.graph_snapshot_id
  LEFT JOIN run_active_query_plans active ON active.run_id=run.id
  WHERE manifest.id=NEW.manifest_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'V3 manifest revision binding is incomplete'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF manifest_run_id IS DISTINCT FROM selection_run_id
     OR manifest_run_id IS DISTINCT FROM query_run_id THEN
    RAISE EXCEPTION 'V3 manifest revision bindings belong to different runs'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF NEW.run_spec_hash IS DISTINCT FROM stored_run_spec_hash THEN
    RAISE EXCEPTION 'V3 manifest revision run-spec hash does not match immutable caller intent'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF NEW.selection_plan_id IS DISTINCT FROM query_selection_plan_id
     OR NEW.graph_snapshot_id IS DISTINCT FROM query_graph_snapshot_id
     OR query_selection_hash IS DISTINCT FROM selection_hash THEN
    RAISE EXCEPTION 'V3 manifest revision query, selection, and graph bindings disagree'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF selection_status <> 'active'
     OR query_status <> 'active'
     OR snapshot_status <> 'locked'
     OR active_query_plan_id IS DISTINCT FROM NEW.query_plan_revision_id THEN
    RAISE EXCEPTION 'V3 manifest revisions require the active plan and a locked graph snapshot'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF NEW.policy_version <> 'corpus_first_v3_policy_v1'
     OR manifest_pipeline_version <> NEW.pipeline_version
     OR run_pipeline_version <> NEW.pipeline_version
     OR run_spec_pipeline_version <> NEW.pipeline_version
     OR selection_pipeline_version <> NEW.pipeline_version
     OR query_pipeline_version <> NEW.pipeline_version
     OR manifest_policy_version <> NEW.policy_version
     OR run_policy_version <> NEW.policy_version
     OR run_spec_policy_version <> NEW.policy_version
     OR selection_policy_version <> NEW.policy_version
     OR query_policy_version <> NEW.policy_version THEN
    RAISE EXCEPTION 'V3 manifest revision pipeline or policy versions disagree'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS manifest_revision_v3_binding_validate ON manifest_revisions;
CREATE TRIGGER manifest_revision_v3_binding_validate
BEFORE INSERT ON manifest_revisions
FOR EACH ROW EXECUTE FUNCTION validate_manifest_revision_v3_binding();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION preserve_manifest_revision_v3_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.pipeline_version='corpus_first_v3' OR NEW.pipeline_version='corpus_first_v3' THEN
    IF NEW.manifest_id IS DISTINCT FROM OLD.manifest_id
       OR NEW.pipeline_version IS DISTINCT FROM OLD.pipeline_version
       OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
       OR NEW.selection_plan_id IS DISTINCT FROM OLD.selection_plan_id
       OR NEW.query_plan_revision_id IS DISTINCT FROM OLD.query_plan_revision_id
       OR NEW.graph_snapshot_id IS DISTINCT FROM OLD.graph_snapshot_id
       OR NEW.run_spec_hash IS DISTINCT FROM OLD.run_spec_hash THEN
      RAISE EXCEPTION 'V3 manifest revision binding is immutable; create a successor revision'
        USING ERRCODE='integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS manifest_revision_v3_binding_immutable ON manifest_revisions;
CREATE TRIGGER manifest_revision_v3_binding_immutable
BEFORE UPDATE ON manifest_revisions
FOR EACH ROW EXECUTE FUNCTION preserve_manifest_revision_v3_binding();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS corpus_entities (
  id uuid PRIMARY KEY,
  entity_type varchar(48) NOT NULL,
  canonical_key text NOT NULL,
  canonical_name varchar(240) NOT NULL,
  state varchar(32) NOT NULL DEFAULT 'active',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS corpus_entity_type_key_idx ON corpus_entities(entity_type,canonical_key);
CREATE INDEX IF NOT EXISTS corpus_entity_name_idx ON corpus_entities(canonical_name);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS corpus_entity_aliases (
  id uuid PRIMARY KEY,
  entity_id uuid NOT NULL REFERENCES corpus_entities(id) ON DELETE CASCADE,
  alias varchar(240) NOT NULL,
  normalized_alias varchar(240) NOT NULL,
  locale varchar(32),
  provider varchar(48) NOT NULL DEFAULT 'internal',
  confidence numeric(8,6) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT corpus_entity_alias_confidence_valid CHECK (confidence BETWEEN 0 AND 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS corpus_entity_alias_unique_idx
  ON corpus_entity_aliases(entity_id,normalized_alias,provider);
CREATE INDEX IF NOT EXISTS corpus_entity_alias_lookup_idx ON corpus_entity_aliases(normalized_alias);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS corpus_recordings (
  id uuid PRIMARY KEY,
  canonical_key text NOT NULL UNIQUE,
  primary_artist_entity_id uuid REFERENCES corpus_entities(id) ON DELETE SET NULL,
  title varchar(240) NOT NULL,
  version_class varchar(48) NOT NULL DEFAULT 'unknown',
  state varchar(32) NOT NULL DEFAULT 'active',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS corpus_recording_artist_title_idx
  ON corpus_recordings(primary_artist_entity_id,title);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS corpus_releases (
  id uuid PRIMARY KEY,
  canonical_key text NOT NULL UNIQUE,
  primary_artist_entity_id uuid REFERENCES corpus_entities(id) ON DELETE SET NULL,
  title varchar(240) NOT NULL,
  release_date varchar(40),
  state varchar(32) NOT NULL DEFAULT 'active',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS corpus_release_artist_title_idx
  ON corpus_releases(primary_artist_entity_id,title);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS corpus_release_recordings (
  release_id uuid NOT NULL REFERENCES corpus_releases(id) ON DELETE CASCADE,
  recording_id uuid NOT NULL REFERENCES corpus_recordings(id) ON DELETE CASCADE,
  disc_number integer,
  track_number integer,
  scope varchar(32) NOT NULL DEFAULT 'track',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT corpus_release_recordings_pkey PRIMARY KEY(release_id,recording_id),
  CONSTRAINT corpus_release_recordings_positions_valid CHECK (
    (disc_number IS NULL OR disc_number > 0) AND (track_number IS NULL OR track_number > 0)
  )
);
CREATE INDEX IF NOT EXISTS corpus_release_recording_recording_idx
  ON corpus_release_recordings(recording_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS corpus_source_documents (
  id uuid PRIMARY KEY,
  url text NOT NULL,
  content_hash varchar(64) NOT NULL,
  title varchar(240) NOT NULL,
  source_class varchar(48) NOT NULL,
  provenance_root varchar(240) NOT NULL,
  access_method varchar(40) NOT NULL,
  approval_state varchar(24) NOT NULL DEFAULT 'pending',
  authority varchar(48) NOT NULL DEFAULT 'unknown',
  license_state varchar(32) NOT NULL DEFAULT 'unknown',
  license_version varchar(160),
  terms_version varchar(160),
  attribution text,
  cache_policy varchar(40) NOT NULL DEFAULT 'excerpt_only',
  retention_policy varchar(40) NOT NULL DEFAULT 'ninety_days',
  freshness_policy varchar(40) NOT NULL DEFAULT 'revalidate_30d',
  freshness_expires_at timestamptz,
  source_revision varchar(160) NOT NULL,
  approved_by varchar(120),
  approved_at timestamptz,
  takedown_reason varchar(500),
  taken_down_at timestamptz,
  status varchar(32) NOT NULL DEFAULT 'active',
  retrieved_at timestamptz NOT NULL,
  last_verified_at timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT corpus_source_content_hash_valid CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT corpus_source_status_valid CHECK (status IN ('active','stale','takedown','revoked')),
  CONSTRAINT corpus_source_access_method_valid CHECK (
    access_method IN ('hosted_web_search','structured_adapter','public_api','owner_import','manual_entry')
  ),
  CONSTRAINT corpus_source_approval_state_valid CHECK (approval_state IN ('pending','approved','rejected')),
  CONSTRAINT corpus_source_authority_valid CHECK (
    authority IN ('primary_track_credit','official_track_credit','specialist_track_credit',
      'trusted_editorial_container','secondary_database','catalog_metadata','unknown')
  ),
  CONSTRAINT corpus_source_license_state_valid CHECK (
    license_state IN ('reusable','permission_recorded','unknown','prohibited')
  ),
  CONSTRAINT corpus_source_cache_policy_valid CHECK (
    cache_policy IN ('no_store','metadata_only','excerpt_only','full_document_permitted')
  ),
  CONSTRAINT corpus_source_retention_policy_valid CHECK (
    retention_policy IN ('run_only','ninety_days','durable_public_corpus','license_term')
  ),
  CONSTRAINT corpus_source_freshness_policy_valid CHECK (
    freshness_policy IN ('immutable_revision','revalidate_30d','revalidate_90d')
  ),
  CONSTRAINT corpus_source_approval_fields_valid CHECK (
    approval_state <> 'approved' OR (
      authority <> 'unknown'
      AND license_state IN ('reusable','permission_recorded')
      AND license_version IS NOT NULL
      AND terms_version IS NOT NULL
      AND attribution IS NOT NULL
      AND approved_by IS NOT NULL
      AND approved_at IS NOT NULL
      AND cache_policy IN ('excerpt_only','full_document_permitted')
      AND retention_policy IN ('durable_public_corpus','license_term')
      AND (
        (freshness_policy='immutable_revision' AND freshness_expires_at IS NULL)
        OR (freshness_policy<>'immutable_revision' AND freshness_expires_at IS NOT NULL)
      )
    )
  ),
  CONSTRAINT corpus_source_takedown_fields_valid CHECK (
    (status IN ('takedown','revoked') AND takedown_reason IS NOT NULL AND taken_down_at IS NOT NULL)
    OR (status NOT IN ('takedown','revoked') AND takedown_reason IS NULL AND taken_down_at IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS corpus_source_url_hash_idx ON corpus_source_documents(url,content_hash);
CREATE INDEX IF NOT EXISTS corpus_source_provenance_idx ON corpus_source_documents(provenance_root);
CREATE INDEX IF NOT EXISTS corpus_source_governance_idx
  ON corpus_source_documents(approval_state,status,freshness_expires_at);
--> statement-breakpoint

-- A source document is an append-only captured revision. Governance may move
-- monotonically from pending to approved/rejected and later to a takedown,
-- but retrieval identity and source content are never rewritten in place.
CREATE OR REPLACE FUNCTION preserve_corpus_source_document_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.url IS DISTINCT FROM OLD.url
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.source_class IS DISTINCT FROM OLD.source_class
     OR NEW.provenance_root IS DISTINCT FROM OLD.provenance_root
     OR NEW.access_method IS DISTINCT FROM OLD.access_method
     OR NEW.source_revision IS DISTINCT FROM OLD.source_revision
     OR NEW.retrieved_at IS DISTINCT FROM OLD.retrieved_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'corpus source revisions are immutable; capture a successor source document'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF OLD.approval_state IN ('approved','rejected')
     AND NEW.approval_state IS DISTINCT FROM OLD.approval_state THEN
    RAISE EXCEPTION 'corpus source approval is terminal; capture a successor source document'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('takedown','revoked')
     AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'corpus source takedown is terminal'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS corpus_source_document_revision_immutable ON corpus_source_documents;
CREATE TRIGGER corpus_source_document_revision_immutable
BEFORE UPDATE ON corpus_source_documents
FOR EACH ROW EXECUTE FUNCTION preserve_corpus_source_document_revision();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_corpus_source_document_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'corpus source documents are append-only'
    USING ERRCODE='integrity_constraint_violation';
END $$;
DROP TRIGGER IF EXISTS corpus_source_document_no_delete ON corpus_source_documents;
CREATE TRIGGER corpus_source_document_no_delete
BEFORE DELETE ON corpus_source_documents
FOR EACH ROW EXECUTE FUNCTION reject_corpus_source_document_delete();
--> statement-breakpoint

-- Untrusted observations are never read directly by a V3 query plan. They
-- must be promoted and included in a locked graph snapshot first.
CREATE TABLE IF NOT EXISTS corpus_assertion_observations (
  id uuid PRIMARY KEY,
  observation_key varchar(64) NOT NULL UNIQUE,
  source_document_id uuid NOT NULL REFERENCES corpus_source_documents(id),
  subject_entity_id uuid REFERENCES corpus_entities(id) ON DELETE SET NULL,
  recording_id uuid REFERENCES corpus_recordings(id) ON DELETE SET NULL,
  release_id uuid REFERENCES corpus_releases(id) ON DELETE SET NULL,
  predicate varchar(160) NOT NULL,
  object_json jsonb NOT NULL,
  credit_scope varchar(48),
  support_excerpt varchar(1000) NOT NULL,
  confidence numeric(8,6) NOT NULL DEFAULT 0,
  status varchar(32) NOT NULL DEFAULT 'quarantined',
  pipeline_version varchar(48) NOT NULL,
  policy_version varchar(80) NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT corpus_observation_confidence_valid CHECK (confidence BETWEEN 0 AND 1),
  CONSTRAINT corpus_observation_status_valid CHECK (status IN ('quarantined','rejected','promoted')),
  CONSTRAINT corpus_observation_subject_valid CHECK (
    subject_entity_id IS NOT NULL OR recording_id IS NOT NULL OR release_id IS NOT NULL
  )
);
CREATE INDEX IF NOT EXISTS corpus_observation_status_time_idx
  ON corpus_assertion_observations(status,observed_at);
CREATE INDEX IF NOT EXISTS corpus_observation_recording_idx
  ON corpus_assertion_observations(recording_id,predicate);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS corpus_promoted_assertions (
  id uuid PRIMARY KEY,
  assertion_key varchar(64) NOT NULL UNIQUE,
  subject_entity_id uuid REFERENCES corpus_entities(id) ON DELETE SET NULL,
  recording_id uuid REFERENCES corpus_recordings(id) ON DELETE SET NULL,
  release_id uuid REFERENCES corpus_releases(id) ON DELETE SET NULL,
  predicate varchar(160) NOT NULL,
  object_json jsonb NOT NULL,
  evidence_tier varchar(32) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'active',
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  promoted_at timestamptz NOT NULL DEFAULT now(),
  retracted_at timestamptz,
  promoted_by varchar(120) NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT corpus_assertion_status_valid CHECK (status IN ('active','superseded','retracted')),
  CONSTRAINT corpus_assertion_subject_valid CHECK (
    subject_entity_id IS NOT NULL OR recording_id IS NOT NULL OR release_id IS NOT NULL
  )
);
CREATE INDEX IF NOT EXISTS corpus_assertion_recording_idx
  ON corpus_promoted_assertions(recording_id,predicate,status);
CREATE INDEX IF NOT EXISTS corpus_assertion_subject_idx
  ON corpus_promoted_assertions(subject_entity_id,predicate,status);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS corpus_assertion_evidence (
  promoted_assertion_id uuid NOT NULL REFERENCES corpus_promoted_assertions(id) ON DELETE CASCADE,
  observation_id uuid NOT NULL REFERENCES corpus_assertion_observations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT corpus_assertion_evidence_pkey PRIMARY KEY(promoted_assertion_id,observation_id)
);
CREATE INDEX IF NOT EXISTS corpus_assertion_evidence_observation_idx
  ON corpus_assertion_evidence(observation_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS corpus_catalog_identities (
  id uuid PRIMARY KEY,
  recording_id uuid NOT NULL REFERENCES corpus_recordings(id) ON DELETE CASCADE,
  provider varchar(40) NOT NULL,
  storefront varchar(16) NOT NULL,
  catalog_id varchar(160) NOT NULL,
  is_preferred boolean NOT NULL DEFAULT false,
  is_available boolean NOT NULL DEFAULT true,
  identity_confidence numeric(8,6) NOT NULL DEFAULT 0,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz,
  CONSTRAINT corpus_catalog_identity_confidence_valid CHECK (identity_confidence BETWEEN 0 AND 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS corpus_catalog_identity_unique_idx
  ON corpus_catalog_identities(recording_id,provider,storefront,catalog_id);
CREATE INDEX IF NOT EXISTS corpus_catalog_identity_lookup_idx
  ON corpus_catalog_identities(provider,storefront,catalog_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS graph_snapshot_assertions (
  graph_snapshot_id uuid NOT NULL REFERENCES graph_snapshots(id) ON DELETE CASCADE,
  assertion_id uuid NOT NULL REFERENCES corpus_promoted_assertions(id),
  assertion_revision_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT graph_snapshot_assertions_pkey PRIMARY KEY(graph_snapshot_id,assertion_id)
);
CREATE INDEX IF NOT EXISTS graph_snapshot_assertion_assertion_idx
  ON graph_snapshot_assertions(assertion_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS graph_snapshot_catalog_identities (
  graph_snapshot_id uuid NOT NULL REFERENCES graph_snapshots(id) ON DELETE CASCADE,
  catalog_identity_id uuid NOT NULL REFERENCES corpus_catalog_identities(id),
  catalog_identity_revision_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT graph_snapshot_catalog_identities_pkey PRIMARY KEY(graph_snapshot_id,catalog_identity_id)
);
CREATE INDEX IF NOT EXISTS graph_snapshot_catalog_identity_identity_idx
  ON graph_snapshot_catalog_identities(catalog_identity_id);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION capture_graph_snapshot_assertion_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT to_jsonb(assertion_row) || jsonb_build_object(
    'evidence',COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'observation',to_jsonb(observation_row),
          'sourceDocument',to_jsonb(source_document_row)
        )
        ORDER BY observation_row.observation_key,source_document_row.id
      )
      FROM corpus_assertion_evidence assertion_evidence
      JOIN corpus_assertion_observations observation_row
        ON observation_row.id=assertion_evidence.observation_id
      JOIN corpus_source_documents source_document_row
        ON source_document_row.id=observation_row.source_document_id
      WHERE assertion_evidence.promoted_assertion_id=assertion_row.id
    ),'[]'::jsonb)
  )
  INTO NEW.assertion_revision_json
  FROM corpus_promoted_assertions assertion_row
  WHERE assertion_row.id=NEW.assertion_id;
  IF NEW.assertion_revision_json IS NULL THEN
    RAISE EXCEPTION 'graph snapshot assertion revision does not exist'
      USING ERRCODE='foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS graph_snapshot_assertion_revision_capture ON graph_snapshot_assertions;
CREATE TRIGGER graph_snapshot_assertion_revision_capture
BEFORE INSERT OR UPDATE OF assertion_id ON graph_snapshot_assertions
FOR EACH ROW EXECUTE FUNCTION capture_graph_snapshot_assertion_revision();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION capture_graph_snapshot_catalog_identity_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT to_jsonb(identity_row)
    INTO NEW.catalog_identity_revision_json
  FROM corpus_catalog_identities identity_row
  WHERE identity_row.id=NEW.catalog_identity_id;
  IF NEW.catalog_identity_revision_json IS NULL THEN
    RAISE EXCEPTION 'graph snapshot catalog identity revision does not exist'
      USING ERRCODE='foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS graph_snapshot_catalog_identity_revision_capture ON graph_snapshot_catalog_identities;
CREATE TRIGGER graph_snapshot_catalog_identity_revision_capture
BEFORE INSERT OR UPDATE OF catalog_identity_id ON graph_snapshot_catalog_identities
FOR EACH ROW EXECUTE FUNCTION capture_graph_snapshot_catalog_identity_revision();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_locked_graph_snapshot_membership()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot_status varchar(32); target_snapshot_id uuid;
BEGIN
  target_snapshot_id := CASE WHEN TG_OP='DELETE' THEN OLD.graph_snapshot_id ELSE NEW.graph_snapshot_id END;
  SELECT status INTO snapshot_status FROM graph_snapshots WHERE id=target_snapshot_id;
  IF snapshot_status IS NULL THEN
    RAISE EXCEPTION 'graph snapshot does not exist'
      USING ERRCODE='foreign_key_violation';
  END IF;
  IF snapshot_status <> 'building' THEN
    RAISE EXCEPTION 'locked graph snapshot membership is immutable'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS graph_snapshot_assertion_membership_guard ON graph_snapshot_assertions;
CREATE TRIGGER graph_snapshot_assertion_membership_guard
BEFORE INSERT OR UPDATE OR DELETE ON graph_snapshot_assertions
FOR EACH ROW EXECUTE FUNCTION enforce_locked_graph_snapshot_membership();
DROP TRIGGER IF EXISTS graph_snapshot_catalog_membership_guard ON graph_snapshot_catalog_identities;
CREATE TRIGGER graph_snapshot_catalog_membership_guard
BEFORE INSERT OR UPDATE OR DELETE ON graph_snapshot_catalog_identities
FOR EACH ROW EXECUTE FUNCTION enforce_locked_graph_snapshot_membership();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION preserve_graph_snapshot_contract()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actual_assertion_count integer;
  actual_catalog_identity_count integer;
  parent_status varchar(32);
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.parent_snapshot_id IS NOT NULL THEN
      SELECT status INTO parent_status FROM graph_snapshots WHERE id=NEW.parent_snapshot_id;
      IF parent_status NOT IN ('locked','superseded') THEN
        RAISE EXCEPTION 'graph snapshot parent must be immutable before creating a successor'
          USING ERRCODE='integrity_constraint_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP='DELETE' THEN
    IF OLD.status <> 'building' THEN
      RAISE EXCEPTION 'locked graph snapshot contract is append-only'
        USING ERRCODE='integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.sequence IS DISTINCT FROM OLD.sequence
     OR NEW.parent_snapshot_id IS DISTINCT FROM OLD.parent_snapshot_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'graph snapshot identity contract is immutable'
      USING ERRCODE='integrity_constraint_violation';
  END IF;

  IF OLD.status='building' THEN
    IF NEW.status='building' THEN
      RETURN NEW;
    END IF;
    IF NEW.status <> 'locked' THEN
      RAISE EXCEPTION 'building graph snapshots may only transition to locked'
        USING ERRCODE='integrity_constraint_violation';
    END IF;

    -- Re-capture the exact corpus revisions at the lock boundary. These no-op
    -- updates invoke the revision-capture triggers while the parent is building.
    UPDATE graph_snapshot_assertions
      SET assertion_id=assertion_id
      WHERE graph_snapshot_id=OLD.id;
    UPDATE graph_snapshot_catalog_identities
      SET catalog_identity_id=catalog_identity_id
      WHERE graph_snapshot_id=OLD.id;

    SELECT count(*)::integer INTO actual_assertion_count
      FROM graph_snapshot_assertions WHERE graph_snapshot_id=OLD.id;
    SELECT count(*)::integer INTO actual_catalog_identity_count
      FROM graph_snapshot_catalog_identities WHERE graph_snapshot_id=OLD.id;
    IF NEW.assertion_count IS DISTINCT FROM actual_assertion_count
       OR NEW.catalog_identity_count IS DISTINCT FROM actual_catalog_identity_count THEN
      RAISE EXCEPTION 'graph snapshot lock counts do not match frozen membership'
        USING ERRCODE='integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status='locked' AND NEW.status='superseded' THEN
    IF NEW.content_hash IS DISTINCT FROM OLD.content_hash
       OR NEW.assertion_count IS DISTINCT FROM OLD.assertion_count
       OR NEW.catalog_identity_count IS DISTINCT FROM OLD.catalog_identity_count
       OR NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
      RAISE EXCEPTION 'superseding a graph snapshot cannot rewrite its locked contract'
        USING ERRCODE='integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'locked graph snapshot contract is immutable'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS graph_snapshot_contract_guard ON graph_snapshots;
CREATE TRIGGER graph_snapshot_contract_guard
BEFORE INSERT OR UPDATE OR DELETE ON graph_snapshots
FOR EACH ROW EXECUTE FUNCTION preserve_graph_snapshot_contract();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS run_corpus_recording_links (
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES track_candidates(id) ON DELETE CASCADE,
  query_plan_revision_id uuid NOT NULL REFERENCES query_plan_revisions(id),
  graph_snapshot_id uuid NOT NULL REFERENCES graph_snapshots(id),
  corpus_recording_id uuid NOT NULL REFERENCES corpus_recordings(id),
  corpus_catalog_identity_id uuid REFERENCES corpus_catalog_identities(id),
  identity_status varchar(32) NOT NULL DEFAULT 'pending',
  membership_status varchar(32) NOT NULL DEFAULT 'pending',
  relevance_status varchar(32) NOT NULL DEFAULT 'pending',
  selection_status varchar(32) NOT NULL DEFAULT 'pending',
  publication_status varchar(32) NOT NULL DEFAULT 'pending',
  ranking_score numeric(12,8),
  confidence numeric(8,6) NOT NULL DEFAULT 0,
  reason_codes_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_corpus_recording_links_pkey PRIMARY KEY(run_id,candidate_id),
  CONSTRAINT run_corpus_recording_link_confidence_valid CHECK (confidence BETWEEN 0 AND 1)
);
CREATE INDEX IF NOT EXISTS run_corpus_link_plan_status_idx
  ON run_corpus_recording_links(query_plan_revision_id,selection_status);
CREATE INDEX IF NOT EXISTS run_corpus_link_recording_idx
  ON run_corpus_recording_links(corpus_recording_id);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_run_corpus_recording_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE candidate_run uuid; plan_run uuid; plan_snapshot uuid; identity_recording uuid;
BEGIN
  SELECT run_id INTO candidate_run FROM track_candidates WHERE id=NEW.candidate_id;
  SELECT run_id,graph_snapshot_id INTO plan_run,plan_snapshot
    FROM query_plan_revisions WHERE id=NEW.query_plan_revision_id;
  IF candidate_run IS DISTINCT FROM NEW.run_id OR plan_run IS DISTINCT FROM NEW.run_id THEN
    RAISE EXCEPTION 'candidate and query plan must belong to the linked run'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF plan_snapshot IS DISTINCT FROM NEW.graph_snapshot_id THEN
    RAISE EXCEPTION 'run link graph snapshot must match the query plan revision'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF NEW.corpus_catalog_identity_id IS NOT NULL THEN
    SELECT recording_id INTO identity_recording FROM corpus_catalog_identities
      WHERE id=NEW.corpus_catalog_identity_id;
    IF identity_recording IS DISTINCT FROM NEW.corpus_recording_id THEN
      RAISE EXCEPTION 'catalog identity must belong to the linked corpus recording'
        USING ERRCODE='integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS run_corpus_recording_link_validate ON run_corpus_recording_links;
CREATE TRIGGER run_corpus_recording_link_validate
BEFORE INSERT OR UPDATE ON run_corpus_recording_links
FOR EACH ROW EXECUTE FUNCTION validate_run_corpus_recording_link();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS partial_publication_decisions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  manifest_revision_id uuid NOT NULL REFERENCES manifest_revisions(id) ON DELETE CASCADE,
  manifest_revision_hash varchar(64) NOT NULL,
  query_plan_revision_id uuid REFERENCES query_plan_revisions(id),
  capability_session_id uuid REFERENCES capability_sessions(id) ON DELETE SET NULL,
  outcome_hash varchar(64) NOT NULL,
  decision varchar(32) NOT NULL DEFAULT 'pending',
  target_count integer NOT NULL,
  selected_count integer NOT NULL,
  idempotency_key varchar(160) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partial_publication_decision_counts_valid CHECK (
    target_count BETWEEN 1 AND 300 AND selected_count BETWEEN 0 AND target_count
  ),
  CONSTRAINT partial_publication_decision_state_valid CHECK (
    decision IN ('pending','continue_research','publish_partial','change_request','expired')
  ),
  CONSTRAINT partial_publication_decision_time_valid CHECK (
    (decision='pending' AND decided_at IS NULL)
    OR (decision<>'pending' AND decided_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS partial_publication_decision_outcome_idx
  ON partial_publication_decisions(manifest_revision_id,outcome_hash,decision);
CREATE INDEX IF NOT EXISTS partial_publication_decision_run_expiry_idx
  ON partial_publication_decisions(run_id,expires_at);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_partial_publication_decision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE manifest_run uuid; revision_hash varchar(64); plan_run uuid;
BEGIN
  SELECT m.run_id,r.content_hash INTO manifest_run,revision_hash
    FROM manifest_revisions r JOIN manifests m ON m.id=r.manifest_id
    WHERE r.id=NEW.manifest_revision_id;
  IF manifest_run IS DISTINCT FROM NEW.run_id OR revision_hash IS DISTINCT FROM NEW.manifest_revision_hash THEN
    RAISE EXCEPTION 'partial decision run/hash must match its immutable manifest revision'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF NEW.query_plan_revision_id IS NOT NULL THEN
    SELECT run_id INTO plan_run FROM query_plan_revisions WHERE id=NEW.query_plan_revision_id;
    IF plan_run IS DISTINCT FROM NEW.run_id THEN
      RAISE EXCEPTION 'partial decision query plan belongs to another run'
        USING ERRCODE='integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS partial_publication_decision_validate ON partial_publication_decisions;
CREATE TRIGGER partial_publication_decision_validate
BEFORE INSERT OR UPDATE ON partial_publication_decisions
FOR EACH ROW EXECUTE FUNCTION validate_partial_publication_decision();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS publication_series (
  id uuid PRIMARY KEY,
  run_id uuid REFERENCES research_runs(id) ON DELETE SET NULL,
  title varchar(240) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS publication_series_run_idx ON publication_series(run_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS publication_revision_attempts (
  id uuid PRIMARY KEY,
  series_id uuid NOT NULL REFERENCES publication_series(id) ON DELETE CASCADE,
  manifest_revision_id uuid NOT NULL REFERENCES manifest_revisions(id),
  attempt integer NOT NULL DEFAULT 1,
  idempotency_key varchar(160) NOT NULL UNIQUE,
  status varchar(40) NOT NULL DEFAULT 'pending',
  content_hash varchar(64) NOT NULL,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publication_revision_attempt_positive CHECK (attempt > 0),
  CONSTRAINT publication_revision_attempt_series_id_unique UNIQUE(series_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS publication_attempt_series_revision_number_idx
  ON publication_revision_attempts(series_id,manifest_revision_id,attempt);
CREATE INDEX IF NOT EXISTS publication_attempt_manifest_revision_idx
  ON publication_revision_attempts(manifest_revision_id,status);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS publication_revision_volumes (
  id uuid PRIMARY KEY,
  publication_attempt_id uuid NOT NULL REFERENCES publication_revision_attempts(id) ON DELETE CASCADE,
  volume_number integer NOT NULL,
  volume_count integer NOT NULL,
  start_position integer NOT NULL,
  end_position integer NOT NULL,
  status varchar(40) NOT NULL DEFAULT 'pending',
  apple_playlist_id varchar(160),
  apple_share_url text,
  appended_count integer NOT NULL DEFAULT 0,
  last_error text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publication_revision_volume_bounds_valid CHECK (
    volume_number > 0 AND volume_count > 0 AND volume_number <= volume_count
    AND start_position > 0 AND end_position >= start_position AND appended_count >= 0
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS publication_revision_volume_number_idx
  ON publication_revision_volumes(publication_attempt_id,volume_number);
CREATE INDEX IF NOT EXISTS publication_revision_volume_apple_idx
  ON publication_revision_volumes(apple_playlist_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS publication_series_active_revisions (
  series_id uuid PRIMARY KEY REFERENCES publication_series(id) ON DELETE CASCADE,
  publication_attempt_id uuid NOT NULL UNIQUE,
  activated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publication_series_active_attempt_fk
    FOREIGN KEY(series_id,publication_attempt_id)
    REFERENCES publication_revision_attempts(series_id,id)
);
--> statement-breakpoint

-- V3 job fencing. The lease epoch changes only when ownership of a lease is
-- acquired, so a stale worker cannot write after a newer worker takes over.
ALTER TABLE job_queue
  ADD COLUMN IF NOT EXISTS query_plan_revision_id uuid,
  ADD COLUMN IF NOT EXISTS stage_key varchar(160) NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS lease_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS queue_class varchar(24) NOT NULL DEFAULT 'interactive';
DO $$ BEGIN
  ALTER TABLE job_queue ADD CONSTRAINT job_queue_query_plan_revision_fk
    FOREIGN KEY(query_plan_revision_id) REFERENCES query_plan_revisions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE job_queue ADD CONSTRAINT job_lease_epoch_valid CHECK (lease_epoch >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE job_queue ADD CONSTRAINT job_queue_class_valid
    CHECK (queue_class IN ('interactive','deep','publication','system'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS job_plan_stage_status_idx
  ON job_queue(run_id,query_plan_revision_id,stage_key,status);
CREATE INDEX IF NOT EXISTS job_queue_class_lease_idx
  ON job_queue(queue_class,status,available_at,lease_expires_at);
--> statement-breakpoint

UPDATE job_queue j
SET pipeline_version=r.pipeline_version,
    minimum_worker_protocol=CASE
      WHEN r.pipeline_version='corpus_first_v3' THEN 6
      WHEN r.pipeline_version='catalog_first_v2' THEN 5
      ELSE 4
    END
FROM research_runs r
WHERE j.run_id=r.id;
UPDATE job_queue j
SET pipeline_version=b.pipeline_version,
    minimum_worker_protocol=CASE
      WHEN b.pipeline_version='corpus_first_v3' THEN 6
      WHEN b.pipeline_version='catalog_first_v2' THEN 5
      ELSE 4
    END
FROM brief_requests b
WHERE j.run_id IS NULL AND j.brief_request_id=b.id;
--> statement-breakpoint

-- Backfill the physical worker boundary. Only V3 factual/exhaustive query
-- plans and explicitly tagged cold-corpus work are deep. Historical and
-- curated work drains through the interactive worker; user-token Apple writes
-- and system maintenance can never enter the deep lane.
UPDATE job_queue j
SET queue_class=CASE
  WHEN j.kind='publication' THEN 'publication'
  WHEN j.kind IN ('notification','apple_authorization','retention','pipeline_observability') THEN 'system'
  WHEN j.kind IN ('research','matching')
    AND EXISTS (
      SELECT 1 FROM query_plan_revisions q
      WHERE q.id=j.query_plan_revision_id
        AND (
          q.plan_json->>'engine' IN ('factual_relationship','exhaustive')
          OR q.plan_json->'engines' ?| ARRAY['factual_relationship','exhaustive']
        )
    ) THEN 'deep'
  WHEN j.kind IN ('research','matching')
    AND j.run_id IS NULL
    AND j.payload_json @> '{"workloadClass":"cold_corpus"}'::jsonb THEN 'deep'
  ELSE 'interactive'
END;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_job_queue_class()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE deep_plan boolean;
BEGIN
  IF NEW.kind='publication' THEN
    NEW.queue_class := 'publication';
  ELSIF NEW.kind IN ('notification','apple_authorization','retention','pipeline_observability') THEN
    NEW.queue_class := 'system';
  ELSIF NEW.kind IN ('research','matching') AND NEW.queue_class IN ('publication','system') THEN
    RAISE EXCEPTION 'job kind % cannot enter reserved queue class %',NEW.kind,NEW.queue_class
      USING ERRCODE='integrity_constraint_violation';
  ELSIF NEW.kind IN ('research','matching') THEN
    deep_plan := NEW.run_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM research_runs r
      JOIN query_plan_revisions q ON q.id=NEW.query_plan_revision_id AND q.run_id=r.id
      WHERE r.id=NEW.run_id
        AND r.pipeline_version='corpus_first_v3'
        AND (
          q.plan_json->>'engine' IN ('factual_relationship','exhaustive')
          OR q.plan_json->'engines' ?| ARRAY['factual_relationship','exhaustive']
        )
    );
    IF deep_plan OR (
      NEW.run_id IS NULL
      AND NEW.payload_json @> '{"workloadClass":"cold_corpus"}'::jsonb
    ) THEN
      NEW.queue_class := 'deep';
    ELSE
      NEW.queue_class := 'interactive';
    END IF;
  ELSIF NEW.queue_class IN ('publication','system','deep') THEN
    RAISE EXCEPTION 'job kind % cannot enter reserved queue class %',NEW.kind,NEW.queue_class
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS job_queue_class_enforce ON job_queue;
CREATE TRIGGER job_queue_class_enforce
BEFORE INSERT OR UPDATE OF kind,queue_class,run_id,query_plan_revision_id,payload_json
ON job_queue FOR EACH ROW EXECUTE FUNCTION enforce_job_queue_class();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION stamp_job_pipeline_protocol()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE persisted_pipeline varchar(48); plan_run uuid;
BEGIN
  persisted_pipeline := 'legacy_v1';
  IF NEW.run_id IS NOT NULL THEN
    SELECT pipeline_version INTO persisted_pipeline FROM research_runs WHERE id=NEW.run_id;
  ELSIF NEW.brief_request_id IS NOT NULL THEN
    SELECT pipeline_version INTO persisted_pipeline FROM brief_requests WHERE id=NEW.brief_request_id;
  END IF;
  persisted_pipeline := COALESCE(persisted_pipeline,'legacy_v1');
  NEW.pipeline_version := persisted_pipeline;
  NEW.minimum_worker_protocol := CASE
    WHEN persisted_pipeline='corpus_first_v3' THEN 6
    WHEN persisted_pipeline='catalog_first_v2' THEN 5
    ELSE 4
  END;
  IF NEW.query_plan_revision_id IS NOT NULL THEN
    SELECT run_id INTO plan_run FROM query_plan_revisions WHERE id=NEW.query_plan_revision_id;
    IF NEW.run_id IS NULL OR plan_run IS DISTINCT FROM NEW.run_id THEN
      RAISE EXCEPTION 'queued query plan must belong to the job run'
        USING ERRCODE='integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS job_pipeline_protocol_stamp ON job_queue;
CREATE TRIGGER job_pipeline_protocol_stamp
BEFORE INSERT OR UPDATE OF run_id,brief_request_id,pipeline_version,minimum_worker_protocol,query_plan_revision_id
ON job_queue FOR EACH ROW EXECUTE FUNCTION stamp_job_pipeline_protocol();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION fence_job_lease_epoch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.lease_epoch := CASE WHEN NEW.status='leased' THEN 1 ELSE 0 END;
  ELSIF NEW.status='leased' AND (
    OLD.status IS DISTINCT FROM 'leased' OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
  ) THEN
    NEW.lease_epoch := OLD.lease_epoch + 1;
  ELSE
    NEW.lease_epoch := OLD.lease_epoch;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS job_lease_epoch_fence ON job_queue;
CREATE TRIGGER job_lease_epoch_fence
BEFORE INSERT OR UPDATE OF status,lease_owner,lease_epoch
ON job_queue FOR EACH ROW EXECUTE FUNCTION fence_job_lease_epoch();
--> statement-breakpoint

-- Deterministic root used by the compatibility bridge before the governed
-- corpus contains any promotable assertions. Create it through the normal
-- building -> locked transition so count validation and immutability guards
-- are exercised even on a fresh installation. The content hash is the
-- service's canonical hash of {assertionIds:[],catalogIdentityIds:[],parentSnapshotId:null}.
INSERT INTO graph_snapshots(id,status)
VALUES('00000000-0000-4000-8000-000000000014','building')
ON CONFLICT DO NOTHING;
UPDATE graph_snapshots
SET status='locked',
    content_hash='f2b3e01c5bcbe9c259875fbd592e71bfd7fe4aa4e6399e212ee42fad8feb006a',
    assertion_count=0,
    catalog_identity_count=0,
    locked_at='2026-07-20T00:00:00.000Z'::timestamptz
WHERE id='00000000-0000-4000-8000-000000000014' AND status='building';
--> statement-breakpoint

INSERT INTO settings(key,value) VALUES('schema_version','14')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
