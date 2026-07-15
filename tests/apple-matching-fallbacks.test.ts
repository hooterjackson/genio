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
    "In the Marketplace (Interlude) Earth, Wind & Fire",
    "Earth, Wind & Fire In the Marketplace (Interlude)",
    "In the Marketplace (Interlude) All 'N All",
    "in the marketplace Earth, Wind & Fire",
    "Earth, Wind & Fire in the marketplace",
    "In the Marketplace (Interlude)",
    "in the marketplace",
  ]);
  expect(normalizeMusicBaseTitle("The Gentle Rain (Chuva Delicada)")).toBe("the gentle rain");
});

test("a direct artist/title/album result stops the query ladder after one request", async () => {
  vi.mocked(searchAppleCatalog).mockResolvedValueOnce([exactSong]);

  const songs = await lookupCandidateSongs(candidate(), "us");

  expect(songs).toEqual([exactSong]);
  expect(searchAppleCatalog).toHaveBeenCalledTimes(1);
  expect(searchAppleCatalog).toHaveBeenCalledWith("us", "Test Song Test Artist", undefined);
});

test("an exact artist and title do not spend a second request on an Apple album edition", async () => {
  const appleEdition = { ...exactSong, albumName: "Test Album (Deluxe Edition)" };
  vi.mocked(searchAppleCatalog).mockResolvedValueOnce([appleEdition]);

  const songs = await lookupCandidateSongs(candidate(), "us");

  expect(songs).toEqual([appleEdition]);
  expect(searchAppleCatalog).toHaveBeenCalledTimes(1);
});

test("a unique exact Apple title with the wrong artist remains an unselected alternative", async () => {
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
    "Corcovado Paulinho da Costa",
    "Paulinho da Costa Corcovado",
    "Corcovado Agora",
    "Corcovado",
  ]);
  expect(result).toMatchObject({
    status: "review",
    song: null,
  });
  expect(result.alternatives).toEqual([appleSong]);
  expect(result.basis).toContain("unresolved artist or album attribution");
});

test("a leading article artist variant is selectable for review but not auto-accepted", () => {
  const input = candidate({ artist: "Commodores", title: "Nightshift", album: null });
  const result = rankCatalogMatches(input.id, input, [{
    id: "apple-nightshift",
    name: "Nightshift",
    artistName: "The Commodores",
    albumName: "Nightshift",
  }]);

  expect(result).toMatchObject({
    status: "review",
    song: { id: "apple-nightshift", artistName: "The Commodores" },
  });
  expect(result.basis).toContain("leading-article artist variant");
});

test("an order-insensitive collaborator set is selectable for review but not auto-accepted", () => {
  const input = candidate({
    artist: "Paulinho da Costa & Joe Pass",
    title: "Corcovado",
    album: null,
  });
  const result = rankCatalogMatches(input.id, input, [{
    id: "apple-corcovado-duo",
    name: "Corcovado",
    artistName: "Joe Pass & Paulinho Da Costa",
    albumName: "Tudo Bem!",
  }]);

  expect(result).toMatchObject({
    status: "review",
    song: { id: "apple-corcovado-duo", artistName: "Joe Pass & Paulinho Da Costa" },
  });
  expect(result.basis).toContain("order-insensitive collaborator set");
});

