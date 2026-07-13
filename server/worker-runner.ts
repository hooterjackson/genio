import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ResearchOrchestrator, processBriefInterpretationJob, type ResearchRepository } from "./research.ts";
import { processMatchingJob, type MatchingRepository } from "./matching-service.ts";
import { processPublicationJob, PublicationPausedError, type PublicationRepository } from "./publisher.ts";
import { processNotificationJob, type NotificationRepository } from "./notifications.ts";
import { processAppleAuthorizationJob, type AppleAuthorizationJobRepository } from "./apple.ts";
import { Repository } from "./repository.ts";
import {
  createAppleAuthorizationRepositoryFacade,
  createMatchingRepositoryFacade,
  createNotificationRepositoryFacade,
  createPublicationRepositoryFacade,
  createResearchRepositoryFacade,
} from "./worker-facades.ts";

const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_RENEW_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_CONTROL_INTERVAL_MS = 5_000;

function positiveEnv(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), maximum) : fallback;
}

export interface DurableJob {
  id: string;
  runId: string | null;
  briefRequestId: string | null;
  kind: "brief" | "research" | "matching" | "publication" | "notification" | string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export interface WorkerQueueRepository {
  ensureSchemaVersion(): Promise<void>;
  leaseNextJob(workerId: string, leaseMs: number): Promise<DurableJob | null>;
  renewJobLease(jobId: string, workerId: string, leaseMs: number): Promise<boolean>;
  deferJob(jobId: string, workerId: string, availableAt: Date, reason: string): Promise<void>;
  cancelLeasedJob(jobId: string, workerId: string, reason: string): Promise<void>;
  completeJob(jobId: string, workerId: string): Promise<void>;
  failJob(jobId: string, workerId: string, error: string, retryAt: Date | null): Promise<void>;
  updateWorkerHeartbeat(workerId: string, metadata: {
    startedAt: string;
    seenAt: string;
    activeJobIds: string[];
    version: string;
    capacity?: number;
    activeJobs?: number;
  }): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  getRunControlState(runId: string): Promise<{ status: string; phase: string } | null>;
  runRetentionSweep(limit?: number): Promise<number>;
}

export type WorkerRepository = WorkerQueueRepository
  & ResearchRepository
  & MatchingRepository
  & PublicationRepository
  & AppleAuthorizationJobRepository
  & NotificationRepository;

export type JobHandler = (payload: Record<string, unknown>, signal: AbortSignal) => Promise<void>;

export interface WorkerRunnerOptions {
  workerId?: string;
  version?: string;
  concurrency?: number;
  leaseMs?: number;
  renewMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  controlIntervalMs?: number;
  handlers?: Record<string, JobHandler>;
}

const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason ?? new Error("Worker stopped"));
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error("Worker stopped"));
  }, { once: true });
});

function retryAtFor(job: DurableJob): Date | null {
  if (job.attempts >= job.maxAttempts) return null;
  return new Date(Date.now() + Math.min(2 ** Math.max(0, job.attempts - 1) * 30_000, 15 * 60_000));
}

export function defaultJobHandlers(repository: WorkerRepository): Record<string, JobHandler> {
  const researchRepository = createResearchRepositoryFacade(repository);
  const matchingRepository = createMatchingRepositoryFacade(repository);
  const publicationRepository = createPublicationRepositoryFacade(repository);
  const notificationRepository = createNotificationRepositoryFacade(repository);
  const appleAuthorizationRepository = createAppleAuthorizationRepositoryFacade(repository);
  const research = new ResearchOrchestrator(researchRepository);
  return {
    brief: async (payload, signal) => processBriefInterpretationJob(researchRepository, payload, signal),
    research: async (payload, signal) => research.processJob(payload, signal),
    matching: async (payload, signal) => processMatchingJob(matchingRepository, payload, signal),
    publication: async (payload, signal) => processPublicationJob(publicationRepository, payload, signal),
    notification: async (payload, signal) => processNotificationJob(notificationRepository, payload, signal),
    apple_authorization: async (payload, signal) => processAppleAuthorizationJob(appleAuthorizationRepository, payload, signal),
    retention: async (_payload, signal) => {
      signal.throwIfAborted();
      await repository.runRetentionSweep(100);
      signal.throwIfAborted();
    },
  };
}

