import {
  PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
  PUBLIC_ROLLOUT_PERCENT_LADDER,
  validatePublicRolloutConfiguration,
  type PublicRolloutConfiguration,
  type PublicRolloutIntentGroup,
} from "../shared/public-rollout-evidence.ts";
import { signedArtifactSha256 } from "../shared/signed-artifact.ts";
import {
  pipelineV3RolloutCohort,
  pipelineV3RolloutGroup,
  QUERY_PLAN_V3_POLICY_VERSION,
} from "./query-plan-v3.ts";
import { createRunSpecV3 } from "./selection-plan-v3.ts";
import { sha256Hex, stableStringify } from "./security.ts";

export const PUBLIC_ROLLOUT_ASSIGNMENT_VERSION =
  "signed_public_contract_rollout_v1";

export function publicRolloutAssignmentStickyKeyV1(input: {
  owner: boolean;
  clientBucket: string;
  releaseCanary: {
    canaryId: string;
    environment: "staging" | "production";
    operation: "brief" | "run";
  } | null;
}): string | null {
  if (input.owner) return null;
  if (input.releaseCanary === null) return input.clientBucket;
  if (
    input.releaseCanary.environment === "production"
    && input.releaseCanary.operation === "brief"
    && /^[0-9A-Za-z][0-9A-Za-z._-]{2,63}$/u.test(
      input.releaseCanary.canaryId,
    )
  ) {
    return `release-canary:${input.releaseCanary.canaryId}`;
  }
  return null;
}

export interface PersistedPublicRolloutAssignmentV1 {
  version: typeof PUBLIC_ROLLOUT_ASSIGNMENT_VERSION;
  rolloutEvidenceHash: string;
  rolloutStage: string;
  intentGroup: PublicRolloutIntentGroup;
  cohort: number;
  percentage: 0 | 1 | 10 | 50 | 100;
  assigned: boolean;
  assignmentHash: string;
}

export interface PublicRolloutDatabaseAuthorityV1 {
  global: unknown;
  intents: Partial<Record<PublicRolloutIntentGroup, unknown>>;
}

interface ParsedPublicRolloutDatabaseAuthorityV1 {
  evidenceHash: string;
  rollbackWarrantHash: string;
  intentCanaryHash: string;
  stage: string;
  targetConfigurationHash: string;
  targetConfiguration: PublicRolloutConfiguration;
}

export interface PublicRolloutRuntimeDatabaseAuthorityV1 {
  evidenceHash: string;
  stage: string;
  targetConfigurationHash: string;
}

/**
 * Once a signed public rollout assignment exists, it is the sole authority
 * for choosing Contract 3. Broad environment flags are only a fallback for
 * callers outside the signed rollout plane (owners, staging, and release
 * canaries). This prevents a zero-percent intent from being compiled as
 * Contract 3 merely because another intent enabled global V3 guidance.
 */
export function publicRolloutCanonicalContractRequestedV1(input: {
  assignment: PersistedPublicRolloutAssignmentV1 | null;
  fallbackRequested: boolean;
}): boolean {
  return input.assignment === null
    ? input.fallbackRequested
    : input.assignment.assigned;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const STAGE =
  /^(?:genre_scene|mood_activity_theme|similarity|artist_catalogue|fixed_container|factual_relationship|exhaustive):(0|1|10|50|100)->(0|1|10|50|100)$/u;
const GROUPS = new Set<PublicRolloutIntentGroup>([
  "genre_scene",
  "mood_activity_theme",
  "similarity",
  "artist_catalogue",
  "fixed_container",
  "factual_relationship",
  "exhaustive",
]);

function hashMaterial(
  value: Omit<PersistedPublicRolloutAssignmentV1, "assignmentHash">,
): string {
  return sha256Hex(stableStringify(value));
}

function rolloutPercentage(
  configuration: PublicRolloutConfiguration,
  intentGroup: PublicRolloutIntentGroup,
): 0 | 1 | 10 | 50 | 100 {
  const raw = configuration[
    PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS[intentGroup]
  ];
  if (!(PUBLIC_ROLLOUT_PERCENT_LADDER as readonly string[]).includes(raw)) {
    throw new Error("signed public rollout contains an unsupported percentage");
  }
  return Number(raw) as 0 | 1 | 10 | 50 | 100;
}

function publicRolloutConfigurationReady(
  configuration: PublicRolloutConfiguration,
  intentGroup: PublicRolloutIntentGroup,
): boolean {
  if (
    configuration.PIPELINE_V3_ASSIGNMENT_ENABLED !== "true"
    || configuration.PIPELINE_V3_PRODUCTION_EVIDENCE_APPROVED !== "true"
  ) {
    return false;
  }
  if (
    (
      intentGroup === "genre_scene"
      || intentGroup === "mood_activity_theme"
      || intentGroup === "similarity"
    )
    && configuration.PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED !== "true"
  ) {
    return false;
  }
  if (
    intentGroup === "genre_scene"
    && configuration.PIPELINE_V3_GENRE_SCENE_EVIDENCE_APPROVED !== "true"
  ) {
    return false;
  }
  if (
    (intentGroup === "factual_relationship" || intentGroup === "exhaustive")
    && configuration.PIPELINE_V3_FACTUAL_FEASIBILITY_APPROVED !== "true"
  ) {
    return false;
  }
  return true;
}

function authorityRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`public rollout ${label} database authority is invalid`);
  }
  return value as Record<string, unknown>;
}

