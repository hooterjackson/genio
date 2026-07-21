import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { createDatabase } from "../../db/index.ts";
import { deterministicBriefFallback } from "../../server/brief-policy.ts";
import {
  publicTrackScopeAttestationV3,
  type QualifiedTrackV3,
  type RetrievalResultV3,
} from "../../server/pipeline-v3-retrieval.ts";
import { Repository } from "../../server/repository.ts";
import { createSelectionPlanV2 } from "../../server/selection-plan-v2.ts";
import { WorkerRunner } from "../../server/worker-runner.ts";

const enabled = process.env.GENIO_SYSTEM_E2E === "1";
const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
const apiPort = Number(process.env.GENIO_SYSTEM_E2E_API_PORT ?? "18788");
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const migrationDirectory = new URL("../../postgres-migrations/", import.meta.url);
const migrationSql = readdirSync(migrationDirectory)
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort()
  .map((file) => readFileSync(new URL(`../../postgres-migrations/${file}`, import.meta.url), "utf8"))
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

function fixtureTrack(prefix: string, index: number, predicateIds: readonly string[]): QualifiedTrackV3 {
  const ordinal = String(index + 1).padStart(3, "0");
  const url = `https://example.test/system-e2e/${prefix}/${ordinal}`;
  return {
    candidateId: `${prefix}:candidate:${ordinal}`,
    title: `${prefix} Track ${ordinal}`,
    artist: `${prefix} Artist ${Math.floor(index / 2) + 1}`,
    album: `${prefix} Album ${Math.floor(index / 5) + 1}`,
    appleSongId: `${prefix}-apple-${ordinal}`,
    recordingFamilyKey: `${prefix}:family:${ordinal}`,
    sourceObservationIds: [`${prefix}:observation:${ordinal}`],
    evidenceBindingIds: [`${prefix}:binding:${ordinal}`],
    evidenceBindings: [{
      id: `${prefix}:binding:${ordinal}`,
      url,
      provenanceRoot: `example.test:${prefix}`,
      strength: 0.99,
      sourceRank: index + 1,
      kind: "track_specific_source",
      predicateIds: [...predicateIds],
      governance: {
        policyVersion: "evidence-source-governance-v3",
        useScope: "run_local",
        approvalState: "approved",
        accessMethod: "hosted_web_search",
        licenseState: "citation_only",
        licenseVersion: "system-e2e-v1",
        termsVersion: "system-e2e-v1",
        attribution: "Deterministic system E2E fixture",
        cachePolicy: "excerpt_only",
        retentionPolicy: "ninety_days",
        freshnessPolicy: "revalidate_30d",
        sourceHash: "a".repeat(64),
        sourceRevision: "b".repeat(64),
      },
      eligibilityAttestation: publicTrackScopeAttestationV3(url),
    }],
    evidenceStrength: 0.99,
    scopeFit: 0.99,
    independentProvenanceRoots: 1,
    versionConfidence: 0.99,
    catalogConfidence: 0.99,
    rankingSignals: { relevance: 1 - index / 1_000 },
    sourceRank: index + 1,
  };
}