export function assertProductionWorkerSecrets(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.NODE_ENV !== "production") return;
  const required = [
    "OPENAI_API_KEY",
    "APPLE_TEAM_ID",
    "APPLE_KEY_ID",
    "APPLE_MEDIA_ID",
    "APPLE_TOKEN_ENCRYPTION_KEY",
  ];
  const missing = required.filter((name) => !environment[name]?.trim());
  if (!environment.APPLE_MUSICKIT_PRIVATE_KEY?.trim() && !environment.APPLE_MUSICKIT_PRIVATE_KEY_BASE64?.trim()) {
    missing.push("APPLE_MUSICKIT_PRIVATE_KEY or APPLE_MUSICKIT_PRIVATE_KEY_BASE64");
  }
  if (missing.length > 0) {
    throw new Error(`Production worker cannot start; missing required service secrets: ${missing.join(", ")}`);
  }
}

export class WorkerRunner {
  readonly workerId: string;
  private readonly version: string;
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly renewMs: number;
  private readonly heartbeatMs: number;
  private readonly pollMs: number;
  private readonly controlIntervalMs: number;
  private readonly handlers: Record<string, JobHandler>;
  private readonly active = new Map<string, {
    promise: Promise<void>;
    controller: AbortController;
    job: DurableJob;
    controlAction: "pause" | "cancel" | null;
  }>();
  private readonly controller = new AbortController();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private controlTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt = new Date().toISOString();

  constructor(private readonly repository: WorkerRepository, options: WorkerRunnerOptions = {}) {
    this.workerId = options.workerId ?? `${process.env.RAILWAY_REPLICA_ID ?? "local"}-${randomUUID()}`;
    this.version = options.version ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.APP_VERSION ?? "development";
    this.concurrency = Math.min(Math.max(options.concurrency ?? 2, 1), 2);
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.renewMs = options.renewMs ?? DEFAULT_RENEW_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.controlIntervalMs = options.controlIntervalMs ?? DEFAULT_CONTROL_INTERVAL_MS;
    this.handlers = { ...defaultJobHandlers(repository), ...(options.handlers ?? {}) };
  }

  async run(): Promise<void> {
    assertProductionWorkerSecrets();
    await this.repository.ensureSchemaVersion();
    await this.heartbeat();
    await this.enforceControls();
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch((error) => {
        const message = error instanceof Error ? error.message : "heartbeat failed";
        process.stderr.write(`[needle-worker] heartbeat: ${message}\n`);
      });
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
    this.controlTimer = setInterval(() => {
      void this.enforceControls().catch((error) => {
        const message = error instanceof Error ? error.message : "control check failed";
        process.stderr.write(`[needle-worker] controls: ${message}\n`);
      });
    }, this.controlIntervalMs);
    this.controlTimer.unref?.();

    try {
      while (!this.controller.signal.aborted) {
        let claimed = false;
        while (this.active.size < this.concurrency && !this.controller.signal.aborted) {
          const job = await this.repository.leaseNextJob(this.workerId, this.leaseMs);
          if (!job) break;
          claimed = true;
          const controller = new AbortController();
          const active = { promise: Promise.resolve(), controller, job, controlAction: null as "pause" | "cancel" | null };
          this.active.set(job.id, active);
          const promise = this.execute(job, controller)
            .catch((error) => {
              const message = error instanceof Error ? error.message : "job finalization failed";
              process.stderr.write(`[needle-worker] job ${job.id} finalization: ${message}\n`);
            })
            .finally(() => {
              if (this.active.get(job.id) === active) this.active.delete(job.id);
            });
          active.promise = promise;
        }
        if (!claimed) {
          await wait(this.active.size > 0 ? Math.min(this.pollMs, 500) : this.pollMs, this.controller.signal).catch(() => undefined);
        }
      }
    } finally {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (this.controlTimer) clearInterval(this.controlTimer);
      await Promise.allSettled([...this.active.values()].map((item) => item.promise));
    }
  }

