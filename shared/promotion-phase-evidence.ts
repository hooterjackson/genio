import type { KeyObject } from "node:crypto";
import { RELEASE_EVIDENCE_TTL_MS } from "./release-evidence-constants.ts";
import {
  REQUIRED_ACTIVATION_EXECUTION_CONTROLS,
  type RequiredActivationExecutionControls,
} from "./release-activation-contract.ts";
import {
  exactObject,
  type JsonRecord,
  sha256Digest,
  signedArtifactSha256,
  verifyStrictSignedEnvelope,
} from "./signed-artifact.ts";

export const PROMOTION_PHASE_EVIDENCE_SCHEMA_VERSION =
  "genio-promotion-phase-evidence/v2";
export const SIGNED_PROMOTION_PHASE_EVIDENCE_SCHEMA_VERSION =
  "genio-signed-promotion-phase-evidence/v2";
export const REQUIRED_PROMOTION_WORKER_PROTOCOL = "playlist-pipeline-v10";
export const ACTIVATION_COHORT_INVENTORY_STATEMENTS_V1 = [
  "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  [
    "SELECT cohort_key,route,intent_group,disabled,reason_code,changed_at",
    "FROM pipeline_cohort_kill_switches",
    "WHERE route IN ('catalog_first_v2','corpus_first_v3')",
    "ORDER BY route,intent_group NULLS FIRST,cohort_key",
  ].join(" "),
] as const;
export const ACTIVATION_COHORT_INVENTORY_QUERY_V1 =
  ACTIVATION_COHORT_INVENTORY_STATEMENTS_V1.join(";");
export const ACTIVATION_COHORT_INVENTORY_QUERY_HASH_V1 =
  signedArtifactSha256(ACTIVATION_COHORT_INVENTORY_QUERY_V1);

export const PUBLIC_ROLLOUT_PERCENT_FLAGS = [
  "PIPELINE_V2_CURATED_PERCENT",
  "PIPELINE_V2_SIMILARITY_PERCENT",
  "PIPELINE_V2_FACTUAL_PERCENT",
  "PIPELINE_V3_GENRE_SCENE_PERCENT",
  "PIPELINE_V3_MOOD_ACTIVITY_PERCENT",
  "PIPELINE_V3_SIMILARITY_PERCENT",
  "PIPELINE_V3_ARTIST_CATALOGUE_PERCENT",
  "PIPELINE_V3_FIXED_CONTAINER_PERCENT",
  "PIPELINE_V3_FACTUAL_PERCENT",
  "PIPELINE_V3_EXHAUSTIVE_PERCENT",
] as const;

export const OWNER_CANDIDATE_BOOLEAN_FLAGS = Object.freeze({
  PIPELINE_V2_OWNER_CANARY: "false",
  PIPELINE_V2_FACTUAL_OWNER_CANARY: "false",
  PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
  PIPELINE_V3_OWNER_CANARY: "true",
  PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED: "true",
  GUIDANCE_CONTRACT_V3_ENABLED: "false",
  GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
  GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "false",
} as const);

export type PromotionObservedPhase = "bridge" | "expand";

export interface ActivationRolloutConfiguration
  extends RequiredActivationExecutionControls {
  PIPELINE_V2_OWNER_CANARY: "false";
  PIPELINE_V2_CURATED_PERCENT: "0";
  PIPELINE_V2_SIMILARITY_PERCENT: "0";
  PIPELINE_V2_FACTUAL_OWNER_CANARY: "false";
  PIPELINE_V2_FACTUAL_PERCENT: "0";
  PIPELINE_V3_ASSIGNMENT_ENABLED: "true";
  PIPELINE_V3_OWNER_CANARY: "true";
  PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED: "true";
  PIPELINE_V3_OWNER_CANARY_GROUPS: string;
  PIPELINE_V3_OWNER_CANARY_MAX_TRACKS: string;
  PIPELINE_V3_GENRE_SCENE_PERCENT: "0";
  PIPELINE_V3_MOOD_ACTIVITY_PERCENT: "0";
  PIPELINE_V3_SIMILARITY_PERCENT: "0";
  PIPELINE_V3_ARTIST_CATALOGUE_PERCENT: "0";
  PIPELINE_V3_FIXED_CONTAINER_PERCENT: "0";
  PIPELINE_V3_FACTUAL_PERCENT: "0";
  PIPELINE_V3_EXHAUSTIVE_PERCENT: "0";
  GUIDANCE_CONTRACT_V3_ENABLED: "false";
  GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true";
  GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "false";
}

