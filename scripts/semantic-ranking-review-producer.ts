import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  attestSemanticRankingReviewV1,
  semanticRankingReviewerKeyFingerprint,
  semanticRankingReviewerTrustPolicyV1,
  semanticRankingReviewerVerificationKeyV1,
  validateSemanticRankingBlindMappingV1,
  validateSemanticRankingBlindScorecardV1,
  validateSemanticRankingBlindedPackageV1,
  validateSemanticRankingReviewBindingsV2,
  validateSemanticRankingReviewArtifactV1,
  validateSemanticRankingReviewReportV1,
  verifySemanticRankingReviewerAttestationV1,
  type SemanticRankingReviewerAttestationV1,
  type SemanticRankingReviewerTrustPolicyV1,
  type SemanticRankingBlindScorecardV1,
  type SemanticRankingReviewArtifactV1,
  type SemanticRankingReviewReportV1,
} from "../lib/semantic-ranking-review.ts";
import {
  stableReleaseVerificationKeyV1,
  verifyHistoricalStableReleaseConsumerBundle,
} from "./authorize-stable-release.ts";
import {
  emitReleaseGateProducerArtifacts,
  loadReleaseProducerRuntimeSnapshot,
  preflightReleaseProducerFiles,
  releaseProducerCandidate,
  releaseProducerOption,
  type ReleaseProducerFiles,
} from "./release-gate-producer.ts";
import {
  releaseFixtureBindingsForGate,
  stableReleaseFixtureJson,
  type ReleaseGateArtifactV1,
  type ReleaseGateProducerAttestationV1,
} from "./release-fixtures.ts";
import { loadSemanticBaselineHandoff } from "./semantic-baseline-handoff.ts";

const SHA256 = /^[0-9a-f]{64}$/u;
const KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:-]{2,79}$/u;
const ATTEST_MODE = "attest";
const PRODUCE_MODE = "produce";

interface SemanticReviewInputFiles {
  reviewArtifactPath: string;
  reviewReportPath: string;
  reviewerAttestationPath: string;
  reviewerVerificationKeyPath: string;
  protectedBaselineHandoffDirectory: string;
  blindedPackagePath: string;
  blindScorecardPath: string;
  blindMappingPath: string;
}

export interface SemanticRankingReviewProducerArgs {
  origin: string;
  expectedRevision: string;
  expectedVersion: string;
  candidateTag: string;
  imageDigest: string;
  runtimeSnapshotPath: string;
  guidanceLineageHashes: {
    reggaeton: string;
    frenchJazz: string;
  };
  reviewerTrustPolicy: SemanticRankingReviewerTrustPolicyV1;
  approvedBaselineHandoffSha256: string;
  review: SemanticReviewInputFiles;
  files: ReleaseProducerFiles;
}

export interface SemanticRankingReviewerAttestArgs {
  blindScorecardPath: string;
  reviewerSigningKeyPath: string;
  reviewerKeyId: string;
  outputPath: string;
}

function rejectUnknownOptions(
  argv: readonly string[],
  allowed: ReadonlySet<string>,
): void {
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index] ?? "";
    if (!allowed.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    if (index + 1 >= argv.length) throw new Error(`${argument} requires a value`);
  }
}

