import { describe, expect, test, vi } from "vitest";
import { AppleApiError } from "../server/apple.ts";
import {
  AppleProviderControl,
  isAppleProviderCircuitOpening,
} from "../server/apple-provider-control.ts";

describe("shared Apple provider control", () => {
  test("begins at six concurrent reads and never exceeds the configured gate", async () => {
    const control = new AppleProviderControl({ recoverySuccesses: 100 });
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const operations = Array.from({ length: 12 }, () => control.execute(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await blocked;
      active -= 1;
      return "ok";
    }));

    await vi.waitFor(() => expect(control.snapshot().activeRequests).toBe(6));
    expect(peak).toBe(6);
    release();
    await expect(Promise.all(operations)).resolves.toHaveLength(12);
    expect(peak).toBe(6);
  });

  test("honors Retry-After and cuts concurrency after an exhausted 429", async () => {
    let instant = 1_000;
    const waits: number[] = [];
    const control = new AppleProviderControl({
      now: () => instant,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        instant += milliseconds;
      },
    });

    await expect(control.execute(async () => {
      throw new AppleApiError("rate limited", 429, true, false, 2_500);
    })).rejects.toMatchObject({ status: 429, retryAfterMs: 2_500 });
    expect(control.snapshot()).toMatchObject({
      currentConcurrency: 3,
      consecutiveTransientFailures: 1,
      blockedUntilMs: 3_500,
    });

    await expect(control.execute(async () => "recovered")).resolves.toBe("recovered");
    expect(waits).toEqual([2_500]);
    expect(control.snapshot()).toMatchObject({
      currentConcurrency: 3,
      consecutiveTransientFailures: 0,
    });
  });

  test("opens after repeated 5xx failures and gradually recovers toward eight", async () => {
    let instant = 10_000;
    const waits: number[] = [];
    const control = new AppleProviderControl({
      transientFailureThreshold: 3,
      circuitCooldownMs: 4_000,
      recoverySuccesses: 2,
      now: () => instant,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        instant += milliseconds;
      },
    });
    const failures = Array.from({ length: 3 }, () => new AppleApiError("Apple unavailable", 503, true));
    for (const failure of failures) {
      await expect(control.execute(async () => {
        throw failure;
      })).rejects.toMatchObject({ status: 503 });
    }
    expect(failures.map(isAppleProviderCircuitOpening)).toEqual([false, false, true]);
    expect(control.snapshot()).toMatchObject({
      currentConcurrency: 3,
      consecutiveTransientFailures: 3,
      blockedUntilMs: 14_000,
    });

    await expect(control.execute(async () => "probe-ok")).resolves.toBe("probe-ok");
    expect(waits).toEqual([4_000]);
    await control.execute(async () => "second-success");
    expect(control.snapshot()).toMatchObject({
      currentConcurrency: 4,
      consecutiveTransientFailures: 0,
    });
    await Promise.all(Array.from({ length: 8 }, () => control.execute(async () => "ok")));
    expect(control.snapshot().currentConcurrency).toBe(8);
  });
});
