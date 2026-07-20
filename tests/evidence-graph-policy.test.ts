import { describe, expect, test } from "vitest";
import {
  evaluateCandidateEvidenceEligibilityV3,
  evaluateEvidenceAssertionV3,
  promoteEvidenceAssertionsV3,
  type EvidenceAssertionV3,
  type GovernedSourceV3,
} from "../server/evidence-graph-policy.ts";

function source(overrides: Partial<GovernedSourceV3> = {}): GovernedSourceV3 {
  return {
    id: "source-1",
    url: "https://credits.example/track/1",
    provenanceRoot: "credits.example",
    authority: "primary_track_credit",
    accessMethod: "manual_entry",
    status: "active",
    approvalState: "approved",
    licenseState: "permission_recorded",
    licenseVersion: "permission-2026-07-20",
    termsVersion: "terms-2026-07-20",
    attribution: "Credits Example",
    cachePolicy: "excerpt_only",
    retentionPolicy: "durable_public_corpus",
    freshnessPolicy: "immutable_revision",
    freshnessExpiresAt: null,
    contentHash: "a".repeat(64),
    sourceRevision: "a".repeat(64),
    retrievedAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

function assertion(overrides: Partial<EvidenceAssertionV3> = {}): EvidenceAssertionV3 {
  return {
    id: "assertion-1",
    recordingId: "recording-1",
    subjectEntityId: "artist-1",
    relationship: "performed percussion on",
    claimAxis: "factual_relationship",
    supportedValues: ["performed percussion"],
    polarity: "supports",
    scope: "exact_recording",
    source: source(),
    extractionMethod: "human",
    reviewerState: "approved",
    identityConfidence: 0.99,
    roleSpecificity: "exact",
    explicitAllTracksStatement: false,
    releaseEditionId: null,
    enumeratedRecordingIds: [],
    supersededByAssertionId: null,
    ...overrides,
  };
}

describe("Pipeline V3 evidence promotion", () => {
  test("promotes a governed, human-approved exact-track primary assertion", () => {
    expect(evaluateEvidenceAssertionV3(assertion())).toEqual({
      assertionId: "assertion-1",
      state: "verified",
      eligibleForMembership: true,
      reasons: [],
    });
  });

  test("quarantines model/import claims and sources without reuse permission", () => {
    const model = evaluateEvidenceAssertionV3(assertion({ extractionMethod: "model" }));
    expect(model).toMatchObject({ state: "quarantined", eligibleForMembership: false });
    expect(model.reasons).toContain("untrusted_extraction_requires_review");

    const unknownLicense = evaluateEvidenceAssertionV3(assertion({
      source: source({ licenseState: "unknown", licenseVersion: null }),
    }));
    expect(unknownLicense).toMatchObject({ state: "review_required", eligibleForMembership: false });
    expect(unknownLicense.reasons).toEqual(expect.arrayContaining([
      "source_reuse_not_authorized", "license_version_missing",
    ]));
  });

  test("never expands an unspecified album credit or recording-family assignment", () => {
    expect(evaluateEvidenceAssertionV3(assertion({ scope: "release_unspecified_tracks" })).reasons)
      .toContain("album_credit_track_scope_unspecified");
    expect(evaluateEvidenceAssertionV3(assertion({ scope: "recording_family" })).reasons)
      .toContain("recording_family_not_exact_credit_scope");
  });

  test("permits all-track propagation only for the exact enumerated release edition", () => {
    const propagated = assertion({
      scope: "exact_release_all_tracks",
      explicitAllTracksStatement: true,
      releaseEditionId: "release-edition-1",
      enumeratedRecordingIds: ["recording-1", "recording-2"],
    });
    expect(evaluateEvidenceAssertionV3(propagated)).toMatchObject({ state: "verified", eligibleForMembership: true });

    const bonusTrack = assertion({
      scope: "exact_release_all_tracks",
      explicitAllTracksStatement: true,
      releaseEditionId: "release-edition-1",
      enumeratedRecordingIds: ["recording-2"],
    });
    expect(evaluateEvidenceAssertionV3(bonusTrack).reasons).toContain("recording_not_on_enumerated_edition");
  });

  test("requires two independent provenance roots for medium evidence", () => {
    const first = assertion({
      id: "medium-1",
      source: source({ id: "source-a", authority: "secondary_database", provenanceRoot: "database-a" }),
    });
    const copied = assertion({
      id: "medium-copy",
      source: source({ id: "source-copy", authority: "secondary_database", provenanceRoot: "database-a", url: "https://mirror.example/track/1" }),
    });
    expect(promoteEvidenceAssertionsV3([first, copied]).every(({ eligibleForMembership }) => !eligibleForMembership)).toBe(true);

    const independent = assertion({
      id: "medium-2",
      source: source({ id: "source-b", authority: "specialist_track_credit", provenanceRoot: "database-b" }),
    });
    // A high-authority independent source verifies itself; two medium sources
    // below demonstrate corroboration specifically.
    const secondMedium = { ...independent, source: { ...independent.source, authority: "secondary_database" as const } };
    expect(promoteEvidenceAssertionsV3([first, secondMedium])).toEqual([
      expect.objectContaining({ assertionId: "medium-1", state: "corroborated", eligibleForMembership: true }),
      expect.objectContaining({ assertionId: "medium-2", state: "corroborated", eligibleForMembership: true }),
    ]);
  });

  test("an unresolved negative assertion blocks matching positive claims", () => {
    const positive = assertion({ id: "positive" });
    const dispute = assertion({
      id: "negative",
      polarity: "disputes",
      source: source({ id: "source-negative", provenanceRoot: "independent-negative.example" }),
    });
    expect(promoteEvidenceAssertionsV3([positive, dispute])).toEqual([
      expect.objectContaining({ assertionId: "positive", state: "disputed", eligibleForMembership: false }),
      expect.objectContaining({ assertionId: "negative", state: "disputed", eligibleForMembership: false }),
    ]);
  });
});

describe("Pipeline V3 evidence eligibility", () => {
  test("requires a playable identity and separate evidence for every requested axis", () => {
    const factual = assertion();
    const genre = assertion({
      id: "genre-1",
      relationship: "is a disco recording",
      claimAxis: "genre",
      supportedValues: ["disco"],
      source: source({ id: "genre-source", url: "https://genre.example/disco/track-1", provenanceRoot: "genre.example" }),
    });
    const requirements = [
      { id: "credit", axis: "factual_relationship" as const, acceptedValues: ["performed percussion"] },
      { id: "genre", axis: "genre" as const, acceptedValues: ["disco"] },
    ];
    expect(evaluateCandidateEvidenceEligibilityV3({
      recordingId: "recording-1",
      hasPlayableCatalogIdentity: true,
      requirements,
      assertions: [factual, genre],
    })).toMatchObject({ eligible: true, missingRequirementIds: [] });

    expect(evaluateCandidateEvidenceEligibilityV3({
      recordingId: "recording-1",
      hasPlayableCatalogIdentity: true,
      requirements,
      assertions: [factual],
    })).toMatchObject({ eligible: false, missingRequirementIds: ["genre"] });

    expect(evaluateCandidateEvidenceEligibilityV3({
      recordingId: "recording-1",
      hasPlayableCatalogIdentity: false,
      requirements: [],
      assertions: [],
    })).toMatchObject({ eligible: false, reasonCodes: ["playable_catalog_identity_missing"] });
  });

  test("catalog metadata cannot prove a factual or editorial relationship", () => {
    const metadata = assertion({
      source: source({ authority: "catalog_metadata" }),
    });
    const result = evaluateCandidateEvidenceEligibilityV3({
      recordingId: "recording-1",
      hasPlayableCatalogIdentity: true,
      requirements: [{ id: "credit", axis: "factual_relationship", acceptedValues: ["performed percussion"] }],
      assertions: [metadata],
    });
    expect(result).toMatchObject({ eligible: false, missingRequirementIds: ["credit"] });
  });
});
