import { randomUUID } from "node:crypto";
import type { CatalogSong } from "../shared/types.ts";
import { sha256Hex, stableStringify } from "./security.ts";
import {
  APPLE_SMOKE_NAME_PREFIX,
} from "./apple-smoke.ts";
import type { PublicationResult } from "./publisher.ts";

export const APPLE_PHASE_ZERO_SCHEMA_VERSION = 1;
export const APPLE_PHASE_ZERO_MIN_SEED_IDS = 3;
export const APPLE_PHASE_ZERO_MAX_SEED_IDS = 25;
export const APPLE_PHASE_ZERO_EXPANDED_CATALOG_IDS = 5_000;
export const APPLE_PHASE_ZERO_TOTAL_WRITTEN_TRACKS = 6_603;
export const APPLE_PHASE_ZERO_RESOLUTION_MAX_AGE_MS = 2 * 60 * 60 * 1_000;
export const APPLE_PHASE_ZERO_WRITE_CONFIRMATION = "--confirm-live-write";

export const APPLE_PHASE_ZERO_CASES = [
  { id: "three", trackCount: 3, expectedVolumes: 1, label: "3 tracks" },
  { id: "one-hundred", trackCount: 100, expectedVolumes: 1, label: "100 tracks" },
  { id: "five-hundred", trackCount: 500, expectedVolumes: 1, label: "500 tracks" },
  { id: "one-thousand", trackCount: 1_000, expectedVolumes: 1, label: "1000 tracks" },
  { id: "five-volumes", trackCount: 5_000, expectedVolumes: 5, label: "five volumes" },
] as const;

export type ApplePhaseZeroCaseId = typeof APPLE_PHASE_ZERO_CASES[number]["id"];

export interface ApplePhaseZeroCatalogIdInput {
  schemaVersion: 1;
  suiteId: string;
  storefront: string;
  catalogIds: string[];
}

export interface ApplePhaseZeroResolvedTrack {
  id: string;
  name: string;
  artistName: string;
  albumName: string;
  releaseDate?: string;
  durationInMillis?: number;
  isrc?: string;
  url?: string;
  versionLabel?: string;
}

export interface ApplePhaseZeroResolvedFixture {
  schemaVersion: 1;
  suiteId: string;
  storefront: string;
  resolvedAt: string;
  seedCount: number;
  tracks: ApplePhaseZeroResolvedTrack[];
  fixtureHash: string;
}

export interface ApplePhaseZeroManifestInput {
  suiteId: string;
  fixtureHash: string;
  caseId: ApplePhaseZeroCaseId;
  storefront: string;
  name: string;
  description: string;
  tracks: ApplePhaseZeroResolvedTrack[];
}

export interface ApplePhaseZeroLockedManifest {
  id: string;
  runId: string;
  name: string;
  description: string;
  contentHash: string;
  lockedAt: string;
  tracks: Array<{
    candidateId: string;
    catalogId: string;
    artist: string;
    title: string;
    position?: number;
  }>;
}

export interface ApplePhaseZeroManifestStore {
  createApplePhaseZeroManifest(input: ApplePhaseZeroManifestInput): Promise<ApplePhaseZeroLockedManifest>;
}

export interface ApplePhaseZeroAppleClient {
  validateAuthorization(signal?: AbortSignal): Promise<string>;
  resolveCatalogSongs(storefront: string, catalogIds: readonly string[], signal?: AbortSignal): Promise<CatalogSong[]>;
  getOrderedPlaylistCatalogIds(playlistId: string, signal?: AbortSignal): Promise<string[]>;
  getLibraryPlaylist(playlistId: string, signal?: AbortSignal): Promise<any | null>;
  listLibraryPlaylists(signal?: AbortSignal): Promise<any[]>;
}

export interface ApplePhaseZeroVolumeReport {
  index: number;
  playlistId: string;
  name: string;
  shareUrl: string;
  expectedTrackCount: number;
  observedTrackCount: number;
  expectedCatalogIdsHash: string;
  observedCatalogIdsHash: string;
}

export interface ApplePhaseZeroCaseReport {
  id: ApplePhaseZeroCaseId;
  expectedTrackCount: number;
  expectedVolumeCount: number;
  manifestId: string;
  runId: string;
  manifestHash: string;
  status: "manifest_ready" | "complete" | "failed";
  volumes: ApplePhaseZeroVolumeReport[];
}

