import type { EvidenceAuthorityV3 } from "./evidence-graph-policy.ts";
import {
  EvidenceGraphLifecycleErrorV3,
  type EvidenceGraphFreshnessPolicyV3,
  type EvidenceGraphSourceAccessMethodV3,
} from "./evidence-graph-service-v3.ts";
import { HttpError } from "./security.ts";

const AUTHORITIES = new Set<EvidenceAuthorityV3>([
  "primary_track_credit",
  "official_track_credit",
  "specialist_track_credit",
  "trusted_editorial_container",
  "secondary_database",
  "catalog_metadata",
  "unknown",
]);
const SOURCE_STATUSES = new Set(["active", "stale", "takedown", "revoked"]);
const OBSERVATION_STATUSES = new Set(["quarantined", "rejected", "promoted"]);
const ASSERTION_STATUSES = new Set(["active", "superseded", "retracted"]);
const SNAPSHOT_STATUSES = new Set(["building", "locked", "superseded"]);
const CREDIT_SCOPES = new Set([
  "exact_recording",
  "exact_release_all_tracks",
  "release_unspecified_tracks",
  "recording_family",
  "album",
]);
const ACCESS_METHODS = new Set<EvidenceGraphSourceAccessMethodV3>([
  "hosted_web_search", "structured_adapter", "public_api", "owner_import", "manual_entry",
]);
const APPROVABLE_CACHE_POLICIES = new Set<"excerpt_only" | "full_document_permitted">([
  "excerpt_only", "full_document_permitted",
]);
const APPROVABLE_RETENTION_POLICIES = new Set<"durable_public_corpus" | "license_term">([
  "durable_public_corpus", "license_term",
]);
const FRESHNESS_POLICIES = new Set<EvidenceGraphFreshnessPolicyV3>([
  "immutable_revision", "revalidate_30d", "revalidate_90d",
]);

