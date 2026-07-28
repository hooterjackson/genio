import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  SEMANTIC_RANKING_PROTECTED_BASELINE_SCHEMA_V1,
  semanticRankingProtectedBaselineMetadataSha256,
  validateSemanticRankingProtectedBaselineMetadataV1,
} from "../lib/semantic-ranking-review.ts";
import {
  sitesControlPlaneTrustPolicyV1,
} from "../shared/sites-control-plane-attestation.ts";
import {
  controlPlaneReceiptTrustPolicyV1,
} from "../shared/staging-control-plane-receipts.ts";
import {
  stagingControlPlaneTrustPolicyV1,
} from "../shared/staging-control-plane-evidence.ts";
import {
  exactObject,
  sha256Digest,
  stableSignedArtifactJson,
} from "../shared/signed-artifact.ts";
import {
  STABLE_RELEASE_FINALIZATION_SOURCE_BUNDLE_SCHEMA_V2,
  stableReleaseKeyFingerprint,
  verifyStableReleaseFinalizationSources,
  type StableReleaseFinalizationSourceBundleV2,
} from "./authorize-stable-release.ts";
import {
  releaseGateProducerTrustPolicyV1,
  verifyReleaseEvidence,
} from "./release-evidence.ts";
import {
  parseCreateOnlyCliOptions,
  readContainedBoundedJsonFile,
  readBoundedJsonFile,
  readBoundedRegularFile,
  requiredProtectedEnvironment,
  writeCanonicalJsonCreateOnly,
} from "./release-authoring-io.ts";

const KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const FINALIZATION_SOURCE_MANIFEST_SCHEMA_V1 =
  "genio-stable-release-finalization-source-authoring-manifest/v1";
const FINALIZATION_SOURCE_GATES = Object.freeze([
  "production_fixed_three_track",
  "production_affected_regression",
  "backend_release_convergence",
  "release_convergence",
  "final_custom_domain_browser",
] as const);
type FinalizationSourceGate = typeof FINALIZATION_SOURCE_GATES[number];

interface FinalizationSourceAuthoringManifestV1 {
  schemaVersion: typeof FINALIZATION_SOURCE_MANIFEST_SCHEMA_V1;
  promotionEvidenceFile: string;
  publicRolloutEvidenceFile: string;
  stagingControlPlaneEvidenceFile: string;
  stagingControlPlaneVerificationKeyFile: string;
  stagingControlPlaneTrustPolicyFile: string;
  controlPlaneReceiptFiles: Record<"apple" | "provider" | "qaBudget", string>;
  controlPlaneReceiptVerificationKeyFiles:
    Record<"apple" | "provider" | "qaBudget", string>;
  controlPlaneReceiptTrustPolicyFiles:
    Record<"apple" | "provider" | "qaBudget", string>;
  gateArtifactFiles: Record<FinalizationSourceGate, string>;
  gateProducerAttestationFiles: Record<FinalizationSourceGate, string>;
}

function protectedValue(
  name: string,
  pattern: RegExp,
  label: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return requiredProtectedEnvironment(name, pattern, label, environment);
}

function exactPathRecord<T extends string>(
  value: unknown,
  keys: readonly T[],
  label: string,
): Record<T, string> {
  const record = exactObject(value, keys, label);
  return Object.fromEntries(keys.map((key) => {
    const path = record[key];
    if (typeof path !== "string" || path.trim() !== path || !path) {
      throw new Error(`${label}.${key} must be a non-empty path`);
    }
    return [key, path];
  })) as Record<T, string>;
}

