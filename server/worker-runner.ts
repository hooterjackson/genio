import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ResearchOrchestrator, processBriefInterpretationJob, type ResearchRepository } from "./research.ts";
import { processMatchingJob, type MatchingRepository } from "./matching-service.ts";
import { processPublicationJob, PublicationPausedError, type PublicationRepository } from "./publisher.ts";
import { processNotificationJob, type NotificationRepository } from "./notifications.ts";
import {
  AppleApiError,
  processAppleAuthorizationJob,
  recoverUnverifiedAppleAuthorizationJob,
  recoverWaitingApplePublicationJobs,
  type AppleAuthorizationJobRepository,
  type ApplePublicationRecoveryRepository,
} from "./apple.ts";
import { Repository } from "./repository.ts";
import {
  createAppleAuthorizationRepositoryFacade,
  createMatchingRepositoryFacade,
  createNotificationRepositoryFacade,
  createPublicationRepositoryFacade,
  createResearchRepositoryFacade,
} from "./worker-facades.ts";
import {
  failureContextForJob,
  safeAppleAuthorizationFailure,
  sanitizeFailure,
} from "./error-sanitizer.ts";
import { readCostConfiguration } from "./cost-config.ts";
import {
  WORKER_PIPELINE_CAPABILITY,
  type WorkerPipelineCapability,
} from "./worker-protocol.ts";
import {
  DATABASE_SCHEMA_SUPPORT,
  type DatabaseSchemaSupport,
} from "../db/index.ts";
import type { PipelineVersion } from "../shared/types.ts";
import {
  createPipelineV3RetrievalExecutionPort,
  PipelineV3DependencyUnavailableError,
  type PipelineV3RetrievalExecutionPort,
} from "./pipeline-v3-worker-execution.ts";
import {
  createHostedColdCorpusBuilderV3,
  type ColdCorpusBuilderPortV3,
} from "./pipeline-v3-corpus-builder.ts";
import { createPipelineV3LiveAdapters } from "./pipeline-v3-live-adapters.ts";
import {
  createPipelineV3GovernedGraphDiscovery,
  PgPipelineV3GovernedGraphReadRepository,
} from "./pipeline-v3-governed-graph-adapter.ts";
import { createMeteredPipelineV3Response } from "./pipeline-v3-provider-meter.ts";
import {
  parseWorkerQueueClass,
  type JobQueueClass,
  type WorkerQueueClass,
} from "./job-queue-class.ts";
import { runtimeReleaseContract } from "./runtime-release.ts";
import { sha256Hex, stableStringify } from "./security.ts";
import {
  DEPENDENCY_DURABLE_RETRY_DELAYS_MS_V1,
  decideDependencyCircuitV1,
} from "./dependency-circuit-v1.ts";
import { createAdaptiveRunDecisionV1 } from "./adaptive-run-decision-v1.ts";
import {
  assertPlaylistContractIntegrityV1,
  type PlaylistContractRevisionV1,
} from "./playlist-contract-v1.ts";

const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_RENEW_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_CONTROL_INTERVAL_MS = 5_000;
const PIPELINE_OBSERVABILITY_MAX_CATCHUP_HOURS = 24;
const WORKER_CONFIGURATION_ENV_KEYS = [
  "NODE_ENV",
  "PIPELINE_V2_OWNER_CANARY",
  "PIPELINE_V2_CURATED_PERCENT",
  "PIPELINE_V2_SIMILARITY_PERCENT",
  "PIPELINE_V2_FACTUAL_OWNER_CANARY",
  "PIPELINE_V2_FACTUAL_PERCENT",
  "PIPELINE_V3_ASSIGNMENT_ENABLED",
  "PIPELINE_V3_OWNER_CANARY",
  "PIPELINE_V3_OWNER_CANARY_GROUPS",
  "PIPELINE_V3_OWNER_CANARY_MAX_TRACKS",
  "PIPELINE_V3_GENRE_SCENE_PERCENT",
  "PIPELINE_V3_MOOD_ACTIVITY_PERCENT",
  "PIPELINE_V3_SIMILARITY_PERCENT",
  "PIPELINE_V3_ARTIST_CATALOGUE_PERCENT",
  "PIPELINE_V3_FIXED_CONTAINER_PERCENT",
  "PIPELINE_V3_FACTUAL_PERCENT",
  "PIPELINE_V3_EXHAUSTIVE_PERCENT",
  "PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION",
  "GUIDANCE_CONTRACT_V2_ENABLED",
  "GUIDANCE_CONTRACT_V2_OWNER_CANARY",
  "GUIDANCE_CONTRACT_V3_ENABLED",
  "GUIDANCE_CONTRACT_V3_OWNER_CANARY",
  "GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED",
  "PIPELINE_V3_MAX_RAW_CANDIDATES",
  "PIPELINE_V3_MAX_ROUNDS",
  "PIPELINE_V3_MAX_TOOL_CALLS",
  "PIPELINE_V3_MAX_SEARCH_CALLS",
  "PIPELINE_V3_MAX_SYNTHESIS_TOKENS",
  "PIPELINE_V3_MAX_EXTRACTION_TOKENS",
  "RESEARCH_TURNS_PER_SEGMENT",
  "RESEARCH_MAX_SEGMENTS_PER_PASS",
  "RESEARCH_MAX_GAP_PASSES",
  "FAST_RESEARCH_MAX_WEB_CALLS",
  "FAST_RESEARCH_MAX_SYNTHESIS_TOKENS",
  "FAST_RESEARCH_MAX_EXTRACTION_TOKENS",
  "FAST_RESEARCH_SEARCH_CONTEXT",
  "APPLE_MATCHING_CONCURRENCY",
  "FAST_MATCH_LOOKUP_TIMEOUT_MS",
  "APPLE_CATALOG_RECOVERY_TIMEOUT_MS",
] as const;

