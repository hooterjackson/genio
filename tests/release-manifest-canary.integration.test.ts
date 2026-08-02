import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import * as databaseSchema from "../db/schema.ts";
import {
  compilePlaylistContractRevisionV1,
  type PlaylistContractRevisionV1,
} from "../server/playlist-contract-v1.ts";
import type { UnsignedReleaseCanaryMetadata } from "../server/release-canary-metadata.ts";
import {
  parseReleaseManifestCanaryMarker,
  RELEASE_MANIFEST_CANARY_MARKER_PHASE,
  type ReleaseManifestCanaryMarkerV1,
} from "../server/release-manifest-canary.ts";
import { Repository } from "../server/repository.ts";
import { pipelineV3ResearchJob } from "../server/research-resume.ts";
import { ResearchOrchestrator } from "../server/research.ts";
import { createSelectionPlanV2 } from "../server/selection-plan-v2.ts";
import type {
  PipelineV3WriteFence,
} from "../server/pipeline-v3-worker-execution.ts";
import {
  createHostedWebEvidenceSnapshotV3,
  evaluatePlaylistOptimizationV3,
  publicTrackScopeAttestationV3,
} from "../server/pipeline-v3-retrieval.ts";
import type { SelectionPlanV3 } from "../server/selection-plan-v3.ts";
import { sha256Hex, stableStringify } from "../server/security.ts";
import { WORKER_PIPELINE_CAPABILITY } from "../server/worker-protocol.ts";
import type { PlaylistBrief, QueryPlanV3 } from "../shared/types.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseDescribe = databaseUrl ? describe.sequential : describe.skip;
const HOSTED_TEST_ACQUIRED_AT = new Date(Date.now() - 60_000).toISOString();
const HOSTED_TEST_FRESH_UNTIL = new Date(
  Date.parse(HOSTED_TEST_ACQUIRED_AT) + 29 * 24 * 60 * 60_000,
).toISOString();
const migrationDirectory = new URL("../postgres-migrations/", import.meta.url);
const migrationSql = readdirSync(migrationDirectory)
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort()
  .map((file) => readFileSync(
    new URL(`../postgres-migrations/${file}`, import.meta.url),
    "utf8",
  ))
  .join("\n-- statement-breakpoint\n");

const sourceRevision = "a".repeat(40);
const executorIdentityHash = "b".repeat(64);
const configurationHash = "c".repeat(64);

async function applyMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of migrationSql
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

function playlistBrief(count = 3): PlaylistBrief {
  return {
    title: "Release manifest canary",
    description: "An exact, source-qualified staging-only reggaeton canary.",
    mode: "curated",
    subjectEntities: ["reggaeton"],
    relationship: "genre membership",
    include: ["officially released reggaeton recordings"],
    exclude: ["karaoke and tribute recordings"],
    versionPolicy: "prefer canonical studio recordings",
    evidencePolicy: "selection-grade track-specific evidence",
    orderingPolicy: "smooth editorial flow",
    targetSize: { min: count, max: count },
    ambiguities: [],
  };
}

function playlistContract(
  prompt: string,
  count = 3,
): PlaylistContractRevisionV1 {
  return compilePlaylistContractRevisionV1({
    contractId: `contract:manifest-canary:${sha256Hex(prompt).slice(0, 16)}`,
    rawPrompt: prompt,
    requestedTrackCount: count,
    locale: "en-US",
    storefront: "us",
    clauses: [{
      id: "membership:reggaeton",
      kind: "membership",
      scope: "track",
      hardness: "hard",
      axis: "genre",
      operator: "require",
      values: ["reggaeton"],
      source: { provenance: "prompt", text: "reggaeton" },
      unknownPolicy: "reject",
    }],
    trackPredicate: {
      op: "clause",
      clauseId: "membership:reggaeton",
    },
  });
}

function releaseCanary(
  canaryId: string,
  operation: "brief" | "run",
  environment: "staging" | "production" = "staging",
): UnsignedReleaseCanaryMetadata {
  return {
    version: "genio-release-canary/v1",
    canaryId,
    environment,
    audience: environment === "staging"
      ? "https://staging.9enio.example"
      : "https://9enio.com",
    operation,
    sourceRevision,
    issuedAt: new Date().toISOString(),
    cacheMode: "reuse_disabled",
  };
}

interface PreparedCanaryBrief {
  briefRequestId: string;
  canaryId: string;
  clientBucket: string;
  contractDatabaseId: string;
  contract: PlaylistContractRevisionV1;
  playlistBrief: PlaylistBrief;
  prompt: string;
}

