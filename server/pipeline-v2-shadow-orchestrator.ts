import {
  PIPELINE_V2_SHADOW_INPUT_SCHEMA,
  evaluatePipelineV2ManifestShadow,
  type PipelineV2ShadowReport,
  type ShadowCandidatePool,
  type ShadowPipelineVersion,
} from "./pipeline-v2-shadow.ts";
import { sha256Hex, stableStringify } from "./security.ts";
import { EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS } from "../shared/product-policy.ts";

export const PIPELINE_SHADOW_RUN_ARTIFACT_SCHEMA = "genio-pipeline-shadow-run-artifact/v1" as const;
export const PIPELINE_V2_SHADOW_ORCHESTRATION_SCHEMA = "genio-pipeline-v2-shadow-orchestration/v1" as const;
export const PIPELINE_V2_SHADOW_ORCHESTRATION_REPORT_SCHEMA = "genio-pipeline-v2-shadow-orchestration-report/v1" as const;

export interface PipelineShadowSourceInput {
  promptHash: string;
  selectionPlanHash: string;
  storefront: string;
  targetTrackCount: number;
}

export interface PipelineShadowRunArtifact {
  schemaVersion: typeof PIPELINE_SHADOW_RUN_ARTIFACT_SCHEMA;
  artifactId: string;
  exportedAt: string;
  sourceInput: PipelineShadowSourceInput;
  candidatePool: ShadowCandidatePool;
}

export interface PipelineV2ShadowOrchestrationRequest {
  schemaVersion: typeof PIPELINE_V2_SHADOW_ORCHESTRATION_SCHEMA;
  comparisonId: string;
  primaryArtifact: PipelineShadowRunArtifact;
  shadowArtifact: PipelineShadowRunArtifact;
}

export interface PipelineV2ShadowOrchestrationReport {
  schemaVersion: typeof PIPELINE_V2_SHADOW_ORCHESTRATION_REPORT_SCHEMA;
  comparisonId: string;
  executionMode: "persisted_artifact_manifest_only";
  publicationCapability: "absent";
  sourceInput: PipelineShadowSourceInput;
  primaryArtifactId: string;
  shadowArtifactId: string;
  manifestComparison: PipelineV2ShadowReport;
  orchestrationHash: string;
}

const REQUEST_KEYS = ["schemaVersion", "comparisonId", "primaryArtifact", "shadowArtifact"] as const;
const ARTIFACT_KEYS = ["schemaVersion", "artifactId", "exportedAt", "sourceInput", "candidatePool"] as const;
const SOURCE_INPUT_KEYS = ["promptHash", "selectionPlanHash", "storefront", "targetTrackCount"] as const;

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const missing = keys.filter((key) => !(key in value));
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`${path} has invalid keys (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`);
  }
}

