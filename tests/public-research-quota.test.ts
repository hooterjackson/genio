import { expect, test, vi } from "vitest";
import { Repository } from "../server/repository.ts";
import type { PlaylistBrief } from "../shared/types.ts";

const brief: PlaylistBrief = {
  title: "Unlimited public research",
  description: "A deterministic public research request used to verify quota-free admission.",
  mode: "exhaustive",
  subjectEntities: ["Test Artist"],
  relationship: "primary artist",
  include: ["officially released recordings"],
  exclude: ["unreleased recordings"],
  versionPolicy: "one canonical studio recording",
  evidencePolicy: "verified or corroborated",
  orderingPolicy: "chronological",
  targetSize: null,
  ambiguities: [],
};

function quotaFreeRepository() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (text.includes("FROM run_accesses a JOIN research_runs")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("SELECT count(*)::int count FROM research_runs")) {
        return { rows: [{ count: 0 }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO research_runs")) {
        return { rows: [{ created_at: new Date("2026-07-17T00:00:00.000Z") }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    end: vi.fn(),
  };
  return {
    repository: new Repository({ pool, db: {} } as never),
    calls,
  };
}

test("public users can create repeated briefs and research runs without daily quota events", async () => {
  const { repository, calls } = quotaFreeRepository();
  const clientBucket = "public.repeat-user";

  for (let index = 0; index < 15; index += 1) {
    await expect(repository.createBriefRequest({
      prompt: `Repeated public brief ${index}`,
      model: "test-model",
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: `brief-${index}`,
    })).resolves.toMatchObject({ created: true, status: "queued" });
  }

  for (let index = 0; index < 8; index += 1) {
    await expect(repository.createRunIdempotent({
      prompt: `Repeated public run ${index}`,
      brief: { ...brief, title: `Unlimited public research ${index}` },
      estimateUsd: 0,
      approvedBudgetUsd: 1,
      clientBucket,
      clientBucketAliases: [clientBucket],
      idempotencyKey: `run-${index}`,
      reuseDays: 0,
      globalLimit: 10,
    })).resolves.toMatchObject({ created: true, status: "queued" });
  }

  expect(calls.some((call) => call.text.includes("rate_limit_events")
    && (call.text.includes("'brief'") || call.text.includes("'run'")))).toBe(false);
});
