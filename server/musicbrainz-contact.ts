export const MUSICBRAINZ_CONTACT_POLICY_VERSION =
  "musicbrainz_contact_policy_v1" as const;
export const DEFAULT_MUSICBRAINZ_CONTACT = "https://9enio.com/about" as const;

export type MusicBrainzContactMode =
  | "default_public_url"
  | "configured_email"
  | "configured_https_url";

const EMAIL =
  /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/iu;

function configuredContact(value: string | undefined): {
  contact: string;
  mode: MusicBrainzContactMode;
} {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    return {
      contact: DEFAULT_MUSICBRAINZ_CONTACT,
      mode: "default_public_url",
    };
  }
  if (
    normalized.length > 200
    || /[\u0000-\u001f\u007f()]/u.test(normalized)
  ) {
    throw new Error(
      "MUSICBRAINZ_CONTACT must be a valid email address or HTTPS URL",
    );
  }
  if (EMAIL.test(normalized)) {
    return { contact: normalized, mode: "configured_email" };
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(
      "MUSICBRAINZ_CONTACT must be a valid email address or HTTPS URL",
    );
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.hash
    || parsed.origin === "null"
  ) {
    throw new Error(
      "MUSICBRAINZ_CONTACT must be a valid email address or HTTPS URL",
    );
  }
  return { contact: parsed.href, mode: "configured_https_url" };
}

/**
 * Privacy-safe behavior identity. Release evidence records only this bounded
 * readiness class, never a raw operator email address or URL.
 */
export function musicBrainzContactConfigurationLabel(
  value: string | undefined,
): string {
  const { mode } = configuredContact(value);
  return `${MUSICBRAINZ_CONTACT_POLICY_VERSION}:${mode}`;
}

export function musicBrainzUserAgentContact(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return configuredContact(environment.MUSICBRAINZ_CONTACT).contact;
}

export function musicBrainzUserAgent(
  environment: NodeJS.ProcessEnv = process.env,
  version = "1.1",
): string {
  return `9enio/${version} (${musicBrainzUserAgentContact(environment)})`;
}
