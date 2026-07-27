import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
} from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  APPLE_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
  PROVIDER_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
  QA_BUDGET_LEDGER_MAX_AGE_MS,
  QA_BUDGET_LEDGER_RECEIPT_SCHEMA_V1,
  SIGNED_APPLE_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
  SIGNED_PROVIDER_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
  SIGNED_QA_BUDGET_LEDGER_RECEIPT_SCHEMA_V1,
  controlPlaneReceiptKeyFingerprint,
  controlPlaneReceiptTrustPolicyV1,
  verifyAppleControlPlaneReceipt,
  verifyProviderControlPlaneReceipt,
  verifyQaBudgetLedgerReceipt,
  type ControlPlaneEvidencePhase,
  type ControlPlaneReceiptKind,
} from "../shared/staging-control-plane-receipts.ts";
import {
  createStrictSignedEnvelope,
  exactObject,
  sha256Digest,
  verifyStrictSignedEnvelope,
  type JsonRecord,
} from "../shared/signed-artifact.ts";
import {
  validateRuntimeSnapshot,
  type LoadedRuntimeSnapshotV1,
} from "./release-evidence.ts";

export const APPLE_CONTROL_PLANE_AUTHORITY_SOURCE_SCHEMA_V1 =
  "genio-apple-control-plane-authority-source/v1";
export const PROVIDER_CONTROL_PLANE_AUTHORITY_SOURCE_SCHEMA_V1 =
  "genio-provider-control-plane-authority-source/v1";
export const QA_BUDGET_LEDGER_AUTHORITY_SOURCE_SCHEMA_V1 =
  "genio-qa-budget-ledger-authority-source/v1";
export const SIGNED_APPLE_CONTROL_PLANE_AUTHORITY_SOURCE_SCHEMA_V1 =
  "genio-signed-apple-control-plane-authority-source/v1";
export const SIGNED_PROVIDER_CONTROL_PLANE_AUTHORITY_SOURCE_SCHEMA_V1 =
  "genio-signed-provider-control-plane-authority-source/v1";
export const SIGNED_QA_BUDGET_LEDGER_AUTHORITY_SOURCE_SCHEMA_V1 =
  "genio-signed-qa-budget-ledger-authority-source/v1";

export type ControlPlaneReceiptProducerKind =
  | "apple"
  | "provider"
  | "qa-budget";

const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_REFERENCE =
  /^ghcr\.io\/[0-9a-z](?:[0-9a-z._/-]*[0-9a-z])?@sha256:[0-9a-f]{64}$/u;
const SAFE_LABEL = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u;
const MAX_RUNTIME_SNAPSHOT_AGE_MS = 24 * 60 * 60_000;
const AUTHORITY_SOURCE_MAX_AGE_MS = 15 * 60_000;
const AUTHORITY_SOURCE_MAX_TTL_MS = 60 * 60_000;
const STANDARD_RECEIPT_TTL_MS = 60 * 60_000;
const QA_BUDGET_RECEIPT_TTL_MS = 15 * 60_000;

export interface ControlPlaneReceiptProducerArgs {
  kind: ControlPlaneReceiptProducerKind;
  phase: ControlPlaneEvidencePhase;
  candidateImageDigest: string;
  candidateImageReference: string;
  stagingRuntimeSnapshotPath: string;
  productionRuntimeSnapshotPath: string | null;
  authoritySourcePath: string;
  authoritySourceVerificationKeyPath: string;
  signingKeyPath: string;
  outputPath: string;
  verificationKeyOutputPath: string;
  issuer: string;
  keyId: string;
  keySha256: string;
  sourceIssuer: string;
  sourceKeyId: string;
  sourceKeySha256: string;
  stagingOrigin: string;
  protectedKeyFingerprints: string[];
}

interface ReceiptProducerContext {
  args: ControlPlaneReceiptProducerArgs;
  generatedAt: string;
  now: number;
  stagingSnapshot: LoadedRuntimeSnapshotV1;
  productionSnapshot: LoadedRuntimeSnapshotV1 | null;
  candidate: {
    version: string;
    sourceRevision: string;
    imageDigest: string;
    imageReference: string;
  };
}

