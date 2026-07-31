import type { KeyObject } from "node:crypto";
import { RELEASE_EVIDENCE_TTL_MS } from "./release-evidence-constants.ts";
import type { ActivationRolloutConfiguration } from "./promotion-phase-evidence.ts";
import {
  publicRolloutIntentCanaryKeyFingerprint,
  verifyTrustedPublicRolloutIntentCanaryV1,
  type PublicRolloutIntentCanaryTrustV1,
} from "./public-rollout-intent-canary.ts";
import {
  exactObject,
  type JsonRecord,
  sha256Digest,
  signedArtifactSha256,
  verifyStrictSignedEnvelope,
} from "./signed-artifact.ts";
import { semanticBehaviorHashV1 } from "./semantic-release-evidence.ts";

export const PUBLIC_ROLLOUT_EVIDENCE_SCHEMA_VERSION =
  "genio-public-rollout-evidence/v5";
export const SIGNED_PUBLIC_ROLLOUT_EVIDENCE_SCHEMA_VERSION =
  "genio-signed-public-rollout-evidence/v5";
export const PUBLIC_ROLLOUT_ROLLBACK_WARRANT_SCHEMA_VERSION =
  "genio-public-rollout-rollback-warrant/v3";
export const SIGNED_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_SCHEMA_VERSION =
  "genio-signed-public-rollout-rollback-warrant/v3";
export const PUBLIC_ROLLOUT_PERCENT_LADDER = ["0", "1", "10", "50", "100"] as const;
export const PUBLIC_ROLLOUT_REQUIRED_PRODUCTION_GATES = [
  "production_fixed_three_track",
  "production_affected_regression",
  "backend_release_convergence",
] as const;

export const PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS = Object.freeze({
  genre_scene: "PIPELINE_V3_GENRE_SCENE_PERCENT",
  mood_activity_theme: "PIPELINE_V3_MOOD_ACTIVITY_PERCENT",
  similarity: "PIPELINE_V3_SIMILARITY_PERCENT",
  artist_catalogue: "PIPELINE_V3_ARTIST_CATALOGUE_PERCENT",
  fixed_container: "PIPELINE_V3_FIXED_CONTAINER_PERCENT",
  factual_relationship: "PIPELINE_V3_FACTUAL_PERCENT",
  exhaustive: "PIPELINE_V3_EXHAUSTIVE_PERCENT",
} as const);

export type PublicRolloutIntentGroup =
  keyof typeof PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS;
export type PublicRolloutPercent =
  typeof PUBLIC_ROLLOUT_PERCENT_LADDER[number];
export type PublicRolloutPercentFlag =
  typeof PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS[PublicRolloutIntentGroup];
export type PublicRolloutPercentages = Record<
  PublicRolloutPercentFlag,
  PublicRolloutPercent
>;

export interface PublicRolloutSoakWorkerLane {
  status: "healthy";
  protocolVersion: "playlist-pipeline-v12";
  compatibleCapacity: number;
  eligibleWorkerCount: number;
  eligibleIdentityCount: number;
  eligibleRevisions: string[];
  eligibleConfigurationHashes: string[];
  lastSeenAt: string;
}

export interface PublicRolloutSoakObservation {
  observedAt: string;
  sitesVersion: string;
  sitesRevision: string;
  apiVersion: string;
  apiRevision: string;
  apiConfigurationHash: string;
  publicRolloutEvidenceHash: string | null;
  publicRolloutStage: string | null;
  systemHttpStatus: 200;
  systemOk: true;
  activationReady: true;
  database: "ready";
  databaseCapabilityVersion: "2";
  releaseManifestCanaryGuardsVersion: "1";
  canonicalExecutionHardeningVersion: "1";
  proofArchitectureVersion: "1";
  proofArchitectureAuthority: "native";
  paused: false;
  workerProtocolExpected: "playlist-pipeline-v12";
  workerProtocolActual: "playlist-pipeline-v12";
  interactiveWorker: PublicRolloutSoakWorkerLane;
  deepWorker: PublicRolloutSoakWorkerLane;
}

export type PublicRolloutConfiguration = Omit<
  ActivationRolloutConfiguration,
  PublicRolloutPercentFlag
> & PublicRolloutPercentages & {
  PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED: "true";
  PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED: "true" | "false";
  PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED: "true" | "false";
  PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED: "true" | "false";
};

export interface VerifiedPublicRolloutEvidence {
  payloadHash: string;
  generatedAt: string;
  expiresAt: string;
  promotionEvidenceHash: string;
  previousRolloutEvidenceHash: string | null;
  previousRolloutStage: string | null;
  rollbackWarrantHash: string | null;
  intentCanaryHash: string;
  operation: "advance" | "rollback_to_zero";
  intentGroup: PublicRolloutIntentGroup;
  fromPercent: PublicRolloutPercent;
  toPercent: PublicRolloutPercent;
  currentPercentages: PublicRolloutPercentages;
  targetConfiguration: PublicRolloutConfiguration;
  targetConfigurationHash: string;
  apiConfigurationHash: string;
  soak: {
    startedAt: string;
    completedAt: string;
    durationSeconds: number;
    healthySampleCount: number;
    observationsHash: string;
    observations: PublicRolloutSoakObservation[];
    intentStageMetrics: {
      windowStartedAt: string;
      windowCompletedAt: string;
      eligibleSubmissionCount: number;
      candidateAssignedCount: number;
      exactCompletionCount: number;
    } | null;
  };
}

export interface VerifiedPublicRolloutRollbackWarrant {
  payloadHash: string;
  generatedAt: string;
  candidate: {
    tag: string;
    version: string;
    sourceRevision: string;
    imageDigest: string;
    promotionEvidenceHash: string;
  };
  advance: {
    payloadHash: string;
    stage: string;
    intentGroup: PublicRolloutIntentGroup;
    fromPercent: PublicRolloutPercent;
    toPercent: Exclude<PublicRolloutPercent, "0">;
    targetConfigurationHash: string;
    intentCanaryHash: string;
    targetPercentages: PublicRolloutPercentages;
  };
  rollback: {
    operation: "rollback_to_zero";
    intentGroup: PublicRolloutIntentGroup;
    fromPercent: Exclude<PublicRolloutPercent, "0">;
    toPercent: "0";
    currentPercentages: PublicRolloutPercentages;
    targetConfiguration: PublicRolloutConfiguration;
    targetConfigurationHash: string;
  };
  promotion: {
    configurationHash: string;
    runtimeHash: string;
    productionCanaryEvidenceHash: string;
    sitesVersion: string;
    sitesRevision: string;
  };
}

const FULL_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const RC_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-rc\.[1-9]\d*$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_RELEASE_LABEL = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{0,159}$/u;
const ROLLOUT_STAGE =
  /^(?:genre_scene|mood_activity_theme|similarity|artist_catalogue|fixed_container|factual_relationship|exhaustive):(?:0|1|10|50|100)->(?:0|1|10|50|100)$/u;
const SAFE_OWNER_GROUPS =
  /^(?:genre_scene|mood_activity_theme|similarity|artist_catalogue|fixed_container|factual_relationship|exhaustive)(?:,(?:genre_scene|mood_activity_theme|similarity|artist_catalogue|fixed_container|factual_relationship|exhaustive))*$/u;
const PERCENT_FLAGS = Object.values(PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS);
export const PUBLIC_ROLLOUT_TARGET_CONFIGURATION_KEYS = [
  "PIPELINE_V2_OWNER_CANARY",
  "PIPELINE_V2_CURATED_PERCENT",
  "PIPELINE_V2_SIMILARITY_PERCENT",
  "PIPELINE_V2_FACTUAL_OWNER_CANARY",
  "PIPELINE_V2_FACTUAL_PERCENT",
  "PIPELINE_V3_ASSIGNMENT_ENABLED",
  "PIPELINE_V3_OWNER_CANARY",
  "PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED",
  "PIPELINE_V3_OWNER_CANARY_GROUPS",
  "PIPELINE_V3_OWNER_CANARY_MAX_TRACKS",
  ...PERCENT_FLAGS,
  "PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED",
  "PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED",
  "PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED",
  "PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED",
  "RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION",
  "RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION",
  "RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION",
  "RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION",
  "PIPELINE_V3_PROOF_ARCHITECTURE_MODE",
  "PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION",
  "GUIDANCE_CONTRACT_V3_ENABLED",
  "GUIDANCE_CONTRACT_V3_OWNER_CANARY",
  "GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED",
] as const;

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function candidate(value: unknown): JsonRecord {
  const result = exactObject(value, [
    "tag",
    "version",
    "sourceRevision",
    "imageDigest",
    "promotionEvidenceHash",
  ], "public rollout candidate");
  if (typeof result.tag !== "string" || !RC_TAG.test(result.tag)) {
    throw new Error("public rollout candidate.tag must be an RC tag");
  }
  if (typeof result.version !== "string" || !VERSION.test(result.version)) {
    throw new Error("public rollout candidate.version must be a semantic version");
  }
  if (!result.tag.startsWith(`v${result.version}-rc.`)) {
    throw new Error("public rollout candidate tag and version do not match");
  }
  if (
    typeof result.sourceRevision !== "string"
    || !FULL_REVISION.test(result.sourceRevision)
  ) {
    throw new Error("public rollout candidate.sourceRevision must be a full Git revision");
  }
  if (typeof result.imageDigest !== "string" || !IMAGE_DIGEST.test(result.imageDigest)) {
    throw new Error("public rollout candidate.imageDigest must be immutable");
  }
  sha256Digest(
    result.promotionEvidenceHash,
    "public rollout candidate.promotionEvidenceHash",
  );
  return result;
}

