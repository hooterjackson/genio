import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Response,
} from "@playwright/test";
import {
  ACTIVE_RESEARCH_LIMIT_MS,
  DEPENDENCY_AUTOMATIC_RETRY_WINDOW_MS,
} from "../server/never-dead-end-policy.ts";
import {
  releaseCanaryAudience,
  signReleaseCanaryMetadata,
  type ReleaseCanaryOperation,
} from "../server/release-canary-metadata.ts";
import { stableStringify } from "../server/security.ts";
import {
  curatedResearchBudgetUsd,
  PUBLIC_FAST_RESEARCH_BUDGET_USD,
  PUBLIC_PLAYLIST_MAXIMUM_TRACKS,
  PUBLIC_PLAYLIST_MINIMUM_TRACKS,
} from "../shared/product-policy.ts";
import {
  createStrictSignedEnvelope,
  exactObject,
  sha256Digest,
  signedArtifactSha256,
  verifyStrictSignedEnvelope,
  type JsonRecord,
} from "../shared/signed-artifact.ts";
import {
  validateStagingControlPlaneTrustPolicyV1,
  verifyStagingControlPlaneEvidence,
} from "../shared/staging-control-plane-evidence.ts";
import {
  releaseGateProducerKeyFingerprint,
  validateReleaseGateProducerTrustPolicyV1,
  validateRuntimeSnapshot,
  type LoadedRuntimeSnapshotV1,
} from "./release-evidence.ts";
import {
  releaseProducerCandidate,
} from "./release-gate-producer.ts";
import {
  assertHostedPublication,
  assertHostedRuntime,
} from "./hosted-publication-smoke.ts";
import { sitesBuildIdentityFromHtml } from "./release-runtime-snapshot.ts";

export const HISTORICAL_REPLAY_SUBMISSION_COUNT = 73;
export const HISTORICAL_REPLAY_MAX_CONCURRENCY = 4;
export const HISTORICAL_REPLAY_REQUIRED_CANARY_RESERVE_USD = 3;
export const HISTORICAL_REPLAY_CORPUS_COMMITMENT_SHA256 =
  "cec24d3d2c78185ccf1fcb8dfe646193c83ef7f26819f473bca34cd6fbc5eefd" as const;
export const HISTORICAL_REPLAY_MAXIMUM_RESEARCH_BUDGET_USD = 59.25;
export const HISTORICAL_REPLAY_REQUIRED_BUDGET_RESERVATION_USD = 62.25;
export const HISTORICAL_REPLAY_EVIDENCE_TTL_MS = 24 * 60 * 60_000;
export const HISTORICAL_REPLAY_PAYLOAD_SCHEMA =
  "genio-historical-browser-replay-evidence/v1" as const;
export const SIGNED_HISTORICAL_REPLAY_SCHEMA =
  "genio-signed-historical-browser-replay-evidence/v1" as const;

const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const SAFE_API_CODE = /^[a-z][a-z0-9_]{1,79}$/u;
const DECISION_NEXT_ACTIONS = new Set([
  "decide_verified_partial",
  "review_contract",
  "resume_research",
]);
const DEPENDENCY_NEXT_ACTIONS = new Set([
  "wait_for_dependency",
  "authorize_apple",
]);
const FORBIDDEN_EVIDENCE_KEYS = new Set([
  "prompt",
  "rawPrompt",
  "runId",
  "requestId",
  "accessId",
  "capability",
  "capabilityToken",
  "playlistId",
  "shareUrl",
  "applePlaylistId",
  "answers",
  "questions",
  "customText",
]);

export type HistoricalReplayOutcome =
  | "exact_original"
  | "exact_after_guidance"
  | "actionable_decision"
  | "visible_retry";

export interface HistoricalReplayScenario {
  ordinal: number;
  prompt: string;
  targetTrackCount: number;
  maximumResearchBudgetUsd: number;
}

export interface HistoricalReplayCorpus {
  scenarios: HistoricalReplayScenario[];
  submissionCount: number;
  corpusCommitmentHash: string;
  maximumResearchBudgetUsd: number;
  requiredBudgetReservationUsd: number;
  privateValues: string[];
}

export interface HistoricalReplayCandidate {
  tag: string;
  version: string;
  sourceRevision: string;
  imageDigest: string;
}

export interface HistoricalReplayRunArgs {
  mode: "run";
  confirmStagingWrites: true;
  origin: string;
  corpusPath: string;
  runtimeSnapshotPath: string;
  stagingControlPlaneEvidencePath: string;
  stagingControlPlaneVerificationKeyPath: string;
  stagingControlPlaneTrustPolicyPath: string;
  canaryHmacKeyPath: string;
  outputPath: string;
  producerSigningKeyPath: string;
  producerKeyId: string;
  candidate: HistoricalReplayCandidate;
  maximumConcurrency: number;
  perRunBudgetCapUsd: number;
}

export interface HistoricalReplayVerifyArgs {
  mode: "verify";
  origin: string;
  evidencePath: string;
  verificationKeyPath: string;
  trustPolicyPath: string;
  runtimeSnapshotPath: string;
  stagingControlPlaneEvidencePath: string;
  stagingControlPlaneVerificationKeyPath: string;
  stagingControlPlaneTrustPolicyPath: string;
  candidate: HistoricalReplayCandidate;
}

export type HistoricalReplayArgs =
  | HistoricalReplayRunArgs
  | HistoricalReplayVerifyArgs;

export interface HistoricalReplayResult {
  ordinal: number;
  targetTrackCount: number;
  outcome: HistoricalReplayOutcome;
  guidanceSubmissionCount: number;
  briefMarkerCount: number;
  runMarkerCount: number;
  freshRunCount: number;
  countIntegrityCheckCount: number;
  transcriptCommitment: string;
}

export interface HistoricalReplayEvidencePayloadV1 extends JsonRecord {
  schemaVersion: typeof HISTORICAL_REPLAY_PAYLOAD_SCHEMA;
  generatedAt: string;
  expiresAt: string;
  environment: "staging";
  candidate: HistoricalReplayCandidate;
  staging: {
    originHash: string;
    runtimeSnapshotHash: string;
    configurationHash: string;
    runtimeHash: string;
    controlPlaneEvidenceHash: string;
    serviceInventoryHash: string;
  };
  corpus: {
    commitmentHash: string;
    submissionCount: number;
    maximumResearchBudgetUsd: number;
    requiredOtherCanaryReserveUsd: number;
    requiredBudgetReservationUsd: number;
  };
  browser: {
    engine: "chromium";
    maximumConcurrency: number;
    perRunDeadlineMs: number;
    perRunBudgetCapUsd: number;
    cacheMode: "reuse_disabled";
    traceCount: 0;
    screenshotCount: 0;
    videoCount: 0;
    rawArtifactCount: 0;
  };
  outcomes: {
    completedSubmissionCount: number;
    exactOriginalCount: number;
    exactAfterGuidanceCount: number;
    actionableDecisionCount: number;
    visibleRetryCount: number;
    guidanceSubmissionCount: number;
    briefMarkerCount: number;
    runMarkerCount: number;
    freshRunCount: number;
    countIntegrityCheckCount: number;
    unexplainedTerminalCount: 0;
    countViolationCount: 0;
    integrityViolationCount: 0;
    budgetExhaustionCount: 0;
    transcriptCommitmentHash: string;
  };
  passed: true;
}

export type SignedHistoricalReplayEvidenceV1 = ReturnType<
  typeof createStrictSignedEnvelope<
    HistoricalReplayEvidencePayloadV1,
    typeof SIGNED_HISTORICAL_REPLAY_SCHEMA
  >
>;

export class HistoricalReplayGateError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HistoricalReplayGateError";
    this.code = code;
  }
}

function gateError(code: string, message: string): never {
  throw new HistoricalReplayGateError(code, message);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableHash(value: unknown): string {
  return sha256(stableStringify(value));
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") gateError("invalid_evidence", `${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    gateError("invalid_evidence", `${label} must be an ISO timestamp`);
  }
  return value;
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveMoney(value: unknown, label: string): number {
  const amount = numberValue(value);
  if (amount <= 0 || Number(amount.toFixed(6)) !== amount) {
    gateError("invalid_budget", `${label} must be positive money with at most six decimals`);
  }
  return amount;
}

function option(
  argv: readonly string[],
  name: string,
): string {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length !== 1) gateError("invalid_arguments", `${name} must be provided exactly once`);
  const value = argv[indexes[0]! + 1]?.trim() ?? "";
  if (!value || value.startsWith("--")) gateError("invalid_arguments", `${name} requires a value`);
  return value;
}

function candidateOptions(argv: readonly string[]): HistoricalReplayCandidate {
  const candidate = releaseProducerCandidate({
    tag: option(argv, "--candidate-tag"),
    version: option(argv, "--expected-version"),
    sourceRevision: option(argv, "--expected-revision"),
    imageDigest: option(argv, "--image-digest"),
  });
  return {
    tag: candidate.tag,
    version: candidate.version,
    sourceRevision: candidate.sourceRevision,
    imageDigest: candidate.imageDigest,
  };
}

function exactHttpsOrigin(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return gateError("unsafe_origin", `${label} must be an HTTPS origin`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) gateError("unsafe_origin", `${label} must be an HTTPS origin`);
  return parsed.origin;
}

function stagingOrigin(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): string {
  const origin = exactHttpsOrigin(option(argv, "--origin"), "--origin");
  const configured = environment.RELEASE_STAGING_ORIGIN?.trim() ?? "";
  if (!configured || exactHttpsOrigin(configured, "RELEASE_STAGING_ORIGIN") !== origin) {
    gateError(
      "staging_origin_mismatch",
      "--origin must exactly match RELEASE_STAGING_ORIGIN",
    );
  }
  const hostname = new URL(origin).hostname.toLowerCase();
  if (hostname === "9enio.com" || hostname === "www.9enio.com") {
    gateError("production_host_refused", "historical replay refuses the production host");
  }
  const production = environment.RELEASE_PRODUCTION_ORIGIN?.trim();
  if (
    production
    && exactHttpsOrigin(production, "RELEASE_PRODUCTION_ORIGIN") === origin
  ) gateError("production_host_refused", "historical replay refuses the production origin");
  return origin;
}

