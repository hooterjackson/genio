export const RETRYABLE_CATALOG_MATCH_BASES = [
  "Apple catalog lookup did not complete inside the absolute fast-run window",
  "Apple catalog lookup did not complete inside the fast matching window",
  "Apple catalog was temporarily unavailable during fast matching",
] as const;

export const CATALOG_RECOVERY_UNRESOLVED_BASIS =
  "Apple catalog recovery could not resolve this track after retry attempts";

export function isRetryableCatalogMatch(match: {
  status: string;
  basis?: string | null;
  song?: { id?: string } | null;
}): boolean {
  return match.status === "review"
    && !match.song?.id
    && RETRYABLE_CATALOG_MATCH_BASES.includes(match.basis as typeof RETRYABLE_CATALOG_MATCH_BASES[number]);
}