function option(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : "";
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function optionalOption(argv: readonly string[], name: string): string | null {
  return argv.includes(name) ? option(argv, name) : null;
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim() ?? "";
  if (!value) {
    throw new Error(`${name} is required in the protected authority environment`);
  }
  return value;
}

function receiptEnvironmentPrefix(
  kind: ControlPlaneReceiptProducerKind,
): "RELEASE_APPLE_CONTROL_PLANE"
  | "RELEASE_PROVIDER_CONTROL_PLANE"
  | "RELEASE_QA_BUDGET_LEDGER" {
  if (kind === "apple") return "RELEASE_APPLE_CONTROL_PLANE";
  if (kind === "provider") return "RELEASE_PROVIDER_CONTROL_PLANE";
  return "RELEASE_QA_BUDGET_LEDGER";
}

function receiptKind(
  kind: ControlPlaneReceiptProducerKind,
): ControlPlaneReceiptKind {
  return kind === "qa-budget" ? "qa_budget" : kind;
}

function phase(value: string): ControlPlaneEvidencePhase {
  if (
    value !== "candidate"
    && value !== "promotion"
    && value !== "finalization"
  ) {
    throw new Error("--phase must be candidate, promotion, or finalization");
  }
  return value;
}

function safeLabel(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !SAFE_LABEL.test(value)
    || /(?:secret|token|password|sk-)/iu.test(value)
  ) {
    throw new Error(`${label} must be an approved authority label`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function httpsStagingOrigin(value: string): string {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("RELEASE_STAGING_ORIGIN must be an HTTPS origin");
  }
  if (
    origin.protocol !== "https:"
    || origin.origin !== value
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
    || origin.username
    || origin.password
    || origin.hostname === "9enio.com"
    || origin.hostname === "www.9enio.com"
  ) {
    throw new Error(
      "RELEASE_STAGING_ORIGIN must be the dedicated staging HTTPS origin",
    );
  }
  return value;
}

function protectedFingerprint(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  return sha256Digest(
    requiredEnvironment(environment, name).toLowerCase(),
    name,
  );
}

export function parseControlPlaneReceiptProducerArgs(
  kindValue: string,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): ControlPlaneReceiptProducerArgs {
  if (
    kindValue !== "apple"
    && kindValue !== "provider"
    && kindValue !== "qa-budget"
  ) {
    throw new Error("receipt producer kind must be apple, provider, or qa-budget");
  }
  const allowed = new Set([
    "--phase",
    "--candidate-image-digest",
    "--staging-runtime-snapshot",
    "--production-runtime-snapshot",
    "--authority-source",
    "--authority-source-verification-key",
    "--signing-key",
    "--output",
    "--verification-key-output",
  ]);
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index] ?? "";
    if (!allowed.has(argument)) {
      throw new Error(`Unknown argument: ${String(argv[index])}`);
    }
    if (seen.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    seen.add(argument);
    if (argv[index + 1] === undefined || argv[index + 1]!.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
  }
  const selectedPhase = phase(option(argv, "--phase"));
  const productionRuntimeSnapshotPath = optionalOption(
    argv,
    "--production-runtime-snapshot",
  );
  if (
    (selectedPhase === "candidate" && productionRuntimeSnapshotPath !== null)
    || (selectedPhase !== "candidate" && productionRuntimeSnapshotPath === null)
  ) {
    throw new Error(
      "candidate receipts forbid a production runtime snapshot; promotion and finalization require one",
    );
  }
  const candidateImageDigest =
    option(argv, "--candidate-image-digest").toLowerCase();
  if (!IMAGE_DIGEST.test(candidateImageDigest)) {
    throw new Error(
      "--candidate-image-digest must be an immutable SHA-256 image digest",
    );
  }
  const candidateImageReference = requiredEnvironment(
    environment,
    "RELEASE_CANDIDATE_IMAGE_REFERENCE",
  ).toLowerCase();
  if (
    !IMAGE_REFERENCE.test(candidateImageReference)
    || !candidateImageReference.endsWith(`@${candidateImageDigest}`)
  ) {
    throw new Error(
      "RELEASE_CANDIDATE_IMAGE_REFERENCE must exactly match the candidate digest",
    );
  }
  const prefix = receiptEnvironmentPrefix(kindValue);
  const keyId = safeLabel(
    requiredEnvironment(environment, `${prefix}_KEY_ID`),
    `${prefix}_KEY_ID`,
  );
  const sourceKeyId = safeLabel(
    requiredEnvironment(environment, `${prefix}_SOURCE_KEY_ID`),
    `${prefix}_SOURCE_KEY_ID`,
  );
  const protectedKeyFingerprints = [
    protectedFingerprint(
      environment,
      "RELEASE_STAGING_CONTROL_PLANE_KEY_SHA256",
    ),
    protectedFingerprint(
      environment,
      "RELEASE_APPLE_CONTROL_PLANE_KEY_SHA256",
    ),
    protectedFingerprint(
      environment,
      "RELEASE_PROVIDER_CONTROL_PLANE_KEY_SHA256",
    ),
    protectedFingerprint(
      environment,
      "RELEASE_QA_BUDGET_LEDGER_KEY_SHA256",
    ),
    protectedFingerprint(
      environment,
      "RELEASE_APPLE_CONTROL_PLANE_SOURCE_KEY_SHA256",
    ),
    protectedFingerprint(
      environment,
      "RELEASE_PROVIDER_CONTROL_PLANE_SOURCE_KEY_SHA256",
    ),
    protectedFingerprint(
      environment,
      "RELEASE_QA_BUDGET_LEDGER_SOURCE_KEY_SHA256",
    ),
    ...(selectedPhase === "candidate"
      ? []
      : [
        protectedFingerprint(
          environment,
          "RELEASE_CANDIDATE_EVIDENCE_KEY_SHA256",
        ),
      ]),
  ];
  if (
    new Set(protectedKeyFingerprints).size
      !== protectedKeyFingerprints.length
  ) {
    throw new Error(
      "control-plane aggregate, source, receipt, and candidate evidence keys must be distinct",
    );
  }
  return {
    kind: kindValue,
    phase: selectedPhase,
    candidateImageDigest,
    candidateImageReference,
    stagingRuntimeSnapshotPath:
      option(argv, "--staging-runtime-snapshot"),
    productionRuntimeSnapshotPath,
    authoritySourcePath: option(argv, "--authority-source"),
    authoritySourceVerificationKeyPath:
      option(argv, "--authority-source-verification-key"),
    signingKeyPath: option(argv, "--signing-key"),
    outputPath: option(argv, "--output"),
    verificationKeyOutputPath:
      option(argv, "--verification-key-output"),
    issuer: safeLabel(
      requiredEnvironment(environment, `${prefix}_ISSUER`),
      `${prefix}_ISSUER`,
    ),
    keyId,
    keySha256: protectedFingerprint(environment, `${prefix}_KEY_SHA256`),
    sourceIssuer: safeLabel(
      requiredEnvironment(environment, `${prefix}_SOURCE_ISSUER`),
      `${prefix}_SOURCE_ISSUER`,
    ),
    sourceKeyId,
    sourceKeySha256: protectedFingerprint(
      environment,
      `${prefix}_SOURCE_KEY_SHA256`,
    ),
    stagingOrigin: httpsStagingOrigin(
      requiredEnvironment(environment, "RELEASE_STAGING_ORIGIN"),
    ),
    protectedKeyFingerprints,
  };
}

function privateKey(value: string | Buffer | KeyObject): KeyObject {
  try {
    const key = value instanceof KeyObject ? value : createPrivateKey(value);
    if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
      throw new Error("wrong key");
    }
    return key;
  } catch {
    throw new Error("receipt signing key must be a readable Ed25519 private key");
  }
}

function publicKey(value: string | Buffer | KeyObject): KeyObject {
  try {
    const parsed = value instanceof KeyObject ? value : createPublicKey(value);
    const key = parsed.type === "private" ? createPublicKey(parsed) : parsed;
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key");
    return key;
  } catch {
    throw new Error(
      "authority source verification key must be a readable Ed25519 public key",
    );
  }
}

function money(value: unknown, label: string, positive = false): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || (positive && value <= 0)
    || Math.round(value * 1_000_000) !== value * 1_000_000
  ) {
    throw new Error(`${label} must be a safe USD amount`);
  }
  return value;
}

