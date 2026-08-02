import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  validateNativeSchema20PromotionReceipt,
} from "./finalize-native-schema20-release.ts";
import {
  nativeV254OwnerEditorialGateVariablesV1,
  nativeV254PublicEditorialActivationVariablesV1,
  nativeV254RouteSwitchVariablesV1,
  parseRailwayVariableInventory,
} from "./promote-native-schema20-release.ts";
import {
  validateReleaseGateArtifact,
  verifyReleaseGateProducerAttestation,
} from "./release-fixtures.ts";
import {
  releaseGateProducerKeyFingerprint,
} from "./release-evidence.ts";
import {
  SEMANTIC_EXECUTION_CONFIGURATION_ENV_KEYS_V1,
  runtimeReleaseContract,
} from "../server/runtime-release.ts";

type JsonRecord = Record<string, unknown>;

export type V254EditorialRoutePhase =
  | "owner_gate"
  | "public_canary"
  | "public_expose"
  | "rollback_zero";
export type V254EditorialRouteMode = "dry-run" | "apply";
export type V254EditorialRollbackTarget = "owner_gate" | "zero";

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{0,159}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const EXACT_ORIGIN = "https://9enio.com";
const ROUTE = "corpus_first_v3";
const INTENT = "editorial_influence";
const GLOBAL_PAUSE_KEY = "pipeline_v3_public_assignment_paused";
const INTENT_PAUSE_KEY =
  "pipeline_v3_public_assignment_paused:editorial_influence";
const AUTHORITY_SETTING = "v254_editorial_route_authority:current";
const LOCK_KEY = "v254-editorial-route-authority-v1";
const TERMINAL_DEPLOYMENT_FAILURES = new Set([
  "CRASHED",
  "FAILED",
  "REMOVED",
  "SKIPPED",
]);
export interface V254EditorialRouteControlArgs {
  mode: V254EditorialRouteMode;
  phase: V254EditorialRoutePhase;
  rollbackTarget: V254EditorialRollbackTarget;
  promotionReceiptPath: string;
  priorAuthorityReceiptPath: string | null;
  proofArtifactPath: string | null;
  proofAttestationPath: string | null;
  producerVerificationKeyPath: string | null;
  producerKeyId: string | null;
  producerKeySha256: string | null;
  approvalHash: string | null;
  sourceRevision: string;
  version: string;
  projectId: string;
  environment: "production";
  services: {
    interactive: string;
    deep: string;
    api: string;
  };
  origin: typeof EXACT_ORIGIN;
  outputPath: string | null;
  deploymentTimeoutMs: number;
  pollIntervalMs: number;
}

export interface V254EditorialRouteProofSourceV1 {
  workflowPath: string;
  artifactName: string;
  proofFile: string;
  attestationFile: string;
  gate: "production_affected_regression" | "final_custom_domain_browser";
}

export function expectedV254EditorialRouteProofSourceV1(
  phase: V254EditorialRoutePhase,
  sourceRevision: string,
): V254EditorialRouteProofSourceV1 | null {
  string(sourceRevision, "proof source revision", SHA1);
  if (phase === "public_canary") {
    return Object.freeze({
      workflowPath: ".github/workflows/v254-owner-apple-gate.yml",
      artifactName: `v254-owner-apple-gate-${sourceRevision}`,
      proofFile: "production-affected-regression.gate.json",
      attestationFile: "production-affected-regression.attestation.json",
      gate: "production_affected_regression",
    });
  }
  if (phase === "public_expose") {
    return Object.freeze({
      workflowPath: ".github/workflows/v254-production-proof.yml",
      artifactName: `v254-final-browser-${sourceRevision}`,
      proofFile: "final-custom-domain-browser.gate.json",
      attestationFile: "final-custom-domain-browser.attestation.json",
      gate: "final_custom_domain_browser",
    });
  }
  return null;
}

export function validateV254EditorialRouteProofSourceV1(input: {
  phase: V254EditorialRoutePhase;
  sourceRevision: string;
  workflowPath: string;
  artifactName: string;
  proofFile: string;
  attestationFile: string;
}): V254EditorialRouteProofSourceV1 {
  const expected = expectedV254EditorialRouteProofSourceV1(
    input.phase,
    input.sourceRevision,
  );
  if (!expected) throw new Error(`${input.phase} does not accept proof evidence`);
  if (
    input.workflowPath !== expected.workflowPath
    || input.artifactName !== expected.artifactName
    || input.proofFile !== expected.proofFile
    || input.attestationFile !== expected.attestationFile
  ) {
    throw new Error(`${input.phase} proof source is not the approved exact-SHA producer`);
  }
  return expected;
}

export interface V254EditorialRouteDatabaseStateV1 {
  hardSwitchDisabled: boolean;
  globalPublicPause: boolean;
  intentPublicPause: boolean;
  currentAuthorityReceipt: V254EditorialRouteAuthorityReceiptV1 | null;
}

export interface V254EditorialRouteBehaviorManifestV1 {
  schemaVersion: "genio-v254-editorial-route-behavior/v1";
  phase: V254EditorialRoutePhase;
  rollbackTarget: V254EditorialRollbackTarget | null;
  values: Readonly<Record<string, string | null>>;
  stagedVariables: readonly string[];
  semanticExecutionConfigurationHash: string;
  manifestHash: string;
}

export interface V254EditorialRouteControlPlanV1 {
  schemaVersion: "genio-v254-editorial-route-control-plan/v1";
  phase: V254EditorialRoutePhase;
  rollbackTarget: V254EditorialRollbackTarget | null;
  sourceRevision: string;
  version: string;
  imageReference: string;
  imageDigest: string;
  promotionReceiptHash: string;
  priorAuthorityReceiptHash: string | null;
  proofEvidenceHash: string | null;
  behaviorManifestHash: string;
  semanticExecutionConfigurationHash: string;
  railwayProjectId: string;
  services: V254EditorialRouteControlArgs["services"];
  databaseBefore: {
    hardSwitchDisabled: boolean;
    globalPublicPause: boolean;
    intentPublicPause: boolean;
  };
  targetDatabase: {
    hardSwitchDisabled: boolean;
    globalPublicPause: boolean;
    intentPublicPause: boolean;
  };
  requiresRedeploy: boolean;
  requiresRollingDeployGuard: boolean;
  rollingDeployGuardHash: string | null;
  deploymentOrder: readonly ["interactive", "deep", "api"];
  rollbackId: string;
  approvalHash: string;
}

export interface V254EditorialRouteAuthorityReceiptV1 {
  schemaVersion: "genio-v254-editorial-route-authority/v1";
  phase: V254EditorialRoutePhase;
  rollbackTarget: V254EditorialRollbackTarget | null;
  sourceRevision: string;
  version: string;
  imageReference: string;
  imageDigest: string;
  promotionReceiptHash: string;
  priorAuthorityReceiptHash: string | null;
  ownerGateReceiptHash: string | null;
  publicCanaryReceiptHash: string | null;
  proofEvidenceHash: string | null;
  behaviorManifestHash: string;
  semanticExecutionConfigurationHash: string;
  approvalHash: string;
  rollbackId: string;
  rollingDeployGuardHash: string | null;
  railwayProjectId: string;
  services: {
    interactive: { serviceId: string; deploymentId: string };
    deep: { serviceId: string; deploymentId: string };
    api: { serviceId: string; deploymentId: string };
  };
  database: {
    hardSwitchDisabled: boolean;
    globalPublicPause: boolean;
    intentPublicPause: boolean;
  };
  applied: boolean;
  completedAt: string;
  receiptHash: string;
}

