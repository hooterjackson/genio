import { describe, expect, test } from "vitest";
import type { SelectionConstraint, SelectionPlan } from "../shared/types.ts";
import { deriveAttestedHardScopeDescriptors } from "../server/evidence-scope-binding.ts";

function constraint(
  id: string,
  axis: SelectionConstraint["axis"],
  values: string[],
  geographyRelationship: SelectionConstraint["geographyRelationship"] = null,
): SelectionConstraint {
  return {
    id,
    axis,
    values,
    kind: "hard",
    operator: axis === "era" ? "within" : "include",
    geographyRelationship,
    relaxationRank: null,
  };
}

function brazilianDiscoPlan(): Pick<SelectionPlan, "constraints"> {
  return {
    constraints: [
      constraint("genre", "genre", ["disco", "funk"]),
      constraint("geography", "geography", ["Brazilian"], "unspecified"),
      constraint("era", "era", ["1970s", "1980s"]),
    ],
  };
}

describe("attested evidence scope-binding derivation", () => {
  test("persists only the Brazilian disco scope asserted by an honest cited relationship", () => {
    expect(deriveAttestedHardScopeDescriptors(brazilianDiscoPlan(), {
      citationAttestationId: "citation-brazilian-disco",
      sourceMetadataText: "Brazilian Disco Classics of the 1970s",
      relationship: "Maria Fumaça is a Brazilian disco recording released in 1977",
    })).toEqual([
      { scopeAxis: "genre", scopeValue: "disco", geographyRelationship: null },
      { scopeAxis: "geography", scopeValue: "Brazilian", geographyRelationship: "unspecified" },
      { scopeAxis: "era", scopeValue: "1970s", geographyRelationship: null },
    ]);
  });

  test("does not turn the forced SUBJECT field into proof", () => {
    expect(deriveAttestedHardScopeDescriptors(brazilianDiscoPlan(), {
      citationAttestationId: "citation-track-only",
      sourceMetadataText: "Track listing",
      relationship: "Maria Fumaça is listed as a track",
    })).toEqual([]);
  });

  test("requires a persisted citation attestation", () => {
    expect(deriveAttestedHardScopeDescriptors(brazilianDiscoPlan(), {
      citationAttestationId: null,
      sourceMetadataText: "Brazilian disco and boogie recordings from the 1970s and 1980s.",
      relationship: "Brazilian disco and boogie recordings from the 1970s and 1980s",
    })).toEqual([]);
  });

  test("does not upgrade a bare place adjective to an artist-origin claim", () => {
    const originPlan = {
      constraints: [constraint("origin", "geography", ["Brazilian"], "artist_origin")],
    };
    expect(deriveAttestedHardScopeDescriptors(originPlan, {
      citationAttestationId: "citation-bare-place",
      sourceMetadataText: "A foundational Brazilian disco recording.",
      relationship: "is a foundational Brazilian disco recording",
    })).toEqual([]);

    expect(deriveAttestedHardScopeDescriptors(originPlan, {
      citationAttestationId: "citation-origin",
      sourceMetadataText: "A foundational disco recording by Brazilian artists.",
      relationship: "is a foundational disco recording by Brazilian artists",
    })).toEqual([
      { scopeAxis: "geography", scopeValue: "Brazilian", geographyRelationship: "artist_origin" },
    ]);
  });

  test("rejects non-supporting relationship assertions even when proof repeats every value", () => {
    expect(deriveAttestedHardScopeDescriptors(brazilianDiscoPlan(), {
      citationAttestationId: "citation-negative",
      sourceMetadataText: "Brazilian disco, boogie, and disco-funk from the 1970s and 1980s.",
      relationship: "is unrelated to Brazilian disco",
    })).toEqual([]);
  });
});
