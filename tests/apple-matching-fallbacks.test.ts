import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CatalogSong, TrackCandidateInput } from "../shared/types.ts";

vi.mock("../server/apple.ts", async () => {
  const actual = await vi.importActual<typeof import("../server/apple.ts")>("../server/apple.ts");
  return {
    ...actual,
    lookupAppleCatalogByIsrc: vi.fn(),
    searchAppleCatalog: vi.fn(),
  };
});

import { lookupAppleCatalogByIsrc, searchAppleCatalog } from "../server/apple.ts";
import {
  catalogSearchQueries,
  lookupCandidateSongs,
  matchingConcurrency,
} from "../server/matching-service.ts";
import {
  mergeCatalogSongs,
  normalizeMusicBaseTitle,
  rankCatalogMatches,
} from "../lib/matching.ts";

function candidate(overrides: Partial<TrackCandidateInput> = {}) {
  return {
    id: "candidate-1",
    artist: "Test Artist",
    title: "Test Song",
    album: "Test Album",
    releaseYear: null,
    durationMs: null,
    isrc: null,
    musicbrainzId: null,
    versionLabel: null,
    evidence: [],
    ...overrides,
  };
}

const exactSong: CatalogSong = {
  id: "apple-exact",
  name: "Test Song",
  artistName: "Test Artist",
  albumName: "Test Album",
};

beforeEach(() => {
  vi.mocked(lookupAppleCatalogByIsrc).mockReset().mockResolvedValue([]);
  vi.mocked(searchAppleCatalog).mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test("catalog matching uses eight workers by default and clamps unsafe overrides", () => {
  expect(matchingConcurrency()).toBe(8);
  vi.stubEnv("APPLE_MATCHING_CONCURRENCY", "99");
  expect(matchingConcurrency()).toBe(12);
});

test("Apple query ladder goes from specific metadata to cautious title-only search", () => {
  expect(catalogSearchQueries(candidate({
    artist: "Earth, Wind & Fire",
    title: "In the Marketplace (Interlude)",
    album: "All 'N All",
  }))).toEqual([
    "Earth, Wind & Fire In the Marketplace (Interlude) All 'N All",
    "Earth, Wind & Fire In the Marketplace (Interlude)",
    "Earth, Wind & Fire in the marketplace",
    "In the Marketplace (Interlude) All 'N All",
    "In the Marketplace (Interlude)",
  ]);
  expect(normalizeMusicBaseTitle("The Gentle Rain (Chuva Delicada)")).toBe("the gentle rain");
});

test("a direct artist/title/album result stops the query ladder after one request", async () => {
  vi.mocked(searchAppleCatalog).mockResolvedValueOnce([exactSong]);

  const songs = await lookupCandidateSongs(candidate(), "us");

  expect(songs).toEqual([exactSong]);
  expect(searchAppleCatalog).toHaveBeenCalledTimes(1);
  expect(searchAppleCatalog).toHaveBeenCalledWith("us", "Test Artist Test Song Test Album", undefined);
});

test("wrong research artist and album fall back to a unique exact Apple title", async () => {
  const appleSong: CatalogSong = {
    id: "apple-corcovado",
    name: "Corcovado",
    artistName: "Joe Pass",
    albumName: "Tudo Bem!",
  };
  vi.mocked(searchAppleCatalog).mockImplementation(async (_storefront, query) => query === "Corcovado" ? [appleSong] : []);
  const input = candidate({ artist: "Paulinho da Costa", title: "Corcovado", album: "Agora" });

  const songs = await lookupCandidateSongs(input, "us");
  const result = rankCatalogMatches(input.id, input, songs);

  expect(vi.mocked(searchAppleCatalog).mock.calls.map((call) => call[1])).toEqual([
    "Paulinho da Costa Corcovado Agora",
    "Paulinho da Costa Corcovado",
    "Corcovado Agora",
    "Corcovado",
  ]);
  expect(result).toMatchObject({
    status: "review",
    song: { id: "apple-corcovado", artistName: "Joe Pass", albumName: "Tudo Bem!" },
  });
  expect(result.basis).toContain("artist or album attribution requires review");
});

test("Apple parenthetical title variants are retained for review instead of marked unavailable", () => {
  const input = candidate({
    artist: "Earth, Wind & Fire",
    title: "In the Marketplace",
    album: "All 'N All",
  });
  const result = rankCatalogMatches(input.id, input, [{
    id: "apple-interlude",
    name: "In the Marketplace (Interlude)",
    artistName: "Earth, Wind & Fire",
    albumName: "All 'N All",
  }]);

  expect(result).toMatchObject({ status: "review", song: { id: "apple-interlude" } });
  expect(result.basis).toContain("parenthetical title variant");
});

test("ambiguous title-only results remain unselected review alternatives", () => {
  const input = candidate({ artist: "Incorrect Artist", title: "Home", album: "Incorrect Album" });
  const result = rankCatalogMatches(input.id, input, [
    { id: "home-a", name: "Home", artistName: "Artist A", albumName: "Album A" },
    { id: "home-b", name: "Home", artistName: "Artist B", albumName: "Album B" },
  ]);

  expect(result.status).toBe("review");
  expect(result.song).toBeNull();
  expect(result.alternatives.map((song) => song.id)).toEqual(["home-a", "home-b"]);
  expect(result.basis).toContain("Multiple catalog recordings");
});

test("merged Apple searches deduplicate stable song IDs before ambiguity checks", () => {
  const merged = mergeCatalogSongs(
    [exactSong, { ...exactSong, id: "second" }],
    [{ ...exactSong }, { ...exactSong, id: "third" }],
  );
  expect(merged.map((song) => song.id)).toEqual(["apple-exact", "second", "third"]);
});
