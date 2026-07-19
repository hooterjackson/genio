import { sha256Hex, stableStringify } from "./security.ts";

export const PIPELINE_V2_SHADOW_INPUT_SCHEMA = "genio-pipeline-v2-shadow-input/v1" as const;
export const PIPELINE_V2_SHADOW_REPORT_SCHEMA = "genio-pipeline-v2-shadow-report/v1" as const;

export type ShadowPipelineVersion = "legacy_v1" | "catalog_first_v2";

export interface ShadowManifestCandidate {
  rank: number;
  candidateId: string;
  appleSongId: string;
  recordingFamilyKey: string;
  artist: string;
  title: string;
  scopeBindingIds: string[];
  includeInManifest: boolean;
  evidenceEligible: boolean;
  hardConstraintsSatisfied: boolean;
  versionCompatible: boolean;
  storefrontPlayable: boolean;
}

export interface ShadowCandidatePool {
  pipelineVersion: ShadowPipelineVersion;
  policyVersion: string;
  modelSnapshot: string;
  sourceRunId: string;
  candidates: ShadowManifestCandidate[];
}

export interface PipelineV2ShadowInput {
  schemaVersion: typeof PIPELINE_V2_SHADOW_INPUT_SCHEMA;
  comparisonId: string;
  generatedAt: string;
  promptHash: string;
  storefront: string;
  targetTrackCount: number;
  primary: ShadowCandidatePool;
  shadow: ShadowCandidatePool;
}

export interface ShadowManifestTrack {
  position: number;
  candidateId: string;
  appleSongId: string;
  recordingFamilyKey: string;
  artist: string;
  title: string;
  scopeBindingIds: string[];
}

export interface GeneratedShadowManifest {
  pipelineVersion: ShadowPipelineVersion;
  sourceRunId: string;
  contentHash: string;
  targetTrackCount: number;
  trackCount: number;
  exactCountSatisfied: boolean;
  tracks: ShadowManifestTrack[];
}

export interface PipelineV2ShadowReport {
  schemaVersion: typeof PIPELINE_V2_SHADOW_REPORT_SCHEMA;
  comparisonId: string;
  generatedAt: string;
  promptHash: string;
  storefront: string;
  targetTrackCount: number;
  executionMode: "manifest_only";
  publicationCapability: "absent";
  primary: GeneratedShadowManifest;
  shadow: GeneratedShadowManifest;
  comparison: {
    primaryTrackCount: number;
    shadowTrackCount: number;
    trackCountDelta: number;
    sharedAppleSongCount: number;
    appleSongOverlapRatio: number;
    sharedRecordingFamilyCount: number;
    recordingFamilyOverlapRatio: number;
    addedAppleSongIds: string[];
    removedAppleSongIds: string[];
    shadowEvidenceCoverage: number;
  };
  releaseDisposition: "independent_review_required";
  reportHash: string;
}

const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "comparisonId",
  "generatedAt",
  "promptHash",
  "storefront",
  "targetTrackCount",
  "primary",
  "shadow",
] as const;
const POOL_KEYS = ["pipelineVersion", "policyVersion", "modelSnapshot", "sourceRunId", "candidates"] as const;
const CANDIDATE_KEYS = [
  "rank",
  "candidateId",
  "appleSongId",
  "recordingFamilyKey",
  "artist",
  "title",
  "scopeBindingIds",
  "includeInManifest",
  "evidenceEligible",
  "hardConstraintsSatisfied",
  "versionCompatible",
  "storefrontPlayable",
] as const;

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const missing = allowed.filter((key) => !(key in record));
  const extra = Object.keys(record).filter((key) => !allowed.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${path} has invalid keys (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
    );
  }
}

function boundedString(value: unknown, path: string, maximum = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${path} must be a non-empty string no longer than ${maximum} characters`);
  }
  return value.trim();
}

function sha256(value: unknown, path: string): string {
  const result = boundedString(value, path, 64);
  if (!/^[0-9a-f]{64}$/u.test(result)) throw new Error(`${path} must be a lowercase SHA-256 digest`);
  return result;
}

function timestamp(value: unknown, path: string): string {
  const result = boundedString(value, path, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(result)
    || !Number.isFinite(Date.parse(result))) {
    throw new Error(`${path} must be an ISO-8601 UTC timestamp`);
  }
  return result;
}

function positiveInteger(value: unknown, path: string, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${path} must be an integer from 1 to ${maximum}`);
  }
  return Number(value);
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`${path} must contain at most 100 strings`);
  }
  const result = value.map((item, index) => boundedString(item, `${path}[${index}]`, 160));
  if (new Set(result).size !== result.length) throw new Error(`${path} contains duplicates`);
  return result;
}

