import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MAXIMUM_STAGING_MONTHLY_COST_USD,
  RELEASE_EVIDENCE_TTL_MS,
} from "../shared/release-evidence-constants.ts";
import {
  stagingControlPlaneTrustPolicyV1,
  validateStagingControlPlaneTrustPolicyV1,
  verifyStagingControlPlaneEvidence,
  type StagingControlPlaneTrustPolicyV1,
} from "../shared/staging-control-plane-evidence.ts";
import {
  validateSitesControlPlaneTrustPolicyV1,
  validateSitesControlPlaneVerificationKeyV1,
  verifySitesControlPlaneAttestation,
} from "../shared/sites-control-plane-attestation.ts";
import {
  PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
  PUBLIC_ROLLOUT_PERCENT_LADDER,
  publicRolloutProductionCanaryEvidenceHash,
  verifyPublicRolloutFinalizationLineage,
  type PublicRolloutIntentGroup,
  type PublicRolloutPercent,
} from "../shared/public-rollout-evidence.ts";
import {
  semanticRankingCandidateBaselineFixturesV1,
  semanticRankingReviewerKeyFingerprint,
  semanticRankingReviewerTrustPolicyV1,
  validateSemanticRankingReviewArtifactV1,
  validateSemanticRankingReviewerTrustPolicyV1,
  validateSemanticRankingReviewerVerificationKeyV1,
  type SemanticRankingProtectedBaselineFixtureV1,
  type SemanticRankingReviewerTrustPolicyV1,
} from "../lib/semantic-ranking-review.ts";
import {
  semanticBehaviorHashV1,
} from "../shared/semantic-release-evidence.ts";
import {
  RELEASE_GATE_ARTIFACT_SCHEMA_V1,
  validateReleaseFixtureBindingsForGate,
  validateReleaseGateArtifact,
  verifyReleaseGateProducerAttestation,
  type ReleaseFixtureBindingV1,
  type ReleaseGateArtifactV1,
} from "./release-fixtures.ts";
import {
  verifyGithubOfflineAttestation,
  type GithubOfflineAttestationBindingV1,
} from "./github-offline-attestation.ts";

export { RELEASE_EVIDENCE_TTL_MS };

export const RELEASE_EVIDENCE_GATE_ENVIRONMENT = Object.freeze({
  offline_suite: "offline",
  staging_provider_manifest: "staging",
  staging_historical_replay: "staging",
  staging_fixed_three_track: "staging",
  staging_affected_regression: "staging",
  staging_guided_constraint: "staging",
  semantic_ranking_blinded_review: "staging",
  production_fixed_three_track: "production",
  production_affected_regression: "production",
  backend_release_convergence: "production",
  release_convergence: "production",
  final_custom_domain_browser: "production",
} as const);

export type ReleaseEvidenceGateName = keyof typeof RELEASE_EVIDENCE_GATE_ENVIRONMENT;
export type ReleaseEvidenceKind = "candidate" | "promotion" | "finalization";

export interface ReleaseGateProducerTrustPolicyV1 {
  schemaVersion: "genio-release-gate-producer-trust-policy/v1";
  approvedKeyId: string;
  approvedKeySha256: string;
}

export interface VerifiedCandidateSemanticReviewAuthorizationV1 {
  candidateEvidence: ReleaseEvidencePayloadV1;
  candidateEvidencePayloadHash: string;
  candidateEvidenceGeneratedAt: string;
  gateEvidenceHash: string;
  reviewedAt: string;
  semanticBehaviorHash: string;
  fixtures: readonly SemanticRankingProtectedBaselineFixtureV1[];
  producerKeySha256: string;
  reviewerKeySha256: string;
}

export interface ReleaseEvidenceGateV1 {
  name: ReleaseEvidenceGateName;
  environment: "offline" | "staging" | "production";
  passed: true;
  completedAt: string;
  evidenceHash: string;
  artifactSchemaVersion: typeof RELEASE_GATE_ARTIFACT_SCHEMA_V1;
  configurationHash: string;
  runtimeHash: string;
  fixtures: ReleaseFixtureBindingV1[];
  cacheMode: "reuse_disabled" | "not_applicable";
  budgetStatus: "within_cap" | "not_applicable";
}

export interface ReleaseEvidenceEnvironmentSnapshotV1 {
  scope: "backend" | "full";
  generatedAt: string;
  snapshotHash: string;
  sitesObservationHash: string;
  sitesVersion: string;
  sitesSourceRevision: string;
  sitesCandidateMatched: boolean;
  configurationHash: string;
  secretVersionsHash: string;
  runtimeHash: string;
  providerCredentialVersionHash: string;
  appleCredentialVersionHash: string;
  appleQaVerifierCredentialVersionHash: string;
  publicRollout: {
    active: boolean;
    databaseAuthorized: boolean;
    evidenceHash: string | null;
    stage: string | null;
    targetConfigurationHash: string | null;
  };
}

export interface ReleaseEvidenceSemanticReviewV1 {
  schemaVersion: "genio-release-semantic-review/v1";
  gateEvidenceHash: string;
  reviewedAt: string;
  semanticBehaviorHash: string;
  fixtures: readonly SemanticRankingProtectedBaselineFixtureV1[];
}

export interface ReleaseEvidencePayloadV1 {
  schemaVersion: "genio-release-evidence/v3";
  kind: ReleaseEvidenceKind;
  generatedAt: string;
  expiresAt: string;
  candidate: {
    tag: string;
    version: string;
    sourceRevision: string;
    imageDigest: string;
    sitesSourceRevision: string;
  };
  lineage: {
    candidateEvidencePayloadHash: string | null;
    candidateEvidenceGeneratedAt: string | null;
    promotionEvidencePayloadHash: string | null;
    promotionEvidenceGeneratedAt: string | null;
    publicRolloutEvidencePayloadHash: string | null;
    publicRolloutCompletedAt: string | null;
    publicRolloutIntentGroup: PublicRolloutIntentGroup | null;
    publicRolloutFromPercent: PublicRolloutPercent | null;
    publicRolloutToPercent: PublicRolloutPercent | null;
    publicRolloutTargetConfigurationHash: string | null;
  };
  configuration: {
    apiHash: string;
    interactiveWorkerHash: string;
    deepWorkerHash: string;
    sitesHash: string;
    secretVersionsHash: string;
  };
  stagingControls: {
    controlPlanePhase: "candidate" | "promotion" | "finalization";
    candidateEvidencePayloadHash: string | null;
    candidateSourceRevision: string;
    candidateImageDigest: string;
    candidateImageReference: string;
    monthlyCostLimitUsd: number;
    budgetRemainingUsd: number;
    reservedForRequiredGatesUsd: number;
    budgetStatus: "available";
    musicKitOrigin: string;
    providerSecretVersionHash: string;
    productionProviderSecretVersionHash: string;
    appleSecretVersionHash: string;
    productionAppleSecretVersionHash: string;
    appleQaVerifierSecretVersionHash: string;
    productionAppleQaVerifierSecretVersionHash: string;
    appleQaVerifierCredentialIdentityHash: string;
    productionAppleQaVerifierCredentialIdentityHash: string;
    providerProjectIdentityHash: string;
    productionProviderProjectIdentityHash: string;
    stagingRuntimeSnapshotHash: string;
    productionRuntimeSnapshotHash: string | null;
    stagingConfigurationHash: string;
    productionConfigurationHash: string | null;
    stagingSecretVersionsHash: string;
    productionSecretVersionsHash: string;
    stagingRailwayServiceInventoryHash: string;
    productionRailwayServiceInventoryHash: string;
    appleReceiptPayloadHash: string;
    providerReceiptPayloadHash: string;
    qaBudgetReceiptPayloadHash: string;
    appleAccountSeparationEvidenceHash: string;
    musicKitOriginRegistrationEvidenceHash: string;
    controlPlaneEvidenceHash: string;
    controlPlaneKeyId: string;
    controlPlaneKeyFingerprint: string;
  };
  runtime: {
    semanticExecutionConfigurationHash: string;
    releaseEnvironment: "staging" | "production";
    deploymentPhase: "activate";
    databaseSchemaVersion: string;
    databaseCapabilityVersion: "2";
    releaseManifestCanaryGuardsVersion: "1";
    canonicalExecutionHardeningVersion: "1";
    workerProtocol: string;
    briefContractVersion: string;
    queryPlanSchemaVersion: string;
    modelIds: {
      brief: string;
      baseline: string;
      escalation: string;
    };
    policyVersions: {
      guidance: string;
      evidence: string;
      queryPlan: string;
      selection: string;
      semanticScope: string;
      musicConcept: string;
      pipeline: string;
      prompt: string;
    };
  };
  semanticReview: ReleaseEvidenceSemanticReviewV1;
  environmentSnapshots: {
    staging: ReleaseEvidenceEnvironmentSnapshotV1;
    production: ReleaseEvidenceEnvironmentSnapshotV1 | null;
  };
  gates: ReleaseEvidenceGateV1[];
}

export interface ReleaseEvidenceSigningBundleV1 {
  schemaVersion: "genio-release-evidence-signing-bundle/v3";
  kind: ReleaseEvidenceKind;
  generatedAt: string;
  expiresAt: string;
  candidate: ReleaseEvidencePayloadV1["candidate"];
  stagingControlPlaneEvidenceFile: string;
  stagingControlPlaneVerificationKeyFile: string;
  offlineGithubAttestationFiles: {
    bundle: string;
    binding: string;
  };
  runtimeSnapshotFiles: {
    staging: string;
    production: string | null;
  };
  priorReleaseEvidenceFile: string | null;
  publicRolloutEvidenceFile: string | null;
  gateArtifactFiles: Partial<Record<ReleaseEvidenceGateName, string>>;
  gateAttestationFiles: Partial<Record<ReleaseEvidenceGateName, string>>;
}

export interface SignedReleaseEvidenceV1 {
  schemaVersion: "genio-signed-release-evidence/v3";
  payload: ReleaseEvidencePayloadV1;
  payloadHash: string;
  signature: {
    algorithm: "Ed25519";
    keyId: string;
    value: string;
  };
}

type JsonRecord = Record<string, unknown>;
export type GithubOfflineEvidenceVerifier = (input: {
  artifactPath: string;
  bundlePath: string;
  bindingValue: unknown;
}) => Promise<{
  artifact: ReleaseGateArtifactV1;
  binding: GithubOfflineAttestationBindingV1;
}>;

const CANDIDATE_GATES: readonly ReleaseEvidenceGateName[] = [
  "offline_suite",
  "staging_provider_manifest",
  "staging_historical_replay",
  "staging_fixed_three_track",
  "staging_affected_regression",
  "staging_guided_constraint",
  "semantic_ranking_blinded_review",
];
const PROMOTION_GATES: readonly ReleaseEvidenceGateName[] = [
  "production_fixed_three_track",
  "production_affected_regression",
  "backend_release_convergence",
];

const FINALIZATION_GATES: readonly ReleaseEvidenceGateName[] = [
  "release_convergence",
  "final_custom_domain_browser",
];
const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const SAFE_LABEL = /^[0-9A-Za-z][0-9A-Za-z._:+/-]{0,159}$/u;
const SIGNATURE_VALUE = /^[0-9A-Za-z_-]{64,256}$/u;
const REQUIRED_RUNTIME_CONTRACT = Object.freeze({
  deploymentPhase: "activate",
  databaseSchemaVersion: "18",
  databaseCapabilityVersion: "2",
  releaseManifestCanaryGuardsVersion: "1",
  canonicalExecutionHardeningVersion: "1",
  workerProtocol: "playlist-pipeline-v10",
  briefContractVersion: "3",
  queryPlanSchemaVersion: "5",
});
const REQUIRED_RUNTIME_POLICY_VERSIONS = Object.freeze({
  guidance: "adaptive_guidance_v3",
  evidence: "governed_evidence_v2",
});

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(record: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unapproved fields`);
  }
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

function label(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_LABEL.test(value) || /(?:sk-|secret|token|password)/iu.test(value)) {
    throw new Error(`${field} is not an approved release label`);
  }
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${field} must be a SHA-256 digest`);
  return value;
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

export function stableReleaseEvidenceJson(value: unknown): string {
  return JSON.stringify(sortedJsonValue(value));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableReleaseEvidenceJson(value)).digest("hex");
}

export function releaseEvidenceConfigurationHash(
  payload: Pick<ReleaseEvidencePayloadV1, "configuration">,
): string {
  return sha256(payload.configuration);
}

export function releaseEvidenceRuntimeHash(
  payload: Pick<ReleaseEvidencePayloadV1, "runtime">,
): string {
  return sha256(payload.runtime);
}

export interface LoadedRuntimeSnapshotV1 {
  schemaVersion: "genio-release-runtime-snapshot/v3";
  generatedAt: string;
  origin: string;
  environment: "staging" | "production";
  scope: "backend" | "full";
  candidate: {
    version: string;
    sourceRevision: string;
  };
  sitesObservation: {
    version: string;
    sourceRevision: string;
    configurationHash: string;
    ownerAllowlistVersion: string;
    candidateMatched: boolean;
  };
  apiObservations: {
    liveReplicaIdentityHash: string;
    systemReplicaIdentityHash: string;
  };
  executorFencing: {
    version: "1";
    ready: true;
    incompleteJobs: 0;
    mismatchedActiveAttempts: 0;
    uncoveredJobs: 0;
    requirementsHash: string;
  };
  configuration: ReleaseEvidencePayloadV1["configuration"];
  runtime: ReleaseEvidencePayloadV1["runtime"];
  publicRollout: ReleaseEvidenceEnvironmentSnapshotV1["publicRollout"];
  credentialVersionHashes: {
    provider: string;
    apple: string;
    appleQaVerifier: string;
  };
  configurationHash: string;
  runtimeHash: string;
  snapshotHash: string;
}

function validateConfigurationShape(
  value: unknown,
  labelPrefix = "configuration",
): ReleaseEvidencePayloadV1["configuration"] {
  const configuration = asRecord(value, labelPrefix);
  exactKeys(configuration, [
    "apiHash",
    "interactiveWorkerHash",
    "deepWorkerHash",
    "sitesHash",
    "secretVersionsHash",
  ], labelPrefix);
  for (const field of [
    "apiHash",
    "interactiveWorkerHash",
    "deepWorkerHash",
    "sitesHash",
    "secretVersionsHash",
  ] as const) {
    digest(configuration[field], `${labelPrefix}.${field}`);
  }
  return configuration as unknown as ReleaseEvidencePayloadV1["configuration"];
}

