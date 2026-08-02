import { expect, test, vi } from "vitest";
import {
  PipelineV3DependencyUnavailableError,
  PipelineV3OptimizerComputeBudgetError,
  PipelineV3WorkerExecution,
  v3RetrievalStageKey,
  type PipelineV3RetrievalExecutionPort,
  type PipelineV3WorkerPayload,
} from "../server/pipeline-v3-worker-execution.ts";
import { compilePlaylistContractRevisionV1 } from "../server/playlist-contract-v1.ts";
import {
  executionFailureSemanticFingerprintV2,
  WorkerRunner,
  type DurableJob,
} from "../server/worker-runner.ts";
import { createQueryPlanV3 } from "../server/query-plan-v3.ts";
import {
  createRunSpecV3,
  resolveRunSpecV3,
} from "../server/selection-plan-v3.ts";

function methodProxy(): any {
  const methods = new Map<PropertyKey, ReturnType<typeof vi.fn>>();
  return new Proxy({}, {
    get(_target, property) {
      if (!methods.has(property)) methods.set(property, vi.fn(async () => undefined));
      return methods.get(property);
    },
  });
}

test("semantic retry fingerprints ignore mutable plan and executor identities", () => {
  const base = {
    errorCode: "v3_retrieval_provider_failed",
    stage: "v3-retrieval:active:semantic",
    contractSemanticHash: "1".repeat(64),
    queryPlanHash: "2".repeat(64),
    strategySemanticHash: "3".repeat(64),
    semanticExecutionConfigurationHash: "4".repeat(64),
    providerRoots: ["provider-b", "provider-a", "provider-a"],
    budgetGeneration: 0,
  };
  const first = executionFailureSemanticFingerprintV2(base);
  const clonedRevision = executionFailureSemanticFingerprintV2({
    ...base,
    providerRoots: ["provider-a", "provider-b"],
  });
  expect(clonedRevision).toEqual(first);
  expect(executionFailureSemanticFingerprintV2({
    ...base,
    strategySemanticHash: "5".repeat(64),
  }).attemptStrategyHash).not.toBe(first.attemptStrategyHash);
  expect(executionFailureSemanticFingerprintV2({
    ...base,
    budgetGeneration: 1,
  }).attemptStrategyHash).not.toBe(first.attemptStrategyHash);
});

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for dependency retry");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function dependencyHarness(input: {
  priorBlocker?: {
    id: string;
    retryCount: number;
    nextRetryAt: Date | null;
    automaticRetryUntil: Date | null;
    createdAt: Date;
    state: Record<string, unknown>;
  } | null;
  expiredBlocker?: {
    id: string;
    dependencyKey: string;
    retryCount: number;
    nextRetryAt: Date | null;
    automaticRetryUntil: Date;
    createdAt: Date;
    state: Record<string, unknown>;
  } | null;
  attempts?: number;
}) {
  let leased = false;
  const contract = compilePlaylistContractRevisionV1({
    contractId: "contract:worker-recovery",
    rawPrompt: "Create one reggaeton track.",
    requestedTrackCount: 1,
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
    }],
    trackPredicate: { op: "clause", clauseId: "membership:reggaeton" },
    playlistConstraints: [],
    qualityPolicy: {
      centralSuitabilityClauseIds: [],
      minimumPassRatio: 0.8,
      maximumUnknownRatio: 0.2,
      zeroKnownFailures: true,
    },
  });
  const contractHash = contract.semanticHash;
  const job: DurableJob = {
    id: "job-v3-provider",
    runId: "run-v3-provider",
    briefRequestId: null,
    kind: "research",
    payload: { runId: "run-v3-provider" },
    attempts: input.attempts ?? 1,
    maxAttempts: 10,
    pipelineVersion: "corpus_first_v3",
    minimumWorkerProtocol: 10,
    queryPlanRevisionId: "query-plan-r1",
    stageKey: "v3-retrieval:active:provider",
    leaseEpoch: input.attempts ?? 1,
  };
  const repository = methodProxy();
  repository.ensureSchemaVersion.mockResolvedValue(undefined);
  repository.updateWorkerHeartbeat.mockResolvedValue(undefined);
  repository.getSetting.mockResolvedValue("false");
  repository.getRunControlState.mockResolvedValue({
    status: "researching",
    phase: "v3_retrieval",
  });
  repository.leaseNextJob.mockImplementation(async () => {
    if (leased) return null;
    leased = true;
    return job;
  });
  repository.renewJobLease.mockResolvedValue(true);
  repository.getActivePlaylistContractRevision.mockResolvedValue({
    id: "contract-db-r1",
    contractHash,
    contract,
  });
  repository.beginPlaylistExecutionAttempt.mockResolvedValue({
    id: `attempt-${job.attempts}`,
    created: true,
    activeComputeMs: 0,
  });
  repository.completePlaylistExecutionAttempt.mockResolvedValue({
    accepted: true,
    discarded: false,
  });
  repository.recordPlaylistExecutionFailureFingerprint.mockResolvedValue({
    accepted: true,
    repeated: false,
  });
  repository.getActivePlaylistRunBlocker.mockResolvedValue(input.priorBlocker ?? null);
  repository.getExpiredPlaylistProviderBlocker.mockResolvedValue(input.expiredBlocker ?? null);
  repository.openPlaylistRunBlocker.mockResolvedValue("blocker-provider");
  repository.resolvePlaylistRunBlockers.mockResolvedValue(1);
  repository.failJob.mockResolvedValue(undefined);
  repository.completeJob.mockResolvedValue(undefined);
  repository.runRetentionSweep.mockResolvedValue(0);
  return { repository, job };
}

