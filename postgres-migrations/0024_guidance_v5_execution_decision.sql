BEGIN;

ALTER TABLE guidance_question_sets
  DROP CONSTRAINT IF EXISTS guidance_question_sets_checkpoint_mode_valid;

ALTER TABLE guidance_question_sets
  ADD CONSTRAINT guidance_question_sets_checkpoint_mode_valid CHECK (
    checkpoint_mode IS NULL
    OR checkpoint_mode IN (
      'correctness_blocking',
      'nuance_optional',
      'interpretation_confirmation',
      'execution_decision'
    )
  );

INSERT INTO settings(key,value)
VALUES
  ('guidance_checkpoint_version','5.1')
ON CONFLICT(key) DO UPDATE
SET value=excluded.value,updated_at=now();

COMMIT;
