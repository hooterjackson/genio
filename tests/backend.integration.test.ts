import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createDatabase,
  DATABASE_SCHEMA_V12_BRIDGE_SUPPORT,
  DATABASE_SCHEMA_VERSION,
} from "../db/index.ts";
import { CapabilityService, CAPABILITY_COOKIE } from "../server/capabilities.ts";
import {
  CATALOG_RECOVERY_UNRESOLVED_BASIS,
  RETRYABLE_CATALOG_MATCH_BASES,
} from "../server/catalog-match-recovery.ts";
import { canonicalGatewayRequest, createGatewayVerifier } from "../server/gateway-auth.ts";
import { processNotificationJob } from "../server/notifications.ts";
import { publicationTerminalStatus } from "../server/publisher.ts";
import { Repository } from "../server/repository.ts";
import {
  FAST_POST_MATCH_REFILL_LIMIT,
  FAST_POST_MATCH_REFILL_MAX_COST_USD,
  parseFastPostMatchRefillRouteCheckpoint,
} from "../server/research-policy.ts";
import { appleAuthorizationGeneration } from "../server/apple.ts";
import type { HostedCitationAttestation } from "../server/research.ts";
import { capabilityHash, hmacBase64Url, sha256Hex } from "../server/security.ts";
import {
  WORKER_PIPELINE_CAPABILITY,
  WORKER_PIPELINE_PROTOCOL_VERSION,
  WORKER_PIPELINE_V4_BRIDGE_CAPABILITY,
} from "../server/worker-protocol.ts";
import { parseFeedbackSubmission } from "../server/feedback.ts";
import { createSelectionPlanV2 } from "../server/selection-plan-v2.ts";
import { buildPipelineOutcome } from "../server/pipeline-outcome-v2.ts";
import { GUIDED_BRIEF_BUDGET_USD, GUIDED_SCOUT_BUDGET_USD } from "../shared/product-policy.ts";
import type {
  CitationAttestationInput,
  PlaylistBrief,
  PlaylistGuidanceAnswer,
  PlaylistGuidanceQuestion,
} from "../shared/types.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseDescribe = databaseUrl ? describe.sequential : describe.skip;
const migrationDirectory = new URL("../postgres-migrations/", import.meta.url);
const migrationSql = readdirSync(migrationDirectory)
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort()
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

function guidanceQuestions(count: 1 | 2 | 3 = 2): PlaylistGuidanceQuestion[] {
  return Array.from({ length: count }, (_, questionIndex) => {
    const questionId = `q${questionIndex + 1}`;
    return {
      id: questionId,
      header: questionIndex === count - 1 ? "Flow" : `Scope ${questionIndex + 1}`,
      question: questionIndex === count - 1
        ? "How should the playlist move?"
        : `Which selection scope should guide question ${questionIndex + 1}?`,
      options: Array.from({ length: 3 }, (_unused, optionIndex) => ({
        id: `${questionId}-o${optionIndex + 1}`,
        label: `Option ${optionIndex + 1}`,
        description: `Question ${questionIndex + 1}, option ${optionIndex + 1}.`,
        recommended: optionIndex === 0,
      })),
    };
  });
}

