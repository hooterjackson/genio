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
    "All 'N All In the Marketplace (Interlude)",
    "in the marketplace Earth, Wind & Fire",
    "Earth, Wind & Fire in the marketplace",
    "In the Marketplace (Interlude)",
    "in the marketplace",
  ]);
  expect(normalizeMusicBaseTitle("The Gentle Rain (Chuva Delicada)")).toBe("the gentle rain");
});

test("Apple query ladder keeps collaboration fallbacks bound to the full credit or album", () => {
  expect(catalogSearchQueries(candidate({
    artist: "Paulinho da Costa & Joe Pass",
    title: "Corcovado",
    album: "Tudo Bem!",
  }))).toEqual([
    "Corcovado Paulinho da Costa & Joe Pass",
    "Paulinho da Costa & Joe Pass Corcovado",
    "Corcovado Tudo Bem!",
    "Tudo Bem! Corcovado",
    "Corcovado",
  ]);
});

test("a direct artist/title/album result stops the query ladder after one request", async () => {
  vi.mocked(searchAppleCatalog).mockResolvedValueOnce([exactSong]);

  const songs = await lookupCandidateSongs(candidate(), "us");

  expect(songs).toEqual([exactSong]);
  expect(searchAppleCatalog).toHaveBeenCalledTimes(1);
  expect(searchAppleCatalog).toHaveBeenCalledWith("us", "Test Song Test Artist", undefined);
});

test("an exact artist and title on a different edition keep searching for the requested album", async () => {
  const appleEdition = { ...exactSong, id: "apple-deluxe", albumName: "Test Album (Deluxe Edition)" };
  vi.mocked(searchAppleCatalog).mockImplementation(async (_storefront, query) => {
    if (query === "Test Song Test Artist") return [appleEdition];
    if (query === "Test Artist Test Song") return [exactSong];
    return [];
  });

  const songs = await lookupCandidateSongs(candidate(), "us");
  const result = rankCatalogMatches("candidate-1", candidate(), songs);

  expect(songs).toEqual([appleEdition, exactSong]);
  expect(searchAppleCatalog).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({
    status: "accepted",
    song: { id: "apple-exact", albumName: "Test Album" },
  });
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
    "Agora Corcovado",
    "Corcovado",
  ]);
  expect(result).toMatchObject({
    status: "review",
    song: null,
  });
  expect(result.alternatives).toEqual([appleSong]);
  expect(result.basis).toContain("unresolved artist or album attribution");
});

test("a wrong artist on the same album cannot stop the ladder before an exact artist result", async () => {
  const wrongArtist: CatalogSong = {
    id: "apple-wrong-artist",
    name: "Test Song",
    artistName: "Unrelated Artist",
    albumName: "Test Album",
  };
  const compatibleArtist: CatalogSong = {
    ...exactSong,
    id: "apple-compatible-artist",
  };
  vi.mocked(searchAppleCatalog).mockImplementation(async (_storefront, query) => {
    if (query === "Test Song Test Artist") return [wrongArtist];
    if (query === "Test Artist Test Song") return [compatibleArtist];
    return [];
  });
  const input = candidate();

  const songs = await lookupCandidateSongs(input, "us");
  const result = rankCatalogMatches(input.id, input, songs);

  expect(searchAppleCatalog).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({
    status: "accepted",
    song: { id: "apple-compatible-artist", artistName: "Test Artist" },
  });
  expect(result.alternatives).toContainEqual(expect.objectContaining({ id: "apple-wrong-artist" }));
});

