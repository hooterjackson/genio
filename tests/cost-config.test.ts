import { describe, expect, test } from "vitest";
import { initialApprovedBudgetUsd, readCostConfiguration } from "../server/cost-config.ts";

describe("fail-closed cost configuration", () => {
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