  async stop(reason = "Worker shutdown"): Promise<void> {
    if (!this.controller.signal.aborted) this.controller.abort(new Error(reason));
    for (const item of this.active.values()) item.controller.abort(new Error(reason));
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.controlTimer) clearInterval(this.controlTimer);
    await Promise.allSettled([...this.active.values()].map((item) => item.promise));
  }

  private async heartbeat(): Promise<void> {
    await this.repository.updateWorkerHeartbeat(this.workerId, {
      startedAt: this.startedAt,
      seenAt: new Date().toISOString(),
      activeJobIds: [...this.active.keys()],
      version: this.version,
      capacity: this.concurrency,
      activeJobs: this.active.size,
    });
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    await this.repository.enqueueJob({
      kind: "retention",
      payload: { day },
      dedupeKey: `retention:${day}`,
      maxAttempts: 3,
    });
  }

  private async enforceControls(): Promise<void> {
    const [researchPaused, publishingPaused, apple] = await Promise.all([
      this.repository.getSetting("research_paused"),
      this.repository.getSetting("publishing_paused"),
      this.repository.getAppleAuthorization(),
    ]);
    for (const active of this.active.values()) {
      const cancellationReason = await this.runCancellationReason(active.job);
      if (cancellationReason) {
        active.controlAction = "cancel";
        if (!active.controller.signal.aborted) active.controller.abort(new Error(cancellationReason));
        continue;
      }
      const paidResearch = ["brief", "research", "matching"].includes(active.job.kind);
      const publication = active.job.kind === "publication";
      const mustPause = (paidResearch && researchPaused === "true")
        || (publication && (publishingPaused === "true" || !apple || apple.status !== "valid"));
      if (!mustPause || active.controlAction === "cancel") continue;
      active.controlAction = "pause";
      if (!active.controller.signal.aborted) {
        active.controller.abort(new Error(publication && (!apple || apple.status !== "valid")
          ? "Apple authorization was revoked"
          : "Owner emergency pause"));
      }
    }
  }

  private async runCancellationReason(job: DurableJob): Promise<string | null> {
    if (!job.runId) return null;
    const run = await this.repository.getRunControlState(job.runId);
    if (!run) return "Run was deleted";
    if (run.status === "deleted" || run.status === "expired" || run.phase === "visitor_deleted") return "Run was deleted";
    if (run.phase === "owner_cancelled") return "Run was cancelled by the owner";
    return null;
  }

  private async execute(job: DurableJob, controller: AbortController): Promise<void> {
    const handler = this.handlers[job.kind];
    let leaseLost = false;
    const renewal = setInterval(() => {
      void this.repository.renewJobLease(job.id, this.workerId, this.leaseMs).then((renewed) => {
        if (!renewed && !controller.signal.aborted) {
          leaseLost = true;
          controller.abort(new Error("Job lease was lost"));
        }
      }).catch(() => {
        leaseLost = true;
        if (!controller.signal.aborted) controller.abort(new Error("Job lease could not be renewed"));
      });
    }, this.renewMs);
    renewal.unref?.();

    try {
      if (!handler) throw new NonRetriableJobError(`Unknown durable job kind ${job.kind}`);
      const cancellationBeforeStart = await this.runCancellationReason(job);
      if (cancellationBeforeStart) {
        await this.repository.cancelLeasedJob(job.id, this.workerId, cancellationBeforeStart);
        return;
      }
      await handler({
        ...job.payload,
        ...(job.runId && !job.payload.runId ? { runId: job.runId } : {}),
        ...(job.briefRequestId && !job.payload.briefRequestId ? { briefRequestId: job.briefRequestId } : {}),
      }, controller.signal);
      if (leaseLost) return;
      const cancellationAfterHandler = await this.runCancellationReason(job);
      const controlAction = this.active.get(job.id)?.controlAction;
      if (cancellationAfterHandler || controlAction === "cancel") {
        await this.repository.cancelLeasedJob(job.id, this.workerId, cancellationAfterHandler ?? "Run was cancelled");
        return;
      }
      if (controlAction === "pause") {
        await this.repository.deferJob(job.id, this.workerId, new Date(Date.now() + 60_000), "Deferred by owner control");
        return;
      }
      await this.repository.completeJob(job.id, this.workerId);
    } catch (error) {
      if (leaseLost) return;
      const cancellationReason = await this.runCancellationReason(job);
      const controlAction = this.active.get(job.id)?.controlAction;
      if (cancellationReason || controlAction === "cancel") {
        await this.repository.cancelLeasedJob(job.id, this.workerId, cancellationReason ?? "Run was cancelled");
        return;
      }
      if (controlAction === "pause" || error instanceof PublicationPausedError) {
        const reason = error instanceof PublicationPausedError ? error.message : "Deferred by owner control";
        await this.repository.deferJob(job.id, this.workerId, new Date(Date.now() + 60_000), reason);
        return;
      }
      const message = error instanceof Error ? error.message.slice(0, 1_000) : "Job failed";
      const retryAt = error instanceof NonRetriableJobError ? null : retryAtFor(job);
      if (!retryAt && job.runId && ["research", "matching", "publication"].includes(job.kind)) {
        await this.repository.updateRun(job.runId, {
          status: "failed",
          phase: `${job.kind}_failed`,
          error: message,
        }).catch((updateError) => {
          const updateMessage = updateError instanceof Error ? updateError.message : "run update failed";
          process.stderr.write(`[needle-worker] could not mark run failed: ${updateMessage}\n`);
        });
      }
      await this.repository.failJob(
        job.id,
        this.workerId,
        message,
        retryAt,
      );
    } finally {
      clearInterval(renewal);
    }
  }
}

