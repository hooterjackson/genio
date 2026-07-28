import {
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  HISTORICAL_REPLAY_CORPUS_COMMITMENT_SHA256,
  HISTORICAL_REPLAY_MAXIMUM_RESEARCH_BUDGET_USD,
  HISTORICAL_REPLAY_REQUIRED_BUDGET_RESERVATION_USD,
  assertHistoricalReplayPromotionCorpus,
  loadHistoricalReplayStagingBindings,
  verifyHistoricalReplayEvidence,
  type HistoricalReplayCandidate,
} from "./historical-browser-replay.ts";
import {
  emitReleaseGateProducerArtifacts,
  loadReleaseProducerRuntimeSnapshot,
  preflightReleaseProducerFiles,
  releaseProducerCandidate,
  releaseProducerOption,
  type ReleaseProducerFiles,
} from "./release-gate-producer.ts";
import {
  releaseGateProducerKeyFingerprint,
  releaseGateProducerTrustPolicyV1,
  validateReleaseGateProducerTrustPolicyV1,
  type ReleaseGateProducerTrustPolicyV1,
} from "./release-evidence.ts";

const HISTORICAL_REPLAY_VERIFICATION_KEY_SCHEMA =
  "genio-historical-browser-replay-verification-key/v1" as const;

export interface HistoricalReplayReleaseProducerArgs {
  origin: string;
  expectedRevision: string;
  expectedVersion: string;
  candidateTag: string;
  imageDigest: string;
  runtimeSnapshotPath: string;
  stagingControlPlaneEvidencePath: string;
  stagingControlPlaneVerificationKeyPath: string;
  stagingControlPlaneTrustPolicyPath: string;
  historicalReplayEvidencePath: string;
  historicalReplayVerificationKeyPath: string;
  historicalReplayTrustPolicyPath: string;
  approvedHistoricalReplayTrust: ReleaseGateProducerTrustPolicyV1;
  files: ReleaseProducerFiles;
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

function exactConfiguredStagingOrigin(
  value: string,
  environment: NodeJS.ProcessEnv,
): string {
  const configured = environment.RELEASE_STAGING_ORIGIN?.trim() ?? "";
  const production = environment.RELEASE_PRODUCTION_ORIGIN?.trim() ?? "";
  let origin: string;
  let configuredOrigin: string;
  try {
    origin = new URL(value).origin;
    configuredOrigin = new URL(configured).origin;
  } catch {
    throw new Error("--origin must be the exact configured HTTPS staging origin");
  }
  if (
    !configured
    || !origin.startsWith("https://")
    || value !== origin
    || configured !== configuredOrigin
    || origin !== configuredOrigin
    || (production && origin === new URL(production).origin)
    || origin === "https://9enio.com"
  ) {
    throw new Error("--origin must be the exact configured non-production HTTPS staging origin");
  }
  return origin;
}

export function parseHistoricalReplayReleaseProducerArgs(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): HistoricalReplayReleaseProducerArgs {
  const allowed = new Set([
    "--origin",
    "--expected-revision",
    "--expected-version",
    "--candidate-tag",
    "--image-digest",
    "--runtime-snapshot",
    "--staging-control-plane-evidence",
    "--staging-control-plane-verification-key",
    "--staging-control-plane-trust-policy",
    "--historical-replay-evidence",
    "--historical-replay-verification-key",
    "--historical-replay-trust-policy",
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
    stagingControlPlaneEvidencePath:
      releaseProducerOption(argv, "--staging-control-plane-evidence"),
    stagingControlPlaneVerificationKeyPath:
      releaseProducerOption(
        argv,
        "--staging-control-plane-verification-key",
      ),
    stagingControlPlaneTrustPolicyPath:
      releaseProducerOption(argv, "--staging-control-plane-trust-policy"),
    historicalReplayEvidencePath:
      releaseProducerOption(argv, "--historical-replay-evidence"),
    historicalReplayVerificationKeyPath:
      releaseProducerOption(argv, "--historical-replay-verification-key"),
    historicalReplayTrustPolicyPath:
      releaseProducerOption(argv, "--historical-replay-trust-policy"),
    approvedHistoricalReplayTrust: releaseGateProducerTrustPolicyV1({
      approvedKeyId:
        environment.RELEASE_HISTORICAL_REPLAY_KEY_ID?.trim() ?? "",
      approvedKeySha256:
        environment.RELEASE_HISTORICAL_REPLAY_KEY_SHA256
          ?.trim()
          .toLowerCase() ?? "",
    }),
    files: {
      sourceOutputPath: releaseProducerOption(argv, "--source-output"),
      artifactOutputPath: releaseProducerOption(argv, "--output"),
      attestationOutputPath:
        releaseProducerOption(argv, "--attestation-output"),
      producerSigningKeyPath:
        releaseProducerOption(argv, "--producer-signing-key"),
      producerKeyId: releaseProducerOption(argv, "--producer-key-id"),
    },
  };
}

async function readJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} must identify readable JSON`);
  }
}

async function readEd25519PublicKey(path: string): Promise<Buffer> {
  let value: Buffer;
  try {
    value = await readFile(path);
  } catch {
    throw new Error(
      "--historical-replay-verification-key must identify a readable Ed25519 public key",
    );
  }
  try {
    const parsed = createPublicKey(value);
    if (parsed.asymmetricKeyType !== "ed25519" || parsed.type !== "public") {
      throw new Error("wrong key");
    }
  } catch {
    throw new Error(
      "--historical-replay-verification-key must identify a readable Ed25519 public key",
    );
  }
  return value;
}

async function assertIndependentProducerKeys(input: {
  historicalReplayVerificationKey: Buffer;
  outerProducerSigningKeyPath: string;
}): Promise<void> {
  let outerSigningKey: Buffer;
  try {
    outerSigningKey = await readFile(input.outerProducerSigningKeyPath);
  } catch {
    throw new Error("release gate producer signing key is unreadable");
  }
  if (
    releaseGateProducerKeyFingerprint(
      input.historicalReplayVerificationKey,
    ) === releaseGateProducerKeyFingerprint(
      createPrivateKey(outerSigningKey),
    )
  ) {
    throw new Error(
      "historical replay and release gate evidence require independent signing keys",
    );
  }
}

export async function produceHistoricalReplayReleaseGate(
  args: HistoricalReplayReleaseProducerArgs,
): Promise<Awaited<ReturnType<typeof emitReleaseGateProducerArtifacts>>> {
  await preflightReleaseProducerFiles(args.files);
  const candidate = releaseProducerCandidate({
    tag: args.candidateTag,
    version: args.expectedVersion,
    sourceRevision: args.expectedRevision,
    imageDigest: args.imageDigest,
  });
  const historicalCandidate: HistoricalReplayCandidate = {
    tag: candidate.tag,
    version: candidate.version,
    sourceRevision: candidate.sourceRevision,
    imageDigest: candidate.imageDigest,
  };
  const [
    runtimeSnapshot,
    stagingBindings,
    signedReplay,
    historicalReplayVerificationKey,
    trustValue,
  ] = await Promise.all([
    loadReleaseProducerRuntimeSnapshot({
      path: args.runtimeSnapshotPath,
      environment: "staging",
      expectedScope: "full",
      origin: args.origin,
      candidate,
    }),
    loadHistoricalReplayStagingBindings({
      origin: args.origin,
      candidate: historicalCandidate,
      runtimeSnapshotPath: args.runtimeSnapshotPath,
      stagingControlPlaneEvidencePath:
        args.stagingControlPlaneEvidencePath,
      stagingControlPlaneVerificationKeyPath:
        args.stagingControlPlaneVerificationKeyPath,
      stagingControlPlaneTrustPolicyPath:
        args.stagingControlPlaneTrustPolicyPath,
    }),
    readJson(
      args.historicalReplayEvidencePath,
      "--historical-replay-evidence",
    ),
    readEd25519PublicKey(args.historicalReplayVerificationKeyPath),
    readJson(
      args.historicalReplayTrustPolicyPath,
      "--historical-replay-trust-policy",
    ),
  ]);
  if (
    runtimeSnapshot.snapshotHash
      !== stagingBindings.runtimeSnapshot.snapshotHash
  ) {
    throw new Error(
      "historical replay and release gate do not bind the same runtime snapshot",
    );
  }
  const trust = validateReleaseGateProducerTrustPolicyV1(trustValue);
  const key = createPublicKey(historicalReplayVerificationKey);
  const keyFingerprint =
    releaseGateProducerKeyFingerprint(key);
  if (
    trust.approvedKeySha256 !== keyFingerprint
    || trust.approvedKeyId
      !== args.approvedHistoricalReplayTrust.approvedKeyId
    || trust.approvedKeySha256
      !== args.approvedHistoricalReplayTrust.approvedKeySha256
  ) {
    throw new Error(
      "historical replay verification key is not approved by the protected trust policy",
    );
  }
  await assertIndependentProducerKeys({
    historicalReplayVerificationKey,
    outerProducerSigningKeyPath: args.files.producerSigningKeyPath,
  });
  const payload = verifyHistoricalReplayEvidence({
    value: signedReplay,
    verificationKey: key,
    trustPolicy: trust,
    expectedCandidate: historicalCandidate,
    origin: args.origin,
    runtimeSnapshot,
    controlPlaneEvidenceHash:
      stagingBindings.controlPlaneEvidenceHash,
    serviceInventoryHash: stagingBindings.serviceInventoryHash,
  });
  assertHistoricalReplayPromotionCorpus({
    corpusCommitmentHash: payload.corpus.commitmentHash,
    submissionCount: payload.corpus.submissionCount,
    maximumResearchBudgetUsd:
      payload.corpus.maximumResearchBudgetUsd,
    requiredBudgetReservationUsd:
      payload.corpus.requiredBudgetReservationUsd,
  });
  if (
    payload.corpus.commitmentHash
      !== HISTORICAL_REPLAY_CORPUS_COMMITMENT_SHA256
    || payload.corpus.maximumResearchBudgetUsd
      !== HISTORICAL_REPLAY_MAXIMUM_RESEARCH_BUDGET_USD
    || payload.corpus.requiredBudgetReservationUsd
      !== HISTORICAL_REPLAY_REQUIRED_BUDGET_RESERVATION_USD
  ) {
    throw new Error(
      "historical replay evidence does not bind the approved promotion corpus",
    );
  }
  const publicKeyPem = key.export({
    format: "pem",
    type: "spki",
  }).toString();
  return emitReleaseGateProducerArtifacts({
    gate: "staging_historical_replay",
    completedAt: payload.generatedAt,
    candidate,
    runtimeSnapshot,
    fixtures: [],
    sources: {
      historicalReplay: signedReplay,
      historicalReplayVerificationKey: {
        schemaVersion: HISTORICAL_REPLAY_VERIFICATION_KEY_SCHEMA,
        algorithm: "Ed25519",
        keyId: trust.approvedKeyId,
        publicKeyPem,
        publicKeySha256: keyFingerprint,
      },
      historicalReplayTrust: trust,
    },
    files: args.files,
  });
}

export async function historicalReplayReleaseProducerMain(
  argv: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const produced = await produceHistoricalReplayReleaseGate(
    parseHistoricalReplayReleaseProducerArgs(argv, environment),
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    gate: produced.artifact.gate,
    historicalCorpusCommitment:
      HISTORICAL_REPLAY_CORPUS_COMMITMENT_SHA256,
    gateEvidenceHash: produced.artifact.evidenceHash,
    producerKeyId: produced.attestation.signature.keyId,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  historicalReplayReleaseProducerMain().catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "historical_replay_release_producer_failed",
      message: "Historical replay release producer failed closed",
    })}\n`);
    process.exitCode = 1;
  });
}
