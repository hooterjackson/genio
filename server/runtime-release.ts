import { DATABASE_SCHEMA_SUPPORT, DATABASE_SCHEMA_VERSION } from "../db/index.ts";
import {
  PIPELINE_V3_ALLOWED_PROVIDER_MODEL_IDS,
  PIPELINE_V3_DEFAULT_BASELINE_MODEL_ID,
  PIPELINE_V3_DEFAULT_ESCALATION_MODEL_ID,
  PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT,
  PIPELINE_V3_MODEL_RESOLUTION_MODE,
  PIPELINE_V3_PROMPT_VERSION,
} from "./pipeline-v3-policy.ts";
import { MUSIC_CONCEPT_POLICY_VERSION } from "./music-concepts-v3.ts";
import {
  CANONICAL_CONTRACT_QUERY_PLAN_V3_VERSION,
  QUERY_PLAN_V3_POLICY_VERSION,
  queryPlanV3EmissionSchemaVersion,
} from "./query-plan-v3.ts";
import {
  PIPELINE_V3_POLICY_VERSION,
  SELECTION_PLAN_V3_VERSION,
  SEMANTIC_SCOPE_POLICY_VERSION,
} from "./selection-plan-v3.ts";
import {
  BRIEF_CONTRACT_VERSION,
  EVIDENCE_POLICY_VERSION,
  GUIDANCE_POLICY_VERSION,
} from "./guidance-contract-v2.ts";
import {
  BRIDGE_API_MINIMUM_WORKER_PROTOCOL_VERSION,
  WORKER_PIPELINE_PROTOCOL_VERSION,
} from "./worker-protocol.ts";
import { ADAPTIVE_GUIDANCE_POLICY_VERSION } from "./adaptive-guidance-v3.ts";
import { PLAYLIST_CONTRACT_EVIDENCE_POLICY_VERSION } from "./playlist-contract-v1.ts";
import {
  capabilityPepperRotationStatus,
  sha256Hex,
  stableStringify,
} from "./security.ts";
import {
  canonicalContractActivationConfigured,
  canonicalContractCohortConfigured,
  expectedReleaseDatabaseSchemaVersion,
  releaseExecutionConfigured,
  runtimeReleaseDeploymentPhase,
  stagingBootstrapConfigured,
  type RuntimeReleaseDeploymentPhase,
} from "./release-deployment-phase.ts";
import { resolveBriefInterpretationModel } from "./brief-model.ts";

export interface RuntimeReleaseContract {
  pipelineVersion: "corpus_first_v3";
  releaseEnvironment: "development" | "staging" | "production";
  ownerAllowlistVersion: string | null;
  capabilityPepperVersionHash: string | null;
  capabilityPreviousPepperVersionHash: string | null;
  deploymentPhase: RuntimeReleaseDeploymentPhase;
  expectedDatabaseSchemaVersion: string | null;
  stagingBootstrapConfigured: boolean;
  executionEnabled: boolean;
  canonicalActivationConfigured: boolean;
  assignmentEnabled: boolean;
  ownerCanaryEnabled: boolean;
  productionEvidenceApproved: boolean;
  curatedHostedEvidenceApproved: boolean;
  genreSceneEvidenceApproved: boolean;
  geographicScopeEvidenceApproved: boolean;
  factualFeasibilityApproved: boolean;
  publicRolloutEvidenceHash: string | null;
  publicRolloutStage: string | null;
  schemaVersion: string;
  schemaMinimum: string;
  schemaMaximum: string;
  schemaPreferred: string;
  workerProtocol: string;
  minimumWorkerProtocol: string;
  selectionPlanVersion: string;
  queryPlanSchemaVersion: string;
  briefContractVersion: string;
  guidanceContractOwnerCanaryEnabled: boolean;
  guidanceContractReggaetonCanaryEnabled: boolean;
  guidancePolicyVersion: string;
  evidencePolicyVersion: string;
  queryPlanPolicyVersion: string;
  semanticScopePolicyVersion: string;
  musicConceptPolicyVersion: string;
  pipelinePolicyVersion: string;
  promptVersion: string;
  briefProviderModelId: string;
  baselineProviderModelId: string;
  escalationProviderModelId: string;
  modelResolutionMode: typeof PIPELINE_V3_MODEL_RESOLUTION_MODE;
  modelCatalogValidatedAt: string;
}

