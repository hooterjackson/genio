import { describe, expect, test } from "vitest";
import {
  evaluateSemanticRankingReviewV1,
  semanticRankingBlindMappingSha256,
  semanticRankingBlindedPackageSha256,
  semanticRankingProtectedBaselineMetadataSha256,
  semanticRankingReviewBaselineIdentityV2,
  validateSemanticRankingReviewBindingsV2,
  type SemanticRankingBlindMappingV1,
  type SemanticRankingBlindScorecardV1,
  type SemanticRankingBlindedPackageV1,
  type SemanticRankingProtectedBaselineMetadataV1,
  type SemanticRankingReviewArtifactV1,
  type SemanticRankingReviewScoresV1,
} from "../lib/semantic-ranking-review.ts";

const candidateRevision = "a".repeat(40);
const baselineRevision = "b".repeat(40);
const candidateImageDigest = `sha256:${"c".repeat(64)}`;
const baselineImageDigest = `sha256:${"d".repeat(64)}`;
const fixtureIds = [
  "fixed-three-track-control-v1",
  "smooth-reggaeton-heat-50-v1",
  "french-jazz-guided-constraint-25-v1",
] as const;

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

const digest = (value: string): string => value.repeat(64);

function protectedBaseline(): SemanticRankingProtectedBaselineMetadataV1 {
  return {
    schemaVersion: "genio-semantic-ranking-protected-baseline/v2",
    rcTag: "v2.3.9-rc.2",
    stableTag: "v2.3.9",
    version: "2.3.9",
    sourceRevision: baselineRevision,
    imageDigest: baselineImageDigest,
    imageReference:
      `ghcr.io/hooterjackson/genio@${baselineImageDigest}`,
    finalizationEvidencePayloadHash: digest("e"),
    finalBrowserGateEvidenceHash: digest("f"),
    fixtures: fixtureIds.map((fixtureId, index) => ({
      fixtureId,
      orderedManifestHash: digest(String(index + 1)),
      outputHash: digest(String(index + 4)),
    })),
  };
}

function blindedInputs() {
  const baseline = protectedBaseline();
  const candidateOutputs = fixtureIds.map((fixtureId, index) => ({
    fixtureId,
    orderedManifestHash: digest(["7", "8", "9"][index]!),
    outputHash: digest(["a", "b", "c"][index]!),
  }));
  const blindedPackage: SemanticRankingBlindedPackageV1 = {
    schemaVersion: "genio-semantic-ranking-blinded-package/v1",
    randomizationId: "QWxhZGRpbjpvcGVuIHNlc2FtZQ",
    fixtures: fixtureIds.map((fixtureId, index) => {
      const baselineArm = {
        blindLabel: `baselineBlindArm_${index}_8Ywq`,
        orderedManifestHash: baseline.fixtures[index]!.orderedManifestHash,
        outputHash: baseline.fixtures[index]!.outputHash,
      };
      const candidateArm = {
        blindLabel: `candidateBlindArm_${index}_4KpZ`,
        orderedManifestHash: candidateOutputs[index]!.orderedManifestHash,
        outputHash: candidateOutputs[index]!.outputHash,
      };
      return {
        fixtureId,
        arms: (index % 2 === 0
          ? [candidateArm, baselineArm]
          : [baselineArm, candidateArm]) as [
            typeof baselineArm,
            typeof candidateArm,
          ],
      };
    }),
  };
  const baselineMetadataHash =
    semanticRankingProtectedBaselineMetadataSha256(baseline);
  const blindedPackageHash =
    semanticRankingBlindedPackageSha256(blindedPackage);
  const blindMapping: SemanticRankingBlindMappingV1 = {
    schemaVersion: "genio-semantic-ranking-blind-mapping/v1",
    blindedPackageHash,
    baselineMetadataHash,
    candidate: {
      sourceRevision: candidateRevision,
      imageDigest: candidateImageDigest,
    },
    fixtures: fixtureIds.map((fixtureId, index) => ({
      fixtureId,
      baselineBlindLabel: `baselineBlindArm_${index}_8Ywq`,
      candidateBlindLabel: `candidateBlindArm_${index}_4KpZ`,
    })),
  };
  return {
    baseline,
    candidateOutputs,
    blindedPackage,
    blindMapping,
    baselineMetadataHash,
    blindedPackageHash,
  };
}

