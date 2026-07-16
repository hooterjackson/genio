ALTER TABLE brief_requests
  ADD COLUMN IF NOT EXISTS questions_json jsonb;
--> statement-breakpoint
ALTER TABLE brief_requests
  ADD COLUMN IF NOT EXISTS answers_json jsonb;
--> statement-breakpoint
ALTER TABLE brief_requests
  ADD COLUMN IF NOT EXISTS answers_idempotency_key varchar(160);
--> statement-breakpoint
ALTER TABLE brief_requests
  ADD COLUMN IF NOT EXISTS answers_hash varchar(64);
--> statement-breakpoint
ALTER TABLE run_accesses
  ADD COLUMN IF NOT EXISTS brief_request_id uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE run_accesses ADD CONSTRAINT run_accesses_brief_request_fk
    FOREIGN KEY (brief_request_id) REFERENCES brief_requests(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS run_access_brief_request_idx ON run_accesses(brief_request_id);
--> statement-breakpoint
INSERT INTO settings(key,value) VALUES('schema_version','9')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
