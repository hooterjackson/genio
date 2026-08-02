import {
  createHash,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  emitReleaseGateProducerArtifacts,
  loadReleaseProducerRuntimeSnapshot,
  preflightReleaseProducerFiles,
  releaseProducerCandidate,
  releaseProducerOption,
} from "./release-gate-producer.ts";
import {
  FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V1,
  type FinalPublicAssignmentProbeFixtureV1,
  releaseFixtureSha256,
  validateReleaseFixtureGuidancePayload,
  validateSitesControlPlaneSource,
} from "./release-fixtures.ts";
import {
  pipelineV3RolloutGroup,
} from "../server/query-plan-v3.ts";
import { signReleaseCanaryMetadata } from "../server/release-canary-metadata.ts";
import { sha256Hex, stableStringify } from "../server/security.ts";
import { createRunSpecV3 } from "../server/selection-plan-v3.ts";
import {
  PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
} from "../shared/public-rollout-evidence.ts";
import {
  sitesControlPlaneKeyFingerprint,
  sitesControlPlaneTrustPolicyV1,
  sitesControlPlaneVerificationKeyV1,
  verifySitesControlPlaneAttestation,
} from "../shared/sites-control-plane-attestation.ts";

const CONFIRMATION_FLAG = "--confirm-production-browser";
const PRODUCTION_ORIGIN = "https://9enio.com";
const DEADLINE_MS = 20 * 60_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const FINAL_ROLLOUT_STAGE =
  /^editorial_influence:(?:0|1|10|50|100)->100$/u;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function publicRunPayload(value: unknown): JsonRecord {
  const root = record(value, "public run response");
  return root.run && typeof root.run === "object" && !Array.isArray(root.run)
    ? record(root.run, "public run response run")
    : root;
}

