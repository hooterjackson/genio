import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { Repository } from "../server/repository.ts";
import type {
  QualifiedTrackV3,
  RetrievalOutcomeStatusV3,
  RetrievalResultV3,
} from "../server/pipeline-v3-retrieval.ts";
import { publicTrackScopeAttestationV3 } from "../server/pipeline-v3-retrieval.ts";
import type { PipelineV3WriteFence } from "../server/pipeline-v3-worker-execution.ts";
import { ResearchOrchestrator } from "../server/research.ts";
import type { SelectionPlanV3 } from "../server/selection-plan-v3.ts";
import type { PlaylistBrief, QueryPlanV3 } from "../shared/types.ts";

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

function curatedBrief(title: string, count: number): PlaylistBrief {
  return {
    title,
    description: `A source-qualified ${count}-track playlist for Pipeline V3 persistence testing.`,
    mode: "curated",
    subjectEntities: [title],
    relationship: "genre membership",
    include: ["released recordings in the requested music genre"],
    exclude: ["karaoke, tribute, and incompatible versions"],
    versionPolicy: "prefer canonical studio recordings",
    evidencePolicy: "auditable exact track-scope evidence",
    orderingPolicy: "rank by relevance, then interleave artists and albums",
    targetSize: { min: count, max: count },
    ambiguities: [],
  };
}

function qualifiedTrack(prefix: string, index: number): QualifiedTrackV3 {
  const ordinal = String(index + 1).padStart(4, "0");
  const sourceUrl = `https://example.test/${encodeURIComponent(prefix)}/tracks/${ordinal}`;
  return {
    candidateId: `${prefix}:candidate:${ordinal}`,
    title: `${prefix} Track ${ordinal}`,
    artist: `${prefix} Artist ${Math.floor(index / 3) + 1}`,
    album: `${prefix} Album ${Math.floor(index / 10) + 1}`,
    appleSongId: `${prefix}-apple-${ordinal}`,
    recordingFamilyKey: `${prefix}:family:${ordinal}`,
    sourceObservationIds: [`${prefix}:observation:${ordinal}`],
    evidenceBindingIds: [`${prefix}:binding:${ordinal}`],
    evidenceBindings: [{
      id: `${prefix}:binding:${ordinal}`,
      url: sourceUrl,
      provenanceRoot: `example.test:${prefix}`,
      strength: 0.95,
      sourceRank: index + 1,
      kind: "track_specific_source",
      governance: {
        policyVersion: "evidence-source-governance-v3",
        useScope: "run_local",
        approvalState: "approved",
        accessMethod: "hosted_web_search",
        licenseState: "citation_only",
        licenseVersion: "test-citation-v1",
        termsVersion: "test-terms-v1",
        attribution: "Integration source",
        cachePolicy: "excerpt_only",
        retentionPolicy: "ninety_days",
        freshnessPolicy: "revalidate_30d",
        sourceHash: "a".repeat(64),
        sourceRevision: "a".repeat(64),
      },
      eligibilityAttestation: publicTrackScopeAttestationV3(sourceUrl),
    }],
    evidenceStrength: 0.95,
    scopeFit: 0.99,
    independentProvenanceRoots: 1,
    versionConfidence: 0.99,
    catalogConfidence: 0.99,
    rankingSignals: { relevance: Math.max(0.1, 1 - index / 1_000) },
    sourceRank: index + 1,
  };
}

