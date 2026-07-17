ALTER TABLE brief_requests
  ADD COLUMN IF NOT EXISTS guidance_source_hints_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS guidance_telemetry_json jsonb,
  ADD COLUMN IF NOT EXISTS guidance_preferences_json jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE research_runs
  ADD COLUMN IF NOT EXISTS guidance_source_hints_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS guidance_telemetry_json jsonb,
  ADD COLUMN IF NOT EXISTS guidance_preferences_json jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
INSERT INTO settings(key,value) VALUES('schema_version','12')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