export function validateFinalizationSourceAuthoringManifestV1(
  value: unknown,
): FinalizationSourceAuthoringManifestV1 {
  const manifest = exactObject(value, [
    "schemaVersion",
    "promotionEvidenceFile",
    "publicRolloutEvidenceFile",
    "stagingControlPlaneEvidenceFile",
    "stagingControlPlaneVerificationKeyFile",
    "stagingControlPlaneTrustPolicyFile",
    "controlPlaneReceiptFiles",
    "controlPlaneReceiptVerificationKeyFiles",
    "controlPlaneReceiptTrustPolicyFiles",
    "gateArtifactFiles",
    "gateProducerAttestationFiles",
  ], "finalization source authoring manifest");
  if (manifest.schemaVersion !== FINALIZATION_SOURCE_MANIFEST_SCHEMA_V1) {
    throw new Error(
      "finalization source authoring manifest uses an unsupported schema",
    );
  }
  const path = (name: string): string => {
    const value = manifest[name];
    if (typeof value !== "string" || value.trim() !== value || !value) {
      throw new Error(
        `finalization source authoring manifest.${name} must be a path`,
      );
    }
    return value;
  };
  const receiptKeys = ["apple", "provider", "qaBudget"] as const;
  return {
    schemaVersion: FINALIZATION_SOURCE_MANIFEST_SCHEMA_V1,
    promotionEvidenceFile: path("promotionEvidenceFile"),
    publicRolloutEvidenceFile: path("publicRolloutEvidenceFile"),
    stagingControlPlaneEvidenceFile:
      path("stagingControlPlaneEvidenceFile"),
    stagingControlPlaneVerificationKeyFile:
      path("stagingControlPlaneVerificationKeyFile"),
    stagingControlPlaneTrustPolicyFile:
      path("stagingControlPlaneTrustPolicyFile"),
    controlPlaneReceiptFiles: exactPathRecord(
      manifest.controlPlaneReceiptFiles,
      receiptKeys,
      "finalization source authoring manifest.controlPlaneReceiptFiles",
    ),
    controlPlaneReceiptVerificationKeyFiles: exactPathRecord(
      manifest.controlPlaneReceiptVerificationKeyFiles,
      receiptKeys,
      "finalization source authoring manifest."
        + "controlPlaneReceiptVerificationKeyFiles",
    ),
    controlPlaneReceiptTrustPolicyFiles: exactPathRecord(
      manifest.controlPlaneReceiptTrustPolicyFiles,
      receiptKeys,
      "finalization source authoring manifest."
        + "controlPlaneReceiptTrustPolicyFiles",
    ),
    gateArtifactFiles: exactPathRecord(
      manifest.gateArtifactFiles,
      FINALIZATION_SOURCE_GATES,
      "finalization source authoring manifest.gateArtifactFiles",
    ),
    gateProducerAttestationFiles: exactPathRecord(
      manifest.gateProducerAttestationFiles,
      FINALIZATION_SOURCE_GATES,
      "finalization source authoring manifest."
        + "gateProducerAttestationFiles",
    ),
  };
}

async function jsonFromManifest(
  directory: string,
  path: string,
  label: string,
): Promise<unknown> {
  return readContainedBoundedJsonFile(directory, path, label);
}