test("a leading-article review result does not hide a later exact artist match", async () => {
  const articleVariant: CatalogSong = {
    id: "apple-article-variant",
    name: "Nightshift",
    artistName: "The Commodores",
    albumName: "Nightshift",
  };
  const exactArtist: CatalogSong = {
    ...articleVariant,
    id: "apple-exact-commodores",
    artistName: "Commodores",
  };
  vi.mocked(searchAppleCatalog).mockImplementation(async (_storefront, query) => {
    if (query === "Nightshift Commodores") return [articleVariant];
    if (query === "Commodores Nightshift") return [exactArtist];
    return [];
  });
  const input = candidate({ artist: "Commodores", title: "Nightshift", album: null });

  const songs = await lookupCandidateSongs(input, "us");
  const result = rankCatalogMatches(input.id, input, songs);

  expect(searchAppleCatalog).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({
    status: "accepted",
    song: { id: "apple-exact-commodores", artistName: "Commodores" },
  });
});

test("unique exact artist, title, and album metadata is accepted without a source duration", () => {
  const input = candidate({ durationMs: null });
  const result = rankCatalogMatches(input.id, input, [exactSong]);

  expect(result).toMatchObject({
    status: "accepted",
    song: { id: "apple-exact" },
  });
  expect(result.basis).toContain("unique exact metadata");
});

test("a supplied source duration must still agree before exact metadata is accepted", () => {
  const input = candidate({ durationMs: 240_000 });
  const result = rankCatalogMatches(input.id, input, [{
    ...exactSong,
    durationInMillis: 270_000,
  }]);

  expect(result.status).toBe("review");
});

