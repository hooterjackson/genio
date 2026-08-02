import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  collectReleaseConvergenceEvidence,
  parseReleaseConvergenceArgs,
} from "./verify-release-convergence.ts";
import {
  nativeV254EvidenceHash,
  validateNativeV254CandidateEvidence,
  type NativeV254CandidateEvidenceV1,
} from "./native-v254-candidate-evidence.ts";
import {
  SEMANTIC_EXECUTION_CONFIGURATION_ENV_KEYS_V1,
  runtimeReleaseContract,
} from "../server/runtime-release.ts";
import {
  validateV254GuidanceMigrationReceiptV1,
} from "./v254-guidance-migration-receipt.ts";

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_REFERENCE =
  /^ghcr\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TERMINAL_FAILURES = new Set([
  "CRASHED",
  "FAILED",
  "REMOVED",
  "SKIPPED",
]);
const REQUIRED_SERVICE_NAMES = Object.freeze({
  interactive: "needle-worker",
  deep: "needle-deep-worker",
  api: "needle-api",
});

export interface ExactShaImageReceiptV1 {
  schemaVersion: "genio-exact-sha-image/v1";
  sourceRevision: string;
  version: string;
  imageReference: string;
  imageDigest: string;
  controllerRevision: string;
  checksRunId: string;
  ciReceiptSha256: string;
  releaseVerificationKeySha256: string;
  publicRolloutIntentCanaryAuthorityPolicySha256: string;
  runUrl: string;
  createdAt: string;
}

export interface NativeSchema20ReleaseArgs {
  exactShaImageReceiptPath: string;
  candidateEvidencePath: string;
  containmentReceiptPath: string;
  guidanceMigrationReceiptPath: string;
  releaseVerificationKeySha256: string;
  candidateTag: string;
  sourceRevision: string;
  version: string;
  secretVersionsHash: string;
  expectedImageRepository: string;
  origin: string;
  priorSitesRevision: string;
  priorSitesVersion: string;
  projectId: string;
  environment: "production";
  services: {
    interactive: string;
    deep: string;
    api: string;
  };
  outputPath: string;
  deploymentTimeoutMs: number;
  pollIntervalMs: number;
}

type JsonRecord = Record<string, unknown>;

interface RailwayServiceStatus {
  id: string;
  name: string;
  deploymentId: string;
  status: string;
  stopped: boolean;
}

interface RailwayDeployment {
  id: string;
  status: string;
  createdAt: string;
  meta: {
    image: string | null;
    imageDigest: string | null;
  };
}

export interface WorkerHeartbeatFenceRow {
  workerId: string;
  queueClass: "interactive" | "deep";
  revision: string;
  protocolVersion: "playlist-pipeline-v12";
  semanticExecutionConfigurationHash: string;
  lastSeenAt: string;
}

export interface NativeReleaseCommandRunner {
  run(command: string, args: readonly string[]): Promise<string>;
}

export interface NativeReleaseRuntime {
  commandRunner: NativeReleaseCommandRunner;
  fetchJson(url: string): Promise<{ status: number; value: unknown }>;
  wait(ms: number): Promise<void>;
  now(): number;
}

export interface NativeSchema20PromotionReceiptV1 {
  schemaVersion: "genio-native-schema20-promotion/v1";
  sourceRevision: string;
  version: string;
  imageReference: string;
  imageDigest: string;
  candidateEvidenceHash: string;
  exactShaImageReceiptHash: string;
  semanticBehaviorManifestHash: string;
  semanticExecutionConfigurationHash: string;
  containmentReceiptHash: string;
  guidanceCheckpointMigrationReceiptHash: string;
  legacyExecutionRouteDrainInventoryReceiptHash: string;
  schema20EvidenceRecoveryReceiptHash: string;
  projectId: string;
  environment: "production";
  services: {
    interactive: { serviceId: string; deploymentId: string };
    deep: { serviceId: string; deploymentId: string };
    api: { serviceId: string; deploymentId: string };
  };
  rollbackServices: {
    interactive: {
      serviceId: string;
      deploymentId: string;
      imageReference: string;
      imageDigest: string;
    };
    deep: {
      serviceId: string;
      deploymentId: string;
      imageReference: string;
      imageDigest: string;
    };
    api: {
      serviceId: string;
      deploymentId: string;
      imageReference: string;
      imageDigest: string;
    };
  };
  promotedRuntimeConfigurationHashes: {
    api: string;
    interactive: string;
    deep: string;
    semantic: string;
  };
  backendConvergenceEvidenceHash: string;
  completedAt: string;
  receiptHash: string;
}

export interface NativeV254BehaviorManifestV1 {
  readonly schemaVersion: "genio-v254-behavior-manifest/v1";
  readonly values: Readonly<Record<string, string | null>>;
  readonly stagedVariables: readonly string[];
  readonly semanticExecutionConfigurationHash: string;
  readonly manifestHash: string;
}

const NATIVE_V254_ROUTE_SWITCH_VARIABLES_V1 = Object.freeze({
  GUIDANCE_CONTRACT_V2_ENABLED: "true",
  GUIDANCE_CONTRACT_V2_OWNER_CANARY: "false",
  GUIDANCE_CONTRACT_V3_ENABLED: "false",
  GUIDANCE_CONTRACT_V3_OWNER_CANARY: "false",
  GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "false",
  GUIDANCE_V5_ENABLED: "true",
  PIPELINE_V2_CURATED_PERCENT: "100",
  PIPELINE_V2_FACTUAL_OWNER_CANARY: "false",
  PIPELINE_V2_FACTUAL_PERCENT: "0",
  PIPELINE_V2_OWNER_CANARY: "false",
  PIPELINE_V2_SIMILARITY_PERCENT: "0",
  PIPELINE_V3_ARTIST_CATALOGUE_PERCENT: "0",
  PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
  PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED: "true",
  PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT: "0",
  PIPELINE_V3_EXHAUSTIVE_PERCENT: "0",
  PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED: "true",
  PIPELINE_V3_FACTUAL_PERCENT: "0",
  PIPELINE_V3_FIXED_CONTAINER_PERCENT: "0",
  PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED: "true",
  PIPELINE_V3_GENRE_SCENE_PERCENT: "0",
  PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED: "true",
  PIPELINE_V3_MOOD_ACTIVITY_PERCENT: "0",
  PIPELINE_V3_OWNER_CANARY: "true",
  PIPELINE_V3_OWNER_CANARY_GROUPS: "editorial_influence",
  PIPELINE_V3_OWNER_CANARY_MAX_TRACKS: "50",
  PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED: "true",
  PIPELINE_V3_PROOF_ARCHITECTURE_MODE: "native",
  PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "6",
  PIPELINE_V3_SIMILARITY_PERCENT: "0",
} satisfies Readonly<Record<string, string>>);

