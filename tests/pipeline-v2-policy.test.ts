import { describe, expect, test } from "vitest";
import {
  adaptiveDiscoveryPlan,
  catalogContentRating,
  catalogRecordingVersionClass,
  catalogRecordingVersionSignature,
  classifyTrackScopeBindingEvidence,
  conservativeQualifiedYield,
  recordingFamilyKey,
  scopeBindingEligible,
  selectWithConstraintLadder,
  terminalPipelineOutcome,
  trackScopeBindingStrength,
  validatePipelineStageCounts,
} from "../server/pipeline-v2-policy.ts";

describe("Pipeline V2 production policy", () => {
  test("classifies exact citations per binding axis instead of per run intent", () => {
    expect(classifyTrackScopeBindingEvidence({
      bindingKind: "track_specific_source",
      scopeAxis: "factual_relationship",
      citationAttested: true,
    })).toEqual({ layer: "factual_claim", supportsRequestedRelationship: true });
    expect(classifyTrackScopeBindingEvidence({
      bindingKind: "track_specific_source",
      scopeAxis: "editorial_ranked",
      citationAttested: true,
    })).toEqual({ layer: "track_claim", supportsRequestedRelationship: true });
    expect(classifyTrackScopeBindingEvidence({
      bindingKind: "catalog_editorial_membership",
      scopeAxis: "genre",
      citationAttested: false,
    })).toEqual({ layer: "scope_binding", supportsRequestedRelationship: true });
    expect(classifyTrackScopeBindingEvidence({
      bindingKind: "track_specific_source",
      scopeAxis: "similarity",
      citationAttested: false,
    })).toEqual({ layer: "scope_binding", supportsRequestedRelationship: false });
  });

  test("shares one binding-strength boundary across matching and manifest lock", () => {
    expect(trackScopeBindingStrength(0.86)).toBe("strong");
    expect(trackScopeBindingStrength(0.8)).toBe("strong");
    expect(trackScopeBindingStrength(0.799)).toBe("medium");
    expect(trackScopeBindingStrength(Number.NaN)).toBe("medium");
  });

  test("exact-fill plans from the conservative post-filter yield and includes a qualified reserve", () => {
    expect(conservativeQualifiedYield(0, 0)).toBe(0.5);
    expect(conservativeQualifiedYield(0, 100)).toBe(0.2);
    const plan = adaptiveDiscoveryPlan({
      target: 50,
      qualified: 39,
      attempted: 50,
      observedQualified: 39,
    });
    expect(plan.deficit).toBe(11);
    expect(plan.qualifiedReserve).toBe(5);
    expect(plan.conservativeYield).toBeLessThan(39 / 50);
    expect(39 + Math.floor(plan.rawDiscoveryGoal * plan.conservativeYield)).toBeGreaterThanOrEqual(55);
  });

  test("zero deficit stops discovery even though a reserve is reported", () => {
    expect(adaptiveDiscoveryPlan({
      target: 25,
      qualified: 25,
      attempted: 40,
      observedQualified: 25,
    })).toMatchObject({ deficit: 0, qualifiedReserve: 5, rawDiscoveryGoal: 0 });
  });

  test("the deficit ledger is monotonic and rejects impossible stage inflation", () => {
    expect(validatePipelineStageCounts({
      discovered: 100,
      scopeEligible: 80,
      evidenceEligible: 70,
      versionCompatible: 65,
      playable: 60,
      canonicalUnique: 55,
      quotaEligible: 50,
      sequenced: 50,
      manifested: 50,
      published: 50,
    }).published).toBe(50);
    expect(() => validatePipelineStageCounts({ discovered: 10, scopeEligible: 11 })).toThrow(/monotonically/iu);
  });

  test("hard constraints never relax and soft constraints relax only in declared order", () => {
    const result = selectWithConstraintLadder({
      target: 3,
      constraints: [
        { id: "required_geography", kind: "hard", relaxationRank: null },
        { id: "album_concentration", kind: "soft", relaxationRank: 2 },
        { id: "sequencing", kind: "soft", relaxationRank: 1 },
      ],
      candidates: [
        { value: "one", violations: [] },
        { value: "two", violations: ["sequencing"] },
        { value: "three", violations: ["album_concentration"] },
        { value: "unsafe", violations: ["required_geography"] },
      ],
    });
    expect(result).toEqual({
      outcome: "complete",
      selected: ["one", "two", "three"],
      relaxedSoftConstraints: ["sequencing", "album_concentration"],
    });
    expect(result.selected).not.toContain("unsafe");
  });

  test("scope eligibility requires one strong or independent medium roots", () => {
    expect(scopeBindingEligible("curated", [{
      strength: "strong",
      provenanceRoot: "apple-editorial",
      layer: "scope_binding",
      supportsRequestedRelationship: true,
    }])).toBe(true);
    expect(scopeBindingEligible("curated", [
      { strength: "medium", provenanceRoot: "mirror-db", layer: "track_claim", supportsRequestedRelationship: true },
      { strength: "medium", provenanceRoot: "mirror-db", layer: "track_claim", supportsRequestedRelationship: true },
    ])).toBe(false);
    expect(scopeBindingEligible("curated", [
      { strength: "medium", provenanceRoot: "history-one", layer: "track_claim", supportsRequestedRelationship: true },
      { strength: "medium", provenanceRoot: "history-two", layer: "track_claim", supportsRequestedRelationship: true },
    ])).toBe(true);
    expect(scopeBindingEligible("exhaustive", [{
      strength: "strong",
      provenanceRoot: "editorial",
      layer: "track_claim",
      supportsRequestedRelationship: true,
    }])).toBe(false);
  });

  test("Apple editorial membership qualifies genre scope but cannot launder higher-order intent claims", () => {
    const appleGenreMembership = {
      strength: "strong" as const,
      provenanceRoot: "apple_music_editorial:pl.house",
      layer: "scope_binding" as const,
      supportsRequestedRelationship: true,
      bindingKind: "catalog_editorial_membership" as const,
      scopeAxis: "genre" as const,
    };
    expect(scopeBindingEligible("curated", [appleGenreMembership], ["genre_scene"])).toBe(true);
    expect(scopeBindingEligible("hybrid", [appleGenreMembership], ["genre_scene"])).toBe(true);
    expect(scopeBindingEligible("curated", [appleGenreMembership], ["similarity"])).toBe(false);
    expect(scopeBindingEligible("curated", [appleGenreMembership], ["mood_activity"])).toBe(false);
    expect(scopeBindingEligible("curated", [appleGenreMembership], ["theme"])).toBe(false);
    expect(scopeBindingEligible("curated", [appleGenreMembership], ["editorial_ranking"])).toBe(false);
    expect(scopeBindingEligible("curated", [appleGenreMembership], ["factual_relationship"])).toBe(false);
  });

  test("every evidentiary intent in a composite plan needs intent-specific independent support", () => {
    const appleGenreMembership = {
      strength: "strong" as const,
      provenanceRoot: "apple_music_editorial:pl.house",
      layer: "scope_binding" as const,
      supportsRequestedRelationship: true,
      bindingKind: "catalog_editorial_membership" as const,
      scopeAxis: "genre" as const,
    };
    const rankingClaim = {
      strength: "strong" as const,
      provenanceRoot: "independent-house-history",
      layer: "track_claim" as const,
      supportsRequestedRelationship: true,
      bindingKind: "track_specific_source" as const,
      scopeAxis: "editorial_ranked" as const,
    };
    expect(scopeBindingEligible(
      "curated",
      [appleGenreMembership],
      ["genre_scene", "editorial_ranking"],
    )).toBe(false);
    expect(scopeBindingEligible(
      "curated",
      [appleGenreMembership, rankingClaim],
      ["genre_scene", "editorial_ranking"],
    )).toBe(true);

    const mirroredRankingClaims = ["one", "two"].map(() => ({
      ...rankingClaim,
      strength: "medium" as const,
      provenanceRoot: "copied-ranking-database",
    }));
    expect(scopeBindingEligible(
      "curated",
      [appleGenreMembership, ...mirroredRankingClaims],
      ["genre_scene", "editorial_ranking"],
    )).toBe(false);
  });

  test("a factual credit cannot launder an independent editorial-ranking claim", () => {
    const factualCredit = {
      strength: "strong" as const,
      provenanceRoot: "session-liner-notes",
      layer: "factual_claim" as const,
      supportsRequestedRelationship: true,
      bindingKind: "track_specific_source" as const,
      scopeAxis: "factual_relationship" as const,
    };
    const rankingClaim = {
      strength: "strong" as const,
      provenanceRoot: "independent-music-history",
      layer: "track_claim" as const,
      supportsRequestedRelationship: true,
      bindingKind: "track_specific_source" as const,
      scopeAxis: "editorial_ranked" as const,
    };

    expect(scopeBindingEligible(
      "curated",
      [factualCredit],
      ["factual_relationship", "editorial_ranking"],
    )).toBe(false);
    expect(scopeBindingEligible(
      "curated",
      [factualCredit, rankingClaim],
      ["factual_relationship", "editorial_ranking"],
    )).toBe(true);
    expect(scopeBindingEligible(
      "curated",
      [factualCredit, {
        ...rankingClaim,
        strength: "medium",
        provenanceRoot: "mirrored-ranking-root",
      }, {
        ...rankingClaim,
        strength: "medium",
        provenanceRoot: "mirrored-ranking-root",
      }],
      ["factual_relationship", "editorial_ranking"],
    )).toBe(false);
  });

  test("recording-family precedence keeps catalog identity separate from playlist uniqueness", () => {
    expect(recordingFamilyKey({
      song: { id: "1", name: "Track", artistName: "Artist", albumName: "Album", isrc: "US-AAA-00-00001" },
    })).toBe("isrc:USAAA0000001");
    const metadataOne = recordingFamilyKey({
      song: { id: "2", name: "Track (feat. Guest)", artistName: "Artist", albumName: "Album", durationInMillis: 180_100 },
    });
    const metadataTwo = recordingFamilyKey({
      song: { id: "3", name: "Track", artistName: "Artist", albumName: "Remaster", durationInMillis: 180_900 },
    });
    expect(metadataOne).toBe(metadataTwo);
  });

  test("clean and explicit catalog recordings remain separate without losing structural version identity", () => {
    const clean = {
      id: "clean",
      name: "Track (Live)",
      artistName: "Artist",
      albumName: "Live Album",
      durationInMillis: 180_000,
      contentRating: "clean" as const,
    };
    const explicit = { ...clean, id: "explicit", contentRating: "explicit" as const };

    expect(catalogContentRating(clean)).toBe("clean");
    expect(catalogRecordingVersionClass(clean)).toBe("live");
    expect(catalogRecordingVersionSignature(clean)).toBe("live:clean");
    expect(catalogRecordingVersionSignature(explicit)).toBe("live:explicit");
    expect(recordingFamilyKey({ song: clean })).not.toBe(recordingFamilyKey({ song: explicit }));
  });

  test.each([
    ["clean", { contentRating: "clean" as const }],
    ["explicit", { contentRating: "explicit" as const }],
    ["live", { name: "Track (Live)" }],
    ["remix", { name: "Track (Club Remix)" }],
    ["radio edit", { name: "Track (Radio Edit)" }],
    ["cover", { name: "Track (Cover)" }],
  ] as const)("same ISRC does not merge a canonical recording with a conflicting %s version", (_label, override) => {
    const canonical = {
      id: "canonical",
      name: "Track",
      artistName: "Artist",
      albumName: "Album",
      isrc: "US-AAA-00-00001",
    };
    const derived = { ...canonical, id: "derived", ...override };

    expect(recordingFamilyKey({ song: canonical }))
      .not.toBe(recordingFamilyKey({ song: derived }));
  });

  test("same MusicBrainz recording mapping does not merge clean and explicit catalog identities", () => {
    const common = {
      id: "catalog-id",
      name: "Track",
      artistName: "Artist",
      albumName: "Album",
    };
    const musicBrainzRecordingId = "11111111-1111-4111-8111-111111111111";
    expect(recordingFamilyKey({
      song: { ...common, id: "clean", contentRating: "clean" },
      musicBrainzRecordingId,
    })).not.toBe(recordingFamilyKey({
      song: { ...common, id: "explicit", contentRating: "explicit" },
      musicBrainzRecordingId,
    }));
  });

  test("safe shortfalls are typed partials; local contract and integrity faults remain failures", () => {
    expect(terminalPipelineOutcome({ failureOrigin: "catalog", safeTrackCount: 18 })).toBe("partial_catalog_degraded");
    expect(terminalPipelineOutcome({ failureOrigin: "provider", safeTrackCount: 18, timedOut: true })).toBe("partial_timed_out");
    expect(terminalPipelineOutcome({ failureOrigin: "provider", safeTrackCount: 0 })).toBe("no_compatible_tracks");
    expect(terminalPipelineOutcome({ failureOrigin: "local_contract", safeTrackCount: 18 })).toBe("failed_system");
    expect(terminalPipelineOutcome({ failureOrigin: "integrity", safeTrackCount: 18 })).toBe("failed_integrity");
  });
});
