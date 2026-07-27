import type { PublicationExecutionFence } from "./publication-reconciliation-persistence.ts";

export const APPLE_WRITE_GATEWAY_LOCK = "genio:apple-write-gateway:v1";
export const APPLE_WRITE_GATEWAY_STATE_KEY = "apple_write_token_bucket_v1";
export const APPLE_WRITE_GATEWAY_EVENT_BUCKET = "apple:global";
export const APPLE_WRITE_GATEWAY_EVENT_ACTION = "apple_write";

export type AppleWriteOperation = "create_playlist" | "append_tracks";

export interface AppleWritePermitRequest {
  runId: string;
  manifestId: string;
  manifestRevisionId: string | null;
  manifestRevisionHash: string;
  contractRevisionId: string | null;
  contractHash: string | null;
  /**
   * Canonical publications must bind the external mutation to the currently
   * leased execution attempt. Legacy V1/V2 bridge publications use null.
   */
  executionFence: PublicationExecutionFence | null;
  publicationVolumeId: string;
  operation: AppleWriteOperation;
}

export interface AppleWritePermit {
  /** Idempotently releases the session-level global advisory lock. */
  release(): Promise<void>;
}

export interface AppleWriteRatePolicy {
  capacity: number;
  refillPerSecond: number;
  lockWaitMs: number;
}

export interface AppleWriteTokenBucketState {
  tokens: number;
  updatedAtMs: number;
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Server-owned Apple mutation limits. Values are intentionally clamped so a
 * malformed deployment variable cannot disable the database-backed gate.
 */
export function readAppleWriteRatePolicy(
  environment: NodeJS.ProcessEnv = process.env,
): AppleWriteRatePolicy {
  return {
    capacity: Math.max(1, Math.min(20, Math.floor(finiteNumber(
      environment.APPLE_WRITE_TOKEN_CAPACITY,
      4,
    )))),
    refillPerSecond: Math.max(0.25, Math.min(10, finiteNumber(
      environment.APPLE_WRITE_TOKEN_REFILL_PER_SECOND,
      2,
    ))),
    lockWaitMs: Math.max(1_000, Math.min(5 * 60_000, Math.floor(finiteNumber(
      environment.APPLE_WRITE_LOCK_WAIT_MS,
      60_000,
    )))),
  };
}

export function refillAppleWriteTokenBucket(input: {
  state: AppleWriteTokenBucketState | null;
  nowMs: number;
  policy: Pick<AppleWriteRatePolicy, "capacity" | "refillPerSecond">;
}): AppleWriteTokenBucketState {
  const { policy } = input;
  const nowMs = Number.isFinite(input.nowMs) ? Math.floor(input.nowMs) : Date.now();
  if (!input.state
    || !Number.isFinite(input.state.tokens)
    || !Number.isFinite(input.state.updatedAtMs)) {
    return { tokens: policy.capacity, updatedAtMs: nowMs };
  }
  const elapsedSeconds = Math.max(0, nowMs - input.state.updatedAtMs) / 1_000;
  return {
    tokens: Math.max(0, Math.min(
      policy.capacity,
      input.state.tokens + elapsedSeconds * policy.refillPerSecond,
    )),
    updatedAtMs: nowMs,
  };
}

export function appleWriteTokenWaitMs(
  tokens: number,
  refillPerSecond: number,
  cost = 1,
): number {
  if (tokens >= cost) return 0;
  return Math.max(1, Math.ceil((cost - Math.max(0, tokens)) / refillPerSecond * 1_000));
}
