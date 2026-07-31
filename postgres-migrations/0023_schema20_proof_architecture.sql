BEGIN;

CREATE TABLE IF NOT EXISTS canonical_track_identities (
  id uuid PRIMARY KEY,
  identity_policy_version varchar(160) NOT NULL,
  provider varchar(40) NOT NULL,
  storefront varchar(16) NOT NULL,
  recording_family_key text NOT NULL,
  recording_family_policy_version varchar(160) NOT NULL,
  apple_stable_id varchar(160) NOT NULL,
  identity_hash varchar(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT canonical_track_identity_provider_valid CHECK (
    provider='apple'
  ),
  CONSTRAINT canonical_track_identity_storefront_valid CHECK (
    storefront ~ '^[a-z]{2}$'
  ),
  CONSTRAINT canonical_track_identity_hash_valid CHECK (
    identity_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT canonical_track_identity_tuple_unique UNIQUE (
    identity_policy_version,
    provider,
    storefront,
    recording_family_key,
    recording_family_policy_version,
    apple_stable_id
  )
);

CREATE INDEX IF NOT EXISTS canonical_track_identity_family_idx
  ON canonical_track_identities(
    provider,storefront,recording_family_policy_version,apple_stable_id
  );

CREATE TABLE IF NOT EXISTS content_addressed_evidence_snapshots (
  id uuid PRIMARY KEY,
  content_hash varchar(64) NOT NULL UNIQUE,
  source_url_hash varchar(64) NOT NULL,
  source_host varchar(240) NOT NULL,
  excerpt_hash varchar(64),
  acquisition_policy_version varchar(160) NOT NULL,
  snapshot_json jsonb NOT NULL,
  acquired_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_snapshot_content_hash_valid CHECK (
    content_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT evidence_snapshot_url_hash_valid CHECK (
    source_url_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT evidence_snapshot_excerpt_hash_valid CHECK (
    excerpt_hash IS NULL OR excerpt_hash ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX IF NOT EXISTS evidence_snapshot_host_acquired_idx
  ON content_addressed_evidence_snapshots(source_host,acquired_at);

CREATE TABLE IF NOT EXISTS selection_qualification_observations (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  contract_revision_id uuid NOT NULL
    REFERENCES playlist_contract_revisions(id) ON DELETE RESTRICT,
  query_plan_revision_id uuid NOT NULL
    REFERENCES query_plan_revisions(id) ON DELETE RESTRICT,
  execution_attempt_id uuid NOT NULL
    REFERENCES playlist_execution_attempts(id) ON DELETE RESTRICT,
  candidate_id uuid NOT NULL
    REFERENCES track_candidates(id) ON DELETE RESTRICT,
  canonical_track_identity_id uuid NOT NULL
    REFERENCES canonical_track_identities(id) ON DELETE RESTRICT,
  source_qualification_record_id uuid
    REFERENCES playlist_qualification_records(id) ON DELETE SET NULL,
  observation_hash varchar(64) NOT NULL,
  observation_json jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT selection_qualification_observation_hash_valid CHECK (
    observation_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT selection_qualification_observation_unique UNIQUE (
    execution_attempt_id,candidate_id,observation_hash
  )
);

CREATE INDEX IF NOT EXISTS selection_qualification_observation_run_idx
  ON selection_qualification_observations(
    run_id,contract_revision_id,query_plan_revision_id,created_at
  );

CREATE TABLE IF NOT EXISTS immutable_selection_qualifications (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  contract_revision_id uuid NOT NULL
    REFERENCES playlist_contract_revisions(id) ON DELETE RESTRICT,
  query_plan_revision_id uuid NOT NULL
    REFERENCES query_plan_revisions(id) ON DELETE RESTRICT,
  execution_attempt_id uuid NOT NULL
    REFERENCES playlist_execution_attempts(id) ON DELETE RESTRICT,
  candidate_id uuid NOT NULL
    REFERENCES track_candidates(id) ON DELETE RESTRICT,
  canonical_track_identity_id uuid NOT NULL
    REFERENCES canonical_track_identities(id) ON DELETE RESTRICT,
  qualification_observation_id uuid NOT NULL
    REFERENCES selection_qualification_observations(id) ON DELETE RESTRICT,
  evidence_snapshot_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  contract_hash varchar(64) NOT NULL,
  query_plan_hash varchar(64) NOT NULL,
  evidence_policy_hash varchar(64) NOT NULL,
  catalog_policy_hash varchar(64) NOT NULL,
  qualification_hash varchar(64) NOT NULL UNIQUE,
  decision varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT immutable_selection_qualification_decision_valid CHECK (
    decision='qualified'
  ),
  CONSTRAINT immutable_selection_qualification_hashes_valid CHECK (
    contract_hash ~ '^[0-9a-f]{64}$'
    AND query_plan_hash ~ '^[0-9a-f]{64}$'
    AND evidence_policy_hash ~ '^[0-9a-f]{64}$'
    AND catalog_policy_hash ~ '^[0-9a-f]{64}$'
    AND qualification_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT immutable_selection_qualification_attempt_candidate_unique
    UNIQUE(execution_attempt_id,candidate_id,qualification_hash)
);

CREATE INDEX IF NOT EXISTS immutable_selection_qualification_run_idx
  ON immutable_selection_qualifications(
    run_id,contract_revision_id,query_plan_revision_id,created_at
  );

CREATE TABLE IF NOT EXISTS immutable_selection_sets (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  contract_revision_id uuid NOT NULL
    REFERENCES playlist_contract_revisions(id) ON DELETE RESTRICT,
  query_plan_revision_id uuid NOT NULL
    REFERENCES query_plan_revisions(id) ON DELETE RESTRICT,
  execution_attempt_id uuid NOT NULL
    REFERENCES playlist_execution_attempts(id) ON DELETE RESTRICT,
  proof_mode varchar(24) NOT NULL,
  requested_count integer NOT NULL,
  selected_count integer NOT NULL,
  reserve_count integer NOT NULL,
  selected_attestation_hash varchar(64) NOT NULL,
  reserve_attestation_hash varchar(64) NOT NULL,
  attestation_set_hash varchar(64) NOT NULL UNIQUE,
  output_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT immutable_selection_set_mode_valid CHECK (
    proof_mode IN ('shadow','native')
  ),
  CONSTRAINT immutable_selection_set_counts_valid CHECK (
    requested_count BETWEEN 1 AND 1000
    AND selected_count BETWEEN 0 AND requested_count
    AND reserve_count >= 0
  ),
  CONSTRAINT immutable_selection_set_hashes_valid CHECK (
    selected_attestation_hash ~ '^[0-9a-f]{64}$'
    AND reserve_attestation_hash ~ '^[0-9a-f]{64}$'
    AND attestation_set_hash ~ '^[0-9a-f]{64}$'
    AND output_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT immutable_selection_set_attempt_hash_unique UNIQUE (
    execution_attempt_id,attestation_set_hash
  )
);

CREATE INDEX IF NOT EXISTS immutable_selection_set_run_idx
  ON immutable_selection_sets(run_id,contract_revision_id,created_at);

CREATE TABLE IF NOT EXISTS immutable_selection_set_items (
  selection_set_id uuid NOT NULL
    REFERENCES immutable_selection_sets(id) ON DELETE CASCADE,
  role varchar(16) NOT NULL,
  position integer NOT NULL,
  selection_qualification_id uuid NOT NULL
    REFERENCES immutable_selection_qualifications(id) ON DELETE RESTRICT,
  canonical_track_identity_id uuid NOT NULL
    REFERENCES canonical_track_identities(id) ON DELETE RESTRICT,
  apple_stable_id varchar(160) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(selection_set_id,role,position),
  CONSTRAINT immutable_selection_set_item_role_valid CHECK (
    role IN ('selected','reserve')
  ),
  CONSTRAINT immutable_selection_set_item_position_valid CHECK (
    position >= 0
  ),
  CONSTRAINT immutable_selection_set_item_identity_unique UNIQUE (
    selection_set_id,canonical_track_identity_id
  ),
  CONSTRAINT immutable_selection_set_item_qualification_unique UNIQUE (
    selection_set_id,selection_qualification_id
  )
);

CREATE TABLE IF NOT EXISTS selection_attempt_output_attestations (
  execution_attempt_id uuid PRIMARY KEY
    REFERENCES playlist_execution_attempts(id) ON DELETE RESTRICT,
  selection_set_id uuid NOT NULL UNIQUE
    REFERENCES immutable_selection_sets(id) ON DELETE RESTRICT,
  output_hash varchar(64) NOT NULL,
  attestation_set_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT selection_attempt_output_hashes_valid CHECK (
    output_hash ~ '^[0-9a-f]{64}$'
    AND attestation_set_hash ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE IF NOT EXISTS immutable_qualification_revocations (
  id uuid PRIMARY KEY,
  selection_qualification_id uuid NOT NULL
    REFERENCES immutable_selection_qualifications(id) ON DELETE RESTRICT,
  reason_code varchar(160) NOT NULL,
  policy_version varchar(160) NOT NULL,
  revocation_hash varchar(64) NOT NULL UNIQUE,
  detail_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  revoked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT immutable_qualification_revocation_hash_valid CHECK (
    revocation_hash ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX IF NOT EXISTS immutable_qualification_revocation_qualification_idx
  ON immutable_qualification_revocations(
    selection_qualification_id,revoked_at
  );

CREATE TABLE IF NOT EXISTS legacy_published_receipts (
  manifest_revision_id uuid PRIMARY KEY
    REFERENCES manifest_revisions(id) ON DELETE CASCADE,
  receipt_hash varchar(64) NOT NULL UNIQUE,
  expected_ordered_ids_hash varchar(64),
  observed_ordered_ids_hash varchar(64),
  reconciled_count integer,
  receipt_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legacy_published_receipt_hashes_valid CHECK (
    receipt_hash ~ '^[0-9a-f]{64}$'
    AND (
      expected_ordered_ids_hash IS NULL
      OR expected_ordered_ids_hash ~ '^[0-9a-f]{64}$'
    )
    AND (
      observed_ordered_ids_hash IS NULL
      OR observed_ordered_ids_hash ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT legacy_published_receipt_count_valid CHECK (
    reconciled_count IS NULL OR reconciled_count >= 0
  )
);

ALTER TABLE manifest_revisions
  ADD COLUMN IF NOT EXISTS selection_set_id uuid
    REFERENCES immutable_selection_sets(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS attestation_set_hash varchar(64),
  ADD COLUMN IF NOT EXISTS proof_kind varchar(32);

ALTER TABLE partial_publication_decisions
  ADD COLUMN IF NOT EXISTS selection_set_id uuid
    REFERENCES immutable_selection_sets(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS manifest_payload_hash varchar(64),
  ADD COLUMN IF NOT EXISTS attestation_set_hash varchar(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='manifest_revisions'::regclass
      AND conname='manifest_revision_schema20_proof_valid'
  ) THEN
    ALTER TABLE manifest_revisions
      ADD CONSTRAINT manifest_revision_schema20_proof_valid CHECK (
        (
          selection_set_id IS NULL
          AND attestation_set_hash IS NULL
          AND proof_kind IS NULL
        ) OR (
          selection_set_id IS NOT NULL
          AND attestation_set_hash ~ '^[0-9a-f]{64}$'
          AND proof_kind IN ('shadow','native')
        )
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='partial_publication_decisions'::regclass
      AND conname='partial_publication_schema20_binding_valid'
  ) THEN
    ALTER TABLE partial_publication_decisions
      ADD CONSTRAINT partial_publication_schema20_binding_valid CHECK (
        (
          selection_set_id IS NULL
          AND manifest_payload_hash IS NULL
          AND attestation_set_hash IS NULL
        ) OR (
          selection_set_id IS NOT NULL
          AND manifest_payload_hash ~ '^[0-9a-f]{64}$'
          AND attestation_set_hash ~ '^[0-9a-f]{64}$'
        )
      );
  END IF;
END $$;

-- The legacy content-only unique index remains authoritative during shadow
-- construction. Native activation replaces it only after every schema-19
-- worker has been fenced and the explicit authority-switch preflight passes.
CREATE INDEX IF NOT EXISTS manifest_revision_content_attestation_shadow_idx
  ON manifest_revisions(
    manifest_id,content_hash,COALESCE(attestation_set_hash,'legacy')
  );

CREATE OR REPLACE FUNCTION prevent_schema20_proof_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'schema-20 proof records are immutable'
    USING ERRCODE='integrity_constraint_violation';
END $$;

DROP TRIGGER IF EXISTS canonical_track_identity_immutable
  ON canonical_track_identities;
CREATE TRIGGER canonical_track_identity_immutable
BEFORE UPDATE OR DELETE ON canonical_track_identities
FOR EACH ROW EXECUTE FUNCTION prevent_schema20_proof_mutation();

DROP TRIGGER IF EXISTS evidence_snapshot_immutable
  ON content_addressed_evidence_snapshots;
CREATE TRIGGER evidence_snapshot_immutable
BEFORE UPDATE OR DELETE ON content_addressed_evidence_snapshots
FOR EACH ROW EXECUTE FUNCTION prevent_schema20_proof_mutation();

DROP TRIGGER IF EXISTS selection_qualification_observation_immutable
  ON selection_qualification_observations;
CREATE TRIGGER selection_qualification_observation_immutable
BEFORE UPDATE OR DELETE ON selection_qualification_observations
FOR EACH ROW EXECUTE FUNCTION prevent_schema20_proof_mutation();

DROP TRIGGER IF EXISTS immutable_selection_qualification_immutable
  ON immutable_selection_qualifications;
CREATE TRIGGER immutable_selection_qualification_immutable
BEFORE UPDATE OR DELETE ON immutable_selection_qualifications
FOR EACH ROW EXECUTE FUNCTION prevent_schema20_proof_mutation();

DROP TRIGGER IF EXISTS immutable_selection_set_immutable
  ON immutable_selection_sets;
CREATE TRIGGER immutable_selection_set_immutable
BEFORE UPDATE OR DELETE ON immutable_selection_sets
FOR EACH ROW EXECUTE FUNCTION prevent_schema20_proof_mutation();

DROP TRIGGER IF EXISTS immutable_selection_set_item_immutable
  ON immutable_selection_set_items;
CREATE TRIGGER immutable_selection_set_item_immutable
BEFORE UPDATE OR DELETE ON immutable_selection_set_items
FOR EACH ROW EXECUTE FUNCTION prevent_schema20_proof_mutation();

DROP TRIGGER IF EXISTS selection_attempt_output_attestation_immutable
  ON selection_attempt_output_attestations;
CREATE TRIGGER selection_attempt_output_attestation_immutable
BEFORE UPDATE OR DELETE ON selection_attempt_output_attestations
FOR EACH ROW EXECUTE FUNCTION prevent_schema20_proof_mutation();

DROP TRIGGER IF EXISTS immutable_qualification_revocation_immutable
  ON immutable_qualification_revocations;
CREATE TRIGGER immutable_qualification_revocation_immutable
BEFORE UPDATE OR DELETE ON immutable_qualification_revocations
FOR EACH ROW EXECUTE FUNCTION prevent_schema20_proof_mutation();

INSERT INTO settings(key,value)
VALUES
  ('schema_version','20'),
  ('proof_architecture_version','1'),
  ('proof_architecture_authority','shadow')
ON CONFLICT(key) DO UPDATE
SET value=excluded.value,updated_at=now();

COMMIT;
