import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "vitest";
import * as databaseSchema from "../db/schema.ts";
import {
  canonicalExecutorCapabilityForSchemaV1,
} from "../server/playlist-contract-backend-capability-v1.ts";
import { Repository } from "../server/repository.ts";
import { WORKER_PIPELINE_CAPABILITY } from "../server/worker-protocol.ts";
import {
  createLegacyExecutionRouteDrainV1,
  LEGACY_EXECUTION_ROUTE_DRAIN_PHASE_V1,
  LEGACY_EXECUTION_ROUTE_DRAIN_VERSION_V1,
} from "../server/legacy-execution-route-drain-v1.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseDescribe = databaseUrl ? describe.sequential : describe.skip;
const migrations = readdirSync(
  new URL("../postgres-migrations/", import.meta.url),
)
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort()
  .map((file) => readFileSync(
    new URL(`../postgres-migrations/${file}`, import.meta.url),
    "utf8",
  ))
  .join("\n-- statement-breakpoint\n");

async function applyMigrations(pool: Pool): Promise<void> {
  for (const statement of migrations
    .split(/\s*-- statement-breakpoint\s*/u)
    .map((value) => value.trim())
    .filter(Boolean)) {
    await pool.query(statement);
  }
}

databaseDescribe("canonical executor release identity migration 0020", () => {
  const schemaName =
    `genio_executor_release_${randomUUID().replaceAll("-", "")}`;
  const targetRevision = "a".repeat(40);
  const targetSemanticHash = "b".repeat(64);
  const capability5 = canonicalExecutorCapabilityForSchemaV1({
    queryPlanSchemaVersion: 5,
  });
  const capability4 = canonicalExecutorCapabilityForSchemaV1({
    queryPlanSchemaVersion: 4,
  });
  let adminPool: Pool;
  let pool: Pool;
  let repository: Repository;

  beforeAll(async () => {
    adminPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: "genio-executor-release-admin",
    });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 4,
      application_name: "genio-executor-release",
    });
    await applyMigrations(pool);
    repository = new Repository({
      pool,
      db: drizzle(pool, { schema: databaseSchema }),
    });
  }, 45_000);

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  });

  async function createCanonicalFixture(input: {
    schemaVersion: 4 | 5;
    suffix: string;
  }): Promise<{
    runId: string;
    contractId: string;
    queryPlanId: string;
    jobId: string;
  }> {
    const runId = randomUUID();
    const contractId = randomUUID();
    const selectionPlanId = randomUUID();
    const graphSnapshotId = randomUUID();
    const graphSnapshotContentHash =
      randomUUID().replaceAll("-", "").repeat(2);
    const selectionPlanRevisionHash = "4".repeat(64);
    const queryPlanId = randomUUID();
    const jobId = randomUUID();
    const capability = input.schemaVersion === 5
      ? capability5
      : capability4;
    await pool.query(
      `INSERT INTO research_runs(
         id,prompt,brief_json,brief_hash,status,phase,client_bucket,
         idempotency_key,retention_expires_at,brief_contract_version,
         pipeline_version)
       VALUES($1,$2,'{}'::jsonb,$3,'queued','queued',$4,$5,
         now()+interval '1 day',2,'corpus_first_v3')`,
      [
        runId,
        `executor release ${input.suffix}`,
        "1".repeat(64),
        `executor-release-${input.suffix}`,
        `executor-release-${input.suffix}`,
      ],
    );
    await pool.query(
      `INSERT INTO playlist_contract_revisions(
         id,run_id,revision,status,contract_hash,contract_json,
         compiler_version,ontology_version,evidence_policy_version,
         question_template_version,catalog_policy_version,locale,storefront,
         answer_lineage_hash)
       VALUES($1,$2,1,'active',$3,'{}'::jsonb,'compiler-test',
         'ontology-test','evidence-test','questions-test','catalog-test',
         'en-US','us',$4)`,
      [contractId, runId, "2".repeat(64), "3".repeat(64)],
    );
    await pool.query(
      `UPDATE research_runs
       SET active_playlist_contract_revision_id=$2 WHERE id=$1`,
      [runId, contractId],
    );
    await pool.query(
      `INSERT INTO selection_plans(
         id,run_id,revision,status,plan_hash,plan_json,pipeline_version,
         policy_version,confirmed_at)
       VALUES($1,$2,1,'active',$3,'{}'::jsonb,'corpus_first_v3',
         'corpus_first_v3_policy_v1',now())`,
      [selectionPlanId, runId, selectionPlanRevisionHash],
    );
    await pool.query(
      `INSERT INTO graph_snapshots(
         id,status,content_hash,assertion_count,catalog_identity_count,locked_at)
       VALUES($1,'locked',$2,0,0,now())`,
      [graphSnapshotId, graphSnapshotContentHash],
    );
    await pool.query(
      `INSERT INTO query_plan_revisions(
         id,run_id,selection_plan_id,revision,graph_snapshot_id,engine,status,
         plan_hash,plan_json,pipeline_version,policy_version,activated_at)
       VALUES($1,$2,$3,1,$4,'portfolio','active',$5,$6::jsonb,
         'corpus_first_v3','corpus_first_v3_policy_v1',now())`,
      [
        queryPlanId,
        runId,
        selectionPlanId,
        graphSnapshotId,
        "6".repeat(64),
        JSON.stringify({
          schemaVersion: input.schemaVersion,
          selectionPlanHash: selectionPlanRevisionHash,
          executorCapabilityHash: capability.hash,
          executorCapabilityVector: capability.vector,
        }),
      ],
    );
    await pool.query(
      `INSERT INTO run_active_query_plans(run_id,query_plan_revision_id)
       VALUES($1,$2)`,
      [runId, queryPlanId],
    );
    if (input.schemaVersion === 5) {
      await pool.query(
        `INSERT INTO job_queue(
           id,run_id,kind,dedupe_key,pipeline_version,
           minimum_worker_protocol,query_plan_revision_id,stage_key,
           required_executor_revision,
           required_executor_semantic_configuration_hash)
         VALUES($1,$2,'research',$3,'corpus_first_v3',10,$4,$5,$6,$7)`,
        [
          jobId,
          runId,
          `executor-release-${input.suffix}`,
          queryPlanId,
          `v3-retrieval:active:${input.suffix}`,
          targetRevision,
          targetSemanticHash,
        ],
      );
    } else {
      // This is intentionally the pre-0020 writer shape. Additive columns and
      // triggers must leave a schema-4 drain job readable and leaseable.
      await pool.query(
        `INSERT INTO job_queue(
           id,run_id,kind,dedupe_key,pipeline_version,
           minimum_worker_protocol,query_plan_revision_id,stage_key)
         VALUES($1,$2,'research',$3,'corpus_first_v3',10,$4,$5)`,
        [
          jobId,
          runId,
          `executor-release-${input.suffix}`,
          queryPlanId,
          `v3-retrieval:active:${input.suffix}`,
        ],
      );
    }
    const createdAt = (await pool.query<{ created_at: Date }>(
      "SELECT created_at FROM job_queue WHERE id=$1",
      [jobId],
    )).rows[0]!.created_at.toISOString();
    const drain = createLegacyExecutionRouteDrainV1({
      version: LEGACY_EXECUTION_ROUTE_DRAIN_VERSION_V1,
      runId,
      contractRevisionId: contractId,
      executionRoute: "corpus_first_v3",
      targetReleaseRevision: targetRevision,
      targetSemanticConfigurationHash: targetSemanticHash,
      acceptedBefore: createdAt,
      inventoriedAt: createdAt,
      jobs: [{
        jobId,
        kind: "research",
        queryPlanRevisionId: queryPlanId,
        queryPlanHash: "6".repeat(64),
        stageKey: `v3-retrieval:active:${input.suffix}`,
        createdAt,
        sourceExecutorRevision: input.schemaVersion === 5
          ? targetRevision
          : null,
        sourceSemanticConfigurationHash: input.schemaVersion === 5
          ? targetSemanticHash
          : null,
      }],
    });
    await pool.query(
      `INSERT INTO research_checkpoints(run_id,phase,state_json)
       VALUES($1,$2,$3::jsonb)`,
      [runId, LEGACY_EXECUTION_ROUTE_DRAIN_PHASE_V1, JSON.stringify(drain)],
    );
    return { runId, contractId, queryPlanId, jobId };
  }

  test("fences schema-5 leases, renewals, attempts, and stale successors", async () => {
    expect((await pool.query<{ value: string }>(
      `SELECT value FROM settings
       WHERE key='canonical_executor_release_identity_fencing_version'`,
    )).rows[0]?.value).toBe("1");

    const rejected = await createCanonicalFixture({
      schemaVersion: 5,
      suffix: "missing-target",
    });
    await pool.query("DELETE FROM job_queue WHERE id=$1", [rejected.jobId]);
    await expect(pool.query(
      `INSERT INTO job_queue(
         id,run_id,kind,dedupe_key,pipeline_version,
         minimum_worker_protocol,query_plan_revision_id,stage_key)
       VALUES($1,$2,'research',$3,'corpus_first_v3',10,$4,'missing-target')`,
      [randomUUID(), rejected.runId, randomUUID(), rejected.queryPlanId],
    )).rejects.toThrow(/lacks an executor release identity fence/u);

    const fixture = await createCanonicalFixture({
      schemaVersion: 5,
      suffix: "schema5",
    });
    const workerOne = `worker-one-${randomUUID()}`;
    await repository.updateWorkerHeartbeat(workerOne, {
      version: "old-worker",
      semanticExecutionConfigurationHash: "c".repeat(64),
      protocolVersion: "playlist-pipeline-v10",
      capacity: 1,
      activeJobs: 0,
    });
    await expect(repository.leaseNextJob(
      workerOne,
      300_000,
      WORKER_PIPELINE_CAPABILITY,
      "all",
      {
        executorRevision: targetRevision,
        semanticExecutionConfigurationHash: targetSemanticHash,
      },
    )).rejects.toThrow(/executor release identity/u);

    await repository.updateWorkerHeartbeat(workerOne, {
      version: targetRevision,
      semanticExecutionConfigurationHash: targetSemanticHash,
      protocolVersion: "playlist-pipeline-v10",
      capacity: 1,
      activeJobs: 0,
    });
    const firstLease = await repository.leaseNextJob(
      workerOne,
      300_000,
      WORKER_PIPELINE_CAPABILITY,
      "all",
      {
        executorRevision: targetRevision,
        semanticExecutionConfigurationHash: targetSemanticHash,
      },
    );
    expect(firstLease).toMatchObject({
      id: fixture.jobId,
      requiredExecutorRevision: targetRevision,
      requiredExecutorSemanticConfigurationHash: targetSemanticHash,
    });
    const firstGeneration = firstLease!.leaseEpoch;
    await expect(repository.beginPlaylistExecutionAttempt({
      runId: fixture.runId,
      contractRevisionId: fixture.contractId,
      jobId: fixture.jobId,
      workerId: workerOne,
      queryPlanRevisionId: fixture.queryPlanId,
      stage: firstLease!.stageKey,
      attemptNumber: 1,
      leaseGeneration: firstGeneration,
      executorRevision: "wrong-worker",
      executorIdentityHash: "7".repeat(64),
      executorCapabilityHash: capability5.hash,
      executorCapabilityVector:
        capability5.vector as unknown as Record<string, unknown>,
      configurationHash: "8".repeat(64),
      semanticExecutionConfigurationHash: targetSemanticHash,
      idempotencyKey: `attempt:${fixture.jobId}:${firstGeneration}`,
    })).rejects.toMatchObject({ code: "job_lease_lost" });
    const firstAttempt = await repository.beginPlaylistExecutionAttempt({
      runId: fixture.runId,
      contractRevisionId: fixture.contractId,
      jobId: fixture.jobId,
      workerId: workerOne,
      queryPlanRevisionId: fixture.queryPlanId,
      stage: firstLease!.stageKey,
      attemptNumber: 1,
      leaseGeneration: firstGeneration,
      executorRevision: targetRevision,
      executorIdentityHash: "7".repeat(64),
      executorCapabilityHash: capability5.hash,
      executorCapabilityVector:
        capability5.vector as unknown as Record<string, unknown>,
      configurationHash: "8".repeat(64),
      semanticExecutionConfigurationHash: targetSemanticHash,
      idempotencyKey: `attempt:${fixture.jobId}:${firstGeneration}`,
    });

    await pool.query(
      `UPDATE worker_heartbeats
       SET last_seen_at=now()-interval '6 minutes'
       WHERE worker_id=$1`,
      [workerOne],
    );
    await expect(repository.renewJobLease(
      fixture.jobId,
      workerOne,
      300_000,
      firstGeneration,
    )).rejects.toThrow(/executor release identity/u);
    await expect(repository.saveResearchCheckpoint(
      fixture.runId,
      "stale-worker-write",
      { accepted: false },
      {
        jobId: fixture.jobId,
        workerId: workerOne,
        leaseEpoch: firstGeneration,
        queryPlanRevisionId: fixture.queryPlanId,
        stageKey: firstLease!.stageKey,
        contractAttemptId: firstAttempt.id,
        contractRevisionDatabaseId: fixture.contractId,
      },
    )).rejects.toMatchObject({ code: "job_lease_lost" });

    await repository.updateWorkerHeartbeat(workerOne, {
      version: targetRevision,
      semanticExecutionConfigurationHash: targetSemanticHash,
      protocolVersion: "playlist-pipeline-v10",
      capacity: 1,
      activeJobs: 0,
    });
    await repository.deferJob(
      fixture.jobId,
      workerOne,
      new Date(),
      "successor lease",
      firstGeneration,
    );
    const workerTwo = `worker-two-${randomUUID()}`;
    await repository.updateWorkerHeartbeat(workerTwo, {
      version: targetRevision,
      semanticExecutionConfigurationHash: targetSemanticHash,
      protocolVersion: "playlist-pipeline-v10",
      capacity: 1,
      activeJobs: 0,
    });
    const secondLease = await repository.leaseNextJob(
      workerTwo,
      300_000,
      WORKER_PIPELINE_CAPABILITY,
      "all",
      {
        executorRevision: targetRevision,
        semanticExecutionConfigurationHash: targetSemanticHash,
      },
    );
    expect(secondLease?.id).toBe(fixture.jobId);
    const secondAttempt = await repository.beginPlaylistExecutionAttempt({
      runId: fixture.runId,
      contractRevisionId: fixture.contractId,
      jobId: fixture.jobId,
      workerId: workerTwo,
      queryPlanRevisionId: fixture.queryPlanId,
      stage: secondLease!.stageKey,
      attemptNumber: 2,
      leaseGeneration: secondLease!.leaseEpoch,
      executorRevision: targetRevision,
      executorIdentityHash: "9".repeat(64),
      executorCapabilityHash: capability5.hash,
      executorCapabilityVector:
        capability5.vector as unknown as Record<string, unknown>,
      configurationHash: "8".repeat(64),
      semanticExecutionConfigurationHash: targetSemanticHash,
      idempotencyKey: `attempt:${fixture.jobId}:${secondLease!.leaseEpoch}`,
    });
    await expect(repository.completePlaylistExecutionAttempt({
      attemptId: firstAttempt.id,
      runId: fixture.runId,
      contractRevisionId: fixture.contractId,
      jobId: fixture.jobId,
      workerId: workerOne,
      leaseGeneration: firstGeneration,
      status: "complete",
    })).resolves.toEqual({ accepted: false, discarded: false });
    await expect(repository.completePlaylistExecutionAttempt({
      attemptId: secondAttempt.id,
      runId: fixture.runId,
      contractRevisionId: fixture.contractId,
      jobId: fixture.jobId,
      workerId: workerTwo,
      leaseGeneration: secondLease!.leaseEpoch,
      status: "complete",
    })).resolves.toEqual({ accepted: true, discarded: false });
    await repository.completeJob(
      fixture.jobId,
      workerTwo,
      secondLease!.leaseEpoch,
    );
  }, 30_000);

  test("keeps schema-4 jobs compatible with old writer/read shapes", async () => {
    const fixture = await createCanonicalFixture({
      schemaVersion: 4,
      suffix: "schema4",
    });
    const worker = `legacy-worker-${randomUUID()}`;
    await repository.updateWorkerHeartbeat(worker, {
      version: "legacy-worker",
      protocolVersion: "playlist-pipeline-v10",
      capacity: 1,
      activeJobs: 0,
    });
    const leased = await repository.leaseNextJob(
      worker,
      300_000,
      WORKER_PIPELINE_CAPABILITY,
      "all",
      {
        executorRevision: targetRevision,
        semanticExecutionConfigurationHash: targetSemanticHash,
      },
    );
    expect(leased).toMatchObject({
      id: fixture.jobId,
      requiredExecutorRevision: null,
      requiredExecutorSemanticConfigurationHash: null,
    });
    await expect(pool.query(
      `SELECT id,run_id,kind,dedupe_key,payload_json,status,
              lease_owner,lease_expires_at
       FROM job_queue WHERE id=$1`,
      [fixture.jobId],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  test("marks predecessor-pinned active work uncovered by the candidate", async () => {
    const fixture = await createCanonicalFixture({
      schemaVersion: 5,
      suffix: "predecessor-pinned",
    });
    const predecessorWorker = `predecessor-${randomUUID()}`;
    await repository.updateWorkerHeartbeat(predecessorWorker, {
      version: targetRevision,
      semanticExecutionConfigurationHash: targetSemanticHash,
      protocolVersion: "playlist-pipeline-v10",
      capacity: 1,
      activeJobs: 0,
    });
    const health = await repository.getSystemHealth();
    expect(health.executorFencing).toMatchObject({
      ready: false,
      incompleteJobs: 0,
      mismatchedActiveAttempts: 0,
      uncoveredJobs: 1,
    });
    await pool.query(
      `UPDATE job_queue SET status='cancelled',completed_at=now()
       WHERE id=$1`,
      [fixture.jobId],
    );
  });

  test("does not trust the 0020 marker when an authoritative trigger is disabled", async () => {
    expect(await repository.executorReleaseIdentityFenceAvailable()).toBe(
      true,
    );
    try {
      await pool.query(
        `ALTER TABLE job_queue
         DISABLE TRIGGER job_executor_release_identity_lease`,
      );
      expect((await pool.query<{ value: string }>(
        `SELECT value FROM settings
         WHERE key='canonical_executor_release_identity_fencing_version'`,
      )).rows[0]?.value).toBe("1");
      expect(
        await repository.executorReleaseIdentityFenceAvailable(),
      ).toBe(false);
      const health = await repository.getSystemHealth();
      expect(health.executorFencing.ready).toBe(false);
    } finally {
      await pool.query(
        `ALTER TABLE job_queue
         ENABLE TRIGGER job_executor_release_identity_lease`,
      );
    }
    expect(await repository.executorReleaseIdentityFenceAvailable()).toBe(
      true,
    );
  });
});