test("a V3 provider outage opens a durable blocker after the adapter exhausts immediate retries", async () => {
  const { repository, job } = dependencyHarness({});
  const before = Date.now();
  const runner = new WorkerRunner(repository, {
    queueClass: "deep",
    concurrency: 1,
    pollMs: 5,
    heartbeatMs: 60_000,
    controlIntervalMs: 60_000,
    renewMs: 60_000,
    handlers: {
      research: async () => {
        throw new PipelineV3DependencyUnavailableError(
          "v3_retrieval_provider",
          "v3_retrieval_provider_failed",
        );
      },
    },
  });
  const running = runner.run();
  try {
    await waitFor(() => repository.failJob.mock.calls.length === 1);
    const blocker = repository.openPlaylistRunBlocker.mock.calls[0]![0] as {
      retryCount: number;
      nextRetryAt: Date;
      automaticRetryUntil: Date;
      state: Record<string, unknown>;
    };
    expect(blocker).toMatchObject({
      blockerKind: "provider",
      dependencyKey: "v3_retrieval_provider",
      retryCount: 4,
      state: {
        reasonCode: "v3_retrieval_provider_failed",
        retryLane: "durable",
        retryOrdinal: 1,
        immediateAttemptsCompleted: 3,
        durableAttemptsCompleted: 1,
        nextAction: "wait_for_dependency",
      },
    });
    expect(blocker.nextRetryAt.getTime()).toBeGreaterThanOrEqual(before + 4.5 * 60_000);
    expect(blocker.nextRetryAt.getTime()).toBeLessThanOrEqual(before + 5.5 * 60_000);
    expect(blocker.automaticRetryUntil.getTime()).toBeGreaterThanOrEqual(
      before + 24 * 60 * 60_000,
    );
    expect(blocker.automaticRetryUntil.getTime()).toBeLessThanOrEqual(
      before + 24 * 60 * 60_000 + 1_000,
    );
    expect(repository.failJob).toHaveBeenCalledWith(
      job.id,
      expect.any(String),
      "Research dependency unavailable; retry scheduled.",
      blocker.nextRetryAt,
      job.leaseEpoch,
    );
    expect(repository.completeJob).not.toHaveBeenCalled();
    expect(repository.beginPlaylistExecutionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        executorIdentityHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    );
    expect(repository.completePlaylistExecutionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "blocked",
        blockerKind: "dependency_retry",
      }),
    );
  } finally {
    await runner.stop();
    await running;
  }
});

