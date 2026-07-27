import {
  createHash,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import {
  appendFile,
  lstat,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  semanticRankingProtectedBaselineMetadataSha256,
  validateSemanticRankingProtectedBaselineMetadataV1,
} from "../lib/semantic-ranking-review.ts";
import { stableReleaseKeyFingerprint } from "./authorize-stable-release.ts";

export const SEMANTIC_BASELINE_HANDOFF_SCHEMA_V1 =
  "genio-semantic-baseline-handoff/v1" as const;
export const SEMANTIC_BASELINE_HANDOFF_MANIFEST =
  "semantic-baseline-handoff.json" as const;
export const SEMANTIC_BASELINE_RELEASE_KEY_FILE =
  "release-verification-public-key.pem" as const;
export const SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_FILE =
  "stable-authorizer-public-key.pem" as const;
export const SEMANTIC_BASELINE_RELEASE_ASSET_NAMES = Object.freeze([
  "finalization-evidence.json",
  "protected-semantic-baseline.json",
  "stable-authorization.json",
  "stable-image-attestation.json",
  "stable-release-consumer.json",
] as const);

const SHA256 = /^[0-9a-f]{64}$/u;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const RC_TAG =
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-rc\.[1-9]\d*$/u;
const STABLE_TAG =
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_PUBLIC_KEY_BYTES = 16 * 1024;

type SemanticBaselineReleaseAssetName =
  typeof SEMANTIC_BASELINE_RELEASE_ASSET_NAMES[number];

export interface SemanticBaselineHandoffManifestV1 {
  schemaVersion: typeof SEMANTIC_BASELINE_HANDOFF_SCHEMA_V1;
  candidate: {
    tag: string;
    sourceRevision: string;
  };
  predecessor: {
    releaseId: number;
    stableTag: string;
    sourceRevision: string;
    releaseIdentitySha256: string;
    metadataSha256: string;
    releaseVerificationKeySha256: string;
    stableAuthorizerKeyId: string;
    stableAuthorizerKeySha256: string;
  };
  releaseAssets: Array<{
    name: SemanticBaselineReleaseAssetName;
    sha256: string;
  }>;
  historicalPublicKeys: [
    {
      name: typeof SEMANTIC_BASELINE_RELEASE_KEY_FILE;
      bytesSha256: string;
      keySha256: string;
    },
    {
      name: typeof SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_FILE;
      bytesSha256: string;
      keySha256: string;
    },
  ];
}

export interface LoadedSemanticBaselineHandoffV1 {
  manifest: SemanticBaselineHandoffManifestV1;
  manifestSha256: string;
  releaseAssets: Readonly<Record<SemanticBaselineReleaseAssetName, Buffer>>;
  releaseVerificationKey: {
    bytes: Buffer;
    key: KeyObject;
  };
  stableAuthorizerVerificationKey: {
    bytes: Buffer;
    key: KeyObject;
  };
  protectedBaselineMetadata: ReturnType<
    typeof validateSemanticRankingProtectedBaselineMetadataV1
  >;
  finalizationEvidence: unknown;
  stableAuthorization: unknown;
  stableReleaseConsumer: unknown;
  stableImageAttestation: Record<string, unknown>;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): JsonRecord {
  const source = record(value, label);
  const actual = Object.keys(source).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} contains missing or unapproved fields`);
  }
  return source;
}

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortedJsonValue(item)]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortedJsonValue(value));
}

function bytesSha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function revision(value: unknown, label: string): string {
  if (typeof value !== "string" || !REVISION.test(value)) {
    throw new Error(`${label} must be a full lowercase source revision`);
  }
  return value;
}

function publicEd25519Key(bytes: Buffer, label: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(bytes);
  } catch {
    throw new Error(`${label} must contain an Ed25519 public key`);
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new Error(`${label} must contain an Ed25519 public key`);
  }
  return key;
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must contain readable JSON`);
  }
}

async function regularFileBytes(
  path: string,
  label: string,
  maximumBytes: number,
): Promise<Buffer> {
  const status = await lstat(path).catch(() => null);
  if (
    !status
    || !status.isFile()
    || status.isSymbolicLink()
    || status.size <= 0
    || status.size > maximumBytes
  ) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  const bytes = await readFile(path);
  if (bytes.length !== status.size) {
    throw new Error(`${label} changed while the handoff was being read`);
  }
  return bytes;
}

