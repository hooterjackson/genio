import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../db/index.ts";
import { buildPipelineOutcome } from "../server/pipeline-outcome-v2.ts";
import { readReleaseCanaryInventory } from "../server/release-canary-inventory.ts";
import { persistReleaseCanaryMarker } from "../server/release-canary-persistence.ts";
import type { UnsignedReleaseCanaryMetadata } from "../server/release-canary-metadata.ts";
import { Repository } from "../server/repository.ts";
import type { PlaylistBrief } from "../shared/types.ts";

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseDescribe = databaseUrl ? describe.sequential : describe.skip;
const migrationDirectory = new URL("../postgres-migrations/", import.meta.url);
const migrationSql = readdirSync(migrationDirectory)
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort()
  .map((file) => readFileSync(
    new URL(`../postgres-migrations/${file}`, import.meta.url),
    "utf8",
  ))
  .join("\n-- statement-breakpoint\n");

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

function marker(
  operation: "brief" | "run",
  cacheMode: "cold" | "warm" | "mixed" = "cold",
  canaryId = "rc-2.4.0-reggaeton",
): UnsignedReleaseCanaryMetadata {
  return {
    version: "genio-release-canary/v1",
    canaryId,
    environment: "staging",
    operation,
    sourceRevision: "a".repeat(40),
    issuedAt: "2026-07-23T12:00:00.000Z",
    cacheMode,
  };
}

