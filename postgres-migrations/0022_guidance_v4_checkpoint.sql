BEGIN;

ALTER TABLE guidance_question_sets
  ADD COLUMN IF NOT EXISTS checkpoint_mode varchar(40),
  ADD COLUMN IF NOT EXISTS interpretation_summary_json jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid='guidance_question_sets'::regclass
      AND conname='guidance_question_sets_checkpoint_mode_valid'
  ) THEN
    ALTER TABLE guidance_question_sets
      ADD CONSTRAINT guidance_question_sets_checkpoint_mode_valid CHECK (
        checkpoint_mode IS NULL
        OR checkpoint_mode IN (
          'correctness_blocking',
          'nuance_optional',
          'interpretation_confirmation'
        )
      );
  END IF;
END $$;

INSERT INTO settings(key,value)
VALUES
  ('schema_version','19'),
  ('guidance_checkpoint_version','4')
ON CONFLICT(key) DO UPDATE
SET value=excluded.value,updated_at=now();

COMMIT;