interface RailwayDeploymentV1 {
  id: string;
  status: string;
  image: string | null;
  imageDigest: string | null;
}

interface WorkerHeartbeatV1 {
  workerId: string;
  queueClass: "interactive" | "deep";
  revision: string;
  semanticExecutionConfigurationHash: string;
  lastSeenAt: string;
}

interface CommandRunner {
  run(command: string, args: readonly string[]): Promise<string>;
}

export interface V254EditorialRouteRuntime {
  commandRunner: CommandRunner;
  fetchJson(url: string): Promise<{ status: number; value: unknown }>;
  now(): number;
  wait(ms: number): Promise<void>;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function string(value: unknown, label: string, pattern: RegExp): string {
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

function exactKeys(value: JsonRecord, expected: readonly string[], label: string) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (
    actual.length !== keys.length
    || actual.some((key, index) => key !== keys[index])
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function option(values: ReadonlyMap<string, string>, name: string): string {
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
    throw new Error(`${label} must be ${minimum} through ${maximum}`);
  }
  return parsed;
}

export function parseV254EditorialRouteControlArgs(
  argv: readonly string[],
): V254EditorialRouteControlArgs {
  const mode = argv[0];
  if (mode !== "dry-run" && mode !== "apply") {
    throw new Error("first argument must be dry-run or apply");
  }
  const allowed = new Set([
    "--phase",
    "--rollback-target",
    "--promotion-receipt",
    "--prior-authority-receipt",
    "--proof-artifact",
    "--proof-attestation",
    "--producer-verification-key",
    "--producer-key-id",
    "--producer-key-sha256",
    "--approval-hash",
    "--source-revision",
    "--version",
    "--project-id",
    "--environment",
    "--interactive-service",
    "--deep-service",
    "--api-service",
    "--origin",
    "--output",
    "--deployment-timeout-seconds",
    "--poll-interval-seconds",
  ]);
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index] ?? "";
    const value = argv[index + 1] ?? "";
    if (!allowed.has(name) || !value || value.startsWith("--") || values.has(name)) {
      throw new Error(`invalid v2.5.4 route control argument: ${name || "missing"}`);
    }
    values.set(name, value);
  }
  const phase = option(values, "--phase") as V254EditorialRoutePhase;
  if (!["owner_gate", "public_canary", "public_expose", "rollback_zero"].includes(phase)) {
    throw new Error("--phase is invalid");
  }
  const rollbackTarget = (
    values.get("--rollback-target") ?? "owner_gate"
  ) as V254EditorialRollbackTarget;
  if (rollbackTarget !== "owner_gate" && rollbackTarget !== "zero") {
    throw new Error("--rollback-target is invalid");
  }
  const environment = option(values, "--environment");
  if (environment !== "production") throw new Error("--environment must be production");
  const origin = option(values, "--origin");
  if (origin !== EXACT_ORIGIN) throw new Error("--origin must be exactly https://9enio.com");
  const services = {
    interactive: string(option(values, "--interactive-service"), "interactive service", UUID),
    deep: string(option(values, "--deep-service"), "deep service", UUID),
    api: string(option(values, "--api-service"), "API service", UUID),
  };
  if (new Set(Object.values(services)).size !== 3) {
    throw new Error("route control services must be distinct");
  }
  const priorAuthorityReceiptPath = values.get("--prior-authority-receipt") ?? null;
  const proofArtifactPath = values.get("--proof-artifact") ?? null;
  const proofAttestationPath = values.get("--proof-attestation") ?? null;
  const producerVerificationKeyPath =
    values.get("--producer-verification-key") ?? null;
  const producerKeyId = values.get("--producer-key-id") ?? null;
  const producerKeySha256 = values.get("--producer-key-sha256") ?? null;
  const suppliedProofInputs = [
    proofArtifactPath,
    proofAttestationPath,
    producerVerificationKeyPath,
    producerKeyId,
    producerKeySha256,
  ];
  if (phase === "owner_gate" && priorAuthorityReceiptPath !== null) {
    throw new Error("owner_gate must begin from the immutable promotion receipt");
  }
  if (
    (phase === "public_canary" || phase === "public_expose")
    && (
      !priorAuthorityReceiptPath
      || suppliedProofInputs.some((value) => value === null)
    )
  ) {
    throw new Error(
      `${phase} requires prior authority, signed proof, and pinned verification key`,
    );
  }
  if (phase === "rollback_zero" && !priorAuthorityReceiptPath) {
    throw new Error("rollback_zero requires the current authority receipt");
  }
  if (
    (phase === "owner_gate" || phase === "rollback_zero")
    && suppliedProofInputs.some((value) => value !== null)
  ) {
    throw new Error(`${phase} does not accept proof inputs`);
  }
  const expectedProof = expectedV254EditorialRouteProofSourceV1(
    phase,
    option(values, "--source-revision"),
  );
  if (expectedProof && (
    basename(proofArtifactPath!) !== expectedProof.proofFile
    || basename(proofAttestationPath!) !== expectedProof.attestationFile
  )) {
    throw new Error(`${phase} proof filenames are not the pinned producer outputs`);
  }
  if (producerKeyId !== null) {
    string(producerKeyId, "producer key ID", SAFE_KEY_ID);
  }
  if (producerKeySha256 !== null) {
    string(producerKeySha256, "producer key SHA-256", SHA256);
  }
  const approvalHash = values.get("--approval-hash") ?? null;
  if (mode === "apply" && (!approvalHash || !SHA256.test(approvalHash))) {
    throw new Error("apply requires --approval-hash from dry-run");
  }
  return {
    mode,
    phase,
    rollbackTarget,
    promotionReceiptPath: option(values, "--promotion-receipt"),
    priorAuthorityReceiptPath,
    proofArtifactPath,
    proofAttestationPath,
    producerVerificationKeyPath,
    producerKeyId,
    producerKeySha256,
    approvalHash,
    sourceRevision: string(option(values, "--source-revision"), "source revision", SHA1),
    version: string(option(values, "--version"), "version", VERSION),
    projectId: string(option(values, "--project-id"), "project ID", UUID),
    environment: "production",
    services,
    origin: EXACT_ORIGIN,
    outputPath: values.get("--output") ?? null,
    deploymentTimeoutMs: positiveInteger(
      option(values, "--deployment-timeout-seconds"),
      "deployment timeout",
      60,
      1_800,
    ) * 1_000,
    pollIntervalMs: positiveInteger(
      option(values, "--poll-interval-seconds"),
      "poll interval",
      2,
      60,
    ) * 1_000,
  };
}

