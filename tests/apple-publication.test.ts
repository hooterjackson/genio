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
  type AppleAuthorizationJobRepository,
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
  manifestContentHash,
  planPublicationVolumes,
  publishManifest,
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

  test("ordered playlist reads retain order across Apple pagination and reject an untrusted next host", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => String(1_000 + index));
    const secondPage = ["1100"];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.searchParams.get("offset") === "100") {
        return new Response(JSON.stringify({
          data: secondPage.map((catalogId) => ({ attributes: { playParams: { catalogId } } })),
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: firstPage.map((catalogId) => ({ relationships: { catalog: { data: [{ id: catalogId }] } } })),
        next: "https://api.music.apple.com/v1/me/library/playlists/p.page/tracks?limit=100&offset=100",
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AppleMusicClient("private-user-token").getOrderedPlaylistCatalogIds("p.page"))
      .resolves.toEqual([...firstPage, ...secondPage]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({
      data: [],
      next: "https://attacker.example/v1/me/library/playlists/p.page/tracks?offset=100",
    }), { status: 200 }));
    await expect(new AppleMusicClient("private-user-token").getOrderedPlaylistCatalogIds("p.page"))
      .rejects.toThrow(/invalid pagination URL/);
  });

  test("safe Apple GETs honor bounded 429 and 5xx retries", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ title: "Rate limited" }] }), {
        status: 429,
        headers: { "retry-after": "0.001" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ title: "Temporary" }] }), {
        status: 503,
        headers: { "retry-after": "0.001" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "us" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AppleMusicClient("private-user-token").validateAuthorization()).resolves.toBe("us");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockReset().mockImplementation(async () => new Response(JSON.stringify({ errors: [{ title: "Still unavailable" }] }), {
      status: 503,
      headers: { "retry-after": "0.001" },
    }));
    await expect(new AppleMusicClient("private-user-token").validateAuthorization())
      .rejects.toMatchObject({ name: "AppleApiError", status: 503, retriable: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
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

function encryptedAuthorizationRecord(token: string, status = "valid"): AppleAuthorizationRecord {
  const envelope = JSON.parse(encryptMusicUserToken(token)) as {
    ciphertext: string;
    iv: string;
    tag: string;
    kid: string;
  };
  return {
    ciphertext: envelope.ciphertext,
    iv: envelope.iv,
    authTag: envelope.tag,
    keyVersion: envelope.kid,
    storefront: "us",
    status,
  };
}

function lockedManifest(trackCount = 3, id = "manifest-production"): LockedManifest {
  const tracks = Array.from({ length: trackCount }, (_, index) => ({
    candidateId: `candidate-${index}`,
    catalogId: String(101 + index),
    artist: "Test Artist",
    title: `Test Track ${index + 1}`,
    position: index,
  }));
  return {
    id,
    runId: `run-${id}`,
    name: "[NEEDLE TEST] production publisher",
    description: "Deterministic production publisher test",
    contentHash: manifestContentHash(tracks),
    lockedAt: new Date().toISOString(),
    tracks,
  };
}

function durablePublicationHarness(input: {
  manifest?: LockedManifest | null;
  authorization?: AppleAuthorizationRecord | null;
} = {}) {
  const activeManifest = input.manifest === undefined ? lockedManifest() : input.manifest;
  let authorization = input.authorization === undefined
    ? encryptedAuthorizationRecord("private-production-user-token")
    : input.authorization;
  let run = activeManifest
    ? { status: "manifest_ready", phase: "manifest", error: null as string | null }
    : null;
  const volumes: any[] = [];
  const repository = methodProxy();
  repository.getManifestById.mockImplementation(async (manifestId: string) => (
    activeManifest?.id === manifestId ? activeManifest : null
  ));
  repository.getSetting.mockResolvedValue("false");
  repository.getRunControlState.mockImplementation(async () => run);
  repository.getAppleAuthorization.mockImplementation(async () => authorization);
  repository.updateAppleAuthorizationStatus.mockImplementation(async (status: string, lastError?: string | null) => {
    if (authorization) authorization = { ...authorization, status, lastError: lastError ?? null };
  });
  repository.updateAppleAuthorizationValidation.mockImplementation(async (update: {
    expectedCiphertext: string;
    expectedKeyVersion: string;
    storefront?: string;
    status: "valid" | "reauthorization_required";
    lastError?: string | null;
  }) => {
    if (!authorization
      || authorization.ciphertext !== update.expectedCiphertext
      || authorization.keyVersion !== update.expectedKeyVersion) return false;
    authorization = {
      ...authorization,
      storefront: update.storefront ?? authorization.storefront,
      status: update.status,
      lastError: update.lastError ?? null,
    };
    return true;
  });
  repository.updateRun.mockImplementation(async (_runId: string, patch: Record<string, unknown>) => {
    if (run) run = { ...run, ...patch } as typeof run;
  });
  repository.createPublicationVolume.mockImplementation(async (volume: Record<string, unknown>) => {
    const stored: any = {
      id: `volume-${volumes.length + 1}`,
      ...volume,
      status: volume.status ?? "queued",
      applePlaylistId: null,
      appleShareUrl: null,
      appendedCount: 0,
      attempt: 0,
      lastError: null,
    };
    const existing = volumes.find((item) => item.manifestId === stored.manifestId && item.volumeNumber === stored.volumeNumber);
    if (existing) return existing;
    volumes.push(stored);
    return stored;
  });
  repository.listPublicationVolumes.mockImplementation(async () => volumes.map((volume) => ({ ...volume })));
  repository.updatePublicationVolume.mockImplementation(async (volumeId: string, patch: Record<string, unknown>) => {
    const volume = volumes.find((item) => item.id === volumeId);
    if (!volume) throw new Error("Publication volume not found in test harness");
    for (const key of ["status", "applePlaylistId", "appleShareUrl", "appendedCount", "lastError", "publishedAt"]) {
      if (key in patch) volume[key] = patch[key];
    }
    if (typeof patch.attemptDelta === "number") volume.attempt += patch.attemptDelta;
  });
  repository.getPublicationCompleteness.mockResolvedValue({ omittedCandidateCount: 0, unresolvedCoverageCount: 0 });
  repository.markPlaylistOrphan.mockImplementation(async () => `orphan-${repository.markPlaylistOrphan.mock.calls.length}`);
  repository.enqueueNotification.mockImplementation(async () => `notification-${repository.enqueueNotification.mock.calls.length}`);
  repository.listWaitingPublicationManifestIds.mockImplementation(async () => (
    run?.status === "waiting_for_apple_authorization" && activeManifest ? [activeManifest.id] : []
  ));
  repository.enqueueJob.mockResolvedValue({ created: true });

  return {
    repository: repository as PublicationRepository & AppleAuthorizationJobRepository & Record<string, ReturnType<typeof vi.fn>>,
    volumes,
    get authorization() { return authorization; },
    setAuthorization(next: AppleAuthorizationRecord | null) { authorization = next; },
    get run() { return run; },
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

test("the production publisher completes a locked manifest through the real Apple client boundary", async () => {
  const productionManifest = lockedManifest(3, "manifest-happy-path");
  const harness = durablePublicationHarness({ manifest: productionManifest });
  const playlistState: string[] = [];
  const shareUrl = "https://music.apple.com/us/playlist/needle-production/pl.production";
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/v1/me/library/playlists" && method === "GET") {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (url.pathname === "/v1/me/library/playlists" && method === "POST") {
      return new Response(JSON.stringify({ data: [{ id: "p.production", type: "library-playlists" }] }), { status: 201 });
    }
    if (url.pathname === "/v1/me/library/playlists/p.production/tracks" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { data: Array<{ id: string }> };
      playlistState.push(...body.data.map((item) => item.id));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/v1/me/library/playlists/p.production/tracks" && method === "GET") {
      return new Response(JSON.stringify({
        data: playlistState.map((catalogId) => ({ attributes: { playParams: { catalogId } } })),
      }), { status: 200 });
    }
    if (url.pathname === "/v1/me/library/playlists/p.production" && method === "GET") {
      return new Response(JSON.stringify({
        data: [{ id: "p.production", type: "library-playlists", attributes: { url: shareUrl } }],
      }), { status: 200 });
    }
    throw new Error(`Unexpected Apple test request: ${method} ${url.pathname}${url.search}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(publishManifest(harness.repository, productionManifest.id)).resolves.toEqual({
    status: "complete",
    manifestId: productionManifest.id,
    volumes: [{ index: 0, playlistId: "p.production", shareUrl, trackCount: 3 }],
  });
  expect(playlistState).toEqual(productionManifest.tracks.map((track) => track.catalogId));
  expect(harness.run).toMatchObject({ status: "complete", phase: "published", error: null });
  expect(harness.volumes).toHaveLength(1);
  expect(harness.volumes[0]).toMatchObject({
    volumeNumber: 1,
    volumeCount: 1,
    applePlaylistId: "p.production",
    appleShareUrl: shareUrl,
    appendedCount: 3,
    status: "complete",
  });
  expect(harness.repository.enqueueNotification).toHaveBeenCalledWith("publication_complete", expect.objectContaining({
    manifestId: productionManifest.id,
    runId: productionManifest.runId,
    volumeCount: 1,
    status: "complete",
  }));
});

test("the production publisher executes a 6,000-track plan across six exact volumes", async () => {
  const base = lockedManifest(6_000, "manifest-six-thousand");
  const tracks = base.tracks.map((track) => ({ ...track }));
  tracks[24]!.catalogId = "777777";
  tracks[26]!.catalogId = "777777";
  tracks[999]!.catalogId = "888888";
  tracks[1_000]!.catalogId = "888888";
  const productionManifest = { ...base, tracks, contentHash: manifestContentHash(tracks) };
  const harness = durablePublicationHarness({ manifest: productionManifest });
  const playlistStates = new Map<string, string[]>();
  const createdNames: string[] = [];
  let playlistNumber = 0;
  let acceptedThenDisconnected = false;
  let rateLimited = false;

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/v1/me/library/playlists" && method === "GET") {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (url.pathname === "/v1/me/library/playlists" && method === "POST") {
      playlistNumber += 1;
      const playlistId = `p.volume-${playlistNumber}`;
      const body = JSON.parse(String(init?.body)) as { attributes: { name: string } };
      createdNames.push(body.attributes.name);
      playlistStates.set(playlistId, []);
      return new Response(JSON.stringify({ data: [{ id: playlistId, type: "library-playlists" }] }), { status: 201 });
    }

    const tracksMatch = url.pathname.match(/^\/v1\/me\/library\/playlists\/(p\.volume-\d+)\/tracks$/u);
    if (tracksMatch) {
      const playlistId = tracksMatch[1]!;
      const state = playlistStates.get(playlistId) ?? [];
      if (method === "POST") {
        const body = JSON.parse(String(init?.body)) as { data: Array<{ id: string }> };
        const ids = body.data.map((item) => item.id);
        if (playlistId === "p.volume-1" && !acceptedThenDisconnected) {
          acceptedThenDisconnected = true;
          state.push(...ids);
          playlistStates.set(playlistId, state);
          throw new Error("connection closed after Apple accepted the first batch");
        }
        if (playlistId === "p.volume-2" && !rateLimited) {
          rateLimited = true;
          return new Response(JSON.stringify({ errors: [{ title: "Rate limited" }] }), {
            status: 429,
            headers: { "retry-after": "0.001" },
          });
        }
        state.push(...ids);
        playlistStates.set(playlistId, state);
        return new Response(null, { status: 204 });
      }
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const page = state.slice(offset, offset + 100);
      const nextOffset = offset + page.length;
      return new Response(JSON.stringify({
        data: page.map((catalogId) => ({ attributes: { playParams: { catalogId } } })),
        ...(nextOffset < state.length
          ? { next: `/v1/me/library/playlists/${playlistId}/tracks?limit=100&offset=${nextOffset}` }
          : {}),
      }), { status: 200 });
    }

    const playlistMatch = url.pathname.match(/^\/v1\/me\/library\/playlists\/(p\.volume-\d+)$/u);
    if (playlistMatch && method === "GET") {
      const playlistId = playlistMatch[1]!;
      const number = Number(playlistId.split("-").at(-1));
      return new Response(JSON.stringify({
        data: [{
          id: playlistId,
          type: "library-playlists",
          attributes: { url: `https://music.apple.com/us/playlist/needle-volume-${number}/pl.volume-${number}` },
        }],
      }), { status: 200 });
    }
    throw new Error(`Unexpected Apple scale-test request: ${method} ${url.pathname}${url.search}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const result = await publishManifest(harness.repository, productionManifest.id);
  expect(result.status).toBe("complete");
  expect(result.volumes).toHaveLength(6);
  expect(result.volumes.every((volume) => volume.trackCount === 1_000)).toBe(true);
  expect(result.volumes.map((volume) => volume.index)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(createdNames).toEqual(Array.from({ length: 6 }, (_, index) =>
    `${productionManifest.name} [${index + 1}/6]`));
  expect(harness.volumes.every((volume) => volume.status === "complete" && volume.appendedCount === 1_000)).toBe(true);
  expect(acceptedThenDisconnected).toBe(true);
  expect(rateLimited).toBe(true);
  expect(fetchMock.mock.calls.filter(([input, init]) => (
    /\/tracks$/u.test(new URL(String(input)).pathname)
    && String((init as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "POST"
  ))).toHaveLength(241); // 240 accepted batches plus one safely reconciled 429.
  for (let index = 0; index < 6; index += 1) {
    expect(playlistStates.get(`p.volume-${index + 1}`)).toEqual(
      productionManifest.tracks.slice(index * 1_000, (index + 1) * 1_000).map((track) => track.catalogId),
    );
  }
});

test("a production Apple 403 preserves the manifest and resumes it after a replacement authorization validates", async () => {
  const productionManifest = lockedManifest(3, "manifest-reauthorization");
  const firstAuthorization = encryptedAuthorizationRecord("private-first-user-token");
  const harness = durablePublicationHarness({ manifest: productionManifest, authorization: firstAuthorization });
  const playlistState: string[] = [];
  let rejectNextAppend = true;
  const shareUrl = "https://music.apple.com/us/playlist/needle-resumed/pl.resumed";
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/v1/me/storefront") {
      return new Response(JSON.stringify({ data: [{ id: "us" }] }), { status: 200 });
    }
    if (url.pathname === "/v1/me/library/playlists" && method === "GET") {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (url.pathname === "/v1/me/library/playlists" && method === "POST") {
      return new Response(JSON.stringify({ data: [{ id: "p.resumed", type: "library-playlists" }] }), { status: 201 });
    }
    if (url.pathname === "/v1/me/library/playlists/p.resumed/tracks" && method === "POST") {
      if (rejectNextAppend) {
        rejectNextAppend = false;
        return new Response(JSON.stringify({ errors: [{ title: "Authorization expired" }] }), { status: 403 });
      }
      const body = JSON.parse(String(init?.body)) as { data: Array<{ id: string }> };
      playlistState.push(...body.data.map((item) => item.id));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/v1/me/library/playlists/p.resumed/tracks" && method === "GET") {
      return new Response(JSON.stringify({
        data: playlistState.map((catalogId) => ({ attributes: { playParams: { catalogId } } })),
      }), { status: 200 });
    }
    if (url.pathname === "/v1/me/library/playlists/p.resumed" && method === "GET") {
      return new Response(JSON.stringify({
        data: [{ id: "p.resumed", type: "library-playlists", attributes: { url: shareUrl } }],
      }), { status: 200 });
    }
    throw new Error(`Unexpected Apple test request: ${method} ${url.pathname}${url.search}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(publishManifest(harness.repository, productionManifest.id)).resolves.toEqual({
    status: "waiting_for_apple_authorization",
    manifestId: productionManifest.id,
    volumes: [],
  });
  expect(harness.run).toMatchObject({ status: "waiting_for_apple_authorization", phase: "apple_reauthorization", error: null });
  expect(harness.volumes).toHaveLength(1);
  expect(harness.volumes[0]).toMatchObject({
    applePlaylistId: "p.resumed",
    appendedCount: 0,
    status: "waiting_for_owner",
  });
  expect(harness.repository.updateAppleAuthorizationStatus).toHaveBeenCalledWith(
    "reauthorization_required",
    expect.any(String),
  );
  expect(harness.repository.enqueueNotification).toHaveBeenCalledWith(
    "apple_reauthorization_required",
    expect.objectContaining({ manifestId: productionManifest.id }),
  );

  const replacementAuthorization = encryptedAuthorizationRecord("private-replacement-user-token", "unverified");
  harness.setAuthorization(replacementAuthorization);
  await processAppleAuthorizationJob(harness.repository, {
    authorizationGeneration: appleAuthorizationGeneration(replacementAuthorization),
  });
  expect(harness.authorization).toMatchObject({ status: "valid", storefront: "us" });
  expect(harness.repository.enqueueJob).toHaveBeenCalledWith({
    kind: "publication",
    runId: productionManifest.runId,
    payload: { manifestId: productionManifest.id },
    dedupeKey: `publication:${productionManifest.id}:reauth:${appleAuthorizationGeneration(replacementAuthorization)}`,
  });

  await expect(publishManifest(harness.repository, productionManifest.id)).resolves.toMatchObject({
    status: "complete",
    manifestId: productionManifest.id,
    volumes: [{ playlistId: "p.resumed", shareUrl, trackCount: 3 }],
  });
  expect(playlistState).toEqual(productionManifest.tracks.map((track) => track.catalogId));
  expect(harness.volumes).toHaveLength(1);
  expect(harness.volumes[0]).toMatchObject({ status: "complete", appendedCount: 3, applePlaylistId: "p.resumed" });
  expect(harness.repository.createPublicationVolume).toHaveBeenCalledTimes(1);
});

