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
  validateSitesControlPlaneSource,
} from "./release-fixtures.ts";
import {
  pipelineV3RolloutGroup,
} from "../server/query-plan-v3.ts";
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
const DEADLINE_MS = 3 * 60_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const FINAL_ROLLOUT_STAGE =
  /^(?:genre_scene|mood_activity_theme|similarity|artist_catalogue|fixed_container|factual_relationship|exhaustive):(?:0|1|10|50|100)->100$/u;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
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

export function assertFinalPublicAssignmentProbeFixtureClassifications(): void {
  const fixtureIds = new Set<string>();
  const intentGroups = new Set<string>();
  const governedIntentGroups = Object.keys(
    PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
  );
  for (const fixture of FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V1) {
    const plan = createRunSpecV3({
      prompt: fixture.prompt,
      requestedTrackCount: fixture.targetTrackCount,
      storefront: "us",
    });
    const classifiedGroup = pipelineV3RolloutGroup(plan);
    if (
      fixtureIds.has(fixture.fixtureId)
      || intentGroups.has(fixture.intentGroup)
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
    fixtureIds.size !== FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V1.length
    || intentGroups.size !== FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V1.length
    || governedIntentGroups.length
      !== FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V1.length
    || governedIntentGroups.some((group) => !intentGroups.has(group))
  ) {
    throw new Error(
      "final public assignment fixtures do not cover every rollout intent",
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
  getStatus: number | null;
  contractVersion: number | null;
  cleanupStatus: number | null;
}

export interface FinalPublicAssignmentProbeEvidenceV1 {
  fixtureId: string;
  intentGroup: FinalPublicAssignmentProbeFixtureV1["intentGroup"];
  targetTrackCount: number;
  rolloutEvidenceHash: string;
  rolloutStage: string;
  assignmentHash: string;
  contractVersion: 3;
  cleanupStatus: 204;
}

export function validateBrowserPublicAssignmentProbeResultV1(input: {
  fixture: FinalPublicAssignmentProbeFixtureV1;
  result: BrowserPublicAssignmentProbeResultV1;
  expectedRolloutEvidenceHash: string;
  expectedRolloutStage: string;
}): FinalPublicAssignmentProbeEvidenceV1 {
  const { result } = input;
  if (
    (result.postStatus !== 200 && result.postStatus !== 202)
    || result.requestIdValid !== true
    || result.rolloutEvidenceHash !== input.expectedRolloutEvidenceHash
    || result.rolloutStage !== input.expectedRolloutStage
    || typeof result.assignmentHash !== "string"
    || !SHA256.test(result.assignmentHash)
    || result.getStatus !== 200
    || result.contractVersion !== 3
    || result.cleanupStatus !== 204
  ) {
    throw new Error(
      `public assignment probe ${input.fixture.fixtureId} did not prove an exact contract-3 assignment and cleanup`,
    );
  }
  return {
    fixtureId: input.fixture.fixtureId,
    intentGroup: input.fixture.intentGroup,
    targetTrackCount: input.fixture.targetTrackCount,
    rolloutEvidenceHash: result.rolloutEvidenceHash,
    rolloutStage: result.rolloutStage,
    assignmentHash: result.assignmentHash,
    contractVersion: 3,
    cleanupStatus: 204,
  };
}

export interface FinalCustomDomainBrowserProducerArgs {
  origin: typeof PRODUCTION_ORIGIN;
  expectedRevision: string;
  expectedVersion: string;
  expectedPublicRolloutEvidenceHash: string;
  expectedPublicRolloutStage: string;
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
    if (argument !== CONFIRMATION_FLAG) index += 1;
  }
  if (argv.filter((value) => value === CONFIRMATION_FLAG).length !== 1) {
    throw new Error(`Final production browser evidence requires ${CONFIRMATION_FLAG}`);
  }
  const configuredOrigin = environment.RELEASE_PRODUCTION_ORIGIN?.trim() ?? "";
  const origin = releaseProducerOption(argv, "--origin");
  if (origin !== PRODUCTION_ORIGIN
    || configuredOrigin !== PRODUCTION_ORIGIN) {
    throw new Error("--origin must exactly match the configured https://9enio.com origin");
  }
  const expectedRevision = releaseProducerOption(argv, "--expected-revision").toLowerCase();
  const expectedVersion = releaseProducerOption(argv, "--expected-version");
  const expectedPublicRolloutEvidenceHash = releaseProducerOption(
    argv,
    "--expected-public-rollout-evidence-hash",
  );
  const expectedPublicRolloutStage = releaseProducerOption(
    argv,
    "--expected-public-rollout-stage",
  );
  if (!SHA256.test(expectedPublicRolloutEvidenceHash)) {
    throw new Error(
      "--expected-public-rollout-evidence-hash must be the exact signed rollout payload hash",
    );
  }
  if (!FINAL_ROLLOUT_STAGE.test(expectedPublicRolloutStage)) {
    throw new Error(
      "--expected-public-rollout-stage must encode a governed intent transition to 100%",
    );
  }
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
    expectedPublicRolloutEvidenceHash,
    expectedPublicRolloutStage,
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
  expectedPublicRolloutEvidenceHash: string;
  expectedPublicRolloutStage: string;
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
    for (const fixture of FINAL_PUBLIC_ASSIGNMENT_PROBE_FIXTURES_V1) {
      remaining(input.deadlineAt, 1);
      const probeResult = await page.evaluate(
        async ({ prompt, targetTrackCount, timeoutMs }) => {
          const lifecycleController = new AbortController();
          const lifecycleTimer = setTimeout(
            () => lifecycleController.abort(),
            Math.max(1, timeoutMs - 5_000),
          );
          try {
            const postResponse = await fetch("/api/v1/brief", {
              method: "POST",
              cache: "no-store",
              credentials: "same-origin",
              headers: {
                "content-type": "application/json",
              },
              body: JSON.stringify({ prompt, targetTrackCount }),
              signal: lifecycleController.signal,
            });
            const rolloutEvidenceHash = postResponse.headers.get(
              "x-genio-public-rollout-evidence-hash",
            );
            const rolloutStage = postResponse.headers.get(
              "x-genio-public-rollout-stage",
            );
            const assignmentHash = postResponse.headers.get(
              "x-genio-public-rollout-assignment-hash",
            );
            let requestId: string | null = null;
            try {
              const payload: unknown = await postResponse.json();
              if (payload && typeof payload === "object" && !Array.isArray(payload)) {
                const candidate = (payload as Record<string, unknown>).requestId;
                requestId = typeof candidate === "string" ? candidate : null;
              }
            } catch {
              requestId = null;
            }
            const requestIdValid = requestId !== null
              && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
                .test(requestId);
            let getStatus: number | null = null;
            let contractVersion: number | null = null;
            let cleanupStatus: number | null = null;
            if (requestIdValid) {
              try {
                const getResponse = await fetch(`/api/v1/brief/${requestId}`, {
                  cache: "no-store",
                  credentials: "same-origin",
                  signal: lifecycleController.signal,
                });
                getStatus = getResponse.status;
                try {
                  const payload: unknown = await getResponse.json();
                  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
                    const candidate = (payload as Record<string, unknown>)
                      .briefContractVersion;
                    contractVersion = typeof candidate === "number"
                      ? candidate
                      : null;
                  }
                } catch {
                  contractVersion = null;
                }
              } finally {
                const cleanupController = new AbortController();
                const cleanupTimer = setTimeout(
                  () => cleanupController.abort(),
                  Math.min(5_000, timeoutMs),
                );
                try {
                  const cleanupResponse = await fetch(
                    `/api/v1/brief/${requestId}`,
                    {
                      method: "DELETE",
                      cache: "no-store",
                      credentials: "same-origin",
                      signal: cleanupController.signal,
                    },
                  );
                  cleanupStatus = cleanupResponse.status;
                } catch {
                  cleanupStatus = null;
                } finally {
                  clearTimeout(cleanupTimer);
                }
              }
            }
            return {
              postStatus: postResponse.status,
              requestIdValid,
              rolloutEvidenceHash,
              rolloutStage,
              assignmentHash,
              getStatus,
              contractVersion,
              cleanupStatus,
            };
          } finally {
            clearTimeout(lifecycleTimer);
          }
        },
        {
          prompt: fixture.prompt,
          targetTrackCount: fixture.targetTrackCount,
          timeoutMs: remaining(input.deadlineAt, 20_000),
        },
      );
      publicAssignmentProbes.push(
        validateBrowserPublicAssignmentProbeResultV1({
          fixture,
          result: probeResult,
          expectedRolloutEvidenceHash:
            input.expectedPublicRolloutEvidenceHash,
          expectedRolloutStage: input.expectedPublicRolloutStage,
        }),
      );
    }
    remaining(input.deadlineAt, 1);
    const observedAt = new Date().toISOString();
    const unsigned = {
      schemaVersion: "genio-final-custom-domain-browser/v2",
      origin: input.origin,
      candidateRevision: input.candidateRevision,
      observedAt,
      tlsValid: true,
      releaseIdentityVisible: true,
      anonymousPlaylistDirectory: true,
      publicPlaylistContentsVisible: true,
      privacyProjectionPassed: true,
      screenshotHashes: [aboutScreenshot, directoryScreenshot]
        .map((bytes) => createHash("sha256").update(bytes).digest("hex")),
      publicAssignmentProbes,
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
  const browserEvidence = await collectFinalCustomDomainBrowserEvidence({
    origin: args.origin,
    candidateRevision: args.expectedRevision,
    candidateVersion: args.expectedVersion,
    expectedPublicRolloutEvidenceHash:
      args.expectedPublicRolloutEvidenceHash,
    expectedPublicRolloutStage: args.expectedPublicRolloutStage,
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
