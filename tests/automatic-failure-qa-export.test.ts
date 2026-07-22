import { describe, expect, test } from "vitest";
import {
  automaticFailureQaExportScenario,
  buildAutomaticFailureQaExport,
} from "../server/automatic-failure-qa-export.ts";
import type { FeedbackSubmissionRecord } from "../server/feedback.ts";

function automaticRecord(overrides: Partial<FeedbackSubmissionRecord> = {}): FeedbackSubmissionRecord {
  const capturedAt = "2026-07-22T12:00:00.000Z";
  return {
    id: "private-feedback-id",
    origin: "automatic_failure",
    kind: "bug",
    status: "new",
    message: "Automatic matching failure report.",
    pagePath: "/jobs",
    appVersion: "2.2.1+abcdef0",
    image: null,
    createdAt: capturedAt,
    updatedAt: capturedAt,
    automaticFailure: {
      schemaVersion: 1,
      failureClass: "matching_failure",
      eventFingerprint: "a".repeat(64),
      runId: "production-run-id",
      runAccessId: "production-access-id",
      briefRequestId: "production-brief-id",
      prompt: "Exact tricky visitor query",
      requestedTrackCount: 50,
      storefront: "us",
      status: "failed",
      phase: "catalog_matching",
      rootCause: "strict_match_shortfall",
      errorCode: "provider_error_with_sensitive_text",
      errorMessage: "Authorization: Bearer definitely-not-exported",
      terminalGeneration: "1784721600000",
      occurredAt: capturedAt,
      runtime: {
        appVersion: "2.2.1+abcdef0",
        buildRevision: "abcdef012345",
        workerProtocol: "playlist-pipeline-v8",
        authorizationToken: "must-not-export",
      },
      plan: {
        pipelineVersion: "v3",
        queryPlanRevision: 2,
        capabilitySecret: "must-not-export",
      },
      counters: { discovered: 44, accepted: 0 },
      details: {
        userToken: "must-not-export",
        providerPayload: { secret: "must-not-export" },
      },
    },
    qaScenario: {
      schemaVersion: 1,
      scenarioId: "automatic-failure-aaaaaaaaaaaaaaaaaaaaaaaa",
      source: "automatic_failure",
      status: "quarantined",
      capturedAt,
      request: { prompt: "Exact tricky visitor query", requestedTrackCount: 50, storefront: "us" },
      expected: { noTerminalFailure: true, requestedTrackCount: 50 },
      observed: {
        failureClass: "matching_failure",
        status: "failed",
        phase: "catalog_matching",
        errorCode: "matching_failed",
        counters: { discovered: 44, accepted: 0 },
      },
      replay: {
        appVersion: "2.2.1+abcdef0",
        workerProtocol: "playlist-pipeline-v8",
        authorizationToken: "must-not-export",
        "plan.pipelineVersion": "v3",
        "plan.capabilitySecret": "must-not-export",
      },
    },
    qaStatus: "quarantined",
    occurrenceCount: 2,
    firstSeenAt: capturedAt,
    lastSeenAt: "2026-07-22T12:05:00.000Z",
    ...overrides,
  };
}

describe("automatic failure QA export", () => {
  test("retains the exact regression request while omitting private diagnostics and production IDs", () => {
    const exported = automaticFailureQaExportScenario(automaticRecord());
    expect(exported).toMatchObject({
      id: "automatic-failure-aaaaaaaaaaaaaaaaaaaaaaaa",
      status: "quarantined",
      occurrenceCount: 2,
      request: { prompt: "Exact tricky visitor query", requestedTrackCount: 50, storefront: "us" },
      observed: { rootCause: "strict_match_shortfall", counters: { discovered: 44, accepted: 0 } },
      replay: {
        appVersion: "2.2.1+abcdef0",
        workerProtocol: "playlist-pipeline-v8",
        "plan.pipelineVersion": "v3",
        "plan.queryPlanRevision": 2,
      },
    });
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain("production-run-id");
    expect(serialized).not.toContain("production-brief-id");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("must-not-export");
    expect(serialized).not.toContain("userToken");
    expect(serialized).not.toContain("providerPayload");
  });

  test("exports quarantined automatic reports by default and excludes manual feedback", () => {
    const manual = { ...automaticRecord(), id: "manual", origin: "manual" as const };
    const promoted = automaticRecord({ id: "promoted", qaStatus: "promoted" });
    const result = buildAutomaticFailureQaExport(
      [promoted, manual, automaticRecord()],
      "quarantined",
      "2026-07-22T13:00:00.000Z",
    );
    expect(result).toMatchObject({
      schemaVersion: "genio-automatic-failure-qa-export/v1",
      generatedAt: "2026-07-22T13:00:00.000Z",
      scenarioCount: 1,
    });
    expect(result.scenarios[0]?.request.prompt).toBe("Exact tricky visitor query");
  });

  test("rejects malformed or promptless private records", () => {
    expect(automaticFailureQaExportScenario(automaticRecord({ qaScenario: null }))).toBeNull();
    const invalid = automaticRecord();
    invalid.qaScenario!.request.prompt = "";
    expect(automaticFailureQaExportScenario(invalid)).toBeNull();
  });

  test("isolates malformed nested historical records while exporting valid siblings", () => {
    const nullRequest = automaticRecord({ id: "null-request" });
    (nullRequest.qaScenario as unknown as Record<string, unknown>).request = null;

    const nonStringRequest = automaticRecord({ id: "non-string-request" });
    (nonStringRequest.qaScenario!.request as unknown as Record<string, unknown>).prompt = 123;

    const nullObserved = automaticRecord({ id: "null-observed" });
    (nullObserved.qaScenario as unknown as Record<string, unknown>).observed = null;

    const nullRuntime = automaticRecord({ id: "null-runtime" });
    (nullRuntime.automaticFailure as unknown as Record<string, unknown>).runtime = null;

    const nonObjectPlan = automaticRecord({ id: "non-object-plan" });
    (nonObjectPlan.automaticFailure as unknown as Record<string, unknown>).plan = "bad-plan";

    const result = buildAutomaticFailureQaExport([
      null,
      "not-a-record",
      nullRequest,
      nonStringRequest,
      nullObserved,
      nullRuntime,
      nonObjectPlan,
      automaticRecord(),
    ]);

    expect(result.scenarioCount).toBe(1);
    expect(result.scenarios[0]?.id).toBe("automatic-failure-aaaaaaaaaaaaaaaaaaaaaaaa");
  });

  test("defensively redacts secret-shaped error codes from persisted historical records before export", () => {
    const secret = "sk-proj-SUPERSECRET0123456789";
    const record = automaticRecord();
    record.automaticFailure!.errorCode = secret;
    record.automaticFailure!.rootCause = `Authorization failed for ${secret}`;
    record.qaScenario!.observed.errorCode = secret;

    const exported = automaticFailureQaExportScenario(record);
    expect(exported).not.toBeNull();
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("SUPERSECRET");
    expect(exported?.observed.errorCode).toMatch(/REDACTED|^failure_/u);
  });
});
