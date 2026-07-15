export type DurableAppleAuthorization = {
  configured: boolean;
  status: string;
  storefront: string | null;
  lastValidatedAt: string | null;
  lastError: string | null;
};

type PollOptions = {
  attempts?: number;
  delayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
};

function normalizeAuthorization(value: unknown): DurableAppleAuthorization {
  const item = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    configured: item.configured === true,
    status: typeof item.status === "string" ? item.status : "missing",
    storefront: typeof item.storefront === "string" ? item.storefront : null,
    lastValidatedAt: typeof item.lastValidatedAt === "string" ? item.lastValidatedAt : null,
    lastError: typeof item.lastError === "string" ? item.lastError : null,
  };
}

const wait = (delayMs: number) => new Promise<void>((resolve) => {
  globalThis.setTimeout(resolve, delayMs);
});

/**
 * A MusicKit authorization is not considered connected until the encrypted
 * token has been read back from Postgres and the worker has validated it.
 */
export async function waitForDurableAppleAuthorization(
  readAuthorization: () => Promise<unknown>,
  options: PollOptions = {},
): Promise<DurableAppleAuthorization> {
  const attempts = Math.max(1, Math.min(Math.floor(options.attempts ?? 12), 60));
  const delayMs = Math.max(0, Math.min(Math.floor(options.delayMs ?? 1_500), 10_000));
  const waitForNextAttempt = options.wait ?? wait;
  let latest: DurableAppleAuthorization | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const authorization = normalizeAuthorization(await readAuthorization());
    latest = authorization;
    if (!authorization.configured || authorization.status === "missing") {
      throw new Error("Apple Music authorization was not saved. Try authorizing again.");
    }
    if (authorization.status === "valid") return authorization;
    if (authorization.status === "reauthorization_required") {
      throw new Error(authorization.lastError
        ? `Apple Music rejected the saved authorization: ${authorization.lastError}`
        : "Apple Music rejected the saved authorization. Authorize again.");
    }
    if (authorization.status === "validation_failed") {
      throw new Error(authorization.lastError
        ? `Apple Music authorization validation failed: ${authorization.lastError}`
        : "Apple Music authorization validation failed. Retry validation.");
    }
    if (authorization.status !== "unverified") {
      throw new Error(`Apple Music returned an unexpected authorization status: ${authorization.status}.`);
    }
    if (attempt < attempts - 1) await waitForNextAttempt(delayMs);
  }
  // The durable worker deliberately retries transient Apple failures with
  // backoff longer than this short UI wait. A saved authorization remains a
  // pending background operation, not a failed browser authorization.
  return latest!;
}

export function durableAppleAuthorizationMessage(authorization: DurableAppleAuthorization): string {
  const storefront = authorization.storefront?.toUpperCase() ?? "UNKNOWN STOREFRONT";
  if (authorization.status === "unverified") {
    return `APPLE MUSIC AUTHORIZATION SAVED · ${storefront} · VALIDATION PENDING`;
  }
  return `APPLE MUSIC CONNECTED · ${storefront} · TOKEN SAVED AND VALIDATED`;
}

export function requireMusicUserToken(value: unknown): string {
  const token = typeof value === "string" ? value.trim() : "";
  if (token.length < 20 || token.length > 16_384) {
    throw new Error("Apple Music did not return an authorization token. Try authorizing again.");
  }
  return token;
}

export function appleAuthorizationErrorMessage(value: unknown): string {
  if (value instanceof Error && value.message.trim()) return value.message.trim();
  if (typeof value === "string" && value.trim()) return value.trim();
  return "Apple Music authorization failed before it could be saved. Try again.";
}
