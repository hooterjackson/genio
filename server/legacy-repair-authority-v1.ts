import { sha256Hex, stableStringify } from "./security.ts";

export const LEGACY_REPAIR_AUTHORITY_VERSION_V1 =
  "legacy_repair_authority_v1" as const;
export const LEGACY_REPAIR_AUTHORITY_PHASE_V1 =
  "legacy_repair_authority_v1" as const;
export const LEGACY_REPAIR_CONSUMPTION_VERSION_V1 =
  "legacy_repair_authority_consumption_v1" as const;
export const LEGACY_REPAIR_CONSUMPTION_PHASE_V1 =
  "legacy_repair_authority_consumption_v1" as const;
export const LEGACY_REPAIR_RUN_ADMISSION_VERSION_V1 =
  "legacy_repair_run_admission_v1" as const;
export const LEGACY_REPAIR_RUN_ADMISSION_PHASE_V1 =
  "legacy_repair_run_admission_v1" as const;

const AUTHORITY_HASH_DOMAIN = "genio-legacy-repair-authority/v1";
const CONSUMPTION_HASH_DOMAIN = "genio-legacy-repair-consumption/v1";
const RUN_ADMISSION_HASH_DOMAIN = "genio-legacy-repair-run-admission/v1";
const MAXIMUM_AUTHORITY_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const SHA256 = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN = /^[0-9A-Za-z][0-9A-Za-z._:/-]{0,159}$/u;

export interface LegacyRepairAuthorityV1 {
  readonly version: typeof LEGACY_REPAIR_AUTHORITY_VERSION_V1;
  /** This receipt authorizes a new successor; it never attests old admission. */
  readonly provenanceKind: "forward_owner_repair_not_historical_admission";
  readonly authorizationKind: "authenticated_owner_control_plane";
  readonly sourceRunId: string;
  readonly sourceAccessId: string;
  readonly sourceBriefRequestId: string;
  readonly sourceResolutionGeneration: number;
  readonly sourceResolutionState: "quarantined";
  readonly sourceRunStatus: "failed_integrity";
  readonly sourceRunPhase: "v254_evidence_persistence_quarantined";
  readonly incidentReference: string;
  readonly sourceContractRevisionId: string;
  readonly sourceContractSemanticHash: string;
  readonly sourceContractStatus: "active";
  readonly sourceQueryPlanRevisionId: string;
  readonly sourceQueryPlanHash: string;
  readonly sourceQueryPlanSchema: number;
  readonly sourceExecutionRoute: "corpus_first_v3";
  readonly sourceReleaseRevision: string;
  readonly sourceExecutorSemanticConfigurationHash: string;
  readonly sourcePublicAssignmentPresent: false;
  readonly sourceRouteReceiptPresent: false;
  readonly sourceReleaseCanaryMarkerPresent: false;
  readonly containmentReceiptHash: string;
  readonly targetTrafficClass: "replay";
  readonly targetSuccessorKind: "v5_1_planning_successor";
  readonly targetGuidanceVersion: "adaptive_guidance_v5";
  readonly targetExecutionRoute: "corpus_first_v3";
  readonly targetIntentGroup: "editorial_influence";
  readonly repairReleaseRevision: string;
  readonly repairExecutorSemanticConfigurationHash: string;
  readonly resultReuse: false;
  readonly autoPublication: false;
  readonly maximumUses: 1;
  readonly authorizedBySubjectHash: string;
  readonly authorizedAt: string;
  readonly expiresAt: string;
  readonly authorityHash: string;
}

export type LegacyRepairAuthorityBodyV1 = Omit<
  LegacyRepairAuthorityV1,
  "authorityHash"
>;

export interface ObservedLegacyRepairFenceV1 {
  readonly sourceRunId: string;
  readonly sourceAccessId: string;
  readonly sourceBriefRequestId: string;
  readonly sourceResolutionGeneration: number;
  readonly sourceResolutionState: string;
  readonly sourceRunStatus: string;
  readonly sourceRunPhase: string;
  readonly incidentReference: string;
  readonly sourceContractRevisionId: string;
  readonly sourceContractSemanticHash: string;
  readonly sourceContractStatus: string;
  readonly sourceQueryPlanRevisionId: string;
  readonly sourceQueryPlanHash: string;
  readonly sourceQueryPlanSchema: number;
  readonly sourceExecutionRoute: string;
  readonly sourceReleaseRevision: string;
  readonly sourceExecutorSemanticConfigurationHash: string;
  readonly sourcePublicAssignmentPresent: boolean;
  readonly sourceRouteReceiptPresent: boolean;
  readonly sourceReleaseCanaryMarkerPresent: boolean;
  readonly containmentReceiptHash: string;
  readonly activeRepairReleaseRevision: string;
  readonly activeRepairExecutorSemanticConfigurationHash: string;
  readonly activeExecutableJobCount: number;
  readonly appleSideEffectCount: number;
  readonly hasPublishedReconciliation: boolean;
}

