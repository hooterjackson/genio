import Fastify, { type FastifyRequest } from "fastify";
import { CapabilityService, type RunCapabilitySessionView } from "./capabilities.ts";
import { createGatewayVerifier, type GatewayIdentity } from "./gateway-auth.ts";
import {
  createAppleDeveloperToken,
  assertOwner,
  encryptAppleUserToken,
  isOwner,
  selectAppleAuthorizationStage,
} from "./owner.ts";
import { parseOwnerCatalogImport, unverifiedImportedCandidates } from "./catalog-import.ts";
import {
  canonicalExecutorReleaseIdentityV1,
  Repository,
} from "./repository.ts";
import {
  capabilityPepperRotationStatus,
  HttpError,
  sha256Hex,
  stableStringify,
} from "./security.ts";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  PUBLIC_FAST_RESEARCH_BUDGET_USD,
  PUBLIC_PLAYLIST_DEFAULT_TRACKS,
  PUBLIC_PLAYLIST_MINIMUM_TRACKS,
  publicRunBudgetUsd,
} from "../shared/product-policy.ts";
import {
  AUTHENTICATED_OWNER_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
  playlistTrackCountAdmission,
  PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
  type CustomGuidanceTrackCountAuthorityV1,
} from "./playlist-count-policy.ts";
import {
  canonicalBriefForRequest,
  estimateResearchCost,
  explicitTrackCount,
  isPlaylistBrief,
  materialAmbiguitiesAccepted,
} from "./brief-policy.ts";
import { publicBriefStatusView } from "./public-api-projections.ts";
import {
  pipelineV3ResearchJob,
  researchResumeJob,
  type ResearchResumeCheckpoint,
} from "./research-resume.ts";
import {
  briefInterpretationModel,
  parseFastRouteCheckpoint,
  researchExecutionPolicy,
  researchExecutionPolicyForRun,
} from "./research-policy.ts";
import {
  DATABASE_SCHEMA_SUPPORT,
  isDatabaseSchemaVersionCompatible,
} from "../db/index.ts";
import {
  appleAuthorizationGeneration,
  appleAuthorizationJobDedupeKey,
  searchAppleCatalogResources,
} from "./apple.ts";
import {
  type ResolvedExactArtistIdentityV1,
} from "./exact-artist-identity-v1.ts";
import {
  customArtistNeedsInputMessageV1,
  resolveCustomArtistIdentitiesV1,
  type CustomArtistIdentityResolutionV1,
} from "./custom-guidance-artist-resolution-v1.ts";
import {
  submitBriefGuidanceAnswersV1,
} from "./brief-guidance-submission-v1.ts";
import { initialApprovedBudgetUsd, readCostConfiguration } from "./cost-config.ts";
import { buildInformation } from "./build-info.ts";
import {
  apiReleaseConfigurationHash,
  runtimeReleaseContract,
} from "./runtime-release.ts";
import {
  BRIDGE_API_MINIMUM_WORKER_PROTOCOL_VERSION,
  WORKER_PIPELINE_PROTOCOL_VERSION,
} from "./worker-protocol.ts";
import {
  FEEDBACK_BODY_BYTES,
  parseFeedbackKind,
  parseFeedbackStatus,
  parseFeedbackSubmission,
} from "./feedback.ts";
import { positiveIntegerQuery } from "./api-validation.ts";
import {
  EVIDENCE_GRAPH_PIPELINE_V3,
  EVIDENCE_GRAPH_POLICY_V3,
  EvidenceGraphServiceV3,
} from "./evidence-graph-service-v3.ts";
import { PgEvidenceGraphRepositoryV3 } from "./evidence-graph-repository-v3.ts";
import {
  evidenceGraphHttpErrorV3,
  parseAppendObservationV3,
  parseBulkHideV3,
  parseDisputeV3,
  parseOwnerCorpusListQueryV3,
  parsePromotionV3,
  parseReasonV3,
  parseSnapshotV3,
  parseSourcePolicyApprovalV3,
} from "./evidence-graph-owner-api-v3.ts";
import { persistedWorkerPipeline } from "./pipeline-worker-routing.ts";
import { isSmoothReggaetonHeatRequestV3 } from "./adaptive-guidance-v3.ts";
import { readReleaseCanaryInventory } from "./release-canary-inventory.ts";
import {
  authenticateReleaseCanary,
  manifestOnlyReleaseCanaryAllowed,
} from "./release-canary-request.ts";
import {
  CANONICAL_ACTIVATION_DATABASE_CAPABILITY_SETTING,
  CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_SETTING,
  CANONICAL_EXECUTOR_RELEASE_IDENTITY_DATABASE_CAPABILITY_SETTING,
  CANONICAL_EXECUTOR_RELEASE_IDENTITY_DATABASE_CAPABILITY_VERSION,
  canonicalContractActivationConfigured,
  canonicalContractActivationReady,
  releaseDatabaseReadinessReady,
  releaseExecutionConfigured,
} from "./release-deployment-phase.ts";
import {
  parseReleaseManifestCanaryMarker,
  RELEASE_MANIFEST_CANARY_MAX_TRACKS,
  RELEASE_MANIFEST_CANARY_MARKER_PHASE,
} from "./release-manifest-canary.ts";
import {
  createPublicRolloutAssignmentV1,
  publicRolloutAssignmentStickyKeyV1,
  publicRolloutAssignmentPausedV1,
  publicRolloutCanonicalContractRequestedV1,
  publicRolloutRuntimeDatabaseAuthorityV1,
} from "./public-rollout-assignment.ts";

const MAX_BODY_BYTES = 64 * 1024;
const BULK_SELECTION_BODY_BYTES = 1024 * 1024;
const costConfiguration = readCostConfiguration();
const repository = new Repository();
const evidenceGraphRepositoryV3 = new PgEvidenceGraphRepositoryV3(repository.pool);
const evidenceGraphServiceV3 = new EvidenceGraphServiceV3(evidenceGraphRepositoryV3);
const capabilities = new CapabilityService(repository);
const verifyGateway = createGatewayVerifier(repository);
const gatewayIdentities = new WeakMap<FastifyRequest, GatewayIdentity>();

function apiRuntimeIdentityV1(
  environment: NodeJS.ProcessEnv = process.env,
): {
  schemaVersion: "genio-api-runtime-identity/v1";
  replicaIdentityHash: string;
  build: ReturnType<typeof buildInformation>;
  configurationHash: string;
  semanticExecutionConfigurationHash: string;
} {
  const build = buildInformation(environment);
  const runtime = runtimeReleaseContract(environment);
  const replicaIdentity = environment.RAILWAY_REPLICA_ID?.trim()
    || `process:${process.pid}`;
  return {
    schemaVersion: "genio-api-runtime-identity/v1",
    replicaIdentityHash: sha256Hex(stableStringify({
      schemaVersion: "genio-api-replica-identity/v1",
      buildIdentifier: build.identifier,
      replicaIdentity,
    })),
    build,
    configurationHash: apiReleaseConfigurationHash(environment),
    semanticExecutionConfigurationHash:
      runtime.semanticExecutionConfigurationHash,
  };
}

async function resolveCustomArtistIdentities(input: {
  customTexts: readonly string[];
  storefront: string;
}): Promise<CustomArtistIdentityResolutionV1> {
  return resolveCustomArtistIdentitiesV1({
    ...input,
    search: async (storefront, query, next) => {
      const page = await searchAppleCatalogResources(
        storefront,
        query,
        ["artists"],
        25,
        undefined,
        next,
      );
      return {
        artists: page.artists,
        next: page.next?.artists ?? null,
      };
    },
  });
}

const app = Fastify({
  bodyLimit: MAX_BODY_BYTES,
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.x-needle-signature",
        "req.headers.x-needle-owner-email",
        "body.capabilityToken",
        "body.token",
        "body.musicUserToken",
        "body.privateKey",
        "body.message",
        "body.image",
        "body.image.dataBase64",
        "body.releaseCanary.signature",
        "res.headers.set-cookie",
      ],
      censor: "[REDACTED]",
    },
  },
});

app.removeContentTypeParser("application/json");
app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: MAX_BODY_BYTES }, (request, body, done) => {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  (request as FastifyRequest & { rawBody?: Buffer }).rawBody = raw;
  if (raw.length === 0) return done(null, {});
  try {
    done(null, JSON.parse(raw.toString("utf8")));
  } catch {
    done(new HttpError(400, "Request body must be valid JSON", "invalid_json"), undefined);
  }
});

app.addHook("onRequest", async (request, reply) => {
  if (request.url.startsWith("/api/v1/")) {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
  }
});

app.addHook("preHandler", async (request) => {
  if (!request.url.startsWith("/api/v1/")) return;
  gatewayIdentities.set(request, await verifyGateway(request));
  if (
    !releaseExecutionConfigured(process.env)
    && ["DELETE", "PATCH", "POST", "PUT"].includes(request.method)
  ) {
    throw new HttpError(
      503,
      "Fresh staging bootstrap is read-only until schema readiness is verified",
      "release_bootstrap_execution_disabled",
    );
  }
});

function identity(request: FastifyRequest): GatewayIdentity {
  const value = gatewayIdentities.get(request);
  if (!value) throw new HttpError(401, "Sites gateway authentication is required", "gateway_required");
  return value;
}

function uuid(value: unknown, label = "ID"): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, `${label} is invalid`, "invalid_id");
  }
  return value;
}

function idempotencyKey(request: FastifyRequest, bodyKey?: unknown): string {
  const header = request.headers["idempotency-key"];
  if (Array.isArray(header)) throw new HttpError(400, "Duplicate Idempotency-Key header", "invalid_idempotency_key");
  const value = String(header ?? bodyKey ?? "").trim();
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(value)) throw new HttpError(400, "Idempotency-Key is required", "invalid_idempotency_key");
  if (bodyKey != null && String(bodyKey) !== value) throw new HttpError(400, "Idempotency keys do not match", "invalid_idempotency_key");
  return value;
}

function catalogChoices(value: unknown, label: string): Array<{ candidateId: string; catalogId: string }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10_000) throw new HttpError(400, `${label} is invalid`, "invalid_selection");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new HttpError(400, `${label} is invalid`, "invalid_selection");
    const row = item as { candidateId?: unknown; catalogId?: unknown };
    const candidateId = uuid(row.candidateId, "Candidate ID");
    const catalogId = typeof row.catalogId === "string" ? row.catalogId.trim() : "";
    if (!catalogId || catalogId.length > 120 || /[\u0000-\u001f\u007f]/u.test(catalogId)) {
      throw new HttpError(400, "Apple catalog ID is invalid", "invalid_selection");
    }
    return { candidateId, catalogId };
  });
}

function candidateIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10_000) throw new HttpError(400, "Excluded candidates are invalid", "invalid_selection");
  return value.map((item) => uuid(item, "Candidate ID"));
}

async function sessionForAccess(request: FastifyRequest, accessId: string): Promise<RunCapabilitySessionView> {
  return capabilities.authenticateForAccess(request, accessId);
}

async function customGuidanceTrackCountAuthorityForRequest(
  request: FastifyRequest,
): Promise<CustomGuidanceTrackCountAuthorityV1> {
  if (!isOwner(identity(request))) {
    return PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1;
  }
  const [
    observedDatabaseSchemaVersion,
    observedDatabaseCapabilityVersion,
    observedCanonicalExecutionHardeningVersion,
    observedCanonicalExecutorReleaseIdentityFencingVersion,
    executorReleaseIdentityFenceSupported,
  ] = await Promise.all([
    repository.getSchemaVersion(),
    repository.getSetting(CANONICAL_ACTIVATION_DATABASE_CAPABILITY_SETTING),
    repository.getSetting(
      CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_SETTING,
    ),
    repository.getSetting(
      CANONICAL_EXECUTOR_RELEASE_IDENTITY_DATABASE_CAPABILITY_SETTING,
    ),
    repository.executorReleaseIdentityFenceAvailable(),
  ]);
  return canonicalContractActivationReady({
    environment: process.env,
    observedDatabaseSchemaVersion,
    observedDatabaseCapabilityVersion,
    observedCanonicalExecutionHardeningVersion,
    observedCanonicalExecutorReleaseIdentityFencingVersion,
    executorReleaseIdentityFenceSupported,
  })
    ? AUTHENTICATED_OWNER_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1
    : PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1;
}

async function requireWorkerForNewWork(): Promise<void> {
  const required = process.env.REQUIRE_WORKER_HEARTBEAT === "true" || process.env.NODE_ENV === "production";
  if (!required) return;
  const health = await repository.getSystemHealth();
  const candidateIdentity = canonicalExecutorReleaseIdentityV1();
  const lane = health.workerLanes?.interactive;
  if (!workerLaneReady(health, "interactive")
    || lane?.candidateExecutorIdentityReady !== true
    || lane.executorRevision !== candidateIdentity.executorRevision
      && !lane.eligibleRevisions?.includes(
        candidateIdentity.executorRevision,
      )
    || !lane.eligibleSemanticExecutionConfigurationHashes?.includes(
      candidateIdentity.semanticExecutionConfigurationHash,
    )) {
    throw new HttpError(503, "Research worker is temporarily unavailable", "worker_unavailable");
  }
}

interface WorkerLaneHealthView {
  worker_id?: string;
  stale?: boolean;
  schemaCompatible?: boolean;
  protocolCompatible?: boolean;
  protocolVersion?: string | number | null;
  compatibleCapacity?: number;
  executorRevision?: string | null;
  configurationHash?: string | null;
  eligibleWorkerCount?: number;
  eligibleRevisions?: string[];
  eligibleConfigurationHashes?: string[];
  eligibleSemanticExecutionConfigurationHashes?: string[];
  candidateExecutorIdentityReady?: boolean;
  lastSeenAt?: string | null;
}

