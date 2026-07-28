import { describe, expect, test } from "vitest";
import {
  signReleaseCanaryMetadata,
  verifyReleaseCanaryMetadata,
} from "../server/release-canary-metadata.ts";

const secret = "release-canary-secret-with-at-least-32-bytes";
const sourceRevision = "a".repeat(40);
const issuedAt = "2026-07-23T12:00:00.000Z";
const audience = "https://staging.9enio.example";

function signed() {
  return signReleaseCanaryMetadata({
    version: "genio-release-canary/v1",
    canaryId: "affected-regression",
    environment: "staging",
    audience,
    operation: "brief",
    sourceRevision,
    issuedAt,
    cacheMode: "reuse_disabled",
  }, secret);
}

describe("release canary metadata", () => {
  test("authenticates an expiring artifact- and operation-bound marker", () => {
    expect(verifyReleaseCanaryMetadata(signed(), {
      secret,
      expectedEnvironment: "staging",
      expectedAudience: audience,
      expectedOperation: "brief",
      expectedSourceRevision: sourceRevision,
      now: "2026-07-23T12:04:59.000Z",
    })).toMatchObject({
      canaryId: "affected-regression",
      cacheMode: "reuse_disabled",
    });
  });

  test("rejects tampering, replay into another operation, and expiry", () => {
    expect(() => verifyReleaseCanaryMetadata({
      ...signed(),
      canaryId: "fixed-control",
    }, {
      secret,
      expectedEnvironment: "staging",
      expectedAudience: audience,
      expectedOperation: "brief",
      expectedSourceRevision: sourceRevision,
      now: "2026-07-23T12:01:00.000Z",
    })).toThrow(/signature/u);
    expect(() => verifyReleaseCanaryMetadata(signed(), {
      secret,
      expectedEnvironment: "staging",
      expectedAudience: audience,
      expectedOperation: "run",
      expectedSourceRevision: sourceRevision,
      now: "2026-07-23T12:01:00.000Z",
    })).toThrow(/scope/u);
    expect(() => verifyReleaseCanaryMetadata(signed(), {
      secret,
      expectedEnvironment: "staging",
      expectedAudience: audience,
      expectedOperation: "brief",
      expectedSourceRevision: sourceRevision,
      now: "2026-07-23T12:05:01.000Z",
    })).toThrow(/expired/u);
  });

  test("does not accept arbitrary extra fields or a short secret", () => {
    expect(() => verifyReleaseCanaryMetadata({
      ...signed(),
      prompt: "do not retain this",
    }, {
      secret,
      expectedEnvironment: "staging",
      expectedAudience: audience,
      expectedOperation: "brief",
      expectedSourceRevision: sourceRevision,
      now: "2026-07-23T12:01:00.000Z",
    })).toThrow(/invalid_release_canary_metadata/u);
    expect(() => signReleaseCanaryMetadata({
      version: "genio-release-canary/v1",
      canaryId: "fixed-control",
      environment: "production",
      audience: "https://9enio.com",
      operation: "run",
      sourceRevision,
      issuedAt,
      cacheMode: "reuse_disabled",
    }, "short")).toThrow(/too_short/u);
  });

  test("rejects a marker replayed to another origin", () => {
    expect(() => verifyReleaseCanaryMetadata(signed(), {
      secret,
      expectedEnvironment: "staging",
      expectedAudience: "https://attacker.example",
      expectedOperation: "brief",
      expectedSourceRevision: sourceRevision,
      now: "2026-07-23T12:01:00.000Z",
    })).toThrow(/scope/u);
  });
});
