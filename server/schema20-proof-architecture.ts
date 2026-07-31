import { sha256Hex, stableStringify } from "./security.ts";

export const SCHEMA_20_PROOF_ARCHITECTURE_VERSION = "1" as const;
export const CANONICAL_TRACK_IDENTITY_POLICY_VERSION =
  "canonical_track_identity_v1" as const;
export const SELECTION_ATTESTATION_POLICY_VERSION =
  "selection_attestation_v1" as const;

export type ProofArchitectureMode = "off" | "shadow" | "native";
export type SelectionSetRole = "selected" | "reserve";

export interface CanonicalTrackIdentityTupleV1 {
  readonly identityPolicyVersion:
    typeof CANONICAL_TRACK_IDENTITY_POLICY_VERSION;
  readonly provider: "apple";
  readonly storefront: string;
  readonly recordingFamilyKey: string;
  readonly recordingFamilyPolicyVersion: string;
  readonly appleStableId: string;
}

export interface SelectionQualificationAttestationV1 {
  readonly schemaVersion: "selection-qualification-attestation/v1";
  readonly policyVersion: typeof SELECTION_ATTESTATION_POLICY_VERSION;
  readonly runId: string;
  readonly contractRevisionId: string;
  readonly queryPlanRevisionId: string;
  readonly executionAttemptId: string;
  readonly candidateId: string;
  readonly canonicalTrackIdentityHash: string;
  readonly qualificationObservationHash: string;
  readonly evidenceSnapshotHashes: readonly string[];
  readonly contractHash: string;
  readonly queryPlanHash: string;
  readonly evidencePolicyHash: string;
  readonly catalogPolicyHash: string;
  readonly qualificationHash: string;
}

export interface SelectionSetItemV1 {
  readonly role: SelectionSetRole;
  readonly position: number;
  readonly selectionQualificationHash: string;
  readonly canonicalTrackIdentityHash: string;
  readonly appleStableId: string;
}

export interface SelectionSetAttestationV1 {
  readonly schemaVersion: "selection-set-attestation/v1";
  readonly policyVersion: typeof SELECTION_ATTESTATION_POLICY_VERSION;
  readonly runId: string;
  readonly contractRevisionId: string;
  readonly queryPlanRevisionId: string;
  readonly executionAttemptId: string;
  readonly requestedCount: number;
  readonly selectedCount: number;
  readonly reserveCount: number;
  readonly selectedAttestationHash: string;
  readonly reserveAttestationHash: string;
  readonly attestationSetHash: string;
  readonly outputHash: string;
  readonly items: readonly SelectionSetItemV1[];
}

export interface PartialPublicationConsentBindingV1 {
  readonly schemaVersion: "partial-publication-consent-binding/v1";
  readonly runId: string;
  readonly contractRevisionId: string;
  readonly selectionSetHash: string;
  readonly manifestRevisionId: string;
  readonly manifestPayloadHash: string;
  readonly attestationSetHash: string;
  readonly outcomeHash: string;
  readonly targetCount: number;
  readonly selectedCount: number;
  readonly expiresAt: string;
}

function nonEmpty(value: string, field: string, maximum = 500): string {
  if (!value || value.trim() !== value || value.length > maximum) {
    throw new Error(`schema20_${field}_invalid`);
  }
  return value;
}

function hash(value: string, field: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`schema20_${field}_invalid`);
  }
  return value;
}

function positiveCount(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 1000) {
    throw new Error(`schema20_${field}_invalid`);
  }
  return value;
}

function domainHash(domain: string, value: unknown): string {
  return sha256Hex(`${domain}\0${stableStringify(value)}`);
}

export function proofArchitectureMode(
  environment: NodeJS.ProcessEnv = process.env,
): ProofArchitectureMode {
  const value =
    environment.PIPELINE_V3_PROOF_ARCHITECTURE_MODE?.trim() ?? "off";
  return value === "shadow" || value === "native" ? value : "off";
}