interface WorkerLaneSystemHealthView {
  workerLanes?: Partial<Record<"interactive" | "deep", WorkerLaneHealthView>>;
}

function workerLaneReady(health: WorkerLaneSystemHealthView, lane: "interactive" | "deep"): boolean {
  const worker = health.workerLanes?.[lane];
  return Boolean(worker
    && !worker.stale
    && worker.schemaCompatible
    && worker.protocolCompatible
    && worker.candidateExecutorIdentityReady === true
    && Number(worker.compatibleCapacity ?? 0) > 0);
}

function workerLaneStatus(health: WorkerLaneSystemHealthView, lane: "interactive" | "deep"): string {
  const worker = health.workerLanes?.[lane];
  if (!worker?.worker_id) return "missing";
  if (worker.stale) return "stale";
  if (!worker.schemaCompatible) return "schema_mismatch";
  if (!worker.protocolCompatible) return "protocol_mismatch";
  if (worker.candidateExecutorIdentityReady !== true) {
    return "executor_identity_mismatch";
  }
  return Number(worker.compatibleCapacity ?? 0) > 0 ? "healthy" : "missing";
}

async function assertNotPaused(kind: "research" | "publishing" | "feedback"): Promise<void> {
  if (await repository.getSetting(`${kind}_paused`) === "true") {
    const label = kind === "research" ? "Research" : kind === "publishing" ? "Publishing" : "Feedback";
    throw new HttpError(503, `${label} is temporarily paused`, `${kind}_paused`);
  }
}

async function enqueueResearchResume(runId: string): Promise<void> {
  const [run, saved, manifestCanaryMarker] = await Promise.all([
    repository.getRun(runId),
    repository.getResearchCheckpoint(runId, "resume") as Promise<ResearchResumeCheckpoint | null>,
    repository.getResearchCheckpoint(runId, RELEASE_MANIFEST_CANARY_MARKER_PHASE),
  ]);
  const pipeline = persistedWorkerPipeline(run);
  if (pipeline.route === "corpus_first_v3") {
    const marker = manifestCanaryMarker === null
      ? null
      : parseReleaseManifestCanaryMarker(manifestCanaryMarker);
    if (manifestCanaryMarker !== null && !marker) {
      throw new HttpError(
        409,
        "Manifest-only release canary authority is malformed",
        "release_manifest_canary_integrity",
      );
    }
    await repository.enqueueJob(pipelineV3ResearchJob(
      runId,
      pipeline.queryPlan!,
      marker ? "shadow" : "active",
    ));
    return;
  }
  if (manifestCanaryMarker !== null) {
    throw new HttpError(
      409,
      "Manifest-only release canaries require Pipeline V3",
      "release_manifest_canary_contract_invalid",
    );
  }
  const policy = researchExecutionPolicyForRun(run);
  let fast = false;
  let fastRoute = null;
  if (policy.kind === "fast_curated") {
    const [route, started] = await Promise.all([
      repository.getResearchCheckpoint(runId, `fast:route:${policy.version}`),
      repository.getResearchCheckpoint(runId, `fast:policy:${policy.version}`),
    ]);
    fast = Boolean(route || started);
    fastRoute = parseFastRouteCheckpoint(route, policy.version);
  }
  await repository.enqueueJob(researchResumeJob(runId, saved, { fast, fastRoute }));
}

app.get("/health/live", async () => {
  const api = apiRuntimeIdentityV1();
  const build = api.build;
  const runtime = runtimeReleaseContract();
  let graphSnapshot: {
    id: string;
    assertionCount: number;
    catalogIdentityCount: number;
    lockedAt: string | null;
  } | null = null;
  try {
    const snapshots = await evidenceGraphRepositoryV3.listSnapshots({
      limit: 1,
      offset: 0,
      status: "locked",
    });
    const latest = snapshots.items[0];
    if (latest) {
      graphSnapshot = {
        id: latest.id,
        assertionCount: latest.assertionCount,
        catalogIdentityCount: latest.catalogIdentityCount,
        lockedAt: latest.lockedAt?.toISOString() ?? null,
      };
    }
  } catch {
    // Liveness must not depend on the graph being bootstrapped. The explicit
    // null still tells operators and visitors that no runtime snapshot could
    // be verified.
  }
  return {
    ok: true,
    service: "needle-api",
    version: build.version,
    revision: build.revision,
    build,
    configurationHash: api.configurationHash,
    api,
    runtime: { ...runtime, graphSnapshot },
  };
});

app.get("/health/ready", async (_request, reply) => {
  const ok = await repository.ping();
  const capabilityPepper = capabilityPepperRotationStatus();
  const schemaVersion = ok ? await repository.getSchemaVersion() : null;
  const releaseManifestCanaryGuardsVersion = ok
    ? await repository.getSetting(CANONICAL_ACTIVATION_DATABASE_CAPABILITY_SETTING)
    : null;
  const canonicalExecutionHardeningVersion = ok
    ? await repository.getSetting(
      CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_SETTING,
    )
    : null;
  const canonicalExecutorReleaseIdentityFencingVersion = ok
    ? await repository.getSetting(
      CANONICAL_EXECUTOR_RELEASE_IDENTITY_DATABASE_CAPABILITY_SETTING,
    )
    : null;
  const executorReleaseIdentityFenceSupported = ok
    ? await repository.executorReleaseIdentityFenceAvailable()
    : false;
  const deploymentDatabaseReady = releaseDatabaseReadinessReady({
    environment: process.env,
    observedDatabaseSchemaVersion: schemaVersion,
    observedDatabaseCapabilityVersion: releaseManifestCanaryGuardsVersion,
    observedCanonicalExecutionHardeningVersion:
      canonicalExecutionHardeningVersion,
    observedCanonicalExecutorReleaseIdentityFencingVersion:
      canonicalExecutorReleaseIdentityFencingVersion,
    executorReleaseIdentityFenceSupported,
  });
  const schemaCompatible = ok
    && isDatabaseSchemaVersionCompatible(schemaVersion)
    && deploymentDatabaseReady
    && canonicalExecutorReleaseIdentityFencingVersion
      === CANONICAL_EXECUTOR_RELEASE_IDENTITY_DATABASE_CAPABILITY_VERSION
    && executorReleaseIdentityFenceSupported;
  if (!schemaCompatible || !capabilityPepper.ready) return reply.code(503).send({
    ok: false,
    database: ok,
    schemaVersion,
    releaseManifestCanaryGuardsVersion,
    canonicalExecutionHardeningVersion,
    canonicalExecutorReleaseIdentityFencingVersion,
    schemaSupport: DATABASE_SCHEMA_SUPPORT,
    capabilityPepper,
  });
  return {
    ok: true,
    database: true,
    schemaVersion,
    releaseManifestCanaryGuardsVersion,
    canonicalExecutionHardeningVersion,
    canonicalExecutorReleaseIdentityFencingVersion,
    schemaSupport: DATABASE_SCHEMA_SUPPORT,
    capabilityPepper,
  };
});

app.get("/health/system", async (_request, reply) => {
  try {
    const api = apiRuntimeIdentityV1();
    const capabilityPepper = capabilityPepperRotationStatus();
    const [health, publicRolloutDatabaseAuthority] = await Promise.all([
      repository.getSystemHealth(),
      repository.getPublicRolloutDatabaseAuthority(),
    ]);
    const publicRollout = publicRolloutRuntimeDatabaseAuthorityV1({
      databaseAuthority: publicRolloutDatabaseAuthority,
    });
    const schemaVersion = health.database.schemaVersion;
    const releaseManifestCanaryGuardsVersion =
      health.database.releaseManifestCanaryGuardsVersion ?? null;
    const canonicalExecutionHardeningVersion =
      health.database.canonicalExecutionHardeningVersion ?? null;
    const canonicalExecutorReleaseIdentityFencingVersion =
      health.database.canonicalExecutorReleaseIdentityFencingVersion ?? null;
    const deploymentDatabaseReady = releaseDatabaseReadinessReady({
      environment: process.env,
      observedDatabaseSchemaVersion: schemaVersion,
      observedDatabaseCapabilityVersion: releaseManifestCanaryGuardsVersion,
      observedCanonicalExecutionHardeningVersion:
        canonicalExecutionHardeningVersion,
      observedCanonicalExecutorReleaseIdentityFencingVersion:
        canonicalExecutorReleaseIdentityFencingVersion,
      executorReleaseIdentityFenceSupported:
        health.database.executorReleaseIdentityFenceSupported === true,
    });
    const schemaCompatible = isDatabaseSchemaVersionCompatible(schemaVersion)
      && deploymentDatabaseReady
      && canonicalExecutorReleaseIdentityFencingVersion
        === CANONICAL_EXECUTOR_RELEASE_IDENTITY_DATABASE_CAPABILITY_VERSION
      && health.executorFencing.ready === true;
    // Public/API readiness depends on the interactive lane. The deep lane is
    // a separate activation prerequisite so a missing deep worker cannot take
    // otherwise healthy interactive traffic offline during staged rollout.
    const ok = schemaCompatible
      && capabilityPepper.ready
      && workerLaneReady(health, "interactive");
    const activationReady = ok && workerLaneReady(health, "deep");
    return reply.code(ok ? 200 : 503).send({
      ok,
      activationReady,
      database: schemaCompatible ? "ready" : "schema_mismatch",
      schemaVersion,
      releaseManifestCanaryGuardsVersion,
      canonicalExecutionHardeningVersion,
      canonicalExecutorReleaseIdentityFencingVersion,
      executorFencing: health.executorFencing,
      api,
      publicRollout: publicRollout
        ? {
            active: true,
            databaseAuthorized: true,
            evidenceHash: publicRollout.evidenceHash,
            stage: publicRollout.stage,
            targetConfigurationHash:
              publicRollout.targetConfigurationHash,
          }
        : {
            active: false,
            databaseAuthorized: true,
            evidenceHash: null,
            stage: null,
            targetConfigurationHash: null,
          },
      capabilityPepper,
      worker: health.worker.worker_id
        ? health.worker.stale
          ? "stale"
          : !health.worker.schemaCompatible
            ? "schema_mismatch"
            : health.worker.protocolCompatible
              ? "healthy"
              : "protocol_mismatch"
        : "missing",
      workerProtocol: {
        expected: WORKER_PIPELINE_PROTOCOL_VERSION,
        minimumAccepted: BRIDGE_API_MINIMUM_WORKER_PROTOCOL_VERSION,
        actual: health.worker.protocolVersion ?? null,
      },
      workerLanes: {
        interactive: {
          status: workerLaneStatus(health, "interactive"),
          protocolVersion: health.workerLanes.interactive.protocolVersion ?? null,
          compatibleCapacity: health.workerLanes.interactive.compatibleCapacity,
          eligibleWorkerCount: health.workerLanes.interactive.eligibleWorkerCount ?? 0,
          eligibleIdentityCount: health.workerLanes.interactive.eligibleIdentityCount ?? 0,
          eligibleRevisions: health.workerLanes.interactive.eligibleRevisions ?? [],
          eligibleConfigurationHashes: health.workerLanes.interactive.eligibleConfigurationHashes ?? [],
          eligibleSemanticExecutionConfigurationHashes:
            health.workerLanes.interactive
              .eligibleSemanticExecutionConfigurationHashes ?? [],
          candidateExecutorIdentityReady:
            health.workerLanes.interactive
              .candidateExecutorIdentityReady === true,
          lastSeenAt: health.workerLanes.interactive.lastSeenAt ?? null,
        },
        deep: {
          status: workerLaneStatus(health, "deep"),
          protocolVersion: health.workerLanes.deep.protocolVersion ?? null,
          compatibleCapacity: health.workerLanes.deep.compatibleCapacity,
          eligibleWorkerCount: health.workerLanes.deep.eligibleWorkerCount ?? 0,
          eligibleIdentityCount: health.workerLanes.deep.eligibleIdentityCount ?? 0,
          eligibleRevisions: health.workerLanes.deep.eligibleRevisions ?? [],
          eligibleConfigurationHashes: health.workerLanes.deep.eligibleConfigurationHashes ?? [],
          eligibleSemanticExecutionConfigurationHashes:
            health.workerLanes.deep
              .eligibleSemanticExecutionConfigurationHashes ?? [],
          candidateExecutorIdentityReady:
            health.workerLanes.deep.candidateExecutorIdentityReady === true,
          lastSeenAt: health.workerLanes.deep.lastSeenAt ?? null,
        },
      },
      paused: health.paused.research || health.paused.publishing,
      queue: health.queue,
      notifications: {
        pending: health.notificationBacklog,
        failed: health.notificationFailures,
        oldestPendingSeconds: health.oldestNotificationSeconds,
      },
      publicationFailures: health.publicationFailures,
      retention: health.retention,
    });
  } catch {
    return reply.code(503).send({ ok: false, database: "down", worker: "unknown", paused: false });
  }
});

app.get("/api/health", async () => ({ ok: await repository.ping(), service: "needle-hosted-api" }));

