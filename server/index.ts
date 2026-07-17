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
import { Repository } from "./repository.ts";
import { HttpError, sha256Hex, stableStringify } from "./security.ts";
import type { PlaylistBrief } from "../shared/types.ts";
import {
  PUBLIC_FAST_RESEARCH_BUDGET_USD,
  PUBLIC_PLAYLIST_DEFAULT_TRACKS,
  PUBLIC_PLAYLIST_MAXIMUM_TRACKS,
  PUBLIC_PLAYLIST_MINIMUM_TRACKS,
  publicRunBudgetUsd,
} from "../shared/product-policy.ts";
import {
  canonicalBriefForRequest,
  estimateResearchCost,
  estimateResearchCostRange,
  isPlaylistBrief,
  materialAmbiguitiesAccepted,
} from "./brief-policy.ts";
import { researchResumeJob, type ResearchResumeCheckpoint } from "./research-resume.ts";
import {
  briefInterpretationModel,
  parseFastRouteCheckpoint,
  researchExecutionPolicy,
} from "./research-policy.ts";
import { DATABASE_SCHEMA_VERSION } from "../db/index.ts";
import { appleAuthorizationGeneration, appleAuthorizationJobDedupeKey } from "./apple.ts";
import { initialApprovedBudgetUsd, readCostConfiguration } from "./cost-config.ts";
import { buildInformation } from "./build-info.ts";
import { WORKER_PIPELINE_PROTOCOL_VERSION } from "./worker-protocol.ts";
import {
  FEEDBACK_BODY_BYTES,
  parseFeedbackKind,
  parseFeedbackStatus,
  parseFeedbackSubmission,
} from "./feedback.ts";
import { positiveIntegerQuery } from "./api-validation.ts";

const MAX_BODY_BYTES = 64 * 1024;
const BULK_SELECTION_BODY_BYTES = 1024 * 1024;
const costConfiguration = readCostConfiguration();
const repository = new Repository();
const capabilities = new CapabilityService(repository);
const verifyGateway = createGatewayVerifier(repository);
const gatewayIdentities = new WeakMap<FastifyRequest, GatewayIdentity>();

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

async function requireWorkerForNewWork(): Promise<void> {
  const required = process.env.REQUIRE_WORKER_HEARTBEAT === "true" || process.env.NODE_ENV === "production";
  if (!required) return;
  const health = await repository.getSystemHealth();
  if (health.worker.stale || !health.worker.schemaCompatible || !health.worker.protocolCompatible) {
    throw new HttpError(503, "Research worker is temporarily unavailable", "worker_unavailable");
  }
}

async function assertNotPaused(kind: "research" | "publishing" | "feedback"): Promise<void> {
  if (await repository.getSetting(`${kind}_paused`) === "true") {
    const label = kind === "research" ? "Research" : kind === "publishing" ? "Publishing" : "Feedback";
    throw new HttpError(503, `${label} is temporarily paused`, `${kind}_paused`);
  }
}

async function enqueueResearchResume(runId: string): Promise<void> {
  const [run, saved] = await Promise.all([
    repository.getRun(runId),
    repository.getResearchCheckpoint(runId, "resume") as Promise<ResearchResumeCheckpoint | null>,
  ]);
  const policy = researchExecutionPolicy(run.brief);
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
  const build = buildInformation();
  return { ok: true, service: "needle-api", version: build.version, revision: build.revision, build };
});

app.get("/health/ready", async (_request, reply) => {
  const ok = await repository.ping();
  const schemaVersion = ok ? await repository.getSchemaVersion() : null;
  if (!ok || schemaVersion !== DATABASE_SCHEMA_VERSION) return reply.code(503).send({ ok: false, database: ok, schemaVersion });
  return { ok: true, database: true, schemaVersion };
});

