import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_REFERENCE =
  /^ghcr\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const RC_TAG =
  /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-rc\.[1-9]\d*$/u;

type JsonRecord = Record<string, unknown>;

export interface NativeV254CandidateEvidenceV1 {
  schemaVersion: "genio-native-v254-candidate-evidence/v1";
  candidateTag: string;
  version: string;
  sourceRevision: string;
  imageReference: string;
  imageDigest: string;
  exactShaImageReceiptHash: string;
  checksRunId: string;
  ciReceiptSha256: string;
  controllerRevision: string;
  releaseVerificationKeySha256: string;
  publicRolloutIntentCanaryAuthorityPolicySha256: string;
  producerWorkflow: ".github/workflows/exact-sha-image.yml";
  producerRunUrl: string;
  requiredRuntime: {
    databaseSchemaVersion: "20";
    proofArchitectureVersion: "1";
    proofArchitectureAuthority: "native";
    workerProtocol: "playlist-pipeline-v12";
    briefContractVersion: "3";
    queryPlanSchemaVersion: "6";
    guidancePolicyVersion: "adaptive_guidance_v5";
  };
  generatedAt: string;
  payloadHash: string;
}

interface ExactShaReceiptLike {
  schemaVersion: "genio-exact-sha-image/v1";
  sourceRevision: string;
  version: string;
  imageReference: string;
  imageDigest: string;
  controllerRevision: string;
  checksRunId: string;
  ciReceiptSha256: string;
  releaseVerificationKeySha256: string;
  publicRolloutIntentCanaryAuthorityPolicySha256: string;
  runUrl: string;
  createdAt: string;
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

function string(value: unknown, label: string, pattern: RegExp): string {
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
      .map(([key, child]) => [key, stable(child)]),
  );
}

export function nativeV254EvidenceHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function validateExactShaReceiptLike(value: unknown): ExactShaReceiptLike {
  const receipt = record(value, "exact-SHA image receipt");
  exactKeys(receipt, [
    "schemaVersion",
    "sourceRevision",
    "version",
    "imageReference",
    "imageDigest",
    "controllerRevision",
    "checksRunId",
    "ciReceiptSha256",
    "releaseVerificationKeySha256",
    "publicRolloutIntentCanaryAuthorityPolicySha256",
    "runUrl",
    "createdAt",
  ], "exact-SHA image receipt");
  if (receipt.schemaVersion !== "genio-exact-sha-image/v1") {
    throw new Error("exact-SHA image receipt uses an unsupported schema");
  }
  const imageDigest = string(
    receipt.imageDigest,
    "exact-SHA image digest",
    IMAGE_DIGEST,
  );
  const imageReference = string(
    receipt.imageReference,
    "exact-SHA image reference",
    IMAGE_REFERENCE,
  );
  if (!imageReference.endsWith(`@${imageDigest}`)) {
    throw new Error("exact-SHA image reference and digest differ");
  }
  return {
    schemaVersion: "genio-exact-sha-image/v1",
    sourceRevision: string(
      receipt.sourceRevision,
      "exact-SHA source revision",
      SHA1,
    ),
    version: string(receipt.version, "exact-SHA version", VERSION),
    imageReference,
    imageDigest,
    controllerRevision: string(
      receipt.controllerRevision,
      "exact-SHA controller revision",
      SHA1,
    ),
    checksRunId: string(
      receipt.checksRunId,
      "exact-SHA checks run ID",
      /^[1-9]\d*$/u,
    ),
    ciReceiptSha256: string(
      receipt.ciReceiptSha256,
      "exact-SHA CI receipt digest",
      SHA256,
    ),
    releaseVerificationKeySha256: string(
      receipt.releaseVerificationKeySha256,
      "release verification key digest",
      SHA256,
    ),
    publicRolloutIntentCanaryAuthorityPolicySha256: string(
      receipt.publicRolloutIntentCanaryAuthorityPolicySha256,
      "public rollout authority policy digest",
      SHA256,
    ),
    runUrl: string(
      receipt.runUrl,
      "exact-SHA workflow URL",
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9]\d*$/u,
    ),
    createdAt: timestamp(
      receipt.createdAt,
      "exact-SHA receipt creation time",
    ),
  };
}

