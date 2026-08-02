import { describe, expect, test } from "vitest";
import type { PlaylistBrief, QueryPlanV3 } from "../shared/types.ts";
import {
  persistedWorkerPipeline,
  WorkerPipelineIntegrityError,
} from "../server/pipeline-worker-routing.ts";
import { ResearchOrchestrator } from "../server/research.ts";
import { assignPipelineV2, createSelectionPlanV2 } from "../server/selection-plan-v2.ts";
import { createMatchingRepositoryFacade } from "../server/worker-facades.ts";

function curatedBrief(): PlaylistBrief {
  return {
    title: "House music essentials",
    description: "A broad source-backed survey of the house music genre.",
    mode: "curated",
    subjectEntities: ["House music"],
    relationship: "is a recording in the house music genre",
    include: ["Recordings musically classified as house music."],
    exclude: ["Songs merely about physical houses."],
    versionPolicy: "Prefer one canonical studio recording.",
    evidencePolicy: "Require track-scope editorial evidence.",
    orderingPolicy: "Intermix artists and albums.",
    targetSize: { min: 25, max: 25 },
    ambiguities: [],
  };
}

function planFor(brief = curatedBrief()) {
  return createSelectionPlanV2({
    prompt: "25 essential house music tracks",
    brief,
    storefront: "us",
  });
}

function queryPlanV3(): QueryPlanV3 {
  return {
    schemaVersion: 1,
    pipelineVersion: "corpus_first_v3",
    policyVersion: "corpus_first_v3_policy_v1",
    engine: "curated_genre_scene",
    engines: ["curated_genre_scene"],
    graphSnapshotId: "snapshot-1",
    selectionPlanHash: "a".repeat(64),
    membershipPredicates: [{
      id: "genre-house",
      kind: "genre",
      subject: "recording",
      relationship: "classified_as_house_music",
      hard: true,
    }],
    rankingObjectives: [{
      id: "influence",
      kind: "editorial_rank",
      description: "Prefer historically consequential recordings.",
      weight: 1,
    }],
    targetTrackCount: 25,
    storefront: "us",
    hardConstraints: [],
    softPreferences: [],
    sourceDiscoveryHints: [],
  };
}

function enqueueHarness(run: Record<string, unknown>) {
  const jobs: Array<Record<string, unknown>> = [];
  const repository = {
    async getRun() { return structuredClone(run); },
    async getResearchCheckpoint() { return null; },
    async enqueueJob(input: Record<string, unknown>) { jobs.push(structuredClone(input)); return input; },
  };
  return { orchestrator: new ResearchOrchestrator(repository as never), jobs };
}

