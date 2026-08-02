import { describe, expect, test } from "vitest";
import {
  canonicalContractFallbackRequestedV1,
} from "../server/canonical-contract-route-authority-v1.ts";

const inactive = Object.freeze({
  owner: false,
  signedOwnerCanary: false,
  signedReleaseCanary: false,
});

describe("canonical Contract-3 fallback authority", () => {
  test("ordinary owner identity is never an implicit Contract-3 canary", () => {
    expect(canonicalContractFallbackRequestedV1({
      ...inactive,
      owner: true,
    })).toBe(false);
  });

  test("requires both owner identity and a verified signed canary receipt", () => {
    expect(canonicalContractFallbackRequestedV1({
      ...inactive,
      owner: true,
      signedOwnerCanary: true,
    })).toBe(true);
    expect(canonicalContractFallbackRequestedV1({
      ...inactive,
      owner: false,
      signedOwnerCanary: true,
    })).toBe(false);
  });

  test("rejects broad historical flags as ordinary-public route authority", () => {
    expect(canonicalContractFallbackRequestedV1({
      ...inactive,
      globalContract3Enabled: true,
    } as Parameters<typeof canonicalContractFallbackRequestedV1>[0])).toBe(false);
    expect(canonicalContractFallbackRequestedV1({
      ...inactive,
      reggaetonContract3Enabled: true,
      smoothReggaetonRequest: true,
    } as Parameters<typeof canonicalContractFallbackRequestedV1>[0])).toBe(false);
    expect(canonicalContractFallbackRequestedV1({
      ...inactive,
      globalContract3Enabled: true,
      owner: true,
      signedOwnerCanary: false,
    } as Parameters<typeof canonicalContractFallbackRequestedV1>[0])).toBe(false);
  });

  test("retains only verified signed owner-canary fallback authority", () => {
    expect(canonicalContractFallbackRequestedV1({
      ...inactive,
      owner: true,
      signedOwnerCanary: true,
    })).toBe(true);
    expect(canonicalContractFallbackRequestedV1({
      ...inactive,
      owner: false,
      signedOwnerCanary: true,
    })).toBe(false);
  });

  test("admits an authenticated release canary without owner identity", () => {
    expect(canonicalContractFallbackRequestedV1({
      ...inactive,
      signedReleaseCanary: true,
    })).toBe(true);
  });
});
