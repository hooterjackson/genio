import { describe, expect, test } from "vitest";
import {
  DEPENDENCY_AUTOMATIC_WINDOW_MS_V1,
  DEPENDENCY_DURABLE_RETRY_DELAYS_MS_V1,
  decideDependencyCircuitV1,
  type DependencyCircuitInputV1,
} from "../server/dependency-circuit-v1.ts";
import {
  evaluateExecutionFenceV1,
  type ExecutionFenceV1,
} from "../server/execution-fence-v1.ts";

const firstFailureAt = new Date("2026-07-23T00:00:00.000Z");
const circuitOpenedAt = new Date("2026-07-23T00:01:00.000Z");

function fence(overrides: Partial<ExecutionFenceV1> = {}): ExecutionFenceV1 {
  return {
    attemptId: "attempt-2",
    activeAttemptId: "attempt-2",
    leaseGeneration: 3,
    activeLeaseGeneration: 3,
    fencingToken: "fence-3",
    activeFencingToken: "fence-3",
    contractRevisionId: "contract-r2",
    activeContractRevisionId: "contract-r2",
    contractSemanticHash: "contract-hash-2",
    activeContractSemanticHash: "contract-hash-2",
    cancelled: false,
    ...overrides,
  };
}

function circuit(
  overrides: Partial<DependencyCircuitInputV1> = {},
): DependencyCircuitInputV1 {
  return {
    fence: fence(),
    failureClass: "transient",
    firstFailureAt,
    lastFailureAt: firstFailureAt,
    circuitOpenedAt,
    immediateAttemptsCompleted: 0,
    durableAttemptsCompleted: 0,
    jitterUnit: 0.5,
    now: firstFailureAt,
    ...overrides,
  };
}

describe("execution fence v1", () => {
  test("permits only the active attempt, lease, fence, and contract", () => {
    expect(evaluateExecutionFenceV1(fence())).toEqual({ state: "allowed" });
    expect(evaluateExecutionFenceV1(fence({
      activeContractRevisionId: "contract-r3",
    }))).toEqual({
      state: "stale_attempt",
      reasonCode: "contract_revision_superseded",
    });
    expect(evaluateExecutionFenceV1(fence({
      activeFencingToken: "fence-4",
    }))).toEqual({
      state: "stale_attempt",
      reasonCode: "fencing_token_superseded",
    });
  });

  test("quarantines a semantic mutation under the same immutable revision id", () => {
    expect(evaluateExecutionFenceV1(fence({
      activeContractSemanticHash: "different-contract-hash",
    }))).toEqual({
      state: "integrity_conflict",
      reasonCode: "contract_hash_conflict",
    });
  });
});

describe("dependency circuit v1", () => {
  test("bounds immediate retries to three and respects an absolute Retry-After", () => {
    const retryAfterUntil = new Date("2026-07-23T00:00:10.000Z");
    expect(decideDependencyCircuitV1(circuit({
      retryAfterUntil,
    }))).toMatchObject({
      state: "blocked_dependency",
      retryLane: "immediate",
      retryOrdinal: 1,
      nextRetryAt: retryAfterUntil,
      shouldRetryNow: false,
    });

    const third = decideDependencyCircuitV1(circuit({
      immediateAttemptsCompleted: 2,
      lastFailureAt: new Date("2026-07-23T00:00:20.000Z"),
      now: new Date("2026-07-23T00:00:24.000Z"),
    }));
    expect(third).toMatchObject({
      state: "blocked_dependency",
      retryLane: "immediate",
      retryOrdinal: 3,
      nextRetryAt: new Date("2026-07-23T00:00:24.000Z"),
      shouldRetryNow: true,
    });
  });

  test("anchors durable slots at 5m, 30m, 2h, 6h, and 12h from circuit open", () => {
    for (const [index, delay] of DEPENDENCY_DURABLE_RETRY_DELAYS_MS_V1.entries()) {
      const due = new Date(circuitOpenedAt.getTime() + delay);
      const decision = decideDependencyCircuitV1(circuit({
        immediateAttemptsCompleted: 3,
        durableAttemptsCompleted: index,
        lastFailureAt: circuitOpenedAt,
        now: due,
      }));
      expect(decision).toMatchObject({
        state: "blocked_dependency",
        retryLane: "durable",
        retryOrdinal: index + 1,
        nextRetryAt: due,
        shouldRetryNow: true,
      });
    }
  });

  test("caps a longer Retry-After at the decision-only 24-hour wake", () => {
    const automaticRetryUntil = new Date(
      firstFailureAt.getTime() + DEPENDENCY_AUTOMATIC_WINDOW_MS_V1,
    );
    const retryAfterUntil = new Date(automaticRetryUntil.getTime() + 24 * 60 * 60_000);
    expect(decideDependencyCircuitV1(circuit({
      immediateAttemptsCompleted: 3,
      durableAttemptsCompleted: 0,
      lastFailureAt: circuitOpenedAt,
      retryAfterUntil,
      now: circuitOpenedAt,
    }))).toMatchObject({
      state: "blocked_dependency",
      retryLane: "durable",
      nextRetryAt: automaticRetryUntil,
      shouldRetryNow: false,
      automaticRetryUntil,
    });
  });

  test("waits without inventing a sixth durable retry, then requires a decision at 24h", () => {
    const beforeDeadline = new Date(
      firstFailureAt.getTime() + DEPENDENCY_AUTOMATIC_WINDOW_MS_V1 - 1,
    );
    expect(decideDependencyCircuitV1(circuit({
      immediateAttemptsCompleted: 3,
      durableAttemptsCompleted: 5,
      lastFailureAt: beforeDeadline,
      now: beforeDeadline,
    }))).toMatchObject({
      state: "blocked_dependency",
      retryLane: "durable",
      nextRetryAt: null,
      shouldRetryNow: false,
    });

    const automaticRetryUntil = new Date(
      firstFailureAt.getTime() + DEPENDENCY_AUTOMATIC_WINDOW_MS_V1,
    );
    expect(decideDependencyCircuitV1(circuit({
      immediateAttemptsCompleted: 3,
      durableAttemptsCompleted: 5,
      lastFailureAt: beforeDeadline,
      now: automaticRetryUntil,
    }))).toEqual({
      state: "needs_decision",
      nextAction: "resume_revise_or_cancel",
      automaticRetryUntil,
    });
  });

  test("separates authorization blockers from integrity quarantine", () => {
    expect(decideDependencyCircuitV1(circuit({
      failureClass: "authorization",
    }))).toEqual({
      state: "blocked_authorization",
      nextAction: "authorize_dependency",
      nextRetryAt: null,
    });
    expect(decideDependencyCircuitV1(circuit({
      failureClass: "integrity",
    }))).toEqual({
      state: "quarantined",
      reasonCode: "dependency_integrity_failure",
    });
  });

  test("does no work for cancellation or a superseded attempt", () => {
    expect(decideDependencyCircuitV1(circuit({
      fence: fence({ cancelled: true }),
    }))).toEqual({ state: "cancelled", reasonCode: "run_cancelled" });
    expect(decideDependencyCircuitV1(circuit({
      fence: fence({ activeAttemptId: "attempt-3" }),
    }))).toEqual({
      state: "stale_attempt",
      reasonCode: "attempt_superseded",
    });
  });

  test("quarantines malformed persisted retry state", () => {
    expect(decideDependencyCircuitV1(circuit({
      durableAttemptsCompleted: -1,
    }))).toEqual({
      state: "quarantined",
      reasonCode: "invalid_retry_state",
    });
  });
});
