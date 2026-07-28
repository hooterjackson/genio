import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PUBLIC_ROLLOUT_EVIDENCE_SCHEMA_VERSION,
  PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
  PUBLIC_ROLLOUT_PERCENT_LADDER,
  PUBLIC_ROLLOUT_TARGET_CONFIGURATION_KEYS,
  SIGNED_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_SCHEMA_VERSION,
  SIGNED_PUBLIC_ROLLOUT_EVIDENCE_SCHEMA_VERSION,
  buildPublicRolloutRollbackWarrantPayload,
  publicRolloutLatestProductionCanaryCompletedAt,
  publicRolloutPercentages,
  publicRolloutProductionCanaryEvidenceHash,
  validatePublicRolloutConfiguration,
  verifyPublicRolloutRollbackWarrant,
  verifyPreviousPublicRolloutLineage,
  verifyPublicRolloutEvidence,
  type PublicRolloutConfiguration,
  type PublicRolloutIntentGroup,
  type PublicRolloutPercent,
  type PublicRolloutSoakObservation,
} from "../shared/public-rollout-evidence.ts";
import {
  publicRolloutIntentCanaryKeyFingerprint,
  verifyTrustedPublicRolloutIntentCanaryV1,
  type PublicRolloutIntentCanaryTrustV1,
  type VerifiedPublicRolloutIntentCanaryV1,
} from "../shared/public-rollout-intent-canary.ts";
import { RELEASE_EVIDENCE_TTL_MS } from "../shared/release-evidence-constants.ts";
import {
  createStrictSignedEnvelope,
  signedArtifactSha256,
  type JsonRecord,
} from "../shared/signed-artifact.ts";
import {
  releaseEvidenceConfigurationHash,
  releaseEvidenceRuntimeHash,
  verifyReleaseEvidence,
} from "./release-evidence.ts";
import {
  loadReleaseProducerRuntimeSnapshot,
  releaseProducerCandidate,
  releaseProducerOption,
} from "./release-gate-producer.ts";
import {
  collectReleaseConvergenceEvidence,
  parseReleaseConvergenceArgs,
  type ReleaseConvergenceObservation,
} from "./verify-release-convergence.ts";

const CONFIRMATION_FLAG = "--confirm-production-public-rollout";
const KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u;
const DEADLINE_MS = 10 * 60_000;

export interface PublicRolloutEvidenceProducerArgs {
  origin: "https://9enio.com";
  candidate: {
    tag: string;
    version: string;
    sourceRevision: string;
    imageDigest: string;
  };
  intentGroup: PublicRolloutIntentGroup;
  toPercent: PublicRolloutPercent;
  samples: number;
  intervalMs: number;
  runtimeSnapshotPath: string;
  promotionEvidencePath: string;
  previousRolloutEvidencePath: string | null;
  intentCanaryPath: string | null;
  intentCanaryVerificationKeyPath: string | null;
  intentCanaryTrust: PublicRolloutIntentCanaryTrustV1 | null;
  intentCanaryAuthorityPolicyHash: string | null;
  rollbackWarrantPath: string | null;
  rollbackWarrantOutputPath: string | null;
  verificationKeyPath: string;
  outputPath: string;
  producerSigningKeyPath: string;
  producerKeyId: string;
}

function optionCount(argv: readonly string[], name: string): number {
  return argv.filter((value) => value === name).length;
}

