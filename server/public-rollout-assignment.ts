import {
  PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
  PUBLIC_ROLLOUT_PERCENT_LADDER,
  validatePublicRolloutConfiguration,
  type PublicRolloutConfiguration,
  type PublicRolloutIntentGroup,
} from "../shared/public-rollout-evidence.ts";
import { signedArtifactSha256 } from "../shared/signed-artifact.ts";
import {
  validateV254DirectExposureConfigurationV1,
  validateV254DirectExposureRuntimeTransitionV1,
  type V254DirectExposureCandidateV1,
  type V254DirectExposureConfigurationV1,
  type V254DirectExposureRuntimeTransitionV1,
} from "../shared/v254-direct-exposure-authority.ts";
import { semanticExecutionConfigurationHash } from "./runtime-release.ts";
import {
  pipelineV3RolloutCohort,
  pipelineV3RolloutGroup,
  QUERY_PLAN_V3_POLICY_VERSION,
} from "./query-plan-v3.ts";
import { createRunSpecV3 } from "./selection-plan-v3.ts";
import { sha256Hex, stableStringify } from "./security.ts";

export const PUBLIC_ROLLOUT_ASSIGNMENT_VERSION =
  "signed_public_contract_rollout_v1";
export const V254_DIRECT_EXPOSURE_ASSIGNMENT_VERSION =
  "signed_public_direct_exposure_v1";

export function publicRolloutAssignmentStickyKeyV1(input: {
  owner: boolean;
  clientBucket: string;
  releaseCanary: {
    canaryId: string;
    environment: "staging" | "production";
    operation: "brief" | "run";
  } | null;
}): string | null {
  // Ordinary owner identity must not select a different canonical-contract
  // cohort from the same browser. A signed owner canary remains outside the
  // public assignment plane and is admitted by its explicit canary receipt.
  if (input.owner && input.releaseCanary !== null) return null;
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
  version:
    | typeof PUBLIC_ROLLOUT_ASSIGNMENT_VERSION
    | typeof V254_DIRECT_EXPOSURE_ASSIGNMENT_VERSION;
  rolloutEvidenceHash: string;
  rolloutStage: string;
  intentGroup: PublicRolloutIntentGroup;
  cohort: number;
  percentage: 0 | 1 | 10 | 50 | 100;
  assigned: boolean;
  assignmentHash: string;
}

export interface V254DirectExposureDatabaseAuthorityV1 {
  active: unknown;
}

export function publicRolloutAssignmentPausedV1(input: {
  assignment: PersistedPublicRolloutAssignmentV1 | null;
  classifiedIntentGroup?: PublicRolloutIntentGroup | null;
  signedCanary: boolean;
  publicAssignmentPaused: boolean;
  intentPublicAssignmentPaused?: boolean;
}): boolean {
  if (input.signedCanary) return false;
  // The route-wide pause only fences traffic that would otherwise be assigned
  // to V3. An intent pause is deliberately stricter: it fences the classified
  // request before contract selection even when the signed percentage is 0,
  // preventing an affected request from silently falling through to V2.
  return (
    input.classifiedIntentGroup !== null
    && input.classifiedIntentGroup !== undefined
    && input.intentPublicAssignmentPaused === true
  )
    || (
      input.assignment?.assigned === true
      && input.publicAssignmentPaused
  );
}

export type PublicRolloutAdmissionDispositionV1 =
  | "admit"
  | "hard_disabled"
  | "public_paused";

/**
 * Decide route admission before contract selection. The hard switch is
 * intentionally evaluated ahead of canary/public-pause semantics: no caller,
 * including a signed canary, may bypass a hard-disabled intent.
 */
