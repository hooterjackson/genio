import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  signedArtifactSha256,
} from "../shared/signed-artifact.ts";
import {
  verifyV254DirectExposureAuthorityAndWarrantV1,
  type V254DirectExposureExpectedV1,
} from "../shared/v254-direct-exposure-authority.ts";
import {
  assertRailwayBehaviorManifest,
  assertWorkerHeartbeatFence,
  buildNativeV254BehaviorManifest,
  buildNativeV254BehaviorManifestForVariables,
  candidateRuntimeHashes,
  defaultNativeReleaseRuntime,
  nativeV254PublicEditorialActivationVariablesV1,
  promoteService,
  railwayVariableInventory,
  waitForExclusiveCandidateHeartbeats,
  workerHeartbeatSnapshot,
  type NativeReleaseRuntime,
  type NativeSchema20ReleaseArgs,
} from "./promote-native-schema20-release.ts";
import {
  validateNativeSchema20PromotionReceipt,
} from "./finalize-native-schema20-release.ts";

type JsonRecord = Record<string, unknown>;
type Operation = "prepare" | "apply" | "rollback";

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u;
const EXACT_ORIGIN = "https://9enio.com";
const DIRECT_STAGE =
  "editorial_influence:0->100:fully_exposed_unproven";
const OLD_ROLLOUT_KEYS = Object.freeze([
  "RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH",
  "RELEASE_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_HASH",
  "RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_HASH",
  "RELEASE_PUBLIC_ROLLOUT_STAGE",
] as const);
const DIRECT_MARKER_KEYS = Object.freeze([
  "RELEASE_V254_DIRECT_EXPOSURE_PRECONDITIONS_HASH",
  "RELEASE_V254_DIRECT_EXPOSURE_ROLLBACK_PLAN_HASH",
  "RELEASE_V254_DIRECT_EXPOSURE_STAGE",
  "RELEASE_V254_DIRECT_EXPOSURE_TARGET_CONFIGURATION_HASH",
] as const);

export interface V254DirectExposureRuntimeArgsV1 {
  operation: Operation;
  promotionReceiptPath: string;
  authorityPath: string | null;
  rollbackWarrantPath: string | null;
  verificationKeyPath: string | null;
  expectedKeyId: string | null;
  expectedKeySha256: string | null;
  candidateTag: string;
  sourceRevision: string;
  version: string;
  imageDigest: string;
  projectId: string;
  environment: "production";
  services: {
    interactive: string;
    deep: string;
    api: string;
  };
  origin: typeof EXACT_ORIGIN;
  outputPath: string;
  deploymentTimeoutMs: number;
  pollIntervalMs: number;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as JsonRecord;
}