export function parsePublicRolloutEvidenceProducerArgs(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): PublicRolloutEvidenceProducerArgs {
  const valueOptions = new Set([
    "--origin",
    "--candidate-tag",
    "--candidate-version",
    "--candidate-revision",
    "--image-digest",
    "--intent-group",
    "--to-percent",
    "--samples",
    "--interval-seconds",
    "--runtime-snapshot",
    "--promotion-evidence",
    "--previous-rollout-evidence",
    "--intent-canary",
    "--intent-canary-verification-key",
    "--rollback-warrant",
    "--rollback-warrant-output",
    "--verification-key",
    "--output",
    "--producer-signing-key",
    "--producer-key-id",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === CONFIRMATION_FLAG) continue;
    if (!valueOptions.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  if (optionCount(argv, CONFIRMATION_FLAG) !== 1) {
    throw new Error(
      `Production public rollout evidence requires ${CONFIRMATION_FLAG}`,
    );
  }
  const origin = releaseProducerOption(argv, "--origin");
  if (
    origin !== "https://9enio.com"
    || environment.RELEASE_PRODUCTION_ORIGIN?.trim() !== origin
  ) {
    throw new Error("--origin must exactly match the protected 9enio.com origin");
  }
  const candidate = releaseProducerCandidate({
    tag: releaseProducerOption(argv, "--candidate-tag"),
    version: releaseProducerOption(argv, "--candidate-version"),
    sourceRevision: releaseProducerOption(argv, "--candidate-revision"),
    imageDigest: releaseProducerOption(argv, "--image-digest"),
  });
  const intentGroup = releaseProducerOption(argv, "--intent-group");
  if (!Object.hasOwn(PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS, intentGroup)) {
    throw new Error("--intent-group is not a governed public rollout intent");
  }
  const toPercent = releaseProducerOption(argv, "--to-percent");
  if (
    !(PUBLIC_ROLLOUT_PERCENT_LADDER as readonly string[]).includes(toPercent)
  ) {
    throw new Error("--to-percent must be 0, 1, 10, 50, or 100");
  }
  const convergence = parseReleaseConvergenceArgs([
    "--origin", origin,
    "--expected-revision", candidate.sourceRevision,
    "--expected-version", candidate.version,
    "--samples", releaseProducerOption(argv, "--samples"),
    "--interval-seconds", releaseProducerOption(argv, "--interval-seconds"),
  ]);
  if (convergence.samples < 3) {
    throw new Error("public rollout evidence requires at least three live samples");
  }
  const previousRolloutEvidencePath =
    optionCount(argv, "--previous-rollout-evidence") === 0
      ? null
      : releaseProducerOption(argv, "--previous-rollout-evidence");
  if (optionCount(argv, "--previous-rollout-evidence") > 1) {
    throw new Error("--previous-rollout-evidence may be provided only once");
  }
  const rollbackWarrantPath = optionCount(argv, "--rollback-warrant") === 0
    ? null
    : releaseProducerOption(argv, "--rollback-warrant");
  const rollbackWarrantOutputPath =
    optionCount(argv, "--rollback-warrant-output") === 0
      ? null
      : releaseProducerOption(argv, "--rollback-warrant-output");
  if (
    optionCount(argv, "--intent-canary") > 1
    || optionCount(argv, "--intent-canary-verification-key") > 1
    ||
    optionCount(argv, "--rollback-warrant") > 1
    || optionCount(argv, "--rollback-warrant-output") > 1
  ) {
    throw new Error("rollback warrant paths may be provided only once");
  }
  if (
    toPercent === "0"
      ? rollbackWarrantPath === null
        || rollbackWarrantOutputPath !== null
        || optionCount(argv, "--intent-canary") !== 0
        || optionCount(argv, "--intent-canary-verification-key") !== 0
      : rollbackWarrantPath !== null
        || rollbackWarrantOutputPath === null
        || optionCount(argv, "--intent-canary") !== 1
        || optionCount(argv, "--intent-canary-verification-key") !== 1
  ) {
    throw new Error(
      toPercent === "0"
        ? "rollback requires --rollback-warrant and forbids --rollback-warrant-output, --intent-canary, and --intent-canary-verification-key"
        : "advance requires --intent-canary, --intent-canary-verification-key, and --rollback-warrant-output and forbids --rollback-warrant",
    );
  }
  const producerKeyId = releaseProducerOption(argv, "--producer-key-id");
  if (!KEY_ID.test(producerKeyId)) {
    throw new Error("--producer-key-id is invalid");
  }
  const intentCanaryTrust = toPercent === "0"
    ? null
    : {
        producerKeyId:
          environment.RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_ID?.trim()
          ?? "",
        producerKeySha256:
          environment.RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_KEY_SHA256?.trim()
          ?? "",
      };
  if (
    intentCanaryTrust
    && (
      !KEY_ID.test(intentCanaryTrust.producerKeyId)
      || !/^[0-9a-f]{64}$/u.test(intentCanaryTrust.producerKeySha256)
    )
  ) {
    throw new Error(
      "advance requires protected intent-canary producer key ID and SHA-256",
    );
  }
  const intentCanaryAuthorityPolicyHash = toPercent === "0"
    ? null
    : environment
      .RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256
      ?.trim().toLowerCase() ?? "";
  if (
    intentCanaryAuthorityPolicyHash !== null
    && !/^[0-9a-f]{64}$/u.test(intentCanaryAuthorityPolicyHash)
  ) {
    throw new Error(
      "advance requires the immutable intent-canary authority policy hash",
    );
  }
  return {
    origin,
    candidate: {
      tag: candidate.tag,
      version: candidate.version,
      sourceRevision: candidate.sourceRevision,
      imageDigest: candidate.imageDigest,
    },
    intentGroup: intentGroup as PublicRolloutIntentGroup,
    toPercent: toPercent as PublicRolloutPercent,
    samples: convergence.samples,
    intervalMs: convergence.intervalMs,
    runtimeSnapshotPath: releaseProducerOption(argv, "--runtime-snapshot"),
    promotionEvidencePath: releaseProducerOption(argv, "--promotion-evidence"),
    previousRolloutEvidencePath,
    intentCanaryPath: optionCount(argv, "--intent-canary") === 0
      ? null
      : releaseProducerOption(argv, "--intent-canary"),
    intentCanaryVerificationKeyPath:
      optionCount(argv, "--intent-canary-verification-key") === 0
        ? null
        : releaseProducerOption(argv, "--intent-canary-verification-key"),
    intentCanaryTrust,
    intentCanaryAuthorityPolicyHash,
    rollbackWarrantPath,
    rollbackWarrantOutputPath,
    verificationKeyPath: releaseProducerOption(argv, "--verification-key"),
    outputPath: releaseProducerOption(argv, "--output"),
    producerSigningKeyPath: releaseProducerOption(
      argv,
      "--producer-signing-key",
    ),
    producerKeyId,
  };
}

async function jsonFile(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error(`${label} must identify readable JSON evidence`);
  }
}

function claimedIntentCanaryExecutorIdentityHash(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--intent-canary must contain signed JSON evidence");
  }
  const payload = (value as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("--intent-canary must contain signed JSON evidence");
  }
  const candidate = (payload as { candidate?: unknown }).candidate;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("--intent-canary must contain signed JSON evidence");
  }
  const identityHash = (
    candidate as { executorIdentityHash?: unknown }
  ).executorIdentityHash;
  if (
    typeof identityHash !== "string"
    || !/^[0-9a-f]{64}$/u.test(identityHash)
  ) {
    throw new Error(
      "--intent-canary must bind an exact executor identity",
    );
  }
  return identityHash;
}

