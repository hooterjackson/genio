import { HttpError } from "./security.ts";

/**
 * Parse a positive integer supplied by Fastify's query-string parser.
 *
 * Keeping this validation ahead of the repository prevents malformed values
 * such as `NaN`, decimals, and scientific notation from reaching PostgreSQL
 * LIMIT/OFFSET parameters and turning a client error into a 500 response.
 */
export function positiveIntegerQuery(
  value: unknown,
  fallback: number,
  label: string,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new HttpError(400, `${label} is invalid`, "invalid_pagination");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new HttpError(400, `${label} is invalid`, "invalid_pagination");
  }
  return parsed;
}