const NATIVE_V254_BEHAVIOR_KEYS_V1 = Object.freeze(
  [...new Set([
    ...SEMANTIC_EXECUTION_CONFIGURATION_ENV_KEYS_V1,
    ...Object.keys(NATIVE_V254_ROUTE_SWITCH_VARIABLES_V1),
  ])].sort(),
);

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  keys: readonly string[],
  label: string,
): void {
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    observed.length !== expected.length
    || observed.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function string(
  value: unknown,
  label: string,
  pattern: RegExp,
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]),
  );
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function option(
  values: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = values.get(name)?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

export function validateExactShaImageReceipt(
  value: unknown,
  expected: {
    sourceRevision: string;
    version: string;
    imageRepository: string;
    releaseVerificationKeySha256: string;
  },
): ExactShaImageReceiptV1 {
  const receipt = record(value, "exact-SHA image receipt");
  exactKeys(receipt, [
    "schemaVersion",
    "sourceRevision",
    "version",
    "imageReference",
    "imageDigest",
    "controllerRevision",
    "checksRunId",
    "ciReceiptSha256",
    "releaseVerificationKeySha256",
    "publicRolloutIntentCanaryAuthorityPolicySha256",
    "runUrl",
    "createdAt",
  ], "exact-SHA image receipt");
  if (receipt.schemaVersion !== "genio-exact-sha-image/v1") {
    throw new Error("exact-SHA image receipt uses an unsupported schema");
  }
  const sourceRevision = string(
    receipt.sourceRevision,
    "exact-SHA source revision",
    SHA1,
  );
  const version = string(receipt.version, "exact-SHA version", VERSION);
  const imageReference = string(
    receipt.imageReference,
    "exact-SHA image reference",
    IMAGE_REFERENCE,
  );
  const imageDigest = string(
    receipt.imageDigest,
    "exact-SHA image digest",
    IMAGE_DIGEST,
  );
  const expectedRepository = expected.imageRepository.toLowerCase();
  if (
    sourceRevision !== expected.sourceRevision
    || version !== expected.version
    || imageReference !== `${expectedRepository}@${imageDigest}`
  ) {
    throw new Error("exact-SHA image receipt does not bind the requested release");
  }
  const keyHash = string(
    receipt.releaseVerificationKeySha256,
    "exact-SHA release verification key digest",
    SHA256,
  );
  if (keyHash !== expected.releaseVerificationKeySha256) {
    throw new Error("exact-SHA image receipt does not bind the protected release key");
  }
  const runUrl = string(
    receipt.runUrl,
    "exact-SHA workflow URL",
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9]\d*$/u,
  );
  return Object.freeze({
    schemaVersion: "genio-exact-sha-image/v1",
    sourceRevision,
    version,
    imageReference,
    imageDigest,
    controllerRevision: string(
      receipt.controllerRevision,
      "exact-SHA controller revision",
      SHA1,
    ),
    checksRunId: string(
      receipt.checksRunId,
      "exact-SHA checks run ID",
      /^[1-9]\d*$/u,
    ),
    ciReceiptSha256: string(
      receipt.ciReceiptSha256,
      "exact-SHA CI receipt digest",
      SHA256,
    ),
    releaseVerificationKeySha256: keyHash,
    publicRolloutIntentCanaryAuthorityPolicySha256: string(
      receipt.publicRolloutIntentCanaryAuthorityPolicySha256,
      "exact-SHA intent-canary authority policy digest",
      SHA256,
    ),
    runUrl,
    createdAt: timestamp(receipt.createdAt, "exact-SHA receipt creation time"),
  });
}

export function parseNativeSchema20ReleaseArgs(
  argv: readonly string[],
): NativeSchema20ReleaseArgs {
  const allowed = new Set([
    "--exact-sha-image-receipt",
    "--candidate-evidence",
    "--containment-receipt",
    "--guidance-migration-receipt",
    "--release-verification-key-sha256",
    "--candidate-tag",
    "--source-revision",
    "--version",
    "--secret-versions-hash",
    "--expected-image-repository",
    "--origin",
    "--prior-sites-revision",
    "--prior-sites-version",
    "--project-id",
    "--environment",
    "--interactive-service",
    "--deep-service",
    "--api-service",
    "--output",
    "--deployment-timeout-seconds",
    "--poll-interval-seconds",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index] ?? "";
    const value = argv[index + 1] ?? "";
    if (
      !allowed.has(name)
      || !value
      || value.startsWith("--")
      || values.has(name)
    ) {
      throw new Error(`Invalid native point-release argument: ${name || "(missing)"}`);
    }
    values.set(name, value);
  }
  const sourceRevision = string(
    option(values, "--source-revision").toLowerCase(),
    "--source-revision",
    SHA1,
  );
  const version = string(option(values, "--version"), "--version", VERSION);
  const origin = new URL(option(values, "--origin"));
  if (
    origin.origin !== "https://9enio.com"
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
    || origin.username
    || origin.password
  ) {
    throw new Error("--origin must be exactly https://9enio.com");
  }
  const environment = option(values, "--environment");
  if (environment !== "production") {
    throw new Error("--environment must be production");
  }
  const expectedImageRepository =
    option(values, "--expected-image-repository").toLowerCase();
  if (!/^ghcr\.io\/[a-z0-9][a-z0-9._/-]*$/u.test(expectedImageRepository)) {
    throw new Error("--expected-image-repository is invalid");
  }
  const serviceIds = {
    interactive: string(
      option(values, "--interactive-service").toLowerCase(),
      "--interactive-service",
      UUID,
    ),
    deep: string(
      option(values, "--deep-service").toLowerCase(),
      "--deep-service",
      UUID,
    ),
    api: string(
      option(values, "--api-service").toLowerCase(),
      "--api-service",
      UUID,
    ),
  };
  if (new Set(Object.values(serviceIds)).size !== 3) {
    throw new Error("Railway release services must be three distinct existing IDs");
  }
  return {
    exactShaImageReceiptPath: option(values, "--exact-sha-image-receipt"),
    candidateEvidencePath: option(values, "--candidate-evidence"),
    containmentReceiptPath: option(values, "--containment-receipt"),
    guidanceMigrationReceiptPath: option(
      values,
      "--guidance-migration-receipt",
    ),
    releaseVerificationKeySha256: string(
      option(values, "--release-verification-key-sha256").toLowerCase(),
      "--release-verification-key-sha256",
      SHA256,
    ),
    candidateTag: string(
      option(values, "--candidate-tag"),
      "--candidate-tag",
      /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-rc\.[1-9]\d*$/u,
    ),
    sourceRevision,
    version,
    secretVersionsHash: string(
      option(values, "--secret-versions-hash").toLowerCase(),
      "--secret-versions-hash",
      SHA256,
    ),
    expectedImageRepository,
    origin: origin.origin,
    priorSitesRevision: string(
      option(values, "--prior-sites-revision").toLowerCase(),
      "--prior-sites-revision",
      SHA1,
    ),
    priorSitesVersion: string(
      option(values, "--prior-sites-version"),
      "--prior-sites-version",
      VERSION,
    ),
    projectId: string(
      option(values, "--project-id").toLowerCase(),
      "--project-id",
      UUID,
    ),
    environment,
    services: serviceIds,
    outputPath: option(values, "--output"),
    deploymentTimeoutMs: positiveInteger(
      option(values, "--deployment-timeout-seconds"),
      "--deployment-timeout-seconds",
      60,
      1_800,
    ) * 1_000,
    pollIntervalMs: positiveInteger(
      option(values, "--poll-interval-seconds"),
      "--poll-interval-seconds",
      2,
      60,
    ) * 1_000,
  };
}

export function nativeReleaseIdentityVariables(input: {
  version: string;
  sourceRevision: string;
  secretVersionsHash: string;
  candidateEvidenceHash: string;
}): readonly string[] {
  return Object.freeze([
    `APP_VERSION=${input.version}`,
    `SOURCE_COMMIT_SHA=${input.sourceRevision}`,
    "RELEASE_ENVIRONMENT=production",
    // redeploy_native is a control-plane phase. The existing binary contract
    // remains in the already-proven schema-20 native activation state.
    "RELEASE_DEPLOYMENT_PHASE=activate",
    "RELEASE_EXECUTION_ENABLED=true",
    "RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION=20",
    `RELEASE_SECRET_VERSIONS_HASH=${input.secretVersionsHash}`,
    `RELEASE_VERIFIED_CANDIDATE_EVIDENCE_HASH=${input.candidateEvidenceHash}`,
  ]);
}

export function nativeV254RouteSwitchVariablesV1():
Readonly<Record<string, string>> {
  return NATIVE_V254_ROUTE_SWITCH_VARIABLES_V1;
}

/**
 * The bounded owner gate changes only signed owner assignment for the repaired
 * editorial route. Public percentages, including editorial_influence, remain
 * zero until the production Irish publication proof exists.
 */
export function nativeV254OwnerEditorialGateVariablesV1():
Readonly<Record<string, string>> {
  return Object.freeze({
    ...NATIVE_V254_ROUTE_SWITCH_VARIABLES_V1,
    PIPELINE_V3_OWNER_CANARY: "true",
    PIPELINE_V3_OWNER_CANARY_GROUPS: "editorial_influence",
    PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT: "0",
  });
}

/**
 * Public activation is editorial-only. Every unrelated V3 percentage is
 * copied from the quiescent v2.5.4 manifest (zero), so release tooling cannot
 * turn an Irish recovery into an all-intents launch.
 */
