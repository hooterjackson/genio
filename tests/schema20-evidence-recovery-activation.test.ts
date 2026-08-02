import { afterEach, describe, expect, test, vi } from "vitest";
import {
  schema20EvidenceRecoveryDatabaseConfig,
} from "../scripts/activate-schema20-evidence-recovery.ts";

describe("schema-20 evidence recovery database transport", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("prefers the runner-reachable public URL with explicit TLS", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://internal/needle");
    vi.stubEnv("DATABASE_PUBLIC_URL", "postgresql://public/needle");
    expect(schema20EvidenceRecoveryDatabaseConfig()).toEqual({
      connectionString: "postgresql://public/needle",
      ssl: { rejectUnauthorized: false },
    });
  });

  test("falls back to the Railway-internal URL without TLS overrides", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://internal/needle");
    vi.stubEnv("DATABASE_PUBLIC_URL", "");
    expect(schema20EvidenceRecoveryDatabaseConfig()).toEqual({
      connectionString: "postgresql://internal/needle",
    });
  });

  test("fails closed when neither database URL is available", () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("DATABASE_PUBLIC_URL", "");
    expect(() => schema20EvidenceRecoveryDatabaseConfig()).toThrow(
      "database_url_missing",
    );
  });
});