export interface LegacyRepairAuthorityConsumptionV1 {
  readonly version: typeof LEGACY_REPAIR_CONSUMPTION_VERSION_V1;
  readonly authorityHash: string;
  readonly requestHash: string;
  readonly idempotencyKeyHash: string;
  readonly successorBriefRequestId: string;
  readonly successorKind: "v5_1_planning_successor";
  readonly consumedAt: string;
  readonly consumptionHash: string;
}

type LegacyRepairConsumptionBodyV1 = Omit<
  LegacyRepairAuthorityConsumptionV1,
  "consumptionHash"
>;

export interface LegacyRepairRunAdmissionV1 {
  readonly version: typeof LEGACY_REPAIR_RUN_ADMISSION_VERSION_V1;
  readonly authority: LegacyRepairAuthorityV1;
  readonly consumption: LegacyRepairAuthorityConsumptionV1;
  readonly sourceRunId: string;
  readonly successorBriefRequestId: string;
  readonly trafficClass: "replay";
  readonly resultReuse: false;
  readonly autoPublication: false;
  readonly admittedAt: string;
  readonly admissionHash: string;
}

type LegacyRepairRunAdmissionBodyV1 = Omit<
  LegacyRepairRunAdmissionV1,
  "admissionHash"
>;

const AUTHORITY_KEYS = Object.freeze([
  "authorizationKind",
  "authorizedAt",
  "authorizedBySubjectHash",
  "authorityHash",
  "autoPublication",
  "containmentReceiptHash",
  "expiresAt",
  "incidentReference",
  "maximumUses",
  "provenanceKind",
  "repairExecutorSemanticConfigurationHash",
  "repairReleaseRevision",
  "resultReuse",
  "sourceAccessId",
  "sourceBriefRequestId",
  "sourceContractRevisionId",
  "sourceContractSemanticHash",
  "sourceContractStatus",
  "sourceExecutionRoute",
  "sourceExecutorSemanticConfigurationHash",
  "sourcePublicAssignmentPresent",
  "sourceQueryPlanHash",
  "sourceQueryPlanRevisionId",
  "sourceQueryPlanSchema",
  "sourceReleaseCanaryMarkerPresent",
  "sourceReleaseRevision",
  "sourceResolutionGeneration",
  "sourceResolutionState",
  "sourceRouteReceiptPresent",
  "sourceRunId",
  "sourceRunPhase",
  "sourceRunStatus",
  "targetExecutionRoute",
  "targetGuidanceVersion",
  "targetIntentGroup",
  "targetSuccessorKind",
  "targetTrafficClass",
  "version",
] as const);

const CONSUMPTION_KEYS = Object.freeze([
  "authorityHash",
  "consumedAt",
  "consumptionHash",
  "idempotencyKeyHash",
  "requestHash",
  "successorBriefRequestId",
  "successorKind",
  "version",
] as const);

const RUN_ADMISSION_KEYS = Object.freeze([
  "admissionHash",
  "admittedAt",
  "authority",
  "autoPublication",
  "consumption",
  "resultReuse",
  "sourceRunId",
  "successorBriefRequestId",
  "trafficClass",
  "version",
] as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: string,
): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (
    actual.length !== keys.length
    || actual.some((key, index) => key !== keys[index])
  ) {
    throw new Error(code);
  }
}

function assertUuid(value: string, code: string): void {
  if (!UUID.test(value)) throw new Error(code);
}

function assertSha256(value: string, code: string): void {
  if (!SHA256.test(value)) throw new Error(code);
}

function assertRevision(value: string, code: string): void {
  if (!REVISION.test(value)) throw new Error(code);
}

function exactInstant(value: string, code: string): number {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== value) {
    throw new Error(code);
  }
  return instant;
}

function authorityHash(body: LegacyRepairAuthorityBodyV1): string {
  return sha256Hex(stableStringify({
    domain: AUTHORITY_HASH_DOMAIN,
    authority: body,
  }));
}