export function parseHistoricalReplayArgs(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): HistoricalReplayArgs {
  const mode = argv[0];
  if (mode !== "run" && mode !== "verify") {
    gateError("invalid_arguments", "historical replay requires run or verify");
  }
  const common = new Set([
    "--origin",
    "--candidate-tag",
    "--expected-revision",
    "--expected-version",
    "--image-digest",
    "--runtime-snapshot",
    "--staging-control-plane-evidence",
    "--staging-control-plane-verification-key",
    "--staging-control-plane-trust-policy",
  ]);
  const allowed = mode === "run"
    ? new Set([
        ...common,
        "--confirm-staging-writes",
        "--corpus",
        "--canary-hmac-key",
        "--output",
        "--producer-signing-key",
        "--producer-key-id",
        "--max-concurrency",
        "--per-run-budget-cap-usd",
      ])
    : new Set([
        ...common,
        "--evidence",
        "--verification-key",
        "--trust-policy",
      ]);
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!allowed.has(argument)) gateError("invalid_arguments", `unknown argument ${argument}`);
    if (argument !== "--confirm-staging-writes") index += 1;
  }
  const origin = stagingOrigin(argv, environment);
  const candidate = candidateOptions(argv);
  const shared = {
    origin,
    candidate,
    runtimeSnapshotPath: option(argv, "--runtime-snapshot"),
    stagingControlPlaneEvidencePath:
      option(argv, "--staging-control-plane-evidence"),
    stagingControlPlaneVerificationKeyPath:
      option(argv, "--staging-control-plane-verification-key"),
    stagingControlPlaneTrustPolicyPath:
      option(argv, "--staging-control-plane-trust-policy"),
  };
  if (mode === "verify") {
    return {
      mode,
      ...shared,
      evidencePath: option(argv, "--evidence"),
      verificationKeyPath: option(argv, "--verification-key"),
      trustPolicyPath: option(argv, "--trust-policy"),
    };
  }
  if (
    argv.filter((value) => value === "--confirm-staging-writes").length !== 1
  ) {
    gateError(
      "staging_write_confirmation_required",
      "run requires --confirm-staging-writes exactly once",
    );
  }
  const maximumConcurrency = Number(option(argv, "--max-concurrency"));
  if (
    !Number.isSafeInteger(maximumConcurrency)
    || maximumConcurrency < 1
    || maximumConcurrency > HISTORICAL_REPLAY_MAX_CONCURRENCY
  ) gateError("invalid_concurrency", "--max-concurrency must be 1 through 4");
  const perRunBudgetCapUsd = positiveMoney(
    Number(option(argv, "--per-run-budget-cap-usd")),
    "per-run budget cap",
  );
  if (perRunBudgetCapUsd > PUBLIC_FAST_RESEARCH_BUDGET_USD) {
    gateError(
      "invalid_budget",
      "per-run budget cap cannot exceed the public hard ceiling",
    );
  }
  return {
    mode,
    ...shared,
    confirmStagingWrites: true,
    corpusPath: option(argv, "--corpus"),
    canaryHmacKeyPath: option(argv, "--canary-hmac-key"),
    outputPath: option(argv, "--output"),
    producerSigningKeyPath: option(argv, "--producer-signing-key"),
    producerKeyId: option(argv, "--producer-key-id"),
    maximumConcurrency,
    perRunBudgetCapUsd,
  };
}

function sourcePrivateValues(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as JsonRecord;
  return ["id", "runId"].flatMap((key) => (
    typeof record[key] === "string" && String(record[key]).length >= 4
      ? [String(record[key])]
      : []
  ));
}

export function parseHistoricalReplayCorpus(
  value: unknown,
): HistoricalReplayCorpus {
  const root = asRecord(value);
  const scenariosValue = root.scenarios;
  if (!Array.isArray(scenariosValue)) {
    gateError("invalid_corpus", "historical replay corpus has no scenarios");
  }
  if (
    Number(root.submissionCount) !== scenariosValue.length
    || scenariosValue.length !== HISTORICAL_REPLAY_SUBMISSION_COUNT
  ) {
    gateError(
      "corpus_submission_count_mismatch",
      `historical replay requires all ${HISTORICAL_REPLAY_SUBMISSION_COUNT} submissions`,
    );
  }
  const privateValues: string[] = [];
  const scenarios = scenariosValue.map((value, index) => {
    const scenario = asRecord(value);
    const prompt = typeof scenario.prompt === "string" ? scenario.prompt : "";
    const targetTrackCount = Number(scenario.requestedTrackCount);
    if (
      prompt !== prompt.trim()
      || prompt.length < 4
      || Array.from(prompt).length > 2_000
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(prompt)
    ) gateError("invalid_corpus", "historical replay contains an invalid prompt");
    if (
      !Number.isSafeInteger(targetTrackCount)
      || targetTrackCount < PUBLIC_PLAYLIST_MINIMUM_TRACKS
      || targetTrackCount > PUBLIC_PLAYLIST_MAXIMUM_TRACKS
    ) gateError("invalid_corpus", "historical replay contains an invalid track count");
    privateValues.push(prompt, ...sourcePrivateValues(value));
    return {
      ordinal: index + 1,
      prompt,
      targetTrackCount,
      maximumResearchBudgetUsd: curatedResearchBudgetUsd(targetTrackCount),
    };
  });
  const maximumResearchBudgetUsd = Number(scenarios.reduce(
    (total, scenario) => total + scenario.maximumResearchBudgetUsd,
    0,
  ).toFixed(6));
  const requiredBudgetReservationUsd = Number((
    maximumResearchBudgetUsd + HISTORICAL_REPLAY_REQUIRED_CANARY_RESERVE_USD
  ).toFixed(6));
  return {
    scenarios,
    submissionCount: scenarios.length,
    corpusCommitmentHash: stableHash(scenarios.map((scenario) => ({
      ordinal: scenario.ordinal,
      prompt: scenario.prompt,
      targetTrackCount: scenario.targetTrackCount,
    }))),
    maximumResearchBudgetUsd,
    requiredBudgetReservationUsd,
    privateValues: [...new Set(privateValues.filter(Boolean))],
  };
}

export async function loadHistoricalReplayCorpus(
  path: string,
): Promise<HistoricalReplayCorpus> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return gateError("invalid_corpus", "--corpus must identify readable JSON");
  }
  return parseHistoricalReplayCorpus(value);
}

async function readJson(path: string, code: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return gateError(code, "required signed JSON evidence is unreadable");
  }
}

async function readEd25519PrivateKey(path: string): Promise<Buffer> {
  let value: Buffer;
  try {
    value = await readFile(path);
  } catch {
    return gateError("invalid_signing_key", "replay evidence signing key is unreadable");
  }
  try {
    if (createPrivateKey(value).asymmetricKeyType !== "ed25519") {
      gateError("invalid_signing_key", "replay evidence requires Ed25519");
    }
  } catch {
    return gateError("invalid_signing_key", "replay evidence requires Ed25519");
  }
  return value;
}

async function readEd25519PublicKey(path: string): Promise<Buffer> {
  let value: Buffer;
  try {
    value = await readFile(path);
  } catch {
    return gateError("invalid_verification_key", "verification key is unreadable");
  }
  try {
    if (createPublicKey(value).asymmetricKeyType !== "ed25519") {
      gateError("invalid_verification_key", "verification key must be Ed25519");
    }
  } catch {
    return gateError("invalid_verification_key", "verification key must be Ed25519");
  }
  return value;
}

async function readCanarySecret(path: string): Promise<string> {
  let value = "";
  try {
    value = (await readFile(path, "utf8")).trim();
  } catch {
    return gateError("invalid_canary_key", "release-canary key is unreadable");
  }
  if (Buffer.byteLength(value, "utf8") < 32) {
    gateError("invalid_canary_key", "release-canary key is too short");
  }
  return value;
}

interface StagingGateBindings {
  runtimeSnapshot: LoadedRuntimeSnapshotV1;
  controlPlaneEvidenceHash: string;
  serviceInventoryHash: string;
  budgetRemainingUsd: number;
  reservedForRequiredGatesUsd: number;
}

export async function loadHistoricalReplayStagingBindings(input: {
  origin: string;
  candidate: HistoricalReplayCandidate;
  runtimeSnapshotPath: string;
  stagingControlPlaneEvidencePath: string;
  stagingControlPlaneVerificationKeyPath: string;
  stagingControlPlaneTrustPolicyPath: string;
  now?: string;
}): Promise<StagingGateBindings> {
  const [
    runtimeValue,
    controlPlaneValue,
    controlPlaneKey,
    controlPlaneTrust,
  ] = await Promise.all([
    readJson(input.runtimeSnapshotPath, "missing_runtime_snapshot"),
    readJson(
      input.stagingControlPlaneEvidencePath,
      "missing_staging_control_plane_evidence",
    ),
    readFile(input.stagingControlPlaneVerificationKeyPath).catch(() => (
      gateError(
        "missing_staging_control_plane_evidence",
        "staging control-plane verification key is unreadable",
      )
    )),
    readJson(
      input.stagingControlPlaneTrustPolicyPath,
      "missing_staging_control_plane_evidence",
    ),
  ]);
  const runtimeSnapshot = validateRuntimeSnapshot(
    runtimeValue,
    "staging",
    "full",
  );
  const trust = validateStagingControlPlaneTrustPolicyV1(controlPlaneTrust);
  const verified = verifyStagingControlPlaneEvidence({
    value: controlPlaneValue,
    verificationKey: controlPlaneKey,
    trustPolicy: trust,
    ...(input.now ? { now: input.now } : {}),
  });
  const controls = verified.derivedControls;
  if (
    runtimeSnapshot.origin !== input.origin
    || runtimeSnapshot.candidate.version !== input.candidate.version
    || runtimeSnapshot.candidate.sourceRevision !== input.candidate.sourceRevision
    || runtimeSnapshot.sitesObservation.sourceRevision
      !== input.candidate.sourceRevision
    || runtimeSnapshot.sitesObservation.candidateMatched !== true
    || controls.controlPlanePhase !== "candidate"
    || controls.candidateSourceRevision !== input.candidate.sourceRevision
    || controls.candidateImageDigest !== input.candidate.imageDigest
    || controls.stagingRuntimeSnapshotHash !== runtimeSnapshot.snapshotHash
    || controls.stagingConfigurationHash !== runtimeSnapshot.configurationHash
    || controls.musicKitOrigin !== input.origin
    || controls.providerSecretVersionHash
      === controls.productionProviderSecretVersionHash
    || controls.appleSecretVersionHash === controls.productionAppleSecretVersionHash
    || controls.appleQaVerifierSecretVersionHash
      === controls.productionAppleQaVerifierSecretVersionHash
  ) {
    gateError(
      "isolated_staging_markers_missing",
      "signed staging controls do not bind an isolated activated candidate",
    );
  }
  return {
    runtimeSnapshot,
    controlPlaneEvidenceHash: controls.controlPlaneEvidenceHash,
    serviceInventoryHash: controls.stagingRailwayServiceInventoryHash,
    budgetRemainingUsd: controls.budgetRemainingUsd,
    reservedForRequiredGatesUsd: controls.reservedForRequiredGatesUsd,
  };
}