app.get("/api/v1/system/health", async () => {
  const capabilityPepper = capabilityPepperRotationStatus();
  const [health, publicRolloutDatabaseAuthority] = await Promise.all([
    repository.getSystemHealth(),
    repository.getPublicRolloutDatabaseAuthority(),
  ]);
  const publicRollout = publicRolloutRuntimeDatabaseAuthorityV1({
    databaseAuthority: publicRolloutDatabaseAuthority,
  });
  const deploymentDatabaseReady = releaseDatabaseReadinessReady({
    environment: process.env,
    observedDatabaseSchemaVersion: health.database.schemaVersion,
    observedDatabaseCapabilityVersion:
      health.database.releaseManifestCanaryGuardsVersion ?? null,
    observedCanonicalExecutionHardeningVersion:
      health.database.canonicalExecutionHardeningVersion ?? null,
    observedCanonicalExecutorReleaseIdentityFencingVersion:
      health.database.canonicalExecutorReleaseIdentityFencingVersion ?? null,
    executorReleaseIdentityFenceSupported:
      health.database.executorReleaseIdentityFenceSupported === true,
  });
  const canonicalExecutorReleaseIdentityFencingVersion =
    health.database.canonicalExecutorReleaseIdentityFencingVersion ?? null;
  const ok = deploymentDatabaseReady
    && canonicalExecutorReleaseIdentityFencingVersion
      === CANONICAL_EXECUTOR_RELEASE_IDENTITY_DATABASE_CAPABILITY_VERSION
    && health.executorFencing.ready === true
    && capabilityPepper.ready
    && workerLaneReady(health, "interactive");
  return {
    ok,
    activationReady: ok && workerLaneReady(health, "deep"),
    schemaVersion: health.database.schemaVersion,
    releaseManifestCanaryGuardsVersion:
      health.database.releaseManifestCanaryGuardsVersion ?? null,
    canonicalExecutionHardeningVersion:
      health.database.canonicalExecutionHardeningVersion ?? null,
    canonicalExecutorReleaseIdentityFencingVersion,
    executorFencing: health.executorFencing,
    publicRollout: publicRollout
      ? {
          active: true,
          databaseAuthorized: true,
          evidenceHash: publicRollout.evidenceHash,
          stage: publicRollout.stage,
          targetConfigurationHash:
            publicRollout.targetConfigurationHash,
        }
      : {
          active: false,
          databaseAuthorized: true,
          evidenceHash: null,
          stage: null,
          targetConfigurationHash: null,
        },
    capabilityPepper,
    worker: {
      stale: health.worker.stale,
      schemaCompatible: health.worker.schemaCompatible,
      protocolCompatible: health.worker.protocolCompatible,
      protocolVersion: health.worker.protocolVersion ?? null,
      expectedProtocolVersion: WORKER_PIPELINE_PROTOCOL_VERSION,
      minimumProtocolVersion: BRIDGE_API_MINIMUM_WORKER_PROTOCOL_VERSION,
    },
    workerLanes: {
      interactive: {
        status: workerLaneStatus(health, "interactive"),
        protocolVersion: health.workerLanes.interactive.protocolVersion ?? null,
        compatibleCapacity: health.workerLanes.interactive.compatibleCapacity,
        eligibleWorkerCount: health.workerLanes.interactive.eligibleWorkerCount ?? 0,
        eligibleIdentityCount: health.workerLanes.interactive.eligibleIdentityCount ?? 0,
        eligibleRevisions: health.workerLanes.interactive.eligibleRevisions ?? [],
        eligibleConfigurationHashes: health.workerLanes.interactive.eligibleConfigurationHashes ?? [],
        eligibleSemanticExecutionConfigurationHashes:
          health.workerLanes.interactive
            .eligibleSemanticExecutionConfigurationHashes ?? [],
        candidateExecutorIdentityReady:
          health.workerLanes.interactive
            .candidateExecutorIdentityReady === true,
        lastSeenAt: health.workerLanes.interactive.lastSeenAt ?? null,
      },
      deep: {
        status: workerLaneStatus(health, "deep"),
        protocolVersion: health.workerLanes.deep.protocolVersion ?? null,
        compatibleCapacity: health.workerLanes.deep.compatibleCapacity,
        eligibleWorkerCount: health.workerLanes.deep.eligibleWorkerCount ?? 0,
        eligibleIdentityCount: health.workerLanes.deep.eligibleIdentityCount ?? 0,
        eligibleRevisions: health.workerLanes.deep.eligibleRevisions ?? [],
        eligibleConfigurationHashes: health.workerLanes.deep.eligibleConfigurationHashes ?? [],
        eligibleSemanticExecutionConfigurationHashes:
          health.workerLanes.deep
            .eligibleSemanticExecutionConfigurationHashes ?? [],
        candidateExecutorIdentityReady:
          health.workerLanes.deep.candidateExecutorIdentityReady === true,
        lastSeenAt: health.workerLanes.deep.lastSeenAt ?? null,
      },
    },
    paused: health.paused,
    queue: health.queue,
    notifications: { pending: health.notificationBacklog, failed: health.notificationFailures },
    publicationFailures: health.publicationFailures,
    retention: health.retention,
  };
});

app.get<{ Querystring: { page?: string; pageSize?: string } }>("/api/v1/playlists", async (request) => {
  const page = positiveIntegerQuery(request.query.page, 1, "Page", 1_000_000);
  const pageSize = positiveIntegerQuery(request.query.pageSize, 24, "Page size", 100);
  return repository.listPublicPlaylists(page, pageSize);
});

app.post<{ Body: unknown }>("/api/v1/feedback", { bodyLimit: FEEDBACK_BODY_BYTES }, async (request, reply) => {
  await assertNotPaused("feedback");
  const caller = identity(request);
  const key = idempotencyKey(request);
  const submission = parseFeedbackSubmission(request.body);
  const result = await repository.createFeedbackSubmission({
    submission,
    idempotencyKey: key,
    clientBucket: caller.clientBucket,
    clientBucketAliases: caller.clientBucketAliases,
    ownerRateLimitExempt: isOwner(caller),
  });
  return reply.code(result.created ? 201 : 200).send({ received: true, id: result.id });
});

app.post<{
  Body: {
    prompt?: string;
    targetTrackCount?: number;
    idempotencyKey?: string;
    releaseCanary?: unknown;
  };
}>("/api/v1/brief", async (request, reply) => {
  const releaseCanary = authenticateReleaseCanary(
    request.body?.releaseCanary,
    "brief",
  );
  await assertNotPaused("research");
  await requireWorkerForNewWork();
  const caller = identity(request);
  const prompt = request.body?.prompt?.trim() ?? "";
  // Anonymous work is always an exact bounded One Command request. An owner
  // may intentionally omit the control to enter the explicit deep path.
  const targetTrackCount = request.body?.targetTrackCount
    ?? (isOwner(caller)
      ? explicitTrackCount(prompt) ?? undefined
      : PUBLIC_PLAYLIST_DEFAULT_TRACKS);
  const preliminaryTrackCountAdmission = playlistTrackCountAdmission({
    requestedTrackCount: targetTrackCount,
    owner: isOwner(caller),
    canonicalActivationReady: false,
  });
  if (preliminaryTrackCountAdmission.status === "invalid") {
    throw new HttpError(
      400,
      `Track count must be an integer from ${PUBLIC_PLAYLIST_MINIMUM_TRACKS} to ${preliminaryTrackCountAdmission.maximumTrackCount}`,
      "invalid_track_count",
    );
  }
  const expandedTrackCountRequested = preliminaryTrackCountAdmission.expanded;
  const key = request.body?.idempotencyKey ? idempotencyKey(request, request.body.idempotencyKey) : undefined;
  const publicRolloutStickyKey = publicRolloutAssignmentStickyKeyV1({
    owner: isOwner(caller),
    clientBucket: caller.clientBucket,
    releaseCanary,
  });
  const publicRolloutDatabaseAuthority = publicRolloutStickyKey !== null
    && Number.isSafeInteger(targetTrackCount)
    ? await repository.getPublicRolloutDatabaseAuthority()
    : null;
  const publicRolloutAssignment = publicRolloutStickyKey !== null
    && Number.isSafeInteger(targetTrackCount)
    ? createPublicRolloutAssignmentV1({
        prompt,
        requestedTrackCount: Number(targetTrackCount),
        stickyKey: publicRolloutStickyKey,
        databaseAuthority: publicRolloutDatabaseAuthority,
      })
    : null;
  if (publicRolloutAssignment?.assigned === true
    && await repository.isPipelineCohortDisabled({
      route: "corpus_first_v3",
      intentGroup: publicRolloutAssignment.intentGroup,
    })) {
    reply.header("Retry-After", "300");
    throw new HttpError(
      503,
      "This playlist route is temporarily unavailable; retry shortly",
      "pipeline_route_hard_disabled",
    );
  }
  if (publicRolloutAssignmentPausedV1({
    assignment: publicRolloutAssignment,
    owner: isOwner(caller),
    signedCanary: releaseCanary !== null,
    publicAssignmentPaused:
      await repository.getSetting("pipeline_v3_public_assignment_paused")
        === "true",
  })) {
    reply.header("Retry-After", "300");
    throw new HttpError(
      503,
      "This playlist route is temporarily paused; retry shortly",
      "public_assignment_paused",
    );
  }
  const canonicalContractCohortRequested = expandedTrackCountRequested
    || publicRolloutCanonicalContractRequestedV1({
      assignment: publicRolloutAssignment,
      fallbackRequested:
        process.env.GUIDANCE_CONTRACT_V3_ENABLED === "true"
        || (process.env.GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED === "true"
          && isSmoothReggaetonHeatRequestV3(prompt))
        || (process.env.GUIDANCE_CONTRACT_V3_OWNER_CANARY === "true"
          && isOwner(caller)),
    });
  const canonicalActivationConfigured = canonicalContractActivationConfigured(process.env);
  const [
    observedDatabaseSchemaVersion,
    observedDatabaseCapabilityVersion,
    observedCanonicalExecutionHardeningVersion,
    observedCanonicalExecutorReleaseIdentityFencingVersion,
    executorReleaseIdentityFenceSupported,
  ] =
    canonicalActivationConfigured || expandedTrackCountRequested
      ? await Promise.all([
        repository.getSchemaVersion(),
        repository.getSetting(CANONICAL_ACTIVATION_DATABASE_CAPABILITY_SETTING),
        repository.getSetting(
          CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_SETTING,
        ),
        repository.getSetting(
          CANONICAL_EXECUTOR_RELEASE_IDENTITY_DATABASE_CAPABILITY_SETTING,
        ),
        repository.executorReleaseIdentityFenceAvailable(),
      ])
      : [null, null, null, null, false];
  const canonicalActivationReady = canonicalContractActivationReady({
    environment: process.env,
    observedDatabaseSchemaVersion,
    observedDatabaseCapabilityVersion,
    observedCanonicalExecutionHardeningVersion,
    observedCanonicalExecutorReleaseIdentityFencingVersion,
    executorReleaseIdentityFenceSupported,
  });
  if (
    canonicalContractCohortRequested
    && canonicalActivationConfigured
    && !canonicalActivationReady
  ) {
    throw new HttpError(
      503,
      "Canonical playlist contracts are paused until the schema-19 activation check passes",
      "canonical_contract_activation_not_ready",
    );
  }
  const trackCountAdmission = playlistTrackCountAdmission({
    requestedTrackCount: targetTrackCount,
    owner: isOwner(caller),
    canonicalActivationReady,
  });
  if (trackCountAdmission.status === "activation_required") {
    throw new HttpError(
      503,
      "Owner playlist sizes above 300 are paused until the schema-19 activation check passes",
      "expanded_track_count_activation_not_ready",
    );
  }
  const briefContractVersion = trackCountAdmission.requiredBriefContractVersion
    ?? (canonicalContractCohortRequested && canonicalActivationReady
    ? 3
    : process.env.GUIDANCE_CONTRACT_V2_ENABLED === "true"
        || (process.env.GUIDANCE_CONTRACT_V2_OWNER_CANARY === "true" && isOwner(caller))
      ? 2
      : 1);
  const created = await repository.createBriefRequest({
    prompt,
    requestedTrackCount: targetTrackCount ?? null,
    model: briefInterpretationModel(),
    clientBucket: caller.clientBucket,
    clientBucketAliases: caller.clientBucketAliases,
    idempotencyKey: key,
    briefContractVersion,
    publicRolloutAssignment,
    releaseCanary,
    allowExecutableTrackCount: expandedTrackCountRequested,
  });
  await capabilities.authorizeBrief(request, reply, created.id);
  if (created.status === "queued") {
    await repository.enqueueJob({
      kind: "brief",
      briefRequestId: created.id,
      payload: { briefRequestId: created.id },
      dedupeKey: `brief:${created.id}`,
      maxAttempts: 6,
    });
  }
  if (publicRolloutAssignment?.assigned === true) {
    reply
      .header(
        "x-genio-public-rollout-evidence-hash",
        publicRolloutAssignment.rolloutEvidenceHash,
      )
      .header(
        "x-genio-public-rollout-stage",
        publicRolloutAssignment.rolloutStage,
      )
      .header(
        "x-genio-public-rollout-assignment-hash",
        publicRolloutAssignment.assignmentHash,
      );
  }
  return reply.code(created.created ? 202 : 200).send({ requestId: created.id, status: created.status, pollAfterMs: 1_500 });
});

app.get<{ Params: { id: string } }>("/api/v1/brief/:id", async (request, reply) => {
  const briefRequestId = uuid(request.params.id, "Brief request ID");
  await capabilities.authenticateForBrief(request, briefRequestId);
  const brief = await repository.getBriefRequest(briefRequestId);
  if (!brief) return reply.code(404).send({ error: "Brief request not found", code: "brief_not_found" });
  const executionRequestedTrackCount = brief.executionRequestedTrackCount
    ?? brief.requestedTrackCount;
  const executionContext = {
    ...brief,
    requestedTrackCount: executionRequestedTrackCount,
  };
  const canonicalBrief = brief.status === "complete" && isPlaylistBrief(brief.brief)
    ? canonicalBriefForRequest(executionContext, brief.brief)
    : ["awaiting_answers", "finalizing"].includes(brief.status) && isPlaylistBrief(brief.brief)
      ? canonicalBriefForRequest(executionContext, brief.brief)
    : undefined;
  return publicBriefStatusView({
    requestId: brief.id,
    prompt: brief.prompt,
    requestedTrackCount: executionRequestedTrackCount,
    originalRequestedTrackCount: brief.requestedTrackCount,
    status: brief.status,
    briefContractVersion: brief.briefContractVersion,
    questionSetHash: brief.questionSetHash,
    checkpointMode: brief.checkpointMode,
    confirmationKind: brief.confirmationKind,
    interpretationSummary: brief.interpretationSummary,
    brief: canonicalBrief,
    questions: Array.isArray(brief.questions) ? brief.questions : [],
    answers: Array.isArray(brief.answers) && brief.answers.length > 0 ? brief.answers : undefined,
    error: brief.status === "failed" ? brief.error : undefined,
  });
});

