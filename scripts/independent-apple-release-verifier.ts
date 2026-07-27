import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { orderedAppleStableIdsHash } from "../server/publication-reconciliation-persistence.ts";
import { stableStringify } from "../server/security.ts";

const APPLE_API_ORIGIN = "https://api.music.apple.com";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TRACK_PAGES = 20;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

type FetchLike = typeof fetch;

interface PublicVolume {
  index: number;
  shareUrl: string;
  expectedTrackCount: number;
}

interface ApplePublicSnapshot extends PublicVolume {
  playlistId: string;
  storefront: string;
  name: string;
  orderedIds: string[];
  orderedTitles: string[];
}

export interface ApplePublicPageProbe {
  (
    snapshot: ApplePublicSnapshot,
    artifactDirectory: string,
    deadlineAt?: number,
  ): Promise<{
    screenshotHash: string;
    titleVisible: true;
    firstTrackVisible: true;
    lastTrackVisible: true;
    countVisible: true;
  }>;
}

function remainingDeadlineMs(deadlineAt: number | undefined, maximum: number): number {
  if (deadlineAt === undefined) return maximum;
  const remaining = deadlineAt - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new Error("independent_apple_verification_deadline_exceeded");
  }
  return Math.max(1, Math.min(maximum, remaining));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function jwtPart(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label}_is_invalid`);
  }
}

export function appleQaVerifierCredentialIdentityHash(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error("apple_qa_verifier_credential_identity_is_invalid");
  }
  const header = jwtPart(
    parts[0]!,
    "apple_qa_verifier_credential_identity",
  );
  const payload = jwtPart(
    parts[1]!,
    "apple_qa_verifier_credential_identity",
  );
  const algorithm = header.alg;
  const keyId = header.kid;
  const issuer = payload.iss;
  if (
    algorithm !== "ES256"
    || typeof keyId !== "string"
    || !/^[0-9A-Za-z]{4,32}$/u.test(keyId)
    || typeof issuer !== "string"
    || !/^[0-9A-Za-z]{4,32}$/u.test(issuer)
  ) {
    throw new Error("apple_qa_verifier_credential_identity_is_invalid");
  }
  return hash({ algorithm, issuer, keyId });
}

function safeLabel(value: unknown, name: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{2,127}$/u.test(normalized)) {
    throw new Error(`invalid_${name}`);
  }
  return normalized;
}

function safeRevision(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(normalized)) {
    throw new Error("invalid_candidate_revision");
  }
  return normalized;
}

export function parseApplePublicPlaylistUrl(value: unknown): {
  shareUrl: string;
  storefront: string;
  playlistId: string;
} {
  if (typeof value !== "string") throw new Error("invalid_apple_share_url");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_apple_share_url");
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "music.apple.com"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("invalid_apple_share_url");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const storefront = segments[0]?.toLowerCase() ?? "";
  const playlistId = segments.at(-1) ?? "";
  if (!/^[a-z]{2}$/u.test(storefront) || !/^pl\.[0-9A-Za-z._-]{1,156}$/u.test(playlistId)) {
    throw new Error("invalid_apple_share_url");
  }
  return { shareUrl: url.toString(), storefront, playlistId };
}

function normalizeNext(value: unknown, playlistPath: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error("invalid_apple_pagination");
  let url: URL;
  try {
    url = new URL(value, APPLE_API_ORIGIN);
  } catch {
    throw new Error("invalid_apple_pagination");
  }
  if (
    url.origin !== APPLE_API_ORIGIN
    || url.username
    || url.password
    || url.hash
    || url.pathname !== playlistPath
  ) {
    throw new Error("invalid_apple_pagination");
  }
  return `${url.pathname}${url.search}`;
}

async function appleJson(
  path: string,
  developerToken: string,
  fetchImpl: FetchLike,
  deadlineAt?: number,
): Promise<Record<string, unknown>> {
  if (!path.startsWith("/v1/catalog/")) throw new Error("invalid_apple_api_path");
  const response = await fetchImpl(`${APPLE_API_ORIGIN}${path}`, {
    headers: { Authorization: `Bearer ${developerToken}` },
    redirect: "manual",
    signal: AbortSignal.timeout(remainingDeadlineMs(deadlineAt, REQUEST_TIMEOUT_MS)),
  });
  if (!response.ok || response.status >= 300) {
    throw new Error("independent_apple_readback_failed");
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("independent_apple_readback_failed");
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("independent_apple_readback_failed");
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("independent_apple_readback_failed");
  }
  let payload: unknown = null;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("independent_apple_readback_failed");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("independent_apple_readback_failed");
  }
  return payload as Record<string, unknown>;
}

async function publicSnapshot(
  volume: PublicVolume,
  developerToken: string,
  fetchImpl: FetchLike,
  deadlineAt?: number,
): Promise<ApplePublicSnapshot> {
  const parsed = parseApplePublicPlaylistUrl(volume.shareUrl);
  const prefix = `/v1/catalog/${parsed.storefront}/playlists/${encodeURIComponent(parsed.playlistId)}`;
  const metadata = await appleJson(prefix, developerToken, fetchImpl, deadlineAt);
  const playlist = record(Array.isArray(metadata.data) ? metadata.data[0] : null);
  const attributes = record(playlist.attributes);
  const name = typeof attributes.name === "string" ? attributes.name.trim() : "";
  if (playlist.id !== parsed.playlistId || playlist.type !== "playlists" || !name) {
    throw new Error("independent_apple_playlist_identity_failed");
  }

  const orderedIds: string[] = [];
  const orderedTitles: string[] = [];
  const trackPath = `${prefix}/tracks`;
  let next: string | null = `${trackPath}?limit=100`;
  for (let page = 0; next && page < MAX_TRACK_PAGES; page += 1) {
    const payload = await appleJson(next, developerToken, fetchImpl, deadlineAt);
    const tracks = Array.isArray(payload.data) ? payload.data.map(record) : [];
    for (const track of tracks) {
      const id = typeof track.id === "string" ? track.id.trim() : "";
      const title = typeof record(track.attributes).name === "string"
        ? String(record(track.attributes).name).trim()
        : "";
      if (!/^[0-9A-Za-z._-]{1,200}$/u.test(id) || !title) {
        throw new Error("independent_apple_track_identity_failed");
      }
      orderedIds.push(id);
      orderedTitles.push(title);
    }
    next = normalizeNext(payload.next, trackPath);
  }
  if (next) throw new Error("independent_apple_pagination_limit");
  if (orderedIds.length !== volume.expectedTrackCount) {
    throw new Error("independent_apple_track_count_mismatch");
  }
  return { ...volume, ...parsed, name, orderedIds, orderedTitles };
}

function normalizedVisibleText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en");
}

export async function playwrightApplePublicPageProbe(
  snapshot: ApplePublicSnapshot,
  artifactDirectory: string,
  deadlineAt?: number,
): Promise<{
  screenshotHash: string;
  titleVisible: true;
  firstTrackVisible: true;
  lastTrackVisible: true;
  countVisible: true;
}> {
  const { chromium } = await import("@playwright/test");
  remainingDeadlineMs(deadlineAt, 1);
  const browser = await chromium.launch({
    headless: true,
    timeout: remainingDeadlineMs(deadlineAt, 30_000),
  });
  try {
    remainingDeadlineMs(deadlineAt, 1);
    const page = await browser.newPage({ locale: "en-US" });
    const response = await page.goto(snapshot.shareUrl, {
      waitUntil: "domcontentloaded",
      timeout: remainingDeadlineMs(deadlineAt, 45_000),
    });
    if (!response || response.status() >= 400 || new URL(page.url()).hostname !== "music.apple.com") {
      throw new Error("apple_public_browser_access_failed");
    }
    if (remainingDeadlineMs(deadlineAt, 3_001) <= 3_000) {
      throw new Error("independent_apple_verification_deadline_exceeded");
    }
    await page.waitForTimeout(3_000);
    const before = normalizedVisibleText(await page.locator("body").innerText());
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    if (remainingDeadlineMs(deadlineAt, 2_001) <= 2_000) {
      throw new Error("independent_apple_verification_deadline_exceeded");
    }
    await page.waitForTimeout(2_000);
    const after = normalizedVisibleText(await page.locator("body").innerText());
    const combined = `${before} ${after}`;
    const titleVisible = combined.includes(normalizedVisibleText(snapshot.name));
    const firstTrackVisible = combined.includes(normalizedVisibleText(snapshot.orderedTitles[0] ?? ""));
    const lastTrackVisible = combined.includes(normalizedVisibleText(snapshot.orderedTitles.at(-1) ?? ""));
    const countVisible = new RegExp(`\\b${snapshot.expectedTrackCount}\\s+songs?\\b`, "iu").test(combined);
    if (!titleVisible || !firstTrackVisible || !lastTrackVisible || !countVisible) {
      throw new Error("apple_public_browser_content_failed");
    }
    const screenshot = await page.screenshot({
      fullPage: true,
      path: resolve(artifactDirectory, `apple-public-volume-${snapshot.index}.png`),
      timeout: remainingDeadlineMs(deadlineAt, 30_000),
    });
    return {
      screenshotHash: createHash("sha256").update(screenshot).digest("hex"),
      titleVisible: true,
      firstTrackVisible: true,
      lastTrackVisible: true,
      countVisible: true,
    };
  } finally {
    await browser.close();
  }
}

export async function independentAppleReleaseEvidence(input: {
  result: unknown;
  targetTrackCount: number;
  expectedOrderedIdsHash: string;
  canaryId: string;
  environment: "staging" | "production";
  candidateRevision: string;
  artifactDirectory: string;
  deadlineAt?: number;
  now?: string;
}, options: {
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  pageProbe?: ApplePublicPageProbe;
} = {}): Promise<Record<string, unknown>> {
  const environment = options.environment ?? process.env;
  const developerToken = environment.APPLE_QA_VERIFIER_DEVELOPER_TOKEN?.trim() ?? "";
  const credentialVersion = safeLabel(
    environment.APPLE_QA_VERIFIER_CREDENTIAL_VERSION,
    "apple_qa_verifier_credential_version",
  );
  if (developerToken.length < 100 || /\s/u.test(developerToken)) {
    throw new Error("apple_qa_verifier_credentials_unavailable");
  }
  const verifierCredentialIdentityHash =
    appleQaVerifierCredentialIdentityHash(developerToken);
  if (!Number.isInteger(input.targetTrackCount) || input.targetTrackCount < 1) {
    throw new Error("invalid_target_track_count");
  }
  if (!/^[0-9a-f]{64}$/u.test(input.expectedOrderedIdsHash)) {
    throw new Error("invalid_expected_ordered_ids_hash");
  }
  const result = record(input.result);
  const volumes = Array.isArray(result.volumes) ? result.volumes.map(record) : [];
  if (volumes.length < 1 || volumes.length > 10) {
    throw new Error("invalid_publication_volumes");
  }
  const publicVolumes: PublicVolume[] = volumes.map((volume, offset) => {
    const index = Number(volume.index ?? volume.volumeNumber);
    const expectedTrackCount = Number(volume.trackCount);
    if (
      index !== offset + 1
      || !Number.isInteger(expectedTrackCount)
      || expectedTrackCount < 1
    ) {
      throw new Error("invalid_publication_volumes");
    }
    return {
      index,
      expectedTrackCount,
      shareUrl: parseApplePublicPlaylistUrl(volume.shareUrl).shareUrl,
    };
  });
  if (publicVolumes.reduce((sum, volume) => sum + volume.expectedTrackCount, 0)
    !== input.targetTrackCount) {
    throw new Error("invalid_publication_volumes");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const snapshots: ApplePublicSnapshot[] = [];
  for (const volume of publicVolumes) {
    remainingDeadlineMs(input.deadlineAt, 1);
    snapshots.push(await publicSnapshot(
      volume,
      developerToken,
      fetchImpl,
      input.deadlineAt,
    ));
  }
  const observedOrderedIds = snapshots.flatMap((snapshot) => snapshot.orderedIds);
  const observedOrderedIdsHash = orderedAppleStableIdsHash(observedOrderedIds);
  if (
    observedOrderedIds.length !== input.targetTrackCount
    || observedOrderedIdsHash !== input.expectedOrderedIdsHash
  ) {
    throw new Error("independent_apple_order_mismatch");
  }

  const artifactDirectory = resolve(input.artifactDirectory);
  await mkdir(artifactDirectory, { recursive: true });
  const pageProbe = options.pageProbe ?? playwrightApplePublicPageProbe;
  const browserChecks = [];
  for (const snapshot of snapshots) {
    remainingDeadlineMs(input.deadlineAt, 1);
    browserChecks.push(await pageProbe(
      snapshot,
      artifactDirectory,
      input.deadlineAt,
    ));
  }
  if (browserChecks.some((check) => !/^[0-9a-f]{64}$/u.test(check.screenshotHash))) {
    throw new Error("invalid_apple_browser_evidence");
  }

  const observedAt = input.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))
    || new Date(observedAt).toISOString() !== observedAt) {
    throw new Error("invalid_observation_time");
  }
  const evidence = {
    schemaVersion: "genio-independent-apple-release-evidence/v1",
    canaryId: safeLabel(input.canaryId, "canary_id"),
    environment: input.environment,
    candidateRevision: safeRevision(input.candidateRevision),
    observedAt,
    verifierCredentialVersionHash: hash(credentialVersion),
    verifierCredentialIdentityHash,
    playlistCount: snapshots.length,
    targetTrackCount: input.targetTrackCount,
    expectedOrderedIdsHash: input.expectedOrderedIdsHash,
    observedOrderedIdsHash,
    exactOrderedReadback: true,
    publicNamesHash: hash(snapshots.map((snapshot) => snapshot.name)),
    browserChecks: browserChecks.map((check, index) => ({
      volumeIndex: index + 1,
      ...check,
    })),
  };
  return {
    ...evidence,
    evidenceHash: hash(evidence),
  };
}
