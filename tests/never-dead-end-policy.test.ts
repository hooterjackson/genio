import { describe, expect, test } from "vitest";
import {
  backendSupportsContract,
  curatedCandidateGoal,
  dependencyRetryDecision,
  projectNeverDeadEndRun,
} from "../server/never-dead-end-policy.ts";

describe("never-dead-end policy", () => {
  test("projects legacy false scarcity into an actionable rescue decision", () => {
    expect(projectNeverDeadEndRun({
      status: "no_compatible_tracks",
      phase: "frontier_exhausted",
    })).toEqual({
      state: "needs_input",
      nextAction: "answer_rescue_guidance",
      terminal: false,
    });
  });

  test("keeps provider failure distinct from scarcity", () => {
    expect(projectNeverDeadEndRun({
      status: "failed_system",
      retryableDependency: true,
    })).toEqual({
      state: "blocked_dependency",
      nextAction: "wait_for_dependency",
      terminal: false,
    });
  });

  test("projects an explicit execution decision without falling back to probing", () => {
    expect(projectNeverDeadEndRun({
      status: "needs_decision",
      phase: "central_quality_floor_missed",
    })).toEqual({
      state: "needs_decision",
      nextAction: "review_contract",
      terminal: false,
    });
  });

  test("bounds dependency retries at 24 hours", () => {
    const blockedAt = new Date("2026-07-23T00:00:00.000Z");
    expect(dependencyRetryDecision({
      blockedAt,
      retryCount: 0,
      now: new Date("2026-07-23T00:01:00.000Z"),
    })).toMatchObject({
      retry: true,
      nextRetryAt: new Date("2026-07-23T00:05:00.000Z"),
      needsDecision: false,
    });
    expect(dependencyRetryDecision({
      blockedAt,
      retryCount: 9,
      now: new Date("2026-07-24T00:00:00.000Z"),
    })).toMatchObject({ retry: false, nextRetryAt: null, needsDecision: true });
  });

  test("anchors all V2 durable slots and turns slot exhaustion or long Retry-After into a decision-only wake", () => {
    const blockedAt = new Date("2026-07-23T00:00:00.000Z");
    const expected = [
      "2026-07-23T00:05:00.000Z",
      "2026-07-23T00:30:00.000Z",
      "2026-07-23T02:00:00.000Z",
      "2026-07-23T06:00:00.000Z",
      "2026-07-23T12:00:00.000Z",
    ];
    expected.forEach((timestamp, retryCount) => {
      expect(dependencyRetryDecision({
        blockedAt,
        retryCount,
        now: new Date("2026-07-23T00:01:00.000Z"),
      })).toMatchObject({
        retry: true,
        nextRetryAt: new Date(timestamp),
        needsDecision: false,
        decisionOnlyWake: false,
      });
    });
    expect(dependencyRetryDecision({
      blockedAt,
      retryCount: 5,
      now: new Date("2026-07-23T12:00:01.000Z"),
    })).toMatchObject({
      retry: false,
      nextRetryAt: new Date("2026-07-24T00:00:00.000Z"),
      needsDecision: false,
      decisionOnlyWake: true,
    });
    expect(dependencyRetryDecision({
      blockedAt,
      retryCount: 0,
      now: new Date("2026-07-23T00:01:00.000Z"),
      retryAfterUntil: new Date("2026-07-25T00:00:00.000Z"),
    })).toMatchObject({
      retry: false,
      nextRetryAt: new Date("2026-07-24T00:00:00.000Z"),
      decisionOnlyWake: true,
    });
  });

  test("sizes curated reserves from conservative conversion while clamping outliers", () => {
    expect(curatedCandidateGoal({ target: 50, p10QualifiedToAppleSafeRate: 0.5 })).toBe(105);
    expect(curatedCandidateGoal({ target: 50, p10QualifiedToAppleSafeRate: 0.01 })).toBe(205);
    expect(curatedCandidateGoal({ target: 50, p10QualifiedToAppleSafeRate: 4 })).toBe(61);
  });

  test("allows backend failover only when every contract capability is supported", () => {
    const backend = {
      backend: "catalog_first_v2",
      predicateOperators: ["and", "not"],
      evidenceGrades: ["structured_metadata", "trusted_container"],
      supportsQuotas: false,
      supportsSequencing: true,
      storefronts: ["us"],
    } as const;
    expect(backendSupportsContract(backend, {
      predicateOperators: ["and", "or"],
      evidenceGrades: ["trusted_container", "track_editorial"],
      requiresQuotas: true,
      requiresSequencing: true,
      storefront: "br",
    })).toEqual({
      supported: false,
      missing: [
        "evidence:track_editorial",
        "feature:quotas",
        "operator:or",
        "storefront:br",
      ],
    });
  });
});