export interface VerifiedPromotionPhaseEvidence {
  phase: PromotionObservedPhase;
  payloadHash: string;
  configurationHash: string;
  databaseSchemaVersion: string;
  databaseCapabilityVersion: string | null;
  releaseManifestCanaryGuardsVersion: string | null;
  canonicalExecutionHardeningVersion: string | null;
  activationRollout: ActivationRolloutConfiguration | null;
}

const FULL_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const RC_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-rc\.[1-9]\d*$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_LABEL = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{0,159}$/u;
const SAFE_COHORT_KEY = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{0,159}$/u;
const SAFE_INTENT_GROUP = /^[a-z][a-z0-9_]{0,79}$/u;
const OWNER_ROUTE_GROUPS = [
  "genre_scene",
  "mood_activity_theme",
  "similarity",
  "artist_catalogue",
  "fixed_container",
  "factual_relationship",
  "exhaustive",
] as const;

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function safeLabel(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !SAFE_LABEL.test(value)
    || /(?:secret|token|password|authorization|sk-)/iu.test(value)
  ) {
    throw new Error(`${label} must be a non-secret release label`);
  }
  return value;
}

function fullRevision(value: unknown, label: string): string {
  if (typeof value !== "string" || !FULL_REVISION.test(value)) {
    throw new Error(`${label} must be a full Git revision`);
  }
  return value;
}

function imageDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !IMAGE_DIGEST.test(value)) {
    throw new Error(`${label} must be an immutable image digest`);
  }
  return value;
}

function exactArray<T>(
  value: unknown,
  label: string,
  validate: (item: unknown, index: number) => T,
): T[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => validate(item, index));
}

function validateCandidate(value: unknown): JsonRecord {
  const candidate = exactObject(value, [
    "tag",
    "version",
    "sourceRevision",
    "imageDigest",
    "candidateEvidenceHash",
  ], "promotion phase candidate");
  if (typeof candidate.tag !== "string" || !RC_TAG.test(candidate.tag)) {
    throw new Error("promotion phase candidate.tag must be an RC tag");
  }
  if (typeof candidate.version !== "string" || !VERSION.test(candidate.version)) {
    throw new Error("promotion phase candidate.version must be a semantic version");
  }
  if (!candidate.tag.startsWith(`v${candidate.version}-rc.`)) {
    throw new Error("promotion phase candidate tag and version do not match");
  }
  fullRevision(candidate.sourceRevision, "promotion phase candidate.sourceRevision");
  imageDigest(candidate.imageDigest, "promotion phase candidate.imageDigest");
  sha256Digest(
    candidate.candidateEvidenceHash,
    "promotion phase candidate.candidateEvidenceHash",
  );
  return candidate;
}

function validateRuntime(value: unknown, phase: PromotionObservedPhase): JsonRecord {
  const runtime = exactObject(value, [
    "releaseEnvironment",
    "deploymentPhase",
    "databaseSchemaVersion",
    "databaseCapabilityVersion",
    "releaseManifestCanaryGuardsVersion",
    "canonicalExecutionHardeningVersion",
    "workerProtocol",
    "configurationHash",
    "apiConfigurationHash",
    "interactiveWorkerConfigurationHash",
    "deepWorkerConfigurationHash",
  ], "promotion phase runtime");
  if (runtime.releaseEnvironment !== "production" || runtime.deploymentPhase !== phase) {
    throw new Error("promotion phase runtime does not match production and its observed phase");
  }
  if (
    typeof runtime.databaseSchemaVersion !== "string"
    || !/^(?:1[3-8])$/u.test(runtime.databaseSchemaVersion)
  ) {
    throw new Error("promotion phase runtime.databaseSchemaVersion is invalid");
  }
  const schema18 = runtime.databaseSchemaVersion === "18";
  if (
    runtime.databaseCapabilityVersion !== (schema18 ? "2" : null)
    || runtime.releaseManifestCanaryGuardsVersion !== (schema18 ? "1" : null)
    || runtime.canonicalExecutionHardeningVersion !== (schema18 ? "1" : null)
  ) {
    throw new Error(
      "promotion phase runtime does not bind composite capability 2 and both authoritative marker-1 values",
    );
  }
  if (runtime.workerProtocol !== REQUIRED_PROMOTION_WORKER_PROTOCOL) {
    throw new Error("promotion phase runtime.workerProtocol is not release-capable");
  }
  for (const field of [
    "configurationHash",
    "apiConfigurationHash",
    "interactiveWorkerConfigurationHash",
    "deepWorkerConfigurationHash",
  ] as const) {
    sha256Digest(runtime[field], `promotion phase runtime.${field}`);
  }
  const expectedConfigurationHash = signedArtifactSha256({
    apiHash: runtime.apiConfigurationHash,
    interactiveWorkerHash: runtime.interactiveWorkerConfigurationHash,
    deepWorkerHash: runtime.deepWorkerConfigurationHash,
  });
  if (runtime.configurationHash !== expectedConfigurationHash) {
    throw new Error(
      "promotion phase runtime.configurationHash does not match the three deployed services",
    );
  }
  return runtime;
}

