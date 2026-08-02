import {
  createHash,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  createSignedNativeSchema20RolloutPromotionAuthorityV1,
  verifyNativeSchema20RolloutPromotionAuthorityV1,
  type NativeSchema20RolloutPromotionAuthorityPayloadV1,
} from "../shared/native-schema20-rollout-promotion-authority.ts";
import { RELEASE_EVIDENCE_TTL_MS } from "../shared/release-evidence-constants.ts";
import { signedArtifactSha256 } from "../shared/signed-artifact.ts";
import {
  validateNativeSchema20PromotionReceipt,
} from "./finalize-native-schema20-release.ts";

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const RC_TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-rc\.[1-9]\d*$/u;
const SAFE_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{0,255}$/u;

export interface NativePromotionAuthorityProducerArgsV1 {
  promotionReceiptPath: string;
  candidateTag: string;
  expectedSourceRevision: string;
  expectedVersion: string;
  expectedImageDigest: string;
  priorSites: {
    projectId: string;
    versionId: string;
    deploymentId: string;
    version: string;
    sourceRevision: string;
    controlPlaneEvidenceHash: string;
  };
  signingKeyPath: string;
  keyId: string;
  expectedKeySha256: string;
  outputPath: string;
}

function option(argv: readonly string[], name: string): string {
  const positions = argv.flatMap((value, index) => value === name ? [index] : []);
  if (positions.length !== 1) throw new Error(`${name} must be provided exactly once`);
  const value = argv[positions[0]! + 1]?.trim() ?? "";
  if (!value || value.startsWith("--") || value.includes("\0")) {
    throw new Error(`${name} requires a safe value`);
  }
  return value;
}

export function parseNativePromotionAuthorityProducerArgsV1(
  argv: readonly string[],
): NativePromotionAuthorityProducerArgsV1 {
  const names = new Set([
    "--promotion-receipt", "--candidate-tag", "--prior-sites-project-id",
    "--expected-source-revision", "--expected-version",
    "--expected-image-digest",
    "--prior-sites-version-id", "--prior-sites-deployment-id",
    "--prior-sites-version", "--prior-sites-revision",
    "--prior-sites-control-plane-evidence-hash", "--signing-key", "--key-id",
    "--expected-key-sha256", "--output",
  ]);
  if (argv.length !== names.size * 2) {
    throw new Error("native promotion authority producer arguments are incomplete");
  }
  for (let index = 0; index < argv.length; index += 2) {
    if (!names.has(argv[index] ?? "")) {
      throw new Error(`unsupported native promotion authority argument: ${argv[index] ?? "missing"}`);
    }
  }
  const candidateTag = option(argv, "--candidate-tag");
  const tag = RC_TAG.exec(candidateTag);
  if (!tag) throw new Error("--candidate-tag is invalid");
  const expectedSourceRevision = option(
    argv,
    "--expected-source-revision",
  ).toLowerCase();
  const expectedVersion = option(argv, "--expected-version");
  const expectedImageDigest = option(argv, "--expected-image-digest")
    .toLowerCase();
  if (
    !SHA1.test(expectedSourceRevision)
    || !VERSION.test(expectedVersion)
    || !/^sha256:[0-9a-f]{64}$/u.test(expectedImageDigest)
    || tag[1] !== expectedVersion
  ) throw new Error("expected candidate identity is invalid");
  const priorSites = {
    projectId: option(argv, "--prior-sites-project-id"),
    versionId: option(argv, "--prior-sites-version-id"),
    deploymentId: option(argv, "--prior-sites-deployment-id"),
    version: option(argv, "--prior-sites-version"),
    sourceRevision: option(argv, "--prior-sites-revision").toLowerCase(),
    controlPlaneEvidenceHash: option(
      argv,
      "--prior-sites-control-plane-evidence-hash",
    ).toLowerCase(),
  };
  if (
    !SAFE_ID.test(priorSites.projectId)
    || !SAFE_ID.test(priorSites.versionId)
    || !SAFE_ID.test(priorSites.deploymentId)
    || !VERSION.test(priorSites.version)
    || !SHA1.test(priorSites.sourceRevision)
    || !SHA256.test(priorSites.controlPlaneEvidenceHash)
  ) throw new Error("prior Sites identity is invalid");
  const keyId = option(argv, "--key-id");
  const expectedKeySha256 = option(argv, "--expected-key-sha256").toLowerCase();
  if (!SAFE_ID.test(keyId) || !SHA256.test(expectedKeySha256)) {
    throw new Error("protected release signing policy is invalid");
  }
  return {
    promotionReceiptPath: option(argv, "--promotion-receipt"),
    candidateTag,
    expectedSourceRevision,
    expectedVersion,
    expectedImageDigest,
    priorSites,
    signingKeyPath: option(argv, "--signing-key"),
    keyId,
    expectedKeySha256,
    outputPath: option(argv, "--output"),
  };
}

