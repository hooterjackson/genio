import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AppleApiError,
  AppleAuthorizationRequiredError,
  AppleMusicClient,
  ApplePlaylistDivergedError,
  type AppleAuthorizationRecord,
} from "../server/apple.ts";
import {
  APPLE_SMOKE_CONFIRMATION_FLAG,
  parseAppleSmokeArgs,
  publicAppleSmokeError,
  runApplePublicationSmoke,
  waitForExactApplePlaylistOrder,
  type AppleSmokeClient,
} from "../server/apple-smoke.ts";
import {
  appendExactVolume,
  type LockedManifest,
  type PublicationAppleClient,
  type PublicationRepository,
  type PublicationVolume,
} from "../server/publisher.ts";

const validAuthorization: AppleAuthorizationRecord = {
  ciphertext: "ciphertext-generation-one",
  iv: "iv",
  authTag: "tag",
  keyVersion: "v1",
  storefront: "us",
  status: "valid",
};

const originalAppleEnvironment = {
  teamId: process.env.APPLE_TEAM_ID,
  keyId: process.env.APPLE_KEY_ID,
  privateKey: process.env.APPLE_MUSICKIT_PRIVATE_KEY,
  privateKeyBase64: process.env.APPLE_MUSICKIT_PRIVATE_KEY_BASE64,
  storefront: process.env.APPLE_STOREFRONT,
};

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const testPrivateKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