function validateRuntimeShape(
  value: unknown,
  expectedEnvironment: "staging" | "production",
  labelPrefix = "runtime",
): ReleaseEvidencePayloadV1["runtime"] {
  const runtime = asRecord(value, labelPrefix);
  exactKeys(runtime, [
    "semanticExecutionConfigurationHash",
    "releaseEnvironment",
    "deploymentPhase",
    "databaseSchemaVersion",
    "databaseCapabilityVersion",
    "releaseManifestCanaryGuardsVersion",
    "canonicalExecutionHardeningVersion",
    "workerProtocol",
    "briefContractVersion",
    "queryPlanSchemaVersion",
    "modelIds",
    "policyVersions",
  ], labelPrefix);
  digest(
    runtime.semanticExecutionConfigurationHash,
    `${labelPrefix}.semanticExecutionConfigurationHash`,
  );
  if (runtime.releaseEnvironment !== expectedEnvironment) {
    throw new Error(`${labelPrefix}.releaseEnvironment must be ${expectedEnvironment}`);
  }
  for (const field of [
    "deploymentPhase",
    "databaseSchemaVersion",
    "databaseCapabilityVersion",
    "releaseManifestCanaryGuardsVersion",
    "canonicalExecutionHardeningVersion",
    "workerProtocol",
    "briefContractVersion",
    "queryPlanSchemaVersion",
  ] as const) {
    label(runtime[field], `${labelPrefix}.${field}`);
    if (runtime[field] !== REQUIRED_RUNTIME_CONTRACT[field]) {
      throw new Error(
        `${labelPrefix}.${field} does not match the schema-18/protocol-10 release contract`,
      );
    }
  }
  const modelIds = asRecord(runtime.modelIds, `${labelPrefix}.modelIds`);
  exactKeys(modelIds, ["brief", "baseline", "escalation"], `${labelPrefix}.modelIds`);
  for (const field of ["brief", "baseline", "escalation"] as const) {
    label(modelIds[field], `${labelPrefix}.modelIds.${field}`);
  }
  const policyVersions = asRecord(runtime.policyVersions, `${labelPrefix}.policyVersions`);
  exactKeys(policyVersions, [
    "guidance",
    "evidence",
    "queryPlan",
    "selection",
    "semanticScope",
    "musicConcept",
    "pipeline",
    "prompt",
  ], `${labelPrefix}.policyVersions`);
  for (const field of [
    "guidance",
    "evidence",
    "queryPlan",
    "selection",
    "semanticScope",
    "musicConcept",
    "pipeline",
    "prompt",
  ] as const) {
    label(policyVersions[field], `${labelPrefix}.policyVersions.${field}`);
  }
  for (const field of ["guidance", "evidence"] as const) {
    if (policyVersions[field] !== REQUIRED_RUNTIME_POLICY_VERSIONS[field]) {
      throw new Error(
        `${labelPrefix}.policyVersions.${field} does not match the schema-18/protocol-10 release contract`,
      );
    }
  }
  return runtime as unknown as ReleaseEvidencePayloadV1["runtime"];
}

export function validateRuntimeSnapshot(
  value: unknown,
  expectedEnvironment: "staging" | "production",
  expectedScope: "backend" | "full",
): LoadedRuntimeSnapshotV1 {
  const root = asRecord(value, `${expectedEnvironment} runtime snapshot`);
  exactKeys(root, [
    "schemaVersion",
    "generatedAt",
    "origin",
    "environment",
    "scope",
    "candidate",
    "sitesObservation",
    "apiObservations",
    "executorFencing",
    "configuration",
    "runtime",
    "publicRollout",
    "credentialVersionHashes",
    "configurationHash",
    "runtimeHash",
    "snapshotHash",
  ], `${expectedEnvironment} runtime snapshot`);
  if (root.schemaVersion !== "genio-release-runtime-snapshot/v3"
    || root.environment !== expectedEnvironment
    || root.scope !== expectedScope) {
    throw new Error(
      `${expectedEnvironment} runtime snapshot uses the wrong schema, environment, or scope`,
    );
  }
  if (expectedEnvironment === "staging" && expectedScope !== "full") {
    throw new Error("staging runtime snapshot must use full scope");
  }
  timestamp(root.generatedAt, `${expectedEnvironment} runtime snapshot generatedAt`);
  if (typeof root.origin !== "string") {
    throw new Error(`${expectedEnvironment} runtime snapshot origin is invalid`);
  }
  let origin: URL;
  try {
    origin = new URL(root.origin);
  } catch {
    throw new Error(`${expectedEnvironment} runtime snapshot origin is invalid`);
  }
  if (origin.protocol !== "https:" || origin.origin !== root.origin
    || origin.pathname !== "/" || origin.username || origin.password) {
    throw new Error(`${expectedEnvironment} runtime snapshot origin is invalid`);
  }
  if (expectedEnvironment === "staging"
    && (origin.hostname === "9enio.com" || origin.hostname === "www.9enio.com")) {
    throw new Error("staging runtime snapshot cannot use the production origin");
  }
  if (
    expectedEnvironment === "production"
    && origin.origin !== "https://9enio.com"
  ) {
    throw new Error(
      "production runtime snapshot must use the canonical https://9enio.com origin",
    );
  }
  const candidate = asRecord(root.candidate, `${expectedEnvironment} runtime snapshot candidate`);
  exactKeys(candidate, ["version", "sourceRevision"], `${expectedEnvironment} runtime snapshot candidate`);
  if (typeof candidate.version !== "string" || !VERSION.test(candidate.version)
    || typeof candidate.sourceRevision !== "string"
    || !SOURCE_REVISION.test(candidate.sourceRevision)) {
    throw new Error(`${expectedEnvironment} runtime snapshot candidate is invalid`);
  }
  const sitesObservation = asRecord(
    root.sitesObservation,
    `${expectedEnvironment} runtime snapshot sitesObservation`,
  );
  exactKeys(sitesObservation, [
    "version",
    "sourceRevision",
    "configurationHash",
    "ownerAllowlistVersion",
    "candidateMatched",
  ], `${expectedEnvironment} runtime snapshot sitesObservation`);
  if (
    typeof sitesObservation.version !== "string"
    || !VERSION.test(sitesObservation.version)
    || typeof sitesObservation.sourceRevision !== "string"
    || !SOURCE_REVISION.test(sitesObservation.sourceRevision)
  ) {
    throw new Error(`${expectedEnvironment} runtime snapshot Sites identity is invalid`);
  }
  digest(
    sitesObservation.configurationHash,
    `${expectedEnvironment} runtime snapshot sitesObservation.configurationHash`,
  );
  label(
    sitesObservation.ownerAllowlistVersion,
    `${expectedEnvironment} runtime snapshot sitesObservation.ownerAllowlistVersion`,
  );
  if (typeof sitesObservation.candidateMatched !== "boolean") {
    throw new Error(
      `${expectedEnvironment} runtime snapshot sitesObservation.candidateMatched is invalid`,
    );
  }
  const observedCandidateMatch = sitesObservation.version === candidate.version
    && sitesObservation.sourceRevision === candidate.sourceRevision;
  if (
    sitesObservation.candidateMatched !== observedCandidateMatch
    || (expectedScope === "full" && !observedCandidateMatch)
    || (expectedScope === "backend" && observedCandidateMatch)
  ) {
    throw new Error(
      `${expectedEnvironment} runtime snapshot Sites candidate binding is invalid`,
    );
  }
  const apiObservations = asRecord(
    root.apiObservations,
    `${expectedEnvironment} runtime snapshot apiObservations`,
  );
  exactKeys(apiObservations, [
    "liveReplicaIdentityHash",
    "systemReplicaIdentityHash",
  ], `${expectedEnvironment} runtime snapshot apiObservations`);
  digest(
    apiObservations.liveReplicaIdentityHash,
    `${expectedEnvironment} runtime snapshot apiObservations.liveReplicaIdentityHash`,
  );
  digest(
    apiObservations.systemReplicaIdentityHash,
    `${expectedEnvironment} runtime snapshot apiObservations.systemReplicaIdentityHash`,
  );
  const executorFencing = asRecord(
    root.executorFencing,
    `${expectedEnvironment} runtime snapshot executorFencing`,
  );
  exactKeys(executorFencing, [
    "version",
    "ready",
    "incompleteJobs",
    "mismatchedActiveAttempts",
    "uncoveredJobs",
    "requirementsHash",
  ], `${expectedEnvironment} runtime snapshot executorFencing`);
  if (
    executorFencing.version !== "1"
    || executorFencing.ready !== true
    || executorFencing.incompleteJobs !== 0
    || executorFencing.mismatchedActiveAttempts !== 0
    || executorFencing.uncoveredJobs !== 0
  ) {
    throw new Error(
      `${expectedEnvironment} runtime snapshot executor fencing is not converged`,
    );
  }
  digest(
    executorFencing.requirementsHash,
    `${expectedEnvironment} runtime snapshot executorFencing.requirementsHash`,
  );
  const configuration = validateConfigurationShape(
    root.configuration,
    `${expectedEnvironment} runtime snapshot configuration`,
  );
  if (
    configuration.sitesHash !== sha256({
      buildIdentity: {
        version: sitesObservation.version,
        sourceRevision: sitesObservation.sourceRevision,
      },
      gatewayConfigurationHash: sitesObservation.configurationHash,
    })
  ) {
    throw new Error(
      `${expectedEnvironment} runtime snapshot Sites configuration binding does not match`,
    );
  }
  const runtime = validateRuntimeShape(
    root.runtime,
    expectedEnvironment,
    `${expectedEnvironment} runtime snapshot runtime`,
  );
  const publicRollout = asRecord(
    root.publicRollout,
    `${expectedEnvironment} runtime snapshot publicRollout`,
  );
  exactKeys(publicRollout, [
    "active",
    "databaseAuthorized",
    "evidenceHash",
    "stage",
    "targetConfigurationHash",
  ], `${expectedEnvironment} runtime snapshot publicRollout`);
  if (
    typeof publicRollout.active !== "boolean"
    || publicRollout.databaseAuthorized !== true
  ) {
    throw new Error(
      `${expectedEnvironment} runtime snapshot public rollout lacks database authority`,
    );
  }
  if (publicRollout.active) {
    digest(
      publicRollout.evidenceHash,
      `${expectedEnvironment} runtime snapshot publicRollout.evidenceHash`,
    );
    if (
      typeof publicRollout.stage !== "string"
      || !/^(?:genre_scene|mood_activity_theme|similarity|artist_catalogue|fixed_container|factual_relationship|exhaustive):(?:0|1|10|50|100)->(?:0|1|10|50|100)$/u
        .test(publicRollout.stage)
    ) {
      throw new Error(
        `${expectedEnvironment} runtime snapshot publicRollout.stage is invalid`,
      );
    }
    digest(
      publicRollout.targetConfigurationHash,
      `${expectedEnvironment} runtime snapshot publicRollout.targetConfigurationHash`,
    );
  } else if (
    publicRollout.evidenceHash !== null
    || publicRollout.stage !== null
    || publicRollout.targetConfigurationHash !== null
  ) {
    throw new Error(
      `${expectedEnvironment} runtime snapshot inactive public rollout has stale markers`,
    );
  }
  const credentialVersionHashes = asRecord(
    root.credentialVersionHashes,
    `${expectedEnvironment} runtime snapshot credentialVersionHashes`,
  );
  exactKeys(
    credentialVersionHashes,
    ["provider", "apple", "appleQaVerifier"],
    `${expectedEnvironment} runtime snapshot credentialVersionHashes`,
  );
  for (const field of ["provider", "apple", "appleQaVerifier"]) {
    digest(
      credentialVersionHashes[field],
      `${expectedEnvironment} runtime snapshot credentialVersionHashes.${field}`,
    );
  }
  const configurationHash = digest(
    root.configurationHash,
    `${expectedEnvironment} runtime snapshot configurationHash`,
  );
  const runtimeHash = digest(
    root.runtimeHash,
    `${expectedEnvironment} runtime snapshot runtimeHash`,
  );
  if (configurationHash !== releaseEvidenceConfigurationHash({ configuration })
    || runtimeHash !== releaseEvidenceRuntimeHash({ runtime })) {
    throw new Error(`${expectedEnvironment} runtime snapshot aggregate hashes do not match`);
  }
  const unsigned = {
    schemaVersion: root.schemaVersion,
    generatedAt: root.generatedAt,
    origin: root.origin,
    environment: root.environment,
    scope: root.scope,
    candidate: root.candidate,
    sitesObservation: root.sitesObservation,
    apiObservations: root.apiObservations,
    executorFencing: root.executorFencing,
    configuration: root.configuration,
    runtime: root.runtime,
    publicRollout: root.publicRollout,
    credentialVersionHashes: root.credentialVersionHashes,
    configurationHash: root.configurationHash,
    runtimeHash: root.runtimeHash,
  };
  if (digest(root.snapshotHash, `${expectedEnvironment} runtime snapshot snapshotHash`)
    !== sha256(unsigned)) {
    throw new Error(`${expectedEnvironment} runtime snapshot hash does not match its contents`);
  }
  return root as unknown as LoadedRuntimeSnapshotV1;
}

export function assertFinalizationRuntimePublicRolloutBindingV1(input: {
  runtimePublicRollout: ReleaseEvidenceEnvironmentSnapshotV1["publicRollout"];
  signedRollout: {
    payloadHash: string;
    intentGroup: string;
    fromPercent: string;
    toPercent: string;
    targetConfigurationHash: string;
  };
}): void {
  const expectedStage =
    `${input.signedRollout.intentGroup}:${input.signedRollout.fromPercent}->${input.signedRollout.toPercent}`;
  if (
    !input.runtimePublicRollout.active
    || !input.runtimePublicRollout.databaseAuthorized
    || input.runtimePublicRollout.evidenceHash
      !== input.signedRollout.payloadHash
    || input.runtimePublicRollout.stage !== expectedStage
    || input.runtimePublicRollout.targetConfigurationHash
      !== input.signedRollout.targetConfigurationHash
  ) {
    throw new Error(
      "finalization runtime snapshot does not prove the exact signed public rollout was database-authorized and active",
    );
  }
}

export function assertFinalizationBrowserPublicRolloutBindingV1(input: {
  probes: readonly unknown[];
  signedRollout: {
    payloadHash: string;
    intentGroup: string;
    fromPercent: string;
    toPercent: string;
  };
}): void {
  const expectedStage =
    `${input.signedRollout.intentGroup}:${input.signedRollout.fromPercent}->${input.signedRollout.toPercent}`;
  if (
    input.probes.length < 1
    || input.probes.some((probeValue, probeIndex) => {
      const probe = asRecord(
        probeValue,
        `final browser public assignment probe ${probeIndex}`,
      );
      return probe.rolloutEvidenceHash
          !== input.signedRollout.payloadHash
        || probe.rolloutStage !== expectedStage;
    })
  ) {
    throw new Error(
      "final browser probes do not bind the exact signed public rollout",
    );
  }
}

