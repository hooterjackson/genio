import { describe, expect, test } from "vitest";
import {
  v254GuidanceMigrationDatabaseConfig,
} from "../scripts/v254-guidance-migration-receipt.ts";

describe("v2.5.4 guidance migration database transport", () => {
  test("prefers the runner-reachable public URL with explicit TLS", () => {
    expect(v254GuidanceMigrationDatabaseConfig({
      DATABASE_PUBLIC_URL: "postgresql://public.example/needle",
      DATABASE_URL: "postgresql://postgres.railway.internal/needle",
    })).toEqual({
      connectionString: "postgresql://public.example/needle",
      ssl: { rejectUnauthorized: false },
    });
  });

  test("uses an internal Railway URL without a public TLS override", () => {
    expect(v254GuidanceMigrationDatabaseConfig({
      DATABASE_PUBLIC_URL: "",
      DATABASE_URL: "postgresql://postgres.railway.internal/needle",
    })).toEqual({
      connectionString: "postgresql://postgres.railway.internal/needle",
    });
  });

  test("fails closed instead of silently targeting a local database", () => {
    expect(() => v254GuidanceMigrationDatabaseConfig({
      DATABASE_PUBLIC_URL: "",
      DATABASE_URL: "",
    })).toThrow("guidance_migration_database_url_missing");
  });
});
