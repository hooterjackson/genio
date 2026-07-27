import { createPrivateKey } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  attestReleaseGateArtifact,
  createReleaseGateArtifactFromSources,
  releaseFixtureSha256,
  type ReleaseFixtureBindingV1,
  type ReleaseGateCandidateBindingV1,
  type ReleaseGateName,
} from "./release-fixtures.ts";
import {
  validateRuntimeSnapshot,
  type LoadedRuntimeSnapshotV1,
} from "./release-evidence.ts";

const SOURCE_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:-]{2,79}$/u;

export interface ReleaseProducerFiles {
  sourceOutputPath: string;
  artifactOutputPath: string;
  attestationOutputPath: string;
  producerSigningKeyPath: string;
  producerKeyId: string;
}

export function releaseProducerOption(
  argv: readonly string[],
  name: string,
): string {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length !== 1) throw new Error(`${name} must be provided exactly once`);
  const value = argv[indexes[0]! + 1]?.trim() ?? "";
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function releaseProducerCandidate(input: {
  tag: string;
  version: string;
  sourceRevision: string;
  imageDigest: string;
}): ReleaseGateCandidateBindingV1 {
  const sourceRevision = input.sourceRevision.trim().toLowerCase();
  if (!VERSION.test(input.version)
    || !new RegExp(`^v${input.version.replaceAll(".", "\\.")}-rc\\.[1-9]\\d*$`, "u")
      .test(input.tag)
    || !SOURCE_REVISION.test(sourceRevision)
    || !IMAGE_DIGEST.test(input.imageDigest)) {
    throw new Error("release producer candidate identity is invalid");
  }
  return {
    tag: input.tag,
    version: input.version,
    sourceRevision,
    imageDigest: input.imageDigest,
    sitesSourceRevision: sourceRevision,
  };
}

async function producerSigningKey(files: ReleaseProducerFiles): Promise<Buffer> {
  if (!KEY_ID.test(files.producerKeyId)) {
    throw new Error("--producer-key-id is invalid");
  }
  let value: Buffer;
  try {
    value = await readFile(files.producerSigningKeyPath);
  } catch {
    throw new Error("--producer-signing-key must identify a readable Ed25519 private key");
  }
  try {
    if (createPrivateKey(value).asymmetricKeyType !== "ed25519") {
      throw new Error("wrong key type");
    }
  } catch {
    throw new Error("--producer-signing-key must identify a readable Ed25519 private key");
  }
  return value;
}

export async function preflightReleaseProducerFiles(
  files: ReleaseProducerFiles,
): Promise<void> {
  await producerSigningKey(files);
  const outputs = [
    files.sourceOutputPath,
    files.artifactOutputPath,
    files.attestationOutputPath,
  ].map((path) => resolve(path));
  if (new Set(outputs).size !== outputs.length
    || outputs.includes(resolve(files.producerSigningKeyPath))) {
    throw new Error("release producer output paths must be distinct from one another and the signing key");
  }
  for (const path of outputs) {
    try {
      await readFile(path);
      throw new Error("release producer output already exists");
    } catch (error) {
      if (error instanceof Error
        && "code" in error
        && error.code === "ENOENT") continue;
      throw error;
    }
  }
}

export async function loadReleaseProducerRuntimeSnapshot(input: {
  path: string;
  environment: "staging" | "production";
  expectedScope?: "backend" | "full";
  origin: string;
  candidate: ReleaseGateCandidateBindingV1;
}): Promise<LoadedRuntimeSnapshotV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(input.path, "utf8"));
  } catch {
    throw new Error("--runtime-snapshot must identify readable JSON evidence");
  }
  const expectedScope = input.expectedScope
    ?? (input.environment === "staging" ? "full" : "backend");
  const snapshot = validateRuntimeSnapshot(
    parsed,
    input.environment,
    expectedScope,
  );
  if (
    snapshot.origin !== input.origin
    || snapshot.candidate.version !== input.candidate.version
    || snapshot.candidate.sourceRevision !== input.candidate.sourceRevision
    || snapshot.runtime.databaseSchemaVersion !== "18"
    || snapshot.runtime.databaseCapabilityVersion !== "2"
    || snapshot.runtime.releaseManifestCanaryGuardsVersion !== "1"
    || snapshot.runtime.canonicalExecutionHardeningVersion !== "1"
    || snapshot.runtime.workerProtocol !== "playlist-pipeline-v10"
    || snapshot.runtime.briefContractVersion !== "3"
    || snapshot.runtime.queryPlanSchemaVersion !== "5"
  ) {
    throw new Error("release producer runtime snapshot does not bind the activated candidate");
  }
  return snapshot;
}

async function immutableJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export async function emitReleaseGateProducerArtifacts(input: {
  gate: ReleaseGateName;
  completedAt: string;
  candidate: ReleaseGateCandidateBindingV1;
  runtimeSnapshot: LoadedRuntimeSnapshotV1;
  fixtures: ReleaseFixtureBindingV1[];
  sources: Record<string, unknown>;
  files: ReleaseProducerFiles;
}): Promise<{
  source: Record<string, unknown>;
  artifact: ReturnType<typeof createReleaseGateArtifactFromSources>;
  attestation: ReturnType<typeof attestReleaseGateArtifact>;
}> {
  const signingKey = await producerSigningKey(input.files);
  const sourceUnsigned = {
    schemaVersion: "genio-release-gate-producer-source/v1",
    gate: input.gate,
    completedAt: input.completedAt,
    candidate: input.candidate,
    runtimeSnapshotHash: input.runtimeSnapshot.snapshotHash,
    credentialVersionHashes: input.runtimeSnapshot.credentialVersionHashes,
    evidence: input.sources,
  };
  const source = {
    ...sourceUnsigned,
    sourceHash: releaseFixtureSha256(sourceUnsigned),
  };
  const artifact = createReleaseGateArtifactFromSources({
    gate: input.gate,
    completedAt: input.completedAt,
    candidate: input.candidate,
    configurationHash: input.runtimeSnapshot.configurationHash,
    runtimeHash: input.runtimeSnapshot.runtimeHash,
    fixtures: input.fixtures,
    sources: input.sources,
  });
  const attestation = attestReleaseGateArtifact(
    artifact,
    signingKey,
    input.files.producerKeyId,
  );
  await immutableJson(input.files.sourceOutputPath, source);
  await immutableJson(input.files.artifactOutputPath, artifact);
  await immutableJson(input.files.attestationOutputPath, attestation);
  return { source, artifact, attestation };
}
