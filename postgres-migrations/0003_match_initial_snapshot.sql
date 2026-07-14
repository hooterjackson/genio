ALTER TABLE "catalog_matches" ADD COLUMN IF NOT EXISTS "initial_status" varchar(40);
--> statement-breakpoint
ALTER TABLE "catalog_matches" ADD COLUMN IF NOT EXISTS "initial_basis" text;
--> statement-breakpoint
ALTER TABLE "catalog_matches" ADD COLUMN IF NOT EXISTS "initial_score" numeric(8, 6);
--> statement-breakpoint
ALTER TABLE "catalog_matches" ADD COLUMN IF NOT EXISTS "initial_catalog_id" varchar(100);
--> statement-breakpoint
ALTER TABLE "catalog_matches" ADD COLUMN IF NOT EXISTS "initial_song_json" jsonb;
--> statement-breakpoint
ALTER TABLE "catalog_matches" ADD COLUMN IF NOT EXISTS "initial_matched_at" timestamp with time zone;
--> statement-breakpoint
INSERT INTO "settings"("key","value") VALUES('schema_version','4')
ON CONFLICT("key") DO UPDATE SET "value"=EXCLUDED."value","updated_at"=now();