function candidateSourceBinding(value: unknown): JsonRecord {
  const candidate = exactObject(value, [
    "version",
    "sourceRevision",
    "imageDigest",
    "imageReference",
  ], "authority source candidate");
  if (
    typeof candidate.version !== "string"
    || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u
      .test(candidate.version)
    || typeof candidate.sourceRevision !== "string"
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
      .test(candidate.sourceRevision)
    || typeof candidate.imageDigest !== "string"
    || !IMAGE_DIGEST.test(candidate.imageDigest)
    || typeof candidate.imageReference !== "string"
    || !IMAGE_REFERENCE.test(candidate.imageReference)
    || !candidate.imageReference.endsWith(`@${candidate.imageDigest}`)
  ) {
    throw new Error("authority source candidate is invalid");
  }
  return candidate;
}

function commonAuthoritySource(
  value: unknown,
  expectedSchema: string,
  label: string,
): JsonRecord {
  const source = exactObject(value, [
    "schemaVersion",
    "issuer",
    "generatedAt",
    "expiresAt",
    "phase",
    "candidate",
    "runtimeSnapshots",
    "authority",
  ], label);
  if (
    source.schemaVersion !== expectedSchema
    || (
      source.phase !== "candidate"
      && source.phase !== "promotion"
      && source.phase !== "finalization"
    )
  ) {
    throw new Error(`${label} uses an unsupported schema or phase`);
  }
  safeLabel(source.issuer, `${label} issuer`);
  timestamp(source.generatedAt, `${label} generatedAt`);
  timestamp(source.expiresAt, `${label} expiresAt`);
  candidateSourceBinding(source.candidate);
  const snapshots = exactObject(source.runtimeSnapshots, [
    "staging",
    "production",
  ], `${label} runtime snapshots`);
  sha256Digest(snapshots.staging, `${label} staging runtime snapshot`);
  if (
    (source.phase === "candidate" && snapshots.production !== null)
    || (source.phase !== "candidate" && snapshots.production === null)
  ) {
    throw new Error(`${label} runtime snapshots do not match its phase`);
  }
  if (snapshots.production !== null) {
    sha256Digest(snapshots.production, `${label} production runtime snapshot`);
  }
  return source;
}