function percentages(
  value: unknown,
  label: string,
): PublicRolloutPercentages {
  const result = exactObject(value, PERCENT_FLAGS, label);
  for (const flag of PERCENT_FLAGS) {
    if (
      typeof result[flag] !== "string"
      || !(PUBLIC_ROLLOUT_PERCENT_LADDER as readonly string[]).includes(
        result[flag] as string,
      )
    ) {
      throw new Error(
        `${label}.${flag} must be one of ${PUBLIC_ROLLOUT_PERCENT_LADDER.join(", ")}`,
      );
    }
  }
  return result as unknown as PublicRolloutPercentages;
}

function percentagesFromConfiguration(
  value: JsonRecord,
  label: string,
): PublicRolloutPercentages {
  return percentages(
    Object.fromEntries(PERCENT_FLAGS.map((flag) => [flag, value[flag]])),
    label,
  );
}

function booleanLiteral(value: unknown, label: string): "true" | "false" {
  if (value !== "true" && value !== "false") {
    throw new Error(`${label} must be the literal string true or false`);
  }
  return value;
}

function targetConfiguration(value: unknown): PublicRolloutConfiguration {
  const result = exactObject(
    value,
    PUBLIC_ROLLOUT_TARGET_CONFIGURATION_KEYS,
    "public rollout targetConfiguration",
  );
  const exactLiterals: Readonly<Record<string, string>> = {
    PIPELINE_V2_OWNER_CANARY: "false",
    // Public V3 assignment is an intent-specific overlay. Requests outside
    // that governed cohort must remain on the proven V2 curated control
    // throughout 0 → 1 → 10 → 50 → 100, never fall back to legacy V1.
    PIPELINE_V2_CURATED_PERCENT: "100",
    PIPELINE_V2_SIMILARITY_PERCENT: "0",
    PIPELINE_V2_FACTUAL_OWNER_CANARY: "false",
    PIPELINE_V2_FACTUAL_PERCENT: "0",
    PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
    PIPELINE_V3_OWNER_CANARY: "true",
    PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED: "true",
    RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION: "2",
    RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION: "1",
    RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION: "1",
    RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION: "1",
    PIPELINE_V3_PROOF_ARCHITECTURE_MODE: "native",
    PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION: "6",
    GUIDANCE_CONTRACT_V3_ENABLED: "false",
    GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
    GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "false",
  };
  for (const [name, expected] of Object.entries(exactLiterals)) {
    if (result[name] !== expected) {
      throw new Error(`public rollout targetConfiguration requires ${name}=${expected}`);
    }
  }
  for (const name of [
    "PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED",
    "PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED",
    "PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED",
  ] as const) {
    booleanLiteral(result[name], `public rollout targetConfiguration.${name}`);
  }
  if (
    typeof result.PIPELINE_V3_OWNER_CANARY_GROUPS !== "string"
    || !SAFE_OWNER_GROUPS.test(result.PIPELINE_V3_OWNER_CANARY_GROUPS)
    || new Set(result.PIPELINE_V3_OWNER_CANARY_GROUPS.split(",")).size
      !== result.PIPELINE_V3_OWNER_CANARY_GROUPS.split(",").length
  ) {
    throw new Error(
      "public rollout targetConfiguration.PIPELINE_V3_OWNER_CANARY_GROUPS is invalid",
    );
  }
  if (
    typeof result.PIPELINE_V3_OWNER_CANARY_MAX_TRACKS !== "string"
    || !/^(?:[5-9]\d|[12]\d\d|300)$/u.test(
      result.PIPELINE_V3_OWNER_CANARY_MAX_TRACKS,
    )
  ) {
    throw new Error(
      "public rollout targetConfiguration.PIPELINE_V3_OWNER_CANARY_MAX_TRACKS must be 50 through 300",
    );
  }
  percentagesFromConfiguration(result, "public rollout targetConfiguration");
  return result as unknown as PublicRolloutConfiguration;
}

export function validatePublicRolloutConfiguration(
  value: unknown,
): PublicRolloutConfiguration {
  return Object.freeze(targetConfiguration(value));
}

function safeReleaseLabel(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !SAFE_RELEASE_LABEL.test(value)
    || /(?:secret|token|password|authorization|sk-)/iu.test(value)
  ) {
    throw new Error(`${label} must be a non-secret release label`);
  }
  return value;
}

function releaseConfiguration(value: unknown): JsonRecord {
  const result = exactObject(value, [
    "apiHash",
    "interactiveWorkerHash",
    "deepWorkerHash",
    "sitesHash",
    "secretVersionsHash",
  ], "public rollout soak runtimeSnapshot.configuration");
  for (const key of Object.keys(result)) {
    sha256Digest(
      result[key],
      `public rollout soak runtimeSnapshot.configuration.${key}`,
    );
  }
  return result;
}

function releaseRuntime(value: unknown): JsonRecord {
  const result = exactObject(value, [
    "semanticExecutionConfigurationHash",
    "releaseEnvironment",
    "deploymentPhase",
    "databaseSchemaVersion",
    "databaseCapabilityVersion",
    "releaseManifestCanaryGuardsVersion",
    "canonicalExecutionHardeningVersion",
    "proofArchitectureMode",
    "proofArchitectureVersion",
    "proofArchitectureAuthority",
    "workerProtocol",
    "briefContractVersion",
    "queryPlanSchemaVersion",
    "modelIds",
    "policyVersions",
  ], "public rollout soak runtimeSnapshot.runtime");
  sha256Digest(
    result.semanticExecutionConfigurationHash,
    "public rollout soak runtimeSnapshot.runtime.semanticExecutionConfigurationHash",
  );
  if (
    result.releaseEnvironment !== "production"
    || result.deploymentPhase !== "activate"
    || result.databaseSchemaVersion !== "20"
    || result.databaseCapabilityVersion !== "2"
    || result.releaseManifestCanaryGuardsVersion !== "1"
    || result.canonicalExecutionHardeningVersion !== "1"
    || result.proofArchitectureMode !== "native"
    || result.proofArchitectureVersion !== "1"
    || result.proofArchitectureAuthority !== "native"
    || result.workerProtocol !== "playlist-pipeline-v12"
    || result.briefContractVersion !== "3"
    || result.queryPlanSchemaVersion !== "6"
  ) {
    throw new Error("public rollout soak runtime snapshot is not production activation-ready");
  }
  const modelIds = exactObject(result.modelIds, [
    "brief",
    "baseline",
    "escalation",
  ], "public rollout soak runtimeSnapshot.runtime.modelIds");
  for (const [key, item] of Object.entries(modelIds)) {
    safeReleaseLabel(
      item,
      `public rollout soak runtimeSnapshot.runtime.modelIds.${key}`,
    );
  }
  const policyVersions = exactObject(result.policyVersions, [
    "guidance",
    "evidence",
    "queryPlan",
    "selection",
    "semanticScope",
    "musicConcept",
    "pipeline",
    "prompt",
  ], "public rollout soak runtimeSnapshot.runtime.policyVersions");
  for (const [key, item] of Object.entries(policyVersions)) {
    safeReleaseLabel(
      item,
      `public rollout soak runtimeSnapshot.runtime.policyVersions.${key}`,
    );
  }
  return result;
}

function stringArray(
  value: unknown,
  label: string,
  validate: (value: unknown, itemLabel: string) => string,
): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result = value.map((item, index) => validate(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) {
    throw new Error(`${label} must contain unique values`);
  }
  return result;
}

