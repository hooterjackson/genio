BEGIN;

ALTER TABLE manifests
  ADD COLUMN IF NOT EXISTS contract_revision_id uuid
    REFERENCES playlist_contract_revisions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS contract_hash varchar(64)
    CHECK (contract_hash IS NULL OR contract_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS partial_consent_answer_hash varchar(64)
    CHECK (
      partial_consent_answer_hash IS NULL
      OR partial_consent_answer_hash ~ '^[0-9a-f]{64}$'
    );
DO $$ BEGIN
  ALTER TABLE manifests ADD CONSTRAINT manifest_contract_binding_complete
    CHECK (
      (contract_revision_id IS NULL AND contract_hash IS NULL)
      OR (contract_revision_id IS NOT NULL AND contract_hash IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS playlist_discovery_leads (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  contract_revision_id uuid NOT NULL
    REFERENCES playlist_contract_revisions(id) ON DELETE CASCADE,
  execution_attempt_id uuid
    REFERENCES playlist_execution_attempts(id) ON DELETE SET NULL,
  provider varchar(80) NOT NULL,
  dependency_key varchar(120) NOT NULL,
  strategy_id varchar(120) NOT NULL,
  identity_hint_hash varchar(64) NOT NULL CHECK (identity_hint_hash ~ '^[0-9a-f]{64}$'),
  lead_json jsonb NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'discovered'
    CHECK (status IN ('discovered','qualifying','qualified','rejected','revoked')),
  evidence_eligible boolean NOT NULL DEFAULT false
    CHECK (evidence_eligible=false),
  discovered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,contract_revision_id,provider,strategy_id,identity_hint_hash)
);
CREATE INDEX IF NOT EXISTS playlist_discovery_lead_attempt_idx
  ON playlist_discovery_leads(execution_attempt_id,status);
CREATE INDEX IF NOT EXISTS playlist_discovery_lead_dependency_idx
  ON playlist_discovery_leads(run_id,dependency_key,status);

CREATE TABLE IF NOT EXISTS playlist_qualification_records (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  contract_revision_id uuid NOT NULL
    REFERENCES playlist_contract_revisions(id) ON DELETE CASCADE,
  discovery_lead_id uuid REFERENCES playlist_discovery_leads(id) ON DELETE SET NULL,
  candidate_id uuid REFERENCES track_candidates(id) ON DELETE CASCADE,
  stable_identity_hash varchar(64) NOT NULL CHECK (stable_identity_hash ~ '^[0-9a-f]{64}$'),
  storefront varchar(16) NOT NULL,
  predicate_results_json jsonb NOT NULL,
  evidence_record_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  quality_result_json jsonb NOT NULL,
  catalog_result_json jsonb NOT NULL,
  decision varchar(32) NOT NULL
    CHECK (decision IN ('qualified','failed','unknown','revoked')),
  qualification_hash varchar(64) NOT NULL CHECK (qualification_hash ~ '^[0-9a-f]{64}$'),
  qualified_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE(run_id,contract_revision_id,stable_identity_hash,qualification_hash)
);
CREATE INDEX IF NOT EXISTS playlist_qualification_contract_idx
  ON playlist_qualification_records(run_id,contract_revision_id,decision,qualified_at);
CREATE INDEX IF NOT EXISTS playlist_qualification_candidate_idx
  ON playlist_qualification_records(candidate_id,decision);

CREATE TABLE IF NOT EXISTS playlist_publication_reconciliations (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  contract_revision_id uuid NOT NULL
    REFERENCES playlist_contract_revisions(id) ON DELETE RESTRICT,
  execution_attempt_id uuid NOT NULL
    REFERENCES playlist_execution_attempts(id) ON DELETE RESTRICT,
  manifest_id uuid NOT NULL REFERENCES manifests(id) ON DELETE RESTRICT,
  manifest_revision_id uuid REFERENCES manifest_revisions(id) ON DELETE RESTRICT,
  apple_playlist_id varchar(160),
  state varchar(40) NOT NULL CHECK (
    state IN (
      'preflight','create_pending','append_pending','reconciling','complete',
      'authorization_blocked','cancelled','quarantined'
    )
  ),
  expected_ordered_ids_hash varchar(64) NOT NULL
    CHECK (expected_ordered_ids_hash ~ '^[0-9a-f]{64}$'),
  observed_ordered_ids_hash varchar(64)
    CHECK (observed_ordered_ids_hash IS NULL OR observed_ordered_ids_hash ~ '^[0-9a-f]{64}$'),
  appended_count integer NOT NULL DEFAULT 0 CHECK (appended_count >= 0),
  expected_count integer NOT NULL CHECK (expected_count > 0),
  batch_cursor integer NOT NULL DEFAULT 0 CHECK (batch_cursor >= 0),
  idempotency_key varchar(160) NOT NULL UNIQUE,
  next_retry_at timestamptz,
  blocker_id uuid REFERENCES playlist_run_blockers(id) ON DELETE SET NULL,
  reconciliation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (appended_count <= expected_count)
);
CREATE INDEX IF NOT EXISTS playlist_publication_reconcile_run_idx
  ON playlist_publication_reconciliations(run_id,state,next_retry_at);
CREATE UNIQUE INDEX IF NOT EXISTS playlist_publication_reconcile_manifest_active_idx
  ON playlist_publication_reconciliations(manifest_id)
  WHERE state NOT IN ('complete','cancelled','quarantined');

CREATE TABLE IF NOT EXISTS pipeline_cohort_kill_switches (
  cohort_key varchar(160) PRIMARY KEY,
  route varchar(48) NOT NULL,
  intent_group varchar(80),
  disabled boolean NOT NULL DEFAULT false,
  reason_code varchar(120),
  changed_by varchar(80) NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (disabled=false AND reason_code IS NULL)
    OR (disabled=true AND reason_code IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS pipeline_cohort_kill_switch_route_idx
  ON pipeline_cohort_kill_switches(route,disabled,intent_group);
-- A route/intent tuple is the rollback authority. Cohort keys are audit
-- labels and must not allow an older disabled row to survive a later enable.
DELETE FROM pipeline_cohort_kill_switches older
USING pipeline_cohort_kill_switches newer
WHERE older.route=newer.route
  AND older.intent_group IS NOT DISTINCT FROM newer.intent_group
  AND (older.changed_at,older.cohort_key)<(newer.changed_at,newer.cohort_key);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_cohort_kill_switch_authority_idx
  ON pipeline_cohort_kill_switches(route,intent_group) NULLS NOT DISTINCT;

CREATE TABLE IF NOT EXISTS release_canary_markers (
  id uuid PRIMARY KEY,
  canary_id varchar(64) NOT NULL,
  environment varchar(16) NOT NULL,
  operation varchar(16) NOT NULL,
  source_revision varchar(64) NOT NULL,
  cache_mode varchar(16) NOT NULL,
  brief_request_id uuid REFERENCES brief_requests(id) ON DELETE CASCADE,
  run_id uuid REFERENCES research_runs(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (environment IN ('staging','production')),
  CHECK (operation IN ('brief','run')),
  CHECK (cache_mode IN ('cold','warm','mixed')),
  CHECK (source_revision ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  CHECK (
    (operation='brief' AND brief_request_id IS NOT NULL AND run_id IS NULL)
    OR (operation='run' AND run_id IS NOT NULL AND brief_request_id IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS release_canary_marker_scope_idx
  ON release_canary_markers(canary_id,environment,operation,source_revision);
CREATE UNIQUE INDEX IF NOT EXISTS release_canary_marker_brief_idx
  ON release_canary_markers(brief_request_id)
  WHERE brief_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS release_canary_marker_run_idx
  ON release_canary_markers(run_id)
  WHERE run_id IS NOT NULL;

INSERT INTO settings(key,value,updated_at)
VALUES('schema_version','18',now())
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;

COMMIT;
