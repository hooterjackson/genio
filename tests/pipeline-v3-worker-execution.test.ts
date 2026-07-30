import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  PIPELINE_V3_RETRIEVAL_SCHEMA,
  RetrievalDependencyErrorV3,
  RetrievalPlaylistOptimizationBudgetExceededErrorV3,
  type QualifiedTrackV3,
  type RetrievalOutcomeStatusV3,
  type RetrievalResultV3,
} from "../server/pipeline-v3-retrieval.ts";
import {
  governedCorpusActionReasonV3,
  PIPELINE_V3_ACTIVE_COMPUTE_LIMIT_MS,
  PipelineV3DependencyUnavailableError,
  PipelineV3OptimizerComputeBudgetError,
  PipelineV3WorkerExecution,
  createPipelineV3RetrievalExecutionPort,
  retrievalPolicyV3FromPipelinePolicySnapshot,
  selectionPlanFromQueryPlanV3,
  v3RetrievalStageKey,
  type PipelineV3RetrievalExecutionPort,
  type PipelineV3WorkerPayload,
  type PipelineV3WorkerRepository,
  type PipelineV3WriteFence,
} from "../server/pipeline-v3-worker-execution.ts";
import type { PlaylistBrief, QueryPlanV3 } from "../shared/types.ts";
import {
  createQueryPlanV3,
  queryPlanV3Hash,
  queryPlanV3RequiresLegacyCanonicalExecutor,
} from "../server/query-plan-v3.ts";
import {
  createRunSpecV3,
  resolveRunSpecV3,
  type SelectionPlanV3,
} from "../server/selection-plan-v3.ts";
import type { ColdCorpusBuildResultV3 } from "../server/pipeline-v3-corpus-builder.ts";
import {
  createPipelinePolicySnapshotV3,
  pipelineV3ModelRouteFromPolicySnapshot,
} from "../server/pipeline-v3-policy.ts";
import type { SemanticPlanRevisionArtifactV3 } from "../server/pipeline-v3-semantic-recovery.ts";
import { compilePlaylistContractRevisionV1 } from "../server/playlist-contract-v1.ts";
import { canonicalContractExecutionPolicyV1 } from "../server/canonical-contract-runtime-v1.ts";
import {
  compilePlaylistContractShadowV1,
} from "../server/playlist-contract-shadow-bridge-v1.ts";
import {
  projectPlaylistContractExecutionV1,
} from "../server/playlist-contract-execution-bridge-v1.ts";
import { createSelectionPlanV2 } from "../server/selection-plan-v2.ts";

const GRAPH_SNAPSHOT_ID = "11111111-1111-4111-8111-111111111111";
const QUERY_PLAN_REVISION_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const MANIFEST_ID = "44444444-4444-4444-8444-444444444444";
const MANIFEST_REVISION_ID = "55555555-5555-4555-8555-555555555555";
const MANIFEST_HASH = "a".repeat(64);

function queryPlan(target = 25) {
  return createQueryPlanV3(resolveRunSpecV3(createRunSpecV3({
    prompt: `${target} influential disco recordings`,
    requestedTrackCount: target,
    storefront: "us",
  }), []), GRAPH_SNAPSHOT_ID);
}

function canonicalQueryPlan(target = 25, schemaVersion: 5 | 6 = 5) {
  const prompt = `${target} influential disco recordings`;
  const contract = compilePlaylistContractRevisionV1({
    contractId: `canonical-disco-${target}`,
    rawPrompt: prompt,
    requestedTrackCount: target,
    locale: "en",
    storefront: "us",
    clauses: [{
      id: "prompt:genre:disco",
      kind: "membership",
      scope: "track",
      hardness: "hard",
      axis: "genre",
      operator: "require",
      values: ["disco"],
      source: { provenance: "prompt", text: "Disco" },
    }],
    trackPredicate: { op: "clause", clauseId: "prompt:genre:disco" },
  });
  const base = resolveRunSpecV3(createRunSpecV3({
    prompt,
    requestedTrackCount: target,
    storefront: "us",
  }), []);
  const selection: SelectionPlanV3 = {
    ...base,
    canonicalContractPolicy: canonicalContractExecutionPolicyV1(contract),
  };
  return {
    contract,
    plan: createQueryPlanV3(selection, GRAPH_SNAPSHOT_ID, {
      schemaVersion,
      briefContractVersion: 3,
      playlistContractRevisionId: contract.revisionId,
      playlistContractSemanticHash: contract.semanticHash,
      playlistContractCompilerVersion: contract.versions.compiler,
    }),
  };
}

function legacyQueryPlan(target = 25) {
  return createQueryPlanV3(resolveRunSpecV3(createRunSpecV3({
    prompt: `${target} influential disco recordings`,
    requestedTrackCount: target,
    storefront: "us",
  }), []), GRAPH_SNAPSHOT_ID, { schemaVersion: 1 });
}

function workerRun(prompt: string, target = 25) {
  const plan = resolveRunSpecV3(createRunSpecV3({
    prompt,
    requestedTrackCount: target,
    storefront: "us",
  }), []);
  return {
    prompt,
    pipelinePolicySnapshot: createPipelinePolicySnapshotV3({
      plan,
      capturedAt: "2026-07-20T12:00:00.000Z",
    }),
  };
}

function factualQueryPlan(input: {
  target?: number;
  exhaustive?: boolean;
} = {}): QueryPlanV3 {
  const target = input.target ?? 25;
  const engine = input.exhaustive ? "exhaustive" : "factual_relationship";
  const base = queryPlan(target);
  return {
    ...base,
    engine,
    engines: [engine],
    scopeKind: "factual_frontier",
    membershipPredicates: [
      {
        id: "membership:artist:paulinho",
        kind: "artist",
        subject: "Paulinho da Costa",
        relationship: "require",
        hard: true,
      },
      {
        id: "membership:relationship:performed_on",
        kind: "factual_relationship",
        subject: "performed on",
        relationship: "require",
        hard: true,
      },
    ],
    rankingObjectives: [],
    hardConstraints: [
      {
        id: "membership:artist:paulinho",
        axis: "artist",
        operator: "require",
        values: ["Paulinho da Costa"],
        kind: "hard",
        relaxationRank: null,
      },
      {
        id: "membership:relationship:performed_on",
        axis: "relationship",
        operator: "require",
        values: ["performed on"],
        kind: "hard",
        relaxationRank: null,
      },
    ],
    softPreferences: [],
  };
}

function track(index: number): QualifiedTrackV3 {
  return {
    candidateId: `candidate-${index}`,
    title: `Track ${index}`,
    artist: `Artist ${index % 7}`,
    album: `Album ${index % 5}`,
    appleSongId: `apple-${index}`,
    recordingFamilyKey: `family-${index}`,
    sourceObservationIds: [`observation-${index}`],
    evidenceBindingIds: [`binding-${index}`],
    evidenceStrength: 0.9,
    scopeFit: 0.95,
    independentProvenanceRoots: 2,
    versionConfidence: 0.98,
    catalogConfidence: 0.99,
    rankingSignals: { relevance: 0.9 },
    sourceRank: index,
  };
}

function retrievalResult(
  status: RetrievalOutcomeStatusV3,
  selectedCount: number,
  requestedCount = 25,
  executionMode: "active" | "shadow" = "active",
): RetrievalResultV3 {
  const selected = Array.from({ length: selectedCount }, (_, index) => track(index));
  const reserve = status === "exact_ready" ? Array.from({ length: 10 }, (_, index) => track(1_000 + index)) : [];
  const canonicalUnique = selected.length + reserve.length;
  const stopReason = status === "exact_ready"
    ? "qualified_reserve_satisfied"
    : status === "failed_integrity"
      ? "integrity_failure"
      : status === "failed_system"
        ? "provider_failure"
        : "frontier_exhausted";
  const stages = {
    discovered: canonicalUnique,
    validCandidates: canonicalUnique,
    scopeEligible: canonicalUnique,
    hardConstraintEligible: canonicalUnique,
    evidenceEligible: canonicalUnique,
    versionCompatible: canonicalUnique,
    storefrontPlayable: canonicalUnique,
    canonicalUnique,
    selected: selected.length,
    reserve: reserve.length,
  } as const;
  return {
    schemaVersion: PIPELINE_V3_RETRIEVAL_SCHEMA,
    runId: "run-v3",
    executionMode,
    engines: ["curated_genre_scene"],
    outcome: {
      status,
      stopReason,
      requestedTrackCount: requestedCount,
      qualifiedTrackCount: canonicalUnique,
      selectedTrackCount: selected.length,
      reserveTrackCount: reserve.length,
      shortfall: Math.max(0, requestedCount - selected.length),
      requiresPartialPublicationDecision: status === "partial_ready",
    },
    selected,
    reserve,
    qualifiedPool: [...selected, ...reserve],
    compatibleAlternatesByRecordingFamily: {},
    stages,
    deficit: {
      ...stages,
      requested: requestedCount,
      qualifiedPoolGoal: requestedCount + 10,
      targetShortfall: Math.max(0, requestedCount - selected.length),
      reserveShortfall: status === "exact_ready" ? 0 : 10,
      discardedByReason: {},
      primaryShortfallReason: status === "exact_ready" ? null : stopReason,
    },
    strategies: [{
      id: "curated_genre_scene:trusted_scoped_containers",
      engine: "curated_genre_scene",
      kind: "trusted_containers",
      discoveryDependencyIds: ["apple_catalog"],
      qualificationDependencyIds: ["apple_catalog"],
      status: "exhausted",
      rounds: 1,
      rawCandidates: canonicalUnique,
      newQualifiedFamilies: canonicalUnique,
      consecutiveZeroQualifiedYieldRounds: 0,
      providerFailures: 0,
      cursor: null,
    }],
    integrityEvents: [],
    publicationBoundary: {
      appleWriteAccess: "forbidden",
      manifestDisposition: executionMode === "shadow"
        ? "shadow_manifest_only"
        : status === "exact_ready"
          ? "exact_draft_ready"
          : status === "partial_ready"
            ? "partial_confirmation_required"
            : status === "no_compatible_tracks"
              ? "no_manifest"
              : "blocked_operational_failure",
    },
  };
}

function factualNoCompatibleResult(rawCandidates: number): RetrievalResultV3 {
  const base = retrievalResult("no_compatible_tracks", 0);
  return {
    ...base,
    engines: ["factual_relationship"],
    strategies: [{
      id: "factual_relationship:promoted_graph_assertions",
      engine: "factual_relationship",
      kind: "graph_traversal",
      discoveryDependencyIds: ["governed_evidence_graph"],
      qualificationDependencyIds: ["apple_catalog"],
      status: "exhausted",
      rounds: 1,
      rawCandidates,
      newQualifiedFamilies: 0,
      consecutiveZeroQualifiedYieldRounds: 1,
      providerFailures: 0,
      cursor: null,
    }],
  };
}