export function assertHistoricalReplayBudget(input: {
  corpus: HistoricalReplayCorpus;
  perRunBudgetCapUsd: number;
  budgetRemainingUsd: number;
  reservedForRequiredGatesUsd: number;
}): void {
  if (input.corpus.scenarios.some(
    ({ maximumResearchBudgetUsd }) => (
      maximumResearchBudgetUsd > input.perRunBudgetCapUsd
      || maximumResearchBudgetUsd > PUBLIC_FAST_RESEARCH_BUDGET_USD
    ),
  )) {
    gateError(
      "per_run_budget_cap_insufficient",
      "the per-run cap cannot cover every unchanged size-tier ceiling",
    );
  }
  if (
    input.budgetRemainingUsd < input.corpus.requiredBudgetReservationUsd
    || input.reservedForRequiredGatesUsd
      < input.corpus.requiredBudgetReservationUsd
  ) {
    gateError(
      "qa_budget_reservation_insufficient",
      "the signed QA ledger cannot reserve the corpus plus required canaries",
    );
  }
}

export function assertHistoricalReplayPromotionCorpus(
  corpus: Pick<
    HistoricalReplayCorpus,
    | "corpusCommitmentHash"
    | "submissionCount"
    | "maximumResearchBudgetUsd"
    | "requiredBudgetReservationUsd"
  >,
): void {
  if (
    corpus.corpusCommitmentHash
      !== HISTORICAL_REPLAY_CORPUS_COMMITMENT_SHA256
    || corpus.submissionCount !== HISTORICAL_REPLAY_SUBMISSION_COUNT
    || corpus.maximumResearchBudgetUsd
      !== HISTORICAL_REPLAY_MAXIMUM_RESEARCH_BUDGET_USD
    || corpus.requiredBudgetReservationUsd
      !== HISTORICAL_REPLAY_REQUIRED_BUDGET_RESERVATION_USD
  ) {
    gateError(
      "unapproved_historical_corpus",
      "historical replay does not bind the approved 73-submission corpus",
    );
  }
}

function workerLaneReady(
  value: unknown,
  expectedRevision: string,
  expectedConfigurationHash: string,
): boolean {
  const lane = asRecord(value);
  const revisions = Array.isArray(lane.eligibleRevisions)
    ? [...new Set(lane.eligibleRevisions.map(String))]
    : [];
  const hashes = Array.isArray(lane.eligibleConfigurationHashes)
    ? [...new Set(lane.eligibleConfigurationHashes.map(String))]
    : [];
  return lane.status === "healthy"
    && numberValue(lane.compatibleCapacity) >= 1
    && numberValue(lane.eligibleWorkerCount) >= 1
    && numberValue(lane.eligibleIdentityCount)
      === numberValue(lane.eligibleWorkerCount)
    && revisions.length === 1
    && revisions[0] === expectedRevision
    && hashes.length === 1
    && hashes[0] === expectedConfigurationHash;
}

async function noStoreResponse(
  url: string,
): Promise<{ status: number; headers: Headers; text: string; json: unknown }> {
  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      redirect: "error",
      headers: {
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return gateError("staging_preflight_failed", "staging preflight request failed");
  }
  const text = await response.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // The caller validates the expected representation.
  }
  return { status: response.status, headers: response.headers, text, json };
}

export async function assertHistoricalReplayLivePreflight(input: {
  origin: string;
  candidate: HistoricalReplayCandidate;
  runtimeSnapshot: LoadedRuntimeSnapshotV1;
}): Promise<void> {
  const nonce = sha256(`${Date.now()}:${input.candidate.sourceRevision}`).slice(0, 16);
  const [sites, live, system] = await Promise.all([
    noStoreResponse(`${input.origin}/about?historical-replay=${nonce}`),
    noStoreResponse(`${input.origin}/health/live?historical-replay=${nonce}`),
    noStoreResponse(`${input.origin}/health/system?historical-replay=${nonce}`),
  ]);
  if (sites.status !== 200 || live.status !== 200 || system.status !== 200) {
    gateError("staging_preflight_failed", "staging is not fully healthy");
  }
  const sitesIdentity = sitesBuildIdentityFromHtml(sites.text);
  if (
    sitesIdentity.version !== input.candidate.version
    || sitesIdentity.sourceRevision !== input.candidate.sourceRevision
    || sites.headers.get("x-genio-sites-configuration-hash")
      !== input.runtimeSnapshot.configuration.sitesHash
  ) {
    gateError(
      "staging_candidate_mismatch",
      "staging Sites does not serve the exact candidate",
    );
  }
  assertHostedRuntime(
    live.json,
    input.candidate.sourceRevision,
    input.candidate.version,
    "staging",
    input.runtimeSnapshot.configuration.apiHash,
  );
  const health = asRecord(system.json);
  const lanes = asRecord(health.workerLanes);
  if (
    health.ok !== true
    || health.activationReady !== true
    || String(health.schemaVersion) !== "18"
    || String(health.releaseManifestCanaryGuardsVersion) !== "1"
    || String(health.canonicalExecutionHardeningVersion) !== "1"
    || !workerLaneReady(
      lanes.interactive,
      input.candidate.sourceRevision,
      input.runtimeSnapshot.configuration.interactiveWorkerHash,
    )
    || !workerLaneReady(
      lanes.deep,
      input.candidate.sourceRevision,
      input.runtimeSnapshot.configuration.deepWorkerHash,
    )
  ) {
    gateError(
      "staging_activation_not_ready",
      "staging schema or candidate worker lanes are not activated",
    );
  }
}

export interface HistoricalReplaySafeRunObservation {
  status: string;
  phase: string;
  errorPresent: boolean;
  targetTrackCount: number;
  publishedTrackCount: number;
  appendedTrackCount: number;
  resolution: {
    state: string;
    nextAction: string;
    terminal: boolean;
    blockerKind: string;
    nextRetryAt: string | null;
    automaticRetryUntil: string | null;
  } | null;
  guidanceAction: {
    kind: string;
    questionSetHash: string;
  } | null;
  partialActionPresent: boolean;
  decisionActionPresent: boolean;
}

function safeRunObservation(
  value: unknown,
): HistoricalReplaySafeRunObservation | null {
  const root = asRecord(value);
  const run = asRecord(root.run ?? root);
  if (typeof run.status !== "string") return null;
  const resolution = asRecord(run.resolution);
  const blocker = asRecord(resolution.blocker);
  const selectionPlan = asRecord(run.selectionPlan);
  const pipelineOutcome = asRecord(run.pipelineOutcome);
  const brief = asRecord(run.brief);
  const targetSize = asRecord(brief.targetSize);
  const progress = asRecord(run.progress);
  const publication = asRecord(progress.publicationSummary);
  const guidance = asRecord(run.guidanceAction);
  return {
    status: String(run.status),
    phase: typeof run.phase === "string" ? run.phase : "",
    errorPresent: Boolean(run.error),
    targetTrackCount: numberValue(
      selectionPlan.requestedTrackCount
      ?? pipelineOutcome.targetTrackCount
      ?? targetSize.max,
    ),
    publishedTrackCount: numberValue(pipelineOutcome.publishedTrackCount),
    appendedTrackCount: numberValue(publication.appendedTracks),
    resolution: typeof resolution.state === "string"
      ? {
          state: String(resolution.state),
          nextAction: String(resolution.nextAction ?? ""),
          terminal: resolution.terminal === true,
          blockerKind: String(blocker.kind ?? ""),
          nextRetryAt: typeof blocker.nextRetryAt === "string"
            ? blocker.nextRetryAt
            : null,
          automaticRetryUntil: typeof blocker.automaticRetryUntil === "string"
            ? blocker.automaticRetryUntil
            : null,
        }
      : null,
    guidanceAction: typeof guidance.kind === "string"
      ? {
          kind: String(guidance.kind),
          questionSetHash: typeof guidance.questionSetHash === "string"
            ? guidance.questionSetHash
            : "",
        }
      : null,
    partialActionPresent: Boolean(
      run.partialAction
      && typeof run.partialAction === "object",
    ),
    decisionActionPresent: Boolean(
      run.decisionAction
      && typeof run.decisionAction === "object",
    ),
  };
}

interface ScenarioCapture {
  pendingResponses: Set<Promise<void>>;
  latestRun: HistoricalReplaySafeRunObservation | null;
  rawResult: unknown;
  latestQuestionSetHash: string;
  latestApiCode: string;
  latestHttpStatus: number;
  budgetExhausted: boolean;
  briefMarkerCount: number;
  runMarkerCount: number;
  freshRunCount: number;
  reusedRunCount: number;
  submittedQuestionSetHashes: string[];
  answerCommitments: string[];
}