export function validateV254EditorialRouteAuthorityReceiptV1(
  value: unknown,
  expected?: {
    sourceRevision: string;
    version: string;
    promotionReceiptHash: string;
  },
): V254EditorialRouteAuthorityReceiptV1 {
  const receipt = record(value, "v2.5.4 editorial route authority receipt");
  exactKeys(receipt, [
    "schemaVersion", "phase", "rollbackTarget", "sourceRevision", "version",
    "imageReference", "imageDigest", "promotionReceiptHash",
    "priorAuthorityReceiptHash", "ownerGateReceiptHash",
    "publicCanaryReceiptHash", "proofEvidenceHash", "behaviorManifestHash",
    "semanticExecutionConfigurationHash", "approvalHash", "rollbackId",
    "rollingDeployGuardHash",
    "railwayProjectId", "services", "database", "applied", "completedAt",
    "receiptHash",
  ], "v2.5.4 editorial route authority receipt");
  if (receipt.schemaVersion !== "genio-v254-editorial-route-authority/v1") {
    throw new Error("editorial route authority receipt schema is invalid");
  }
  const phase = receipt.phase as V254EditorialRoutePhase;
  if (!["owner_gate", "public_canary", "public_expose", "rollback_zero"].includes(phase)) {
    throw new Error("editorial route authority phase is invalid");
  }
  const sourceRevision = string(receipt.sourceRevision, "authority source revision", SHA1);
  const version = string(receipt.version, "authority version", VERSION);
  const promotionReceiptHash = string(
    receipt.promotionReceiptHash,
    "authority promotion receipt hash",
    SHA256,
  );
  if (expected && (
    sourceRevision !== expected.sourceRevision
    || version !== expected.version
    || promotionReceiptHash !== expected.promotionReceiptHash
  )) {
    throw new Error("editorial route authority does not bind the promotion");
  }
  string(receipt.imageDigest, "authority image digest", IMAGE_DIGEST);
  for (const key of [
    "behaviorManifestHash", "semanticExecutionConfigurationHash",
    "approvalHash", "rollbackId", "receiptHash",
  ] as const) string(receipt[key], `authority ${key}`, SHA256);
  for (const key of [
    "priorAuthorityReceiptHash", "ownerGateReceiptHash",
    "publicCanaryReceiptHash", "proofEvidenceHash", "rollingDeployGuardHash",
  ] as const) {
    if (receipt[key] !== null) string(receipt[key], `authority ${key}`, SHA256);
  }
  const services = record(receipt.services, "authority services");
  exactKeys(services, ["interactive", "deep", "api"], "authority services");
  for (const lane of ["interactive", "deep", "api"] as const) {
    const service = record(services[lane], `authority ${lane} service`);
    exactKeys(service, ["serviceId", "deploymentId"], `authority ${lane} service`);
    string(service.serviceId, `authority ${lane} service ID`, UUID);
    string(service.deploymentId, `authority ${lane} deployment ID`, UUID);
  }
  const database = record(receipt.database, "authority database state");
  exactKeys(
    database,
    ["hardSwitchDisabled", "globalPublicPause", "intentPublicPause"],
    "authority database state",
  );
  if (Object.values(database).some((item) => typeof item !== "boolean")) {
    throw new Error("authority database state is invalid");
  }
  timestamp(receipt.completedAt, "authority completion time");
  const unsigned = { ...receipt };
  delete unsigned.receiptHash;
  if (receipt.receiptHash !== sha256(unsigned)) {
    throw new Error("editorial route authority receipt hash is invalid");
  }
  if (
    phase === "owner_gate"
    && (receipt.ownerGateReceiptHash === null
      || receipt.publicCanaryReceiptHash !== null)
  ) {
    throw new Error("owner gate receipt lineage is invalid");
  }
  if (
    phase === "public_canary"
    && (receipt.ownerGateReceiptHash === null
      || receipt.publicCanaryReceiptHash === null
      || receipt.proofEvidenceHash === null)
  ) {
    throw new Error("public canary receipt lineage is invalid");
  }
  if (
    phase === "owner_gate" && receipt.rollingDeployGuardHash !== null
    || (phase === "public_canary" || phase === "public_expose")
      && receipt.rollingDeployGuardHash === null
  ) {
    throw new Error("rolling deployment guard lineage is invalid");
  }
  if (
    phase === "public_expose"
    && (receipt.ownerGateReceiptHash === null
      || receipt.publicCanaryReceiptHash === null
      || receipt.proofEvidenceHash === null
      || database.hardSwitchDisabled !== false
      || database.globalPublicPause !== false
      || database.intentPublicPause !== false)
  ) {
    throw new Error("public exposure receipt lineage is invalid");
  }
  return receipt as unknown as V254EditorialRouteAuthorityReceiptV1;
}

function targetVariables(
  phase: V254EditorialRoutePhase,
  rollbackTarget: V254EditorialRollbackTarget,
): Readonly<Record<string, string>> {
  if (phase === "public_canary") {
    // public_canary proves the repaired route through an explicit signed
    // canary receipt. It must not preempt the signed 0→1→10→50→100 authority
    // plane by staging a public percentage.
    return nativeV254OwnerEditorialGateVariablesV1();
  }
  if (phase === "public_expose") {
    return nativeV254PublicEditorialActivationVariablesV1();
  }
  if (phase === "rollback_zero" && rollbackTarget === "zero") {
    return Object.freeze({
      ...nativeV254RouteSwitchVariablesV1(),
      PIPELINE_V3_OWNER_CANARY: "false",
      PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT: "0",
    });
  }
  return nativeV254OwnerEditorialGateVariablesV1();
}

