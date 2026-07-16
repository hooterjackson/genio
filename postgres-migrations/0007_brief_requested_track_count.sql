ALTER TABLE brief_requests
  ADD COLUMN IF NOT EXISTS requested_track_count integer;
--> statement-breakpoint
ALTER TABLE brief_requests
  DROP CONSTRAINT IF EXISTS brief_requests_requested_track_count_check;
--> statement-breakpoint
ALTER TABLE brief_requests
  ADD CONSTRAINT brief_requests_requested_track_count_check
  CHECK(requested_track_count IS NULL OR requested_track_count BETWEEN 1 AND 10000);
--> statement-breakpoint
ALTER TABLE research_runs
  ADD COLUMN IF NOT EXISTS auto_publish boolean NOT NULL DEFAULT false;
--> statement-breakpoint
INSERT INTO settings(key,value) VALUES('schema_version','8')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
