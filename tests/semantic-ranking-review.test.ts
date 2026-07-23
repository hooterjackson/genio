import { describe, expect, test } from "vitest";
import {
  evaluateSemanticRankingReviewV1,
  type SemanticRankingReviewArtifactV1,
  type SemanticRankingReviewScoresV1,
} from "../lib/semantic-ranking-review.ts";

const score = (
  value: number,
  overrides: Partial<SemanticRankingReviewScoresV1> = {},
): SemanticRankingReviewScoresV1 => ({
  relevance: value,
  discoveryQuality: value,
  coherence: value,
  sequencing: value,
  ...overrides,
});

function artifact(
  candidateScores: readonly SemanticRankingReviewScoresV1[],
  baselineScores: readonly SemanticRankingReviewScoresV1[] = candidateScores,
): SemanticRankingReviewArtifactV1 {
  return {
    schemaVersion: "genio-semantic-ranking-review/v1",
    blinded: true,
    independentReviewerAttested: true,
    sourceRevision: "a".repeat(40),
    baselineRevision: "b".repeat(40),
    reviewedAt: "2026-07-23T12:00:00.000Z",
    pairs: candidateScores.map((candidate, index) => ({
      fixtureId: `release-fixture-${index + 1}`,
      baseline: baselineScores[index]!,
      candidate,
    })),
  };
}

describe("semantic and ranking paired-review release gate", () => {
  test("passes only blinded independent pairs whose four candidate medians are at least 4 without regression", () => {
    const result = evaluateSemanticRankingReviewV1(artifact([
      score(4),
      score(5),
      score(4),
    ], [
      score(4),
      score(4),
      score(4),
    ]));
    expect(result).toMatchObject({
      passed: true,
      pairCount: 3,
      candidateMedians: score(4),
      baselineMedians: score(4),
      reasonCodes: [],
    });
    expect(result.evidenceHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("fails a sub-four candidate median or any median regression", () => {
    expect(evaluateSemanticRankingReviewV1(artifact([
      score(3),
      score(3),
      score(5),
    ], [
      score(4),
      score(4),
      score(4),
    ]))).toMatchObject({
      passed: false,
      reasonCodes: expect.arrayContaining([
        "candidate_median_below_four:relevance",
        "material_median_regression:sequencing",
      ]),
    });
  });

  test("rejects unblinded, self-attested, undersized, or identifier-bearing review artifacts", () => {
    const valid = artifact([score(4), score(4), score(4)]);
    expect(() => evaluateSemanticRankingReviewV1({
      ...valid,
      blinded: false,
    } as unknown as SemanticRankingReviewArtifactV1)).toThrow(
      "invalid_semantic_ranking_review_artifact",
    );
    expect(() => evaluateSemanticRankingReviewV1({
      ...valid,
      independentReviewerAttested: false,
    } as unknown as SemanticRankingReviewArtifactV1)).toThrow(
      "invalid_semantic_ranking_review_artifact",
    );
    expect(() => evaluateSemanticRankingReviewV1({
      ...valid,
      pairs: valid.pairs.slice(0, 2),
    })).toThrow("invalid_semantic_ranking_review_artifact");
    expect(() => evaluateSemanticRankingReviewV1({
      ...valid,
      pairs: [{
        ...valid.pairs[0]!,
        fixtureId: "raw prompt: make me a playlist",
      }, ...valid.pairs.slice(1)],
    })).toThrow("invalid_semantic_ranking_review_artifact");
  });
});