export interface ApplePhaseZeroReport {
  schemaVersion: 1;
  reportId: string;
  suiteId: string;
  storefront: string;
  fixtureHash: string;
  startedAt: string;
  completedAt: string | null;
  status: "running" | "complete" | "failed";
  expectedWrittenTrackCount: number;
  cases: ApplePhaseZeroCaseReport[];
  error: string | null;
  reportHash: string;
}

export interface ApplePhaseZeroInventoryItem {
  playlistId: string;
  name: string;
  shareUrl: string | null;
}

export interface ApplePhaseZeroInventoryReport {
  schemaVersion: 1;
  reportId: string;
  storefront: string;
  generatedAt: string;
  items: ApplePhaseZeroInventoryItem[];
  reportHash: string;
}

type JsonRecord = Record<string, unknown>;

function object(value: unknown, field: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) throw new Error(`${field} contains unsupported fields: ${unexpected.join(", ")}`);
}

function string(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`${field} is invalid`);
  return value.trim();
}

function storefront(value: unknown, field = "storefront"): string {
  const normalized = string(value, field, 2).toLowerCase();
  if (!/^[a-z]{2}$/u.test(normalized)) throw new Error(`${field} must be a two-letter Apple storefront`);
  return normalized;
}

function suiteId(value: unknown): string {
  const normalized = string(value, "suiteId", 64);
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/u.test(normalized)) {
    throw new Error("suiteId must contain 3-64 lowercase letters, digits, underscores, or hyphens");
  }
  return normalized;
}