function string(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${path} must be a non-empty string no longer than ${maximum} characters`);
  }
  return value.trim();
}

function digest(value: unknown, path: string): string {
  const normalized = string(value, path, 64);
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(`${path} must be a lowercase SHA-256 digest`);
  return normalized;
}

function timestamp(value: unknown, path: string): string {
  const normalized = string(value, path, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(normalized)
    || !Number.isFinite(Date.parse(normalized))) {
    throw new Error(`${path} must be an ISO-8601 UTC timestamp`);
  }
  return normalized;
}

function parseSourceInput(value: unknown, path: string): PipelineShadowSourceInput {
  const input = object(value, path);
  exactKeys(input, SOURCE_INPUT_KEYS, path);
  const storefront = string(input.storefront, `${path}.storefront`, 3).toLowerCase();
  if (!/^[a-z]{2}$/u.test(storefront)) throw new Error(`${path}.storefront must be a two-letter code`);
  if (!Number.isInteger(input.targetTrackCount)
    || Number(input.targetTrackCount) < 1
    || Number(input.targetTrackCount) > EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS) {
    throw new Error(
      `${path}.targetTrackCount must be an integer from 1 to ${EXECUTABLE_PLAYLIST_MAXIMUM_TRACKS}`,
    );
  }
  return {
    promptHash: digest(input.promptHash, `${path}.promptHash`),
    selectionPlanHash: digest(input.selectionPlanHash, `${path}.selectionPlanHash`),
    storefront,
    targetTrackCount: Number(input.targetTrackCount),
  };
}

function parseArtifact(
  value: unknown,
  path: string,
  expectedVersion: ShadowPipelineVersion,
): PipelineShadowRunArtifact {
  const artifact = object(value, path);
  exactKeys(artifact, ARTIFACT_KEYS, path);
  if (artifact.schemaVersion !== PIPELINE_SHADOW_RUN_ARTIFACT_SCHEMA) {
    throw new Error(`${path}.schemaVersion is unsupported`);
  }
  const pool = object(artifact.candidatePool, `${path}.candidatePool`);
  if (pool.pipelineVersion !== expectedVersion) {
    throw new Error(`${path}.candidatePool.pipelineVersion must be ${expectedVersion}`);
  }
  return {
    schemaVersion: PIPELINE_SHADOW_RUN_ARTIFACT_SCHEMA,
    artifactId: string(artifact.artifactId, `${path}.artifactId`, 160),
    exportedAt: timestamp(artifact.exportedAt, `${path}.exportedAt`),
    sourceInput: parseSourceInput(artifact.sourceInput, `${path}.sourceInput`),
    // The manifest evaluator below validates this pool's exact schema and
    // every candidate field before it can generate either manifest.
    candidatePool: artifact.candidatePool as ShadowCandidatePool,
  };
}

function assertSameInput(
  primary: PipelineShadowSourceInput,
  shadow: PipelineShadowSourceInput,
): void {
  for (const key of SOURCE_INPUT_KEYS) {
    if (primary[key] !== shadow[key]) throw new Error(`shadow artifacts do not share the same ${key}`);
  }
}

/**
 * Pure persisted-artifact orchestration boundary. Both pipeline artifacts must
 * describe the exact same immutable input. The only downstream capability is
 * pure manifest comparison; no repository, provider, token, or publisher can
 * be injected through this strict schema.
 */
export function orchestratePipelineV2ManifestShadow(value: unknown): PipelineV2ShadowOrchestrationReport {
  const request = object(value, "shadow orchestration request");
  exactKeys(request, REQUEST_KEYS, "shadow orchestration request");
  if (request.schemaVersion !== PIPELINE_V2_SHADOW_ORCHESTRATION_SCHEMA) {
    throw new Error("Unsupported Pipeline V2 shadow-orchestration schema");
  }
  const comparisonId = string(request.comparisonId, "shadow orchestration request.comparisonId", 160);
  const primaryArtifact = parseArtifact(request.primaryArtifact, "primary artifact", "legacy_v1");
  const shadowArtifact = parseArtifact(request.shadowArtifact, "shadow artifact", "catalog_first_v2");
  assertSameInput(primaryArtifact.sourceInput, shadowArtifact.sourceInput);
  const generatedAt = primaryArtifact.exportedAt > shadowArtifact.exportedAt
    ? primaryArtifact.exportedAt
    : shadowArtifact.exportedAt;
  const manifestComparison = evaluatePipelineV2ManifestShadow({
    schemaVersion: PIPELINE_V2_SHADOW_INPUT_SCHEMA,
    comparisonId,
    generatedAt,
    promptHash: primaryArtifact.sourceInput.promptHash,
    storefront: primaryArtifact.sourceInput.storefront,
    targetTrackCount: primaryArtifact.sourceInput.targetTrackCount,
    primary: primaryArtifact.candidatePool,
    shadow: shadowArtifact.candidatePool,
  });
  const unsigned: Omit<PipelineV2ShadowOrchestrationReport, "orchestrationHash"> = {
    schemaVersion: PIPELINE_V2_SHADOW_ORCHESTRATION_REPORT_SCHEMA,
    comparisonId,
    executionMode: "persisted_artifact_manifest_only",
    publicationCapability: "absent",
    sourceInput: { ...primaryArtifact.sourceInput },
    primaryArtifactId: primaryArtifact.artifactId,
    shadowArtifactId: shadowArtifact.artifactId,
    manifestComparison,
  };
  return {
    ...unsigned,
    orchestrationHash: sha256Hex(stableStringify(unsigned)),
  };
}
