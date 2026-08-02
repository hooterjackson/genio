import { sha256Hex, stableStringify } from "./security.ts";

export const TECHNICAL_REPAIR_REPLAY_CONSUMPTION_VERSION_V1 =
  "technical_repair_replay_consumption_v1" as const;
export const TECHNICAL_REPAIR_REPLAY_CONSUMPTION_PHASE_V1 =
  "technical_repair_replay_consumption_v1" as const;
export const TECHNICAL_REPAIR_RUN_ADMISSION_PHASE_V1 =
  "technical_repair_run_admission_v1" as const;

const HASH = /^[0-9a-f]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN = /^[0-9A-Za-z][0-9A-Za-z._:/-]{0,159}$/u;
const CONSUMPTION_HASH_DOMAIN =
  "genio-technical-repair-replay-consumption/v1";
const RUN_ADMISSION_HASH_DOMAIN =
  "genio-technical-repair-run-admission/v1";

export interface TechnicalRepairReplayConsumptionV1 {
  readonly version:
    typeof TECHNICAL_REPAIR_REPLAY_CONSUMPTION_VERSION_V1;
  readonly sourceRunId: string;
  readonly sourceAccessId: string;
  readonly sourceResolutionGeneration: number;
  readonly incidentReference: string;
  readonly sourceContractRevisionId: string;
  readonly sourceContractSemanticHash: string;
  readonly sourceRouteReceiptHash: string;
  readonly requestHash: string;
  readonly idempotencyKeyHash: string;
  readonly successorBriefRequestId: string;
  readonly successorKind: "v5_1_planning_successor";
  readonly resultReuse: false;
  readonly autoPublication: false;
  readonly consumedAt: string;
  readonly consumptionHash: string;
}

export interface TechnicalRepairRunAdmissionV1 {
  readonly version: "technical_repair_run_admission_v1";
  readonly sourceRunId: string;
  readonly consumptionHash: string;
  readonly successorBriefRequestId: string;
  readonly admittedRunId: string;
  readonly targetIntentGroup: string;
  readonly targetExecutionRoute: "corpus_first_v3";
  readonly targetGuidanceVersion: "adaptive_guidance_v5";
  readonly repairReleaseRevision: string;
  readonly repairExecutorConfigurationHash: string;
  readonly resultReuse: false;
  readonly autoPublication: false;
  readonly admittedAt: string;
  readonly admissionHash: string;
}

type TechnicalRepairReplayConsumptionBodyV1 = Omit<
  TechnicalRepairReplayConsumptionV1,
  "consumptionHash"
>;
type TechnicalRepairRunAdmissionBodyV1 = Omit<
  TechnicalRepairRunAdmissionV1,
  "admissionHash"
>;

const CONSUMPTION_KEYS = Object.freeze([
  "autoPublication",
  "consumedAt",
  "consumptionHash",
  "idempotencyKeyHash",
  "incidentReference",
  "requestHash",
  "resultReuse",
  "sourceAccessId",
  "sourceContractRevisionId",
  "sourceContractSemanticHash",
  "sourceResolutionGeneration",
  "sourceRouteReceiptHash",
  "sourceRunId",
  "successorBriefRequestId",
  "successorKind",
  "version",
] as const);
const RUN_ADMISSION_KEYS = Object.freeze([
  "admissionHash",
  "admittedAt",
  "admittedRunId",
  "autoPublication",
  "consumptionHash",
  "repairExecutorConfigurationHash",
  "repairReleaseRevision",
  "resultReuse",
  "sourceRunId",
  "successorBriefRequestId",
  "targetExecutionRoute",
  "targetGuidanceVersion",
  "targetIntentGroup",
  "version",
] as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...CONSUMPTION_KEYS].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function exactRunAdmissionKeys(value: Record<string, unknown>): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...RUN_ADMISSION_KEYS].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function consumptionHash(
  body: TechnicalRepairReplayConsumptionBodyV1,
): string {
  return sha256Hex(stableStringify({
    domain: CONSUMPTION_HASH_DOMAIN,
    consumption: body,
  }));
}

function runAdmissionHash(
  body: TechnicalRepairRunAdmissionBodyV1,
): string {
  return sha256Hex(stableStringify({
    domain: RUN_ADMISSION_HASH_DOMAIN,
    admission: body,
  }));
}