export function nativeV254PublicEditorialActivationVariablesV1():
Readonly<Record<string, string>> {
  return Object.freeze({
    ...NATIVE_V254_ROUTE_SWITCH_VARIABLES_V1,
    // Public activation has one authority plane. Owner canaries are disabled
    // so owner identity cannot bypass or diverge from the signed public route.
    PIPELINE_V3_OWNER_CANARY: "false",
    PIPELINE_V3_OWNER_CANARY_GROUPS: "",
    PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT: "100",
  });
}

export function parseRailwayVariableInventory(
  value: string,
): Readonly<Record<string, string>> {
  const parsed = record(JSON.parse(value) as unknown, "Railway variable inventory");
  const variables = "variables" in parsed
    ? record(parsed.variables, "Railway variable inventory variables")
    : parsed;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(variables)) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || typeof item !== "string") {
      throw new Error("Railway variable inventory contains a malformed entry");
    }
    result[key] = item;
  }
  return Object.freeze(result);
}

function commonUnmanagedSemanticValue(
  key: typeof SEMANTIC_EXECUTION_CONFIGURATION_ENV_KEYS_V1[number],
  inventories: readonly Readonly<Record<string, string>>[],
): string | null {
  const observed = inventories.map((inventory) => inventory[key] ?? null);
  if (observed.some((value) => value !== observed[0])) {
    throw new Error(
      `Railway semantic variable ${key} differs across release lanes`,
    );
  }
  return observed[0] ?? null;
}

export function buildNativeV254BehaviorManifest(
  inventories: readonly Readonly<Record<string, string>>[],
): NativeV254BehaviorManifestV1 {
  return buildNativeV254BehaviorManifestForVariables(
    inventories,
    NATIVE_V254_ROUTE_SWITCH_VARIABLES_V1,
  );
}

export function buildNativeV254BehaviorManifestForVariables(
  inventories: readonly Readonly<Record<string, string>>[],
  managedVariables: Readonly<Record<string, string>>,
): NativeV254BehaviorManifestV1 {
  if (inventories.length !== 3) {
    throw new Error("exactly three Railway behavior inventories are required");
  }
  const values: Record<string, string | null> = {};
  for (const key of SEMANTIC_EXECUTION_CONFIGURATION_ENV_KEYS_V1) {
    values[key] = key in managedVariables
      ? managedVariables[key]!
      : commonUnmanagedSemanticValue(key, inventories);
  }
  for (const [key, value] of Object.entries(
    managedVariables,
  )) {
    values[key] = value;
  }
  const environment = Object.fromEntries(
    Object.entries(values)
      .filter((entry): entry is [string, string] => entry[1] !== null),
  ) as NodeJS.ProcessEnv;
  const semanticExecutionConfigurationHash =
    runtimeReleaseContract(environment).semanticExecutionConfigurationHash;
  const unsigned = {
    schemaVersion: "genio-v254-behavior-manifest/v1" as const,
    values: Object.fromEntries(
      NATIVE_V254_BEHAVIOR_KEYS_V1.map((key) => [key, values[key] ?? null]),
    ),
    semanticExecutionConfigurationHash,
  };
  return Object.freeze({
    ...unsigned,
    stagedVariables: Object.freeze(
      Object.entries(unsigned.values)
        .filter((entry): entry is [string, string] => entry[1] !== null)
        .map(([key, value]) => `${key}=${value}`),
    ),
    manifestHash: sha256(unsigned),
  });
}

export function assertRailwayBehaviorManifest(
  inventory: Readonly<Record<string, string>>,
  manifest: NativeV254BehaviorManifestV1,
): void {
  for (const [key, expected] of Object.entries(manifest.values)) {
    const observed = inventory[key] ?? null;
    if (observed !== expected) {
      throw new Error(
        `Railway behavior manifest readback mismatch for ${key}`,
      );
    }
  }
  const observedEnvironment = Object.fromEntries(
    Object.entries(manifest.values)
      .filter((entry): entry is [string, string] => entry[1] !== null)
      .map(([key]) => [key, inventory[key]!]),
  ) as NodeJS.ProcessEnv;
  const observedHash =
    runtimeReleaseContract(observedEnvironment)
      .semanticExecutionConfigurationHash;
  if (observedHash !== manifest.semanticExecutionConfigurationHash) {
    throw new Error("Railway behavior manifest semantic hash mismatch");
  }
}

export function verifyNativeCandidateEvidence(input: {
  value: unknown;
  exactShaReceipt: ExactShaImageReceiptV1;
  expectedTag: string;
  expectedVersion: string;
  expectedRevision: string;
  expectedImageDigest: string;
}): {
  payload: NativeV254CandidateEvidenceV1;
  payloadHash: string;
} {
  const payload = validateNativeV254CandidateEvidence(input.value, {
    candidateTag: input.expectedTag,
    version: input.expectedVersion,
    sourceRevision: input.expectedRevision,
    imageReference: input.exactShaReceipt.imageReference,
    imageDigest: input.expectedImageDigest,
    exactShaImageReceiptHash:
      nativeV254EvidenceHash(input.exactShaReceipt),
    checksRunId: input.exactShaReceipt.checksRunId,
    ciReceiptSha256: input.exactShaReceipt.ciReceiptSha256,
    controllerRevision: input.exactShaReceipt.controllerRevision,
    releaseVerificationKeySha256:
      input.exactShaReceipt.releaseVerificationKeySha256,
    producerRunUrl: input.exactShaReceipt.runUrl,
  });
  return {
    payload,
    payloadHash: payload.payloadHash,
  };
}

export function railwaySelectors(args: NativeSchema20ReleaseArgs): string[] {
  return [
    "--project",
    args.projectId,
    "--environment",
    args.environment,
  ];
}

function parseServiceStatuses(value: string): RailwayServiceStatus[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Railway service inventory is malformed");
  }
  return parsed.map((item, index) => {
    const row = record(item, `Railway service inventory row ${index}`);
    return {
      id: string(row.id, "Railway service ID", UUID),
      name: string(
        row.name,
        "Railway service name",
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u,
      ),
      deploymentId: string(row.deploymentId, "Railway deployment ID", UUID),
      status: string(
        row.status,
        "Railway deployment status",
        /^[A-Z_]+$/u,
      ),
      stopped: row.stopped === true,
    };
  });
}

function parseDeployments(value: string): RailwayDeployment[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Railway deployment inventory is malformed");
  }
  return parsed.map((item, index) => {
    const row = record(item, `Railway deployment row ${index}`);
    const meta = record(row.meta, `Railway deployment metadata ${index}`);
    const image = typeof meta.image === "string" ? meta.image : null;
    const imageDigest =
      typeof meta.imageDigest === "string" ? meta.imageDigest : null;
    return {
      id: string(row.id, "Railway deployment ID", UUID),
      status: string(
        row.status,
        "Railway deployment status",
        /^[A-Z_]+$/u,
      ),
      createdAt: timestamp(row.createdAt, "Railway deployment creation time"),
      meta: { image, imageDigest },
    };
  });
}

export function parseWorkerHeartbeatSnapshot(value: string): WorkerHeartbeatFenceRow[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("worker heartbeat fence snapshot is malformed");
  }
  return parsed.map((item, index) => {
    const row = record(item, `worker heartbeat fence row ${index}`);
    const queueClass = row.queueClass;
    if (queueClass !== "interactive" && queueClass !== "deep") {
      throw new Error("worker heartbeat fence queue class is invalid");
    }
    if (row.protocolVersion !== "playlist-pipeline-v12") {
      throw new Error("worker heartbeat fence protocol is invalid");
    }
    return {
      workerId: string(
        row.workerId,
        "worker heartbeat fence worker ID",
        /^[0-9A-Za-z][0-9A-Za-z._:+-]{0,159}$/u,
      ),
      queueClass,
      revision: string(
        row.revision,
        "worker heartbeat fence revision",
        SHA1,
      ),
      protocolVersion: "playlist-pipeline-v12",
      semanticExecutionConfigurationHash: string(
        row.semanticExecutionConfigurationHash,
        "worker heartbeat fence semantic configuration",
        SHA256,
      ),
      lastSeenAt: timestamp(
        row.lastSeenAt,
        "worker heartbeat fence last-seen time",
      ),
    };
  });
}

