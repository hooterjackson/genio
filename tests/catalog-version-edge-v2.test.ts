import { describe, expect, test } from "vitest";
import { rankCatalogMatches } from "../lib/matching.ts";
import {
  preflightManifestRevision,
  type PreflightManifestTrack,
  type PreflightReserveTrack,
} from "../server/manifest-preflight-v2.ts";
import type { TrackCandidateInput } from "../shared/types.ts";

function sparseCandidate(overrides: Partial<TrackCandidateInput> = {}): TrackCandidateInput {
  return {
    artist: "Shared Artist Name",
    title: "Shared Song Title",
    album: null,
    releaseYear: null,
    durationMs: null,
    isrc: null,
    musicbrainzId: null,
    versionLabel: null,
    evidence: [],
    ...overrides,
  };
}

function manifestTrack(overrides: Partial<PreflightManifestTrack> = {}): PreflightManifestTrack {
  return {
    position: 0,
    candidateId: "candidate-deleted",
    catalogId: "100",
    artist: "Artist",
    title: "Deleted Song",
    recordingFamilyId: "family-deleted",
    catalogIdentityId: "identity-deleted",
    alternates: [],
    ...overrides,
  };
}

function reserveTrack(overrides: Partial<PreflightReserveTrack> = {}): PreflightReserveTrack {
  return {
    ...manifestTrack({
      candidateId: "candidate-reserve",
      catalogId: "200",
      artist: "Reserve Artist",
      title: "Reserve Song",
      recordingFamilyId: "family-reserve",
      catalogIdentityId: "identity-reserve",
    }),
    evidenceEligible: true,
    hardConstraintsSatisfied: true,
    versionCompatible: true,
    qualified: true,
    ...overrides,
  };
}

describe("Pipeline V2 recording and catalog edge cases", () => {
  test("does not auto-accept same-name artist/title results that resolve to materially different recordings", () => {
    const result = rankCatalogMatches("candidate", sparseCandidate(), [
      {
        id: "artist-one-recording",
        name: "Shared Song Title",
        artistName: "Shared Artist Name",
        albumName: "First Catalogue",
        releaseDate: "2001-01-01",
        durationInMillis: 181_000,
      },
      {
        id: "artist-two-recording",
        name: "Shared Song Title",
        artistName: "Shared Artist Name",
        albumName: "Second Catalogue",
        releaseDate: "2001-01-01",
        durationInMillis: 267_000,
      },
    ]);

    expect(result.status).toBe("review");
    expect(result.basis).toMatch(/Multiple catalog recordings share this title|metadata requires review/u);
    expect([result.song?.id, ...result.alternatives.map((song) => song.id)]).toEqual(expect.arrayContaining([
      "artist-one-recording",
      "artist-two-recording",
    ]));
  });

  test("prefers the earliest supported canonical compatible issue without calling it historically original", () => {
    const result = rankCatalogMatches("candidate", sparseCandidate({
      artist: "Canonical Artist",
      title: "Canonical Track",
    }), [
      {
        id: "later-issue",
        name: "Canonical Track",
        artistName: "Canonical Artist",
        albumName: "Canonical Album",
        releaseDate: "2015-01-01",
        durationInMillis: 240_000,
      },
      {
        id: "earlier-supported-issue",
        name: "Canonical Track",
        artistName: "Canonical Artist",
        albumName: "Canonical Album",
        releaseDate: "1985-01-01",
        durationInMillis: 240_500,
      },
      {
        id: "earlier-compilation",
        name: "Canonical Track",
        artistName: "Canonical Artist",
        albumName: "Greatest Hits Collection",
        releaseDate: "1980-01-01",
        durationInMillis: 240_300,
      },
    ]);

    expect(result.status).toBe("accepted");
    expect(result.song?.id).toBe("earlier-supported-issue");
    expect(result.basis).toContain("preferred earliest supported compatible catalog issue");
    expect(result.basis).toContain("without asserting historical originality");
  });

  test("treats a deleted Apple ID as unavailable and substitutes a qualified reserve without failing", () => {
    const result = preflightManifestRevision(
      [manifestTrack()],
      // Apple omitted catalog ID 100 from the fresh ID lookup, which is the
      // observable deleted/unavailable contract. The qualified reserve exists.
      new Set(["200"]),
      [reserveTrack()],
    );

    expect(result.state).toBe("revision_required");
    expect(result.unavailableCatalogIds).toEqual(["100"]);
    expect(result.tracks).toEqual([expect.objectContaining({
      candidateId: "candidate-reserve",
      catalogId: "200",
      position: 0,
    })]);
    expect(result.reasonCodes).toEqual(["preflight_qualified_reserve_substituted"]);
  });

  test("returns a non-error partial revision when a deleted Apple ID has no compatible substitute", () => {
    const result = preflightManifestRevision([
      manifestTrack(),
      manifestTrack({
        position: 1,
        candidateId: "candidate-playable",
        catalogId: "300",
        recordingFamilyId: "family-playable",
        catalogIdentityId: "identity-playable",
      }),
    ], new Set(["300"]));

    expect(result.state).toBe("revision_required");
    expect(result.unavailableCatalogIds).toEqual(["100"]);
    expect(result.omittedCandidateIds).toEqual(["candidate-deleted"]);
    expect(result.tracks).toEqual([expect.objectContaining({ candidateId: "candidate-playable", position: 0 })]);
    expect(result.reasonCodes).toEqual(["preflight_catalog_identity_unavailable"]);
  });
});
