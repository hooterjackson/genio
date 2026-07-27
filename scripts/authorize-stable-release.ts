import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  createStrictSignedEnvelope,
  exactObject,
  sha256Digest,
  verifyStrictSignedEnvelope,
  type JsonRecord,
} from "../shared/signed-artifact.ts";
import {
  RELEASE_EVIDENCE_TTL_MS,
  verifyReleaseEvidence,
} from "./release-evidence.ts";
import {
  semanticRankingProtectedBaselineMetadataSha256,
  validateSemanticRankingProtectedBaselineMetadataV1,
} from "../lib/semantic-ranking-review.ts";

export const STABLE_RELEASE_AUTHORIZATION_SCHEMA_V1 =
  "genio-stable-release-authorization/v2";
export const SIGNED_STABLE_RELEASE_AUTHORIZATION_SCHEMA_V1 =
  "genio-signed-stable-release-authorization/v2";
export const STABLE_RELEASE_AUTHORIZATION_ISSUER_V1 =
  "genio-protected-stable-release-authorizer";

const CONFIRMATION_FLAG = "--confirm-stable-release-authorization";
const TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-rc\.[1-9]\d*$/u;
const SOURCE_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_REFERENCE =
  /^ghcr\.io\/[0-9a-z](?:[0-9a-z._/-]*[0-9a-z])?@sha256:[0-9a-f]{64}$/u;
const KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u;

export interface StableReleaseConsumerManifestV1 {
  schemaVersion: "genio-stable-release-consumer-manifest/v2";
  verifiedAt: string;
  candidate: {
    rcTag: string;
    stableTag: string;
    version: string;
    sourceRevision: string;
    imageDigest: string;
    imageReference: string;
  };
  finalizationEvidencePayloadHash: string;
  finalBrowserGateEvidenceHash: string;
  protectedBaselineMetadataHash: string;
  stableAuthorizationPayloadHash: string;
  releaseVerificationKeySha256: string;
  stableAuthorizerKeyId: string;
  stableAuthorizerKeySha256: string;
}

export interface StableReleaseVerificationKeyV1 {
  schemaVersion: "genio-stable-release-verification-key/v1";
  algorithm: "Ed25519";
  format: "spki-der";
  value: string;
  sha256: string;
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : "";
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function publicKey(value: string | Buffer | KeyObject): KeyObject {
  const parsed = value instanceof KeyObject ? value : createPublicKey(value);
  const key = parsed.type === "private" ? createPublicKey(parsed) : parsed;
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("stable release verification keys must be Ed25519");
  }
  return key;
}

function privateKey(value: string | Buffer | KeyObject): KeyObject {
  const key = value instanceof KeyObject ? value : createPrivateKey(value);
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("stable release authorizer key must be a private Ed25519 key");
  }
  return key;
}

export function stableReleaseKeyFingerprint(
  value: string | Buffer | KeyObject,
): string {
  return createHash("sha256")
    .update(publicKey(value).export({ format: "der", type: "spki" }))
    .digest("hex");
}

export function stableReleaseVerificationKeyV1(
  value: string | Buffer | KeyObject,
): StableReleaseVerificationKeyV1 {
  const key = publicKey(value);
  return {
    schemaVersion: "genio-stable-release-verification-key/v1",
    algorithm: "Ed25519",
    format: "spki-der",
    value: key.export({ format: "der", type: "spki" }).toString("base64url"),
    sha256: stableReleaseKeyFingerprint(key),
  };
}

