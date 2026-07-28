import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  verifyStableReleaseConsumerBundle,
} from "./authorize-stable-release.ts";

const CONFIRMATION_FLAG = "--confirm-stable-release-consumption";

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : "";
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseStableReleaseVerificationArgs(
  args: readonly string[],
): {
  finalizationEvidencePath: string;
  protectedBaselineMetadataPath: string;
  releaseVerificationKeyPath: string;
  stableAuthorizationPath: string;
  stableAuthorizationVerificationKeyPath: string;
  outputPath: string;
  expectedRcTag: string;
  expectedVersion: string;
  expectedRevision: string;
  expectedImageDigest: string;
  expectedImageReference: string;
} {
  if (args.filter((value) => value === CONFIRMATION_FLAG).length !== 1) {
    throw new Error(
      `stable release verification requires ${CONFIRMATION_FLAG}`,
    );
  }
  const allowed = new Set([
    CONFIRMATION_FLAG,
    "--finalization-evidence",
    "--protected-baseline-metadata",
    "--release-verification-key",
    "--stable-authorization",
    "--stable-authorization-verification-key",
    "--output",
    "--expected-rc-tag",
    "--expected-version",
    "--expected-revision",
    "--expected-image-digest",
    "--expected-image-reference",
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
    finalizationEvidencePath: option(args, "--finalization-evidence"),
    protectedBaselineMetadataPath:
      option(args, "--protected-baseline-metadata"),
    releaseVerificationKeyPath:
      option(args, "--release-verification-key"),
    stableAuthorizationPath: option(args, "--stable-authorization"),
    stableAuthorizationVerificationKeyPath:
      option(args, "--stable-authorization-verification-key"),
    outputPath: option(args, "--output"),
    expectedRcTag: option(args, "--expected-rc-tag"),
    expectedVersion: option(args, "--expected-version"),
    expectedRevision: option(args, "--expected-revision").toLowerCase(),
    expectedImageDigest:
      option(args, "--expected-image-digest").toLowerCase(),
    expectedImageReference:
      option(args, "--expected-image-reference").toLowerCase(),
  };
}

async function main(): Promise<void> {
  const args = parseStableReleaseVerificationArgs(process.argv.slice(2));
  const [
    finalizationEvidence,
    protectedBaselineMetadata,
    releaseVerificationKey,
    stableAuthorization,
    stableAuthorizationVerificationKey,
  ] = await Promise.all([
    readFile(args.finalizationEvidencePath, "utf8"),
    readFile(args.protectedBaselineMetadataPath, "utf8"),
    readFile(args.releaseVerificationKeyPath),
    readFile(args.stableAuthorizationPath, "utf8"),
    readFile(args.stableAuthorizationVerificationKeyPath),
  ]);
  const manifest = verifyStableReleaseConsumerBundle({
    finalizationEvidence: JSON.parse(finalizationEvidence),
    protectedBaselineMetadata: JSON.parse(protectedBaselineMetadata),
    releaseVerificationKey,
    approvedReleaseKeySha256:
      process.env.RELEASE_VERIFICATION_KEY_SHA256?.trim().toLowerCase() ?? "",
    stableAuthorization: JSON.parse(stableAuthorization),
    stableAuthorizationVerificationKey,
    approvedStableAuthorizerKeyId:
      process.env.RELEASE_STABLE_AUTHORIZER_KEY_ID?.trim() ?? "",
    approvedStableAuthorizerKeySha256:
      process.env.RELEASE_STABLE_AUTHORIZER_KEY_SHA256
        ?.trim()
        .toLowerCase() ?? "",
    expectedRcTag: args.expectedRcTag,
    expectedVersion: args.expectedVersion,
    expectedRevision: args.expectedRevision,
    expectedImageDigest: args.expectedImageDigest,
    expectedImageReference: args.expectedImageReference,
  });
  await writeFile(
    args.outputPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    stableTag: manifest.candidate.stableTag,
    sourceRevision: manifest.candidate.sourceRevision,
    imageDigest: manifest.candidate.imageDigest,
    finalizationEvidencePayloadHash:
      manifest.finalizationEvidencePayloadHash,
    stableAuthorizationPayloadHash:
      manifest.stableAuthorizationPayloadHash,
    protectedBaselineMetadataHash:
      manifest.protectedBaselineMetadataHash,
    output: args.outputPath,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "stable_release_verification_failed",
      message: error instanceof Error
        ? error.message
        : "Stable release verification failed",
    })}\n`);
    process.exitCode = 1;
  });
}
