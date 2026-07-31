import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { createDatabase } from "../../db/index.ts";
import {
  attestedEvidenceBindingsForSelectionV3,
  createHostedWebEvidenceSnapshotV3,
  publicTrackScopeAttestationV3,
  type QualifiedTrackV3,
  type RetrievalResultV3,
} from "../../server/pipeline-v3-retrieval.ts";
import {
  selectionPlanFromQueryPlanV3,
  type PipelineV3RetrievalExecutionPort,
} from "../../server/pipeline-v3-worker-execution.ts";
import { orderedAppleStableIdsHash } from "../../server/publication-reconciliation-persistence.ts";
import { Repository } from "../../server/repository.ts";
import { defaultJobHandlers, WorkerRunner } from "../../server/worker-runner.ts";
import type {
  CanonicalPlaylistContractClauseV1,
  CanonicalPlaylistContractEvidenceGradeV1,
  CanonicalPlaylistContractExecutionPolicyV1,
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
): QualifiedTrackV3 {
  const ordinal = String(index + 1).padStart(3, "0");
  const url = `https://example.test/system-e2e/${prefix}/${ordinal}`;
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
    const excerpt = `${prefix} Artist ${ordinal} — ${prefix} Track ${ordinal} satisfies ${obligationIds.join(", ")}.`;
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
    title: `${prefix} Track ${ordinal}`,
    artist: `${prefix} Artist ${ordinal}`,
    album: `${prefix} Album ${ordinal}`,
    appleSongId: `${prefix}-apple-${ordinal}`,
    recordingFamilyKey: `${prefix}:family:${ordinal}`,
    sourceObservationIds: [`${prefix}:observation:${ordinal}`],
    evidenceBindingIds: evidenceBindings.map(({ id }) => id),
    evidenceBindings,
    ...(canonicalClauseAssessments ? { canonicalClauseAssessments } : {}),
    evidenceStrength: 0.99,
    scopeFit: 0.99,
    independentProvenanceRoots: 1,
    versionConfidence: 0.99,
    catalogConfidence: 0.99,
    rankingSignals: { relevance: 1 - index / 1_000 },
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
  kind: "exact" | "partial" | "zero";
  continuationAvailable?: boolean;
}): RetrievalResultV3 {
  const reserveCount = input.kind === "exact" ? Math.max(10, Math.ceil(input.target * 0.2)) : 0;
  const selected = Array.from({ length: input.selectedCount }, (_, index) => (
    fixtureTrack(input.kind, index, input.predicateIds, input.canonicalPolicy)
  ));
  const reserve = Array.from({ length: reserveCount }, (_, index) => (
    fixtureTrack(
      `${input.kind}-reserve`,
      index,
      input.predicateIds,
      input.canonicalPolicy,
    )
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
      discoveryDependencyIds: ["apple_catalog"],
      qualificationDependencyIds: ["apple_catalog"],
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

test("stitched V3 fixtures retain attested exact track-scope evidence", () => {
  const track = fixtureTrack("exact", 0, ["genre:disco"]);
  expect(attestedEvidenceBindingsForSelectionV3(
    track.evidenceBindingIds,
    track.evidenceBindings,
  )).toHaveLength(1);
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
  const persistenceReplays = new Map<string, number>();

  test.beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.PIPELINE_V3_ASSIGNMENT_ENABLED = "true";
    process.env.PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED = "true";
    process.env.PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED = "true";
    process.env.PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED = "true";
    process.env.PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED = "true";
    process.env.PIPELINE_V3_GENRE_SCENE_PERCENT = "100";
    process.env.RELEASE_ENVIRONMENT = "staging";
    process.env.RELEASE_DEPLOYMENT_PHASE = "activate";
    process.env.RELEASE_EXECUTION_ENABLED = "true";
    process.env.RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION = "20";
    process.env.RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION = "2";
    process.env.RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION = "1";
    process.env.RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION = "1";
    process.env.RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION = "1";
    process.env.PIPELINE_V3_PROOF_ARCHITECTURE_MODE = "native";
    process.env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION = "6";
    process.env.GUIDANCE_CONTRACT_V3_ENABLED = "true";
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

    const v3RetrievalPort: PipelineV3RetrievalExecutionPort = {
      execute: async ({ runId, plan }) => {
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
        const result = fixtureResult({
          runId,
          target: plan.requestedTrackCount,
          selectedCount,
          predicateIds: plan.membershipPredicates
            .filter((predicate: { operator: string }) => predicate.operator !== "exclude")
            .map((predicate: { id: string }) => predicate.id),
          canonicalPolicy: plan.canonicalContractPolicy,
          kind,
          continuationAvailable: marker.includes("system continuation") && call === 1,
        });
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
          throw new Error("System E2E replay could not reload its immutable result");
        }
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
          await repository.advancePublicationReconciliation({
            ...authority,
            state: "reconciling",
            applePlaylistId,
            observedOrderedIdsHash: expectedOrderedIdsHash,
            appendedCount: manifest.tracks.length,
            batchCursor: manifest.tracks.length,
            detail: { exactMembershipVerified: true },
          });
          await repository.commitPublicationCompletion({
            runId: manifest.runId,
            manifestId,
            manifestRevisionId: manifest.revisionId,
            manifestRevisionHash: manifest.contentHash,
            contractRevisionId: manifest.contractRevisionId,
            contractHash: manifest.contractHash,
            executionFence,
            selectedCount: manifest.tracks.length,
            terminalStatus: "complete",
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
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    }
  });

  async function submit(page: import("@playwright/test").Page, prompt: string, count = 25): Promise<void> {
    await page.goto("/");
    await page.getByRole("textbox", { name: "PLAYLIST REQUEST" }).fill(prompt);
    if (count !== 50) await page.getByRole("button", { name: `${count} tracks` }).click();
    await page.getByRole("button", { name: new RegExp(`create playlist · ${count} tracks`, "iu") }).click();
    // This is deliberately a real Guidance V4 checkpoint, not a test-only
    // shortcut. Fully explicit prompts confirm the editable summary; curated
    // prompts answer one server-owned refinement before research begins.
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
      if (state === "working") return;
      if (state === "confirmation") {
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
      await page.getByRole("button", { name: /create playlist|next/i }).click();
    }
    throw new Error(`System E2E exceeded its bounded guidance checkpoints for: ${prompt}`);
  }

  async function systemDiagnostics(prompt: string): Promise<string> {
    const [briefs, runs, jobs, workers, controls] = await Promise.all([
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
    ]);
    return JSON.stringify({
      apiOutput,
      briefs: briefs.rows,
      runs: runs.rows,
      jobs: jobs.rows,
      workers: workers.rows,
      controls: controls.rows,
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
                reconciliation.observed_ordered_ids_hash reconciliation_observed_hash
         FROM run_specs spec
         JOIN research_runs run ON run.id=spec.run_id
         JOIN query_plan_revisions query ON query.run_id=spec.run_id AND query.status='active'
         JOIN manifests manifest ON manifest.run_id=spec.run_id
         JOIN manifest_revisions revision ON revision.manifest_id=manifest.id
           AND revision.status='published'
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
      [prompt],
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
        reconciled_count: number;
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
                 WHERE job.run_id=run.id AND job.kind='publication') publication_job_count,
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
      status: "complete",
      track_count: 17,
      decision_count: 1,
      publication_job_count: 1,
      reconciled_count: 17,
    });
    await expect(page.getByRole("heading", { name: "Playlist published with gaps", exact: true }))
      .toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("17 of 25 requested tracks published.", { exact: true })).toBeVisible();
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
                 ORDER BY reconciliation.updated_at DESC LIMIT 1) reconciled_count
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
    });
    expect(retrievalCalls.size).toBeGreaterThan(0);
    await expect(page.getByRole("heading", { name: "Playlist published" }))
      .toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("25 tracks published.", { exact: true })).toBeVisible();
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
