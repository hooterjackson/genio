import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  releaseCanaryAudience,
  signReleaseCanaryMetadata,
  type ReleaseCanaryCacheMode,
  type ReleaseCanaryEnvironment,
  type ReleaseCanaryOperation,
} from "../server/release-canary-metadata.ts";
import { stableStringify } from "../server/security.ts";
import { independentAppleReleaseEvidence } from "./independent-apple-release-verifier.ts";
import {
  RELEASE_FIXTURES,
  createReleaseFixtureExecutionProof,
  releaseFixtureBindingsForGate,
  releaseFixturePrompt,
  releaseFixtureSha256,
  validateReleaseFixtureGuidancePayload,
  type ReleaseFixtureGuidanceValidationV1,
  type ReleaseFixtureId,
  type ReleaseGateName,
} from "./release-fixtures.ts";
import {
  collectIrishInfluenceReleaseProofV1,
} from "./irish-influence-release-proof-producer.ts";
import {
  emitReleaseGateProducerArtifacts,
  loadReleaseProducerRuntimeSnapshot,
  preflightReleaseProducerFiles,
  releaseProducerCandidate,
  releaseProducerOption,
  type ReleaseProducerFiles,
} from "./release-gate-producer.ts";

const CONFIRMATION_FLAG = "--confirm-live-write";
const REQUEST_TIMEOUT_MS = 20_000;
const SMOKE_DEADLINE_MS = 20 * 60_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TERMINAL_RUN_STATUSES = new Set([
  "complete",
  "partial",
  "no_compatible_tracks",
  "cancelled",
  "failed",
  "failed_system",
  "failed_integrity",
  "expired",
  "deleted",
]);
const NON_EXACT_DECISION_STATES = new Set([
  "blocked_dependency",
  "needs_decision",
  "needs_input",
  "quarantined",
]);
const REVIEW_RUN_STATUSES = new Set(["review", "visitor_review"]);
const MAX_GUIDANCE_REVISIONS = 3;
const GUIDANCE_MODES = [
  "recommended",
  "alternate",
  "custom",
  "skipped",
] as const;
export type HostedGuidanceMode = typeof GUIDANCE_MODES[number];

export interface SmokeArgs {
  confirmLiveWrite: true;
  origin: string;
  fixtureId: ReleaseFixtureId;
  gate: Extract<ReleaseGateName,
    | "staging_fixed_three_track"
    | "staging_affected_regression"
    | "staging_guided_constraint"
    | "production_fixed_three_track"
    | "production_affected_regression">;
  prompt: string;
  targetTrackCount: number;
  canaryId: string;
  expectedRevision: string;
  expectedVersion: string;
  environment: ReleaseCanaryEnvironment;
  cacheMode: ReleaseCanaryCacheMode;
  runtimeSnapshotScope: "backend" | "full";
  runtimeSnapshotPath: string;
  candidateTag: string;
  imageDigest: string;
  irishRecoveryAccessId: string | null;
  irishRecoveryCookie: string | null;
  ownerBrowserCookie: string | null;
  productionDatabaseUrl: string | null;
  files: ReleaseProducerFiles;
}

type ApiResponse = Record<string, unknown>;
export type HostedGuidanceAnswer = {
  questionId: string;
  optionId?: string;
  customText?: string;
  skipped?: true;
};
export type ExpectedHostedGuidanceExecution = {
  questionSetHash: string;
  executionDeltaHash: string;
};

export interface OwnerUiPublicationEvidenceV1 {
  schemaVersion: "genio-owner-ui-publication/v1";
  exercised: true;
  publishRequestObserved: true;
  publishResponseStatus: number;
  selectedTrackCount: number;
  completedUiVisible: true;
  directoryEntryVisible: true;
  runAccessIdHash: string;
  screenshotHash: string;
  evidenceHash: string;
}

function asRecord(value: unknown): ApiResponse {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ApiResponse
    : {};
}