export function normalizeCanonicalTrackIdentityTupleV1(input: {
  provider?: string;
  storefront: string;
  recordingFamilyKey: string;
  recordingFamilyPolicyVersion: string;
  appleStableId: string;
}): CanonicalTrackIdentityTupleV1 {
  if ((input.provider ?? "apple") !== "apple") {
    throw new Error("schema20_identity_provider_invalid");
  }
  const storefront = nonEmpty(
    input.storefront.toLowerCase(),
    "identity_storefront",
    16,
  );
  if (!/^[a-z]{2}$/u.test(storefront)) {
    throw new Error("schema20_identity_storefront_invalid");
  }
  return Object.freeze({
    identityPolicyVersion: CANONICAL_TRACK_IDENTITY_POLICY_VERSION,
    provider: "apple",
    storefront,
    recordingFamilyKey: nonEmpty(
      input.recordingFamilyKey,
      "recording_family_key",
      2_000,
    ),
    recordingFamilyPolicyVersion: nonEmpty(
      input.recordingFamilyPolicyVersion,
      "recording_family_policy_version",
      160,
    ),
    appleStableId: nonEmpty(input.appleStableId, "apple_stable_id", 160),
  });
}

export function canonicalTrackIdentityHashV1(
  tuple: CanonicalTrackIdentityTupleV1,
): string {
  const normalized = normalizeCanonicalTrackIdentityTupleV1(tuple);
  return domainHash("genio/canonical-track-identity/v1", normalized);
}

export function canonicalTrackIdentityTuplesEqualV1(
  left: CanonicalTrackIdentityTupleV1,
  right: CanonicalTrackIdentityTupleV1,
): boolean {
  return stableStringify(normalizeCanonicalTrackIdentityTupleV1(left))
    === stableStringify(normalizeCanonicalTrackIdentityTupleV1(right));
}

export function selectionQualificationHashV1(
  input: Omit<SelectionQualificationAttestationV1, "schemaVersion" | "policyVersion" | "qualificationHash">,
): string {
  const evidenceSnapshotHashes = [...input.evidenceSnapshotHashes]
    .map((value) => hash(value, "evidence_snapshot_hash"))
    .sort();
  if (new Set(evidenceSnapshotHashes).size !== evidenceSnapshotHashes.length) {
    throw new Error("schema20_evidence_snapshot_hash_duplicate");
  }
  const payload = {
    schemaVersion: "selection-qualification-attestation/v1" as const,
    policyVersion: SELECTION_ATTESTATION_POLICY_VERSION,
    runId: nonEmpty(input.runId, "run_id", 160),
    contractRevisionId: nonEmpty(
      input.contractRevisionId,
      "contract_revision_id",
      160,
    ),
    queryPlanRevisionId: nonEmpty(
      input.queryPlanRevisionId,
      "query_plan_revision_id",
      160,
    ),
    executionAttemptId: nonEmpty(
      input.executionAttemptId,
      "execution_attempt_id",
      160,
    ),
    candidateId: nonEmpty(input.candidateId, "candidate_id", 160),
    canonicalTrackIdentityHash: hash(
      input.canonicalTrackIdentityHash,
      "canonical_track_identity_hash",
    ),
    qualificationObservationHash: hash(
      input.qualificationObservationHash,
      "qualification_observation_hash",
    ),
    evidenceSnapshotHashes,
    contractHash: hash(input.contractHash, "contract_hash"),
    queryPlanHash: hash(input.queryPlanHash, "query_plan_hash"),
    evidencePolicyHash: hash(
      input.evidencePolicyHash,
      "evidence_policy_hash",
    ),
    catalogPolicyHash: hash(input.catalogPolicyHash, "catalog_policy_hash"),
  };
  return domainHash("genio/selection-qualification/v1", payload);
}

export function buildSelectionQualificationAttestationV1(
  input: Omit<SelectionQualificationAttestationV1, "schemaVersion" | "policyVersion" | "qualificationHash">,
): SelectionQualificationAttestationV1 {
  const evidenceSnapshotHashes = [...input.evidenceSnapshotHashes].sort();
  return Object.freeze({
    schemaVersion: "selection-qualification-attestation/v1",
    policyVersion: SELECTION_ATTESTATION_POLICY_VERSION,
    ...input,
    evidenceSnapshotHashes,
    qualificationHash: selectionQualificationHashV1(input),
  });
}

