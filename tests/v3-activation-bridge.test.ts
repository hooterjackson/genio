import { describe, expect, test, vi } from "vitest";
import { Repository } from "../server/repository.ts";
import {
  createPipelineV3ActivationContract,
  pipelineV3ActivationPreconditionFailure,
} from "../server/v3-activation-bridge.ts";
import {
  createRunSpecV3,
  resolveRunSpecV3,
  selectionPlanV3Hash,
} from "../server/selection-plan-v3.ts";
import { sha256Hex, stableStringify } from "../server/security.ts";

const runId = "00000000-0000-4000-8000-000000000010";
const snapshotId = "00000000-0000-4000-8000-000000000020";

function confirmedPlan(target = 150) {
  return resolveRunSpecV3(createRunSpecV3({
    prompt: "Brazilian disco songs",
    requestedTrackCount: target,
    storefront: "us",
  }), []);
}

interface MockState {
  schema?: string;
  runStatus?: string;
  snapshotStatus?: string | null;
  leased?: boolean;
  selectionPlan?: unknown;
  active?: Record<string, unknown> | null;
  latest?: { id: string; revision: number } | null;
  duplicate?: { id: string } | null;
  requestedTrackCount?: number;
}

function repositoryMock(state: MockState = {}) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (text.includes("key='schema_version'")) {
        return { rows: [{ value: state.schema ?? "14" }], rowCount: 1 };
      }
      if (text.includes("FROM research_runs r") && text.includes("LEFT JOIN run_specs")) {
        const requestedTrackCount = state.requestedTrackCount ?? 150;
        const rawPrompt = "Brazilian disco songs";
        const storefront = "us";
        const guidanceAnswers: unknown[] = [];
        const guidanceSourceHints: unknown[] = [];
        const pipelineVersion = "corpus_first_v3";
        const policyVersion = "corpus_first_v3_policy_v1";
        return { rows: [{
          status: state.runStatus ?? "queued",
          phase: "queued",
          deleted_at: null,
          selection_plan_json: state.selectionPlan ?? null,
          raw_prompt: rawPrompt,
          requested_track_count: requestedTrackCount,
          storefront,
          guidance_answers_json: guidanceAnswers,
          guidance_source_hints_json: guidanceSourceHints,
          spec_hash: sha256Hex(stableStringify({
            rawPrompt,
            requestedTrackCount,
            storefront,
            guidanceAnswers,
            guidanceSourceHints,
            pipelineVersion,
            policyVersion,
          })),
          spec_pipeline_version: pipelineVersion,
          spec_policy_version: policyVersion,
        }], rowCount: 1 };
      }
      if (text.includes("FROM graph_snapshots WHERE id=$1")) {
        return { rows: state.snapshotStatus === null ? [] : [{ status: state.snapshotStatus ?? "locked" }], rowCount: 1 };
      }
      if (text.includes("FROM job_queue") && text.includes("status='leased'")) {
        return { rows: state.leased ? [{ exists: 1 }] : [], rowCount: state.leased ? 1 : 0 };
      }
      if (text.includes("FROM run_active_query_plans")) {
        return { rows: state.active ? [state.active] : [], rowCount: state.active ? 1 : 0 };
      }
      if (text.includes("ORDER BY revision DESC")) {
        return { rows: state.latest ? [state.latest] : [], rowCount: state.latest ? 1 : 0 };
      }
      if (text.includes("plan_hash=$2")) {
        return { rows: state.duplicate ? [state.duplicate] : [], rowCount: state.duplicate ? 1 : 0 };
      }
      if (text.includes("RETURNING selection_plan_json")) {
        return { rows: [{ selection_plan_json: state.selectionPlan ?? null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client), end: vi.fn() };
  return { repository: new Repository({ pool, db: {} } as never), client, calls };
}

describe("Pipeline V3 explicit activation bridge", () => {
  test("accepts only schema 14, pre-research run states, and locked snapshots", () => {
    expect(pipelineV3ActivationPreconditionFailure({
      schemaVersion: 14, runStatus: "queued", deleted: false, snapshotStatus: "locked",
    })).toBeNull();
    expect(pipelineV3ActivationPreconditionFailure({
      schemaVersion: 14, runStatus: "awaiting_guidance", deleted: false, snapshotStatus: "locked",
    })).toBeNull();
    expect(pipelineV3ActivationPreconditionFailure({
      schemaVersion: 13, runStatus: "queued", deleted: false, snapshotStatus: "locked",
    })).toBe("schema_unavailable");
    expect(pipelineV3ActivationPreconditionFailure({
      schemaVersion: 14, runStatus: "researching", deleted: false, snapshotStatus: "locked",
    })).toBe("run_in_flight");
    expect(pipelineV3ActivationPreconditionFailure({
      schemaVersion: 14, runStatus: "queued", deleted: false, snapshotStatus: "building",
    })).toBe("snapshot_not_locked");
  });

  test("builds the immutable query plan through the canonical V3 factory", () => {
    const contract = createPipelineV3ActivationContract(confirmedPlan(176), snapshotId);
    expect(contract.queryPlan).toMatchObject({
      pipelineVersion: "corpus_first_v3",
      policyVersion: "corpus_first_v3_policy_v1",
      graphSnapshotId: snapshotId,
      targetTrackCount: 176,
    });
    expect(contract.planHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("creates and activates revision one without rewriting the legacy selection plan", async () => {
    const legacySelectionPlan = { pipelineVersion: "catalog_first_v2", immutable: true };
    const { repository, calls } = repositoryMock({ selectionPlan: legacySelectionPlan });
    const result = await repository.activatePipelineV3Run({
      runId,
      selectionPlan: confirmedPlan(150),
      graphSnapshotId: snapshotId,
    });

    expect(result).toMatchObject({ runId, revision: 1, idempotent: false });
    expect(result.queryPlan.targetTrackCount).toBe(150);
    const insert = calls.find(({ text }) => text.includes("INSERT INTO query_plan_revisions"));
    expect(insert?.values[3]).toBe(1);
    expect(insert?.values[4]).toBeNull();
    expect(insert?.values[5]).toBe(snapshotId);
    expect(calls.some(({ text }) => text.includes("INSERT INTO run_active_query_plans"))).toBe(true);
    const runUpdate = calls.find(({ text }) => text.includes("UPDATE research_runs SET pipeline_version='corpus_first_v3'")
      && text.includes("RETURNING selection_plan_json"));
    expect(runUpdate?.text).not.toContain("selection_plan_json=");
    expect(calls.at(-2)?.text).toContain("UPDATE research_runs");
    expect(calls.at(-1)?.text).toBe("COMMIT");
  });

  test("creates the next immutable revision and supersedes the prior active revision", async () => {
    const { repository, calls } = repositoryMock({
      requestedTrackCount: 50,
      active: {
        id: "00000000-0000-4000-8000-000000000030",
        revision: 2,
        graph_snapshot_id: "00000000-0000-4000-8000-000000000031",
        status: "active",
        plan_hash: "a".repeat(64),
        plan_json: {},
      },
      latest: { id: "00000000-0000-4000-8000-000000000030", revision: 2 },
    });
    const result = await repository.activatePipelineV3Run({
      runId,
      selectionPlan: confirmedPlan(50),
      graphSnapshotId: snapshotId,
    });
    expect(result.revision).toBe(3);
    const insert = calls.find(({ text }) => text.includes("INSERT INTO query_plan_revisions"));
    expect(insert?.values[3]).toBe(3);
    expect(insert?.values[4]).toBe("00000000-0000-4000-8000-000000000030");
    expect(calls.some(({ text }) => text.includes("status='superseded'"))).toBe(true);
  });

  test.each([
    [{ schema: "13" }, "v3_schema_unavailable"],
    [{ runStatus: "researching" }, "v3_activation_run_in_flight"],
    [{ snapshotStatus: "building" }, "v3_snapshot_not_locked"],
    [{ snapshotStatus: null }, "v3_snapshot_not_locked"],
    [{ leased: true }, "v3_activation_run_in_flight"],
  ] satisfies Array<[MockState, string]>)
  ("fails closed before inserting a revision when activation preconditions fail: %s", async (state, code) => {
    const { repository, calls } = repositoryMock(state);
    await expect(repository.activatePipelineV3Run({
      runId,
      selectionPlan: confirmedPlan(),
      graphSnapshotId: snapshotId,
    })).rejects.toMatchObject({ code });
    expect(calls.some(({ text }) => text.includes("INSERT INTO query_plan_revisions"))).toBe(false);
    expect(calls.at(-1)?.text).toBe("ROLLBACK");
  });

  test("replays an already-active identical plan idempotently", async () => {
    const contract = createPipelineV3ActivationContract(confirmedPlan(100), snapshotId);
    const revisionId = "00000000-0000-4000-8000-000000000040";
    const { repository, calls } = repositoryMock({
      requestedTrackCount: 100,
      active: {
        id: revisionId,
        revision: 4,
        graph_snapshot_id: snapshotId,
        status: "active",
        plan_hash: contract.planHash,
        plan_json: contract.queryPlan,
        selection_plan_hash: selectionPlanV3Hash(confirmedPlan(100)),
      },
    });
    await expect(repository.activatePipelineV3Run({
      runId,
      selectionPlan: confirmedPlan(100),
      graphSnapshotId: snapshotId,
    })).resolves.toMatchObject({ queryPlanRevisionId: revisionId, revision: 4, idempotent: true });
    expect(calls.some(({ text }) => text.includes("INSERT INTO query_plan_revisions"))).toBe(false);
  });
});
