import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { MAXIMUM_STAGING_MONTHLY_COST_USD } from "../.railway/release-phase.ts";

export const RELEASE_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1_000;

export const RELEASE_EVIDENCE_GATE_ENVIRONMENT = Object.freeze({
  offline_suite: "offline",
  staging_provider_manifest: "staging",
  staging_fixed_three_track: "staging",
  staging_affected_regression: "staging",
  staging_guided_constraint: "staging",
  semantic_ranking_blinded_review: "staging",
  production_fixed_three_track: "production",
  production_affected_regression: "production",
  release_convergence: "production",
  final_custom_domain_browser: "production",
} as const);

export type ReleaseEvidenceGateName = keyof typeof RELEASE_EVIDENCE_GATE_ENVIRONMENT;
export type ReleaseEvidenceKind = "candidate" | "promotion";

export interface ReleaseEvidenceGateV1 {
  name: ReleaseEvidenceGateName;
  environment: "offline" | "staging" | "production";
  passed: true;
  completedAt: string;
  evidenceHash: string;
  cacheMode: "cold" | "warm" | "mixed" | "not_applicable";
  budgetStatus: "within_cap" | "not_applicable";
}

export interface ReleaseEvidencePayloadV1 {
  schemaVersion: "genio-release-evidence/v1";
  kind: ReleaseEvidenceKind;
  generatedAt: string;
  expiresAt: string;
  candidate: {
    tag: string;
    version: string;
    sourceRevision: string;
    imageDigest: string;
    sitesSourceRevision: string;
  };
  configuration: {
    apiHash: string;
    interactiveWorkerHash: string;
    deepWorkerHash: string;
    sitesHash: string;
    secretVersionsHash: string;
  };
  stagingControls: {
    monthlyCostLimitUsd: number;
    budgetRemainingUsd: number;
    reservedForRequiredGatesUsd: number;
    budgetStatus: "available";
    musicKitOrigin: string;
    providerSecretVersionHash: string;
    productionProviderSecretVersionHash: string;
    appleSecretVersionHash: string;
    productionAppleSecretVersionHash: string;
    appleAccountSeparationEvidenceHash: string;
    musicKitOriginRegistrationEvidenceHash: string;
  };
  runtime: {
    deploymentPhase: "activate";
    databaseSchemaVersion: string;
    workerProtocol: string;
    briefContractVersion: string;
    queryPlanSchemaVersion: string;
    modelIds: {
      brief: string;
      baseline: string;
      escalation: string;
    };
    policyVersions: {
      guidance: string;
      evidence: string;
      queryPlan: string;
      selection: string;
      semanticScope: string;
      musicConcept: string;
      pipeline: string;
      prompt: string;
    };
  };
  gates: ReleaseEvidenceGateV1[];
}

export interface SignedReleaseEvidenceV1 {
  schemaVersion: "genio-signed-release-evidence/v1";
  payload: ReleaseEvidencePayloadV1;
  payloadHash: string;
  signature: {
    algorithm: "Ed25519";
    keyId: string;
    value: string;
  };
}

type JsonRecord = Record<string, unknown>;

const CANDIDATE_GATES: readonly ReleaseEvidenceGateName[] = [
  "offline_suite",
  "staging_provider_manifest",
  "staging_fixed_three_track",
  "staging_affected_regression",
  "staging_guided_constraint",
  "semantic_ranking_blinded_review",
];
const PROMOTION_GATES: readonly ReleaseEvidenceGateName[] = [
  ...CANDIDATE_GATES,
  "production_fixed_three_track",
  "production_affected_regression",
  "release_convergence",
  "final_custom_domain_browser",
];
const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const SAFE_LABEL = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{0,159}$/u;
const SIGNATURE_VALUE = /^[0-9A-Za-z_-]{64,256}$/u;
const REQUIRED_RUNTIME_CONTRACT = Object.freeze({
  deploymentPhase: "activate",
  databaseSchemaVersion: "18",
  workerProtocol: "playlist-pipeline-v10",
  briefContractVersion: "3",
  queryPlanSchemaVersion: "4",
});
const REQUIRED_RUNTIME_POLICY_VERSIONS = Object.freeze({
  guidance: "adaptive_guidance_v3",
  evidence: "governed_evidence_v2",
});

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(record: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unapproved fields`);
  }
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function label(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_LABEL.test(value) || /(?:sk-|secret|token|password)/iu.test(value)) {
    throw new Error(`${field} is not an approved release label`);
  }
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${field} must be a SHA-256 digest`);
  return value;
}

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortedJsonValue(item)]),
  );
}

