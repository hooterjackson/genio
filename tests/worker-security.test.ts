import { expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  AppleApiError,
  appleAuthorizationGeneration,
  appleAuthorizationJobDedupeKey,
  type AppleAuthorizationRecord,
} from "../server/apple.ts";
import {
  assertPublicationControl,
  exactOrderedPrefix,
  manifestContentHash,
  nextPublicationAppendBatch,
  planPublicationVolumes,
  publicationTerminalStatus,
  PublicationPausedError,
  PublicationRunCancelledError,
  type LockedManifestTrack,
  type PublicationRepository,
} from "../server/publisher.ts";
import {
  createAppleAuthorizationRepositoryFacade,
  createMatchingRepositoryFacade,
  createPublicationRepositoryFacade,
  createResearchRepositoryFacade,
} from "../server/worker-facades.ts";
import {
  assertProductionWorkerSecrets,
  defaultJobHandlers,
  WorkerRunner,
  type DurableJob,
} from "../server/worker-runner.ts";
import { WORKER_PIPELINE_PROTOCOL_VERSION } from "../server/worker-protocol.ts";

const validAuthorization: AppleAuthorizationRecord = {
  ciphertext: "encrypted-token-generation-one",
  iv: "iv",
  authTag: "tag",
  keyVersion: "v1",
  storefront: "br",
  status: "valid",
};

function methodProxy(): any {
  const methods = new Map<PropertyKey, ReturnType<typeof vi.fn>>();
  return new Proxy({}, {
    get(_target, property) {
      if (!methods.has(property)) methods.set(property, vi.fn(async () => undefined));
      return methods.get(property);
    },
  });
}

test("worker handler facades enforce role-specific runtime capabilities", async () => {
  const source = methodProxy();
  const research = createResearchRepositoryFacade(source);
  const matching = createMatchingRepositoryFacade(source);
  const publication = createPublicationRepositoryFacade(source);
  const appleAuthorization = createAppleAuthorizationRepositoryFacade(source);

  expect(Object.isFrozen(research)).toBe(true);
  expect(Object.isFrozen(matching)).toBe(true);
  expect(Object.isFrozen(publication)).toBe(true);
  expect("getAppleAuthorization" in research).toBe(false);
  expect("getManifestById" in research).toBe(false);
  expect("reserveProviderCost" in publication).toBe(false);
  expect("addSources" in publication).toBe(false);
  expect("saveAppleAuthorization" in publication).toBe(false);
  expect("acquireAppleWritePermit" in publication).toBe(true);
  expect("acquireAppleWritePermit" in research).toBe(false);
  expect("acquireAppleWritePermit" in matching).toBe(false);
  expect("reserveProviderCost" in appleAuthorization).toBe(false);
  expect("enqueueJob" in appleAuthorization).toBe(false);
  expect("getManifestById" in appleAuthorization).toBe(false);
  expect(() => research.enqueueJob({ kind: "publication" })).toThrow(/Research cannot enqueue publication/);

  await research.enqueueJob({ kind: "research" });
  expect(source.enqueueJob).toHaveBeenCalledTimes(1);

  // Catalog discovery happens behind the matching worker facade in
  // production. If this capability is omitted, direct repository tests pass
  // while real workers silently discard every discovered track.
  expect("persistCatalogDiscoveredCandidates" in matching).toBe(true);
  await matching.persistCatalogDiscoveredCandidates?.("run-1", [], {
    pipelineVersion: "catalog_first_v2",
    policyVersion: "relevance_first_2026_07",
  });
  expect(source.persistCatalogDiscoveredCandidates).toHaveBeenCalledTimes(1);

  expect("getManifestPreflightReserveTracks" in publication).toBe(true);
  await publication.getManifestPreflightReserveTracks?.("manifest-1", "revision-1", "us");
  expect(source.getManifestPreflightReserveTracks).toHaveBeenCalledWith("manifest-1", "revision-1", "us");
  expect("getPublicationGuard" in publication).toBe(true);
  await publication.getPublicationGuard?.({
    runId: "run-1",
    manifestId: "manifest-1",
    manifestRevisionId: "revision-1",
    manifestRevisionHash: "a".repeat(64),
    selectedCount: 25,
  });
  expect(source.getPublicationGuard).toHaveBeenCalledWith({
    runId: "run-1",
    manifestId: "manifest-1",
    manifestRevisionId: "revision-1",
    manifestRevisionHash: "a".repeat(64),
    selectedCount: 25,
  });
  await publication.acquireAppleWritePermit?.({
    runId: "run-1",
    manifestId: "manifest-1",
    manifestRevisionId: "revision-1",
    manifestRevisionHash: "a".repeat(64),
    contractRevisionId: null,
    contractHash: null,
    publicationVolumeId: "volume-1",
    operation: "append_tracks",
  });
  expect(source.acquireAppleWritePermit).toHaveBeenCalledWith({
    runId: "run-1",
    manifestId: "manifest-1",
    manifestRevisionId: "revision-1",
    manifestRevisionHash: "a".repeat(64),
    contractRevisionId: null,
    contractHash: null,
    publicationVolumeId: "volume-1",
    operation: "append_tracks",
  });
  const completionFence = {
    runId: "run-1",
    manifestId: "manifest-1",
    manifestRevisionId: "revision-1",
    manifestRevisionHash: "a".repeat(64),
    contractRevisionId: null,
    contractHash: null,
    selectedCount: 1,
    terminalStatus: "complete" as const,
    publicationVolumes: [{
      publicationVolumeId: "volume-1",
      attempt: 0,
      applePlaylistId: "p.test",
      appendedCount: 1,
      startPosition: 0,
      endPosition: 0,
    }],
    pipelineOutcome: null,
  };
  expect("commitPublicationCompletion" in publication).toBe(true);
  await publication.commitPublicationCompletion?.(completionFence);
  expect(source.commitPublicationCompletion).toHaveBeenCalledWith(completionFence);
});

