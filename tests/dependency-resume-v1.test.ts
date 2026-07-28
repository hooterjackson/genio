import { describe, expect, test } from "vitest";
import type { RunDecisionActionView } from "../shared/types.ts";
import {
  decideDependencyResumeV1,
  dependencyResumeAuthorizationHashV1,
  dependencyResumeBlockerVersionV1,
  type DependencyResumeEligibilityInputV1,
} from "../server/dependency-resume-v1.ts";

const now = new Date("2026-07-24T12:00:00.000Z");
const automaticRetryUntil = new Date("2026-07-24T11:59:00.000Z");
const retryAfterUntil = new Date("2026-07-24T12:30:00.000Z");
const semanticHash = "a".repeat(64);
const decisionHash = "b".repeat(64);
const executorHash = "c".repeat(64);

const decision: RunDecisionActionView = {
  kind: "research_boundary",
  decisionHash,
  contractRevisionId: "pcr1:dependency-resume",
  contractSemanticHash: semanticHash,
  reason: "dependency_retry_window_expired",
  targetTrackCount: 50,
  verifiedTrackCount: 0,
  remainingStrategyCount: 0,
  consumedActiveComputeMs: 0,
  activeComputeLimitMs: 900_000,
  activeComputeExtensionsUsed: 0,
  namedPredicates: [],
  interpretationSummary: {
    mustHave: ["Reggaeton"],
    prefer: ["Smooth"],
    avoid: [],
    flow: ["Editorial flow"],
    count: 50,
  },
  actions: {
    anotherBoundedPass: false,
    reviseNamedPredicate: false,
    reduceCount: false,
    publishVerifiedPartial: false,
    pause: true,
    resumeLater: true,
    cancel: true,
  },
  reachedAt: "2026-07-24T11:59:00.000Z",
};

function eligibleInput(): DependencyResumeEligibilityInputV1 {
  const blocker = {
    id: "blocker-dependency",
    contractRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    dependencyKey: "v3_retrieval_provider",
    retryCount: 8,
    automaticRetryUntil,
    retryAfterUntil,
    stageKey: `v3-retrieval:active:${"d".repeat(48)}`,
    decisionHash,
    nextAction: "resume_revise_or_cancel",
    kind: "provider",
    resolved: false,
  };
  return {
    now,
    runStatus: "needs_decision",
    runPhase: "dependency_retry_window_expired",
    activeContractRevisionId: blocker.contractRevisionId,
    activeContractSemanticRevisionId: decision.contractRevisionId,
    activeContractSemanticHash: semanticHash,
    expectedContractRevisionId: blocker.contractRevisionId,
    expectedContractSemanticHash: semanticHash,
    expectedDecisionHash: decisionHash,
    expectedBlockerVersion: dependencyResumeBlockerVersionV1(blocker),
    blocker,
    decision,
    queryPlan: {
      status: "active",
      schemaVersion: 5,
      playlistContractRevisionId: decision.contractRevisionId,
      playlistContractSemanticHash: semanticHash,
      stageKey: blocker.stageKey,
      expectedStageKey: blocker.stageKey,
      executorCapabilityHash: executorHash,
      expectedExecutorCapabilityHash: executorHash,
      executorCapabilityMatches: true,
    },
  };
}

describe("dependency resume v1", () => {
  test("authorizes only the retained provider decision and honors Retry-After", () => {
    expect(decideDependencyResumeV1(eligibleInput())).toEqual({
      state: "eligible",
      blockerVersion: eligibleInput().expectedBlockerVersion,
      resumeAt: retryAfterUntil,
    });
  });

  test("rejects a blocker before the automatic 24-hour boundary", () => {
    const input = eligibleInput();
    input.blocker.automaticRetryUntil =
      new Date("2026-07-24T12:01:00.000Z");
    input.expectedBlockerVersion =
      dependencyResumeBlockerVersionV1(input.blocker);
    expect(decideDependencyResumeV1(input)).toEqual({
      state: "ineligible",
      reasonCode: "dependency_resume_not_ready",
    });
  });

  test("rejects generic scope decisions and stale browser hashes", () => {
    const wrongKind = eligibleInput();
    wrongKind.blocker.kind = "scope_decision";
    expect(decideDependencyResumeV1(wrongKind)).toEqual({
      state: "ineligible",
      reasonCode: "dependency_resume_not_ready",
    });

    const stale = eligibleInput();
    stale.expectedBlockerVersion = "0".repeat(64);
    expect(decideDependencyResumeV1(stale)).toEqual({
      state: "ineligible",
      reasonCode: "dependency_resume_stale",
    });
  });

  test("rejects contract drift and non-exact executor capability", () => {
    const contractDrift = eligibleInput();
    contractDrift.expectedContractSemanticHash = "1".repeat(64);
    expect(decideDependencyResumeV1(contractDrift)).toEqual({
      state: "ineligible",
      reasonCode: "dependency_resume_contract_conflict",
    });

    const executorDrift = eligibleInput();
    executorDrift.queryPlan.executorCapabilityMatches = false;
    expect(decideDependencyResumeV1(executorDrift)).toEqual({
      state: "ineligible",
      reasonCode: "dependency_resume_executor_conflict",
    });
  });

  test("binds authorization to capability, idempotency, and immutable work", () => {
    const material = {
      runId: "run-dependency",
      sourceAccessId: "access-dependency",
      capabilitySessionId: "session-dependency",
      idempotencyKey: "dependency-resume-key",
      contractRevisionId: "contract-db-dependency",
      contractSemanticHash: semanticHash,
      queryPlanRevisionId: "query-plan-dependency",
      queryPlanHash: "d".repeat(64),
      blockerId: "blocker-dependency",
      blockerVersion: eligibleInput().expectedBlockerVersion,
      decisionHash,
      dependencyKey: "v3_retrieval_provider",
      stageKey: eligibleInput().blocker.stageKey,
      resumeAt: retryAfterUntil,
    };
    const first = dependencyResumeAuthorizationHashV1(material);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(dependencyResumeAuthorizationHashV1(material)).toBe(first);
    expect(dependencyResumeAuthorizationHashV1({
      ...material,
      idempotencyKey: "dependency-resume-other",
    })).not.toBe(first);
  });
});
