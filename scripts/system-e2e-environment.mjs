const DEFAULT_SYSTEM_E2E_API_PORT = "18788";

/**
 * The stitched browser suite owns both ends of its signed gateway. Never let
 * ambient CI, staging, or production gateway variables split the local Sites
 * preview from the API process spawned by the fixture.
 */
export function systemE2eEnvironment(environment = process.env) {
  if (environment.GENIO_SYSTEM_E2E !== "1") return {};
  const apiPort = environment.GENIO_SYSTEM_E2E_API_PORT?.trim()
    || DEFAULT_SYSTEM_E2E_API_PORT;
  if (!/^\d{2,5}$/u.test(apiPort) || Number(apiPort) > 65_535) {
    throw new Error("GENIO_SYSTEM_E2E_API_PORT must be a valid local TCP port");
  }
  return {
    GENIO_SYSTEM_E2E_API_PORT: apiPort,
    RAILWAY_API_BASE: `http://127.0.0.1:${apiPort}`,
    GATEWAY_KEY_ID: "local-dev",
    GATEWAY_HMAC_SECRET: "needle-local-development-only",
    IP_HASH_SECRET: "needle-local-ip-pepper",
  };
}
