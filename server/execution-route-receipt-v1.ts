import { sha256Hex, stableStringify } from "./security.ts";

export const EXECUTION_ROUTE_RECEIPT_VERSION_V1 =
  "execution_route_receipt_v1" as const;
export const EXECUTION_ROUTE_RECEIPT_PHASE_V1 =
  "execution_route_receipt_v1" as const;

export type ExecutionTrafficClassV1 =
  | "public"
  | "owner_canary"
  | "synthetic"
  | "replay";

export type ExecutionAssignmentAuthorityKindV1 =
  | "signed_public_rollout"
  | "signed_public_direct_exposure"
  | "signed_owner_canary"
  | "signed_release_canary"
  | "authenticated_legacy_repair"
  | "legacy_control";

export interface ExecutionRouteReceiptV1 {
  readonly version: typeof EXECUTION_ROUTE_RECEIPT_VERSION_V1;
  readonly briefId: string;
  readonly rootLineageId: string;
  readonly trafficClass: ExecutionTrafficClassV1;
  readonly contractVersion: 1 | 2 | 3;
  readonly guidanceVersion: string;
  readonly assignmentAuthority: {
    readonly kind: ExecutionAssignmentAuthorityKindV1;
    readonly receiptHash: string;
    readonly intentGroup: string | null;
    readonly assignmentReason: string;
  };
  /** Compatibility/parser label retained by the originating brief. */
  readonly briefSelectionPipelineVersion: string;
  /** The only executor route authorized to claim the run. */
  readonly executionRoute: string;
  readonly queryPlanSchema: number | null;
  readonly queryPlanHash: string | null;
  readonly capabilitySnapshotHash: string | null;
  readonly releaseRevision: string;
  readonly executorConfigurationHash: string;
  readonly createdAt: string;
  readonly receiptHash: string;
}

type ReceiptBodyV1 = Omit<ExecutionRouteReceiptV1, "receiptHash">;

const SHA256 = /^[0-9a-f]{64}$/u;
const TOKEN = /^[0-9A-Za-z][0-9A-Za-z._:/-]{0,199}$/u;

function assertToken(value: string, name: string): void {
  if (!TOKEN.test(value)) throw new Error(`execution_route_receipt_${name}_invalid`);
}

function assertSha256(value: string | null, name: string): void {
  if (value !== null && !SHA256.test(value)) {
    throw new Error(`execution_route_receipt_${name}_invalid`);
  }
}

export function createExecutionRouteReceiptV1(
  input: ReceiptBodyV1,
): ExecutionRouteReceiptV1 {
  const body: ReceiptBodyV1 = structuredClone(input);
  const receipt: ExecutionRouteReceiptV1 = {
    ...body,
    receiptHash: sha256Hex(stableStringify(body)),
  };
  assertExecutionRouteReceiptV1(receipt);
  return receipt;
}