function validateAppleAuthoritySource(value: unknown): JsonRecord {
  const source = commonAuthoritySource(
    value,
    APPLE_CONTROL_PLANE_AUTHORITY_SOURCE_SCHEMA_V1,
    "Apple control-plane authority source",
  );
  const authority = exactObject(source.authority, [
    "stagingAppleQaVerifierCredentialIdentityHash",
    "productionAppleQaVerifierCredentialIdentityHash",
    "stagingAppleAccountIdHash",
    "productionAppleAccountIdHash",
    "productionAppleCredentialVersionHash",
    "productionAppleQaVerifierCredentialVersionHash",
    "musicKitOriginRegistered",
    "musicKitOriginRegistrationEvidenceHash",
  ], "Apple control-plane authority facts");
  if (authority.musicKitOriginRegistered !== true) {
    throw new Error("Apple authority did not attest the staging MusicKit origin");
  }
  for (const field of [
    "stagingAppleQaVerifierCredentialIdentityHash",
    "productionAppleQaVerifierCredentialIdentityHash",
    "stagingAppleAccountIdHash",
    "productionAppleAccountIdHash",
    "productionAppleCredentialVersionHash",
    "productionAppleQaVerifierCredentialVersionHash",
    "musicKitOriginRegistrationEvidenceHash",
  ]) {
    sha256Digest(authority[field], `Apple authority fact ${field}`);
  }
  if (
    authority.stagingAppleQaVerifierCredentialIdentityHash
      === authority.productionAppleQaVerifierCredentialIdentityHash
    || authority.stagingAppleAccountIdHash
      === authority.productionAppleAccountIdHash
  ) {
    throw new Error("Apple authority source does not prove separate identities");
  }
  return source;
}

function validateProviderAuthoritySource(value: unknown): JsonRecord {
  const source = commonAuthoritySource(
    value,
    PROVIDER_CONTROL_PLANE_AUTHORITY_SOURCE_SCHEMA_V1,
    "provider control-plane authority source",
  );
  const authority = exactObject(source.authority, [
    "stagingProviderProjectIdentityHash",
    "productionProviderProjectIdentityHash",
    "productionProviderCredentialVersionHash",
  ], "provider control-plane authority facts");
  for (const field of [
    "stagingProviderProjectIdentityHash",
    "productionProviderProjectIdentityHash",
    "productionProviderCredentialVersionHash",
  ]) {
    sha256Digest(authority[field], `provider authority fact ${field}`);
  }
  if (
    authority.stagingProviderProjectIdentityHash
      === authority.productionProviderProjectIdentityHash
  ) {
    throw new Error("provider authority source does not prove separate projects");
  }
  return source;
}