function newScenarioCapture(): ScenarioCapture {
  return {
    pendingResponses: new Set(),
    latestRun: null,
    rawResult: null,
    latestQuestionSetHash: "",
    latestApiCode: "",
    latestHttpStatus: 0,
    budgetExhausted: false,
    briefMarkerCount: 0,
    runMarkerCount: 0,
    freshRunCount: 0,
    reusedRunCount: 0,
    submittedQuestionSetHashes: [],
    answerCommitments: [],
  };
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function responsePath(response: Response): string {
  try {
    return new URL(response.url()).pathname;
  } catch {
    return "";
  }
}

async function captureResponse(
  response: Response,
  capture: ScenarioCapture,
): Promise<void> {
  const path = responsePath(response);
  if (!path.startsWith("/api/v1/")) return;
  const method = response.request().method();
  const relevant = (
    (path === "/api/v1/brief" && method === "POST")
    || (path === "/api/v1/runs" && method === "POST")
    || /^\/api\/v1\/brief\/[^/]+$/u.test(path)
    || /^\/api\/v1\/runs\/[^/]+$/u.test(path)
    || /^\/api\/v1\/runs\/[^/]+\/result$/u.test(path)
    || /\/answers$/u.test(path)
  );
  if (!relevant) return;
  const payload = await responseJson(response);
  const record = asRecord(payload);
  if (response.status() >= 400) {
    capture.latestHttpStatus = response.status();
    const code = typeof record.code === "string" && SAFE_API_CODE.test(record.code)
      ? record.code
      : "unclassified_api_failure";
    capture.latestApiCode = code;
    if (
      response.status() === 402
      || code.includes("budget")
      || code.includes("cost_limit")
    ) capture.budgetExhausted = true;
    return;
  }
  capture.latestApiCode = "";
  capture.latestHttpStatus = 0;
  if (path === "/api/v1/runs" && method === "POST") {
    if (record.reused === false) capture.freshRunCount += 1;
    if (record.reused === true) capture.reusedRunCount += 1;
  }
  if (
    (path === "/api/v1/brief" && method === "POST")
    || /^\/api\/v1\/brief\/[^/]+$/u.test(path)
    || /\/answers$/u.test(path)
  ) {
    const hash = typeof record.questionSetHash === "string"
      ? record.questionSetHash.toLowerCase()
      : "";
    if (SHA256.test(hash)) capture.latestQuestionSetHash = hash;
  }
  if (
    (path === "/api/v1/runs" && method === "POST")
    || (
      /^\/api\/v1\/runs\/[^/]+$/u.test(path)
      && method === "GET"
    )
  ) {
    capture.latestRun = safeRunObservation(payload) ?? capture.latestRun;
  }
  if (/^\/api\/v1\/runs\/[^/]+\/result$/u.test(path)) {
    capture.rawResult = payload;
  }
}

async function drainResponseCaptures(capture: ScenarioCapture): Promise<void> {
  while (capture.pendingResponses.size > 0) {
    await Promise.all([...capture.pendingResponses]);
  }
}

function releaseCanaryForScenario(input: {
  canaryId: string;
  origin: string;
  operation: ReleaseCanaryOperation;
  sourceRevision: string;
  secret: string;
}) {
  return signReleaseCanaryMetadata({
    version: "genio-release-canary/v1",
    canaryId: input.canaryId,
    environment: "staging",
    audience: releaseCanaryAudience(input.origin),
    operation: input.operation,
    sourceRevision: input.sourceRevision,
    issuedAt: new Date().toISOString(),
    cacheMode: "reuse_disabled",
  }, input.secret);
}

export function historicalReplayTaggedRequestBody(input: {
  operation: ReleaseCanaryOperation;
  body: JsonRecord;
  expectedPrompt?: string;
  expectedTrackCount?: number;
  canaryId: string;
  origin: string;
  sourceRevision: string;
  secret: string;
}): JsonRecord {
  if (input.operation === "brief" && (
    input.body.prompt !== input.expectedPrompt
    || Number(input.body.targetTrackCount) !== input.expectedTrackCount
  )) {
    gateError(
      "prompt_or_count_changed",
      "the browser changed the historical prompt or count",
    );
  }
  return {
    ...input.body,
    releaseCanary: releaseCanaryForScenario({
      canaryId: input.canaryId,
      origin: input.origin,
      operation: input.operation,
      sourceRevision: input.sourceRevision,
      secret: input.secret,
    }),
  };
}

function parsePostData(page: Page, request: Parameters<
  Parameters<Page["route"]>[1]
>[0]["request"] extends () => infer RequestType ? RequestType : never): JsonRecord {
  try {
    return asRecord(request.postDataJSON());
  } catch {
    void page;
    return {};
  }
}

async function configureScenarioInterception(input: {
  page: Page;
  scenario: HistoricalReplayScenario;
  canaryId: string;
  origin: string;
  sourceRevision: string;
  canarySecret: string;
  transcriptKey: string;
  capture: ScenarioCapture;
}): Promise<void> {
  const inject = async (
    operation: ReleaseCanaryOperation,
    route: Parameters<Parameters<Page["route"]>[1]>[0],
  ) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    const body = parsePostData(input.page, request);
    if (operation === "brief") {
      input.capture.briefMarkerCount += 1;
    } else {
      input.capture.runMarkerCount += 1;
    }
    let nextBody: JsonRecord;
    try {
      nextBody = historicalReplayTaggedRequestBody({
        operation,
        body,
        ...(operation === "brief"
          ? {
              expectedPrompt: input.scenario.prompt,
              expectedTrackCount: input.scenario.targetTrackCount,
            }
          : {}),
        canaryId: input.canaryId,
        origin: input.origin,
        sourceRevision: input.sourceRevision,
        secret: input.canarySecret,
      });
    } catch (error) {
      await route.abort();
      throw error;
    }
    await route.continue({
      postData: JSON.stringify(nextBody),
      headers: {
        ...request.headers(),
        "content-type": "application/json",
      },
    });
  };
  await input.page.route("**/api/v1/brief", (route) => inject("brief", route));
  await input.page.route("**/api/v1/runs", (route) => inject("run", route));
  input.page.on("request", (request) => {
    let path = "";
    try {
      path = new URL(request.url()).pathname;
    } catch {
      return;
    }
    if (request.method() !== "POST" || !/\/answers$/u.test(path)) return;
    let body: JsonRecord;
    try {
      body = asRecord(request.postDataJSON());
    } catch {
      return;
    }
    const questionSetHash = typeof body.questionSetHash === "string"
      ? body.questionSetHash.toLowerCase()
      : "";
    const answers = Array.isArray(body.answers) ? body.answers : [];
    if (!SHA256.test(questionSetHash) || answers.length < 1) return;
    if (!input.capture.submittedQuestionSetHashes.includes(questionSetHash)) {
      input.capture.submittedQuestionSetHashes.push(questionSetHash);
      input.capture.answerCommitments.push(
        createHmac("sha256", input.transcriptKey)
          .update(stableStringify({
            questionSetHash,
            answers: answers.map((answer) => {
              const value = asRecord(answer);
              return {
                questionId: value.questionId,
                optionId: value.optionId,
                optionIds: value.optionIds,
                skipped: value.skipped,
              };
            }),
          }))
          .digest("hex"),
      );
    }
  });
  input.page.on("response", (response) => {
    const pending = captureResponse(response, input.capture);
    input.capture.pendingResponses.add(pending);
    void pending.finally(() => input.capture.pendingResponses.delete(pending));
  });
}

async function visible(locator: ReturnType<Page["locator"]>): Promise<boolean> {
  return locator.first().isVisible().catch(() => false);
}

async function handleRecommendedGuidance(input: {
  page: Page;
  capture: ScenarioCapture;
  handledTokens: Set<string>;
}): Promise<boolean> {
  const screen = input.page.locator(".guided-question-screen")
    .filter({ has: input.page.locator("fieldset.guided-options") })
    .first();
  if (!await visible(screen)) return false;
  const fieldset = screen.locator("fieldset.guided-options").first();
  if (await fieldset.isDisabled().catch(() => true)) return false;
  const heading = screen.locator("h1").first();
  const headingId = await heading.getAttribute("id").catch(() => "") ?? "";
  const token = `${input.capture.latestQuestionSetHash}:${headingId}`;
  if (input.handledTokens.has(token)) return false;
  const recommended = fieldset.locator("label.guided-option-card")
    .filter({ hasText: "RECOMMENDED" });
  if (await recommended.count() !== 1) {
    gateError(
      "guidance_has_no_single_recommendation",
      "browser guidance did not expose exactly one server recommendation",
    );
  }
  await recommended.locator("input").click({ timeout: 10_000 });
  const next = screen.locator("button.guided-next").first();
  await next.click({ timeout: 10_000 });
  input.handledTokens.add(token);
  return true;
}

async function visibleActionableDecision(
  page: Page,
  run: HistoricalReplaySafeRunObservation,
): Promise<boolean> {
  if (run.resolution?.state === "quarantined") return false;
  if (
    run.resolution?.state !== "needs_decision"
    && run.resolution?.state !== "needs_input"
  ) return false;
  if (
    run.resolution.state === "needs_decision"
    && !DECISION_NEXT_ACTIONS.has(run.resolution.nextAction)
  ) return false;
  const summary = page.getByTestId("clarification-limit-summary");
  if (await visible(summary)) {
    return await visible(summary.locator("button:enabled"));
  }
  const partial = page.getByTestId("partial-decision-screen");
  if (await visible(partial)) {
    return await visible(partial.locator("button:enabled"));
  }
  const panel = page.getByTestId("run-decision-panel");
  const footerAction = page.locator(
    ".run-action-footer button:enabled, .run-action-footer a[href]",
  );
  return (run.decisionActionPresent || run.partialActionPresent)
    && (await visible(panel) || await visible(footerAction))
    && await visible(footerAction);
}

function retryTimestamp(value: string | null): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : null;
}

function validBoundedProviderRetry(
  resolution: NonNullable<HistoricalReplaySafeRunObservation["resolution"]>,
  now: number,
): boolean {
  const nextRetryAt = retryTimestamp(resolution.nextRetryAt);
  const automaticRetryUntil = retryTimestamp(
    resolution.automaticRetryUntil,
  );
  return (
    resolution.terminal === false
    && resolution.blockerKind === "provider"
    && resolution.nextAction === "wait_for_dependency"
    && nextRetryAt !== null
    && automaticRetryUntil !== null
    && nextRetryAt >= now
    && nextRetryAt <= automaticRetryUntil
    && automaticRetryUntil <= now + DEPENDENCY_AUTOMATIC_RETRY_WINDOW_MS
  );
}

