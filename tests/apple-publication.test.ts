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
  catalogRecordingKeysEquivalent,
  createDeveloperToken,
  encryptMusicUserToken,
  libraryPlaylistIsPublic,
  processAppleAuthorizationJob,
  recoverUnverifiedAppleAuthorizationJob,
  recoverWaitingApplePublicationJobs,
  searchAppleCatalog,
  type AppleAuthorizationJobRepository,
  type ApplePublicationRecoveryRepository,
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
  assertManifestPublicationAuthorized,
  manifestContentHash,
  PartialPublicationDecisionRequiredError,
  planPublicationVolumes,
  publicationPartialOutcomeStatus,
  publishManifest,
  type LockedManifest,
  type PublicationAppleClient,
  type PublicationRepository,
  type PublicationVolume,
  type PublicationVolumeProgress,
} from "../server/publisher.ts";
import type {
  AdvancePublicationReconciliationInput,
  BeginPublicationReconciliationInput,
  DurablePublicationReconciliation,
} from "../server/publication-reconciliation-persistence.ts";
import {
  CANONICAL_PUBLICATION_REVALIDATION_ERROR,
  CanonicalPublicationRevalidationRequiredErrorV1,
} from "../server/canonical-publication-revalidation-v1.ts";

function richRecordingKey(input: {
  isrc: string;
  artist?: string;
  title?: string;
  durationMs?: number;
  versionSignature?: string;
}): string {
  return `recording-json:${JSON.stringify({
    version: 1,
    isrc: input.isrc,
    artist: input.artist ?? "phuture",
    title: input.title ?? "acid tracks",
    durationMs: input.durationMs ?? 737_173,
    versionSignature: input.versionSignature ?? "canonical:unrated",
  })}`;
}

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

test("recording-key metadata fallback stays inside exact title, artist, duration, and version boundaries", () => {
  const expected = richRecordingKey({ isrc: "GBBLG0100348" });
  expect(catalogRecordingKeysEquivalent(
    expected,
    richRecordingKey({ isrc: "QMFMF1498221", durationMs: 739_627 }),
  )).toBe(true);
  expect(catalogRecordingKeysEquivalent(
    expected,
    richRecordingKey({ isrc: "QMFMF1498221", artist: "Another Artist" }),
  )).toBe(false);
  expect(catalogRecordingKeysEquivalent(
    expected,
    richRecordingKey({ isrc: "QMFMF1498221", title: "Another Track" }),
  )).toBe(false);
  expect(catalogRecordingKeysEquivalent(
    expected,
    richRecordingKey({ isrc: "QMFMF1498221", durationMs: 747_174 }),
  )).toBe(false);
  expect(catalogRecordingKeysEquivalent(
    expected,
    richRecordingKey({ isrc: "QMFMF1498221", versionSignature: "live:unrated" }),
  )).toBe(false);
});

test("Apple catalog parsing preserves supported clean and explicit ratings", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    results: {
      songs: {
        data: [
          { id: "clean-song", attributes: { name: "Clean Song", artistName: "Artist", albumName: "Album", contentRating: "clean" } },
          { id: "explicit-song", attributes: { name: "Explicit Song", artistName: "Artist", albumName: "Album", contentRating: "explicit" } },
          { id: "unknown-song", attributes: { name: "Unknown Song", artistName: "Artist", albumName: "Album", contentRating: "mystery" } },
        ],
      },
    },
  }), { status: 200 })));

  await expect(searchAppleCatalog("us", "rating test")).resolves.toEqual([
    expect.objectContaining({ id: "clean-song", contentRating: "clean" }),
    expect.objectContaining({ id: "explicit-song", contentRating: "explicit" }),
    expect.not.objectContaining({ contentRating: expect.anything() }),
  ]);
});

describe("Apple Music client failure classification", () => {
  test("browser developer tokens bind the allowed origin as an array", async () => {
    const token = await createDeveloperToken({
      origin: "https://needle.example/owner?from=test",
      ttlSeconds: 60,
    });
    const payload = token.split(".")[1];
    expect(payload).toBeTruthy();
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;

    expect(claims.origin).toEqual(["https://needle.example"]);
  });

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

  test("playlist creation does not persist a returned URL while Apple still reports the playlist private", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{
        id: "p.not-public-yet",
        type: "library-playlists",
        attributes: {
          isPublic: false,
          url: "https://music.apple.com/us/playlist/not-public-yet/pl.u-not-public-yet",
        },
      }],
    }), { status: 201 })));

    await expect(new AppleMusicClient("private-user-token", "us").createLibraryPlaylist("Needle", "Pending"))
      .resolves.toEqual({ id: "p.not-public-yet", url: null });
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
            attributes: { isPublic: true, playParams: { globalId: "pl.u-public" } },
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
        return new Response(JSON.stringify({
          data: [{ id: "p.relationship", type: "library-playlists", attributes: { isPublic: true } }],
        }), { status: 200 });
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

  test("a private library playlist never becomes a visitor share link merely because it has a global catalog ID", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/v1/me/library/playlists/p.private?include=catalog")) {
        return new Response(JSON.stringify({
          data: [{
            id: "p.private",
            type: "library-playlists",
            attributes: {
              isPublic: false,
              url: "https://music.apple.com/us/playlist/private/pl.u-private",
              playParams: { globalId: "pl.u-private" },
            },
          }],
        }), { status: 200 });
      }
      throw new Error(`Private playlist resolution must stop at the library resource: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AppleMusicClient("private-user-token", "us").resolveLibraryPlaylistShareUrl("p.private"))
      .resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(libraryPlaylistIsPublic({ type: "library-playlists", attributes: { isPublic: true } })).toBe(true);
    expect(libraryPlaylistIsPublic({ type: "library-playlists", attributes: { isPublic: false } })).toBe(false);
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

  test("an empty tracks-relationship 404 is empty only while the parent playlist still exists", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/v1/me/library/playlists/p.propagating/tracks?")) {
        return new Response(JSON.stringify({ errors: [{ title: "Relationship not ready" }] }), { status: 404 });
      }
      if (url.includes("/v1/me/library/playlists/p.propagating?include=catalog")) {
        return new Response(JSON.stringify({
          data: [{ id: "p.propagating", type: "library-playlists", attributes: { isPublic: true } }],
        }), { status: 200 });
      }
      throw new Error(`Unexpected Apple propagation-test URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AppleMusicClient("private-user-token").getOrderedPlaylistCatalogIds("p.propagating"))
      .resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset().mockImplementation(async () => new Response(JSON.stringify({
      errors: [{ title: "Not found" }],
    }), { status: 404 }));
    await expect(new AppleMusicClient("private-user-token").getOrderedPlaylistCatalogIds("p.missing"))
      .rejects.toMatchObject({ name: "AppleApiError", status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
      .rejects.toMatchObject({
        name: "AppleApiError",
        status: 503,
        retriable: true,
        retryAfterMs: 1,
      });
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
    maxAttempts: 6,
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
  repository.updateAppleAuthorizationValidation.mockResolvedValue(true);
  await processAppleAuthorizationJob(repository, { authorizationGeneration: "stale-generation" });
  expect(repository.updateAppleAuthorizationValidation).toHaveBeenCalledTimes(1);
});

test("waiting publication recovery is independent, generation-scoped, and requires valid Apple authorization", async () => {
  const authorization: AppleAuthorizationRecord = {
    ...validAuthorization,
    status: "valid",
  };
  const repository = {
    getAppleAuthorization: vi.fn(async () => authorization),
    listWaitingPublicationManifests: vi.fn(async () => [{ manifestId: "manifest-waiting", runId: "run-waiting" }]),
    enqueueWaitingPublicationRecovery: vi.fn(async () => true),
  };

  await expect(recoverWaitingApplePublicationJobs(repository)).resolves.toBe(1);
  expect(repository.enqueueWaitingPublicationRecovery).toHaveBeenCalledWith({
    runId: "run-waiting",
    manifestId: "manifest-waiting",
    dedupeKey: `publication:manifest-waiting:reauth:${appleAuthorizationGeneration(authorization)}:legacy`,
  });

  repository.getAppleAuthorization.mockResolvedValue({ ...authorization, status: "validation_failed" });
  await expect(recoverWaitingApplePublicationJobs(repository)).resolves.toBe(0);
  expect(repository.enqueueWaitingPublicationRecovery).toHaveBeenCalledTimes(1);
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
    get(target, property) {
      if (Reflect.has(target, property)) return Reflect.get(target, property);
      if (!methods.has(property)) methods.set(property, vi.fn(async () => undefined));
      return methods.get(property);
    },
  });
}