export function stableReleaseEvidenceJson(value: unknown): string {
  return JSON.stringify(sortedJsonValue(value));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableReleaseEvidenceJson(value)).digest("hex");
}

export function releaseEvidenceConfigurationHash(
  payload: Pick<ReleaseEvidencePayloadV1, "configuration">,
): string {
  return sha256(payload.configuration);
}

export function releaseEvidenceRuntimeHash(
  payload: Pick<ReleaseEvidencePayloadV1, "runtime">,
): string {
  return sha256(payload.runtime);
}

function requiredGates(kind: ReleaseEvidenceKind): readonly ReleaseEvidenceGateName[] {
  return kind === "promotion" ? PROMOTION_GATES : CANDIDATE_GATES;
}

export function validateReleaseEvidencePayload(value: unknown): ReleaseEvidencePayloadV1 {
  const root = asRecord(value, "release evidence");
  exactKeys(root, [
    "schemaVersion",
    "kind",
    "generatedAt",
    "expiresAt",
    "candidate",
    "configuration",
    "stagingControls",
    "runtime",
    "gates",
  ], "release evidence");
  if (root.schemaVersion !== "genio-release-evidence/v1") {
    throw new Error("release evidence uses an unsupported schema");
  }
  if (root.kind !== "candidate" && root.kind !== "promotion") {
    throw new Error("release evidence kind must be candidate or promotion");
  }
  const generatedAt = timestamp(root.generatedAt, "generatedAt");
  const expiresAt = timestamp(root.expiresAt, "expiresAt");
  const lifetime = Date.parse(expiresAt) - Date.parse(generatedAt);
  if (lifetime <= 0 || lifetime > RELEASE_EVIDENCE_TTL_MS) {
    throw new Error("release evidence must expire within 24 hours");
  }

  const candidate = asRecord(root.candidate, "candidate");
  exactKeys(candidate, [
    "tag",
    "version",
    "sourceRevision",
    "imageDigest",
    "sitesSourceRevision",
  ], "candidate");
  if (typeof candidate.version !== "string" || !VERSION.test(candidate.version)) {
    throw new Error("candidate.version must be a stable semantic version");
  }
  if (typeof candidate.tag !== "string"
    || !new RegExp(`^v${candidate.version.replaceAll(".", "\\.")}-rc\\.[1-9]\\d*$`, "u").test(candidate.tag)) {
    throw new Error("candidate.tag must be an RC tag for candidate.version");
  }
  if (typeof candidate.sourceRevision !== "string" || !SOURCE_REVISION.test(candidate.sourceRevision)) {
    throw new Error("candidate.sourceRevision must be a full Git revision");
  }
  if (typeof candidate.sitesSourceRevision !== "string" || !SOURCE_REVISION.test(candidate.sitesSourceRevision)) {
    throw new Error("candidate.sitesSourceRevision must be a full Git revision");
  }
  if (candidate.sitesSourceRevision !== candidate.sourceRevision) {
    throw new Error("Sites and backend evidence must bind the same source revision");
  }
  if (typeof candidate.imageDigest !== "string" || !IMAGE_DIGEST.test(candidate.imageDigest)) {
    throw new Error("candidate.imageDigest must be an immutable SHA-256 image digest");
  }

  const configuration = asRecord(root.configuration, "configuration");
  exactKeys(configuration, [
    "apiHash",
    "interactiveWorkerHash",
    "deepWorkerHash",
    "sitesHash",
    "secretVersionsHash",
  ], "configuration");
  for (const field of [
    "apiHash",
    "interactiveWorkerHash",
    "deepWorkerHash",
    "sitesHash",
    "secretVersionsHash",
  ] as const) {
    digest(configuration[field], `configuration.${field}`);
  }

  const stagingControls = asRecord(root.stagingControls, "stagingControls");
  exactKeys(stagingControls, [
    "monthlyCostLimitUsd",
    "budgetRemainingUsd",
    "reservedForRequiredGatesUsd",
    "budgetStatus",
    "musicKitOrigin",
    "providerSecretVersionHash",
    "productionProviderSecretVersionHash",
    "appleSecretVersionHash",
    "productionAppleSecretVersionHash",
    "appleAccountSeparationEvidenceHash",
    "musicKitOriginRegistrationEvidenceHash",
  ], "stagingControls");
  const monthlyCostLimitUsd = Number(stagingControls.monthlyCostLimitUsd);
  const budgetRemainingUsd = Number(stagingControls.budgetRemainingUsd);
  const reservedForRequiredGatesUsd = Number(stagingControls.reservedForRequiredGatesUsd);
  if (
    !Number.isFinite(monthlyCostLimitUsd)
    || monthlyCostLimitUsd <= 0
    || monthlyCostLimitUsd > MAXIMUM_STAGING_MONTHLY_COST_USD
  ) {
    throw new Error("stagingControls.monthlyCostLimitUsd is not a valid capped QA budget");
  }
  if (
    !Number.isFinite(budgetRemainingUsd)
    || budgetRemainingUsd <= 0
    || budgetRemainingUsd > monthlyCostLimitUsd
    || !Number.isFinite(reservedForRequiredGatesUsd)
    || reservedForRequiredGatesUsd <= 0
    || reservedForRequiredGatesUsd > budgetRemainingUsd
  ) {
    throw new Error("staging QA budget cannot cover every required live gate");
  }
  if (stagingControls.budgetStatus !== "available") {
    throw new Error("staging QA budget is not available");
  }
  if (typeof stagingControls.musicKitOrigin !== "string") {
    throw new Error("stagingControls.musicKitOrigin must be a dedicated HTTPS origin");
  }
  let musicKitOrigin: URL;
  try {
    musicKitOrigin = new URL(stagingControls.musicKitOrigin);
  } catch {
    throw new Error("stagingControls.musicKitOrigin must be a dedicated HTTPS origin");
  }
  if (
    musicKitOrigin.protocol !== "https:"
    || musicKitOrigin.origin !== stagingControls.musicKitOrigin
    || musicKitOrigin.pathname !== "/"
    || musicKitOrigin.username
    || musicKitOrigin.password
    || musicKitOrigin.hostname === "9enio.com"
    || musicKitOrigin.hostname === "www.9enio.com"
  ) {
    throw new Error("stagingControls.musicKitOrigin must be a dedicated non-production HTTPS origin");
  }
  for (const field of [
    "providerSecretVersionHash",
    "productionProviderSecretVersionHash",
    "appleSecretVersionHash",
    "productionAppleSecretVersionHash",
    "appleAccountSeparationEvidenceHash",
    "musicKitOriginRegistrationEvidenceHash",
  ] as const) {
    digest(stagingControls[field], `stagingControls.${field}`);
  }
  if (stagingControls.providerSecretVersionHash === stagingControls.productionProviderSecretVersionHash) {
    throw new Error("staging and production provider credential versions must be different");
  }
  if (stagingControls.appleSecretVersionHash === stagingControls.productionAppleSecretVersionHash) {
    throw new Error("staging and production Apple credential versions must be different");
  }

  const runtime = asRecord(root.runtime, "runtime");
  exactKeys(runtime, [
    "deploymentPhase",
    "databaseSchemaVersion",
    "workerProtocol",
    "briefContractVersion",
    "queryPlanSchemaVersion",
    "modelIds",
    "policyVersions",
  ], "runtime");
  for (const field of [
    "deploymentPhase",
    "databaseSchemaVersion",
    "workerProtocol",
    "briefContractVersion",
    "queryPlanSchemaVersion",
  ] as const) {
    label(runtime[field], `runtime.${field}`);
    if (runtime[field] !== REQUIRED_RUNTIME_CONTRACT[field]) {
      throw new Error(`runtime.${field} does not match the schema-18/protocol-10 release contract`);
    }
  }
  const modelIds = asRecord(runtime.modelIds, "runtime.modelIds");
  exactKeys(modelIds, ["brief", "baseline", "escalation"], "runtime.modelIds");
  for (const field of ["brief", "baseline", "escalation"] as const) {
    label(modelIds[field], `runtime.modelIds.${field}`);
  }
  const policyVersions = asRecord(runtime.policyVersions, "runtime.policyVersions");
  exactKeys(policyVersions, [
    "guidance",
    "evidence",
    "queryPlan",
    "selection",
    "semanticScope",
    "musicConcept",
    "pipeline",
    "prompt",
  ], "runtime.policyVersions");
  for (const field of [
    "guidance",
    "evidence",
    "queryPlan",
    "selection",
    "semanticScope",
    "musicConcept",
    "pipeline",
    "prompt",
  ] as const) {
    label(policyVersions[field], `runtime.policyVersions.${field}`);
  }
  for (const field of ["guidance", "evidence"] as const) {
    if (policyVersions[field] !== REQUIRED_RUNTIME_POLICY_VERSIONS[field]) {
      throw new Error(
        `runtime.policyVersions.${field} does not match the schema-18/protocol-10 release contract`,
      );
    }
  }

  if (!Array.isArray(root.gates)) throw new Error("gates must be an array");
  const gateNames = new Set<ReleaseEvidenceGateName>();
  for (const [index, item] of root.gates.entries()) {
    const gate = asRecord(item, `gates[${index}]`);
    exactKeys(gate, [
      "name",
      "environment",
      "passed",
      "completedAt",
      "evidenceHash",
      "cacheMode",
      "budgetStatus",
    ], `gates[${index}]`);
    if (typeof gate.name !== "string" || !(gate.name in RELEASE_EVIDENCE_GATE_ENVIRONMENT)) {
      throw new Error(`gates[${index}].name is not an approved release gate`);
    }
    const gateName = gate.name as ReleaseEvidenceGateName;
    if (gateNames.has(gateName)) throw new Error(`release gate ${gateName} is duplicated`);
    gateNames.add(gateName);
    if (gate.environment !== RELEASE_EVIDENCE_GATE_ENVIRONMENT[gateName]) {
      throw new Error(`release gate ${gateName} has the wrong environment`);
    }
    if (gate.passed !== true) throw new Error(`release gate ${gateName} did not pass`);
    const completedAt = timestamp(gate.completedAt, `gates[${index}].completedAt`);
    const completedMs = Date.parse(completedAt);
    const generatedMs = Date.parse(generatedAt);
    if (completedMs > generatedMs + 5 * 60 * 1_000
      || generatedMs - completedMs > RELEASE_EVIDENCE_TTL_MS) {
      throw new Error(`release gate ${gateName} is outside the 24-hour evidence window`);
    }
    digest(gate.evidenceHash, `gates[${index}].evidenceHash`);
    if (!new Set(["cold", "warm", "mixed", "not_applicable"]).has(String(gate.cacheMode))) {
      throw new Error(`release gate ${gateName} has an invalid cache mode`);
    }
    const expectedBudgetStatus = gate.environment === "staging"
      ? "within_cap"
      : "not_applicable";
    if (gate.budgetStatus !== expectedBudgetStatus) {
      throw new Error(`release gate ${gateName} does not prove the required QA budget state`);
    }
  }
  const expectedGates = requiredGates(root.kind);
  const missing = expectedGates.filter((gate) => !gateNames.has(gate));
  const extras = [...gateNames].filter((gate) => !expectedGates.includes(gate));
  if (missing.length > 0 || extras.length > 0) {
    throw new Error(`release evidence gates do not match ${root.kind}: missing=${missing.join(",") || "none"} extras=${extras.join(",") || "none"}`);
  }
  return value as ReleaseEvidencePayloadV1;
}