export function parseHostedSmokeArgs(
  argv: readonly string[],
  releaseOrigins: NodeJS.ProcessEnv = process.env,
): SmokeArgs {
  const allowed = new Set([
    CONFIRMATION_FLAG,
    "--origin",
    "--fixture-id",
    "--candidate-tag",
    "--expected-revision",
    "--expected-version",
    "--image-digest",
    "--environment",
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
    throw new Error(`Hosted publication smoke tests require ${CONFIRMATION_FLAG}`);
  }
  const fixtureId = releaseProducerOption(argv, "--fixture-id");
  if (!(fixtureId in RELEASE_FIXTURES)) {
    throw new Error("--fixture-id must identify a code-owned promotable release fixture");
  }
  const typedFixtureId = fixtureId as ReleaseFixtureId;
  const environmentValue = releaseProducerOption(argv, "--environment");
  if (environmentValue !== "staging" && environmentValue !== "production") {
    throw new Error("--environment must be staging or production");
  }
  const environment = environmentValue as ReleaseCanaryEnvironment;
  const gateByFixture = {
    staging: {
      "fixed-three-track-control-v1": "staging_fixed_three_track",
      "smooth-reggaeton-heat-50-v1": "staging_affected_regression",
      "french-jazz-guided-constraint-25-v1": "staging_guided_constraint",
      "irish-influence-recovery-25-v1": null,
    },
    production: {
      "fixed-three-track-control-v1": "production_fixed_three_track",
      "smooth-reggaeton-heat-50-v1": null,
      "french-jazz-guided-constraint-25-v1": null,
      "irish-influence-recovery-25-v1": "production_affected_regression",
    },
  } as const;
  const gate = gateByFixture[environment][typedFixtureId];
  if (!gate) {
    throw new Error("the selected fixture is not an approved production publication gate");
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
  const releaseOriginName = environment === "staging"
    ? "RELEASE_STAGING_ORIGIN"
    : "RELEASE_PRODUCTION_ORIGIN";
  const configuredOrigin = releaseOrigins[releaseOriginName]?.trim() ?? "";
  if (!configuredOrigin) {
    throw new Error(`${releaseOriginName} is required for hosted canaries`);
  }
  let allowedOrigin: string;
  try {
    allowedOrigin = releaseCanaryAudience(configuredOrigin);
  } catch {
    throw new Error(`${releaseOriginName} must be an HTTPS origin with no path, query, or credentials`);
  }
  let parsed: URL;
  try {
    const explicitOrigin = argv.includes("--origin")
      ? releaseProducerOption(argv, "--origin")
      : allowedOrigin;
    parsed = new URL(explicitOrigin);
  } catch {
    throw new Error("--origin must be an HTTPS origin with no path, query, or credentials");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("--origin must be an HTTPS origin with no path, query, or credentials");
  }
  if (
    environment === "staging"
    && (parsed.hostname === "9enio.com" || parsed.hostname === "www.9enio.com")
  ) {
    throw new Error("staging canaries require a dedicated non-production origin");
  }
  if (parsed.origin !== allowedOrigin) {
    throw new Error(`--origin must exactly match ${releaseOriginName}`);
  }
  const fixture = RELEASE_FIXTURES[typedFixtureId];
  const irishRecoveryAccessId =
    releaseOrigins.RELEASE_IRISH_RECOVERY_ACCESS_ID?.trim() ?? null;
  const irishRecoveryCookie =
    releaseOrigins.RELEASE_IRISH_RECOVERY_COOKIE?.trim() ?? null;
  const productionDatabaseUrl =
    releaseOrigins.RELEASE_PRODUCTION_DATABASE_URL?.trim() ?? null;
  const ownerBrowserCookie =
    releaseOrigins.RELEASE_OWNER_BROWSER_COOKIE?.trim() ?? null;
  if (
    typedFixtureId === "irish-influence-recovery-25-v1"
      ? (
          !irishRecoveryAccessId
          || !UUID.test(irishRecoveryAccessId)
          || !irishRecoveryCookie
          || !ownerBrowserCookie
          || !/^[^=;\s]+=[^;\r\n]+(?:;\s*[^=;\s]+=[^;\r\n]+)*$/u
            .test(ownerBrowserCookie)
          || !productionDatabaseUrl
        )
      : (
          irishRecoveryAccessId !== null
          || irishRecoveryCookie !== null
          || ownerBrowserCookie !== null
          || productionDatabaseUrl !== null
        )
  ) {
    throw new Error(
      typedFixtureId === "irish-influence-recovery-25-v1"
        ? "the Irish production regression requires protected durable recovery DB/API selectors"
        : "Irish recovery DB/API selectors are accepted only for the Irish production regression",
    );
  }
  const canaryId = `${gate}-${fixture.fixtureHash.slice(0, 12)}`;
  return {
    confirmLiveWrite: true,
    origin: parsed.origin,
    fixtureId: typedFixtureId,
    gate,
    prompt: releaseFixturePrompt(typedFixtureId),
    targetTrackCount: fixture.targetTrackCount,
    canaryId,
    expectedRevision,
    expectedVersion,
    environment,
    cacheMode: "reuse_disabled",
    runtimeSnapshotScope:
      environment === "staging"
        || gate === "production_fixed_three_track"
        || gate === "production_affected_regression"
        ? "full"
        : "backend",
    runtimeSnapshotPath: releaseProducerOption(argv, "--runtime-snapshot"),
    candidateTag,
    imageDigest,
    irishRecoveryAccessId,
    irishRecoveryCookie,
    ownerBrowserCookie,
    productionDatabaseUrl,
    files: {
      sourceOutputPath: releaseProducerOption(argv, "--source-output"),
      artifactOutputPath: releaseProducerOption(argv, "--output"),
      attestationOutputPath: releaseProducerOption(argv, "--attestation-output"),
      producerSigningKeyPath: releaseProducerOption(argv, "--producer-signing-key"),
      producerKeyId: releaseProducerOption(argv, "--producer-key-id"),
    },
  };
}

function validGuidanceQuestions(payload: unknown): Array<{
  id: string;
  criticality: unknown;
  allowCustom: unknown;
  options: Array<{ id: string; recommended: boolean }>;
}> {
  const record = asRecord(payload);
  const questions = Array.isArray(record.questions) ? record.questions.map(asRecord) : [];
  if (questions.length < 1 || questions.length > 3) {
    throw new Error("gênio requested guidance without returning 1–3 valid questions");
  }
  const questionIds = new Set<string>();
  return questions.map((question) => {
    if (typeof question.id !== "string" || !question.id.trim()) {
      throw new Error("A guidance question has no valid ID");
    }
    const questionId = question.id.trim();
    if (questionIds.has(questionId)) {
      throw new Error("A guidance question ID is repeated");
    }
    questionIds.add(questionId);
    const options = Array.isArray(question.options) ? question.options.map(asRecord) : [];
    if (options.length < 2 || options.length > 4) {
      throw new Error("A guidance question does not contain 2–4 options");
    }
    const optionIds = new Set<string>();
    const validOptions = options.map((option) => {
      const optionId = typeof option.id === "string" ? option.id.trim() : "";
      if (!optionId || optionIds.has(optionId)) {
        throw new Error("A guidance question contains an invalid or repeated option ID");
      }
      optionIds.add(optionId);
      return { id: optionId, recommended: option.recommended === true };
    });
    const recommended = validOptions.filter((option) => option.recommended);
    if (recommended.length !== 1) {
      throw new Error("A guidance question does not contain exactly one recommendation");
    }
    return {
      id: questionId,
      criticality: question.criticality,
      allowCustom: question.allowCustom,
      options: validOptions,
    };
  });
}

export function hostedGuidanceAnswers(
  payload: unknown,
  mode: HostedGuidanceMode = "recommended",
  customText: string | null = null,
): HostedGuidanceAnswer[] {
  if (!GUIDANCE_MODES.includes(mode)) {
    throw new Error("Hosted guidance mode is invalid");
  }
  const questions = validGuidanceQuestions(payload);
  if (mode === "custom") {
    const normalizedCustomText = customText?.trim() ?? "";
    if (!normalizedCustomText
      || Array.from(normalizedCustomText).length > 500
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalizedCustomText)) {
      throw new Error("Custom hosted guidance must contain 1–500 printable characters");
    }
    if (questions.length !== 1) {
      throw new Error(
        "The custom hosted guidance fixture requires exactly one question axis",
      );
    }
    return questions.map((question) => {
      if (question.allowCustom !== true) {
        throw new Error(`Guidance question ${question.id} does not support a custom answer`);
      }
      return { questionId: question.id, customText: normalizedCustomText };
    });
  }
  if (customText?.trim()) {
    throw new Error("Custom hosted guidance text is accepted only in custom mode");
  }
  if (mode === "skipped") {
    return questions.map((question) => {
      if (question.criticality !== "optional") {
        throw new Error(`Required guidance question ${question.id} cannot be skipped`);
      }
      return { questionId: question.id, skipped: true };
    });
  }
  return questions.map((question) => {
    const option = mode === "recommended"
      ? question.options.find((candidate) => candidate.recommended)
      : question.options.find((candidate) => !candidate.recommended);
    if (!option) {
      throw new Error(`Guidance question ${question.id} does not contain a valid ${mode} option`);
    }
    return { questionId: question.id, optionId: option.id };
  });
}

export function hostedGuidanceSubmission(
  payload: unknown,
  mode: HostedGuidanceMode = "recommended",
  customText: string | null = null,
): {
  questionSetHash: string;
  answers: HostedGuidanceAnswer[];
} {
  const record = asRecord(payload);
  const questionSetHash = typeof record.questionSetHash === "string"
    ? record.questionSetHash.trim().toLowerCase()
    : "";
  if (!/^[0-9a-f]{64}$/u.test(questionSetHash)) {
    throw new Error("gênio requested guidance without a valid question-set hash");
  }
  return {
    questionSetHash,
    answers: hostedGuidanceAnswers(payload, mode, customText),
  };
}

export function hostedGuidanceFixtureForRevision(
  mode: HostedGuidanceMode,
  customText: string | null,
  customAnswerAccepted: boolean,
): { mode: HostedGuidanceMode; customText: string | null } {
  // Custom prose is never executable. After the first custom answer the
  // server returns a typed confirmation revision; apply its recommended
  // server-owned option instead of trying to submit the prose a second time.
  if (mode === "custom" && customAnswerAccepted) {
    return { mode: "recommended", customText: null };
  }
  return {
    mode,
    customText: mode === "custom" ? customText : null,
  };
}

export function recommendedGuidanceAnswers(payload: unknown): Array<{ questionId: string; optionId: string }> {
  return hostedGuidanceAnswers(payload, "recommended").map((answer) => ({
    questionId: answer.questionId,
    optionId: String(answer.optionId),
  }));
}

export function recommendedGuidanceSubmission(payload: unknown): {
  questionSetHash: string;
  answers: Array<{ questionId: string; optionId: string }>;
} {
  const submission = hostedGuidanceSubmission(payload, "recommended");
  return {
    questionSetHash: submission.questionSetHash,
    answers: submission.answers.map((answer) => ({
      questionId: answer.questionId,
      optionId: String(answer.optionId),
    })),
  };
}

export function recordNewGuidanceQuestionSet(
  seenQuestionSets: Set<string>,
  questionSetHash: string,
  maximumRevisions = MAX_GUIDANCE_REVISIONS,
): void {
  if (seenQuestionSets.has(questionSetHash)) {
    throw new Error("gênio returned a guidance revision that the smoke test already answered");
  }
  if (seenQuestionSets.size >= maximumRevisions) {
    throw new Error(`gênio exceeded the ${maximumRevisions}-revision hosted guidance safety limit`);
  }
  seenQuestionSets.add(questionSetHash);
}

export function expectedHostedGuidanceExecution(
  payload: unknown,
  submission: {
    questionSetHash: string;
    answers: readonly HostedGuidanceAnswer[];
  },
): ExpectedHostedGuidanceExecution {
  const questions = Array.isArray(asRecord(payload).questions)
    ? (asRecord(payload).questions as unknown[]).map(asRecord)
    : [];
  const byId = new Map(questions.map((question) => [String(question.id ?? ""), question]));
  const operations = submission.answers.flatMap((answer) => {
    if (!answer.optionId) return [];
    const question = byId.get(answer.questionId);
    const options = Array.isArray(question?.options)
      ? (question.options as unknown[]).map(asRecord)
      : [];
    const option = options.find((candidate) => candidate.id === answer.optionId);
    const contractPatch = asRecord(option?.contractPatch);
    if (!Array.isArray(contractPatch.operations)) {
      throw new Error("Selected hosted guidance option has no executable contract patch");
    }
    return contractPatch.operations;
  });
  return {
    questionSetHash: submission.questionSetHash,
    executionDeltaHash: createHash("sha256")
      .update(stableStringify(operations))
      .digest("hex"),
  };
}

function appleShareUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname === "music.apple.com";
  } catch {
    return false;
  }
}

