import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { createDatabase } from "../../db/index.ts";
import {
  attestedEvidenceBindingsForSelectionV3,
  createCentralQualityCriterionObservationV3,
  createHostedWebEvidenceSnapshotV3,
  evaluateCentralQualityV3,
  publicTrackScopeAttestationV3,
  type CandidateQualificationV3,
  type QualifiedTrackV3,
  type RawTrackCandidateV3,
  type RetrievalResultV3,
  type RetrievalStrategyDefinitionV3,
} from "../../server/pipeline-v3-retrieval.ts";
import {
  createPipelineV3RetrievalExecutionPort,
  selectionPlanFromQueryPlanV3,
  type PipelineV3RetrievalExecutionInput,
  type PipelineV3RetrievalExecutionPort,
} from "../../server/pipeline-v3-worker-execution.ts";
import { candidateLeadKeyV3 } from "../../server/pipeline-v3-semantic-recovery.ts";
import { orderedAppleStableIdsHash } from "../../server/publication-reconciliation-persistence.ts";
import { publicationTerminalStatus } from "../../server/publisher.ts";
import {
  createExecutionRouteReceiptV1,
  parseExecutionRouteReceiptV1,
} from "../../server/execution-route-receipt-v1.ts";
import { Repository } from "../../server/repository.ts";
import { defaultJobHandlers, WorkerRunner } from "../../server/worker-runner.ts";
import type { PlaylistContractRevisionV1 } from "../../server/playlist-contract-v1.ts";
import {
  PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
  type PublicRolloutConfiguration,
  type PublicRolloutIntentGroup,
} from "../../shared/public-rollout-evidence.ts";
import { signedArtifactSha256 } from "../../shared/signed-artifact.ts";
import type {
  CanonicalPlaylistContractClauseV1,
  CanonicalPlaylistContractEvidenceGradeV1,
  CanonicalPlaylistContractExecutionPolicyV1,
  CanonicalPlaylistQualityPolicy,
} from "../../shared/types.ts";

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

const SYSTEM_E2E_ACQUIRED_AT = "2026-07-30T12:00:00.000Z";
const SYSTEM_E2E_FRESH_UNTIL = "2026-08-29T12:00:00.000Z";
const SYSTEM_E2E_ROLLOUT_EVIDENCE_HASH = "a".repeat(64);
const SYSTEM_E2E_ROLLBACK_WARRANT_HASH = "f".repeat(64);
const SYSTEM_E2E_INTENT_CANARY_HASH = "e".repeat(64);
const SYSTEM_E2E_ROLLOUT_STAGE = "editorial_influence:0->100";
const SYSTEM_E2E_ROLLOUT_GROUPS = Object.keys(
  PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
) as PublicRolloutIntentGroup[];
const SYSTEM_E2E_FIXTURE_STRATEGY: RetrievalStrategyDefinitionV3 = Object.freeze({
  id: "curated_genre_scene:system_e2e",
  engine: "curated_genre_scene",
  kind: "trusted_containers",
  tier: 1,
  maximumRounds: 1,
  maximumBatchSize: 250,
  zeroQualifiedYieldLimit: 2,
  discoveryDependencyIds: Object.freeze(["apple_catalog"] as const),
  qualificationDependencyIds: Object.freeze(["apple_catalog"] as const),
});

function systemE2ePublicRolloutConfiguration(): PublicRolloutConfiguration {
  return {
    PIPELINE_V2_OWNER_CANARY: "false",
    PIPELINE_V2_CURATED_PERCENT: "100",
    PIPELINE_V2_SIMILARITY_PERCENT: "0",
    PIPELINE_V2_FACTUAL_OWNER_CANARY: "false",
    PIPELINE_V2_FACTUAL_PERCENT: "0",
    PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
    PIPELINE_V3_OWNER_CANARY: "true",
    PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_OWNER_CANARY_GROUPS: SYSTEM_E2E_ROLLOUT_GROUPS.join(","),
    PIPELINE_V3_OWNER_CANARY_MAX_TRACKS: "300",
    PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT: "100",
    PIPELINE_V3_GENRE_SCENE_PERCENT: "100",
    PIPELINE_V3_MOOD_ACTIVITY_PERCENT: "100",
    PIPELINE_V3_SIMILARITY_PERCENT: "100",
    PIPELINE_V3_ARTIST_CATALOGUE_PERCENT: "100",
    PIPELINE_V3_FIXED_CONTAINER_PERCENT: "100",
    PIPELINE_V3_FACTUAL_PERCENT: "100",
    PIPELINE_V3_EXHAUSTIVE_PERCENT: "100",
    PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED: "true",
    RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
    RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
    RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
    RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION: "1",
    PIPELINE_V3_PROOF_ARCHITECTURE_MODE: "native",
    PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "6",
    GUIDANCE_CONTRACT_V3_ENABLED: "false",
    GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
    GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "false",
  };
}

function fixtureEvidenceKind(
  grade: CanonicalPlaylistContractEvidenceGradeV1,
): string {
  if (grade === "trusted_scoped_container") return "trusted_scoped_container";
  if (grade === "primary_source") return "primary_source";
  if (grade === "independent_secondary_source") {
    return "independent_secondary_source";
  }
  if (grade === "authoritative_structured_metadata") {
    return "authoritative_structured_metadata";
  }
  return "hosted_web_track";
}

function fixtureExternalGrade(
  clause: CanonicalPlaylistContractClauseV1,
): CanonicalPlaylistContractEvidenceGradeV1 {
  const preference: CanonicalPlaylistContractEvidenceGradeV1[] = [
    "track_specific_editorial_assertion",
    "trusted_scoped_container",
    "primary_source",
    "independent_secondary_source",
    "authoritative_structured_metadata",
  ];
  return preference.find((grade) => clause.evidence.permittedGrades.includes(grade))
    ?? clause.evidence.permittedGrades[0]!;
}

function fixtureTrack(
  prefix: string,
  index: number,
  predicateIds: readonly string[],
  canonicalPolicy?: CanonicalPlaylistContractExecutionPolicyV1 | null,
  qualityPolicy?: CanonicalPlaylistQualityPolicy | null,
): QualifiedTrackV3 {
  const ordinal = String(index + 1).padStart(3, "0");
  const url = `https://example.test/system-e2e/${prefix}/${ordinal}`;
  const artist = `${prefix} Artist ${ordinal}`;
  const title = `${prefix} Track ${ordinal}`;
  const album = `${prefix} Album ${ordinal}`;
  const appleSongId = `${prefix}-apple-${ordinal}`;
  const recordingFamilyKey = `${prefix}:family:${ordinal}`;
  const canonicalClauseAssessments = canonicalPolicy
    ? Object.fromEntries(canonicalPolicy.clauses.map((clause) => {
        const structuredPositive = clause.operator === "require"
          && [
            "storefront_availability",
            "recording_version",
            "era",
          ].includes(clause.axis)
          && clause.evidence.permittedGrades.includes(
            "authoritative_structured_metadata",
          );
        if (structuredPositive) {
          return [clause.id, {
            status: "pass",
            evidenceGrade: "authoritative_structured_metadata",
            evidenceIds: [],
          }];
        }
        const grade = fixtureExternalGrade(clause);
        return [clause.id, {
          status: clause.operator === "exclude" ? "fail" : "pass",
          evidenceGrade: grade,
          evidenceIds: [`${prefix}:binding:${ordinal}:${clause.id}`],
        }];
      }))
    : undefined;
  const evidenceClauses = canonicalPolicy?.clauses.filter((clause) => (
    clause.axis !== "evidence"
    &&
    canonicalClauseAssessments?.[clause.id]?.evidenceIds?.length
  )) ?? [];
  const primaryFactualClause = evidenceClauses[0];
  if (canonicalPolicy && canonicalClauseAssessments && primaryFactualClause) {
    for (const clause of canonicalPolicy.clauses) {
      if (clause.axis !== "evidence") continue;
      canonicalClauseAssessments[clause.id] = {
        status: "pass",
        evidenceGrade:
          canonicalClauseAssessments[primaryFactualClause.id]!.evidenceGrade,
        evidenceIds:
          canonicalClauseAssessments[primaryFactualClause.id]!.evidenceIds,
      };
    }
  }
  const legacyBindingClauseIds = canonicalPolicy ? [] : [...predicateIds];
  const bindingClauses = canonicalPolicy
    ? evidenceClauses.map((clause) => ({
        id: clause.id,
        grade: canonicalClauseAssessments![clause.id]!.evidenceGrade!,
      }))
    : [{
        id: "legacy",
        grade:
          "track_specific_editorial_assertion" as CanonicalPlaylistContractEvidenceGradeV1,
      }];
  const evidenceBindings = bindingClauses.map(({ id, grade }, bindingIndex) => {
    const obligationIds = canonicalPolicy ? [id] : legacyBindingClauseIds;
    const bindingId = canonicalPolicy
      ? `${prefix}:binding:${ordinal}:${id}`
      : `${prefix}:binding:${ordinal}`;
    const excerpt = `${artist} — ${title} satisfies ${obligationIds.join(", ")}.`;
    const hostedEvidenceSnapshot = createHostedWebEvidenceSnapshotV3({
      sourceUrl: `${url}/${bindingIndex}`,
      excerpt,
      responseId: `resp_${prefix}_${ordinal}_${bindingIndex}`,
      outputItemId: `msg_${prefix}_${ordinal}_${bindingIndex}`,
      contentIndex: bindingIndex,
      citationStartIndex: Math.max(0, excerpt.length - 1),
      citationEndIndex: excerpt.length,
      excerptStartIndex: 0,
      excerptEndIndex: excerpt.length,
      acquiredAt: SYSTEM_E2E_ACQUIRED_AT,
      storefront: "us",
      freshnessExpiresAt: SYSTEM_E2E_FRESH_UNTIL,
      predicateIds: obligationIds,
      obligationIds,
    });
    return {
      id: bindingId,
      url: hostedEvidenceSnapshot.sourceUrl,
      provenanceRoot: `example.test:${prefix}:${bindingIndex}`,
      strength: 0.99,
      sourceRank: index + bindingIndex + 1,
      kind: fixtureEvidenceKind(grade),
      predicateIds: obligationIds,
      governance: {
        policyVersion: "evidence-source-governance-v3" as const,
        useScope: "run_local" as const,
        approvalState: "approved" as const,
        accessMethod: "hosted_web_search" as const,
        licenseState: "citation_only" as const,
        licenseVersion: "system-e2e-v1",
        termsVersion: "system-e2e-v1",
        attribution: "Deterministic system E2E fixture",
        cachePolicy: "excerpt_only" as const,
        retentionPolicy: "ninety_days" as const,
        freshnessPolicy: "revalidate_30d" as const,
        freshnessExpiresAt: hostedEvidenceSnapshot.freshnessExpiresAt,
        acquiredAt: hostedEvidenceSnapshot.acquiredAt,
        revokedAt: hostedEvidenceSnapshot.revokedAt,
        sourceHash: hostedEvidenceSnapshot.snapshotHash,
        sourceRevision: hostedEvidenceSnapshot.snapshotHash,
      },
      hostedEvidenceSnapshot,
      eligibilityAttestation: publicTrackScopeAttestationV3(
        hostedEvidenceSnapshot.sourceUrl,
        hostedEvidenceSnapshot,
      ),
    };
  });
  return {
    candidateId: `${prefix}:candidate:${ordinal}`,
    title,
    artist,
    album,
    appleSongId,
    recordingFamilyKey,
    sourceObservationIds: [`${prefix}:observation:${ordinal}`],
    evidenceBindingIds: evidenceBindings.map(({ id }) => id),
    evidenceBindings,
    ...(canonicalClauseAssessments ? { canonicalClauseAssessments } : {}),
    ...(qualityPolicy ? {
      centralQualityCriterionObservations: qualityPolicy.criteria.map(
        (criterion) => createCentralQualityCriterionObservationV3({
          policy: qualityPolicy,
          criterion,
          verdict: "pass",
          sourceKind: "independent_curator_review",
          sourceId: `${prefix}:central-quality-review:${ordinal}`,
          artist,
          title,
          album,
          catalogIdentity: {
            appleSongId,
            recordingFamilyKey,
          },
        }),
      ),
    } : {}),
    evidenceStrength: 0.99,
    scopeFit: 0.99,
    independentProvenanceRoots: 1,
    versionConfidence: 0.99,
    catalogConfidence: 0.99,
    rankingSignals: {
      relevance: 1 - index / 1_000,
      ...(qualityPolicy ? { central_quality: 1 } : {}),
    },
    sourceRank: index + 1,
    cacheOrigin: "live",
    discoveryDependencyIds: ["hosted_web"],
    provenanceRoots: [`example.test:${prefix}:${ordinal}`],
  };
}

