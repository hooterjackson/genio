BEGIN;

-- Schema-5 work, including publication jobs whose immutable plan is reached
-- through the run pointer, is bound to the exact source artifact and secret-free
-- semantic configuration that accepted it. The nullable pair keeps legacy
-- and already-queued schema-4 work expand-compatible; new schema-5 writes are
-- rejected unless the candidate API supplies the complete immutable fence.
ALTER TABLE job_queue
  ADD COLUMN IF NOT EXISTS required_executor_revision varchar(160),
  ADD COLUMN IF NOT EXISTS
    required_executor_semantic_configuration_hash varchar(64);

DO $$ BEGIN
  ALTER TABLE job_queue
    ADD CONSTRAINT job_required_executor_release_identity_complete
    CHECK (
      (
        required_executor_revision IS NULL
        AND required_executor_semantic_configuration_hash IS NULL
      )
      OR (
        required_executor_revision
          ~ '^[0-9A-Za-z][0-9A-Za-z._:+-]{0,159}$'
        AND required_executor_semantic_configuration_hash
          ~ '^[0-9a-f]{64}$'
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS job_executor_release_identity_lease_idx
  ON job_queue(
    status,
    required_executor_revision,
    required_executor_semantic_configuration_hash,
    available_at,
    lease_expires_at
  );

CREATE OR REPLACE FUNCTION require_schema5_job_executor_release_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  plan_schema integer;
  effective_plan_id uuid;
BEGIN
  effective_plan_id := NEW.query_plan_revision_id;
  IF effective_plan_id IS NULL AND NEW.kind='publication' THEN
    SELECT active.query_plan_revision_id
    INTO effective_plan_id
    FROM run_active_query_plans active
    WHERE active.run_id=NEW.run_id;
  END IF;

  IF effective_plan_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE((plan_json->>'schemaVersion')::integer,1)
  INTO plan_schema
  FROM query_plan_revisions
  WHERE id=effective_plan_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'queued query plan is missing'
      USING ERRCODE='integrity_constraint_violation';
  END IF;

  IF plan_schema >= 5
     AND (
       NEW.required_executor_revision IS NULL
       OR NEW.required_executor_semantic_configuration_hash IS NULL
     ) THEN
    RAISE EXCEPTION
      'schema-5 canonical job lacks an executor release identity fence'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS job_executor_release_identity_require ON job_queue;
CREATE TRIGGER job_executor_release_identity_require
BEFORE INSERT OR UPDATE OF
  run_id,
  kind,
  query_plan_revision_id,
  required_executor_revision,
  required_executor_semantic_configuration_hash
ON job_queue
FOR EACH ROW EXECUTE FUNCTION require_schema5_job_executor_release_identity();

-- The database independently validates every lease acquisition and renewal.
-- This blocks an overlapping old worker even if its SQL does not know about
-- the new columns. The heartbeat is only the presented identity; authority
-- remains the immutable target persisted on the job.
CREATE OR REPLACE FUNCTION enforce_job_executor_release_identity_lease()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  identity_matches boolean;
  plan_schema integer;
  effective_plan_id uuid;
BEGIN
  IF NEW.status <> 'leased' THEN
    RETURN NEW;
  END IF;

  IF NEW.required_executor_revision IS NULL
     AND NEW.required_executor_semantic_configuration_hash IS NULL THEN
    effective_plan_id := NEW.query_plan_revision_id;
    IF effective_plan_id IS NULL AND NEW.kind='publication' THEN
      SELECT active.query_plan_revision_id
      INTO effective_plan_id
      FROM run_active_query_plans active
      WHERE active.run_id=NEW.run_id;
    END IF;
    IF effective_plan_id IS NOT NULL THEN
      SELECT COALESCE((plan_json->>'schemaVersion')::integer,1)
      INTO plan_schema
      FROM query_plan_revisions
      WHERE id=effective_plan_id;
    END IF;
    IF COALESCE(plan_schema,1) >= 5 THEN
      RAISE EXCEPTION
        'schema-5 canonical job lacks an executor release identity fence'
        USING ERRCODE='integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT EXISTS(
    SELECT 1
    FROM worker_heartbeats heartbeat
    WHERE heartbeat.worker_id=NEW.lease_owner
      AND heartbeat.last_seen_at>now()-interval '5 minutes'
      AND heartbeat.metadata_json->>'version'
        =NEW.required_executor_revision
      AND heartbeat.metadata_json->>'semanticExecutionConfigurationHash'
        =NEW.required_executor_semantic_configuration_hash
  )
  INTO identity_matches;

  IF NOT identity_matches THEN
    RAISE EXCEPTION
      'worker does not match the queued executor release identity'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS job_executor_release_identity_lease
  ON job_queue;
CREATE TRIGGER job_executor_release_identity_lease
BEFORE INSERT OR UPDATE OF
  status,
  lease_owner,
  lease_epoch,
  lease_expires_at
ON job_queue
FOR EACH ROW EXECUTE FUNCTION enforce_job_executor_release_identity_lease();

ALTER TABLE playlist_execution_attempts
  ADD COLUMN IF NOT EXISTS
    semantic_execution_configuration_hash varchar(64);

DO $$ BEGIN
  ALTER TABLE playlist_execution_attempts
    ADD CONSTRAINT playlist_execution_attempt_semantic_identity_valid
    CHECK (
      semantic_execution_configuration_hash IS NULL
      OR semantic_execution_configuration_hash ~ '^[0-9a-f]{64}$'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION enforce_attempt_executor_release_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  required_revision varchar(160);
  required_semantic_hash varchar(64);
BEGIN
  IF NEW.job_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT
    job.required_executor_revision,
    job.required_executor_semantic_configuration_hash
  INTO required_revision,required_semantic_hash
  FROM job_queue job
  WHERE job.id=NEW.job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'execution attempt job is missing'
      USING ERRCODE='integrity_constraint_violation';
  END IF;

  IF required_revision IS NOT NULL
     AND (
       NEW.executor_revision IS DISTINCT FROM required_revision
       OR NEW.semantic_execution_configuration_hash
         IS DISTINCT FROM required_semantic_hash
     ) THEN
    RAISE EXCEPTION
      'execution attempt does not match the queued executor release identity'
      USING ERRCODE='integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS playlist_attempt_executor_release_identity
  ON playlist_execution_attempts;
CREATE TRIGGER playlist_attempt_executor_release_identity
BEFORE INSERT OR UPDATE OF
  job_id,
  executor_revision,
  semantic_execution_configuration_hash
ON playlist_execution_attempts
FOR EACH ROW EXECUTE FUNCTION enforce_attempt_executor_release_identity();

INSERT INTO settings(key,value)
VALUES('canonical_executor_release_identity_fencing_version','1')
ON CONFLICT(key) DO UPDATE
SET value=excluded.value,updated_at=now();

COMMIT;
