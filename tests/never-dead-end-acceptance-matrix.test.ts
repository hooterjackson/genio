import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  DATABASE_SCHEMA_V13_BRIDGE_SUPPORT,
  isDatabaseSchemaVersionCompatible,
} from "../db/index.ts";
import {
  playlistWorkMotion,
  playlistWorkStage,
} from "../app/playlist-waiting-state.ts";
import {
  CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY,
  negotiatePlaylistContractBackendV1,
} from "../server/playlist-contract-backend-capability-v1.ts";
import {
  canonicalContractExecutionPolicyV1,
  evaluateCanonicalContractTrackV1,
} from "../server/canonical-contract-runtime-v1.ts";
import {
  evaluateExecutionFenceV1,
  type ExecutionFenceV1,
} from "../server/execution-fence-v1.ts";
import {
  compilePlaylistContractRevisionV1,
  evaluatePlaylistQuotasV1,
  type PlaylistClauseAssessmentV1,
  type PlaylistContractDraftV1,
} from "../server/playlist-contract-v1.ts";
import { assessPlaylistFeasibilityV1 } from "../server/playlist-feasibility-v1.ts";
import {
  createAdaptiveRunDecisionV1,
} from "../server/adaptive-run-decision-v1.ts";
import {
  recompileCustomGuidanceTextV3,
} from "../server/adaptive-guidance-v3.ts";

const structuredPass = {
  status: "pass",
  evidenceGrade: "authoritative_structured_metadata",
} as const satisfies PlaylistClauseAssessmentV1;

const structuredFail = {
  status: "fail",
  evidenceGrade: "authoritative_structured_metadata",
} as const satisfies PlaylistClauseAssessmentV1;

const factualPass = {
  status: "pass",
  evidenceGrade: "independent_secondary_source",
} as const satisfies PlaylistClauseAssessmentV1;

function booleanContractDraft(): PlaylistContractDraftV1 {
  return {
    contractId: "acceptance:boolean-not-except-mostly",
    rawPrompt: "Mostly women: jazz or dark ambient for sleep, not explicit, except live versions.",
    requestedTrackCount: 100,
    locale: "en-US",
    storefront: "us",
    clauses: [
      {
        id: "genre:jazz",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "genre",
        operator: "require",
        values: ["jazz"],
        source: { provenance: "prompt", text: "jazz" },
      },
      {
        id: "genre:dark-ambient",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "genre",
        operator: "require",
        values: ["dark ambient"],
        source: { provenance: "prompt", text: "dark ambient" },
      },
      {
        id: "activity:sleep",
        kind: "factual_relationship",
        scope: "track",
        hardness: "hard",
        axis: "activity",
        operator: "require",
        values: ["suitable for sleep"],
        source: { provenance: "prompt", text: "for sleep" },
      },
      {
        id: "content:explicit",
        kind: "catalog_version",
        scope: "track",
        hardness: "hard",
        axis: "content",
        operator: "require",
        values: ["explicit-content:explicit"],
        source: { provenance: "prompt", text: "explicit" },
      },
      {
        id: "version:live",
        kind: "catalog_version",
        scope: "track",
        hardness: "hard",
        axis: "recording_version",
        operator: "require",
        values: ["live"],
        source: { provenance: "prompt", text: "live versions" },
      },
      {
        id: "artist:women",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "artist",
        operator: "require",
        values: ["women artists"],
        source: { provenance: "prompt", text: "women artists" },
      },
      {
        id: "quota:mostly-women",
        kind: "quota_diversity",
        scope: "playlist",
        hardness: "hard",
        axis: "artist",
        operator: "limit",
        values: ["minimum women-artist share 0.51"],
        source: { provenance: "prompt", text: "mostly women" },
      },
    ],
    trackPredicate: {
      op: "all",
      children: [
        {
          op: "any",
          children: [
            { op: "clause", clauseId: "genre:jazz" },
            { op: "clause", clauseId: "genre:dark-ambient" },
          ],
        },
        { op: "not", child: { op: "clause", clauseId: "content:explicit" } },
        {
          op: "except",
          base: { op: "clause", clauseId: "activity:sleep" },
          exceptions: [{ op: "clause", clauseId: "version:live" }],
        },
      ],
    },
    playlistConstraints: [{
      id: "distribution:mostly-women",
      clauseId: "quota:mostly-women",
      predicate: { op: "clause", clauseId: "artist:women" },
      minimumCount: null,
      maximumCount: null,
      minimumRatio: 0.51,
      maximumRatio: 1,
    }],
  };
}