test("the production publisher resumes from Apple's accepted prefix after interruption before persistence", async () => {
  const expected = Array.from({ length: 30 }, (_, index) => String(1_000 + index));
  const repository = publicationRepository();
  const volume = { ...pendingVolume(), playlistId: "p.interrupted", status: "appending" as const };
  let playlistState: string[] = [];
  let interruptAfterFirstAppend = true;
  const controller = new AbortController();
  const client: PublicationAppleClient = {
    findLibraryPlaylistByMarker: vi.fn(async () => null),
    createLibraryPlaylist: vi.fn(async () => ({ id: "p.interrupted", url: null })),
    appendCatalogTracks: vi.fn(async (_playlistId, ids) => {
      playlistState = [...playlistState, ...ids];
      if (interruptAfterFirstAppend) {
        interruptAfterFirstAppend = false;
        controller.abort(new Error("worker interrupted after Apple accepted the batch"));
        throw new AppleApiError("Connection closed after acceptance", null, true, true);
      }
    }),
    getOrderedPlaylistCatalogIds: vi.fn(async () => [...playlistState]),
    pollStableShareUrl: vi.fn(async () => "https://music.apple.com/us/playlist/interrupted/pl.interrupted"),
  };

  await expect(appendExactVolume(repository, client, manifest, volume, expected, validAuthorization, controller.signal))
    .rejects.toThrow(/worker interrupted/);
  expect(playlistState).toEqual(expected.slice(0, 25));

  const resumed = await appendExactVolume(repository, client, manifest, volume, expected, validAuthorization);
  expect(resumed).toMatchObject({ playlistId: "p.interrupted", appendedCount: 30, status: "complete" });
  expect(playlistState).toEqual(expected);
  expect(client.appendCatalogTracks).toHaveBeenNthCalledWith(1, "p.interrupted", expected.slice(0, 25), controller.signal);
  expect(client.appendCatalogTracks).toHaveBeenNthCalledWith(2, "p.interrupted", expected.slice(25), undefined);
});

