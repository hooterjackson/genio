import { describe, expect, test } from "vitest";
import {
  sitesGatewayReleaseConfiguration,
  sitesGatewayReleaseConfigurationHash,
  sitesOwnerAllowlistVersion,
} from "../worker/release-identity.ts";

describe("Sites gateway release identity", () => {
  const environment = {
    RAILWAY_API_BASE: "https://staging-api.example",
    GATEWAY_KEY_ID: "staging-v2",
    GATEWAY_HMAC_SECRET: "first-secret",
    IP_HASH_SECRET: "first-pepper",
    OWNER_EMAIL: "Owner@Example.com",
    OWNER_ALLOWLIST_VERSION: "owner-allowlist-v1",
  };

  test("captures behavior without exposing secret values", () => {
    expect(sitesGatewayReleaseConfiguration(environment)).toEqual({
      schemaVersion: "genio-sites-gateway-configuration/v1",
      railwayApiBase: "https://staging-api.example",
      gatewayKeyId: "staging-v2",
      gatewaySecretConfigured: true,
      previousGatewayKeyId: null,
      previousGatewaySecretConfigured: false,
      ipHashSecretConfigured: true,
      ownerAllowlistConfigured: true,
      ownerAllowlistVersion: "owner-allowlist-v1",
    });
  });

  test("is secret-insensitive but changes with routing or key identity", async () => {
    const first = await sitesGatewayReleaseConfigurationHash(environment);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(await sitesGatewayReleaseConfigurationHash({
      ...environment,
      GATEWAY_HMAC_SECRET: "rotated-secret",
      IP_HASH_SECRET: "rotated-pepper",
    })).toBe(first);
    expect(await sitesGatewayReleaseConfigurationHash({
      ...environment,
      RAILWAY_API_BASE: "https://another-api.example",
    })).not.toBe(first);
    expect(await sitesGatewayReleaseConfigurationHash({
      ...environment,
      GATEWAY_KEY_ID: "staging-v3",
    })).not.toBe(first);
    expect(await sitesGatewayReleaseConfigurationHash({
      ...environment,
      OWNER_ALLOWLIST_VERSION: "owner-allowlist-v2",
    })).not.toBe(first);
  });

  test("requires a safe explicit version without hashing the owner address", () => {
    expect(() => sitesOwnerAllowlistVersion({
      OWNER_EMAIL: "owner@example.com",
    })).toThrow(/OWNER_ALLOWLIST_VERSION is required/u);
    expect(() => sitesOwnerAllowlistVersion({
      OWNER_EMAIL: "owner@example.com",
      OWNER_ALLOWLIST_VERSION: "invalid version",
    })).toThrow(/safe non-secret release label/u);
    expect(JSON.stringify(sitesGatewayReleaseConfiguration(environment)))
      .not.toContain("Owner@Example.com");
  });
});