function requiredGates(kind: ReleaseEvidenceKind): readonly ReleaseEvidenceGateName[] {
  if (kind === "finalization") return FINALIZATION_GATES;
  return kind === "promotion" ? PROMOTION_GATES : CANDIDATE_GATES;
}

export function releaseGateProducerKeyFingerprint(
  value: string | Buffer | KeyObject,
): string {
  const parsed = value instanceof KeyObject ? value : createPublicKey(value);
  const key = parsed.type === "private" ? createPublicKey(parsed) : parsed;
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("release gate producer verification key must be Ed25519");
  }
  return createHash("sha256")
    .update(key.export({ format: "der", type: "spki" }))
    .digest("hex");
}

export function releaseGateProducerTrustPolicyV1(input: {
  approvedKeyId: string;
  approvedKeySha256: string;
}): ReleaseGateProducerTrustPolicyV1 {
  if (
    !/^[0-9A-Za-z][0-9A-Za-z._:-]{2,79}$/u.test(input.approvedKeyId)
    || !SHA256.test(input.approvedKeySha256)
  ) {
    throw new Error("approved release gate producer identity is invalid");
  }
  return {
    schemaVersion: "genio-release-gate-producer-trust-policy/v1",
    approvedKeyId: input.approvedKeyId,
    approvedKeySha256: input.approvedKeySha256,
  };
}

export function validateReleaseGateProducerTrustPolicyV1(
  value: unknown,
): ReleaseGateProducerTrustPolicyV1 {
  const policy = asRecord(value, "release gate producer trust policy");
  exactKeys(policy, [
    "schemaVersion",
    "approvedKeyId",
    "approvedKeySha256",
  ], "release gate producer trust policy");
  if (
    policy.schemaVersion
      !== "genio-release-gate-producer-trust-policy/v1"
  ) {
    throw new Error(
      "release gate producer trust policy uses an unsupported schema",
    );
  }
  return releaseGateProducerTrustPolicyV1({
    approvedKeyId: String(policy.approvedKeyId),
    approvedKeySha256: String(policy.approvedKeySha256),
  });
}