export function assertHostedPublication(
  runValue: unknown,
  resultValue: unknown,
  targetTrackCount: number,
  expectedRevision: string,
  expectedWorkerConfigurationHashes: readonly string[],
  expectedGuidance: readonly ExpectedHostedGuidanceExecution[] = [],
): void {
  const run = asRecord(runValue);
  const result = asRecord(resultValue);
  if (run.status !== "complete") {
    throw new Error(`Hosted publication smoke test ended with status ${String(run.status)}`);
  }
  if (result.status !== "complete") {
    throw new Error(`Hosted publication result ended with status ${String(result.status)}`);
  }
  if (run.error || result.error) throw new Error("Hosted publication completed with a retained run error");
  const manifest = asRecord(result.manifest);
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    throw new Error("Published manifest has no playlist name");
  }
  if (typeof manifest.contentHash !== "string" || !/^[0-9a-f]{64}$/u.test(manifest.contentHash)) {
    throw new Error("Published manifest has no immutable content hash");
  }
  if (Number(manifest.trackCount ?? result.totalTracks ?? 0) !== targetTrackCount) {
    throw new Error(
      `Published manifest contains ${String(manifest.trackCount ?? result.totalTracks ?? 0)} tracks instead of ${targetTrackCount}`,
    );
  }
  if (Number(result.totalTracks ?? 0) !== targetTrackCount) {
    throw new Error(`Published result contains ${String(result.totalTracks ?? 0)} tracks instead of ${targetTrackCount}`);
  }
  if (Number(result.completedTracks ?? 0) !== targetTrackCount) {
    throw new Error(
      `Apple publication completed ${String(result.completedTracks ?? 0)} tracks instead of ${targetTrackCount}`,
    );
  }
  const volumes = Array.isArray(result.volumes) ? result.volumes.map(asRecord) : [];
  if (volumes.length === 0) throw new Error("Apple publication returned no playlist volumes");
  if (volumes.some((volume) => volume.status !== "complete")) {
    throw new Error("Apple publication returned an incomplete playlist volume");
  }
  if (volumes.some((volume) => !appleShareUrl(volume.shareUrl))) {
    throw new Error("Apple publication did not return a valid public Apple Music link for every volume");
  }
  const playlistIds = new Set<string>();
  const shareUrls = new Set<string>();
  let nextPosition = 0;
  for (const [offset, volume] of volumes.entries()) {
    const trackCount = Number(volume.trackCount ?? 0);
    if (Number(volume.index ?? volume.volumeNumber) !== offset + 1
      || Number(volume.total ?? volume.volumeCount) !== volumes.length
      || Number(volume.startPosition) !== nextPosition
      || Number(volume.endPosition) !== nextPosition + trackCount - 1) {
      throw new Error("Apple publication volumes do not form the exact ordered manifest range");
    }
    const playlistId = typeof volume.playlistId === "string" ? volume.playlistId.trim() : "";
    const shareUrl = typeof volume.shareUrl === "string" ? volume.shareUrl : "";
    if (!playlistId || playlistIds.has(playlistId) || shareUrls.has(shareUrl)) {
      throw new Error("Apple publication volumes do not have unique stable identities");
    }
    playlistIds.add(playlistId);
    shareUrls.add(shareUrl);
    nextPosition += trackCount;
  }
  const volumeTrackCount = volumes.reduce((sum, volume) => sum + Number(volume.trackCount ?? 0), 0);
  const appendedTrackCount = volumes.reduce((sum, volume) => sum + Number(volume.appendedCount ?? 0), 0);
  if (volumeTrackCount !== targetTrackCount || appendedTrackCount !== targetTrackCount) {
    throw new Error("Apple publication volume counts do not match the approved manifest");
  }
  const executionProof = asRecord(result.executionProof);
  const attempts = Array.isArray(executionProof.attempts)
    ? executionProof.attempts.map(asRecord)
    : [];
  const activeQueryPlanRevisionId = String(
    executionProof.queryPlanRevisionId ?? "",
  );
  const allowedConfigurationHashes = new Set(
    expectedWorkerConfigurationHashes,
  );
  if (allowedConfigurationHashes.size < 1
    || [...allowedConfigurationHashes].some(
      (value) => !/^[0-9a-f]{64}$/u.test(value),
    )) {
    throw new Error("Hosted publication has no trusted runtime worker configuration binding");
  }
  if (attempts.length === 0) {
    throw new Error("Hosted publication returned no contract-fenced worker execution proof");
  }
  if (attempts.some((attempt) => (
    String(attempt.executorRevision ?? "").toLowerCase() !== expectedRevision
    || !/^[0-9a-f]{64}$/u.test(String(attempt.executorIdentityHash ?? ""))
    || !allowedConfigurationHashes.has(String(attempt.configurationHash ?? ""))
    || !UUID.test(activeQueryPlanRevisionId)
    || attempt.queryPlanRevisionId !== activeQueryPlanRevisionId
    || typeof attempt.stage !== "string"
    || !attempt.stage
    || attempt.status !== "complete"
    || typeof attempt.completedAt !== "string"
    || !Number.isFinite(Date.parse(attempt.completedAt))
  ))) {
    throw new Error("Hosted publication lacks completed execution by the promoted worker artifact");
  }
  if (!/^[0-9a-f]{64}$/u.test(String(executionProof.contractHash ?? ""))) {
    throw new Error("Hosted publication returned no immutable contract proof");
  }
  if (!/^[0-9a-f]{64}$/u.test(String(executionProof.answerLineageHash ?? ""))) {
    throw new Error("Hosted publication returned no immutable answer-lineage proof");
  }
  const guidanceLineage = Array.isArray(executionProof.guidanceLineage)
    ? executionProof.guidanceLineage.map(asRecord)
    : [];
  if (
    guidanceLineage.length !== expectedGuidance.length
    || expectedGuidance.some((expected) => !guidanceLineage.some((observed) => (
      observed.questionSetHash === expected.questionSetHash
      && observed.executionDeltaHash === expected.executionDeltaHash
      && /^[0-9a-f]{64}$/u.test(String(observed.baseContractHash ?? ""))
      && /^[0-9a-f]{64}$/u.test(String(observed.resultingContractHash ?? ""))
      && Array.isArray(observed.affectedClauseIds)
      && typeof observed.acceptedAt === "string"
      && Number.isFinite(Date.parse(observed.acceptedAt))
    )))
  ) {
    throw new Error("Hosted guidance did not reach the active contract exactly as selected");
  }
  const reconciliation = asRecord(executionProof.publicationReconciliation);
  if (reconciliation.state !== "complete"
    || reconciliation.orderedIdsVerified !== true
    || Number(reconciliation.expectedCount) !== targetTrackCount
    || Number(reconciliation.appendedCount) !== targetTrackCount
    || reconciliation.expectedOrderedIdsHash !== reconciliation.observedOrderedIdsHash
    || !/^[0-9a-f]{64}$/u.test(String(reconciliation.expectedOrderedIdsHash ?? ""))) {
    throw new Error("Apple did not return the exact ordered IDs from the immutable manifest");
  }
}

