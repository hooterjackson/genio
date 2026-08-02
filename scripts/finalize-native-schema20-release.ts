import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  releaseGateProducerKeyFingerprint,
} from "./release-evidence.ts";
import {
  validateReleaseGateArtifact,
  verifyReleaseGateProducerAttestation,
  type ReleaseGateArtifactV1,
  type ReleaseGateName,
} from "./release-fixtures.ts";
import type {
  NativeSchema20PromotionReceiptV1,
} from "./promote-native-schema20-release.ts";

type JsonRecord = Record<string, unknown>;

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_REFERENCE =
  /^ghcr\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:-]{2,79}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EXISTING_SITES_PROJECT_ID =
  "appgprj_6a5565cf7d6c8191ab9f2084e8eda856";
const REQUIRED_GATES = Object.freeze([
  "release_convergence",
  "final_custom_domain_browser",
  "production_fixed_three_track",
  "production_affected_regression",
] as const satisfies readonly ReleaseGateName[]);

export interface NativeSchema20FinalizationArgs {
  candidateTag: string;
  sourceRevision: string;
  version: string;
  backendPromotionPath: string;
  directExposureAuthorityPath: string;
  directExposureRollbackWarrantPath: string;
  directExposureDatabaseActivateReceiptPath: string;
  directExposureRuntimeReceiptPath: string;
  directExposureVerificationKeyPath: string;
  directExposureKeyId: string;
  directExposureKeySha256: string;
  producerVerificationKeyPath: string;
  producerKeyId: string;
  producerKeySha256: string;
  gates: Readonly<Record<typeof REQUIRED_GATES[number], {
    artifactPath: string;
    attestationPath: string;
  }>>;
  burnInReceiptPath: string;
  outputPath: string;
}

export interface NativeSchema20FinalizationReceiptV1 {
  schemaVersion: "genio-native-schema20-finalization/v2";
  candidate: {
    tag: string;
    version: string;
    sourceRevision: string;
    imageDigest: string;
    sitesSourceRevision: string;
  };
  backendPromotionReceiptHash: string;
  semanticBehaviorManifestHash: string;
  semanticExecutionConfigurationHash: string;
  containmentReceiptHash: string;
  guidanceCheckpointMigrationReceiptHash: string;
  legacyExecutionRouteDrainInventoryReceiptHash: string;
  schema20EvidenceRecoveryReceiptHash: string;
  directExposure: {
    authorityPayloadHash: string;
    authorityArtifactHash: string;
    rollbackWarrantPayloadHash: string;
    rollbackWarrantArtifactHash: string;
    preconditionsHash: string;
    rollbackPlanHash: string;
    targetConfigurationHash: string;
    preExposureSemanticConfigurationHash: string;
    postExposureSemanticConfigurationHash: string;
    rollbackSemanticConfigurationHash: string;
    preExposureRuntimeTupleHash: string;
    postExposureRuntimeTupleHash: string;
    rollbackRuntimeTupleHash: string;
    databaseActivateReceiptHash: string;
    runtimeTransitionReceiptHash: string;
    ownerAppleGateEvidenceHash: string;
    preExposureCleanGateEvidenceHash: string;
    databaseRouteReceiptHash: string;
    exposureClass: "fully_exposed_unproven";
    organicReliabilityProven: false;
  };
  gateEvidenceHashes: Readonly<Record<
    typeof REQUIRED_GATES[number],
    string
  >>;
  burnInReceiptHash: string;
  burnInCompletedAt: string;
  sites: {
    projectId: string;
    versionId: string;
    deploymentId: string;
    archiveSha256: string;
    controlPlaneEvidenceHash: string;
  };
  completedAt: string;
  receiptHash: string;
}

export function nativeSchema20FinalizationReceiptHash(
  value: Omit<NativeSchema20FinalizationReceiptV1, "receiptHash">,
): string {
  return sha256(value);
}