function positiveEnv(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), maximum) : fallback;
}

export function workerConfigurationHash(input: {
  environment?: NodeJS.ProcessEnv;
  queueClass: WorkerQueueClass;
  concurrency: number;
  leaseMs: number;
  renewMs: number;
  heartbeatMs: number;
  pollMs: number;
  controlIntervalMs: number;
  pipelineCapability: WorkerPipelineCapability;
  schemaSupport: DatabaseSchemaSupport;
}): string {
  const environment = input.environment ?? process.env;
  const policyEnvironment = Object.fromEntries(
    WORKER_CONFIGURATION_ENV_KEYS.map((key) => [key, environment[key]?.trim() || null]),
  );
  return sha256Hex(stableStringify({
    runtime: runtimeReleaseContract(environment),
    queueClass: input.queueClass,
    concurrency: input.concurrency,
    leaseMs: input.leaseMs,
    renewMs: input.renewMs,
    heartbeatMs: input.heartbeatMs,
    pollMs: input.pollMs,
    controlIntervalMs: input.controlIntervalMs,
    pipelineCapability: input.pipelineCapability,
    schemaSupport: input.schemaSupport,
    cost: readCostConfiguration(environment),
    policyEnvironment,
  }));
}

export interface DurableJob {
  id: string;
  runId: string | null;
  briefRequestId: string | null;
  kind: "brief" | "research" | "matching" | "publication" | "notification" | string;
  /** Present on schema-14 jobs; optional while schema-13 bridge workers drain. */
  queueClass?: JobQueueClass;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  pipelineVersion: PipelineVersion;
  minimumWorkerProtocol: number;
  /** Present on schema-14 jobs; optional while schema-13 bridge workers drain. */
  queryPlanRevisionId?: string | null;
  stageKey?: string;
  leaseEpoch?: number;
}

export interface WorkerQueueRepository {
  getSchemaVersion(): Promise<string | null>;
  ensureSchemaVersion(support?: DatabaseSchemaSupport): Promise<void>;
  leaseNextJob(
    workerId: string,
    leaseMs: number,
    capability: WorkerPipelineCapability,
    queueClass: WorkerQueueClass,
  ): Promise<DurableJob | null>;
  renewJobLease(jobId: string, workerId: string, leaseMs: number, leaseEpoch?: number): Promise<boolean>;
  deferJob(jobId: string, workerId: string, availableAt: Date, reason: string, leaseEpoch?: number): Promise<void>;
  cancelLeasedJob(jobId: string, workerId: string, reason: string, leaseEpoch?: number): Promise<void>;
  completeJob(jobId: string, workerId: string, leaseEpoch?: number): Promise<void>;
  failJob(jobId: string, workerId: string, error: string, retryAt: Date | null, leaseEpoch?: number): Promise<void>;
  updateWorkerHeartbeat(workerId: string, metadata: {
    startedAt: string;
    seenAt: string;
    activeJobIds: string[];
    version: string;
    protocolVersion: string;
    capacity?: number;
    activeJobs?: number;
    [key: string]: unknown;
  }): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  getRunControlState(runId: string): Promise<{ status: string; phase: string } | null>;
  runRetentionSweep(limit?: number): Promise<number>;
  runPipelineV2OperationalAlertSweep(input?: {
    windowHours?: number;
    windowEndedAt?: Date;
  }): Promise<unknown>;
  beginPlaylistExecutionAttempt?(input: {
    runId: string;
    contractRevisionId: string;
    stage: string;
    dependencyKey?: string | null;
    attemptNumber: number;
    leaseGeneration: number;
    executorRevision: string;
    executorIdentityHash: string;
    configurationHash: string;
    idempotencyKey: string;
    checkpointCursor?: string | null;
  }): Promise<{ id: string; created: boolean; activeComputeMs?: number }>;
  getPlaylistActiveComputeAllowanceMs?(input: {
    runId: string;
    contractRevisionId: string;
  }): Promise<number>;
  completePlaylistExecutionAttempt?(input: {
    attemptId: string;
    runId: string;
    contractRevisionId: string;
    leaseGeneration: number;
    status: "blocked" | "complete" | "cancelled" | "failed";
    blockerKind?: string | null;
    checkpointCursor?: string | null;
  }): Promise<{ accepted: boolean; discarded: boolean }>;
  discardPlaylistExecutionAttempt?(input: {
    attemptId: string;
    runId: string;
    contractRevisionId: string;
    leaseGeneration: number;
  }): Promise<boolean>;
  openPlaylistRunBlocker?(input: {
    runId: string;
    contractRevisionId: string;
    blockerKind:
      | "guidance"
      | "scope_decision"
      | "provider"
      | "apple_authorization"
      | "budget"
      | "integrity"
      | "publication_reconciliation";
    dependencyKey?: string | null;
    retryCount?: number;
    nextRetryAt?: Date | null;
    automaticRetryUntil?: Date | null;
    state?: Record<string, unknown>;
  }): Promise<string>;
  getActivePlaylistRunBlocker?(input: {
    runId: string;
    contractRevisionId: string;
    blockerKind: "provider";
    dependencyKey: string;
  }): Promise<{
    id: string;
    retryCount: number;
    nextRetryAt: Date | null;
    automaticRetryUntil: Date | null;
    createdAt: Date;
    state: Record<string, unknown>;
  } | null>;
  resolvePlaylistRunBlockers?(input: {
    runId: string;
    contractRevisionId: string;
    blockerKind?: "provider" | "apple_authorization";
  }): Promise<number>;
}

