import type { PlaylistMode } from "../shared/types.ts";

export interface PublicationCompleteness {
  omittedCandidateCount: number;
  unresolvedCoverageCount: number;
}

export interface PublicationCompletenessInput extends PublicationCompleteness {
  mode: PlaylistMode;
  targetMinimum: number | null;
  manifestTrackCount: number;
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Decide what "complete" means for the confirmed playlist scope.
 *
 * Curated research deliberately discovers a reserve pool so unavailable or
 * weak Apple matches can be replaced. Once the immutable manifest satisfies
 * the confirmed minimum, reserve candidates and an open-ended source frontier
 * are not publication gaps. Exhaustive and hybrid runs retain the strict
 * source/candidate accounting used for factual coverage claims.
 */
export function resolvePublicationCompleteness(
  input: PublicationCompletenessInput,
): PublicationCompleteness {
  const strictCompleteness = {
    omittedCandidateCount: nonNegativeInteger(input.omittedCandidateCount),
    unresolvedCoverageCount: nonNegativeInteger(input.unresolvedCoverageCount),
  };

  if (input.mode !== "curated") return strictCompleteness;

  // A validated curated brief always has a target. Retain strict accounting
  // for malformed legacy rows rather than silently presenting them as complete.
  if (!Number.isInteger(input.targetMinimum) || Number(input.targetMinimum) < 1) {
    return strictCompleteness;
  }

  return {
    omittedCandidateCount: Math.max(
      0,
      Number(input.targetMinimum) - nonNegativeInteger(input.manifestTrackCount),
    ),
    unresolvedCoverageCount: 0,
  };
}