app.post<{
  Params: { id: string };
  Body: {
    answers?: Array<{
      questionId?: string;
      optionId?: string;
      optionIds?: string[];
      customText?: string;
      skipped?: boolean;
      confirmed?: boolean;
    }>;
    questionSetHash?: string;
    idempotencyKey?: string;
  };
}>("/api/v1/brief/:id/answers", async (request, reply) => {
  const briefRequestId = uuid(request.params.id, "Brief request ID");
  await capabilities.authenticateForBrief(request, briefRequestId);
  if (!Array.isArray(request.body?.answers)) {
    throw new HttpError(400, "Playlist answers are required", "invalid_guidance_answers");
  }
  const key = idempotencyKey(request, request.body?.idempotencyKey);
  const submittedAnswers = request.body.answers.map((answer) => ({
    questionId: typeof answer.questionId === "string" ? answer.questionId : "",
    ...(typeof answer.optionId === "string" ? { optionId: answer.optionId } : {}),
    ...(Array.isArray(answer.optionIds)
      ? { optionIds: answer.optionIds.filter((value): value is string => typeof value === "string") }
      : {}),
    ...(typeof answer.customText === "string" ? { customText: answer.customText } : {}),
    ...(answer.skipped === true ? { skipped: true } : {}),
    ...(answer.confirmed === true ? { confirmed: true } : {}),
  }));
  const customTexts = submittedAnswers.flatMap((answer) => (
    typeof answer.customText === "string" ? [answer.customText] : []
  ));
  const questionSetHash = typeof request.body.questionSetHash === "string"
    ? request.body.questionSetHash.trim()
    : undefined;
  const outcome = await submitBriefGuidanceAnswersV1({
    customTexts,
    preflight: (customTrackCountAuthority) => (
      repository.preflightBriefAnswers({
        briefRequestId,
        idempotencyKey: key,
        questionSetHash,
        answers: submittedAnswers,
        ...(customTrackCountAuthority
          ? { customTrackCountAuthority }
          : {}),
      })
    ),
    authorizeNewWork: async () => {
      await assertNotPaused("research");
      await requireWorkerForNewWork();
      return customGuidanceTrackCountAuthorityForRequest(request);
    },
    resolveCustomArtistIdentities,
    submit: ({
      authority,
      resolvedExactArtistIdentities,
    }) => repository.submitBriefAnswers({
      briefRequestId,
      idempotencyKey: key,
      questionSetHash,
      answers: submittedAnswers,
      customTrackCountAuthority: authority,
      resolvedExactArtistIdentities,
    }),
    submitAmbiguity: ({ authority, ambiguity }) => (
      repository.submitBriefAnswers({
        briefRequestId,
        idempotencyKey: key,
        questionSetHash,
        answers: submittedAnswers,
        customTrackCountAuthority: authority,
        exactArtistIdentityAmbiguity: {
          inputText: ambiguity.inputText,
          candidates: ambiguity.candidates ?? [],
        },
      })
    ),
  });
  if (outcome.status === "stale_question_set") {
    return reply.code(409).send({
      error: "Playlist guidance changed; review the current questions before answering",
      code: "stale_guidance_question_set",
      requestId: briefRequestId,
      questionSetHash: outcome.questionSetHash,
      questions: outcome.questions,
    });
  }
  if (outcome.status === "blocked_dependency") {
    return reply
      .header(
        "retry-after",
        String(Math.ceil(outcome.retryAfterMs / 1_000)),
      )
      .code(503)
      .send({
        requestId: briefRequestId,
        status: "blocked_dependency",
        code: "artist_identity_resolution_retryable",
        error: "Apple artist verification is temporarily unavailable. Your current playlist interpretation is unchanged.",
        nextAction: "retry",
        retryAfterMs: outcome.retryAfterMs,
        questionSetHash: outcome.questionSetHash,
        questions: outcome.questions,
      });
  }
  if (outcome.status === "technical_quarantine") {
    return reply.code(503).send({
      requestId: briefRequestId,
      status: "quarantined",
      code: "artist_identity_resolution_configuration",
      error: "Apple artist verification needs operator attention. Your current playlist interpretation is unchanged.",
      nextAction: "contact_support",
      reason: outcome.reason,
      questionSetHash: outcome.questionSetHash,
      questions: outcome.questions,
    });
  }
  if (outcome.status === "needs_input") {
    return reply.code(409).send({
      requestId: briefRequestId,
      status: "needs_input",
      code: "exact_artist_identity_clarification_required",
      error: customArtistNeedsInputMessageV1(outcome),
      nextAction: "edit_interpretation",
      reason: outcome.reason,
      questionSetHash: outcome.questionSetHash,
      questions: outcome.questions,
      artistCandidates: outcome.candidates,
    });
  }
  const submitted = outcome.submission;
  if (submitted.status === "stale_question_set") {
    return reply.code(409).send({
      error: "Playlist guidance changed; review the current questions before answering",
      code: "stale_guidance_question_set",
      requestId: briefRequestId,
      questionSetHash: submitted.questionSetHash,
      questions: submitted.questions,
    });
  }
  if (submitted.status === "finalizing") {
    // The dedupe key repairs a crash after the durable answer transaction but
    // before queue handoff, including an identical prior replay.
    await repository.enqueueJob({
      kind: "brief",
      briefRequestId,
      payload: { briefRequestId },
      dedupeKey: `brief-finalize:${briefRequestId}`,
    });
  }
  return reply.code(submitted.created ? 202 : 200).send({
    requestId: briefRequestId,
    status: submitted.status,
    ...("questionSetHash" in submitted
      ? {
          questionSetHash: submitted.questionSetHash,
          questions: submitted.questions,
        }
      : {}),
    pollAfterMs: submitted.status === "finalizing" ? 1_500 : undefined,
  });
});

app.delete<{ Params: { id: string } }>("/api/v1/brief/:id", async (request, reply) => {
  const briefRequestId = uuid(request.params.id, "Brief request ID");
  await capabilities.authenticateForBrief(request, briefRequestId);
  await repository.consumeRateLimit(identity(request).clientBucketAliases, "mutation", 120, 1);
  await repository.deleteBriefRequest(briefRequestId);
  if (!await capabilities.authenticateOptional(request)) await capabilities.revoke(request, reply);
  return reply.code(204).send();
});

app.post<{ Body: { token?: string; capabilityToken?: string } }>("/api/v1/capabilities/exchange", async (request, reply) => {
  const currentSession = await capabilities.authenticateOptional(request);
  const session = await capabilities.exchange(
    request.body?.token ?? request.body?.capabilityToken ?? "",
    reply,
    currentSession,
  );
  return { runId: session.accessId, expiresAt: session.expiresAt.toISOString() };
});

app.post<{
  Body: {
    briefRequestId?: string;
    brief?: PlaylistBrief;
    targetTrackCount?: number;
    idempotencyKey?: string;
    releaseCanary?: unknown;
    manifestOnly?: boolean;
  };
}>("/api/v1/runs", async (request, reply) => {
  const releaseCanary = authenticateReleaseCanary(
    request.body?.releaseCanary,
    "run",
  );
  const caller = identity(request);
  const manifestOnly = request.body?.manifestOnly === true;
  if (request.body?.manifestOnly !== undefined && !manifestOnly) {
    throw new HttpError(
      400,
      "manifestOnly must be true when present",
      "invalid_manifest_canary_mode",
    );
  }
  const manifestCanaryAllowed = !manifestOnly
    || manifestOnlyReleaseCanaryAllowed({
      releaseEnvironment: releaseCanary?.environment ?? null,
      owner: isOwner(caller),
      publicAssignmentPaused:
        await repository.getSetting("pipeline_v3_public_assignment_paused")
          === "true",
    });
  if (
    manifestOnly
    && !manifestCanaryAllowed
  ) {
    throw new HttpError(
      403,
      "Production manifest-only canaries require a signed owner request while public assignment is paused",
      "release_manifest_canary_owner_gate_required",
    );
  }
  await assertNotPaused("research");
  await requireWorkerForNewWork();
  const briefRequestId = uuid(request.body?.briefRequestId, "Brief request ID");
  const briefSession = await capabilities.authenticateForBrief(request, briefRequestId);
  const interpreted = await repository.getBriefRequest(briefRequestId);
  if (!interpreted || interpreted.status !== "complete" || !isPlaylistBrief(interpreted.brief)) {
    throw new HttpError(409, "Playlist scope is not ready to confirm", "brief_not_ready");
  }
  const submittedBrief = request.body?.brief;
  if (submittedBrief !== undefined && !isPlaylistBrief(submittedBrief)) {
    throw new HttpError(400, "Confirmed playlist brief is invalid", "invalid_brief");
  }
  const executionRequestedTrackCount = interpreted.executionRequestedTrackCount
    ?? interpreted.requestedTrackCount;
  const brief = canonicalBriefForRequest(
    { ...interpreted, requestedTrackCount: executionRequestedTrackCount },
    interpreted.brief,
    submittedBrief,
  );
  const submittedTrackCount = request.body?.targetTrackCount;
  const canonicalExactTrackCount = brief.targetSize
    && brief.targetSize.min === brief.targetSize.max
    ? brief.targetSize.max
    : null;
  const requestedTrackCount = submittedTrackCount
    ?? executionRequestedTrackCount
    ?? canonicalExactTrackCount;
  if (manifestOnly && (
    !Number.isSafeInteger(requestedTrackCount)
    || Number(requestedTrackCount) < 1
    || Number(requestedTrackCount) > RELEASE_MANIFEST_CANARY_MAX_TRACKS
  )) {
    throw new HttpError(
      400,
      `Manifest-only live-provider canaries require an exact count from 1 through ${RELEASE_MANIFEST_CANARY_MAX_TRACKS}`,
      "release_manifest_canary_count_invalid",
    );
  }
  const preliminaryTrackCountAdmission = playlistTrackCountAdmission({
    requestedTrackCount,
    owner: isOwner(caller),
    canonicalActivationReady: false,
  });
  if (preliminaryTrackCountAdmission.status === "invalid") {
    throw new HttpError(
      400,
      `Track count must be an integer from ${PUBLIC_PLAYLIST_MINIMUM_TRACKS} to ${preliminaryTrackCountAdmission.maximumTrackCount}`,
      "invalid_track_count",
    );
  }
  if (submittedTrackCount !== undefined
    && submittedTrackCount !== executionRequestedTrackCount) {
    throw new HttpError(
      409,
      "The selected playlist size changed before research began; return to the request and retry",
      "track_count_mismatch",
    );
  }
  if (preliminaryTrackCountAdmission.expanded) {
    const [
      observedDatabaseSchemaVersion,
      observedDatabaseCapabilityVersion,
      observedCanonicalExecutionHardeningVersion,
      observedCanonicalExecutorReleaseIdentityFencingVersion,
      executorReleaseIdentityFenceSupported,
    ] =
      await Promise.all([
        repository.getSchemaVersion(),
        repository.getSetting(CANONICAL_ACTIVATION_DATABASE_CAPABILITY_SETTING),
        repository.getSetting(
          CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_SETTING,
        ),
        repository.getSetting(
          CANONICAL_EXECUTOR_RELEASE_IDENTITY_DATABASE_CAPABILITY_SETTING,
        ),
        repository.executorReleaseIdentityFenceAvailable(),
      ]);
    const trackCountAdmission = playlistTrackCountAdmission({
      requestedTrackCount,
      owner: isOwner(caller),
      canonicalActivationReady: canonicalContractActivationReady({
        environment: process.env,
        observedDatabaseSchemaVersion,
        observedDatabaseCapabilityVersion,
        observedCanonicalExecutionHardeningVersion,
        observedCanonicalExecutorReleaseIdentityFencingVersion,
        executorReleaseIdentityFenceSupported,
      }),
    });
    if (trackCountAdmission.status !== "accepted"
      || trackCountAdmission.requiredBriefContractVersion !== 3
      || interpreted.briefContractVersion !== 3) {
      throw new HttpError(
        503,
        "Owner playlist sizes above 300 are paused until the schema-19 activation check passes",
        "expanded_track_count_activation_not_ready",
      );
    }
  }
  const confirmedEstimateUsd = estimateResearchCost(brief);
  if (!isOwner(caller)) {
    if (executionRequestedTrackCount === null) {
      throw new HttpError(409, "A public playlist requires an exact track count", "brief_not_ready");
    }
    const policy = researchExecutionPolicy(brief, process.env, interpreted.selectionPlan);
    if (
      policy.kind !== "fast_curated"
      || brief.targetSize?.min !== executionRequestedTrackCount
      || brief.targetSize?.max !== executionRequestedTrackCount
      || confirmedEstimateUsd > PUBLIC_FAST_RESEARCH_BUDGET_USD
    ) {
      throw new HttpError(409, "The public playlist scope exceeds the bounded research profile", "brief_not_ready");
    }
  }
  const automaticOneCommand = executionRequestedTrackCount !== null;
  if (!automaticOneCommand && !materialAmbiguitiesAccepted(brief, interpreted.brief.ambiguities)) {
    throw new HttpError(
      409,
      "Accept every material scope assumption before research",
      "ambiguities_unresolved",
    );
  }
  const key = idempotencyKey(request, request.body?.idempotencyKey);
  const briefActualCostUsd = await repository.getBriefActualCostUsd(briefRequestId);
  const publicRunBudget = publicRunBudgetUsd(
    confirmedEstimateUsd,
    briefActualCostUsd,
    executionRequestedTrackCount ?? brief.targetSize?.max ?? undefined,
  );
  if (!isOwner(caller) && publicRunBudget <= 0) {
    throw new HttpError(
      402,
      "Playlist guidance used the available research budget",
      "brief_budget_reached",
    );
  }
  const runBudgetUsd = isOwner(caller) ? confirmedEstimateUsd : publicRunBudget;
  const created = await repository.createRunIdempotent({
    prompt: interpreted.prompt,
    briefRequestId,
    brief,
    estimateUsd: runBudgetUsd,
    approvedBudgetUsd: isOwner(caller)
      ? initialApprovedBudgetUsd(confirmedEstimateUsd)
      : runBudgetUsd,
    clientBucket: caller.clientBucket,
    clientBucketAliases: caller.clientBucketAliases,
    idempotencyKey: key,
    autoPublish: !manifestOnly && executionRequestedTrackCount !== null,
    capabilitySessionId: briefSession.id,
    forceFreshResearch: isOwner(caller) || releaseCanary !== null,
    releaseCanary,
    releaseManifestCanary: manifestOnly,
    releaseManifestCanaryOwnerAuthorized: manifestOnly && isOwner(caller),
  });
  // A repeated idempotent request repairs a crash between the committed run
  // transaction and the queue insert. Cached completed runs need no handoff.
  if (!created.reused && created.status === "queued") {
    await enqueueResearchResume(created.runId);
  }
  const capability = await capabilities.issue(created.runId, created.accessId);
  const run = await repository.getRunByAccess(created.accessId);
  return reply.code(created.created ? 201 : 200).send({ run, capability, reused: created.reused });
});

