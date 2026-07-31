import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client, type QueryResult } from "pg";
import {
  ACTIVATION_COHORT_INVENTORY_QUERY_HASH_V1,
  ACTIVATION_COHORT_INVENTORY_STATEMENTS_V1,
  OWNER_CANDIDATE_BOOLEAN_FLAGS,
  PROMOTION_PHASE_EVIDENCE_SCHEMA_VERSION,
  PUBLIC_ROLLOUT_PERCENT_FLAGS,
  REQUIRED_PROMOTION_WORKER_PROTOCOL,
  SIGNED_PROMOTION_PHASE_EVIDENCE_SCHEMA_VERSION,
  type PromotionObservedPhase,
  verifyPromotionPhaseEvidence,
} from "../shared/promotion-phase-evidence.ts";
import {
  REQUIRED_ACTIVATION_EXECUTION_CONTROLS,
} from "../shared/release-activation-contract.ts";
import { RELEASE_EVIDENCE_TTL_MS } from "../shared/release-evidence-constants.ts";
import {
  createStrictSignedEnvelope,
  signedArtifactSha256,
  type JsonRecord,
} from "../shared/signed-artifact.ts";
import {
  verifyReleaseEvidence,
} from "./release-evidence.ts";
import {
  releaseProducerCandidate,
  releaseProducerOption,
} from "./release-gate-producer.ts";
import {
  collectReleaseMigrationPhaseEvidence,
  type ReleaseMigrationPhaseEvidence,
} from "./verify-release-migration-phase.ts";

const CONFIRMATION_FLAG = "--confirm-production-phase-evidence";
const SHA256 = /^[0-9a-f]{64}$/u;
const KEY_ID = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{2,159}$/u;
const DEADLINE_MS = 6 * 60_000;

type ActivationCohortRow = {
  cohort_key: unknown;
  route: unknown;
  intent_group: unknown;
  disabled: unknown;
  reason_code: unknown;
  changed_at: unknown;
};

export interface PromotionPhaseEvidenceProducerArgs {
  origin: string;
  phase: PromotionObservedPhase;
  expectedSchemaVersion: string;
  expectedDatabaseCapabilityVersion: "2" | null;
  expectedReleaseManifestCanaryGuardsVersion: "1" | null;
  expectedCanonicalExecutionHardeningVersion: "1" | null;
  expectedProofArchitectureVersion: "1" | null;
  expectedProofArchitectureAuthority: "shadow" | null;
  candidate: {
    tag: string;
    version: string;
    sourceRevision: string;
    imageDigest: string;
  };
  candidateEvidencePath: string;
  candidateVerificationKeyPath: string;
  samples: number;
  intervalMs: number;
  outputPath: string;
  producerSigningKeyPath: string;
  producerKeyId: string;
  productionDatabaseUrl: string | null;
  expectedDatabaseIdentityHash: string | null;
}

export interface ActivationPreflightDatabaseClient {
  query(
    text: string,
  ): Promise<QueryResult<Record<string, unknown>> | QueryResult<ActivationCohortRow>>;
}

function exactRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function oneInteger(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be ${minimum} through ${maximum}`);
  }
  return parsed;
}

function iso(value: unknown, label: string): string {
  const date = value instanceof Date
    ? value
    : typeof value === "string"
      ? new Date(value)
      : null;
  if (!date || !Number.isFinite(date.getTime())) {
    throw new Error(`${label} must be a database timestamp`);
  }
  return date.toISOString();
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function configuredOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("--origin must be the configured production HTTPS origin");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("--origin must be the configured production HTTPS origin");
  }
  return parsed.origin;
}

export function parsePromotionPhaseEvidenceProducerArgs(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): PromotionPhaseEvidenceProducerArgs {
  const valueOptions = new Set([
    "--origin",
    "--phase",
    "--expected-schema",
    "--expected-capability",
    "--expected-manifest-canary-guards",
    "--expected-canonical-hardening",
    "--candidate-tag",
    "--candidate-version",
    "--candidate-revision",
    "--image-digest",
    "--candidate-evidence",
    "--candidate-verification-key",
    "--samples",
    "--interval-seconds",
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
    throw new Error(`Production phase evidence requires ${CONFIRMATION_FLAG}`);
  }
  const origin = configuredOrigin(releaseProducerOption(argv, "--origin"));
  if (environment.RELEASE_PRODUCTION_ORIGIN?.trim() !== origin) {
    throw new Error("--origin must exactly match RELEASE_PRODUCTION_ORIGIN");
  }
  const phase = releaseProducerOption(argv, "--phase");
  if (phase !== "bridge" && phase !== "expand") {
    throw new Error("--phase must be bridge or expand");
  }
  const expectedSchemaVersion = releaseProducerOption(argv, "--expected-schema");
  if (
    (phase === "bridge" && expectedSchemaVersion !== "19")
    || (phase === "expand" && expectedSchemaVersion !== "20")
  ) {
    throw new Error(
      "--expected-schema must be 19 for bridge or 20 for expand",
    );
  }
  const expectedCapabilityValue = releaseProducerOption(
    argv,
    "--expected-capability",
  );
  if (
    expectedCapabilityValue !== "2"
    && expectedCapabilityValue !== "none"
  ) {
    throw new Error("--expected-capability must be 2 or none");
  }
  const expectedDatabaseCapabilityVersion =
    expectedCapabilityValue === "2" ? "2" : null;
  const expectedManifestCanaryGuardsValue = releaseProducerOption(
    argv,
    "--expected-manifest-canary-guards",
  );
  if (
    expectedManifestCanaryGuardsValue !== "1"
    && expectedManifestCanaryGuardsValue !== "none"
  ) {
    throw new Error("--expected-manifest-canary-guards must be 1 or none");
  }
  const expectedReleaseManifestCanaryGuardsVersion =
    expectedManifestCanaryGuardsValue === "1" ? "1" : null;
  const expectedCanonicalHardeningValue = releaseProducerOption(
    argv,
    "--expected-canonical-hardening",
  );
  if (
    expectedCanonicalHardeningValue !== "1"
    && expectedCanonicalHardeningValue !== "none"
  ) {
    throw new Error("--expected-canonical-hardening must be 1 or none");
  }
  const expectedCanonicalExecutionHardeningVersion =
    expectedCanonicalHardeningValue === "1" ? "1" : null;
  const schemaCapabilityActive = Number(expectedSchemaVersion) >= 18;
  if (
    (schemaCapabilityActive && (
      expectedDatabaseCapabilityVersion !== "2"
      || expectedReleaseManifestCanaryGuardsVersion !== "1"
      || expectedCanonicalExecutionHardeningVersion !== "1"
    ))
    || (!schemaCapabilityActive && (
      expectedDatabaseCapabilityVersion !== null
      || expectedReleaseManifestCanaryGuardsVersion !== null
      || expectedCanonicalExecutionHardeningVersion !== null
    ))
  ) {
    throw new Error(
      "schemas 18 through 20 require composite capability 2, manifest-canary marker 1, and canonical-hardening marker 1; schemas 13 through 17 require none",
    );
  }
  const candidate = releaseProducerCandidate({
    tag: releaseProducerOption(argv, "--candidate-tag"),
    version: releaseProducerOption(argv, "--candidate-version"),
    sourceRevision: releaseProducerOption(argv, "--candidate-revision"),
    imageDigest: releaseProducerOption(argv, "--image-digest"),
  });
  const producerKeyId = releaseProducerOption(argv, "--producer-key-id");
  if (!KEY_ID.test(producerKeyId)) throw new Error("--producer-key-id is invalid");
  const productionDatabaseUrl =
    environment.RELEASE_PRODUCTION_DATABASE_URL?.trim() || null;
  const expectedDatabaseIdentityHash =
    environment.GENIO_PRODUCTION_DATABASE_IDENTITY_HASH?.trim() || null;
  if (phase === "expand") {
    if (!productionDatabaseUrl) {
      throw new Error("expand evidence requires RELEASE_PRODUCTION_DATABASE_URL");
    }
    digest(
      expectedDatabaseIdentityHash,
      "GENIO_PRODUCTION_DATABASE_IDENTITY_HASH",
    );
  } else if (productionDatabaseUrl || expectedDatabaseIdentityHash) {
    throw new Error(
      "bridge evidence must not receive activation database credentials or identity",
    );
  }
  return {
    origin,
    phase,
    expectedSchemaVersion,
    expectedDatabaseCapabilityVersion,
    expectedReleaseManifestCanaryGuardsVersion,
    expectedCanonicalExecutionHardeningVersion,
    expectedProofArchitectureVersion: phase === "expand" ? "1" : null,
    expectedProofArchitectureAuthority: phase === "expand" ? "shadow" : null,
    candidate: {
      tag: candidate.tag,
      version: candidate.version,
      sourceRevision: candidate.sourceRevision,
      imageDigest: candidate.imageDigest,
    },
    candidateEvidencePath: releaseProducerOption(argv, "--candidate-evidence"),
    candidateVerificationKeyPath:
      releaseProducerOption(argv, "--candidate-verification-key"),
    samples: oneInteger(
      releaseProducerOption(argv, "--samples"),
      "--samples",
      2,
      5,
    ),
    intervalMs: oneInteger(
      releaseProducerOption(argv, "--interval-seconds"),
      "--interval-seconds",
      30,
      120,
    ) * 1_000,
    outputPath: releaseProducerOption(argv, "--output"),
    producerSigningKeyPath: releaseProducerOption(argv, "--producer-signing-key"),
    producerKeyId,
    productionDatabaseUrl,
    expectedDatabaseIdentityHash:
      phase === "expand" ? expectedDatabaseIdentityHash : null,
  };
}

async function ed25519PrivateKey(path: string): Promise<KeyObject> {
  try {
    const key = createPrivateKey(await readFile(path));
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key;
  } catch {
    throw new Error("--producer-signing-key must identify a readable Ed25519 private key");
  }
}

async function ed25519PublicKey(path: string): Promise<KeyObject> {
  try {
    const key = createPublicKey(await readFile(path));
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key;
  } catch {
    throw new Error(
      "--candidate-verification-key must identify a readable Ed25519 public key",
    );
  }
}

async function preflightFiles(
  args: PromotionPhaseEvidenceProducerArgs,
): Promise<{ signingKey: KeyObject; candidateVerificationKey: KeyObject }> {
  const paths = [
    args.outputPath,
    args.producerSigningKeyPath,
    args.candidateEvidencePath,
    args.candidateVerificationKeyPath,
  ].map((path) => resolve(path));
  if (new Set(paths).size !== paths.length) {
    throw new Error("promotion evidence input, key, and output paths must be distinct");
  }
  const [signingKey, candidateVerificationKey] = await Promise.all([
    ed25519PrivateKey(args.producerSigningKeyPath),
    ed25519PublicKey(args.candidateVerificationKeyPath),
  ]);
  try {
    await readFile(args.outputPath);
    throw new Error("promotion phase evidence output already exists");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { signingKey, candidateVerificationKey };
    }
    throw error;
  }
}

function rolloutFromEnvironment(
  environment: NodeJS.ProcessEnv,
): {
  rolloutFlags: Record<string, string>;
  ownerCandidateRoute: {
    route: "corpus_first_v3";
    groups: string[];
    maximumTrackCount: number;
  };
  activationConfiguration: Record<string, string>;
} {
  const rolloutFlags: Record<string, string> = {};
  for (const flag of PUBLIC_ROLLOUT_PERCENT_FLAGS) {
    const value = environment[flag]?.trim();
    if (value === undefined) throw new Error(`Missing protected rollout value ${flag}`);
    rolloutFlags[flag] = value;
  }
  for (const flag of Object.keys(OWNER_CANDIDATE_BOOLEAN_FLAGS)) {
    const value = environment[flag]?.trim();
    if (value === undefined) throw new Error(`Missing protected rollout value ${flag}`);
    rolloutFlags[flag] = value;
  }
  const groupsValue = environment.PIPELINE_V3_OWNER_CANARY_GROUPS?.trim();
  const maximumValue = environment.PIPELINE_V3_OWNER_CANARY_MAX_TRACKS?.trim();
  if (!groupsValue || !maximumValue) {
    throw new Error("Missing protected owner candidate route values");
  }
  const ownerCandidateRoute = {
    route: "corpus_first_v3" as const,
    groups: groupsValue.split(",").map((value) => value.trim()).filter(Boolean),
    maximumTrackCount: oneInteger(
      maximumValue,
      "PIPELINE_V3_OWNER_CANARY_MAX_TRACKS",
      50,
      300,
    ),
  };
  return {
    rolloutFlags,
    ownerCandidateRoute,
    activationConfiguration: {
      ...REQUIRED_ACTIVATION_EXECUTION_CONTROLS,
      ...rolloutFlags,
      PIPELINE_V3_OWNER_CANARY_GROUPS: ownerCandidateRoute.groups.join(","),
      PIPELINE_V3_OWNER_CANARY_MAX_TRACKS:
        String(ownerCandidateRoute.maximumTrackCount),
    },
  };
}

export async function collectActivationPreflight(input: {
  client: ActivationPreflightDatabaseClient;
  environment: NodeJS.ProcessEnv;
}): Promise<{
  capturedAt: string;
  databaseIdentityHash: string;
  databaseSnapshotId: string;
  cohortQueryHash: string;
  cohortInventoryHash: string;
  inventoryComplete: true;
  affectedCohorts: Array<{
    cohortKey: string;
    route: unknown;
    intentGroup: unknown;
    disabled: unknown;
    reasonCode: unknown;
    changedAt: string;
  }>;
  rolloutFlags: Record<string, string>;
  ownerCandidateRoute: {
    route: "corpus_first_v3";
    groups: string[];
    maximumTrackCount: number;
  };
  activationConfiguration: Record<string, string>;
}> {
  await input.client.query("BEGIN");
  let committed = false;
  try {
    await input.client.query(ACTIVATION_COHORT_INVENTORY_STATEMENTS_V1[0]);
    const identity = await input.client.query(
      [
        "SELECT current_database() AS database_name,",
        "(pg_control_system()).system_identifier::text AS system_identifier,",
        "pg_export_snapshot() AS snapshot_id,",
        "clock_timestamp() AS captured_at",
      ].join(" "),
    );
    if (identity.rows.length !== 1) {
      throw new Error("activation preflight could not identify one production database");
    }
    const identityRow = exactRecord(
      identity.rows[0],
      "activation preflight database identity",
    );
    const databaseName = typeof identityRow.database_name === "string"
      ? identityRow.database_name
      : "";
    const systemIdentifier = typeof identityRow.system_identifier === "string"
      ? identityRow.system_identifier
      : "";
    const databaseSnapshotId = typeof identityRow.snapshot_id === "string"
      ? identityRow.snapshot_id
      : "";
    if (!databaseName || !/^\d{10,24}$/u.test(systemIdentifier)
      || !/^[0-9A-Za-z][0-9A-Za-z._:+/-]{0,159}$/u.test(databaseSnapshotId)) {
      throw new Error("activation preflight database identity is incomplete");
    }
    const inventory = await input.client.query(
      ACTIVATION_COHORT_INVENTORY_STATEMENTS_V1[1],
    );
    const affectedCohorts = (inventory.rows as ActivationCohortRow[]).map(
      (row) => ({
        cohortKey: typeof row.cohort_key === "string" ? row.cohort_key : "",
        route: row.route,
        intentGroup: row.intent_group ?? null,
        disabled: row.disabled,
        reasonCode: row.reason_code,
        changedAt: iso(row.changed_at, "activation cohort changed_at"),
      }),
    );
    const canonicalCohorts = [...affectedCohorts].sort((left, right) => (
      `${String(left.route)}:${String(left.intentGroup ?? "")}:${left.cohortKey}`
        .localeCompare(
          `${String(right.route)}:${String(right.intentGroup ?? "")}:${right.cohortKey}`,
        )
    ));
    const rollout = rolloutFromEnvironment(input.environment);
    const result = {
      capturedAt: iso(identityRow.captured_at, "activation preflight captured_at"),
      databaseIdentityHash: signedArtifactSha256({
        databaseName,
        systemIdentifier,
      }),
      databaseSnapshotId,
      cohortQueryHash: ACTIVATION_COHORT_INVENTORY_QUERY_HASH_V1,
      cohortInventoryHash: signedArtifactSha256(canonicalCohorts),
      inventoryComplete: true as const,
      affectedCohorts,
      ...rollout,
    };
    await input.client.query("COMMIT");
    committed = true;
    return result;
  } finally {
    if (!committed) {
      await input.client.query("ROLLBACK").catch(() => undefined);
    }
  }
}

function uniqueDigest(
  values: readonly (string | null)[],
  label: string,
): string {
  const unique = [...new Set(values.filter((value): value is string => Boolean(value)))];
  if (unique.length !== 1 || values.some((value) => value !== unique[0])) {
    throw new Error(`${label} is not stable across convergence observations`);
  }
  return digest(unique[0], label);
}

export function buildPromotionPhasePayload(input: {
  args: PromotionPhaseEvidenceProducerArgs;
  candidateEvidenceHash: string;
  migrationEvidence: ReleaseMigrationPhaseEvidence;
  activationPreflight: Awaited<ReturnType<typeof collectActivationPreflight>> | null;
  generatedAt?: string;
}): JsonRecord {
  if (!input.migrationEvidence.passed || input.migrationEvidence.violations.length > 0) {
    throw new Error("promotion phase convergence did not pass");
  }
  if (
    input.migrationEvidence.expected.revision
      !== input.args.candidate.sourceRevision
    || input.migrationEvidence.expected.version
      !== input.args.candidate.version
    || input.migrationEvidence.expected.databaseSchemaVersion
      !== input.args.expectedSchemaVersion
    || input.migrationEvidence.expected.databaseCapabilityVersion
      !== input.args.expectedDatabaseCapabilityVersion
    || input.migrationEvidence.expected.releaseManifestCanaryGuardsVersion
      !== input.args.expectedReleaseManifestCanaryGuardsVersion
    || input.migrationEvidence.expected.canonicalExecutionHardeningVersion
      !== input.args.expectedCanonicalExecutionHardeningVersion
    || input.migrationEvidence.expected.proofArchitectureVersion
      !== input.args.expectedProofArchitectureVersion
    || input.migrationEvidence.expected.proofArchitectureAuthority
      !== input.args.expectedProofArchitectureAuthority
    || input.migrationEvidence.expected.phase !== input.args.phase
    || input.migrationEvidence.expected.samples !== input.args.samples
    || input.migrationEvidence.expected.minimumObservationSpanMs !== 30_000
    || input.migrationEvidence.observationSpanMs < 30_000
  ) {
    throw new Error(
      "promotion phase convergence does not bind the requested deployment phase",
    );
  }
  const observations = input.migrationEvidence.observations;
  if (observations.length !== input.args.samples) {
    throw new Error("promotion phase convergence sample count changed");
  }
  const apiHash = uniqueDigest(
    observations.map(({ apiConfigurationHash }) => apiConfigurationHash),
    "API configuration hash",
  );
  const interactiveWorkerHash = uniqueDigest(
    observations.map(
      ({ workerLanes }) => workerLanes.interactive.eligibleConfigurationHashes[0] ?? null,
    ),
    "interactive worker configuration hash",
  );
  const deepWorkerHash = uniqueDigest(
    observations.map(
      ({ workerLanes }) => workerLanes.deep.eligibleConfigurationHashes[0] ?? null,
    ),
    "deep worker configuration hash",
  );
  const databaseCapabilityVersion = observations[0]?.databaseCapabilityVersion ?? null;
  if (observations.some(
    (observation) => observation.databaseCapabilityVersion
      !== databaseCapabilityVersion,
  )) {
    throw new Error("database capability changed across convergence observations");
  }
  if (
    databaseCapabilityVersion
      !== input.args.expectedDatabaseCapabilityVersion
  ) {
    throw new Error(
      "database capability does not match the CLI-bound expected capability",
    );
  }
  const releaseManifestCanaryGuardsVersion =
    observations[0]?.releaseManifestCanaryGuardsVersion ?? null;
  if (observations.some(
    (observation) => observation.releaseManifestCanaryGuardsVersion
      !== releaseManifestCanaryGuardsVersion,
  )) {
    throw new Error(
      "release-manifest canary marker changed across convergence observations",
    );
  }
  if (
    releaseManifestCanaryGuardsVersion
      !== input.args.expectedReleaseManifestCanaryGuardsVersion
  ) {
    throw new Error(
      "release-manifest canary marker does not match the CLI-bound expected marker",
    );
  }
  const canonicalExecutionHardeningVersion =
    observations[0]?.canonicalExecutionHardeningVersion ?? null;
  if (observations.some(
    (observation) => observation.canonicalExecutionHardeningVersion
      !== canonicalExecutionHardeningVersion,
  )) {
    throw new Error(
      "canonical execution hardening marker changed across convergence observations",
    );
  }
  if (
    canonicalExecutionHardeningVersion
      !== input.args.expectedCanonicalExecutionHardeningVersion
  ) {
    throw new Error(
      "canonical execution hardening marker does not match the CLI-bound expected marker",
    );
  }
  const proofArchitectureVersion =
    observations[0]?.proofArchitectureVersion ?? null;
  const proofArchitectureAuthority =
    observations[0]?.proofArchitectureAuthority ?? null;
  if (
    observations.some(
      (observation) =>
        observation.proofArchitectureVersion !== proofArchitectureVersion
        || observation.proofArchitectureAuthority
          !== proofArchitectureAuthority,
    )
    || proofArchitectureVersion
      !== input.args.expectedProofArchitectureVersion
    || proofArchitectureAuthority
      !== input.args.expectedProofArchitectureAuthority
  ) {
    throw new Error(
      "proof architecture markers do not match the phase-bound authority",
    );
  }
  const oldRevisions = new Set(observations.flatMap((observation) => [
    ...observation.workerLanes.interactive.eligibleRevisions,
    ...observation.workerLanes.deep.eligibleRevisions,
  ]).filter((revision) => revision !== input.args.candidate.sourceRevision));
  const freshInteractive = new Set(observations.map(
    ({ workerLanes }) => workerLanes.interactive.lastSeenAt,
  )).size;
  const freshDeep = new Set(observations.map(
    ({ workerLanes }) => workerLanes.deep.lastSeenAt,
  )).size;
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  return {
    schemaVersion: PROMOTION_PHASE_EVIDENCE_SCHEMA_VERSION,
    generatedAt,
    expiresAt: new Date(
      Date.parse(generatedAt) + RELEASE_EVIDENCE_TTL_MS,
    ).toISOString(),
    environment: "production",
    phase: input.args.phase,
    candidate: {
      ...input.args.candidate,
      candidateEvidenceHash: digest(
        input.candidateEvidenceHash,
        "candidate evidence hash",
      ),
    },
    runtime: {
      releaseEnvironment: "production",
      deploymentPhase: input.args.phase,
      databaseSchemaVersion: input.args.expectedSchemaVersion,
      databaseCapabilityVersion,
      releaseManifestCanaryGuardsVersion,
      canonicalExecutionHardeningVersion,
      proofArchitectureVersion,
      proofArchitectureAuthority,
      workerProtocol: REQUIRED_PROMOTION_WORKER_PROTOCOL,
      configurationHash: signedArtifactSha256({
        apiHash,
        interactiveWorkerHash,
        deepWorkerHash,
      }),
      apiConfigurationHash: apiHash,
      interactiveWorkerConfigurationHash: interactiveWorkerHash,
      deepWorkerConfigurationHash: deepWorkerHash,
    },
    convergence: {
      passed: true,
      sampleCount: observations.length,
      observationsHash: signedArtifactSha256(observations),
      freshWorkerHeartbeatsPerLane: Math.min(freshInteractive, freshDeep),
      eligibleOldWorkerCount: oldRevisions.size,
    },
    activationPreflight: input.activationPreflight,
  };
}

async function main(): Promise<void> {
  const args = parsePromotionPhaseEvidenceProducerArgs(process.argv.slice(2));
  const { signingKey, candidateVerificationKey } = await preflightFiles(args);
  const deadlineAt = Date.now() + DEADLINE_MS;
  let candidateEnvelope: unknown;
  try {
    candidateEnvelope = JSON.parse(await readFile(args.candidateEvidencePath, "utf8"));
  } catch {
    throw new Error("--candidate-evidence must identify readable signed JSON evidence");
  }
  const candidateEvidence = verifyReleaseEvidence(
    candidateEnvelope,
    candidateVerificationKey,
    {
      expectedKind: "candidate",
      expectedRevision: args.candidate.sourceRevision,
      expectedImageDigest: args.candidate.imageDigest,
      expectedTag: args.candidate.tag,
    },
  );
  if (candidateEvidence.candidate.version !== args.candidate.version) {
    throw new Error("candidate evidence version does not match the promotion target");
  }
  const candidateEnvelopeRecord = exactRecord(
    candidateEnvelope,
    "signed candidate evidence",
  );
  const candidateEvidenceHash = digest(
    candidateEnvelopeRecord.payloadHash,
    "signed candidate evidence payloadHash",
  );
  const migrationEvidence = await collectReleaseMigrationPhaseEvidence({
    origin: args.origin,
    expectedRevision: args.candidate.sourceRevision,
    expectedVersion: args.candidate.version,
    expectedSchemaVersion: args.expectedSchemaVersion,
    expectedDatabaseCapabilityVersion:
      args.expectedDatabaseCapabilityVersion,
    expectedReleaseManifestCanaryGuardsVersion:
      args.expectedReleaseManifestCanaryGuardsVersion,
      expectedCanonicalExecutionHardeningVersion:
        args.expectedCanonicalExecutionHardeningVersion,
      expectedProofArchitectureVersion:
        args.expectedProofArchitectureVersion,
      expectedProofArchitectureAuthority:
        args.expectedProofArchitectureAuthority,
    phase: args.phase,
    samples: args.samples,
    intervalMs: args.intervalMs,
  }, deadlineAt);
  let activationPreflight: Awaited<
    ReturnType<typeof collectActivationPreflight>
  > | null = null;
  if (args.phase === "expand") {
    const client = new Client({
      connectionString: args.productionDatabaseUrl!,
      statement_timeout: Math.max(1, deadlineAt - Date.now()),
      query_timeout: Math.max(1, deadlineAt - Date.now()),
      application_name: "genio-promotion-phase-evidence",
    });
    await client.connect();
    try {
      activationPreflight = await collectActivationPreflight({
        client,
        environment: process.env,
      });
    } finally {
      await client.end();
    }
    if (
      activationPreflight.databaseIdentityHash
        !== args.expectedDatabaseIdentityHash
    ) {
      throw new Error(
        "activation preflight database identity does not match the pinned production database",
      );
    }
  }
  const payload = buildPromotionPhasePayload({
    args,
    candidateEvidenceHash,
    migrationEvidence,
    activationPreflight,
  });
  const envelope = createStrictSignedEnvelope({
    envelopeSchemaVersion: SIGNED_PROMOTION_PHASE_EVIDENCE_SCHEMA_VERSION,
    payload,
    signingKey,
    keyId: args.producerKeyId,
  });
  const runtime = exactRecord(payload.runtime, "promotion runtime");
  const preflight = payload.activationPreflight === null
    ? null
    : exactRecord(payload.activationPreflight, "activation preflight");
  verifyPromotionPhaseEvidence(
    envelope,
    createPublicKey(signingKey),
    {
      expectedPhase: args.phase,
      expectedTag: args.candidate.tag,
      expectedVersion: args.candidate.version,
      expectedRevision: args.candidate.sourceRevision,
      expectedImageDigest: args.candidate.imageDigest,
      expectedCandidateEvidenceHash: candidateEvidenceHash,
      expectedConfigurationHash: String(runtime.configurationHash),
      expectedDatabaseSchemaVersion: args.expectedSchemaVersion,
      expectedDatabaseCapabilityVersion:
        runtime.databaseCapabilityVersion === null
          ? null
          : String(runtime.databaseCapabilityVersion),
      expectedReleaseManifestCanaryGuardsVersion:
        runtime.releaseManifestCanaryGuardsVersion === null
          ? null
          : String(runtime.releaseManifestCanaryGuardsVersion),
      expectedCanonicalExecutionHardeningVersion:
        runtime.canonicalExecutionHardeningVersion === null
          ? null
          : String(runtime.canonicalExecutionHardeningVersion),
      expectedProofArchitectureVersion:
        runtime.proofArchitectureVersion === null
          ? null
          : String(runtime.proofArchitectureVersion),
      expectedProofArchitectureAuthority:
        runtime.proofArchitectureAuthority === null
          ? null
          : String(runtime.proofArchitectureAuthority),
      expectedDatabaseIdentityHash:
        preflight === null ? null : String(preflight.databaseIdentityHash),
    },
  );
  await writeFile(args.outputPath, `${JSON.stringify(envelope, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    phase: args.phase,
    payloadHash: envelope.payloadHash,
    candidateEvidenceHash,
    configurationHash: runtime.configurationHash,
    databaseIdentityHash: preflight?.databaseIdentityHash ?? null,
    producerKeyId: envelope.signature.keyId,
  })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "promotion_phase_evidence_producer_failed",
      message: "Promotion phase evidence producer failed closed",
    })}\n`);
    process.exitCode = 1;
  });
}
