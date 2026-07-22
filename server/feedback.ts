import { HttpError, sha256Hex, stableStringify } from "./security.ts";

export const FEEDBACK_BODY_BYTES = 2 * 1024 * 1024;
export const FEEDBACK_IMAGE_BYTES = Math.floor(1.25 * 1024 * 1024);
export const FEEDBACK_MESSAGE_MINIMUM = 10;
export const FEEDBACK_MESSAGE_MAXIMUM = 4_000;
export const FEEDBACK_MAX_IMAGE_DIMENSION = 4_096;
export const FEEDBACK_MAX_IMAGE_PIXELS = 12_000_000;

export type FeedbackKind = "bug" | "improvement";
export type FeedbackStatus = "new" | "reviewed" | "resolved";
export type FeedbackImageMimeType = "image/png" | "image/jpeg";
export type FeedbackOrigin = "manual" | "automatic_failure";
export type AutomaticFailureClass =
  | "brief_failure"
  | "research_failure"
  | "matching_failure"
  | "publication_failure"
  | "system_failure"
  | "integrity_failure";
export type AutomaticQaScenarioStatus = "quarantined" | "promoted" | "dismissed";

/**
 * Owner-only diagnostics captured when a playlist request reaches a terminal
 * failure. The public feedback parser never accepts this structure; only
 * trusted server code may persist it.
 *
 * The nested records intentionally stay additive so newer workers can attach
 * stage counters and policy versions without making older reports unreadable.
 * Callers must keep every value JSON-safe and must not include credentials,
 * capability tokens, raw IP buckets, provider payloads, or stack traces.
 */
export interface AutomaticFailureDiagnostics {
  schemaVersion: 1;
  failureClass: AutomaticFailureClass;
  eventFingerprint: string;
  runId: string | null;
  /**
   * The retained visitor access whose prompt was captured for this report.
   * A shared canonical run can have several independent access records; tying
   * the report to one access lets deleting that access remove only its prompt.
   */
  runAccessId: string | null;
  briefRequestId: string | null;
  prompt: string;
  requestedTrackCount: number | null;
  storefront: string | null;
  status: string;
  phase: string | null;
  rootCause: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Stable timestamp/generation for the terminal transition, when known. */
  terminalGeneration: string | null;
  occurredAt: string;
  runtime: Record<string, string | number | boolean | null>;
  plan: Record<string, string | number | boolean | null>;
  counters: Record<string, number>;
  details: Record<string, unknown>;
}

/**
 * A captured production failure is a quarantined QA candidate, not an active
 * test. An owner must review and explicitly promote it into the checked-in QA
 * harness so untrusted prompts can never change release gates at runtime.
 */
export interface AutomaticQaScenario {
  schemaVersion: 1;
  scenarioId: string;
  source: "automatic_failure";
  status: AutomaticQaScenarioStatus;
  capturedAt: string;
  request: {
    prompt: string;
    requestedTrackCount: number | null;
    storefront: string | null;
  };
  expected: {
    noTerminalFailure: true;
    requestedTrackCount: number | null;
  };
  observed: {
    failureClass: AutomaticFailureClass;
    status: string;
    phase: string | null;
    errorCode: string | null;
    counters: Record<string, number>;
  };
  replay: Record<string, string | number | boolean | null>;
}

export interface FeedbackImage {
  mimeType: FeedbackImageMimeType;
  dataBase64: string;
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
}

export interface FeedbackSubmissionInput {
  kind: FeedbackKind;
  message: string;
  pagePath: string | null;
  appVersion: string | null;
  image: FeedbackImage | null;
}

export interface FeedbackSubmissionRecord extends FeedbackSubmissionInput {
  id: string;
  status: FeedbackStatus;
  createdAt: string;
  updatedAt: string;
  /** Missing on historical records and interpreted as `manual`. */
  origin?: FeedbackOrigin;
  automaticFailure?: AutomaticFailureDiagnostics | null;
  qaScenario?: AutomaticQaScenario | null;
  occurrenceCount?: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
  qaStatus?: AutomaticQaScenarioStatus;
}

export interface FeedbackListItem extends Omit<FeedbackSubmissionRecord, "image"> {
  image: Omit<FeedbackImage, "dataBase64"> | null;
}