function soakWorkerLane(
  value: unknown,
  label: string,
  expectedRevision: string,
  expectedConfigurationHash: string,
  observedAt: string,
  previousHeartbeat: number | null,
): { lane: PublicRolloutSoakWorkerLane; heartbeat: number } {
  const result = exactObject(value, [
    "status",
    "protocolVersion",
    "compatibleCapacity",
    "eligibleWorkerCount",
    "eligibleIdentityCount",
    "eligibleRevisions",
    "eligibleConfigurationHashes",
    "lastSeenAt",
  ], label);
  if (
    result.status !== "healthy"
    || result.protocolVersion !== "playlist-pipeline-v12"
    || !Number.isSafeInteger(result.compatibleCapacity)
    || Number(result.compatibleCapacity) < 1
    || !Number.isSafeInteger(result.eligibleWorkerCount)
    || Number(result.eligibleWorkerCount) < 1
    || result.eligibleIdentityCount !== result.eligibleWorkerCount
  ) {
    throw new Error(`${label} is not healthy and uniquely identified`);
  }
  const eligibleRevisions = stringArray(
    result.eligibleRevisions,
    `${label}.eligibleRevisions`,
    (item, itemLabel) => {
      if (typeof item !== "string" || !FULL_REVISION.test(item)) {
        throw new Error(`${itemLabel} must be a full Git revision`);
      }
      return item;
    },
  );
  const eligibleConfigurationHashes = stringArray(
    result.eligibleConfigurationHashes,
    `${label}.eligibleConfigurationHashes`,
    (item, itemLabel) => sha256Digest(item, itemLabel),
  );
  if (
    eligibleRevisions.length !== 1
    || eligibleRevisions[0] !== expectedRevision
    || eligibleConfigurationHashes.length !== 1
    || eligibleConfigurationHashes[0] !== expectedConfigurationHash
  ) {
    throw new Error(`${label} does not bind the exact candidate worker`);
  }
  const lastSeenAt = isoTimestamp(result.lastSeenAt, `${label}.lastSeenAt`);
  const heartbeat = Date.parse(lastSeenAt);
  const observed = Date.parse(observedAt);
  if (
    heartbeat > observed + 5_000
    || observed - heartbeat > 120_000
    || (previousHeartbeat !== null && heartbeat <= previousHeartbeat)
  ) {
    throw new Error(`${label} does not contain a fresh advancing heartbeat`);
  }
  return {
    lane: {
      status: "healthy",
      protocolVersion: "playlist-pipeline-v12",
      compatibleCapacity: Number(result.compatibleCapacity),
      eligibleWorkerCount: Number(result.eligibleWorkerCount),
      eligibleIdentityCount: Number(result.eligibleIdentityCount),
      eligibleRevisions,
      eligibleConfigurationHashes,
      lastSeenAt,
    },
    heartbeat,
  };
}

function soakObservations(input: {
  value: unknown;
  backendVersion: string;
  backendRevision: string;
  sitesVersion: string;
  sitesRevision: string;
  configuration: JsonRecord;
  expectedRolloutEvidenceHash: string | null;
  expectedRolloutStage: string | null;
}): PublicRolloutSoakObservation[] {
  if (!Array.isArray(input.value)) {
    throw new Error("public rollout soak.observations must be an array");
  }
  if (input.value.length < 3 || input.value.length > 5) {
    throw new Error("public rollout soak requires three to five live observations");
  }
  let previousObservedAt: number | null = null;
  let previousInteractiveHeartbeat: number | null = null;
  let previousDeepHeartbeat: number | null = null;
  return input.value.map((value, index) => {
    const label = `public rollout soak.observations[${index}]`;
    const result = exactObject(value, [
      "observedAt",
      "sitesVersion",
      "sitesRevision",
      "apiVersion",
      "apiRevision",
      "apiConfigurationHash",
      "publicRolloutEvidenceHash",
      "publicRolloutStage",
      "systemHttpStatus",
      "systemOk",
      "activationReady",
      "database",
      "databaseCapabilityVersion",
      "releaseManifestCanaryGuardsVersion",
      "canonicalExecutionHardeningVersion",
      "proofArchitectureVersion",
      "proofArchitectureAuthority",
      "paused",
      "workerProtocolExpected",
      "workerProtocolActual",
      "interactiveWorker",
      "deepWorker",
    ], label);
    const observedAt = isoTimestamp(result.observedAt, `${label}.observedAt`);
    const observed = Date.parse(observedAt);
    if (previousObservedAt !== null && observed <= previousObservedAt) {
      throw new Error("public rollout soak observation timestamps must advance");
    }
    previousObservedAt = observed;
    if (
      result.sitesVersion !== input.sitesVersion
      || result.sitesRevision !== input.sitesRevision
      || result.apiVersion !== input.backendVersion
      || result.apiRevision !== input.backendRevision
      || result.apiConfigurationHash !== input.configuration.apiHash
      || result.publicRolloutEvidenceHash !== input.expectedRolloutEvidenceHash
      || result.publicRolloutStage !== input.expectedRolloutStage
      || result.systemHttpStatus !== 200
      || result.systemOk !== true
      || result.activationReady !== true
      || result.database !== "ready"
      || result.databaseCapabilityVersion !== "2"
      || result.releaseManifestCanaryGuardsVersion !== "1"
      || result.canonicalExecutionHardeningVersion !== "1"
      || result.proofArchitectureVersion !== "1"
      || result.proofArchitectureAuthority !== "native"
      || result.paused !== false
      || result.workerProtocolExpected !== "playlist-pipeline-v12"
      || result.workerProtocolActual !== "playlist-pipeline-v12"
    ) {
      throw new Error(`${label} does not bind the healthy current production rollout`);
    }
    const interactive = soakWorkerLane(
      result.interactiveWorker,
      `${label}.interactiveWorker`,
      input.backendRevision,
      String(input.configuration.interactiveWorkerHash),
      observedAt,
      previousInteractiveHeartbeat,
    );
    previousInteractiveHeartbeat = interactive.heartbeat;
    const deep = soakWorkerLane(
      result.deepWorker,
      `${label}.deepWorker`,
      input.backendRevision,
      String(input.configuration.deepWorkerHash),
      observedAt,
      previousDeepHeartbeat,
    );
    previousDeepHeartbeat = deep.heartbeat;
    return {
      observedAt,
      sitesVersion: input.sitesVersion,
      sitesRevision: input.sitesRevision,
      apiVersion: input.backendVersion,
      apiRevision: input.backendRevision,
      apiConfigurationHash: String(input.configuration.apiHash),
      publicRolloutEvidenceHash: input.expectedRolloutEvidenceHash,
      publicRolloutStage: input.expectedRolloutStage,
      systemHttpStatus: 200,
      systemOk: true,
      activationReady: true,
      database: "ready",
      databaseCapabilityVersion: "2",
      releaseManifestCanaryGuardsVersion: "1",
      canonicalExecutionHardeningVersion: "1",
      proofArchitectureVersion: "1",
      proofArchitectureAuthority: "native",
      paused: false,
      workerProtocolExpected: "playlist-pipeline-v12",
      workerProtocolActual: "playlist-pipeline-v12",
      interactiveWorker: interactive.lane,
      deepWorker: deep.lane,
    };
  });
}