async function visibleDependencyRetry(
  page: Page,
  run: HistoricalReplaySafeRunObservation,
): Promise<boolean> {
  const resolution = run.resolution;
  if (
    resolution?.state !== "blocked_dependency"
    || !DEPENDENCY_NEXT_ACTIONS.has(resolution.nextAction)
    || resolution.terminal
  ) return false;
  const providerBounded = validBoundedProviderRetry(
    resolution,
    Date.now(),
  );
  const appleBounded = (
    resolution.blockerKind === "apple_authorization"
    || run.status === "waiting_for_apple_authorization"
  ) && resolution.nextAction === "authorize_apple";
  if (!providerBounded && !appleBounded) return false;
  return await visible(
    page.getByRole("heading", { name: "Your playlist is safely paused" }),
  ) && (
    await visible(page.locator(".run-action-footer"))
    || await visible(page.getByRole("status"))
  );
}

function noPublicationBeforeDecision(
  run: HistoricalReplaySafeRunObservation,
): boolean {
  return run.publishedTrackCount === 0 && run.appendedTrackCount === 0;
}

export function classifyHistoricalReplayRunState(input: {
  run: HistoricalReplaySafeRunObservation;
  expectedTrackCount: number;
  actionableDecisionVisible: boolean;
  dependencyRetryVisible: boolean;
  now?: string;
}): "actionable_decision" | "visible_retry" | null {
  const { run } = input;
  if (run.targetTrackCount !== input.expectedTrackCount) {
    gateError(
      "count_or_integrity_violation",
      "the active run changed the original exact count",
    );
  }
  if (
    run.resolution?.state === "quarantined"
    || run.resolution?.blockerKind === "integrity"
    || ["failed_integrity", "quarantined"].includes(run.status)
  ) {
    gateError(
      "technical_quarantine",
      "historical replay reached a technical or integrity quarantine",
    );
  }
  const now = input.now
    ? Date.parse(isoTimestamp(input.now, "historical replay observation time"))
    : Date.now();
  if (
    input.actionableDecisionVisible
    && (
      run.resolution?.state === "needs_decision"
      || run.resolution?.state === "needs_input"
    )
  ) {
    if (!noPublicationBeforeDecision(run)) {
      gateError(
        "partial_publication_without_consent",
        "a decision state already contains published tracks",
      );
    }
    return "actionable_decision";
  }
  if (run.resolution?.state === "blocked_dependency") {
    const providerBounded = validBoundedProviderRetry(
      run.resolution,
      now,
    );
    const appleBounded = (
      run.resolution.terminal === false
      && (
        run.resolution.blockerKind === "apple_authorization"
        || run.status === "waiting_for_apple_authorization"
      )
      && run.resolution.nextAction === "authorize_apple"
    );
    if (!providerBounded && !appleBounded) {
      gateError(
        "unbounded_dependency_retry",
        "dependency blocker has no authoritative bounded retry metadata",
      );
    }
  }
  if (
    input.dependencyRetryVisible
    && run.resolution?.state === "blocked_dependency"
  ) {
    if (!noPublicationBeforeDecision(run)) {
      gateError(
        "dependency_state_published",
        "a dependency state already contains published tracks",
      );
    }
    return "visible_retry";
  }
  if (
    run.resolution?.terminal === true
    || ["cancelled", "deleted", "expired", "partial"].includes(run.status)
  ) {
    gateError(
      "unexplained_terminal",
      "historical replay reached an unexplained terminal state",
    );
  }
  return null;
}

export function classifyHistoricalReplayPreRunArtistState(input: {
  apiCode: string;
  retryAlreadyAttempted: boolean;
  editableInputVisible: boolean;
  typedIdentityOptionsVisible: boolean;
}): "retry_once" | "actionable_decision" | null {
  if (input.apiCode === "artist_identity_resolution_configuration") {
    gateError(
      "artist_identity_configuration_failure",
      "artist identity resolution is not configured in staging",
    );
  }
  if (input.apiCode === "artist_identity_resolution_retryable") {
    if (input.retryAlreadyAttempted) {
      gateError(
        "transient_dependency_not_durable",
        "transient artist lookup did not become a durable dependency blocker",
      );
    }
    return "retry_once";
  }
  if (input.apiCode === "exact_artist_identity_clarification_required") {
    if (!input.editableInputVisible && !input.typedIdentityOptionsVisible) {
      gateError(
        "artist_identity_dead_end",
        "artist ambiguity has no editable input or typed identity choice",
      );
    }
    return "actionable_decision";
  }
  return null;
}

function expectedGuidanceFromResult(
  resultValue: unknown,
  submittedQuestionSetHashes: readonly string[],
): Array<{ questionSetHash: string; executionDeltaHash: string }> {
  const result = asRecord(resultValue);
  const proof = asRecord(result.executionProof);
  const lineage = Array.isArray(proof.guidanceLineage)
    ? proof.guidanceLineage.map(asRecord)
    : [];
  if (lineage.length !== submittedQuestionSetHashes.length) {
    gateError(
      "guidance_lineage_mismatch",
      "published execution did not preserve the selected guidance lineage",
    );
  }
  return submittedQuestionSetHashes.map((questionSetHash) => {
    const item = lineage.find((value) => value.questionSetHash === questionSetHash);
    const executionDeltaHash = String(item?.executionDeltaHash ?? "");
    if (!item || !SHA256.test(executionDeltaHash)) {
      return gateError(
        "guidance_lineage_mismatch",
        "published execution omitted a selected guidance revision",
      );
    }
    return { questionSetHash, executionDeltaHash };
  });
}

async function assertExactBrowserResult(input: {
  page: Page;
  run: HistoricalReplaySafeRunObservation;
  result: unknown;
  scenario: HistoricalReplayScenario;
  candidate: HistoricalReplayCandidate;
  runtimeSnapshot: LoadedRuntimeSnapshotV1;
  submittedQuestionSetHashes: readonly string[];
}): Promise<void> {
  if (
    input.run.targetTrackCount !== input.scenario.targetTrackCount
    || input.run.resolution?.state !== "completed"
    || input.run.resolution.terminal !== true
  ) {
    gateError(
      "count_or_integrity_violation",
      "completed run does not retain the exact original count",
    );
  }
  const expectedGuidance = expectedGuidanceFromResult(
    input.result,
    input.submittedQuestionSetHashes,
  );
  assertHostedPublication(
    {
      status: input.run.status,
      error: input.run.errorPresent ? "retained_error" : null,
    },
    input.result,
    input.scenario.targetTrackCount,
    input.candidate.sourceRevision,
    [
      input.runtimeSnapshot.configuration.interactiveWorkerHash,
      input.runtimeSnapshot.configuration.deepWorkerHash,
    ],
    expectedGuidance,
  );
  const resultScreen = input.page.locator("section.result-screen");
  if (
    !await visible(resultScreen)
    || !await visible(resultScreen.locator('a[href^="https://music.apple.com/"]'))
  ) {
    gateError(
      "browser_result_not_visible",
      "exact publication was not visible through the browser UI",
    );
  }
}

async function visiblePreRunRetry(
  page: Page,
  capture: ScenarioCapture,
): Promise<boolean> {
  if (capture.latestApiCode !== "artist_identity_resolution_retryable") {
    return false;
  }
  return await visible(page.getByRole("alert"))
    && await visible(page.getByRole("button", { name: "RETRY LOOKUP →" }));
}

async function visiblePreRunDecision(
  page: Page,
  capture: ScenarioCapture,
): Promise<boolean> {
  if (capture.latestApiCode !== "exact_artist_identity_clarification_required") {
    return false;
  }
  return await visible(page.getByRole("alert"))
    && (
      await visible(page.getByRole("button", { name: /different artist/i }))
      || await visible(page.getByRole("button", { name: /edit artist/i }))
    );
}

async function visiblePreRunTypedIdentityOptions(page: Page): Promise<boolean> {
  const options = page.locator(
    "fieldset.guided-options label.guided-option-card input:enabled",
  );
  return await visible(options) && await options.count() >= 2;
}

function scenarioCommitment(input: {
  transcriptKey: string;
  scenario: HistoricalReplayScenario;
  outcome: HistoricalReplayOutcome;
  capture: ScenarioCapture;
}): string {
  return createHmac("sha256", input.transcriptKey)
    .update(stableStringify({
      ordinal: input.scenario.ordinal,
      prompt: input.scenario.prompt,
      targetTrackCount: input.scenario.targetTrackCount,
      outcome: input.outcome,
      briefMarkerCount: input.capture.briefMarkerCount,
      runMarkerCount: input.capture.runMarkerCount,
      freshRunCount: input.capture.freshRunCount,
      guidance: input.capture.answerCommitments,
    }))
    .digest("hex");
}

export interface HistoricalReplayBrowserDriver {
  runScenario(
    scenario: HistoricalReplayScenario,
    ordinal: number,
  ): Promise<HistoricalReplayResult>;
  close(): Promise<void>;
}

