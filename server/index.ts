import Fastify, { type FastifyRequest } from "fastify";
import { CapabilityService, type CapabilitySessionView } from "./capabilities.ts";
import { createGatewayVerifier, type GatewayIdentity } from "./gateway-auth.ts";
import { createAppleDeveloperToken, assertOwner, encryptAppleUserToken, isOwner } from "./owner.ts";
import { parseOwnerCatalogImport, unverifiedImportedCandidates } from "./catalog-import.ts";
import { Repository } from "./repository.ts";
import { HttpError, sha256Hex, stableStringify } from "./security.ts";
import type { PlaylistBrief } from "../shared/types.ts";
import {
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

async function sessionForAccess(request: FastifyRequest, accessId: string): Promise<CapabilitySessionView> {
  return capabilities.authenticateForAccess(request, accessId);
}

async function requireWorkerForNewWork(): Promise<void> {
  const required = process.env.REQUIRE_WORKER_HEARTBEAT === "true" || process.env.NODE_ENV === "production";
  if (!required) return;
  const health = await repository.getSystemHealth();
  if (health.worker.stale || !health.worker.schemaCompatible) {
    throw new HttpError(503, "Research worker is temporarily unavailable", "worker_unavailable");
  }
}

async function assertNotPaused(kind: "research" | "publishing"): Promise<void> {
  if (await repository.getSetting(`${kind}_paused`) === "true") {
    throw new HttpError(503, `${kind === "research" ? "Research" : "Publishing"} is temporarily paused`, `${kind}_paused`);
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
      && health.worker.schemaCompatible;
    return reply.code(ok ? 200 : 503).send({
      ok,
      database: schemaVersion === DATABASE_SCHEMA_VERSION ? "ready" : "schema_mismatch",
      worker: health.worker.worker_id
        ? health.worker.stale
          ? "stale"
          : health.worker.schemaCompatible
            ? "healthy"
            : "schema_mismatch"
        : "missing",
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
    ok: !health.worker.stale && health.worker.schemaCompatible,
    worker: { stale: health.worker.stale, schemaCompatible: health.worker.schemaCompatible },
    paused: health.paused,
    queue: health.queue,
    notifications: { pending: health.notificationBacklog, failed: health.notificationFailures },
    publicationFailures: health.publicationFailures,
    retention: health.retention,
  };
});

app.post<{ Body: { prompt?: string; idempotencyKey?: string } }>("/api/v1/brief", async (request, reply) => {
  await assertNotPaused("research");
  await requireWorkerForNewWork();
  const caller = identity(request);
  const prompt = request.body?.prompt?.trim() ?? "";
  const key = request.body?.idempotencyKey ? idempotencyKey(request, request.body.idempotencyKey) : undefined;
  const created = await repository.createBriefRequest({
    prompt,
    model: briefInterpretationModel(),
    clientBucket: caller.clientBucket,
    clientBucketAliases: caller.clientBucketAliases,
    idempotencyKey: key,
    bypassVisitorRateLimit: isOwner(caller),
  });
  if (created.created) {
    await repository.enqueueJob({ kind: "brief", briefRequestId: created.id, payload: { briefRequestId: created.id }, dedupeKey: `brief:${created.id}` });
  }
  return reply.code(created.created ? 202 : 200).send({ requestId: created.id, status: created.status, pollAfterMs: 1_500 });
});

app.get<{ Params: { id: string } }>("/api/v1/brief/:id", async (request, reply) => {
  const brief = await repository.getBriefRequest(uuid(request.params.id, "Brief request ID"));
  if (!brief) return reply.code(404).send({ error: "Brief request not found", code: "brief_not_found" });
  if (!identity(request).clientBucketAliases.includes(brief.clientBucket)) {
    return reply.code(404).send({ error: "Brief request not found", code: "brief_not_found" });
  }
  return {
    requestId: brief.id,
    status: brief.status,
    brief: brief.status === "complete" ? brief.brief : undefined,
    estimateUsd: brief.status === "complete" ? brief.estimateUsd : undefined,
    estimate: brief.status === "complete" && isPlaylistBrief(brief.brief)
      ? estimateResearchCostRange(brief.brief)
      : undefined,
    error: brief.status === "failed" ? brief.error : undefined,
  };
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
  const interpreted = await repository.getBriefRequest(briefRequestId);
  if (!interpreted || interpreted.status !== "complete" || !isPlaylistBrief(interpreted.brief)) {
    throw new HttpError(409, "Playlist scope is not ready to confirm", "brief_not_ready");
  }
  if (!caller.clientBucketAliases.includes(interpreted.clientBucket)) {
    throw new HttpError(404, "Brief request not found", "brief_not_found");
  }
  const brief = request.body?.brief ?? interpreted.brief;
  if (!isPlaylistBrief(brief)) throw new HttpError(400, "Confirmed playlist brief is invalid", "invalid_brief");
  if (!materialAmbiguitiesAccepted(brief, interpreted.brief.ambiguities)) {
    throw new HttpError(
      409,
      "Accept every material scope assumption before research",
      "ambiguities_unresolved",
    );
  }
  const confirmedEstimateUsd = estimateResearchCost(brief);
  const key = idempotencyKey(request, request.body?.idempotencyKey);
  const currentSession = await capabilities.authenticateOptional(request);
  const created = await repository.createRunIdempotent({
    prompt: interpreted.prompt,
    brief,
    estimateUsd: confirmedEstimateUsd,
    approvedBudgetUsd: initialApprovedBudgetUsd(confirmedEstimateUsd),
    clientBucket: caller.clientBucket,
    clientBucketAliases: caller.clientBucketAliases,
    idempotencyKey: key,
    capabilitySessionId: currentSession?.id,
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
  return repository.listExceptions(session.runId, Number(request.query.page ?? 1), Number(request.query.pageSize ?? 20));
});

app.get<{ Params: { id: string }; Querystring: { page?: string; pageSize?: string } }>("/api/v1/runs/:id/tracks", async (request) => {
  const accessId = uuid(request.params.id, "Run ID");
  const session = await sessionForAccess(request, accessId);
  return repository.listCatalogTracks(
    session.runId,
    Number(request.query.page ?? 1),
    Number(request.query.pageSize ?? 200),
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
  return repository.getEvidenceReport(session.runId, Number(request.query.page ?? 1), Number(request.query.pageSize ?? 50));
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
    ok: !health.worker.stale,
    paused: health.paused.research || health.paused.publishing,
    database: "ready",
    worker: health.worker.worker_id ? health.worker.stale ? "stale" : "healthy" : "missing",
    apple: {
      configured: health.apple.status !== "missing",
      authorized: health.apple.status === "valid",
      storefront: health.apple.storefront ?? null,
      validatedAt: health.apple.lastValidatedAt ?? null,
      needsReauthorization: health.apple.status === "reauthorization_required",
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

app.post<{ Body: { paused?: boolean; researchPaused?: boolean; publishingPaused?: boolean } }>("/api/v1/owner/emergency-pause", async (request) => {
  const email = owner(request);
  const fallback = Boolean(request.body?.paused);
  const researchPaused = request.body?.researchPaused ?? fallback;
  const publishingPaused = request.body?.publishingPaused ?? fallback;
  await repository.setSetting("research_paused", String(Boolean(researchPaused)));
  await repository.setSetting("publishing_paused", String(Boolean(publishingPaused)));
  await repository.recordAudit(email, "system.pause_changed", { researchPaused, publishingPaused });
  return { researchPaused: Boolean(researchPaused), publishingPaused: Boolean(publishingPaused) };
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
  const encrypted = encryptAppleUserToken(request.body?.musicUserToken ?? "", request.body?.storefront ?? "");
  await repository.saveAppleAuthorization(encrypted);
  await repository.enqueueJob({
    kind: "apple_authorization",
    payload: { authorizationGeneration: appleAuthorizationGeneration(encrypted) },
    dedupeKey: appleAuthorizationJobDedupeKey(encrypted),
  });
  await repository.recordAudit(email, "apple.authorization_saved", { storefront: encrypted.storefront });
  return reply.code(202).send({ configured: true, status: "unverified", storefront: encrypted.storefront });
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
      ? "Needle could not complete that request"
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