databaseDescribe("release-canary durable persistence", () => {
  const schemaName = `needle_canary_${randomUUID().replaceAll("-", "")}`;
  let adminPool: Pool;
  let pool: Pool;
  let repository: Repository;

  beforeAll(async () => {
    adminPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: "needle-canary-admin",
    });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    const handle = createDatabase({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 4,
      application_name: "needle-canary-integration",
    });
    pool = handle.pool;
    await applyMigrations(pool);
    repository = new Repository(handle);
  }, 30_000);

  beforeEach(async () => {
    await pool.query(`DO $$
      DECLARE table_name text;
      BEGIN
        FOR table_name IN
          SELECT tablename FROM pg_tables WHERE schemaname=current_schema()
        LOOP
          EXECUTE format('TRUNCATE TABLE %I.%I CASCADE', current_schema(), table_name);
        END LOOP;
      END $$`);
    await pool.query(
      "INSERT INTO settings(key,value) VALUES('schema_version','18')",
    );
  });

  afterAll(async () => {
    if (repository) await repository.close();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  }, 30_000);

  test("atomically records a marker and prevents synthetic relabeling or scope reuse", async () => {
    const briefRequestId = randomUUID();
    const idempotentReplay = async (
      releaseCanary: UnsignedReleaseCanaryMetadata | null,
    ): Promise<void> => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await persistReleaseCanaryMarker(
          client,
          releaseCanary,
          { operation: "brief", id: briefRequestId },
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };

    const first = await pool.connect();
    try {
      await first.query("BEGIN");
      await first.query(
        `INSERT INTO brief_requests(
           id,prompt,model,client_bucket,idempotency_key,expires_at)
         VALUES($1,'Release canary','test-model','canary-bucket','canary-key',
           now()+interval '1 day')`,
        [briefRequestId],
      );
      await persistReleaseCanaryMarker(
        first,
        marker("brief"),
        { operation: "brief", id: briefRequestId },
      );
      await first.query("COMMIT");
    } catch (error) {
      await first.query("ROLLBACK");
      throw error;
    } finally {
      first.release();
    }

    await expect(idempotentReplay(marker("brief"))).resolves.toBeUndefined();
    await expect(idempotentReplay(null)).rejects.toMatchObject({
      statusCode: 409,
      code: "release_canary_conflict",
    });
    await expect(idempotentReplay(marker("brief", "warm"))).rejects.toMatchObject({
      statusCode: 409,
      code: "release_canary_conflict",
    });

    const conflictingBriefId = randomUUID();
    const conflicting = await pool.connect();
    try {
      await conflicting.query("BEGIN");
      await conflicting.query(
        `INSERT INTO brief_requests(
           id,prompt,model,client_bucket,idempotency_key,expires_at)
         VALUES($1,'Must roll back','test-model','other-bucket','other-key',
           now()+interval '1 day')`,
        [conflictingBriefId],
      );
      await expect(persistReleaseCanaryMarker(
        conflicting,
        marker("brief"),
        { operation: "brief", id: conflictingBriefId },
      )).rejects.toMatchObject({
        statusCode: 409,
        code: "release_canary_conflict",
      });
      await conflicting.query("ROLLBACK");
    } finally {
      conflicting.release();
    }

    await expect(pool.query(
      "SELECT id FROM brief_requests WHERE id=$1",
      [conflictingBriefId],
    )).resolves.toMatchObject({ rowCount: 0 });
    await expect(pool.query(
      `SELECT canary_id,environment,operation,source_revision,cache_mode,
              brief_request_id,run_id
       FROM release_canary_markers`,
    )).resolves.toMatchObject({
      rowCount: 1,
      rows: [{
        canary_id: "rc-2.4.0-reggaeton",
        environment: "staging",
        operation: "brief",
        source_revision: "a".repeat(40),
        cache_mode: "cold",
        brief_request_id: briefRequestId,
        run_id: null,
      }],
    });
  });

  test("requires a run marker to match its linked authenticated canary brief", async () => {
    const briefRequestId = randomUUID();
    const ordinaryBriefRequestId = randomUUID();
    const runId = randomUUID();
    const ordinaryBriefRunId = randomUUID();
    await pool.query(
      `INSERT INTO brief_requests(
         id,prompt,model,client_bucket,idempotency_key,expires_at)
       VALUES
         ($1,'Linked canary brief','test-model','linked-canary','linked-canary-key',
          now()+interval '1 day'),
         ($2,'Ordinary brief','test-model','linked-ordinary','linked-ordinary-key',
          now()+interval '1 day')`,
      [briefRequestId, ordinaryBriefRequestId],
    );
    const briefClient = await pool.connect();
    try {
      await briefClient.query("BEGIN");
      await persistReleaseCanaryMarker(
        briefClient,
        marker("brief", "cold", "rc-2.4.0-linked"),
        { operation: "brief", id: briefRequestId },
      );
      await briefClient.query("COMMIT");
    } catch (error) {
      await briefClient.query("ROLLBACK");
      throw error;
    } finally {
      briefClient.release();
    }
    await pool.query(
      `INSERT INTO research_runs(
         id,prompt,brief_json,brief_hash,status,phase,client_bucket,
         idempotency_key,retention_expires_at)
       VALUES
         ($1,'Linked canary run','{}'::jsonb,$3,'queued','queued',
          'run-canary','run-canary-key',now()+interval '1 day'),
         ($2,'Ordinary-brief run','{}'::jsonb,$4,'queued','queued',
          'run-ordinary','run-ordinary-key',now()+interval '1 day')`,
      [runId, ordinaryBriefRunId, "c".repeat(64), "d".repeat(64)],
    );

    const runClient = await pool.connect();
    try {
      await runClient.query("BEGIN");
      await persistReleaseCanaryMarker(
        runClient,
        marker("run", "cold", "rc-2.4.0-linked"),
        { operation: "run", id: runId },
        briefRequestId,
      );
      await runClient.query("COMMIT");
    } catch (error) {
      await runClient.query("ROLLBACK");
      throw error;
    } finally {
      runClient.release();
    }

    const mismatchClient = await pool.connect();
    try {
      await mismatchClient.query("BEGIN");
      await expect(persistReleaseCanaryMarker(
        mismatchClient,
        null,
        { operation: "run", id: runId },
        briefRequestId,
      )).rejects.toMatchObject({
        statusCode: 409,
        code: "release_canary_conflict",
      });
      await mismatchClient.query("ROLLBACK");
    } finally {
      mismatchClient.release();
    }

    const ordinaryClient = await pool.connect();
    try {
      await ordinaryClient.query("BEGIN");
      await expect(persistReleaseCanaryMarker(
        ordinaryClient,
        marker("run", "cold", "rc-2.4.0-linked"),
        { operation: "run", id: ordinaryBriefRunId },
        ordinaryBriefRequestId,
      )).rejects.toMatchObject({
        statusCode: 409,
        code: "release_canary_conflict",
      });
      await ordinaryClient.query("ROLLBACK");
    } finally {
      ordinaryClient.release();
    }

    await pool.query(
      "UPDATE brief_requests SET status='complete' WHERE id=$1",
      [briefRequestId],
    );
    await pool.query(
      "UPDATE research_runs SET status='complete',phase='complete' WHERE id=$1",
      [runId],
    );
    const inventory = await readReleaseCanaryInventory({
      pool,
      canaryId: "rc-2.4.0-linked",
      environment: "staging",
      sourceRevision: "a".repeat(40),
      executionProof: async (hiddenRunId, hiddenManifestId) => {
        expect(hiddenRunId).toBe(runId);
        expect(hiddenManifestId).toBeNull();
        return {
          contractRevision: 1,
          contractHash: "b".repeat(64),
          attempts: [{
            stage: "research",
            status: "complete",
            executorRevision: "a".repeat(40),
            executorIdentityHash: "e".repeat(64),
            configurationHash: "f".repeat(64),
            startedAt: "2026-07-23T12:00:00.000Z",
            completedAt: "2026-07-23T12:01:00.000Z",
          }],
          publicationReconciliation: {
            state: "complete",
            expectedCount: 3,
            appendedCount: 3,
            batchCursor: 3,
            expectedOrderedIdsHash: "1".repeat(64),
            observedOrderedIdsHash: "1".repeat(64),
            orderedIdsVerified: true,
            completedAt: "2026-07-23T12:02:00.000Z",
          },
        };
      },
    });
    expect(inventory).toMatchObject({
      schemaAvailable: true,
      canaryId: "rc-2.4.0-linked",
      readyForReleaseEvidence: true,
      operations: [
        { operation: "brief", status: "complete" },
        {
          operation: "run",
          status: "complete",
          executionProof: {
            contractHash: "b".repeat(64),
            publicationReconciliation: { orderedIdsVerified: true },
          },
        },
      ],
    });
    const serializedInventory = JSON.stringify(inventory);
    expect(serializedInventory).not.toContain(briefRequestId);
    expect(serializedInventory).not.toContain(runId);
    expect(serializedInventory).not.toContain("Linked canary");

    await expect(pool.query(
      "SELECT operation,count(*)::int count FROM release_canary_markers GROUP BY operation ORDER BY operation",
    )).resolves.toMatchObject({
      rows: [
        { operation: "brief", count: 1 },
        { operation: "run", count: 1 },
      ],
    });
  });

  test("persists markers through repository transactions and excludes synthetic traffic from every resolution denominator", async () => {
    const windowStartedAt = new Date(Date.now() - 1_000);
    const exactBrief: PlaylistBrief = {
      title: "Canary metrics fixture",
      description: "A deterministic three-track integration fixture.",
      mode: "curated",
      subjectEntities: ["Canary Fixture"],
      relationship: "primary artist",
      include: ["officially released recordings"],
      exclude: ["unreleased recordings"],
      versionPolicy: "one canonical studio recording",
      evidencePolicy: "verified or corroborated",
      orderingPolicy: "chronological",
      targetSize: { min: 3, max: 3 },
      ambiguities: [],
    };
    const ordinaryBucket = `ordinary-${randomUUID()}`;
    const canaryBucket = `canary-${randomUUID()}`;
    const ordinaryBriefKey = `ordinary-brief-${randomUUID()}`;
    const canaryBriefKey = `canary-brief-${randomUUID()}`;
    const ordinaryBrief = await repository.createBriefRequest({
      prompt: "Build the ordinary metrics fixture",
      requestedTrackCount: 3,
      model: "test-model",
      clientBucket: ordinaryBucket,
      clientBucketAliases: [ordinaryBucket],
      idempotencyKey: ordinaryBriefKey,
    });
    const canaryBrief = await repository.createBriefRequest({
      prompt: "Build the synthetic metrics fixture",
      requestedTrackCount: 3,
      model: "test-model",
      clientBucket: canaryBucket,
      clientBucketAliases: [canaryBucket],
      idempotencyKey: canaryBriefKey,
      releaseCanary: marker("brief", "cold", "rc-2.4.0-metrics"),
    });
    await expect(repository.createBriefRequest({
      prompt: "Build the synthetic metrics fixture",
      requestedTrackCount: 3,
      model: "test-model",
      clientBucket: canaryBucket,
      clientBucketAliases: [canaryBucket],
      idempotencyKey: canaryBriefKey,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "release_canary_conflict",
    });
    await Promise.all([
      repository.saveBriefResult(ordinaryBrief.id, {
        status: "complete",
        brief: exactBrief,
        estimateUsd: 0,
      }),
      repository.saveBriefResult(canaryBrief.id, {
        status: "complete",
        brief: exactBrief,
        estimateUsd: 0,
      }),
    ]);
    const ordinaryRunKey = `ordinary-run-${randomUUID()}`;
    const canaryRunKey = `canary-run-${randomUUID()}`;
    const ordinaryRun = await repository.createRunIdempotent({
      prompt: "Build the ordinary metrics fixture",
      briefRequestId: ordinaryBrief.id,
      brief: exactBrief,
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket: ordinaryBucket,
      clientBucketAliases: [ordinaryBucket],
      idempotencyKey: ordinaryRunKey,
      autoPublish: true,
      reuseDays: 0,
      globalLimit: 100,
    });
    const canaryRun = await repository.createRunIdempotent({
      prompt: "Build the synthetic metrics fixture",
      briefRequestId: canaryBrief.id,
      brief: exactBrief,
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket: canaryBucket,
      clientBucketAliases: [canaryBucket],
      idempotencyKey: canaryRunKey,
      autoPublish: true,
      globalLimit: 100,
      releaseCanary: marker("run", "cold", "rc-2.4.0-metrics"),
    });
    await expect(repository.createRunIdempotent({
      prompt: "Build the synthetic metrics fixture",
      briefRequestId: canaryBrief.id,
      brief: exactBrief,
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket: canaryBucket,
      clientBucketAliases: [canaryBucket],
      idempotencyKey: canaryRunKey,
      autoPublish: true,
      globalLimit: 100,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "release_canary_conflict",
    });

    const questionSetRows = [
      {
        briefRequestId: ordinaryBrief.id,
        questionSetId: randomUUID(),
        questionSetHash: "2".repeat(64),
        answerHash: "4".repeat(64),
        executionDelta: [],
        normalizedAnswers: [{ questionId: "flow", skipped: true }],
        idempotencyKey: `answer-${randomUUID()}`,
      },
      {
        briefRequestId: canaryBrief.id,
        questionSetId: randomUUID(),
        questionSetHash: "3".repeat(64),
        answerHash: "5".repeat(64),
        executionDelta: [{ op: "add_clause", clauseId: "synthetic-only" }],
        normalizedAnswers: [{ questionId: "scope", optionId: "recommended" }],
        idempotencyKey: `answer-${randomUUID()}`,
      },
    ];
    for (const [index, row] of questionSetRows.entries()) {
      await pool.query(
        `INSERT INTO guidance_question_sets(
           id,brief_request_id,revision,question_set_hash,
           request_classification,generation_mode,guidance_policy_version,
           locale,storefront,target_track_count,explicit_constraint_hash,
           questions_json,active)
         VALUES($1,$2,1,$3,'broad_curated','deterministic',
           'metrics-fixture-v1','en-US','us',3,$4,'[]'::jsonb,true)`,
        [
          row.questionSetId,
          row.briefRequestId,
          row.questionSetHash,
          String(index + 6).repeat(64),
        ],
      );
      await pool.query(
        `INSERT INTO guidance_answer_sets(
           id,brief_request_id,question_set_id,question_set_hash,
           normalized_answers_json,answer_hash,execution_delta_json,
           execution_delta_hash,idempotency_key)
         VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9)`,
        [
          randomUUID(),
          row.briefRequestId,
          row.questionSetId,
          row.questionSetHash,
          JSON.stringify(row.normalizedAnswers),
          row.answerHash,
          JSON.stringify(row.executionDelta),
          String(index + 8).repeat(64),
          row.idempotencyKey,
        ],
      );
    }

    for (const created of [ordinaryRun, canaryRun]) {
      const versions = await pool.query<{
        pipeline_version: "legacy_v1";
        policy_version: "legacy_v1";
      }>(
        "SELECT pipeline_version,policy_version FROM research_runs WHERE id=$1",
        [created.runId],
      );
      await repository.savePipelineOutcome(created.runId, buildPipelineOutcome({
        pipelineVersion: versions.rows[0]!.pipeline_version,
        policyVersion: versions.rows[0]!.policy_version,
        status: "complete",
        targetTrackCount: 3,
        discoveredTrackCount: 3,
        qualifiedTrackCount: 3,
        selectedTrackCount: 3,
        publishedTrackCount: 3,
        completedAt: new Date().toISOString(),
      }));
      await pool.query(
        `UPDATE research_runs
         SET status='complete',phase='complete',completed_at=now()
         WHERE id=$1`,
        [created.runId],
      );
    }

    await expect(repository.getPlaylistResolutionMetrics({
      windowStartedAt,
      windowEndedAt: new Date(Date.now() + 1_000),
    })).resolves.toMatchObject({
      schemaAvailable: true,
      syntheticTrafficExcluded: true,
      denominators: {
        acceptedValidSubmissions: 1,
        guidance: {
          offered: 1,
          answered: 1,
          skipped: 1,
          abandoned: 0,
        },
        researchStartedExactConfirmed: 1,
        userAuthorizedScopeOrCountChanges: 0,
      },
      outcomes: {
        // Skipping an optional question is an answered guidance event, but
        // it is not a user-authorized semantic contract revision.
        originalRequestExactSuccess: 1,
        guidedExactResolution: 0,
      },
    });

    const baseContractRevisionId = randomUUID();
    const resultingContractRevisionId = randomUUID();
    await pool.query(
      `INSERT INTO playlist_contract_revisions(
         id,brief_request_id,revision,parent_revision_id,status,
         contract_hash,contract_json,compiler_version,ontology_version,
         evidence_policy_version,question_template_version,
         catalog_policy_version,locale,storefront,answer_lineage_hash)
       VALUES
         ($1,$3,1,NULL,'superseded',$4,'{}'::jsonb,
          'metrics-v1','metrics-v1','metrics-v1','metrics-v1',
          'metrics-v1','en-US','us',$6),
         ($2,$3,2,$1,'active',$5,'{}'::jsonb,
          'metrics-v1','metrics-v1','metrics-v1','metrics-v1',
          'metrics-v1','en-US','us',$7)`,
      [
        baseContractRevisionId,
        resultingContractRevisionId,
        ordinaryBrief.id,
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        "d".repeat(64),
      ],
    );
    await pool.query(
      `INSERT INTO guidance_answer_sets(
         id,brief_request_id,question_set_id,question_set_hash,
         normalized_answers_json,answer_hash,execution_delta_json,
         execution_delta_hash,idempotency_key,base_contract_revision_id,
         resulting_contract_revision_id)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10,$11)`,
      [
        randomUUID(),
        ordinaryBrief.id,
        questionSetRows[0]!.questionSetId,
        questionSetRows[0]!.questionSetHash,
        JSON.stringify([{
          questionId: "flow",
          optionId: "chronological",
        }]),
        "e".repeat(64),
        JSON.stringify([{
          op: "replace_clause",
          clauseId: "flow",
        }]),
        "f".repeat(64),
        `answer-${randomUUID()}`,
        baseContractRevisionId,
        resultingContractRevisionId,
      ],
    );
    await expect(repository.getPlaylistResolutionMetrics({
      windowStartedAt,
      windowEndedAt: new Date(Date.now() + 1_000),
    })).resolves.toMatchObject({
      outcomes: {
        originalRequestExactSuccess: 0,
        guidedExactResolution: 1,
      },
    });
    await expect(pool.query(
      `SELECT operation,count(*)::int count
       FROM release_canary_markers
       GROUP BY operation ORDER BY operation`,
    )).resolves.toMatchObject({
      rows: [
        { operation: "brief", count: 1 },
        { operation: "run", count: 1 },
      ],
    });
  });

  test("projects execution and Apple reconciliation proof without internal identifiers", async () => {
    const proofBrief: PlaylistBrief = {
      title: "Safe proof fixture",
      description: "A fixture whose internal identifiers must never be public.",
      mode: "curated",
      subjectEntities: ["Proof Fixture"],
      relationship: "primary artist",
      include: ["officially released recordings"],
      exclude: [],
      versionPolicy: "one canonical studio recording",
      evidencePolicy: "verified or corroborated",
      orderingPolicy: "chronological",
      targetSize: { min: 3, max: 3 },
      ambiguities: [],
    };
    const runId = await repository.createRun(
      "private prompt must not appear in release evidence",
      proofBrief,
      0,
      1,
    );
    const contractRevisionId = randomUUID();
    const contractHash = "a".repeat(64);
    await pool.query(
      `INSERT INTO playlist_contract_revisions(
         id,run_id,revision,status,contract_hash,contract_json,
         compiler_version,ontology_version,evidence_policy_version,
         question_template_version,catalog_policy_version,locale,storefront,
         answer_lineage_hash)
       VALUES($1,$2,1,'active',$3,'{}'::jsonb,
         'compiler-v1','ontology-v1','evidence-v1','questions-v1',
         'catalog-v1','en-US','us',$4)`,
      [contractRevisionId, runId, contractHash, "b".repeat(64)],
    );
    await pool.query(
      "UPDATE research_runs SET active_playlist_contract_revision_id=$2 WHERE id=$1",
      [runId, contractRevisionId],
    );
    const attempt = await repository.beginPlaylistExecutionAttempt({
      runId,
      contractRevisionId,
      stage: "publication",
      dependencyKey: "apple",
      attemptNumber: 1,
      leaseGeneration: 1,
      executorRevision: "c".repeat(40),
      executorIdentityHash: "d".repeat(64),
      configurationHash: "e".repeat(64),
      idempotencyKey: `proof-attempt-${randomUUID()}`,
    });
    await repository.completePlaylistExecutionAttempt({
      attemptId: attempt.id,
      runId,
      contractRevisionId,
      leaseGeneration: 1,
      status: "complete",
    });
    const manifestId = randomUUID();
    await pool.query(
      `INSERT INTO manifests(
         id,run_id,name,description,content_hash,
         contract_revision_id,contract_hash)
       VALUES($1,$2,'Safe proof','No identifiers',$3,$4,$5)`,
      [
        manifestId,
        runId,
        "f".repeat(64),
        contractRevisionId,
        contractHash,
      ],
    );
    await pool.query(
      `INSERT INTO playlist_publication_reconciliations(
         id,run_id,contract_revision_id,execution_attempt_id,manifest_id,
         state,expected_ordered_ids_hash,observed_ordered_ids_hash,
         appended_count,expected_count,batch_cursor,idempotency_key,
         completed_at)
       VALUES($1,$2,$3,$4,$5,'complete',$6,$6,3,3,3,$7,now())`,
      [
        randomUUID(),
        runId,
        contractRevisionId,
        attempt.id,
        manifestId,
        "1".repeat(64),
        `proof-reconcile-${randomUUID()}`,
      ],
    );

    const proof = await repository.getPublicRunExecutionProof(runId, manifestId);
    expect(proof).toMatchObject({
      contractRevision: 1,
      contractHash,
      attempts: [{
        stage: "publication",
        status: "complete",
        executorRevision: "c".repeat(40),
        executorIdentityHash: "d".repeat(64),
        configurationHash: "e".repeat(64),
      }],
      publicationReconciliation: {
        state: "complete",
        expectedCount: 3,
        appendedCount: 3,
        batchCursor: 3,
        expectedOrderedIdsHash: "1".repeat(64),
        observedOrderedIdsHash: "1".repeat(64),
        orderedIdsVerified: true,
      },
    });
    const serializedProof = JSON.stringify(proof);
    for (const privateValue of [
      runId,
      contractRevisionId,
      attempt.id,
      manifestId,
      "private prompt",
    ]) {
      expect(serializedProof).not.toContain(privateValue);
    }
    expect(proof?.contractHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(proof?.attempts[0]?.executorIdentityHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(proof?.attempts[0]?.configurationHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("keeps ordinary requests compatible before the expand-only canary table exists", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DROP TABLE release_canary_markers");
      await expect(persistReleaseCanaryMarker(
        client,
        null,
        { operation: "brief", id: randomUUID() },
      )).resolves.toBeUndefined();
      await expect(persistReleaseCanaryMarker(
        client,
        marker("brief"),
        { operation: "brief", id: randomUUID() },
      )).rejects.toMatchObject({
        statusCode: 503,
        code: "release_canary_unavailable",
      });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