test("publication volume planning is exact at 999, 1,000, and 1,001 tracks", () => {
  const tracks = Array.from({ length: 1_001 }, (_, index) => ({
    candidateId: `boundary-candidate-${index}`,
    catalogId: String(10_000 + index),
    artist: "Boundary Artist",
    title: `Boundary Track ${index}`,
  }));
  expect(planPublicationVolumes(tracks.slice(0, 999))).toMatchObject([
    { volumeIndex: 0, volumeCount: 1, startPosition: 0, endPosition: 998 },
  ]);
  expect(planPublicationVolumes(tracks.slice(0, 1_000))).toMatchObject([
    { volumeIndex: 0, volumeCount: 1, startPosition: 0, endPosition: 999 },
  ]);
  const split = planPublicationVolumes(tracks);
  expect(split).toHaveLength(2);
  expect(split.map((volume) => ({
    volumeIndex: volume.volumeIndex,
    volumeCount: volume.volumeCount,
    startPosition: volume.startPosition,
    endPosition: volume.endPosition,
    length: volume.catalogIds.length,
  }))).toEqual([
    { volumeIndex: 0, volumeCount: 2, startPosition: 0, endPosition: 999, length: 1_000 },
    { volumeIndex: 1, volumeCount: 2, startPosition: 1_000, endPosition: 1_000, length: 1 },
  ]);
});