function validateBudgetAuthoritySource(value: unknown): JsonRecord {
  const source = commonAuthoritySource(
    value,
    QA_BUDGET_LEDGER_AUTHORITY_SOURCE_SCHEMA_V1,
    "QA budget-ledger authority source",
  );
  const authority = exactObject(source.authority, [
    "ledgerScope",
    "currency",
    "monthlyCostLimitUsd",
    "spentUsd",
    "reservedForRequiredGatesUsd",
    "asOf",
  ], "QA budget-ledger authority facts");
  if (
    authority.ledgerScope !== "staging_release_qa"
    || authority.currency !== "USD"
  ) {
    throw new Error("QA budget authority source is for the wrong ledger");
  }
  const limit = money(authority.monthlyCostLimitUsd, "QA monthly limit", true);
  const spent = money(authority.spentUsd, "QA spent amount");
  const reserved = money(
    authority.reservedForRequiredGatesUsd,
    "QA reserved gate amount",
    true,
  );
  timestamp(authority.asOf, "QA ledger asOf");
  if (spent > limit || reserved > limit - spent) {
    throw new Error("QA budget authority source cannot cover required gates");
  }
  return source;
}

function authoritySourceSchema(
  kind: ControlPlaneReceiptProducerKind,
): {
  envelope: string;
  validate: (value: unknown) => JsonRecord;
} {
  if (kind === "apple") {
    return {
      envelope: SIGNED_APPLE_CONTROL_PLANE_AUTHORITY_SOURCE_SCHEMA_V1,
      validate: validateAppleAuthoritySource,
    };
  }
  if (kind === "provider") {
    return {
      envelope: SIGNED_PROVIDER_CONTROL_PLANE_AUTHORITY_SOURCE_SCHEMA_V1,
      validate: validateProviderAuthoritySource,
    };
  }
  return {
    envelope: SIGNED_QA_BUDGET_LEDGER_AUTHORITY_SOURCE_SCHEMA_V1,
    validate: validateBudgetAuthoritySource,
  };
}

function verifyAuthoritySource(input: {
  value: unknown;
  verificationKey: KeyObject;
  context: ReceiptProducerContext;
}): JsonRecord {
  const schema = authoritySourceSchema(input.context.args.kind);
  if (
    controlPlaneReceiptKeyFingerprint(input.verificationKey)
      !== input.context.args.sourceKeySha256
  ) {
    throw new Error(
      "authority source does not use its protected independent key",
    );
  }
  const verified = verifyStrictSignedEnvelope({
    value: input.value,
    verificationKey: input.verificationKey,
    envelopeSchemaVersion: schema.envelope,
    payloadLabel: `${input.context.args.kind} authority source`,
    validatePayload: schema.validate,
  });
  if (
    verified.keyId !== input.context.args.sourceKeyId
    || verified.payload.issuer !== input.context.args.sourceIssuer
  ) {
    throw new Error(
      "authority source key ID or issuer is not protected and approved",
    );
  }
  const generatedAt = Date.parse(String(verified.payload.generatedAt));
  const expiresAt = Date.parse(String(verified.payload.expiresAt));
  if (
    expiresAt <= generatedAt
    || expiresAt - generatedAt > AUTHORITY_SOURCE_MAX_TTL_MS
    || generatedAt > input.context.now + 5 * 60_000
    || input.context.now - generatedAt > AUTHORITY_SOURCE_MAX_AGE_MS
    || input.context.now >= expiresAt
  ) {
    throw new Error("authority source is stale, future-dated, or expired");
  }
  const candidate = verified.payload.candidate as JsonRecord;
  const snapshots = verified.payload.runtimeSnapshots as JsonRecord;
  if (
    verified.payload.phase !== input.context.args.phase
    || candidate.version !== input.context.candidate.version
    || candidate.sourceRevision !== input.context.candidate.sourceRevision
    || candidate.imageDigest !== input.context.candidate.imageDigest
    || candidate.imageReference !== input.context.candidate.imageReference
    || snapshots.staging !== input.context.stagingSnapshot.snapshotHash
    || snapshots.production
      !== (input.context.productionSnapshot?.snapshotHash ?? null)
  ) {
    throw new Error(
      "authority source does not bind the exact phase, candidate, and runtime snapshots",
    );
  }
  if (input.context.args.kind === "qa-budget") {
    const authority = verified.payload.authority as JsonRecord;
    const asOf = Date.parse(String(authority.asOf));
    if (
      asOf > input.context.now + 5 * 60_000
      || input.context.now - asOf > QA_BUDGET_LEDGER_MAX_AGE_MS
    ) {
      throw new Error("QA authority ledger position is stale");
    }
  }
  return verified.payload;
}

