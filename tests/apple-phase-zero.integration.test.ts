import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDatabase } from "../db/index.ts";
import { createApplePhaseZeroManifest } from "../server/apple-phase-zero-manifest.ts";
import type { ApplePhaseZeroManifestInput } from "../server/apple-phase-zero.ts";
import { Repository } from "../server/repository.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseDescribe = databaseUrl ? describe.sequential : describe.skip;
const migrationDirectory = new URL("../postgres-migrations/", import.meta.url);
const migrationSql = readdirSync(migrationDirectory)
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort()
  .map((file) => readFileSync(new URL(`../postgres-migrations/${file}`, import.meta.url), "utf8"))
  .join("\n-- statement-breakpoint\n");

async function applyMigration(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of migrationSql.split(/\s*-- statement-breakpoint\s*/u).map((value) => value.trim()).filter(Boolean)) {
      await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

databaseDescribe("Apple phase-zero manifest persistence", () => {
  const schemaName = `needle_phase_zero_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool;
  let repository: Repository;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl, max: 2, application_name: "needle-phase-zero-admin" });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    const handle = createDatabase({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 4,
      application_name: "needle-phase-zero-integration",
    });
    await applyMigration(handle.pool);
    repository = new Repository(handle);
  }, 30_000);

  afterAll(async () => {
    if (repository) await repository.close();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  }, 30_000);

  test("persists an exact duplicate-aware immutable manifest without claiming research evidence", async () => {
    const input: ApplePhaseZeroManifestInput = {
      suiteId: "integration-suite",
      fixtureHash: "a".repeat(64),
      caseId: "three",
      storefront: "us",
      name: "[NEEDLE TEST] integration-suite 3 tracks",
      description: "Temporary phase-zero integration fixture.",
      tracks: [
        { id: "101", name: "First", artistName: "Artist", albumName: "Album" },
        { id: "202", name: "Second", artistName: "Artist", albumName: "Album" },
        { id: "101", name: "First", artistName: "Artist", albumName: "Album" },
      ],
    };

    const first = await createApplePhaseZeroManifest(repository, input);
    const resumed = await createApplePhaseZeroManifest(repository, input);
    expect(resumed).toEqual(first);
    expect(first.tracks.map((track) => track.catalogId)).toEqual(["101", "202", "101"]);
    expect(first.tracks.map((track) => track.position)).toEqual([0, 1, 2]);
    expect(await repository.getPublicationCompleteness(first.runId, first.id)).toEqual({
      omittedCandidateCount: 0,
      unresolvedCoverageCount: 0,
    });

    const claims = await repository.pool.query<{
      state: string;
      support_scope: string;
      verification_phase: string;
      subject_entity: string;
      subject_relationship: string;
    }>(
      `SELECT state,support_scope,verification_phase,subject_entity,subject_relationship
       FROM evidence_claims WHERE run_id=$1 ORDER BY id`,
      [first.runId],
    );
    expect(claims.rows).toHaveLength(3);
    expect(claims.rows.every((claim) => (
      claim.state === "inferred"
      && claim.support_scope === "track"
      && claim.verification_phase === "catalog_enrichment"
      && claim.subject_entity.includes("Artist —")
      && claim.subject_relationship === "operational Apple catalog fixture"
    ))).toBe(true);

    const audit = await repository.pool.query<{ action: string; actor: string }>(
      "SELECT action,actor FROM audit_events WHERE run_id=$1",
      [first.runId],
    );
    expect(audit.rows).toEqual([{ action: "apple.phase_zero_manifest_created", actor: "phase-zero-tool" }]);
  });
});