test("a canonical V2 success does not enter V3-only blocker cleanup", async () => {
  const { repository, job } = dependencyHarness({});
  job.pipelineVersion = "catalog_first_v2";
  job.minimumWorkerProtocol = 9;
  job.queryPlanRevisionId = null;
  job.stageKey = "research_provider_dependency_retry";
  const handler = vi.fn(async () => undefined);
  const runner = new WorkerRunner(repository, {
    queueClass: "deep",
    concurrency: 1,
    pollMs: 5,
    heartbeatMs: 60_000,
    controlIntervalMs: 60_000,
    renewMs: 60_000,
    handlers: { research: handler },
  });
  const running = runner.run();
  try {
    await waitFor(() => repository.completeJob.mock.calls.length === 1);
    expect(handler).toHaveBeenCalledOnce();
    expect(repository.resolvePlaylistRunBlockers).not.toHaveBeenCalled();
    expect(repository.quarantineCanonicalExecution).not.toHaveBeenCalled();
    expect(repository.failJob).not.toHaveBeenCalled();
    expect(repository.completePlaylistExecutionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "complete",
      }),
    );
  } finally {
    await runner.stop();
    await running;
  }
});

test.each([
  {
    kind: "research",
    dependencyKey: "openai_research",
    stageKey: "research_provider_dependency_retry",
    marker: "researchProviderDecisionOnly",
    generationKey: "researchProviderBlockerGeneration",
    failureCountKey: "researchProviderBlockerFailureCount",
  },
  {
    kind: "matching",
    dependencyKey: "apple_catalog",
    stageKey: "catalog_matching_dependency_retry",
    marker: "providerDecisionOnly",
    generationKey: "providerBlockerGeneration",
    failureCountKey: "providerBlockerFailureCount",
  },
] as const)(
  "a V2 $kind decision-only horizon wake transitions without calling its provider handler",
  async ({
    kind,
    dependencyKey,
    stageKey,
    marker,
    generationKey,
    failureCountKey,
  }) => {
    const { repository, job } = dependencyHarness({ attempts: 7 });
    const generation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    job.pipelineVersion = "catalog_first_v2";
    job.minimumWorkerProtocol = 9;
    job.queryPlanRevisionId = null;
    job.kind = kind;
    job.stageKey = stageKey;
    job.payload = {
      runId: job.runId,
      [marker]: true,
      [generationKey]: generation,
      [failureCountKey]: 6,
      ...(kind === "research"
        ? { researchProviderDependencyRetry: true }
        : { providerDependencyRetry: true }),
    };
    repository.markPipelineV2ProviderDependencyDecision.mockResolvedValue(true);
    const providerHandler = vi.fn(async () => {
      throw new Error("provider must not be called at a V2 decision-only wake");
    });
    const runner = new WorkerRunner(repository, {
      queueClass: "deep",
      concurrency: 1,
      pollMs: 5,
      heartbeatMs: 60_000,
      controlIntervalMs: 60_000,
      renewMs: 60_000,
      handlers: { [kind]: providerHandler },
    });
    const running = runner.run();
    try {
      await waitFor(() => repository.completeJob.mock.calls.length === 1);
      expect(providerHandler).not.toHaveBeenCalled();
      expect(repository.markPipelineV2ProviderDependencyDecision)
        .toHaveBeenCalledWith({
          runId: job.runId,
          dependencyKey,
          expectedGeneration: generation,
          priorFailureCount: 6,
          jobId: job.id,
          workerId: expect.any(String),
          leaseEpoch: job.leaseEpoch,
        });
      expect(repository.completePlaylistExecutionAttempt).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "blocked",
          blockerKind: "dependency_decision",
        }),
      );
      expect(repository.failJob).not.toHaveBeenCalled();
    } finally {
      await runner.stop();
      await running;
    }
  },
);