app.get("/api/v1/runs", async (request) => {
  const session = await capabilities.authenticate(request);
  return { items: await repository.listRunsForCapabilitySession(session.id, 50) };
});

app.get<{ Params: { id: string } }>("/api/v1/runs/:id", async (request) => {
  const accessId = uuid(request.params.id, "Run ID");
  await sessionForAccess(request, accessId);
  const run = await repository.getRunByAccess(accessId);
  if (!run) throw new HttpError(404, "Research run not found", "run_not_found");
  return run;
});

app.get<{ Params: { id: string } }>("/api/v1/runs/:id/manifest-canary-evidence", async (request) => {
  const accessId = uuid(request.params.id, "Run ID");
  await sessionForAccess(request, accessId);
  return repository.getReleaseManifestCanaryEvidenceByAccess(accessId);
});

app.get<{ Params: { id: string } }>("/api/v1/runs/:id/progress", async (request) => {
  const accessId = uuid(request.params.id, "Run ID");
  await sessionForAccess(request, accessId);
  const run = await repository.getRunByAccess(accessId);
  if (!run) throw new HttpError(404, "Research run not found", "run_not_found");
  return {
    runId: run.id,
    status: run.status,
    phase: run.phase,
    progress: run.progress ?? null,
    resolution: run.resolution ?? null,
    partialAction: run.partialAction ?? null,
    decisionAction: run.decisionAction ?? null,
    explore: run.explore ?? null,
  };
});

app.post<{
  Params: { id: string };
  Body: {
    answers?: Array<{
      questionId?: string;
      optionId?: string;
      optionIds?: string[];
      customText?: string;
      skipped?: boolean;
    }>;
    questionSetHash?: unknown;
    idempotencyKey?: unknown;
  };
}>("/api/v1/runs/:id/guidance/answers", async (request, reply) => {
  const accessId = uuid(request.params.id, "Run ID");
  const session = await sessionForAccess(request, accessId);
  if (!Array.isArray(request.body?.answers)) {
    throw new HttpError(
      400,
      "Playlist guidance answers are required",
      "invalid_guidance_answers",
    );
  }
  const questionSetHash = typeof request.body?.questionSetHash === "string"
    ? request.body.questionSetHash.trim().toLowerCase()
    : "";
  if (!/^[a-f0-9]{64}$/u.test(questionSetHash)) {
    throw new HttpError(
      400,
      "Playlist guidance question set is invalid",
      "invalid_guidance_question_set",
    );
  }
  const key = idempotencyKey(request, request.body?.idempotencyKey);
  await repository.consumeRateLimit(
    identity(request).clientBucketAliases,
    "mutation",
    120,
    1,
  );
  const submitted = await repository.submitPlaylistRunRescueGuidance({
    runId: session.runId,
    sourceAccessId: accessId,
    questionSetHash,
    idempotencyKey: key,
    answers: request.body.answers.map((answer) => ({
      questionId: typeof answer.questionId === "string" ? answer.questionId : "",
      ...(typeof answer.optionId === "string" ? { optionId: answer.optionId } : {}),
      ...(Array.isArray(answer.optionIds)
        ? {
            optionIds: answer.optionIds.filter(
              (value): value is string => typeof value === "string",
            ),
          }
        : {}),
      ...(typeof answer.customText === "string"
        ? { customText: answer.customText }
        : {}),
      ...(answer.skipped === true ? { skipped: true } : {}),
    })),
  });
  const run = await repository.getRunByAccess(submitted.accessId);
  if (!run) throw new HttpError(404, "Research run not found", "run_not_found");
  return reply.code(submitted.created ? 202 : 200).send({
    run,
    revised: submitted.revised,
  });
});

app.get<{
  Params: { id: string };
}>("/api/v1/runs/:id/guidance/history", async (request) => {
  const accessId = uuid(request.params.id, "Run ID");
  const session = await sessionForAccess(request, accessId);
  return repository.getPlaylistGuidanceHistory({
    runId: session.runId,
    sourceAccessId: accessId,
  });
});

app.post<{
  Params: { id: string };
  Body: {
    answerSetId?: unknown;
    questionId?: unknown;
    answer?: {
      optionId?: unknown;
      optionIds?: unknown;
      customText?: unknown;
      skipped?: unknown;
    };
    expectedContractRevisionId?: unknown;
    expectedContractSemanticHash?: unknown;
    historyVersion?: unknown;
    confirmationHash?: unknown;
    confirmed?: unknown;
    idempotencyKey?: unknown;
  };
}>("/api/v1/runs/:id/guidance/revisions", async (request, reply) => {
  const accessId = uuid(request.params.id, "Run ID");
  const session = await sessionForAccess(request, accessId);
  const answerSetId = uuid(
    typeof request.body?.answerSetId === "string"
      ? request.body.answerSetId
      : "",
    "Guidance answer",
  );
  const questionId = typeof request.body?.questionId === "string"
    ? request.body.questionId.normalize("NFKC").trim()
    : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,159}$/u.test(questionId)) {
    throw new HttpError(
      400,
      "Guidance question is invalid",
      "invalid_guidance_question",
    );
  }
  const expectedContractRevisionId = uuid(
    typeof request.body?.expectedContractRevisionId === "string"
      ? request.body.expectedContractRevisionId
      : "",
    "Contract revision",
  );
  const expectedContractSemanticHash =
    typeof request.body?.expectedContractSemanticHash === "string"
      ? request.body.expectedContractSemanticHash.trim().toLowerCase()
      : "";
  const historyVersion = typeof request.body?.historyVersion === "string"
    ? request.body.historyVersion.trim().toLowerCase()
    : "";
  if (!/^[a-f0-9]{64}$/u.test(expectedContractSemanticHash)
    || !/^[a-f0-9]{64}$/u.test(historyVersion)) {
    throw new HttpError(
      400,
      "Guidance history fence is invalid",
      "invalid_guidance_history",
    );
  }
  const answer = request.body?.answer;
  if (!answer || typeof answer !== "object") {
    throw new HttpError(
      400,
      "A replacement guidance answer is required",
      "invalid_guidance_answers",
    );
  }
  const key = idempotencyKey(request, request.body?.idempotencyKey);
  const normalizedRevisionAnswer = {
    questionId,
    ...(typeof answer.optionId === "string"
      ? { optionId: answer.optionId }
      : {}),
    ...(Array.isArray(answer.optionIds)
      ? {
          optionIds: answer.optionIds.filter(
            (value): value is string => typeof value === "string",
          ),
        }
      : {}),
    ...(typeof answer.customText === "string"
      ? { customText: answer.customText }
      : {}),
    ...(answer.skipped === true ? { skipped: true } : {}),
  };
  const preflight = await repository.preflightPlaylistGuidanceRevision({
    runId: session.runId,
    sourceAccessId: accessId,
    answerSetId,
    questionId,
    expectedContractRevisionId,
    expectedContractSemanticHash,
    historyVersion,
    idempotencyKey: key,
    answer: normalizedRevisionAnswer,
    // Authority is creation-time server state and is intentionally excluded
    // from the request hash. The durable replay read must precede readiness.
    customTrackCountAuthority:
      PUBLIC_CUSTOM_GUIDANCE_TRACK_COUNT_AUTHORITY_V1,
  });
  if (preflight.status === "prior") {
    const priorRun = await repository.getRunByAccess(preflight.accessId);
    if (!priorRun) {
      throw new HttpError(
        404,
        "Research run not found",
        "run_not_found",
      );
    }
    return reply.code(200).send({
      status: "revised",
      run: priorRun,
    });
  }
  const caller = identity(request);
  await repository.consumeRateLimit(
    caller.clientBucketAliases,
    "mutation",
    120,
    1,
  );
  const customTrackCountAuthority =
    await customGuidanceTrackCountAuthorityForRequest(request);
  let resolvedExactArtistIdentities: ResolvedExactArtistIdentityV1[] = [];
  if (typeof answer.customText === "string") {
    const resolution = await resolveCustomArtistIdentities({
      customTexts: [answer.customText],
      storefront: preflight.storefront,
    });
    if (resolution.status !== "ready") {
      const concurrent = await repository.preflightPlaylistGuidanceRevision({
        runId: session.runId,
        sourceAccessId: accessId,
        answerSetId,
        questionId,
        expectedContractRevisionId,
        expectedContractSemanticHash,
        historyVersion,
        idempotencyKey: key,
        answer: normalizedRevisionAnswer,
        customTrackCountAuthority,
      });
      if (concurrent.status === "prior") {
        const priorRun = await repository.getRunByAccess(concurrent.accessId);
        if (!priorRun) {
          throw new HttpError(
            404,
            "Research run not found",
            "run_not_found",
          );
        }
        return reply.code(200).send({
          status: "revised",
          run: priorRun,
        });
      }
    }
    if (resolution.status === "blocked_dependency") {
      return reply
        .header(
          "retry-after",
          String(Math.ceil(resolution.retryAfterMs / 1_000)),
        )
        .code(503)
        .send({
          status: "blocked_dependency",
          code: "artist_identity_resolution_retryable",
          error: "Apple artist verification is temporarily unavailable. The saved playlist interpretation is unchanged.",
          nextAction: "retry",
          retryAfterMs: resolution.retryAfterMs,
        });
    }
    if (resolution.status === "technical_quarantine") {
      return reply.code(503).send({
        status: "quarantined",
        code: "artist_identity_resolution_configuration",
        error: "Apple artist verification needs operator attention. The saved playlist interpretation is unchanged.",
        nextAction: "contact_support",
        reason: resolution.reason,
      });
    }
    if (resolution.status === "needs_input") {
      return reply.code(409).send({
        status: "needs_input",
        code: "exact_artist_identity_clarification_required",
        error: customArtistNeedsInputMessageV1(resolution),
        nextAction: "edit_interpretation",
        reason: resolution.reason,
        artistCandidates: resolution.candidates,
      });
    }
    resolvedExactArtistIdentities = resolution.identities;
  }
  const revised = await repository.revisePlaylistGuidanceAnswer({
    runId: session.runId,
    sourceAccessId: accessId,
    answerSetId,
    questionId,
    expectedContractRevisionId,
    expectedContractSemanticHash,
    historyVersion,
    idempotencyKey: key,
    answer: normalizedRevisionAnswer,
    ...(typeof request.body?.confirmationHash === "string"
      ? { confirmationHash: request.body.confirmationHash }
      : {}),
    confirmed: request.body?.confirmed === true,
    customTrackCountAuthority,
    resolvedExactArtistIdentities,
  });
  if (revised.status === "needs_confirmation") {
    return reply.code(200).send(revised);
  }
  const run = await repository.getRunByAccess(revised.accessId);
  if (!run) throw new HttpError(404, "Research run not found", "run_not_found");
  return reply.code(revised.created ? 202 : 200).send({
    status: "revised",
    run,
  });
});

app.post<{
  Params: { id: string };
  Body: { outcomeVersion?: unknown; decisionHash?: unknown; idempotencyKey?: unknown };
}>("/api/v1/runs/:id/research/continue", async (request, reply) => {
  await assertNotPaused("research");
  await requireWorkerForNewWork();
  const accessId = uuid(request.params.id, "Run ID");
  const session = await sessionForAccess(request, accessId);
  const key = idempotencyKey(request, request.body?.idempotencyKey);
  await repository.consumeRateLimit(identity(request).clientBucketAliases, "mutation", 120, 1);
  const outcomeVersion = Number(request.body?.outcomeVersion);
  if (!Number.isSafeInteger(outcomeVersion) || outcomeVersion < 1) {
    throw new HttpError(400, "Outcome version is invalid", "invalid_outcome_version");
  }
  const continuation = await repository.continuePartialResearch({
    runId: session.runId,
    outcomeVersion,
    idempotencyKey: key,
    decisionHash: typeof request.body?.decisionHash === "string"
      ? request.body.decisionHash.trim().toLowerCase()
      : null,
  });
  const run = await repository.getRunByAccess(accessId);
  if (!run) throw new HttpError(404, "Research run not found", "run_not_found");
  return reply.code(continuation.queued ? 202 : 200).send(run);
});