function validateConvergence(value: unknown): JsonRecord {
  const convergence = exactObject(value, [
    "passed",
    "sampleCount",
    "observationsHash",
    "freshWorkerHeartbeatsPerLane",
    "eligibleOldWorkerCount",
  ], "promotion phase convergence");
  if (convergence.passed !== true) {
    throw new Error("promotion phase convergence did not pass");
  }
  if (
    !Number.isSafeInteger(convergence.sampleCount)
    || Number(convergence.sampleCount) < 2
    || Number(convergence.sampleCount) > 10
  ) {
    throw new Error("promotion phase convergence requires two to ten observations");
  }
  sha256Digest(convergence.observationsHash, "promotion phase convergence.observationsHash");
  if (
    !Number.isSafeInteger(convergence.freshWorkerHeartbeatsPerLane)
    || Number(convergence.freshWorkerHeartbeatsPerLane) < 2
  ) {
    throw new Error("promotion phase convergence requires two fresh heartbeats per lane");
  }
  if (convergence.eligibleOldWorkerCount !== 0) {
    throw new Error("promotion phase convergence still has an eligible old worker");
  }
  return convergence;
}

function validateActivationPreflight(value: unknown): {
  value: JsonRecord;
  rollout: ActivationRolloutConfiguration;
} {
  const preflight = exactObject(value, [
    "capturedAt",
    "databaseIdentityHash",
    "databaseSnapshotId",
    "cohortQueryHash",
    "cohortInventoryHash",
    "inventoryComplete",
    "affectedCohorts",
    "rolloutFlags",
    "ownerCandidateRoute",
    "activationConfiguration",
  ], "activation preflight");
  isoTimestamp(preflight.capturedAt, "activation preflight.capturedAt");
  for (const field of [
    "databaseIdentityHash",
    "cohortQueryHash",
    "cohortInventoryHash",
  ] as const) {
    sha256Digest(preflight[field], `activation preflight.${field}`);
  }
  safeLabel(preflight.databaseSnapshotId, "activation preflight.databaseSnapshotId");
  if (preflight.cohortQueryHash !== ACTIVATION_COHORT_INVENTORY_QUERY_HASH_V1) {
    throw new Error(
      "activation preflight was not produced by the complete cohort-inventory query",
    );
  }
  if (preflight.inventoryComplete !== true) {
    throw new Error("activation preflight does not prove a complete DB cohort inventory");
  }
  const affectedCohorts = exactArray(
    preflight.affectedCohorts,
    "activation preflight.affectedCohorts",
    (value, index) => {
      const cohort = exactObject(value, [
        "cohortKey",
        "route",
        "intentGroup",
        "disabled",
        "reasonCode",
        "changedAt",
      ], `activation preflight.affectedCohorts[${index}]`);
      if (
        typeof cohort.cohortKey !== "string"
        || !SAFE_COHORT_KEY.test(cohort.cohortKey)
      ) {
        throw new Error(`activation preflight.affectedCohorts[${index}].cohortKey is invalid`);
      }
      if (cohort.route !== "catalog_first_v2" && cohort.route !== "corpus_first_v3") {
        throw new Error(`activation preflight.affectedCohorts[${index}].route is invalid`);
      }
      if (
        cohort.intentGroup !== null
        && (
          typeof cohort.intentGroup !== "string"
          || !SAFE_INTENT_GROUP.test(cohort.intentGroup)
        )
      ) {
        throw new Error(`activation preflight.affectedCohorts[${index}].intentGroup is invalid`);
      }
      if (cohort.disabled !== true) {
        throw new Error("activation preflight contains an enabled affected DB cohort");
      }
      safeLabel(
        cohort.reasonCode,
        `activation preflight.affectedCohorts[${index}].reasonCode`,
      );
      isoTimestamp(
        cohort.changedAt,
        `activation preflight.affectedCohorts[${index}].changedAt`,
      );
      return cohort;
    },
  );
  if (
    affectedCohorts.length < 1
    || !affectedCohorts.some((cohort) => (
      cohort.route === "catalog_first_v2" && cohort.intentGroup === null
    ))
  ) {
    throw new Error(
      "activation preflight must prove the global catalog-first cohort is disabled",
    );
  }
  if (
    new Set(affectedCohorts.map((cohort) => (
      `${cohort.route}:${cohort.intentGroup ?? "<global>"}`
    ))).size !== affectedCohorts.length
  ) {
    throw new Error("activation preflight contains duplicate DB cohort controls");
  }
  const canonicalCohortSet = [...affectedCohorts]
    .map((cohort) => ({
      cohortKey: cohort.cohortKey,
      route: cohort.route,
      intentGroup: cohort.intentGroup,
      disabled: cohort.disabled,
      reasonCode: cohort.reasonCode,
      changedAt: cohort.changedAt,
    }))
    .sort((left, right) => (
      `${left.route}:${left.intentGroup ?? ""}:${left.cohortKey}`
        .localeCompare(`${right.route}:${right.intentGroup ?? ""}:${right.cohortKey}`)
    ));
  if (
    preflight.cohortInventoryHash
      !== signedArtifactSha256(canonicalCohortSet)
  ) {
    throw new Error("activation preflight cohort inventory hash does not match");
  }

  const rolloutFlags = exactObject(preflight.rolloutFlags, [
    ...PUBLIC_ROLLOUT_PERCENT_FLAGS,
    ...Object.keys(OWNER_CANDIDATE_BOOLEAN_FLAGS),
  ], "activation preflight.rolloutFlags");
  for (const flag of PUBLIC_ROLLOUT_PERCENT_FLAGS) {
    if (rolloutFlags[flag] !== "0") {
      throw new Error(`activation preflight requires ${flag}=0`);
    }
  }
  for (const [flag, expected] of Object.entries(OWNER_CANDIDATE_BOOLEAN_FLAGS)) {
    if (rolloutFlags[flag] !== expected) {
      throw new Error(`activation preflight requires ${flag}=${expected}`);
    }
  }

  const ownerCandidateRoute = exactObject(preflight.ownerCandidateRoute, [
    "route",
    "groups",
    "maximumTrackCount",
  ], "activation preflight.ownerCandidateRoute");
  if (ownerCandidateRoute.route !== "corpus_first_v3") {
    throw new Error("activation preflight owner candidate must use corpus_first_v3");
  }
  const groups = exactArray(
    ownerCandidateRoute.groups,
    "activation preflight.ownerCandidateRoute.groups",
    (value, index) => {
      if (
        typeof value !== "string"
        || !(OWNER_ROUTE_GROUPS as readonly string[]).includes(value)
      ) {
        throw new Error(
          `activation preflight.ownerCandidateRoute.groups[${index}] is invalid`,
        );
      }
      return value;
    },
  );
  if (
    groups.length < 1
    || groups.length !== new Set(groups).size
    || !groups.includes("genre_scene")
  ) {
    throw new Error(
      "activation preflight owner candidate groups must uniquely include genre_scene",
    );
  }
  if (
    !Number.isSafeInteger(ownerCandidateRoute.maximumTrackCount)
    || Number(ownerCandidateRoute.maximumTrackCount) < 50
    || Number(ownerCandidateRoute.maximumTrackCount) > 300
  ) {
    throw new Error(
      "activation preflight owner candidate maximumTrackCount must be 50 through 300",
    );
  }
  if (affectedCohorts.some((cohort) => (
    cohort.route === "corpus_first_v3"
    && (
      cohort.intentGroup === null
      || groups.includes(String(cohort.intentGroup))
    )
  ))) {
    throw new Error(
      "activation preflight DB controls would block the owner candidate route",
    );
  }
  const rollout: ActivationRolloutConfiguration = {
    ...REQUIRED_ACTIVATION_EXECUTION_CONTROLS,
    PIPELINE_V2_OWNER_CANARY: "false",
    PIPELINE_V2_CURATED_PERCENT: "0",
    PIPELINE_V2_SIMILARITY_PERCENT: "0",
    PIPELINE_V2_FACTUAL_OWNER_CANARY: "false",
    PIPELINE_V2_FACTUAL_PERCENT: "0",
    PIPELINE_V3_ASSIGNMENT_ENABLED: "true",
    PIPELINE_V3_OWNER_CANARY: "true",
    PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED: "true",
    PIPELINE_V3_OWNER_CANARY_GROUPS: groups.join(","),
    PIPELINE_V3_OWNER_CANARY_MAX_TRACKS:
      String(ownerCandidateRoute.maximumTrackCount),
    PIPELINE_V3_GENRE_SCENE_PERCENT: "0",
    PIPELINE_V3_MOOD_ACTIVITY_PERCENT: "0",
    PIPELINE_V3_SIMILARITY_PERCENT: "0",
    PIPELINE_V3_ARTIST_CATALOGUE_PERCENT: "0",
    PIPELINE_V3_FIXED_CONTAINER_PERCENT: "0",
    PIPELINE_V3_FACTUAL_PERCENT: "0",
    PIPELINE_V3_EXHAUSTIVE_PERCENT: "0",
    GUIDANCE_CONTRACT_V3_ENABLED: "false",
    GUIDANCE_CONTRACT_V3_OWNER_CANARY: "true",
    GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED: "false",
  };
  const signedRollout = exactObject(
    preflight.activationConfiguration,
    Object.keys(rollout),
    "activation preflight.activationConfiguration",
  );
  for (const [name, expected] of Object.entries(rollout)) {
    if (signedRollout[name] !== expected) {
      throw new Error(
        `activation preflight.activationConfiguration requires ${name}=${expected}`,
      );
    }
  }
  return {
    value: preflight,
    rollout: Object.freeze({
      ...signedRollout,
    }) as unknown as ActivationRolloutConfiguration,
  };
}