function object(value: unknown, allowedKeys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be an object`, "invalid_corpus_request");
  }
  const result = value as Record<string, unknown>;
  const extra = Object.keys(result).filter((key) => !allowedKeys.includes(key));
  if (extra.length > 0) {
    throw new HttpError(400, `${label} contains unsupported fields`, "invalid_corpus_request");
  }
  return result;
}

function text(value: unknown, label: string, maximum: number): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new HttpError(400, `${label} is invalid`, "invalid_corpus_request");
  }
  return result;
}

function uuid(value: unknown, label: string, optional = false): string | null {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new HttpError(400, `${label} is invalid`, "invalid_corpus_request");
  }
  return value;
}

function enumeration<T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new HttpError(400, `${label} is invalid`, "invalid_corpus_request");
  }
  return value as T;
}

function jsonValue(value: unknown, depth = 0): void {
  if (depth > 8) throw new HttpError(400, "Observation metadata is too deeply nested", "invalid_corpus_request");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new HttpError(400, "Observation metadata is invalid", "invalid_corpus_request");
    return;
  }
  if (typeof value === "string") {
    if (value.length > 2_000 || /[\u0000\u007f]/u.test(value)) {
      throw new HttpError(400, "Observation metadata contains invalid text", "invalid_corpus_request");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 200) throw new HttpError(400, "Observation metadata is too large", "invalid_corpus_request");
    value.forEach((item) => jsonValue(item, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 100) throw new HttpError(400, "Observation metadata is too large", "invalid_corpus_request");
    for (const [key, item] of entries) {
      if (!key || key.length > 160 || /[\u0000-\u001f\u007f]/u.test(key)) {
        throw new HttpError(400, "Observation metadata contains an invalid key", "invalid_corpus_request");
      }
      jsonValue(item, depth + 1);
    }
    return;
  }
  throw new HttpError(400, "Observation metadata is not valid JSON", "invalid_corpus_request");
}

function jsonObject(value: unknown): Record<string, unknown> {
  const result = object(value, Object.keys((value ?? {}) as object), "objectJson");
  jsonValue(result);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 16 * 1024) {
    throw new HttpError(400, "Observation metadata exceeds 16 KB", "invalid_corpus_request");
  }
  return result;
}

export interface OwnerCorpusListQueryV3 {
  limit: number;
  offset: number;
  status: string | null;
}

export function parseOwnerCorpusListQueryV3(
  value: unknown,
  kind: "source" | "observation" | "assertion" | "snapshot" | "review",
): OwnerCorpusListQueryV3 {
  const query = object(value ?? {}, ["limit", "offset", "status"], "Query");
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, "Limit must be an integer from 1 to 100", "invalid_pagination");
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new HttpError(400, "Offset must be an integer from 0 to 1000000", "invalid_pagination");
  }
  const allowed = kind === "source"
    ? SOURCE_STATUSES
    : kind === "assertion"
      ? ASSERTION_STATUSES
      : kind === "snapshot"
        ? SNAPSHOT_STATUSES
        : OBSERVATION_STATUSES;
  const defaultStatus = kind === "review" ? "quarantined" : null;
  const status = query.status === undefined ? defaultStatus : enumeration(query.status, allowed, "Status");
  if (kind === "review" && status !== "quarantined") {
    throw new HttpError(400, "The review queue contains quarantined observations only", "invalid_corpus_request");
  }
  return { limit, offset, status };
}

export function parseSourcePolicyApprovalV3(value: unknown): {
  authority: EvidenceAuthorityV3;
  accessMethod: EvidenceGraphSourceAccessMethodV3;
  licenseState: "reusable" | "permission_recorded";
  licenseVersion: string;
  termsVersion: string;
  attribution: string;
  cachePolicy: "excerpt_only" | "full_document_permitted";
  retentionPolicy: "durable_public_corpus" | "license_term";
  freshnessPolicy: EvidenceGraphFreshnessPolicyV3;
  sourceRevision: string;
} {
  const body = object(value, [
    "authority", "accessMethod", "licenseState", "licenseVersion", "termsVersion",
    "attribution", "cachePolicy", "retentionPolicy", "freshnessPolicy", "sourceRevision",
  ], "Body");
  return {
    authority: enumeration(body.authority, AUTHORITIES, "Authority"),
    accessMethod: enumeration(body.accessMethod, ACCESS_METHODS, "Access method"),
    licenseState: enumeration(
      body.licenseState,
      new Set<"reusable" | "permission_recorded">(["reusable", "permission_recorded"]),
      "License state",
    ),
    licenseVersion: text(body.licenseVersion, "License version", 160),
    termsVersion: text(body.termsVersion, "Terms version", 160),
    attribution: text(body.attribution, "Attribution", 1_000),
    cachePolicy: enumeration(body.cachePolicy, APPROVABLE_CACHE_POLICIES, "Cache policy"),
    retentionPolicy: enumeration(body.retentionPolicy, APPROVABLE_RETENTION_POLICIES, "Retention policy"),
    freshnessPolicy: enumeration(body.freshnessPolicy, FRESHNESS_POLICIES, "Freshness policy"),
    sourceRevision: text(body.sourceRevision, "Source revision", 160),
  };
}

export function parseAppendObservationV3(value: unknown): {
  sourceDocumentId: string;
  subjectEntityId: string | null;
  recordingId: string | null;
  releaseId: string | null;
  predicate: string;
  objectJson: Record<string, unknown>;
  creditScope: string | null;
  supportExcerpt: string;
  confidence: number;
} {
  const body = object(value, [
    "sourceDocumentId", "subjectEntityId", "recordingId", "releaseId", "predicate",
    "objectJson", "creditScope", "supportExcerpt", "confidence",
  ], "Body");
  const confidence = Number(body.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new HttpError(400, "Confidence must be between 0 and 1", "invalid_corpus_request");
  }
  return {
    sourceDocumentId: uuid(body.sourceDocumentId, "Source document ID")!,
    subjectEntityId: uuid(body.subjectEntityId, "Subject entity ID", true),
    recordingId: uuid(body.recordingId, "Recording ID", true),
    releaseId: uuid(body.releaseId, "Release ID", true),
    predicate: text(body.predicate, "Predicate", 160),
    objectJson: jsonObject(body.objectJson),
    creditScope: body.creditScope == null ? null : enumeration(body.creditScope, CREDIT_SCOPES, "Credit scope"),
    supportExcerpt: text(body.supportExcerpt, "Support excerpt", 1_000),
    confidence,
  };
}

export function parsePromotionV3(value: unknown): { observationIds: string[] } {
  const body = object(value, ["observationIds"], "Body");
  if (!Array.isArray(body.observationIds) || body.observationIds.length < 1 || body.observationIds.length > 50) {
    throw new HttpError(400, "Promotion requires 1 to 50 observation IDs", "invalid_corpus_request");
  }
  const observationIds = [...new Set(body.observationIds.map((id) => uuid(id, "Observation ID")!))];
  return { observationIds };
}

export function parseDisputeV3(value: unknown): { observationId: string } {
  const body = object(value, ["observationId"], "Body");
  return { observationId: uuid(body.observationId, "Observation ID")! };
}

export function parseReasonV3(value: unknown): { reason: string } {
  const body = object(value, ["reason"], "Body");
  return { reason: text(body.reason, "Reason", 500) };
}

export function parseSnapshotV3(value: unknown): { parentSnapshotId: string | null } {
  const body = object(value ?? {}, ["parentSnapshotId"], "Body");
  return { parentSnapshotId: uuid(body.parentSnapshotId, "Parent snapshot ID", true) };
}

export function parseBulkHideV3(value: unknown): { scope: "all_listed" | "ids"; playlistIds: string[] } {
  const body = object(value, ["scope", "playlistIds"], "Body");
  const scope = enumeration(
    body.scope,
    new Set<"all_listed" | "ids">(["all_listed", "ids"]),
    "Scope",
  );
  if (scope === "all_listed") {
    if (body.playlistIds !== undefined) throw new HttpError(400, "playlistIds is not allowed for all_listed", "invalid_corpus_request");
    return { scope, playlistIds: [] };
  }
  if (!Array.isArray(body.playlistIds) || body.playlistIds.length < 1 || body.playlistIds.length > 1_000) {
    throw new HttpError(400, "Bulk hide requires 1 to 1000 playlist IDs", "invalid_corpus_request");
  }
  return { scope, playlistIds: [...new Set(body.playlistIds.map((id) => uuid(id, "Playlist ID")!))] };
}

export function evidenceGraphHttpErrorV3(error: unknown): never {
  if (!(error instanceof EvidenceGraphLifecycleErrorV3)) throw error;
  const notFound = new Set(["source_not_found", "observation_not_found"]);
  const badInput = new Set([
    "invalid_input", "observation_subject_missing", "confidence_invalid", "claim_mismatch",
    "track_scope_ineligible", "exact_track_scope_missing", "album_credit_track_scope_unspecified",
    "recording_family_not_exact_credit_scope", "evidence_missing", "dispute_claim_mismatch",
    "source_access_method_mismatch", "source_revision_mismatch",
  ]);
  const status = notFound.has(error.code) ? 404 : badInput.has(error.code) ? 400 : 409;
  throw new HttpError(status, error.message, `corpus_${error.code}`);
}
