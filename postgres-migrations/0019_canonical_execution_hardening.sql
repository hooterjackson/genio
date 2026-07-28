BEGIN;

-- A canonical job is executable only by a worker advertising the exact
-- schema-aware capability vector used when its immutable query plan was
-- compiled. Historical under-specified canonical jobs remain NULL and are
-- intentionally ineligible for leasing.
ALTER TABLE job_queue
  ADD COLUMN IF NOT EXISTS required_executor_capability_hash varchar(64),
  ADD COLUMN IF NOT EXISTS required_executor_capability_vector jsonb;
DO $$ BEGIN
  ALTER TABLE job_queue
    ADD CONSTRAINT job_required_executor_capability_complete
    CHECK (
      (required_executor_capability_hash IS NULL
        AND required_executor_capability_vector IS NULL)
      OR (
        required_executor_capability_hash ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof(required_executor_capability_vector)='object'
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS job_executor_capability_lease_idx
  ON job_queue(
    status,required_executor_capability_hash,available_at,lease_expires_at
  );

CREATE OR REPLACE FUNCTION stamp_job_executor_capability()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  plan_schema integer;
  plan_hash text;
  plan_vector jsonb;
BEGIN
  IF NEW.query_plan_revision_id IS NULL THEN
    NEW.required_executor_capability_hash := NULL;
    NEW.required_executor_capability_vector := NULL;
    RETURN NEW;
  END IF;

  SELECT
    COALESCE((plan_json->>'schemaVersion')::integer,1),
    plan_json->>'executorCapabilityHash',
    plan_json->'executorCapabilityVector'
  INTO plan_schema,plan_hash,plan_vector
  FROM query_plan_revisions
  WHERE id=NEW.query_plan_revision_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'queued query plan is missing'
      USING ERRCODE='integrity_constraint_violation';
  END IF;

  IF plan_schema >= 4 THEN
    IF plan_hash IS NULL
       OR plan_hash !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(plan_vector) IS DISTINCT FROM 'object' THEN
      -- Expand compatibility: the v10/schema-4 artifact remains live while
      -- this migration is applied and may continue enqueueing its historical
      -- under-specified jobs. New workers reject these NULL fences. Schema 5
      -- is the first artifact for which the fence is mandatory at write time.
      IF plan_schema >= 5 THEN
        RAISE EXCEPTION 'canonical query plan lacks an executor capability fence'
          USING ERRCODE='integrity_constraint_violation';
      END IF;
      NEW.required_executor_capability_hash := NULL;
      NEW.required_executor_capability_vector := NULL;
      RETURN NEW;
    END IF;
    NEW.required_executor_capability_hash := plan_hash;
    NEW.required_executor_capability_vector := plan_vector;
  ELSE
    NEW.required_executor_capability_hash := NULL;
    NEW.required_executor_capability_vector := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS job_executor_capability_stamp ON job_queue;
CREATE TRIGGER job_executor_capability_stamp
BEFORE INSERT OR UPDATE OF query_plan_revision_id
ON job_queue FOR EACH ROW EXECUTE FUNCTION stamp_job_executor_capability();

-- Attempt accounting records only intervals in which a particular lease was
-- actively executing. Queue time, dependency waits, and an abandoned lease
-- after its last heartbeat are not charged to the contract compute budget.
ALTER TABLE playlist_execution_attempts
  ADD COLUMN IF NOT EXISTS job_id uuid
    REFERENCES job_queue(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS executor_capability_hash varchar(64),
  ADD COLUMN IF NOT EXISTS executor_capability_vector jsonb,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  -- Keep a database default during the expand overlap so the still-serving
  -- schema-18 artifact can drain legacy attempts after 0019 is applied.
  ADD COLUMN IF NOT EXISTS last_active_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS active_compute_ms bigint NOT NULL DEFAULT 0;

UPDATE playlist_execution_attempts
SET active_compute_ms=GREATEST(
      0,
      floor(EXTRACT(EPOCH FROM (completed_at-started_at))*1000)::bigint
    ),
    last_active_at=completed_at
WHERE completed_at IS NOT NULL
  AND active_compute_ms=0;
UPDATE playlist_execution_attempts
SET last_active_at=started_at
WHERE last_active_at IS NULL;
ALTER TABLE playlist_execution_attempts
  ALTER COLUMN last_active_at SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE playlist_execution_attempts
    ADD CONSTRAINT playlist_execution_attempt_capability_complete
    CHECK (
      (executor_capability_hash IS NULL
        AND executor_capability_vector IS NULL)
      OR (
        executor_capability_hash ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof(executor_capability_vector)='object'
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE playlist_execution_attempts
    ADD CONSTRAINT playlist_execution_attempt_active_compute_valid
    CHECK (
      active_compute_ms >= 0
      AND last_active_at >= started_at
      AND (completed_at IS NULL OR completed_at >= started_at)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS playlist_execution_attempt_job_generation_idx
  ON playlist_execution_attempts(job_id,lease_generation,status);

CREATE OR REPLACE FUNCTION close_reclaimed_playlist_execution_attempt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='leased'
     AND (
       NEW.status IS DISTINCT FROM 'leased'
       OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
       OR NEW.lease_epoch IS DISTINCT FROM OLD.lease_epoch
     ) THEN
    UPDATE playlist_execution_attempts attempt
    SET completed_at=LEAST(
          COALESCE(attempt.last_active_at,attempt.started_at),
          COALESCE(attempt.lease_expires_at,OLD.lease_expires_at,attempt.started_at)
        ),
        active_compute_ms=attempt.active_compute_ms + GREATEST(
          0,
          floor(EXTRACT(EPOCH FROM (
            LEAST(
              COALESCE(attempt.last_active_at,attempt.started_at),
              COALESCE(attempt.lease_expires_at,OLD.lease_expires_at,attempt.started_at)
            )-COALESCE(attempt.last_active_at,attempt.started_at)
          ))*1000)::bigint
        ),
        status='discarded'
    WHERE attempt.job_id=OLD.id
      AND attempt.lease_generation=OLD.lease_epoch
      AND attempt.status='running';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS close_reclaimed_playlist_execution_attempt_trigger
  ON job_queue;
CREATE TRIGGER close_reclaimed_playlist_execution_attempt_trigger
AFTER UPDATE OF status,lease_owner,lease_epoch ON job_queue
FOR EACH ROW EXECUTE FUNCTION close_reclaimed_playlist_execution_attempt();

-- Provenance diversity and freshness are first-class persisted facts. A cache
-- entry may accelerate discovery, but stale or concentrated inventory cannot
-- masquerade as an independently qualified frontier.
ALTER TABLE playlist_discovery_leads
  ADD COLUMN IF NOT EXISTS dependency_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS provenance_roots text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS cache_origin varchar(32) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS source_fresh_until timestamptz;
ALTER TABLE playlist_discovery_leads
  ALTER COLUMN cache_origin SET DEFAULT 'unknown';
UPDATE playlist_discovery_leads
SET cache_origin='unknown'
WHERE cache_origin='live'
  AND dependency_ids='{}'::text[]
  AND provenance_roots='{}'::text[];
DO $$ BEGIN
  ALTER TABLE playlist_discovery_leads
    ADD CONSTRAINT playlist_discovery_lead_cache_origin_valid
    CHECK (cache_origin IN (
      'live','fresh_cache','governed_snapshot','orchestration_local','unknown'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS playlist_discovery_lead_source_diversity_idx
  ON playlist_discovery_leads(
    run_id,contract_revision_id,cache_origin,source_fresh_until
  );

ALTER TABLE pipeline_candidate_leads
  ADD COLUMN IF NOT EXISTS dependency_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS provenance_roots text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS cache_origin varchar(32) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS source_fresh_until timestamptz;
ALTER TABLE pipeline_candidate_leads
  ALTER COLUMN cache_origin SET DEFAULT 'unknown';
UPDATE pipeline_candidate_leads
SET cache_origin='unknown'
WHERE cache_origin='live'
  AND dependency_ids='{}'::text[]
  AND provenance_roots='{}'::text[];
DO $$ BEGIN
  ALTER TABLE pipeline_candidate_leads
    ADD CONSTRAINT pipeline_candidate_lead_cache_origin_valid
    CHECK (cache_origin IN (
      'live','fresh_cache','governed_snapshot','orchestration_local','unknown'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS pipeline_candidate_lead_source_diversity_idx
  ON pipeline_candidate_leads(
    run_id,query_plan_revision_id,cache_origin,source_fresh_until
  );

-- Schema 18 predates this additive hardening. Use a new marker: overwriting
-- the 0018 marker would make the serving schema-18 artifact fail readiness.
INSERT INTO settings(key,value,updated_at)
VALUES('canonical_execution_hardening_version','1',now())
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;

COMMIT;