export function createNativeV254CandidateEvidence(input: {
  exactShaImageReceipt: unknown;
  candidateTag: string;
  generatedAt?: string;
}): NativeV254CandidateEvidenceV1 {
  const receipt = validateExactShaReceiptLike(input.exactShaImageReceipt);
  const tag = string(input.candidateTag, "candidate tag", RC_TAG);
  if (RC_TAG.exec(tag)![1] !== receipt.version) {
    throw new Error("candidate tag does not match exact-SHA version");
  }
  const generatedAt = timestamp(
    input.generatedAt ?? new Date().toISOString(),
    "candidate evidence generation time",
  );
  if (Date.parse(generatedAt) < Date.parse(receipt.createdAt)) {
    throw new Error("candidate evidence predates the exact-SHA image receipt");
  }
  const unsigned = {
    schemaVersion: "genio-native-v254-candidate-evidence/v1" as const,
    candidateTag: tag,
    version: receipt.version,
    sourceRevision: receipt.sourceRevision,
    imageReference: receipt.imageReference,
    imageDigest: receipt.imageDigest,
    exactShaImageReceiptHash: nativeV254EvidenceHash(receipt),
    checksRunId: receipt.checksRunId,
    ciReceiptSha256: receipt.ciReceiptSha256,
    controllerRevision: receipt.controllerRevision,
    releaseVerificationKeySha256:
      receipt.releaseVerificationKeySha256,
    publicRolloutIntentCanaryAuthorityPolicySha256:
      receipt.publicRolloutIntentCanaryAuthorityPolicySha256,
    producerWorkflow: ".github/workflows/exact-sha-image.yml" as const,
    producerRunUrl: receipt.runUrl,
    requiredRuntime: {
      databaseSchemaVersion: "20" as const,
      proofArchitectureVersion: "1" as const,
      proofArchitectureAuthority: "native" as const,
      workerProtocol: "playlist-pipeline-v12" as const,
      briefContractVersion: "3" as const,
      queryPlanSchemaVersion: "6" as const,
      guidancePolicyVersion: "adaptive_guidance_v5" as const,
    },
    generatedAt,
  };
  return Object.freeze({
    ...unsigned,
    payloadHash: nativeV254EvidenceHash(unsigned),
  });
}

