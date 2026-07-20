import { HttpError } from "./security.ts";

export const PARTIAL_DECISION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const PARTIAL_EXPLORE_MINIMUM_FILL_RATIO = 0.9;

export interface PartialReadyCheckpoint {
  outcomeHash: string;
  outcomeVersion: number;
  targetTrackCount: number;
  verifiedTrackCount: number;
  shortfall: number;
  remainingStrategyCount: number;
  continueAvailable: boolean;
  preparedAt: string;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function safeText(value: unknown, maximum: number): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, maximum)
    : "";
}

export function parsePartialReadyCheckpoint(value: unknown): PartialReadyCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const outcomeHash = safeText(row.outcomeHash, 64).toLowerCase();
  const targetTrackCount = boundedInteger(row.targetTrackCount, 1, 300);
  const verifiedTrackCount = boundedInteger(row.verifiedTrackCount, 0, 300);
  const outcomeVersion = boundedInteger(row.outcomeVersion ?? 1, 1, Number.MAX_SAFE_INTEGER);
  const remainingStrategyCount = boundedInteger(row.remainingStrategyCount ?? 0, 0, 1_000);
  const preparedAt = safeText(row.preparedAt, 64);
  const preparedAtMs = Date.parse(preparedAt);
  if (
    !/^[a-f0-9]{64}$/.test(outcomeHash)
    || targetTrackCount === null
    || verifiedTrackCount === null
    || verifiedTrackCount >= targetTrackCount
    || outcomeVersion === null
    || remainingStrategyCount === null
    || !Number.isFinite(preparedAtMs)
  ) return null;
  return {
    outcomeHash,
    outcomeVersion,
    targetTrackCount,
    verifiedTrackCount,
    shortfall: targetTrackCount - verifiedTrackCount,
    remainingStrategyCount,
    continueAvailable: row.continueAvailable === true && remainingStrategyCount > 0,
    preparedAt: new Date(preparedAtMs).toISOString(),
  };
}

export function requireCurrentPartialOutcome(input: {
  checkpoint: unknown;
  outcomeHash?: unknown;
  outcomeVersion?: unknown;
}): PartialReadyCheckpoint {
  const checkpoint = parsePartialReadyCheckpoint(input.checkpoint);
  if (!checkpoint) {
    throw new HttpError(409, "The partial playlist outcome is no longer available", "partial_outcome_not_ready");
  }
  if (input.outcomeHash !== undefined && safeText(input.outcomeHash, 64).toLowerCase() !== checkpoint.outcomeHash) {
    throw new HttpError(409, "The playlist result changed; review the latest result", "partial_outcome_stale");
  }
  if (input.outcomeVersion !== undefined && Number(input.outcomeVersion) !== checkpoint.outcomeVersion) {
    throw new HttpError(409, "The playlist result changed; review the latest result", "partial_outcome_stale");
  }
  return checkpoint;
}

export function partialDecisionExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + PARTIAL_DECISION_TTL_MS);
}

export function shortManifestRequiresDecision(targetTrackCount: number | null, manifestTrackCount: number): boolean {
  if (targetTrackCount == null) return false;
  return manifestTrackCount < targetTrackCount;
}

export function partialExploreEligibility(input: {
  targetTrackCount: number;
  selectedTrackCount: number;
  ownerApproved?: boolean;
}): { eligible: boolean; fillRatio: number; reason: string | null } {
  const target = Math.max(1, Math.floor(input.targetTrackCount));
  const selected = Math.max(0, Math.min(target, Math.floor(input.selectedTrackCount)));
  const fillRatio = selected / target;
  if (input.ownerApproved === true || fillRatio >= PARTIAL_EXPLORE_MINIMUM_FILL_RATIO) {
    return { eligible: true, fillRatio, reason: null };
  }
  return {
    eligible: false,
    fillRatio,
    reason: "Partial playlists below 90% fill require owner approval before Explore listing",
  };
}
