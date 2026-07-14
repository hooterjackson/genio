/**
 * Errors cross several durable and public boundaries in Needle. Provider,
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

const FAILURE_MESSAGES: Record<FailureContext, string> = {
  brief: "Needle could not interpret this request after the final attempt.",
  research: "Research could not be completed after the final attempt.",
  matching: "Apple Music matching could not be completed after the final attempt.",
  publication: "Apple publication failed after the final attempt; provider details were redacted.",
  notification: "Owner notification delivery failed after the final attempt.",
  apple_authorization: "Apple Music authorization validation failed after the final attempt.",
  background: "Background work failed after the final attempt.",
};

const PUBLICATION_SHARE_LINK_FAILURE = "Apple did not expose a stable public playlist link after the final attempt.";
const PUBLICATION_ORDER_FAILURE = "Apple playlist ordering diverged from the approved manifest after the final attempt.";
const PUBLICATION_LEASE_FAILURE = "The publication worker lease expired after the final attempt.";
const PUBLICATION_AVAILABILITY_FAILURE = "Apple Music remained unavailable after the final attempt.";
const SAFE_PUBLICATION_MESSAGES = new Set([
  FAILURE_MESSAGES.publication,
  PUBLICATION_SHARE_LINK_FAILURE,
  PUBLICATION_ORDER_FAILURE,
  PUBLICATION_LEASE_FAILURE,
  PUBLICATION_AVAILABILITY_FAILURE,
]);

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
  if (context !== "publication") return FAILURE_MESSAGES[context];

  const suppliedMessage = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (SAFE_PUBLICATION_MESSAGES.has(suppliedMessage)) return suppliedMessage;

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

export function sanitizeOptionalFailure(
  error: unknown,
  context: FailureContext = "background",
): string | null {
  return error == null ? null : sanitizeFailure(error, context);
}

export function publicToolFailure(): string {
  return "The source operation failed; continue with other documented sources.";
}
