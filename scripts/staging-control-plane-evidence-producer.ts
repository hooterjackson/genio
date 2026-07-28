import { execFile } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
} from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { RELEASE_EVIDENCE_TTL_MS } from "../shared/release-evidence-constants.ts";
import {
  SIGNED_STAGING_CONTROL_PLANE_EVIDENCE_SCHEMA_V1,
  STAGING_CONTROL_PLANE_EVIDENCE_SCHEMA_V1,
  STAGING_CONTROL_PLANE_ISSUER_V1,
  stagingControlPlaneKeyFingerprint,
  stagingControlPlaneTrustPolicyV1,
  verifyStagingControlPlaneEvidence,
} from "../shared/staging-control-plane-evidence.ts";
import {
  controlPlaneReceiptTrustPolicyV1,
  verifyAppleControlPlaneReceipt,
  verifyProviderControlPlaneReceipt,
  verifyQaBudgetLedgerReceipt,
  type ControlPlaneEvidencePhase,
  type ControlPlaneReceiptTrustPolicyV1,
} from "../shared/staging-control-plane-receipts.ts";
import {
  createStrictSignedEnvelope,
  signedArtifactSha256,
  type JsonRecord,
} from "../shared/signed-artifact.ts";
import {
  validateRuntimeSnapshot,
  verifyReleaseEvidence,
  type LoadedRuntimeSnapshotV1,
} from "./release-evidence.ts";

const execFileAsync = promisify(execFile);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SOURCE_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_REFERENCE =
  /^ghcr\.io\/[0-9a-z](?:[0-9a-z._/-]*[0-9a-z])?@sha256:[0-9a-f]{64}$/u;
const KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u;

export interface RailwayEnvironmentSelectorV1 {
  projectId: string;
  environmentId: string;
  requiredServiceIds: string[];
  candidateServiceIds: string[];
}

export interface RailwayControlPlaneQueryAdapter {
  queryStatus(
    selector: Pick<RailwayEnvironmentSelectorV1, "projectId" | "environmentId">,
  ): Promise<unknown>;
  querySecretVersionsHash(input: {
    projectId: string;
    environmentId: string;
    serviceId: string;
  }): Promise<string>;
}

export interface VerifiedRailwayEnvironmentV1 {
  railwayProjectIdHash: string;
  railwayEnvironmentIdHash: string;
  railwayServiceInventoryHash: string;
}

export interface StagingControlPlaneEvidenceProducerArgs {
  phase: ControlPlaneEvidencePhase;
  candidateImageDigest: string;
  candidateImageReference: string;
  stagingRuntimeSnapshotPath: string;
  productionRuntimeSnapshotPath: string | null;
  candidateEvidencePath: string | null;
  candidateEvidenceVerificationKeyPath: string | null;
  candidateEvidenceKeySha256: string | null;
  appleReceiptPath: string;
  appleReceiptVerificationKeyPath: string;
  providerReceiptPath: string;
  providerReceiptVerificationKeyPath: string;
  budgetReceiptPath: string;
  budgetReceiptVerificationKeyPath: string;
  producerSigningKeyPath: string;
  outputPath: string;
  verificationKeyOutputPath: string;
  producerKeyId: string;
  producerKeySha256: string;
  stagingOrigin: string;
  productionOrigin: string;
  stagingRailway: RailwayEnvironmentSelectorV1;
  productionRailway: RailwayEnvironmentSelectorV1;
  appleReceiptTrust: ControlPlaneReceiptTrustPolicyV1;
  providerReceiptTrust: ControlPlaneReceiptTrustPolicyV1;
  budgetReceiptTrust: ControlPlaneReceiptTrustPolicyV1;
}

interface LoadedInputs {
  stagingSnapshot: LoadedRuntimeSnapshotV1;
  productionSnapshot: LoadedRuntimeSnapshotV1 | null;
  candidateEvidence: unknown | null;
  candidateEvidenceVerificationKey: KeyObject | null;
  appleReceipt: unknown;
  appleReceiptVerificationKey: KeyObject;
  providerReceipt: unknown;
  providerReceiptVerificationKey: KeyObject;
  budgetReceipt: unknown;
  budgetReceiptVerificationKey: KeyObject;
  producerSigningKey: KeyObject;
  producerVerificationKey: KeyObject;
}

export interface CandidateReleaseEvidenceVerifier {
  verify(input: {
    value: unknown;
    verificationKey: KeyObject;
    candidate: LoadedRuntimeSnapshotV1["candidate"] & {
      imageDigest: string;
      imageReference: string;
    };
    stagingRuntimeSnapshotHash: string;
    now: string;
  }): {
    payloadHash: string;
    expiresAt: string;
  };
}

interface RailwayStatusService {
  serviceId: string;
  deploymentStatus: "SUCCESS";
  instanceStatus: "RUNNING";
  sourceRevision: string | null;
  imageDigest: string;
  imageReference: string | null;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function option(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : "";
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function optionalOption(argv: readonly string[], name: string): string | null {
  return argv.includes(name) ? option(argv, name) : null;
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required in the protected environment`);
  return value;
}

function digest(
  value: string,
  label: string,
): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function uuid(value: string, label: string): string {
  if (!UUID.test(value)) throw new Error(`${label} must be a Railway UUID`);
  return value.toLowerCase();
}

function serviceIds(value: string, label: string): string[] {
  const result = value
    .split(",")
    .map((item) => uuid(item.trim(), label))
    .sort();
  if (
    result.length < 1
    || result.length > 20
    || new Set(result).size !== result.length
  ) {
    throw new Error(`${label} must be a non-empty unique Railway service allowlist`);
  }
  return result;
}

function httpsOrigin(
  value: string,
  label: string,
  environment: "staging" | "production",
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an HTTPS origin`);
  }
  const productionHost =
    parsed.hostname === "9enio.com" || parsed.hostname === "www.9enio.com";
  if (
    parsed.protocol !== "https:"
    || parsed.origin !== value
    || parsed.pathname !== "/"
    || parsed.username
    || parsed.password
    || (environment === "staging" && productionHost)
    || (environment === "production" && !productionHost)
  ) {
    throw new Error(`${label} must identify the exact ${environment} HTTPS origin`);
  }
  return value;
}