export function assertWorkerHeartbeatFence(input: {
  first: readonly WorkerHeartbeatFenceRow[];
  second: readonly WorkerHeartbeatFenceRow[];
  sourceRevision: string;
  semanticExecutionConfigurationHash: string;
}): void {
  const lane = (
    rows: readonly WorkerHeartbeatFenceRow[],
    queueClass: "interactive" | "deep",
  ) => rows.filter((row) => row.queueClass === queueClass);
  for (const queueClass of ["interactive", "deep"] as const) {
    const first = lane(input.first, queueClass);
    const second = lane(input.second, queueClass);
    if (
      first.length !== 1
      || second.length !== 1
      || first[0]!.workerId !== second[0]!.workerId
      || first[0]!.revision !== input.sourceRevision
      || second[0]!.revision !== input.sourceRevision
      || first[0]!.semanticExecutionConfigurationHash
        !== input.semanticExecutionConfigurationHash
      || second[0]!.semanticExecutionConfigurationHash
        !== input.semanticExecutionConfigurationHash
      || Date.parse(second[0]!.lastSeenAt) <= Date.parse(first[0]!.lastSeenAt)
    ) {
      throw new Error(
        `candidate ${queueClass} heartbeat fence did not advance exclusively`,
      );
    }
  }
}

export function assertExistingReleaseServices(
  inventory: readonly RailwayServiceStatus[],
  expected: NativeSchema20ReleaseArgs["services"],
): void {
  for (const [lane, expectedName] of Object.entries(REQUIRED_SERVICE_NAMES)) {
    const serviceId = expected[lane as keyof typeof expected];
    const match = inventory.find((service) => service.id === serviceId);
    if (!match || match.name !== expectedName || match.stopped) {
      throw new Error(
        `Railway ${lane} release target is not the expected running ${expectedName} service`,
      );
    }
  }
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : -1;
}

export function assertNativeSchema20Preflight(value: unknown): void {
  const system = record(value, "production system health");
  const workerProtocol = record(
    system.workerProtocol,
    "production worker protocol",
  );
  const fencing = record(system.executorFencing, "production executor fencing");
  const queue = record(system.queue, "production queue");
  const rollout = record(system.publicRollout, "production public rollout");
  if (
    system.ok !== true
    || system.activationReady !== true
    || system.schemaVersion !== "20"
    || system.proofArchitectureVersion !== "1"
    || system.proofArchitectureAuthority !== "native"
    || workerProtocol.actual !== "playlist-pipeline-v12"
    || fencing.ready !== true
    || number(fencing.uncoveredJobs) !== 0
    || number(fencing.incompleteJobs) !== 0
    || number(queue.queued) !== 0
    || number(queue.leased) !== 0
    || rollout.databaseAuthorized !== true
    || rollout.active !== false
  ) {
    throw new Error(
      "production is not quiescent on healthy schema-20 native protocol-12 owner-only authority",
    );
  }
}

export function candidateRuntimeHashes(value: unknown, input: {
  sourceRevision: string;
  version: string;
}): {
  api: string;
  interactive: string;
  deep: string;
  semantic: string;
} {
  const system = record(value, "candidate system health");
  const api = record(system.api, "candidate API identity");
  const build = record(api.build, "candidate API build");
  const lanes = record(system.workerLanes, "candidate worker lanes");
  const lane = (name: "interactive" | "deep") => {
    const value = record(lanes[name], `candidate ${name} worker lane`);
    const revisions = value.eligibleRevisions;
    const configurations = value.eligibleConfigurationHashes;
    const semantics = value.eligibleSemanticExecutionConfigurationHashes;
    if (
      value.status !== "healthy"
      || value.protocolVersion !== "playlist-pipeline-v12"
      || value.eligibleIdentityCount !== 1
      || !Array.isArray(revisions)
      || revisions.length !== 1
      || revisions[0] !== input.sourceRevision
      || !Array.isArray(configurations)
      || configurations.length !== 1
      || typeof configurations[0] !== "string"
      || !SHA256.test(configurations[0])
      || !Array.isArray(semantics)
      || semantics.length !== 1
      || typeof semantics[0] !== "string"
      || !SHA256.test(semantics[0])
    ) {
      throw new Error(`candidate ${name} worker lane is not exclusively ready`);
    }
    return {
      configuration: configurations[0],
      semantic: semantics[0],
    };
  };
  const interactive = lane("interactive");
  const deep = lane("deep");
  const apiConfiguration = string(
    api.configurationHash,
    "candidate API configuration hash",
    SHA256,
  );
  const apiSemantic = string(
    api.semanticExecutionConfigurationHash,
    "candidate API semantic configuration hash",
    SHA256,
  );
  if (
    build.version !== input.version
    || build.revision !== input.sourceRevision
    || apiSemantic !== interactive.semantic
    || apiSemantic !== deep.semantic
  ) {
    throw new Error("candidate API and worker semantic identities do not converge");
  }
  assertNativeSchema20Preflight(system);
  return {
    api: apiConfiguration,
    interactive: interactive.configuration,
    deep: deep.configuration,
    semantic: apiSemantic,
  };
}

class ProcessCommandRunner implements NativeReleaseCommandRunner {
  async run(command: string, args: readonly string[]): Promise<string> {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        const safeMessage = redactNativeSchema20PromotionCommandStderr(stderr);
        reject(new Error(
          `${command} exited with status ${code ?? "unknown"}: ${safeMessage}`,
        ));
      });
    });
  }
}

export function redactNativeSchema20PromotionCommandStderr(
  stderr: string,
): string {
  // Provider CLIs can echo credentials in arbitrary formats. Never treat
  // unrecognized stderr as safe production release-log content.
  return stderr.trim().length > 0
    ? "[redacted Railway stderr]"
    : "[no Railway stderr]";
}