function fixtureResult(input: {
  runId: string;
  target: number;
  selectedCount: number;
  predicateIds: readonly string[];
  kind: "exact" | "partial" | "zero";
  continuationAvailable?: boolean;
}): RetrievalResultV3 {
  const reserveCount = input.kind === "exact" ? Math.max(10, Math.ceil(input.target * 0.2)) : 0;
  const selected = Array.from({ length: input.selectedCount }, (_, index) => (
    fixtureTrack(input.kind, index, input.predicateIds)
  ));
  const reserve = Array.from({ length: reserveCount }, (_, index) => (
    fixtureTrack(`${input.kind}-reserve`, index, input.predicateIds)
  ));
  const qualifiedPool = [...selected, ...reserve];
  const exact = input.kind === "exact";
  const zero = input.kind === "zero";
  const status = exact ? "exact_ready" : zero ? "no_compatible_tracks" : "partial_ready";
  const stages = {
    discovered: qualifiedPool.length,
    validCandidates: qualifiedPool.length,
    scopeEligible: qualifiedPool.length,
    hardConstraintEligible: qualifiedPool.length,
    evidenceEligible: qualifiedPool.length,
    versionCompatible: qualifiedPool.length,
    storefrontPlayable: qualifiedPool.length,
    canonicalUnique: qualifiedPool.length,
    selected: selected.length,
    reserve: reserve.length,
  };
  return {
    schemaVersion: "genio-pipeline-v3-retrieval/v1",
    runId: input.runId,
    executionMode: "active",
    engines: ["curated_genre_scene"],
    outcome: {
      status,
      stopReason: exact ? "qualified_reserve_satisfied" : "frontier_exhausted",
      requestedTrackCount: input.target,
      qualifiedTrackCount: qualifiedPool.length,
      selectedTrackCount: selected.length,
      reserveTrackCount: reserve.length,
      shortfall: Math.max(0, input.target - selected.length),
      requiresPartialPublicationDecision: !exact && !zero,
    },
    selected,
    reserve,
    qualifiedPool,
    compatibleAlternatesByRecordingFamily: {},
    stages,
    deficit: {
      ...stages,
      requested: input.target,
      qualifiedPoolGoal: input.target + Math.max(10, Math.ceil(input.target * 0.2)),
      targetShortfall: Math.max(0, input.target - selected.length),
      reserveShortfall: exact ? 0 : Math.max(0, 10 - reserve.length),
      discardedByReason: {},
      primaryShortfallReason: exact ? null : "frontier_exhausted",
    },
    strategies: [{
      id: "curated_genre_scene:system_e2e",
      engine: "curated_genre_scene",
      kind: "trusted_containers",
      status: input.continuationAvailable ? "available" : "exhausted",
      rounds: 1,
      rawCandidates: qualifiedPool.length,
      newQualifiedFamilies: qualifiedPool.length,
      consecutiveZeroQualifiedYieldRounds: zero ? 1 : 0,
      providerFailures: 0,
      cursor: null,
    }],
    integrityEvents: [],
    publicationBoundary: {
      appleWriteAccess: "forbidden",
      manifestDisposition: exact
        ? "exact_draft_ready"
        : zero
          ? "no_manifest"
          : "partial_confirmation_required",
    },
  };
}

async function waitForApi(child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`System E2E API exited early:\n${output()}`);
    try {
      const response = await fetch(`${apiOrigin}/health/live`);
      if (response.ok) return;
    } catch {
      // The API has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`System E2E API did not become ready:\n${output()}`);
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!graceful && child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error("System E2E API did not exit after SIGKILL")),
        5_000,
      )),
    ]);
  }
}