function receiptTrustFromEnvironment(
  environment: NodeJS.ProcessEnv,
  prefix:
    | "RELEASE_APPLE_CONTROL_PLANE"
    | "RELEASE_PROVIDER_CONTROL_PLANE"
    | "RELEASE_QA_BUDGET_LEDGER",
  receiptKind: "apple" | "provider" | "qa_budget",
): ControlPlaneReceiptTrustPolicyV1 {
  return controlPlaneReceiptTrustPolicyV1({
    receiptKind,
    approvedIssuer: requiredEnvironment(environment, `${prefix}_ISSUER`),
    approvedKeyId: requiredEnvironment(environment, `${prefix}_KEY_ID`),
    approvedKeySha256: requiredEnvironment(environment, `${prefix}_KEY_SHA256`)
      .toLowerCase(),
  });
}

export function parseStagingControlPlaneEvidenceProducerArgs(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): StagingControlPlaneEvidenceProducerArgs {
  const allowed = new Set([
    "--phase",
    "--candidate-image-digest",
    "--staging-runtime-snapshot",
    "--production-runtime-snapshot",
    "--candidate-evidence",
    "--candidate-evidence-verification-key",
    "--apple-receipt",
    "--apple-receipt-verification-key",
    "--provider-receipt",
    "--provider-receipt-verification-key",
    "--budget-receipt",
    "--budget-receipt-verification-key",
    "--producer-signing-key",
    "--output",
    "--verification-key-output",
  ]);
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index] ?? "";
    if (!allowed.has(argument)) {
      throw new Error(`Unknown argument: ${String(argv[index])}`);
    }
    if (seen.has(argument)) {
      throw new Error(`Duplicate argument: ${argument}`);
    }
    seen.add(argument);
    if (argv[index + 1] === undefined || argv[index + 1]!.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
  }
  const phase = option(argv, "--phase");
  if (
    phase !== "candidate"
    && phase !== "promotion"
    && phase !== "finalization"
  ) {
    throw new Error("--phase must be candidate, promotion, or finalization");
  }
  const candidateImageDigest = option(argv, "--candidate-image-digest")
    .toLowerCase();
  if (!IMAGE_DIGEST.test(candidateImageDigest)) {
    throw new Error("--candidate-image-digest must be an immutable SHA-256 image digest");
  }
  const candidateImageReference = requiredEnvironment(
    environment,
    "RELEASE_CANDIDATE_IMAGE_REFERENCE",
  ).toLowerCase();
  if (
    !IMAGE_REFERENCE.test(candidateImageReference)
    || !candidateImageReference.endsWith(`@${candidateImageDigest}`)
  ) {
    throw new Error(
      "RELEASE_CANDIDATE_IMAGE_REFERENCE must be an immutable GHCR reference matching the candidate digest",
    );
  }
  const productionRuntimeSnapshotPath =
    optionalOption(argv, "--production-runtime-snapshot");
  const candidateEvidencePath = optionalOption(argv, "--candidate-evidence");
  const candidateEvidenceVerificationKeyPath = optionalOption(
    argv,
    "--candidate-evidence-verification-key",
  );
  if (
    phase === "candidate"
      ? (
        productionRuntimeSnapshotPath !== null
        || candidateEvidencePath !== null
        || candidateEvidenceVerificationKeyPath !== null
      )
      : (
        productionRuntimeSnapshotPath === null
        || candidateEvidencePath === null
        || candidateEvidenceVerificationKeyPath === null
      )
  ) {
    throw new Error(
      "candidate phase forbids production candidate inputs; promotion and finalization require all of them",
    );
  }
  const stagingProjectId = uuid(
    requiredEnvironment(environment, "RELEASE_STAGING_RAILWAY_PROJECT_ID"),
    "RELEASE_STAGING_RAILWAY_PROJECT_ID",
  );
  const productionProjectId = uuid(
    requiredEnvironment(environment, "RELEASE_PRODUCTION_RAILWAY_PROJECT_ID"),
    "RELEASE_PRODUCTION_RAILWAY_PROJECT_ID",
  );
  const stagingEnvironmentId = uuid(
    requiredEnvironment(environment, "RELEASE_STAGING_RAILWAY_ENVIRONMENT_ID"),
    "RELEASE_STAGING_RAILWAY_ENVIRONMENT_ID",
  );
  const productionEnvironmentId = uuid(
    requiredEnvironment(environment, "RELEASE_PRODUCTION_RAILWAY_ENVIRONMENT_ID"),
    "RELEASE_PRODUCTION_RAILWAY_ENVIRONMENT_ID",
  );
  if (
    stagingProjectId === productionProjectId
    || stagingEnvironmentId === productionEnvironmentId
  ) {
    throw new Error("staging and production Railway identities must be separate");
  }
  const producerKeyId = requiredEnvironment(
    environment,
    "RELEASE_STAGING_CONTROL_PLANE_KEY_ID",
  );
  if (!KEY_ID.test(producerKeyId)) {
    throw new Error("RELEASE_STAGING_CONTROL_PLANE_KEY_ID is invalid");
  }
  const producerKeySha256 = digest(
    requiredEnvironment(
      environment,
      "RELEASE_STAGING_CONTROL_PLANE_KEY_SHA256",
    ).toLowerCase(),
    "RELEASE_STAGING_CONTROL_PLANE_KEY_SHA256",
  );
  const stagingOrigin = httpsOrigin(
    requiredEnvironment(environment, "RELEASE_STAGING_ORIGIN"),
    "RELEASE_STAGING_ORIGIN",
    "staging",
  );
  const protectedMusicKitOrigin = httpsOrigin(
    requiredEnvironment(environment, "GENIO_STAGING_MUSICKIT_ORIGIN"),
    "GENIO_STAGING_MUSICKIT_ORIGIN",
    "staging",
  );
  if (stagingOrigin !== protectedMusicKitOrigin) {
    throw new Error(
      "GENIO_STAGING_MUSICKIT_ORIGIN must equal the observed staging runtime origin",
    );
  }
  const stagingRequiredServiceIds = serviceIds(
    requiredEnvironment(
      environment,
      "RELEASE_STAGING_RAILWAY_SERVICE_IDS",
    ),
    "RELEASE_STAGING_RAILWAY_SERVICE_IDS",
  );
  const productionRequiredServiceIds = serviceIds(
    requiredEnvironment(
      environment,
      "RELEASE_PRODUCTION_RAILWAY_SERVICE_IDS",
    ),
    "RELEASE_PRODUCTION_RAILWAY_SERVICE_IDS",
  );
  const stagingCandidateServiceIds = serviceIds(
    requiredEnvironment(
      environment,
      "RELEASE_STAGING_RAILWAY_CANDIDATE_SERVICE_IDS",
    ),
    "RELEASE_STAGING_RAILWAY_CANDIDATE_SERVICE_IDS",
  );
  const productionCandidateServiceIds = serviceIds(
    requiredEnvironment(
      environment,
      "RELEASE_PRODUCTION_RAILWAY_CANDIDATE_SERVICE_IDS",
    ),
    "RELEASE_PRODUCTION_RAILWAY_CANDIDATE_SERVICE_IDS",
  );
  if (
    stagingCandidateServiceIds.length < 3
    || productionCandidateServiceIds.length < 3
    || stagingCandidateServiceIds.some(
      (id) => !stagingRequiredServiceIds.includes(id),
    )
    || productionCandidateServiceIds.some(
      (id) => !productionRequiredServiceIds.includes(id),
    )
  ) {
    throw new Error("Railway candidate services must be in the protected inventory");
  }
  return {
    phase,
    candidateImageDigest,
    candidateImageReference,
    stagingRuntimeSnapshotPath:
      option(argv, "--staging-runtime-snapshot"),
    productionRuntimeSnapshotPath,
    candidateEvidencePath,
    candidateEvidenceVerificationKeyPath,
    candidateEvidenceKeySha256: phase !== "candidate"
      ? digest(
        requiredEnvironment(
          environment,
          "RELEASE_CANDIDATE_EVIDENCE_KEY_SHA256",
        ).toLowerCase(),
        "RELEASE_CANDIDATE_EVIDENCE_KEY_SHA256",
      )
      : null,
    appleReceiptPath: option(argv, "--apple-receipt"),
    appleReceiptVerificationKeyPath:
      option(argv, "--apple-receipt-verification-key"),
    providerReceiptPath: option(argv, "--provider-receipt"),
    providerReceiptVerificationKeyPath:
      option(argv, "--provider-receipt-verification-key"),
    budgetReceiptPath: option(argv, "--budget-receipt"),
    budgetReceiptVerificationKeyPath:
      option(argv, "--budget-receipt-verification-key"),
    producerSigningKeyPath: option(argv, "--producer-signing-key"),
    outputPath: option(argv, "--output"),
    verificationKeyOutputPath: option(argv, "--verification-key-output"),
    producerKeyId,
    producerKeySha256,
    stagingOrigin,
    productionOrigin: httpsOrigin(
      requiredEnvironment(environment, "RELEASE_PRODUCTION_ORIGIN"),
      "RELEASE_PRODUCTION_ORIGIN",
      "production",
    ),
    stagingRailway: {
      projectId: stagingProjectId,
      environmentId: stagingEnvironmentId,
      requiredServiceIds: stagingRequiredServiceIds,
      candidateServiceIds: stagingCandidateServiceIds,
    },
    productionRailway: {
      projectId: productionProjectId,
      environmentId: productionEnvironmentId,
      requiredServiceIds: productionRequiredServiceIds,
      candidateServiceIds: productionCandidateServiceIds,
    },
    appleReceiptTrust: receiptTrustFromEnvironment(
      environment,
      "RELEASE_APPLE_CONTROL_PLANE",
      "apple",
    ),
    providerReceiptTrust: receiptTrustFromEnvironment(
      environment,
      "RELEASE_PROVIDER_CONTROL_PLANE",
      "provider",
    ),
    budgetReceiptTrust: receiptTrustFromEnvironment(
      environment,
      "RELEASE_QA_BUDGET_LEDGER",
      "qa_budget",
    ),
  };
}