export function defaultNativeReleaseRuntime(): NativeReleaseRuntime {
  return {
    commandRunner: new ProcessCommandRunner(),
    async fetchJson(url) {
      const response = await fetch(url, {
        cache: "no-store",
        redirect: "error",
        headers: { "cache-control": "no-cache", pragma: "no-cache" },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      let value: unknown = {};
      try {
        value = text ? JSON.parse(text) : {};
      } catch {
        // The strict caller reports only the response class, never its body.
      }
      return { status: response.status, value };
    },
    async wait(ms) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
    now: () => Date.now(),
  };
}

export async function latestDeployments(
  args: NativeSchema20ReleaseArgs,
  runtime: NativeReleaseRuntime,
  serviceId: string,
): Promise<RailwayDeployment[]> {
  return parseDeployments(await runtime.commandRunner.run("railway", [
    "deployment",
    "list",
    "--service",
    serviceId,
    ...railwaySelectors(args),
    "--limit",
    "5",
    "--json",
  ]));
}

export async function railwayVariableInventory(
  args: NativeSchema20ReleaseArgs,
  runtime: NativeReleaseRuntime,
  serviceId: string,
): Promise<Readonly<Record<string, string>>> {
  return parseRailwayVariableInventory(
    await runtime.commandRunner.run("railway", [
      "variable",
      "list",
      "--service",
      serviceId,
      ...railwaySelectors(args),
      "--json",
    ]),
  );
}

export function schema20EvidenceRecoveryCommandArgs(input: {
  args: NativeSchema20ReleaseArgs;
  sourceRevision: string;
  semanticExecutionConfigurationHash: string;
  mode: "dry-run" | "apply";
  receiptHash?: string;
}): readonly string[] {
  const modeArguments = input.mode === "apply"
    ? ["apply", string(
      input.receiptHash,
      "schema-20 evidence recovery receipt hash",
      SHA256,
    )]
    : ["dry-run"];
  return Object.freeze([
    "run",
    "--service",
    "Postgres",
    ...railwaySelectors(input.args),
    "--no-local",
    "--",
    "env",
    `EXPECTED_RELEASE_REVISION=${input.sourceRevision}`,
    `EXPECTED_SEMANTIC_CONFIGURATION_HASH=${
      input.semanticExecutionConfigurationHash
    }`,
    "WORKER_STALE_SECONDS=90",
    "node",
    "--experimental-transform-types",
    "scripts/activate-schema20-evidence-recovery.ts",
    ...modeArguments,
  ]);
}

export function legacyExecutionRouteDrainInventoryCommandArgs(input: {
  args: NativeSchema20ReleaseArgs;
  sourceRevision: string;
  semanticExecutionConfigurationHash: string;
  acceptedBefore: string;
  inventoriedAt: string;
  mode: "dry-run" | "apply" | "status";
  receiptHash?: string;
}): readonly string[] {
  const modeArguments = input.receiptHash
    ? [input.mode, string(
        input.receiptHash,
        "legacy route drain inventory receipt hash",
        SHA256,
      )]
    : [input.mode];
  return Object.freeze([
    "run",
    "--service",
    "Postgres",
    ...railwaySelectors(input.args),
    "--no-local",
    "--",
    "env",
    `EXPECTED_RELEASE_REVISION=${input.sourceRevision}`,
    `EXPECTED_SEMANTIC_CONFIGURATION_HASH=${
      input.semanticExecutionConfigurationHash
    }`,
    `LEGACY_ROUTE_DRAIN_ACCEPTED_BEFORE=${input.acceptedBefore}`,
    `LEGACY_ROUTE_DRAIN_INVENTORIED_AT=${input.inventoriedAt}`,
    "node",
    "--experimental-transform-types",
    "scripts/inventory-legacy-execution-route-drain.ts",
    ...modeArguments,
  ]);
}

export function parseLegacyExecutionRouteDrainInventoryResult(
  value: string,
  expectedMode: "dry-run" | "apply" | "status",
): {
  receiptHash: string;
  jobCount: number;
  drained: boolean | null;
} {
  const parsed = record(
    JSON.parse(value) as unknown,
    "legacy route drain inventory result",
  );
  const receiptHash = string(
    parsed.receiptHash,
    "legacy route drain inventory receipt hash",
    SHA256,
  );
  const jobCount = Number(parsed.jobCount);
  if (
    parsed.mode !== expectedMode
    || !Number.isSafeInteger(jobCount)
    || jobCount < 0
    || (expectedMode === "dry-run" && parsed.safeToApply !== true)
    || (
      expectedMode === "apply"
      && parsed.applied !== true
      && parsed.applied !== false
    )
    || (
      expectedMode === "status"
      && (
        parsed.inventoryIntact !== true
        || typeof parsed.drained !== "boolean"
        || !Number.isSafeInteger(Number(parsed.activeJobCount))
        || Number(parsed.activeJobCount) < 0
        || !Number.isSafeInteger(Number(parsed.unreceiptedJobCount))
        || Number(parsed.unreceiptedJobCount) < 0
      )
    )
  ) {
    throw new Error(
      `legacy route drain inventory ${expectedMode} did not prove authority`,
    );
  }
  return {
    receiptHash,
    jobCount,
    drained: expectedMode === "status" ? parsed.drained as boolean : null,
  };
}

export function parseSchema20EvidenceRecoveryResult(
  value: string,
  expectedMode: "dry-run" | "apply",
): { receiptHash: string } {
  const parsed = record(
    JSON.parse(value) as unknown,
    "schema-20 evidence recovery result",
  );
  const receiptHash = string(
    parsed.receiptHash,
    "schema-20 evidence recovery receipt hash",
    SHA256,
  );
  if (
    parsed.mode !== expectedMode
    || (expectedMode === "dry-run" && parsed.safeToApply !== true)
    || (expectedMode === "apply"
      && (
        parsed.applied !== true
        || parsed.constraint
          !== "playlist_qualification_candidate_required_v1"
        || parsed.constraintValidated !== false
        || parsed.routeTrigger
          !== "contract3_execution_route_receipt_required_v1"
        || parsed.legacyUnboundImmutabilityTrigger
          !== "legacy_unbound_qualification_immutable_v1"
      ))
  ) {
    throw new Error(
      `schema-20 evidence recovery ${expectedMode} did not prove activation`,
    );
  }
  return { receiptHash };
}

export function validateV254ContainmentReceipt(
  value: unknown,
): { receiptHash: string; affectedRunCount: number } {
  const receipt = record(value, "v2.5.4 containment receipt");
  if (
    receipt.mode !== "contain-apply"
    || (receipt.applied !== true && receipt.applied !== false)
    || receipt.incidentReference
      !== "v254-irish-influence-evidence-persistence"
    || receipt.hardSwitchRemainsEngaged !== true
    || receipt.intentPublicPauseRemainsEngaged !== true
    || receipt.safeRoutesResumed !== true
  ) {
    throw new Error(
      "v2.5.4 containment receipt does not prove safe route recovery",
    );
  }
  const affectedRunCount = Number(receipt.affectedRunCount);
  if (!Number.isSafeInteger(affectedRunCount) || affectedRunCount < 1) {
    throw new Error("v2.5.4 containment receipt has no affected runs");
  }
  string(
    receipt.affectedRunSetHash,
    "v2.5.4 containment affected run-set hash",
    SHA256,
  );
  string(
    receipt.observedCountsHash,
    "v2.5.4 containment observed counts hash",
    SHA256,
  );
  const ownerReviewProof = record(
    receipt.ownerReviewPromotionProof,
    "v2.5.4 containment owner-review promotion proof",
  );
  const ownerReviewProofKeys = [
    "candidateCount",
    "candidateSetHash",
    "dispositionCount",
    "dispositionSetHash",
    "undispositionedCount",
    "unresolvedExecutableWorkCount",
    "unresolvedPublicationWorkCount",
    "promotionSafe",
  ] as const;
  exactKeys(
    ownerReviewProof,
    ownerReviewProofKeys,
    "v2.5.4 containment owner-review promotion proof",
  );
  const candidateCount = number(ownerReviewProof.candidateCount);
  const dispositionCount = number(ownerReviewProof.dispositionCount);
  const undispositionedCount = number(ownerReviewProof.undispositionedCount);
  const unresolvedExecutableWorkCount =
    number(ownerReviewProof.unresolvedExecutableWorkCount);
  const unresolvedPublicationWorkCount =
    number(ownerReviewProof.unresolvedPublicationWorkCount);
  for (const [label, count] of [
    ["candidate", candidateCount],
    ["disposition", dispositionCount],
    ["undispositioned", undispositionedCount],
    ["unresolved executable work", unresolvedExecutableWorkCount],
    ["unresolved publication work", unresolvedPublicationWorkCount],
  ] as const) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(
        `v2.5.4 containment owner-review ${label} count is invalid`,
      );
    }
  }
  const candidateSetHash = string(
    ownerReviewProof.candidateSetHash,
    "v2.5.4 containment owner-review candidate-set hash",
    SHA256,
  );
  const dispositionSetHash = string(
    ownerReviewProof.dispositionSetHash,
    "v2.5.4 containment owner-review disposition-set hash",
    SHA256,
  );
  const promotionSafe = ownerReviewProof.promotionSafe === true;
  const provedSafe = candidateCount === 0 || (
    dispositionCount === candidateCount
    && undispositionedCount === 0
    && unresolvedExecutableWorkCount === 0
    && unresolvedPublicationWorkCount === 0
  );
  if (
    !promotionSafe
    || !provedSafe
    || dispositionCount > candidateCount
    || undispositionedCount !== candidateCount - dispositionCount
    || receipt.ownerReviewCandidateCount !== candidateCount
    || receipt.ownerReviewCandidateSetHash !== candidateSetHash
    || receipt.ownerReviewDispositionCount !== dispositionCount
    || receipt.ownerReviewDispositionSetHash !== dispositionSetHash
    || receipt.ownerReviewUndispositionedCount !== undispositionedCount
    || receipt.ownerReviewUnresolvedExecutableWorkCount
      !== unresolvedExecutableWorkCount
    || receipt.ownerReviewUnresolvedPublicationWorkCount
      !== unresolvedPublicationWorkCount
    || receipt.ownerReviewPromotionSafe !== true
    || receipt.ownerReviewPromotionProofHash !== sha256(ownerReviewProof)
  ) {
    throw new Error(
      "v2.5.4 containment owner-review inventory is not safely dispositioned",
    );
  }
  const countKeys = [
    "jobsCancelled",
    "blockerResolved",
    "transitionInserted",
    "resolutionUpdated",
    "outboxInserted",
    "runUpdated",
    "auditInserted",
    "pausesCleared",
  ] as const;
  const expectedCounts = record(
    receipt.expectedMutationCounts,
    "v2.5.4 containment expected mutation counts",
  );
  const actualCounts = record(
    receipt.actualMutationCounts,
    "v2.5.4 containment actual mutation counts",
  );
  const compatibilityCounts = record(
    receipt.mutationCounts,
    "v2.5.4 containment compatibility mutation counts",
  );
  for (const [label, counts] of [
    ["expected", expectedCounts],
    ["actual", actualCounts],
    ["compatibility", compatibilityCounts],
  ] as const) {
    exactKeys(counts, countKeys, `v2.5.4 containment ${label} mutation counts`);
    for (const key of countKeys) {
      const count = number(counts[key]);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error(
          `v2.5.4 containment ${label} mutation count ${key} is invalid`,
        );
      }
    }
  }
  const expectedAppliedCounts = receipt.applied === true
    ? {
        jobsCancelled: 0,
        blockerResolved: 1,
        transitionInserted: 1,
        resolutionUpdated: 1,
        outboxInserted: 1,
        runUpdated: 1,
        auditInserted: 1,
        pausesCleared: 2,
      }
    : {
        jobsCancelled: 0,
        blockerResolved: 0,
        transitionInserted: 0,
        resolutionUpdated: 0,
        outboxInserted: 0,
        runUpdated: 0,
        auditInserted: 0,
        pausesCleared: 2,
      };
  const countsMatch = (counts: JsonRecord) => countKeys.every(
    (key) => counts[key] === expectedAppliedCounts[key],
  );
  if (
    !countsMatch(expectedCounts)
    || !countsMatch(actualCounts)
    || !countsMatch(compatibilityCounts)
  ) {
    throw new Error(
      "v2.5.4 containment mutation counts do not prove the expected apply",
    );
  }
  const expectedCountsHash = sha256(expectedCounts);
  if (
    receipt.expectedMutationCountsHash !== expectedCountsHash
    || receipt.actualMutationCountsHash !== sha256(actualCounts)
    || receipt.mutationCountsHash !== sha256(compatibilityCounts)
  ) {
    throw new Error("v2.5.4 containment mutation count hash is invalid");
  }
  return {
    receiptHash: string(
      receipt.receiptHash,
      "v2.5.4 containment receipt hash",
      SHA256,
    ),
    affectedRunCount,
  };
}