export function validateReleaseEvidencePayload(value: unknown): ReleaseEvidencePayloadV1 {
  const root = asRecord(value, "release evidence");
  exactKeys(root, [
    "schemaVersion",
    "kind",
    "generatedAt",
    "expiresAt",
    "candidate",
    "lineage",
    "configuration",
    "stagingControls",
    "runtime",
    "semanticReview",
    "environmentSnapshots",
    "gates",
  ], "release evidence");
  if (root.schemaVersion !== "genio-release-evidence/v3") {
    throw new Error("release evidence uses an unsupported schema");
  }
  if (
    root.kind !== "candidate"
    && root.kind !== "promotion"
    && root.kind !== "finalization"
  ) {
    throw new Error(
      "release evidence kind must be candidate, promotion, or finalization",
    );
  }
  const generatedAt = timestamp(root.generatedAt, "generatedAt");
  const expiresAt = timestamp(root.expiresAt, "expiresAt");
  const lifetime = Date.parse(expiresAt) - Date.parse(generatedAt);
  if (lifetime <= 0 || lifetime > RELEASE_EVIDENCE_TTL_MS) {
    throw new Error("release evidence must expire within 24 hours");
  }

  const candidate = asRecord(root.candidate, "candidate");
  exactKeys(candidate, [
    "tag",
    "version",
    "sourceRevision",
    "imageDigest",
    "sitesSourceRevision",
  ], "candidate");
  if (typeof candidate.version !== "string" || !VERSION.test(candidate.version)) {
    throw new Error("candidate.version must be a stable semantic version");
  }
  if (typeof candidate.tag !== "string"
    || !new RegExp(`^v${candidate.version.replaceAll(".", "\\.")}-rc\\.[1-9]\\d*$`, "u").test(candidate.tag)) {
    throw new Error("candidate.tag must be an RC tag for candidate.version");
  }
  if (typeof candidate.sourceRevision !== "string" || !SOURCE_REVISION.test(candidate.sourceRevision)) {
    throw new Error("candidate.sourceRevision must be a full Git revision");
  }
  if (typeof candidate.sitesSourceRevision !== "string" || !SOURCE_REVISION.test(candidate.sitesSourceRevision)) {
    throw new Error("candidate.sitesSourceRevision must be a full Git revision");
  }
  if (candidate.sitesSourceRevision !== candidate.sourceRevision) {
    throw new Error("Sites and backend evidence must bind the same source revision");
  }
  if (typeof candidate.imageDigest !== "string" || !IMAGE_DIGEST.test(candidate.imageDigest)) {
    throw new Error("candidate.imageDigest must be an immutable SHA-256 image digest");
  }

  const lineage = asRecord(root.lineage, "lineage");
  exactKeys(lineage, [
    "candidateEvidencePayloadHash",
    "candidateEvidenceGeneratedAt",
    "promotionEvidencePayloadHash",
    "promotionEvidenceGeneratedAt",
    "publicRolloutEvidencePayloadHash",
    "publicRolloutCompletedAt",
    "publicRolloutIntentGroup",
    "publicRolloutFromPercent",
    "publicRolloutToPercent",
    "publicRolloutTargetConfigurationHash",
  ], "lineage");
  const candidateEvidencePayloadHash =
    lineage.candidateEvidencePayloadHash === null
      ? null
      : digest(
          lineage.candidateEvidencePayloadHash,
          "lineage.candidateEvidencePayloadHash",
        );
  const candidateEvidenceGeneratedAt =
    lineage.candidateEvidenceGeneratedAt === null
      ? null
      : timestamp(
          lineage.candidateEvidenceGeneratedAt,
          "lineage.candidateEvidenceGeneratedAt",
        );
  const promotionEvidencePayloadHash =
    lineage.promotionEvidencePayloadHash === null
      ? null
      : digest(
          lineage.promotionEvidencePayloadHash,
          "lineage.promotionEvidencePayloadHash",
        );
  const promotionEvidenceGeneratedAt =
    lineage.promotionEvidenceGeneratedAt === null
      ? null
      : timestamp(
          lineage.promotionEvidenceGeneratedAt,
          "lineage.promotionEvidenceGeneratedAt",
        );
  const publicRolloutEvidencePayloadHash =
    lineage.publicRolloutEvidencePayloadHash === null
      ? null
      : digest(
          lineage.publicRolloutEvidencePayloadHash,
          "lineage.publicRolloutEvidencePayloadHash",
        );
  const publicRolloutCompletedAt =
    lineage.publicRolloutCompletedAt === null
      ? null
      : timestamp(
          lineage.publicRolloutCompletedAt,
          "lineage.publicRolloutCompletedAt",
        );
  const publicRolloutIntentGroup =
    lineage.publicRolloutIntentGroup === null
      ? null
      : label(
          lineage.publicRolloutIntentGroup,
          "lineage.publicRolloutIntentGroup",
        );
  if (
    publicRolloutIntentGroup !== null
    && !(publicRolloutIntentGroup in PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS)
  ) {
    throw new Error("lineage.publicRolloutIntentGroup is not governed");
  }
  const rolloutPercent = (
    value: unknown,
    field: string,
  ): PublicRolloutPercent | null => {
    if (value === null) return null;
    if (
      typeof value !== "string"
      || !PUBLIC_ROLLOUT_PERCENT_LADDER.includes(
        value as PublicRolloutPercent,
      )
    ) {
      throw new Error(`${field} is not an approved rollout percentage`);
    }
    return value as PublicRolloutPercent;
  };
  const publicRolloutFromPercent = rolloutPercent(
    lineage.publicRolloutFromPercent,
    "lineage.publicRolloutFromPercent",
  );
  const publicRolloutToPercent = rolloutPercent(
    lineage.publicRolloutToPercent,
    "lineage.publicRolloutToPercent",
  );
  const publicRolloutTargetConfigurationHash =
    lineage.publicRolloutTargetConfigurationHash === null
      ? null
      : digest(
          lineage.publicRolloutTargetConfigurationHash,
          "lineage.publicRolloutTargetConfigurationHash",
        );
  const candidateLineagePresent = candidateEvidencePayloadHash !== null
    && candidateEvidenceGeneratedAt !== null;
  const promotionLineagePresent = promotionEvidencePayloadHash !== null
    && promotionEvidenceGeneratedAt !== null;
  const rolloutLineagePresent = publicRolloutEvidencePayloadHash !== null
    && publicRolloutCompletedAt !== null
    && publicRolloutIntentGroup !== null
    && publicRolloutFromPercent !== null
    && publicRolloutToPercent !== null
    && publicRolloutTargetConfigurationHash !== null;
  const rolloutLineageNulls = [
    publicRolloutEvidencePayloadHash,
    publicRolloutCompletedAt,
    publicRolloutIntentGroup,
    publicRolloutFromPercent,
    publicRolloutToPercent,
    publicRolloutTargetConfigurationHash,
  ].filter((value) => value === null).length;
  if (
    (candidateEvidencePayloadHash === null)
      !== (candidateEvidenceGeneratedAt === null)
    || (promotionEvidencePayloadHash === null)
      !== (promotionEvidenceGeneratedAt === null)
    || (rolloutLineageNulls !== 0 && rolloutLineageNulls !== 6)
    || (root.kind === "candidate"
      && (
        candidateLineagePresent
        || promotionLineagePresent
        || rolloutLineagePresent
      ))
    || (root.kind === "promotion"
      && (
        !candidateLineagePresent
        || promotionLineagePresent
        || rolloutLineagePresent
      ))
    || (root.kind === "finalization"
      && (
        !candidateLineagePresent
        || !promotionLineagePresent
        || !rolloutLineagePresent
        || publicRolloutToPercent !== "100"
      ))
  ) {
    throw new Error(
      "release evidence lineage does not match candidate → promotion → rollout → finalization",
    );
  }
  if (
    candidateEvidenceGeneratedAt
    && Date.parse(candidateEvidenceGeneratedAt) >= Date.parse(generatedAt)
  ) {
    throw new Error("candidate evidence must predate its successor phase");
  }
  if (
    promotionEvidenceGeneratedAt
    && (
      !candidateEvidenceGeneratedAt
      || Date.parse(promotionEvidenceGeneratedAt)
        <= Date.parse(candidateEvidenceGeneratedAt)
      || Date.parse(promotionEvidenceGeneratedAt) >= Date.parse(generatedAt)
    )
  ) {
    throw new Error("promotion evidence chronology is invalid");
  }
  if (
    publicRolloutCompletedAt
    && (
      !promotionEvidenceGeneratedAt
      || Date.parse(publicRolloutCompletedAt)
        <= Date.parse(promotionEvidenceGeneratedAt)
      || Date.parse(publicRolloutCompletedAt) >= Date.parse(generatedAt)
    )
  ) {
    throw new Error("public rollout must complete before finalization");
  }

  const configuration = validateConfigurationShape(root.configuration);

  const stagingControls = asRecord(root.stagingControls, "stagingControls");
  exactKeys(stagingControls, [
    "controlPlanePhase",
    "candidateEvidencePayloadHash",
    "candidateSourceRevision",
    "candidateImageDigest",
    "candidateImageReference",
    "monthlyCostLimitUsd",
    "budgetRemainingUsd",
    "reservedForRequiredGatesUsd",
    "budgetStatus",
    "musicKitOrigin",
    "providerSecretVersionHash",
    "productionProviderSecretVersionHash",
    "appleSecretVersionHash",
    "productionAppleSecretVersionHash",
    "appleQaVerifierSecretVersionHash",
    "productionAppleQaVerifierSecretVersionHash",
    "appleQaVerifierCredentialIdentityHash",
    "productionAppleQaVerifierCredentialIdentityHash",
    "providerProjectIdentityHash",
    "productionProviderProjectIdentityHash",
    "stagingRuntimeSnapshotHash",
    "productionRuntimeSnapshotHash",
    "stagingConfigurationHash",
    "productionConfigurationHash",
    "stagingSecretVersionsHash",
    "productionSecretVersionsHash",
    "stagingRailwayServiceInventoryHash",
    "productionRailwayServiceInventoryHash",
    "appleReceiptPayloadHash",
    "providerReceiptPayloadHash",
    "qaBudgetReceiptPayloadHash",
    "appleAccountSeparationEvidenceHash",
    "musicKitOriginRegistrationEvidenceHash",
    "controlPlaneEvidenceHash",
    "controlPlaneKeyId",
    "controlPlaneKeyFingerprint",
  ], "stagingControls");
  const expectedControlPlanePhase = root.kind;
  if (stagingControls.controlPlanePhase !== expectedControlPlanePhase) {
    throw new Error(
      "staging control-plane evidence phase does not match release evidence kind",
    );
  }
  if (
    stagingControls.candidateSourceRevision !== candidate.sourceRevision
    || stagingControls.candidateImageDigest !== candidate.imageDigest
    || typeof stagingControls.candidateImageReference !== "string"
    || !/^ghcr\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/u
      .test(stagingControls.candidateImageReference)
    || !stagingControls.candidateImageReference.endsWith(
      `@${candidate.imageDigest}`,
    )
  ) {
    throw new Error(
      "staging control-plane evidence does not bind the exact candidate artifact",
    );
  }
  if (
    root.kind !== "candidate"
    && stagingControls.candidateEvidencePayloadHash
      !== candidateEvidencePayloadHash
  ) {
    throw new Error(
      "staging control-plane candidate evidence does not match release lineage",
    );
  }
  if (
    (root.kind === "candidate"
      && stagingControls.candidateEvidencePayloadHash !== null)
    || (
      root.kind !== "candidate"
      && (
        typeof stagingControls.candidateEvidencePayloadHash !== "string"
        || !SHA256.test(stagingControls.candidateEvidencePayloadHash)
      )
    )
  ) {
    throw new Error(
      "candidate evidence payload hash does not match the control-plane phase",
    );
  }
  const monthlyCostLimitUsd = Number(stagingControls.monthlyCostLimitUsd);
  const budgetRemainingUsd = Number(stagingControls.budgetRemainingUsd);
  const reservedForRequiredGatesUsd = Number(stagingControls.reservedForRequiredGatesUsd);
  if (
    !Number.isFinite(monthlyCostLimitUsd)
    || monthlyCostLimitUsd <= 0
    || monthlyCostLimitUsd > MAXIMUM_STAGING_MONTHLY_COST_USD
  ) {
    throw new Error("stagingControls.monthlyCostLimitUsd is not a valid capped QA budget");
  }
  if (
    !Number.isFinite(budgetRemainingUsd)
    || budgetRemainingUsd <= 0
    || budgetRemainingUsd > monthlyCostLimitUsd
    || !Number.isFinite(reservedForRequiredGatesUsd)
    || reservedForRequiredGatesUsd <= 0
    || reservedForRequiredGatesUsd > budgetRemainingUsd
  ) {
    throw new Error("staging QA budget cannot cover every required live gate");
  }
  if (stagingControls.budgetStatus !== "available") {
    throw new Error("staging QA budget is not available");
  }
  if (typeof stagingControls.musicKitOrigin !== "string") {
    throw new Error("stagingControls.musicKitOrigin must be a dedicated HTTPS origin");
  }
  let musicKitOrigin: URL;
  try {
    musicKitOrigin = new URL(stagingControls.musicKitOrigin);
  } catch {
    throw new Error("stagingControls.musicKitOrigin must be a dedicated HTTPS origin");
  }
  if (
    musicKitOrigin.protocol !== "https:"
    || musicKitOrigin.origin !== stagingControls.musicKitOrigin
    || musicKitOrigin.pathname !== "/"
    || musicKitOrigin.username
    || musicKitOrigin.password
    || musicKitOrigin.hostname === "9enio.com"
    || musicKitOrigin.hostname === "www.9enio.com"
  ) {
    throw new Error("stagingControls.musicKitOrigin must be a dedicated non-production HTTPS origin");
  }
  for (const field of [
    "providerSecretVersionHash",
    "productionProviderSecretVersionHash",
    "appleSecretVersionHash",
    "productionAppleSecretVersionHash",
    "appleQaVerifierSecretVersionHash",
    "productionAppleQaVerifierSecretVersionHash",
    "appleQaVerifierCredentialIdentityHash",
    "productionAppleQaVerifierCredentialIdentityHash",
    "providerProjectIdentityHash",
    "productionProviderProjectIdentityHash",
    "stagingRuntimeSnapshotHash",
    "stagingConfigurationHash",
    "stagingSecretVersionsHash",
    "productionSecretVersionsHash",
    "stagingRailwayServiceInventoryHash",
    "productionRailwayServiceInventoryHash",
    "appleReceiptPayloadHash",
    "providerReceiptPayloadHash",
    "qaBudgetReceiptPayloadHash",
    "appleAccountSeparationEvidenceHash",
    "musicKitOriginRegistrationEvidenceHash",
    "controlPlaneEvidenceHash",
    "controlPlaneKeyFingerprint",
  ] as const) {
    digest(stagingControls[field], `stagingControls.${field}`);
  }
  label(stagingControls.controlPlaneKeyId, "stagingControls.controlPlaneKeyId");
  for (const field of [
    "productionRuntimeSnapshotHash",
    "productionConfigurationHash",
  ] as const) {
    if (root.kind === "candidate") {
      if (stagingControls[field] !== null) {
        throw new Error(
          `candidate stagingControls.${field} must be null`,
        );
      }
    } else {
      digest(stagingControls[field], `stagingControls.${field}`);
    }
  }
  if (stagingControls.providerSecretVersionHash === stagingControls.productionProviderSecretVersionHash) {
    throw new Error("staging and production provider credential versions must be different");
  }
  if (stagingControls.appleSecretVersionHash === stagingControls.productionAppleSecretVersionHash) {
    throw new Error("staging and production Apple credential versions must be different");
  }
  if (
    stagingControls.appleQaVerifierSecretVersionHash
      === stagingControls.productionAppleQaVerifierSecretVersionHash
  ) {
    throw new Error(
      "staging and production Apple QA verifier credential versions must be different",
    );
  }
  if (
    stagingControls.appleQaVerifierCredentialIdentityHash
      === stagingControls.productionAppleQaVerifierCredentialIdentityHash
  ) {
    throw new Error(
      "staging and production Apple QA verifier identities must be different",
    );
  }
  if (
    stagingControls.providerProjectIdentityHash
      === stagingControls.productionProviderProjectIdentityHash
  ) {
    throw new Error(
      "staging and production provider project identities must be different",
    );
  }

  const requiredReleaseEnvironment = root.kind === "candidate"
    ? "staging"
    : "production";
  const runtime = validateRuntimeShape(root.runtime, requiredReleaseEnvironment);
  const semanticReviewValue = asRecord(
    root.semanticReview,
    "semanticReview",
  );
  exactKeys(semanticReviewValue, [
    "schemaVersion",
    "gateEvidenceHash",
    "reviewedAt",
    "semanticBehaviorHash",
    "fixtures",
  ], "semanticReview");
  if (
    semanticReviewValue.schemaVersion
      !== "genio-release-semantic-review/v1"
  ) {
    throw new Error("semanticReview uses an unsupported schema");
  }
  const semanticReviewGateEvidenceHash = digest(
    semanticReviewValue.gateEvidenceHash,
    "semanticReview.gateEvidenceHash",
  );
  const semanticReviewReviewedAt = timestamp(
    semanticReviewValue.reviewedAt,
    "semanticReview.reviewedAt",
  );
  const semanticBehaviorHash = digest(
    semanticReviewValue.semanticBehaviorHash,
    "semanticReview.semanticBehaviorHash",
  );
  if (semanticBehaviorHash !== semanticBehaviorHashV1(runtime)) {
    throw new Error(
      "semantic behavior hash does not match the signed release runtime",
    );
  }
  if (
    Date.parse(semanticReviewReviewedAt) > Date.parse(generatedAt) + 5 * 60_000
    || Date.parse(generatedAt) - Date.parse(semanticReviewReviewedAt)
      > RELEASE_EVIDENCE_TTL_MS
  ) {
    throw new Error("semantic review is outside the release evidence window");
  }
  if (
    !Array.isArray(semanticReviewValue.fixtures)
    || semanticReviewValue.fixtures.length < 3
  ) {
    throw new Error("semanticReview.fixtures must contain the reviewed fixtures");
  }
  const semanticReviewFixtures =
    semanticReviewValue.fixtures.map((value, index) => {
      const fixture = asRecord(value, `semanticReview.fixtures[${index}]`);
      exactKeys(
        fixture,
        ["fixtureId", "orderedManifestHash", "outputHash"],
        `semanticReview.fixtures[${index}]`,
      );
      return {
        fixtureId: label(
          fixture.fixtureId,
          `semanticReview.fixtures[${index}].fixtureId`,
        ),
        orderedManifestHash: digest(
          fixture.orderedManifestHash,
          `semanticReview.fixtures[${index}].orderedManifestHash`,
        ),
        outputHash: digest(
          fixture.outputHash,
          `semanticReview.fixtures[${index}].outputHash`,
        ),
      };
    });
  if (
    new Set(semanticReviewFixtures.map(({ fixtureId }) => fixtureId)).size
      !== semanticReviewFixtures.length
  ) {
    throw new Error("semanticReview.fixtures contains duplicate fixture IDs");
  }

  const environmentSnapshots = asRecord(root.environmentSnapshots, "environmentSnapshots");
  exactKeys(environmentSnapshots, ["staging", "production"], "environmentSnapshots");
  const snapshotBinding = (
    value: unknown,
    environment: "staging" | "production",
  ): ReleaseEvidenceEnvironmentSnapshotV1 => {
    const binding = asRecord(value, `environmentSnapshots.${environment}`);
    exactKeys(
      binding,
      [
        "scope",
        "generatedAt",
        "snapshotHash",
        "sitesObservationHash",
        "sitesVersion",
        "sitesSourceRevision",
        "sitesCandidateMatched",
        "configurationHash",
        "secretVersionsHash",
        "runtimeHash",
        "providerCredentialVersionHash",
        "appleCredentialVersionHash",
        "appleQaVerifierCredentialVersionHash",
        "publicRollout",
      ],
      `environmentSnapshots.${environment}`,
    );
    if (binding.scope !== "backend" && binding.scope !== "full") {
      throw new Error(`environmentSnapshots.${environment}.scope is invalid`);
    }
    timestamp(
      binding.generatedAt,
      `environmentSnapshots.${environment}.generatedAt`,
    );
    digest(binding.snapshotHash, `environmentSnapshots.${environment}.snapshotHash`);
    digest(
      binding.sitesObservationHash,
      `environmentSnapshots.${environment}.sitesObservationHash`,
    );
    if (typeof binding.sitesVersion !== "string"
      || !VERSION.test(binding.sitesVersion)) {
      throw new Error(
        `environmentSnapshots.${environment}.sitesVersion is invalid`,
      );
    }
    if (typeof binding.sitesSourceRevision !== "string"
      || !SOURCE_REVISION.test(binding.sitesSourceRevision)) {
      throw new Error(
        `environmentSnapshots.${environment}.sitesSourceRevision is invalid`,
      );
    }
    if (typeof binding.sitesCandidateMatched !== "boolean") {
      throw new Error(
        `environmentSnapshots.${environment}.sitesCandidateMatched is invalid`,
      );
    }
    digest(binding.configurationHash, `environmentSnapshots.${environment}.configurationHash`);
    digest(
      binding.secretVersionsHash,
      `environmentSnapshots.${environment}.secretVersionsHash`,
    );
    digest(binding.runtimeHash, `environmentSnapshots.${environment}.runtimeHash`);
    digest(
      binding.providerCredentialVersionHash,
      `environmentSnapshots.${environment}.providerCredentialVersionHash`,
    );
    digest(
      binding.appleCredentialVersionHash,
      `environmentSnapshots.${environment}.appleCredentialVersionHash`,
    );
    digest(
      binding.appleQaVerifierCredentialVersionHash,
      `environmentSnapshots.${environment}.appleQaVerifierCredentialVersionHash`,
    );
    const publicRollout = asRecord(
      binding.publicRollout,
      `environmentSnapshots.${environment}.publicRollout`,
    );
    exactKeys(publicRollout, [
      "active",
      "databaseAuthorized",
      "evidenceHash",
      "stage",
      "targetConfigurationHash",
    ], `environmentSnapshots.${environment}.publicRollout`);
    if (
      typeof publicRollout.active !== "boolean"
      || publicRollout.databaseAuthorized !== true
    ) {
      throw new Error(
        `environmentSnapshots.${environment}.publicRollout lacks database authority`,
      );
    }
    if (publicRollout.active) {
      digest(
        publicRollout.evidenceHash,
        `environmentSnapshots.${environment}.publicRollout.evidenceHash`,
      );
      if (
        typeof publicRollout.stage !== "string"
        || !/^(?:genre_scene|mood_activity_theme|similarity|artist_catalogue|fixed_container|factual_relationship|exhaustive):(?:0|1|10|50|100)->(?:0|1|10|50|100)$/u
          .test(publicRollout.stage)
      ) {
        throw new Error(
          `environmentSnapshots.${environment}.publicRollout.stage is invalid`,
        );
      }
      digest(
        publicRollout.targetConfigurationHash,
        `environmentSnapshots.${environment}.publicRollout.targetConfigurationHash`,
      );
    } else if (
      publicRollout.evidenceHash !== null
      || publicRollout.stage !== null
      || publicRollout.targetConfigurationHash !== null
    ) {
      throw new Error(
        `environmentSnapshots.${environment}.publicRollout has stale inactive markers`,
      );
    }
    return binding as unknown as ReleaseEvidenceEnvironmentSnapshotV1;
  };
  const stagingSnapshot = snapshotBinding(environmentSnapshots.staging, "staging");
  const productionSnapshot = environmentSnapshots.production === null
    ? null
    : snapshotBinding(environmentSnapshots.production, "production");
  if (root.kind === "candidate" && productionSnapshot !== null) {
    throw new Error("candidate release evidence must not include a production runtime snapshot");
  }
  if (root.kind !== "candidate" && productionSnapshot === null) {
    throw new Error(
      `${root.kind} release evidence requires a production runtime snapshot`,
    );
  }
  if (stagingSnapshot.scope !== "full" || !stagingSnapshot.sitesCandidateMatched) {
    throw new Error("staging release evidence requires a full candidate-matched snapshot");
  }
  if (
    root.kind === "promotion"
    && (
      productionSnapshot?.scope !== "backend"
      || productionSnapshot.sitesCandidateMatched
    )
  ) {
    throw new Error(
      "promotion release evidence requires a backend-scoped pre-Sites production snapshot",
    );
  }
  if (
    root.kind === "promotion"
    && candidateEvidenceGeneratedAt
    && Date.parse(productionSnapshot!.generatedAt)
      <= Date.parse(candidateEvidenceGeneratedAt)
  ) {
    throw new Error(
      "promotion production snapshot must postdate candidate evidence",
    );
  }
  if (
    root.kind === "finalization"
    && publicRolloutCompletedAt
    && Date.parse(productionSnapshot!.generatedAt)
      <= Date.parse(publicRolloutCompletedAt)
  ) {
    throw new Error(
      "finalization production snapshot must postdate public rollout",
    );
  }
  if (
    root.kind === "finalization"
    && (
      productionSnapshot?.scope !== "full"
      || !productionSnapshot.sitesCandidateMatched
    )
  ) {
    throw new Error(
      "finalization release evidence requires a full candidate-matched production snapshot",
    );
  }
  if (stagingSnapshot.publicRollout.active) {
    throw new Error(
      "staging release evidence cannot carry a production public rollout",
    );
  }
  if (root.kind === "finalization") {
    const appliedRollout = productionSnapshot!.publicRollout;
    const expectedRolloutStage =
      `${publicRolloutIntentGroup}:${publicRolloutFromPercent}->${publicRolloutToPercent}`;
    if (
      !appliedRollout.active
      || appliedRollout.evidenceHash !== publicRolloutEvidencePayloadHash
      || appliedRollout.stage !== expectedRolloutStage
      || appliedRollout.targetConfigurationHash
        !== publicRolloutTargetConfigurationHash
    ) {
      throw new Error(
        "finalization environment snapshot does not bind its signed public rollout lineage",
      );
    }
  }
  const activeSnapshot = root.kind === "candidate" ? stagingSnapshot : productionSnapshot!;
  if (activeSnapshot.configurationHash !== releaseEvidenceConfigurationHash({ configuration })
    || activeSnapshot.runtimeHash !== releaseEvidenceRuntimeHash({ runtime })) {
    throw new Error("active runtime snapshot does not bind the signed configuration and runtime");
  }
  if (
    stagingControls.providerSecretVersionHash
      !== stagingSnapshot.providerCredentialVersionHash
    || stagingControls.appleSecretVersionHash
      !== stagingSnapshot.appleCredentialVersionHash
    || stagingControls.appleQaVerifierSecretVersionHash
      !== stagingSnapshot.appleQaVerifierCredentialVersionHash
    || (productionSnapshot && (
      stagingControls.productionProviderSecretVersionHash
        !== productionSnapshot.providerCredentialVersionHash
      || stagingControls.productionAppleSecretVersionHash
        !== productionSnapshot.appleCredentialVersionHash
      || stagingControls.productionAppleQaVerifierSecretVersionHash
        !== productionSnapshot.appleQaVerifierCredentialVersionHash
    ))
  ) {
    throw new Error("staging controls do not match the runtime credential-version bindings");
  }
  if (
    stagingControls.stagingRuntimeSnapshotHash !== stagingSnapshot.snapshotHash
    || stagingControls.stagingConfigurationHash
      !== stagingSnapshot.configurationHash
    || stagingControls.stagingSecretVersionsHash
      !== stagingSnapshot.secretVersionsHash
  ) {
    throw new Error(
      "staging controls do not bind the exact staging runtime snapshot",
    );
  }
  if (
    productionSnapshot
      ? (
        stagingControls.productionRuntimeSnapshotHash
          !== productionSnapshot.snapshotHash
        || stagingControls.productionConfigurationHash
          !== productionSnapshot.configurationHash
        || stagingControls.productionSecretVersionsHash
          !== productionSnapshot.secretVersionsHash
      )
      : (
        stagingControls.productionRuntimeSnapshotHash !== null
        || stagingControls.productionConfigurationHash !== null
      )
  ) {
    throw new Error(
      "staging controls do not bind the exact production runtime snapshot",
    );
  }

  if (!Array.isArray(root.gates)) throw new Error("gates must be an array");
  const gateNames = new Set<ReleaseEvidenceGateName>();
  for (const [index, item] of root.gates.entries()) {
    const gate = asRecord(item, `gates[${index}]`);
    exactKeys(gate, [
      "name",
      "environment",
      "passed",
      "completedAt",
      "evidenceHash",
      "artifactSchemaVersion",
      "configurationHash",
      "runtimeHash",
      "fixtures",
      "cacheMode",
      "budgetStatus",
    ], `gates[${index}]`);
    if (typeof gate.name !== "string" || !(gate.name in RELEASE_EVIDENCE_GATE_ENVIRONMENT)) {
      throw new Error(`gates[${index}].name is not an approved release gate`);
    }
    const gateName = gate.name as ReleaseEvidenceGateName;
    if (gateNames.has(gateName)) throw new Error(`release gate ${gateName} is duplicated`);
    gateNames.add(gateName);
    if (gate.environment !== RELEASE_EVIDENCE_GATE_ENVIRONMENT[gateName]) {
      throw new Error(`release gate ${gateName} has the wrong environment`);
    }
    if (gate.passed !== true) throw new Error(`release gate ${gateName} did not pass`);
    const completedAt = timestamp(gate.completedAt, `gates[${index}].completedAt`);
    const completedMs = Date.parse(completedAt);
    const generatedMs = Date.parse(generatedAt);
    if (completedMs > generatedMs + 5 * 60 * 1_000
      || generatedMs - completedMs > RELEASE_EVIDENCE_TTL_MS) {
      throw new Error(`release gate ${gateName} is outside the 24-hour evidence window`);
    }
    const minimumPhaseTime = root.kind === "promotion"
      ? candidateEvidenceGeneratedAt
      : root.kind === "finalization"
        ? publicRolloutCompletedAt
        : null;
    if (
      minimumPhaseTime
      && completedMs <= Date.parse(minimumPhaseTime)
    ) {
      throw new Error(
        `release gate ${gateName} predates its required phase lineage`,
      );
    }
    digest(gate.evidenceHash, `gates[${index}].evidenceHash`);
    if (gate.artifactSchemaVersion !== RELEASE_GATE_ARTIFACT_SCHEMA_V1) {
      throw new Error(`release gate ${gateName} has an unsupported artifact schema`);
    }
    const gateConfigurationHash = digest(
      gate.configurationHash,
      `gates[${index}].configurationHash`,
    );
    const gateRuntimeHash = digest(gate.runtimeHash, `gates[${index}].runtimeHash`);
    const expectedSnapshot = gate.environment === "production"
      ? productionSnapshot
      : gate.environment === "staging"
        ? stagingSnapshot
        : null;
    if (gate.environment !== "offline" && (
      !expectedSnapshot
      || gateConfigurationHash !== expectedSnapshot.configurationHash
      || gateRuntimeHash !== expectedSnapshot.runtimeHash
    )) {
      throw new Error(`release gate ${gateName} is not bound to its environment runtime snapshot`);
    }
    validateReleaseFixtureBindingsForGate(gateName, gate.fixtures);
    const expectedCacheMode = gate.environment === "offline"
      ? "not_applicable"
      : "reuse_disabled";
    if (gate.cacheMode !== expectedCacheMode) {
      throw new Error(`release gate ${gateName} does not prove result reuse was disabled`);
    }
    const expectedBudgetStatus = gate.environment === "staging"
      ? "within_cap"
      : "not_applicable";
    if (gate.budgetStatus !== expectedBudgetStatus) {
      throw new Error(`release gate ${gateName} does not prove the required QA budget state`);
    }
  }
  const expectedGates = requiredGates(root.kind);
  const missing = expectedGates.filter((gate) => !gateNames.has(gate));
  const extras = [...gateNames].filter((gate) => !expectedGates.includes(gate));
  if (missing.length > 0 || extras.length > 0) {
    throw new Error(`release evidence gates do not match ${root.kind}: missing=${missing.join(",") || "none"} extras=${extras.join(",") || "none"}`);
  }
  if (root.kind === "candidate") {
    const semanticGate = (root.gates as ReleaseEvidenceGateV1[]).find(
      ({ name }) => name === "semantic_ranking_blinded_review",
    );
    if (
      !semanticGate
      || semanticGate.evidenceHash !== semanticReviewGateEvidenceHash
      || Date.parse(semanticReviewReviewedAt)
        > Date.parse(semanticGate.completedAt)
    ) {
      throw new Error(
        "candidate semantic review summary does not bind its verified release gate",
      );
    }
  }
  return value as ReleaseEvidencePayloadV1;
}

