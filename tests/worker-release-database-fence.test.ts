import { describe, expect, test, vi } from "vitest";
import {
  CANONICAL_ACTIVATION_DATABASE_CAPABILITY_SETTING,
  CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_SETTING,
  CANONICAL_EXECUTOR_RELEASE_IDENTITY_DATABASE_CAPABILITY_SETTING,
} from "../server/release-deployment-phase.ts";
import { WorkerRunner } from "../server/worker-runner.ts";

const productionActivateEnvironment = {
  NODE_ENV: "production",
  RELEASE_ENVIRONMENT: "production",
  RELEASE_DEPLOYMENT_PHASE: "activate",
  RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: "18",
  RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
  RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
  RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
  RELEASE_EXECUTION_ENABLED: "true",
  PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "5",
  OPENAI_API_KEY: "test-openai-key",
  APPLE_TEAM_ID: "test-team",
  APPLE_KEY_ID: "test-key",
  APPLE_MEDIA_ID: "test-media",
  APPLE_MUSICKIT_PRIVATE_KEY_BASE64: "test-private-key",
} satisfies NodeJS.ProcessEnv;

function repositoryHarness(input: {
  schemaVersion: string | null;
  capabilityVersion: string | null;
  hardeningVersion: string | null;
  releaseIdentityVersion?: string | null;
  releaseIdentitySupported?: boolean;
}) {
  return {
    ensureSchemaVersion: vi.fn(async () => undefined),
    getSchemaVersion: vi.fn(async () => input.schemaVersion),
    getSetting: vi.fn(async (key: string) =>
      key === CANONICAL_ACTIVATION_DATABASE_CAPABILITY_SETTING
        ? input.capabilityVersion
        : key === CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_SETTING
          ? input.hardeningVersion
          : key
            === CANONICAL_EXECUTOR_RELEASE_IDENTITY_DATABASE_CAPABILITY_SETTING
            ? input.releaseIdentityVersion === undefined
              ? "1"
              : input.releaseIdentityVersion
          : null),
    executorReleaseIdentityFenceAvailable: vi.fn(
      async () => input.releaseIdentitySupported ?? true,
    ),
    updateWorkerHeartbeat: vi.fn(async () => undefined),
    leaseNextJob: vi.fn(async () => null),
  } as any;
}

function runner(repository: any): WorkerRunner {
  return new WorkerRunner(repository, {
    environment: productionActivateEnvironment,
    queueClass: "deep",
    concurrency: 1,
    pollMs: 5,
    heartbeatMs: 60_000,
    controlIntervalMs: 60_000,
  });
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for worker state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("worker release database fence", () => {
  test("production activation cannot start or lease against schema 17", async () => {
    const repository = repositoryHarness({
      schemaVersion: "17",
      capabilityVersion: "1",
      hardeningVersion: "1",
    });

    await expect(runner(repository).run()).rejects.toThrow(
      /release database readiness check failed/u,
    );
    expect(repository.updateWorkerHeartbeat).not.toHaveBeenCalled();
    expect(repository.leaseNextJob).not.toHaveBeenCalled();
  });

  test("production activation cannot start or lease without the schema-18 capability", async () => {
    const repository = repositoryHarness({
      schemaVersion: "18",
      capabilityVersion: null,
      hardeningVersion: "1",
    });

    await expect(runner(repository).run()).rejects.toThrow(
      /release database readiness check failed/u,
    );
    expect(repository.updateWorkerHeartbeat).not.toHaveBeenCalled();
    expect(repository.leaseNextJob).not.toHaveBeenCalled();
  });

  test("a capability lost after startup is rechecked before the next lease", async () => {
    const repository = repositoryHarness({
      schemaVersion: "18",
      capabilityVersion: "1",
      hardeningVersion: "1",
    });
    let capabilityChecks = 0;
    repository.getSetting.mockImplementation(async (key: string) => {
      if (key === CANONICAL_EXECUTION_HARDENING_DATABASE_CAPABILITY_SETTING) {
        return "1";
      }
      if (
        key
          === CANONICAL_EXECUTOR_RELEASE_IDENTITY_DATABASE_CAPABILITY_SETTING
      ) {
        return "1";
      }
      if (key !== CANONICAL_ACTIVATION_DATABASE_CAPABILITY_SETTING) return null;
      capabilityChecks += 1;
      return capabilityChecks === 1 ? "1" : null;
    });

    await expect(runner(repository).run()).rejects.toThrow(
      /release database readiness check failed/u,
    );
    expect(repository.updateWorkerHeartbeat).toHaveBeenCalledTimes(1);
    expect(repository.leaseNextJob).not.toHaveBeenCalled();
  });

  test("production activation rejects a missing or partial 0020 fence", async () => {
    for (const releaseIdentity of [
      { releaseIdentityVersion: null, releaseIdentitySupported: true },
      { releaseIdentityVersion: "1", releaseIdentitySupported: false },
    ]) {
      const repository = repositoryHarness({
        schemaVersion: "18",
        capabilityVersion: "1",
        hardeningVersion: "1",
        ...releaseIdentity,
      });
      await expect(runner(repository).run()).rejects.toThrow(
        /release database readiness check failed/u,
      );
      expect(repository.updateWorkerHeartbeat).not.toHaveBeenCalled();
      expect(repository.leaseNextJob).not.toHaveBeenCalled();
    }
  });

  test("production activation with schema 18 and its capability may lease", async () => {
    const repository = repositoryHarness({
      schemaVersion: "18",
      capabilityVersion: "1",
      hardeningVersion: "1",
    });
    const worker = runner(repository);
    const running = worker.run();
    try {
      await waitFor(() => repository.leaseNextJob.mock.calls.length > 0);
      expect(repository.updateWorkerHeartbeat).toHaveBeenCalledTimes(1);
      expect(repository.leaseNextJob).toHaveBeenCalledTimes(1);
    } finally {
      await worker.stop();
      await running;
    }
  });
});