export function validateStableReleaseVerificationKeyV1(
  value: unknown,
): {
  source: StableReleaseVerificationKeyV1;
  key: KeyObject;
} {
  const source = exactObject(value, [
    "schemaVersion",
    "algorithm",
    "format",
    "value",
    "sha256",
  ], "stable release verification key");
  if (
    source.schemaVersion
      !== "genio-stable-release-verification-key/v1"
    || source.algorithm !== "Ed25519"
    || source.format !== "spki-der"
    || typeof source.value !== "string"
    || !/^[0-9A-Za-z_-]{48,256}$/u.test(source.value)
    || typeof source.sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(source.sha256)
  ) {
    throw new Error("stable release verification key is invalid");
  }
  let key: KeyObject;
  try {
    key = publicKey(createPublicKey({
      key: Buffer.from(source.value, "base64url"),
      format: "der",
      type: "spki",
    }));
  } catch {
    throw new Error("stable release verification key is invalid");
  }
  if (
    source.sha256 !== stableReleaseKeyFingerprint(key)
    || source.value
      !== key.export({ format: "der", type: "spki" }).toString("base64url")
  ) {
    throw new Error("stable release verification key is invalid");
  }
  return {
    source: source as unknown as StableReleaseVerificationKeyV1,
    key,
  };
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function validateAuthorizationPayload(value: unknown): JsonRecord {
  const payload = exactObject(value, [
    "schemaVersion",
    "issuer",
    "generatedAt",
    "expiresAt",
    "action",
    "candidate",
    "finalizationEvidencePayloadHash",
    "finalBrowserGateEvidenceHash",
    "protectedBaselineMetadataHash",
  ], "stable release authorization");
  if (
    payload.schemaVersion !== STABLE_RELEASE_AUTHORIZATION_SCHEMA_V1
    || payload.issuer !== STABLE_RELEASE_AUTHORIZATION_ISSUER_V1
    || payload.action !== "create_stable_tag_and_github_release"
  ) {
    throw new Error("stable release authorization provenance is invalid");
  }
  const generatedAt = timestamp(
    payload.generatedAt,
    "stable release authorization generatedAt",
  );
  const expiresAt = timestamp(
    payload.expiresAt,
    "stable release authorization expiresAt",
  );
  if (
    Date.parse(expiresAt) <= Date.parse(generatedAt)
    || Date.parse(expiresAt) - Date.parse(generatedAt)
      > RELEASE_EVIDENCE_TTL_MS
  ) {
    throw new Error("stable release authorization must expire within 24 hours");
  }
  const candidate = exactObject(payload.candidate, [
    "rcTag",
    "stableTag",
    "version",
    "sourceRevision",
    "imageDigest",
  ], "stable release authorization candidate");
  const match = typeof candidate.rcTag === "string"
    ? TAG.exec(candidate.rcTag)
    : null;
  if (
    !match
    || candidate.version !== match[1]
    || candidate.stableTag !== `v${candidate.version}`
    || typeof candidate.sourceRevision !== "string"
    || !SOURCE_REVISION.test(candidate.sourceRevision)
    || typeof candidate.imageDigest !== "string"
    || !IMAGE_DIGEST.test(candidate.imageDigest)
  ) {
    throw new Error("stable release authorization candidate is invalid");
  }
  sha256Digest(
    payload.finalizationEvidencePayloadHash,
    "finalization evidence payload hash",
  );
  sha256Digest(
    payload.finalBrowserGateEvidenceHash,
    "final browser gate evidence hash",
  );
  sha256Digest(
    payload.protectedBaselineMetadataHash,
    "protected semantic baseline metadata hash",
  );
  return payload;
}

export function verifyStableReleaseAuthorization(input: {
  value: unknown;
  verificationKey: string | Buffer | KeyObject;
  approvedKeyId: string;
  approvedKeySha256: string;
  expectedRevision: string;
  expectedImageDigest: string;
  expectedRcTag: string;
  expectedFinalizationEvidencePayloadHash: string;
  expectedProtectedBaselineMetadataHash: string;
  now?: string;
}): JsonRecord {
  if (
    !KEY_ID.test(input.approvedKeyId)
    || sha256Digest(
      input.approvedKeySha256,
      "approved stable release authorizer key fingerprint",
    ) !== stableReleaseKeyFingerprint(input.verificationKey)
  ) {
    throw new Error(
      "stable release authorization does not use the protected approved key",
    );
  }
  const verified = verifyStrictSignedEnvelope({
    value: input.value,
    verificationKey: publicKey(input.verificationKey),
    envelopeSchemaVersion: SIGNED_STABLE_RELEASE_AUTHORIZATION_SCHEMA_V1,
    payloadLabel: "stable release authorization",
    validatePayload: validateAuthorizationPayload,
  });
  if (verified.keyId !== input.approvedKeyId) {
    throw new Error("stable release authorization key ID is not protected");
  }
  const candidate = verified.payload.candidate as JsonRecord;
  if (
    candidate.rcTag !== input.expectedRcTag
    || candidate.sourceRevision !== input.expectedRevision
    || candidate.imageDigest !== input.expectedImageDigest
    || verified.payload.finalizationEvidencePayloadHash
      !== input.expectedFinalizationEvidencePayloadHash
    || verified.payload.protectedBaselineMetadataHash
      !== input.expectedProtectedBaselineMetadataHash
  ) {
    throw new Error(
      "stable release authorization does not bind the exact finalized candidate",
    );
  }
  const now = Date.parse(
    input.now
      ? timestamp(input.now, "stable release authorization verification time")
      : new Date().toISOString(),
  );
  if (
    now < Date.parse(String(verified.payload.generatedAt)) - 5 * 60_000
    || now >= Date.parse(String(verified.payload.expiresAt))
  ) {
    throw new Error("stable release authorization is not currently valid");
  }
  return verified.payload;
}

export async function authorizeStableRelease(input: {
  finalizationEvidence: unknown;
  protectedBaselineMetadata: unknown;
  releaseVerificationKey: string | Buffer | KeyObject;
  approvedReleaseKeySha256: string;
  authorizerSigningKey: string | Buffer | KeyObject;
  approvedAuthorizerKeyId: string;
  approvedAuthorizerKeySha256: string;
  expectedRcTag: string;
  expectedVersion: string;
  expectedRevision: string;
  expectedImageDigest: string;
  generatedAt?: string;
}): Promise<ReturnType<typeof createStrictSignedEnvelope>> {
  if (
    sha256Digest(
      input.approvedReleaseKeySha256,
      "approved release evidence key fingerprint",
    ) !== stableReleaseKeyFingerprint(input.releaseVerificationKey)
  ) {
    throw new Error(
      "finalization evidence does not use the protected release key",
    );
  }
  if (
    !KEY_ID.test(input.approvedAuthorizerKeyId)
    || sha256Digest(
      input.approvedAuthorizerKeySha256,
      "approved stable authorizer key fingerprint",
    ) !== stableReleaseKeyFingerprint(input.authorizerSigningKey)
    || input.approvedAuthorizerKeySha256 === input.approvedReleaseKeySha256
  ) {
    throw new Error(
      "stable release authorizer must use its distinct protected key",
    );
  }
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const payload = verifyReleaseEvidence(
    input.finalizationEvidence,
    input.releaseVerificationKey,
    {
      expectedKind: "finalization",
      expectedTag: input.expectedRcTag,
      expectedRevision: input.expectedRevision,
      expectedImageDigest: input.expectedImageDigest,
      now: generatedAt,
    },
  );
  if (Date.parse(generatedAt) < Date.parse(payload.generatedAt)) {
    throw new Error(
      "stable release authorization cannot predate finalization evidence",
    );
  }
  if (payload.candidate.version !== input.expectedVersion) {
    throw new Error("finalization evidence version does not match the target");
  }
  const finalBrowser = payload.gates.find(
    ({ name }) => name === "final_custom_domain_browser",
  );
  if (!finalBrowser) {
    throw new Error("finalization evidence has no final browser attestation");
  }
  const envelope = exactObject(input.finalizationEvidence, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], "signed finalization evidence");
  const finalizationEvidencePayloadHash = sha256Digest(
    envelope.payloadHash,
    "finalization evidence payload hash",
  );
  const protectedBaselineMetadata =
    validateSemanticRankingProtectedBaselineMetadataV1(
      input.protectedBaselineMetadata,
    );
  const expectedImageReference =
    payload.stagingControls.candidateImageReference;
  if (
    protectedBaselineMetadata.rcTag !== input.expectedRcTag
    || protectedBaselineMetadata.stableTag
      !== `v${input.expectedVersion}`
    || protectedBaselineMetadata.version !== input.expectedVersion
    || protectedBaselineMetadata.sourceRevision !== input.expectedRevision
    || protectedBaselineMetadata.imageDigest !== input.expectedImageDigest
    || protectedBaselineMetadata.imageReference !== expectedImageReference
    || protectedBaselineMetadata.finalizationEvidencePayloadHash
      !== finalizationEvidencePayloadHash
    || protectedBaselineMetadata.finalBrowserGateEvidenceHash
      !== finalBrowser.evidenceHash
  ) {
    throw new Error(
      "protected semantic baseline metadata does not bind the exact finalized stable release",
    );
  }
  const protectedBaselineMetadataHash =
    semanticRankingProtectedBaselineMetadataSha256(
      protectedBaselineMetadata,
    );
  const expiresAt = new Date(Math.min(
    Date.parse(payload.expiresAt),
    Date.parse(generatedAt) + RELEASE_EVIDENCE_TTL_MS,
  )).toISOString();
  const authorization = createStrictSignedEnvelope({
    envelopeSchemaVersion: SIGNED_STABLE_RELEASE_AUTHORIZATION_SCHEMA_V1,
    payload: {
      schemaVersion: STABLE_RELEASE_AUTHORIZATION_SCHEMA_V1,
      issuer: STABLE_RELEASE_AUTHORIZATION_ISSUER_V1,
      generatedAt,
      expiresAt,
      action: "create_stable_tag_and_github_release",
      candidate: {
        rcTag: input.expectedRcTag,
        stableTag: `v${input.expectedVersion}`,
        version: input.expectedVersion,
        sourceRevision: input.expectedRevision,
        imageDigest: input.expectedImageDigest,
      },
      finalizationEvidencePayloadHash,
      finalBrowserGateEvidenceHash: finalBrowser.evidenceHash,
      protectedBaselineMetadataHash,
    },
    signingKey: privateKey(input.authorizerSigningKey),
    keyId: input.approvedAuthorizerKeyId,
  });
  verifyStableReleaseAuthorization({
    value: authorization,
    verificationKey: publicKey(input.authorizerSigningKey),
    approvedKeyId: input.approvedAuthorizerKeyId,
    approvedKeySha256: input.approvedAuthorizerKeySha256,
    expectedRevision: input.expectedRevision,
    expectedImageDigest: input.expectedImageDigest,
    expectedRcTag: input.expectedRcTag,
    expectedFinalizationEvidencePayloadHash:
      finalizationEvidencePayloadHash,
    expectedProtectedBaselineMetadataHash:
      protectedBaselineMetadataHash,
    now: generatedAt,
  });
  return authorization;
}