app.post<{
  Params: { id: string };
  Body: {
    expectedContractRevisionId?: unknown;
    expectedContractSemanticHash?: unknown;
    decisionHash?: unknown;
    blockerVersion?: unknown;
    idempotencyKey?: unknown;
  };
}>("/api/v1/runs/:id/dependency/resume", async (request, reply) => {
  await assertNotPaused("research");
  await requireWorkerForNewWork();
  const accessId = uuid(request.params.id, "Run ID");
  const session = await sessionForAccess(request, accessId);
  const key = idempotencyKey(request, request.body?.idempotencyKey);
  await repository.consumeRateLimit(
    identity(request).clientBucketAliases,
    "mutation",
    120,
    1,
  );
  const expectedContractRevisionId = uuid(
    request.body?.expectedContractRevisionId,
    "Contract revision ID",
  );
  const expectedContractSemanticHash = typeof request.body
    ?.expectedContractSemanticHash === "string"
    ? request.body.expectedContractSemanticHash.trim().toLowerCase()
    : "";
  const decisionHash = typeof request.body?.decisionHash === "string"
    ? request.body.decisionHash.trim().toLowerCase()
    : "";
  const blockerVersion = typeof request.body?.blockerVersion === "string"
    ? request.body.blockerVersion.trim().toLowerCase()
    : "";
  if (![
    expectedContractSemanticHash,
    decisionHash,
    blockerVersion,
  ].every((value) => /^[a-f0-9]{64}$/u.test(value))) {
    throw new HttpError(
      400,
      "Dependency resume fence is invalid",
      "invalid_dependency_resume_state",
    );
  }
  const resumed = await repository.resumePlaylistDependencyDecision({
    runId: session.runId,
    sourceAccessId: accessId,
    capabilitySessionId: session.id,
    expectedContractRevisionId,
    expectedContractSemanticHash,
    expectedDecisionHash: decisionHash,
    expectedBlockerVersion: blockerVersion,
    idempotencyKey: key,
  });
  const run = await repository.getRunByAccess(accessId);
  if (!run) throw new HttpError(404, "Research run not found", "run_not_found");
  return reply.code(resumed.queued ? 202 : 200).send({
    run,
    dependencyResume: {
      queued: resumed.queued,
      authorizationHash: resumed.authorizationHash,
      resumeAt: resumed.resumeAt.toISOString(),
    },
  });
});

app.post<{
  Params: { id: string };
  Body: {
    outcomeHash?: unknown;
    manifestId?: unknown;
    manifestHash?: unknown;
    idempotencyKey?: unknown;
  };
}>("/api/v1/runs/:id/partial/confirm", async (request, reply) => {
  await assertNotPaused("publishing");
  const accessId = uuid(request.params.id, "Run ID");
  const session = await sessionForAccess(request, accessId);
  const key = idempotencyKey(request, request.body?.idempotencyKey);
  await repository.consumeRateLimit(identity(request).clientBucketAliases, "mutation", 120, 1);
  const outcomeHash = typeof request.body?.outcomeHash === "string"
    ? request.body.outcomeHash.trim().toLowerCase()
    : "";
  if (!/^[a-f0-9]{64}$/u.test(outcomeHash)) {
    throw new HttpError(400, "Partial outcome hash is invalid", "invalid_outcome_hash");
  }
  const manifestId = request.body?.manifestId == null
    ? null
    : uuid(request.body.manifestId, "Manifest ID");
  const manifestHash = request.body?.manifestHash == null
    ? null
    : String(request.body.manifestHash).trim().toLowerCase();
  if (manifestHash !== null && !/^[a-f0-9]{64}$/u.test(manifestHash)) {
    throw new HttpError(400, "Manifest hash is invalid", "invalid_manifest_hash");
  }
  const manifest = await repository.confirmPartialPublication({
    runId: session.runId,
    capabilitySessionId: session.id,
    idempotencyKey: key,
    outcomeHash,
    manifestId,
    manifestHash,
  });
  const apple = await repository.getAppleAuthorization();
  const caller = identity(request);
  const publication = await repository.queueManifestPublication({
    runId: session.runId,
    manifestId: manifest.id,
    appleAuthorized: apple?.status === "valid",
    clientBucket: caller.clientBucket,
    clientBucketAliases: caller.clientBucketAliases,
    rateLimit: 10,
  });
  if (publication.state === "waiting_for_apple_authorization") {
    await repository.enqueueNotification("apple_reauthorization_required", {
      deduplicationKey: `apple-reauthorization:${manifest.id}`,
      runId: session.runId,
      manifestId: manifest.id,
    });
  }
  return reply.code(publication.state === "terminal" ? 200 : 202).send({
    run: await repository.getRunByAccess(accessId),
    manifest,
    publication: { state: publication.state, queued: publication.queued },
  });
});

app.post<{
  Params: { id: string };
  Body: { idempotencyKey?: unknown };
}>("/api/v1/runs/:id/cancel", async (request) => {
  const accessId = uuid(request.params.id, "Run ID");
  const session = await sessionForAccess(request, accessId);
  idempotencyKey(request, request.body?.idempotencyKey);
  await repository.consumeRateLimit(identity(request).clientBucketAliases, "mutation", 120, 1);
  await repository.cancelRunByVisitor(session.runId);
  const run = await repository.getRunByAccess(accessId);
  if (!run) throw new HttpError(404, "Research run not found", "run_not_found");
  return { run };
});

app.post<{
  Params: { id: string };
  Body: { listed?: unknown; idempotencyKey?: unknown };
}>("/api/v1/runs/:id/explore", async (request) => {
  const accessId = uuid(request.params.id, "Run ID");
  const session = await sessionForAccess(request, accessId);
  idempotencyKey(request, request.body?.idempotencyKey);
  await repository.consumeRateLimit(identity(request).clientBucketAliases, "mutation", 120, 1);
  if (typeof request.body?.listed !== "boolean") {
    throw new HttpError(400, "Explore visibility is invalid", "invalid_explore_visibility");
  }
  return { explore: await repository.setRunExplorePreference(session.runId, request.body.listed) };
});

app.post<{ Params: { id: string } }>("/api/v1/runs/:id/capability", async (request) => {
  const accessId = uuid(request.params.id, "Run ID");
  const session = await sessionForAccess(request, accessId);
  await repository.consumeRateLimit(identity(request).clientBucketAliases, "mutation", 120, 1);
  return { capability: await capabilities.issue(session.runId, accessId), expiresInSeconds: 1_800 };
});

app.post<{ Params: { id: string } }>("/api/v1/runs/:id/capabilities/transfer", async (request) => {
  const accessId = uuid(request.params.id, "Run ID");
  const session = await sessionForAccess(request, accessId);
  await repository.consumeRateLimit(identity(request).clientBucketAliases, "mutation", 120, 1);
  return { capability: await capabilities.issue(session.runId, accessId), expiresAt: new Date(Date.now() + 1_800_000).toISOString() };
});

app.get<{ Params: { id: string }; Querystring: { page?: string; pageSize?: string } }>("/api/v1/runs/:id/exceptions", async (request) => {
  const accessId = uuid(request.params.id, "Run ID");
  const session = await sessionForAccess(request, accessId);
  const page = positiveIntegerQuery(request.query.page, 1, "Page", 1_000_000);
  const pageSize = positiveIntegerQuery(request.query.pageSize, 20, "Page size", 20);
  return repository.listExceptions(session.runId, page, pageSize);
});

app.get<{ Params: { id: string }; Querystring: { page?: string; pageSize?: string } }>("/api/v1/runs/:id/tracks", async (request) => {
  const accessId = uuid(request.params.id, "Run ID");
  const session = await sessionForAccess(request, accessId);
  const page = positiveIntegerQuery(request.query.page, 1, "Page", 1_000_000);
  const pageSize = positiveIntegerQuery(request.query.pageSize, 200, "Page size", 500);
  return repository.listCatalogTracks(
    session.runId,
    page,
    pageSize,
  );
});

app.post<{ Params: { id: string } }>("/api/v1/runs/:id/matching", async (request, reply) => {
  const accessId = uuid(request.params.id, "Run ID");
  const session = await sessionForAccess(request, accessId);
  await repository.consumeRateLimit(identity(request).clientBucketAliases, "mutation", 120, 1);
  const recovery = await repository.queueCatalogRecovery(
    session.runId,
    process.env.APPLE_STOREFRONT ?? "us",
  );
  return reply.code(recovery.state === "ready" ? 200 : 202).send({
    ...recovery,
    run: await repository.getRunByAccess(accessId),
  });
});

app.post<{
  Params: { id: string };
  Body: {
    selected?: unknown;
    useRecommended?: unknown;
    excludedCandidateIds?: unknown;
    overrides?: unknown;
  };
}>("/api/v1/runs/:id/selection", { bodyLimit: BULK_SELECTION_BODY_BYTES }, async (request) => {
  const accessId = uuid(request.params.id, "Run ID");
  const session = await sessionForAccess(request, accessId);
  await repository.consumeRateLimit(identity(request).clientBucketAliases, "mutation", 120, 1);
  return repository.finalizeCatalogSelection(session.runId, {
    selected: catalogChoices(request.body?.selected, "Selected tracks"),
    useRecommended: request.body?.useRecommended === true,
    excludedCandidateIds: candidateIds(request.body?.excludedCandidateIds),
    overrides: catalogChoices(request.body?.overrides, "Apple match overrides"),
  });
});

app.post<{ Params: { id: string }; Body: { candidateId?: string; decision?: "accepted" | "rejected"; catalogId?: string; song?: Record<string, unknown> } }>("/api/v1/runs/:id/review", async (request) => {
  const accessId = uuid(request.params.id, "Run ID");
  const session = await sessionForAccess(request, accessId);
  await repository.consumeRateLimit(identity(request).clientBucketAliases, "mutation", 120, 1);
  const candidateId = uuid(request.body?.candidateId, "Candidate ID");
  const decision = request.body?.decision;
  if (decision !== "accepted" && decision !== "rejected") throw new HttpError(400, "Review decision is invalid", "invalid_review");
  let song = request.body?.song;
  if (!song && request.body?.catalogId) song = { id: request.body.catalogId };
  const resultingStatus = await repository.reviewMatch(session.runId, candidateId, decision, song);
  return { reviewed: true, candidateId, decision: resultingStatus };
});

app.post<{ Params: { id: string }; Body: { mode?: "reviewed" | "verified_only" } }>("/api/v1/runs/:id/manifest", async (request) => {
  const accessId = uuid(request.params.id, "Run ID");
  const session = await sessionForAccess(request, accessId);
  await repository.consumeRateLimit(identity(request).clientBucketAliases, "mutation", 120, 1);
  return repository.createManifest(session.runId, { verifiedOnly: request.body?.mode === "verified_only" });
});

app.post<{ Params: { id: string }; Body: { manifestId?: string } }>("/api/v1/runs/:id/publish", async (request, reply) => {
  await assertNotPaused("publishing");
  idempotencyKey(request);
  const accessId = uuid(request.params.id, "Run ID");
  const session = await sessionForAccess(request, accessId);
  const manifest = request.body?.manifestId
    ? await repository.getManifestById(uuid(request.body.manifestId, "Manifest ID"))
    : await repository.getLatestManifestForRun(session.runId);
  if (!manifest || manifest.runId !== session.runId) throw new HttpError(409, "Lock a manifest before publishing", "manifest_not_ready");
  const apple = await repository.getAppleAuthorization();
  const caller = identity(request);
  const publication = await repository.queueManifestPublication({
    runId: session.runId,
    manifestId: manifest.id,
    appleAuthorized: apple?.status === "valid",
    clientBucket: caller.clientBucket,
    clientBucketAliases: caller.clientBucketAliases,
    rateLimit: 10,
  });
  if (publication.state === "waiting_for_apple_authorization") {
    await repository.enqueueNotification("apple_reauthorization_required", {
      deduplicationKey: `apple-reauthorization:${manifest.id}`,
      runId: session.runId,
      manifestId: manifest.id,
    });
  }
  return reply.code(publication.state === "terminal" ? 200 : 202).send({
    run: await repository.getRunByAccess(accessId),
    publication: { state: publication.state, queued: publication.queued },
  });
});

app.get<{ Params: { id: string } }>("/api/v1/runs/:id/result", async (request) => {
  const accessId = uuid(request.params.id, "Run ID");
  const session = await sessionForAccess(request, accessId);
  return repository.getPublicResult(session.runId);
});

app.get<{ Params: { id: string }; Querystring: { page?: string; pageSize?: string } }>("/api/v1/runs/:id/evidence", async (request) => {
  const accessId = uuid(request.params.id, "Run ID");
  const session = await sessionForAccess(request, accessId);
  const page = positiveIntegerQuery(request.query.page, 1, "Page", 1_000_000);
  const pageSize = positiveIntegerQuery(request.query.pageSize, 50, "Page size", 100);
  return repository.getEvidenceReport(session.runId, page, pageSize);
});

