import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import {
  readOwnedQaWebServerLease,
  terminateOwnedQaWebServer,
} from "../scripts/qa-process-lifecycle.mjs";

const createdDirectories: string[] = [];

async function leaseFixture(token = "owner-token") {
  const directory = join(tmpdir(), `genio-qa-lifecycle-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  createdDirectories.push(directory);
  const leasePath = join(directory, "webserver.json");
  await writeFile(leasePath, JSON.stringify({ ownershipToken: token, pid: 42 }));
  return { leasePath, token };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(createdDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe("browser QA process lifecycle", () => {
  test("rejects a lease that does not belong to the current QA project", async () => {
    const fixture = await leaseFixture("expected-owner");
    await expect(
      readOwnedQaWebServerLease(fixture.leasePath, "different-owner"),
    ).rejects.toThrow(/ownership lease is invalid/u);
  });

  test("waits for graceful webserver group shutdown and removes its lease", async () => {
    const fixture = await leaseFixture();
    let alive = true;
    const signals: string[] = [];
    const result = await terminateOwnedQaWebServer({
      leasePath: fixture.leasePath,
      ownershipToken: fixture.token,
      processGroupIsAlive: () => alive,
      signalProcessGroup: (_pid, signal) => {
        signals.push(signal);
        alive = false;
      },
      pause: async () => undefined,
    });

    expect(result).toEqual({ found: true, stopped: true });
    expect(signals).toEqual(["SIGTERM"]);
    await expect(readOwnedQaWebServerLease(
      fixture.leasePath,
      fixture.token,
    )).resolves.toBeNull();
  });

  test("escalates only the leased group when graceful shutdown stalls", async () => {
    const fixture = await leaseFixture();
    let alive = true;
    const signals: Array<{ pid: number; signal: string }> = [];
    const result = await terminateOwnedQaWebServer({
      leasePath: fixture.leasePath,
      ownershipToken: fixture.token,
      gracefulTimeoutMs: 1,
      forceTimeoutMs: 1,
      pollMs: 1,
      processGroupIsAlive: () => alive,
      signalProcessGroup: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGKILL") alive = false;
      },
      pause: async () => undefined,
    });

    expect(result).toEqual({ found: true, stopped: true });
    expect(signals).toEqual([
      { pid: 42, signal: "SIGTERM" },
      { pid: 42, signal: "SIGKILL" },
    ]);
  });

  test("stops a still-live leased group after its wrapper leader exits", async () => {
    const fixture = await leaseFixture();
    let groupAlive = true;
    const signals: Array<{ pid: number; signal: string }> = [];

    // The lease deliberately remains after the wrapper process exits. Group
    // liveness, rather than leader PID liveness, must drive outer cleanup.
    await expect(readOwnedQaWebServerLease(
      fixture.leasePath,
      fixture.token,
    )).resolves.toEqual({ pid: 42 });

    const result = await terminateOwnedQaWebServer({
      leasePath: fixture.leasePath,
      ownershipToken: fixture.token,
      processGroupIsAlive: () => groupAlive,
      signalProcessGroup: (pid, signal) => {
        signals.push({ pid, signal });
        groupAlive = false;
      },
      pause: async () => undefined,
    });

    expect(result).toEqual({ found: true, stopped: true });
    expect(signals).toEqual([{ pid: 42, signal: "SIGTERM" }]);
    await expect(readOwnedQaWebServerLease(
      fixture.leasePath,
      fixture.token,
    )).resolves.toBeNull();
  });
});