export async function loadStableReleaseFinalizationSourceBundleV2(
  manifestValue: unknown,
  manifestDirectory: string,
): Promise<StableReleaseFinalizationSourceBundleV2> {
  const manifest =
    validateFinalizationSourceAuthoringManifestV1(manifestValue);
  const receiptNames = ["apple", "provider", "qaBudget"] as const;
  const gateArtifacts = Object.fromEntries(
    await Promise.all(FINALIZATION_SOURCE_GATES.map(async (gate) => [
      gate,
      await jsonFromManifest(
        manifestDirectory,
        manifest.gateArtifactFiles[gate],
        `${gate} gate artifact`,
      ),
    ])),
  ) as Record<FinalizationSourceGate, unknown>;
  const gateProducerAttestations = Object.fromEntries(
    await Promise.all(FINALIZATION_SOURCE_GATES.map(async (gate) => [
      gate,
      await jsonFromManifest(
        manifestDirectory,
        manifest.gateProducerAttestationFiles[gate],
        `${gate} gate producer attestation`,
      ),
    ])),
  ) as Record<FinalizationSourceGate, unknown>;
  const controlPlaneReceipts = Object.fromEntries(
    await Promise.all(receiptNames.map(async (name) => [
      name,
      await jsonFromManifest(
        manifestDirectory,
        manifest.controlPlaneReceiptFiles[name],
        `${name} control-plane receipt`,
      ),
    ])),
  ) as Record<typeof receiptNames[number], unknown>;
  const controlPlaneReceiptVerificationKeys = Object.fromEntries(
    await Promise.all(receiptNames.map(async (name) => [
      name,
      await jsonFromManifest(
        manifestDirectory,
        manifest.controlPlaneReceiptVerificationKeyFiles[name],
        `${name} control-plane receipt verification key`,
      ),
    ])),
  ) as Record<typeof receiptNames[number], unknown>;
  const controlPlaneReceiptTrustPolicies = Object.fromEntries(
    await Promise.all(receiptNames.map(async (name) => [
      name,
      await jsonFromManifest(
        manifestDirectory,
        manifest.controlPlaneReceiptTrustPolicyFiles[name],
        `${name} control-plane receipt trust policy`,
      ),
    ])),
  ) as Record<typeof receiptNames[number], unknown>;
  const [
    promotionEvidence,
    publicRolloutEvidence,
    stagingControlPlaneEvidence,
    stagingControlPlaneVerificationKey,
    stagingControlPlaneTrustPolicy,
  ] = await Promise.all([
    jsonFromManifest(
      manifestDirectory,
      manifest.promotionEvidenceFile,
      "promotion evidence",
    ),
    jsonFromManifest(
      manifestDirectory,
      manifest.publicRolloutEvidenceFile,
      "public rollout evidence",
    ),
    jsonFromManifest(
      manifestDirectory,
      manifest.stagingControlPlaneEvidenceFile,
      "staging control-plane evidence",
    ),
    jsonFromManifest(
      manifestDirectory,
      manifest.stagingControlPlaneVerificationKeyFile,
      "staging control-plane verification key",
    ),
    jsonFromManifest(
      manifestDirectory,
      manifest.stagingControlPlaneTrustPolicyFile,
      "staging control-plane trust policy",
    ),
  ]);
  return {
    schemaVersion: STABLE_RELEASE_FINALIZATION_SOURCE_BUNDLE_SCHEMA_V2,
    promotionEvidence,
    publicRolloutEvidence,
    stagingControlPlaneEvidence,
    stagingControlPlaneVerificationKey,
    stagingControlPlaneTrustPolicy,
    controlPlaneReceipts,
    controlPlaneReceiptVerificationKeys,
    controlPlaneReceiptTrustPolicies,
    gateArtifacts,
    gateProducerAttestations,
  };
}

function assertProtectedReleaseKey(input: {
  signedEvidence: unknown;
  verificationKey: Buffer;
  environment?: NodeJS.ProcessEnv;
}): { keyId: string; keySha256: string } {
  const environment = input.environment ?? process.env;
  const keyId = protectedValue(
    "RELEASE_VERIFICATION_KEY_ID",
    KEY_ID,
    "protected release verification key ID",
    environment,
  );
  const keySha256 = protectedValue(
    "RELEASE_VERIFICATION_KEY_SHA256",
    SHA256,
    "protected release verification key fingerprint",
    environment,
  );
  const envelope = exactObject(input.signedEvidence, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], "signed release evidence");
  const signature = exactObject(envelope.signature, [
    "algorithm",
    "keyId",
    "value",
  ], "signed release evidence signature");
  if (
    signature.keyId !== keyId
    || stableReleaseKeyFingerprint(input.verificationKey) !== keySha256
  ) {
    throw new Error(
      "release evidence does not use the protected verification authority",
    );
  }
  return { keyId, keySha256 };
}