export function buildV254EditorialRouteBehaviorManifestV1(input: {
  phase: V254EditorialRoutePhase;
  rollbackTarget: V254EditorialRollbackTarget;
  inventories: readonly Readonly<Record<string, string>>[];
}): V254EditorialRouteBehaviorManifestV1 {
  if (input.inventories.length !== 3) {
    throw new Error("three Railway variable inventories are required");
  }
  const target = targetVariables(input.phase, input.rollbackTarget);
  const values: Record<string, string | null> = {};
  for (const key of SEMANTIC_EXECUTION_CONFIGURATION_ENV_KEYS_V1) {
    if (Object.hasOwn(target, key)) {
      values[key] = target[key]!;
      continue;
    }
    const observed = input.inventories.map((inventory) => inventory[key] ?? null);
    if (observed.some((value) => value !== observed[0])) {
      throw new Error(`unmanaged semantic variable ${key} differs across lanes`);
    }
    values[key] = observed[0] ?? null;
  }
  for (const [key, value] of Object.entries(target)) values[key] = value;
  const environment = Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== null),
  ) as NodeJS.ProcessEnv;
  const semanticExecutionConfigurationHash =
    runtimeReleaseContract(environment).semanticExecutionConfigurationHash;
  const unsigned = {
    schemaVersion: "genio-v254-editorial-route-behavior/v1" as const,
    phase: input.phase,
    rollbackTarget: input.phase === "rollback_zero" ? input.rollbackTarget : null,
    values: Object.fromEntries(Object.keys(values).sort().map((key) => [key, values[key]!])),
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

function targetDatabaseState(
  phase: V254EditorialRoutePhase,
): Omit<V254EditorialRouteDatabaseStateV1, "currentAuthorityReceipt"> {
  if (phase === "public_expose") {
    return {
      hardSwitchDisabled: false,
      globalPublicPause: false,
      intentPublicPause: false,
    };
  }
  if (phase === "owner_gate" || phase === "public_canary") {
    return {
      hardSwitchDisabled: false,
      globalPublicPause: true,
      intentPublicPause: true,
    };
  }
  return {
    hardSwitchDisabled: true,
    globalPublicPause: true,
    intentPublicPause: true,
  };
}

export function buildV254EditorialRouteControlPlanV1(input: {
  phase: V254EditorialRoutePhase;
  rollbackTarget: V254EditorialRollbackTarget;
  promotion: ReturnType<typeof validateNativeSchema20PromotionReceipt>;
  priorAuthority: V254EditorialRouteAuthorityReceiptV1 | null;
  proofEvidenceHash: string | null;
  behavior: V254EditorialRouteBehaviorManifestV1;
  database: V254EditorialRouteDatabaseStateV1;
}): V254EditorialRouteControlPlanV1 {
  const { phase, promotion, priorAuthority, database } = input;
  if (phase === "owner_gate") {
    if (priorAuthority !== null || database.currentAuthorityReceipt !== null) {
      throw new Error("owner gate authority already exists");
    }
    if (
      !database.hardSwitchDisabled
      || !database.globalPublicPause
      || !database.intentPublicPause
    ) {
      throw new Error("owner gate requires contained hard switch and pauses");
    }
  } else {
    if (!priorAuthority) throw new Error(`${phase} requires prior authority`);
    if (
      database.currentAuthorityReceipt?.receiptHash
        !== priorAuthority.receiptHash
    ) {
      throw new Error("database authority does not match the supplied predecessor");
    }
    if (phase === "public_canary" && priorAuthority.phase !== "owner_gate") {
      throw new Error("public canary requires owner gate authority");
    }
    if (phase === "public_expose" && priorAuthority.phase !== "public_canary") {
      throw new Error("public exposure requires public canary authority");
    }
  }
  if (
    (phase === "public_canary" || phase === "public_expose")
    && input.proofEvidenceHash === null
  ) {
    throw new Error(`${phase} requires exact-candidate proof evidence`);
  }
  const target = targetDatabaseState(phase);
  const rollingDeployGuardHash = phase === "public_canary"
    ? sha256({
        schemaVersion: "genio-v254-rolling-deploy-guard/v1",
        sourceRevision: promotion.sourceRevision,
        imageDigest: promotion.imageDigest,
        promotionReceiptHash: promotion.receiptHash,
        priorAuthorityReceiptHash: priorAuthority?.receiptHash ?? null,
        behaviorManifestHash: input.behavior.manifestHash,
        semanticExecutionConfigurationHash:
          input.behavior.semanticExecutionConfigurationHash,
        target: {
          hardSwitchDisabled: true,
          globalPublicPause: true,
          intentPublicPause: true,
        },
      })
    : priorAuthority?.rollingDeployGuardHash ?? null;
  const core = {
    schemaVersion: "genio-v254-editorial-route-control-plan/v1" as const,
    phase,
    rollbackTarget: phase === "rollback_zero" ? input.rollbackTarget : null,
    sourceRevision: promotion.sourceRevision,
    version: promotion.version,
    imageReference: promotion.imageReference,
    imageDigest: promotion.imageDigest,
    promotionReceiptHash: promotion.receiptHash,
    priorAuthorityReceiptHash: priorAuthority?.receiptHash ?? null,
    proofEvidenceHash: input.proofEvidenceHash,
    behaviorManifestHash: input.behavior.manifestHash,
    semanticExecutionConfigurationHash:
      input.behavior.semanticExecutionConfigurationHash,
    railwayProjectId: promotion.projectId,
    services: {
      interactive: promotion.services.interactive.serviceId,
      deep: promotion.services.deep.serviceId,
      api: promotion.services.api.serviceId,
    },
    databaseBefore: {
      hardSwitchDisabled: database.hardSwitchDisabled,
      globalPublicPause: database.globalPublicPause,
      intentPublicPause: database.intentPublicPause,
    },
    targetDatabase: target,
    requiresRedeploy: phase === "public_canary" || phase === "rollback_zero",
    requiresRollingDeployGuard: phase === "public_canary",
    rollingDeployGuardHash,
    deploymentOrder: ["interactive", "deep", "api"] as const,
    rollbackId: sha256({
      kind: "v254-editorial-route-rollback",
      promotionReceiptHash: promotion.receiptHash,
      phase,
      predecessor: priorAuthority?.receiptHash ?? null,
      target: phase === "rollback_zero" ? input.rollbackTarget : "owner_gate",
    }),
  };
  return Object.freeze({
    ...core,
    approvalHash: sha256(core),
  });
}

class ProcessRunner implements CommandRunner {
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
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) return resolve(stdout);
        reject(new Error(
          `${command} exited ${code ?? "unknown"}: ${
            redactV254EditorialRouteCommandStderr(stderr)
          }`,
        ));
      });
    });
  }
}

export function redactV254EditorialRouteCommandStderr(
  stderr: string,
): string {
  // Railway and provider CLIs can echo credentials in URLs, headers, JSON,
  // dotenv lines, base64, or short/dotted token formats. Pattern-based
  // scrubbing cannot prove that an unrecognized credential format is safe.
  // Release-control errors therefore disclose only whether stderr existed;
  // the exit code and failed command remain available to operators above.
  return stderr.trim().length > 0
    ? "[redacted Railway stderr]"
    : "[no Railway stderr]";
}

export function defaultV254EditorialRouteRuntime(): V254EditorialRouteRuntime {
  return {
    commandRunner: new ProcessRunner(),
    async fetchJson(url) {
      const response = await fetch(url, {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { "cache-control": "no-cache", pragma: "no-cache" },
      });
      let value: unknown = {};
      try { value = JSON.parse(await response.text()); } catch { /* fail below */ }
      return { status: response.status, value };
    },
    now: () => Date.now(),
    async wait(ms) { await new Promise((resolve) => setTimeout(resolve, ms)); },
  };
}

function railwaySelectors(args: V254EditorialRouteControlArgs): string[] {
  return ["--project", args.projectId, "--environment", args.environment];
}

async function variableInventory(
  runtime: V254EditorialRouteRuntime,
  args: V254EditorialRouteControlArgs,
  serviceId: string,
) {
  return parseRailwayVariableInventory(await runtime.commandRunner.run("railway", [
    "variable", "list", "--service", serviceId,
    ...railwaySelectors(args), "--json",
  ]));
}

function parseDeployments(value: string): RailwayDeploymentV1[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Railway deployments are invalid");
  return parsed.map((item) => {
    const row = record(item, "Railway deployment");
    const meta = record(row.meta, "Railway deployment metadata");
    return {
      id: string(row.id, "deployment ID", UUID),
      status: string(row.status, "deployment status", /^[A-Z_]+$/u),
      image: typeof meta.image === "string" ? meta.image : null,
      imageDigest: typeof meta.imageDigest === "string" ? meta.imageDigest : null,
    };
  });
}

async function deployments(
  runtime: V254EditorialRouteRuntime,
  args: V254EditorialRouteControlArgs,
  serviceId: string,
) {
  return parseDeployments(await runtime.commandRunner.run("railway", [
    "deployment", "list", "--service", serviceId,
    ...railwaySelectors(args), "--limit", "5", "--json",
  ]));
}

async function requireExactCurrentDeployments(input: {
  runtime: V254EditorialRouteRuntime;
  args: V254EditorialRouteControlArgs;
  imageReference: string;
  imageDigest: string;
}): Promise<Record<"interactive" | "deep" | "api", string>> {
  const result = {} as Record<"interactive" | "deep" | "api", string>;
  for (const lane of ["interactive", "deep", "api"] as const) {
    const latest = (await deployments(
      input.runtime,
      input.args,
      input.args.services[lane],
    ))[0];
    if (
      !latest
      || latest.status !== "SUCCESS"
      || latest.image !== input.imageReference
      || latest.imageDigest !== input.imageDigest
    ) {
      throw new Error(`${lane} is not on the exact promoted image`);
    }
    result[lane] = latest.id;
  }
  return result;
}

