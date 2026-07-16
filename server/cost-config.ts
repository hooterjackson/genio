const MAX_CONFIGURED_BUDGET_USD = 10_000;
const MAX_INPUT_OUTPUT_PRICE_USD_PER_MILLION = 10_000;
const MAX_WEB_SEARCH_PRICE_USD = 100;
export const OPENAI_PRICING_VERSION = "2026-07-16";

export interface CostConfiguration {
  autoRunCostLimitUsd: number;
  monthlyCostLimitUsd: number;
  openAIInputUsdPerMillion: number;
  openAIOutputUsdPerMillion: number;
  openAIWebSearchUsd: number;
}

export interface OpenAITokenPricing {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
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

/**
 * The service uses Sol-equivalent prices as its conservative base. Luna and
 * Terra defaults follow their published 1/5 and 1/2 relative rate-card tiers;
 * every value remains independently overridable when the API price changes.
 */
export function readOpenAITokenPricing(
  model: string,
  environment: Environment = process.env,
): OpenAITokenPricing {
  const base = readCostConfiguration(environment);
  const normalized = model.trim().toLowerCase();
  if (normalized.includes("gpt-5.4-mini")) {
    return {
      inputUsdPerMillion: positiveBoundedNumber(environment, "OPENAI_GPT_5_4_MINI_INPUT_USD_PER_MILLION", 0.75, MAX_INPUT_OUTPUT_PRICE_USD_PER_MILLION),
      cachedInputUsdPerMillion: positiveBoundedNumber(environment, "OPENAI_GPT_5_4_MINI_CACHED_INPUT_USD_PER_MILLION", 0.075, MAX_INPUT_OUTPUT_PRICE_USD_PER_MILLION),
      outputUsdPerMillion: positiveBoundedNumber(environment, "OPENAI_GPT_5_4_MINI_OUTPUT_USD_PER_MILLION", 4.5, MAX_INPUT_OUTPUT_PRICE_USD_PER_MILLION),
    };
  }
  if (normalized.includes("luna")) {
    return {
      inputUsdPerMillion: positiveBoundedNumber(environment, "OPENAI_LUNA_INPUT_USD_PER_MILLION", base.openAIInputUsdPerMillion * 0.2, MAX_INPUT_OUTPUT_PRICE_USD_PER_MILLION),
      cachedInputUsdPerMillion: positiveBoundedNumber(environment, "OPENAI_LUNA_CACHED_INPUT_USD_PER_MILLION", base.openAIInputUsdPerMillion * 0.02, MAX_INPUT_OUTPUT_PRICE_USD_PER_MILLION),
      outputUsdPerMillion: positiveBoundedNumber(environment, "OPENAI_LUNA_OUTPUT_USD_PER_MILLION", base.openAIOutputUsdPerMillion * 0.2, MAX_INPUT_OUTPUT_PRICE_USD_PER_MILLION),
    };
  }
  if (normalized.includes("terra")) {
    return {
      inputUsdPerMillion: positiveBoundedNumber(environment, "OPENAI_TERRA_INPUT_USD_PER_MILLION", base.openAIInputUsdPerMillion * 0.5, MAX_INPUT_OUTPUT_PRICE_USD_PER_MILLION),
      cachedInputUsdPerMillion: positiveBoundedNumber(environment, "OPENAI_TERRA_CACHED_INPUT_USD_PER_MILLION", base.openAIInputUsdPerMillion * 0.05, MAX_INPUT_OUTPUT_PRICE_USD_PER_MILLION),
      outputUsdPerMillion: positiveBoundedNumber(environment, "OPENAI_TERRA_OUTPUT_USD_PER_MILLION", base.openAIOutputUsdPerMillion * 0.5, MAX_INPUT_OUTPUT_PRICE_USD_PER_MILLION),
    };
  }
  return {
    inputUsdPerMillion: base.openAIInputUsdPerMillion,
    cachedInputUsdPerMillion: base.openAIInputUsdPerMillion * 0.1,
    outputUsdPerMillion: base.openAIOutputUsdPerMillion,
  };
}

/**
 * GPT-5.6 Sol and Terra apply long-context multipliers above 272K input
 * tokens. Luna and GPT-5.4 mini do not advertise that surcharge.
 */
export function openAIContextPriceMultipliers(
  model: string,
  inputTokens: number,
): { input: number; output: number } {
  const normalized = model.trim().toLowerCase();
  const longContextModel = normalized === "gpt-5.6"
    || normalized.includes("gpt-5.6-sol")
    || normalized.includes("gpt-5.6-terra");
  return longContextModel && inputTokens > 272_000
    ? { input: 2, output: 1.5 }
    : { input: 1, output: 1 };
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