export type WorkerRepository = WorkerQueueRepository
  & ResearchRepository
  & MatchingRepository
  & PublicationRepository
  & AppleAuthorizationJobRepository
  & ApplePublicationRecoveryRepository
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
  pipelineCapability?: WorkerPipelineCapability;
  schemaSupport?: DatabaseSchemaSupport;
  v3RetrievalPort?: PipelineV3RetrievalExecutionPort | null;
  v3CorpusBuilder?: ColdCorpusBuilderPortV3 | null;
  queueClass?: WorkerQueueClass;
  handlers?: Record<string, JobHandler>;
}

export function workerExecutorRevision(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment.SOURCE_COMMIT_SHA
    ?? environment.RAILWAY_GIT_COMMIT_SHA
    ?? environment.APP_VERSION
    ?? "development";
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
  if (job.kind === "apple_authorization") {
    return new Date(Date.now() + Math.min(5_000 * 2 ** Math.max(0, job.attempts - 1), 30_000));
  }
  const delay = DEPENDENCY_DURABLE_RETRY_DELAYS_MS_V1[
    Math.min(
      Math.max(0, job.attempts - 1),
      DEPENDENCY_DURABLE_RETRY_DELAYS_MS_V1.length - 1,
    )
  ]!;
  return new Date(Date.now() + delay);
}

function validRetryDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function deterministicRetryJitter(jobId: string, retryCount: number): number {
  const digest = sha256Hex(`${jobId}:${retryCount}`);
  return Number.parseInt(digest.slice(0, 8), 16) / 0xffff_ffff;
}

export function defaultJobHandlers(
  repository: WorkerRepository,
  options: {
    v3RetrievalPort?: PipelineV3RetrievalExecutionPort | null;
    v3CorpusBuilder?: ColdCorpusBuilderPortV3 | null;
    queueClass?: WorkerQueueClass;
  } = {},
): Record<string, JobHandler> {
  const researchRepository = createResearchRepositoryFacade(repository);
  const matchingRepository = createMatchingRepositoryFacade(repository);
  const research = new ResearchOrchestrator(researchRepository, {
    v3RetrievalPort: options.v3RetrievalPort ?? null,
    v3CorpusBuilder: options.v3CorpusBuilder ?? null,
  });
  const researchHandlers: Record<string, JobHandler> = {
    brief: async (payload, signal) => processBriefInterpretationJob(researchRepository, payload, signal),
    research: async (payload, signal) => research.processJob(payload, signal),
    matching: async (payload, signal) => processMatchingJob(matchingRepository, payload, signal),
  };
  if (options.queueClass === "deep") {
    // Deep workers intentionally never construct publication, authorization,
    // notification, or system-maintenance facades.
    return {
      research: researchHandlers.research!,
      matching: researchHandlers.matching!,
    };
  }
  const publicationRepository = createPublicationRepositoryFacade(repository);
  const notificationRepository = createNotificationRepositoryFacade(repository);
  const appleAuthorizationRepository = createAppleAuthorizationRepositoryFacade(repository);
  return {
    ...researchHandlers,
    publication: async (payload, signal) => processPublicationJob(publicationRepository, payload, signal),
    notification: async (payload, signal) => processNotificationJob(notificationRepository, payload, signal),
    apple_authorization: async (payload, signal) => processAppleAuthorizationJob(appleAuthorizationRepository, payload, signal),
    retention: async (_payload, signal) => {
      signal.throwIfAborted();
      await repository.runRetentionSweep(100);
      signal.throwIfAborted();
    },
    pipeline_observability: async (payload, signal) => {
      signal.throwIfAborted();
      const rawWindowEnd = typeof payload.windowEndedAt === "string"
        ? new Date(payload.windowEndedAt)
        : undefined;
      await repository.runPipelineV2OperationalAlertSweep({
        windowHours: 1,
        ...(rawWindowEnd && Number.isFinite(rawWindowEnd.getTime())
          ? { windowEndedAt: rawWindowEnd }
          : {}),
      });
      signal.throwIfAborted();
    },
  };
}