export function publicRolloutAdmissionDispositionV1(input: {
  assignment: PersistedPublicRolloutAssignmentV1 | null;
  classifiedIntentGroup: PublicRolloutIntentGroup | null;
  signedCanary: boolean;
  hardSwitchDisabled: boolean;
  publicAssignmentPaused: boolean;
  intentPublicAssignmentPaused: boolean;
}): PublicRolloutAdmissionDispositionV1 {
  if (input.classifiedIntentGroup !== null && input.hardSwitchDisabled) {
    return "hard_disabled";
  }
  if (publicRolloutAssignmentPausedV1(input)) return "public_paused";
  return "admit";
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

/** Classify intent for admission controls without requiring rollout authority. */
export function publicRolloutIntentGroupForPromptV1(input: {
  prompt: string;
  requestedTrackCount: number;
  environment?: NodeJS.ProcessEnv;
}): PublicRolloutIntentGroup {
  const environment = input.environment ?? process.env;
  return pipelineV3RolloutGroup(createRunSpecV3({
    prompt: input.prompt,
    requestedTrackCount: input.requestedTrackCount,
    storefront: environment.APPLE_STOREFRONT ?? "us",
  }));
}

/**
 * Once a signed public rollout assignment exists, it is the sole authority
 * for choosing Contract 3. Broad environment flags are only a fallback for
 * authenticated release canaries outside the signed public rollout plane.
 * Ordinary owners remain in the public assignment cohort. This prevents a
 * zero-percent intent from being compiled as Contract 3 merely because
 * another intent enabled global V3 guidance.
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
  /^(?:editorial_influence|genre_scene|mood_activity_theme|similarity|artist_catalogue|fixed_container|factual_relationship|exhaustive):(0|1|10|50|100)->(0|1|10|50|100)$/u;
const GROUPS = new Set<PublicRolloutIntentGroup>([
  "editorial_influence",
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

export function publicRolloutAssignmentAuthoritySettingKeyV1(
  assignment: PersistedPublicRolloutAssignmentV1,
): string {
  return assignment.version === V254_DIRECT_EXPOSURE_ASSIGNMENT_VERSION
    ? `v254_direct_exposure_authority:${assignment.rolloutEvidenceHash}`
    : `public_rollout_authority:${assignment.rolloutEvidenceHash}`;
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
      intentGroup === "editorial_influence"
      || intentGroup === "genre_scene"
      || intentGroup === "mood_activity_theme"
      || intentGroup === "similarity"
    )
    && configuration.PIPELINE_V3_CURATED_HOSTED_EVIDENCE_APPROVED !== "true"
  ) {
    return false;
  }
  if (
    (intentGroup === "editorial_influence" || intentGroup === "genre_scene")
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

function parseV254DirectExposureDatabaseAuthorityV1(
  value: V254DirectExposureDatabaseAuthorityV1 | null | undefined,
): {
  state: "armed" | "active" | "rolled_back";
  authorityPayloadHash: string;
  rollbackWarrantPayloadHash: string;
  currentConfigurationHash: string;
  currentConfiguration: V254DirectExposureConfigurationV1;
  targetConfigurationHash: string;
  targetConfiguration: V254DirectExposureConfigurationV1;
  preconditionsHash: string;
  rollbackPlanHash: string;
  runtimeTransition: V254DirectExposureRuntimeTransitionV1;
} | null {
  if (!value) return null;
  const active = authorityRecord(value.active, "direct exposure active");
  if (
    active.schemaVersion
      !== "genio-v254-direct-exposure-database-authority/v1"
    || active.intentGroup !== "editorial_influence"
    || !["armed", "active", "rolled_back"].includes(
      String(active.state ?? ""),
    )
    || active.fromPercent !== "0"
    || active.toPercent !== "100"
    || active.exposureClass !== "fully_exposed_unproven"
    || active.organicReliabilityProven !== false
    || typeof active.candidateHash !== "string"
    || !SHA256.test(active.candidateHash)
    || typeof active.authorityPayloadHash !== "string"
    || !SHA256.test(active.authorityPayloadHash)
    || typeof active.rollbackWarrantPayloadHash !== "string"
    || !SHA256.test(active.rollbackWarrantPayloadHash)
    || typeof active.targetConfigurationHash !== "string"
    || !SHA256.test(active.targetConfigurationHash)
    || typeof active.currentConfigurationHash !== "string"
    || !SHA256.test(active.currentConfigurationHash)
    || typeof active.preconditionsHash !== "string"
    || !SHA256.test(active.preconditionsHash)
    || typeof active.rollbackPlanHash !== "string"
    || !SHA256.test(active.rollbackPlanHash)
  ) throw new Error("direct exposure database authority is invalid");
  const currentConfiguration = validateV254DirectExposureConfigurationV1(
    active.currentConfiguration,
  );
  const targetConfiguration = validateV254DirectExposureConfigurationV1(
    active.targetConfiguration,
  );
  if (
    signedArtifactSha256(targetConfiguration)
      !== active.targetConfigurationHash
    || signedArtifactSha256(currentConfiguration)
      !== active.currentConfigurationHash
    || currentConfiguration.PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT !== "0"
    || targetConfiguration.PIPELINE_V3_EDITORIAL_INFLUENCE_PERCENT !== "100"
  ) throw new Error("direct exposure target configuration is invalid");
  const runtimeTransition = validateV254DirectExposureRuntimeTransitionV1(
    active.runtimeTransition,
    active.candidate as V254DirectExposureCandidateV1,
    String(
      authorityRecord(
        active.runtimeTransition,
        "direct exposure runtime transition",
      ).preExposureSemanticConfigurationHash ?? "",
    ),
  );
  if (signedArtifactSha256(active.candidate) !== active.candidateHash) {
    throw new Error("direct exposure database candidate does not match");
  }
  for (const [intent, flag] of Object.entries(
    PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS,
  ) as Array<[PublicRolloutIntentGroup, keyof PublicRolloutConfiguration]>) {
    if (intent !== "editorial_influence" && targetConfiguration[flag] !== "0") {
      throw new Error("direct exposure changed an unrelated intent");
    }
  }
  return {
    state: active.state as "armed" | "active" | "rolled_back",
    authorityPayloadHash: active.authorityPayloadHash,
    rollbackWarrantPayloadHash: active.rollbackWarrantPayloadHash,
    currentConfigurationHash: active.currentConfigurationHash,
    currentConfiguration,
    targetConfigurationHash: active.targetConfigurationHash,
    targetConfiguration,
    preconditionsHash: active.preconditionsHash,
    rollbackPlanHash: active.rollbackPlanHash,
    runtimeTransition,
  };
}

export function publicRolloutDatabaseAuthorityActiveV1(
  value: PublicRolloutDatabaseAuthorityV1 | null | undefined,
): boolean {
  const authority = parsePublicRolloutDatabaseAuthorityV1(value);
  if (!authority) return false;
  return (Object.keys(PUBLIC_ROLLOUT_INTENT_PERCENT_FLAGS) as
    PublicRolloutIntentGroup[]).some(
      (intent) => rolloutPercentage(authority.targetConfiguration, intent) > 0,
    );
}

export function v254DirectExposureRuntimeDatabaseAuthorityV1(input: {
  environment?: NodeJS.ProcessEnv;
  databaseAuthority?: V254DirectExposureDatabaseAuthorityV1 | null;
}): {
  state: "armed" | "active" | "rolled_back";
  active: boolean;
  authorityPayloadHash: string;
  rollbackWarrantPayloadHash: string;
  stage: "editorial_influence:0->100:fully_exposed_unproven";
  targetConfigurationHash: string;
  exposureClass: "fully_exposed_unproven";
  organicReliabilityProven: false;
} | null {
  const environment = input.environment ?? process.env;
  const authority = parseV254DirectExposureDatabaseAuthorityV1(
    input.databaseAuthority,
  );
  const runtime = {
    preconditionsHash:
      environment.RELEASE_V254_DIRECT_EXPOSURE_PRECONDITIONS_HASH?.trim() ?? "",
    rollbackPlanHash:
      environment.RELEASE_V254_DIRECT_EXPOSURE_ROLLBACK_PLAN_HASH?.trim()
        ?? "",
    stage: environment.RELEASE_V254_DIRECT_EXPOSURE_STAGE?.trim() ?? "",
    targetConfigurationHash:
      environment.RELEASE_V254_DIRECT_EXPOSURE_TARGET_CONFIGURATION_HASH
        ?.trim() ?? "",
  };
  const present = Object.values(runtime).some(Boolean);
  if (!present && !authority) return null;
  const runtimeComplete = Object.values(runtime).every(Boolean);
  const expectedConfiguration = runtimeComplete
    ? authority?.targetConfiguration ?? null
    : (() => {
      if (!authority) return null;
      return authority.currentConfiguration;
    })();
  const runtimeMatchesSignedConfiguration = expectedConfiguration !== null
    && (Object.keys(expectedConfiguration) as Array<
      keyof PublicRolloutConfiguration
    >).every((key) => (
      (environment[key]?.trim() ?? "") === expectedConfiguration[key]
    ));
  if (
    !authority
    || environment.RELEASE_ENVIRONMENT !== "production"
    || environment.RELEASE_DEPLOYMENT_PHASE !== "activate"
    || (authority.state === "active" && !runtimeComplete)
    || (present && !runtimeComplete)
    || (runtimeComplete && (
      runtime.preconditionsHash !== authority.preconditionsHash
      || runtime.rollbackPlanHash !== authority.rollbackPlanHash
      || runtime.stage
        !== "editorial_influence:0->100:fully_exposed_unproven"
      || runtime.targetConfigurationHash !== authority.targetConfigurationHash
    ))
    || !runtimeMatchesSignedConfiguration
    || semanticExecutionConfigurationHash(environment)
      !== (authority.state === "active"
        ? authority.runtimeTransition.postExposureSemanticConfigurationHash
        : authority.runtimeTransition.preExposureSemanticConfigurationHash)
    || [
      environment.RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH,
      environment.RELEASE_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_HASH,
      environment.RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_HASH,
      environment.RELEASE_PUBLIC_ROLLOUT_STAGE,
    ].some((value) => (value?.trim() ?? "") !== "")
  ) throw new Error("direct exposure runtime does not match database authority");
  return {
    state: authority.state,
    active: authority.state === "active",
    authorityPayloadHash: authority.authorityPayloadHash,
    rollbackWarrantPayloadHash: authority.rollbackWarrantPayloadHash,
    stage: "editorial_influence:0->100:fully_exposed_unproven",
    targetConfigurationHash: authority.targetConfigurationHash,
    exposureClass: "fully_exposed_unproven",
    organicReliabilityProven: false,
  };
}

export function createV254DirectExposureAssignmentV1(input: {
  prompt: string;
  requestedTrackCount: number;
  stickyKey: string;
  environment?: NodeJS.ProcessEnv;
  databaseAuthority?: V254DirectExposureDatabaseAuthorityV1 | null;
}): PersistedPublicRolloutAssignmentV1 | null {
  const environment = input.environment ?? process.env;
  const authority = parseV254DirectExposureDatabaseAuthorityV1(
    input.databaseAuthority,
  );
  if (!authority || authority.state !== "active") return null;
  const preconditionsHash =
    environment.RELEASE_V254_DIRECT_EXPOSURE_PRECONDITIONS_HASH?.trim() ?? "";
  const rollbackPlanHash =
    environment.RELEASE_V254_DIRECT_EXPOSURE_ROLLBACK_PLAN_HASH?.trim()
      ?? "";
  const stage = environment.RELEASE_V254_DIRECT_EXPOSURE_STAGE?.trim() ?? "";
  const targetHash =
    environment.RELEASE_V254_DIRECT_EXPOSURE_TARGET_CONFIGURATION_HASH
      ?.trim() ?? "";
  if (
    environment.RELEASE_ENVIRONMENT !== "production"
    || environment.RELEASE_DEPLOYMENT_PHASE !== "activate"
    || preconditionsHash !== authority.preconditionsHash
    || rollbackPlanHash !== authority.rollbackPlanHash
    || targetHash !== authority.targetConfigurationHash
    || stage
      !== "editorial_influence:0->100:fully_exposed_unproven"
    || semanticExecutionConfigurationHash(environment)
      !== authority.runtimeTransition.postExposureSemanticConfigurationHash
    || [
      environment.RELEASE_PUBLIC_ROLLOUT_EVIDENCE_HASH,
      environment.RELEASE_PUBLIC_ROLLOUT_ROLLBACK_WARRANT_HASH,
      environment.RELEASE_PUBLIC_ROLLOUT_INTENT_CANARY_HASH,
      environment.RELEASE_PUBLIC_ROLLOUT_STAGE,
    ].some((value) => (value?.trim() ?? "") !== "")
  ) throw new Error("direct exposure runtime does not match database authority");
  const intentGroup = publicRolloutIntentGroupForPromptV1({
    prompt: input.prompt,
    requestedTrackCount: input.requestedTrackCount,
    environment,
  });
  if (intentGroup !== "editorial_influence") return null;
  const material: Omit<PersistedPublicRolloutAssignmentV1, "assignmentHash"> = {
    version: V254_DIRECT_EXPOSURE_ASSIGNMENT_VERSION,
    rolloutEvidenceHash: authority.authorityPayloadHash,
    rolloutStage: "editorial_influence:0->100",
    intentGroup,
    cohort: pipelineV3RolloutCohort(
      `${input.stickyKey}:${intentGroup}:${QUERY_PLAN_V3_POLICY_VERSION}`,
    ),
    percentage: 100,
    assigned: true,
  };
  return Object.freeze({
    ...material,
    assignmentHash: hashMaterial(material),
  });
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
  if (parsed?.version === V254_DIRECT_EXPOSURE_ASSIGNMENT_VERSION) {
    const direct = parseV254DirectExposureDatabaseAuthorityV1({
      active: record,
    });
    if (
      !direct
      || !parsed.assigned
      || parsed.intentGroup !== "editorial_influence"
      || parsed.percentage !== 100
      || direct.authorityPayloadHash !== parsed.rolloutEvidenceHash
    ) {
      throw new Error(
        "direct exposure assignment has no authoritative database lineage",
      );
    }
    return;
  }
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
  const intentGroup = publicRolloutIntentGroupForPromptV1({
    prompt: input.prompt,
    requestedTrackCount: input.requestedTrackCount,
    environment,
  });
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
    || (
      record.version !== PUBLIC_ROLLOUT_ASSIGNMENT_VERSION
      && record.version !== V254_DIRECT_EXPOSURE_ASSIGNMENT_VERSION
    )
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
    version: record.version as PersistedPublicRolloutAssignmentV1["version"],
    rolloutEvidenceHash: record.rolloutEvidenceHash,
    rolloutStage: record.rolloutStage,
    intentGroup: record.intentGroup as PublicRolloutIntentGroup,
    cohort: Number(record.cohort),
    percentage: Number(record.percentage) as 0 | 1 | 10 | 50 | 100,
    assigned: record.assigned,
  };
  if (
    (
      material.version === V254_DIRECT_EXPOSURE_ASSIGNMENT_VERSION
        ? material.intentGroup !== "editorial_influence"
          || material.percentage !== 100
          || material.assigned !== true
        : material.assigned !== (material.cohort < material.percentage * 100)
    )
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
