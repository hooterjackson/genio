import { defineRailway, image, postgres, preserve, project, service, volume } from "railway/iac";
import {
  railwayReleasePhaseConfiguration,
  releasePhasePreDeployCommand,
} from "./release-phase.ts";

const releaseImage = process.env.GENIO_RELEASE_IMAGE?.trim() ?? "";
if (!/^ghcr\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/u.test(releaseImage)) {
  throw new Error(
    "GENIO_RELEASE_IMAGE must name the promoted immutable image as ghcr.io/<owner>/<image>@sha256:<digest>",
  );
}
const releaseRevision = process.env.GENIO_RELEASE_REVISION?.trim().toLowerCase() ?? "";
if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(releaseRevision)) {
  throw new Error(
    "GENIO_RELEASE_REVISION must be the full Git revision used to build the promoted image",
  );
}
const releaseVersion = process.env.GENIO_RELEASE_VERSION?.trim() ?? "";
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(releaseVersion)) {
  throw new Error(
    "GENIO_RELEASE_VERSION must be the stable semantic version embedded in the promoted image",
  );
}
const releasePhase = railwayReleasePhaseConfiguration(process.env);

const releaseIdentityVariables = {
  APP_VERSION: releaseVersion,
  SOURCE_COMMIT_SHA: releaseRevision,
  RELEASE_ENVIRONMENT: releasePhase.environment,
  RELEASE_DEPLOYMENT_PHASE: releasePhase.phase,
  RELEASE_EXPECTED_DATABASE_SCHEMA_VERSION: releasePhase.expectedDatabaseSchemaVersion,
  ...(releasePhase.verifiedCandidateEvidenceHash
    ? {
        RELEASE_VERIFIED_CANDIDATE_EVIDENCE_HASH:
          releasePhase.verifiedCandidateEvidenceHash,
      }
    : {}),
  ...(releasePhase.bridgeConvergenceEvidenceHash
    ? { RELEASE_BRIDGE_CONVERGENCE_EVIDENCE_HASH: releasePhase.bridgeConvergenceEvidenceHash }
    : {}),
  ...(releasePhase.expandConvergenceEvidenceHash
    ? { RELEASE_EXPAND_CONVERGENCE_EVIDENCE_HASH: releasePhase.expandConvergenceEvidenceHash }
    : {}),
  ...(releasePhase.staging
    ? { QA_STAGING_CONTROL_HASH: releasePhase.staging.controlHash }
    : {}),
} as const;

const stagingApiVariables = releasePhase.staging
  ? {
      APP_ORIGIN: releasePhase.staging.musicKitOrigin,
      APP_MONTHLY_COST_LIMIT_USD: String(releasePhase.staging.monthlyCostLimitUsd),
    }
  : {};

const stagingWorkerVariables = releasePhase.staging
  ? {
      APP_MONTHLY_COST_LIMIT_USD: String(releasePhase.staging.monthlyCostLimitUsd),
    }
  : {};

const promotedReleaseSource = () => image(releaseImage, {
  autoUpdates: { type: "disabled" },
});

const preserved = <const Names extends readonly string[]>(names: Names) =>
  Object.fromEntries(names.map((name) => [name, preserve()])) as {
    [Name in Names[number]]: ReturnType<typeof preserve>;
  };

