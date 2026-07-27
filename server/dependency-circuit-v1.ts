import {
  evaluateExecutionFenceV1,
  type ExecutionFenceDecisionV1,
  type ExecutionFenceV1,
} from "./execution-fence-v1.ts";

export const DEPENDENCY_IMMEDIATE_RETRY_DELAYS_MS_V1 = [
  1_000,
  2_000,
  4_000,
] as const;

export const DEPENDENCY_DURABLE_RETRY_DELAYS_MS_V1 = [
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
] as const;

export const DEPENDENCY_AUTOMATIC_WINDOW_MS_V1 = 24 * 60 * 60_000;

export type DependencyFailureClassV1 =
  | "transient"
  | "rate_limited"
  | "authorization"
  | "integrity"
  | "contract_conflict"
  | "permanent";

export interface DependencyCircuitInputV1 {
  fence: ExecutionFenceV1;
  failureClass: DependencyFailureClassV1;
  firstFailureAt: Date;
  lastFailureAt: Date;
  circuitOpenedAt: Date;
  immediateAttemptsCompleted: number;
  durableAttemptsCompleted: number;
  /**
   * Absolute provider Retry-After boundary. Persist the parsed instant rather
   * than recomputing a relative delay on every worker wake-up.
   */
  retryAfterUntil?: Date | null;
  now?: Date;
  /**
   * Caller-provided deterministic jitter sample in [0, 1]. Persist it with the
   * attempt so restarts calculate the same due time.
   */
  jitterUnit?: number;
}

export type DependencyCircuitDecisionV1 =
  | { state: "cancelled"; reasonCode: "run_cancelled" }
  | {
    state: "stale_attempt";
    reasonCode: Extract<ExecutionFenceDecisionV1, { state: "stale_attempt" }>["reasonCode"];
  }
  | {
    state: "quarantined";
    reasonCode:
      | "invalid_retry_state"
      | "invalid_fence_metadata"
      | "contract_hash_conflict"
      | "dependency_integrity_failure"
      | "dependency_contract_conflict"
      | "dependency_permanent_failure";
  }
  | {
    state: "blocked_authorization";
    nextAction: "authorize_dependency";
    nextRetryAt: null;
  }
  | {
    state: "blocked_dependency";
    retryLane: "immediate" | "durable";
    retryOrdinal: number;
    nextRetryAt: Date | null;
    shouldRetryNow: boolean;
    automaticRetryUntil: Date;
  }
  | {
    state: "needs_decision";
    nextAction: "resume_revise_or_cancel";
    automaticRetryUntil: Date;
  };

function finiteDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function count(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function jitterMultiplier(unit: number | undefined, spread: number): number {
  const normalized = Number.isFinite(unit)
    ? Math.min(1, Math.max(0, Number(unit)))
    : 0.5;
  return 1 - spread + (2 * spread * normalized);
}

function maxDate(left: Date, right: Date | null | undefined): Date {
  if (!right || !finiteDate(right)) return left;
  return right.getTime() > left.getTime() ? right : left;
}

function minDate(left: Date, right: Date): Date {
  return right.getTime() < left.getTime() ? right : left;
}

/**
 * Decide the next durable dependency transition without performing I/O.
 * Immediate retries are bounded to three. Durable attempts are anchored to
 * the persisted circuit-open instant, so process restarts cannot extend the
 * retry window or accidentally retry a completed slot.
 */
export function decideDependencyCircuitV1(
  input: DependencyCircuitInputV1,
): DependencyCircuitDecisionV1 {
  const fence = evaluateExecutionFenceV1(input.fence);
  if (fence.state === "cancelled" || fence.state === "stale_attempt") return fence;
  if (fence.state === "integrity_conflict") {
    return { state: "quarantined", reasonCode: fence.reasonCode };
  }

  const now = input.now ?? new Date();
  const immediateAttemptsCompleted = count(input.immediateAttemptsCompleted);
  const durableAttemptsCompleted = count(input.durableAttemptsCompleted);
  const validRetryAfter = input.retryAfterUntil === undefined
    || input.retryAfterUntil === null
    || finiteDate(input.retryAfterUntil);
  if (!finiteDate(now)
    || !finiteDate(input.firstFailureAt)
    || !finiteDate(input.lastFailureAt)
    || !finiteDate(input.circuitOpenedAt)
    || input.lastFailureAt.getTime() < input.firstFailureAt.getTime()
    || input.circuitOpenedAt.getTime() < input.firstFailureAt.getTime()
    || immediateAttemptsCompleted === null
    || durableAttemptsCompleted === null
    || !validRetryAfter) {
    return { state: "quarantined", reasonCode: "invalid_retry_state" };
  }

  if (input.failureClass === "integrity") {
    return { state: "quarantined", reasonCode: "dependency_integrity_failure" };
  }
  if (input.failureClass === "contract_conflict") {
    return { state: "quarantined", reasonCode: "dependency_contract_conflict" };
  }
  if (input.failureClass === "permanent") {
    return { state: "quarantined", reasonCode: "dependency_permanent_failure" };
  }
  if (input.failureClass === "authorization") {
    return {
      state: "blocked_authorization",
      nextAction: "authorize_dependency",
      nextRetryAt: null,
    };
  }

  const automaticRetryUntil = new Date(
    input.firstFailureAt.getTime() + DEPENDENCY_AUTOMATIC_WINDOW_MS_V1,
  );
  if (now.getTime() >= automaticRetryUntil.getTime()) {
    return {
      state: "needs_decision",
      nextAction: "resume_revise_or_cancel",
      automaticRetryUntil,
    };
  }

  if (immediateAttemptsCompleted < DEPENDENCY_IMMEDIATE_RETRY_DELAYS_MS_V1.length) {
    const baseDelay = DEPENDENCY_IMMEDIATE_RETRY_DELAYS_MS_V1[immediateAttemptsCompleted]!;
    const due = new Date(input.lastFailureAt.getTime()
      + Math.round(baseDelay * jitterMultiplier(input.jitterUnit, 0.25)));
    // A provider may ask us not to call it until after the product's automatic
    // retry window. Wake at the product horizon in that case so orchestration
    // can present the required decision without making another provider call.
    // The absolute Retry-After remains part of the persisted blocker state for
    // a later user-authorized resume.
    const nextRetryAt = minDate(
      maxDate(due, input.retryAfterUntil),
      automaticRetryUntil,
    );
    return {
      state: "blocked_dependency",
      retryLane: "immediate",
      retryOrdinal: immediateAttemptsCompleted + 1,
      nextRetryAt,
      shouldRetryNow: nextRetryAt.getTime() <= now.getTime(),
      automaticRetryUntil,
    };
  }

  if (durableAttemptsCompleted >= DEPENDENCY_DURABLE_RETRY_DELAYS_MS_V1.length) {
    return {
      state: "blocked_dependency",
      retryLane: "durable",
      retryOrdinal: DEPENDENCY_DURABLE_RETRY_DELAYS_MS_V1.length,
      nextRetryAt: null,
      shouldRetryNow: false,
      automaticRetryUntil,
    };
  }

  const baseDelay = DEPENDENCY_DURABLE_RETRY_DELAYS_MS_V1[durableAttemptsCompleted]!;
  const scheduled = new Date(input.circuitOpenedAt.getTime()
    + Math.round(baseDelay * jitterMultiplier(input.jitterUnit, 0.1)));
  const nextRetryAt = minDate(
    maxDate(scheduled, input.retryAfterUntil),
    automaticRetryUntil,
  );
  return {
    state: "blocked_dependency",
    retryLane: "durable",
    retryOrdinal: durableAttemptsCompleted + 1,
    nextRetryAt,
    shouldRetryNow: nextRetryAt.getTime() <= now.getTime(),
    automaticRetryUntil,
  };
}
