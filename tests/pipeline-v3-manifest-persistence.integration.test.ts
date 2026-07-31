import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import * as databaseSchema from "../db/schema.ts";
import { Repository } from "../server/repository.ts";
import type {
  QualifiedTrackV3,
  RetrievalOutcomeStatusV3,
  RetrievalResultV3,
} from "../server/pipeline-v3-retrieval.ts";
import {
  createCentralQualityCriterionObservationV3,
  createHostedWebEvidenceSnapshotV3,
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
  isQueryPlanV3,
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
import { assessPlaylistRuntimeFeasibilityV1 } from "../server/playlist-feasibility-v1.ts";
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
  const title = `${prefix} Track ${ordinal}`;
  const artist = `${prefix} Artist ${Math.floor(index / 3) + 1}`;
  const excerpt = `${artist} — ${title} satisfies ${(
    predicateIds ?? []
  ).join(", ")}.`;
  const hostedEvidenceSnapshot = predicateIds?.length
    ? createHostedWebEvidenceSnapshotV3({
        sourceUrl,
        excerpt,
        responseId: `resp_${ordinal}`,
        outputItemId: `msg_${ordinal}`,
        contentIndex: 0,
        citationStartIndex: Math.max(0, excerpt.length - 1),
        citationEndIndex: excerpt.length,
        excerptStartIndex: 0,
        excerptEndIndex: excerpt.length,
        acquiredAt: HOSTED_TEST_ACQUIRED_AT,
        storefront: "us",
        freshnessExpiresAt: HOSTED_TEST_FRESH_UNTIL,
        predicateIds,
      })
    : undefined;
  return {
    candidateId: `${prefix}:candidate:${ordinal}`,
    title,
    artist,
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
      // This fixture models an exact, track-specific editorial assertion
      // returned by hosted research. Keep the binding kind aligned with the
      // server-derived evidence grade instead of relying on the legacy
      // unclassified `track_specific_source` label.
      kind: "hosted_web_track",
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
        ...(hostedEvidenceSnapshot ? {
          freshnessExpiresAt: hostedEvidenceSnapshot.freshnessExpiresAt,
          acquiredAt: hostedEvidenceSnapshot.acquiredAt,
          revokedAt: hostedEvidenceSnapshot.revokedAt,
        } : {}),
        sourceHash: hostedEvidenceSnapshot?.snapshotHash ?? "a".repeat(64),
        sourceRevision: hostedEvidenceSnapshot?.snapshotHash ?? "a".repeat(64),
      },
      ...(hostedEvidenceSnapshot ? { hostedEvidenceSnapshot } : {}),
      eligibilityAttestation: publicTrackScopeAttestationV3(
        sourceUrl,
        hostedEvidenceSnapshot,
      ),
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
  status: Extract<
    RetrievalOutcomeStatusV3,
    "exact_ready" | "partial_ready" | "no_compatible_tracks" | "failed_integrity"
  >;
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
  const integrityFailure = input.status === "failed_integrity";
  const stopReason = exact
    ? "qualified_reserve_satisfied"
    : integrityFailure
      ? "integrity_failure"
      : "frontier_exhausted";
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
      stopReason,
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
      primaryShortfallReason: exact ? null : stopReason,
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
          : integrityFailure
            ? "blocked_operational_failure"
            : "no_manifest",
    },
  };
}

function withCanonicalCatalogProof(
  result: RetrievalResultV3,
): RetrievalResultV3 {
  const prove = (track: QualifiedTrackV3): QualifiedTrackV3 => ({
    ...track,
    evidenceBindingIds: [],
    evidenceBindings: [],
    evidenceStrength: 1,
    independentProvenanceRoots: 1,
    canonicalClauseAssessments: {
      "catalog:storefront-playable": {
        status: "pass",
        evidenceGrade: "authoritative_structured_metadata",
        evidenceIds: [],
      },
    },
  });
  const selected = result.selected.map(prove);
  const reserve = result.reserve.map(prove);
  return {
    ...result,
    selected,
    reserve,
    qualifiedPool: [...selected, ...reserve],
  };
}

function withCanonicalHostedProof(
  result: RetrievalResultV3,
  clauseId: string,
): RetrievalResultV3 {
  const prove = (track: QualifiedTrackV3): QualifiedTrackV3 => ({
    ...track,
    canonicalClauseAssessments: {
      [clauseId]: {
        status: "pass",
        evidenceGrade: "track_specific_editorial_assertion",
        evidenceIds: [...track.evidenceBindingIds],
      },
    },
  });
  const selected = result.selected.map(prove);
  const reserve = result.reserve.map(prove);
  return {
    ...result,
    selected,
    reserve,
    qualifiedPool: [...selected, ...reserve],
  };
}