function publicationRepository(): PublicationRepository & Record<string, ReturnType<typeof vi.fn>> {
  const repository = methodProxy();
  // The default harness represents a schema-13 repository. Individual V3
  // cases opt into the schema-14 publication guard explicitly.
  repository.getPublicationGuard = undefined;
  repository.commitPublicationCompletion = undefined;
  repository.acquireAppleWritePermit.mockImplementation(async () => ({ release: vi.fn(async () => undefined) }));
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
  // The default harness represents a schema-13 repository. Individual V3
  // cases opt into the schema-14 publication guard explicitly.
  repository.getPublicationGuard = undefined;
  repository.commitPublicationCompletion = undefined;
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
      lastValidatedAt: update.status === "valid" ? new Date() : authorization.lastValidatedAt,
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
    if (existing) {
      const sameRevision = (existing.manifestRevisionId ?? null) === (stored.manifestRevisionId ?? null);
      const sameRange = existing.volumeCount === stored.volumeCount
        && existing.startPosition === stored.startPosition
        && existing.endPosition === stored.endPosition;
      if (!sameRevision || !sameRange) {
        throw Object.assign(new Error("publication_revision_conflict"), { code: "publication_revision_conflict" });
      }
      return existing;
    }
    volumes.push(stored);
    return stored;
  });
  repository.listPublicationVolumes.mockImplementation(async (_manifestId: string, revisionId?: string | null) => volumes
    .filter((volume) => revisionId === undefined || (volume.manifestRevisionId ?? null) === revisionId)
    .map((volume) => ({ ...volume })));
  repository.retirePublicationVolume.mockImplementation(async (input: {
    manifestId: string;
    publicationVolumeId: string;
    applePlaylistId?: string | null;
  }) => {
    const index = volumes.findIndex((volume) => volume.id === input.publicationVolumeId && volume.manifestId === input.manifestId);
    if (index < 0) return null;
    const [retired] = volumes.splice(index, 1);
    return (input.applePlaylistId ?? retired?.applePlaylistId) ? `orphan-${input.publicationVolumeId}` : null;
  });
  repository.hidePublicPlaylistsForRun.mockResolvedValue(1);
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
  repository.listWaitingPublicationManifests.mockImplementation(async () => (
    run?.status === "waiting_for_apple_authorization" && activeManifest
      ? [{ manifestId: activeManifest.id, runId: activeManifest.runId }]
      : []
  ));
  repository.enqueueWaitingPublicationRecovery.mockResolvedValue(true);
  repository.enqueueJob.mockResolvedValue({ created: true });

  return {
    repository: repository as PublicationRepository & AppleAuthorizationJobRepository & ApplePublicationRecoveryRepository & Record<string, ReturnType<typeof vi.fn>>,
    volumes,
    get authorization() { return authorization; },
    setAuthorization(next: AppleAuthorizationRecord | null) { authorization = next; },
    get run() { return run; },
  };
}

test("publisher recovers an uncertain playlist creation by its private marker", async () => {
  const repository = publicationRepository();
  const acquireAppleWritePermit = repository.acquireAppleWritePermit as ReturnType<typeof vi.fn>;
  const releases: Array<ReturnType<typeof vi.fn>> = [];
  acquireAppleWritePermit.mockImplementation(async () => {
    const release = vi.fn(async () => undefined);
    releases.push(release);
    return { release };
  });
  let currentMarkerLookups = 0;
  let state: string[] = [];
  const client: PublicationAppleClient = {
    findLibraryPlaylistByMarker: vi.fn(async (marker) => {
      if (!marker.startsWith("gênio publication ")) return null;
      currentMarkerLookups += 1;
      return currentMarkerLookups === 1 ? null : { id: "p.recovered" };
    }),
    createLibraryPlaylist: vi.fn(async () => {
      throw new AppleApiError("Unknown create result", 503, true, true);
    }),
    appendCatalogTracks: vi.fn(async (_playlistId, ids) => { state = [...state, ...ids]; }),
    getOrderedPlaylistCatalogIds: vi.fn(async () => [...state]),
    pollStableShareUrl: vi.fn(async () => "https://music.apple.com/us/playlist/recovered/pl.recovered"),
  };

  const recordProgress = vi.fn(async (
    progress: PublicationVolumeProgress,
  ) => {
    void progress;
  });
  const result = await appendExactVolume(
    repository,
    client,
    manifest,
    pendingVolume(),
    ["101"],
    validAuthorization,
    undefined,
    recordProgress,
  );
  expect(result).toMatchObject({ playlistId: "p.recovered", appendedCount: 1, status: "complete" });
  expect(client.createLibraryPlaylist).toHaveBeenCalledTimes(1);
  expect(client.appendCatalogTracks).toHaveBeenCalledWith("p.recovered", ["101"], undefined);
  expect(client.findLibraryPlaylistByMarker).toHaveBeenCalledWith(
    "gênio publication volume-id:0",
    undefined,
  );
  expect(acquireAppleWritePermit.mock.calls.map((call) => (call[0] as { operation: string }).operation))
    .toEqual(["create_playlist", "append_tracks"]);
  expect(releases).toHaveLength(2);
  expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  expect(recordProgress.mock.calls.map(([progress]) => progress.state))
    .toEqual(expect.arrayContaining(["append_pending", "reconciling"]));
  expect(recordProgress).toHaveBeenLastCalledWith(expect.objectContaining({
    state: "reconciling",
    applePlaylistId: "p.recovered",
    appendedCount: 1,
    observedOrderedIds: ["101"],
  }));
});

test("every retried append consumes a fresh permit and always releases the global write fence", async () => {
  const repository = publicationRepository();
  const acquireAppleWritePermit = repository.acquireAppleWritePermit as ReturnType<typeof vi.fn>;
  const releases: Array<ReturnType<typeof vi.fn>> = [];
  acquireAppleWritePermit.mockImplementation(async () => {
    const release = vi.fn(async () => undefined);
    releases.push(release);
    return { release };
  });
  let appendAttempts = 0;
  let state: string[] = [];
  const client: PublicationAppleClient = {
    findLibraryPlaylistByMarker: vi.fn(async () => null),
    createLibraryPlaylist: vi.fn(async () => ({ id: "p.unused", url: null })),
    appendCatalogTracks: vi.fn(async (_playlistId, ids) => {
      appendAttempts += 1;
      if (appendAttempts === 1) throw new AppleApiError("transient", 503, true, false);
      state = [...state, ...ids];
    }),
    getOrderedPlaylistCatalogIds: vi.fn(async () => [...state]),
    pollStableShareUrl: vi.fn(async () => "https://music.apple.com/us/playlist/gated/pl.gated"),
  };
  const existing = { ...pendingVolume(), playlistId: "p.gated", status: "appending" as const };

  await expect(appendExactVolume(repository, client, manifest, existing, ["101"], validAuthorization))
    .resolves.toMatchObject({ playlistId: "p.gated", appendedCount: 1, status: "complete" });

  expect(client.createLibraryPlaylist).not.toHaveBeenCalled();
  expect(client.appendCatalogTracks).toHaveBeenCalledTimes(2);
  expect(acquireAppleWritePermit).toHaveBeenCalledTimes(2);
  expect(acquireAppleWritePermit.mock.calls.every(
    (call) => (call[0] as { operation: string }).operation === "append_tracks",
  )).toBe(true);
  expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
});

test("V3 fails closed before an Apple mutation when the global write gateway is unavailable", async () => {
  const repository = publicationRepository();
  repository.acquireAppleWritePermit = undefined;
  const v3 = { ...manifest, pipelineVersion: "corpus_first_v3" as const };
  const client: PublicationAppleClient = {
    findLibraryPlaylistByMarker: vi.fn(async () => null),
    createLibraryPlaylist: vi.fn(async () => ({ id: "p.unsafe", url: null })),
    appendCatalogTracks: vi.fn(async () => undefined),
    getOrderedPlaylistCatalogIds: vi.fn(async () => []),
    pollStableShareUrl: vi.fn(async () => "https://music.apple.com/us/playlist/unsafe/pl.unsafe"),
  };

  await expect(appendExactVolume(repository, client, v3, pendingVolume(), ["101"], validAuthorization))
    .rejects.toThrow(/V3 Apple write gateway is unavailable/u);
  expect(client.createLibraryPlaylist).not.toHaveBeenCalled();
  expect(client.appendCatalogTracks).not.toHaveBeenCalled();
});

test("publisher recovers a playlist created under the previous 9ênio marker", async () => {
  const repository = publicationRepository();
  let state: string[] = [];
  const client: PublicationAppleClient = {
    findLibraryPlaylistByMarker: vi.fn(async (marker) => (
      marker.startsWith("9ênio publication ") ? { id: "p.previous" } : null
    )),
    createLibraryPlaylist: vi.fn(async () => ({ id: "p.unexpected", url: null })),
    appendCatalogTracks: vi.fn(async (_playlistId, ids) => { state = [...state, ...ids]; }),
    getOrderedPlaylistCatalogIds: vi.fn(async () => [...state]),
    pollStableShareUrl: vi.fn(async () => "https://music.apple.com/us/playlist/previous/pl.previous"),
  };

  const result = await appendExactVolume(repository, client, manifest, pendingVolume(), ["101"], validAuthorization);
  expect(result).toMatchObject({ playlistId: "p.previous", appendedCount: 1, status: "complete" });
  expect(client.createLibraryPlaylist).not.toHaveBeenCalled();
  expect(client.findLibraryPlaylistByMarker).toHaveBeenCalledWith(
    "9ênio publication volume-id:0",
    undefined,
  );
});