async function exactDirectory(
  directory: string,
  expectedNames: readonly string[],
  label: string,
): Promise<string> {
  const resolved = resolve(directory);
  const status = await lstat(resolved).catch(() => null);
  if (!status || !status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  const names = (await readdir(resolved)).sort();
  const expected = [...expectedNames].sort();
  if (
    names.length !== expected.length
    || names.some((name, index) => name !== expected[index])
  ) {
    throw new Error(`${label} has a missing or unexpected file`);
  }
  return resolved;
}

function validateAssetHashMap(
  value: unknown,
  label: string,
): Record<SemanticBaselineReleaseAssetName, string> {
  const source = exactRecord(
    value,
    SEMANTIC_BASELINE_RELEASE_ASSET_NAMES,
    label,
  );
  return Object.fromEntries(
    SEMANTIC_BASELINE_RELEASE_ASSET_NAMES.map((name) => [
      name,
      digest(source[name], `${label}.${name}`),
    ]),
  ) as Record<SemanticBaselineReleaseAssetName, string>;
}

function validateConsumerBindings(input: {
  value: unknown;
  metadataSha256: string;
  stableTag: string;
  sourceRevision: string;
  releaseVerificationKeySha256: string;
  stableAuthorizerKeyId: string;
  stableAuthorizerKeySha256: string;
}): unknown {
  const consumer = exactRecord(input.value, [
    "schemaVersion",
    "verifiedAt",
    "candidate",
    "finalizationEvidencePayloadHash",
    "finalBrowserGateEvidenceHash",
    "protectedBaselineMetadataHash",
    "stableAuthorizationPayloadHash",
    "releaseVerificationKeySha256",
    "stableAuthorizerKeyId",
    "stableAuthorizerKeySha256",
  ], "semantic baseline stored consumer manifest");
  const candidate = exactRecord(consumer.candidate, [
    "rcTag",
    "stableTag",
    "version",
    "sourceRevision",
    "imageDigest",
    "imageReference",
  ], "semantic baseline stored consumer candidate");
  if (
    consumer.schemaVersion !== "genio-stable-release-consumer-manifest/v2"
    || consumer.protectedBaselineMetadataHash !== input.metadataSha256
    || consumer.releaseVerificationKeySha256
      !== input.releaseVerificationKeySha256
    || consumer.stableAuthorizerKeyId !== input.stableAuthorizerKeyId
    || consumer.stableAuthorizerKeySha256
      !== input.stableAuthorizerKeySha256
    || candidate.stableTag !== input.stableTag
    || candidate.sourceRevision !== input.sourceRevision
  ) {
    throw new Error(
      "semantic baseline stored consumer does not bind the selected predecessor",
    );
  }
  return input.value;
}

export function semanticBaselineReleaseIdentitySha256(input: {
  releaseId: number;
  stableTag: string;
  sourceRevision: string;
  metadataSha256: string;
  assetSha256: Record<SemanticBaselineReleaseAssetName, string>;
}): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

export function semanticBaselineHandoffManifestSha256(
  value: SemanticBaselineHandoffManifestV1,
): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function validateSemanticBaselineHandoffManifestV1(
  value: unknown,
): SemanticBaselineHandoffManifestV1 {
  const manifest = exactRecord(value, [
    "schemaVersion",
    "candidate",
    "predecessor",
    "releaseAssets",
    "historicalPublicKeys",
  ], "semantic baseline handoff manifest");
  const candidate = exactRecord(manifest.candidate, [
    "tag",
    "sourceRevision",
  ], "semantic baseline handoff candidate");
  const predecessor = exactRecord(manifest.predecessor, [
    "releaseId",
    "stableTag",
    "sourceRevision",
    "releaseIdentitySha256",
    "metadataSha256",
    "releaseVerificationKeySha256",
    "stableAuthorizerKeyId",
    "stableAuthorizerKeySha256",
  ], "semantic baseline handoff predecessor");
  if (
    manifest.schemaVersion !== SEMANTIC_BASELINE_HANDOFF_SCHEMA_V1
    || typeof candidate.tag !== "string"
    || !RC_TAG.test(candidate.tag)
    || typeof predecessor.stableTag !== "string"
    || !STABLE_TAG.test(predecessor.stableTag)
    || !Number.isSafeInteger(predecessor.releaseId)
    || Number(predecessor.releaseId) <= 0
    || typeof predecessor.stableAuthorizerKeyId !== "string"
    || !KEY_ID.test(predecessor.stableAuthorizerKeyId)
  ) {
    throw new Error("semantic baseline handoff identity is invalid");
  }
  const releaseAssets = Array.isArray(manifest.releaseAssets)
    ? manifest.releaseAssets
    : [];
  if (
    releaseAssets.length !== SEMANTIC_BASELINE_RELEASE_ASSET_NAMES.length
  ) {
    throw new Error("semantic baseline handoff asset inventory is invalid");
  }
  const parsedAssets = releaseAssets.map((value, index) => {
    const asset = exactRecord(
      value,
      ["name", "sha256"],
      `semantic baseline handoff asset ${index}`,
    );
    if (
      asset.name !== SEMANTIC_BASELINE_RELEASE_ASSET_NAMES[index]
    ) {
      throw new Error("semantic baseline handoff asset order is invalid");
    }
    return {
      name: asset.name,
      sha256: digest(
        asset.sha256,
        `semantic baseline handoff asset ${index}.sha256`,
      ),
    } as SemanticBaselineHandoffManifestV1["releaseAssets"][number];
  });
  const publicKeys = Array.isArray(manifest.historicalPublicKeys)
    ? manifest.historicalPublicKeys
    : [];
  const expectedKeyNames = [
    SEMANTIC_BASELINE_RELEASE_KEY_FILE,
    SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_FILE,
  ] as const;
  if (publicKeys.length !== expectedKeyNames.length) {
    throw new Error("semantic baseline handoff key inventory is invalid");
  }
  const parsedKeys = publicKeys.map((value, index) => {
    const key = exactRecord(
      value,
      ["name", "bytesSha256", "keySha256"],
      `semantic baseline handoff key ${index}`,
    );
    if (key.name !== expectedKeyNames[index]) {
      throw new Error("semantic baseline handoff key order is invalid");
    }
    return {
      name: key.name,
      bytesSha256: digest(
        key.bytesSha256,
        `semantic baseline handoff key ${index}.bytesSha256`,
      ),
      keySha256: digest(
        key.keySha256,
        `semantic baseline handoff key ${index}.keySha256`,
      ),
    };
  }) as SemanticBaselineHandoffManifestV1["historicalPublicKeys"];
  const parsed: SemanticBaselineHandoffManifestV1 = {
    schemaVersion: SEMANTIC_BASELINE_HANDOFF_SCHEMA_V1,
    candidate: {
      tag: candidate.tag,
      sourceRevision: revision(
        candidate.sourceRevision,
        "semantic baseline handoff candidate.sourceRevision",
      ),
    },
    predecessor: {
      releaseId: Number(predecessor.releaseId),
      stableTag: predecessor.stableTag,
      sourceRevision: revision(
        predecessor.sourceRevision,
        "semantic baseline handoff predecessor.sourceRevision",
      ),
      releaseIdentitySha256: digest(
        predecessor.releaseIdentitySha256,
        "semantic baseline handoff predecessor.releaseIdentitySha256",
      ),
      metadataSha256: digest(
        predecessor.metadataSha256,
        "semantic baseline handoff predecessor.metadataSha256",
      ),
      releaseVerificationKeySha256: digest(
        predecessor.releaseVerificationKeySha256,
        "semantic baseline handoff predecessor.releaseVerificationKeySha256",
      ),
      stableAuthorizerKeyId: predecessor.stableAuthorizerKeyId,
      stableAuthorizerKeySha256: digest(
        predecessor.stableAuthorizerKeySha256,
        "semantic baseline handoff predecessor.stableAuthorizerKeySha256",
      ),
    },
    releaseAssets: parsedAssets,
    historicalPublicKeys: parsedKeys,
  };
  if (
    parsed.predecessor.releaseVerificationKeySha256
      === parsed.predecessor.stableAuthorizerKeySha256
    || parsed.historicalPublicKeys[0].keySha256
      !== parsed.predecessor.releaseVerificationKeySha256
    || parsed.historicalPublicKeys[1].keySha256
      !== parsed.predecessor.stableAuthorizerKeySha256
  ) {
    throw new Error("semantic baseline handoff key bindings are invalid");
  }
  return parsed;
}

async function loadBundleFiles(
  directory: string,
  expectedNames: readonly string[],
): Promise<{
  directory: string;
  assets: Record<SemanticBaselineReleaseAssetName, Buffer>;
  releaseKeyBytes: Buffer;
  stableAuthorizerKeyBytes: Buffer;
}> {
  const resolved = await exactDirectory(
    directory,
    expectedNames,
    "semantic baseline handoff",
  );
  const assetEntries = await Promise.all(
    SEMANTIC_BASELINE_RELEASE_ASSET_NAMES.map(async (name) => [
      name,
      await regularFileBytes(
        join(resolved, name),
        `semantic baseline handoff ${name}`,
        MAX_ASSET_BYTES,
      ),
    ] as const),
  );
  const [releaseKeyBytes, stableAuthorizerKeyBytes] = await Promise.all([
    regularFileBytes(
      join(resolved, SEMANTIC_BASELINE_RELEASE_KEY_FILE),
      "semantic baseline historical release verification key",
      MAX_PUBLIC_KEY_BYTES,
    ),
    regularFileBytes(
      join(resolved, SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_FILE),
      "semantic baseline historical stable-authorizer key",
      MAX_PUBLIC_KEY_BYTES,
    ),
  ]);
  return {
    directory: resolved,
    assets: Object.fromEntries(assetEntries) as Record<
      SemanticBaselineReleaseAssetName,
      Buffer
    >,
    releaseKeyBytes,
    stableAuthorizerKeyBytes,
  };
}

async function validateBundleAgainstManifest(input: {
  manifest: SemanticBaselineHandoffManifestV1;
  directory: string;
  expectedNames: readonly string[];
}): Promise<LoadedSemanticBaselineHandoffV1> {
  const files = await loadBundleFiles(input.directory, input.expectedNames);
  const assetHashes = Object.fromEntries(
    input.manifest.releaseAssets.map(({ name, sha256 }) => [name, sha256]),
  ) as Record<SemanticBaselineReleaseAssetName, string>;
  for (const name of SEMANTIC_BASELINE_RELEASE_ASSET_NAMES) {
    if (bytesSha256(files.assets[name]) !== assetHashes[name]) {
      throw new Error(`semantic baseline handoff ${name} hash mismatch`);
    }
  }
  const releaseVerificationKey =
    publicEd25519Key(
      files.releaseKeyBytes,
      "semantic baseline historical release verification key",
    );
  const stableAuthorizerVerificationKey =
    publicEd25519Key(
      files.stableAuthorizerKeyBytes,
      "semantic baseline historical stable-authorizer key",
    );
  const releaseKeyFingerprint =
    stableReleaseKeyFingerprint(releaseVerificationKey);
  const stableAuthorizerKeyFingerprint =
    stableReleaseKeyFingerprint(stableAuthorizerVerificationKey);
  if (
    bytesSha256(files.releaseKeyBytes)
      !== input.manifest.historicalPublicKeys[0].bytesSha256
    || releaseKeyFingerprint
      !== input.manifest.historicalPublicKeys[0].keySha256
    || bytesSha256(files.stableAuthorizerKeyBytes)
      !== input.manifest.historicalPublicKeys[1].bytesSha256
    || stableAuthorizerKeyFingerprint
      !== input.manifest.historicalPublicKeys[1].keySha256
  ) {
    throw new Error("semantic baseline historical public-key bytes mismatch");
  }
  const protectedBaselineMetadata =
    validateSemanticRankingProtectedBaselineMetadataV1(
      parseJson(
        files.assets["protected-semantic-baseline.json"],
        "semantic baseline protected metadata",
      ),
    );
  if (
    semanticRankingProtectedBaselineMetadataSha256(
      protectedBaselineMetadata,
    ) !== input.manifest.predecessor.metadataSha256
    || protectedBaselineMetadata.stableTag
      !== input.manifest.predecessor.stableTag
    || protectedBaselineMetadata.sourceRevision
      !== input.manifest.predecessor.sourceRevision
  ) {
    throw new Error(
      "semantic baseline handoff metadata does not bind the predecessor",
    );
  }
  const releaseIdentitySha256 = semanticBaselineReleaseIdentitySha256({
    releaseId: input.manifest.predecessor.releaseId,
    stableTag: input.manifest.predecessor.stableTag,
    sourceRevision: input.manifest.predecessor.sourceRevision,
    metadataSha256: input.manifest.predecessor.metadataSha256,
    assetSha256: assetHashes,
  });
  if (
    releaseIdentitySha256
      !== input.manifest.predecessor.releaseIdentitySha256
  ) {
    throw new Error("semantic baseline handoff release identity mismatch");
  }
  const stableReleaseConsumer = validateConsumerBindings({
    value: parseJson(
      files.assets["stable-release-consumer.json"],
      "semantic baseline stored consumer manifest",
    ),
    metadataSha256: input.manifest.predecessor.metadataSha256,
    stableTag: input.manifest.predecessor.stableTag,
    sourceRevision: input.manifest.predecessor.sourceRevision,
    releaseVerificationKeySha256: releaseKeyFingerprint,
    stableAuthorizerKeyId:
      input.manifest.predecessor.stableAuthorizerKeyId,
    stableAuthorizerKeySha256: stableAuthorizerKeyFingerprint,
  });
  const stableImageAttestation = record(
    parseJson(
      files.assets["stable-image-attestation.json"],
      "semantic baseline stored image attestation",
    ),
    "semantic baseline stored image attestation",
  );
  return {
    manifest: input.manifest,
    manifestSha256:
      semanticBaselineHandoffManifestSha256(input.manifest),
    releaseAssets: files.assets,
    releaseVerificationKey: {
      bytes: files.releaseKeyBytes,
      key: releaseVerificationKey,
    },
    stableAuthorizerVerificationKey: {
      bytes: files.stableAuthorizerKeyBytes,
      key: stableAuthorizerVerificationKey,
    },
    protectedBaselineMetadata,
    finalizationEvidence: parseJson(
      files.assets["finalization-evidence.json"],
      "semantic baseline signed finalization evidence",
    ),
    stableAuthorization: parseJson(
      files.assets["stable-authorization.json"],
      "semantic baseline signed stable authorization",
    ),
    stableReleaseConsumer,
    stableImageAttestation,
  };
}

export async function createSemanticBaselineHandoff(input: {
  directory: string;
  manifestOutputPath: string;
  candidateTag: string;
  candidateSourceRevision: string;
  predecessorReleaseId: number;
  predecessorStableTag: string;
  predecessorSourceRevision: string;
  predecessorReleaseIdentitySha256: string;
  metadataSha256: string;
  assetSha256: Record<SemanticBaselineReleaseAssetName, string>;
  releaseVerificationKeySha256: string;
  stableAuthorizerKeyId: string;
  stableAuthorizerKeySha256: string;
}): Promise<{
  manifest: SemanticBaselineHandoffManifestV1;
  manifestSha256: string;
}> {
  const directory = await exactDirectory(
    input.directory,
    [
      ...SEMANTIC_BASELINE_RELEASE_ASSET_NAMES,
      SEMANTIC_BASELINE_RELEASE_KEY_FILE,
      SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_FILE,
    ],
    "semantic baseline handoff input",
  );
  if (
    resolve(input.manifestOutputPath)
      !== join(directory, SEMANTIC_BASELINE_HANDOFF_MANIFEST)
  ) {
    throw new Error(
      "semantic baseline handoff manifest must be written inside the exact bundle",
    );
  }
  const releaseAssets = SEMANTIC_BASELINE_RELEASE_ASSET_NAMES.map((name) => ({
    name,
    sha256: digest(
      input.assetSha256[name],
      `semantic baseline selected asset ${name}`,
    ),
  }));
  const provisional: SemanticBaselineHandoffManifestV1 = {
    schemaVersion: SEMANTIC_BASELINE_HANDOFF_SCHEMA_V1,
    candidate: {
      tag: input.candidateTag,
      sourceRevision: input.candidateSourceRevision,
    },
    predecessor: {
      releaseId: input.predecessorReleaseId,
      stableTag: input.predecessorStableTag,
      sourceRevision: input.predecessorSourceRevision,
      releaseIdentitySha256: input.predecessorReleaseIdentitySha256,
      metadataSha256: input.metadataSha256,
      releaseVerificationKeySha256:
        input.releaseVerificationKeySha256,
      stableAuthorizerKeyId: input.stableAuthorizerKeyId,
      stableAuthorizerKeySha256:
        input.stableAuthorizerKeySha256,
    },
    releaseAssets,
    historicalPublicKeys: [
      {
        name: SEMANTIC_BASELINE_RELEASE_KEY_FILE,
        bytesSha256: "0".repeat(64),
        keySha256: input.releaseVerificationKeySha256,
      },
      {
        name: SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_FILE,
        bytesSha256: "0".repeat(64),
        keySha256: input.stableAuthorizerKeySha256,
      },
    ],
  };
  const files = await loadBundleFiles(
    directory,
    [
      ...SEMANTIC_BASELINE_RELEASE_ASSET_NAMES,
      SEMANTIC_BASELINE_RELEASE_KEY_FILE,
      SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_FILE,
    ],
  );
  const manifest = validateSemanticBaselineHandoffManifestV1({
    ...provisional,
    historicalPublicKeys: [
      {
        ...provisional.historicalPublicKeys[0],
        bytesSha256: bytesSha256(files.releaseKeyBytes),
      },
      {
        ...provisional.historicalPublicKeys[1],
        bytesSha256: bytesSha256(files.stableAuthorizerKeyBytes),
      },
    ],
  });
  await validateBundleAgainstManifest({
    manifest,
    directory,
    expectedNames: [
      ...SEMANTIC_BASELINE_RELEASE_ASSET_NAMES,
      SEMANTIC_BASELINE_RELEASE_KEY_FILE,
      SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_FILE,
    ],
  });
  await writeFile(
    input.manifestOutputPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return {
    manifest,
    manifestSha256: semanticBaselineHandoffManifestSha256(manifest),
  };
}

export async function loadSemanticBaselineHandoff(input: {
  directory: string;
  expectedManifestSha256: string;
  expectedCandidateTag: string;
  expectedCandidateSourceRevision: string;
  expectedMetadataSha256: string;
  expectedStableTag: string;
  expectedReleaseVerificationKeySha256: string;
  expectedStableAuthorizerKeyId: string;
  expectedStableAuthorizerKeySha256: string;
}): Promise<LoadedSemanticBaselineHandoffV1> {
  const directory = await exactDirectory(
    input.directory,
    [
      ...SEMANTIC_BASELINE_RELEASE_ASSET_NAMES,
      SEMANTIC_BASELINE_RELEASE_KEY_FILE,
      SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_FILE,
      SEMANTIC_BASELINE_HANDOFF_MANIFEST,
    ],
    "semantic baseline handoff",
  );
  const manifest = validateSemanticBaselineHandoffManifestV1(
    parseJson(
      await regularFileBytes(
        join(directory, SEMANTIC_BASELINE_HANDOFF_MANIFEST),
        "semantic baseline handoff manifest",
        MAX_ASSET_BYTES,
      ),
      "semantic baseline handoff manifest",
    ),
  );
  const manifestSha256 = semanticBaselineHandoffManifestSha256(manifest);
  if (
    manifestSha256
      !== digest(
        input.expectedManifestSha256,
        "expected semantic baseline handoff hash",
      )
    || manifest.candidate.tag !== input.expectedCandidateTag
    || manifest.candidate.sourceRevision
      !== input.expectedCandidateSourceRevision
    || manifest.predecessor.metadataSha256
      !== input.expectedMetadataSha256
    || manifest.predecessor.stableTag !== input.expectedStableTag
    || manifest.predecessor.releaseVerificationKeySha256
      !== input.expectedReleaseVerificationKeySha256
    || manifest.predecessor.stableAuthorizerKeyId
      !== input.expectedStableAuthorizerKeyId
    || manifest.predecessor.stableAuthorizerKeySha256
      !== input.expectedStableAuthorizerKeySha256
  ) {
    throw new Error(
      "semantic baseline handoff does not match the protected candidate and predecessor pins",
    );
  }
  return validateBundleAgainstManifest({
    manifest,
    directory,
    expectedNames: [
      ...SEMANTIC_BASELINE_RELEASE_ASSET_NAMES,
      SEMANTIC_BASELINE_RELEASE_KEY_FILE,
      SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_FILE,
      SEMANTIC_BASELINE_HANDOFF_MANIFEST,
    ],
  });
}

function options(
  argv: readonly string[],
  allowed: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index] ?? "";
    const value = argv[index + 1] ?? "";
    if (!allowed.has(name)) throw new Error(`Unknown argument: ${name}`);
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
    values.set(name, value);
  }
  return values;
}

