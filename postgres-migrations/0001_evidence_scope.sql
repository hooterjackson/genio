ALTER TABLE evidence_claims
  ADD COLUMN IF NOT EXISTS support_scope varchar(32) NOT NULL DEFAULT 'collection';
-- statement-breakpoint
ALTER TABLE evidence_claims
  ADD COLUMN IF NOT EXISTS verification_phase varchar(80) NOT NULL DEFAULT 'unverified';
-- statement-breakpoint
UPDATE evidence_claims
SET state='inferred'
WHERE state IN ('verified','corroborated')
  AND (support_scope<>'track' OR verification_phase<>'track_verification');
-- statement-breakpoint
INSERT INTO settings(key,value) VALUES('schema_version','2')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
