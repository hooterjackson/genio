ALTER TABLE evidence_claims
  ADD COLUMN IF NOT EXISTS subject_entity varchar(240);
-- statement-breakpoint
ALTER TABLE evidence_claims
  ADD COLUMN IF NOT EXISTS subject_relationship varchar(240);
-- statement-breakpoint
UPDATE evidence_claims e
SET subject_entity=CASE
      WHEN jsonb_typeof(r.brief_json->'subjectEntities')='array'
        AND jsonb_array_length(r.brief_json->'subjectEntities')=1
      THEN left(r.brief_json->'subjectEntities'->>0,240)
      ELSE ''
    END,
    subject_relationship=left(COALESCE(r.brief_json->>'relationship',''),240),
    state=CASE
      WHEN e.state IN ('verified','corroborated','editorial') THEN 'inferred'
      ELSE e.state
    END
FROM research_runs r
WHERE r.id=e.run_id
  AND (e.subject_entity IS NULL OR e.subject_relationship IS NULL);
-- statement-breakpoint
UPDATE evidence_claims
SET subject_entity=COALESCE(subject_entity,''),
    subject_relationship=COALESCE(subject_relationship,''),
    state=CASE
      WHEN COALESCE(subject_entity,'')='' OR COALESCE(subject_relationship,'')='' THEN 'inferred'
      ELSE state
    END;
-- statement-breakpoint
-- Keep both columns nullable during the rolling upgrade. The new API always
-- writes canonical values and treats NULL legacy rows as ineligible, while an
-- old worker can continue writing until it is drained. A later contract-only
-- release may add NOT NULL after every old revision is gone.
DROP INDEX IF EXISTS evidence_claim_unique_idx;
-- statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS evidence_claim_unique_idx
  ON evidence_claims(candidate_id,source_id,subject_entity,subject_relationship,relationship);
-- statement-breakpoint
INSERT INTO settings(key,value) VALUES('schema_version','3')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
