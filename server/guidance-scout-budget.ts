import {
  openAIContextPriceMultipliers,
  readCostConfiguration,
  readOpenAITokenPricing,
} from "./cost-config.ts";

/**
 * Hosted low-context search is deliberately budgeted as an additional input
 * allowance. The Responses API still owns the exact retrieved context, so the
 * scout may run only when this conservative envelope fits before the call.
 */
export const GUIDANCE_SCOUT_SEARCH_CONTEXT_TOKEN_ALLOWANCE = 4_096;
export const GUIDANCE_SCOUT_REQUEST_TOKEN_OVERHEAD = 1_024;

export interface GuidanceScoutCostEnvelope {
  inputTokenUpperBound: number;
  outputTokenUpperBound: number;
  webSearchCallUpperBound: number;
  maximumCostUsd: number;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : 0;
}

/**
 * Calculates a pre-spend upper envelope from the actual serialized request.
 * One UTF-8 byte per token is intentionally pessimistic for caller-owned text.
 * The separate search-context allowance covers provider-retrieved snippets.
 */
export function guidanceScoutCostEnvelope(
  body: Record<string, unknown>,
): GuidanceScoutCostEnvelope {
  const model = typeof body.model === "string" ? body.model : "";
  const pricing = readOpenAITokenPricing(model);
  const cost = readCostConfiguration();
  const outputTokenUpperBound = nonNegativeInteger(body.max_output_tokens);
  const webSearchCallUpperBound = nonNegativeInteger(body.max_tool_calls);
  const requestBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  const inputTokenUpperBound = requestBytes
    + GUIDANCE_SCOUT_REQUEST_TOKEN_OVERHEAD
    + webSearchCallUpperBound * GUIDANCE_SCOUT_SEARCH_CONTEXT_TOKEN_ALLOWANCE;
  const multipliers = openAIContextPriceMultipliers(model, inputTokenUpperBound);
  const maximumCostUsd = inputTokenUpperBound / 1_000_000
      * pricing.inputUsdPerMillion * multipliers.input
    + outputTokenUpperBound / 1_000_000
      * pricing.outputUsdPerMillion * multipliers.output
    + webSearchCallUpperBound * cost.openAIWebSearchUsd;
  return {
    inputTokenUpperBound,
    outputTokenUpperBound,
    webSearchCallUpperBound,
    maximumCostUsd: Math.ceil(maximumCostUsd * 1_000_000) / 1_000_000,
  };
}

export function guidanceScoutRequestFitsBudget(
  body: Record<string, unknown>,
  remainingBudgetUsd: number,
): boolean {
  if (!Number.isFinite(remainingBudgetUsd) || remainingBudgetUsd < 0) return false;
  return guidanceScoutCostEnvelope(body).maximumCostUsd <= remainingBudgetUsd + 0.000001;
}
