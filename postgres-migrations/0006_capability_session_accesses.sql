CREATE TABLE IF NOT EXISTS capability_session_accesses (
  session_id uuid NOT NULL REFERENCES capability_sessions(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  access_id uuid NOT NULL REFERENCES run_accesses(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capability_session_accesses_pkey PRIMARY KEY(session_id,access_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS capability_session_access_created_idx
  ON capability_session_accesses(session_id,created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS capability_session_access_access_idx
  ON capability_session_accesses(access_id);
--> statement-breakpoint
INSERT INTO capability_session_accesses(session_id,run_id,access_id,created_at)
SELECT id,run_id,access_id,created_at
FROM capability_sessions
WHERE run_id IS NOT NULL AND access_id IS NOT NULL
ON CONFLICT(session_id,access_id) DO NOTHING;
--> statement-breakpoint
ALTER TABLE capability_sessions
  DROP CONSTRAINT IF EXISTS capability_sessions_run_fk;
--> statement-breakpoint
ALTER TABLE capability_sessions
  ADD CONSTRAINT capability_sessions_run_fk
  FOREIGN KEY(run_id) REFERENCES research_runs(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE capability_sessions
  DROP CONSTRAINT IF EXISTS capability_sessions_access_fk;
--> statement-breakpoint
ALTER TABLE capability_sessions
  ADD CONSTRAINT capability_sessions_access_fk
  FOREIGN KEY(access_id) REFERENCES run_accesses(id) ON DELETE SET NULL;
--> statement-breakpoint
INSERT INTO settings(key,value) VALUES('schema_version','7')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