function fixtureResult(input: {
  runId: string;
  target: number;
  selectedCount: number;
  predicateIds: readonly string[];
  canonicalPolicy?: CanonicalPlaylistContractExecutionPolicyV1 | null;
  qualityPolicy?: CanonicalPlaylistQualityPolicy | null;
  kind: "exact" | "partial" | "zero";
  continuationAvailable?: boolean;
  continuationQualifiedTracks?: readonly QualifiedTrackV3[];
}): RetrievalResultV3 {
  const reserveCount = input.kind === "exact" ? Math.max(10, Math.ceil(input.target * 0.2)) : 0;
  const continuationQualifiedTracks = [
    ...(input.continuationQualifiedTracks ?? []),
  ].slice(0, input.selectedCount);
  const selected = [
    ...continuationQualifiedTracks,
    ...Array.from({
      length: Math.max(
        0,
        input.selectedCount - continuationQualifiedTracks.length,
      ),
    }, (_, index) => (
      fixtureTrack(
        input.continuationQualifiedTracks ? "continuation-exact" : input.kind,
        index,
        input.predicateIds,
        input.canonicalPolicy,
        input.qualityPolicy,
      )
    )),
  ];
  const reserve = Array.from({ length: reserveCount }, (_, index) => (
    fixtureTrack(
      input.continuationQualifiedTracks
        ? "continuation-exact-reserve"
        : `${input.kind}-reserve`,
      index,
      input.predicateIds,
      input.canonicalPolicy,
      input.qualityPolicy,
    )
  ));
  const qualifiedPool = [...selected, ...reserve];
  const candidateLeads = qualifiedPool.map((track) => {
    const rawCandidate: RawTrackCandidateV3 = {
      id: track.candidateId,
      artist: track.artist,
      title: track.title,
      album: track.album,
      sourceObservationIds: [...track.sourceObservationIds],
    };
    return {
      strategyId: SYSTEM_E2E_FIXTURE_STRATEGY.id,
      candidateKey: candidateLeadKeyV3(rawCandidate),
      artist: track.artist,
      title: track.title,
      album: track.album,
      sourceRecordIds: [...track.sourceObservationIds],
      citationHashes: [],
      predicateCoverage: [...input.predicateIds],
      rejectionCode: null,
      discoveryDependencyIds: [
        ...SYSTEM_E2E_FIXTURE_STRATEGY.discoveryDependencyIds,
      ],
      provenanceRoots: [...(track.provenanceRoots ?? [])],
      cacheOrigin: track.cacheOrigin ?? "live",
      sourceFreshUntil: track.sourceFreshUntil ?? null,
    };
  });
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
      id: SYSTEM_E2E_FIXTURE_STRATEGY.id,
      engine: SYSTEM_E2E_FIXTURE_STRATEGY.engine,
      kind: SYSTEM_E2E_FIXTURE_STRATEGY.kind,
      discoveryDependencyIds: [
        ...SYSTEM_E2E_FIXTURE_STRATEGY.discoveryDependencyIds,
      ],
      qualificationDependencyIds: [
        ...SYSTEM_E2E_FIXTURE_STRATEGY.qualificationDependencyIds,
      ],
      status: input.continuationAvailable ? "available" : "exhausted",
      rounds: 1,
      rawCandidates: qualifiedPool.length,
      newQualifiedFamilies: qualifiedPool.length,
      consecutiveZeroQualifiedYieldRounds: zero ? 1 : 0,
      providerFailures: 0,
      cursor: null,
    }],
    candidateLeads,
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

async function persistPartialFixtureObservations(
  execution: PipelineV3RetrievalExecutionInput,
  result: RetrievalResultV3,
): Promise<number> {
  if (result.outcome.status !== "partial_ready"
    && result.outcome.status !== "exact_ready") return 0;
  if (!execution.recordDiscoveryBatch || !execution.recordQualificationBatch) {
    throw new Error(
      "System partial fixture requires candidate-first persistence callbacks",
    );
  }
  const priorTracks = execution.continuation?.qualifiedTracks ?? [];
  const priorCandidateIds = new Set(
    priorTracks.map(({ candidateId }) => candidateId),
  );
  // Continuation retrieval results are cumulative, while the candidate-first
  // callbacks represent only facts observed by the current bounded pass.
  // Re-persisting authenticated source seeds would double-count the source
  // attempt and make the database/telemetry integrity comparison meaningless.
  const currentPassTracks = result.qualifiedPool.filter(
    ({ candidateId }) => !priorCandidateIds.has(candidateId),
  );
  const candidates: RawTrackCandidateV3[] = currentPassTracks.map((track) => ({
    id: track.candidateId,
    artist: track.artist,
    title: track.title,
    album: track.album,
    sourceObservationIds: [...track.sourceObservationIds],
  }));
  const discoveryRequest = {
    runId: execution.runId,
    executionMode: execution.executionMode,
    appleWriteAccess: "forbidden" as const,
    modelRoute: execution.modelRoute,
    plan: execution.plan,
    engine: SYSTEM_E2E_FIXTURE_STRATEGY.engine,
    strategy: SYSTEM_E2E_FIXTURE_STRATEGY,
    strategyRound: 1,
    cursor: null,
    requestedRawCandidateCount: candidates.length,
    alreadyDiscoveredCandidateIds: [...priorCandidateIds],
    alreadyDiscoveredTracks: priorTracks.map(({ artist, title }) => ({
      artist,
      title,
    })),
    qualifiedRecordingFamilyKeys: priorTracks.map(
      ({ recordingFamilyKey }) => recordingFamilyKey,
    ),
    qualifiedTrackSeeds: priorTracks.map((track) => ({
      artist: track.artist,
      title: track.title,
      appleSongId: track.appleSongId,
      recordingFamilyKey: track.recordingFamilyKey,
    })),
    qualityEvidenceTrackSeeds: [],
    signal: execution.signal,
  };
  await execution.recordDiscoveryBatch(discoveryRequest, {
    candidates,
    nextCursor: null,
    exhausted: true,
    costUnits: 1,
    provenance: {
      cacheOrigin: "live",
      sourceFreshUntil: null,
    },
  });
  const trackByCandidateId = new Map(
    currentPassTracks.map((track) => [track.candidateId, track]),
  );
  const qualifications: CandidateQualificationV3[] = candidates.map((candidate) => {
    const track = trackByCandidateId.get(candidate.id)!;
    return {
      candidateId: track.candidateId,
      scope: {
        passed: true,
        failedMembershipPredicateIds: [],
        fit: track.scopeFit,
      },
      hardConstraints: {
        passed: true,
        failedConstraintIds: [],
      },
      evidence: {
        passed: true,
        bindingIds: [...track.evidenceBindingIds],
        ...(track.evidenceBindings
          ? { bindings: [...track.evidenceBindings] }
          : {}),
        strength: track.evidenceStrength,
        independentProvenanceRoots: track.independentProvenanceRoots,
      },
      version: {
        compatible: true,
        confidence: track.versionConfidence,
      },
      catalog: {
        lookupAttempted: true,
        appleProviderRequestCount: 1,
        storefrontPlayable: true,
        appleSongId: track.appleSongId,
        recordingFamilyKey: track.recordingFamilyKey,
        artistName: track.artist,
        trackName: track.title,
        albumName: track.album,
        confidence: track.catalogConfidence,
        releaseYear: track.catalogReleaseYear ?? null,
        compatibleReleaseYears:
          track.catalogCompatibleReleaseYears ?? [],
        genreNames: track.catalogGenreNames ?? [],
      },
      ...(track.canonicalClauseAssessments
        ? {
            canonicalClauseAssessments:
              structuredClone(track.canonicalClauseAssessments),
          }
        : {}),
      ...(track.playlistOptimizationSignals
        ? {
            playlistOptimizationSignals:
              structuredClone(track.playlistOptimizationSignals),
          }
        : {}),
      ...(track.centralQualityCriterionObservations
        ? {
            centralQualityCriterionObservations:
              structuredClone(track.centralQualityCriterionObservations),
          }
        : {}),
      rankingSignals: { ...track.rankingSignals },
      sourceRank: track.sourceRank,
    };
  });
  await execution.recordQualificationBatch(
    {
      runId: execution.runId,
      executionMode: execution.executionMode,
      appleWriteAccess: "forbidden",
      plan: execution.plan,
      engine: SYSTEM_E2E_FIXTURE_STRATEGY.engine,
      strategy: SYSTEM_E2E_FIXTURE_STRATEGY,
      candidates,
      signal: execution.signal,
    },
    qualifications,
  );
  return candidates.length;
}