const apiVariables = preserved([
  "APP_ORIGIN",
  "RETENTION_DAYS",
  "CAPABILITY_SESSION_TTL_DAYS",
  "NODE_ENV",
  "RESULT_REUSE_DAYS",
  "WORKER_STALE_SECONDS",
  "APPLE_SHARE_URL_TIMEOUT_SECONDS",
  "APPLE_TOKEN_DECRYPTION_KEYS_JSON",
  "AUTO_RUN_COST_LIMIT_USD",
  "LOG_LEVEL",
  "APPLE_STOREFRONT",
  "APPLE_TOKEN_ENCRYPTION_KEY_ID",
  "APP_MONTHLY_COST_LIMIT_USD",
  "BRIEF_LIMIT_PER_24H",
  "MAX_GLOBAL_NONTERMINAL_RUNS",
  "COST_TIMEZONE",
  "GATEWAY_KEY_ID",
  "GATEWAY_PREVIOUS_KEY_ID",
  "GATEWAY_PREVIOUS_HMAC_SECRET",
  "OWNER_EMAIL",
  "RUN_LIMIT_PER_24H",
  "APPLE_MUSICKIT_PRIVATE_KEY_BASE64",
  "APPLE_KEY_ID",
  "APPLE_MEDIA_ID",
  "APPLE_TEAM_ID",
  "CAPABILITY_PEPPER",
  "APPLE_TOKEN_ENCRYPTION_KEY",
  "GATEWAY_HMAC_SECRET",
  "RELEASE_CANARY_HMAC_SECRET",
  "RELEASE_ENVIRONMENT",
  "PIPELINE_V2_OWNER_CANARY",
  "PIPELINE_V2_CURATED_PERCENT",
  "PIPELINE_V2_SIMILARITY_PERCENT",
  "PIPELINE_V2_FACTUAL_OWNER_CANARY",
  "PIPELINE_V2_FACTUAL_PERCENT",
  "PIPELINE_V3_OWNER_CANARY",
  "PIPELINE_V3_OWNER_CANARY_GROUPS",
  "PIPELINE_V3_OWNER_CANARY_MAX_TRACKS",
  "PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED",
  "PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED",
  "PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED",
  "PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED",
  "PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED",
  "PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION",
  "GUIDANCE_CONTRACT_V2_ENABLED",
  "GUIDANCE_CONTRACT_V2_OWNER_CANARY",
  "GUIDANCE_CONTRACT_V3_ENABLED",
  "GUIDANCE_CONTRACT_V3_OWNER_CANARY",
  "GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED",
  "PIPELINE_V3_BASELINE_MODEL_ID",
  "PIPELINE_V3_ESCALATION_MODEL_ID",
  "PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT",
  "PIPELINE_V3_GENRE_SCENE_PERCENT",
  "PIPELINE_V3_MOOD_ACTIVITY_PERCENT",
  "PIPELINE_V3_SIMILARITY_PERCENT",
  "PIPELINE_V3_ARTIST_CATALOGUE_PERCENT",
  "PIPELINE_V3_FIXED_CONTAINER_PERCENT",
  "PIPELINE_V3_FACTUAL_PERCENT",
  "PIPELINE_V3_EXHAUSTIVE_PERCENT",
  "PIPELINE_V3_ASSIGNMENT_ENABLED",
] as const);