export function parsePublicRolloutDatabaseAuthorityV1(
  value: PublicRolloutDatabaseAuthorityV1 | null | undefined,
): ParsedPublicRolloutDatabaseAuthorityV1 | null {
  if (!value) return null;
  const global = authorityRecord(value.global, "global");
  if (
    global.schemaVersion !== "genio-public-rollout-database-authority/v1"
    || typeof global.evidenceHash !== "string"
    || !SHA256.test(global.evidenceHash)
    || typeof global.rollbackWarrantHash !== "string"
    || !SHA256.test(global.rollbackWarrantHash)
    || typeof global.intentCanaryHash !== "string"
    || !SHA256.test(global.intentCanaryHash)
    || typeof global.stage !== "string"
    || !STAGE.test(global.stage)
    || typeof global.targetConfigurationHash !== "string"
    || !SHA256.test(global.targetConfigurationHash)
  ) {
    throw new Error("public rollout global database authority is invalid");
  }
  const targetConfiguration = validatePublicRolloutConfiguration(
    global.targetConfiguration,
  );
  const stage = STAGE.exec(global.stage as string);
  if (
    !stage
    || global.intentGroup !== stage[0]!.split(":")[0]
    || global.toPercent !== stage[2]
    || !Object.hasOwn(
      PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
      String(global.intentGroup),
    )
    || targetConfiguration[
      PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS[
        global.intentGroup as PublicRolloutIntentGroup
      ]
    ] !== stage[2]
  ) {
    throw new Error(
      "public rollout database stage does not match its signed target",
    );
  }
  if (
    signedArtifactSha256(targetConfiguration)
      !== global.targetConfigurationHash
  ) {
    throw new Error(
      "public rollout database target configuration hash does not match",
    );
  }
  for (const [intentGroup, flag] of Object.entries(
    PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
  ) as Array<
    [PublicRolloutIntentGroup, keyof PublicRolloutConfiguration]
  >) {
    const percentage = targetConfiguration[flag];
    const intent = value.intents[intentGroup];
    if (percentage === "0" && intent === undefined) continue;
    const record = authorityRecord(intent, `intent ${intentGroup}`);
    if (
      record.schemaVersion !== "genio-public-rollout-database-authority/v1"
      || record.intentGroup !== intentGroup
      || record.toPercent !== percentage
      || typeof record.evidenceHash !== "string"
      || !SHA256.test(record.evidenceHash)
      || typeof record.intentCanaryHash !== "string"
      || !SHA256.test(record.intentCanaryHash)
    ) {
      throw new Error(
        `public rollout ${intentGroup} database lineage does not match its signed target`,
      );
    }
  }
  return Object.freeze({
    evidenceHash: global.evidenceHash,
    rollbackWarrantHash: global.rollbackWarrantHash,
    intentCanaryHash: global.intentCanaryHash,
    stage: global.stage,
    targetConfigurationHash: global.targetConfigurationHash,
    targetConfiguration,
  });
}

/**
 * Bind the public runtime markers to the atomically persisted rollout
 * authority. This is intentionally stricter than cohort selection: a stale
 * database row, a partially applied Railway variable set, or an authority
 * present in only one plane makes release health fail closed.
 */