beforeEach(() => {
  process.env.APPLE_TEAM_ID = "TESTTEAM01";
  process.env.APPLE_KEY_ID = "TESTKEY001";
  process.env.APPLE_MUSICKIT_PRIVATE_KEY = testPrivateKey;
  delete process.env.APPLE_MUSICKIT_PRIVATE_KEY_BASE64;
  process.env.APPLE_STOREFRONT = "us";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries({
    APPLE_TEAM_ID: originalAppleEnvironment.teamId,
    APPLE_KEY_ID: originalAppleEnvironment.keyId,
    APPLE_MUSICKIT_PRIVATE_KEY: originalAppleEnvironment.privateKey,
    APPLE_MUSICKIT_PRIVATE_KEY_BASE64: originalAppleEnvironment.privateKeyBase64,
    APPLE_STOREFRONT: originalAppleEnvironment.storefront,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Apple Music client failure classification", () => {
  test.each([401, 403] as const)("authenticated Apple %s responses require owner reauthorization", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: [{ title: "Denied" }] }), {
      status,
      headers: { "content-type": "application/json" },
    })));

    await expect(new AppleMusicClient("private-user-token").validateAuthorization())
      .rejects.toMatchObject({ name: "AppleAuthorizationRequiredError", status, retriable: false, uncertainMutation: false });
  });

  test("an unsafe transient POST failure is marked as an uncertain mutation and is not retried", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ errors: [{ title: "Temporary failure" }] }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AppleMusicClient("private-user-token").appendCatalogTracks("playlist-id", ["123"]))
      .rejects.toMatchObject({ name: "AppleApiError", status: 503, retriable: true, uncertainMutation: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

test("the live smoke CLI requires both explicit test naming and write confirmation", () => {
  expect(() => parseAppleSmokeArgs([
    "--name", "ordinary playlist", "--catalog-id", "123", APPLE_SMOKE_CONFIRMATION_FLAG,
  ])).toThrow(/must begin/);
  expect(() => parseAppleSmokeArgs([
    "--name", "[NEEDLE TEST] three tracks", "--catalog-id", "123",
  ])).toThrow(/confirm-live-write/);
  expect(parseAppleSmokeArgs([
    APPLE_SMOKE_CONFIRMATION_FLAG,
    "--name", "[NEEDLE TEST] ordered duplicates",
    "--catalog-id", "123",
    "--catalog-id", "123",
  ])).toEqual({
    confirmLiveWrite: true,
    name: "[NEEDLE TEST] ordered duplicates",
    catalogIds: ["123", "123"],
  });
});

test("eventually consistent Apple reads must converge on the exact ordered sequence", async () => {
  const reads = [[], ["101"], ["101", "202"]];
  const client = {
    getOrderedPlaylistCatalogIds: vi.fn(async () => reads.shift() ?? ["101", "202"]),
  };
  await expect(waitForExactApplePlaylistOrder(client, "playlist", ["101", "202"], { attempts: 4, delayMs: 0 }))
    .resolves.toEqual(["101", "202"]);

  client.getOrderedPlaylistCatalogIds.mockResolvedValueOnce(["202", "101"]);
  await expect(waitForExactApplePlaylistOrder(client, "playlist", ["101", "202"], { attempts: 1, delayMs: 0 }))
    .rejects.toBeInstanceOf(ApplePlaylistDivergedError);
});

test("the smoke harness reconciles a server-accepted append timeout before returning a public link", async () => {
  const expected = ["101", "202", "101"];
  let playlistState: string[] = [];
  const client: AppleSmokeClient = {
    validateAuthorization: vi.fn(async () => "us"),
    findLibraryPlaylistByMarker: vi.fn(async () => null),
    createLibraryPlaylist: vi.fn(async () => ({ id: "p.smoke", url: null })),
    appendCatalogTracks: vi.fn(async (_playlistId, ids) => {
      playlistState = [...playlistState, ...ids];
      throw new AppleApiError("Connection closed after acceptance", null, true, true);
    }),
    getOrderedPlaylistCatalogIds: vi.fn(async () => [...playlistState]),
    pollStableShareUrl: vi.fn(async () => "https://music.apple.com/us/playlist/needle-test/pl.smoke"),
  };

  const result = await runApplePublicationSmoke(
    { getAppleAuthorization: vi.fn(async () => validAuthorization) },
    { name: "[NEEDLE TEST] uncertain append", catalogIds: expected, confirmLiveWrite: true },
    undefined,
    { authorize: async () => ({ client, authorization: validAuthorization }), pollAttempts: 3, pollDelayMs: 0 },
  );

  expect(client.appendCatalogTracks).toHaveBeenCalledTimes(1);
  expect(result.orderedCatalogIds).toEqual(expected);
  expect(result.shareUrl).toContain("music.apple.com/us/playlist/");
});

function methodProxy(): any {
  const methods = new Map<PropertyKey, ReturnType<typeof vi.fn>>();
  return new Proxy({}, {
    get(_target, property) {
      if (!methods.has(property)) methods.set(property, vi.fn(async () => undefined));
      return methods.get(property);
    },
  });
}

function publicationRepository(): PublicationRepository & Record<string, ReturnType<typeof vi.fn>> {
  const repository = methodProxy();
  repository.getSetting.mockResolvedValue("false");
  repository.getAppleAuthorization.mockResolvedValue(validAuthorization);
  repository.getRunControlState.mockResolvedValue({ status: "publishing", phase: "apple_publication" });
  repository.markPlaylistOrphan.mockResolvedValue("orphan-id");
  repository.enqueueNotification.mockResolvedValue("notification-id");
  return repository;
}

const manifest: LockedManifest = {
  id: "manifest-id",
  runId: "run-id",
  name: "[NEEDLE TEST] publisher",
  description: "Publisher behavior test",
  contentHash: "hash",
  lockedAt: new Date().toISOString(),
  tracks: [],
};

function pendingVolume(): PublicationVolume {
  return {
    id: "volume-id",
    manifestId: manifest.id,
    runId: manifest.runId,
    volumeIndex: 0,
    volumeCount: 1,
    attempt: 0,
    name: manifest.name,
    description: manifest.description,
    playlistId: null,
    shareUrl: null,
    appendedCount: 0,
    status: "pending",
  };
}

test("publisher recovers an uncertain playlist creation by its private marker", async () => {
  const repository = publicationRepository();
  let markerLookups = 0;
  let state: string[] = [];
  const client: PublicationAppleClient = {
    findLibraryPlaylistByMarker: vi.fn(async () => {
      markerLookups += 1;
      return markerLookups === 1 ? null : { id: "p.recovered" };
    }),
    createLibraryPlaylist: vi.fn(async () => {
      throw new AppleApiError("Unknown create result", 503, true, true);
    }),
    appendCatalogTracks: vi.fn(async (_playlistId, ids) => { state = [...state, ...ids]; }),
    getOrderedPlaylistCatalogIds: vi.fn(async () => [...state]),
    pollStableShareUrl: vi.fn(async () => "https://music.apple.com/us/playlist/recovered/pl.recovered"),
  };

  const result = await appendExactVolume(repository, client, manifest, pendingVolume(), ["101"], validAuthorization);
  expect(result).toMatchObject({ playlistId: "p.recovered", appendedCount: 1, status: "complete" });
  expect(client.createLibraryPlaylist).toHaveBeenCalledTimes(1);
  expect(client.appendCatalogTracks).toHaveBeenCalledWith("p.recovered", ["101"], undefined);
});

test("publisher orphans a divergent playlist and creates a clean replacement", async () => {
  const repository = publicationRepository();
  const states = new Map<string, string[]>([["p.diverged", ["wrong-track"]], ["p.replacement", []]]);
  let createCount = 0;
  const client: PublicationAppleClient = {
    findLibraryPlaylistByMarker: vi.fn(async () => null),
    createLibraryPlaylist: vi.fn(async () => {
      createCount += 1;
      return { id: createCount === 1 ? "p.diverged" : "p.replacement", url: null };
    }),
    appendCatalogTracks: vi.fn(async (playlistId, ids) => {
      states.set(playlistId, [...(states.get(playlistId) ?? []), ...ids]);
    }),
    getOrderedPlaylistCatalogIds: vi.fn(async (playlistId) => [...(states.get(playlistId) ?? [])]),
    pollStableShareUrl: vi.fn(async () => "https://music.apple.com/us/playlist/replacement/pl.replacement"),
  };

  const result = await appendExactVolume(repository, client, manifest, pendingVolume(), ["101", "202"], validAuthorization);
  expect(repository.markPlaylistOrphan).toHaveBeenCalledWith(expect.objectContaining({ applePlaylistId: "p.diverged" }));
  expect(repository.updatePublicationVolume).toHaveBeenCalledWith("volume-id", expect.objectContaining({
    attemptDelta: 1,
    applePlaylistId: null,
    appendedCount: 0,
  }));
  expect(result).toMatchObject({ playlistId: "p.replacement", appendedCount: 2, status: "complete" });
  expect(states.get("p.replacement")).toEqual(["101", "202"]);
});

test("safe smoke failures never serialize an arbitrary provider or database error", () => {
  const privateError = new Error("postgres://user:password@private-host/openai-secret-key");
  expect(publicAppleSmokeError(privateError)).toEqual({
    code: "smoke_failed",
    message: "The Apple publication smoke test failed without exposing private diagnostics.",
  });
  expect(publicAppleSmokeError(new AppleAuthorizationRequiredError(403))).toEqual({
    code: "apple_reauthorization_required",
    message: "The owner must reauthorize Apple Music.",
    status: 403,
  });
});