const API_RELEASE_CONFIGURATION_ENV_KEYS = [
  "NODE_ENV",
  "APP_ORIGIN",
  "RELEASE_ENVIRONMENT",
  "RELEASE_DEPLOYMENT_PHASE",
  "RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION",
  "RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION",
  "RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION",
  "RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION",
  "RELEASE_STAGING_BOOTSTRAP_FRESH_EMPTY_DATABASE_CONFIRMED",
  "RELEASE_EXECUTION_ENABLED",
  "RELEASE_SECRET_VERSIONS_HASH",
  "RELEASE_VERIFIED_CANDIDATE_EVIDENCE_HASH",
  "RELEASE_BRIDGE_CONVERGENCE_EVIDENCE_HASH",
  "RELEASE_EXPAND_CONVERGENCE_EVIDENCE_HASH",
  "RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH",
  "RELEASE_PUBLIC_ROLLOUT_STAGE",
  "RELEASE_PUBLIC_ROLLOUT_OPERATION",
  "RELEASE_PUBLIC_ROLLOUT_INTENT_GROUP",
  "RELEASE_PUBLIC_ROLLOUT_FROM_PERCENT",
  "RELEASE_PUBLIC_ROLLOUT_TO_PERCENT",
  "RELEASE_PREVIOUS_PUBLIC_ROLLOUT_EVIDENCE_HASH",
  "QA_STAGING_CONTROL_HASH",
  "REQUIRE_WORKER_HEARTBEAT",
  "CAPABILITY_SESSION_TTL_DAYS",
  "CAPABILITY_PREVIOUS_PEPPER_EXPIRES_AT",
  "WORKER_STALE_SECONDS",
  "APPLE_SHARE_URL_TIMEOUT_SECONDS",
  "APPLE_STOREFRONT",
  "RESULT_REUSE_DAYS",
  "RETENTION_DAYS",
  "BRIEF_LIMIT_PER_24H",
  "MAX_GLOBAL_NONTERMINAL_RUNS",
  "RUN_LIMIT_PER_24H",
  "GATEWAY_KEY_ID",
  "GATEWAY_PREVIOUS_KEY_ID",
  "OWNER_ALLOWLIST_VERSION",
  "APPLE_KEY_ID",
  "APPLE_MEDIA_ID",
  "APPLE_TEAM_ID",
  "APPLE_TOKEN_ENCRYPTION_KEY_ID",
  "OPENAI_TIMEOUT_MS",
  "GUIDANCE_SCOUT_TIMEOUT_MS",
  "APPLE_WRITE_TOKEN_CAPACITY",
  "APPLE_WRITE_TOKEN_REFILL_PER_SECOND",
  "APPLE_WRITE_LOCK_WAIT_MS",
  "APP_MONTHLY_COST_LIMIT_USD",
  "AUTO_RUN_COST_LIMIT_USD",
  "COST_TIMEZONE",
  "OPENAI_INPUT_USD_PER_MILLION",
  "OPENAI_LUNA_INPUT_USD_PER_MILLION",
  "OPENAI_LUNA_OUTPUT_USD_PER_MILLION",
  "OPENAI_TERRA_INPUT_USD_PER_MILLION",
  "OPENAI_TERRA_OUTPUT_USD_PER_MILLION",
  "OPENAI_OUTPUT_USD_PER_MILLION",
  "OPENAI_WEB_SEARCH_USD",
  "OPENAI_MAX_BRIEF_RESERVATION_USD",
  "OPENAI_MAX_RESPONSE_RESERVATION_USD",
  "OPENAI_MIN_BRIEF_RESERVATION_USD",
  "OPENAI_MIN_RESPONSE_RESERVATION_USD",
  "OPENAI_RESUME_CONTEXT_FALLBACK_TOKENS",
  "OPENAI_BRIEF_MODEL",
  "OPENAI_FAST_MODEL",
  "OPENAI_DEEP_MODEL",
  "OPENAI_CURATED_LUNA_SNAPSHOT",
  "OPENAI_CURATED_TERRA_SNAPSHOT",
  "PIPELINE_V2_OWNER_CANARY",
  "PIPELINE_V2_CURATED_PERCENT",
  "PIPELINE_V2_SIMILARITY_PERCENT",
  "PIPELINE_V2_FACTUAL_OWNER_CANARY",
  "PIPELINE_V2_FACTUAL_PERCENT",
  "PIPELINE_V3_ASSIGNMENT_ENABLED",
  "PIPELINE_V3_OWNER_CANARY",
  "PIPELINE_V3_OWNER_CANARY_GROUPS",
  "PIPELINE_V3_OWNER_CANARY_MAX_TRACKS",
  "PIPELINE_V3_GENRE_SCENE_PERCENT",
  "PIPELINE_V3_MOOD_ACTIVITY_PERCENT",
  "PIPELINE_V3_SIMILARITY_PERCENT",
  "PIPELINE_V3_ARTIST_CATALOGUE_PERCENT",
  "PIPELINE_V3_FIXED_CONTAINER_PERCENT",
  "PIPELINE_V3_FACTUAL_PERCENT",
  "PIPELINE_V3_EXHAUSTIVE_PERCENT",
  "PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION",
  "PIPELINE_V3_BASELINE_MODEL_ID",
  "PIPELINE_V3_ESCALATION_MODEL_ID",
  "PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT",
  "PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED",
  "PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED",
  "PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED",
  "PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED",
  "PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED",
  "GUIDANCE_CONTRACT_V2_ENABLED",
  "GUIDANCE_CONTRACT_V2_OWNER_CANARY",
  "GUIDANCE_CONTRACT_V3_ENABLED",
  "GUIDANCE_CONTRACT_V3_OWNER_CANARY",
  "GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED",
] as const;