function payloadValidator(
  value: unknown,
): {
  payload: JsonRecord;
  verified: Omit<VerifiedPublicRolloutEvidence, "payloadHash">;
} {
  const payload = exactObject(value, [
    "schemaVersion",
    "generatedAt",
    "expiresAt",
    "environment",
    "candidate",
    "promotion",
    "transition",
    "soak",
    "targetConfiguration",
    "targetConfigurationHash",
  ], "public rollout evidence");
  if (payload.schemaVersion !== PUBLIC_ROLLOUT_EVIDENCE_SCHEMA_VERSION) {
    throw new Error("public rollout evidence uses an unsupported schema");
  }
  const generatedAt = isoTimestamp(
    payload.generatedAt,
    "public rollout evidence.generatedAt",
  );
  const expiresAt = isoTimestamp(
    payload.expiresAt,
    "public rollout evidence.expiresAt",
  );
  const validity = Date.parse(expiresAt) - Date.parse(generatedAt);
  if (validity <= 0 || validity > RELEASE_EVIDENCE_TTL_MS) {
    throw new Error("public rollout evidence must expire within 24 hours");
  }
  if (payload.environment !== "production") {
    throw new Error("public rollout evidence must attest production");
  }
  const candidateValue = candidate(payload.candidate);
  const promotion = exactObject(payload.promotion, [
    "configurationHash",
    "runtimeHash",
    "semanticBehaviorHash",
    "productionCanaryEvidenceHash",
    "sitesVersion",
    "sitesRevision",
    "sitesCandidateMatched",
    "databaseSchemaVersion",
    "databaseCapabilityVersion",
    "releaseManifestCanaryGuardsVersion",
    "canonicalExecutionHardeningVersion",
    "proofArchitectureVersion",
    "proofArchitectureAuthority",
    "workerProtocol",
  ], "public rollout promotion");
  for (const field of [
    "configurationHash",
    "runtimeHash",
    "semanticBehaviorHash",
    "productionCanaryEvidenceHash",
  ] as const) {
    sha256Digest(promotion[field], `public rollout promotion.${field}`);
  }
  if (
    typeof promotion.sitesVersion !== "string"
    || !VERSION.test(promotion.sitesVersion)
    || typeof promotion.sitesRevision !== "string"
    || !FULL_REVISION.test(promotion.sitesRevision)
    || promotion.sitesCandidateMatched !== false
    || (
      promotion.sitesVersion === candidateValue.version
      && promotion.sitesRevision === candidateValue.sourceRevision
    )
  ) {
    throw new Error(
      "public rollout promotion must preserve the exact prior Sites identity",
    );
  }
  if (
    promotion.databaseSchemaVersion !== "20"
    || promotion.databaseCapabilityVersion !== "2"
    || promotion.releaseManifestCanaryGuardsVersion !== "1"
    || promotion.canonicalExecutionHardeningVersion !== "1"
    || promotion.proofArchitectureVersion !== "1"
    || promotion.proofArchitectureAuthority !== "native"
    || promotion.workerProtocol !== "playlist-pipeline-v12"
  ) {
    throw new Error(
      "public rollout promotion requires schema 20, native proof architecture 1, composite capability 2, both authoritative marker-1 values, and protocol 12",
    );
  }
  const soak = exactObject(payload.soak, [
    "runtimeSnapshot",
    "startedAt",
    "completedAt",
    "durationSeconds",
    "healthySampleCount",
    "observationsHash",
    "observations",
    "eligibleOldWorkerCount",
    "intentStageMetrics",
  ], "public rollout soak");
  const runtimeSnapshot = exactObject(soak.runtimeSnapshot, [
    "configuration",
    "runtime",
    "configurationHash",
    "runtimeHash",
  ], "public rollout soak.runtimeSnapshot");
  const snapshotConfiguration = releaseConfiguration(
    runtimeSnapshot.configuration,
  );
  const snapshotRuntime = releaseRuntime(runtimeSnapshot.runtime);
  const snapshotConfigurationHash = sha256Digest(
    runtimeSnapshot.configurationHash,
    "public rollout soak.runtimeSnapshot.configurationHash",
  );
  const snapshotRuntimeHash = sha256Digest(
    runtimeSnapshot.runtimeHash,
    "public rollout soak.runtimeSnapshot.runtimeHash",
  );
  if (
    snapshotConfigurationHash !== signedArtifactSha256(snapshotConfiguration)
    || snapshotRuntimeHash !== signedArtifactSha256(snapshotRuntime)
    || snapshotRuntimeHash !== promotion.runtimeHash
    || promotion.semanticBehaviorHash !== semanticBehaviorHashV1(snapshotRuntime)
  ) {
    throw new Error(
      "public rollout soak runtime and semantic behavior do not match the fresh signed promotion",
    );
  }
  const soakStartedAt = isoTimestamp(
    soak.startedAt,
    "public rollout soak.startedAt",
  );
  const soakCompletedAt = isoTimestamp(
    soak.completedAt,
    "public rollout soak.completedAt",
  );
  const observedDurationSeconds =
    (Date.parse(soakCompletedAt) - Date.parse(soakStartedAt)) / 1_000;
  if (
    !Number.isSafeInteger(soak.durationSeconds)
    || Number(soak.durationSeconds) < 60
    || Number(soak.durationSeconds) !== observedDurationSeconds
  ) {
    throw new Error(
      "public rollout soak must prove at least 60 elapsed seconds across the Railway overlap window",
    );
  }
  const transition = exactObject(payload.transition, [
    "operation",
    "intentGroup",
    "fromPercent",
    "toPercent",
    "currentPercentages",
    "previousRolloutEvidenceHash",
    "previousRolloutStage",
    "rollbackWarrantHash",
    "intentCanaryHash",
    "preserveInFlightRoute",
    "rollbackPercent",
  ], "public rollout transition");
  if (transition.operation !== "advance" && transition.operation !== "rollback_to_zero") {
    throw new Error("public rollout transition.operation is invalid");
  }
  if (
    typeof transition.intentGroup !== "string"
    || !Object.hasOwn(PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS, transition.intentGroup)
  ) {
    throw new Error("public rollout transition.intentGroup is invalid");
  }
  const intentGroup = transition.intentGroup as PublicRolloutIntentGroup;
  if (
    typeof transition.fromPercent !== "string"
    || !(PUBLIC_ROLLOUT_PERCENT_LADDER as readonly string[]).includes(
      transition.fromPercent,
    )
    || typeof transition.toPercent !== "string"
    || !(PUBLIC_ROLLOUT_PERCENT_LADDER as readonly string[]).includes(
      transition.toPercent,
    )
  ) {
    throw new Error("public rollout transition percentages are invalid");
  }
  const fromPercent = transition.fromPercent as PublicRolloutPercent;
  const toPercent = transition.toPercent as PublicRolloutPercent;
  const currentPercentages = percentages(
    transition.currentPercentages,
    "public rollout transition.currentPercentages",
  );
  if (transition.preserveInFlightRoute !== true || transition.rollbackPercent !== "0") {
    throw new Error(
      "public rollout transition must preserve in-flight routes and rollback to zero",
    );
  }
  const previousRolloutEvidenceHash = transition.previousRolloutEvidenceHash === null
    ? null
    : sha256Digest(
      transition.previousRolloutEvidenceHash,
      "public rollout transition.previousRolloutEvidenceHash",
    );
  const previousRolloutStage = transition.previousRolloutStage === null
    ? null
    : (
        typeof transition.previousRolloutStage === "string"
        && ROLLOUT_STAGE.test(transition.previousRolloutStage)
      )
      ? transition.previousRolloutStage
      : (() => {
          throw new Error("public rollout transition.previousRolloutStage is invalid");
        })();
  if (
    (previousRolloutEvidenceHash === null) !== (previousRolloutStage === null)
  ) {
    throw new Error(
      "public rollout previous runtime evidence hash and stage must be present together",
    );
  }
  const rollbackWarrantHash = transition.rollbackWarrantHash === null
    ? null
    : sha256Digest(
      transition.rollbackWarrantHash,
      "public rollout transition.rollbackWarrantHash",
    );
  if (
    (transition.operation === "advance" && rollbackWarrantHash !== null)
    || (transition.operation === "rollback_to_zero" && rollbackWarrantHash === null)
  ) {
    throw new Error(
      "public rollout rollback warrant hash is permitted only and required for rollback",
    );
  }
  const intentCanaryHash = sha256Digest(
    transition.intentCanaryHash,
    "public rollout transition.intentCanaryHash",
  );
  if (
    transition.operation === "advance"
    && snapshotConfigurationHash !== promotion.configurationHash
  ) {
    throw new Error(
      "public rollout advance runtime snapshot does not match the fresh signed promotion configuration",
    );
  }
  const observations = soakObservations({
    value: soak.observations,
    backendVersion: String(candidateValue.version),
    backendRevision: String(candidateValue.sourceRevision),
    sitesVersion: String(promotion.sitesVersion),
    sitesRevision: String(promotion.sitesRevision),
    configuration: snapshotConfiguration,
    expectedRolloutEvidenceHash: previousRolloutEvidenceHash,
    expectedRolloutStage: previousRolloutStage,
  });
  const derivedStartedAt = observations[0]!.observedAt;
  const derivedCompletedAt = observations.at(-1)!.observedAt;
  if (
    soakStartedAt !== derivedStartedAt
    || soakCompletedAt !== derivedCompletedAt
    || soak.healthySampleCount !== observations.length
    || soak.observationsHash !== signedArtifactSha256(observations)
  ) {
    throw new Error(
      "public rollout soak summary does not match its live observations",
    );
  }
  if (soak.eligibleOldWorkerCount !== 0) {
    throw new Error("public rollout soak still has an eligible old worker");
  }
  let intentStageMetrics:
    | VerifiedPublicRolloutEvidence["soak"]["intentStageMetrics"] = null;
  if (transition.operation === "advance") {
    const metrics = exactObject(soak.intentStageMetrics, [
      "windowStartedAt",
      "windowCompletedAt",
      "eligibleSubmissionCount",
      "candidateAssignedCount",
      "exactCompletionCount",
    ], "public rollout soak.intentStageMetrics");
    const windowStartedAt = isoTimestamp(
      metrics.windowStartedAt,
      "public rollout soak.intentStageMetrics.windowStartedAt",
    );
    const windowCompletedAt = isoTimestamp(
      metrics.windowCompletedAt,
      "public rollout soak.intentStageMetrics.windowCompletedAt",
    );
    if (
      Date.parse(windowCompletedAt) <= Date.parse(windowStartedAt)
      || !Number.isSafeInteger(metrics.eligibleSubmissionCount)
      || Number(metrics.eligibleSubmissionCount) < 0
      || !Number.isSafeInteger(metrics.candidateAssignedCount)
      || Number(metrics.candidateAssignedCount) < 0
      || !Number.isSafeInteger(metrics.exactCompletionCount)
      || Number(metrics.exactCompletionCount) < 0
      || Number(metrics.exactCompletionCount)
        > Number(metrics.candidateAssignedCount)
      || Number(metrics.candidateAssignedCount)
        > Number(metrics.eligibleSubmissionCount)
      || Date.parse(windowCompletedAt) > Date.parse(generatedAt)
    ) {
      throw new Error(
        "public rollout soak intent stage metrics are invalid",
      );
    }
    intentStageMetrics = {
      windowStartedAt,
      windowCompletedAt,
      eligibleSubmissionCount: Number(metrics.eligibleSubmissionCount),
      candidateAssignedCount: Number(metrics.candidateAssignedCount),
      exactCompletionCount: Number(metrics.exactCompletionCount),
    };
  } else if (soak.intentStageMetrics !== null) {
    throw new Error(
      "public rollout rollback must not claim fresh intent stage metrics",
    );
  }
  if (
    Date.parse(soakCompletedAt) > Date.parse(generatedAt)
    || Date.parse(soakCompletedAt) < Date.parse(generatedAt) - 5 * 60_000
  ) {
    throw new Error("public rollout soak is not fresh for the signed transition");
  }
  const changedFlag = PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS[intentGroup];
  if (currentPercentages[changedFlag] !== fromPercent) {
    throw new Error(
      "public rollout transition.fromPercent does not match its current intent cohort",
    );
  }
  const target = targetConfiguration(payload.targetConfiguration);
  const targetPercentages = percentagesFromConfiguration(
    target as unknown as JsonRecord,
    "public rollout targetConfiguration",
  );
  for (const flag of PERCENT_FLAGS) {
    const expected = flag === changedFlag ? toPercent : currentPercentages[flag];
    if (targetPercentages[flag] !== expected) {
      throw new Error(
        "public rollout transition may change exactly one signed intent cohort",
      );
    }
  }
  if (transition.operation === "advance") {
    const fromIndex = PUBLIC_ROLLOUT_PERCENT_LADDER.indexOf(fromPercent);
    if (
      fromIndex < 0
      || PUBLIC_ROLLOUT_PERCENT_LADDER[fromIndex + 1] !== toPercent
    ) {
      throw new Error(
        "public rollout advance must follow owner→1%→10%→50%→100%",
      );
    }
  } else if (fromPercent === "0" || toPercent !== "0") {
    throw new Error("public rollout rollback must move an active cohort directly to zero");
  }
  const allCurrentZero = PERCENT_FLAGS.every(
    (flag) => currentPercentages[flag] === "0",
  );
  if (
    previousRolloutEvidenceHash === null
    && !(transition.operation === "advance" && fromPercent === "0" && allCurrentZero)
  ) {
    throw new Error(
      "public rollout transition requires the immediately previous signed rollout evidence",
    );
  }
  if (
    targetPercentages.PIPELINE_V3_GENRE_SCENE_PERCENT !== "0"
    && target.PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED !== "true"
  ) {
    throw new Error("genre-scene rollout requires signed genre-scene evidence approval");
  }
  if (
    (
      targetPercentages.PIPELINE_V3_FACTUAL_PERCENT !== "0"
      || targetPercentages.PIPELINE_V3_EXHAUSTIVE_PERCENT !== "0"
    )
    && target.PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED !== "true"
  ) {
    throw new Error("factual or exhaustive rollout requires signed feasibility approval");
  }
  const targetConfigurationHash = sha256Digest(
    payload.targetConfigurationHash,
    "public rollout targetConfigurationHash",
  );
  if (targetConfigurationHash !== signedArtifactSha256(target)) {
    throw new Error("public rollout target configuration hash does not match");
  }
  return {
    payload,
    verified: {
      generatedAt,
      expiresAt,
      promotionEvidenceHash: String(candidateValue.promotionEvidenceHash),
      previousRolloutEvidenceHash,
      previousRolloutStage,
      rollbackWarrantHash,
      intentCanaryHash,
      operation: transition.operation,
      intentGroup,
      fromPercent,
      toPercent,
      currentPercentages,
      targetConfiguration: target,
      targetConfigurationHash,
      apiConfigurationHash: String(snapshotConfiguration.apiHash),
      soak: {
        startedAt: soakStartedAt,
        completedAt: soakCompletedAt,
        durationSeconds: Number(soak.durationSeconds),
        healthySampleCount: Number(soak.healthySampleCount),
        observationsHash: String(soak.observationsHash),
        observations,
        intentStageMetrics,
      },
    },
  };
}

