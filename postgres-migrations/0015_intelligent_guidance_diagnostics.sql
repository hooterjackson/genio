BEGIN;

ALTER TABLE brief_requests
  ADD COLUMN IF NOT EXISTS brief_contract_version integer NOT NULL DEFAULT 1;
ALTER TABLE research_runs
  ADD COLUMN IF NOT EXISTS brief_contract_version integer NOT NULL DEFAULT 1;
ALTER TABLE run_specs
  ADD COLUMN IF NOT EXISTS brief_contract_version integer NOT NULL DEFAULT 1;

DO $$ BEGIN
  ALTER TABLE brief_requests ADD CONSTRAINT brief_contract_version_valid
    CHECK (brief_contract_version BETWEEN 1 AND 2);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE research_runs ADD CONSTRAINT run_brief_contract_version_valid
    CHECK (brief_contract_version BETWEEN 1 AND 2);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE run_specs ADD CONSTRAINT run_spec_brief_contract_version_valid
    CHECK (brief_contract_version BETWEEN 1 AND 2);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS guidance_question_sets (
  id uuid PRIMARY KEY,
  brief_request_id uuid NOT NULL REFERENCES brief_requests(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  question_set_hash varchar(64) NOT NULL CHECK (question_set_hash ~ '^[0-9a-f]{64}$'),
  request_classification varchar(40) NOT NULL CHECK (
    request_classification IN ('precise','broad_curated','critical_ambiguity','preference_ambiguity')
  ),
  generation_mode varchar(40) NOT NULL,
  guidance_policy_version varchar(80) NOT NULL,
  locale varchar(32) NOT NULL,
  storefront varchar(16) NOT NULL,
  target_track_count integer NOT NULL CHECK (target_track_count BETWEEN 1 AND 300),
  explicit_constraint_hash varchar(64) NOT NULL CHECK (explicit_constraint_hash ~ '^[0-9a-f]{64}$'),
  rejected_question_reasons_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  questions_json jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(brief_request_id, revision),
  UNIQUE(brief_request_id, question_set_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS guidance_question_sets_active_idx
  ON guidance_question_sets(brief_request_id) WHERE active;
CREATE INDEX IF NOT EXISTS guidance_question_sets_policy_idx
  ON guidance_question_sets(guidance_policy_version, created_at);

ALTER TABLE brief_requests
  ADD COLUMN IF NOT EXISTS active_guidance_question_set_id uuid;
DO $$ BEGIN
  ALTER TABLE brief_requests ADD CONSTRAINT brief_active_guidance_question_set_fk
    FOREIGN KEY(active_guidance_question_set_id) REFERENCES guidance_question_sets(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS guidance_answer_sets (
  id uuid PRIMARY KEY,
  brief_request_id uuid NOT NULL REFERENCES brief_requests(id) ON DELETE CASCADE,
  question_set_id uuid NOT NULL REFERENCES guidance_question_sets(id) ON DELETE CASCADE,
  question_set_hash varchar(64) NOT NULL CHECK (question_set_hash ~ '^[0-9a-f]{64}$'),
  normalized_answers_json jsonb NOT NULL,
  raw_custom_answers_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  answer_hash varchar(64) NOT NULL CHECK (answer_hash ~ '^[0-9a-f]{64}$'),
  execution_delta_json jsonb NOT NULL,
  execution_delta_hash varchar(64) NOT NULL CHECK (execution_delta_hash ~ '^[0-9a-f]{64}$'),
  resulting_selection_plan_id uuid REFERENCES selection_plans(id) ON DELETE SET NULL,
  resulting_query_plan_revision_id uuid REFERENCES query_plan_revisions(id) ON DELETE SET NULL,
  idempotency_key varchar(160) NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(brief_request_id, idempotency_key),
  UNIQUE(brief_request_id, answer_hash)
);
CREATE INDEX IF NOT EXISTS guidance_answer_sets_question_set_idx
  ON guidance_answer_sets(question_set_id, accepted_at);

CREATE TABLE IF NOT EXISTS run_stage_metric_summaries (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  query_plan_revision_id uuid REFERENCES query_plan_revisions(id) ON DELETE CASCADE,
  stage_key varchar(120) NOT NULL,
  metric_revision integer NOT NULL DEFAULT 1 CHECK (metric_revision > 0),
  provider_rows integer NOT NULL DEFAULT 0 CHECK (provider_rows >= 0),
  unique_valid_leads integer NOT NULL DEFAULT 0 CHECK (unique_valid_leads >= 0),
  requalification_attempts integer NOT NULL DEFAULT 0 CHECK (requalification_attempts >= 0),
  citation_bearing_leads integer NOT NULL DEFAULT 0 CHECK (citation_bearing_leads >= 0),
  exact_pair_attestations integer NOT NULL DEFAULT 0 CHECK (exact_pair_attestations >= 0),
  containers_discovered integer NOT NULL DEFAULT 0 CHECK (containers_discovered >= 0),
  containers_enumerated integer NOT NULL DEFAULT 0 CHECK (containers_enumerated >= 0),
  scope_bound_candidates integer NOT NULL DEFAULT 0 CHECK (scope_bound_candidates >= 0),
  evidence_qualified_candidates integer NOT NULL DEFAULT 0 CHECK (evidence_qualified_candidates >= 0),
  apple_resolution_attempts integer NOT NULL DEFAULT 0 CHECK (apple_resolution_attempts >= 0),
  apple_provider_requests integer NOT NULL DEFAULT 0 CHECK (apple_provider_requests >= 0),
  apple_matches integer NOT NULL DEFAULT 0 CHECK (apple_matches >= 0),
  recording_families integer NOT NULL DEFAULT 0 CHECK (recording_families >= 0),
  selected_count integer NOT NULL DEFAULT 0 CHECK (selected_count >= 0),
  reserve_count integer NOT NULL DEFAULT 0 CHECK (reserve_count >= 0),
  manifested_count integer NOT NULL DEFAULT 0 CHECK (manifested_count >= 0),
  published_count integer NOT NULL DEFAULT 0 CHECK (published_count >= 0),
  stop_reason varchar(120),
  root_cause varchar(160),
  downstream_state varchar(160),
  terminal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS run_stage_metric_summaries_revision_idx
  ON run_stage_metric_summaries(
    run_id,
    COALESCE(query_plan_revision_id,'00000000-0000-0000-0000-000000000000'::uuid),
    stage_key,
    metric_revision
  );
CREATE INDEX IF NOT EXISTS run_stage_metric_summaries_run_idx
  ON run_stage_metric_summaries(run_id, created_at);

CREATE TABLE IF NOT EXISTS provider_metric_events (
  id uuid PRIMARY KEY,
  run_id uuid REFERENCES research_runs(id) ON DELETE CASCADE,
  provider varchar(80) NOT NULL,
  operation varchar(120) NOT NULL,
  stage_key varchar(120) NOT NULL,
  metric_name varchar(120) NOT NULL,
  metric_value integer NOT NULL CHECK (metric_value >= 0),
  request_outcome varchar(48) NOT NULL,
  cache_outcome varchar(48),
  idempotency_key varchar(160) NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_metric_events_run_idx
  ON provider_metric_events(run_id, occurred_at);
CREATE INDEX IF NOT EXISTS provider_metric_events_expiry_idx
  ON provider_metric_events(expires_at);

CREATE TABLE IF NOT EXISTS run_source_observations (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  query_plan_revision_id uuid REFERENCES query_plan_revisions(id) ON DELETE CASCADE,
  provider_metric_event_id uuid REFERENCES provider_metric_events(id) ON DELETE SET NULL,
  idempotency_key varchar(160) NOT NULL UNIQUE,
  allowed_host varchar(240) NOT NULL,
  resource_type varchar(80) NOT NULL,
  extraction_method varchar(80) NOT NULL,
  attempt_outcome varchar(80) NOT NULL,
  locator_hash varchar(64) NOT NULL CHECK (locator_hash ~ '^[0-9a-f]{64}$'),
  provider_rows integer NOT NULL DEFAULT 0 CHECK (provider_rows >= 0),
  unique_valid_leads integer NOT NULL DEFAULT 0 CHECK (unique_valid_leads >= 0),
  citation_bearing_leads integer NOT NULL DEFAULT 0 CHECK (citation_bearing_leads >= 0),
  exact_pair_attestations integer NOT NULL DEFAULT 0 CHECK (exact_pair_attestations >= 0),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_source_observations_run_idx
  ON run_source_observations(run_id, created_at);

CREATE TABLE IF NOT EXISTS provider_metric_daily_aggregates (
  metric_date date NOT NULL,
  provider varchar(80) NOT NULL,
  operation varchar(120) NOT NULL,
  metric_name varchar(120) NOT NULL,
  metric_value bigint NOT NULL DEFAULT 0 CHECK (metric_value >= 0),
  event_count bigint NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '13 months'),
  PRIMARY KEY(metric_date, provider, operation, metric_name)
);
CREATE INDEX IF NOT EXISTS provider_metric_daily_expiry_idx
  ON provider_metric_daily_aggregates(expires_at);

CREATE TABLE IF NOT EXISTS quality_incident_groups (
  id uuid PRIMARY KEY,
  incident_signature varchar(64) NOT NULL UNIQUE CHECK (incident_signature ~ '^[0-9a-f]{64}$'),
  incident_class varchar(80) NOT NULL,
  stop_reason varchar(120),
  root_cause varchar(160),
  downstream_state varchar(160),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  total_count bigint NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  overflow_count bigint NOT NULL DEFAULT 0 CHECK (overflow_count >= 0),
  qa_promoted boolean NOT NULL DEFAULT false,
  qa_promoted_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '13 months'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quality_incident_groups_expiry_idx
  ON quality_incident_groups(expires_at);

CREATE TABLE IF NOT EXISTS quality_incident_daily_counters (
  incident_date date PRIMARY KEY,
  detailed_count integer NOT NULL DEFAULT 0 CHECK (detailed_count >= 0),
  overflow_count integer NOT NULL DEFAULT 0 CHECK (overflow_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Irreversible hashes prevent retries from inflating anonymous overflow
-- aggregates without retaining a run or visitor identifier past the cap.
CREATE TABLE IF NOT EXISTS quality_incident_event_keys (
  event_hash varchar(64) PRIMARY KEY CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  incident_date date NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quality_incident_event_keys_expiry_idx
  ON quality_incident_event_keys(expires_at);

CREATE TABLE IF NOT EXISTS quality_incident_occurrences (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES quality_incident_groups(id) ON DELETE CASCADE,
  run_id uuid REFERENCES research_runs(id) ON DELETE CASCADE,
  run_access_id uuid REFERENCES run_accesses(id) ON DELETE CASCADE,
  brief_request_id uuid REFERENCES brief_requests(id) ON DELETE CASCADE,
  plan_revision integer,
  terminal_outcome_hash varchar(64) NOT NULL CHECK (terminal_outcome_hash ~ '^[0-9a-f]{64}$'),
  stop_reason varchar(120),
  root_cause varchar(160),
  downstream_state varchar(160),
  diagnostics_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key varchar(160) NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (brief_request_id IS NOT NULL AND run_id IS NULL AND run_access_id IS NULL)
    OR (run_id IS NOT NULL AND brief_request_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS quality_incident_occurrences_group_idx
  ON quality_incident_occurrences(group_id, occurred_at);
CREATE INDEX IF NOT EXISTS quality_incident_occurrences_run_idx
  ON quality_incident_occurrences(run_id, occurred_at);
CREATE INDEX IF NOT EXISTS quality_incident_occurrences_expiry_idx
  ON quality_incident_occurrences(expires_at);

CREATE OR REPLACE FUNCTION prevent_guidance_revision_update() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE OR REPLACE FUNCTION permit_guidance_question_set_deactivation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.active AND NOT NEW.active
     AND (to_jsonb(OLD) - 'active') = (to_jsonb(NEW) - 'active') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only except for deactivation', TG_TABLE_NAME;
END $$;
DROP TRIGGER IF EXISTS guidance_question_sets_immutable ON guidance_question_sets;
CREATE TRIGGER guidance_question_sets_immutable BEFORE UPDATE ON guidance_question_sets
FOR EACH ROW EXECUTE FUNCTION permit_guidance_question_set_deactivation();
DROP TRIGGER IF EXISTS guidance_answer_sets_immutable ON guidance_answer_sets;
CREATE TRIGGER guidance_answer_sets_immutable BEFORE UPDATE ON guidance_answer_sets
FOR EACH ROW EXECUTE FUNCTION prevent_guidance_revision_update();
DROP TRIGGER IF EXISTS run_stage_terminal_immutable ON run_stage_metric_summaries;
CREATE TRIGGER run_stage_terminal_immutable BEFORE UPDATE ON run_stage_metric_summaries
FOR EACH ROW WHEN (OLD.terminal) EXECUTE FUNCTION prevent_guidance_revision_update();

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
  IF persisted_contract >= 2 THEN
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
    ELSIF plan_schema >= 3 THEN
      NEW.minimum_worker_protocol := GREATEST(NEW.minimum_worker_protocol,9);
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS job_pipeline_protocol_stamp ON job_queue;
CREATE TRIGGER job_pipeline_protocol_stamp
BEFORE INSERT OR UPDATE OF run_id,brief_request_id,pipeline_version,minimum_worker_protocol,query_plan_revision_id
ON job_queue FOR EACH ROW EXECUTE FUNCTION stamp_job_pipeline_protocol();

UPDATE job_queue job
SET minimum_worker_protocol=GREATEST(job.minimum_worker_protocol,9)
FROM research_runs run
WHERE job.run_id=run.id AND run.brief_contract_version >= 2;
UPDATE job_queue job
SET minimum_worker_protocol=GREATEST(job.minimum_worker_protocol,9)
FROM brief_requests brief
WHERE job.brief_request_id=brief.id AND brief.brief_contract_version >= 2;
UPDATE job_queue job
SET minimum_worker_protocol=GREATEST(
  job.minimum_worker_protocol,
  CASE WHEN (query.plan_json->>'schemaVersion')::integer >= 3 THEN 9 ELSE 8 END
)
FROM query_plan_revisions query
WHERE job.query_plan_revision_id=query.id
  AND (query.plan_json->>'schemaVersion')::integer >= 2;

INSERT INTO settings(key,value,updated_at)
VALUES('schema_version','16',now())
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;

COMMIT;
