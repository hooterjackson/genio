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
import { ADAPTIVE_GUIDANCE_POLICY_VERSION_V4 } from "./adaptive-guidance-v4.ts";
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
import {
  musicBrainzContactConfigurationLabel,
} from "./musicbrainz-contact.ts";
import {
  proofArchitectureMode,
  SCHEMA_20_PROOF_ARCHITECTURE_VERSION,
  type ProofArchitectureMode,
} from "./schema20-proof-architecture.ts";

export interface RuntimeReleaseContract {
  pipelineVersion: "corpus_first_v3";
  semanticExecutionConfigurationHash: string;
  releaseEnvironment: "development" | "staging" | "production";
  ownerAllowlistVersion: string | null;
  capabilityPepperVersionHash: string | null;
  capabilityPreviousPepperVersionHash: string | null;
  deploymentPhase: RuntimeReleaseDeploymentPhase;
  expectedDatabaseSchemaVersion: string | null;
  stagingBootstrapConfigured: boolean;
  executionEnabled: boolean;
  canonicalActivationConfigured: boolean;
  proofArchitectureMode: ProofArchitectureMode;
  proofArchitectureVersion: typeof SCHEMA_20_PROOF_ARCHITECTURE_VERSION;
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

export const SEMANTIC_EXECUTION_CONFIGURATION_SCHEMA_V1 =
  "genio-semantic-execution-configuration/v1" as const;

/**
 * Closed, secret-free inventory of mutable environment inputs that can alter
 * interpretation, retrieval yield, qualification, matching, or exact output.
 * Pure percentage cohorts and signed rollout-lineage markers are deliberately
 * excluded: they decide who receives a behavior, not what that behavior does.
 */
export const SEMANTIC_EXECUTION_CONFIGURATION_ENV_KEYS_V1 = Object.freeze([
  "APPLE_CATALOG_RECOVERY_TIMEOUT_MS",
  "APPLE_MATCHING_CONCURRENCY",
  "APPLE_MATCH_MAX_QUERIES",
  "APPLE_SHARE_URL_TIMEOUT_SECONDS",
  "APPLE_STOREFRONT",
  "APPLE_WRITE_LOCK_WAIT_MS",
  "APPLE_WRITE_TOKEN_CAPACITY",
  "APPLE_WRITE_TOKEN_REFILL_PER_SECOND",
  "AUTO_RUN_COST_LIMIT_USD",
  "COST_TIMEZONE",
  "ENABLE_DISCOGS_ADAPTER",
  "FAST_MATCH_LOOKUP_TIMEOUT_MS",
  "FAST_RESEARCH_MAX_EXTRACTION_TOKENS",
  "FAST_RESEARCH_MAX_SYNTHESIS_TOKENS",
  "FAST_RESEARCH_MAX_WEB_CALLS",
  "FAST_RESEARCH_SEARCH_CONTEXT",
  "GUIDANCE_CONTRACT_V2_ENABLED",
  "GUIDANCE_CONTRACT_V2_OWNER_CANARY",
  "GUIDANCE_CONTRACT_V3_ENABLED",
  "GUIDANCE_CONTRACT_V3_OWNER_CANARY",
  "GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED",
  "GUIDANCE_V5_ENABLED",
  "GUIDANCE_SCOUT_TIMEOUT_MS",
  "INITIAL_COST_GATE_USD",
  "MUSICBRAINZ_CONTACT",
  "OPENAI_BRIEF_MODEL",
  "OPENAI_CURATED_LUNA_SNAPSHOT",
  "OPENAI_CURATED_TERRA_SNAPSHOT",
  "OPENAI_DEEP_MODEL",
  "OPENAI_FAST_MODEL",
  "OPENAI_GPT_5_4_MINI_CACHED_INPUT_USD_PER_MILLION",
  "OPENAI_GPT_5_4_MINI_INPUT_USD_PER_MILLION",
  "OPENAI_GPT_5_4_MINI_OUTPUT_USD_PER_MILLION",
  "OPENAI_INPUT_USD_PER_MILLION",
  "OPENAI_LUNA_CACHED_INPUT_USD_PER_MILLION",
  "OPENAI_LUNA_INPUT_USD_PER_MILLION",
  "OPENAI_LUNA_OUTPUT_USD_PER_MILLION",
  "OPENAI_MAX_BRIEF_RESERVATION_USD",
  "OPENAI_MAX_RESPONSE_RESERVATION_USD",
  "OPENAI_MIN_BRIEF_RESERVATION_USD",
  "OPENAI_MIN_RESPONSE_RESERVATION_USD",
  "OPENAI_OUTPUT_USD_PER_MILLION",
  "OPENAI_RESUME_CONTEXT_FALLBACK_TOKENS",
  "OPENAI_TERRA_CACHED_INPUT_USD_PER_MILLION",
  "OPENAI_TERRA_INPUT_USD_PER_MILLION",
  "OPENAI_TERRA_OUTPUT_USD_PER_MILLION",
  "OPENAI_TIMEOUT_MS",
  "OPENAI_WEB_SEARCH_USD",
  "PIPELINE_V2_FACTUAL_OWNER_CANARY",
  "PIPELINE_V2_OWNER_CANARY",
  "PIPELINE_V3_ASSIGNMENT_ENABLED",
  "PIPELINE_V3_BASELINE_MODEL_ID",
  "PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED",
  "PIPELINE_V3_ESCALATION_MODEL_ID",
  "PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED",
  "PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED",
  "PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED",
  "PIPELINE_V3_MAX_EXTRACTION_TOKENS",
  "PIPELINE_V3_MAX_RAW_CANDIDATES",
  "PIPELINE_V3_MAX_ROUNDS",
  "PIPELINE_V3_MAX_SEARCH_CALLS",
  "PIPELINE_V3_MAX_SYNTHESIS_TOKENS",
  "PIPELINE_V3_MAX_TOOL_CALLS",
  "PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT",
  "PIPELINE_V3_OWNER_CANARY",
  "PIPELINE_V3_OWNER_CANARY_GROUPS",
  "PIPELINE_V3_OWNER_CANARY_MAX_TRACKS",
  "PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED",
  "PIPELINE_V3_PROOF_ARCHITECTURE_MODE",
  "PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION",
  "RESEARCH_MAX_GAP_PASSES",
  "RESEARCH_MAX_SEGMENTS_PER_PASS",
  "RESEARCH_TURNS_PER_SEGMENT",
  "RESULT_REUSE_DAYS",
] as const);

export const SEMANTIC_EXECUTION_CONFIGURATION_REVIEWED_EXCLUSIONS_V1 =
  Object.freeze({
    cohortPercentages: Object.freeze([
      "PIPELINE_V2_CURATED_PERCENT",
      "PIPELINE_V2_FACTUAL_PERCENT",
      "PIPELINE_V2_SIMILARITY_PERCENT",
      "PIPELINE_V3_ARTIST_CATALOGUE_PERCENT",
      "PIPELINE_V3_EXHAUSTIVE_PERCENT",
      "PIPELINE_V3_FACTUAL_PERCENT",
      "PIPELINE_V3_FIXED_CONTAINER_PERCENT",
      "PIPELINE_V3_GENRE_SCENE_PERCENT",
      "PIPELINE_V3_MOOD_ACTIVITY_PERCENT",
      "PIPELINE_V3_SIMILARITY_PERCENT",
    ] as const),
    rolloutLineage: Object.freeze([
      "RELEASE_BRIDGE_CONVERGENCE_EVIDENCE_HASH",
      "RELEASE_EXPAND_CONVERGENCE_EVIDENCE_HASH",
      "RELEASE_PREVIOUS_PUBLIC_ROLLOUT_EVIDENCE_HASH",
      "RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH",
      "RELEASE_PUBLIC_ROLLOUT_FROM_PERCENT",
      "RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_HASH",
      "RELEASE_PUBLIC_ROLLOUT_INTENT_GROUP",
      "RELEASE_PUBLIC_ROLLOUT_OPERATION",
      "RELEASE_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_HASH",
      "RELEASE_PUBLIC_ROLLOUT_STAGE",
      "RELEASE_PUBLIC_ROLLOUT_TO_PERCENT",
      "RELEASE_VERIFIED_CANDIDATE_EVIDENCE_HASH",
    ] as const),
    credentials: Object.freeze([
      "APPLE_KEY_ID",
      "APPLE_MEDIA_ID",
      "APPLE_TEAM_ID",
      "APPLE_TOKEN_ENCRYPTION_KEY_ID",
      "GATEWAY_KEY_ID",
      "GATEWAY_PREVIOUS_KEY_ID",
      "RELEASE_SECRET_VERSIONS_HASH",
    ] as const),
    operationalBudgets: Object.freeze([
      "APP_MONTHLY_COST_LIMIT_USD",
      "MONTHLY_RESEARCH_CEILING_USD",
    ] as const),
    deploymentInfrastructure: Object.freeze([
      "APP_ORIGIN",
      "BRIEF_LIMIT_PER_24H",
      "CAPABILITY_PREVIOUS_PEPPER_EXPIRES_AT",
      "CAPABILITY_SESSION_TTL_DAYS",
      "MAX_GLOBAL_NONTERMINAL_RUNS",
      "NODE_ENV",
      "OWNER_ALLOWLIST_VERSION",
      "QA_STAGING_CONTROL_HASH",
      "RELEASE_DEPLOYMENT_PHASE",
      "RELEASE_ENVIRONMENT",
      "RELEASE_EXECUTION_ENABLED",
      "RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION",
      "RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION",
      "RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION",
      "RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION",
      "RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION",
      "RELEASE_STAGING_BOOTSTRAP_FRESH_EMPTY_DATABASE_CONFIRMED",
      "REQUIRE_WORKER_HEARTBEAT",
      "RETENTION_DAYS",
      "RUN_LIMIT_PER_24H",
      "WORKER_STALE_SECONDS",
    ] as const),
  });

/**
 * Closed classification for static server environment reads that are not
 * semantic-execution inputs. This inventory is enforced against source by a
 * census test, so a new direct read cannot silently bypass release review.
 * Values in these categories must never be copied into release evidence.
 */
export const SERVER_ENVIRONMENT_READ_REVIEWED_EXCLUSIONS_V1 =
  Object.freeze({
    secretMaterialAndPrivateIdentifiers: Object.freeze([
      "ALERT_EMAIL",
      "APPLE_MUSICKIT_PRIVATE_KEY",
      "APPLE_MUSICKIT_PRIVATE_KEY_BASE64",
      "APPLE_TOKEN_ENCRYPTION_KEY",
      "CAPABILITY_PEPPER",
      "CAPABILITY_PEPPER_VERSION",
      "CAPABILITY_PREVIOUS_PEPPER",
      "CAPABILITY_PREVIOUS_PEPPER_VERSION",
      "GATEWAY_HMAC_SECRET",
      "GATEWAY_KEYS_JSON",
      "GATEWAY_PREVIOUS_HMAC_SECRET",
      "GATEWAY_PREVIOUS_SECRET",
      "GATEWAY_SECRET",
      "DISCOGS_TOKEN",
      "OPENAI_API_KEY",
      "OWNER_ALERT_EMAIL",
      "OWNER_EMAIL",
      "RELEASE_CANARY_HMAC_SECRET",
      "RESEND_API_KEY",
      "RESEND_FROM",
    ] as const),
    buildIdentity: Object.freeze([
      "APP_VERSION",
      "COMMIT_SHA",
      "GITHUB_SHA",
      "RAILWAY_GIT_COMMIT_SHA",
      "SOURCE_COMMIT_SHA",
    ] as const),
    processTopology: Object.freeze([
      "MAX_WORKER_JOBS",
      "PORT",
      "RAILWAY_REPLICA_ID",
      "WORKER_CONCURRENCY",
      "WORKER_HEARTBEAT_SECONDS",
      "WORKER_LEASE_SECONDS",
      "WORKER_POLL_MS",
      "WORKER_QUEUE_CLASS",
      "WORKER_RENEW_SECONDS",
    ] as const),
    nonPlaylistProductPolicy: Object.freeze([
      "FEEDBACK_GLOBAL_DAILY_LIMIT",
      "FEEDBACK_STORAGE_LIMIT_BYTES",
    ] as const),
    observability: Object.freeze([
      "LOG_LEVEL",
    ] as const),
    testOnly: Object.freeze([
      "GENIO_SYSTEM_E2E",
    ] as const),
  });

/**
 * Dynamic indexed environment reads are permitted only at these reviewed
 * source sites and only for these closed key inventories. The source census
 * checks the exact site multiset, so switching syntax cannot bypass review.
 */
export const SERVER_DYNAMIC_ENVIRONMENT_READ_SOURCES_V1 = Object.freeze([
  Object.freeze({
    site: "cost-config.ts:environment[primary]",
    occurrences: 2,
    keys: Object.freeze([
      "APP_MONTHLY_COST_LIMIT_USD",
      "AUTO_RUN_COST_LIMIT_USD",
      "OPENAI_GPT_5_4_MINI_CACHED_INPUT_USD_PER_MILLION",
      "OPENAI_GPT_5_4_MINI_INPUT_USD_PER_MILLION",
      "OPENAI_GPT_5_4_MINI_OUTPUT_USD_PER_MILLION",
      "OPENAI_INPUT_USD_PER_MILLION",
      "OPENAI_LUNA_CACHED_INPUT_USD_PER_MILLION",
      "OPENAI_LUNA_INPUT_USD_PER_MILLION",
      "OPENAI_LUNA_OUTPUT_USD_PER_MILLION",
      "OPENAI_OUTPUT_USD_PER_MILLION",
      "OPENAI_TERRA_CACHED_INPUT_USD_PER_MILLION",
      "OPENAI_TERRA_INPUT_USD_PER_MILLION",
      "OPENAI_TERRA_OUTPUT_USD_PER_MILLION",
      "OPENAI_WEB_SEARCH_USD",
    ] as const),
  }),
  Object.freeze({
    site: "cost-config.ts:environment[legacy]",
    occurrences: 2,
    keys: Object.freeze([
      "INITIAL_COST_GATE_USD",
      "MONTHLY_RESEARCH_CEILING_USD",
    ] as const),
  }),
  Object.freeze({
    site: "runtime-release.ts:environment[key]",
    occurrences: 2,
    keys: Object.freeze([
      ...SEMANTIC_EXECUTION_CONFIGURATION_ENV_KEYS_V1,
      "NODE_ENV",
      "APP_ORIGIN",
      "RELEASE_ENVIRONMENT",
      "RELEASE_DEPLOYMENT_PHASE",
      "RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION",
      "RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION",
      "RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION",
      "RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION",
    ] as const),
  }),
  Object.freeze({
    site: "worker-runner.ts:process.env[name]",
    occurrences: 1,
    keys: Object.freeze([
      "WORKER_CONCURRENCY",
      "WORKER_HEARTBEAT_SECONDS",
      "WORKER_LEASE_SECONDS",
      "WORKER_POLL_MS",
      "WORKER_RENEW_SECONDS",
    ] as const),
  }),
  Object.freeze({
    site: "worker-runner.ts:environment[key]",
    occurrences: 1,
    keys: Object.freeze([
      ...SEMANTIC_EXECUTION_CONFIGURATION_ENV_KEYS_V1,
    ] as const),
  }),
  Object.freeze({
    site: "worker-runner.ts:environment[name]",
    occurrences: 1,
    keys: Object.freeze([
      "APPLE_KEY_ID",
      "APPLE_MEDIA_ID",
      "APPLE_TEAM_ID",
      "APPLE_TOKEN_ENCRYPTION_KEY",
      "OPENAI_API_KEY",
    ] as const),
  }),
  Object.freeze({
    site: "secrets.ts:process.env[name]",
    occurrences: 1,
    keys: Object.freeze([
      "APPLE_KEY_ID",
      "APPLE_MEDIA_ID",
      "APPLE_MUSICKIT_PRIVATE_KEY",
      "APPLE_MUSICKIT_PRIVATE_KEY_BASE64",
      "APPLE_TEAM_ID",
      "APPLE_TOKEN_ENCRYPTION_KEY",
      "APPLE_TOKEN_ENCRYPTION_KEY_ID",
      "DISCOGS_TOKEN",
      "OPENAI_API_KEY",
      "RESEND_API_KEY",
      "RESEND_FROM",
      "OWNER_ALERT_EMAIL",
      "ALERT_EMAIL",
    ] as const),
  }),
  Object.freeze({
    site: "matching-service.ts:process.env[name]",
    occurrences: 1,
    keys: Object.freeze([
      "APPLE_CATALOG_RECOVERY_TIMEOUT_MS",
      "APPLE_MATCHING_CONCURRENCY",
      "APPLE_MATCH_MAX_QUERIES",
      "FAST_MATCH_LOOKUP_TIMEOUT_MS",
    ] as const),
  }),
  Object.freeze({
    site: "query-plan-v3.ts:env[pipelineV3RolloutVariable(group)]",
    occurrences: 1,
    keys: Object.freeze([
      "PIPELINE_V3_ARTIST_CATALOGUE_PERCENT",
      "PIPELINE_V3_EXHAUSTIVE_PERCENT",
      "PIPELINE_V3_FACTUAL_PERCENT",
      "PIPELINE_V3_FIXED_CONTAINER_PERCENT",
      "PIPELINE_V3_GENRE_SCENE_PERCENT",
      "PIPELINE_V3_MOOD_ACTIVITY_PERCENT",
      "PIPELINE_V3_SIMILARITY_PERCENT",
    ] as const),
  }),
] as const);

type SemanticExecutionConfigurationKey =
  typeof SEMANTIC_EXECUTION_CONFIGURATION_ENV_KEYS_V1[number];

const SEMANTIC_EXECUTION_BOOLEAN_KEYS = new Set<SemanticExecutionConfigurationKey>([
  "ENABLE_DISCOGS_ADAPTER",
  "GUIDANCE_CONTRACT_V2_ENABLED",
  "GUIDANCE_CONTRACT_V2_OWNER_CANARY",
  "GUIDANCE_CONTRACT_V3_ENABLED",
  "GUIDANCE_CONTRACT_V3_OWNER_CANARY",
  "GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED",
  "PIPELINE_V2_FACTUAL_OWNER_CANARY",
  "PIPELINE_V2_OWNER_CANARY",
  "PIPELINE_V3_ASSIGNMENT_ENABLED",
  "PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED",
  "PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED",
  "PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED",
  "PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED",
  "PIPELINE_V3_OWNER_CANARY",
  "PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED",
]);

const SEMANTIC_EXECUTION_NUMERIC_KEYS = new Set<SemanticExecutionConfigurationKey>([
  "APPLE_CATALOG_RECOVERY_TIMEOUT_MS",
  "APPLE_MATCHING_CONCURRENCY",
  "APPLE_MATCH_MAX_QUERIES",
  "APPLE_SHARE_URL_TIMEOUT_SECONDS",
  "APPLE_WRITE_LOCK_WAIT_MS",
  "APPLE_WRITE_TOKEN_CAPACITY",
  "APPLE_WRITE_TOKEN_REFILL_PER_SECOND",
  "AUTO_RUN_COST_LIMIT_USD",
  "FAST_MATCH_LOOKUP_TIMEOUT_MS",
  "FAST_RESEARCH_MAX_EXTRACTION_TOKENS",
  "FAST_RESEARCH_MAX_SYNTHESIS_TOKENS",
  "FAST_RESEARCH_MAX_WEB_CALLS",
  "GUIDANCE_SCOUT_TIMEOUT_MS",
  "INITIAL_COST_GATE_USD",
  "OPENAI_GPT_5_4_MINI_CACHED_INPUT_USD_PER_MILLION",
  "OPENAI_GPT_5_4_MINI_INPUT_USD_PER_MILLION",
  "OPENAI_GPT_5_4_MINI_OUTPUT_USD_PER_MILLION",
  "OPENAI_INPUT_USD_PER_MILLION",
  "OPENAI_LUNA_CACHED_INPUT_USD_PER_MILLION",
  "OPENAI_LUNA_INPUT_USD_PER_MILLION",
  "OPENAI_LUNA_OUTPUT_USD_PER_MILLION",
  "OPENAI_MAX_BRIEF_RESERVATION_USD",
  "OPENAI_MAX_RESPONSE_RESERVATION_USD",
  "OPENAI_MIN_BRIEF_RESERVATION_USD",
  "OPENAI_MIN_RESPONSE_RESERVATION_USD",
  "OPENAI_OUTPUT_USD_PER_MILLION",
  "OPENAI_RESUME_CONTEXT_FALLBACK_TOKENS",
  "OPENAI_TERRA_CACHED_INPUT_USD_PER_MILLION",
  "OPENAI_TERRA_INPUT_USD_PER_MILLION",
  "OPENAI_TERRA_OUTPUT_USD_PER_MILLION",
  "OPENAI_TIMEOUT_MS",
  "OPENAI_WEB_SEARCH_USD",
  "PIPELINE_V3_MAX_EXTRACTION_TOKENS",
  "PIPELINE_V3_MAX_RAW_CANDIDATES",
  "PIPELINE_V3_MAX_ROUNDS",
  "PIPELINE_V3_MAX_SEARCH_CALLS",
  "PIPELINE_V3_MAX_SYNTHESIS_TOKENS",
  "PIPELINE_V3_MAX_TOOL_CALLS",
  "PIPELINE_V3_OWNER_CANARY_MAX_TRACKS",
  "RESEARCH_MAX_GAP_PASSES",
  "RESEARCH_MAX_SEGMENTS_PER_PASS",
  "RESEARCH_TURNS_PER_SEGMENT",
  "RESULT_REUSE_DAYS",
]);

function normalizedSemanticExecutionValue(
  key: SemanticExecutionConfigurationKey,
  value: string | undefined,
): string | number | boolean | null {
  const normalized = value?.trim() ?? "";
  if (key === "MUSICBRAINZ_CONTACT") {
    return musicBrainzContactConfigurationLabel(value);
  }
  if (!normalized) return null;
  if (SEMANTIC_EXECUTION_BOOLEAN_KEYS.has(key)) {
    if (normalized !== "true" && normalized !== "false") {
      throw new Error(`${key} must be true or false for semantic execution fencing`);
    }
    return normalized === "true";
  }
  if (SEMANTIC_EXECUTION_NUMERIC_KEYS.has(key)) {
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new Error(`${key} must be a finite non-negative number for semantic execution fencing`);
    }
    return Object.is(numeric, -0) ? 0 : numeric;
  }
  if (
    normalized.length > 256
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(`${key} is not a safe semantic execution label`);
  }
  return key === "APPLE_STOREFRONT" || key === "FAST_RESEARCH_SEARCH_CONTEXT"
    ? normalized.toLowerCase()
    : normalized;
}

