CREATE TABLE IF NOT EXISTS citation_attestations (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  attestation_key varchar(64) NOT NULL,
  source_url text NOT NULL,
  response_id varchar(240) NOT NULL,
  output_item_id varchar(240) NOT NULL,
  content_index integer NOT NULL CHECK (content_index >= 0),
  start_index integer NOT NULL CHECK (start_index >= 0),
  end_index integer NOT NULL CHECK (end_index > start_index),
  excerpt varchar(1000) NOT NULL CHECK (char_length(excerpt) BETWEEN 8 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT citation_attestation_https CHECK (source_url ~ '^https://'),
  CONSTRAINT citation_attestation_span_length CHECK (end_index-start_index=char_length(excerpt)),
  CONSTRAINT citation_attestation_run_key_unique UNIQUE(run_id,attestation_key)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS citation_attestation_run_idx
  ON citation_attestations(run_id);
--> statement-breakpoint
ALTER TABLE evidence_claims
  ADD COLUMN IF NOT EXISTS citation_attestation_id uuid REFERENCES citation_attestations(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS evidence_citation_attestation_idx
  ON evidence_claims(citation_attestation_id);
--> statement-breakpoint
-- This is both the initial backfill and a replay-safe repair. Claims that
-- already point at a persisted attestation have passed the new integrity
-- gate and must keep their state when the migration is applied again.
UPDATE evidence_claims e
SET state='inferred',citation_attestation_id=NULL
FROM source_records s
WHERE s.id=e.source_id
  AND s.source_class='web'
  AND e.citation_attestation_id IS NULL
  AND e.state IN ('verified','corroborated','editorial','disputed');
--> statement-breakpoint
INSERT INTO settings(key,value) VALUES('schema_version','5')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now();