test("production worker refuses startup when provider or encryption secrets are absent", () => {
  expect(() => assertProductionWorkerSecrets({ NODE_ENV: "development" })).not.toThrow();
  expect(() => assertProductionWorkerSecrets({ NODE_ENV: "production" })).toThrow(/OPENAI_API_KEY/);
  expect(() => assertProductionWorkerSecrets({
    NODE_ENV: "production",
    AUTO_RUN_COST_LIMIT_USD: "NaN",
  })).toThrow(/AUTO_RUN_COST_LIMIT_USD/u);
  expect(() => assertProductionWorkerSecrets({
    NODE_ENV: "production",
    OPENAI_API_KEY: "openai",
    APPLE_TEAM_ID: "team",
    APPLE_KEY_ID: "key",
    APPLE_MEDIA_ID: "media",
    APPLE_TOKEN_ENCRYPTION_KEY: "encryption",
    APPLE_MUSICKIT_PRIVATE_KEY_BASE64: "private-key",
  })).not.toThrow();
});

test("production worker meters both live retrieval and cold corpus provider calls", () => {
  const source = readFileSync(new URL("../server/worker-runner.ts", import.meta.url), "utf8");
  expect(source).toMatch(
    /const meteredV3Response = createMeteredPipelineV3Response\(repository\);/u,
  );
  expect(source).toMatch(
    /createPipelineV3LiveAdapters\(\{[\s\S]*?createResponse: meteredV3Response,[\s\S]*?\}\)/u,
  );
  expect(source).toContain(
    "createHostedColdCorpusBuilderV3({ createResponse: meteredV3Response })",
  );
});

test("production deep workers require read-only catalog credentials but not user-token decryption", () => {
  const readOnlyCatalogEnvironment = {
    NODE_ENV: "production",
    OPENAI_API_KEY: "openai",
    APPLE_TEAM_ID: "team",
    APPLE_KEY_ID: "key",
    APPLE_MEDIA_ID: "media",
    APPLE_MUSICKIT_PRIVATE_KEY_BASE64: "private-key",
  };
  expect(() => assertProductionWorkerSecrets(readOnlyCatalogEnvironment, "deep")).not.toThrow();
  expect(() => assertProductionWorkerSecrets(readOnlyCatalogEnvironment, "interactive"))
    .toThrow(/APPLE_TOKEN_ENCRYPTION_KEY/u);
  expect(() => assertProductionWorkerSecrets({
    ...readOnlyCatalogEnvironment,
    APPLE_TOKEN_ENCRYPTION_KEY: "encryption",
  }, "all")).toThrow(/isolated interactive or deep queue class/u);
});