test("publisher recovers a pre-gênio playlist by its legacy Needle marker", async () => {
  const repository = publicationRepository();
  let state: string[] = [];
  const client: PublicationAppleClient = {
    findLibraryPlaylistByMarker: vi.fn(async (marker) => (
      marker.startsWith("Needle publication ") ? { id: "p.legacy" } : null
    )),
    createLibraryPlaylist: vi.fn(async () => ({ id: "p.unexpected", url: null })),
    appendCatalogTracks: vi.fn(async (_playlistId, ids) => { state = [...state, ...ids]; }),
    getOrderedPlaylistCatalogIds: vi.fn(async () => [...state]),
    pollStableShareUrl: vi.fn(async () => "https://music.apple.com/us/playlist/legacy/pl.legacy"),
  };

  const result = await appendExactVolume(repository, client, manifest, pendingVolume(), ["101"], validAuthorization);
  expect(result).toMatchObject({ playlistId: "p.legacy", appendedCount: 1, status: "complete" });
  expect(client.createLibraryPlaylist).not.toHaveBeenCalled();
  expect(client.findLibraryPlaylistByMarker).toHaveBeenCalledWith(
    "Needle publication volume-id:0",
    undefined,
  );
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
  expect(repository.markPlaylistOrphan).toHaveBeenCalledWith(expect.objectContaining({
    applePlaylistId: "p.diverged",
    reason: "Apple playlist catalog mismatch at position 1: expected 101, observed wrong-track (observed 1 tracks)",
  }));
  expect(repository.updatePublicationVolume).toHaveBeenCalledWith("volume-id", expect.objectContaining({
    attemptDelta: 1,
    applePlaylistId: null,
    appendedCount: 0,
  }));
  expect(result).toMatchObject({ playlistId: "p.replacement", appendedCount: 2, status: "complete" });
  expect(states.get("p.replacement")).toEqual(["101", "202"]);
});

test("publisher ignores a transient non-prefix read that converges to a stable valid prefix", async () => {
  const repository = publicationRepository();
  let readCount = 0;
  let state: string[] = [];
  const client: PublicationAppleClient = {
    findLibraryPlaylistByMarker: vi.fn(async () => null),
    createLibraryPlaylist: vi.fn(async () => ({ id: "p.transient-read", url: null })),
    appendCatalogTracks: vi.fn(async (_playlistId, ids) => { state = [...state, ...ids]; }),
    getOrderedPlaylistCatalogIds: vi.fn(async () => {
      readCount += 1;
      if (readCount === 1) return ["transient-wrong-track"];
      return [...state];
    }),
    pollStableShareUrl: vi.fn(async () => "https://music.apple.com/us/playlist/transient/pl.transient"),
  };

  const result = await appendExactVolume(repository, client, manifest, pendingVolume(), ["101", "202"], validAuthorization);

  expect(result).toMatchObject({ playlistId: "p.transient-read", appendedCount: 2, status: "complete" });
  expect(repository.markPlaylistOrphan).not.toHaveBeenCalled();
  expect(client.createLibraryPlaylist).toHaveBeenCalledTimes(1);
  expect(client.getOrderedPlaylistCatalogIds).toHaveBeenCalledTimes(5);
});

test("publisher declares divergence only after three identical non-prefix reads", async () => {
  const repository = publicationRepository();
  const client: PublicationAppleClient = {
    findLibraryPlaylistByMarker: vi.fn(async () => null),
    createLibraryPlaylist: vi.fn(async () => ({ id: "p.unused", url: null })),
    appendCatalogTracks: vi.fn(async () => undefined),
    getOrderedPlaylistCatalogIds: vi.fn(async () => ["persistent-wrong-track"]),
    pollStableShareUrl: vi.fn(async () => "https://music.apple.com/us/playlist/unused/pl.unused"),
  };
  const exhausted = {
    ...pendingVolume(),
    attempt: 3,
    playlistId: "p.persistent-divergence",
    status: "appending" as const,
  };

  await expect(appendExactVolume(repository, client, manifest, exhausted, ["101"], validAuthorization))
    .rejects.toThrow(/diverged too many times/);

  expect(client.getOrderedPlaylistCatalogIds).toHaveBeenCalledTimes(3);
  expect(repository.markPlaylistOrphan).toHaveBeenCalledTimes(1);
  expect(client.createLibraryPlaylist).not.toHaveBeenCalled();
});

test("publisher does not resend an acknowledged batch while Apple visibility lags across a retry", async () => {
  const repository = publicationRepository();
  const expected = Array.from({ length: 30 }, (_, index) => String(10_000 + index));
  const volume = {
    ...pendingVolume(),
    playlistId: "p.delayed-visibility",
    status: "appending" as const,
  };
  let accepted: string[] = [];
  let exposeAccepted = false;
  const client: PublicationAppleClient = {
    findLibraryPlaylistByMarker: vi.fn(async () => null),
    createLibraryPlaylist: vi.fn(async () => ({ id: "p.delayed-visibility", url: null })),
    appendCatalogTracks: vi.fn(async (_playlistId, ids) => { accepted = [...accepted, ...ids]; }),
    getOrderedPlaylistCatalogIds: vi.fn(async () => exposeAccepted ? [...accepted] : []),
    pollStableShareUrl: vi.fn(async () => "https://music.apple.com/us/playlist/delayed/pl.delayed"),
  };

  await expect(appendExactVolume(repository, client, manifest, volume, expected, validAuthorization))
    .rejects.toMatchObject({ name: "AppleApiError", retriable: true });

  expect(client.appendCatalogTracks).toHaveBeenCalledTimes(1);
  expect(client.appendCatalogTracks).toHaveBeenLastCalledWith(
    "p.delayed-visibility",
    expected.slice(0, 25),
    undefined,
  );
  expect(repository.updatePublicationVolume).toHaveBeenCalledWith("volume-id", {
    appendedCount: 25,
    status: "appending",
  });

  exposeAccepted = true;
  const resumed = await appendExactVolume(
    repository,
    client,
    manifest,
    { ...volume, appendedCount: 25 },
    expected,
    validAuthorization,
  );

  expect(resumed).toMatchObject({ playlistId: "p.delayed-visibility", appendedCount: 30, status: "complete" });
  expect(client.appendCatalogTracks).toHaveBeenCalledTimes(2);
  expect(client.appendCatalogTracks).toHaveBeenLastCalledWith(
    "p.delayed-visibility",
    expected.slice(25),
    undefined,
  );
  const updatePublicationVolumeMock = repository.updatePublicationVolume as unknown as ReturnType<typeof vi.fn>;
  const persistedCounts = updatePublicationVolumeMock.mock.calls
    .map((call) => (call[1] as { appendedCount?: unknown }).appendedCount)
    .filter((count): count is number => typeof count === "number");
  expect(persistedCounts).toEqual([25, 30, 30]);
});

test("publisher replaces an indeterminate playlist instead of resending an uncertain batch onto it", async () => {
  const repository = publicationRepository();
  const expected = Array.from({ length: 30 }, (_, index) => String(15_000 + index));
  const original = {
    ...pendingVolume(),
    playlistId: "p.uncertain-append",
    status: "appending" as const,
  };
  let replacementState: string[] = [];
  const client: PublicationAppleClient = {
    findLibraryPlaylistByMarker: vi.fn(async () => null),
    createLibraryPlaylist: vi.fn(async () => ({ id: "p.clean-replacement", url: null })),
    appendCatalogTracks: vi.fn(async (playlistId, ids) => {
      if (playlistId === "p.uncertain-append") {
        throw new AppleApiError("Connection closed before the append response", null, true, true);
      }
      replacementState = [...replacementState, ...ids];
    }),
    getOrderedPlaylistCatalogIds: vi.fn(async (playlistId) => (
      playlistId === "p.clean-replacement" ? [...replacementState] : []
    )),
    pollStableShareUrl: vi.fn(async () => "https://music.apple.com/us/playlist/replacement/pl.clean"),
  };

  const result = await appendExactVolume(repository, client, manifest, original, expected, validAuthorization);

  expect(result).toMatchObject({ playlistId: "p.clean-replacement", appendedCount: 30, status: "complete" });
  expect(repository.markPlaylistOrphan).toHaveBeenCalledTimes(1);
  expect(repository.markPlaylistOrphan).toHaveBeenCalledWith({
    manifestId: manifest.id,
    publicationVolumeId: "volume-id",
    applePlaylistId: "p.uncertain-append",
    reason: "Apple append outcome remained uncertain after bounded reconciliation",
  });
  expect(client.createLibraryPlaylist).toHaveBeenCalledTimes(1);
  expect(client.appendCatalogTracks).toHaveBeenCalledTimes(3);
  expect(client.appendCatalogTracks).toHaveBeenNthCalledWith(
    1,
    "p.uncertain-append",
    expected.slice(0, 25),
    undefined,
  );
  expect(client.appendCatalogTracks).toHaveBeenNthCalledWith(
    2,
    "p.clean-replacement",
    expected.slice(0, 25),
    undefined,
  );
  expect(client.appendCatalogTracks).toHaveBeenNthCalledWith(
    3,
    "p.clean-replacement",
    expected.slice(25),
    undefined,
  );
  expect(replacementState).toEqual(expected);
});