export function assertHostedRuntime(
  livePayload: unknown,
  expectedRevision: string,
  expectedVersion: string,
  expectedEnvironment: ReleaseCanaryEnvironment,
  expectedApiConfigurationHash: string,
): void {
  const live = asRecord(livePayload);
  const build = asRecord(live.build);
  const runtime = asRecord(live.runtime);
  if (String(build.revision ?? "").toLowerCase() !== expectedRevision) {
    throw new Error("Hosted API revision does not match the promoted artifact");
  }
  if (build.version !== expectedVersion) {
    throw new Error("Hosted API version does not match the promoted artifact");
  }
  if (
    !/^[0-9a-f]{64}$/u.test(expectedApiConfigurationHash)
    || live.configurationHash !== expectedApiConfigurationHash
  ) {
    throw new Error(
      "Hosted API configuration does not match the signed runtime snapshot",
    );
  }
  const required = {
    releaseEnvironment: expectedEnvironment,
    deploymentPhase: "activate",
    expectedDatabaseSchemaVersion: "20",
    canonicalActivationConfigured: "true",
    proofArchitectureMode: "native",
    proofArchitectureVersion: "1",
    schemaVersion: "20",
    schemaMaximum: "20",
    schemaPreferred: "19",
    workerProtocol: "playlist-pipeline-v12",
    queryPlanSchemaVersion: "6",
    briefContractVersion: "3",
  };
  for (const [key, value] of Object.entries(required)) {
    if (String(runtime[key] ?? "") !== value) {
      throw new Error(`Hosted runtime ${key} does not match the release contract`);
    }
  }
}

export function hostedPublicationEvidence(
  resultValue: unknown,
  targetTrackCount: number,
  canaryId: string,
  cacheMode: ReleaseCanaryCacheMode = "reuse_disabled",
  independentAppleEvidenceHash?: string,
  expectedWorkerConfigurationHashes: readonly string[] = [],
  ownerUiPublication: OwnerUiPublicationEvidenceV1 | null = null,
): Record<string, unknown> {
  const result = asRecord(resultValue);
  const manifest = asRecord(result.manifest);
  const volumes = Array.isArray(result.volumes) ? result.volumes.map(asRecord) : [];
  const executionProof = asRecord(result.executionProof);
  const attempts = Array.isArray(executionProof.attempts)
    ? executionProof.attempts.map(asRecord)
    : [];
  const reconciliation = asRecord(executionProof.publicationReconciliation);
  const activeQueryPlanRevisionId = String(
    executionProof.queryPlanRevisionId ?? "",
  );
  const allowedConfigurationHashes = new Set(
    expectedWorkerConfigurationHashes,
  );
  if (
    !UUID.test(activeQueryPlanRevisionId)
    || allowedConfigurationHashes.size < 1
    || [...allowedConfigurationHashes].some(
      (value) => !/^[0-9a-f]{64}$/u.test(value),
    )
    || attempts.some((attempt) => (
      attempt.queryPlanRevisionId !== activeQueryPlanRevisionId
      || !allowedConfigurationHashes.has(String(attempt.configurationHash ?? ""))
    ))
  ) {
    throw new Error(
      "Hosted publication attempts do not bind the active query plan and runtime worker configuration",
    );
  }
  const evidence = {
    schemaVersion: "genio-hosted-publication-smoke/v2",
    canaryId,
    cacheMode,
    targetTrackCount,
    manifestContentHash: manifest.contentHash,
    contractHash: executionProof.contractHash,
    answerLineageHash: executionProof.answerLineageHash,
    queryPlanRevisionHash: createHash("sha256")
      .update(activeQueryPlanRevisionId)
      .digest("hex"),
    guidanceLineageHash: createHash("sha256")
      .update(stableStringify(executionProof.guidanceLineage ?? []))
      .digest("hex"),
    guidanceRevisionCount: Array.isArray(executionProof.guidanceLineage)
      ? executionProof.guidanceLineage.length
      : 0,
    executorRevisions: [...new Set(attempts.map((attempt) => attempt.executorRevision))].sort(),
    executorIdentityHashes: [...new Set(
      attempts.map((attempt) => attempt.executorIdentityHash),
    )].sort(),
    configurationHashes: [...new Set(
      attempts.map((attempt) => attempt.configurationHash),
    )].sort(),
    completedAttemptCount: attempts.filter((attempt) => (
      attempt.status === "complete"
      && typeof attempt.completedAt === "string"
      && Number.isFinite(Date.parse(attempt.completedAt))
    )).length,
    allAttemptsComplete: attempts.length > 0 && attempts.every((attempt) => (
      attempt.status === "complete"
      && typeof attempt.completedAt === "string"
      && Number.isFinite(Date.parse(attempt.completedAt))
    )),
    serverReportedOrderedAppleReconciliation: reconciliation.orderedIdsVerified === true
      && reconciliation.expectedOrderedIdsHash === reconciliation.observedOrderedIdsHash
      && Number(reconciliation.expectedCount) === targetTrackCount,
    orderedAppleIdsHash: reconciliation.observedOrderedIdsHash,
    ownerUiPublication,
    ...(independentAppleEvidenceHash === undefined
      ? {}
      : /^[0-9a-f]{64}$/u.test(independentAppleEvidenceHash)
        ? { independentAppleEvidenceHash }
        : (() => {
          throw new Error("Independent Apple evidence hash is invalid");
        })()),
    volumes: volumes.map((volume) => ({
      index: volume.index ?? volume.volumeNumber,
      trackCount: volume.trackCount,
      appendedCount: volume.appendedCount,
      shareUrl: volume.shareUrl,
    })),
  };
  return {
    ...evidence,
    evidenceHash: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
  };
}