function rollbackWarrantPayloadValidator(
  value: unknown,
): {
  payload: JsonRecord;
  verified: Omit<VerifiedPublicRolloutRollbackWarrant, "payloadHash">;
} {
  const payload = exactObject(value, [
    "schemaVersion",
    "generatedAt",
    "environment",
    "operation",
    "candidate",
    "advance",
    "rollback",
    "promotion",
  ], "public rollout rollback warrant");
  if (
    payload.schemaVersion
      !== PUBLIC_ROLLOUT_ROLLBACK_WARRANT_SCHEMA_VERSION
  ) {
    throw new Error("public rollout rollback warrant uses an unsupported schema");
  }
  const generatedAt = isoTimestamp(
    payload.generatedAt,
    "public rollout rollback warrant.generatedAt",
  );
  if (
    payload.environment !== "production"
    || payload.operation !== "rollback_to_zero"
  ) {
    throw new Error(
      "public rollout rollback warrant must authorize production rollback to zero",
    );
  }
  const candidateValue = candidate(payload.candidate);
  const advance = exactObject(payload.advance, [
    "payloadHash",
    "stage",
    "operation",
    "intentGroup",
    "fromPercent",
    "toPercent",
    "targetConfigurationHash",
    "intentCanaryHash",
    "targetPercentages",
  ], "public rollout rollback warrant.advance");
  const advancePayloadHash = sha256Digest(
    advance.payloadHash,
    "public rollout rollback warrant.advance.payloadHash",
  );
  if (
    advance.operation !== "advance"
    || typeof advance.intentGroup !== "string"
    || !Object.hasOwn(PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS, advance.intentGroup)
    || typeof advance.fromPercent !== "string"
    || !(PUBLIC_ROLLOUT_PERCENT_LADDER as readonly string[]).includes(
      advance.fromPercent,
    )
    || typeof advance.toPercent !== "string"
    || advance.toPercent === "0"
    || !(PUBLIC_ROLLOUT_PERCENT_LADDER as readonly string[]).includes(
      advance.toPercent,
    )
  ) {
    throw new Error(
      "public rollout rollback warrant must bind an exact nonzero advance",
    );
  }
  const intentGroup = advance.intentGroup as PublicRolloutIntentGroup;
  const advanceFromPercent = advance.fromPercent as PublicRolloutPercent;
  const advanceToPercent =
    advance.toPercent as Exclude<PublicRolloutPercent, "0">;
  const expectedAdvanceStage =
    `${intentGroup}:${advanceFromPercent}->${advanceToPercent}`;
  if (advance.stage !== expectedAdvanceStage || !ROLLOUT_STAGE.test(String(advance.stage))) {
    throw new Error(
      "public rollout rollback warrant advance stage does not match its transition",
    );
  }
  const advanceTargetConfigurationHash = sha256Digest(
    advance.targetConfigurationHash,
    "public rollout rollback warrant.advance.targetConfigurationHash",
  );
  const advanceIntentCanaryHash = sha256Digest(
    advance.intentCanaryHash,
    "public rollout rollback warrant.advance.intentCanaryHash",
  );
  const advanceTargetPercentages = percentages(
    advance.targetPercentages,
    "public rollout rollback warrant.advance.targetPercentages",
  );
  const changedFlag = PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS[intentGroup];
  if (advanceTargetPercentages[changedFlag] !== advanceToPercent) {
    throw new Error(
      "public rollout rollback warrant advance target does not match its intent",
    );
  }
  const rollback = exactObject(payload.rollback, [
    "operation",
    "intentGroup",
    "fromPercent",
    "toPercent",
    "currentPercentages",
    "targetConfiguration",
    "targetConfigurationHash",
  ], "public rollout rollback warrant.rollback");
  if (
    rollback.operation !== "rollback_to_zero"
    || rollback.intentGroup !== intentGroup
    || rollback.fromPercent !== advanceToPercent
    || rollback.toPercent !== "0"
  ) {
    throw new Error(
      "public rollout rollback warrant must authorize only its advanced intent directly to zero",
    );
  }
  const rollbackCurrentPercentages = percentages(
    rollback.currentPercentages,
    "public rollout rollback warrant.rollback.currentPercentages",
  );
  for (const flag of PERCENT_FLAGS) {
    if (rollbackCurrentPercentages[flag] !== advanceTargetPercentages[flag]) {
      throw new Error(
        "public rollout rollback warrant current percentages do not match the advance target",
      );
    }
  }
  const rollbackTargetConfiguration = targetConfiguration(
    rollback.targetConfiguration,
  );
  const rollbackTargetPercentages = percentagesFromConfiguration(
    rollbackTargetConfiguration as unknown as JsonRecord,
    "public rollout rollback warrant.rollback.targetConfiguration",
  );
  for (const flag of PERCENT_FLAGS) {
    const expected = flag === changedFlag
      ? "0"
      : rollbackCurrentPercentages[flag];
    if (rollbackTargetPercentages[flag] !== expected) {
      throw new Error(
        "public rollout rollback warrant target may zero only its affected intent",
      );
    }
  }
  const rollbackTargetConfigurationHash = sha256Digest(
    rollback.targetConfigurationHash,
    "public rollout rollback warrant.rollback.targetConfigurationHash",
  );
  if (
    rollbackTargetConfigurationHash
      !== signedArtifactSha256(rollbackTargetConfiguration)
  ) {
    throw new Error(
      "public rollout rollback warrant target configuration hash does not match",
    );
  }
  const promotion = exactObject(payload.promotion, [
    "configurationHash",
    "runtimeHash",
    "productionCanaryEvidenceHash",
    "sitesVersion",
    "sitesRevision",
    "sitesCandidateMatched",
    "databaseSchemaVersion",
    "databaseCapabilityVersion",
    "releaseManifestCanaryGuardsVersion",
    "canonicalExecutionHardeningVersion",
    "proofArchitectureVersion",
    "proofArchitectureAuthority",
    "workerProtocol",
  ], "public rollout rollback warrant.promotion");
  const promotionConfigurationHash = sha256Digest(
    promotion.configurationHash,
    "public rollout rollback warrant.promotion.configurationHash",
  );
  const promotionRuntimeHash = sha256Digest(
    promotion.runtimeHash,
    "public rollout rollback warrant.promotion.runtimeHash",
  );
  const productionCanaryEvidenceHash = sha256Digest(
    promotion.productionCanaryEvidenceHash,
    "public rollout rollback warrant.promotion.productionCanaryEvidenceHash",
  );
  if (
    typeof promotion.sitesVersion !== "string"
    || !VERSION.test(promotion.sitesVersion)
    || typeof promotion.sitesRevision !== "string"
    || !FULL_REVISION.test(promotion.sitesRevision)
    || promotion.sitesCandidateMatched !== false
    || promotion.databaseSchemaVersion !== "20"
    || promotion.databaseCapabilityVersion !== "2"
    || promotion.releaseManifestCanaryGuardsVersion !== "1"
    || promotion.canonicalExecutionHardeningVersion !== "1"
    || promotion.proofArchitectureVersion !== "1"
    || promotion.proofArchitectureAuthority !== "native"
    || promotion.workerProtocol !== "playlist-pipeline-v12"
  ) {
    throw new Error(
      "public rollout rollback warrant does not preserve the exact pre-Sites promotion",
    );
  }
  return {
    payload,
    verified: {
      generatedAt,
      candidate: {
        tag: String(candidateValue.tag),
        version: String(candidateValue.version),
        sourceRevision: String(candidateValue.sourceRevision),
        imageDigest: String(candidateValue.imageDigest),
        promotionEvidenceHash: String(candidateValue.promotionEvidenceHash),
      },
      advance: {
        payloadHash: advancePayloadHash,
        stage: expectedAdvanceStage,
        intentGroup,
        fromPercent: advanceFromPercent,
        toPercent: advanceToPercent,
        targetConfigurationHash: advanceTargetConfigurationHash,
        intentCanaryHash: advanceIntentCanaryHash,
        targetPercentages: advanceTargetPercentages,
      },
      rollback: {
        operation: "rollback_to_zero",
        intentGroup,
        fromPercent: advanceToPercent,
        toPercent: "0",
        currentPercentages: rollbackCurrentPercentages,
        targetConfiguration: rollbackTargetConfiguration,
        targetConfigurationHash: rollbackTargetConfigurationHash,
      },
      promotion: {
        configurationHash: promotionConfigurationHash,
        runtimeHash: promotionRuntimeHash,
        productionCanaryEvidenceHash,
        sitesVersion: String(promotion.sitesVersion),
        sitesRevision: String(promotion.sitesRevision),
      },
    },
  };
}

