import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createDatabase } from "../db/index.ts";
import { CapabilityService, CAPABILITY_COOKIE } from "../server/capabilities.ts";
import { canonicalGatewayRequest, createGatewayVerifier } from "../server/gateway-auth.ts";
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

  afterEach(() => {
    vi.unstubAllEnvs();
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
});
