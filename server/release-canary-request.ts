import { buildInformation } from "./build-info.ts";
import {
  verifyReleaseCanaryMetadata,
  type ReleaseCanaryOperation,
  type UnsignedReleaseCanaryMetadata,
} from "./release-canary-metadata.ts";
import { HttpError } from "./security.ts";

function releaseEnvironment(
  environment: NodeJS.ProcessEnv,
): "staging" | "production" {
  const value = environment.RELEASE_ENVIRONMENT?.trim();
  if (value !== "staging" && value !== "production") {
    throw new HttpError(
      503,
      "Release-canary verification is not configured",
      "release_canary_unavailable",
    );
  }
  return value;
}

/**
 * Public traffic may omit canary metadata. Once the field is present, however,
 * it must be a current server-authenticated marker for this exact artifact;
 * callers cannot self-identify as synthetic.
 */
export function authenticateReleaseCanary(
  value: unknown,
  operation: ReleaseCanaryOperation,
  environment: NodeJS.ProcessEnv = process.env,
  now?: string,
): UnsignedReleaseCanaryMetadata | null {
  if (value === undefined) return null;
  const secret = environment.RELEASE_CANARY_HMAC_SECRET?.trim() ?? "";
  const revision = buildInformation(environment).revision;
  if (secret.length < 32 || !revision || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(revision)) {
    throw new HttpError(
      503,
      "Release-canary verification is not configured",
      "release_canary_unavailable",
    );
  }
  const expectedEnvironment = releaseEnvironment(environment);
  try {
    return verifyReleaseCanaryMetadata(value, {
      secret,
      expectedEnvironment,
      expectedOperation: operation,
      expectedSourceRevision: revision,
      now,
    });
  } catch {
    throw new HttpError(
      400,
      "Release-canary metadata is invalid or expired",
      "invalid_release_canary",
    );
  }
}
