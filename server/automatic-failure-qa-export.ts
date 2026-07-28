import type {
  AutomaticQaScenario,
} from "./feedback.ts";
import { redactSensitiveDiagnosticText } from "./feedback.ts";
import { EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS } from "../shared/product-policy.ts";

export type AutomaticFailureExportStatus = "quarantined" | "promoted" | "dismissed";

export interface AutomaticFailureQaExportScenario {
  id: string;
  capturedAt: string;
  status: AutomaticFailureExportStatus;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  request: AutomaticQaScenario["request"];
  expected: AutomaticQaScenario["expected"];
  observed: AutomaticQaScenario["observed"] & { rootCause: string | null };
  replay: Record<string, string | number | boolean | null>;
}

const SAFE_REPLAY_KEYS = new Set([
  "appVersion",
  "buildRevision",
  "databaseSchemaVersion",
  "workerProtocol",
  "promptVersion",
  "baselineModel",
  "actualBriefModel",
  "configuredModel",
  "plan.pipelineVersion",
  "plan.policyVersion",
  "plan.specHash",
  "plan.selectionPlanRevision",
  "plan.selectionPlanHash",
  "plan.queryPlanRevision",
  "plan.queryPlanHash",
  "plan.queryPlanSchemaVersion",
  "plan.selectionPlanPresent",
]);

const AUTOMATIC_FAILURE_CLASSES = new Set([
  "brief_failure",
  "research_failure",
  "matching_failure",
  "publication_failure",
  "system_failure",
  "integrity_failure",
]);

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function automaticFailureClass(value: unknown): AutomaticQaScenario["observed"]["failureClass"] | null {
  return typeof value === "string" && AUTOMATIC_FAILURE_CLASSES.has(value)
    ? value as AutomaticQaScenario["observed"]["failureClass"]
    : null;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function finiteCount(value: unknown, fallback = 1): number {
  if (typeof value !== "number" && typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function requestedTrackCount(value: unknown): number | null {
  return Number.isInteger(value)
    && Number(value) >= 1
    && Number(value) <= EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS
    ? Number(value)
    : null;
}

function nullableBoundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" ? value.slice(0, maximum) : null;
}

function safeScalarRecord(value: Record<string, unknown>): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item === null || ["string", "number", "boolean"].includes(typeof item)),
  ) as Record<string, string | number | boolean | null>;
}

function safeReplay(
  scenarioReplay: Record<string, unknown>,
  runtime: Record<string, unknown>,
  plan: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const replay: Record<string, unknown> = { ...safeScalarRecord(scenarioReplay) };
  for (const [key, value] of Object.entries(safeScalarRecord(runtime))) replay[key] = value;
  for (const [key, value] of Object.entries(safeScalarRecord(plan))) replay[`plan.${key}`] = value;
  return Object.fromEntries(
    Object.entries(replay).filter(([key, value]) => SAFE_REPLAY_KEYS.has(key)
      && (value === null || ["string", "number", "boolean"].includes(typeof value))),
  ) as Record<string, string | number | boolean | null>;
}

/**
 * Builds the only payload allowed to leave the private automatic-feedback
 * store for QA promotion. It deliberately omits production IDs, diagnostic
 * details, error prose, capability data, visitor identity, and provider
 * payloads. The prompt is retained after recognized credential-like values
 * are redacted because it is the regression input; callers must keep the raw
 * export private until a human completes the privacy and QA review.
 */
export function automaticFailureQaExportScenario(
  value: unknown,
): AutomaticFailureQaExportScenario | null {
  const record = plainRecord(value);
  if (record?.origin !== "automatic_failure") return null;

  const diagnostics = plainRecord(record.automaticFailure);
  const qaScenario = plainRecord(record.qaScenario);
  if (!diagnostics || !qaScenario) return null;
  if (diagnostics.schemaVersion !== 1 || qaScenario.schemaVersion !== 1 || qaScenario.source !== "automatic_failure") return null;

  const request = plainRecord(qaScenario.request);
  const expected = plainRecord(qaScenario.expected);
  const observed = plainRecord(qaScenario.observed);
  const replay = plainRecord(qaScenario.replay);
  const runtime = plainRecord(diagnostics.runtime);
  const plan = plainRecord(diagnostics.plan);
  if (!request || !expected || !observed || !replay || !runtime || !plan) return null;
  if (expected.noTerminalFailure !== true) return null;

  if (typeof request.prompt !== "string" || request.prompt.length < 1 || request.prompt.length > 2_000) return null;
  const prompt = redactSensitiveDiagnosticText(request.prompt);
  if (prompt.length < 1) return null;

  const status = record.qaStatus ?? qaScenario.status;
  if (status !== "quarantined" && status !== "promoted" && status !== "dismissed") return null;
  if (!validDate(qaScenario.capturedAt)) return null;

  const scenarioId = qaScenario.scenarioId;
  const failureClass = automaticFailureClass(observed.failureClass);
  const countersRecord = plainRecord(observed.counters);
  if (typeof scenarioId !== "string" || scenarioId.length < 1 || scenarioId.length > 200) return null;
  if (!failureClass || typeof observed.status !== "string" || !countersRecord) return null;

  const firstSeenAt = validDate(record.firstSeenAt) ? record.firstSeenAt : qaScenario.capturedAt;
  const lastSeenAt = validDate(record.lastSeenAt) ? record.lastSeenAt : qaScenario.capturedAt;
  const counters = Object.fromEntries(
    Object.entries(countersRecord).flatMap(([key, value]) => {
      const count = Number(value);
      return Number.isFinite(count) && count >= 0 ? [[key.slice(0, 80), Math.floor(count)]] : [];
    }),
  );

  return {
    id: scenarioId,
    capturedAt: qaScenario.capturedAt,
    status,
    occurrenceCount: Math.max(1, finiteCount(record.occurrenceCount)),
    firstSeenAt,
    lastSeenAt,
    request: {
      prompt,
      requestedTrackCount: requestedTrackCount(request.requestedTrackCount),
      storefront: nullableBoundedString(request.storefront, 16),
    },
    expected: {
      noTerminalFailure: true,
      requestedTrackCount: requestedTrackCount(expected.requestedTrackCount),
    },
    observed: {
      failureClass,
      status: observed.status.slice(0, 80),
      phase: nullableBoundedString(observed.phase, 120),
      errorCode: typeof observed.errorCode === "string"
        ? redactSensitiveDiagnosticText(observed.errorCode, 120)
        : null,
      counters,
      rootCause: typeof diagnostics.rootCause === "string"
        ? redactSensitiveDiagnosticText(diagnostics.rootCause, 240)
        : null,
    },
    replay: safeReplay(replay, runtime, plan),
  };
}

export function buildAutomaticFailureQaExport(
  records: readonly unknown[],
  status: AutomaticFailureExportStatus | "all" = "quarantined",
  generatedAt = new Date().toISOString(),
) {
  const scenarios = records
    .flatMap((record) => {
      try {
        const scenario = automaticFailureQaExportScenario(record);
        return scenario && (status === "all" || scenario.status === status) ? [scenario] : [];
      } catch {
        // Historical settings rows are untrusted persisted JSON. Isolate a
        // malformed record so one corrupt submission cannot abort the export.
        return [];
      }
    })
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt) || left.id.localeCompare(right.id));
  return {
    schemaVersion: "genio-automatic-failure-qa-export/v1" as const,
    generatedAt,
    warning: "Contains untrusted visitor prompt text. Keep private, redact personal data, and review before adding to checked-in QA fixtures.",
    scenarioCount: scenarios.length,
    scenarios,
  };
}