test("a provider Retry-After later than the durable slot remains the exact wake boundary", async () => {
  const { repository, job } = dependencyHarness({});
  const retryAfterUntil = new Date(Date.now() + 20 * 60_000);
  const runner = new WorkerRunner(repository, {
    queueClass: "deep",
    concurrency: 1,
    pollMs: 5,
    heartbeatMs: 60_000,
    controlIntervalMs: 60_000,
    renewMs: 60_000,
    handlers: {
      research: async () => {
        throw new PipelineV3DependencyUnavailableError(
          "v3_retrieval_provider",
          "v3_retrieval_provider_failed",
          retryAfterUntil,
        );
      },
    },
  });
  const running = runner.run();
  try {
    await waitFor(() => repository.failJob.mock.calls.length === 1);
    const blocker = repository.openPlaylistRunBlocker.mock.calls[0]![0] as {
      nextRetryAt: Date;
      state: Record<string, unknown>;
    };
    expect(blocker.nextRetryAt.getTime()).toBe(retryAfterUntil.getTime());
    expect(blocker.state).toMatchObject({
      retryAfterUntil: retryAfterUntil.toISOString(),
      retryLane: "durable",
      retryOrdinal: 1,
      nextAction: "wait_for_dependency",
    });
    expect(repository.failJob).toHaveBeenCalledWith(
      job.id,
      expect.any(String),
      "Research dependency unavailable; retry scheduled.",
      retryAfterUntil,
      job.leaseEpoch,
    );
  } finally {
    await runner.stop();
    await running;
  }
});

test.each([
  { failureClass: "authorization", reasonCode: "provider_authorization_failure" },
  { failureClass: "quota", reasonCode: "provider_quota_failure" },
  { failureClass: "invalid_request", reasonCode: "provider_invalid_request_failure" },
  { failureClass: "configuration", reasonCode: "provider_configuration_failure" },
] as const)(
  "a non-retryable provider $failureClass failure quarantines immediately without entering the dependency circuit",
  async ({ failureClass, reasonCode }) => {
    const { repository, job } = dependencyHarness({ attempts: 1 });
    const runner = new WorkerRunner(repository, {
      queueClass: "deep",
      concurrency: 1,
      pollMs: 5,
      heartbeatMs: 60_000,
      controlIntervalMs: 60_000,
      renewMs: 60_000,
      handlers: {
        research: async () => {
          throw new PipelineV3DependencyUnavailableError(
            "v3_retrieval_provider",
            `v3_retrieval_provider_${failureClass}`,
            null,
            failureClass,
          );
        },
      },
    });
    const running = runner.run();
    try {
      await waitFor(() => repository.failJob.mock.calls.length === 1);
      expect(repository.getActivePlaylistRunBlocker).not.toHaveBeenCalled();
      expect(repository.openPlaylistRunBlocker).not.toHaveBeenCalled();
      expect(repository.markPlaylistDependencyDecision).not.toHaveBeenCalled();
      expect(repository.quarantineCanonicalExecution).toHaveBeenCalledWith({
        runId: job.runId,
        jobId: job.id,
        workerId: expect.any(String),
        leaseGeneration: job.leaseEpoch,
        reasonCode,
      });
      expect(repository.completePlaylistExecutionAttempt).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
          blockerKind: "provider_configuration_quarantine",
        }),
      );
      expect(repository.failJob).toHaveBeenCalledWith(
        job.id,
        expect.any(String),
        "Research provider configuration requires operator attention.",
        null,
        job.leaseEpoch,
      );
    } finally {
      await runner.stop();
      await running;
    }
  },
);

