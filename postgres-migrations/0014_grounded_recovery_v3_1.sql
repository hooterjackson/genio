BEGIN;

CREATE TABLE IF NOT EXISTS user_goals (
  run_id uuid PRIMARY KEY REFERENCES research_runs(id) ON DELETE CASCADE,
  goal_hash text NOT NULL CHECK (length(goal_hash)=64),
  goal_json jsonb NOT NULL,
  semantic_plan_version text NOT NULL DEFAULT 'semantic_plan_v3_1',
  policy_version text NOT NULL DEFAULT 'grounded_recovery_v3_1_policy_v1',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS semantic_plan_revisions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  parent_revision integer,
  equivalence text NOT NULL CHECK (equivalence IN ('initial','semantic_equivalent_repair','user_confirmed_change')),
  hard_constraint_hash text NOT NULL CHECK (length(hard_constraint_hash)=64),
  plan_json jsonb NOT NULL,
  audit_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, revision)
);

CREATE TABLE IF NOT EXISTS pipeline_candidate_leads (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  query_plan_revision_id uuid,
  semantic_revision integer NOT NULL DEFAULT 1,
  strategy_id text NOT NULL,
  candidate_key text NOT NULL,
  artist text NOT NULL,
  title text NOT NULL,
  album text,
  source_record_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  citation_hashes jsonb NOT NULL DEFAULT '[]'::jsonb,
  predicate_coverage jsonb NOT NULL DEFAULT '[]'::jsonb,
  rejection_code text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, semantic_revision, strategy_id, candidate_key)
);
CREATE INDEX IF NOT EXISTS pipeline_candidate_leads_expiry_idx ON pipeline_candidate_leads(expires_at);

CREATE TABLE IF NOT EXISTS pipeline_recovery_audits (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  query_plan_revision_id uuid,
  generation integer NOT NULL CHECK (generation BETWEEN 1 AND 3),
  root_cause text NOT NULL CHECK (root_cause IN ('under_discovery','evidence_shortfall','catalog_shortfall','provider_degraded','semantic_contract')),
  action text NOT NULL,
  status text NOT NULL CHECK (status IN ('started','complete','no_yield','blocked','failed')),
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  envelope jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipeline_recovery_audits_run_idx ON pipeline_recovery_audits(run_id, generation);

CREATE OR REPLACE FUNCTION prevent_grounded_recovery_immutable_update() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is immutable', TG_TABLE_NAME; END $$;

DROP TRIGGER IF EXISTS user_goals_immutable ON user_goals;
CREATE TRIGGER user_goals_immutable BEFORE UPDATE ON user_goals
FOR EACH ROW EXECUTE FUNCTION prevent_grounded_recovery_immutable_update();
DROP TRIGGER IF EXISTS semantic_plan_revisions_immutable ON semantic_plan_revisions;
CREATE TRIGGER semantic_plan_revisions_immutable BEFORE UPDATE ON semantic_plan_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_grounded_recovery_immutable_update();

INSERT INTO settings(key, value, updated_at)
VALUES('schema_version','15',now())
ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;

COMMIT;
