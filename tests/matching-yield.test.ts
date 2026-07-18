import { describe, expect, test } from "vitest";
import { rankCatalogMatches } from "../lib/matching.ts";
import type { CatalogSong, TrackCandidateInput } from "../shared/types.ts";

const candidate: TrackCandidateInput = {
  artist: "MC Marcinho",
  title: "Glamurosa",
  album: "Falando Com as Estrelas",
  releaseYear: null,
  durationMs: null,
  isrc: null,
  musicbrainzId: null,
  versionLabel: null,
  evidence: [],
};

function song(overrides: Partial<CatalogSong>): CatalogSong {
  return {
    id: "apple-1",
    name: "Glamurosa",
    artistName: "MC Marcinho",
    albumName: "Glamurosa - Single",
    durationInMillis: 246_000,
    isrc: "BRABC0300001",
    ...overrides,
  };
}

describe("precision-preserving yield for sparse curated catalog candidates", () => {
  test("accepts an exact recording family across Apple reissues when the cited album is absent", () => {
    const result = rankCatalogMatches("candidate", candidate, [
      song({ id: "apple-single", albumName: "Glamurosa - Single" }),
      song({ id: "apple-compilation", albumName: "Funk Brasil", durationInMillis: 247_200 }),
    ]);

    expect(result).toMatchObject({
      status: "accepted",
      song: { id: "apple-single" },
    });
    expect(result.basis).toContain("corroborated recording family");
  });

  test("keeps one uncorroborated exact result on a different album in review", () => {
    const result = rankCatalogMatches("candidate", candidate, [
      song({ id: "apple-other-album", albumName: "Another Album" }),
    ]);

    expect(result).toMatchObject({
      status: "review",
      song: { id: "apple-other-album" },
    });
  });

  test("accepts the sole non-derived exact result when the other containers are live or remix collections", () => {
    const result = rankCatalogMatches("candidate", candidate, [
      song({ id: "apple-studio", albumName: "Glamurosa - Single" }),
      song({ id: "apple-live-container", albumName: "MC Marcinho ao Vivo", isrc: "BRABC2200002", durationInMillis: 284_000 }),
      song({ id: "apple-remix-container", albumName: "Glamurosa Remixes", isrc: "BRABC2200003", durationInMillis: 312_000 }),
    ]);

    expect(result).toMatchObject({
      status: "accepted",
      song: { id: "apple-studio" },
    });
  });

  test("does not auto-accept two materially different studio recordings", () => {
    const result = rankCatalogMatches("candidate", candidate, [
      song({ id: "apple-original", albumName: "Original Release", isrc: "BRABC0300001", durationInMillis: 246_000 }),
      song({ id: "apple-rerecording", albumName: "New Recording", isrc: "BRABC2300099", durationInMillis: 301_000 }),
    ]);

    expect(result.status).toBe("review");
  });

  test("does not auto-accept an explicit live or remix title for an unqualified candidate", () => {
    const result = rankCatalogMatches("candidate", { ...candidate, album: null }, [
      song({ id: "apple-live", name: "Glamurosa (Ao Vivo)", albumName: "Ao Vivo", isrc: "BRABC2200002" }),
      song({ id: "apple-remix", name: "Glamurosa (Remix)", albumName: "Remixes", isrc: "BRABC2200003" }),
    ]);

    expect(result.status).not.toBe("accepted");
  });
});