export function publicRolloutRuntimeDatabaseAuthorityV1(input: {
  environment?: NodeJS.ProcessEnv;
  databaseAuthority?: PublicRolloutDatabaseAuthorityV1 | null;
}): PublicRolloutRuntimeDatabaseAuthorityV1 | null {
  const environment = input.environment ?? process.env;
  const deploymentPhase = environment.RELEASE_DEPLOYMENT_PHASE?.trim() ?? "";
  // Bridge and expand deliberately preserve the last signed rollout markers
  // and database authority so rollback lineage is not destroyed during a
  // forward-only schema migration. They are inert until the exact candidate
  // reaches activate; treating preserved authority as active here would make
  // every post-rollout bridge fail its own system-health gate.
  if (deploymentPhase === "bridge" || deploymentPhase === "expand") {
    return null;
  }
  const runtime = {
    evidenceHash:
      environment.RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH?.trim() ?? "",
    rollbackWarrantHash:
      environment.RELEASE_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_HASH?.trim() ?? "",
    intentCanaryHash:
      environment.RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_HASH?.trim() ?? "",
    stage: environment.RELEASE_PUBLIC_ROLLOUT_STAGE?.trim() ?? "",
  };
  const runtimePresent = Object.values(runtime).some((value) => value !== "");
  const authority = parsePublicRolloutDatabaseAuthorityV1(
    input.databaseAuthority,
  );
  if (!runtimePresent && authority === null) return null;
  if (
    environment.RELEASE_ENVIRONMENT !== "production"
    || deploymentPhase !== "activate"
    || !SHA256.test(runtime.evidenceHash)
    || !SHA256.test(runtime.rollbackWarrantHash)
    || !SHA256.test(runtime.intentCanaryHash)
    || !STAGE.test(runtime.stage)
    || authority === null
    || runtime.evidenceHash !== authority.evidenceHash
    || runtime.rollbackWarrantHash !== authority.rollbackWarrantHash
    || runtime.intentCanaryHash !== authority.intentCanaryHash
    || runtime.stage !== authority.stage
  ) {
    throw new Error(
      "public rollout runtime identity does not match its database authority",
    );
  }
  return Object.freeze({
    evidenceHash: authority.evidenceHash,
    stage: authority.stage,
    targetConfigurationHash: authority.targetConfigurationHash,
  });
}

export function assertPublicRolloutAssignmentDatabaseAuthorityV1(
  assignment: PersistedPublicRolloutAssignmentV1,
  value: unknown,
): void {
  const parsed = parsePublicRolloutAssignmentV1(assignment);
  const record = authorityRecord(value, "historical");
  if (
    !parsed
    || !parsed.assigned
    || record.schemaVersion !== "genio-public-rollout-database-authority/v1"
    || record.evidenceHash !== parsed.rolloutEvidenceHash
    || typeof record.rollbackWarrantHash !== "string"
    || !SHA256.test(record.rollbackWarrantHash)
    || typeof record.intentCanaryHash !== "string"
    || !SHA256.test(record.intentCanaryHash)
    || record.stage !== parsed.rolloutStage
    || typeof record.targetConfigurationHash !== "string"
    || !SHA256.test(record.targetConfigurationHash)
  ) {
    throw new Error("public rollout assignment has no authoritative database lineage");
  }
  const configuration = validatePublicRolloutConfiguration(
    record.targetConfiguration,
  );
  if (
    signedArtifactSha256(configuration) !== record.targetConfigurationHash
    || rolloutPercentage(configuration, parsed.intentGroup)
      !== parsed.percentage
    || !publicRolloutConfigurationReady(configuration, parsed.intentGroup)
  ) {
    throw new Error("public rollout assignment disagrees with its signed database target");
  }
}

/**
 * Decide the canonical public route before brief compilation. This exact
 * sticky decision is persisted with the brief and is the sole public rollout
 * authority at run creation; downstream model interpretation cannot reshuffle
 * a caller between control and V3.
 */
