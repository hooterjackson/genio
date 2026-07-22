import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  PIPELINE_V3_RETRIEVAL_SCHEMA,
  type QualifiedTrackV3,
  type RetrievalOutcomeStatusV3,
  type RetrievalResultV3,
} from "../server/pipeline-v3-retrieval.ts";
import {
  governedCorpusActionReasonV3,
  PipelineV3WorkerExecution,
  retrievalPolicyV3FromPipelinePolicySnapshot,
  selectionPlanFromQueryPlanV3,
  v3RetrievalStageKey,
  type PipelineV3RetrievalExecutionPort,
  type PipelineV3WorkerPayload,
  type PipelineV3WorkerRepository,
  type PipelineV3WriteFence,
} from "../server/pipeline-v3-worker-execution.ts";
import type { QueryPlanV3 } from "../shared/types.ts";
import { createQueryPlanV3 } from "../server/query-plan-v3.ts";
import {
  createRunSpecV3,
  resolveRunSpecV3,
  type SelectionPlanV3,
} from "../server/selection-plan-v3.ts";
import type { ColdCorpusBuildResultV3 } from "../server/pipeline-v3-corpus-builder.ts";
import { createPipelinePolicySnapshotV3 } from "../server/pipeline-v3-policy.ts";
import type { SemanticPlanRevisionArtifactV3 } from "../server/pipeline-v3-semantic-recovery.ts";

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
  readonly semanticRecoveryClaims: Array<Parameters<PipelineV3WorkerRepository["claimPipelineV3SemanticRecovery"]>[0]> = [];
  readonly corpusIngestions: ColdCorpusBuildResultV3[] = [];

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

  async claimPipelineV3SemanticRecovery(
    input: Parameters<PipelineV3WorkerRepository["claimPipelineV3SemanticRecovery"]>[0],
  ): ReturnType<PipelineV3WorkerRepository["claimPipelineV3SemanticRecovery"]> {
    this.semanticRecoveryClaims.push(structuredClone(input));
    return { status: this.semanticRecoveryClaims.length === 1 ? "claimed" : "replayed", revision: 2 };
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

function payload(plan: ReturnType<typeof queryPlan>, mode: "active" | "shadow" = "active"): PipelineV3WorkerPayload {
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

function execution(result: RetrievalResultV3): PipelineV3RetrievalExecutionPort {
  return { execute: vi.fn(async () => result) };
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

function assertFenced(repository: MemoryRepository, plan: ReturnType<typeof queryPlan>, mode: "active" | "shadow" = "active") {
  const expected = {
    jobId: JOB_ID,
    workerId: "worker-v3",
    leaseEpoch: 7,
    queryPlanRevisionId: QUERY_PLAN_REVISION_ID,
    stageKey: v3RetrievalStageKey(plan, mode),
  };
  expect(repository.writes.length).toBeGreaterThan(0);
  expect(repository.updates.length).toBeGreaterThan(0);
  for (const write of repository.writes) expect(write.fence).toEqual(expected);
  for (const update of repository.updates) expect(update.fence).toEqual(expected);
  for (const persisted of repository.persisted) expect(persisted.fence).toEqual(expected);
  for (const claim of repository.semanticRecoveryClaims) expect(claim.fence).toEqual(expected);
}

describe("Pipeline V3 durable worker execution", () => {
  test("refuses schema-2 work compiled against a different music-concept registry", () => {
    const plan = queryPlan();
    expect(() => selectionPlanFromQueryPlanV3({
      ...plan,
      musicConceptPolicyVersion: "music_concepts_future",
    }, workerRun("25 influential disco recordings"))).toThrow(
      "unsupported music-concept policy",
    );
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
        maximumCostUnits: 48,
        deadlineAtEpochMs: null,
        maximumProviderFailuresPerStrategy: 2,
      },
    }));
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
        maximumCostUnits: 9,
        deadlineAtEpochMs: null,
        maximumProviderFailuresPerStrategy: 2,
      },
    }));
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
    await new PipelineV3WorkerExecution(repository, null).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: payload(plan),
    });

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

  test("resumes a provider-paused stage only from a successor lease", async () => {
    const plan = queryPlan();
    const repository = new MemoryRepository();
    const originalPayload = payload(plan);
    await new PipelineV3WorkerExecution(repository, null).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: originalPayload,
    });
    expect(repository.checkpoints.get(v3RetrievalStageKey(plan, "active")))
      .toMatchObject({ state: "waiting_provider", leaseEpoch: 7 });

    const port = execution(retrievalResult("exact_ready", 25));
    await new PipelineV3WorkerExecution(repository, port).process({
      runId: "run-v3",
      run: workerRun("25 influential disco recordings"),
      queryPlan: plan,
      payload: originalPayload,
    });
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
});
