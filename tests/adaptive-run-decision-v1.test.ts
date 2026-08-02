import { describe, expect, test } from "vitest";
import {
  ADAPTIVE_RUN_DECISION_SCHEMA_V1,
  ACTIVE_COMPUTE_EXTENSION_MS_V1,
  createAdaptiveRunDecisionV1,
  publicAdaptiveRunDecisionV1,
} from "../server/adaptive-run-decision-v1.ts";
import { compilePlaylistContractRevisionV1 } from "../server/playlist-contract-v1.ts";

function contract() {
  return compilePlaylistContractRevisionV1({
    contractId: "rare-jazz-boundary",
    rawPrompt: "100 rare French jazz recordings from the 1970s",
    requestedTrackCount: 100,
    locale: "en",
    storefront: "us",
    clauses: [
      {
        id: "prompt:genre:jazz",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "genre",
        operator: "require",
        values: ["jazz"],
        source: { provenance: "prompt", text: "Jazz" },
      },
      {
        id: "prompt:era:1970s",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "era",
        operator: "require",
        values: ["1970s"],
        source: { provenance: "prompt", text: "Recorded in the 1970s" },
      },
    ],
    trackPredicate: {
      op: "all",
      children: [
        { op: "clause", clauseId: "prompt:genre:jazz" },
        { op: "clause", clauseId: "prompt:era:1970s" },
      ],
    },
  });
}

describe("adaptive run decision v1", () => {
  test("keeps soft avoid clauses out of the preference summary", () => {
    const base = contract();
    const avoidContract = compilePlaylistContractRevisionV1({
      contractId: "fixed-list-decision-summary",
      rawPrompt: "Three exact tracks; exclude covers",
      requestedTrackCount: 3,
      locale: "en",
      storefront: "us",
      clauses: [
        ...base.clauses.map((clause) => ({
          id: clause.id,
          kind: clause.kind,
          scope: clause.scope,
          hardness: clause.hardness,
          axis: clause.axis,
          operator: clause.operator,
          values: clause.values,
          source: clause.source,
        })),
        {
          id: "bridge:constraint:brief_avoid:covers",
          kind: "ranking_preference",
          scope: "track",
          hardness: "soft",
          axis: "relationship",
          operator: "prefer",
          values: ["avoid:covers"],
          source: { provenance: "prompt", text: "covers" },
        },
      ],
      trackPredicate: base.trackPredicate,
    });
    const decision = createAdaptiveRunDecisionV1({
      contract: avoidContract,
      reason: "runtime_feasibility_unknown",
      verifiedTrackCount: 0,
      remainingStrategyCount: 0,
    });
    expect(decision.interpretationSummary.avoid).toContain("covers");
    expect(decision.interpretationSummary.prefer).not.toContain("covers");
  });

  test("offers one bounded extension and separate revision/publication actions", () => {
    const decision = createAdaptiveRunDecisionV1({
      contract: contract(),
      reason: "active_compute_limit",
      verifiedTrackCount: 73,
      remainingStrategyCount: 2,
      consumedActiveComputeMs: ACTIVE_COMPUTE_EXTENSION_MS_V1,
      limitingClauseIds: ["prompt:era:1970s"],
      reachedAt: new Date("2026-07-23T12:00:00.000Z"),
    });
    expect(decision).toMatchObject({
      reason: "active_compute_limit",
      targetTrackCount: 100,
      verifiedTrackCount: 73,
      namedPredicates: [{
        clauseId: "prompt:era:1970s",
        label: "Recorded in the 1970s",
      }],
      actions: {
        anotherBoundedPass: true,
        reviseNamedPredicate: true,
        reduceCount: true,
        publishVerifiedPartial: true,
        pause: true,
        resumeLater: false,
        cancel: true,
      },
    });
    expect(decision.decisionHash).toMatch(/^[a-f0-9]{64}$/u);
    const { schemaVersion, ...publicShape } = decision;
    expect(schemaVersion).toBe(ADAPTIVE_RUN_DECISION_SCHEMA_V1);
    const publicDecision = publicAdaptiveRunDecisionV1(decision);
    expect(publicDecision).toEqual({
      ...publicShape,
      kind: "research_boundary",
    });
    expect(publicAdaptiveRunDecisionV1(publicDecision))
      .toEqual(publicDecision);
  });

  test("does not advertise a second extension or a zero-track partial", () => {
    const decision = createAdaptiveRunDecisionV1({
      contract: contract(),
      reason: "active_compute_limit",
      verifiedTrackCount: 0,
      remainingStrategyCount: 2,
      activeComputeExtensionsUsed: 1,
    });
    expect(decision.actions).toMatchObject({
      anotherBoundedPass: false,
      reduceCount: false,
      publishVerifiedPartial: false,
    });
  });

  test("offers resume-later after the dependency retry window and rejects malformed state", () => {
    const decision = createAdaptiveRunDecisionV1({
      contract: contract(),
      reason: "dependency_retry_window_expired",
      verifiedTrackCount: 0,
      remainingStrategyCount: 0,
    });
    expect(decision.actions.resumeLater).toBe(true);
    expect(publicAdaptiveRunDecisionV1({
      ...decision,
      contractSemanticHash: "private-or-invalid",
    })).toBeNull();
  });

  test("rejects hash-valid-looking decisions whose hashed body was tampered", () => {
    const decision = createAdaptiveRunDecisionV1({
      contract: contract(),
      reason: "active_compute_limit",
      verifiedTrackCount: 73,
      remainingStrategyCount: 2,
      limitingClauseIds: ["prompt:era:1970s"],
      reachedAt: new Date("2026-07-23T12:00:00.000Z"),
    });
    expect(publicAdaptiveRunDecisionV1({
      ...decision,
      verifiedTrackCount: 72,
    })).toBeNull();
    expect(publicAdaptiveRunDecisionV1({
      ...decision,
      contractRevisionId: `${decision.contractRevisionId}:tampered`,
    })).toBeNull();
    expect(publicAdaptiveRunDecisionV1({
      ...decision,
      actions: {
        ...decision.actions,
        anotherBoundedPass: false,
      },
    })).toBeNull();
    expect(publicAdaptiveRunDecisionV1({
      ...decision,
      decisionHash: "0".repeat(64),
    })).toBeNull();
  });

  test("does not advertise a policy-invalid partial when playlist constraints fail", () => {
    const decision = createAdaptiveRunDecisionV1({
      contract: contract(),
      reason: "playlist_optimization_constraints",
      verifiedTrackCount: 73,
      remainingStrategyCount: 0,
      limitingClauseIds: ["prompt:era:1970s"],
    });
    expect(decision.actions).toMatchObject({
      anotherBoundedPass: false,
      reviseNamedPredicate: true,
      reduceCount: true,
      publishVerifiedPartial: false,
    });
    expect(publicAdaptiveRunDecisionV1(decision)?.reason)
      .toBe("playlist_optimization_constraints");
  });
});
