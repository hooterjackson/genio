import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from "node:crypto";

export const SEMANTIC_RANKING_REVIEW_SCHEMA_V2 =
  "genio-semantic-ranking-review/v2" as const;
/**
 * Compatibility export for callers whose function/type names still carry V1.
 * The wire contract is intentionally V2-only and rejects legacy review files.
 */
export const SEMANTIC_RANKING_REVIEW_SCHEMA_V1 =
  SEMANTIC_RANKING_REVIEW_SCHEMA_V2;

export const SEMANTIC_RANKING_PROTECTED_BASELINE_SCHEMA_V1 =
  "genio-semantic-ranking-protected-baseline/v2" as const;
export const SEMANTIC_RANKING_BLINDED_PACKAGE_SCHEMA_V1 =
  "genio-semantic-ranking-blinded-package/v1" as const;
export const SEMANTIC_RANKING_BLIND_MAPPING_SCHEMA_V1 =
  "genio-semantic-ranking-blind-mapping/v1" as const;
export const SEMANTIC_RANKING_BLIND_SCORECARD_SCHEMA_V1 =
  "genio-semantic-ranking-blind-scorecard/v1" as const;

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

export interface SemanticRankingReviewOutputV2 {
  scores: SemanticRankingReviewScoresV1;
  orderedManifestHash: string;
  outputHash: string;
}

export interface SemanticRankingReviewPairV2 {
  /** Safe identifier for an explicitly marked QA fixture, never a raw prompt. */
  fixtureId: string;
  baseline: SemanticRankingReviewOutputV2;
  candidate: SemanticRankingReviewOutputV2;
}

export interface SemanticRankingProtectedBaselineFixtureV1 {
  fixtureId: string;
  orderedManifestHash: string;
  outputHash: string;
}

export interface SemanticRankingProtectedBaselineMetadataV1 {
  schemaVersion: typeof SEMANTIC_RANKING_PROTECTED_BASELINE_SCHEMA_V1;
  rcTag: string;
  stableTag: string;
  version: string;
  sourceRevision: string;
  imageDigest: string;
  imageReference: string;
  finalizationEvidencePayloadHash: string;
  finalBrowserGateEvidenceHash: string;
  fixtures: readonly SemanticRankingProtectedBaselineFixtureV1[];
}

export interface SemanticRankingReviewBaselineIdentityV2 {
  stableTag: string;
  version: string;
  sourceRevision: string;
  imageDigest: string;
  finalizationEvidencePayloadHash: string;
  metadataHash: string;
}

export interface SemanticRankingBlindedPackageArmV1 {
  blindLabel: string;
  orderedManifestHash: string;
  outputHash: string;
}

export interface SemanticRankingBlindedPackageFixtureV1 {
  fixtureId: string;
  arms: readonly [
    SemanticRankingBlindedPackageArmV1,
    SemanticRankingBlindedPackageArmV1,
  ];
}

export interface SemanticRankingBlindedPackageV1 {
  schemaVersion: typeof SEMANTIC_RANKING_BLINDED_PACKAGE_SCHEMA_V1;
  randomizationId: string;
  fixtures: readonly SemanticRankingBlindedPackageFixtureV1[];
}

export interface SemanticRankingBlindMappingFixtureV1 {
  fixtureId: string;
  baselineBlindLabel: string;
  candidateBlindLabel: string;
}

export interface SemanticRankingBlindMappingV1 {
  schemaVersion: typeof SEMANTIC_RANKING_BLIND_MAPPING_SCHEMA_V1;
  blindedPackageHash: string;
  baselineMetadataHash: string;
  candidate: {
    sourceRevision: string;
    imageDigest: string;
  };
  fixtures: readonly SemanticRankingBlindMappingFixtureV1[];
}

export interface SemanticRankingBlindScorecardArmV1 {
  blindLabel: string;
  orderedManifestHash: string;
  outputHash: string;
  scores: SemanticRankingReviewScoresV1;
}

export interface SemanticRankingBlindScorecardFixtureV1 {
  fixtureId: string;
  arms: readonly [
    SemanticRankingBlindScorecardArmV1,
    SemanticRankingBlindScorecardArmV1,
  ];
}

/**
 * The reviewer signs this artifact before receiving the blind mapping. Scores
 * therefore remain cryptographically attached to the exact blind labels and
 * output hashes that appeared in the review package.
 */
export interface SemanticRankingBlindScorecardV1 {
  schemaVersion: typeof SEMANTIC_RANKING_BLIND_SCORECARD_SCHEMA_V1;
  blindedPackageHash: string;
  reviewedAt: string;
  fixtures: readonly SemanticRankingBlindScorecardFixtureV1[];
}

export interface SemanticRankingReviewArtifactV2 {
  schemaVersion: typeof SEMANTIC_RANKING_REVIEW_SCHEMA_V2;
  blinded: true;
  independentReviewerAttested: true;
  candidate: {
    sourceRevision: string;
    imageDigest: string;
  };
  baseline: SemanticRankingReviewBaselineIdentityV2;
  blinding: {
    blindedPackageHash: string;
    blindMappingHash: string;
  };
  reviewedAt: string;
  pairs: readonly SemanticRankingReviewPairV2[];
}

export type SemanticRankingReviewPairV1 = SemanticRankingReviewPairV2;
export type SemanticRankingReviewArtifactV1 = SemanticRankingReviewArtifactV2;

export interface SemanticRankingReviewReportV1 {
  schemaVersion: typeof SEMANTIC_RANKING_REVIEW_SCHEMA_V2;
  passed: boolean;
  pairCount: number;
  candidateMedians: SemanticRankingReviewScoresV1;
  baselineMedians: SemanticRankingReviewScoresV1;
  reasonCodes: string[];
  evidenceHash: string;
}

export const SEMANTIC_RANKING_REVIEWER_ATTESTATION_SCHEMA_V2 =
  "genio-semantic-ranking-reviewer-attestation/v3" as const;
export const SEMANTIC_RANKING_REVIEWER_ATTESTATION_SCHEMA_V1 =
  SEMANTIC_RANKING_REVIEWER_ATTESTATION_SCHEMA_V2;

export interface SemanticRankingReviewerAttestationV1 {
  schemaVersion: typeof SEMANTIC_RANKING_REVIEWER_ATTESTATION_SCHEMA_V1;
  blindScorecardHash: string;
  reviewerVerificationKeySha256: string;
  signature: {
    algorithm: "Ed25519";
    keyId: string;
    value: string;
  };
}