function opaqueIdentifierHash(kind: string, value: string): string {
  return createHash("sha256")
    .update(`genio-control-plane:${kind}:v1:${value}`)
    .digest("hex");
}

export function validateRailwayStatusMetadata(input: {
  value: unknown;
  selector: RailwayEnvironmentSelectorV1;
  expectedCandidate: {
    sourceRevision: string;
    imageDigest: string;
    imageReference: string;
  } | null;
  forbiddenCandidate: {
    sourceRevision: string;
    imageDigest: string;
    imageReference: string;
  } | null;
}): VerifiedRailwayEnvironmentV1 {
  const root = record(input.value, "Railway status response");
  if (uuid(String(root.id ?? ""), "Railway status project ID")
    !== input.selector.projectId) {
    throw new Error("Railway status returned the wrong project");
  }
  const environmentEdges = array(
    record(root.environments, "Railway status environments").edges,
    "Railway status environment edges",
  );
  const matchingEnvironments = environmentEdges
    .map((edge) => record(record(edge, "Railway environment edge").node,
      "Railway environment"))
    .filter((environment) => (
      typeof environment.id === "string"
      && environment.id.toLowerCase() === input.selector.environmentId
    ));
  if (matchingEnvironments.length !== 1) {
    throw new Error("Railway status did not return exactly one selected environment");
  }
  const environment = matchingEnvironments[0]!;
  if (
    environment.canAccess !== true
    || environment.deletedAt !== null
  ) {
    throw new Error("Railway selected environment is inaccessible or deleted");
  }
  const serviceEdges = array(
    record(
      environment.serviceInstances,
      "Railway status service instances",
    ).edges,
    "Railway status service instance edges",
  );
  const services: RailwayStatusService[] = serviceEdges.map((edge, index) => {
    const service = record(
      record(edge, `Railway service edge ${index}`).node,
      `Railway service ${index}`,
    );
    const serviceId = uuid(
      String(service.serviceId ?? ""),
      `Railway service ${index} ID`,
    );
    if (service.environmentId !== input.selector.environmentId) {
      throw new Error("Railway service belongs to the wrong environment");
    }
    const deployment = record(
      service.latestDeployment,
      `Railway service ${index} latest deployment`,
    );
    if (deployment.status !== "SUCCESS") {
      throw new Error("Railway service latest deployment is not successful");
    }
    const instances = array(
      deployment.instances,
      `Railway service ${index} deployment instances`,
    );
    if (!instances.some((item) => (
      record(item, `Railway service ${index} instance`).status === "RUNNING"
    ))) {
      throw new Error("Railway service has no running deployment instance");
    }
    const meta = record(
      deployment.meta,
      `Railway service ${index} deployment metadata`,
    );
    const imageDigest = typeof meta.imageDigest === "string"
      ? meta.imageDigest.toLowerCase()
      : "";
    if (!IMAGE_DIGEST.test(imageDigest)) {
      throw new Error("Railway service deployment has no immutable image digest");
    }
    const sourceRevision = typeof meta.commitHash === "string"
      && SOURCE_REVISION.test(meta.commitHash.toLowerCase())
      ? meta.commitHash.toLowerCase()
      : null;
    const imageReference = typeof meta.image === "string"
      ? meta.image.toLowerCase()
      : null;
    if (
      input.expectedCandidate !== null
      && input.selector.candidateServiceIds.includes(serviceId)
      && !(
        (
          sourceRevision === input.expectedCandidate.sourceRevision
          && imageDigest === input.expectedCandidate.imageDigest
        )
        || (
          sourceRevision === null
          && imageReference === input.expectedCandidate.imageReference
          && imageDigest === input.expectedCandidate.imageDigest
        )
      )
    ) {
      throw new Error(
        "Railway candidate service deployment artifact does not match the target",
      );
    }
    if (
      input.forbiddenCandidate !== null
      && input.selector.candidateServiceIds.includes(serviceId)
      && (
        sourceRevision === input.forbiddenCandidate.sourceRevision
        || imageDigest === input.forbiddenCandidate.imageDigest
        || imageReference === input.forbiddenCandidate.imageReference
      )
    ) {
      throw new Error(
        "candidate-phase evidence cannot be produced after the candidate reaches production",
      );
    }
    return {
      serviceId,
      deploymentStatus: "SUCCESS" as const,
      instanceStatus: "RUNNING" as const,
      sourceRevision,
      imageDigest,
      imageReference,
    };
  }).sort((left, right) => left.serviceId.localeCompare(right.serviceId));
  if (
    new Set(services.map((service) => service.serviceId)).size !== services.length
    || services.length !== input.selector.requiredServiceIds.length
    || services.some((
      service,
      index,
    ) => service.serviceId !== input.selector.requiredServiceIds[index])
  ) {
    throw new Error("Railway service inventory does not match the protected allowlist");
  }
  const serviceInventory = services.map((service) => ({
    serviceIdHash: opaqueIdentifierHash("service-id", service.serviceId),
    deploymentStatus: service.deploymentStatus,
    instanceStatus: service.instanceStatus,
    sourceRevision: service.sourceRevision,
    imageDigest: service.imageDigest,
    imageReference: service.imageReference,
  }));
  return {
    railwayProjectIdHash:
      opaqueIdentifierHash("project-id", input.selector.projectId),
    railwayEnvironmentIdHash:
      opaqueIdentifierHash("environment-id", input.selector.environmentId),
    railwayServiceInventoryHash: signedArtifactSha256(serviceInventory),
  };
}