function normalizedSelectionItems(
  items: readonly SelectionSetItemV1[],
): SelectionSetItemV1[] {
  const result = [...items]
    .map((item) => ({
      role: item.role,
      position: positiveCount(item.position, "selection_position"),
      selectionQualificationHash: hash(
        item.selectionQualificationHash,
        "selection_qualification_hash",
      ),
      canonicalTrackIdentityHash: hash(
        item.canonicalTrackIdentityHash,
        "canonical_track_identity_hash",
      ),
      appleStableId: nonEmpty(item.appleStableId, "apple_stable_id", 160),
    }))
    .sort((left, right) => (
      left.role === right.role
        ? left.position - right.position
        : left.role === "selected"
          ? -1
          : 1
    ));
  const identities = result.map(({ canonicalTrackIdentityHash }) =>
    canonicalTrackIdentityHash
  );
  if (new Set(identities).size !== identities.length) {
    throw new Error("schema20_selection_identity_duplicate");
  }
  for (const role of ["selected", "reserve"] as const) {
    const positions = result
      .filter((item) => item.role === role)
      .map(({ position }) => position);
    if (positions.some((position, index) => position !== index)) {
      throw new Error(`schema20_${role}_positions_invalid`);
    }
  }
  return result;
}

export function buildSelectionSetAttestationV1(input: {
  runId: string;
  contractRevisionId: string;
  queryPlanRevisionId: string;
  executionAttemptId: string;
  requestedCount: number;
  items: readonly SelectionSetItemV1[];
  partialConsent?: PartialPublicationConsentBindingV1 | null;
  allowPendingPartial?: boolean;
}): SelectionSetAttestationV1 {
  const requestedCount = positiveCount(input.requestedCount, "requested_count");
  if (requestedCount < 1) throw new Error("schema20_requested_count_invalid");
  const items = normalizedSelectionItems(input.items);
  const selected = items.filter(({ role }) => role === "selected");
  const reserve = items.filter(({ role }) => role === "reserve");
  if (selected.length > requestedCount) {
    throw new Error("schema20_selected_count_exceeds_requested");
  }
  if (
    selected.length < requestedCount
    && !input.partialConsent
    && input.allowPendingPartial !== true
  ) {
    throw new Error("schema20_partial_consent_required");
  }
  const selectedAttestationHash = domainHash(
    "genio/selection-set-selected/v1",
    selected,
  );
  const reserveAttestationHash = domainHash(
    "genio/selection-set-reserve/v1",
    reserve,
  );
  const identity = {
    schemaVersion: "selection-set-attestation/v1" as const,
    policyVersion: SELECTION_ATTESTATION_POLICY_VERSION,
    runId: nonEmpty(input.runId, "run_id", 160),
    contractRevisionId: nonEmpty(
      input.contractRevisionId,
      "contract_revision_id",
      160,
    ),
    queryPlanRevisionId: nonEmpty(
      input.queryPlanRevisionId,
      "query_plan_revision_id",
      160,
    ),
    executionAttemptId: nonEmpty(
      input.executionAttemptId,
      "execution_attempt_id",
      160,
    ),
    requestedCount,
    selectedCount: selected.length,
    reserveCount: reserve.length,
    selectedAttestationHash,
    reserveAttestationHash,
  };
  const attestationSetHash = domainHash(
    "genio/selection-set-attestation/v1",
    identity,
  );
  const outputHash = domainHash(
    "genio/selection-set-output/v1",
    items.map(({ role, position, appleStableId }) => ({
      role,
      position,
      appleStableId,
    })),
  );
  if (input.partialConsent) {
    assertPartialPublicationConsentBindingV1(input.partialConsent, {
      runId: identity.runId,
      contractRevisionId: identity.contractRevisionId,
      selectionSetHash: attestationSetHash,
      attestationSetHash,
      targetCount: requestedCount,
      selectedCount: selected.length,
    });
  }
  return Object.freeze({
    ...identity,
    attestationSetHash,
    outputHash,
    items,
  });
}