function validatePromotionPhasePayload(
  value: unknown,
): { payload: JsonRecord; activationRollout: ActivationRolloutConfiguration | null } {
  const payload = exactObject(value, [
    "schemaVersion",
    "generatedAt",
    "expiresAt",
    "environment",
    "phase",
    "candidate",
    "runtime",
    "convergence",
    "activationPreflight",
  ], "promotion phase evidence");
  if (payload.schemaVersion !== PROMOTION_PHASE_EVIDENCE_SCHEMA_VERSION) {
    throw new Error("promotion phase evidence uses an unsupported schema");
  }
  const generatedAt = isoTimestamp(
    payload.generatedAt,
    "promotion phase evidence.generatedAt",
  );
  const expiresAt = isoTimestamp(
    payload.expiresAt,
    "promotion phase evidence.expiresAt",
  );
  const validity = Date.parse(expiresAt) - Date.parse(generatedAt);
  if (validity <= 0 || validity > RELEASE_EVIDENCE_TTL_MS) {
    throw new Error("promotion phase evidence must expire within 24 hours");
  }
  if (payload.environment !== "production") {
    throw new Error("promotion phase evidence must attest production");
  }
  if (payload.phase !== "bridge" && payload.phase !== "expand") {
    throw new Error("promotion phase evidence phase must be bridge or expand");
  }
  validateCandidate(payload.candidate);
  validateRuntime(payload.runtime, payload.phase);
  validateConvergence(payload.convergence);
  let activationRollout: ActivationRolloutConfiguration | null = null;
  if (payload.phase === "expand") {
    if (payload.activationPreflight === null) {
      throw new Error("expand convergence requires activation preflight evidence");
    }
    const preflight = validateActivationPreflight(payload.activationPreflight);
    activationRollout = preflight.rollout;
    if (
      Date.parse(String(preflight.value.capturedAt)) < Date.parse(generatedAt) - 15 * 60_000
      || Date.parse(String(preflight.value.capturedAt)) > Date.parse(generatedAt) + 5 * 60_000
    ) {
      throw new Error("activation preflight is not fresh for expand convergence");
    }
  } else if (payload.activationPreflight !== null) {
    throw new Error("bridge convergence must not contain activation preflight evidence");
  }
  return { payload, activationRollout };
}

