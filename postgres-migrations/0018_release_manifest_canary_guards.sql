BEGIN;

-- Public rollout assignment is decided before brief compilation and remains
-- immutable for that brief. This prevents a downstream model interpretation
-- or a later cohort percentage from moving an accepted caller between the
-- canonical V3 route and its proven control route.
ALTER TABLE brief_requests
  ADD COLUMN IF NOT EXISTS public_rollout_assignment_json jsonb;
DO $$ BEGIN
  ALTER TABLE brief_requests
    ADD CONSTRAINT brief_requests_public_rollout_assignment_shape
    CHECK (
      public_rollout_assignment_json IS NULL
      OR (
        jsonb_typeof(public_rollout_assignment_json)='object'
        AND public_rollout_assignment_json ?& ARRAY[
          'version','rolloutEvidenceHash','rolloutStage','intentGroup',
          'cohort','percentage','assigned','assignmentHash'
        ]
        AND (
          public_rollout_assignment_json - ARRAY[
            'version','rolloutEvidenceHash','rolloutStage','intentGroup',
            'cohort','percentage','assigned','assignmentHash'
          ]::text[]
        )='{}'::jsonb
        AND public_rollout_assignment_json->>'version'
          ='signed_public_contract_rollout_v1'
        AND public_rollout_assignment_json->>'rolloutEvidenceHash'
          ~ '^[0-9a-f]{64}$'
        AND public_rollout_assignment_json->>'assignmentHash'
          ~ '^[0-9a-f]{64}$'
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION reject_public_rollout_assignment_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.public_rollout_assignment_json
    IS DISTINCT FROM NEW.public_rollout_assignment_json
  THEN
    RAISE EXCEPTION 'public_rollout_assignment_immutable'
      USING ERRCODE='23000';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS reject_public_rollout_assignment_change_trigger
  ON brief_requests;
CREATE TRIGGER reject_public_rollout_assignment_change_trigger
BEFORE UPDATE OF public_rollout_assignment_json ON brief_requests
FOR EACH ROW EXECUTE FUNCTION reject_public_rollout_assignment_change();

-- RC1 froze schema-18 migration 0017 before canary audience binding and
-- truthful cache semantics were added. Keep that migration immutable and
-- upgrade both fresh and already-expanded databases here.
ALTER TABLE release_canary_markers
  ADD COLUMN IF NOT EXISTS audience varchar(512);
UPDATE release_canary_markers
SET audience='https://legacy-canary.invalid'
WHERE audience IS NULL;
ALTER TABLE release_canary_markers
  ALTER COLUMN audience SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE release_canary_markers
    ADD CONSTRAINT release_canary_markers_audience_valid
    CHECK (audience ~ '^https://[^/@?#[:space:]]+$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE release_canary_markers
  DROP CONSTRAINT IF EXISTS release_canary_markers_cache_mode_check;
UPDATE release_canary_markers
SET cache_mode='legacy_unknown'
WHERE cache_mode IN ('cold','warm','mixed');
DO $$ BEGIN
  ALTER TABLE release_canary_markers
    ADD CONSTRAINT release_canary_markers_cache_mode_check
    CHECK (cache_mode IN ('reuse_disabled','legacy_unknown'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Execution-attempt identity must fence the exact immutable query-plan
-- revision. Historical schema-17 attempts remain nullable while draining;
-- release evidence accepts only attempts carrying the active revision.
ALTER TABLE playlist_execution_attempts
  ADD COLUMN IF NOT EXISTS query_plan_revision_id uuid
    REFERENCES query_plan_revisions(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS playlist_execution_attempt_query_plan_idx
  ON playlist_execution_attempts(
    run_id,contract_revision_id,query_plan_revision_id,stage,status
  );

-- Manifest-only release canaries use the live discovery/matching providers,
-- but they must be structurally unable to cross the durable Apple publication
-- boundary. Application checks remain defense in depth; these triggers make a
-- direct or future write path fail in the database transaction itself.
--
-- This is intentionally an additive migration even though it does not advance
-- the public schema contract beyond 18. A release candidate may already have
-- applied 0017; changing that historical migration would leave such databases
-- without the guard.
CREATE OR REPLACE FUNCTION reject_manifest_canary_manifest_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM release_canary_markers marker
    JOIN research_checkpoints checkpoint
      ON checkpoint.run_id=marker.run_id
     AND checkpoint.phase='v3:release-canary:manifest-only'
    WHERE marker.run_id=NEW.run_id
      AND marker.operation='run'
  ) THEN
    RAISE EXCEPTION 'release_manifest_canary_write_forbidden'
      USING ERRCODE='23000';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS reject_manifest_canary_manifest_write_trigger
  ON manifests;
CREATE TRIGGER reject_manifest_canary_manifest_write_trigger
BEFORE INSERT OR UPDATE OF run_id ON manifests
FOR EACH ROW EXECUTE FUNCTION reject_manifest_canary_manifest_write();

CREATE OR REPLACE FUNCTION reject_manifest_canary_job_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.run_id IS NOT NULL
    AND NEW.kind IN ('matching','publication')
    AND EXISTS (
      SELECT 1
      FROM release_canary_markers marker
      JOIN research_checkpoints checkpoint
        ON checkpoint.run_id=marker.run_id
       AND checkpoint.phase='v3:release-canary:manifest-only'
      WHERE marker.run_id=NEW.run_id
        AND marker.operation='run'
    )
  THEN
    RAISE EXCEPTION 'release_manifest_canary_write_forbidden'
      USING ERRCODE='23000';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS reject_manifest_canary_job_write_trigger
  ON job_queue;
CREATE TRIGGER reject_manifest_canary_job_write_trigger
BEFORE INSERT OR UPDATE OF run_id,kind ON job_queue
FOR EACH ROW EXECUTE FUNCTION reject_manifest_canary_job_write();

CREATE OR REPLACE FUNCTION reject_manifest_canary_publication_volume_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM manifests manifest
    JOIN release_canary_markers marker ON marker.run_id=manifest.run_id
    JOIN research_checkpoints checkpoint
      ON checkpoint.run_id=marker.run_id
     AND checkpoint.phase='v3:release-canary:manifest-only'
    WHERE manifest.id=NEW.manifest_id
      AND marker.operation='run'
  ) THEN
    RAISE EXCEPTION 'release_manifest_canary_write_forbidden'
      USING ERRCODE='23000';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS reject_manifest_canary_publication_volume_write_trigger
  ON publication_volumes;
CREATE TRIGGER reject_manifest_canary_publication_volume_write_trigger
BEFORE INSERT OR UPDATE OF manifest_id ON publication_volumes
FOR EACH ROW EXECUTE FUNCTION reject_manifest_canary_publication_volume_write();

-- Schema 18 was introduced by 0017, so its numeric setting alone cannot prove
-- that an already-expanded database has received this additive hardening.
-- Activation and release evidence require this capability marker as well.
INSERT INTO settings(key,value,updated_at)
VALUES('release_manifest_canary_guards_version','1',now())
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;

COMMIT;