async function activateSchema20EvidenceRecovery(input: {
  args: NativeSchema20ReleaseArgs;
  runtime: NativeReleaseRuntime;
  sourceRevision: string;
  semanticExecutionConfigurationHash: string;
}): Promise<string> {
  const dryRun = parseSchema20EvidenceRecoveryResult(
    await input.runtime.commandRunner.run("railway",
      schema20EvidenceRecoveryCommandArgs({
        ...input,
        mode: "dry-run",
      })),
    "dry-run",
  );
  const applied = parseSchema20EvidenceRecoveryResult(
    await input.runtime.commandRunner.run("railway",
      schema20EvidenceRecoveryCommandArgs({
        ...input,
        mode: "apply",
        receiptHash: dryRun.receiptHash,
      })),
    "apply",
  );
  if (applied.receiptHash !== dryRun.receiptHash) {
    throw new Error(
      "schema-20 evidence recovery changed between dry-run and apply",
    );
  }
  return applied.receiptHash;
}

async function inventoryLegacyExecutionRouteDrain(input: {
  args: NativeSchema20ReleaseArgs;
  runtime: NativeReleaseRuntime;
  sourceRevision: string;
  semanticExecutionConfigurationHash: string;
  acceptedBefore: string;
  inventoriedAt: string;
}): Promise<{ receiptHash: string; jobCount: number }> {
  const common = {
    args: input.args,
    sourceRevision: input.sourceRevision,
    semanticExecutionConfigurationHash:
      input.semanticExecutionConfigurationHash,
    acceptedBefore: input.acceptedBefore,
    inventoriedAt: input.inventoriedAt,
  };
  const dryRun = parseLegacyExecutionRouteDrainInventoryResult(
    await input.runtime.commandRunner.run("railway",
      legacyExecutionRouteDrainInventoryCommandArgs({
        ...common,
        mode: "dry-run",
      })),
    "dry-run",
  );
  const applied = parseLegacyExecutionRouteDrainInventoryResult(
    await input.runtime.commandRunner.run("railway",
      legacyExecutionRouteDrainInventoryCommandArgs({
        ...common,
        mode: "apply",
        receiptHash: dryRun.receiptHash,
      })),
    "apply",
  );
  if (
    applied.receiptHash !== dryRun.receiptHash
    || applied.jobCount !== dryRun.jobCount
  ) {
    throw new Error(
      "legacy route drain inventory changed between dry-run and apply",
    );
  }
  return {
    receiptHash: applied.receiptHash,
    jobCount: applied.jobCount,
  };
}

async function waitForLegacyExecutionRouteDrain(input: {
  args: NativeSchema20ReleaseArgs;
  runtime: NativeReleaseRuntime;
  sourceRevision: string;
  semanticExecutionConfigurationHash: string;
  acceptedBefore: string;
  inventoriedAt: string;
  receiptHash: string;
  jobCount: number;
}): Promise<void> {
  const deadline = input.runtime.now() + input.args.deploymentTimeoutMs;
  while (input.runtime.now() < deadline) {
    const observed = parseLegacyExecutionRouteDrainInventoryResult(
      await input.runtime.commandRunner.run("railway",
        legacyExecutionRouteDrainInventoryCommandArgs({
          ...input,
          mode: "status",
        })),
      "status",
    );
    if (
      observed.receiptHash !== input.receiptHash
      || observed.jobCount !== input.jobCount
    ) {
      throw new Error("legacy route drain inventory identity changed");
    }
    if (observed.drained) return;
    await input.runtime.wait(input.args.pollIntervalMs);
  }
  throw new Error("legacy execution route drain did not become quiescent");
}

async function pollDeployment(input: {
  args: NativeSchema20ReleaseArgs;
  runtime: NativeReleaseRuntime;
  serviceId: string;
  previousDeploymentId: string;
  imageReference: string;
  imageDigest: string;
}): Promise<string> {
  const deadline = input.runtime.now() + input.args.deploymentTimeoutMs;
  while (input.runtime.now() < deadline) {
    const deployments = await latestDeployments(
      input.args,
      input.runtime,
      input.serviceId,
    );
    const candidate = deployments.find((deployment) => (
      deployment.id !== input.previousDeploymentId
      && deployment.meta.image === input.imageReference
      && deployment.meta.imageDigest === input.imageDigest
    ));
    if (candidate?.status === "SUCCESS") return candidate.id;
    if (candidate && TERMINAL_FAILURES.has(candidate.status)) {
      throw new Error(
        `Railway deployment ${candidate.id} failed with ${candidate.status}`,
      );
    }
    await input.runtime.wait(input.args.pollIntervalMs);
  }
  throw new Error(`Railway deployment timed out for service ${input.serviceId}`);
}

export async function promoteService(input: {
  args: NativeSchema20ReleaseArgs;
  runtime: NativeReleaseRuntime;
  serviceId: string;
  imageReference: string;
  imageDigest: string;
}): Promise<{
  deploymentId: string;
  previousDeployment: {
    deploymentId: string;
    imageReference: string;
    imageDigest: string;
  };
}> {
  const previous = (await latestDeployments(
    input.args,
    input.runtime,
    input.serviceId,
  ))[0];
  if (!previous) {
    throw new Error(`Railway service ${input.serviceId} has no deployment`);
  }
  const previousImageReference = string(
    previous.meta.image,
    `Railway service ${input.serviceId} prior image reference`,
    IMAGE_REFERENCE,
  );
  const previousImageDigest = string(
    previous.meta.imageDigest,
    `Railway service ${input.serviceId} prior image digest`,
    IMAGE_DIGEST,
  );
  if (!previousImageReference.endsWith(`@${previousImageDigest}`)) {
    throw new Error(
      `Railway service ${input.serviceId} prior image identity is inconsistent`,
    );
  }
  if (
    previous.meta.image === input.imageReference
    && previous.meta.imageDigest === input.imageDigest
  ) {
    await input.runtime.commandRunner.run("railway", [
      "redeploy",
      "--service",
      input.serviceId,
      ...railwaySelectors(input.args),
      "--yes",
      "--json",
    ]);
  } else {
    await input.runtime.commandRunner.run("railway", [
      "service",
      "source",
      "connect",
      "--image",
      input.imageReference,
      "--service",
      input.serviceId,
      ...railwaySelectors(input.args),
      "--json",
    ]);
  }
  const deploymentId = await pollDeployment({
    ...input,
    previousDeploymentId: previous.id,
  });
  return {
    deploymentId,
    previousDeployment: {
      deploymentId: previous.id,
      imageReference: previousImageReference,
      imageDigest: previousImageDigest,
    },
  };
}