test("a wrong-artist unique title can never become the primary Apple selection", () => {
  const input = candidate({ artist: "Drexciya", title: "Black Sea", album: null });
  const wrongArtist: CatalogSong = {
    id: "wrong-black-sea",
    name: "Black Sea",
    artistName: "Unrelated Artist",
    albumName: "Black Sea",
  };
  const result = rankCatalogMatches(input.id, input, [wrongArtist]);

  expect(result).toMatchObject({ status: "review", song: null });
  expect(result.alternatives).toEqual([wrongArtist]);
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

test("a remastered presentation remains selectable for review without becoming an automatic exact match", () => {
  const input = candidate({
    artist: "Earth, Wind & Fire",
    title: "In the Stone",
    album: "I Am",
  });
  const result = rankCatalogMatches(input.id, input, [{
    id: "apple-remaster",
    name: "In the Stone (2018 Remaster)",
    artistName: "Earth, Wind & Fire",
    albumName: "I Am (2018 Remaster)",
  }]);

  expect(result).toMatchObject({
    status: "review",
    song: { id: "apple-remaster" },
  });
  expect(result.basis).toContain("parenthetical title variant");
});

test("apostrophe and compact acronym variants prefer the correct artist without auto-accepting", () => {
  const noUfos = candidate({ artist: "Model500", title: "No UFOs", album: null });
  const noUfosResult = rankCatalogMatches(noUfos.id, noUfos, [
    {
      id: "wrong-exact-title",
      name: "No UFOs",
      artistName: "Unrelated Artist",
      albumName: "No UFOs",
    },
    {
      id: "correct-vocal",
      name: "No Ufo's (Vocal)",
      artistName: "Model 500",
      albumName: "No UFO's",
    },
  ]);
  expect(noUfosResult).toMatchObject({
    status: "review",
    song: { id: "correct-vocal", artistName: "Model 500" },
  });
  expect(noUfosResult.basis).toContain("punctuation-normalized artist");

  const q = candidate({ artist: "Basic Channel", title: "Q 1.1", album: null });
  const qResult = rankCatalogMatches(q.id, q, [
    {
      id: "wrong-q",
      name: "Q 1.1",
      artistName: "Unrelated Artist",
      albumName: "Q 1.1",
    },
    {
      id: "correct-q",
      name: "Q1.1",
      artistName: "Basic Channel",
      albumName: "Q1.1",
    },
  ]);
  expect(qResult).toMatchObject({
    status: "review",
    song: { id: "correct-q", artistName: "Basic Channel" },
  });
  expect(qResult.basis).toContain("punctuation-normalized title");
});

test("compact-title similarity alone never promotes a different artist", () => {
  const input = candidate({ artist: "Basic Channel", title: "Q 1.1", album: null });
  const result = rankCatalogMatches(input.id, input, [{
    id: "wrong-artist",
    name: "Q1.1",
    artistName: "Unrelated Artist",
    albumName: "Q1.1",
  }]);

  expect(result).toMatchObject({ status: "unavailable", song: null });
});

test("a parent title can surface Apple numbered parts for review without auto-accepting either", () => {
  const input = candidate({ artist: "Basic Channel", title: "Quadrant Dub", album: null });
  const result = rankCatalogMatches(input.id, input, [
    {
      id: "quadrant-i",
      name: "Quadrant Dub I",
      artistName: "Basic Channel",
      albumName: "Quadrant Dub",
    },
    {
      id: "quadrant-ii",
      name: "Quadrant Dub II",
      artistName: "Basic Channel",
      albumName: "Quadrant Dub",
    },
  ]);

  expect(result).toMatchObject({
    status: "review",
    song: { id: "quadrant-i" },
  });
  expect(result.alternatives.map((song) => song.id)).toEqual(["quadrant-ii"]);
  expect(result.basis).toContain("numbered-part title variant");
});

test("a numbered-part stem from the wrong artist remains unavailable", () => {
  const input = candidate({ artist: "Basic Channel", title: "Quadrant Dub", album: null });
  const result = rankCatalogMatches(input.id, input, [{
    id: "wrong-quadrant",
    name: "Quadrant Dub I",
    artistName: "Unrelated Artist",
    albumName: "Unrelated Album",
  }]);

  expect(result).toMatchObject({ status: "unavailable", song: null });
});

test("album compilation wording cannot manufacture a recording-version conflict", () => {
  const input = candidate({ artist: "Test Artist", title: "Test Song", album: "Original Album" });
  const result = rankCatalogMatches(input.id, input, [{
    ...exactSong,
    id: "apple-compilation",
    albumName: "Live & Remastered: The Remixes",
  }]);

  expect(result).toMatchObject({ status: "review", song: { id: "apple-compilation" } });
});

test("mastering compatibility is asymmetric when the requested version is explicit", () => {
  const explicitRemaster = candidate({
    artist: "Test Artist",
    title: "Test Song (2018 Remaster)",
    album: "Test Album",
  });
  const result = rankCatalogMatches(explicitRemaster.id, explicitRemaster, [exactSong]);

  expect(result).toMatchObject({ status: "review", song: null });
  expect(result.basis).toContain("recording-version conflicts");
});

test("a genuinely different live recording remains unresolved instead of being auto-selected", () => {
  const input = candidate({ artist: "Test Artist", title: "Test Song", album: "Test Album" });
  const result = rankCatalogMatches(input.id, input, [{
    ...exactSong,
    id: "apple-live",
    name: "Test Song (Live)",
  }]);

  expect(result).toMatchObject({ status: "review", song: null });
  expect(result.alternatives.map((song) => song.id)).toEqual(["apple-live"]);
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