export function assertTechnicalRepairReplayConsumptionV1(
  value: TechnicalRepairReplayConsumptionV1,
): void {
  if (!exactKeys(value as unknown as Record<string, unknown>)
    || value.version !== TECHNICAL_REPAIR_REPLAY_CONSUMPTION_VERSION_V1
    || value.successorKind !== "v5_1_planning_successor"
    || value.resultReuse !== false
    || value.autoPublication !== false
    || !UUID.test(value.sourceRunId)
    || !UUID.test(value.sourceAccessId)
    || !UUID.test(value.sourceContractRevisionId)
    || !UUID.test(value.successorBriefRequestId)
    || !Number.isSafeInteger(value.sourceResolutionGeneration)
    || value.sourceResolutionGeneration < 1
    || !TOKEN.test(value.incidentReference)
    || !HASH.test(value.sourceContractSemanticHash)
    || !HASH.test(value.sourceRouteReceiptHash)
    || !HASH.test(value.requestHash)
    || !HASH.test(value.idempotencyKeyHash)
    || !Number.isFinite(Date.parse(value.consumedAt))
    || !HASH.test(value.consumptionHash)) {
    throw new Error("technical_repair_consumption_invalid");
  }
  const { consumptionHash: persistedHash, ...body } = value;
  if (consumptionHash(body) !== persistedHash) {
    throw new Error("technical_repair_consumption_hash_mismatch");
  }
}

export function createTechnicalRepairReplayConsumptionV1(
  body: TechnicalRepairReplayConsumptionBodyV1,
): TechnicalRepairReplayConsumptionV1 {
  const cloned = structuredClone(body);
  const receipt = Object.freeze({
    ...cloned,
    consumptionHash: consumptionHash(cloned),
  });
  assertTechnicalRepairReplayConsumptionV1(receipt);
  return receipt;
}

export function parseTechnicalRepairReplayConsumptionV1(
  value: unknown,
): TechnicalRepairReplayConsumptionV1 | null {
  if (!isRecord(value)) return null;
  try {
    const receipt = structuredClone(
      value,
    ) as unknown as TechnicalRepairReplayConsumptionV1;
    assertTechnicalRepairReplayConsumptionV1(receipt);
    return receipt;
  } catch {
    return null;
  }
}

export function createTechnicalRepairRunAdmissionV1(
  body: TechnicalRepairRunAdmissionBodyV1,
): TechnicalRepairRunAdmissionV1 {
  const cloned = structuredClone(body);
  const admission = Object.freeze({
    ...cloned,
    admissionHash: runAdmissionHash(cloned),
  });
  assertTechnicalRepairRunAdmissionV1(admission);
  return admission;
}

export function assertTechnicalRepairRunAdmissionV1(
  admission: TechnicalRepairRunAdmissionV1,
): void {
  if (!exactRunAdmissionKeys(
    admission as unknown as Record<string, unknown>,
  )
    || admission.version !== "technical_repair_run_admission_v1"
    || !UUID.test(admission.sourceRunId)
    || !UUID.test(admission.successorBriefRequestId)
    || !UUID.test(admission.admittedRunId)
    || !HASH.test(admission.consumptionHash)
    || !TOKEN.test(admission.targetIntentGroup)
    || admission.targetExecutionRoute !== "corpus_first_v3"
    || admission.targetGuidanceVersion !== "adaptive_guidance_v5"
    || !TOKEN.test(admission.repairReleaseRevision)
    || !HASH.test(admission.repairExecutorConfigurationHash)
    || admission.resultReuse !== false
    || admission.autoPublication !== false
    || !Number.isFinite(Date.parse(admission.admittedAt))
    || !HASH.test(admission.admissionHash)) {
    throw new Error("technical_repair_run_admission_invalid");
  }
  const { admissionHash: persistedHash, ...body } = admission;
  if (runAdmissionHash(body) !== persistedHash) {
    throw new Error("technical_repair_run_admission_hash_mismatch");
  }
}

export function parseTechnicalRepairRunAdmissionV1(
  value: unknown,
): TechnicalRepairRunAdmissionV1 | null {
  if (!isRecord(value)) return null;
  try {
    const admission = structuredClone(
      value,
    ) as unknown as TechnicalRepairRunAdmissionV1;
    assertTechnicalRepairRunAdmissionV1(admission);
    return admission;
  } catch {
    return null;
  }
}

