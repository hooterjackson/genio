import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  releaseCanaryAudience,
  signReleaseCanaryMetadata,
  type ReleaseCanaryCacheMode,
  type ReleaseCanaryOperation,
} from "../server/release-canary-metadata.ts";
import { stableStringify } from "../server/security.ts";
import {
  validateRuntimeSnapshot,
} from "./release-evidence.ts";
import type { ReleaseRuntimeSnapshotV1 } from "./release-runtime-snapshot.ts";
import {
  assertHostedRuntime,
} from "./hosted-publication-smoke.ts";
import {
  RELEASE_FIXTURES,
  createReleaseFixtureExecutionProof,
  releaseFixtureBindingsForGate,
  releaseFixturePrompt,
  releaseFixtureSha256,
  validateReleaseFixtureGuidancePayload,
  type ReleaseFixtureGuidanceValidationV1,
} from "./release-fixtures.ts";
import {
  emitReleaseGateProducerArtifacts,
  loadReleaseProducerRuntimeSnapshot,
  preflightReleaseProducerFiles,
  releaseProducerCandidate,
  releaseProducerOption,
  type ReleaseProducerFiles,
} from "./release-gate-producer.ts";

const CONFIRMATION_FLAG = "--confirm-live-provider";
const MAXIMUM_GUIDANCE_REVISIONS = 3;
const CANARY_DEADLINE_MS = 16 * 60_000;
const DECISION_OR_BLOCKER = new Set([
  "partial",
  "no_compatible_tracks",
  "needs_decision",
  "blocked_dependency",
  "quarantined",
  "failed",
  "failed_system",
  "failed_integrity",
]);
const TERMINAL = new Set([
  "complete",
  "partial",
  "no_compatible_tracks",
  "needs_decision",
  "blocked_dependency",
  "cancelled",
  "quarantined",
  "failed",
  "failed_system",
  "failed_integrity",
  "expired",
  "deleted",
]);

type JsonRecord = Record<string, unknown>;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTRACT_REVISION_ID = /^pcr1:[0-9a-f]{64}$/u;
const SOURCE_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export interface StagingManifestCanaryArgs {
  confirmLiveProvider: true;
  origin: string;
  fixtureId: "smooth-reggaeton-heat-50-v1";
  prompt: string;
  targetTrackCount: number;
  canaryId: string;
  expectedRevision: string;
  expectedVersion: string;
  cacheMode: ReleaseCanaryCacheMode;
  runtimeSnapshotPath: string;
  candidateTag: string;
  imageDigest: string;
  files: ReleaseProducerFiles;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function exactKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const approved = [...expected].sort();
  if (actual.length !== approved.length
    || actual.some((item, index) => item !== approved[index])) {
    throw new Error(`${label} contains missing or unapproved fields`);
  }
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value;
}

export function parseStagingManifestRuntimeSnapshot(
  value: unknown,
  expected: {
    origin: string;
    sourceRevision: string;
    version: string;
  },
): ReleaseRuntimeSnapshotV1 {
  const snapshot = validateRuntimeSnapshot(value, "staging", "full");
  const normalizedOrigin = new URL(expected.origin).origin;
  if (
    snapshot.origin !== normalizedOrigin
    || snapshot.candidate.sourceRevision !== expected.sourceRevision
    || snapshot.candidate.version !== expected.version
  ) {
    throw new Error("runtime snapshot does not match the staging candidate");
  }
  return snapshot;
}

