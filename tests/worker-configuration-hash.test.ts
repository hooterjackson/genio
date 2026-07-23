import { describe, expect, test } from "vitest";
import { DATABASE_SCHEMA_SUPPORT } from "../db/index.ts";
import {
  workerConfigurationHash,
  workerExecutorRevision,
} from "../server/worker-runner.ts";
import { WORKER_PIPELINE_CAPABILITY } from "../server/worker-protocol.ts";

function configurationHash(
  environment: NodeJS.ProcessEnv,
  queueClass: "interactive" | "deep" = "interactive",
): string {
  return workerConfigurationHash({
    environment,
    queueClass,
    concurrency: queueClass === "deep" ? 1 : 2,
    leaseMs: 300_000,
    renewMs: 60_000,
    heartbeatMs: 30_000,
    pollMs: 1_000,
    controlIntervalMs: 5_000,
    pipelineCapability: WORKER_PIPELINE_CAPABILITY,
    schemaSupport: DATABASE_SCHEMA_SUPPORT,
  });
}

describe("worker release configuration evidence", () => {
  test("uses the immutable image source revision when Railway has no repository SHA", () => {
    expect(workerExecutorRevision({
      SOURCE_COMMIT_SHA: "a".repeat(40),
      APP_VERSION: "2.4.0",
    })).toBe("a".repeat(40));
    expect(workerExecutorRevision({
      RAILWAY_GIT_COMMIT_SHA: "b".repeat(40),
      SOURCE_COMMIT_SHA: "a".repeat(40),
      APP_VERSION: "2.4.0",
    })).toBe("a".repeat(40));
  });

  test("is deterministic, secret-insensitive, and behavior-sensitive", () => {
    const environment = {
      NODE_ENV: "production",
      PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
      PIPELINE_V3_MAX_ROUNDS: "4",
      OPENAI_API_KEY: "sk-proj-first-secret",
      APPLE_TOKEN_ENCRYPTION_KEY: "first-apple-secret",
    };
    const first = configurationHash(environment);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(configurationHash({
      ...environment,
      OPENAI_API_KEY: "sk-proj-different-secret",
      APPLE_TOKEN_ENCRYPTION_KEY: "different-apple-secret",
    })).toBe(first);
    expect(configurationHash({
      ...environment,
      PIPELINE_V3_MAX_ROUNDS: "5",
    })).not.toBe(first);
    expect(configurationHash(environment, "deep")).not.toBe(first);
  });
});
