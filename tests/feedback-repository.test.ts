import { expect, test, vi } from "vitest";
import { Repository } from "../server/repository.ts";
import { feedbackPayloadHash, parseFeedbackSubmission } from "../server/feedback.ts";

const submission = parseFeedbackSubmission({
  kind: "improvement",
  message: "Please make the job history easier to scan.",
  pagePath: "/jobs",
});

function repositoryWithQuery(query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }>) {
  const client = { query: vi.fn(query), release: vi.fn() };
  const pool = { connect: vi.fn(async () => client), end: vi.fn() };
  return { repository: new Repository({ pool, db: {} } as never), client };
}

test("feedback creation atomically writes the report, alias-aware idempotency mappings, and both limits", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const { repository } = repositoryWithQuery(async (text, values = []) => {
    calls.push({ text, values });
    if (text.includes("SELECT value FROM settings WHERE key=ANY")) return { rows: [] };
    if (text.includes("count(*) FILTER")) return { rows: [{ hourly: 0, daily: 0 }] };
    return { rows: [] };
  });
  const result = await repository.createFeedbackSubmission({
    submission,
    idempotencyKey: "feedback-submit-0001",
    clientBucket: "today.bucket",
    clientBucketAliases: ["today.bucket", "yesterday.bucket"],
  });
  expect(result.created).toBe(true);
  expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
  const reportInsert = calls.find((call) => call.text.includes("INSERT INTO settings(key,value) VALUES($1,$2)")
    && String(call.values[0]).startsWith("feedback-submission:"));
  expect(reportInsert?.values[0]).toBe(`feedback-submission:${result.id}`);
  expect(JSON.parse(String(reportInsert?.values[1]))).toMatchObject({
    id: result.id,
    kind: "improvement",
    status: "new",
    message: submission.message,
  });
  const mappingInserts = calls.filter((call) => call.text.includes("ON CONFLICT(key) DO UPDATE"));
  expect(mappingInserts).toHaveLength(2);
  expect(mappingInserts.every((call) => String(call.values[0]).startsWith("feedback-idempotency:"))).toBe(true);
  expect(calls.some((call) => call.text.includes("'feedback_hour'"))).toBe(true);
});

test("an idempotent feedback retry returns the stored ID without consuming another limit", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const calls: string[] = [];
  const { repository } = repositoryWithQuery(async (text) => {
    calls.push(text);
    if (text.includes("SELECT value FROM settings WHERE key=ANY")) {
      return { rows: [{ value: JSON.stringify({ id, payloadHash: feedbackPayloadHash(submission) }) }] };
    }
    if (text.includes("SELECT 1 FROM settings")) return { rows: [{ exists: 1 }] };
    return { rows: [] };
  });
  await expect(repository.createFeedbackSubmission({
    submission,
    idempotencyKey: "feedback-submit-0001",
    clientBucket: "today.bucket",
    clientBucketAliases: ["today.bucket"],
  })).resolves.toEqual({ id, created: false });
  expect(calls.some((text) => text.includes("count(*) FILTER"))).toBe(false);
  expect(calls.some((text) => text.includes("INSERT INTO rate_limit_events"))).toBe(false);
});

test("feedback rate limits are enforced before any report is stored", async () => {
  const calls: string[] = [];
  const { repository } = repositoryWithQuery(async (text) => {
    calls.push(text);
    if (text.includes("SELECT value FROM settings WHERE key=ANY")) return { rows: [] };
    if (text.includes("count(*) FILTER")) return { rows: [{ hourly: 2, daily: 2 }] };
    return { rows: [] };
  });
  await expect(repository.createFeedbackSubmission({
    submission,
    idempotencyKey: "feedback-submit-0002",
    clientBucket: "today.bucket",
    clientBucketAliases: ["today.bucket"],
  })).rejects.toMatchObject({ statusCode: 429, code: "feedback_rate_limited" });
  expect(calls.some((text) => text.includes("feedback-submission:"))).toBe(false);
});

test("feedback obeys the owner pause and application-wide daily ceiling", async () => {
  const paused = repositoryWithQuery(async (text) => {
    if (text.includes("feedback_paused")) return { rows: [{ paused: true }] };
    return { rows: [] };
  }).repository;
  await expect(paused.createFeedbackSubmission({
    submission,
    idempotencyKey: "feedback-submit-paused",
    clientBucket: "today.bucket",
    clientBucketAliases: ["today.bucket"],
  })).rejects.toMatchObject({ statusCode: 503, code: "feedback_paused" });

  const atCapacity = repositoryWithQuery(async (text) => {
    if (text.includes("feedback_paused")) return { rows: [{ paused: false }] };
    if (text.includes("SELECT value FROM settings WHERE key=ANY")) return { rows: [] };
    if (text.includes("count(*) FILTER") && text.includes("feedback_hour")) return { rows: [{ hourly: 0, daily: 0 }] };
    if (text.includes("stored_bytes")) return { rows: [{ daily: 100, stored_bytes: "0" }] };
    return { rows: [] };
  }).repository;
  await expect(atCapacity.createFeedbackSubmission({
    submission,
    idempotencyKey: "feedback-submit-global-limit",
    clientBucket: "another.bucket",
    clientBucketAliases: ["another.bucket"],
  })).rejects.toMatchObject({ statusCode: 503, code: "feedback_global_limit" });
});