const workerVariables = preserved([
  "RESULT_REUSE_DAYS",
  "RETENTION_DAYS",
  "ALERT_EMAIL",
  "APPLE_SHARE_URL_TIMEOUT_SECONDS",
  "APPLE_STOREFRONT",
  "APPLE_TOKEN_DECRYPTION_KEYS_JSON",
  "APPLE_TOKEN_ENCRYPTION_KEY_ID",
  "APP_MONTHLY_COST_LIMIT_USD",
  "LOG_LEVEL",
  "AUTO_RUN_COST_LIMIT_USD",
  "COST_TIMEZONE",
  "MUSICBRAINZ_CONTACT",
  "NODE_ENV",
  "OPENAI_INPUT_USD_PER_MILLION",
  "OPENAI_LUNA_INPUT_USD_PER_MILLION",
  "OPENAI_LUNA_OUTPUT_USD_PER_MILLION",
  "OPENAI_TERRA_INPUT_USD_PER_MILLION",
  "OPENAI_TERRA_OUTPUT_USD_PER_MILLION",
  "OPENAI_BRIEF_MODEL",
  "OPENAI_FAST_MODEL",
  "OPENAI_DEEP_MODEL",
  "OPENAI_CURATED_LUNA_SNAPSHOT",
  "OPENAI_CURATED_TERRA_SNAPSHOT",
  "OPENAI_MODEL",
  "OPENAI_OUTPUT_USD_PER_MILLION",
  "OPENAI_WEB_SEARCH_USD",
  "OPENAI_MAX_BRIEF_RESERVATION_USD",
  "OPENAI_MAX_RESPONSE_RESERVATION_USD",
  "OPENAI_MIN_BRIEF_RESERVATION_USD",
  "OPENAI_MIN_RESPONSE_RESERVATION_USD",
  "OPENAI_RESUME_CONTEXT_FALLBACK_TOKENS",
  "PIPELINE_V2_OWNER_CANARY",
  "PIPELINE_V2_CURATED_PERCENT",
  "PIPELINE_V2_SIMILARITY_PERCENT",
  "PIPELINE_V2_FACTUAL_OWNER_CANARY",
  "PIPELINE_V2_FACTUAL_PERCENT",
  "PIPELINE_V3_BASELINE_MODEL_ID",
  "PIPELINE_V3_ESCALATION_MODEL_ID",
  "PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT",
  "PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED",
  "PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED",
  "PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED",
  "PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED",
  "PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED",
  "PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION",
  "GUIDANCE_CONTRACT_V2_ENABLED",
  "GUIDANCE_CONTRACT_V2_OWNER_CANARY",
  "GUIDANCE_CONTRACT_V3_ENABLED",
  "GUIDANCE_CONTRACT_V3_OWNER_CANARY",
  "GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED",
  "PIPELINE_V3_OWNER_CANARY",
  "PIPELINE_V3_OWNER_CANARY_GROUPS",
  "PIPELINE_V3_OWNER_CANARY_MAX_TRACKS",
  "PIPELINE_V3_ASSIGNMENT_ENABLED",
  "PIPELINE_V3_GENRE_SCENE_PERCENT",
  "PIPELINE_V3_MOOD_ACTIVITY_PERCENT",
  "PIPELINE_V3_SIMILARITY_PERCENT",
  "PIPELINE_V3_ARTIST_CATALOGUE_PERCENT",
  "PIPELINE_V3_FIXED_CONTAINER_PERCENT",
  "PIPELINE_V3_FACTUAL_PERCENT",
  "PIPELINE_V3_EXHAUSTIVE_PERCENT",
  "PIPELINE_V3_MAX_RAW_CANDIDATES",
  "PIPELINE_V3_MAX_ROUNDS",
  "PIPELINE_V3_MAX_TOOL_CALLS",
  "PIPELINE_V3_MAX_SEARCH_CALLS",
  "PIPELINE_V3_MAX_SYNTHESIS_TOKENS",
  "PIPELINE_V3_MAX_EXTRACTION_TOKENS",
  "WORKER_CONCURRENCY",
  "WORKER_HEARTBEAT_SECONDS",
  "WORKER_LEASE_SECONDS",
  "WORKER_POLL_MS",
  "WORKER_RENEW_SECONDS",
  "WORKER_STALE_SECONDS",
  "RESEARCH_TURNS_PER_SEGMENT",
  "RESEARCH_MAX_SEGMENTS_PER_PASS",
  "RESEARCH_MAX_GAP_PASSES",
  "FAST_RESEARCH_MAX_WEB_CALLS",
  "FAST_RESEARCH_MAX_SYNTHESIS_TOKENS",
  "FAST_RESEARCH_MAX_EXTRACTION_TOKENS",
  "FAST_RESEARCH_SEARCH_CONTEXT",
  "APPLE_MATCHING_CONCURRENCY",
  "FAST_MATCH_LOOKUP_TIMEOUT_MS",
  "APPLE_CATALOG_RECOVERY_TIMEOUT_MS",
  "OPENAI_API_KEY",
  "ENABLE_DISCOGS_ADAPTER",
  "DISCOGS_TOKEN",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "APPLE_MEDIA_ID",
  "APPLE_MUSICKIT_PRIVATE_KEY_BASE64",
  "APPLE_KEY_ID",
  "APPLE_TEAM_ID",
  "APPLE_TOKEN_ENCRYPTION_KEY",
] as const);

