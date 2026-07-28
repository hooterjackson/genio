import { describe, expect, test } from "vitest";
import {
  DATABASE_SCHEMA_SUPPORT,
  DATABASE_SCHEMA_V13_BRIDGE_SUPPORT,
  databaseSchemaCompatibility,
  isDatabaseSchemaVersionCompatible,
} from "../db/index.ts";

describe("database schema rollout compatibility", () => {
  test("keeps the compatibility bridge healthy on schemas 13 through 18 without admitting schema 12", () => {
    expect(isDatabaseSchemaVersionCompatible("12", DATABASE_SCHEMA_V13_BRIDGE_SUPPORT)).toBe(false);
    expect(isDatabaseSchemaVersionCompatible("13", DATABASE_SCHEMA_V13_BRIDGE_SUPPORT)).toBe(true);
    expect(isDatabaseSchemaVersionCompatible("14", DATABASE_SCHEMA_V13_BRIDGE_SUPPORT)).toBe(true);
    expect(isDatabaseSchemaVersionCompatible("15", DATABASE_SCHEMA_V13_BRIDGE_SUPPORT)).toBe(true);
    expect(isDatabaseSchemaVersionCompatible("16", DATABASE_SCHEMA_V13_BRIDGE_SUPPORT)).toBe(true);
    expect(isDatabaseSchemaVersionCompatible("17", DATABASE_SCHEMA_V13_BRIDGE_SUPPORT)).toBe(true);
    expect(isDatabaseSchemaVersionCompatible("18", DATABASE_SCHEMA_V13_BRIDGE_SUPPORT)).toBe(true);
    expect(isDatabaseSchemaVersionCompatible("13", DATABASE_SCHEMA_SUPPORT)).toBe(true);
    expect(isDatabaseSchemaVersionCompatible("14", DATABASE_SCHEMA_SUPPORT)).toBe(true);
    expect(isDatabaseSchemaVersionCompatible("15", DATABASE_SCHEMA_SUPPORT)).toBe(true);
    expect(isDatabaseSchemaVersionCompatible("16", DATABASE_SCHEMA_SUPPORT)).toBe(true);
    expect(isDatabaseSchemaVersionCompatible("17", DATABASE_SCHEMA_SUPPORT)).toBe(true);
    expect(isDatabaseSchemaVersionCompatible("18", DATABASE_SCHEMA_SUPPORT)).toBe(true);
  });

  test.each([
    [null, "uninitialized"],
    ["garbage", "malformed"],
    ["12", "too_old"],
    ["13", "compatible"],
    ["14", "compatible"],
    ["15", "compatible"],
    ["16", "compatible"],
    ["17", "compatible"],
    ["18", "compatible"],
    ["19", "too_new"],
  ] as const)("classifies observed schema %s as %s", (actual, expected) => {
    expect(databaseSchemaCompatibility(actual, DATABASE_SCHEMA_SUPPORT)).toBe(expected);
  });

  test("rejects malformed compatibility ranges instead of comparing strings", () => {
    expect(databaseSchemaCompatibility("13", {
      minimum: "14",
      preferred: "13",
      maximum: "12",
    })).toBe("malformed");
  });
});
