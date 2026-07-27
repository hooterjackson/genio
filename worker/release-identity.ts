const encoder = new TextEncoder();

export interface SitesGatewayReleaseEnvironment {
  RAILWAY_API_BASE?: string;
  GATEWAY_KEY_ID?: string;
  GATEWAY_HMAC_SECRET?: string;
  GATEWAY_PREVIOUS_KEY_ID?: string;
  GATEWAY_PREVIOUS_HMAC_SECRET?: string;
  IP_HASH_SECRET?: string;
  OWNER_EMAIL?: string;
  OWNER_ALLOWLIST_VERSION?: string;
}

function normalized(value: string | undefined): string | null {
  const result = value?.trim() ?? "";
  return result || null;
}

const OWNER_ALLOWLIST_VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u;

export function sitesOwnerAllowlistVersion(
  environment: SitesGatewayReleaseEnvironment,
): string | null {
  const ownerConfigured = Boolean(normalized(environment.OWNER_EMAIL));
  const version = normalized(environment.OWNER_ALLOWLIST_VERSION);
  if (version && !OWNER_ALLOWLIST_VERSION.test(version)) {
    throw new Error("OWNER_ALLOWLIST_VERSION must be a safe non-secret release label");
  }
  if (ownerConfigured && !version) {
    throw new Error(
      "OWNER_ALLOWLIST_VERSION is required when OWNER_EMAIL is configured",
    );
  }
  return version;
}

function hex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

export function sitesGatewayReleaseConfiguration(
  environment: SitesGatewayReleaseEnvironment,
): Record<string, unknown> {
  return {
    schemaVersion: "genio-sites-gateway-configuration/v1",
    railwayApiBase: normalized(environment.RAILWAY_API_BASE),
    gatewayKeyId: normalized(environment.GATEWAY_KEY_ID),
    gatewaySecretConfigured: Boolean(environment.GATEWAY_HMAC_SECRET),
    previousGatewayKeyId: normalized(environment.GATEWAY_PREVIOUS_KEY_ID),
    previousGatewaySecretConfigured: Boolean(
      environment.GATEWAY_PREVIOUS_HMAC_SECRET,
    ),
    ipHashSecretConfigured: Boolean(environment.IP_HASH_SECRET),
    ownerAllowlistConfigured: Boolean(normalized(environment.OWNER_EMAIL)),
    ownerAllowlistVersion: sitesOwnerAllowlistVersion(environment),
  };
}

/**
 * Public digest of behavior-affecting Sites gateway configuration. Secret
 * values are represented only by presence; their exact rotations are bound by
 * the separate digest-only release secret-version manifest.
 */
export async function sitesGatewayReleaseConfigurationHash(
  environment: SitesGatewayReleaseEnvironment,
): Promise<string> {
  const material = JSON.stringify(sitesGatewayReleaseConfiguration(environment));
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(material));
  return hex(new Uint8Array(digest));
}
