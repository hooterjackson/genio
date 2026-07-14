import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

const preserved = (names: readonly string[]) =>
  Object.fromEntries(names.map((name) => [name, preserve()]));

const apiVariables = preserved([
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
  "OPENAI_MODEL",
  "OPENAI_OUTPUT_USD_PER_MILLION",
  "OPENAI_WEB_SEARCH_USD",
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

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "us-west2" });
  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
    allowOnlineResize: true,
    region: "us-west2",
    sizeMB: 500,
  });
  const needleWorker = service("needle-worker", {
    source: github("hooterjackson/needle", { branch: "main" }),
    build: "pnpm run build:server",
    start: "pnpm run start:worker",
    deploy: {
      restartPolicyType: "ALWAYS",
      drainingSeconds: 30,
    },
    replicas: { "us-west2": 1 },
    variables: {
      ...workerVariables,
      DATABASE_URL: Postgres.env.DATABASE_URL,
    },
  });
  const needleApi = service("needle-api", {
    source: github("hooterjackson/needle", { branch: "main" }),
    build: "pnpm run build:server",
    preDeploy: "pnpm run db:migrate",
    start: "pnpm run start:api",
    healthcheck: "/health/ready",
    healthcheckTimeout: 120,
    deploy: {
      restartPolicyType: "ALWAYS",
      overlapSeconds: 30,
      drainingSeconds: 15,
    },
    replicas: { "us-west2": 1 },
    variables: {
      ...apiVariables,
      APP_ORIGIN: "https://needle.hooterjackson.chatgpt.site",
      DATABASE_URL: Postgres.env.DATABASE_URL,
    },
  });

  return project("needle", {
    environments: ["staging", "production"],
    resources: [needleWorker, needleApi, Postgres, postgresVolume],
  });
});
