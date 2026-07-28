BEGIN;

-- Expand-only capacity change. Bridge binaries still admit at most 300, while
-- the activated artifact may admit authenticated owner/deep work through
-- 1,000. Widening CHECK constraints is rollback-compatible with old readers.
ALTER TABLE run_specs DROP CONSTRAINT IF EXISTS run_spec_requested_track_count_valid;
ALTER TABLE run_specs ADD CONSTRAINT run_spec_requested_track_count_valid
  CHECK (requested_track_count IS NULL OR requested_track_count BETWEEN 1 AND 1000);
ALTER TABLE guidance_question_sets
  DROP CONSTRAINT IF EXISTS guidance_question_sets_target_track_count_check;
ALTER TABLE guidance_question_sets ADD CONSTRAINT guidance_question_sets_target_track_count_check
  CHECK (target_track_count BETWEEN 1 AND 1000);
ALTER TABLE partial_publication_decisions
  DROP CONSTRAINT IF EXISTS partial_publication_decision_counts_valid;
ALTER TABLE partial_publication_decisions
  ADD CONSTRAINT partial_publication_decision_counts_valid CHECK (
    target_count BETWEEN 1 AND 1000
    AND selected_count BETWEEN 0 AND target_count
  );

ALTER TABLE brief_requests
  ADD COLUMN IF NOT EXISTS active_playlist_contract_revision_id uuid;
ALTER TABLE research_runs
  ADD COLUMN IF NOT EXISTS active_playlist_contract_revision_id uuid;

ALTER TABLE brief_requests DROP CONSTRAINT IF EXISTS brief_contract_version_valid;
ALTER TABLE research_runs DROP CONSTRAINT IF EXISTS run_brief_contract_version_valid;
ALTER TABLE run_specs DROP CONSTRAINT IF EXISTS run_spec_brief_contract_version_valid;
ALTER TABLE brief_requests ADD CONSTRAINT brief_contract_version_valid
  CHECK (brief_contract_version BETWEEN 1 AND 3);
ALTER TABLE research_runs ADD CONSTRAINT run_brief_contract_version_valid
  CHECK (brief_contract_version BETWEEN 1 AND 3);
ALTER TABLE run_specs ADD CONSTRAINT run_spec_brief_contract_version_valid
  CHECK (brief_contract_version BETWEEN 1 AND 3);

