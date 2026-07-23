import { expect, test, vi } from "vitest";
import { PipelineV3DependencyUnavailableError } from "../server/pipeline-v3-worker-execution.ts";
import { compilePlaylistContractRevisionV1 } from "../server/playlist-contract-v1.ts";
import { WorkerRunner, type DurableJob } from "../server/worker-runner.ts";

function methodProxy(): any {
  const methods = new Map<PropertyKey, ReturnType<typeof vi.fn>>();
  return new Proxy({}, {
    get(_target, property) {
      if (!methods.has(property)) methods.set(property, vi.fn(async () => undefined));
      return methods.get(property);
    },
  });
}

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
  repository.getActivePlaylistRunBlocker.mockResolvedValue(input.priorBlocker ?? null);
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

test("the 24-hour dependency horizon becomes an explicit decision instead of a failed job", async () => {
  const firstFailureAt = new Date(Date.now() - 24 * 60 * 60_000 - 1_000);
  const { repository, job } = dependencyHarness({
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
    expect(repository.resolvePlaylistRunBlockers).toHaveBeenCalledWith({
      runId: job.runId,
      contractRevisionId: "contract-db-r1",
      blockerKind: "provider",
    });
    expect(repository.openPlaylistRunBlocker).toHaveBeenCalledWith(
      expect.objectContaining({
        blockerKind: "scope_decision",
        dependencyKey: "v3_retrieval_provider",
        nextRetryAt: null,
        state: expect.objectContaining({
          nextAction: "resume_revise_or_cancel",
        }),
      }),
    );
    expect(repository.failJob).not.toHaveBeenCalled();
    expect(repository.completePlaylistExecutionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "blocked",
        blockerKind: "scope_decision",
      }),
    );
  } finally {
    await runner.stop();
    await running;
  }
});