export function verifyStableReleaseConsumerBundle(input: {
  finalizationEvidence: unknown;
  protectedBaselineMetadata: unknown;
  releaseVerificationKey: string | Buffer | KeyObject;
  approvedReleaseKeySha256: string;
  stableAuthorization: unknown;
  stableAuthorizationVerificationKey: string | Buffer | KeyObject;
  approvedStableAuthorizerKeyId: string;
  approvedStableAuthorizerKeySha256: string;
  expectedRcTag: string;
  expectedVersion: string;
  expectedRevision: string;
  expectedImageDigest: string;
  expectedImageReference: string;
  now?: string;
}): StableReleaseConsumerManifestV1 {
  const verifiedAt = input.now
    ? timestamp(input.now, "stable release consumer verification time")
    : new Date().toISOString();
  const rcMatch = TAG.exec(input.expectedRcTag);
  if (
    !rcMatch
    || rcMatch[1] !== input.expectedVersion
    || !SOURCE_REVISION.test(input.expectedRevision)
    || !IMAGE_DIGEST.test(input.expectedImageDigest)
    || !IMAGE_REFERENCE.test(input.expectedImageReference)
    || !input.expectedImageReference.endsWith(
      `@${input.expectedImageDigest}`,
    )
  ) {
    throw new Error("stable release consumer target identity is invalid");
  }
  const protectedBaselineMetadata =
    validateSemanticRankingProtectedBaselineMetadataV1(
      input.protectedBaselineMetadata,
    );
  if (
    protectedBaselineMetadata.rcTag !== input.expectedRcTag
    || protectedBaselineMetadata.stableTag
      !== `v${input.expectedVersion}`
    || protectedBaselineMetadata.version !== input.expectedVersion
    || protectedBaselineMetadata.sourceRevision !== input.expectedRevision
    || protectedBaselineMetadata.imageDigest !== input.expectedImageDigest
    || protectedBaselineMetadata.imageReference
      !== input.expectedImageReference
  ) {
    throw new Error(
      "protected semantic baseline metadata does not bind the exact stable release target",
    );
  }
  const protectedBaselineMetadataHash =
    semanticRankingProtectedBaselineMetadataSha256(
      protectedBaselineMetadata,
    );
  const releaseKeySha256 = stableReleaseKeyFingerprint(
    input.releaseVerificationKey,
  );
  const stableKeySha256 = stableReleaseKeyFingerprint(
    input.stableAuthorizationVerificationKey,
  );
  if (
    sha256Digest(
      input.approvedReleaseKeySha256,
      "approved release verification key fingerprint",
    ) !== releaseKeySha256
    || sha256Digest(
      input.approvedStableAuthorizerKeySha256,
      "approved stable authorizer key fingerprint",
    ) !== stableKeySha256
    || releaseKeySha256 === stableKeySha256
  ) {
    throw new Error(
      "stable release consumer keys are unapproved or not independent",
    );
  }
  const finalization = verifyReleaseEvidence(
    input.finalizationEvidence,
    input.releaseVerificationKey,
    {
      expectedKind: "finalization",
      expectedTag: input.expectedRcTag,
      expectedRevision: input.expectedRevision,
      expectedImageDigest: input.expectedImageDigest,
      now: verifiedAt,
    },
  );
  if (
    Date.parse(verifiedAt) < Date.parse(finalization.generatedAt)
    || finalization.candidate.version !== input.expectedVersion
    || finalization.stagingControls.candidateImageReference
      !== input.expectedImageReference
    || finalization.stagingControls.controlPlanePhase !== "finalization"
    || finalization.environmentSnapshots.production?.scope !== "full"
    || finalization.environmentSnapshots.production.sitesCandidateMatched
      !== true
  ) {
    throw new Error(
      "finalization evidence does not bind the full post-Sites target",
    );
  }
  const finalizationEnvelope = exactObject(input.finalizationEvidence, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], "signed finalization evidence");
  const finalizationEvidencePayloadHash = sha256Digest(
    finalizationEnvelope.payloadHash,
    "finalization evidence payload hash",
  );
  const authorization = verifyStableReleaseAuthorization({
    value: input.stableAuthorization,
    verificationKey: input.stableAuthorizationVerificationKey,
    approvedKeyId: input.approvedStableAuthorizerKeyId,
    approvedKeySha256: input.approvedStableAuthorizerKeySha256,
    expectedRevision: input.expectedRevision,
    expectedImageDigest: input.expectedImageDigest,
    expectedRcTag: input.expectedRcTag,
    expectedFinalizationEvidencePayloadHash:
      finalizationEvidencePayloadHash,
    expectedProtectedBaselineMetadataHash:
      protectedBaselineMetadataHash,
    now: verifiedAt,
  });
  const authorizationCandidate = authorization.candidate as JsonRecord;
  const finalBrowser = finalization.gates.find(
    ({ name }) => name === "final_custom_domain_browser",
  );
  if (
    !finalBrowser
    || authorization.finalBrowserGateEvidenceHash
      !== finalBrowser.evidenceHash
    || protectedBaselineMetadata.finalizationEvidencePayloadHash
      !== finalizationEvidencePayloadHash
    || protectedBaselineMetadata.finalBrowserGateEvidenceHash
      !== finalBrowser.evidenceHash
    || authorizationCandidate.version !== input.expectedVersion
    || authorizationCandidate.stableTag !== `v${input.expectedVersion}`
  ) {
    throw new Error(
      "stable authorization does not bind the exact final browser evidence",
    );
  }
  const authorizationEnvelope = exactObject(input.stableAuthorization, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], "signed stable release authorization");
  return {
    schemaVersion: "genio-stable-release-consumer-manifest/v2",
    verifiedAt,
    candidate: {
      rcTag: input.expectedRcTag,
      stableTag: `v${input.expectedVersion}`,
      version: input.expectedVersion,
      sourceRevision: input.expectedRevision,
      imageDigest: input.expectedImageDigest,
      imageReference: input.expectedImageReference,
    },
    finalizationEvidencePayloadHash,
    finalBrowserGateEvidenceHash: finalBrowser.evidenceHash,
    protectedBaselineMetadataHash,
    stableAuthorizationPayloadHash: sha256Digest(
      authorizationEnvelope.payloadHash,
      "stable authorization payload hash",
    ),
    releaseVerificationKeySha256: releaseKeySha256,
    stableAuthorizerKeyId: input.approvedStableAuthorizerKeyId,
    stableAuthorizerKeySha256: stableKeySha256,
  };
}

