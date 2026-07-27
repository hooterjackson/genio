export class CanonicalExecutionIntegrityError extends Error {
  readonly name = "CanonicalExecutionIntegrityError";
  readonly code = "canonical_execution_integrity";

  constructor(readonly reasonCode: string) {
    super(`Canonical execution integrity check failed: ${reasonCode}`);
  }
}

export function canonicalExecutionIntegrityError(
  error: unknown,
  fallbackReasonCode: string,
): CanonicalExecutionIntegrityError {
  return error instanceof CanonicalExecutionIntegrityError
    ? error
    : new CanonicalExecutionIntegrityError(fallbackReasonCode);
}
