import { describe, expect, test } from "vitest";
import {
  assignPipelineV3,
  createQueryPlanV3,
  isQueryPlanV3,
  queryPlanV3Engines,
  queryPlanV3Hash,
} from "../server/query-plan-v3.ts";
import { createRunSpecV3, resolveRunSpecV3 } from "../server/selection-plan-v3.ts";

function confirmed(prompt: string, target = 50) {
  const spec = createRunSpecV3({ prompt, requestedTrackCount: target, storefront: "us" });
  const answers = spec.criticalAmbiguities.map((ambiguity) => {
    if (ambiguity.key === "house_semantics") return { key: ambiguity.key, optionId: "house_genre" as const };
    if (ambiguity.key === "french_jazz_scope") return { key: ambiguity.key, optionId: "french_scene" as const };
    if (ambiguity.key === "possessive_relationship") return { key: ambiguity.key, optionId: "subject_performed" as const };
    return { key: ambiguity.key, optionId: "funk_carioca" as const };
  });
  return resolveRunSpecV3(spec, answers);
}

describe("query plan V3", () => {
  test("preserves the exact 1-300 target and separates ranking from hard membership", () => {
    const plan = confirmed("Paulinho da Costa's 176 most influential songs", 176);
    const query = createQueryPlanV3(plan, "00000000-0000-4000-8000-000000000001");
    expect(query.targetTrackCount).toBe(176);
    expect(query.engine).toBe("factual_relationship");
    expect(query.membershipPredicates.some(({ kind }) => kind === "factual_relationship")).toBe(true);
    expect(query.membershipPredicates.some(({ kind }) => kind === "influence")).toBe(false);
    expect(query.rankingObjectives.some(({ kind }) => kind === "influence")).toBe(true);
    expect(isQueryPlanV3(query)).toBe(true);
    expect(queryPlanV3Hash(query)).toMatch(/^[a-f0-9]{64}$/u);
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