function parseHeartbeatSnapshot(value: string): WorkerHeartbeatV1[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("heartbeat snapshot is invalid");
  return parsed.map((item) => {
    const row = record(item, "heartbeat row");
    if (row.queueClass !== "interactive" && row.queueClass !== "deep") {
      throw new Error("heartbeat queue class is invalid");
    }
    return {
      workerId: string(row.workerId, "heartbeat worker ID", /^[0-9A-Za-z][0-9A-Za-z._:+-]{0,159}$/u),
      queueClass: row.queueClass,
      revision: string(row.revision, "heartbeat revision", SHA1),
      semanticExecutionConfigurationHash: string(
        row.semanticExecutionConfigurationHash,
        "heartbeat semantic hash",
        SHA256,
      ),
      lastSeenAt: timestamp(row.lastSeenAt, "heartbeat time"),
    };
  });
}

async function dbCommand(
  runtime: V254EditorialRouteRuntime,
  args: V254EditorialRouteControlArgs,
  command: "db-snapshot" | "db-guard" | "db-transition" | "db-record" | "heartbeat-snapshot",
  values: readonly string[] = [],
): Promise<string> {
  return await runtime.commandRunner.run("railway", [
    "run", "--service", "Postgres", ...railwaySelectors(args), "--no-local", "--",
    "node", "--experimental-transform-types",
    "scripts/v254-editorial-route-control.ts", command, ...values,
  ]);
}

function parseDatabaseSnapshot(value: string): V254EditorialRouteDatabaseStateV1 {
  const row = record(JSON.parse(value) as unknown, "route database snapshot");
  const current = row.currentAuthorityReceipt === null
    ? null
    : validateV254EditorialRouteAuthorityReceiptV1(row.currentAuthorityReceipt);
  return {
    hardSwitchDisabled: row.hardSwitchDisabled === true,
    globalPublicPause: row.globalPublicPause === true,
    intentPublicPause: row.intentPublicPause === true,
    currentAuthorityReceipt: current,
  };
}

async function heartbeatSnapshot(
  runtime: V254EditorialRouteRuntime,
  args: V254EditorialRouteControlArgs,
) {
  return parseHeartbeatSnapshot(await dbCommand(runtime, args, "heartbeat-snapshot"));
}

async function promoteExactService(input: {
  runtime: V254EditorialRouteRuntime;
  args: V254EditorialRouteControlArgs;
  serviceId: string;
  imageReference: string;
  imageDigest: string;
}): Promise<string> {
  const before = (await deployments(input.runtime, input.args, input.serviceId))[0];
  if (
    !before
    || before.image !== input.imageReference
    || before.imageDigest !== input.imageDigest
  ) {
    throw new Error("route phase cannot change the immutable image source");
  }
  await input.runtime.commandRunner.run("railway", [
    "redeploy", "--service", input.serviceId,
    ...railwaySelectors(input.args), "--yes", "--json",
  ]);
  const deadline = input.runtime.now() + input.args.deploymentTimeoutMs;
  while (input.runtime.now() < deadline) {
    const current = (await deployments(input.runtime, input.args, input.serviceId))
      .find((item) => item.id !== before.id);
    if (
      current?.status === "SUCCESS"
      && current.image === input.imageReference
      && current.imageDigest === input.imageDigest
    ) return current.id;
    if (current && TERMINAL_DEPLOYMENT_FAILURES.has(current.status)) {
      throw new Error(`exact-image redeploy failed with ${current.status}`);
    }
    await input.runtime.wait(input.args.pollIntervalMs);
  }
  throw new Error("exact-image redeploy timed out");
}

async function requireWorkerConvergence(input: {
  runtime: V254EditorialRouteRuntime;
  args: V254EditorialRouteControlArgs;
  sourceRevision: string;
  semanticHash: string;
}): Promise<void> {
  const eligible = (rows: readonly WorkerHeartbeatV1[]) =>
    (["interactive", "deep"] as const).every((queueClass) => {
      const lane = rows.filter((row) => row.queueClass === queueClass);
      return lane.length === 1
        && lane[0]!.revision === input.sourceRevision
        && lane[0]!.semanticExecutionConfigurationHash === input.semanticHash;
    });
  const deadline = input.runtime.now() + input.args.deploymentTimeoutMs;
  let first: WorkerHeartbeatV1[] | null = null;
  while (input.runtime.now() < deadline) {
    const observed = await heartbeatSnapshot(input.runtime, input.args);
    if (eligible(observed)) { first = observed; break; }
    await input.runtime.wait(input.args.pollIntervalMs);
  }
  if (!first) throw new Error("workers did not converge on the route manifest");
  await input.runtime.wait(30_000);
  const second = await heartbeatSnapshot(input.runtime, input.args);
  if (!eligible(second)) throw new Error("worker convergence did not persist");
  for (const queueClass of ["interactive", "deep"] as const) {
    const left = first.find((row) => row.queueClass === queueClass)!;
    const right = second.find((row) => row.queueClass === queueClass)!;
    if (
      left.workerId !== right.workerId
      || Date.parse(right.lastSeenAt) <= Date.parse(left.lastSeenAt)
    ) throw new Error(`${queueClass} heartbeat did not advance`);
  }
}

async function requireSystemConvergence(input: {
  runtime: V254EditorialRouteRuntime;
  args: V254EditorialRouteControlArgs;
  sourceRevision: string;
  version: string;
  semanticHash: string;
}): Promise<void> {
  const get = async (path: string) => {
    const response = await input.runtime.fetchJson(
      `${input.args.origin}${path}?v254-route-authority=${input.runtime.now()}`,
    );
    if (response.status !== 200) throw new Error(`${path} returned ${response.status}`);
    return record(response.value, path);
  };
  const live = await get("/health/live");
  const build = record(live.build ?? live, "health live build");
  if (build.version !== input.version || build.revision !== input.sourceRevision) {
    throw new Error("health live does not bind the exact candidate");
  }
  await get("/health/ready");
  const system = await get("/health/system");
  const api = record(system.api, "system API");
  const worker = record(system.workerProtocol, "system worker protocol");
  if (
    system.ok !== true
    || system.activationReady !== true
    || system.schemaVersion !== "20"
    || worker.actual !== "playlist-pipeline-v12"
    || api.semanticExecutionConfigurationHash !== input.semanticHash
  ) {
    throw new Error("system health does not converge on schema 20/protocol 12");
  }
}

export function verifyV254EditorialRouteProofV1(input: {
  artifactValue: unknown;
  attestationValue: unknown;
  verificationKey: string | Buffer;
  approvedKeyId: string;
  approvedKeySha256: string;
  phase: V254EditorialRoutePhase;
  expected: { sourceRevision: string; version: string; imageDigest: string };
}): string {
  string(input.approvedKeyId, "approved producer key ID", SAFE_KEY_ID);
  string(
    input.approvedKeySha256,
    "approved producer key SHA-256",
    SHA256,
  );
  const observedKeySha256 =
    releaseGateProducerKeyFingerprint(input.verificationKey);
  if (observedKeySha256 !== input.approvedKeySha256) {
    throw new Error("proof producer verification key is not the approved key");
  }
  const artifact = validateReleaseGateArtifact(input.artifactValue);
  const requiredGate = input.phase === "public_canary"
    ? "production_affected_regression"
    : input.phase === "public_expose"
      ? "final_custom_domain_browser"
      : null;
  if (!requiredGate) {
    throw new Error(`${input.phase} does not accept proof evidence`);
  }
  const attestation = verifyReleaseGateProducerAttestation(
    input.attestationValue,
    artifact,
    input.verificationKey,
  );
  if (attestation.signature.keyId !== input.approvedKeyId) {
    throw new Error("proof used an unapproved producer key ID");
  }
  if (
    artifact.gate !== requiredGate
    || artifact.environment !== "production"
    || artifact.candidate.sourceRevision !== input.expected.sourceRevision
    || artifact.candidate.sitesSourceRevision !== input.expected.sourceRevision
    || artifact.candidate.version !== input.expected.version
    || artifact.candidate.imageDigest !== input.expected.imageDigest
  ) {
    throw new Error(`${input.phase} proof does not bind the exact candidate`);
  }
  return artifact.evidenceHash;
}