class NonRetriableJobError extends Error {
  readonly name = "NonRetriableJobError";
}

async function runExecutableWorker(): Promise<void> {
  const repository = new Repository();
  const leaseMs = positiveEnv("WORKER_LEASE_SECONDS", DEFAULT_LEASE_MS / 1_000, 30 * 60) * 1_000;
  const renewMs = Math.min(
    positiveEnv("WORKER_RENEW_SECONDS", DEFAULT_RENEW_MS / 1_000, 10 * 60) * 1_000,
    Math.max(1_000, leaseMs - 1_000),
  );
  const runner = new WorkerRunner(repository, {
    concurrency: positiveEnv("WORKER_CONCURRENCY", 2, 2),
    leaseMs,
    renewMs,
    heartbeatMs: positiveEnv("WORKER_HEARTBEAT_SECONDS", DEFAULT_HEARTBEAT_MS / 1_000, 5 * 60) * 1_000,
    pollMs: positiveEnv("WORKER_POLL_MS", DEFAULT_POLL_MS, 60_000),
  });
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[needle-worker] ${signal}; draining jobs\n`);
    try {
      await runner.stop(signal);
    } finally {
      await repository.close();
    }
  };
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.once("SIGINT", () => { void shutdown("SIGINT"); });

  try {
    await runner.run();
  } finally {
    if (!shuttingDown) await repository.close();
  }
}

const isMainModule = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMainModule) {
  runExecutableWorker().catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown worker failure";
    process.stderr.write(`[needle-worker] fatal: ${message}\n`);
    process.exitCode = 1;
  });
}
