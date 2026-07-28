/**
 * Errors cross several durable and public boundaries in gênio. Provider,
 * database, and network messages can contain credentials, connection strings,
 * request data, or upstream implementation details, so none of those messages
 * are suitable for persistence or a visitor response.
 *
 * Keep these messages constant. Callers may use the original error for local
 * control flow, but must pass only a value returned here to queues, run state,
 * notification state, or public payloads.
 */

export type FailureContext =
  | "brief"
  | "research"
  | "matching"
  | "publication"
  | "notification"
  | "apple_authorization"
  | "background";

export interface SafeTechnicalFailureDiagnostic {
  name: string;
  code: string | null;
  status: number | null;
}

const SAFE_DIAGNOSTIC_NAME = /^[A-Za-z][A-Za-z0-9]{0,79}$/u;
const SAFE_DIAGNOSTIC_CODE = /^[a-z0-9][a-z0-9_.:-]{0,119}$/u;

/**
 * Retain only bounded machine identifiers for operator logs. Error messages,
 * stacks, prompts, URLs, credentials, and provider payloads never cross this
 * boundary.
 */
export function safeTechnicalFailureDiagnostic(
  error: unknown,
): SafeTechnicalFailureDiagnostic {
  const value = error && typeof error === "object"
    ? error as {
      name?: unknown;
      code?: unknown;
      operatorCode?: unknown;
      status?: unknown;
      statusCode?: unknown;
    }
    : {};
  const name = typeof value.name === "string"
    && SAFE_DIAGNOSTIC_NAME.test(value.name)
    ? value.name
    : "Error";
  const codeCandidate = typeof value.operatorCode === "string"
    && SAFE_DIAGNOSTIC_CODE.test(value.operatorCode)
    ? value.operatorCode
    : value.code;
  const code = typeof codeCandidate === "string"
    && SAFE_DIAGNOSTIC_CODE.test(codeCandidate)
    ? codeCandidate
    : null;
  const suppliedStatus = typeof value.status === "number"
    ? value.status
    : typeof value.statusCode === "number"
      ? value.statusCode
      : null;
  const status = suppliedStatus !== null
    && Number.isSafeInteger(suppliedStatus)
    && suppliedStatus >= 100
    && suppliedStatus <= 599
    ? suppliedStatus
    : null;
  return { name, code, status };
}

const FAILURE_MESSAGES: Record<FailureContext, string> = {
  brief: "gênio could not interpret this request after the final attempt.",
  research: "Research could not be completed after the final attempt.",
  matching: "Apple Music matching could not be completed after the final attempt.",
  publication: "Apple publication failed after the final attempt; provider details were redacted.",
  notification: "Owner notification delivery failed after the final attempt.",
  apple_authorization: "Apple Music authorization validation failed after the final attempt.",
  background: "Background work failed after the final attempt.",
};

const APPLE_AUTHORIZATION_RATE_LIMITED = "Apple Music temporarily rate-limited authorization validation (HTTP 429).";
const APPLE_AUTHORIZATION_UNAVAILABLE = "Apple Music authorization validation was temporarily unavailable.";
const APPLE_AUTHORIZATION_UNREACHABLE = "gênio could not reach Apple Music while validating authorization.";
const PREVIOUS_APPLE_AUTHORIZATION_UNREACHABLE = "9ênio could not reach Apple Music while validating authorization.";
const LEGACY_APPLE_AUTHORIZATION_UNREACHABLE = "Needle could not reach Apple Music while validating authorization.";
const APPLE_AUTHORIZATION_INVALID_RESPONSE = "Apple Music returned an invalid authorization-validation response.";
const APPLE_AUTHORIZATION_CLIENT_REJECTION = /^Apple Music rejected (?:gênio|9ênio|Needle)'s authorization validation request \(HTTP 4\d\d\)\.$/u;
const SAFE_APPLE_AUTHORIZATION_MESSAGES = new Set([
  FAILURE_MESSAGES.apple_authorization,
  APPLE_AUTHORIZATION_RATE_LIMITED,
  APPLE_AUTHORIZATION_UNAVAILABLE,
  APPLE_AUTHORIZATION_UNREACHABLE,
  APPLE_AUTHORIZATION_INVALID_RESPONSE,
]);

const PUBLICATION_SHARE_LINK_FAILURE = "Apple did not expose a stable public playlist link after the final attempt.";
const PUBLICATION_ORDER_FAILURE = "Apple playlist ordering diverged from the approved manifest after the final attempt.";
const PUBLICATION_LEASE_FAILURE = "The publication worker lease expired after the final attempt.";
const PUBLICATION_AVAILABILITY_FAILURE = "Apple Music remained unavailable after the final attempt.";
const PUBLICATION_RATE_LIMITED = "Apple Music rate-limited playlist publication (HTTP 429).";
const PUBLICATION_CLIENT_REJECTION = /^Apple Music rejected playlist publication \(HTTP 4\d\d\)\.$/u;
const PUBLICATION_CATALOG_MISMATCH = /^Apple playlist catalog mismatch at position \d+: expected [A-Za-z0-9._-]+, observed [A-Za-z0-9._-]+ \(observed \d+ tracks\)$/u;
const SAFE_PUBLICATION_MESSAGES = new Set([
  FAILURE_MESSAGES.publication,
  PUBLICATION_SHARE_LINK_FAILURE,
  PUBLICATION_ORDER_FAILURE,
  PUBLICATION_LEASE_FAILURE,
  PUBLICATION_AVAILABILITY_FAILURE,
  PUBLICATION_RATE_LIMITED,
]);
const MATCHING_COUNT_SHORTFALL = /^Apple Music matching found \d+ strict unique catalog match(?:es)? for the required \d+\. No playlist was published because the exact count could not be met safely\.$/u;

