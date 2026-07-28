import { describe, expect, test } from "vitest";
import type { ManifestRevisionTrack } from "../shared/types.ts";
import {
  CanonicalPublicationRevalidationRequiredErrorV1,
  assertCanonicalManifestRevisionV1,
  revalidateCanonicalManifestRevisionV1,
  type PersistedCanonicalQualificationV1,
} from "../server/canonical-publication-revalidation-v1.ts";
import { canonicalContractExecutionPolicyV1 } from "../server/canonical-contract-runtime-v1.ts";
import {
  compilePlaylistContractRevisionV1,
  type PlaylistContractEvidenceObligationV1,
} from "../server/playlist-contract-v1.ts";
import {
  createRunSpecV3,
  resolveRunSpecV3,
  type SelectionPlanV3,
} from "../server/selection-plan-v3.ts";
import {
  createCentralQualityCriterionObservationV3,
  createHostedWebEvidenceSnapshotV3,
  publicTrackScopeAttestationV3,
  type CentralQualityCriterionObservationV3,
  type EvidenceBindingReferenceV3,
} from "../server/pipeline-v3-retrieval.ts";

const ACQUIRED_AT = new Date(Date.now() - 60_000).toISOString();
const FRESH_UNTIL = new Date(
  Date.parse(ACQUIRED_AT) + 29 * 24 * 60 * 60_000,
).toISOString();

function canonicalPlan(
  target: number,
  patch: Partial<SelectionPlanV3> = {},
  evidence?: PlaylistContractEvidenceObligationV1,
): SelectionPlanV3 {
  const contract = compilePlaylistContractRevisionV1({
    contractId: `contract:publication-revalidation:${target}`,
    rawPrompt: `${target} disco tracks`,
    requestedTrackCount: target,
    locale: "en-US",
    storefront: "us",
    clauses: [{
      id: "genre:disco",
      kind: "membership",
      scope: "track",
      hardness: "hard",
      axis: "genre",
      operator: "require",
      values: ["disco"],
      source: { provenance: "prompt", text: "disco" },
      ...(evidence ? { evidence } : {}),
    }],
    trackPredicate: { op: "clause", clauseId: "genre:disco" },
  });
  const base = resolveRunSpecV3(createRunSpecV3({
    prompt: `${target} disco tracks`,
    requestedTrackCount: target,
    storefront: "us",
  }), []);
  return {
    ...base,
    canonicalContractPolicy: canonicalContractExecutionPolicyV1(contract),
    diversityGoals: {
      minimumDistinctArtists: null,
      minimumDistinctAlbums: null,
      minimumDistinctEras: null,
      minimumDistinctScenes: null,
      minimumDistinctGeographies: null,
      maximumTracksPerArtist: null,
      maximumTracksPerAlbum: null,
    },
    softGoalRelaxationOrder: [],
    confirmed: true,
    ...patch,
  };
}

function manifestTrack(index: number): ManifestRevisionTrack {
  return {
    position: index,
    candidateId: `candidate-${index}`,
    recordingFamilyId: `family-id-${index}`,
    catalogIdentityId: `identity-${index}`,
    catalogId: `apple-${index}`,
    artist: `Artist ${index}`,
    title: `Track ${index}`,
  };
}

function evidenceBinding(index: number): EvidenceBindingReferenceV3 {
  const sourceUrl = `https://example.test/disco/${index}`;
  const excerpt =
    `Artist ${index} — Track ${index} is documented as disco. [source]`;
  const citationStartIndex = excerpt.indexOf("[source]");
  const hostedEvidenceSnapshot = createHostedWebEvidenceSnapshotV3({
    sourceUrl,
    excerpt,
    responseId: `resp_${index}`,
    outputItemId: `msg_${index}`,
    contentIndex: 0,
    citationStartIndex,
    citationEndIndex: citationStartIndex + "[source]".length,
    excerptStartIndex: 0,
    excerptEndIndex: excerpt.length,
    acquiredAt: ACQUIRED_AT,
    storefront: "us",
    freshnessExpiresAt: FRESH_UNTIL,
    predicateIds: ["genre:disco"],
  });
  return {
    id: `evidence-${index}`,
    url: sourceUrl,
    provenanceRoot: "example.test",
    strength: 0.95,
    sourceRank: index + 1,
    kind: "hosted_web_track",
    predicateIds: ["genre:disco"],
    governance: {
      policyVersion: "evidence-source-governance-v3",
      useScope: "run_local",
      approvalState: "approved",
      accessMethod: "hosted_web_search",
      licenseState: "citation_only",
      licenseVersion: "test-citation-v1",
      termsVersion: "test-terms-v1",
      attribution: "Canonical publication test source",
      cachePolicy: "excerpt_only",
      retentionPolicy: "ninety_days",
      freshnessPolicy: "revalidate_30d",
      freshnessExpiresAt: hostedEvidenceSnapshot.freshnessExpiresAt,
      acquiredAt: hostedEvidenceSnapshot.acquiredAt,
      revokedAt: hostedEvidenceSnapshot.revokedAt,
      sourceHash: hostedEvidenceSnapshot.snapshotHash,
      sourceRevision: hostedEvidenceSnapshot.snapshotHash,
    },
    hostedEvidenceSnapshot,
    eligibilityAttestation: publicTrackScopeAttestationV3(
      sourceUrl,
      hostedEvidenceSnapshot,
    ),
  };
}

