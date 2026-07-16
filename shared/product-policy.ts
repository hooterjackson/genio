/**
 * The public One Command surface is intentionally bounded. Larger source-
 * frontier projects belong to an explicit owner-controlled research path;
 * adjectives such as "long" must never unlock an expensive execution mode.
 */
export const PUBLIC_PLAYLIST_MINIMUM_TRACKS = 1;
export const PUBLIC_PLAYLIST_MAXIMUM_TRACKS = 300;
export const PUBLIC_PLAYLIST_DEFAULT_TRACKS = 50;
/** Used only for legacy/missing count requests; the current UI always sends a count. */
export const PUBLIC_PLAYLIST_MISSING_COUNT_TRACKS = 100;

/** Hard approved-budget ceiling for the bounded public fast path. */
export const PUBLIC_FAST_RESEARCH_BUDGET_USD = 1.5;

/**
 * The guided preflight is deliberately small and has its own hard cap.
 * Answers are applied deterministically without a second model call. This
 * prevents malformed prompts or unexpectedly verbose output from spending the
 * playlist's research budget before research begins.
 */
export const GUIDED_BRIEF_BUDGET_USD = 0.25;

/**
 * A public playlist's preflight and research share one $1.50 ceiling. Passing
 * this reduced value as both the estimate and approved run budget also keeps
 * the repository's queued-run budget normalization from restoring a larger
 * estimate.
 */
export function publicRunBudgetUsd(
  confirmedResearchEstimateUsd: number,
  briefActualCostUsd: number,
): number {
  if (!Number.isFinite(confirmedResearchEstimateUsd) || confirmedResearchEstimateUsd < 0) return 0;
  if (!Number.isFinite(briefActualCostUsd) || briefActualCostUsd < 0) return 0;
  return Math.max(
    0,
    Math.min(
      confirmedResearchEstimateUsd,
      PUBLIC_FAST_RESEARCH_BUDGET_USD - briefActualCostUsd,
    ),
  );
}