const OWNER_SAFE_QA_REPLAY_KEYS = new Set([
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

const SENSITIVE_DIAGNOSTIC_TEXT_PATTERNS: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]{0,16384}?-----END [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/gu, "[REDACTED PEM MATERIAL]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/giu, "[REDACTED OPENAI KEY]"],
  [/\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/gu, "[REDACTED GITHUB TOKEN]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED GITLAB TOKEN]"],
  [/\bnpm_[A-Za-z0-9]{20,}\b/gu, "[REDACTED NPM TOKEN]"],
  [/\bAIza[A-Za-z0-9_-]{30,}\b/gu, "[REDACTED GOOGLE KEY]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[REDACTED AWS KEY]"],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/gu, "[REDACTED STRIPE KEY]"],
  [/\bwhsec_[A-Za-z0-9]{16,}\b/gu, "[REDACTED STRIPE SECRET]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/gu, "[REDACTED SLACK TOKEN]"],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED SENDGRID KEY]"],
  [/\bSK[0-9a-f]{32}\b/giu, "[REDACTED PROVIDER KEY]"],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}=*/giu, "Bearer [REDACTED TOKEN]"],
  [/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED JWT]"],
  [/\b(?:api[ _-]?key|access[ _-]?token|user[ _-]?token|password|secret)\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{8,}=?["']?/giu, "[REDACTED CREDENTIAL]"],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED EMAIL]"],
];

/** Preserve a replayable query while removing pasted credentials and email. */
export function redactSensitiveDiagnosticText(value: string, maximum = 2_000): string {
  let redacted = value;
  for (const [pattern, replacement] of SENSITIVE_DIAGNOSTIC_TEXT_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted.slice(0, maximum);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PRIVATE_FEEDBACK_FIELDS = [
  "origin",
  "automaticFailure",
  "qaScenario",
  "occurrenceCount",
  "firstSeenAt",
  "lastSeenAt",
  "qaStatus",
] as const;

const NON_FAILURE_PHASES = new Set([
  "owner_cancelled",
  "visitor_deleted",
  "cancelled",
  "deleted",
  "expired",
  "apple_authorization",
  "apple_reauthorization",
  "waiting_for_apple_authorization",
]);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Feedback is invalid", "invalid_feedback");
  }
  return value as Record<string, unknown>;
}

export function parseFeedbackKind(value: unknown): FeedbackKind {
  if (value !== "bug" && value !== "improvement") {
    throw new HttpError(400, "Choose bug or improvement", "invalid_feedback_kind");
  }
  return value;
}

export function parseFeedbackStatus(value: unknown): FeedbackStatus {
  if (value !== "new" && value !== "reviewed" && value !== "resolved") {
    throw new HttpError(400, "Feedback status is invalid", "invalid_feedback_status");
  }
  return value;
}

function parseMessage(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "Describe the bug or improvement", "invalid_feedback_message");
  }
  const message = value.trim();
  if (
    message.length < FEEDBACK_MESSAGE_MINIMUM
    || message.length > FEEDBACK_MESSAGE_MAXIMUM
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(message)
  ) {
    throw new HttpError(
      400,
      `Feedback must be ${FEEDBACK_MESSAGE_MINIMUM}–${FEEDBACK_MESSAGE_MAXIMUM.toLocaleString("en-US")} characters`,
      "invalid_feedback_message",
    );
  }
  return message;
}

function parsePagePath(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 300 || !value.startsWith("/") || /[?#\\\u0000-\u001f\u007f]/u.test(value)) {
    throw new HttpError(400, "Feedback page path is invalid", "invalid_feedback_path");
  }
  try {
    const parsed = new URL(value, "https://9enio.invalid");
    if (parsed.origin !== "https://9enio.invalid" || parsed.pathname !== value || parsed.search || parsed.hash) throw new Error("non-canonical");
  } catch {
    throw new HttpError(400, "Feedback page path is invalid", "invalid_feedback_path");
  }
  return value;
}

function parseAppVersion(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, "App version is invalid", "invalid_feedback_version");
  const version = value.trim();
  if (!version || version.length > 120 || /[\u0000-\u001f\u007f]/u.test(version)) {
    throw new HttpError(400, "App version is invalid", "invalid_feedback_version");
  }
  return version;
}

function canonicalBase64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(FEEDBACK_IMAGE_BYTES / 3) * 4 + 4) {
    throw new HttpError(400, "Screenshot is invalid", "invalid_feedback_image");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const unpadded = padding > 0 ? value.slice(0, -padding) : value;
  if (
    value.length % 4 !== 0
    || /[^A-Za-z0-9+/=]/.test(value)
    || unpadded.includes("=")
    || (padding === 1 && unpadded.length % 4 !== 3)
    || (padding === 2 && unpadded.length % 4 !== 2)
  ) {
    throw new HttpError(400, "Screenshot must use canonical base64", "invalid_feedback_image");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > FEEDBACK_IMAGE_BYTES || bytes.toString("base64") !== value) {
    throw new HttpError(400, "Screenshot is too large or invalid", "invalid_feedback_image");
  }
  return bytes;
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 45 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new HttpError(400, "Screenshot contents do not match image/png", "invalid_feedback_image");
  }
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new HttpError(400, "PNG screenshot is malformed", "invalid_feedback_image");
  }
  let offset = 8;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) {
      throw new HttpError(400, "PNG screenshot is malformed", "invalid_feedback_image");
    }
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL") throw new HttpError(400, "Animated screenshots are not supported", "invalid_feedback_image");
    offset += length + 12;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended || offset !== bytes.length) throw new HttpError(400, "PNG screenshot is malformed", "invalid_feedback_image");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw new HttpError(400, "Screenshot contents do not match image/jpeg", "invalid_feedback_image");
  }
  let offset = 2;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 7) break;
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  throw new HttpError(400, "JPEG screenshot is malformed", "invalid_feedback_image");
}