function retrievalResult(input: {
  runId: string;
  target: number;
  selectedCount: number;
  reserveCount?: number;
  status: Extract<RetrievalOutcomeStatusV3, "exact_ready" | "partial_ready" | "no_compatible_tracks">;
  prefix: string;
}): RetrievalResultV3 {
  const reserveCount = input.reserveCount ?? 0;
  const selected = Array.from({ length: input.selectedCount }, (_, index) => (
    qualifiedTrack(input.prefix, index)
  ));
  const reserve = Array.from({ length: reserveCount }, (_, index) => (
    qualifiedTrack(`${input.prefix}-reserve`, index)
  ));
  const qualifiedPool = [...selected, ...reserve];
  const exact = input.status === "exact_ready";
  const partial = input.status === "partial_ready";
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
      status: input.status,
      stopReason: exact ? "qualified_reserve_satisfied" : "frontier_exhausted",
      requestedTrackCount: input.target,
      qualifiedTrackCount: qualifiedPool.length,
      selectedTrackCount: selected.length,
      reserveTrackCount: reserve.length,
      shortfall: Math.max(0, input.target - selected.length),
      requiresPartialPublicationDecision: partial,
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
      id: "curated_genre_scene:trusted_scoped_containers",
      engine: "curated_genre_scene",
      kind: "trusted_containers",
      status: "exhausted",
      rounds: 1,
      rawCandidates: qualifiedPool.length,
      newQualifiedFamilies: qualifiedPool.length,
      consecutiveZeroQualifiedYieldRounds: 0,
      providerFailures: 0,
      cursor: null,
    }],
    integrityEvents: [],
    publicationBoundary: {
      appleWriteAccess: "forbidden",
      manifestDisposition: exact
        ? "exact_draft_ready"
        : partial
          ? "partial_confirmation_required"
          : "no_manifest",
    },
  };
}