export function validateNativeSchema20FinalizationReceiptV1(
  value: unknown,
  expected: {
    candidateTag: string;
    sourceRevision: string;
    version: string;
  },
): NativeSchema20FinalizationReceiptV1 {
  const receipt = record(value, "native schema-20 finalization receipt");
  exactKeys(receipt, [
    "schemaVersion",
    "candidate",
    "backendPromotionReceiptHash",
    "semanticBehaviorManifestHash",
    "semanticExecutionConfigurationHash",
    "containmentReceiptHash",
    "guidanceCheckpointMigrationReceiptHash",
    "legacyExecutionRouteDrainInventoryReceiptHash",
    "schema20EvidenceRecoveryReceiptHash",
    "directExposure",
    "gateEvidenceHashes",
    "burnInReceiptHash",
    "burnInCompletedAt",
    "sites",
    "completedAt",
    "receiptHash",
  ], "native schema-20 finalization receipt");
  if (receipt.schemaVersion !== "genio-native-schema20-finalization/v2") {
    throw new Error("native finalization receipt schema is invalid");
  }
  const candidate = record(
    receipt.candidate,
    "native finalization candidate",
  );
  exactKeys(candidate, [
    "tag",
    "version",
    "sourceRevision",
    "imageDigest",
    "sitesSourceRevision",
  ], "native finalization candidate");
  if (
    candidate.tag !== expected.candidateTag
    || candidate.version !== expected.version
    || candidate.sourceRevision !== expected.sourceRevision
    || candidate.sitesSourceRevision !== expected.sourceRevision
  ) {
    throw new Error("native finalization receipt does not bind the candidate");
  }
  string(candidate.version, "native finalization version", VERSION);
  string(candidate.sourceRevision, "native finalization source", SHA1);
  string(
    candidate.imageDigest,
    "native finalization image digest",
    IMAGE_DIGEST,
  );
  if (
    !new RegExp(
      `^v${expected.version.replaceAll(".", "\\.")}-rc\\.[1-9]\\d*$`,
      "u",
    ).test(String(candidate.tag))
  ) {
    throw new Error("native finalization candidate tag is invalid");
  }
  for (const field of [
    "backendPromotionReceiptHash",
    "semanticBehaviorManifestHash",
    "semanticExecutionConfigurationHash",
    "containmentReceiptHash",
    "guidanceCheckpointMigrationReceiptHash",
    "legacyExecutionRouteDrainInventoryReceiptHash",
    "schema20EvidenceRecoveryReceiptHash",
    "burnInReceiptHash",
  ] as const) {
    string(receipt[field], `native finalization ${field}`, SHA256);
  }
  const directExposure = record(
    receipt.directExposure,
    "native finalization direct exposure",
  );
  exactKeys(directExposure, [
    "authorityPayloadHash",
    "authorityArtifactHash",
    "rollbackWarrantPayloadHash",
    "rollbackWarrantArtifactHash",
    "preconditionsHash",
    "rollbackPlanHash",
    "targetConfigurationHash",
    "preExposureSemanticConfigurationHash",
    "postExposureSemanticConfigurationHash",
    "rollbackSemanticConfigurationHash",
    "preExposureRuntimeTupleHash",
    "postExposureRuntimeTupleHash",
    "rollbackRuntimeTupleHash",
    "databaseActivateReceiptHash",
    "runtimeTransitionReceiptHash",
    "ownerAppleGateEvidenceHash",
    "preExposureCleanGateEvidenceHash",
    "databaseRouteReceiptHash",
    "exposureClass",
    "organicReliabilityProven",
  ], "native finalization direct exposure");
  for (const field of [
    "authorityPayloadHash",
    "authorityArtifactHash",
    "rollbackWarrantPayloadHash",
    "rollbackWarrantArtifactHash",
    "preconditionsHash",
    "rollbackPlanHash",
    "targetConfigurationHash",
    "preExposureSemanticConfigurationHash",
    "postExposureSemanticConfigurationHash",
    "rollbackSemanticConfigurationHash",
    "preExposureRuntimeTupleHash",
    "postExposureRuntimeTupleHash",
    "rollbackRuntimeTupleHash",
    "databaseActivateReceiptHash",
    "runtimeTransitionReceiptHash",
    "ownerAppleGateEvidenceHash",
    "preExposureCleanGateEvidenceHash",
    "databaseRouteReceiptHash",
  ] as const) {
    string(
      directExposure[field],
      `native finalization direct exposure ${field}`,
      SHA256,
    );
  }
  if (
    directExposure.exposureClass !== "fully_exposed_unproven"
    || directExposure.organicReliabilityProven !== false
    || directExposure.preExposureSemanticConfigurationHash
      !== directExposure.rollbackSemanticConfigurationHash
    || directExposure.preExposureSemanticConfigurationHash
      === directExposure.postExposureSemanticConfigurationHash
    || directExposure.postExposureSemanticConfigurationHash
      !== receipt.semanticExecutionConfigurationHash
  ) {
    throw new Error("native finalization direct exposure lineage is invalid");
  }
  const gateEvidenceHashes = record(
    receipt.gateEvidenceHashes,
    "native finalization gate evidence",
  );
  exactKeys(
    gateEvidenceHashes,
    [...REQUIRED_GATES],
    "native finalization gate evidence",
  );
  for (const gate of REQUIRED_GATES) {
    string(
      gateEvidenceHashes[gate],
      `native finalization ${gate} evidence hash`,
      SHA256,
    );
  }
  const sites = record(receipt.sites, "native finalization Sites receipt");
  exactKeys(sites, [
    "projectId",
    "versionId",
    "deploymentId",
    "archiveSha256",
    "controlPlaneEvidenceHash",
  ], "native finalization Sites receipt");
  if (sites.projectId !== EXISTING_SITES_PROJECT_ID) {
    throw new Error("native finalization receipt uses the wrong Sites project");
  }
  for (const field of ["versionId", "deploymentId"] as const) {
    if (
      typeof sites[field] !== "string"
      || !/^[0-9A-Za-z][0-9A-Za-z._:-]{2,255}$/u.test(sites[field])
    ) {
      throw new Error(`native finalization Sites ${field} is invalid`);
    }
  }
  string(sites.archiveSha256, "native finalization Sites archive", SHA256);
  string(
    sites.controlPlaneEvidenceHash,
    "native finalization Sites evidence",
    SHA256,
  );
  const burnInCompletedAt = timestamp(
    receipt.burnInCompletedAt,
    "native finalization burn-in completion",
  );
  const completedAt = timestamp(
    receipt.completedAt,
    "native finalization completion",
  );
  if (Date.parse(completedAt) < Date.parse(burnInCompletedAt)) {
    throw new Error("native finalization predates completed burn-in");
  }
  const unsigned = { ...receipt };
  delete unsigned.receiptHash;
  if (
    string(
      receipt.receiptHash,
      "native finalization receipt hash",
      SHA256,
    ) !== sha256(unsigned)
  ) {
    throw new Error("native finalization receipt hash is invalid");
  }
  return receipt as unknown as NativeSchema20FinalizationReceiptV1;
}

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
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
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