function parseImage(value: unknown): FeedbackImage | null {
  if (value === undefined || value === null) return null;
  const input = object(value);
  const mimeType = input.mimeType;
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") {
    throw new HttpError(400, "Screenshot must be PNG or JPEG", "invalid_feedback_image_type");
  }
  const bytes = canonicalBase64(input.dataBase64);
  const dimensions = mimeType === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (
    dimensions.width < 1
    || dimensions.height < 1
    || dimensions.width > FEEDBACK_MAX_IMAGE_DIMENSION
    || dimensions.height > FEEDBACK_MAX_IMAGE_DIMENSION
    || dimensions.width * dimensions.height > FEEDBACK_MAX_IMAGE_PIXELS
  ) {
    throw new HttpError(400, "Screenshot dimensions are too large or invalid", "invalid_feedback_image_dimensions");
  }
  if (
    (input.width !== undefined && input.width !== dimensions.width)
    || (input.height !== undefined && input.height !== dimensions.height)
  ) {
    throw new HttpError(400, "Screenshot dimensions do not match its contents", "invalid_feedback_image_dimensions");
  }
  return {
    mimeType,
    dataBase64: bytes.toString("base64"),
    byteSize: bytes.length,
    width: dimensions.width,
    height: dimensions.height,
    sha256: sha256Hex(bytes),
  };
}

export function parseFeedbackSubmission(value: unknown): FeedbackSubmissionInput {
  const input = object(value);
  if (PRIVATE_FEEDBACK_FIELDS.some((field) => input[field] !== undefined)) {
    throw new HttpError(
      400,
      "Automatic failure details may only be submitted by the service",
      "private_feedback_fields",
    );
  }
  return {
    kind: parseFeedbackKind(input.kind),
    message: parseMessage(input.message),
    pagePath: parsePagePath(input.pagePath),
    appVersion: parseAppVersion(input.appVersion),
    image: parseImage(input.image),
  };
}

export function feedbackPayloadHash(input: FeedbackSubmissionInput): string {
  return sha256Hex(stableStringify({
    kind: input.kind,
    message: input.message,
    pagePath: input.pagePath,
    appVersion: input.appVersion,
    image: input.image ? {
      mimeType: input.image.mimeType,
      byteSize: input.image.byteSize,
      width: input.image.width,
      height: input.image.height,
      sha256: input.image.sha256,
    } : null,
  }));
}

export function feedbackListItem(record: FeedbackSubmissionRecord): FeedbackListItem {
  const automaticFailure = record.automaticFailure
    ? {
        ...record.automaticFailure,
        // Inbox pages can contain many automatic reports. Full checkpoint
        // diagnostics remain in private storage and the offline QA export;
        // listing them here would allow a 100-item page to exceed 12 MiB.
        details: { summaryOnly: true },
      }
    : null;
  return {
    ...record,
    origin: record.origin === "automatic_failure" ? "automatic_failure" : "manual",
    automaticFailure,
    // The inbox may display the private diagnostics, but its copy-to-QA action
    // must never receive production plan IDs or arbitrary future replay keys.
    // Keep that boundary server-side so an older or modified client cannot
    // bypass the allowlist.
    qaScenario: record.qaScenario ? sanitizeAutomaticQaScenario(record.qaScenario) : null,
    image: record.image ? {
      mimeType: record.image.mimeType,
      byteSize: record.image.byteSize,
      width: record.image.width,
      height: record.image.height,
      sha256: record.image.sha256,
    } : null,
  };
}