function guidanceAnswers(questions: readonly PlaylistGuidanceQuestion[]): PlaylistGuidanceAnswer[] {
  return questions.map((question, index) => index === 0
    ? { questionId: question.id, optionId: question.options[0]!.id }
    : { questionId: question.id, customText: `Custom answer ${index + 1}` });
}

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

  async function createAutomaticRefillRun(
    label: string,
    status = "matching",
  ): Promise<string> {
    const runId = await repository.createRun(label, {
      ...brief,
      mode: "curated",
      targetSize: { min: 50, max: 50 },
    }, 0, 0.4);
    await repository.pool.query(
      `UPDATE research_runs SET auto_publish=true,status=$2,phase=$3,
         actual_cost_usd=1.1,reserved_cost_usd=0.2,approved_budget_usd=0.4
       WHERE id=$1`,
      [runId, status, status === "matching" ? "catalog_matching" : status],
    );
    return runId;
  }

  async function seedRefillBaseline(runId: string): Promise<void> {
    const sourceUrl = `https://music-history.example/${randomUUID()}`;
    const sourceIds = await repository.addSources(runId, [{
      url: sourceUrl,
      title: "Refill baseline source",
      sourceClass: "web",
      provenanceRoot: "music-history.example",
      note: "A cited integration-test source for the immutable refill baseline.",
    }]);
    const supported = [
      { title: "Baseline Song One", selectionRank: 4 },
      { title: "Baseline Song Two", selectionRank: 9 },
    ].map(({ title, selectionRank }) => {
      const citation = citationFixture(sourceUrl, title, "primary artist");
      return { title, selectionRank, citation };
    });
    await repository.addCitationAttestations(runId, supported.map(({ citation }) => citation.attestation));
    await repository.addCandidates(runId, [
      ...supported.map(({ title, selectionRank, citation }) => ({
        artist: "Integration Test Artist",
        title,
        album: null,
        releaseYear: null,
        durationMs: null,
        isrc: null,
        musicbrainzId: null,
        versionLabel: null,
        selectionRank,
        evidence: [{
          sourceUrl,
          state: "editorial" as const,
          supportScope: "track" as const,
          ...evidenceBinding,
          relationship: "primary artist",
          note: `${title} is supported by the cited editorial source.`,
          citationSupport: citation.support,
        }],
      })),
      {
        artist: "Unverified Artist",
        title: "Unverified Baseline Candidate",
        album: null,
        releaseYear: null,
        durationMs: null,
        isrc: null,
        musicbrainzId: null,
        versionLabel: null,
        selectionRank: 17,
        evidence: [],
      },
    ], sourceIds, "track_verification");
  }

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
    await expect(repository.ensureSchemaVersion(DATABASE_SCHEMA_V12_BRIDGE_SUPPORT)).resolves.toBeUndefined();
    // Model the staged rollout marker without pretending that V13 code can
    // execute against the V12 schema. The separately deployed bridge accepts
    // both markers; the V13 binary remains fail-closed until migration.
    await repository.setSetting("schema_version", "12");
    await expect(repository.ensureSchemaVersion(DATABASE_SCHEMA_V12_BRIDGE_SUPPORT)).resolves.toBeUndefined();
    await expect(repository.ensureSchemaVersion()).rejects.toThrow(/supported 13-13, found 12/u);
    await repository.setSetting("schema_version", DATABASE_SCHEMA_VERSION);
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
        to_regclass('capability_session_briefs')::text,
        to_regclass('citation_attestations')::text,
        to_regclass('public_playlists')::text,
        to_regclass('public_playlist_volumes')::text,
        to_regclass('apple_catalog_cache_entries')::text,
        to_regclass('apple_catalog_cache_leases')::text,
        to_regclass('apple_catalog_cache_events')::text
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
      "capability_session_briefs",
      "citation_attestations",
      "public_playlists",
      "public_playlist_volumes",
      "apple_catalog_cache_entries",
      "apple_catalog_cache_leases",
      "apple_catalog_cache_events",
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

  test("Apple catalog cache persists storefront-isolated payloads and provider telemetry", async () => {
    const runId = await repository.createRun("Apple cache integration", brief, 0, 1);
    const requestFingerprint = "a".repeat(64);
    const fetchedAt = "2026-07-19T12:00:00.000Z";
    const expiresAt = "2026-07-20T12:00:00.000Z";
    await repository.putAppleCatalogCacheEntry({
      storefront: "us",
      resourceKind: "search_view",
      requestFingerprint,
      payload: { songs: [{ id: "us-song" }], artists: [], albums: [], playlists: [] },
      fetchedAt,
      expiresAt,
    });
    await repository.putAppleCatalogCacheEntry({
      storefront: "gb",
      resourceKind: "search_view",
      requestFingerprint,
      payload: { songs: [{ id: "gb-song" }], artists: [], albums: [], playlists: [] },
      fetchedAt,
      expiresAt,
    });

    await expect(repository.getAppleCatalogCacheEntry("us", "search_view", requestFingerprint))
      .resolves.toMatchObject({ storefront: "us", payload: { songs: [{ id: "us-song" }] } });
    await expect(repository.getAppleCatalogCacheEntry("gb", "search_view", requestFingerprint))
      .resolves.toMatchObject({ storefront: "gb", payload: { songs: [{ id: "gb-song" }] } });

    await repository.recordAppleCatalogCacheEvent({
      runId,
      storefront: "us",
      resourceKind: "search_view",
      requestFingerprint,
      cacheState: "hit",
      providerState: "skipped",
      detail: { ageMs: 1200 },
      occurredAt: "2026-07-19T12:00:01.200Z",
    });
    const event = await repository.pool.query<{
      run_id: string;
      cache_state: string;
      provider_state: string;
      detail_json: { ageMs: number };
    }>(
      `SELECT run_id,cache_state,provider_state,detail_json
       FROM apple_catalog_cache_events WHERE run_id=$1`,
      [runId],
    );
    expect(event.rows).toEqual([{
      run_id: runId,
      cache_state: "hit",
      provider_state: "skipped",
      detail_json: { ageMs: 1200 },
    }]);

    await repository.deleteAppleCatalogCacheEntry("us", "search_view", requestFingerprint);
    await expect(repository.getAppleCatalogCacheEntry("us", "search_view", requestFingerprint)).resolves.toBeNull();
    await expect(repository.getAppleCatalogCacheEntry("gb", "search_view", requestFingerprint))
      .resolves.toMatchObject({ storefront: "gb" });

    const firstOwner = randomUUID();
    const secondOwner = randomUUID();
    await expect(repository.tryAcquireAppleCatalogCacheLease(
      "us", "search_view", requestFingerprint, firstOwner, 30_000,
    )).resolves.toBe(true);
    await expect(repository.tryAcquireAppleCatalogCacheLease(
      "us", "search_view", requestFingerprint, secondOwner, 30_000,
    )).resolves.toBe(false);
    await repository.pool.query(
      `UPDATE apple_catalog_cache_leases SET expires_at=now()-interval '1 second'
       WHERE storefront='us' AND resource_kind='search_view' AND request_fingerprint=$1`,
      [requestFingerprint],
    );
    await expect(repository.tryAcquireAppleCatalogCacheLease(
      "us", "search_view", requestFingerprint, secondOwner, 30_000,
    )).resolves.toBe(true);
    await repository.releaseAppleCatalogCacheLease(
      "us", "search_view", requestFingerprint, firstOwner,
    );
    await expect(repository.pool.query(
      `SELECT owner_id FROM apple_catalog_cache_leases
       WHERE storefront='us' AND resource_kind='search_view' AND request_fingerprint=$1`,
      [requestFingerprint],
    )).resolves.toMatchObject({ rows: [{ owner_id: secondOwner }] });
    await repository.pool.query(
      `UPDATE apple_catalog_cache_leases SET expires_at=now()-interval '1 second'
       WHERE storefront='us' AND resource_kind='search_view' AND request_fingerprint=$1`,
      [requestFingerprint],
    );
    await expect(repository.cleanupExpiredAppleCatalogCacheLeases(1)).resolves.toBe(1);
    await expect(repository.cleanupExpiredAppleCatalogCacheLeases(1)).resolves.toBe(0);
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
    expect((await repository.pool.query(
      `SELECT tsb.binding_kind,tsb.eligibility,tsb.source_url,tc.candidate_stage
       FROM track_scope_bindings tsb JOIN track_candidates tc ON tc.id=tsb.candidate_id
       WHERE tsb.run_id=$1`,
      [runId],
    )).rows).toEqual([expect.objectContaining({
      binding_kind: "track_specific_source",
      eligibility: "qualifying",
      source_url: sourceUrl,
      candidate_stage: "scope_qualified",
    })]);

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
    expect((await repository.pool.query(
      "SELECT count(*)::int count FROM track_scope_bindings WHERE run_id=$1 AND eligibility='qualifying'",
      [runId],
    )).rows[0]).toEqual({ count: 0 });
    expect((await repository.pool.query(
      "SELECT candidate_stage FROM track_candidates WHERE run_id=$1",
      [runId],
    )).rows[0]).toEqual({ candidate_stage: "discovered" });
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
    expect(run.progress).toMatchObject({
      targetTrackCount: null,
      sourceSummary: { total: 0, recentSources: [] },
      frontierSummary: {
        total: 1,
        complete: 0,
        active: 1,
        unresolved: 0,
        inaccessible: 0,
        discoveredCount: 1,
        recoveredCount: 0,
      },
      containerSummary: {
        total: 1,
        complete: 0,
        active: 1,
        unresolved: 0,
        inaccessible: 0,
        advertisedCount: 0,
        recoveredCount: 0,
      },
      matchSummary: { attempted: 0, accepted: 0, shortfall: null },
      publicationSummary: {
        volumeCount: 0,
        completedVolumes: 0,
        totalTracks: 0,
        appendedTracks: 0,
        currentVolume: null,
        status: null,
      },
    });
    expect(run.progress?.latestActivityAt).toEqual(expect.any(String));
  });

  test("publication completeness follows curated targets while exhaustive and hybrid runs remain strict", async () => {
    const createFixture = async (input: {
      mode: PlaylistBrief["mode"];
      targetMinimum: number | null;
      manifestTrackCount: number;
      reserveOutcomes: string[];
    }) => {
      const scopedBrief: PlaylistBrief = {
        ...brief,
        mode: input.mode,
        targetSize: input.mode === "exhaustive"
          ? null
          : { min: input.targetMinimum!, max: input.targetMinimum! },
      };
      const runId = await repository.createRun(
        `Publication completeness ${input.mode} ${randomUUID()}`,
        scopedBrief,
        0,
        1,
      );
      const manifestId = randomUUID();
      const manifestCandidateIds = Array.from(
        { length: input.manifestTrackCount },
        () => randomUUID(),
      );
      const reserveCandidateIds = input.reserveOutcomes.map(() => randomUUID());
      const allCandidates = [
        ...manifestCandidateIds.map((id) => ({ id, outcome: "accepted" })),
        ...reserveCandidateIds.map((id, index) => ({
          id,
          outcome: input.reserveOutcomes[index]!,
        })),
      ];
      for (const [index, candidate] of allCandidates.entries()) {
        await repository.pool.query(
          `INSERT INTO track_candidates(id,run_id,canonical_key,artist,title,outcome)
           VALUES($1,$2,$3,'Completeness Artist',$4,$5)`,
          [candidate.id, runId, `completeness:${index}:${randomUUID()}`, `Track ${index + 1}`, candidate.outcome],
        );
      }
      await repository.pool.query(
        `INSERT INTO manifests(id,run_id,name,description,content_hash)
         VALUES($1,$2,'Completeness fixture','Integration fixture',$3)`,
        [manifestId, runId, sha256Hex(`${runId}:${manifestId}`)],
      );
      for (const [position, candidateId] of manifestCandidateIds.entries()) {
        await repository.pool.query(
          `INSERT INTO manifest_tracks(manifest_id,position,candidate_id,catalog_id,artist,title)
           VALUES($1,$2,$3,$4,'Completeness Artist',$5)`,
          [manifestId, position, candidateId, `catalog-${position}`, `Track ${position + 1}`],
        );
      }
      await repository.pool.query(
        `INSERT INTO source_frontier(id,run_id,source_class,strategy,status,discovered_count,recovered_count,note)
         VALUES($1,$2,'web','publication completeness frontier','unresolved',2,1,'One documented gap')`,
        [randomUUID(), runId],
      );
      return repository.getPublicationCompleteness(runId, manifestId);
    };

    const curatedExact = await createFixture({
      mode: "curated",
      targetMinimum: 3,
      manifestTrackCount: 3,
      reserveOutcomes: ["overflow", "unavailable"],
    });
    expect(curatedExact).toEqual({ omittedCandidateCount: 0, unresolvedCoverageCount: 0 });
    expect(publicationTerminalStatus(curatedExact)).toBe("complete");

    const curatedShortfall = await createFixture({
      mode: "curated",
      targetMinimum: 3,
      manifestTrackCount: 2,
      reserveOutcomes: ["unavailable"],
    });
    expect(curatedShortfall).toEqual({ omittedCandidateCount: 1, unresolvedCoverageCount: 0 });
    expect(publicationTerminalStatus(curatedShortfall)).toBe("partial");

    for (const mode of ["exhaustive", "hybrid"] as const) {
      const strict = await createFixture({
        mode,
        targetMinimum: mode === "exhaustive" ? null : 2,
        manifestTrackCount: 2,
        reserveOutcomes: ["unavailable"],
      });
      expect(strict).toEqual({ omittedCandidateCount: 1, unresolvedCoverageCount: 1 });
      expect(publicationTerminalStatus(strict)).toBe("partial");
    }
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
      reuseDays: 30,
      forceFreshResearch: owner,
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
      });
    };
    const first = await createBrief("idempotent");
    vi.stubEnv("APP_MONTHLY_COST_LIMIT_USD", "5");
    const sameReservation = await Promise.all([
      repository.reserveProviderCost({ briefRequestId: first.id }, "same-operation", 0.2),
      repository.reserveProviderCost({ briefRequestId: first.id }, "same-operation", 0.2),
    ]);
    expect(new Set(sameReservation.map((item) => item.reservationId)).size).toBe(1);
    await repository.releaseProviderCost(sameReservation[0]!.reservationId);

    vi.stubEnv("APP_MONTHLY_COST_LIMIT_USD", "0.3");
    const [left, right] = await Promise.all([createBrief("left"), createBrief("right")]);
    const results = await Promise.allSettled([
      repository.reserveProviderCost({ briefRequestId: left.id }, "left-call", 0.2),
      repository.reserveProviderCost({ briefRequestId: right.id }, "right-call", 0.2),
    ]);
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<{ reservationId: string }> => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ statusCode: 402, code: "monthly_budget_reached" });
    await repository.releaseProviderCost(fulfilled[0]!.value.reservationId);
  });

  test("caps each guided brief across actual spend, active reservations, and the next call", async () => {
    vi.stubEnv("APP_MONTHLY_COST_LIMIT_USD", "100");
    const clientBucket = `guided-cost-cap-${randomUUID()}`;
    const request = await repository.createBriefRequest({
      prompt: "Guided cost cap",
      requestedTrackCount: 300,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
    });

    const first = await repository.reserveProviderCost(
      { briefRequestId: request.id },
      "guided-preflight",
      0.1,
    );
    await repository.reconcileProviderCost(first.reservationId, 0.1);
    await expect(repository.getBriefActualCostUsd(request.id)).resolves.toBeCloseTo(0.1, 6);

    const active = await repository.reserveProviderCost(
      { briefRequestId: request.id },
      "guided-refinement",
      0.1,
    );
    await expect(repository.reserveProviderCost(
      { briefRequestId: request.id },
      "guided-third-call",
      GUIDED_BRIEF_BUDGET_USD - 0.2 + 0.001,
    )).rejects.toMatchObject({ statusCode: 402, code: "brief_budget_reached" });

    await repository.releaseProviderCost(active.reservationId);
    await expect(repository.reserveProviderCost(
      { briefRequestId: request.id },
      "guided-boundary-call",
      GUIDED_BRIEF_BUDGET_USD - 0.1,
    )).resolves.toMatchObject({ reservationId: expect.any(String) });
  });

  test("accounts the canonical question scout against its own ceiling without reducing research allowance", async () => {
    vi.stubEnv("APP_MONTHLY_COST_LIMIT_USD", "100");
    const clientBucket = `guided-scout-partition-${randomUUID()}`;
    const request = await repository.createBriefRequest({
      prompt: "Canonical question scout accounting",
      requestedTrackCount: 50,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
    });

    const interpretation = await repository.reserveProviderCost(
      { briefRequestId: request.id },
      "brief.interpret:primary",
      0.1,
    );
    await repository.reconcileProviderCost(interpretation.reservationId, 0.1);

    const scout = await repository.reserveProviderCost(
      { briefRequestId: request.id },
      "brief.question_scout:primary",
      GUIDED_SCOUT_BUDGET_USD,
    );
    await repository.reconcileProviderCost(scout.reservationId, GUIDED_SCOUT_BUDGET_USD);

    await expect(repository.getBriefActualCostUsd(request.id)).resolves.toBeCloseTo(0.1, 6);
    await expect(repository.reserveProviderCost(
      { briefRequestId: request.id },
      "brief.question_scout:overflow",
      0.001,
    )).rejects.toMatchObject({ statusCode: 402, code: "brief_budget_reached" });
    await expect(repository.reserveProviderCost(
      { briefRequestId: request.id },
      "brief.interpret:remaining",
      GUIDED_BRIEF_BUDGET_USD - 0.1,
    )).resolves.toMatchObject({ reservationId: expect.any(String) });
  });

  test("serializes concurrent guided reservations against one brief budget", async () => {
    vi.stubEnv("APP_MONTHLY_COST_LIMIT_USD", "100");
    const clientBucket = `guided-cost-concurrent-${randomUUID()}`;
    const request = await repository.createBriefRequest({
      prompt: "Concurrent guided cost cap",
      requestedTrackCount: 50,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
    });

    const results = await Promise.allSettled([
      repository.reserveProviderCost({ briefRequestId: request.id }, "guided-left", 0.15),
      repository.reserveProviderCost({ briefRequestId: request.id }, "guided-right", 0.15),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { statusCode: 402, code: "brief_budget_reached" },
    });
  });

  test("records and blocks further work after a guided provider cost overrun", async () => {
    vi.stubEnv("APP_MONTHLY_COST_LIMIT_USD", "100");
    const clientBucket = `guided-cost-overrun-${randomUUID()}`;
    const request = await repository.createBriefRequest({
      prompt: "Guided provider overrun",
      requestedTrackCount: 50,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
    });
    const reservation = await repository.reserveProviderCost(
      { briefRequestId: request.id },
      "guided-overrun",
      0.1,
    );

    await expect(repository.reconcileProviderCost(
      reservation.reservationId,
      GUIDED_BRIEF_BUDGET_USD + 0.01,
      { total_tokens: 1 },
    )).rejects.toMatchObject({ statusCode: 402, code: "provider_cost_overrun" });
    await expect(repository.getBriefActualCostUsd(request.id))
      .resolves.toBeCloseTo(GUIDED_BRIEF_BUDGET_USD + 0.01, 6);
    await expect(repository.reserveProviderCost(
      { briefRequestId: request.id },
      "guided-after-overrun",
      0.001,
    )).rejects.toMatchObject({ statusCode: 402, code: "brief_budget_reached" });
    const persisted = await repository.pool.query<{ status: string; count: number }>(
      `SELECT r.status,
         (SELECT count(*)::int FROM cost_ledger l WHERE l.reservation_id=r.id) count
       FROM cost_reservations r WHERE r.id=$1`,
      [reservation.reservationId],
    );
    expect(persisted.rows[0]).toEqual({ status: "reconciled_overrun", count: 1 });
  });

  test("deleting a guided brief revokes access and preserves active provider accounting", async () => {
    vi.stubEnv("APP_MONTHLY_COST_LIMIT_USD", "100");
    vi.stubEnv("CAPABILITY_PEPPER", "integration-capability-pepper-32-bytes");
    const clientBucket = `guided-delete-active-cost-${randomUUID()}`;
    const request = await repository.createBriefRequest({
      prompt: "Private visitor prompt that must be deleted",
      requestedTrackCount: 50,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
    });
    const capabilities = new CapabilityService(repository);
    const reply = new ReplyStub();
    await capabilities.authorizeBrief(
      cookieRequest(""),
      reply as unknown as FastifyReply,
      request.id,
    );
    const authorizedRequest = cookieRequest(reply.headers.get("set-cookie")!.split(";")[0]!);
    await expect(capabilities.authenticateForBrief(authorizedRequest, request.id))
      .resolves.toMatchObject({ runId: null, accessId: null });
    const reservation = await repository.reserveProviderCost(
      { briefRequestId: request.id },
      "guided-delete-in-flight",
      0.1,
    );

    await expect(repository.deleteBriefRequest(request.id)).resolves.toBe(true);
    await expect(repository.getBriefRequest(request.id)).resolves.toBeNull();
    await expect(capabilities.authenticate(authorizedRequest))
      .rejects.toMatchObject({ statusCode: 401, code: "capability_required" });
    const retained = await repository.pool.query<{
      brief_request_id: string | null;
      status: string;
    }>(
      "SELECT brief_request_id,status FROM cost_reservations WHERE id=$1",
      [reservation.reservationId],
    );
    expect(retained.rows[0]).toEqual({ brief_request_id: request.id, status: "reserved" });
    const scrubbed = await repository.pool.query<{
      prompt: string;
      brief_json: unknown;
      questions_json: unknown;
      answers_json: unknown;
      status: string;
      expired: boolean;
    }>(
      `SELECT prompt,brief_json,questions_json,answers_json,status,(expires_at<=now()) expired
       FROM brief_requests WHERE id=$1`,
      [request.id],
    );
    expect(scrubbed.rows[0]).toEqual({
      prompt: "",
      brief_json: null,
      questions_json: null,
      answers_json: null,
      status: "failed",
      expired: true,
    });

    await expect(repository.reconcileProviderCost(
      reservation.reservationId,
      0.08,
      { total_tokens: 1 },
    )).resolves.toBeUndefined();
    const accounted = await repository.pool.query<{
      amount_usd: string;
      brief_request_id: string | null;
    }>(
      "SELECT amount_usd,brief_request_id FROM cost_ledger WHERE reservation_id=$1",
      [reservation.reservationId],
    );
    expect(Number(accounted.rows[0]!.amount_usd)).toBeCloseTo(0.08, 6);
    expect(accounted.rows[0]!.brief_request_id).toBe(request.id);
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

  test("allows repeated brief and run creation while preserving mutation and publication burst limits", async () => {
    const briefBucket = `unlimited-brief-${randomUUID()}`;
    const briefAttempts = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
      repository.createBriefRequest({
        prompt: `Repeated brief request ${index}`,
        model: "test-model",
        clientBucket: briefBucket,
        clientBucketAliases: [briefBucket],
      })));
    expect(briefAttempts.every((result) => result.status === "fulfilled")).toBe(true);

    const runBucket = `unlimited-run-${randomUUID()}`;
    const runAttempts = await Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
      repository.createRunIdempotent({
        prompt: `Repeated run request ${index}`,
        brief: { ...brief, title: `Repeated run ${index}` },
        estimateUsd: 0,
        approvedBudgetUsd: 1,
        clientBucket: runBucket,
        clientBucketAliases: [runBucket],
        idempotencyKey: `unlimited-run-${index}-${randomUUID()}`,
        reuseDays: 0,
        globalLimit: 100,
      })));
    expect(runAttempts.every((result) => result.status === "fulfilled")).toBe(true);

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
      { client_bucket: mutationBucket, action: "mutation", count: 1 },
      { client_bucket: publishBucket, action: "publish", count: 1 },
    ]));
    expect(counts.rows).toHaveLength(2);
  });

  test("serializes rolling rate limits when daily client-bucket alias sets overlap", async () => {
    const sharedBucket = `shared-rate-limit-${randomUUID()}`;
    const olderBucket = `older-rate-limit-${randomUUID()}`;
    const newerBucket = `newer-rate-limit-${randomUUID()}`;
    const attempts = await Promise.allSettled([
      repository.consumeRateLimit([sharedBucket, olderBucket], "mutation", 1, 24),
      repository.consumeRateLimit([sharedBucket, newerBucket], "mutation", 1, 24),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(attempts.find((result) => result.status === "rejected")).toMatchObject({
      reason: { statusCode: 429, code: "rate_limited" },
    });

    const count = await repository.pool.query<{ count: number }>(
      `SELECT count(*)::int count FROM rate_limit_events
       WHERE client_bucket=ANY($1::text[]) AND action='mutation'`,
      [[sharedBucket, olderBucket, newerBucket]],
    );
    expect(count.rows[0]!.count).toBe(1);
  });

  test("exempts only owner feedback from client limits while retaining anonymous and global limits", async () => {
    const feedback = parseFeedbackSubmission({
      kind: "bug",
      message: "The owner needs to submit another private regression report.",
      pagePath: "/feedback",
    });
    const ownerBucket = `owner-feedback-${randomUUID()}`;
    await repository.pool.query(
      `INSERT INTO rate_limit_events(client_bucket,action)
       SELECT $1,action FROM (VALUES
         ('feedback_hour'),('feedback_hour'),
         ('feedback_day'),('feedback_day'),('feedback_day'),('feedback_day'),('feedback_day')
       ) events(action)`,
      [ownerBucket],
    );
    await expect(repository.createFeedbackSubmission({
      submission: feedback,
      idempotencyKey: `owner-feedback-${randomUUID()}`,
      clientBucket: ownerBucket,
      clientBucketAliases: [ownerBucket],
      ownerRateLimitExempt: true,
    })).resolves.toMatchObject({ created: true });

    const ownerEvents = await repository.pool.query<{ action: string; count: number }>(
      `SELECT action,count(*)::int count FROM rate_limit_events
       WHERE client_bucket=ANY($1::text[]) OR client_bucket='feedback-global'
       GROUP BY action ORDER BY action`,
      [[ownerBucket]],
    );
    expect(ownerEvents.rows).toEqual([
      { action: "feedback_day", count: 5 },
      { action: "feedback_global_day", count: 1 },
      { action: "feedback_hour", count: 2 },
    ]);

    const anonymousBucket = `anonymous-feedback-${randomUUID()}`;
    await repository.pool.query(
      "INSERT INTO rate_limit_events(client_bucket,action) VALUES($1,'feedback_hour'),($1,'feedback_hour')",
      [anonymousBucket],
    );
    await expect(repository.createFeedbackSubmission({
      submission: feedback,
      idempotencyKey: `anonymous-feedback-${randomUUID()}`,
      clientBucket: anonymousBucket,
      clientBucketAliases: [anonymousBucket],
      ownerRateLimitExempt: false,
    })).rejects.toMatchObject({ statusCode: 429, code: "feedback_rate_limited" });

    await repository.pool.query(
      `INSERT INTO rate_limit_events(client_bucket,action)
       SELECT 'feedback-global','feedback_global_day' FROM generate_series(1,99)`,
    );
    await expect(repository.createFeedbackSubmission({
      submission: feedback,
      idempotencyKey: `owner-global-feedback-${randomUUID()}`,
      clientBucket: ownerBucket,
      clientBucketAliases: [ownerBucket],
      ownerRateLimitExempt: true,
    })).rejects.toMatchObject({ statusCode: 503, code: "feedback_global_limit" });
  });

  test("round-trips private feedback screenshots without exposing bytes in owner lists", async () => {
    // A valid 3x2 RGBA PNG with six distinct pixels exercises real binary
    // persistence rather than the one-pixel parser fixture used by unit tests.
    const screenshotBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAFklEQVR4nGP4z8DwHwwZ/v+HIAjBAACvag7y13hP6QAAAABJRU5ErkJggg==";
    const feedback = parseFeedbackSubmission({
      kind: "bug",
      message: "The attached screenshot captures a reproducible mobile layout failure.",
      pagePath: "/jobs",
      appVersion: "feedback-round-trip-test",
      image: {
        mimeType: "image/png",
        dataBase64: screenshotBase64,
        width: 3,
        height: 2,
      },
    });
    const bucket = `feedback-image-${randomUUID()}`;
    const created = await repository.createFeedbackSubmission({
      submission: feedback,
      idempotencyKey: `feedback-image-${randomUUID()}`,
      clientBucket: bucket,
      clientBucketAliases: [bucket],
      ownerRateLimitExempt: false,
    });

    const listed = await repository.listFeedbackSubmissions();
    expect(listed).toMatchObject({ total: 1, counts: { new: 1, reviewed: 0, resolved: 0 } });
    expect(listed.items[0]).toMatchObject({
      id: created.id,
      status: "new",
      image: {
        mimeType: "image/png",
        byteSize: Buffer.from(screenshotBase64, "base64").length,
        width: 3,
        height: 2,
        sha256: feedback.image?.sha256,
      },
    });
    expect(listed.items[0]?.image).not.toHaveProperty("dataBase64");
    expect(JSON.stringify(listed.items)).not.toContain(screenshotBase64);

    const storedImage = await repository.getFeedbackImage(created.id);
    expect(storedImage?.mimeType).toBe("image/png");
    expect(storedImage?.data.equals(Buffer.from(screenshotBase64, "base64"))).toBe(true);

    await expect(repository.updateFeedbackStatus(created.id, "reviewed", "owner@example.com"))
      .resolves.toMatchObject({ id: created.id, status: "reviewed" });
    await expect(repository.deleteFeedbackSubmission(created.id, "owner@example.com")).resolves.toBe(true);
    await expect(repository.getFeedbackImage(created.id)).resolves.toBeNull();
    await expect(repository.deleteFeedbackSubmission(created.id, "owner@example.com")).resolves.toBe(false);
  });

  test("anonymous brief and run requests do not consume daily quota events", async () => {
    const briefBucket = `anonymous-brief-unlimited-${randomUUID()}`;
    const createBrief = (label: string) => repository.createBriefRequest({
      prompt: `Anonymous brief request ${label}`,
      model: "test-model",
      clientBucket: briefBucket,
      clientBucketAliases: [briefBucket],
    });
    for (const label of ["one", "two", "three", "four"]) {
      await expect(createBrief(label)).resolves.toMatchObject({ created: true });
    }

    const runBucket = `anonymous-run-unlimited-${randomUUID()}`;
    const createRun = (label: string) => repository.createRunIdempotent({
      prompt: `Anonymous run request ${label}`,
      brief: { ...brief, title: `Anonymous run ${label}` },
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket: runBucket,
      clientBucketAliases: [runBucket],
      idempotencyKey: `anonymous-run-${label}-${randomUUID()}`,
      reuseDays: 0,
      globalLimit: 100,
    });
    for (const label of ["one", "two", "three", "four"]) {
      await expect(createRun(label)).resolves.toMatchObject({ created: true });
    }

    const events = await repository.pool.query<{ count: number }>(
      `SELECT count(*)::int count FROM rate_limit_events
       WHERE client_bucket=ANY($1::text[]) AND action=ANY($2::text[])`,
      [[briefBucket, runBucket], ["brief", "run"]],
    );
    expect(events.rows[0]?.count).toBe(0);
  });

  test("owner force-refresh never bypasses global run capacity", async () => {
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
        globalLimit: 1,
        forceFreshResearch: true,
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
      globalLimit: 100,
    });
    const runResults = await Promise.all([createRun(), createRun()]);
    expect(new Set(runResults.map((result) => result.runId)).size).toBe(1);
    expect(new Set(runResults.map((result) => result.accessId)).size).toBe(1);
    expect(runResults.filter((result) => result.created)).toHaveLength(1);

    const eventCounts = await repository.pool.query<{ count: number }>(
      `SELECT count(*)::int count FROM rate_limit_events
       WHERE client_bucket=ANY($1::text[]) AND action=ANY($2::text[])`,
      [[briefBucket, runBucket], ["brief", "run"]],
    );
    expect(eventCounts.rows[0]?.count).toBe(0);
  });

  test("persists the requested track count and rejects idempotent payload drift", async () => {
    const clientBucket = `brief-count-${randomUUID()}`;
    const key = `brief-count-${randomUUID()}`;
    const first = await repository.createBriefRequest({
      prompt: "Influential techno",
      requestedTrackCount: 50,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: key,
    });

    await expect(repository.getBriefRequest(first.id)).resolves.toMatchObject({
      prompt: "Influential techno",
      requestedTrackCount: 50,
    });
    await expect(repository.createBriefRequest({
      prompt: "Influential techno",
      requestedTrackCount: 50,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: key,
    })).resolves.toMatchObject({ id: first.id, created: false });
    await expect(repository.createBriefRequest({
      prompt: "Influential techno",
      requestedTrackCount: 100,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: key,
    })).rejects.toMatchObject({ statusCode: 409, code: "idempotency_conflict" });
  });

  test.each([1, 2, 3] as const)(
    "accepts one option or one custom answer for each of %i guided questions",
    async (questionCount) => {
      const clientBucket = `guided-${questionCount}-${randomUUID()}`;
      const request = await repository.createBriefRequest({
        prompt: `${questionCount} guided questions`,
        requestedTrackCount: 50,
        model: "test-model",
        clientBucket,
        clientBucketAliases: [clientBucket],
        idempotencyKey: randomUUID(),
      });
      const questions = guidanceQuestions(questionCount);
      await repository.saveBriefResult(request.id, {
        status: "awaiting_answers",
        brief: { ...brief, mode: "curated", targetSize: { min: 50, max: 50 } },
        questions,
      });

      await expect(repository.submitBriefAnswers({
        briefRequestId: request.id,
        idempotencyKey: `answers-${randomUUID()}`,
        answers: guidanceAnswers(questions),
      })).resolves.toEqual({ status: "finalizing", created: true });
      await expect(repository.getBriefRequest(request.id)).resolves.toMatchObject({
        status: "finalizing",
        answers: guidanceAnswers(questions),
      });
    },
  );

  test.each([
    {
      label: "missing answer",
      answers: (questions: PlaylistGuidanceQuestion[]) => [
        { questionId: questions[0]!.id, optionId: questions[0]!.options[0]!.id },
      ],
    },
    {
      label: "duplicate question",
      answers: (questions: PlaylistGuidanceQuestion[]) => [
        { questionId: questions[0]!.id, optionId: questions[0]!.options[0]!.id },
        { questionId: questions[0]!.id, customText: "Second answer to the same question" },
      ],
    },
    {
      label: "unknown question",
      answers: (questions: PlaylistGuidanceQuestion[]) => [
        { questionId: questions[0]!.id, optionId: questions[0]!.options[0]!.id },
        { questionId: "unknown-question", customText: "Unknown" },
      ],
    },
    {
      label: "option and custom answer together",
      answers: (questions: PlaylistGuidanceQuestion[]) => [
        {
          questionId: questions[0]!.id,
          optionId: questions[0]!.options[0]!.id,
          customText: "Also custom",
        },
        { questionId: questions[1]!.id, optionId: questions[1]!.options[0]!.id },
      ],
    },
    {
      label: "neither option nor custom answer",
      answers: (questions: PlaylistGuidanceQuestion[]) => [
        { questionId: questions[0]!.id },
        { questionId: questions[1]!.id, optionId: questions[1]!.options[0]!.id },
      ],
    },
    {
      label: "unknown option",
      answers: (questions: PlaylistGuidanceQuestion[]) => [
        { questionId: questions[0]!.id, optionId: "unknown-option" },
        { questionId: questions[1]!.id, optionId: questions[1]!.options[0]!.id },
      ],
    },
    {
      label: "oversized custom answer",
      answers: (questions: PlaylistGuidanceQuestion[]) => [
        { questionId: questions[0]!.id, customText: "x".repeat(501) },
        { questionId: questions[1]!.id, optionId: questions[1]!.options[0]!.id },
      ],
    },
    {
      label: "control character in custom answer",
      answers: (questions: PlaylistGuidanceQuestion[]) => [
        { questionId: questions[0]!.id, customText: "invalid\u0000answer" },
        { questionId: questions[1]!.id, optionId: questions[1]!.options[0]!.id },
      ],
    },
  ])("rejects a guided submission with $label without mutating it", async ({ answers }) => {
    const clientBucket = `guided-invalid-${randomUUID()}`;
    const request = await repository.createBriefRequest({
      prompt: "Invalid guided answer",
      requestedTrackCount: 50,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
    });
    const questions = guidanceQuestions(2);
    await repository.saveBriefResult(request.id, {
      status: "awaiting_answers",
      brief: { ...brief, mode: "curated", targetSize: { min: 50, max: 50 } },
      questions,
    });

    await expect(repository.submitBriefAnswers({
      briefRequestId: request.id,
      idempotencyKey: `invalid-answers-${randomUUID()}`,
      answers: answers(questions),
    })).rejects.toMatchObject({ statusCode: 400, code: "invalid_guidance_answers" });
    await expect(repository.getBriefRequest(request.id)).resolves.toMatchObject({
      status: "awaiting_answers",
      answers: [],
    });
  });

  test.each([0, 4])("rejects a stored guided flow with %i questions", async (questionCount) => {
    const clientBucket = `guided-count-invalid-${questionCount}-${randomUUID()}`;
    const request = await repository.createBriefRequest({
      prompt: "Invalid guided question count",
      requestedTrackCount: 50,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
    });
    const questions = Array.from({ length: questionCount }, (_unused, index) =>
      guidanceQuestions(2)[index % 2]!).map((question, index) => ({
        ...question,
        id: `stored-q${index + 1}`,
        options: question.options.map((option, optionIndex) => ({
          ...option,
          id: `stored-q${index + 1}-o${optionIndex + 1}`,
        })),
      }));
    await repository.saveBriefResult(request.id, {
      status: "awaiting_answers",
      brief: { ...brief, mode: "curated", targetSize: { min: 50, max: 50 } },
      questions,
    });

    await expect(repository.submitBriefAnswers({
      briefRequestId: request.id,
      idempotencyKey: `invalid-count-${randomUUID()}`,
      answers: guidanceAnswers(questions),
    })).rejects.toMatchObject({ statusCode: 400, code: "invalid_guidance_answers" });
  });

  test("makes guided answer replay single-effect and rejects key or payload drift", async () => {
    const clientBucket = `guided-replay-${randomUUID()}`;
    const request = await repository.createBriefRequest({
      prompt: "Guided replay",
      requestedTrackCount: 75,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
    });
    const questions = guidanceQuestions(2);
    const answers = guidanceAnswers(questions);
    await repository.saveBriefResult(request.id, {
      status: "awaiting_answers",
      brief: { ...brief, mode: "curated", targetSize: { min: 75, max: 75 } },
      questions,
    });
    const idempotencyKey = `guided-replay-${randomUUID()}`;
    const submit = (submittedAnswers = answers, key = idempotencyKey) =>
      repository.submitBriefAnswers({
        briefRequestId: request.id,
        idempotencyKey: key,
        answers: submittedAnswers,
      });

    await expect(submit()).resolves.toEqual({ status: "finalizing", created: true });
    await expect(submit()).resolves.toEqual({ status: "finalizing", created: false });
    await expect(submit([
      answers[0]!,
      { questionId: questions[1]!.id, optionId: questions[1]!.options[1]!.id },
    ])).rejects.toMatchObject({ statusCode: 409, code: "idempotency_conflict" });
    await expect(submit(answers, `different-key-${randomUUID()}`))
      .rejects.toMatchObject({ statusCode: 409, code: "idempotency_conflict" });
  });

  test("serializes concurrent identical guided answer submissions", async () => {
    const clientBucket = `guided-concurrent-${randomUUID()}`;
    const request = await repository.createBriefRequest({
      prompt: "Concurrent guided submission",
      requestedTrackCount: 100,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
    });
    const questions = guidanceQuestions(3);
    const answers = guidanceAnswers(questions);
    await repository.saveBriefResult(request.id, {
      status: "awaiting_answers",
      brief: { ...brief, mode: "curated", targetSize: { min: 100, max: 100 } },
      questions,
    });
    const idempotencyKey = `guided-concurrent-${randomUUID()}`;
    const submit = () => repository.submitBriefAnswers({
      briefRequestId: request.id,
      idempotencyKey,
      answers,
    });

    const results = await Promise.all([submit(), submit()]);
    expect(results).toEqual(expect.arrayContaining([
      { status: "finalizing", created: true },
      { status: "finalizing", created: false },
    ]));
    const stored = await repository.pool.query<{
      status: string;
      answers_json: PlaylistGuidanceAnswer[];
      answers_idempotency_key: string;
      answers_hash: string;
    }>(
      `SELECT status,answers_json,answers_idempotency_key,answers_hash
       FROM brief_requests WHERE id=$1`,
      [request.id],
    );
    expect(stored.rows[0]).toMatchObject({
      status: "finalizing",
      answers_json: answers,
      answers_idempotency_key: idempotencyKey,
    });
    expect(stored.rows[0]!.answers_hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("a stale preflight completion cannot overwrite durably submitted guided answers", async () => {
    const clientBucket = `guided-stale-preflight-${randomUUID()}`;
    const request = await repository.createBriefRequest({
      prompt: "Stale guided preflight",
      requestedTrackCount: 50,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
    });
    const questions = guidanceQuestions(2);
    const answers = guidanceAnswers(questions);
    const canonicalBrief: PlaylistBrief = {
      ...brief,
      mode: "curated",
      targetSize: { min: 50, max: 50 },
    };
    await repository.saveBriefResult(request.id, {
      status: "awaiting_answers",
      brief: canonicalBrief,
      questions,
    });
    await repository.submitBriefAnswers({
      briefRequestId: request.id,
      idempotencyKey: `guided-stale-preflight-${randomUUID()}`,
      answers,
    });

    // Simulate a reclaimed preflight worker completing after the answer
    // transaction. This write must be ignored rather than reverting the state.
    await repository.saveBriefResult(request.id, {
      status: "awaiting_answers",
      expectedStatus: "queued",
      brief: { ...canonicalBrief, title: "Stale model result" },
      questions: guidanceQuestions(3),
    });

    await expect(repository.getBriefRequest(request.id)).resolves.toMatchObject({
      status: "finalizing",
      brief: canonicalBrief,
      questions,
      answers,
    });
  });

  test("rejects public playlist sizes above the bounded fast-path maximum", async () => {
    const clientBucket = `brief-count-limit-${randomUUID()}`;
    await expect(repository.createBriefRequest({
      prompt: "An oversized playlist",
      requestedTrackCount: 301,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ statusCode: 400, code: "invalid_track_count" });
  });

  test("persists the durable automatic-publication intent on One Command runs", async () => {
    const clientBucket = `auto-publish-${randomUUID()}`;
    const created = await repository.createRunIdempotent({
      prompt: "One Command playlist",
      brief: { ...brief, mode: "curated", targetSize: { min: 50, max: 50 } },
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: `auto-publish-${randomUUID()}`,
      autoPublish: true,
      reuseDays: 0,
      globalLimit: 100,
    });

    await expect(repository.getRun(created.runId)).resolves.toMatchObject({ autoPublish: true });
  });

  test("rejects a reused run idempotency key when the confirmed count or prompt changed", async () => {
    const clientBucket = `run-idempotency-${randomUUID()}`;
    const idempotencyKey = `run-idempotency-${randomUUID()}`;
    const create = (prompt: string, count: number) => repository.createRunIdempotent({
      prompt,
      brief: { ...brief, mode: "curated", targetSize: { min: count, max: count } },
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey,
      autoPublish: true,
      reuseDays: 0,
      globalLimit: 100,
    });

    await expect(create("Fifty influential tracks", 50)).resolves.toMatchObject({ created: true });
    await expect(create("One hundred influential tracks", 100)).rejects.toMatchObject({
      statusCode: 409,
      code: "idempotency_conflict",
    });
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
      globalLimit: 100,
    });

    const created = await create();
    expect(created).toMatchObject({ created: true, reused: false, status: "queued" });
    const originalRoute = await repository.getResearchCheckpoint(created.runId, "fast:route:fast_curated_v3") as any;
    expect(originalRoute).toMatchObject({ status: "queued", profile: "fast_curated_v3", matchingReserveMs: 40_000 });
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
    await expect(repository.getResearchCheckpoint(created.runId, "fast:route:fast_curated_v3"))
      .resolves.toEqual(originalRoute);

    // This represents a legacy run created before route checkpoints existed.
    // An idempotent retry may repair its queue handoff, but must remain deep.
    await repository.pool.query(
      "DELETE FROM research_checkpoints WHERE run_id=$1 AND phase='fast:route:fast_curated_v3'",
      [created.runId],
    );
    await create();
    await expect(repository.getResearchCheckpoint(created.runId, "fast:route:fast_curated_v3"))
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
       WHERE status IN ('queued','researching','ready_for_matching','matching','publishing')
         AND deleted_at IS NULL`,
    );
    expect(active.rows[0]?.count).toBe(1);
  });

  test("saved review jobs do not consume global research capacity", async () => {
    const create = (label: string) => {
      const bucket = `review-capacity-${label}-${randomUUID()}`;
      return repository.createRunIdempotent({
        prompt: `Review capacity request ${label}`,
        brief: { ...brief, title: `Review capacity ${label}` },
        estimateUsd: 0,
        approvedBudgetUsd: 1,
        clientBucket: bucket,
        clientBucketAliases: [bucket],
        idempotencyKey: `review-capacity-${label}-${randomUUID()}`,
        reuseDays: 0,
        globalLimit: 1,
      });
    };

    const first = await create("first");
    await repository.updateRun(first.runId, { status: "visitor_review", phase: "exception_review" });
    await expect(create("second")).resolves.toMatchObject({ created: true });
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

  test("stamps queue protocol from persisted pipeline state across mixed v4 and v5 workers", async () => {
    vi.stubEnv("WORKER_CONCURRENCY", "4");
    const v1RunId = await repository.createRun("Mixed rollout V1", brief, 0, 1);
    const v2Brief: PlaylistBrief = {
      ...brief,
      mode: "curated",
      title: "Mixed rollout V2",
      targetSize: { min: 25, max: 25 },
    };
    const v2RunId = await repository.createRun("Mixed rollout V2", v2Brief, 0, 1);
    await repository.savePipelineSelectionPlan(
      v2RunId,
      createSelectionPlanV2({ prompt: "Mixed rollout V2", brief: v2Brief }),
    );

    // Enqueue V2 first and lie in both payloads. The database trigger must use
    // authoritative run state, and a bridge worker must skip the older V2 row
    // rather than blocking the runnable V1 row behind it.
    const v2Job = await repository.enqueueJob({
      kind: "integration-v2",
      runId: v2RunId,
      payload: { pipelineVersion: "legacy_v1" },
      availableAt: new Date(Date.now() - 10_000),
      dedupeKey: randomUUID(),
    });
    const v1Job = await repository.enqueueJob({
      kind: "integration-v1",
      runId: v1RunId,
      payload: { pipelineVersion: "catalog_first_v2" },
      dedupeKey: randomUUID(),
    });
    const stamped = await repository.pool.query<{
      id: string;
      pipeline_version: string;
      minimum_worker_protocol: number;
    }>(
      `SELECT id,pipeline_version,minimum_worker_protocol FROM job_queue
       WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [[v1Job.id, v2Job.id]],
    );
    expect(Object.fromEntries(stamped.rows.map((row) => [row.id, {
      pipelineVersion: row.pipeline_version,
      minimumWorkerProtocol: row.minimum_worker_protocol,
    }]))).toEqual({
      [v1Job.id]: { pipelineVersion: "legacy_v1", minimumWorkerProtocol: 4 },
      [v2Job.id]: { pipelineVersion: "catalog_first_v2", minimumWorkerProtocol: 5 },
    });

    const bridgeLease = await repository.leaseNextJob(
      "bridge-v4",
      30_000,
      WORKER_PIPELINE_V4_BRIDGE_CAPABILITY,
    );
    expect(bridgeLease).toMatchObject({
      id: v1Job.id,
      pipelineVersion: "legacy_v1",
      minimumWorkerProtocol: 4,
    });
    await repository.completeJob(v1Job.id, "bridge-v4");
    await expect(repository.leaseNextJob(
      "bridge-v4",
      30_000,
      WORKER_PIPELINE_V4_BRIDGE_CAPABILITY,
    )).resolves.toBeNull();
    expect((await repository.pool.query(
      "SELECT status,attempts FROM job_queue WHERE id=$1",
      [v2Job.id],
    )).rows[0]).toMatchObject({ status: "queued", attempts: 0 });

    const v5Lease = await repository.leaseNextJob(
      "worker-v5",
      30_000,
      WORKER_PIPELINE_CAPABILITY,
    );
    expect(v5Lease).toMatchObject({
      id: v2Job.id,
      pipelineVersion: "catalog_first_v2",
      minimumWorkerProtocol: 5,
    });
    await repository.completeJob(v2Job.id, "worker-v5");

    // An exhausted V2 lease is also invisible to the v4 sweeper. Only a
    // capable v5 worker may terminalize it and its owning run.
    const exhaustedRunId = await repository.createRun("Mixed rollout exhausted V2", v2Brief, 0, 1);
    await repository.savePipelineSelectionPlan(
      exhaustedRunId,
      createSelectionPlanV2({ prompt: "Mixed rollout exhausted V2", brief: v2Brief }),
    );
    const exhaustedJob = await repository.enqueueJob({
      kind: "research",
      runId: exhaustedRunId,
      dedupeKey: randomUUID(),
      maxAttempts: 1,
    });
    expect(await repository.leaseNextJob(
      "worker-v5-exhausted",
      30_000,
      WORKER_PIPELINE_CAPABILITY,
    )).toMatchObject({ id: exhaustedJob.id, attempts: 1 });
    await repository.pool.query(
      "UPDATE job_queue SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [exhaustedJob.id],
    );
    await expect(repository.leaseNextJob(
      "bridge-v4-sweeper",
      30_000,
      WORKER_PIPELINE_V4_BRIDGE_CAPABILITY,
    )).resolves.toBeNull();
    expect((await repository.pool.query(
      "SELECT status FROM job_queue WHERE id=$1",
      [exhaustedJob.id],
    )).rows[0]?.status).toBe("leased");
    await expect(repository.leaseNextJob(
      "worker-v5-sweeper",
      30_000,
      WORKER_PIPELINE_CAPABILITY,
    )).resolves.toBeNull();
    expect((await repository.pool.query(
      "SELECT status FROM job_queue WHERE id=$1",
      [exhaustedJob.id],
    )).rows[0]?.status).toBe("failed");
    expect((await repository.getRun(exhaustedRunId)).status).toBe("failed");
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

  test("Pipeline V2 manifest lock requires authoritative scope provenance and never relaxes hard version policy", async () => {
    const v2Brief: PlaylistBrief = {
      ...brief,
      title: "V2 manifest eligibility",
      description: "A curated set whose manifest must retain only exact, proven studio recordings.",
      mode: "curated",
      include: [],
      exclude: [],
      orderingPolicy: "artist/title",
      targetSize: { min: 3, max: 3 },
    };
    const runId = await repository.createRun("V2 manifest eligibility", v2Brief, 0, 1);
    const plan = createSelectionPlanV2({ prompt: "V2 manifest eligibility", brief: v2Brief });
    await repository.savePipelineSelectionPlan(runId, plan);
    const sourceUrl = `https://v2-evidence.example/${randomUUID()}`;
    const sourceIds = await repository.addSources(runId, [{
      url: sourceUrl,
      title: "Exact track evidence",
      sourceClass: "web",
      provenanceRoot: "v2-evidence.example",
      note: "A track-specific integration fixture.",
    }]);
    const attestedTitles = ["Safe Studio Recording", "Wrong Live Recording"];
    const citations = new Map(attestedTitles.map((title) => [
      title,
      citationFixture(sourceUrl, title, "primary artist", v2Brief.subjectEntities[0]),
    ]));
    await repository.addCitationAttestations(
      runId,
      [...citations.values()].map((citation) => citation.attestation),
    );
    await repository.addCandidates(runId, [
      ...attestedTitles.map((title) => ({
        artist: "V2 Artist",
        title,
        album: "V2 Album",
        releaseYear: 2024,
        durationMs: 180_000,
        isrc: null,
        musicbrainzId: null,
        versionLabel: null,
        evidence: [{
          sourceUrl,
          state: "verified" as const,
          supportScope: "track" as const,
          subjectEntity: v2Brief.subjectEntities[0]!,
          subjectRelationship: v2Brief.relationship,
          relationship: "primary artist",
          note: "Exact track support.",
          citationSupport: citations.get(title)!.support,
        }],
      })),
      {
        artist: "V2 Artist",
        title: "Unproven Recording",
        album: "V2 Album",
        releaseYear: 2024,
        durationMs: 180_000,
        isrc: null,
        musicbrainzId: null,
        versionLabel: null,
        evidence: [{
          sourceUrl,
          state: "inferred" as const,
          supportScope: "track" as const,
          subjectEntity: v2Brief.subjectEntities[0]!,
          subjectRelationship: v2Brief.relationship,
          relationship: "primary artist",
          note: "This candidate deliberately has no qualifying attested claim.",
        }],
      },
    ], sourceIds, "track_verification");
    const candidates = new Map((await repository.listCandidates(runId)).map((candidate) => [candidate.title, candidate]));
    for (const [title, candidate] of candidates) {
      await repository.saveMatch(runId, {
        candidateId: candidate.id,
        status: "accepted",
        basis: "Exact compatible catalog identity",
        score: 1,
        song: {
          id: `catalog-${title.toLowerCase().replaceAll(" ", "-")}`,
          name: title === "Wrong Live Recording" ? `${title} (Live)` : title,
          artistName: candidate.artist,
          albumName: candidate.album ?? "",
          releaseDate: "2024-01-01",
          durationInMillis: 180_000,
        },
        alternatives: [],
      });
    }
    await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review" });

    const manifest = await repository.createManifest(runId);
    expect(manifest.tracks.map((track) => track.title)).toEqual(["Safe Studio Recording"]);
    const outcomes = await repository.pool.query<{ title: string; status: string; outcome: string }>(
      `SELECT c.title,m.status,c.outcome FROM track_candidates c
       JOIN catalog_matches m ON m.run_id=c.run_id AND m.candidate_id=c.id
       WHERE c.run_id=$1 ORDER BY c.title`,
      [runId],
    );
    expect(outcomes.rows).toEqual([
      { title: "Safe Studio Recording", status: "accepted", outcome: "accepted" },
      { title: "Unproven Recording", status: "unsupported", outcome: "unsupported" },
      { title: "Wrong Live Recording", status: "unsupported", outcome: "unsupported" },
    ]);
    const deficit = await repository.pool.query<{
      required_count: number;
      actual_count: number;
      deficit_count: number;
      reason_code: string;
    }>(
      `SELECT required_count,actual_count,deficit_count,reason_code
       FROM pipeline_deficit_ledger WHERE run_id=$1 ORDER BY observed_at DESC LIMIT 1`,
      [runId],
    );
    expect(deficit.rows[0]).toEqual({
      required_count: 3,
      actual_count: 1,
      deficit_count: 2,
      reason_code: "manifest_hard_constraint_shortfall",
    });
  });

  test("Pipeline V2 manifest eligibility retains separate factual and editorial claims for composite requests", async () => {
    const compositeBrief: PlaylistBrief = {
      ...brief,
      title: "Influential Paulinho da Costa performances",
      description: "Influential recordings Paulinho da Costa performed on.",
      mode: "curated",
      subjectEntities: ["Paulinho da Costa"],
      relationship: "Paulinho da Costa performed on and the recording was influential",
      include: [],
      exclude: [],
      evidencePolicy: "track-level performance credit and independent historical support",
      orderingPolicy: "influence rank",
      targetSize: { min: 2, max: 2 },
    };
    const runId = await repository.createRun(compositeBrief.title, compositeBrief, 0, 1);
    const plan = createSelectionPlanV2({
      prompt: compositeBrief.description,
      brief: compositeBrief,
    });
    expect(plan.intents).toEqual(expect.arrayContaining(["factual_relationship", "editorial_ranking"]));
    await repository.savePipelineSelectionPlan(runId, plan);

    const factualUrl = `https://session-credit.example/${randomUUID()}`;
    const editorialUrl = `https://music-history.example/${randomUUID()}`;
    const sourceIds = await repository.addSources(runId, [{
      url: factualUrl,
      title: "Exact session credit",
      sourceClass: "web",
      provenanceRoot: "session-credit.example",
      note: "Exact track-level performance evidence.",
    }, {
      url: editorialUrl,
      title: "Independent historical assessment",
      sourceClass: "web",
      provenanceRoot: "music-history.example",
      note: "Independent track-level influence evidence.",
    }]);
    const factualRelationship = "Paulinho da Costa performed percussion on this track";
    const editorialRelationship = "This recording was culturally influential and historically important";
    const qualifiedFactual = citationFixture(
      factualUrl,
      "Composite Qualified Recording",
      factualRelationship,
      compositeBrief.subjectEntities[0],
    );
    const qualifiedEditorial = citationFixture(
      editorialUrl,
      "Composite Qualified Recording",
      editorialRelationship,
      compositeBrief.subjectEntities[0],
    );
    const factualOnly = citationFixture(
      factualUrl,
      "Factual Only Recording",
      factualRelationship,
      compositeBrief.subjectEntities[0],
    );
    await repository.addCitationAttestations(runId, [
      qualifiedFactual.attestation,
      qualifiedEditorial.attestation,
      factualOnly.attestation,
    ]);
    await repository.addCandidates(runId, [{
      artist: "Session Artist",
      title: "Composite Qualified Recording",
      album: "Composite Album",
      releaseYear: 1982,
      durationMs: 180_000,
      isrc: null,
      musicbrainzId: null,
      versionLabel: null,
      evidence: [{
        sourceUrl: factualUrl,
        state: "verified" as const,
        supportScope: "track" as const,
        subjectEntity: compositeBrief.subjectEntities[0]!,
        subjectRelationship: compositeBrief.relationship,
        relationship: factualRelationship,
        note: factualRelationship,
        citationSupport: qualifiedFactual.support,
      }, {
        sourceUrl: editorialUrl,
        state: "editorial" as const,
        supportScope: "editorial" as const,
        subjectEntity: compositeBrief.subjectEntities[0]!,
        subjectRelationship: compositeBrief.relationship,
        relationship: editorialRelationship,
        note: editorialRelationship,
        citationSupport: qualifiedEditorial.support,
      }],
    }, {
      artist: "Session Artist",
      title: "Factual Only Recording",
      album: "Composite Album",
      releaseYear: 1983,
      durationMs: 181_000,
      isrc: null,
      musicbrainzId: null,
      versionLabel: null,
      evidence: [{
        sourceUrl: factualUrl,
        state: "verified" as const,
        supportScope: "track" as const,
        subjectEntity: compositeBrief.subjectEntities[0]!,
        subjectRelationship: compositeBrief.relationship,
        relationship: factualRelationship,
        note: factualRelationship,
        citationSupport: factualOnly.support,
      }],
    }], sourceIds, "track_verification");

    const candidates = await repository.listCandidates(runId);
    for (const candidate of candidates) {
      await repository.saveMatch(runId, {
        candidateId: candidate.id,
        status: "accepted",
        basis: "Exact compatible catalog identity",
        score: 1,
        song: {
          id: `catalog-${candidate.title.toLowerCase().replaceAll(" ", "-")}`,
          name: candidate.title,
          artistName: candidate.artist,
          albumName: candidate.album ?? "",
          releaseDate: `${candidate.releaseYear}-01-01`,
          durationInMillis: candidate.durationMs ?? undefined,
        },
        alternatives: [],
      });
    }
    await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review" });

    const manifest = await repository.createManifest(runId);
    expect(manifest.tracks.map((track) => track.title)).toEqual(["Composite Qualified Recording"]);
    const storedBindings = await repository.pool.query<{
      title: string;
      scope_axis: string;
      provenance_root: string;
    }>(
      `SELECT c.title,b.scope_axis,s.provenance_root
       FROM track_scope_bindings b
       JOIN track_candidates c ON c.id=b.candidate_id
       JOIN source_records s ON s.id=b.source_record_id
       WHERE b.run_id=$1 ORDER BY c.title,b.scope_axis`,
      [runId],
    );
    expect(storedBindings.rows.filter((row) => row.title === "Composite Qualified Recording"))
      .toEqual(expect.arrayContaining([
        {
          title: "Composite Qualified Recording",
          scope_axis: "factual_relationship",
          provenance_root: "session-credit.example",
        },
        {
          title: "Composite Qualified Recording",
          scope_axis: "editorial_ranked",
          provenance_root: "music-history.example",
        },
      ]));
    const rejected = await repository.pool.query<{ status: string; outcome: string }>(
      `SELECT m.status,c.outcome FROM track_candidates c
       JOIN catalog_matches m ON m.run_id=c.run_id AND m.candidate_id=c.id
       WHERE c.run_id=$1 AND c.title='Factual Only Recording'`,
      [runId],
    );
    expect(rejected.rows[0]).toEqual({ status: "unsupported", outcome: "unsupported" });
  });

  test("Pipeline V2 atomically persists catalog-grown candidates with stable identity and authoritative scope provenance", async () => {
    const catalogBrief: PlaylistBrief = {
      ...brief,
      title: "House music essentials",
      description: "A source-backed survey of house music.",
      mode: "curated",
      subjectEntities: ["house music"],
      relationship: "represents house music",
      include: ["house music"],
      exclude: [],
      versionPolicy: "studio recordings",
      evidencePolicy: "trusted scoped editorial sources",
      orderingPolicy: "editorial rank",
      targetSize: { min: 2, max: 2 },
    };
    const runId = await repository.createRun(catalogBrief.title, catalogBrief, 0, 1);
    const plan = createSelectionPlanV2({ prompt: catalogBrief.description, brief: catalogBrief });
    await repository.savePipelineSelectionPlan(runId, plan);
    const sourceUrl = "https://music.apple.com/us/playlist/house-essentials/pl.house-integration";
    const discovered = {
      song: {
        id: "apple-house-integration-1",
        name: "Warehouse Signal",
        artistName: "South Side Unit",
        albumName: "Warehouse Signal",
        releaseDate: "1987-04-01",
        durationInMillis: 360_000,
        isrc: "USAAA8700002",
      },
      source: {
        url: sourceUrl,
        title: "House Essentials",
        sourceClass: "apple" as const,
        provenanceRoot: "apple_music_editorial:pl.house-integration",
        note: "Apple Music editorial playlist scoped to house music.",
      },
      container: {
        providerId: "pl.house-integration",
        title: "House Essentials",
        metadata: { curatorName: "Apple Music Dance", playlistType: "editorial" },
      },
      bindings: [{
        bindingKind: "catalog_editorial_membership" as const,
        eligibility: "qualifying" as const,
        scopeAxis: "genre" as const,
        scopeValue: "house music",
        relationship: "represents house music",
        confidence: 0.9,
        sourceUrl,
        note: "Exact membership in a trusted, scope-matched Apple Music editorial playlist.",
      }, {
        bindingKind: "catalog_editorial_membership" as const,
        eligibility: "qualifying" as const,
        scopeAxis: "geography" as const,
        scopeValue: "Chicago",
        relationship: "represents the Chicago house scene",
        confidence: 0.9,
        sourceUrl,
        note: "The same exact editorial membership also binds the requested Chicago scope axis.",
      }],
    };
    const versions = { pipelineVersion: plan.pipelineVersion, policyVersion: plan.policyVersion };

    const first = await repository.persistCatalogDiscoveredCandidates(runId, [discovered], versions);
    const second = await repository.persistCatalogDiscoveredCandidates(runId, [discovered], versions);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).toMatchObject({ appleSongId: discovered.song.id, inserted: true });
    expect(second[0]).toMatchObject({
      candidateId: first[0]!.candidateId,
      appleSongId: discovered.song.id,
      inserted: false,
    });
    const candidates = await repository.listCandidates(runId);
    expect(candidates).toEqual([expect.objectContaining({
      id: first[0]!.candidateId,
      artist: discovered.song.artistName,
      title: discovered.song.name,
      candidateStage: "scope_qualified",
      scopeBindings: expect.arrayContaining([
        expect.objectContaining({
          bindingKind: "catalog_editorial_membership",
          eligibility: "qualifying",
          scopeAxis: "genre",
          scopeValue: "house music",
          sourceUrl,
          sourceRecordId: expect.any(String),
          researchContainerId: expect.any(String),
          provenancePath: expect.arrayContaining([
            expect.objectContaining({ kind: "provenance_root", id: discovered.source.provenanceRoot }),
            expect.objectContaining({ kind: "catalog_recording", id: discovered.song.id }),
          ]),
        }),
        expect.objectContaining({ scopeAxis: "geography", scopeValue: "Chicago" }),
      ]),
    })]);
    const counts = await repository.pool.query<{
      sources: number;
      containers: number;
      candidates: number;
      bindings: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM source_records WHERE run_id=$1) sources,
         (SELECT count(*)::int FROM research_containers WHERE run_id=$1) containers,
         (SELECT count(*)::int FROM track_candidates WHERE run_id=$1) candidates,
         (SELECT count(*)::int FROM track_scope_bindings WHERE run_id=$1) bindings`,
      [runId],
    );
    expect(counts.rows[0]).toEqual({ sources: 1, containers: 1, candidates: 1, bindings: 2 });
  });

  test("Pipeline V2 enforces cross-axis proof, relationship evidence, and decade ranges without rejecting a valid track", async () => {
    const scopedBrief: PlaylistBrief = {
      ...brief,
      title: "French-language American house from the 1990s",
      description: "American house music released in the 1990s and sung in French.",
      mode: "curated",
      subjectEntities: ["American French-language house music"],
      relationship: "is a house genre recording from the American scene sung in French",
      include: ["American house music from the 1990s", "French-language recordings"],
      exclude: [],
      orderingPolicy: "artist/title",
      targetSize: { min: 3, max: 3 },
    };
    const runId = await repository.createRun(scopedBrief.title, scopedBrief, 0, 1);
    const plan = createSelectionPlanV2({ prompt: scopedBrief.description, brief: scopedBrief });
    await repository.savePipelineSelectionPlan(runId, plan);
    const sourceUrl = `https://v2-cross-axis.example/${randomUUID()}`;
    const sourceIds = await repository.addSources(runId, [{
      url: sourceUrl,
      title: "Cross-axis track evidence",
      sourceClass: "web",
      provenanceRoot: "v2-cross-axis.example",
      note: "Exact track-level integration evidence.",
    }]);
    const fixtures = [
      {
        title: "Qualified 1996 Recording",
        releaseYear: 1996,
        relationship: scopedBrief.relationship,
      },
      {
        title: "Wrong Relationship Recording",
        releaseYear: 1996,
        relationship: "is featured on an unrelated editorial playlist",
      },
      {
        title: "Outside Era Recording",
        releaseYear: 1989,
        relationship: scopedBrief.relationship,
      },
    ].map((item) => ({ ...item, citation: citationFixture(
      sourceUrl,
      item.title,
      item.relationship,
      scopedBrief.subjectEntities[0],
    ) }));
    await repository.addCitationAttestations(runId, fixtures.map((item) => item.citation.attestation));
    await repository.addCandidates(runId, fixtures.map((item) => ({
      artist: "Fixture Artist",
      title: item.title,
      album: "Fixture Album",
      releaseYear: item.releaseYear,
      durationMs: 180_000,
      isrc: null,
      musicbrainzId: null,
      versionLabel: null,
      evidence: [{
        sourceUrl,
        state: "verified" as const,
        supportScope: "track" as const,
        subjectEntity: scopedBrief.subjectEntities[0]!,
        subjectRelationship: scopedBrief.relationship,
        relationship: item.relationship,
        note: `${scopedBrief.subjectEntities[0]} ${item.relationship}`,
        citationSupport: item.citation.support,
      }],
    })), sourceIds, "track_verification");
    const candidates = await repository.listCandidates(runId);
    for (const candidate of candidates) {
      await repository.saveMatch(runId, {
        candidateId: candidate.id,
        status: "accepted",
        basis: "Exact compatible catalog identity",
        score: 1,
        song: {
          id: `catalog-${candidate.title.toLowerCase().replaceAll(" ", "-")}`,
          name: candidate.title,
          artistName: candidate.artist,
          albumName: candidate.album ?? "",
          releaseDate: `${candidate.releaseYear}-01-01`,
          durationInMillis: 180_000,
          genreNames: ["House"],
        },
        alternatives: [],
      });
    }
    await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review" });

    const manifest = await repository.createManifest(runId);
    expect(manifest.tracks.map((track) => track.title)).toEqual(["Qualified 1996 Recording"]);
    const outcomes = await repository.pool.query<{ title: string; status: string }>(
      `SELECT c.title,m.status FROM track_candidates c
       JOIN catalog_matches m ON m.run_id=c.run_id AND m.candidate_id=c.id
       WHERE c.run_id=$1 ORDER BY c.title`,
      [runId],
    );
    expect(outcomes.rows).toEqual([
      { title: "Outside Era Recording", status: "unsupported" },
      { title: "Qualified 1996 Recording", status: "accepted" },
      { title: "Wrong Relationship Recording", status: "unsupported" },
    ]);
    const bindingAxes = await repository.pool.query<{ scope_axis: string; scope_value: string }>(
      `SELECT scope_axis,scope_value FROM track_scope_bindings b
       JOIN track_candidates c ON c.id=b.candidate_id
       WHERE b.run_id=$1 AND c.title='Qualified 1996 Recording'
       ORDER BY scope_axis,scope_value`,
      [runId],
    );
    expect(bindingAxes.rows).toEqual(expect.arrayContaining([
      { scope_axis: "genre", scope_value: "house music" },
      { scope_axis: "geography", scope_value: "American" },
      { scope_axis: "language", scope_value: "French" },
      { scope_axis: "genre", scope_value: scopedBrief.relationship },
    ]));
  });

  test("Pipeline V2 operational sweep derives and deduplicates owner alerts from durable telemetry", async () => {
    const occurredAt = new Date();
    const windowEndedAt = new Date(occurredAt);
    windowEndedAt.setUTCMinutes(0, 0, 0);
    windowEndedAt.setUTCHours(windowEndedAt.getUTCHours() + 1);
    let publicationRunId = "";
    for (let index = 0; index < 3; index += 1) {
      const scopedBrief: PlaylistBrief = {
        ...brief,
        title: `Pipeline operational signal ${index + 1}`,
        mode: "curated",
        targetSize: { min: 25, max: 25 },
      };
      const runId = await repository.createRun(scopedBrief.title, scopedBrief, 0, 1);
      publicationRunId ||= runId;
      const plan = createSelectionPlanV2({ prompt: scopedBrief.title, brief: scopedBrief });
      await repository.savePipelineSelectionPlan(runId, plan);
      await repository.pool.query(
        "UPDATE research_runs SET status='partial',phase='no_compatible_tracks',completed_at=$2 WHERE id=$1",
        [runId, occurredAt],
      );
      await repository.savePipelineOutcome(runId, buildPipelineOutcome({
        pipelineVersion: plan.pipelineVersion,
        policyVersion: plan.policyVersion,
        status: "no_compatible_tracks",
        targetTrackCount: 25,
        discoveredTrackCount: 0,
        qualifiedTrackCount: 0,
        selectedTrackCount: 0,
        publishedTrackCount: 0,
        frontierExhausted: true,
        reasonCodes: [
          "apple_circuit_open",
          ...(index < 2 ? ["local_contract_rejected"] : []),
        ],
        completedAt: occurredAt.toISOString(),
      }));
      if (index === 0) {
        await repository.recordAudit("worker", "pipeline.pagination_loop", {
          reasonCode: "pagination_loop_detected",
        }, runId);
        await repository.recordAppleCatalogCacheEvent({
          runId,
          storefront: "us",
          resourceKind: "search_view",
          requestFingerprint: "a".repeat(64),
          cacheState: "miss",
          providerState: "invalid",
          detail: { errorName: "MalformedCatalogResponse" },
          occurredAt: occurredAt.toISOString(),
        });
      }
    }
    await repository.enqueueNotification("publication_orphaned", {
      deduplicationKey: `operational-publication-orphan:${publicationRunId}`,
      runId: publicationRunId,
      manifestId: "integration-manifest",
    });

    const first = await repository.runPipelineV2OperationalAlertSweep({ windowEndedAt });
    expect(first.alerts.map((alert) => alert.kind)).toEqual([
      "pipeline_zero_result_spike",
      "pipeline_local_contract_rejections",
      "pipeline_provider_circuit_repeated",
      "pipeline_pagination_loop",
      "pipeline_endpoint_drift",
      "pipeline_publication_divergence",
    ]);
    const second = await repository.runPipelineV2OperationalAlertSweep({ windowEndedAt });
    expect(second.notificationIds).toEqual(first.notificationIds);
    const notifications = await repository.pool.query<{ kind: string; count: number }>(
      `SELECT kind,count(*)::int count FROM notification_outbox
       WHERE kind LIKE 'pipeline_%' GROUP BY kind ORDER BY kind`,
    );
    expect(notifications.rows).toHaveLength(6);
    expect(notifications.rows.every((row) => row.count === 1)).toBe(true);
  });

  test("Pipeline V2 automatic publication finishes as a non-error when hard eligibility rejects every Apple match", async () => {
    const emptyBrief: PlaylistBrief = {
      ...brief,
      title: "V2 safe zero result",
      description: "A V2 run whose only Apple match lacks authoritative scope evidence.",
      mode: "curated",
      include: [],
      exclude: [],
      targetSize: { min: 1, max: 1 },
    };
    const runId = await repository.createRun("V2 safe zero result", emptyBrief, 0, 1);
    const plan = createSelectionPlanV2({ prompt: "V2 safe zero result", brief: emptyBrief });
    await repository.savePipelineSelectionPlan(runId, plan);
    await repository.addCandidates(runId, [{
      artist: "Unproven Artist",
      title: "Unproven Track",
      album: "Unproven Album",
      releaseYear: 2024,
      durationMs: 180_000,
      isrc: null,
      musicbrainzId: null,
      versionLabel: null,
      evidence: [],
    }], new Map(), "track_verification");
    const candidate = (await repository.listCandidates(runId))[0]!;
    await repository.saveMatch(runId, {
      candidateId: candidate.id,
      status: "accepted",
      basis: "Exact compatible catalog identity",
      score: 1,
      song: {
        id: "catalog-unproven-track",
        name: candidate.title,
        artistName: candidate.artist,
        albumName: candidate.album ?? "",
        releaseDate: "2024-01-01",
        durationInMillis: 180_000,
      },
      alternatives: [],
    });
    await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review" });

    await expect(repository.queueAutomaticPublication(runId)).resolves.toBeUndefined();

    const terminal = await repository.pool.query<{
      status: string;
      phase: string;
      error: string | null;
      match_status: string;
      candidate_outcome: string;
      pipeline_outcome: string;
      selected_track_count: number;
    }>(
      `SELECT r.status,r.phase,r.error,m.status match_status,c.outcome candidate_outcome,
         po.status pipeline_outcome,po.selected_track_count
       FROM research_runs r
       JOIN track_candidates c ON c.run_id=r.id
       JOIN catalog_matches m ON m.run_id=r.id AND m.candidate_id=c.id
       JOIN pipeline_outcomes po ON po.run_id=r.id
       WHERE r.id=$1`,
      [runId],
    );
    expect(terminal.rows[0]).toEqual({
      status: "partial",
      phase: "manifest_policy_empty",
      error: null,
      match_status: "unsupported",
      candidate_outcome: "unsupported",
      pipeline_outcome: "no_compatible_tracks",
      selected_track_count: 0,
    });
    const publicationJobs = await repository.pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM job_queue WHERE run_id=$1 AND kind='publication'",
      [runId],
    );
    expect(publicationJobs.rows[0]?.count).toBe(0);
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

  test("guided chronological order reorders the highest-ranked curated membership without changing it", async () => {
    const chronologicalBrief: PlaylistBrief = {
      ...brief,
      title: "Chronological guided mix",
      mode: "curated",
      orderingPolicy: "chronological by release date",
      targetSize: { min: 1, max: 3 },
    };
    const runId = await repository.createRun("Chronological guided mix", chronologicalBrief, 0, 1);
    await repository.addCandidates(runId, [
      { selectionRank: 1, artist: "Artist A", title: "Selected Newest", album: "Album A", releaseYear: 2005, durationMs: 180_000, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [] },
      { selectionRank: 2, artist: "Artist B", title: "Selected Oldest", album: "Album B", releaseYear: 1990, durationMs: 181_000, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [] },
      { selectionRank: 3, artist: "Artist C", title: "Selected Middle", album: "Album C", releaseYear: 2000, durationMs: 182_000, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [] },
      { selectionRank: 4, artist: "Artist D", title: "Unselected Earliest", album: "Album D", releaseYear: 1980, durationMs: 183_000, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [] },
    ], new Map(), "unverified");
    const candidates = await repository.listCandidates(runId);
    for (const candidate of candidates) {
      await repository.saveMatch(runId, {
        candidateId: candidate.id,
        status: "accepted",
        basis: "Exact compatible match",
        score: 1,
        song: {
          id: `catalog-${candidate.title.toLowerCase().replaceAll(" ", "-")}`,
          name: candidate.title,
          artistName: candidate.artist,
          albumName: candidate.album ?? "",
          releaseDate: `${candidate.releaseYear}-01-01`,
          durationInMillis: candidate.durationMs ?? undefined,
        },
        alternatives: [],
      });
    }
    await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review" });

    const manifest = await repository.createManifest(runId);
    expect(manifest.tracks.map((track) => track.title)).toEqual([
      "Selected Oldest",
      "Selected Middle",
      "Selected Newest",
    ]);
    const excluded = await repository.pool.query<{ outcome: string; status: string }>(
      `SELECT c.outcome,m.status
       FROM track_candidates c
       JOIN catalog_matches m ON m.candidate_id=c.id AND m.run_id=c.run_id
       WHERE c.run_id=$1 AND c.title='Unselected Earliest'`,
      [runId],
    );
    expect(excluded.rows[0]).toEqual({ outcome: "overflow", status: "overflow" });
  });

  test.each(["smooth listening flow", "high-contrast flow"])(
    "manifests interleave artists and albums after selecting the highest-ranked tracks for %s",
    async (orderingPolicy) => {
    const sequencedBrief: PlaylistBrief = {
      ...brief,
      title: "Sequenced mix",
      mode: "curated",
      orderingPolicy,
      targetSize: { min: 1, max: 6 },
    };
    const runId = await repository.createRun("Sequenced mix", sequencedBrief, 0, 1);
    await repository.addCandidates(runId, [
      { selectionRank: 1, artist: "Artist A", title: "A1", album: "Album A", releaseYear: 2001, durationMs: 180_000, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [] },
      { selectionRank: 2, artist: "Artist A", title: "A2", album: "Album A", releaseYear: 2002, durationMs: 181_000, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [] },
      { selectionRank: 3, artist: "Artist A", title: "A3", album: "Album A", releaseYear: 2003, durationMs: 182_000, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [] },
      { selectionRank: 4, artist: "Artist B", title: "B1", album: "Album B", releaseYear: 2004, durationMs: 183_000, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [] },
      { selectionRank: 5, artist: "Artist B", title: "B2", album: "Album B", releaseYear: 2005, durationMs: 184_000, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [] },
      { selectionRank: 6, artist: "Artist C", title: "C1", album: "Album C", releaseYear: 2006, durationMs: 185_000, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [] },
      { selectionRank: 7, artist: "Artist D", title: "D0", album: "Album D", releaseYear: 1990, durationMs: 179_000, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [] },
    ], new Map(), "unverified");
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
          genreNames: ["Electronic"],
          releaseDate: `${candidate.releaseYear}-01-01`,
          durationInMillis: candidate.durationMs ?? undefined,
        },
        alternatives: [],
      });
    }
    await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review" });

    const manifest = await repository.createManifest(runId);
    expect(new Set(manifest.tracks.map((track) => track.title)))
      .toEqual(new Set(["A1", "A2", "A3", "B1", "B2", "C1"]));
    expect(manifest.tracks.map((track) => track.title)).not.toContain("D0");
    for (let index = 1; index < manifest.tracks.length; index += 1) {
      expect(manifest.tracks[index]?.artist).not.toBe(manifest.tracks[index - 1]?.artist);
    }
    const overflow = await repository.pool.query<{ outcome: string; status: string }>(
      `SELECT c.outcome,m.status
       FROM track_candidates c
       JOIN catalog_matches m ON m.candidate_id=c.id AND m.run_id=c.run_id
       WHERE c.run_id=$1 AND c.title='D0'`,
      [runId],
    );
    expect(overflow.rows[0]).toEqual({ outcome: "overflow", status: "overflow" });
    },
  );

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

  test("requires an explicit visitor choice before a no-primary Apple alternative can enter the manifest", async () => {
    const selectionBrief: PlaylistBrief = {
      ...brief,
      title: "Manual Apple version choice",
      mode: "curated",
      targetSize: { min: 1, max: 1 },
    };
    const runId = await repository.createRun("Manual Apple version choice", selectionBrief, 0, 1);
    await repository.addCandidates(runId, [{
      selectionRank: 1,
      artist: "Expected Artist",
      title: "Expected Track",
      album: null,
      releaseYear: null,
      durationMs: null,
      isrc: null,
      musicbrainzId: null,
      versionLabel: null,
      evidence: [],
    }], new Map(), "unverified");
    const candidate = (await repository.listCandidates(runId))[0]!;
    const alternative = {
      id: "catalog-title-only-alternative",
      name: "Expected Track",
      artistName: "Different Artist",
      albumName: "Catalog Result",
    };
    await repository.saveMatch(runId, {
      candidateId: candidate.id,
      status: "review",
      basis: "Multiple title matches require visitor review",
      score: 0.35,
      song: null,
      alternatives: [alternative],
    });
    await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review" });

    await expect(repository.listCatalogTracks(runId, 1, 200)).resolves.toMatchObject({
      selectableCount: 0,
      unmatchedCount: 1,
      requestedTrackCount: 1,
      items: [{
        candidateId: candidate.id,
        song: null,
        alternatives: [alternative],
        selectable: false,
        selected: false,
      }],
    });
    await repository.updateRun(runId, { status: "visitor_review", phase: "catalog_matching_shortfall" });
    await expect(repository.finalizeCatalogSelection(runId, {
      useRecommended: true,
      excludedCandidateIds: [],
      overrides: [],
    })).rejects.toMatchObject({ code: "playlist_target_shortfall" });
    await expect(repository.finalizeCatalogSelection(runId, {
      selected: [{ candidateId: candidate.id, catalogId: "not-a-server-choice" }],
    })).rejects.toMatchObject({ code: "catalog_match_not_permitted" });

    const manifest = await repository.finalizeCatalogSelection(runId, {
      selected: [{ candidateId: candidate.id, catalogId: alternative.id }],
    });
    expect(manifest.tracks).toEqual([expect.objectContaining({
      candidateId: candidate.id,
      catalogId: alternative.id,
      artist: "Expected Artist",
      title: "Expected Track",
    })]);
  });

  test("automatic publication locks a safe partial manifest below the requested count", async () => {
    const clientBucket = `partial.${randomUUID()}`;
    const partialBrief: PlaylistBrief = {
      ...brief,
      title: "Safe partial automatic playlist",
      mode: "curated",
      targetSize: { min: 2, max: 2 },
    };
    const created = await repository.createRunIdempotent({
      prompt: "Safe partial automatic playlist",
      brief: partialBrief,
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      autoPublish: true,
      reuseDays: 0,
    });
    const runId = created.runId;
    await repository.addCandidates(runId, [
      { selectionRank: 1, artist: "Partial Artist", title: "Matched", album: null, releaseYear: null, durationMs: null, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [] },
      { selectionRank: 2, artist: "Partial Artist", title: "Unavailable", album: null, releaseYear: null, durationMs: null, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [] },
    ], new Map(), "unverified");
    const candidates = new Map((await repository.listCandidates(runId)).map((candidate) => [candidate.title, candidate]));
    await repository.saveMatch(runId, {
      candidateId: candidates.get("Matched")!.id,
      status: "accepted",
      basis: "Unique exact metadata",
      score: 1,
      song: {
        id: "catalog-partial-matched",
        name: "Matched",
        artistName: "Partial Artist",
        albumName: "Partial Album",
      },
      alternatives: [],
    });
    await repository.saveMatch(runId, {
      candidateId: candidates.get("Unavailable")!.id,
      status: "unavailable",
      basis: "No compatible Apple recording",
      score: 0,
      song: null,
      alternatives: [],
    });
    await repository.updateRun(runId, { status: "visitor_review", phase: "exception_review" });

    const manifest = await repository.finalizeCatalogSelection(runId, {
      useRecommended: true,
      excludedCandidateIds: [],
      overrides: [],
      automatic: true,
    });

    expect(manifest.tracks).toEqual([expect.objectContaining({
      title: "Matched",
      catalogId: "catalog-partial-matched",
    })]);
    await expect(repository.getPublicationCompleteness(runId, manifest.id)).resolves.toEqual({
      omittedCandidateCount: 1,
      unresolvedCoverageCount: 0,
    });
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
      max_attempts: 2,
    }]);
  });

  test("candidate-refill generation CAS is replay-safe and freezes its baseline, target, rank, and budget", async () => {
    const runId = await createAutomaticRefillRun("Candidate refill generation CAS");
    await seedRefillBaseline(runId);

    const concurrent = await Promise.all([
      repository.queueAutomaticCandidateRefill(runId, "US", 7, 0),
      repository.queueAutomaticCandidateRefill(runId, "US", 7, 0),
    ]);
    expect(concurrent.sort()).toEqual(["in_flight", "queued"]);

    const checkpointBefore = await repository.getResearchCheckpoint(
      runId,
      "fast:post-match-refill:1:route",
    );
    const route = parseFastPostMatchRefillRouteCheckpoint(checkpointBefore, 1);
    expect(route).toMatchObject({
      generation: 1,
      additionalCandidateGoal: 7,
      storefront: "us",
      baselineEligibleCount: 2,
      targetEligibleCount: 9,
      baselineSelectionRank: 17,
    });
    const queued = await repository.pool.query<{
      dedupe_key: string;
      payload_json: Record<string, unknown>;
      max_attempts: number;
    }>(
      `SELECT dedupe_key,payload_json,max_attempts FROM job_queue
       WHERE run_id=$1 AND kind='research' AND payload_json->>'postMatchRefill'='true'`,
      [runId],
    );
    expect(queued.rows).toEqual([{
      dedupe_key: `research-refill:${runId}:1`,
      payload_json: expect.objectContaining({
        runId,
        fast: true,
        postMatchRefill: true,
        refillGeneration: 1,
        additionalCandidateGoal: 7,
        storefront: "us",
      }),
      max_attempts: 2,
    }]);
    const runAfterQueue = await repository.pool.query<{
      status: string;
      phase: string;
      actual_cost_usd: string;
      reserved_cost_usd: string;
      approved_budget_usd: string;
    }>(
      `SELECT status,phase,actual_cost_usd,reserved_cost_usd,approved_budget_usd
       FROM research_runs WHERE id=$1`,
      [runId],
    );
    expect(runAfterQueue.rows[0]).toMatchObject({
      status: "researching",
      phase: "catalog_refill_research",
    });
    expect(Number(runAfterQueue.rows[0]!.approved_budget_usd)).toBeCloseTo(
      Number(runAfterQueue.rows[0]!.actual_cost_usd)
        + Number(runAfterQueue.rows[0]!.reserved_cost_usd)
        + FAST_POST_MATCH_REFILL_MAX_COST_USD,
      6,
    );

    await repository.addCandidates(runId, [{
      artist: "Later Artist",
      title: "Later Candidate Must Not Move Baseline",
      album: null,
      releaseYear: null,
      durationMs: null,
      isrc: null,
      musicbrainzId: null,
      versionLabel: null,
      selectionRank: 25,
      evidence: [],
    }], new Map(), "unverified");
    await expect(repository.queueAutomaticCandidateRefill(runId, "us", 120, 0))
      .resolves.toBe("in_flight");
    expect(await repository.getResearchCheckpoint(runId, "fast:post-match-refill:1:route"))
      .toEqual(checkpointBefore);
    expect(Number((await repository.pool.query<{ approved_budget_usd: string }>(
      "SELECT approved_budget_usd FROM research_runs WHERE id=$1",
      [runId],
    )).rows[0]!.approved_budget_usd)).toBeCloseTo(1.65, 6);
  });

  test("candidate refill refuses terminal runs without mutating jobs, checkpoints, or budget", async () => {
    for (const status of ["complete", "publishing", "failed"] as const) {
      const runId = await createAutomaticRefillRun(`Terminal candidate refill ${status}`, status);
      await expect(repository.queueAutomaticCandidateRefill(runId, "us", 8, 0))
        .resolves.toBe("not_needed");
      const state = await repository.pool.query<{
        jobs: number;
        checkpoints: number;
        approved_budget_usd: string;
      }>(
        `SELECT
           (SELECT count(*)::int FROM job_queue WHERE run_id=$1) jobs,
           (SELECT count(*)::int FROM research_checkpoints
             WHERE run_id=$1 AND phase LIKE 'fast:post-match-refill:%') checkpoints,
           approved_budget_usd
         FROM research_runs WHERE id=$1`,
        [runId],
      );
      expect(state.rows[0]).toEqual({ jobs: 0, checkpoints: 0, approved_budget_usd: "0.400000" });
    }
  });

  test("candidate refill caps at two generations and treats an older-generation replay as in flight", async () => {
    const runId = await createAutomaticRefillRun("Candidate refill generation ceiling");
    await expect(repository.queueAutomaticCandidateRefill(runId, "us", 8, 0)).resolves.toBe("queued");
    await repository.pool.query(
      `UPDATE job_queue SET status='complete',completed_at=now()
       WHERE run_id=$1 AND dedupe_key=$2`,
      [runId, `research-refill:${runId}:1`],
    );
    await expect(repository.queueAutomaticCandidateRefill(runId, "us", 8, 1)).resolves.toBe("queued");

    // A generation-one matching lease may replay after generation two was
    // committed but before its own completion was acknowledged. It must see
    // the later durable handoff, not terminalize the run as exhausted.
    await expect(repository.queueAutomaticCandidateRefill(runId, "us", 8, 1))
      .resolves.toBe("in_flight");
    await expect(repository.queueAutomaticCandidateRefill(runId, "us", 8, FAST_POST_MATCH_REFILL_LIMIT))
      .resolves.toBe("exhausted");

    const generations = await repository.pool.query<{
      generation: string;
      dedupe_key: string;
    }>(
      `SELECT payload_json->>'refillGeneration' generation,dedupe_key
       FROM job_queue WHERE run_id=$1 AND kind='research'
         AND payload_json->>'postMatchRefill'='true'
       ORDER BY payload_json->>'refillGeneration'`,
      [runId],
    );
    expect(generations.rows).toEqual([
      { generation: "1", dedupe_key: `research-refill:${runId}:1` },
      { generation: "2", dedupe_key: `research-refill:${runId}:2` },
    ]);
    expect(await repository.getResearchCheckpoint(runId, "fast:post-match-refill:3:route"))
      .toBeNull();
  });

  test("candidate-refill research survives one expired lease before terminal failure", async () => {
    const runId = await createAutomaticRefillRun("Candidate refill lease replay");
    await expect(repository.queueAutomaticCandidateRefill(runId, "us", 8, 0)).resolves.toBe("queued");

    const firstLease = await repository.leaseNextJob("refill-worker-one", 30_000);
    expect(firstLease).toMatchObject({
      runId,
      kind: "research",
      attempts: 1,
      maxAttempts: 2,
      payload: expect.objectContaining({ postMatchRefill: true, refillGeneration: 1 }),
    });
    await repository.pool.query(
      "UPDATE job_queue SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [firstLease!.id],
    );
    const replayLease = await repository.leaseNextJob("refill-worker-two", 30_000);
    expect(replayLease).toMatchObject({
      id: firstLease!.id,
      runId,
      attempts: 2,
      maxAttempts: 2,
    });
    expect((await repository.getRun(runId)).status).toBe("researching");

    await repository.pool.query(
      "UPDATE job_queue SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [firstLease!.id],
    );
    await expect(repository.leaseNextJob("refill-worker-final", 30_000)).resolves.toBeNull();
    const terminal = await repository.pool.query<{ status: string; attempts: number }>(
      "SELECT status,attempts FROM job_queue WHERE id=$1",
      [firstLease!.id],
    );
    expect(terminal.rows[0]).toEqual({ status: "failed", attempts: 2 });
    expect((await repository.getRun(runId)).status).toBe("failed");
  });

  test("One Command queues the next bounded recovery from inside the current matching lease", async () => {
    const runId = await repository.createRun(
      "Automatic catalog recovery",
      { ...brief, mode: "curated", targetSize: { min: 2, max: 2 } },
      0,
      1,
    );
    await repository.pool.query(
      "UPDATE research_runs SET auto_publish=true,status='matching',phase='catalog_matching' WHERE id=$1",
      [runId],
    );
    await repository.addCandidates(runId, [{
      artist: "Recovery Artist", title: "Automatic Retry", album: null, releaseYear: null,
      durationMs: null, isrc: null, musicbrainzId: null, versionLabel: null, evidence: [],
    }], new Map(), "unverified");
    const candidate = (await repository.listCandidates(runId))[0]!;
    await repository.saveTimeoutMatches(runId, [candidate.id], RETRYABLE_CATALOG_MATCH_BASES[0]);
    await repository.enqueueJob({
      kind: "matching",
      runId,
      payload: { runId, storefront: "us" },
      dedupeKey: `matching:${runId}`,
    });
    await repository.pool.query(
      `UPDATE job_queue SET status='leased',lease_owner='original-matching',
         lease_expires_at=now()+interval '5 minutes'
       WHERE run_id=$1 AND kind='matching' AND payload_json->>'retryIncomplete' IS NULL`,
      [runId],
    );

    await expect(repository.queueAutomaticCatalogRecovery(runId, "us", 0, 1)).resolves.toBe("queued");
    await expect(repository.queueAutomaticCatalogRecovery(runId, "us", 0, 1)).resolves.toBe("in_flight");
    await repository.pool.query(
      `UPDATE job_queue SET status='leased',lease_owner='recovery-one',
         lease_expires_at=now()+interval '5 minutes'
       WHERE run_id=$1 AND payload_json->>'recoveryGeneration'='1'`,
      [runId],
    );
    await expect(repository.queueAutomaticCatalogRecovery(runId, "us", 1, 1)).resolves.toBe("queued");

    const generations = await repository.pool.query<{
      generation: string;
      refill_generation: string;
      dedupe_key: string;
      status: string;
    }>(
      `SELECT payload_json->>'recoveryGeneration' generation,
              payload_json->>'refillGeneration' refill_generation,dedupe_key,status
       FROM job_queue WHERE run_id=$1 AND payload_json->>'retryIncomplete'='true'
       ORDER BY payload_json->>'recoveryGeneration'`,
      [runId],
    );
    expect(generations.rows).toEqual([
      {
        generation: "1",
        refill_generation: "1",
        dedupe_key: `matching-recovery:${runId}:1:refill:1`,
        status: "leased",
      },
      {
        generation: "2",
        refill_generation: "1",
        dedupe_key: `matching-recovery:${runId}:2:refill:1`,
        status: "queued",
      },
    ]);
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
    const activeVolume = await repository.createPublicationVolume({
      manifestId,
      volumeNumber: 1,
      volumeCount: 2,
      startPosition: 0,
      endPosition: 24,
      status: "publishing",
    });
    await repository.updatePublicationVolume(activeVolume.id, { applePlaylistId: "p.retriable-terminal" });
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
      applePlaylistId: "p.retriable-terminal",
      lastError: "Apple publication failed after the final attempt; provider details were redacted.",
    });
    expect((await repository.pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM orphan_playlists WHERE publication_volume_id=$1",
      [activeVolume.id],
    )).rows[0]?.count).toBe(0);
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
      "gênio could not interpret this request after the final attempt.",
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
    expect(briefView?.error).toBe("gênio could not interpret this request after the final attempt.");
    expect(runView?.error).toBe("Research could not be completed after the final attempt.");
    expect(publicResult.error).toBe("Research could not be completed after the final attempt.");
    const publicRunKeys = Object.keys(runView ?? {});
    expect(publicRunKeys.filter((key) => /cost|budget|estimate/iu.test(key))).toEqual([]);
    expect(publicRunKeys).not.toContain("pipelinePolicySnapshot");
    expect(publicRunKeys).not.toContain("canonicalRunId");
    expect(JSON.stringify({ briefView, runView, publicResult })).not.toContain("sk-proj-PRIVATE");
    expect(JSON.stringify({ briefView, runView, publicResult })).not.toContain("postgres://");
  });

  test("a Resend outage keeps the notification outbox pending for a durable retry", async () => {
    vi.stubEnv("RESEND_API_KEY", "offline-resend-integration-key");
    vi.stubEnv("RESEND_FROM", "gênio <alerts@example.com>");
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

  test("allows repeated active runs from one anonymous bucket while preserving capability isolation", async () => {
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
    const third = await create("third", session.id);
    expect(third).toMatchObject({ created: true, status: "queued" });

    await expect(capabilities.authenticateForAccess(request, left.accessId)).resolves.toMatchObject({
      runId: left.runId,
      accessId: left.accessId,
    });
    await expect(capabilities.authenticateForAccess(request, right.accessId)).resolves.toMatchObject({
      runId: right.runId,
      accessId: right.accessId,
    });
    await expect(capabilities.authenticateForAccess(request, third.accessId)).resolves.toMatchObject({
      runId: third.runId,
      accessId: third.accessId,
    });
    const history = await repository.listRunsForCapabilitySession(session.id);
    expect(history.map((item) => item.id)).toEqual([third.accessId, right.accessId, left.accessId]);
    expect(history[0]).toMatchObject({
      prompt: "Capability scope third",
      status: "queued",
      phase: "queued",
      candidateCount: 0,
      sourceCount: 0,
      unresolvedCount: 0,
      brief: { title: "Capability scope third" },
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
      globalLimit: 100,
    });
    await expect(capabilities.authenticateForAccess(request, isolated.accessId)).rejects.toMatchObject({
      statusCode: 403,
      code: "capability_scope_mismatch",
    });

    await expect(repository.deleteRunAccess(left.accessId)).resolves.toBe(true);
    await expect(capabilities.authenticate(request)).resolves.toMatchObject({
      id: session.id,
      runId: third.runId,
      accessId: third.accessId,
    });
    await expect(repository.listRunsForCapabilitySession(session.id)).resolves.toMatchObject([
      { id: third.accessId },
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
      globalLimit: 100,
    });
    const capabilities = new CapabilityService(repository);
    const expired = await capabilities.issue(created.runId, created.accessId, 60_000);
    await repository.pool.query(
      "UPDATE capability_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
      [capabilityHash(expired)],
    );
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

  test("projects only stable completed Apple publications into the privacy-safe directory", async () => {
    const clientBucket = `public-directory-${randomUUID()}`;
    const created = await repository.createRunIdempotent({
      prompt: "A private prompt that must never enter the directory",
      brief: { ...brief, title: "Directory fixture" },
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      reuseDays: 0,
      globalLimit: 100,
    });
    const manifestId = randomUUID();
    const candidateId = randomUUID();
    const shareUrl = "https://music.apple.com/us/playlist/directory-fixture/pl.u-directory123";
    await repository.pool.query(
      `INSERT INTO track_candidates(id,run_id,canonical_key,artist,title,outcome)
       VALUES($1,$2,'directory-track','Directory Artist','Directory Track','accepted')`,
      [candidateId, created.runId],
    );
    await repository.pool.query(
      `INSERT INTO manifests(id,run_id,name,description,content_hash)
       VALUES($1,$2,'Directory fixture','Private operational description',$3)`,
      [manifestId, created.runId, "a".repeat(64)],
    );
    await repository.pool.query(
      `INSERT INTO manifest_tracks(manifest_id,position,candidate_id,catalog_id,artist,title)
       VALUES($1,0,$2,'catalog-directory','Directory Artist','Directory Track')`,
      [manifestId, candidateId],
    );
    await repository.pool.query(
      `INSERT INTO publication_volumes(
         id,manifest_id,volume_number,volume_count,start_position,end_position,status,
         apple_playlist_id,apple_share_url,appended_count,published_at
       ) VALUES($1,$2,1,1,0,0,'complete','p.private-library-id',$3,1,now())`,
      [randomUUID(), manifestId, shareUrl],
    );

    await repository.updateRun(created.runId, { status: "complete", phase: "published" });
    const listed = await repository.listPublicPlaylists(1, 24);
    expect(listed).toMatchObject({ page: 1, pageSize: 24, total: 1, totalPages: 1 });
    expect(listed.items).toEqual([{
      id: expect.any(String),
      title: "Directory fixture",
      trackCount: 1,
      volumeCount: 1,
      publishedAt: expect.any(String),
      volumes: [{
        volumeNumber: 1,
        name: "Directory fixture",
        trackCount: 1,
        shareUrl,
      }],
    }]);
    expect(JSON.stringify(listed)).not.toContain("private prompt");
    expect(JSON.stringify(listed)).not.toContain("Private operational description");
    expect(JSON.stringify(listed)).not.toContain("p.private-library-id");
    expect(JSON.stringify(listed)).not.toContain(created.runId);

    const directoryId = listed.items[0]!.id;
    await expect(repository.setPublicPlaylistVisibility(directoryId, false)).resolves.toBe(true);
    await expect(repository.listPublicPlaylists()).resolves.toMatchObject({ items: [], total: 0 });
    // Re-projecting identical content must not undo an explicit owner hide.
    await repository.updateRun(created.runId, { status: "complete", phase: "published" });
    await expect(repository.listPublicPlaylists()).resolves.toMatchObject({ items: [], total: 0 });
    await expect(repository.setPublicPlaylistVisibility(directoryId, true)).resolves.toBe(true);
    await expect(repository.listPublicPlaylists()).resolves.toMatchObject({ total: 1 });
  });

  test("migration backfill rejects incomplete or unstable legacy publications", async () => {
    const createLegacyPublication = async (suffix: string, shareUrl: string, appendedCount: number) => {
      const runId = await repository.createRun(`Legacy ${suffix}`, { ...brief, title: `Legacy ${suffix}` }, 0, 1);
      const candidateId = randomUUID();
      const manifestId = randomUUID();
      await repository.pool.query(
        `INSERT INTO track_candidates(id,run_id,canonical_key,artist,title,outcome)
         VALUES($1,$2,$3,'Legacy Artist','Legacy Track','accepted')`,
        [candidateId, runId, `legacy-${suffix}`],
      );
      await repository.pool.query(
        `INSERT INTO manifests(id,run_id,name,description,content_hash)
         VALUES($1,$2,$3,'Legacy private description',$4)`,
        [manifestId, runId, `Legacy ${suffix}`, suffix.repeat(64).slice(0, 64)],
      );
      await repository.pool.query(
        `INSERT INTO manifest_tracks(manifest_id,position,candidate_id,catalog_id,artist,title)
         VALUES($1,0,$2,$3,'Legacy Artist','Legacy Track')`,
        [manifestId, candidateId, `catalog-${suffix}`],
      );
      await repository.pool.query(
        `INSERT INTO publication_volumes(
           id,manifest_id,volume_number,volume_count,start_position,end_position,status,
           apple_playlist_id,apple_share_url,appended_count,published_at
         ) VALUES($1,$2,1,1,0,0,'complete',$3,$4,$5,now())`,
        [randomUUID(), manifestId, `p.${suffix}`, shareUrl, appendedCount],
      );
      await repository.pool.query(
        "UPDATE research_runs SET status='complete',phase='published',completed_at=now() WHERE id=$1",
        [runId],
      );
    };
    await createLegacyPublication(
      "b",
      "https://music.apple.com/us/playlist/legacy-stable/pl.u-legacystable",
      1,
    );
    await createLegacyPublication("c", "https://attacker.example/not-apple", 1);
    await createLegacyPublication(
      "d",
      "https://music.apple.com/us/playlist/legacy-short/pl.u-legacyshort",
      0,
    );

    await applyMigration(repository.pool);
    const directory = await repository.listPublicPlaylists();
    expect(directory.total).toBe(1);
    expect(directory.items[0]).toMatchObject({
      title: "Legacy b",
      trackCount: 1,
      volumes: [{ shareUrl: "https://music.apple.com/us/playlist/legacy-stable/pl.u-legacystable" }],
    });
  });

  test("post-publication deletion removes gênio detail but preserves the public Apple links in a tombstone", async () => {
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
      globalLimit: 100,
    });
    const manifestId = randomUUID();
    const candidateId = randomUUID();
    const contentHash = "d".repeat(64);
    const shareUrl = "https://music.apple.com/us/playlist/needle-published-deletion/pl.u-test123";
    await repository.pool.query(
      `INSERT INTO track_candidates(id,run_id,canonical_key,artist,title,outcome)
       VALUES($1,$2,'published-deletion-track','Deletion Artist','Deletion Track','accepted')`,
      [candidateId, created.runId],
    );
    await repository.pool.query(
      `INSERT INTO manifests(id,run_id,name,description,content_hash)
       VALUES($1,$2,'Published deletion fixture','A published fixture',$3)`,
      [manifestId, created.runId, contentHash],
    );
    await repository.pool.query(
      `INSERT INTO manifest_tracks(manifest_id,position,candidate_id,catalog_id,artist,title)
       VALUES($1,0,$2,'catalog-deletion','Deletion Artist','Deletion Track')`,
      [manifestId, candidateId],
    );
    await repository.pool.query(
      `INSERT INTO publication_volumes(
         id,manifest_id,volume_number,volume_count,start_position,end_position,status,
         apple_playlist_id,apple_share_url,appended_count,published_at
       ) VALUES($1,$2,1,1,0,0,'complete','p.library-test',$3,1,now())`,
      [randomUUID(), manifestId, shareUrl],
    );
    await repository.updateRun(created.runId, { status: "complete", phase: "publication_complete" });
    await expect(repository.listPublicPlaylists()).resolves.toMatchObject({ total: 1 });

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
    await expect(repository.listPublicPlaylists()).resolves.toMatchObject({
      total: 1,
      items: [{
        title: "Published deletion fixture",
        volumes: [{ shareUrl }],
      }],
    });
    const projection = await repository.pool.query<{ run_id: string | null }>(
      "SELECT run_id FROM public_playlists WHERE manifest_hash=$1",
      [contentHash],
    );
    expect(projection.rows[0]?.run_id).toBeNull();
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
    await repository.setSetting("schema_version", DATABASE_SCHEMA_VERSION);
    await repository.updateWorkerHeartbeat("stale-worker", { schemaVersion: "1", capacity: 2, activeJobs: 1 });
    await repository.pool.query(
      "UPDATE worker_heartbeats SET last_seen_at=now()-interval '91 seconds' WHERE worker_id='stale-worker'",
    );
    expect((await repository.getSystemHealth()).worker).toMatchObject({ worker_id: "stale-worker", stale: true });

    await repository.updateWorkerHeartbeat("legacy-worker", {
      schemaVersion: DATABASE_SCHEMA_VERSION,
      capacity: 2,
      activeJobs: 0,
    });
    expect((await repository.getSystemHealth()).worker).toMatchObject({
      worker_id: "legacy-worker",
      stale: false,
      schemaCompatible: true,
      protocolCompatible: false,
      protocolVersion: null,
    });

    await repository.updateWorkerHeartbeat("fresh-worker", {
      schemaVersion: DATABASE_SCHEMA_VERSION,
      protocolVersion: WORKER_PIPELINE_PROTOCOL_VERSION,
      capacity: 2,
      activeJobs: 0,
    });
    expect((await repository.getSystemHealth()).worker).toMatchObject({
      worker_id: "fresh-worker",
      stale: false,
      schemaCompatible: true,
      protocolCompatible: true,
      protocolVersion: WORKER_PIPELINE_PROTOCOL_VERSION,
    });

    await repository.pool.query("DELETE FROM worker_heartbeats");
    await repository.updateWorkerHeartbeat("wrong-schema-worker", {
      schemaVersion: "1",
      observedSchemaVersion: "1",
      protocolVersion: WORKER_PIPELINE_PROTOCOL_VERSION,
      capacity: 2,
      activeJobs: 0,
    });
    expect((await repository.getSystemHealth()).worker).toMatchObject({
      worker_id: "wrong-schema-worker",
      stale: false,
      schemaCompatible: false,
      protocolCompatible: true,
    });

    await repository.pool.query("DELETE FROM worker_heartbeats");
    await repository.updateWorkerHeartbeat("wrong-protocol-worker", {
      schemaVersion: DATABASE_SCHEMA_VERSION,
      observedSchemaVersion: DATABASE_SCHEMA_VERSION,
      protocolVersion: "playlist-pipeline-v1",
      capacity: 2,
      activeJobs: 0,
    });
    expect((await repository.getSystemHealth()).worker).toMatchObject({
      worker_id: "wrong-protocol-worker",
      stale: false,
      schemaCompatible: true,
      protocolCompatible: false,
      protocolVersion: "playlist-pipeline-v1",
    });

    await repository.pool.query("DELETE FROM worker_heartbeats");
    await repository.updateWorkerHeartbeat("healthy-v5", {
      schemaVersion: DATABASE_SCHEMA_VERSION,
      schemaMinimum: DATABASE_SCHEMA_VERSION,
      schemaMaximum: DATABASE_SCHEMA_VERSION,
      schemaPreferred: DATABASE_SCHEMA_VERSION,
      observedSchemaVersion: DATABASE_SCHEMA_VERSION,
      protocolVersion: WORKER_PIPELINE_PROTOCOL_VERSION,
      capacity: 2,
      activeJobs: 0,
    });
    await repository.updateWorkerHeartbeat("newer-v4-bridge", {
      schemaVersion: "12",
      schemaMinimum: "12",
      schemaMaximum: "13",
      schemaPreferred: "12",
      observedSchemaVersion: DATABASE_SCHEMA_VERSION,
      protocolVersion: WORKER_PIPELINE_V4_BRIDGE_CAPABILITY.protocolVersion,
      capacity: 3,
      activeJobs: 0,
    });
    expect((await repository.getSystemHealth()).worker).toMatchObject({
      worker_id: "healthy-v5",
      stale: false,
      schemaCompatible: true,
      protocolCompatible: true,
      compatibleCapacity: 2,
    });
  });
});