function consumptionHash(body: LegacyRepairConsumptionBodyV1): string {
  return sha256Hex(stableStringify({
    domain: CONSUMPTION_HASH_DOMAIN,
    consumption: body,
  }));
}

function runAdmissionHash(body: LegacyRepairRunAdmissionBodyV1): string {
  return sha256Hex(stableStringify({
    domain: RUN_ADMISSION_HASH_DOMAIN,
    admission: body,
  }));
}

export function assertLegacyRepairAuthorityV1(
  value: LegacyRepairAuthorityV1,
): void {
  assertExactKeys(
    value as unknown as Record<string, unknown>,
    AUTHORITY_KEYS,
    "legacy_repair_authority_shape_invalid",
  );
  if (
    value.version !== LEGACY_REPAIR_AUTHORITY_VERSION_V1
    || value.provenanceKind
      !== "forward_owner_repair_not_historical_admission"
    || value.authorizationKind !== "authenticated_owner_control_plane"
    || value.sourceResolutionState !== "quarantined"
    || value.sourceRunStatus !== "failed_integrity"
    || value.sourceRunPhase !== "v254_evidence_persistence_quarantined"
    || value.sourceContractStatus !== "active"
    || value.sourceExecutionRoute !== "corpus_first_v3"
    || value.sourcePublicAssignmentPresent !== false
    || value.sourceRouteReceiptPresent !== false
    || value.sourceReleaseCanaryMarkerPresent !== false
    || value.targetTrafficClass !== "replay"
    || value.targetSuccessorKind !== "v5_1_planning_successor"
    || value.targetGuidanceVersion !== "adaptive_guidance_v5"
    || value.targetExecutionRoute !== "corpus_first_v3"
    || value.targetIntentGroup !== "editorial_influence"
    || value.resultReuse !== false
    || value.autoPublication !== false
    || value.maximumUses !== 1
  ) {
    throw new Error("legacy_repair_authority_policy_invalid");
  }
  for (const [identifier, code] of [
    [value.sourceRunId, "legacy_repair_source_run_invalid"],
    [value.sourceAccessId, "legacy_repair_source_access_invalid"],
    [value.sourceBriefRequestId, "legacy_repair_source_brief_invalid"],
    [value.sourceContractRevisionId, "legacy_repair_source_contract_invalid"],
    [value.sourceQueryPlanRevisionId, "legacy_repair_source_plan_invalid"],
  ] as const) {
    assertUuid(identifier, code);
  }
  if (
    !Number.isSafeInteger(value.sourceResolutionGeneration)
    || value.sourceResolutionGeneration < 1
    || !Number.isSafeInteger(value.sourceQueryPlanSchema)
    || value.sourceQueryPlanSchema < 1
    || !TOKEN.test(value.incidentReference)
  ) {
    throw new Error("legacy_repair_authority_fence_invalid");
  }
  for (const [digest, code] of [
    [value.sourceContractSemanticHash, "legacy_repair_contract_hash_invalid"],
    [value.sourceQueryPlanHash, "legacy_repair_query_plan_hash_invalid"],
    [value.sourceExecutorSemanticConfigurationHash,
      "legacy_repair_source_configuration_hash_invalid"],
    [value.containmentReceiptHash, "legacy_repair_containment_hash_invalid"],
    [value.repairExecutorSemanticConfigurationHash,
      "legacy_repair_target_configuration_hash_invalid"],
    [value.authorizedBySubjectHash, "legacy_repair_authorizer_hash_invalid"],
    [value.authorityHash, "legacy_repair_authority_hash_invalid"],
  ] as const) {
    assertSha256(digest, code);
  }
  assertRevision(
    value.sourceReleaseRevision,
    "legacy_repair_source_revision_invalid",
  );
  assertRevision(
    value.repairReleaseRevision,
    "legacy_repair_target_revision_invalid",
  );
  const authorizedAt = exactInstant(
    value.authorizedAt,
    "legacy_repair_authorized_at_invalid",
  );
  const expiresAt = exactInstant(
    value.expiresAt,
    "legacy_repair_expires_at_invalid",
  );
  if (
    expiresAt <= authorizedAt
    || expiresAt - authorizedAt > MAXIMUM_AUTHORITY_LIFETIME_MS
  ) {
    throw new Error("legacy_repair_authority_lifetime_invalid");
  }
  const { authorityHash: persistedHash, ...body } = value;
  if (authorityHash(body) !== persistedHash) {
    throw new Error("legacy_repair_authority_hash_mismatch");
  }
}

