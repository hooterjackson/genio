import { describe, expect, test } from "vitest";
import {
  assignPipelineV3,
  createQueryPlanV3,
  createRuntimeQueryPlanV3,
  isQueryPlanV3,
  queryPlanV3EmissionSchemaVersion,
  queryPlanV3Engines,
  queryPlanV3Hash,
} from "../server/query-plan-v3.ts";
import { createRunSpecV3, resolveRunSpecV3 } from "../server/selection-plan-v3.ts";
import { MUSIC_CONCEPT_POLICY_VERSION } from "../server/music-concepts-v3.ts";

function confirmed(prompt: string, target = 50) {
  const spec = createRunSpecV3({ prompt, requestedTrackCount: target, storefront: "us" });
  const answers = spec.criticalAmbiguities.map((ambiguity) => {
    if (ambiguity.key === "house_semantics") return { key: ambiguity.key, optionId: "house_genre" as const };
    if (ambiguity.key === "french_jazz_scope") return { key: ambiguity.key, optionId: "french_scene" as const };
    if (ambiguity.key === "geographic_genre_scope") return { key: ambiguity.key, optionId: "geographic_scene" as const };
    if (ambiguity.key === "possessive_relationship") return { key: ambiguity.key, optionId: "subject_performed" as const };
    return { key: ambiguity.key, optionId: "funk_carioca" as const };
  });
  return resolveRunSpecV3(spec, answers);
}