export const railwayCliControlPlaneQueryAdapter:
RailwayControlPlaneQueryAdapter = {
  async queryStatus(selector) {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("railway", [
        "status",
        "--project",
        selector.projectId,
        "--environment",
        selector.environmentId,
        "--json",
      ], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 12 * 1024 * 1024,
      }));
    } catch {
      throw new Error("Railway control-plane metadata query failed");
    }
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error("Railway control-plane metadata query returned invalid JSON");
    }
  },
  async querySecretVersionsHash(input) {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("railway", [
        "variable",
        "list",
        "--service",
        input.serviceId,
        "--project",
        input.projectId,
        "--environment",
        input.environmentId,
        "--json",
      ], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 12 * 1024 * 1024,
      }));
    } catch {
      throw new Error("Railway secret-version identity query failed");
    }
    try {
      const variables = record(
        JSON.parse(stdout),
        "Railway variable response",
      );
      return digest(
        String(variables.RELEASE_SECRET_VERSIONS_HASH ?? "").toLowerCase(),
        "deployed RELEASE_SECRET_VERSIONS_HASH",
      );
    } catch {
      throw new Error(
        "Railway did not expose a valid deployed secret-version identity",
      );
    } finally {
      stdout = "";
    }
  },
};

export async function collectDeployedSecretVersionsBinding(input: {
  railway: RailwayControlPlaneQueryAdapter;
  selector: RailwayEnvironmentSelectorV1;
  expectedSecretVersionsHash: string | null;
}): Promise<{
  secretVersionsHash: string;
  serviceBindingsHash: string;
}> {
  const bindings = await Promise.all(
    input.selector.candidateServiceIds.map(async (serviceId) => ({
      serviceIdHash: opaqueIdentifierHash("service-id", serviceId),
      secretVersionsHash: digest(
        (
          await input.railway.querySecretVersionsHash({
            projectId: input.selector.projectId,
            environmentId: input.selector.environmentId,
            serviceId,
          })
        ).toLowerCase(),
        "deployed RELEASE_SECRET_VERSIONS_HASH",
      ),
    })),
  );
  const uniqueHashes = new Set(
    bindings.map((binding) => binding.secretVersionsHash),
  );
  if (
    uniqueHashes.size !== 1
    || (
      input.expectedSecretVersionsHash !== null
      && !uniqueHashes.has(input.expectedSecretVersionsHash)
    )
  ) {
    throw new Error(
      "Railway candidate services do not share the exact runtime snapshot secret-version identity",
    );
  }
  return {
    secretVersionsHash: bindings[0]!.secretVersionsHash,
    serviceBindingsHash: signedArtifactSha256(bindings),
  };
}

