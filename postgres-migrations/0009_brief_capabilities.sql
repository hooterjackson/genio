CREATE TABLE IF NOT EXISTS capability_session_briefs (
  session_id uuid NOT NULL REFERENCES capability_sessions(id) ON DELETE CASCADE,
  brief_request_id uuid NOT NULL REFERENCES brief_requests(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capability_session_briefs_pkey PRIMARY KEY(session_id,brief_request_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS capability_session_brief_request_idx
  ON capability_session_briefs(brief_request_id);
--> statement-breakpoint
INSERT INTO settings(key,value) VALUES('schema_version','10')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