async function ed25519Key(
  path: string,
  kind: "private" | "public",
  label = kind === "private"
    ? "--producer-signing-key"
    : "--verification-key",
): Promise<KeyObject> {
  try {
    const bytes = await readFile(path);
    const key = kind === "private"
      ? createPrivateKey(bytes)
      : createPublicKey(bytes);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key;
  } catch {
    throw new Error(
      `${label} must identify a readable Ed25519 ${kind} key`,
    );
  }
}

async function preflightFiles(
  args: PublicRolloutEvidenceProducerArgs,
): Promise<{
  signingKey: KeyObject;
  verificationKey: KeyObject;
  intentCanaryVerificationKey: KeyObject | null;
}> {
  const paths = [
    args.runtimeSnapshotPath,
    args.promotionEvidencePath,
    args.previousRolloutEvidencePath,
    args.intentCanaryPath,
    args.intentCanaryVerificationKeyPath,
    args.rollbackWarrantPath,
    args.rollbackWarrantOutputPath,
    args.verificationKeyPath,
    args.outputPath,
    args.producerSigningKeyPath,
  ].filter((value): value is string => value !== null)
    .map((value) => resolve(value));
  if (new Set(paths).size !== paths.length) {
    throw new Error("public rollout evidence inputs, output, and keys must be distinct");
  }
  const [signingKey, verificationKey, intentCanaryVerificationKey] =
    await Promise.all([
    ed25519Key(args.producerSigningKeyPath, "private"),
    ed25519Key(args.verificationKeyPath, "public"),
    args.intentCanaryVerificationKeyPath
      ? ed25519Key(
          args.intentCanaryVerificationKeyPath,
          "public",
          "--intent-canary-verification-key",
        )
      : Promise.resolve(null),
  ]);
  if (intentCanaryVerificationKey && args.intentCanaryTrust) {
    const intentFingerprint =
      publicRolloutIntentCanaryKeyFingerprint(intentCanaryVerificationKey);
    const evidenceSigningFingerprint =
      publicRolloutIntentCanaryKeyFingerprint(createPublicKey(signingKey));
    const releaseVerificationFingerprint =
      publicRolloutIntentCanaryKeyFingerprint(verificationKey);
    if (intentFingerprint !== args.intentCanaryTrust.producerKeySha256) {
      throw new Error(
        "--intent-canary-verification-key does not match its protected SHA-256",
      );
    }
    if (
      intentFingerprint === evidenceSigningFingerprint
      || intentFingerprint === releaseVerificationFingerprint
    ) {
      throw new Error(
        "intent-canary producer key must be independent from rollout and release keys",
      );
    }
  }
  for (const [path, label] of [
    [args.outputPath, "public rollout evidence output"],
    [args.rollbackWarrantOutputPath, "rollback warrant output"],
  ] as const) {
    if (path === null) continue;
    try {
      await readFile(path);
      throw new Error(`${label} already exists`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return { signingKey, verificationKey, intentCanaryVerificationKey };
}

export function historicalPromotionVerificationTimeForRollback(
  value: unknown,
  toPercent: PublicRolloutPercent,
): string | undefined {
  if (toPercent !== "0") return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("rollback promotion evidence is invalid");
  }
  const payload = (value as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("rollback promotion evidence payload is invalid");
  }
  const generatedAt = (payload as { generatedAt?: unknown }).generatedAt;
  if (
    typeof generatedAt !== "string"
    || !Number.isFinite(Date.parse(generatedAt))
    || new Date(Date.parse(generatedAt)).toISOString() !== generatedAt
  ) {
    throw new Error("rollback promotion evidence generatedAt is invalid");
  }
  return generatedAt;
}

function configurationFromEnvironment(
  environment: NodeJS.ProcessEnv,
): PublicRolloutConfiguration {
  return validatePublicRolloutConfiguration(Object.fromEntries(
    PUBLIC_ROLLOUT_TARGET_CONFIGURATION_KEYS.map((key) => {
      const value = environment[key]?.trim();
      if (value === undefined || value === "") {
        throw new Error(`Missing protected public rollout configuration ${key}`);
      }
      return [key, value];
    }),
  ));
}

function rolloutStage(input: {
  intentGroup: PublicRolloutIntentGroup;
  fromPercent: PublicRolloutPercent;
  toPercent: PublicRolloutPercent;
}): string {
  return `${input.intentGroup}:${input.fromPercent}->${input.toPercent}`;
}

export function summarizePublicRolloutObservation(
  value: ReleaseConvergenceObservation,
): PublicRolloutSoakObservation {
  const runtime = value.runtime;
  const system = value.system;
  const publicRollout = system.publicRollout;
  const interactive = system.workerLanes.interactive;
  const deep = system.workerLanes.deep;
  const runtimeRolloutEvidenceHash =
    typeof runtime.publicRolloutEvidenceHash === "string"
      ? runtime.publicRolloutEvidenceHash
      : null;
  const runtimeRolloutStage =
    typeof runtime.publicRolloutStage === "string"
      ? runtime.publicRolloutStage
      : null;
  if (
    value.sitesVersion === null
    || value.sitesRevision === null
    || value.api.version === null
    || value.api.revision === null
    || value.api.configurationHash === null
    || value.systemHttpStatus !== 200
    || system.ok !== true
    || system.activationReady !== true
    || system.database !== "ready"
    || system.releaseManifestCanaryGuardsVersion !== "1"
    || system.canonicalExecutionHardeningVersion !== "1"
    || system.paused !== false
    || system.workerProtocol.expected !== "playlist-pipeline-v10"
    || system.workerProtocol.actual !== "playlist-pipeline-v10"
    || interactive.status !== "healthy"
    || interactive.protocolVersion !== "playlist-pipeline-v10"
    || interactive.lastSeenAt === null
    || deep.status !== "healthy"
    || deep.protocolVersion !== "playlist-pipeline-v10"
    || deep.lastSeenAt === null
    || publicRollout.databaseAuthorized !== true
    || publicRollout.active !== (runtimeRolloutEvidenceHash !== null)
    || publicRollout.evidenceHash !== runtimeRolloutEvidenceHash
    || publicRollout.stage !== runtimeRolloutStage
    || (
      publicRollout.active
      && publicRollout.targetConfigurationHash === null
    )
  ) {
    throw new Error(
      "public rollout producer cannot summarize an unhealthy convergence observation",
    );
  }
  return {
    observedAt: value.observedAt,
    sitesVersion: String(value.sitesVersion),
    sitesRevision: String(value.sitesRevision),
    apiVersion: String(value.api.version),
    apiRevision: String(value.api.revision),
    apiConfigurationHash: String(value.api.configurationHash),
    publicRolloutEvidenceHash: runtimeRolloutEvidenceHash,
    publicRolloutStage: runtimeRolloutStage,
    systemHttpStatus: 200,
    systemOk: true,
    activationReady: true,
    database: "ready",
    databaseCapabilityVersion: "2",
    releaseManifestCanaryGuardsVersion: "1",
    canonicalExecutionHardeningVersion: "1",
    paused: false,
    workerProtocolExpected: "playlist-pipeline-v10",
    workerProtocolActual: "playlist-pipeline-v10",
    interactiveWorker: {
      ...interactive,
      status: "healthy",
      protocolVersion: "playlist-pipeline-v10",
      lastSeenAt: interactive.lastSeenAt,
    },
    deepWorker: {
      ...deep,
      status: "healthy",
      protocolVersion: "playlist-pipeline-v10",
      lastSeenAt: deep.lastSeenAt,
    },
  };
}

export function buildPublicRolloutPayload(input: {
  args: PublicRolloutEvidenceProducerArgs;
  promotionPayload: ReturnType<typeof verifyReleaseEvidence>;
  promotionEvidenceHash: string;
  runtimeSnapshot: Awaited<ReturnType<typeof loadReleaseProducerRuntimeSnapshot>>;
  currentConfiguration: PublicRolloutConfiguration;
  previous: ReturnType<typeof verifyPreviousPublicRolloutLineage> | null;
  intentCanary: VerifiedPublicRolloutIntentCanaryV1 | null;
  preservedIntentCanaryHash?: string | null;
  rollbackWarrantHash?: string | null;
  convergence: Awaited<ReturnType<typeof collectReleaseConvergenceEvidence>>;
  generatedAt?: string;
}): JsonRecord {
  if (!input.convergence.passed || input.convergence.violations.length > 0) {
    throw new Error("public rollout live convergence did not pass");
  }
  if (
    input.convergence.expected.samples !== input.args.samples
    || input.convergence.observations.length !== input.args.samples
    || input.convergence.observationSpanMs < 60_000
  ) {
    throw new Error("public rollout live convergence did not span at least 60 seconds");
  }
  const changedFlag =
    PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS[input.args.intentGroup];
  const fromPercent = input.currentConfiguration[changedFlag];
  const operation = input.args.toPercent === "0"
    ? "rollback_to_zero"
    : "advance";
  const targetConfiguration = validatePublicRolloutConfiguration({
    ...input.currentConfiguration,
    [changedFlag]: input.args.toPercent,
  });
  const previousStage = input.previous
    ? rolloutStage(input.previous)
    : null;
  const observations = input.convergence.observations.map(
    summarizePublicRolloutObservation,
  );
  const startedAt = observations[0]!.observedAt;
  const completedAt = observations.at(-1)!.observedAt;
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const intentCanaryHash = input.intentCanary?.payloadHash
    ?? input.preservedIntentCanaryHash
    ?? "";
  if (
    !/^[0-9a-f]{64}$/u.test(intentCanaryHash)
    || (operation === "advance") !== (input.intentCanary !== null)
  ) {
    throw new Error(
      operation === "advance"
        ? "public rollout advance requires its verified intent canary"
        : "public rollout rollback must preserve the prior advance intent canary hash",
    );
  }
  return {
    schemaVersion: PUBLIC_ROLLOUT_EVIDENCE_SCHEMA_VERSION,
    generatedAt,
    expiresAt: new Date(
      Date.parse(generatedAt) + RELEASE_EVIDENCE_TTL_MS,
    ).toISOString(),
    environment: "production",
    candidate: {
      tag: input.args.candidate.tag,
      version: input.args.candidate.version,
      sourceRevision: input.args.candidate.sourceRevision,
      imageDigest: input.args.candidate.imageDigest,
      promotionEvidenceHash: input.promotionEvidenceHash,
    },
    promotion: {
      configurationHash: releaseEvidenceConfigurationHash(
        input.promotionPayload,
      ),
      runtimeHash: releaseEvidenceRuntimeHash(input.promotionPayload),
      semanticBehaviorHash:
        input.promotionPayload.semanticReview.semanticBehaviorHash,
      productionCanaryEvidenceHash:
        publicRolloutProductionCanaryEvidenceHash(input.promotionPayload.gates),
      sitesVersion:
        input.promotionPayload.environmentSnapshots.production!.sitesVersion,
      sitesRevision:
        input.promotionPayload.environmentSnapshots.production!
          .sitesSourceRevision,
      sitesCandidateMatched: false,
      databaseSchemaVersion: "18",
      databaseCapabilityVersion: "2",
      releaseManifestCanaryGuardsVersion: "1",
      canonicalExecutionHardeningVersion: "1",
      workerProtocol: "playlist-pipeline-v10",
    },
    transition: {
      operation,
      intentGroup: input.args.intentGroup,
      fromPercent,
      toPercent: input.args.toPercent,
      currentPercentages: publicRolloutPercentages(input.currentConfiguration),
      previousRolloutEvidenceHash: input.previous?.payloadHash ?? null,
      previousRolloutStage: previousStage,
      rollbackWarrantHash: input.rollbackWarrantHash ?? null,
      intentCanaryHash,
      preserveInFlightRoute: true,
      rollbackPercent: "0",
    },
    soak: {
      runtimeSnapshot: {
        configuration: input.runtimeSnapshot.configuration,
        runtime: input.runtimeSnapshot.runtime,
        configurationHash: input.runtimeSnapshot.configurationHash,
        runtimeHash: input.runtimeSnapshot.runtimeHash,
      },
      startedAt,
      completedAt,
      durationSeconds:
        (Date.parse(completedAt) - Date.parse(startedAt)) / 1_000,
      healthySampleCount: observations.length,
      observationsHash: signedArtifactSha256(observations),
      observations,
      eligibleOldWorkerCount: 0,
      intentStageMetrics: input.intentCanary?.stageMetrics ?? null,
    },
    targetConfiguration,
    targetConfigurationHash: signedArtifactSha256(targetConfiguration),
  };
}

async function main(): Promise<void> {
  const args = parsePublicRolloutEvidenceProducerArgs(process.argv.slice(2));
  const {
    signingKey,
    verificationKey,
    intentCanaryVerificationKey,
  } = await preflightFiles(args);
  const deadlineAt = Date.now() + DEADLINE_MS;
  const candidate = releaseProducerCandidate(args.candidate);
  const [
    promotionEnvelope,
    runtimeSnapshot,
    previousEnvelope,
    intentCanaryEnvelope,
    rollbackWarrantEnvelope,
  ] =
    await Promise.all([
      jsonFile(args.promotionEvidencePath, "--promotion-evidence"),
      loadReleaseProducerRuntimeSnapshot({
        path: args.runtimeSnapshotPath,
        environment: "production",
        expectedScope: "backend",
        origin: args.origin,
        candidate,
      }),
      args.previousRolloutEvidencePath
        ? jsonFile(
            args.previousRolloutEvidencePath,
            "--previous-rollout-evidence",
          )
        : null,
      args.intentCanaryPath
        ? jsonFile(args.intentCanaryPath, "--intent-canary")
        : null,
      args.rollbackWarrantPath
        ? jsonFile(args.rollbackWarrantPath, "--rollback-warrant")
        : null,
    ]);
  const historicalPromotionVerificationTime =
    historicalPromotionVerificationTimeForRollback(
      promotionEnvelope,
      args.toPercent,
    );
  const promotionPayload = verifyReleaseEvidence(
    promotionEnvelope,
    verificationKey,
    {
      expectedKind: "promotion",
      expectedTag: args.candidate.tag,
      expectedRevision: args.candidate.sourceRevision,
      expectedImageDigest: args.candidate.imageDigest,
      expectedRuntimeHash: runtimeSnapshot.runtimeHash,
      ...(args.toPercent === "0"
        ? {}
        : { expectedConfigurationHash: runtimeSnapshot.configurationHash }),
      ...(historicalPromotionVerificationTime
        ? {
          now: historicalPromotionVerificationTime,
        }
        : {}),
    },
  );
  if (promotionPayload.candidate.version !== args.candidate.version) {
    throw new Error("promotion evidence version does not match the rollout target");
  }
  const promotionRecord = promotionEnvelope as JsonRecord;
  const promotionEvidenceHash = String(promotionRecord.payloadHash ?? "");
  const currentConfiguration = configurationFromEnvironment(process.env);
  const previous = previousEnvelope
    ? verifyPreviousPublicRolloutLineage(
        previousEnvelope,
        verificationKey,
        {
          expectedTag: args.candidate.tag,
          expectedVersion: args.candidate.version,
          expectedRevision: args.candidate.sourceRevision,
          expectedImageDigest: args.candidate.imageDigest,
          expectedOwnerCanaryGroups:
            currentConfiguration.PIPELINE_V3_OWNER_CANARY_GROUPS,
          expectedOwnerCanaryMaximumTracks:
            currentConfiguration.PIPELINE_V3_OWNER_CANARY_MAX_TRACKS,
        },
      )
    : null;
  const promotionConfigurationHash =
    releaseEvidenceConfigurationHash(promotionPayload);
  const promotionRuntimeHash = releaseEvidenceRuntimeHash(promotionPayload);
  const promotionCanaryEvidenceHash =
    publicRolloutProductionCanaryEvidenceHash(promotionPayload.gates);
  const priorSites =
    promotionPayload.environmentSnapshots.production!;
  const rollbackWarrant = rollbackWarrantEnvelope
    ? verifyPublicRolloutRollbackWarrant(
        rollbackWarrantEnvelope,
        verificationKey,
        {
          expectedTag: args.candidate.tag,
          expectedVersion: args.candidate.version,
          expectedRevision: args.candidate.sourceRevision,
          expectedImageDigest: args.candidate.imageDigest,
          expectedPromotionEvidenceHash: promotionEvidenceHash,
          expectedPromotionConfigurationHash: promotionConfigurationHash,
          expectedPromotionRuntimeHash: promotionRuntimeHash,
          expectedProductionCanaryEvidenceHash:
            promotionCanaryEvidenceHash,
          expectedSitesVersion: priorSites.sitesVersion,
          expectedSitesRevision: priorSites.sitesSourceRevision,
          ...(previous ? { expectedAdvance: previous } : {}),
        },
      )
    : null;
  if (args.toPercent === "0") {
    if (
      !previous
      || previous.operation !== "advance"
      || !rollbackWarrant
      || rollbackWarrant.advance.payloadHash !== previous.payloadHash
      || signedArtifactSha256(currentConfiguration)
        !== previous.targetConfigurationHash
      || signedArtifactSha256(currentConfiguration)
        !== rollbackWarrant.advance.targetConfigurationHash
    ) {
      throw new Error(
        "rollback requires the exact active advance and its durable signed warrant",
      );
    }
  }
  if (previous) {
    const previousPercentages =
      publicRolloutPercentages(previous.targetConfiguration);
    const currentPercentages =
      publicRolloutPercentages(currentConfiguration);
    if (signedArtifactSha256(previousPercentages)
      !== signedArtifactSha256(currentPercentages)) {
      throw new Error(
        "protected current rollout percentages do not match previous signed evidence",
      );
    }
  } else if (
    Object.values(publicRolloutPercentages(currentConfiguration))
      .some((value) => value !== "0")
  ) {
    throw new Error("nonzero current rollout requires previous signed evidence");
  }
  const changedFlag =
    PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS[args.intentGroup];
  const fromPercent = currentConfiguration[changedFlag];
  const targetConfiguration = validatePublicRolloutConfiguration({
    ...currentConfiguration,
    [changedFlag]: args.toPercent,
  });
  const targetConfigurationHash =
    signedArtifactSha256(targetConfiguration);
  const intentCanary = intentCanaryEnvelope
    ? verifyTrustedPublicRolloutIntentCanaryV1(
        intentCanaryEnvelope,
        intentCanaryVerificationKey!,
        {
          tag: args.candidate.tag,
          version: args.candidate.version,
          sourceRevision: args.candidate.sourceRevision,
          imageDigest: args.candidate.imageDigest,
          apiConfigurationHash: runtimeSnapshot.configuration.apiHash,
          executorIdentityHash:
            claimedIntentCanaryExecutorIdentityHash(intentCanaryEnvelope),
          intentGroup: args.intentGroup,
          fromPercent,
          toPercent: args.toPercent as Exclude<PublicRolloutPercent, "0">,
          targetConfigurationHash,
          authorityPolicyHash: args.intentCanaryAuthorityPolicyHash!,
        },
        args.intentCanaryTrust!,
      )
    : null;
  const convergence = await collectReleaseConvergenceEvidence({
    origin: args.origin,
    scope: "backend",
    expectedRevision: args.candidate.sourceRevision,
    expectedVersion: args.candidate.version,
    expectedSitesRevision:
      runtimeSnapshot.sitesObservation.sourceRevision,
    expectedSitesVersion: runtimeSnapshot.sitesObservation.version,
    samples: args.samples,
    intervalMs: args.intervalMs,
    expectedConfigurationHashes: {
      api: runtimeSnapshot.configuration.apiHash,
      interactiveWorker:
        runtimeSnapshot.configuration.interactiveWorkerHash,
      deepWorker: runtimeSnapshot.configuration.deepWorkerHash,
      semanticExecution:
        runtimeSnapshot.runtime.semanticExecutionConfigurationHash,
    },
  }, deadlineAt);
  const payload = buildPublicRolloutPayload({
    args,
    promotionPayload,
    promotionEvidenceHash,
    runtimeSnapshot,
    currentConfiguration,
    previous,
    intentCanary,
    preservedIntentCanaryHash:
      rollbackWarrant?.advance.intentCanaryHash ?? null,
    rollbackWarrantHash: rollbackWarrant?.payloadHash ?? null,
    convergence,
  });
  const envelope = createStrictSignedEnvelope({
    envelopeSchemaVersion: SIGNED_PUBLIC_ROLLOUT_EVIDENCE_SCHEMA_VERSION,
    payload,
    signingKey,
    keyId: args.producerKeyId,
  });
  const latestCanary = publicRolloutLatestProductionCanaryCompletedAt(
    promotionPayload.gates,
  );
  const verified = verifyPublicRolloutEvidence(
    envelope,
    createPublicKey(signingKey),
    {
      expectedTag: args.candidate.tag,
      expectedVersion: args.candidate.version,
      expectedRevision: args.candidate.sourceRevision,
      expectedImageDigest: args.candidate.imageDigest,
      expectedPromotionEvidenceHash: promotionEvidenceHash,
      ...(args.toPercent === "0"
        ? {
          expectedPromotionConfigurationHash: promotionConfigurationHash,
          rollbackWarrant: rollbackWarrantEnvelope,
        }
        : {
          expectedPromotionConfigurationHash: runtimeSnapshot.configurationHash,
          intentCanary: intentCanaryEnvelope,
          intentCanaryVerificationKey: intentCanaryVerificationKey!,
          intentCanaryTrust: args.intentCanaryTrust!,
          intentCanaryAuthorityPolicyHash:
            args.intentCanaryAuthorityPolicyHash!,
        }),
      expectedPromotionRuntimeHash: runtimeSnapshot.runtimeHash,
      expectedProductionCanaryEvidenceHash:
        promotionCanaryEvidenceHash,
      expectedOwnerCanaryGroups:
        currentConfiguration.PIPELINE_V3_OWNER_CANARY_GROUPS,
      expectedOwnerCanaryMaximumTracks:
        currentConfiguration.PIPELINE_V3_OWNER_CANARY_MAX_TRACKS,
      expectedPreviousRolloutEvidenceHash: previous?.payloadHash ?? null,
      expectedPreviousRolloutStage: previous ? rolloutStage(previous) : null,
      expectedPreviousTargetPercentages: previous
        ? publicRolloutPercentages(previous.targetConfiguration)
        : null,
      minimumSoakStartedAt: new Date(Math.max(
        Date.parse(latestCanary),
        Date.parse(previous?.generatedAt ?? "1970-01-01T00:00:00.000Z"),
        Date.parse(
          intentCanary?.stageMetrics.windowCompletedAt
            ?? "1970-01-01T00:00:00.000Z",
        ),
      )).toISOString(),
    },
  );
  let rollbackWarrantOutput:
    | ReturnType<typeof createStrictSignedEnvelope>
    | null = null;
  if (verified.operation === "advance") {
    const warrantPayload = buildPublicRolloutRollbackWarrantPayload({
      advance: verified,
      candidate: args.candidate,
      promotion: {
        configurationHash: promotionConfigurationHash,
        runtimeHash: promotionRuntimeHash,
        productionCanaryEvidenceHash: promotionCanaryEvidenceHash,
        sitesVersion: priorSites.sitesVersion,
        sitesRevision: priorSites.sitesSourceRevision,
      },
      generatedAt: verified.generatedAt,
    });
    rollbackWarrantOutput = createStrictSignedEnvelope({
      envelopeSchemaVersion:
        SIGNED_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_SCHEMA_VERSION,
      payload: warrantPayload,
      signingKey,
      keyId: args.producerKeyId,
    });
    verifyPublicRolloutRollbackWarrant(
      rollbackWarrantOutput,
      createPublicKey(signingKey),
      {
        expectedTag: args.candidate.tag,
        expectedVersion: args.candidate.version,
        expectedRevision: args.candidate.sourceRevision,
        expectedImageDigest: args.candidate.imageDigest,
        expectedPromotionEvidenceHash: promotionEvidenceHash,
        expectedPromotionConfigurationHash: promotionConfigurationHash,
        expectedPromotionRuntimeHash: promotionRuntimeHash,
        expectedProductionCanaryEvidenceHash: promotionCanaryEvidenceHash,
        expectedSitesVersion: priorSites.sitesVersion,
        expectedSitesRevision: priorSites.sitesSourceRevision,
        expectedAdvance: verified,
      },
    );
  }
  if (rollbackWarrantOutput && args.rollbackWarrantOutputPath) {
    await writeFile(
      args.rollbackWarrantOutputPath,
      `${JSON.stringify(rollbackWarrantOutput, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
  }
  await writeFile(args.outputPath, `${JSON.stringify(envelope, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    payloadHash: verified.payloadHash,
    operation: verified.operation,
    intentGroup: verified.intentGroup,
    fromPercent: verified.fromPercent,
    toPercent: verified.toPercent,
    intentCanaryHash: verified.intentCanaryHash,
    healthySampleCount: verified.soak.healthySampleCount,
    rollbackWarrantHash:
      rollbackWarrantOutput?.payloadHash ?? rollbackWarrant?.payloadHash ?? null,
    producerKeyId: envelope.signature.keyId,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "public_rollout_evidence_producer_failed",
      message: "Production public rollout evidence producer failed closed",
    })}\n`);
    process.exitCode = 1;
  });
}