export interface SemanticRankingReviewerVerificationKeyV1 {
  schemaVersion: "genio-semantic-ranking-reviewer-verification-key/v1";
  algorithm: "Ed25519";
  format: "spki-der";
  value: string;
  sha256: string;
}

export interface SemanticRankingReviewerTrustPolicyV1 {
  schemaVersion: "genio-semantic-ranking-reviewer-trust-policy/v3";
  approvedKeyId: string;
  approvedKeySha256: string;
  approvedBaselineMetadataSha256: string;
  approvedBaselineStableTag: string;
  approvedBaselineReleaseKeySha256: string;
  approvedBaselineStableAuthorizerKeyId: string;
  approvedBaselineStableAuthorizerKeySha256: string;
}

const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_REFERENCE =
  /^ghcr\.io\/[0-9a-z](?:[0-9a-z._/-]*[0-9a-z])?@sha256:[0-9a-f]{64}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const RC_TAG =
  /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-rc\.[1-9]\d*$/u;
const FIXTURE_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{2,79}$/u;
const BLIND_LABEL = /^[0-9A-Za-z_-]{16,86}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:-]{2,79}$/u;
const STABLE_KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u;
const SIGNATURE_VALUE = /^[0-9A-Za-z_-]{64,256}$/u;
const SCORE_KEYS = [
  "relevance",
  "discoveryQuality",
  "coherence",
  "sequencing",
] as const;