export default defineRailway((context) => {
  const selectedEnvironment = context.environmentName ?? context.environment;
  if (selectedEnvironment && selectedEnvironment !== releasePhase.environment) {
    throw new Error(
      `GENIO_RELEASE_ENVIRONMENT=${releasePhase.environment} does not match the selected Railway environment ${selectedEnvironment}`,
    );
  }
  const Postgres = postgres("Postgres", { region: "us-west2" });
  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
    allowOnlineResize: true,
    region: "us-west2",
    sizeMB: 500,
  });
  const needleWorker = service("needle-worker", {
    source: promotedReleaseSource(),
    start: "pnpm run start:worker",
    deploy: {
      drainingSeconds: 30,
    },
    replicas: { "us-west2": 1 },
    variables: {
      ...workerVariables,
      ...releaseIdentityVariables,
      ...stagingWorkerVariables,
      DATABASE_URL: Postgres.env.DATABASE_URL,
      WORKER_CONCURRENCY: "2",
      WORKER_QUEUE_CLASS: "interactive",
    },
  });
  const needleDeepWorker = service("needle-deep-worker", {
    source: promotedReleaseSource(),
    start: "pnpm run start:worker",
    deploy: {
      drainingSeconds: 30,
    },
    replicas: { "us-west2": 1 },
    variables: {
      ...releaseIdentityVariables,
      ...stagingWorkerVariables,
      DATABASE_URL: Postgres.env.DATABASE_URL,
      NODE_ENV: needleWorker.env.NODE_ENV,
      LOG_LEVEL: needleWorker.env.LOG_LEVEL,
      COST_TIMEZONE: needleWorker.env.COST_TIMEZONE,
      APP_MONTHLY_COST_LIMIT_USD: needleWorker.env.APP_MONTHLY_COST_LIMIT_USD,
      AUTO_RUN_COST_LIMIT_USD: needleWorker.env.AUTO_RUN_COST_LIMIT_USD,
      OPENAI_API_KEY: needleWorker.env.OPENAI_API_KEY,
      OPENAI_INPUT_USD_PER_MILLION: needleWorker.env.OPENAI_INPUT_USD_PER_MILLION,
      OPENAI_LUNA_INPUT_USD_PER_MILLION: needleWorker.env.OPENAI_LUNA_INPUT_USD_PER_MILLION,
      OPENAI_LUNA_OUTPUT_USD_PER_MILLION: needleWorker.env.OPENAI_LUNA_OUTPUT_USD_PER_MILLION,
      OPENAI_TERRA_INPUT_USD_PER_MILLION: needleWorker.env.OPENAI_TERRA_INPUT_USD_PER_MILLION,
      OPENAI_TERRA_OUTPUT_USD_PER_MILLION: needleWorker.env.OPENAI_TERRA_OUTPUT_USD_PER_MILLION,
      OPENAI_OUTPUT_USD_PER_MILLION: needleWorker.env.OPENAI_OUTPUT_USD_PER_MILLION,
      OPENAI_WEB_SEARCH_USD: needleWorker.env.OPENAI_WEB_SEARCH_USD,
      OPENAI_MODEL: needleWorker.env.OPENAI_MODEL,
      OPENAI_FAST_MODEL: needleWorker.env.OPENAI_FAST_MODEL,
      OPENAI_DEEP_MODEL: needleWorker.env.OPENAI_DEEP_MODEL,
      PIPELINE_V3_BASELINE_MODEL_ID: needleWorker.env.PIPELINE_V3_BASELINE_MODEL_ID,
      PIPELINE_V3_ESCALATION_MODEL_ID: needleWorker.env.PIPELINE_V3_ESCALATION_MODEL_ID,
      PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT:
        needleWorker.env.PIPELINE_V3_MODEL_CATALOG_VALIDATED_AT,
      PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED:
        needleWorker.env.PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED,
      PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED:
        needleWorker.env.PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED,
      PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED:
        needleWorker.env.PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED,
      PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED:
        needleWorker.env.PIPELINE_V3_GEOGRAPHIC_SCOPE_EVIDENCE_APPROVED,
      PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED:
        needleWorker.env.PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED,
      PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION:
        needleWorker.env.PIPELINE_V3_QUERY_PLAN_SCHEMA_VERSION,
      GUIDANCE_CONTRACT_V2_ENABLED: needleWorker.env.GUIDANCE_CONTRACT_V2_ENABLED,
      GUIDANCE_CONTRACT_V2_OWNER_CANARY: needleWorker.env.GUIDANCE_CONTRACT_V2_OWNER_CANARY,
      GUIDANCE_CONTRACT_V3_ENABLED: needleWorker.env.GUIDANCE_CONTRACT_V3_ENABLED,
      GUIDANCE_CONTRACT_V3_OWNER_CANARY: needleWorker.env.GUIDANCE_CONTRACT_V3_OWNER_CANARY,
      GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED:
        needleWorker.env.GUIDANCE_CONTRACT_V3_REGGAETON_ENABLED,
      PIPELINE_V2_OWNER_CANARY: needleWorker.env.PIPELINE_V2_OWNER_CANARY,
      PIPELINE_V2_CURATED_PERCENT: needleWorker.env.PIPELINE_V2_CURATED_PERCENT,
      PIPELINE_V2_SIMILARITY_PERCENT: needleWorker.env.PIPELINE_V2_SIMILARITY_PERCENT,
      PIPELINE_V2_FACTUAL_OWNER_CANARY:
        needleWorker.env.PIPELINE_V2_FACTUAL_OWNER_CANARY,
      PIPELINE_V2_FACTUAL_PERCENT: needleWorker.env.PIPELINE_V2_FACTUAL_PERCENT,
      PIPELINE_V3_OWNER_CANARY: needleWorker.env.PIPELINE_V3_OWNER_CANARY,
      PIPELINE_V3_OWNER_CANARY_GROUPS: needleWorker.env.PIPELINE_V3_OWNER_CANARY_GROUPS,
      PIPELINE_V3_OWNER_CANARY_MAX_TRACKS:
        needleWorker.env.PIPELINE_V3_OWNER_CANARY_MAX_TRACKS,
      PIPELINE_V3_GENRE_SCENE_PERCENT: needleWorker.env.PIPELINE_V3_GENRE_SCENE_PERCENT,
      PIPELINE_V3_MOOD_ACTIVITY_PERCENT:
        needleWorker.env.PIPELINE_V3_MOOD_ACTIVITY_PERCENT,
      PIPELINE_V3_SIMILARITY_PERCENT: needleWorker.env.PIPELINE_V3_SIMILARITY_PERCENT,
      PIPELINE_V3_ARTIST_CATALOGUE_PERCENT:
        needleWorker.env.PIPELINE_V3_ARTIST_CATALOGUE_PERCENT,
      PIPELINE_V3_FIXED_CONTAINER_PERCENT:
        needleWorker.env.PIPELINE_V3_FIXED_CONTAINER_PERCENT,
      PIPELINE_V3_FACTUAL_PERCENT: needleWorker.env.PIPELINE_V3_FACTUAL_PERCENT,
      PIPELINE_V3_EXHAUSTIVE_PERCENT: needleWorker.env.PIPELINE_V3_EXHAUSTIVE_PERCENT,
      PIPELINE_V3_MAX_RAW_CANDIDATES: needleWorker.env.PIPELINE_V3_MAX_RAW_CANDIDATES,
      PIPELINE_V3_MAX_ROUNDS: needleWorker.env.PIPELINE_V3_MAX_ROUNDS,
      PIPELINE_V3_MAX_TOOL_CALLS: needleWorker.env.PIPELINE_V3_MAX_TOOL_CALLS,
      PIPELINE_V3_MAX_SEARCH_CALLS: needleWorker.env.PIPELINE_V3_MAX_SEARCH_CALLS,
      PIPELINE_V3_MAX_SYNTHESIS_TOKENS: needleWorker.env.PIPELINE_V3_MAX_SYNTHESIS_TOKENS,
      PIPELINE_V3_MAX_EXTRACTION_TOKENS: needleWorker.env.PIPELINE_V3_MAX_EXTRACTION_TOKENS,
      MUSICBRAINZ_CONTACT: needleWorker.env.MUSICBRAINZ_CONTACT,
      ENABLE_DISCOGS_ADAPTER: needleWorker.env.ENABLE_DISCOGS_ADAPTER,
      DISCOGS_TOKEN: needleWorker.env.DISCOGS_TOKEN,
      APPLE_STOREFRONT: needleWorker.env.APPLE_STOREFRONT,
      APPLE_TEAM_ID: needleWorker.env.APPLE_TEAM_ID,
      APPLE_KEY_ID: needleWorker.env.APPLE_KEY_ID,
      APPLE_MEDIA_ID: needleWorker.env.APPLE_MEDIA_ID,
      APPLE_MUSICKIT_PRIVATE_KEY_BASE64: needleWorker.env.APPLE_MUSICKIT_PRIVATE_KEY_BASE64,
      APPLE_MATCHING_CONCURRENCY: needleWorker.env.APPLE_MATCHING_CONCURRENCY,
      FAST_MATCH_LOOKUP_TIMEOUT_MS: needleWorker.env.FAST_MATCH_LOOKUP_TIMEOUT_MS,
      APPLE_CATALOG_RECOVERY_TIMEOUT_MS: needleWorker.env.APPLE_CATALOG_RECOVERY_TIMEOUT_MS,
      PIPELINE_V3_ASSIGNMENT_ENABLED: needleWorker.env.PIPELINE_V3_ASSIGNMENT_ENABLED,
      WORKER_CONCURRENCY: "1",
      WORKER_QUEUE_CLASS: "deep",
    },
  });
  const needleApi = service("needle-api", {
    source: promotedReleaseSource(),
    ...(releasePhasePreDeployCommand(releasePhase)
      ? { preDeploy: releasePhasePreDeployCommand(releasePhase) }
      : {}),
    start: "pnpm run start:api",
    healthcheck: "/health/ready",
    healthcheckTimeout: 120,
    deploy: {
      overlapSeconds: 30,
      drainingSeconds: 15,
    },
    replicas: { "us-west2": 1 },
    variables: {
      ...apiVariables,
      ...releaseIdentityVariables,
      ...stagingApiVariables,
      DATABASE_URL: Postgres.env.DATABASE_URL,
    },
  });

  return project("needle", {
    environments: ["staging", "production"],
    resources: [needleWorker, needleDeepWorker, needleApi, Postgres, postgresVolume],
  });
});