async function jsonFile(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} must identify readable JSON`);
  }
}

async function publicKeyFile(path: string, label: string): Promise<KeyObject> {
  try {
    const key = createPublicKey(await readFile(path));
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key");
    return key;
  } catch {
    throw new Error(`${label} must identify a readable Ed25519 public key`);
  }
}

async function privateKeyFile(path: string, label: string): Promise<KeyObject> {
  try {
    const key = createPrivateKey(await readFile(path));
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key");
    return key;
  } catch {
    throw new Error(`${label} must identify a readable Ed25519 private key`);
  }
}

function assertFreshRuntimeSnapshot(
  snapshot: LoadedRuntimeSnapshotV1,
  now: number,
  expectedOrigin: string,
): void {
  const generatedAt = Date.parse(snapshot.generatedAt);
  if (
    snapshot.origin !== expectedOrigin
    || generatedAt > now + 5 * 60_000
    || now - generatedAt > RELEASE_EVIDENCE_TTL_MS
  ) {
    throw new Error(
      `${snapshot.environment} runtime snapshot is stale or has the wrong protected origin`,
    );
  }
}

async function loadInputs(
  args: StagingControlPlaneEvidenceProducerArgs,
  now: number,
): Promise<LoadedInputs> {
  if (
    (args.phase === "candidate" && (
      args.productionRuntimeSnapshotPath !== null
      || args.candidateEvidencePath !== null
      || args.candidateEvidenceVerificationKeyPath !== null
      || args.candidateEvidenceKeySha256 !== null
    ))
    || (args.phase !== "candidate" && (
      args.productionRuntimeSnapshotPath === null
      || args.candidateEvidencePath === null
      || args.candidateEvidenceVerificationKeyPath === null
      || args.candidateEvidenceKeySha256 === null
    ))
  ) {
    throw new Error("control-plane producer phase inputs are inconsistent");
  }
  const paths = [
    args.stagingRuntimeSnapshotPath,
    args.productionRuntimeSnapshotPath,
    args.candidateEvidencePath,
    args.candidateEvidenceVerificationKeyPath,
    args.appleReceiptPath,
    args.appleReceiptVerificationKeyPath,
    args.providerReceiptPath,
    args.providerReceiptVerificationKeyPath,
    args.budgetReceiptPath,
    args.budgetReceiptVerificationKeyPath,
    args.producerSigningKeyPath,
    args.outputPath,
    args.verificationKeyOutputPath,
  ].filter((path): path is string => path !== null).map((path) => resolve(path));
  if (new Set(paths).size !== paths.length) {
    throw new Error("control-plane input, key, and output paths must be distinct");
  }
  for (const outputPath of [
    args.outputPath,
    args.verificationKeyOutputPath,
  ]) {
    try {
      await access(outputPath);
      throw new Error("control-plane evidence output already exists");
    } catch (error) {
      if (
        !(error instanceof Error)
        || !("code" in error)
        || error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
  const [
    stagingSnapshotValue,
    productionSnapshotValue,
    candidateEvidence,
    candidateEvidenceVerificationKey,
    appleReceipt,
    appleReceiptVerificationKey,
    providerReceipt,
    providerReceiptVerificationKey,
    budgetReceipt,
    budgetReceiptVerificationKey,
    producerSigningKey,
  ] = await Promise.all([
    jsonFile(args.stagingRuntimeSnapshotPath, "--staging-runtime-snapshot"),
    args.productionRuntimeSnapshotPath === null
      ? Promise.resolve(null)
      : jsonFile(
        args.productionRuntimeSnapshotPath,
        "--production-runtime-snapshot",
      ),
    args.candidateEvidencePath === null
      ? Promise.resolve(null)
      : jsonFile(args.candidateEvidencePath, "--candidate-evidence"),
    args.candidateEvidenceVerificationKeyPath === null
      ? Promise.resolve(null)
      : publicKeyFile(
        args.candidateEvidenceVerificationKeyPath,
        "--candidate-evidence-verification-key",
      ),
    jsonFile(args.appleReceiptPath, "--apple-receipt"),
    publicKeyFile(
      args.appleReceiptVerificationKeyPath,
      "--apple-receipt-verification-key",
    ),
    jsonFile(args.providerReceiptPath, "--provider-receipt"),
    publicKeyFile(
      args.providerReceiptVerificationKeyPath,
      "--provider-receipt-verification-key",
    ),
    jsonFile(args.budgetReceiptPath, "--budget-receipt"),
    publicKeyFile(
      args.budgetReceiptVerificationKeyPath,
      "--budget-receipt-verification-key",
    ),
    privateKeyFile(args.producerSigningKeyPath, "--producer-signing-key"),
  ]);
  const producerVerificationKey = createPublicKey(producerSigningKey);
  const producerFingerprint =
    stagingControlPlaneKeyFingerprint(producerVerificationKey);
  if (producerFingerprint !== args.producerKeySha256) {
    throw new Error(
      "staging control-plane producer does not use the protected approved key",
    );
  }
  if (
    candidateEvidenceVerificationKey !== null
    && stagingControlPlaneKeyFingerprint(candidateEvidenceVerificationKey)
      !== args.candidateEvidenceKeySha256
  ) {
    throw new Error("candidate release evidence does not use its protected key");
  }
  const fingerprints = [
    producerFingerprint,
    stagingControlPlaneKeyFingerprint(appleReceiptVerificationKey),
    stagingControlPlaneKeyFingerprint(providerReceiptVerificationKey),
    stagingControlPlaneKeyFingerprint(budgetReceiptVerificationKey),
    ...(candidateEvidenceVerificationKey === null
      ? []
      : [stagingControlPlaneKeyFingerprint(candidateEvidenceVerificationKey)]),
  ];
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new Error(
      "aggregate, candidate, Apple, provider, and budget evidence require independent signing keys",
    );
  }
  const stagingSnapshot = validateRuntimeSnapshot(
    stagingSnapshotValue,
    "staging",
    "full",
  );
  const productionSnapshot = productionSnapshotValue === null
    ? null
    : validateRuntimeSnapshot(
      productionSnapshotValue,
      "production",
      args.phase === "finalization" ? "full" : "backend",
    );
  assertFreshRuntimeSnapshot(stagingSnapshot, now, args.stagingOrigin);
  if (productionSnapshot) {
    assertFreshRuntimeSnapshot(productionSnapshot, now, args.productionOrigin);
  }
  if (
    !SOURCE_REVISION.test(stagingSnapshot.candidate.sourceRevision)
    || (productionSnapshot !== null && (
      stagingSnapshot.candidate.version !== productionSnapshot.candidate.version
      || stagingSnapshot.candidate.sourceRevision
        !== productionSnapshot.candidate.sourceRevision
      || stagingSnapshot.snapshotHash === productionSnapshot.snapshotHash
      || stagingSnapshot.configuration.secretVersionsHash
        === productionSnapshot.configuration.secretVersionsHash
      || stagingSnapshot.credentialVersionHashes.provider
        === productionSnapshot.credentialVersionHashes.provider
      || stagingSnapshot.credentialVersionHashes.apple
        === productionSnapshot.credentialVersionHashes.apple
      || stagingSnapshot.credentialVersionHashes.appleQaVerifier
        === productionSnapshot.credentialVersionHashes.appleQaVerifier
    ))
  ) {
    throw new Error(
      "runtime snapshots do not prove a separated exact candidate deployment",
    );
  }
  return {
    stagingSnapshot,
    productionSnapshot,
    candidateEvidence,
    candidateEvidenceVerificationKey,
    appleReceipt,
    appleReceiptVerificationKey,
    providerReceipt,
    providerReceiptVerificationKey,
    budgetReceipt,
    budgetReceiptVerificationKey,
    producerSigningKey,
    producerVerificationKey,
  };
}

function receiptExpiry(receipt: unknown): number {
  const envelope = record(receipt, "signed control-plane receipt");
  const payload = record(envelope.payload, "signed control-plane receipt payload");
  const value = payload.expiresAt;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("signed control-plane receipt expiresAt is invalid");
  }
  return Date.parse(value);
}

export const signedCandidateReleaseEvidenceVerifier:
CandidateReleaseEvidenceVerifier = {
  verify(input) {
    const payload = verifyReleaseEvidence(
      input.value,
      input.verificationKey,
      {
        expectedKind: "candidate",
        expectedRevision: input.candidate.sourceRevision,
        expectedImageDigest: input.candidate.imageDigest,
        now: input.now,
      },
    );
    if (
      payload.candidate.version !== input.candidate.version
      || payload.environmentSnapshots.staging.snapshotHash
        !== input.stagingRuntimeSnapshotHash
    ) {
      throw new Error(
        "candidate release evidence does not bind the target candidate",
      );
    }
    const envelope = record(input.value, "signed candidate release evidence");
    return {
      payloadHash: digest(
        String(envelope.payloadHash ?? ""),
        "candidate release-evidence payload hash",
      ),
      expiresAt: String(payload.expiresAt),
    };
  },
};

export async function produceStagingControlPlaneEvidence(input: {
  args: StagingControlPlaneEvidenceProducerArgs;
  railway: RailwayControlPlaneQueryAdapter;
  candidateEvidenceVerifier?: CandidateReleaseEvidenceVerifier;
  now?: string;
}): Promise<{
  envelope: ReturnType<typeof createStrictSignedEnvelope>;
  verificationKey: string;
}> {
  const generatedAt = input.now ?? new Date().toISOString();
  if (new Date(generatedAt).toISOString() !== generatedAt) {
    throw new Error("control-plane evidence time must be an ISO timestamp");
  }
  const now = Date.parse(generatedAt);
  const loaded = await loadInputs(input.args, now);
  const [
    stagingRailwayValue,
    productionRailwayValue,
  ] = await Promise.all([
    input.railway.queryStatus(input.args.stagingRailway),
    input.railway.queryStatus(input.args.productionRailway),
  ]);
  const stagingRailwayDeployment = validateRailwayStatusMetadata({
    value: stagingRailwayValue,
    selector: input.args.stagingRailway,
    expectedCandidate: {
      sourceRevision: loaded.stagingSnapshot.candidate.sourceRevision,
      imageDigest: input.args.candidateImageDigest,
      imageReference: input.args.candidateImageReference,
    },
    forbiddenCandidate: null,
  });
  const productionRailwayDeployment = validateRailwayStatusMetadata({
    value: productionRailwayValue,
    selector: input.args.productionRailway,
    expectedCandidate: input.args.phase !== "candidate"
      ? {
        sourceRevision: loaded.stagingSnapshot.candidate.sourceRevision,
        imageDigest: input.args.candidateImageDigest,
        imageReference: input.args.candidateImageReference,
      }
      : null,
    forbiddenCandidate: input.args.phase === "candidate"
      ? {
        sourceRevision: loaded.stagingSnapshot.candidate.sourceRevision,
        imageDigest: input.args.candidateImageDigest,
        imageReference: input.args.candidateImageReference,
      }
      : null,
  });
  const [stagingSecretVersions, productionSecretVersions] = await Promise.all([
    collectDeployedSecretVersionsBinding({
      railway: input.railway,
      selector: input.args.stagingRailway,
      expectedSecretVersionsHash:
        loaded.stagingSnapshot.configuration.secretVersionsHash,
    }),
    collectDeployedSecretVersionsBinding({
      railway: input.railway,
      selector: input.args.productionRailway,
      expectedSecretVersionsHash:
        loaded.productionSnapshot?.configuration.secretVersionsHash ?? null,
    }),
  ]);
  const stagingRailway = {
    ...stagingRailwayDeployment,
    railwayServiceInventoryHash: signedArtifactSha256({
      deploymentInventoryHash:
        stagingRailwayDeployment.railwayServiceInventoryHash,
      secretVersionBindingsHash:
        stagingSecretVersions.serviceBindingsHash,
    }),
  };
  const productionRailway = {
    ...productionRailwayDeployment,
    railwayServiceInventoryHash: signedArtifactSha256({
      deploymentInventoryHash:
        productionRailwayDeployment.railwayServiceInventoryHash,
      secretVersionBindingsHash:
        productionSecretVersions.serviceBindingsHash,
    }),
  };
  for (const field of [
    "railwayProjectIdHash",
    "railwayEnvironmentIdHash",
    "railwayServiceInventoryHash",
  ] as const) {
    if (stagingRailway[field] === productionRailway[field]) {
      throw new Error(`Railway ${field} must be separate by environment`);
    }
  }
  const candidate = {
    ...loaded.stagingSnapshot.candidate,
    imageDigest: input.args.candidateImageDigest,
    imageReference: input.args.candidateImageReference,
  };
  const productionSnapshot = loaded.productionSnapshot;
  const productionSnapshotHash = productionSnapshot?.snapshotHash ?? null;
  // Runtime snapshots are not trusted merely because their self-hash is valid.
  // Their exact hash and candidate identity must be co-attested by the three
  // independently pinned Apple, provider, and QA-ledger receipt authorities.
  const apple = verifyAppleControlPlaneReceipt({
    value: loaded.appleReceipt,
    verificationKey: loaded.appleReceiptVerificationKey,
    trustPolicy: input.args.appleReceiptTrust,
    expected: {
      phase: input.args.phase,
      candidate,
      staging: {
        runtimeSnapshotHash: loaded.stagingSnapshot.snapshotHash,
        appleCredentialVersionHash:
          loaded.stagingSnapshot.credentialVersionHashes.apple,
        appleQaVerifierCredentialVersionHash:
          loaded.stagingSnapshot.credentialVersionHashes.appleQaVerifier,
        musicKitOrigin: input.args.stagingOrigin,
      },
      production: {
        runtimeSnapshotHash: productionSnapshotHash,
        ...(productionSnapshot === null
          ? {}
          : {
            appleCredentialVersionHash:
              productionSnapshot.credentialVersionHashes.apple,
            appleQaVerifierCredentialVersionHash:
              productionSnapshot.credentialVersionHashes.appleQaVerifier,
          }),
      },
    },
    now: generatedAt,
  });
  const provider = verifyProviderControlPlaneReceipt({
    value: loaded.providerReceipt,
    verificationKey: loaded.providerReceiptVerificationKey,
    trustPolicy: input.args.providerReceiptTrust,
    expected: {
      phase: input.args.phase,
      candidate,
      staging: {
        runtimeSnapshotHash: loaded.stagingSnapshot.snapshotHash,
        providerCredentialVersionHash:
          loaded.stagingSnapshot.credentialVersionHashes.provider,
      },
      production: {
        runtimeSnapshotHash: productionSnapshotHash,
        ...(productionSnapshot === null
          ? {}
          : {
            providerCredentialVersionHash:
              productionSnapshot.credentialVersionHashes.provider,
          }),
      },
    },
    now: generatedAt,
  });
  const budget = verifyQaBudgetLedgerReceipt({
    value: loaded.budgetReceipt,
    verificationKey: loaded.budgetReceiptVerificationKey,
    trustPolicy: input.args.budgetReceiptTrust,
    expected: {
      phase: input.args.phase,
      candidate,
      stagingRuntimeSnapshotHash: loaded.stagingSnapshot.snapshotHash,
      productionRuntimeSnapshotHash: productionSnapshotHash,
    },
    now: generatedAt,
  });
  let candidateEvidence: {
    payloadHash: string;
    expiresAt: string;
  } | null = null;
  if (input.args.phase !== "candidate") {
    if (
      loaded.candidateEvidence === null
      || loaded.candidateEvidenceVerificationKey === null
    ) {
      throw new Error(
        `${input.args.phase} control-plane evidence lacks candidate evidence`,
      );
    }
    candidateEvidence = (
      input.candidateEvidenceVerifier ?? signedCandidateReleaseEvidenceVerifier
    ).verify({
      value: loaded.candidateEvidence,
      verificationKey: loaded.candidateEvidenceVerificationKey,
      candidate,
      stagingRuntimeSnapshotHash: loaded.stagingSnapshot.snapshotHash,
      now: generatedAt,
    });
  }
  const expiresMs = Math.min(
    now + RELEASE_EVIDENCE_TTL_MS,
    receiptExpiry(loaded.appleReceipt),
    receiptExpiry(loaded.providerReceipt),
    receiptExpiry(loaded.budgetReceipt),
    candidateEvidence === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(candidateEvidence.expiresAt),
  );
  if (expiresMs <= now) {
    throw new Error("control-plane receipt validity does not cover the aggregate");
  }
  const payload = {
    schemaVersion: STAGING_CONTROL_PLANE_EVIDENCE_SCHEMA_V1,
    phase: input.args.phase,
    candidate,
    candidateEvidencePayloadHash:
      candidateEvidence?.payloadHash ?? null,
    generatedAt,
    expiresAt: new Date(expiresMs).toISOString(),
    issuer: STAGING_CONTROL_PLANE_ISSUER_V1,
    staging: {
      ...stagingRailway,
      runtimeSnapshotHash: loaded.stagingSnapshot.snapshotHash,
      configurationHash: loaded.stagingSnapshot.configurationHash,
      secretVersionsHash:
        stagingSecretVersions.secretVersionsHash,
      providerCredentialVersionHash:
        provider.stagingProviderCredentialVersionHash,
      providerProjectIdentityHash:
        provider.stagingProviderProjectIdentityHash,
      appleCredentialVersionHash:
        loaded.stagingSnapshot.credentialVersionHashes.apple,
      appleQaVerifierCredentialVersionHash:
        loaded.stagingSnapshot.credentialVersionHashes.appleQaVerifier,
      appleQaVerifierCredentialIdentityHash:
        apple.stagingAppleQaVerifierCredentialIdentityHash,
      appleAccountIdHash: apple.stagingAppleAccountIdHash,
      musicKitOrigin: input.args.stagingOrigin,
      musicKitOriginRegistrationEvidenceHash:
        apple.musicKitOriginRegistrationEvidenceHash,
    },
    production: {
      ...productionRailway,
      runtimeSnapshotHash: productionSnapshotHash,
      configurationHash: productionSnapshot?.configurationHash ?? null,
      secretVersionsHash:
        productionSecretVersions.secretVersionsHash,
      providerCredentialVersionHash:
        provider.productionProviderCredentialVersionHash,
      providerProjectIdentityHash:
        provider.productionProviderProjectIdentityHash,
      appleCredentialVersionHash:
        String((apple.payload.production as JsonRecord)
          .appleCredentialVersionHash),
      appleQaVerifierCredentialVersionHash:
        String((apple.payload.production as JsonRecord)
          .appleQaVerifierCredentialVersionHash),
      appleQaVerifierCredentialIdentityHash:
        apple.productionAppleQaVerifierCredentialIdentityHash,
      appleAccountIdHash: apple.productionAppleAccountIdHash,
    },
    budget: {
      currency: "USD",
      monthlyCostLimitUsd: budget.monthlyCostLimitUsd,
      budgetRemainingUsd: budget.budgetRemainingUsd,
      reservedForRequiredGatesUsd: budget.reservedForRequiredGatesUsd,
      status: "available",
    },
    receipts: {
      apple: {
        payloadHash: apple.payloadHash,
        issuer: input.args.appleReceiptTrust.approvedIssuer,
        keyId: apple.keyId,
        keySha256: apple.verificationKeyFingerprint,
      },
      provider: {
        payloadHash: provider.payloadHash,
        issuer: input.args.providerReceiptTrust.approvedIssuer,
        keyId: provider.keyId,
        keySha256: provider.verificationKeyFingerprint,
      },
      qaBudget: {
        payloadHash: budget.payloadHash,
        issuer: input.args.budgetReceiptTrust.approvedIssuer,
        keyId: budget.keyId,
        keySha256: budget.verificationKeyFingerprint,
      },
    },
  };
  const envelope = createStrictSignedEnvelope({
    envelopeSchemaVersion:
      SIGNED_STAGING_CONTROL_PLANE_EVIDENCE_SCHEMA_V1,
    payload,
    signingKey: loaded.producerSigningKey,
    keyId: input.args.producerKeyId,
  });
  verifyStagingControlPlaneEvidence({
    value: envelope,
    verificationKey: loaded.producerVerificationKey,
    trustPolicy: stagingControlPlaneTrustPolicyV1({
      approvedKeyId: input.args.producerKeyId,
      approvedKeySha256: input.args.producerKeySha256,
    }),
    now: generatedAt,
  });
  const verificationKey = loaded.producerVerificationKey.export({
    format: "pem",
    type: "spki",
  }).toString();
  await writeFile(
    input.args.verificationKeyOutputPath,
    verificationKey,
    { encoding: "utf8", flag: "wx", mode: 0o644 },
  );
  await writeFile(
    input.args.outputPath,
    `${JSON.stringify(envelope, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return { envelope, verificationKey };
}

async function main(): Promise<void> {
  const args = parseStagingControlPlaneEvidenceProducerArgs(
    process.argv.slice(2),
  );
  const result = await produceStagingControlPlaneEvidence({
    args,
    railway: railwayCliControlPlaneQueryAdapter,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    output: args.outputPath,
    verificationKeyOutput: args.verificationKeyOutputPath,
    evidenceHash: result.envelope.payloadHash,
    keyId: args.producerKeyId,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "staging_control_plane_evidence_failed",
      message: "Staging control-plane evidence production failed",
    })}\n`);
    process.exitCode = 1;
  });
}
