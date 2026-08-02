import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  parseV254DirectExposureRuntimeArgsV1,
} from "../scripts/promote-v254-direct-exposure.ts";

const revision = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;

function commonArgs(): string[] {
  return [
    "--promotion-receipt", "/tmp/promotion.json",
    "--candidate-tag", "v2.5.4-rc.1",
    "--source-revision", revision,
    "--version", "2.5.4",
    "--image-digest", imageDigest,
    "--project-id", "11111111-1111-4111-8111-111111111111",
    "--environment", "production",
    "--interactive-service", "22222222-2222-4222-8222-222222222222",
    "--deep-service", "33333333-3333-4333-8333-333333333333",
    "--api-service", "44444444-4444-4444-8444-444444444444",
    "--origin", "https://9enio.com",
    "--deployment-timeout-seconds", "600",
    "--poll-interval-seconds", "10",
    "--output", "/tmp/direct-runtime.json",
  ];
}

const protectedArgs = [
  "--authority", "/tmp/authority.json",
  "--rollback-warrant", "/tmp/warrant.json",
  "--verification-key", "/tmp/public.pem",
  "--expected-key-id", "v254-direct-rollout-v1",
  "--expected-key-sha256", "c".repeat(64),
] as const;

describe("v2.5.4 direct exposure runtime", () => {
  test("keeps prepare read-only and requires all protected inputs for mutation", () => {
    expect(parseV254DirectExposureRuntimeArgsV1([
      "prepare",
      ...commonArgs(),
    ])).toMatchObject({
      operation: "prepare",
      authorityPath: null,
      rollbackWarrantPath: null,
      sourceRevision: revision,
      imageDigest,
    });
    expect(() => parseV254DirectExposureRuntimeArgsV1([
      "prepare",
      ...commonArgs(),
      ...protectedArgs,
    ])).toThrow(/protected inputs are inconsistent/u);
    expect(() => parseV254DirectExposureRuntimeArgsV1([
      "apply",
      ...commonArgs(),
    ])).toThrow(/protected inputs are inconsistent/u);
    expect(parseV254DirectExposureRuntimeArgsV1([
      "rollback",
      ...commonArgs(),
      ...protectedArgs,
    ])).toMatchObject({
      operation: "rollback",
      authorityPath: "/tmp/authority.json",
      rollbackWarrantPath: "/tmp/warrant.json",
    });
  });

  test("uses existing immutable deployments workers-first, API-last, with two heartbeat samples", async () => {
    const source = await readFile(new URL(
      "../scripts/promote-v254-direct-exposure.ts",
      import.meta.url,
    ), "utf8");
    const interactive = source.indexOf(
      "serviceId: args.services.interactive",
    );
    const deep = source.indexOf("serviceId: args.services.deep", interactive);
    const firstHeartbeat = source.indexOf(
      "waitForExclusiveCandidateHeartbeats",
      deep,
    );
    const thirtySeconds = source.indexOf("runtime.wait(30_000)", firstHeartbeat);
    const secondHeartbeat = source.indexOf(
      "workerHeartbeatSnapshot",
      thirtySeconds,
    );
    const api = source.indexOf("serviceId: args.services.api", secondHeartbeat);

    expect(interactive).toBeGreaterThanOrEqual(0);
    expect(deep).toBeGreaterThan(interactive);
    expect(firstHeartbeat).toBeGreaterThan(deep);
    expect(thirtySeconds).toBeGreaterThan(firstHeartbeat);
    expect(secondHeartbeat).toBeGreaterThan(thirtySeconds);
    expect(api).toBeGreaterThan(secondHeartbeat);
    expect(source).toContain("assertWorkerHeartbeatFence");
    expect(source).toContain("promotion.imageReference");
    expect(source).toContain("promotion.imageDigest");
    expect(source).toContain("--skip-deploys");
    expect(source).toContain("RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH");
    expect(source).toContain("`${key}=`");
    expect(source).not.toMatch(/\brailway\s+up\b/u);
    expect(source).not.toContain("--from-source");
    expect(source).not.toMatch(/service\s+create/u);
  });

  test("requires the actual protocol-12 health field and honest exposure class", async () => {
    const source = await readFile(new URL(
      "../scripts/promote-v254-direct-exposure.ts",
      import.meta.url,
    ), "utf8");
    expect(source).toContain(
      'record(input.system.workerProtocol, "worker protocol").actual',
    );
    expect(source).toContain('"playlist-pipeline-v12"');
    expect(source).toContain('"fully_exposed_unproven"');
    expect(source).toContain("organicReliabilityProven: false");
  });
});