export function parseNativeSchema20FinalizationArgs(
  argv: readonly string[],
): NativeSchema20FinalizationArgs {
  const names = [
    "--candidate-tag",
    "--source-revision",
    "--version",
    "--backend-promotion",
    "--direct-exposure-authority",
    "--direct-exposure-rollback-warrant",
    "--direct-exposure-database-activate-receipt",
    "--direct-exposure-runtime-receipt",
    "--direct-exposure-verification-key",
    "--direct-exposure-key-id",
    "--direct-exposure-key-sha256",
    "--producer-verification-key",
    "--producer-key-id",
    "--producer-key-sha256",
    "--release-convergence-artifact",
    "--release-convergence-attestation",
    "--final-browser-artifact",
    "--final-browser-attestation",
    "--fixed-three-artifact",
    "--fixed-three-attestation",
    "--apple-artifact",
    "--apple-attestation",
    "--burn-in-receipt",
    "--output",
  ] as const;
  const allowed = new Set(names);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index] ?? "";
    const value = argv[index + 1] ?? "";
    if (
      !allowed.has(name as typeof names[number])
      || !value
      || value.startsWith("--")
      || values.has(name)
    ) {
      throw new Error(`Invalid native finalization argument: ${name || "(missing)"}`);
    }
    values.set(name, value);
  }
  if (values.size !== names.length) {
    throw new Error("native finalization requires every evidence argument");
  }
  const version = string(option(values, "--version"), "--version", VERSION);
  const candidateTag = string(
    option(values, "--candidate-tag"),
    "--candidate-tag",
    new RegExp(`^v${version.replaceAll(".", "\\.")}-rc\\.[1-9]\\d*$`, "u"),
  );
  return {
    candidateTag,
    sourceRevision: string(
      option(values, "--source-revision").toLowerCase(),
      "--source-revision",
      SHA1,
    ),
    version,
    backendPromotionPath: option(values, "--backend-promotion"),
    directExposureAuthorityPath:
      option(values, "--direct-exposure-authority"),
    directExposureRollbackWarrantPath:
      option(values, "--direct-exposure-rollback-warrant"),
    directExposureDatabaseActivateReceiptPath:
      option(values, "--direct-exposure-database-activate-receipt"),
    directExposureRuntimeReceiptPath:
      option(values, "--direct-exposure-runtime-receipt"),
    directExposureVerificationKeyPath:
      option(values, "--direct-exposure-verification-key"),
    directExposureKeyId: string(
      option(values, "--direct-exposure-key-id"),
      "--direct-exposure-key-id",
      KEY_ID,
    ),
    directExposureKeySha256: string(
      option(values, "--direct-exposure-key-sha256").toLowerCase(),
      "--direct-exposure-key-sha256",
      SHA256,
    ),
    producerVerificationKeyPath:
      option(values, "--producer-verification-key"),
    producerKeyId: string(
      option(values, "--producer-key-id"),
      "--producer-key-id",
      KEY_ID,
    ),
    producerKeySha256: string(
      option(values, "--producer-key-sha256").toLowerCase(),
      "--producer-key-sha256",
      SHA256,
    ),
    gates: {
      release_convergence: {
        artifactPath: option(values, "--release-convergence-artifact"),
        attestationPath:
          option(values, "--release-convergence-attestation"),
      },
      final_custom_domain_browser: {
        artifactPath: option(values, "--final-browser-artifact"),
        attestationPath: option(values, "--final-browser-attestation"),
      },
      production_fixed_three_track: {
        artifactPath: option(values, "--fixed-three-artifact"),
        attestationPath: option(values, "--fixed-three-attestation"),
      },
      production_affected_regression: {
        artifactPath: option(values, "--apple-artifact"),
        attestationPath: option(values, "--apple-attestation"),
      },
    },
    burnInReceiptPath: option(values, "--burn-in-receipt"),
    outputPath: option(values, "--output"),
  };
}

