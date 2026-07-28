import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  type ReleaseGateArtifactV1,
  validateReleaseGateArtifact,
} from "./release-fixtures.ts";

const execFileAsync = promisify(execFile);

export const RELEASE_ATTESTATION_REPOSITORY = "hooterjackson/genio";
export const RELEASE_ATTESTATION_WORKFLOW =
  "hooterjackson/genio/.github/workflows/release-candidate.yml";
export const RELEASE_ATTESTATION_SOURCE_REF = "refs/heads/main";
export const RELEASE_ATTESTATION_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";

const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export interface GithubOfflineAttestationBindingV1 {
  schemaVersion: "genio-release-offline-attestation-binding/v1";
  repository: typeof RELEASE_ATTESTATION_REPOSITORY;
  workflow: typeof RELEASE_ATTESTATION_WORKFLOW;
  workflowRef: typeof RELEASE_ATTESTATION_SOURCE_REF;
  workflowSha: string;
  candidateSourceRevision: string;
  artifactSha256: string;
  predicateType: typeof RELEASE_ATTESTATION_PREDICATE_TYPE;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function offlineWorkflow(artifact: ReleaseGateArtifactV1): JsonRecord {
  if (artifact.gate !== "offline_suite" || artifact.environment !== "offline") {
    throw new Error("GitHub artifact attestation may bind only the offline release gate");
  }
  const offlineSuite = record(artifact.sources.offlineSuite, "offline suite source");
  return record(offlineSuite.workflow, "offline suite workflow provenance");
}

export function validateGithubOfflineAttestationBinding(
  value: unknown,
  artifactValue: unknown,
): GithubOfflineAttestationBindingV1 {
  const artifact = validateReleaseGateArtifact(artifactValue);
  const workflow = offlineWorkflow(artifact);
  const root = record(value, "GitHub offline attestation binding");
  exactKeys(root, [
    "schemaVersion",
    "repository",
    "workflow",
    "workflowRef",
    "workflowSha",
    "candidateSourceRevision",
    "artifactSha256",
    "predicateType",
  ], "GitHub offline attestation binding");
  if (
    root.schemaVersion !== "genio-release-offline-attestation-binding/v1"
    || root.repository !== RELEASE_ATTESTATION_REPOSITORY
    || root.workflow !== RELEASE_ATTESTATION_WORKFLOW
    || root.workflowRef !== RELEASE_ATTESTATION_SOURCE_REF
    || root.predicateType !== RELEASE_ATTESTATION_PREDICATE_TYPE
    || typeof root.workflowSha !== "string"
    || !SOURCE_REVISION.test(root.workflowSha)
    || typeof root.candidateSourceRevision !== "string"
    || !SOURCE_REVISION.test(root.candidateSourceRevision)
    || root.workflowSha !== artifact.candidate.sourceRevision
    || root.candidateSourceRevision !== artifact.candidate.sourceRevision
    || workflow.repository !== RELEASE_ATTESTATION_REPOSITORY
    || workflow.sha !== artifact.candidate.sourceRevision
    || typeof root.artifactSha256 !== "string"
    || !SHA256.test(root.artifactSha256)
  ) {
    throw new Error(
      "GitHub offline attestation binding does not bind the trusted workflow and candidate",
    );
  }
  return root as unknown as GithubOfflineAttestationBindingV1;
}

export type GithubAttestationCommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr?: string }>;

async function defaultRunner(
  executable: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr?: string }> {
  const result = await execFileAsync(executable, [...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function verifiedGithubAttestation(
  stdout: string,
  expectedArtifactSha256: string,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("GitHub attestation verifier returned invalid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length < 1) {
    throw new Error("GitHub attestation verifier returned no verified attestations");
  }
  const accepted = parsed.some((entry) => {
    const result = record(record(entry, "GitHub attestation result").verificationResult,
      "GitHub attestation verification result");
    const statement = record(result.statement, "GitHub attestation statement");
    if (statement.predicateType !== RELEASE_ATTESTATION_PREDICATE_TYPE
      || !Array.isArray(statement.subject)) return false;
    const subjectMatches = statement.subject.some((subjectValue) => {
      const subject = record(subjectValue, "GitHub attestation subject");
      const digest = record(subject.digest, "GitHub attestation subject digest");
      return digest.sha256 === expectedArtifactSha256;
    });
    const signature = record(result.signature, "GitHub attestation signature");
    const certificate = record(signature.certificate, "GitHub attestation certificate");
    return subjectMatches
      && Object.keys(certificate).length > 0
      && Array.isArray(result.verifiedTimestamps);
  });
  if (!accepted) {
    throw new Error(
      "GitHub attestation verification result does not bind the offline artifact",
    );
  }
}

export async function verifyGithubOfflineAttestation(input: {
  artifactPath: string;
  bundlePath: string;
  bindingValue: unknown;
  runner?: GithubAttestationCommandRunner;
}): Promise<{
  artifact: ReleaseGateArtifactV1;
  binding: GithubOfflineAttestationBindingV1;
}> {
  const artifactBytes = await readFile(input.artifactPath);
  const artifact = validateReleaseGateArtifact(JSON.parse(artifactBytes.toString("utf8")));
  const binding = validateGithubOfflineAttestationBinding(input.bindingValue, artifact);
  const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
  if (artifactSha256 !== binding.artifactSha256) {
    throw new Error("offline artifact bytes do not match the attestation binding");
  }
  const runner = input.runner ?? defaultRunner;
  const result = await runner("gh", [
    "attestation",
    "verify",
    input.artifactPath,
    "--repo",
    RELEASE_ATTESTATION_REPOSITORY,
    "--bundle",
    input.bundlePath,
    "--signer-workflow",
    RELEASE_ATTESTATION_WORKFLOW,
    "--source-ref",
    RELEASE_ATTESTATION_SOURCE_REF,
    "--source-digest",
    binding.workflowSha,
    "--predicate-type",
    RELEASE_ATTESTATION_PREDICATE_TYPE,
    "--cert-oidc-issuer",
    "https://token.actions.githubusercontent.com",
    "--deny-self-hosted-runners",
    "--format",
    "json",
  ]);
  verifiedGithubAttestation(result.stdout, artifactSha256);
  return { artifact, binding };
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : "";
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "verify") {
    throw new Error(
      "Usage: github-offline-attestation verify --artifact <json> "
      + "--bundle <sigstore.json> --binding <json>",
    );
  }
  const artifactPath = option(args, "--artifact");
  const bundlePath = option(args, "--bundle");
  const bindingPath = option(args, "--binding");
  const bindingValue = JSON.parse(await readFile(bindingPath, "utf8"));
  const result = await verifyGithubOfflineAttestation({
    artifactPath,
    bundlePath,
    bindingValue,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    artifact: basename(artifactPath),
    gate: result.artifact.gate,
    evidenceHash: result.artifact.evidenceHash,
    candidateSourceRevision: result.binding.candidateSourceRevision,
    workflowSha: result.binding.workflowSha,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "github_offline_attestation_failed",
      message: error instanceof Error ? error.message : "GitHub attestation verification failed",
    })}\n`);
    process.exitCode = 1;
  });
}