class MemoryRepository implements PipelineV3WorkerRepository {
  readonly checkpoints = new Map<string, unknown>();
  readonly writes: Array<{ key: string; fence: PipelineV3WriteFence | undefined }> = [];
  readonly updates: Array<{
    patch: { status?: string; phase?: string; error?: string | null };
    fence: PipelineV3WriteFence | undefined;
  }> = [];
  readonly persisted: Array<Parameters<PipelineV3WorkerRepository["persistPipelineV3RetrievalResult"]>[0]> = [];
  readonly quarantines: Array<Parameters<NonNullable<
    PipelineV3WorkerRepository["quarantineCanonicalExecution"]
  >>[0]> = [];
  readonly semanticRecoveryClaims: Array<Parameters<PipelineV3WorkerRepository["claimPipelineV3SemanticRecovery"]>[0]> = [];
  readonly corpusIngestions: ColdCorpusBuildResultV3[] = [];
  readonly discoveryBatches: Array<
    Parameters<NonNullable<
      PipelineV3WorkerRepository["persistPipelineV3DiscoveryBatch"]
    >>[0]
  > = [];
  readonly qualificationBatches: Array<
    Parameters<NonNullable<
      PipelineV3WorkerRepository["persistPipelineV3QualificationBatch"]
    >>[0]
  > = [];
  readonly runtimeFeasibilitySnapshots: Array<
    Parameters<NonNullable<
      PipelineV3WorkerRepository["persistPipelineV3RuntimeFeasibilitySnapshot"]
    >>[0]
  > = [];
  readonly continuationQualificationValidations: Array<
    Parameters<NonNullable<
      PipelineV3WorkerRepository[
        "validatePipelineV3ContinuationQualifications"
      ]
    >>[0]
  > = [];

  constructor(
    private readonly exactPublicationState: "queued" | "waiting_for_apple_authorization" = "queued",
  ) {}

  async getResearchCheckpoint(_runId: string, checkpointKey: string): Promise<unknown | null> {
    return this.checkpoints.get(checkpointKey) ?? null;
  }

  async saveResearchCheckpoint(
    _runId: string,
    checkpointKey: string,
    checkpoint: unknown,
    fence?: PipelineV3WriteFence,
  ): Promise<void> {
    this.checkpoints.set(checkpointKey, structuredClone(checkpoint));
    this.writes.push({ key: checkpointKey, fence });
  }

  async updateRun(
    _runId: string,
    patch: { status?: string; phase?: string; error?: string | null },
    fence?: PipelineV3WriteFence,
  ): Promise<void> {
    this.updates.push({ patch: structuredClone(patch), fence });
  }

  async quarantineCanonicalExecution(
    input: Parameters<NonNullable<
      PipelineV3WorkerRepository["quarantineCanonicalExecution"]
    >>[0],
  ): Promise<boolean> {
    this.quarantines.push(structuredClone(input));
    return true;
  }

  async claimPipelineV3SemanticRecovery(
    input: Parameters<PipelineV3WorkerRepository["claimPipelineV3SemanticRecovery"]>[0],
  ): ReturnType<PipelineV3WorkerRepository["claimPipelineV3SemanticRecovery"]> {
    this.semanticRecoveryClaims.push(structuredClone(input));
    return { status: this.semanticRecoveryClaims.length === 1 ? "claimed" : "replayed", revision: 2 };
  }

  async persistPipelineV3DiscoveryBatch(
    input: Parameters<NonNullable<
      PipelineV3WorkerRepository["persistPipelineV3DiscoveryBatch"]
    >>[0],
  ): Promise<void> {
    this.discoveryBatches.push(structuredClone(input));
  }

  async persistPipelineV3QualificationBatch(
    input: Parameters<NonNullable<
      PipelineV3WorkerRepository["persistPipelineV3QualificationBatch"]
    >>[0],
  ): Promise<void> {
    this.qualificationBatches.push(structuredClone(input));
  }

  async validatePipelineV3ContinuationQualifications(
    input: Parameters<NonNullable<
      PipelineV3WorkerRepository[
        "validatePipelineV3ContinuationQualifications"
      ]
    >>[0],
  ): Promise<void> {
    this.continuationQualificationValidations.push(structuredClone(input));
  }

  async persistPipelineV3RuntimeFeasibilitySnapshot(
    input: Parameters<NonNullable<
      PipelineV3WorkerRepository["persistPipelineV3RuntimeFeasibilitySnapshot"]
    >>[0],
  ): Promise<{ id: string; created: boolean }> {
    this.runtimeFeasibilitySnapshots.push(structuredClone(input));
    return { id: randomUUID(), created: true };
  }

  async persistPipelineV3RetrievalResult(
    input: Parameters<PipelineV3WorkerRepository["persistPipelineV3RetrievalResult"]>[0],
  ): ReturnType<PipelineV3WorkerRepository["persistPipelineV3RetrievalResult"]> {
    this.persisted.push(structuredClone(input));
    if (input.result.outcome.status === "no_compatible_tracks"
      || input.result.outcome.status === "awaiting_guidance"
      || input.result.outcome.status === "failed_integrity"
      || input.result.outcome.status === "failed_system") {
      return {
        manifestId: null,
        manifestRevisionId: null,
        manifestHash: null,
        publicationState: "not_applicable",
      };
    }
    return {
      manifestId: MANIFEST_ID,
      manifestRevisionId: MANIFEST_REVISION_ID,
      manifestHash: MANIFEST_HASH,
      publicationState: input.result.outcome.status === "partial_ready"
        ? "partial_confirmation_required"
        : this.exactPublicationState,
    };
  }

  async ingestPipelineV3ColdCorpus(
    input: Parameters<NonNullable<PipelineV3WorkerRepository["ingestPipelineV3ColdCorpus"]>>[0],
  ): Promise<{ sourceDocumentCount: number; observationCount: number; enumerationComplete: boolean; unresolvedGapCount: number }> {
    this.corpusIngestions.push(structuredClone(input.result));
    return {
      sourceDocumentCount: input.result.sourceCount,
      observationCount: input.result.observations.length,
      enumerationComplete: input.result.enumerationComplete,
      unresolvedGapCount: input.result.gaps.length + (input.result.enumerationComplete ? 0 : 1),
    };
  }
}

class FenceValidatingMemoryRepository extends MemoryRepository {
  constructor(private readonly leasedStageKey: string) {
    super();
  }

  private validate(fence: PipelineV3WriteFence | undefined): void {
    if (fence?.stageKey !== this.leasedStageKey) {
      throw new Error("job_lease_lost");
    }
  }

  override async saveResearchCheckpoint(
    runId: string,
    checkpointKey: string,
    checkpoint: unknown,
    fence?: PipelineV3WriteFence,
  ): Promise<void> {
    this.validate(fence);
    await super.saveResearchCheckpoint(runId, checkpointKey, checkpoint, fence);
  }

  override async updateRun(
    runId: string,
    patch: { status?: string; phase?: string; error?: string | null },
    fence?: PipelineV3WriteFence,
  ): Promise<void> {
    this.validate(fence);
    await super.updateRun(runId, patch, fence);
  }
}

function payload(plan: QueryPlanV3, mode: "active" | "shadow" = "active"): PipelineV3WorkerPayload {
  const stageKey = v3RetrievalStageKey(plan, mode);
  return {
    v3ExecutionMode: mode,
    stageExecutionKey: stageKey,
    __jobStageKey: stageKey,
    __jobLeaseEpoch: 7,
    __queryPlanRevisionId: QUERY_PLAN_REVISION_ID,
    __jobId: JOB_ID,
    __jobWorkerId: "worker-v3",
  };
}

function canonicalPayload(
  plan: QueryPlanV3,
  contract: ReturnType<typeof compilePlaylistContractRevisionV1>,
): PipelineV3WorkerPayload {
  return {
    ...payload(plan),
    __contractAttemptId: "66666666-6666-4666-8666-666666666666",
    __contractRevisionDatabaseId: "77777777-7777-4777-8777-777777777777",
    __contractRevisionId: contract.revisionId,
    __contractSemanticHash: contract.semanticHash,
  };
}

function execution(result: RetrievalResultV3): PipelineV3RetrievalExecutionPort {
  return { execute: vi.fn(async () => result) };
}

function optimizerRetrySeed() {
  const result = retrievalResult("exact_ready", 1, 1);
  return {
    providerCallPermitted: false as const,
    approvedStrategyIds: [],
    qualifiedTracks: result.qualifiedPool,
    compatibleAlternatesByRecordingFamily: {},
    stages: result.stages,
    strategies: result.strategies,
  };
}

function semanticRecoveryRevision(plan: SelectionPlanV3): SemanticPlanRevisionArtifactV3 {
  return {
    revision: 2,
    parentRevision: 1,
    equivalence: "semantic_equivalent_repair",
    hardConstraintHash: "b".repeat(64),
    planHash: "c".repeat(64),
    plan,
    transformations: [{
      kind: "duplicate_projection",
      removedPredicateId: "genre:duplicate",
      retainedPredicateId: "genre:retained",
      reason: "Exact duplicate membership projection",
    }],
    predicateProjection: { "genre:duplicate": "genre:retained" },
  };
}

function assertFenced(repository: MemoryRepository, plan: QueryPlanV3, mode: "active" | "shadow" = "active") {
  const expected = {
    jobId: JOB_ID,
    workerId: "worker-v3",
    leaseEpoch: 7,
    queryPlanRevisionId: QUERY_PLAN_REVISION_ID,
    stageKey: v3RetrievalStageKey(plan, mode),
    ...(plan.schemaVersion >= 4 ? {
      contractAttemptId: "66666666-6666-4666-8666-666666666666",
      contractRevisionDatabaseId: "77777777-7777-4777-8777-777777777777",
      contractRevisionId: plan.playlistContractRevisionId,
      contractSemanticHash: plan.playlistContractSemanticHash,
    } : {}),
  };
  expect(repository.writes.length).toBeGreaterThan(0);
  expect(repository.updates.length).toBeGreaterThan(0);
  for (const write of repository.writes) expect(write.fence).toEqual(expected);
  for (const update of repository.updates) expect(update.fence).toEqual(expected);
  for (const persisted of repository.persisted) expect(persisted.fence).toEqual(expected);
  for (const claim of repository.semanticRecoveryClaims) expect(claim.fence).toEqual(expected);
  for (const snapshot of repository.runtimeFeasibilitySnapshots) {
    expect(snapshot.fence).toEqual(expected);
  }
}