async function readJsonArtifact(path: string, label: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new Error(`${label} could not be read`);
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function artifactFilePath(baseDirectory: string, value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${label} must name a JSON artifact file`);
  }
  return resolve(baseDirectory, value);
}

function sameCandidate(
  left: ReleaseEvidencePayloadV1["candidate"],
  right: ReleaseGateArtifactV1["candidate"],
): boolean {
  return stableReleaseEvidenceJson(left) === stableReleaseEvidenceJson(right);
}

/**
 * Load a signing bundle and derive every signed gate from exact-parsed source
 * artifacts. The CLI intentionally has no path that accepts a hand-authored
 * `gates: [{ evidenceHash: ... }]` payload.
 */
export async function loadReleaseEvidenceSigningBundle(
  value: unknown,
  baseDirectory: string,
  producerVerificationKey: string | Buffer | KeyObject,
  producerTrustValue: unknown,
  approvedSemanticReviewerValue: unknown,
  approvedHistoricalReplayValue: unknown,
  stagingControlPlaneTrustValue: unknown,
  approvedSitesControlPlaneValue: unknown,
  githubOfflineVerifier: GithubOfflineEvidenceVerifier,
  releaseVerificationKey?: string | Buffer | KeyObject,
): Promise<ReleaseEvidencePayloadV1> {
  const producerTrust = validateReleaseGateProducerTrustPolicyV1(
    producerTrustValue,
  );
  if (
    releaseGateProducerKeyFingerprint(producerVerificationKey)
      !== producerTrust.approvedKeySha256
  ) {
    throw new Error(
      "release gate producer does not use the protected approved key",
    );
  }
  const approvedSemanticReviewer =
    validateSemanticRankingReviewerTrustPolicyV1(
      approvedSemanticReviewerValue,
    );
  const approvedHistoricalReplay =
    validateReleaseGateProducerTrustPolicyV1(
      approvedHistoricalReplayValue,
    );
  const stagingControlPlaneTrust =
    validateStagingControlPlaneTrustPolicyV1(stagingControlPlaneTrustValue);
  const root = asRecord(value, "release evidence signing bundle");
  exactKeys(root, [
    "schemaVersion",
    "kind",
    "generatedAt",
    "expiresAt",
    "candidate",
    "stagingControlPlaneEvidenceFile",
    "stagingControlPlaneVerificationKeyFile",
    "offlineGithubAttestationFiles",
    "runtimeSnapshotFiles",
    "priorReleaseEvidenceFile",
    "publicRolloutEvidenceFile",
    "gateArtifactFiles",
    "gateAttestationFiles",
  ], "release evidence signing bundle");
  if (root.schemaVersion !== "genio-release-evidence-signing-bundle/v3") {
    throw new Error("release evidence signing bundle uses an unsupported schema");
  }
  if (
    root.kind !== "candidate"
    && root.kind !== "promotion"
    && root.kind !== "finalization"
  ) {
    throw new Error(
      "release evidence signing bundle kind must be candidate, promotion, or finalization",
    );
  }
  const kind = root.kind;
  const approvedSitesControlPlane = kind === "finalization"
    ? validateSitesControlPlaneTrustPolicyV1(
      approvedSitesControlPlaneValue,
    )
    : null;
  const generatedAt = timestamp(root.generatedAt, "release evidence signing bundle generatedAt");
  timestamp(root.expiresAt, "release evidence signing bundle expiresAt");
  if (
    (kind === "candidate" && root.priorReleaseEvidenceFile !== null)
    || (kind !== "candidate" && root.priorReleaseEvidenceFile === null)
    || (kind !== "finalization" && root.publicRolloutEvidenceFile !== null)
    || (kind === "finalization" && root.publicRolloutEvidenceFile === null)
  ) {
    throw new Error(
      "release evidence signing bundle does not name the required phase lineage files",
    );
  }
  if (kind !== "candidate" && !releaseVerificationKey) {
    throw new Error(
      "successor release evidence requires the protected release verification key",
    );
  }
  const priorReleaseEvidencePath = root.priorReleaseEvidenceFile === null
    ? null
    : artifactFilePath(
        baseDirectory,
        root.priorReleaseEvidenceFile,
        "priorReleaseEvidenceFile",
      );
  const publicRolloutEvidencePath = root.publicRolloutEvidenceFile === null
    ? null
    : artifactFilePath(
        baseDirectory,
        root.publicRolloutEvidenceFile,
        "publicRolloutEvidenceFile",
      );
  const stagingControlPlaneEvidencePath = artifactFilePath(
    baseDirectory,
    root.stagingControlPlaneEvidenceFile,
    "stagingControlPlaneEvidenceFile",
  );
  const stagingControlPlaneVerificationKeyPath = artifactFilePath(
    baseDirectory,
    root.stagingControlPlaneVerificationKeyFile,
    "stagingControlPlaneVerificationKeyFile",
  );
  const [stagingControlPlaneEvidenceValue, stagingControlPlaneVerificationKey] =
    await Promise.all([
      readJsonArtifact(
        stagingControlPlaneEvidencePath,
        "signed staging control-plane evidence",
      ),
      readFile(stagingControlPlaneVerificationKeyPath),
    ]);
  const stagingControlPlane = verifyStagingControlPlaneEvidence({
    value: stagingControlPlaneEvidenceValue,
    verificationKey: stagingControlPlaneVerificationKey,
    trustPolicy: stagingControlPlaneTrust,
    now: generatedAt,
  });
  const offlineGithubAttestationFiles = asRecord(
    root.offlineGithubAttestationFiles,
    "release evidence signing bundle offlineGithubAttestationFiles",
  );
  exactKeys(offlineGithubAttestationFiles, [
    "bundle",
    "binding",
  ], "release evidence signing bundle offlineGithubAttestationFiles");
  const offlineGithubBundlePath = artifactFilePath(
    baseDirectory,
    offlineGithubAttestationFiles.bundle,
    "offlineGithubAttestationFiles.bundle",
  );
  const offlineGithubBindingPath = artifactFilePath(
    baseDirectory,
    offlineGithubAttestationFiles.binding,
    "offlineGithubAttestationFiles.binding",
  );
  const offlineGithubBindingValue = await readJsonArtifact(
    offlineGithubBindingPath,
    "GitHub offline attestation binding",
  );

  const runtimeSnapshotFiles = asRecord(
    root.runtimeSnapshotFiles,
    "release evidence signing bundle runtimeSnapshotFiles",
  );
  exactKeys(
    runtimeSnapshotFiles,
    ["staging", "production"],
    "release evidence signing bundle runtimeSnapshotFiles",
  );
  const stagingSnapshotPath = artifactFilePath(
    baseDirectory,
    runtimeSnapshotFiles.staging,
    "runtimeSnapshotFiles.staging",
  );
  if (kind === "candidate" && runtimeSnapshotFiles.production !== null) {
    throw new Error("candidate signing bundle must not name a production runtime snapshot");
  }
  if (kind !== "candidate" && runtimeSnapshotFiles.production === null) {
    throw new Error(
      `${kind} signing bundle requires a production runtime snapshot`,
    );
  }
  const productionSnapshotPath = runtimeSnapshotFiles.production === null
    ? null
    : artifactFilePath(
      baseDirectory,
      runtimeSnapshotFiles.production,
      "runtimeSnapshotFiles.production",
    );
  const [stagingSnapshotValue, productionSnapshotValue] = await Promise.all([
    readJsonArtifact(stagingSnapshotPath, "staging runtime snapshot"),
    productionSnapshotPath
      ? readJsonArtifact(productionSnapshotPath, "production runtime snapshot")
      : Promise.resolve(null),
  ]);
  const stagingSnapshot = validateRuntimeSnapshot(
    stagingSnapshotValue,
    "staging",
    "full",
  );
  const productionSnapshot = productionSnapshotValue === null
    ? null
    : validateRuntimeSnapshot(
      productionSnapshotValue,
      "production",
      kind === "finalization" ? "full" : "backend",
    );

  const candidate = asRecord(root.candidate, "release evidence signing bundle candidate");
  const candidateVersion = candidate.version;
  const candidateRevision = candidate.sourceRevision;
  const controlPlaneCandidate = asRecord(
    stagingControlPlane.payload.candidate,
    "staging control-plane evidence candidate",
  );
  const expectedControlPlanePhase = kind;
  if (
    stagingControlPlane.payload.phase !== expectedControlPlanePhase
    || controlPlaneCandidate.version !== candidateVersion
    || controlPlaneCandidate.sourceRevision !== candidateRevision
  ) {
    throw new Error(
      "staging control-plane evidence does not bind the signing bundle phase and candidate",
    );
  }
  if (stagingSnapshot.candidate.version !== candidateVersion
    || stagingSnapshot.candidate.sourceRevision !== candidateRevision
    || (productionSnapshot
      && (productionSnapshot.candidate.version !== candidateVersion
        || productionSnapshot.candidate.sourceRevision !== candidateRevision))) {
    throw new Error("runtime snapshots do not bind the signing bundle candidate");
  }
  const priorReleaseEvidenceValue = priorReleaseEvidencePath
    ? await readJsonArtifact(
        priorReleaseEvidencePath,
        "prior signed release evidence",
      )
    : null;
  const priorReleasePayload = priorReleaseEvidenceValue === null
    ? null
    : verifyReleaseEvidence(
        priorReleaseEvidenceValue as SignedReleaseEvidenceV1,
        releaseVerificationKey!,
        {
          expectedKind: kind === "promotion" ? "candidate" : "promotion",
          expectedTag: String(candidate.tag),
          expectedRevision: String(candidate.sourceRevision),
          expectedImageDigest: String(candidate.imageDigest),
          now: generatedAt,
        },
      );
  if (
    priorReleasePayload
    && priorReleasePayload.candidate.version !== candidateVersion
  ) {
    throw new Error("prior release evidence does not bind the candidate version");
  }
  const priorReleaseEnvelope = priorReleaseEvidenceValue === null
    ? null
    : asRecord(priorReleaseEvidenceValue, "prior signed release evidence");
  const priorReleasePayloadHash = priorReleaseEnvelope === null
    ? null
    : digest(
        priorReleaseEnvelope.payloadHash,
        "prior signed release evidence payload hash",
      );
  const publicRolloutEvidenceValue = publicRolloutEvidencePath
    ? await readJsonArtifact(
        publicRolloutEvidencePath,
        "signed public rollout finalization lineage",
      )
    : null;
  const publicRollout = kind === "finalization"
    ? verifyPublicRolloutFinalizationLineage(
        publicRolloutEvidenceValue,
        releaseVerificationKey!,
        {
          expectedTag: String(candidate.tag),
          expectedVersion: String(candidate.version),
          expectedRevision: String(candidate.sourceRevision),
          expectedImageDigest: String(candidate.imageDigest),
          expectedPromotionEvidenceHash: priorReleasePayloadHash!,
          expectedPromotionConfigurationHash:
            releaseEvidenceConfigurationHash(priorReleasePayload!),
          expectedPromotionRuntimeHash:
            releaseEvidenceRuntimeHash(priorReleasePayload!),
          expectedSemanticBehaviorHash:
            priorReleasePayload!.semanticReview.semanticBehaviorHash,
          expectedProductionCanaryEvidenceHash:
            publicRolloutProductionCanaryEvidenceHash(
              priorReleasePayload!.gates,
            ),
          expectedSitesVersion:
            priorReleasePayload!.environmentSnapshots.production!
              .sitesVersion,
          expectedSitesRevision:
            priorReleasePayload!.environmentSnapshots.production!
              .sitesSourceRevision,
          minimumSoakStartedAt: priorReleasePayload!.generatedAt,
          now: generatedAt,
        },
      )
    : null;
  const maximumFutureMs = Date.parse(generatedAt) + 5 * 60 * 1_000;
  const minimumFreshMs = Date.parse(generatedAt) - RELEASE_EVIDENCE_TTL_MS;
  for (const snapshot of [stagingSnapshot, productionSnapshot].filter(
    (item): item is LoadedRuntimeSnapshotV1 => item !== null,
  )) {
    const snapshotTime = Date.parse(snapshot.generatedAt);
    if (snapshotTime > maximumFutureMs || snapshotTime < minimumFreshMs) {
      throw new Error(`${snapshot.environment} runtime snapshot is outside the evidence window`);
    }
  }
  if (
    kind === "promotion"
    && Date.parse(productionSnapshot!.generatedAt)
      <= Date.parse(priorReleasePayload!.generatedAt)
  ) {
    throw new Error(
      "promotion runtime snapshot predates candidate release evidence",
    );
  }
  if (
    kind === "finalization"
    && Date.parse(productionSnapshot!.generatedAt)
      <= Date.parse(publicRollout!.soak.completedAt)
  ) {
    throw new Error(
      "finalization runtime snapshot predates the signed public rollout",
    );
  }
  if (kind === "finalization") {
    assertFinalizationRuntimePublicRolloutBindingV1({
      runtimePublicRollout: productionSnapshot!.publicRollout,
      signedRollout: publicRollout!,
    });
  }

  const artifactFiles = asRecord(
    root.gateArtifactFiles,
    "release evidence signing bundle gateArtifactFiles",
  );
  const expectedGates = requiredGates(kind);
  exactKeys(artifactFiles, expectedGates, "release evidence signing bundle gateArtifactFiles");
  const attestationFiles = asRecord(
    root.gateAttestationFiles,
    "release evidence signing bundle gateAttestationFiles",
  );
  exactKeys(
    attestationFiles,
    expectedGates,
    "release evidence signing bundle gateAttestationFiles",
  );
  const artifacts = await Promise.all(expectedGates.map(async (gateName) => {
    const path = artifactFilePath(
      baseDirectory,
      artifactFiles[gateName],
      `gateArtifactFiles.${gateName}`,
    );
    const artifact = validateReleaseGateArtifact(
      await readJsonArtifact(path, `release gate artifact ${gateName}`),
    );
    if (gateName === "offline_suite") {
      const github = await githubOfflineVerifier({
        artifactPath: path,
        bundlePath: offlineGithubBundlePath,
        bindingValue: offlineGithubBindingValue,
      });
      if (github.artifact.evidenceHash !== artifact.evidenceHash
        || !sameCandidate(
          artifact.candidate,
          github.artifact.candidate,
        )) {
        throw new Error(
          "GitHub keyless attestation did not bind the exact offline gate artifact",
        );
      }
    }
    const attestationPath = artifactFilePath(
      baseDirectory,
      attestationFiles[gateName],
      `gateAttestationFiles.${gateName}`,
    );
    const producerAttestation = verifyReleaseGateProducerAttestation(
      await readJsonArtifact(
        attestationPath,
        `release gate producer attestation ${gateName}`,
      ),
      artifact,
      producerVerificationKey,
    );
    if (
      producerAttestation.signature.keyId !== producerTrust.approvedKeyId
    ) {
      throw new Error(
        "release gate producer attestation key ID is not protected and approved",
      );
    }
    if (gateName === "semantic_ranking_blinded_review") {
      const reviewerKey = validateSemanticRankingReviewerVerificationKeyV1(
        artifact.sources.reviewerVerificationKey,
      );
      const artifactTrustPolicy =
        validateSemanticRankingReviewerTrustPolicyV1(
          artifact.sources.reviewerTrustPolicy,
        );
      if (
        artifactTrustPolicy.approvedKeyId
          !== approvedSemanticReviewer.approvedKeyId
        || artifactTrustPolicy.approvedKeySha256
          !== approvedSemanticReviewer.approvedKeySha256
        || artifactTrustPolicy.approvedBaselineMetadataSha256
          !== approvedSemanticReviewer.approvedBaselineMetadataSha256
        || artifactTrustPolicy.approvedBaselineStableTag
          !== approvedSemanticReviewer.approvedBaselineStableTag
        || artifactTrustPolicy.approvedBaselineReleaseKeySha256
          !== approvedSemanticReviewer.approvedBaselineReleaseKeySha256
        || artifactTrustPolicy.approvedBaselineStableAuthorizerKeyId
          !== approvedSemanticReviewer.approvedBaselineStableAuthorizerKeyId
        || artifactTrustPolicy.approvedBaselineStableAuthorizerKeySha256
          !== approvedSemanticReviewer
            .approvedBaselineStableAuthorizerKeySha256
        || reviewerKey.source.sha256
          !== approvedSemanticReviewer.approvedKeySha256
      ) {
        throw new Error(
          "semantic reviewer or baseline does not match the protected semantic review policy",
        );
      }
      if (
        reviewerKey.source.sha256
          === semanticRankingReviewerKeyFingerprint(producerVerificationKey)
      ) {
        throw new Error(
          "semantic reviewer key must be separate from the release gate producer key",
        );
      }
    }
    if (gateName === "staging_historical_replay") {
      const replayKey = asRecord(
        artifact.sources.historicalReplayVerificationKey,
        "historical replay verification key",
      );
      const replayTrust = validateReleaseGateProducerTrustPolicyV1(
        artifact.sources.historicalReplayTrust,
      );
      if (
        replayTrust.approvedKeyId
          !== approvedHistoricalReplay.approvedKeyId
        || replayTrust.approvedKeySha256
          !== approvedHistoricalReplay.approvedKeySha256
        || replayKey.keyId !== approvedHistoricalReplay.approvedKeyId
        || replayKey.publicKeySha256
          !== approvedHistoricalReplay.approvedKeySha256
      ) {
        throw new Error(
          "historical replay producer does not match the protected approved key",
        );
      }
      if (
        replayKey.publicKeySha256
          === releaseGateProducerKeyFingerprint(producerVerificationKey)
      ) {
        throw new Error(
          "historical replay evidence key must be separate from the release gate producer key",
        );
      }
    }
    if (gateName === "final_custom_domain_browser") {
      if (!approvedSitesControlPlane) {
        throw new Error(
          "finalization signing requires the protected Sites control-plane key",
        );
      }
      const embeddedPolicy = validateSitesControlPlaneTrustPolicyV1(
        artifact.sources.sitesControlPlaneTrustPolicy,
      );
      const embeddedKey = validateSitesControlPlaneVerificationKeyV1(
        artifact.sources.sitesControlPlaneVerificationKey,
      );
      if (
        embeddedPolicy.approvedKeyId
          !== approvedSitesControlPlane.approvedKeyId
        || embeddedPolicy.approvedKeySha256
          !== approvedSitesControlPlane.approvedKeySha256
        || embeddedKey.source.sha256
          !== approvedSitesControlPlane.approvedKeySha256
      ) {
        throw new Error(
          "Sites control-plane evidence does not use the protected approved key",
        );
      }
      const receipt = asRecord(
        artifact.sources.sitesControlPlane,
        "Sites control-plane deployment receipt",
      );
      verifySitesControlPlaneAttestation({
        value: artifact.sources.sitesControlPlaneAttestation,
        verificationKey: embeddedKey.key,
        expectedReceiptHash: String(receipt.evidenceHash),
        expectedKeyId: approvedSitesControlPlane.approvedKeyId,
        expectedKeyFingerprint:
          approvedSitesControlPlane.approvedKeySha256,
        now: artifact.completedAt,
      });
    }
    return artifact;
  }));

  const candidateValue = candidate as unknown as ReleaseEvidencePayloadV1["candidate"];
  const environmentSnapshots: ReleaseEvidencePayloadV1["environmentSnapshots"] = {
    staging: {
      scope: stagingSnapshot.scope,
      generatedAt: stagingSnapshot.generatedAt,
      snapshotHash: stagingSnapshot.snapshotHash,
      sitesObservationHash: sha256(stagingSnapshot.sitesObservation),
      sitesVersion: stagingSnapshot.sitesObservation.version,
      sitesSourceRevision: stagingSnapshot.sitesObservation.sourceRevision,
      sitesCandidateMatched: stagingSnapshot.sitesObservation.candidateMatched,
      configurationHash: stagingSnapshot.configurationHash,
      secretVersionsHash: stagingSnapshot.configuration.secretVersionsHash,
      runtimeHash: stagingSnapshot.runtimeHash,
      providerCredentialVersionHash: stagingSnapshot.credentialVersionHashes.provider,
      appleCredentialVersionHash: stagingSnapshot.credentialVersionHashes.apple,
      appleQaVerifierCredentialVersionHash:
        stagingSnapshot.credentialVersionHashes.appleQaVerifier,
      publicRollout: stagingSnapshot.publicRollout,
    },
    production: productionSnapshot
      ? {
        scope: productionSnapshot.scope,
        generatedAt: productionSnapshot.generatedAt,
        snapshotHash: productionSnapshot.snapshotHash,
        sitesObservationHash: sha256(productionSnapshot.sitesObservation),
        sitesVersion: productionSnapshot.sitesObservation.version,
        sitesSourceRevision:
          productionSnapshot.sitesObservation.sourceRevision,
        sitesCandidateMatched:
          productionSnapshot.sitesObservation.candidateMatched,
        configurationHash: productionSnapshot.configurationHash,
        secretVersionsHash:
          productionSnapshot.configuration.secretVersionsHash,
        runtimeHash: productionSnapshot.runtimeHash,
        providerCredentialVersionHash: productionSnapshot.credentialVersionHashes.provider,
        appleCredentialVersionHash: productionSnapshot.credentialVersionHashes.apple,
        appleQaVerifierCredentialVersionHash:
          productionSnapshot.credentialVersionHashes.appleQaVerifier,
        publicRollout: productionSnapshot.publicRollout,
      }
      : null,
  };
  const gates: ReleaseEvidenceGateV1[] = artifacts.map((artifact, index) => {
    const expectedGate = expectedGates[index]!;
    if (artifact.gate !== expectedGate) {
      throw new Error(`release gate artifact ${expectedGate} is mislabeled as ${artifact.gate}`);
    }
    if (!sameCandidate(candidateValue, artifact.candidate)) {
      throw new Error(`release gate artifact ${expectedGate} does not bind the candidate`);
    }
    const expectedSnapshot = artifact.environment === "production"
      ? productionSnapshot
      : artifact.environment === "staging"
        ? stagingSnapshot
        : null;
    if (artifact.environment !== "offline" && (
      !expectedSnapshot
      || artifact.configurationHash !== expectedSnapshot.configurationHash
      || artifact.runtimeHash !== expectedSnapshot.runtimeHash
    )) {
      throw new Error(`release gate artifact ${expectedGate} does not bind its runtime snapshot`);
    }
    if (
      expectedGate === "backend_release_convergence"
      || expectedGate === "release_convergence"
    ) {
      const convergence = asRecord(
        artifact.sources.convergence,
        `${expectedGate} convergence source`,
      );
      const expected = asRecord(
        convergence.expected,
        `${expectedGate} convergence expected identity`,
      );
      const sites = asRecord(
        expected.sites,
        `${expectedGate} convergence expected Sites identity`,
      );
      const requiredScope = expectedGate === "backend_release_convergence"
        ? "backend"
        : "full";
      if (
        convergence.scope !== requiredScope
        || sites.version !== expectedSnapshot!.sitesObservation.version
        || sites.revision
          !== expectedSnapshot!.sitesObservation.sourceRevision
        || sites.candidateMatched
          !== expectedSnapshot!.sitesObservation.candidateMatched
      ) {
        throw new Error(
          `${expectedGate} does not bind the exact runtime snapshot Sites identity`,
        );
      }
      if (kind === "finalization" && expectedGate === "release_convergence") {
        const expectedRolloutStage =
          `${publicRollout!.intentGroup}:${publicRollout!.fromPercent}->${publicRollout!.toPercent}`;
        const observations = Array.isArray(convergence.observations)
          ? convergence.observations
          : [];
        if (observations.length < 2) {
          throw new Error(
            "release_convergence has no independently repeated rollout observations",
          );
        }
        for (const [observationIndex, observationValue] of observations.entries()) {
          const observation = asRecord(
            observationValue,
            `release_convergence observation ${observationIndex}`,
          );
          const observedRuntime = asRecord(
            observation.runtime,
            `release_convergence observation ${observationIndex} runtime`,
          );
          const observedSystem = asRecord(
            observation.system,
            `release_convergence observation ${observationIndex} system`,
          );
          const observedRollout = asRecord(
            observedSystem.publicRollout,
            `release_convergence observation ${observationIndex} public rollout`,
          );
          if (
            observedRuntime.publicRolloutEvidenceHash
              !== publicRollout!.payloadHash
            || observedRuntime.publicRolloutStage !== expectedRolloutStage
            || observedRollout.active !== true
            || observedRollout.databaseAuthorized !== true
            || observedRollout.evidenceHash !== publicRollout!.payloadHash
            || observedRollout.stage !== expectedRolloutStage
            || observedRollout.targetConfigurationHash
              !== publicRollout!.targetConfigurationHash
          ) {
            throw new Error(
              "release_convergence did not observe the exact database-authorized signed public rollout",
            );
          }
        }
      }
    }
    if (expectedGate === "staging_provider_manifest") {
      const manifestCanary = asRecord(
        artifact.sources.manifestCanary,
        "staging provider manifest source",
      );
      if (manifestCanary.runtimeSnapshotHash !== stagingSnapshot.snapshotHash) {
        throw new Error(
          "staging provider manifest does not bind the signed staging runtime snapshot",
        );
      }
    }
    if (expectedGate === "staging_historical_replay") {
      const replayEnvelope = asRecord(
        artifact.sources.historicalReplay,
        "historical replay signed evidence",
      );
      const replayPayload = asRecord(
        replayEnvelope.payload,
        "historical replay evidence payload",
      );
      const replayStaging = asRecord(
        replayPayload.staging,
        "historical replay staging binding",
      );
      const replayBindingMatches = {
        runtimeSnapshot:
          replayStaging.runtimeSnapshotHash === stagingSnapshot.snapshotHash,
        configuration:
          replayStaging.configurationHash
            === stagingSnapshot.configurationHash,
        runtime: replayStaging.runtimeHash === stagingSnapshot.runtimeHash,
        controlPlane:
          kind !== "candidate"
          || replayStaging.controlPlaneEvidenceHash
              === stagingControlPlane.derivedControls.controlPlaneEvidenceHash,
        serviceInventory:
          kind !== "candidate"
          || replayStaging.serviceInventoryHash
              === stagingControlPlane.derivedControls
                .stagingRailwayServiceInventoryHash,
      };
      const mismatchedBindings = Object.entries(replayBindingMatches)
        .filter(([, matches]) => !matches)
        .map(([binding]) => binding);
      if (mismatchedBindings.length > 0) {
        throw new Error(
          "historical replay does not bind the signed staging runtime and control plane: "
          + mismatchedBindings.join(","),
        );
      }
    }
    if (artifact.environment !== "offline" && "independentApple" in artifact.sources) {
      const independent = asRecord(
        artifact.sources.independentApple,
        `release gate artifact ${expectedGate} independent Apple evidence`,
      );
      if (independent.verifierCredentialVersionHash
        !== expectedSnapshot!.credentialVersionHashes.appleQaVerifier) {
        throw new Error(
          `release gate artifact ${expectedGate} does not bind the QA verifier credential version`,
        );
      }
      const expectedVerifierIdentityHash = artifact.environment === "production"
        ? stagingControlPlane.derivedControls
          .productionAppleQaVerifierCredentialIdentityHash
        : stagingControlPlane.derivedControls
          .appleQaVerifierCredentialIdentityHash;
      if (
        independent.verifierCredentialIdentityHash
          !== expectedVerifierIdentityHash
      ) {
        throw new Error(
          `release gate artifact ${expectedGate} does not bind the QA verifier credential identity`,
        );
      }
    }
    if (artifact.environment !== "offline" && "hostedPublication" in artifact.sources) {
      const hosted = asRecord(
        artifact.sources.hostedPublication,
        `release gate artifact ${expectedGate} hosted publication evidence`,
      );
      const hashes = Array.isArray(hosted.configurationHashes)
        ? hosted.configurationHashes
        : [];
      const permitted = new Set([
        expectedSnapshot!.configuration.interactiveWorkerHash,
        expectedSnapshot!.configuration.deepWorkerHash,
      ]);
      if (
        hashes.length < 1
        || hashes.some((value) => (
          typeof value !== "string" || !permitted.has(value)
        ))
      ) {
        throw new Error(
          `release gate artifact ${expectedGate} was executed by an unbound worker configuration`,
        );
      }
    }
    const completedMs = Date.parse(artifact.completedAt);
    if (completedMs > maximumFutureMs || completedMs < minimumFreshMs) {
      throw new Error(`release gate artifact ${expectedGate} is outside the evidence window`);
    }
    const phaseFloor = kind === "promotion"
      ? priorReleasePayload!.generatedAt
      : kind === "finalization"
        ? publicRollout!.soak.completedAt
        : null;
    if (phaseFloor && completedMs <= Date.parse(phaseFloor)) {
      throw new Error(
        `release gate artifact ${expectedGate} predates its signed phase lineage`,
      );
    }
    if (
      phaseFloor
      && (
        expectedGate === "backend_release_convergence"
        || expectedGate === "release_convergence"
      )
      && Date.parse(String(
        asRecord(
          artifact.sources.convergence,
          `${expectedGate} convergence source`,
        ).generatedAt,
      )) <= Date.parse(phaseFloor)
    ) {
      throw new Error(
        `${expectedGate} source predates its signed phase lineage`,
      );
    }
    if (expectedGate === "final_custom_domain_browser") {
      const browser = asRecord(
        artifact.sources.browser,
        "final browser source",
      );
      const sitesReceipt = asRecord(
        artifact.sources.sitesControlPlane,
        "Sites deployment receipt",
      );
      const rollbackTarget = asRecord(
        sitesReceipt.rollbackTarget,
        "Sites production rollback target",
      );
      const previousSites = asRecord(
        rollbackTarget.previous,
        "previous Sites saved version",
      );
      const priorSites =
        priorReleasePayload!.environmentSnapshots.production!;
      const rolloutCompletedAt = publicRollout!.soak.completedAt;
      const publicAssignmentProbes = Array.isArray(
        browser.publicAssignmentProbes,
      )
        ? browser.publicAssignmentProbes
        : [];
      assertFinalizationBrowserPublicRolloutBindingV1({
        probes: publicAssignmentProbes,
        signedRollout: publicRollout!,
      });
      if (
        previousSites.liveBuildVersion !== priorSites.sitesVersion
        || previousSites.liveBuildRevision !== priorSites.sitesSourceRevision
        || previousSites.commitSha !== priorSites.sitesSourceRevision
        || Date.parse(String(sitesReceipt.deploymentRequestedAt))
          <= Date.parse(rolloutCompletedAt)
        || Date.parse(String(rollbackTarget.capturedAt))
          >= Date.parse(String(sitesReceipt.deploymentRequestedAt))
        || Date.parse(String(sitesReceipt.observedAt))
          < Date.parse(String(sitesReceipt.deploymentRequestedAt))
        || Date.parse(String(browser.observedAt))
          < Date.parse(String(sitesReceipt.observedAt))
        || Date.parse(productionSnapshot!.generatedAt)
          < Date.parse(String(sitesReceipt.observedAt))
      ) {
        throw new Error(
          "prior Sites rollback target, deployment, full snapshot, and browser proof are out of order",
        );
      }
    }
    return {
      name: artifact.gate,
      environment: artifact.environment,
      passed: true,
      completedAt: artifact.completedAt,
      evidenceHash: artifact.evidenceHash,
      artifactSchemaVersion: artifact.schemaVersion,
      configurationHash: artifact.configurationHash,
      runtimeHash: artifact.runtimeHash,
      fixtures: artifact.fixtures,
      cacheMode: artifact.cacheMode,
      budgetStatus: artifact.budgetStatus,
    };
  });
  const activeSnapshot = kind === "candidate" ? stagingSnapshot : productionSnapshot!;
  const semanticBehaviorHash = semanticBehaviorHashV1(activeSnapshot.runtime);
  if (
    priorReleasePayload
    && priorReleasePayload.semanticReview.semanticBehaviorHash
      !== semanticBehaviorHash
  ) {
    throw new Error(
      "semantic behavior changed after the reviewed candidate phase",
    );
  }
  const semanticReview: ReleaseEvidenceSemanticReviewV1 =
    kind === "candidate"
      ? (() => {
          const semanticGate = artifacts.find(
            ({ gate }) => gate === "semantic_ranking_blinded_review",
          );
          if (!semanticGate) {
            throw new Error(
              "candidate release evidence has no verified semantic review gate",
            );
          }
          const reviewArtifact = validateSemanticRankingReviewArtifactV1(
            semanticGate.sources.reviewArtifact,
          );
          return {
            schemaVersion: "genio-release-semantic-review/v1",
            gateEvidenceHash: semanticGate.evidenceHash,
            reviewedAt: reviewArtifact.reviewedAt,
            semanticBehaviorHash,
            fixtures:
              semanticRankingCandidateBaselineFixturesV1(reviewArtifact),
          };
        })()
      : priorReleasePayload!.semanticReview;
  const lineage: ReleaseEvidencePayloadV1["lineage"] = kind === "candidate"
    ? {
        candidateEvidencePayloadHash: null,
        candidateEvidenceGeneratedAt: null,
        promotionEvidencePayloadHash: null,
        promotionEvidenceGeneratedAt: null,
        publicRolloutEvidencePayloadHash: null,
        publicRolloutCompletedAt: null,
        publicRolloutIntentGroup: null,
        publicRolloutFromPercent: null,
        publicRolloutToPercent: null,
        publicRolloutTargetConfigurationHash: null,
      }
    : kind === "promotion"
      ? {
          candidateEvidencePayloadHash: priorReleasePayloadHash!,
          candidateEvidenceGeneratedAt: priorReleasePayload!.generatedAt,
          promotionEvidencePayloadHash: null,
          promotionEvidenceGeneratedAt: null,
          publicRolloutEvidencePayloadHash: null,
          publicRolloutCompletedAt: null,
          publicRolloutIntentGroup: null,
          publicRolloutFromPercent: null,
          publicRolloutToPercent: null,
          publicRolloutTargetConfigurationHash: null,
        }
      : {
          candidateEvidencePayloadHash:
            priorReleasePayload!.lineage.candidateEvidencePayloadHash,
          candidateEvidenceGeneratedAt:
            priorReleasePayload!.lineage.candidateEvidenceGeneratedAt,
          promotionEvidencePayloadHash: priorReleasePayloadHash!,
          promotionEvidenceGeneratedAt: priorReleasePayload!.generatedAt,
          publicRolloutEvidencePayloadHash: publicRollout!.payloadHash,
          publicRolloutCompletedAt: publicRollout!.soak.completedAt,
          publicRolloutIntentGroup: publicRollout!.intentGroup,
          publicRolloutFromPercent: publicRollout!.fromPercent,
          publicRolloutToPercent: publicRollout!.toPercent,
          publicRolloutTargetConfigurationHash:
            publicRollout!.targetConfigurationHash,
        };
  return validateReleaseEvidencePayload({
    schemaVersion: "genio-release-evidence/v3",
    kind,
    generatedAt: root.generatedAt,
    expiresAt: root.expiresAt,
    candidate: root.candidate,
    lineage,
    configuration: activeSnapshot.configuration,
    stagingControls: stagingControlPlane.derivedControls,
    runtime: activeSnapshot.runtime,
    semanticReview,
    environmentSnapshots,
    gates,
  });
}

function signingMaterial(payload: ReleaseEvidencePayloadV1, keyId: string): string {
  return stableReleaseEvidenceJson({
    algorithm: "Ed25519",
    keyId,
    payload,
  });
}

function privateKey(value: string | Buffer | KeyObject): KeyObject {
  return value instanceof KeyObject ? value : createPrivateKey(value);
}

function publicKey(value: string | Buffer | KeyObject): KeyObject {
  return value instanceof KeyObject ? value : createPublicKey(value);
}

function signValidatedReleaseEvidence(
  payloadValue: unknown,
  signingKey: string | Buffer | KeyObject,
  keyIdValue: string,
): SignedReleaseEvidenceV1 {
  const payload = validateReleaseEvidencePayload(payloadValue);
  const keyId = label(keyIdValue, "signature.keyId");
  const value = sign(
    null,
    Buffer.from(signingMaterial(payload, keyId)),
    privateKey(signingKey),
  ).toString("base64url");
  return {
    schemaVersion: "genio-signed-release-evidence/v3",
    payload,
    payloadHash: sha256(payload),
    signature: {
      algorithm: "Ed25519",
      keyId,
      value,
    },
  };
}

export async function signReleaseEvidenceBundle(
  bundleValue: unknown,
  baseDirectory: string,
  producerVerificationKey: string | Buffer | KeyObject,
  producerTrust: ReleaseGateProducerTrustPolicyV1,
  approvedSemanticReviewer: SemanticRankingReviewerTrustPolicyV1,
  approvedHistoricalReplay: ReleaseGateProducerTrustPolicyV1,
  stagingControlPlaneTrust: StagingControlPlaneTrustPolicyV1,
  approvedSitesControlPlane: unknown,
  githubOfflineVerifier: GithubOfflineEvidenceVerifier,
  signingKey: string | Buffer | KeyObject,
  keyIdValue: string,
): Promise<SignedReleaseEvidenceV1> {
  const payload = await loadReleaseEvidenceSigningBundle(
    bundleValue,
    baseDirectory,
    producerVerificationKey,
    producerTrust,
    approvedSemanticReviewer,
    approvedHistoricalReplay,
    stagingControlPlaneTrust,
    approvedSitesControlPlane,
    githubOfflineVerifier,
    createPublicKey(privateKey(signingKey)),
  );
  return signValidatedReleaseEvidence(payload, signingKey, keyIdValue);
}

export function verifyReleaseEvidence(
  value: unknown,
  verificationKey: string | Buffer | KeyObject,
  options: {
    expectedKind: ReleaseEvidenceKind;
    now?: string;
    expectedRevision?: string;
    expectedImageDigest?: string;
    expectedTag?: string;
    expectedConfigurationHash?: string;
    expectedRuntimeHash?: string;
  },
): ReleaseEvidencePayloadV1 {
  if (
    !options
    || (
      options.expectedKind !== "candidate"
      && options.expectedKind !== "promotion"
      && options.expectedKind !== "finalization"
    )
  ) {
    throw new Error(
      "release evidence verification requires an expected candidate, promotion, or finalization kind",
    );
  }
  const envelope = asRecord(value, "signed release evidence");
  exactKeys(envelope, ["schemaVersion", "payload", "payloadHash", "signature"], "signed release evidence");
  if (envelope.schemaVersion !== "genio-signed-release-evidence/v3") {
    throw new Error("signed release evidence uses an unsupported schema");
  }
  const payload = validateReleaseEvidencePayload(envelope.payload);
  if (payload.kind !== options.expectedKind) {
    throw new Error(
      `release evidence kind ${payload.kind} does not match expected ${options.expectedKind}`,
    );
  }
  if (typeof envelope.payloadHash !== "string" || envelope.payloadHash !== sha256(payload)) {
    throw new Error("release evidence payload hash does not match");
  }
  const signature = asRecord(envelope.signature, "signature");
  exactKeys(signature, ["algorithm", "keyId", "value"], "signature");
  if (signature.algorithm !== "Ed25519") throw new Error("release evidence signature algorithm is unsupported");
  const keyId = label(signature.keyId, "signature.keyId");
  if (typeof signature.value !== "string" || !SIGNATURE_VALUE.test(signature.value)) {
    throw new Error("release evidence signature is malformed");
  }
  const valid = verify(
    null,
    Buffer.from(signingMaterial(payload, keyId)),
    publicKey(verificationKey),
    Buffer.from(signature.value, "base64url"),
  );
  if (!valid) throw new Error("release evidence signature is invalid");
  const now = Date.parse(options.now ? timestamp(options.now, "verification time") : new Date().toISOString());
  if (now < Date.parse(payload.generatedAt) - 5 * 60 * 1_000) {
    throw new Error("release evidence was generated in the future");
  }
  if (now >= Date.parse(payload.expiresAt)) throw new Error("release evidence has expired");
  if (options.expectedRevision && payload.candidate.sourceRevision !== options.expectedRevision) {
    throw new Error("release evidence source revision does not match the promotion target");
  }
  if (options.expectedImageDigest && payload.candidate.imageDigest !== options.expectedImageDigest) {
    throw new Error("release evidence image digest does not match the promotion target");
  }
  if (options.expectedTag && payload.candidate.tag !== options.expectedTag) {
    throw new Error("release evidence RC tag does not match the promotion target");
  }
  if (options.expectedConfigurationHash
    && releaseEvidenceConfigurationHash(payload) !== options.expectedConfigurationHash) {
    throw new Error("release evidence configuration does not match the promotion target");
  }
  if (options.expectedRuntimeHash
    && releaseEvidenceRuntimeHash(payload) !== options.expectedRuntimeHash) {
    throw new Error("release evidence runtime does not match the promotion target");
  }
  return payload;
}

/**
 * Rebuilds the candidate semantic baseline from the independently attested
 * blinded-review gate. Stable authorization must not trust fixture hashes that
 * exist only in release-signer-owned candidate/finalization summaries.
 */
export function verifyCandidateSemanticReviewAuthorizationEvidence(input: {
  candidateEvidence: unknown;
  semanticReviewGateArtifact: unknown;
  semanticReviewGateProducerAttestation: unknown;
  releaseVerificationKey: string | Buffer | KeyObject;
  releaseGateProducerVerificationKey: string | Buffer | KeyObject;
  approvedReleaseGateProducer: unknown;
  approvedSemanticReviewer: unknown;
  expectedTag: string;
  expectedRevision: string;
  expectedImageDigest: string;
  now?: string;
}): VerifiedCandidateSemanticReviewAuthorizationV1 {
  const candidateEvidence = verifyReleaseEvidence(
    input.candidateEvidence,
    input.releaseVerificationKey,
    {
      expectedKind: "candidate",
      expectedTag: input.expectedTag,
      expectedRevision: input.expectedRevision,
      expectedImageDigest: input.expectedImageDigest,
      now: input.now,
    },
  );
  const candidateEnvelope = asRecord(
    input.candidateEvidence,
    "signed candidate release evidence",
  );
  const candidateEvidencePayloadHash = digest(
    candidateEnvelope.payloadHash,
    "candidate release evidence payload hash",
  );
  const artifact = validateReleaseGateArtifact(
    input.semanticReviewGateArtifact,
  );
  if (
    artifact.gate !== "semantic_ranking_blinded_review"
    || artifact.environment !== "staging"
    || !sameCandidate(candidateEvidence.candidate, artifact.candidate)
  ) {
    throw new Error(
      "semantic review gate does not bind the exact candidate release",
    );
  }
  const candidateGate = candidateEvidence.gates.find(
    ({ name }) => name === "semantic_ranking_blinded_review",
  );
  const canonicalGate = {
    name: artifact.gate,
    environment: artifact.environment,
    passed: true as const,
    completedAt: artifact.completedAt,
    evidenceHash: artifact.evidenceHash,
    artifactSchemaVersion: artifact.schemaVersion,
    configurationHash: artifact.configurationHash,
    runtimeHash: artifact.runtimeHash,
    fixtures: artifact.fixtures,
    cacheMode: artifact.cacheMode,
    budgetStatus: artifact.budgetStatus,
  };
  if (
    !candidateGate
    || stableReleaseEvidenceJson(candidateGate)
      !== stableReleaseEvidenceJson(canonicalGate)
    || artifact.configurationHash
      !== releaseEvidenceConfigurationHash(candidateEvidence)
    || artifact.runtimeHash !== releaseEvidenceRuntimeHash(candidateEvidence)
    || candidateEvidence.semanticReview.gateEvidenceHash
      !== artifact.evidenceHash
  ) {
    throw new Error(
      "candidate release evidence does not bind the exact semantic review gate",
    );
  }

  const producerTrust = validateReleaseGateProducerTrustPolicyV1(
    input.approvedReleaseGateProducer,
  );
  const producerKeySha256 = releaseGateProducerKeyFingerprint(
    input.releaseGateProducerVerificationKey,
  );
  if (producerKeySha256 !== producerTrust.approvedKeySha256) {
    throw new Error(
      "semantic review gate producer does not use the protected approved key",
    );
  }
  const producerAttestation = verifyReleaseGateProducerAttestation(
    input.semanticReviewGateProducerAttestation,
    artifact,
    input.releaseGateProducerVerificationKey,
  );
  if (
    producerAttestation.signature.keyId !== producerTrust.approvedKeyId
  ) {
    throw new Error(
      "semantic review gate producer key ID is not protected and approved",
    );
  }

  const approvedSemanticReviewer =
    validateSemanticRankingReviewerTrustPolicyV1(
      input.approvedSemanticReviewer,
    );
  const artifactReviewerTrust =
    validateSemanticRankingReviewerTrustPolicyV1(
      artifact.sources.reviewerTrustPolicy,
    );
  const reviewerKey = validateSemanticRankingReviewerVerificationKeyV1(
    artifact.sources.reviewerVerificationKey,
  );
  if (
    stableReleaseEvidenceJson(artifactReviewerTrust)
      !== stableReleaseEvidenceJson(approvedSemanticReviewer)
    || reviewerKey.source.sha256
      !== approvedSemanticReviewer.approvedKeySha256
  ) {
    throw new Error(
      "semantic reviewer or baseline does not match the protected semantic review policy",
    );
  }
  const reviewerKeySha256 = reviewerKey.source.sha256;
  if (reviewerKeySha256 === producerKeySha256) {
    throw new Error(
      "semantic reviewer key must be separate from the release gate producer key",
    );
  }

  const reviewArtifact = validateSemanticRankingReviewArtifactV1(
    artifact.sources.reviewArtifact,
  );
  const fixtures = Object.freeze(
    semanticRankingCandidateBaselineFixturesV1(reviewArtifact).map(
      (fixture) => Object.freeze({ ...fixture }),
    ),
  );
  if (
    reviewArtifact.reviewedAt
      !== candidateEvidence.semanticReview.reviewedAt
    || stableReleaseEvidenceJson(fixtures)
      !== stableReleaseEvidenceJson(
        candidateEvidence.semanticReview.fixtures,
      )
  ) {
    throw new Error(
      "candidate semantic review fixtures were not mechanically derived from the independently verified candidate arms",
    );
  }
  return Object.freeze({
    candidateEvidence,
    candidateEvidencePayloadHash,
    candidateEvidenceGeneratedAt: candidateEvidence.generatedAt,
    gateEvidenceHash: artifact.evidenceHash,
    reviewedAt: reviewArtifact.reviewedAt,
    semanticBehaviorHash:
      candidateEvidence.semanticReview.semanticBehaviorHash,
    fixtures,
    producerKeySha256,
    reviewerKeySha256,
  });
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : "";
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "sign") {
    const inputPath = option(args, "--input");
    const outputPath = option(args, "--output");
    const privateKeyPath = option(args, "--private-key");
    const producerPublicKeyPath = option(args, "--producer-public-key");
    const keyId = option(args, "--key-id");
    const [input, pem, producerPem] = await Promise.all([
      readFile(inputPath, "utf8"),
      readFile(privateKeyPath),
      readFile(producerPublicKeyPath),
    ]);
    const evidence = await signReleaseEvidenceBundle(
      JSON.parse(input),
      dirname(resolve(inputPath)),
      producerPem,
      releaseGateProducerTrustPolicyV1({
        approvedKeyId:
          process.env.RELEASE_GATE_PRODUCER_KEY_ID?.trim() ?? "",
        approvedKeySha256:
          process.env.RELEASE_GATE_PRODUCER_KEY_SHA256
            ?.trim()
            .toLowerCase() ?? "",
      }),
      semanticRankingReviewerTrustPolicyV1({
        approvedKeyId:
          process.env.RELEASE_SEMANTIC_REVIEWER_KEY_ID?.trim() ?? "",
        approvedKeySha256:
          process.env.RELEASE_SEMANTIC_REVIEWER_KEY_SHA256
            ?.trim()
            .toLowerCase() ?? "",
        approvedBaselineMetadataSha256:
          process.env.RELEASE_SEMANTIC_BASELINE_METADATA_SHA256
            ?.trim()
            .toLowerCase() ?? "",
        approvedBaselineStableTag:
          process.env.RELEASE_SEMANTIC_BASELINE_STABLE_TAG?.trim() ?? "",
        approvedBaselineReleaseKeySha256:
          process.env.RELEASE_SEMANTIC_BASELINE_RELEASE_KEY_SHA256
            ?.trim()
            .toLowerCase() ?? "",
        approvedBaselineStableAuthorizerKeyId:
          process.env.RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_ID
            ?.trim() ?? "",
        approvedBaselineStableAuthorizerKeySha256:
          process.env
            .RELEASE_SEMANTIC_BASELINE_STABLE_AUTHORIZER_KEY_SHA256
            ?.trim()
            .toLowerCase() ?? "",
      }),
      releaseGateProducerTrustPolicyV1({
        approvedKeyId:
          process.env.RELEASE_HISTORICAL_REPLAY_KEY_ID?.trim() ?? "",
        approvedKeySha256:
          process.env.RELEASE_HISTORICAL_REPLAY_KEY_SHA256
            ?.trim()
            .toLowerCase() ?? "",
      }),
      stagingControlPlaneTrustPolicyV1({
        approvedKeyId:
          process.env.RELEASE_STAGING_CONTROL_PLANE_KEY_ID?.trim() ?? "",
        approvedKeySha256:
          process.env.RELEASE_STAGING_CONTROL_PLANE_KEY_SHA256
            ?.trim()
            .toLowerCase() ?? "",
      }),
      {
        schemaVersion: "genio-sites-control-plane-trust-policy/v1",
        approvedKeyId:
          process.env.RELEASE_SITES_CONTROL_PLANE_KEY_ID?.trim() ?? "",
        approvedKeySha256:
          process.env.RELEASE_SITES_CONTROL_PLANE_KEY_SHA256
            ?.trim()
            .toLowerCase() ?? "",
      },
      verifyGithubOfflineAttestation,
      pem,
      keyId,
    );
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command,
      payloadHash: evidence.payloadHash,
      configurationHash: releaseEvidenceConfigurationHash(evidence.payload),
      runtimeHash: releaseEvidenceRuntimeHash(evidence.payload),
      keyId: evidence.signature.keyId,
      output: outputPath,
    })}\n`);
    return;
  }
  if (command === "verify") {
    const inputPath = option(args, "--input");
    const publicKeyPath = option(args, "--public-key");
    const expectedRevision = option(args, "--expected-revision");
    const expectedImageDigest = option(args, "--expected-image-digest");
    const expectedTag = option(args, "--expected-tag");
    const expectedConfigurationHash = option(args, "--expected-configuration-hash");
    const expectedRuntimeHash = option(args, "--expected-runtime-hash");
    const expectedKindValue = option(args, "--expected-kind");
    if (
      expectedKindValue !== "candidate"
      && expectedKindValue !== "promotion"
      && expectedKindValue !== "finalization"
    ) {
      throw new Error(
        "--expected-kind must be candidate, promotion, or finalization",
      );
    }
    const [input, pem] = await Promise.all([
      readFile(inputPath, "utf8"),
      readFile(publicKeyPath),
    ]);
    const envelope = JSON.parse(input) as SignedReleaseEvidenceV1;
    const payload = verifyReleaseEvidence(envelope, pem, {
      expectedKind: expectedKindValue,
      expectedRevision,
      expectedImageDigest,
      expectedTag,
      expectedConfigurationHash: digest(expectedConfigurationHash, "--expected-configuration-hash"),
      expectedRuntimeHash: digest(expectedRuntimeHash, "--expected-runtime-hash"),
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command,
      kind: payload.kind,
      payloadHash: envelope.payloadHash,
      keyId: envelope.signature.keyId,
      tag: payload.candidate.tag,
      configurationHash: releaseEvidenceConfigurationHash(payload),
      runtimeHash: releaseEvidenceRuntimeHash(payload),
      expiresAt: payload.expiresAt,
    })}\n`);
    return;
  }
  throw new Error(
    "Usage: release-evidence sign --input signing-bundle.json --output evidence.json --private-key key.pem "
    + "--producer-public-key producer.pub.pem --key-id <id> | "
    + "verify --input evidence.json --public-key key.pub.pem --expected-revision <sha> "
    + "--expected-image-digest sha256:<digest> --expected-tag vX.Y.Z-rc.N "
    + "--expected-kind candidate|promotion --expected-configuration-hash <sha256> "
    + "--expected-runtime-hash <sha256>",
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: "release_evidence_failed",
      message: error instanceof Error ? error.message : "Release evidence failed",
    })}\n`);
    process.exitCode = 1;
  });
}