app.get("/health/system", async (_request, reply) => {
  try {
    const health = await repository.getSystemHealth();
    const schemaVersion = health.database.schemaVersion;
    const ok = schemaVersion === DATABASE_SCHEMA_VERSION
      && !health.worker.stale
      && health.worker.schemaCompatible
      && health.worker.protocolCompatible;
    return reply.code(ok ? 200 : 503).send({
      ok,
      database: schemaVersion === DATABASE_SCHEMA_VERSION ? "ready" : "schema_mismatch",
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
        actual: health.worker.protocolVersion ?? null,
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
  const health = await repository.getSystemHealth();
  return {
    ok: !health.worker.stale && health.worker.schemaCompatible && health.worker.protocolCompatible,
    worker: {
      stale: health.worker.stale,
      schemaCompatible: health.worker.schemaCompatible,
      protocolCompatible: health.worker.protocolCompatible,
      protocolVersion: health.worker.protocolVersion ?? null,
      expectedProtocolVersion: WORKER_PIPELINE_PROTOCOL_VERSION,
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
  });
  return reply.code(result.created ? 201 : 200).send({ received: true, id: result.id });
});

app.post<{ Body: { prompt?: string; targetTrackCount?: number; idempotencyKey?: string } }>("/api/v1/brief", async (request, reply) => {
  await assertNotPaused("research");
  await requireWorkerForNewWork();
  const caller = identity(request);
  const prompt = request.body?.prompt?.trim() ?? "";
  // Anonymous work is always an exact bounded One Command request. An owner
  // may intentionally omit the control to enter the explicit deep path.
  const targetTrackCount = request.body?.targetTrackCount
    ?? (isOwner(caller) ? undefined : PUBLIC_PLAYLIST_DEFAULT_TRACKS);
  if (targetTrackCount !== undefined && (
    !Number.isInteger(targetTrackCount)
    || targetTrackCount < PUBLIC_PLAYLIST_MINIMUM_TRACKS
    || targetTrackCount > PUBLIC_PLAYLIST_MAXIMUM_TRACKS
  )) {
    throw new HttpError(
      400,
      `Track count must be an integer from ${PUBLIC_PLAYLIST_MINIMUM_TRACKS} to ${PUBLIC_PLAYLIST_MAXIMUM_TRACKS}`,
      "invalid_track_count",
    );
  }
  const key = request.body?.idempotencyKey ? idempotencyKey(request, request.body.idempotencyKey) : undefined;
  const created = await repository.createBriefRequest({
    prompt,
    requestedTrackCount: targetTrackCount ?? null,
    model: briefInterpretationModel(),
    clientBucket: caller.clientBucket,
    clientBucketAliases: caller.clientBucketAliases,
    idempotencyKey: key,
    bypassVisitorRateLimit: isOwner(caller),
  });
  await capabilities.authorizeBrief(request, reply, created.id);
  if (created.status === "queued") {
    await repository.enqueueJob({ kind: "brief", briefRequestId: created.id, payload: { briefRequestId: created.id }, dedupeKey: `brief:${created.id}` });
  }
  return reply.code(created.created ? 202 : 200).send({ requestId: created.id, status: created.status, pollAfterMs: 1_500 });
});

app.get<{ Params: { id: string } }>("/api/v1/brief/:id", async (request, reply) => {
  const briefRequestId = uuid(request.params.id, "Brief request ID");
  await capabilities.authenticateForBrief(request, briefRequestId);
  const brief = await repository.getBriefRequest(briefRequestId);
  if (!brief) return reply.code(404).send({ error: "Brief request not found", code: "brief_not_found" });
  const canonicalBrief = brief.status === "complete" && isPlaylistBrief(brief.brief)
    ? canonicalBriefForRequest(brief, brief.brief)
    : ["awaiting_answers", "finalizing"].includes(brief.status) && isPlaylistBrief(brief.brief)
      ? canonicalBriefForRequest(brief, brief.brief)
    : undefined;
  return {
    requestId: brief.id,
    prompt: brief.prompt,
    requestedTrackCount: brief.requestedTrackCount,
    status: brief.status,
    brief: canonicalBrief,
    questions: Array.isArray(brief.questions) ? brief.questions : [],
    answers: Array.isArray(brief.answers) && brief.answers.length > 0 ? brief.answers : undefined,
    estimateUsd: canonicalBrief ? estimateResearchCost(canonicalBrief) : undefined,
    estimate: canonicalBrief ? estimateResearchCostRange(canonicalBrief) : undefined,
    error: brief.status === "failed" ? brief.error : undefined,
  };
});

app.post<{
  Params: { id: string };
  Body: {
    answers?: Array<{ questionId?: string; optionId?: string; customText?: string }>;
    idempotencyKey?: string;
  };
}>("/api/v1/brief/:id/answers", async (request, reply) => {
  const briefRequestId = uuid(request.params.id, "Brief request ID");
  await capabilities.authenticateForBrief(request, briefRequestId);
  await assertNotPaused("research");
  await requireWorkerForNewWork();
  if (!Array.isArray(request.body?.answers)) {
    throw new HttpError(400, "Playlist answers are required", "invalid_guidance_answers");
  }
  const key = idempotencyKey(request, request.body?.idempotencyKey);
  const submitted = await repository.submitBriefAnswers({
    briefRequestId,
    idempotencyKey: key,
    answers: request.body.answers.map((answer) => ({
      questionId: typeof answer.questionId === "string" ? answer.questionId : "",
      ...(typeof answer.optionId === "string" ? { optionId: answer.optionId } : {}),
      ...(typeof answer.customText === "string" ? { customText: answer.customText } : {}),
    })),
  });
  if (submitted.status === "finalizing") {
    // Also repair a crash after the durable answer transaction but before the
    // queue handoff when an identical idempotent request is repeated.
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

app.post<{ Body: { briefRequestId?: string; brief?: PlaylistBrief; idempotencyKey?: string } }>("/api/v1/runs", async (request, reply) => {
  await assertNotPaused("research");
  await requireWorkerForNewWork();
  const caller = identity(request);
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
  const brief = canonicalBriefForRequest(interpreted, interpreted.brief, submittedBrief);
  const confirmedEstimateUsd = estimateResearchCost(brief);
  if (!isOwner(caller)) {
    if (interpreted.requestedTrackCount === null) {
      throw new HttpError(409, "A public playlist requires an exact track count", "brief_not_ready");
    }
    const policy = researchExecutionPolicy(brief);
    if (
      policy.kind !== "fast_curated"
      || brief.targetSize?.min !== interpreted.requestedTrackCount
      || brief.targetSize?.max !== interpreted.requestedTrackCount
      || confirmedEstimateUsd > PUBLIC_FAST_RESEARCH_BUDGET_USD
    ) {
      throw new HttpError(409, "The public playlist scope exceeds the bounded research profile", "brief_not_ready");
    }
  }
  const automaticOneCommand = interpreted.requestedTrackCount !== null;
  if (!automaticOneCommand && !materialAmbiguitiesAccepted(brief, interpreted.brief.ambiguities)) {
    throw new HttpError(
      409,
      "Accept every material scope assumption before research",
      "ambiguities_unresolved",
    );
  }
  const key = idempotencyKey(request, request.body?.idempotencyKey);
  const briefActualCostUsd = await repository.getBriefActualCostUsd(briefRequestId);
  const publicRunBudget = publicRunBudgetUsd(confirmedEstimateUsd, briefActualCostUsd);
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
    autoPublish: interpreted.requestedTrackCount !== null,
    capabilitySessionId: briefSession.id,
    bypassVisitorRateLimit: isOwner(caller),
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

app.get("/api/v1/owner/status", async (request) => {
  owner(request);
  const health = await repository.getSystemHealth();
  return {
    ok: !health.worker.stale && health.worker.schemaCompatible && health.worker.protocolCompatible,
    paused: health.paused.research || health.paused.publishing || health.paused.feedback,
    database: "ready",
    worker: health.worker.worker_id
      ? health.worker.stale || !health.worker.schemaCompatible || !health.worker.protocolCompatible
        ? "stale"
        : "healthy"
      : "missing",
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
  if (statusCode >= 500) request.log.error({ code, statusCode }, "request failed; private diagnostics suppressed");
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