export function validateNativeSchema20PromotionReceipt(
  value: unknown,
  expected: { sourceRevision: string; version: string },
): NativeSchema20PromotionReceiptV1 {
  const receipt = record(value, "native schema-20 promotion receipt");
  exactKeys(receipt, [
    "schemaVersion",
    "sourceRevision",
    "version",
    "imageReference",
    "imageDigest",
    "candidateEvidenceHash",
    "exactShaImageReceiptHash",
    "semanticBehaviorManifestHash",
    "semanticExecutionConfigurationHash",
    "containmentReceiptHash",
    "guidanceCheckpointMigrationReceiptHash",
    "legacyExecutionRouteDrainInventoryReceiptHash",
    "schema20EvidenceRecoveryReceiptHash",
    "projectId",
    "environment",
    "services",
    "rollbackServices",
    "promotedRuntimeConfigurationHashes",
    "backendConvergenceEvidenceHash",
    "completedAt",
    "receiptHash",
  ], "native schema-20 promotion receipt");
  if (
    receipt.schemaVersion !== "genio-native-schema20-promotion/v1"
    || receipt.sourceRevision !== expected.sourceRevision
    || receipt.version !== expected.version
    || receipt.environment !== "production"
  ) {
    throw new Error("native promotion receipt does not bind the candidate");
  }
  string(receipt.sourceRevision, "promotion source revision", SHA1);
  string(receipt.version, "promotion version", VERSION);
  const imageDigest = string(
    receipt.imageDigest,
    "promotion image digest",
    IMAGE_DIGEST,
  );
  const imageReference = string(
    receipt.imageReference,
    "promotion image reference",
    IMAGE_REFERENCE,
  );
  if (!imageReference.endsWith(`@${imageDigest}`)) {
    throw new Error("promotion image reference and digest do not match");
  }
  string(receipt.candidateEvidenceHash, "candidate evidence hash", SHA256);
  string(receipt.exactShaImageReceiptHash, "exact-SHA receipt hash", SHA256);
  string(receipt.semanticBehaviorManifestHash, "behavior manifest hash", SHA256);
  string(
    receipt.semanticExecutionConfigurationHash,
    "semantic execution configuration hash",
    SHA256,
  );
  string(
    receipt.containmentReceiptHash,
    "v2.5.4 containment receipt hash",
    SHA256,
  );
  string(
    receipt.guidanceCheckpointMigrationReceiptHash,
    "v2.5.4 guidance checkpoint migration receipt hash",
    SHA256,
  );
  string(
    receipt.legacyExecutionRouteDrainInventoryReceiptHash,
    "legacy execution route drain inventory receipt hash",
    SHA256,
  );
  string(
    receipt.schema20EvidenceRecoveryReceiptHash,
    "schema-20 evidence recovery receipt hash",
    SHA256,
  );
  string(
    receipt.backendConvergenceEvidenceHash,
    "backend convergence evidence hash",
    SHA256,
  );
  string(receipt.projectId, "promotion Railway project ID", UUID);
  const services = record(receipt.services, "promotion Railway services");
  exactKeys(services, ["interactive", "deep", "api"], "promotion Railway services");
  for (const lane of ["interactive", "deep", "api"] as const) {
    const service = record(services[lane], `promotion ${lane} service`);
    exactKeys(
      service,
      ["serviceId", "deploymentId"],
      `promotion ${lane} service`,
    );
    string(service.serviceId, `promotion ${lane} service ID`, UUID);
    string(service.deploymentId, `promotion ${lane} deployment ID`, UUID);
  }
  const rollbackServices = record(
    receipt.rollbackServices,
    "promotion Railway rollback services",
  );
  exactKeys(
    rollbackServices,
    ["interactive", "deep", "api"],
    "promotion Railway rollback services",
  );
  for (const lane of ["interactive", "deep", "api"] as const) {
    const service = record(
      rollbackServices[lane],
      `promotion rollback ${lane} service`,
    );
    exactKeys(
      service,
      ["serviceId", "deploymentId", "imageReference", "imageDigest"],
      `promotion rollback ${lane} service`,
    );
    const current = record(services[lane], `promotion ${lane} service`);
    const serviceId = string(
      service.serviceId,
      `promotion rollback ${lane} service ID`,
      UUID,
    );
    if (serviceId !== current.serviceId) {
      throw new Error(
        `promotion rollback ${lane} service does not match the promoted lane`,
      );
    }
    const deploymentId = string(
      service.deploymentId,
      `promotion rollback ${lane} deployment ID`,
      UUID,
    );
    if (deploymentId === current.deploymentId) {
      throw new Error(
        `promotion rollback ${lane} deployment is not a prior deployment`,
      );
    }
    const rollbackImageDigest = string(
      service.imageDigest,
      `promotion rollback ${lane} image digest`,
      IMAGE_DIGEST,
    );
    if (!string(
      service.imageReference,
      `promotion rollback ${lane} image reference`,
      IMAGE_REFERENCE,
    ).endsWith(`@${rollbackImageDigest}`)) {
      throw new Error(
        `promotion rollback ${lane} image reference and digest do not match`,
      );
    }
  }
  const runtimeHashes = record(
    receipt.promotedRuntimeConfigurationHashes,
    "promoted runtime configuration hashes",
  );
  exactKeys(
    runtimeHashes,
    ["api", "interactive", "deep", "semantic"],
    "promoted runtime configuration hashes",
  );
  for (const lane of ["api", "interactive", "deep", "semantic"] as const) {
    string(
      runtimeHashes[lane],
      `promoted runtime configuration hash ${lane}`,
      SHA256,
    );
  }
  if (runtimeHashes.semantic !== receipt.semanticExecutionConfigurationHash) {
    throw new Error(
      "promoted semantic runtime hash does not match the promotion manifest",
    );
  }
  timestamp(receipt.completedAt, "promotion completion time");
  const unsigned = { ...receipt };
  delete unsigned.receiptHash;
  if (
    string(receipt.receiptHash, "promotion receipt hash", SHA256)
      !== sha256(unsigned)
  ) {
    throw new Error("native promotion receipt hash is invalid");
  }
  return receipt as unknown as NativeSchema20PromotionReceiptV1;
}