function artifact(
  candidateScores: readonly SemanticRankingReviewScoresV1[],
  baselineScores: readonly SemanticRankingReviewScoresV1[] = candidateScores,
): {
  artifact: SemanticRankingReviewArtifactV1;
  protectedBaselineMetadata: SemanticRankingProtectedBaselineMetadataV1;
  blindedPackage: SemanticRankingBlindedPackageV1;
  blindScorecard: SemanticRankingBlindScorecardV1;
  blindMapping: SemanticRankingBlindMappingV1;
  approvedBaselineMetadataSha256: string;
} {
  const inputs = blindedInputs();
  const reviewedAt = "2026-07-23T12:00:00.000Z";
  const blindScorecard: SemanticRankingBlindScorecardV1 = {
    schemaVersion: "genio-semantic-ranking-blind-scorecard/v1",
    blindedPackageHash: inputs.blindedPackageHash,
    reviewedAt,
    fixtures: inputs.blindedPackage.fixtures.map((fixture, index) => {
      const mapping = inputs.blindMapping.fixtures[index]!;
      return {
        fixtureId: fixture.fixtureId,
        arms: fixture.arms.map((arm) => ({
          ...arm,
          scores: arm.blindLabel === mapping.baselineBlindLabel
            ? baselineScores[index]!
            : candidateScores[index]!,
        })) as [
          SemanticRankingBlindScorecardV1["fixtures"][number]["arms"][number],
          SemanticRankingBlindScorecardV1["fixtures"][number]["arms"][number],
        ],
      };
    }),
  };
  return {
    artifact: {
      schemaVersion: "genio-semantic-ranking-review/v2",
      blinded: true,
      independentReviewerAttested: true,
      candidate: {
        sourceRevision: candidateRevision,
        imageDigest: candidateImageDigest,
      },
      baseline: semanticRankingReviewBaselineIdentityV2(inputs.baseline),
      blinding: {
        blindedPackageHash: inputs.blindedPackageHash,
        blindMappingHash:
          semanticRankingBlindMappingSha256(inputs.blindMapping),
      },
      reviewedAt,
      pairs: candidateScores.map((candidate, index) => ({
        fixtureId: fixtureIds[index]!,
        baseline: {
          scores: baselineScores[index]!,
          orderedManifestHash:
            inputs.baseline.fixtures[index]!.orderedManifestHash,
          outputHash: inputs.baseline.fixtures[index]!.outputHash,
        },
        candidate: {
          scores: candidate,
          orderedManifestHash:
            inputs.candidateOutputs[index]!.orderedManifestHash,
          outputHash: inputs.candidateOutputs[index]!.outputHash,
        },
      })),
    },
    protectedBaselineMetadata: inputs.baseline,
    blindedPackage: inputs.blindedPackage,
    blindScorecard,
    blindMapping: inputs.blindMapping,
    approvedBaselineMetadataSha256: inputs.baselineMetadataHash,
  };
}

function validateBindings(
  value: ReturnType<typeof artifact>,
): ReturnType<typeof validateSemanticRankingReviewBindingsV2> {
  return validateSemanticRankingReviewBindingsV2({
    ...value,
    expectedCandidate: {
      sourceRevision: candidateRevision,
      imageDigest: candidateImageDigest,
    },
  });
}

describe("semantic and ranking paired-review release gate", () => {
  test("passes an exact protected prior release and binds both blinded output arms", () => {
    const value = artifact([
      score(4),
      score(5),
      score(4),
    ], [
      score(4),
      score(4),
      score(4),
    ]);
    expect(validateBindings(value).artifact).toEqual(value.artifact);
    const result = evaluateSemanticRankingReviewV1(value.artifact);
    expect(result).toMatchObject({
      passed: true,
      pairCount: 3,
      candidateMedians: score(4),
      baselineMedians: score(4),
      reasonCodes: [],
    });
    expect(result.evidenceHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("fails every per-fixture score drop even when cross-fixture medians improve", () => {
    const value = artifact([
      score(1),
      score(5),
      score(5),
    ], [
      score(5),
      score(4),
      score(4),
    ]);
    expect(evaluateSemanticRankingReviewV1(value.artifact)).toMatchObject({
      passed: false,
      candidateMedians: score(5),
      baselineMedians: score(4),
      reasonCodes: expect.arrayContaining([
        "fixture_dimension_regression:fixed-three-track-control-v1:relevance",
        "fixture_dimension_regression:fixed-three-track-control-v1:sequencing",
      ]),
    });
  });

  test("fails a sub-four candidate median or any median regression", () => {
    const value = artifact([
      score(3),
      score(3),
      score(5),
    ], [
      score(4),
      score(4),
      score(4),
    ]);
    expect(evaluateSemanticRankingReviewV1(value.artifact)).toMatchObject({
      passed: false,
      reasonCodes: expect.arrayContaining([
        "candidate_median_below_four:relevance",
        "material_median_regression:sequencing",
      ]),
    });
  });

  test("rejects an arbitrary baseline, swapped outputs, and a tampered mapping", () => {
    const value = artifact([score(4), score(4), score(4)]);
    expect(() => validateSemanticRankingReviewBindingsV2({
      ...value,
      approvedBaselineMetadataSha256: digest("f"),
      expectedCandidate: {
        sourceRevision: candidateRevision,
        imageDigest: candidateImageDigest,
      },
    })).toThrow(/protected baseline and exact blinded outputs/u);

    const swapped = structuredClone(value);
    const first = swapped.artifact.pairs[0]!;
    (first.candidate as { orderedManifestHash: string }).orderedManifestHash =
      first.baseline.orderedManifestHash;
    expect(() => validateBindings(swapped))
      .toThrow(/protected baseline and exact blinded outputs/u);

    const tampered = structuredClone(value);
    const mappingFixture = tampered.blindMapping.fixtures[0]!;
    const baselineBlindLabel = mappingFixture.baselineBlindLabel;
    (mappingFixture as { baselineBlindLabel: string }).baselineBlindLabel =
      mappingFixture.candidateBlindLabel;
    (mappingFixture as { candidateBlindLabel: string }).candidateBlindLabel =
      baselineBlindLabel;
    tampered.artifact.blinding.blindMappingHash =
      semanticRankingBlindMappingSha256(tampered.blindMapping);
    expect(() => validateBindings(tampered))
      .toThrow(/protected baseline and exact blinded outputs/u);

    const transposedScores = structuredClone(value);
    transposedScores.artifact.pairs[0]!.candidate.scores = score(5);
    expect(() => validateBindings(transposedScores))
      .toThrow(/protected baseline and exact blinded outputs/u);

    const tamperedScorecard = structuredClone(value);
    tamperedScorecard.blindScorecard.fixtures[0]!.arms[0]!.outputHash =
      digest("f");
    expect(() => validateBindings(tamperedScorecard))
      .toThrow(/blind scorecard does not bind the exact blinded package/u);
  });

  test("rejects unblinded, self-attested, undersized, or identifier-bearing review artifacts", () => {
    const value = artifact([score(4), score(4), score(4)]);
    const valid = value.artifact;
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
    })).toThrow(/privacy-safe fixture ID/u);
  });
});