export function validateNativeV254CandidateEvidence(
  value: unknown,
  expected: {
    candidateTag: string;
    version: string;
    sourceRevision: string;
    imageReference: string;
    imageDigest: string;
    exactShaImageReceiptHash: string;
    checksRunId: string;
    ciReceiptSha256: string;
    controllerRevision: string;
    releaseVerificationKeySha256: string;
    producerRunUrl: string;
  },
): NativeV254CandidateEvidenceV1 {
  const evidence = record(value, "native v2.5.4 candidate evidence");
  exactKeys(evidence, [
    "schemaVersion",
    "candidateTag",
    "version",
    "sourceRevision",
    "imageReference",
    "imageDigest",
    "exactShaImageReceiptHash",
    "checksRunId",
    "ciReceiptSha256",
    "controllerRevision",
    "releaseVerificationKeySha256",
    "publicRolloutIntentCanaryAuthorityPolicySha256",
    "producerWorkflow",
    "producerRunUrl",
    "requiredRuntime",
    "generatedAt",
    "payloadHash",
  ], "native v2.5.4 candidate evidence");
  if (
    evidence.schemaVersion !== "genio-native-v254-candidate-evidence/v1"
    || evidence.producerWorkflow !== ".github/workflows/exact-sha-image.yml"
  ) {
    throw new Error("native candidate evidence uses an unsupported authority");
  }
  const runtime = record(
    evidence.requiredRuntime,
    "native candidate required runtime",
  );
  exactKeys(runtime, [
    "databaseSchemaVersion",
    "proofArchitectureVersion",
    "proofArchitectureAuthority",
    "workerProtocol",
    "briefContractVersion",
    "queryPlanSchemaVersion",
    "guidancePolicyVersion",
  ], "native candidate required runtime");
  if (
    runtime.databaseSchemaVersion !== "20"
    || runtime.proofArchitectureVersion !== "1"
    || runtime.proofArchitectureAuthority !== "native"
    || runtime.workerProtocol !== "playlist-pipeline-v12"
    || runtime.briefContractVersion !== "3"
    || runtime.queryPlanSchemaVersion !== "6"
    || runtime.guidancePolicyVersion !== "adaptive_guidance_v5"
  ) {
    throw new Error("native candidate evidence has incompatible runtime requirements");
  }
  const unsigned = Object.fromEntries(
    Object.entries(evidence).filter(([key]) => key !== "payloadHash"),
  );
  const payloadHash = string(
    evidence.payloadHash,
    "native candidate evidence payload hash",
    SHA256,
  );
  if (nativeV254EvidenceHash(unsigned) !== payloadHash) {
    throw new Error("native candidate evidence payload hash is invalid");
  }
  const observed = {
    candidateTag: string(evidence.candidateTag, "candidate tag", RC_TAG),
    version: string(evidence.version, "candidate version", VERSION),
    sourceRevision: string(
      evidence.sourceRevision,
      "candidate source revision",
      SHA1,
    ),
    imageReference: string(
      evidence.imageReference,
      "candidate image reference",
      IMAGE_REFERENCE,
    ),
    imageDigest: string(
      evidence.imageDigest,
      "candidate image digest",
      IMAGE_DIGEST,
    ),
    exactShaImageReceiptHash: string(
      evidence.exactShaImageReceiptHash,
      "exact-SHA image receipt hash",
      SHA256,
    ),
    checksRunId: string(
      evidence.checksRunId,
      "exact-SHA checks run ID",
      /^[1-9]\d*$/u,
    ),
    ciReceiptSha256: string(
      evidence.ciReceiptSha256,
      "exact-SHA CI receipt digest",
      SHA256,
    ),
    controllerRevision: string(
      evidence.controllerRevision,
      "exact-SHA controller revision",
      SHA1,
    ),
    releaseVerificationKeySha256: string(
      evidence.releaseVerificationKeySha256,
      "release verification key digest",
      SHA256,
    ),
    producerRunUrl: string(
      evidence.producerRunUrl,
      "candidate producer run URL",
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9]\d*$/u,
    ),
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (observed[key as keyof typeof observed] !== expectedValue) {
      throw new Error(`native candidate evidence does not bind ${key}`);
    }
  }
  timestamp(evidence.generatedAt, "candidate evidence generation time");
  string(
    evidence.publicRolloutIntentCanaryAuthorityPolicySha256,
    "public rollout authority policy digest",
    SHA256,
  );
  return evidence as unknown as NativeV254CandidateEvidenceV1;
}

async function main(argv: readonly string[]): Promise<void> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) {
      throw new Error("candidate evidence arguments are malformed");
    }
    values.set(key, value);
  }
  const allowed = new Set([
    "--exact-sha-image-receipt",
    "--candidate-tag",
    "--output",
  ]);
  if (
    values.size !== allowed.size
    || [...values.keys()].some((key) => !allowed.has(key))
  ) {
    throw new Error(
      "Usage: native-v254-candidate-evidence.ts "
      + "--exact-sha-image-receipt <path> --candidate-tag <tag> --output <path>",
    );
  }
  const receipt = JSON.parse(await readFile(
    values.get("--exact-sha-image-receipt")!,
    "utf8",
  )) as unknown;
  const evidence = createNativeV254CandidateEvidence({
    exactShaImageReceipt: receipt,
    candidateTag: values.get("--candidate-tag")!,
  });
  await writeFile(
    values.get("--output")!,
    `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    payloadHash: evidence.payloadHash,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "native_candidate_evidence_failed",
      message: error instanceof Error ? error.message : "unknown failure",
    })}\n`);
    process.exitCode = 1;
  });
}