function safeProviderModelId(value: string | undefined, fallback: string): string {
  const normalized = value?.trim() ?? "";
  return (PIPELINE_V3_ALLOWED_PROVIDER_MODEL_IDS as readonly string[]).includes(normalized)
    ? normalized
    : fallback;
}

function safeCatalogValidatedAt(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === normalized
    ? normalized
    : PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT;
}

function releaseEnvironment(
  value: string | undefined,
): RuntimeReleaseContract["releaseEnvironment"] {
  return value === "staging" || value === "production"
    ? value
    : "development";
}

const OWNER_ALLOWLIST_VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u;

export function releaseOwnerAllowlistVersion(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const version = environment.OWNER_ALLOWLIST_VERSION?.trim() ?? "";
  if (version && !OWNER_ALLOWLIST_VERSION.test(version)) {
    throw new Error("OWNER_ALLOWLIST_VERSION must be a safe non-secret release label");
  }
  if (
    releaseEnvironment(environment.RELEASE_ENVIRONMENT) !== "development"
    && environment.OWNER_EMAIL?.trim()
    && !version
  ) {
    throw new Error(
      "OWNER_ALLOWLIST_VERSION is required when OWNER_EMAIL is configured in a release environment",
    );
  }
  return version || null;
}

/**
 * Public, secret-free runtime contract shown on About and health endpoints.
 * It describes the exact protocol the deployed binary understands; rollout
 * flags remain explicit so a capable binary is never mistaken for active V3
 * traffic.
 */