test("a successor lease reconciles a crash-persisted non-retryable provider checkpoint without another provider call", async () => {
  const selection = resolveRunSpecV3(createRunSpecV3({
    prompt: "Create one reggaeton track.",
    requestedTrackCount: 1,
    storefront: "us",
  }), []);
  const queryPlan = createQueryPlanV3(
    selection,
    "11111111-1111-4111-8111-111111111111",
  );
  const stageKey = v3RetrievalStageKey(queryPlan, "active");
  const { repository, job } = dependencyHarness({ attempts: 2 });
  job.stageKey = stageKey;
  const crashCheckpoint = {
    schemaVersion: "genio-pipeline-v3-worker-checkpoint/v1",
    state: "failed_integrity",
    stageKey,
    queryPlanHash: "a".repeat(64),
    code: "v3_retrieval_provider_non_retryable",
    reasonCode: "v3_retrieval_provider_quota",
    failureClass: "quota",
    retryable: false,
    nextAction: "contact_support",
  };
  repository.getResearchCheckpoint.mockResolvedValue(crashCheckpoint);
  const provider: PipelineV3RetrievalExecutionPort = {
    execute: vi.fn(async () => {
      throw new Error("provider must not be called while reconciling quarantine");
    }),
  };
  const execution = new PipelineV3WorkerExecution(repository, provider);
  const runner = new WorkerRunner(repository, {
    queueClass: "deep",
    concurrency: 1,
    pollMs: 5,
    heartbeatMs: 60_000,
    controlIntervalMs: 60_000,
    renewMs: 60_000,
    handlers: {
      research: async (payload, signal) => execution.process({
        runId: job.runId!,
        run: {},
        queryPlan,
        payload: payload as PipelineV3WorkerPayload,
        signal,
      }),
    },
  });

  const running = runner.run();
  try {
    await waitFor(() => repository.failJob.mock.calls.length === 1);
    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.quarantineCanonicalExecution).toHaveBeenCalledWith({
      runId: job.runId,
      jobId: job.id,
      workerId: expect.any(String),
      leaseGeneration: job.leaseEpoch,
      reasonCode: "provider_quota_failure",
    });
    expect(repository.completePlaylistExecutionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        blockerKind: "provider_configuration_quarantine",
      }),
    );
    expect(repository.completeJob).not.toHaveBeenCalled();
    expect(repository.failJob).toHaveBeenCalledWith(
      job.id,
      expect.any(String),
      "Research provider configuration requires operator attention.",
      null,
      job.leaseEpoch,
    );
  } finally {
    await runner.stop();
    await running;
  }
});

test("a Retry-After beyond 24 hours wakes for a decision without calling the provider", async () => {
  const firstFailureAt = new Date(Date.now() - 24 * 60 * 60_000 - 1_000);
  const retryAfterUntil = new Date(Date.now() + 24 * 60 * 60_000);
  const automaticRetryUntil = new Date(firstFailureAt.getTime() + 24 * 60 * 60_000);
  const { repository } = dependencyHarness({
    attempts: 5,
    expiredBlocker: {
      id: "blocker-provider",
      dependencyKey: "v3_retrieval_provider",
      retryCount: 4,
      nextRetryAt: automaticRetryUntil,
      automaticRetryUntil,
      createdAt: firstFailureAt,
      state: {
        firstFailureAt: firstFailureAt.toISOString(),
        circuitOpenedAt: firstFailureAt.toISOString(),
        reasonCode: "v3_retrieval_provider_failed",
        retryAfterUntil: retryAfterUntil.toISOString(),
      },
    },
  });
  const provider = vi.fn(async () => {
    throw new Error("provider must not be called at the decision-only wake");
  });
  const runner = new WorkerRunner(repository, {
    queueClass: "deep",
    concurrency: 1,
    pollMs: 5,
    heartbeatMs: 60_000,
    controlIntervalMs: 60_000,
    renewMs: 60_000,
    handlers: { research: provider },
  });
  const running = runner.run();
  try {
    await waitFor(() => repository.completeJob.mock.calls.length === 1);
    expect(provider).not.toHaveBeenCalled();
    expect(repository.markPlaylistDependencyDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        dependencyKey: "v3_retrieval_provider",
        automaticRetryUntil,
        state: expect.objectContaining({
          reason: "dependency_retry_window_expired",
          retryAfterUntil: retryAfterUntil.toISOString(),
          nextAction: "resume_revise_or_cancel",
          automaticResume: false,
        }),
      }),
    );
    expect(repository.resolvePlaylistRunBlockers).not.toHaveBeenCalled();
    expect(repository.failJob).not.toHaveBeenCalled();
  } finally {
    await runner.stop();
    await running;
  }
});