function oneClauseContract(input: {
  contractId: string;
  rawPrompt: string;
  requestedTrackCount: number;
  versions?: PlaylistContractDraftV1["versions"];
}) {
  return compilePlaylistContractRevisionV1({
    contractId: input.contractId,
    rawPrompt: input.rawPrompt,
    requestedTrackCount: input.requestedTrackCount,
    locale: "en-US",
    storefront: "us",
    versions: input.versions,
    clauses: [{
      id: "scope:membership",
      kind: "membership",
      scope: "track",
      hardness: "hard",
      axis: "genre",
      operator: "require",
      values: ["jazz"],
      source: { provenance: "prompt", text: "jazz" },
    }],
    trackPredicate: { op: "clause", clauseId: "scope:membership" },
  });
}

describe("never-dead-end adversarial acceptance matrix", () => {
  test("executes nested OR, NOT, exceptions, and a literal mostly quota without flattening", () => {
    const contract = compilePlaylistContractRevisionV1(booleanContractDraft());
    const policy = canonicalContractExecutionPolicyV1(contract);
    expect(policy.trackPredicate).toEqual(contract.trackPredicate);

    const eligible = evaluateCanonicalContractTrackV1({
      policy,
      assessments: {
        "genre:jazz": structuredFail,
        "genre:dark-ambient": structuredPass,
        "activity:sleep": factualPass,
        "content:explicit": structuredFail,
        "version:live": structuredFail,
      },
    });
    expect(eligible).toMatchObject({ status: "pass", eligible: true });

    expect(evaluateCanonicalContractTrackV1({
      policy,
      assessments: {
        "genre:jazz": structuredPass,
        "activity:sleep": factualPass,
        "content:explicit": structuredPass,
        "version:live": structuredFail,
      },
    })).toMatchObject({ status: "fail", eligible: false });

    expect(evaluateCanonicalContractTrackV1({
      policy,
      assessments: {
        "genre:jazz": structuredPass,
        "activity:sleep": factualPass,
        "content:explicit": structuredFail,
        "version:live": structuredPass,
      },
    })).toMatchObject({ status: "fail", eligible: false });

    const fiftyOne = Array.from({ length: 100 }, (_, index) => ({
      "artist:women": index < 51 ? structuredPass : structuredFail,
    }));
    const fifty = Array.from({ length: 100 }, (_, index) => ({
      "artist:women": index < 50 ? structuredPass : structuredFail,
    }));
    expect(evaluatePlaylistQuotasV1(contract, fiftyOne)[0]).toMatchObject({
      status: "pass",
      passCount: 51,
      totalCount: 100,
    });
    expect(evaluatePlaylistQuotasV1(contract, fifty)[0]).toMatchObject({
      status: "fail",
      passCount: 50,
      totalCount: 100,
    });
  });

  test("refuses replay after either the ontology or evidence-policy snapshot changes", () => {
    const future = oneClauseContract({
      contractId: "acceptance:future-policy",
      rawPrompt: "Twenty jazz tracks.",
      requestedTrackCount: 20,
      versions: {
        ontology: "playlist_music_ontology_v99",
        evidencePolicy: "governed_evidence_v99",
      },
    });
    const negotiation = negotiatePlaylistContractBackendV1({
      contract: future,
      backends: [CORPUS_FIRST_V3_PLAYLIST_CONTRACT_CAPABILITY],
    });
    expect(negotiation.backend).toBeNull();
    expect(negotiation.result.missing).toEqual(expect.arrayContaining([
      "corpus_first_v3:ontology:playlist_music_ontology_v99",
      "corpus_first_v3:evidence_policy:governed_evidence_v99",
    ]));
  });

  test("keeps every new state renderable by an old client and treats unknown future states as active", () => {
    const states = [
      ["accepted", false, "active"],
      ["needs_input", false, "action-required"],
      ["probing", false, "active"],
      ["executing", false, "active"],
      ["blocked_dependency", false, "paused"],
      ["needs_decision", false, "action-required"],
      ["ready", false, "active"],
      ["publishing", false, "active"],
      ["completed", true, "idle"],
      ["cancelled", true, "idle"],
      ["quarantined", false, "paused"],
    ] as const;
    for (const [state, terminal, motion] of states) {
      expect(playlistWorkMotion({
        status: "researching",
        resolution: { state, terminal, nextAction: "none" },
      }), state).toBe(motion);
    }
    expect(playlistWorkMotion({
      status: "researching",
      resolution: {
        state: "future_nonterminal_state",
        terminal: false,
        nextAction: "future_action",
      },
    })).toBe("active");
    expect(playlistWorkStage({
      status: "future_nonterminal_status",
      phase: "future_nonterminal_phase",
    })).toBe("discover");
  });

  test.each(["probing", "executing", "ready", "publishing"] as const)(
    "applies the same cancellation and restart fence during %s",
    (stage) => {
      const base: ExecutionFenceV1 = {
        attemptId: `attempt:${stage}`,
        activeAttemptId: `attempt:${stage}`,
        leaseGeneration: 1,
        activeLeaseGeneration: 1,
        fencingToken: `fence:${stage}`,
        activeFencingToken: `fence:${stage}`,
        contractRevisionId: "revision:1",
        activeContractRevisionId: "revision:1",
        contractSemanticHash: "a".repeat(64),
        activeContractSemanticHash: "a".repeat(64),
        cancelled: false,
      };
      expect(evaluateExecutionFenceV1({ ...base, cancelled: true })).toEqual({
        state: "cancelled",
        reasonCode: "run_cancelled",
      });
      expect(evaluateExecutionFenceV1({
        ...base,
        activeAttemptId: `attempt:${stage}:restart`,
      })).toEqual({
        state: "stale_attempt",
        reasonCode: "attempt_superseded",
      });
    },
  );

  test("keeps schema-18 writes expand-only enough for the schema-13 bridge binary to remain healthy", () => {
    const schema17 = readFileSync(
      new URL("../postgres-migrations/0016_playlist_contract_foundation.sql", import.meta.url),
      "utf8",
    );
    const schema18 = readFileSync(
      new URL("../postgres-migrations/0017_playlist_recovery_foundation.sql", import.meta.url),
      "utf8",
    );
    for (const migration of [schema17, schema18]) {
      expect(migration).not.toMatch(/\bDROP\s+TABLE\b/iu);
      expect(migration).not.toMatch(/\bDROP\s+COLUMN\b/iu);
      expect(migration).not.toMatch(/\bTRUNCATE\b/iu);
    }
    expect(schema17).not.toMatch(/\bDELETE\s+FROM\b/iu);
    expect([...schema18.matchAll(/\bDELETE\s+FROM\s+([a-z_]+)/giu)]
      .map((match) => match[1])).toEqual(["pipeline_cohort_kill_switches"]);
    expect(isDatabaseSchemaVersionCompatible(
      "18",
      DATABASE_SCHEMA_V13_BRIDGE_SUPPORT,
    )).toBe(true);
  });

  test("distinguishes rising-yield continuation from a flat exhausted frontier at 15 minutes", () => {
    const contract = oneClauseContract({
      contractId: "acceptance:rare-100",
      rawPrompt: "100 rare French jazz recordings from the 1970s.",
      requestedTrackCount: 100,
    });
    const rising = createAdaptiveRunDecisionV1({
      contract,
      reason: "active_compute_limit",
      verifiedTrackCount: 73,
      remainingStrategyCount: 2,
      consumedActiveComputeMs: 15 * 60_000,
    });
    const flat = createAdaptiveRunDecisionV1({
      contract,
      reason: "frontier_exhausted_under_policy",
      verifiedTrackCount: 73,
      remainingStrategyCount: 0,
      consumedActiveComputeMs: 15 * 60_000,
    });
    expect(rising.actions.anotherBoundedPass).toBe(true);
    expect(flat.actions.anotherBoundedPass).toBe(false);
    expect(flat.actions.publishVerifiedPartial).toBe(true);
  });

  test("labels a fixed Kind of Blue count shortfall as a known ceiling, not open-world failure", () => {
    const contract = compilePlaylistContractRevisionV1({
      contractId: "acceptance:kind-of-blue",
      rawPrompt: "Every track from Kind of Blue, exactly 25 tracks.",
      requestedTrackCount: 25,
      locale: "en-US",
      storefront: "us",
      clauses: [{
        id: "fixed-release:kind-of-blue",
        kind: "membership",
        scope: "track",
        hardness: "hard",
        axis: "release",
        operator: "require",
        values: ["Kind of Blue"],
        source: {
          provenance: "prompt",
          text: "Every track from Kind of Blue",
        },
      }],
      trackPredicate: {
        op: "clause",
        clauseId: "fixed-release:kind-of-blue",
      },
    });
    expect(assessPlaylistFeasibilityV1({
      contractRevisionId: contract.revisionId,
      contractSemanticHash: contract.semanticHash,
      targetTrackCount: 25,
      scope: "closed_set",
      phase: "preview",
      dependencyHealth: "healthy",
      eligibleEstimateLower: 5,
      eligibleEstimateUpper: 5,
      closedSetCapacity: 5,
      discoveredCount: 5,
      qualifiedCount: 5,
      storefrontSafeCount: 5,
      contradictions: [],
      limitingPredicateIds: ["fixed-release:kind-of-blue"],
      frontiers: [],
      activeResearchBudgetExhausted: false,
      policyVersions: { catalog: "catalog_policy_v1" },
    })).toMatchObject({
      state: "known_ceiling",
      reasonCodes: ["closed_set_below_requested_count"],
      targetTrackCount: 25,
    });
  });

  test("rejects custom text that would require and exclude the same artist", () => {
    const contract = compilePlaylistContractRevisionV1({
      contractId: "acceptance:custom-conflict",
      rawPrompt: "Only Bad Bunny reggaeton tracks.",
      requestedTrackCount: 20,
      locale: "en-US",
      storefront: "us",
      clauses: [
        {
          id: "genre:reggaeton",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "genre",
          operator: "require",
          values: ["reggaeton"],
          source: { provenance: "prompt", text: "reggaeton" },
        },
        {
          id: "artist:bad-bunny",
          kind: "membership",
          scope: "track",
          hardness: "hard",
          axis: "artist",
          operator: "require",
          values: ["Bad Bunny"],
          source: { provenance: "prompt", text: "Only Bad Bunny" },
        },
      ],
      trackPredicate: {
        op: "all",
        children: [
          { op: "clause", clauseId: "genre:reggaeton" },
          { op: "clause", clauseId: "artist:bad-bunny" },
        ],
      },
    });
    expect(() => recompileCustomGuidanceTextV3({
      base: contract,
      customText: "No Bad Bunny",
    })).toThrow("custom_guidance_conflicts_with_existing_hard_predicate");
  });
});