/**
 * Revalidates an immutable past stable release at the signed authorization
 * issuance time. Release evidence and authorization may be expired today, but
 * both must have been valid and overlapping when the protected stable
 * authorizer approved the release. Future-dated lineage still fails closed.
 */
export function verifyHistoricalStableReleaseConsumerBundle(
  input: Omit<
    Parameters<typeof verifyStableReleaseConsumerBundle>[0],
    "now"
  > & { now?: string },
): StableReleaseConsumerManifestV1 {
  const authorizationEnvelope = exactObject(input.stableAuthorization, [
    "schemaVersion",
    "payload",
    "payloadHash",
    "signature",
  ], "signed stable release authorization");
  const authorizationPayload = validateAuthorizationPayload(
    authorizationEnvelope.payload,
  );
  const issuedAt = timestamp(
    authorizationPayload.generatedAt,
    "historical stable release authorization generatedAt",
  );
  const currentTime = input.now
    ? timestamp(input.now, "historical stable release verification time")
    : new Date().toISOString();
  if (Date.parse(currentTime) < Date.parse(issuedAt)) {
    throw new Error("historical stable release lineage is future-dated");
  }
  return verifyStableReleaseConsumerBundle({
    ...input,
    now: issuedAt,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.filter((value) => value === CONFIRMATION_FLAG).length !== 1) {
    throw new Error(
      `stable release authorization requires ${CONFIRMATION_FLAG}`,
    );
  }
  const allowed = new Set([
    CONFIRMATION_FLAG,
    "--finalization-evidence",
    "--protected-baseline-metadata",
    "--release-verification-key",
    "--authorizer-signing-key",
    "--output",
    "--expected-rc-tag",
    "--expected-version",
    "--expected-revision",
    "--expected-image-digest",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!allowed.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    if (argument !== CONFIRMATION_FLAG) index += 1;
  }
  const [
    finalizationEvidenceSource,
    protectedBaselineMetadataSource,
    releaseVerificationKey,
    authorizerSigningKey,
  ] = await Promise.all([
    readFile(option(args, "--finalization-evidence"), "utf8"),
    readFile(option(args, "--protected-baseline-metadata"), "utf8"),
    readFile(option(args, "--release-verification-key")),
    readFile(option(args, "--authorizer-signing-key")),
  ]);
  const authorization = await authorizeStableRelease({
    finalizationEvidence: JSON.parse(finalizationEvidenceSource),
    protectedBaselineMetadata:
      JSON.parse(protectedBaselineMetadataSource),
    releaseVerificationKey,
    approvedReleaseKeySha256:
      process.env.RELEASE_VERIFICATION_KEY_SHA256?.trim().toLowerCase() ?? "",
    authorizerSigningKey,
    approvedAuthorizerKeyId:
      process.env.RELEASE_STABLE_AUTHORIZER_KEY_ID?.trim() ?? "",
    approvedAuthorizerKeySha256:
      process.env.RELEASE_STABLE_AUTHORIZER_KEY_SHA256
        ?.trim()
        .toLowerCase() ?? "",
    expectedRcTag: option(args, "--expected-rc-tag"),
    expectedVersion: option(args, "--expected-version"),
    expectedRevision: option(args, "--expected-revision").toLowerCase(),
    expectedImageDigest: option(args, "--expected-image-digest").toLowerCase(),
  });
  const output = option(args, "--output");
  await writeFile(output, `${JSON.stringify(authorization, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    stableTag:
      (authorization.payload.candidate as JsonRecord).stableTag,
    finalizationEvidencePayloadHash:
      authorization.payload.finalizationEvidencePayloadHash,
    output,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "stable_release_authorization_failed",
      message: error instanceof Error
        ? error.message
        : "Stable release authorization failed",
    })}\n`);
    process.exitCode = 1;
  });
}