function exactKeys(
  value: JsonRecord,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains missing or non-public fields`);
  }
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function publicAppleShareUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("public playlist shareUrl is invalid");
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "music.apple.com"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !/^\/[a-z]{2}\/playlist\/.+\/pl\.[0-9A-Za-z._-]+$/u.test(parsed.pathname)
  ) {
    throw new Error("public playlist shareUrl is invalid");
  }
  return parsed.toString();
}

export function validatePublicPlaylistDirectoryDto(
  value: unknown,
): { firstTitle: string; itemCount: number } {
  const root = record(value, "public playlist directory response");
  exactKeys(root, ["items", "page", "pageSize", "total", "totalPages"], "public playlist directory response");
  const page = positiveInteger(root.page, "public playlist directory page");
  const pageSize = positiveInteger(root.pageSize, "public playlist directory pageSize");
  const total = Number(root.total);
  const totalPages = Number(root.totalPages);
  if (
    page !== 1
    || pageSize !== 12
    || !Number.isSafeInteger(total)
    || total < 1
    || !Number.isSafeInteger(totalPages)
    || totalPages < 1
    || !Array.isArray(root.items)
    || root.items.length < 1
    || root.items.length > pageSize
    || total < root.items.length
  ) {
    throw new Error("public playlist directory pagination is invalid");
  }
  let firstTitle = "";
  const ids = new Set<string>();
  root.items.forEach((value, itemIndex) => {
    const item = record(value, `public playlist directory item ${itemIndex}`);
    exactKeys(item, [
      "id",
      "title",
      "trackCount",
      "volumeCount",
      "publishedAt",
      "volumes",
    ], `public playlist directory item ${itemIndex}`);
    const id = typeof item.id === "string" ? item.id : "";
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const trackCount = positiveInteger(
      item.trackCount,
      `public playlist directory item ${itemIndex} trackCount`,
    );
    const volumeCount = positiveInteger(
      item.volumeCount,
      `public playlist directory item ${itemIndex} volumeCount`,
    );
    if (!UUID.test(id) || ids.has(id) || !title || title.length > 160
      || typeof item.publishedAt !== "string"
      || !Number.isFinite(Date.parse(item.publishedAt))
      || new Date(item.publishedAt).toISOString() !== item.publishedAt
      || !Array.isArray(item.volumes)
      || item.volumes.length !== volumeCount) {
      throw new Error(`public playlist directory item ${itemIndex} is invalid`);
    }
    ids.add(id);
    if (itemIndex === 0) firstTitle = title;
    let volumeTracks = 0;
    item.volumes.forEach((value, volumeIndex) => {
      const volume = record(
        value,
        `public playlist directory item ${itemIndex} volume ${volumeIndex}`,
      );
      exactKeys(
        volume,
        ["volumeNumber", "name", "trackCount", "shareUrl"],
        `public playlist directory item ${itemIndex} volume ${volumeIndex}`,
      );
      const volumeTrackCount = positiveInteger(
        volume.trackCount,
        `public playlist directory item ${itemIndex} volume ${volumeIndex} trackCount`,
      );
      if (Number(volume.volumeNumber) !== volumeIndex + 1
        || typeof volume.name !== "string"
        || !volume.name.trim()
        || volume.name.length > 190) {
        throw new Error(`public playlist directory item ${itemIndex} volume ${volumeIndex} is invalid`);
      }
      publicAppleShareUrl(volume.shareUrl);
      volumeTracks += volumeTrackCount;
    });
    if (volumeTracks !== trackCount) {
      throw new Error(`public playlist directory item ${itemIndex} volume counts are invalid`);
    }
  });
  return { firstTitle, itemCount: root.items.length };
}

function remaining(deadlineAt: number, maximum: number): number {
  const value = deadlineAt - Date.now();
  if (value <= 0) throw new Error("final custom-domain browser producer exceeded its deadline");
  return Math.max(1, Math.min(value, maximum));
}

function browserReleaseCanary(input: {
  fixtureId: string;
  operation: "brief" | "run";
  sourceRevision: string;
  secret: string;
}): ReturnType<typeof signReleaseCanaryMetadata> {
  return signReleaseCanaryMetadata({
    version: "genio-release-canary/v1",
    canaryId: `v254-final-${
      createHash("sha256").update(input.fixtureId).digest("hex").slice(0, 20)
    }`,
    environment: "production",
    audience: PRODUCTION_ORIGIN,
    operation: input.operation,
    sourceRevision: input.sourceRevision,
    issuedAt: new Date().toISOString(),
    cacheMode: "reuse_disabled",
  }, input.secret);
}

export function assertFinalPublicAssignmentProbeFixtureClassifications(): void {
  const fixtureIds = new Set<string>();
  const intentGroups = new Set<string>();
  const governedIntentGroups = Object.keys(PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS);
  for (const fixture of FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V1) {
    const plan = createRunSpecV3({
      prompt: fixture.prompt,
      requestedTrackCount: fixture.targetTrackCount,
      storefront: "us",
    });
    const classifiedGroup = pipelineV3RolloutGroup(plan);
    if (
      fixtureIds.has(fixture.fixtureId)
      || classifiedGroup !== fixture.intentGroup
      || plan.criticalAmbiguities.length !== 0
    ) {
      throw new Error(
        `final public assignment fixture ${fixture.fixtureId} does not uniquely classify as ${fixture.intentGroup}`,
      );
    }
    fixtureIds.add(fixture.fixtureId);
    intentGroups.add(fixture.intentGroup);
  }
  if (
    FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V1.length !== 2
    || fixtureIds.size !== 2
    || intentGroups.size !== 1
    || !intentGroups.has("editorial_influence")
    || governedIntentGroups.filter(
      (group) => group !== "editorial_influence",
    ).some((group) => intentGroups.has(group))
  ) {
    throw new Error(
      "final browser assignment fixture must cover only editorial_influence",
    );
  }
}

assertFinalPublicAssignmentProbeFixtureClassifications();

export interface BrowserPublicAssignmentProbeResultV1 {
  postStatus: number;
  requestIdValid: boolean;
  rolloutEvidenceHash: string | null;
  rolloutStage: string | null;
  assignmentHash: string | null;
  assignmentReceiptHash: string | null;
  getStatus: number | null;
  contractVersion: number | null;
  guidancePayload: unknown;
  questionVisible: boolean;
  selectedOptionVisible: boolean;
  answerStatus: number | null;
  finalBriefStatus: string | null;
  runCreateStatus: number | null;
  runReused: boolean | null;
  runAccessIdValid: boolean;
  runAccessIdHash: string | null;
  runUiVisible: boolean;
  noPublishedUi: boolean;
  runGetStatus: number | null;
  resultGetStatus: number | null;
  executionRouteReceipt: unknown;
  resultPayload: unknown;
  manifestCanaryEvidence: unknown;
}

export interface FinalPublicAssignmentProbeEvidenceV1 {
  fixtureId: string;
  intentGroup: FinalPublicAssignmentProbeFixtureV1["intentGroup"];
  targetTrackCount: number;
  rolloutEvidenceHash: string | null;
  rolloutStage: string | null;
  assignmentHash: string | null;
  assignmentAuthority:
    | "signed_public_rollout"
    | "signed_release_canary"
    | "signed_public_direct_exposure";
  assignmentReceiptHash: string;
  publicPercentageBypass: boolean;
  organicAssignment: boolean;
  contractVersion: 3;
  guidancePolicyVersion: "adaptive_guidance_v5";
  questionSetHash: string;
  questionHash: string;
  axis: "influence_scope";
  selectedOptionId: "balanced_influence";
  answerAccepted: true;
  successorContractHash: string;
  queryPlanHash: string;
  executionRouteReceiptHash: string;
  runAccessIdHash: string;
  workerConsumptionReceiptHash: string;
  workerExecutionEffectHash: string;
  workerResultEffectHash: string;
  manifestCanaryEvidenceHash: string;
  qualifiedManifestHash: string;
  selectedTrackCount: 25;
  reserveTrackCount: number;
  attemptCount: number;
  executorIdentityHashes: string[];
  configurationHashes: string[];
  manifestOnly: true;
  appleWriteAccess: "forbidden";
  autoPublish: false;
  manifestRows: 0;
  matchingJobs: 0;
  publicationJobs: 0;
  publicationVolumeRows: 0;
  orphanPlaylistRows: 0;
  noPublishedUi: true;
  runReused: false;
  realUiPath: true;
}

export function validateBrowserPublicAssignmentProbeResultV1(input: {
  fixture: FinalPublicAssignmentProbeFixtureV1;
  result: BrowserPublicAssignmentProbeResultV1;
  assignmentMode?:
    | "public_rollout"
    | "pre_exposure_release_canary"
    | "direct_exposure";
  expectedRolloutEvidenceHash: string | null;
  expectedRolloutStage: string | null;
}): FinalPublicAssignmentProbeEvidenceV1 {
  const { result } = input;
  const preExposure = input.assignmentMode === "pre_exposure_release_canary";
  const directExposure = input.assignmentMode === "direct_exposure";
  const guidance = validateReleaseFixtureGuidancePayload(
    "irish-influence-recovery-25-v1",
    result.guidancePayload,
  );
  const route = record(
    result.executionRouteReceipt,
    "public assignment probe execution route receipt",
  );
  const publicResult = record(
    result.resultPayload,
    "public assignment probe result",
  );
  const manifestCanary = record(
    result.manifestCanaryEvidence,
    "public assignment probe manifest-only evidence",
  );
  const executionProof = record(
    publicResult.executionProof,
    "public assignment probe execution proof",
  );
  const workerConsumption = record(
    executionProof.workerConsumption,
    "public assignment probe worker consumption",
  );
  const zeroWrite = record(
    manifestCanary.zeroWriteProof,
    "public assignment probe zero-write proof",
  );
  const contractHash = typeof executionProof.contractHash === "string"
    ? executionProof.contractHash
    : "";
  const routeReceiptHash = typeof route.receiptHash === "string"
    ? route.receiptHash
    : "";
  const runAccessIdHash = result.runAccessIdHash ?? "";
  const assignmentReceiptHash = result.assignmentReceiptHash ?? "";
  const assignmentMatches = preExposure
    ? result.rolloutEvidenceHash === null
      && result.rolloutStage === null
      && result.assignmentHash === null
      && SHA256.test(assignmentReceiptHash)
      && route.assignmentKind === "signed_release_canary"
    : directExposure
      ? result.rolloutEvidenceHash === input.expectedRolloutEvidenceHash
        && result.rolloutStage
          === "editorial_influence:0->100:fully_exposed_unproven"
        && typeof result.assignmentHash === "string"
        && SHA256.test(result.assignmentHash)
        && route.assignmentKind === "signed_public_direct_exposure"
        && assignmentReceiptHash === result.assignmentHash
      : result.rolloutEvidenceHash === input.expectedRolloutEvidenceHash
      && result.rolloutStage === input.expectedRolloutStage
      && typeof result.assignmentHash === "string"
      && SHA256.test(result.assignmentHash)
      && route.assignmentKind === "signed_public_rollout"
      && assignmentReceiptHash === result.assignmentHash;
  if (
    (result.postStatus !== 200 && result.postStatus !== 202)
    || result.requestIdValid !== true
    || !assignmentMatches
    || result.getStatus !== 200
    || result.contractVersion !== 3
    || result.questionVisible !== true
    || result.selectedOptionVisible !== true
    || (result.answerStatus !== 200 && result.answerStatus !== 202)
    || result.finalBriefStatus !== "complete"
    || (result.runCreateStatus !== 200 && result.runCreateStatus !== 202)
    || result.runReused !== false
    || result.runAccessIdValid !== true
    || result.runUiVisible !== true
    || result.noPublishedUi !== true
    || result.runGetStatus !== 200
    || result.resultGetStatus !== 200
    || route.version !== "execution_route_receipt_v1"
    || route.trafficClass !== "synthetic"
    || route.guidanceVersion !== "adaptive_guidance_v5"
    || route.executionRoute !== "corpus_first_v3"
    || route.queryPlanSchema !== 6
    || !SHA256.test(assignmentReceiptHash)
    || route.intentGroup !== "editorial_influence"
    || !SHA256.test(routeReceiptHash)
    || !SHA256.test(contractHash)
    || !SHA256.test(runAccessIdHash)
    || publicResult.status !== "complete"
    || publicResult.totalTracks !== 0
    || publicResult.completedTracks !== 0
    || publicResult.manifest !== null
    || executionProof.contractHash !== contractHash
    || workerConsumption.status !== "consumed"
    || workerConsumption.questionSetHash !== guidance.questionSetHash
    || workerConsumption.questionHash !== guidance.questionHash
    || workerConsumption.selectedOptionId !== "balanced_influence"
    || workerConsumption.axis !== "influence_scope"
    || workerConsumption.contractSemanticHash !== contractHash
    || workerConsumption.executionField !== "rankingObjectives"
    || !SHA256.test(String(workerConsumption.queryPlanHash ?? ""))
    || !SHA256.test(String(workerConsumption.effectHash ?? ""))
    || !SHA256.test(String(workerConsumption.resultEffectHash ?? ""))
    || !SHA256.test(String(workerConsumption.receiptHash ?? ""))
    || manifestCanary.schemaVersion
      !== "genio-release-manifest-canary-evidence/v1"
    || manifestCanary.environment !== "production"
    || manifestCanary.sourceRevision !== route.releaseRevision
    || manifestCanary.executionMode !== "shadow"
    || manifestCanary.publicationBoundary !== "database_fenced"
    || manifestCanary.appleWriteAccess !== "forbidden"
    || manifestCanary.outcome !== "exact_ready"
    || manifestCanary.requestedTrackCount !== input.fixture.targetTrackCount
    || manifestCanary.selectedTrackCount !== input.fixture.targetTrackCount
    || !Number.isSafeInteger(manifestCanary.reserveTrackCount)
    || Number(manifestCanary.reserveTrackCount) < 1
    || !SHA256.test(String(manifestCanary.evidenceHash ?? ""))
    || !SHA256.test(String(manifestCanary.qualifiedManifestHash ?? ""))
    || !Array.isArray(manifestCanary.attempts)
    || manifestCanary.attempts.length < 1
    || !Array.isArray(manifestCanary.executorIdentityHashes)
    || manifestCanary.executorIdentityHashes.length < 1
    || !Array.isArray(manifestCanary.configurationHashes)
    || manifestCanary.configurationHashes.length !== 1
    || zeroWrite.autoPublish !== false
    || zeroWrite.manifestRows !== 0
    || zeroWrite.matchingJobs !== 0
    || zeroWrite.publicationJobs !== 0
    || zeroWrite.publicationVolumeRows !== 0
    || zeroWrite.orphanPlaylistRows !== 0
    || guidance.selectedOptionId !== "balanced_influence"
  ) {
    throw new Error(
      `public assignment probe ${input.fixture.fixtureId} did not prove exact manifest-only UI execution and the Apple write fence`,
    );
  }
  return {
    fixtureId: input.fixture.fixtureId,
    intentGroup: input.fixture.intentGroup,
    targetTrackCount: input.fixture.targetTrackCount,
    rolloutEvidenceHash: result.rolloutEvidenceHash,
    rolloutStage: result.rolloutStage,
    assignmentHash: result.assignmentHash,
    assignmentAuthority: preExposure
      ? "signed_release_canary"
      : directExposure
        ? "signed_public_direct_exposure"
        : "signed_public_rollout",
    assignmentReceiptHash,
    publicPercentageBypass: preExposure,
    organicAssignment: !preExposure && !directExposure,
    contractVersion: 3,
    guidancePolicyVersion: "adaptive_guidance_v5",
    questionSetHash: guidance.questionSetHash,
    questionHash: guidance.questionHash,
    axis: "influence_scope",
    selectedOptionId: "balanced_influence",
    answerAccepted: true,
    successorContractHash: contractHash,
    queryPlanHash: String(workerConsumption.queryPlanHash),
    executionRouteReceiptHash: routeReceiptHash,
    runAccessIdHash,
    workerConsumptionReceiptHash: String(workerConsumption.receiptHash),
    workerExecutionEffectHash: String(workerConsumption.effectHash),
    workerResultEffectHash: String(workerConsumption.resultEffectHash),
    manifestCanaryEvidenceHash: String(manifestCanary.evidenceHash),
    qualifiedManifestHash: String(manifestCanary.qualifiedManifestHash),
    selectedTrackCount: 25,
    reserveTrackCount: Number(manifestCanary.reserveTrackCount),
    attemptCount: manifestCanary.attempts.length,
    executorIdentityHashes:
      [...manifestCanary.executorIdentityHashes] as string[],
    configurationHashes:
      [...manifestCanary.configurationHashes] as string[],
    manifestOnly: true,
    appleWriteAccess: "forbidden",
    autoPublish: false,
    manifestRows: 0,
    matchingJobs: 0,
    publicationJobs: 0,
    publicationVolumeRows: 0,
    orphanPlaylistRows: 0,
    noPublishedUi: true,
    runReused: false,
    realUiPath: true,
  };
}

export interface FinalCustomDomainBrowserProducerArgs {
  origin: typeof PRODUCTION_ORIGIN;
  expectedRevision: string;
  expectedVersion: string;
  assignmentMode:
    | "public_rollout"
    | "pre_exposure_release_canary"
    | "direct_exposure";
  expectedPublicRolloutEvidenceHash: string | null;
  expectedPublicRolloutStage: string | null;
  expectedDirectExposureAuthorityHash: string | null;
  candidateTag: string;
  imageDigest: string;
  runtimeSnapshotPath: string;
  sitesControlPlaneEvidencePath: string;
  sitesControlPlaneAttestationPath: string;
  sitesControlPlaneVerificationKeyPath: string;
  trustedSitesControlPlaneKeyFingerprint: string;
  trustedSitesControlPlaneKeyId: string;
  browserArtifactDirectory: string;
  files: {
    sourceOutputPath: string;
    artifactOutputPath: string;
    attestationOutputPath: string;
    producerSigningKeyPath: string;
    producerKeyId: string;
  };
}

export function parseFinalCustomDomainBrowserProducerArgs(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): FinalCustomDomainBrowserProducerArgs {
  const allowed = new Set([
    CONFIRMATION_FLAG,
    "--origin",
    "--expected-revision",
    "--expected-version",
    "--expected-public-rollout-evidence-hash",
    "--expected-public-rollout-stage",
    "--expected-direct-exposure-authority-hash",
    "--pre-exposure-clean-nonowner",
    "--direct-exposure",
    "--candidate-tag",
    "--image-digest",
    "--runtime-snapshot",
    "--sites-control-plane-evidence",
    "--sites-control-plane-attestation",
    "--sites-control-plane-verification-key",
    "--browser-artifact-dir",
    "--source-output",
    "--output",
    "--attestation-output",
    "--producer-signing-key",
    "--producer-key-id",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!allowed.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    if (
      argument !== CONFIRMATION_FLAG
      && argument !== "--pre-exposure-clean-nonowner"
      && argument !== "--direct-exposure"
    ) index += 1;
  }
  if (argv.filter((value) => value === CONFIRMATION_FLAG).length !== 1) {
    throw new Error(`Final production browser evidence requires ${CONFIRMATION_FLAG}`);
  }
  const preExposureCount = argv.filter(
    (value) => value === "--pre-exposure-clean-nonowner",
  ).length;
  if (preExposureCount > 1) {
    throw new Error("--pre-exposure-clean-nonowner may be provided once");
  }
  const directExposureCount = argv.filter(
    (value) => value === "--direct-exposure",
  ).length;
  if (directExposureCount > 1 || preExposureCount + directExposureCount > 1) {
    throw new Error("browser assignment mode may be selected exactly once");
  }
  const assignmentMode = preExposureCount === 1
    ? "pre_exposure_release_canary"
    : directExposureCount === 1
      ? "direct_exposure"
      : "public_rollout";
  const configuredOrigin = environment.RELEASE_PRODUCTION_ORIGIN?.trim() ?? "";
  const origin = releaseProducerOption(argv, "--origin");
  if (origin !== PRODUCTION_ORIGIN
    || configuredOrigin !== PRODUCTION_ORIGIN) {
    throw new Error("--origin must exactly match the configured https://9enio.com origin");
  }
  const expectedRevision = releaseProducerOption(argv, "--expected-revision").toLowerCase();
  const expectedVersion = releaseProducerOption(argv, "--expected-version");
  const rolloutHashCount = argv.filter(
    (value) => value === "--expected-public-rollout-evidence-hash",
  ).length;
  const rolloutStageCount = argv.filter(
    (value) => value === "--expected-public-rollout-stage",
  ).length;
  const directAuthorityCount = argv.filter(
    (value) => value === "--expected-direct-exposure-authority-hash",
  ).length;
  if (
    assignmentMode === "public_rollout"
      ? rolloutHashCount !== 1
        || rolloutStageCount !== 1
        || directAuthorityCount !== 0
      : assignmentMode === "direct_exposure"
        ? rolloutHashCount !== 0
          || rolloutStageCount !== 0
          || directAuthorityCount !== 1
        : rolloutHashCount !== 0
          || rolloutStageCount !== 0
          || directAuthorityCount !== 0
  ) {
    throw new Error(assignmentMode === "public_rollout"
      ? "--expected-public-rollout-evidence-hash and --expected-public-rollout-stage are required exactly once"
      : assignmentMode === "direct_exposure"
        ? "--expected-direct-exposure-authority-hash is required exactly once and public rollout markers are forbidden"
        : "public rollout and direct exposure markers are forbidden for the pre-exposure browser gate");
  }
  const expectedPublicRolloutEvidenceHash = rolloutHashCount === 1
    ? releaseProducerOption(argv, "--expected-public-rollout-evidence-hash")
    : null;
  const expectedPublicRolloutStage = rolloutStageCount === 1
    ? releaseProducerOption(argv, "--expected-public-rollout-stage")
    : null;
  const expectedDirectExposureAuthorityHash = directAuthorityCount === 1
    ? releaseProducerOption(
        argv,
        "--expected-direct-exposure-authority-hash",
      ).toLowerCase()
    : null;
  if (
    expectedPublicRolloutEvidenceHash !== null
    && !SHA256.test(expectedPublicRolloutEvidenceHash)
  ) throw new Error("--expected-public-rollout-evidence-hash is invalid");
  if (
    expectedPublicRolloutStage !== null
    && !FINAL_ROLLOUT_STAGE.test(expectedPublicRolloutStage)
  ) throw new Error(
    "--expected-public-rollout-stage must encode editorial_influence transitioning to 100%",
  );
  if (
    expectedDirectExposureAuthorityHash !== null
    && !SHA256.test(expectedDirectExposureAuthorityHash)
  ) throw new Error("--expected-direct-exposure-authority-hash is invalid");
  const candidateTag = releaseProducerOption(argv, "--candidate-tag");
  const imageDigest = releaseProducerOption(argv, "--image-digest");
  releaseProducerCandidate({
    tag: candidateTag,
    version: expectedVersion,
    sourceRevision: expectedRevision,
    imageDigest,
  });
  const trustedSitesControlPlaneKeyFingerprint =
    environment.RELEASE_SITES_CONTROL_PLANE_KEY_SHA256?.trim() ?? "";
  const trustedSitesControlPlaneKeyId =
    environment.RELEASE_SITES_CONTROL_PLANE_KEY_ID?.trim() ?? "";
  if (!/^[0-9a-f]{64}$/u.test(trustedSitesControlPlaneKeyFingerprint)
    || !/^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u.test(
      trustedSitesControlPlaneKeyId,
    )) {
    throw new Error(
      "protected Sites control-plane key fingerprint and key ID are required",
    );
  }
  return {
    origin: PRODUCTION_ORIGIN,
    expectedRevision,
    expectedVersion,
    assignmentMode,
    expectedPublicRolloutEvidenceHash,
    expectedPublicRolloutStage,
    expectedDirectExposureAuthorityHash,
    candidateTag,
    imageDigest,
    runtimeSnapshotPath: releaseProducerOption(argv, "--runtime-snapshot"),
    sitesControlPlaneEvidencePath:
      releaseProducerOption(argv, "--sites-control-plane-evidence"),
    sitesControlPlaneAttestationPath:
      releaseProducerOption(argv, "--sites-control-plane-attestation"),
    sitesControlPlaneVerificationKeyPath:
      releaseProducerOption(argv, "--sites-control-plane-verification-key"),
    trustedSitesControlPlaneKeyFingerprint,
    trustedSitesControlPlaneKeyId,
    browserArtifactDirectory: releaseProducerOption(argv, "--browser-artifact-dir"),
    files: {
      sourceOutputPath: releaseProducerOption(argv, "--source-output"),
      artifactOutputPath: releaseProducerOption(argv, "--output"),
      attestationOutputPath: releaseProducerOption(argv, "--attestation-output"),
      producerSigningKeyPath: releaseProducerOption(argv, "--producer-signing-key"),
      producerKeyId: releaseProducerOption(argv, "--producer-key-id"),
    },
  };
}

async function readSitesControlPlaneEvidence(path: string): Promise<JsonRecord> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(
      "--sites-control-plane-evidence must identify actual connector-produced JSON evidence",
    );
  }
  return record(value, "Sites control-plane evidence");
}

async function readRequiredJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} must identify readable JSON evidence`);
  }
}