function assertGateCandidate(
  artifact: ReleaseGateArtifactV1,
  expected: {
    tag: string;
    version: string;
    sourceRevision: string;
    imageDigest: string;
  },
): void {
  if (
    artifact.candidate.tag !== expected.tag
    || artifact.candidate.version !== expected.version
    || artifact.candidate.sourceRevision !== expected.sourceRevision
    || artifact.candidate.sitesSourceRevision !== expected.sourceRevision
    || artifact.candidate.imageDigest !== expected.imageDigest
  ) {
    throw new Error(`${artifact.gate} does not bind the exact candidate`);
  }
}

export async function finalizeNativeSchema20Release(
  args: NativeSchema20FinalizationArgs,
): Promise<NativeSchema20FinalizationReceiptV1> {
  const [promotionValue, producerKey] = await Promise.all([
    readFile(args.backendPromotionPath, "utf8").then(JSON.parse),
    readFile(args.producerVerificationKeyPath),
  ]);
  if (
    releaseGateProducerKeyFingerprint(producerKey)
      !== args.producerKeySha256
  ) {
    throw new Error("release gate producer key is not the protected key");
  }
  const promotion = validateNativeSchema20PromotionReceipt(promotionValue, {
    sourceRevision: args.sourceRevision,
    version: args.version,
  });
  const loaded = await Promise.all(REQUIRED_GATES.map(async (gate) => {
    const paths = args.gates[gate];
    const [artifactValue, attestationValue] = await Promise.all([
      readFile(paths.artifactPath, "utf8").then(JSON.parse),
      readFile(paths.attestationPath, "utf8").then(JSON.parse),
    ]);
    const artifact = validateReleaseGateArtifact(artifactValue);
    if (artifact.gate !== gate || artifact.environment !== "production") {
      throw new Error(`required ${gate} production evidence is absent`);
    }
    assertGateCandidate(artifact, {
      tag: args.candidateTag,
      version: args.version,
      sourceRevision: args.sourceRevision,
      imageDigest: promotion.imageDigest,
    });
    const attestation = verifyReleaseGateProducerAttestation(
      attestationValue,
      artifact,
      producerKey,
    );
    if (attestation.signature.keyId !== args.producerKeyId) {
      throw new Error(`${gate} used an unapproved producer key ID`);
    }
    if (
      Date.parse(artifact.completedAt) < Date.parse(promotion.completedAt)
    ) {
      throw new Error(`${gate} predates backend promotion`);
    }
    return artifact;
  }));
  const [convergence, browser, fixedThree, apple] = loaded;
  if (
    convergence.configurationHash !== browser.configurationHash
    || convergence.runtimeHash !== browser.runtimeHash
    || fixedThree.configurationHash !== apple.configurationHash
    || fixedThree.runtimeHash !== apple.runtimeHash
  ) {
    throw new Error(
      "pre- and post-exposure gate pairs do not bind their exact runtimes",
    );
  }
  const browserSource = record(
    browser.sources.browser,
    "final browser direct-exposure evidence",
  );
  if (
    browserSource.schemaVersion !== "genio-final-custom-domain-browser/v8"
    || browserSource.assignmentMode !== "direct_exposure"
    || browserSource.exposureClass !== "fully_exposed_unproven"
    || browserSource.organicReliabilityProven !== false
  ) throw new Error("final browser did not prove direct public exposure");
  const sites = record(
    browser.sources.sitesControlPlane,
    "final browser Sites control-plane evidence",
  );
  if (sites.projectId !== EXISTING_SITES_PROJECT_ID) {
    throw new Error("final browser evidence does not use the existing Sites project");
  }
  const burnInValue = JSON.parse(await readFile(args.burnInReceiptPath, "utf8"));
  // Dynamic import avoids making the burn-in producer's use of the promotion
  // receipt validator into a module-initialization cycle. Both modules are
  // fully evaluated before finalization begins.
  const {
    createV254BurnInBindingV1,
    validateV254ProductionBurnInReceiptV1,
  } = await import(
    "./v254-production-burn-in.ts"
  );
  const reconstructedBinding = await createV254BurnInBindingV1({
    candidateTag: args.candidateTag,
    sourceRevision: args.sourceRevision,
    version: args.version,
    backendPromotionPath: args.backendPromotionPath,
    directExposureAuthorityPath: args.directExposureAuthorityPath,
    directExposureRollbackWarrantPath:
      args.directExposureRollbackWarrantPath,
    directExposureDatabaseActivateReceiptPath:
      args.directExposureDatabaseActivateReceiptPath,
    directExposureRuntimeReceiptPath: args.directExposureRuntimeReceiptPath,
    finalBrowserArtifactPath:
      args.gates.final_custom_domain_browser.artifactPath,
    finalBrowserAttestationPath:
      args.gates.final_custom_domain_browser.attestationPath,
    producerVerificationKeyPath: args.producerVerificationKeyPath,
    producerKeyId: args.producerKeyId,
    producerKeySha256: args.producerKeySha256,
    directExposureVerificationKeyPath:
      args.directExposureVerificationKeyPath,
    directExposureKeyId: args.directExposureKeyId,
    directExposureKeySha256: args.directExposureKeySha256,
  });
  if (
    reconstructedBinding.route.ownerAppleGateEvidenceHash
      !== apple.evidenceHash
  ) {
    throw new Error(
      "signed direct exposure does not bind the final owner Apple gate",
    );
  }
  const burnIn = validateV254ProductionBurnInReceiptV1(burnInValue, {
    candidateTag: args.candidateTag,
    version: args.version,
    sourceRevision: args.sourceRevision,
    imageDigest: promotion.imageDigest,
    semanticBehaviorManifestHash:
      reconstructedBinding.backend.semanticBehaviorManifestHash,
    semanticExecutionConfigurationHash:
      reconstructedBinding.backend.semanticExecutionConfigurationHash,
    sitesProjectId: String(sites.projectId),
    sitesVersionId: String(sites.versionId),
    sitesDeploymentId: String(sites.deploymentId),
    finalBrowserEvidenceHash: browser.evidenceHash,
    requireComplete: true,
  });
  if (burnIn.binding.bindingHash !== reconstructedBinding.bindingHash) {
    throw new Error(
      "burn-in binding differs from independently verified finalization inputs",
    );
  }
  const unsigned = {
    schemaVersion: "genio-native-schema20-finalization/v2" as const,
    candidate: {
      tag: args.candidateTag,
      version: args.version,
      sourceRevision: args.sourceRevision,
      imageDigest: promotion.imageDigest,
      sitesSourceRevision: args.sourceRevision,
    },
    backendPromotionReceiptHash: promotion.receiptHash,
    semanticBehaviorManifestHash:
      reconstructedBinding.backend.semanticBehaviorManifestHash,
    semanticExecutionConfigurationHash:
      reconstructedBinding.backend.semanticExecutionConfigurationHash,
    containmentReceiptHash: promotion.containmentReceiptHash,
    guidanceCheckpointMigrationReceiptHash:
      promotion.guidanceCheckpointMigrationReceiptHash,
    legacyExecutionRouteDrainInventoryReceiptHash:
      promotion.legacyExecutionRouteDrainInventoryReceiptHash,
    schema20EvidenceRecoveryReceiptHash:
      promotion.schema20EvidenceRecoveryReceiptHash,
    directExposure: {
      authorityPayloadHash:
        reconstructedBinding.route.directExposureAuthorityPayloadHash,
      authorityArtifactHash:
        reconstructedBinding.route.directExposureAuthorityArtifactHash,
      rollbackWarrantPayloadHash:
        reconstructedBinding.route.rollbackWarrantPayloadHash,
      rollbackWarrantArtifactHash:
        reconstructedBinding.route.rollbackWarrantArtifactHash,
      preconditionsHash: reconstructedBinding.route.preconditionsHash,
      rollbackPlanHash: reconstructedBinding.route.rollbackPlanHash,
      targetConfigurationHash:
        reconstructedBinding.route.targetConfigurationHash,
      preExposureSemanticConfigurationHash:
        reconstructedBinding.route.preExposureSemanticConfigurationHash,
      postExposureSemanticConfigurationHash:
        reconstructedBinding.route.postExposureSemanticConfigurationHash,
      rollbackSemanticConfigurationHash:
        reconstructedBinding.route.rollbackSemanticConfigurationHash,
      preExposureRuntimeTupleHash:
        reconstructedBinding.route.preExposureRuntimeTupleHash,
      postExposureRuntimeTupleHash:
        reconstructedBinding.route.postExposureRuntimeTupleHash,
      rollbackRuntimeTupleHash:
        reconstructedBinding.route.rollbackRuntimeTupleHash,
      databaseActivateReceiptHash:
        reconstructedBinding.route.databaseActivateReceiptHash,
      runtimeTransitionReceiptHash:
        reconstructedBinding.route.runtimeTransitionReceiptHash,
      ownerAppleGateEvidenceHash:
        reconstructedBinding.route.ownerAppleGateEvidenceHash,
      preExposureCleanGateEvidenceHash:
        reconstructedBinding.route.preExposureCleanGateEvidenceHash,
      databaseRouteReceiptHash:
        reconstructedBinding.route.databaseRouteReceiptHash,
      exposureClass: "fully_exposed_unproven" as const,
      organicReliabilityProven: false as const,
    },
    gateEvidenceHashes: {
      release_convergence: convergence.evidenceHash,
      final_custom_domain_browser: browser.evidenceHash,
      production_fixed_three_track: fixedThree.evidenceHash,
      production_affected_regression: apple.evidenceHash,
    },
    burnInReceiptHash: burnIn.receiptHash,
    burnInCompletedAt: burnIn.completedAt!,
    sites: {
      projectId: String(sites.projectId),
      versionId: String(sites.versionId),
      deploymentId: String(sites.deploymentId),
      archiveSha256: string(
        sites.archiveSha256,
        "Sites archive digest",
        SHA256,
      ),
      controlPlaneEvidenceHash: string(
        sites.evidenceHash,
        "Sites control-plane evidence hash",
        SHA256,
      ),
    },
    completedAt: new Date().toISOString(),
  };
  return Object.freeze({
    ...unsigned,
    receiptHash: nativeSchema20FinalizationReceiptHash(unsigned),
  });
}

async function main(): Promise<void> {
  const args = parseNativeSchema20FinalizationArgs(process.argv.slice(2));
  const receipt = await finalizeNativeSchema20Release(args);
  await writeFile(args.outputPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schemaVersion: receipt.schemaVersion,
    sourceRevision: receipt.candidate.sourceRevision,
    version: receipt.candidate.version,
    receiptHash: receipt.receiptHash,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "native_schema20_finalization_failed",
      message: error instanceof Error
        ? error.message
        : "Native schema-20 finalization failed",
    })}\n`);
    process.exitCode = 1;
  });
}