export function failureContextForJob(kind: string): FailureContext {
  if (kind === "brief") return "brief";
  if (kind === "research") return "research";
  if (kind === "matching") return "matching";
  if (kind === "publication") return "publication";
  if (kind === "notification") return "notification";
  if (kind === "apple_authorization") return "apple_authorization";
  return "background";
}

export function failureContextForRun(phase?: string | null): FailureContext {
  const normalized = String(phase ?? "").toLowerCase();
  if (normalized.includes("publication") || normalized.startsWith("apple_")) return "publication";
  if (normalized.includes("match") || normalized.includes("exception") || normalized.includes("catalog_")) return "matching";
  return "research";
}

export function sanitizeFailure(error: unknown, context: FailureContext = "background"): string {
  if (context === "apple_authorization") {
    const suppliedMessage = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    if ([PREVIOUS_APPLE_AUTHORIZATION_UNREACHABLE, LEGACY_APPLE_AUTHORIZATION_UNREACHABLE].includes(suppliedMessage)) {
      return APPLE_AUTHORIZATION_UNREACHABLE;
    }
    if (APPLE_AUTHORIZATION_CLIENT_REJECTION.test(suppliedMessage)) {
      return suppliedMessage.replace(/(?:9ênio|Needle)'s/u, "gênio's");
    }
    return SAFE_APPLE_AUTHORIZATION_MESSAGES.has(suppliedMessage)
      ? suppliedMessage
      : FAILURE_MESSAGES.apple_authorization;
  }
  if (context === "matching") {
    const suppliedMessage = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    return MATCHING_COUNT_SHORTFALL.test(suppliedMessage)
      ? suppliedMessage
      : FAILURE_MESSAGES.matching;
  }
  if (context !== "publication") return FAILURE_MESSAGES[context];

  const suppliedMessage = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (SAFE_PUBLICATION_MESSAGES.has(suppliedMessage)
    || PUBLICATION_CLIENT_REJECTION.test(suppliedMessage)
    || PUBLICATION_CATALOG_MISMATCH.test(suppliedMessage)) return suppliedMessage;

  const value = error && typeof error === "object" ? error as { status?: unknown } : {};
  const status = typeof value.status === "number" ? value.status : null;
  if (status === 429) return PUBLICATION_RATE_LIMITED;
  if (status !== null && status >= 400 && status < 500) {
    return `Apple Music rejected playlist publication (HTTP ${Math.floor(status)}).`;
  }
  if (status !== null && status >= 500) return PUBLICATION_AVAILABILITY_FAILURE;

  // Publication reconciliation has a few useful, non-sensitive outcomes. The
  // raw message is used only for classification and is never returned.
  const normalized = suppliedMessage.toLowerCase();
  if (normalized.includes("share link")) {
    return PUBLICATION_SHARE_LINK_FAILURE;
  }
  if (normalized.includes("diverg") || normalized.includes("ordered prefix") || normalized.includes("ordered sequence")) {
    return PUBLICATION_ORDER_FAILURE;
  }
  if (normalized.includes("lease expired")) {
    return PUBLICATION_LEASE_FAILURE;
  }
  if (normalized.includes("timeout") || normalized.includes("timed out") || normalized.includes("could not be reached")) {
    return PUBLICATION_AVAILABILITY_FAILURE;
  }
  return FAILURE_MESSAGES.publication;
}

/**
 * Preserve only a small, non-secret diagnostic class for owner-facing Apple
 * authorization failures. Raw provider bodies, URLs, and tokens never cross
 * the durable job boundary.
 */
export function safeAppleAuthorizationFailure(error: unknown): string {
  const value = error && typeof error === "object" ? error as { status?: unknown } : {};
  const status = typeof value.status === "number" ? value.status : null;
  if (status === 429) return APPLE_AUTHORIZATION_RATE_LIMITED;
  if (status !== null && status >= 400 && status < 500) {
    return `Apple Music rejected gênio's authorization validation request (HTTP ${Math.floor(status)}).`;
  }
  if (status !== null && status >= 500) return APPLE_AUTHORIZATION_UNAVAILABLE;
  if (error instanceof Error && [
    "Apple did not return the owner storefront",
    "Apple returned malformed JSON",
  ].includes(error.message)) {
    return APPLE_AUTHORIZATION_INVALID_RESPONSE;
  }
  if (status === null && error instanceof Error && error.name === "AppleApiError") {
    return APPLE_AUTHORIZATION_UNREACHABLE;
  }
  return FAILURE_MESSAGES.apple_authorization;
}

export function sanitizeOptionalFailure(
  error: unknown,
  context: FailureContext = "background",
): string | null {
  return error == null ? null : sanitizeFailure(error, context);
}

export function publicToolFailure(): string {
  return "The source operation failed; continue with other documented sources.";
}
