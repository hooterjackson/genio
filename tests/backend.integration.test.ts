import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase } from "../db/index.ts";
import { CapabilityService, CAPABILITY_COOKIE } from "../server/capabilities.ts";
import { canonicalGatewayRequest, createGatewayVerifier } from "../server/gateway-auth.ts";
import { processNotificationJob } from "../server/notifications.ts";
import { Repository } from "../server/repository.ts";
import { hmacBase64Url, sha256Hex } from "../server/security.ts";
import type { PlaylistBrief } from "../shared/types.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseDescribe = databaseUrl ? describe.sequential : describe.skip;
const migrationSql = ["0000_needle_initial.sql", "0001_evidence_scope.sql"]
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
    await applyMigration(repository.pool);
    await expect(repository.ensureSchemaVersion()).resolves.toBeUndefined();
    const result = await repository.pool.query<{ name: string }>(
      `SELECT unnest(ARRAY[
        to_regclass('settings')::text,
        to_regclass('research_runs')::text,
        to_regclass('job_queue')::text,
        to_regclass('cost_reservations')::text,
        to_regclass('gateway_nonces')::text,
        to_regclass('capability_sessions')::text
      ]) AS name`,
    );
    expect(result.rows.map((row) => row.name)).toEqual([
      "settings",
      "research_runs",
      "job_queue",
      "cost_reservations",
      "gateway_nonces",
      "capability_sessions",
    ]);
    const evidenceColumns = await repository.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema=current_schema() AND table_name='evidence_claims'
         AND column_name IN ('support_scope','verification_phase')
       ORDER BY column_name`,
    );
    expect(evidenceColumns.rows.map((row) => row.column_name)).toEqual(["support_scope", "verification_phase"]);
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
    const claim = (state: "verified" | "inferred", supportScope: "track" | "album", relationship = "performed on") => ({
      sourceUrl,
      state,
      supportScope,
      relationship,
      note: "The relationship under verification.",
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
        (SELECT count(*)::int FROM source_frontier WHERE run_id=$1 AND source_class='import' AND status='complete') frontier,
        (SELECT count(*)::int FROM audit_events WHERE run_id=$1 AND action='run.catalog_imported') audits`,
      [runId],
    );
    expect(stored.rows[0]).toMatchObject({ sources: 1, candidates: 1, inferred: 1, frontier: 1, audits: 1 });

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
          evidence: [{ sourceUrl: concreteUrl, state: "inferred", supportScope: "track", relationship: "attribution", note: "Not verified." }],
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
          evidence: [{ sourceUrl: upgradeUrl, state: "inferred", supportScope: "track", relationship: "attribution", note: "Not verified." }],
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
        relationship: "performed on",
        note: "Track-level test evidence.",
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

  test("keeps capability sessions isolated to their own run access", async () => {
    vi.stubEnv("CAPABILITY_PEPPER", "integration-capability-pepper-32-bytes");
    const create = (label: string) => {
      const clientBucket = `capability-scope-${label}-${randomUUID()}`;
      return repository.createRunIdempotent({
        prompt: `Capability scope ${label}`,
        brief: { ...brief, title: `Capability scope ${label}` },
        estimateUsd: 0,
        approvedBudgetUsd: 1,
        clientBucket,
        clientBucketAliases: [clientBucket],
        idempotencyKey: randomUUID(),
        reuseDays: 0,
        rateLimit: 100,
        globalLimit: 100,
      });
    };
    const [left, right] = await Promise.all([create("left"), create("right")]);
    const capabilities = new CapabilityService(repository);
    const reply = new ReplyStub();
    await capabilities.exchange(
      await capabilities.issue(left.runId, left.accessId),
      reply as unknown as FastifyReply,
    );
    const request = cookieRequest(reply.headers.get("set-cookie")!.split(";")[0]!);

    await expect(capabilities.authenticateForAccess(request, left.accessId)).resolves.toMatchObject({
      runId: left.runId,
      accessId: left.accessId,
    });
    await expect(capabilities.authenticateForAccess(request, right.accessId)).rejects.toMatchObject({
      statusCode: 403,
      code: "capability_scope_mismatch",
    });
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

    await repository.updateWorkerHeartbeat("fresh-worker", { schemaVersion: "1", capacity: 2, activeJobs: 0 });
    expect((await repository.getSystemHealth()).worker).toMatchObject({ worker_id: "fresh-worker", stale: false });
  });
});