export function verifyPromotionPhaseEvidence(
  value: unknown,
  verificationKey: string | Buffer | KeyObject,
  options: {
    expectedPhase: PromotionObservedPhase;
    expectedTag: string;
    expectedVersion: string;
    expectedRevision: string;
    expectedImageDigest: string;
    expectedCandidateEvidenceHash: string;
    expectedConfigurationHash: string;
    expectedDatabaseSchemaVersion: string;
    expectedDatabaseCapabilityVersion: string | null;
    expectedReleaseManifestCanaryGuardsVersion: string | null;
    expectedCanonicalExecutionHardeningVersion: string | null;
    expectedDatabaseIdentityHash: string | null;
    now?: string;
  },
): VerifiedPromotionPhaseEvidence {
  let activationRollout: ActivationRolloutConfiguration | null = null;
  const verified = verifyStrictSignedEnvelope({
    value,
    verificationKey,
    envelopeSchemaVersion: SIGNED_PROMOTION_PHASE_EVIDENCE_SCHEMA_VERSION,
    payloadLabel: "promotion phase evidence",
    validatePayload: (payloadValue) => {
      const result = validatePromotionPhasePayload(payloadValue);
      activationRollout = result.activationRollout;
      return result.payload;
    },
  });
  const payload = verified.payload;
  const generatedAt = Date.parse(String(payload.generatedAt));
  const expiresAt = Date.parse(String(payload.expiresAt));
  const now = options.now
    ? Date.parse(isoTimestamp(options.now, "promotion phase verification time"))
    : Date.now();
  if (generatedAt > now + 5 * 60_000) {
    throw new Error("promotion phase evidence was generated in the future");
  }
  if (now >= expiresAt) {
    throw new Error("promotion phase evidence has expired");
  }
  if (payload.phase !== options.expectedPhase) {
    throw new Error("promotion phase evidence does not match the required prior phase");
  }
  const candidate = payload.candidate as JsonRecord;
  if (
    candidate.tag !== options.expectedTag
    || candidate.version !== options.expectedVersion
    || candidate.sourceRevision !== options.expectedRevision
    || candidate.imageDigest !== options.expectedImageDigest
    || candidate.candidateEvidenceHash !== options.expectedCandidateEvidenceHash
  ) {
    throw new Error("promotion phase evidence does not bind the exact candidate");
  }
  const runtime = payload.runtime as JsonRecord;
  if (
    runtime.configurationHash !== options.expectedConfigurationHash
    || runtime.databaseSchemaVersion !== options.expectedDatabaseSchemaVersion
    || runtime.databaseCapabilityVersion !== options.expectedDatabaseCapabilityVersion
    || runtime.releaseManifestCanaryGuardsVersion
      !== options.expectedReleaseManifestCanaryGuardsVersion
    || runtime.canonicalExecutionHardeningVersion
      !== options.expectedCanonicalExecutionHardeningVersion
  ) {
    throw new Error(
      "promotion phase evidence does not bind the expected configuration, schema, composite capability, and authoritative markers",
    );
  }
  const activationPreflight = payload.activationPreflight as JsonRecord | null;
  if (
    options.expectedPhase === "expand"
    && (
      !activationPreflight
      || activationPreflight.databaseIdentityHash
        !== options.expectedDatabaseIdentityHash
    )
  ) {
    throw new Error(
      "activation preflight does not bind the selected production database",
    );
  }
  if (
    options.expectedPhase === "bridge"
    && options.expectedDatabaseIdentityHash !== null
  ) {
    throw new Error("bridge evidence cannot bind an activation database preflight");
  }
  return {
    phase: options.expectedPhase,
    payloadHash: verified.payloadHash,
    configurationHash: String(runtime.configurationHash),
    databaseSchemaVersion: String(runtime.databaseSchemaVersion),
    databaseCapabilityVersion:
      runtime.databaseCapabilityVersion === null
        ? null
        : String(runtime.databaseCapabilityVersion),
    releaseManifestCanaryGuardsVersion:
      runtime.releaseManifestCanaryGuardsVersion === null
        ? null
        : String(runtime.releaseManifestCanaryGuardsVersion),
    canonicalExecutionHardeningVersion:
      runtime.canonicalExecutionHardeningVersion === null
        ? null
        : String(runtime.canonicalExecutionHardeningVersion),
    activationRollout,
  };
}
