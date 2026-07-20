export const PIPELINE_V3_STAGE_ORDER = [
  "discovered",
  "scope_eligible",
  "evidence_eligible",
  "version_compatible",
  "playable",
  "canonical_unique",
  "quota_eligible",
] as const;

export type PipelineV3YieldStage = typeof PIPELINE_V3_STAGE_ORDER[number];

export interface StageYieldObservationV3 {
  readonly stage: PipelineV3YieldStage;
  readonly entered: number;
  readonly passed: number;
}

export interface StageYieldEstimateV3 extends StageYieldObservationV3 {
  readonly observedYield: number | null;
  readonly conservativeYield: number | null;
}

export interface AdaptiveFillPlanV3 {
  readonly target: number;
  readonly reserve: number;
  readonly qualified: number;
  readonly targetDeficit: number;
  readonly qualifiedPoolGoal: number;
  readonly qualifiedPoolDeficit: number;
  readonly conservativeEndToEndYield: number;
  readonly rawDiscoveryGoal: number;
  readonly stageYields: readonly StageYieldEstimateV3[];
}

const ONE_SIDED_95_Z = 1.6448536269514722;
const COLD_START_END_TO_END_YIELD = 0.5;
const MINIMUM_BOUNDED_YIELD = 0.2;
const MAXIMUM_BOUNDED_YIELD = 0.95;

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function wilsonLowerBound(successes: number, attempts: number): number {
  if (attempts === 0) return 0;
  const observed = successes / attempts;
  const z2 = ONE_SIDED_95_Z ** 2;
  const denominator = 1 + z2 / attempts;
  const center = observed + z2 / (2 * attempts);
  const margin = ONE_SIDED_95_Z * Math.sqrt(
    (observed * (1 - observed) + z2 / (4 * attempts)) / attempts,
  );
  return Math.max(0, (center - margin) / denominator);
}

export function estimateStageYieldsV3(
  observations: readonly StageYieldObservationV3[],
): StageYieldEstimateV3[] {
  const byStage = new Map<PipelineV3YieldStage, StageYieldObservationV3>();
  for (const observation of observations) {
    if (byStage.has(observation.stage)) throw new Error(`Stage ${observation.stage} was observed more than once`);
    const entered = nonNegativeInteger(observation.entered, `${observation.stage}.entered`);
    const passed = nonNegativeInteger(observation.passed, `${observation.stage}.passed`);
    if (passed > entered) throw new Error(`Stage ${observation.stage} cannot pass more candidates than entered`);
    byStage.set(observation.stage, { ...observation, entered, passed });
  }
  return PIPELINE_V3_STAGE_ORDER
    .filter((stage) => byStage.has(stage))
    .map((stage) => {
      const observation = byStage.get(stage)!;
      return {
        ...observation,
        observedYield: observation.entered === 0 ? null : observation.passed / observation.entered,
        conservativeYield: observation.entered === 0 ? null : wilsonLowerBound(observation.passed, observation.entered),
      };
    });
}

/**
 * Combine observed stage yields for planning, while retaining a global 20%
 * floor so a low-sample run cannot trigger unbounded provider work.
 */
export function conservativeEndToEndYieldV3(
  observations: readonly StageYieldObservationV3[],
): number {
  const estimates = estimateStageYieldsV3(observations)
    .filter((estimate) => estimate.conservativeYield !== null);
  if (estimates.length === 0) return COLD_START_END_TO_END_YIELD;
  const product = estimates.reduce((yieldValue, estimate) => yieldValue * estimate.conservativeYield!, 1);
  return Math.max(MINIMUM_BOUNDED_YIELD, Math.min(MAXIMUM_BOUNDED_YIELD, product));
}

export function adaptiveFillPlanV3(input: {
  target: number;
  qualified: number;
  stageObservations: readonly StageYieldObservationV3[];
  reserve?: number;
  maximumRawDiscoveryGoal?: number;
}): AdaptiveFillPlanV3 {
  const target = nonNegativeInteger(input.target, "target");
  const qualified = nonNegativeInteger(input.qualified, "qualified");
  const defaultReserve = target === 0 ? 0 : Math.max(10, Math.ceil(target * 0.2));
  const reserve = input.reserve === undefined ? defaultReserve : nonNegativeInteger(input.reserve, "reserve");
  const maximumRawDiscoveryGoal = input.maximumRawDiscoveryGoal === undefined
    ? 5_000
    : Math.max(1, nonNegativeInteger(input.maximumRawDiscoveryGoal, "maximumRawDiscoveryGoal"));
  const qualifiedPoolGoal = target + reserve;
  const qualifiedPoolDeficit = Math.max(0, qualifiedPoolGoal - qualified);
  const conservativeEndToEndYield = conservativeEndToEndYieldV3(input.stageObservations);
  return {
    target,
    reserve,
    qualified,
    targetDeficit: Math.max(0, target - qualified),
    qualifiedPoolGoal,
    qualifiedPoolDeficit,
    conservativeEndToEndYield,
    rawDiscoveryGoal: qualifiedPoolDeficit === 0
      ? 0
      : Math.min(maximumRawDiscoveryGoal, Math.ceil(qualifiedPoolDeficit / conservativeEndToEndYield)),
    stageYields: estimateStageYieldsV3(input.stageObservations),
  };
}

export interface DiscoveryStrategyStateV3 {
  readonly id: string;
  readonly status: "available" | "running" | "exhausted" | "circuit_open" | "forbidden";
  readonly consecutiveZeroYieldRounds: number;
}

export type AdaptiveFillDecisionV3 =
  | { readonly action: "continue"; readonly strategyIds: readonly string[]; readonly reason: "qualified_reserve_missing" }
  | {
    readonly action: "stop";
    readonly reason:
      | "qualified_reserve_satisfied"
      | "deadline_reached"
      | "budget_reached"
      | "provider_circuit_open"
      | "frontier_exhausted";
  };

export function decideAdaptiveFillV3(input: {
  plan: AdaptiveFillPlanV3;
  strategies: readonly DiscoveryStrategyStateV3[];
  deadlineReached: boolean;
  budgetReached: boolean;
}): AdaptiveFillDecisionV3 {
  if (input.plan.qualifiedPoolDeficit === 0) return { action: "stop", reason: "qualified_reserve_satisfied" };
  if (input.deadlineReached) return { action: "stop", reason: "deadline_reached" };
  if (input.budgetReached) return { action: "stop", reason: "budget_reached" };
  const available = input.strategies.filter((strategy) => (
    (strategy.status === "available" || strategy.status === "running")
    && Number.isSafeInteger(strategy.consecutiveZeroYieldRounds)
    && strategy.consecutiveZeroYieldRounds >= 0
    && strategy.consecutiveZeroYieldRounds < 2
  ));
  if (available.length > 0) {
    return { action: "continue", strategyIds: available.map(({ id }) => id), reason: "qualified_reserve_missing" };
  }
  if (input.strategies.length > 0 && input.strategies.every(({ status }) => status === "circuit_open")) {
    return { action: "stop", reason: "provider_circuit_open" };
  }
  return { action: "stop", reason: "frontier_exhausted" };
}