function option(argv: readonly string[], name: string): string {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length !== 1) throw new Error(`${name} must occur exactly once`);
  const value = argv[indexes[0]! + 1]?.trim() ?? "";
  if (!value || value.startsWith("--") || value.includes("\0")) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function optional(argv: readonly string[], name: string): string | null {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} must occur at most once`);
  if (indexes.length === 0) return null;
  const value = argv[indexes[0]! + 1]?.trim() ?? "";
  if (!value || value.startsWith("--") || value.includes("\0")) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function positive(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

export function parseV254DirectExposureRuntimeArgsV1(
  argv: readonly string[],
): V254DirectExposureRuntimeArgsV1 {
  const operation = argv[0] as Operation;
  if (!(["prepare", "apply", "rollback"] as const).includes(operation)) {
    throw new Error("direct runtime operation is invalid");
  }
  const tail = argv.slice(1);
  const commonNames = [
    "--promotion-receipt", "--candidate-tag", "--source-revision",
    "--version", "--image-digest", "--project-id", "--environment",
    "--interactive-service", "--deep-service", "--api-service", "--origin",
    "--output", "--deployment-timeout-seconds", "--poll-interval-seconds",
  ] as const;
  const protectedNames = [
    "--authority", "--rollback-warrant", "--verification-key",
    "--expected-key-id", "--expected-key-sha256",
  ] as const;
  const allowed = new Set<string>([...commonNames, ...protectedNames]);
  for (let index = 0; index < tail.length; index += 2) {
    if (!allowed.has(tail[index] ?? "")) {
      throw new Error("direct runtime argument is unsupported");
    }
  }
  const authorityPath = optional(tail, "--authority");
  const rollbackWarrantPath = optional(tail, "--rollback-warrant");
  const verificationKeyPath = optional(tail, "--verification-key");
  const expectedKeyId = optional(tail, "--expected-key-id");
  const expectedKeySha256 = optional(tail, "--expected-key-sha256");
  const protectedValues = [
    authorityPath, rollbackWarrantPath, verificationKeyPath,
    expectedKeyId, expectedKeySha256,
  ];
  if (
    (operation === "prepare" && protectedValues.some(Boolean))
    || (operation !== "prepare" && protectedValues.some((value) => !value))
  ) throw new Error("direct runtime protected inputs are inconsistent");
  const result: V254DirectExposureRuntimeArgsV1 = {
    operation,
    promotionReceiptPath: option(tail, "--promotion-receipt"),
    authorityPath,
    rollbackWarrantPath,
    verificationKeyPath,
    expectedKeyId,
    expectedKeySha256: expectedKeySha256?.toLowerCase() ?? null,
    candidateTag: option(tail, "--candidate-tag"),
    sourceRevision: option(tail, "--source-revision").toLowerCase(),
    version: option(tail, "--version"),
    imageDigest: option(tail, "--image-digest").toLowerCase(),
    projectId: option(tail, "--project-id"),
    environment: option(tail, "--environment") as "production",
    services: {
      interactive: option(tail, "--interactive-service"),
      deep: option(tail, "--deep-service"),
      api: option(tail, "--api-service"),
    },
    origin: option(tail, "--origin") as typeof EXACT_ORIGIN,
    outputPath: option(tail, "--output"),
    deploymentTimeoutMs: positive(
      option(tail, "--deployment-timeout-seconds"),
      "--deployment-timeout-seconds",
    ) * 1_000,
    pollIntervalMs: positive(
      option(tail, "--poll-interval-seconds"),
      "--poll-interval-seconds",
    ) * 1_000,
  };
  if (
    !SHA1.test(result.sourceRevision)
    || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u
      .test(result.version)
    || !new RegExp(
      `^v${result.version.replaceAll(".", "\\.")}-rc\\.[1-9]\\d*$`,
      "u",
    ).test(result.candidateTag)
    || !IMAGE_DIGEST.test(result.imageDigest)
    || result.environment !== "production"
    || result.origin !== EXACT_ORIGIN
    || (result.expectedKeyId !== null && !SAFE_KEY_ID.test(result.expectedKeyId))
    || (result.expectedKeySha256 !== null
      && !SHA256.test(result.expectedKeySha256))
  ) throw new Error("direct runtime immutable identity is invalid");
  return result;
}

function releaseArgs(
  args: V254DirectExposureRuntimeArgsV1,
): NativeSchema20ReleaseArgs {
  return {
    exactShaImageReceiptPath: "unused",
    candidateEvidencePath: "unused",
    containmentReceiptPath: "unused",
    guidanceMigrationReceiptPath: "unused",
    releaseVerificationKeySha256: "0".repeat(64),
    candidateTag: args.candidateTag,
    sourceRevision: args.sourceRevision,
    version: args.version,
    secretVersionsHash: "0".repeat(64),
    expectedImageRepository: "ghcr.io/hooterjackson/genio",
    origin: args.origin,
    priorSitesRevision: args.sourceRevision,
    priorSitesVersion: args.version,
    projectId: args.projectId,
    environment: args.environment,
    services: args.services,
    outputPath: args.outputPath,
    deploymentTimeoutMs: args.deploymentTimeoutMs,
    pollIntervalMs: args.pollIntervalMs,
  };
}

function expectedFromAuthority(
  value: unknown,
  args: V254DirectExposureRuntimeArgsV1,
): V254DirectExposureExpectedV1 {
  const envelope = record(value, "direct authority envelope");
  const payload = record(envelope.payload, "direct authority payload");
  const candidate = record(payload.candidate, "direct authority candidate");
  const promotion = record(payload.promotion, "direct authority promotion");
  const proofs = record(payload.proofs, "direct authority proofs");
  const owner = record(proofs.ownerApple, "direct owner proof");
  const clean = record(proofs.cleanNonOwner, "direct clean proof");
  const route = record(proofs.databaseRouteAuthority, "direct route proof");
  if (
    candidate.tag !== args.candidateTag
    || candidate.sourceRevision !== args.sourceRevision
    || candidate.version !== args.version
    || candidate.imageDigest !== args.imageDigest
  ) throw new Error("direct runtime authority is for another candidate");
  return {
    keyId: args.expectedKeyId!,
    keySha256: args.expectedKeySha256!,
    candidate: candidate as unknown as V254DirectExposureExpectedV1["candidate"],
    signedNativePromotionAuthorityHash:
      String(promotion.signedNativePromotionAuthorityHash ?? ""),
    nativePromotionReceiptHash:
      String(promotion.nativePromotionReceiptHash ?? ""),
    configurationHash: String(promotion.configurationHash ?? ""),
    runtimeHash: String(promotion.runtimeHash ?? ""),
    semanticBehaviorHash: String(promotion.semanticBehaviorHash ?? ""),
    sites: {
      projectId: String(promotion.sitesProjectId ?? ""),
      versionId: String(promotion.sitesVersionId ?? ""),
      deploymentId: String(promotion.sitesDeploymentId ?? ""),
      revision: String(promotion.sitesRevision ?? ""),
    },
    runtimeTransition:
      promotion.runtimeTransition as V254DirectExposureExpectedV1["runtimeTransition"],
    ownerAppleGateEvidenceHash: String(owner.gateEvidenceHash ?? ""),
    cleanNonOwnerGateEvidenceHash: String(clean.gateEvidenceHash ?? ""),
    databaseRouteReceiptHash: String(route.receiptHash ?? ""),
    currentConfiguration:
      payload.currentConfiguration as V254DirectExposureExpectedV1["currentConfiguration"],
    targetConfiguration:
      payload.targetConfiguration as V254DirectExposureExpectedV1["targetConfiguration"],
    verificationMode: args.operation === "rollback" ? "rollback" : "advance",
  };
}

async function absent(path: string): Promise<void> {
  try {
    await access(path);
    throw new Error("direct runtime output already exists");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function inventories(
  args: V254DirectExposureRuntimeArgsV1,
  runtime: NativeReleaseRuntime,
) {
  const release = releaseArgs(args);
  return Promise.all(
    (["interactive", "deep", "api"] as const).map((lane) => (
      railwayVariableInventory(release, runtime, args.services[lane])
    )),
  );
}

function assertNoCompetingAuthority(
  values: readonly Readonly<Record<string, string>>[],
): void {
  for (const inventory of values) {
    if (OLD_ROLLOUT_KEYS.some((key) => (inventory[key]?.trim() ?? "") !== "")) {
      throw new Error("standard staged rollout authority is still configured");
    }
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function health(
  runtime: NativeReleaseRuntime,
  path: string,
): Promise<JsonRecord> {
  const response = await runtime.fetchJson(
    `${EXACT_ORIGIN}${path}?v254-direct=${Date.now()}`,
  );
  if (response.status !== 200) throw new Error(`${path} is not HTTP 200`);
  return record(response.value, path);
}

function assertDirectHealth(input: {
  live: JsonRecord;
  system: JsonRecord;
  args: V254DirectExposureRuntimeArgsV1;
  semanticHash: string;
  expectedState: "armed" | "rolled_back";
}): void {
  const build = record(input.live.build ?? input.live, "direct liveness build");
  const direct = record(input.system.directExposure, "direct health authority");
  const hashes = candidateRuntimeHashes(input.system, {
    sourceRevision: input.args.sourceRevision,
    version: input.args.version,
  });
  if (
    build.version !== input.args.version
    || build.revision !== input.args.sourceRevision
    || input.system.ok !== true
    || input.system.activationReady !== true
    || record(input.system.executorFencing, "executor fencing").uncoveredJobs !== 0
    || String(input.system.schemaVersion) !== "20"
    || record(input.system.workerProtocol, "worker protocol").actual
      !== "playlist-pipeline-v12"
    || hashes.semantic !== input.semanticHash
    || direct.state !== input.expectedState
    || direct.active !== false
    || direct.organicReliabilityProven !== false
  ) throw new Error("direct runtime health did not converge");
}

async function verifyPair(
  args: V254DirectExposureRuntimeArgsV1,
) {
  const [authority, warrant, key] = await Promise.all([
    readFile(args.authorityPath!, "utf8").then(JSON.parse),
    readFile(args.rollbackWarrantPath!, "utf8").then(JSON.parse),
    readFile(args.verificationKeyPath!),
  ]);
  return {
    authority,
    warrant,
    verified: verifyV254DirectExposureAuthorityAndWarrantV1({
      authority,
      rollbackWarrant: warrant,
      verificationKey: key,
      expected: expectedFromAuthority(authority, args),
    }),
  };
}

async function stage(input: {
  args: V254DirectExposureRuntimeArgsV1;
  runtime: NativeReleaseRuntime;
  values: Readonly<Record<string, string>>;
  markers: Readonly<Record<string, string>>;
}): Promise<void> {
  const release = releaseArgs(input.args);
  const staged = [
    ...Object.entries(input.values).map(([key, value]) => `${key}=${value}`),
    ...Object.entries(input.markers).map(([key, value]) => `${key}=${value}`),
    ...OLD_ROLLOUT_KEYS.map((key) => `${key}=`),
  ];
  for (const serviceId of Object.values(input.args.services)) {
    await input.runtime.commandRunner.run("railway", [
      "variable", "set", ...staged,
      "--service", serviceId,
      "--project", release.projectId,
      "--environment", release.environment,
      "--skip-deploys", "--json",
    ]);
  }
  const readback = await inventories(input.args, input.runtime);
  const manifest = buildNativeV254BehaviorManifestForVariables(
    readback,
    input.values,
  );
  for (const inventory of readback) {
    assertRailwayBehaviorManifest(inventory, manifest);
    for (const [key, value] of Object.entries(input.markers)) {
      if ((inventory[key] ?? "") !== value) {
        throw new Error(`direct runtime marker ${key} did not persist`);
      }
    }
    if (OLD_ROLLOUT_KEYS.some((key) => (inventory[key]?.trim() ?? "") !== "")) {
      throw new Error("standard rollout marker survived direct staging");
    }
  }
}

export async function runV254DirectExposureRuntimeV1(
  args: V254DirectExposureRuntimeArgsV1,
  runtime: NativeReleaseRuntime = defaultNativeReleaseRuntime(),
) {
  await absent(args.outputPath);
  const promotion = validateNativeSchema20PromotionReceipt(
    JSON.parse(await readFile(args.promotionReceiptPath, "utf8")),
    { sourceRevision: args.sourceRevision, version: args.version },
  );
  if (
    promotion.imageDigest !== args.imageDigest
    || promotion.projectId !== args.projectId
    || (Object.keys(args.services) as Array<keyof typeof args.services>)
      .some((lane) => promotion.services[lane].serviceId !== args.services[lane])
  ) throw new Error("direct runtime promotion identity diverges");
  const before = await inventories(args, runtime);
  assertNoCompetingAuthority(before);
  const current = buildNativeV254BehaviorManifest(before);
  const target = buildNativeV254BehaviorManifestForVariables(
    before,
    nativeV254PublicEditorialActivationVariablesV1(),
  );
  if (current.semanticExecutionConfigurationHash
    !== promotion.semanticExecutionConfigurationHash) {
    throw new Error("direct runtime pre-exposure semantic identity changed");
  }
  if (args.operation === "prepare") {
    const unsigned = {
      schemaVersion: "genio-v254-direct-exposure-runtime-plan/v1" as const,
      candidate: {
        tag: args.candidateTag,
        version: args.version,
        sourceRevision: args.sourceRevision,
        imageDigest: args.imageDigest,
      },
      promotionReceiptHash: promotion.receiptHash,
      currentManifestHash: current.manifestHash,
      currentSemanticConfigurationHash:
        current.semanticExecutionConfigurationHash,
      targetManifestHash: target.manifestHash,
      postSemanticConfigurationHash:
        target.semanticExecutionConfigurationHash,
      exposureClass: "fully_exposed_unproven" as const,
      organicReliabilityProven: false as const,
      completedAt: new Date(runtime.now()).toISOString(),
    };
    const output = { ...unsigned, receiptHash: digest(unsigned) };
    await writeFile(args.outputPath, `${JSON.stringify(output, null, 2)}\n`, {
      mode: 0o600, flag: "wx",
    });
    return output;
  }

  const pair = await verifyPair(args);
  const desiredSemanticHash = args.operation === "apply"
    ? pair.verified.runtimeTransition.postExposureSemanticConfigurationHash
    : pair.verified.runtimeTransition.preExposureSemanticConfigurationHash;
  const desiredValues = args.operation === "apply"
    ? pair.verified.targetConfiguration
    : pair.verified.currentConfiguration;
  if (
    target.semanticExecutionConfigurationHash
      !== pair.verified.runtimeTransition.postExposureSemanticConfigurationHash
    || current.semanticExecutionConfigurationHash
      !== pair.verified.runtimeTransition.preExposureSemanticConfigurationHash
  ) throw new Error("direct runtime plan does not match signed transition");
  const markers = args.operation === "apply"
    ? {
        RELEASE_V254_DIRECT_EXPOSURE_PRECONDITIONS_HASH:
          pair.verified.preconditionsHash,
        RELEASE_V254_DIRECT_EXPOSURE_ROLLBACK_PLAN_HASH:
          pair.verified.rollbackPlanHash,
        RELEASE_V254_DIRECT_EXPOSURE_STAGE: DIRECT_STAGE,
        RELEASE_V254_DIRECT_EXPOSURE_TARGET_CONFIGURATION_HASH:
          pair.verified.targetConfigurationHash,
      }
    : Object.fromEntries(DIRECT_MARKER_KEYS.map((key) => [key, ""]));
  await stage({ args, runtime, values: desiredValues, markers });
  const release = releaseArgs(args);
  const interactive = await promoteService({
    args: release,
    runtime,
    serviceId: args.services.interactive,
    imageReference: promotion.imageReference,
    imageDigest: promotion.imageDigest,
  });
  const deep = await promoteService({
    args: release,
    runtime,
    serviceId: args.services.deep,
    imageReference: promotion.imageReference,
    imageDigest: promotion.imageDigest,
  });
  const first = await waitForExclusiveCandidateHeartbeats({
    args: release,
    runtime,
    sourceRevision: args.sourceRevision,
    semanticExecutionConfigurationHash: desiredSemanticHash,
  });
  await runtime.wait(30_000);
  const second = await workerHeartbeatSnapshot(release, runtime);
  assertWorkerHeartbeatFence({
    first,
    second,
    sourceRevision: args.sourceRevision,
    semanticExecutionConfigurationHash: desiredSemanticHash,
  });
  const api = await promoteService({
    args: release,
    runtime,
    serviceId: args.services.api,
    imageReference: promotion.imageReference,
    imageDigest: promotion.imageDigest,
  });
  const live = await health(runtime, "/health/live");
  await health(runtime, "/health/ready");
  const system = await health(runtime, "/health/system");
  assertDirectHealth({
    live,
    system,
    args,
    semanticHash: desiredSemanticHash,
    expectedState: args.operation === "apply" ? "armed" : "rolled_back",
  });
  const unsigned = {
    schemaVersion: "genio-v254-direct-exposure-runtime/v1" as const,
    operation: args.operation,
    candidate: pair.verified.candidate,
    authorityArtifactHash: signedArtifactSha256(pair.authority),
    rollbackWarrantArtifactHash: signedArtifactSha256(pair.warrant),
    authorityPayloadHash: pair.verified.authorityPayloadHash,
    rollbackWarrantPayloadHash: pair.verified.rollbackWarrantPayloadHash,
    preconditionsHash: pair.verified.preconditionsHash,
    rollbackPlanHash: pair.verified.rollbackPlanHash,
    semanticConfigurationHash: desiredSemanticHash,
    runtimeTupleHash: args.operation === "apply"
      ? pair.verified.runtimeTransition.postExposureRuntimeTupleHash
      : pair.verified.runtimeTransition.rollbackRuntimeTupleHash,
    services: {
      interactive: {
        serviceId: args.services.interactive,
        deploymentId: interactive.deploymentId,
      },
      deep: {
        serviceId: args.services.deep,
        deploymentId: deep.deploymentId,
      },
      api: { serviceId: args.services.api, deploymentId: api.deploymentId },
    },
    heartbeatFenceHash: digest({ first, second }),
    healthHash: digest({ live, system }),
    exposureClass: "fully_exposed_unproven" as const,
    organicReliabilityProven: false as const,
    completedAt: new Date(runtime.now()).toISOString(),
  };
  const output = { ...unsigned, receiptHash: digest(unsigned) };
  await writeFile(args.outputPath, `${JSON.stringify(output, null, 2)}\n`, {
    mode: 0o600, flag: "wx",
  });
  return output;
}

async function main(): Promise<void> {
  const args = parseV254DirectExposureRuntimeArgsV1(process.argv.slice(2));
  const result = await runV254DirectExposureRuntimeV1(args);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    operation: args.operation,
    receiptHash: result.receiptHash,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "v254_direct_exposure_runtime_failed_closed",
      message: "Direct exposure runtime transition failed closed",
    })}\n`);
    process.exitCode = 1;
  });
}