test("publisher waits for each submitted prefix to become visible before serially appending the next batch", async () => {
  const repository = publicationRepository();
  const expected = Array.from({ length: 60 }, (_, index) => String(20_000 + index));
  let accepted: string[] = [];
  let visible: string[] = [];
  let staleReadsRemaining = 0;
  let concurrentAppends = 0;
  let maximumConcurrentAppends = 0;
  const events: string[] = [];
  const client: PublicationAppleClient = {
    findLibraryPlaylistByMarker: vi.fn(async () => null),
    createLibraryPlaylist: vi.fn(async () => ({ id: "p.serial-batches", url: null })),
    appendCatalogTracks: vi.fn(async (_playlistId, ids) => {
      events.push(`append:${accepted.length}`);
      concurrentAppends += 1;
      maximumConcurrentAppends = Math.max(maximumConcurrentAppends, concurrentAppends);
      await Promise.resolve();
      accepted = [...accepted, ...ids];
      staleReadsRemaining = 1;
      concurrentAppends -= 1;
    }),
    getOrderedPlaylistCatalogIds: vi.fn(async () => {
      if (accepted.length > visible.length) {
        if (staleReadsRemaining > 0) staleReadsRemaining -= 1;
        else visible = [...accepted];
      }
      events.push(`visible:${visible.length}`);
      return [...visible];
    }),
    pollStableShareUrl: vi.fn(async () => "https://music.apple.com/us/playlist/serial/pl.serial"),
  };

  const result = await appendExactVolume(repository, client, manifest, pendingVolume(), expected, validAuthorization);

  expect(result).toMatchObject({ playlistId: "p.serial-batches", appendedCount: 60, status: "complete" });
  expect(maximumConcurrentAppends).toBe(1);
  expect(client.appendCatalogTracks).toHaveBeenCalledTimes(3);
  expect(client.appendCatalogTracks).toHaveBeenNthCalledWith(1, "p.serial-batches", expected.slice(0, 25), undefined);
  expect(client.appendCatalogTracks).toHaveBeenNthCalledWith(2, "p.serial-batches", expected.slice(25, 50), undefined);
  expect(client.appendCatalogTracks).toHaveBeenNthCalledWith(3, "p.serial-batches", expected.slice(50), undefined);
  expect(events.indexOf("visible:25")).toBeLessThan(events.indexOf("append:25"));
  expect(events.indexOf("visible:50")).toBeLessThan(events.indexOf("append:50"));
  expect(accepted).toEqual(expected);
  expect(visible).toEqual(expected);
});

test("publisher replaces a stored Apple playlist ID that remains unavailable after bounded propagation reads", async () => {
  const repository = publicationRepository();
  const state: string[] = [];
  const client: PublicationAppleClient = {
    findLibraryPlaylistByMarker: vi.fn(async () => null),
    createLibraryPlaylist: vi.fn(async () => ({ id: "p.replacement", url: null })),
    appendCatalogTracks: vi.fn(async (_playlistId, ids) => { state.push(...ids); }),
    getOrderedPlaylistCatalogIds: vi.fn(async (playlistId) => {
      if (playlistId === "p.missing") throw new AppleApiError("private missing resource detail", 404, false);
      return [...state];
    }),
    pollStableShareUrl: vi.fn(async () => "https://music.apple.com/us/playlist/replacement/pl.replacement"),
  };
  const unavailable = { ...pendingVolume(), playlistId: "p.missing", status: "appending" as const };

  const result = await appendExactVolume(repository, client, manifest, unavailable, ["101", "202"], validAuthorization);
  expect(repository.markPlaylistOrphan).toHaveBeenCalledWith(expect.objectContaining({
    applePlaylistId: "p.missing",
    reason: "Apple no longer returned the stored library playlist resource",
  }));
  expect(repository.updatePublicationVolume).toHaveBeenCalledWith("volume-id", expect.objectContaining({
    attemptDelta: 1,
    applePlaylistId: null,
    status: "queued",
  }));
  expect(result).toMatchObject({ playlistId: "p.replacement", appendedCount: 2, status: "complete" });
});

test("publisher accepts Apple catalog-ID normalization only when ordered ISRC identities remain equal", async () => {
  const repository = publicationRepository();
  const aliases: Record<string, string> = { "101": "901", "202": "902" };
  const recordingKeys: Record<string, string> = {
    "101": "isrc:USAAA0000001",
    "901": "isrc:USAAA0000001",
    "202": "isrc:USAAA0000002",
    "902": "isrc:USAAA0000002",
  };
  const state: string[] = [];
  const client: PublicationAppleClient = {
    findLibraryPlaylistByMarker: vi.fn(async () => null),
    createLibraryPlaylist: vi.fn(async () => ({ id: "p.normalized", url: null })),
    appendCatalogTracks: vi.fn(async (_playlistId: string, ids: readonly string[]) => { state.push(...ids.map((id) => aliases[id] ?? id)); }),
    getOrderedPlaylistCatalogIds: vi.fn(async () => [...state]),
    getCatalogRecordingKeys: vi.fn(async (ids: readonly string[]) => Object.fromEntries(
      ids.filter((id) => recordingKeys[id]).map((id) => [id, recordingKeys[id]!]),
    )),
    pollStableShareUrl: vi.fn(async () => "https://music.apple.com/us/playlist/normalized/pl.normalized"),
  };

  const result = await appendExactVolume(repository, client, manifest, pendingVolume(), ["101", "202"], validAuthorization);
  expect(result).toMatchObject({ playlistId: "p.normalized", appendedCount: 2, status: "complete" });
  expect(repository.markPlaylistOrphan).not.toHaveBeenCalled();
  expect(client.getCatalogRecordingKeys).toHaveBeenCalled();
});

test("publisher accepts Apple's storefront alias when exact metadata and compatible duration prove the recording family", async () => {
  const repository = publicationRepository();
  const aliases: Record<string, string> = { "1601915460": "885922991" };
  const recordingKeys: Record<string, string> = {
    "1601915460": 'recording-json:{"version":1,"isrc":"GBBLG0100348","artist":"phuture","title":"acid tracks","durationMs":737173,"versionSignature":"canonical:unrated"}',
    "885922991": 'recording-json:{"version":1,"isrc":"QMFMF1498221","artist":"phuture","title":"acid tracks","durationMs":739627,"versionSignature":"canonical:unrated"}',
  };
  const state: string[] = [];
  const client: PublicationAppleClient = {
    findLibraryPlaylistByMarker: vi.fn(async () => null),
    createLibraryPlaylist: vi.fn(async () => ({ id: "p.storefront-alias", url: null })),
    appendCatalogTracks: vi.fn(async (_playlistId: string, ids: readonly string[]) => {
      state.push(...ids.map((id) => aliases[id] ?? id));
    }),
    getOrderedPlaylistCatalogIds: vi.fn(async () => [...state]),
    getCatalogRecordingKeys: vi.fn(async (ids: readonly string[]) => Object.fromEntries(
      ids.filter((id) => recordingKeys[id]).map((id) => [id, recordingKeys[id]!]),
    )),
    pollStableShareUrl: vi.fn(async () => "https://music.apple.com/us/playlist/storefront-alias/pl.storefront-alias"),
  };

  const result = await appendExactVolume(
    repository,
    client,
    manifest,
    pendingVolume(),
    ["1601915460"],
    validAuthorization,
  );

  expect(result).toMatchObject({ playlistId: "p.storefront-alias", appendedCount: 1, status: "complete" });
  expect(repository.markPlaylistOrphan).not.toHaveBeenCalled();
});