test("deep-worker handlers expose research and catalog matching only", () => {
  const handlers = defaultJobHandlers(methodProxy(), { queueClass: "deep" });
  expect(Object.keys(handlers).sort()).toEqual(["matching", "research"]);
  expect("publication" in handlers).toBe(false);
  expect("apple_authorization" in handlers).toBe(false);
  expect("notification" in handlers).toBe(false);
  expect("retention" in handlers).toBe(false);
  expect("pipeline_observability" in handlers).toBe(false);
});

test("deep workers advertise and lease only the deep lane without authorization recovery", async () => {
  const harness = runnerHarness();
  harness.repository.leaseNextJob.mockResolvedValue(null);
  const runner = new WorkerRunner(harness.repository, {
    queueClass: "deep",
    concurrency: 1,
    pollMs: 5,
    heartbeatMs: 60_000,
    controlIntervalMs: 60_000,
  });
  const running = runner.run();
  try {
    await waitFor(() => harness.repository.leaseNextJob.mock.calls.length > 0);
    expect(harness.repository.updateWorkerHeartbeat).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ queueClass: "deep" }),
    );
    expect(harness.repository.leaseNextJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      expect.any(Object),
      "deep",
    );
    expect(harness.repository.getAppleAuthorization).not.toHaveBeenCalled();
    expect(harness.repository.listWaitingPublicationManifests).not.toHaveBeenCalled();
    expect(harness.repository.enqueueJob).not.toHaveBeenCalled();
  } finally {
    await runner.stop();
    await running;
  }
});

test("worker startup durably recovers an unverified Apple authorization", async () => {
  const harness = runnerHarness();
  const unverified = { ...validAuthorization, status: "unverified" };
  harness.repository.getAppleAuthorization.mockResolvedValue(unverified);
  harness.repository.leaseNextJob.mockResolvedValue(null);
  const runner = new WorkerRunner(harness.repository, {
    concurrency: 1,
    pollMs: 5,
    heartbeatMs: 60_000,
  });
  const running = runner.run();
  try {
    await waitFor(() => harness.repository.enqueueJob.mock.calls.some(
      ([input]: [{ kind?: string }]) => input.kind === "apple_authorization",
    ));
    expect(harness.repository.updateWorkerHeartbeat).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ protocolVersion: WORKER_PIPELINE_PROTOCOL_VERSION }),
    );
    expect(harness.repository.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
      kind: "apple_authorization",
      payload: { authorizationGeneration: expect.stringMatching(/^[a-f0-9]{20}$/u) },
      dedupeKey: expect.stringMatching(/^apple-authorization:[a-f0-9]{20}$/u),
      maxAttempts: 6,
    }));
  } finally {
    await runner.stop();
    await running;
  }
});

test("worker heartbeat reconciles an unverified Apple authorization saved after startup", async () => {
  const harness = runnerHarness();
  let authorization: AppleAuthorizationRecord = validAuthorization;
  harness.repository.getAppleAuthorization.mockImplementation(async () => authorization);
  harness.repository.leaseNextJob.mockResolvedValue(null);
  const runner = new WorkerRunner(harness.repository, {
    concurrency: 1,
    pollMs: 5,
    heartbeatMs: 10,
    controlIntervalMs: 60_000,
  });
  const running = runner.run();
  try {
    await waitFor(() => harness.repository.updateWorkerHeartbeat.mock.calls.length >= 1);
    harness.repository.enqueueJob.mockClear();
    authorization = { ...validAuthorization, status: "unverified" };
    await waitFor(() => harness.repository.enqueueJob.mock.calls.some(
      ([input]: [{ kind?: string }]) => input.kind === "apple_authorization",
    ));
    expect(harness.repository.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
      kind: "apple_authorization",
      payload: { authorizationGeneration: appleAuthorizationGeneration(authorization) },
      dedupeKey: appleAuthorizationJobDedupeKey(authorization),
      maxAttempts: 6,
    }));
  } finally {
    await runner.stop();
    await running;
  }
});