export function buildPublicRolloutRollbackWarrantPayload(input: {
  advance: VerifiedPublicRolloutEvidence;
  candidate: {
    tag: string;
    version: string;
    sourceRevision: string;
    imageDigest: string;
  };
  promotion: {
    configurationHash: string;
    runtimeHash: string;
    productionCanaryEvidenceHash: string;
    sitesVersion: string;
    sitesRevision: string;
  };
  generatedAt?: string;
}): JsonRecord {
  if (input.advance.operation !== "advance" || input.advance.toPercent === "0") {
    throw new Error("rollback warrants can be minted only for a nonzero advance");
  }
  const changedFlag =
    PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS[input.advance.intentGroup];
  const currentPercentages = publicRolloutPercentages(
    input.advance.targetConfiguration,
  );
  const target = validatePublicRolloutConfiguration({
    ...input.advance.targetConfiguration,
    [changedFlag]: "0",
  });
  return {
    schemaVersion: PUBLIC_ROLLOUT_ROLLBACK_WARRANT_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? input.advance.generatedAt,
    environment: "production",
    operation: "rollback_to_zero",
    candidate: {
      ...input.candidate,
      promotionEvidenceHash: input.advance.promotionEvidenceHash,
    },
    advance: {
      payloadHash: input.advance.payloadHash,
      stage:
        `${input.advance.intentGroup}:${input.advance.fromPercent}->${input.advance.toPercent}`,
      operation: "advance",
      intentGroup: input.advance.intentGroup,
      fromPercent: input.advance.fromPercent,
      toPercent: input.advance.toPercent,
      targetConfigurationHash: input.advance.targetConfigurationHash,
      intentCanaryHash: input.advance.intentCanaryHash,
      targetPercentages: currentPercentages,
    },
    rollback: {
      operation: "rollback_to_zero",
      intentGroup: input.advance.intentGroup,
      fromPercent: input.advance.toPercent,
      toPercent: "0",
      currentPercentages,
      targetConfiguration: target,
      targetConfigurationHash: signedArtifactSha256(target),
    },
    promotion: {
      ...input.promotion,
      sitesCandidateMatched: false,
      databaseSchemaVersion: "20",
      databaseCapabilityVersion: "2",
      releaseManifestCanaryGuardsVersion: "1",
      canonicalExecutionHardeningVersion: "1",
      proofArchitectureVersion: "1",
      proofArchitectureAuthority: "native",
      workerProtocol: "playlist-pipeline-v12",
    },
  };
}

export interface VerifyPublicRolloutRollbackWarrantOptions {
  expectedTag: string;
  expectedVersion: string;
  expectedRevision: string;
  expectedImageDigest: string;
  expectedPromotionEvidenceHash: string;
  expectedPromotionConfigurationHash: string;
  expectedPromotionRuntimeHash: string;
  expectedProductionCanaryEvidenceHash: string;
  expectedSitesVersion: string;
  expectedSitesRevision: string;
  expectedAdvance?: VerifiedPublicRolloutEvidence;
  expectedRollback?: VerifiedPublicRolloutEvidence;
  now?: string;
}

export function verifyPublicRolloutRollbackWarrant(
  value: unknown,
  verificationKey: string | Buffer | KeyObject,
  options: VerifyPublicRolloutRollbackWarrantOptions,
): VerifiedPublicRolloutRollbackWarrant {
  if (!options.expectedAdvance && !options.expectedRollback) {
    throw new Error(
      "public rollout rollback warrant verification requires exact transition context",
    );
  }
  let validated: ReturnType<typeof rollbackWarrantPayloadValidator> | null = null;
  const envelope = verifyStrictSignedEnvelope({
    value,
    verificationKey,
    envelopeSchemaVersion:
      SIGNED_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_SCHEMA_VERSION,
    payloadLabel: "public rollout rollback warrant",
    validatePayload: (payload) => {
      validated = rollbackWarrantPayloadValidator(payload);
      return validated.payload;
    },
  });
  const result = validated!.verified;
  if (
    result.candidate.tag !== options.expectedTag
    || result.candidate.version !== options.expectedVersion
    || result.candidate.sourceRevision !== options.expectedRevision
    || result.candidate.imageDigest !== options.expectedImageDigest
    || result.candidate.promotionEvidenceHash
      !== options.expectedPromotionEvidenceHash
    || result.promotion.configurationHash
      !== options.expectedPromotionConfigurationHash
    || result.promotion.runtimeHash !== options.expectedPromotionRuntimeHash
    || result.promotion.productionCanaryEvidenceHash
      !== options.expectedProductionCanaryEvidenceHash
    || result.promotion.sitesVersion !== options.expectedSitesVersion
    || result.promotion.sitesRevision !== options.expectedSitesRevision
  ) {
    throw new Error(
      "public rollout rollback warrant does not bind the exact candidate, promotion, canaries, and prior Sites identity",
    );
  }
  const advance = options.expectedAdvance;
  if (advance) {
    if (
      advance.operation !== "advance"
      || advance.toPercent === "0"
      || result.advance.payloadHash !== advance.payloadHash
      || result.advance.stage
        !== `${advance.intentGroup}:${advance.fromPercent}->${advance.toPercent}`
      || result.advance.intentGroup !== advance.intentGroup
      || result.advance.fromPercent !== advance.fromPercent
      || result.advance.toPercent !== advance.toPercent
      || result.advance.targetConfigurationHash
        !== advance.targetConfigurationHash
      || result.advance.intentCanaryHash !== advance.intentCanaryHash
      || signedArtifactSha256(result.advance.targetPercentages)
        !== signedArtifactSha256(
          publicRolloutPercentages(advance.targetConfiguration),
        )
    ) {
      throw new Error(
        "public rollout rollback warrant does not bind the exact signed advance",
      );
    }
    if (
      Date.parse(result.generatedAt) < Date.parse(advance.generatedAt)
      || Date.parse(result.generatedAt) > Date.parse(advance.generatedAt) + 5 * 60_000
    ) {
      throw new Error(
        "public rollout rollback warrant was not minted with its signed advance",
      );
    }
  }
  const rollback = options.expectedRollback;
  if (rollback) {
    const reconstructedCurrentConfiguration =
      validatePublicRolloutConfiguration({
        ...rollback.targetConfiguration,
        [PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS[rollback.intentGroup]]:
          rollback.fromPercent,
      });
    if (
      rollback.operation !== "rollback_to_zero"
      || rollback.toPercent !== "0"
      || result.advance.payloadHash !== rollback.previousRolloutEvidenceHash
      || result.advance.stage !== rollback.previousRolloutStage
      || result.rollback.intentGroup !== rollback.intentGroup
      || result.rollback.fromPercent !== rollback.fromPercent
      || result.rollback.toPercent !== rollback.toPercent
      || result.rollback.targetConfigurationHash
        !== rollback.targetConfigurationHash
      || signedArtifactSha256(result.rollback.currentPercentages)
        !== signedArtifactSha256(rollback.currentPercentages)
      || signedArtifactSha256(result.rollback.targetConfiguration)
        !== signedArtifactSha256(rollback.targetConfiguration)
      || result.advance.targetConfigurationHash
        !== signedArtifactSha256(reconstructedCurrentConfiguration)
      || result.advance.intentCanaryHash !== rollback.intentCanaryHash
      || envelope.payloadHash !== rollback.rollbackWarrantHash
    ) {
      throw new Error(
        "public rollout rollback evidence does not match its signed zero-only warrant",
      );
    }
  }
  const now = isoTimestamp(
    options.now ?? new Date().toISOString(),
    "public rollout rollback warrant verification time",
  );
  if (Date.parse(result.generatedAt) > Date.parse(now) + 5 * 60_000) {
    throw new Error("public rollout rollback warrant was generated in the future");
  }
  return Object.freeze({
    payloadHash: envelope.payloadHash,
    ...result,
  });
}

