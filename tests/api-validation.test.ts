import { describe, expect, test } from "vitest";
import { positiveIntegerQuery } from "../server/api-validation.ts";

describe("positiveIntegerQuery", () => {
  test("uses the configured fallback when the query is omitted", () => {
    expect(positiveIntegerQuery(undefined, 20, "Page size", 100)).toBe(20);
  });

  test("accepts positive decimal integer strings through the configured maximum", () => {
    expect(positiveIntegerQuery("1", 20, "Page size", 100)).toBe(1);
    expect(positiveIntegerQuery("100", 20, "Page size", 100)).toBe(100);
  });

  test.each([
    ["zero", "0"],
    ["negative", "-1"],
    ["decimal", "1.5"],
    ["scientific notation", "1e2"],
    ["leading whitespace", " 2"],
    ["trailing whitespace", "2 "],
    ["leading zero", "02"],
    ["not a number", "NaN"],
    ["non-string", 2],
  ])("rejects %s pagination values", (_label, value) => {
    expect(() => positiveIntegerQuery(value, 20, "Page size", 100)).toThrowError(
      expect.objectContaining({ statusCode: 400, code: "invalid_pagination" }),
    );
  });

  test("rejects unsafe and over-limit integers", () => {
    expect(() => positiveIntegerQuery("101", 20, "Page size", 100)).toThrowError(
      expect.objectContaining({ statusCode: 400, code: "invalid_pagination" }),
    );
    expect(() => positiveIntegerQuery("9007199254740992", 20, "Page size", Number.MAX_SAFE_INTEGER)).toThrowError(
      expect.objectContaining({ statusCode: 400, code: "invalid_pagination" }),
    );
  });
});