test("a version-labeled candidate without album or duration cannot auto-accept a title-only identity", () => {
  const input = candidate({
    album: null,
    durationMs: null,
    versionLabel: "Original Mix",
  });
  const result = rankCatalogMatches(input.id, input, [exactSong]);

  expect(result).toMatchObject({ status: "review", song: { id: "apple-exact" } });
  expect(result.basis).toContain("requires review");
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

test("a sparse cited candidate accepts a unique exact Apple artist and title", () => {
  const input = candidate({
    artist: "Michael Jackson",
    title: "Billie Jean",
    album: null,
  });
  const result = rankCatalogMatches(input.id, input, [{
    id: "apple-billie-jean",
    name: "Billie Jean",
    artistName: "Michael Jackson",
    albumName: "Thriller",
    durationInMillis: 294_000,
  }]);

  expect(result).toMatchObject({
    status: "accepted",
    song: { id: "apple-billie-jean" },
  });
  expect(result.basis).toContain("exact sparse metadata selects a corroborated recording family");
});

test("equivalent Apple reissues of a sparse exact track do not force manual review", () => {
  const input = candidate({
    artist: "Michael Jackson",
    title: "Billie Jean",
    album: null,
  });
  const result = rankCatalogMatches(input.id, input, [
    {
      id: "apple-thriller",
      name: "Billie Jean",
      artistName: "Michael Jackson",
      albumName: "Thriller",
      durationInMillis: 294_000,
    },
    {
      id: "apple-essential",
      name: "Billie Jean",
      artistName: "Michael Jackson",
      albumName: "The Essential Michael Jackson",
      durationInMillis: 294_500,
    },
  ]);

  expect(result).toMatchObject({ status: "accepted", song: { id: "apple-thriller" } });
});

test("materially different exact recordings remain review-only for sparse candidates", () => {
  const input = candidate({ artist: "Test Artist", title: "Test Song", album: null });
  const result = rankCatalogMatches(input.id, input, [
    { ...exactSong, id: "apple-original", durationInMillis: 240_000 },
    { ...exactSong, id: "apple-rerecording", albumName: "Later Sessions", durationInMillis: 260_000 },
  ]);

  expect(result.status).toBe("review");
});

test("a repeated original recording family wins over a derived Cirque version", () => {
  const input = candidate({ artist: "Michael Jackson", title: "Man in the Mirror", album: null });
  const result = rankCatalogMatches(input.id, input, [
    {
      id: "apple-cirque",
      name: "Man in the Mirror",
      artistName: "Michael Jackson",
      albumName: "Immortal (Music from the Cirque du Soleil Show)",
      releaseDate: "2011-11-17",
      durationInMillis: 254_560,
      isrc: "USSM11105977",
    },
    {
      id: "apple-history",
      name: "Man in the Mirror",
      artistName: "Michael Jackson",
      albumName: "HIStory",
      releaseDate: "1987-08-31",
      durationInMillis: 318_688,
      isrc: "USSM18700004",
    },
    {
      id: "apple-essential",
      name: "Man in the Mirror",
      artistName: "Michael Jackson",
      albumName: "The Essential Michael Jackson",
      releaseDate: "1987-08-31",
      durationInMillis: 320_905,
      isrc: "USSM19909070",
    },
    {
      id: "apple-this-is-it",
      name: "Man in the Mirror",
      artistName: "Michael Jackson",
      albumName: "Michael Jackson's This Is It",
      releaseDate: "1987-08-31",
      durationInMillis: 319_480,
      isrc: "USSM10905828",
    },
  ]);

  expect(result).toMatchObject({
    status: "accepted",
    song: { id: "apple-history" },
  });
});

test("a repeated full-length recording family wins over a shorter compilation edit", () => {
  const input = candidate({ artist: "Madonna", title: "Express Yourself", album: null });
  const result = rankCatalogMatches(input.id, input, [
    {
      id: "apple-edit-one",
      name: "Express Yourself",
      artistName: "Madonna",
      albumName: "Celebration",
      durationInMillis: 239_093,
      isrc: "USWB10903609",
    },
    {
      id: "apple-original",
      name: "Express Yourself",
      artistName: "Madonna",
      albumName: "Like a Prayer",
      durationInMillis: 279_133,
      isrc: "USWB10002776",
    },
    {
      id: "apple-original-reissue",
      name: "Express Yourself",
      artistName: "Madonna",
      albumName: "80s Album Collection",
      durationInMillis: 279_400,
      isrc: "USWB10002776",
    },
    {
      id: "apple-edit-two",
      name: "Express Yourself",
      artistName: "Madonna",
      albumName: "Celebration (Deluxe Video Edition)",
      durationInMillis: 239_093,
      isrc: "USWB10903609",
    },
  ]);

  expect(result).toMatchObject({
    status: "accepted",
    song: { id: "apple-original" },
  });
});

test("duplicate live-only results cannot override a unique studio catalog result", () => {
  const input = candidate({ artist: "Test Artist", title: "Test Song", album: null });
  const result = rankCatalogMatches(input.id, input, [
    { ...exactSong, id: "apple-studio", durationInMillis: 240_000 },
    { ...exactSong, id: "apple-live-one", albumName: "Live at Wembley", durationInMillis: 260_000 },
    { ...exactSong, id: "apple-live-two", albumName: "Best Live Performances", durationInMillis: 260_500 },
  ]);

  expect(result.status).toBe("review");
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

test("a catalog credit that adds or omits one collaborator remains alternatives-only", () => {
  const addedProject = candidate({ artist: "Juan Atkins", title: "Skyway", album: null });
  const addedProjectResult = rankCatalogMatches(addedProject.id, addedProject, [{
    id: "apple-skyway",
    name: "Skyway",
    artistName: "Infiniti & Juan Atkins",
    albumName: "The Remixes, Pt. 2",
  }]);
  expect(addedProjectResult).toMatchObject({
    status: "review",
    song: null,
  });
  expect(addedProjectResult.alternatives).toEqual([expect.objectContaining({ id: "apple-skyway" })]);

  const omittedCollaborator = candidate({
    artist: "Paulinho da Costa & Joe Pass",
    title: "Corcovado",
    album: null,
  });
  const omittedCollaboratorResult = rankCatalogMatches(omittedCollaborator.id, omittedCollaborator, [{
    id: "apple-corcovado-pass",
    name: "Corcovado",
    artistName: "Joe Pass",
    albumName: "Tudo Bem!",
  }]);
  expect(omittedCollaboratorResult).toMatchObject({
    status: "review",
    song: null,
  });
  expect(omittedCollaboratorResult.alternatives).toEqual([expect.objectContaining({ id: "apple-corcovado-pass" })]);
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