test.describe("Pipeline V3 stitched system E2E", () => {
  test.skip(!enabled, "Set GENIO_SYSTEM_E2E=1 and DATABASE_URL to run the stitched V3 system suite");
  test.skip(enabled && !databaseUrl, "DATABASE_URL is required for the stitched V3 system suite");
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  const schemaName = `genio_v3_system_${randomUUID().replaceAll("-", "")}`;
  const graphSnapshotId = randomUUID();
  let adminPool: Pool;
  let repository: Repository;
  let worker: WorkerRunner;
  let workerPromise: Promise<void>;
  let api: ChildProcess | null = null;
  let apiOutput = "";
  const retrievalCalls = new Map<string, number>();

  test.beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.PIPELINE_V3_ASSIGNMENT_ENABLED = "true";
    process.env.PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED = "true";
    process.env.PIPELINE_V3_GENRE_SCENE_PERCENT = "100";
    // The stitched suite injects deterministic brief/retrieval ports, but the
    // immutable run policy still validates the exact production model route.
    // Keep these values on the same allowlisted IDs used by real V3 runs so
    // the test exercises policy creation instead of failing on fake model IDs.
    process.env.PIPELINE_V3_BASELINE_MODEL_ID = "gpt-5.6-luna";
    process.env.PIPELINE_V3_ESCALATION_MODEL_ID = "gpt-5.6-terra";
    process.env.PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT = "2026-07-20T00:00:00.000Z";
    process.env.APPLE_STOREFRONT = "us";
    delete process.env.OPENAI_API_KEY;

    adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    const handle = createDatabase({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 8,
      application_name: "genio-v3-system-e2e",
    });
    repository = new Repository(handle);
    await applySql(repository.pool, migrationSql);
    // Migrations intentionally schedule recurring maintenance jobs. They are
    // unrelated to this stitched browser contract and can otherwise win the
    // first leases on a high-latency database, making the test exercise queue
    // housekeeping instead of the user request it submitted.
    await repository.pool.query("DELETE FROM job_queue");
    await repository.pool.query("INSERT INTO graph_snapshots(id,status) VALUES($1,'building')", [graphSnapshotId]);
    await repository.pool.query(
      `UPDATE graph_snapshots SET status='locked',content_hash=$2,assertion_count=0,
         catalog_identity_count=0,locked_at=now() WHERE id=$1`,
      [graphSnapshotId, "c".repeat(64)],
    );

    worker = new WorkerRunner(repository, {
      workerId: `system-e2e-${randomUUID()}`,
      concurrency: 2,
      pollMs: 20,
      heartbeatMs: 300_000,
      controlIntervalMs: 300_000,
      handlers: {
        brief: async (payload) => {
          const briefRequestId = String(payload.briefRequestId ?? "");
          const request = await repository.getBriefRequest(briefRequestId);
          if (!request) throw new Error("System E2E brief request is missing");
          const brief = deterministicBriefFallback(request);
          await repository.saveBriefSelectionPlan(briefRequestId, createSelectionPlanV2({
            prompt: request.prompt,
            brief,
            storefront: "us",
          }));
          await repository.saveBriefResult(briefRequestId, {
            status: "complete",
            expectedStatus: "queued",
            brief,
            questions: [],
            guidanceSourceHints: [],
            estimateUsd: 0.1,
            error: null,
          });
        },
      },
      v3RetrievalPort: {
        execute: async ({ runId, plan }) => {
          // Make the in-progress UI observable rather than racing the
          // client's first poll against an instantaneous fixture result.
          await new Promise((resolve) => setTimeout(resolve, 2_500));
          const marker = plan.prompt.toLocaleLowerCase("en-US");
          const call = (retrievalCalls.get(runId) ?? 0) + 1;
          retrievalCalls.set(runId, call);
          const kind = marker.includes("system continuation") && call > 1
            ? "exact"
            : marker.includes("system partial") || marker.includes("system continuation")
            ? "partial"
            : marker.includes("system zero")
              ? "zero"
              : "exact";
          const selectedCount = kind === "exact"
            ? plan.requestedTrackCount
            : kind === "partial"
              ? Math.max(1, plan.requestedTrackCount - 8)
              : 0;
          return fixtureResult({
            runId,
            target: plan.requestedTrackCount,
            selectedCount,
            predicateIds: plan.membershipPredicates
              .filter((predicate) => predicate.operator !== "exclude")
              .map((predicate) => predicate.id),
            kind,
            continuationAvailable: marker.includes("system continuation") && call === 1,
          });
        },
      },
    });
    workerPromise = worker.run();

    const apiEnvironment = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PGOPTIONS: `-c search_path=${schemaName},public`,
      PORT: String(apiPort),
      NODE_ENV: "test",
      REQUIRE_WORKER_HEARTBEAT: "false",
      GATEWAY_KEY_ID: "local-dev",
      GATEWAY_HMAC_SECRET: "needle-local-development-only",
      IP_HASH_SECRET: "needle-local-ip-pepper",
      LOG_LEVEL: "error",
      OPENAI_API_KEY: "",
    };
    api = spawn(process.execPath, ["--experimental-transform-types", "server/index.ts"], {
      cwd: process.cwd(),
      env: apiEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    api.stdout?.on("data", (chunk) => { apiOutput += chunk.toString(); });
    api.stderr?.on("data", (chunk) => { apiOutput += chunk.toString(); });
    await waitForApi(api, () => apiOutput);
  });

  test.afterAll(async () => {
    await stopChild(api);
    if (worker) await worker.stop("Pipeline V3 system E2E complete");
    if (workerPromise) await workerPromise.catch(() => undefined);
    if (repository) await repository.close();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  });

  async function submit(page: import("@playwright/test").Page, prompt: string, count = 25): Promise<void> {
    await page.goto("/");
    await page.getByRole("textbox", { name: "PLAYLIST REQUEST" }).fill(prompt);
    if (count !== 50) await page.getByRole("button", { name: `${count} tracks` }).click();
    await page.getByRole("button", { name: new RegExp(`create playlist · ${count} tracks`, "iu") }).click();
  }

  async function systemDiagnostics(prompt: string): Promise<string> {
    const [briefs, runs, jobs] = await Promise.all([
      repository.pool.query(
        `SELECT id,status,error,prompt,created_at,updated_at
         FROM brief_requests WHERE prompt=$1 ORDER BY created_at DESC LIMIT 3`,
        [prompt],
      ),
      repository.pool.query(
        `SELECT run.id,run.status,run.phase,run.error,spec.raw_prompt,
                run.pipeline_version,run.created_at,run.updated_at
         FROM research_runs run
         JOIN run_specs spec ON spec.run_id=run.id
         WHERE spec.raw_prompt=$1 ORDER BY run.created_at DESC LIMIT 3`,
        [prompt],
      ),
      repository.pool.query(
        `SELECT kind,status,attempts,last_error,run_id,created_at,updated_at
         FROM job_queue ORDER BY created_at DESC LIMIT 8`,
      ),
    ]);
    return JSON.stringify({
      apiOutput,
      briefs: briefs.rows,
      runs: runs.rows,
      jobs: jobs.rows,
    }, null, 2);
  }

  async function expectWorkingScreen(
    page: import("@playwright/test").Page,
    prompt: string,
  ): Promise<void> {
    try {
      await expect(page.getByRole("heading", { name: /creating your playlist/i }))
        .toBeVisible({ timeout: 90_000 });
    } catch (error) {
      const alert = await page.getByRole("alert").allTextContents().catch(() => [] as string[]);
      throw new Error(
        `Pipeline V3 system flow did not reach the working screen. Alerts: ${alert.join(" | ")}\n${await systemDiagnostics(prompt)}`,
        { cause: error },
      );
    }
  }

  test("exact flow preserves the immutable count and locks a complete manifest", async ({ page }) => {
    const prompt = "System exact disco music";
    await submit(page, prompt, 25);
    await expectWorkingScreen(page, prompt);

    await expect.poll(async () => (
      await repository.pool.query<{
        run_id: string;
        requested_track_count: number;
        target_track_count: number;
        status: string;
        pipeline_version: string;
        query_plan_hash: string;
        selection_plan_hash: string;
        manifest_hash: string;
        track_count: number;
        track_ids: string[];
      }>(
        `SELECT spec.run_id,spec.requested_track_count,run.status,run.pipeline_version,
                NULLIF(query.plan_json->>'targetTrackCount','')::int target_track_count,
                query.plan_hash query_plan_hash,
                query.plan_json->>'selectionPlanHash' selection_plan_hash,
                revision.content_hash manifest_hash,
                (SELECT count(*)::int FROM manifest_revision_tracks track
                 WHERE track.manifest_revision_id=revision.id) track_count,
                ARRAY(SELECT track.catalog_id FROM manifest_revision_tracks track
                      WHERE track.manifest_revision_id=revision.id
                      ORDER BY track.position) track_ids
         FROM run_specs spec
         JOIN research_runs run ON run.id=spec.run_id
         JOIN query_plan_revisions query ON query.run_id=spec.run_id AND query.status='active'
         JOIN manifests manifest ON manifest.run_id=spec.run_id
         JOIN manifest_revisions revision ON revision.manifest_id=manifest.id AND revision.status='locked'
         WHERE spec.raw_prompt=$1`,
        [prompt],
      )
    ).rows[0]).toMatchObject({
      requested_track_count: 25,
      target_track_count: 25,
      track_count: 25,
      status: "waiting_for_apple_authorization",
      pipeline_version: "corpus_first_v3",
      query_plan_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      selection_plan_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      manifest_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      track_ids: Array.from({ length: 25 }, (_, index) => `exact-apple-${String(index + 1).padStart(3, "0")}`),
    });
    await expect(page.getByText("Paused until the owner reconnects Apple Music.")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("JOBS", { exact: true })).toBeVisible();
  });

  test("partial flow pauses in the browser and persists no publication consent", async ({ page }) => {
    await submit(page, "System partial Brazilian disco music", 25);
    await expect(page.getByTestId("partial-decision-screen")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole("heading", { name: "17 verified tracks are ready" })).toBeVisible();
    await expect(page.getByText(/No playlist has been published yet/i)).toBeVisible();

    const row = await repository.pool.query<{
      requested_track_count: number;
      status: string;
      track_count: number;
      decision_count: number;
      publication_count: number;
      publication_job_count: number;
    }>(
      `SELECT spec.requested_track_count,run.status,
              (SELECT count(*)::int FROM manifest_revision_tracks track
               JOIN manifest_revisions revision ON revision.id=track.manifest_revision_id
               JOIN manifests manifest ON manifest.id=revision.manifest_id
               WHERE manifest.run_id=run.id) track_count,
              (SELECT count(*)::int FROM partial_publication_decisions decision
               WHERE decision.run_id=run.id) decision_count,
              (SELECT count(*)::int FROM publication_volumes volume
               JOIN manifests manifest ON manifest.id=volume.manifest_id
               WHERE manifest.run_id=run.id) publication_count,
              (SELECT count(*)::int FROM job_queue job
               WHERE job.run_id=run.id AND job.kind='publication') publication_job_count
       FROM research_runs run JOIN run_specs spec ON spec.run_id=run.id
       WHERE spec.raw_prompt=$1`,
      ["System partial Brazilian disco music"],
    );
    expect(row.rows[0]).toEqual({
      requested_track_count: 25,
      status: "partial_ready",
      track_count: 17,
      decision_count: 0,
      publication_count: 0,
      publication_job_count: 0,
    });
  });

  test("partial publication requires the browser decision and locks only the verified tracks", async ({ page }) => {
    const prompt = "System partial consent Brazilian disco music";
    await submit(page, prompt, 25);
    await expect(page.getByTestId("partial-decision-screen")).toBeVisible({ timeout: 90_000 });
    await page.getByRole("button", { name: "PUBLISH 17 VERIFIED TRACKS" }).click();

    await expect.poll(async () => (
      await repository.pool.query<{
        requested_track_count: number;
        status: string;
        track_count: number;
        decision_count: number;
        publication_job_count: number;
      }>(
        `SELECT spec.requested_track_count,run.status,
                (SELECT count(*)::int FROM manifest_revision_tracks track
                 WHERE track.manifest_revision_id=(
                   SELECT revision.id FROM manifest_revisions revision
                   JOIN manifests manifest ON manifest.id=revision.manifest_id
                   WHERE manifest.run_id=run.id
                   ORDER BY revision.revision DESC LIMIT 1
                 )) track_count,
                (SELECT count(*)::int FROM partial_publication_decisions decision
                 WHERE decision.run_id=run.id) decision_count,
                (SELECT count(*)::int FROM job_queue job
                 WHERE job.run_id=run.id AND job.kind='publication') publication_job_count
         FROM research_runs run JOIN run_specs spec ON spec.run_id=run.id
         WHERE spec.raw_prompt=$1`,
        [prompt],
      )
    ).rows[0]).toMatchObject({
      requested_track_count: 25,
      status: "waiting_for_apple_authorization",
      track_count: 17,
      decision_count: 1,
      // Publication is intentionally not enqueued until the owner account is
      // authorized. The persisted partial decision is the durable handoff;
      // owner reauthorization will resume publication from this manifest.
      publication_job_count: 0,
    });
    await expect(page.getByText("Publication will resume after the owner reconnects Apple Music."))
      .toBeVisible({ timeout: 10_000 });
  });

  test("continue research resumes the same immutable request and can reach exact fill", async ({ page }) => {
    const prompt = "System continuation Detroit techno music";
    await submit(page, prompt, 25);
    await expect(page.getByTestId("partial-decision-screen")).toBeVisible({ timeout: 90_000 });
    await page.getByRole("button", { name: "CONTINUE RESEARCH →" }).click();
    await expectWorkingScreen(page, prompt);

    await expect.poll(async () => (
      await repository.pool.query<{
        requested_track_count: number;
        status: string;
        track_count: number;
        decision_count: number;
      }>(
        `SELECT spec.requested_track_count,run.status,
                (SELECT count(*)::int FROM manifest_revision_tracks track
                 WHERE track.manifest_revision_id=(
                   SELECT revision.id FROM manifest_revisions revision
                   JOIN manifests manifest ON manifest.id=revision.manifest_id
                   WHERE manifest.run_id=run.id
                   ORDER BY revision.revision DESC LIMIT 1
                 )) track_count,
                (SELECT count(*)::int FROM partial_publication_decisions decision
                 WHERE decision.run_id=run.id) decision_count
         FROM research_runs run JOIN run_specs spec ON spec.run_id=run.id
         WHERE spec.raw_prompt=$1`,
        [prompt],
      )
    ).rows[0]).toMatchObject({
      requested_track_count: 25,
      status: "waiting_for_apple_authorization",
      track_count: 25,
      decision_count: 0,
    });
    expect(retrievalCalls.size).toBeGreaterThan(0);
    await expect(page.getByText("Paused until the owner reconnects Apple Music."))
      .toBeVisible({ timeout: 10_000 });
  });

  test("zero-compatible flow completes neutrally without a manifest or Apple write", async ({ page }) => {
    await submit(page, "System zero obscure lunar folk", 25);
    await expect(page.getByRole("heading", { name: "No verified tracks are ready yet" })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "NO VERIFIED TRACKS TO PUBLISH" })).toBeDisabled();

    const row = await repository.pool.query<{
      requested_track_count: number;
      status: string;
      manifest_count: number;
      publication_count: number;
      publication_job_count: number;
    }>(
      `SELECT spec.requested_track_count,run.status,
              (SELECT count(*)::int FROM manifests manifest WHERE manifest.run_id=run.id) manifest_count,
              (SELECT count(*)::int FROM publication_volumes volume
               JOIN manifests manifest ON manifest.id=volume.manifest_id
               WHERE manifest.run_id=run.id) publication_count,
              (SELECT count(*)::int FROM job_queue job
               WHERE job.run_id=run.id AND job.kind='publication') publication_job_count
       FROM research_runs run JOIN run_specs spec ON spec.run_id=run.id
       WHERE spec.raw_prompt=$1`,
      ["System zero obscure lunar folk"],
    );
    expect(row.rows[0]).toEqual({
      requested_track_count: 25,
      status: "no_compatible_tracks",
      manifest_count: 0,
      publication_count: 0,
      publication_job_count: 0,
    });
  });
});
