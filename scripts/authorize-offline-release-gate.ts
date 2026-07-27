import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import {
  access,
  readFile,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  verifyGithubOfflineAttestation,
  type GithubOfflineAttestationBindingV1,
} from "./github-offline-attestation.ts";
import {
  attestReleaseGateArtifact,
  verifyReleaseGateProducerAttestation,
  type ReleaseGateArtifactV1,
  type ReleaseGateProducerAttestationV1,
} from "./release-fixtures.ts";

const CONFIRMATION_FLAG = "--confirm-protected-offline-authorization";
const KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:-]{2,79}$/u;

export interface OfflineReleaseGateAuthorizationArgs {
  artifactPath: string;
  githubBundlePath: string;
  githubBindingPath: string;
  outputPath: string;
  producerSigningKeyPath: string;
  producerKeyId: string;
}

export type OfflineGithubVerifier = (input: {
  artifactPath: string;
  bundlePath: string;
  bindingValue: unknown;
}) => Promise<{
  artifact: ReleaseGateArtifactV1;
  binding: GithubOfflineAttestationBindingV1;
}>;

function option(args: readonly string[], name: string): string {
  const positions = args.flatMap((value, index) => value === name ? [index] : []);
  if (positions.length !== 1) throw new Error(`${name} must be provided exactly once`);
  const value = args[positions[0]! + 1];
  if (!value || value.startsWith("--") || value.includes("\0")) {
    throw new Error(`${name} requires a safe value`);
  }
  return value;
}

export function parseOfflineReleaseGateAuthorizationArgs(
  argv: readonly string[],
): OfflineReleaseGateAuthorizationArgs {
  const valueOptions = new Set([
    "--artifact",
    "--github-bundle",
    "--github-binding",
    "--output",
    "--producer-signing-key",
    "--producer-key-id",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === CONFIRMATION_FLAG) continue;
    if (!valueOptions.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  if (argv.filter((value) => value === CONFIRMATION_FLAG).length !== 1) {
    throw new Error(
      `Offline authorization requires ${CONFIRMATION_FLAG}`,
    );
  }
  const producerKeyId = option(argv, "--producer-key-id");
  if (!KEY_ID.test(producerKeyId)) {
    throw new Error("--producer-key-id is invalid");
  }
  return {
    artifactPath: option(argv, "--artifact"),
    githubBundlePath: option(argv, "--github-bundle"),
    githubBindingPath: option(argv, "--github-binding"),
    outputPath: option(argv, "--output"),
    producerSigningKeyPath: option(argv, "--producer-signing-key"),
    producerKeyId,
  };
}

async function privateEd25519Key(path: string): Promise<KeyObject> {
  try {
    const key = createPrivateKey(await readFile(path));
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key;
  } catch {
    throw new Error(
      "--producer-signing-key must identify a readable Ed25519 private key",
    );
  }
}

async function requireAbsent(path: string): Promise<void> {
  try {
    await access(path);
    throw new Error("offline authorization output already exists");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function authorizeOfflineReleaseGate(
  args: OfflineReleaseGateAuthorizationArgs,
  verifier: OfflineGithubVerifier = verifyGithubOfflineAttestation,
): Promise<ReleaseGateProducerAttestationV1> {
  const paths = [
    args.artifactPath,
    args.githubBundlePath,
    args.githubBindingPath,
    args.outputPath,
    args.producerSigningKeyPath,
  ].map((path) => resolve(path));
  if (new Set(paths).size !== paths.length) {
    throw new Error(
      "offline artifact, proofs, key, and authorization output must be distinct files",
    );
  }
  await requireAbsent(args.outputPath);
  const [bindingValue, signingKey] = await Promise.all([
    readFile(args.githubBindingPath, "utf8")
      .then((value) => JSON.parse(value) as unknown)
      .catch(() => {
        throw new Error("--github-binding must identify readable JSON evidence");
      }),
    privateEd25519Key(args.producerSigningKeyPath),
  ]);
  const verified = await verifier({
    artifactPath: args.artifactPath,
    bundlePath: args.githubBundlePath,
    bindingValue,
  });
  const attestation = attestReleaseGateArtifact(
    verified.artifact,
    signingKey,
    args.producerKeyId,
  );
  verifyReleaseGateProducerAttestation(
    attestation,
    verified.artifact,
    createPublicKey(signingKey),
  );
  await writeFile(args.outputPath, `${JSON.stringify(attestation, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return attestation;
}

async function main(): Promise<void> {
  const args = parseOfflineReleaseGateAuthorizationArgs(process.argv.slice(2));
  const attestation = await authorizeOfflineReleaseGate(args);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    gate: "offline_suite",
    artifactEvidenceHash: attestation.evidenceHash,
    producerKeyId: attestation.signature.keyId,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "offline_release_gate_authorization_failed",
      message: "Offline release gate authorization failed closed",
    })}\n`);
    process.exitCode = 1;
  });
}
