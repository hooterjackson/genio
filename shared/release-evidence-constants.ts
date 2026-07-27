/**
 * Release-evidence constants shared by the evidence compiler and Railway IaC.
 *
 * Keeping these values outside either module avoids a circular dependency:
 * Railway must verify the complete signed candidate envelope, while the
 * evidence compiler must independently enforce the same staging ceiling.
 */
export const RELEASE_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1_000;
/**
 * The historical browser replay gate executes every retained submission, not
 * a de-duplicated prompt sample. The current 73-submission corpus reserves
 * $59.25 at the unchanged public per-run ceilings; the remaining $15.75 keeps
 * the existing manifest/publication canaries and a small retry margin inside
 * one independently signed QA ledger. This does not change production or
 * per-run research limits.
 */
export const MAXIMUM_STAGING_MONTHLY_COST_USD = 75;