CREATE TABLE IF NOT EXISTS playlist_contract_revisions (
  id uuid PRIMARY KEY,
  brief_request_id uuid REFERENCES brief_requests(id) ON DELETE CASCADE,
  run_id uuid REFERENCES research_runs(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  parent_revision_id uuid REFERENCES playlist_contract_revisions(id) ON DELETE RESTRICT,
  status varchar(32) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','superseded','legacy_import')),
  contract_hash varchar(64) NOT NULL CHECK (contract_hash ~ '^[0-9a-f]{64}$'),
  contract_json jsonb NOT NULL,
  compiler_version varchar(80) NOT NULL,
  ontology_version varchar(80) NOT NULL,
  evidence_policy_version varchar(80) NOT NULL,
  question_template_version varchar(80) NOT NULL,
  catalog_policy_version varchar(80) NOT NULL,
  locale varchar(32) NOT NULL,
  storefront varchar(16) NOT NULL,
  answer_lineage_hash varchar(64) NOT NULL CHECK (answer_lineage_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(brief_request_id,run_id)=1),
  UNIQUE(brief_request_id,revision),
  UNIQUE(run_id,revision),
  UNIQUE(brief_request_id,contract_hash),
  UNIQUE(run_id,contract_hash)
);
CREATE INDEX IF NOT EXISTS playlist_contract_parent_idx
  ON playlist_contract_revisions(parent_revision_id);
CREATE INDEX IF NOT EXISTS playlist_contract_status_idx
  ON playlist_contract_revisions(status,created_at);

DO $$ BEGIN
  ALTER TABLE brief_requests ADD CONSTRAINT brief_active_playlist_contract_fk
    FOREIGN KEY(active_playlist_contract_revision_id)
    REFERENCES playlist_contract_revisions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE research_runs ADD CONSTRAINT run_active_playlist_contract_fk
    FOREIGN KEY(active_playlist_contract_revision_id)
    REFERENCES playlist_contract_revisions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS playlist_feasibility_snapshots (
  id uuid PRIMARY KEY,
  contract_revision_id uuid NOT NULL
    REFERENCES playlist_contract_revisions(id) ON DELETE CASCADE,
  phase varchar(40) NOT NULL CHECK (phase IN ('initial','post_guidance','recovery')),
  assessment varchar(40) NOT NULL CHECK (
    assessment IN (
      'contradictory','known_ceiling','likely','at_risk','unknown',
      'frontier_exhausted_under_policy'
    )
  ),
  target_count integer NOT NULL CHECK (target_count BETWEEN 1 AND 1000),
  observed_qualified_count integer NOT NULL DEFAULT 0 CHECK (observed_qualified_count >= 0),
  projected_lower_count integer CHECK (projected_lower_count IS NULL OR projected_lower_count >= 0),
  projected_upper_count integer CHECK (projected_upper_count IS NULL OR projected_upper_count >= 0),
  confidence numeric(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  report_hash varchar(64) NOT NULL CHECK (report_hash ~ '^[0-9a-f]{64}$'),
  report_json jsonb NOT NULL,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    projected_lower_count IS NULL
    OR projected_upper_count IS NULL
    OR projected_lower_count <= projected_upper_count
  ),
  UNIQUE(contract_revision_id,report_hash)
);
CREATE INDEX IF NOT EXISTS playlist_feasibility_contract_idx
  ON playlist_feasibility_snapshots(contract_revision_id,created_at);

CREATE TABLE IF NOT EXISTS playlist_execution_attempts (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  contract_revision_id uuid NOT NULL
    REFERENCES playlist_contract_revisions(id) ON DELETE CASCADE,
  stage varchar(80) NOT NULL,
  dependency_key varchar(120),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  lease_generation integer NOT NULL CHECK (lease_generation >= 0),
  executor_revision varchar(160) NOT NULL,
  executor_identity_hash varchar(64) NOT NULL
    CHECK (executor_identity_hash ~ '^[0-9a-f]{64}$'),
  configuration_hash varchar(64) NOT NULL CHECK (configuration_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key varchar(160) NOT NULL UNIQUE,
  checkpoint_cursor varchar(240),
  status varchar(40) NOT NULL CHECK (
    status IN ('queued','running','blocked','complete','cancelled','discarded','failed')
  ),
  blocker_kind varchar(64),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,contract_revision_id,stage,attempt_number,lease_generation)
);
CREATE INDEX IF NOT EXISTS playlist_execution_attempt_run_idx
  ON playlist_execution_attempts(run_id,started_at);

CREATE TABLE IF NOT EXISTS playlist_run_blockers (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  contract_revision_id uuid NOT NULL
    REFERENCES playlist_contract_revisions(id) ON DELETE CASCADE,
  blocker_kind varchar(64) NOT NULL CHECK (
    blocker_kind IN (
      'guidance','scope_decision','provider','apple_authorization','budget',
      'integrity','publication_reconciliation'
    )
  ),
  dependency_key varchar(120),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_retry_at timestamptz,
  automatic_retry_until timestamptz,
  state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS playlist_run_blocker_active_idx
  ON playlist_run_blockers(run_id,resolved_at,next_retry_at);

ALTER TABLE guidance_question_sets
  ALTER COLUMN brief_request_id DROP NOT NULL;
ALTER TABLE guidance_question_sets
  ADD COLUMN IF NOT EXISTS run_id uuid
    REFERENCES research_runs(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS base_contract_revision_id uuid
    REFERENCES playlist_contract_revisions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parent_question_set_id uuid
    REFERENCES guidance_question_sets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS feasibility_snapshot_id uuid
    REFERENCES playlist_feasibility_snapshots(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS guidance_round varchar(24) NOT NULL DEFAULT 'initial',
  ADD COLUMN IF NOT EXISTS trigger varchar(24) NOT NULL DEFAULT 'nuance',
  ADD COLUMN IF NOT EXISTS axis varchar(80);
DO $$ BEGIN
  ALTER TABLE guidance_question_sets ADD CONSTRAINT guidance_question_sets_owner_valid
    CHECK (num_nonnulls(brief_request_id,run_id)=1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS guidance_question_sets_run_revision_idx
  ON guidance_question_sets(run_id,revision);
CREATE UNIQUE INDEX IF NOT EXISTS guidance_question_sets_run_hash_idx
  ON guidance_question_sets(run_id,question_set_hash);
CREATE UNIQUE INDEX IF NOT EXISTS guidance_question_sets_run_active_idx
  ON guidance_question_sets(run_id) WHERE active;
DO $$ BEGIN
  ALTER TABLE guidance_question_sets ADD CONSTRAINT guidance_question_sets_round_valid
    CHECK (guidance_round IN ('initial','rescue'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE guidance_question_sets ADD CONSTRAINT guidance_question_sets_trigger_valid
    CHECK (trigger IN ('correctness','yield_risk','nuance'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE guidance_answer_sets
  ALTER COLUMN brief_request_id DROP NOT NULL;
ALTER TABLE guidance_answer_sets
  ADD COLUMN IF NOT EXISTS run_id uuid
    REFERENCES research_runs(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS base_contract_revision_id uuid
    REFERENCES playlist_contract_revisions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resulting_contract_revision_id uuid
    REFERENCES playlist_contract_revisions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS invalidated_at timestamptz;
DO $$ BEGIN
  ALTER TABLE guidance_answer_sets ADD CONSTRAINT guidance_answer_sets_owner_valid
    CHECK (num_nonnulls(brief_request_id,run_id)=1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS guidance_answer_sets_run_idempotency_idx
  ON guidance_answer_sets(run_id,idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS guidance_answer_sets_run_hash_idx
  ON guidance_answer_sets(run_id,answer_hash);

CREATE OR REPLACE FUNCTION permit_playlist_contract_supersession() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='active' AND NEW.status='superseded'
     AND (to_jsonb(OLD)-'status')=(to_jsonb(NEW)-'status') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only except for supersession',TG_TABLE_NAME;
END $$;
DROP TRIGGER IF EXISTS playlist_contract_revisions_immutable ON playlist_contract_revisions;
CREATE TRIGGER playlist_contract_revisions_immutable
BEFORE UPDATE ON playlist_contract_revisions
FOR EACH ROW EXECUTE FUNCTION permit_playlist_contract_supersession();

CREATE OR REPLACE FUNCTION permit_feasibility_invalidation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.invalidated_at IS NULL AND NEW.invalidated_at IS NOT NULL
     AND (to_jsonb(OLD)-'invalidated_at')=(to_jsonb(NEW)-'invalidated_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only except for invalidation',TG_TABLE_NAME;
END $$;
DROP TRIGGER IF EXISTS playlist_feasibility_snapshots_immutable
  ON playlist_feasibility_snapshots;
CREATE TRIGGER playlist_feasibility_snapshots_immutable
BEFORE UPDATE ON playlist_feasibility_snapshots
FOR EACH ROW EXECUTE FUNCTION permit_feasibility_invalidation();

CREATE OR REPLACE FUNCTION permit_guidance_answer_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(OLD)
        - 'resulting_selection_plan_id'
        - 'resulting_query_plan_revision_id'
        - 'resulting_contract_revision_id'
        - 'invalidated_at')
     <> (to_jsonb(NEW)
        - 'resulting_selection_plan_id'
        - 'resulting_query_plan_revision_id'
        - 'resulting_contract_revision_id'
        - 'invalidated_at') THEN
    RAISE EXCEPTION '% is append-only: immutable answer fields changed',TG_TABLE_NAME;
  END IF;
  IF OLD.resulting_selection_plan_id IS NOT NULL
     AND NEW.resulting_selection_plan_id IS DISTINCT FROM OLD.resulting_selection_plan_id THEN
    RAISE EXCEPTION 'resulting selection plan binding is immutable';
  END IF;
  IF OLD.resulting_query_plan_revision_id IS NOT NULL
     AND NEW.resulting_query_plan_revision_id IS DISTINCT FROM OLD.resulting_query_plan_revision_id THEN
    RAISE EXCEPTION 'resulting query plan binding is immutable';
  END IF;
  IF OLD.resulting_contract_revision_id IS NOT NULL
     AND NEW.resulting_contract_revision_id IS DISTINCT FROM OLD.resulting_contract_revision_id THEN
    RAISE EXCEPTION 'resulting contract binding is immutable';
  END IF;
  IF OLD.invalidated_at IS NOT NULL
     AND NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at THEN
    RAISE EXCEPTION 'answer invalidation is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guidance_answer_sets_immutable ON guidance_answer_sets;
CREATE TRIGGER guidance_answer_sets_immutable BEFORE UPDATE ON guidance_answer_sets
FOR EACH ROW EXECUTE FUNCTION permit_guidance_answer_binding();

CREATE OR REPLACE FUNCTION stamp_job_pipeline_protocol()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  persisted_pipeline varchar(48);
  persisted_contract integer;
  plan_run uuid;
  plan_schema integer;
BEGIN
  persisted_pipeline := 'legacy_v1';
  persisted_contract := 1;
  IF NEW.run_id IS NOT NULL THEN
    SELECT pipeline_version,brief_contract_version
      INTO persisted_pipeline,persisted_contract FROM research_runs WHERE id=NEW.run_id;
  ELSIF NEW.brief_request_id IS NOT NULL THEN
    SELECT pipeline_version,brief_contract_version
      INTO persisted_pipeline,persisted_contract FROM brief_requests WHERE id=NEW.brief_request_id;
  END IF;
  persisted_pipeline := COALESCE(persisted_pipeline,'legacy_v1');
  persisted_contract := COALESCE(persisted_contract,1);
  NEW.pipeline_version := persisted_pipeline;
  NEW.minimum_worker_protocol := CASE
    WHEN persisted_pipeline='corpus_first_v3' THEN 6
    WHEN persisted_pipeline='catalog_first_v2' THEN 5
    ELSE 4
  END;
  IF persisted_contract >= 3 THEN
    NEW.minimum_worker_protocol := GREATEST(NEW.minimum_worker_protocol,10);
  ELSIF persisted_contract >= 2 THEN
    NEW.minimum_worker_protocol := GREATEST(NEW.minimum_worker_protocol,9);
  END IF;
  IF NEW.query_plan_revision_id IS NOT NULL THEN
    SELECT run_id,COALESCE((plan_json->>'schemaVersion')::integer,1)
      INTO plan_run,plan_schema FROM query_plan_revisions WHERE id=NEW.query_plan_revision_id;
    IF NEW.run_id IS NULL OR plan_run IS DISTINCT FROM NEW.run_id THEN
      RAISE EXCEPTION 'queued query plan must belong to the job run'
        USING ERRCODE='integrity_constraint_violation';
    END IF;
    IF plan_schema = 2 THEN
      NEW.minimum_worker_protocol := GREATEST(NEW.minimum_worker_protocol,8);
    ELSIF plan_schema = 3 THEN
      NEW.minimum_worker_protocol := GREATEST(NEW.minimum_worker_protocol,9);
    ELSIF plan_schema >= 4 THEN
      NEW.minimum_worker_protocol := GREATEST(NEW.minimum_worker_protocol,10);
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS job_pipeline_protocol_stamp ON job_queue;
CREATE TRIGGER job_pipeline_protocol_stamp
BEFORE INSERT OR UPDATE OF run_id,brief_request_id,pipeline_version,minimum_worker_protocol,query_plan_revision_id
ON job_queue FOR EACH ROW EXECUTE FUNCTION stamp_job_pipeline_protocol();

INSERT INTO settings(key,value,updated_at)
VALUES('schema_version','17',now())
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;

COMMIT;
