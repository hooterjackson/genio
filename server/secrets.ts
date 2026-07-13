/**
 * Production secrets are injected by the hosting platform.  This module keeps
 * their parsing in one place so provider modules never fall back to a local
 * keychain or accidentally expose raw values in error messages.
 */

export class MissingSecretError extends Error {
  readonly name = "MissingSecretError";

  constructor(readonly secretName: string) {
    super(`Required service secret ${secretName} is not configured`);
  }
}

export function optionalSecret(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function requireSecret(name: string): string {
  const value = optionalSecret(name);
  if (!value) throw new MissingSecretError(name);
  return value;
}

export function requireOneSecret(names: readonly string[]): { name: string; value: string } {
  for (const name of names) {
    const value = optionalSecret(name);
    if (value) return { name, value };
  }
  throw new MissingSecretError(names.join(" or "));
}

/** Accept a literal PEM, an escaped-newline PEM, or a base64-encoded PEM. */
export function requirePrivateKey(
  plainName = "APPLE_MUSICKIT_PRIVATE_KEY",
  base64Name = "APPLE_MUSICKIT_PRIVATE_KEY_BASE64",
): string {
  const plain = optionalSecret(plainName);
  if (plain) return plain.replaceAll("\\n", "\n");

  const encoded = optionalSecret(base64Name);
  if (!encoded) throw new MissingSecretError(`${plainName} or ${base64Name}`);
  const decoded = Buffer.from(encoded, "base64").toString("utf8").trim();
  if (!decoded.includes("BEGIN PRIVATE KEY")) {
    throw new Error(`${base64Name} does not contain a PKCS#8 private key`);
  }
  return decoded;
}

export function parseSecretJson<T>(name: string, fallback: T): T {
  const value = optionalSecret(name);
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }
}