app.delete<{ Params: { id: string } }>("/api/v1/runs/:id", async (request, reply) => {
  const accessId = uuid(request.params.id, "Run ID");
  await sessionForAccess(request, accessId);
  await repository.consumeRateLimit(identity(request).clientBucketAliases, "mutation", 120, 1);
  await repository.deleteRunAccess(accessId);
  if (!await capabilities.authenticateOptional(request)) await capabilities.revoke(request, reply);
  return reply.code(204).send();
});

function owner(request: FastifyRequest): string {
  return assertOwner(identity(request));
}

async function ownerCorpusAction<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    return evidenceGraphHttpErrorV3(error);
  }
}

app.get("/api/v1/owner/status", async (request) => {
  owner(request);
  const capabilityPepper = capabilityPepperRotationStatus();
  const health = await repository.getSystemHealth();
  const deploymentDatabaseReady = releaseDatabaseReadinessReady({
    environment: process.env,
    observedDatabaseSchemaVersion: health.database.schemaVersion,
    observedDatabaseCapabilityVersion:
      health.database.releaseManifestCanaryGuardsVersion ?? null,
    observedCanonicalExecutionHardeningVersion:
      health.database.canonicalExecutionHardeningVersion ?? null,
    observedCanonicalExecutorReleaseIdentityFencingVersion:
      health.database.canonicalExecutorReleaseIdentityFencingVersion ?? null,
    executorReleaseIdentityFenceSupported:
      health.database.executorReleaseIdentityFenceSupported === true,
  });
  const ok = deploymentDatabaseReady
    && capabilityPepper.ready
    && workerLaneReady(health, "interactive");
  return {
    ok,
    activationReady: ok && workerLaneReady(health, "deep"),
    paused: health.paused.research || health.paused.publishing || health.paused.feedback,
    database: "ready",
    capabilityPepper,
    worker: health.worker.worker_id
      ? health.worker.stale || !health.worker.schemaCompatible || !health.worker.protocolCompatible
        ? "stale"
        : "healthy"
      : "missing",
    workerLanes: {
      interactive: workerLaneStatus(health, "interactive"),
      deep: workerLaneStatus(health, "deep"),
    },
    apple: {
      configured: health.apple.status !== "missing",
      authorized: health.apple.status === "valid",
      status: health.apple.status,
      storefront: health.apple.storefront ?? null,
      validatedAt: health.apple.lastValidatedAt ?? null,
      needsReauthorization: health.apple.status === "reauthorization_required",
      lastError: health.apple.lastError ?? null,
    },
    queuedJobs: health.queue.queued ?? 0,
    activeJobs: health.queue.leased ?? 0,
    queueAgeSeconds: health.queue.oldestQueuedSeconds ?? 0,
    expiredLeases: health.queue.expiredLeases ?? 0,
    failedJobs: health.queue.failed ?? 0,
    monthSpendUsd: health.monthSpendUsd,
    monthReservedUsd: health.monthReservedUsd,
    notificationBacklog: health.notificationBacklog,
    notificationFailures: health.notificationFailures,
    oldestNotificationSeconds: health.oldestNotificationSeconds,
    publicationFailures: health.publicationFailures,
    orphanedPlaylists: health.orphanedPlaylists,
    retention: health.retention,
    configuration: {
      openai: Boolean(process.env.OPENAI_API_KEY),
      appleDeveloper: Boolean(process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_MEDIA_ID && (process.env.APPLE_MUSICKIT_PRIVATE_KEY || process.env.APPLE_MUSICKIT_PRIVATE_KEY_BASE64)),
      resend: Boolean(process.env.RESEND_API_KEY && (process.env.ALERT_EMAIL || process.env.OWNER_ALERT_EMAIL)),
    },
  };
});

app.get("/api/v1/owner/budgets", async (request) => {
  owner(request);
  return { runs: await repository.listAwaitingBudgets(), ceilingUsd: costConfiguration.monthlyCostLimitUsd };
});

app.get<{ Querystring: { limit?: string } }>("/api/v1/owner/runs", async (request) => {
  owner(request);
  return { runs: await repository.listRecentRuns(Number(request.query.limit ?? 50)) };
});

app.get<{
  Querystring: { limit?: string; offset?: string; status?: string };
}>("/api/v1/owner/corpus/review", async (request) => {
  owner(request);
  const query = parseOwnerCorpusListQueryV3(request.query, "review");
  return evidenceGraphRepositoryV3.listObservations({ ...query, status: "quarantined" });
});

app.get<{
  Querystring: { limit?: string; offset?: string; status?: string };
}>("/api/v1/owner/corpus/sources", async (request) => {
  owner(request);
  const query = parseOwnerCorpusListQueryV3(request.query, "source");
  return evidenceGraphRepositoryV3.listSources(query);
});

app.get<{
  Querystring: { limit?: string; offset?: string; status?: string };
}>("/api/v1/owner/corpus/assertions", async (request) => {
  owner(request);
  const query = parseOwnerCorpusListQueryV3(request.query, "assertion");
  return evidenceGraphRepositoryV3.listAssertions({
    ...query,
    status: query.status as "active" | "superseded" | "retracted" | null,
  });
});

app.get<{
  Querystring: { limit?: string; offset?: string; status?: string };
}>("/api/v1/owner/corpus/snapshots", async (request) => {
  owner(request);
  const query = parseOwnerCorpusListQueryV3(request.query, "snapshot");
  return evidenceGraphRepositoryV3.listSnapshots({
    ...query,
    status: query.status as "building" | "locked" | "superseded" | null,
  });
});

app.post<{
  Params: { id: string };
  Body: unknown;
}>("/api/v1/owner/corpus/sources/:id/approve", async (request) => {
  const email = owner(request);
  const sourceDocumentId = uuid(request.params.id, "Source document ID");
  const policy = parseSourcePolicyApprovalV3(request.body);
  const source = await ownerCorpusAction(() => evidenceGraphServiceV3.approveSourcePolicy({
    sourceDocumentId,
    ...policy,
    approvedBy: email,
  }));
  await repository.recordAudit(email, "corpus.source_policy_approved", {
    sourceDocumentId,
    authority: policy.authority,
    accessMethod: policy.accessMethod,
    licenseState: policy.licenseState,
    licenseVersion: policy.licenseVersion,
    termsVersion: policy.termsVersion,
    attribution: policy.attribution,
    cachePolicy: policy.cachePolicy,
    retentionPolicy: policy.retentionPolicy,
    freshnessPolicy: policy.freshnessPolicy,
    sourceRevision: policy.sourceRevision,
  });
  return { source };
});

app.post<{ Body: unknown }>("/api/v1/owner/corpus/observations", async (request, reply) => {
  const email = owner(request);
  const observationInput = parseAppendObservationV3(request.body);
  const observation = await ownerCorpusAction(() => evidenceGraphServiceV3.appendObservation({
    ...observationInput,
    pipelineVersion: EVIDENCE_GRAPH_PIPELINE_V3,
    policyVersion: EVIDENCE_GRAPH_POLICY_V3,
  }));
  await repository.recordAudit(email, "corpus.observation_appended", {
    observationId: observation.id,
    sourceDocumentId: observation.sourceDocumentId,
    predicate: observation.predicate,
    creditScope: observation.creditScope,
  });
  return reply.code(201).send({ observation });
});

app.post<{ Body: unknown }>("/api/v1/owner/corpus/observations/promote", async (request) => {
  const email = owner(request);
  const input = parsePromotionV3(request.body);
  const assertion = await ownerCorpusAction(() => evidenceGraphServiceV3.promoteObservations({
    ...input,
    promotedBy: email,
  }));
  await repository.recordAudit(email, "corpus.observations_promoted", {
    assertionId: assertion.id,
    observationIds: input.observationIds,
    evidenceTier: assertion.evidenceTier,
  });
  return { assertion };
});

app.post<{
  Params: { id: string };
  Body: unknown;
}>("/api/v1/owner/corpus/observations/:id/reject", async (request) => {
  const email = owner(request);
  const observationId = uuid(request.params.id, "Observation ID");
  const input = parseReasonV3(request.body);
  const observation = await ownerCorpusAction(() => evidenceGraphServiceV3.rejectObservation({
    observationId,
    rejectedBy: email,
    reason: input.reason,
  }));
  await repository.recordAudit(email, "corpus.observation_rejected", {
    observationId,
    reason: input.reason,
  });
  return { observation };
});

app.post<{
  Params: { id: string };
  Body: unknown;
}>("/api/v1/owner/corpus/assertions/:id/dispute", async (request) => {
  const email = owner(request);
  const assertionId = uuid(request.params.id, "Assertion ID");
  const input = parseDisputeV3(request.body);
  const assertion = await ownerCorpusAction(() => evidenceGraphServiceV3.disputeAssertion({
    assertionId,
    observationId: input.observationId,
    promotedBy: email,
  }));
  await repository.recordAudit(email, "corpus.assertion_disputed", {
    assertionId,
    disputeAssertionId: assertion.id,
    observationId: input.observationId,
  });
  return { assertion };
});

app.post<{
  Params: { id: string };
  Body: unknown;
}>("/api/v1/owner/corpus/assertions/:id/retract", async (request) => {
  const email = owner(request);
  const assertionId = uuid(request.params.id, "Assertion ID");
  const input = parseReasonV3(request.body);
  const assertion = await ownerCorpusAction(() => evidenceGraphServiceV3.retractAssertion({
    assertionId,
    reason: input.reason,
    promotedBy: email,
  }));
  await repository.recordAudit(email, "corpus.assertion_retracted", {
    assertionId,
    lifecycleAssertionId: assertion.id,
    reason: input.reason,
  });
  return { assertion };
});

app.post<{
  Params: { id: string };
  Body: unknown;
}>("/api/v1/owner/corpus/sources/:id/takedown", async (request) => {
  const email = owner(request);
  const sourceDocumentId = uuid(request.params.id, "Source document ID");
  const input = parseReasonV3(request.body);
  const result = await ownerCorpusAction(() => evidenceGraphServiceV3.takeDownSource({
    sourceDocumentId,
    reason: input.reason,
    promotedBy: email,
  }));
  await repository.recordAudit(email, "corpus.source_taken_down", {
    sourceDocumentId,
    reason: input.reason,
    retractedAssertionIds: result.retractedAssertionIds,
    retainedAssertionIds: result.retainedAssertionIds,
  });
  return result;
});

app.post<{ Body: unknown }>("/api/v1/owner/corpus/snapshots", async (request, reply) => {
  const email = owner(request);
  const input = parseSnapshotV3(request.body);
  const snapshot = await ownerCorpusAction(() => evidenceGraphServiceV3.createLockedSnapshot(input));
  await repository.recordAudit(email, "corpus.snapshot_locked", {
    snapshotId: snapshot.id,
    contentHash: snapshot.contentHash,
    assertionCount: snapshot.assertionCount,
    catalogIdentityCount: snapshot.catalogIdentityCount,
    parentSnapshotId: snapshot.parentSnapshotId,
  });
  return reply.code(201).send({ snapshot });
});

app.post<{
  Params: { id: string };
  Body: { idempotencyKey?: unknown } | unknown;
}>("/api/v1/owner/runs/:id/corpus/resume", async (request, reply) => {
  const email = owner(request);
  await assertNotPaused("research");
  await requireWorkerForNewWork();
  const runId = uuid(request.params.id, "Run ID");
  const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
    ? request.body as { idempotencyKey?: unknown }
    : {};
  const key = idempotencyKey(request, body.idempotencyKey);
  const replay = await repository.getPipelineV3CorpusResumeReplay(runId, key);
  if (replay) return reply.code(202).send({ replayed: true, resumed: replay });
  const review = await repository.preparePipelineV3CorpusResume(runId);
  const snapshot = await ownerCorpusAction(() => evidenceGraphServiceV3.createLockedSnapshot({
    parentSnapshotId: review.parentGraphSnapshotId,
  }));
  const resumed = await repository.resumePipelineV3CorpusResearch({
    runId,
    reviewedGraphSnapshotId: snapshot.id,
    expectedSourceQueryPlanRevisionId: review.sourceQueryPlanRevisionId,
    expectedSourceCheckpointHash: review.sourceCheckpointHash,
    idempotencyKey: key,
  });
  await repository.recordAudit(email, "corpus.run_resumed", {
    runId,
    sourceQueryPlanRevisionId: review.sourceQueryPlanRevisionId,
    graphSnapshotId: snapshot.id,
    promotedAssertionCount: review.promotedAssertionCount,
    enumerationComplete: review.enumerationComplete,
    successorQueryPlanRevisionId: resumed.queryPlanRevisionId,
    jobId: resumed.jobId,
  }, runId);
  return reply.code(202).send({ snapshot, resumed });
});

app.get<{
  Querystring: { limit?: string; offset?: string; kind?: string; status?: string };
}>("/api/v1/owner/feedback", async (request) => {
  owner(request);
  const kind = request.query.kind ? parseFeedbackKind(request.query.kind) : null;
  const status = request.query.status ? parseFeedbackStatus(request.query.status) : null;
  const result = await repository.listFeedbackSubmissions({
    limit: Number(request.query.limit ?? 50),
    offset: Number(request.query.offset ?? 0),
    kind,
    status,
  });
  return {
    items: result.items.map((item) => ({
      ...item,
      imageUrl: item.image ? `/api/v1/owner/feedback/${item.id}/image` : null,
    })),
    total: result.total,
    counts: result.counts,
  };
});

app.get<{ Params: { id: string } }>("/api/v1/owner/feedback/:id/image", async (request, reply) => {
  owner(request);
  const feedbackId = uuid(request.params.id, "Feedback ID");
  const image = await repository.getFeedbackImage(feedbackId);
  if (!image) throw new HttpError(404, "Feedback screenshot was not found", "feedback_image_not_found");
  return reply
    .header("Content-Type", image.mimeType)
    .header("Cache-Control", "private, no-store, max-age=0")
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Disposition", "inline")
    .send(image.data);
});