export function createProtectedSemanticBaselineMetadataV1(input: {
  finalizationEvidence: unknown;
  releaseVerificationKey: Buffer;
  approvedReleaseKeyId: string;
  approvedReleaseKeySha256: string;
  expectedRcTag: string;
  expectedVersion: string;
  expectedRevision: string;
  expectedImageDigest: string;
  now?: string;
}): ReturnType<typeof validateSemanticRankingProtectedBaselineMetadataV1> {
  const envelope = exactObject(input.finalizationEvidence, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], "signed finalization evidence");
  const signature = exactObject(envelope.signature, [
    "algorithm",
    "keyId",
    "value",
  ], "signed finalization evidence signature");
  if (
    signature.keyId !== input.approvedReleaseKeyId
    || stableReleaseKeyFingerprint(input.releaseVerificationKey)
      !== input.approvedReleaseKeySha256
  ) {
    throw new Error(
      "finalization evidence does not use the protected release key",
    );
  }
  const payload = verifyReleaseEvidence(
    input.finalizationEvidence,
    input.releaseVerificationKey,
    {
      expectedKind: "finalization",
      expectedTag: input.expectedRcTag,
      expectedRevision: input.expectedRevision,
      expectedImageDigest: input.expectedImageDigest,
      now: input.now,
    },
  );
  if (payload.candidate.version !== input.expectedVersion) {
    throw new Error("finalization evidence version does not match");
  }
  const finalBrowser = payload.gates.find(
    ({ name }) => name === "final_custom_domain_browser",
  );
  if (!finalBrowser) {
    throw new Error("finalization evidence has no final browser gate");
  }
  const metadata = validateSemanticRankingProtectedBaselineMetadataV1({
    schemaVersion: SEMANTIC_RANKING_PROTECTED_BASELINE_SCHEMA_V1,
    rcTag: payload.candidate.tag,
    stableTag: `v${payload.candidate.version}`,
    version: payload.candidate.version,
    sourceRevision: payload.candidate.sourceRevision,
    imageDigest: payload.candidate.imageDigest,
    imageReference: payload.stagingControls.candidateImageReference,
    finalizationEvidencePayloadHash: sha256Digest(
      envelope.payloadHash,
      "finalization evidence payload hash",
    ),
    finalBrowserGateEvidenceHash: finalBrowser.evidenceHash,
    fixtures: payload.semanticReview.fixtures.map((fixture) => ({
      ...fixture,
    })),
  });
  const reparsed = validateSemanticRankingProtectedBaselineMetadataV1(
    JSON.parse(stableSignedArtifactJson(metadata)),
  );
  if (
    semanticRankingProtectedBaselineMetadataSha256(reparsed)
      !== semanticRankingProtectedBaselineMetadataSha256(metadata)
  ) {
    throw new Error("protected baseline metadata failed canonical verification");
  }
  return metadata;
}