export async function workerHeartbeatSnapshot(
  args: NativeSchema20ReleaseArgs,
  runtime: NativeReleaseRuntime,
): Promise<WorkerHeartbeatFenceRow[]> {
  const output = await runtime.commandRunner.run("railway", [
    "run",
    "--service",
    "Postgres",
    ...railwaySelectors(args),
    "--no-local",
    "--",
    "node",
    "--experimental-transform-types",
    "scripts/promote-native-schema20-release.ts",
    "heartbeat-snapshot",
  ]);
  return parseWorkerHeartbeatSnapshot(output);
}

function exclusiveCandidateHeartbeats(
  rows: readonly WorkerHeartbeatFenceRow[],
  sourceRevision: string,
  semanticExecutionConfigurationHash: string,
): boolean {
  return (["interactive", "deep"] as const).every((queueClass) => {
    const lane = rows.filter((row) => row.queueClass === queueClass);
    return lane.length === 1
      && lane[0]!.revision === sourceRevision
      && lane[0]!.semanticExecutionConfigurationHash
        === semanticExecutionConfigurationHash;
  });
}

export async function waitForExclusiveCandidateHeartbeats(input: {
  args: NativeSchema20ReleaseArgs;
  runtime: NativeReleaseRuntime;
  sourceRevision: string;
  semanticExecutionConfigurationHash: string;
}): Promise<WorkerHeartbeatFenceRow[]> {
  const deadline = input.runtime.now() + input.args.deploymentTimeoutMs;
  while (input.runtime.now() < deadline) {
    const snapshot = await workerHeartbeatSnapshot(input.args, input.runtime);
    if (exclusiveCandidateHeartbeats(
      snapshot,
      input.sourceRevision,
      input.semanticExecutionConfigurationHash,
    )) {
      return snapshot;
    }
    await input.runtime.wait(input.args.pollIntervalMs);
  }
  throw new Error(
    "candidate worker heartbeats did not become exclusively eligible",
  );
}

async function health(
  runtime: NativeReleaseRuntime,
  origin: string,
  path: string,
): Promise<unknown> {
  const result = await runtime.fetchJson(
    `${origin}${path}?native-point-release=${randomUUID()}`,
  );
  if (result.status !== 200) {
    throw new Error(`${path} returned HTTP ${result.status}`);
  }
  return result.value;
}

async function requireCandidateBackendHealth(input: {
  args: NativeSchema20ReleaseArgs;
  runtime: NativeReleaseRuntime;
  behaviorManifest: NativeV254BehaviorManifestV1;
  phase: "before_schema20_recovery" | "after_schema20_recovery";
}): Promise<ReturnType<typeof candidateRuntimeHashes>> {
  const live = record(
    await health(input.runtime, input.args.origin, "/health/live"),
    `${input.phase} candidate liveness`,
  );
  const liveBuild = record(
    live.build ?? live,
    `${input.phase} candidate liveness build`,
  );
  if (
    liveBuild.version !== input.args.version
    || liveBuild.revision !== input.args.sourceRevision
  ) {
    throw new Error(
      `${input.phase} candidate liveness does not expose the exact release`,
    );
  }
  await health(input.runtime, input.args.origin, "/health/ready");
  const system = await health(
    input.runtime,
    input.args.origin,
    "/health/system",
  );
  const hashes = candidateRuntimeHashes(system, {
    sourceRevision: input.args.sourceRevision,
    version: input.args.version,
  });
  if (
    hashes.semantic
      !== input.behaviorManifest.semanticExecutionConfigurationHash
  ) {
    throw new Error(
      `${input.phase} production semantic execution configuration does not match the staged manifest`,
    );
  }
  return hashes;
}