export function semanticExecutionConfigurationHash(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const values = Object.fromEntries(
    SEMANTIC_EXECUTION_CONFIGURATION_ENV_KEYS_V1.map((key) => [
      key,
      normalizedSemanticExecutionValue(key, environment[key]),
    ]),
  );
  return sha256Hex(stableStringify({
    schemaVersion: SEMANTIC_EXECUTION_CONFIGURATION_SCHEMA_V1,
    values,
  }));
}

export const API_RELEASE_CONFIGURATION_ENV_KEYS = Object.freeze([
  "NODE_ENV",
  "APP_ORIGIN",
  "RELEASE_ENVIRONMENT",
  "RELEASE_DEPLOYMENT_PHASE",
  "RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION",
  "RELEASE_EXPECTED_DATABASE_CAPABILITY_VERSION",
  "RELEASE_EXPECTED_MANIFEST_CANARY_GUARDS_VERSION",
  "RELEASE_EXPECTED_CANONICAL_EXECUTION_HARDENING_VERSION",
  "RELEASE_EXPECTED_PROOF_ARCHITECTURE_VERSION",
  "RELEASE_STAGING_BOOTSTRAP_FRESH_EMPTY_DATABASE_CONFIRMED",
  "RELEASE_EXECUTION_ENABLED",
  "RELEASE_SECRET_VERSIONS_HASH",
  "RELEASE_VERIFIED_CANDIDATE_EVIDENCE_HASH",
  "RELEASE_BRIDGE_CONVERGENCE_EVIDENCE_HASH",
  "RELEASE_EXPAND_CONVERGENCE_EVIDENCE_HASH",
  "RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH",
  "RELEASE_PUBLIC_ROLLOUT_STAGE",
  "RELEASE_PUBLIC_ROLLOUT_OPERATION",
  "RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_HASH",
  "RELEASE_PUBLIC_ROLLOUT_INTENT_GROUP",
  "RELEASE_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_HASH",
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
  "PIPELINE_V3_PROOF_ARCHITECTURE_MODE",
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
] as const);

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
  const emittedQueryPlanSchemaVersion =
    queryPlanV3EmissionSchemaVersion(environment);
  const ownerAllowlistVersion = releaseOwnerAllowlistVersion(environment);
  const capabilityPepper = capabilityPepperRotationStatus(environment);
  return Object.freeze({
    pipelineVersion: "corpus_first_v3",
    semanticExecutionConfigurationHash:
      semanticExecutionConfigurationHash(environment),
    releaseEnvironment: releaseEnvironment(environment.RELEASE_ENVIRONMENT),
    ownerAllowlistVersion,
    capabilityPepperVersionHash: capabilityPepper.currentVersionHash,
    capabilityPreviousPepperVersionHash: capabilityPepper.previousVersionHash,
    deploymentPhase: runtimeReleaseDeploymentPhase(environment),
    expectedDatabaseSchemaVersion: expectedReleaseDatabaseSchemaVersion(environment),
    stagingBootstrapConfigured: stagingBootstrapConfigured(environment),
    executionEnabled: releaseExecutionConfigured(environment),
    canonicalActivationConfigured,
    proofArchitectureMode: proofArchitectureMode(environment),
    proofArchitectureVersion: SCHEMA_20_PROOF_ARCHITECTURE_VERSION,
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
      ? emittedQueryPlanSchemaVersion
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
      ? emittedQueryPlanSchemaVersion === 6
        ? ADAPTIVE_GUIDANCE_POLICY_VERSION_V4
        : ADAPTIVE_GUIDANCE_POLICY_VERSION
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