function withCanonicalCatalogMembershipAndEvidenceMeta(
  result: RetrievalResultV3,
): RetrievalResultV3 {
  const membershipClauseId = "bridge:membership:hip-hop-or-grime";
  const evidenceClauseId = "bridge:evidence:qualification-policy";
  const prove = (track: QualifiedTrackV3): QualifiedTrackV3 => ({
    ...track,
    canonicalClauseAssessments: {
      [membershipClauseId]: {
        status: "pass",
        evidenceGrade: "authoritative_structured_metadata",
        evidenceIds: [],
      },
      [evidenceClauseId]: {
        status: "pass",
        evidenceGrade: "track_specific_editorial_assertion",
        evidenceIds: [...track.evidenceBindingIds],
      },
    },
  });
  const selected = result.selected.map(prove);
  const reserve = result.reserve.map(prove);
  return {
    ...result,
    selected,
    reserve,
    qualifiedPool: [...selected, ...reserve],
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
    repository = new Repository({
      pool,
      db: drizzle(pool, { schema: databaseSchema }),
    });
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
    canonicalRecovery:
      | false
      | "empty"
      | "closed_world_artist_exclusion"
      | "or_membership"
      | "catalog_membership_with_evidence_meta"
      | "not_exclusion" = false,
  ): Promise<{
    runId: string;
    accessId: string;
    selectionPlan: SelectionPlanV3;
    queryPlan: QueryPlanV3;
    executorReleaseIdentity: {
      executorRevision: string;
      semanticExecutionConfigurationHash: string | null;
    };
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
      expect(
        active?.selection_plan,
        `active selection plan missing for ${label} (${created.runId})`,
      ).toBeTruthy();
      const canonicalClauses =
        canonicalRecovery === "closed_world_artist_exclusion"
        ? [{
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
              minimumGrade: "authoritative_structured_metadata" as const,
              permittedGrades: [
                "authoritative_structured_metadata" as const,
              ],
            },
          }, {
            id: "artist:exclude-pop-smoke",
            kind: "exclusion" as const,
            scope: "track" as const,
            hardness: "hard" as const,
            axis: "artist",
            operator: "exclude" as const,
            values: ["Pop Smoke"],
            source: {
              provenance: "prompt" as const,
              text: "without centering Pop Smoke",
            },
            evidence: {
              required: true,
              minimumGrade: "authoritative_structured_metadata" as const,
              permittedGrades: [
                "authoritative_structured_metadata" as const,
              ],
            },
          }, {
            id: "ranking:pop-smoke-similarity",
            kind: "ranking_preference" as const,
            scope: "track" as const,
            hardness: "soft" as const,
            axis: "similarity",
            operator: "prefer" as const,
            values: ["Pop Smoke"],
            source: {
              provenance: "prompt" as const,
              text: "favorite rapper is Pop Smoke",
            },
          }]
        : canonicalRecovery === "catalog_membership_with_evidence_meta"
        ? [{
            id: "bridge:membership:hip-hop-or-grime",
            kind: "membership" as const,
            scope: "track" as const,
            hardness: "hard" as const,
            axis: "genre",
            operator: "require" as const,
            values: ["hip-hop", "grime"],
            source: {
              provenance: "prompt" as const,
              text: "rap music and grime",
            },
            evidence: {
              required: true,
              minimumGrade: null,
              permittedGrades: [
                "authoritative_structured_metadata" as const,
                "trusted_scoped_container" as const,
                "track_specific_editorial_assertion" as const,
              ],
            },
            unknownPolicy: "reject" as const,
          }, {
            id: "bridge:evidence:qualification-policy",
            kind: "factual_relationship" as const,
            scope: "track" as const,
            hardness: "hard" as const,
            axis: "evidence",
            operator: "require" as const,
            values: ["selection-grade evidence"],
            source: {
              provenance: "system_default" as const,
              text: "Require selection-grade evidence.",
            },
            evidence: {
              required: true,
              minimumGrade: null,
              permittedGrades: [
                "trusted_scoped_container" as const,
                "track_specific_editorial_assertion" as const,
              ],
            },
            unknownPolicy: "defer" as const,
          }]
        : canonicalRecovery === "or_membership"
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
        : canonicalRecovery === "not_exclusion"
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
            id: "artist:bad-bunny",
            kind: "membership" as const,
            scope: "track" as const,
            hardness: "hard" as const,
            axis: "artist",
            operator: "require" as const,
            values: ["Bad Bunny"],
            source: {
              provenance: "prompt" as const,
              text: "Bad Bunny",
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
        trackPredicate:
          canonicalRecovery === "closed_world_artist_exclusion"
          ? {
              op: "all",
              children: canonicalClauses
                .filter(({ hardness }) => hardness === "hard")
                .map(({ id }) => ({
                op: "clause" as const,
                clauseId: id,
              })),
            }
          : canonicalRecovery === "catalog_membership_with_evidence_meta"
          ? {
              op: "all",
              children: canonicalClauses.map(({ id }) => ({
                op: "clause" as const,
                clauseId: id,
              })),
            }
          : canonicalRecovery === "or_membership"
          ? {
              op: "any",
              children: canonicalClauses.map(({ id }) => ({
                op: "clause" as const,
                clauseId: id,
              })),
            }
          : canonicalRecovery === "not_exclusion"
          ? {
              op: "all",
              children: [
                {
                  op: "clause" as const,
                  clauseId: "genre:reggaeton",
                },
                {
                  op: "not" as const,
                  child: {
                    op: "clause" as const,
                    clauseId: "artist:bad-bunny",
                  },
                },
              ],
            }
          : {
              op: "clause",
              clauseId: "catalog:storefront-playable",
            },
        ...(canonicalRecovery === "closed_world_artist_exclusion"
          ? {
              executionDirectives: {
                fixedContainer: null,
                fixedTrackList: null,
                similarity: {
                  seedArtists: ["Pop Smoke"],
                  excludedArtists: ["Pop Smoke"],
                  rankingClauseId: "ranking:pop-smoke-similarity",
                  exactArtistExclusionClauseIds: [
                    "artist:exclude-pop-smoke",
                  ],
                },
              },
            }
          : {}),
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
      const canonicalContractPolicy =
        canonicalContractExecutionPolicyV1(contract);
      const canonicalSemanticClauses =
        canonicalRecovery === "closed_world_artist_exclusion"
          ? [
              ...active.selection_plan.semanticClauses.filter(
                ({ id }) => id !== "artist:exclude-pop-smoke",
              ),
              {
                id: "artist:exclude-pop-smoke",
                role: "membership" as const,
                axis: "artist" as const,
                operator: "exclude" as const,
                values: ["Pop Smoke"],
                source: "raw_prompt" as const,
                explicitUserAuthored: true,
                geographyRelationship: null,
                reason: "Exclude Pop Smoke as primary artist.",
              },
            ]
          : active.selection_plan.semanticClauses;
      const canonicalHardConstraintHash = sha256Hex(stableStringify(
        canonicalSemanticClauses
          .filter(({ role }) => role === "membership")
          .map(({ axis, operator, values }) => ({
            axis,
            operator,
            values: values
              .map((value) => value.normalize("NFKC").trim().toLowerCase())
              .sort(),
          })),
      ));
      const canonicalSelectionPlan = JSON.parse(JSON.stringify({
        ...active.selection_plan,
        canonicalContractPolicy,
        ...(canonicalRecovery === "closed_world_artist_exclusion"
          ? {
              semanticClauses: canonicalSemanticClauses,
              membershipPredicates: [
                ...active.selection_plan.membershipPredicates.filter(
                  ({ id }) => id !== "artist:exclude-pop-smoke",
                ),
                {
                  id: "artist:exclude-pop-smoke",
                  axis: "artist" as const,
                  operator: "exclude" as const,
                  values: ["Pop Smoke"],
                  source: "user" as const,
                  reason: "Exclude Pop Smoke as primary artist.",
                },
              ],
              rankingObjectives: [
                ...active.selection_plan.rankingObjectives.filter(
                  ({ id }) => id !== "ranking:pop-smoke-similarity",
                ),
                {
                  id: "ranking:pop-smoke-similarity",
                  dimension: "similarity" as const,
                  direction: "maximize" as const,
                  weight: 1,
                  relaxationRank: null,
                  values: ["Pop Smoke"],
                  reason: "Use Pop Smoke as the exact similarity seed.",
                },
              ],
              semanticAudit: {
                ...(active.selection_plan.semanticAudit ?? {
                  version: "semantic_plan_v3_1" as const,
                  musicConceptPolicyVersion:
                    active.selection_plan.musicConceptPolicyVersion,
                  passed: true,
                  aliasCollapses: [],
                  contradictions: [],
                }),
                hardConstraintHash: canonicalHardConstraintHash,
              },
            }
          : {}),
        ...(canonicalContractPolicy.executionDirectives
          ? {
              executionDirectives:
                canonicalContractPolicy.executionDirectives,
              engines: canonicalContractPolicy.executionDirectives.similarity
                ? [
                    ...new Set([
                      ...active.selection_plan.engines,
                      "similarity" as const,
                    ]),
                  ]
                : active.selection_plan.engines,
            }
          : {}),
      })) as SelectionPlanV3;
      const canonicalQueryPlan = JSON.parse(JSON.stringify(
        createQueryPlanV3(
          canonicalSelectionPlan,
          active.graph_snapshot_id,
          {
            schemaVersion: 5,
            briefContractVersion: 3,
            playlistContractRevisionId: contract.revisionId,
            playlistContractSemanticHash: contract.semanticHash,
            playlistContractCompilerVersion: contract.versions.compiler,
          },
        ),
      )) as QueryPlanV3;
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
      required_executor_revision: string | null;
      required_executor_semantic_configuration_hash: string | null;
    }>(
      `SELECT sp.plan_json selection_plan,qp.plan_json query_plan,qp.id query_plan_id,
              jq.id job_id,jq.stage_key,ra.id access_id,
              jq.required_executor_revision,
              jq.required_executor_semantic_configuration_hash
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
    if (Number(active.query_plan.schemaVersion ?? 1) >= 5) {
      expect(active.required_executor_revision).toMatch(
        /^[0-9A-Za-z][0-9A-Za-z._:+-]{0,159}$/u,
      );
      expect(active.required_executor_semantic_configuration_hash).toMatch(
        /^[0-9a-f]{64}$/u,
      );
    }
    const executorRevision =
      active.required_executor_revision ?? "integration-v3-worker";
    await repository.updateWorkerHeartbeat(workerId, {
      version: executorRevision,
      ...(active.required_executor_semantic_configuration_hash ? {
        semanticExecutionConfigurationHash:
          active.required_executor_semantic_configuration_hash,
      } : {}),
      protocolVersion: "playlist-pipeline-v10",
      capacity: 1,
      activeJobs: 0,
    });
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
          jobId: active.job_id,
          workerId,
          queryPlanRevisionId: active.query_plan_id,
          stage: active.stage_key,
          dependencyKey: "research",
          attemptNumber: 1,
          leaseGeneration: leaseEpoch,
          executorRevision,
          executorIdentityHash: "e".repeat(64),
          executorCapabilityHash:
            active.query_plan.executorCapabilityHash ?? null,
          executorCapabilityVector:
            active.query_plan.executorCapabilityVector
              ? structuredClone(
                  active.query_plan.executorCapabilityVector,
                ) as unknown as Record<string, unknown>
              : null,
          configurationHash: "d".repeat(64),
          semanticExecutionConfigurationHash:
            active.required_executor_semantic_configuration_hash,
          idempotencyKey:
            `${active.job_id}:${leaseEpoch}:${contractRevision.id}`,
        })
      : null;
    return {
      runId: created.runId,
      accessId: active.access_id,
      selectionPlan: active.selection_plan,
      queryPlan: active.query_plan,
      executorReleaseIdentity: {
        executorRevision,
        semanticExecutionConfigurationHash:
          active.required_executor_semantic_configuration_hash,
      },
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

  test("reports LIVE only for a fresh fenced lease and matching heartbeat", async () => {
    const context = await createLeasedRun(
      3,
      "schema-19-work-motion",
      undefined,
      undefined,
      "or_membership",
    );
    await expect(repository.getRun(context.runId)).resolves.toMatchObject({
      resolution: {
        workMotion: "running",
        lastWorkerHeartbeatAt: expect.any(String),
        activeComputeMs: expect.any(Number),
      },
    });
    await pool.query(
      `UPDATE worker_heartbeats
       SET last_seen_at=now()-interval '10 minutes'
       WHERE worker_id=$1`,
      [context.fence.workerId],
    );
    await expect(repository.getRun(context.runId)).resolves.toMatchObject({
      resolution: {
        workMotion: "stalled",
      },
    });
  }, 120_000);

  test("a stale begin cannot discard the successor lease generation's running attempt", async () => {
    const context = await createLeasedRun(
      3,
      "schema-19-stale-begin-fence",
      undefined,
      undefined,
      "or_membership",
    );
    const successorWorkerId = `v3-successor-worker-${randomUUID()}`;
    await repository.updateWorkerHeartbeat(successorWorkerId, {
      version: context.executorReleaseIdentity.executorRevision,
      semanticExecutionConfigurationHash:
        context.executorReleaseIdentity.semanticExecutionConfigurationHash,
      protocolVersion: "playlist-pipeline-v10",
      capacity: 1,
      activeJobs: 0,
    });
    await pool.query(
      `UPDATE job_queue
       SET lease_owner=$2,lease_expires_at=now()+interval '5 minutes'
       WHERE id=$1`,
      [context.fence.jobId, successorWorkerId],
    );
    const successorGeneration = Number((await pool.query<{ lease_epoch: string }>(
      "SELECT lease_epoch::text FROM job_queue WHERE id=$1",
      [context.fence.jobId],
    )).rows[0]!.lease_epoch);
    expect(successorGeneration).toBeGreaterThan(context.fence.leaseEpoch);

    const successor = await repository.beginPlaylistExecutionAttempt({
      runId: context.runId,
      contractRevisionId: context.fence.contractRevisionDatabaseId!,
      jobId: context.fence.jobId,
      workerId: successorWorkerId,
      queryPlanRevisionId: context.fence.queryPlanRevisionId,
      stage: context.fence.stageKey,
      dependencyKey: "research",
      attemptNumber: 2,
      leaseGeneration: successorGeneration,
      executorRevision: context.executorReleaseIdentity.executorRevision,
      executorIdentityHash: "f".repeat(64),
      executorCapabilityHash: context.queryPlan.executorCapabilityHash!,
      executorCapabilityVector: structuredClone(
        context.queryPlan.executorCapabilityVector!,
      ) as unknown as Record<string, unknown>,
      configurationHash: "d".repeat(64),
      semanticExecutionConfigurationHash:
        context.executorReleaseIdentity.semanticExecutionConfigurationHash,
      idempotencyKey:
        `${context.fence.jobId}:${successorGeneration}:${context.fence.contractRevisionDatabaseId}`,
    });

    await expect(repository.beginPlaylistExecutionAttempt({
      runId: context.runId,
      contractRevisionId: context.fence.contractRevisionDatabaseId!,
      jobId: context.fence.jobId,
      workerId: context.fence.workerId,
      queryPlanRevisionId: context.fence.queryPlanRevisionId,
      stage: context.fence.stageKey,
      dependencyKey: "research",
      attemptNumber: 3,
      leaseGeneration: context.fence.leaseEpoch,
      executorRevision: context.executorReleaseIdentity.executorRevision,
      executorIdentityHash: "e".repeat(64),
      executorCapabilityHash: context.queryPlan.executorCapabilityHash!,
      executorCapabilityVector: structuredClone(
        context.queryPlan.executorCapabilityVector!,
      ) as unknown as Record<string, unknown>,
      configurationHash: "d".repeat(64),
      semanticExecutionConfigurationHash:
        context.executorReleaseIdentity.semanticExecutionConfigurationHash,
      idempotencyKey:
        `${context.fence.jobId}:${context.fence.leaseEpoch}:stale-retry`,
    })).rejects.toMatchObject({ code: "job_lease_lost" });

    await expect(pool.query<{ status: string }>(
      "SELECT status FROM playlist_execution_attempts WHERE id=$1",
      [successor.id],
    )).resolves.toMatchObject({ rows: [{ status: "running" }] });
  }, 30_000);

  test("persists a runtime feasibility proof only under the active contract-attempt fence", async () => {
    const context = await createLeasedRun(
      25,
      "schema-18-runtime-feasibility",
      undefined,
      undefined,
      "or_membership",
    );
    const report = assessPlaylistRuntimeFeasibilityV1({
      contractRevisionId: context.queryPlan.playlistContractRevisionId!,
      contractSemanticHash: context.queryPlan.playlistContractSemanticHash!,
      targetTrackCount: context.queryPlan.targetTrackCount!,
      scope: "open_world",
      stopReason: "frontier_exhausted",
      discoveredCount: 19,
      qualifiedCount: 7,
      storefrontSafeCount: 4,
      contradictions: [],
      limitingPredicateIds: ["genre:reggaeton"],
      strategies: [
        {
          id: "curated_genre_scene:trusted_scoped_containers",
          status: "exhausted",
          rounds: 2,
          rawCandidates: 11,
          newQualifiedFamilies: 4,
          discoveryDependencyIds: ["apple_catalog"],
        },
        {
          id: "curated_genre_scene:editorial_tracks",
          status: "exhausted",
          rounds: 3,
          rawCandidates: 8,
          newQualifiedFamilies: 3,
          discoveryDependencyIds: ["hosted_web"],
        },
      ],
      dependencyOutages: [],
      budgets: {
        activeComputeConsumedMs: 12_345,
        activeComputeAllowanceMs: 900_000,
        maximumGlobalRounds: 48,
        maximumRawCandidates: 500,
        maximumCostUnits: 48,
        qualifiedPoolGoal: 55,
      },
      policyVersions: {
        queryPlanPolicy: context.queryPlan.policyVersion,
        semanticPolicy: context.queryPlan.semanticPolicyVersion!,
        evidencePolicy: context.queryPlan.evidencePolicyVersion!,
      },
    });

    await expect(repository.persistPipelineV3RuntimeFeasibilitySnapshot({
      runId: context.runId,
      queryPlan: context.queryPlan,
      phase: "initial",
      report,
      fence: context.fence,
    })).resolves.toMatchObject({
      id: expect.any(String),
      created: true,
    });
    await expect(repository.persistPipelineV3RuntimeFeasibilitySnapshot({
      runId: context.runId,
      queryPlan: context.queryPlan,
      phase: "initial",
      report,
      fence: context.fence,
    })).resolves.toMatchObject({
      id: expect.any(String),
      created: false,
    });
    const persisted = (await pool.query<{
      contract_revision_id: string;
      phase: string;
      assessment: string;
      target_count: number;
      observed_qualified_count: number;
      report_hash: string;
      report_json: Record<string, unknown>;
    }>(
      `SELECT contract_revision_id,phase,assessment,target_count,
              observed_qualified_count,report_hash,report_json
       FROM playlist_feasibility_snapshots
       WHERE contract_revision_id=$1`,
      [context.fence.contractRevisionDatabaseId],
    )).rows;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      contract_revision_id: context.fence.contractRevisionDatabaseId,
      phase: "initial",
      assessment: "frontier_exhausted_under_policy",
      target_count: 25,
      observed_qualified_count: 7,
      report_hash: report.reportHash,
      report_json: {
        frontierProof: {
          completedFrontierIds: [
            "curated_genre_scene:editorial_tracks",
            "curated_genre_scene:trusted_scoped_containers",
          ],
          independentDependencyKeys: ["apple_catalog", "hosted_web"],
        },
        runtimeEvidence: {
          discoveredCount: 19,
          qualifiedCount: 7,
          storefrontSafeCount: 4,
          budgets: {
            activeComputeConsumedMs: 12_345,
            activeComputeAllowanceMs: 900_000,
            observedStrategyRounds: 5,
          },
        },
      },
    });

    const staleSuccessorWorkerId =
      `v3-feasibility-successor-${randomUUID()}`;
    await repository.updateWorkerHeartbeat(staleSuccessorWorkerId, {
      version: context.executorReleaseIdentity.executorRevision,
      semanticExecutionConfigurationHash:
        context.executorReleaseIdentity.semanticExecutionConfigurationHash,
      protocolVersion: "playlist-pipeline-v10",
      capacity: 1,
      activeJobs: 0,
    });
    await pool.query(
      "UPDATE job_queue SET lease_owner=$2 WHERE id=$1",
      [context.fence.jobId, staleSuccessorWorkerId],
    );
    const staleReport = assessPlaylistRuntimeFeasibilityV1({
      contractRevisionId: context.queryPlan.playlistContractRevisionId!,
      contractSemanticHash: context.queryPlan.playlistContractSemanticHash!,
      targetTrackCount: context.queryPlan.targetTrackCount!,
      scope: "open_world",
      stopReason: "frontier_exhausted",
      discoveredCount: 20,
      qualifiedCount: 7,
      storefrontSafeCount: 4,
      contradictions: [],
      limitingPredicateIds: ["genre:dembow"],
      strategies: report.runtimeEvidence!.frontiers.map((frontier) => ({
        id: frontier.id,
        status: "exhausted" as const,
        rounds: 1,
        rawCandidates: frontier.discoveredCount,
        newQualifiedFamilies: frontier.qualifiedCount,
        discoveryDependencyIds: frontier.dependencyKeys ?? [frontier.dependencyKey],
      })),
      dependencyOutages: [],
      budgets: {
        activeComputeConsumedMs: 12_346,
        activeComputeAllowanceMs: 900_000,
        maximumGlobalRounds: 48,
        maximumRawCandidates: 500,
        maximumCostUnits: 48,
        qualifiedPoolGoal: 55,
      },
      policyVersions: {
        queryPlanPolicy: context.queryPlan.policyVersion,
      },
    });
    await expect(repository.persistPipelineV3RuntimeFeasibilitySnapshot({
      runId: context.runId,
      queryPlan: context.queryPlan,
      phase: "recovery",
      report: staleReport,
      fence: context.fence,
    })).rejects.toMatchObject({ code: "job_lease_lost" });
    await expect(pool.query(
      "SELECT count(*)::int count FROM playlist_feasibility_snapshots WHERE contract_revision_id=$1",
      [context.fence.contractRevisionDatabaseId],
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  }, 30_000);

  test("separates untrusted leads from contract-fenced qualification records", async () => {
    const context = await createLeasedRun(
      1,
      "schema-18-separated-recovery",
      undefined,
      undefined,
      "or_membership",
    );
    expect(context.queryPlan.schemaVersion).toBe(5);
    const strategy = retrievalStrategiesForEnginesV3(
      context.queryPlan.engines,
    ).find(({ discoveryDependencyIds }) => (
      discoveryDependencyIds.includes("hosted_web")
    ))!;
    const source = qualifiedTrack(
      "schema-18-separated-recovery",
      0,
      ["genre:reggaeton", "genre:dembow"],
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
        provenance: {
          cacheOrigin: "fresh_cache",
          sourceFreshUntil: "2099-01-01T00:00:00.000Z",
        },
      },
      fence: context.fence,
    });

    const discovered = (await pool.query<{
      id: string;
      contract_revision_id: string;
      execution_attempt_id: string;
      status: string;
      evidence_eligible: boolean;
      dependency_ids: string[];
      provenance_roots: string[];
      cache_origin: string;
      source_fresh_until: Date | null;
      lead_json: Record<string, unknown>;
    }>(
      `SELECT id,contract_revision_id,execution_attempt_id,status,
              evidence_eligible,dependency_ids,provenance_roots,cache_origin,
              source_fresh_until,lead_json
       FROM playlist_discovery_leads WHERE run_id=$1`,
      [context.runId],
    )).rows[0]!;
    expect(discovered).toMatchObject({
      contract_revision_id: context.fence.contractRevisionDatabaseId,
      execution_attempt_id: context.fence.contractAttemptId,
      status: "discovered",
      evidence_eligible: false,
      dependency_ids: [...strategy.discoveryDependencyIds],
      provenance_roots: [],
      cache_origin: "fresh_cache",
      lead_json: {
        schemaVersion: "genio-playlist-discovery-lead/v1",
        untrusted: true,
      },
    });
    expect(discovered.source_fresh_until?.toISOString())
      .toBe("2099-01-01T00:00:00.000Z");
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
          // The canonical schema must execute the exact OR tree below. This
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
        provenance: {
          dependencyIds: [...strategy.discoveryDependencyIds],
          provenanceRoots: source.evidenceBindings
            ?.map(({ provenanceRoot }) => provenanceRoot)
            .sort(),
          cacheOrigin: "fresh_cache",
          sourceFreshUntil: "2099-01-01T00:00:00.000Z",
        },
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

    const finalBase = retrievalResult({
      runId: context.runId,
      target: 1,
      selectedCount: 1,
      status: "exact_ready",
      prefix: "schema-18-separated-recovery",
      predicateIds: ["genre:reggaeton", "genre:dembow"],
    });
    const finalSelected = finalBase.selected.map((track) => ({
      ...track,
      canonicalClauseAssessments: {
        "genre:reggaeton": {
          status: "pass" as const,
          evidenceGrade: "track_specific_editorial_assertion" as const,
          evidenceIds: [...track.evidenceBindingIds],
        },
        "genre:dembow": { status: "unknown" as const },
      },
    }));
    const finalPersisted = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result: {
        ...finalBase,
        selected: finalSelected,
        qualifiedPool: finalSelected,
      },
      fence: context.fence,
    });
    expect((await pool.query<{
      active: number;
      revoked: number;
    }>(
      `SELECT
         count(*) FILTER (
           WHERE decision='qualified' AND revoked_at IS NULL
         )::int active,
         count(*) FILTER (
           WHERE decision='qualified' AND revoked_at IS NOT NULL
         )::int revoked
       FROM playlist_qualification_records
       WHERE run_id=$1`,
      [context.runId],
    )).rows[0]).toEqual({
      active: 1,
      revoked: 1,
    });
    const durableBinding = (await pool.query<{
      provenance_path_json: Array<Record<string, unknown>>;
    }>(
      `SELECT provenance_path_json
       FROM track_scope_bindings
       WHERE run_id=$1
       ORDER BY id
       LIMIT 1`,
      [context.runId],
    )).rows[0]!.provenance_path_json.find(
      ({ kind }) => kind === "pipeline_v3_binding",
    );
    expect(durableBinding).toMatchObject({
      predicateIds: ["genre:reggaeton"],
      sourcePredicateIds: ["genre:dembow", "genre:reggaeton"],
    });
    expect((await pool.query<{ count: number }>(
      `SELECT count(*)::int count
       FROM track_scope_bindings
       WHERE run_id=$1 AND scope_axis='evidence'
         AND pipeline_version='corpus_first_v3'`,
      [context.runId],
    )).rows[0]?.count).toBe(0);
    await expect(repository.validatePipelineV3ContinuationQualifications({
      runId: context.runId,
      queryPlan: context.queryPlan,
      tracks: finalSelected,
    })).resolves.toBeUndefined();
    await expect(repository.getPublicationGuard({
      runId: context.runId,
      manifestId: finalPersisted.manifestId!,
      manifestRevisionId: finalPersisted.manifestRevisionId!,
      manifestRevisionHash: finalPersisted.manifestHash!,
      selectedCount: 1,
    })).resolves.toMatchObject({
      enforcement: "required",
      decision: null,
    });
    await expect(repository.revalidateCanonicalPublicationManifest({
      runId: context.runId,
      manifestId: finalPersisted.manifestId!,
      manifestRevisionId: finalPersisted.manifestRevisionId!,
      manifestRevisionHash: finalPersisted.manifestHash!,
      partialPublicationAuthorized: false,
    })).resolves.toBeUndefined();

    const duplicatedAuthority = await pool.query(
      `UPDATE playlist_qualification_records
       SET revoked_at=NULL
       WHERE run_id=$1 AND decision='qualified' AND revoked_at IS NOT NULL
       RETURNING id`,
      [context.runId],
    );
    expect(duplicatedAuthority.rowCount).toBe(1);
    await expect(repository.validatePipelineV3ContinuationQualifications({
      runId: context.runId,
      queryPlan: context.queryPlan,
      tracks: finalSelected,
    })).rejects.toMatchObject({
      code: "pipeline_v3_continuation_qualification_invalid",
    });
    await expect(repository.getPublicationGuard({
      runId: context.runId,
      manifestId: finalPersisted.manifestId!,
      manifestRevisionId: finalPersisted.manifestRevisionId!,
      manifestRevisionHash: finalPersisted.manifestHash!,
      selectedCount: 1,
    })).rejects.toMatchObject({
      code: "pipeline_v3_evidence_attestation_missing",
    });
    await expect(repository.revalidateCanonicalPublicationManifest({
      runId: context.runId,
      manifestId: finalPersisted.manifestId!,
      manifestRevisionId: finalPersisted.manifestRevisionId!,
      manifestRevisionHash: finalPersisted.manifestHash!,
      partialPublicationAuthorized: false,
    })).rejects.toMatchObject({
      code: CANONICAL_PUBLICATION_REVALIDATION_ERROR,
      reasonCodes: ["canonical_qualification_projection_ambiguous"],
    });

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
    await expect(repository.renewJobLease(
      context.fence.jobId,
      context.fence.workerId,
      60_000,
      context.fence.leaseEpoch,
    )).resolves.toBe(false);
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
    await expect(repository.renewJobLease(
      context.fence.jobId,
      context.fence.workerId,
      60_000,
      context.fence.leaseEpoch,
    )).resolves.toBe(true);
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
    const result = withCanonicalCatalogProof(retrievalResult({
      runId: context.runId,
      target: 1,
      selectedCount: 1,
      status: "exact_ready",
      prefix: "schema-18-publication-reconciliation",
      predicateIds: positivePredicateIds(context.selectionPlan),
    }));
    const persisted = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result,
      fence: context.fence,
    });
    const locked = await repository.getManifestById(persisted.manifestId!);
    expect(locked).toBeTruthy();
    await expect(repository.getRun(context.runId)).resolves.toMatchObject({
      resolution: {
        manifestedTrackCount: 1,
        reconciledPublishedTrackCount: null,
      },
    });
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
    await expect(repository.getRun(context.runId)).resolves.toMatchObject({
      resolution: {
        manifestedTrackCount: 1,
        appendedTrackCount: 1,
        reconciledPublishedTrackCount: 1,
      },
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

  test("atomically adopts authorization-blocked reconciliation only after the former lease is inactive", async () => {
    const context = await createLeasedRun(
      1,
      "disco",
      undefined,
      undefined,
      "empty",
    );
    const result = withCanonicalCatalogProof(retrievalResult({
      runId: context.runId,
      target: 1,
      selectedCount: 1,
      status: "exact_ready",
      prefix: "publication-reauthorization-adoption",
      predicateIds: positivePredicateIds(context.selectionPlan),
    }));
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
    const original = {
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
    const unrelatedJobId = randomUUID();
    await pool.query(
      `INSERT INTO job_queue(
         id,run_id,kind,queue_class,dedupe_key,pipeline_version,
         minimum_worker_protocol,stage_key,status,payload_json,max_attempts,
         lease_owner,lease_expires_at,required_executor_revision,
         required_executor_semantic_configuration_hash)
       VALUES($1,$2,'publication','publication',$3,'corpus_first_v3',
         10,$4,'leased','{}'::jsonb,3,$5,
         now()+interval '5 minutes',$6,$7)`,
      [
        unrelatedJobId,
        context.runId,
        `spliced-reconciliation:${context.runId}`,
        original.stageKey,
        original.workerId,
        context.executorReleaseIdentity.executorRevision,
        context.executorReleaseIdentity.semanticExecutionConfigurationHash,
      ],
    );
    const unrelatedLease = Number((await pool.query<{
      lease_epoch: string;
    }>(
      "SELECT lease_epoch::text FROM job_queue WHERE id=$1",
      [unrelatedJobId],
    )).rows[0]!.lease_epoch);
    expect(unrelatedLease).toBe(original.leaseGeneration);
    await expect(repository.beginPublicationReconciliation({
      ...original,
      jobId: unrelatedJobId,
    })).rejects.toMatchObject({ code: "publication_reconciliation_stale" });
    await repository.beginPublicationReconciliation(original);
    await repository.advancePublicationReconciliation({
      ...original,
      state: "authorization_blocked",
      appendedCount: 0,
      batchCursor: 0,
      detail: { nextAction: "authorize_apple" },
    });
    await repository.updateRun(context.runId, {
      status: "waiting_for_apple_authorization",
      phase: "apple_reauthorization",
      error: null,
    });
    const recoveryDedupeKey =
      `publication:${locked!.id}:reauth:integration`;
    await expect(repository.enqueueWaitingPublicationRecovery({
      manifestId: locked!.id,
      runId: context.runId,
      dedupeKey: recoveryDedupeKey,
    })).resolves.toBe(true);
    await expect(pool.query<{ status: string; phase: string }>(
      "SELECT status,phase FROM research_runs WHERE id=$1",
      [context.runId],
    )).resolves.toMatchObject({
      rows: [{
        status: "waiting_for_apple_authorization",
        phase: "apple_reauthorization",
      }],
    });
    const recoveryJob = (await pool.query<{
      id: string;
      stage_key: string;
      query_plan_revision_id: string | null;
      required_executor_capability_hash: string;
      required_executor_capability_vector: Record<string, unknown>;
      required_executor_revision: string;
      required_executor_semantic_configuration_hash: string;
    }>(
      `SELECT id,stage_key,query_plan_revision_id,
              required_executor_capability_hash,
              required_executor_capability_vector,
              required_executor_revision,
              required_executor_semantic_configuration_hash
       FROM job_queue
       WHERE kind='publication' AND dedupe_key=$1`,
      [recoveryDedupeKey],
    )).rows[0]!;
    const recoveryWorker = `reauth-worker-${randomUUID()}`;
    await repository.updateWorkerHeartbeat(recoveryWorker, {
      version: recoveryJob.required_executor_revision,
      semanticExecutionConfigurationHash:
        recoveryJob.required_executor_semantic_configuration_hash,
      protocolVersion: "playlist-pipeline-v10",
      capacity: 1,
      activeJobs: 0,
    });
    await pool.query(
      `UPDATE job_queue
       SET status='leased',lease_owner=$2,
           lease_expires_at=now()+interval '5 minutes'
       WHERE id=$1`,
      [recoveryJob.id, recoveryWorker],
    );
    const recoveryLeaseGeneration = Number((await pool.query<{
      lease_epoch: string;
    }>(
      "SELECT lease_epoch::text FROM job_queue WHERE id=$1",
      [recoveryJob.id],
    )).rows[0]!.lease_epoch);
    const recoveryAttempt = await repository.beginPlaylistExecutionAttempt({
      runId: context.runId,
      contractRevisionId: locked!.contractRevisionId!,
      jobId: recoveryJob.id,
      workerId: recoveryWorker,
      queryPlanRevisionId: recoveryJob.query_plan_revision_id,
      stage: recoveryJob.stage_key,
      dependencyKey: "publication",
      attemptNumber: 1,
      leaseGeneration: recoveryLeaseGeneration,
      executorRevision: recoveryJob.required_executor_revision,
      executorIdentityHash: "3".repeat(64),
      executorCapabilityHash:
        recoveryJob.required_executor_capability_hash,
      executorCapabilityVector:
        recoveryJob.required_executor_capability_vector,
      configurationHash: "4".repeat(64),
      semanticExecutionConfigurationHash:
        recoveryJob.required_executor_semantic_configuration_hash,
      idempotencyKey:
        `${recoveryJob.id}:${recoveryLeaseGeneration}:${locked!.contractRevisionId}`,
    });
    const recovery = {
      ...original,
      executionAttemptId: recoveryAttempt.id,
      jobId: recoveryJob.id,
      workerId: recoveryWorker,
      leaseGeneration: recoveryLeaseGeneration,
      stageKey: recoveryJob.stage_key,
    };
    await expect(repository.beginPublicationReconciliation(recovery))
      .rejects.toMatchObject({ code: "publication_reconciliation_active" });

    await pool.query(
      `UPDATE job_queue
       SET status='completed',lease_owner=NULL,lease_expires_at=NULL,
           completed_at=now()
       WHERE id=$1`,
      [original.jobId],
    );
    await expect(repository.beginPublicationReconciliation(recovery)).resolves
      .toMatchObject({
        state: "authorization_blocked",
        appendedCount: 0,
        batchCursor: 0,
      });
    await expect(pool.query<{ status: string; phase: string }>(
      "SELECT status,phase FROM research_runs WHERE id=$1",
      [context.runId],
    )).resolves.toMatchObject({
      rows: [{ status: "publishing", phase: "apple_publication" }],
    });
    await repository.advancePublicationReconciliation({
      ...recovery,
      state: "append_pending",
      applePlaylistId: "p.reauthorized",
      appendedCount: 0,
      batchCursor: 0,
    });
    const adopted = (await pool.query<{
      execution_attempt_id: string;
      state: string;
      reconciliation_json: Record<string, unknown>;
      old_attempt_status: string;
    }>(
      `SELECT reconciliation.execution_attempt_id,reconciliation.state,
              reconciliation.reconciliation_json,
              attempt.status old_attempt_status
       FROM playlist_publication_reconciliations reconciliation
       JOIN playlist_execution_attempts attempt ON attempt.id=$2
       WHERE reconciliation.run_id=$1`,
      [context.runId, original.executionAttemptId],
    )).rows[0]!;
    expect(adopted).toMatchObject({
      execution_attempt_id: recoveryAttempt.id,
      state: "append_pending",
      old_attempt_status: "discarded",
      reconciliation_json: {
        jobId: recoveryJob.id,
        workerId: recoveryWorker,
        leaseGeneration: recoveryLeaseGeneration,
        stageKey: recoveryJob.stage_key,
        adoptedFrom: {
          executionAttemptId: original.executionAttemptId,
          jobId: original.jobId,
          leaseGeneration: original.leaseGeneration,
        },
      },
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
    const result = withCanonicalCatalogProof(retrievalResult({
      runId: context.runId,
      target: 1,
      selectedCount: 1,
      status: "exact_ready",
      prefix: "schema-18-prepublication-revalidation",
      predicateIds: positivePredicateIds(context.selectionPlan),
    }));
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
    const discoveryLeadId = randomUUID();
    await pool.query(
      `WITH qualification AS (
         SELECT contract_revision_id
         FROM playlist_qualification_records
         WHERE run_id=$1
         LIMIT 1
       )
       INSERT INTO playlist_discovery_leads(
         id,run_id,contract_revision_id,execution_attempt_id,
         provider,dependency_key,dependency_ids,provenance_roots,
         cache_origin,source_fresh_until,strategy_id,identity_hint_hash,
         lead_json,status,evidence_eligible)
       SELECT $2,$1,qualification.contract_revision_id,$3,
         'apple_music_editorial','apple_catalog',ARRAY['apple_catalog'],
         ARRAY['music.apple.com'],'live',NULL,
         'canonical-revalidation-provenance',
         repeat('a',64),'{}'::jsonb,'qualified',false
       FROM qualification`,
      [context.runId, discoveryLeadId, context.fence.contractAttemptId],
    );
    await pool.query(
      `UPDATE playlist_qualification_records
       SET discovery_lead_id=$2
       WHERE run_id=$1`,
      [context.runId, discoveryLeadId],
    );
    const provenanceProjection = await pool.query<{
      quality_has_provenance: boolean;
      cache_origin: string;
    }>(
      `UPDATE playlist_qualification_records qualification
       SET quality_result_json=qualification.quality_result_json-'provenance'
       FROM playlist_discovery_leads lead
       WHERE qualification.run_id=$1
         AND lead.id=qualification.discovery_lead_id
       RETURNING qualification.quality_result_json ? 'provenance'
           quality_has_provenance,
         lead.cache_origin`,
      [context.runId],
    );
    expect(provenanceProjection.rows).toEqual([
      { quality_has_provenance: false, cache_origin: "live" },
    ]);
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
    const selected = base.selected.map((track, index) => ({
      ...track,
      catalogGenreNames: ["Disco"],
      discoveryDependencyIds: ["hosted_web"] as const,
      provenanceRoots: [`quota-selected-${index}`],
      cacheOrigin: "live" as const,
    }));
    const reserve = base.reserve.map((track, index) => ({
      ...track,
      catalogGenreNames: ["Latin Pop"],
      discoveryDependencyIds: ["hosted_web"] as const,
      provenanceRoots: [`quota-reserve-${index}`],
      cacheOrigin: "live" as const,
    }));
    const result = withCanonicalCatalogProof({
      ...base,
      selected,
      reserve,
      qualifiedPool: [...selected, ...reserve],
    });
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

  test("replays the production-shaped 50 plus 5 reserve state without losing any of 56 source observations", async () => {
    const context = await createLeasedRun(
      50,
      "echo-park-production-shape",
      undefined,
      "50 rap and grime tracks with a style reference and new-artist emphasis",
      "catalog_membership_with_evidence_meta",
    );
    const base = withCanonicalCatalogMembershipAndEvidenceMeta(retrievalResult({
      runId: context.runId,
      target: 50,
      selectedCount: 50,
      reserveCount: 5,
      status: "exact_ready",
      prefix: "echo-park-production-shape",
      predicateIds: ["bridge:membership:hip-hop-or-grime"],
    }));
    const selected = Array.from(
      { length: base.selected.length },
      (_, index) => base.selected[(index * 11) % base.selected.length]!,
    ).map((track, index) => ({
      ...track,
      cacheOrigin: "live" as const,
      discoveryDependencyIds: ["hosted_web"] as const,
      provenanceRoots: [`echo-park-live-frontier-${index}`],
      ...(index === 0 ? {
        sourceObservationIds: [
          ...track.sourceObservationIds,
          "echo-park-production-shape:observation:extra",
        ],
      } : {}),
    }));
    const reserve = base.reserve.map((track, index) => ({
      ...track,
      cacheOrigin: "live" as const,
      discoveryDependencyIds: ["hosted_web"] as const,
      provenanceRoots: [`echo-park-live-reserve-${index}`],
    }));
    const result: RetrievalResultV3 = {
      ...base,
      selected,
      reserve,
      qualifiedPool: [...selected, ...reserve],
    };

    const first = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result,
      fence: context.fence,
    });
    const replay = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result,
      fence: context.fence,
    });
    expect(replay).toEqual(first);

    const counts = (await pool.query<{
      selected_count: number;
      reserve_count: number;
      qualification_count: number;
      null_candidate_count: number;
      manifest_revision_count: number;
      publication_job_count: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM manifest_revision_tracks
          WHERE manifest_revision_id=$2) selected_count,
         (SELECT count(*)::int FROM manifest_revision_reserve_tracks
          WHERE manifest_revision_id=$2) reserve_count,
         (SELECT count(*)::int FROM playlist_qualification_records
          WHERE run_id=$1 AND decision='qualified' AND revoked_at IS NULL) qualification_count,
         (SELECT count(*)::int FROM playlist_qualification_records
          WHERE run_id=$1 AND decision='qualified' AND revoked_at IS NULL
            AND candidate_id IS NULL) null_candidate_count,
         (SELECT count(*)::int FROM manifest_revisions revision
          JOIN manifests manifest ON manifest.id=revision.manifest_id
          WHERE manifest.run_id=$1) manifest_revision_count,
         (SELECT count(*)::int FROM job_queue
          WHERE run_id=$1 AND kind='publication') publication_job_count`,
      [context.runId, first.manifestRevisionId],
    )).rows[0]!;
    expect(counts).toEqual({
      selected_count: 50,
      reserve_count: 5,
      qualification_count: 55,
      null_candidate_count: 0,
      manifest_revision_count: 1,
      publication_job_count: 1,
    });
    await expect(repository.getPublicationGuard({
      runId: context.runId,
      manifestId: first.manifestId!,
      manifestRevisionId: first.manifestRevisionId!,
      manifestRevisionHash: first.manifestHash!,
      selectedCount: 50,
    })).resolves.toMatchObject({
      enforcement: "required",
      decision: null,
    });

    const provenance = (await pool.query<{
      provenance_path_json: Array<{ kind?: string; id?: string }>;
    }>(
      `SELECT provenance_path_json
       FROM track_scope_bindings
       WHERE run_id=$1 AND eligibility='qualifying'`,
      [context.runId],
    )).rows;
    const sourceObservationIds = provenance.flatMap(({ provenance_path_json: path }) => (
      path.filter(({ kind }) => kind === "source_observation")
        .map(({ id }) => id)
        .filter((id): id is string => typeof id === "string")
    ));
    expect(provenance).toHaveLength(55);
    expect(sourceObservationIds).toHaveLength(56);
    expect(new Set(sourceObservationIds).size).toBe(56);
  }, 120_000);

  test("rejects an evidence-policy citation that has no factual predicate scope", async () => {
    const context = await createLeasedRun(
      1,
      "unscoped-evidence-policy-binding",
      undefined,
      "1 rap or grime track",
      "catalog_membership_with_evidence_meta",
    );
    const base = retrievalResult({
      runId: context.runId,
      target: 1,
      selectedCount: 1,
      status: "exact_ready",
      prefix: "unscoped-evidence-policy-binding",
      predicateIds: ["bridge:membership:hip-hop-or-grime"],
    });
    const selected = base.selected.map((track) => {
      const binding = track.evidenceBindings![0]!;
      const {
        hostedEvidenceSnapshot: ignoredHostedEvidenceSnapshot,
        ...unhosted
      } = binding;
      void ignoredHostedEvidenceSnapshot;
      return {
        ...track,
        evidenceBindings: [{
          ...unhosted,
          kind: "apple_editorial_container",
          predicateIds: [],
          governance: {
            ...binding.governance,
            accessMethod: "public_api" as const,
            licenseState: "reusable" as const,
            licenseVersion: "apple-test-v1",
            termsVersion: "apple-test-v1",
            sourceHash: "a".repeat(64),
            sourceRevision: "a".repeat(64),
          },
          eligibilityAttestation: publicTrackScopeAttestationV3(binding.url!),
        }],
        canonicalClauseAssessments: {
          "bridge:membership:hip-hop-or-grime": {
            status: "pass" as const,
            evidenceGrade: "authoritative_structured_metadata" as const,
            evidenceIds: [],
          },
          "bridge:evidence:qualification-policy": {
            status: "pass" as const,
            evidenceGrade: "trusted_scoped_container" as const,
            evidenceIds: [...track.evidenceBindingIds],
          },
        },
      } satisfies QualifiedTrackV3;
    });

    await expect(repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result: {
        ...base,
        selected,
        qualifiedPool: selected,
      },
      fence: context.fence,
    })).rejects.toMatchObject({
      code: "pipeline_v3_evidence_predicate_missing",
    });
    expect((await pool.query<{ manifests: number; qualifications: number }>(
      `SELECT
         (SELECT count(*)::int FROM manifests WHERE run_id=$1) manifests,
         (SELECT count(*)::int FROM playlist_qualification_records
          WHERE run_id=$1) qualifications`,
      [context.runId],
    )).rows[0]).toEqual({
      manifests: 0,
      qualifications: 0,
    });
  }, 30_000);

  test("uses database-returned candidate IDs after an upsert conflict", async () => {
    const context = await createLeasedRun(
      1,
      "returned-candidate-id",
      undefined,
      "Create 1 reggaeton track",
      "or_membership",
    );
    const result = withCanonicalHostedProof(retrievalResult({
      runId: context.runId,
      target: 1,
      selectedCount: 1,
      status: "exact_ready",
      prefix: "returned-candidate-id",
      predicateIds: ["genre:reggaeton"],
    }), "genre:reggaeton");
    const track = result.selected[0]!;
    const existingFamilyId = randomUUID();
    const existingCandidateId = randomUUID();
    const canonicalKey = `v3:${sha256Hex(stableStringify({
      runId: context.runId,
      sourceCandidateId: track.candidateId,
      familyKey: track.recordingFamilyKey,
    }))}`;
    await pool.query(
      `INSERT INTO recording_families(
         id,run_id,family_key,canonical_artist,canonical_title,version_class,
         metadata_json,pipeline_version,policy_version)
       VALUES($1,$2,$3,$4,$5,'canonical','{}'::jsonb,
         'corpus_first_v3','corpus_first_v3_policy_v1')`,
      [
        existingFamilyId,
        context.runId,
        track.recordingFamilyKey,
        track.artist,
        track.title,
      ],
    );
    await pool.query(
      `INSERT INTO track_candidates(
         id,run_id,canonical_key,duplicate_cluster_key,artist,title,album,outcome,
         recording_family_id,candidate_stage,pipeline_version,policy_version)
       VALUES($1,$2,$3,$4,$5,$6,$7,'accepted',$8,'discovered',
         'corpus_first_v3','corpus_first_v3_policy_v1')`,
      [
        existingCandidateId,
        context.runId,
        canonicalKey,
        track.recordingFamilyKey,
        track.artist,
        track.title,
        track.album,
        existingFamilyId,
      ],
    );

    const persisted = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result,
      fence: context.fence,
    });
    const binding = (await pool.query<{
      manifest_candidate_id: string;
      qualification_candidate_id: string;
      family_id: string;
    }>(
      `SELECT item.candidate_id manifest_candidate_id,
              qualification.candidate_id qualification_candidate_id,
              item.recording_family_id family_id
       FROM manifest_revision_tracks item
       JOIN playlist_qualification_records qualification
         ON qualification.run_id=$1
        AND qualification.candidate_id=item.candidate_id
        AND qualification.decision='qualified'
        AND qualification.revoked_at IS NULL
       WHERE item.manifest_revision_id=$2`,
      [context.runId, persisted.manifestRevisionId],
    )).rows[0]!;
    expect(binding).toEqual({
      manifest_candidate_id: existingCandidateId,
      qualification_candidate_id: existingCandidateId,
      family_id: existingFamilyId,
    });
  }, 30_000);

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

  test("rejects a valid extra concept lead that is absent from the immutable selection plan", async () => {
    const context = await createLeasedRun(1, "forged-concept-discovery-hint");
    const forgedQueryPlan: QueryPlanV3 = {
      ...context.queryPlan,
      conceptDiscoveryHints: [{
        clauseId: "unexecuted:concept:velvet-pulse",
        axis: "genre",
        originalText: "velvet pulse",
        normalizedText: "velvet pulse",
        status: "unresolved",
        ontologyVersion: "playlist_music_ontology_v3",
        unresolvedTermId: `unresolved:${sha256Hex("velvet pulse").slice(0, 16)}`,
        provenance: "immutable_playlist_contract_concept_v1",
        untrusted: true,
        usage: "discovery_lead_only_not_membership_evidence_or_ranking",
      }],
    };
    expect(isQueryPlanV3(forgedQueryPlan)).toBe(true);
    const forgedHash = queryPlanV3Hash(forgedQueryPlan);
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
        prefix: "forged-concept-discovery-hint",
        predicateIds: positivePredicateIds(forgedExecutionPlan),
      }),
      fence: context.fence,
    })).rejects.toMatchObject({ code: "pipeline_v3_plan_stale" });
  }, 30_000);

  test("locks a partial manifest without any Apple write until capability-bound consent", async () => {
    const priorMode = process.env.PIPELINE_V3_PROOF_ARCHITECTURE_MODE;
    process.env.PIPELINE_V3_PROOF_ARCHITECTURE_MODE = "native";
    await pool.query(
      `UPDATE settings SET value='native',updated_at=now()
       WHERE key='proof_architecture_authority'`,
    );
    try {
    const context = await createLeasedRun(
      50,
      "french-jazz-partial",
      undefined,
      "Create 50 rap music and grime recordings",
      "catalog_membership_with_evidence_meta",
    );
    const partialBase = withCanonicalCatalogMembershipAndEvidenceMeta(retrievalResult({
      runId: context.runId,
      target: 50,
      selectedCount: 23,
      status: "partial_ready",
      prefix: "partial-23",
      predicateIds: ["bridge:membership:hip-hop-or-grime"],
    }));
    const selected = Array.from(
      { length: partialBase.selected.length },
      (_, index) => partialBase.selected[
        (index * 11) % partialBase.selected.length
      ]!,
    ).map((track, index) => ({
      ...track,
      cacheOrigin: "live" as const,
      discoveryDependencyIds: ["hosted_web"] as const,
      provenanceRoots: [`partial-live-frontier-${index}`],
    }));
    const result: RetrievalResultV3 = {
      ...partialBase,
      selected,
      qualifiedPool: selected,
    };
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
    expect((await pool.query<{
      selection_set_id: string | null;
      manifest_payload_hash: string | null;
      attestation_set_hash: string | null;
    }>(
      `SELECT selection_set_id,manifest_payload_hash,attestation_set_hash
       FROM partial_publication_decisions
       WHERE run_id=$1 AND manifest_revision_id=$2`,
      [context.runId, persisted.manifestRevisionId],
    )).rows[0]).toMatchObject({
      selection_set_id: expect.any(String),
      manifest_payload_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      attestation_set_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
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
    } finally {
      await pool.query(
        `UPDATE settings SET value='shadow',updated_at=now()
         WHERE key='proof_architecture_authority'`,
      );
      if (priorMode === undefined) {
        delete process.env.PIPELINE_V3_PROOF_ARCHITECTURE_MODE;
      } else {
        process.env.PIPELINE_V3_PROOF_ARCHITECTURE_MODE = priorMode;
      }
    }
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

  test("persists a full-selection integrity failure as quarantine with no publishable manifest", async () => {
    const context = await createLeasedRun(
      25,
      "returned-integrity-failure",
      undefined,
      "Create 25 disco tracks",
    );
    const persisted = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result: retrievalResult({
        runId: context.runId,
        target: 25,
        selectedCount: 25,
        status: "failed_integrity",
        prefix: "integrity",
      }),
      fence: context.fence,
    });

    expect(persisted).toEqual({
      manifestId: null,
      manifestRevisionId: null,
      manifestHash: null,
      publicationState: "not_applicable",
    });
    expect((await pool.query<{
      status: string;
      phase: string;
      pipeline_outcome: string;
      manifests: number;
      publication_jobs: number;
    }>(
      `SELECT run.status,run.phase,outcome.status pipeline_outcome,
              (SELECT count(*)::int FROM manifests WHERE run_id=run.id) manifests,
              (SELECT count(*)::int FROM job_queue
               WHERE run_id=run.id AND kind='publication') publication_jobs
       FROM research_runs run
       JOIN pipeline_outcomes outcome ON outcome.run_id=run.id
       WHERE run.id=$1`,
      [context.runId],
    )).rows[0]).toEqual({
      status: "failed_integrity",
      phase: "pipeline_v3_failed_integrity",
      pipeline_outcome: "failed_integrity",
      manifests: 0,
      publication_jobs: 0,
    });
  }, 30_000);

  test("persists and republishes a canonical catalog-only proof without manufacturing an external binding", async () => {
    const context = await createLeasedRun(
      1,
      "catalog-structured-metadata-only",
      undefined,
      "Create 1 released disco track",
      "empty",
    );
    expect(context.queryPlan.schemaVersion).toBe(5);
    const base = retrievalResult({
      runId: context.runId,
      target: 1,
      selectedCount: 1,
      status: "exact_ready",
      prefix: "catalog-structured-metadata-only",
      predicateIds: positivePredicateIds(context.selectionPlan),
    });
    const selected = base.selected.map((track) => ({
      ...track,
      evidenceBindingIds: [],
      evidenceBindings: [],
      evidenceStrength: 1,
      independentProvenanceRoots: 1,
      canonicalClauseAssessments: {
        "catalog:storefront-playable": {
          status: "pass" as const,
          evidenceGrade: "authoritative_structured_metadata" as const,
          evidenceIds: [],
        },
      },
    }));
    const result: RetrievalResultV3 = {
      ...base,
      selected,
      qualifiedPool: selected,
    };

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
      publicationState: "queued",
    });
    expect((await pool.query<{ bindings: number; evidence_ids: string[] }>(
      `SELECT
         (SELECT count(*)::int FROM track_scope_bindings WHERE run_id=$1) bindings,
         qualification.evidence_record_ids_json evidence_ids
       FROM playlist_qualification_records qualification
       WHERE qualification.run_id=$1`,
      [context.runId],
    )).rows[0]).toEqual({
      bindings: 0,
      evidence_ids: [],
    });

    await expect(repository.getPublicationGuard({
      runId: context.runId,
      manifestId: persisted.manifestId!,
      manifestRevisionId: persisted.manifestRevisionId!,
      manifestRevisionHash: persisted.manifestHash!,
      selectedCount: 1,
    })).resolves.toMatchObject({
      enforcement: "required",
      decision: null,
    });
    await expect(repository.revalidateCanonicalPublicationManifest({
      runId: context.runId,
      manifestId: persisted.manifestId!,
      manifestRevisionId: persisted.manifestRevisionId!,
      manifestRevisionHash: persisted.manifestHash!,
      partialPublicationAuthorized: false,
    })).resolves.toBeUndefined();
  }, 30_000);

  test("persists and revalidates a declared exact-artist exclusion from Apple identity alone", async () => {
    const context = await createLeasedRun(
      1,
      "closed-world-pop-smoke-exclusion",
      undefined,
      "Create 1 released disco track",
      "closed_world_artist_exclusion",
    );
    const base = retrievalResult({
      runId: context.runId,
      target: 1,
      selectedCount: 1,
      status: "exact_ready",
      prefix: "closed-world-pop-smoke-exclusion",
      predicateIds: [],
    });
    const selected = base.selected.map((track) => ({
      ...track,
      evidenceBindingIds: [],
      evidenceBindings: [],
      evidenceStrength: 1,
      independentProvenanceRoots: 1,
      canonicalClauseAssessments: {
        "catalog:storefront-playable": {
          status: "pass" as const,
          evidenceGrade: "authoritative_structured_metadata" as const,
          evidenceIds: [],
        },
        "artist:exclude-pop-smoke": {
          status: "fail" as const,
          evidenceGrade: "authoritative_structured_metadata" as const,
          evidenceIds: [],
        },
      },
    }));
    const result: RetrievalResultV3 = {
      ...base,
      selected,
      qualifiedPool: selected,
    };

    const first = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result,
      fence: context.fence,
    });
    const replay = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result,
      fence: context.fence,
    });
    expect(replay).toEqual(first);
    expect((await pool.query<{
      decision: string;
      bindings: number;
      null_candidates: number;
    }>(
      `SELECT qualification.decision,
              (SELECT count(*)::int FROM track_scope_bindings
               WHERE run_id=$1) bindings,
              count(*) FILTER (
                WHERE qualification.candidate_id IS NULL
              )::int null_candidates
       FROM playlist_qualification_records qualification
       WHERE qualification.run_id=$1
       GROUP BY qualification.decision`,
      [context.runId],
    )).rows[0]).toEqual({
      decision: "qualified",
      bindings: 0,
      null_candidates: 0,
    });
    await expect(repository.revalidateCanonicalPublicationManifest({
      runId: context.runId,
      manifestId: first.manifestId!,
      manifestRevisionId: first.manifestRevisionId!,
      manifestRevisionHash: first.manifestHash!,
      partialPublicationAuthorized: false,
    })).resolves.toBeUndefined();
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

  test("persists hosted evidence content and rejects excerpt tampering before publication", async () => {
    const context = await createLeasedRun(
      1,
      "hosted-snapshot-prepublication-tamper",
      undefined,
      "Create 1 disco track",
      "or_membership",
    );
    const persisted = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result: withCanonicalHostedProof(retrievalResult({
        runId: context.runId,
        target: 1,
        selectedCount: 1,
        status: "exact_ready",
        prefix: "hosted-snapshot-prepublication-tamper",
        predicateIds: ["genre:reggaeton"],
      }), "genre:reggaeton"),
      fence: context.fence,
    });
    const durable = (await pool.query<{
      provenance_path_json: Array<Record<string, unknown>>;
      quality_result_json: Record<string, unknown>;
    }>(
      `SELECT binding.provenance_path_json,
              qualification.quality_result_json
       FROM track_scope_bindings binding
       JOIN playlist_qualification_records qualification
         ON qualification.run_id=binding.run_id
        AND qualification.candidate_id=binding.candidate_id
        AND qualification.decision='qualified'
        AND qualification.revoked_at IS NULL
       WHERE binding.run_id=$1
       ORDER BY qualification.qualified_at DESC,binding.id
       LIMIT 1`,
      [context.runId],
    )).rows[0]!;
    const pathSnapshot = durable.provenance_path_json.find(
      ({ kind }) => kind === "hosted_web_evidence_snapshot",
    )?.snapshot as Record<string, unknown> | undefined;
    const qualitySnapshots = durable.quality_result_json
      .hostedEvidenceSnapshots as Array<Record<string, unknown>>;
    expect(pathSnapshot).toMatchObject({
      schemaVersion: "genio-hosted-web-evidence-snapshot/v1",
      excerpt: expect.stringContaining("satisfies"),
      excerptHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      snapshotHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      storefront: context.selectionPlan.storefront,
      revokedAt: null,
      predicateIds: ["genre:reggaeton"],
      obligationIds: ["genre:reggaeton"],
    });
    expect(qualitySnapshots).toContainEqual(pathSnapshot);

    await pool.query(
      `UPDATE track_scope_bindings binding
       SET provenance_path_json=(
         SELECT jsonb_agg(
           CASE
             WHEN entry.item->>'kind'='hosted_web_evidence_snapshot'
             THEN jsonb_set(
               entry.item,
               '{snapshot,excerpt}',
               to_jsonb('tampered hosted evidence'::text)
             )
             ELSE entry.item
           END
           ORDER BY entry.ordinal
         )
         FROM jsonb_array_elements(binding.provenance_path_json)
           WITH ORDINALITY entry(item,ordinal)
       )
       WHERE binding.run_id=$1`,
      [context.runId],
    );
    await expect(repository.getPublicationGuard({
      runId: context.runId,
      manifestId: persisted.manifestId!,
      manifestRevisionId: persisted.manifestRevisionId!,
      manifestRevisionHash: persisted.manifestHash!,
      selectedCount: 1,
    })).rejects.toMatchObject({
      code: "pipeline_v3_evidence_attestation_missing",
    });
    await expect(repository.revalidateCanonicalPublicationManifest({
      runId: context.runId,
      manifestId: persisted.manifestId!,
      manifestRevisionId: persisted.manifestRevisionId!,
      manifestRevisionHash: persisted.manifestHash!,
      partialPublicationAuthorized: false,
    })).rejects.toMatchObject({
      code: CANONICAL_PUBLICATION_REVALIDATION_ERROR,
      reasonCodes: ["canonical_evidence_binding_invalid"],
    });
  }, 30_000);

  test("rejects an unbounded unhashed field injected into a persisted evidence wrapper", async () => {
    const context = await createLeasedRun(
      1,
      "hosted-wrapper-prepublication-tamper",
      undefined,
      "Create 1 disco track",
      "or_membership",
    );
    const persisted = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result: withCanonicalHostedProof(retrievalResult({
        runId: context.runId,
        target: 1,
        selectedCount: 1,
        status: "exact_ready",
        prefix: "hosted-wrapper-prepublication-tamper",
        predicateIds: ["genre:reggaeton"],
      }), "genre:reggaeton"),
      fence: context.fence,
    });

    await pool.query(
      `UPDATE track_scope_bindings binding
       SET provenance_path_json=(
         SELECT jsonb_agg(
           CASE
             WHEN entry.item->>'kind'='evidence_source_governance'
             THEN entry.item || jsonb_build_object(
               'unhashedProviderPayload',
               repeat('x', 1024 * 1024)
             )
             ELSE entry.item
           END
           ORDER BY entry.ordinal
         )
         FROM jsonb_array_elements(binding.provenance_path_json)
           WITH ORDINALITY entry(item,ordinal)
       )
       WHERE binding.run_id=$1`,
      [context.runId],
    );

    await expect(repository.getPublicationGuard({
      runId: context.runId,
      manifestId: persisted.manifestId!,
      manifestRevisionId: persisted.manifestRevisionId!,
      manifestRevisionHash: persisted.manifestHash!,
      selectedCount: 1,
    })).rejects.toMatchObject({
      code: "pipeline_v3_evidence_attestation_missing",
    });
    await expect(repository.revalidateCanonicalPublicationManifest({
      runId: context.runId,
      manifestId: persisted.manifestId!,
      manifestRevisionId: persisted.manifestRevisionId!,
      manifestRevisionHash: persisted.manifestHash!,
      partialPublicationAuthorized: false,
    })).rejects.toMatchObject({
      code: CANONICAL_PUBLICATION_REVALIDATION_ERROR,
      reasonCodes: ["canonical_evidence_binding_invalid"],
    });
  }, 30_000);

  test("rejects expired or revoked persisted hosted evidence before publication", async () => {
    for (const mutation of [
      {
        label: "expired",
        path: "{governance,freshnessExpiresAt}",
        value: "2020-01-01T00:00:00.000Z",
      },
      {
        label: "revoked",
        path: "{governance,revokedAt}",
        value: "2026-07-25T00:00:00.000Z",
      },
    ]) {
      const context = await createLeasedRun(
        1,
        `hosted-snapshot-${mutation.label}`,
        undefined,
        "Create 1 disco track",
        "or_membership",
      );
      const persisted = await repository.persistPipelineV3RetrievalResult({
        runId: context.runId,
        queryPlan: context.queryPlan,
        plan: context.selectionPlan,
        result: withCanonicalHostedProof(retrievalResult({
          runId: context.runId,
          target: 1,
          selectedCount: 1,
          status: "exact_ready",
          prefix: `hosted-snapshot-${mutation.label}`,
          predicateIds: ["genre:reggaeton"],
        }), "genre:reggaeton"),
        fence: context.fence,
      });
      await pool.query(
        `UPDATE track_scope_bindings binding
         SET provenance_path_json=(
           SELECT jsonb_agg(
             CASE
               WHEN entry.item->>'kind'='evidence_source_governance'
               THEN jsonb_set(
                 entry.item,
                 $2::text[],
                 to_jsonb($3::text)
               )
               ELSE entry.item
             END
             ORDER BY entry.ordinal
           )
           FROM jsonb_array_elements(binding.provenance_path_json)
             WITH ORDINALITY entry(item,ordinal)
         )
         WHERE binding.run_id=$1`,
        [
          context.runId,
          mutation.path.replace(/[{}]/gu, "").split(","),
          mutation.value,
        ],
      );
      await expect(repository.revalidateCanonicalPublicationManifest({
        runId: context.runId,
        manifestId: persisted.manifestId!,
        manifestRevisionId: persisted.manifestRevisionId!,
        manifestRevisionHash: persisted.manifestHash!,
        partialPublicationAuthorized: false,
      })).rejects.toMatchObject({
        code: CANONICAL_PUBLICATION_REVALIDATION_ERROR,
        reasonCodes: ["canonical_evidence_binding_invalid"],
      });
    }
  }, 60_000);

  test("rejects qualification projection tampering at restart and publication", async () => {
    const mutations = [{
      label: "stable-identity-hash",
      sql: `UPDATE playlist_qualification_records
            SET stable_identity_hash=repeat('f',64)
            WHERE run_id=$1 AND decision='qualified' AND revoked_at IS NULL`,
    }, {
      label: "qualification-hash",
      sql: `UPDATE playlist_qualification_records
            SET qualification_hash=repeat('e',64)
            WHERE run_id=$1 AND decision='qualified' AND revoked_at IS NULL`,
    }, {
      label: "assessment-references",
      sql: `UPDATE playlist_qualification_records
            SET predicate_results_json=jsonb_set(
              predicate_results_json,
              '{canonicalContract,assessments,genre:reggaeton,evidenceIds}',
              '[]'::jsonb
            )
            WHERE run_id=$1 AND decision='qualified' AND revoked_at IS NULL`,
    }, {
      label: "hosted-snapshots",
      sql: `UPDATE playlist_qualification_records
            SET quality_result_json=jsonb_set(
              quality_result_json,
              '{hostedEvidenceSnapshots}',
              '[]'::jsonb
            )
            WHERE run_id=$1 AND decision='qualified' AND revoked_at IS NULL`,
    }, {
      label: "quality-projection",
      sql: `UPDATE playlist_qualification_records
            SET quality_result_json=jsonb_set(
              quality_result_json,
              '{sourceRank}',
              '999'::jsonb
            )
            WHERE run_id=$1 AND decision='qualified' AND revoked_at IS NULL`,
    }, {
      label: "catalog-projection",
      sql: `UPDATE playlist_qualification_records
            SET catalog_result_json=jsonb_set(
              catalog_result_json,
              '{appleSongId}',
              to_jsonb('tampered-apple-id'::text)
            )
            WHERE run_id=$1 AND decision='qualified' AND revoked_at IS NULL`,
    }] as const;

    for (const mutation of mutations) {
      const context = await createLeasedRun(
        1,
        `canonical-projection-tamper-${mutation.label}`,
        undefined,
        "Create 1 reggaeton track",
        "or_membership",
      );
      const base = retrievalResult({
        runId: context.runId,
        target: 1,
        selectedCount: 1,
        status: "exact_ready",
        prefix: `canonical-projection-tamper-${mutation.label}`,
        predicateIds: ["genre:reggaeton"],
      });
      const selected = base.selected.map((track) => ({
        ...track,
        canonicalClauseAssessments: {
          "genre:reggaeton": {
            status: "pass" as const,
            evidenceGrade: "track_specific_editorial_assertion" as const,
            evidenceIds: [...track.evidenceBindingIds],
          },
          "genre:dembow": { status: "unknown" as const },
        },
      }));
      const persisted = await repository.persistPipelineV3RetrievalResult({
        runId: context.runId,
        queryPlan: context.queryPlan,
        plan: context.selectionPlan,
        result: {
          ...base,
          selected,
          qualifiedPool: selected,
        },
        fence: context.fence,
      });
      await expect(repository.validatePipelineV3ContinuationQualifications({
        runId: context.runId,
        queryPlan: context.queryPlan,
        tracks: selected,
      })).resolves.toBeUndefined();

      await pool.query(mutation.sql, [context.runId]);

      await expect(repository.validatePipelineV3ContinuationQualifications({
        runId: context.runId,
        queryPlan: context.queryPlan,
        tracks: selected,
      })).rejects.toMatchObject({
        code: "pipeline_v3_continuation_qualification_invalid",
      });
      await expect(repository.getPublicationGuard({
        runId: context.runId,
        manifestId: persisted.manifestId!,
        manifestRevisionId: persisted.manifestRevisionId!,
        manifestRevisionHash: persisted.manifestHash!,
        selectedCount: 1,
      })).rejects.toMatchObject({
        code: "pipeline_v3_evidence_attestation_missing",
      });
      await expect(repository.revalidateCanonicalPublicationManifest({
        runId: context.runId,
        manifestId: persisted.manifestId!,
        manifestRevisionId: persisted.manifestRevisionId!,
        manifestRevisionHash: persisted.manifestHash!,
        partialPublicationAuthorized: false,
      })).rejects.toMatchObject({
        code: CANONICAL_PUBLICATION_REVALIDATION_ERROR,
      });
    }
  }, 180_000);

  test("persists policy-bound central-quality observations and fences continuation omission", async () => {
    const qualityPolicy:
      NonNullable<SelectionPlanV3["playlistQualityPolicy"]> = {
      policyVersion: "canonical_central_quality_v1",
      clauseIds: ["quality:smooth", "quality:polished"],
      criteria: ["smooth", "polished"],
      minimumPassRatio: 0.8,
      maximumUnknownRatio: 0.2,
      zeroKnownFailures: true,
      signalDimension: "central_quality",
      passThreshold: 0.75,
      failThreshold: 0.4,
      signalSemantics: "ranking_only_not_factual_evidence",
    };
    const context = await createLeasedRun(
      1,
      "central-quality-continuation",
      (selection) => ({
        ...selection,
        playlistQualityPolicy: qualityPolicy,
      }),
      "Create one smooth and polished reggaeton track",
      "or_membership",
    );
    const base = retrievalResult({
      runId: context.runId,
      target: 1,
      selectedCount: 1,
      status: "exact_ready",
      prefix: "central-quality-continuation",
      predicateIds: ["genre:reggaeton"],
    });
    const selected = base.selected.map((track) => ({
      ...track,
      evidenceBindings: track.evidenceBindings?.map((binding) => ({
        ...binding,
        kind: "hosted_web_track",
      })),
      canonicalClauseAssessments: {
        "genre:reggaeton": {
          status: "pass" as const,
          evidenceGrade: "track_specific_editorial_assertion" as const,
          evidenceIds: [...track.evidenceBindingIds],
        },
        "genre:dembow": { status: "unknown" as const },
      },
      centralQualityCriterionObservations: qualityPolicy.criteria.map(
        (criterion) => createCentralQualityCriterionObservationV3({
          policy: qualityPolicy,
          criterion,
          verdict: "pass",
          sourceKind: "independent_curator_review",
          sourceId: "central-quality-continuation-review",
          artist: track.artist,
          title: track.title,
          album: track.album,
          catalogIdentity: {
            appleSongId: track.appleSongId,
            recordingFamilyKey: track.recordingFamilyKey,
          },
        }),
      ),
      rankingSignals: {
        ...track.rankingSignals,
        central_quality: 1,
      },
    }));
    const replayedSelected = selected.map((track) => ({
      ...track,
      centralQualityCriterionObservations: qualityPolicy.criteria.map(
        (criterion) => createCentralQualityCriterionObservationV3({
          policy: qualityPolicy,
          criterion,
          verdict: "pass",
          sourceKind: "independent_curator_review",
          sourceId: "review-for-another-catalog-family",
          artist: track.artist,
          title: track.title,
          album: track.album,
          catalogIdentity: {
            appleSongId: "apple-replayed-recording",
            recordingFamilyKey: "family-replayed-recording",
          },
        }),
      ),
    }));
    await expect(repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result: {
        ...base,
        selected: replayedSelected,
        qualifiedPool: replayedSelected,
      },
      fence: context.fence,
    })).rejects.toMatchObject({ code: "pipeline_v3_result_invalid" });
    await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result: {
        ...base,
        selected,
        qualifiedPool: selected,
      },
      fence: context.fence,
    });

    const persisted = (await pool.query<{
      central_quality_criterion_observations: unknown;
    }>(
      `SELECT quality_result_json->'centralQualityCriterionObservations'
                central_quality_criterion_observations
       FROM playlist_qualification_records
       WHERE run_id=$1 AND decision='qualified' AND revoked_at IS NULL`,
      [context.runId],
    )).rows[0]!;
    expect(persisted.central_quality_criterion_observations)
      .toEqual(
        [...selected[0]!.centralQualityCriterionObservations!]
          .sort((left, right) => left.observationId.localeCompare(right.observationId)),
      );
    await expect(repository.validatePipelineV3ContinuationQualifications({
      runId: context.runId,
      queryPlan: context.queryPlan,
      tracks: selected,
    })).resolves.toBeUndefined();
    await expect(repository.validatePipelineV3ContinuationQualifications({
      runId: context.runId,
      queryPlan: context.queryPlan,
      tracks: [{
        ...selected[0]!,
        centralQualityCriterionObservations: [],
      }],
    })).rejects.toMatchObject({
      code: "pipeline_v3_continuation_qualification_invalid",
    });
    await expect(repository.validatePipelineV3ContinuationQualifications({
      runId: context.runId,
      queryPlan: context.queryPlan,
      tracks: replayedSelected,
    })).rejects.toMatchObject({
      code: "pipeline_v3_continuation_qualification_invalid",
    });
  }, 30_000);

  test("publication guard preserves canonical OR semantics instead of requiring every positive leaf", async () => {
    const context = await createLeasedRun(
      1,
      "canonical-or-publication",
      undefined,
      undefined,
      "or_membership",
    );
    expect(context.queryPlan.schemaVersion).toBe(5);
    const base = retrievalResult({
      runId: context.runId,
      target: 1,
      selectedCount: 1,
      status: "exact_ready",
      prefix: "canonical-or-publication",
      predicateIds: ["genre:reggaeton"],
    });
    const selected = base.selected.map((track) => ({
      ...track,
      canonicalClauseAssessments: {
        "genre:reggaeton": {
          status: "pass" as const,
          evidenceGrade: "track_specific_editorial_assertion" as const,
          evidenceIds: [...track.evidenceBindingIds],
        },
        "genre:dembow": {
          status: "unknown" as const,
        },
      },
    }));
    const persisted = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result: {
        ...base,
        selected,
        qualifiedPool: selected,
      },
      fence: context.fence,
    });

    await expect(repository.getPublicationGuard({
      runId: context.runId,
      manifestId: persisted.manifestId!,
      manifestRevisionId: persisted.manifestRevisionId!,
      manifestRevisionHash: persisted.manifestHash!,
      selectedCount: 1,
    })).resolves.toMatchObject({
      enforcement: "required",
      decision: null,
    });
    await expect(repository.revalidateCanonicalPublicationManifest({
      runId: context.runId,
      manifestId: persisted.manifestId!,
      manifestRevisionId: persisted.manifestRevisionId!,
      manifestRevisionHash: persisted.manifestHash!,
      partialPublicationAuthorized: false,
    })).resolves.toBeUndefined();
  }, 30_000);

  test("reconstructs one multi-obligation hosted source for every persisted clause row", async () => {
    const context = await createLeasedRun(
      1,
      "canonical-multi-obligation-source",
      undefined,
      undefined,
      "or_membership",
    );
    const predicateIds = ["genre:dembow", "genre:reggaeton"];
    const base = retrievalResult({
      runId: context.runId,
      target: 1,
      selectedCount: 1,
      status: "exact_ready",
      prefix: "canonical-multi-obligation-source",
      predicateIds,
    });
    const selected = base.selected.map((track) => ({
      ...track,
      canonicalClauseAssessments: {
        "genre:reggaeton": {
          status: "pass" as const,
          evidenceGrade: "track_specific_editorial_assertion" as const,
          evidenceIds: [...track.evidenceBindingIds],
        },
        "genre:dembow": {
          status: "pass" as const,
          evidenceGrade: "track_specific_editorial_assertion" as const,
          evidenceIds: [...track.evidenceBindingIds],
        },
      },
    }));
    const persisted = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result: {
        ...base,
        selected,
        qualifiedPool: selected,
      },
      fence: context.fence,
    });
    const bindings = (await pool.query<{
      provenance_path_json: Array<Record<string, unknown>>;
    }>(
      `SELECT provenance_path_json
       FROM track_scope_bindings
       WHERE run_id=$1
       ORDER BY scope_axis,scope_value,id`,
      [context.runId],
    )).rows.map(({ provenance_path_json }) => (
      provenance_path_json.find(
        ({ kind }) => kind === "pipeline_v3_binding",
      )
    ));
    expect(bindings).toHaveLength(2);
    expect(bindings.map((binding) => binding?.predicateIds).sort())
      .toEqual([["genre:dembow"], ["genre:reggaeton"]]);
    expect(bindings.every((binding) => (
      stableStringify(binding?.sourcePredicateIds) ===
        stableStringify(predicateIds)
    ))).toBe(true);

    await expect(repository.validatePipelineV3ContinuationQualifications({
      runId: context.runId,
      queryPlan: context.queryPlan,
      tracks: selected,
    })).resolves.toBeUndefined();
    await expect(repository.getPublicationGuard({
      runId: context.runId,
      manifestId: persisted.manifestId!,
      manifestRevisionId: persisted.manifestRevisionId!,
      manifestRevisionHash: persisted.manifestHash!,
      selectedCount: 1,
    })).resolves.toMatchObject({
      enforcement: "required",
      decision: null,
    });
    await expect(repository.revalidateCanonicalPublicationManifest({
      runId: context.runId,
      manifestId: persisted.manifestId!,
      manifestRevisionId: persisted.manifestRevisionId!,
      manifestRevisionHash: persisted.manifestHash!,
      partialPublicationAuthorized: false,
    })).resolves.toBeUndefined();
  }, 30_000);

  test("publication guard preserves canonical NOT semantics with proof of the decisive negative leaf", async () => {
    const context = await createLeasedRun(
      1,
      "canonical-not-publication",
      undefined,
      undefined,
      "not_exclusion",
    );
    expect(context.queryPlan.schemaVersion).toBe(5);
    const base = retrievalResult({
      runId: context.runId,
      target: 1,
      selectedCount: 1,
      status: "exact_ready",
      prefix: "canonical-not-publication",
      predicateIds: ["genre:reggaeton", "artist:bad-bunny"],
    });
    const selected = base.selected.map((track) => ({
      ...track,
      artist: "Ivy Queen",
      canonicalClauseAssessments: {
        "genre:reggaeton": {
          status: "pass" as const,
          evidenceGrade: "track_specific_editorial_assertion" as const,
          evidenceIds: [...track.evidenceBindingIds],
        },
        "artist:bad-bunny": {
          status: "fail" as const,
          evidenceGrade: "track_specific_editorial_assertion" as const,
          evidenceIds: [...track.evidenceBindingIds],
        },
      },
    }));
    const persisted = await repository.persistPipelineV3RetrievalResult({
      runId: context.runId,
      queryPlan: context.queryPlan,
      plan: context.selectionPlan,
      result: {
        ...base,
        selected,
        qualifiedPool: selected,
      },
      fence: context.fence,
    });

    await expect(repository.getPublicationGuard({
      runId: context.runId,
      manifestId: persisted.manifestId!,
      manifestRevisionId: persisted.manifestRevisionId!,
      manifestRevisionHash: persisted.manifestHash!,
      selectedCount: 1,
    })).resolves.toMatchObject({
      enforcement: "required",
      decision: null,
    });
    await expect(repository.revalidateCanonicalPublicationManifest({
      runId: context.runId,
      manifestId: persisted.manifestId!,
      manifestRevisionId: persisted.manifestRevisionId!,
      manifestRevisionHash: persisted.manifestHash!,
      partialPublicationAuthorized: false,
    })).resolves.toBeUndefined();
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

  test("shadow-writes one immutable schema-20 selection proof and replays as a no-op", async () => {
    const priorMode = process.env.PIPELINE_V3_PROOF_ARCHITECTURE_MODE;
    process.env.PIPELINE_V3_PROOF_ARCHITECTURE_MODE = "shadow";
    try {
      const context = await createLeasedRun(
        1,
        "schema-20-shadow-proof",
        undefined,
        undefined,
        "empty",
      );
      const result = withCanonicalCatalogProof(retrievalResult({
        runId: context.runId,
        target: 1,
        selectedCount: 1,
        reserveCount: 1,
        status: "exact_ready",
        prefix: "schema-20-shadow-proof",
      }));
      const first = await repository.persistPipelineV3RetrievalResult({
        runId: context.runId,
        queryPlan: context.queryPlan,
        plan: context.selectionPlan,
        result,
        fence: context.fence,
      });
      const replay = await repository.persistPipelineV3RetrievalResult({
        runId: context.runId,
        queryPlan: context.queryPlan,
        plan: context.selectionPlan,
        result,
        fence: context.fence,
      });
      expect(replay).toEqual(first);

      const proof = (await pool.query<{
        selection_set_id: string;
        attestation_set_hash: string;
        proof_kind: string;
        requested_count: number;
        selected_count: number;
        reserve_count: number;
        set_items: number;
        qualifications: number;
        identities: number;
        output_attestations: number;
      }>(
        `SELECT revision.selection_set_id,revision.attestation_set_hash,
                revision.proof_kind,
                selection.requested_count,selection.selected_count,
                selection.reserve_count,
                (SELECT count(*)::int
                 FROM immutable_selection_set_items item
                 WHERE item.selection_set_id=selection.id) set_items,
                (SELECT count(*)::int
                 FROM immutable_selection_qualifications qualification
                 WHERE qualification.execution_attempt_id=
                   selection.execution_attempt_id) qualifications,
                (SELECT count(*)::int
                 FROM canonical_track_identities identity
                 JOIN immutable_selection_set_items item
                   ON item.canonical_track_identity_id=identity.id
                 WHERE item.selection_set_id=selection.id) identities,
                (SELECT count(*)::int
                 FROM selection_attempt_output_attestations output
                 WHERE output.execution_attempt_id=
                   selection.execution_attempt_id) output_attestations
         FROM manifest_revisions revision
         JOIN immutable_selection_sets selection
           ON selection.id=revision.selection_set_id
         WHERE revision.id=$1`,
        [first.manifestRevisionId],
      )).rows[0]!;
      expect(proof).toMatchObject({
        selection_set_id: expect.any(String),
        attestation_set_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        proof_kind: "shadow",
        requested_count: 1,
        selected_count: 1,
        reserve_count: 1,
        set_items: 2,
        qualifications: 2,
        identities: 2,
        output_attestations: 1,
      });
      await expect(pool.query(
        `UPDATE canonical_track_identities SET apple_stable_id='tampered'
         WHERE id=$1`,
        [(await pool.query<{ id: string }>(
          `SELECT canonical_track_identity_id id
           FROM immutable_selection_set_items
           WHERE selection_set_id=$1
           ORDER BY role,position LIMIT 1`,
          [proof.selection_set_id],
        )).rows[0]!.id],
      )).rejects.toThrow(/immutable/u);
    } finally {
      if (priorMode === undefined) {
        delete process.env.PIPELINE_V3_PROOF_ARCHITECTURE_MODE;
      } else {
        process.env.PIPELINE_V3_PROOF_ARCHITECTURE_MODE = priorMode;
      }
    }
  }, 60_000);

  test("native publication recomputes the frozen proof and rejects an appended revocation", async () => {
    const priorMode = process.env.PIPELINE_V3_PROOF_ARCHITECTURE_MODE;
    process.env.PIPELINE_V3_PROOF_ARCHITECTURE_MODE = "native";
    await pool.query(
      `UPDATE settings SET value='native',updated_at=now()
       WHERE key='proof_architecture_authority'`,
    );
    try {
      const context = await createLeasedRun(
        1,
        "schema-20-native-proof",
        undefined,
        undefined,
        "empty",
      );
      const persisted = await repository.persistPipelineV3RetrievalResult({
        runId: context.runId,
        queryPlan: context.queryPlan,
        plan: context.selectionPlan,
        result: withCanonicalCatalogProof(retrievalResult({
          runId: context.runId,
          target: 1,
          selectedCount: 1,
          status: "exact_ready",
          prefix: "schema-20-native-proof",
        })),
        fence: context.fence,
      });
      await expect(repository.getPublicationGuard({
        runId: context.runId,
        manifestId: persisted.manifestId!,
        manifestRevisionId: persisted.manifestRevisionId!,
        manifestRevisionHash: persisted.manifestHash!,
        selectedCount: 1,
      })).resolves.toMatchObject({
        requestedTrackCount: 1,
        enforcement: "required",
        decision: null,
      });
      await expect(repository.revalidateCanonicalPublicationManifest({
        runId: context.runId,
        manifestId: persisted.manifestId!,
        manifestRevisionId: persisted.manifestRevisionId!,
        manifestRevisionHash: persisted.manifestHash!,
        partialPublicationAuthorized: false,
      })).resolves.toBeUndefined();

      const qualification = (await pool.query<{ id: string }>(
        `SELECT item.selection_qualification_id id
         FROM manifest_revisions revision
         JOIN immutable_selection_set_items item
           ON item.selection_set_id=revision.selection_set_id
          AND item.role='selected'
         WHERE revision.id=$1`,
        [persisted.manifestRevisionId],
      )).rows[0]!;
      await pool.query(
        `INSERT INTO immutable_qualification_revocations(
           id,selection_qualification_id,reason_code,policy_version,
           revocation_hash,detail_json,revoked_at)
         VALUES($1,$2,'test_revocation','selection_attestation_v1',$3,
           '{"test":true}'::jsonb,now())`,
        [
          randomUUID(),
          qualification.id,
          sha256Hex(stableStringify({
            qualificationId: qualification.id,
            reason: "test_revocation",
          })),
        ],
      );
      await expect(repository.getPublicationGuard({
        runId: context.runId,
        manifestId: persisted.manifestId!,
        manifestRevisionId: persisted.manifestRevisionId!,
        manifestRevisionHash: persisted.manifestHash!,
        selectedCount: 1,
      })).rejects.toMatchObject({
        code: "schema20_native_publication_proof_invalid",
      });
    } finally {
      await pool.query(
        `UPDATE settings SET value='shadow',updated_at=now()
         WHERE key='proof_architecture_authority'`,
      );
      if (priorMode === undefined) {
        delete process.env.PIPELINE_V3_PROOF_ARCHITECTURE_MODE;
      } else {
        process.env.PIPELINE_V3_PROOF_ARCHITECTURE_MODE = priorMode;
      }
    }
  }, 60_000);

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