export function sanitizeAutomaticQaScenario(scenario: AutomaticQaScenario): AutomaticQaScenario {
  return {
    schemaVersion: 1,
    scenarioId: String(scenario.scenarioId).slice(0, 120),
    source: "automatic_failure",
    status: scenario.status,
    capturedAt: scenario.capturedAt,
    request: {
      prompt: redactSensitiveDiagnosticText(scenario.request.prompt),
      requestedTrackCount: Number.isInteger(scenario.request.requestedTrackCount)
        ? scenario.request.requestedTrackCount
        : null,
      storefront: typeof scenario.request.storefront === "string"
        ? scenario.request.storefront.slice(0, 16)
        : null,
    },
    expected: {
      noTerminalFailure: true,
      requestedTrackCount: Number.isInteger(scenario.expected.requestedTrackCount)
        ? scenario.expected.requestedTrackCount
        : null,
    },
    observed: {
      failureClass: scenario.observed.failureClass,
      status: String(scenario.observed.status).slice(0, 80),
      phase: typeof scenario.observed.phase === "string" ? scenario.observed.phase.slice(0, 120) : null,
      errorCode: typeof scenario.observed.errorCode === "string"
        ? redactSensitiveDiagnosticText(scenario.observed.errorCode, 120)
        : null,
      counters: Object.fromEntries(
        Object.entries(scenario.observed.counters).flatMap(([key, value]) => {
          const count = Number(value);
          return Number.isFinite(count) && count >= 0 ? [[key.slice(0, 80), Math.floor(count)]] : [];
        }),
      ),
    },
    replay: Object.fromEntries(
      Object.entries(scenario.replay).filter(([key, value]) => OWNER_SAFE_QA_REPLAY_KEYS.has(key)
        && (value === null || ["string", "number", "boolean"].includes(typeof value))),
    ),
  };
}

export interface AutomaticFailureFingerprintInput {
  source: "run" | "brief";
  sourceId: string;
  status: string;
  phase?: string | null;
  failureClass: AutomaticFailureClass;
  activePlanRevision?: string | number | null;
  errorCode?: string | null;
  terminalGeneration?: string | number | null;
}

/**
 * Classifies only operational terminal failures. Expected product outcomes
 * such as a partial result, no compatible tracks, cancellation, expiration,
 * or an Apple-authorization wait deliberately return null.
 */
export function classifyAutomaticRunFailure(status: string, phase?: string | null): AutomaticFailureClass | null {
  const normalizedStatus = String(status ?? "").trim().toLowerCase();
  const normalizedPhase = String(phase ?? "").trim().toLowerCase();
  if (normalizedStatus === "failed_integrity") return "integrity_failure";
  if (normalizedStatus === "failed_system") return "system_failure";
  if (normalizedStatus !== "failed" || NON_FAILURE_PHASES.has(normalizedPhase)) return null;
  if (normalizedPhase.includes("publication") || normalizedPhase.includes("publish")) return "publication_failure";
  if (normalizedPhase.includes("matching") || normalizedPhase.includes("catalog")) return "matching_failure";
  if (normalizedPhase.includes("research")) return "research_failure";
  return "system_failure";
}

export function classifyAutomaticBriefFailure(status: string): AutomaticFailureClass | null {
  return String(status ?? "").trim().toLowerCase() === "failed" ? "brief_failure" : null;
}

/**
 * Stable identity for one terminal transition. Human error prose is
 * intentionally excluded because retry wrappers often reword the same
 * underlying failure. A bounded server-derived error code and terminal
 * generation distinguish genuinely different failures on the same run.
 */
export function automaticFailureFingerprint(input: AutomaticFailureFingerprintInput): string {
  return sha256Hex(stableStringify({
    schemaVersion: 1,
    source: input.source,
    sourceId: input.sourceId.trim(),
    status: input.status.trim().toLowerCase(),
    phase: input.phase?.trim().toLowerCase() || null,
    failureClass: input.failureClass,
    activePlanRevision: input.activePlanRevision ?? null,
    errorCode: input.errorCode?.trim().toLowerCase() || null,
    terminalGeneration: input.terminalGeneration ?? null,
  }));
}

export function createAutomaticQaScenario(diagnostics: AutomaticFailureDiagnostics): AutomaticQaScenario {
  return {
    schemaVersion: 1,
    scenarioId: `automatic-failure-${diagnostics.eventFingerprint.slice(0, 24)}`,
    source: "automatic_failure",
    status: "quarantined",
    capturedAt: diagnostics.occurredAt,
    request: {
      prompt: diagnostics.prompt,
      requestedTrackCount: diagnostics.requestedTrackCount,
      storefront: diagnostics.storefront,
    },
    expected: {
      noTerminalFailure: true,
      requestedTrackCount: diagnostics.requestedTrackCount,
    },
    observed: {
      failureClass: diagnostics.failureClass,
      status: diagnostics.status,
      phase: diagnostics.phase,
      errorCode: diagnostics.errorCode,
      counters: { ...diagnostics.counters },
    },
    replay: {
      ...diagnostics.runtime,
      ...Object.fromEntries(
        Object.entries(diagnostics.plan).map(([key, value]) => [`plan.${key}`, value]),
      ),
    },
  };
}
