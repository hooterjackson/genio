const MAX_CONFIGURED_BUDGET_USD = 10_000;
const MAX_INPUT_OUTPUT_PRICE_USD_PER_MILLION = 10_000;
const MAX_WEB_SEARCH_PRICE_USD = 100;

export interface CostConfiguration {
  autoRunCostLimitUsd: number;
  monthlyCostLimitUsd: number;
  openAIInputUsdPerMillion: number;
  openAIOutputUsdPerMillion: number;
  openAIWebSearchUsd: number;
}

type Environment = Record<string, string | undefined>;

function configuredValue(environment: Environment, primary: string, legacy?: string): {
  name: string;
  value: string | undefined;
} {
  if (environment[primary] !== undefined) return { name: primary, value: environment[primary] };
  if (legacy && environment[legacy] !== undefined) return { name: legacy, value: environment[legacy] };
  return { name: primary, value: undefined };
}

function positiveBoundedNumber(
  environment: Environment,
  primary: string,
  fallback: number,
  maximum: number,
  legacy?: string,
): number {
  const configured = configuredValue(environment, primary, legacy);
  const raw = configured.value ?? String(fallback);
  if (raw.trim() === "") {
    throw new Error(`${configured.name} must be a finite number greater than 0 and at most ${maximum}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new Error(`${configured.name} must be a finite number greater than 0 and at most ${maximum}`);
  }
  return value;
}

/**
 * Cost limits are safety controls, so malformed configuration must stop work
 * instead of silently falling back or turning comparisons into `NaN`.
 */
export function readCostConfiguration(environment: Environment = process.env): CostConfiguration {
  return {
    autoRunCostLimitUsd: positiveBoundedNumber(
      environment,
      "AUTO_RUN_COST_LIMIT_USD",
      5,
      MAX_CONFIGURED_BUDGET_USD,
      "INITIAL_COST_GATE_USD",
    ),
    monthlyCostLimitUsd: positiveBoundedNumber(
      environment,
      "APP_MONTHLY_COST_LIMIT_USD",
      50,
      MAX_CONFIGURED_BUDGET_USD,
      "MONTHLY_RESEARCH_CEILING_USD",
    ),
    openAIInputUsdPerMillion: positiveBoundedNumber(
      environment,
      "OPENAI_INPUT_USD_PER_MILLION",
      5,
      MAX_INPUT_OUTPUT_PRICE_USD_PER_MILLION,
    ),
    openAIOutputUsdPerMillion: positiveBoundedNumber(
      environment,
      "OPENAI_OUTPUT_USD_PER_MILLION",
      30,
      MAX_INPUT_OUTPUT_PRICE_USD_PER_MILLION,
    ),
    openAIWebSearchUsd: positiveBoundedNumber(
      environment,
      "OPENAI_WEB_SEARCH_USD",
      0.01,
      MAX_WEB_SEARCH_PRICE_USD,
    ),
  };
}

export function initialApprovedBudgetUsd(
  estimateUsd: number,
  environment: Environment = process.env,
): number {
  if (!Number.isFinite(estimateUsd) || estimateUsd < 0 || estimateUsd > MAX_CONFIGURED_BUDGET_USD) {
    throw new Error("Research estimate must be a finite non-negative amount within the configured safety bound");
  }
  return estimateUsd <= readCostConfiguration(environment).autoRunCostLimitUsd ? estimateUsd : 0;
}
