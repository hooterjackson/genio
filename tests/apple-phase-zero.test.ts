import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  AppleMusicClient,
  lookupAppleCatalogByIds,
} from "../server/apple.ts";
import {
  APPLE_PHASE_ZERO_CASES,
  APPLE_PHASE_ZERO_EXPANDED_CATALOG_IDS,
  APPLE_PHASE_ZERO_TOTAL_WRITTEN_TRACKS,
  acceptApplePhaseZeroFixture,
  inventoryNeedleTestPlaylists,
  phaseZeroFixtureHash,
  phaseZeroTestPlaylistName,
  playlistIdsFromPhaseZeroReport,
  publishApplePhaseZeroSuite,
  resolveApplePhaseZeroFixture,
  validateApplePhaseZeroCatalogIdInput,
  validateApplePhaseZeroReport,
  validateApplePhaseZeroResolvedFixture,
  verifyApplePhaseZeroReport,
  type ApplePhaseZeroManifestInput,
  type ApplePhaseZeroReport,
  type ApplePhaseZeroResolvedFixture,
} from "../server/apple-phase-zero.ts";
import { manifestContentHash } from "../server/publisher.ts";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const testPrivateKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const originalEnvironment = {
  teamId: process.env.APPLE_TEAM_ID,
  keyId: process.env.APPLE_KEY_ID,
  privateKey: process.env.APPLE_MUSICKIT_PRIVATE_KEY,
  privateKeyBase64: process.env.APPLE_MUSICKIT_PRIVATE_KEY_BASE64,
};