function protectedTrustPolicies(
  environment: NodeJS.ProcessEnv = process.env,
): {
  gateProducer: ReturnType<typeof releaseGateProducerTrustPolicyV1>;
  sites: ReturnType<typeof sitesControlPlaneTrustPolicyV1>;
  staging: ReturnType<typeof stagingControlPlaneTrustPolicyV1>;
  receipts: {
    apple: ReturnType<typeof controlPlaneReceiptTrustPolicyV1>;
    provider: ReturnType<typeof controlPlaneReceiptTrustPolicyV1>;
    qaBudget: ReturnType<typeof controlPlaneReceiptTrustPolicyV1>;
  };
} {
  const id = (name: string, label: string): string =>
    protectedValue(name, KEY_ID, label, environment);
  const sha = (name: string, label: string): string =>
    protectedValue(name, SHA256, label, environment);
  return {
    gateProducer: releaseGateProducerTrustPolicyV1({
      approvedKeyId: id(
        "RELEASE_GATE_PRODUCER_KEY_ID",
        "release gate producer key ID",
      ),
      approvedKeySha256: sha(
        "RELEASE_GATE_PRODUCER_KEY_SHA256",
        "release gate producer key fingerprint",
      ),
    }),
    sites: sitesControlPlaneTrustPolicyV1({
      approvedKeyId: id(
        "RELEASE_SITES_CONTROL_PLANE_KEY_ID",
        "Sites control-plane key ID",
      ),
      approvedKeySha256: sha(
        "RELEASE_SITES_CONTROL_PLANE_KEY_SHA256",
        "Sites control-plane key fingerprint",
      ),
    }),
    staging: stagingControlPlaneTrustPolicyV1({
      approvedKeyId: id(
        "RELEASE_STAGING_CONTROL_PLANE_KEY_ID",
        "staging control-plane key ID",
      ),
      approvedKeySha256: sha(
        "RELEASE_STAGING_CONTROL_PLANE_KEY_SHA256",
        "staging control-plane key fingerprint",
      ),
    }),
    receipts: {
      apple: controlPlaneReceiptTrustPolicyV1({
        receiptKind: "apple",
        approvedIssuer: id(
          "RELEASE_APPLE_CONTROL_PLANE_ISSUER",
          "Apple control-plane issuer",
        ),
        approvedKeyId: id(
          "RELEASE_APPLE_CONTROL_PLANE_KEY_ID",
          "Apple control-plane key ID",
        ),
        approvedKeySha256: sha(
          "RELEASE_APPLE_CONTROL_PLANE_KEY_SHA256",
          "Apple control-plane key fingerprint",
        ),
      }),
      provider: controlPlaneReceiptTrustPolicyV1({
        receiptKind: "provider",
        approvedIssuer: id(
          "RELEASE_PROVIDER_CONTROL_PLANE_ISSUER",
          "provider control-plane issuer",
        ),
        approvedKeyId: id(
          "RELEASE_PROVIDER_CONTROL_PLANE_KEY_ID",
          "provider control-plane key ID",
        ),
        approvedKeySha256: sha(
          "RELEASE_PROVIDER_CONTROL_PLANE_KEY_SHA256",
          "provider control-plane key fingerprint",
        ),
      }),
      qaBudget: controlPlaneReceiptTrustPolicyV1({
        receiptKind: "qa_budget",
        approvedIssuer: id(
          "RELEASE_QA_BUDGET_LEDGER_ISSUER",
          "QA budget ledger issuer",
        ),
        approvedKeyId: id(
          "RELEASE_QA_BUDGET_LEDGER_KEY_ID",
          "QA budget ledger key ID",
        ),
        approvedKeySha256: sha(
          "RELEASE_QA_BUDGET_LEDGER_KEY_SHA256",
          "QA budget ledger key fingerprint",
        ),
      }),
    },
  };
}

