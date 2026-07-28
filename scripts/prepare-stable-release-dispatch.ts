import {
  type KeyObject,
} from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  validateSemanticRankingProtectedBaselineMetadataV1,
} from "../lib/semantic-ranking-review.ts";
import {
  exactObject,
} from "../shared/signed-artifact.ts";
import {
  verifyStableReleaseConsumerBundle,
} from "./authorize-stable-release.ts";
import {
  canonicalJsonBytes,
  protectedPath,
  readBoundedJsonFile,
  readBoundedRegularFile,
  requiredProtectedEnvironment,
  writeCanonicalJsonCreateOnly,
} from "./release-authoring-io.ts";

export const STABLE_RELEASE_DISPATCH_EVENT = "genio-stable-release";
export const GITHUB_CLIENT_PAYLOAD_MAX_BYTES = 64 * 1024;
export const GITHUB_CLIENT_PAYLOAD_MAX_TOP_LEVEL_KEYS = 10;

const CONFIRMATION_FLAG = "--confirm-stable-release-dispatch";
const RC_TAG =
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-rc\.[1-9]\d*$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : "";
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function buildStableReleaseDispatchRequest(input: {
  candidateTag: string;
  imageDigest: string;
  finalizationEvidence: Buffer;
  protectedBaselineMetadata: Buffer;
  stableAuthorization: Buffer;
}): {
  event_type: typeof STABLE_RELEASE_DISPATCH_EVENT;
  client_payload: {
    candidate_tag: string;
    image_digest: string;
    finalization_evidence_b64url: string;
    protected_baseline_metadata_b64url: string;
    stable_authorization_b64url: string;
  };
} {
  if (!RC_TAG.test(input.candidateTag)) {
    throw new Error("stable release dispatch candidate tag is invalid");
  }
  if (!IMAGE_DIGEST.test(input.imageDigest)) {
    throw new Error("stable release dispatch image digest is invalid");
  }
  for (const [label, value] of [
    ["finalization evidence", input.finalizationEvidence],
    ["protected baseline metadata", input.protectedBaselineMetadata],
    ["stable authorization", input.stableAuthorization],
  ] as const) {
    if (value.length === 0) throw new Error(`${label} is empty`);
    try {
      const parsed: unknown = JSON.parse(value.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
    } catch {
      throw new Error(`${label} must be a JSON object`);
    }
  }
  const clientPayload = {
    candidate_tag: input.candidateTag,
    image_digest: input.imageDigest,
    finalization_evidence_b64url:
      input.finalizationEvidence.toString("base64url"),
    protected_baseline_metadata_b64url:
      input.protectedBaselineMetadata.toString("base64url"),
    stable_authorization_b64url:
      input.stableAuthorization.toString("base64url"),
  };
  const keys = Object.keys(clientPayload);
  const payloadBytes = Buffer.byteLength(
    JSON.stringify(clientPayload),
    "utf8",
  );
  if (
    keys.length > GITHUB_CLIENT_PAYLOAD_MAX_TOP_LEVEL_KEYS
    || payloadBytes >= GITHUB_CLIENT_PAYLOAD_MAX_BYTES
  ) {
    throw new Error(
      `stable release client_payload is ${payloadBytes} bytes across `
      + `${keys.length} keys; GitHub requires fewer than `
      + `${GITHUB_CLIENT_PAYLOAD_MAX_BYTES} bytes and at most `
      + `${GITHUB_CLIENT_PAYLOAD_MAX_TOP_LEVEL_KEYS} keys`,
    );
  }
  return {
    event_type: STABLE_RELEASE_DISPATCH_EVENT,
    client_payload: clientPayload,
  };
}

export function parseStableReleaseDispatchArgs(args: readonly string[]): {
  candidateTag: string;
  imageDigest: string;
  finalizationEvidencePath: string;
  protectedBaselineMetadataPath: string;
  stableAuthorizationPath: string;
  releaseVerificationKeyPath?: string;
  stableAuthorizationVerificationKeyPath?: string;
  outputPath: string;
} {
  if (args.filter((value) => value === CONFIRMATION_FLAG).length !== 1) {
    throw new Error(
      `stable release dispatch preparation requires ${CONFIRMATION_FLAG}`,
    );
  }
  const allowed = new Set([
    CONFIRMATION_FLAG,
    "--candidate-tag",
    "--image-digest",
    "--finalization-evidence",
    "--protected-baseline-metadata",
    "--stable-authorization",
    "--release-verification-key",
    "--stable-authorization-verification-key",
    "--output",
  ]);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!allowed.has(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (seen.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    seen.add(argument);
    if (argument !== CONFIRMATION_FLAG) index += 1;
  }
  return {
    candidateTag: option(args, "--candidate-tag"),
    imageDigest: option(args, "--image-digest").toLowerCase(),
    finalizationEvidencePath: option(args, "--finalization-evidence"),
    protectedBaselineMetadataPath:
      option(args, "--protected-baseline-metadata"),
    stableAuthorizationPath: option(args, "--stable-authorization"),
    releaseVerificationKeyPath: seen.has("--release-verification-key")
      ? option(args, "--release-verification-key")
      : undefined,
    stableAuthorizationVerificationKeyPath:
      seen.has("--stable-authorization-verification-key")
        ? option(args, "--stable-authorization-verification-key")
        : undefined,
    outputPath: option(args, "--output"),
  };
}

export function verifyStableReleaseDispatchArtifacts(input: {
  candidateTag: string;
  imageDigest: string;
  finalizationEvidence: unknown;
  protectedBaselineMetadata: unknown;
  stableAuthorization: unknown;
  releaseVerificationKey: string | Buffer | KeyObject;
  approvedReleaseKeyId: string;
  approvedReleaseKeySha256: string;
  stableAuthorizationVerificationKey: string | Buffer | KeyObject;
  approvedStableAuthorizerKeyId: string;
  approvedStableAuthorizerKeySha256: string;
  now?: string;
}): ReturnType<typeof verifyStableReleaseConsumerBundle> {
  const metadata = validateSemanticRankingProtectedBaselineMetadataV1(
    input.protectedBaselineMetadata,
  );
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
  ], "signed finalization evidence.signature");
  if (
    !KEY_ID.test(input.approvedReleaseKeyId)
    || signature.keyId !== input.approvedReleaseKeyId
  ) {
    throw new Error(
      "finalization evidence key ID is not the protected release key",
    );
  }
  return verifyStableReleaseConsumerBundle({
    finalizationEvidence: input.finalizationEvidence,
    protectedBaselineMetadata: metadata,
    releaseVerificationKey: input.releaseVerificationKey,
    approvedReleaseKeySha256: input.approvedReleaseKeySha256,
    stableAuthorization: input.stableAuthorization,
    stableAuthorizationVerificationKey:
      input.stableAuthorizationVerificationKey,
    approvedStableAuthorizerKeyId:
      input.approvedStableAuthorizerKeyId,
    approvedStableAuthorizerKeySha256:
      input.approvedStableAuthorizerKeySha256,
    expectedRcTag: input.candidateTag,
    expectedVersion: metadata.version,
    expectedRevision: metadata.sourceRevision,
    expectedImageDigest: input.imageDigest,
    expectedImageReference: metadata.imageReference,
    now: input.now,
  });
}

