import { describe, expect, test } from "vitest";
import { systemE2eEnvironment } from "../scripts/system-e2e-environment.mjs";

describe("stitched browser gateway environment", () => {
  test("does not alter ordinary responsive browser runs", () => {
    expect(systemE2eEnvironment({
      GENIO_SYSTEM_E2E: "0",
      GATEWAY_KEY_ID: "ci-v1",
    })).toEqual({});
  });

  test("overrides ambient release gateway values with the owned local pair", () => {
    expect(systemE2eEnvironment({
      GENIO_SYSTEM_E2E: "1",
      GENIO_SYSTEM_E2E_API_PORT: "19876",
      RAILWAY_API_BASE: "https://production.invalid",
      GATEWAY_KEY_ID: "rc-v1",
      GATEWAY_HMAC_SECRET: "ambient-release-secret",
      IP_HASH_SECRET: "ambient-release-pepper",
    })).toEqual({
      GENIO_SYSTEM_E2E_API_PORT: "19876",
      RAILWAY_API_BASE: "http://127.0.0.1:19876",
      GATEWAY_KEY_ID: "local-dev",
      GATEWAY_HMAC_SECRET: "needle-local-development-only",
      IP_HASH_SECRET: "needle-local-ip-pepper",
    });
  });

  test("rejects an invalid fixture port before starting a browser", () => {
    expect(() => systemE2eEnvironment({
      GENIO_SYSTEM_E2E: "1",
      GENIO_SYSTEM_E2E_API_PORT: "70000",
    })).toThrow(/valid local TCP port/u);
  });
});