test("the publisher stops after the bounded divergent-playlist replacement ceiling", async () => {
  const repository = publicationRepository();
  let replacementCount = 0;
  const client: PublicationAppleClient = {
    findLibraryPlaylistByMarker: vi.fn(async () => null),
    createLibraryPlaylist: vi.fn(async () => {
      replacementCount += 1;
      return { id: `p.replacement-${replacementCount}`, url: null };
    }),
    appendCatalogTracks: vi.fn(async () => undefined),
    getOrderedPlaylistCatalogIds: vi.fn(async () => ["wrong-track"]),
    pollStableShareUrl: vi.fn(async () => "https://music.apple.com/us/playlist/never/pl.never"),
  };
  const existing = { ...pendingVolume(), playlistId: "p.original-divergent", status: "appending" as const };

  await expect(appendExactVolume(repository, client, manifest, existing, ["expected-track"], validAuthorization))
    .rejects.toThrow(/diverged too many times/);
  expect(repository.markPlaylistOrphan).toHaveBeenCalledTimes(4);
  expect(client.createLibraryPlaylist).toHaveBeenCalledTimes(3);
  expect(client.appendCatalogTracks).not.toHaveBeenCalled();
  expect(client.pollStableShareUrl).not.toHaveBeenCalled();
});

test("publishManifest rejects missing, mutable, corrupt, empty, and catalog-incomplete manifests before Apple access", async () => {
  const base = lockedManifest(1, "manifest-validation");
  const emptyTracks: LockedManifest = {
    ...base,
    id: "manifest-empty",
    tracks: [],
    contentHash: manifestContentHash([]),
  };
  const missingCatalogTracks = [{ ...base.tracks[0]!, catalogId: "" }];
  const cases: Array<{ manifest: LockedManifest | null; id: string; message: RegExp }> = [
    { manifest: null, id: "manifest-missing", message: /was not found/ },
    { manifest: { ...base, lockedAt: "" }, id: base.id, message: /immutable locked manifest/ },
    { manifest: { ...base, contentHash: "0".repeat(64) }, id: base.id, message: /content hash/ },
    { manifest: emptyTracks, id: emptyTracks.id, message: /zero-track manifest/ },
    {
      manifest: { ...base, id: "manifest-missing-catalog", tracks: missingCatalogTracks, contentHash: manifestContentHash(missingCatalogTracks) },
      id: "manifest-missing-catalog",
      message: /without an Apple catalog ID/,
    },
  ];

  for (const invalid of cases) {
    const harness = durablePublicationHarness({ manifest: invalid.manifest });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(publishManifest(harness.repository, invalid.id)).rejects.toThrow(invalid.message);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.repository.createPublicationVolume).not.toHaveBeenCalled();
  }
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
