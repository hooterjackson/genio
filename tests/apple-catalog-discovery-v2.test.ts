import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  getAppleCatalogAlbumTracks,
  getAppleCatalogArtistAlbums,
  getAppleCatalogArtistTopSongs,
  getAppleCatalogPlaylistTracks,
  getAppleCatalogSimilarArtists,
  searchAppleCatalogResources,
} from "../server/apple.ts";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const testPrivateKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const originalEnvironment = {
  teamId: process.env.APPLE_TEAM_ID,
  keyId: process.env.APPLE_KEY_ID,
  privateKey: process.env.APPLE_MUSICKIT_PRIVATE_KEY,
};

beforeEach(() => {
  process.env.APPLE_TEAM_ID = "TESTTEAM01";
  process.env.APPLE_KEY_ID = "TESTKEY001";
  process.env.APPLE_MUSICKIT_PRIVATE_KEY = testPrivateKey;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries({
    APPLE_TEAM_ID: originalEnvironment.teamId,
    APPLE_KEY_ID: originalEnvironment.keyId,
    APPLE_MUSICKIT_PRIVATE_KEY: originalEnvironment.privateKey,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function song(id = "101") {
  return {
    id,
    type: "songs",
    attributes: {
      name: `Song ${id}`,
      artistName: "Artist",
      albumName: "Album",
      genreNames: ["House", "Music"],
      durationInMillis: 180_000,
      isrc: `USAAA0000${id.padStart(3, "0")}`,
    },
  };
}

describe("Apple-resolved V2 discovery primitives", () => {
  test("a plural search returns typed containers without treating them as relevance proof", async () => {
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      void request;
      return response({
      results: {
        songs: { data: [song()] },
        artists: { data: [{ id: "201", attributes: { name: "Artist", genreNames: ["House"] } }] },
        albums: { data: [{ id: "301", attributes: { name: "Album", artistName: "Artist", trackCount: 12 } }] },
        playlists: { data: [{ id: "pl.editorial", attributes: {
          name: "House Essentials",
          curatorName: "Apple Music Dance",
          playlistType: "editorial",
          description: { standard: "<b>Documented</b> house selections." },
        } }] },
      },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchAppleCatalogResources("US", "house music");

    expect(result.songs[0]).toMatchObject({ id: "101", name: "Song 101", genreNames: ["House", "Music"] });
    expect(result.artists[0]).toMatchObject({ id: "201", name: "Artist" });
    expect(result.albums[0]).toMatchObject({ id: "301", trackCount: 12 });
    expect(result.playlists[0]).toMatchObject({
      id: "pl.editorial",
      curatorName: "Apple Music Dance",
      description: "Documented house selections.",
    });
    const requested = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(requested.origin).toBe("https://api.music.apple.com");
    expect(requested.searchParams.get("types")).toBe("songs,artists,albums,playlists");
    expect(requested.searchParams.get("term")).toBe("house music");
  });

  test("search pagination follows each typed Apple cursor without widening scope", async () => {
    const firstCursor = "/v1/catalog/us/search?term=house+music&types=songs&limit=25&offset=25";
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const requested = new URL(String(request));
      if (requested.searchParams.get("offset") === "25") {
        return response({ results: { songs: { data: [song("126")], next: null } } });
      }
      return response({ results: { songs: { data: [song("101")], next: firstCursor } } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await searchAppleCatalogResources("us", "house music", ["songs"], 25);
    expect(first.next).toEqual({ songs: firstCursor });

    const second = await searchAppleCatalogResources("us", "house music", ["songs"], 25, undefined, first.next!.songs);
    expect(second.songs).toEqual([expect.objectContaining({ id: "126" })]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get("offset")).toBe("25");

    await expect(searchAppleCatalogResources(
      "us",
      "house music",
      ["songs"],
      25,
      undefined,
      "/v1/catalog/us/search?term=houses&types=songs&offset=50",
    )).rejects.toThrow(/scope changed/iu);
    await expect(searchAppleCatalogResources(
      "us",
      "house music",
      ["songs"],
      25,
      undefined,
      "/v1/catalog/us/search?term=house+music&types=artists&offset=50",
    )).rejects.toThrow(/scope changed/iu);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("playlist and album enumeration retain Apple cursors but reject cross-container cursors", async () => {
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/playlists/")) {
        return response({ data: [song("102")], next: "/v1/catalog/us/playlists/pl.scope/tracks?offset=100" });
      }
      return response({ data: [song("103")], next: null });
    });
    vi.stubGlobal("fetch", fetchMock);

    const playlist = await getAppleCatalogPlaylistTracks("us", "pl.scope");
    const album = await getAppleCatalogAlbumTracks("us", "301");
    expect(playlist).toEqual({ items: [expect.objectContaining({ id: "102" })], next: "/v1/catalog/us/playlists/pl.scope/tracks?offset=100" });
    expect(album).toEqual({ items: [expect.objectContaining({ id: "103" })], next: null });

    await expect(getAppleCatalogPlaylistTracks(
      "us",
      "pl.scope",
      "/v1/catalog/us/playlists/pl.attacker/tracks?offset=100",
    )).rejects.toThrow(/scope changed/iu);
  });

  test("artist views expose top songs, albums, and similar artists through fixed endpoints", async () => {
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("top-songs")) return response({ data: [song("104")] });
      if (url.includes("similar-artists")) return response({ data: [{ id: "202", attributes: { name: "Other Artist" } }] });
      return response({ data: [{ id: "302", attributes: { name: "Single", artistName: "Artist", isSingle: true } }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAppleCatalogArtistTopSongs("us", "201")).resolves.toEqual({
      items: [expect.objectContaining({ id: "104" })],
      next: null,
    });
    await expect(getAppleCatalogArtistAlbums("us", "201", "singles")).resolves.toEqual({
      items: [expect.objectContaining({ id: "302", isSingle: true })],
      next: null,
    });
    await expect(getAppleCatalogSimilarArtists("us", "201")).resolves.toEqual({
      items: [expect.objectContaining({ id: "202", name: "Other Artist" })],
      next: null,
    });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining("/artists/201/view/top-songs?limit=25"),
      expect.stringContaining("/artists/201/view/singles?limit=25"),
      expect.stringContaining("/artists/201/view/similar-artists?limit=25"),
    ]);
  });

  test("invalid resource identifiers and search classes fail before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getAppleCatalogAlbumTracks("us", "../secrets")).rejects.toThrow(/album ID/iu);
    await expect(getAppleCatalogPlaylistTracks("us", "not-a-playlist")).rejects.toThrow(/playlist ID/iu);
    await expect(searchAppleCatalogResources("us", "house", [] as never[])).rejects.toThrow(/search type/iu);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