function releaseCanaryMetadata(input: {
  canaryId: string;
  environment: ReleaseCanaryEnvironment;
  audience: string;
  operation: ReleaseCanaryOperation;
  sourceRevision: string;
  cacheMode: ReleaseCanaryCacheMode;
}): ReturnType<typeof signReleaseCanaryMetadata> {
  const secret = process.env.RELEASE_CANARY_HMAC_SECRET?.trim() ?? "";
  if (!secret) throw new Error("RELEASE_CANARY_HMAC_SECRET is required for hosted canaries");
  return signReleaseCanaryMetadata({
    version: "genio-release-canary/v1",
    ...input,
    issuedAt: new Date().toISOString(),
  }, secret);
}

function safeMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const object = payload as Record<string, unknown>;
    if (typeof object.error === "string") return object.error;
    if (typeof object.message === "string") return object.message;
  }
  return `gênio returned HTTP ${status}`;
}

function scopedCapabilityCookie(setCookie: string | null, current: string): string {
  const cookies = new Map<string, string>();
  for (const item of current.split(/;\s*/u)) {
    const separator = item.indexOf("=");
    if (separator > 0) {
      cookies.set(item.slice(0, separator), item.slice(separator + 1));
    }
  }
  if (!setCookie) {
    return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  for (const name of ["__Host-needle-session", "needle-session"]) {
    const match = setCookie.match(new RegExp(`(?:^|,\\s*)(${name}=[^;,\\s]+)`, "u"));
    if (match?.[1]) {
      const separator = match[1].indexOf("=");
      cookies.set(
        match[1].slice(0, separator),
        match[1].slice(separator + 1),
      );
    }
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function request(
  origin: string,
  path: string,
  init: RequestInit = {},
  cookie = "",
  allowedStatuses: readonly number[] = [],
  deadlineAt = Number.POSITIVE_INFINITY,
): Promise<{ payload: ApiResponse; cookie: string; status: number }> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new Error("Hosted publication smoke exceeded its bounded deadline");
  }
  const timeoutSignal = AbortSignal.timeout(Math.max(
    1,
    Math.min(REQUEST_TIMEOUT_MS, remainingMs),
  ));
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers,
    redirect: "error",
    signal,
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => ({})) as ApiResponse
    : { text: await response.text().catch(() => "") };
  if (!response.ok && !allowedStatuses.includes(response.status)) {
    throw new Error(safeMessage(payload, response.status));
  }
  const setCookie = response.headers.get("set-cookie");
  const nextCookie = scopedCapabilityCookie(setCookie, cookie);
  return { payload, cookie: nextCookie, status: response.status };
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function browserCookies(
  origin: string,
  cookieHeader: string,
): Array<{
  name: string;
  value: string;
  url: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax";
}> {
  return cookieHeader.split(/;\s*/u).flatMap((item) => {
    const separator = item.indexOf("=");
    if (separator < 1) return [];
    return [{
      name: item.slice(0, separator),
      value: item.slice(separator + 1),
      url: origin,
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
    }];
  });
}

export async function publishOwnerCanaryThroughRealUi(input: {
  origin: string;
  accessId: string;
  cookie: string;
  targetTrackCount: number;
  artifactDirectory: string;
  deadlineAt: number;
}): Promise<OwnerUiPublicationEvidenceV1> {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: false,
      storageState: { cookies: [], origins: [] },
    });
    const cookies = browserCookies(input.origin, input.cookie);
    if (cookies.length < 1) {
      throw new Error("Protected owner browser cookie is unavailable");
    }
    await context.addCookies(cookies);
    const directRailwayRequests: string[] = [];
    context.on("request", (request) => {
      const hostname = new URL(request.url()).hostname.toLocaleLowerCase(
        "en-US",
      );
      if (
        hostname === "railway.app"
        || hostname.endsWith(".railway.app")
        || hostname.endsWith(".up.railway.app")
      ) {
        directRailwayRequests.push(request.url());
      }
    });
    const page = await context.newPage();
    const navigation = await page.goto(
      `${input.origin}/?run=${encodeURIComponent(input.accessId)}&release-owner-publication=1`,
      {
        waitUntil: "domcontentloaded",
        timeout: Math.max(
          1,
          Math.min(60_000, input.deadlineAt - Date.now()),
        ),
      },
    );
    if (!navigation || navigation.status() !== 200) {
      throw new Error("Owner publication UI did not load");
    }
    const publishResponsePromise = page.waitForResponse(
      (response) => (
        response.request().method() === "POST"
        && response.url() ===
          `${input.origin}/api/v1/runs/${
            encodeURIComponent(input.accessId)
          }/publish`
      ),
      {
        timeout: Math.max(
          1,
          Math.min(5 * 60_000, input.deadlineAt - Date.now()),
        ),
      },
    );
    const continueButton = page.getByRole("button", {
      name: new RegExp(
        `^CONTINUE WITH ${input.targetTrackCount.toLocaleString("en-US")}`,
        "iu",
      ),
    });
    const publishButton = page.getByRole("button", {
      name: /PUBLISH TO APPLE MUSIC/iu,
    });
    await Promise.race([
      continueButton.waitFor({
        state: "visible",
        timeout: Math.max(
          1,
          Math.min(90_000, input.deadlineAt - Date.now()),
        ),
      }),
      publishButton.waitFor({
        state: "visible",
        timeout: Math.max(
          1,
          Math.min(90_000, input.deadlineAt - Date.now()),
        ),
      }),
    ]);
    if (await continueButton.isVisible()) {
      await continueButton.click();
    } else {
      await publishButton.click();
    }
    const publishResponse = await publishResponsePromise;
    if (![200, 201, 202].includes(publishResponse.status())) {
      throw new Error("Owner publication UI received a non-success response");
    }
    const completedHeading = page.getByRole("heading", {
      name: "Playlist published",
      exact: true,
    });
    await completedHeading.waitFor({
      state: "visible",
      timeout: Math.max(
        1,
        Math.min(10 * 60_000, input.deadlineAt - Date.now()),
      ),
    });
    const result = await page.evaluate(async (accessId) => {
      const response = await fetch(
        `/api/v1/runs/${encodeURIComponent(accessId)}/result`,
        { cache: "no-store", credentials: "same-origin" },
      );
      return {
        status: response.status,
        value: await response.json().catch(() => ({})),
      };
    }, input.accessId);
    const resultPayload = asRecord(result.value);
    const manifest = asRecord(resultPayload.manifest);
    const volumes = Array.isArray(resultPayload.volumes)
      ? resultPayload.volumes.map(asRecord)
      : [];
    if (
      result.status !== 200
      || manifest.trackCount !== input.targetTrackCount
      || typeof manifest.name !== "string"
      || !manifest.name
      || volumes.length < 1
      || typeof volumes[0]?.shareUrl !== "string"
    ) {
      throw new Error("Owner publication UI did not expose an exact result");
    }
    await page.goto(`${input.origin}/playlists?release-owner-publication=1`, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(
        1,
        Math.min(60_000, input.deadlineAt - Date.now()),
      ),
    });
    await page.getByRole("heading", {
      name: manifest.name,
      exact: true,
    }).first().waitFor({
      state: "visible",
      timeout: Math.max(
        1,
        Math.min(60_000, input.deadlineAt - Date.now()),
      ),
    });
    const directoryAppleLink = page.locator(
      `a[href="${String(volumes[0]!.shareUrl).replaceAll('"', '\\"')}"]`,
    ).first();
    await directoryAppleLink.waitFor({
      state: "visible",
      timeout: Math.max(
        1,
        Math.min(30_000, input.deadlineAt - Date.now()),
      ),
    });
    if (directRailwayRequests.length > 0) {
      throw new Error("Owner publication UI called Railway directly");
    }
    await mkdir(input.artifactDirectory, { recursive: true });
    const screenshot = await page.screenshot({
      fullPage: true,
      path: resolve(
        input.artifactDirectory,
        "production-owner-ui-publication.png",
      ),
      timeout: Math.max(
        1,
        Math.min(30_000, input.deadlineAt - Date.now()),
      ),
    });
    const unsigned = {
      schemaVersion: "genio-owner-ui-publication/v1" as const,
      exercised: true as const,
      publishRequestObserved: true as const,
      publishResponseStatus: publishResponse.status(),
      selectedTrackCount: input.targetTrackCount,
      completedUiVisible: true as const,
      directoryEntryVisible: true as const,
      runAccessIdHash: createHash("sha256")
        .update(input.accessId)
        .digest("hex"),
      screenshotHash: createHash("sha256").update(screenshot).digest("hex"),
    };
    return {
      ...unsigned,
      evidenceHash: createHash("sha256")
        .update(stableStringify(unsigned))
        .digest("hex"),
    };
  } finally {
    await browser.close();
  }
}