async function proofEvidenceHash(
  args: V254EditorialRouteControlArgs,
  expected: { sourceRevision: string; version: string; imageDigest: string },
): Promise<string> {
  if (
    !args.proofArtifactPath
    || !args.proofAttestationPath
    || !args.producerVerificationKeyPath
    || !args.producerKeyId
    || !args.producerKeySha256
  ) throw new Error(`${args.phase} signed proof inputs are incomplete`);
  const [artifactValue, attestationValue, verificationKey] = await Promise.all([
    readFile(args.proofArtifactPath, "utf8").then(JSON.parse),
    readFile(args.proofAttestationPath, "utf8").then(JSON.parse),
    readFile(args.producerVerificationKeyPath),
  ]);
  return verifyV254EditorialRouteProofV1({
    artifactValue,
    attestationValue,
    verificationKey,
    approvedKeyId: args.producerKeyId,
    approvedKeySha256: args.producerKeySha256,
    phase: args.phase,
    expected,
  });
}

async function stageManifest(input: {
  runtime: V254EditorialRouteRuntime;
  args: V254EditorialRouteControlArgs;
  manifest: V254EditorialRouteBehaviorManifestV1;
}): Promise<void> {
  for (const serviceId of Object.values(input.args.services)) {
    await input.runtime.commandRunner.run("railway", [
      "variable", "set", ...input.manifest.stagedVariables,
      "--service", serviceId, ...railwaySelectors(input.args),
      "--skip-deploys", "--json",
    ]);
  }
  for (const serviceId of Object.values(input.args.services)) {
    const observed = await variableInventory(input.runtime, input.args, serviceId);
    for (const [key, expected] of Object.entries(input.manifest.values)) {
      if ((observed[key] ?? null) !== expected) {
        throw new Error(`staged route manifest mismatch for ${key}`);
      }
    }
  }
}

function receiptLineage(input: {
  phase: V254EditorialRoutePhase;
  prior: V254EditorialRouteAuthorityReceiptV1 | null;
}): { ownerGateReceiptHash: string | null; publicCanaryReceiptHash: string | null } {
  if (input.phase === "owner_gate") {
    return { ownerGateReceiptHash: null, publicCanaryReceiptHash: null };
  }
  if (input.phase === "public_canary") {
    return {
      ownerGateReceiptHash: input.prior!.ownerGateReceiptHash,
      publicCanaryReceiptHash: null,
    };
  }
  return {
    ownerGateReceiptHash: input.prior!.ownerGateReceiptHash,
    publicCanaryReceiptHash: input.prior!.publicCanaryReceiptHash,
  };
}

export async function runV254EditorialRouteControl(
  args: V254EditorialRouteControlArgs,
  runtime: V254EditorialRouteRuntime = defaultV254EditorialRouteRuntime(),
): Promise<V254EditorialRouteControlPlanV1 | V254EditorialRouteAuthorityReceiptV1> {
  const promotionValue = JSON.parse(await readFile(args.promotionReceiptPath, "utf8"));
  const promotion = validateNativeSchema20PromotionReceipt(promotionValue, {
    sourceRevision: args.sourceRevision,
    version: args.version,
  });
  if (
    promotion.projectId !== args.projectId
    || promotion.services.interactive.serviceId !== args.services.interactive
    || promotion.services.deep.serviceId !== args.services.deep
    || promotion.services.api.serviceId !== args.services.api
  ) throw new Error("route control targets differ from the immutable promotion");
  const prior = args.priorAuthorityReceiptPath
    ? validateV254EditorialRouteAuthorityReceiptV1(
        JSON.parse(await readFile(args.priorAuthorityReceiptPath, "utf8")),
        {
          sourceRevision: args.sourceRevision,
          version: args.version,
          promotionReceiptHash: promotion.receiptHash,
        },
      )
    : null;
  const proofHash = args.proofArtifactPath
    ? await proofEvidenceHash(
        args,
        {
          sourceRevision: args.sourceRevision,
          version: args.version,
          imageDigest: promotion.imageDigest,
        },
      )
    : null;
  const inventories = await Promise.all(
    Object.values(args.services).map((serviceId) => variableInventory(runtime, args, serviceId)),
  );
  const behavior = buildV254EditorialRouteBehaviorManifestV1({
    phase: args.phase,
    rollbackTarget: args.rollbackTarget,
    inventories,
  });
  const database = parseDatabaseSnapshot(
    await dbCommand(runtime, args, "db-snapshot"),
  );
  if (
    database.currentAuthorityReceipt
    && database.currentAuthorityReceipt.phase === args.phase
    && database.currentAuthorityReceipt.promotionReceiptHash === promotion.receiptHash
    && database.currentAuthorityReceipt.rollbackTarget
      === (args.phase === "rollback_zero" ? args.rollbackTarget : null)
  ) {
    return database.currentAuthorityReceipt;
  }
  const plan = buildV254EditorialRouteControlPlanV1({
    phase: args.phase,
    rollbackTarget: args.rollbackTarget,
    promotion,
    priorAuthority: prior,
    proofEvidenceHash: proofHash,
    behavior,
    database,
  });
  if (args.mode === "dry-run") return plan;
  if (args.approvalHash !== plan.approvalHash) {
    throw new Error("route control changed after dry-run approval");
  }
  let deploymentIds = await requireExactCurrentDeployments({
    runtime,
    args,
    imageReference: promotion.imageReference,
    imageDigest: promotion.imageDigest,
  });
  if (plan.requiresRollingDeployGuard) {
    if (!plan.rollingDeployGuardHash) {
      throw new Error("rolling deployment guard hash is missing");
    }
    const guardResult = record(JSON.parse(await dbCommand(
      runtime,
      args,
      "db-guard",
      [
        args.phase,
        plan.rollingDeployGuardHash,
        plan.approvalHash,
        promotion.receiptHash,
        prior?.receiptHash ?? "none",
        behavior.manifestHash,
        behavior.semanticExecutionConfigurationHash,
      ],
    )) as unknown, "rolling deployment guard result");
    if (guardResult.guardHash !== plan.rollingDeployGuardHash) {
      throw new Error("rolling deployment guard receipt does not match the plan");
    }
    const guarded = parseDatabaseSnapshot(
      await dbCommand(runtime, args, "db-snapshot"),
    );
    if (
      !guarded.hardSwitchDisabled
      || !guarded.globalPublicPause
      || !guarded.intentPublicPause
    ) throw new Error("rolling deployment guard did not converge");
  }
  if (args.phase === "rollback_zero") {
    await dbCommand(runtime, args, "db-transition", [
      args.phase, plan.approvalHash, promotion.receiptHash,
      prior?.receiptHash ?? "none", proofHash ?? "none",
      behavior.manifestHash, behavior.semanticExecutionConfigurationHash,
      plan.rollbackId, args.rollbackTarget,
    ]);
  }
  if (plan.requiresRedeploy) {
    await stageManifest({ runtime, args, manifest: behavior });
    deploymentIds = {
      interactive: await promoteExactService({
        runtime, args, serviceId: args.services.interactive,
        imageReference: promotion.imageReference,
        imageDigest: promotion.imageDigest,
      }),
      deep: await promoteExactService({
        runtime, args, serviceId: args.services.deep,
        imageReference: promotion.imageReference,
        imageDigest: promotion.imageDigest,
      }),
      api: "",
    };
    await requireWorkerConvergence({
      runtime,
      args,
      sourceRevision: args.sourceRevision,
      semanticHash: behavior.semanticExecutionConfigurationHash,
    });
    deploymentIds.api = await promoteExactService({
      runtime, args, serviceId: args.services.api,
      imageReference: promotion.imageReference,
      imageDigest: promotion.imageDigest,
    });
  }
  await requireSystemConvergence({
    runtime,
    args,
    sourceRevision: args.sourceRevision,
    version: args.version,
    semanticHash: behavior.semanticExecutionConfigurationHash,
  });
  if (args.phase !== "rollback_zero") {
    await dbCommand(runtime, args, "db-transition", [
      args.phase, plan.approvalHash, promotion.receiptHash,
      prior?.receiptHash ?? "none", proofHash ?? "none",
      behavior.manifestHash, behavior.semanticExecutionConfigurationHash,
      plan.rollbackId, args.rollbackTarget,
    ]);
  }
  const after = parseDatabaseSnapshot(await dbCommand(runtime, args, "db-snapshot"));
  if (
    after.hardSwitchDisabled !== plan.targetDatabase.hardSwitchDisabled
    || after.globalPublicPause !== plan.targetDatabase.globalPublicPause
    || after.intentPublicPause !== plan.targetDatabase.intentPublicPause
  ) throw new Error("route control database transition did not converge");
  const lineage = receiptLineage({ phase: args.phase, prior });
  const unsignedBase = {
    schemaVersion: "genio-v254-editorial-route-authority/v1" as const,
    phase: args.phase,
    rollbackTarget: args.phase === "rollback_zero" ? args.rollbackTarget : null,
    sourceRevision: args.sourceRevision,
    version: args.version,
    imageReference: promotion.imageReference,
    imageDigest: promotion.imageDigest,
    promotionReceiptHash: promotion.receiptHash,
    priorAuthorityReceiptHash: prior?.receiptHash ?? null,
    ownerGateReceiptHash: args.phase === "owner_gate"
      ? sha256({
          kind: "v254-owner-gate-authority",
          approvalHash: plan.approvalHash,
          promotionReceiptHash: promotion.receiptHash,
        })
      : lineage.ownerGateReceiptHash,
    publicCanaryReceiptHash: args.phase === "public_canary"
      ? sha256({
          kind: "v254-public-canary-authority",
          approvalHash: plan.approvalHash,
          ownerGateReceiptHash: lineage.ownerGateReceiptHash,
          proofEvidenceHash: proofHash,
        })
      : lineage.publicCanaryReceiptHash,
    proofEvidenceHash: proofHash,
    behaviorManifestHash: behavior.manifestHash,
    semanticExecutionConfigurationHash: behavior.semanticExecutionConfigurationHash,
    approvalHash: plan.approvalHash,
    rollbackId: plan.rollbackId,
    rollingDeployGuardHash: plan.rollingDeployGuardHash,
    railwayProjectId: args.projectId,
    services: {
      interactive: { serviceId: args.services.interactive, deploymentId: deploymentIds.interactive },
      deep: { serviceId: args.services.deep, deploymentId: deploymentIds.deep },
      api: { serviceId: args.services.api, deploymentId: deploymentIds.api },
    },
    database: plan.targetDatabase,
    applied: true,
    completedAt: new Date(runtime.now()).toISOString(),
  };
  const finalReceipt = Object.freeze({
    ...unsignedBase,
    receiptHash: sha256(unsignedBase),
  });
  await dbCommand(runtime, args, "db-record", [
    Buffer.from(JSON.stringify(finalReceipt)).toString("base64url"),
  ]);
  return finalReceipt as V254EditorialRouteAuthorityReceiptV1;
}

