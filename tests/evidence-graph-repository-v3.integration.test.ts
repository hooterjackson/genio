import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PgEvidenceGraphRepositoryV3 } from "../server/evidence-graph-repository-v3.ts";
import {
  EVIDENCE_GRAPH_PIPELINE_V3,
  EVIDENCE_GRAPH_POLICY_V3,
  EvidenceGraphServiceV3,
} from "../server/evidence-graph-service-v3.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseDescribe = databaseUrl ? describe.sequential : describe.skip;
const migrationDirectory = new URL("../postgres-migrations/", import.meta.url);
const migrationSql = readdirSync(migrationDirectory)
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort()
  .map((file) => readFileSync(new URL(`../postgres-migrations/${file}`, import.meta.url), "utf8"))
  .join("\n-- statement-breakpoint\n");

async function applySql(pool: Pool, sql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of sql
      .split(/\s*-- statement-breakpoint\s*/u)
      .map((value) => value.trim())
      .filter(Boolean)) {
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

databaseDescribe("schema-14 evidence graph repository", () => {
  const schemaName = `genio_graph_service_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl, max: 2, application_name: "graph-service-admin" });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 3,
      application_name: "graph-service-integration",
    });
    await applySql(pool, migrationSql);
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  }, 30_000);

  test("persists governed promotion, locks a reproducible snapshot, and applies takedown without rewriting it", async () => {
    const subjectId = randomUUID();
    const recordingId = randomUUID();
    const sourceAId = randomUUID();
    const sourceBId = randomUUID();
    const catalogIdentityId = randomUUID();
    await pool.query(
      `INSERT INTO corpus_entities(id,entity_type,canonical_key,canonical_name)
       VALUES($1,'genre','genre:disco','Disco')`,
      [subjectId],
    );
    await pool.query(
      `INSERT INTO corpus_recordings(id,canonical_key,title,version_class)
       VALUES($1,'recording:integration','Integration Disco Track','studio')`,
      [recordingId],
    );
    await pool.query(
      `INSERT INTO corpus_source_documents(
         id,url,content_hash,title,source_class,provenance_root,access_method,source_revision,
         status,retrieved_at,metadata_json
       ) VALUES
         ($1,'https://archive-a.example/disco',$2,'Archive A','editorial','archive-a.example','manual_entry',$2,'active',now(),'{}'::jsonb),
         ($3,'https://archive-b.example/disco',$4,'Archive B','editorial','archive-b.example','manual_entry',$4,'active',now(),'{}'::jsonb)`,
      [sourceAId, "a".repeat(64), sourceBId, "b".repeat(64)],
    );
    await pool.query(
      `INSERT INTO corpus_catalog_identities(
         id,recording_id,provider,storefront,catalog_id,is_preferred,is_available,identity_confidence
       ) VALUES($1,$2,'apple','us','apple-integration-song',true,true,0.99)`,
      [catalogIdentityId, recordingId],
    );

    const repository = new PgEvidenceGraphRepositoryV3(pool);
    const service = new EvidenceGraphServiceV3(repository, () => new Date("2026-07-20T12:00:00.000Z"));
    await service.approveSourcePolicy({
      sourceDocumentId: sourceAId,
      authority: "secondary_database",
      accessMethod: "manual_entry",
      licenseState: "permission_recorded",
      licenseVersion: "permission-a-v1",
      termsVersion: "terms-a-v1",
      attribution: "Archive A",
      cachePolicy: "excerpt_only",
      retentionPolicy: "durable_public_corpus",
      freshnessPolicy: "immutable_revision",
      sourceRevision: "a".repeat(64),
      approvedBy: "integration-reviewer",
    });
    const sourcePage = await repository.listSources({ limit: 1, offset: 0 });
    expect(sourcePage).toMatchObject({ total: 2, limit: 1, offset: 0 });
    expect(sourcePage.items).toHaveLength(1);
    await service.approveSourcePolicy({
      sourceDocumentId: sourceBId,
      authority: "primary_track_credit",
      accessMethod: "manual_entry",
      licenseState: "permission_recorded",
      licenseVersion: "permission-b-v1",
      termsVersion: "terms-b-v1",
      attribution: "Archive B",
      cachePolicy: "excerpt_only",
      retentionPolicy: "durable_public_corpus",
      freshnessPolicy: "immutable_revision",
      sourceRevision: "b".repeat(64),
      approvedBy: "integration-reviewer",
    });

    const graph = {
      relationship: "is a disco recording",
      claimAxis: "genre",
      supportedValues: ["disco"],
      polarity: "supports",
      scope: "exact_recording",
    };
    const first = await service.appendObservation({
      sourceDocumentId: sourceAId,
      subjectEntityId: subjectId,
      recordingId,
      predicate: "genre_membership",
      objectJson: { graph },
      creditScope: "exact_recording",
      supportExcerpt: "Archive A identifies the exact recording as disco.",
      confidence: 0.98,
      pipelineVersion: EVIDENCE_GRAPH_PIPELINE_V3,
      policyVersion: EVIDENCE_GRAPH_POLICY_V3,
    });
    const second = await service.appendObservation({
      sourceDocumentId: sourceBId,
      subjectEntityId: subjectId,
      recordingId,
      predicate: "genre_membership",
      objectJson: { graph },
      creditScope: "exact_recording",
      supportExcerpt: "Archive B identifies the exact recording as disco.",
      confidence: 0.99,
      pipelineVersion: EVIDENCE_GRAPH_PIPELINE_V3,
      policyVersion: EVIDENCE_GRAPH_POLICY_V3,
    });
    const reviewPage = await repository.listObservations({ limit: 25, offset: 0, status: "quarantined" });
    expect(reviewPage.total).toBe(2);
    expect(reviewPage.items.map(({ source }) => source.provenanceRoot).sort()).toEqual([
      "archive-a.example",
      "archive-b.example",
    ]);
    const assertion = await service.promoteObservations({
      observationIds: [first.id, second.id],
      promotedBy: "integration-reviewer",
    });
    expect(assertion.evidenceTier).toBe("verified");
    const assertionPage = await repository.listAssertions({ limit: 25, offset: 0, status: "active" });
    expect(assertionPage.items).toHaveLength(1);
    expect(assertionPage.items[0]).toMatchObject({ evidenceCount: 2 });
    expect((await pool.query<{ status: string }>(
      "SELECT status FROM corpus_assertion_observations WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[first.id, second.id]],
    )).rows.map(({ status }) => status)).toEqual(["promoted", "promoted"]);

    const snapshot = await service.createLockedSnapshot();
    expect(snapshot).toMatchObject({ status: "locked", assertionCount: 1, catalogIdentityCount: 1 });
    const snapshotPage = await repository.listSnapshots({ limit: 25, offset: 0, status: "locked" });
    expect(snapshotPage.items).toContainEqual(snapshot);
    expect(snapshotPage.items).toContainEqual(expect.objectContaining({
      id: "00000000-0000-4000-8000-000000000014",
      status: "locked",
      assertionCount: 0,
      catalogIdentityCount: 0,
    }));
    expect((await pool.query(
      "SELECT assertion_id FROM graph_snapshot_assertions WHERE graph_snapshot_id=$1",
      [snapshot.id],
    )).rows).toEqual([{ assertion_id: assertion.id }]);
    const frozenAssertion = (await pool.query<{
      assertion_revision_json: {
        status: string;
        evidence: Array<{ sourceDocument: { status: string } }>;
      };
    }>(
      `SELECT assertion_revision_json
       FROM graph_snapshot_assertions
       WHERE graph_snapshot_id=$1 AND assertion_id=$2`,
      [snapshot.id, assertion.id],
    )).rows[0]?.assertion_revision_json;
    const frozenCatalogIdentity = (await pool.query<{
      catalog_identity_revision_json: { is_available: boolean };
    }>(
      `SELECT catalog_identity_revision_json
       FROM graph_snapshot_catalog_identities
       WHERE graph_snapshot_id=$1 AND catalog_identity_id=$2`,
      [snapshot.id, catalogIdentityId],
    )).rows[0]?.catalog_identity_revision_json;
    expect(frozenAssertion).toMatchObject({ status: "active" });
    expect(frozenAssertion?.evidence).toHaveLength(2);
    expect(frozenAssertion?.evidence.every(({ sourceDocument }) => sourceDocument.status === "active")).toBe(true);
    expect(frozenCatalogIdentity).toMatchObject({ is_available: true });

    await expect(pool.query(
      "DELETE FROM graph_snapshot_assertions WHERE graph_snapshot_id=$1",
      [snapshot.id],
    )).rejects.toThrow(/immutable/u);
    await expect(pool.query(
      `UPDATE graph_snapshots
       SET status='building',content_hash=NULL,locked_at=NULL
       WHERE id=$1`,
      [snapshot.id],
    )).rejects.toThrow(/immutable/u);
    await expect(pool.query(
      "UPDATE graph_snapshots SET assertion_count=assertion_count+1 WHERE id=$1",
      [snapshot.id],
    )).rejects.toThrow(/immutable/u);

    const takedown = await service.takeDownSource({
      sourceDocumentId: sourceAId,
      promotedBy: "integration-owner",
      reason: "Rights holder request",
    });
    expect(takedown).toEqual({ retractedAssertionIds: [], retainedAssertionIds: [assertion.id] });
    expect((await pool.query<{ status: string }>(
      "SELECT status FROM corpus_promoted_assertions WHERE id=$1",
      [assertion.id],
    )).rows[0]?.status).toBe("active");
    expect((await pool.query<{ count: string }>(
      "SELECT count(*)::text count FROM graph_snapshot_assertions WHERE graph_snapshot_id=$1",
      [snapshot.id],
    )).rows[0]?.count).toBe("1");

    await pool.query(
      "UPDATE corpus_catalog_identities SET is_available=false,last_verified_at=now() WHERE id=$1",
      [catalogIdentityId],
    );
    expect((await pool.query<{ assertion_revision_json: unknown }>(
      `SELECT assertion_revision_json
       FROM graph_snapshot_assertions
       WHERE graph_snapshot_id=$1 AND assertion_id=$2`,
      [snapshot.id, assertion.id],
    )).rows[0]?.assertion_revision_json).toEqual(frozenAssertion);
    expect((await pool.query<{ catalog_identity_revision_json: unknown }>(
      `SELECT catalog_identity_revision_json
       FROM graph_snapshot_catalog_identities
       WHERE graph_snapshot_id=$1 AND catalog_identity_id=$2`,
      [snapshot.id, catalogIdentityId],
    )).rows[0]?.catalog_identity_revision_json).toEqual(frozenCatalogIdentity);

    await pool.query("UPDATE graph_snapshots SET status='superseded' WHERE id=$1", [snapshot.id]);
    await expect(pool.query(
      `UPDATE graph_snapshots
       SET status='building',content_hash=NULL,locked_at=NULL
       WHERE id=$1`,
      [snapshot.id],
    )).rejects.toThrow(/immutable/u);
    await expect(pool.query("DELETE FROM graph_snapshots WHERE id=$1", [snapshot.id])).rejects.toThrow(/append-only/u);
  }, 20_000);

  test("refuses to lock a snapshot whose declared counts do not match its frozen membership", async () => {
    const snapshotId = randomUUID();
    await pool.query("INSERT INTO graph_snapshots(id,status) VALUES($1,'building')", [snapshotId]);
    await expect(pool.query(
      `UPDATE graph_snapshots
       SET status='locked',content_hash=$2,assertion_count=1,catalog_identity_count=0,locked_at=now()
       WHERE id=$1`,
      [snapshotId, "f".repeat(64)],
    )).rejects.toThrow(/counts do not match/u);
    expect((await pool.query<{ status: string }>(
      "SELECT status FROM graph_snapshots WHERE id=$1",
      [snapshotId],
    )).rows[0]?.status).toBe("building");
    await pool.query("DELETE FROM graph_snapshots WHERE id=$1", [snapshotId]);
  }, 20_000);
});