export function assertProductionWorkerSecrets(
  environment: NodeJS.ProcessEnv = process.env,
  queueClass: WorkerQueueClass = parseWorkerQueueClass(environment.WORKER_QUEUE_CLASS),
): void {
  readCostConfiguration(environment);
  if (environment.NODE_ENV !== "production") return;
  if (queueClass === "all") {
    throw new Error("Production workers must use an isolated interactive or deep queue class");
  }
  const required = [
    "OPENAI_API_KEY",
    "APPLE_TEAM_ID",
    "APPLE_KEY_ID",
    "APPLE_MEDIA_ID",
    ...(queueClass === "interactive" ? ["APPLE_TOKEN_ENCRYPTION_KEY"] : []),
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
  private readonly pipelineCapability: WorkerPipelineCapability;
  private readonly schemaSupport: DatabaseSchemaSupport;
  private readonly queueClass: WorkerQueueClass;
  private readonly configurationHash: string;
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
    this.version = options.version ?? workerExecutorRevision();
    this.concurrency = Math.min(Math.max(options.concurrency ?? 2, 1), 2);
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.renewMs = options.renewMs ?? DEFAULT_RENEW_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.controlIntervalMs = options.controlIntervalMs ?? DEFAULT_CONTROL_INTERVAL_MS;
    this.pipelineCapability = options.pipelineCapability ?? WORKER_PIPELINE_CAPABILITY;
    this.schemaSupport = options.schemaSupport ?? DATABASE_SCHEMA_SUPPORT;
    this.queueClass = options.queueClass ?? parseWorkerQueueClass(process.env.WORKER_QUEUE_CLASS);
    this.configurationHash = workerConfigurationHash({
      queueClass: this.queueClass,
      concurrency: this.concurrency,
      leaseMs: this.leaseMs,
      renewMs: this.renewMs,
      heartbeatMs: this.heartbeatMs,
      pollMs: this.pollMs,
      controlIntervalMs: this.controlIntervalMs,
      pipelineCapability: this.pipelineCapability,
      schemaSupport: this.schemaSupport,
    });
    this.handlers = {
      ...defaultJobHandlers(repository, {
        v3RetrievalPort: options.v3RetrievalPort ?? null,
        v3CorpusBuilder: options.v3CorpusBuilder ?? null,
        queueClass: this.queueClass,
      }),
      ...(options.handlers ?? {}),
    };
  }

  async run(): Promise<void> {
    assertProductionWorkerSecrets(process.env, this.queueClass);
    await this.repository.ensureSchemaVersion(this.schemaSupport);
    await this.heartbeat();
    await this.enforceControls();
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch(() => {
        process.stderr.write("[needle-worker] heartbeat failed; private diagnostics were suppressed\n");
      });
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
    this.controlTimer = setInterval(() => {
      void this.enforceControls().catch(() => {
        process.stderr.write("[needle-worker] control check failed; private diagnostics were suppressed\n");
      });
    }, this.controlIntervalMs);
    this.controlTimer.unref?.();

    try {
      while (!this.controller.signal.aborted) {
        let claimed = false;
        while (this.active.size < this.concurrency && !this.controller.signal.aborted) {
          // Do not continue leasing across a schema cutover that this binary
          // cannot safely read. The 2.2.2 bridge accepts schemas 13..16 while
          // continuing to prefer the active schema 15 until migration.
          await this.repository.ensureSchemaVersion(this.schemaSupport);
          const job = await this.repository.leaseNextJob(
            this.workerId,
            this.leaseMs,
            this.pipelineCapability,
            this.queueClass,
          );
          if (!job) break;
          claimed = true;
          const controller = new AbortController();
          const active = { promise: Promise.resolve(), controller, job, controlAction: null as "pause" | "cancel" | null };
          this.active.set(job.id, active);
          const promise = this.execute(job, controller)
            .catch(() => {
              process.stderr.write(`[needle-worker] job ${job.id} finalization failed; private diagnostics were suppressed\n`);
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
    const observedSchemaVersion = await this.repository.getSchemaVersion();
    await this.repository.updateWorkerHeartbeat(this.workerId, {
      startedAt: this.startedAt,
      seenAt: new Date().toISOString(),
      activeJobIds: [...this.active.keys()],
      version: this.version,
      schemaVersion: this.schemaSupport.preferred,
      schemaMinimum: this.schemaSupport.minimum,
      schemaMaximum: this.schemaSupport.maximum,
      schemaPreferred: this.schemaSupport.preferred,
      observedSchemaVersion,
      protocolVersion: this.pipelineCapability.protocolVersion,
      protocolNumber: this.pipelineCapability.protocolNumber,
      pipelineVersions: [...this.pipelineCapability.pipelineVersions],
      queueClass: this.queueClass,
      configurationHash: this.configurationHash,
      capacity: this.concurrency,
      activeJobs: this.active.size,
    });
    if (this.queueClass === "deep") return;
    // Reconciliation is best-effort maintenance. A transient queue/database
    // error here must not prevent the worker from starting or processing
    // unrelated jobs; the next heartbeat will retry it.
    try {
      await recoverUnverifiedAppleAuthorizationJob(this.repository);
    } catch {
      process.stderr.write("[needle-worker] Apple authorization reconciliation failed; private diagnostics were suppressed\n");
    }
    try {
      await recoverWaitingApplePublicationJobs(this.repository);
    } catch {
      process.stderr.write("[needle-worker] Apple publication recovery reconciliation failed; private diagnostics were suppressed\n");
    }
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
    // Sweep only fully closed UTC hours. The durable hourly keys prevent
    // duplicate work across replicas, while the persisted high-water mark
    // backfills up to one day after a worker outage.
    const operationalWindowEnd = new Date();
    operationalWindowEnd.setUTCMinutes(0, 0, 0);
    const priorWindowValue = await this.repository.getSetting("pipeline_v2_alert_last_window_end");
    const priorWindowEnd = priorWindowValue ? new Date(priorWindowValue) : null;
    const oldestCatchupEnd = new Date(
      operationalWindowEnd.getTime() - (PIPELINE_OBSERVABILITY_MAX_CATCHUP_HOURS - 1) * 60 * 60 * 1_000,
    );
    let nextWindowEnd = priorWindowEnd && Number.isFinite(priorWindowEnd.getTime())
      ? new Date(priorWindowEnd.getTime() + 60 * 60 * 1_000)
      : operationalWindowEnd;
    if (nextWindowEnd < oldestCatchupEnd) nextWindowEnd = oldestCatchupEnd;
    const observabilityJobs: Array<Promise<unknown>> = [];
    while (nextWindowEnd <= operationalWindowEnd) {
      const closedWindowEnd = new Date(nextWindowEnd);
      observabilityJobs.push(this.repository.enqueueJob({
        kind: "pipeline_observability",
        payload: { windowEndedAt: closedWindowEnd.toISOString() },
        dedupeKey: `pipeline-observability:${closedWindowEnd.toISOString().slice(0, 13)}`,
        maxAttempts: 3,
      }));
      nextWindowEnd = new Date(nextWindowEnd.getTime() + 60 * 60 * 1_000);
    }
    await Promise.all(observabilityJobs);
  }

  private async enforceControls(): Promise<void> {
    const researchPaused = await this.repository.getSetting("research_paused");
    const [publishingPaused, apple] = this.queueClass === "deep"
      ? [null, null]
      : await Promise.all([
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
    if (run.status === "cancelled"
      || run.phase === "owner_cancelled"
      || run.phase === "visitor_cancelled") return "Run was cancelled";
    return null;
  }

  private async execute(job: DurableJob, controller: AbortController): Promise<void> {
    const handler = this.handlers[job.kind];
    let leaseLost = false;
    let contractAttempt: {
      id: string;
      contractDatabaseId: string;
      contractRevisionId: string;
      contractSemanticHash: string;
      contract: PlaylistContractRevisionV1;
      leaseGeneration: number;
    } | null = null;
    const finishContractAttempt = async (
      status: "blocked" | "complete" | "cancelled" | "failed",
      blockerKind?: string | null,
    ): Promise<boolean> => {
      if (!contractAttempt || !job.runId || !this.repository.completePlaylistExecutionAttempt) {
        return true;
      }
      const result = await this.repository.completePlaylistExecutionAttempt({
        attemptId: contractAttempt.id,
        runId: job.runId,
        contractRevisionId: contractAttempt.contractDatabaseId,
        leaseGeneration: contractAttempt.leaseGeneration,
        status,
        blockerKind: blockerKind ?? null,
      });
      return result.accepted;
    };
    const discardContractAttempt = async (): Promise<void> => {
      if (!contractAttempt || !job.runId || !this.repository.discardPlaylistExecutionAttempt) return;
      await this.repository.discardPlaylistExecutionAttempt({
        attemptId: contractAttempt.id,
        runId: job.runId,
        contractRevisionId: contractAttempt.contractDatabaseId,
        leaseGeneration: contractAttempt.leaseGeneration,
      });
    };
    const renewal = setInterval(() => {
      void this.repository.renewJobLease(job.id, this.workerId, this.leaseMs, job.leaseEpoch).then((renewed) => {
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
        await this.repository.cancelLeasedJob(job.id, this.workerId, cancellationBeforeStart, job.leaseEpoch);
        return;
      }
      if (job.runId
        && this.repository.getActivePlaylistContractRevision
        && this.repository.beginPlaylistExecutionAttempt) {
        const activeContract = await this.repository.getActivePlaylistContractRevision({
          runId: job.runId,
        });
        const revisionId = activeContract?.contract?.revisionId;
        const semanticHash = activeContract?.contract?.semanticHash;
        if (activeContract
          && typeof revisionId === "string"
          && typeof semanticHash === "string"
          && /^[a-f0-9]{64}$/u.test(semanticHash)) {
          const playlistContract = activeContract.contract as unknown as PlaylistContractRevisionV1;
          assertPlaylistContractIntegrityV1(playlistContract);
          const leaseGeneration = Number.isSafeInteger(job.leaseEpoch) ? Number(job.leaseEpoch) : 0;
          const attempt = await this.repository.beginPlaylistExecutionAttempt({
            runId: job.runId,
            contractRevisionId: activeContract.id,
            stage: job.stageKey || job.kind,
            dependencyKey: job.kind,
            attemptNumber: Math.max(1, job.attempts),
            leaseGeneration,
            executorRevision: this.version,
            executorIdentityHash: sha256Hex(this.workerId),
            configurationHash: this.configurationHash,
            idempotencyKey: `${job.id}:${leaseGeneration}:${activeContract.id}`,
          });
          contractAttempt = {
            id: attempt.id,
            contractDatabaseId: activeContract.id,
            contractRevisionId: revisionId,
            contractSemanticHash: semanticHash,
            contract: playlistContract,
            leaseGeneration,
          };
          job.payload.__contractActiveComputeConsumedMs = Math.max(
            0,
            Number(attempt.activeComputeMs ?? 0),
          );
          if (this.repository.getPlaylistActiveComputeAllowanceMs) {
            job.payload.__contractActiveComputeAllowanceMs = await this.repository
              .getPlaylistActiveComputeAllowanceMs({
                runId: job.runId,
                contractRevisionId: activeContract.id,
              });
          }
        }
      }
      await handler({
        ...job.payload,
        ...(job.runId && !job.payload.runId ? { runId: job.runId } : {}),
        ...(job.briefRequestId && !job.payload.briefRequestId ? { briefRequestId: job.briefRequestId } : {}),
        ...(job.stageKey ? { __jobStageKey: job.stageKey } : {}),
        ...(Number.isSafeInteger(job.leaseEpoch) ? { __jobLeaseEpoch: job.leaseEpoch } : {}),
        ...(job.queryPlanRevisionId ? { __queryPlanRevisionId: job.queryPlanRevisionId } : {}),
        __jobId: job.id,
        __jobWorkerId: this.workerId,
        ...(contractAttempt ? {
          __contractAttemptId: contractAttempt.id,
          __contractRevisionDatabaseId: contractAttempt.contractDatabaseId,
          __contractRevisionId: contractAttempt.contractRevisionId,
          __contractSemanticHash: contractAttempt.contractSemanticHash,
          __executorRevision: this.version,
          __executorConfigurationHash: this.configurationHash,
        } : {}),
      }, controller.signal);
      if (leaseLost) {
        await discardContractAttempt();
        return;
      }
      const cancellationAfterHandler = await this.runCancellationReason(job);
      const controlAction = this.active.get(job.id)?.controlAction;
      if (cancellationAfterHandler || controlAction === "cancel") {
        await finishContractAttempt("cancelled");
        await this.repository.cancelLeasedJob(
          job.id,
          this.workerId,
          cancellationAfterHandler ?? "Run was cancelled",
          job.leaseEpoch,
        );
        return;
      }
      if (controlAction === "pause") {
        await finishContractAttempt("blocked", "owner_control");
        await this.repository.deferJob(
          job.id,
          this.workerId,
          new Date(Date.now() + 60_000),
          "Deferred by owner control",
          job.leaseEpoch,
        );
        return;
      }
      if (!await finishContractAttempt("complete")) return;
      if (contractAttempt && job.runId && this.repository.resolvePlaylistRunBlockers) {
        await Promise.all([
          this.repository.resolvePlaylistRunBlockers({
            runId: job.runId,
            contractRevisionId: contractAttempt.contractDatabaseId,
            blockerKind: "provider",
          }),
          this.repository.resolvePlaylistRunBlockers({
            runId: job.runId,
            contractRevisionId: contractAttempt.contractDatabaseId,
            blockerKind: "apple_authorization",
          }),
        ]);
      }
      await this.repository.completeJob(job.id, this.workerId, job.leaseEpoch);
    } catch (error) {
      if (leaseLost) {
        await discardContractAttempt();
        return;
      }
      if (process.env.NODE_ENV === "test" && process.env.GENIO_SYSTEM_E2E === "1") {
        const diagnostic = error instanceof Error ? error.stack ?? error.message : String(error);
        process.stderr.write(`[genio-system-e2e] ${job.kind} job failed: ${diagnostic}\n`);
      }
      const cancellationReason = await this.runCancellationReason(job);
      const controlAction = this.active.get(job.id)?.controlAction;
      if (cancellationReason || controlAction === "cancel") {
        await finishContractAttempt("cancelled");
        await this.repository.cancelLeasedJob(
          job.id,
          this.workerId,
          cancellationReason ?? "Run was cancelled",
          job.leaseEpoch,
        );
        return;
      }
      if (controlAction === "pause" || error instanceof PublicationPausedError) {
        const reason = error instanceof PublicationPausedError ? error.message : "Deferred by owner control";
        if (contractAttempt
          && job.runId
          && error instanceof PublicationPausedError
          && this.repository.openPlaylistRunBlocker) {
          await this.repository.openPlaylistRunBlocker({
            runId: job.runId,
            contractRevisionId: contractAttempt.contractDatabaseId,
            blockerKind: "apple_authorization",
            dependencyKey: "apple_music",
            retryCount: job.attempts,
            nextRetryAt: null,
            automaticRetryUntil: null,
            state: { stage: job.stageKey || job.kind, nextAction: "authorize_apple" },
          });
        }
        await finishContractAttempt(
          "blocked",
          error instanceof PublicationPausedError ? "apple_authorization" : "owner_control",
        );
        await this.repository.deferJob(
          job.id,
          this.workerId,
          new Date(Date.now() + 60_000),
          reason,
          job.leaseEpoch,
        );
        return;
      }
      if (error instanceof PipelineV3DependencyUnavailableError
        && contractAttempt
        && job.runId
        && this.repository.openPlaylistRunBlocker) {
        const previous = this.repository.getActivePlaylistRunBlocker
          ? await this.repository.getActivePlaylistRunBlocker({
              runId: job.runId,
              contractRevisionId: contractAttempt.contractDatabaseId,
              blockerKind: "provider",
              dependencyKey: error.dependencyKey,
            })
          : null;
        const now = new Date();
        const priorState = previous?.state ?? {};
        const firstFailureAt = validRetryDate(priorState.firstFailureAt)
          ?? previous?.createdAt
          ?? now;
        const circuitOpenedAt = validRetryDate(priorState.circuitOpenedAt)
          ?? firstFailureAt;
        const priorRetryCount = Number.isSafeInteger(previous?.retryCount)
          ? Math.max(0, Number(previous?.retryCount))
          : 0;
        // PipelineV3DependencyUnavailableError crosses this boundary only
        // after the provider adapter has exhausted its own three immediate
        // attempts (including Retry-After handling). Re-running the entire
        // durable job at 1s/2s/4s would multiply those provider calls beyond
        // the public retry contract, so this circuit begins at the 5-minute
        // durable lane.
        const immediateAttemptsCompleted = 3;
        const durableAttemptsCompleted = Math.min(
          DEPENDENCY_DURABLE_RETRY_DELAYS_MS_V1.length,
          Number.isSafeInteger(priorState.durableAttemptsCompleted)
            ? Math.max(0, Number(priorState.durableAttemptsCompleted))
            : priorState.retryLane === "durable" && Number.isSafeInteger(priorState.retryOrdinal)
              ? Math.max(0, Number(priorState.retryOrdinal))
              : Math.max(0, priorRetryCount - 3),
        );
        const fencingToken = `${job.id}:${contractAttempt.leaseGeneration}`;
        const decision = decideDependencyCircuitV1({
          fence: {
            attemptId: contractAttempt.id,
            activeAttemptId: contractAttempt.id,
            leaseGeneration: contractAttempt.leaseGeneration,
            activeLeaseGeneration: contractAttempt.leaseGeneration,
            fencingToken,
            activeFencingToken: fencingToken,
            contractRevisionId: contractAttempt.contractRevisionId,
            activeContractRevisionId: contractAttempt.contractRevisionId,
            contractSemanticHash: contractAttempt.contractSemanticHash,
            activeContractSemanticHash: contractAttempt.contractSemanticHash,
            cancelled: false,
          },
          failureClass: "transient",
          firstFailureAt,
          lastFailureAt: now,
          circuitOpenedAt,
          immediateAttemptsCompleted,
          durableAttemptsCompleted,
          retryAfterUntil: error.retryAfterUntil,
          jitterUnit: deterministicRetryJitter(job.id, priorRetryCount),
          now,
        });
        if (decision.state === "needs_decision") {
          const runDecision = createAdaptiveRunDecisionV1({
            contract: contractAttempt.contract,
            reason: "dependency_retry_window_expired",
            verifiedTrackCount: 0,
            remainingStrategyCount: 0,
            reachedAt: now,
          });
          if (this.repository.resolvePlaylistRunBlockers) {
            await this.repository.resolvePlaylistRunBlockers({
              runId: job.runId,
              contractRevisionId: contractAttempt.contractDatabaseId,
              blockerKind: "provider",
            });
          }
          await this.repository.openPlaylistRunBlocker({
            runId: job.runId,
            contractRevisionId: contractAttempt.contractDatabaseId,
            blockerKind: "scope_decision",
            dependencyKey: error.dependencyKey,
            retryCount: priorRetryCount,
            nextRetryAt: null,
            automaticRetryUntil: decision.automaticRetryUntil,
            state: {
              ...runDecision,
              stage: job.stageKey || job.kind,
              reasonCode: error.reasonCode,
              firstFailureAt: firstFailureAt.toISOString(),
              lastFailureAt: now.toISOString(),
              nextAction: decision.nextAction,
            },
          });
          if (!await finishContractAttempt("blocked", "scope_decision")) return;
          await this.repository.completeJob(job.id, this.workerId, job.leaseEpoch);
          return;
        }
        if (decision.state === "blocked_dependency") {
          // Once the five durable slots are exhausted, wake exactly once at
          // the anchored 24-hour horizon so the run can become needs_decision.
          const retryAt = decision.nextRetryAt ?? decision.automaticRetryUntil;
          const retryCount = decision.retryLane === "immediate"
            ? decision.retryOrdinal
            : 3 + decision.retryOrdinal;
          await this.repository.openPlaylistRunBlocker({
            runId: job.runId,
            contractRevisionId: contractAttempt.contractDatabaseId,
            blockerKind: "provider",
            dependencyKey: error.dependencyKey,
            retryCount,
            nextRetryAt: retryAt,
            automaticRetryUntil: decision.automaticRetryUntil,
            state: {
              stage: job.stageKey || job.kind,
              reasonCode: error.reasonCode,
              firstFailureAt: firstFailureAt.toISOString(),
              circuitOpenedAt: circuitOpenedAt.toISOString(),
              lastFailureAt: now.toISOString(),
              retryLane: decision.retryLane,
              retryOrdinal: decision.retryOrdinal,
              immediateAttemptsCompleted,
              durableAttemptsCompleted: decision.retryLane === "durable"
                ? decision.retryOrdinal
                : durableAttemptsCompleted,
              nextAction: "wait_for_dependency",
            },
          });
          if (!await finishContractAttempt("blocked", "dependency_retry")) return;
          await this.repository.failJob(
            job.id,
            this.workerId,
            "Research dependency unavailable; retry scheduled.",
            retryAt,
            job.leaseEpoch,
          );
          return;
        }
      }
      const message = job.kind === "apple_authorization"
        ? safeAppleAuthorizationFailure(error)
        : sanitizeFailure(error, failureContextForJob(job.kind));
      const providerRejectedAuthorization = job.kind === "apple_authorization"
        && error instanceof AppleApiError
        && !error.retriable;
      const retryAt = error instanceof NonRetriableJobError || providerRejectedAuthorization ? null : retryAtFor(job);
      if (contractAttempt && job.runId && this.repository.openPlaylistRunBlocker) {
        const blockerKind = error instanceof PublicationPausedError
          ? "apple_authorization" as const
          : retryAt
            ? "provider" as const
            : error instanceof NonRetriableJobError
              ? "integrity" as const
              : "scope_decision" as const;
        await this.repository.openPlaylistRunBlocker({
          runId: job.runId,
          contractRevisionId: contractAttempt.contractDatabaseId,
          blockerKind,
          dependencyKey: job.kind,
          retryCount: job.attempts,
          nextRetryAt: retryAt,
          automaticRetryUntil: retryAt
            ? new Date(Date.now() + 24 * 60 * 60_000)
            : new Date(),
          state: {
            stage: job.stageKey || job.kind,
            attempt: job.attempts,
            nextAction: retryAt ? "wait_for_dependency" : "review_contract",
          },
        });
      }
      await finishContractAttempt(retryAt ? "blocked" : "failed", retryAt ? "dependency_retry" : null);
      await this.repository.failJob(
        job.id,
        this.workerId,
        message,
        retryAt,
        job.leaseEpoch,
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
  const governedGraph = new PgPipelineV3GovernedGraphReadRepository(repository.pool);
  // Every V3 provider surface must share the same durable reservation and
  // reconciliation boundary. In particular, cold factual/exhaustive corpus
  // discovery is paid OpenAI work just like interactive retrieval.
  const meteredV3Response = createMeteredPipelineV3Response(repository);
  const v3RetrievalPort = createPipelineV3RetrievalExecutionPort({
    adapters: createPipelineV3LiveAdapters({
      discoverGovernedGraph: createPipelineV3GovernedGraphDiscovery(governedGraph),
      createResponse: meteredV3Response,
    }),
  });
  const v3CorpusBuilder = createHostedColdCorpusBuilderV3({ createResponse: meteredV3Response });
  const leaseMs = positiveEnv("WORKER_LEASE_SECONDS", DEFAULT_LEASE_MS / 1_000, 30 * 60) * 1_000;
  const renewMs = Math.min(
    positiveEnv("WORKER_RENEW_SECONDS", DEFAULT_RENEW_MS / 1_000, 10 * 60) * 1_000,
    Math.max(1_000, leaseMs - 1_000),
  );
  const queueClass = parseWorkerQueueClass(process.env.WORKER_QUEUE_CLASS);
  const runner = new WorkerRunner(repository, {
    concurrency: positiveEnv("WORKER_CONCURRENCY", 2, 2),
    leaseMs,
    renewMs,
    heartbeatMs: positiveEnv("WORKER_HEARTBEAT_SECONDS", DEFAULT_HEARTBEAT_MS / 1_000, 5 * 60) * 1_000,
    pollMs: positiveEnv("WORKER_POLL_MS", DEFAULT_POLL_MS, 60_000),
    v3RetrievalPort,
    v3CorpusBuilder,
    queueClass,
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
  runExecutableWorker().catch(() => {
    process.stderr.write("[needle-worker] fatal failure; private diagnostics were suppressed\n");
    process.exitCode = 1;
  });
}