export async function runNativeSchema20Promotion(
  args: NativeSchema20ReleaseArgs,
  runtime: NativeReleaseRuntime = defaultNativeReleaseRuntime(),
): Promise<NativeSchema20PromotionReceiptV1> {
  const [
    receiptValue,
    evidenceValue,
    containmentValue,
    guidanceMigrationValue,
  ] = await Promise.all([
    readFile(args.exactShaImageReceiptPath, "utf8").then(JSON.parse),
    readFile(args.candidateEvidencePath, "utf8").then(JSON.parse),
    readFile(args.containmentReceiptPath, "utf8").then(JSON.parse),
    readFile(args.guidanceMigrationReceiptPath, "utf8").then(JSON.parse),
  ]);
  const exactShaReceipt = validateExactShaImageReceipt(receiptValue, {
    sourceRevision: args.sourceRevision,
    version: args.version,
    imageRepository: args.expectedImageRepository,
    releaseVerificationKeySha256: args.releaseVerificationKeySha256,
  });
  const verifiedCandidate = verifyNativeCandidateEvidence({
    value: evidenceValue,
    exactShaReceipt,
    expectedTag: args.candidateTag,
    expectedVersion: args.version,
    expectedRevision: args.sourceRevision,
    expectedImageDigest: exactShaReceipt.imageDigest,
  });
  const containment = validateV254ContainmentReceipt(containmentValue);
  const guidanceMigration = validateV254GuidanceMigrationReceiptV1(
    guidanceMigrationValue,
    { sourceRevision: args.sourceRevision },
  );
  assertNativeSchema20Preflight(await health(
    runtime,
    args.origin,
    "/health/system",
  ));
  const inventory = parseServiceStatuses(
    await runtime.commandRunner.run("railway", [
      "service",
      "list",
      ...railwaySelectors(args),
      "--json",
    ]),
  );
  assertExistingReleaseServices(inventory, args.services);
  const serviceIds = [
    args.services.interactive,
    args.services.deep,
    args.services.api,
  ] as const;
  const existingBehaviorInventories = await Promise.all(
    serviceIds.map((serviceId) => (
      railwayVariableInventory(args, runtime, serviceId)
    )),
  );
  const behaviorManifest = buildNativeV254BehaviorManifest(
    existingBehaviorInventories,
  );
  const identityVariables = nativeReleaseIdentityVariables({
    version: args.version,
    sourceRevision: args.sourceRevision,
    secretVersionsHash: args.secretVersionsHash,
    candidateEvidenceHash: verifiedCandidate.payloadHash,
  });
  for (const serviceId of serviceIds) {
    await runtime.commandRunner.run("railway", [
      "variable",
      "set",
      ...identityVariables,
      ...behaviorManifest.stagedVariables,
      "--service",
      serviceId,
      ...railwaySelectors(args),
      "--skip-deploys",
      "--json",
    ]);
  }
  const stagedBehaviorInventories = await Promise.all(
    serviceIds.map((serviceId) => (
      railwayVariableInventory(args, runtime, serviceId)
    )),
  );
  for (const staged of stagedBehaviorInventories) {
    assertRailwayBehaviorManifest(staged, behaviorManifest);
  }
  // Persist the exact pre-cutover Contract-3 job inventory before either new
  // worker can claim. The receipt re-fences only those enumerated jobs to this
  // candidate; every absent or post-cutoff job remains fail-closed.
  const legacyDrainInventoryTime =
    new Date(runtime.now()).toISOString();
  const legacyDrainInventory =
    await inventoryLegacyExecutionRouteDrain({
      args,
      runtime,
      sourceRevision: args.sourceRevision,
      semanticExecutionConfigurationHash:
        behaviorManifest.semanticExecutionConfigurationHash,
      acceptedBefore: legacyDrainInventoryTime,
      inventoriedAt: legacyDrainInventoryTime,
    });
  const interactivePromotion = await promoteService({
    args,
    runtime,
    serviceId: args.services.interactive,
    imageReference: exactShaReceipt.imageReference,
    imageDigest: exactShaReceipt.imageDigest,
  });
  const deepPromotion = await promoteService({
    args,
    runtime,
    serviceId: args.services.deep,
    imageReference: exactShaReceipt.imageReference,
    imageDigest: exactShaReceipt.imageDigest,
  });
  // The API remains on the prior proven artifact until both new worker lanes
  // have become the only fresh heartbeats and the same worker IDs advance in a
  // second observation at least 30 seconds later.
  const firstHeartbeatSnapshot = await waitForExclusiveCandidateHeartbeats({
    args,
    runtime,
    sourceRevision: args.sourceRevision,
    semanticExecutionConfigurationHash:
      behaviorManifest.semanticExecutionConfigurationHash,
  });
  await runtime.wait(30_000);
  const secondHeartbeatSnapshot = await workerHeartbeatSnapshot(args, runtime);
  assertWorkerHeartbeatFence({
    first: firstHeartbeatSnapshot,
    second: secondHeartbeatSnapshot,
    sourceRevision: args.sourceRevision,
    semanticExecutionConfigurationHash:
      behaviorManifest.semanticExecutionConfigurationHash,
  });
  await waitForLegacyExecutionRouteDrain({
    args,
    runtime,
    sourceRevision: args.sourceRevision,
    semanticExecutionConfigurationHash:
      behaviorManifest.semanticExecutionConfigurationHash,
    acceptedBefore: legacyDrainInventoryTime,
    inventoriedAt: legacyDrainInventoryTime,
    receiptHash: legacyDrainInventory.receiptHash,
    jobCount: legacyDrainInventory.jobCount,
  });
  const apiPromotion = await promoteService({
    args,
    runtime,
    serviceId: args.services.api,
    imageReference: exactShaReceipt.imageReference,
    imageDigest: exactShaReceipt.imageDigest,
  });
  const preActivationHashes = await requireCandidateBackendHealth({
    args,
    runtime,
    behaviorManifest,
    phase: "before_schema20_recovery",
  });
  const schema20EvidenceRecoveryReceiptHash =
    await activateSchema20EvidenceRecovery({
      args,
      runtime,
      sourceRevision: args.sourceRevision,
      semanticExecutionConfigurationHash:
        behaviorManifest.semanticExecutionConfigurationHash,
    });
  const hashes = await requireCandidateBackendHealth({
    args,
    runtime,
    behaviorManifest,
    phase: "after_schema20_recovery",
  });
  if (
    hashes.api !== preActivationHashes.api
    || hashes.interactive !== preActivationHashes.interactive
    || hashes.deep !== preActivationHashes.deep
    || hashes.semantic !== preActivationHashes.semantic
  ) {
    throw new Error(
      "candidate runtime identity changed during schema-20 recovery activation",
    );
  }
  const convergence = await collectReleaseConvergenceEvidence(
    parseReleaseConvergenceArgs([
      "--origin",
      args.origin,
      "--scope",
      "backend",
      "--expected-revision",
      args.sourceRevision,
      "--expected-version",
      args.version,
      "--expected-sites-revision",
      args.priorSitesRevision,
      "--expected-sites-version",
      args.priorSitesVersion,
      "--samples",
      "2",
      "--interval-seconds",
      "30",
      "--expected-api-configuration-hash",
      hashes.api,
      "--expected-interactive-configuration-hash",
      hashes.interactive,
      "--expected-deep-configuration-hash",
      hashes.deep,
      "--expected-semantic-execution-configuration-hash",
      hashes.semantic,
    ]),
  );
  if (!convergence.passed) {
    throw new Error(
      `backend convergence failed: ${convergence.violations.join(",")}`,
    );
  }
  const unsigned = {
    schemaVersion: "genio-native-schema20-promotion/v1" as const,
    sourceRevision: args.sourceRevision,
    version: args.version,
    imageReference: exactShaReceipt.imageReference,
    imageDigest: exactShaReceipt.imageDigest,
    candidateEvidenceHash: verifiedCandidate.payloadHash,
    exactShaImageReceiptHash: sha256(exactShaReceipt),
    semanticBehaviorManifestHash: behaviorManifest.manifestHash,
    semanticExecutionConfigurationHash:
      behaviorManifest.semanticExecutionConfigurationHash,
    containmentReceiptHash: containment.receiptHash,
    guidanceCheckpointMigrationReceiptHash: guidanceMigration.receiptHash,
    legacyExecutionRouteDrainInventoryReceiptHash:
      legacyDrainInventory.receiptHash,
    schema20EvidenceRecoveryReceiptHash,
    projectId: args.projectId,
    environment: "production" as const,
    services: {
      interactive: {
        serviceId: args.services.interactive,
        deploymentId: interactivePromotion.deploymentId,
      },
      deep: {
        serviceId: args.services.deep,
        deploymentId: deepPromotion.deploymentId,
      },
      api: {
        serviceId: args.services.api,
        deploymentId: apiPromotion.deploymentId,
      },
    },
    rollbackServices: {
      interactive: {
        serviceId: args.services.interactive,
        ...interactivePromotion.previousDeployment,
      },
      deep: {
        serviceId: args.services.deep,
        ...deepPromotion.previousDeployment,
      },
      api: {
        serviceId: args.services.api,
        ...apiPromotion.previousDeployment,
      },
    },
    promotedRuntimeConfigurationHashes: hashes,
    backendConvergenceEvidenceHash: convergence.evidenceHash,
    completedAt: new Date(runtime.now()).toISOString(),
  };
  return Object.freeze({
    ...unsigned,
    receiptHash: sha256(unsigned),
  });
}

async function heartbeatSnapshotMain(): Promise<void> {
  const connectionString =
    process.env.DATABASE_PUBLIC_URL?.trim()
    || process.env.DATABASE_URL?.trim()
    || "";
  if (!connectionString) {
    throw new Error("heartbeat snapshot database connection is unavailable");
  }
  const configuredStaleSeconds = Number(
    process.env.WORKER_STALE_SECONDS ?? 90,
  );
  const staleSeconds = Number.isFinite(configuredStaleSeconds)
    ? Math.max(30, Math.min(Math.floor(configuredStaleSeconds), 600))
    : 90;
  const client = new pg.Client({
    connectionString,
    ssl: connectionString.includes("railway.internal")
      ? undefined
      : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const result = await client.query<{
      worker_id: string;
      queue_class: string;
      revision: string;
      protocol_version: string;
      semantic_execution_configuration_hash: string;
      last_seen_at: Date;
    }>(
      `SELECT
         worker_id,
         metadata_json->>'queueClass' AS queue_class,
         metadata_json->>'version' AS revision,
         metadata_json->>'protocolVersion' AS protocol_version,
         metadata_json->>'semanticExecutionConfigurationHash'
           AS semantic_execution_configuration_hash,
         last_seen_at
       FROM worker_heartbeats
       WHERE last_seen_at > now() - ($1::text || ' seconds')::interval
         AND metadata_json->>'queueClass' IN ('interactive','deep')
       ORDER BY metadata_json->>'queueClass',worker_id`,
      [String(staleSeconds)],
    );
    process.stdout.write(`${JSON.stringify(result.rows.map((row) => ({
      workerId: row.worker_id,
      queueClass: row.queue_class,
      revision: row.revision,
      protocolVersion: row.protocol_version,
      semanticExecutionConfigurationHash:
        row.semantic_execution_configuration_hash,
      lastSeenAt: row.last_seen_at.toISOString(),
    })))}\n`);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const args = parseNativeSchema20ReleaseArgs(process.argv.slice(2));
  const receipt = await runNativeSchema20Promotion(args);
  await writeFile(args.outputPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schemaVersion: receipt.schemaVersion,
    sourceRevision: receipt.sourceRevision,
    version: receipt.version,
    imageDigest: receipt.imageDigest,
    receiptHash: receipt.receiptHash,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const selectedMain = process.argv[2] === "heartbeat-snapshot"
    ? heartbeatSnapshotMain
    : main;
  selectedMain().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "native_schema20_promotion_failed",
      message: error instanceof Error
        ? error.message
        : "Native schema-20 promotion failed",
    })}\n`);
    process.exitCode = 1;
  });
}