function parseCandidate(value: unknown, path: string): ShadowManifestCandidate {
  const candidate = asObject(value, path);
  exactKeys(candidate, CANDIDATE_KEYS, path);
  return {
    rank: positiveInteger(candidate.rank, `${path}.rank`, 100_000),
    candidateId: boundedString(candidate.candidateId, `${path}.candidateId`, 160),
    appleSongId: boundedString(candidate.appleSongId, `${path}.appleSongId`, 160),
    recordingFamilyKey: boundedString(candidate.recordingFamilyKey, `${path}.recordingFamilyKey`, 300),
    artist: boundedString(candidate.artist, `${path}.artist`, 500),
    title: boundedString(candidate.title, `${path}.title`, 500),
    scopeBindingIds: strings(candidate.scopeBindingIds, `${path}.scopeBindingIds`),
    includeInManifest: booleanValue(candidate.includeInManifest, `${path}.includeInManifest`),
    evidenceEligible: booleanValue(candidate.evidenceEligible, `${path}.evidenceEligible`),
    hardConstraintsSatisfied: booleanValue(candidate.hardConstraintsSatisfied, `${path}.hardConstraintsSatisfied`),
    versionCompatible: booleanValue(candidate.versionCompatible, `${path}.versionCompatible`),
    storefrontPlayable: booleanValue(candidate.storefrontPlayable, `${path}.storefrontPlayable`),
  };
}

function parsePool(value: unknown, path: string, expectedVersion: ShadowPipelineVersion): ShadowCandidatePool {
  const pool = asObject(value, path);
  exactKeys(pool, POOL_KEYS, path);
  if (pool.pipelineVersion !== expectedVersion) {
    throw new Error(`${path}.pipelineVersion must be ${expectedVersion}`);
  }
  if (!Array.isArray(pool.candidates) || pool.candidates.length > 10_000) {
    throw new Error(`${path}.candidates must contain at most 10,000 candidates`);
  }
  const candidates = pool.candidates.map((candidate, index) => parseCandidate(candidate, `${path}.candidates[${index}]`));
  const ranks = candidates.map(({ rank }) => rank);
  const candidateIds = candidates.map(({ candidateId }) => candidateId);
  if (new Set(ranks).size !== ranks.length) throw new Error(`${path}.candidates contains duplicate ranks`);
  if (new Set(candidateIds).size !== candidateIds.length) throw new Error(`${path}.candidates contains duplicate candidate IDs`);
  return {
    pipelineVersion: expectedVersion,
    policyVersion: boundedString(pool.policyVersion, `${path}.policyVersion`, 120),
    modelSnapshot: boundedString(pool.modelSnapshot, `${path}.modelSnapshot`, 160),
    sourceRunId: boundedString(pool.sourceRunId, `${path}.sourceRunId`, 160),
    candidates,
  };
}

export function parsePipelineV2ShadowInput(value: unknown): PipelineV2ShadowInput {
  const input = asObject(value, "shadow input");
  exactKeys(input, TOP_LEVEL_KEYS, "shadow input");
  if (input.schemaVersion !== PIPELINE_V2_SHADOW_INPUT_SCHEMA) {
    throw new Error("Unsupported Pipeline V2 shadow-input schema");
  }
  const storefront = boundedString(input.storefront, "shadow input.storefront", 3).toLowerCase();
  if (!/^[a-z]{2}$/u.test(storefront)) throw new Error("shadow input.storefront must be a two-letter storefront");
  return {
    schemaVersion: PIPELINE_V2_SHADOW_INPUT_SCHEMA,
    comparisonId: boundedString(input.comparisonId, "shadow input.comparisonId", 160),
    generatedAt: timestamp(input.generatedAt, "shadow input.generatedAt"),
    promptHash: sha256(input.promptHash, "shadow input.promptHash"),
    storefront,
    targetTrackCount: positiveInteger(input.targetTrackCount, "shadow input.targetTrackCount", 300),
    primary: parsePool(input.primary, "shadow input.primary", "legacy_v1"),
    shadow: parsePool(input.shadow, "shadow input.shadow", "catalog_first_v2"),
  };
}

function manifestContentHash(tracks: readonly ShadowManifestTrack[]): string {
  return sha256Hex(JSON.stringify(tracks.map((track, index) => [
    index,
    track.candidateId,
    track.appleSongId,
  ])));
}

