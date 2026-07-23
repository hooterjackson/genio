import { createHash } from "node:crypto";

export const SEMANTIC_RANKING_REVIEW_SCHEMA_V1 =
  "genio-semantic-ranking-review/v1" as const;

export const SEMANTIC_RANKING_REVIEW_DIMENSIONS = [
  "relevance",
  "discoveryQuality",
  "coherence",
  "sequencing",
] as const;

export type SemanticRankingReviewDimensionV1 =
  typeof SEMANTIC_RANKING_REVIEW_DIMENSIONS[number];

export interface SemanticRankingReviewScoresV1 {
  relevance: number;
  discoveryQuality: number;
  coherence: number;
  sequencing: number;
}

export interface SemanticRankingReviewPairV1 {
  /** Safe identifier for an explicitly marked QA fixture, never a raw prompt. */
  fixtureId: string;
  baseline: SemanticRankingReviewScoresV1;
  candidate: SemanticRankingReviewScoresV1;
}

export interface SemanticRankingReviewArtifactV1 {
  schemaVersion: typeof SEMANTIC_RANKING_REVIEW_SCHEMA_V1;
  blinded: true;
  independentReviewerAttested: true;
  sourceRevision: string;
  baselineRevision: string;
  reviewedAt: string;
  pairs: readonly SemanticRankingReviewPairV1[];
}

export interface SemanticRankingReviewReportV1 {
  schemaVersion: typeof SEMANTIC_RANKING_REVIEW_SCHEMA_V1;
  passed: boolean;
  pairCount: number;
  candidateMedians: SemanticRankingReviewScoresV1;
  baselineMedians: SemanticRankingReviewScoresV1;
  reasonCodes: string[];
  evidenceHash: string;
}

const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const FIXTURE_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{2,79}$/u;

function score(value: number): boolean {
  return Number.isFinite(value) && value >= 1 && value <= 5;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, ordered(item)]),
  );
}

function evidenceHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
}

/**
 * Evaluate the release's blinded paired review without retaining prompts,
 * reviewer identity, or playlist/run IDs. Three pairs correspond to the
 * required fixed control, affected regression, and guided constraint canaries.
 */
export function evaluateSemanticRankingReviewV1(
  artifact: SemanticRankingReviewArtifactV1,
): SemanticRankingReviewReportV1 {
  if (artifact.schemaVersion !== SEMANTIC_RANKING_REVIEW_SCHEMA_V1
    || artifact.blinded !== true
    || artifact.independentReviewerAttested !== true
    || !REVISION.test(artifact.sourceRevision)
    || !REVISION.test(artifact.baselineRevision)
    || artifact.sourceRevision === artifact.baselineRevision
    || !Number.isFinite(Date.parse(artifact.reviewedAt))
    || new Date(Date.parse(artifact.reviewedAt)).toISOString() !== artifact.reviewedAt
    || artifact.pairs.length < 3
    || new Set(artifact.pairs.map(({ fixtureId }) => fixtureId)).size !== artifact.pairs.length
    || artifact.pairs.some(({ fixtureId, baseline, candidate }) => (
      !FIXTURE_ID.test(fixtureId)
      || SEMANTIC_RANKING_REVIEW_DIMENSIONS.some((dimension) => (
        !score(baseline[dimension]) || !score(candidate[dimension])
      ))
    ))) {
    throw new Error("invalid_semantic_ranking_review_artifact");
  }
  const baselineMedians = Object.fromEntries(
    SEMANTIC_RANKING_REVIEW_DIMENSIONS.map((dimension) => [
      dimension,
      median(artifact.pairs.map(({ baseline }) => baseline[dimension])),
    ]),
  ) as unknown as SemanticRankingReviewScoresV1;
  const candidateMedians = Object.fromEntries(
    SEMANTIC_RANKING_REVIEW_DIMENSIONS.map((dimension) => [
      dimension,
      median(artifact.pairs.map(({ candidate }) => candidate[dimension])),
    ]),
  ) as unknown as SemanticRankingReviewScoresV1;
  const reasonCodes = SEMANTIC_RANKING_REVIEW_DIMENSIONS.flatMap((dimension) => [
    ...(candidateMedians[dimension] < 4
      ? [`candidate_median_below_four:${dimension}`]
      : []),
    ...(candidateMedians[dimension] < baselineMedians[dimension]
      ? [`material_median_regression:${dimension}`]
      : []),
  ]);
  const body = {
    schemaVersion: SEMANTIC_RANKING_REVIEW_SCHEMA_V1,
    passed: reasonCodes.length === 0,
    pairCount: artifact.pairs.length,
    candidateMedians,
    baselineMedians,
    reasonCodes,
  };
  return {
    ...body,
    evidenceHash: evidenceHash({ artifact, report: body }),
  };
}