export function assertHostedCanaryStillExact(
  runValue: unknown,
  deadlineAt: number,
  now = Date.now(),
): void {
  if (!Number.isFinite(deadlineAt) || now >= deadlineAt) {
    throw new Error("Hosted publication smoke exceeded its bounded deadline");
  }
  const run = asRecord(runValue);
  const status = String(run.status ?? "");
  const resolution = asRecord(run.resolution);
  const resolutionState = String(resolution.state ?? "");
  if (NON_EXACT_DECISION_STATES.has(status) || NON_EXACT_DECISION_STATES.has(resolutionState)) {
    throw new Error("Hosted publication smoke reached a non-exact decision or blocker state");
  }
}

function log(event: string, detail: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`);
}

async function main(): Promise<void> {
  const deadlineAt = Date.now() + SMOKE_DEADLINE_MS;
  const {
    origin,
    fixtureId,
    gate,
    prompt,
    targetTrackCount,
    canaryId,
    expectedRevision,
    expectedVersion,
    environment,
    cacheMode,
    runtimeSnapshotScope,
    runtimeSnapshotPath,
    candidateTag,
    imageDigest,
    irishRecoveryAccessId,
    irishRecoveryCookie,
    ownerBrowserCookie,
    productionDatabaseUrl,
    files,
  } = parseHostedSmokeArgs(process.argv.slice(2));
  await preflightReleaseProducerFiles(files);
  const candidate = releaseProducerCandidate({
    tag: candidateTag,
    version: expectedVersion,
    sourceRevision: expectedRevision,
    imageDigest,
  });
  const runtimeSnapshot = await loadReleaseProducerRuntimeSnapshot({
    path: runtimeSnapshotPath,
    environment,
    expectedScope: runtimeSnapshotScope,
    origin,
    candidate,
  });
  const artifactDirectory =
    process.env.RELEASE_BROWSER_ARTIFACT_DIR?.trim() ?? "";
  if (!artifactDirectory) {
    throw new Error(
      "RELEASE_BROWSER_ARTIFACT_DIR is required for browser evidence",
    );
  }
  const canaryRequest = (
    path: string,
    init: RequestInit = {},
    cookie = "",
    allowedStatuses: readonly number[] = [],
  ) => request(origin, path, init, cookie, allowedStatuses, deadlineAt);
  const live = await canaryRequest("/health/live");
  assertHostedRuntime(
    live.payload,
    expectedRevision,
    expectedVersion,
    environment,
    runtimeSnapshot.configuration.apiHash,
  );
  const build = asRecord(live.payload.build);
  const revision = typeof build.revision === "string" ? build.revision.toLowerCase() : "";
  if (!/^[0-9a-f]{7,64}$/u.test(revision)) {
    throw new Error("Hosted API did not expose a valid deployment revision");
  }
  log("build_verified", {
    canaryId,
    identifier: build.identifier,
    version: build.version,
    revision,
  });
  const briefKey = `hosted-smoke-brief-${randomUUID()}`;
  let briefCookie = fixtureId === "irish-influence-recovery-25-v1"
    ? ownerBrowserCookie!
    : "";
  const briefStart = await canaryRequest("/api/v1/brief", {
    method: "POST",
    headers: { "Idempotency-Key": briefKey },
    body: JSON.stringify({
      prompt,
      targetTrackCount,
      idempotencyKey: briefKey,
      releaseCanary: releaseCanaryMetadata({
        canaryId,
        environment,
        audience: origin,
        operation: "brief",
        sourceRevision: expectedRevision,
        cacheMode,
      }),
    }),
  }, briefCookie);
  briefCookie = briefStart.cookie;
  const briefRequestId = String(briefStart.payload.requestId ?? "");
  if (!briefRequestId) throw new Error("gênio did not return a brief request ID");
  log("brief_queued", { canaryId });

  let briefPayload = briefStart.payload;
  const seenQuestionSets = new Set<string>();
  const expectedGuidance: ExpectedHostedGuidanceExecution[] = [];
  let fixtureGuidancePayload: {
    questionSetHash: string;
    questions: import("../shared/types.ts").PlaylistGuidanceQuestion[];
  } | null = null;
  let fixtureGuidanceValidation: ReleaseFixtureGuidanceValidationV1 | null = null;
  for (let attempt = 0; briefPayload.status !== "complete" && attempt < 160; attempt += 1) {
    assertHostedCanaryStillExact(briefPayload, deadlineAt);
    if (briefPayload.status === "failed") throw new Error(String(briefPayload.error ?? "Brief interpretation failed"));
    if (briefPayload.status === "awaiting_answers") {
      if (RELEASE_FIXTURES[fixtureId].guidanceMode !== "recommended") {
        throw new Error("The fixed release fixture unexpectedly requested guidance");
      }
      if (fixtureGuidancePayload) {
        throw new Error("The release fixture requested an unapproved second guidance axis");
      }
      const guidancePayload = {
        questionSetHash: String(briefPayload.questionSetHash ?? ""),
        questions: Array.isArray(briefPayload.questions)
          ? briefPayload.questions as import("../shared/types.ts").PlaylistGuidanceQuestion[]
          : [],
      };
      const validation = validateReleaseFixtureGuidancePayload(
        fixtureId as
          | "smooth-reggaeton-heat-50-v1"
          | "french-jazz-guided-constraint-25-v1"
          | "irish-influence-recovery-25-v1",
        guidancePayload,
      );
      const submission = {
        questionSetHash: validation.questionSetHash,
        answers: [{
          questionId: guidancePayload.questions[0]!.id,
          optionId: validation.selectedOptionId,
        }],
      };
      recordNewGuidanceQuestionSet(seenQuestionSets, submission.questionSetHash);
      const answerKey = `hosted-smoke-answers-${randomUUID()}`;
      const answered = await canaryRequest(`/api/v1/brief/${encodeURIComponent(briefRequestId)}/answers`, {
        method: "POST",
        headers: { "Idempotency-Key": answerKey },
        body: JSON.stringify({
          answers: submission.answers,
          questionSetHash: submission.questionSetHash,
          idempotencyKey: answerKey,
        }),
      }, briefCookie, [409]);
      briefCookie = answered.cookie;
      if (answered.status === 409) {
        if (answered.payload.code !== "stale_guidance_question_set") {
          throw new Error(safeMessage(answered.payload, answered.status));
        }
        briefPayload = {
          ...answered.payload,
          status: "awaiting_answers",
        };
        log("guidance_revision_refreshed", {
          canaryId,
          revision: seenQuestionSets.size,
        });
        continue;
      }
      fixtureGuidancePayload = guidancePayload;
      fixtureGuidanceValidation = validation;
      expectedGuidance.push({
        questionSetHash: validation.questionSetHash,
        executionDeltaHash: validation.executionDeltaHash,
      });
      briefPayload = answered.payload;
      log("guidance_answered", {
        canaryId,
        fixtureId,
        selectedOptionId: validation.selectedOptionId,
        questionCount: submission.answers.length,
        revision: seenQuestionSets.size,
      });
      continue;
    }
    await wait(attempt < 20 ? 1_500 : 5_000);
    const briefPoll = await canaryRequest(`/api/v1/brief/${encodeURIComponent(briefRequestId)}`, {}, briefCookie);
    briefCookie = briefPoll.cookie;
    briefPayload = briefPoll.payload;
  }
  if (briefPayload.status !== "complete" || !briefPayload.brief) {
    throw new Error("Brief interpretation did not finish within the smoke-test window");
  }
  if (RELEASE_FIXTURES[fixtureId].guidanceMode === "recommended"
    && (!fixtureGuidancePayload || !fixtureGuidanceValidation)) {
    throw new Error("The guided release fixture completed without its required typed guidance");
  }

  const interpreted = briefPayload.brief as Record<string, unknown>;
  log("brief_confirmed", {
    canaryId,
    estimateUsd: Number(briefPayload.estimateUsd ?? 0),
    targetSize: targetTrackCount,
  });

  const runKey = `hosted-smoke-run-${randomUUID()}`;
  const runStart = await canaryRequest("/api/v1/runs", {
    method: "POST",
    headers: { "Idempotency-Key": runKey },
    // The server rebuilds the exact canonical brief from the stored request.
    // Echo the interpreted brief instead of pretending browser fields such as
    // title or ambiguity acceptance can override server-owned policy.
    body: JSON.stringify({
      briefRequestId,
      brief: interpreted,
      idempotencyKey: runKey,
      releaseCanary: releaseCanaryMetadata({
        canaryId,
        environment,
        audience: origin,
        operation: "run",
        sourceRevision: expectedRevision,
        cacheMode,
      }),
    }),
  }, briefCookie);
  const initialRun = asRecord(runStart.payload.run ?? runStart.payload);
  const accessId = String(initialRun.id ?? "");
  const capability = String(runStart.payload.capability ?? runStart.payload.capabilityToken ?? "");
  if (!accessId || !capability) throw new Error("gênio did not return a run access ID and capability");

  const exchanged = await canaryRequest("/api/v1/capabilities/exchange", {
    method: "POST",
    body: JSON.stringify({ token: capability }),
  }, briefCookie);
  let cookie = exchanged.cookie;
  if (!cookie) throw new Error("gênio did not establish the scoped capability cookie");
  log("run_started", { canaryId, status: initialRun.status });

  let run = initialRun;
  for (let attempt = 0; attempt < 480; attempt += 1) {
    assertHostedCanaryStillExact(run, deadlineAt);
    if (REVIEW_RUN_STATUSES.has(String(run.status)) || TERMINAL_RUN_STATUSES.has(String(run.status))
      || run.status === "waiting_for_apple_authorization") break;
    if (run.status === "awaiting_budget") {
      throw new Error("A bounded public smoke run unexpectedly stopped for owner budget approval");
    } else {
      await wait(5_000);
    }
    const response = await canaryRequest(`/api/v1/runs/${encodeURIComponent(accessId)}`, {}, cookie);
    cookie = response.cookie;
    const nextRun = asRecord(response.payload.run ?? response.payload);
    if (nextRun.status !== run.status || nextRun.phase !== run.phase) {
      log("run_progress", {
        canaryId,
        status: nextRun.status,
        phase: nextRun.phase,
        candidates: Number(nextRun.candidateCount ?? asRecord(nextRun.coverage).candidateCount ?? 0),
        actualCostUsd: Number(nextRun.actualCostUsd ?? 0),
      });
    }
    run = nextRun;
  }
  assertHostedCanaryStillExact(run, deadlineAt);
  let ownerUiPublication: OwnerUiPublicationEvidenceV1 | null = null;
  if (
    fixtureId === "irish-influence-recovery-25-v1"
    && REVIEW_RUN_STATUSES.has(String(run.status))
  ) {
    ownerUiPublication = await publishOwnerCanaryThroughRealUi({
      origin,
      accessId,
      cookie,
      targetTrackCount,
      artifactDirectory,
      deadlineAt,
    });
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const response = await canaryRequest(
        `/api/v1/runs/${encodeURIComponent(accessId)}`,
        {},
        cookie,
      );
      cookie = response.cookie;
      run = asRecord(response.payload.run ?? response.payload);
      if (TERMINAL_RUN_STATUSES.has(String(run.status))
        || run.status === "waiting_for_apple_authorization") break;
      await wait(2_000);
    }
  } else if (REVIEW_RUN_STATUSES.has(String(run.status))) {
    throw new Error("Automatic one-command publication unexpectedly stopped for manual review");
  }
  if (
    fixtureId === "irish-influence-recovery-25-v1"
    && ownerUiPublication === null
  ) {
    throw new Error(
      "Irish production acceptance did not exercise owner publication through the real UI",
    );
  }
  if (run.status === "waiting_for_apple_authorization") {
    throw new Error("Apple Music owner authorization is not currently valid");
  }
  const resultResponse = await canaryRequest(`/api/v1/runs/${encodeURIComponent(accessId)}/result`, {}, cookie);
  const result = resultResponse.payload;
  log("smoke_complete", {
    canaryId,
    status: run.status,
    volumes: Array.isArray(result.volumes)
      ? result.volumes.map((volume) => {
        const row = asRecord(volume);
        return {
          index: row.index ?? row.volumeNumber,
          shareUrl: row.shareUrl ?? row.appleShareUrl ?? null,
          appendedCount: row.appendedCount,
          status: row.status,
        };
      })
      : [],
  });
  if (!TERMINAL_RUN_STATUSES.has(String(run.status))) {
    throw new Error(`Publication did not reach a terminal status; final status was ${String(run.status)}`);
  }
  assertHostedPublication(
    run,
    result,
    targetTrackCount,
    expectedRevision,
    [
      runtimeSnapshot.configuration.interactiveWorkerHash,
      runtimeSnapshot.configuration.deepWorkerHash,
    ],
    expectedGuidance,
  );
  const executionProof = asRecord(result.executionProof);
  const reconciliation = asRecord(executionProof.publicationReconciliation);
  const independentEvidence = await independentAppleReleaseEvidence({
    result,
    targetTrackCount,
    expectedOrderedIdsHash: String(reconciliation.expectedOrderedIdsHash ?? ""),
    canaryId,
    environment,
    candidateRevision: expectedRevision,
    artifactDirectory,
    deadlineAt,
  });
  assertHostedCanaryStillExact(run, deadlineAt);
  if (independentEvidence.verifierCredentialVersionHash
    !== runtimeSnapshot.credentialVersionHashes.appleQaVerifier) {
    throw new Error("Independent Apple verification used the wrong credential version");
  }
  log("independent_apple_evidence", independentEvidence);
  const hostedEvidence = hostedPublicationEvidence(
    result,
    targetTrackCount,
    canaryId,
    cacheMode,
    String(independentEvidence.evidenceHash ?? ""),
    [
      runtimeSnapshot.configuration.interactiveWorkerHash,
      runtimeSnapshot.configuration.deepWorkerHash,
    ],
    ownerUiPublication,
  );
  const guidanceLineageHash = RELEASE_FIXTURES[fixtureId].guidanceMode === "recommended"
    ? String(hostedEvidence.guidanceLineageHash ?? "")
    : null;
  const fixtures = releaseFixtureBindingsForGate(gate, guidanceLineageHash
    ? { [fixtureId]: guidanceLineageHash }
    : {});
  const fixtureExecution = createReleaseFixtureExecutionProof({
    fixtureId,
    guidanceLineageHash,
    guidancePayload: fixtureGuidancePayload,
  });
  const irishInfluenceRecovery = fixtureId
    === "irish-influence-recovery-25-v1"
    ? await (async () => {
        if (
          !irishRecoveryAccessId
          || !irishRecoveryCookie
          || !productionDatabaseUrl
        ) {
          throw new Error(
            "Irish-influence durable recovery selectors are missing",
          );
        }
        const client = new pg.Client({
          connectionString: productionDatabaseUrl,
          ssl: productionDatabaseUrl.includes("railway.internal")
            ? undefined
            : { rejectUnauthorized: false },
        });
        await client.connect();
        try {
          return await collectIrishInfluenceReleaseProofV1({
            database: client,
            runtime: {
              async fetchJson(url, scopedCookie) {
                const response = await fetch(url, {
                  cache: "no-store",
                  redirect: "error",
                  headers: {
                    "cache-control": "no-cache",
                    pragma: "no-cache",
                    ...(scopedCookie ? { cookie: scopedCookie } : {}),
                  },
                  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                });
                let value: unknown = {};
                try {
                  value = JSON.parse(await response.text());
                } catch {
                  value = {};
                }
                return { status: response.status, value };
              },
              now: () => new Date(),
            },
            origin: "https://9enio.com",
            publicationAccessId: accessId,
            publicationCookie: cookie,
            recoveryAccessId: irishRecoveryAccessId,
            recoveryCookie: irishRecoveryCookie,
            expectedVersion,
            expectedRevision,
          });
        } finally {
          await client.end();
        }
      })()
    : null;
  const completedAt = new Date().toISOString();
  assertHostedCanaryStillExact(run, deadlineAt);
  const produced = await emitReleaseGateProducerArtifacts({
    gate,
    completedAt,
    candidate,
    runtimeSnapshot,
    fixtures,
    sources: {
      hostedPublication: hostedEvidence,
      independentApple: independentEvidence,
      fixtureExecution,
      ...(irishInfluenceRecovery
        ? { irishInfluenceRecovery }
        : {}),
    },
    files,
  });
  log("publication_evidence", {
    fixtureId,
    gate,
    sourceEvidenceHash: releaseFixtureSha256(produced.source),
    gateEvidenceHash: produced.artifact.evidenceHash,
    producerKeyId: produced.attestation.signature.keyId,
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "hosted_publication_smoke_failed",
      message: "Hosted publication smoke test failed; inspect the named canary stage without retaining provider bodies.",
    })}\n`);
    process.exitCode = 1;
  });
}