function qualification(
  index: number,
  patch: {
    artist?: string;
    album?: string | null;
    rankingSignals?: Record<string, number>;
    playlistOptimizationSignals?: Record<string, unknown>;
    centralQualityCriterionObservations?:
      readonly CentralQualityCriterionObservationV3[];
    catalog?: Record<string, unknown>;
    evidenceGrade?: string;
  } = {},
): PersistedCanonicalQualificationV1 {
  const binding = {
    ...evidenceBinding(index),
    kind: patch.evidenceGrade === "primary_source"
      ? "primary_source"
      : patch.evidenceGrade === "independent_secondary_source"
        ? "independent_secondary_source"
        : "hosted_web_track",
  };
  return {
    candidateId: `candidate-${index}`,
    artist: patch.artist ?? `Artist ${index}`,
    title: `Track ${index}`,
    album: patch.album === undefined ? `Album ${index}` : patch.album,
    recordingFamilyKey: `family-key-${index}`,
    decision: "qualified",
    revokedAt: null,
    predicateResults: {
      canonicalContract: {
        assessments: {
          "genre:disco": {
            status: "pass",
            evidenceGrade: patch.evidenceGrade ?? "track_specific_editorial_assertion",
            evidenceIds: [`evidence-${index}`],
          },
        },
      },
      scope: { fit: 0.95 },
    },
    evidenceRecordIds: [`evidence-${index}`],
    evidenceBindings: [binding],
    qualityResult: {
      verdict: "pass",
      evidenceStrength: 0.95,
      independentProvenanceRoots: 2,
      rankingSignals: patch.rankingSignals ?? {
        relevance: 1 - index / 100,
        central_quality: 0.9,
      },
      sourceRank: index + 1,
      ...(patch.centralQualityCriterionObservations ? {
        centralQualityCriterionObservations:
          patch.centralQualityCriterionObservations,
      } : {}),
      hostedEvidenceSnapshots: [binding.hostedEvidenceSnapshot],
      provenance: {
        dependencyIds: [`dependency-${index}`],
        provenanceRoots: [`source-${index}.example.test`],
        cacheOrigin: "live",
        sourceFreshUntil: null,
      },
      playlistOptimizationSignals: patch.playlistOptimizationSignals ?? {
        familiarityScore: 0.5,
        discoveryScore: 0.5,
        eraKeys: ["2020s"],
        sceneKeys: ["disco"],
        geographyKeys: ["global"],
        chronologyPosition: 2020 + index,
      },
    },
    catalogResult: {
      verdict: "pass",
      storefrontPlayable: true,
      appleSongId: `apple-${index}`,
      recordingFamilyKey: `family-key-${index}`,
      releaseYear: 2020 + index,
      compatibleReleaseYears: [2020 + index],
      genreNames: ["Disco"],
      versionCompatible: true,
      versionConfidence: 0.99,
      catalogConfidence: 0.99,
      ...patch.catalog,
    },
  };
}

function centralQualityObservations(
  index: number,
  policy: NonNullable<SelectionPlanV3["playlistQualityPolicy"]>,
  verdict: "pass" | "fail" | "unknown",
): CentralQualityCriterionObservationV3[] {
  return policy.criteria.map((criterion) => (
    createCentralQualityCriterionObservationV3({
      policy,
      criterion,
      verdict,
      sourceKind: "independent_curator_review",
      sourceId: `publication-review-${index}`,
      artist: `Artist ${index}`,
      title: `Track ${index}`,
      album: `Album ${index}`,
      catalogIdentity: {
        appleSongId: `apple-${index}`,
        recordingFamilyKey: `family-key-${index}`,
      },
    })
  ));
}