export function createLegacyRepairAuthorityV1(
  body: LegacyRepairAuthorityBodyV1,
): LegacyRepairAuthorityV1 {
  const cloned = structuredClone(body);
  const authority: LegacyRepairAuthorityV1 = Object.freeze({
    ...cloned,
    authorityHash: authorityHash(cloned),
  });
  assertLegacyRepairAuthorityV1(authority);
  return authority;
}

export function parseLegacyRepairAuthorityV1(
  value: unknown,
): LegacyRepairAuthorityV1 | null {
  if (!isRecord(value)) return null;
  try {
    const authority = structuredClone(value) as unknown as
      LegacyRepairAuthorityV1;
    assertLegacyRepairAuthorityV1(authority);
    return authority;
  } catch {
    return null;
  }
}

export type LegacyRepairFenceDecisionV1 =
  | { eligible: true; authority: LegacyRepairAuthorityV1 }
  | { eligible: false; reasonCode: string };

/**
 * Validates every immutable fact that justified the one-time authority. It
 * intentionally does not infer historical admission from owner identity.
 */
export function validateLegacyRepairAuthorityFenceV1(input: {
  authority: unknown;
  observed: ObservedLegacyRepairFenceV1;
  now: string;
}): LegacyRepairFenceDecisionV1 {
  const authority = parseLegacyRepairAuthorityV1(input.authority);
  if (!authority) {
    return { eligible: false, reasonCode: "legacy_repair_authority_invalid" };
  }
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) {
    return { eligible: false, reasonCode: "legacy_repair_clock_invalid" };
  }
  if (now < Date.parse(authority.authorizedAt)) {
    return {
      eligible: false,
      reasonCode: "legacy_repair_authority_not_yet_valid",
    };
  }
  if (now >= Date.parse(authority.expiresAt)) {
    return { eligible: false, reasonCode: "legacy_repair_authority_expired" };
  }
  if (
    !Number.isSafeInteger(input.observed.activeExecutableJobCount)
    || input.observed.activeExecutableJobCount < 0
    || !Number.isSafeInteger(input.observed.appleSideEffectCount)
    || input.observed.appleSideEffectCount < 0
  ) {
    return {
      eligible: false,
      reasonCode: "legacy_repair_observation_invalid",
    };
  }
  if (
    input.observed.appleSideEffectCount > 0
    || input.observed.hasPublishedReconciliation
  ) {
    return { eligible: false, reasonCode: "legacy_repair_already_published" };
  }
  if (input.observed.activeExecutableJobCount !== 0) {
    return { eligible: false, reasonCode: "legacy_repair_work_still_active" };
  }
  const matches =
    input.observed.sourceRunId === authority.sourceRunId
    && input.observed.sourceAccessId === authority.sourceAccessId
    && input.observed.sourceBriefRequestId === authority.sourceBriefRequestId
    && input.observed.sourceResolutionGeneration
      === authority.sourceResolutionGeneration
    && input.observed.sourceResolutionState
      === authority.sourceResolutionState
    && input.observed.sourceRunStatus === authority.sourceRunStatus
    && input.observed.sourceRunPhase === authority.sourceRunPhase
    && input.observed.incidentReference === authority.incidentReference
    && input.observed.sourceContractRevisionId
      === authority.sourceContractRevisionId
    && input.observed.sourceContractSemanticHash
      === authority.sourceContractSemanticHash
    && input.observed.sourceContractStatus === authority.sourceContractStatus
    && input.observed.sourceQueryPlanRevisionId
      === authority.sourceQueryPlanRevisionId
    && input.observed.sourceQueryPlanHash === authority.sourceQueryPlanHash
    && input.observed.sourceQueryPlanSchema
      === authority.sourceQueryPlanSchema
    && input.observed.sourceExecutionRoute === authority.sourceExecutionRoute
    && input.observed.sourceReleaseRevision
      === authority.sourceReleaseRevision
    && input.observed.sourceExecutorSemanticConfigurationHash
      === authority.sourceExecutorSemanticConfigurationHash
    && input.observed.sourcePublicAssignmentPresent
      === authority.sourcePublicAssignmentPresent
    && input.observed.sourceRouteReceiptPresent
      === authority.sourceRouteReceiptPresent
    && input.observed.sourceReleaseCanaryMarkerPresent
      === authority.sourceReleaseCanaryMarkerPresent
    && input.observed.containmentReceiptHash
      === authority.containmentReceiptHash
    && input.observed.activeRepairReleaseRevision
      === authority.repairReleaseRevision
    && input.observed.activeRepairExecutorSemanticConfigurationHash
      === authority.repairExecutorSemanticConfigurationHash;
  return matches
    ? { eligible: true, authority }
    : { eligible: false, reasonCode: "legacy_repair_authority_stale" };
}