describe("query plan V3", () => {
  test("preserves the exact 1-300 target and separates ranking from hard membership", () => {
    const plan = confirmed("Paulinho da Costa's 176 most influential songs", 176);
    const query = createQueryPlanV3(plan, "00000000-0000-4000-8000-000000000001");
    expect(query.schemaVersion).toBe(2);
    expect(query.policyVersion).toBe("corpus_first_v3_policy_v1");
    expect(query.targetTrackCount).toBe(176);
    expect(query.engine).toBe("factual_relationship");
    expect(query.membershipPredicates.some(({ kind }) => kind === "factual_relationship")).toBe(true);
    expect(query.membershipPredicates.some(({ kind }) => kind === "influence")).toBe(false);
    expect(query.rankingObjectives.some(({ kind }) => kind === "influence")).toBe(true);
    expect(query.semanticPolicyVersion).toBe("scope_gate_v2_1_2");
    expect(query.musicConceptPolicyVersion).toBe(MUSIC_CONCEPT_POLICY_VERSION);
    expect(query.semanticAuditMetadata?.musicConceptPolicyVersion).toBe(MUSIC_CONCEPT_POLICY_VERSION);
    expect(query.semanticClauses?.some(({ role, axis, values }) => (
      role === "membership" && axis === "factual_relationship" && values.length > 0
    ))).toBe(true);
    expect(query.explicitUserConstraintHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(query.hardConstraintHash).toBe(query.semanticAuditMetadata?.hardConstraintHash);
    expect(query.hardConstraints.some((constraint) => (
      constraint.axis === "relationship" && constraint.operator === "require"
    ))).toBe(false);
    expect(isQueryPlanV3(query)).toBe(true);
    expect(queryPlanV3Hash(query)).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("keeps runtime emission on schema 1 until the explicit activation flag is set", () => {
    const base = confirmed("25 disco songs", 25);
    const plan = {
      ...base,
      hardConstraints: [
        ...base.hardConstraints,
        {
          id: "artist-quota",
          axis: "artist" as const,
          operator: "maximum" as const,
          values: ["4"],
          kind: "hard" as const,
          relaxationRank: null,
        },
      ],
    };
    const snapshot = "00000000-0000-4000-8000-000000000001";
    expect(queryPlanV3EmissionSchemaVersion({})).toBe(1);
    const compatibility = createRuntimeQueryPlanV3(plan, snapshot, {});
    expect(compatibility.schemaVersion).toBe(1);
    expect(compatibility.semanticClauses).toBeUndefined();
    expect(compatibility.musicConceptPolicyVersion).toBeUndefined();
    expect(compatibility.hardConstraints).toEqual([expect.objectContaining({
      id: "artist-quota",
      axis: "artist",
      operator: "maximum",
      values: ["4"],
    })]);
    expect(isQueryPlanV3(compatibility)).toBe(true);

    const activated = createRuntimeQueryPlanV3(plan, snapshot, {
      PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "2",
    });
    expect(activated.schemaVersion).toBe(2);
    expect(activated.semanticClauses?.some(({ role }) => role === "membership")).toBe(true);
    expect(isQueryPlanV3(activated)).toBe(true);
  });

  test("continues to validate historical schema-1 query plans", () => {
    const current = createQueryPlanV3(
      confirmed("25 disco songs", 25),
      "00000000-0000-4000-8000-000000000001",
    );
    const legacy = {
      ...current,
      schemaVersion: 1,
      policyVersion: "corpus_first_v3_policy_v1",
      semanticPolicyVersion: undefined,
      musicConceptPolicyVersion: undefined,
      semanticClauses: undefined,
      contextSignals: undefined,
      catalogPolicies: undefined,
      recordingPolicy: undefined,
      explicitUserConstraintHash: undefined,
      hardConstraintHash: undefined,
      semanticAuditMetadata: undefined,
    };
    expect(isQueryPlanV3(legacy)).toBe(true);
  });

  test("schema 3 binds contract-2 guidance and governed evidence metadata", () => {
    const plan = confirmed("25 disco songs", 25);
    const snapshot = "00000000-0000-4000-8000-000000000001";
    const executionDeltaHash = "b".repeat(64);
    const query = createQueryPlanV3(plan, snapshot, {
      schemaVersion: 3,
      briefContractVersion: 2,
      executionDeltaHash,
    });
    expect(query).toMatchObject({
      schemaVersion: 3,
      briefContractVersion: 2,
      guidancePolicyVersion: "intelligent_guidance_v2",
      evidencePolicyVersion: "governed_evidence_v1",
      executionDeltaHash,
    });
    expect(isQueryPlanV3(query)).toBe(true);
    expect(() => createQueryPlanV3(plan, snapshot, { schemaVersion: 3 })).toThrow(/contract-2/iu);
    expect(isQueryPlanV3({ ...query, executionDeltaHash: "tampered" })).toBe(false);
    expect(isQueryPlanV3({ ...query, briefContractVersion: 1 })).toBe(false);
  });

  test("rejects schema-2 plans whose governed music-concept policy drifts", () => {
    const query = createQueryPlanV3(
      confirmed("25 disco songs", 25),
      "00000000-0000-4000-8000-000000000001",
    );
    expect(isQueryPlanV3(query)).toBe(true);
    expect(isQueryPlanV3({
      ...query,
      musicConceptPolicyVersion: "music_concepts_future",
    })).toBe(false);
    expect(isQueryPlanV3({
      ...query,
      semanticAuditMetadata: {
        ...query.semanticAuditMetadata!,
        musicConceptPolicyVersion: "music_concepts_future",
      },
    })).toBe(false);
  });

  test("rejects drift between schema-2 membership clauses and their legacy projection", () => {
    const query = createQueryPlanV3(
      confirmed("Paulinho da Costa's 25 most influential songs", 25),
      "00000000-0000-4000-8000-000000000001",
    );
    const predicates = query.membershipPredicates;
    const predicate = query.membershipPredicates[0]!;
    expect(query.semanticClauses?.filter(({ role }) => role === "membership").length).toBeGreaterThan(0);
    expect(isQueryPlanV3(query)).toBe(true);

    // `include` and `require` are the same positive membership operation.
    expect(isQueryPlanV3({
      ...query,
      membershipPredicates: predicates.map((item, index) => index === 0
        ? {
          ...predicate,
          relationship: predicate.relationship === "include" ? "require" : "include",
        }
        : item),
    })).toBe(true);

    for (const membershipPredicates of [
      [null],
      predicates.slice(1),
      predicates.map((item, index) => index === 0 ? { ...predicate, id: "tampered-id" } : item),
      predicates.map((item, index) => index === 0 ? { ...predicate, kind: "genre" } : item),
      predicates.map((item, index) => index === 0 ? { ...predicate, relationship: "exclude" } : item),
      predicates.map((item, index) => index === 0 ? { ...predicate, subject: `${predicate.subject} (tampered)` } : item),
      predicates.map((item, index) => index === 0 ? { ...predicate, hard: false } : item),
      [...predicates, { ...predicate, id: "unexpected-extra-predicate" }],
    ]) {
      expect(isQueryPlanV3({ ...query, membershipPredicates })).toBe(false);
    }
  });

  test("requires exact bidirectional context and catalog-policy role projections", () => {
    const query = createQueryPlanV3(
      confirmed(
        "49 iconic disco songs for a Paris dinner, only live versions",
        49,
      ),
      "00000000-0000-4000-8000-000000000001",
    );
    const context = query.contextSignals?.[0];
    const policy = query.catalogPolicies?.[0];
    expect(context).toBeDefined();
    expect(policy).toBeDefined();
    expect(isQueryPlanV3(query)).toBe(true);

    expect(isQueryPlanV3({ ...query, contextSignals: [] })).toBe(false);
    expect(isQueryPlanV3({ ...query, catalogPolicies: [] })).toBe(false);
    expect(isQueryPlanV3({
      ...query,
      contextSignals: [context!, { ...context!, id: "duplicate-context-projection" }],
    })).toBe(false);

    const unprojectedContext = { ...context!, id: "unprojected-context-clause" };
    expect(isQueryPlanV3({
      ...query,
      semanticClauses: [...query.semanticClauses!, unprojectedContext],
      semanticAuditMetadata: {
        ...query.semanticAuditMetadata!,
        clauseCount: query.semanticAuditMetadata!.clauseCount + 1,
        contextClauseCount: query.semanticAuditMetadata!.contextClauseCount + 1,
      },
    })).toBe(false);

    const unprojectedPolicy = { ...policy!, id: "unprojected-catalog-policy-clause" };
    expect(isQueryPlanV3({
      ...query,
      semanticClauses: [...query.semanticClauses!, unprojectedPolicy],
      semanticAuditMetadata: {
        ...query.semanticAuditMetadata!,
        clauseCount: query.semanticAuditMetadata!.clauseCount + 1,
        catalogPolicyClauseCount: query.semanticAuditMetadata!.catalogPolicyClauseCount + 1,
      },
    })).toBe(false);
  });

  test("keeps only executable aggregate quotas in schema-2 hard constraints", () => {
    const base = confirmed("25 disco songs", 25);
    const query = createQueryPlanV3({
      ...base,
      hardConstraints: [
        ...base.hardConstraints,
        {
          id: "legacy-unbound-geography",
          axis: "geography",
          operator: "require",
          values: ["Rio de Janeiro"],
          kind: "hard",
          relaxationRank: null,
        },
        {
          id: "artist-quota",
          axis: "artist",
          operator: "maximum",
          values: ["4"],
          kind: "hard",
          relaxationRank: null,
        },
      ],
    }, "00000000-0000-4000-8000-000000000001");

    expect(query.hardConstraints).toEqual([expect.objectContaining({
      id: "artist-quota",
      axis: "artist",
      operator: "maximum",
      values: ["4"],
    })]);
    expect(isQueryPlanV3(query)).toBe(true);

    for (const constraint of [
      {
        id: "injected-geography",
        axis: "geography" as const,
        operator: "require" as const,
        values: ["Rio de Janeiro"],
        kind: "hard" as const,
        relaxationRank: null,
      },
      {
        id: "injected-version",
        axis: "recording_version" as const,
        operator: "require" as const,
        values: ["live"],
        kind: "hard" as const,
        relaxationRank: null,
      },
      {
        id: "invalid-quota",
        axis: "artist" as const,
        operator: "maximum" as const,
        values: ["0"],
        kind: "hard" as const,
        relaxationRank: null,
      },
    ]) {
      expect(isQueryPlanV3({ ...query, hardConstraints: [...query.hardConstraints, constraint] })).toBe(false);
    }
  });

  test("persists only bounded public provider-attested scout leads", () => {
    const hints = [
      {
        url: "https://example.org/disco-history#source",
        title: "  Disco   history  ",
        excerpt: "  A provider-returned discovery lead.  ",
      },
      {
        url: "https://example.org/disco-history",
        title: "Duplicate",
        excerpt: "Duplicate normalized URL.",
      },
      { url: "https://127.0.0.1/private", title: "Private", excerpt: "Invalid." },
      ...Array.from({ length: 20 }, (_, index) => ({
        url: `https://sources.example.org/${index}`,
        title: `Source ${index}`,
        excerpt: "Provider-returned scout context.",
      })),
    ];
    const spec = createRunSpecV3({
      prompt: "25 disco songs",
      requestedTrackCount: 25,
      guidanceSourceHints: hints,
    });
    expect(spec.sourceDiscoveryHints).toHaveLength(12);
    expect(spec.sourceDiscoveryHints[0]).toEqual({
      url: "https://example.org/disco-history",
      title: "Disco history",
      excerpt: "A provider-returned discovery lead.",
      attestation: "guidance_scout_provider_response",
    });
    const query = createQueryPlanV3(resolveRunSpecV3(spec, []), "00000000-0000-4000-8000-000000000001");
    expect(query.sourceDiscoveryHints).toEqual(spec.sourceDiscoveryHints);
    expect(isQueryPlanV3(query)).toBe(true);
    expect(isQueryPlanV3({
      ...query,
      sourceDiscoveryHints: [{
        ...query.sourceDiscoveryHints[0],
        url: "https://localhost/private",
      }],
    })).toBe(false);
  });

  test("routes composite curated requests to each relevant engine", () => {
    const plan = confirmed("Dark house music like Moodymann but excluding Moodymann for sleep");
    expect(queryPlanV3Engines(plan)).toEqual([
      "similarity",
      "mood_activity_theme",
      "curated_genre_scene",
    ]);
  });

  test("persists similarity seeds for worker rehydration while accepting legacy objectives without values", () => {
    const query = createQueryPlanV3(
      confirmed("100 songs like Radiohead but do not include Radiohead", 100),
      "00000000-0000-4000-8000-000000000001",
    );
    expect(query.rankingObjectives).toContainEqual(expect.objectContaining({
      kind: "similarity",
      values: ["radiohead"],
    }));
    expect(isQueryPlanV3(query)).toBe(true);

    const legacy = {
      ...query,
      rankingObjectives: query.rankingObjectives.map((objective) => {
        const legacyObjective = { ...objective };
        delete legacyObjective.values;
        return legacyObjective;
      }),
    };
    expect(isQueryPlanV3(legacy)).toBe(true);
    expect(isQueryPlanV3({
      ...query,
      rankingObjectives: query.rankingObjectives.map((objective) => ({ ...objective, values: [""] })),
    })).toBe(false);
  });

  test("binds a continuation to the exact source plan, outcome, and approved strategies", () => {
    const base = createQueryPlanV3(
      confirmed("50 influential disco tracks", 50),
      "00000000-0000-4000-8000-000000000001",
    );
    const continuation = {
      ...base,
      continuation: {
        sourceQueryPlanRevisionId: "11111111-1111-4111-8111-111111111111",
        sourceQueryPlanHash: queryPlanV3Hash(base),
        sourceStageKey: `v3-retrieval:active:${queryPlanV3Hash(base).slice(0, 48)}`,
        sourceOutcomeHash: "b".repeat(64),
        sourceOutcomeVersion: 2,
        strategyIds: ["curated_genre_scene:qualified_artist_release_expansion"],
      },
    };
    expect(isQueryPlanV3(continuation)).toBe(true);
    expect(queryPlanV3Hash(continuation)).not.toBe(queryPlanV3Hash(base));
    expect(isQueryPlanV3({
      ...continuation,
      continuation: {
        ...continuation.continuation,
        strategyIds: ["duplicate", "duplicate"],
      },
    })).toBe(false);
  });

  test("binds a reviewed cold corpus to a direct successor graph snapshot", () => {
    const base = createQueryPlanV3(
      confirmed("Paulinho da Costa's released performance credits", 50),
      "00000000-0000-4000-8000-000000000001",
    );
    const reviewed = {
      ...base,
      graphSnapshotId: "00000000-0000-4000-8000-000000000002",
      corpusReview: {
        sourceQueryPlanRevisionId: "11111111-1111-4111-8111-111111111111",
        sourceQueryPlanHash: queryPlanV3Hash(base),
        sourceStageKey: `v3-retrieval:active:${queryPlanV3Hash(base).slice(0, 48)}`,
        sourceCheckpointHash: "c".repeat(64),
        reviewedGraphSnapshotId: "00000000-0000-4000-8000-000000000002",
        enumerationComplete: true,
        reviewedAt: "2026-07-20T12:00:00.000Z",
      },
    };
    expect(isQueryPlanV3(reviewed)).toBe(true);
    expect(isQueryPlanV3({
      ...reviewed,
      corpusReview: {
        ...reviewed.corpusReview,
        reviewedGraphSnapshotId: "00000000-0000-4000-8000-000000000003",
      },
    })).toBe(false);
  });

  test("blocks assignment when the master gate is off", () => {
    const plan = confirmed("Brazilian disco songs");
    expect(assignPipelineV3({
      plan,
      owner: true,
      stickyKey: "owner",
      env: { NODE_ENV: "test", PIPELINE_V3_ASSIGNMENT_ENABLED: "false", PIPELINE_V3_OWNER_CANARY: "true" },
    })).toMatchObject({ assigned: false, reason: "master_disabled" });
  });

  test("owner canaries require both the master gate and resolved guidance", () => {
    const unresolved = resolveRunSpecV3(
      createRunSpecV3({ prompt: "French jazz", requestedTrackCount: 25 }),
      [],
    );
    expect(assignPipelineV3({
      plan: unresolved,
      owner: true,
      stickyKey: "owner",
      env: { NODE_ENV: "test", PIPELINE_V3_ASSIGNMENT_ENABLED: "true", PIPELINE_V3_OWNER_CANARY: "true" },
    })).toMatchObject({ assigned: false, reason: "guidance_required" });

    const resolved = confirmed("French jazz", 25);
    expect(assignPipelineV3({
      plan: resolved,
      owner: true,
      stickyKey: "owner",
      env: { NODE_ENV: "test", PIPELINE_V3_ASSIGNMENT_ENABLED: "true", PIPELINE_V3_OWNER_CANARY: "true" },
    })).toMatchObject({ assigned: true, reason: "owner_canary" });
  });

  test("owner canaries are restricted by engine and count tier", () => {
    const env = {
      PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
      PIPELINE_V3_OWNER_CANARY: "true",
      PIPELINE_V3_OWNER_CANARY_GROUPS: "genre_scene",
      PIPELINE_V3_OWNER_CANARY_MAX_TRACKS: "50",
    };
    expect(assignPipelineV3({
      plan: confirmed("Brazilian disco songs", 50),
      owner: true,
      stickyKey: "owner",
      env,
    })).toMatchObject({ assigned: true, reason: "owner_canary", group: "genre_scene" });
    expect(assignPipelineV3({
      plan: confirmed("Brazilian disco songs", 100),
      owner: true,
      stickyKey: "owner",
      env,
    })).toMatchObject({ assigned: false, reason: "production_evidence_required", group: "genre_scene" });
    expect(assignPipelineV3({
      plan: confirmed("Paulinho da Costa's released performance credits", 25),
      owner: true,
      stickyKey: "owner",
      env,
    })).toMatchObject({ assigned: false, reason: "production_evidence_required", group: "factual_relationship" });
  });

  test("public rollout requires adjudicated production evidence and a separate factual feasibility gate", () => {
    const base = {
      PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
      PIPELINE_V3_GENRE_SCENE_PERCENT: "100",
      PIPELINE_V3_FACTUAL_PERCENT: "100",
    };
    expect(assignPipelineV3({
      plan: confirmed("Brazilian disco songs", 50),
      owner: false,
      stickyKey: "visitor",
      env: base,
    })).toMatchObject({ assigned: false, reason: "production_evidence_required" });
    expect(assignPipelineV3({
      plan: confirmed("Brazilian disco songs", 50),
      owner: false,
      stickyKey: "visitor",
      env: { ...base, PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED: "true" },
    })).toMatchObject({ assigned: false, reason: "governed_geographic_evidence_required" });
    expect(assignPipelineV3({
      plan: confirmed("Brazilian disco songs", 50),
      owner: false,
      stickyKey: "visitor",
      env: {
        ...base,
        PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED: "true",
        PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED: "true",
      },
    })).toMatchObject({ assigned: true, reason: "sticky_rollout" });
    expect(assignPipelineV3({
      plan: confirmed("Paulinho da Costa's released performance credits", 25),
      owner: false,
      stickyKey: "visitor",
      env: { ...base, PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED: "true" },
    })).toMatchObject({ assigned: false, reason: "factual_feasibility_required" });
    expect(assignPipelineV3({
      plan: confirmed("Paulinho da Costa's released performance credits", 25),
      owner: false,
      stickyKey: "visitor",
      env: {
        ...base,
        PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED: "true",
        PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED: "true",
      },
    })).toMatchObject({ assigned: true, reason: "sticky_rollout" });
  });
});