export function runtimeReleaseContract(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeReleaseContract {
  const canonicalActivationConfigured = canonicalContractActivationConfigured(environment);
  const canonicalContractActive = canonicalContractCohortConfigured(environment);
  const ownerAllowlistVersion = releaseOwnerAllowlistVersion(environment);
  const capabilityPepper = capabilityPepperRotationStatus(environment);
  return Object.freeze({
    pipelineVersion: "corpus_first_v3",
    releaseEnvironment: releaseEnvironment(environment.RELEASE_ENVIRONMENT),
    ownerAllowlistVersion,
    capabilityPepperVersionHash: capabilityPepper.currentVersionHash,
    capabilityPreviousPepperVersionHash: capabilityPepper.previousVersionHash,
    deploymentPhase: runtimeReleaseDeploymentPhase(environment),
    expectedDatabaseSchemaVersion: expectedReleaseDatabaseSchemaVersion(environment),
    stagingBootstrapConfigured: stagingBootstrapConfigured(environment),
    executionEnabled: releaseExecutionConfigured(environment),
    canonicalActivationConfigured,
    assignmentEnabled: environment.PIPELINE_V3_ASSIGNMENT_ENABLED === "true",
    ownerCanaryEnabled: environment.PIPELINE_V3_OWNER_CANARY === "true",
    productionEvidenceApproved: environment.PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED === "true",
    curatedHostedEvidenceApproved: environment.PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED === "true",
    genreSceneEvidenceApproved: environment.PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED === "true",
    geographicScopeEvidenceApproved: environment.PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED === "true",
    factualFeasibilityApproved: environment.PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED === "true",
    publicRolloutEvidenceHash:
      /^[0-9a-f]{64}$/u.test(
        environment.RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH?.trim() ?? "",
      )
        ? environment.RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH!.trim()
        : null,
    publicRolloutStage:
      /^(?:genre_scene|mood_activity_theme|similarity|artist_catalogue|fixed_container|factual_relationship|exhaustive):(?:0|1|10|50|100)->(?:0|1|10|50|100)$/u.test(
        environment.RELEASE_PUBLIC_ROLLOUT_STAGE?.trim() ?? "",
      )
        ? environment.RELEASE_PUBLIC_ROLLOUT_STAGE!.trim()
        : null,
    schemaVersion: DATABASE_SCHEMA_VERSION,
    schemaMinimum: DATABASE_SCHEMA_SUPPORT.minimum,
    schemaMaximum: DATABASE_SCHEMA_SUPPORT.maximum,
    schemaPreferred: DATABASE_SCHEMA_SUPPORT.preferred,
    workerProtocol: WORKER_PIPELINE_PROTOCOL_VERSION,
    minimumWorkerProtocol: BRIDGE_API_MINIMUM_WORKER_PROTOCOL_VERSION,
    selectionPlanVersion: SELECTION_PLAN_V3_VERSION,
    queryPlanSchemaVersion: String(canonicalContractActive
      ? CANONICAL_CONTRACT_QUERY_PLAN_V3_VERSION
      : environment.GUIDANCE_CONTRACT_V2_ENABLED === "true"
        ? 3
        : queryPlanV3EmissionSchemaVersion(environment)),
    briefContractVersion: String(canonicalContractActive
      ? 3
      : environment.GUIDANCE_CONTRACT_V2_ENABLED === "true"
        ? BRIEF_CONTRACT_VERSION
        : 1),
    guidanceContractOwnerCanaryEnabled: (
      canonicalActivationConfigured
      && environment.GUIDANCE_CONTRACT_V3_OWNER_CANARY === "true"
    )
      || environment.GUIDANCE_CONTRACT_V2_OWNER_CANARY === "true",
    guidanceContractReggaetonCanaryEnabled:
      canonicalActivationConfigured
      && environment.GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED === "true",
    guidancePolicyVersion: canonicalContractActive
      ? ADAPTIVE_GUIDANCE_POLICY_VERSION
      : GUIDANCE_POLICY_VERSION,
    evidencePolicyVersion: canonicalContractActive
      ? PLAYLIST_CONTRACT_EVIDENCE_POLICY_VERSION
      : EVIDENCE_POLICY_VERSION,
    queryPlanPolicyVersion: QUERY_PLAN_V3_POLICY_VERSION,
    semanticScopePolicyVersion: SEMANTIC_SCOPE_POLICY_VERSION,
    musicConceptPolicyVersion: MUSIC_CONCEPT_POLICY_VERSION,
    pipelinePolicyVersion: PIPELINE_V3_POLICY_VERSION,
    promptVersion: PIPELINE_V3_PROMPT_VERSION,
    briefProviderModelId: resolveBriefInterpretationModel(environment),
    baselineProviderModelId: safeProviderModelId(
      environment.PIPELINE_V3_BASELINE_MODEL_ID,
      PIPELINE_V3_DEFAULT_BASELINE_MODEL_ID,
    ),
    escalationProviderModelId: safeProviderModelId(
      environment.PIPELINE_V3_ESCALATION_MODEL_ID,
      PIPELINE_V3_DEFAULT_ESCALATION_MODEL_ID,
    ),
    modelResolutionMode: PIPELINE_V3_MODEL_RESOLUTION_MODE,
    modelCatalogValidatedAt: safeCatalogValidatedAt(environment.PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT),
  });
}

/**
 * Secret-free, behavior-sensitive identity for the API configuration that is
 * actually running. Secret rotation is fenced independently by the release
 * secret-version snapshot; raw secret material is never part of this digest.
 */
export function apiReleaseConfigurationHash(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const policyEnvironment = Object.fromEntries(
    API_RELEASE_CONFIGURATION_ENV_KEYS.map((key) => [
      key,
      environment[key]?.trim() || null,
    ]),
  );
  return sha256Hex(stableStringify({
    runtime: runtimeReleaseContract(environment),
    policyEnvironment,
  }));
}