export function validateStagingManifestCanaryEvidence(
  value: unknown,
  expected: {
    canaryId: string;
    targetTrackCount: number;
    sourceRevision: string;
    runtimeSnapshot: ReleaseRuntimeSnapshotV1;
  },
): JsonRecord {
  const evidence = record(value);
  exactKeys(evidence, [
    "schemaVersion",
    "canaryId",
    "cacheMode",
    "environment",
    "sourceRevision",
    "executionMode",
    "publicationBoundary",
    "appleWriteAccess",
    "outcome",
    "requestedTrackCount",
    "selectedTrackCount",
    "reserveTrackCount",
    "queryPlanHash",
    "queryPlanRevisionId",
    "contractRevisionDatabaseId",
    "contractRevisionId",
    "contractSemanticHash",
    "qualifiedManifestHash",
    "qualifiedReserveHash",
    "selectionValidation",
    "attempts",
    "executorIdentityHashes",
    "configurationHashes",
    "zeroWriteProof",
    "completedAt",
    "evidenceHash",
  ], "manifest canary evidence");
  const zeroWriteProof = record(evidence.zeroWriteProof);
  const selectionValidation = record(evidence.selectionValidation);
  exactKeys(zeroWriteProof, [
    "autoPublish",
    "manifestRows",
    "matchingJobs",
    "publicationJobs",
    "publicationVolumeRows",
  ], "manifest canary zero-write proof");
  exactKeys(selectionValidation, [
    "canonicalPublicationValid",
    "centralQualityRequired",
    "centralQualityPassed",
    "playlistOptimizationRequired",
    "playlistOptimizationExact",
    "usefulReserveTrackCount",
  ], "manifest canary selection validation");
  const attempts = Array.isArray(evidence.attempts)
    ? evidence.attempts.map((value, index) => {
      const attempt = record(value);
      exactKeys(attempt, [
        "stage",
        "contractRevisionDatabaseId",
        "queryPlanRevisionId",
        "executorRevision",
        "executorIdentityHash",
        "configurationHash",
        "status",
        "completedAt",
      ], `manifest canary attempt ${index}`);
      return attempt;
    })
    : [];
  const executorIdentityHashes = Array.isArray(evidence.executorIdentityHashes)
    ? evidence.executorIdentityHashes
    : [];
  const configurationHashes = Array.isArray(evidence.configurationHashes)
    ? evidence.configurationHashes
    : [];
  const reserveTrackCount = Number(evidence.reserveTrackCount);
  const allowedWorkerConfigurationHashes = new Set([
    expected.runtimeSnapshot.configuration.interactiveWorkerHash,
    expected.runtimeSnapshot.configuration.deepWorkerHash,
  ]);
  if (
    evidence.schemaVersion !== "genio-release-manifest-canary-evidence/v1"
    || evidence.canaryId !== expected.canaryId
    || evidence.cacheMode !== "reuse_disabled"
    || evidence.environment !== "staging"
    || evidence.sourceRevision !== expected.sourceRevision
    || evidence.executionMode !== "shadow"
    || evidence.publicationBoundary !== "database_fenced"
    || evidence.appleWriteAccess !== "forbidden"
    || evidence.outcome !== "exact_ready"
    || Number(evidence.requestedTrackCount) !== expected.targetTrackCount
    || Number(evidence.selectedTrackCount) !== expected.targetTrackCount
    || !Number.isSafeInteger(reserveTrackCount)
    || reserveTrackCount < 0
    || !UUID.test(String(evidence.queryPlanRevisionId))
    || !UUID.test(String(evidence.contractRevisionDatabaseId))
    || !CONTRACT_REVISION_ID.test(String(evidence.contractRevisionId))
    || attempts.length < 1
    || executorIdentityHashes.length !== 1
    || configurationHashes.length !== 1
    || !allowedWorkerConfigurationHashes.has(String(configurationHashes[0]))
    || zeroWriteProof.autoPublish !== false
    || Number(zeroWriteProof.manifestRows) !== 0
    || Number(zeroWriteProof.matchingJobs) !== 0
    || Number(zeroWriteProof.publicationJobs) !== 0
    || Number(zeroWriteProof.publicationVolumeRows) !== 0
    || selectionValidation.canonicalPublicationValid !== true
    || typeof selectionValidation.centralQualityRequired !== "boolean"
    || (selectionValidation.centralQualityRequired
      ? selectionValidation.centralQualityPassed !== true
      : selectionValidation.centralQualityPassed !== null)
    || typeof selectionValidation.playlistOptimizationRequired !== "boolean"
    || (selectionValidation.playlistOptimizationRequired
      ? selectionValidation.playlistOptimizationExact !== true
      : selectionValidation.playlistOptimizationExact !== null)
    || Number(selectionValidation.usefulReserveTrackCount) !== reserveTrackCount
  ) {
    throw new Error("Manifest-only canary returned invalid release evidence");
  }
  for (const [key, item] of Object.entries({
    queryPlanHash: evidence.queryPlanHash,
    contractSemanticHash: evidence.contractSemanticHash,
    qualifiedManifestHash: evidence.qualifiedManifestHash,
    qualifiedReserveHash: evidence.qualifiedReserveHash,
  })) digest(item, `manifest canary ${key}`);
  digest(executorIdentityHashes[0], "manifest canary executor identity");
  digest(configurationHashes[0], "manifest canary configuration");
  isoTimestamp(evidence.completedAt, "manifest canary completedAt");
  for (const attempt of attempts) {
    if (
      attempt.stage === ""
      || attempt.contractRevisionDatabaseId !== evidence.contractRevisionDatabaseId
      || attempt.queryPlanRevisionId !== evidence.queryPlanRevisionId
      || attempt.executorRevision !== evidence.sourceRevision
      || attempt.executorIdentityHash !== executorIdentityHashes[0]
      || attempt.configurationHash !== configurationHashes[0]
      || attempt.status !== "complete"
      || !SOURCE_REVISION.test(String(attempt.executorRevision))
    ) {
      throw new Error("Manifest-only canary attempt proof is incoherent");
    }
    isoTimestamp(attempt.completedAt, "manifest canary attempt completedAt");
  }
  const evidenceHash = digest(evidence.evidenceHash, "manifest canary evidenceHash");
  const unsigned = { ...evidence };
  delete unsigned.evidenceHash;
  if (createHash("sha256").update(stableStringify(unsigned)).digest("hex")
    !== evidenceHash) {
    throw new Error("Manifest-only canary evidence hash is invalid");
  }
  return evidence;
}