function signingMaterial(payload: ReleaseEvidencePayloadV1, keyId: string): string {
  return stableReleaseEvidenceJson({
    algorithm: "Ed25519",
    keyId,
    payload,
  });
}

function privateKey(value: string | Buffer | KeyObject): KeyObject {
  return value instanceof KeyObject ? value : createPrivateKey(value);
}

function publicKey(value: string | Buffer | KeyObject): KeyObject {
  return value instanceof KeyObject ? value : createPublicKey(value);
}

export function signReleaseEvidence(
  payloadValue: unknown,
  signingKey: string | Buffer | KeyObject,
  keyIdValue: string,
): SignedReleaseEvidenceV1 {
  const payload = validateReleaseEvidencePayload(payloadValue);
  const keyId = label(keyIdValue, "signature.keyId");
  const value = sign(
    null,
    Buffer.from(signingMaterial(payload, keyId)),
    privateKey(signingKey),
  ).toString("base64url");
  return {
    schemaVersion: "genio-signed-release-evidence/v1",
    payload,
    payloadHash: sha256(payload),
    signature: {
      algorithm: "Ed25519",
      keyId,
      value,
    },
  };
}

export function verifyReleaseEvidence(
  value: unknown,
  verificationKey: string | Buffer | KeyObject,
  options: {
    expectedKind: ReleaseEvidenceKind;
    now?: string;
    expectedRevision?: string;
    expectedImageDigest?: string;
    expectedTag?: string;
    expectedConfigurationHash?: string;
    expectedRuntimeHash?: string;
  },
): ReleaseEvidencePayloadV1 {
  if (
    !options
    || (options.expectedKind !== "candidate" && options.expectedKind !== "promotion")
  ) {
    throw new Error("release evidence verification requires an expected candidate or promotion kind");
  }
  const envelope = asRecord(value, "signed release evidence");
  exactKeys(envelope, ["schemaVersion", "payload", "payloadHash", "signature"], "signed release evidence");
  if (envelope.schemaVersion !== "genio-signed-release-evidence/v1") {
    throw new Error("signed release evidence uses an unsupported schema");
  }
  const payload = validateReleaseEvidencePayload(envelope.payload);
  if (payload.kind !== options.expectedKind) {
    throw new Error(
      `release evidence kind ${payload.kind} does not match expected ${options.expectedKind}`,
    );
  }
  if (typeof envelope.payloadHash !== "string" || envelope.payloadHash !== sha256(payload)) {
    throw new Error("release evidence payload hash does not match");
  }
  const signature = asRecord(envelope.signature, "signature");
  exactKeys(signature, ["algorithm", "keyId", "value"], "signature");
  if (signature.algorithm !== "Ed25519") throw new Error("release evidence signature algorithm is unsupported");
  const keyId = label(signature.keyId, "signature.keyId");
  if (typeof signature.value !== "string" || !SIGNATURE_VALUE.test(signature.value)) {
    throw new Error("release evidence signature is malformed");
  }
  const valid = verify(
    null,
    Buffer.from(signingMaterial(payload, keyId)),
    publicKey(verificationKey),
    Buffer.from(signature.value, "base64url"),
  );
  if (!valid) throw new Error("release evidence signature is invalid");
  const now = Date.parse(options.now ? timestamp(options.now, "verification time") : new Date().toISOString());
  if (now < Date.parse(payload.generatedAt) - 5 * 60 * 1_000) {
    throw new Error("release evidence was generated in the future");
  }
  if (now >= Date.parse(payload.expiresAt)) throw new Error("release evidence has expired");
  if (options.expectedRevision && payload.candidate.sourceRevision !== options.expectedRevision) {
    throw new Error("release evidence source revision does not match the promotion target");
  }
  if (options.expectedImageDigest && payload.candidate.imageDigest !== options.expectedImageDigest) {
    throw new Error("release evidence image digest does not match the promotion target");
  }
  if (options.expectedTag && payload.candidate.tag !== options.expectedTag) {
    throw new Error("release evidence RC tag does not match the promotion target");
  }
  if (options.expectedConfigurationHash
    && releaseEvidenceConfigurationHash(payload) !== options.expectedConfigurationHash) {
    throw new Error("release evidence configuration does not match the promotion target");
  }
  if (options.expectedRuntimeHash
    && releaseEvidenceRuntimeHash(payload) !== options.expectedRuntimeHash) {
    throw new Error("release evidence runtime does not match the promotion target");
  }
  return payload;
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : "";
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "sign") {
    const inputPath = option(args, "--input");
    const outputPath = option(args, "--output");
    const privateKeyPath = option(args, "--private-key");
    const keyId = option(args, "--key-id");
    const [input, pem] = await Promise.all([
      readFile(inputPath, "utf8"),
      readFile(privateKeyPath),
    ]);
    const evidence = signReleaseEvidence(JSON.parse(input), pem, keyId);
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command,
      payloadHash: evidence.payloadHash,
      configurationHash: releaseEvidenceConfigurationHash(evidence.payload),
      runtimeHash: releaseEvidenceRuntimeHash(evidence.payload),
      keyId: evidence.signature.keyId,
      output: outputPath,
    })}\n`);
    return;
  }
  if (command === "verify") {
    const inputPath = option(args, "--input");
    const publicKeyPath = option(args, "--public-key");
    const expectedRevision = option(args, "--expected-revision");
    const expectedImageDigest = option(args, "--expected-image-digest");
    const expectedTag = option(args, "--expected-tag");
    const expectedConfigurationHash = option(args, "--expected-configuration-hash");
    const expectedRuntimeHash = option(args, "--expected-runtime-hash");
    const expectedKindValue = option(args, "--expected-kind");
    if (expectedKindValue !== "candidate" && expectedKindValue !== "promotion") {
      throw new Error("--expected-kind must be candidate or promotion");
    }
    const [input, pem] = await Promise.all([
      readFile(inputPath, "utf8"),
      readFile(publicKeyPath),
    ]);
    const envelope = JSON.parse(input) as SignedReleaseEvidenceV1;
    const payload = verifyReleaseEvidence(envelope, pem, {
      expectedKind: expectedKindValue,
      expectedRevision,
      expectedImageDigest,
      expectedTag,
      expectedConfigurationHash: digest(expectedConfigurationHash, "--expected-configuration-hash"),
      expectedRuntimeHash: digest(expectedRuntimeHash, "--expected-runtime-hash"),
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command,
      kind: payload.kind,
      payloadHash: envelope.payloadHash,
      keyId: envelope.signature.keyId,
      tag: payload.candidate.tag,
      configurationHash: releaseEvidenceConfigurationHash(payload),
      runtimeHash: releaseEvidenceRuntimeHash(payload),
      expiresAt: payload.expiresAt,
    })}\n`);
    return;
  }
  throw new Error(
    "Usage: release-evidence sign --input payload.json --output evidence.json --private-key key.pem --key-id <id> | "
    + "verify --input evidence.json --public-key key.pub.pem --expected-revision <sha> "
    + "--expected-image-digest sha256:<digest> --expected-tag vX.Y.Z-rc.N "
    + "--expected-kind candidate|promotion --expected-configuration-hash <sha256> "
    + "--expected-runtime-hash <sha256>",
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "release_evidence_failed",
      message: error instanceof Error ? error.message : "Release evidence failed",
    })}\n`);
    process.exitCode = 1;
  });
}