databaseDescribe("Pipeline V3 governed manifest persistence", () => {
  const schemaName = `genio_v3_manifest_${randomUUID().replaceAll("-", "")}`;
  const graphSnapshotId = randomUUID();
  let adminPool: Pool;
  let pool: Pool;
  let repository: Repository;

  beforeAll(async () => {
    vi.stubEnv("PIPELINE_V3_ASSIGNMENT_ENABLED", "true");
    vi.stubEnv("PIPELINE_V3_OWNER_CANARY", "true");
    vi.stubEnv("PIPELINE_V3_OWNER_CANARY_GROUPS", "genre_scene");
    vi.stubEnv("PIPELINE_V3_OWNER_CANARY_MAX_TRACKS", "300");
    vi.stubEnv("APPLE_STOREFRONT", "us");
    adminPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      application_name: "genio-v3-manifest-admin",
    });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
      max: 5,
      application_name: "genio-v3-manifest-integration",
    });
    await applySql(pool, migrationSql);
    await pool.query("INSERT INTO graph_snapshots(id,status) VALUES($1,'building')", [graphSnapshotId]);
    await pool.query(
      `UPDATE graph_snapshots
       SET status='locked',content_hash=$2,assertion_count=0,catalog_identity_count=0,locked_at=now()
       WHERE id=$1`,
      [graphSnapshotId, "a".repeat(64)],
    );
    await pool.query(
      `INSERT INTO apple_authorizations(
         id,ciphertext,iv,auth_tag,key_version,storefront,status,last_validated_at)
       VALUES('owner','test-ciphertext',$1,$2,'test-key','us','valid',now())`,
      ["b".repeat(24), "c".repeat(32)],
    );
    repository = new Repository({ pool, db: {} } as never);
  }, 30_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  }, 30_000);

  async function createLeasedRun(target: number, label: string): Promise<{
    runId: string;
    accessId: string;
    selectionPlan: SelectionPlanV3;
    queryPlan: QueryPlanV3;
    fence: PipelineV3WriteFence;
  }> {
    const clientBucket = `v3-manifest-${label}-${randomUUID()}`;
    const created = await repository.createRunIdempotent({
      prompt: `Create ${target} released recordings in the ${label} music genre`,
      brief: curatedBrief(label, target),
      estimateUsd: 0,
      approvedBudgetUsd: 0,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: randomUUID(),
      autoPublish: false,
      reuseDays: 0,
      globalLimit: 100,
      forceFreshResearch: true,
    });
    await new ResearchOrchestrator(repository).enqueue(created.runId);

    const active = (await pool.query<{
      selection_plan: SelectionPlanV3;
      query_plan: QueryPlanV3;
      query_plan_id: string;
      job_id: string;
      stage_key: string;
      access_id: string;
    }>(
      `SELECT sp.plan_json selection_plan,qp.plan_json query_plan,qp.id query_plan_id,
              jq.id job_id,jq.stage_key,ra.id access_id
       FROM selection_plans sp
       JOIN run_active_query_plans aqp ON aqp.run_id=sp.run_id
       JOIN query_plan_revisions qp ON qp.id=aqp.query_plan_revision_id
       JOIN job_queue jq ON jq.run_id=sp.run_id AND jq.kind='research'
       JOIN run_accesses ra ON ra.run_id=sp.run_id AND ra.deleted_at IS NULL
       WHERE sp.run_id=$1 AND sp.status='active'
       ORDER BY jq.created_at DESC,ra.created_at DESC LIMIT 1`,
      [created.runId],
    )).rows[0]!;
    const workerId = `v3-manifest-worker-${randomUUID()}`;
    await pool.query(
      `UPDATE job_queue
       SET status='leased',lease_owner=$2,lease_expires_at=now()+interval '5 minutes'
       WHERE id=$1`,
      [active.job_id, workerId],
    );
    const leaseEpoch = Number((await pool.query<{ lease_epoch: string }>(
      "SELECT lease_epoch::text FROM job_queue WHERE id=$1",
      [active.job_id],
    )).rows[0]!.lease_epoch);
    return {
      runId: created.runId,
      accessId: active.access_id,
      selectionPlan: active.selection_plan,
      queryPlan: active.query_plan,
      fence: {
        jobId: active.job_id,
        workerId,
        leaseEpoch,
        queryPlanRevisionId: active.query_plan_id,
        stageKey: active.stage_key,
      },
    };
  }

  test.each([150, 300])(
    "locks a provenance-bound %i-track manifest and queues exact publication idempotently",
    async (target) => {
      const context = await createLeasedRun(target, `disco-${target}`);
      const result = retrievalResult({
        runId: context.runId,
        target,
        selectedCount: target,
        reserveCount: Math.max(10, Math.ceil(target * 0.2)),
        status: "exact_ready",
        prefix: `exact-${target}`,
      });
      const first = await repository.persistPipelineV3RetrievalResult({
        runId: context.runId,
        queryPlan: context.queryPlan,
        plan: context.selectionPlan,
        result,
        fence: context.fence,
      });
      const retried = await repository.persistPipelineV3RetrievalResult({
        runId: context.runId,
        queryPlan: context.queryPlan,
        plan: context.selectionPlan,
        result,
        fence: context.fence,
      });

      expect(first).toMatchObject({
        manifestId: expect.any(String),
        manifestRevisionId: expect.any(String),
        manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        publicationState: "queued",
      });
      expect(retried).toEqual(first);

      const stored = (await pool.query<{
        status: string;
        track_count: number;
        reserve_count: number;
        binding_count: number;
        selection_plan_id: string;
        query_plan_revision_id: string;
        graph_snapshot_id: string;
        run_spec_hash: string;
        publication_jobs: number;
      }>(
        `SELECT mr.status,
                (SELECT count(*)::int FROM manifest_revision_tracks t
                 WHERE t.manifest_revision_id=mr.id) track_count,
                (SELECT count(*)::int FROM manifest_revision_reserve_tracks t
                 WHERE t.manifest_revision_id=mr.id) reserve_count,
                (SELECT count(DISTINCT t.candidate_id)::int
                 FROM manifest_revision_tracks t
                 JOIN track_scope_bindings b ON b.candidate_id=t.candidate_id
                 WHERE t.manifest_revision_id=mr.id AND b.eligibility='qualifying') binding_count,
                mr.selection_plan_id,mr.query_plan_revision_id,mr.graph_snapshot_id,mr.run_spec_hash,
                (SELECT count(*)::int FROM job_queue j
                 WHERE j.run_id=m.run_id AND j.kind='publication') publication_jobs
         FROM manifest_revisions mr
         JOIN manifests m ON m.id=mr.manifest_id
         WHERE mr.id=$1`,
        [first.manifestRevisionId],
      )).rows[0]!;
      expect(stored).toMatchObject({
        status: "locked",
        track_count: target,
        reserve_count: Math.max(10, Math.ceil(target * 0.2)),
        binding_count: target,
        query_plan_revision_id: context.fence.queryPlanRevisionId,
        graph_snapshot_id: graphSnapshotId,
        publication_jobs: 1,
      });
      expect(stored.selection_plan_id).toBeTruthy();
      expect(stored.run_spec_hash).toMatch(/^[a-f0-9]{64}$/u);
      expect((await pool.query<{ count: number }>(
        "SELECT count(*)::int count FROM manifest_revisions WHERE manifest_id=$1",
        [first.manifestId],
      )).rows[0]?.count).toBe(1);
    },
    120_000,
  );

  test("locks a partial manifest without any Apple write until capability-bound consent", async () => {
    const context = await createLeasedRun(50, "french-jazz-partial");
    const result = retrievalResult({
      runId: context.runId,
      target: 50,
      selectedCount: 23,
      status: "partial_ready",
      prefix: "partial-23",
    });
    const persisted = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result,
      fence: context.fence,
    });
    expect(persisted).toMatchObject({
      manifestId: expect.any(String),
      manifestRevisionId: expect.any(String),
      manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      publicationState: "partial_confirmation_required",
    });
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM job_queue WHERE run_id=$1 AND kind='publication'",
      [context.runId],
    )).rows[0]?.count).toBe(0);

    const outcomeHash = "d".repeat(64);
    await repository.saveResearchCheckpoint(context.runId, "partial_ready", {
      outcomeHash,
      outcomeVersion: 1,
      targetTrackCount: 50,
      verifiedTrackCount: 23,
      shortfall: 27,
      remainingStrategyCount: 0,
      continueAvailable: false,
      preparedAt: new Date().toISOString(),
      pipelineVersion: "corpus_first_v3",
      manifestId: persisted.manifestId,
      manifestRevisionId: persisted.manifestRevisionId,
      manifestHash: persisted.manifestHash,
    });
    await repository.updateRun(context.runId, {
      status: "partial_ready",
      phase: "partial_confirmation_required",
      error: null,
    });
    const sessionId = randomUUID();
    await pool.query(
      `INSERT INTO capability_sessions(id,run_id,token_hash,expires_at)
       VALUES($1,$2,$3,now()+interval '1 day')`,
      [sessionId, context.runId, "e".repeat(64)],
    );
    await pool.query(
      `INSERT INTO capability_session_accesses(session_id,run_id,access_id)
       VALUES($1,$2,$3)`,
      [sessionId, context.runId, context.accessId],
    );
    const confirmed = await repository.confirmPartialPublication({
      runId: context.runId,
      capabilitySessionId: sessionId,
      idempotencyKey: randomUUID(),
      outcomeHash,
      manifestId: persisted.manifestId,
      manifestHash: persisted.manifestHash,
    });
    expect(confirmed).toMatchObject({ id: persisted.manifestId, tracks: expect.any(Array) });
    expect(confirmed.tracks).toHaveLength(23);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM job_queue WHERE run_id=$1 AND kind='publication'",
      [context.runId],
    )).rows[0]?.count).toBe(0);

    const queued = await repository.queueManifestPublication({
      runId: context.runId,
      manifestId: persisted.manifestId!,
      appleAuthorized: true,
      clientBucket: `partial-confirm-${randomUUID()}`,
      clientBucketAliases: [`partial-confirm-${randomUUID()}`],
      rateLimit: Number.POSITIVE_INFINITY,
    });
    expect(queued).toMatchObject({ queued: true, state: "queued", runStatus: "publishing" });
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM job_queue WHERE run_id=$1 AND kind='publication'",
      [context.runId],
    )).rows[0]?.count).toBe(1);
  }, 60_000);

  test("completes a zero-compatible result without a manifest or Apple write", async () => {
    const context = await createLeasedRun(25, "narrow-zero-result");
    const persisted = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result: retrievalResult({
        runId: context.runId,
        target: 25,
        selectedCount: 0,
        status: "no_compatible_tracks",
        prefix: "zero",
      }),
      fence: context.fence,
    });
    expect(persisted).toEqual({
      manifestId: null,
      manifestRevisionId: null,
      manifestHash: null,
      publicationState: "not_applicable",
    });
    expect((await pool.query<{ manifests: number; publication_jobs: number }>(
      `SELECT
         (SELECT count(*)::int FROM manifests WHERE run_id=$1) manifests,
         (SELECT count(*)::int FROM job_queue WHERE run_id=$1 AND kind='publication') publication_jobs`,
      [context.runId],
    )).rows[0]).toEqual({ manifests: 0, publication_jobs: 0 });
  }, 30_000);

  test("rejects URL-less synthetic evidence before manifest persistence", async () => {
    const context = await createLeasedRun(1, "synthetic-evidence");
    const unsafe = retrievalResult({
      runId: context.runId,
      target: 1,
      selectedCount: 1,
      status: "exact_ready",
      prefix: "synthetic",
    });
    const selected = unsafe.selected.map((track) => ({
      ...track,
      evidenceBindings: undefined,
    }));
    await expect(repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result: {
        ...unsafe,
        selected,
        qualifiedPool: selected,
      },
      fence: context.fence,
    })).rejects.toMatchObject({ code: "pipeline_v3_evidence_attestation_missing" });
    expect((await pool.query<{ candidates: number; manifests: number }>(
      `SELECT
         (SELECT count(*)::int FROM track_candidates WHERE run_id=$1) candidates,
         (SELECT count(*)::int FROM manifests WHERE run_id=$1) manifests`,
      [context.runId],
    )).rows[0]).toEqual({ candidates: 0, manifests: 0 });
  }, 30_000);

  test("publication guard rejects a V3 manifest whose persisted attestation is missing", async () => {
    const context = await createLeasedRun(1, "publication-attestation");
    const persisted = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result: retrievalResult({
        runId: context.runId,
        target: 1,
        selectedCount: 1,
        status: "exact_ready",
        prefix: "publication-attestation",
      }),
      fence: context.fence,
    });
    await pool.query(
      "UPDATE track_scope_bindings SET provenance_path_json='[]'::jsonb WHERE run_id=$1",
      [context.runId],
    );
    await expect(repository.getPublicationGuard({
      runId: context.runId,
      manifestId: persisted.manifestId!,
      manifestRevisionId: persisted.manifestRevisionId!,
      manifestRevisionHash: persisted.manifestHash!,
      selectedCount: 1,
    })).rejects.toMatchObject({ code: "pipeline_v3_evidence_attestation_missing" });
  }, 30_000);

  test("rejects a stale lease before it can persist candidates, manifests, or Apple work", async () => {
    const context = await createLeasedRun(25, "stale-lease");
    const staleFence = { ...context.fence, leaseEpoch: context.fence.leaseEpoch - 1 };
    await expect(repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result: retrievalResult({
        runId: context.runId,
        target: 25,
        selectedCount: 25,
        reserveCount: 10,
        status: "exact_ready",
        prefix: "stale",
      }),
      fence: staleFence,
    })).rejects.toMatchObject({ code: "job_lease_lost" });
    expect((await pool.query<{ candidates: number; manifests: number; publication_jobs: number }>(
      `SELECT
         (SELECT count(*)::int FROM track_candidates WHERE run_id=$1) candidates,
         (SELECT count(*)::int FROM manifests WHERE run_id=$1) manifests,
         (SELECT count(*)::int FROM job_queue WHERE run_id=$1 AND kind='publication') publication_jobs`,
      [context.runId],
    )).rows[0]).toEqual({ candidates: 0, manifests: 0, publication_jobs: 0 });
  }, 30_000);
});