async function verifySitesControlPlaneProvenance(input: {
  args: FinalCustomDomainBrowserProducerArgs;
  receipt: JsonRecord;
}): Promise<{
  attestation: unknown;
  trust: JsonRecord;
  verificationKey: ReturnType<typeof sitesControlPlaneVerificationKeyV1>;
  trustPolicy: ReturnType<typeof sitesControlPlaneTrustPolicyV1>;
}> {
  const [attestation, verificationKeyBytes, producerKeyBytes] = await Promise.all([
    readRequiredJson(
      input.args.sitesControlPlaneAttestationPath,
      "--sites-control-plane-attestation",
    ),
    readFile(input.args.sitesControlPlaneVerificationKeyPath),
    readFile(input.args.files.producerSigningKeyPath),
  ]);
  let verificationKey;
  let producerPublicKey;
  try {
    verificationKey = createPublicKey(verificationKeyBytes);
    producerPublicKey = createPublicKey(createPrivateKey(producerKeyBytes));
  } catch {
    throw new Error(
      "--sites-control-plane-verification-key must identify an Ed25519 public key",
    );
  }
  if (verificationKey.asymmetricKeyType !== "ed25519"
    || producerPublicKey.asymmetricKeyType !== "ed25519"
    || sitesControlPlaneKeyFingerprint(verificationKey)
      === sitesControlPlaneKeyFingerprint(producerPublicKey)) {
    throw new Error(
      "Sites control-plane attestation must use the distinct protected connector key",
    );
  }
  const verified = verifySitesControlPlaneAttestation({
    value: attestation,
    verificationKey,
    expectedReceiptHash: String(input.receipt.evidenceHash),
    expectedKeyId: input.args.trustedSitesControlPlaneKeyId,
    expectedKeyFingerprint:
      input.args.trustedSitesControlPlaneKeyFingerprint,
  });
  const trustUnsigned = {
    schemaVersion: "genio-sites-control-plane-trust-verification/v1",
    receiptHash: input.receipt.evidenceHash,
    attestationPayloadHash: verified.payloadHash,
    trustedKeyId: verified.keyId,
    verificationKeyFingerprint: verified.verificationKeyFingerprint,
    verifiedAt: new Date().toISOString(),
  };
  return {
    attestation,
    verificationKey: sitesControlPlaneVerificationKeyV1(verificationKey),
    trustPolicy: sitesControlPlaneTrustPolicyV1({
      approvedKeyId: input.args.trustedSitesControlPlaneKeyId,
      approvedKeySha256:
        input.args.trustedSitesControlPlaneKeyFingerprint,
    }),
    trust: {
      ...trustUnsigned,
      evidenceHash: releaseFixtureSha256(trustUnsigned),
    },
  };
}