interface ManifestCanaryFixture extends PreparedCanaryBrief {
  runId: string;
  accessId: string;
  marker: ReleaseManifestCanaryMarkerV1;
  queryPlanRevisionId: string;
  queryPlan: QueryPlanV3;
  selectionPlan: SelectionPlanV3;
}

databaseDescribe("manifest-only release canary integration", () => {
  const schemaName =
    `genio_manifest_canary_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool;
  let pool: Pool;
  let repository: Repository;

  beforeAll(async () => {
    vi.stubEnv("RELEASE_ENVIRONMENT", "staging");
    vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", sourceRevision);
    vi.stubEnv("APPLE_STOREFRONT", "us");
    vi.stubEnv("PIPELINE_V3_ASSIGNMENT_ENABLED", "true");
    vi.stubEnv("PIPELINE_V3_OWNER_CANARY", "true");
    vi.stubEnv("PIPELINE_V3_OWNER_CANARY_GROUPS", "genre_scene");
    vi.stubEnv("PIPELINE_V3_OWNER_CANARY_MAX_TRACKS", "300");
    vi.stubEnv("PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED", "true");
    vi.stubEnv("PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED", "true");
    adminPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: "genio-manifest-canary-admin",
    });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 6,
      application_name: "genio-manifest-canary-integration",
    });
    await applyMigrations(pool);
    repository = new Repository({
      pool,
      db: drizzle(pool, { schema: databaseSchema }),
    });
  }, 30_000);

  beforeEach(async () => {
    await pool.query(`DO $$
      DECLARE table_name text;
      BEGIN
        FOR table_name IN
          SELECT tablename FROM pg_tables WHERE schemaname=current_schema()
        LOOP
          EXECUTE format(
            'TRUNCATE TABLE %I.%I CASCADE',
            current_schema(),
            table_name
          );
        END LOOP;
      END $$`);
    await pool.query(
      `INSERT INTO settings(key,value) VALUES
         ('schema_version','18'),
         ('release_manifest_canary_guards_version','1'),
         ('canonical_executor_release_identity_fencing_version','1')`,
    );
    const snapshotId = randomUUID();
    await pool.query(
      "INSERT INTO graph_snapshots(id,status) VALUES($1,'building')",
      [snapshotId],
    );
    await pool.query(
      `UPDATE graph_snapshots
       SET status='locked',content_hash=$2,assertion_count=0,
           catalog_identity_count=0,locked_at=now()
       WHERE id=$1`,
      [snapshotId, sha256Hex(`manifest-canary-snapshot:${snapshotId}`)],
    );
  }, 30_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  }, 30_000);

  async function prepareCanonicalBrief(
    label = randomUUID().slice(0, 8),
    environment: "staging" | "production" = "staging",
  ): Promise<PreparedCanaryBrief> {
    const canaryId = `manifest-${label}`;
    const prompt = `Create exactly 3 source-qualified reggaeton tracks ${label}`;
    const clientBucket = `manifest-canary-${label}-${randomUUID()}`;
    const brief = playlistBrief();
    const contract = playlistContract(prompt);
    const request = await repository.createBriefRequest({
      prompt,
      requestedTrackCount: 3,
      model: "manifest-canary-test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      briefContractVersion: 3,
      releaseCanary: releaseCanary(canaryId, "brief", environment),
    });
    const selectionPlan = createSelectionPlanV2({
      prompt,
      brief,
      storefront: "us",
    });
    const persistedContract = await repository.savePlaylistContractRevision({
      briefRequestId: request.id,
      expectedParentRevisionId: null,
      contractHash: contract.semanticHash,
      contract: structuredClone(contract) as unknown as Record<string, unknown>,
      compilerVersion: contract.versions.compiler,
      ontologyVersion: contract.versions.ontology,
      evidencePolicyVersion: contract.versions.evidencePolicy,
      questionTemplateVersion: contract.versions.questionTemplates,
      catalogPolicyVersion: contract.versions.catalogPolicy,
      locale: contract.locale,
      storefront: contract.storefront,
      answerLineageHash: sha256Hex(stableStringify(contract.answerLineage)),
    });
    await repository.saveBriefSelectionPlan(request.id, selectionPlan);
    await repository.saveBriefResult(request.id, {
      status: "complete",
      expectedStatus: "queued",
      brief,
      estimateUsd: 0,
    });
    return {
      briefRequestId: request.id,
      canaryId,
      clientBucket,
      contractDatabaseId: persistedContract.id,
      contract,
      playlistBrief: brief,
      prompt,
    };
  }

  function runInput(
    prepared: PreparedCanaryBrief,
    marker = releaseCanary(prepared.canaryId, "run"),
    productionOwnerAuthorized = false,
  ) {
    return {
      prompt: prepared.prompt,
      briefRequestId: prepared.briefRequestId,
      brief: prepared.playlistBrief,
      estimateUsd: 0,
      approvedBudgetUsd: 3,
      clientBucket: prepared.clientBucket,
      clientBucketAliases: [prepared.clientBucket],
      idempotencyKey: randomUUID(),
      autoPublish: false,
      reuseDays: 0,
      globalLimit: 100,
      forceFreshResearch: true,
      releaseCanary: marker,
      releaseManifestCanary: true,
      releaseManifestCanaryOwnerAuthorized: productionOwnerAuthorized,
    };
  }

  async function createManifestCanary(
    label = randomUUID().slice(0, 8),
  ): Promise<ManifestCanaryFixture> {
    const prepared = await prepareCanonicalBrief(label);
    const created = await repository.createRunIdempotent(runInput(prepared));
    const active = (await pool.query<{
      query_plan_revision_id: string;
      plan_json: QueryPlanV3;
      selection_plan_json: SelectionPlanV3;
      marker_json: unknown;
    }>(
      `SELECT active.query_plan_revision_id,query.plan_json,
              selection.plan_json selection_plan_json,
              marker.state_json marker_json
       FROM run_active_query_plans active
       JOIN query_plan_revisions query
         ON query.id=active.query_plan_revision_id
       JOIN selection_plans selection
         ON selection.id=query.selection_plan_id
       JOIN research_checkpoints marker
         ON marker.run_id=active.run_id AND marker.phase=$2
       WHERE active.run_id=$1`,
      [created.runId, RELEASE_MANIFEST_CANARY_MARKER_PHASE],
    )).rows[0]!;
    const marker = parseReleaseManifestCanaryMarker(active.marker_json);
    expect(marker).not.toBeNull();
    return {
      ...prepared,
      runId: created.runId,
      accessId: created.accessId,
      marker: marker!,
      queryPlanRevisionId: active.query_plan_revision_id,
      queryPlan: active.plan_json,
      selectionPlan: active.selection_plan_json,
    };
  }

  test("creates the run, schema-4 plan, and shadow marker atomically", async () => {
    const prepared = await prepareCanonicalBrief("atomic");
    await expect(repository.createRunIdempotent(runInput(prepared, {
      ...releaseCanary("manifest-wrong-scope", "run"),
    }))).rejects.toMatchObject({
      statusCode: 409,
      code: "release_canary_conflict",
    });

    expect((await pool.query<{ count: number }>(
      `SELECT (
         (SELECT count(*) FROM research_runs)
         +(SELECT count(*) FROM run_accesses)
         +(SELECT count(*) FROM selection_plans)
         +(SELECT count(*) FROM query_plan_revisions)
         +(SELECT count(*) FROM research_checkpoints
           WHERE phase=$1)
         +(SELECT count(*) FROM release_canary_markers
           WHERE operation='run')
       )::int count`,
      [RELEASE_MANIFEST_CANARY_MARKER_PHASE],
    )).rows[0]?.count).toBe(0);

    const created = await repository.createRunIdempotent(runInput(prepared));
    const persisted = (await pool.query<{
      auto_publish: boolean;
      pipeline_version: string;
      brief_contract_version: number;
      schema_version: number;
      query_plan_hash: string;
      marker_json: unknown;
      release_environment: string;
      release_operation: string;
      release_canary_id: string;
    }>(
      `SELECT run.auto_publish,run.pipeline_version,
              run.brief_contract_version,
              (query.plan_json->>'schemaVersion')::int schema_version,
              query.plan_hash query_plan_hash,
              marker.state_json marker_json,
              release.environment release_environment,
              release.operation release_operation,
              release.canary_id release_canary_id
       FROM research_runs run
       JOIN run_accesses access ON access.run_id=run.id
       JOIN run_active_query_plans active ON active.run_id=run.id
       JOIN query_plan_revisions query
         ON query.id=active.query_plan_revision_id
       JOIN research_checkpoints marker
         ON marker.run_id=run.id AND marker.phase=$2
       JOIN release_canary_markers release ON release.run_id=run.id
       WHERE run.id=$1 AND access.id=$3`,
      [
        created.runId,
        RELEASE_MANIFEST_CANARY_MARKER_PHASE,
        created.accessId,
      ],
    )).rows[0]!;
    const marker = parseReleaseManifestCanaryMarker(persisted.marker_json);
    expect(persisted).toMatchObject({
      auto_publish: false,
      pipeline_version: "corpus_first_v3",
      brief_contract_version: 3,
      schema_version: 5,
      release_environment: "staging",
      release_operation: "run",
      release_canary_id: prepared.canaryId,
    });
    expect(marker).toMatchObject({
      canaryId: prepared.canaryId,
      environment: "staging",
      executionMode: "shadow",
      publicationBoundary: "database_fenced",
      appleWriteAccess: "forbidden",
      requestedTrackCount: 3,
      queryPlanHash: persisted.query_plan_hash,
    });
  }, 30_000);

  test("permits a signed production owner manifest canary only while public assignment is paused", async () => {
    vi.stubEnv("RELEASE_ENVIRONMENT", "production");
    try {
      const prepared = await prepareCanonicalBrief("production-owner", "production");
      const marker = releaseCanary(prepared.canaryId, "run", "production");
      await expect(repository.createRunIdempotent(
        runInput(prepared, marker),
      )).rejects.toMatchObject({
        statusCode: 409,
        code: "release_manifest_canary_scope_invalid",
      });

      await pool.query(
        `INSERT INTO settings(key,value)
         VALUES('pipeline_v3_public_assignment_paused','false')
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      );
      await expect(repository.createRunIdempotent(
        runInput(prepared, marker, true),
      )).rejects.toMatchObject({
        statusCode: 409,
        code: "release_manifest_canary_scope_invalid",
      });

      await pool.query(
        `UPDATE settings
         SET value='true'
         WHERE key='pipeline_v3_public_assignment_paused'`,
      );
      await expect(repository.createRunIdempotent(
        runInput(prepared, marker, true),
      )).rejects.toMatchObject({
        statusCode: 409,
        code: "release_manifest_canary_scope_invalid",
      });
      await pool.query(
        `INSERT INTO settings(key,value)
         VALUES('pipeline_v3_public_assignment_paused:genre_scene','true')
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      );
      const created = await repository.createRunIdempotent(
        runInput(prepared, marker, true),
      );
      const persisted = (await pool.query<{
        auto_publish: boolean;
        marker_count: number;
        marker_environment: string | null;
        publication_job_count: number;
      }>(
        `SELECT run.auto_publish,
                (SELECT count(*)::int
                 FROM research_checkpoints checkpoint
                 WHERE checkpoint.run_id=run.id
                   AND checkpoint.phase=$2) marker_count,
                (SELECT checkpoint.state_json->>'environment'
                 FROM research_checkpoints checkpoint
                 WHERE checkpoint.run_id=run.id
                   AND checkpoint.phase=$2) marker_environment,
                (SELECT count(*)::int
                 FROM job_queue job
                 WHERE job.run_id=run.id
                   AND job.kind='publication') publication_job_count
         FROM research_runs run
         WHERE run.id=$1`,
        [created.runId, RELEASE_MANIFEST_CANARY_MARKER_PHASE],
      )).rows[0]!;
      expect(persisted).toEqual({
        auto_publish: false,
        marker_count: 1,
        marker_environment: "production",
        publication_job_count: 0,
      });
    } finally {
      vi.stubEnv("RELEASE_ENVIRONMENT", "staging");
    }
  });

  test("fails closed when the durable canary marker is malformed", async () => {
    const fixture = await createManifestCanary("malformed");
    await pool.query(
      `UPDATE research_checkpoints
       SET state_json='{"schemaVersion":"broken"}'::jsonb
       WHERE run_id=$1 AND phase=$2`,
      [fixture.runId, RELEASE_MANIFEST_CANARY_MARKER_PHASE],
    );

    await expect(
      new ResearchOrchestrator(repository).enqueue(fixture.runId),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "release_manifest_canary_integrity",
    });
    await expect(repository.enqueueJob({
      kind: "matching",
      runId: fixture.runId,
      payload: { runId: fixture.runId },
      dedupeKey: `matching:${fixture.runId}`,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "release_manifest_canary_integrity",
    });
    await expect(
      repository.getReleaseManifestCanaryEvidenceByAccess(fixture.accessId),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "release_manifest_canary_unavailable",
    });
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM job_queue WHERE run_id=$1",
      [fixture.runId],
    )).rows[0]?.count).toBe(0);
  }, 30_000);

  test("keeps initial, resumed, and retried work on one shadow-only fence", async () => {
    const fixture = await createManifestCanary("retry");
    const orchestrator = new ResearchOrchestrator(repository);
    await orchestrator.enqueue(fixture.runId);
    await orchestrator.enqueue(fixture.runId);
    const queued = (await pool.query<{
      id: string;
      kind: string;
      status: string;
      payload_json: Record<string, unknown>;
      stage_key: string;
      query_plan_revision_id: string;
      minimum_worker_protocol: number;
      required_executor_revision: string;
      required_executor_semantic_configuration_hash: string;
    }>(
      `SELECT id,kind,status,payload_json,stage_key,
              query_plan_revision_id,minimum_worker_protocol,
              required_executor_revision,
              required_executor_semantic_configuration_hash
       FROM job_queue WHERE run_id=$1`,
      [fixture.runId],
    )).rows;
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: "research",
      status: "queued",
      stage_key: fixture.marker.stageKey,
      query_plan_revision_id: fixture.queryPlanRevisionId,
      minimum_worker_protocol: 10,
      payload_json: {
        v3ExecutionMode: "shadow",
        stageExecutionKey: fixture.marker.stageKey,
      },
    });

    await expect(repository.leaseNextJob(
      "manifest-canary-v9",
      60_000,
      {
        protocolVersion: "playlist-pipeline-v9",
        protocolNumber: 9,
        pipelineVersions: [
          "legacy_v1",
          "catalog_first_v2",
          "corpus_first_v3",
        ],
      },
    )).resolves.toBeNull();

    await repository.updateWorkerHeartbeat(
      "manifest-canary-worker-one",
      {
        version: queued[0]!.required_executor_revision,
        semanticExecutionConfigurationHash:
          queued[0]!.required_executor_semantic_configuration_hash,
        protocolVersion: "playlist-pipeline-v10",
        capacity: 1,
        activeJobs: 0,
      },
    );
    const first = await repository.leaseNextJob(
      "manifest-canary-worker-one",
      60_000,
      WORKER_PIPELINE_CAPABILITY,
    );
    expect(first).toMatchObject({
      id: queued[0]!.id,
      runId: fixture.runId,
      stageKey: fixture.marker.stageKey,
      queryPlanRevisionId: fixture.queryPlanRevisionId,
      leaseEpoch: 1,
      payload: {
        v3ExecutionMode: "shadow",
        stageExecutionKey: fixture.marker.stageKey,
      },
    });
    await repository.failJob(
      first!.id,
      "manifest-canary-worker-one",
      "bounded provider retry",
      new Date(Date.now() - 1_000),
      first!.leaseEpoch,
    );
    await orchestrator.enqueue(fixture.runId);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM job_queue WHERE run_id=$1",
      [fixture.runId],
    )).rows[0]?.count).toBe(1);

    await repository.updateWorkerHeartbeat(
      "manifest-canary-worker-two",
      {
        version: queued[0]!.required_executor_revision,
        semanticExecutionConfigurationHash:
          queued[0]!.required_executor_semantic_configuration_hash,
        protocolVersion: "playlist-pipeline-v10",
        capacity: 1,
        activeJobs: 0,
      },
    );
    const second = await repository.leaseNextJob(
      "manifest-canary-worker-two",
      60_000,
      WORKER_PIPELINE_CAPABILITY,
    );
    expect(second).toMatchObject({
      id: first!.id,
      stageKey: fixture.marker.stageKey,
      queryPlanRevisionId: fixture.queryPlanRevisionId,
      leaseEpoch: 2,
      attempts: 2,
      payload: {
        v3ExecutionMode: "shadow",
        stageExecutionKey: fixture.marker.stageKey,
      },
    });
    const staleFence: PipelineV3WriteFence = {
      jobId: first!.id,
      workerId: "manifest-canary-worker-one",
      leaseEpoch: first!.leaseEpoch,
      queryPlanRevisionId: first!.queryPlanRevisionId!,
      stageKey: first!.stageKey,
    };
    await expect(repository.saveResearchCheckpoint(
      fixture.runId,
      "manifest-canary-stale-write",
      { accepted: false },
      staleFence,
    )).rejects.toMatchObject({
      statusCode: 409,
      code: "job_lease_lost",
    });
    await expect(repository.completeJob(
      first!.id,
      "manifest-canary-worker-one",
      first!.leaseEpoch,
    )).rejects.toMatchObject({
      statusCode: 409,
      code: "job_lease_lost",
    });
    await repository.completeJob(
      second!.id,
      "manifest-canary-worker-two",
      second!.leaseEpoch,
    );
    expect((await pool.query<{ status: string }>(
      "SELECT status FROM job_queue WHERE id=$1",
      [second!.id],
    )).rows[0]?.status).toBe("complete");
  }, 30_000);

  test("rejects every matching, publication, active-retrieval, and manifest write boundary", async () => {
    const fixture = await createManifestCanary("write-boundary");
    for (const kind of ["matching", "publication"] as const) {
      await expect(repository.enqueueJob({
        kind,
        runId: fixture.runId,
        payload: { runId: fixture.runId },
        dedupeKey: `${kind}:${fixture.runId}`,
      })).rejects.toMatchObject({
        statusCode: 409,
        code: "release_manifest_canary_write_forbidden",
      });
    }
    await expect(repository.enqueueJob(
      pipelineV3ResearchJob(
        fixture.runId,
        fixture.queryPlan,
        "active",
      ),
    )).rejects.toMatchObject({
      statusCode: 409,
      code: "release_manifest_canary_write_forbidden",
    });

    await expect(repository.persistPipelineV3RetrievalResult({
      runId: fixture.runId,
      queryPlan: fixture.queryPlan,
      plan: fixture.selectionPlan,
      result: {} as never,
      fence: {
        jobId: randomUUID(),
        workerId: "manifest-canary-write-boundary",
        leaseEpoch: 1,
        queryPlanRevisionId: fixture.queryPlanRevisionId,
        stageKey: fixture.marker.stageKey,
      },
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "release_manifest_canary_write_forbidden",
    });
    await expect(pool.query(
      `INSERT INTO job_queue(
         id,run_id,kind,dedupe_key,status,payload_json,max_attempts,
         required_executor_revision,
         required_executor_semantic_configuration_hash)
       VALUES($1,$2,'publication',$3,'queued','{}'::jsonb,1,$4,$5)`,
      [
        randomUUID(),
        fixture.runId,
        `direct-publication:${fixture.runId}`,
        sourceRevision,
        sha256Hex("manifest-canary-direct-publication"),
      ],
    )).rejects.toThrow(/release_manifest_canary_write_forbidden/u);
    await expect(pool.query(
      `INSERT INTO manifests(id,run_id,name,description,content_hash)
       VALUES($1,$2,'Forbidden manifest','Direct DB boundary fixture',$3)`,
      [randomUUID(), fixture.runId, "9".repeat(64)],
    )).rejects.toThrow(/release_manifest_canary_write_forbidden/u);
    expect((await pool.query<{
      jobs: number;
      manifests: number;
      volumes: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM job_queue WHERE run_id=$1) jobs,
         (SELECT count(*)::int FROM manifests WHERE run_id=$1) manifests,
         (SELECT count(*)::int
          FROM publication_volumes volume
          JOIN manifests manifest ON manifest.id=volume.manifest_id
          WHERE manifest.run_id=$1) volumes`,
      [fixture.runId],
    )).rows[0]).toEqual({
      jobs: 0,
      manifests: 0,
      volumes: 0,
    });
  }, 30_000);

  test("returns hash-bound exact evidence only while SQL proves zero Apple-write artifacts", async () => {
    const fixture = await createManifestCanary("evidence");
    const qualifiedTrack = (index: number) => {
      const bindingId = `binding-${index}`;
      const provenanceRoot = `evidence-${index}.example.test`;
      const sourceUrl = `https://${provenanceRoot}/manifest-integration/${index}`;
      const excerpt =
        `Artist ${index} — Track ${index}: exact reggaeton membership evidence.`;
      const hostedEvidenceSnapshot = createHostedWebEvidenceSnapshotV3({
        sourceUrl,
        excerpt,
        responseId: `manifest-integration-response-${index}`,
        outputItemId: `manifest-integration-output-${index}`,
        contentIndex: 0,
        citationStartIndex: 0,
        citationEndIndex: excerpt.length,
        excerptStartIndex: 0,
        excerptEndIndex: excerpt.length,
        acquiredAt: HOSTED_TEST_ACQUIRED_AT,
        storefront: "us",
        freshnessExpiresAt: HOSTED_TEST_FRESH_UNTIL,
        predicateIds: ["membership:reggaeton"],
        obligationIds: ["membership:reggaeton"],
      });
      const discoveryDependency = ([
        "hosted_web",
        "apple_catalog",
        "governed_evidence_graph",
        "orchestration_local",
      ] as const)[(index - 1) % 4]!;
      return {
        candidateId: `candidate-${index}`,
        title: `Track ${index}`,
        artist: `Artist ${index}`,
        album: `Album ${index}`,
        appleSongId: String(100_000 + index),
        recordingFamilyKey: `isrc:USAAA26000${String(index).padStart(3, "0")}`,
        sourceObservationIds: [`observation-${index}`],
        evidenceBindingIds: [bindingId],
        discoveryDependencyIds: [discoveryDependency],
        provenanceRoots: [provenanceRoot],
        cacheOrigin: "live" as const,
        evidenceBindings: [{
          id: bindingId,
          url: sourceUrl,
          provenanceRoot,
          strength: 0.95,
          sourceRank: index,
          kind: "hosted_web_track",
          predicateIds: ["membership:reggaeton"],
          governance: {
            policyVersion: "evidence-source-governance-v3" as const,
            useScope: "run_local" as const,
            approvalState: "approved" as const,
            accessMethod: "hosted_web_search" as const,
            licenseState: "citation_only" as const,
            licenseVersion: "integration-citation-v1",
            termsVersion: "integration-terms-v1",
            attribution: "Integration exact-track evidence",
            cachePolicy: "excerpt_only" as const,
            retentionPolicy: "ninety_days" as const,
            freshnessPolicy: "revalidate_30d" as const,
            acquiredAt: hostedEvidenceSnapshot.acquiredAt,
            freshnessExpiresAt: hostedEvidenceSnapshot.freshnessExpiresAt,
            revokedAt: null,
            sourceHash: hostedEvidenceSnapshot.snapshotHash,
            sourceRevision: hostedEvidenceSnapshot.snapshotHash,
          },
          hostedEvidenceSnapshot,
          eligibilityAttestation: publicTrackScopeAttestationV3(
            sourceUrl,
            hostedEvidenceSnapshot,
          ),
        }],
        canonicalClauseAssessments: {
          "membership:reggaeton": {
            status: "pass" as const,
            evidenceGrade: "track_specific_editorial_assertion" as const,
            evidenceIds: [bindingId],
          },
        },
        evidenceStrength: 0.95,
        scopeFit: 0.95,
        independentProvenanceRoots: 1,
        versionConfidence: 0.99,
        catalogConfidence: 0.99,
        rankingSignals: { relevance: 1 - index * 0.01 },
        sourceRank: index,
      };
    };
    const selected = Array.from({ length: 3 }, (_, index) => (
      qualifiedTrack(index + 1)
    ));
    const reserve = [qualifiedTrack(4)];
    const completedAt = new Date().toISOString();
    await repository.saveResearchCheckpoint(
      fixture.runId,
      fixture.marker.stageKey,
      {
        schemaVersion: "genio-pipeline-v3-worker/v1",
        state: "complete",
        stageKey: fixture.marker.stageKey,
        queryPlanHash: fixture.marker.queryPlanHash,
        queryPlanRevisionId: fixture.queryPlanRevisionId,
        graphSnapshotId: fixture.queryPlan.graphSnapshotId,
        executionMode: "shadow",
        engines: fixture.queryPlan.engines,
        outcome: {
          status: "exact_ready",
          requestedTrackCount: 3,
          selectedTrackCount: 3,
          reserveTrackCount: 1,
        },
        publicationBoundary: {
          appleWriteAccess: "forbidden",
          manifestDisposition: "shadow_manifest_only",
        },
        selected,
        reserve,
        playlistOptimization: evaluatePlaylistOptimizationV3({
          plan: fixture.selectionPlan,
          tracks: selected,
        }),
        completedAt,
      },
    );
    await pool.query(
      `INSERT INTO settings(key,value) VALUES
         ('canonical_execution_hardening_version','1')
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    );
    await new ResearchOrchestrator(repository).enqueue(fixture.runId);
    const workerId = `manifest-canary-worker-${randomUUID()}`;
    const job = (await pool.query<{
      id: string;
      stage_key: string;
      required_executor_capability_hash: string;
      required_executor_capability_vector: Record<string, unknown>;
      required_executor_revision: string;
      required_executor_semantic_configuration_hash: string;
    }>(
      `SELECT id,stage_key,required_executor_capability_hash,
              required_executor_capability_vector,
              required_executor_revision,
              required_executor_semantic_configuration_hash
       FROM job_queue
       WHERE run_id=$1 AND kind='research'
       ORDER BY created_at DESC LIMIT 1`,
      [fixture.runId],
    )).rows[0]!;
    expect(job.stage_key).toBe(fixture.marker.stageKey);
    await repository.updateWorkerHeartbeat(workerId, {
      version: job.required_executor_revision,
      semanticExecutionConfigurationHash:
        job.required_executor_semantic_configuration_hash,
      protocolVersion: "playlist-pipeline-v10",
      capacity: 1,
      activeJobs: 0,
    });
    await pool.query(
      `UPDATE job_queue
       SET status='leased',lease_owner=$2,
           lease_expires_at=now()+interval '5 minutes'
       WHERE id=$1`,
      [job.id, workerId],
    );
    const leaseGeneration = Number((await pool.query<{ lease_epoch: string }>(
      "SELECT lease_epoch::text FROM job_queue WHERE id=$1",
      [job.id],
    )).rows[0]!.lease_epoch);
    const attempt = await repository.beginPlaylistExecutionAttempt({
      runId: fixture.runId,
      contractRevisionId: fixture.contractDatabaseId,
      jobId: job.id,
      workerId,
      queryPlanRevisionId: fixture.queryPlanRevisionId,
      stage: job.stage_key,
      attemptNumber: 1,
      leaseGeneration,
      executorRevision: job.required_executor_revision,
      executorIdentityHash,
      executorCapabilityHash: job.required_executor_capability_hash,
      executorCapabilityVector: structuredClone(
        job.required_executor_capability_vector,
      ),
      configurationHash,
      semanticExecutionConfigurationHash:
        job.required_executor_semantic_configuration_hash,
      idempotencyKey: `manifest-canary-attempt:${fixture.runId}`,
      checkpointCursor: fixture.marker.stageKey,
    });
    await expect(repository.completePlaylistExecutionAttempt({
      attemptId: attempt.id,
      runId: fixture.runId,
      contractRevisionId: fixture.contractDatabaseId,
      jobId: job.id,
      workerId,
      leaseGeneration,
      status: "complete",
      checkpointCursor: fixture.marker.stageKey,
    })).resolves.toEqual({ accepted: true, discarded: false });
    await pool.query(
      `UPDATE research_runs
       SET status='complete',phase='v3_shadow_exact_ready',
           completed_at=now(),updated_at=now()
       WHERE id=$1`,
      [fixture.runId],
    );

    const evidence =
      await repository.getReleaseManifestCanaryEvidenceByAccess(
        fixture.accessId,
      );
    expect(evidence).toMatchObject({
      schemaVersion: "genio-release-manifest-canary-evidence/v1",
      canaryId: fixture.canaryId,
      environment: "staging",
      sourceRevision,
      executionMode: "shadow",
      publicationBoundary: "database_fenced",
      appleWriteAccess: "forbidden",
      outcome: "exact_ready",
      requestedTrackCount: 3,
      selectedTrackCount: 3,
      reserveTrackCount: 1,
      queryPlanHash: fixture.marker.queryPlanHash,
      executorIdentityHashes: [executorIdentityHash],
      configurationHashes: [configurationHash],
      zeroWriteProof: {
        autoPublish: false,
        manifestRows: 0,
        matchingJobs: 0,
        publicationJobs: 0,
        publicationVolumeRows: 0,
        orphanPlaylistRows: 0,
      },
    });
    expect(evidence.qualifiedManifestHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(evidence.evidenceHash).toMatch(/^[0-9a-f]{64}$/u);
    expect((await pool.query<{
      auto_publish: boolean;
      manifests: number;
      matching_jobs: number;
      publication_jobs: number;
      publication_volumes: number;
    }>(
      `SELECT run.auto_publish,
         (SELECT count(*)::int FROM manifests
          WHERE run_id=run.id) manifests,
         (SELECT count(*)::int FROM job_queue
          WHERE run_id=run.id AND kind='matching') matching_jobs,
         (SELECT count(*)::int FROM job_queue
          WHERE run_id=run.id AND kind='publication') publication_jobs,
         (SELECT count(*)::int
          FROM publication_volumes volume
          JOIN manifests manifest ON manifest.id=volume.manifest_id
          WHERE manifest.run_id=run.id) publication_volumes
       FROM research_runs run WHERE run.id=$1`,
      [fixture.runId],
    )).rows[0]).toEqual({
      auto_publish: false,
      manifests: 0,
      matching_jobs: 0,
      publication_jobs: 0,
      publication_volumes: 0,
    });

    await expect(pool.query(
      `INSERT INTO manifests(id,run_id,name,description,content_hash)
       VALUES($1,$2,'Forbidden manifest','Boundary corruption fixture',$3)`,
      [randomUUID(), fixture.runId, "d".repeat(64)],
    )).rejects.toThrow(/release_manifest_canary_write_forbidden/u);
  }, 30_000);
});