beforeEach(() => {
  process.env.APPLE_TEAM_ID = "TESTTEAM01";
  process.env.APPLE_KEY_ID = "TESTKEY001";
  process.env.APPLE_MUSICKIT_PRIVATE_KEY = testPrivateKey;
  delete process.env.APPLE_MUSICKIT_PRIVATE_KEY_BASE64;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries({
    APPLE_TEAM_ID: originalEnvironment.teamId,
    APPLE_KEY_ID: originalEnvironment.keyId,
    APPLE_MUSICKIT_PRIVATE_KEY: originalEnvironment.privateKey,
    APPLE_MUSICKIT_PRIVATE_KEY_BASE64: originalEnvironment.privateKeyBase64,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function seed(index: number) {
  return {
    id: String(1_000 + index),
    name: `Seed ${index}`,
    artistName: `Artist ${index}`,
    albumName: `Album ${index}`,
    releaseDate: `202${index}-01-01`,
    durationInMillis: 180_000 + index,
    isrc: `USAAA000000${index}`,
    url: `https://music.apple.com/us/song/seed-${index}/${1_000 + index}`,
  };
}

function fixture(now = new Date("2026-07-14T12:00:00.000Z")): ApplePhaseZeroResolvedFixture {
  const seeds = [seed(0), seed(1), seed(2)];
  const body: Omit<ApplePhaseZeroResolvedFixture, "fixtureHash"> = {
    schemaVersion: 1,
    suiteId: "live-2026-07-14",
    storefront: "us",
    resolvedAt: now.toISOString(),
    seedCount: seeds.length,
    tracks: Array.from({ length: APPLE_PHASE_ZERO_EXPANDED_CATALOG_IDS }, (_, index) => ({ ...seeds[index % seeds.length]! })),
  };
  return { ...body, fixtureHash: phaseZeroFixtureHash(body) };
}

test("phase-zero input accepts only 3-25 unique explicit numeric seed IDs", () => {
  expect(validateApplePhaseZeroCatalogIdInput({
    schemaVersion: 1,
    suiteId: "suite-001",
    storefront: "US",
    catalogIds: ["101", "202", "303"],
  })).toEqual({
    schemaVersion: 1,
    suiteId: "suite-001",
    storefront: "us",
    catalogIds: ["101", "202", "303"],
  });
  expect(() => validateApplePhaseZeroCatalogIdInput({
    schemaVersion: 1,
    suiteId: "suite-001",
    storefront: "us",
    catalogIds: ["101", "202"],
  })).toThrow(/3-25/);
  expect(() => validateApplePhaseZeroCatalogIdInput({
    schemaVersion: 1,
    suiteId: "suite-001",
    storefront: "us",
    catalogIds: ["101", "101", "303"],
  })).toThrow(/duplicates/);
  expect(() => validateApplePhaseZeroCatalogIdInput({
    schemaVersion: 1,
    suiteId: "suite-001",
    storefront: "us",
    catalogIds: ["101", "202", "not-a-song"],
  })).toThrow(/numeric Apple song ID/);
  expect(() => validateApplePhaseZeroCatalogIdInput({
    schemaVersion: 1,
    suiteId: "suite-001",
    storefront: "us",
    catalogIds: ["101", "202", "303"],
    upstreamUrl: "https://attacker.example",
  })).toThrow(/unsupported fields/);
});

test("resolution looks up only the explicit seeds then cycles them deterministically to 5,000", async () => {
  const resolveCatalogSongs = vi.fn(async (_storefront: string, ids: readonly string[]) => ids.map((id) => seed(Number(id) - 1_000)));
  const resolved = await resolveApplePhaseZeroFixture({
    schemaVersion: 1,
    suiteId: "suite-001",
    storefront: "us",
    catalogIds: ["1000", "1001", "1002"],
  }, { resolveCatalogSongs }, undefined, new Date("2026-07-14T12:00:00.000Z"));

  expect(resolveCatalogSongs).toHaveBeenCalledTimes(1);
  expect(resolveCatalogSongs).toHaveBeenCalledWith("us", ["1000", "1001", "1002"], undefined);
  expect(resolved.seedCount).toBe(3);
  expect(resolved.tracks).toHaveLength(5_000);
  expect(resolved.tracks.slice(0, 7).map((track) => track.id)).toEqual(["1000", "1001", "1002", "1000", "1001", "1002", "1000"]);
  expect(validateApplePhaseZeroResolvedFixture(resolved)).toEqual(resolved);

  const altered = structuredClone(resolved);
  altered.tracks[4] = altered.tracks[0]!;
  const { fixtureHash: _ignored, ...alteredBody } = altered;
  void _ignored;
  altered.fixtureHash = phaseZeroFixtureHash(alteredBody);
  expect(() => validateApplePhaseZeroResolvedFixture(altered)).toThrow(/cycle expansion/);
});

test("fixture acceptance binds the reviewed hash, storefront, and a fresh resolution window", () => {
  const resolved = fixture();
  expect(acceptApplePhaseZeroFixture(resolved, resolved.fixtureHash, "us", new Date("2026-07-14T13:00:00.000Z"))).toEqual(resolved);
  expect(() => acceptApplePhaseZeroFixture(resolved, "0".repeat(64), "us", new Date("2026-07-14T13:00:00.000Z"))).toThrow(/exactly match/);
  expect(() => acceptApplePhaseZeroFixture(resolved, resolved.fixtureHash, "br", new Date("2026-07-14T13:00:00.000Z"))).toThrow(/storefront/);
  expect(() => acceptApplePhaseZeroFixture(resolved, resolved.fixtureHash, "us", new Date("2026-07-14T15:00:00.001Z"))).toThrow(/stale/);
});

test("production-path phase-zero suite publishes and re-reads 3, 100, 500, 1000, and five exact duplicate-aware volumes", async () => {
  const resolved = fixture();
  const manifests = new Map<string, ApplePhaseZeroManifestInput>();
  const playlistStates = new Map<string, { ids: string[]; name: string }>();
  const store = {
    createApplePhaseZeroManifest: vi.fn(async (input: ApplePhaseZeroManifestInput) => {
      const manifestId = `manifest-${input.caseId}`;
      manifests.set(manifestId, input);
      const tracks = input.tracks.map((track, position) => ({
        position,
        candidateId: `candidate-${input.caseId}-${position}`,
        catalogId: track.id,
        artist: track.artistName,
        title: track.name,
      }));
      return {
        id: manifestId,
        runId: `run-${input.caseId}`,
        name: input.name,
        description: input.description,
        contentHash: manifestContentHash(tracks),
        lockedAt: "2026-07-14T12:00:00.000Z",
        tracks,
      };
    }),
  };
  const publish = vi.fn(async (_repository: unknown, manifestId: string) => {
    const input = manifests.get(manifestId)!;
    const volumeCount = Math.ceil(input.tracks.length / 1_000);
    return {
      status: "complete" as const,
      manifestId,
      volumes: Array.from({ length: volumeCount }, (_, index) => {
        const playlistId = `p.${input.caseId}.${index + 1}`;
        const name = volumeCount === 1 ? input.name : `${input.name} [${index + 1}/${volumeCount}]`;
        const ids = input.tracks.slice(index * 1_000, (index + 1) * 1_000).map((track) => track.id);
        playlistStates.set(playlistId, { ids, name });
        return {
          index,
          playlistId,
          shareUrl: `https://music.apple.com/us/playlist/needle-test/pl.${input.caseId}-${index + 1}`,
          trackCount: ids.length,
        };
      }),
    };
  });
  const apple = {
    validateAuthorization: vi.fn(async () => "us"),
    getOrderedPlaylistCatalogIds: vi.fn(async (playlistId: string) => [...playlistStates.get(playlistId)!.ids]),
    getLibraryPlaylist: vi.fn(async (playlistId: string) => ({
      id: playlistId,
      attributes: { name: playlistStates.get(playlistId)!.name },
    })),
  };
  const checkpoints: ApplePhaseZeroReport[] = [];
  const report = await publishApplePhaseZeroSuite(
    store,
    {},
    apple,
    resolved,
    publish,
    async (value) => { checkpoints.push(structuredClone(value)); },
    undefined,
    () => new Date("2026-07-14T13:00:00.000Z"),
  );

  expect(report.status).toBe("complete");
  expect(report.expectedWrittenTrackCount).toBe(APPLE_PHASE_ZERO_TOTAL_WRITTEN_TRACKS);
  expect(report.cases.map((item) => [item.id, item.expectedTrackCount, item.volumes.length])).toEqual(
    APPLE_PHASE_ZERO_CASES.map((item) => [item.id, item.trackCount, item.expectedVolumes]),
  );
  expect(playlistIdsFromPhaseZeroReport(report)).toHaveLength(9);
  expect(report.cases.flatMap((item) => item.volumes).every((volume) => (
    volume.expectedCatalogIdsHash === volume.observedCatalogIdsHash
    && volume.expectedTrackCount === volume.observedTrackCount
  ))).toBe(true);
  expect(report.cases.at(-1)!.volumes.map((volume) => volume.name)).toEqual(
    Array.from({ length: 5 }, (_, index) => `${phaseZeroTestPlaylistName(resolved.suiteId, "five volumes")} [${index + 1}/5]`),
  );
  expect(report.cases.at(-1)!.volumes[0]!.expectedTrackCount).toBe(1_000);
  expect(playlistStates.get("p.five-volumes.1")!.ids.slice(0, 6)).toEqual(["1000", "1001", "1002", "1000", "1001", "1002"]);
  expect(checkpoints.at(-1)).toEqual(report);
  expect(validateApplePhaseZeroReport(report)).toEqual(report);

  const verified = await verifyApplePhaseZeroReport(
    apple,
    "us",
    resolved,
    resolved.fixtureHash,
    report,
    report.reportHash,
    undefined,
    new Date("2026-08-14T13:00:00.000Z"),
  );
  expect(verified.status).toBe("complete");
  expect(verified.reportHash).not.toBe(report.reportHash);
});

test("suite fails closed before any manifest or write when the live storefront differs", async () => {
  const resolved = fixture();
  const store = { createApplePhaseZeroManifest: vi.fn() };
  const publish = vi.fn();
  await expect(publishApplePhaseZeroSuite(
    store,
    {},
    {
      validateAuthorization: vi.fn(async () => "br"),
      getOrderedPlaylistCatalogIds: vi.fn(),
      getLibraryPlaylist: vi.fn(),
    },
    resolved,
    publish,
    vi.fn(),
  )).rejects.toThrow(/storefront/);
  expect(store.createApplePhaseZeroManifest).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});

test("inventory returns only exact [NEEDLE TEST] namespace playlists and never mutates Apple", async () => {
  const report = await inventoryNeedleTestPlaylists({
    validateAuthorization: vi.fn(async () => "us"),
    listLibraryPlaylists: vi.fn(async () => [
      { id: "p.good", attributes: { name: "[NEEDLE TEST] suite 3 tracks", url: "https://music.apple.com/us/playlist/test/pl.good" } },
      { id: "p.near", attributes: { name: "[NEEDLE TEST]evil" } },
      { id: "p.personal", attributes: { name: "My personal playlist" } },
    ]),
  }, "us", undefined, new Date("2026-07-14T13:00:00.000Z"));
  expect(report.items).toEqual([{
    playlistId: "p.good",
    name: "[NEEDLE TEST] suite 3 tracks",
    shareUrl: "https://music.apple.com/us/playlist/test/pl.good",
  }]);
});

test("catalog-ID lookup sends one bounded public catalog request and rejects nonnumeric or duplicate IDs", async () => {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe("/v1/catalog/us/songs");
    expect(url.searchParams.get("ids")).toBe("101,202,303");
    return new Response(JSON.stringify({ data: [
      { id: "202", attributes: { name: "Two", artistName: "Artist", albumName: "Album" } },
      { id: "101", attributes: { name: "One", artistName: "Artist", albumName: "Album" } },
      { id: "303", attributes: { name: "Three", artistName: "Artist", albumName: "Album" } },
    ] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  await expect(lookupAppleCatalogByIds("us", ["101", "202", "303"]))
    .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "101" }), expect.objectContaining({ id: "202" }), expect.objectContaining({ id: "303" })]));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await expect(lookupAppleCatalogByIds("us", ["101", "101"])).rejects.toThrow(/unique numeric/);
  await expect(lookupAppleCatalogByIds("us", ["not-numeric"])).rejects.toThrow(/unique numeric/);
});

test("Apple library inventory paginates without exposing a deletion operation", async () => {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.searchParams.get("offset") === "100") {
      return new Response(JSON.stringify({ data: [{ id: "p.second", attributes: { name: "[NEEDLE TEST] second" } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      data: [{ id: "p.first", attributes: { name: "[NEEDLE TEST] first" } }],
      next: "/v1/me/library/playlists?limit=100&offset=100",
    }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new AppleMusicClient("private-test-user-token", "us");
  await expect(client.listLibraryPlaylists()).resolves.toMatchObject([{ id: "p.first" }, { id: "p.second" }]);
  expect("deleteLibraryPlaylist" in client).toBe(false);
});