export function createPublicRolloutAssignmentV1(input: {
  prompt: string;
  requestedTrackCount: number;
  stickyKey: string;
  environment?: NodeJS.ProcessEnv;
  databaseAuthority?: PublicRolloutDatabaseAuthorityV1 | null;
}): PersistedPublicRolloutAssignmentV1 | null {
  const environment = input.environment ?? process.env;
  const authority = parsePublicRolloutDatabaseAuthorityV1(
    input.databaseAuthority,
  );
  if (!authority) return null;
  const rolloutEvidenceHash =
    environment.RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH?.trim() ?? "";
  const rolloutStage = environment.RELEASE_PUBLIC_ROLLOUT_STAGE?.trim() ?? "";
  const rollbackWarrantHash =
    environment.RELEASE_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_HASH?.trim() ?? "";
  const intentCanaryHash =
    environment.RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_HASH?.trim() ?? "";
  if (!rolloutEvidenceHash && !rolloutStage) return null;
  if (
    environment.RELEASE_ENVIRONMENT !== "production"
    || environment.RELEASE_DEPLOYMENT_PHASE !== "activate"
    || rolloutEvidenceHash !== authority.evidenceHash
    || rollbackWarrantHash !== authority.rollbackWarrantHash
    || intentCanaryHash !== authority.intentCanaryHash
    || rolloutStage !== authority.stage
  ) {
    throw new Error(
      "public rollout runtime identity does not match its database authority",
    );
  }
  const preliminary = createRunSpecV3({
    prompt: input.prompt,
    requestedTrackCount: input.requestedTrackCount,
    storefront: environment.APPLE_STOREFRONT ?? "us",
  });
  const intentGroup = pipelineV3RolloutGroup(preliminary);
  const percentage = publicRolloutConfigurationReady(
    authority.targetConfiguration,
    intentGroup,
  )
    ? rolloutPercentage(authority.targetConfiguration, intentGroup)
    : 0;
  const cohort = pipelineV3RolloutCohort(
    `${input.stickyKey}:${intentGroup}:${QUERY_PLAN_V3_POLICY_VERSION}`,
  );
  const material: Omit<
    PersistedPublicRolloutAssignmentV1,
    "assignmentHash"
  > = {
    version: PUBLIC_ROLLOUT_ASSIGNMENT_VERSION,
    rolloutEvidenceHash,
    rolloutStage,
    intentGroup,
    cohort,
    percentage,
    assigned: cohort < percentage * 100,
  } as const;
  return Object.freeze({
    ...material,
    assignmentHash: hashMaterial(material),
  });
}

export function parsePublicRolloutAssignmentV1(
  value: unknown,
): PersistedPublicRolloutAssignmentV1 | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("persisted public rollout assignment is invalid");
  }
  const record = value as Record<string, unknown>;
  const expected = [
    "version",
    "rolloutEvidenceHash",
    "rolloutStage",
    "intentGroup",
    "cohort",
    "percentage",
    "assigned",
    "assignmentHash",
  ].sort();
  const actual = Object.keys(record).sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
    || record.version !== PUBLIC_ROLLOUT_ASSIGNMENT_VERSION
    || typeof record.rolloutEvidenceHash !== "string"
    || !SHA256.test(record.rolloutEvidenceHash)
    || typeof record.rolloutStage !== "string"
    || !STAGE.test(record.rolloutStage)
    || typeof record.intentGroup !== "string"
    || !GROUPS.has(record.intentGroup as PublicRolloutIntentGroup)
    || !Number.isSafeInteger(record.cohort)
    || Number(record.cohort) < 0
    || Number(record.cohort) > 9_999
    || ![0, 1, 10, 50, 100].includes(Number(record.percentage))
    || typeof record.assigned !== "boolean"
    || typeof record.assignmentHash !== "string"
    || !SHA256.test(record.assignmentHash)
  ) {
    throw new Error("persisted public rollout assignment is invalid");
  }
  const material: Omit<
    PersistedPublicRolloutAssignmentV1,
    "assignmentHash"
  > = {
    version: PUBLIC_ROLLOUT_ASSIGNMENT_VERSION,
    rolloutEvidenceHash: record.rolloutEvidenceHash,
    rolloutStage: record.rolloutStage,
    intentGroup: record.intentGroup as PublicRolloutIntentGroup,
    cohort: Number(record.cohort),
    percentage: Number(record.percentage) as 0 | 1 | 10 | 50 | 100,
    assigned: record.assigned,
  };
  if (
    material.assigned !== (material.cohort < material.percentage * 100)
    || record.assignmentHash !== hashMaterial(material)
  ) {
    throw new Error("persisted public rollout assignment hash does not match");
  }
  return Object.freeze({
    ...material,
    assignmentHash: record.assignmentHash,
  });
}

export function assertPublicRolloutExecutionGroupV1(
  assignment: PersistedPublicRolloutAssignmentV1 | null,
  confirmedIntentGroup: PublicRolloutIntentGroup,
): void {
  if (
    assignment?.assigned
    && assignment.intentGroup !== confirmedIntentGroup
  ) {
    throw new Error(
      "public_rollout_confirmed_intent_changed_requires_successor",
    );
  }
}

export function assertPublicRolloutExecutionEligibilityV1(
  assignment: PersistedPublicRolloutAssignmentV1 | null,
  currentAssignmentReason: string,
): void {
  if (
    assignment?.assigned
    && currentAssignmentReason !== "sticky_rollout"
    && currentAssignmentReason !== "control"
  ) {
    throw new Error(
      `public_rollout_confirmed_capability_not_certified:${currentAssignmentReason}`,
    );
  }
}
