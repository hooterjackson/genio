import { describe, expect, test } from "vitest";
import {
  manifestRevisionContentHash,
  preflightManifestRevision,
  type PreflightManifestTrack,
  type PreflightReserveTrack,
} from "../server/manifest-preflight-v2.ts";

function track(overrides: Partial<PreflightManifestTrack> = {}): PreflightManifestTrack {
  return {
    position: 0,
    candidateId: "candidate-1",
    catalogId: "101",
    artist: "Artist",
    title: "Song",
    recordingFamilyId: "family-1",
    catalogIdentityId: "identity-101",
    alternates: [],
    ...overrides,
  };
}

function reserve(overrides: Partial<PreflightReserveTrack> = {}): PreflightReserveTrack {
  return {
    ...track({
      position: 0,
      candidateId: "reserve-1",
      catalogId: "501",
      artist: "Reserve Artist",
      title: "Reserve Song",
      recordingFamilyId: "family-reserve-1",
      catalogIdentityId: "identity-501",
    }),
    evidenceEligible: true,
    hardConstraintsSatisfied: true,
    versionCompatible: true,
    qualified: true,
    ...overrides,
  };
}

describe("Pipeline V2 manifest preflight", () => {
  test("leaves a playable locked revision unchanged", () => {
    const tracks = [track()];
    const result = preflightManifestRevision(tracks, new Set(["101"]));

    expect(result).toMatchObject({
      state: "unchanged",
      substituted: [],
      omittedCandidateIds: [],
      reasonCodes: [],
    });
    expect(result.tracks).toEqual(tracks);
    expect(result.contentHash).toBe(manifestRevisionContentHash(tracks));
  });

  test("uses the highest-ranked compatible identity from the same recording family", () => {
    const result = preflightManifestRevision([
      track({
        alternates: [
          { id: "wrong-family", catalogId: "202", recordingFamilyId: "family-2", identityConfidence: 1, isPreferred: true, compatible: true },
          { id: "weak", catalogId: "303", recordingFamilyId: "family-1", identityConfidence: 0.7, isPreferred: false, compatible: true },
          { id: "preferred", catalogId: "404", recordingFamilyId: "family-1", identityConfidence: 0.9, isPreferred: true, compatible: true },
        ],
      }),
    ], new Set(["202", "303", "404"]));

    expect(result.state).toBe("revision_required");
    expect(result.tracks[0]).toMatchObject({ catalogId: "404", catalogIdentityId: "preferred" });
    expect(result.substituted).toEqual([{ candidateId: "candidate-1", fromCatalogId: "101", toCatalogId: "404" }]);
    expect(result.reasonCodes).toEqual(["preflight_catalog_identity_substituted"]);
  });

  test("omits an unavailable identity and requires a new immutable revision", () => {
    const result = preflightManifestRevision([
      track(),
      track({ position: 1, candidateId: "candidate-2", catalogId: "202", recordingFamilyId: "family-2" }),
    ], new Set(["202"]));

    expect(result.state).toBe("revision_required");
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]).toMatchObject({ candidateId: "candidate-2", position: 0 });
    expect(result.omittedCandidateIds).toEqual(["candidate-1"]);
    expect(result.reasonCodes).toEqual(["preflight_catalog_identity_unavailable"]);
  });

  test("returns a non-error no-compatible outcome when storefront preflight removes everything", () => {
    const result = preflightManifestRevision([track()], new Set());

    expect(result.state).toBe("no_compatible_tracks");
    expect(result.tracks).toEqual([]);
    expect(result.omittedCandidateIds).toEqual(["candidate-1"]);
    expect(result.contentHash).toBe(manifestRevisionContentHash([]));
  });

  test("never introduces duplicate Apple IDs while substituting", () => {
    const sharedAlternate = {
      id: "identity-303",
      catalogId: "303",
      recordingFamilyId: null,
      identityConfidence: 0.9,
      isPreferred: true,
      compatible: true,
    };
    const result = preflightManifestRevision([
      track({ recordingFamilyId: null, alternates: [sharedAlternate] }),
      track({ position: 1, candidateId: "candidate-2", catalogId: "202", recordingFamilyId: null, alternates: [sharedAlternate] }),
    ], new Set(["303"]));

    expect(result.tracks).toHaveLength(1);
    expect(result.substituted).toHaveLength(1);
    expect(result.omittedCandidateIds).toHaveLength(1);
  });

  test("replaces an unavailable selection with a different qualified reserve recording in place", () => {
    const result = preflightManifestRevision([
      track(),
      track({ position: 1, candidateId: "candidate-2", catalogId: "202", recordingFamilyId: "family-2" }),
    ], new Set(["202", "501"]), [reserve()]);

    expect(result.state).toBe("revision_required");
    expect(result.tracks).toEqual([
      expect.objectContaining({ position: 0, candidateId: "reserve-1", catalogId: "501", recordingFamilyId: "family-reserve-1" }),
      expect.objectContaining({ position: 1, candidateId: "candidate-2", catalogId: "202", recordingFamilyId: "family-2" }),
    ]);
    expect(result.substituted).toEqual([{
      candidateId: "candidate-1",
      replacementCandidateId: "reserve-1",
      fromCatalogId: "101",
      toCatalogId: "501",
    }]);
    expect(result.omittedCandidateIds).toEqual([]);
    expect(result.reserveTracks).toEqual([]);
    expect(result.reasonCodes).toEqual(["preflight_qualified_reserve_substituted"]);
  });

  test("may use a compatible alternate identity for a qualified reserve recording", () => {
    const result = preflightManifestRevision([track()], new Set(["502"]), [reserve({
      alternates: [{
        id: "identity-502",
        catalogId: "502",
        recordingFamilyId: "family-reserve-1",
        identityConfidence: 0.95,
        isPreferred: true,
        compatible: true,
      }],
    })]);

    expect(result.tracks).toEqual([expect.objectContaining({
      candidateId: "reserve-1",
      catalogId: "502",
      catalogIdentityId: "identity-502",
    })]);
  });

  test.each([
    ["same selected recording family", { recordingFamilyId: "family-1" }],
    ["missing evidence", { evidenceEligible: false }],
    ["failed hard constraint", { hardConstraintsSatisfied: false }],
    ["incompatible version", { versionCompatible: false }],
    ["not qualified", { qualified: false }],
  ] as const)("does not substitute a reserve with %s", (_label, overrides) => {
    const result = preflightManifestRevision([track()], new Set(["501"]), [reserve(overrides)]);

    expect(result.state).toBe("no_compatible_tracks");
    expect(result.tracks).toEqual([]);
    expect(result.substituted).toEqual([]);
    expect(result.omittedCandidateIds).toEqual(["candidate-1"]);
    expect(result.reserveTracks).toHaveLength(1);
  });

  test("uses at most one reserve recording from each recording family", () => {
    const result = preflightManifestRevision([
      track(),
      track({ position: 1, candidateId: "candidate-2", catalogId: "202", recordingFamilyId: "family-2" }),
    ], new Set(["501", "502"]), [
      reserve(),
      reserve({ position: 1, candidateId: "reserve-2", catalogId: "502", catalogIdentityId: "identity-502" }),
    ]);

    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]).toMatchObject({ candidateId: "reserve-1" });
    expect(result.omittedCandidateIds).toEqual(["candidate-2"]);
  });
});