export class PlaywrightHistoricalReplayDriver
implements HistoricalReplayBrowserDriver {
  private readonly browser: Browser;
  private readonly origin: string;
  private readonly candidate: HistoricalReplayCandidate;
  private readonly runtimeSnapshot: LoadedRuntimeSnapshotV1;
  private readonly canarySecret: string;
  private readonly transcriptKey: string;
  private readonly suiteId: string;
  private readonly contexts = new Set<BrowserContext>();

  private constructor(input: {
    browser: Browser;
    origin: string;
    candidate: HistoricalReplayCandidate;
    runtimeSnapshot: LoadedRuntimeSnapshotV1;
    canarySecret: string;
    transcriptKey: string;
    suiteId: string;
  }) {
    this.browser = input.browser;
    this.origin = input.origin;
    this.candidate = input.candidate;
    this.runtimeSnapshot = input.runtimeSnapshot;
    this.canarySecret = input.canarySecret;
    this.transcriptKey = input.transcriptKey;
    this.suiteId = input.suiteId;
  }

  static async create(input: {
    origin: string;
    candidate: HistoricalReplayCandidate;
    runtimeSnapshot: LoadedRuntimeSnapshotV1;
    canarySecret: string;
    transcriptKey: string;
    corpusCommitmentHash: string;
  }): Promise<PlaywrightHistoricalReplayDriver> {
    let browser: Browser;
    try {
      browser = await chromium.launch({
        headless: true,
      });
    } catch {
      return gateError(
        "browser_launch_failed",
        "the staging browser could not launch",
      );
    }
    return new PlaywrightHistoricalReplayDriver({
      browser,
      origin: input.origin,
      candidate: input.candidate,
      runtimeSnapshot: input.runtimeSnapshot,
      canarySecret: input.canarySecret,
      transcriptKey: input.transcriptKey,
      suiteId: input.corpusCommitmentHash.slice(0, 12),
    });
  }

  async runScenario(
    scenario: HistoricalReplayScenario,
    ordinal: number,
  ): Promise<HistoricalReplayResult> {
    const canaryId =
      `hist-${this.suiteId}-${String(ordinal).padStart(3, "0")}`;
    const capture = newScenarioCapture();
    const handledGuidance = new Set<string>();
    let context: BrowserContext | null = null;
    try {
      context = await this.browser.newContext({
        baseURL: this.origin,
        acceptDownloads: false,
        reducedMotion: "reduce",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 900 },
        recordVideo: undefined,
      });
      this.contexts.add(context);
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.setDefaultNavigationTimeout(20_000);
      await configureScenarioInterception({
        page,
        scenario,
        canaryId,
        origin: this.origin,
        sourceRevision: this.candidate.sourceRevision,
        canarySecret: this.canarySecret,
        transcriptKey: this.transcriptKey,
        capture,
      });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const prompt = page.getByRole("textbox", { name: "PLAYLIST REQUEST" });
      await prompt.fill(scenario.prompt);
      if ([25, 50, 100].includes(scenario.targetTrackCount)) {
        await page.getByRole(
          "button",
          { name: `${scenario.targetTrackCount} tracks` },
        ).click();
      } else {
        await page.getByRole("button", { name: "Custom size" }).click();
        await page.getByRole("textbox", { name: "Exact track count" })
          .fill(String(scenario.targetTrackCount));
      }
      await page.locator("button.one-command-submit").click();
      const deadlineAt = Date.now() + ACTIVE_RESEARCH_LIMIT_MS;
      let preRunRetryAttempted = false;
      while (Date.now() < deadlineAt) {
        await drainResponseCaptures(capture);
        if (capture.budgetExhausted) {
          gateError(
            "qa_budget_exhausted",
            "staging reported budget exhaustion",
          );
        }
        if (capture.reusedRunCount > 0) {
          gateError(
            "result_reuse_not_disabled",
            "staging reused a historical replay result",
          );
        }
        if (!capture.latestRun && capture.latestApiCode) {
          const retryVisible = await visiblePreRunRetry(page, capture);
          let editableInputVisible = await visiblePreRunDecision(page, capture);
          let typedIdentityOptionsVisible =
            await visiblePreRunTypedIdentityOptions(page);
          if (
            capture.latestApiCode
              === "exact_artist_identity_clarification_required"
            && !editableInputVisible
            && !typedIdentityOptionsVisible
          ) {
            await page.waitForTimeout(250);
            editableInputVisible = await visiblePreRunDecision(page, capture);
            typedIdentityOptionsVisible =
              await visiblePreRunTypedIdentityOptions(page);
          }
          const preRunOutcome = classifyHistoricalReplayPreRunArtistState({
            apiCode: capture.latestApiCode,
            retryAlreadyAttempted: preRunRetryAttempted,
            editableInputVisible,
            typedIdentityOptionsVisible,
          });
          if (preRunOutcome === "retry_once") {
            if (!retryVisible) {
              await page.waitForTimeout(250);
              continue;
            }
            preRunRetryAttempted = true;
            capture.latestApiCode = "";
            await page.getByRole("button", { name: "RETRY LOOKUP →" }).click();
            await page.waitForTimeout(500);
            continue;
          }
          if (preRunOutcome === "actionable_decision") {
            const outcome: HistoricalReplayOutcome = "actionable_decision";
            return {
              ordinal,
              targetTrackCount: scenario.targetTrackCount,
              outcome,
              guidanceSubmissionCount:
                capture.submittedQuestionSetHashes.length,
              briefMarkerCount: capture.briefMarkerCount,
              runMarkerCount: capture.runMarkerCount,
              freshRunCount: capture.freshRunCount,
              countIntegrityCheckCount: 0,
              transcriptCommitment: scenarioCommitment({
                transcriptKey: this.transcriptKey,
                scenario,
                outcome,
                capture,
              }),
            };
          }
        }
        if (await handleRecommendedGuidance({
          page,
          capture,
          handledTokens: handledGuidance,
        })) {
          if (handledGuidance.size > 8) {
            gateError(
              "guidance_loop",
              "historical replay exceeded bounded guidance",
            );
          }
          await page.waitForTimeout(250);
          continue;
        }
        const run = capture.latestRun;
        if (run?.status === "complete" && capture.rawResult) {
          await assertExactBrowserResult({
            page,
            run,
            result: capture.rawResult,
            scenario,
            candidate: this.candidate,
            runtimeSnapshot: this.runtimeSnapshot,
            submittedQuestionSetHashes: capture.submittedQuestionSetHashes,
          });
          const outcome: HistoricalReplayOutcome =
            capture.submittedQuestionSetHashes.length > 0
              ? "exact_after_guidance"
              : "exact_original";
          return {
            ordinal,
            targetTrackCount: scenario.targetTrackCount,
            outcome,
            guidanceSubmissionCount:
              capture.submittedQuestionSetHashes.length,
            briefMarkerCount: capture.briefMarkerCount,
            runMarkerCount: capture.runMarkerCount,
            freshRunCount: capture.freshRunCount,
            countIntegrityCheckCount: 1,
            transcriptCommitment: scenarioCommitment({
              transcriptKey: this.transcriptKey,
              scenario,
              outcome,
              capture,
            }),
          };
        }
        if (run) {
          const decisionVisible = await visibleActionableDecision(page, run);
          const retryVisible = await visibleDependencyRetry(page, run);
          const outcome = run.status === "complete"
            ? (() => {
                if (run.targetTrackCount !== scenario.targetTrackCount) {
                  gateError(
                    "count_or_integrity_violation",
                    "the completed run changed the original exact count",
                  );
                }
                return null;
              })()
            : classifyHistoricalReplayRunState({
                run,
                expectedTrackCount: scenario.targetTrackCount,
                actionableDecisionVisible: decisionVisible,
                dependencyRetryVisible: retryVisible,
              });
          if (outcome) {
            return {
              ordinal,
              targetTrackCount: scenario.targetTrackCount,
              outcome,
              guidanceSubmissionCount:
                capture.submittedQuestionSetHashes.length,
              briefMarkerCount: capture.briefMarkerCount,
              runMarkerCount: capture.runMarkerCount,
              freshRunCount: capture.freshRunCount,
              countIntegrityCheckCount: 0,
              transcriptCommitment: scenarioCommitment({
                transcriptKey: this.transcriptKey,
                scenario,
                outcome,
                capture,
              }),
            };
          }
        }
        await page.waitForTimeout(500);
      }
      gateError(
        "replay_deadline_exceeded",
        "historical replay did not reach a valid bounded outcome",
      );
    } catch (error) {
      if (error instanceof HistoricalReplayGateError) throw error;
      gateError(
        "browser_replay_failed",
        "historical browser replay failed",
      );
    } finally {
      if (context) {
        this.contexts.delete(context);
        await context.close().catch(() => undefined);
      }
    }
    return gateError(
      "browser_replay_failed",
      "historical browser replay ended without an outcome",
    );
  }

  async close(): Promise<void> {
    await Promise.all([...this.contexts].map((context) => (
      context.close().catch(() => undefined)
    )));
    this.contexts.clear();
    await this.browser.close().catch(() => undefined);
  }
}

export async function runHistoricalReplayCorpus(input: {
  corpus: HistoricalReplayCorpus;
  driver: HistoricalReplayBrowserDriver;
  maximumConcurrency: number;
}): Promise<HistoricalReplayResult[]> {
  if (
    !Number.isSafeInteger(input.maximumConcurrency)
    || input.maximumConcurrency < 1
    || input.maximumConcurrency > HISTORICAL_REPLAY_MAX_CONCURRENCY
  ) gateError("invalid_concurrency", "historical replay concurrency is invalid");
  const results: HistoricalReplayResult[] = [];
  let cursor = 0;
  let firstFailure: unknown = null;
  const worker = async () => {
    while (firstFailure === null) {
      const index = cursor;
      cursor += 1;
      const scenario = input.corpus.scenarios[index];
      if (!scenario) return;
      try {
        results.push(await input.driver.runScenario(scenario, index + 1));
      } catch (error) {
        firstFailure = error;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(input.maximumConcurrency, input.corpus.scenarios.length) },
      () => worker(),
    ),
  );
  if (firstFailure) throw firstFailure;
  results.sort((left, right) => left.ordinal - right.ordinal);
  if (
    results.length !== HISTORICAL_REPLAY_SUBMISSION_COUNT
    || results.some((result, index) => result.ordinal !== index + 1)
  ) {
    gateError(
      "incomplete_replay",
      "not every historical submission completed",
    );
  }
  return results;
}

function countOutcome(
  results: readonly HistoricalReplayResult[],
  outcome: HistoricalReplayOutcome,
): number {
  return results.filter((result) => result.outcome === outcome).length;
}

function recursivelyAssertNoForbiddenEvidenceKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(recursivelyAssertNoForbiddenEvidenceKeys);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    if (FORBIDDEN_EVIDENCE_KEYS.has(key)) {
      gateError("evidence_contains_private_field", "evidence contains a private field");
    }
    recursivelyAssertNoForbiddenEvidenceKeys(child);
  }
}

export function assertHistoricalReplayEvidenceIsSanitized(
  value: unknown,
  privateValues: readonly string[],
): void {
  recursivelyAssertNoForbiddenEvidenceKeys(value);
  const serialized = JSON.stringify(value);
  if (
    privateValues.some((privateValue) => (
      privateValue.length >= 4 && serialized.includes(privateValue)
    ))
  ) {
    gateError(
      "evidence_contains_private_value",
      "evidence contains private corpus data",
    );
  }
}