function assertFreshSnapshot(
  snapshot: LoadedRuntimeSnapshotV1,
  expectedOrigin: string,
  now: number,
): void {
  const generatedAt = Date.parse(snapshot.generatedAt);
  if (
    snapshot.origin !== expectedOrigin
    || generatedAt > now + 5 * 60_000
    || now - generatedAt > MAX_RUNTIME_SNAPSHOT_AGE_MS
  ) {
    throw new Error(
      `${snapshot.environment} runtime snapshot is stale or has the wrong origin`,
    );
  }
}

async function assertOutputDoesNotExist(path: string): Promise<void> {
  try {
    await access(path);
    throw new Error(`receipt output already exists: ${path}`);
  } catch (error) {
    if (
      !(error instanceof Error)
      || !("code" in error)
      || error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

export async function produceControlPlaneReceipt(input: {
  args: ControlPlaneReceiptProducerArgs;
  now?: string;
}): Promise<{
  envelope: ReturnType<typeof createStrictSignedEnvelope>;
  verificationKey: string;
}> {
  if (
    input.args.protectedKeyFingerprints.length < 7
    || new Set(input.args.protectedKeyFingerprints).size
      !== input.args.protectedKeyFingerprints.length
    || !input.args.protectedKeyFingerprints.includes(input.args.keySha256)
    || !input.args.protectedKeyFingerprints.includes(
      input.args.sourceKeySha256,
    )
    || input.args.keySha256 === input.args.sourceKeySha256
  ) {
    throw new Error(
      "receipt producer requires distinct protected aggregate, source, and authority keys",
    );
  }
  const generatedAt = input.now ?? new Date().toISOString();
  const now = Date.parse(timestamp(generatedAt, "receipt generation time"));
  const paths = [
    input.args.stagingRuntimeSnapshotPath,
    input.args.productionRuntimeSnapshotPath,
    input.args.authoritySourcePath,
    input.args.authoritySourceVerificationKeyPath,
    input.args.signingKeyPath,
    input.args.outputPath,
    input.args.verificationKeyOutputPath,
  ].filter((value): value is string => value !== null).map((value) =>
    resolve(value)
  );
  if (new Set(paths).size !== paths.length) {
    throw new Error("receipt input, key, and output paths must be distinct");
  }
  await Promise.all([
    assertOutputDoesNotExist(input.args.outputPath),
    assertOutputDoesNotExist(input.args.verificationKeyOutputPath),
  ]);
  const [
    stagingSnapshotValue,
    productionSnapshotValue,
    authoritySourceValue,
    authoritySourceVerificationKeyValue,
    signingKeySource,
  ] = await Promise.all([
    readFile(input.args.stagingRuntimeSnapshotPath, "utf8"),
    input.args.productionRuntimeSnapshotPath === null
      ? Promise.resolve(null)
      : readFile(input.args.productionRuntimeSnapshotPath, "utf8"),
    readFile(input.args.authoritySourcePath, "utf8"),
    readFile(input.args.authoritySourceVerificationKeyPath),
    readFile(input.args.signingKeyPath),
  ]);
  const stagingSnapshot = validateRuntimeSnapshot(
    JSON.parse(stagingSnapshotValue),
    "staging",
    "full",
  );
  const productionSnapshot = productionSnapshotValue === null
    ? null
    : validateRuntimeSnapshot(
      JSON.parse(productionSnapshotValue),
      "production",
      input.args.phase === "finalization" ? "full" : "backend",
    );
  if (
    (input.args.phase === "candidate" && productionSnapshot !== null)
    || (input.args.phase !== "candidate" && productionSnapshot === null)
  ) {
    throw new Error("runtime snapshot set does not match the receipt phase");
  }
  assertFreshSnapshot(stagingSnapshot, input.args.stagingOrigin, now);
  if (productionSnapshot) {
    assertFreshSnapshot(productionSnapshot, "https://9enio.com", now);
    if (
      productionSnapshot.candidate.version !== stagingSnapshot.candidate.version
      || productionSnapshot.candidate.sourceRevision
        !== stagingSnapshot.candidate.sourceRevision
    ) {
      throw new Error("receipt runtime snapshots do not bind one candidate");
    }
  }
  const signingKey = privateKey(signingKeySource);
  const verificationKey = createPublicKey(signingKey);
  if (
    controlPlaneReceiptKeyFingerprint(verificationKey)
      !== input.args.keySha256
  ) {
    throw new Error("receipt signer does not use its protected approved key");
  }
  const candidate = {
    version: stagingSnapshot.candidate.version,
    sourceRevision: stagingSnapshot.candidate.sourceRevision,
    imageDigest: input.args.candidateImageDigest,
    imageReference: input.args.candidateImageReference,
  };
  const context: ReceiptProducerContext = {
    args: input.args,
    generatedAt,
    now,
    stagingSnapshot,
    productionSnapshot,
    candidate,
  };
  const authoritySource = verifyAuthoritySource({
    value: JSON.parse(authoritySourceValue),
    verificationKey: publicKey(authoritySourceVerificationKeyValue),
    context,
  });
  const authority = authoritySource.authority as JsonRecord;
  const trust = controlPlaneReceiptTrustPolicyV1({
    receiptKind: receiptKind(input.args.kind),
    approvedIssuer: input.args.issuer,
    approvedKeyId: input.args.keyId,
    approvedKeySha256: input.args.keySha256,
  });
  const expiresAt = new Date(
    now + (input.args.kind === "qa-budget"
      ? QA_BUDGET_RECEIPT_TTL_MS
      : STANDARD_RECEIPT_TTL_MS),
  ).toISOString();
  let payload: JsonRecord;
  let envelopeSchemaVersion: string;
  if (input.args.kind === "apple") {
    if (
      productionSnapshot !== null
      && (
        authority.productionAppleCredentialVersionHash
          !== productionSnapshot.credentialVersionHashes.apple
        || authority.productionAppleQaVerifierCredentialVersionHash
          !== productionSnapshot.credentialVersionHashes.appleQaVerifier
      )
    ) {
      throw new Error(
        "signed Apple authority facts do not match the production snapshot",
      );
    }
    payload = {
      schemaVersion: APPLE_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
      phase: input.args.phase,
      issuer: input.args.issuer,
      generatedAt,
      expiresAt,
      candidate,
      staging: {
        runtimeSnapshotHash: stagingSnapshot.snapshotHash,
        appleCredentialVersionHash:
          stagingSnapshot.credentialVersionHashes.apple,
        appleQaVerifierCredentialVersionHash:
          stagingSnapshot.credentialVersionHashes.appleQaVerifier,
        appleQaVerifierCredentialIdentityHash:
          authority.stagingAppleQaVerifierCredentialIdentityHash,
        appleAccountIdHash: authority.stagingAppleAccountIdHash,
        musicKitOrigin: stagingSnapshot.origin,
        musicKitOriginRegistered: true,
        musicKitOriginRegistrationEvidenceHash:
          authority.musicKitOriginRegistrationEvidenceHash,
      },
      production: {
        runtimeSnapshotHash: productionSnapshot?.snapshotHash ?? null,
        appleCredentialVersionHash: productionSnapshot
          ?.credentialVersionHashes.apple
          ?? authority.productionAppleCredentialVersionHash,
        appleQaVerifierCredentialVersionHash: productionSnapshot
          ?.credentialVersionHashes.appleQaVerifier
          ?? authority.productionAppleQaVerifierCredentialVersionHash,
        appleQaVerifierCredentialIdentityHash:
          authority.productionAppleQaVerifierCredentialIdentityHash,
        appleAccountIdHash: authority.productionAppleAccountIdHash,
      },
    };
    envelopeSchemaVersion = SIGNED_APPLE_CONTROL_PLANE_RECEIPT_SCHEMA_V1;
  } else if (input.args.kind === "provider") {
    if (
      productionSnapshot !== null
      && authority.productionProviderCredentialVersionHash
        !== productionSnapshot.credentialVersionHashes.provider
    ) {
      throw new Error(
        "signed provider authority facts do not match the production snapshot",
      );
    }
    payload = {
      schemaVersion: PROVIDER_CONTROL_PLANE_RECEIPT_SCHEMA_V1,
      phase: input.args.phase,
      issuer: input.args.issuer,
      generatedAt,
      expiresAt,
      candidate,
      staging: {
        runtimeSnapshotHash: stagingSnapshot.snapshotHash,
        providerCredentialVersionHash:
          stagingSnapshot.credentialVersionHashes.provider,
        providerProjectIdentityHash:
          authority.stagingProviderProjectIdentityHash,
      },
      production: {
        runtimeSnapshotHash: productionSnapshot?.snapshotHash ?? null,
        providerCredentialVersionHash: productionSnapshot
          ?.credentialVersionHashes.provider
          ?? authority.productionProviderCredentialVersionHash,
        providerProjectIdentityHash:
          authority.productionProviderProjectIdentityHash,
      },
    };
    envelopeSchemaVersion = SIGNED_PROVIDER_CONTROL_PLANE_RECEIPT_SCHEMA_V1;
  } else {
    payload = {
      schemaVersion: QA_BUDGET_LEDGER_RECEIPT_SCHEMA_V1,
      phase: input.args.phase,
      issuer: input.args.issuer,
      generatedAt,
      expiresAt,
      candidate,
      runtimeSnapshots: {
        staging: stagingSnapshot.snapshotHash,
        production: productionSnapshot?.snapshotHash ?? null,
      },
      ledgerScope: authority.ledgerScope,
      currency: authority.currency,
      monthlyCostLimitUsd: authority.monthlyCostLimitUsd,
      spentUsd: authority.spentUsd,
      reservedForRequiredGatesUsd:
        authority.reservedForRequiredGatesUsd,
      asOf: authority.asOf,
    };
    envelopeSchemaVersion = SIGNED_QA_BUDGET_LEDGER_RECEIPT_SCHEMA_V1;
  }
  const envelope = createStrictSignedEnvelope({
    envelopeSchemaVersion,
    payload,
    signingKey,
    keyId: input.args.keyId,
  });
  const expectedProduction = productionSnapshot === null
    ? { runtimeSnapshotHash: null }
    : { runtimeSnapshotHash: productionSnapshot.snapshotHash };
  if (input.args.kind === "apple") {
    verifyAppleControlPlaneReceipt({
      value: envelope,
      verificationKey,
      trustPolicy: trust,
      expected: {
        phase: input.args.phase,
        candidate,
        staging: {
          runtimeSnapshotHash: stagingSnapshot.snapshotHash,
          appleCredentialVersionHash:
            stagingSnapshot.credentialVersionHashes.apple,
          appleQaVerifierCredentialVersionHash:
            stagingSnapshot.credentialVersionHashes.appleQaVerifier,
          musicKitOrigin: stagingSnapshot.origin,
        },
        production: {
          ...expectedProduction,
          ...(productionSnapshot === null
            ? {}
            : {
              appleCredentialVersionHash:
                productionSnapshot.credentialVersionHashes.apple,
              appleQaVerifierCredentialVersionHash:
                productionSnapshot.credentialVersionHashes.appleQaVerifier,
            }),
        },
      },
      now: generatedAt,
    });
  } else if (input.args.kind === "provider") {
    verifyProviderControlPlaneReceipt({
      value: envelope,
      verificationKey,
      trustPolicy: trust,
      expected: {
        phase: input.args.phase,
        candidate,
        staging: {
          runtimeSnapshotHash: stagingSnapshot.snapshotHash,
          providerCredentialVersionHash:
            stagingSnapshot.credentialVersionHashes.provider,
        },
        production: {
          ...expectedProduction,
          ...(productionSnapshot === null
            ? {}
            : {
              providerCredentialVersionHash:
                productionSnapshot.credentialVersionHashes.provider,
            }),
        },
      },
      now: generatedAt,
    });
  } else {
    verifyQaBudgetLedgerReceipt({
      value: envelope,
      verificationKey,
      trustPolicy: trust,
      expected: {
        phase: input.args.phase,
        candidate,
        stagingRuntimeSnapshotHash: stagingSnapshot.snapshotHash,
        productionRuntimeSnapshotHash:
          productionSnapshot?.snapshotHash ?? null,
      },
      now: generatedAt,
    });
  }
  const verificationKeyPem = verificationKey.export({
    format: "pem",
    type: "spki",
  }).toString();
  await writeFile(
    input.args.verificationKeyOutputPath,
    verificationKeyPem,
    { encoding: "utf8", flag: "wx", mode: 0o644 },
  );
  await writeFile(
    input.args.outputPath,
    `${JSON.stringify(envelope, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return { envelope, verificationKey: verificationKeyPem };
}

async function main(): Promise<void> {
  const [kind, ...argv] = process.argv.slice(2);
  const args = parseControlPlaneReceiptProducerArgs(kind ?? "", argv);
  const result = await produceControlPlaneReceipt({ args });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    kind: args.kind,
    phase: args.phase,
    authoritySourceKeySha256: args.sourceKeySha256,
    payloadHash: result.envelope.payloadHash,
    output: args.outputPath,
    verificationKeyOutput: args.verificationKeyOutputPath,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "control_plane_receipt_production_failed",
      message: error instanceof Error
        ? error.message
        : "Control-plane receipt production failed",
    })}\n`);
    process.exitCode = 1;
  });
}
