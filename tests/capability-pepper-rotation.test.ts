import { describe, expect, test } from "vitest";
import {
  capabilityHash,
  capabilityPepperRotationStatus,
  capabilityVerificationHashes,
  hmacHex,
  sha256Hex,
} from "../server/security.ts";
import {
  apiReleaseConfigurationHash,
  runtimeReleaseContract,
} from "../server/runtime-release.ts";

const now = new Date("2026-07-24T12:00:00.000Z");
const currentPepper = "current-capability-pepper-32-bytes";
const previousPepper = "previous-capability-pepper-32-byte";

function rotatingEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    CAPABILITY_SESSION_TTL_DAYS: "90",
    CAPABILITY_PEPPER: currentPepper,
    CAPABILITY_PEPPER_VERSION: "capability-v2",
    CAPABILITY_PREVIOUS_PEPPER: previousPepper,
    CAPABILITY_PREVIOUS_PEPPER_VERSION: "capability-v1",
    CAPABILITY_PREVIOUS_PEPPER_EXPIRES_AT: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("capability pepper rotation", () => {
  test("mints only with current while verifying current and previous", () => {
    const environment = rotatingEnvironment();
    const token = "test-capability-token";

    expect(capabilityHash(token, environment)).toBe(hmacHex(currentPepper, token));
    expect(capabilityVerificationHashes(token, environment, now)).toEqual([
      hmacHex(currentPepper, token),
      hmacHex(previousPepper, token),
    ]);
  });

  test("exposes only hashes of non-secret version labels", () => {
    const status = capabilityPepperRotationStatus(rotatingEnvironment(), now);

    expect(status).toMatchObject({
      ready: true,
      currentVersionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      previousVersionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      previousVerificationActive: true,
      previousCleanupRequired: false,
      issue: null,
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(currentPepper);
    expect(serialized).not.toContain(previousPepper);
    expect(serialized).not.toContain("capability-v2");
    expect(status.currentVersionHash).not.toBe(sha256Hex(currentPepper));
    expect(status.previousVersionHash).not.toBe(sha256Hex(previousPepper));
  });

  test("binds version identities and overlap deadline into release configuration", () => {
    const environment = rotatingEnvironment();
    const runtime = runtimeReleaseContract(environment);

    expect(runtime).toMatchObject({
      capabilityPepperVersionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      capabilityPreviousPepperVersionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(runtime)).not.toContain(currentPepper);
    expect(JSON.stringify(runtime)).not.toContain(previousPepper);
    expect(JSON.stringify(runtime)).not.toContain("capability-v2");

    const originalHash = apiReleaseConfigurationHash(environment);
    expect(apiReleaseConfigurationHash({
      ...environment,
      CAPABILITY_PREVIOUS_PEPPER_EXPIRES_AT: "2026-09-30T12:00:00.000Z",
    })).not.toBe(originalHash);
    expect(apiReleaseConfigurationHash({
      ...environment,
      CAPABILITY_PEPPER: "different-secret-same-version",
    })).toBe(originalHash);
  });

  test("disables expired legacy verification and keeps cleanup observable", () => {
    const environment = rotatingEnvironment({
      CAPABILITY_PREVIOUS_PEPPER_EXPIRES_AT: "2026-07-24T11:59:59.000Z",
    });
    const token = "expired-overlap-token";
    const status = capabilityPepperRotationStatus(environment, now);

    expect(status).toMatchObject({
      ready: true,
      previousVerificationActive: false,
      previousCleanupRequired: true,
      previousVersionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(capabilityVerificationHashes(token, environment, now)).toEqual([
      hmacHex(currentPepper, token),
    ]);
  });

  test.each([
    [
      "requires the current version in production",
      { CAPABILITY_PEPPER_VERSION: "" },
      "current_version_missing",
    ],
    [
      "requires a version for the previous pepper",
      { CAPABILITY_PREVIOUS_PEPPER_VERSION: "" },
      "previous_version_missing",
    ],
    [
      "rejects reused versions",
      { CAPABILITY_PREVIOUS_PEPPER_VERSION: "capability-v2" },
      "version_reused",
    ],
    [
      "rejects reused pepper material",
      { CAPABILITY_PREVIOUS_PEPPER: currentPepper },
      "pepper_reused",
    ],
    [
      "requires a bounded expiry",
      { CAPABILITY_PREVIOUS_PEPPER_EXPIRES_AT: "" },
      "previous_expiry_missing",
    ],
    [
      "rejects malformed expiry",
      { CAPABILITY_PREVIOUS_PEPPER_EXPIRES_AT: "later" },
      "previous_expiry_invalid",
    ],
    [
      "rejects overlap beyond the active session TTL",
      { CAPABILITY_PREVIOUS_PEPPER_EXPIRES_AT: "2027-07-24T12:00:00.000Z" },
      "previous_expiry_too_long",
    ],
  ] as const)("%s", (_label, overrides, issue) => {
    const environment = rotatingEnvironment(overrides);
    expect(capabilityPepperRotationStatus(environment, now)).toMatchObject({
      ready: false,
      issue,
    });
    expect(() => capabilityVerificationHashes("valid-shaped-token", environment, now))
      .toThrow(/Capability pepper configuration is invalid/u);
  });
});
