import { describe, expect, test } from "vitest";
import { selectionFallsBelowRequiredMinimum } from "../server/catalog-selection-policy.ts";

describe("catalog selection minimum policy", () => {
  test("automatic publication may lock all strict matches below target as partial", () => {
    expect(selectionFallsBelowRequiredMinimum({
      automatic: true,
      initialRequestSatisfied: false,
      requestedMinimum: 50,
      selectedUniqueCount: 23,
    })).toBe(false);
  });

  test("manual review still blocks an unresolved pool below its confirmed minimum", () => {
    expect(selectionFallsBelowRequiredMinimum({
      automatic: false,
      initialRequestSatisfied: false,
      requestedMinimum: 50,
      selectedUniqueCount: 23,
    })).toBe(true);
  });

  test("a manual exclusion does not reopen a target already satisfied by the safe pool", () => {
    expect(selectionFallsBelowRequiredMinimum({
      automatic: false,
      initialRequestSatisfied: true,
      requestedMinimum: 50,
      selectedUniqueCount: 49,
    })).toBe(false);
  });
});
