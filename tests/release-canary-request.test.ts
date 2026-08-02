import { describe, expect, test } from "vitest";
import { signReleaseCanaryMetadata } from "../server/release-canary-metadata.ts";
import {
  authenticateReleaseCanary,
  manifestOnlyReleaseCanaryAllowed,
} from "../server/release-canary-request.ts";

const secret = "release-canary-test-secret-with-at-least-32-bytes";
const revision = "a".repeat(40);
const issuedAt = "2026-07-23T12:00:00.000Z";
const audience = "https://staging.9enio.example";

function marker(operation: "brief" | "run" = "brief") {
  return signReleaseCanaryMetadata({
    version: "genio-release-canary/v1",
    canaryId: "rc-2.4.0-reggaeton",
    environment: "staging",
    audience,
    operation,
    sourceRevision: revision,
    issuedAt,
    cacheMode: "reuse_disabled",
  }, secret);
}

const environment = {
  RELEASE_CANARY_HMAC_SECRET: secret,
  RELEASE_ENVIRONMENT: "staging",
  SOURCE_COMMIT_SHA: revision,
  APP_VERSION: "2.4.0",
  APP_ORIGIN: audience,
};

describe("authenticated release canary requests", () => {
  test("requires a signed canary and a production assignment pause", () => {
    expect(manifestOnlyReleaseCanaryAllowed({
      releaseEnvironment: "staging",
      signedCanary: true,
      publicAssignmentPaused: false,
    })).toBe(true);
    expect(manifestOnlyReleaseCanaryAllowed({
      releaseEnvironment: "production",
      signedCanary: true,
      publicAssignmentPaused: true,
    })).toBe(true);
    expect(manifestOnlyReleaseCanaryAllowed({
      releaseEnvironment: "production",
      signedCanary: true,
      publicAssignmentPaused: false,
    })).toBe(false);
    expect(manifestOnlyReleaseCanaryAllowed({
      releaseEnvironment: "production",
      signedCanary: true,
      publicAssignmentPaused: false,
      signedDirectExposureActive: true,
    })).toBe(true);
    expect(manifestOnlyReleaseCanaryAllowed({
      releaseEnvironment: "production",
      signedCanary: false,
      publicAssignmentPaused: false,
      signedDirectExposureActive: true,
    })).toBe(false);
    expect(manifestOnlyReleaseCanaryAllowed({
      releaseEnvironment: "production",
      signedCanary: false,
      publicAssignmentPaused: true,
    })).toBe(false);
    expect(manifestOnlyReleaseCanaryAllowed({
      releaseEnvironment: null,
      signedCanary: true,
      publicAssignmentPaused: true,
    })).toBe(false);
  });

  test("leaves ordinary public requests unmarked", () => {
    expect(authenticateReleaseCanary(undefined, "brief", {})).toBeNull();
  });

  test("accepts a current marker bound to this artifact and operation", () => {
    expect(authenticateReleaseCanary(
      marker(),
      "brief",
      environment,
      "2026-07-23T12:03:00.000Z",
    )).toMatchObject({
      canaryId: "rc-2.4.0-reggaeton",
      operation: "brief",
      sourceRevision: revision,
      audience,
    });
  });

  test("rejects self-labeling, stale, cross-operation, and cross-revision markers", () => {
    expect(() => authenticateReleaseCanary(
      { ...marker(), signature: "0".repeat(64) },
      "brief",
      environment,
      "2026-07-23T12:03:00.000Z",
    )).toThrowError(expect.objectContaining({ code: "invalid_release_canary" }));
    expect(() => authenticateReleaseCanary(
      marker(),
      "brief",
      environment,
      "2026-07-23T12:06:00.001Z",
    )).toThrowError(expect.objectContaining({ code: "invalid_release_canary" }));
    expect(() => authenticateReleaseCanary(
      marker("run"),
      "brief",
      environment,
      "2026-07-23T12:03:00.000Z",
    )).toThrowError(expect.objectContaining({ code: "invalid_release_canary" }));
    expect(() => authenticateReleaseCanary(
      marker(),
      "brief",
      { ...environment, SOURCE_COMMIT_SHA: "b".repeat(40) },
      "2026-07-23T12:03:00.000Z",
    )).toThrowError(expect.objectContaining({ code: "invalid_release_canary" }));
    expect(() => authenticateReleaseCanary(
      marker(),
      "brief",
      { ...environment, APP_ORIGIN: "https://other.example" },
      "2026-07-23T12:03:00.000Z",
    )).toThrowError(expect.objectContaining({ code: "invalid_release_canary" }));
  });

  test("fails closed when a marker is supplied to an unconfigured runtime", () => {
    expect(() => authenticateReleaseCanary(marker(), "brief", {}))
      .toThrowError(expect.objectContaining({ code: "release_canary_unavailable" }));
    expect(() => authenticateReleaseCanary(marker(), "brief", {
      RELEASE_CANARY_HMAC_SECRET: secret,
      SOURCE_COMMIT_SHA: revision,
      APP_ORIGIN: audience,
    })).toThrowError(expect.objectContaining({ code: "release_canary_unavailable" }));
  });
});
