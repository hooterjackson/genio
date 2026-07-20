import { expect, test } from "vitest";
import {
  appleWriteTokenWaitMs,
  readAppleWriteRatePolicy,
  refillAppleWriteTokenBucket,
} from "../server/apple-write-gateway.ts";

test("Apple write rate policy is bounded even when deployment values are malformed or excessive", () => {
  expect(readAppleWriteRatePolicy({
    APPLE_WRITE_TOKEN_CAPACITY: "999",
    APPLE_WRITE_TOKEN_REFILL_PER_SECOND: "0",
    APPLE_WRITE_LOCK_WAIT_MS: "999999999",
  } as NodeJS.ProcessEnv)).toEqual({
    capacity: 20,
    refillPerSecond: 0.25,
    lockWaitMs: 300_000,
  });
  expect(readAppleWriteRatePolicy({
    APPLE_WRITE_TOKEN_CAPACITY: "not-a-number",
    APPLE_WRITE_TOKEN_REFILL_PER_SECOND: "not-a-number",
    APPLE_WRITE_LOCK_WAIT_MS: "not-a-number",
  } as NodeJS.ProcessEnv)).toEqual({
    capacity: 4,
    refillPerSecond: 2,
    lockWaitMs: 60_000,
  });
});

test("token-bucket refill is monotonic, capacity bounded, and robust to clock rollback", () => {
  const policy = { capacity: 4, refillPerSecond: 2 };
  expect(refillAppleWriteTokenBucket({
    state: { tokens: 0, updatedAtMs: 1_000 },
    nowMs: 2_500,
    policy,
  })).toEqual({ tokens: 3, updatedAtMs: 2_500 });
  expect(refillAppleWriteTokenBucket({
    state: { tokens: 3.5, updatedAtMs: 1_000 },
    nowMs: 20_000,
    policy,
  })).toEqual({ tokens: 4, updatedAtMs: 20_000 });
  expect(refillAppleWriteTokenBucket({
    state: { tokens: 1.25, updatedAtMs: 10_000 },
    nowMs: 5_000,
    policy,
  })).toEqual({ tokens: 1.25, updatedAtMs: 5_000 });
});

test("token wait computes the bounded delay until the next mutation permit", () => {
  expect(appleWriteTokenWaitMs(1, 2)).toBe(0);
  expect(appleWriteTokenWaitMs(0.5, 2)).toBe(250);
  expect(appleWriteTokenWaitMs(0, 0.25)).toBe(4_000);
});