test("publisher rejects a catalog alias when Apple reports a conflicting version", async () => {
  const repository = publicationRepository();
  const recordingKeys: Record<string, string> = {
    "101": 'recording-json:{"version":1,"isrc":"USAAA0000001","artist":"artist","title":"song","durationMs":240000,"versionSignature":"canonical:unrated"}',
    "901": 'recording-json:{"version":1,"isrc":"USBBB0000002","artist":"artist","title":"song","durationMs":240000,"versionSignature":"live:unrated"}',
  };
  const client: PublicationAppleClient = {
    findLibraryPlaylistByMarker: vi.fn(async () => null),
    createLibraryPlaylist: vi.fn(async () => ({ id: "p.conflicting-alias", url: null })),
    appendCatalogTracks: vi.fn(async () => undefined),
    getOrderedPlaylistCatalogIds: vi.fn(async () => ["901"]),
    getCatalogRecordingKeys: vi.fn(async (ids: readonly string[]) => Object.fromEntries(
      ids.filter((id) => recordingKeys[id]).map((id) => [id, recordingKeys[id]!]),
    )),
    pollStableShareUrl: vi.fn(async () => "https://music.apple.com/us/playlist/unexpected/pl.unexpected"),
  };
  const exhausted = {
    ...pendingVolume(),
    attempt: 3,
    playlistId: "p.conflicting-alias",
    status: "appending" as const,
  };

  await expect(appendExactVolume(repository, client, manifest, exhausted, ["101"], validAuthorization))
    .rejects.toThrow(/diverged too many times/);
  expect(repository.markPlaylistOrphan).toHaveBeenCalledTimes(1);
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
  const productionManifest: LockedManifest = {
    ...lockedManifest(3, "manifest-happy-path"),
    revisionId: "55555555-5555-4555-8555-555555555555",
    revision: 1,
    contractRevisionId: "66666666-6666-4666-8666-666666666666",
    contractHash: "b".repeat(64),
  };
  const harness = durablePublicationHarness({ manifest: productionManifest });
  const beginReconciliation = vi.fn(async (
    input: BeginPublicationReconciliationInput,
  ): Promise<DurablePublicationReconciliation> => {
    void input;
    return {
      id: "77777777-7777-4777-8777-777777777777",
      state: "preflight",
      appendedCount: 0,
      batchCursor: 0,
    };
  });
  const advanceReconciliation = vi.fn(async (
    input: AdvancePublicationReconciliationInput,
  ): Promise<DurablePublicationReconciliation> => ({
    id: "77777777-7777-4777-8777-777777777777",
    state: input.state,
    appendedCount: input.appendedCount,
    batchCursor: input.batchCursor,
  }));
  harness.repository.beginPublicationReconciliation = beginReconciliation;
  harness.repository.advancePublicationReconciliation = advanceReconciliation;
  harness.repository.commitPublicationCompletion = vi.fn(async (input) => {
    await harness.repository.updateRun(input.runId, {
      status: input.terminalStatus,
      phase: input.terminalStatus === "partial" ? "published_partial" : "published",
      error: null,
    });
  });
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
        data: [{ id: "p.production", type: "library-playlists", attributes: { isPublic: true, url: shareUrl } }],
      }), { status: 200 });
    }
    throw new Error(`Unexpected Apple test request: ${method} ${url.pathname}${url.search}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(publishManifest(
    harness.repository,
    productionManifest.id,
    undefined,
    {
      executionAttemptId: "88888888-8888-4888-8888-888888888888",
      jobId: "99999999-9999-4999-8999-999999999999",
      workerId: "publisher-test-worker",
      leaseGeneration: 1,
      stageKey: "publication",
    },
  )).resolves.toEqual({
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
  expect(harness.repository.commitPublicationCompletion).toHaveBeenCalledWith(expect.objectContaining({
    runId: productionManifest.runId,
    manifestId: productionManifest.id,
    manifestRevisionId: productionManifest.revisionId,
    manifestRevisionHash: productionManifest.contentHash,
    contractRevisionId: productionManifest.contractRevisionId,
    contractHash: productionManifest.contractHash,
    selectedCount: 3,
    terminalStatus: "complete",
    publicationVolumes: [{
      publicationVolumeId: "volume-1",
      attempt: 0,
      applePlaylistId: "p.production",
      appendedCount: 3,
      startPosition: 0,
      endPosition: 2,
    }],
  }));
  expect(beginReconciliation)
    .toHaveBeenCalledWith(expect.objectContaining({
      runId: productionManifest.runId,
      contractRevisionId: productionManifest.contractRevisionId,
      contractHash: productionManifest.contractHash,
      manifestId: productionManifest.id,
      manifestRevisionId: productionManifest.revisionId,
      manifestRevisionHash: productionManifest.contentHash,
      expectedCount: 3,
    }));
  expect(advanceReconciliation.mock.calls
    .map(([input]) => input.state))
    .toEqual(expect.arrayContaining([
      "create_pending",
      "append_pending",
      "reconciling",
      "complete",
    ]));
});

test("a safe non-empty manifest publishes as partial instead of failing on a count shortfall", async () => {
  const productionManifest: LockedManifest = {
    ...lockedManifest(1, "manifest-safe-partial"),
    selectionPlan: { requestedTrackCount: 50 } as LockedManifest["selectionPlan"],
  };
  const harness = durablePublicationHarness({ manifest: productionManifest });
  vi.mocked(harness.repository.getPublicationCompleteness).mockResolvedValue({ omittedCandidateCount: 24, unresolvedCoverageCount: 0 });
  const playlistState: string[] = [];
  const shareUrl = "https://music.apple.com/us/playlist/safe-partial/pl.safe-partial";
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/v1/me/library/playlists" && method === "GET") return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (url.pathname === "/v1/me/library/playlists" && method === "POST") {
      return new Response(JSON.stringify({ data: [{ id: "p.safe-partial" }] }), { status: 201 });
    }
    if (url.pathname === "/v1/me/library/playlists/p.safe-partial/tracks" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { data: Array<{ id: string }> };
      playlistState.push(...body.data.map((item) => item.id));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/v1/me/library/playlists/p.safe-partial/tracks" && method === "GET") {
      return new Response(JSON.stringify({ data: playlistState.map((id) => ({ attributes: { playParams: { catalogId: id } } })) }), { status: 200 });
    }
    if (url.pathname === "/v1/me/library/playlists/p.safe-partial" && method === "GET") {
      return new Response(JSON.stringify({ data: [{
        id: "p.safe-partial",
        type: "library-playlists",
        attributes: { isPublic: true, url: shareUrl },
      }] }), { status: 200 });
    }
    throw new Error(`Unexpected safe-partial Apple request: ${method} ${url.pathname}${url.search}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(publishManifest(harness.repository, productionManifest.id)).resolves.toEqual({
    status: "partial",
    manifestId: productionManifest.id,
    volumes: [{ index: 0, playlistId: "p.safe-partial", shareUrl, trackCount: 1 }],
  });
  expect(harness.run).toMatchObject({ status: "partial", phase: "published_partial", error: null });
  expect(harness.repository.savePipelineOutcome).toHaveBeenCalledWith(
    productionManifest.runId,
    expect.objectContaining({
      status: "partial_evidence_shortfall",
      targetTrackCount: 50,
      discoveredTrackCount: 25,
      publishedTrackCount: 1,
    }),
  );
});

function v3Manifest(trackCount: number, targetCount: number, id: string): LockedManifest {
  return {
    ...lockedManifest(trackCount, id),
    pipelineVersion: "corpus_first_v3",
    policyVersion: "corpus_first_v3_policy_v1",
    revisionId: `${id}-revision-1`,
    revision: 1,
    selectionPlan: { requestedTrackCount: targetCount } as LockedManifest["selectionPlan"],
  };
}

function acceptedGuard(manifest: LockedManifest, targetCount: number) {
  const outcomeHash = "a".repeat(64);
  return {
    requestedTrackCount: targetCount,
    enforcement: "required" as const,
    currentOutcomeHash: outcomeHash,
    decision: {
      decision: "accepted" as const,
      manifestRevisionId: manifest.revisionId!,
      manifestRevisionHash: manifest.contentHash,
      targetCount,
      selectedCount: manifest.tracks.length,
      outcomeHash,
      expiresAt: new Date(Date.now() + 60_000),
    },
  };
}

test("V3 exact manifests require the schema-14 guard but do not require partial consent", async () => {
  const productionManifest = v3Manifest(2, 2, "manifest-v3-exact");
  const getPublicationGuard = vi.fn(async () => ({
    requestedTrackCount: 2,
    enforcement: "required" as const,
    currentOutcomeHash: null,
    decision: null,
  }));
  await expect(assertManifestPublicationAuthorized(
    { getPublicationGuard } as unknown as PublicationRepository,
    productionManifest,
  )).resolves.toBeUndefined();
  expect(getPublicationGuard).toHaveBeenCalledWith({
    runId: productionManifest.runId,
    manifestId: productionManifest.id,
    manifestRevisionId: productionManifest.revisionId,
    manifestRevisionHash: productionManifest.contentHash,
    selectedCount: 2,
  });
});

test("V3 short manifests require unexpired consent bound to the exact revision, hash, outcome, and counts", async () => {
  const productionManifest = v3Manifest(1, 2, "manifest-v3-consented-partial");
  const valid = acceptedGuard(productionManifest, 2);
  await expect(assertManifestPublicationAuthorized(
    { getPublicationGuard: vi.fn(async () => valid) } as unknown as PublicationRepository,
    productionManifest,
  )).resolves.toBeUndefined();

  const invalidGuards = [
    { ...valid, decision: null },
    { ...valid, decision: { ...valid.decision, manifestRevisionId: "another-revision" } },
    { ...valid, decision: { ...valid.decision, manifestRevisionHash: "b".repeat(64) } },
    { ...valid, decision: { ...valid.decision, selectedCount: 0 } },
    { ...valid, currentOutcomeHash: "c".repeat(64) },
    { ...valid, decision: { ...valid.decision, expiresAt: new Date(Date.now() - 1) } },
  ];
  for (const guard of invalidGuards) {
    await expect(assertManifestPublicationAuthorized(
      { getPublicationGuard: vi.fn(async () => guard) } as unknown as PublicationRepository,
      productionManifest,
    )).rejects.toBeInstanceOf(PartialPublicationDecisionRequiredError);
  }
});