export type RepairReplayRouteAuthorityKindV1 =
  | "signed_public_rollout"
  | "authenticated_legacy_repair";

export type RepairReplayPauseDecisionV1 =
  | { allowed: true; bypassedPublicAssignmentPause: boolean }
  | { allowed: false; reasonCode: string };

/** The hard route switch and global pause are never bypassable. */
export function repairReplayPauseDecisionV1(input: {
  authorityKind: RepairReplayRouteAuthorityKindV1;
  globalResearchPaused: boolean;
  publicAssignmentPaused: boolean;
  hardRouteDisabled: boolean;
}): RepairReplayPauseDecisionV1 {
  if (input.globalResearchPaused) {
    return { allowed: false, reasonCode: "research_paused" };
  }
  if (input.hardRouteDisabled) {
    return { allowed: false, reasonCode: "repair_replay_route_disabled" };
  }
  if (
    input.publicAssignmentPaused
    && input.authorityKind === "signed_public_rollout"
  ) {
    return {
      allowed: false,
      reasonCode: "repair_replay_public_assignment_paused",
    };
  }
  return {
    allowed: true,
    bypassedPublicAssignmentPause:
      input.publicAssignmentPaused
      && input.authorityKind === "authenticated_legacy_repair",
  };
}

export function assertLegacyRepairAuthorityConsumptionV1(
  value: LegacyRepairAuthorityConsumptionV1,
): void {
  assertExactKeys(
    value as unknown as Record<string, unknown>,
    CONSUMPTION_KEYS,
    "legacy_repair_consumption_shape_invalid",
  );
  if (
    value.version !== LEGACY_REPAIR_CONSUMPTION_VERSION_V1
    || value.successorKind !== "v5_1_planning_successor"
  ) {
    throw new Error("legacy_repair_consumption_policy_invalid");
  }
  for (const [digest, code] of [
    [value.authorityHash, "legacy_repair_consumption_authority_invalid"],
    [value.requestHash, "legacy_repair_consumption_request_invalid"],
    [value.idempotencyKeyHash,
      "legacy_repair_consumption_idempotency_invalid"],
    [value.consumptionHash, "legacy_repair_consumption_hash_invalid"],
  ] as const) {
    assertSha256(digest, code);
  }
  assertUuid(
    value.successorBriefRequestId,
    "legacy_repair_consumption_successor_invalid",
  );
  exactInstant(value.consumedAt, "legacy_repair_consumed_at_invalid");
  const { consumptionHash: persistedHash, ...body } = value;
  if (consumptionHash(body) !== persistedHash) {
    throw new Error("legacy_repair_consumption_hash_mismatch");
  }
}

export function createLegacyRepairAuthorityConsumptionV1(
  body: LegacyRepairConsumptionBodyV1,
): LegacyRepairAuthorityConsumptionV1 {
  const cloned = structuredClone(body);
  const consumption: LegacyRepairAuthorityConsumptionV1 = Object.freeze({
    ...cloned,
    consumptionHash: consumptionHash(cloned),
  });
  assertLegacyRepairAuthorityConsumptionV1(consumption);
  return consumption;
}

export function parseLegacyRepairAuthorityConsumptionV1(
  value: unknown,
): LegacyRepairAuthorityConsumptionV1 | null {
  if (!isRecord(value)) return null;
  try {
    const consumption = structuredClone(value) as unknown as
      LegacyRepairAuthorityConsumptionV1;
    assertLegacyRepairAuthorityConsumptionV1(consumption);
    return consumption;
  } catch {
    return null;
  }
}

export type LegacyRepairUseDecisionV1 =
  | { kind: "create_planning_successor" }
  | { kind: "return_existing"; successorBriefRequestId: string }
  | { kind: "reject"; reasonCode: string };

/**
 * Call under the source-run advisory lock. The consumption and linked V5.1
 * brief must be inserted in one transaction.
 */