export function createHistoricalReplayEvidencePayload(input: {
  candidate: HistoricalReplayCandidate;
  origin: string;
  runtimeSnapshot: LoadedRuntimeSnapshotV1;
  controlPlaneEvidenceHash: string;
  serviceInventoryHash: string;
  corpus: HistoricalReplayCorpus;
  results: readonly HistoricalReplayResult[];
  maximumConcurrency: number;
  perRunBudgetCapUsd: number;
  generatedAt?: string;
}): HistoricalReplayEvidencePayloadV1 {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  isoTimestamp(generatedAt, "historical replay generatedAt");
  const expiresAt = new Date(
    Date.parse(generatedAt) + HISTORICAL_REPLAY_EVIDENCE_TTL_MS,
  ).toISOString();
  if (input.results.length !== HISTORICAL_REPLAY_SUBMISSION_COUNT) {
    gateError("incomplete_replay", "historical replay evidence is incomplete");
  }
  const exactOriginalCount = countOutcome(input.results, "exact_original");
  const exactAfterGuidanceCount = countOutcome(
    input.results,
    "exact_after_guidance",
  );
  const actionableDecisionCount = countOutcome(
    input.results,
    "actionable_decision",
  );
  const visibleRetryCount = countOutcome(input.results, "visible_retry");
  const completedSubmissionCount = exactOriginalCount
    + exactAfterGuidanceCount
    + actionableDecisionCount
    + visibleRetryCount;
  const payload: HistoricalReplayEvidencePayloadV1 = {
    schemaVersion: HISTORICAL_REPLAY_PAYLOAD_SCHEMA,
    generatedAt,
    expiresAt,
    environment: "staging",
    candidate: input.candidate,
    staging: {
      originHash: sha256(input.origin),
      runtimeSnapshotHash: input.runtimeSnapshot.snapshotHash,
      configurationHash: input.runtimeSnapshot.configurationHash,
      runtimeHash: input.runtimeSnapshot.runtimeHash,
      controlPlaneEvidenceHash: input.controlPlaneEvidenceHash,
      serviceInventoryHash: input.serviceInventoryHash,
    },
    corpus: {
      commitmentHash: input.corpus.corpusCommitmentHash,
      submissionCount: input.corpus.submissionCount,
      maximumResearchBudgetUsd: input.corpus.maximumResearchBudgetUsd,
      requiredOtherCanaryReserveUsd:
        HISTORICAL_REPLAY_REQUIRED_CANARY_RESERVE_USD,
      requiredBudgetReservationUsd:
        input.corpus.requiredBudgetReservationUsd,
    },
    browser: {
      engine: "chromium",
      maximumConcurrency: input.maximumConcurrency,
      perRunDeadlineMs: ACTIVE_RESEARCH_LIMIT_MS,
      perRunBudgetCapUsd: input.perRunBudgetCapUsd,
      cacheMode: "reuse_disabled",
      traceCount: 0,
      screenshotCount: 0,
      videoCount: 0,
      rawArtifactCount: 0,
    },
    outcomes: {
      completedSubmissionCount,
      exactOriginalCount,
      exactAfterGuidanceCount,
      actionableDecisionCount,
      visibleRetryCount,
      guidanceSubmissionCount: input.results.reduce(
        (sum, result) => sum + result.guidanceSubmissionCount,
        0,
      ),
      briefMarkerCount: input.results.reduce(
        (sum, result) => sum + result.briefMarkerCount,
        0,
      ),
      runMarkerCount: input.results.reduce(
        (sum, result) => sum + result.runMarkerCount,
        0,
      ),
      freshRunCount: input.results.reduce(
        (sum, result) => sum + result.freshRunCount,
        0,
      ),
      countIntegrityCheckCount: input.results.reduce(
        (sum, result) => sum + result.countIntegrityCheckCount,
        0,
      ),
      unexplainedTerminalCount: 0,
      countViolationCount: 0,
      integrityViolationCount: 0,
      budgetExhaustionCount: 0,
      transcriptCommitmentHash: stableHash(input.results.map((result) => ({
        ordinal: result.ordinal,
        targetTrackCount: result.targetTrackCount,
        outcome: result.outcome,
        transcriptCommitment: result.transcriptCommitment,
      }))),
    },
    passed: true,
  };
  validateHistoricalReplayEvidencePayload(payload);
  assertHistoricalReplayEvidenceIsSanitized(
    payload,
    input.corpus.privateValues,
  );
  return payload;
}

export function validateHistoricalReplayEvidencePayload(
  value: unknown,
): HistoricalReplayEvidencePayloadV1 {
  const root = exactObject(value, [
    "schemaVersion",
    "generatedAt",
    "expiresAt",
    "environment",
    "candidate",
    "staging",
    "corpus",
    "browser",
    "outcomes",
    "passed",
  ], "historical replay evidence");
  if (
    root.schemaVersion !== HISTORICAL_REPLAY_PAYLOAD_SCHEMA
    || root.environment !== "staging"
    || root.passed !== true
  ) gateError("invalid_evidence", "historical replay evidence did not pass");
  const generatedAt = isoTimestamp(
    root.generatedAt,
    "historical replay generatedAt",
  );
  const expiresAt = isoTimestamp(
    root.expiresAt,
    "historical replay expiresAt",
  );
  if (
    Date.parse(expiresAt) - Date.parse(generatedAt)
      !== HISTORICAL_REPLAY_EVIDENCE_TTL_MS
  ) gateError("invalid_evidence", "historical replay evidence TTL is invalid");
  const candidate = exactObject(root.candidate, [
    "tag",
    "version",
    "sourceRevision",
    "imageDigest",
  ], "historical replay candidate");
  if (
    typeof candidate.version !== "string"
    || !VERSION.test(candidate.version)
    || typeof candidate.tag !== "string"
    || !new RegExp(
      `^v${candidate.version.replaceAll(".", "\\.")}-rc\\.[1-9]\\d*$`,
      "u",
    ).test(candidate.tag)
    || typeof candidate.sourceRevision !== "string"
    || !SOURCE_REVISION.test(candidate.sourceRevision)
    || typeof candidate.imageDigest !== "string"
    || !IMAGE_DIGEST.test(candidate.imageDigest)
  ) gateError("invalid_evidence", "historical replay candidate is invalid");
  const staging = exactObject(root.staging, [
    "originHash",
    "runtimeSnapshotHash",
    "configurationHash",
    "runtimeHash",
    "controlPlaneEvidenceHash",
    "serviceInventoryHash",
  ], "historical replay staging binding");
  for (const [key, digest] of Object.entries(staging)) {
    sha256Digest(digest, `historical replay staging ${key}`);
  }
  const corpus = exactObject(root.corpus, [
    "commitmentHash",
    "submissionCount",
    "maximumResearchBudgetUsd",
    "requiredOtherCanaryReserveUsd",
    "requiredBudgetReservationUsd",
  ], "historical replay corpus");
  sha256Digest(corpus.commitmentHash, "historical replay corpus commitment");
  if (
    Number(corpus.submissionCount) !== HISTORICAL_REPLAY_SUBMISSION_COUNT
    || numberValue(corpus.maximumResearchBudgetUsd) <= 0
    || numberValue(corpus.requiredOtherCanaryReserveUsd)
      !== HISTORICAL_REPLAY_REQUIRED_CANARY_RESERVE_USD
    || numberValue(corpus.requiredBudgetReservationUsd)
      !== Number((
        numberValue(corpus.maximumResearchBudgetUsd)
        + HISTORICAL_REPLAY_REQUIRED_CANARY_RESERVE_USD
      ).toFixed(6))
  ) gateError("invalid_evidence", "historical replay budget binding is invalid");
  const browser = exactObject(root.browser, [
    "engine",
    "maximumConcurrency",
    "perRunDeadlineMs",
    "perRunBudgetCapUsd",
    "cacheMode",
    "traceCount",
    "screenshotCount",
    "videoCount",
    "rawArtifactCount",
  ], "historical replay browser");
  if (
    browser.engine !== "chromium"
    || browser.cacheMode !== "reuse_disabled"
    || numberValue(browser.maximumConcurrency) < 1
    || numberValue(browser.maximumConcurrency) > HISTORICAL_REPLAY_MAX_CONCURRENCY
    || numberValue(browser.perRunDeadlineMs) !== ACTIVE_RESEARCH_LIMIT_MS
    || numberValue(browser.perRunBudgetCapUsd) <= 0
    || numberValue(browser.perRunBudgetCapUsd) > PUBLIC_FAST_RESEARCH_BUDGET_USD
    || numberValue(browser.traceCount) !== 0
    || numberValue(browser.screenshotCount) !== 0
    || numberValue(browser.videoCount) !== 0
    || numberValue(browser.rawArtifactCount) !== 0
  ) gateError("invalid_evidence", "historical replay browser proof is invalid");
  const outcomes = exactObject(root.outcomes, [
    "completedSubmissionCount",
    "exactOriginalCount",
    "exactAfterGuidanceCount",
    "actionableDecisionCount",
    "visibleRetryCount",
    "guidanceSubmissionCount",
    "briefMarkerCount",
    "runMarkerCount",
    "freshRunCount",
    "countIntegrityCheckCount",
    "unexplainedTerminalCount",
    "countViolationCount",
    "integrityViolationCount",
    "budgetExhaustionCount",
    "transcriptCommitmentHash",
  ], "historical replay outcomes");
  const categoryTotal = [
    outcomes.exactOriginalCount,
    outcomes.exactAfterGuidanceCount,
    outcomes.actionableDecisionCount,
    outcomes.visibleRetryCount,
  ].reduce<number>((sum, count) => sum + numberValue(count), 0);
  const exactTotal = numberValue(outcomes.exactOriginalCount)
    + numberValue(outcomes.exactAfterGuidanceCount);
  const nonnegativeCounts = Object.entries(outcomes)
    .filter(([key]) => key.endsWith("Count"))
    .map(([, count]) => Number(count));
  if (
    nonnegativeCounts.some((count) => (
      !Number.isSafeInteger(count) || count < 0
    ))
    || numberValue(outcomes.completedSubmissionCount)
      !== HISTORICAL_REPLAY_SUBMISSION_COUNT
    || categoryTotal !== HISTORICAL_REPLAY_SUBMISSION_COUNT
    || numberValue(outcomes.briefMarkerCount)
      < HISTORICAL_REPLAY_SUBMISSION_COUNT
    || numberValue(outcomes.freshRunCount)
      !== numberValue(outcomes.runMarkerCount)
    || numberValue(outcomes.countIntegrityCheckCount) !== exactTotal
    || numberValue(outcomes.unexplainedTerminalCount) !== 0
    || numberValue(outcomes.countViolationCount) !== 0
    || numberValue(outcomes.integrityViolationCount) !== 0
    || numberValue(outcomes.budgetExhaustionCount) !== 0
  ) gateError("invalid_evidence", "historical replay outcomes are incomplete");
  sha256Digest(
    outcomes.transcriptCommitmentHash,
    "historical replay transcript commitment",
  );
  recursivelyAssertNoForbiddenEvidenceKeys(root);
  return root as unknown as HistoricalReplayEvidencePayloadV1;
}