export interface VerifyPublicRolloutEvidenceOptions {
  expectedTag: string;
  expectedVersion: string;
  expectedRevision: string;
  expectedImageDigest: string;
  expectedPromotionEvidenceHash?: string;
  expectedPromotionConfigurationHash?: string;
  expectedPromotionRuntimeHash?: string;
  expectedProductionCanaryEvidenceHash?: string;
  expectedOwnerCanaryGroups: string;
  expectedOwnerCanaryMaximumTracks: string;
  expectedPreviousTargetPercentages?: PublicRolloutPercentages | null;
  expectedPreviousRolloutEvidenceHash?: string | null;
  expectedPreviousRolloutStage?: string | null;
  intentCanary?: unknown;
  intentCanaryVerificationKey?: string | Buffer | KeyObject;
  intentCanaryTrust?: PublicRolloutIntentCanaryTrustV1;
  intentCanaryAuthorityPolicyHash?: string;
  rollbackWarrant?: unknown;
  minimumSoakStartedAt?: string;
  now?: string;
}

function claimedIntentCanaryExecutorIdentityHash(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("public rollout advance requires a signed intent canary");
  }
  const payload = (value as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("public rollout advance requires a signed intent canary");
  }
  const candidateValue = (payload as { candidate?: unknown }).candidate;
  if (
    !candidateValue
    || typeof candidateValue !== "object"
    || Array.isArray(candidateValue)
  ) {
    throw new Error("public rollout advance requires a signed intent canary");
  }
  return sha256Digest(
    (candidateValue as { executorIdentityHash?: unknown })
      .executorIdentityHash,
    "public rollout intent canary claimed executor identity",
  );
}

function verifyPublicRolloutEvidenceInternal(
  value: unknown,
  verificationKey: string | Buffer | KeyObject,
  options: VerifyPublicRolloutEvidenceOptions,
  acceptHistoricalExpiration: boolean,
  requireRollbackWarrant: boolean,
  requireIntentCanary: boolean,
): VerifiedPublicRolloutEvidence {
  let validated:
    | ReturnType<typeof payloadValidator>
    | null = null;
  const envelope = verifyStrictSignedEnvelope({
    value,
    verificationKey,
    envelopeSchemaVersion: SIGNED_PUBLIC_ROLLOUT_EVIDENCE_SCHEMA_VERSION,
    payloadLabel: "public rollout evidence",
    validatePayload: (payload) => {
      validated = payloadValidator(payload);
      return validated.payload;
    },
  });
  const result = validated!.verified;
  const payload = validated!.payload;
  const candidateValue = payload.candidate as JsonRecord;
  const promotion = payload.promotion as JsonRecord;
  if (
    candidateValue.tag !== options.expectedTag
    || candidateValue.version !== options.expectedVersion
    || candidateValue.sourceRevision !== options.expectedRevision
    || candidateValue.imageDigest !== options.expectedImageDigest
    || (
      options.expectedPromotionEvidenceHash !== undefined
      && result.promotionEvidenceHash !== options.expectedPromotionEvidenceHash
    )
  ) {
    throw new Error("public rollout evidence does not match the exact promoted candidate");
  }
  if (
    (
      options.expectedPromotionConfigurationHash !== undefined
      && promotion.configurationHash !== options.expectedPromotionConfigurationHash
    )
    || (
      options.expectedPromotionRuntimeHash !== undefined
      && promotion.runtimeHash !== options.expectedPromotionRuntimeHash
    )
    || (
      options.expectedProductionCanaryEvidenceHash !== undefined
      && promotion.productionCanaryEvidenceHash
        !== options.expectedProductionCanaryEvidenceHash
    )
  ) {
    throw new Error(
      "public rollout evidence does not match the signed production configuration, runtime, and canaries",
    );
  }
  if (
    result.targetConfiguration.PIPELINE_V3_OWNER_CANARY_GROUPS
      !== options.expectedOwnerCanaryGroups
    || result.targetConfiguration.PIPELINE_V3_OWNER_CANARY_MAX_TRACKS
      !== options.expectedOwnerCanaryMaximumTracks
  ) {
    throw new Error("public rollout evidence changed the signed owner candidate route");
  }
  if (result.operation === "advance" && requireIntentCanary) {
    if (
      options.intentCanary === undefined
      || options.intentCanaryVerificationKey === undefined
      || options.intentCanaryTrust === undefined
      || options.intentCanaryAuthorityPolicyHash === undefined
    ) {
      throw new Error(
        "public rollout advance requires its exact protected-producer intent canary",
      );
    }
    const intentCanary = verifyTrustedPublicRolloutIntentCanaryV1(
      options.intentCanary,
      options.intentCanaryVerificationKey,
      {
        tag: String(candidateValue.tag),
        version: String(candidateValue.version),
        sourceRevision: String(candidateValue.sourceRevision),
        imageDigest: String(candidateValue.imageDigest),
        apiConfigurationHash: result.apiConfigurationHash,
        executorIdentityHash:
          claimedIntentCanaryExecutorIdentityHash(options.intentCanary),
        intentGroup: result.intentGroup,
        fromPercent: result.fromPercent,
        toPercent:
          result.toPercent as Exclude<PublicRolloutPercent, "0">,
        targetConfigurationHash: result.targetConfigurationHash,
        authorityPolicyHash: options.intentCanaryAuthorityPolicyHash,
        now: options.now,
      },
      options.intentCanaryTrust,
    );
    if (
      intentCanary.payloadHash !== result.intentCanaryHash
      || intentCanary.provenance.rolloutEvidenceKeySha256
        !== publicRolloutIntentCanaryKeyFingerprint(verificationKey)
      || !result.soak.intentStageMetrics
      || signedArtifactSha256(result.soak.intentStageMetrics)
        !== signedArtifactSha256(intentCanary.stageMetrics)
      || Date.parse(result.soak.startedAt)
        < Date.parse(intentCanary.stageMetrics.windowCompletedAt)
    ) {
      throw new Error(
        "public rollout evidence does not bind its exact intent canary and stage metrics",
      );
    }
  } else if (
    options.intentCanary !== undefined
    || options.intentCanaryVerificationKey !== undefined
    || options.intentCanaryTrust !== undefined
    || options.intentCanaryAuthorityPolicyHash !== undefined
  ) {
    throw new Error(
      result.operation === "rollback_to_zero"
        ? "public rollout rollback must not consume a fresh intent canary"
        : "historical public rollout lineage must use its embedded intent canary hash",
    );
  }
  if (result.operation === "rollback_to_zero" && requireRollbackWarrant) {
    if (options.rollbackWarrant === undefined) {
      throw new Error(
        "public rollout rollback requires its durable signed rollback warrant",
      );
    }
    verifyPublicRolloutRollbackWarrant(
      options.rollbackWarrant,
      verificationKey,
      {
        expectedTag: String(candidateValue.tag),
        expectedVersion: String(candidateValue.version),
        expectedRevision: String(candidateValue.sourceRevision),
        expectedImageDigest: String(candidateValue.imageDigest),
        expectedPromotionEvidenceHash: result.promotionEvidenceHash,
        expectedPromotionConfigurationHash: String(promotion.configurationHash),
        expectedPromotionRuntimeHash: String(promotion.runtimeHash),
        expectedProductionCanaryEvidenceHash:
          String(promotion.productionCanaryEvidenceHash),
        expectedSitesVersion: String(promotion.sitesVersion),
        expectedSitesRevision: String(promotion.sitesRevision),
        expectedRollback: {
          payloadHash: envelope.payloadHash,
          ...result,
        },
        now: options.now,
      },
    );
  } else if (
    result.operation === "advance"
    && options.rollbackWarrant !== undefined
  ) {
    throw new Error(
      "public rollout advance must not consume an emergency rollback warrant",
    );
  }
  if (
    Object.hasOwn(options, "expectedPreviousRolloutEvidenceHash")
    && result.previousRolloutEvidenceHash
      !== (options.expectedPreviousRolloutEvidenceHash ?? null)
  ) {
    throw new Error(
      "public rollout evidence does not chain to the immediately previous rollout",
    );
  }
  if (
    Object.hasOwn(options, "expectedPreviousRolloutStage")
    && result.previousRolloutStage !== (options.expectedPreviousRolloutStage ?? null)
  ) {
    throw new Error(
      "public rollout evidence does not bind the expected previous live rollout stage",
    );
  }
  if (options.minimumSoakStartedAt) {
    const minimumSoakStartedAt = isoTimestamp(
      options.minimumSoakStartedAt,
      "public rollout minimum soak start",
    );
    if (Date.parse(result.soak.startedAt) < Date.parse(minimumSoakStartedAt)) {
      throw new Error(
        "public rollout soak predates the production canaries or previous signed transition",
      );
    }
  }
  if (options.expectedPreviousTargetPercentages) {
    for (const flag of PERCENT_FLAGS) {
      if (
        result.currentPercentages[flag]
          !== options.expectedPreviousTargetPercentages[flag]
      ) {
        throw new Error(
          "public rollout current cohorts do not match the previous signed target",
        );
      }
    }
  }
  const now = isoTimestamp(
    options.now ?? new Date().toISOString(),
    "public rollout verification time",
  );
  if (Date.parse(String(payload.generatedAt)) > Date.parse(now) + 5 * 60_000) {
    throw new Error("public rollout evidence was generated in the future");
  }
  if (
    !acceptHistoricalExpiration
    && Date.parse(String(payload.expiresAt)) <= Date.parse(now)
  ) {
    throw new Error("public rollout evidence has expired");
  }
  return Object.freeze({
    payloadHash: envelope.payloadHash,
    ...result,
  });
}