async function databaseClient(): Promise<pg.Client> {
  const connectionString =
    process.env.DATABASE_PUBLIC_URL?.trim()
    || process.env.DATABASE_URL?.trim()
    || "";
  if (!connectionString) throw new Error("route authority database unavailable");
  const client = new pg.Client({
    connectionString,
    ssl: connectionString.includes("railway.internal")
      ? undefined
      : { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

async function databaseSnapshotMain(): Promise<void> {
  const client = await databaseClient();
  try {
    const result = await client.query<{
      disabled: boolean | null;
      global_pause: boolean;
      intent_pause: boolean;
      current_authority: string | null;
    }>(
      `SELECT
         (SELECT disabled FROM pipeline_cohort_kill_switches
          WHERE route=$1 AND intent_group=$2) disabled,
         COALESCE((SELECT value='true' FROM settings WHERE key=$3),false)
           global_pause,
         COALESCE((SELECT value='true' FROM settings WHERE key=$4),false)
           intent_pause,
         (SELECT value FROM settings WHERE key=$5) current_authority`,
      [ROUTE, INTENT, GLOBAL_PAUSE_KEY, INTENT_PAUSE_KEY, AUTHORITY_SETTING],
    );
    const row = result.rows[0]!;
    process.stdout.write(`${JSON.stringify({
      hardSwitchDisabled: row.disabled === true,
      globalPublicPause: row.global_pause === true,
      intentPublicPause: row.intent_pause === true,
      currentAuthorityReceipt: row.current_authority
        ? JSON.parse(row.current_authority)
        : null,
    })}\n`);
  } finally { await client.end(); }
}

async function databaseRollingDeployGuardMain(
  argv: readonly string[],
): Promise<void> {
  const [phase, guardHash, approvalHash, promotionHash, priorHash,
    manifestHash, semanticHash] = argv;
  if (
    phase !== "public_canary"
    || !SHA256.test(guardHash ?? "")
    || !SHA256.test(approvalHash ?? "")
    || !SHA256.test(promotionHash ?? "")
    || !SHA256.test(priorHash ?? "")
    || !SHA256.test(manifestHash ?? "")
    || !SHA256.test(semanticHash ?? "")
  ) throw new Error("rolling deployment guard arguments are invalid");
  const client = await databaseClient();
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LOCK_KEY]);
    const current = await client.query<{ value: string }>(
      "SELECT value FROM settings WHERE key=$1 FOR UPDATE",
      [AUTHORITY_SETTING],
    );
    const currentReceipt = current.rows[0]?.value
      ? validateV254EditorialRouteAuthorityReceiptV1(JSON.parse(current.rows[0].value))
      : null;
    if (currentReceipt?.receiptHash !== priorHash) {
      throw new Error("rolling deployment guard predecessor changed");
    }
    await client.query(
      `INSERT INTO settings(key,value,updated_at)
       VALUES($1,'true',now()),($2,'true',now())
       ON CONFLICT(key) DO UPDATE SET value='true',updated_at=now()`,
      [GLOBAL_PAUSE_KEY, INTENT_PAUSE_KEY],
    );
    await client.query(
      `INSERT INTO pipeline_cohort_kill_switches(
         cohort_key,route,intent_group,disabled,reason_code,changed_by,changed_at)
       VALUES('v254-editorial-route-authority',$1,$2,true,
              'v254_rolling_deploy_guard','release-authority',now())
       ON CONFLICT(route,intent_group) DO UPDATE SET
         cohort_key=excluded.cohort_key,disabled=true,
         reason_code=excluded.reason_code,changed_by=excluded.changed_by,
         changed_at=now()`,
      [ROUTE, INTENT],
    );
    await client.query(
      `INSERT INTO audit_events(actor,action,detail_json)
       VALUES('release-authority','v254.editorial_route_rolling_guard',$1::jsonb)`,
      [JSON.stringify({
        phase,
        guardHash,
        approvalHash,
        promotionHash,
        priorHash,
        manifestHash,
        semanticHash,
        target: {
          hardSwitchDisabled: true,
          globalPublicPause: true,
          intentPublicPause: true,
        },
      })],
    );
    await client.query("COMMIT");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      guardHash,
      target: {
        hardSwitchDisabled: true,
        globalPublicPause: true,
        intentPublicPause: true,
      },
    })}\n`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { await client.end(); }
}

async function databaseTransitionMain(argv: readonly string[]): Promise<void> {
  const [phase, approvalHash, promotionHash, priorHash, proofHash,
    manifestHash, semanticHash, rollbackId, rollbackTarget] = argv;
  if (
    !["owner_gate", "public_canary", "public_expose", "rollback_zero"].includes(phase ?? "")
    || !SHA256.test(approvalHash ?? "")
    || !SHA256.test(promotionHash ?? "")
    || (priorHash !== "none" && !SHA256.test(priorHash ?? ""))
    || (proofHash !== "none" && !SHA256.test(proofHash ?? ""))
    || !SHA256.test(manifestHash ?? "")
    || !SHA256.test(semanticHash ?? "")
    || !SHA256.test(rollbackId ?? "")
    || !["owner_gate", "zero"].includes(rollbackTarget ?? "")
  ) throw new Error("database route transition arguments are invalid");
  const target = targetDatabaseState(phase as V254EditorialRoutePhase);
  const client = await databaseClient();
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LOCK_KEY]);
    const current = await client.query<{ value: string }>(
      "SELECT value FROM settings WHERE key=$1 FOR UPDATE",
      [AUTHORITY_SETTING],
    );
    const currentReceipt = current.rows[0]?.value
      ? validateV254EditorialRouteAuthorityReceiptV1(JSON.parse(current.rows[0].value))
      : null;
    if ((currentReceipt?.receiptHash ?? "none") !== priorHash) {
      throw new Error("route authority predecessor changed");
    }
    await client.query(
      `INSERT INTO settings(key,value,updated_at)
       VALUES($1,$3,now()),($2,$4,now())
       ON CONFLICT(key) DO UPDATE SET
         value=excluded.value,updated_at=now()`,
      [
        GLOBAL_PAUSE_KEY,
        INTENT_PAUSE_KEY,
        target.globalPublicPause ? "true" : "false",
        target.intentPublicPause ? "true" : "false",
      ],
    );
    await client.query(
      `INSERT INTO pipeline_cohort_kill_switches(
         cohort_key,route,intent_group,disabled,reason_code,changed_by,changed_at)
       VALUES('v254-editorial-route-authority',$1,$2,$3,$4,'release-authority',now())
       ON CONFLICT(route,intent_group) DO UPDATE SET
         cohort_key=excluded.cohort_key,disabled=excluded.disabled,
         reason_code=excluded.reason_code,changed_by=excluded.changed_by,
         changed_at=now()`,
      [
        ROUTE,
        INTENT,
        target.hardSwitchDisabled,
        target.hardSwitchDisabled ? "v254_route_rollback_or_containment" : null,
      ],
    );
    await client.query(
      `INSERT INTO audit_events(actor,action,detail_json)
       VALUES('release-authority','v254.editorial_route_transition',$1::jsonb)`,
      [JSON.stringify({
        phase,
        approvalHash,
        promotionHash,
        priorHash: priorHash === "none" ? null : priorHash,
        proofHash: proofHash === "none" ? null : proofHash,
        manifestHash,
        semanticHash,
        rollbackId,
        rollbackTarget,
        target,
      })],
    );
    await client.query("COMMIT");
    process.stdout.write(`${JSON.stringify({ ok: true, target })}\n`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { await client.end(); }
}

async function databaseRecordMain(encoded: string | undefined): Promise<void> {
  if (!encoded || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new Error("route receipt encoding is invalid");
  }
  const receipt = validateV254EditorialRouteAuthorityReceiptV1(
    JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
  );
  const client = await databaseClient();
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LOCK_KEY]);
    const state = targetDatabaseState(receipt.phase);
    const observed = await client.query<{
      disabled: boolean | null;
      global_pause: boolean;
      intent_pause: boolean;
    }>(
      `SELECT
         (SELECT disabled FROM pipeline_cohort_kill_switches
          WHERE route=$1 AND intent_group=$2) disabled,
         COALESCE((SELECT value='true' FROM settings WHERE key=$3),false)
           global_pause,
         COALESCE((SELECT value='true' FROM settings WHERE key=$4),false)
           intent_pause`,
      [ROUTE, INTENT, GLOBAL_PAUSE_KEY, INTENT_PAUSE_KEY],
    );
    const row = observed.rows[0]!;
    if (
      (row.disabled === true) !== state.hardSwitchDisabled
      || row.global_pause !== state.globalPublicPause
      || row.intent_pause !== state.intentPublicPause
    ) throw new Error("cannot record authority before database convergence");
    await client.query(
      `INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now())
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`,
      [AUTHORITY_SETTING, JSON.stringify(receipt)],
    );
    await client.query("COMMIT");
    process.stdout.write(`${JSON.stringify({ ok: true, receiptHash: receipt.receiptHash })}\n`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { await client.end(); }
}

async function heartbeatSnapshotMain(): Promise<void> {
  const client = await databaseClient();
  try {
    const rows = await client.query<{
      worker_id: string;
      queue_class: string;
      revision: string;
      semantic_hash: string;
      last_seen_at: Date;
    }>(
      `SELECT worker_id,metadata_json->>'queueClass' queue_class,
              metadata_json->>'version' revision,
              metadata_json->>'semanticExecutionConfigurationHash' semantic_hash,
              last_seen_at
       FROM worker_heartbeats
       WHERE last_seen_at>now()-interval '90 seconds'
         AND metadata_json->>'queueClass' IN ('interactive','deep')
       ORDER BY queue_class,worker_id`,
    );
    process.stdout.write(`${JSON.stringify(rows.rows.map((row) => ({
      workerId: row.worker_id,
      queueClass: row.queue_class,
      revision: row.revision,
      semanticExecutionConfigurationHash: row.semantic_hash,
      lastSeenAt: row.last_seen_at.toISOString(),
    })))}\n`);
  } finally { await client.end(); }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "db-snapshot") return await databaseSnapshotMain();
  if (command === "db-guard") {
    return await databaseRollingDeployGuardMain(process.argv.slice(3));
  }
  if (command === "db-transition") {
    return await databaseTransitionMain(process.argv.slice(3));
  }
  if (command === "db-record") return await databaseRecordMain(process.argv[3]);
  if (command === "heartbeat-snapshot") return await heartbeatSnapshotMain();
  const args = parseV254EditorialRouteControlArgs(process.argv.slice(2));
  const result = await runV254EditorialRouteControl(args);
  if (args.outputPath) {
    await writeFile(args.outputPath, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: args.mode,
    phase: args.phase,
    approvalHash: "approvalHash" in result ? result.approvalHash : null,
    receiptHash: "receiptHash" in result ? result.receiptHash : null,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "v254_editorial_route_control_failed",
      message: error instanceof Error ? error.message : "route control failed",
    })}\n`);
    process.exitCode = 1;
  });
}