async function createProtectedBaselineCommand(
  options: Record<string, string>,
): Promise<void> {
  const [finalizationEvidence, releaseVerificationKey] = await Promise.all([
    readBoundedJsonFile(
      options["--finalization-evidence"]!,
      "finalization evidence",
    ),
    readBoundedRegularFile(
      options["--release-verification-key"]!,
      "release verification key",
      16 * 1024,
    ),
  ]);
  const protectedKey = assertProtectedReleaseKey({
    signedEvidence: finalizationEvidence,
    verificationKey: releaseVerificationKey,
  });
  const metadata = createProtectedSemanticBaselineMetadataV1({
    finalizationEvidence,
    releaseVerificationKey,
    approvedReleaseKeyId: protectedKey.keyId,
    approvedReleaseKeySha256: protectedKey.keySha256,
    expectedRcTag: options["--expected-rc-tag"]!,
    expectedVersion: options["--expected-version"]!,
    expectedRevision: options["--expected-revision"]!.toLowerCase(),
    expectedImageDigest: options["--expected-image-digest"]!.toLowerCase(),
  });
  await writeCanonicalJsonCreateOnly(options["--output"]!, metadata);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "protected-baseline",
    metadataHash:
      semanticRankingProtectedBaselineMetadataSha256(metadata),
    output: options["--output"],
  })}\n`);
}

async function createFinalizationSourceCommand(
  options: Record<string, string>,
): Promise<void> {
  const manifestPath = options["--manifest"]!;
  const [
    manifest,
    finalizationEvidence,
    releaseVerificationKey,
    releaseGateProducerVerificationKey,
  ] = await Promise.all([
    readBoundedJsonFile(manifestPath, "finalization source manifest"),
    readBoundedJsonFile(
      options["--finalization-evidence"]!,
      "finalization evidence",
    ),
    readBoundedRegularFile(
      options["--release-verification-key"]!,
      "release verification key",
      16 * 1024,
    ),
    readBoundedRegularFile(
      options["--release-gate-producer-verification-key"]!,
      "release gate producer verification key",
      16 * 1024,
    ),
  ]);
  assertProtectedReleaseKey({
    signedEvidence: finalizationEvidence,
    verificationKey: releaseVerificationKey,
  });
  const bundle = await loadStableReleaseFinalizationSourceBundleV2(
    manifest,
    dirname(resolve(manifestPath)),
  );
  const trust = protectedTrustPolicies();
  const verified = verifyStableReleaseFinalizationSources({
    value: bundle,
    finalizationEvidence: verifyReleaseEvidence(
      finalizationEvidence,
      releaseVerificationKey,
      {
        expectedKind: "finalization",
        expectedTag: options["--expected-rc-tag"]!,
        expectedRevision: options["--expected-revision"]!.toLowerCase(),
        expectedImageDigest:
          options["--expected-image-digest"]!.toLowerCase(),
      },
    ),
    releaseVerificationKey,
    releaseGateProducerVerificationKey,
    approvedReleaseGateProducer: trust.gateProducer,
    approvedSitesControlPlane: trust.sites,
    approvedStagingControlPlane: trust.staging,
    approvedControlPlaneReceipts: trust.receipts,
    expectedTag: options["--expected-rc-tag"]!,
    expectedRevision: options["--expected-revision"]!.toLowerCase(),
    expectedImageDigest: options["--expected-image-digest"]!.toLowerCase(),
    now: new Date().toISOString(),
  });
  await writeCanonicalJsonCreateOnly(options["--output"]!, bundle);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "finalization-source",
    producerKeySha256: verified.producerKeySha256,
    sitesKeySha256: verified.sitesKeySha256,
    stagingControlPlaneKeySha256:
      verified.stagingControlPlaneKeySha256,
    expiresAt: verified.expiresAt,
    output: options["--output"],
  })}\n`);
}

export function parseReleaseArtifactAuthorArgs(
  argv: readonly string[],
): {
  command: "protected-baseline" | "finalization-source";
  options: Record<string, string>;
} {
  const [command, ...args] = argv;
  if (command === "protected-baseline") {
    return {
      command,
      options: parseCreateOnlyCliOptions(args, {
        required: [
          "--finalization-evidence",
          "--release-verification-key",
          "--expected-rc-tag",
          "--expected-version",
          "--expected-revision",
          "--expected-image-digest",
          "--output",
        ],
      }),
    };
  }
  if (command === "finalization-source") {
    return {
      command,
      options: parseCreateOnlyCliOptions(args, {
        required: [
          "--manifest",
          "--finalization-evidence",
          "--release-verification-key",
          "--release-gate-producer-verification-key",
          "--expected-rc-tag",
          "--expected-revision",
          "--expected-image-digest",
          "--output",
        ],
      }),
    };
  }
  throw new Error(
    "Usage: release-artifact-author "
    + "<protected-baseline|finalization-source> ...",
  );
}

export async function runReleaseArtifactAuthorCli(
  argv: readonly string[],
): Promise<void> {
  const parsed = parseReleaseArtifactAuthorArgs(argv);
  if (parsed.command === "protected-baseline") {
    await createProtectedBaselineCommand(parsed.options);
    return;
  }
  await createFinalizationSourceCommand(parsed.options);
}

async function main(): Promise<void> {
  await runReleaseArtifactAuthorCli(process.argv.slice(2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "release_artifact_authoring_failed",
      message: error instanceof Error ? error.message : "unknown error",
    })}\n`);
    process.exitCode = 1;
  });
}
