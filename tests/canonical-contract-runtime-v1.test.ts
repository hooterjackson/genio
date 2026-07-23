import { describe, expect, test } from "vitest";
import {
  assertCanonicalContractExecutionPolicyV1,
  canonicalEvidenceGradeForBindingV1,
  canonicalContractExecutionPolicyV1,
  evaluateCanonicalContractTrackV1,
} from "../server/canonical-contract-runtime-v1.ts";
import {
  compilePlaylistContractRevisionV1,
  type PlaylistContractDraftV1,
} from "../server/playlist-contract-v1.ts";

function draft(): PlaylistContractDraftV1 {
  return {
    contractId: "contract:runtime-boolean",
    rawPrompt: "Twenty tracks that are reggaeton or dembow, excluding Bad Bunny.",
    requestedTrackCount: 20,
    locale: "en-US",
    storefront: "us",
    clauses: [
      {
        id: "genre:reggaeton",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "genre",
        operator: "require",
        values: ["reggaeton"],
        source: { provenance: "prompt", text: "reggaeton" },
      },
      {
        id: "genre:dembow",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "genre",
        operator: "require",
        values: ["dembow"],
        source: { provenance: "prompt", text: "dembow" },
      },
      {
        id: "artist:bad-bunny",
        kind: "exclusion",
        scope: "track",
        hardness: "hard",
        axis: "artist",
        operator: "exclude",
        values: ["Bad Bunny"],
        source: { provenance: "prompt", text: "excluding Bad Bunny" },
        unknownPolicy: "defer",
      },
    ],
    trackPredicate: {
      op: "all",
      children: [
        {
          op: "any",
          children: [
            { op: "clause", clauseId: "genre:reggaeton" },
            { op: "clause", clauseId: "genre:dembow" },
          ],
        },
        { op: "clause", clauseId: "artist:bad-bunny" },
      ],
    },
    qualityPolicy: {
      centralSuitabilityClauseIds: [],
      minimumPassRatio: 0.8,
      maximumUnknownRatio: 0.2,
      zeroKnownFailures: true,
    },
  };
}

describe("canonical contract runtime authority", () => {
  test("executes OR, exclusion inversion, evidence grades, and unknown policy", () => {
    const policy = canonicalContractExecutionPolicyV1(
      compilePlaylistContractRevisionV1(draft()),
    );
    expect(evaluateCanonicalContractTrackV1({
      policy,
      assessments: {
        "genre:reggaeton": { status: "unknown" },
        "genre:dembow": {
          status: "pass",
          evidenceGrade: "trusted_scoped_container",
          evidenceIds: ["binding:dembow"],
        },
        // Raw fail means the excluded artist does not match.
        "artist:bad-bunny": {
          status: "fail",
          evidenceGrade: "authoritative_structured_metadata",
        },
      },
    })).toMatchObject({ status: "pass", eligible: true });

    expect(evaluateCanonicalContractTrackV1({
      policy,
      assessments: {
        "genre:reggaeton": {
          status: "pass",
          evidenceGrade: "model_derived_lead",
        },
        "genre:dembow": { status: "fail" },
        "artist:bad-bunny": {
          status: "fail",
          evidenceGrade: "authoritative_structured_metadata",
        },
      },
    })).toMatchObject({ status: "unknown", eligible: false });

    expect(evaluateCanonicalContractTrackV1({
      policy,
      assessments: {
        "genre:reggaeton": {
          status: "pass",
          evidenceGrade: "trusted_scoped_container",
        },
        "artist:bad-bunny": {
          status: "pass",
          evidenceGrade: "authoritative_structured_metadata",
        },
      },
    })).toMatchObject({ status: "fail", eligible: false });

    // A raw "excluded artist absent" result is still a factual claim. An
    // unqualified lead cannot be inverted into compliant publication proof.
    expect(evaluateCanonicalContractTrackV1({
      policy,
      assessments: {
        "genre:reggaeton": {
          status: "pass",
          evidenceGrade: "trusted_scoped_container",
        },
        "artist:bad-bunny": {
          status: "fail",
          evidenceGrade: "model_derived_lead",
        },
      },
    })).toMatchObject({ status: "unknown", eligible: false });
  });

  test("hash-fences the complete executable projection", () => {
    const policy = canonicalContractExecutionPolicyV1(
      compilePlaylistContractRevisionV1(draft()),
    );
    expect(policy.evidenceStrengthPolicyVersion).toBe(
      "evidence_strength_partial_order_v1",
    );
    expect(() => assertCanonicalContractExecutionPolicyV1(policy)).not.toThrow();
    expect(() => assertCanonicalContractExecutionPolicyV1({
      ...policy,
      storefront: "br",
    })).toThrow("canonical_contract_runtime_projection_hash_mismatch");
    expect(() => assertCanonicalContractExecutionPolicyV1({
      ...policy,
      evidenceStrengthPolicyVersion: "future_strength_policy" as never,
    })).toThrow("invalid_canonical_contract_runtime_policy");
  });

  test("fails closed below, across, or outside the evidence-grade partial order", () => {
    const base = draft();
    const policy = canonicalContractExecutionPolicyV1(
      compilePlaylistContractRevisionV1({
        ...base,
        clauses: base.clauses
          .filter((clause) => clause.id === "genre:reggaeton")
          .map((clause) => ({
            ...clause,
            evidence: {
              required: true,
              minimumGrade: "primary_source" as const,
              permittedGrades: [
                "primary_source" as const,
                "independent_secondary_source" as const,
                "authoritative_structured_metadata" as const,
              ],
            },
          })),
        trackPredicate: { op: "clause", clauseId: "genre:reggaeton" },
      }),
    );
    const evaluate = (evidenceGrade: string) => evaluateCanonicalContractTrackV1({
      policy,
      assessments: {
        "genre:reggaeton": {
          status: "pass",
          evidenceGrade: evidenceGrade as never,
        },
      },
    });

    expect(evaluate("primary_source")).toMatchObject({ status: "pass", eligible: true });
    expect(evaluate("independent_secondary_source")).toMatchObject({
      status: "unknown",
      eligible: false,
    });
    expect(evaluate("authoritative_structured_metadata")).toMatchObject({
      status: "unknown",
      eligible: false,
    });
    expect(evaluate("future_unreviewed_grade")).toMatchObject({
      status: "unknown",
      eligible: false,
    });
    expect(evaluateCanonicalContractTrackV1({
      policy,
      assessments: {
        "genre:reggaeton": {
          status: "future_unreviewed_status" as never,
          evidenceGrade: "primary_source",
        },
      },
    })).toMatchObject({ status: "unknown", eligible: false });
  });

  test("classifies evidence by entailment instead of public-API transport", () => {
    expect(canonicalEvidenceGradeForBindingV1({
      kind: "apple_editorial_container",
      accessMethod: "public_api",
    })).toBe("trusted_scoped_container");
    expect(canonicalEvidenceGradeForBindingV1({
      kind: "fixed_container",
      accessMethod: "public_api",
    })).toBe("trusted_scoped_container");
    expect(canonicalEvidenceGradeForBindingV1({
      kind: "artist_catalogue",
      accessMethod: "public_api",
    })).toBe("authoritative_structured_metadata");
    expect(canonicalEvidenceGradeForBindingV1({
      kind: "future_unknown_binding",
      accessMethod: "public_api",
    })).toBe("model_derived_lead");
    expect(canonicalEvidenceGradeForBindingV1({
      kind: "future_unreviewed_structured_binding",
      accessMethod: "public_api",
    })).toBe("model_derived_lead");
  });
});