export type TechnicalRepairReplayUseDecisionV1 =
  | { kind: "create_planning_successor" }
  | {
      kind: "return_existing";
      successorBriefRequestId: string;
    }
  | { kind: "reject"; reasonCode: string };

/**
 * Call under the source-run transaction lock. One source lineage may create
 * exactly one clean planning successor; a byte-identical endpoint retry
 * returns that successor without incrementing any generation.
 */
export function decideTechnicalRepairReplayUseV1(input: {
  existingConsumptions: readonly unknown[];
  requestHash: string;
  idempotencyKeyHash: string;
  sourceResolutionGeneration: number;
  incidentReference: string;
  sourceContractRevisionId: string;
  sourceContractSemanticHash: string;
  sourceRouteReceiptHash: string;
}): TechnicalRepairReplayUseDecisionV1 {
  if (!HASH.test(input.requestHash)
    || !HASH.test(input.idempotencyKeyHash)
    || !Number.isSafeInteger(input.sourceResolutionGeneration)
    || input.sourceResolutionGeneration < 1
    || !TOKEN.test(input.incidentReference)
    || !UUID.test(input.sourceContractRevisionId)
    || !HASH.test(input.sourceContractSemanticHash)
    || !HASH.test(input.sourceRouteReceiptHash)) {
    return {
      kind: "reject",
      reasonCode: "technical_repair_request_invalid",
    };
  }
  const parsed = input.existingConsumptions.map(
    parseTechnicalRepairReplayConsumptionV1,
  );
  if (parsed.some((value) => value === null) || parsed.length > 1) {
    return {
      kind: "reject",
      reasonCode: "technical_repair_consumption_integrity",
    };
  }
  const existing = parsed[0];
  if (!existing) return { kind: "create_planning_successor" };
  if (existing.sourceResolutionGeneration
      !== input.sourceResolutionGeneration
    || existing.incidentReference !== input.incidentReference
    || existing.sourceContractRevisionId
      !== input.sourceContractRevisionId
    || existing.sourceContractSemanticHash
      !== input.sourceContractSemanticHash
    || existing.sourceRouteReceiptHash !== input.sourceRouteReceiptHash) {
    return {
      kind: "reject",
      reasonCode: "technical_repair_consumption_integrity",
    };
  }
  if (existing.requestHash === input.requestHash
    && existing.idempotencyKeyHash === input.idempotencyKeyHash) {
    return {
      kind: "return_existing",
      successorBriefRequestId: existing.successorBriefRequestId,
    };
  }
  return {
    kind: "reject",
    reasonCode: "technical_repair_already_used",
  };
}

export type TechnicalRepairReplayAvailabilityReasonV1 =
  | "ready"
  | "repair_pending"
  | "route_paused"
  | "already_started";

export function technicalRepairReplayAvailabilityV1(input: {
  sourceReleaseRevision: string;
  sourceExecutorConfigurationHash: string;
  activeReleaseRevision: string;
  activeExecutorConfigurationHash: string;
  globalResearchPaused: boolean;
  publicAssignmentPaused: boolean;
  hardRouteDisabled: boolean;
  assignmentKind:
    | "signed_public_rollout"
    | "signed_public_direct_exposure"
    | "signed_owner_canary";
  successorBriefRequestId: string | null;
}): {
  available: boolean;
  reason: TechnicalRepairReplayAvailabilityReasonV1;
} {
  if (input.successorBriefRequestId) {
    return { available: false, reason: "already_started" };
  }
  if (input.globalResearchPaused
    || input.hardRouteDisabled
    || (
      input.publicAssignmentPaused
      && (
        input.assignmentKind === "signed_public_rollout"
        || input.assignmentKind === "signed_public_direct_exposure"
      )
    )) {
    return { available: false, reason: "route_paused" };
  }
  if (input.sourceReleaseRevision === input.activeReleaseRevision
    && input.sourceExecutorConfigurationHash
      === input.activeExecutorConfigurationHash) {
    return { available: false, reason: "repair_pending" };
  }
  return { available: true, reason: "ready" };
}
