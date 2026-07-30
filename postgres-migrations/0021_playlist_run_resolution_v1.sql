BEGIN;

CREATE TABLE IF NOT EXISTS playlist_run_resolutions (
  run_id uuid PRIMARY KEY REFERENCES research_runs(id) ON DELETE CASCADE,
  generation integer NOT NULL DEFAULT 1,
  state varchar(40) NOT NULL,
  next_action varchar(80) NOT NULL,
  active_contract_revision_id uuid
    REFERENCES playlist_contract_revisions(id) ON DELETE RESTRICT,
  execution_attempt_id uuid
    REFERENCES playlist_execution_attempts(id) ON DELETE SET NULL,
  blocker_id uuid REFERENCES playlist_run_blockers(id) ON DELETE SET NULL,
  question_set_id uuid REFERENCES guidance_question_sets(id) ON DELETE SET NULL,
  decision_json jsonb,
  manifest_id uuid REFERENCES manifests(id) ON DELETE SET NULL,
  state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance varchar(40) NOT NULL,
  incident_reference varchar(160),
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT playlist_run_resolution_generation_valid CHECK (generation > 0),
  CONSTRAINT playlist_run_resolution_state_valid CHECK (
    state IN (
      'accepted','needs_input','probing','executing','blocked_dependency',
      'needs_decision','ready','publishing','completed','cancelled',
      'quarantined'
    )
  ),
  CONSTRAINT playlist_run_resolution_state_action_valid CHECK (
    (state IN ('accepted','probing','executing','ready','publishing',
      'completed','cancelled') AND next_action='none')
    OR (state='needs_input' AND next_action IN (
      'answer_initial_guidance','answer_rescue_guidance'
    ))
    OR (state='blocked_dependency' AND next_action IN (
      'wait_for_dependency','authorize_apple'
    ))
    OR (state='needs_decision' AND next_action IN (
      'resume_research','decide_verified_partial','review_contract'
    ))
    OR (state='quarantined' AND next_action='contact_support')
  ),
  CONSTRAINT playlist_run_resolution_provenance_valid CHECK (
    provenance IN (
      'legacy_backfill','protocol11_shadow','resolution_service',
      'reconciler','owner_repair'
    )
  ),
  CONSTRAINT playlist_run_resolution_terminal_time_valid CHECK (
    (state='completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL)
    OR (state='cancelled' AND cancelled_at IS NOT NULL AND completed_at IS NULL)
    OR (state NOT IN ('completed','cancelled')
      AND completed_at IS NULL AND cancelled_at IS NULL)
  ),
  CONSTRAINT playlist_run_resolution_blocker_valid CHECK (
    state NOT IN ('blocked_dependency','needs_input')
    OR blocker_id IS NOT NULL
  ),
  CONSTRAINT playlist_run_resolution_decision_valid CHECK (
    state <> 'needs_decision'
    OR decision_json IS NOT NULL
  ),
  CONSTRAINT playlist_run_resolution_manifest_valid CHECK (
    state NOT IN ('ready','publishing','completed')
    OR manifest_id IS NOT NULL
    OR provenance='legacy_backfill'
  ),
  CONSTRAINT playlist_run_resolution_incident_valid CHECK (
    state <> 'quarantined'
    OR incident_reference IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS playlist_run_resolution_state_idx
  ON playlist_run_resolutions(state,updated_at);
CREATE INDEX IF NOT EXISTS playlist_run_resolution_blocker_idx
  ON playlist_run_resolutions(blocker_id)
  WHERE blocker_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS playlist_run_resolution_attempt_idx
  ON playlist_run_resolutions(execution_attempt_id)
  WHERE execution_attempt_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS playlist_run_resolution_transitions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  expected_generation integer NOT NULL,
  successor_generation integer NOT NULL,
  from_state varchar(40),
  to_state varchar(40) NOT NULL,
  contract_revision_id uuid
    REFERENCES playlist_contract_revisions(id) ON DELETE RESTRICT,
  execution_attempt_id uuid
    REFERENCES playlist_execution_attempts(id) ON DELETE SET NULL,
  blocker_id uuid REFERENCES playlist_run_blockers(id) ON DELETE SET NULL,
  companion_artifact_kind varchar(48),
  companion_artifact_id uuid,
  transition_kind varchar(64) NOT NULL,
  transition_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key varchar(160) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT playlist_run_resolution_transition_generation_valid CHECK (
    expected_generation >= 0
    AND successor_generation=expected_generation+1
  )
);

CREATE INDEX IF NOT EXISTS playlist_run_resolution_transition_run_idx
  ON playlist_run_resolution_transitions(run_id,successor_generation);

CREATE TABLE IF NOT EXISTS playlist_resolution_outbox (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  transition_id uuid NOT NULL
    REFERENCES playlist_run_resolution_transitions(id) ON DELETE CASCADE,
  topic varchar(80) NOT NULL,
  idempotency_key varchar(160) NOT NULL UNIQUE,
  payload_json jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner varchar(160),
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error_class varchar(80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT playlist_resolution_outbox_attempt_valid CHECK (attempt_count >= 0),
  CONSTRAINT playlist_resolution_outbox_lease_valid CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS playlist_resolution_outbox_due_idx
  ON playlist_resolution_outbox(available_at,created_at)
  WHERE delivered_at IS NULL;

CREATE OR REPLACE FUNCTION prevent_resolution_transition_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Retention and explicit run deletion remove the parent research_run. Its
  -- FK cascade may erase private lineage after the retention boundary; direct
  -- mutation of the append-only transition ledger remains forbidden.
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'playlist resolution transitions are append-only'
    USING ERRCODE='integrity_constraint_violation';
END $$;

DROP TRIGGER IF EXISTS playlist_resolution_transition_append_only
  ON playlist_run_resolution_transitions;
CREATE TRIGGER playlist_resolution_transition_append_only
BEFORE UPDATE OR DELETE ON playlist_run_resolution_transitions
FOR EACH ROW EXECUTE FUNCTION prevent_resolution_transition_mutation();

-- Backfill is deterministic and deliberately conservative. Legacy terminal
-- failures become decisions or quarantine; they never become false success.
WITH latest_manifest AS (
  SELECT DISTINCT ON (run_id) id,run_id
  FROM manifests
  ORDER BY run_id,created_at DESC,id DESC
),
latest_attempt AS (
  SELECT DISTINCT ON (run_id) id,run_id,status
  FROM playlist_execution_attempts
  ORDER BY run_id,created_at DESC,id DESC
),
latest_blocker AS (
  SELECT DISTINCT ON (run_id) id,run_id,blocker_kind,state_json
  FROM playlist_run_blockers
  WHERE resolved_at IS NULL
  ORDER BY run_id,created_at DESC,id DESC
),
mapped AS (
  SELECT
    run.id run_id,
    run.active_playlist_contract_revision_id contract_revision_id,
    attempt.id execution_attempt_id,
    blocker.id blocker_id,
    manifest.id manifest_id,
    CASE
      WHEN run.status='complete'
        AND manifest.id IS NOT NULL
        AND counts.requested_track_count IS NOT NULL
        AND counts.published_track_count=counts.requested_track_count
        THEN 'completed'
      WHEN run.status IN ('complete','partial') THEN 'needs_decision'
      WHEN run.status='cancelled' THEN 'cancelled'
      WHEN blocker.blocker_kind IN ('provider','apple_authorization')
        THEN 'blocked_dependency'
      WHEN blocker.blocker_kind='guidance' THEN 'needs_input'
      WHEN run.status IN (
        'needs_decision','awaiting_budget','partial_ready',
        'no_compatible_tracks'
      ) THEN 'needs_decision'
      WHEN run.status IN (
        'queued','researching','continuing_research','ready_for_matching',
        'matching','resolving_catalog'
      ) AND attempt.id IS NOT NULL THEN 'executing'
      WHEN run.status IN ('manifest_ready','ready') THEN 'ready'
      WHEN run.status='publishing' THEN 'publishing'
      WHEN run.status IN ('failed_system','failed_integrity')
        THEN 'quarantined'
      ELSE 'accepted'
    END state,
    CASE
      WHEN run.status='complete'
        AND manifest.id IS NOT NULL
        AND counts.requested_track_count IS NOT NULL
        AND counts.published_track_count=counts.requested_track_count
        THEN 'none'
      WHEN run.status IN ('complete','partial') THEN 'review_contract'
      WHEN run.status='cancelled' THEN 'none'
      WHEN blocker.blocker_kind='apple_authorization' THEN 'authorize_apple'
      WHEN blocker.blocker_kind='provider' THEN 'wait_for_dependency'
      WHEN blocker.blocker_kind='guidance' THEN 'answer_initial_guidance'
      WHEN run.status IN (
        'needs_decision','awaiting_budget','partial_ready',
        'no_compatible_tracks'
      ) THEN 'review_contract'
      WHEN run.status IN ('manifest_ready','ready') THEN 'none'
      WHEN run.status='publishing' THEN 'none'
      WHEN run.status IN ('failed_system','failed_integrity')
        THEN 'contact_support'
      ELSE 'none'
    END next_action,
    run.status legacy_status,
    run.phase legacy_phase,
    counts.requested_track_count,
    counts.published_track_count,
    run.completed_at
  FROM research_runs run
  LEFT JOIN latest_manifest manifest ON manifest.run_id=run.id
  LEFT JOIN latest_attempt attempt ON attempt.run_id=run.id
  LEFT JOIN latest_blocker blocker ON blocker.run_id=run.id
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(
        NULLIF(run.selection_plan_json->>'requestedTrackCount','')::integer,
        NULLIF(run.brief_json #>> '{targetSize,max}','')::integer,
        NULLIF(run.brief_json #>> '{targetSize,min}','')::integer
      ) requested_track_count,
      CASE WHEN manifest.id IS NULL THEN 0 ELSE (
        SELECT count(*)::integer
        FROM manifest_tracks track
        WHERE track.manifest_id=manifest.id
      ) END published_track_count
  ) counts ON true
  WHERE run.deleted_at IS NULL
)
INSERT INTO playlist_run_resolutions(
  run_id,generation,state,next_action,active_contract_revision_id,
  execution_attempt_id,blocker_id,decision_json,manifest_id,state_json,
  provenance,incident_reference,completed_at,cancelled_at)
SELECT
  run_id,1,state,next_action,contract_revision_id,execution_attempt_id,
  blocker_id,
  CASE WHEN state='needs_decision' THEN jsonb_build_object(
    'kind','legacy_backfill_decision',
    'editableInterpretationSummary',true
  ) END,
  manifest_id,
  jsonb_build_object(
    'legacyStatus',legacy_status,
    'legacyPhase',legacy_phase,
    'requestedTrackCount',requested_track_count,
    'publishedTrackCount',published_track_count
  ),
  'legacy_backfill',
  CASE WHEN state='quarantined'
    THEN 'legacy-backfill:' || run_id::text END,
  CASE WHEN state='completed' THEN COALESCE(completed_at,now()) END,
  CASE WHEN state='cancelled' THEN COALESCE(completed_at,now()) END
FROM mapped
ON CONFLICT(run_id) DO NOTHING;

WITH normalized_legacy_completion AS (
  SELECT
    resolution.run_id,
    run.status,
    run.completed_at run_completed_at,
    COALESCE(
      NULLIF(run.selection_plan_json->>'requestedTrackCount','')::integer,
      NULLIF(run.brief_json #>> '{targetSize,max}','')::integer,
      NULLIF(run.brief_json #>> '{targetSize,min}','')::integer
    ) requested_track_count,
    CASE WHEN resolution.manifest_id IS NULL THEN 0 ELSE (
      SELECT count(*)::integer
      FROM manifest_tracks track
      WHERE track.manifest_id=resolution.manifest_id
    ) END published_track_count
  FROM playlist_run_resolutions resolution
  JOIN research_runs run ON run.id=resolution.run_id
  WHERE resolution.provenance='legacy_backfill'
    AND run.status IN ('complete','partial')
)
UPDATE playlist_run_resolutions resolution
SET state=CASE
      WHEN normalized.status='complete'
        AND resolution.manifest_id IS NOT NULL
        AND normalized.requested_track_count IS NOT NULL
        AND normalized.published_track_count=normalized.requested_track_count
        THEN 'completed'
      WHEN normalized.status IN ('complete','partial') THEN 'needs_decision'
      ELSE resolution.state
    END,
    next_action=CASE
      WHEN normalized.status='complete'
        AND resolution.manifest_id IS NOT NULL
        AND normalized.requested_track_count IS NOT NULL
        AND normalized.published_track_count=normalized.requested_track_count
        THEN 'none'
      WHEN normalized.status IN ('complete','partial') THEN 'review_contract'
      ELSE resolution.next_action
    END,
    decision_json=CASE
      WHEN normalized.status IN ('complete','partial')
        AND NOT (
          normalized.status='complete'
          AND resolution.manifest_id IS NOT NULL
          AND normalized.requested_track_count IS NOT NULL
          AND normalized.published_track_count=normalized.requested_track_count
        )
        THEN jsonb_build_object(
          'kind','legacy_backfill_decision',
          'editableInterpretationSummary',true
        )
      ELSE resolution.decision_json
    END,
    state_json=resolution.state_json || jsonb_build_object(
      'requestedTrackCount',normalized.requested_track_count,
      'publishedTrackCount',normalized.published_track_count
    ),
    completed_at=CASE
      WHEN normalized.status='complete'
        AND resolution.manifest_id IS NOT NULL
        AND normalized.requested_track_count IS NOT NULL
        AND normalized.published_track_count=normalized.requested_track_count
        THEN COALESCE(
          resolution.completed_at,
          normalized.run_completed_at,
          now()
        )
      ELSE NULL
    END,
    updated_at=now()
FROM normalized_legacy_completion normalized
WHERE resolution.run_id=normalized.run_id;

-- Normalize rows created by the earliest schema-19 draft before installing the
-- state/action constraint on an already-expanded database.
UPDATE playlist_run_resolutions
SET next_action=CASE
  WHEN state IN (
    'accepted','probing','executing','ready','publishing','completed','cancelled'
  ) THEN 'none'
  WHEN state='needs_input' AND next_action='answer_rescue_guidance'
    THEN 'answer_rescue_guidance'
  WHEN state='needs_input' THEN 'answer_initial_guidance'
  WHEN state='blocked_dependency' AND next_action='authorize_apple'
    THEN 'authorize_apple'
  WHEN state='blocked_dependency' THEN 'wait_for_dependency'
  WHEN state='needs_decision' AND next_action IN (
    'resume_research','decide_verified_partial','review_contract'
  ) THEN next_action
  WHEN state='needs_decision' THEN 'review_contract'
  WHEN state='quarantined' THEN 'contact_support'
  ELSE 'none'
END,
updated_at=now()
WHERE next_action NOT IN (
  'none','answer_initial_guidance','answer_rescue_guidance',
  'wait_for_dependency','resume_research','authorize_apple',
  'decide_verified_partial','review_contract','contact_support'
)
OR NOT (
  (state IN ('accepted','probing','executing','ready','publishing',
    'completed','cancelled') AND next_action='none')
  OR (state='needs_input' AND next_action IN (
    'answer_initial_guidance','answer_rescue_guidance'
  ))
  OR (state='blocked_dependency' AND next_action IN (
    'wait_for_dependency','authorize_apple'
  ))
  OR (state='needs_decision' AND next_action IN (
    'resume_research','decide_verified_partial','review_contract'
  ))
  OR (state='quarantined' AND next_action='contact_support')
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid='playlist_run_resolutions'::regclass
      AND conname='playlist_run_resolution_state_action_valid'
  ) THEN
    ALTER TABLE playlist_run_resolutions
      ADD CONSTRAINT playlist_run_resolution_state_action_valid CHECK (
        (state IN ('accepted','probing','executing','ready','publishing',
          'completed','cancelled') AND next_action='none')
        OR (state='needs_input' AND next_action IN (
          'answer_initial_guidance','answer_rescue_guidance'
        ))
        OR (state='blocked_dependency' AND next_action IN (
          'wait_for_dependency','authorize_apple'
        ))
        OR (state='needs_decision' AND next_action IN (
          'resume_research','decide_verified_partial','review_contract'
        ))
        OR (state='quarantined' AND next_action='contact_support')
      );
  END IF;
END $$;

INSERT INTO playlist_run_resolution_transitions(
  id,run_id,expected_generation,successor_generation,from_state,to_state,
  contract_revision_id,execution_attempt_id,blocker_id,transition_kind,
  transition_json,idempotency_key)
SELECT
  md5('resolution-transition:' || resolution.run_id::text)::uuid,
  resolution.run_id,0,1,NULL,resolution.state,
  resolution.active_contract_revision_id,resolution.execution_attempt_id,
  resolution.blocker_id,'legacy_backfill',
  jsonb_build_object('provenance','legacy_backfill'),
  'legacy-backfill:' || resolution.run_id::text
FROM playlist_run_resolutions resolution
WHERE resolution.provenance='legacy_backfill'
ON CONFLICT(idempotency_key) DO NOTHING;

INSERT INTO settings(key,value)
VALUES
  ('schema_version','19'),
  ('playlist_resolution_service_version','1'),
  ('playlist_resolution_authority_mode','legacy_shadow')
ON CONFLICT(key) DO UPDATE
SET value=excluded.value,updated_at=now();

COMMIT;