export function decideLegacyRepairAuthorityUseV1(input: {
  authority: LegacyRepairAuthorityV1;
  existingConsumptions: readonly unknown[];
  requestHash: string;
  idempotencyKeyHash: string;
}): LegacyRepairUseDecisionV1 {
  if (!SHA256.test(input.requestHash) || !SHA256.test(input.idempotencyKeyHash)) {
    return { kind: "reject", reasonCode: "legacy_repair_request_invalid" };
  }
  const consumptions = input.existingConsumptions.map(
    parseLegacyRepairAuthorityConsumptionV1,
  );
  if (consumptions.some((value) => value === null)) {
    return {
      kind: "reject",
      reasonCode: "legacy_repair_consumption_integrity",
    };
  }
  const authorityConsumptions = consumptions.filter(
    (value): value is LegacyRepairAuthorityConsumptionV1 =>
      value?.authorityHash === input.authority.authorityHash,
  );
  if (authorityConsumptions.length === 0) {
    return { kind: "create_planning_successor" };
  }
  if (authorityConsumptions.length !== input.authority.maximumUses) {
    return {
      kind: "reject",
      reasonCode: "legacy_repair_consumption_integrity",
    };
  }
  const existing = authorityConsumptions[0]!;
  const consumedAt = Date.parse(existing.consumedAt);
  if (
    consumedAt < Date.parse(input.authority.authorizedAt)
    || consumedAt >= Date.parse(input.authority.expiresAt)
  ) {
    return {
      kind: "reject",
      reasonCode: "legacy_repair_consumption_integrity",
    };
  }
  if (
    existing.requestHash === input.requestHash
    && existing.idempotencyKeyHash === input.idempotencyKeyHash
  ) {
    return {
      kind: "return_existing",
      successorBriefRequestId: existing.successorBriefRequestId,
    };
  }
  return {
    kind: "reject",
    reasonCode: "legacy_repair_authority_already_used",
  };
}

export function assertLegacyRepairRunAdmissionV1(
  value: LegacyRepairRunAdmissionV1,
): void {
  assertExactKeys(
    value as unknown as Record<string, unknown>,
    RUN_ADMISSION_KEYS,
    "legacy_repair_run_admission_shape_invalid",
  );
  assertLegacyRepairAuthorityV1(value.authority);
  assertLegacyRepairAuthorityConsumptionV1(value.consumption);
  if (
    value.version !== LEGACY_REPAIR_RUN_ADMISSION_VERSION_V1
    || value.trafficClass !== "replay"
    || value.resultReuse !== false
    || value.autoPublication !== false
    || value.sourceRunId !== value.authority.sourceRunId
    || value.successorBriefRequestId
      !== value.consumption.successorBriefRequestId
    || value.consumption.authorityHash !== value.authority.authorityHash
    || value.authority.targetTrafficClass !== value.trafficClass
    || value.authority.targetSuccessorKind
      !== value.consumption.successorKind
  ) {
    throw new Error("legacy_repair_run_admission_binding_invalid");
  }
  assertUuid(
    value.sourceRunId,
    "legacy_repair_run_admission_source_invalid",
  );
  assertUuid(
    value.successorBriefRequestId,
    "legacy_repair_run_admission_brief_invalid",
  );
  assertSha256(
    value.admissionHash,
    "legacy_repair_run_admission_hash_invalid",
  );
  const admittedAt = exactInstant(
    value.admittedAt,
    "legacy_repair_run_admission_time_invalid",
  );
  const consumedAt = Date.parse(value.consumption.consumedAt);
  if (
    admittedAt < consumedAt
    || admittedAt >= Date.parse(value.authority.expiresAt)
  ) {
    throw new Error("legacy_repair_run_admission_time_invalid");
  }
  const { admissionHash: persistedHash, ...body } = value;
  if (runAdmissionHash(body) !== persistedHash) {
    throw new Error("legacy_repair_run_admission_hash_mismatch");
  }
}

export function createLegacyRepairRunAdmissionV1(
  body: LegacyRepairRunAdmissionBodyV1,
): LegacyRepairRunAdmissionV1 {
  const cloned = structuredClone(body);
  const admission: LegacyRepairRunAdmissionV1 = Object.freeze({
    ...cloned,
    admissionHash: runAdmissionHash(cloned),
  });
  assertLegacyRepairRunAdmissionV1(admission);
  return admission;
}

export function parseLegacyRepairRunAdmissionV1(
  value: unknown,
): LegacyRepairRunAdmissionV1 | null {
  if (!isRecord(value)) return null;
  try {
    const admission = structuredClone(value) as unknown as
      LegacyRepairRunAdmissionV1;
    assertLegacyRepairRunAdmissionV1(admission);
    return admission;
  } catch {
    return null;
  }
}