export function validateStagingManifestGuidanceExecution(
  resultValue: unknown,
  expected: ReleaseFixtureGuidanceValidationV1,
): string {
  const result = record(resultValue);
  const executionProof = record(result.executionProof);
  const lineage = Array.isArray(executionProof.guidanceLineage)
    ? executionProof.guidanceLineage.map(record)
    : [];
  if (lineage.length !== 1) {
    throw new Error("Manifest canary did not execute exactly one typed guidance revision");
  }
  const observed = lineage[0]!;
  const affectedClauseIds = Array.isArray(observed.affectedClauseIds)
    ? observed.affectedClauseIds.filter((value): value is string => typeof value === "string")
      .sort()
    : [];
  if (
    observed.questionSetHash !== expected.questionSetHash
    || observed.executionDeltaHash !== expected.executionDeltaHash
    || !SHA256.test(String(observed.baseContractHash ?? ""))
    || !SHA256.test(String(observed.resultingContractHash ?? ""))
    || isoTimestamp(observed.acceptedAt, "manifest canary guidance acceptedAt")
      !== observed.acceptedAt
    || stableStringify(affectedClauseIds)
      !== stableStringify([...expected.affectedClauseIds].sort())
  ) {
    throw new Error("Manifest canary guidance did not reach the active contract");
  }
  return releaseFixtureSha256(lineage);
}