function required(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function decodedAssetHashes(value: string): Record<
  SemanticBaselineReleaseAssetName,
  string
> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    throw new Error("--asset-sha256-json-b64url is invalid");
  }
  if (!value || bytes.toString("base64url") !== value) {
    throw new Error("--asset-sha256-json-b64url is not canonical base64url");
  }
  return validateAssetHashMap(
    parseJson(bytes, "--asset-sha256-json-b64url"),
    "selected semantic baseline asset hashes",
  );
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "create") {
    const values = options(argv, new Set([
      "--directory",
      "--manifest-output",
      "--candidate-tag",
      "--candidate-source-revision",
      "--predecessor-release-id",
      "--predecessor-stable-tag",
      "--predecessor-source-revision",
      "--predecessor-release-identity-sha256",
      "--metadata-sha256",
      "--asset-sha256-json-b64url",
      "--release-verification-key-sha256",
      "--stable-authorizer-key-id",
      "--stable-authorizer-key-sha256",
      "--github-output",
    ]));
    const releaseId = Number(required(values, "--predecessor-release-id"));
    if (!Number.isSafeInteger(releaseId) || releaseId <= 0) {
      throw new Error("--predecessor-release-id must be a positive integer");
    }
    const created = await createSemanticBaselineHandoff({
      directory: required(values, "--directory"),
      manifestOutputPath: required(values, "--manifest-output"),
      candidateTag: required(values, "--candidate-tag"),
      candidateSourceRevision:
        required(values, "--candidate-source-revision"),
      predecessorReleaseId: releaseId,
      predecessorStableTag:
        required(values, "--predecessor-stable-tag"),
      predecessorSourceRevision:
        required(values, "--predecessor-source-revision"),
      predecessorReleaseIdentitySha256:
        required(values, "--predecessor-release-identity-sha256"),
      metadataSha256: required(values, "--metadata-sha256"),
      assetSha256: decodedAssetHashes(
        required(values, "--asset-sha256-json-b64url"),
      ),
      releaseVerificationKeySha256:
        required(values, "--release-verification-key-sha256"),
      stableAuthorizerKeyId:
        required(values, "--stable-authorizer-key-id"),
      stableAuthorizerKeySha256:
        required(values, "--stable-authorizer-key-sha256"),
    });
    await appendFile(
      required(values, "--github-output"),
      `sha256=${created.manifestSha256}\n`,
      { encoding: "utf8" },
    );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      manifestSha256: created.manifestSha256,
    })}\n`);
    return;
  }
  if (command === "verify") {
    const values = options(argv, new Set([
      "--directory",
      "--expected-manifest-sha256",
      "--candidate-tag",
      "--candidate-source-revision",
      "--metadata-sha256",
      "--stable-tag",
      "--release-verification-key-sha256",
      "--stable-authorizer-key-id",
      "--stable-authorizer-key-sha256",
    ]));
    const loaded = await loadSemanticBaselineHandoff({
      directory: required(values, "--directory"),
      expectedManifestSha256:
        required(values, "--expected-manifest-sha256"),
      expectedCandidateTag: required(values, "--candidate-tag"),
      expectedCandidateSourceRevision:
        required(values, "--candidate-source-revision"),
      expectedMetadataSha256: required(values, "--metadata-sha256"),
      expectedStableTag: required(values, "--stable-tag"),
      expectedReleaseVerificationKeySha256:
        required(values, "--release-verification-key-sha256"),
      expectedStableAuthorizerKeyId:
        required(values, "--stable-authorizer-key-id"),
      expectedStableAuthorizerKeySha256:
        required(values, "--stable-authorizer-key-sha256"),
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      manifestSha256: loaded.manifestSha256,
    })}\n`);
    return;
  }
  throw new Error("Usage: semantic-baseline-handoff create|verify ...");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "semantic_baseline_handoff_failed",
      message: "Semantic baseline handoff failed closed",
    })}\n`);
    process.exitCode = 1;
  });
}
