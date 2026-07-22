import { expect, test } from "vitest";
import {
  FEEDBACK_IMAGE_BYTES,
  automaticFailureFingerprint,
  classifyAutomaticBriefFailure,
  classifyAutomaticRunFailure,
  createAutomaticQaScenario,
  feedbackListItem,
  feedbackPayloadHash,
  parseFeedbackStatus,
  parseFeedbackSubmission,
  redactSensitiveDiagnosticText,
  type AutomaticFailureDiagnostics,
} from "../server/feedback.ts";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

test("automatic diagnostic text redacts credential and identity-shaped values", () => {
  expect(redactSensitiveDiagnosticText(
    "disco test sk-proj-abcdefghijklmnopqrst api_key=supersecretvalue owner@example.com",
  )).toBe("disco test [REDACTED OPENAI KEY] [REDACTED CREDENTIAL] [REDACTED EMAIL]");
  expect(redactSensitiveDiagnosticText(
    "AIza12345678901234567890123456789012345 AKIA1234567890ABCDEF xoxb-123456789012-abcdefghijklmnop sk_live_1234567890abcdefghijklmnop",
  )).toBe("[REDACTED GOOGLE KEY] [REDACTED AWS KEY] [REDACTED SLACK TOKEN] [REDACTED STRIPE KEY]");
  expect(redactSensitiveDiagnosticText(
    "-----BEGIN PRIVATE KEY-----\nsecret-key-material\n-----END PRIVATE KEY-----",
  )).toBe("[REDACTED PEM MATERIAL]");
});

test("validates and normalizes a feedback submission without exposing image bytes in owner lists", () => {
  const submission = parseFeedbackSubmission({
    kind: "bug",
    message: "  The playlist button did not respond.  ",
    pagePath: "/feedback",
    appVersion: "release-123",
    image: {
      mimeType: "image/png",
      dataBase64: ONE_PIXEL_PNG,
      width: 1,
      height: 1,
    },
  });
  expect(submission).toMatchObject({
    kind: "bug",
    message: "The playlist button did not respond.",
    pagePath: "/feedback",
    appVersion: "release-123",
    image: { mimeType: "image/png", width: 1, height: 1 },
  });
  expect(submission.image?.byteSize).toBe(Buffer.from(ONE_PIXEL_PNG, "base64").length);
  expect(submission.image?.sha256).toMatch(/^[a-f0-9]{64}$/);

  const listItem = feedbackListItem({
    id: "00000000-0000-4000-8000-000000000001",
    status: "new",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    ...submission,
  });
  expect(listItem.image).not.toHaveProperty("dataBase64");
  expect(JSON.stringify(listItem)).not.toContain(ONE_PIXEL_PNG);
  expect(listItem.origin).toBe("manual");
});

test("feedback payload hashing is stable and binds the private screenshot", () => {
  const first = parseFeedbackSubmission({
    kind: "improvement",
    message: "Please add a compact playlist view.",
    pagePath: "/",
    image: { mimeType: "image/png", dataBase64: ONE_PIXEL_PNG },
  });
  expect(feedbackPayloadHash(first)).toBe(feedbackPayloadHash({ ...first }));
  expect(feedbackPayloadHash(first)).not.toBe(feedbackPayloadHash({ ...first, message: `${first.message}!` }));
});

test("rejects unsupported, mismatched, malformed, animated, and oversized screenshots", () => {
  const base = { kind: "bug", message: "This is enough detail for feedback." };
  expect(() => parseFeedbackSubmission({
    ...base,
    image: { mimeType: "image/gif", dataBase64: ONE_PIXEL_PNG },
  })).toThrow(/PNG or JPEG/);
  expect(() => parseFeedbackSubmission({
    ...base,
    image: { mimeType: "image/jpeg", dataBase64: ONE_PIXEL_PNG },
  })).toThrow(/image\/jpeg/);
  expect(() => parseFeedbackSubmission({
    ...base,
    image: { mimeType: "image/png", dataBase64: `${ONE_PIXEL_PNG}\n` },
  })).toThrow(/canonical base64/);
  expect(() => parseFeedbackSubmission({
    ...base,
    image: { mimeType: "image/png", dataBase64: ONE_PIXEL_PNG, width: 2, height: 1 },
  })).toThrow(/dimensions do not match/);
  const oversized = Buffer.alloc(FEEDBACK_IMAGE_BYTES + 1, 0).toString("base64");
  expect(() => parseFeedbackSubmission({
    ...base,
    image: { mimeType: "image/png", dataBase64: oversized },
  })).toThrow(/invalid|large/i);
});