app.post<{
  Params: { id: string };
  Body: { status?: unknown };
}>("/api/v1/owner/feedback/:id/status", async (request) => {
  const email = owner(request);
  const feedbackId = uuid(request.params.id, "Feedback ID");
  const status = parseFeedbackStatus(request.body?.status);
  return { item: await repository.updateFeedbackStatus(feedbackId, status, email) };
});

app.delete<{ Params: { id: string } }>("/api/v1/owner/feedback/:id", async (request, reply) => {
  const email = owner(request);
  const feedbackId = uuid(request.params.id, "Feedback ID");
  if (!await repository.deleteFeedbackSubmission(feedbackId, email)) {
    throw new HttpError(404, "Feedback was not found", "feedback_not_found");
  }
  return reply.code(204).send();
});

app.get<{ Querystring: { days?: string } }>("/api/v1/owner/quality-diagnostics", async (request) => {
  owner(request);
  const days = Number(request.query?.days ?? 30);
  return repository.getQualityDiagnosticsSummary(Number.isFinite(days) ? days : 30);
});

app.get<{ Querystring: { hours?: string } }>("/api/v1/owner/playlist-resolution-metrics", async (request) => {
  owner(request);
  const requestedHours = Number(request.query?.hours ?? 24);
  if (!Number.isFinite(requestedHours) || requestedHours < 1 || requestedHours > 24 * 90) {
    throw new HttpError(400, "Playlist metrics hours must be between 1 and 2160", "invalid_metrics_window");
  }
  const windowEndedAt = new Date();
  const windowStartedAt = new Date(
    windowEndedAt.getTime() - Math.floor(requestedHours) * 60 * 60_000,
  );
  return repository.getPlaylistResolutionMetrics({
    windowStartedAt,
    windowEndedAt,
  });
});

app.get<{
  Params: { id: string };
  Querystring: { environment?: string; sourceRevision?: string };
}>("/api/v1/owner/release-canaries/:id", async (request) => {
  owner(request);
  const environment = request.query?.environment;
  if (environment !== "staging" && environment !== "production") {
    throw new HttpError(
      400,
      "Release-canary environment is invalid",
      "invalid_release_canary_scope",
    );
  }
  return readReleaseCanaryInventory({
    pool: repository.pool,
    canaryId: request.params.id,
    environment,
    sourceRevision: String(request.query?.sourceRevision ?? "").toLowerCase(),
    executionProof: (runId, manifestId) => (
      repository.getPublicRunExecutionProof(runId, manifestId)
    ),
  });
});

app.post<{ Params: { id: string } }>("/api/v1/owner/runs/:id/refresh", async (request) => {
  const email = owner(request);
  const runId = uuid(request.params.id, "Run ID");
  const result = await repository.invalidateRunReuse(runId, email);
  return { invalidated: true, invalidatedAt: result.invalidatedAt };
});

app.post<{
  Params: { id: string };
  Body: { format?: "json" | "csv"; data?: unknown };
}>("/api/v1/owner/runs/:id/catalog-import", async (request) => {
  const email = owner(request);
  const runId = uuid(request.params.id, "Run ID");
  const parsed = parseOwnerCatalogImport({ format: request.body?.format, data: request.body?.data });
  // A structurally valid owner catalogue is a discovery input, not proof that
  // its linked pages support each assertion. Imported claims remain inferred.
  const importCandidates = unverifiedImportedCandidates(parsed.candidates);
  const importHash = sha256Hex(stableStringify({ sources: parsed.sources, candidates: importCandidates }));
  const { newlyAdded } = await repository.importOwnerCatalog({
    runId,
    actor: email,
    importHash,
    sources: parsed.sources,
    candidates: importCandidates,
  });
  return {
    imported: true,
    importHash,
    sourceCount: parsed.sources.length,
    candidateCount: parsed.candidates.length,
    newlyAdded,
    evidenceState: "inferred",
  };
});

app.post<{ Params: { id: string }; Body: { decision?: "approve" | "cancel"; approvedBudgetUsd?: number } }>("/api/v1/owner/runs/:id/budget", async (request) => {
  const email = owner(request);
  const runId = uuid(request.params.id, "Run ID");
  if (request.body?.decision === "cancel") {
    await repository.cancelRun(runId);
    await repository.recordAudit(email, "run.budget_cancelled", {}, runId);
    return { cancelled: true };
  }
  if (request.body?.decision !== "approve") throw new HttpError(400, "Budget decision is invalid", "invalid_budget_decision");
  const approved = Number(request.body.approvedBudgetUsd);
  await repository.approveRunBudget(runId, approved);
  await enqueueResearchResume(runId);
  await repository.recordAudit(email, "run.budget_approved", { approvedBudgetUsd: approved }, runId);
  return { approved: true, run: await repository.getRun(runId) };
});

app.post<{ Body: { paused?: boolean; researchPaused?: boolean; publishingPaused?: boolean; feedbackPaused?: boolean } }>("/api/v1/owner/emergency-pause", async (request) => {
  const email = owner(request);
  const fallback = Boolean(request.body?.paused);
  const researchPaused = request.body?.researchPaused ?? fallback;
  const publishingPaused = request.body?.publishingPaused ?? fallback;
  const feedbackPaused = request.body?.feedbackPaused ?? fallback;
  await repository.setSetting("research_paused", String(Boolean(researchPaused)));
  await repository.setSetting("publishing_paused", String(Boolean(publishingPaused)));
  await repository.setSetting("feedback_paused", String(Boolean(feedbackPaused)));
  await repository.recordAudit(email, "system.pause_changed", { researchPaused, publishingPaused, feedbackPaused });
  return {
    researchPaused: Boolean(researchPaused),
    publishingPaused: Boolean(publishingPaused),
    feedbackPaused: Boolean(feedbackPaused),
  };
});

app.post<{
  Body: {
    cohortKey?: string;
    route?: "catalog_first_v2" | "corpus_first_v3";
    intentGroup?: string | null;
    disabled?: boolean;
    reasonCode?: string | null;
  };
}>("/api/v1/owner/pipeline-cohort-control", async (request) => {
  const email = owner(request);
  const cohortKey = typeof request.body?.cohortKey === "string" ? request.body.cohortKey : "";
  const route = request.body?.route;
  if (route !== "catalog_first_v2" && route !== "corpus_first_v3") {
    throw new HttpError(400, "Pipeline route is invalid", "invalid_cohort_control");
  }
  const disabled = request.body?.disabled === true;
  await repository.setPipelineCohortKillSwitch({
    cohortKey,
    route,
    intentGroup: typeof request.body?.intentGroup === "string"
      ? request.body.intentGroup
      : null,
    disabled,
    reasonCode: typeof request.body?.reasonCode === "string"
      ? request.body.reasonCode
      : null,
    changedBy: email,
  });
  await repository.recordAudit(email, "pipeline.cohort_control_changed", {
    cohortKey,
    route,
    intentGroup: request.body?.intentGroup ?? null,
    disabled,
    reasonCode: disabled ? request.body?.reasonCode ?? "owner_disabled" : null,
  });
  return { cohortKey, route, intentGroup: request.body?.intentGroup ?? null, disabled };
});

app.get("/api/v1/owner/apple/developer-token", async (request) => {
  owner(request);
  return createAppleDeveloperToken();
});

app.get("/api/v1/owner/apple/authorization", async (request) => {
  owner(request);
  const authorization = await repository.getAppleAuthorization();
  return authorization ? {
    configured: true,
    status: authorization.status,
    storefront: authorization.storefront,
    lastValidatedAt: authorization.lastValidatedAt?.toISOString() ?? null,
    lastError: authorization.lastError,
  } : { configured: false, status: "missing" };
});

app.post<{ Body: { musicUserToken?: string; storefront?: string } }>("/api/v1/owner/apple/authorization", async (request, reply) => {
  const email = owner(request);
  const musicUserToken = request.body?.musicUserToken ?? "";
  const encrypted = encryptAppleUserToken(musicUserToken, request.body?.storefront ?? "");
  const existing = await repository.getAppleAuthorization();
  const { authorization: staged, sameAuthorization } = selectAppleAuthorizationStage(
    existing,
    musicUserToken,
    encrypted,
  );
  if (sameAuthorization && existing?.status === "valid") {
    return reply.code(200).send({
      configured: true,
      status: "valid",
      storefront: existing.storefront,
      lastValidatedAt: existing.lastValidatedAt?.toISOString() ?? null,
    });
  }
  if (sameAuthorization) {
    await repository.updateAppleAuthorizationStatus("unverified", null);
  } else {
    await repository.saveAppleAuthorization(encrypted);
  }
  await repository.enqueueJob({
    kind: "apple_authorization",
    payload: { authorizationGeneration: appleAuthorizationGeneration(staged) },
    dedupeKey: appleAuthorizationJobDedupeKey(staged),
    maxAttempts: 6,
  });
  await repository.recordAudit(email, sameAuthorization ? "apple.authorization_validation_retried" : "apple.authorization_saved", {
    storefront: encrypted.storefront,
  });
  return reply.code(202).send({ configured: true, status: "unverified", storefront: encrypted.storefront });
});

app.post("/api/v1/owner/apple/authorization/validate", async (request, reply) => {
  const email = owner(request);
  const authorization = await repository.getAppleAuthorization();
  if (!authorization) {
    throw new HttpError(404, "Apple Music authorization has not been saved", "apple_authorization_missing");
  }
  if (authorization.status === "valid") {
    return {
      configured: true,
      status: "valid",
      storefront: authorization.storefront,
      lastValidatedAt: authorization.lastValidatedAt?.toISOString() ?? null,
    };
  }
  if (authorization.status === "reauthorization_required") {
    throw new HttpError(409, "Apple Music rejected the saved authorization; authorize again", "apple_reauthorization_required");
  }
  await repository.updateAppleAuthorizationStatus("unverified", null);
  const authorizationGeneration = appleAuthorizationGeneration(authorization);
  await repository.enqueueJob({
    kind: "apple_authorization",
    payload: { authorizationGeneration },
    dedupeKey: appleAuthorizationJobDedupeKey(authorization),
    maxAttempts: 6,
  });
  await repository.recordAudit(email, "apple.authorization_validation_retried", {
    storefront: authorization.storefront,
  });
  return reply.code(202).send({
    configured: true,
    status: "unverified",
    storefront: authorization.storefront,
  });
});

app.delete("/api/v1/owner/apple/authorization", async (request) => {
  const email = owner(request);
  await repository.revokeAppleAuthorization();
  await repository.recordAudit(email, "apple.authorization_revoked");
  return { configured: false, status: "missing" };
});

app.get("/api/v1/owner/publications/orphans", async (request) => {
  owner(request);
  return { items: await repository.listOrphanPlaylists() };
});

app.post<{
  Params: { id: string };
  Body: { listed?: unknown };
}>("/api/v1/owner/playlists/:id/visibility", async (request) => {
  const email = owner(request);
  const playlistId = uuid(request.params.id, "Playlist ID");
  if (typeof request.body?.listed !== "boolean") {
    throw new HttpError(400, "Playlist visibility is invalid", "invalid_playlist_visibility");
  }
  if (!await repository.setPublicPlaylistVisibility(playlistId, request.body.listed)) {
    throw new HttpError(404, "Public playlist was not found", "public_playlist_not_found");
  }
  await repository.recordAudit(email, "public_playlist.visibility_changed", {
    playlistId,
    listed: request.body.listed,
  });
  return { id: playlistId, listed: request.body.listed };
});

app.post<{ Body: unknown }>("/api/v1/owner/playlists/bulk-hide", async (request) => {
  const email = owner(request);
  const input = parseBulkHideV3(request.body);
  const hidden = await repository.bulkHidePublicPlaylists(input);
  await repository.recordAudit(email, "public_playlist.bulk_hidden", {
    scope: input.scope,
    playlistIds: input.scope === "ids" ? input.playlistIds : undefined,
    hidden,
  });
  return { hidden, scope: input.scope };
});

app.post<{ Body: { limit?: number } }>("/api/v1/owner/retention/run", async (request) => {
  const email = owner(request);
  const purged = await repository.runRetentionSweep(Number(request.body?.limit ?? 50));
  await repository.recordAudit(email, "retention.sweep", { purged });
  return { purged };
});

app.setErrorHandler((error, request, reply) => {
  const errorRecord = typeof error === "object" && error !== null ? error as { statusCode?: unknown; message?: unknown } : {};
  const hintedStatus = typeof errorRecord.statusCode === "number" ? errorRecord.statusCode : null;
  const statusCode = error instanceof HttpError
    ? error.statusCode
    : hintedStatus !== null && hintedStatus >= 400 && hintedStatus < 500
      ? hintedStatus
      : 500;
  const code = error instanceof HttpError ? error.code : statusCode === 500 ? "internal_error" : "request_error";
  if (statusCode >= 500) {
    if (process.env.NODE_ENV === "test" && process.env.GENIO_SYSTEM_E2E === "1") {
      request.log.error({ err: error, code, statusCode }, "system E2E request failed");
    } else {
      request.log.error({ code, statusCode }, "request failed; private diagnostics suppressed");
    }
  }
  else request.log.info({ code, statusCode }, "request rejected");
  const message = error instanceof HttpError
    ? error.message
    : statusCode >= 500
      ? "gênio could not complete that request"
      : "Request rejected";
  reply.code(statusCode).send({ error: message, code });
});

const port = Number(process.env.PORT ?? 8788);
await app.listen({ port, host: "::" });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await repository.close();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
