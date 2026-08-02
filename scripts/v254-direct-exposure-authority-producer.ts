import {
  createHash,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { RELEASE_EVIDENCE_TTL_MS } from "../shared/release-evidence-constants.ts";
import { signedArtifactSha256 } from "../shared/signed-artifact.ts";
import {
  V254_DIRECT_EXPOSURE_AUTHORITY_SCHEMA_VERSION,
  V254_DIRECT_EXPOSURE_ROLLBACK_WARRANT_SCHEMA_VERSION,
  createSignedV254DirectExposureAuthorityV1,
  createSignedV254DirectExposureRollbackWarrantV1,
  createV254DirectExposureRollbackPlanV1,
  createV254DirectExposureRuntimeTransitionV1,
  validateV254DirectExposureConfigurationV1,
  v254DirectExposurePreconditionsHashV1,
  verifyV254DirectExposureAuthorityAndWarrantV1,
  type V254DirectExposureAuthorityPayloadV1,
  type V254DirectExposureRollbackWarrantPayloadV1,
} from "../shared/v254-direct-exposure-authority.ts";
import {
  verifyNativeSchema20RolloutPromotionAuthorityV1,
  type NativeSchema20RolloutPromotionAuthorityPayloadV1,
} from "../shared/native-schema20-rollout-promotion-authority.ts";
import {
  validateNativeSchema20PromotionReceipt,
} from "./finalize-native-schema20-release.ts";
import {
  validateReleaseGateArtifact,
  validateSitesControlPlaneSource,
  verifyReleaseGateProducerAttestation,
  type ReleaseGateArtifactV1,
} from "./release-fixtures.ts";
import { releaseGateProducerKeyFingerprint } from "./release-evidence.ts";
import {
  nativeV254PublicEditorialActivationVariablesV1,
  nativeV254RouteSwitchVariablesV1,
} from "./promote-native-schema20-release.ts";
import {
  validateV254EditorialRouteAuthorityReceiptV1,
} from "./v254-editorial-route-control.ts";
import {
  PUBLIC_ROLLOUT_TARGET_CONFIGURATION_KEYS,
} from "../shared/public-rollout-evidence.ts";

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u;
const PROJECT_ID = "appgprj_6a5565cf7d6c8191ab9f2084e8eda856";

type JsonRecord = Record<string, unknown>;

function directConfigurationFromBehaviorVariables(
  variables: Readonly<Record<string, string>>,
) {
  const complete: Readonly<Record<string, string>> = {
    RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
    RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
    RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
    RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION: "1",
    ...variables,
  };
  return validateV254DirectExposureConfigurationV1(Object.fromEntries(
    PUBLIC_ROLLOUT_TARGET_CONFIGURATION_KEYS.map((key) => [
      key,
      complete[key],
    ]),
  ));
}

export interface V254DirectExposureAuthorityProducerArgsV1 {
  promotionReceiptPath: string;
  nativeAuthorityPath: string;
  nativeVerificationKeyPath: string;
  nativeKeyId: string;
  nativeKeySha256: string;
  sitesControlPlanePath: string;
  ownerGatePath: string;
  ownerAttestationPath: string;
  cleanGatePath: string;
  cleanAttestationPath: string;
  gateVerificationKeyPath: string;
  gateKeyId: string;
  gateKeySha256: string;
  databaseRouteReceiptPath: string;
  candidateTag: string;
  sourceRevision: string;
  version: string;
  imageDigest: string;
  postSemanticConfigurationHash: string;
  signingKeyPath: string;
  signingKeyId: string;
  signingKeySha256: string;
  authorityOutputPath: string;
  rollbackWarrantOutputPath: string;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as JsonRecord;
}

async function json(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} is not readable JSON`);
  }
}

function option(argv: readonly string[], name: string): string {
  const indices = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indices.length !== 1) throw new Error(`${name} must occur exactly once`);
  const value = argv[indices[0]! + 1]?.trim() ?? "";
  if (!value || value.startsWith("--") || value.includes("\0")) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

export function parseV254DirectExposureAuthorityProducerArgsV1(
  argv: readonly string[],
): V254DirectExposureAuthorityProducerArgsV1 {
  const names = [
    "--promotion-receipt", "--native-authority",
    "--native-verification-key", "--native-key-id", "--native-key-sha256",
    "--sites-control-plane", "--owner-gate", "--owner-attestation",
    "--clean-gate", "--clean-attestation", "--gate-verification-key",
    "--gate-key-id", "--gate-key-sha256", "--database-route-receipt",
    "--candidate-tag", "--source-revision", "--version", "--image-digest",
    "--post-semantic-configuration-hash", "--signing-key",
    "--signing-key-id", "--signing-key-sha256", "--authority-output",
    "--rollback-warrant-output",
  ] as const;
  const allowed = new Set(names);
  if (argv.length !== names.length * 2) {
    throw new Error("direct-exposure authority inputs are incomplete");
  }
  for (let index = 0; index < argv.length; index += 2) {
    if (!allowed.has(argv[index] as typeof names[number])) {
      throw new Error("direct-exposure authority argument is unsupported");
    }
  }
  const result: V254DirectExposureAuthorityProducerArgsV1 = {
    promotionReceiptPath: option(argv, "--promotion-receipt"),
    nativeAuthorityPath: option(argv, "--native-authority"),
    nativeVerificationKeyPath: option(argv, "--native-verification-key"),
    nativeKeyId: option(argv, "--native-key-id"),
    nativeKeySha256: option(argv, "--native-key-sha256").toLowerCase(),
    sitesControlPlanePath: option(argv, "--sites-control-plane"),
    ownerGatePath: option(argv, "--owner-gate"),
    ownerAttestationPath: option(argv, "--owner-attestation"),
    cleanGatePath: option(argv, "--clean-gate"),
    cleanAttestationPath: option(argv, "--clean-attestation"),
    gateVerificationKeyPath: option(argv, "--gate-verification-key"),
    gateKeyId: option(argv, "--gate-key-id"),
    gateKeySha256: option(argv, "--gate-key-sha256").toLowerCase(),
    databaseRouteReceiptPath: option(argv, "--database-route-receipt"),
    candidateTag: option(argv, "--candidate-tag"),
    sourceRevision: option(argv, "--source-revision").toLowerCase(),
    version: option(argv, "--version"),
    imageDigest: option(argv, "--image-digest").toLowerCase(),
    postSemanticConfigurationHash: option(
      argv,
      "--post-semantic-configuration-hash",
    ).toLowerCase(),
    signingKeyPath: option(argv, "--signing-key"),
    signingKeyId: option(argv, "--signing-key-id"),
    signingKeySha256: option(argv, "--signing-key-sha256").toLowerCase(),
    authorityOutputPath: option(argv, "--authority-output"),
    rollbackWarrantOutputPath: option(argv, "--rollback-warrant-output"),
  };
  if (
    !SHA1.test(result.sourceRevision)
    || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u
      .test(result.version)
    || !new RegExp(`^v${result.version.replaceAll(".", "\\.")}-rc\\.[1-9]\\d*$`, "u")
      .test(result.candidateTag)
    || !IMAGE_DIGEST.test(result.imageDigest)
    || !SHA256.test(result.postSemanticConfigurationHash)
    || !SAFE_KEY_ID.test(result.nativeKeyId)
    || !SHA256.test(result.nativeKeySha256)
    || !SAFE_KEY_ID.test(result.gateKeyId)
    || !SHA256.test(result.gateKeySha256)
    || !SAFE_KEY_ID.test(result.signingKeyId)
    || !SHA256.test(result.signingKeySha256)
  ) throw new Error("direct-exposure authority identity policy is invalid");
  return result;
}

async function requireAbsent(path: string): Promise<void> {
  try {
    await access(path);
    throw new Error("direct-exposure authority output already exists");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function assertGateCandidate(
  artifact: ReleaseGateArtifactV1,
  input: V254DirectExposureAuthorityProducerArgsV1,
): void {
  if (
    artifact.candidate.tag !== input.candidateTag
    || artifact.candidate.version !== input.version
    || artifact.candidate.sourceRevision !== input.sourceRevision
    || artifact.candidate.sitesSourceRevision !== input.sourceRevision
    || artifact.candidate.imageDigest !== input.imageDigest
  ) throw new Error("direct-exposure gate does not bind the exact candidate");
}

function validateGateAttestation(input: {
  artifact: ReleaseGateArtifactV1;
  attestation: unknown;
  key: Buffer;
  keyId: string;
  keySha256: string;
}): string {
  if (releaseGateProducerKeyFingerprint(input.key) !== input.keySha256) {
    throw new Error("direct-exposure gate verification key is not protected");
  }
  const verified = verifyReleaseGateProducerAttestation(
    input.attestation,
    input.artifact,
    input.key,
  );
  if (verified.signature.keyId !== input.keyId) {
    throw new Error("direct-exposure gate used the wrong producer key ID");
  }
  return signedArtifactSha256(input.attestation);
}

function nativeExpected(
  authority: unknown,
  keyId: string,
  keySha256: string,
): Parameters<typeof verifyNativeSchema20RolloutPromotionAuthorityV1>[2] {
  const envelope = record(authority, "signed native promotion authority");
  const payload = record(
    envelope.payload,
    "native promotion authority payload",
  ) as unknown as NativeSchema20RolloutPromotionAuthorityPayloadV1;
  return {
    keyId,
    keySha256,
    candidate: payload.candidate,
    nativePromotion: payload.nativePromotion,
    promotion: payload.promotion,
    sites: {
      projectId: payload.sites.projectId,
      versionId: payload.sites.versionId,
      deploymentId: payload.sites.deploymentId,
      version: payload.sites.version,
      sourceRevision: payload.sites.sourceRevision,
      controlPlaneEvidenceHash: payload.sites.controlPlaneEvidenceHash,
    },
  };
}

export async function produceV254DirectExposureAuthorityV1(
  args: V254DirectExposureAuthorityProducerArgsV1,
  now = new Date(),
) {
  await Promise.all([
    requireAbsent(args.authorityOutputPath),
    requireAbsent(args.rollbackWarrantOutputPath),
  ]);
  const [
    promotionValue,
    nativeAuthority,
    nativeVerificationKey,
    sitesValue,
    ownerValue,
    ownerAttestation,
    cleanValue,
    cleanAttestation,
    gateVerificationKey,
    routeValue,
    signingKeyBytes,
  ] = await Promise.all([
    json(args.promotionReceiptPath, "native promotion receipt"),
    json(args.nativeAuthorityPath, "signed native promotion authority"),
    readFile(args.nativeVerificationKeyPath),
    json(args.sitesControlPlanePath, "Sites control-plane receipt"),
    json(args.ownerGatePath, "owner Apple gate"),
    json(args.ownerAttestationPath, "owner Apple attestation"),
    json(args.cleanGatePath, "clean non-owner gate"),
    json(args.cleanAttestationPath, "clean non-owner attestation"),
    readFile(args.gateVerificationKeyPath),
    json(args.databaseRouteReceiptPath, "database route receipt"),
    readFile(args.signingKeyPath),
  ]);
  const promotion = validateNativeSchema20PromotionReceipt(promotionValue, {
    sourceRevision: args.sourceRevision,
    version: args.version,
  });
  if (promotion.imageDigest !== args.imageDigest) {
    throw new Error("direct-exposure promotion image does not match");
  }
  const native = verifyNativeSchema20RolloutPromotionAuthorityV1(
    nativeAuthority,
    nativeVerificationKey,
    nativeExpected(nativeAuthority, args.nativeKeyId, args.nativeKeySha256),
  );
  if (
    native.candidate.tag !== args.candidateTag
    || native.candidate.version !== args.version
    || native.candidate.sourceRevision !== args.sourceRevision
    || native.candidate.imageDigest !== args.imageDigest
    || native.nativePromotionReceiptHash !== promotion.receiptHash
    || native.configurationHash
      !== promotion.semanticExecutionConfigurationHash
    || native.runtimeHash !== promotion.backendConvergenceEvidenceHash
    || native.semanticBehaviorHash !== promotion.semanticBehaviorManifestHash
  ) throw new Error("signed native authority and promotion receipt diverge");
  const candidate = native.candidate;
  const sitesRecord = record(sitesValue, "Sites control-plane receipt");
  validateSitesControlPlaneSource(sitesValue, {
    tag: args.candidateTag,
    version: args.version,
    sourceRevision: args.sourceRevision,
    imageDigest: args.imageDigest,
    sitesSourceRevision: args.sourceRevision,
  });
  if (sitesRecord.projectId !== PROJECT_ID) {
    throw new Error("direct exposure may not target another Sites project");
  }
  const owner = validateReleaseGateArtifact(ownerValue);
  const clean = validateReleaseGateArtifact(cleanValue);
  assertGateCandidate(owner, args);
  assertGateCandidate(clean, args);
  if (owner.gate !== "production_affected_regression") {
    throw new Error("direct exposure lacks the owner Apple regression gate");
  }
  if (clean.gate !== "final_custom_domain_browser") {
    throw new Error("direct exposure lacks the clean non-owner browser gate");
  }
  const ownerAttestationHash = validateGateAttestation({
    artifact: owner,
    attestation: ownerAttestation,
    key: gateVerificationKey,
    keyId: args.gateKeyId,
    keySha256: args.gateKeySha256,
  });
  const cleanAttestationHash = validateGateAttestation({
    artifact: clean,
    attestation: cleanAttestation,
    key: gateVerificationKey,
    keyId: args.gateKeyId,
    keySha256: args.gateKeySha256,
  });
  const ownerSources = record(owner.sources, "owner gate sources");
  const hosted = record(ownerSources.hostedPublication, "owner hosted proof");
  const apple = record(ownerSources.independentApple, "owner Apple proof");
  const cleanSources = record(clean.sources, "clean browser gate sources");
  const browser = record(cleanSources.browser, "clean browser proof");
  const probes = Array.isArray(browser.publicAssignmentProbes)
    ? browser.publicAssignmentProbes.map((value) => record(value, "clean probe"))
    : [];
  const probe = probes.find((value) => (
    value.fixtureId === "final-public-assignment-editorial-influence-typo-v1"
  ));
  if (
    browser.schemaVersion !== "genio-final-custom-domain-browser/v7"
    || browser.assignmentMode !== "pre_exposure_release_canary"
    || !probe
  ) throw new Error("clean non-owner gate is not the pre-exposure UI proof");
  const route = validateV254EditorialRouteAuthorityReceiptV1(routeValue);
  if (
    route.phase !== "public_canary"
    || route.sourceRevision !== args.sourceRevision
    || route.version !== args.version
    || route.imageDigest !== args.imageDigest
    || route.promotionReceiptHash !== promotion.receiptHash
    || route.database.hardSwitchDisabled !== false
    || route.database.globalPublicPause !== true
    || route.database.intentPublicPause !== true
    || route.completedAt > clean.completedAt
    || owner.completedAt > route.completedAt
  ) throw new Error("database route proof is not the paused public canary");
  const currentConfiguration = directConfigurationFromBehaviorVariables(
    nativeV254RouteSwitchVariablesV1(),
  );
  const targetConfiguration = directConfigurationFromBehaviorVariables(
    nativeV254PublicEditorialActivationVariablesV1(),
  );
  const rollbackPlan = createV254DirectExposureRollbackPlanV1({
    candidate,
    targetConfiguration: currentConfiguration,
  });
  const serviceName = {
    interactive: "needle-worker",
    deep: "needle-deep-worker",
    api: "needle-api",
  } as const;
  const services = Object.fromEntries(
    (["interactive", "deep", "api"] as const).map((lane) => {
      const promoted = promotion.services[lane];
      return [lane, {
        serviceId: promoted.serviceId,
        serviceName: serviceName[lane],
        preExposureDeploymentId: promoted.deploymentId,
        targetImageReference: promotion.imageReference,
        targetImageDigest: promotion.imageDigest,
        targetSourceRevision: promotion.sourceRevision,
        preExposureSemanticConfigurationHash:
          promotion.semanticExecutionConfigurationHash,
        postExposureSemanticConfigurationHash:
          args.postSemanticConfigurationHash,
        rollbackDeploymentId: promoted.deploymentId,
        rollbackImageReference: promotion.imageReference,
        rollbackImageDigest: promotion.imageDigest,
        rollbackSourceRevision: promotion.sourceRevision,
        rollbackSemanticConfigurationHash:
          promotion.semanticExecutionConfigurationHash,
      }];
    }),
  ) as Parameters<typeof createV254DirectExposureRuntimeTransitionV1>[0]["services"];
  const runtimeTransition = createV254DirectExposureRuntimeTransitionV1({
    candidate,
    preExposureSemanticConfigurationHash:
      promotion.semanticExecutionConfigurationHash,
    postExposureSemanticConfigurationHash:
      args.postSemanticConfigurationHash,
    services,
  });
  const generatedAt = now.toISOString();
  const base: V254DirectExposureAuthorityPayloadV1 = {
    schemaVersion: V254_DIRECT_EXPOSURE_AUTHORITY_SCHEMA_VERSION,
    generatedAt,
    expiresAt: new Date(now.getTime() + RELEASE_EVIDENCE_TTL_MS).toISOString(),
    environment: "production",
    candidate,
    promotion: {
      signedNativePromotionAuthorityHash:
        signedArtifactSha256(nativeAuthority),
      nativePromotionReceiptHash: promotion.receiptHash,
      configurationHash: promotion.semanticExecutionConfigurationHash,
      runtimeHash: promotion.backendConvergenceEvidenceHash,
      semanticBehaviorHash: promotion.semanticBehaviorManifestHash,
      nativePromotionCompletedAt: promotion.completedAt,
      sitesProjectId: String(sitesRecord.projectId),
      sitesVersionId: String(sitesRecord.versionId),
      sitesDeploymentId: String(sitesRecord.deploymentId),
      sitesRevision: args.sourceRevision,
      sitesDeployedAt: String(sitesRecord.observedAt),
      railwayProjectId: promotion.projectId,
      runtimeTransition,
    },
    transition: {
      operation: "direct_expose",
      route: "corpus_first_v3",
      intentGroup: "editorial_influence",
      fromPercent: "0",
      toPercent: "100",
      exposureClass: "fully_exposed_unproven",
      organicReliabilityProven: false,
      organicMetricsClaim: null,
      previousDirectExposureHash: null,
    },
    proofs: {
      ownerApple: {
        workflowPath: ".github/workflows/v254-owner-apple-gate.yml",
        gateEvidenceHash: owner.evidenceHash,
        attestationPayloadHash: ownerAttestationHash,
        manifestHash: String(hosted.manifestContentHash),
        expectedOrderedAppleIdsHash: String(apple.expectedOrderedIdsHash),
        observedOrderedAppleIdsHash: String(apple.observedOrderedIdsHash),
        trackCount: 25,
        completedAt: owner.completedAt,
      },
      cleanNonOwner: {
        workflowPath: ".github/workflows/v254-pre-exposure-clean-nonowner.yml",
        gateEvidenceHash: clean.evidenceHash,
        attestationPayloadHash: cleanAttestationHash,
        assignmentReceiptHash: String(probe.assignmentReceiptHash),
        routeReceiptHash: String(probe.executionRouteReceiptHash),
        successorContractHash: String(probe.successorContractHash),
        queryPlanHash: String(probe.queryPlanHash),
        workerConsumptionReceiptHash:
          String(probe.workerConsumptionReceiptHash),
        identityClass: "clean_non_owner",
        assignmentAuthority: "signed_release_canary",
        publicPercentageBypass: true,
        organicAssignment: false,
        manifestOnly: true,
        appleWriteAccess: "forbidden",
        completedAt: clean.completedAt,
      },
      databaseRouteAuthority: {
        receiptHash: route.receiptHash,
        phase: "public_canary",
        hardSwitchDisabled: false,
        globalPublicPause: true,
        intentPublicPause: true,
        completedAt: route.completedAt,
      },
    },
    currentConfiguration,
    currentConfigurationHash: signedArtifactSha256(currentConfiguration),
    targetConfiguration,
    targetConfigurationHash: signedArtifactSha256(targetConfiguration),
    preconditionsHash: "0".repeat(64),
    rollbackPlanHash: signedArtifactSha256(rollbackPlan),
  };
  const payload: V254DirectExposureAuthorityPayloadV1 = {
    ...base,
    preconditionsHash: v254DirectExposurePreconditionsHashV1(base),
  };
  const privateKey = createPrivateKey(signingKeyBytes);
  const publicKey = createPublicKey(privateKey);
  const signingKeySha256 = createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
  if (
    privateKey.asymmetricKeyType !== "ed25519"
    || signingKeySha256 !== args.signingKeySha256
  ) throw new Error("direct exposure did not use the protected rollout key");
  const authority = createSignedV254DirectExposureAuthorityV1({
    payload,
    signingKey: privateKey,
    keyId: args.signingKeyId,
  });
  const warrantPayload: V254DirectExposureRollbackWarrantPayloadV1 = {
    schemaVersion: V254_DIRECT_EXPOSURE_ROLLBACK_WARRANT_SCHEMA_VERSION,
    generatedAt,
    environment: "production",
    candidate,
    advance: {
      authorityPayloadHash: authority.payloadHash,
      targetConfigurationHash: payload.targetConfigurationHash,
      ownerAppleProofHash: signedArtifactSha256(payload.proofs.ownerApple),
      cleanNonOwnerProofHash:
        signedArtifactSha256(payload.proofs.cleanNonOwner),
      routeReceiptHash: route.receiptHash,
      rollbackPlanHash: payload.rollbackPlanHash,
      preExposureRuntimeTupleHash:
        runtimeTransition.preExposureRuntimeTupleHash,
      postExposureRuntimeTupleHash: runtimeTransition.postExposureRuntimeTupleHash,
      rollbackRuntimeTupleHash: runtimeTransition.rollbackRuntimeTupleHash,
    },
    rollback: rollbackPlan,
    promotion: {
      signedNativePromotionAuthorityHash:
        payload.promotion.signedNativePromotionAuthorityHash,
      nativePromotionReceiptHash: promotion.receiptHash,
      runtimeHash: promotion.backendConvergenceEvidenceHash,
      sitesRevision: args.sourceRevision,
    },
  };
  const rollbackWarrant = createSignedV254DirectExposureRollbackWarrantV1({
    payload: warrantPayload,
    signingKey: privateKey,
    keyId: args.signingKeyId,
  });
  verifyV254DirectExposureAuthorityAndWarrantV1({
    authority,
    rollbackWarrant,
    verificationKey: publicKey,
    expected: {
      keyId: args.signingKeyId,
      keySha256: args.signingKeySha256,
      candidate,
      signedNativePromotionAuthorityHash:
        payload.promotion.signedNativePromotionAuthorityHash,
      nativePromotionReceiptHash: promotion.receiptHash,
      configurationHash: promotion.semanticExecutionConfigurationHash,
      runtimeHash: promotion.backendConvergenceEvidenceHash,
      semanticBehaviorHash: promotion.semanticBehaviorManifestHash,
      sites: {
        projectId: String(sitesRecord.projectId),
        versionId: String(sitesRecord.versionId),
        deploymentId: String(sitesRecord.deploymentId),
        revision: args.sourceRevision,
      },
      runtimeTransition,
      ownerAppleGateEvidenceHash: owner.evidenceHash,
      cleanNonOwnerGateEvidenceHash: clean.evidenceHash,
      databaseRouteReceiptHash: route.receiptHash,
      currentConfiguration,
      targetConfiguration,
      now: generatedAt,
    },
  });
  await writeFile(args.authorityOutputPath, `${JSON.stringify(authority, null, 2)}\n`, {
    encoding: "utf8", mode: 0o600, flag: "wx",
  });
  await writeFile(
    args.rollbackWarrantOutputPath,
    `${JSON.stringify(rollbackWarrant, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return Object.freeze({
    authorityPayloadHash: authority.payloadHash,
    authorityArtifactHash: signedArtifactSha256(authority),
    rollbackWarrantPayloadHash: rollbackWarrant.payloadHash,
    rollbackWarrantArtifactHash: signedArtifactSha256(rollbackWarrant),
    preconditionsHash: payload.preconditionsHash,
    rollbackPlanHash: payload.rollbackPlanHash,
  });
}

async function main(): Promise<void> {
  const args = parseV254DirectExposureAuthorityProducerArgsV1(
    process.argv.slice(2),
  );
  const result = await produceV254DirectExposureAuthorityV1(args);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "v254_direct_exposure_authority_failed_closed",
      message: "v2.5.4 direct-exposure authority failed closed",
    })}\n`);
    process.exitCode = 1;
  });
}