function productionShapedUnknownEvidencePort():
  PipelineV3RetrievalExecutionPort {
  const delivered = new Map<string, number>();
  return createPipelineV3RetrievalExecutionPort({
    adapters: {
      discover: async (request) => {
        const priorCount = delivered.get(request.runId) ?? 0;
        const remaining = Math.max(0, 80 - priorCount);
        if (remaining === 0) {
          return {
            candidates: [],
            nextCursor: null,
            exhausted: true,
            costUnits: 1,
          };
        }
        const batchSize = Math.min(
          remaining,
          request.requestedRawCandidateCount,
        );
        delivered.set(request.runId, priorCount + batchSize);
        return {
          candidates: Array.from(
            { length: batchSize },
            (_, offset): RawTrackCandidateV3 => {
              const index = priorCount + offset + 1;
              return {
                id: `irish-unknown-${String(index).padStart(3, "0")}`,
                artist: `Irish Fixture Artist ${index}`,
                title: `Irish Fixture Track ${index}`,
                album: `Irish Fixture Album ${index}`,
                sourceObservationIds: [
                  `irish-source-observation-${index}`,
                ],
              };
            },
          ),
          nextCursor: priorCount + batchSize < 80
            ? `irish-unknown:${priorCount + batchSize}`
            : null,
          exhausted: priorCount + batchSize >= 80,
          costUnits: 1,
          provenance: {
            cacheOrigin: "live",
            sourceFreshUntil: null,
          },
        };
      },
      qualify: async ({ candidates, plan }) => (
        candidates.filter((candidate) => (
          Number(candidate.id.slice(-3)) <= 77
        )).map((
          candidate,
        ): CandidateQualificationV3 => {
          const index = Number(candidate.id.slice(-3));
          const appleResolved = index <= 73;
          return {
            candidateId: candidate.id,
            scope: {
              passed: true,
              failedMembershipPredicateIds: [],
              fit: 1,
            },
            hardConstraints: {
              passed: true,
              failedConstraintIds: [],
            },
            evidence: {
              passed: false,
              bindingIds: [],
              bindings: [],
              strength: 0,
              independentProvenanceRoots: 0,
            },
            version: {
              compatible: appleResolved,
              confidence: appleResolved ? 0.98 : 0,
            },
            catalog: {
              lookupAttempted: true,
              appleProviderRequestCount: 1,
              storefrontPlayable: appleResolved,
              appleSongId: appleResolved
                ? `irish-apple-${String(index).padStart(3, "0")}`
                : null,
              // Recording identity is materialized for every evaluated row;
              // Apple catalog/version/storefront identity exists for 73.
              recordingFamilyKey:
                `irish-family-${String(index).padStart(3, "0")}`,
              artistName: candidate.artist,
              trackName: candidate.title,
              albumName: candidate.album,
              confidence: appleResolved ? 0.99 : 0,
            },
            canonicalClauseAssessments: Object.fromEntries(
              (plan.canonicalContractPolicy?.clauses ?? []).map(
                (clause) => {
                  if (clause.operator === "exclude") {
                    return [clause.id, { status: "fail" as const }];
                  }
                  if (
                    appleResolved
                    && [
                      "catalog_identity",
                      "recording_family",
                      "recording_version",
                      "storefront_availability",
                    ].includes(clause.axis)
                    && clause.evidence.permittedGrades.includes(
                      "authoritative_structured_metadata",
                    )
                  ) {
                    return [clause.id, {
                      status: "pass" as const,
                      evidenceGrade:
                        "authoritative_structured_metadata" as const,
                      evidenceIds: [],
                    }];
                  }
                  // The production incident had healthy musical scope and
                  // Apple identity, but no selection-grade origin/influence
                  // snapshot. Keep that missing proof as unknown.
                  return [clause.id, { status: "unknown" as const }];
                },
              ),
            ),
            rankingSignals: {},
            sourceRank: index,
          };
        })
      ),
    },
  });
}

test("stitched V3 fixtures retain attested exact track-scope evidence", () => {
  const track = fixtureTrack("exact", 0, ["genre:disco"]);
  expect(attestedEvidenceBindingsForSelectionV3(
    track.evidenceBindingIds,
    track.evidenceBindings,
  )).toHaveLength(1);
});