test("the 24-hour dependency horizon becomes an explicit decision instead of a failed job", async () => {
  const firstFailureAt = new Date(Date.now() - 24 * 60 * 60_000 - 1_000);
  const { repository } = dependencyHarness({
    attempts: 10,
    priorBlocker: {
      id: "blocker-provider",
      retryCount: 8,
      nextRetryAt: firstFailureAt,
      automaticRetryUntil: new Date(firstFailureAt.getTime() + 24 * 60 * 60_000),
      createdAt: firstFailureAt,
      state: {
        firstFailureAt: firstFailureAt.toISOString(),
        circuitOpenedAt: firstFailureAt.toISOString(),
      },
    },
  });
  const runner = new WorkerRunner(repository, {
    queueClass: "deep",
    concurrency: 1,
    pollMs: 5,
    heartbeatMs: 60_000,
    controlIntervalMs: 60_000,
    renewMs: 60_000,
    handlers: {
      research: async () => {
        throw new PipelineV3DependencyUnavailableError(
          "v3_retrieval_provider",
          "v3_retrieval_provider_failed",
        );
      },
    },
  });
  const running = runner.run();
  try {
    await waitFor(() => repository.completeJob.mock.calls.length === 1);
    expect(repository.resolvePlaylistRunBlockers).not.toHaveBeenCalled();
    expect(repository.markPlaylistDependencyDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        dependencyKey: "v3_retrieval_provider",
        state: expect.objectContaining({
          nextAction: "resume_revise_or_cancel",
        }),
      }),
    );
    expect(repository.failJob).not.toHaveBeenCalled();
    expect(repository.completePlaylistExecutionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "blocked",
        blockerKind: "dependency_decision",
      }),
    );
  } finally {
    await runner.stop();
    await running;
  }
});

test("an optimizer budget miss opens a technical budget blocker for one larger bounded pass", async () => {
  const { repository, job } = dependencyHarness({ attempts: 1 });
  const runner = new WorkerRunner(repository, {
    queueClass: "deep",
    concurrency: 1,
    pollMs: 5,
    heartbeatMs: 60_000,
    controlIntervalMs: 60_000,
    renewMs: 60_000,
    handlers: {
      research: async () => {
        throw new PipelineV3OptimizerComputeBudgetError(1, true);
      },
    },
  });
  const running = runner.run();
  try {
    await waitFor(() => repository.failJob.mock.calls.length === 1);
    expect(repository.openPlaylistRunBlocker).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: job.runId,
        blockerKind: "budget",
        dependencyKey: "playlist_optimizer_compute",
        retryCount: 1,
        nextRetryAt: expect.any(Date),
        automaticRetryUntil: null,
        state: expect.objectContaining({
          technical: true,
          providerCallPermitted: false,
          budgetPass: 1,
          nextBudgetPass: 2,
          nextAction: "wait_for_compute",
        }),
      }),
    );
    expect(repository.getActivePlaylistRunBlocker).not.toHaveBeenCalled();
    expect(repository.markPlaylistDependencyDecision).not.toHaveBeenCalled();
    expect(repository.quarantineCanonicalExecution).not.toHaveBeenCalled();
    expect(repository.completePlaylistExecutionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "blocked",
        blockerKind: "optimizer_compute_retry",
      }),
    );
    expect(repository.failJob).toHaveBeenCalledWith(
      job.id,
      expect.any(String),
      "Playlist optimization needs one larger bounded compute pass.",
      expect.any(Date),
      job.leaseEpoch,
    );
  } finally {
    await runner.stop();
    await running;
  }
});

