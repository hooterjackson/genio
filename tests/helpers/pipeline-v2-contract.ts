export type ConstraintKind = "hard" | "soft";

export interface ContractConstraint {
  id: string;
  kind: ConstraintKind;
  relaxationRank: number | null;
}

export interface ContractCandidate {
  id: string;
  violations: string[];
}

export interface ContractSelectionResult {
  state: "exact" | "partial";
  selected: string[];
  relaxed: string[];
}

const ONE_SIDED_95_PERCENT_Z = 1.6448536269514722;
const COLD_START_SELECTABLE_YIELD = 0.5;
const MINIMUM_SELECTABLE_YIELD = 0.2;

/**
 * Test oracle for Pipeline V2's conservative selectable-yield estimate.
 *
 * A point estimate is unsafe for exact fill: 39/50 does not mean the next
 * batch will also match at precisely 78%. Use the one-sided Wilson lower
 * confidence bound, with a bounded cold-start prior, so a refill is sized for
 * the downside rather than for the average case.
 */
export function selectableYieldLowerBound(
  selectable: number,
  attempts: number,
): number {
  if (attempts <= 0) return COLD_START_SELECTABLE_YIELD;
  const boundedAttempts = Math.max(1, Math.floor(attempts));
  const boundedSelectable = Math.max(0, Math.min(boundedAttempts, Math.floor(selectable)));
  const observed = boundedSelectable / boundedAttempts;
  const zSquared = ONE_SIDED_95_PERCENT_Z ** 2;
  const denominator = 1 + zSquared / boundedAttempts;
  const center = observed + zSquared / (2 * boundedAttempts);
  const margin = ONE_SIDED_95_PERCENT_Z * Math.sqrt(
    (observed * (1 - observed) + zSquared / (4 * boundedAttempts)) / boundedAttempts,
  );
  return Math.max(
    MINIMUM_SELECTABLE_YIELD,
    Math.min(1, (center - margin) / denominator),
  );
}

/**
 * Raw discovery needed to fill the current deficit plus a selectable reserve.
 * The function deliberately reasons about Apple-selectable rows, not model
 * candidates, citations, or fuzzy catalog search results.
 */
export function exactFillRawPlan(input: {
  target: number;
  selectable: number;
  observedAttempts: number;
  observedSelectable: number;
}): number {
  const target = Math.max(0, Math.floor(input.target));
  const selectable = Math.max(0, Math.floor(input.selectable));
  const deficit = Math.max(0, target - selectable);
  if (deficit === 0) return 0;
  const selectableReserve = Math.max(5, Math.ceil(target * 0.1));
  const lowerBound = selectableYieldLowerBound(
    input.observedSelectable,
    input.observedAttempts,
  );
  return Math.ceil((deficit + selectableReserve) / lowerBound);
}

/**
 * Reference constraint ladder. Hard rules never leave the active set. Soft
 * rules relax one at a time in explicit order, stopping as soon as exact fill
 * is possible. If hard rules exhaust the pool, the result is transparent
 * partial output rather than an unsafe exact playlist.
 */
export function selectWithConstraintLadder(input: {
  target: number;
  constraints: ContractConstraint[];
  candidates: ContractCandidate[];
}): ContractSelectionResult {
  const hard = new Set(input.constraints
    .filter((constraint) => constraint.kind === "hard")
    .map((constraint) => constraint.id));
  const soft = input.constraints
    .filter((constraint) => constraint.kind === "soft")
    .sort((left, right) => Number(left.relaxationRank) - Number(right.relaxationRank));
  const relaxed: string[] = [];

  const selectable = () => {
    const activeSoft = new Set(soft
      .filter((constraint) => !relaxed.includes(constraint.id))
      .map((constraint) => constraint.id));
    return input.candidates.filter((candidate) => candidate.violations.every((violation) => (
      !hard.has(violation) && !activeSoft.has(violation)
    )));
  };

  let eligible = selectable();
  for (const constraint of soft) {
    if (eligible.length >= input.target) break;
    relaxed.push(constraint.id);
    eligible = selectable();
  }
  const selected = eligible.slice(0, input.target).map((candidate) => candidate.id);
  return {
    state: selected.length >= input.target ? "exact" : "partial",
    selected,
    relaxed,
  };
}

export type ContractFailureOrigin = "provider" | "catalog_shortfall" | "local_contract";

/**
 * Reference terminal policy: recoverable external shortfalls preserve safe
 * work as partial output. Local invariant/schema violations are developer
 * errors and fail closed even when some rows happened to be assembled.
 */
export function contractTerminalOutcome(input: {
  failureOrigin: ContractFailureOrigin;
  safeTrackCount: number;
  target: number;
}): { status: "partial" | "failed"; publicClass: string } {
  if (input.failureOrigin === "local_contract") {
    return { status: "failed", publicClass: "internal_contract" };
  }
  return {
    status: "partial",
    publicClass: input.failureOrigin === "catalog_shortfall"
      ? "catalog_shortfall"
      : "provider_unavailable",
  };
}

export function keywordCandidateSelectable(input: {
  requestIntent: string;
  genreEvidence: boolean;
}): boolean {
  if (input.requestIntent === "house_music_genre") return input.genreEvidence;
  return true;
}
