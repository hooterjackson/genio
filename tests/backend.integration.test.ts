import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, DATABASE_SCHEMA_VERSION } from "../db/index.ts";
import { CapabilityService, CAPABILITY_COOKIE } from "../server/capabilities.ts";
import {
  CATALOG_RECOVERY_UNRESOLVED_BASIS,
  RETRYABLE_CATALOG_MATCH_BASES,
} from "../server/catalog-match-recovery.ts";
import { canonicalGatewayRequest, createGatewayVerifier } from "../server/gateway-auth.ts";
import { processNotificationJob } from "../server/notifications.ts";
import { Repository } from "../server/repository.ts";
import { appleAuthorizationGeneration } from "../server/apple.ts";
import type { HostedCitationAttestation } from "../server/research.ts";
import { hmacBase64Url, sha256Hex } from "../server/security.ts";
import type { CitationAttestationInput, PlaylistBrief } from "../shared/types.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseDescribe = databaseUrl ? describe.sequential : describe.skip;
const migrationSql = [
  "0000_needle_initial.sql",
  "0001_evidence_scope.sql",
  "0002_research_integrity.sql",
  "0003_match_initial_snapshot.sql",
  "0004_citation_attestation.sql",
  "0005_candidate_selection_rank.sql",
  "0006_capability_session_accesses.sql",
]
  .map((file) => readFileSync(new URL(`../postgres-migrations/${file}`, import.meta.url), "utf8"))
  .join("\n-- statement-breakpoint\n");

const brief: PlaylistBrief = {
  title: "Integration test playlist",
  description: "A deterministic scope used only by the hosted backend integration suite.",
  mode: "exhaustive",
  subjectEntities: ["Integration Test Artist"],
  relationship: "primary artist",
  include: ["officially released recordings"],
  exclude: ["unreleased recordings"],
  versionPolicy: "one canonical studio recording",
  evidencePolicy: "verified or corroborated",
  orderingPolicy: "chronological",
  targetSize: null,
  ambiguities: [],
};
const evidenceBinding = {
  subjectEntity: brief.subjectEntities[0]!,
  subjectRelationship: brief.relationship,
};

function citationFixture(
  sourceUrl: string,
  title: string,
  relationship: string,
  subjectEntity = evidenceBinding.subjectEntity,
): { attestation: HostedCitationAttestation; support: CitationAttestationInput } {
  const excerpt = `${subjectEntity} — ${relationship} — ${title}.`;
  const support = {
    responseId: `resp-${randomUUID()}`,
    outputItemId: `msg-${randomUUID()}`,
    contentIndex: 0,
    startIndex: 0,
    endIndex: excerpt.length,
    excerpt,
  };
  return { support, attestation: { sourceUrl, ...support } };
}

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

function fakeGatewayRequest(input: {
  path: string;
  body: Buffer;
  headers: Record<string, string>;
}): FastifyRequest {
  const rawHeaders = Object.entries(input.headers).flatMap(([name, value]) => [name, value]);
  return {
    method: "POST",
    url: input.path,
    rawBody: input.body,
    raw: { rawHeaders, url: input.path },
  } as unknown as FastifyRequest;
}

class ReplyStub {
  readonly headers = new Map<string, string>();

  header(name: string, value: unknown): this {
    this.headers.set(name.toLowerCase(), String(value));
    return this;
  }
}

function cookieRequest(cookie: string): FastifyRequest {
  return {
    method: "GET",
    url: "/api/v1/runs/test",
    raw: { rawHeaders: ["cookie", cookie], url: "/api/v1/runs/test" },
  } as unknown as FastifyRequest;
}

