import { describe, expect, test } from "vitest";
import {
  catalogEraConstraintFailuresV3,
  catalogEraPoliciesV3,
  normalizedCatalogReleaseYear,
} from "../server/pipeline-v3-era-policy.ts";
import { evidenceMembershipPredicateIdsV3 } from "../server/selection-plan-v3.ts";
import type { SelectionPlanV3 } from "../server/selection-plan-v3.ts";

function eraPlan(): Pick<SelectionPlanV3, "hardConstraints" | "membershipPredicates"> {
  return {
    membershipPredicates: [
      {
        id: "genre-disco",
        axis: "genre",
        operator: "require",
        values: ["disco"],
        source: "user",
        reason: "Requested genre.",
      },
      {
        id: "era-membership",
        axis: "era",
        operator: "require",
        values: ["1973", "1983"],
        source: "user",
        reason: "Requested era.",
      },
    ],
    hardConstraints: [
      // QueryPlanV3 persists this generic membership projection alongside the
      // typed range. It must not reduce the range to its endpoint years.
      {
        id: "era-membership",
        axis: "era",
        operator: "require",
        values: ["1973", "1983"],
        kind: "hard",
        relaxationRank: null,
      },
      {
        id: "era-between",
        axis: "era",
        operator: "between",
        values: ["1973", "1983"],
        kind: "hard",
        relaxationRank: null,
      },
    ],
  };
}

describe("Pipeline V3 catalog era policy", () => {
  test("enforces an explicit schema-2 era catalog policy without legacy membership projection", () => {
    const plan = {
      membershipPredicates: [{
        id: "genre-disco",
        axis: "genre" as const,
        operator: "require" as const,
        values: ["disco"],
        source: "user" as const,
        reason: "Requested genre.",
      }],
      hardConstraints: [],
      catalogPolicies: [{
        id: "catalog-era-1970s",
        role: "catalog_policy" as const,
        axis: "era" as const,
        operator: "within" as const,
        values: ["1970s"],
        source: "raw_prompt" as const,
        explicitUserAuthored: true,
        geographyRelationship: null,
        reason: "Explicit era.",
      }],
    };

    expect(catalogEraPoliciesV3(plan)).toEqual([{
      id: "catalog-era-1970s",
      constraint: { operator: "within", values: ["1970s"] },
      excluded: false,
    }]);
    expect(catalogEraConstraintFailuresV3(plan, 1978)).toEqual([]);
    expect(catalogEraConstraintFailuresV3(plan, 1981)).toEqual(["catalog-era-1970s"]);
  });

  test("does not turn generated era preference prose into a hard catalog gate", () => {
    const plan = {
      membershipPredicates: [],
      hardConstraints: [],
      catalogPolicies: [{
        id: "generated-era-preference",
        role: "catalog_policy" as const,
        axis: "era" as const,
        operator: "prefer" as const,
        values: ["1970s"],
        source: "v2_compatibility" as const,
        explicitUserAuthored: false,
        geographyRelationship: null,
        reason: "Generated preference.",
      }],
    };
    expect(catalogEraPoliciesV3(plan)).toEqual([]);
    expect(catalogEraConstraintFailuresV3(plan, null)).toEqual([]);
  });

  test("keeps genre in the evidence contract but evaluates era from catalog metadata", () => {
    const plan = eraPlan();
    expect(evidenceMembershipPredicateIdsV3(plan)).toEqual(["genre-disco"]);
    expect(catalogEraPoliciesV3(plan)).toEqual([{
      id: "era-between",
      constraint: { operator: "between", values: ["1973", "1983"] },
      excluded: false,
    }]);
  });

  test.each([
    [1972, ["era-between"]],
    [1973, []],
    [1983, []],
    [1984, ["era-between"]],
  ] as const)("enforces the inclusive 1973–1983 catalog boundary for %i", (year, failures) => {
    expect(catalogEraConstraintFailuresV3(eraPlan(), year)).toEqual(failures);
  });

  test("fails closed without a catalog year and normalizes Apple release dates", () => {
    expect(catalogEraConstraintFailuresV3(eraPlan(), null)).toEqual(["era-between"]);
    expect(normalizedCatalogReleaseYear("1973-06-01")).toBe(1973);
    expect(normalizedCatalogReleaseYear("not-a-date")).toBeNull();
  });

  test("accepts an in-range year from an exact compatible recording-family issue", () => {
    expect(catalogEraConstraintFailuresV3(eraPlan(), 2004, [1978, 2004])).toEqual([]);
  });

  test("uses the earliest supported family issue rather than treating later compilations as a new-era recording", () => {
    const modernPlan = {
      membershipPredicates: [{
        id: "era-membership",
        axis: "era" as const,
        operator: "require" as const,
        values: ["2000s"],
        source: "user" as const,
        reason: "Requested era.",
      }],
      hardConstraints: [{
        id: "era-modern",
        axis: "era" as const,
        operator: "within" as const,
        values: ["2000s"],
        kind: "hard" as const,
        relaxationRank: null,
      }],
    };
    expect(catalogEraConstraintFailuresV3(modernPlan, 2004, [1978, 2004])).toEqual(["era-modern"]);
  });

  test("fails closed when compatible issues still cannot prove the requested era", () => {
    expect(catalogEraConstraintFailuresV3(eraPlan(), 2004, [2004, 2018])).toEqual(["era-between"]);
    expect(catalogEraConstraintFailuresV3(eraPlan(), null, [])).toEqual(["era-between"]);
  });
});
