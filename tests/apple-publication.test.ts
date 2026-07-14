import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AppleApiError,
  AppleAuthorizationRequiredError,
  AppleMusicClient,
  ApplePlaylistDivergedError,
  AppleShareLinkUnavailableError,
  appleAuthorizationGeneration,
  appleAuthorizationJobDedupeKey,
  encryptMusicUserToken,
  processAppleAuthorizationJob,
  recoverUnverifiedAppleAuthorizationJob,
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
  encryptionKey: process.env.APPLE_TOKEN_ENCRYPTION_KEY,
  encryptionKeyId: process.env.APPLE_TOKEN_ENCRYPTION_KEY_ID,
};

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const testPrivateKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

beforeEach(() => {
  process.env.APPLE_TEAM_ID = "TESTTEAM01";
  process.env.APPLE_KEY_ID = "TESTKEY001";
  process.env.APPLE_MUSICKIT_PRIVATE_KEY = testPrivateKey;
  delete process.env.APPLE_MUSICKIT_PRIVATE_KEY_BASE64;
  process.env.APPLE_STOREFRONT = "us";
  process.env.APPLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.APPLE_TOKEN_ENCRYPTION_KEY_ID = "test-v1";
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
    APPLE_TOKEN_ENCRYPTION_KEY: originalAppleEnvironment.encryptionKey,
    APPLE_TOKEN_ENCRYPTION_KEY_ID: originalAppleEnvironment.encryptionKeyId,
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

  test("playlist creation explicitly requests a public library playlist", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return new Response(JSON.stringify({
        data: [{ id: "p.public", type: "library-playlists", attributes: { isPublic: true } }],
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AppleMusicClient("private-user-token", "us").createLibraryPlaylist("Needle", "Public test"))
      .resolves.toEqual({ id: "p.public", url: null });
    const request = fetchMock.mock.calls[0]?.[1] as unknown as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      attributes: { name: "Needle", description: "Public test", isPublic: true },
    });
  });

  test("share polling follows a library globalId to the catalog playlist URL", async () => {
    const publicUrl = "https://music.apple.com/us/playlist/needle/pl.u-public";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/v1/me/library/playlists/p.library?include=catalog")) {
        return new Response(JSON.stringify({
          data: [{
            id: "p.library",
            type: "library-playlists",
            attributes: { playParams: { globalId: "pl.u-public" } },
          }],
        }), { status: 200 });
      }
      if (url.endsWith("/v1/me/library/playlists/p.library/catalog")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (url.endsWith("/v1/catalog/us/playlists/pl.u-public")) {
        return new Response(JSON.stringify({
          data: [{ id: "pl.u-public", type: "playlists", attributes: { url: publicUrl } }],
        }), { status: 200 });
      }
      throw new Error(`Unexpected Apple test URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AppleMusicClient("private-user-token", "us").pollStableShareUrl("p.library", 2, 0))
      .resolves.toBe(publicUrl);
    expect(fetchMock.mock.calls.map((call) => String(call[0])))
      .toContain("https://api.music.apple.com/v1/catalog/us/playlists/pl.u-public");
  });

  test("share resolution follows the library playlist catalog relationship", async () => {
    const publicUrl = "https://music.apple.com/us/playlist/needle/pl.relationship";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/v1/me/library/playlists/p.relationship?include=catalog")) {
        return new Response(JSON.stringify({ data: [{ id: "p.relationship", type: "library-playlists" }] }), { status: 200 });
      }
      if (url.endsWith("/v1/me/library/playlists/p.relationship/catalog")) {
        return new Response(JSON.stringify({
          data: [{ id: "pl.relationship", type: "playlists", attributes: { url: publicUrl } }],
        }), { status: 200 });
      }
      throw new Error(`Unexpected Apple test URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AppleMusicClient("private-user-token", "us").resolveLibraryPlaylistShareUrl("p.relationship"))
      .resolves.toBe(publicUrl);
  });
});