test("feedback accepts only constrained text, pathname-only context, and exact statuses", () => {
  expect(() => parseFeedbackSubmission({ kind: "complaint", message: "This message is long enough." })).toThrow(/bug or improvement/);
  expect(() => parseFeedbackSubmission({ kind: "bug", message: "short" })).toThrow(/10/);
  expect(() => parseFeedbackSubmission({ kind: "bug", message: "This message is long enough.\u0000" })).toThrow(/characters/);
  expect(() => parseFeedbackSubmission({ kind: "bug", message: "This message is long enough.", pagePath: "/jobs?secret=1" })).toThrow(/path/);
  expect(() => parseFeedbackSubmission({ kind: "bug", message: "This message is long enough.", pagePath: "https://example.com/jobs" })).toThrow(/path/);
  expect(parseFeedbackStatus("reviewed")).toBe("reviewed");
  expect(() => parseFeedbackStatus("published")).toThrow(/status/);
});

test("public feedback cannot inject owner-only automatic failure fields", () => {
  const base = { kind: "bug", message: "This request failed during research." };
  for (const privateField of [
    "origin",
    "automaticFailure",
    "qaScenario",
    "occurrenceCount",
    "firstSeenAt",
    "lastSeenAt",
    "qaStatus",
  ]) {
    expect(() => parseFeedbackSubmission({
      ...base,
      [privateField]: privateField === "origin" ? "automatic_failure" : {},
    })).toThrow(/only be submitted by the service/);
  }
});

test("classifies terminal failures without treating product outcomes as bugs", () => {
  expect(classifyAutomaticBriefFailure("failed")).toBe("brief_failure");
  expect(classifyAutomaticBriefFailure("complete")).toBeNull();
  expect(classifyAutomaticRunFailure("failed_system", "v3_retrieval_system_failure")).toBe("system_failure");
  expect(classifyAutomaticRunFailure("failed_integrity", "v3_retrieval_integrity_failure")).toBe("integrity_failure");
  expect(classifyAutomaticRunFailure("failed", "research_failed")).toBe("research_failure");
  expect(classifyAutomaticRunFailure("failed", "catalog_matching_failed")).toBe("matching_failure");
  expect(classifyAutomaticRunFailure("failed", "publication_failed")).toBe("publication_failure");
  expect(classifyAutomaticRunFailure("failed", "owner_cancelled")).toBeNull();
  expect(classifyAutomaticRunFailure("no_compatible_tracks", "v3_no_compatible_tracks")).toBeNull();
  expect(classifyAutomaticRunFailure("partial_ready", "partial_confirmation_required")).toBeNull();
  expect(classifyAutomaticRunFailure("waiting_for_apple_authorization", "apple_reauthorization")).toBeNull();
});

test("automatic failure fingerprints are deterministic for one terminal transition", () => {
  const input = {
    source: "run" as const,
    sourceId: "00000000-0000-4000-8000-000000000099",
    status: "failed_system",
    phase: "v3_retrieval_system_failure",
    failureClass: "system_failure" as const,
    activePlanRevision: 3,
    errorCode: "provider_timeout",
  };
  const fingerprint = automaticFailureFingerprint(input);
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(automaticFailureFingerprint({ ...input })).toBe(fingerprint);
  expect(automaticFailureFingerprint({ ...input, activePlanRevision: 4 })).not.toBe(fingerprint);
  expect(automaticFailureFingerprint({ ...input, errorCode: "provider_contract_failed" })).not.toBe(fingerprint);
  expect(automaticFailureFingerprint({ ...input, sourceId: `${input.sourceId}-different` })).not.toBe(fingerprint);
});

