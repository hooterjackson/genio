import { describe, expect, test } from "vitest";
import {
  initialApprovedBudgetUsd,
  openAIContextPriceMultipliers,
  readCostConfiguration,
  readOpenAITokenPricing,
} from "../server/cost-config.ts";
import { responseCostUsd } from "../server/openai.ts";

describe("fail-closed cost configuration", () => {
  test("prices Luna and Terra from bounded model-specific tiers", () => {
    expect(readOpenAITokenPricing("gpt-5.4-mini", {})).toEqual({ inputUsdPerMillion: 0.75, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 4.5 });
    expect(readOpenAITokenPricing("gpt-5.6-luna", {})).toEqual({ inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 6 });
    expect(readOpenAITokenPricing("gpt-5.6-terra", {})).toEqual({ inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 15 });
    expect(readOpenAITokenPricing("gpt-5.6-sol", {})).toEqual({ inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 30 });
  });

  test("accounts for cached tokens and documented long-context multipliers", () => {
    expect(responseCostUsd({
      model: "gpt-5.6-luna",
      usage: {
        input_tokens: 1_000_000,
        input_tokens_details: { cached_tokens: 800_000 },
        output_tokens: 100_000,
      },
      output: [],
    })).toBeCloseTo(0.88, 8);
    expect(openAIContextPriceMultipliers("gpt-5.6-terra", 272_001))
      .toEqual({ input: 2, output: 1.5 });
    expect(openAIContextPriceMultipliers("gpt-5.6-luna", 300_000))
      .toEqual({ input: 1, output: 1 });
  });
  test("uses the documented default limits and pricing", () => {
    expect(readCostConfiguration({})).toEqual({
      autoRunCostLimitUsd: 5,
      monthlyCostLimitUsd: 50,
      openAIInputUsdPerMillion: 5,
      openAIOutputUsdPerMillion: 30,
      openAIWebSearchUsd: 0.01,
    });
  });

  test("auto-approves exactly five dollars but requires approval for eight", () => {
    const environment = { AUTO_RUN_COST_LIMIT_USD: "5" };
    expect(initialApprovedBudgetUsd(5, environment)).toBe(5);
    expect(initialApprovedBudgetUsd(8, environment)).toBe(0);
  });

  test.each([
    ["AUTO_RUN_COST_LIMIT_USD", "NaN"],
    ["AUTO_RUN_COST_LIMIT_USD", "Infinity"],
    ["AUTO_RUN_COST_LIMIT_USD", "0"],
    ["AUTO_RUN_COST_LIMIT_USD", "-1"],
    ["AUTO_RUN_COST_LIMIT_USD", "10001"],
    ["APP_MONTHLY_COST_LIMIT_USD", "NaN"],
    ["APP_MONTHLY_COST_LIMIT_USD", "0"],
    ["APP_MONTHLY_COST_LIMIT_USD", "10001"],
    ["OPENAI_INPUT_USD_PER_MILLION", "NaN"],
    ["OPENAI_OUTPUT_USD_PER_MILLION", "0"],
    ["OPENAI_WEB_SEARCH_USD", "Infinity"],
  ])("rejects invalid %s=%s instead of weakening a limit", (name, value) => {
    expect(() => readCostConfiguration({ [name]: value })).toThrow(new RegExp(name));
  });

  test("validates the active legacy aliases", () => {
    expect(readCostConfiguration({
      INITIAL_COST_GATE_USD: "4",
      MONTHLY_RESEARCH_CEILING_USD: "40",
    })).toMatchObject({ autoRunCostLimitUsd: 4, monthlyCostLimitUsd: 40 });
    expect(() => readCostConfiguration({ INITIAL_COST_GATE_USD: "not-a-number" }))
      .toThrow(/INITIAL_COST_GATE_USD/u);
  });
});