export function verifyPublicRolloutEvidence(
  value: unknown,
  verificationKey: string | Buffer | KeyObject,
  options: VerifyPublicRolloutEvidenceOptions,
): VerifiedPublicRolloutEvidence {
  return verifyPublicRolloutEvidenceInternal(
    value,
    verificationKey,
    options,
    false,
    true,
    true,
  );
}

/**
 * Historical evidence is accepted only as the immediately previous signed
 * lineage anchor. It cannot authorize a deployment by itself and therefore
 * deliberately has no generic `allowExpired` switch.
 */
export function verifyPreviousPublicRolloutLineage(
  value: unknown,
  verificationKey: string | Buffer | KeyObject,
  options: Omit<
    VerifyPublicRolloutEvidenceOptions,
    "minimumSoakStartedAt"
  >,
): VerifiedPublicRolloutEvidence {
  return verifyPublicRolloutEvidenceInternal(
    value,
    verificationKey,
    options,
    true,
    false,
    false,
  );
}

/**
 * Finalization consumes the last fully rolled-out intent as proof that every
 * governed backend cohort reached 100% while Sites still exposed the exact
 * pre-candidate identity. This verifier intentionally accepts no caller-owned
 * scope relaxation: the transition must be an advance to 100%, every target
 * percentage must be 100%, and the evidence must be fresh and chained to the
 * exact promotion artifact and runtime.
 */
export function verifyPublicRolloutFinalizationLineage(
  value: unknown,
  verificationKey: string | Buffer | KeyObject,
  options: {
    expectedTag: string;
    expectedVersion: string;
    expectedRevision: string;
    expectedImageDigest: string;
    expectedPromotionEvidenceHash: string;
    expectedPromotionConfigurationHash: string;
    expectedPromotionRuntimeHash: string;
    expectedSemanticBehaviorHash: string;
    expectedProductionCanaryEvidenceHash: string;
    expectedSitesVersion: string;
    expectedSitesRevision: string;
    minimumSoakStartedAt: string;
    now?: string;
  },
): VerifiedPublicRolloutEvidence {
  let validated: ReturnType<typeof payloadValidator> | null = null;
  const envelope = verifyStrictSignedEnvelope({
    value,
    verificationKey,
    envelopeSchemaVersion: SIGNED_PUBLIC_ROLLOUT_EVIDENCE_SCHEMA_VERSION,
    payloadLabel: "public rollout finalization lineage",
    validatePayload: (payload) => {
      validated = payloadValidator(payload);
      return validated.payload;
    },
  });
  const result = validated!.verified;
  const payload = validated!.payload;
  const candidateValue = payload.candidate as JsonRecord;
  const promotion = payload.promotion as JsonRecord;
  if (
    candidateValue.tag !== options.expectedTag
    || candidateValue.version !== options.expectedVersion
    || candidateValue.sourceRevision !== options.expectedRevision
    || candidateValue.imageDigest !== options.expectedImageDigest
    || candidateValue.promotionEvidenceHash
      !== options.expectedPromotionEvidenceHash
    || promotion.configurationHash
      !== options.expectedPromotionConfigurationHash
    || promotion.runtimeHash !== options.expectedPromotionRuntimeHash
    || promotion.semanticBehaviorHash
      !== options.expectedSemanticBehaviorHash
    || promotion.productionCanaryEvidenceHash
      !== options.expectedProductionCanaryEvidenceHash
    || promotion.sitesVersion !== options.expectedSitesVersion
    || promotion.sitesRevision !== options.expectedSitesRevision
    || promotion.sitesCandidateMatched !== false
  ) {
    throw new Error(
      "public rollout finalization lineage does not bind the exact pre-Sites promotion",
    );
  }
  if (result.operation !== "advance" || result.toPercent !== "100") {
    throw new Error(
      "finalization requires a completed signed backend cohort rollout to 100%",
    );
  }
  if (
    Object.values(publicRolloutPercentages(result.targetConfiguration))
      .some((percentage) => percentage !== "100")
  ) {
    throw new Error(
      "finalization requires every governed intent cohort at 100%",
    );
  }
  const minimumSoakStartedAt = isoTimestamp(
    options.minimumSoakStartedAt,
    "public rollout finalization minimum soak start",
  );
  if (Date.parse(result.soak.startedAt) < Date.parse(minimumSoakStartedAt)) {
    throw new Error(
      "public rollout finalization lineage predates its promotion evidence",
    );
  }
  const now = isoTimestamp(
    options.now ?? new Date().toISOString(),
    "public rollout finalization verification time",
  );
  if (
    Date.parse(result.generatedAt) > Date.parse(now) + 5 * 60_000
    || Date.parse(result.expiresAt) <= Date.parse(now)
  ) {
    throw new Error(
      "public rollout finalization lineage is not currently valid",
    );
  }
  return Object.freeze({
    payloadHash: envelope.payloadHash,
    ...result,
  });
}

export function publicRolloutPercentages(
  configuration: Pick<PublicRolloutConfiguration, PublicRolloutPercentFlag>,
): PublicRolloutPercentages {
  return Object.freeze(Object.fromEntries(
    PERCENT_FLAGS.map((flag) => [flag, configuration[flag]]),
  )) as PublicRolloutPercentages;
}

export function publicRolloutProductionCanaryEvidenceHash(
  gates: readonly {
    name: string;
    environment: string;
    passed: true;
    completedAt: string;
    evidenceHash: string;
    artifactSchemaVersion: string;
    configurationHash: string;
    runtimeHash: string;
    fixtures: readonly unknown[];
    cacheMode: string;
    budgetStatus: string;
  }[],
): string {
  const selected = PUBLIC_ROLLOUT_REQUIRED_PRODUCTION_GATES.map((name) => {
    const matches = gates.filter((gate) => gate.name === name);
    if (
      matches.length !== 1
      || matches[0]!.environment !== "production"
      || matches[0]!.passed !== true
    ) {
      throw new Error(`public rollout requires one passed ${name} production gate`);
    }
    return matches[0]!;
  });
  return signedArtifactSha256(selected);
}

export function publicRolloutLatestProductionCanaryCompletedAt(
  gates: readonly {
    name: string;
    environment: string;
    passed: true;
    completedAt: string;
  }[],
): string {
  const timestamps = PUBLIC_ROLLOUT_REQUIRED_PRODUCTION_GATES.map((name) => {
    const matches = gates.filter((gate) => gate.name === name);
    if (
      matches.length !== 1
      || matches[0]!.environment !== "production"
      || matches[0]!.passed !== true
    ) {
      throw new Error(`public rollout requires one passed ${name} production gate`);
    }
    return isoTimestamp(
      matches[0]!.completedAt,
      `public rollout ${name}.completedAt`,
    );
  });
  return new Date(Math.max(...timestamps.map(Date.parse))).toISOString();
}
