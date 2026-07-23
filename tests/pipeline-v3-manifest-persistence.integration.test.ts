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
import {
  publicTrackScopeAttestationV3,
  retrievalStrategiesForEnginesV3,
} from "../server/pipeline-v3-retrieval.ts";
import {
  selectionPlanFromQueryPlanV3,
  type PipelineV3WriteFence,
} from "../server/pipeline-v3-worker-execution.ts";
import { ResearchOrchestrator } from "../server/research.ts";
import { createPublicationRepositoryFacade } from "../server/worker-facades.ts";
import {
  manifestContentHash as publisherManifestContentHash,
  publishManifest,
} from "../server/publisher.ts";
import { orderedAppleStableIdsHash } from "../server/publication-reconciliation-persistence.ts";
import {
  CANONICAL_PUBLICATION_REVALIDATION_ERROR,
} from "../server/canonical-publication-revalidation-v1.ts";
import {
  createQueryPlanV3,
  queryPlanV3Hash,
} from "../server/query-plan-v3.ts";
import { canonicalContractExecutionPolicyV1 } from "../server/canonical-contract-runtime-v1.ts";
import { compilePlaylistContractRevisionV1 } from "../server/playlist-contract-v1.ts";
import { sha256Hex, stableStringify } from "../server/security.ts";
import {
  evidenceMembershipPredicateIdsV3,
  selectionPlanV3Hash,
  type MembershipPredicateV3,
  type SelectionPlanV3,
} from "../server/selection-plan-v3.ts";
import {
  buildSemanticEquivalentRecoveryPlanV3,
  type SemanticPlanRevisionArtifactV3,
} from "../server/pipeline-v3-semantic-recovery.ts";
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

function positivePredicateIds(plan: SelectionPlanV3): string[] {
  return evidenceMembershipPredicateIdsV3(plan);
}