describe("canonical repaired-manifest publication revalidation", () => {
  test("reconstructs persisted optimization signals and accepts the unchanged exact set", () => {
    const result = revalidateCanonicalManifestRevisionV1({
      plan: canonicalPlan(2),
      manifestTracks: [manifestTrack(0), manifestTrack(1)],
      qualifications: [qualification(0), qualification(1)],
    });

    expect(result).toMatchObject({ valid: true, reasonCodes: [] });
    expect(result.tracks[0]?.playlistOptimizationSignals).toMatchObject({
      eraKeys: ["2020s"],
      sceneKeys: ["disco"],
      chronologyPosition: 2020,
    });
  });

  test("rejects a reserve repair that restores count but breaks a canonical quota", () => {
    const plan = canonicalPlan(2, {
      playlistQuotaRules: [{
        id: "quota:disco",
        clauseId: "quota:disco",
        axis: "genre",
        values: ["disco"],
        minimumCount: 2,
        maximumCount: null,
        minimumRatio: null,
        maximumRatio: null,
        evidenceGrade: "authoritative_structured_metadata",
      }],
    });
    const result = revalidateCanonicalManifestRevisionV1({
      plan,
      manifestTracks: [manifestTrack(0), manifestTrack(1)],
      qualifications: [
        qualification(0),
        qualification(1, { catalog: { genreNames: ["Latin Pop"] } }),
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.reasonCodes).toContain("canonical_quota_failed:quota:disco");
  });

  test("rejects exact-count repair when the central quality floor is missed", () => {
    const plan = canonicalPlan(2, {
      playlistQualityPolicy: {
        policyVersion: "canonical_central_quality_v1",
        clauseIds: ["quality:smooth"],
        criteria: ["smooth"],
        minimumPassRatio: 0.8,
        maximumUnknownRatio: 0.2,
        zeroKnownFailures: true,
        signalDimension: "central_quality",
        passThreshold: 0.75,
        failThreshold: 0.4,
        signalSemantics: "ranking_only_not_factual_evidence",
      },
    });
    const result = revalidateCanonicalManifestRevisionV1({
      plan,
      manifestTracks: [manifestTrack(0), manifestTrack(1)],
      qualifications: [
        qualification(0, {
          centralQualityCriterionObservations: centralQualityObservations(
            0,
            plan.playlistQualityPolicy!,
            "pass",
          ),
          rankingSignals: { relevance: 0.9, central_quality: 1 },
        }),
        qualification(1, {
          centralQualityCriterionObservations: centralQualityObservations(
            1,
            plan.playlistQualityPolicy!,
            "fail",
          ),
          rankingSignals: { relevance: 0.9, central_quality: 1 },
        }),
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.reasonCodes).toContain("canonical_central_quality_failed");
  });

  test("rejects central-quality proof replayed from another album and catalog family", () => {
    const plan = canonicalPlan(1, {
      playlistQualityPolicy: {
        policyVersion: "canonical_central_quality_v1",
        clauseIds: ["quality:smooth"],
        criteria: ["smooth"],
        minimumPassRatio: 0.8,
        maximumUnknownRatio: 0.2,
        zeroKnownFailures: true,
        signalDimension: "central_quality",
        passThreshold: 0.75,
        failThreshold: 0.4,
        signalSemantics: "ranking_only_not_factual_evidence",
      },
    });
    const replayed = plan.playlistQualityPolicy!.criteria.map((criterion) => (
      createCentralQualityCriterionObservationV3({
        policy: plan.playlistQualityPolicy!,
        criterion,
        verdict: "pass",
        sourceKind: "independent_curator_review",
        sourceId: "review-for-other-catalog-recording",
        artist: "Same Artist",
        title: "Track 0",
        album: "Other Album",
        catalogIdentity: {
          appleSongId: "apple-other",
          recordingFamilyKey: "family-key-other",
        },
      })
    ));
    const result = revalidateCanonicalManifestRevisionV1({
      plan,
      manifestTracks: [manifestTrack(0)],
      qualifications: [qualification(0, {
        artist: "Same Artist",
        album: "Selected Album",
        centralQualityCriterionObservations: replayed,
        rankingSignals: { relevance: 1, central_quality: 1 },
      })],
    });

    expect(result.valid).toBe(false);
    expect(result.reasonCodes).toContain("canonical_central_quality_failed");
  });

  test("rejects a repaired set that violates diversity or deterministic sequencing", () => {
    const plan = canonicalPlan(2, {
      diversityGoals: {
        minimumDistinctArtists: 2,
        minimumDistinctAlbums: 2,
        minimumDistinctEras: null,
        minimumDistinctScenes: null,
        minimumDistinctGeographies: null,
        maximumTracksPerArtist: 1,
        maximumTracksPerAlbum: 1,
      },
      orderingPolicy: {
        mode: "smooth",
        goals: ["avoid adjacent artist repetition"],
        avoidAdjacentSameArtist: true,
        avoidAdjacentSameAlbum: true,
      },
    });
    const result = revalidateCanonicalManifestRevisionV1({
      plan,
      manifestTracks: [manifestTrack(0), manifestTrack(1)],
      qualifications: [
        qualification(0, { artist: "Same Artist", album: "Same Album" }),
        qualification(1, { artist: "Same Artist", album: "Same Album" }),
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      expect.stringMatching(/^canonical_playlist_optimization_failed:/u),
      "canonical_sequence_adjacent_artist",
    ]));
  });

  test.each([
    "fixed_release_container",
    "artist_catalogue",
    "factual_frontier",
  ] as const)("rejects a %s repair that violates immutable diversity", (scopeKind) => {
    const plan = canonicalPlan(2, {
      scopeKind,
      diversityGoals: {
        minimumDistinctArtists: 2,
        minimumDistinctAlbums: null,
        minimumDistinctEras: null,
        minimumDistinctScenes: null,
        minimumDistinctGeographies: null,
        maximumTracksPerArtist: 1,
        maximumTracksPerAlbum: null,
      },
    });
    const result = revalidateCanonicalManifestRevisionV1({
      plan,
      manifestTracks: [manifestTrack(0), manifestTrack(1)],
      qualifications: [
        qualification(0, { artist: "Same Artist" }),
        qualification(1, { artist: "Same Artist" }),
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      expect.stringMatching(/^canonical_playlist_optimization_failed:/u),
    ]));
  });

  test("rejects a fixed-container manifest whose order differs from immutable source rank", () => {
    const plan = canonicalPlan(2, {
      scopeKind: "fixed_release_container",
      diversityGoals: {
        minimumDistinctArtists: 2,
        minimumDistinctAlbums: null,
        minimumDistinctEras: null,
        minimumDistinctScenes: null,
        minimumDistinctGeographies: null,
        maximumTracksPerArtist: 1,
        maximumTracksPerAlbum: null,
      },
      orderingPolicy: {
        mode: "source_order",
        goals: ["keep the source order"],
        avoidAdjacentSameArtist: false,
        avoidAdjacentSameAlbum: false,
      },
    });
    const result = revalidateCanonicalManifestRevisionV1({
      plan,
      manifestTracks: [
        { ...manifestTrack(1), position: 0 },
        { ...manifestTrack(0), position: 1 },
      ],
      qualifications: [qualification(0), qualification(1)],
    });

    expect(result.valid).toBe(false);
    expect(result.reasonCodes).toContain("canonical_sequence_optimizer_mismatch");
  });

  test("fails closed on a missing projection and throws a typed decision error", () => {
    expect(() => assertCanonicalManifestRevisionV1({
      plan: canonicalPlan(1),
      manifestTracks: [manifestTrack(0)],
      qualifications: [],
    })).toThrow(CanonicalPublicationRevalidationRequiredErrorV1);
  });

  test("re-enforces the minimum evidence grade before repaired publication", () => {
    const plan = canonicalPlan(1, {}, {
      required: true,
      minimumGrade: "primary_source",
      permittedGrades: ["primary_source", "independent_secondary_source"],
      claim: "documented disco membership",
    });
    const belowFloor = revalidateCanonicalManifestRevisionV1({
      plan,
      manifestTracks: [manifestTrack(0)],
      qualifications: [qualification(0, {
        evidenceGrade: "independent_secondary_source",
      })],
    });
    expect(belowFloor.valid).toBe(false);
    expect(belowFloor.reasonCodes).toContain("canonical_track_unknown");

    expect(revalidateCanonicalManifestRevisionV1({
      plan,
      manifestTracks: [manifestTrack(0)],
      qualifications: [qualification(0, { evidenceGrade: "primary_source" })],
    })).toMatchObject({ valid: true, reasonCodes: [] });
  });
});
