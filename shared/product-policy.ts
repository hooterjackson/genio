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

/** Hard approved-budget ceiling for the largest bounded public fast path. */
export const PUBLIC_FAST_RESEARCH_BUDGET_USD = 3;

/**
 * The guided preflight is deliberately small and has its own hard cap.
 * Answers are applied deterministically without a second model call. This
 * prevents malformed prompts or unexpectedly verbose output from spending the
 * playlist's research budget before research begins.
 */
export const GUIDED_BRIEF_BUDGET_USD = 0.25;

/**
 * Grounded follow-up discovery has an independent ceiling. Its spend remains
 * visible in the owner ledger, but never consumes the track-research allowance.
 */
// Covers the normal researched scout and one rare no-search structured repair
// without letting a truncated first response strand an otherwise useful set
// of questions at reconciliation time.
export const GUIDED_SCOUT_BUDGET_USD = 0.03;

/**
 * Size-tiered research allowance. A vague adjective such as "long" never
 * changes this number; only the validated, explicit target count does.
 */
export function curatedResearchBudgetUsd(requestedTrackCount: number): number {
  if (!Number.isFinite(requestedTrackCount)) return 0;
  const tracks = Math.max(0, Math.floor(requestedTrackCount));
  if (tracks < PUBLIC_PLAYLIST_MINIMUM_TRACKS || tracks > PUBLIC_PLAYLIST_MAXIMUM_TRACKS) return 0;
  if (tracks <= 50) return 0.75;
  if (tracks <= 100) return 1.5;
  return 3;
}

/**
 * A public playlist's preflight and research share the validated size-tier
 * ceiling. Passing this reduced value as both the estimate and approved run
 * budget also keeps queued-run normalization from restoring a larger estimate.
 */
export function publicRunBudgetUsd(
  confirmedResearchEstimateUsd: number,
  briefActualCostUsd: number,
  requestedTrackCount = PUBLIC_PLAYLIST_MISSING_COUNT_TRACKS,
): number {
  if (!Number.isFinite(confirmedResearchEstimateUsd) || confirmedResearchEstimateUsd < 0) return 0;
  if (!Number.isFinite(briefActualCostUsd) || briefActualCostUsd < 0) return 0;
  const sizeTierBudgetUsd = curatedResearchBudgetUsd(requestedTrackCount);
  return Math.max(
    0,
    Math.min(
      confirmedResearchEstimateUsd,
      sizeTierBudgetUsd - briefActualCostUsd,
    ),
  );
}