function generateManifest(
  pool: ShadowCandidatePool,
  targetTrackCount: number,
): GeneratedShadowManifest {
  const included = pool.candidates
    .filter(({ includeInManifest }) => includeInManifest)
    .sort((left, right) => left.rank - right.rank);

  if (included.length > targetTrackCount) {
    throw new Error(`${pool.pipelineVersion} manifest exceeds the immutable requested target`);
  }
  if (pool.pipelineVersion === "catalog_first_v2") {
    const unsafe = included.find((candidate) => (
      !candidate.evidenceEligible
      || !candidate.hardConstraintsSatisfied
      || !candidate.versionCompatible
      || !candidate.storefrontPlayable
      || candidate.scopeBindingIds.length === 0
    ));
    if (unsafe) {
      throw new Error(`catalog_first_v2 selected an ineligible candidate: ${unsafe.candidateId}`);
    }
  }
  const appleSongIds = included.map(({ appleSongId }) => appleSongId);
  if (new Set(appleSongIds).size !== appleSongIds.length) {
    throw new Error(`${pool.pipelineVersion} manifest contains duplicate Apple song IDs`);
  }
  const familyKeys = included.map(({ recordingFamilyKey }) => recordingFamilyKey);
  if (new Set(familyKeys).size !== familyKeys.length) {
    throw new Error(`${pool.pipelineVersion} manifest contains duplicate recording families`);
  }

  const tracks = included.map((candidate, position): ShadowManifestTrack => ({
    position,
    candidateId: candidate.candidateId,
    appleSongId: candidate.appleSongId,
    recordingFamilyKey: candidate.recordingFamilyKey,
    artist: candidate.artist,
    title: candidate.title,
    scopeBindingIds: [...candidate.scopeBindingIds],
  }));
  return {
    pipelineVersion: pool.pipelineVersion,
    sourceRunId: pool.sourceRunId,
    contentHash: manifestContentHash(tracks),
    targetTrackCount,
    trackCount: tracks.length,
    exactCountSatisfied: tracks.length === targetTrackCount,
    tracks,
  };
}

function overlapRatio(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  const denominator = Math.max(left.size, right.size);
  if (denominator === 0) return 1;
  let shared = 0;
  for (const value of left) if (right.has(value)) shared += 1;
  return shared / denominator;
}

function reportHash(report: Omit<PipelineV2ShadowReport, "reportHash">): string {
  return sha256Hex(stableStringify(report));
}

/**
 * Pure manifest-only shadow boundary.
 *
 * This function accepts immutable candidate-pool data, performs no I/O, and
 * exposes no publication dependency. It can compare V1 and V2 through manifest
 * generation without loading an Apple user token or creating an Apple playlist.
 * Independent relevance review remains mandatory before rollout promotion.
 */
export function evaluatePipelineV2ManifestShadow(value: unknown): PipelineV2ShadowReport {
  const input = parsePipelineV2ShadowInput(value);
  const primary = generateManifest(input.primary, input.targetTrackCount);
  const shadow = generateManifest(input.shadow, input.targetTrackCount);
  const primaryAppleIds = new Set(primary.tracks.map(({ appleSongId }) => appleSongId));
  const shadowAppleIds = new Set(shadow.tracks.map(({ appleSongId }) => appleSongId));
  const primaryFamilies = new Set(primary.tracks.map(({ recordingFamilyKey }) => recordingFamilyKey));
  const shadowFamilies = new Set(shadow.tracks.map(({ recordingFamilyKey }) => recordingFamilyKey));
  const sharedAppleSongCount = [...primaryAppleIds].filter((id) => shadowAppleIds.has(id)).length;
  const sharedRecordingFamilyCount = [...primaryFamilies].filter((id) => shadowFamilies.has(id)).length;
  const unsigned: Omit<PipelineV2ShadowReport, "reportHash"> = {
    schemaVersion: PIPELINE_V2_SHADOW_REPORT_SCHEMA,
    comparisonId: input.comparisonId,
    generatedAt: input.generatedAt,
    promptHash: input.promptHash,
    storefront: input.storefront,
    targetTrackCount: input.targetTrackCount,
    executionMode: "manifest_only",
    publicationCapability: "absent",
    primary,
    shadow,
    comparison: {
      primaryTrackCount: primary.trackCount,
      shadowTrackCount: shadow.trackCount,
      trackCountDelta: shadow.trackCount - primary.trackCount,
      sharedAppleSongCount,
      appleSongOverlapRatio: overlapRatio(primaryAppleIds, shadowAppleIds),
      sharedRecordingFamilyCount,
      recordingFamilyOverlapRatio: overlapRatio(primaryFamilies, shadowFamilies),
      addedAppleSongIds: [...shadowAppleIds].filter((id) => !primaryAppleIds.has(id)).sort(),
      removedAppleSongIds: [...primaryAppleIds].filter((id) => !shadowAppleIds.has(id)).sort(),
      shadowEvidenceCoverage: shadow.trackCount === 0
        ? 1
        : shadow.tracks.filter(({ scopeBindingIds }) => scopeBindingIds.length > 0).length / shadow.trackCount,
    },
    releaseDisposition: "independent_review_required",
  };
  return { ...unsigned, reportHash: reportHash(unsigned) };
}