type JsonRecord = Record<string, unknown>;

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as JsonRecord;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} contains missing or unapproved fields`);
  }
  return record;
}

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

export function semanticRankingReviewSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
}

function exactScores(
  value: unknown,
  label: string,
): SemanticRankingReviewScoresV1 {
  const scores = exactRecord(value, SCORE_KEYS, label);
  if (SCORE_KEYS.some((dimension) => (
    typeof scores[dimension] !== "number" || !score(scores[dimension])
  ))) {
    throw new Error("invalid_semantic_ranking_review_artifact");
  }
  return Object.fromEntries(SCORE_KEYS.map((dimension) => [
    dimension,
    scores[dimension],
  ])) as unknown as SemanticRankingReviewScoresV1;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function revision(value: unknown, label: string): string {
  if (typeof value !== "string" || !REVISION.test(value)) {
    throw new Error(`${label} must be a full Git revision`);
  }
  return value;
}

function imageDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !IMAGE_DIGEST.test(value)) {
    throw new Error(`${label} must be an immutable image digest`);
  }
  return value;
}

function version(value: unknown, label: string): string {
  if (typeof value !== "string" || !VERSION.test(value)) {
    throw new Error(`${label} must be a semantic version`);
  }
  return value;
}

function fixtureId(value: unknown, label: string): string {
  if (typeof value !== "string" || !FIXTURE_ID.test(value)) {
    throw new Error(`${label} must be a privacy-safe fixture ID`);
  }
  return value;
}

function blindLabel(value: unknown, label: string): string {
  if (typeof value !== "string" || !BLIND_LABEL.test(value)) {
    throw new Error(`${label} must be a randomized blind label`);
  }
  return value;
}

function exactOutput(
  value: unknown,
  label: string,
): SemanticRankingReviewOutputV2 {
  const output = exactRecord(
    value,
    ["scores", "orderedManifestHash", "outputHash"],
    label,
  );
  return {
    scores: exactScores(output.scores, `${label} scores`),
    orderedManifestHash: sha256(
      output.orderedManifestHash,
      `${label} orderedManifestHash`,
    ),
    outputHash: sha256(output.outputHash, `${label} outputHash`),
  };
}

function exactCandidateIdentity(
  value: unknown,
  label: string,
): SemanticRankingReviewArtifactV2["candidate"] {
  const candidate = exactRecord(
    value,
    ["sourceRevision", "imageDigest"],
    label,
  );
  return {
    sourceRevision: revision(
      candidate.sourceRevision,
      `${label}.sourceRevision`,
    ),
    imageDigest: imageDigest(candidate.imageDigest, `${label}.imageDigest`),
  };
}

export function validateSemanticRankingProtectedBaselineMetadataV1(
  value: unknown,
): SemanticRankingProtectedBaselineMetadataV1 {
  const metadata = exactRecord(value, [
    "schemaVersion",
    "rcTag",
    "stableTag",
    "version",
    "sourceRevision",
    "imageDigest",
    "imageReference",
    "finalizationEvidencePayloadHash",
    "finalBrowserGateEvidenceHash",
    "fixtures",
  ], "semantic ranking protected baseline metadata");
  const releaseVersion = version(
    metadata.version,
    "semantic ranking protected baseline metadata.version",
  );
  const rcMatch = typeof metadata.rcTag === "string"
    ? RC_TAG.exec(metadata.rcTag)
    : null;
  if (
    metadata.schemaVersion !== SEMANTIC_RANKING_PROTECTED_BASELINE_SCHEMA_V1
    || !rcMatch
    || rcMatch[1] !== releaseVersion
    || metadata.stableTag !== `v${releaseVersion}`
    || typeof metadata.imageReference !== "string"
    || !IMAGE_REFERENCE.test(metadata.imageReference)
    || typeof metadata.imageDigest !== "string"
    || !IMAGE_DIGEST.test(metadata.imageDigest)
    || !metadata.imageReference.endsWith(`@${metadata.imageDigest}`)
    || !Array.isArray(metadata.fixtures)
    || metadata.fixtures.length < 3
  ) {
    throw new Error("invalid_semantic_ranking_protected_baseline");
  }
  const fixtures = metadata.fixtures.map((value, index) => {
    const fixture = exactRecord(
      value,
      ["fixtureId", "orderedManifestHash", "outputHash"],
      `semantic ranking protected baseline fixture ${index}`,
    );
    return {
      fixtureId: fixtureId(
        fixture.fixtureId,
        `semantic ranking protected baseline fixture ${index}.fixtureId`,
      ),
      orderedManifestHash: sha256(
        fixture.orderedManifestHash,
        `semantic ranking protected baseline fixture ${index}.orderedManifestHash`,
      ),
      outputHash: sha256(
        fixture.outputHash,
        `semantic ranking protected baseline fixture ${index}.outputHash`,
      ),
    };
  });
  if (new Set(fixtures.map(({ fixtureId }) => fixtureId)).size !== fixtures.length) {
    throw new Error("invalid_semantic_ranking_protected_baseline");
  }
  return {
    schemaVersion: SEMANTIC_RANKING_PROTECTED_BASELINE_SCHEMA_V1,
    rcTag: String(metadata.rcTag),
    stableTag: String(metadata.stableTag),
    version: releaseVersion,
    sourceRevision: revision(
      metadata.sourceRevision,
      "semantic ranking protected baseline metadata.sourceRevision",
    ),
    imageDigest: imageDigest(
      metadata.imageDigest,
      "semantic ranking protected baseline metadata.imageDigest",
    ),
    imageReference: String(metadata.imageReference),
    finalizationEvidencePayloadHash: sha256(
      metadata.finalizationEvidencePayloadHash,
      "semantic ranking protected baseline metadata.finalizationEvidencePayloadHash",
    ),
    finalBrowserGateEvidenceHash: sha256(
      metadata.finalBrowserGateEvidenceHash,
      "semantic ranking protected baseline metadata.finalBrowserGateEvidenceHash",
    ),
    fixtures,
  };
}

export function semanticRankingProtectedBaselineMetadataSha256(
  value: unknown,
): string {
  return semanticRankingReviewSha256(
    validateSemanticRankingProtectedBaselineMetadataV1(value),
  );
}

export function semanticRankingReviewBaselineIdentityV2(
  value: unknown,
): SemanticRankingReviewBaselineIdentityV2 {
  const metadata = validateSemanticRankingProtectedBaselineMetadataV1(value);
  return {
    stableTag: metadata.stableTag,
    version: metadata.version,
    sourceRevision: metadata.sourceRevision,
    imageDigest: metadata.imageDigest,
    finalizationEvidencePayloadHash:
      metadata.finalizationEvidencePayloadHash,
    metadataHash: semanticRankingProtectedBaselineMetadataSha256(metadata),
  };
}

function exactBaselineIdentity(
  value: unknown,
): SemanticRankingReviewBaselineIdentityV2 {
  const baseline = exactRecord(value, [
    "stableTag",
    "version",
    "sourceRevision",
    "imageDigest",
    "finalizationEvidencePayloadHash",
    "metadataHash",
  ], "semantic ranking review baseline identity");
  const baselineVersion = version(
    baseline.version,
    "semantic ranking review baseline identity.version",
  );
  if (baseline.stableTag !== `v${baselineVersion}`) {
    throw new Error("invalid_semantic_ranking_review_artifact");
  }
  return {
    stableTag: String(baseline.stableTag),
    version: baselineVersion,
    sourceRevision: revision(
      baseline.sourceRevision,
      "semantic ranking review baseline identity.sourceRevision",
    ),
    imageDigest: imageDigest(
      baseline.imageDigest,
      "semantic ranking review baseline identity.imageDigest",
    ),
    finalizationEvidencePayloadHash: sha256(
      baseline.finalizationEvidencePayloadHash,
      "semantic ranking review baseline identity.finalizationEvidencePayloadHash",
    ),
    metadataHash: sha256(
      baseline.metadataHash,
      "semantic ranking review baseline identity.metadataHash",
    ),
  };
}

export function validateSemanticRankingBlindedPackageV1(
  value: unknown,
): SemanticRankingBlindedPackageV1 {
  const source = exactRecord(
    value,
    ["schemaVersion", "randomizationId", "fixtures"],
    "semantic ranking blinded package",
  );
  if (
    source.schemaVersion !== SEMANTIC_RANKING_BLINDED_PACKAGE_SCHEMA_V1
    || !Array.isArray(source.fixtures)
    || source.fixtures.length < 3
  ) {
    throw new Error("invalid_semantic_ranking_blinded_package");
  }
  const randomizationId = blindLabel(
    source.randomizationId,
    "semantic ranking blinded package.randomizationId",
  );
  const fixtures = source.fixtures.map((value, index) => {
    const fixture = exactRecord(
      value,
      ["fixtureId", "arms"],
      `semantic ranking blinded package fixture ${index}`,
    );
    if (!Array.isArray(fixture.arms) || fixture.arms.length !== 2) {
      throw new Error("invalid_semantic_ranking_blinded_package");
    }
    const arms = fixture.arms.map((value, armIndex) => {
      const arm = exactRecord(
        value,
        ["blindLabel", "orderedManifestHash", "outputHash"],
        `semantic ranking blinded package fixture ${index} arm ${armIndex}`,
      );
      return {
        blindLabel: blindLabel(
          arm.blindLabel,
          `semantic ranking blinded package fixture ${index} arm ${armIndex}.blindLabel`,
        ),
        orderedManifestHash: sha256(
          arm.orderedManifestHash,
          `semantic ranking blinded package fixture ${index} arm ${armIndex}.orderedManifestHash`,
        ),
        outputHash: sha256(
          arm.outputHash,
          `semantic ranking blinded package fixture ${index} arm ${armIndex}.outputHash`,
        ),
      };
    }) as [
      SemanticRankingBlindedPackageArmV1,
      SemanticRankingBlindedPackageArmV1,
    ];
    if (arms[0].blindLabel === arms[1].blindLabel) {
      throw new Error("invalid_semantic_ranking_blinded_package");
    }
    return {
      fixtureId: fixtureId(
        fixture.fixtureId,
        `semantic ranking blinded package fixture ${index}.fixtureId`,
      ),
      arms,
    };
  });
  if (
    new Set(fixtures.map(({ fixtureId }) => fixtureId)).size !== fixtures.length
    || new Set(fixtures.flatMap(({ arms }) => arms.map(({ blindLabel }) => blindLabel)))
      .size !== fixtures.length * 2
  ) {
    throw new Error("invalid_semantic_ranking_blinded_package");
  }
  return {
    schemaVersion: SEMANTIC_RANKING_BLINDED_PACKAGE_SCHEMA_V1,
    randomizationId,
    fixtures,
  };
}

export function semanticRankingBlindedPackageSha256(value: unknown): string {
  return semanticRankingReviewSha256(
    validateSemanticRankingBlindedPackageV1(value),
  );
}

export function validateSemanticRankingBlindMappingV1(
  value: unknown,
): SemanticRankingBlindMappingV1 {
  const source = exactRecord(value, [
    "schemaVersion",
    "blindedPackageHash",
    "baselineMetadataHash",
    "candidate",
    "fixtures",
  ], "semantic ranking blind mapping");
  if (
    source.schemaVersion !== SEMANTIC_RANKING_BLIND_MAPPING_SCHEMA_V1
    || !Array.isArray(source.fixtures)
    || source.fixtures.length < 3
  ) {
    throw new Error("invalid_semantic_ranking_blind_mapping");
  }
  const fixtures = source.fixtures.map((value, index) => {
    const fixture = exactRecord(
      value,
      ["fixtureId", "baselineBlindLabel", "candidateBlindLabel"],
      `semantic ranking blind mapping fixture ${index}`,
    );
    const baselineBlindLabel = blindLabel(
      fixture.baselineBlindLabel,
      `semantic ranking blind mapping fixture ${index}.baselineBlindLabel`,
    );
    const candidateBlindLabel = blindLabel(
      fixture.candidateBlindLabel,
      `semantic ranking blind mapping fixture ${index}.candidateBlindLabel`,
    );
    if (baselineBlindLabel === candidateBlindLabel) {
      throw new Error("invalid_semantic_ranking_blind_mapping");
    }
    return {
      fixtureId: fixtureId(
        fixture.fixtureId,
        `semantic ranking blind mapping fixture ${index}.fixtureId`,
      ),
      baselineBlindLabel,
      candidateBlindLabel,
    };
  });
  if (
    new Set(fixtures.map(({ fixtureId }) => fixtureId)).size !== fixtures.length
    || new Set(fixtures.flatMap((fixture) => [
      fixture.baselineBlindLabel,
      fixture.candidateBlindLabel,
    ])).size !== fixtures.length * 2
  ) {
    throw new Error("invalid_semantic_ranking_blind_mapping");
  }
  return {
    schemaVersion: SEMANTIC_RANKING_BLIND_MAPPING_SCHEMA_V1,
    blindedPackageHash: sha256(
      source.blindedPackageHash,
      "semantic ranking blind mapping.blindedPackageHash",
    ),
    baselineMetadataHash: sha256(
      source.baselineMetadataHash,
      "semantic ranking blind mapping.baselineMetadataHash",
    ),
    candidate: exactCandidateIdentity(
      source.candidate,
      "semantic ranking blind mapping candidate",
    ),
    fixtures,
  };
}

export function semanticRankingBlindMappingSha256(value: unknown): string {
  return semanticRankingReviewSha256(
    validateSemanticRankingBlindMappingV1(value),
  );
}

export function validateSemanticRankingBlindScorecardV1(
  value: unknown,
): SemanticRankingBlindScorecardV1 {
  const source = exactRecord(
    value,
    ["schemaVersion", "blindedPackageHash", "reviewedAt", "fixtures"],
    "semantic ranking blind scorecard",
  );
  if (
    source.schemaVersion !== SEMANTIC_RANKING_BLIND_SCORECARD_SCHEMA_V1
    || typeof source.reviewedAt !== "string"
    || !Number.isFinite(Date.parse(source.reviewedAt))
    || new Date(Date.parse(source.reviewedAt)).toISOString()
      !== source.reviewedAt
    || !Array.isArray(source.fixtures)
    || source.fixtures.length < 3
  ) {
    throw new Error("invalid_semantic_ranking_blind_scorecard");
  }
  const fixtures = source.fixtures.map((value, fixtureIndex) => {
    const fixture = exactRecord(
      value,
      ["fixtureId", "arms"],
      `semantic ranking blind scorecard fixture ${fixtureIndex}`,
    );
    if (!Array.isArray(fixture.arms) || fixture.arms.length !== 2) {
      throw new Error("invalid_semantic_ranking_blind_scorecard");
    }
    const arms = fixture.arms.map((value, armIndex) => {
      const arm = exactRecord(
        value,
        ["blindLabel", "orderedManifestHash", "outputHash", "scores"],
        `semantic ranking blind scorecard fixture ${fixtureIndex} arm ${armIndex}`,
      );
      return {
        blindLabel: blindLabel(
          arm.blindLabel,
          `semantic ranking blind scorecard fixture ${fixtureIndex} arm ${armIndex}.blindLabel`,
        ),
        orderedManifestHash: sha256(
          arm.orderedManifestHash,
          `semantic ranking blind scorecard fixture ${fixtureIndex} arm ${armIndex}.orderedManifestHash`,
        ),
        outputHash: sha256(
          arm.outputHash,
          `semantic ranking blind scorecard fixture ${fixtureIndex} arm ${armIndex}.outputHash`,
        ),
        scores: exactScores(
          arm.scores,
          `semantic ranking blind scorecard fixture ${fixtureIndex} arm ${armIndex}.scores`,
        ),
      };
    }) as [
      SemanticRankingBlindScorecardArmV1,
      SemanticRankingBlindScorecardArmV1,
    ];
    if (arms[0].blindLabel === arms[1].blindLabel) {
      throw new Error("invalid_semantic_ranking_blind_scorecard");
    }
    return {
      fixtureId: fixtureId(
        fixture.fixtureId,
        `semantic ranking blind scorecard fixture ${fixtureIndex}.fixtureId`,
      ),
      arms,
    };
  });
  if (
    new Set(fixtures.map(({ fixtureId }) => fixtureId)).size
      !== fixtures.length
    || new Set(fixtures.flatMap(({ arms }) => (
      arms.map(({ blindLabel }) => blindLabel)
    ))).size !== fixtures.length * 2
  ) {
    throw new Error("invalid_semantic_ranking_blind_scorecard");
  }
  return {
    schemaVersion: SEMANTIC_RANKING_BLIND_SCORECARD_SCHEMA_V1,
    blindedPackageHash: sha256(
      source.blindedPackageHash,
      "semantic ranking blind scorecard.blindedPackageHash",
    ),
    reviewedAt: source.reviewedAt,
    fixtures,
  };
}

export function semanticRankingBlindScorecardSha256(value: unknown): string {
  return semanticRankingReviewSha256(
    validateSemanticRankingBlindScorecardV1(value),
  );
}

export function validateSemanticRankingBlindScorecardBindingsV1(input: {
  blindScorecard: unknown;
  blindedPackage: unknown;
}): SemanticRankingBlindScorecardV1 {
  const scorecard = validateSemanticRankingBlindScorecardV1(
    input.blindScorecard,
  );
  const blindedPackage = validateSemanticRankingBlindedPackageV1(
    input.blindedPackage,
  );
  const packageHash = semanticRankingBlindedPackageSha256(blindedPackage);
  const packageByFixture = new Map(
    blindedPackage.fixtures.map((fixture) => [fixture.fixtureId, fixture]),
  );
  if (
    scorecard.blindedPackageHash !== packageHash
    || scorecard.fixtures.length !== blindedPackage.fixtures.length
  ) {
    throw new Error(
      "semantic ranking blind scorecard does not bind the exact blinded package",
    );
  }
  for (const fixture of scorecard.fixtures) {
    const packaged = packageByFixture.get(fixture.fixtureId);
    const packagedByLabel = new Map(
      packaged?.arms.map((arm) => [arm.blindLabel, arm]) ?? [],
    );
    if (
      !packaged
      || fixture.arms.some((arm) => {
        const packagedArm = packagedByLabel.get(arm.blindLabel);
        return !packagedArm
          || packagedArm.orderedManifestHash !== arm.orderedManifestHash
          || packagedArm.outputHash !== arm.outputHash;
      })
    ) {
      throw new Error(
        "semantic ranking blind scorecard does not bind the exact blinded package",
      );
    }
  }
  return scorecard;
}

export function validateSemanticRankingReviewArtifactV1(
  value: unknown,
): SemanticRankingReviewArtifactV1 {
  const artifact = exactRecord(value, [
    "schemaVersion",
    "blinded",
    "independentReviewerAttested",
    "candidate",
    "baseline",
    "blinding",
    "reviewedAt",
    "pairs",
  ], "semantic ranking review artifact");
  const candidate = exactCandidateIdentity(
    artifact.candidate,
    "semantic ranking review candidate",
  );
  const baseline = exactBaselineIdentity(artifact.baseline);
  const blinding = exactRecord(
    artifact.blinding,
    ["blindedPackageHash", "blindMappingHash"],
    "semantic ranking review blinding",
  );
  if (
    artifact.schemaVersion !== SEMANTIC_RANKING_REVIEW_SCHEMA_V2
    || artifact.blinded !== true
    || artifact.independentReviewerAttested !== true
    || candidate.sourceRevision === baseline.sourceRevision
    || candidate.imageDigest === baseline.imageDigest
    || typeof artifact.reviewedAt !== "string"
    || !Number.isFinite(Date.parse(artifact.reviewedAt))
    || new Date(Date.parse(artifact.reviewedAt)).toISOString() !== artifact.reviewedAt
    || !Array.isArray(artifact.pairs)
    || artifact.pairs.length < 3
  ) {
    throw new Error("invalid_semantic_ranking_review_artifact");
  }
  const pairs = artifact.pairs.map((value, index) => {
    const pair = exactRecord(
      value,
      ["fixtureId", "baseline", "candidate"],
      `semantic ranking review pair ${index}`,
    );
    return {
      fixtureId: fixtureId(
        pair.fixtureId,
        `semantic ranking review pair ${index}.fixtureId`,
      ),
      baseline: exactOutput(
        pair.baseline,
        `semantic ranking review pair ${index} baseline`,
      ),
      candidate: exactOutput(
        pair.candidate,
        `semantic ranking review pair ${index} candidate`,
      ),
    };
  });
  if (new Set(pairs.map(({ fixtureId }) => fixtureId)).size !== pairs.length) {
    throw new Error("invalid_semantic_ranking_review_artifact");
  }
  return {
    schemaVersion: SEMANTIC_RANKING_REVIEW_SCHEMA_V2,
    blinded: true,
    independentReviewerAttested: true,
    candidate,
    baseline,
    blinding: {
      blindedPackageHash: sha256(
        blinding.blindedPackageHash,
        "semantic ranking review blinding.blindedPackageHash",
      ),
      blindMappingHash: sha256(
        blinding.blindMappingHash,
        "semantic ranking review blinding.blindMappingHash",
      ),
    },
    reviewedAt: artifact.reviewedAt,
    pairs,
  };
}

export function validateSemanticRankingReviewBindingsV2(input: {
  artifact: unknown;
  protectedBaselineMetadata: unknown;
  blindedPackage: unknown;
  blindScorecard: unknown;
  blindMapping: unknown;
  approvedBaselineMetadataSha256: unknown;
  expectedCandidate: {
    sourceRevision: unknown;
    imageDigest: unknown;
  };
}): {
  artifact: SemanticRankingReviewArtifactV2;
  protectedBaselineMetadata: SemanticRankingProtectedBaselineMetadataV1;
  blindedPackage: SemanticRankingBlindedPackageV1;
  blindScorecard: SemanticRankingBlindScorecardV1;
  blindMapping: SemanticRankingBlindMappingV1;
} {
  const artifact = validateSemanticRankingReviewArtifactV1(input.artifact);
  const protectedBaselineMetadata =
    validateSemanticRankingProtectedBaselineMetadataV1(
      input.protectedBaselineMetadata,
    );
  const blindedPackage = validateSemanticRankingBlindedPackageV1(
    input.blindedPackage,
  );
  const blindScorecard = validateSemanticRankingBlindScorecardBindingsV1({
    blindScorecard: input.blindScorecard,
    blindedPackage,
  });
  const blindMapping = validateSemanticRankingBlindMappingV1(
    input.blindMapping,
  );
  const approvedBaselineMetadataSha256 = sha256(
    input.approvedBaselineMetadataSha256,
    "approved semantic ranking baseline metadata hash",
  );
  const expectedCandidate = exactCandidateIdentity(
    input.expectedCandidate,
    "expected semantic ranking review candidate",
  );
  const baselineMetadataHash =
    semanticRankingProtectedBaselineMetadataSha256(protectedBaselineMetadata);
  const blindedPackageHash =
    semanticRankingBlindedPackageSha256(blindedPackage);
  const blindMappingHash = semanticRankingBlindMappingSha256(blindMapping);
  if (
    baselineMetadataHash !== approvedBaselineMetadataSha256
    || semanticRankingReviewSha256(artifact.baseline)
      !== semanticRankingReviewSha256(
        semanticRankingReviewBaselineIdentityV2(protectedBaselineMetadata),
      )
    || semanticRankingReviewSha256(artifact.candidate)
      !== semanticRankingReviewSha256(expectedCandidate)
    || artifact.blinding.blindedPackageHash !== blindedPackageHash
    || artifact.blinding.blindMappingHash !== blindMappingHash
    || blindMapping.blindedPackageHash !== blindedPackageHash
    || blindScorecard.blindedPackageHash !== blindedPackageHash
    || artifact.reviewedAt !== blindScorecard.reviewedAt
    || blindMapping.baselineMetadataHash !== baselineMetadataHash
    || semanticRankingReviewSha256(blindMapping.candidate)
      !== semanticRankingReviewSha256(expectedCandidate)
  ) {
    throw new Error(
      "semantic ranking review does not bind the protected baseline and exact blinded outputs",
    );
  }
  const baselineByFixture = new Map(
    protectedBaselineMetadata.fixtures.map((fixture) => [
      fixture.fixtureId,
      fixture,
    ]),
  );
  const packageByFixture = new Map(
    blindedPackage.fixtures.map((fixture) => [fixture.fixtureId, fixture]),
  );
  const mappingByFixture = new Map(
    blindMapping.fixtures.map((fixture) => [fixture.fixtureId, fixture]),
  );
  const scorecardByFixture = new Map(
    blindScorecard.fixtures.map((fixture) => [fixture.fixtureId, fixture]),
  );
  if (
    artifact.pairs.length !== protectedBaselineMetadata.fixtures.length
    || artifact.pairs.length !== blindedPackage.fixtures.length
    || artifact.pairs.length !== blindScorecard.fixtures.length
    || artifact.pairs.length !== blindMapping.fixtures.length
  ) {
    throw new Error(
      "semantic ranking review does not bind the protected baseline and exact blinded outputs",
    );
  }
  for (const pair of artifact.pairs) {
    const protectedFixture = baselineByFixture.get(pair.fixtureId);
    const packagedFixture = packageByFixture.get(pair.fixtureId);
    const mappedFixture = mappingByFixture.get(pair.fixtureId);
    const scoredFixture = scorecardByFixture.get(pair.fixtureId);
    const armByLabel = new Map(
      packagedFixture?.arms.map((arm) => [arm.blindLabel, arm]) ?? [],
    );
    const scoredArmByLabel = new Map(
      scoredFixture?.arms.map((arm) => [arm.blindLabel, arm]) ?? [],
    );
    const mappedBaseline = mappedFixture
      ? armByLabel.get(mappedFixture.baselineBlindLabel)
      : undefined;
    const mappedCandidate = mappedFixture
      ? armByLabel.get(mappedFixture.candidateBlindLabel)
      : undefined;
    const scoredBaseline = mappedFixture
      ? scoredArmByLabel.get(mappedFixture.baselineBlindLabel)
      : undefined;
    const scoredCandidate = mappedFixture
      ? scoredArmByLabel.get(mappedFixture.candidateBlindLabel)
      : undefined;
    if (
      !protectedFixture
      || !packagedFixture
      || !mappedFixture
      || !scoredFixture
      || !mappedBaseline
      || !mappedCandidate
      || !scoredBaseline
      || !scoredCandidate
      || mappedBaseline.blindLabel === mappedCandidate.blindLabel
      || pair.baseline.orderedManifestHash
        !== protectedFixture.orderedManifestHash
      || pair.baseline.outputHash !== protectedFixture.outputHash
      || pair.baseline.orderedManifestHash
        !== mappedBaseline.orderedManifestHash
      || pair.baseline.outputHash !== mappedBaseline.outputHash
      || pair.candidate.orderedManifestHash
        !== mappedCandidate.orderedManifestHash
      || pair.candidate.outputHash !== mappedCandidate.outputHash
      || semanticRankingReviewSha256(pair.baseline.scores)
        !== semanticRankingReviewSha256(scoredBaseline.scores)
      || semanticRankingReviewSha256(pair.candidate.scores)
        !== semanticRankingReviewSha256(scoredCandidate.scores)
    ) {
      throw new Error(
        "semantic ranking review does not bind the protected baseline and exact blinded outputs",
      );
    }
  }
  return {
    artifact,
    protectedBaselineMetadata,
    blindedPackage,
    blindScorecard,
    blindMapping,
  };
}

/**
 * Evaluate the release's blinded paired review without retaining prompts,
 * reviewer identity, or playlist/run IDs. Three pairs correspond to the
 * required fixed control, affected regression, and guided constraint canaries.
 */
export function evaluateSemanticRankingReviewV1(
  artifact: SemanticRankingReviewArtifactV1,
): SemanticRankingReviewReportV1 {
  const validated = validateSemanticRankingReviewArtifactV1(artifact);
  const baselineMedians = Object.fromEntries(
    SEMANTIC_RANKING_REVIEW_DIMENSIONS.map((dimension) => [
      dimension,
      median(validated.pairs.map(({ baseline }) => baseline.scores[dimension])),
    ]),
  ) as unknown as SemanticRankingReviewScoresV1;
  const candidateMedians = Object.fromEntries(
    SEMANTIC_RANKING_REVIEW_DIMENSIONS.map((dimension) => [
      dimension,
      median(validated.pairs.map(({ candidate }) => candidate.scores[dimension])),
    ]),
  ) as unknown as SemanticRankingReviewScoresV1;
  const reasonCodes = [
    ...SEMANTIC_RANKING_REVIEW_DIMENSIONS.flatMap((dimension) => [
      ...(candidateMedians[dimension] < 4
        ? [`candidate_median_below_four:${dimension}`]
        : []),
      ...(candidateMedians[dimension] < baselineMedians[dimension]
        ? [`material_median_regression:${dimension}`]
        : []),
    ]),
    ...validated.pairs.flatMap((pair) => (
      SEMANTIC_RANKING_REVIEW_DIMENSIONS.flatMap((dimension) => (
        pair.candidate.scores[dimension] < pair.baseline.scores[dimension]
          ? [`fixture_dimension_regression:${pair.fixtureId}:${dimension}`]
          : []
      ))
    )),
  ];
  const body = {
    schemaVersion: SEMANTIC_RANKING_REVIEW_SCHEMA_V2,
    passed: reasonCodes.length === 0,
    pairCount: artifact.pairs.length,
    candidateMedians,
    baselineMedians,
    reasonCodes,
  };
  return {
    ...body,
    evidenceHash: semanticRankingReviewSha256({ artifact: validated, report: body }),
  };
}

export function validateSemanticRankingReviewReportV1(
  value: unknown,
  artifactValue: unknown,
): SemanticRankingReviewReportV1 {
  const artifact = validateSemanticRankingReviewArtifactV1(artifactValue);
  const report = exactRecord(value, [
    "schemaVersion",
    "passed",
    "pairCount",
    "candidateMedians",
    "baselineMedians",
    "reasonCodes",
    "evidenceHash",
  ], "semantic ranking review report");
  const evaluated = evaluateSemanticRankingReviewV1(artifact);
  if (
    report.schemaVersion !== SEMANTIC_RANKING_REVIEW_SCHEMA_V1
    || report.passed !== evaluated.passed
    || report.pairCount !== evaluated.pairCount
    || typeof report.evidenceHash !== "string"
    || !SHA256.test(report.evidenceHash)
    || report.evidenceHash !== evaluated.evidenceHash
    || !Array.isArray(report.reasonCodes)
    || report.reasonCodes.some((item) => typeof item !== "string")
  ) {
    throw new Error("semantic ranking review report was not derived from the review artifact");
  }
  const candidateMedians = exactScores(
    report.candidateMedians,
    "semantic ranking review report candidate medians",
  );
  const baselineMedians = exactScores(
    report.baselineMedians,
    "semantic ranking review report baseline medians",
  );
  if (
    semanticRankingReviewSha256(candidateMedians)
      !== semanticRankingReviewSha256(evaluated.candidateMedians)
    || semanticRankingReviewSha256(baselineMedians)
      !== semanticRankingReviewSha256(evaluated.baselineMedians)
    || semanticRankingReviewSha256(report.reasonCodes)
      !== semanticRankingReviewSha256(evaluated.reasonCodes)
  ) {
    throw new Error("semantic ranking review report was not derived from the review artifact");
  }
  return evaluated;
}

function ed25519PublicKey(value: string | Buffer | KeyObject): KeyObject {
  let key: KeyObject;
  try {
    key = value instanceof KeyObject
      ? (value.type === "private" ? createPublicKey(value) : value)
      : createPublicKey(value);
  } catch {
    throw new Error("semantic review verification key must be Ed25519");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("semantic review verification key must be Ed25519");
  }
  return key;
}

function ed25519PrivateKey(value: string | Buffer | KeyObject): KeyObject {
  let key: KeyObject;
  try {
    key = value instanceof KeyObject ? value : createPrivateKey(value);
  } catch {
    throw new Error("semantic review signing key must be Ed25519");
  }
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("semantic review signing key must be Ed25519");
  }
  return key;
}

export function semanticRankingReviewerKeyFingerprint(
  value: string | Buffer | KeyObject,
): string {
  return createHash("sha256").update(
    ed25519PublicKey(value).export({ format: "der", type: "spki" }),
  ).digest("hex");
}

export function semanticRankingReviewerVerificationKeyV1(
  value: string | Buffer | KeyObject,
): SemanticRankingReviewerVerificationKeyV1 {
  const publicKey = ed25519PublicKey(value);
  return {
    schemaVersion: "genio-semantic-ranking-reviewer-verification-key/v1",
    algorithm: "Ed25519",
    format: "spki-der",
    value: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    sha256: semanticRankingReviewerKeyFingerprint(publicKey),
  };
}

export function validateSemanticRankingReviewerVerificationKeyV1(
  value: unknown,
): {
  source: SemanticRankingReviewerVerificationKeyV1;
  key: KeyObject;
} {
  const source = exactRecord(value, [
    "schemaVersion",
    "algorithm",
    "format",
    "value",
    "sha256",
  ], "semantic ranking reviewer verification key");
  if (
    source.schemaVersion
      !== "genio-semantic-ranking-reviewer-verification-key/v1"
    || source.algorithm !== "Ed25519"
    || source.format !== "spki-der"
    || typeof source.value !== "string"
    || !/^[0-9A-Za-z_-]{48,256}$/u.test(source.value)
    || typeof source.sha256 !== "string"
    || !SHA256.test(source.sha256)
  ) {
    throw new Error("semantic ranking reviewer verification key is invalid");
  }
  let key: KeyObject;
  try {
    key = createPublicKey({
      key: Buffer.from(source.value, "base64url"),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new Error("semantic ranking reviewer verification key is invalid");
  }
  if (
    key.asymmetricKeyType !== "ed25519"
    || source.sha256 !== semanticRankingReviewerKeyFingerprint(key)
    || source.value
      !== key.export({ format: "der", type: "spki" }).toString("base64url")
  ) {
    throw new Error("semantic ranking reviewer verification key is invalid");
  }
  return {
    source: source as unknown as SemanticRankingReviewerVerificationKeyV1,
    key,
  };
}

function reviewerKeyId(value: unknown): string {
  if (typeof value !== "string" || !KEY_ID.test(value)) {
    throw new Error("semantic review reviewer key ID is invalid");
  }
  return value;
}

function stableAuthorizerKeyId(value: unknown): string {
  if (typeof value !== "string" || !STABLE_KEY_ID.test(value)) {
    throw new Error("semantic review stable authorizer key ID is invalid");
  }
  return value;
}

export function semanticRankingReviewerTrustPolicyV1(input: {
  approvedKeyId: unknown;
  approvedKeySha256: unknown;
  approvedBaselineMetadataSha256: unknown;
  approvedBaselineStableTag: unknown;
  approvedBaselineReleaseKeySha256: unknown;
  approvedBaselineStableAuthorizerKeyId: unknown;
  approvedBaselineStableAuthorizerKeySha256: unknown;
}): SemanticRankingReviewerTrustPolicyV1 {
  if (
    typeof input.approvedKeySha256 !== "string"
    || !SHA256.test(input.approvedKeySha256)
    || typeof input.approvedBaselineMetadataSha256 !== "string"
    || !SHA256.test(input.approvedBaselineMetadataSha256)
    || typeof input.approvedBaselineStableTag !== "string"
    || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u
      .test(input.approvedBaselineStableTag)
    || typeof input.approvedBaselineReleaseKeySha256 !== "string"
    || !SHA256.test(input.approvedBaselineReleaseKeySha256)
    || typeof input.approvedBaselineStableAuthorizerKeySha256 !== "string"
    || !SHA256.test(input.approvedBaselineStableAuthorizerKeySha256)
    || input.approvedBaselineReleaseKeySha256
      === input.approvedBaselineStableAuthorizerKeySha256
  ) {
    throw new Error(
      "semantic review approved reviewer or stable-release lineage keys are invalid",
    );
  }
  return {
    schemaVersion: "genio-semantic-ranking-reviewer-trust-policy/v3",
    approvedKeyId: reviewerKeyId(input.approvedKeyId),
    approvedKeySha256: input.approvedKeySha256,
    approvedBaselineMetadataSha256:
      input.approvedBaselineMetadataSha256,
    approvedBaselineStableTag: input.approvedBaselineStableTag,
    approvedBaselineReleaseKeySha256:
      input.approvedBaselineReleaseKeySha256,
    approvedBaselineStableAuthorizerKeyId:
      stableAuthorizerKeyId(
        input.approvedBaselineStableAuthorizerKeyId,
      ),
    approvedBaselineStableAuthorizerKeySha256:
      input.approvedBaselineStableAuthorizerKeySha256,
  };
}

export function validateSemanticRankingReviewerTrustPolicyV1(
  value: unknown,
): SemanticRankingReviewerTrustPolicyV1 {
  const policy = exactRecord(value, [
    "schemaVersion",
    "approvedKeyId",
    "approvedKeySha256",
    "approvedBaselineMetadataSha256",
    "approvedBaselineStableTag",
    "approvedBaselineReleaseKeySha256",
    "approvedBaselineStableAuthorizerKeyId",
    "approvedBaselineStableAuthorizerKeySha256",
  ], "semantic ranking reviewer trust policy");
  if (
    policy.schemaVersion
      !== "genio-semantic-ranking-reviewer-trust-policy/v3"
  ) {
    throw new Error("semantic ranking reviewer trust policy is invalid");
  }
  return semanticRankingReviewerTrustPolicyV1({
    approvedKeyId: policy.approvedKeyId,
    approvedKeySha256: policy.approvedKeySha256,
    approvedBaselineMetadataSha256:
      policy.approvedBaselineMetadataSha256,
    approvedBaselineStableTag:
      policy.approvedBaselineStableTag,
    approvedBaselineReleaseKeySha256:
      policy.approvedBaselineReleaseKeySha256,
    approvedBaselineStableAuthorizerKeyId:
      policy.approvedBaselineStableAuthorizerKeyId,
    approvedBaselineStableAuthorizerKeySha256:
      policy.approvedBaselineStableAuthorizerKeySha256,
  });
}

function reviewerAttestationMaterial(input: {
  blindScorecardHash: string;
  reviewerVerificationKeySha256: string;
  keyId: string;
}): string {
  return JSON.stringify(ordered({
    schemaVersion: SEMANTIC_RANKING_REVIEWER_ATTESTATION_SCHEMA_V1,
    ...input,
  }));
}

export function attestSemanticRankingReviewV1(input: {
  blindScorecard: unknown;
  signingKey: string | Buffer | KeyObject;
  keyId: string;
}): SemanticRankingReviewerAttestationV1 {
  const blindScorecard = validateSemanticRankingBlindScorecardV1(
    input.blindScorecard,
  );
  const signingKey = ed25519PrivateKey(input.signingKey);
  const publicKey = createPublicKey(signingKey);
  const keyId = reviewerKeyId(input.keyId);
  const blindScorecardHash =
    semanticRankingBlindScorecardSha256(blindScorecard);
  const reviewerVerificationKeySha256 =
    semanticRankingReviewerKeyFingerprint(publicKey);
  return {
    schemaVersion: SEMANTIC_RANKING_REVIEWER_ATTESTATION_SCHEMA_V1,
    blindScorecardHash,
    reviewerVerificationKeySha256,
    signature: {
      algorithm: "Ed25519",
      keyId,
      value: sign(
        null,
        Buffer.from(reviewerAttestationMaterial({
          blindScorecardHash,
          reviewerVerificationKeySha256,
          keyId,
        })),
        signingKey,
      ).toString("base64url"),
    },
  };
}

export function validateSemanticRankingReviewerAttestationV1(
  value: unknown,
  blindScorecardValue: unknown,
): SemanticRankingReviewerAttestationV1 {
  const blindScorecard = validateSemanticRankingBlindScorecardV1(
    blindScorecardValue,
  );
  const attestation = exactRecord(value, [
    "schemaVersion",
    "blindScorecardHash",
    "reviewerVerificationKeySha256",
    "signature",
  ], "semantic ranking reviewer attestation");
  const signature = exactRecord(
    attestation.signature,
    ["algorithm", "keyId", "value"],
    "semantic ranking reviewer attestation signature",
  );
  if (
    attestation.schemaVersion !== SEMANTIC_RANKING_REVIEWER_ATTESTATION_SCHEMA_V1
    || attestation.blindScorecardHash
      !== semanticRankingBlindScorecardSha256(blindScorecard)
    || typeof attestation.reviewerVerificationKeySha256 !== "string"
    || !SHA256.test(attestation.reviewerVerificationKeySha256)
    || signature.algorithm !== "Ed25519"
    || typeof signature.value !== "string"
    || !SIGNATURE_VALUE.test(signature.value)
  ) {
    throw new Error("semantic ranking reviewer attestation does not bind the exact review");
  }
  reviewerKeyId(signature.keyId);
  return attestation as unknown as SemanticRankingReviewerAttestationV1;
}

export function verifySemanticRankingReviewerAttestationV1(input: {
  value: unknown;
  blindScorecard: unknown;
  verificationKey: string | Buffer | KeyObject;
}): SemanticRankingReviewerAttestationV1 {
  const attestation = validateSemanticRankingReviewerAttestationV1(
    input.value,
    input.blindScorecard,
  );
  const publicKey = ed25519PublicKey(input.verificationKey);
  if (
    attestation.reviewerVerificationKeySha256
      !== semanticRankingReviewerKeyFingerprint(publicKey)
    || !verify(
      null,
      Buffer.from(reviewerAttestationMaterial({
        blindScorecardHash: attestation.blindScorecardHash,
        reviewerVerificationKeySha256:
          attestation.reviewerVerificationKeySha256,
        keyId: attestation.signature.keyId,
      })),
      publicKey,
      Buffer.from(attestation.signature.value, "base64url"),
    )
  ) {
    throw new Error("semantic ranking reviewer attestation signature is invalid");
  }
  return attestation;
}