export function assertExecutionRouteReceiptV1(
  value: ExecutionRouteReceiptV1,
): void {
  if (value.version !== EXECUTION_ROUTE_RECEIPT_VERSION_V1) {
    throw new Error("execution_route_receipt_version_invalid");
  }
  assertToken(value.briefId, "brief_id");
  assertToken(value.rootLineageId, "root_lineage_id");
  assertToken(value.guidanceVersion, "guidance_version");
  assertToken(value.assignmentAuthority.assignmentReason, "assignment_reason");
  if (value.assignmentAuthority.intentGroup !== null) {
    assertToken(value.assignmentAuthority.intentGroup, "intent_group");
  }
  assertSha256(value.assignmentAuthority.receiptHash, "assignment_hash");
  assertToken(
    value.briefSelectionPipelineVersion,
    "brief_selection_pipeline_version",
  );
  assertToken(value.executionRoute, "execution_route");
  assertSha256(value.queryPlanHash, "query_plan_hash");
  assertSha256(value.capabilitySnapshotHash, "capability_snapshot_hash");
  assertToken(value.releaseRevision, "release_revision");
  assertSha256(
    value.executorConfigurationHash,
    "executor_configuration_hash",
  );
  assertSha256(value.receiptHash, "receipt_hash");
  if (!new Set<ExecutionTrafficClassV1>([
    "public",
    "owner_canary",
    "synthetic",
    "replay",
  ]).has(value.trafficClass)) {
    throw new Error("execution_route_receipt_traffic_class_invalid");
  }
  if (!new Set<ExecutionAssignmentAuthorityKindV1>([
    "signed_public_rollout",
    "signed_public_direct_exposure",
    "signed_owner_canary",
    "signed_release_canary",
    "authenticated_legacy_repair",
    "legacy_control",
  ]).has(value.assignmentAuthority.kind)) {
    throw new Error("execution_route_receipt_assignment_kind_invalid");
  }
  if (!Number.isInteger(value.contractVersion)
    || value.contractVersion < 1
    || value.contractVersion > 3) {
    throw new Error("execution_route_receipt_contract_version_invalid");
  }
  if (value.queryPlanSchema !== null
    && (!Number.isInteger(value.queryPlanSchema)
      || value.queryPlanSchema < 1)) {
    throw new Error("execution_route_receipt_query_plan_schema_invalid");
  }
  if (!Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error("execution_route_receipt_created_at_invalid");
  }
  const isAuthenticatedLegacyRepair =
    value.assignmentAuthority.kind === "authenticated_legacy_repair";
  if (isAuthenticatedLegacyRepair
    && (value.trafficClass !== "replay" || value.contractVersion !== 3)) {
    throw new Error("execution_route_receipt_legacy_repair_scope_mismatch");
  }
  if (isAuthenticatedLegacyRepair
    && value.executionRoute !== "corpus_first_v3") {
    throw new Error("execution_route_receipt_legacy_repair_route_mismatch");
  }
  if (isAuthenticatedLegacyRepair
    && value.assignmentAuthority.intentGroup === null) {
    throw new Error("execution_route_receipt_legacy_repair_intent_missing");
  }
  if (value.executionRoute === "corpus_first_v3") {
    if (value.contractVersion !== 3) {
      if (!new Set<ExecutionAssignmentAuthorityKindV1>([
        "legacy_control",
        "signed_owner_canary",
        "signed_release_canary",
      ]).has(value.assignmentAuthority.kind)) {
        throw new Error("execution_route_receipt_contract_route_mismatch");
      }
    } else if (value.assignmentAuthority.kind === "legacy_control") {
      throw new Error("execution_route_receipt_assignment_missing");
    }
    if (value.queryPlanSchema === null
      || value.queryPlanHash === null
      || value.capabilitySnapshotHash === null) {
      throw new Error("execution_route_receipt_v3_binding_missing");
    }
  }
  if (value.trafficClass === "owner_canary"
    && value.assignmentAuthority.kind !== "signed_owner_canary") {
    throw new Error("execution_route_receipt_owner_authority_mismatch");
  }
  if (value.trafficClass === "public"
    && value.contractVersion === 3
    && value.assignmentAuthority.kind !== "signed_public_rollout"
    && value.assignmentAuthority.kind !== "signed_public_direct_exposure") {
    throw new Error("execution_route_receipt_public_authority_mismatch");
  }
  if (value.contractVersion === 3
    && value.trafficClass !== "owner_canary"
    && value.trafficClass !== "synthetic"
    && value.assignmentAuthority.kind !== "signed_public_rollout"
    && value.assignmentAuthority.kind !== "signed_public_direct_exposure"
    && !isAuthenticatedLegacyRepair) {
    throw new Error("execution_route_receipt_contract_authority_mismatch");
  }
  if (value.trafficClass === "synthetic"
    && value.contractVersion === 3
    && value.assignmentAuthority.kind !== "signed_release_canary"
    && value.assignmentAuthority.kind !== "signed_public_direct_exposure") {
    throw new Error("execution_route_receipt_release_canary_authority_mismatch");
  }
  const { receiptHash, ...body } = value;
  if (sha256Hex(stableStringify(body)) !== receiptHash) {
    throw new Error("execution_route_receipt_hash_mismatch");
  }
}

export function parseExecutionRouteReceiptV1(
  value: unknown,
): ExecutionRouteReceiptV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const receipt = structuredClone(value) as ExecutionRouteReceiptV1;
    assertExecutionRouteReceiptV1(receipt);
    return receipt;
  } catch {
    return null;
  }
}