export function signHistoricalReplayEvidence(input: {
  payload: HistoricalReplayEvidencePayloadV1;
  signingKey: string | Buffer | KeyObject;
  keyId: string;
}): SignedHistoricalReplayEvidenceV1 {
  validateHistoricalReplayEvidencePayload(input.payload);
  return createStrictSignedEnvelope({
    envelopeSchemaVersion: SIGNED_HISTORICAL_REPLAY_SCHEMA,
    payload: input.payload,
    signingKey: input.signingKey,
    keyId: input.keyId,
  });
}

export function verifyHistoricalReplayEvidence(input: {
  value: unknown;
  verificationKey: string | Buffer | KeyObject;
  trustPolicy: unknown;
  expectedCandidate: HistoricalReplayCandidate;
  origin: string;
  runtimeSnapshot: LoadedRuntimeSnapshotV1;
  controlPlaneEvidenceHash: string;
  serviceInventoryHash: string;
  now?: string;
}): HistoricalReplayEvidencePayloadV1 {
  const trust = validateReleaseGateProducerTrustPolicyV1(input.trustPolicy);
  const fingerprint = releaseGateProducerKeyFingerprint(input.verificationKey);
  if (trust.approvedKeySha256 !== fingerprint) {
    gateError(
      "untrusted_replay_evidence",
      "historical replay evidence used an unapproved producer key",
    );
  }
  const verified = verifyStrictSignedEnvelope({
    value: input.value,
    verificationKey: input.verificationKey,
    envelopeSchemaVersion: SIGNED_HISTORICAL_REPLAY_SCHEMA,
    payloadLabel: "historical browser replay evidence",
    validatePayload: (value) => (
      validateHistoricalReplayEvidencePayload(value) as unknown as JsonRecord
    ),
  });
  if (verified.keyId !== trust.approvedKeyId) {
    gateError(
      "untrusted_replay_evidence",
      "historical replay evidence used an unapproved producer identity",
    );
  }
  const payload = verified.payload as unknown as HistoricalReplayEvidencePayloadV1;
  const now = input.now
    ? Date.parse(isoTimestamp(input.now, "historical replay verification time"))
    : Date.now();
  if (
    Date.parse(payload.generatedAt) > now + 5 * 60_000
    || now >= Date.parse(payload.expiresAt)
  ) gateError("expired_replay_evidence", "historical replay evidence is expired");
  if (
    stableStringify(payload.candidate)
      !== stableStringify(input.expectedCandidate)
    || payload.staging.originHash !== sha256(input.origin)
    || payload.staging.runtimeSnapshotHash
      !== input.runtimeSnapshot.snapshotHash
    || payload.staging.configurationHash
      !== input.runtimeSnapshot.configurationHash
    || payload.staging.runtimeHash !== input.runtimeSnapshot.runtimeHash
    || payload.staging.controlPlaneEvidenceHash
      !== input.controlPlaneEvidenceHash
    || payload.staging.serviceInventoryHash !== input.serviceInventoryHash
  ) {
    gateError(
      "replay_evidence_binding_mismatch",
      "historical replay evidence does not bind the exact staging candidate",
    );
  }
  return payload;
}

async function writeImmutableEvidence(
  path: string,
  value: unknown,
): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && "code" in error
      && error.code === "EEXIST"
    ) gateError("output_already_exists", "historical replay output already exists");
    gateError("output_write_failed", "historical replay evidence could not be written");
  }
}

function safeCliFailureCode(error: unknown): string {
  return error instanceof HistoricalReplayGateError
    && SAFE_API_CODE.test(error.code)
    ? error.code
    : "historical_replay_gate_failed";
}

async function runMode(args: HistoricalReplayRunArgs): Promise<{
  submissionCount: number;
  payloadHash: string;
}> {
  const corpus = await loadHistoricalReplayCorpus(args.corpusPath);
  assertHistoricalReplayPromotionCorpus(corpus);
  const [bindings, canarySecret, signingKey] = await Promise.all([
    loadHistoricalReplayStagingBindings({
      origin: args.origin,
      candidate: args.candidate,
      runtimeSnapshotPath: args.runtimeSnapshotPath,
      stagingControlPlaneEvidencePath:
        args.stagingControlPlaneEvidencePath,
      stagingControlPlaneVerificationKeyPath:
        args.stagingControlPlaneVerificationKeyPath,
      stagingControlPlaneTrustPolicyPath:
        args.stagingControlPlaneTrustPolicyPath,
    }),
    readCanarySecret(args.canaryHmacKeyPath),
    readEd25519PrivateKey(args.producerSigningKeyPath),
  ]);
  assertHistoricalReplayBudget({
    corpus,
    perRunBudgetCapUsd: args.perRunBudgetCapUsd,
    budgetRemainingUsd: bindings.budgetRemainingUsd,
    reservedForRequiredGatesUsd: bindings.reservedForRequiredGatesUsd,
  });
  const output = resolve(args.outputPath);
  if (
    [
      args.corpusPath,
      args.runtimeSnapshotPath,
      args.stagingControlPlaneEvidencePath,
      args.stagingControlPlaneVerificationKeyPath,
      args.stagingControlPlaneTrustPolicyPath,
      args.canaryHmacKeyPath,
      args.producerSigningKeyPath,
    ].map((path) => resolve(path)).includes(output)
  ) gateError("unsafe_output_path", "historical replay output path is unsafe");
  await readFile(output).then(
    () => gateError("output_already_exists", "historical replay output already exists"),
    (error) => {
      if (
        !error
        || typeof error !== "object"
        || !("code" in error)
        || error.code !== "ENOENT"
      ) gateError("output_write_failed", "historical replay output cannot be preflighted");
    },
  );
  await assertHistoricalReplayLivePreflight({
    origin: args.origin,
    candidate: args.candidate,
    runtimeSnapshot: bindings.runtimeSnapshot,
  });
  const transcriptKey = createHmac("sha256", canarySecret)
    .update(`historical-replay:${corpus.corpusCommitmentHash}`)
    .digest("hex");
  const driver = await PlaywrightHistoricalReplayDriver.create({
    origin: args.origin,
    candidate: args.candidate,
    runtimeSnapshot: bindings.runtimeSnapshot,
    canarySecret,
    transcriptKey,
    corpusCommitmentHash: corpus.corpusCommitmentHash,
  });
  let results: HistoricalReplayResult[];
  try {
    results = await runHistoricalReplayCorpus({
      corpus,
      driver,
      maximumConcurrency: args.maximumConcurrency,
    });
  } finally {
    await driver.close();
  }
  const payload = createHistoricalReplayEvidencePayload({
    candidate: args.candidate,
    origin: args.origin,
    runtimeSnapshot: bindings.runtimeSnapshot,
    controlPlaneEvidenceHash: bindings.controlPlaneEvidenceHash,
    serviceInventoryHash: bindings.serviceInventoryHash,
    corpus,
    results,
    maximumConcurrency: args.maximumConcurrency,
    perRunBudgetCapUsd: args.perRunBudgetCapUsd,
  });
  const signed = signHistoricalReplayEvidence({
    payload,
    signingKey,
    keyId: args.producerKeyId,
  });
  assertHistoricalReplayEvidenceIsSanitized(signed, corpus.privateValues);
  await writeImmutableEvidence(args.outputPath, signed);
  return {
    submissionCount: payload.outcomes.completedSubmissionCount,
    payloadHash: signed.payloadHash,
  };
}

async function verifyMode(args: HistoricalReplayVerifyArgs): Promise<{
  submissionCount: number;
  payloadHash: string;
}> {
  const [
    evidence,
    verificationKey,
    trustPolicy,
    bindings,
  ] = await Promise.all([
    readJson(args.evidencePath, "invalid_replay_evidence"),
    readEd25519PublicKey(args.verificationKeyPath),
    readJson(args.trustPolicyPath, "invalid_replay_evidence"),
    loadHistoricalReplayStagingBindings({
      origin: args.origin,
      candidate: args.candidate,
      runtimeSnapshotPath: args.runtimeSnapshotPath,
      stagingControlPlaneEvidencePath:
        args.stagingControlPlaneEvidencePath,
      stagingControlPlaneVerificationKeyPath:
        args.stagingControlPlaneVerificationKeyPath,
      stagingControlPlaneTrustPolicyPath:
        args.stagingControlPlaneTrustPolicyPath,
    }),
  ]);
  const payload = verifyHistoricalReplayEvidence({
    value: evidence,
    verificationKey,
    trustPolicy,
    expectedCandidate: args.candidate,
    origin: args.origin,
    runtimeSnapshot: bindings.runtimeSnapshot,
    controlPlaneEvidenceHash: bindings.controlPlaneEvidenceHash,
    serviceInventoryHash: bindings.serviceInventoryHash,
  });
  assertHistoricalReplayPromotionCorpus({
    corpusCommitmentHash: payload.corpus.commitmentHash,
    submissionCount: payload.corpus.submissionCount,
    maximumResearchBudgetUsd: payload.corpus.maximumResearchBudgetUsd,
    requiredBudgetReservationUsd:
      payload.corpus.requiredBudgetReservationUsd,
  });
  return {
    submissionCount: payload.outcomes.completedSubmissionCount,
    payloadHash: signedArtifactSha256(payload),
  };
}

export async function historicalReplayMain(
  argv: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const args = parseHistoricalReplayArgs(argv, environment);
  const result = args.mode === "run"
    ? await runMode(args)
    : await verifyMode(args);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    submissionCount: result.submissionCount,
    payloadHash: result.payloadHash,
  })}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  historicalReplayMain().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: safeCliFailureCode(error),
    })}\n`);
    process.exitCode = 1;
  });
}