test("worker heartbeat independently resumes publications after Apple authorization becomes valid", async () => {
  const harness = runnerHarness();
  harness.repository.listWaitingPublicationManifests.mockResolvedValue([{ manifestId: "manifest-waiting", runId: "run-waiting" }]);
  harness.repository.enqueueWaitingPublicationRecovery.mockResolvedValue(true);
  harness.repository.leaseNextJob.mockResolvedValue(null);
  const runner = new WorkerRunner(harness.repository, {
    concurrency: 1,
    pollMs: 5,
    heartbeatMs: 60_000,
    controlIntervalMs: 60_000,
  });
  const running = runner.run();
  try {
    await waitFor(() => harness.repository.enqueueWaitingPublicationRecovery.mock.calls.length > 0);
    expect(harness.repository.enqueueWaitingPublicationRecovery).toHaveBeenCalledWith({
      runId: "run-waiting",
      manifestId: "manifest-waiting",
      dedupeKey: `publication:manifest-waiting:reauth:${appleAuthorizationGeneration(validAuthorization)}:legacy`,
    });
  } finally {
    await runner.stop();
    await running;
  }
});

test("a publication-recovery reconciliation error cannot prevent worker startup", async () => {
  const harness = runnerHarness();
  harness.repository.listWaitingPublicationManifests
    .mockRejectedValueOnce(new Error("private transient database failure"))
    .mockResolvedValue([]);
  harness.repository.leaseNextJob.mockResolvedValue(null);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const runner = new WorkerRunner(harness.repository, {
    concurrency: 1,
    pollMs: 5,
    heartbeatMs: 10,
    controlIntervalMs: 60_000,
  });
  const running = runner.run();
  try {
    await waitFor(() => harness.repository.leaseNextJob.mock.calls.length > 0);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("publication recovery reconciliation failed"));
  } finally {
    await runner.stop();
    await running;
    stderr.mockRestore();
  }
});

function controlRepository(input: {
  paused?: boolean;
  authorization?: AppleAuthorizationRecord | null;
  run?: { status: string; phase: string } | null;
} = {}): PublicationRepository {
  const source = methodProxy();
  source.getSetting.mockResolvedValue(input.paused ? "true" : "false");
  source.getAppleAuthorization.mockResolvedValue(input.authorization === undefined ? validAuthorization : input.authorization);
  source.getRunControlState.mockResolvedValue(input.run === undefined ? { status: "publishing", phase: "apple_publication" } : input.run);
  return source as PublicationRepository;
}

test("publication control checks stop owner pauses, cancellation, and token generation changes", async () => {
  await expect(assertPublicationControl(controlRepository({ paused: true }), validAuthorization, undefined, "run"))
    .rejects.toBeInstanceOf(PublicationPausedError);
  await expect(assertPublicationControl(controlRepository({ run: { status: "failed", phase: "owner_cancelled" } }), validAuthorization, undefined, "run"))
    .rejects.toBeInstanceOf(PublicationRunCancelledError);
  await expect(assertPublicationControl(controlRepository({ run: null }), validAuthorization, undefined, "run"))
    .rejects.toBeInstanceOf(PublicationRunCancelledError);
  await expect(assertPublicationControl(controlRepository({ authorization: { ...validAuthorization, ciphertext: "replacement" } }), validAuthorization, undefined, "run"))
    .rejects.toBeInstanceOf(PublicationPausedError);
  await expect(assertPublicationControl(controlRepository(), validAuthorization, undefined, "run"))
    .resolves.toMatchObject({ ciphertext: validAuthorization.ciphertext, status: "valid" });
});

function track(index: number, catalogId = `catalog-${index}`): LockedManifestTrack {
  return { candidateId: `candidate-${index}`, catalogId, artist: "Artist", title: `Track ${index}` };
}