test("a second deterministic optimizer budget miss quarantines without provider scarcity", async () => {
  const { repository, job } = dependencyHarness({ attempts: 2 });
  const runner = new WorkerRunner(repository, {
    queueClass: "deep",
    concurrency: 1,
    pollMs: 5,
    heartbeatMs: 60_000,
    controlIntervalMs: 60_000,
    renewMs: 60_000,
    handlers: {
      research: async () => {
        throw new PipelineV3OptimizerComputeBudgetError(2, false);
      },
    },
  });
  const running = runner.run();
  try {
    await waitFor(() => repository.failJob.mock.calls.length === 1);
    expect(repository.openPlaylistRunBlocker).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: job.runId,
        blockerKind: "budget",
        dependencyKey: "playlist_optimizer_compute",
        retryCount: 2,
        nextRetryAt: null,
        state: expect.objectContaining({
          technical: true,
          providerCallPermitted: false,
          budgetPass: 2,
          nextBudgetPass: null,
          nextAction: "contact_support",
        }),
      }),
    );
    expect(repository.getActivePlaylistRunBlocker).not.toHaveBeenCalled();
    expect(repository.markPlaylistDependencyDecision).not.toHaveBeenCalled();
    expect(repository.quarantineCanonicalExecution).toHaveBeenCalledWith({
      runId: job.runId,
      jobId: job.id,
      workerId: expect.any(String),
      leaseGeneration: job.leaseEpoch,
      reasonCode: "optimizer_compute_budget_exhausted",
    });
    expect(repository.completePlaylistExecutionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        blockerKind: "optimizer_compute_quarantine",
      }),
    );
    expect(repository.failJob).toHaveBeenCalledWith(
      job.id,
      expect.any(String),
      "Playlist optimization exhausted its bounded technical compute budget.",
      null,
      job.leaseEpoch,
    );
  } finally {
    await runner.stop();
    await running;
  }
});

test("an unexpected canonical system error fails closed without a blind retry", async () => {
  const { repository, job } = dependencyHarness({ attempts: 1 });
  const runner = new WorkerRunner(repository, {
    queueClass: "deep",
    concurrency: 1,
    pollMs: 5,
    heartbeatMs: 60_000,
    controlIntervalMs: 60_000,
    renewMs: 60_000,
    handlers: {
      research: async () => {
        throw new TypeError("programmer fault");
      },
    },
  });
  const running = runner.run();
  try {
    await waitFor(() => repository.failJob.mock.calls.length === 1);
    expect(repository.openPlaylistRunBlocker).not.toHaveBeenCalled();
    expect(repository.markPlaylistDependencyDecision).not.toHaveBeenCalled();
    expect(repository.quarantineCanonicalExecution).toHaveBeenCalledWith({
      runId: job.runId,
      jobId: job.id,
      workerId: expect.any(String),
      leaseGeneration: job.leaseEpoch,
      reasonCode: "unexpected_system_failure",
    });
    expect(repository.completePlaylistExecutionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        blockerKind: "technical_quarantine",
      }),
    );
    expect(repository.failJob).toHaveBeenCalledWith(
      job.id,
      expect.any(String),
      expect.any(String),
      null,
      job.leaseEpoch,
    );
  } finally {
    await runner.stop();
    await running;
  }
});

test("an exhausted unexpected canonical system error quarantines without revising the contract", async () => {
  const { repository, job } = dependencyHarness({ attempts: 10 });
  const runner = new WorkerRunner(repository, {
    queueClass: "deep",
    concurrency: 1,
    pollMs: 5,
    heartbeatMs: 60_000,
    controlIntervalMs: 60_000,
    renewMs: 60_000,
    handlers: {
      research: async () => {
        throw new Error("unexpected invariant violation");
      },
    },
  });
  const running = runner.run();
  try {
    await waitFor(() => repository.failJob.mock.calls.length === 1);
    expect(repository.openPlaylistRunBlocker).not.toHaveBeenCalled();
    expect(repository.markPlaylistDependencyDecision).not.toHaveBeenCalled();
    expect(repository.quarantineCanonicalExecution).toHaveBeenCalledWith({
      runId: job.runId,
      jobId: job.id,
      workerId: expect.any(String),
      leaseGeneration: job.leaseEpoch,
      reasonCode: "unexpected_system_failure",
    });
    expect(repository.completePlaylistExecutionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        blockerKind: "technical_quarantine",
      }),
    );
    expect(repository.failJob).toHaveBeenCalledWith(
      job.id,
      expect.any(String),
      expect.any(String),
      null,
      job.leaseEpoch,
    );
  } finally {
    await runner.stop();
    await running;
  }
});