function catalogId(value: unknown, field: string): string {
  const normalized = string(value, field, 32);
  if (!/^\d{1,32}$/u.test(normalized)) throw new Error(`${field} must be a numeric Apple song ID`);
  return normalized;
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} must not contain duplicates`);
}

function isoTimestamp(value: unknown, field: string): string {
  const normalized = string(value, field, 40);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) throw new Error(`${field} must be an ISO timestamp`);
  return normalized;
}

function trackFromUnknown(value: unknown, index: number): ApplePhaseZeroResolvedTrack {
  const row = object(value, `tracks[${index}]`);
  exactKeys(row, [
    "id", "name", "artistName", "albumName", "releaseDate", "durationInMillis", "isrc", "url", "versionLabel",
  ], `tracks[${index}]`);
  const result: ApplePhaseZeroResolvedTrack = {
    id: catalogId(row.id, `tracks[${index}].id`),
    name: string(row.name, `tracks[${index}].name`, 240),
    artistName: string(row.artistName, `tracks[${index}].artistName`, 240),
    albumName: typeof row.albumName === "string" ? row.albumName.trim().slice(0, 240) : "",
  };
  if (row.releaseDate !== undefined) result.releaseDate = string(row.releaseDate, `tracks[${index}].releaseDate`, 40);
  if (row.durationInMillis !== undefined) {
    if (!Number.isInteger(row.durationInMillis) || Number(row.durationInMillis) < 0 || Number(row.durationInMillis) > 24 * 60 * 60 * 1_000) {
      throw new Error(`tracks[${index}].durationInMillis is invalid`);
    }
    result.durationInMillis = Number(row.durationInMillis);
  }
  if (row.isrc !== undefined) result.isrc = string(row.isrc, `tracks[${index}].isrc`, 32);
  if (row.versionLabel !== undefined) result.versionLabel = string(row.versionLabel, `tracks[${index}].versionLabel`, 120);
  if (row.url !== undefined) {
    const url = new URL(string(row.url, `tracks[${index}].url`, 2_000));
    if (url.protocol !== "https:" || url.hostname !== "music.apple.com") throw new Error(`tracks[${index}].url is not an Apple Music URL`);
    result.url = url.toString();
  }
  return result;
}

export function phaseZeroFixtureHash(input: Omit<ApplePhaseZeroResolvedFixture, "fixtureHash">): string {
  return sha256Hex(stableStringify(input));
}

function withReportHash<T extends { reportHash: string }>(report: T): T {
  const { reportHash: _ignored, ...body } = report;
  void _ignored;
  return { ...report, reportHash: sha256Hex(stableStringify(body)) };
}

export function validateApplePhaseZeroCatalogIdInput(value: unknown): ApplePhaseZeroCatalogIdInput {
  const input = object(value, "catalog ID fixture");
  exactKeys(input, ["schemaVersion", "suiteId", "storefront", "catalogIds"], "catalog ID fixture");
  if (input.schemaVersion !== APPLE_PHASE_ZERO_SCHEMA_VERSION) throw new Error("catalog ID fixture schemaVersion must be 1");
  if (!Array.isArray(input.catalogIds)
    || input.catalogIds.length < APPLE_PHASE_ZERO_MIN_SEED_IDS
    || input.catalogIds.length > APPLE_PHASE_ZERO_MAX_SEED_IDS) {
    throw new Error(`catalog ID fixture must contain ${APPLE_PHASE_ZERO_MIN_SEED_IDS}-${APPLE_PHASE_ZERO_MAX_SEED_IDS} explicit seed IDs`);
  }
  const catalogIds = input.catalogIds.map((id, index) => catalogId(id, `catalogIds[${index}]`));
  assertUnique(catalogIds, "catalogIds");
  return {
    schemaVersion: 1,
    suiteId: suiteId(input.suiteId),
    storefront: storefront(input.storefront),
    catalogIds,
  };
}

export function validateApplePhaseZeroResolvedFixture(value: unknown): ApplePhaseZeroResolvedFixture {
  const input = object(value, "resolved fixture");
  exactKeys(input, ["schemaVersion", "suiteId", "storefront", "resolvedAt", "seedCount", "tracks", "fixtureHash"], "resolved fixture");
  if (input.schemaVersion !== APPLE_PHASE_ZERO_SCHEMA_VERSION) throw new Error("resolved fixture schemaVersion must be 1");
  if (!Number.isInteger(input.seedCount)
    || Number(input.seedCount) < APPLE_PHASE_ZERO_MIN_SEED_IDS
    || Number(input.seedCount) > APPLE_PHASE_ZERO_MAX_SEED_IDS) {
    throw new Error(`resolved fixture seedCount must be ${APPLE_PHASE_ZERO_MIN_SEED_IDS}-${APPLE_PHASE_ZERO_MAX_SEED_IDS}`);
  }
  if (!Array.isArray(input.tracks) || input.tracks.length !== APPLE_PHASE_ZERO_EXPANDED_CATALOG_IDS) {
    throw new Error(`resolved fixture must contain exactly ${APPLE_PHASE_ZERO_EXPANDED_CATALOG_IDS} deterministically expanded tracks`);
  }
  const fixture: ApplePhaseZeroResolvedFixture = {
    schemaVersion: 1,
    suiteId: suiteId(input.suiteId),
    storefront: storefront(input.storefront),
    resolvedAt: isoTimestamp(input.resolvedAt, "resolvedAt"),
    seedCount: Number(input.seedCount),
    tracks: input.tracks.map(trackFromUnknown),
    fixtureHash: string(input.fixtureHash, "fixtureHash", 64).toLowerCase(),
  };
  const seedTracks = fixture.tracks.slice(0, fixture.seedCount);
  assertUnique(seedTracks.map((track) => track.id), "resolved fixture seed track IDs");
  for (let index = 0; index < fixture.tracks.length; index += 1) {
    if (stableStringify(fixture.tracks[index]) !== stableStringify(seedTracks[index % seedTracks.length])) {
      throw new Error("resolved fixture is not the required deterministic cycle expansion");
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(fixture.fixtureHash)) throw new Error("fixtureHash must be a SHA-256 hash");
  const { fixtureHash: _ignored, ...body } = fixture;
  void _ignored;
  if (phaseZeroFixtureHash(body) !== fixture.fixtureHash) throw new Error("resolved fixture hash does not match its contents");
  return fixture;
}

export async function resolveApplePhaseZeroFixture(
  value: unknown,
  client: Pick<ApplePhaseZeroAppleClient, "resolveCatalogSongs">,
  signal?: AbortSignal,
  now = new Date(),
): Promise<ApplePhaseZeroResolvedFixture> {
  const input = validateApplePhaseZeroCatalogIdInput(value);
  const resolved = new Map<string, ApplePhaseZeroResolvedTrack>();
  for (let offset = 0; offset < input.catalogIds.length; offset += 25) {
    signal?.throwIfAborted();
    const batch = input.catalogIds.slice(offset, offset + 25);
    const songs = await client.resolveCatalogSongs(input.storefront, batch, signal);
    for (const song of songs) {
      if (!batch.includes(song.id)) throw new Error("Apple returned a song outside the requested catalog-ID batch");
      if (resolved.has(song.id)) throw new Error(`Apple returned catalog ID ${song.id} more than once`);
      resolved.set(song.id, trackFromUnknown({
        id: song.id,
        name: song.name,
        artistName: song.artistName,
        albumName: song.albumName,
        ...(song.releaseDate ? { releaseDate: song.releaseDate } : {}),
        ...(song.durationInMillis !== undefined ? { durationInMillis: song.durationInMillis } : {}),
        ...(song.isrc ? { isrc: song.isrc } : {}),
        ...(song.url ? { url: song.url } : {}),
        ...(song.versionLabel ? { versionLabel: song.versionLabel } : {}),
      }, offset + batch.indexOf(song.id)));
    }
  }
  const missing = input.catalogIds.filter((id) => !resolved.has(id));
  if (missing.length > 0) throw new Error(`Apple did not resolve ${missing.length} explicit catalog IDs`);
  const seedTracks = input.catalogIds.map((id) => resolved.get(id)!);
  const body: Omit<ApplePhaseZeroResolvedFixture, "fixtureHash"> = {
    schemaVersion: 1,
    suiteId: input.suiteId,
    storefront: input.storefront,
    resolvedAt: now.toISOString(),
    seedCount: seedTracks.length,
    tracks: Array.from(
      { length: APPLE_PHASE_ZERO_EXPANDED_CATALOG_IDS },
      (_, index) => ({ ...seedTracks[index % seedTracks.length]! }),
    ),
  };
  return { ...body, fixtureHash: phaseZeroFixtureHash(body) };
}

export function acceptApplePhaseZeroFixture(
  value: unknown,
  expectedHash: string,
  expectedStorefront: string,
  now = new Date(),
): ApplePhaseZeroResolvedFixture {
  const fixture = validateApplePhaseZeroResolvedFixture(value);
  const acceptedHash = expectedHash.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(acceptedHash) || acceptedHash !== fixture.fixtureHash) {
    throw new Error("--accept-fixture-sha256 must exactly match the resolved fixture hash");
  }
  if (fixture.storefront !== storefront(expectedStorefront, "expected storefront")) {
    throw new Error("resolved fixture storefront does not match --expected-storefront");
  }
  const age = now.getTime() - Date.parse(fixture.resolvedAt);
  if (age < -5 * 60_000 || age > APPLE_PHASE_ZERO_RESOLUTION_MAX_AGE_MS) {
    throw new Error("resolved fixture is stale or future-dated; resolve the explicit IDs again");
  }
  return fixture;
}

export function phaseZeroTestPlaylistName(suite: string, label: string): string {
  const name = `${APPLE_SMOKE_NAME_PREFIX} ${suiteId(suite)} ${label}`;
  if (name.length > 240) throw new Error("phase-zero playlist name exceeds Apple's limit");
  return name;
}

export function isNeedleTestPlaylistName(name: unknown): name is string {
  return typeof name === "string" && name.startsWith(`${APPLE_SMOKE_NAME_PREFIX} `) && name.length <= 240;
}

function catalogIdsHash(ids: readonly string[]): string {
  return sha256Hex(stableStringify(ids));
}

function playlistName(item: any): string {
  const name = item?.attributes?.name;
  return typeof name === "string" ? name : "";
}

function playlistShareUrl(item: any): string | null {
  const value = item?.attributes?.url ?? item?.attributes?.playParams?.shareUrl;
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "music.apple.com" && /\/playlist\//iu.test(url.pathname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function expectedVolumeName(baseName: string, index: number, count: number): string {
  return count === 1 ? baseName : `${baseName} [${index + 1}/${count}]`;
}

function assertOrderedIds(observed: readonly string[], expected: readonly string[], context: string): void {
  if (observed.length !== expected.length || observed.some((id, index) => id !== expected[index])) {
    throw new Error(`${context} does not exactly match the accepted catalog-ID order`);
  }
}

function initialReport(fixture: ApplePhaseZeroResolvedFixture, now: Date): ApplePhaseZeroReport {
  return withReportHash({
    schemaVersion: 1,
    reportId: randomUUID(),
    suiteId: fixture.suiteId,
    storefront: fixture.storefront,
    fixtureHash: fixture.fixtureHash,
    startedAt: now.toISOString(),
    completedAt: null,
    status: "running",
    expectedWrittenTrackCount: APPLE_PHASE_ZERO_TOTAL_WRITTEN_TRACKS,
    cases: [],
    error: null,
    reportHash: "",
  });
}

export async function publishApplePhaseZeroSuite(
  store: ApplePhaseZeroManifestStore,
  publicationRepository: any,
  apple: Pick<ApplePhaseZeroAppleClient, "validateAuthorization" | "getOrderedPlaylistCatalogIds" | "getLibraryPlaylist">,
  fixture: ApplePhaseZeroResolvedFixture,
  publish: (repository: any, manifestId: string, signal?: AbortSignal) => Promise<PublicationResult>,
  checkpoint: (report: ApplePhaseZeroReport) => Promise<void>,
  signal?: AbortSignal,
  now = () => new Date(),
): Promise<ApplePhaseZeroReport> {
  const liveStorefront = (await apple.validateAuthorization(signal)).toLowerCase();
  if (liveStorefront !== fixture.storefront) throw new Error("live Apple storefront does not match the accepted fixture");
  let report = initialReport(fixture, now());
  await checkpoint(report);

  try {
    for (const testCase of APPLE_PHASE_ZERO_CASES) {
      signal?.throwIfAborted();
      const name = phaseZeroTestPlaylistName(fixture.suiteId, testCase.label);
      const tracks = fixture.tracks.slice(0, testCase.trackCount);
      const manifest = await store.createApplePhaseZeroManifest({
        suiteId: fixture.suiteId,
        fixtureHash: fixture.fixtureHash,
        caseId: testCase.id,
        storefront: fixture.storefront,
        name,
        description: "Temporary Needle Apple Music phase-zero validation. Delete after acceptance.",
        tracks,
      });
      const caseReport: ApplePhaseZeroCaseReport = {
        id: testCase.id,
        expectedTrackCount: testCase.trackCount,
        expectedVolumeCount: testCase.expectedVolumes,
        manifestId: manifest.id,
        runId: manifest.runId,
        manifestHash: manifest.contentHash,
        status: "manifest_ready",
        volumes: [],
      };
      report = withReportHash({ ...report, cases: [...report.cases, caseReport] });
      await checkpoint(report);

      const publication = await publish(publicationRepository, manifest.id, signal);
      if (publication.status !== "complete" || publication.volumes.length !== testCase.expectedVolumes) {
        throw new Error(`phase-zero case ${testCase.id} did not publish the expected volumes`);
      }
      const volumes: ApplePhaseZeroVolumeReport[] = [];
      for (const [index, volume] of publication.volumes.entries()) {
        const expected = tracks.slice(index * 1_000, (index + 1) * 1_000).map((track) => track.id);
        const observed = await apple.getOrderedPlaylistCatalogIds(volume.playlistId, signal);
        assertOrderedIds(observed, expected, `phase-zero case ${testCase.id} volume ${index + 1}`);
        const playlist = await apple.getLibraryPlaylist(volume.playlistId, signal);
        const expectedName = expectedVolumeName(name, index, testCase.expectedVolumes);
        if (!playlist || playlistName(playlist) !== expectedName || !isNeedleTestPlaylistName(playlistName(playlist))) {
          throw new Error(`phase-zero case ${testCase.id} volume ${index + 1} has an unexpected Apple playlist name`);
        }
        if (!volume.shareUrl || !playlistShareUrl({ attributes: { url: volume.shareUrl } })) {
          throw new Error(`phase-zero case ${testCase.id} volume ${index + 1} has no valid Apple share link`);
        }
        volumes.push({
          index,
          playlistId: volume.playlistId,
          name: expectedName,
          shareUrl: volume.shareUrl,
          expectedTrackCount: expected.length,
          observedTrackCount: observed.length,
          expectedCatalogIdsHash: catalogIdsHash(expected),
          observedCatalogIdsHash: catalogIdsHash(observed),
        });
      }
      caseReport.status = "complete";
      caseReport.volumes = volumes;
      report = withReportHash({
        ...report,
        cases: report.cases.map((item) => item.id === caseReport.id ? caseReport : item),
      });
      await checkpoint(report);
    }
    report = withReportHash({ ...report, status: "complete", completedAt: now().toISOString() });
    await checkpoint(report);
    return report;
  } catch (error) {
    const failedCase = report.cases.findLast((item) => item.status !== "complete");
    if (failedCase) failedCase.status = "failed";
    report = withReportHash({
      ...report,
      status: "failed",
      completedAt: now().toISOString(),
      error: error instanceof Error && error.message.startsWith("phase-zero")
        ? error.message.slice(0, 500)
        : "The phase-zero Apple publication suite did not complete.",
    });
    await checkpoint(report);
    throw error;
  }
}

export function validateApplePhaseZeroReport(value: unknown): ApplePhaseZeroReport {
  const report = object(value, "phase-zero report") as unknown as ApplePhaseZeroReport;
  if (report.schemaVersion !== 1 || !Array.isArray(report.cases) || !/^[a-f0-9]{64}$/u.test(String(report.reportHash))) {
    throw new Error("phase-zero report is invalid");
  }
  const expectedHash = withReportHash({ ...report }).reportHash;
  if (expectedHash !== report.reportHash) throw new Error("phase-zero report hash does not match its contents");
  if (report.storefront !== storefront(report.storefront)) throw new Error("phase-zero report storefront is invalid");
  suiteId(report.suiteId);
  if (!/^[a-f0-9]{64}$/u.test(report.fixtureHash) || report.expectedWrittenTrackCount !== APPLE_PHASE_ZERO_TOTAL_WRITTEN_TRACKS) {
    throw new Error("phase-zero report fixture identity is invalid");
  }
  const caseIds = report.cases.map((item) => item.id);
  if (new Set(caseIds).size !== caseIds.length || caseIds.some((id) => !APPLE_PHASE_ZERO_CASES.some((item) => item.id === id))) {
    throw new Error("phase-zero report cases are invalid");
  }
  for (const item of report.cases) {
    const expected = APPLE_PHASE_ZERO_CASES.find((testCase) => testCase.id === item.id)!;
    if (item.expectedTrackCount !== expected.trackCount || item.expectedVolumeCount !== expected.expectedVolumes) {
      throw new Error(`phase-zero report case ${item.id} has invalid expected counts`);
    }
    if (item.volumes.length > expected.expectedVolumes) throw new Error(`phase-zero report case ${item.id} has too many volumes`);
    for (const [index, volume] of item.volumes.entries()) {
      if (volume.index !== index || !isNeedleTestPlaylistName(volume.name)) throw new Error(`phase-zero report case ${item.id} volume is invalid`);
      if (!/^[A-Za-z0-9._-]{1,160}$/u.test(volume.playlistId)) throw new Error("phase-zero report contains an invalid playlist ID");
      if (!playlistShareUrl({ attributes: { url: volume.shareUrl } })) throw new Error("phase-zero report contains an invalid share URL");
      if (!/^[a-f0-9]{64}$/u.test(volume.expectedCatalogIdsHash) || !/^[a-f0-9]{64}$/u.test(volume.observedCatalogIdsHash)) {
        throw new Error("phase-zero report contains an invalid ordered-ID hash");
      }
    }
  }
  return report;
}

export async function verifyApplePhaseZeroReport(
  apple: Pick<ApplePhaseZeroAppleClient, "validateAuthorization" | "getOrderedPlaylistCatalogIds" | "getLibraryPlaylist">,
  expectedStorefront: string,
  fixtureValue: unknown,
  acceptedFixtureHash: string,
  reportValue: unknown,
  acceptedReportHash: string,
  signal?: AbortSignal,
  now = new Date(),
): Promise<ApplePhaseZeroReport> {
  const fixture = validateApplePhaseZeroResolvedFixture(fixtureValue);
  if (acceptedFixtureHash.trim().toLowerCase() !== fixture.fixtureHash) {
    throw new Error("--accept-fixture-sha256 must exactly match the resolved fixture hash");
  }
  if (fixture.storefront !== storefront(expectedStorefront, "expected storefront")) {
    throw new Error("resolved fixture storefront does not match --expected-storefront");
  }
  const report = validateApplePhaseZeroReport(reportValue);
  if (acceptedReportHash.trim().toLowerCase() !== report.reportHash) {
    throw new Error("--accept-report-sha256 must exactly match the phase-zero report hash");
  }
  if (report.fixtureHash !== fixture.fixtureHash || report.suiteId !== fixture.suiteId || report.storefront !== fixture.storefront) {
    throw new Error("phase-zero report does not belong to the accepted resolved fixture");
  }
  if ((await apple.validateAuthorization(signal)).toLowerCase() !== fixture.storefront) {
    throw new Error("live Apple storefront does not match the accepted fixture");
  }
  const verifiedCases: ApplePhaseZeroCaseReport[] = [];
  for (const testCase of APPLE_PHASE_ZERO_CASES) {
    const sourceCase = report.cases.find((item) => item.id === testCase.id);
    if (!sourceCase || sourceCase.status !== "complete" || sourceCase.volumes.length !== testCase.expectedVolumes) {
      throw new Error(`phase-zero report case ${testCase.id} is not complete`);
    }
    const baseName = phaseZeroTestPlaylistName(fixture.suiteId, testCase.label);
    const volumes: ApplePhaseZeroVolumeReport[] = [];
    for (const [index, sourceVolume] of sourceCase.volumes.entries()) {
      signal?.throwIfAborted();
      const expectedIds = fixture.tracks
        .slice(0, testCase.trackCount)
        .slice(index * 1_000, (index + 1) * 1_000)
        .map((track) => track.id);
      const observedIds = await apple.getOrderedPlaylistCatalogIds(sourceVolume.playlistId, signal);
      assertOrderedIds(observedIds, expectedIds, `phase-zero verification ${testCase.id} volume ${index + 1}`);
      const playlist = await apple.getLibraryPlaylist(sourceVolume.playlistId, signal);
      const name = expectedVolumeName(baseName, index, testCase.expectedVolumes);
      if (!playlist || playlistName(playlist) !== name || !isNeedleTestPlaylistName(name)) {
        throw new Error(`phase-zero verification ${testCase.id} volume ${index + 1} has an unexpected name`);
      }
      volumes.push({
        ...sourceVolume,
        index,
        name,
        expectedTrackCount: expectedIds.length,
        observedTrackCount: observedIds.length,
        expectedCatalogIdsHash: catalogIdsHash(expectedIds),
        observedCatalogIdsHash: catalogIdsHash(observedIds),
      });
    }
    verifiedCases.push({ ...sourceCase, volumes });
  }
  return withReportHash({
    ...report,
    reportId: randomUUID(),
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    status: "complete" as const,
    cases: verifiedCases,
    error: null,
  });
}

export async function inventoryNeedleTestPlaylists(
  apple: Pick<ApplePhaseZeroAppleClient, "validateAuthorization" | "listLibraryPlaylists">,
  expectedStorefront: string,
  signal?: AbortSignal,
  now = new Date(),
): Promise<ApplePhaseZeroInventoryReport> {
  const expected = storefront(expectedStorefront, "expected storefront");
  if ((await apple.validateAuthorization(signal)).toLowerCase() !== expected) {
    throw new Error("live Apple storefront does not match --expected-storefront");
  }
  const items = (await apple.listLibraryPlaylists(signal))
    .filter((item) => isNeedleTestPlaylistName(playlistName(item)))
    .map((item) => ({
      playlistId: string(item.id, "Apple playlist ID", 160),
      name: playlistName(item),
      shareUrl: playlistShareUrl(item),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.playlistId.localeCompare(b.playlistId));
  return withReportHash({
    schemaVersion: 1 as const,
    reportId: randomUUID(),
    storefront: expected,
    generatedAt: now.toISOString(),
    items,
    reportHash: "",
  });
}

export function playlistIdsFromPhaseZeroReport(report: ApplePhaseZeroReport): string[] {
  return [...new Set(report.cases.flatMap((testCase) => testCase.volumes.map((volume) => volume.playlistId)))];
}