function qualifiedTrack(
  prefix: string,
  index: number,
  predicateIds?: readonly string[],
): QualifiedTrackV3 {
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
      predicateIds,
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
  predicateIds?: readonly string[];
}): RetrievalResultV3 {
  const reserveCount = input.reserveCount ?? 0;
  const selected = Array.from({ length: input.selectedCount }, (_, index) => (
    qualifiedTrack(input.prefix, index, input.predicateIds)
  ));
  const reserve = Array.from({ length: reserveCount }, (_, index) => (
    qualifiedTrack(`${input.prefix}-reserve`, index, input.predicateIds)
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
      discoveryDependencyIds: ["apple_catalog"],
      qualificationDependencyIds: ["apple_catalog"],
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
    vi.stubEnv("PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED", "true");
    vi.stubEnv("PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED", "true");
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

  async function createLeasedRun(
    target: number,
    label: string,
    transformSelectionPlan?: (plan: SelectionPlanV3) => SelectionPlanV3,
    rawPrompt = `Create ${target} released recordings in the ${label} music genre`,
    canonicalRecovery: false | "empty" | "or_membership" = false,
  ): Promise<{
    runId: string;
    accessId: string;
    selectionPlan: SelectionPlanV3;
    queryPlan: QueryPlanV3;
    fence: PipelineV3WriteFence;
  }> {
    const clientBucket = `v3-manifest-${label}-${randomUUID()}`;
    const created = await repository.createRunIdempotent({
      prompt: rawPrompt,
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
    if (transformSelectionPlan) {
      const current = (await pool.query<{ plan_json: SelectionPlanV3 }>(
        `SELECT selection.plan_json
         FROM run_active_query_plans active
         JOIN query_plan_revisions query ON query.id=active.query_plan_revision_id
         JOIN selection_plans selection ON selection.id=query.selection_plan_id
         WHERE active.run_id=$1`,
        [created.runId],
      )).rows[0];
      expect(current?.plan_json).toBeTruthy();
      await repository.activatePipelineV3Run({
        runId: created.runId,
        selectionPlan: transformSelectionPlan(current!.plan_json),
        graphSnapshotId,
      });
    }
    if (canonicalRecovery) {
      const active = (await pool.query<{
        selection_plan: SelectionPlanV3;
        selection_plan_id: string;
        selection_revision: number;
        query_plan_id: string;
        query_revision: number;
        graph_snapshot_id: string;
        raw_prompt: string;
      }>(
        `SELECT selection.plan_json selection_plan,
                selection.id selection_plan_id,
                selection.revision selection_revision,
                query.id query_plan_id,query.revision query_revision,
                query.graph_snapshot_id,
                spec.raw_prompt
         FROM research_runs run
         JOIN run_specs spec ON spec.run_id=run.id
         JOIN run_active_query_plans active ON active.run_id=run.id
         JOIN query_plan_revisions query
           ON query.id=active.query_plan_revision_id
         JOIN selection_plans selection
           ON selection.id=query.selection_plan_id
         WHERE run.id=$1`,
        [created.runId],
      )).rows[0]!;
      expect(active?.selection_plan).toBeTruthy();
      const canonicalClauses = canonicalRecovery === "or_membership"
        ? [{
            id: "genre:reggaeton",
            kind: "membership" as const,
            scope: "track" as const,
            hardness: "hard" as const,
            axis: "genre",
            operator: "require" as const,
            values: ["reggaeton"],
            source: {
              provenance: "prompt" as const,
              text: "reggaeton",
            },
          }, {
            id: "genre:dembow",
            kind: "membership" as const,
            scope: "track" as const,
            hardness: "hard" as const,
            axis: "genre",
            operator: "require" as const,
            values: ["dembow"],
            source: {
              provenance: "prompt" as const,
              text: "dembow",
            },
          }]
        : [{
            id: "catalog:storefront-playable",
            kind: "catalog_version" as const,
            scope: "track" as const,
            hardness: "hard" as const,
            axis: "catalog",
            operator: "require" as const,
            values: ["storefront playable"],
            source: {
              provenance: "system_default" as const,
              text: "storefront playable",
            },
            evidence: {
              required: true,
              claim: "The recording is playable in the requested storefront",
              minimumGrade: "authoritative_structured_metadata" as const,
              permittedGrades: [
                "authoritative_structured_metadata" as const,
              ],
            },
            // This fixture isolates publication reconciliation. Production
            // adapters supply the structured assessment; allowing a missing
            // fixture assessment avoids manufacturing editorial evidence.
            unknownPolicy: "allow" as const,
          }];
      const contract = compilePlaylistContractRevisionV1({
        contractId: `run:${created.runId}`,
        rawPrompt: active.raw_prompt,
        requestedTrackCount: target,
        locale: "en-US",
        storefront: active.selection_plan.storefront,
        clauses: canonicalClauses,
        trackPredicate: canonicalRecovery === "or_membership"
          ? {
              op: "any",
              children: canonicalClauses.map(({ id }) => ({
                op: "clause" as const,
                clauseId: id,
              })),
            }
          : {
              op: "clause",
              clauseId: "catalog:storefront-playable",
            },
      });
      const contractRevision = await repository.savePlaylistContractRevision({
        runId: created.runId,
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
        answerLineageHash: sha256Hex(
          stableStringify(contract.answerLineage),
        ),
      });
      const canonicalSelectionPlan: SelectionPlanV3 = {
        ...active.selection_plan,
        canonicalContractPolicy:
          canonicalContractExecutionPolicyV1(contract),
      };
      const canonicalQueryPlan = createQueryPlanV3(
        canonicalSelectionPlan,
        active.graph_snapshot_id,
        {
          schemaVersion: 4,
          briefContractVersion: 3,
          playlistContractRevisionId: contract.revisionId,
          playlistContractSemanticHash: contract.semanticHash,
          playlistContractCompilerVersion: contract.versions.compiler,
        },
      );
      const canonicalSelectionHash =
        selectionPlanV3Hash(canonicalSelectionPlan);
      const canonicalQueryHash = queryPlanV3Hash(canonicalQueryPlan);
      const canonicalSelectionPlanId = randomUUID();
      const canonicalQueryPlanId = randomUUID();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE selection_plans SET status='superseded'
           WHERE run_id=$1 AND status='active'`,
          [created.runId],
        );
        await client.query(
          `INSERT INTO selection_plans(
             id,run_id,revision,status,plan_hash,plan_json,
             pipeline_version,policy_version,confirmed_at)
           VALUES($1,$2,$3,'active',$4,$5::jsonb,
             'corpus_first_v3','corpus_first_v3_policy_v1',now())`,
          [
            canonicalSelectionPlanId,
            created.runId,
            active.selection_revision + 1,
            canonicalSelectionHash,
            JSON.stringify(canonicalSelectionPlan),
          ],
        );
        await client.query(
          `INSERT INTO query_plan_revisions(
             id,run_id,selection_plan_id,revision,parent_revision_id,
             graph_snapshot_id,engine,status,plan_hash,plan_json,
             pipeline_version,policy_version,activated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$9::jsonb,
             'corpus_first_v3','corpus_first_v3_policy_v1',now())`,
          [
            canonicalQueryPlanId,
            created.runId,
            canonicalSelectionPlanId,
            active.query_revision + 1,
            active.query_plan_id,
            active.graph_snapshot_id,
            canonicalQueryPlan.engine,
            canonicalQueryHash,
            JSON.stringify(canonicalQueryPlan),
          ],
        );
        await client.query(
          `UPDATE run_active_query_plans
           SET query_plan_revision_id=$2,activated_at=now()
           WHERE run_id=$1`,
          [created.runId, canonicalQueryPlanId],
        );
        await client.query(
          `UPDATE query_plan_revisions SET status='superseded'
           WHERE run_id=$1 AND id<>$2 AND status='active'`,
          [created.runId, canonicalQueryPlanId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      expect(contractRevision.contractHash).toBe(canonicalQueryPlan
        .playlistContractSemanticHash);
    }
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
    const contractRevision = canonicalRecovery
      ? await repository.getActivePlaylistContractRevision({
          runId: created.runId,
        })
      : null;
    const immutableContract = contractRevision?.contract as {
      revisionId: string;
      semanticHash: string;
    } | undefined;
    const executionAttempt = contractRevision
      ? await repository.beginPlaylistExecutionAttempt({
          runId: created.runId,
          contractRevisionId: contractRevision.id,
          stage: active.stage_key,
          dependencyKey: "research",
          attemptNumber: 1,
          leaseGeneration: leaseEpoch,
          executorRevision: "integration-v3-recovery",
          executorIdentityHash: "e".repeat(64),
          configurationHash: "d".repeat(64),
          idempotencyKey:
            `${active.job_id}:${leaseEpoch}:${contractRevision.id}`,
        })
      : null;
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
        ...(contractRevision && immutableContract && executionAttempt ? {
          contractAttemptId: executionAttempt.id,
          contractRevisionDatabaseId: contractRevision.id,
          contractRevisionId: immutableContract.revisionId,
          contractSemanticHash: immutableContract.semanticHash,
        } : {}),
      },
    };
  }

  test("separates untrusted leads from contract-fenced qualification records", async () => {
    const context = await createLeasedRun(
      1,
      "schema-18-separated-recovery",
      undefined,
      undefined,
      "or_membership",
    );
    expect(context.queryPlan.schemaVersion).toBe(4);
    const strategy = retrievalStrategiesForEnginesV3(
      context.queryPlan.engines,
    )[0]!;
    const source = qualifiedTrack(
      "schema-18-separated-recovery",
      0,
      positivePredicateIds(context.selectionPlan),
    );
    const candidate = {
      id: source.candidateId,
      artist: source.artist,
      title: source.title,
      album: source.album,
      sourceObservationIds: [...source.sourceObservationIds],
    };
    const discoveryRequest = {
      runId: context.runId,
      executionMode: "active" as const,
      appleWriteAccess: "forbidden" as const,
      plan: context.selectionPlan,
      engine: strategy.engine,
      strategy,
      strategyRound: 1,
      cursor: null,
      requestedRawCandidateCount: 1,
      alreadyDiscoveredCandidateIds: [],
      alreadyDiscoveredTracks: [],
      qualifiedRecordingFamilyKeys: [],
      qualifiedTrackSeeds: [],
    };
    await repository.persistPipelineV3DiscoveryBatch({
      runId: context.runId,
      queryPlan: context.queryPlan,
      request: discoveryRequest,
      batch: {
        candidates: [candidate],
        nextCursor: null,
        exhausted: true,
        costUnits: 1,
      },
      fence: context.fence,
    });

    const discovered = (await pool.query<{
      id: string;
      contract_revision_id: string;
      execution_attempt_id: string;
      status: string;
      evidence_eligible: boolean;
      lead_json: Record<string, unknown>;
    }>(
      `SELECT id,contract_revision_id,execution_attempt_id,status,
              evidence_eligible,lead_json
       FROM playlist_discovery_leads WHERE run_id=$1`,
      [context.runId],
    )).rows[0]!;
    expect(discovered).toMatchObject({
      contract_revision_id: context.fence.contractRevisionDatabaseId,
      execution_attempt_id: context.fence.contractAttemptId,
      status: "discovered",
      evidence_eligible: false,
      lead_json: {
        schemaVersion: "genio-playlist-discovery-lead/v1",
        untrusted: true,
      },
    });
    await expect(pool.query(
      "UPDATE playlist_discovery_leads SET evidence_eligible=true WHERE id=$1",
      [discovered.id],
    )).rejects.toThrow();

    await repository.persistPipelineV3QualificationBatch({
      runId: context.runId,
      queryPlan: context.queryPlan,
      request: {
        runId: context.runId,
        executionMode: "active",
        appleWriteAccess: "forbidden",
        plan: context.selectionPlan,
        engine: strategy.engine,
        strategy,
        candidates: [candidate],
      },
      qualifications: [{
        candidateId: candidate.id,
        scope: {
          // Schema 4 must execute the canonical OR tree below. This
          // deliberately contradictory flattened legacy result is retained
          // only as an audit observation.
          passed: false,
          failedMembershipPredicateIds: ["legacy:flattened"],
          fit: 0,
        },
        hardConstraints: {
          passed: true,
          failedConstraintIds: [],
        },
        evidence: {
          passed: true,
          bindingIds: source.evidenceBindingIds,
          bindings: source.evidenceBindings,
          strength: source.evidenceStrength,
          independentProvenanceRoots: source.independentProvenanceRoots,
        },
        version: {
          compatible: true,
          confidence: source.versionConfidence,
        },
        catalog: {
          lookupAttempted: true,
          storefrontPlayable: true,
          appleSongId: source.appleSongId,
          recordingFamilyKey: source.recordingFamilyKey,
          confidence: source.catalogConfidence,
        },
        canonicalClauseAssessments: {
          "genre:reggaeton": {
            status: "pass",
            evidenceGrade: "track_specific_editorial_assertion",
            evidenceIds: [...source.evidenceBindingIds],
          },
          "genre:dembow": { status: "unknown" },
        },
        rankingSignals: source.rankingSignals,
        sourceRank: source.sourceRank,
      }],
      fence: context.fence,
    });

    const qualification = (await pool.query<{
      decision: string;
      predicate_results_json: Record<string, unknown>;
      evidence_record_ids_json: string[];
      quality_result_json: Record<string, unknown>;
      catalog_result_json: Record<string, unknown>;
      lead_status: string;
      evidence_eligible: boolean;
    }>(
      `SELECT qualification.decision,qualification.predicate_results_json,
              qualification.evidence_record_ids_json,
              qualification.quality_result_json,
              qualification.catalog_result_json,
              lead.status lead_status,lead.evidence_eligible
       FROM playlist_qualification_records qualification
       JOIN playlist_discovery_leads lead
         ON lead.id=qualification.discovery_lead_id
       WHERE qualification.run_id=$1`,
      [context.runId],
    )).rows[0]!;
    expect(qualification).toMatchObject({
      decision: "qualified",
      lead_status: "qualified",
      evidence_eligible: false,
      predicate_results_json: {
        scope: { passed: false },
        hardConstraints: { passed: true },
        legacyFlattenedAuthoritative: false,
        canonicalContract: {
          evaluation: { status: "pass", eligible: true },
          evidenceIntegrity: { passed: true },
          assessments: {
            "genre:reggaeton": { status: "pass" },
            "genre:dembow": { status: "unknown" },
          },
        },
      },
      quality_result_json: {
        evidence: { passed: true },
      },
      catalog_result_json: {
        version: { compatible: true },
        catalog: {
          storefrontPlayable: true,
          appleSongId: source.appleSongId,
        },
      },
    });
    expect(qualification.evidence_record_ids_json)
      .toEqual(source.evidenceBindingIds);

    await expect(repository.persistPipelineV3DiscoveryBatch({
      runId: context.runId,
      queryPlan: context.queryPlan,
      request: discoveryRequest,
      batch: {
        candidates: [candidate],
        nextCursor: null,
        exhausted: true,
      },
      fence: {
        ...context.fence,
        contractSemanticHash: "0".repeat(64),
      },
    })).rejects.toMatchObject({
      code: "pipeline_v3_recovery_fence_stale",
    });

    await repository.setPipelineCohortKillSwitch({
      cohortKey: `test:${context.runId}`,
      route: "corpus_first_v3",
      intentGroup: "genre_scene",
      disabled: true,
      reasonCode: "integration_test",
      changedBy: "integration",
    });
    await expect(repository.isPipelineCohortDisabled({
      route: "corpus_first_v3",
      intentGroup: "genre_scene",
    })).resolves.toBe(true);
    await repository.setPipelineCohortKillSwitch({
      cohortKey: `test:reenable:${context.runId}`,
      route: "corpus_first_v3",
      intentGroup: "genre_scene",
      disabled: false,
      changedBy: "integration",
    });
    await expect(repository.isPipelineCohortDisabled({
      route: "corpus_first_v3",
      intentGroup: "genre_scene",
    })).resolves.toBe(false);
    await expect(pool.query<{
      cohort_key: string;
      disabled: boolean;
    }>(
      `SELECT cohort_key,disabled
       FROM pipeline_cohort_kill_switches
       WHERE route='corpus_first_v3' AND intent_group='genre_scene'`,
    )).resolves.toMatchObject({
      rows: [{
        cohort_key: `test:reenable:${context.runId}`,
        disabled: false,
      }],
    });
  }, 120_000);

  test("persists the contract-bound publication reconciliation lifecycle", async () => {
    const context = await createLeasedRun(
      1,
      "disco",
      undefined,
      undefined,
      "empty",
    );
    const result = retrievalResult({
      runId: context.runId,
      target: 1,
      selectedCount: 1,
      status: "exact_ready",
      prefix: "schema-18-publication-reconciliation",
      predicateIds: positivePredicateIds(context.selectionPlan),
    });
    const persisted = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result,
      fence: context.fence,
    });
    const locked = await repository.getManifestById(persisted.manifestId!);
    expect(locked).toBeTruthy();
    const expectedOrderedIdsHash = orderedAppleStableIdsHash(
      locked!.tracks.map((track: { catalogId: string }) => track.catalogId),
    );
    const base = {
      runId: context.runId,
      contractRevisionId: locked!.contractRevisionId!,
      contractHash: locked!.contractHash!,
      executionAttemptId: context.fence.contractAttemptId!,
      jobId: context.fence.jobId,
      workerId: context.fence.workerId,
      leaseGeneration: context.fence.leaseEpoch,
      stageKey: context.fence.stageKey,
      manifestId: locked!.id,
      manifestRevisionId: locked!.revisionId!,
      manifestRevisionHash: locked!.contentHash,
      expectedOrderedIdsHash,
      expectedCount: 1,
      idempotencyKey:
        `publish:${locked!.id}:${locked!.revisionId}:${locked!.contentHash}`,
    };
    await expect(repository.beginPublicationReconciliation(base)).resolves
      .toMatchObject({
        state: "preflight",
        appendedCount: 0,
        batchCursor: 0,
      });
    await expect(repository.beginPublicationReconciliation(base)).resolves
      .toMatchObject({ state: "preflight" });
    await repository.advancePublicationReconciliation({
      ...base,
      state: "create_pending",
      appendedCount: 0,
      batchCursor: 0,
      detail: { volumeAttempt: 0 },
    });
    await repository.advancePublicationReconciliation({
      ...base,
      state: "append_pending",
      applePlaylistId: "p.integration",
      appendedCount: 1,
      batchCursor: 1,
      detail: { volumeAttempt: 0 },
    });
    await repository.advancePublicationReconciliation({
      ...base,
      state: "reconciling",
      applePlaylistId: "p.integration",
      observedOrderedIdsHash: expectedOrderedIdsHash,
      appendedCount: 1,
      batchCursor: 1,
      detail: { exactMembershipVerified: true },
    });
    await repository.advancePublicationReconciliation({
      ...base,
      state: "complete",
      applePlaylistId: "p.integration",
      observedOrderedIdsHash: expectedOrderedIdsHash,
      appendedCount: 1,
      batchCursor: 1,
      detail: { terminalFenceCommitted: true },
    });
    const stored = (await pool.query<{
      state: string;
      expected_ordered_ids_hash: string;
      observed_ordered_ids_hash: string;
      appended_count: number;
      batch_cursor: number;
      evidence_eligible_leads: number;
    }>(
      `SELECT reconciliation.state,reconciliation.expected_ordered_ids_hash,
              reconciliation.observed_ordered_ids_hash,
              reconciliation.appended_count,reconciliation.batch_cursor,
              (SELECT count(*)::int FROM playlist_discovery_leads lead
               WHERE lead.run_id=reconciliation.run_id
                 AND lead.evidence_eligible) evidence_eligible_leads
       FROM playlist_publication_reconciliations reconciliation
       WHERE reconciliation.run_id=$1`,
      [context.runId],
    )).rows[0]!;
    expect(stored).toEqual({
      state: "complete",
      expected_ordered_ids_hash: expectedOrderedIdsHash,
      observed_ordered_ids_hash: expectedOrderedIdsHash,
      appended_count: 1,
      batch_cursor: 1,
      evidence_eligible_leads: 0,
    });
    await expect(repository.advancePublicationReconciliation({
      ...base,
      state: "append_pending",
      applePlaylistId: "p.integration",
      appendedCount: 1,
      batchCursor: 1,
    })).rejects.toMatchObject({
      code: "publication_reconciliation_conflict",
    });
    await expect(repository.beginPublicationReconciliation({
      ...base,
      manifestRevisionHash: "0".repeat(64),
      idempotencyKey: `${base.idempotencyKey.slice(0, -1)}0`,
    })).rejects.toMatchObject({
      code: "publication_reconciliation_stale",
    });
  }, 120_000);

  test("revalidates an unchanged locked canonical manifest from current qualifications immediately before publication", async () => {
    const context = await createLeasedRun(
      1,
      "disco",
      undefined,
      undefined,
      "empty",
    );
    const result = retrievalResult({
      runId: context.runId,
      target: 1,
      selectedCount: 1,
      status: "exact_ready",
      prefix: "schema-18-prepublication-revalidation",
      predicateIds: positivePredicateIds(context.selectionPlan),
    });
    const persisted = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result,
      fence: context.fence,
    });
    const locked = await repository.getManifestById(persisted.manifestId!);
    expect(locked).toMatchObject({
      revisionId: persisted.manifestRevisionId,
      contentHash: persisted.manifestHash,
      contractRevisionId: context.fence.contractRevisionDatabaseId,
    });
    const publicationRepository =
      createPublicationRepositoryFacade(repository);
    const prepublicationFence = {
      runId: context.runId,
      manifestId: persisted.manifestId!,
      manifestRevisionId: persisted.manifestRevisionId!,
      manifestRevisionHash: persisted.manifestHash!,
      partialPublicationAuthorized: false,
    };
    await expect(
      publicationRepository.revalidateCanonicalPublicationManifest!(
        prepublicationFence,
      ),
    ).resolves.toBeUndefined();

    const revoked = await pool.query(
      `UPDATE playlist_qualification_records
       SET decision='revoked',revoked_at=now()
       WHERE run_id=$1 AND candidate_id=$2
       RETURNING id`,
      [context.runId, locked!.tracks[0]!.candidateId],
    );
    expect(revoked.rowCount).toBe(1);
    await expect(
      publicationRepository.revalidateCanonicalPublicationManifest!(
        prepublicationFence,
      ),
    ).rejects.toMatchObject({
      code: CANONICAL_PUBLICATION_REVALIDATION_ERROR,
      reasonCodes: expect.arrayContaining([
        "canonical_qualification_projection_missing",
      ]),
    });
  }, 120_000);

  test("refuses to lock an exact reserve repair that breaks a canonical playlist quota", async () => {
    const context = await createLeasedRun(
      2,
      "schema-18-publication-quota-repair",
      (plan) => ({
        ...plan,
        playlistQuotaRules: [{
          id: "quota:disco",
          clauseId: "quota:disco",
          axis: "genre",
          values: ["disco"],
          minimumCount: 2,
          maximumCount: null,
          minimumRatio: null,
          maximumRatio: null,
          evidenceGrade: "authoritative_structured_metadata",
        }],
        diversityGoals: {
          minimumDistinctArtists: null,
          minimumDistinctAlbums: null,
          minimumDistinctEras: null,
          minimumDistinctScenes: null,
          minimumDistinctGeographies: null,
          maximumTracksPerArtist: null,
          maximumTracksPerAlbum: null,
        },
        orderingPolicy: {
          mode: "source_order",
          goals: [],
          avoidAdjacentSameArtist: false,
          avoidAdjacentSameAlbum: false,
        },
        softGoalRelaxationOrder: [],
      }),
      "2 disco tracks",
      "empty",
    );
    const base = retrievalResult({
      runId: context.runId,
      target: 2,
      selectedCount: 2,
      reserveCount: 1,
      status: "exact_ready",
      prefix: "schema-18-publication-quota-repair",
      predicateIds: positivePredicateIds(context.selectionPlan),
    });
    const selected = base.selected.map((track) => ({
      ...track,
      catalogGenreNames: ["Disco"],
    }));
    const reserve = base.reserve.map((track) => ({
      ...track,
      catalogGenreNames: ["Latin Pop"],
    }));
    const result: RetrievalResultV3 = {
      ...base,
      selected,
      reserve,
      qualifiedPool: [...selected, ...reserve],
    };
    const persisted = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result,
      fence: context.fence,
    });
    const original = await repository.getManifestRevision(
      context.runId,
      persisted.manifestRevisionId!,
    );
    expect(original).toBeTruthy();
    const reserveTracks = await repository.getManifestPreflightReserveTracks(
      persisted.manifestId!,
      persisted.manifestRevisionId!,
      context.selectionPlan.storefront,
    );
    expect(reserveTracks).toHaveLength(1);
    const replacementTracks = [
      {
        position: 0,
        candidateId: reserveTracks[0]!.candidateId,
        recordingFamilyId: reserveTracks[0]!.recordingFamilyId,
        catalogIdentityId: reserveTracks[0]!.catalogIdentityId,
        catalogId: reserveTracks[0]!.catalogId,
        artist: reserveTracks[0]!.artist,
        title: reserveTracks[0]!.title,
      },
      {
        ...original!.tracks[1]!,
        position: 1,
      },
    ];
    await expect(repository.createManifestRevision(context.runId, {
      ...original!,
      id: "",
      revision: 2,
      parentRevisionId: original!.id,
      status: "locked",
      reason: "publication_preflight_qualified_reserve_substituted",
      contentHash: publisherManifestContentHash(replacementTracks),
      createdAt: new Date().toISOString(),
      lockedAt: new Date().toISOString(),
      tracks: replacementTracks,
      reserveTracks: [],
    })).rejects.toMatchObject({
      code: CANONICAL_PUBLICATION_REVALIDATION_ERROR,
      reasonCodes: expect.arrayContaining([
        "canonical_quota_failed:quota:disco",
      ]),
    });
    await expect(pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM manifest_revisions WHERE manifest_id=$1",
      [persisted.manifestId],
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  }, 120_000);

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
        predicateIds: positivePredicateIds(context.selectionPlan),
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

  test("claims one semantic repair across crash/restart replay and keeps final persistence idempotent", async () => {
    const previousSchemaVersion = process.env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION;
    process.env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION = "2";
    let context: Awaited<ReturnType<typeof createLeasedRun>>;
    try {
      context = await createLeasedRun(25, "baile-funk-recovery", (plan) => {
        const baile: MembershipPredicateV3 = {
          id: "genre:baile",
          axis: "genre",
          operator: "require",
          values: ["baile funk"],
          source: "user",
          reason: "Explicit baile funk genre",
        };
        return {
          ...plan,
          membershipPredicates: [
            ...plan.membershipPredicates,
            baile,
            { ...baile, id: "genre:carioca", values: ["funk carioca"] },
          ],
          semanticClauses: [
            ...plan.semanticClauses,
            {
              id: baile.id,
              role: "membership",
              axis: baile.axis,
              operator: baile.operator,
              values: [...baile.values],
              source: "raw_prompt",
              explicitUserAuthored: true,
              geographyRelationship: null,
              reason: baile.reason,
            },
            {
              id: "genre:carioca",
              role: "membership",
              axis: baile.axis,
              operator: baile.operator,
              values: ["funk carioca"],
              source: "raw_prompt",
              explicitUserAuthored: true,
              geographyRelationship: null,
              reason: baile.reason,
            },
          ],
        };
      });
    } finally {
      if (previousSchemaVersion === undefined) {
        delete process.env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION;
      } else {
        process.env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION = previousSchemaVersion;
      }
    }
    expect(context.queryPlan.schemaVersion).toBe(2);
    // createLeasedRun activates a transformed plan after run creation. Replace
    // the fresh test-only initial semantic snapshot so this fixture models a
    // run whose faulty duplicate projection existed from initial activation.
    await pool.query("DELETE FROM semantic_plan_revisions WHERE run_id=$1", [context.runId]);
    await pool.query(
      `INSERT INTO semantic_plan_revisions(
         id,run_id,revision,parent_revision,equivalence,hard_constraint_hash,plan_json,audit_json)
       VALUES($1,$2,1,NULL,'initial',$3,$4::jsonb,$5::jsonb)`,
      [
        randomUUID(),
        context.runId,
        context.selectionPlan.semanticAudit!.hardConstraintHash,
        JSON.stringify(context.selectionPlan),
        JSON.stringify(context.selectionPlan.semanticAudit),
      ],
    );
    const revision = buildSemanticEquivalentRecoveryPlanV3(context.selectionPlan);
    expect(revision).not.toBeNull();

    await expect(repository.claimPipelineV3SemanticRecovery({
      runId: context.runId,
      queryPlan: context.queryPlan,
      revision: revision!,
      fence: context.fence,
    })).resolves.toEqual({ status: "claimed", revision: 2 });

    // Simulate a crash after the durable claim but before final result
    // persistence. A successor lease must replay the same immutable revision,
    // not create a second repair.
    const successorWorkerId = `v3-restart-${randomUUID()}`;
    const successorLease = (await pool.query<{ lease_epoch: string }>(
      `UPDATE job_queue
       SET lease_owner=$2,lease_epoch=lease_epoch+1,
           lease_expires_at=now()+interval '5 minutes'
       WHERE id=$1
       RETURNING lease_epoch::text`,
      [context.fence.jobId, successorWorkerId],
    )).rows[0]!;
    const successorFence: PipelineV3WriteFence = {
      ...context.fence,
      workerId: successorWorkerId,
      leaseEpoch: Number(successorLease.lease_epoch),
    };
    await expect(repository.claimPipelineV3SemanticRecovery({
      runId: context.runId,
      queryPlan: context.queryPlan,
      revision: revision!,
      fence: successorFence,
    })).resolves.toEqual({ status: "replayed", revision: 2 });

    const storedRevisions = await pool.query<{ revision: number }>(
      "SELECT revision FROM semantic_plan_revisions WHERE run_id=$1 ORDER BY revision",
      [context.runId],
    );
    expect(storedRevisions.rows.map(({ revision: value }) => value)).toEqual([1, 2]);

    const conflictingRevision: SemanticPlanRevisionArtifactV3 = {
      ...revision!,
      planHash: "f".repeat(64),
    };
    await expect(repository.claimPipelineV3SemanticRecovery({
      runId: context.runId,
      queryPlan: context.queryPlan,
      revision: conflictingRevision,
      fence: successorFence,
    })).rejects.toMatchObject({ code: "pipeline_v3_semantic_recovery_conflict" });

    const result: RetrievalResultV3 = {
      ...retrievalResult({
        runId: context.runId,
        target: 25,
        selectedCount: 25,
        reserveCount: 10,
        status: "exact_ready",
        prefix: "semantic-recovery-restart",
        predicateIds: positivePredicateIds(revision!.plan),
      }),
      semanticPlanRevisions: [revision!],
    };
    const first = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result,
      fence: successorFence,
    });
    const replayed = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result,
      fence: successorFence,
    });
    expect(replayed).toEqual(first);
    expect((await pool.query<{ count: string }>(
      "SELECT count(*)::text count FROM semantic_plan_revisions WHERE run_id=$1 AND revision=2",
      [context.runId],
    )).rows[0]!.count).toBe("1");
    const recoverySnapshots = (await pool.query<{
      manifest_plan: SelectionPlanV3;
      revision_plan: SelectionPlanV3;
    }>(
      `SELECT manifest.selection_plan_json manifest_plan,
              revision.selection_plan_snapshot_json revision_plan
       FROM manifests manifest
       JOIN manifest_revisions revision ON revision.manifest_id=manifest.id
       WHERE revision.id=$1`,
      [first.manifestRevisionId],
    )).rows[0]!;
    expect(recoverySnapshots.manifest_plan).toEqual(revision!.plan);
    expect(recoverySnapshots.revision_plan).toEqual(revision!.plan);
    expect(recoverySnapshots.manifest_plan).not.toEqual(context.selectionPlan);
  });

  test(
    "queues an exact manifest when catalog-layer version policy has no source binding",
    async () => {
      const previousSchemaVersion = process.env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION;
      process.env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION = "2";
      let context: Awaited<ReturnType<typeof createLeasedRun>>;
      try {
        context = await createLeasedRun(
          25,
          "disco-live-version-policy-boundary",
          undefined,
          "Create 25 disco tracks using only live versions",
        );
      } finally {
        if (previousSchemaVersion === undefined) {
          delete process.env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION;
        } else {
          process.env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION = previousSchemaVersion;
        }
      }
      const sourceBoundPredicateIds = positivePredicateIds(context.selectionPlan);
      expect(context.queryPlan.schemaVersion).toBe(2);
      expect(context.selectionPlan.membershipPredicates).not.toContainEqual(
        expect.objectContaining({ axis: "recording_version" }),
      );
      expect(context.queryPlan.membershipPredicates).not.toContainEqual(
        expect.objectContaining({ kind: "recording_version" }),
      );
      expect(sourceBoundPredicateIds).toEqual([
        expect.stringMatching(/^membership:genre:/u),
      ]);
      expect(context.selectionPlan.catalogPolicies).toContainEqual(expect.objectContaining({
        role: "catalog_policy",
        axis: "recording_version",
        explicitUserAuthored: true,
      }));
      expect(context.queryPlan.catalogPolicies).toContainEqual(expect.objectContaining({
        role: "catalog_policy",
        axis: "recording_version",
        explicitUserAuthored: true,
      }));
      expect(context.selectionPlan.recordingPolicy.allowedVersions).toEqual(["live"]);
      expect(context.queryPlan.recordingPolicy?.allowedVersions).toEqual(["live"]);

      const persisted = await repository.persistPipelineV3RetrievalResult({
        runId: context.runId,
        queryPlan: context.queryPlan,
        plan: context.selectionPlan,
        result: retrievalResult({
          runId: context.runId,
          target: 25,
          selectedCount: 25,
          reserveCount: 10,
          status: "exact_ready",
          prefix: "disco-version-policy-boundary",
          predicateIds: sourceBoundPredicateIds,
        }),
        fence: context.fence,
      });

      expect(persisted).toMatchObject({ publicationState: "queued" });
      const publication = (await pool.query<{
        run_status: string;
        publication_jobs: number;
      }>(
        `SELECT r.status run_status,
                (SELECT count(*)::int FROM job_queue j
                 WHERE j.run_id=r.id AND j.kind='publication') publication_jobs
         FROM research_runs r WHERE r.id=$1`,
        [context.runId],
      )).rows[0]!;
      expect(publication).toEqual({ run_status: "publishing", publication_jobs: 1 });
      const persistedBoundary = (await pool.query<{
        selection_plan: SelectionPlanV3;
        version_scope_bindings: number;
      }>(
        `SELECT revision.selection_plan_snapshot_json selection_plan,
                (SELECT count(*)::int FROM track_scope_bindings binding
                 WHERE binding.run_id=manifest.run_id
                   AND binding.scope_axis='recording_version') version_scope_bindings
         FROM manifest_revisions revision
         JOIN manifests manifest ON manifest.id=revision.manifest_id
         WHERE revision.id=$1`,
        [persisted.manifestRevisionId],
      )).rows[0]!;
      expect(persistedBoundary.selection_plan.recordingPolicy.allowedVersions).toEqual(["live"]);
      expect(persistedBoundary.version_scope_bindings).toBe(0);
    },
    120_000,
  );

  test(
    "persists the publisher's ordered-track hash and crosses the immutable publication gate",
    async () => {
      const context = await createLeasedRun(25, "disco-publisher-hash-boundary");
      const result = retrievalResult({
        runId: context.runId,
        target: 25,
        selectedCount: 25,
        reserveCount: 10,
        status: "exact_ready",
        prefix: "disco-publisher-hash-boundary",
        predicateIds: positivePredicateIds(context.selectionPlan),
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
        publicationState: "queued",
      });

      const lockedManifest = await repository.getManifestById(persisted.manifestId!);
      expect(lockedManifest).toBeTruthy();
      expect(lockedManifest.tracks.map((track: { catalogId: string }) => track.catalogId))
        .toEqual(result.selected.map((track) => track.appleSongId));

      const publisherHash = publisherManifestContentHash(lockedManifest.tracks);
      const storedRevision = (await pool.query<{ content_hash: string }>(
        "SELECT content_hash FROM manifest_revisions WHERE id=$1",
        [persisted.manifestRevisionId],
      )).rows[0]!;
      expect(storedRevision.content_hash).toBe(publisherHash);
      expect(persisted.manifestHash).toBe(publisherHash);
      expect(lockedManifest.contentHash).toBe(publisherHash);

      // Stop at the first post-guard outcome read. Reaching this sentinel
      // proves publishManifest accepted both the immutable ordered-track hash
      // and the real persisted Pipeline V3 evidence/publication guard without
      // requiring Apple network access in this database integration test.
      const crossedImmutableGate = new Error("crossed immutable V3 publication gate");
      const guardSpy = vi.fn(repository.getPublicationGuard.bind(repository));
      const pipelineOutcomeSpy = vi.fn(async () => {
        throw crossedImmutableGate;
      });
      const publicationSource = new Proxy(repository, {
        get(target, property) {
          if (property === "getPublicationGuard") return guardSpy;
          if (property === "getPipelineOutcome") return pipelineOutcomeSpy;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const publicationRepository = createPublicationRepositoryFacade(
        publicationSource as unknown as Parameters<typeof createPublicationRepositoryFacade>[0],
      );

      await expect(publishManifest(
        publicationRepository as unknown as Parameters<typeof publishManifest>[0],
        persisted.manifestId!,
      )).rejects.toBe(crossedImmutableGate);
      expect(guardSpy).toHaveBeenCalledOnce();
      expect(guardSpy).toHaveBeenCalledWith(expect.objectContaining({
        runId: context.runId,
        manifestId: persisted.manifestId,
        manifestRevisionId: persisted.manifestRevisionId,
        manifestRevisionHash: publisherHash,
        selectedCount: 25,
      }));
      expect(pipelineOutcomeSpy).toHaveBeenCalledOnce();
      expect(pipelineOutcomeSpy).toHaveBeenCalledWith(context.runId);
    },
    120_000,
  );

  test("persists a query-plan execution projection against the original immutable selection plan", async () => {
    const context = await createLeasedRun(1, "disco-execution-projection");
    const executionPlan = selectionPlanFromQueryPlanV3(context.queryPlan, {
      prompt: "A deliberately opaque audit prompt that is not reparsed by the worker.",
    });

    // QueryPlanV3 deliberately omits authoring-only SelectionPlanV3 fields.
    // Its execution projection therefore cannot reproduce the original plan
    // hash; persistence must bind to the stored immutable plan instead.
    expect(selectionPlanV3Hash(executionPlan)).not.toBe(context.queryPlan.selectionPlanHash);

    const persisted = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: executionPlan,
      result: retrievalResult({
        runId: context.runId,
        target: 1,
        selectedCount: 1,
        status: "exact_ready",
        prefix: "execution-projection",
        // The execution projection deliberately omits authoring-only fields;
        // evidence still binds to the immutable plan carried by QueryPlanV3.
        predicateIds: positivePredicateIds(context.selectionPlan),
      }),
      fence: context.fence,
    });
    expect(persisted).toMatchObject({
      manifestId: expect.any(String),
      manifestRevisionId: expect.any(String),
      publicationState: "queued",
    });

    const snapshots = (await pool.query<{
      manifest_plan: SelectionPlanV3;
      revision_plan: SelectionPlanV3;
    }>(
      `SELECT manifest.selection_plan_json manifest_plan,
              revision.selection_plan_snapshot_json revision_plan
       FROM manifests manifest
       JOIN manifest_revisions revision ON revision.manifest_id=manifest.id
       WHERE revision.id=$1`,
      [persisted.manifestRevisionId],
    )).rows[0]!;
    expect(snapshots.manifest_plan).toEqual(context.selectionPlan);
    expect(snapshots.revision_plan).toEqual(context.selectionPlan);
    expect(snapshots.revision_plan).not.toEqual(executionPlan);
  }, 30_000);

  test("drains a pre-hotfix schema-1 contract without semantic recompilation or reinterpretation", async () => {
    const previousSchemaVersion = process.env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION;
    process.env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION = "1";
    let context: Awaited<ReturnType<typeof createLeasedRun>>;
    try {
      context = await createLeasedRun(1, "disco-schema-one-immutable-drain");
    } finally {
      if (previousSchemaVersion === undefined) {
        delete process.env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION;
      } else {
        process.env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION = previousSchemaVersion;
      }
    }

    expect(context.queryPlan.schemaVersion).toBe(1);
    expect(context.queryPlan).not.toHaveProperty("semanticPolicyVersion");
    expect(context.queryPlan).not.toHaveProperty("semanticClauses");
    expect(context.queryPlan).not.toHaveProperty("contextSignals");
    expect(context.queryPlan).not.toHaveProperty("catalogPolicies");
    expect(context.queryPlan).not.toHaveProperty("recordingPolicy");
    expect(context.queryPlan).not.toHaveProperty("explicitUserConstraintHash");
    expect(context.queryPlan).not.toHaveProperty("semanticAuditMetadata");

    const storedSelectionPlan = structuredClone(context.selectionPlan);
    const storedQueryPlan = structuredClone(context.queryPlan);
    const executionPlan = selectionPlanFromQueryPlanV3(context.queryPlan, {
      prompt: "Opaque legacy audit prose must not change the persisted contract.",
    });
    expect(selectionPlanV3Hash(executionPlan)).not.toBe(context.queryPlan.selectionPlanHash);

    const persisted = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: executionPlan,
      result: retrievalResult({
        runId: context.runId,
        target: 1,
        selectedCount: 1,
        status: "exact_ready",
        prefix: "schema-one-immutable-drain",
        predicateIds: positivePredicateIds(executionPlan),
      }),
      fence: context.fence,
    });
    expect(persisted).toMatchObject({
      manifestId: expect.any(String),
      manifestRevisionId: expect.any(String),
      publicationState: "queued",
    });

    const immutable = (await pool.query<{
      active_selection_plan: SelectionPlanV3;
      active_query_plan: QueryPlanV3;
      manifest_selection_plan: SelectionPlanV3;
      revision_selection_plan: SelectionPlanV3;
    }>(
      `SELECT selection.plan_json active_selection_plan,
              query.plan_json active_query_plan,
              manifest.selection_plan_json manifest_selection_plan,
              revision.selection_plan_snapshot_json revision_selection_plan
       FROM manifest_revisions revision
       JOIN manifests manifest ON manifest.id=revision.manifest_id
       JOIN run_active_query_plans active ON active.run_id=manifest.run_id
       JOIN query_plan_revisions query ON query.id=active.query_plan_revision_id
       JOIN selection_plans selection ON selection.id=query.selection_plan_id
       WHERE revision.id=$1`,
      [persisted.manifestRevisionId],
    )).rows[0]!;

    expect(immutable.active_query_plan).toEqual(storedQueryPlan);
    expect(immutable.active_query_plan.schemaVersion).toBe(1);
    expect(immutable.active_query_plan).not.toHaveProperty("semanticClauses");
    expect(immutable.active_selection_plan).toEqual(storedSelectionPlan);
    expect(immutable.manifest_selection_plan).toEqual(storedSelectionPlan);
    expect(immutable.revision_selection_plan).toEqual(storedSelectionPlan);
    expect(immutable.manifest_selection_plan).not.toEqual(executionPlan);
    expect(immutable.revision_selection_plan).not.toEqual(executionPlan);
  }, 30_000);

  test("rejects a stored immutable selection-plan payload whose hash no longer matches", async () => {
    const context = await createLeasedRun(1, "tampered-selection-plan");
    const executionPlan = selectionPlanFromQueryPlanV3(context.queryPlan, {
      prompt: "Opaque execution context.",
    });
    // Production triggers reject mutation before the repository ever sees
    // it. Disable them only inside this disposable test schema to prove the
    // repository still detects storage corruption at its trust boundary.
    await pool.query("ALTER TABLE selection_plans DISABLE TRIGGER USER");
    try {
      await pool.query(
        `UPDATE selection_plans
         SET plan_json=jsonb_set(plan_json,'{prompt}',to_jsonb('tampered'::text))
         WHERE run_id=$1 AND status='active'`,
        [context.runId],
      );
    } finally {
      await pool.query("ALTER TABLE selection_plans ENABLE TRIGGER USER");
    }

    await expect(repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: executionPlan,
      result: retrievalResult({
        runId: context.runId,
        target: 1,
        selectedCount: 1,
        status: "exact_ready",
        prefix: "tampered-selection-plan",
        predicateIds: positivePredicateIds(executionPlan),
      }),
      fence: context.fence,
    })).rejects.toMatchObject({ code: "pipeline_v3_plan_stale" });
    expect((await pool.query<{ candidates: number; manifests: number }>(
      `SELECT
         (SELECT count(*)::int FROM track_candidates WHERE run_id=$1) candidates,
         (SELECT count(*)::int FROM manifests WHERE run_id=$1) manifests`,
      [context.runId],
    )).rows[0]).toEqual({ candidates: 0, manifests: 0 });
  }, 30_000);

  test.each(["query", "selection", "both"] as const)(
    "rejects persistence when the active pointer references a superseded %s plan",
    async (superseded) => {
      const context = await createLeasedRun(1, `superseded-${superseded}`);
      const executionPlan = selectionPlanFromQueryPlanV3(context.queryPlan, {
        prompt: "Opaque execution context.",
      });
      if (superseded === "query" || superseded === "both") {
        await pool.query(
          "UPDATE query_plan_revisions SET status='superseded' WHERE id=$1",
          [context.fence.queryPlanRevisionId],
        );
      }
      if (superseded === "selection" || superseded === "both") {
        await pool.query(
          `UPDATE selection_plans SET status='superseded'
           WHERE id=(SELECT selection_plan_id FROM query_plan_revisions WHERE id=$1)`,
          [context.fence.queryPlanRevisionId],
        );
      }

      await expect(repository.persistPipelineV3RetrievalResult({
        runId: context.runId,
        queryPlan: context.queryPlan,
        plan: executionPlan,
        result: retrievalResult({
          runId: context.runId,
          target: 1,
          selectedCount: 1,
          status: "exact_ready",
          prefix: `superseded-${superseded}`,
          predicateIds: positivePredicateIds(executionPlan),
        }),
        fence: context.fence,
      })).rejects.toMatchObject({ code: "pipeline_v3_plan_stale" });
      expect((await pool.query<{ candidates: number; manifests: number }>(
        `SELECT
           (SELECT count(*)::int FROM track_candidates WHERE run_id=$1) candidates,
           (SELECT count(*)::int FROM manifests WHERE run_id=$1) manifests`,
        [context.runId],
      )).rows[0]).toEqual({ candidates: 0, manifests: 0 });
    },
    30_000,
  );

  test("rejects a forged stored query contract even when its selection hash and query hash are valid", async () => {
    const context = await createLeasedRun(1, "forged-query-contract");
    const forgedQueryPlan: QueryPlanV3 = {
      ...context.queryPlan,
      membershipPredicates: context.queryPlan.membershipPredicates.map((predicate, index) => (
        index === 0 ? { ...predicate, subject: "forged unrelated genre" } : { ...predicate }
      )),
      rankingObjectives: context.queryPlan.rankingObjectives.map((objective, index) => (
        index === 0 ? { ...objective, description: "Prefer forged unrelated recordings." } : { ...objective }
      )),
      hardConstraints: context.queryPlan.hardConstraints.map((constraint, index) => (
        index === 0 ? { ...constraint, values: ["forged unrelated genre"] } : { ...constraint, values: [...constraint.values] }
      )),
    };
    expect(forgedQueryPlan.selectionPlanHash).toBe(context.queryPlan.selectionPlanHash);
    const forgedHash = queryPlanV3Hash(forgedQueryPlan);
    expect(forgedHash).toMatch(/^[a-f0-9]{64}$/u);

    // Query-plan revisions are immutable in production. Disable the guard only
    // in this disposable schema to model storage corruption with an internally
    // consistent hash, then prove the selection-plan trust anchor still wins.
    await pool.query("ALTER TABLE query_plan_revisions DISABLE TRIGGER USER");
    try {
      await pool.query(
        "UPDATE query_plan_revisions SET plan_json=$2::jsonb,plan_hash=$3 WHERE id=$1",
        [context.fence.queryPlanRevisionId, JSON.stringify(forgedQueryPlan), forgedHash],
      );
    } finally {
      await pool.query("ALTER TABLE query_plan_revisions ENABLE TRIGGER USER");
    }
    const forgedExecutionPlan = selectionPlanFromQueryPlanV3(forgedQueryPlan, {
      prompt: "Opaque execution context.",
    });

    await expect(repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: forgedQueryPlan,
      plan: forgedExecutionPlan,
      result: retrievalResult({
        runId: context.runId,
        target: 1,
        selectedCount: 1,
        status: "exact_ready",
        prefix: "forged-query-contract",
        predicateIds: positivePredicateIds(forgedExecutionPlan),
      }),
      fence: context.fence,
    })).rejects.toMatchObject({ code: "pipeline_v3_plan_stale" });
    expect((await pool.query<{ candidates: number; manifests: number }>(
      `SELECT
         (SELECT count(*)::int FROM track_candidates WHERE run_id=$1) candidates,
         (SELECT count(*)::int FROM manifests WHERE run_id=$1) manifests`,
      [context.runId],
    )).rows[0]).toEqual({ candidates: 0, manifests: 0 });
  }, 30_000);

  test("locks a partial manifest without any Apple write until capability-bound consent", async () => {
    const context = await createLeasedRun(50, "french-jazz-partial");
    const result = retrievalResult({
      runId: context.runId,
      target: 50,
      selectedCount: 23,
      status: "partial_ready",
      prefix: "partial-23",
      predicateIds: positivePredicateIds(context.selectionPlan),
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
      predicateIds: positivePredicateIds(context.selectionPlan),
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
    const context = await createLeasedRun(1, "disco-publication-attestation");
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
        predicateIds: positivePredicateIds(context.selectionPlan),
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

  test("publication guard requires every positive membership predicate for every manifest track", async () => {
    const previousSchemaVersion = process.env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION;
    process.env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION = "2";
    let context: Awaited<ReturnType<typeof createLeasedRun>>;
    try {
      context = await createLeasedRun(
        1,
        "composite-publication-evidence",
        undefined,
        "Create 1 disco track only by artists born in France",
      );
    } finally {
      if (previousSchemaVersion === undefined) {
        delete process.env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION;
      } else {
        process.env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION = previousSchemaVersion;
      }
    }
    const requiredPredicateIds = context.selectionPlan.membershipPredicates
      .filter((predicate) => predicate.operator !== "exclude")
      .map((predicate) => predicate.id);
    expect(context.queryPlan.schemaVersion).toBe(2);
    expect(context.selectionPlan.membershipPredicates).toEqual(expect.arrayContaining([
      expect.objectContaining({ axis: "genre", values: ["disco"] }),
      expect.objectContaining({
        axis: "geography",
        values: ["France"],
        geographyRelationship: "artist_origin",
      }),
    ]));
    expect(requiredPredicateIds).toHaveLength(2);
    const persisted = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result: retrievalResult({
        runId: context.runId,
        target: 1,
        selectedCount: 1,
        status: "exact_ready",
        prefix: "composite-publication-evidence",
        predicateIds: requiredPredicateIds,
      }),
      fence: context.fence,
    });
    await expect(repository.getPublicationGuard({
      runId: context.runId,
      manifestId: persisted.manifestId!,
      manifestRevisionId: persisted.manifestRevisionId!,
      manifestRevisionHash: persisted.manifestHash!,
      selectedCount: 1,
    })).resolves.toMatchObject({ enforcement: "required", decision: null });

    await pool.query(
      "DELETE FROM track_scope_bindings WHERE run_id=$1 AND scope_axis='geography'",
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
        predicateIds: positivePredicateIds(context.selectionPlan),
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