test("the deterministic 6,000-track plan preserves order, duplicates, and Apple batch limits", () => {
  const tracks = Array.from({ length: 6_000 }, (_, index) => track(index));
  tracks[24] = track(24, "duplicate-occurrence");
  tracks[25] = track(25, "between-duplicates");
  tracks[26] = track(26, "duplicate-occurrence");

  const plan = planPublicationVolumes(tracks);
  expect(plan).toHaveLength(6);
  expect(plan.every((volume) => volume.catalogIds.length === 1_000)).toBe(true);
  expect(plan.map((volume) => [volume.startPosition, volume.endPosition])).toEqual([
    [0, 999], [1_000, 1_999], [2_000, 2_999], [3_000, 3_999], [4_000, 4_999], [5_000, 5_999],
  ]);

  const simulatedVolumes = plan.map((volume) => {
    const appended: string[] = [];
    while (appended.length < volume.catalogIds.length) {
      const batch = nextPublicationAppendBatch(volume.catalogIds, appended.length);
      expect(batch.length).toBeGreaterThan(0);
      expect(batch.length).toBeLessThanOrEqual(25);
      appended.push(...batch);
    }
    return appended;
  });
  expect(simulatedVolumes.flat()).toEqual(tracks.map((item) => item.catalogId));
  expect(simulatedVolumes[0]?.slice(24, 27)).toEqual(["duplicate-occurrence", "between-duplicates", "duplicate-occurrence"]);
  expect(manifestContentHash(tracks)).not.toBe(manifestContentHash(tracks.filter((_, index) => index !== 26)));
});

test("ordered-prefix reconciliation rejects divergence, including duplicate reordering", () => {
  const expected = ["a", "duplicate", "b", "duplicate", "c"];
  expect(exactOrderedPrefix(["a", "duplicate", "b"], expected)).toBe(true);
  expect(exactOrderedPrefix(["a", "duplicate", "duplicate"], expected)).toBe(false);
  expect(exactOrderedPrefix([...expected, "extra"], expected)).toBe(false);
});

test("publication is partial when candidates or documented source coverage remain incomplete", () => {
  expect(publicationTerminalStatus({ omittedCandidateCount: 0, unresolvedCoverageCount: 0 })).toBe("complete");
  expect(publicationTerminalStatus({ omittedCandidateCount: 1, unresolvedCoverageCount: 0 })).toBe("partial");
  expect(publicationTerminalStatus({ omittedCandidateCount: 0, unresolvedCoverageCount: 1 })).toBe("partial");
});

interface RunnerHarness {
  repository: any;
  job: DurableJob;
  setPaused(value: boolean): void;
  cancelRun(): void;
  deleteRun(): void;
}