test("owner lists retain private diagnostics and a quarantined QA candidate without image bytes", () => {
  const eventFingerprint = automaticFailureFingerprint({
    source: "run",
    sourceId: "00000000-0000-4000-8000-000000000099",
    status: "failed_system",
    phase: "v3_retrieval_system_failure",
    failureClass: "system_failure",
    activePlanRevision: 3,
  });
  const automaticFailure: AutomaticFailureDiagnostics = {
    schemaVersion: 1,
    failureClass: "system_failure",
    eventFingerprint,
    runId: "00000000-0000-4000-8000-000000000099",
    runAccessId: "00000000-0000-4000-8000-000000000097",
    briefRequestId: "00000000-0000-4000-8000-000000000098",
    prompt: "Brazilian disco songs",
    requestedTrackCount: 50,
    storefront: "us",
    status: "failed_system",
    phase: "v3_retrieval_system_failure",
    rootCause: "provider_timeout",
    errorCode: "provider_timeout",
    errorMessage: "Research provider timed out after the final attempt",
    terminalGeneration: "1784678400000",
    occurredAt: "2026-07-22T00:00:00.000Z",
    runtime: {
      appVersion: "2.2.1",
      pipelineVersion: "corpus_first_v3",
      workerProtocol: 8,
    },
    plan: {
      activePlanRevision: 3,
      queryPlanSchemaVersion: 2,
      selectionPlanId: "production-selection-plan-id",
      queryPlanId: "production-query-plan-id",
    },
    counters: {
      candidatesDiscovered: 148,
      appleLookupCount: 0,
    },
    details: {
      rootCause: "provider_timeout",
      rejectedByPredicate: { disco: 148 },
    },
  };
  const qaScenario = createAutomaticQaScenario(automaticFailure);
  expect(qaScenario).toMatchObject({
    source: "automatic_failure",
    status: "quarantined",
    request: { prompt: "Brazilian disco songs", requestedTrackCount: 50, storefront: "us" },
    expected: { noTerminalFailure: true, requestedTrackCount: 50 },
    observed: { failureClass: "system_failure", errorCode: "provider_timeout" },
  });

  const listItem = feedbackListItem({
    id: "00000000-0000-4000-8000-000000000100",
    status: "new",
    kind: "bug",
    message: "Automatic report: playlist research reached a terminal failure.",
    pagePath: "/jobs",
    appVersion: "2.2.1",
    image: {
      mimeType: "image/png",
      dataBase64: ONE_PIXEL_PNG,
      byteSize: Buffer.from(ONE_PIXEL_PNG, "base64").length,
      width: 1,
      height: 1,
      sha256: "a".repeat(64),
    },
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    origin: "automatic_failure",
    automaticFailure,
    qaScenario,
    occurrenceCount: 1,
    firstSeenAt: "2026-07-22T00:00:00.000Z",
    lastSeenAt: "2026-07-22T00:00:00.000Z",
    qaStatus: "quarantined",
  });

  expect(listItem.origin).toBe("automatic_failure");
  expect(listItem.automaticFailure).toEqual({
    ...automaticFailure,
    details: { summaryOnly: true },
  });
  expect(listItem.qaScenario).toEqual(expect.objectContaining({
    scenarioId: qaScenario.scenarioId,
    request: qaScenario.request,
  }));
  expect(listItem.qaScenario?.replay).not.toHaveProperty("plan.selectionPlanId");
  expect(listItem.qaScenario?.replay).not.toHaveProperty("plan.queryPlanId");
  expect(listItem.image).not.toHaveProperty("dataBase64");
  expect(JSON.stringify(listItem)).not.toContain(ONE_PIXEL_PNG);
});