test("worker recovery queues exactly the current unverified Apple authorization generation", async () => {
  const authorization = { ...validAuthorization, status: "unverified" };
  const repository = {
    getAppleAuthorization: vi.fn(async () => authorization),
    enqueueJob: vi.fn(async () => ({ created: true })),
  };

  await expect(recoverUnverifiedAppleAuthorizationJob(repository)).resolves.toBe(true);
  expect(repository.enqueueJob).toHaveBeenCalledWith({
    kind: "apple_authorization",
    payload: { authorizationGeneration: appleAuthorizationGeneration(authorization) },
    dedupeKey: appleAuthorizationJobDedupeKey(authorization),
    maxAttempts: 3,
  });

  repository.getAppleAuthorization.mockResolvedValue({ ...authorization, status: "valid" });
  await expect(recoverUnverifiedAppleAuthorizationJob(repository)).resolves.toBe(false);
  expect(repository.enqueueJob).toHaveBeenCalledTimes(1);
});

test("Apple authorization validation updates only the token generation that was checked", async () => {
  const envelope = JSON.parse(encryptMusicUserToken("private-valid-apple-user-token")) as {
    ciphertext: string;
    iv: string;
    tag: string;
    kid: string;
  };
  const authorization: AppleAuthorizationRecord = {
    ciphertext: envelope.ciphertext,
    iv: envelope.iv,
    authTag: envelope.tag,
    keyVersion: envelope.kid,
    storefront: "us",
    status: "unverified",
  };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "us" }] }), { status: 200 })));
  const repository = {
    getAppleAuthorization: vi.fn(async () => authorization),
    saveAppleAuthorization: vi.fn(async () => undefined),
    updateAppleAuthorizationStatus: vi.fn(async () => undefined),
    updateAppleAuthorizationValidation: vi.fn(async () => false),
    listWaitingPublicationManifestIds: vi.fn(async () => ["manifest-stale"]),
    getManifestById: vi.fn(async () => ({ runId: "run-stale" })),
    enqueueJob: vi.fn(async () => ({ created: true })),
  };

  await processAppleAuthorizationJob(repository, {
    authorizationGeneration: appleAuthorizationGeneration(authorization),
  });
  expect(repository.updateAppleAuthorizationValidation).toHaveBeenCalledWith({
    expectedCiphertext: authorization.ciphertext,
    expectedKeyVersion: authorization.keyVersion,
    storefront: "us",
    status: "valid",
    lastError: null,
  });
  expect(repository.listWaitingPublicationManifestIds).not.toHaveBeenCalled();
  expect(repository.enqueueJob).not.toHaveBeenCalled();

  repository.updateAppleAuthorizationValidation.mockResolvedValue(true);
  await processAppleAuthorizationJob(repository, { authorizationGeneration: "stale-generation" });
  expect(repository.updateAppleAuthorizationValidation).toHaveBeenCalledTimes(1);
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
    status: "queued",
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

test("publisher preserves the Apple playlist ID and exact track count when share polling times out", async () => {
  const repository = publicationRepository();
  let state: string[] = [];
  const client: PublicationAppleClient = {
    findLibraryPlaylistByMarker: vi.fn(async () => null),
    createLibraryPlaylist: vi.fn(async () => ({ id: "p.shareless", url: null })),
    appendCatalogTracks: vi.fn(async (_playlistId, ids) => { state = [...state, ...ids]; }),
    getOrderedPlaylistCatalogIds: vi.fn(async () => [...state]),
    pollStableShareUrl: vi.fn(async () => { throw new AppleShareLinkUnavailableError("p.shareless"); }),
  };

  await expect(appendExactVolume(repository, client, manifest, pendingVolume(), ["101"], validAuthorization))
    .rejects.toMatchObject({ name: "AppleShareLinkUnavailableError", playlistId: "p.shareless" });
  expect(repository.updatePublicationVolume).toHaveBeenCalledWith("volume-id", expect.objectContaining({
    applePlaylistId: "p.shareless",
    status: "appending",
  }));
  expect(repository.updatePublicationVolume).toHaveBeenLastCalledWith("volume-id", {
    appendedCount: 1,
    status: "waiting_for_share_url",
    lastError: "Apple did not expose a stable share link for playlist p.shareless",
  });
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
