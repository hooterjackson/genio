import type { SelectionConstraint } from "../shared/types.ts";
import type { SelectionPlanV3 } from "./selection-plan-v3.ts";
import { recordingFamilySatisfiesEraConstraint } from "./selection-era-policy.ts";

export interface CatalogEraPolicyV3 {
  readonly id: string;
  readonly constraint: Pick<SelectionConstraint, "operator" | "values">;
  readonly excluded: boolean;
}

const EXPRESSIVE_ERA_OPERATORS = new Set<SelectionConstraint["operator"]>([
  "within",
  "between",
  "before",
  "after",
]);

function policyKey(policy: CatalogEraPolicyV3): string {
  return `${policy.excluded ? "exclude" : "include"}:${policy.constraint.operator}:${policy.constraint.values.join("|")}`;
}

/**
 * Return the immutable era rules that must be proven by catalog metadata.
 *
 * Query-plan persistence adds a generic `require` constraint for every
 * membership predicate. When a typed `between`/`within` constraint is also
 * present, the typed constraint is authoritative: evaluating both would turn
 * 1973–1983 into the two endpoint years only.
 */
export function catalogEraPoliciesV3(
  plan: Pick<SelectionPlanV3, "hardConstraints" | "membershipPredicates">,
): CatalogEraPolicyV3[] {
  const hardEra = plan.hardConstraints.filter((constraint) => (
    constraint.kind === "hard" && constraint.axis === "era"
  ));
  const excluded = hardEra.filter((constraint) => (
    constraint.operator === "exclude" || constraint.operator === "avoid"
  ));
  const positive = hardEra.filter((constraint) => (
    constraint.operator !== "exclude" && constraint.operator !== "avoid"
  ));
  const expressive = positive.filter((constraint) => EXPRESSIVE_ERA_OPERATORS.has(constraint.operator));
  const selectedPositive = expressive.length > 0 ? expressive : positive;
  const policies: CatalogEraPolicyV3[] = [
    ...selectedPositive.map((constraint) => ({
      id: constraint.id,
      constraint: { operator: constraint.operator, values: [...constraint.values] },
      excluded: false,
    })),
    ...excluded.map((constraint) => ({
      id: constraint.id,
      constraint: { operator: constraint.operator, values: [...constraint.values] },
      excluded: true,
    })),
  ];

  // Focused adapter tests and pre-query-plan callers may carry only the
  // membership predicate. Preserve the same fail-closed catalog behavior.
  if (policies.length === 0) {
    policies.push(...plan.membershipPredicates
      .filter((predicate) => predicate.axis === "era")
      .map((predicate) => ({
        id: predicate.id,
        constraint: {
          operator: "within" as const,
          values: [...predicate.values],
        },
        excluded: predicate.operator === "exclude",
      })));
  }

  const seen = new Set<string>();
  return policies.filter((policy) => {
    const key = policyKey(policy);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizedCatalogReleaseYear(releaseDate: string | null | undefined): number | null {
  if (typeof releaseDate !== "string") return null;
  const match = /^(\d{4})/u.exec(releaseDate.trim());
  if (!match) return null;
  const year = Number.parseInt(match[1]!, 10);
  return Number.isInteger(year) && year >= 1000 && year <= 2999 ? year : null;
}

/** Fail closed when the catalog cannot prove every hard era rule. */
export function catalogEraConstraintFailuresV3(
  plan: Pick<SelectionPlanV3, "hardConstraints" | "membershipPredicates">,
  catalogReleaseYear: number | null | undefined,
  compatibleReleaseYears: readonly number[] = [],
): string[] {
  const policies = catalogEraPoliciesV3(plan);
  if (policies.length === 0) return [];
  return policies.flatMap((policy) => {
    const matches = recordingFamilySatisfiesEraConstraint({
      candidateReleaseYear: catalogReleaseYear ?? null,
      appleReleaseDate: null,
      compatibleReleaseYears,
    }, policy.constraint);
    const passed = policy.excluded ? !matches : matches;
    return passed ? [] : [policy.id];
  });
}
