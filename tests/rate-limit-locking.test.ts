import { expect, test, vi } from "vitest";
import { Repository } from "../server/repository.ts";

test("locks each client-bucket alias in stable order before consuming a rate limit", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (text.includes("SELECT count(*)::int count FROM rate_limit_events")) {
        return { rows: [{ count: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    end: vi.fn(),
  };
  const repository = new Repository({ pool, db: {} } as never);

  await repository.consumeRateLimit(
    ["today.bucket", "yesterday.bucket", "today.bucket"],
    "mutation",
    10,
    24,
  );

  const locks = calls.filter((call) => call.text.includes("pg_advisory_xact_lock"));
  expect(locks.map((call) => call.values[0])).toEqual([
    "rate:mutation:today.bucket",
    "rate:mutation:yesterday.bucket",
  ]);
  expect(calls.find((call) => call.text.includes("INSERT INTO rate_limit_events"))?.values).toEqual([
    "today.bucket",
    "mutation",
  ]);
});

test("rejects rate-limit operations without a client identity before opening a transaction", async () => {
  const pool = {
    connect: vi.fn(),
    end: vi.fn(),
  };
  const repository = new Repository({ pool, db: {} } as never);

  await expect(repository.consumeRateLimit([], "mutation", 10, 24)).rejects.toMatchObject({
    statusCode: 401,
    code: "invalid_gateway_identity",
  });
  expect(pool.connect).not.toHaveBeenCalled();
});