test("V3 rejects an unconsented short manifest before any Apple request or playlist write", async () => {
  const productionManifest = v3Manifest(1, 25, "manifest-v3-unconsented-partial");
  const harness = durablePublicationHarness({ manifest: productionManifest });
  harness.repository.getPublicationGuard = vi.fn(async () => ({
    requestedTrackCount: 25,
    enforcement: "required" as const,
    currentOutcomeHash: "d".repeat(64),
    decision: null,
  }));
  const fetchMock = vi.fn(async () => {
    throw new Error("The V3 partial guard must run before Apple");
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(publishManifest(harness.repository, productionManifest.id))
    .rejects.toBeInstanceOf(PartialPublicationDecisionRequiredError);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(harness.repository.createPublicationVolume).not.toHaveBeenCalled();
});

test("a zero-track manifest completes without any Apple request or playlist write", async () => {
  const productionManifest = v3Manifest(0, 25, "manifest-v3-zero");
  const harness = durablePublicationHarness({ manifest: productionManifest });
  harness.repository.getPublicationGuard = vi.fn(async () => {
    throw new Error("A zero-track manifest must not reach the publication guard");
  });
  const fetchMock = vi.fn(async () => {
    throw new Error("A zero-track manifest must not call Apple");
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(publishManifest(harness.repository, productionManifest.id)).resolves.toEqual({
    status: "no_compatible_tracks",
    manifestId: productionManifest.id,
    volumes: [],
  });
  expect(harness.run).toMatchObject({ status: "no_compatible_tracks", phase: "no_compatible_tracks", error: null });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(harness.repository.createPublicationVolume).not.toHaveBeenCalled();
});

test("publication partial outcomes preserve known causes and let catalog preflight take precedence", () => {
  expect(publicationPartialOutcomeStatus({
    priorOutcome: { status: "partial_timed_out" } as any,
    omittedCandidateCount: 10,
  })).toBe("partial_timed_out");
  expect(publicationPartialOutcomeStatus({
    priorOutcome: { status: "partial_policy_conflict" } as any,
    unresolvedCoverageCount: 1,
  })).toBe("partial_policy_conflict");
  expect(publicationPartialOutcomeStatus({
    priorOutcome: { status: "partial_evidence_shortfall" } as any,
    preflightOmittedCount: 1,
    reasonCodes: ["preflight_catalog_identity_unavailable"],
  })).toBe("partial_catalog_degraded");
  expect(publicationPartialOutcomeStatus({ unresolvedCoverageCount: 2 }))
    .toBe("partial_frontier_exhausted");
});

test("V2 publication fails closed when a required preflight capability is missing", async () => {
  const base = lockedManifest(1, "manifest-v2-fail-closed");
  const productionManifest: LockedManifest = {
    ...base,
    pipelineVersion: "catalog_first_v2",
    policyVersion: "relevance_first_2026_07",
    revisionId: "revision-1",
    revision: 1,
  };
  const harness = durablePublicationHarness({ manifest: productionManifest });
  (harness.repository as any).getManifestPreflightTracks = undefined;
  const fetchMock = vi.fn(async () => {
    throw new Error("V2 fail-closed preflight must not call Apple");
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(publishManifest(harness.repository, productionManifest.id))
    .rejects.toThrow(/Pipeline V2 publication preflight is unavailable.*getManifestPreflightTracks/u);
  expect(harness.repository.createPublicationVolume).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a new V2 revision retires every stale volume before publishing and exposing its replacement", async () => {
  const base = lockedManifest(1, "manifest-v2-revision-safe");
  const productionManifest: LockedManifest = {
    ...base,
    pipelineVersion: "catalog_first_v2",
    policyVersion: "relevance_first_2026_07",
    revisionId: "revision-2",
    revision: 2,
  };
  const harness = durablePublicationHarness({ manifest: productionManifest });
  harness.volumes.push(
    {
      id: "old-volume-1",
      manifestId: productionManifest.id,
      manifestRevisionId: "revision-1",
      volumeNumber: 1,
      volumeCount: 2,
      startPosition: 0,
      endPosition: 0,
      status: "complete",
      applePlaylistId: "p.old-1",
      appleShareUrl: "https://music.apple.com/us/playlist/old-1/pl.old1",
      appendedCount: 1,
      attempt: 0,
    },
    {
      id: "old-volume-2",
      manifestId: productionManifest.id,
      manifestRevisionId: "revision-1",
      volumeNumber: 2,
      volumeCount: 2,
      startPosition: 1,
      endPosition: 1,
      status: "complete",
      applePlaylistId: "p.old-2",
      appleShareUrl: "https://music.apple.com/us/playlist/old-2/pl.old2",
      appendedCount: 1,
      attempt: 0,
    },
  );
  vi.mocked(harness.repository.getManifestPreflightTracks!).mockResolvedValue([{
    position: 0,
    candidateId: base.tracks[0]!.candidateId,
    catalogId: base.tracks[0]!.catalogId,
    artist: base.tracks[0]!.artist,
    title: base.tracks[0]!.title,
    recordingFamilyId: "family-1",
    catalogIdentityId: "identity-101",
    alternates: [],
  }]);

  const playlistState: string[] = [];
  const shareUrl = "https://music.apple.com/us/playlist/revision-safe/pl.revision-safe";
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/v1/catalog/us/songs") {
      return new Response(JSON.stringify({ data: [{ id: "101", attributes: { isrc: "USAAA2000101" } }] }), { status: 200 });
    }
    if (url.pathname === "/v1/me/library/playlists" && method === "GET") {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (url.pathname === "/v1/me/library/playlists" && method === "POST") {
      return new Response(JSON.stringify({ data: [{ id: "p.revision-safe" }] }), { status: 201 });
    }
    if (url.pathname === "/v1/me/library/playlists/p.revision-safe/tracks" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { data: Array<{ id: string }> };
      playlistState.push(...body.data.map((item) => item.id));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/v1/me/library/playlists/p.revision-safe/tracks" && method === "GET") {
      return new Response(JSON.stringify({ data: playlistState.map((id) => ({ attributes: { playParams: { catalogId: id } } })) }), { status: 200 });
    }
    if (url.pathname === "/v1/me/library/playlists/p.revision-safe" && method === "GET") {
      return new Response(JSON.stringify({ data: [{
        id: "p.revision-safe",
        type: "library-playlists",
        attributes: { isPublic: true, canEdit: true, url: shareUrl },
      }] }), { status: 200 });
    }
    throw new Error(`Unexpected revision-safe Apple request: ${method} ${url.pathname}${url.search}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(publishManifest(harness.repository, productionManifest.id)).resolves.toMatchObject({
    status: "complete",
    volumes: [{ playlistId: "p.revision-safe", shareUrl, trackCount: 1 }],
  });
  expect(harness.repository.hidePublicPlaylistsForRun).toHaveBeenCalledWith(productionManifest.runId);
  expect(harness.repository.retirePublicationVolume).toHaveBeenCalledTimes(2);
  expect(harness.volumes).toEqual([
    expect.objectContaining({
      manifestRevisionId: "revision-2",
      volumeNumber: 1,
      volumeCount: 1,
      applePlaylistId: "p.revision-safe",
      appleShareUrl: shareUrl,
      status: "complete",
    }),
  ]);
  expect(JSON.stringify(harness.volumes)).not.toContain("pl.old");
});

test("V2 preflight locks a replacement revision before publishing a qualified reserve recording", async () => {
  const base = lockedManifest(2, "manifest-v2-preflight");
  const productionManifest: LockedManifest = {
    ...base,
    pipelineVersion: "catalog_first_v2",
    policyVersion: "relevance_first_2026_07",
    revisionId: "revision-1",
    revision: 1,
  };
  const harness = durablePublicationHarness({ manifest: productionManifest });
  vi.mocked(harness.repository.getPipelineStageCounts!).mockResolvedValue({
    discovered: 3,
    scope_qualified: 3,
    claim_verified: 3,
    version_compatible: 3,
    catalog_resolved: 3,
    playable: 3,
    canonicalized: 3,
    quota_eligible: 3,
    sequenced: 2,
    manifested: 2,
    published: 2,
  });
  const replacementTracks = [
    {
      position: 0,
      candidateId: "reserve-candidate-3",
      catalogId: "303",
      artist: "Reserve Artist",
      title: "Reserve Track",
      recordingFamilyId: "family-3",
      catalogIdentityId: "identity-303",
    },
    {
      position: 1,
      candidateId: base.tracks[1]!.candidateId,
      catalogId: base.tracks[1]!.catalogId,
      artist: base.tracks[1]!.artist,
      title: base.tracks[1]!.title,
      recordingFamilyId: "family-2",
      catalogIdentityId: "identity-102",
    },
  ];
  vi.mocked(harness.repository.getManifestPreflightTracks!).mockResolvedValue([
    {
      position: 0,
      candidateId: base.tracks[0]!.candidateId,
      catalogId: base.tracks[0]!.catalogId,
      artist: base.tracks[0]!.artist,
      title: base.tracks[0]!.title,
      recordingFamilyId: "family-1",
      catalogIdentityId: "identity-101",
      alternates: [],
    },
    { ...replacementTracks[1], alternates: [] },
  ]);
  vi.mocked(harness.repository.getManifestPreflightReserveTracks!).mockResolvedValue([{
    ...replacementTracks[0],
    alternates: [],
    evidenceEligible: true,
    hardConstraintsSatisfied: true,
    versionCompatible: true,
    qualified: true,
  }]);
  vi.mocked(harness.repository.createManifestRevision!).mockResolvedValue("revision-2");
  vi.mocked(harness.repository.getManifestRevision!).mockResolvedValue({
    id: "revision-2",
    manifestId: productionManifest.id,
    revision: 2,
    parentRevisionId: "revision-1",
    status: "locked",
    reason: "preflight_qualified_reserve_substituted",
    contentHash: manifestContentHash(replacementTracks),
    pipelineVersion: "catalog_first_v2",
    policyVersion: "relevance_first_2026_07",
    selectionPlanSnapshot: null,
    policySnapshot: null,
    outcomeSnapshot: null,
    deficitSnapshot: [],
    lockedAt: "2026-07-19T12:00:00.000Z",
    createdAt: "2026-07-19T12:00:00.000Z",
    tracks: replacementTracks,
    reserveTracks: [],
  });
  const playlistState: string[] = [];
  const shareUrl = "https://music.apple.com/us/playlist/v2-preflight/pl.v2-preflight";
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/v1/catalog/us/songs") {
      return new Response(JSON.stringify({
        data: ["102", "303"].map((id) => ({ id, attributes: { isrc: `USAAA2000${id}` } })),
      }), { status: 200 });
    }
    if (url.pathname === "/v1/me/library/playlists" && method === "GET") return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (url.pathname === "/v1/me/library/playlists" && method === "POST") {
      return new Response(JSON.stringify({ data: [{ id: "p.v2-preflight" }] }), { status: 201 });
    }
    if (url.pathname === "/v1/me/library/playlists/p.v2-preflight/tracks" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { data: Array<{ id: string }> };
      playlistState.push(...body.data.map((item) => item.id));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/v1/me/library/playlists/p.v2-preflight/tracks" && method === "GET") {
      return new Response(JSON.stringify({ data: playlistState.map((id) => ({ attributes: { playParams: { catalogId: id } } })) }), { status: 200 });
    }
    if (url.pathname === "/v1/me/library/playlists/p.v2-preflight" && method === "GET") {
      return new Response(JSON.stringify({ data: [{ id: "p.v2-preflight", type: "library-playlists", attributes: { isPublic: true, canEdit: true, url: shareUrl } }] }), { status: 200 });
    }
    throw new Error(`Unexpected V2 Apple request: ${method} ${url.pathname}${url.search}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(publishManifest(harness.repository, productionManifest.id)).resolves.toMatchObject({
    status: "complete",
    volumes: [{ playlistId: "p.v2-preflight", shareUrl, trackCount: 2 }],
  });
  expect(harness.repository.createManifestRevision).toHaveBeenCalledWith(
    productionManifest.runId,
    expect.objectContaining({
      revision: 2,
      parentRevisionId: "revision-1",
      status: "locked",
      tracks: [expect.objectContaining({ candidateId: "reserve-candidate-3", catalogId: "303" }), expect.anything()],
      reserveTracks: [],
    }),
  );
  expect(harness.repository.markManifestRevisionStatus).toHaveBeenNthCalledWith(1, productionManifest.runId, "revision-1", "superseded");
  expect(harness.repository.sealManifestRevisionPublication).toHaveBeenCalledWith(
    productionManifest.runId,
    "revision-2",
    expect.objectContaining({ status: "complete", publishedTrackCount: 2 }),
  );
  expect(harness.repository.appendCandidateStageEvents).toHaveBeenCalledWith(
    productionManifest.runId,
    expect.arrayContaining([
      expect.objectContaining({
        candidateId: "reserve-candidate-3",
        fromStage: "manifested",
        toStage: "published",
        reasonCode: "apple_publication_membership_verified",
      }),
      expect.objectContaining({
        candidateId: base.tracks[1]!.candidateId,
        fromStage: "manifested",
        toStage: "published",
        reasonCode: "apple_publication_membership_verified",
      }),
    ]),
    {
      pipelineVersion: "catalog_first_v2",
      policyVersion: "relevance_first_2026_07",
    },
  );
  expect(playlistState).toEqual(["303", "102"]);
});

test("canonical preflight revalidates unchanged Apple inventory and makes revoked evidence a visible decision before any write", async () => {
  const base = lockedManifest(2, "manifest-v3-unchanged-revalidation");
  const productionManifest: LockedManifest = {
    ...base,
    pipelineVersion: "corpus_first_v3",
    policyVersion: "corpus_first_v3_policy_v1",
    selectionPlan: {
      requestedTrackCount: 2,
    } as LockedManifest["selectionPlan"],
    revisionId: "11111111-1111-4111-8111-111111111112",
    revision: 1,
    contractRevisionId: "22222222-2222-4222-8222-222222222223",
    contractHash: "d".repeat(64),
  };
  const harness = durablePublicationHarness({ manifest: productionManifest });
  harness.repository.getPublicationGuard = vi.fn(async () => ({
    requestedTrackCount: 2,
    enforcement: "required" as const,
    currentOutcomeHash: null,
    decision: null,
  }));
  vi.mocked(harness.repository.getManifestPreflightTracks!).mockResolvedValue(
    base.tracks.map((track, index) => ({
      position: track.position ?? index,
      candidateId: track.candidateId,
      catalogId: track.catalogId,
      artist: track.artist,
      title: track.title,
      recordingFamilyId: `family-${index + 1}`,
      catalogIdentityId: `identity-${track.catalogId}`,
      alternates: [],
    })),
  );
  vi.mocked(harness.repository.getManifestPreflightReserveTracks!)
    .mockResolvedValue([]);
  vi.mocked(harness.repository.revalidateCanonicalPublicationManifest!)
    .mockRejectedValue(
      new CanonicalPublicationRevalidationRequiredErrorV1([
        "canonical_qualification_projection_missing",
      ]),
    );
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/catalog/us/songs") {
      return new Response(JSON.stringify({
        data: base.tracks.map((track) => ({
          id: track.catalogId,
          attributes: { isrc: `USAAA2000${track.catalogId}` },
        })),
      }), { status: 200 });
    }
    throw new Error(`No Apple mutation was expected: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(publishManifest(harness.repository, productionManifest.id))
    .resolves.toEqual({
      status: "needs_decision",
      manifestId: productionManifest.id,
      volumes: [],
    });
  expect(
    harness.repository.revalidateCanonicalPublicationManifest,
  ).toHaveBeenCalledWith({
    runId: productionManifest.runId,
    manifestId: productionManifest.id,
    manifestRevisionId: productionManifest.revisionId,
    manifestRevisionHash: productionManifest.contentHash,
    partialPublicationAuthorized: false,
  });
  expect(harness.repository.createManifestRevision).not.toHaveBeenCalled();
  expect(harness.repository.createPublicationVolume).not.toHaveBeenCalled();
  expect(harness.repository.openPlaylistRunBlocker).toHaveBeenCalledWith(
    expect.objectContaining({
      runId: productionManifest.runId,
      dependencyKey: "publication_revalidation",
      state: expect.objectContaining({
        reasonCodes: ["canonical_qualification_projection_missing"],
      }),
    }),
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("canonical preflight moves to a visible decision without Apple writes when an exact reserve repair breaks playlist semantics", async () => {
  const base = lockedManifest(2, "manifest-v3-revalidation-decision");
  const productionManifest: LockedManifest = {
    ...base,
    pipelineVersion: "corpus_first_v3",
    policyVersion: "corpus_first_v3_policy_v1",
    revisionId: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    contractRevisionId: "22222222-2222-4222-8222-222222222222",
    contractHash: "c".repeat(64),
  };
  const harness = durablePublicationHarness({ manifest: productionManifest });
  harness.repository.getPublicationGuard = vi.fn(async () => ({
    requestedTrackCount: 2,
    enforcement: "required" as const,
    currentOutcomeHash: null,
    decision: null,
  }));
  vi.mocked(harness.repository.getManifestPreflightTracks!).mockResolvedValue([
    {
      position: 0,
      candidateId: base.tracks[0]!.candidateId,
      catalogId: base.tracks[0]!.catalogId,
      artist: base.tracks[0]!.artist,
      title: base.tracks[0]!.title,
      recordingFamilyId: "family-1",
      catalogIdentityId: "identity-101",
      alternates: [],
    },
    {
      position: 1,
      candidateId: base.tracks[1]!.candidateId,
      catalogId: base.tracks[1]!.catalogId,
      artist: base.tracks[1]!.artist,
      title: base.tracks[1]!.title,
      recordingFamilyId: "family-2",
      catalogIdentityId: "identity-102",
      alternates: [],
    },
  ]);
  vi.mocked(harness.repository.getManifestPreflightReserveTracks!).mockResolvedValue([{
    position: 0,
    candidateId: "reserve-candidate-3",
    catalogId: "303",
    artist: "Reserve Artist",
    title: "Reserve Track",
    recordingFamilyId: "family-3",
    catalogIdentityId: "identity-303",
    alternates: [],
    evidenceEligible: true,
    hardConstraintsSatisfied: true,
    versionCompatible: true,
    qualified: true,
  }]);
  vi.mocked(harness.repository.createManifestRevision!).mockRejectedValue(
    new CanonicalPublicationRevalidationRequiredErrorV1([
      "canonical_quota_failed:quota:core",
      "canonical_sequence_optimizer_mismatch",
    ]),
  );
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/catalog/us/songs") {
      return new Response(JSON.stringify({
        data: ["102", "303"].map((id) => ({
          id,
          attributes: { isrc: `USAAA2000${id}` },
        })),
      }), { status: 200 });
    }
    throw new Error(`No Apple mutation was expected: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(publishManifest(harness.repository, productionManifest.id))
    .resolves.toEqual({
      status: "needs_decision",
      manifestId: productionManifest.id,
      volumes: [],
    });
  expect(harness.repository.openPlaylistRunBlocker).toHaveBeenCalledWith({
    runId: productionManifest.runId,
    contractRevisionId: productionManifest.contractRevisionId,
    blockerKind: "scope_decision",
    dependencyKey: "publication_revalidation",
    retryCount: 0,
    nextRetryAt: null,
    automaticRetryUntil: null,
    state: expect.objectContaining({
      reasonCode: CANONICAL_PUBLICATION_REVALIDATION_ERROR,
      reasonCodes: [
        "canonical_quota_failed:quota:core",
        "canonical_sequence_optimizer_mismatch",
      ],
      nextAction: "review_contract",
    }),
  });
  expect(harness.run).toMatchObject({
    status: "needs_decision",
    phase: "publication_contract_revalidation_required",
    error: null,
  });
  expect(harness.repository.createPublicationVolume).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("V2 storefront preflight returns no-compatible as a non-error without creating Apple state", async () => {
  const base = lockedManifest(1, "manifest-v2-empty-preflight");
  const productionManifest: LockedManifest = {
    ...base,
    pipelineVersion: "catalog_first_v2",
    policyVersion: "relevance_first_2026_07",
    revisionId: "revision-1",
    revision: 1,
  };
  const harness = durablePublicationHarness({ manifest: productionManifest });
  vi.mocked(harness.repository.getPipelineStageCounts!).mockResolvedValue({
    discovered: 1,
    scope_qualified: 1,
    claim_verified: 1,
    version_compatible: 1,
    catalog_resolved: 1,
    playable: 1,
    canonicalized: 1,
    quota_eligible: 1,
    sequenced: 1,
    manifested: 1,
    published: 0,
  });
  harness.volumes.push({
    id: "previously-published-volume",
    manifestId: productionManifest.id,
    manifestRevisionId: "revision-1",
    volumeNumber: 1,
    volumeCount: 1,
    startPosition: 0,
    endPosition: 0,
    status: "complete",
    applePlaylistId: "p.preflight-stale",
    appleShareUrl: "https://music.apple.com/us/playlist/stale/pl.stale",
    appendedCount: 1,
    attempt: 0,
  });
  vi.mocked(harness.repository.getManifestPreflightTracks!).mockResolvedValue([{
    position: 0,
    candidateId: base.tracks[0]!.candidateId,
    catalogId: base.tracks[0]!.catalogId,
    artist: base.tracks[0]!.artist,
    title: base.tracks[0]!.title,
    recordingFamilyId: "family-1",
    catalogIdentityId: "identity-101",
    alternates: [],
  }]);
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/catalog/us/songs") {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    throw new Error(`No Apple mutation was expected: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(publishManifest(harness.repository, productionManifest.id)).resolves.toEqual({
    status: "no_compatible_tracks",
    manifestId: productionManifest.id,
    volumes: [],
  });
  expect(harness.run).toMatchObject({ status: "partial", phase: "no_compatible_tracks", error: null });
  expect(harness.repository.createPublicationVolume).not.toHaveBeenCalled();
  expect(harness.repository.hidePublicPlaylistsForRun).toHaveBeenCalledWith(productionManifest.runId);
  expect(harness.repository.retirePublicationVolume).toHaveBeenCalledWith(expect.objectContaining({
    publicationVolumeId: "previously-published-volume",
    applePlaylistId: "p.preflight-stale",
  }));
  expect(harness.volumes).toEqual([]);
  expect(harness.repository.markManifestRevisionStatus).toHaveBeenCalledWith(
    productionManifest.runId,
    "revision-1",
    "abandoned",
  );
  expect(harness.repository.savePipelineOutcome).toHaveBeenCalledWith(
    productionManifest.runId,
    expect.objectContaining({ status: "no_compatible_tracks", publishedTrackCount: 0 }),
  );
  expect(harness.repository.appendCandidateStageEvents).toHaveBeenCalledWith(
    productionManifest.runId,
    [expect.objectContaining({
      candidateId: base.tracks[0]!.candidateId,
      fromStage: "manifested",
      toStage: "rejected",
      reasonCode: "publication_preflight_no_compatible_identity",
    })],
    {
      pipelineVersion: "catalog_first_v2",
      policyVersion: "relevance_first_2026_07",
    },
  );
});

test("the production publisher executes a 6,000-track plan across six exact volumes", { timeout: 30_000 }, async () => {
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
          attributes: { isPublic: true, url: `https://music.apple.com/us/playlist/needle-volume-${number}/pl.volume-${number}` },
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
  expect(createdNames).toEqual([
    `${productionManifest.name} [1/6]`,
    `${productionManifest.name} [2/6]`,
    `${productionManifest.name} [2/6]`,
    `${productionManifest.name} [3/6]`,
    `${productionManifest.name} [4/6]`,
    `${productionManifest.name} [5/6]`,
    `${productionManifest.name} [6/6]`,
  ]);
  expect(harness.volumes.every((volume) => volume.status === "complete" && volume.appendedCount === 1_000)).toBe(true);
  expect(acceptedThenDisconnected).toBe(true);
  expect(rateLimited).toBe(true);
  expect(harness.repository.markPlaylistOrphan).toHaveBeenCalledWith(expect.objectContaining({
    applePlaylistId: "p.volume-2",
    reason: "Apple append outcome remained uncertain after bounded reconciliation",
  }));
  expect(fetchMock.mock.calls.filter(([input, init]) => (
    /\/tracks$/u.test(new URL(String(input)).pathname)
    && String((init as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "POST"
  ))).toHaveLength(241); // 240 accepted batches plus one indeterminate 429 on the abandoned playlist.
  const orderedTrackReads = fetchMock.mock.calls.filter(([input, init]) => (
    /\/tracks$/u.test(new URL(String(input)).pathname)
    && String((init as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "GET"
  )).length;
  // Keep the scale test's timeout isolated from ordinary unit tests while
  // retaining a deterministic performance guard. Wall-clock timing becomes
  // noisy under V8 coverage and shared CI runners; bounded Apple reads catch
  // reconciliation or pagination regressions without depending on host speed.
  expect(orderedTrackReads).toBeLessThanOrEqual(1_350);
  expect(playlistStates.get("p.volume-2")).toEqual([]);
  for (const volume of result.volumes) {
    expect(playlistStates.get(volume.playlistId)).toEqual(
      productionManifest.tracks.slice(volume.index * 1_000, (volume.index + 1) * 1_000).map((track) => track.catalogId),
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
        data: [{ id: "p.resumed", type: "library-playlists", attributes: { isPublic: true, url: shareUrl } }],
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
  await expect(recoverWaitingApplePublicationJobs(harness.repository)).resolves.toBe(1);
  const validationEpoch = harness.authorization?.lastValidatedAt?.getTime().toString(36);
  expect(validationEpoch).toBeTruthy();
  expect(harness.repository.enqueueWaitingPublicationRecovery).toHaveBeenCalledWith({
    runId: productionManifest.runId,
    manifestId: productionManifest.id,
    dedupeKey: `publication:${productionManifest.id}:reauth:${appleAuthorizationGeneration(replacementAuthorization)}:${validationEpoch}`,
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

test("publishManifest rejects missing, mutable, corrupt, and catalog-incomplete manifests before Apple access", async () => {
  const base = lockedManifest(1, "manifest-validation");
  const missingCatalogTracks = [{ ...base.tracks[0]!, catalogId: "" }];
  const cases: Array<{ manifest: LockedManifest | null; id: string; message: RegExp }> = [
    { manifest: null, id: "manifest-missing", message: /was not found/ },
    { manifest: { ...base, lockedAt: "" }, id: base.id, message: /immutable locked manifest/ },
    { manifest: { ...base, contentHash: "0".repeat(64) }, id: base.id, message: /content hash/ },
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