export function parseStagingManifestCanaryArgs(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): StagingManifestCanaryArgs {
  const allowed = new Set([
    CONFIRMATION_FLAG,
    "--origin",
    "--fixture-id",
    "--candidate-tag",
    "--expected-revision",
    "--expected-version",
    "--image-digest",
    "--cache-mode",
    "--runtime-snapshot",
    "--source-output",
    "--output",
    "--attestation-output",
    "--producer-signing-key",
    "--producer-key-id",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!allowed.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    if (argument !== CONFIRMATION_FLAG) index += 1;
  }
  if (argv.filter((value) => value === CONFIRMATION_FLAG).length !== 1) {
    throw new Error(`Live-provider manifest canaries require ${CONFIRMATION_FLAG}`);
  }
  const fixtureId = releaseProducerOption(argv, "--fixture-id");
  if (fixtureId !== "smooth-reggaeton-heat-50-v1") {
    throw new Error(
      "--fixture-id must be smooth-reggaeton-heat-50-v1 for the staging provider manifest gate",
    );
  }
  if (releaseProducerOption(argv, "--cache-mode") !== "reuse_disabled") {
    throw new Error("--cache-mode must be reuse_disabled");
  }
  const expectedRevision = releaseProducerOption(argv, "--expected-revision").toLowerCase();
  const expectedVersion = releaseProducerOption(argv, "--expected-version");
  const candidateTag = releaseProducerOption(argv, "--candidate-tag");
  const imageDigest = releaseProducerOption(argv, "--image-digest");
  releaseProducerCandidate({
    tag: candidateTag,
    version: expectedVersion,
    sourceRevision: expectedRevision,
    imageDigest,
  });
  const configuredOrigin = environment.RELEASE_STAGING_ORIGIN?.trim() ?? "";
  if (!configuredOrigin) {
    throw new Error("RELEASE_STAGING_ORIGIN is required for staging canaries");
  }
  let parsedOrigin: URL;
  let allowedOrigin: string;
  try {
    parsedOrigin = new URL(releaseProducerOption(argv, "--origin"));
    allowedOrigin = releaseCanaryAudience(configuredOrigin);
  } catch {
    throw new Error("--origin must be a dedicated staging HTTPS origin");
  }
  if (
    parsedOrigin.protocol !== "https:"
    || parsedOrigin.username
    || parsedOrigin.password
    || parsedOrigin.pathname !== "/"
    || parsedOrigin.search
    || parsedOrigin.hash
    || parsedOrigin.hostname === "9enio.com"
    || parsedOrigin.hostname === "www.9enio.com"
  ) {
    throw new Error("--origin must be a dedicated non-production HTTPS origin");
  }
  if (parsedOrigin.origin !== allowedOrigin) {
    throw new Error("--origin must exactly match RELEASE_STAGING_ORIGIN");
  }
  const fixture = RELEASE_FIXTURES[fixtureId];
  return {
    confirmLiveProvider: true,
    origin: parsedOrigin.origin,
    fixtureId,
    prompt: releaseFixturePrompt(fixtureId),
    targetTrackCount: fixture.targetTrackCount,
    canaryId: `staging-provider-manifest-${fixture.fixtureHash.slice(0, 12)}`,
    expectedRevision,
    expectedVersion,
    cacheMode: "reuse_disabled",
    runtimeSnapshotPath: releaseProducerOption(argv, "--runtime-snapshot"),
    candidateTag,
    imageDigest,
    files: {
      sourceOutputPath: releaseProducerOption(argv, "--source-output"),
      artifactOutputPath: releaseProducerOption(argv, "--output"),
      attestationOutputPath: releaseProducerOption(argv, "--attestation-output"),
      producerSigningKeyPath: releaseProducerOption(argv, "--producer-signing-key"),
      producerKeyId: releaseProducerOption(argv, "--producer-key-id"),
    },
  };
}

function capabilityCookie(setCookie: string | null, current: string): string {
  if (!setCookie) return current;
  for (const name of ["__Host-needle-session", "needle-session"]) {
    const match = setCookie.match(new RegExp(`(?:^|,\\s*)(${name}=[^;,\\s]+)`, "u"));
    if (match?.[1]) return match[1];
  }
  return current;
}

async function request(
  origin: string,
  path: string,
  init: RequestInit = {},
  cookie = "",
  acceptedErrorStatuses: readonly number[] = [],
  deadlineAt = Number.POSITIVE_INFINITY,
): Promise<{ payload: JsonRecord; cookie: string; status: number }> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new Error("Manifest-only canary exceeded its overall deadline");
  }
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, remainingMs))),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? record(await response.json().catch(() => ({})))
    : {};
  if (!response.ok && !acceptedErrorStatuses.includes(response.status)) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : typeof payload.message === "string"
        ? payload.message
        : `gênio returned HTTP ${response.status}`,
    );
  }
  return {
    payload,
    cookie: capabilityCookie(response.headers.get("set-cookie"), cookie),
    status: response.status,
  };
}

