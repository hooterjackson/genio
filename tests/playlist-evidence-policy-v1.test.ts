import { describe, expect, test } from "vitest";
import {
  GOVERNED_PLAYLIST_EVIDENCE_POLICY_VERSION,
  PLAYLIST_EVIDENCE_STRENGTH_POLICY_VERSION,
  playlistEvidenceGradeMeetsMinimumV1,
  playlistEvidenceGradeSatisfiesObligationV1,
  selectQualifyingPlaylistEvidenceGradeV1,
} from "../server/playlist-evidence-policy-v1.ts";

const policy = {
  evidencePolicyVersion: GOVERNED_PLAYLIST_EVIDENCE_POLICY_VERSION,
  strengthPolicyVersion: PLAYLIST_EVIDENCE_STRENGTH_POLICY_VERSION,
};

describe("canonical evidence partial-order policy", () => {
  test("allows only documented within-family strength relations", () => {
    expect(playlistEvidenceGradeMeetsMinimumV1({
      grade: "primary_source",
      minimumGrade: "independent_secondary_source",
      strengthPolicyVersion: PLAYLIST_EVIDENCE_STRENGTH_POLICY_VERSION,
    })).toBe(true);
    expect(playlistEvidenceGradeMeetsMinimumV1({
      grade: "track_specific_editorial_assertion",
      minimumGrade: "trusted_scoped_container",
      strengthPolicyVersion: PLAYLIST_EVIDENCE_STRENGTH_POLICY_VERSION,
    })).toBe(true);
    expect(playlistEvidenceGradeMeetsMinimumV1({
      grade: "authoritative_structured_metadata",
      minimumGrade: "primary_source",
      strengthPolicyVersion: PLAYLIST_EVIDENCE_STRENGTH_POLICY_VERSION,
    })).toBe(false);
    expect(playlistEvidenceGradeMeetsMinimumV1({
      grade: "primary_source",
      minimumGrade: "authoritative_structured_metadata",
      strengthPolicyVersion: PLAYLIST_EVIDENCE_STRENGTH_POLICY_VERSION,
    })).toBe(false);
  });

  test("enforces both the permitted allowlist and the minimum floor", () => {
    const obligation = {
      required: true,
      minimumGrade: "independent_secondary_source" as const,
      permittedGrades: [
        "primary_source",
        "independent_secondary_source",
      ] as const,
    };
    expect(playlistEvidenceGradeSatisfiesObligationV1({
      grade: "primary_source",
      obligation,
      ...policy,
    })).toBe(true);
    expect(playlistEvidenceGradeSatisfiesObligationV1({
      grade: "independent_secondary_source",
      obligation,
      ...policy,
    })).toBe(true);
    expect(playlistEvidenceGradeSatisfiesObligationV1({
      grade: "track_specific_editorial_assertion",
      obligation,
      ...policy,
    })).toBe(false);
  });

  test("fails closed for model leads, unknown grades, unknown policies, and incomparability", () => {
    const obligation = {
      required: true,
      minimumGrade: "primary_source" as const,
      permittedGrades: [
        "primary_source",
        "authoritative_structured_metadata",
      ] as const,
    };
    for (const grade of [
      "model_derived_lead",
      "future_unreviewed_grade",
      "authoritative_structured_metadata",
    ]) {
      expect(playlistEvidenceGradeSatisfiesObligationV1({
        grade,
        obligation,
        ...policy,
      })).toBe(false);
    }
    expect(playlistEvidenceGradeSatisfiesObligationV1({
      grade: "primary_source",
      obligation,
      evidencePolicyVersion: "governed_evidence_v999",
      strengthPolicyVersion: PLAYLIST_EVIDENCE_STRENGTH_POLICY_VERSION,
    })).toBe(false);
  });

  test("selects a qualifying route without globally ranking incomparable grades", () => {
    const obligation = {
      required: true,
      minimumGrade: null,
      permittedGrades: [
        "primary_source",
        "authoritative_structured_metadata",
      ] as const,
    };
    expect(selectQualifyingPlaylistEvidenceGradeV1({
      grades: ["primary_source", "authoritative_structured_metadata"],
      obligation,
      ...policy,
    })).toBe("authoritative_structured_metadata");
    expect(selectQualifyingPlaylistEvidenceGradeV1({
      grades: ["model_derived_lead", "future_unreviewed_grade"],
      obligation,
      ...policy,
    })).toBeNull();
  });
});