test("stitched V3 exact fixtures retain catalog-bound central-quality proof", () => {
  const qualityPolicy: CanonicalPlaylistQualityPolicy = {
    policyVersion: "canonical_central_quality_v1",
    clauseIds: ["quality:influential", "quality:representative"],
    criteria: ["influential", "representative"],
    minimumPassRatio: 0.8,
    maximumUnknownRatio: 0.2,
    zeroKnownFailures: true,
    signalDimension: "central_quality",
    passThreshold: 0.75,
    failThreshold: 0.4,
    signalSemantics: "ranking_only_not_factual_evidence",
  };
  const track = fixtureTrack(
    "quality-exact",
    0,
    ["geo:irish"],
    null,
    qualityPolicy,
  );

  expect(track.centralQualityCriterionObservations).toHaveLength(2);
  expect(track.centralQualityCriterionObservations).toEqual(
    expect.arrayContaining(qualityPolicy.criteria.map((criterion) => (
      expect.objectContaining({
        criterion,
        verdict: "pass",
        bindingKind: "catalog",
        catalogIdentityHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      })
    ))),
  );
  expect(evaluateCentralQualityV3({
    tracks: [track],
    policy: qualityPolicy,
  })).toMatchObject({
    passed: true,
    passCount: 1,
    failCount: 0,
    unknownCount: 0,
  });
});

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
  let deepWorker: WorkerRunner;
  let deepWorkerPromise: Promise<void>;
  let api: ChildProcess | null = null;
  let apiOutput = "";
  let originalFetch: typeof globalThis.fetch;
  const retrievalCalls = new Map<string, number>();
  const retrievalResults = new Map<string, RetrievalResultV3>();
  const candidateFirstPersistenceCounts = new Map<string, number[]>();
  const persistenceReplays = new Map<string, number>();
  const fakeAppleOrderedIds = new Map<string, readonly string[]>();

  test.beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.PIPELINE_V2_OWNER_CANARY = "false";
    process.env.PIPELINE_V2_CURATED_PERCENT = "100";
    process.env.PIPELINE_V2_SIMILARITY_PERCENT = "0";
    process.env.PIPELINE_V2_FACTUAL_OWNER_CANARY = "false";
    process.env.PIPELINE_V2_FACTUAL_PERCENT = "0";
    process.env.PIPELINE_V3_ASSIGNMENT_ENABLED = "true";
    process.env.PIPELINE_V3_OWNER_CANARY = "true";
    process.env.PIPELINE_V3_OWNER_CANARY_GROUPS =
      SYSTEM_E2E_ROLLOUT_GROUPS.join(",");
    process.env.PIPELINE_V3_OWNER_CANARY_MAX_TRACKS = "300";
    process.env.PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED = "true";
    process.env.PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED = "true";
    process.env.PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED = "true";
    process.env.PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED = "true";
    process.env.PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT = "100";
    process.env.PIPELINE_V3_GENRE_SCENE_PERCENT = "100";
    process.env.PIPELINE_V3_MOOD_ACTIVITY_PERCENT = "100";
    process.env.PIPELINE_V3_SIMILARITY_PERCENT = "100";
    process.env.PIPELINE_V3_ARTIST_CATALOGUE_PERCENT = "100";
    process.env.PIPELINE_V3_FIXED_CONTAINER_PERCENT = "100";
    process.env.PIPELINE_V3_FACTUAL_PERCENT = "100";
    process.env.PIPELINE_V3_EXHAUSTIVE_PERCENT = "100";
    process.env.PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED = "true";
    process.env.RELEASE_ENVIRONMENT = "production";
    process.env.RELEASE_DEPLOYMENT_PHASE = "activate";
    process.env.RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH =
      SYSTEM_E2E_ROLLOUT_EVIDENCE_HASH;
    process.env.RELEASE_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_HASH =
      SYSTEM_E2E_ROLLBACK_WARRANT_HASH;
    process.env.RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_HASH =
      SYSTEM_E2E_INTENT_CANARY_HASH;
    process.env.RELEASE_PUBLIC_ROLLOUT_STAGE = SYSTEM_E2E_ROLLOUT_STAGE;
    process.env.RELEASE_EXECUTION_ENABLED = "true";
    process.env.RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION = "20";
    process.env.RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION = "2";
    process.env.RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION = "1";
    process.env.RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION = "1";
    process.env.RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION = "1";
    process.env.PIPELINE_V3_PROOF_ARCHITECTURE_MODE = "native";
    process.env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION = "6";
    // Contract 3 is admitted solely by the signed public assignment below.
    // A broad fallback would let this test pass without proving the immutable
    // route receipt used by production.
    process.env.GUIDANCE_CONTRACT_V3_ENABLED = "false";
    process.env.GUIDANCE_CONTRACT_V3_OWNER_CANARY = "true";
    process.env.GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED = "false";
    process.env.GUIDANCE_V5_ENABLED = "true";
    // The stitched suite injects deterministic brief/retrieval ports, but the
    // immutable run policy still validates the exact production model route.
    // Keep these values on the same allowlisted IDs used by real V3 runs so
    // the test exercises policy creation instead of failing on fake model IDs.
    process.env.PIPELINE_V3_BASELINE_MODEL_ID = "gpt-5.6-luna";
    process.env.PIPELINE_V3_ESCALATION_MODEL_ID = "gpt-5.6-terra";
    process.env.PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT = "2026-07-20T00:00:00.000Z";
    process.env.APPLE_STOREFRONT = "us";
    process.env.OPENAI_API_KEY = "system-e2e-provider-outage";
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://api.openai.com/")) {
        return new Response(JSON.stringify({
          error: {
            message: "System E2E deterministic provider outage",
            type: "system_e2e_provider_outage",
          },
        }), {
          status: 503,
          headers: {
            "content-type": "application/json",
            "retry-after": "0",
          },
        });
      }
      return originalFetch(input, init);
    };

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
    // Schema 20 fails closed with the route-wide V3 hard switch engaged.
    // This suite is the bounded synthetic owner gate, so open that exact
    // control explicitly before submitting any browser work.
    await repository.setPipelineCohortKillSwitch({
      cohortKey: "system-e2e-owner-gate",
      route: "corpus_first_v3",
      intentGroup: null,
      disabled: false,
      changedBy: "system-e2e",
    });
    await repository.setSetting("pipeline_v3_public_assignment_paused", "false");
    const rolloutConfiguration = systemE2ePublicRolloutConfiguration();
    const rolloutConfigurationHash =
      signedArtifactSha256(rolloutConfiguration);
    const rolloutGlobalAuthority = {
      schemaVersion: "genio-public-rollout-database-authority/v1",
      evidenceHash: SYSTEM_E2E_ROLLOUT_EVIDENCE_HASH,
      rollbackWarrantHash: SYSTEM_E2E_ROLLBACK_WARRANT_HASH,
      intentCanaryHash: SYSTEM_E2E_INTENT_CANARY_HASH,
      stage: SYSTEM_E2E_ROLLOUT_STAGE,
      intentGroup: "editorial_influence",
      toPercent: "100",
      targetConfigurationHash: rolloutConfigurationHash,
      targetConfiguration: rolloutConfiguration,
    };
    await repository.setSetting(
      "public_rollout_state:global",
      JSON.stringify(rolloutGlobalAuthority),
    );
    for (const intentGroup of SYSTEM_E2E_ROLLOUT_GROUPS) {
      await repository.setSetting(
        `public_rollout_state:${intentGroup}`,
        JSON.stringify({
          ...rolloutGlobalAuthority,
          intentGroup,
          toPercent:
            rolloutConfiguration[
              PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS[intentGroup]
            ],
        }),
      );
    }
    // Run admission revalidates the exact immutable assignment against the
    // historical authority that minted it, independently of the current
    // global/intent rollout rows.
    await repository.setSetting(
      `public_rollout_authority:${SYSTEM_E2E_ROLLOUT_EVIDENCE_HASH}`,
      JSON.stringify(rolloutGlobalAuthority),
    );
    // This clean, synthetic database has no legacy manifests to backfill.
    // Enter the exact native authority state that production may reach only
    // through the separately tested receipt-bound activation transaction.
    await repository.pool.query(
      `UPDATE settings
       SET value='native',updated_at=now()
       WHERE key='proof_architecture_authority'`,
    );
    await repository.saveAppleAuthorization({
      ciphertext: "system-e2e-fake-ciphertext",
      iv: "system-e2e-fake-iv",
      authTag: "system-e2e-fake-auth-tag",
      keyVersion: "system-e2e-fake-v1",
      storefront: "us",
      status: "valid",
      lastValidatedAt: new Date(),
    });
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

    const unknownEvidencePort = productionShapedUnknownEvidencePort();
    const v3RetrievalPort: PipelineV3RetrievalExecutionPort = {
      execute: async (input) => {
        const { runId, plan } = input;
        // Make the in-progress UI observable rather than racing the
        // client's first poll against an instantaneous fixture result.
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        const rawPrompt = (await repository.pool.query<{ raw_prompt: string }>(
          "SELECT raw_prompt FROM run_specs WHERE run_id=$1",
          [runId],
        )).rows[0]?.raw_prompt ?? plan.prompt;
        const marker = rawPrompt.toLocaleLowerCase("en-US");
        const call = (retrievalCalls.get(runId) ?? 0) + 1;
        retrievalCalls.set(runId, call);
        if (marker.includes("system evidence collapse")) {
          const base = await unknownEvidencePort.execute(input);
          const result: RetrievalResultV3 = {
            ...base,
            predicateDiagnostics: {
              ...(base.predicateDiagnostics ?? {
                qualificationsObserved: 0,
                scopeFailures: 0,
                failedMembershipPredicateIds: {},
                appleLookupCount: 0,
                appleProviderRequestCount: 0,
                rootCause: "evidence_shortfall",
                recoveryAttemptCount: 0,
              }),
              // Evaluating a clause as unknown is not evidence that a
              // producer was called. The first bounded pass must therefore
              // be authorized by a real strategy delta.
              evidenceAcquisitionAttempts: [],
            },
          };
          retrievalResults.set(runId, result);
          return result;
        }
        const kind = marker.includes("system continuation") && call > 1
          ? "exact"
          : marker.includes("system partial") || marker.includes("system continuation")
          ? "partial"
          : marker.includes("system zero")
            ? "zero"
            : "exact";
        const policyValidPartialCount = plan.playlistQualityPolicy
          ? Math.max(
              1,
              Math.ceil(
                plan.requestedTrackCount
                  * plan.playlistQualityPolicy.minimumPassRatio,
              ),
              plan.requestedTrackCount - Math.floor(
                plan.requestedTrackCount
                  * plan.playlistQualityPolicy.maximumUnknownRatio,
              ),
            )
          : Math.max(
              1,
              Math.ceil(plan.requestedTrackCount * 0.8),
            );
        const selectedCount = kind === "exact"
          ? plan.requestedTrackCount
          : kind === "partial"
            ? policyValidPartialCount
            : 0;
        const result = fixtureResult({
          runId,
          target: plan.requestedTrackCount,
          selectedCount,
          predicateIds: plan.membershipPredicates
            .filter((predicate: { operator: string }) => predicate.operator !== "exclude")
            .map((predicate: { id: string }) => predicate.id),
          canonicalPolicy: plan.canonicalContractPolicy,
          qualityPolicy: plan.playlistQualityPolicy,
          kind,
          continuationAvailable: marker.includes("system continuation") && call === 1,
          ...(marker.includes("system continuation")
              && call > 1
              && input.continuation
            ? {
                continuationQualifiedTracks:
                  input.continuation.qualifiedTracks,
              }
            : {}),
        });
        const persistedCandidateCount = await persistPartialFixtureObservations(
          input,
          result,
        );
        candidateFirstPersistenceCounts.set(runId, [
          ...(candidateFirstPersistenceCounts.get(runId) ?? []),
          persistedCandidateCount,
        ]);
        retrievalResults.set(runId, result);
        return result;
      },
    };
    const baseHandlers = defaultJobHandlers(repository, { v3RetrievalPort });
    const replayResearchHandler: NonNullable<(typeof baseHandlers)["research"]> =
      async (payload, signal) => {
        await baseHandlers.research!(payload, signal);
        const runId = String(payload.runId ?? "");
        const result = retrievalResults.get(runId);
        const queryPlan = await repository.getActiveQueryPlan(runId);
        if (!result || !queryPlan) {
          const run = await repository.getRun(runId);
          const failedCheckpoint = await repository.getResearchCheckpoint(
            runId,
            String(payload.__jobStageKey ?? ""),
          );
          throw new Error(
            `System E2E replay could not reload its immutable result `
              + `(result=${Boolean(result)},queryPlan=${Boolean(queryPlan)},`
              + `status=${run?.status ?? "missing"},phase=${run?.phase ?? "missing"},`
              + `reason=${String(
                (failedCheckpoint as Record<string, unknown> | null)?.reason
                  ?? "missing",
              )})`,
          );
        }
        if (result.outcome.status !== "exact_ready") return;
        await repository.persistPipelineV3RetrievalResult({
          runId,
          queryPlan,
          plan: selectionPlanFromQueryPlanV3(queryPlan, {}),
          result,
          fence: {
            jobId: String(payload.__jobId ?? ""),
            workerId: String(payload.__jobWorkerId ?? ""),
            leaseEpoch: Number(payload.__jobLeaseEpoch),
            queryPlanRevisionId: String(payload.__queryPlanRevisionId ?? ""),
            stageKey: String(payload.__jobStageKey ?? ""),
            contractAttemptId: String(payload.__contractAttemptId ?? ""),
            contractRevisionDatabaseId: String(
              payload.__contractRevisionDatabaseId ?? "",
            ),
            contractRevisionId: String(payload.__contractRevisionId ?? ""),
            contractSemanticHash: String(payload.__contractSemanticHash ?? ""),
          },
        });
        persistenceReplays.set(
          runId,
          (persistenceReplays.get(runId) ?? 0) + 1,
        );
      };
    worker = new WorkerRunner(repository, {
      workerId: `system-e2e-${randomUUID()}`,
      concurrency: 2,
      pollMs: 20,
      heartbeatMs: 300_000,
      controlIntervalMs: 300_000,
      v3RetrievalPort,
      handlers: {
        research: replayResearchHandler,
        publication: async (payload) => {
          const manifestId = String(payload.manifestId ?? "");
          const manifest = await repository.getManifestById(manifestId);
          if (!manifest?.revisionId
            || !manifest.contractRevisionId
            || !manifest.contractHash) {
            throw new Error("System E2E publication manifest is not canonical");
          }
          const executionFence = {
            executionAttemptId: String(payload.__contractAttemptId ?? ""),
            jobId: String(payload.__jobId ?? ""),
            workerId: String(payload.__jobWorkerId ?? ""),
            leaseGeneration: Number(payload.__jobLeaseEpoch),
            stageKey: String(payload.__jobStageKey ?? ""),
          };
          const expectedOrderedIdsHash = orderedAppleStableIdsHash(
            manifest.tracks.map(
              ({ catalogId }: { catalogId: string }) => catalogId,
            ),
          );
          const authority = {
            ...executionFence,
            runId: manifest.runId,
            contractRevisionId: manifest.contractRevisionId,
            contractHash: manifest.contractHash,
            manifestId,
            manifestRevisionId: manifest.revisionId,
            manifestRevisionHash: manifest.contentHash,
            expectedOrderedIdsHash,
            expectedCount: manifest.tracks.length,
            idempotencyKey:
              `publish:${manifestId}:${manifest.revisionId}:${manifest.contentHash}`,
          };
          await repository.beginPublicationReconciliation(authority);
          await repository.updateCanonicalPublicationRun(authority, {
            status: "publishing",
            phase: "apple_publication",
          });
          const volume = await repository.createPublicationVolume({
            manifestId,
            manifestRevisionId: manifest.revisionId,
            volumeNumber: 1,
            volumeCount: 1,
            startPosition: 0,
            endPosition: manifest.tracks.length - 1,
            status: "queued",
            publicationAuthority: authority,
          });
          const applePlaylistId = `system-e2e-${manifest.id}`;
          fakeAppleOrderedIds.set(
            applePlaylistId,
            manifest.tracks.map(
              ({ catalogId }: { catalogId: string }) => catalogId,
            ),
          );
          await repository.advancePublicationReconciliation({
            ...authority,
            state: "append_pending",
            applePlaylistId,
            appendedCount: manifest.tracks.length,
            batchCursor: manifest.tracks.length,
          });
          await repository.updatePublicationVolume(volume.id, {
            status: "complete",
            applePlaylistId,
            appleShareUrl:
              `https://music.apple.com/us/playlist/system-e2e/pl.${manifest.id}`,
            appendedCount: manifest.tracks.length,
            publishedAt: new Date(),
          }, authority);
          const observedOrderedIds = fakeAppleOrderedIds.get(applePlaylistId);
          if (!observedOrderedIds) {
            throw new Error("System E2E Apple readback is missing");
          }
          const observedOrderedIdsHash = orderedAppleStableIdsHash(
            observedOrderedIds,
          );
          await repository.advancePublicationReconciliation({
            ...authority,
            state: "reconciling",
            applePlaylistId,
            observedOrderedIdsHash,
            appendedCount: manifest.tracks.length,
            batchCursor: manifest.tracks.length,
            detail: {
              exactMembershipVerified:
                observedOrderedIdsHash === expectedOrderedIdsHash,
            },
          });
          const terminalStatus = publicationTerminalStatus(
            await repository.getPublicationCompleteness(
              manifest.runId,
              manifestId,
            ),
          );
          await repository.commitPublicationCompletion({
            runId: manifest.runId,
            manifestId,
            manifestRevisionId: manifest.revisionId,
            manifestRevisionHash: manifest.contentHash,
            contractRevisionId: manifest.contractRevisionId,
            contractHash: manifest.contractHash,
            executionFence,
            selectedCount: manifest.tracks.length,
            terminalStatus,
            publicationVolumes: [{
              publicationVolumeId: volume.id,
              attempt: Number(volume.attempt ?? 0),
              applePlaylistId,
              appendedCount: manifest.tracks.length,
              startPosition: 0,
              endPosition: manifest.tracks.length - 1,
            }],
            pipelineOutcome: null,
          });
        },
      },
    });
    deepWorker = new WorkerRunner(repository, {
      workerId: `system-e2e-deep-${randomUUID()}`,
      queueClass: "deep",
      concurrency: 2,
      pollMs: 20,
      heartbeatMs: 300_000,
      controlIntervalMs: 300_000,
      v3RetrievalPort,
      handlers: {
        research: replayResearchHandler,
      },
    });
    workerPromise = worker.run();
    deepWorkerPromise = deepWorker.run();

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
    if (originalFetch) globalThis.fetch = originalFetch;
    await stopChild(api);
    if (worker) await worker.stop("Pipeline V3 system E2E complete");
    if (deepWorker) await deepWorker.stop("Pipeline V3 system E2E complete");
    if (workerPromise) await workerPromise.catch(() => undefined);
    if (deepWorkerPromise) await deepWorkerPromise.catch(() => undefined);
    if (repository) await repository.close();
    if (adminPool) {
      if (process.env.GENIO_SYSTEM_E2E_KEEP_SCHEMA === "1") {
        process.stderr.write(`[genio-system-e2e] retained schema ${schemaName}\n`);
      } else {
        await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      }
      await adminPool.end();
    }
  });

  async function submit(page: import("@playwright/test").Page, prompt: string, count = 25): Promise<void> {
    await page.goto("/");
    await page.getByRole("textbox", { name: "PLAYLIST REQUEST" }).fill(prompt);
    if (count !== 50) await page.getByRole("button", { name: `${count} tracks` }).click();
    await page.getByRole("button", { name: new RegExp(`create playlist · ${count} tracks`, "iu") }).click();
    // This is deliberately a real Guidance V5.1 checkpoint, not a test-only
    // shortcut. Every accepted request answers a server-owned executable
    // question before research begins.
    let answeredQuestionCount = 0;
    for (let checkpoint = 0; checkpoint < 3; checkpoint += 1) {
      const state = await page.waitForFunction(() => {
        if (
          new URLSearchParams(window.location.search).has("run")
          && document.querySelector("[data-testid='working-indicator']")
        ) {
          return "working";
        }
        if (document.querySelector("[data-testid='guidance-confirmation-summary']")) {
          return "confirmation";
        }
        if (document.querySelector("[role='progressbar'][aria-label='Playlist preferences']")) {
          return "question";
        }
        return null;
      }, undefined, { timeout: 90_000 }).then((handle) => handle.jsonValue());
      if (state === "working") {
        if (answeredQuestionCount === 0) {
          throw new Error(
            `Curated system brief entered execution without a Guidance V5.1 multiple-choice question: ${prompt}`,
          );
        }
        await expect.poll(async () => (
          await repository.pool.query<{ persisted: boolean }>(
            `SELECT EXISTS(
               SELECT 1
               FROM brief_requests brief
               JOIN guidance_question_sets questions
                 ON questions.brief_request_id=brief.id
               JOIN guidance_answer_sets answers
                 ON answers.question_set_id=questions.id
                AND answers.brief_request_id=brief.id
               WHERE brief.prompt=$1
                 AND questions.guidance_policy_version='adaptive_guidance_v5'
                 AND jsonb_array_length(questions.questions_json)>=1
             ) persisted`,
            [prompt],
          )
        ).rows[0]?.persisted).toBe(true);
        return;
      }
      if (state === "confirmation") {
        if (answeredQuestionCount === 0) {
          throw new Error(
            `Curated system brief received a questionless confirmation checkpoint: ${prompt}`,
          );
        }
        await page.getByRole("button", { name: /create this playlist/i }).click();
        continue;
      }
      const recommended = page.locator("label.guided-option-card")
        .filter({ hasText: "RECOMMENDED" })
        .first();
      const balancedDefault = page.locator("label.guided-option-card")
        .filter({ hasText: "USE THE BALANCED DEFAULT" })
        .first();
      if (await recommended.isVisible()) await recommended.click();
      else if (await balancedDefault.isVisible()) await balancedDefault.click();
      else await page.locator("label.guided-option-card").first().click();
      answeredQuestionCount += 1;
      await page.getByRole("button", { name: /create playlist|next/i }).click();
    }
    throw new Error(`System E2E exceeded its bounded guidance checkpoints for: ${prompt}`);
  }

  async function systemDiagnostics(prompt: string): Promise<string> {
    const [
      briefs,
      runs,
      jobs,
      workers,
      controls,
      checkpoints,
      blockers,
    ] = await Promise.all([
      repository.pool.query(
        `SELECT id,status,error,prompt,created_at,updated_at
         FROM brief_requests WHERE prompt=$1 ORDER BY created_at DESC LIMIT 3`,
        [prompt],
      ),
      repository.pool.query(
        `SELECT run.id,run.status,run.phase,run.error,spec.raw_prompt,
                run.pipeline_version,run.created_at,run.updated_at,
                query.plan_json->>'schemaVersion' query_plan_schema,
                query.plan_json->'engines' query_plan_engines,
                query.plan_json->>'executorCapabilityHash' executor_capability_hash
         FROM research_runs run
         JOIN run_specs spec ON spec.run_id=run.id
         LEFT JOIN run_active_query_plans active ON active.run_id=run.id
         LEFT JOIN query_plan_revisions query ON query.id=active.query_plan_revision_id
         WHERE spec.raw_prompt=$1 ORDER BY run.created_at DESC LIMIT 3`,
        [prompt],
      ),
      repository.pool.query(
        `SELECT kind,status,attempts,last_error,run_id,queue_class,
                available_at,minimum_worker_protocol,
                required_executor_capability_hash,
                required_executor_revision,
                required_executor_semantic_configuration_hash,
                created_at,updated_at
         FROM job_queue ORDER BY created_at DESC LIMIT 8`,
      ),
      repository.pool.query(
        `SELECT worker_id,metadata_json,last_seen_at
         FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 4`,
      ),
      repository.pool.query(
        `SELECT key,value FROM settings
         WHERE key IN ('research_paused','publishing_paused')
         UNION ALL
         SELECT 'hard_switch:' || route || ':' || COALESCE(intent_group,'*'),
                disabled::text
         FROM pipeline_cohort_kill_switches
         ORDER BY 1`,
      ),
      repository.pool.query(
        `SELECT checkpoint.phase,checkpoint.state_json,
                checkpoint.updated_at
         FROM research_checkpoints checkpoint
         JOIN run_specs spec ON spec.run_id=checkpoint.run_id
         WHERE spec.raw_prompt=$1
         ORDER BY checkpoint.updated_at DESC,checkpoint.phase`,
        [prompt],
      ),
      repository.pool.query(
        `SELECT blocker.blocker_kind,blocker.dependency_key,
                blocker.state_json,blocker.created_at,blocker.resolved_at
         FROM playlist_run_blockers blocker
         JOIN run_specs spec ON spec.run_id=blocker.run_id
         WHERE spec.raw_prompt=$1
         ORDER BY blocker.created_at DESC`,
        [prompt],
      ),
    ]);
    return JSON.stringify({
      apiOutput,
      briefs: briefs.rows,
      runs: runs.rows,
      jobs: jobs.rows,
      workers: workers.rows,
      controls: controls.rows,
      checkpoints: checkpoints.rows,
      blockers: blockers.rows,
    }, null, 2);
  }

  async function expectWorkingScreen(
    page: import("@playwright/test").Page,
    prompt: string,
  ): Promise<void> {
    try {
      await expect(page.getByTestId("working-indicator"))
        .toBeVisible({ timeout: 90_000 });
    } catch (error) {
      const alert = await page.getByRole("alert").allTextContents().catch(() => [] as string[]);
      throw new Error(
        `Pipeline V3 system flow did not reach the working screen. Alerts: ${alert.join(" | ")}\n${await systemDiagnostics(prompt)}`,
        { cause: error },
      );
    }
  }

  test("Irish influence uses a real V5.1 question and delivers its typed effect to the worker", async ({
    page,
  }) => {
    const prompt = "Infuential irish music";
    await page.goto("/");
    await page.getByRole("textbox", { name: "PLAYLIST REQUEST" }).fill(prompt);
    await page.getByRole("button", { name: "25 tracks" }).click();
    await page.getByRole(
      "button",
      { name: /create playlist · 25 tracks/iu },
    ).click();

    await expect(page.getByRole("heading", {
      name: "Which kind of influence should lead the playlist?",
      exact: true,
    })).toBeVisible({ timeout: 90_000 });
    await expect(page.locator("label.guided-option-card")).toHaveCount(4);
    const balanced = page.locator("label.guided-option-card")
      .filter({ hasText: "Balanced" })
      .first();
    await expect(balanced).toContainText("RECOMMENDED");
    await expect(balanced).toContainText(
      "Why recommended: The original wording leaves Irish cultural impact versus global influence open, so a balanced emphasis preserves both readings.",
    );
    await balanced.click();
    await page.getByRole("button", { name: /create playlist/i }).click();
    await expectWorkingScreen(page, prompt);

    try {
      await expect.poll(async () => (
        await repository.pool.query<{
        run_id: string;
        guidance_policy_version: string;
        question_count: number;
        selected_option_id: string;
        execution_delta_hash: string;
        contract_json: PlaylistContractRevisionV1;
        query_plan_hash: string;
        query_plan_json: {
          guidancePolicyVersion?: string;
          rankingObjectives?: Array<{
            kind?: string;
            values?: string[];
          }>;
        };
        public_rollout_assignment: {
          intentGroup?: string;
          percentage?: number;
          assigned?: boolean;
          assignmentHash?: string;
        };
        assignment_receipt_matches: boolean;
        route_receipt: {
          guidanceVersion?: string;
          contractVersion?: number;
          executionRoute?: string;
          queryPlanHash?: string;
          assignmentAuthority?: {
            kind?: string;
            receiptHash?: string;
            intentGroup?: string;
            assignmentReason?: string;
          };
        };
        worker_consumption: {
          schemaVersion?: string;
          kind?: string;
          status?: string;
          selectedOptionId?: string;
          axis?: string;
          queryPlanHash?: string;
          contractSemanticHash?: string;
          executionField?: string;
          effectHash?: string;
          consumerId?: string;
          receiptHash?: string;
        };
      }>(
        `SELECT spec.run_id,
                questions.guidance_policy_version,
                jsonb_array_length(questions.questions_json) question_count,
                answers.normalized_answers_json->0->>'optionId'
                  selected_option_id,
                answers.execution_delta_hash,
                contract.contract_json,
                query.plan_hash query_plan_hash,
                query.plan_json query_plan_json,
                brief.public_rollout_assignment_json
                  public_rollout_assignment,
                (
                  route.state_json->'assignmentAuthority'->>'receiptHash'
                  =brief.public_rollout_assignment_json->>'assignmentHash'
                ) assignment_receipt_matches,
                route.state_json route_receipt,
                consumption.state_json worker_consumption
         FROM run_specs spec
         JOIN research_runs run ON run.id=spec.run_id
         JOIN run_accesses access ON access.run_id=run.id
         JOIN brief_requests brief ON brief.id=access.brief_request_id
         JOIN guidance_question_sets questions
           ON questions.brief_request_id=access.brief_request_id
         JOIN guidance_answer_sets answers
           ON answers.question_set_id=questions.id
         JOIN playlist_contract_revisions contract
           ON contract.id=run.active_playlist_contract_revision_id
         JOIN run_active_query_plans active ON active.run_id=run.id
         JOIN query_plan_revisions query
           ON query.id=active.query_plan_revision_id
         JOIN research_checkpoints route
           ON route.run_id=run.id AND route.phase='execution_route_receipt_v1'
         JOIN research_checkpoints consumption
           ON consumption.run_id=run.id
          AND consumption.phase=
            'v3:guidance:v5:worker-consumption:' || left(query.plan_hash,46)
         WHERE spec.raw_prompt=$1
         ORDER BY questions.created_at DESC
         LIMIT 1`,
          [prompt],
        )
      ).rows[0], {
        message: "Irish guidance answer, successor plan, and route receipt should converge",
        timeout: 90_000,
      }).toMatchObject({
        guidance_policy_version: "adaptive_guidance_v5",
        question_count: 1,
        selected_option_id: "balanced_influence",
        execution_delta_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        query_plan_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        assignment_receipt_matches: true,
        public_rollout_assignment: {
          intentGroup: "editorial_influence",
          percentage: 100,
          assigned: true,
          assignmentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        query_plan_json: {
          guidancePolicyVersion: "adaptive_guidance_v5",
          rankingObjectives: expect.arrayContaining([
            expect.objectContaining({
              kind: "influence",
              values: expect.arrayContaining([
                expect.stringMatching(
                  /balance Irish cultural impact with global influence/iu,
                ),
              ]),
            }),
          ]),
        },
        route_receipt: {
          guidanceVersion: "adaptive_guidance_v5",
          contractVersion: 3,
          executionRoute: "corpus_first_v3",
          queryPlanHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          assignmentAuthority: {
            kind: "signed_public_rollout",
            receiptHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
            intentGroup: "editorial_influence",
            assignmentReason: "sticky_rollout",
          },
        },
        worker_consumption: {
          schemaVersion: "genio-guidance-v5-worker-consumption/v1",
          kind: "worker_consumption",
          status: "consumed",
          selectedOptionId: "balanced_influence",
          axis: "influence_scope",
          queryPlanHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          contractSemanticHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          executionField: "rankingObjectives",
          effectHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          consumerId:
            "pipeline_v3_live_adapters:hostedDiscoveryRankingObjectivesV5",
          receiptHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      });
    } catch (error) {
      throw new Error(
        `Irish system flow did not persist its guidance/route contract.\n${await systemDiagnostics(prompt)}`,
        { cause: error },
      );
    }

    await expect.poll(async () => (
      await repository.pool.query<{
        requested_track_count: number;
        status: string;
        contract_json: PlaylistContractRevisionV1;
        reconciled_count: number;
        central_quality_pass_track_count: number;
      }>(
        `SELECT spec.requested_track_count,run.status,
                contract.contract_json,
                reconciliation.appended_count reconciled_count,
                (
                  SELECT count(
                    DISTINCT item.selection_qualification_id
                  )::int
                  FROM immutable_selection_set_items item
                  JOIN immutable_selection_qualifications selection_quality
                    ON selection_quality.id=item.selection_qualification_id
                  JOIN playlist_qualification_records persisted_quality
                    ON persisted_quality.run_id=run.id
                   AND persisted_quality.contract_revision_id=
                     selection_quality.contract_revision_id
                   AND persisted_quality.candidate_id=
                     selection_quality.candidate_id
                   AND persisted_quality.decision='qualified'
                   AND persisted_quality.revoked_at IS NULL
                  WHERE item.selection_set_id=selection_set.id
                    AND item.role='selected'
                    AND jsonb_array_length(
                      COALESCE(
                        persisted_quality.quality_result_json
                          ->'centralQualityCriterionObservations',
                        '[]'::jsonb
                      )
                    )=jsonb_array_length(
                      query.plan_json->'playlistQualityPolicy'->'criteria'
                    )
                    AND NOT EXISTS (
                      SELECT 1
                      FROM jsonb_array_elements(
                        persisted_quality.quality_result_json
                          ->'centralQualityCriterionObservations'
                      ) observation
                      WHERE observation->>'verdict'<>'pass'
                         OR observation->>'bindingKind'<>'catalog'
                         OR COALESCE(
                           observation->>'catalogIdentityHash',
                           ''
                         ) !~ '^[0-9a-f]{64}$'
                    )
                ) central_quality_pass_track_count
         FROM run_specs spec
         JOIN research_runs run ON run.id=spec.run_id
         JOIN playlist_contract_revisions contract
           ON contract.id=run.active_playlist_contract_revision_id
         JOIN run_active_query_plans active ON active.run_id=run.id
         JOIN query_plan_revisions query
           ON query.id=active.query_plan_revision_id
         JOIN manifests manifest ON manifest.run_id=run.id
         JOIN manifest_revisions revision
           ON revision.manifest_id=manifest.id
          AND revision.status='published'
         JOIN immutable_selection_sets selection_set
           ON selection_set.id=revision.selection_set_id
         JOIN playlist_publication_reconciliations reconciliation
           ON reconciliation.manifest_id=manifest.id
          AND reconciliation.state='complete'
         WHERE spec.raw_prompt=$1`,
        [prompt],
      )
    ).rows[0], {
      message: "Irish guidance successor should publish exactly 25 reconciled tracks",
      timeout: 90_000,
    }).toMatchObject({
      requested_track_count: 25,
      status: "complete",
      reconciled_count: 25,
      central_quality_pass_track_count: 25,
      contract_json: expect.objectContaining({
        requestedTrackCount: 25,
        clauses: expect.arrayContaining([
          expect.objectContaining({
            hardness: "hard",
            axis: "geography",
            operator: "require",
            values: expect.arrayContaining(["Irish"]),
          }),
          expect.objectContaining({
            id: "guidance:v5:influence-scope:balanced_influence",
            hardness: "soft",
            axis: "influence",
          }),
        ]),
      }),
    });
  });

  test("exact flow preserves the immutable count and locks a complete manifest", async ({ page }) => {
    const prompt = "System exact disco music";
    await submit(page, prompt, 50);
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
        manifest_revision_count: number;
        reconciliation_state: string;
        reconciliation_appended_count: number;
        reconciliation_expected_hash: string;
        reconciliation_observed_hash: string;
        proof_kind: string;
        selection_set_id: string;
        attestation_set_hash: string;
        proof_mode: string;
        selection_set_requested_count: number;
        selection_set_selected_count: number;
        selected_item_count: number;
        immutable_qualification_count: number;
        attempt_output_attestation_count: number;
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
                      ORDER BY track.position) track_ids,
                (SELECT count(*)::int FROM manifest_revisions all_revision
                 WHERE all_revision.manifest_id=manifest.id) manifest_revision_count,
                reconciliation.state reconciliation_state,
                reconciliation.appended_count reconciliation_appended_count,
                reconciliation.expected_ordered_ids_hash reconciliation_expected_hash,
                reconciliation.observed_ordered_ids_hash reconciliation_observed_hash,
                revision.proof_kind,
                revision.selection_set_id,
                revision.attestation_set_hash,
                selection_set.proof_mode,
                selection_set.requested_count selection_set_requested_count,
                selection_set.selected_count selection_set_selected_count,
                (SELECT count(*)::int
                 FROM immutable_selection_set_items item
                 WHERE item.selection_set_id=selection_set.id
                   AND item.role='selected') selected_item_count,
                (SELECT count(*)::int
                 FROM immutable_selection_set_items item
                 JOIN immutable_selection_qualifications qualification
                   ON qualification.id=item.selection_qualification_id
                 WHERE item.selection_set_id=selection_set.id
                   AND item.role='selected'
                   AND qualification.run_id=run.id
                   AND qualification.decision='qualified')
                  immutable_qualification_count,
                (SELECT count(*)::int
                 FROM selection_attempt_output_attestations output
                 WHERE output.selection_set_id=selection_set.id
                   AND output.output_hash=selection_set.output_hash
                   AND output.attestation_set_hash=
                     selection_set.attestation_set_hash)
                  attempt_output_attestation_count
         FROM run_specs spec
         JOIN research_runs run ON run.id=spec.run_id
         JOIN query_plan_revisions query ON query.run_id=spec.run_id AND query.status='active'
         JOIN manifests manifest ON manifest.run_id=spec.run_id
         JOIN manifest_revisions revision ON revision.manifest_id=manifest.id
           AND revision.status='published'
         JOIN immutable_selection_sets selection_set
           ON selection_set.id=revision.selection_set_id
          AND selection_set.attestation_set_hash=revision.attestation_set_hash
         JOIN playlist_publication_reconciliations reconciliation
           ON reconciliation.manifest_id=manifest.id
          AND reconciliation.manifest_revision_id=revision.id
         WHERE spec.raw_prompt=$1`,
        [prompt],
      )
    ).rows[0]).toMatchObject({
      requested_track_count: 50,
      target_track_count: 50,
      track_count: 50,
      status: "complete",
      pipeline_version: "corpus_first_v3",
      query_plan_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      selection_plan_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      manifest_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      track_ids: Array.from({ length: 50 }, (_, index) => `exact-apple-${String(index + 1).padStart(3, "0")}`),
      manifest_revision_count: 1,
      reconciliation_state: "complete",
      reconciliation_appended_count: 50,
      reconciliation_expected_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      reconciliation_observed_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      proof_kind: "native",
      selection_set_id: expect.any(String),
      attestation_set_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      proof_mode: "native",
      selection_set_requested_count: 50,
      selection_set_selected_count: 50,
      selected_item_count: 50,
      immutable_qualification_count: 50,
      attempt_output_attestation_count: 1,
    });
    const runId = (await repository.pool.query<{ run_id: string }>(
      "SELECT run_id FROM run_specs WHERE raw_prompt=$1",
      [prompt],
    )).rows[0]!.run_id;
    expect(persistenceReplays.get(runId)).toBe(1);
    await expect(page.getByRole("heading", { name: "Playlist published" }))
      .toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("50 tracks published.", { exact: true })).toBeVisible();
    await expect(page.getByText("JOBS", { exact: true })).toBeVisible();
  });

  test("partial flow pauses in the browser and persists no publication consent", async ({ page }) => {
    const prompt = "System partial Brazilian disco music";
    await submit(page, prompt, 25);
    try {
      await expect(page.getByTestId("partial-decision-screen"))
        .toBeVisible({ timeout: 30_000 });
    } catch (error) {
      throw new Error(
        `Partial system flow did not reach its decision screen.\n${await systemDiagnostics(prompt)}`,
        { cause: error },
      );
    }
    await expect(page.getByRole("heading", { name: "20 verified tracks are ready" })).toBeVisible();
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
      [prompt],
    );
    expect(row.rows[0]).toEqual({
      requested_track_count: 25,
      status: "partial_ready",
      track_count: 20,
      decision_count: 0,
      publication_count: 0,
      publication_job_count: 0,
    });
  });

  test("partial publication requires the browser decision and locks only the verified tracks", async ({ page }) => {
    const prompt = "System partial consent Brazilian disco music";
    await submit(page, prompt, 25);
    await expect(page.getByTestId("partial-decision-screen")).toBeVisible({ timeout: 90_000 });
    await page.getByRole("button", { name: "PUBLISH 20 VERIFIED TRACKS" }).click();

    await expect.poll(async () => (
      await repository.pool.query<{
        requested_track_count: number;
        status: string;
        track_count: number;
        decision_count: number;
        native_decision_count: number;
        reconciled_count: number;
        publication_job_count: number;
        resolution_state: string | null;
        resolution_next_action: string | null;
        resolution_reason: string | null;
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
                (SELECT count(*)::int FROM partial_publication_decisions decision
                 WHERE decision.run_id=run.id
                   AND decision.decision='publish_partial'
                   AND decision.selection_set_id IS NOT NULL
                   AND decision.manifest_payload_hash ~ '^[0-9a-f]{64}$'
                   AND decision.attestation_set_hash ~ '^[0-9a-f]{64}$')
                  native_decision_count,
                (SELECT count(*)::int FROM job_queue job
                 WHERE job.run_id=run.id AND job.kind='publication') publication_job_count,
                (SELECT resolution.state
                 FROM playlist_run_resolutions resolution
                 WHERE resolution.run_id=run.id) resolution_state,
                (SELECT resolution.next_action
                 FROM playlist_run_resolutions resolution
                 WHERE resolution.run_id=run.id) resolution_next_action,
                (SELECT resolution.state_json->>'resolutionReasonCode'
                 FROM playlist_run_resolutions resolution
                 WHERE resolution.run_id=run.id) resolution_reason,
                (SELECT reconciliation.appended_count
                 FROM playlist_publication_reconciliations reconciliation
                 JOIN manifests manifest ON manifest.id=reconciliation.manifest_id
                 WHERE manifest.run_id=run.id
                   AND reconciliation.state='complete'
                 ORDER BY reconciliation.updated_at DESC LIMIT 1) reconciled_count
         FROM research_runs run JOIN run_specs spec ON spec.run_id=run.id
         WHERE spec.raw_prompt=$1`,
        [prompt],
      )
    ).rows[0]).toMatchObject({
      requested_track_count: 25,
      status: "partial",
      track_count: 20,
      decision_count: 1,
      native_decision_count: 1,
      publication_job_count: 1,
      reconciled_count: 20,
      resolution_state: "completed",
      resolution_next_action: "none",
      resolution_reason: "approved_partial_apple_reconciliation",
    });
    await expect(page.getByRole("heading", { name: "Playlist published with gaps", exact: true }))
      .toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("20 of 25 requested tracks published.", { exact: true })).toBeVisible();
  });

  test("continue research resumes the same immutable request and can reach exact fill", async ({ page }) => {
    const prompt = "System continuation Detroit techno music";
    await submit(page, prompt, 25);
    await expect(page.getByTestId("partial-decision-screen")).toBeVisible({ timeout: 90_000 });
    await page.getByRole("button", { name: "RUN ONE MORE BOUNDED PASS →" }).click();
    await expectWorkingScreen(page, prompt);

    await expect.poll(async () => (
      await repository.pool.query<{
        requested_track_count: number;
        status: string;
        track_count: number;
        decision_count: number;
        resolution_state: string | null;
        resolution_next_action: string | null;
        resolution_requested_count: number | null;
        resolution_manifested_count: number | null;
        resolution_reconciled_count: number | null;
        reconciliation_hash_matches: boolean | null;
        manifest_revision_count: number;
        superseded_revision_count: number;
        unresolved_scope_blocker_count: number;
        reconciled_count: number | null;
        source_attempt_candidate_count: number;
        continuation_attempt_candidate_count: number;
        cumulative_candidate_count: number;
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
                (SELECT resolution.state
                 FROM playlist_run_resolutions resolution
                 WHERE resolution.run_id=run.id) resolution_state,
                (SELECT resolution.next_action
                 FROM playlist_run_resolutions resolution
                 WHERE resolution.run_id=run.id) resolution_next_action,
                (SELECT (resolution.state_json->>'requestedTrackCount')::int
                 FROM playlist_run_resolutions resolution
                 WHERE resolution.run_id=run.id) resolution_requested_count,
                (SELECT (resolution.state_json->>'manifestedTrackCount')::int
                 FROM playlist_run_resolutions resolution
                 WHERE resolution.run_id=run.id) resolution_manifested_count,
                (SELECT (resolution.state_json->>'reconciledPublishedTrackCount')::int
                 FROM playlist_run_resolutions resolution
                 WHERE resolution.run_id=run.id) resolution_reconciled_count,
                (SELECT reconciliation.expected_ordered_ids_hash
                          =reconciliation.observed_ordered_ids_hash
                 FROM playlist_publication_reconciliations reconciliation
                 JOIN manifests manifest ON manifest.id=reconciliation.manifest_id
                 WHERE manifest.run_id=run.id
                 ORDER BY reconciliation.updated_at DESC LIMIT 1)
                  reconciliation_hash_matches,
                (SELECT count(*)::int
                 FROM manifest_revisions revision
                 JOIN manifests manifest ON manifest.id=revision.manifest_id
                 WHERE manifest.run_id=run.id) manifest_revision_count,
                (SELECT count(*)::int
                 FROM manifest_revisions revision
                 JOIN manifests manifest ON manifest.id=revision.manifest_id
                 WHERE manifest.run_id=run.id
                   AND revision.status='superseded')
                  superseded_revision_count,
                (SELECT count(*)::int
                 FROM playlist_run_blockers blocker
                 WHERE blocker.run_id=run.id
                   AND blocker.blocker_kind='scope_decision'
                   AND blocker.resolved_at IS NULL)
                  unresolved_scope_blocker_count,
                (SELECT reconciliation.appended_count
                 FROM playlist_publication_reconciliations reconciliation
                 JOIN manifests manifest ON manifest.id=reconciliation.manifest_id
                 WHERE manifest.run_id=run.id
                   AND reconciliation.state='complete'
                 ORDER BY reconciliation.updated_at DESC LIMIT 1)
                  reconciled_count,
                (SELECT count(DISTINCT qualification.candidate_id)::int
                 FROM playlist_qualification_records qualification
                 JOIN playlist_discovery_leads lead
                   ON lead.id=qualification.discovery_lead_id
                 JOIN playlist_execution_attempts attempt
                   ON attempt.id=lead.execution_attempt_id
                 WHERE qualification.run_id=run.id
                   AND attempt.query_plan_revision_id=(
                     SELECT revision.id
                     FROM query_plan_revisions revision
                     WHERE revision.run_id=run.id
                     ORDER BY revision.revision ASC
                     LIMIT 1
                   )) source_attempt_candidate_count,
                (SELECT count(DISTINCT qualification.candidate_id)::int
                 FROM playlist_qualification_records qualification
                 JOIN playlist_discovery_leads lead
                   ON lead.id=qualification.discovery_lead_id
                 JOIN playlist_execution_attempts attempt
                   ON attempt.id=lead.execution_attempt_id
                 WHERE qualification.run_id=run.id
                   AND attempt.query_plan_revision_id=(
                     SELECT revision.id
                     FROM query_plan_revisions revision
                     WHERE revision.run_id=run.id
                     ORDER BY revision.revision DESC
                     LIMIT 1
                   )) continuation_attempt_candidate_count,
                (SELECT count(DISTINCT qualification.candidate_id)::int
                 FROM playlist_qualification_records qualification
                 WHERE qualification.run_id=run.id)
                  cumulative_candidate_count
         FROM research_runs run JOIN run_specs spec ON spec.run_id=run.id
         WHERE spec.raw_prompt=$1`,
        [prompt],
      )
    ).rows[0]).toMatchObject({
      requested_track_count: 25,
      status: "complete",
      track_count: 25,
      decision_count: 0,
      resolution_state: "completed",
      resolution_next_action: "none",
      resolution_requested_count: 25,
      resolution_manifested_count: 25,
      resolution_reconciled_count: 25,
      reconciliation_hash_matches: true,
      manifest_revision_count: 2,
      superseded_revision_count: 1,
      unresolved_scope_blocker_count: 0,
      reconciled_count: 25,
      source_attempt_candidate_count: 20,
      continuation_attempt_candidate_count: 15,
      cumulative_candidate_count: 35,
    });
    const continuedRunId = (await repository.pool.query<{ run_id: string }>(
      "SELECT run_id FROM run_specs WHERE raw_prompt=$1",
      [prompt],
    )).rows[0]!.run_id;
    expect(candidateFirstPersistenceCounts.get(continuedRunId)).toEqual([
      20,
      15,
    ]);
    const continuedRunView = await repository.getRun(continuedRunId);
    expect(continuedRunView.evidenceCoverage).toMatchObject({
      observationCount: 35,
      qualificationObservationCount: 35,
      uniqueLeadCount: 35,
      candidates: 35,
      materializedCandidateCount: 35,
      identityBound: 35,
      evidencePassed: 35,
      evidenceUnknown: 0,
      evidenceFailed: 0,
      selected: 25,
      manifested: 25,
      reconciledPublished: 25,
    });
    expect(retrievalCalls.size).toBeGreaterThan(0);
    await expect(page.getByRole("heading", { name: "Playlist published" }))
      .toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("25 tracks published.", { exact: true })).toBeVisible();
  });

  test("candidate-rich unknown evidence preserves 80/77/73 truth and quarantines with repair", async ({
    page,
  }) => {
    const prompt = "System evidence collapse influential Irish music";
    await submit(page, prompt, 25);

    await expect(page.getByRole("heading", {
      name: "Your playlist needs technical repair",
      exact: true,
    })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("technical-evidence-coverage"))
      .toContainText("80 unique leads");
    await expect(page.getByTestId("technical-evidence-coverage"))
      .toContainText("materialized 77 unique candidates");
    await expect(page.getByTestId("technical-evidence-coverage"))
      .toContainText("recorded 77 qualification observations");
    await expect(page.getByTestId("technical-evidence-coverage"))
      .toContainText("resolved 73 as playable in Apple Music");
    await expect(page.getByText(/musical scarcity/iu)).toBeVisible();
    await expect(page.getByRole("button", { name: /refine request/iu }))
      .toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);

    await expect.poll(async () => (
      await repository.pool.query<{
        requested_track_count: number;
        status: string;
        phase: string;
        lead_count: number;
        distinct_lead_count: number;
        candidate_count: number;
        family_bound_count: number;
        qualification_count: number;
        null_candidate_count: number;
        distinct_qualification_candidate_count: number;
        unknown_count: number;
        failed_count: number;
        qualified_count: number;
        apple_identity_count: number;
        evidence_record_count: number;
        manifest_count: number;
        publication_count: number;
        publication_job_count: number;
        reconciliation_count: number;
        active_job_count: number;
        resolution_state: string | null;
        resolution_next_action: string | null;
        resolution_work_motion: string | null;
        coverage_version: string | null;
        coverage_hash: string | null;
        audit_version: string | null;
        audit_hash: string | null;
        audit_disposition: string | null;
        audit_reason: string | null;
      }>(
        `SELECT spec.requested_track_count,run.status,run.phase,
                (SELECT count(*)::int
                 FROM playlist_discovery_leads lead
                 WHERE lead.run_id=run.id) lead_count,
                (SELECT count(DISTINCT lead.identity_hint_hash)::int
                 FROM playlist_discovery_leads lead
                 WHERE lead.run_id=run.id) distinct_lead_count,
                (SELECT count(*)::int
                 FROM track_candidates candidate
                 WHERE candidate.run_id=run.id) candidate_count,
                (SELECT count(*)::int
                 FROM track_candidates candidate
                 WHERE candidate.run_id=run.id
                   AND candidate.recording_family_id IS NOT NULL)
                  family_bound_count,
                (SELECT count(*)::int
                 FROM playlist_qualification_records qualification
                 WHERE qualification.run_id=run.id
                   AND qualification.revoked_at IS NULL)
                  qualification_count,
                (SELECT count(*)::int
                 FROM playlist_qualification_records qualification
                 WHERE qualification.run_id=run.id
                   AND qualification.revoked_at IS NULL
                   AND qualification.candidate_id IS NULL)
                  null_candidate_count,
                (SELECT count(DISTINCT qualification.candidate_id)::int
                 FROM playlist_qualification_records qualification
                 WHERE qualification.run_id=run.id
                   AND qualification.revoked_at IS NULL)
                  distinct_qualification_candidate_count,
                (SELECT count(*)::int
                 FROM playlist_qualification_records qualification
                 WHERE qualification.run_id=run.id
                   AND qualification.revoked_at IS NULL
                   AND qualification.decision='unknown') unknown_count,
                (SELECT count(*)::int
                 FROM playlist_qualification_records qualification
                 WHERE qualification.run_id=run.id
                   AND qualification.revoked_at IS NULL
                   AND qualification.decision='failed') failed_count,
                (SELECT count(*)::int
                 FROM playlist_qualification_records qualification
                 WHERE qualification.run_id=run.id
                   AND qualification.revoked_at IS NULL
                   AND qualification.decision='qualified') qualified_count,
                (SELECT count(*)::int
                 FROM recording_catalog_identities identity
                 JOIN recording_families family
                   ON family.id=identity.recording_family_id
                 WHERE family.run_id=run.id
                   AND identity.provider='apple') apple_identity_count,
                (SELECT COALESCE(sum(
                   jsonb_array_length(
                     qualification.evidence_record_ids_json
                   )
                 ),0)::int
                 FROM playlist_qualification_records qualification
                 WHERE qualification.run_id=run.id
                   AND qualification.revoked_at IS NULL)
                  evidence_record_count,
                (SELECT count(*)::int
                 FROM manifests manifest
                 WHERE manifest.run_id=run.id) manifest_count,
                (SELECT count(*)::int
                 FROM publication_volumes volume
                 JOIN manifests manifest ON manifest.id=volume.manifest_id
                 WHERE manifest.run_id=run.id) publication_count,
                (SELECT count(*)::int
                 FROM job_queue job
                 WHERE job.run_id=run.id
                   AND job.kind='publication') publication_job_count,
                (SELECT count(*)::int
                 FROM playlist_publication_reconciliations reconciliation
                 WHERE reconciliation.run_id=run.id) reconciliation_count,
                (SELECT count(*)::int
                 FROM job_queue job
                 WHERE job.run_id=run.id
                   AND job.status IN ('queued','retry','leased'))
                  active_job_count,
                resolution.state resolution_state,
                resolution.next_action resolution_next_action,
                resolution.state_json->>'workMotion'
                  resolution_work_motion,
                coverage.state_json->>'version' coverage_version,
                coverage.state_json->>'coverageHash' coverage_hash,
                audit.state_json->>'version' audit_version,
                audit.state_json->>'auditHash' audit_hash,
                audit.state_json->>'disposition' audit_disposition,
                audit.state_json->>'reasonCode' audit_reason
         FROM research_runs run
         JOIN run_specs spec ON spec.run_id=run.id
         LEFT JOIN playlist_run_resolutions resolution
           ON resolution.run_id=run.id
         LEFT JOIN research_checkpoints coverage
           ON coverage.run_id=run.id
          AND coverage.phase='v3:semantic-collapse:coverage:v2'
         LEFT JOIN research_checkpoints audit
           ON audit.run_id=run.id
          AND audit.phase='v3:semantic-collapse:audit:v2'
         WHERE spec.raw_prompt=$1`,
        [prompt],
      )
    ).rows[0], {
      message: "The production-shaped evidence collapse must retain its facts",
      timeout: 90_000,
    }).toMatchObject({
      requested_track_count: 25,
      status: "quarantined",
      phase: "canonical_integrity_quarantine",
      lead_count: 80,
      distinct_lead_count: 80,
      candidate_count: 77,
      family_bound_count: 77,
      qualification_count: 77,
      null_candidate_count: 0,
      distinct_qualification_candidate_count: 77,
      unknown_count: 77,
      failed_count: 0,
      qualified_count: 0,
      apple_identity_count: 73,
      evidence_record_count: 0,
      manifest_count: 0,
      publication_count: 0,
      publication_job_count: 0,
      reconciliation_count: 0,
      active_job_count: 0,
      resolution_state: "quarantined",
      resolution_next_action: "contact_support",
      resolution_work_motion: "none",
      coverage_version: "semantic_collapse_coverage_v2",
      coverage_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      audit_version: "semantic_collapse_audit_v2",
      audit_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      audit_disposition: "deficit_research",
      audit_reason: "bounded_evidence_enrichment_required",
    });

    const source = (await repository.pool.query<{
      run_id: string;
      route_receipt: unknown;
    }>(
      `SELECT run.id run_id,route.state_json route_receipt
       FROM research_runs run
       JOIN run_specs spec ON spec.run_id=run.id
       JOIN research_checkpoints route
         ON route.run_id=run.id
        AND route.phase='execution_route_receipt_v1'
       WHERE spec.raw_prompt=$1`,
      [prompt],
    )).rows[0]!;
    const sourceRoute = parseExecutionRouteReceiptV1(source.route_receipt);
    expect(sourceRoute).not.toBeNull();
    const {
      receiptHash: _supersededReceiptHash,
      ...sourceRouteBody
    } = sourceRoute!;
    expect(_supersededReceiptHash).toMatch(/^[a-f0-9]{64}$/u);
    const supersededRoute = createExecutionRouteReceiptV1({
      ...sourceRouteBody,
      releaseRevision: "superseded-system-e2e",
      executorConfigurationHash:
        sourceRoute!.executorConfigurationHash.startsWith("0")
          ? "1".repeat(64)
          : "0".repeat(64),
    });
    await repository.pool.query(
      `UPDATE research_checkpoints
       SET state_json=$3::jsonb,updated_at=now()
       WHERE run_id=$1 AND phase=$2`,
      [
        source.run_id,
        "execution_route_receipt_v1",
        JSON.stringify(supersededRoute),
      ],
    );
    const repairReadyRun = await repository.getRun(source.run_id);
    expect(repairReadyRun?.repairReplayAction).toMatchObject({
      kind: "repair_replay",
      available: true,
      availabilityReason: "ready",
      incidentReference: expect.any(String),
      resultReuse: false,
      autoPublication: false,
    });
    const sourceAccessId = new URL(page.url()).searchParams.get("run");
    expect(sourceAccessId).toMatch(/^[0-9a-f-]{36}$/u);
    const repairReadyAccess = await repository.getRunByAccess(
      sourceAccessId!,
    );
    expect(repairReadyAccess?.repairReplayAction).toMatchObject({
      kind: "repair_replay",
      available: true,
      availabilityReason: "ready",
      incidentReference: expect.any(String),
      resultReuse: false,
      autoPublication: false,
    });
    const apiRepairReady = await page.evaluate(async (accessId) => {
      const response = await fetch(
        `/api/v1/runs/${encodeURIComponent(accessId)}?qa=${Date.now()}`,
        { cache: "no-store" },
      );
      return {
        status: response.status,
        body: await response.json(),
      };
    }, sourceAccessId!);
    expect(apiRepairReady).toMatchObject({
      status: 200,
      body: {
        repairReplayAction: {
          kind: "repair_replay",
          available: true,
          availabilityReason: "ready",
          resultReuse: false,
          autoPublication: false,
        },
        resolution: {
          state: "quarantined",
          nextAction: "replay_after_repair",
          generation:
            repairReadyRun!.repairReplayAction!.expectedGeneration,
          contractRevisionId:
            repairReadyRun!.repairReplayAction!.contractRevisionId,
          contractHash:
            repairReadyRun!.repairReplayAction!.contractSemanticHash,
        },
      },
    });

    await page.reload();
    const replayButton = page.getByTestId("replay-after-repair");
    await expect(replayButton).toBeVisible({ timeout: 20_000 });
    await Promise.all([
      page.waitForURL(/\?brief=[0-9a-f-]+$/u, { timeout: 30_000 }),
      replayButton.click(),
    ]);
    const successorBriefRequestId = new URL(page.url()).searchParams.get(
      "brief",
    );
    expect(successorBriefRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/u,
    );
    await expect(page.getByRole("heading", {
      name: /Which kind of influence should/iu,
    })).toBeVisible({ timeout: 90_000 });
    const balanced = page.locator("label.guided-option-card")
      .filter({ hasText: "Balanced" })
      .first();
    await expect(balanced).toBeVisible();
    await balanced.click();
    await page.getByRole("button", {
      name: /create playlist/iu,
    }).click();
    await page.waitForURL(/\?run=[0-9a-f-]+/u, { timeout: 90_000 });

    await expect.poll(async () => (
      await repository.pool.query<{
        successor_brief_id: string;
        source_run_id: string;
        successor_run_id: string;
        auto_publish: boolean;
        result_reuse: boolean;
        receipt_auto_publication: boolean;
        route_traffic_class: string;
        route_assignment_kind: string;
        route_guidance_version: string;
      }>(
        `SELECT brief.id successor_brief_id,
                admission.state_json->>'sourceRunId' source_run_id,
                run.id successor_run_id,
                run.auto_publish,
                (admission.state_json->>'resultReuse')::boolean
                  result_reuse,
                (admission.state_json->>'autoPublication')::boolean
                  receipt_auto_publication,
                route.state_json->>'trafficClass' route_traffic_class,
                route.state_json#>>'{assignmentAuthority,kind}'
                  route_assignment_kind,
                route.state_json->>'guidanceVersion'
                  route_guidance_version
         FROM brief_requests brief
         JOIN run_accesses access ON access.brief_request_id=brief.id
         JOIN research_runs run ON run.id=access.run_id
         JOIN research_checkpoints admission
           ON admission.run_id=run.id
          AND admission.phase='technical_repair_run_admission_v1'
         JOIN research_checkpoints route
           ON route.run_id=run.id
          AND route.phase='execution_route_receipt_v1'
         WHERE brief.id=$1`,
        [successorBriefRequestId],
      )
    ).rows[0], {
      message: "Repair replay must create a clean Guidance V5.1 successor",
      timeout: 30_000,
    }).toMatchObject({
      successor_brief_id: successorBriefRequestId,
      source_run_id: source.run_id,
      successor_run_id: expect.not.stringMatching(
        new RegExp(`^${source.run_id}$`, "u"),
      ),
      auto_publish: false,
      result_reuse: false,
      receipt_auto_publication: false,
      route_traffic_class: "replay",
      route_assignment_kind: "authenticated_legacy_repair",
      route_guidance_version: "adaptive_guidance_v5",
    });
  });
});