function runnerHarness(): RunnerHarness {
  let leased = false;
  let researchPaused = false;
  let run: { status: string; phase: string } | null = { status: "researching", phase: "source_discovery" };
  const job: DurableJob = {
    id: "job-1",
    runId: "run-1",
    briefRequestId: null,
    kind: "research",
    payload: { runId: "run-1" },
    attempts: 1,
    maxAttempts: 3,
    pipelineVersion: "legacy_v1",
    minimumWorkerProtocol: 4,
  };
  const repository = methodProxy();
  repository.ensureSchemaVersion.mockResolvedValue(undefined);
  repository.updateWorkerHeartbeat.mockResolvedValue(undefined);
  repository.enqueueJob.mockResolvedValue({});
  repository.leaseNextJob.mockImplementation(async () => {
    if (leased) return null;
    leased = true;
    return job;
  });
  repository.renewJobLease.mockResolvedValue(true);
  repository.getSetting.mockImplementation(async (key: string) => key === "research_paused" && researchPaused ? "true" : "false");
  repository.getAppleAuthorization.mockResolvedValue(validAuthorization);
  repository.listWaitingPublicationManifests.mockResolvedValue([]);
  repository.enqueueWaitingPublicationRecovery.mockResolvedValue(false);
  repository.getRunControlState.mockImplementation(async () => run);
  repository.deferJob.mockResolvedValue(undefined);
  repository.cancelLeasedJob.mockResolvedValue(undefined);
  repository.completeJob.mockResolvedValue(undefined);
  repository.failJob.mockResolvedValue(undefined);
  repository.runRetentionSweep.mockResolvedValue(0);
  return {
    repository,
    job,
    setPaused(value) { researchPaused = value; },
    cancelRun() { run = { status: "failed", phase: "owner_cancelled" }; },
    deleteRun() { run = null; },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for worker state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function abortableHandler(onStarted: () => void) {
  return async (_payload: Record<string, unknown>, signal: AbortSignal): Promise<void> => {
    onStarted();
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
}

test("an emergency pause aborts and defers an active paid job for resumption", async () => {
  const harness = runnerHarness();
  let started = false;
  const runner = new WorkerRunner(harness.repository, {
    concurrency: 1,
    pollMs: 5,
    controlIntervalMs: 5,
    heartbeatMs: 60_000,
    renewMs: 60_000,
    handlers: { research: abortableHandler(() => { started = true; }) },
  });
  const running = runner.run();
  try {
    await waitFor(() => started);
    harness.setPaused(true);
    await waitFor(() => harness.repository.deferJob.mock.calls.length === 1);
    expect(harness.repository.cancelLeasedJob).not.toHaveBeenCalled();
    expect(harness.repository.completeJob).not.toHaveBeenCalled();
  } finally {
    await runner.stop();
    await running;
  }
});

test("owner cancellation aborts and permanently cancels an active lease", async () => {
  const harness = runnerHarness();
  let started = false;
  const runner = new WorkerRunner(harness.repository, {
    concurrency: 1,
    pollMs: 5,
    controlIntervalMs: 5,
    heartbeatMs: 60_000,
    renewMs: 60_000,
    handlers: { research: abortableHandler(() => { started = true; }) },
  });
  const running = runner.run();
  try {
    await waitFor(() => started);
    harness.cancelRun();
    await waitFor(() => harness.repository.cancelLeasedJob.mock.calls.length === 1);
    expect(harness.repository.deferJob).not.toHaveBeenCalled();
    expect(harness.repository.completeJob).not.toHaveBeenCalled();
  } finally {
    await runner.stop();
    await running;
  }
});

test("visitor deletion aborts an active lease without requeueing it", async () => {
  const harness = runnerHarness();
  let started = false;
  const runner = new WorkerRunner(harness.repository, {
    concurrency: 1,
    pollMs: 5,
    controlIntervalMs: 5,
    heartbeatMs: 60_000,
    renewMs: 60_000,
    handlers: { research: abortableHandler(() => { started = true; }) },
  });
  const running = runner.run();
  try {
    await waitFor(() => started);
    harness.deleteRun();
    await waitFor(() => harness.repository.cancelLeasedJob.mock.calls.length === 1);
    expect(harness.repository.deferJob).not.toHaveBeenCalled();
    expect(harness.repository.completeJob).not.toHaveBeenCalled();
  } finally {
    await runner.stop();
    await running;
  }
});

test("terminal worker failures are sanitized before crossing the repository boundary", async () => {
  const harness = runnerHarness();
  harness.job.kind = "publication";
  harness.job.maxAttempts = 1;
  const privateFailure = "provider failure sk-proj-PRIVATE postgres://user:password@private.example/needle";
  const runner = new WorkerRunner(harness.repository, {
    concurrency: 1,
    pollMs: 5,
    controlIntervalMs: 60_000,
    heartbeatMs: 60_000,
    renewMs: 60_000,
    handlers: { publication: async () => { throw new Error(privateFailure); } },
  });
  const running = runner.run();
  try {
    await waitFor(() => harness.repository.failJob.mock.calls.length === 1);
    expect(harness.repository.updateRun).not.toHaveBeenCalled();
    expect(harness.repository.failJob).toHaveBeenCalledWith(
      harness.job.id,
      expect.any(String),
      "Apple publication failed after the final attempt; provider details were redacted.",
      null,
      undefined,
    );
    expect(JSON.stringify(harness.repository.failJob.mock.calls)).not.toContain("sk-proj-PRIVATE");
    expect(JSON.stringify(harness.repository.failJob.mock.calls)).not.toContain("postgres://");
  } finally {
    await runner.stop();
    await running;
  }
});

test("non-retriable Apple authorization rejections fail without six delayed attempts", async () => {
  const harness = runnerHarness();
  harness.job.kind = "apple_authorization";
  harness.job.runId = null;
  harness.job.maxAttempts = 6;
  const runner = new WorkerRunner(harness.repository, {
    concurrency: 1,
    pollMs: 5,
    controlIntervalMs: 60_000,
    heartbeatMs: 60_000,
    renewMs: 60_000,
    handlers: {
      apple_authorization: async () => {
        throw new AppleApiError("private Apple response", 422, false);
      },
    },
  });
  const running = runner.run();
  try {
    await waitFor(() => harness.repository.failJob.mock.calls.length === 1);
    expect(harness.repository.failJob).toHaveBeenCalledWith(
      harness.job.id,
      expect.any(String),
      "Apple Music rejected gênio's authorization validation request (HTTP 422).",
      null,
      undefined,
    );
  } finally {
    await runner.stop();
    await running;
  }
});