function fullDigest(value: string, label: string): string {
  if (!SHA256.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
  return value;
}

function exactConfiguredStagingOrigin(
  value: string,
  environment: NodeJS.ProcessEnv,
): string {
  const configured = environment.RELEASE_STAGING_ORIGIN?.trim() ?? "";
  if (!configured) {
    throw new Error("RELEASE_STAGING_ORIGIN is required for semantic review evidence");
  }
  let origin: string;
  let configuredOrigin: string;
  try {
    origin = new URL(value).origin;
    configuredOrigin = new URL(configured).origin;
  } catch {
    throw new Error("--origin must be the exact configured HTTPS staging origin");
  }
  if (
    !origin.startsWith("https://")
    || value !== origin
    || configured !== configuredOrigin
    || origin !== configuredOrigin
  ) {
    throw new Error("--origin must be the exact configured HTTPS staging origin");
  }
  return origin;
}

export function semanticReviewerTrustPolicyFromEnvironment(
  environment: NodeJS.ProcessEnv,
): SemanticRankingReviewerTrustPolicyV1 {
  const approvedKeyId =
    environment.RELEASE_SEMANTIC_REVIEWER_KEY_ID?.trim() ?? "";
  const approvedKeySha256 =
    environment.RELEASE_SEMANTIC_REVIEWER_KEY_SHA256?.trim().toLowerCase() ?? "";
  const approvedBaselineMetadataSha256 =
    environment.RELEASE_SEMANTIC_BASELINE_METADATA_SHA256
      ?.trim()
      .toLowerCase() ?? "";
  const approvedBaselineStableTag =
    environment.RELEASE_SEMANTIC_BASELINE_STABLE_TAG?.trim() ?? "";
  const approvedBaselineReleaseKeySha256 =
    environment.RELEASE_SEMANTIC_BASELINE_RELEASE_KEY_SHA256
      ?.trim()
      .toLowerCase() ?? "";
  const approvedBaselineStableAuthorizerKeyId =
    environment.RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_ID
      ?.trim() ?? "";
  const approvedBaselineStableAuthorizerKeySha256 =
    environment.RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_SHA256
      ?.trim()
      .toLowerCase() ?? "";
  const approvedBaselineHandoffSha256 =
    environment.RELEASE_SEMANTIC_BASELINE_HANDOFF_SHA256
      ?.trim()
      .toLowerCase() ?? "";
  if (
    !approvedKeyId
    || !approvedKeySha256
    || !approvedBaselineMetadataSha256
    || !approvedBaselineStableTag
    || !approvedBaselineReleaseKeySha256
    || !approvedBaselineStableAuthorizerKeyId
    || !approvedBaselineStableAuthorizerKeySha256
    || !approvedBaselineHandoffSha256
  ) {
    throw new Error(
      "RELEASE_SEMANTIC_REVIEWER_KEY_ID and "
      + "RELEASE_SEMANTIC_REVIEWER_KEY_SHA256 and "
      + "RELEASE_SEMANTIC_BASELINE_METADATA_SHA256 and "
      + "RELEASE_SEMANTIC_BASELINE_STABLE_TAG and "
      + "RELEASE_SEMANTIC_BASELINE_RELEASE_KEY_SHA256 and "
      + "RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_ID and "
      + "RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_SHA256 and "
      + "RELEASE_SEMANTIC_BASELINE_HANDOFF_SHA256 "
      + "are required",
    );
  }
  return semanticRankingReviewerTrustPolicyV1({
    approvedKeyId,
    approvedKeySha256,
    approvedBaselineMetadataSha256,
    approvedBaselineStableTag,
    approvedBaselineReleaseKeySha256,
    approvedBaselineStableAuthorizerKeyId,
    approvedBaselineStableAuthorizerKeySha256,
  });
}

function semanticBaselineHandoffHashFromEnvironment(
  environment: NodeJS.ProcessEnv,
): string {
  return fullDigest(
    environment.RELEASE_SEMANTIC_BASELINE_HANDOFF_SHA256
      ?.trim()
      .toLowerCase() ?? "",
    "RELEASE_SEMANTIC_BASELINE_HANDOFF_SHA256",
  );
}

export function parseSemanticRankingReviewProducerArgs(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): SemanticRankingReviewProducerArgs {
  const allowed = new Set([
    "--origin",
    "--expected-revision",
    "--expected-version",
    "--candidate-tag",
    "--image-digest",
    "--runtime-snapshot",
    "--review-artifact",
    "--review-report",
    "--reviewer-attestation",
    "--reviewer-verification-key",
    "--protected-baseline-handoff-directory",
    "--blinded-package",
    "--blind-scorecard",
    "--blind-mapping",
    "--reggaeton-guidance-lineage-hash",
    "--french-guidance-lineage-hash",
    "--source-output",
    "--output",
    "--attestation-output",
    "--producer-signing-key",
    "--producer-key-id",
  ]);
  rejectUnknownOptions(argv, allowed);
  const expectedRevision =
    releaseProducerOption(argv, "--expected-revision").toLowerCase();
  const expectedVersion = releaseProducerOption(argv, "--expected-version");
  const candidateTag = releaseProducerOption(argv, "--candidate-tag");
  const imageDigest = releaseProducerOption(argv, "--image-digest");
  releaseProducerCandidate({
    tag: candidateTag,
    version: expectedVersion,
    sourceRevision: expectedRevision,
    imageDigest,
  });
  return {
    origin: exactConfiguredStagingOrigin(
      releaseProducerOption(argv, "--origin"),
      environment,
    ),
    expectedRevision,
    expectedVersion,
    candidateTag,
    imageDigest,
    runtimeSnapshotPath: releaseProducerOption(argv, "--runtime-snapshot"),
    guidanceLineageHashes: {
      reggaeton: fullDigest(
        releaseProducerOption(argv, "--reggaeton-guidance-lineage-hash"),
        "--reggaeton-guidance-lineage-hash",
      ),
      frenchJazz: fullDigest(
        releaseProducerOption(argv, "--french-guidance-lineage-hash"),
        "--french-guidance-lineage-hash",
      ),
    },
    reviewerTrustPolicy:
      semanticReviewerTrustPolicyFromEnvironment(environment),
    approvedBaselineHandoffSha256:
      semanticBaselineHandoffHashFromEnvironment(environment),
    review: {
      reviewArtifactPath: releaseProducerOption(argv, "--review-artifact"),
      reviewReportPath: releaseProducerOption(argv, "--review-report"),
      reviewerAttestationPath: releaseProducerOption(argv, "--reviewer-attestation"),
      reviewerVerificationKeyPath:
        releaseProducerOption(argv, "--reviewer-verification-key"),
      protectedBaselineHandoffDirectory:
        releaseProducerOption(
          argv,
          "--protected-baseline-handoff-directory",
        ),
      blindedPackagePath:
        releaseProducerOption(argv, "--blinded-package"),
      blindScorecardPath:
        releaseProducerOption(argv, "--blind-scorecard"),
      blindMappingPath:
        releaseProducerOption(argv, "--blind-mapping"),
    },
    files: {
      sourceOutputPath: releaseProducerOption(argv, "--source-output"),
      artifactOutputPath: releaseProducerOption(argv, "--output"),
      attestationOutputPath: releaseProducerOption(argv, "--attestation-output"),
      producerSigningKeyPath:
        releaseProducerOption(argv, "--producer-signing-key"),
      producerKeyId: releaseProducerOption(argv, "--producer-key-id"),
    },
  };
}

export function parseSemanticRankingReviewerAttestArgs(
  argv: readonly string[],
): SemanticRankingReviewerAttestArgs {
  const allowed = new Set([
    "--blind-scorecard",
    "--reviewer-signing-key",
    "--reviewer-key-id",
    "--output",
  ]);
  rejectUnknownOptions(argv, allowed);
  const reviewerKeyId = releaseProducerOption(argv, "--reviewer-key-id");
  if (!KEY_ID.test(reviewerKeyId)) throw new Error("--reviewer-key-id is invalid");
  return {
    blindScorecardPath: releaseProducerOption(argv, "--blind-scorecard"),
    reviewerSigningKeyPath:
      releaseProducerOption(argv, "--reviewer-signing-key"),
    reviewerKeyId,
    outputPath: releaseProducerOption(argv, "--output"),
  };
}

async function jsonInput(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} must identify readable JSON`);
  }
}

async function ed25519PublicKeyFile(
  path: string,
  label: string,
): Promise<{
  bytes: Buffer;
  key: KeyObject;
}> {
  let bytes: Buffer;
  let key: KeyObject;
  try {
    bytes = await readFile(path);
    key = createPublicKey(bytes);
  } catch {
    throw new Error(`${label} must identify a readable Ed25519 public key`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`${label} must identify a readable Ed25519 public key`);
  }
  return { bytes, key };
}

async function ed25519PrivateKeyFile(
  path: string,
  label: string,
): Promise<{ bytes: Buffer; key: KeyObject }> {
  let bytes: Buffer;
  let key: KeyObject;
  try {
    bytes = await readFile(path);
    key = createPrivateKey(bytes);
  } catch {
    throw new Error(`${label} must identify a readable Ed25519 private key`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`${label} must identify a readable Ed25519 private key`);
  }
  return { bytes, key };
}

async function immutableJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export async function loadExactSemanticRankingReview(input: {
  artifactPath: string;
  reportPath: string;
}): Promise<{
  artifact: SemanticRankingReviewArtifactV1;
  report: SemanticRankingReviewReportV1;
}> {
  const artifact = validateSemanticRankingReviewArtifactV1(
    await jsonInput(input.artifactPath, "--review-artifact"),
  );
  const report = validateSemanticRankingReviewReportV1(
    await jsonInput(input.reportPath, "--review-report"),
    artifact,
  );
  return { artifact, report };
}

export function assertIndependentSemanticReviewerKey(input: {
  reviewerVerificationKey: string | Buffer | KeyObject;
  producerSigningKey: string | Buffer | KeyObject;
}): void {
  const producerPrivate = input.producerSigningKey instanceof KeyObject
    ? input.producerSigningKey
    : createPrivateKey(input.producerSigningKey);
  if (
    producerPrivate.asymmetricKeyType !== "ed25519"
    || semanticRankingReviewerKeyFingerprint(input.reviewerVerificationKey)
      === semanticRankingReviewerKeyFingerprint(createPublicKey(producerPrivate))
  ) {
    throw new Error("semantic reviewer key must be separate from the release gate producer key");
  }
}

export async function produceSemanticRankingReviewGate(
  args: SemanticRankingReviewProducerArgs,
): Promise<{
  artifact: ReleaseGateArtifactV1;
  attestation: ReleaseGateProducerAttestationV1;
  reviewerAttestation: SemanticRankingReviewerAttestationV1;
}> {
  await preflightReleaseProducerFiles(args.files);
  const immutableInputsAndOutputs = [
    args.runtimeSnapshotPath,
    args.review.reviewArtifactPath,
    args.review.reviewReportPath,
    args.review.reviewerAttestationPath,
    args.review.reviewerVerificationKeyPath,
    args.review.protectedBaselineHandoffDirectory,
    args.review.blindedPackagePath,
    args.review.blindScorecardPath,
    args.review.blindMappingPath,
    args.files.sourceOutputPath,
    args.files.artifactOutputPath,
    args.files.attestationOutputPath,
    args.files.producerSigningKeyPath,
  ].map((path) => resolve(path));
  if (
    new Set(immutableInputsAndOutputs).size
      !== immutableInputsAndOutputs.length
  ) {
    throw new Error(
      "semantic review inputs, outputs, runtime snapshot, and keys must be separate files",
    );
  }
  const candidate = releaseProducerCandidate({
    tag: args.candidateTag,
    version: args.expectedVersion,
    sourceRevision: args.expectedRevision,
    imageDigest: args.imageDigest,
  });
  const runtimeSnapshot = await loadReleaseProducerRuntimeSnapshot({
    path: args.runtimeSnapshotPath,
    environment: "staging",
    origin: args.origin,
    candidate,
  });
  const { artifact: reviewArtifact, report: reviewReport } =
    await loadExactSemanticRankingReview({
      artifactPath: args.review.reviewArtifactPath,
      reportPath: args.review.reviewReportPath,
    });
  const protectedBaselineHandoff = await loadSemanticBaselineHandoff({
    directory: args.review.protectedBaselineHandoffDirectory,
    expectedManifestSha256: args.approvedBaselineHandoffSha256,
    expectedCandidateTag: args.candidateTag,
    expectedCandidateSourceRevision: args.expectedRevision,
    expectedMetadataSha256:
      args.reviewerTrustPolicy.approvedBaselineMetadataSha256,
    expectedStableTag:
      args.reviewerTrustPolicy.approvedBaselineStableTag,
    expectedReleaseVerificationKeySha256:
      args.reviewerTrustPolicy.approvedBaselineReleaseKeySha256,
    expectedStableAuthorizerKeyId:
      args.reviewerTrustPolicy.approvedBaselineStableAuthorizerKeyId,
    expectedStableAuthorizerKeySha256:
      args.reviewerTrustPolicy
        .approvedBaselineStableAuthorizerKeySha256,
  });
  const [
    blindedPackage,
    blindScorecard,
    blindMapping,
  ] = await Promise.all([
    jsonInput(args.review.blindedPackagePath, "--blinded-package")
      .then(validateSemanticRankingBlindedPackageV1),
    jsonInput(args.review.blindScorecardPath, "--blind-scorecard")
      .then(validateSemanticRankingBlindScorecardV1),
    jsonInput(args.review.blindMappingPath, "--blind-mapping")
      .then(validateSemanticRankingBlindMappingV1),
  ]);
  const protectedBaselineMetadata =
    protectedBaselineHandoff.protectedBaselineMetadata;
  const protectedBaselineFinalizationEvidence =
    protectedBaselineHandoff.finalizationEvidence;
  const protectedBaselineStableAuthorization =
    protectedBaselineHandoff.stableAuthorization;
  const protectedBaselineReleaseKey =
    protectedBaselineHandoff.releaseVerificationKey;
  const protectedBaselineStableAuthorizerKey =
    protectedBaselineHandoff.stableAuthorizerVerificationKey;
  const protectedBaselineLineage =
    verifyHistoricalStableReleaseConsumerBundle({
      finalizationEvidence: protectedBaselineFinalizationEvidence,
      protectedBaselineMetadata,
      releaseVerificationKey: protectedBaselineReleaseKey.key,
      approvedReleaseKeySha256:
        args.reviewerTrustPolicy.approvedBaselineReleaseKeySha256,
      stableAuthorization: protectedBaselineStableAuthorization,
      stableAuthorizationVerificationKey:
        protectedBaselineStableAuthorizerKey.key,
      approvedStableAuthorizerKeyId:
        args.reviewerTrustPolicy
          .approvedBaselineStableAuthorizerKeyId,
      approvedStableAuthorizerKeySha256:
        args.reviewerTrustPolicy
          .approvedBaselineStableAuthorizerKeySha256,
      expectedRcTag: protectedBaselineMetadata.rcTag,
      expectedVersion: protectedBaselineMetadata.version,
      expectedRevision: protectedBaselineMetadata.sourceRevision,
      expectedImageDigest: protectedBaselineMetadata.imageDigest,
      expectedImageReference: protectedBaselineMetadata.imageReference,
      now: reviewArtifact.reviewedAt,
    });
  if (
    protectedBaselineLineage.protectedBaselineMetadataHash
      !== args.reviewerTrustPolicy.approvedBaselineMetadataSha256
    || protectedBaselineLineage.candidate.stableTag
      !== args.reviewerTrustPolicy.approvedBaselineStableTag
  ) {
    throw new Error(
      "protected semantic baseline lineage is not the approved predecessor release",
    );
  }
  if (
    stableReleaseFixtureJson(protectedBaselineLineage)
      !== stableReleaseFixtureJson(
        protectedBaselineHandoff.stableReleaseConsumer,
      )
  ) {
    throw new Error(
      "protected semantic baseline stored consumer is not the rederived signed lineage",
    );
  }
  validateSemanticRankingReviewBindingsV2({
    artifact: reviewArtifact,
    protectedBaselineMetadata,
    blindedPackage,
    blindScorecard,
    blindMapping,
    approvedBaselineMetadataSha256:
      protectedBaselineLineage.protectedBaselineMetadataHash,
    expectedCandidate: {
      sourceRevision: candidate.sourceRevision,
      imageDigest: candidate.imageDigest,
    },
  });
  const reviewerAttestationValue = await jsonInput(
    args.review.reviewerAttestationPath,
    "--reviewer-attestation",
  );
  const reviewerKey = await ed25519PublicKeyFile(
    args.review.reviewerVerificationKeyPath,
    "--reviewer-verification-key",
  );
  const producerKey = await ed25519PrivateKeyFile(
    args.files.producerSigningKeyPath,
    "--producer-signing-key",
  );
  assertIndependentSemanticReviewerKey({
    reviewerVerificationKey: reviewerKey.key,
    producerSigningKey: producerKey.key,
  });
  const reviewerAttestation = verifySemanticRankingReviewerAttestationV1({
    value: reviewerAttestationValue,
    blindScorecard,
    verificationKey: reviewerKey.key,
  });
  if (
    reviewerAttestation.signature.keyId
      !== args.reviewerTrustPolicy.approvedKeyId
    || reviewerAttestation.reviewerVerificationKeySha256
      !== args.reviewerTrustPolicy.approvedKeySha256
  ) {
    throw new Error(
      "semantic reviewer attestation does not match the protected approved reviewer key",
    );
  }
  const fixtures = releaseFixtureBindingsForGate(
    "semantic_ranking_blinded_review",
    {
      "smooth-reggaeton-heat-50-v1": args.guidanceLineageHashes.reggaeton,
      "french-jazz-guided-constraint-25-v1":
        args.guidanceLineageHashes.frenchJazz,
    },
  );
  const produced = await emitReleaseGateProducerArtifacts({
    gate: "semantic_ranking_blinded_review",
    completedAt: reviewArtifact.reviewedAt,
    candidate,
    runtimeSnapshot,
    fixtures,
    sources: {
      reviewArtifact,
      reviewReport,
      protectedBaselineMetadata,
      protectedBaselineFinalizationEvidence,
      protectedBaselineReleaseVerificationKey:
        stableReleaseVerificationKeyV1(protectedBaselineReleaseKey.key),
      protectedBaselineStableAuthorization,
      protectedBaselineStableAuthorizerVerificationKey:
        stableReleaseVerificationKeyV1(
          protectedBaselineStableAuthorizerKey.key,
        ),
      protectedBaselineLineage,
      blindedPackage,
      blindScorecard,
      blindMapping,
      reviewerAttestation,
      reviewerTrustPolicy: args.reviewerTrustPolicy,
      reviewerVerificationKey:
        semanticRankingReviewerVerificationKeyV1(reviewerKey.key),
    },
    files: args.files,
  });
  return {
    artifact: produced.artifact,
    attestation: produced.attestation,
    reviewerAttestation,
  };
}

async function attestReviewer(
  args: SemanticRankingReviewerAttestArgs,
): Promise<SemanticRankingReviewerAttestationV1> {
  if (resolve(args.outputPath) === resolve(args.reviewerSigningKeyPath)) {
    throw new Error("reviewer attestation output must be separate from the signing key");
  }
  const blindScorecard: SemanticRankingBlindScorecardV1 =
    validateSemanticRankingBlindScorecardV1(
      await jsonInput(args.blindScorecardPath, "--blind-scorecard"),
    );
  const signingKey = await ed25519PrivateKeyFile(
    args.reviewerSigningKeyPath,
    "--reviewer-signing-key",
  );
  const attestation = attestSemanticRankingReviewV1({
    blindScorecard,
    signingKey: signingKey.key,
    keyId: args.reviewerKeyId,
  });
  await immutableJson(args.outputPath, attestation);
  return attestation;
}

async function main(): Promise<void> {
  const [mode, ...argv] = process.argv.slice(2);
  if (mode === ATTEST_MODE) {
    const attestation = await attestReviewer(
      parseSemanticRankingReviewerAttestArgs(argv),
    );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode,
      blindScorecardHash: attestation.blindScorecardHash,
      reviewerKeyId: attestation.signature.keyId,
    })}\n`);
    return;
  }
  if (mode === PRODUCE_MODE) {
    const produced = await produceSemanticRankingReviewGate(
      parseSemanticRankingReviewProducerArgs(argv),
    );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode,
      gate: produced.artifact.gate,
      reviewEvidenceHash: produced.artifact.sources.reviewReport
        && (produced.artifact.sources.reviewReport as { evidenceHash?: unknown })
          .evidenceHash,
      gateEvidenceHash: produced.artifact.evidenceHash,
      reviewerKeyId: produced.reviewerAttestation.signature.keyId,
      producerKeyId: produced.attestation.signature.keyId,
    })}\n`);
    return;
  }
  throw new Error(`Usage: semantic-ranking-review-producer ${ATTEST_MODE}|${PRODUCE_MODE} ...`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "semantic_ranking_review_producer_failed",
      message: "Semantic ranking review producer failed closed",
    })}\n`);
    process.exitCode = 1;
  });
}