async function requireAbsent(path: string): Promise<void> {
  try {
    await access(path);
    throw new Error("native promotion authority output already exists");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function produceNativeSchema20RolloutPromotionAuthorityV1(
  args: NativePromotionAuthorityProducerArgsV1,
  now = new Date(),
) {
  await requireAbsent(args.outputPath);
  let promotionValue: unknown;
  let signingKeyBytes: Buffer;
  try {
    [promotionValue, signingKeyBytes] = await Promise.all([
      readFile(args.promotionReceiptPath, "utf8").then(JSON.parse),
      readFile(args.signingKeyPath),
    ]);
  } catch {
    throw new Error("native promotion authority inputs are not readable");
  }
  const privateKey = createPrivateKey(signingKeyBytes);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("native promotion authority requires an Ed25519 signing key");
  }
  const publicKey = createPublicKey(privateKey);
  const keySha256 = createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
  if (keySha256 !== args.expectedKeySha256) {
    throw new Error("native promotion authority signing key is not the protected release key");
  }
  const promotion = validateNativeSchema20PromotionReceipt(promotionValue, {
    sourceRevision: args.expectedSourceRevision,
    version: args.expectedVersion,
  });
  const tag = RC_TAG.exec(args.candidateTag);
  if (
    !tag
    || tag[1] !== promotion.version
    || promotion.imageDigest !== args.expectedImageDigest
  ) {
    throw new Error("candidate tag does not match the promoted release");
  }
  const generatedAt = now.toISOString();
  if (!Number.isFinite(now.getTime()) || generatedAt !== now.toISOString()) {
    throw new Error("native promotion authority time is invalid");
  }
  if (Date.parse(generatedAt) < Date.parse(promotion.completedAt)) {
    throw new Error("native promotion authority cannot predate promotion");
  }
  const payload: NativeSchema20RolloutPromotionAuthorityPayloadV1 = {
    schemaVersion: "genio-native-schema20-rollout-promotion-authority/v1",
    generatedAt,
    expiresAt: new Date(now.getTime() + RELEASE_EVIDENCE_TTL_MS).toISOString(),
    environment: "production",
    candidate: {
      tag: args.candidateTag,
      version: promotion.version,
      sourceRevision: promotion.sourceRevision,
      imageReference: promotion.imageReference,
      imageDigest: promotion.imageDigest,
    },
    nativePromotion: {
      receiptHash: promotion.receiptHash,
      completedAt: promotion.completedAt,
    },
    promotion: {
      configurationHash: promotion.semanticExecutionConfigurationHash,
      runtimeHash: promotion.backendConvergenceEvidenceHash,
      semanticBehaviorHash: promotion.semanticBehaviorManifestHash,
      backendConvergenceEvidenceHash: promotion.backendConvergenceEvidenceHash,
      backendConvergenceCompletedAt: promotion.completedAt,
    },
    sites: {
      ...args.priorSites,
      candidateMatched: false,
    },
  };
  const signed = createSignedNativeSchema20RolloutPromotionAuthorityV1({
    payload,
    signingKey: privateKey,
    keyId: args.keyId,
  });
  verifyNativeSchema20RolloutPromotionAuthorityV1(signed, publicKey, {
    keyId: args.keyId,
    keySha256,
    candidate: payload.candidate,
    nativePromotion: payload.nativePromotion,
    promotion: payload.promotion,
    sites: args.priorSites,
    now: generatedAt,
  });
  await writeFile(args.outputPath, `${JSON.stringify(signed, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return Object.freeze({
    signed,
    payloadHash: signed.payloadHash,
    promotionReceiptHash: promotion.receiptHash,
    artifactHash: signedArtifactSha256(signed),
  });
}

async function main(): Promise<void> {
  const args = parseNativePromotionAuthorityProducerArgsV1(
    process.argv.slice(2),
  );
  const result = await produceNativeSchema20RolloutPromotionAuthorityV1(args);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    payloadHash: result.payloadHash,
    promotionReceiptHash: result.promotionReceiptHash,
    artifactHash: result.artifactHash,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "native_promotion_authority_failed_closed",
      message: "Native promotion authority production failed closed",
    })}\n`);
    process.exitCode = 1;
  });
}