databaseDescribe("hosted backend integration", () => {
  const schemaName = `needle_it_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool;
  let repository: Repository;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl, max: 2, application_name: "needle-integration-admin" });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    const handle = createDatabase({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 8,
      application_name: "needle-integration",
    });
    await applyMigration(handle.pool);
    repository = new Repository(handle);
  }, 30_000);

  beforeEach(async () => {
    await repository.pool.query(`DO $$
      DECLARE table_name text;
      BEGIN
        FOR table_name IN SELECT tablename FROM pg_tables WHERE schemaname=current_schema() LOOP
          EXECUTE format('TRUNCATE TABLE %I.%I CASCADE', current_schema(), table_name);
        END LOOP;
      END $$`);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    if (repository) await repository.close();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  }, 30_000);

  test("applies the Postgres migration idempotently and reports schema readiness", async () => {
    const constraintBefore = await repository.pool.query<{ oid: string; convalidated: boolean }>(
      `SELECT oid::text,convalidated
       FROM pg_constraint
       WHERE conname='track_candidates_selection_rank_check'
         AND conrelid='track_candidates'::regclass`,
    );
    expect(constraintBefore.rows).toEqual([
      expect.objectContaining({ convalidated: true }),
    ]);
    await applyMigration(repository.pool);
    const constraintAfter = await repository.pool.query<{ oid: string; convalidated: boolean }>(
      `SELECT oid::text,convalidated
       FROM pg_constraint
       WHERE conname='track_candidates_selection_rank_check'
         AND conrelid='track_candidates'::regclass`,
    );
    expect(constraintAfter.rows).toEqual(constraintBefore.rows);
    await expect(repository.ensureSchemaVersion()).resolves.toBeUndefined();
    const result = await repository.pool.query<{ name: string }>(
      `SELECT unnest(ARRAY[
        to_regclass('settings')::text,
        to_regclass('research_runs')::text,
        to_regclass('job_queue')::text,
        to_regclass('cost_reservations')::text,
        to_regclass('gateway_nonces')::text,
        to_regclass('capability_sessions')::text,
        to_regclass('capability_session_accesses')::text,
        to_regclass('citation_attestations')::text
      ]) AS name`,
    );
    expect(result.rows.map((row) => row.name)).toEqual([
      "settings",
      "research_runs",
      "job_queue",
      "cost_reservations",
      "gateway_nonces",
      "capability_sessions",
      "capability_session_accesses",
      "citation_attestations",
    ]);
    const evidenceColumns = await repository.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema=current_schema() AND table_name='evidence_claims'
         AND column_name IN ('citation_attestation_id','subject_entity','subject_relationship','support_scope','verification_phase')
       ORDER BY column_name`,
    );
    expect(evidenceColumns.rows.map((row) => row.column_name)).toEqual([
      "citation_attestation_id",
      "subject_entity",
      "subject_relationship",
      "support_scope",
      "verification_phase",
    ]);
    const candidateColumns = await repository.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema=current_schema() AND table_name='track_candidates'
         AND column_name='selection_rank'`,
    );
    expect(candidateColumns.rows.map((row) => row.column_name)).toEqual(["selection_rank"]);
  });

  test("track verification can promote and later demote the same persisted claim", async () => {
    const runId = await repository.createRun("Evidence transition test", brief, 0, 1);
    const sourceUrl = `https://credits.example/${randomUUID()}`;
    const sourceIds = await repository.addSources(runId, [{
      url: sourceUrl,
      title: "Integration credit source",
      sourceClass: "web",
      provenanceRoot: "credits.example",
      note: "A bounded integration-test credit note.",
    }]);
    const candidate = {
      artist: "Integration Artist",
      title: "Integration Song",
      album: "Integration Album",
      releaseYear: 2020,
      durationMs: 240_000,
      isrc: `USAAA${Math.floor(Math.random() * 10_000_000).toString().padStart(7, "0")}`,
      musicbrainzId: null,
      versionLabel: null,
    };
    const citation = citationFixture(sourceUrl, candidate.title, "performed on");
    await repository.addCitationAttestations(runId, [citation.attestation]);
    const claim = (state: "verified" | "inferred", supportScope: "track" | "album", relationship = "performed on") => ({
      sourceUrl,
      state,
      supportScope,
      ...evidenceBinding,
      relationship,
      note: "The relationship under verification.",
      citationSupport: relationship === "performed on" ? citation.support : null,
    });

    await repository.addCandidates(runId, [{ ...candidate, evidence: [claim("verified", "album")] }], sourceIds, "source_discovery");
    let stored = await repository.pool.query(
      "SELECT state,support_scope,verification_phase FROM evidence_claims WHERE run_id=$1",
      [runId],
    );
    expect(stored.rows[0]).toMatchObject({ state: "inferred", support_scope: "album", verification_phase: "source_discovery" });
    expect((await repository.getCoverage(runId)).eligibleCandidateCount).toBe(0);

    await repository.addCandidates(runId, [{ ...candidate, evidence: [claim("verified", "track")] }], sourceIds, "track_verification");
    stored = await repository.pool.query(
      "SELECT state,support_scope,verification_phase FROM evidence_claims WHERE run_id=$1",
      [runId],
    );
    expect(stored.rows[0]).toMatchObject({ state: "verified", support_scope: "track", verification_phase: "track_verification" });
    expect((await repository.getCoverage(runId)).eligibleCandidateCount).toBe(1);

    await repository.addCandidates(runId, [{ ...candidate, evidence: [claim("inferred", "track", "session participation")] }], sourceIds, "track_verification");
    stored = await repository.pool.query(
      "SELECT state,support_scope,verification_phase FROM evidence_claims WHERE run_id=$1",
      [runId],
    );
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows.every((row) => row.state === "inferred")).toBe(true);
    expect(stored.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ support_scope: "track", verification_phase: "track_verification" }),
    ]));
    expect((await repository.getCoverage(runId)).eligibleCandidateCount).toBe(0);
  });

  test("strong web evidence requires a persisted exact citation attestation", async () => {
    const runId = await repository.createRun("Citation attestation integrity", brief, 0, 1);
    const sourceUrl = `https://credits.example/${randomUUID()}`;
    const sourceIds = await repository.addSources(runId, [{
      url: sourceUrl,
      title: "Attested credit source",
      sourceClass: "web",
      provenanceRoot: "credits.example",
      note: "A bounded citation-attestation test source.",
    }]);
    const candidate = {
      artist: "Recording Artist",
      title: "Attested Song",
      album: null,
      releaseYear: 2024,
      durationMs: 180_000,
      isrc: null,
      musicbrainzId: null,
      versionLabel: null,
    };
    const citation = citationFixture(sourceUrl, candidate.title, "performed on");
    const claim = (citationSupport: CitationAttestationInput) => ({
      sourceUrl,
      state: "verified" as const,
      supportScope: "track" as const,
      ...evidenceBinding,
      relationship: "performed on",
      note: "Track-level support.",
      citationSupport,
    });

    await repository.addCandidates(runId, [{ ...candidate, evidence: [claim(citation.support)] }], sourceIds, "track_verification");
    expect((await repository.pool.query(
      "SELECT state,citation_attestation_id FROM evidence_claims WHERE run_id=$1",
      [runId],
    )).rows[0]).toMatchObject({ state: "inferred", citation_attestation_id: null });

    await repository.addCitationAttestations(runId, [citation.attestation]);
    await repository.addCandidates(runId, [{ ...candidate, evidence: [claim(citation.support)] }], sourceIds, "track_verification");
    expect((await repository.pool.query(
      "SELECT state,citation_attestation_id IS NOT NULL attested FROM evidence_claims WHERE run_id=$1",
      [runId],
    )).rows[0]).toEqual({ state: "verified", attested: true });
    expect((await repository.getCoverage(runId)).eligibleCandidateCount).toBe(1);
    expect((await repository.getEvidenceReport(runId)).candidates[0].evidence[0].citationSupport)
      .toMatchObject({ responseId: citation.support.responseId, excerpt: citation.support.excerpt });

    await applyMigration(repository.pool);
    expect((await repository.pool.query(
      "SELECT state,citation_attestation_id IS NOT NULL attested FROM evidence_claims WHERE run_id=$1",
      [runId],
    )).rows[0]).toEqual({ state: "verified", attested: true });

    await repository.addCandidates(runId, [{
      ...candidate,
      evidence: [claim({ ...citation.support, excerpt: `${citation.support.excerpt} invented` })],
    }], sourceIds, "track_verification");
    expect((await repository.pool.query(
      "SELECT state,citation_attestation_id FROM evidence_claims WHERE run_id=$1",
      [runId],
    )).rows[0]).toMatchObject({ state: "inferred", citation_attestation_id: null });
    expect((await repository.getCoverage(runId)).eligibleCandidateCount).toBe(0);
  });

  test("identifierless rediscovery merges evidence and rejects an unbound subject", async () => {
    const runId = await repository.createRun("Identifierless evidence merge", brief, 0, 1);
    const urls = [
      `https://credits-one.example/${randomUUID()}`,
      `https://credits-two.example/${randomUUID()}`,
    ];
    const sourceIds = await repository.addSources(runId, urls.map((url, index) => ({
      url,
      title: `Credit source ${index + 1}`,
      sourceClass: "web" as const,
      provenanceRoot: `credits-${index + 1}.example`,
      note: "Independent track-credit source.",
    })));
    const descriptor = {
      artist: "Recording Artist",
      title: "Identifierless Song",
      album: "Identifierless Album",
      releaseYear: 2020,
      durationMs: 240_000,
      isrc: null,
      musicbrainzId: null,
      versionLabel: "studio",
    };
    const candidate = (sourceUrl: string, note: string) => ({
      ...descriptor,
      evidence: [{
        sourceUrl,
        state: "verified" as const,
        supportScope: "track" as const,
        ...evidenceBinding,
        relationship: "performed on",
        note,
      }],
    });

    await expect(repository.addCandidates(runId, [candidate(urls[0]!, "First credit")], sourceIds, "track_verification"))
      .resolves.toBe(1);
    await expect(repository.addCandidates(runId, [candidate(urls[1]!, "Second credit")], sourceIds, "track_verification"))
      .resolves.toBe(0);
    const merged = await repository.pool.query<{ candidates: number; claims: number }>(
      `SELECT
        (SELECT count(*)::int FROM track_candidates WHERE run_id=$1) candidates,
        (SELECT count(*)::int FROM evidence_claims WHERE run_id=$1) claims`,
      [runId],
    );
    expect(merged.rows[0]).toEqual({ candidates: 1, claims: 2 });

    const wrongSubject = candidate(urls[0]!, "Wrong subject");
    wrongSubject.evidence[0]!.subjectEntity = "Adjacent Artist";
    await expect(repository.addCandidates(runId, [wrongSubject], sourceIds, "track_verification"))
      .rejects.toMatchObject({ code: "evidence_subject_mismatch" });
    expect((await repository.pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM evidence_claims WHERE run_id=$1",
      [runId],
    )).rows[0]?.count).toBe(2);
  });

  test("counts pending frontier work and incomplete containers as unresolved coverage", async () => {
    const runId = await repository.createRun("Coverage test", brief, 0, 1);
    await repository.pool.query(
      `INSERT INTO source_frontier(id,run_id,source_class,strategy,status,discovered_count,recovered_count,note)
       VALUES($1,$2,'web','pending strategy','pending',1,0,'not finished')`,
      [randomUUID(), runId],
    );
    await repository.pool.query(
      `INSERT INTO research_containers(id,run_id,container_type,provider_id,title,status)
       VALUES($1,$2,'release','release:test','Test release','enumerating')`,
      [randomUUID(), runId],
    );
    const run = await repository.getRun(runId);
    expect(run.unresolvedCount).toBe(2);
  });

  test("container rediscovery preserves enumeration progress while later enumeration can advance it", async () => {
    const runId = await repository.createRun("Container merge integrity", brief, 0, 1);
    const identity = {
      containerType: "release" as const,
      providerId: "musicbrainz:release:merge-test",
      title: "Merge Test Release",
    };

    await repository.upsertResearchContainers(runId, [{
      ...identity,
      status: "enumerating",
      cursor: "page:2",
      advertisedTotal: 12,
      recoveredTotal: 7,
      metadata: { pagesRead: 2, enumerationSource: "release endpoint" },
    }]);
    await repository.upsertResearchContainers(runId, [{
      ...identity,
      title: "Merge Test Release Rediscovered",
      status: "discovered",
      cursor: null,
      advertisedTotal: null,
      recoveredTotal: 0,
      metadata: { pagesRead: 0, rediscoveredBy: "gap pass" },
    }]);
    const rediscoveredDuringEnumeration = (await repository.listResearchContainers(runId))[0];
    expect(rediscoveredDuringEnumeration).toMatchObject({
      title: "Merge Test Release Rediscovered",
      status: "enumerating",
      cursor: "page:2",
      advertisedTotal: 12,
      recoveredTotal: 7,
      metadata: { pagesRead: 2, enumerationSource: "release endpoint", rediscoveredBy: "gap pass" },
    });

    await repository.upsertResearchContainers(runId, [{
      ...identity,
      status: "complete",
      cursor: null,
      advertisedTotal: 12,
      recoveredTotal: 12,
      metadata: { pagesRead: 3, enumerationSource: "release endpoint", reconciled: true },
    }]);
    const completed = (await repository.listResearchContainers(runId))[0];
    expect(completed).toMatchObject({
      status: "complete",
      cursor: null,
      advertisedTotal: 12,
      recoveredTotal: 12,
      metadata: { pagesRead: 3, enumerationSource: "release endpoint", reconciled: true },
    });
    expect(completed.completedAt).not.toBeNull();

    await repository.upsertResearchContainers(runId, [{
      ...identity,
      title: "Merge Test Release Rediscovered",
      status: "discovered",
      cursor: null,
      advertisedTotal: null,
      recoveredTotal: 0,
      metadata: { pagesRead: 0, rediscoveredBy: "gap pass" },
    }]);
    const rediscoveredAfterCompletion = (await repository.listResearchContainers(runId))[0];
    expect(rediscoveredAfterCompletion).toMatchObject({
      title: "Merge Test Release Rediscovered",
      status: "complete",
      cursor: null,
      advertisedTotal: 12,
      recoveredTotal: 12,
      metadata: {
        pagesRead: 3,
        enumerationSource: "release endpoint",
        reconciled: true,
        rediscoveredBy: "gap pass",
      },
      completedAt: completed.completedAt,
    });

    await repository.upsertResearchContainers(runId, [{
      ...identity,
      status: "complete",
      cursor: null,
      advertisedTotal: 13,
      recoveredTotal: 13,
      metadata: { pagesRead: 4, enumerationSource: "release endpoint", refreshed: true },
    }]);
    expect((await repository.listResearchContainers(runId))[0]).toMatchObject({
      status: "complete",
      cursor: null,
      advertisedTotal: 13,
      recoveredTotal: 13,
      metadata: { pagesRead: 4, enumerationSource: "release endpoint", refreshed: true },
      completedAt: completed.completedAt,
    });
  });

  test("owner catalogue import is paused, quiescent, inferred, atomic, and audited", async () => {
    const runId = await repository.createRun("Owner import transaction", brief, 0, 1);
    const sourceUrl = `https://catalog.example/${randomUUID()}`;
    const source = {
      url: sourceUrl,
      title: "Owner catalogue row",
      sourceClass: "import" as const,
      provenanceRoot: "unclassified",
      note: "Unverified owner import.",
    };
    const candidate = {
      artist: "Import Artist",
      title: "Import Song",
      album: null,
      releaseYear: null,
      durationMs: null,
      isrc: null,
      musicbrainzId: null,
      versionLabel: null,
      evidence: [{
        sourceUrl,
        state: "inferred" as const,
        supportScope: "track" as const,
        subjectEntity: "",
        subjectRelationship: "",
        relationship: "owner catalogue attribution",
        note: "Linked support has not been fetched.",
      }],
    };
    const input = { runId, actor: "owner@example.com", importHash: "a".repeat(64), sources: [source], candidates: [candidate] };

    await repository.setSetting("research_paused", "false");
    await expect(repository.importOwnerCatalog(input)).rejects.toMatchObject({ code: "catalog_import_requires_pause" });
    await repository.setSetting("research_paused", "true");
    const job = await repository.enqueueJob({ kind: "research", runId, dedupeKey: randomUUID() });
    await repository.pool.query(
      "UPDATE job_queue SET status='leased',lease_owner='stale-worker',lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [job.id],
    );
    await expect(repository.importOwnerCatalog(input)).rejects.toMatchObject({ code: "run_not_quiescent" });
    await repository.pool.query("UPDATE job_queue SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [job.id]);

    const imported = await repository.importOwnerCatalog(input);
    expect(imported.newlyAdded).toBe(1);
    const stored = await repository.pool.query(
      `SELECT
        (SELECT count(*)::int FROM source_records WHERE run_id=$1) sources,
        (SELECT count(*)::int FROM track_candidates WHERE run_id=$1) candidates,
        (SELECT count(*)::int FROM evidence_claims WHERE run_id=$1 AND state='inferred' AND verification_phase='unverified') inferred,
        (SELECT count(*)::int FROM evidence_claims WHERE run_id=$1 AND subject_entity=$2 AND subject_relationship=$3) bound,
        (SELECT count(*)::int FROM source_frontier WHERE run_id=$1 AND source_class='import' AND status='complete') frontier,
        (SELECT count(*)::int FROM audit_events WHERE run_id=$1 AND action='run.catalog_imported') audits`,
      [runId, evidenceBinding.subjectEntity, evidenceBinding.subjectRelationship],
    );
    expect(stored.rows[0]).toMatchObject({ sources: 1, candidates: 1, inferred: 1, bound: 1, frontier: 1, audits: 1 });

    const rollbackRunId = await repository.createRun("Owner import rollback", brief, 0, 1);
    const conflictInput = {
      ...input,
      runId: rollbackRunId,
      importHash: "b".repeat(64),
      sources: [source, { ...source, provenanceRoot: "different-root" }],
    };
    await expect(repository.importOwnerCatalog(conflictInput)).rejects.toMatchObject({ code: "source_provenance_conflict" });
    const rolledBack = await repository.pool.query(
      `SELECT
        (SELECT count(*)::int FROM source_records WHERE run_id=$1) sources,
        (SELECT count(*)::int FROM track_candidates WHERE run_id=$1) candidates,
        (SELECT count(*)::int FROM source_frontier WHERE run_id=$1) frontier,
        (SELECT count(*)::int FROM audit_events WHERE run_id=$1) audits`,
      [rollbackRunId],
    );
    expect(rolledBack.rows[0]).toMatchObject({ sources: 0, candidates: 0, frontier: 0, audits: 0 });

    const lockedRunId = await repository.createRun("Owner import locked manifest", brief, 0, 1);
    await repository.pool.query(
      "INSERT INTO manifests(id,run_id,name,description,content_hash) VALUES($1,$2,'Locked','Locked before import',$3)",
      [randomUUID(), lockedRunId, "e".repeat(64)],
    );
    await expect(repository.importOwnerCatalog({ ...input, runId: lockedRunId, importHash: "f".repeat(64) }))
      .rejects.toMatchObject({ code: "manifest_already_locked" });
    expect((await repository.pool.query<{ count: number }>("SELECT count(*)::int count FROM source_records WHERE run_id=$1", [lockedRunId])).rows[0]?.count).toBe(0);
    await repository.setSetting("research_paused", "false");
  });

  test("owner import reuses validated sources and unclassified imports can upgrade one way", async () => {
    await repository.setSetting("research_paused", "true");
    try {
      const concreteRun = await repository.createRun("Concrete source reuse", brief, 0, 1);
      const concreteUrl = `https://credits.example/${randomUUID()}`;
      await repository.addSources(concreteRun, [{
        url: concreteUrl, title: "Validated", sourceClass: "web", provenanceRoot: "primary-ledger", note: "Validated web result.",
      }]);
      await repository.importOwnerCatalog({
        runId: concreteRun,
        actor: "owner@example.com",
        importHash: "c".repeat(64),
        sources: [{ url: concreteUrl, title: "Import", sourceClass: "import", provenanceRoot: "unclassified", note: "Import row." }],
        candidates: [{
          artist: "Artist", title: "Song", album: null, releaseYear: null, durationMs: null, isrc: null, musicbrainzId: null, versionLabel: null,
          evidence: [{ sourceUrl: concreteUrl, state: "inferred", supportScope: "track", ...evidenceBinding, relationship: "attribution", note: "Not verified." }],
        }],
      });
      let stored = await repository.pool.query("SELECT source_class,provenance_root,title FROM source_records WHERE run_id=$1 AND url=$2", [concreteRun, concreteUrl]);
      expect(stored.rows[0]).toMatchObject({ source_class: "web", provenance_root: "primary-ledger", title: "Validated" });

      const upgradeRun = await repository.createRun("Import source upgrade", brief, 0, 1);
      const upgradeUrl = `https://credits.example/${randomUUID()}`;
      await repository.importOwnerCatalog({
        runId: upgradeRun,
        actor: "owner@example.com",
        importHash: "d".repeat(64),
        sources: [{ url: upgradeUrl, title: "Import", sourceClass: "import", provenanceRoot: "unclassified", note: "Import row." }],
        candidates: [{
          artist: "Artist", title: "Song", album: null, releaseYear: null, durationMs: null, isrc: null, musicbrainzId: null, versionLabel: null,
          evidence: [{ sourceUrl: upgradeUrl, state: "inferred", supportScope: "track", ...evidenceBinding, relationship: "attribution", note: "Not verified." }],
        }],
      });
      await repository.addSources(upgradeRun, [{
        url: upgradeUrl, title: "Validated later", sourceClass: "web", provenanceRoot: "validated-ledger", note: "Hosted search result.",
      }]);
      stored = await repository.pool.query("SELECT source_class,provenance_root,title FROM source_records WHERE run_id=$1 AND url=$2", [upgradeRun, upgradeUrl]);
      expect(stored.rows[0]).toMatchObject({ source_class: "web", provenance_root: "validated-ledger", title: "Validated later" });
    } finally {
      await repository.setSetting("research_paused", "false");
    }
  });

  test("cache invalidation is audited and the next equivalent request creates fresh work", async () => {
    const bucket = `cache-${randomUUID()}`;
    const create = (key: string) => repository.createRunIdempotent({
      prompt: "same cache prompt",
      brief,
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket: bucket,
      clientBucketAliases: [bucket],
      idempotencyKey: key,
      rateLimit: 10,
      reuseDays: 30,
    });
    const first = await create(`first-${randomUUID()}`);
    await repository.updateRun(first.runId, { status: "complete", phase: "complete" });
    const reused = await create(`second-${randomUUID()}`);
    expect(reused).toMatchObject({ runId: first.runId, reused: true });
    await repository.invalidateRunReuse(first.runId, "owner@example.com");
    const fresh = await create(`third-${randomUUID()}`);
    expect(fresh.reused).toBe(false);
    expect(fresh.runId).not.toBe(first.runId);
    const audit = await repository.pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM audit_events WHERE run_id=$1 AND action='run.cache_invalidated'",
      [first.runId],
    );
    expect(audit.rows[0]?.count).toBe(1);
  });

  test("does not reuse partial, target-short, or owner refresh runs", async () => {
    const bucket = `cache-eligibility-${randomUUID()}`;
    const exactBrief: PlaylistBrief = {
      ...brief,
      mode: "curated",
      targetSize: { min: 100, max: 100 },
    };
    const create = (key: string, owner = false) => repository.createRunIdempotent({
      prompt: "same exact-count prompt",
      brief: exactBrief,
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket: bucket,
      clientBucketAliases: [bucket],
      idempotencyKey: key,
      rateLimit: 20,
      reuseDays: 30,
      bypassVisitorRateLimit: owner,
    });

    const partial = await create(`partial-${randomUUID()}`);
    await repository.updateRun(partial.runId, { status: "partial", phase: "complete" });
    const afterPartial = await create(`after-partial-${randomUUID()}`);
    expect(afterPartial).toMatchObject({ created: true, reused: false });

    await repository.updateRun(afterPartial.runId, { status: "complete", phase: "complete" });
    const afterShortfall = await create(`after-shortfall-${randomUUID()}`);
    expect(afterShortfall).toMatchObject({ created: true, reused: false });

    await repository.updateRun(afterShortfall.runId, { status: "complete", phase: "complete" });
    const ownerRefresh = await create(`owner-${randomUUID()}`, true);
    expect(ownerRefresh).toMatchObject({ created: true, reused: false });
  });

  test("accepts one valid gateway request and rejects an exact replay", async () => {
    const keyId = "integration-v1";
    const secret = "integration-gateway-secret-32-bytes";
    vi.stubEnv("GATEWAY_KEYS_JSON", "");
    vi.stubEnv("GATEWAY_KEY_ID", keyId);
    vi.stubEnv("GATEWAY_HMAC_SECRET", secret);
    vi.stubEnv("GATEWAY_PREVIOUS_KEY_ID", "");
    vi.stubEnv("GATEWAY_PREVIOUS_HMAC_SECRET", "");

    const path = "/api/v1/brief?integration=1";
    const body = Buffer.from(JSON.stringify({ prompt: "every integration test song" }));
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const nonce = `nonce_${"n".repeat(32)}`;
    const bodyHash = sha256Hex(body);
    const clientBucket = `2026-07-13.${"b".repeat(43)}`;
    const signature = hmacBase64Url(secret, canonicalGatewayRequest({
      keyId,
      timestamp,
      nonce,
      method: "POST",
      path,
      bodyHash,
      clientBucket,
      ownerEmail: "",
    }));
    const request = fakeGatewayRequest({
      path,
      body,
      headers: {
        "x-needle-key-id": keyId,
        "x-needle-timestamp": timestamp,
        "x-needle-nonce": nonce,
        "x-needle-body-sha256": bodyHash,
        "x-needle-client-bucket": clientBucket,
        "x-needle-signature": signature,
      },
    });
    const verify = createGatewayVerifier(repository);

    await expect(verify(request)).resolves.toMatchObject({ keyId, clientBucket, ownerEmail: null });
    await expect(verify(request)).rejects.toMatchObject({ statusCode: 409, code: "gateway_replay" });
  });

  test("serializes concurrent cost reservations and enforces the monthly ceiling", async () => {
    const createBrief = (suffix: string) => {
      const clientBucket = `bucket-${suffix}-${randomUUID()}`;
      return repository.createBriefRequest({
        prompt: `Integration cost request ${suffix}`,
        model: "test-model",
        clientBucket,
        clientBucketAliases: [clientBucket],
        rateLimit: 100,
      });
    };
    const first = await createBrief("idempotent");
    vi.stubEnv("APP_MONTHLY_COST_LIMIT_USD", "5");
    const sameReservation = await Promise.all([
      repository.reserveProviderCost({ briefRequestId: first.id }, "same-operation", 0.5),
      repository.reserveProviderCost({ briefRequestId: first.id }, "same-operation", 0.5),
    ]);
    expect(new Set(sameReservation.map((item) => item.reservationId)).size).toBe(1);
    await repository.releaseProviderCost(sameReservation[0]!.reservationId);

    vi.stubEnv("APP_MONTHLY_COST_LIMIT_USD", "1");
    const [left, right] = await Promise.all([createBrief("left"), createBrief("right")]);
    const results = await Promise.allSettled([
      repository.reserveProviderCost({ briefRequestId: left.id }, "left-call", 0.75),
      repository.reserveProviderCost({ briefRequestId: right.id }, "right-call", 0.75),
    ]);
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<{ reservationId: string }> => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ statusCode: 402, code: "monthly_budget_reached" });
    await repository.releaseProviderCost(fulfilled[0]!.value.reservationId);
  });

  test("monthly cost accounting switches at midnight in America/Sao_Paulo", async () => {
    const boundary = await repository.pool.query<{ start_at: Date }>(
      `SELECT date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')
         AT TIME ZONE 'America/Sao_Paulo' start_at`,
    );
    const startAt = boundary.rows[0]!.start_at;
    await repository.pool.query(
      `INSERT INTO cost_ledger(id,operation,amount_usd,occurred_at) VALUES
         ($1,'previous-sao-paulo-month',49,$3::timestamptz-interval '1 millisecond'),
         ($2,'current-sao-paulo-month',2.5,$3)`,
      [randomUUID(), randomUUID(), startAt],
    );

    const health = await repository.getSystemHealth();
    expect(health.monthSpendUsd).toBeCloseTo(2.5, 6);
    const localBoundary = await repository.pool.query<{ local_value: string }>(
      "SELECT to_char($1::timestamptz AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD HH24:MI:SS') local_value",
      [startAt],
    );
    expect(localBoundary.rows[0]?.local_value).toMatch(/-01 00:00:00$/u);
  });

  test("auto-starts an exact $5 run, gates an $8 run, and rejects invalid gate configuration", async () => {
    vi.stubEnv("AUTO_RUN_COST_LIMIT_USD", "5");
    const create = (label: string, estimateUsd: number, approvedBudgetUsd: number) => {
      const clientBucket = `cost-gate-${label}-${randomUUID()}`;
      return repository.createRunIdempotent({
        prompt: `Cost gate request ${label}`,
        brief: { ...brief, title: `Cost gate ${label}` },
        estimateUsd,
        approvedBudgetUsd,
        clientBucket,
        clientBucketAliases: [clientBucket],
        idempotencyKey: `cost-gate-${label}-${randomUUID()}`,
        reuseDays: 0,
        rateLimit: 100,
        globalLimit: 100,
      });
    };

    const exactGate = await create("exact", 5, 5);
    const aboveGate = await create("above", 8, 0);
    expect(await repository.getRun(exactGate.runId)).toMatchObject({
      status: "queued",
      estimatedCostUsd: 5,
      approvedBudgetUsd: 5,
    });
    expect(await repository.getRun(aboveGate.runId)).toMatchObject({
      status: "awaiting_budget",
      estimatedCostUsd: 8,
      approvedBudgetUsd: 0,
    });

    vi.stubEnv("AUTO_RUN_COST_LIMIT_USD", "NaN");
    await expect(create("invalid", 5, 5)).rejects.toThrow(/AUTO_RUN_COST_LIMIT_USD/u);
  });

  test("atomically enforces brief, run, mutation, and publish limits", async () => {
    const briefBucket = `brief-limit-${randomUUID()}`;
    const briefAttempts = await Promise.allSettled(Array.from({ length: 3 }, (_, index) =>
      repository.createBriefRequest({
        prompt: `Brief rate-limit request ${index}`,
        model: "test-model",
        clientBucket: briefBucket,
        clientBucketAliases: [briefBucket],
        rateLimit: 2,
      })));
    expect(briefAttempts.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(briefAttempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(briefAttempts.find((result) => result.status === "rejected")).toMatchObject({
      reason: { statusCode: 429, code: "rate_limited" },
    });

    const runBucket = `run-limit-${randomUUID()}`;
    const runAttempts = await Promise.allSettled(Array.from({ length: 3 }, (_, index) =>
      repository.createRunIdempotent({
        prompt: `Run rate-limit request ${index}`,
        brief,
        estimateUsd: 0,
        approvedBudgetUsd: 1,
        clientBucket: runBucket,
        clientBucketAliases: [runBucket],
        idempotencyKey: `run-limit-${index}-${randomUUID()}`,
        reuseDays: 0,
        rateLimit: 2,
        globalLimit: 100,
      })));
    expect(runAttempts.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(runAttempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(runAttempts.find((result) => result.status === "rejected")).toMatchObject({
      reason: { statusCode: 429, code: "rate_limited" },
    });

    const mutationBucket = `mutation-limit-${randomUUID()}`;
    const mutationAttempts = await Promise.allSettled([
      repository.consumeRateLimit([mutationBucket], "mutation", 1, 1),
      repository.consumeRateLimit([mutationBucket], "mutation", 1, 1),
    ]);
    expect(mutationAttempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(mutationAttempts.find((result) => result.status === "rejected")).toMatchObject({
      reason: { statusCode: 429, code: "rate_limited" },
    });

    const publishBucket = `publish-limit-${randomUUID()}`;
    const publishAttempts = await Promise.allSettled([
      repository.consumeRateLimit([publishBucket], "publish", 1, 24),
      repository.consumeRateLimit([publishBucket], "publish", 1, 24),
    ]);
    expect(publishAttempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(publishAttempts.find((result) => result.status === "rejected")).toMatchObject({
      reason: { statusCode: 429, code: "rate_limited" },
    });

    const counts = await repository.pool.query<{ client_bucket: string; action: string; count: number }>(
      `SELECT client_bucket,action,count(*)::int count FROM rate_limit_events
       WHERE client_bucket=ANY($1::text[]) GROUP BY client_bucket,action`,
      [[briefBucket, runBucket, mutationBucket, publishBucket]],
    );
    expect(counts.rows).toEqual(expect.arrayContaining([
      { client_bucket: briefBucket, action: "brief", count: 2 },
      { client_bucket: runBucket, action: "run", count: 2 },
      { client_bucket: mutationBucket, action: "mutation", count: 1 },
      { client_bucket: publishBucket, action: "publish", count: 1 },
    ]));
  });

  test("owner brief and run requests bypass visitor quotas without consuming visitor events", async () => {
    const briefBucket = `owner-brief-limit-${randomUUID()}`;
    const createBrief = (label: string, bypassVisitorRateLimit?: boolean) => repository.createBriefRequest({
      prompt: `Owner brief quota request ${label}`,
      model: "test-model",
      clientBucket: briefBucket,
      clientBucketAliases: [briefBucket],
      rateLimit: 1,
      bypassVisitorRateLimit,
    });
    await expect(createBrief("visitor")).resolves.toMatchObject({ created: true });
    await expect(createBrief("wrong-identity", false)).rejects.toMatchObject({
      statusCode: 429,
      code: "rate_limited",
    });
    await expect(createBrief("anonymous")).rejects.toMatchObject({
      statusCode: 429,
      code: "rate_limited",
    });
    await expect(createBrief("owner-one", true)).resolves.toMatchObject({ created: true });
    await expect(createBrief("owner-two", true)).resolves.toMatchObject({ created: true });

    const runBucket = `owner-run-limit-${randomUUID()}`;
    const createRun = (label: string, bypassVisitorRateLimit?: boolean) => repository.createRunIdempotent({
      prompt: `Owner run quota request ${label}`,
      brief: { ...brief, title: `Owner quota ${label}` },
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket: runBucket,
      clientBucketAliases: [runBucket],
      idempotencyKey: `owner-run-${label}-${randomUUID()}`,
      reuseDays: 0,
      rateLimit: 1,
      globalLimit: 100,
      bypassVisitorRateLimit,
    });
    await expect(createRun("visitor")).resolves.toMatchObject({ created: true });
    await expect(createRun("wrong-identity", false)).rejects.toMatchObject({
      statusCode: 429,
      code: "rate_limited",
    });
    await expect(createRun("anonymous")).rejects.toMatchObject({
      statusCode: 429,
      code: "rate_limited",
    });
    await expect(createRun("owner-one", true)).resolves.toMatchObject({ created: true });
    await expect(createRun("owner-two", true)).resolves.toMatchObject({ created: true });

    const events = await repository.pool.query<{ client_bucket: string; action: string; count: number }>(
      `SELECT client_bucket,action,count(*)::int count FROM rate_limit_events
       WHERE client_bucket=ANY($1::text[]) GROUP BY client_bucket,action ORDER BY client_bucket,action`,
      [[briefBucket, runBucket]],
    );
    expect(events.rows).toEqual(expect.arrayContaining([
      { client_bucket: briefBucket, action: "brief", count: 1 },
      { client_bucket: runBucket, action: "run", count: 1 },
    ]));
    expect(events.rows).toHaveLength(2);
  });

  test("owner visitor-rate bypass never bypasses global run capacity", async () => {
    const create = (label: string) => {
      const bucket = `owner-global-capacity-${label}-${randomUUID()}`;
      return repository.createRunIdempotent({
        prompt: `Owner global capacity request ${label}`,
        brief: { ...brief, title: `Owner global capacity ${label}` },
        estimateUsd: 0,
        approvedBudgetUsd: 1,
        clientBucket: bucket,
        clientBucketAliases: [bucket],
        idempotencyKey: `owner-global-${label}-${randomUUID()}`,
        reuseDays: 0,
        rateLimit: 0,
        globalLimit: 1,
        bypassVisitorRateLimit: true,
      });
    };
    await expect(create("first")).resolves.toMatchObject({ created: true });
    await expect(create("second")).rejects.toMatchObject({
      statusCode: 503,
      code: "global_capacity_reached",
    });
    const events = await repository.pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM rate_limit_events WHERE action='run'",
    );
    expect(events.rows[0]?.count).toBe(0);
  });

  test("keeps concurrent idempotent brief and run submissions single-effect", async () => {
    const briefBucket = `brief-idempotency-${randomUUID()}`;
    const briefKey = `brief-${randomUUID()}`;
    const createBrief = () => repository.createBriefRequest({
      prompt: "Concurrent idempotent brief request",
      model: "test-model",
      clientBucket: briefBucket,
      clientBucketAliases: [briefBucket],
      idempotencyKey: briefKey,
      rateLimit: 1,
    });
    const briefResults = await Promise.all([createBrief(), createBrief()]);
    expect(new Set(briefResults.map((result) => result.id)).size).toBe(1);
    expect(briefResults.filter((result) => result.created)).toHaveLength(1);

    const runBucket = `run-idempotency-${randomUUID()}`;
    const runKey = `run-${randomUUID()}`;
    const createRun = () => repository.createRunIdempotent({
      prompt: "Concurrent idempotent run request",
      brief,
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket: runBucket,
      clientBucketAliases: [runBucket],
      idempotencyKey: runKey,
      reuseDays: 0,
      rateLimit: 1,
      globalLimit: 100,
    });
    const runResults = await Promise.all([createRun(), createRun()]);
    expect(new Set(runResults.map((result) => result.runId)).size).toBe(1);
    expect(new Set(runResults.map((result) => result.accessId)).size).toBe(1);
    expect(runResults.filter((result) => result.created)).toHaveLength(1);

    const eventCounts = await repository.pool.query<{ client_bucket: string; count: number }>(
      `SELECT client_bucket,count(*)::int count FROM rate_limit_events
       WHERE client_bucket=ANY($1::text[]) GROUP BY client_bucket`,
      [[briefBucket, runBucket]],
    );
    expect(eventCounts.rows).toEqual(expect.arrayContaining([
      { client_bucket: briefBucket, count: 1 },
      { client_bucket: runBucket, count: 1 },
    ]));
  });

  test("atomically records a new fast route without reclassifying an unmarked idempotent retry", async () => {
    const clientBucket = `fast-route-${randomUUID()}`;
    const idempotencyKey = `fast-route-${randomUUID()}`;
    const curatedBrief: PlaylistBrief = {
      ...brief,
      title: "Fast route transaction",
      mode: "curated",
      targetSize: { min: 50, max: 100 },
    };
    const create = () => repository.createRunIdempotent({
      prompt: "Create an influential test playlist",
      brief: curatedBrief,
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey,
      reuseDays: 0,
      rateLimit: 10,
      globalLimit: 100,
    });

    const created = await create();
    expect(created).toMatchObject({ created: true, reused: false, status: "queued" });
    const originalRoute = await repository.getResearchCheckpoint(created.runId, "fast:route:fast_curated_v1") as any;
    expect(originalRoute).toMatchObject({ status: "queued", profile: "fast_curated_v1", matchingReserveMs: 40_000 });
    expect(Date.parse(originalRoute.deadlineAt) - Date.parse(originalRoute.confirmedAt)).toBe(120_000);
    expect(Date.parse(originalRoute.deadlineAt) - Date.parse(originalRoute.researchDeadlineAt)).toBe(40_000);
    const createdRun = await repository.getRun(created.runId);
    expect(originalRoute.confirmedAt).toBe(createdRun.createdAt);

    const retry = await create();
    expect(retry).toMatchObject({
      runId: created.runId,
      accessId: created.accessId,
      created: false,
      reused: false,
    });
    await expect(repository.getResearchCheckpoint(created.runId, "fast:route:fast_curated_v1"))
      .resolves.toEqual(originalRoute);

    // This represents a legacy run created before route checkpoints existed.
    // An idempotent retry may repair its queue handoff, but must remain deep.
    await repository.pool.query(
      "DELETE FROM research_checkpoints WHERE run_id=$1 AND phase='fast:route:fast_curated_v1'",
      [created.runId],
    );
    await create();
    await expect(repository.getResearchCheckpoint(created.runId, "fast:route:fast_curated_v1"))
      .resolves.toBeNull();
  });

  test("serializes global active-run admission across different client buckets", async () => {
    const create = (label: string) => {
      const bucket = `global-capacity-${label}-${randomUUID()}`;
      return repository.createRunIdempotent({
        prompt: `Global capacity request ${label}`,
        brief: { ...brief, title: `Global capacity ${label}` },
        estimateUsd: 0,
        approvedBudgetUsd: 1,
        clientBucket: bucket,
        clientBucketAliases: [bucket],
        idempotencyKey: `global-${label}-${randomUUID()}`,
        reuseDays: 0,
        rateLimit: 10,
        globalLimit: 1,
      });
    };
    const results = await Promise.allSettled([create("left"), create("right")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { statusCode: 503, code: "global_capacity_reached" },
    });
    const active = await repository.pool.query<{ count: number }>(
      `SELECT count(*)::int count FROM research_runs
       WHERE status IN ('queued','awaiting_budget','researching','ready_for_matching','matching','review','visitor_review','manifest_ready','publishing','waiting_for_apple_authorization')
         AND deleted_at IS NULL`,
    );
    expect(active.rows[0]?.count).toBe(1);
  });

  test("reconciliation expands within ceilings and durably pauses a true provider overrun", async () => {
    vi.stubEnv("APP_MONTHLY_COST_LIMIT_USD", "100");
    const withinRunId = await repository.createRun("Reconciliation expansion test", brief, 0, 1);
    const within = await repository.reserveProviderCost({ runId: withinRunId }, "within-ceilings", 0.25);
    await expect(repository.reconcileProviderCost(within.reservationId, 0.4, { total_tokens: 1 })).resolves.toBeUndefined();
    const withinRun = await repository.getRun(withinRunId);
    expect(withinRun.actualCostUsd).toBeCloseTo(0.4, 6);
    expect(withinRun.reservedCostUsd).toBe(0);
    expect(withinRun.status).not.toBe("awaiting_budget");

    const overrunRunId = await repository.createRun("Reconciliation overrun test", brief, 0, 0.5);
    const overrun = await repository.reserveProviderCost({ runId: overrunRunId }, "cross-run-ceiling", 0.4);
    await expect(repository.reconcileProviderCost(overrun.reservationId, 0.75, { total_tokens: 2 }))
      .rejects.toMatchObject({ statusCode: 402, code: "provider_cost_overrun" });
    const paused = await repository.getRun(overrunRunId);
    expect(paused).toMatchObject({ status: "awaiting_budget", reservedCostUsd: 0 });
    expect(paused.actualCostUsd).toBeCloseTo(0.75, 6);
    await expect(repository.reconcileProviderCost(overrun.reservationId, 0.75, { total_tokens: 2 })).resolves.toBeUndefined();
    const ledger = await repository.pool.query("SELECT count(*)::int count FROM cost_ledger WHERE reservation_id=$1", [overrun.reservationId]);
    expect(ledger.rows[0].count).toBe(1);
  });

  test("a renewed budget pause receives a fresh seven-day approval window", async () => {
    const runId = await repository.createRun("Renewed budget test", brief, 0, 1);
    await repository.updateRun(runId, { status: "awaiting_budget", phase: "track_verification" });
    const paused = (await repository.listAwaitingBudgets()).find((item) => item.id === runId);
    expect(paused).toBeDefined();
    const expiry = Date.parse(paused.expiresAt);
    expect(expiry).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1_000);
    expect(expiry).toBeLessThan(Date.now() + 8 * 24 * 60 * 60 * 1_000);
  });

  test("renews owned leases, reclaims expired work, and terminates exhausted leases", async () => {
    vi.stubEnv("WORKER_CONCURRENCY", "2");
    const queued = await repository.enqueueJob({ kind: "integration", payload: { stable: true }, dedupeKey: randomUUID(), maxAttempts: 3 });
    const firstLease = await repository.leaseNextJob("worker-a", 30_000);
    expect(firstLease).toMatchObject({ id: queued.id, leaseOwner: "worker-a", attempts: 1 });
    await expect(repository.renewJobLease(queued.id, "worker-b", 30_000)).resolves.toBe(false);
    await expect(repository.renewJobLease(queued.id, "worker-a", 30_000)).resolves.toBe(true);

    await repository.pool.query("UPDATE job_queue SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [queued.id]);
    const reclaimed = await repository.leaseNextJob("worker-b", 30_000);
    expect(reclaimed).toMatchObject({ id: queued.id, leaseOwner: "worker-b", attempts: 2 });
    await expect(repository.completeJob(queued.id, "worker-a")).rejects.toMatchObject({ code: "job_lease_lost" });
    await repository.completeJob(queued.id, "worker-b");

    const runId = await repository.createRun("Exhausted lease test", brief, 0, 1);
    const finalDedupeKey = randomUUID();
    const finalAttempt = await repository.enqueueJob({ kind: "research", runId, dedupeKey: finalDedupeKey, maxAttempts: 1 });
    expect(await repository.leaseNextJob("worker-final", 30_000)).toMatchObject({ id: finalAttempt.id, attempts: 1 });
    await repository.pool.query("UPDATE job_queue SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [finalAttempt.id]);
    await expect(repository.leaseNextJob("worker-next", 30_000)).resolves.toBeNull();
    const [job, run] = await Promise.all([
      repository.pool.query<{ status: string }>("SELECT status FROM job_queue WHERE id=$1", [finalAttempt.id]),
      repository.getRun(runId),
    ]);
    expect(job.rows[0]?.status).toBe("failed");
    expect(run.status).toBe("failed");

    const requeued = await repository.enqueueJob({
      kind: "research",
      runId,
      dedupeKey: finalDedupeKey,
      payload: { safeRetry: true },
      maxAttempts: 3,
    });
    expect(requeued).toMatchObject({ id: finalAttempt.id, created: false });
    const revived = await repository.pool.query<{ status: string; attempts: number; max_attempts: number; payload_json: Record<string, unknown> }>(
      "SELECT status,attempts,max_attempts,payload_json FROM job_queue WHERE id=$1",
      [finalAttempt.id],
    );
    expect(revived.rows[0]).toMatchObject({ status: "queued", attempts: 0, max_attempts: 3, payload_json: { safeRetry: true } });
  });

  test("reserves one worker slot from deep research while prioritizing exact fast jobs", async () => {
    vi.stubEnv("WORKER_CONCURRENCY", "2");
    const deepResearch = await repository.enqueueJob({
      kind: "research",
      payload: { route: "deep" },
      dedupeKey: randomUUID(),
    });
    const deepMatching = await repository.enqueueJob({
      kind: "matching",
      payload: { fast: "true" },
      dedupeKey: randomUUID(),
    });
    const fastResearch = await repository.enqueueJob({
      kind: "research",
      payload: { fast: true },
      dedupeKey: randomUUID(),
    });

    const fastLease = await repository.leaseNextJob("qos-fast", 60_000);
    expect(fastLease).toMatchObject({ id: fastResearch.id, payload: { fast: true } });

    const deepLease = await repository.leaseNextJob("qos-deep-one", 60_000);
    expect([deepResearch.id, deepMatching.id]).toContain(deepLease?.id);
    await repository.completeJob(fastLease!.id, "qos-fast");

    await expect(repository.leaseNextJob("qos-reserved", 60_000)).resolves.toBeNull();
    await repository.completeJob(deepLease!.id, "qos-deep-one");

    const remainingDeep = await repository.leaseNextJob("qos-deep-two", 60_000);
    expect([deepResearch.id, deepMatching.id]).toContain(remainingDeep?.id);
    expect(remainingDeep?.id).not.toBe(deepLease?.id);
    await repository.completeJob(remainingDeep!.id, "qos-deep-two");
  });

  test("promotes operational work after a bounded fast-lane wait", async () => {
    vi.stubEnv("WORKER_CONCURRENCY", "2");
    const freshOperational = await repository.enqueueJob({
      kind: "notification",
      payload: { event: "fresh" },
      dedupeKey: randomUUID(),
    });
    const firstFast = await repository.enqueueJob({
      kind: "research",
      payload: { fast: true },
      dedupeKey: randomUUID(),
    });

    const prioritizedFast = await repository.leaseNextJob("fairness-fast", 60_000);
    expect(prioritizedFast).toMatchObject({ id: firstFast.id });
    await repository.completeJob(prioritizedFast!.id, "fairness-fast");
    const freshLease = await repository.leaseNextJob("fairness-fresh-operation", 60_000);
    expect(freshLease).toMatchObject({ id: freshOperational.id });
    await repository.completeJob(freshLease!.id, "fairness-fresh-operation");

    const agedOperational = await repository.enqueueJob({
      kind: "publication",
      payload: { manifestId: randomUUID() },
      dedupeKey: randomUUID(),
    });
    await repository.pool.query(
      "UPDATE job_queue SET available_at=now()-interval '31 seconds' WHERE id=$1",
      [agedOperational.id],
    );
    const secondFast = await repository.enqueueJob({
      kind: "matching",
      payload: { fast: true },
      dedupeKey: randomUUID(),
    });

    const promotedOperation = await repository.leaseNextJob("fairness-promoted-operation", 60_000);
    expect(promotedOperation).toMatchObject({ id: agedOperational.id });
    await repository.completeJob(promotedOperation!.id, "fairness-promoted-operation");
    const remainingFast = await repository.leaseNextJob("fairness-remaining-fast", 60_000);
    expect(remainingFast).toMatchObject({ id: secondFast.id });
    await repository.completeJob(remainingFast!.id, "fairness-remaining-fast");
  });

  test("refuses an interrupted matching manifest and explicitly accounts for every verified-only candidate", async () => {
    const runId = await repository.createRun("Manifest accounting invariant", brief, 0, 1);
    const sourceUrl = `https://credits.example/${randomUUID()}`;
    const sourceIds = await repository.addSources(runId, [{
      url: sourceUrl,
      title: "Track-level verification",
      sourceClass: "web",
      provenanceRoot: "credits.example",
      note: "A bounded integration-test source.",
    }]);
    const candidateTitles = [
      "Accepted Recording",
      "Unavailable Recording",
      "Review Recording",
      "Duplicate Recording",
      "Unsupported Recording",
      "Evidence-Ineligible Recording",
    ];
    const citations = new Map(candidateTitles.map((title) => [title, citationFixture(sourceUrl, title, "performed on")]));
    await repository.addCitationAttestations(runId, [...citations.values()].map((item) => item.attestation));
    await repository.addCandidates(runId, candidateTitles.map((title) => ({
      artist: "Manifest Artist",
      title,
      album: "Manifest Album",
      releaseYear: 2024,
      durationMs: 180_000,
      isrc: null,
      musicbrainzId: null,
      versionLabel: null,
      evidence: [{
        sourceUrl,
        state: title === "Evidence-Ineligible Recording" ? "inferred" as const : "verified" as const,
        supportScope: "track" as const,
        ...evidenceBinding,
        relationship: "performed on",
        note: "Track-level test evidence.",
        citationSupport: citations.get(title)!.support,
      }],
    })), sourceIds, "track_verification");
    const candidates = new Map((await repository.listCandidates(runId)).map((candidate) => [candidate.title, candidate]));
    const candidate = (title: string) => {
      const found = candidates.get(title);
      if (!found) throw new Error(`Missing test candidate ${title}`);
      return found;
    };
    const song = (id: string, name: string) => ({
      id,
      name,
      artistName: "Manifest Artist",
      albumName: "Manifest Album",
      releaseDate: "2024-01-01",
      durationInMillis: 180_000,
    });

    await repository.saveMatch(runId, {
      candidateId: candidate("Accepted Recording").id,
      status: "accepted",
      basis: "Exact compatible identifier",
      score: 1,
      song: song("catalog-accepted", "Accepted Recording"),
      alternatives: [],
    });
    await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review" });
    await expect(repository.createManifest(runId, { verifiedOnly: true }))
      .rejects.toMatchObject({ code: "matching_incomplete" });
    expect((await repository.pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM manifests WHERE run_id=$1",
      [runId],
    )).rows[0]?.count).toBe(0);

    await repository.saveMatch(runId, {
      candidateId: candidate("Unavailable Recording").id,
      status: "unavailable",
      basis: "No compatible catalog result",
      score: 0,
      song: null,
      alternatives: [],
    });
    await repository.saveMatch(runId, {
      candidateId: candidate("Review Recording").id,
      status: "review",
      basis: "Ambiguous compatible results",
      score: 0.8,
      song: song("catalog-review", "Review Recording"),
      alternatives: [],
    });
    await repository.saveMatch(runId, {
      candidateId: candidate("Duplicate Recording").id,
      status: "duplicate",
      basis: "Stable catalog ID was already accepted",
      score: 1,
      song: song("catalog-accepted", "Accepted Recording"),
      alternatives: [],
    });
    await repository.saveMatch(runId, {
      candidateId: candidate("Unsupported Recording").id,
      status: "unsupported",
      basis: "The storefront does not support this recording",
      score: 0,
      song: null,
      alternatives: [],
    });
    await repository.saveMatch(runId, {
      candidateId: candidate("Evidence-Ineligible Recording").id,
      status: "accepted",
      basis: "Exact metadata match but insufficient evidence",
      score: 1,
      song: song("catalog-ineligible", "Evidence-Ineligible Recording"),
      alternatives: [],
    });

    await expect(repository.createManifest(runId)).rejects.toMatchObject({ code: "unresolved_exceptions" });
    const manifest = await repository.createManifest(runId, { verifiedOnly: true });
    expect(manifest.tracks).toEqual([
      expect.objectContaining({ candidateId: candidate("Accepted Recording").id, catalogId: "catalog-accepted" }),
    ]);
    const accounted = await repository.pool.query<{ title: string; outcome: string; match_status: string }>(
      `SELECT c.title,c.outcome,m.status match_status FROM track_candidates c
       JOIN catalog_matches m ON m.candidate_id=c.id AND m.run_id=c.run_id
       WHERE c.run_id=$1 ORDER BY c.title`,
      [runId],
    );
    expect(accounted.rows).toEqual([
      { title: "Accepted Recording", outcome: "accepted", match_status: "accepted" },
      { title: "Duplicate Recording", outcome: "duplicate", match_status: "duplicate" },
      { title: "Evidence-Ineligible Recording", outcome: "unsupported", match_status: "unsupported" },
      { title: "Review Recording", outcome: "rejected", match_status: "rejected" },
      { title: "Unavailable Recording", outcome: "unavailable", match_status: "unavailable" },
      { title: "Unsupported Recording", outcome: "unsupported", match_status: "unsupported" },
    ]);
    expect(accounted.rows.every((row) => ["accepted", "unavailable", "rejected", "duplicate", "unsupported"].includes(row.outcome))).toBe(true);
  });

  test("curated manifests deterministically cap tracks and account for overflow", async () => {
    const curatedBrief: PlaylistBrief = {
      ...brief,
      title: "Curated cap",
      mode: "curated",
      orderingPolicy: "artist/title",
      targetSize: { min: 1, max: 2 },
    };
    const runId = await repository.createRun("Curated overflow", curatedBrief, 0, 1);
    const sourceUrl = `https://editorial.example/${randomUUID()}`;
    const sourceIds = await repository.addSources(runId, [{
      url: sourceUrl,
      title: "Editorial source",
      sourceClass: "web",
      provenanceRoot: "editorial.example",
      note: "Track-specific curated evidence.",
    }]);
    const titles = ["Gamma", "Alpha", "Beta"];
    const citations = new Map(titles.map((title) => [title, citationFixture(sourceUrl, title, "primary artist")]));
    await repository.addCitationAttestations(runId, [...citations.values()].map((item) => item.attestation));
    await repository.addCandidates(runId, titles.map((title) => ({
      artist: "Curated Artist",
      title,
      album: "Curated Album",
      releaseYear: 2024,
      durationMs: 180_000,
      isrc: null,
      musicbrainzId: null,
      versionLabel: null,
      evidence: [{
        sourceUrl,
        state: "verified" as const,
        supportScope: "track" as const,
        ...evidenceBinding,
        relationship: "primary artist",
        note: "Track-specific support.",
        citationSupport: citations.get(title)!.support,
      }],
    })), sourceIds, "track_verification");
    const candidates = await repository.listCandidates(runId);
    for (const candidate of candidates) {
      await repository.saveMatch(runId, {
        candidateId: candidate.id,
        status: "accepted",
        basis: "Exact compatible match",
        score: 1,
        song: {
          id: `catalog-${candidate.title.toLowerCase()}`,
          name: candidate.title,
          artistName: candidate.artist,
          albumName: candidate.album ?? "",
        },
        alternatives: [],
      });
    }
    const gamma = candidates.find((candidate) => candidate.title === "Gamma")!;
    await repository.saveMatch(runId, {
      candidateId: gamma.id,
      status: "review",
      basis: "Retry observed ambiguous metadata",
      score: 0.7,
      song: { id: "catalog-gamma-alternate", name: "Gamma (Alternate)", artistName: gamma.artist, albumName: "Curated Album" },
      alternatives: [],
    });
    await repository.saveMatch(runId, {
      candidateId: gamma.id,
      status: "accepted",
      basis: "Retry restored exact compatible match",
      score: 1,
      song: { id: "catalog-gamma", name: gamma.title, artistName: gamma.artist, albumName: "Curated Album" },
      alternatives: [],
    });
    await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review" });

    const manifest = await repository.createManifest(runId);
    expect(manifest.tracks.map((track) => track.title)).toEqual(["Alpha", "Beta"]);
    const outcomes = await repository.pool.query<{
      title: string;
      outcome: string;
      status: string;
      basis: string;
      initial_status: string;
      initial_catalog_id: string;
      initial_basis: string;
    }>(
      `SELECT c.title,c.outcome,m.status,m.basis,m.initial_status,m.initial_catalog_id,m.initial_basis FROM track_candidates c
       JOIN catalog_matches m ON m.candidate_id=c.id WHERE c.run_id=$1 ORDER BY c.title`,
      [runId],
    );
    expect(outcomes.rows).toEqual([
      expect.objectContaining({ title: "Alpha", outcome: "accepted", status: "accepted" }),
      expect.objectContaining({ title: "Beta", outcome: "accepted", status: "accepted" }),
      expect.objectContaining({
        title: "Gamma",
        outcome: "overflow",
        status: "overflow",
        basis: expect.stringContaining("target maximum of 2"),
        initial_status: "accepted",
        initial_catalog_id: "catalog-gamma",
        initial_basis: "Exact compatible match",
      }),
    ]);
  });

  test("curated influence manifests preserve the fast research selection rank", async () => {
    const rankedBrief: PlaylistBrief = {
      ...brief,
      title: "Ranked curated order",
      mode: "curated",
      orderingPolicy: "influence rank",
      targetSize: { min: 1, max: 3 },
    };
    const runId = await repository.createRun("Ranked curated order", rankedBrief, 0, 1);
    await repository.addCandidates(runId, [
      { selectionRank: 3, artist: "Ranked Artist", title: "Third", album: null, releaseYear: null, durationMs: null, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [] },
      { selectionRank: 1, artist: "Ranked Artist", title: "First", album: null, releaseYear: null, durationMs: null, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [] },
      { selectionRank: 2, artist: "Ranked Artist", title: "Second", album: null, releaseYear: null, durationMs: null, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [] },
    ], new Map(), "unverified");
    const candidates = await repository.listCandidates(runId);
    for (const candidate of candidates) {
      await repository.saveMatch(runId, {
        candidateId: candidate.id,
        status: "accepted",
        basis: "Exact compatible match",
        score: 1,
        song: { id: `catalog-${candidate.title.toLowerCase()}`, name: candidate.title, artistName: candidate.artist, albumName: "" },
        alternatives: [],
      });
    }
    await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review" });
    const manifest = await repository.createManifest(runId);
    expect(manifest.tracks.map((track) => track.title)).toEqual(["First", "Second", "Third"]);
  });

  test("lists every catalog row in manifest order and atomically locks a bulk visitor selection", async () => {
    const selectionBrief: PlaylistBrief = {
      ...brief,
      title: "Bulk catalog selection",
      mode: "curated",
      orderingPolicy: "influence rank",
      targetSize: { min: 1, max: 10 },
    };
    const runId = await repository.createRun("Bulk catalog selection", selectionBrief, 0, 1);
    await repository.addCandidates(runId, [
      { selectionRank: 4, artist: "Bulk Artist", title: "Unavailable", album: "Bulk Album", releaseYear: 2024, durationMs: 180_000, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [] },
      { selectionRank: 2, artist: "Bulk Artist", title: "Override", album: "Bulk Album", releaseYear: 2024, durationMs: 180_000, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [] },
      { selectionRank: 1, artist: "Bulk Artist", title: "Recommended", album: "Bulk Album", releaseYear: 2024, durationMs: 180_000, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [] },
      { selectionRank: 3, artist: "Bulk Artist", title: "Unchecked", album: "Bulk Album", releaseYear: 2024, durationMs: 180_000, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [] },
    ], new Map(), "unverified");
    const candidates = new Map((await repository.listCandidates(runId)).map((candidate) => [candidate.title, candidate]));
    const catalogSong = (id: string, name: string) => ({
      id,
      name,
      artistName: "Bulk Artist",
      albumName: "Bulk Album",
      releaseDate: "2024-01-01",
      durationInMillis: 180_000,
    });
    await repository.saveMatch(runId, {
      candidateId: candidates.get("Recommended")!.id,
      status: "accepted",
      basis: "Unique exact metadata",
      score: 1,
      song: catalogSong("catalog-recommended", "Recommended"),
      alternatives: [],
    });
    await repository.saveMatch(runId, {
      candidateId: candidates.get("Override")!.id,
      status: "review",
      basis: "Two plausible versions",
      score: 0.8,
      song: catalogSong("catalog-override-default", "Override"),
      alternatives: [catalogSong("catalog-override-selected", "Override (Selected Version)")],
    });
    await repository.saveMatch(runId, {
      candidateId: candidates.get("Unchecked")!.id,
      status: "review",
      basis: "Visitor decision required",
      score: 0.7,
      song: catalogSong("catalog-unchecked", "Unchecked"),
      alternatives: [],
    });
    await repository.saveMatch(runId, {
      candidateId: candidates.get("Unavailable")!.id,
      status: "unavailable",
      basis: "No compatible catalog result",
      score: 0,
      song: null,
      alternatives: [catalogSong("catalog-unrelated", "Different Song")],
    });
    await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review" });

    const page = await repository.listCatalogTracks(runId, 1, 200);
    expect(page).toMatchObject({
      total: 4,
      pageSize: 200,
      selectableCount: 3,
      unmatchedCount: 1,
      retryableCount: 0,
      matchingComplete: true,
    });
    expect(page.items.map((item) => item.title)).toEqual(["Recommended", "Override", "Unchecked", "Unavailable"]);
    expect(page.items.map((item) => item.position)).toEqual([0, 1, 2, 3]);
    expect(page.items[1]).toMatchObject({
      status: "review",
      catalogId: "catalog-override-default",
      song: { id: "catalog-override-default" },
      alternatives: [{ id: "catalog-override-selected" }],
      selectable: true,
    });
    expect(page.items[3]).toMatchObject({
      status: "unavailable",
      song: null,
      alternatives: [{ id: "catalog-unrelated" }],
      selectable: false,
    });

    await expect(repository.finalizeCatalogSelection(runId, {
      selected: [{ candidateId: candidates.get("Override")!.id, catalogId: "catalog-not-returned" }],
    })).rejects.toMatchObject({ code: "catalog_match_not_permitted" });
    await expect(repository.finalizeCatalogSelection(runId, {
      selected: [{ candidateId: candidates.get("Unavailable")!.id, catalogId: "catalog-unrelated" }],
    })).rejects.toMatchObject({ code: "catalog_match_not_permitted" });
    await repository.reviewMatch(runId, candidates.get("Unchecked")!.id, "rejected");
    const rejectedPage = await repository.listCatalogTracks(runId, 1, 200);
    expect(rejectedPage.items.find((item) => item.title === "Unchecked")).toMatchObject({
      status: "rejected",
      selected: false,
      selectable: true,
    });
    const manifest = await repository.finalizeCatalogSelection(runId, {
      useRecommended: true,
      excludedCandidateIds: [],
      overrides: [{ candidateId: candidates.get("Override")!.id, catalogId: "catalog-override-selected" }],
    });
    expect(manifest.tracks.map((track) => [track.title, track.catalogId])).toEqual([
      ["Recommended", "catalog-recommended"],
      ["Override", "catalog-override-selected"],
    ]);
    const outcomes = await repository.pool.query<{ title: string; status: string; outcome: string }>(
      `SELECT c.title,m.status,c.outcome FROM track_candidates c
       JOIN catalog_matches m ON m.candidate_id=c.id WHERE c.run_id=$1 ORDER BY c.selection_rank`,
      [runId],
    );
    expect(outcomes.rows).toEqual([
      { title: "Recommended", status: "accepted", outcome: "accepted" },
      { title: "Override", status: "accepted", outcome: "accepted" },
      { title: "Unchecked", status: "rejected", outcome: "rejected" },
      { title: "Unavailable", status: "unavailable", outcome: "unavailable" },
    ]);
  });

  test("queues one durable recovery job for legacy fast-match timeout rows", async () => {
    const runId = await repository.createRun("Catalog recovery", brief, 0, 1);
    await repository.addCandidates(runId, [{
      artist: "Recovery Artist",
      title: "Recovery Track",
      album: null,
      releaseYear: null,
      durationMs: null,
      isrc: null,
      musicbrainzId: null,
      versionLabel: null,
      evidence: [],
    }], new Map(), "unverified");
    const candidate = (await repository.listCandidates(runId))[0]!;
    await repository.saveTimeoutMatches(
      runId,
      [candidate.id],
      "Apple catalog lookup did not complete inside the absolute fast-run window",
    );
    await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review" });

    await expect(repository.listCatalogTracks(runId, 1, 200)).resolves.toMatchObject({
      retryableCount: 1,
      unmatchedCount: 1,
      matchingComplete: false,
    });
    await expect(repository.queueCatalogRecovery(runId, "us")).resolves.toEqual({
      queued: true,
      state: "queued",
      retryableCount: 1,
    });
    await expect(repository.queueCatalogRecovery(runId, "us")).resolves.toEqual({
      queued: false,
      state: "in_flight",
      retryableCount: 1,
    });
    const job = await repository.pool.query<{ payload_json: Record<string, unknown>; status: string; max_attempts: number }>(
      "SELECT payload_json,status,max_attempts FROM job_queue WHERE run_id=$1 AND kind='matching'",
      [runId],
    );
    expect(job.rows).toEqual([{
      payload_json: expect.objectContaining({ runId, storefront: "us", retryIncomplete: true, recoveryGeneration: 1 }),
      status: "queued",
      max_attempts: 1,
    }]);
  });

  test("a failed first recovery remains retryable and queues generation two", async () => {
    const runId = await repository.createRun("Retry recovery generation", brief, 0, 1);
    await repository.addCandidates(runId, [{
      artist: "Recovery Artist", title: "Retry Track", album: null, releaseYear: null,
      durationMs: null, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [],
    }], new Map(), "unverified");
    const candidate = (await repository.listCandidates(runId))[0]!;
    await repository.saveTimeoutMatches(runId, [candidate.id], RETRYABLE_CATALOG_MATCH_BASES[0]);
    await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review" });
    await repository.queueCatalogRecovery(runId, "us");
    const leased = await repository.pool.query<{ id: string }>(
      `UPDATE job_queue SET status='leased',lease_owner='generation-one',attempts=max_attempts,
         lease_expires_at=now()+interval '5 minutes'
       WHERE run_id=$1 AND status='queued' AND payload_json->>'recoveryGeneration'='1' RETURNING id`,
      [runId],
    );
    await repository.failJob(leased.rows[0]!.id, "generation-one", "catalog failure", null);

    const afterFailure = await repository.listCatalogTracks(runId, 1, 200);
    expect(afterFailure).toMatchObject({ retryableCount: 1, matchingComplete: false });
    expect(afterFailure.items[0]).toMatchObject({ retryable: true, basis: RETRYABLE_CATALOG_MATCH_BASES[0] });
    await expect(repository.queueCatalogRecovery(runId, "us")).resolves.toEqual({
      queued: true, state: "queued", retryableCount: 1,
    });
    const generations = await repository.pool.query<{ generation: string; status: string }>(
      `SELECT payload_json->>'recoveryGeneration' generation,status FROM job_queue
       WHERE run_id=$1 AND payload_json->>'retryIncomplete'='true' ORDER BY created_at`,
      [runId],
    );
    expect(generations.rows).toEqual([
      { generation: "1", status: "failed" },
      { generation: "2", status: "queued" },
    ]);
  });

  test("reopens a prematurely terminalized generation-one row and normalizes its JSON", async () => {
    const runId = await repository.createRun("Legacy terminal recovery", brief, 0, 1);
    await repository.addCandidates(runId, [{
      artist: "Recovery Artist", title: "Legacy Terminal Track", album: null, releaseYear: null,
      durationMs: null, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [],
    }], new Map(), "unverified");
    const candidate = (await repository.listCandidates(runId))[0]!;
    await repository.saveTimeoutMatches(runId, [candidate.id], RETRYABLE_CATALOG_MATCH_BASES[0]);
    await repository.pool.query(
      "UPDATE catalog_matches SET basis=$2,alternatives_json='{}'::jsonb WHERE run_id=$1",
      [runId, CATALOG_RECOVERY_UNRESOLVED_BASIS],
    );
    const prior = await repository.enqueueJob({
      kind: "matching", runId,
      payload: { runId, storefront: "us", retryIncomplete: true, recoveryGeneration: 1 },
      dedupeKey: `matching-recovery:${runId}:1`, maxAttempts: 1,
    });
    await repository.pool.query("UPDATE job_queue SET status='failed',completed_at=now() WHERE id=$1", [prior.id]);
    await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review" });

    const before = await repository.listCatalogTracks(runId, 1, 200);
    expect(before).toMatchObject({ retryableCount: 1, matchingComplete: false });
    expect(before.items[0]).toMatchObject({ retryable: true, basis: CATALOG_RECOVERY_UNRESOLVED_BASIS });
    await expect(repository.queueCatalogRecovery(runId, "us")).resolves.toMatchObject({ queued: true });
    const reopened = await repository.pool.query<{ basis: string; kind: string }>(
      "SELECT basis,jsonb_typeof(alternatives_json) kind FROM catalog_matches WHERE run_id=$1",
      [runId],
    );
    expect(reopened.rows).toEqual([{ basis: RETRYABLE_CATALOG_MATCH_BASES[0], kind: "array" }]);
  });

  test("generation three terminalizes remaining catalog rows", async () => {
    const runId = await repository.createRun("Terminal recovery generation", brief, 0, 1);
    await repository.addCandidates(runId, [{
      artist: "Recovery Artist", title: "Terminal Track", album: null, releaseYear: null,
      durationMs: null, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [],
    }], new Map(), "unverified");
    const candidate = (await repository.listCandidates(runId))[0]!;
    await repository.saveTimeoutMatches(runId, [candidate.id], RETRYABLE_CATALOG_MATCH_BASES[0]);
    await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review" });

    for (let generation = 1; generation <= 3; generation += 1) {
      await repository.queueCatalogRecovery(runId, "us");
      const leased = await repository.pool.query<{ id: string }>(
        `UPDATE job_queue SET status='leased',lease_owner=$2,attempts=max_attempts,
           lease_expires_at=now()+interval '5 minutes'
         WHERE run_id=$1 AND status='queued' AND payload_json->>'recoveryGeneration'=$3 RETURNING id`,
        [runId, `generation-${generation}`, String(generation)],
      );
      await repository.failJob(leased.rows[0]!.id, `generation-${generation}`, "catalog failure", null);
    }
    const terminal = await repository.listCatalogTracks(runId, 1, 200);
    expect(terminal).toMatchObject({ retryableCount: 0, matchingComplete: true });
    expect(terminal.items[0]).toMatchObject({
      retryable: false,
      basis: CATALOG_RECOVERY_UNRESOLVED_BASIS,
    });
    await expect(repository.queueCatalogRecovery(runId, "us")).resolves.toEqual({
      queued: false, state: "ready", retryableCount: 0,
    });
  });

  test("does not queue recovery while the original matching job is still active", async () => {
    const runId = await repository.createRun("Concurrent catalog recovery", brief, 0, 1);
    await repository.addCandidates(runId, [{
      artist: "Recovery Artist",
      title: "Still Matching",
      album: null,
      releaseYear: null,
      durationMs: null,
      isrc: null,
      musicbrainzId: null,
      versionLabel: null,
      evidence: [],
    }], new Map(), "unverified");
    const candidate = (await repository.listCandidates(runId))[0]!;
    await repository.saveTimeoutMatches(runId, [candidate.id], RETRYABLE_CATALOG_MATCH_BASES[0]);
    await repository.enqueueJob({
      kind: "matching",
      runId,
      payload: { runId, storefront: "us" },
      dedupeKey: `matching-active:${runId}`,
    });
    await repository.updateRun(runId, { status: "matching", phase: "catalog_matching" });

    await expect(repository.queueCatalogRecovery(runId, "us")).rejects.toMatchObject({
      code: "catalog_recovery_not_ready",
    });
    const jobs = await repository.pool.query<{ recovery: boolean }>(
      `SELECT COALESCE(payload_json->>'retryIncomplete'='true',false) recovery
       FROM job_queue WHERE run_id=$1 AND kind='matching'`,
      [runId],
    );
    expect(jobs.rows).toEqual([{ recovery: false }]);
  });

  test("bulk generation publishes matched tracks even when a bounded recovery leaves timeout rows", async () => {
    const runId = await repository.createRun("Partial catalog recovery", brief, 0, 1);
    await repository.addCandidates(runId, [
      {
        artist: "Recovery Artist",
        title: "Matched Track",
        album: null,
        releaseYear: null,
        durationMs: null,
        isrc: null,
        musicbrainzId: null,
        versionLabel: null,
        evidence: [],
      },
      {
        artist: "Recovery Artist",
        title: "Timed-out Track",
        album: null,
        releaseYear: null,
        durationMs: null,
        isrc: null,
        musicbrainzId: null,
        versionLabel: null,
        evidence: [],
      },
    ], new Map(), "unverified");
    const candidates = new Map((await repository.listCandidates(runId)).map((candidate) => [candidate.title, candidate]));
    await repository.saveMatch(runId, {
      candidateId: candidates.get("Matched Track")!.id,
      status: "accepted",
      basis: "Unique exact metadata",
      score: 1,
      song: { id: "catalog-matched", name: "Matched Track", artistName: "Recovery Artist", albumName: "" },
      alternatives: [],
    });
    await repository.saveTimeoutMatches(
      runId,
      [candidates.get("Timed-out Track")!.id],
      RETRYABLE_CATALOG_MATCH_BASES[0],
    );
    await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review" });

    const manifest = await repository.finalizeCatalogSelection(runId, {
      useRecommended: true,
      excludedCandidateIds: [],
      overrides: [],
    });
    expect(manifest.tracks).toEqual([
      expect.objectContaining({ title: "Matched Track", catalogId: "catalog-matched" }),
    ]);
    const outcomes = await repository.pool.query<{ title: string; status: string }>(
      `SELECT c.title,m.status FROM track_candidates c
       JOIN catalog_matches m ON m.candidate_id=c.id WHERE c.run_id=$1 ORDER BY c.title`,
      [runId],
    );
    expect(outcomes.rows).toEqual([
      { title: "Matched Track", status: "accepted" },
      { title: "Timed-out Track", status: "rejected" },
    ]);
  });

  test("exhausted catalog recovery returns unresolved rows to review without stranding matched tracks", async () => {
    const runId = await repository.createRun("Recoverable catalog failure", brief, 0, 1);
    await repository.addCandidates(runId, [
      {
        artist: "Recovery Artist",
        title: "Already Matched",
        album: null,
        releaseYear: null,
        durationMs: null,
        isrc: null,
        musicbrainzId: null,
        versionLabel: null,
        evidence: [],
      },
      {
        artist: "Recovery Artist",
        title: "Still Unresolved",
        album: null,
        releaseYear: null,
        durationMs: null,
        isrc: null,
        musicbrainzId: null,
        versionLabel: null,
        evidence: [],
      },
    ], new Map(), "unverified");
    const candidates = new Map((await repository.listCandidates(runId)).map((candidate) => [candidate.title, candidate]));
    await repository.saveMatch(runId, {
      candidateId: candidates.get("Already Matched")!.id,
      status: "accepted",
      basis: "Unique exact metadata",
      score: 1,
      song: {
        id: "catalog-ready",
        name: "Already Matched",
        artistName: "Recovery Artist",
        albumName: "",
      },
      alternatives: [],
    });
    await repository.saveTimeoutMatches(
      runId,
      [candidates.get("Still Unresolved")!.id],
      RETRYABLE_CATALOG_MATCH_BASES[0],
    );
    await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review" });
    for (let generation = 1; generation <= 3; generation += 1) {
      await repository.queueCatalogRecovery(runId, "us");
      const job = await repository.pool.query<{ id: string }>(
        `UPDATE job_queue SET status='leased',lease_owner=$2,attempts=max_attempts,
           lease_expires_at=now()+interval '5 minutes'
         WHERE run_id=$1 AND kind='matching' AND status='queued'
           AND payload_json->>'recoveryGeneration'=$3 RETURNING id`,
        [runId, `recovery-test-${generation}`, String(generation)],
      );
      await repository.failJob(
        job.rows[0]!.id,
        `recovery-test-${generation}`,
        "Apple remained unavailable",
        null,
      );
    }

    await expect(repository.getRun(runId)).resolves.toMatchObject({
      status: "visitor_review",
      phase: "exception_review",
      error: null,
    });
    const page = await repository.listCatalogTracks(runId, 1, 200);
    expect(page).toMatchObject({
      selectableCount: 1,
      retryableCount: 0,
      matchingComplete: true,
    });
    expect(page.items.find((item) => item.title === "Still Unresolved")).toMatchObject({
      status: "review",
      basis: CATALOG_RECOVERY_UNRESOLVED_BASIS,
      selectable: false,
      retryable: false,
    });
    const manifest = await repository.finalizeCatalogSelection(runId, {
      useRecommended: true,
      excludedCandidateIds: [],
      overrides: [],
    });
    expect(manifest.tracks).toEqual([
      expect.objectContaining({ title: "Already Matched", catalogId: "catalog-ready" }),
    ]);
  });

  test("catalog matches cannot mutate a candidate owned by another run", async () => {
    const firstRunId = await repository.createRun("First match scope", brief, 0, 1);
    const secondRunId = await repository.createRun("Second match scope", brief, 0, 1);
    await repository.addCandidates(firstRunId, [{
      artist: "Scoped Artist",
      title: "Scoped Track",
      album: null,
      releaseYear: null,
      durationMs: null,
      isrc: null,
      musicbrainzId: null,
      versionLabel: null,
      evidence: [],
    }], new Map(), "unverified");
    const candidate = (await repository.listCandidates(firstRunId))[0]!;
    await expect(repository.saveMatch(secondRunId, {
      candidateId: candidate.id,
      status: "accepted",
      basis: "Cross-run attempt",
      score: 1,
      song: { id: "cross-run-catalog", name: candidate.title, artistName: candidate.artist, albumName: "" },
      alternatives: [],
    })).rejects.toMatchObject({ code: "catalog_candidate_scope_mismatch" });
    expect(await repository.listMatches(firstRunId)).toEqual([]);
    expect(await repository.listMatches(secondRunId)).toEqual([]);
  });

  test("never leases two publication jobs for the same manifest concurrently", async () => {
    vi.stubEnv("WORKER_CONCURRENCY", "2");
    const runId = await repository.createRun("Publication serialization", brief, 0, 1);
    const manifestId = randomUUID();
    await repository.enqueueJob({
      kind: "publication",
      runId,
      payload: { manifestId },
      dedupeKey: `publication:${manifestId}`,
    });
    await repository.enqueueJob({
      kind: "publication",
      runId,
      payload: { manifestId },
      dedupeKey: `publication:${manifestId}:reauth`,
    });
    const first = await repository.leaseNextJob("publisher-one", 60_000);
    expect(first).toMatchObject({ kind: "publication" });
    await expect(repository.leaseNextJob("publisher-two", 60_000)).resolves.toBeNull();
    await repository.completeJob(first!.id, "publisher-one");
    await expect(repository.leaseNextJob("publisher-two", 60_000)).resolves.toMatchObject({ kind: "publication" });
  });

  test("a repeated publication request while the first response is in flight queues exactly one job", async () => {
    const runId = await repository.createRun("Publication request race", brief, 0, 1);
    const manifestId = randomUUID();
    const clientBucket = `publish-in-flight-${randomUUID()}`;
    await repository.pool.query(
      "INSERT INTO manifests(id,run_id,name,description,content_hash) VALUES($1,$2,'Publication request race','Test manifest',$3)",
      [manifestId, runId, "1".repeat(64)],
    );
    await repository.updateRun(runId, { status: "manifest_ready", phase: "manifest" });

    const request = () => repository.queueManifestPublication({
      runId,
      manifestId,
      appleAuthorized: true,
      clientBucket,
      clientBucketAliases: [clientBucket],
    });
    const results = await Promise.all([request(), request()]);

    expect(results.filter((result) => result.queued)).toHaveLength(1);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ queued: true, state: "queued", runStatus: "publishing" }),
      expect.objectContaining({ queued: false, state: "in_flight", runStatus: "publishing" }),
    ]));
    expect(new Set(results.map((result) => result.jobId)).size).toBe(1);
    expect(await repository.getRunControlState(runId)).toEqual({ status: "publishing", phase: "publication_queued" });
    const persisted = await repository.pool.query<{ jobs: number; rate_events: number }>(
      `SELECT
         (SELECT count(*)::int FROM job_queue WHERE kind='publication' AND dedupe_key=$1) jobs,
         (SELECT count(*)::int FROM rate_limit_events WHERE client_bucket=$2 AND action='publish') rate_events`,
      [`publication:${manifestId}`, clientBucket],
    );
    expect(persisted.rows[0]).toEqual({ jobs: 1, rate_events: 1 });
  });

  test("a retry after a lost publication response never regresses a completed run or requeues its job", async () => {
    const runId = await repository.createRun("Completed publication retry", brief, 0, 1);
    const manifestId = randomUUID();
    const clientBucket = `publish-complete-${randomUUID()}`;
    await repository.pool.query(
      "INSERT INTO manifests(id,run_id,name,description,content_hash) VALUES($1,$2,'Completed publication retry','Test manifest',$3)",
      [manifestId, runId, "2".repeat(64)],
    );
    await repository.updateRun(runId, { status: "manifest_ready", phase: "manifest" });
    const input = {
      runId,
      manifestId,
      appleAuthorized: true,
      clientBucket,
      clientBucketAliases: [clientBucket],
    };

    const first = await repository.queueManifestPublication(input);
    expect(first).toMatchObject({ queued: true, state: "queued" });
    const leased = await repository.leaseNextJob("lost-response-publisher", 60_000);
    expect(leased).toMatchObject({ id: first.jobId, kind: "publication" });
    await repository.updateRun(runId, { status: "complete", phase: "published", error: null });
    await repository.completeJob(leased!.id, "lost-response-publisher");

    const retry = await repository.queueManifestPublication(input);
    expect(retry).toMatchObject({ queued: false, state: "terminal", runStatus: "complete", jobId: first.jobId });
    expect(await repository.getRunControlState(runId)).toEqual({ status: "complete", phase: "published" });
    const persisted = await repository.pool.query<{ jobs: number; complete_jobs: number; rate_events: number }>(
      `SELECT
         (SELECT count(*)::int FROM job_queue WHERE kind='publication' AND dedupe_key=$1) jobs,
         (SELECT count(*)::int FROM job_queue WHERE kind='publication' AND dedupe_key=$1 AND status='complete') complete_jobs,
         (SELECT count(*)::int FROM rate_limit_events WHERE client_bucket=$2 AND action='publish') rate_events`,
      [`publication:${manifestId}`, clientBucket],
    );
    expect(persisted.rows[0]).toEqual({ jobs: 1, complete_jobs: 1, rate_events: 1 });
  });

  test("publication retries while Apple authorization is unavailable reuse one owner notification", async () => {
    const runId = await repository.createRun("Apple authorization publication retry", brief, 0, 1);
    const manifestId = randomUUID();
    const clientBucket = `publish-apple-wait-${randomUUID()}`;
    await repository.pool.query(
      "INSERT INTO manifests(id,run_id,name,description,content_hash) VALUES($1,$2,'Apple authorization retry','Test manifest',$3)",
      [manifestId, runId, "3".repeat(64)],
    );
    await repository.updateRun(runId, { status: "manifest_ready", phase: "manifest" });
    const request = () => repository.queueManifestPublication({
      runId,
      manifestId,
      appleAuthorized: false,
      clientBucket,
      clientBucketAliases: [clientBucket],
    });
    const notify = () => repository.enqueueNotification("apple_reauthorization_required", {
      deduplicationKey: `apple-reauthorization:${manifestId}`,
      runId,
      manifestId,
    });

    const first = await request();
    const firstNotification = await notify();
    const retry = await request();
    const retryNotification = await notify();

    expect(first).toMatchObject({ queued: false, state: "waiting_for_apple_authorization" });
    expect(retry).toMatchObject({ queued: false, state: "waiting_for_apple_authorization" });
    expect(retryNotification).toBe(firstNotification);
    expect(await repository.getRunControlState(runId)).toEqual({
      status: "waiting_for_apple_authorization",
      phase: "apple_authorization",
    });
    const persisted = await repository.pool.query<{ jobs: number; notifications: number; rate_events: number }>(
      `SELECT
         (SELECT count(*)::int FROM job_queue WHERE kind='publication' AND run_id=$1) jobs,
         (SELECT count(*)::int FROM notification_outbox WHERE dedupe_key=$2) notifications,
         (SELECT count(*)::int FROM rate_limit_events WHERE client_bucket=$3 AND action='publish') rate_events`,
      [runId, `apple-reauthorization:${manifestId}`, clientBucket],
    );
    expect(persisted.rows[0]).toEqual({ jobs: 0, notifications: 1, rate_events: 0 });
  });

  test("Apple publication recovery never heartbeat-revives a terminal job and a new validation epoch can resume it", async () => {
    const runId = await repository.createRun("Apple publication recovery epoch", brief, 0, 1);
    const manifestId = randomUUID();
    await repository.pool.query(
      "INSERT INTO manifests(id,run_id,name,description,content_hash) VALUES($1,$2,'Authorization recovery','Test manifest',$3)",
      [manifestId, runId, "7".repeat(64)],
    );
    await repository.updateRun(runId, { status: "waiting_for_apple_authorization", phase: "apple_reauthorization" });

    await expect(repository.listWaitingPublicationManifests()).resolves.toEqual([{ manifestId, runId }]);
    const firstKey = `publication:${manifestId}:reauth:generation:epoch-one`;
    await expect(repository.enqueueWaitingPublicationRecovery({ manifestId, runId, dedupeKey: firstKey })).resolves.toBe(true);
    await repository.pool.query(
      "UPDATE job_queue SET status='failed',attempts=max_attempts,completed_at=now() WHERE kind='publication' AND dedupe_key=$1",
      [firstKey],
    );

    await expect(repository.enqueueWaitingPublicationRecovery({ manifestId, runId, dedupeKey: firstKey })).resolves.toBe(false);
    const secondKey = `publication:${manifestId}:reauth:generation:epoch-two`;
    await expect(repository.enqueueWaitingPublicationRecovery({ manifestId, runId, dedupeKey: secondKey })).resolves.toBe(true);
    const jobs = await repository.pool.query<{ dedupe_key: string; status: string }>(
      "SELECT dedupe_key,status FROM job_queue WHERE kind='publication' AND run_id=$1 ORDER BY created_at",
      [runId],
    );
    expect(jobs.rows).toEqual([
      { dedupe_key: firstKey, status: "failed" },
      { dedupe_key: secondKey, status: "queued" },
    ]);
  });

  test("terminal Apple validation failures update only the current durable authorization", async () => {
    const authorization = {
      ciphertext: "encrypted-current-authorization",
      iv: "iv",
      authTag: "tag",
      keyVersion: "v1",
      storefront: "us",
      status: "unverified",
      lastValidatedAt: null,
      lastError: null,
    };
    await repository.saveAppleAuthorization(authorization);
    const authorizationGeneration = appleAuthorizationGeneration(authorization);
    const queued = await repository.enqueueJob({
      kind: "apple_authorization",
      payload: { authorizationGeneration },
      dedupeKey: `apple-authorization:${authorizationGeneration}`,
      maxAttempts: 1,
    });
    const leased = await repository.leaseNextJob("apple-validation-diagnostics", 60_000);
    expect(leased).toMatchObject({ id: queued.id, kind: "apple_authorization", attempts: 1 });
    await repository.failJob(
      queued.id,
      "apple-validation-diagnostics",
      "Apple Music temporarily rate-limited authorization validation (HTTP 429).",
      null,
    );
    await expect(repository.getAppleAuthorization()).resolves.toMatchObject({
      status: "validation_failed",
      lastError: "Apple Music temporarily rate-limited authorization validation (HTTP 429).",
    });
  });

  test("completed Apple validation jobs can be revived for the same cached token generation", async () => {
    const authorization = {
      ciphertext: "encrypted-cached-authorization",
      iv: "iv",
      authTag: "tag",
      keyVersion: "v1",
      storefront: "us",
      status: "unverified",
      lastValidatedAt: null,
      lastError: null,
    };
    await repository.saveAppleAuthorization(authorization);
    const authorizationGeneration = appleAuthorizationGeneration(authorization);
    const dedupeKey = `apple-authorization:${authorizationGeneration}`;
    const queued = await repository.enqueueJob({
      kind: "apple_authorization",
      payload: { authorizationGeneration },
      dedupeKey,
      maxAttempts: 6,
    });
    const leased = await repository.leaseNextJob("apple-cached-token-first", 60_000);
    expect(leased).toMatchObject({ id: queued.id, attempts: 1 });
    await repository.completeJob(queued.id, "apple-cached-token-first");

    const retried = await repository.enqueueJob({
      kind: "apple_authorization",
      payload: { authorizationGeneration },
      dedupeKey,
      maxAttempts: 6,
    });
    expect(retried).toEqual({ id: queued.id, created: false });
    const revived = await repository.pool.query<{
      status: string;
      attempts: number;
      max_attempts: number;
      completed_at: Date | null;
    }>("SELECT status,attempts,max_attempts,completed_at FROM job_queue WHERE id=$1", [queued.id]);
    expect(revived.rows[0]).toMatchObject({
      status: "queued",
      attempts: 0,
      max_attempts: 6,
      completed_at: null,
    });
  });

  test("an expired final Apple validation lease fails only its current authorization generation", async () => {
    const authorization = {
      ciphertext: "encrypted-expired-authorization",
      iv: "iv",
      authTag: "tag",
      keyVersion: "v1",
      storefront: "us",
      status: "unverified",
      lastValidatedAt: null,
      lastError: null,
    };
    await repository.saveAppleAuthorization(authorization);
    const authorizationGeneration = appleAuthorizationGeneration(authorization);
    const queued = await repository.enqueueJob({
      kind: "apple_authorization",
      payload: { authorizationGeneration },
      dedupeKey: `apple-authorization:${authorizationGeneration}`,
      maxAttempts: 1,
    });
    expect(await repository.leaseNextJob("apple-expired-validation", 30_000)).toMatchObject({
      id: queued.id,
      attempts: 1,
    });
    await repository.pool.query("UPDATE job_queue SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [queued.id]);
    await expect(repository.leaseNextJob("apple-expired-sweeper", 30_000)).resolves.toBeNull();
    await expect(repository.getAppleAuthorization()).resolves.toMatchObject({
      status: "validation_failed",
      lastError: "Apple Music authorization validation failed after the final attempt.",
    });

    const staleAuthorization = {
      ...authorization,
      ciphertext: "encrypted-stale-authorization",
      status: "unverified",
    };
    await repository.saveAppleAuthorization(staleAuthorization);
    const staleGeneration = appleAuthorizationGeneration(staleAuthorization);
    const staleJob = await repository.enqueueJob({
      kind: "apple_authorization",
      payload: { authorizationGeneration: staleGeneration },
      dedupeKey: `apple-authorization:${staleGeneration}`,
      maxAttempts: 1,
    });
    expect(await repository.leaseNextJob("apple-stale-validation", 30_000)).toMatchObject({ id: staleJob.id });
    await repository.saveAppleAuthorization({
      ...authorization,
      ciphertext: "encrypted-current-replacement",
      status: "unverified",
    });
    await repository.pool.query("UPDATE job_queue SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [staleJob.id]);
    await expect(repository.leaseNextJob("apple-stale-sweeper", 30_000)).resolves.toBeNull();
    await expect(repository.getAppleAuthorization()).resolves.toMatchObject({
      ciphertext: "encrypted-current-replacement",
      status: "unverified",
      lastError: null,
    });

    const validatedAuthorization = {
      ...authorization,
      ciphertext: "encrypted-validated-before-expiry",
      status: "unverified",
    };
    await repository.saveAppleAuthorization(validatedAuthorization);
    const validatedGeneration = appleAuthorizationGeneration(validatedAuthorization);
    const validatedJob = await repository.enqueueJob({
      kind: "apple_authorization",
      payload: { authorizationGeneration: validatedGeneration },
      dedupeKey: `apple-authorization:${validatedGeneration}`,
      maxAttempts: 1,
    });
    expect(await repository.leaseNextJob("apple-validating-before-expiry", 30_000)).toMatchObject({ id: validatedJob.id });
    await repository.updateAppleAuthorizationStatus("valid", null);
    await repository.pool.query("UPDATE job_queue SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [validatedJob.id]);
    await expect(repository.leaseNextJob("apple-validated-sweeper", 30_000)).resolves.toBeNull();
    await expect(repository.getAppleAuthorization()).resolves.toMatchObject({
      ciphertext: "encrypted-validated-before-expiry",
      status: "valid",
      lastError: null,
    });
  });

  test("a terminal publication-resume failure cannot downgrade a valid Apple authorization", async () => {
    const authorization = {
      ciphertext: "encrypted-valid-authorization",
      iv: "iv",
      authTag: "tag",
      keyVersion: "v1",
      storefront: "us",
      status: "valid",
      lastValidatedAt: new Date(),
      lastError: null,
    };
    await repository.saveAppleAuthorization(authorization);
    const authorizationGeneration = appleAuthorizationGeneration(authorization);
    const queued = await repository.enqueueJob({
      kind: "apple_authorization",
      payload: { authorizationGeneration },
      dedupeKey: `apple-authorization:${authorizationGeneration}`,
      maxAttempts: 1,
    });
    const leased = await repository.leaseNextJob("apple-publication-resume-failure", 60_000);
    expect(leased).toMatchObject({ id: queued.id, kind: "apple_authorization", attempts: 1 });

    await repository.failJob(
      queued.id,
      "apple-publication-resume-failure",
      "Publication recovery failed after validation",
      null,
    );

    await expect(repository.getAppleAuthorization()).resolves.toMatchObject({
      status: "valid",
      storefront: "us",
      lastError: null,
    });
  });

  test("terminal publication failures mark only active volumes failed with redacted diagnostics", async () => {
    const runId = await repository.createRun("Terminal publication diagnostics", brief, 0, 1);
    const manifestId = randomUUID();
    await repository.pool.query(
      "INSERT INTO manifests(id,run_id,name,description,content_hash) VALUES($1,$2,'Terminal diagnostics','Test manifest',$3)",
      [manifestId, runId, "a".repeat(64)],
    );
    await repository.createPublicationVolume({
      manifestId,
      volumeNumber: 1,
      volumeCount: 2,
      startPosition: 0,
      endPosition: 24,
      status: "publishing",
    });
    await repository.createPublicationVolume({
      manifestId,
      volumeNumber: 2,
      volumeCount: 2,
      startPosition: 25,
      endPosition: 49,
      status: "complete",
    });
    const queued = await repository.enqueueJob({
      kind: "publication",
      runId,
      payload: { manifestId },
      dedupeKey: `publication-diagnostics:${manifestId}`,
      maxAttempts: 2,
    });
    const first = await repository.leaseNextJob("publisher-diagnostics", 60_000);
    expect(first).toMatchObject({ id: queued.id, attempts: 1, maxAttempts: 2 });
    await repository.failJob(queued.id, "publisher-diagnostics", "temporary Apple timeout", new Date(Date.now() + 60_000));
    let volumes = await repository.listPublicationVolumes(manifestId);
    expect(volumes[0]).toMatchObject({ status: "publishing", lastError: null });
    expect(volumes[1]).toMatchObject({ status: "complete", lastError: null });
    expect((await repository.pool.query<{ last_error: string }>(
      "SELECT last_error FROM job_queue WHERE id=$1",
      [queued.id],
    )).rows[0]?.last_error).toBe("Apple Music remained unavailable after the final attempt.");

    await repository.pool.query("UPDATE job_queue SET available_at=now() WHERE id=$1", [queued.id]);
    const final = await repository.leaseNextJob("publisher-diagnostics", 60_000);
    expect(final).toMatchObject({ id: queued.id, attempts: 2, maxAttempts: 2 });
    const privateFailure = "provider failure sk-proj-PRIVATE postgres://user:password@private.example/needle";
    await repository.failJob(queued.id, "publisher-diagnostics", privateFailure, new Date(Date.now() + 60_000));
    volumes = await repository.listPublicationVolumes(manifestId);
    expect(volumes[0]).toMatchObject({
      status: "failed",
      lastError: "Apple publication failed after the final attempt; provider details were redacted.",
    });
    expect(volumes[0].lastError).not.toContain("sk-proj");
    expect(volumes[0].lastError).not.toContain("password");
    expect(volumes[1]).toMatchObject({ status: "complete", lastError: null });
    const persistedJob = (await repository.pool.query<{ last_error: string }>(
      "SELECT last_error FROM job_queue WHERE id=$1",
      [queued.id],
    )).rows[0]?.last_error;
    const persistedRun = await repository.getRun(runId);
    expect(persistedJob).toBe("Apple publication failed after the final attempt; provider details were redacted.");
    expect(persistedRun.error).toBe("Apple publication failed after the final attempt; provider details were redacted.");
    expect(`${persistedJob} ${persistedRun.error} ${volumes[0].lastError}`).not.toContain("sk-proj");
    expect(`${persistedJob} ${persistedRun.error} ${volumes[0].lastError}`).not.toContain("password");
    await repository.updatePublicationVolume(volumes[0].id, { lastError: privateFailure });
    expect((await repository.listPublicationVolumes(manifestId))[0]?.lastError)
      .toBe("Apple publication failed after the final attempt; provider details were redacted.");

    const waitingRunId = await repository.createRun("Authorization waiting diagnostics", brief, 0, 1);
    await repository.updateRun(waitingRunId, { status: "waiting_for_apple_authorization", phase: "apple_reauthorization" });
    const waitingManifestId = randomUUID();
    await repository.pool.query(
      "INSERT INTO manifests(id,run_id,name,description,content_hash) VALUES($1,$2,'Authorization waiting','Test manifest',$3)",
      [waitingManifestId, waitingRunId, "b".repeat(64)],
    );
    await repository.createPublicationVolume({
      manifestId: waitingManifestId,
      volumeNumber: 1,
      volumeCount: 1,
      startPosition: 0,
      endPosition: 2,
      status: "waiting_for_owner",
    });
    const waitingJob = await repository.enqueueJob({
      kind: "publication",
      runId: waitingRunId,
      payload: { manifestId: waitingManifestId },
      dedupeKey: `publication-auth-waiting:${waitingManifestId}`,
      maxAttempts: 1,
    });
    expect(await repository.leaseNextJob("publisher-auth-waiting", 60_000)).toMatchObject({ id: waitingJob.id });
    await repository.failJob(waitingJob.id, "publisher-auth-waiting", "Apple returned 403", null);
    expect((await repository.listPublicationVolumes(waitingManifestId))[0]).toMatchObject({
      status: "waiting_for_owner",
      lastError: null,
    });
    expect(await repository.getRun(waitingRunId)).toMatchObject({
      status: "waiting_for_apple_authorization",
      phase: "apple_reauthorization",
      error: null,
    });
  });

  test("raw provider and database failures never cross durable or public boundaries", async () => {
    const privateFailure = "OpenAI sk-proj-PRIVATE failed at postgres://user:password@private.example/needle";
    const briefBucket = `brief-redaction-${randomUUID()}`;
    const briefRequest = await repository.createBriefRequest({
      prompt: "Build a securely redacted integration playlist",
      model: "test-model",
      clientBucket: briefBucket,
      clientBucketAliases: [briefBucket],
      rateLimit: 100,
    });
    await repository.saveBriefResult(briefRequest.id, { status: "failed", error: privateFailure });

    const clientBucket = `run-redaction-${randomUUID()}`;
    const created = await repository.createRunIdempotent({
      prompt: "Public redaction boundary test",
      brief,
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      reuseDays: 0,
      rateLimit: 100,
      globalLimit: 100,
    });
    const researchJob = await repository.enqueueJob({
      kind: "research",
      runId: created.runId,
      payload: { runId: created.runId },
      dedupeKey: `redaction:${created.runId}`,
      maxAttempts: 1,
    });
    expect(await repository.leaseNextJob("redaction-worker", 60_000)).toMatchObject({ id: researchJob.id });
    await repository.failJob(researchJob.id, "redaction-worker", privateFailure, null);

    const manifestId = randomUUID();
    await repository.pool.query(
      "INSERT INTO manifests(id,run_id,name,description,content_hash) VALUES($1,$2,'Redaction result','Public boundary test',$3)",
      [manifestId, created.runId, "c".repeat(64)],
    );
    const notificationId = await repository.enqueueNotification("worker_stale", { runId: created.runId });
    await repository.markNotificationFailed(notificationId, privateFailure, null);

    const matchingRunId = await repository.createRun("Matching redaction boundary", brief, 0, 1);
    await repository.updateRun(matchingRunId, { status: "failed", phase: "matching_failed", error: privateFailure });

    const [storedBrief, storedRun, storedJob, storedNotification, storedMatchingRun] = await Promise.all([
      repository.pool.query<{ error: string }>("SELECT error FROM brief_requests WHERE id=$1", [briefRequest.id]),
      repository.pool.query<{ error: string }>("SELECT error FROM research_runs WHERE id=$1", [created.runId]),
      repository.pool.query<{ last_error: string }>("SELECT last_error FROM job_queue WHERE id=$1", [researchJob.id]),
      repository.pool.query<{ last_error: string }>("SELECT last_error FROM notification_outbox WHERE id=$1", [notificationId]),
      repository.pool.query<{ error: string }>("SELECT error FROM research_runs WHERE id=$1", [matchingRunId]),
    ]);
    const durableErrors = [
      storedBrief.rows[0]?.error,
      storedRun.rows[0]?.error,
      storedJob.rows[0]?.last_error,
      storedNotification.rows[0]?.last_error,
      storedMatchingRun.rows[0]?.error,
    ];
    expect(durableErrors).toEqual([
      "Needle could not interpret this request after the final attempt.",
      "Research could not be completed after the final attempt.",
      "Research could not be completed after the final attempt.",
      "Owner notification delivery failed after the final attempt.",
      "Apple Music matching could not be completed after the final attempt.",
    ]);
    expect(JSON.stringify(durableErrors)).not.toContain("sk-proj-PRIVATE");
    expect(JSON.stringify(durableErrors)).not.toContain("postgres://");

    const [briefView, runView, publicResult] = await Promise.all([
      repository.getBriefRequest(briefRequest.id),
      repository.getRunByAccess(created.accessId),
      repository.getPublicResult(created.runId),
    ]);
    expect(briefView?.error).toBe("Needle could not interpret this request after the final attempt.");
    expect(runView?.error).toBe("Research could not be completed after the final attempt.");
    expect(publicResult.error).toBe("Research could not be completed after the final attempt.");
    expect(JSON.stringify({ briefView, runView, publicResult })).not.toContain("sk-proj-PRIVATE");
    expect(JSON.stringify({ briefView, runView, publicResult })).not.toContain("postgres://");
  });

  test("a Resend outage keeps the notification outbox pending for a durable retry", async () => {
    vi.stubEnv("RESEND_API_KEY", "offline-resend-integration-key");
    vi.stubEnv("RESEND_FROM", "Needle <alerts@example.com>");
    vi.stubEnv("OWNER_ALERT_EMAIL", "owner@example.com");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Resend is unavailable"); }));
    const notificationId = await repository.enqueueNotification("worker_stale", {
      observedAt: new Date().toISOString(),
      deduplicationKey: `resend-outage-${randomUUID()}`,
    });

    await expect(processNotificationJob(repository, { notificationId })).rejects.toThrow(/Resend is unavailable/u);
    const [notification, job] = await Promise.all([
      repository.getNotification(notificationId),
      repository.pool.query<{ count: number }>(
        "SELECT count(*)::int count FROM job_queue WHERE kind='notification' AND payload_json->>'notificationId'=$1",
        [notificationId],
      ),
    ]);
    expect(notification).toMatchObject({
      id: notificationId,
      status: "pending",
      attempts: 1,
      availableAt: expect.any(Date),
      sentAt: null,
      lastError: "Owner notification delivery failed after the final attempt.",
    });
    expect(notification.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(job.rows[0]?.count).toBe(1);
  });

  test("exchanges capabilities once and rejects revoked sessions", async () => {
    vi.stubEnv("CAPABILITY_PEPPER", "integration-capability-pepper-32-bytes");
    const clientBucket = `capability-${randomUUID()}`;
    const created = await repository.createRunIdempotent({
      prompt: "Capability integration test",
      brief,
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      reuseDays: 0,
      rateLimit: 100,
      globalLimit: 100,
    });
    const capabilities = new CapabilityService(repository);
    const oneTimeToken = await capabilities.issue(created.runId, created.accessId);
    const exchangeReply = new ReplyStub();
    const session = await capabilities.exchange(oneTimeToken, exchangeReply as unknown as FastifyReply);
    expect(session).toMatchObject({ runId: created.runId, accessId: created.accessId });
    await expect(capabilities.exchange(oneTimeToken, new ReplyStub() as unknown as FastifyReply))
      .rejects.toMatchObject({ statusCode: 401, code: "invalid_capability" });

    const setCookie = exchangeReply.headers.get("set-cookie");
    expect(setCookie).toContain(`${CAPABILITY_COOKIE}=`);
    const request = cookieRequest(setCookie!.split(";")[0]!);
    await expect(capabilities.authenticate(request)).resolves.toMatchObject({ id: session.id });

    const revokeReply = new ReplyStub();
    await capabilities.revoke(request, revokeReply as unknown as FastifyReply);
    expect(revokeReply.headers.get("set-cookie")).toContain("Max-Age=0");
    await expect(capabilities.authenticate(request)).rejects.toMatchObject({ statusCode: 401, code: "capability_required" });
  });

  test("allows multiple active runs from one anonymous bucket while preserving capability isolation and rate limits", async () => {
    vi.stubEnv("CAPABILITY_PEPPER", "integration-capability-pepper-32-bytes");
    const clientBucket = `capability-multi-run-${randomUUID()}`;
    const create = (label: string, capabilitySessionId?: string) => {
      return repository.createRunIdempotent({
        prompt: `Capability scope ${label}`,
        brief: { ...brief, title: `Capability scope ${label}` },
        estimateUsd: 0,
        approvedBudgetUsd: 1,
        clientBucket,
        clientBucketAliases: [clientBucket],
        idempotencyKey: randomUUID(),
        reuseDays: 0,
        rateLimit: 2,
        globalLimit: 100,
        capabilitySessionId,
      });
    };
    const left = await create("left");
    expect(left).toMatchObject({ created: true, status: "queued" });
    const capabilities = new CapabilityService(repository);
    const reply = new ReplyStub();
    const session = await capabilities.exchange(
      await capabilities.issue(left.runId, left.accessId),
      reply as unknown as FastifyReply,
    );
    const request = cookieRequest(reply.headers.get("set-cookie")!.split(";")[0]!);
    const right = await create("right", session.id);
    expect(right).toMatchObject({ created: true, status: "queued" });
    expect(left.runId).not.toBe(right.runId);
    await expect(create("third", session.id)).rejects.toMatchObject({ statusCode: 429, code: "rate_limited" });

    await expect(capabilities.authenticateForAccess(request, left.accessId)).resolves.toMatchObject({
      runId: left.runId,
      accessId: left.accessId,
    });
    await expect(capabilities.authenticateForAccess(request, right.accessId)).resolves.toMatchObject({
      runId: right.runId,
      accessId: right.accessId,
    });
    const history = await repository.listRunsForCapabilitySession(session.id);
    expect(history.map((item) => item.id)).toEqual([right.accessId, left.accessId]);
    expect(history[0]).toMatchObject({
      prompt: "Capability scope right",
      status: "queued",
      phase: "queued",
      candidateCount: 0,
      sourceCount: 0,
      unresolvedCount: 0,
      brief: { title: "Capability scope right" },
    });

    const mergeReply = new ReplyStub();
    await expect(capabilities.exchange(
      await capabilities.issue(right.runId, right.accessId),
      mergeReply as unknown as FastifyReply,
      session,
    )).resolves.toMatchObject({ id: session.id, runId: right.runId, accessId: right.accessId });
    expect(mergeReply.headers.get("set-cookie")).toBeUndefined();
    await expect(capabilities.authenticate(request)).resolves.toMatchObject({ id: session.id });

    const isolatedBucket = `capability-isolated-${randomUUID()}`;
    const isolated = await repository.createRunIdempotent({
      prompt: "Capability scope isolated",
      brief: { ...brief, title: "Capability scope isolated" },
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket: isolatedBucket,
      clientBucketAliases: [isolatedBucket],
      idempotencyKey: randomUUID(),
      reuseDays: 0,
      rateLimit: 100,
      globalLimit: 100,
    });
    await expect(capabilities.authenticateForAccess(request, isolated.accessId)).rejects.toMatchObject({
      statusCode: 403,
      code: "capability_scope_mismatch",
    });

    await expect(repository.deleteRunAccess(left.accessId)).resolves.toBe(true);
    await expect(capabilities.authenticate(request)).resolves.toMatchObject({
      id: session.id,
      runId: right.runId,
      accessId: right.accessId,
    });
    await expect(repository.listRunsForCapabilitySession(session.id)).resolves.toMatchObject([
      { id: right.accessId },
    ]);
  });

  test("deleting a secondary run keeps the original run in the same capability session", async () => {
    vi.stubEnv("CAPABILITY_PEPPER", "integration-capability-pepper-32-bytes");
    const clientBucket = `capability-secondary-delete-${randomUUID()}`;
    const create = (label: string, capabilitySessionId?: string) => repository.createRunIdempotent({
      prompt: `Secondary deletion ${label}`,
      brief: { ...brief, title: `Secondary deletion ${label}` },
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      reuseDays: 0,
      rateLimit: 100,
      globalLimit: 100,
      capabilitySessionId,
    });
    const original = await create("original");
    const capabilities = new CapabilityService(repository);
    const reply = new ReplyStub();
    const session = await capabilities.exchange(
      await capabilities.issue(original.runId, original.accessId),
      reply as unknown as FastifyReply,
    );
    const request = cookieRequest(reply.headers.get("set-cookie")!.split(";")[0]!);
    const secondary = await create("secondary", session.id);

    await expect(repository.deleteRunAccess(secondary.accessId)).resolves.toBe(true);
    await expect(capabilities.authenticate(request)).resolves.toMatchObject({
      id: session.id,
      runId: original.runId,
      accessId: original.accessId,
    });
    await expect(capabilities.authenticateForAccess(request, secondary.accessId)).rejects.toMatchObject({
      statusCode: 403,
      code: "capability_scope_mismatch",
    });
    await expect(repository.listRunsForCapabilitySession(session.id)).resolves.toMatchObject([
      { id: original.accessId },
    ]);
  });

  test("backfills existing single-run capability sessions into run history", async () => {
    vi.stubEnv("CAPABILITY_PEPPER", "integration-capability-pepper-32-bytes");
    const clientBucket = `capability-backfill-${randomUUID()}`;
    const created = await repository.createRunIdempotent({
      prompt: "Capability migration backfill",
      brief,
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      reuseDays: 0,
      rateLimit: 100,
      globalLimit: 100,
    });
    const capabilities = new CapabilityService(repository);
    const session = await capabilities.exchange(
      await capabilities.issue(created.runId, created.accessId),
      new ReplyStub() as unknown as FastifyReply,
    );
    await repository.pool.query("DELETE FROM capability_session_accesses WHERE session_id=$1", [session.id]);
    await expect(repository.listRunsForCapabilitySession(session.id)).resolves.toEqual([]);

    await applyMigration(repository.pool);

    await expect(repository.listRunsForCapabilitySession(session.id)).resolves.toMatchObject([
      { id: created.accessId, prompt: "Capability migration backfill" },
    ]);
  });

  test("allows exactly one concurrent exchange of a one-time capability", async () => {
    vi.stubEnv("CAPABILITY_PEPPER", "integration-capability-pepper-32-bytes");
    const clientBucket = `capability-race-${randomUUID()}`;
    const created = await repository.createRunIdempotent({
      prompt: "Concurrent capability exchange",
      brief,
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      reuseDays: 0,
      rateLimit: 100,
      globalLimit: 100,
    });
    const capabilities = new CapabilityService(repository);
    const token = await capabilities.issue(created.runId, created.accessId);
    const results = await Promise.allSettled([
      capabilities.exchange(token, new ReplyStub() as unknown as FastifyReply),
      capabilities.exchange(token, new ReplyStub() as unknown as FastifyReply),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { statusCode: 401, code: "invalid_capability" },
    });
    const sessions = await repository.pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM capability_sessions WHERE access_id=$1 AND revoked_at IS NULL",
      [created.accessId],
    );
    expect(sessions.rows[0]?.count).toBe(1);
  });

  test("expires transfer capabilities and permits only one successful use", async () => {
    vi.stubEnv("CAPABILITY_PEPPER", "integration-capability-pepper-32-bytes");
    const clientBucket = `capability-transfer-${randomUUID()}`;
    const created = await repository.createRunIdempotent({
      prompt: "Transfer capability expiry",
      brief,
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      reuseDays: 0,
      rateLimit: 100,
      globalLimit: 100,
    });
    const capabilities = new CapabilityService(repository);
    const expired = await capabilities.issue(created.runId, created.accessId, -1);
    await expect(capabilities.exchange(expired, new ReplyStub() as unknown as FastifyReply)).rejects.toMatchObject({
      statusCode: 401,
      code: "invalid_capability",
    });

    const transfer = await capabilities.issue(created.runId, created.accessId, 60_000);
    await expect(capabilities.exchange(transfer, new ReplyStub() as unknown as FastifyReply)).resolves.toMatchObject({
      runId: created.runId,
      accessId: created.accessId,
    });
    await expect(capabilities.exchange(transfer, new ReplyStub() as unknown as FastifyReply)).rejects.toMatchObject({
      statusCode: 401,
      code: "invalid_capability",
    });
  });

  test("deletion revokes active sessions and unexchanged capabilities", async () => {
    vi.stubEnv("CAPABILITY_PEPPER", "integration-capability-pepper-32-bytes");
    const clientBucket = `capability-delete-${randomUUID()}`;
    const created = await repository.createRunIdempotent({
      prompt: "Capability deletion revocation",
      brief,
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      reuseDays: 0,
      rateLimit: 100,
      globalLimit: 100,
    });
    const capabilities = new CapabilityService(repository);
    const reply = new ReplyStub();
    await capabilities.exchange(
      await capabilities.issue(created.runId, created.accessId),
      reply as unknown as FastifyReply,
    );
    const pending = await capabilities.issue(created.runId, created.accessId);
    const request = cookieRequest(reply.headers.get("set-cookie")!.split(";")[0]!);

    await expect(repository.deleteRunAccess(created.accessId)).resolves.toBe(true);
    await expect(capabilities.authenticate(request)).rejects.toMatchObject({ statusCode: 401, code: "capability_required" });
    await expect(capabilities.exchange(pending, new ReplyStub() as unknown as FastifyReply)).rejects.toMatchObject({
      statusCode: 401,
      code: "invalid_capability",
    });
    await expect(repository.getRunByAccess(created.accessId)).resolves.toBeNull();
    await expect(repository.getRun(created.runId)).rejects.toMatchObject({ statusCode: 404, code: "run_not_found" });
    const tombstone = await repository.pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM retention_tombstones WHERE run_id=$1",
      [created.runId],
    );
    expect(tombstone.rows[0]?.count).toBe(1);
    const remaining = await repository.pool.query<{ tokens: number; active_sessions: number }>(
      `SELECT
         (SELECT count(*)::int FROM capability_tokens WHERE access_id=$1) tokens,
         (SELECT count(*)::int FROM capability_sessions WHERE access_id=$1 AND revoked_at IS NULL) active_sessions`,
      [created.accessId],
    );
    expect(remaining.rows[0]).toEqual({ tokens: 0, active_sessions: 0 });
  });

  test("post-publication deletion removes Needle detail but preserves the public Apple links in a tombstone", async () => {
    const clientBucket = `published-delete-${randomUUID()}`;
    const created = await repository.createRunIdempotent({
      prompt: "Published playlist deletion",
      brief: { ...brief, title: "Published deletion fixture" },
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      reuseDays: 0,
      rateLimit: 100,
      globalLimit: 100,
    });
    const manifestId = randomUUID();
    const contentHash = "d".repeat(64);
    const shareUrl = "https://music.apple.com/us/playlist/needle-published-deletion/pl.u-test123";
    await repository.pool.query(
      `INSERT INTO manifests(id,run_id,name,description,content_hash)
       VALUES($1,$2,'Published deletion fixture','A published fixture',$3)`,
      [manifestId, created.runId, contentHash],
    );
    await repository.pool.query(
      `INSERT INTO publication_volumes(
         id,manifest_id,volume_number,volume_count,start_position,end_position,status,
         apple_playlist_id,apple_share_url,appended_count,published_at
       ) VALUES($1,$2,1,1,0,0,'complete','p.library-test',$3,1,now())`,
      [randomUUID(), manifestId, shareUrl],
    );
    await repository.updateRun(created.runId, { status: "complete", phase: "publication_complete" });

    await expect(repository.deleteRunAccess(created.accessId)).resolves.toBe(true);
    await expect(repository.getRun(created.runId)).rejects.toMatchObject({ statusCode: 404, code: "run_not_found" });
    const [tombstone, manifestCount, volumeCount] = await Promise.all([
      repository.pool.query<{
        manifest_hash: string;
        playlist_title: string;
        apple_links_json: string[];
      }>(
        "SELECT manifest_hash,playlist_title,apple_links_json FROM retention_tombstones WHERE run_id=$1",
        [created.runId],
      ),
      repository.pool.query<{ count: number }>("SELECT count(*)::int count FROM manifests WHERE run_id=$1", [created.runId]),
      repository.pool.query<{ count: number }>("SELECT count(*)::int count FROM publication_volumes WHERE manifest_id=$1", [manifestId]),
    ]);
    expect(tombstone.rows[0]).toEqual({
      manifest_hash: contentHash,
      playlist_title: "Published deletion fixture",
      apple_links_json: [shareUrl],
    });
    expect(manifestCount.rows[0]?.count).toBe(0);
    expect(volumeCount.rows[0]?.count).toBe(0);
  });

  test("sets host-only production capability cookies with strict security attributes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CAPABILITY_PEPPER", "integration-capability-pepper-32-bytes");
    vi.resetModules();
    const productionModule = await import("../server/capabilities.ts");
    expect(productionModule.CAPABILITY_COOKIE).toBe("__Host-needle-session");

    const clientBucket = `capability-cookie-${randomUUID()}`;
    const created = await repository.createRunIdempotent({
      prompt: "Production cookie attributes",
      brief,
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      reuseDays: 0,
      rateLimit: 100,
      globalLimit: 100,
    });
    const capabilities = new productionModule.CapabilityService(repository);
    const reply = new ReplyStub();
    await capabilities.exchange(
      await capabilities.issue(created.runId, created.accessId),
      reply as unknown as FastifyReply,
    );
    const setCookie = reply.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^__Host-needle-session=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict; Secure; Expires=/u);
    expect(setCookie).not.toMatch(/;\s*Domain=/iu);
  });

  test("retention preserves a minimal tombstone and removes run-level detail", async () => {
    const runId = await repository.createRun("Retention detail test", brief, 0, 2);
    await repository.appendCostLedger({ runId }, "retention-detail", 1.25, { tokens: 42 });
    await repository.recordAudit("owner@example.com", "retention.detail", { privateDetail: true }, runId);
    const notificationId = await repository.enqueueNotification("publication_complete", {
      runId,
      manifestId: randomUUID(),
      volumeCount: 1,
    });
    await repository.pool.query(
      "UPDATE research_runs SET retention_expires_at=now()-interval '1 second' WHERE id=$1",
      [runId],
    );

    await expect(repository.runRetentionSweep(50)).resolves.toBeGreaterThanOrEqual(1);

    const [run, tombstone, cost, audit, notification, notificationJob] = await Promise.all([
      repository.pool.query<{ count: number }>("SELECT count(*)::int count FROM research_runs WHERE id=$1", [runId]),
      repository.pool.query<{ aggregate_cost_usd: string }>("SELECT aggregate_cost_usd FROM retention_tombstones WHERE run_id=$1", [runId]),
      repository.pool.query<{ count: number }>("SELECT count(*)::int count FROM cost_ledger WHERE run_id=$1", [runId]),
      repository.pool.query<{ count: number }>("SELECT count(*)::int count FROM audit_events WHERE run_id=$1", [runId]),
      repository.pool.query<{ count: number }>("SELECT count(*)::int count FROM notification_outbox WHERE id=$1", [notificationId]),
      repository.pool.query<{ count: number }>(
        "SELECT count(*)::int count FROM job_queue WHERE kind='notification' AND payload_json->>'notificationId'=$1",
        [notificationId],
      ),
    ]);
    expect(run.rows[0]?.count).toBe(0);
    expect(Number(tombstone.rows[0]?.aggregate_cost_usd)).toBe(1.25);
    expect(cost.rows[0]?.count).toBe(0);
    expect(audit.rows[0]?.count).toBe(0);
    expect(notification.rows[0]?.count).toBe(0);
    expect(notificationJob.rows[0]?.count).toBe(0);

    const health = await repository.getSystemHealth();
    expect(health.retention.lastRunAt).toEqual(expect.any(String));
    expect(health.retention.lastPurged).toBeGreaterThanOrEqual(1);
  });

  test("system health exposes queue age, expired work, notification failures, and publication failures", async () => {
    const queued = await repository.enqueueJob({ kind: "health-queued", dedupeKey: randomUUID() });
    const expired = await repository.enqueueJob({ kind: "health-expired", dedupeKey: randomUUID() });
    await repository.pool.query("UPDATE job_queue SET created_at=now()-interval '10 minutes' WHERE id=$1", [queued.id]);
    await repository.pool.query(
      "UPDATE job_queue SET status='leased',attempts=1,lease_owner='stale-worker',lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [expired.id],
    );
    const notificationId = await repository.enqueueNotification("worker_stale", { observedAt: new Date().toISOString() });
    await repository.markNotificationFailed(notificationId, "delivery failed", null);
    const failedRunId = await repository.createRun("Publication failure telemetry", brief, 0, 1);
    await repository.updateRun(failedRunId, { status: "failed", phase: "publication_failed", error: "test failure" });

    const health = await repository.getSystemHealth();
    expect(health.queue.oldestQueuedSeconds).toBeGreaterThanOrEqual(590);
    expect(health.queue.expiredLeases).toBeGreaterThanOrEqual(1);
    expect(health.notificationFailures).toBeGreaterThanOrEqual(1);
    expect(health.publicationFailures.runs).toBeGreaterThanOrEqual(1);
    expect(health.retention).toMatchObject({ dueRuns: expect.any(Number), lastPurged: expect.any(Number) });
  });

  test("system health marks a stale heartbeat unhealthy and accepts a fresh replacement heartbeat", async () => {
    vi.stubEnv("WORKER_STALE_SECONDS", "90");
    await repository.updateWorkerHeartbeat("stale-worker", { schemaVersion: "1", capacity: 2, activeJobs: 1 });
    await repository.pool.query(
      "UPDATE worker_heartbeats SET last_seen_at=now()-interval '91 seconds' WHERE worker_id='stale-worker'",
    );
    expect((await repository.getSystemHealth()).worker).toMatchObject({ worker_id: "stale-worker", stale: true });

    await repository.updateWorkerHeartbeat("fresh-worker", { schemaVersion: DATABASE_SCHEMA_VERSION, capacity: 2, activeJobs: 0 });
    expect((await repository.getSystemHealth()).worker).toMatchObject({
      worker_id: "fresh-worker",
      stale: false,
      schemaCompatible: true,
    });

    await repository.updateWorkerHeartbeat("wrong-schema-worker", { schemaVersion: "1", capacity: 2, activeJobs: 0 });
    expect((await repository.getSystemHealth()).worker).toMatchObject({
      worker_id: "wrong-schema-worker",
      stale: false,
      schemaCompatible: false,
    });
  });
});