describe("persisted worker pipeline routing", () => {
  test("routes a persisted curated V2 run through the fast V2 handoff even without a prior route checkpoint", async () => {
    const brief = curatedBrief();
    const selectionPlan = planFor(brief);
    const state = enqueueHarness({
      id: "v2-curated",
      brief,
      pipelineVersion: "catalog_first_v2",
      policyVersion: selectionPlan.policyVersion,
      selectionPlan,
      status: "queued",
      phase: "queued",
      actualCostUsd: 0,
      approvedBudgetUsd: 1,
    });

    await state.orchestrator.enqueue("v2-curated");

    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toMatchObject({
      kind: "research",
      runId: "v2-curated",
      payload: expect.objectContaining({ fast: true, phase: "scope_resolution" }),
    });
  });

  test("rollback stays on V1 from the persisted version even when a stale V2 plan is attached", async () => {
    const brief = curatedBrief();
    const selectionPlan = planFor(brief);
    const decision = persistedWorkerPipeline({
      pipelineVersion: "legacy_v1",
      policyVersion: "legacy_v1",
      selectionPlan,
    });
    expect(decision).toMatchObject({ route: "legacy_v1", selectionPlan: null });

    const state = enqueueHarness({
      id: "legacy-control",
      brief,
      pipelineVersion: "legacy_v1",
      policyVersion: "legacy_v1",
      selectionPlan,
      status: "queued",
      phase: "queued",
      actualCostUsd: 0,
      approvedBudgetUsd: 1,
    });
    await state.orchestrator.enqueue("legacy-control");
    expect((state.jobs[0]?.payload as Record<string, unknown>)).not.toHaveProperty("fast");

    const source = {
      async getRun() {
        return {
          brief,
          status: "ready_for_matching",
          pipelineVersion: "legacy_v1" as const,
          policyVersion: "legacy_v1" as const,
          selectionPlan,
        };
      },
    } as never;
    const matchingRun = await createMatchingRepositoryFacade(source).getRun("legacy-control");
    expect(matchingRun).toMatchObject({
      pipelineVersion: "legacy_v1",
      policyVersion: "legacy_v1",
      selectionPlan: null,
    });
  });

  test("matching facade exposes the persisted V2 plan to the catalog controller", async () => {
    const brief = curatedBrief();
    const selectionPlan = planFor(brief);
    const source = {
      async getRun() {
        return {
          brief,
          status: "ready_for_matching",
          pipelineVersion: "catalog_first_v2" as const,
          policyVersion: selectionPlan.policyVersion,
          selectionPlan,
        };
      },
    } as never;
    const matchingRun = await createMatchingRepositoryFacade(source).getRun("v2-curated");
    expect(matchingRun).toMatchObject({
      pipelineVersion: "catalog_first_v2",
      policyVersion: selectionPlan.policyVersion,
      selectionPlan,
    });
  });

  test("routes factual V2 through the distinct durable claim-first frontier", () => {
    const factualBrief: PlaylistBrief = {
      ...curatedBrief(),
      title: "Paulinho da Costa credits",
      mode: "exhaustive",
      subjectEntities: ["Paulinho da Costa"],
      relationship: "performed percussion on the released recording",
      targetSize: null,
    };
    const selectionPlan = createSelectionPlanV2({
      prompt: "Every released song Paulinho da Costa performed on",
      brief: factualBrief,
      storefront: "us",
    });

    expect(persistedWorkerPipeline({
      pipelineVersion: "catalog_first_v2",
      policyVersion: selectionPlan.policyVersion,
      selectionPlan,
    })).toMatchObject({
      route: "catalog_first_v2_factual",
      pipelineVersion: "catalog_first_v2",
      selectionPlan,
    });
  });

  test("routes only a persisted, version-matched V3 query plan to the V3 worker", () => {
    const queryPlan = queryPlanV3();
    expect(persistedWorkerPipeline({
      pipelineVersion: "corpus_first_v3",
      policyVersion: "corpus_first_v3_policy_v1",
      queryPlan,
    })).toEqual({
      route: "corpus_first_v3",
      pipelineVersion: "corpus_first_v3",
      policyVersion: "corpus_first_v3_policy_v1",
      selectionPlan: null,
      queryPlan,
    });
  });

  test("rejects V3 rows without the immutable V3 query plan", () => {
    expect(() => persistedWorkerPipeline({
      pipelineVersion: "corpus_first_v3",
      policyVersion: "corpus_first_v3_policy_v1",
      queryPlan: null,
    })).toThrowError(expect.objectContaining<Partial<WorkerPipelineIntegrityError>>({
      code: "missing_v3_query_plan",
    }));

    expect(() => persistedWorkerPipeline({
      pipelineVersion: "corpus_first_v3",
      policyVersion: "relevance_first_2026_07_r2",
      queryPlan: queryPlanV3(),
    })).toThrowError(expect.objectContaining<Partial<WorkerPipelineIntegrityError>>({
      code: "v3_policy_version_mismatch",
    }));
  });

  test("enqueues factual V2 as durable deep research and never as fast curated work", async () => {
    const factualBrief: PlaylistBrief = {
      ...curatedBrief(),
      title: "Paulinho da Costa credits",
      mode: "exhaustive",
      subjectEntities: ["Paulinho da Costa"],
      relationship: "performed percussion on the released recording",
      targetSize: null,
    };
    const selectionPlan = createSelectionPlanV2({
      prompt: "Every released song Paulinho da Costa performed on",
      brief: factualBrief,
      storefront: "us",
    });
    const state = enqueueHarness({
      id: "v2-factual",
      brief: factualBrief,
      pipelineVersion: "catalog_first_v2",
      policyVersion: selectionPlan.policyVersion,
      selectionPlan,
      status: "queued",
      phase: "queued",
      actualCostUsd: 0,
      approvedBudgetUsd: 5,
    });

    await state.orchestrator.enqueue("v2-factual");

    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toMatchObject({
      kind: "research",
      runId: "v2-factual",
      payload: expect.objectContaining({ phase: "scope_resolution" }),
    });
    expect(state.jobs[0]?.payload).not.toHaveProperty("fast");
  });

  test("factual rollout ignores the obsolete gate and uses the independent owner canary", async () => {
    const factualBrief: PlaylistBrief = {
      ...curatedBrief(),
      title: "Paulinho da Costa credits",
      mode: "exhaustive",
      subjectEntities: ["Paulinho da Costa"],
      relationship: "performed percussion on the released recording",
      targetSize: null,
    };
    const proposedPlan = createSelectionPlanV2({
      prompt: "Every released song Paulinho da Costa performed on",
      brief: factualBrief,
      storefront: "us",
    });
    const assignment = assignPipelineV2({
      plan: proposedPlan,
      signedOwnerCanary: false,
      stickyKey: "owner:factual",
      env: { PIPELINE_V2_FACTUAL_CANARY: "1", PIPELINE_V2_CURATED_PERCENT: "100" },
    });
    expect(assignment).toMatchObject({ assigned: false, reason: "legacy_control" });

    const state = enqueueHarness({
      id: "factual-legacy-control",
      brief: factualBrief,
      pipelineVersion: "legacy_v1",
      policyVersion: "legacy_v1",
      selectionPlan: assignment.assigned ? proposedPlan : null,
      status: "queued",
      phase: "queued",
      actualCostUsd: 0,
      approvedBudgetUsd: 5,
    });
    await expect(state.orchestrator.enqueue("factual-legacy-control")).resolves.toBeUndefined();
    expect(state.jobs).toHaveLength(1);
    expect((state.jobs[0]?.payload as Record<string, unknown>)).not.toHaveProperty("fast");

    const factualCanary = assignPipelineV2({
      plan: proposedPlan,
      signedOwnerCanary: true,
      stickyKey: "owner:factual",
      env: { PIPELINE_V2_FACTUAL_OWNER_CANARY: "true" },
    });
    expect(factualCanary).toMatchObject({ assigned: true, reason: "owner_canary" });
  });

  test("rejects a V2 row whose immutable policy no longer matches its plan", () => {
    const selectionPlan = planFor();
    expect(() => persistedWorkerPipeline({
      pipelineVersion: "catalog_first_v2",
      policyVersion: "catalog_first_v2_policy_v1",
      selectionPlan,
    })).toThrowError(expect.objectContaining<Partial<WorkerPipelineIntegrityError>>({
      code: "v2_policy_version_mismatch",
    }));
  });
});
