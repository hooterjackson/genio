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

  test("does not treat an arbitrary parenthetical suffix as a feature-credit variant", () => {
    const sparse = { ...candidate, artist: "Kyan & MU540", title: "Fantástico Mundo da Oakley", album: null };
    const result = rankCatalogMatches("candidate", sparse, [
      song({
        id: "apple-bonus",
        name: "Fantástico Mundo da Oakley (Bonus Track)",
        artistName: "Kyan & MU540",
        albumName: "UM Quebrada Inteligente",
        isrc: "BKRQM2300013",
      }),
    ]);

    expect(result.status).toBe("review");
  });

  test("accepts Apple's featured-artist parenthetical when exact artist and recording family agree", () => {
    const sparse = { ...candidate, artist: "Bandmanrill", title: "Bouncin’", album: null };
    const result = rankCatalogMatches("candidate", sparse, [
      song({
        id: "apple-album",
        name: "BOUNCIN’ (feat. NLE Choppa)",
        artistName: "Bandmanrill",
        albumName: "Club Godfather",
        isrc: "USWB12206466",
        durationInMillis: 162_000,
      }),
      song({
        id: "apple-compilation",
        name: "BOUNCIN' (feat. NLE Choppa)",
        artistName: "Bandmanrill",
        albumName: "Rap Rhymes",
        isrc: "USWB12206466",
        durationInMillis: 162_000,
      }),
      song({
        id: "apple-sped-up",
        name: "BOUNCIN' (feat. NLE Choppa) [Sped Up]",
        artistName: "Bandmanrill",
        albumName: "Club Godfather - Sped Up",
        isrc: "USWB12301281",
        durationInMillis: 152_907,
      }),
    ]);

    expect(result).toMatchObject({
      status: "accepted",
      song: { id: "apple-album" },
    });
    expect(result.basis).toContain("compatible sparse catalog credit");
  });

  test("keeps a singleton featured-artist version in review without recording-family corroboration", () => {
    const sparse = { ...candidate, artist: "Bandmanrill", title: "Bouncin’", album: null };
    const result = rankCatalogMatches("candidate", sparse, [
      song({
        id: "apple-feature-singleton",
        name: "BOUNCIN’ (feat. NLE Choppa)",
        artistName: "Bandmanrill",
        albumName: "Club Godfather",
        isrc: "USWB12206466",
        durationInMillis: 162_000,
      }),
    ]);

    expect(result.status).toBe("review");
  });

  test("does not erase a feature credit explicitly required by the candidate", () => {
    const sparse = {
      ...candidate,
      artist: "Bandmanrill",
      title: "BOUNCIN’ (feat. NLE Choppa)",
      album: null,
    };
    const result = rankCatalogMatches("candidate", sparse, [
      song({
        id: "apple-uncredited",
        name: "BOUNCIN’",
        artistName: "Bandmanrill",
        albumName: "Club Godfather",
      }),
    ]);

    expect(result.status).toBe("review");
  });

  test("selects the canonical feature over sped-up and slowed-down derivatives", () => {
    const sparse = { ...candidate, artist: "Bandmanrill", title: "Piano", album: null };
    const result = rankCatalogMatches("candidate", sparse, [
      song({
        id: "apple-original",
        name: "PIANO (feat. Lay Bankz)",
        artistName: "Bandmanrill",
        albumName: "Club Godfather",
        isrc: "USWB12206471",
        durationInMillis: 156_800,
      }),
      song({
        id: "apple-original-reissue",
        name: "PIANO (feat. Lay Bankz)",
        artistName: "Bandmanrill",
        albumName: "Rap Collection",
        isrc: "USWB12206471",
        durationInMillis: 156_800,
      }),
      song({
        id: "apple-sped-up",
        name: "PIANO (feat. Lay Bankz) [Sped Up]",
        artistName: "Bandmanrill",
        albumName: "Club Godfather - Sped Up",
        isrc: "USWB12301297",
        durationInMillis: 147_998,
      }),
      song({
        id: "apple-slowed",
        name: "PIANO (feat. Lay Bankz) [Slowed Down]",
        artistName: "Bandmanrill",
        albumName: "Club Godfather - Slowed Down",
        isrc: "USWB12301298",
        durationInMillis: 186_468,
      }),
    ]);

    expect(result).toMatchObject({
      status: "accepted",
      song: { id: "apple-original" },
    });
  });

  test("accepts an exact-title Apple credit that adds documented collaborators", () => {
    const sparse = { ...candidate, artist: "MU540", title: "XRC no Chão", album: null };
    const result = rankCatalogMatches("candidate", sparse, [
      song({
        id: "apple-collaboration",
        name: "XRC no Chão",
        artistName: "MU540 & MC GW",
        albumName: "4x4",
        isrc: "USUYG1583942",
        durationInMillis: 239_625,
      }),
      song({
        id: "apple-collaboration-reissue",
        name: "XRC no Chão",
        artistName: "MU540 & MC GW",
        albumName: "4x4 Collection",
        isrc: "USUYG1583942",
        durationInMillis: 239_625,
      }),
      song({
        id: "wrong-recording",
        name: "Mão No Joelho Xrc No Chão",
        artistName: "DJ Jeeh FDC, Mc Delux, Meno Saaint & Mc LcKaiique",
        albumName: "Ritmos",
        isrc: "BC3PG2203437",
        durationInMillis: 230_769,
      }),
    ]);

    expect(result).toMatchObject({
      status: "accepted",
      song: { id: "apple-collaboration" },
    });
    expect(result.basis).toContain("catalog collaborator credit contains cited artist");
  });

  test("keeps a singleton expanded credit and derived cover container in review", () => {
    const sparse = { ...candidate, artist: "MU540", title: "XRC no Chão", album: null };
    const singleton = rankCatalogMatches("candidate-singleton", sparse, [
      song({
        id: "apple-singleton-credit",
        name: "XRC no Chão",
        artistName: "MU540 & MC GW",
        albumName: "4x4",
      }),
    ]);
    const cover = rankCatalogMatches("candidate-cover", sparse, [
      song({
        id: "apple-cover-credit",
        name: "XRC no Chão",
        artistName: "MU540 & Cover Project",
        albumName: "Brazilian Funk Covers",
      }),
      song({
        id: "apple-cover-credit-two",
        name: "XRC no Chão",
        artistName: "MU540 & Cover Project",
        albumName: "The Cover Sessions",
      }),
    ]);

    expect(singleton.status).toBe("review");
    expect(cover.status).toBe("review");
  });

  test("accepts role-prefixed collaborators in a different catalog order", () => {
    const sparse = {
      ...candidate,
      artist: "L da Vinte & Gury",
      title: "Parado no Bailão",
      album: null,
    };
    const result = rankCatalogMatches("candidate", sparse, [
      song({
        id: "apple-role-variant",
        name: "Parado No Bailão",
        artistName: "MC Gury & MC L da Vinte",
        albumName: "Parado no Bailão - Single",
        isrc: "BRABC1800101",
        durationInMillis: 171_000,
      }),
    ]);

    expect(result).toMatchObject({
      status: "accepted",
      song: { id: "apple-role-variant" },
    });
    expect(result.basis).toContain("catalog role-prefixed collaborator set");
  });

  test("does not strip a candidate's DJ or MC stage-name prefix", () => {
    const djResult = rankCatalogMatches("candidate-dj", {
      ...candidate,
      artist: "DJ Shadow & Cut Chemist",
      title: "Product Placement",
      album: null,
    }, [
      song({
        id: "apple-shadow",
        name: "Product Placement",
        artistName: "Shadow & Cut Chemist",
        albumName: "Product Placement",
      }),
    ]);
    const mcResult = rankCatalogMatches("candidate-mc", {
      ...candidate,
      artist: "MC Hammer",
      title: "U Can't Touch This",
      album: null,
    }, [
      song({
        id: "apple-hammer-guest",
        name: "U Can't Touch This",
        artistName: "Hammer & Guest",
        albumName: "Unrelated",
      }),
    ]);

    expect(djResult.status).not.toBe("accepted");
    expect(mcResult.status).not.toBe("accepted");
  });

  test("does not accept a same-title recording when the cited artist is absent", () => {
    const sparse = { ...candidate, artist: "VHOOR", title: "Senta no Baile", album: null };
    const result = rankCatalogMatches("candidate", sparse, [
      song({
        id: "wrong-artist",
        name: "Senta no Baile",
        artistName: "DJ Broothex",
        albumName: "Senta no Baile - Single",
        isrc: "US7VG2608262",
      }),
      song({
        id: "right-artist-wrong-song",
        name: "Mandelão",
        artistName: "VHOOR",
        albumName: "Baile & Drip",
        isrc: "USYBL2001861",
      }),
    ]);

    expect(result.status).not.toBe("accepted");
  });
});