async function main(): Promise<void> {
  const args = parseStableReleaseDispatchArgs(process.argv.slice(2));
  const [
    finalizationEvidence,
    protectedBaselineMetadata,
    stableAuthorization,
    releaseVerificationKey,
    stableAuthorizationVerificationKey,
  ] = await Promise.all([
    readBoundedJsonFile(
      args.finalizationEvidencePath,
      "finalization evidence",
    ),
    readBoundedJsonFile(
      args.protectedBaselineMetadataPath,
      "protected baseline metadata",
    ),
    readBoundedJsonFile(
      args.stableAuthorizationPath,
      "stable authorization",
    ),
    readBoundedRegularFile(
      protectedPath({
        cliPath: args.releaseVerificationKeyPath,
        environmentName: "RELEASE_VERIFICATION_PUBLIC_KEY_FILE",
        label: "release verification key",
      }),
      "release verification key",
      16 * 1024,
    ),
    readBoundedRegularFile(
      protectedPath({
        cliPath: args.stableAuthorizationVerificationKeyPath,
        environmentName:
          "RELEASE_STABLE_AUTHORIZER_PUBLIC_KEY_FILE",
        label: "stable authorizer verification key",
      }),
      "stable authorizer verification key",
      16 * 1024,
    ),
  ]);
  const approvedReleaseKeyId = requiredProtectedEnvironment(
    "RELEASE_VERIFICATION_KEY_ID",
    KEY_ID,
    "release verification key ID",
  );
  const approvedReleaseKeySha256 = requiredProtectedEnvironment(
    "RELEASE_VERIFICATION_KEY_SHA256",
    SHA256,
    "release verification key fingerprint",
  );
  const approvedStableAuthorizerKeyId = requiredProtectedEnvironment(
    "RELEASE_STABLE_AUTHORIZER_KEY_ID",
    KEY_ID,
    "stable authorizer key ID",
  );
  const approvedStableAuthorizerKeySha256 = requiredProtectedEnvironment(
    "RELEASE_STABLE_AUTHORIZER_KEY_SHA256",
    SHA256,
    "stable authorizer key fingerprint",
  );
  verifyStableReleaseDispatchArtifacts({
    candidateTag: args.candidateTag,
    imageDigest: args.imageDigest,
    finalizationEvidence,
    protectedBaselineMetadata,
    stableAuthorization,
    releaseVerificationKey,
    approvedReleaseKeyId,
    approvedReleaseKeySha256,
    stableAuthorizationVerificationKey,
    approvedStableAuthorizerKeyId,
    approvedStableAuthorizerKeySha256,
    now: new Date().toISOString(),
  });
  const request = buildStableReleaseDispatchRequest({
    candidateTag: args.candidateTag,
    imageDigest: args.imageDigest,
    finalizationEvidence: canonicalJsonBytes(finalizationEvidence),
    protectedBaselineMetadata:
      canonicalJsonBytes(protectedBaselineMetadata),
    stableAuthorization: canonicalJsonBytes(stableAuthorization),
  });
  const verified = buildStableReleaseDispatchRequest({
    candidateTag: request.client_payload.candidate_tag,
    imageDigest: request.client_payload.image_digest,
    finalizationEvidence: Buffer.from(
      request.client_payload.finalization_evidence_b64url,
      "base64url",
    ),
    protectedBaselineMetadata: Buffer.from(
      request.client_payload.protected_baseline_metadata_b64url,
      "base64url",
    ),
    stableAuthorization: Buffer.from(
      request.client_payload.stable_authorization_b64url,
      "base64url",
    ),
  });
  if (JSON.stringify(request) !== JSON.stringify(verified)) {
    throw new Error("stable release dispatch failed canonical round-trip");
  }
  await writeCanonicalJsonCreateOnly(args.outputPath, request);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    eventType: request.event_type,
    clientPayloadBytes: Buffer.byteLength(
      JSON.stringify(request.client_payload),
      "utf8",
    ),
    clientPayloadKeys: Object.keys(request.client_payload).length,
    output: args.outputPath,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "stable_release_dispatch_preparation_failed",
      message: error instanceof Error
        ? error.message
        : "Stable release dispatch preparation failed",
    })}\n`);
    process.exitCode = 1;
  });
}