export function schema20ManifestPayloadHashV1(input: {
  runId: string;
  contractRevisionId: string;
  manifestRevisionId: string;
  manifestContentHash: string;
  selectionSetHash: string;
  attestationSetHash: string;
  targetCount: number;
  selectedCount: number;
}): string {
  const targetCount = positiveCount(input.targetCount, "target_count");
  const selectedCount = positiveCount(
    input.selectedCount,
    "selected_count",
  );
  if (targetCount < 1 || selectedCount > targetCount) {
    throw new Error("schema20_manifest_count_invalid");
  }
  return domainHash("genio/manifest-payload/v1", {
    schemaVersion: "schema20-manifest-payload/v1",
    runId: nonEmpty(input.runId, "run_id", 160),
    contractRevisionId: nonEmpty(
      input.contractRevisionId,
      "contract_revision_id",
      160,
    ),
    manifestRevisionId: nonEmpty(
      input.manifestRevisionId,
      "manifest_revision_id",
      160,
    ),
    manifestContentHash: hash(
      input.manifestContentHash,
      "manifest_content_hash",
    ),
    selectionSetHash: hash(input.selectionSetHash, "selection_set_hash"),
    attestationSetHash: hash(
      input.attestationSetHash,
      "attestation_set_hash",
    ),
    targetCount,
    selectedCount,
  });
}

export function assertAttemptOutputDeterministicV1(input: {
  existingOutputHash: string;
  existingAttestationSetHash: string;
  proposedOutputHash: string;
  proposedAttestationSetHash: string;
}): void {
  if (
    hash(input.existingOutputHash, "existing_output_hash")
      !== hash(input.proposedOutputHash, "proposed_output_hash")
    || hash(
      input.existingAttestationSetHash,
      "existing_attestation_set_hash",
    ) !== hash(
      input.proposedAttestationSetHash,
      "proposed_attestation_set_hash",
    )
  ) {
    throw new Error("schema20_nondeterministic_attempt_output");
  }
}

export function assertPartialPublicationConsentBindingV1(
  consent: PartialPublicationConsentBindingV1,
  expected: {
    runId: string;
    contractRevisionId: string;
    selectionSetHash: string;
    attestationSetHash: string;
    targetCount: number;
    selectedCount: number;
    manifestRevisionId?: string;
    manifestPayloadHash?: string;
    outcomeHash?: string;
    now?: Date;
  },
): void {
  const now = expected.now ?? new Date();
  const exact = (
    consent.schemaVersion === "partial-publication-consent-binding/v1"
    && consent.runId === expected.runId
    && consent.contractRevisionId === expected.contractRevisionId
    && consent.selectionSetHash === expected.selectionSetHash
    && consent.attestationSetHash === expected.attestationSetHash
    && consent.targetCount === expected.targetCount
    && consent.selectedCount === expected.selectedCount
    && (expected.manifestRevisionId === undefined
      || consent.manifestRevisionId === expected.manifestRevisionId)
    && (expected.manifestPayloadHash === undefined
      || consent.manifestPayloadHash === expected.manifestPayloadHash)
    && (expected.outcomeHash === undefined
      || consent.outcomeHash === expected.outcomeHash)
    && /^[0-9a-f]{64}$/u.test(consent.selectionSetHash)
    && /^[0-9a-f]{64}$/u.test(consent.manifestPayloadHash)
    && /^[0-9a-f]{64}$/u.test(consent.attestationSetHash)
    && /^[0-9a-f]{64}$/u.test(consent.outcomeHash)
    && Number.isInteger(consent.targetCount)
    && Number.isInteger(consent.selectedCount)
    && consent.selectedCount < consent.targetCount
    && Number.isFinite(Date.parse(consent.expiresAt))
    && Date.parse(consent.expiresAt) > now.getTime()
  );
  if (!exact) throw new Error("schema20_partial_consent_binding_invalid");
}