describe("Pipeline V3 durable worker execution", () => {
  test("revalidates schema-6 coverage against the claiming worker configuration", async () => {
    const canonical = canonicalQueryPlan(25, 6);
    const repository = new MemoryRepository();
    const port = execution(retrievalResult("exact_ready", 25));
    const validPayload = {
      ...canonicalPayload(canonical.plan, canonical.contract),
      __executorSemanticConfigurationHash:
        canonical.plan.executionCoverageReport!.configurationHash,
    };

    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: canonical.plan,
      payload: validPayload,
    });

    expect(port.execute).toHaveBeenCalledOnce();
    expect(repository.checkpoints.get("v3:coverage:worker-claim"))
      .toMatchObject({
        stage: "worker_claim",
        complete: true,
        configurationHash:
          canonical.plan.executionCoverageReport!.configurationHash,
      });

    const rejectedRepository = new MemoryRepository();
    const rejectedPort = execution(retrievalResult("exact_ready", 25));
    await new PipelineV3WorkerExecution(
      rejectedRepository,
      rejectedPort,
    ).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: canonical.plan,
      payload: {
        ...validPayload,
        __jobId: randomUUID(),
        __executorSemanticConfigurationHash: "f".repeat(64),
      },
    });
    expect(rejectedPort.execute).not.toHaveBeenCalled();
    expect(rejectedRepository.updates.at(-1)?.patch).toEqual({
      status: "failed_integrity",
      phase: "v3_execution_coverage_worker_claim_failed",
      error: null,
    });
  });

  test("uses the canonical execution evidence policy when the shadow projection differs from the legacy plan policy", async () => {
    const prompt = "Build exactly Billie Jean, La Isla Bonita, and September in the listed order.";
    const brief: PlaylistBrief = {
      title: "Classic Pop Originals",
      description: "Three original studio recordings in the requested order.",
      mode: "curated",
      subjectEntities: [],
      relationship: "Exact inclusion of three named original studio recordings in the listed order.",
      include: [
        "Michael Jackson — Billie Jean",
        "Madonna — La Isla Bonita",
        "Earth, Wind & Fire — September",
      ],
      exclude: [
        "remixes",
        "live versions",
        "radio edits",
        "covers",
        "re-recordings",
        "duplicates",
      ],
      versionPolicy: "Use the original studio recording only for each listed song; no alternate versions.",
      evidencePolicy: "Verify exact artist, title, and original studio recording identity.",
      orderingPolicy: "Preserve the user-specified order exactly.",
      targetSize: { min: 3, max: 3 },
      ambiguities: [],
    };
    const basePlan = createSelectionPlanV2({ prompt, brief, storefront: "us" });
    const shadow = compilePlaylistContractShadowV1({
      contractId: "contract:worker-claim:fixed-list",
      prompt,
      brief,
      selectionPlan: basePlan,
    });
    const projection = projectPlaylistContractExecutionV1({
      contract: shadow.contract,
      basePlan,
    });
    const plan = createQueryPlanV3(
      projection.selectionPlanV3,
      GRAPH_SNAPSHOT_ID,
      {
        schemaVersion: 6,
        briefContractVersion: 3,
        playlistContractRevisionId: shadow.contract.revisionId,
        playlistContractSemanticHash: shadow.contract.semanticHash,
        playlistContractCompilerVersion: shadow.contract.versions.compiler,
      },
    );
    expect(plan.evidencePolicyVersion).toBe("governed_evidence_v2");
    expect(plan.executionCoverageReport?.evidencePolicyVersion)
      .toBe("selection_plan_evidence_projection_v2");
    const repository = new MemoryRepository();
    const port = execution(retrievalResult("exact_ready", 3));

    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun(prompt, 3),
      queryPlan: plan,
      payload: {
        ...canonicalPayload(plan, shadow.contract),
        __executorSemanticConfigurationHash:
          plan.executionCoverageReport!.configurationHash,
      },
    });

    expect(port.execute).toHaveBeenCalledOnce();
    expect(repository.checkpoints.get("v3:coverage:worker-claim"))
      .toMatchObject({
        complete: true,
        evidencePolicyVersion: "selection_plan_evidence_projection_v2",
      });
  });

  test("fails closed without a provider call for a historical schema-4 fixed-container plan missing typed directives", async () => {
    const { contract, plan: current } = canonicalQueryPlan();
    const legacyPlan: QueryPlanV3 = {
      ...current,
      schemaVersion: 4,
      engine: "fixed_container",
      engines: ["fixed_container"],
      executionDirectives: undefined,
      executorCapabilityHash: undefined,
      executorCapabilityVector: undefined,
      canonicalContractPolicy: {
        ...current.canonicalContractPolicy!,
        executionDirectives: undefined,
      },
    };
    expect(queryPlanV3RequiresLegacyCanonicalExecutor(legacyPlan)).toBe(true);
    class LegacyCanonicalDecisionRepository extends MemoryRepository {
      readonly blockers: Record<string, unknown>[] = [];

      async openPlaylistRunBlocker(
        input: Record<string, unknown>,
      ): Promise<string> {
        this.blockers.push(structuredClone(input));
        return "88888888-8888-4888-8888-888888888888";
      }
    }
    const repository = new LegacyCanonicalDecisionRepository();
    const port = execution(retrievalResult("exact_ready", 25));

    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("Every track from the fixed album"),
      queryPlan: legacyPlan,
      payload: canonicalPayload(legacyPlan, contract),
    });

    expect(port.execute).not.toHaveBeenCalled();
    expect(repository.blockers).toEqual([
      expect.objectContaining({
        blockerKind: "scope_decision",
        dependencyKey: "legacy_schema4_executor",
        state: expect.objectContaining({
          reasonCode: "legacy_canonical_executor_required",
          requiredQueryPlanSchemaVersion: 5,
          automaticResume: false,
        }),
      }),
    ]);
    expect(repository.updates.at(-1)?.patch).toEqual({
      status: "needs_decision",
      phase: "legacy_canonical_successor_required",
      error: null,
    });
  });

  test("refuses schema-2 work compiled against a different music-concept registry", () => {
    const plan = queryPlan();
    expect(() => selectionPlanFromQueryPlanV3({
      ...plan,
      musicConceptPolicyVersion: "music_concepts_future",
    }, workerRun("25 influential disco recordings"))).toThrow(
      "unsupported music-concept policy",
    );
  });

  test("rehydrates central-quality ranking without changing its policy dimension", () => {
    const canonical = canonicalQueryPlan(1);
    const query: QueryPlanV3 = {
      ...canonical.plan,
      rankingObjectives: [
        ...canonical.plan.rankingObjectives,
        {
          id: "canonical:ranking:central-quality",
          kind: "central_quality",
          description: "Prefer the strongest policy-bound central fit.",
          weight: 1,
          values: ["smooth"],
        },
      ],
    };

    const rehydrated = selectionPlanFromQueryPlanV3(query, {});

    expect(rehydrated.rankingObjectives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "canonical:ranking:central-quality",
          dimension: "central_quality",
        }),
      ]),
    );
  });

  test("removes legacy relaxation metadata from canonical query-plan rehydration", () => {
    const canonical = canonicalQueryPlan(1);
    const query: QueryPlanV3 = {
      ...canonical.plan,
      softGoalRelaxationOrder: [
        "album_concentration",
        "artist_concentration",
      ],
    };

    const rehydrated = selectionPlanFromQueryPlanV3(query, {});

    expect(rehydrated.softGoalRelaxationOrder).toEqual([]);
    expect(rehydrated.diversityGoals).toEqual(query.diversityGoals);
  });

  test("classifies unsupported exhaustive and cold factual graph work explicitly", () => {
    expect(governedCorpusActionReasonV3(factualQueryPlan({ exhaustive: true }))).toBe(
      "v3_exhaustive_frontier_builder_unavailable",
    );
    expect(governedCorpusActionReasonV3(
      factualQueryPlan(),
      factualNoCompatibleResult(0),
    )).toBe("v3_factual_graph_snapshot_has_no_qualified_candidates");
    expect(governedCorpusActionReasonV3(
      factualQueryPlan(),
      factualNoCompatibleResult(3),
    )).toBeNull();
    expect(governedCorpusActionReasonV3(queryPlan(), retrievalResult("no_compatible_tracks", 0))).toBeNull();
  });

  test("allows exhaustive graph retrieval only after a reviewed complete frontier is frozen", () => {
    const source = factualQueryPlan({ exhaustive: true });
    const reviewed: QueryPlanV3 = {
      ...source,
      graphSnapshotId: "99999999-9999-4999-8999-999999999999",
      corpusReview: {
        sourceQueryPlanRevisionId: QUERY_PLAN_REVISION_ID,
        sourceQueryPlanHash: "a".repeat(64),
        sourceStageKey: "v3-retrieval:active:source",
        sourceCheckpointHash: "b".repeat(64),
        reviewedGraphSnapshotId: "99999999-9999-4999-8999-999999999999",
        enumerationComplete: true,
        reviewedAt: "2026-07-20T12:00:00.000Z",
      },
    };
    expect(governedCorpusActionReasonV3(reviewed)).toBeNull();
  });

  test("revalidates authoritative qualification hashes before a canonical continuation", async () => {
    const canonical = canonicalQueryPlan(1);
    const sourceStageKey = "v3-retrieval:active:source";
    const sourceQueryPlanHash = "b".repeat(64);
    const sourceOutcomeHash = "c".repeat(64);
    const sourceTrack = track(0);
    const successor: QueryPlanV3 = {
      ...canonical.plan,
      continuation: {
        sourceQueryPlanRevisionId: QUERY_PLAN_REVISION_ID,
        sourceQueryPlanHash,
        sourceStageKey,
        sourceOutcomeHash,
        sourceOutcomeVersion: 1,
        strategyIds: ["curated_genre_scene:trusted_scoped_containers"],
      },
    };
    class RejectingContinuationRepository extends MemoryRepository {
      override async validatePipelineV3ContinuationQualifications(
        input: Parameters<NonNullable<
          PipelineV3WorkerRepository[
            "validatePipelineV3ContinuationQualifications"
          ]
        >>[0],
      ): Promise<void> {
        await super.validatePipelineV3ContinuationQualifications(input);
        throw new Error("qualification hash mismatch");
      }
    }
    const repository = new RejectingContinuationRepository();
    const sourceResult = retrievalResult("partial_ready", 1, 2);
    repository.checkpoints.set(sourceStageKey, {
      schemaVersion: "genio-pipeline-v3-worker/v1",
      state: "complete",
      stageKey: sourceStageKey,
      queryPlanHash: sourceQueryPlanHash,
      queryPlanRevisionId: QUERY_PLAN_REVISION_ID,
      selected: [sourceTrack],
      reserve: [],
      strategies: sourceResult.strategies,
      stages: sourceResult.stages,
      compatibleAlternatesByRecordingFamily: {},
    });
    repository.checkpoints.set("partial_ready", {
      outcomeHash: sourceOutcomeHash,
      outcomeVersion: 1,
    });
    const port = execution(retrievalResult("exact_ready", 1, 1));

    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("1 influential disco recording", 1),
      queryPlan: successor,
      payload: canonicalPayload(successor, canonical.contract),
    });

    expect(repository.continuationQualificationValidations).toHaveLength(1);
    expect(repository.continuationQualificationValidations[0]?.tracks)
      .toEqual([sourceTrack]);
    expect(port.execute).not.toHaveBeenCalled();
    expect(repository.updates.at(-1)?.patch).toMatchObject({
      status: "failed_integrity",
      phase: "v3_continuation_source_invalid",
    });
  });

  test("does not trust unpersisted continuation alternates for canonical ranking", async () => {
    const canonical = canonicalQueryPlan(1);
    const sourceStageKey = "v3-retrieval:active:source";
    const sourceQueryPlanHash = "b".repeat(64);
    const sourceOutcomeHash = "c".repeat(64);
    const sourceTrack = track(0);
    const untrustedAlternate = {
      ...track(999),
      recordingFamilyKey: sourceTrack.recordingFamilyKey,
      rankingSignals: { relevance: 999 },
      unboundedProviderPayload: "x".repeat(1_000_000),
    } as QualifiedTrackV3;
    const successor: QueryPlanV3 = {
      ...canonical.plan,
      continuation: {
        sourceQueryPlanRevisionId: QUERY_PLAN_REVISION_ID,
        sourceQueryPlanHash,
        sourceStageKey,
        sourceOutcomeHash,
        sourceOutcomeVersion: 1,
        strategyIds: ["curated_genre_scene:trusted_scoped_containers"],
      },
    };
    const repository = new MemoryRepository();
    const sourceResult = retrievalResult("partial_ready", 1, 2);
    repository.checkpoints.set(sourceStageKey, {
      schemaVersion: "genio-pipeline-v3-worker/v1",
      state: "complete",
      stageKey: sourceStageKey,
      queryPlanHash: sourceQueryPlanHash,
      queryPlanRevisionId: QUERY_PLAN_REVISION_ID,
      selected: [sourceTrack],
      reserve: [],
      strategies: sourceResult.strategies,
      stages: sourceResult.stages,
      compatibleAlternatesByRecordingFamily: {
        [sourceTrack.recordingFamilyKey]: [untrustedAlternate],
      },
    });
    repository.checkpoints.set("partial_ready", {
      outcomeHash: sourceOutcomeHash,
      outcomeVersion: 1,
    });
    const port = execution(retrievalResult("exact_ready", 1, 1));

    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("1 influential disco recording", 1),
      queryPlan: successor,
      payload: canonicalPayload(successor, canonical.contract),
    });

    expect(repository.continuationQualificationValidations).toHaveLength(1);
    expect(repository.continuationQualificationValidations[0]?.tracks)
      .toEqual([sourceTrack]);
    expect(port.execute).toHaveBeenCalledOnce();
    expect(vi.mocked(port.execute).mock.calls[0]?.[0].continuation)
      .toMatchObject({
        qualifiedTracks: [sourceTrack],
        compatibleAlternatesByRecordingFamily: {},
      });
  });

  test.each([
    ["exact_ready", 25, "publishing", "publication_queued", "queued"],
    ["partial_ready", 14, "partial_ready", "partial_confirmation_required", "partial_confirmation_required"],
    ["no_compatible_tracks", 0, "no_compatible_tracks", "v3_no_compatible_tracks", "not_applicable"],
  ] as const)("persists %s without exposing an Apple publication operation", async (
    outcome,
    selectedCount,
    expectedStatus,
    expectedPhase,
    expectedPublicationState,
  ) => {
    const plan = queryPlan();
    const repository = new MemoryRepository();
    const port = execution(retrievalResult(outcome, selectedCount));
    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: payload(plan),
    });

    expect(repository.updates.at(-1)?.patch).toEqual({
      status: expectedStatus,
      phase: expectedPhase,
      error: null,
    });
    expect(repository.checkpoints.get("v3:retrieval:latest")).toMatchObject({
      outcome: { status: outcome },
      publicationBoundary: { appleWriteAccess: "forbidden" },
      manifestId: outcome === "no_compatible_tracks" ? null : MANIFEST_ID,
      manifestRevisionId: outcome === "no_compatible_tracks" ? null : MANIFEST_REVISION_ID,
      manifestHash: outcome === "no_compatible_tracks" ? null : MANIFEST_HASH,
      publicationState: expectedPublicationState,
    });
    if (outcome === "partial_ready") {
      expect(repository.checkpoints.get("partial_ready")).toMatchObject({
        targetTrackCount: 25,
        verifiedTrackCount: 14,
        shortfall: 11,
        outcomeVersion: 1,
        outcomeHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        manifestId: MANIFEST_ID,
        manifestRevisionId: MANIFEST_REVISION_ID,
        manifestHash: MANIFEST_HASH,
      });
    } else {
      expect(repository.checkpoints.has("partial_ready")).toBe(false);
    }
    expect(repository.persisted).toHaveLength(1);
    expect(repository.persisted[0]).toMatchObject({
      runId: "run-v3",
      result: { outcome: { status: outcome } },
    });
    assertFenced(repository, plan);
    expect(port.execute).toHaveBeenCalledOnce();
    expect(port.execute).toHaveBeenCalledWith(expect.objectContaining({
      semanticRecoveryEnabled: true,
      modelRoute: expect.objectContaining({
        providerModelId: "gpt-5.6-luna",
        escalationProviderModelId: "gpt-5.6-terra",
        resolutionMode: "provider_managed_alias",
      }),
      policy: {
        maximumGlobalRounds: 48,
        maximumRawCandidates: 500,
        candidateGoal: 55,
        qualifiedPoolGoal: 30,
        maximumCostUnits: 48,
        deadlineAtEpochMs: null,
        maximumProviderFailuresPerStrategy: 2,
      },
    }));
  });

  test("quarantines a returned failed-integrity outcome without reporting musical scarcity", async () => {
    const plan = queryPlan();
    const repository = new MemoryRepository();
    const port = execution(retrievalResult("failed_integrity", 0));

    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: payload(plan),
    });

    expect(repository.persisted).toHaveLength(1);
    expect(repository.persisted[0]?.result.outcome).toMatchObject({
      status: "failed_integrity",
      stopReason: "integrity_failure",
    });
    expect(repository.checkpoints.get(v3RetrievalStageKey(plan, "active")))
      .toMatchObject({
        state: "failed_integrity",
        outcome: {
          status: "failed_integrity",
          stopReason: "integrity_failure",
        },
      });
    expect(repository.checkpoints.get("v3:retrieval:latest")).toMatchObject({
      state: "failed_integrity",
      outcome: {
        status: "failed_integrity",
        stopReason: "integrity_failure",
      },
      manifestId: null,
      publicationState: "not_applicable",
    });
    expect(repository.updates.at(-1)?.patch).toEqual({
      status: "failed_integrity",
      phase: "v3_retrieval_integrity_failure",
      error: null,
    });
    expect(repository.updates.map(({ patch }) => patch.status))
      .not.toContain("no_compatible_tracks");
    assertFenced(repository, plan);
  });

  test("moves a canonical full-selection integrity failure into technical quarantine", async () => {
    const { contract, plan } = canonicalQueryPlan();
    const repository = new MemoryRepository();
    const result = retrievalResult("failed_integrity", 25);

    await new PipelineV3WorkerExecution(repository, execution(result)).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: canonicalPayload(plan, contract),
    });

    expect(repository.persisted).toHaveLength(1);
    expect(repository.checkpoints.get("v3:retrieval:latest")).toMatchObject({
      state: "failed_integrity",
      manifestId: null,
      manifestRevisionId: null,
      manifestHash: null,
      publicationState: "not_applicable",
    });
    expect(repository.quarantines).toEqual([{
      runId: "run-v3",
      jobId: JOB_ID,
      workerId: "worker-v3",
      leaseGeneration: 7,
      reasonCode: "v3_retrieval_integrity_failure",
    }]);
    expect(repository.updates.map(({ patch }) => patch.status))
      .not.toContain("publishing");
  });

  test("permits a canonical empty outcome only with two healthy independent completed frontiers", async () => {
    const { contract, plan } = canonicalQueryPlan();
    const repository = new MemoryRepository();
    const base = retrievalResult("no_compatible_tracks", 0);
    const result: RetrievalResultV3 = {
      ...base,
      strategies: [
        {
          ...base.strategies[0]!,
          id: "curated_genre_scene:trusted_scoped_containers",
          discoveryDependencyIds: ["apple_catalog"],
        },
        {
          ...base.strategies[0]!,
          id: "curated_genre_scene:editorial_tracks",
          kind: "editorial_tracks",
          discoveryDependencyIds: ["hosted_web"],
        },
      ],
      dependencyOutages: [],
    };

    await new PipelineV3WorkerExecution(repository, execution(result)).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: canonicalPayload(plan, contract),
    });

    expect(repository.runtimeFeasibilitySnapshots).toHaveLength(1);
    expect(repository.runtimeFeasibilitySnapshots[0]).toMatchObject({
      phase: "initial",
      report: {
        state: "frontier_exhausted_under_policy",
        dependencyHealth: "healthy",
        runtimeEvidence: {
          source: "pipeline_v3_retrieval",
          budgets: {
            stopReason: "frontier_exhausted",
            maximumGlobalRounds: 48,
            maximumRawCandidates: 500,
            maximumCostUnits: 48,
          },
        },
        frontierProof: {
          completedFrontierIds: [
            "curated_genre_scene:editorial_tracks",
            "curated_genre_scene:trusted_scoped_containers",
          ],
          independentDependencyKeys: ["apple_catalog", "hosted_web"],
        },
      },
    });
    expect(repository.persisted).toHaveLength(1);
    expect(repository.persisted[0]?.result.outcome.status).toBe("no_compatible_tracks");
    expect(repository.updates.at(-1)?.patch).toMatchObject({
      status: "no_compatible_tracks",
      phase: "v3_no_compatible_tracks",
    });
    assertFenced(repository, plan);
  });

  test("turns an inadequately independent canonical empty frontier into an actionable decision", async () => {
    const { contract, plan } = canonicalQueryPlan();
    class RuntimeDecisionRepository extends MemoryRepository {
      readonly blockers: Array<Record<string, unknown>> = [];

      async getActivePlaylistContractRevision() {
        return {
          id: "77777777-7777-4777-8777-777777777777",
          contractHash: contract.semanticHash,
          contract: contract as unknown as Record<string, unknown>,
        };
      }

      async openPlaylistRunBlocker(input: Record<string, unknown>): Promise<string> {
        this.blockers.push(structuredClone(input));
        return "88888888-8888-4888-8888-888888888888";
      }
    }
    const repository = new RuntimeDecisionRepository();
    const base = retrievalResult("no_compatible_tracks", 0);
    const result: RetrievalResultV3 = {
      ...base,
      strategies: [
        {
          ...base.strategies[0]!,
          id: "curated_genre_scene:editorial_tracks",
          kind: "editorial_tracks",
          discoveryDependencyIds: ["hosted_web"],
        },
        {
          ...base.strategies[0]!,
          id: "curated_genre_scene:deficit_queries",
          kind: "deficit_query",
          discoveryDependencyIds: ["hosted_web"],
        },
      ],
      predicateDiagnostics: {
        qualificationsObserved: 20,
        scopeFailures: 20,
        failedMembershipPredicateIds: {
          "prompt:genre:disco": 20,
        },
        appleLookupCount: 0,
        appleProviderRequestCount: 0,
        rootCause: "under_discovery",
        recoveryAttemptCount: 0,
      },
    };

    await new PipelineV3WorkerExecution(repository, execution(result)).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: canonicalPayload(plan, contract),
    });

    expect(repository.runtimeFeasibilitySnapshots[0]?.report).toMatchObject({
      state: "unknown",
      frontierProof: null,
      limitingPredicateIds: ["prompt:genre:disco"],
    });
    expect(repository.persisted).toHaveLength(0);
    expect(repository.checkpoints.get("run_decision")).toMatchObject({
      reason: "runtime_feasibility_unknown",
      namedPredicates: [{
        clauseId: "prompt:genre:disco",
        label: "Disco",
      }],
      actions: {
        publishVerifiedPartial: false,
        anotherBoundedPass: false,
        reviseNamedPredicate: true,
      },
    });
    expect(repository.checkpoints.get("runtime_feasibility_decision")).toMatchObject({
      state: "needs_decision",
      feasibilityState: "unknown",
      feasibilityReportHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(repository.blockers[0]).toMatchObject({
      blockerKind: "scope_decision",
      dependencyKey: "runtime_feasibility",
    });
    expect(repository.updates.at(-1)?.patch).toMatchObject({
      status: "needs_decision",
      phase: "runtime_feasibility_unknown",
    });
    assertFenced(repository, plan);
  });

  test("routes a canonical empty result with an active upstream outage to dependency pause", async () => {
    const { contract, plan } = canonicalQueryPlan();
    const repository = new MemoryRepository();
    const base = retrievalResult("no_compatible_tracks", 0);
    const result: RetrievalResultV3 = {
      ...base,
      strategies: [{
        ...base.strategies[0]!,
        id: "curated_genre_scene:editorial_tracks",
        kind: "editorial_tracks",
        discoveryDependencyIds: ["hosted_web"],
        status: "circuit_open",
        providerFailures: 2,
      }],
      dependencyOutages: [{
        dependencyId: "hosted_web",
        failureClass: "rate_limited",
        outageCount: 1,
        failureAttempts: 2,
        active: true,
        circuitOpen: true,
        affectedStrategyIds: ["curated_genre_scene:editorial_tracks"],
      }],
    };

    await expect(new PipelineV3WorkerExecution(repository, execution(result)).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: canonicalPayload(plan, contract),
    })).rejects.toMatchObject({
      code: "pipeline_v3_dependency_unavailable",
    });

    expect(repository.runtimeFeasibilitySnapshots[0]?.report).toMatchObject({
      state: "unknown",
      dependencyHealth: "unavailable",
      reasonCodes: ["dependency_unavailable"],
      runtimeEvidence: {
        dependencyOutages: [{
          dependencyKey: "hosted_web",
          active: true,
          circuitOpen: true,
          failureAttempts: 2,
        }],
      },
    });
    expect(repository.persisted).toHaveLength(0);
    expect(repository.updates.at(-1)?.patch).toMatchObject({
      status: "queued",
      phase: "v3_waiting_for_retrieval_provider",
    });
    assertFenced(repository, plan);
  });

  test("fences semantic recovery out of immutable schema-1 compatibility jobs", async () => {
    const plan = legacyQueryPlan();
    const repository = new MemoryRepository();
    const port = execution(retrievalResult("no_compatible_tracks", 0));

    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: payload(plan),
    });

    expect(port.execute).toHaveBeenCalledWith(expect.objectContaining({
      semanticRecoveryEnabled: false,
    }));
  });

  test("rehydrates retrieval limits from the immutable run snapshot", async () => {
    const plan = queryPlan();
    const selection = resolveRunSpecV3(createRunSpecV3({
      prompt: "25 influential disco recordings",
      requestedTrackCount: 25,
      storefront: "us",
    }), []);
    const snapshot = createPipelinePolicySnapshotV3({
      plan: selection,
      environment: {
        PIPELINE_V3_MAX_ROUNDS: "7",
        PIPELINE_V3_MAX_RAW_CANDIDATES: "777",
        PIPELINE_V3_MAX_TOOL_CALLS: "9",
      },
      capturedAt: "2026-07-20T12:00:00.000Z",
    });
    expect(retrievalPolicyV3FromPipelinePolicySnapshot(snapshot)).toEqual({
      maximumGlobalRounds: 7,
      maximumRawCandidates: 777,
      candidateGoal: 55,
      qualifiedPoolGoal: 30,
      maximumCostUnits: 9,
      deadlineAtEpochMs: null,
      maximumProviderFailuresPerStrategy: 2,
    });

    const repository = new MemoryRepository();
    const port = execution(retrievalResult("exact_ready", 25));
    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: { prompt: "25 influential disco recordings", pipelinePolicySnapshot: snapshot },
      queryPlan: plan,
      payload: payload(plan),
    });

    expect(port.execute).toHaveBeenCalledWith(expect.objectContaining({
      policy: {
        maximumGlobalRounds: 7,
        maximumRawCandidates: 777,
        candidateGoal: 55,
        qualifiedPoolGoal: 30,
        maximumCostUnits: 9,
        deadlineAtEpochMs: null,
        maximumProviderFailuresPerStrategy: 2,
      },
    }));
  });

  test("turns the cumulative 15-minute compute boundary into a decision, not scarcity", async () => {
    const plan = queryPlan();
    const repository = new MemoryRepository();
    const base = retrievalResult("needs_decision", 0);
    const result: RetrievalResultV3 = {
      ...base,
      outcome: {
        ...base.outcome,
        status: "needs_decision",
        stopReason: "deadline_reached",
      },
      deficit: {
        ...base.deficit,
        primaryShortfallReason: "deadline_reached",
      },
      publicationBoundary: {
        appleWriteAccess: "forbidden",
        manifestDisposition: "no_manifest",
      },
    };
    const port = execution(result);
    const exhaustedPayload = {
      ...payload(plan),
      __contractActiveComputeConsumedMs: PIPELINE_V3_ACTIVE_COMPUTE_LIMIT_MS,
    };
    const before = Date.now();

    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: exhaustedPayload,
    });

    const deadline = vi.mocked(port.execute).mock.calls[0]?.[0].policy.deadlineAtEpochMs;
    expect(deadline).toBeTypeOf("number");
    expect(deadline).toBeGreaterThanOrEqual(before);
    expect(deadline).toBeLessThanOrEqual(Date.now());
    expect(repository.persisted).toHaveLength(0);
    expect(repository.updates.at(-1)?.patch).toEqual({
      status: "needs_decision",
      phase: "active_compute_limit_reached",
      error: null,
    });
    expect(repository.checkpoints.get("active_compute_limit")).toMatchObject({
      state: "needs_decision",
      activeComputeLimitMs: PIPELINE_V3_ACTIVE_COMPUTE_LIMIT_MS,
    });
    expect(repository.checkpoints.get(v3RetrievalStageKey(plan, "active"))).toMatchObject({
      outcome: { status: "needs_decision", stopReason: "deadline_reached" },
    });
    assertFenced(repository, plan);
  });

  test("persists a hash-bound 15-minute decision without freezing an unchanged-contract partial", async () => {
    const plan = queryPlan();
    const contract = compilePlaylistContractRevisionV1({
      contractId: "disco-compute-boundary",
      rawPrompt: "25 influential disco recordings from the 1970s",
      requestedTrackCount: 25,
      locale: "en",
      storefront: "us",
      clauses: [
        {
          id: "prompt:genre:disco",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "genre",
          operator: "require",
          values: ["disco"],
          source: { provenance: "prompt", text: "Disco" },
        },
        {
          id: "prompt:era:1970s",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "era",
          operator: "require",
          values: ["1970s"],
          source: { provenance: "prompt", text: "Recorded in the 1970s" },
        },
      ],
      trackPredicate: {
        op: "all",
        children: [
          { op: "clause", clauseId: "prompt:genre:disco" },
          { op: "clause", clauseId: "prompt:era:1970s" },
        ],
      },
    });
    class DecisionRepository extends MemoryRepository {
      readonly blockers: Array<Record<string, unknown>> = [];

      async getActivePlaylistContractRevision() {
        return {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          contractHash: contract.semanticHash,
          contract: contract as unknown as Record<string, unknown>,
        };
      }

      async openPlaylistRunBlocker(input: Record<string, unknown>): Promise<string> {
        this.blockers.push(structuredClone(input));
        return "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      }
    }
    const repository = new DecisionRepository();
    const base = retrievalResult("needs_decision", 12);
    const result: RetrievalResultV3 = {
      ...base,
      outcome: {
        ...base.outcome,
        status: "needs_decision",
        stopReason: "deadline_reached",
      },
      deficit: {
        ...base.deficit,
        primaryShortfallReason: "deadline_reached",
      },
      strategies: base.strategies.map((strategy) => ({
        ...strategy,
        status: "available",
      })),
      predicateDiagnostics: {
        qualificationsObserved: 30,
        scopeFailures: 14,
        failedMembershipPredicateIds: {
          "prompt:era:1970s": 14,
        },
        appleLookupCount: 12,
        appleProviderRequestCount: 3,
        rootCause: "under_discovery",
        recoveryAttemptCount: 0,
      },
    };
    const port = execution(result);
    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: {
        ...payload(plan),
        __contractRevisionDatabaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        __contractActiveComputeConsumedMs: PIPELINE_V3_ACTIVE_COMPUTE_LIMIT_MS,
      },
    });

    expect(repository.persisted).toHaveLength(0);
    expect(repository.checkpoints.has("partial_ready")).toBe(false);
    expect(repository.checkpoints.get("run_decision")).toMatchObject({
      schemaVersion: "genio-run-decision/v1",
      reason: "active_compute_limit",
      verifiedTrackCount: 12,
      remainingStrategyCount: 1,
      namedPredicates: [{
        clauseId: "prompt:era:1970s",
        label: "Recorded in the 1970s",
      }],
      actions: {
        anotherBoundedPass: true,
        publishVerifiedPartial: true,
        reduceCount: true,
      },
    });
    expect(repository.blockers[0]).toMatchObject({
      blockerKind: "scope_decision",
      dependencyKey: "active_compute",
      state: {
        decisionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
  });

  test("routes a canonical quality partial to a decision without creating a manifest", async () => {
    const canonical = canonicalQueryPlan(25);
    class PartialDecisionRepository extends MemoryRepository {
      readonly blockers: Array<Record<string, unknown>> = [];

      async getActivePlaylistContractRevision() {
        return {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          contractHash: canonical.contract.semanticHash,
          contract: canonical.contract as unknown as Record<string, unknown>,
        };
      }

      async openPlaylistRunBlocker(input: Record<string, unknown>): Promise<string> {
        this.blockers.push(structuredClone(input));
        return "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      }
    }
    const repository = new PartialDecisionRepository();
    const base = retrievalResult("partial_ready", 14);
    const result: RetrievalResultV3 = {
      ...base,
      outcome: {
        ...base.outcome,
        status: "partial_ready",
        stopReason: "central_quality_floor",
        requiresPartialPublicationDecision: true,
      },
      deficit: {
        ...base.deficit,
        primaryShortfallReason: "central_quality_floor",
      },
    };

    await new PipelineV3WorkerExecution(repository, execution(result)).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: canonical.plan,
      payload: {
        ...canonicalPayload(canonical.plan, canonical.contract),
        __contractRevisionDatabaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    });

    expect(repository.persisted).toHaveLength(0);
    expect(repository.checkpoints.has("partial_ready")).toBe(false);
    expect(repository.checkpoints.get("run_decision")).toMatchObject({
      reason: "central_quality_floor",
      verifiedTrackCount: 14,
      actions: {
        publishVerifiedPartial: false,
        reduceCount: true,
      },
    });
    expect(repository.updates.at(-1)?.patch).toEqual({
      status: "needs_decision",
      phase: "central_quality_floor_missed",
      error: null,
    });
  });

  test("maps optimizer constraint failure to an explicit non-publishable decision", async () => {
    const plan = queryPlan();
    const contract = compilePlaylistContractRevisionV1({
      contractId: "disco-playlist-constraints",
      rawPrompt: "25 disco recordings with at least 20 distinct artists",
      requestedTrackCount: 25,
      locale: "en",
      storefront: "us",
      clauses: [
        {
          id: "prompt:genre:disco",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "genre",
          operator: "require",
          values: ["disco"],
          source: { provenance: "prompt", text: "Disco" },
        },
        {
          id: "prompt:diversity:artists",
          kind: "quota_diversity",
          scope: "playlist",
          hardness: "hard",
          axis: "artist_diversity",
          operator: "balance",
          values: ["at least 20 distinct artists"],
          source: { provenance: "prompt", text: "At least 20 distinct artists" },
        },
      ],
      trackPredicate: { op: "clause", clauseId: "prompt:genre:disco" },
      playlistConstraints: [{
        id: "quota:distinct-artists",
        clauseId: "prompt:diversity:artists",
        predicate: { op: "clause", clauseId: "prompt:genre:disco" },
        minimumCount: 20,
        maximumCount: null,
        minimumRatio: null,
        maximumRatio: null,
      }],
    });
    class OptimizerDecisionRepository extends MemoryRepository {
      readonly blockers: Array<Record<string, unknown>> = [];

      async getActivePlaylistContractRevision() {
        return {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          contractHash: contract.semanticHash,
          contract: contract as unknown as Record<string, unknown>,
        };
      }

      async openPlaylistRunBlocker(input: Record<string, unknown>): Promise<string> {
        this.blockers.push(structuredClone(input));
        return "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      }
    }
    const repository = new OptimizerDecisionRepository();
    const base = retrievalResult("needs_decision", 18);
    const result: RetrievalResultV3 = {
      ...base,
      outcome: {
        ...base.outcome,
        status: "needs_decision",
        stopReason: "playlist_optimization_constraints",
        requiresPartialPublicationDecision: true,
      },
      deficit: {
        ...base.deficit,
        primaryShortfallReason: "playlist_optimization_constraints",
      },
      playlistOptimization: {
        policyVersion: "playlist_optimizer_v2",
        exact: false,
        evidenceQualifiedCandidateCount: 25,
        unmetConstraints: ["minimum_distinct_artists:12/20"],
        distinct: {
          artists: 12,
          albums: 18,
          eras: 1,
          scenes: 1,
          geographies: 1,
        },
        familiarTrackCount: 8,
      },
      publicationBoundary: {
        appleWriteAccess: "forbidden",
        manifestDisposition: "no_manifest",
      },
    };

    await new PipelineV3WorkerExecution(repository, execution(result)).process({
      runId: "run-v3",
      run: workerRun("25 disco recordings with at least 20 distinct artists"),
      queryPlan: plan,
      payload: {
        ...payload(plan),
        __contractRevisionDatabaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    });

    expect(repository.persisted).toHaveLength(0);
    expect(repository.checkpoints.get("playlist_constraints_decision")).toMatchObject({
      state: "needs_decision",
      reasonCode: "playlist_optimization_constraints",
      playlistOptimization: {
        exact: false,
        unmetConstraints: ["minimum_distinct_artists:12/20"],
      },
    });
    expect(repository.checkpoints.get("run_decision")).toMatchObject({
      reason: "playlist_optimization_constraints",
      namedPredicates: [{
        clauseId: "prompt:diversity:artists",
        label: "At least 20 distinct artists",
      }],
      actions: {
        publishVerifiedPartial: false,
        reviseNamedPredicate: true,
        reduceCount: true,
      },
    });
    expect(repository.blockers[0]).toMatchObject({
      blockerKind: "scope_decision",
      dependencyKey: "playlist_constraints",
    });
    expect(repository.updates.at(-1)?.patch).toEqual({
      status: "needs_decision",
      phase: "playlist_optimization_constraints_missed",
      error: null,
    });
  });

  test("offers one fenced predicate rescue before falling back to the 15-minute panel", async () => {
    const plan = queryPlan();
    const contract = compilePlaylistContractRevisionV1({
      contractId: "disco-rescue-boundary",
      rawPrompt: "25 influential disco recordings from the 1970s",
      requestedTrackCount: 25,
      locale: "en",
      storefront: "us",
      clauses: [
        {
          id: "prompt:genre:disco",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "genre",
          operator: "require",
          values: ["disco"],
          source: { provenance: "prompt", text: "Disco" },
        },
        {
          id: "prompt:era:1970s",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "era",
          operator: "require",
          values: ["1970s"],
          source: { provenance: "prompt", text: "Recorded in the 1970s" },
        },
      ],
      trackPredicate: {
        op: "all",
        children: [
          { op: "clause", clauseId: "prompt:genre:disco" },
          { op: "clause", clauseId: "prompt:era:1970s" },
        ],
      },
    });
    class RescueRepository extends MemoryRepository {
      readonly rescueInputs: Array<Record<string, unknown>> = [];
      readonly blockers: Array<Record<string, unknown>> = [];

      async getActivePlaylistContractRevision() {
        return {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          contractHash: contract.semanticHash,
          contract: contract as unknown as Record<string, unknown>,
        };
      }

      async preparePlaylistRunRescueGuidance(input: Record<string, unknown>) {
        this.rescueInputs.push(structuredClone(input));
        return { questionSetHash: "e".repeat(64) };
      }

      async openPlaylistRunBlocker(input: Record<string, unknown>): Promise<string> {
        this.blockers.push(structuredClone(input));
        return "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      }
    }
    const repository = new RescueRepository();
    const base = retrievalResult("needs_decision", 12);
    const result: RetrievalResultV3 = {
      ...base,
      outcome: {
        ...base.outcome,
        status: "needs_decision",
        stopReason: "deadline_reached",
      },
      deficit: {
        ...base.deficit,
        primaryShortfallReason: "deadline_reached",
      },
      predicateDiagnostics: {
        qualificationsObserved: 30,
        scopeFailures: 14,
        failedMembershipPredicateIds: {
          "prompt:era:1970s": 14,
        },
        appleLookupCount: 12,
        appleProviderRequestCount: 3,
        rootCause: "under_discovery",
        recoveryAttemptCount: 0,
      },
    };

    await new PipelineV3WorkerExecution(repository, execution(result)).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings from the 1970s"),
      queryPlan: plan,
      payload: {
        ...payload(plan),
        __contractRevisionDatabaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    });

    expect(repository.rescueInputs).toHaveLength(1);
    expect(repository.rescueInputs[0]).toMatchObject({
      runId: "run-v3",
      contractRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      contractSemanticHash: contract.semanticHash,
      limitingClauseIds: ["prompt:era:1970s"],
      fence: {
        jobId: JOB_ID,
        leaseEpoch: 7,
        queryPlanRevisionId: QUERY_PLAN_REVISION_ID,
      },
    });
    expect(repository.blockers).toHaveLength(0);
    expect(repository.checkpoints.get("run_decision")).toMatchObject({
      reason: "active_compute_limit",
      actions: { reviseNamedPredicate: true },
    });
    expect(repository.updates.at(-1)?.patch).toEqual({
      status: "needs_decision",
      phase: "rescue_guidance_required",
      error: null,
    });
  });

  test("fails closed when immutable retrieval ceilings conflict", async () => {
    const plan = queryPlan();
    const run = workerRun("25 influential disco recordings");
    const snapshot = structuredClone(run.pipelinePolicySnapshot);
    snapshot.catalogLimits.maximumRawDiscoveryGoal += 1;
    const repository = new MemoryRepository();
    const port = execution(retrievalResult("exact_ready", 25));

    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: { ...run, pipelinePolicySnapshot: snapshot },
      queryPlan: plan,
      payload: payload(plan),
    });

    expect(port.execute).not.toHaveBeenCalled();
    expect(repository.updates.at(-1)?.patch).toEqual({
      status: "failed_integrity",
      phase: "v3_retrieval_policy_snapshot_invalid",
      error: null,
    });
    expect([...repository.checkpoints.values()]).toContainEqual(expect.objectContaining({
      state: "failed_integrity",
      code: "v3_retrieval_policy_snapshot_invalid",
    }));
  });

  test("claims semantic recovery under the active lease before persisting the result", async () => {
    const plan = queryPlan();
    const repository = new MemoryRepository();
    const result = retrievalResult("exact_ready", 25);
    const port: PipelineV3RetrievalExecutionPort = {
      execute: vi.fn(async (request) => {
        await request.claimSemanticRecovery(semanticRecoveryRevision(request.plan));
        expect(repository.persisted).toHaveLength(0);
        return result;
      }),
    };

    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: payload(plan),
    });

    expect(repository.semanticRecoveryClaims).toHaveLength(1);
    expect(repository.semanticRecoveryClaims[0]).toMatchObject({
      runId: "run-v3",
      queryPlan: plan,
      revision: { revision: 2, parentRevision: 1 },
    });
    expect(repository.persisted).toHaveLength(1);
    assertFenced(repository, plan);
  });

  test("settles a conflicting semantic-recovery replay as failed integrity", async () => {
    const plan = queryPlan();
    const repository = new MemoryRepository();
    repository.claimPipelineV3SemanticRecovery = vi.fn(async () => {
      throw Object.assign(new Error("conflicting semantic recovery"), {
        code: "pipeline_v3_semantic_recovery_conflict",
      });
    });
    const port: PipelineV3RetrievalExecutionPort = {
      execute: vi.fn(async (request) => {
        await request.claimSemanticRecovery(semanticRecoveryRevision(request.plan));
        return retrievalResult("exact_ready", 25);
      }),
    };

    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: payload(plan),
    });

    expect(repository.persisted).toHaveLength(0);
    expect(repository.updates.at(-1)?.patch).toEqual({
      status: "failed_integrity",
      phase: "v3_semantic_recovery_claim_conflict",
      error: null,
    });
    expect([...repository.checkpoints.values()]).toContainEqual(expect.objectContaining({
      state: "failed_integrity",
      code: "v3_semantic_recovery_claim_conflict",
      claimErrorCode: "pipeline_v3_semantic_recovery_conflict",
    }));
  });

  test("fails closed when the immutable V3 model route is missing", async () => {
    const plan = queryPlan();
    const repository = new MemoryRepository();
    const port = execution(retrievalResult("exact_ready", 25));
    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: { prompt: "25 influential disco recordings", pipelinePolicySnapshot: null },
      queryPlan: plan,
      payload: payload(plan),
    });

    expect(port.execute).not.toHaveBeenCalled();
    expect(repository.updates.at(-1)?.patch).toEqual({
      status: "failed_integrity",
      phase: "v3_model_route_snapshot_invalid",
      error: null,
    });
    expect([...repository.checkpoints.values()]).toContainEqual(expect.objectContaining({
      state: "failed_integrity",
      code: "v3_model_route_snapshot_invalid",
    }));
  });

  test("an exact manifest waits durably when the owner Apple authorization is unavailable", async () => {
    const plan = queryPlan();
    const repository = new MemoryRepository("waiting_for_apple_authorization");
    const port = execution(retrievalResult("exact_ready", 25));
    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: payload(plan),
    });

    expect(repository.updates.at(-1)?.patch).toEqual({
      status: "waiting_for_apple_authorization",
      phase: "apple_authorization",
      error: null,
    });
    expect(repository.checkpoints.get("v3:retrieval:latest")).toMatchObject({
      manifestId: MANIFEST_ID,
      manifestRevisionId: MANIFEST_REVISION_ID,
      manifestHash: MANIFEST_HASH,
      publicationState: "waiting_for_apple_authorization",
    });
    expect(repository.persisted).toHaveLength(1);
    assertFenced(repository, plan);
  });

  test("shadow retrieval persists observations but cannot hand off to publication", async () => {
    const plan = queryPlan();
    const repository = new MemoryRepository();
    const port = execution(retrievalResult("exact_ready", 25, 25, "shadow"));
    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: payload(plan, "shadow"),
    });

    expect(repository.updates.at(-1)?.patch).toEqual({
      status: "complete",
      phase: "v3_shadow_exact_ready",
      error: null,
    });
    expect(repository.checkpoints.get("v3:retrieval:latest")).toMatchObject({
      executionMode: "shadow",
      publicationBoundary: {
        appleWriteAccess: "forbidden",
        manifestDisposition: "shadow_manifest_only",
      },
    });
    expect(repository.checkpoints.has("partial_ready")).toBe(false);
    expect(repository.persisted).toHaveLength(0);
    assertFenced(repository, plan, "shadow");
  });

  test("fails closed into a durable waiting state when no retrieval provider is configured", async () => {
    const plan = queryPlan();
    const repository = new MemoryRepository();
    await expect(new PipelineV3WorkerExecution(repository, null).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: payload(plan),
    })).rejects.toBeInstanceOf(PipelineV3DependencyUnavailableError);

    expect(repository.updates.at(-1)?.patch).toEqual({
      status: "queued",
      phase: "v3_waiting_for_retrieval_provider",
      error: null,
    });
    expect([...repository.checkpoints.values()]).toContainEqual(expect.objectContaining({
      state: "waiting_provider",
      reasonCode: "v3_retrieval_provider_unavailable",
    }));
    expect(repository.persisted).toHaveLength(0);
    assertFenced(repository, plan);
  });

  test("maps a bounded optimizer miss to visible technical recovery instead of a scope decision", async () => {
    const plan = queryPlan();
    const repository = new MemoryRepository();
    const port: PipelineV3RetrievalExecutionPort = {
      execute: vi.fn(async () => {
        throw new RetrievalPlaylistOptimizationBudgetExceededErrorV3(
          "bounded exact rescue exhausted",
          optimizerRetrySeed(),
        );
      }),
    };

    const failure = new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: payload(plan),
    });
    await expect(failure).rejects.toBeInstanceOf(
      PipelineV3OptimizerComputeBudgetError,
    );
    await expect(failure).rejects.toMatchObject({
      budgetPass: 1,
      retriable: true,
    });

    expect(repository.checkpoints.get(v3RetrievalStageKey(plan, "active")))
      .toMatchObject({
        state: "waiting_compute",
        code: "optimizer_search_budget_exhausted",
        retryable: true,
        budgetPass: 1,
        nextBudgetPass: 2,
        providerCallPermitted: false,
        optimizerRetrySeed: expect.objectContaining({
          providerCallPermitted: false,
          approvedStrategyIds: [],
        }),
      });
    expect(repository.updates.at(-1)?.patch).toEqual({
      status: "recovering",
      phase: "optimizer_search_budget_exhausted",
      error: null,
    });
    expect(repository.persisted).toHaveLength(0);
    assertFenced(repository, plan);
  });

  test("persists a second larger optimizer pass before deterministic compute quarantine", async () => {
    const plan = queryPlan();
    const repository = new MemoryRepository();
    const stageKey = v3RetrievalStageKey(plan, "active");
    repository.checkpoints.set(stageKey, {
      schemaVersion: "genio-pipeline-v3-worker-checkpoint/v1",
      state: "waiting_compute",
      stageKey,
      queryPlanHash: queryPlanV3Hash(plan),
      code: "optimizer_search_budget_exhausted",
      retryable: true,
      budgetPass: 1,
      maximumBudgetPasses: 2,
      nextBudgetPass: 2,
      providerCallPermitted: false,
      optimizerRetrySeed: optimizerRetrySeed(),
    });
    const port: PipelineV3RetrievalExecutionPort = {
      execute: vi.fn(async (input) => {
        expect(input.continuation).toMatchObject({
          providerCallPermitted: false,
          approvedStrategyIds: [],
        });
        throw new RetrievalPlaylistOptimizationBudgetExceededErrorV3(
          "larger bounded exact rescue exhausted",
          optimizerRetrySeed(),
        );
      }),
    };

    await expect(new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: payload(plan),
    })).rejects.toMatchObject({
      code: "optimizer_search_budget_exhausted",
      budgetPass: 2,
      retriable: false,
    });

    expect(port.execute).toHaveBeenCalledTimes(1);
    expect(repository.checkpoints.get(stageKey)).toMatchObject({
      state: "waiting_compute",
      code: "optimizer_search_budget_exhausted",
      retryable: false,
      budgetPass: 2,
      maximumBudgetPasses: 2,
      nextBudgetPass: null,
    });
    expect(repository.updates.at(-1)?.patch).toEqual({
      status: "recovering",
      phase: "optimizer_search_budget_exhausted",
      error: null,
    });
    expect(repository.persisted).toHaveLength(0);
    assertFenced(repository, plan);
  });

  test("keeps provider-failed retrieval on the durable retry path instead of terminalizing failed_system", async () => {
    const plan = queryPlan();
    const repository = new MemoryRepository();
    const retryAfterUntil = new Date("2030-01-02T03:04:05.000Z");
    const base = retrievalResult("failed_system", 0);
    const port = execution({
      ...base,
      dependencyOutages: [{
        dependencyId: "hosted_web",
        failureClass: "rate_limited",
        outageCount: 1,
        failureAttempts: 3,
        active: true,
        circuitOpen: false,
        retryAfterUntil: retryAfterUntil.toISOString(),
        affectedStrategyIds: [base.strategies[0]!.id],
      }],
    });

    await expect(new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: payload(plan),
    })).rejects.toMatchObject({
      code: "pipeline_v3_dependency_unavailable",
      dependencyKey: "v3_retrieval_provider",
      reasonCode: "v3_retrieval_provider_failed",
      retryAfterUntil,
      failureClass: "rate_limited",
      retriable: true,
    });

    expect(repository.persisted).toHaveLength(0);
    expect(repository.updates.at(-1)?.patch).toEqual({
      status: "queued",
      phase: "v3_waiting_for_retrieval_provider",
      error: null,
    });
    expect(repository.checkpoints.get(v3RetrievalStageKey(plan, "active"))).toMatchObject({
      state: "waiting_provider",
      reasonCode: "v3_retrieval_provider_failed",
      outcome: { status: "failed_system", stopReason: "provider_failure" },
      leaseEpoch: 7,
      retryAfterUntil: retryAfterUntil.toISOString(),
      failureClass: "rate_limited",
    });
    expect(repository.checkpoints.get("v3:retrieval:latest")).toMatchObject({
      state: "waiting_provider",
      reasonCode: "v3_retrieval_provider_failed",
      failureClass: "rate_limited",
    });
    await expect(new PipelineV3WorkerExecution(repository, null).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: payload(plan),
    })).rejects.toMatchObject({
      failureClass: "rate_limited",
      retriable: true,
    });
    assertFenced(repository, plan);
  });

  test.each([
    "authorization",
    "quota",
    "invalid_request",
    "configuration",
  ] as const)(
    "preserves non-retryable provider %s failures across the worker execution boundary",
    async (failureClass) => {
      const plan = queryPlan();
      const repository = new MemoryRepository();
      const port: PipelineV3RetrievalExecutionPort = {
        execute: vi.fn(async () => {
          throw new RetrievalDependencyErrorV3(
            "provider rejected request",
            ["hosted_web"],
            null,
            failureClass,
          );
        }),
      };

      await expect(new PipelineV3WorkerExecution(repository, port).process({
        runId: "run-v3",
        run: workerRun("25 influential disco recordings"),
        queryPlan: plan,
        payload: payload(plan),
      })).rejects.toMatchObject({
        code: "pipeline_v3_dependency_unavailable",
        dependencyKey: "v3_retrieval_provider",
        reasonCode: `v3_retrieval_provider_${failureClass}`,
        failureClass,
        retriable: false,
      });

      expect(repository.persisted).toHaveLength(0);
      expect([...repository.checkpoints.values()])
        .not.toContainEqual(expect.objectContaining({ state: "waiting_provider" }));
      expect(repository.checkpoints.get(v3RetrievalStageKey(plan, "active")))
        .toMatchObject({
          state: "failed_integrity",
          code: "v3_retrieval_provider_non_retryable",
          reasonCode: `v3_retrieval_provider_${failureClass}`,
          failureClass,
          retryable: false,
          nextAction: "contact_support",
        });
      expect(repository.updates.at(-1)?.patch).toEqual({
        status: "failed_integrity",
        phase: `v3_retrieval_provider_${failureClass}`,
        error: null,
      });
    },
  );

  test("a non-retryable outage class wins mixed dependency aggregation and never creates a waiting checkpoint", async () => {
    const plan = queryPlan();
    const repository = new MemoryRepository();
    const base = retrievalResult("failed_system", 0);
    const port = execution({
      ...base,
      dependencyOutages: [
        {
          dependencyId: "hosted_web",
          failureClass: "rate_limited",
          outageCount: 1,
          failureAttempts: 3,
          active: true,
          circuitOpen: false,
          affectedStrategyIds: ["hosted"],
        },
        {
          dependencyId: "apple_catalog",
          failureClass: "quota",
          outageCount: 1,
          failureAttempts: 1,
          active: true,
          circuitOpen: false,
          affectedStrategyIds: ["catalog"],
        },
      ],
    });

    await expect(new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: payload(plan),
    })).rejects.toMatchObject({
      failureClass: "quota",
      retriable: false,
    });
    expect(repository.checkpoints.get(v3RetrievalStageKey(plan, "active")))
      .toMatchObject({
        state: "failed_integrity",
        failureClass: "quota",
        retryable: false,
      });
    expect([...repository.checkpoints.values()])
      .not.toContainEqual(expect.objectContaining({ state: "waiting_provider" }));
  });

  test("resumes a provider-paused stage only from a successor lease", async () => {
    const plan = queryPlan();
    const repository = new MemoryRepository();
    const originalPayload = payload(plan);
    await expect(new PipelineV3WorkerExecution(repository, null).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: originalPayload,
    })).rejects.toBeInstanceOf(PipelineV3DependencyUnavailableError);
    expect(repository.checkpoints.get(v3RetrievalStageKey(plan, "active")))
      .toMatchObject({ state: "waiting_provider", leaseEpoch: 7 });

    const port = execution(retrievalResult("exact_ready", 25));
    await expect(new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: originalPayload,
    })).rejects.toBeInstanceOf(PipelineV3DependencyUnavailableError);
    expect(port.execute).not.toHaveBeenCalled();

    const successorPayload: PipelineV3WorkerPayload = {
      ...originalPayload,
      __jobLeaseEpoch: 8,
      __jobId: randomUUID(),
      __jobWorkerId: "worker-v3-successor",
    };
    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: successorPayload,
    });

    expect(port.execute).toHaveBeenCalledOnce();
    expect(repository.updates.at(-1)?.patch).toMatchObject({
      status: "publishing",
      phase: "publication_queued",
    });
    expect(repository.persisted.at(-1)?.fence).toMatchObject({
      jobId: successorPayload.__jobId,
      workerId: "worker-v3-successor",
      leaseEpoch: 8,
      stageKey: v3RetrievalStageKey(plan, "active"),
    });
  });

  test("pauses exhaustive work before retrieval until a governed source-frontier builder exists", async () => {
    const plan = factualQueryPlan({ exhaustive: true });
    const repository = new MemoryRepository();
    const port = execution(retrievalResult("no_compatible_tracks", 0));
    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("Every released recording Paulinho da Costa performed on"),
      queryPlan: plan,
      payload: payload(plan),
    });

    expect(port.execute).not.toHaveBeenCalled();
    expect(repository.persisted).toHaveLength(0);
    expect(repository.updates.at(-1)?.patch).toEqual({
      status: "waiting_for_corpus_review",
      phase: "v3_waiting_for_exhaustive_corpus_frontier",
      error: null,
    });
    expect(repository.checkpoints.get("v3:corpus:action-required")).toMatchObject({
      state: "owner_action_required",
      actionKind: "corpus_review",
      reasonCode: "v3_exhaustive_frontier_builder_unavailable",
      engines: ["exhaustive"],
    });
    assertFenced(repository, plan);
  });

  test("pauses a cold factual snapshot instead of reporting a misleading zero-track result", async () => {
    const plan = factualQueryPlan();
    const repository = new MemoryRepository();
    const port = execution(factualNoCompatibleResult(0));
    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("Recordings Paulinho da Costa performed on"),
      queryPlan: plan,
      payload: payload(plan),
    });

    expect(port.execute).toHaveBeenCalledOnce();
    expect(repository.persisted).toHaveLength(0);
    expect(repository.updates.at(-1)?.patch).toEqual({
      status: "waiting_for_corpus_review",
      phase: "v3_waiting_for_factual_corpus_review",
      error: null,
    });
    expect(repository.checkpoints.get("v3:retrieval:latest")).toMatchObject({
      state: "owner_action_required",
      reasonCode: "v3_factual_graph_snapshot_has_no_qualified_candidates",
      outcome: { status: "no_compatible_tracks" },
      manifestId: null,
      publicationState: "not_applicable",
    });
    assertFenced(repository, plan);
  });

  test("builds and quarantines a cold factual corpus before pausing for owner review", async () => {
    const plan = factualQueryPlan();
    const repository = new MemoryRepository();
    const port = execution(factualNoCompatibleResult(0));
    const corpusBuilder = {
      build: vi.fn(async (): Promise<ColdCorpusBuildResultV3> => ({
        schema: "genio-v3-cold-corpus/v1",
        responseId: "resp-corpus",
        observations: [{
          artist: "Michael Jackson",
          title: "Human Nature",
          album: "Thriller",
          predicate: "performed_on",
          relationship: "percussion",
          role: "percussion",
          creditScope: "exact_recording",
          sourceUrl: "https://example.com/credit",
          sourceTitle: "Credit",
          supportExcerpt: "Track-level percussion credit.",
          confidence: 0.9,
        }],
        sourceCount: 1,
        advertisedTotal: null,
        recoveredTotal: 1,
        nextCursor: null,
        enumerationComplete: false,
        zeroNewEvidenceGapPasses: 0,
        gaps: ["Additional sources remain unresolved."],
      })),
    };
    await new PipelineV3WorkerExecution(repository, port, corpusBuilder).process({
      runId: "run-v3",
      run: workerRun("Recordings Paulinho da Costa performed on"),
      queryPlan: plan,
      payload: payload(plan),
    });

    expect(corpusBuilder.build).toHaveBeenCalledOnce();
    expect(repository.corpusIngestions).toHaveLength(1);
    expect(repository.persisted).toHaveLength(0);
    expect(repository.checkpoints.get("v3:corpus:action-required")).toMatchObject({
      corpusBuild: {
        sourceDocumentCount: 1,
        observationCount: 1,
        enumerationComplete: false,
        unresolvedGapCount: 2,
      },
    });
    expect(repository.updates.at(-1)?.patch.status).toBe("waiting_for_corpus_review");
  });

  test("keeps a legitimate factual hard-constraint rejection as no compatible tracks", async () => {
    const plan = factualQueryPlan();
    const repository = new MemoryRepository();
    const port = execution(factualNoCompatibleResult(3));
    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("Recordings Paulinho da Costa performed on"),
      queryPlan: plan,
      payload: payload(plan),
    });

    expect(port.execute).toHaveBeenCalledOnce();
    expect(repository.persisted).toHaveLength(1);
    expect(repository.updates.at(-1)?.patch).toEqual({
      status: "no_compatible_tracks",
      phase: "v3_no_compatible_tracks",
      error: null,
    });
    expect(repository.checkpoints.has("v3:corpus:action-required")).toBe(false);
    assertFenced(repository, plan);
  });

  test("rejects a mismatched stage identity before invoking retrieval", async () => {
    const plan = queryPlan();
    const leasedStageKey = "v3-retrieval:active:stale-plan";
    const repository = new FenceValidatingMemoryRepository(leasedStageKey);
    const port = execution(retrievalResult("exact_ready", 25));
    const badPayload = { ...payload(plan), __jobStageKey: leasedStageKey };
    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: badPayload,
    });

    expect(port.execute).not.toHaveBeenCalled();
    expect(repository.updates.at(-1)?.patch).toMatchObject({
      status: "failed_integrity",
      phase: "v3_stage_execution_key_mismatch",
    });
    expect(repository.persisted).toHaveLength(0);
    for (const write of repository.writes) expect(write.fence?.stageKey).toBe(leasedStageKey);
    for (const update of repository.updates) expect(update.fence?.stageKey).toBe(leasedStageKey);
  });

  test("requires the complete lease fence before any durable mutation", async () => {
    const plan = queryPlan();
    const repository = new MemoryRepository();
    const port = execution(retrievalResult("exact_ready", 25));
    await expect(new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: {
        v3ExecutionMode: "active",
        __jobStageKey: v3RetrievalStageKey(plan, "active"),
        __jobLeaseEpoch: 7,
        __queryPlanRevisionId: QUERY_PLAN_REVISION_ID,
        __jobId: randomUUID(),
      },
    })).rejects.toThrow("missing its durable lease fence");
    expect(repository.writes).toHaveLength(0);
    expect(repository.updates).toHaveLength(0);
    expect(repository.persisted).toHaveLength(0);
    expect(port.execute).not.toHaveBeenCalled();
  });

  test("flushes separated discovery and qualification observations outside provider classification", async () => {
    const query = queryPlan(1);
    const plan = selectionPlanFromQueryPlanV3(query, {
      prompt: "One influential disco recording",
    });
    const rawCandidate = {
      id: "lead-1",
      artist: "Test Artist",
      title: "Test Track",
      album: "Test Album",
      sourceObservationIds: ["observation-1"],
    };
    const port = createPipelineV3RetrievalExecutionPort({
      adapters: {
        discover: vi.fn(async () => ({
          candidates: [rawCandidate],
          nextCursor: null,
          exhausted: true,
          costUnits: 1,
        })),
        qualify: vi.fn(async () => [{
          candidateId: rawCandidate.id,
          scope: {
            passed: false,
            failedMembershipPredicateIds: ["membership:genre"],
            fit: 0,
          },
          hardConstraints: {
            passed: true,
            failedConstraintIds: [],
          },
          evidence: {
            passed: false,
            bindingIds: [],
            strength: 0,
            independentProvenanceRoots: 0,
          },
          version: { compatible: true, confidence: 1 },
          catalog: {
            lookupAttempted: false,
            storefrontPlayable: false,
            appleSongId: null,
            recordingFamilyKey: null,
            confidence: 0,
          },
          rankingSignals: {},
          sourceRank: 1,
        }]),
      },
    });
    const recordDiscoveryBatch = vi.fn(async () => undefined);
    const recordQualificationBatch = vi.fn(async () => undefined);
    const snapshot = workerRun("One influential disco recording", 1)
      .pipelinePolicySnapshot;
    await port.execute({
      runId: "run-v3",
      plan,
      executionMode: "active",
      routingHints: { fixedContainer: false },
      modelRoute: pipelineV3ModelRouteFromPolicySnapshot(snapshot),
      policy: {
        maximumGlobalRounds: 1,
        maximumConcurrentDiscovery: 1,
        maximumRawCandidates: 10,
        qualifiedPoolGoal: 1,
        maximumCostUnits: 10,
        deadlineAtEpochMs: null,
        maximumProviderFailuresPerStrategy: 1,
      },
      semanticRecoveryEnabled: false,
      claimSemanticRecovery: vi.fn(async () => undefined),
      recordDiscoveryBatch,
      recordQualificationBatch,
    });
    expect(recordDiscoveryBatch).toHaveBeenCalledOnce();
    expect(recordDiscoveryBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-v3",
        appleWriteAccess: "forbidden",
      }),
      expect.objectContaining({ candidates: [rawCandidate] }),
    );
    expect(recordQualificationBatch).toHaveBeenCalledOnce();
    expect(recordQualificationBatch).toHaveBeenCalledWith(
      expect.objectContaining({ candidates: [rawCandidate] }),
      expect.arrayContaining([
        expect.objectContaining({ candidateId: rawCandidate.id }),
      ]),
    );

    const persistenceFailure = Object.assign(
      new Error("contract attempt became stale"),
      { code: "pipeline_v3_recovery_fence_stale" },
    );
    await expect(port.execute({
      runId: "run-v3",
      plan,
      executionMode: "active",
      routingHints: { fixedContainer: false },
      modelRoute: pipelineV3ModelRouteFromPolicySnapshot(snapshot),
      policy: {
        maximumGlobalRounds: 1,
        maximumConcurrentDiscovery: 1,
        maximumRawCandidates: 10,
        qualifiedPoolGoal: 1,
        maximumCostUnits: 10,
        deadlineAtEpochMs: null,
        maximumProviderFailuresPerStrategy: 1,
      },
      semanticRecoveryEnabled: false,
      claimSemanticRecovery: vi.fn(async () => undefined),
      recordDiscoveryBatch: vi.fn(async () => {
        throw persistenceFailure;
      }),
      recordQualificationBatch: vi.fn(async () => undefined),
    })).rejects.toBe(persistenceFailure);
  });

  test("flushes paid discovery and qualification observations before rethrowing a later retrieval failure", async () => {
    const query = queryPlan(2);
    const plan = selectionPlanFromQueryPlanV3(query, {
      prompt: "Two influential disco recordings",
    });
    const rawCandidate = {
      id: "paid-lead-1",
      artist: "Test Artist",
      title: "Test Track",
      album: "Test Album",
      sourceObservationIds: ["observation-paid-1"],
    };
    const laterFailure = new Error("later retrieval operation failed");
    let discoveryCall = 0;
    const port = createPipelineV3RetrievalExecutionPort({
      adapters: {
        discover: vi.fn(async () => {
          discoveryCall += 1;
          if (discoveryCall > 1) throw laterFailure;
          return {
            candidates: [rawCandidate],
            nextCursor: null,
            exhausted: false,
            costUnits: 1,
          };
        }),
        qualify: vi.fn(async () => [{
          candidateId: rawCandidate.id,
          scope: {
            passed: false,
            failedMembershipPredicateIds: ["membership:genre"],
            fit: 0,
          },
          hardConstraints: {
            passed: true,
            failedConstraintIds: [],
          },
          evidence: {
            passed: false,
            bindingIds: [],
            strength: 0,
            independentProvenanceRoots: 0,
          },
          version: { compatible: true, confidence: 1 },
          catalog: {
            lookupAttempted: false,
            storefrontPlayable: false,
            appleSongId: null,
            recordingFamilyKey: null,
            confidence: 0,
          },
          rankingSignals: {},
          sourceRank: 1,
        }]),
      },
    });
    const recordDiscoveryBatch = vi.fn(async () => undefined);
    const recordQualificationBatch = vi.fn(async () => undefined);
    const snapshot = workerRun("Two influential disco recordings", 2)
      .pipelinePolicySnapshot;

    await expect(port.execute({
      runId: "run-v3-paid-resume",
      plan,
      executionMode: "active",
      routingHints: { fixedContainer: false },
      modelRoute: pipelineV3ModelRouteFromPolicySnapshot(snapshot),
      policy: {
        maximumGlobalRounds: 2,
        maximumConcurrentDiscovery: 1,
        maximumRawCandidates: 10,
        qualifiedPoolGoal: 2,
        maximumCostUnits: 10,
        deadlineAtEpochMs: null,
        maximumProviderFailuresPerStrategy: 1,
      },
      semanticRecoveryEnabled: false,
      claimSemanticRecovery: vi.fn(async () => undefined),
      recordDiscoveryBatch,
      recordQualificationBatch,
    })).rejects.toBe(laterFailure);

    expect(recordDiscoveryBatch).toHaveBeenCalledOnce();
    expect(recordQualificationBatch).toHaveBeenCalledOnce();
  });
});
