ALTER TABLE track_candidates
  ADD COLUMN IF NOT EXISTS selection_rank integer;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'track_candidates_selection_rank_check'
      AND conrelid = 'track_candidates'::regclass
  ) THEN
    ALTER TABLE track_candidates
      ADD CONSTRAINT track_candidates_selection_rank_check
      CHECK (selection_rank IS NULL OR selection_rank > 0) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'track_candidates_selection_rank_check'
      AND conrelid = 'track_candidates'::regclass
      AND NOT convalidated
  ) THEN
    ALTER TABLE track_candidates
      VALIDATE CONSTRAINT track_candidates_selection_rank_check;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS candidate_selection_rank_idx
  ON track_candidates(run_id,selection_rank);
--> statement-breakpoint
INSERT INTO settings(key,value) VALUES('schema_version','6')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