export async function collectFinalCustomDomainBrowserEvidence(input: {
  origin: typeof PRODUCTION_ORIGIN;
  candidateRevision: string;
  candidateVersion: string;
  assignmentMode?:
    | "public_rollout"
    | "pre_exposure_release_canary"
    | "direct_exposure";
  expectedPublicRolloutEvidenceHash: string | null;
  expectedPublicRolloutStage: string | null;
  expectedDirectExposureAuthorityHash?: string | null;
  releaseCanarySecret: string;
  artifactDirectory: string;
  deadlineAt: number;
}): Promise<JsonRecord> {
  const { chromium } = await import("@playwright/test");
  const directory = resolve(input.artifactDirectory);
  await mkdir(directory, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    timeout: remaining(input.deadlineAt, 30_000),
  });
  try {
    const context = await browser.newContext({
      locale: "en-US",
      ignoreHTTPSErrors: false,
      storageState: { cookies: [], origins: [] },
    });
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
    const aboutResponse = await page.goto(`${input.origin}/about?release-browser=1`, {
      waitUntil: "networkidle",
      timeout: remaining(input.deadlineAt, 45_000),
    });
    if (!aboutResponse || aboutResponse.status() !== 200
      || new URL(page.url()).origin !== input.origin) {
      throw new Error("production custom-domain about page is unavailable");
    }
    const aboutHtml = await page.locator("html").getAttribute("data-build-revision");
    const version = await page.locator("html").getAttribute("data-build-version");
    if (aboutHtml !== input.candidateRevision || version !== input.candidateVersion) {
      throw new Error("production custom-domain page does not expose the candidate identity");
    }
    const aboutScreenshot = await page.screenshot({
      fullPage: true,
      path: resolve(directory, "production-about.png"),
      timeout: remaining(input.deadlineAt, 30_000),
    });

    const directoryResponsePromise = page.waitForResponse((response) => (
      response.url().startsWith(`${input.origin}/api/v1/playlists?`)
    ), { timeout: remaining(input.deadlineAt, 30_000) });
    const navigation = await page.goto(`${input.origin}/playlists?release-browser=1`, {
      waitUntil: "domcontentloaded",
      timeout: remaining(input.deadlineAt, 45_000),
    });
    if (!navigation || navigation.status() !== 200) {
      throw new Error("production public playlist directory is unavailable");
    }
    const directoryResponse = await directoryResponsePromise;
    if (directoryResponse.status() !== 200) {
      throw new Error("production public playlist directory API failed");
    }
    const directoryPayload = await directoryResponse.json();
    const publicDirectory = validatePublicPlaylistDirectoryDto(directoryPayload);
    await page.getByRole("heading", { name: "Explore playlists" })
      .waitFor({ state: "visible", timeout: remaining(input.deadlineAt, 20_000) });
    const playlistCards = page.locator(".directory-playlist");
    if (await playlistCards.count() < 1) {
      throw new Error("production public playlist contents are not visible");
    }
    await page.getByRole("heading", { name: publicDirectory.firstTitle, exact: true })
      .first()
      .waitFor({ state: "visible", timeout: remaining(input.deadlineAt, 20_000) });
    const appleLinks = page.locator('a[href^="https://music.apple.com/"]');
    if (await appleLinks.count() < 1) {
      throw new Error("production public playlist contents have no visible Apple link");
    }
    const directoryScreenshot = await page.screenshot({
      fullPage: true,
      path: resolve(directory, "production-playlists.png"),
      timeout: remaining(input.deadlineAt, 30_000),
    });
    const publicAssignmentProbes: FinalPublicAssignmentProbeEvidenceV1[] = [];
    const canaryCredential = input.releaseCanarySecret;
    for (const fixture of FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V1) {
      remaining(input.deadlineAt, 1);
      const briefCanary = browserReleaseCanary({
        fixtureId: fixture.fixtureId,
        operation: "brief",
        sourceRevision: input.candidateRevision,
        secret: canaryCredential,
      });
      const runCanary = browserReleaseCanary({
        fixtureId: fixture.fixtureId,
        operation: "run",
        sourceRevision: input.candidateRevision,
        secret: canaryCredential,
      });
      const runCanaryUnsigned = Object.fromEntries(
        Object.entries(runCanary).filter(([key]) => key !== "signature"),
      );
      const releaseCanaryAssignmentReceiptHash = sha256Hex(stableStringify({
        kind: "authenticated_release_canary_owner_v1",
        metadata: runCanaryUnsigned,
      }));
      const briefRoutePattern = `${input.origin}/api/v1/brief`;
      const runRoutePattern = `${input.origin}/api/v1/runs`;
      await page.route(briefRoutePattern, async (route) => {
        const request = route.request();
        if (request.method() !== "POST") {
          await route.continue();
          return;
        }
        await route.continue({
          postData: JSON.stringify({
            ...record(request.postDataJSON(), "real UI brief request body"),
            releaseCanary: briefCanary,
          }),
          headers: {
            ...request.headers(),
            "content-type": "application/json",
          },
        });
      });
      await page.route(runRoutePattern, async (route) => {
        const request = route.request();
        if (request.method() !== "POST") {
          await route.continue();
          return;
        }
        await route.continue({
          postData: JSON.stringify({
            ...record(request.postDataJSON(), "real UI run request body"),
            manifestOnly: true,
            releaseCanary: runCanary,
          }),
          headers: {
            ...request.headers(),
            "content-type": "application/json",
          },
        });
      });
      const briefPayloads: Array<{
        status: number;
        method: string;
        value: JsonRecord;
      }> = [];
      const captureBriefResponse = async (
        response: import("@playwright/test").Response,
      ) => {
        const url = new URL(response.url());
        if (
          url.origin !== input.origin
          || !url.pathname.startsWith("/api/v1/brief")
        ) return;
        try {
          const value = await response.json() as unknown;
          if (value && typeof value === "object" && !Array.isArray(value)) {
            briefPayloads.push({
              status: response.status(),
              method: response.request().method(),
              value: value as JsonRecord,
            });
          }
        } catch {
          // A non-JSON response fails the durable payload assertions below.
        }
      };
      page.on("response", captureBriefResponse);
      const createNavigation = await page.goto(
        `${input.origin}/?release-browser=1&fixture=${
          encodeURIComponent(fixture.fixtureId)
        }`,
        {
          waitUntil: "domcontentloaded",
          timeout: remaining(input.deadlineAt, 45_000),
        },
      );
      if (!createNavigation || createNavigation.status() !== 200) {
        throw new Error("production Create UI is unavailable");
      }
      const requestField = page.getByRole(
        "textbox",
        { name: /playlist request/iu },
      );
      await requestField.waitFor({
        state: "visible",
        timeout: remaining(input.deadlineAt, 20_000),
      });
      await requestField.fill(fixture.prompt);
      const countButton = page.getByRole(
        "button",
        { name: new RegExp(`^${fixture.targetTrackCount} tracks$`, "iu") },
      );
      await countButton.click();
      const initialBriefResponsePromise = page.waitForResponse(
        (response) => (
          response.request().method() === "POST"
          && response.url() === `${input.origin}/api/v1/brief`
        ),
        { timeout: remaining(input.deadlineAt, 45_000) },
      );
      await page.getByRole("button", { name: /create playlist/iu }).click();
      const initialBriefResponse = await initialBriefResponsePromise;
      const initialPayload = record(
        await initialBriefResponse.json(),
        "real UI initial brief response",
      );
      const requestId = typeof initialPayload.requestId === "string"
        ? initialPayload.requestId
        : "";
      const requestIdValid = UUID.test(requestId);
      const questionHeading = page.getByRole("heading", {
        name: /Which kind of influence should/iu,
      });
      await questionHeading.waitFor({
        state: "visible",
        timeout: remaining(input.deadlineAt, 90_000),
      });
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (briefPayloads.some(({ value }) => (
          value.status === "awaiting_answers"
          && Array.isArray(value.questions)
          && value.questions.length > 0
        ))) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      const guidanceResponse = [...briefPayloads].reverse().find(
        ({ value }) => (
          value.status === "awaiting_answers"
          && Array.isArray(value.questions)
          && value.questions.length > 0
        ),
      );
      const guidanceValue = guidanceResponse?.value ?? {};
      const guidancePayload = {
        questionSetHash:
          typeof guidanceValue.questionSetHash === "string"
            ? guidanceValue.questionSetHash
            : "",
        questions: Array.isArray(guidanceValue.questions)
          ? guidanceValue.questions
          : [],
      };
      const balancedOption = page.locator("label.guided-option-card")
        .filter({ hasText: "Balanced" })
        .first();
      await balancedOption.waitFor({
        state: "visible",
        timeout: remaining(input.deadlineAt, 20_000),
      });
      const questionVisible = await questionHeading.isVisible();
      const selectedOptionVisible = await balancedOption.isVisible();
      await balancedOption.click();
      const answerResponsePromise = page.waitForResponse(
        (response) => (
          response.request().method() === "POST"
          && response.url() ===
            `${input.origin}/api/v1/brief/${requestId}/answers`
        ),
        { timeout: remaining(input.deadlineAt, 60_000) },
      );
      const runResponsePromise = page.waitForResponse(
        (response) => (
          response.request().method() === "POST"
          && response.url() === `${input.origin}/api/v1/runs`
        ),
        { timeout: remaining(input.deadlineAt, 90_000) },
      );
      await page.getByRole("button", { name: /create playlist/iu }).click();
      const answerResponse = await answerResponsePromise;
      const answerPayload = record(
        await answerResponse.json(),
        "real UI guidance answer response",
      );
      const runResponse = await runResponsePromise;
      const runPayload = record(
        await runResponse.json(),
        "real UI run creation response",
      );
      const runRoot = runPayload.run
        ? record(runPayload.run, "real UI run")
        : runPayload;
      const runAccessId = typeof runRoot.id === "string" ? runRoot.id : "";
      const runAccessIdValid = UUID.test(runAccessId);
      const runReused = typeof runPayload.reused === "boolean"
        ? runPayload.reused
        : null;
      const workingHeading = page.getByRole("heading", {
        name: /Researching your playlist|Review your playlist|Your playlist/iu,
      });
      await workingHeading.first().waitFor({
        state: "visible",
        timeout: remaining(input.deadlineAt, 60_000),
      });
      let runReread: { status: number; value: unknown } = {
        status: 0,
        value: {},
      };
      let runApi: JsonRecord = {};
      let manifestCanaryEvidence: unknown = null;
      while (true) {
        remaining(input.deadlineAt, 1);
        runReread = await page.evaluate(async (accessId) => {
          const response = await fetch(
            `/api/v1/runs/${encodeURIComponent(accessId)}`,
            {
              cache: "no-store",
              credentials: "same-origin",
            },
          );
          let value: unknown = {};
          try {
            value = await response.json();
          } catch {
            value = {};
          }
          return { status: response.status, value };
        }, runAccessId);
        runApi = publicRunPayload(runReread.value);
        const evidenceReread = await page.evaluate(async (accessId) => {
          const response = await fetch(
            `/api/v1/runs/${
              encodeURIComponent(accessId)
            }/manifest-canary-evidence`,
            {
              cache: "no-store",
              credentials: "same-origin",
            },
          );
          let value: unknown = {};
          try {
            value = await response.json();
          } catch {
            value = {};
          }
          return { status: response.status, value };
        }, runAccessId);
        if (evidenceReread.status === 200) {
          manifestCanaryEvidence = evidenceReread.value;
          break;
        }
        const evidenceError = evidenceReread.value
          && typeof evidenceReread.value === "object"
          && !Array.isArray(evidenceReread.value)
          ? evidenceReread.value as JsonRecord
          : {};
        if (
          evidenceReread.status !== 409
          || evidenceError.code !== "release_manifest_canary_incomplete"
        ) {
          throw new Error(
            "fresh public Irish manifest-only evidence endpoint failed closed",
          );
        }
        if ([
            "failed",
            "failed_system",
            "failed_integrity",
            "cancelled",
          ].includes(String(runApi.status))) {
          throw new Error(
            `fresh public Irish run reached ${String(
              runApi.status,
            )} before its exact shadow manifest`,
          );
        }
        await page.waitForTimeout(2_000);
      }
      const resultReread = await page.evaluate(async (accessId) => {
        const response = await fetch(
          `/api/v1/runs/${encodeURIComponent(accessId)}/result`,
          {
            cache: "no-store",
            credentials: "same-origin",
          },
        );
        let value: unknown = {};
        try {
          value = await response.json();
        } catch {
          value = {};
        }
        return { status: response.status, value };
      }, runAccessId);
      const completedHeading = page.getByRole("heading", {
        name: "Playlist published",
        exact: true,
      });
      const noPublishedUi = !(await completedHeading.isVisible());
      const completeBrief = [...briefPayloads].reverse().find(
        ({ value }) => value.status === "complete",
      );
      const probeResult: BrowserPublicAssignmentProbeResultV1 = {
        postStatus: initialBriefResponse.status(),
        requestIdValid,
        rolloutEvidenceHash:
          input.assignmentMode === "direct_exposure"
            ? initialBriefResponse.headers()[
              "x-genio-direct-exposure-authority-hash"
            ] ?? null
            : initialBriefResponse.headers()[
              "x-genio-public-rollout-evidence-hash"
            ] ?? null,
        rolloutStage:
          input.assignmentMode === "direct_exposure"
            ? initialBriefResponse.headers()[
              "x-genio-direct-exposure-stage"
            ] ?? null
            : initialBriefResponse.headers()[
              "x-genio-public-rollout-stage"
            ] ?? null,
        assignmentHash:
          input.assignmentMode === "direct_exposure"
            ? initialBriefResponse.headers()[
              "x-genio-direct-exposure-assignment-hash"
            ] ?? null
            : initialBriefResponse.headers()[
              "x-genio-public-rollout-assignment-hash"
            ] ?? null,
        assignmentReceiptHash:
          input.assignmentMode === "pre_exposure_release_canary"
            ? releaseCanaryAssignmentReceiptHash
            : input.assignmentMode === "direct_exposure"
              ? initialBriefResponse.headers()[
                "x-genio-direct-exposure-assignment-hash"
              ] ?? null
            : initialBriefResponse.headers()[
              "x-genio-public-rollout-assignment-hash"
            ] ?? null,
        getStatus: guidanceResponse?.status ?? null,
        contractVersion:
          typeof guidanceValue.briefContractVersion === "number"
            ? guidanceValue.briefContractVersion
            : null,
        guidancePayload,
        questionVisible,
        selectedOptionVisible,
        answerStatus: answerResponse.status(),
        finalBriefStatus:
          answerPayload.status === "complete" || completeBrief
            ? "complete"
            : null,
        runCreateStatus: runResponse.status(),
        runReused,
        runAccessIdValid,
        runAccessIdHash: runAccessIdValid
          ? createHash("sha256").update(runAccessId).digest("hex")
          : null,
        runUiVisible: await workingHeading.first().isVisible(),
        noPublishedUi,
        runGetStatus: runReread.status,
        resultGetStatus: resultReread.status,
        executionRouteReceipt: runApi.executionRouteReceipt ?? null,
        resultPayload: resultReread.value,
        manifestCanaryEvidence,
      };
      publicAssignmentProbes.push(
        validateBrowserPublicAssignmentProbeResultV1({
          fixture,
          result: probeResult,
          assignmentMode: input.assignmentMode,
          expectedRolloutEvidenceHash:
            input.assignmentMode === "direct_exposure"
              ? input.expectedDirectExposureAuthorityHash ?? null
              : input.expectedPublicRolloutEvidenceHash,
          expectedRolloutStage: input.expectedPublicRolloutStage,
        }),
      );
      page.off("response", captureBriefResponse);
      await page.unroute(briefRoutePattern);
      await page.unroute(runRoutePattern);
    }
    remaining(input.deadlineAt, 1);
    const runScreenshot = await page.screenshot({
      fullPage: true,
      path: resolve(directory, "production-guidance-run.png"),
      timeout: remaining(input.deadlineAt, 30_000),
    });
    const observedAt = new Date().toISOString();
    if (directRailwayRequests.length > 0) {
      throw new Error(
        "production browser made a direct request to Railway instead of the custom domain",
      );
    }
    const serializedPublicAssignmentProbes =
      input.assignmentMode !== "public_rollout"
        ? publicAssignmentProbes
        : publicAssignmentProbes.map((probe) => {
            const serialized = { ...probe } as Record<string, unknown>;
            delete serialized.assignmentAuthority;
            delete serialized.assignmentReceiptHash;
            delete serialized.publicPercentageBypass;
            delete serialized.organicAssignment;
            delete serialized.queryPlanHash;
            return serialized;
          });
    const unsigned = {
      schemaVersion: input.assignmentMode === "pre_exposure_release_canary"
        ? "genio-final-custom-domain-browser/v7"
        : input.assignmentMode === "direct_exposure"
          ? "genio-final-custom-domain-browser/v8"
          : "genio-final-custom-domain-browser/v6",
      ...(input.assignmentMode !== "public_rollout"
        ? { assignmentMode: input.assignmentMode }
        : {}),
      ...(input.assignmentMode === "direct_exposure"
        ? {
            exposureClass: "fully_exposed_unproven" as const,
            organicReliabilityProven: false as const,
          }
        : {}),
      origin: input.origin,
      candidateRevision: input.candidateRevision,
      observedAt,
      tlsValid: true,
      releaseIdentityVisible: true,
      anonymousPlaylistDirectory: true,
      publicPlaylistContentsVisible: true,
      privacyProjectionPassed: true,
      noDirectRailwayRequests: true,
      screenshotHashes: [aboutScreenshot, directoryScreenshot, runScreenshot]
        .map((bytes) => createHash("sha256").update(bytes).digest("hex")),
      publicAssignmentProbes: serializedPublicAssignmentProbes,
    };
    return {
      ...unsigned,
      evidenceHash: releaseFixtureSha256(unsigned),
    };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const args = parseFinalCustomDomainBrowserProducerArgs(process.argv.slice(2));
  await preflightReleaseProducerFiles(args.files);
  const deadlineAt = Date.now() + DEADLINE_MS;
  const candidate = releaseProducerCandidate({
    tag: args.candidateTag,
    version: args.expectedVersion,
    sourceRevision: args.expectedRevision,
    imageDigest: args.imageDigest,
  });
  const runtimeSnapshot = await loadReleaseProducerRuntimeSnapshot({
    path: args.runtimeSnapshotPath,
    environment: "production",
    expectedScope: "full",
    origin: args.origin,
    candidate,
  });
  const sitesControlPlane = await readSitesControlPlaneEvidence(
    args.sitesControlPlaneEvidencePath,
  );
  validateSitesControlPlaneSource(sitesControlPlane, candidate);
  const sitesProvenance = await verifySitesControlPlaneProvenance({
    args,
    receipt: sitesControlPlane,
  });
  const releaseCanarySecret =
    process.env.RELEASE_CANARY_HMAC_SECRET?.trim() ?? "";
  if (Buffer.byteLength(releaseCanarySecret, "utf8") < 32) {
    throw new Error(
      "RELEASE_CANARY_HMAC_SECRET is required for the signed public manifest-only probe",
    );
  }
  const browserEvidence = await collectFinalCustomDomainBrowserEvidence({
    origin: args.origin,
    candidateRevision: args.expectedRevision,
    candidateVersion: args.expectedVersion,
    assignmentMode: args.assignmentMode,
    expectedPublicRolloutEvidenceHash:
      args.expectedPublicRolloutEvidenceHash,
    expectedPublicRolloutStage: args.expectedPublicRolloutStage,
    expectedDirectExposureAuthorityHash:
      args.expectedDirectExposureAuthorityHash,
    releaseCanarySecret,
    artifactDirectory: args.browserArtifactDirectory,
    deadlineAt,
  });
  remaining(deadlineAt, 1);
  const produced = await emitReleaseGateProducerArtifacts({
    gate: "final_custom_domain_browser",
    completedAt: new Date().toISOString(),
    candidate,
    runtimeSnapshot,
    fixtures: [],
    sources: {
      browser: browserEvidence,
      sitesControlPlane,
      sitesControlPlaneAttestation: sitesProvenance.attestation,
      sitesControlPlaneTrust: sitesProvenance.trust,
      sitesControlPlaneVerificationKey: sitesProvenance.verificationKey,
      sitesControlPlaneTrustPolicy: sitesProvenance.trustPolicy,
    },
    files: args.files,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    gate: produced.artifact.gate,
    browserEvidenceHash: browserEvidence.evidenceHash,
    gateEvidenceHash: produced.artifact.evidenceHash,
    producerKeyId: produced.attestation.signature.keyId,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "final_custom_domain_browser_producer_failed",
      message: "Final custom-domain browser producer failed closed",
    })}\n`);
    process.exitCode = 1;
  });
}