function canaryMetadata(input: {
  canaryId: string;
  cacheMode: ReleaseCanaryCacheMode;
  operation: ReleaseCanaryOperation;
  sourceRevision: string;
  audience: string;
}) {
  const secret = process.env.RELEASE_CANARY_HMAC_SECRET?.trim() ?? "";
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("RELEASE_CANARY_HMAC_SECRET is required for staging canaries");
  }
  return signReleaseCanaryMetadata({
    version: "genio-release-canary/v1",
    canaryId: input.canaryId,
    environment: "staging",
    audience: input.audience,
    operation: input.operation,
    sourceRevision: input.sourceRevision,
    issuedAt: new Date().toISOString(),
    cacheMode: input.cacheMode,
  }, secret);
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const args = parseStagingManifestCanaryArgs(process.argv.slice(2));
  await preflightReleaseProducerFiles(args.files);
  const deadlineAt = Date.now() + CANARY_DEADLINE_MS;
  const candidate = releaseProducerCandidate({
    tag: args.candidateTag,
    version: args.expectedVersion,
    sourceRevision: args.expectedRevision,
    imageDigest: args.imageDigest,
  });
  const assertDeadline = (): void => {
    if (Date.now() >= deadlineAt) {
      throw new Error("Manifest-only canary exceeded its overall deadline");
    }
  };
  const canaryRequest = (
    path: string,
    init: RequestInit = {},
    cookie = "",
    acceptedErrorStatuses: readonly number[] = [],
  ) => {
    assertDeadline();
    return request(
      args.origin,
      path,
      init,
      cookie,
      acceptedErrorStatuses,
      deadlineAt,
    );
  };
  const canaryWait = async (ms: number): Promise<void> => {
    assertDeadline();
    if (Date.now() + ms >= deadlineAt) {
      throw new Error("Manifest-only canary exceeded its overall deadline");
    }
    await wait(ms);
  };
  const runtimeSnapshot = await loadReleaseProducerRuntimeSnapshot({
    path: args.runtimeSnapshotPath,
    environment: "staging",
    origin: args.origin,
    candidate,
  });
  const live = await canaryRequest("/health/live");
  assertHostedRuntime(
    live.payload,
    args.expectedRevision,
    args.expectedVersion,
    "staging",
    runtimeSnapshot.configuration.apiHash,
  );

  const briefKey = `manifest-canary-brief-${randomUUID()}`;
  let briefCookie = "";
  let brief = await canaryRequest("/api/v1/brief", {
    method: "POST",
    headers: { "Idempotency-Key": briefKey },
    body: JSON.stringify({
      prompt: args.prompt,
      targetTrackCount: args.targetTrackCount,
      idempotencyKey: briefKey,
      releaseCanary: canaryMetadata({
        canaryId: args.canaryId,
        cacheMode: args.cacheMode,
        operation: "brief",
        sourceRevision: args.expectedRevision,
        audience: args.origin,
      }),
    }),
  });
  briefCookie = brief.cookie;
  const briefRequestId = String(brief.payload.requestId ?? "");
  if (!briefRequestId) throw new Error("gênio did not return a brief request ID");
  const answeredQuestionSets = new Set<string>();
  let fixtureGuidancePayload: {
    questionSetHash: string;
    questions: import("../shared/types.ts").PlaylistGuidanceQuestion[];
  } | null = null;
  let fixtureGuidanceValidation: ReleaseFixtureGuidanceValidationV1 | null = null;
  for (let attempt = 0; brief.payload.status !== "complete" && attempt < 160; attempt += 1) {
    if (brief.payload.status === "failed") throw new Error("Brief interpretation failed");
    if (brief.payload.status === "awaiting_answers") {
      if (fixtureGuidancePayload) {
        throw new Error("Manifest canary requested an unapproved second guidance axis");
      }
      const guidancePayload = {
        questionSetHash: String(brief.payload.questionSetHash ?? ""),
        questions: Array.isArray(brief.payload.questions)
          ? brief.payload.questions as import("../shared/types.ts").PlaylistGuidanceQuestion[]
          : [],
      };
      const validation = validateReleaseFixtureGuidancePayload(
        args.fixtureId,
        guidancePayload,
      );
      const submission = {
        questionSetHash: validation.questionSetHash,
        answers: [{
          questionId: guidancePayload.questions[0]!.id,
          optionId: validation.selectedOptionId,
        }],
      };
      if (answeredQuestionSets.has(submission.questionSetHash)
        || answeredQuestionSets.size >= MAXIMUM_GUIDANCE_REVISIONS) {
        throw new Error("Manifest canary exceeded its bounded guidance revisions");
      }
      const answerKey = `manifest-canary-answer-${randomUUID()}`;
      answeredQuestionSets.add(submission.questionSetHash);
      const answered = await canaryRequest(
        `/api/v1/brief/${encodeURIComponent(briefRequestId)}/answers`,
        {
          method: "POST",
          headers: { "Idempotency-Key": answerKey },
          body: JSON.stringify({
            answers: submission.answers,
            questionSetHash: submission.questionSetHash,
            idempotencyKey: answerKey,
          }),
        },
        briefCookie,
        [409],
      );
      briefCookie = answered.cookie;
      if (answered.status === 409) {
        if (answered.payload.code !== "stale_guidance_question_set") {
          throw new Error("Manifest canary guidance submission failed closed");
        }
        brief = {
          ...answered,
          payload: {
            ...answered.payload,
            status: "awaiting_answers",
          },
        };
        continue;
      }
      brief = answered;
      fixtureGuidancePayload = guidancePayload;
      fixtureGuidanceValidation = validation;
      continue;
    }
    await canaryWait(attempt < 20 ? 1_500 : 5_000);
    brief = await canaryRequest(
      `/api/v1/brief/${encodeURIComponent(briefRequestId)}`,
      {},
      briefCookie,
    );
    briefCookie = brief.cookie;
  }
  if (brief.payload.status !== "complete" || !brief.payload.brief) {
    throw new Error("Brief interpretation did not complete inside the canary window");
  }
  if (!fixtureGuidancePayload || !fixtureGuidanceValidation) {
    throw new Error("Manifest canary completed without the required typed guidance");
  }

  const runKey = `manifest-canary-run-${randomUUID()}`;
  const started = await canaryRequest("/api/v1/runs", {
    method: "POST",
    headers: { "Idempotency-Key": runKey },
    body: JSON.stringify({
      briefRequestId,
      brief: brief.payload.brief,
      idempotencyKey: runKey,
      manifestOnly: true,
      releaseCanary: canaryMetadata({
        canaryId: args.canaryId,
        cacheMode: args.cacheMode,
        operation: "run",
        sourceRevision: args.expectedRevision,
        audience: args.origin,
      }),
    }),
  }, briefCookie);
  const initialRun = record(started.payload.run ?? started.payload);
  const accessId = String(initialRun.id ?? "");
  const capability = String(started.payload.capability ?? started.payload.capabilityToken ?? "");
  if (!accessId || !capability) throw new Error("gênio did not return scoped run access");
  const exchanged = await canaryRequest("/api/v1/capabilities/exchange", {
    method: "POST",
    body: JSON.stringify({ token: capability }),
  });
  let cookie = exchanged.cookie;
  if (!cookie) throw new Error("gênio did not establish scoped run access");

  let run = initialRun;
  for (let attempt = 0; attempt < 180 && !TERMINAL.has(String(run.status)); attempt += 1) {
    if (DECISION_OR_BLOCKER.has(String(run.status))) {
      throw new Error("Manifest-only canary entered a decision or blocker state");
    }
    await canaryWait(5_000);
    const polled = await canaryRequest(
      `/api/v1/runs/${encodeURIComponent(accessId)}`,
      {},
      cookie,
    );
    cookie = polled.cookie;
    run = record(polled.payload.run ?? polled.payload);
    if (DECISION_OR_BLOCKER.has(String(run.status))) {
      throw new Error("Manifest-only canary entered a decision or blocker state");
    }
  }
  if (run.status !== "complete" || run.phase !== "v3_shadow_exact_ready") {
    throw new Error(
      `Manifest-only canary did not reach an exact qualified result (${String(run.status)}/${String(run.phase)})`,
    );
  }
  const resultResponse = await canaryRequest(
    `/api/v1/runs/${encodeURIComponent(accessId)}/result`,
    {},
    cookie,
  );
  cookie = resultResponse.cookie;
  const guidanceLineageHash = validateStagingManifestGuidanceExecution(
    resultResponse.payload,
    fixtureGuidanceValidation,
  );
  let evidenceValue: unknown = null;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const evidenceResponse = await canaryRequest(
      `/api/v1/runs/${encodeURIComponent(accessId)}/manifest-canary-evidence`,
      {},
      cookie,
      [409],
    );
    cookie = evidenceResponse.cookie;
    if (evidenceResponse.status === 200) {
      evidenceValue = evidenceResponse.payload;
      break;
    }
    if (evidenceResponse.status !== 409
      || evidenceResponse.payload.code !== "release_manifest_canary_incomplete") {
      throw new Error("Manifest-only canary evidence endpoint failed closed");
    }
    await canaryWait(2_500);
  }
  if (!evidenceValue) {
    throw new Error("Manifest-only canary evidence remained incomplete");
  }
  const evidence = validateStagingManifestCanaryEvidence(evidenceValue, {
    canaryId: args.canaryId,
    targetTrackCount: args.targetTrackCount,
    sourceRevision: args.expectedRevision,
    runtimeSnapshot,
  });
  const report = {
    schemaVersion: "genio-staging-manifest-canary/v1",
    candidate: {
      version: args.expectedVersion,
      sourceRevision: args.expectedRevision,
    },
    runtimeSnapshotHash: runtimeSnapshot.snapshotHash,
    evidence,
  };
  const typedReport = {
    ...report,
    evidenceHash: createHash("sha256").update(stableStringify(report)).digest("hex"),
  };
  const fixtures = releaseFixtureBindingsForGate("staging_provider_manifest", {
    [args.fixtureId]: guidanceLineageHash,
  });
  const fixtureExecution = createReleaseFixtureExecutionProof({
    fixtureId: args.fixtureId,
    guidanceLineageHash,
    guidancePayload: fixtureGuidancePayload,
  });
  assertDeadline();
  const produced = await emitReleaseGateProducerArtifacts({
    gate: "staging_provider_manifest",
    completedAt: new Date().toISOString(),
    candidate,
    runtimeSnapshot,
    fixtures,
    sources: {
      manifestCanary: typedReport,
      fixtureExecution,
    },
    files: args.files,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    fixtureId: args.fixtureId,
    gate: produced.artifact.gate,
    reportEvidenceHash: typedReport.evidenceHash,
    gateEvidenceHash: produced.artifact.evidenceHash,
    producerKeyId: produced.attestation.signature.keyId,
  }, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "staging_manifest_canary_failed",
      message: "Staging manifest canary failed closed",
    })}\n`);
    process.exitCode = 1;
  });
}
