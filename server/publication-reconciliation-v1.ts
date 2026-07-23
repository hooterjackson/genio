import { createHash } from "node:crypto";
import {
  evaluateExecutionFenceV1,
  type ExecutionFenceDecisionV1,
  type ExecutionFenceV1,
} from "./execution-fence-v1.ts";
import { manifestContentHash } from "./manifest-integrity.ts";

export type PublicationEvidenceVerdictV1 = "pass" | "fail" | "unknown";

export interface ContractBoundManifestTrackV1 {
  position: number;
  candidateId: string;
  appleStableId: string;
  artist: string;
  title: string;
  recordingFamilyId: string | null;
}

export interface PartialPublicationApprovalV1 {
  decisionId: string;
  contractRevisionId: string;
  contractSemanticHash: string;
  selectedCount: number;
  manifestContentHash: string;
}

export interface ContractBoundManifestDraftV1 {
  manifestId: string;
  revisionNumber: number;
  parentRevisionId: string | null;
  contractRevisionId: string;
  contractSemanticHash: string;
  storefront: string;
  desiredCount: number;
  tracks: readonly ContractBoundManifestTrackV1[];
  frozenAt: string;
  partialApproval?: PartialPublicationApprovalV1 | null;
}

export interface ContractBoundManifestV1 extends ContractBoundManifestDraftV1 {
  revisionId: string;
  contentHash: string;
  bindingHash: string;
  tracks: readonly Readonly<ContractBoundManifestTrackV1>[];
  partialApproval: Readonly<PartialPublicationApprovalV1> | null;
}

export type ContractBoundManifestIntegrityReasonV1 =
  | "invalid_manifest_metadata"
  | "manifest_track_positions_invalid"
  | "manifest_duplicate_candidate"
  | "manifest_duplicate_apple_identity"
  | "manifest_count_exceeds_contract"
  | "partial_publication_not_approved"
  | "partial_approval_binding_invalid"
  | "manifest_content_hash_conflict"
  | "manifest_binding_hash_conflict"
  | "manifest_revision_id_conflict";

export class ContractBoundManifestIntegrityErrorV1 extends Error {
  readonly name = "ContractBoundManifestIntegrityErrorV1";

  constructor(readonly reasonCode: ContractBoundManifestIntegrityReasonV1) {
    super(`Contract-bound manifest failed integrity validation: ${reasonCode}`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function manifestTrackContentHash(
  tracks: readonly ContractBoundManifestTrackV1[],
): string {
  return manifestContentHash(tracks.map((track) => ({
    candidateId: track.candidateId,
    catalogId: track.appleStableId,
  })));
}

function manifestBindingHash(input: {
  manifestId: string;
  revisionNumber: number;
  parentRevisionId: string | null;
  contractRevisionId: string;
  contractSemanticHash: string;
  storefront: string;
  desiredCount: number;
  contentHash: string;
  partialApproval: PartialPublicationApprovalV1 | null;
}): string {
  return sha256(JSON.stringify({
    kind: "contract_bound_manifest_v1",
    manifestId: input.manifestId,
    revisionNumber: input.revisionNumber,
    parentRevisionId: input.parentRevisionId,
    contractRevisionId: input.contractRevisionId,
    contractSemanticHash: input.contractSemanticHash,
    storefront: input.storefront,
    desiredCount: input.desiredCount,
    contentHash: input.contentHash,
    partialApproval: input.partialApproval
      ? {
        decisionId: input.partialApproval.decisionId,
        contractRevisionId: input.partialApproval.contractRevisionId,
        contractSemanticHash: input.partialApproval.contractSemanticHash,
        selectedCount: input.partialApproval.selectedCount,
        manifestContentHash: input.partialApproval.manifestContentHash,
      }
      : null,
  }));
}

function expectedManifestRevisionId(
  manifestId: string,
  revisionNumber: number,
  bindingHash: string,
): string {
  return `${manifestId}:r${revisionNumber}:${bindingHash.slice(0, 20)}`;
}

function integrityReasons(
  manifest: ContractBoundManifestV1 | ContractBoundManifestDraftV1,
  stored?: Pick<ContractBoundManifestV1, "revisionId" | "contentHash" | "bindingHash">,
): ContractBoundManifestIntegrityReasonV1[] {
  const reasons: ContractBoundManifestIntegrityReasonV1[] = [];
  const partialApproval = manifest.partialApproval ?? null;
  const validMetadata = [
    manifest.manifestId,
    manifest.contractRevisionId,
    manifest.contractSemanticHash,
    manifest.storefront,
    manifest.frozenAt,
  ].every(nonEmpty)
    && Number.isSafeInteger(manifest.revisionNumber)
    && manifest.revisionNumber >= 1
    && Number.isSafeInteger(manifest.desiredCount)
    && manifest.desiredCount >= 1
    && Number.isFinite(new Date(manifest.frozenAt).getTime());
  if (!validMetadata) reasons.push("invalid_manifest_metadata");

  if (!manifest.tracks.every((track, index) => (
    track.position === index
    && nonEmpty(track.candidateId)
    && nonEmpty(track.appleStableId)
    && nonEmpty(track.artist)
    && nonEmpty(track.title)
  ))) {
    reasons.push("manifest_track_positions_invalid");
  }
  const candidateIds = manifest.tracks.map((track) => track.candidateId);
  if (new Set(candidateIds).size !== candidateIds.length) {
    reasons.push("manifest_duplicate_candidate");
  }
  const appleStableIds = manifest.tracks.map((track) => track.appleStableId);
  if (new Set(appleStableIds).size !== appleStableIds.length) {
    reasons.push("manifest_duplicate_apple_identity");
  }
  if (manifest.tracks.length > manifest.desiredCount) {
    reasons.push("manifest_count_exceeds_contract");
  }

  const contentHash = manifestTrackContentHash(manifest.tracks);
  if (manifest.tracks.length < manifest.desiredCount && !partialApproval) {
    reasons.push("partial_publication_not_approved");
  }
  if (partialApproval && (
    !nonEmpty(partialApproval.decisionId)
    || partialApproval.contractRevisionId !== manifest.contractRevisionId
    || partialApproval.contractSemanticHash !== manifest.contractSemanticHash
    || partialApproval.selectedCount !== manifest.tracks.length
    || partialApproval.manifestContentHash !== contentHash
  )) {
    reasons.push("partial_approval_binding_invalid");
  }

  if (stored) {
    if (stored.contentHash !== contentHash) {
      reasons.push("manifest_content_hash_conflict");
    }
    const bindingHash = manifestBindingHash({
      ...manifest,
      contentHash,
      partialApproval,
    });
    if (stored.bindingHash !== bindingHash) {
      reasons.push("manifest_binding_hash_conflict");
    }
    if (stored.revisionId !== expectedManifestRevisionId(
      manifest.manifestId,
      manifest.revisionNumber,
      bindingHash,
    )) {
      reasons.push("manifest_revision_id_conflict");
    }
  }
  return [...new Set(reasons)];
}

/**
 * Freeze the ordered Apple payload together with the immutable contract
 * revision that authorized it. A short manifest cannot be frozen without an
 * explicit decision bound to the exact content hash.
 */
export function freezeContractBoundManifestV1(
  draft: ContractBoundManifestDraftV1,
): ContractBoundManifestV1 {
  const reasons = integrityReasons(draft);
  if (reasons.length > 0) {
    throw new ContractBoundManifestIntegrityErrorV1(reasons[0]!);
  }
  const tracks = Object.freeze(draft.tracks.map((track) => Object.freeze({ ...track })));
  const partialApproval = draft.partialApproval
    ? Object.freeze({ ...draft.partialApproval })
    : null;
  const contentHash = manifestTrackContentHash(tracks);
  const bindingHash = manifestBindingHash({
    ...draft,
    contentHash,
    partialApproval,
  });
  return Object.freeze({
    ...draft,
    tracks,
    partialApproval,
    contentHash,
    bindingHash,
    revisionId: expectedManifestRevisionId(
      draft.manifestId,
      draft.revisionNumber,
      bindingHash,
    ),
  });
}

export function validateContractBoundManifestV1(
  manifest: ContractBoundManifestV1,
): {
  valid: boolean;
  reasonCodes: ContractBoundManifestIntegrityReasonV1[];
} {
  const reasonCodes = integrityReasons(manifest, manifest);
  return { valid: reasonCodes.length === 0, reasonCodes };
}

export interface PrepublicationTrackRevalidationV1 {
  candidateId: string;
  appleStableId: string;
  storefront: string;
  identity: PublicationEvidenceVerdictV1;
  version: PublicationEvidenceVerdictV1;
  contentPolicy: PublicationEvidenceVerdictV1;
  storefrontAvailability: PublicationEvidenceVerdictV1;
  validatedAt: string;
}

export interface QualifiedPublicationReserveV1 {
  track: Omit<ContractBoundManifestTrackV1, "position">;
  revalidation: PrepublicationTrackRevalidationV1;
  evidenceEligible: PublicationEvidenceVerdictV1;
  hardPredicates: PublicationEvidenceVerdictV1;
  qualityEligible: PublicationEvidenceVerdictV1;
  qualificationRank: number;
}

export interface PublicationGateResultV1 {
  passed: boolean;
  reasonCodes: readonly string[];
}

export interface PublicationSequenceResultV1 extends PublicationGateResultV1 {
  orderedCandidateIds: readonly string[];
}

export interface PublicationGateHooksV1 {
  evaluateQuotas(
    tracks: readonly Readonly<ContractBoundManifestTrackV1>[],
  ): PublicationGateResultV1;
  evaluateCentralQuality(
    tracks: readonly Readonly<ContractBoundManifestTrackV1>[],
  ): PublicationGateResultV1;
  sequence(
    tracks: readonly Readonly<ContractBoundManifestTrackV1>[],
  ): PublicationSequenceResultV1;
}

export interface PrepublicationReconciliationInputV1 {
  manifest: ContractBoundManifestV1;
  fence: ExecutionFenceV1;
  authorization: "valid" | "missing" | "expired" | "changing";
  revalidations: readonly PrepublicationTrackRevalidationV1[];
  qualifiedReserve: readonly QualifiedPublicationReserveV1[];
  gates: PublicationGateHooksV1;
  now?: Date;
}

export interface PublicationReplacementV1 {
  kind: "catalog_identity" | "qualified_reserve";
  position: number;
  removedCandidateId: string;
  replacementCandidateId: string;
  replacementAppleStableId: string;
}

type StaleFenceReasonV1 =
  Extract<ExecutionFenceDecisionV1, { state: "stale_attempt" }>["reasonCode"];

export type PrepublicationReconciliationResultV1 =
  | { state: "cancelled"; reasonCode: "run_cancelled" }
  | { state: "stale_attempt"; reasonCode: StaleFenceReasonV1 }
  | {
    state: "blocked_authorization";
    blocker: {
      kind: "apple_authorization";
      nextAction: "authorize_apple";
      preservedManifestRevisionId: string;
    };
  }
  | {
    state: "needs_decision";
    reasonCodes: string[];
    verifiedCount: number;
    publicationCount: number;
    desiredCount: number;
  }
  | {
    state: "quarantined";
    reasonCodes: string[];
  }
  | {
    state: "ready";
    manifest: ContractBoundManifestV1;
    replacements: PublicationReplacementV1[];
    gateResults: {
      quotas: PublicationGateResultV1;
      centralQuality: PublicationGateResultV1;
      sequencing: PublicationSequenceResultV1;
    };
    publicationPlan: IdempotentPublicationPlanV1;
  };

function revalidationPasses(
  validation: PrepublicationTrackRevalidationV1 | undefined,
  storefront: string,
): validation is PrepublicationTrackRevalidationV1 {
  return Boolean(validation)
    && validation!.storefront === storefront
    && nonEmpty(validation!.candidateId)
    && nonEmpty(validation!.appleStableId)
    && Number.isFinite(new Date(validation!.validatedAt).getTime())
    && validation!.identity === "pass"
    && validation!.version === "pass"
    && validation!.contentPolicy === "pass"
    && validation!.storefrontAvailability === "pass";
}

function reservePasses(
  reserve: QualifiedPublicationReserveV1,
  storefront: string,
): boolean {
  return reserve.track.candidateId === reserve.revalidation.candidateId
    && reserve.track.appleStableId === reserve.revalidation.appleStableId
    && nonEmpty(reserve.track.candidateId)
    && nonEmpty(reserve.track.appleStableId)
    && Boolean(reserve.track.recordingFamilyId)
    && reserve.evidenceEligible === "pass"
    && reserve.hardPredicates === "pass"
    && reserve.qualityEligible === "pass"
    && Number.isFinite(reserve.qualificationRank)
    && revalidationPasses(reserve.revalidation, storefront);
}

function sameOrderedTracks(
  left: readonly ContractBoundManifestTrackV1[],
  right: readonly ContractBoundManifestTrackV1[],
): boolean {
  return left.length === right.length
    && left.every((track, index) => {
      const other = right[index];
      return other?.candidateId === track.candidateId
        && other.appleStableId === track.appleStableId
        && other.recordingFamilyId === track.recordingFamilyId;
    });
}

function exactCandidatePermutation(
  tracks: readonly ContractBoundManifestTrackV1[],
  orderedCandidateIds: readonly string[],
): boolean {
  if (tracks.length !== orderedCandidateIds.length) return false;
  const expected = [...tracks.map((track) => track.candidateId)].sort();
  const actual = [...orderedCandidateIds].sort();
  return expected.every((candidateId, index) => candidateId === actual[index]);
}

function successorManifest(
  manifest: ContractBoundManifestV1,
  tracks: readonly ContractBoundManifestTrackV1[],
  now: Date,
): ContractBoundManifestV1 {
  const changed = !sameOrderedTracks(manifest.tracks, tracks);
  if (!changed) {
    return freezeContractBoundManifestV1({
      ...manifest,
      tracks,
      partialApproval: manifest.partialApproval,
    });
  }
  return freezeContractBoundManifestV1({
    manifestId: manifest.manifestId,
    revisionNumber: manifest.revisionNumber + 1,
    parentRevisionId: manifest.revisionId,
    contractRevisionId: manifest.contractRevisionId,
    contractSemanticHash: manifest.contractSemanticHash,
    storefront: manifest.storefront,
    desiredCount: manifest.desiredCount,
    tracks,
    frozenAt: now.toISOString(),
    partialApproval: manifest.partialApproval,
  });
}

/**
 * Revalidate and repair immediately before Apple publication. Only a reserve
 * that independently passed evidence, hard predicates, quality, version,
 * content policy, and storefront checks may replace a lost selection.
 */
export function reconcilePrepublicationV1(
  input: PrepublicationReconciliationInputV1,
): PrepublicationReconciliationResultV1 {
  const fence = evaluateExecutionFenceV1(input.fence);
  if (fence.state === "cancelled" || fence.state === "stale_attempt") return fence;
  if (fence.state === "integrity_conflict") {
    return { state: "quarantined", reasonCodes: [fence.reasonCode] };
  }
  if (input.manifest.contractRevisionId !== input.fence.contractRevisionId
    || input.manifest.contractSemanticHash !== input.fence.contractSemanticHash) {
    return {
      state: "quarantined",
      reasonCodes: ["manifest_contract_binding_conflict"],
    };
  }
  const integrity = validateContractBoundManifestV1(input.manifest);
  if (!integrity.valid) {
    return { state: "quarantined", reasonCodes: integrity.reasonCodes };
  }
  if (input.authorization !== "valid") {
    return {
      state: "blocked_authorization",
      blocker: {
        kind: "apple_authorization",
        nextAction: "authorize_apple",
        preservedManifestRevisionId: input.manifest.revisionId,
      },
    };
  }

  const validationByCandidate = new Map<string, PrepublicationTrackRevalidationV1>();
  for (const validation of input.revalidations) {
    if (validationByCandidate.has(validation.candidateId)) {
      return {
        state: "quarantined",
        reasonCodes: ["duplicate_prepublish_revalidation"],
      };
    }
    validationByCandidate.set(validation.candidateId, validation);
  }
  const reserves = [...input.qualifiedReserve]
    .filter((reserve) => reservePasses(reserve, input.manifest.storefront))
    .sort((left, right) => right.qualificationRank - left.qualificationRank
      || left.track.candidateId.localeCompare(right.track.candidateId));
  const blockedOriginalFamilies = new Set(input.manifest.tracks
    .map((track) => track.recordingFamilyId)
    .filter((value): value is string => Boolean(value)));
  const selectedCandidateIds = new Set<string>();
  const selectedAppleStableIds = new Set<string>();
  const selectedFamilyIds = new Set<string>();
  const usedReserveCandidateIds = new Set<string>();
  const repaired: ContractBoundManifestTrackV1[] = [];
  const replacements: PublicationReplacementV1[] = [];
  const unavailableCandidateIds: string[] = [];

  for (const original of input.manifest.tracks) {
    const validation = validationByCandidate.get(original.candidateId);
    const canKeep = revalidationPasses(validation, input.manifest.storefront)
      && !selectedCandidateIds.has(original.candidateId)
      && !selectedAppleStableIds.has(validation.appleStableId)
      && (!original.recordingFamilyId || !selectedFamilyIds.has(original.recordingFamilyId));
    if (canKeep) {
      const kept = {
        ...original,
        position: repaired.length,
        appleStableId: validation.appleStableId,
      };
      repaired.push(kept);
      selectedCandidateIds.add(kept.candidateId);
      selectedAppleStableIds.add(kept.appleStableId);
      if (kept.recordingFamilyId) selectedFamilyIds.add(kept.recordingFamilyId);
      if (kept.appleStableId !== original.appleStableId) {
        replacements.push({
          kind: "catalog_identity",
          position: original.position,
          removedCandidateId: original.candidateId,
          replacementCandidateId: kept.candidateId,
          replacementAppleStableId: kept.appleStableId,
        });
      }
      continue;
    }

    const reserve = reserves.find((candidate) => (
      !usedReserveCandidateIds.has(candidate.track.candidateId)
      && !selectedCandidateIds.has(candidate.track.candidateId)
      && !selectedAppleStableIds.has(candidate.track.appleStableId)
      && !blockedOriginalFamilies.has(candidate.track.recordingFamilyId!)
      && !selectedFamilyIds.has(candidate.track.recordingFamilyId!)
    ));
    if (!reserve) {
      unavailableCandidateIds.push(original.candidateId);
      continue;
    }
    usedReserveCandidateIds.add(reserve.track.candidateId);
    selectedCandidateIds.add(reserve.track.candidateId);
    selectedAppleStableIds.add(reserve.track.appleStableId);
    selectedFamilyIds.add(reserve.track.recordingFamilyId!);
    repaired.push({ ...reserve.track, position: repaired.length });
    replacements.push({
      kind: "qualified_reserve",
      position: original.position,
      removedCandidateId: original.candidateId,
      replacementCandidateId: reserve.track.candidateId,
      replacementAppleStableId: reserve.track.appleStableId,
    });
  }

  if (unavailableCandidateIds.length > 0) {
    return {
      state: "needs_decision",
      reasonCodes: [
        "prepublish_exact_count_shortfall",
        ...unavailableCandidateIds.map((candidateId) => `unavailable:${candidateId}`),
      ],
      verifiedCount: repaired.length,
      publicationCount: input.manifest.tracks.length,
      desiredCount: input.manifest.desiredCount,
    };
  }

  let quotas: PublicationGateResultV1;
  let centralQuality: PublicationGateResultV1;
  let sequencing: PublicationSequenceResultV1;
  try {
    quotas = input.gates.evaluateQuotas(repaired);
    centralQuality = input.gates.evaluateCentralQuality(repaired);
    sequencing = input.gates.sequence(repaired);
  } catch {
    return { state: "quarantined", reasonCodes: ["publication_gate_exception"] };
  }
  const failedGateReasons = [
    ...(!quotas.passed ? ["quota_gate_failed", ...quotas.reasonCodes] : []),
    ...(!centralQuality.passed
      ? ["central_quality_gate_failed", ...centralQuality.reasonCodes]
      : []),
    ...(!sequencing.passed ? ["sequencing_gate_failed", ...sequencing.reasonCodes] : []),
  ];
  if (failedGateReasons.length > 0) {
    return {
      state: "needs_decision",
      reasonCodes: [...new Set(failedGateReasons)],
      verifiedCount: repaired.length,
      publicationCount: input.manifest.tracks.length,
      desiredCount: input.manifest.desiredCount,
    };
  }
  if (!exactCandidatePermutation(repaired, sequencing.orderedCandidateIds)) {
    return {
      state: "quarantined",
      reasonCodes: ["sequencing_result_not_exact_permutation"],
    };
  }

  const byCandidate = new Map(repaired.map((track) => [track.candidateId, track]));
  const ordered = sequencing.orderedCandidateIds.map((candidateId, position) => ({
    ...byCandidate.get(candidateId)!,
    position,
  }));
  let manifest: ContractBoundManifestV1;
  try {
    manifest = successorManifest(input.manifest, ordered, input.now ?? new Date());
  } catch (error) {
    if (error instanceof ContractBoundManifestIntegrityErrorV1) {
      return {
        state: "needs_decision",
        reasonCodes: [error.reasonCode],
        verifiedCount: ordered.length,
        publicationCount: input.manifest.tracks.length,
        desiredCount: input.manifest.desiredCount,
      };
    }
    return { state: "quarantined", reasonCodes: ["successor_manifest_freeze_failed"] };
  }
  return {
    state: "ready",
    manifest,
    replacements,
    gateResults: { quotas, centralQuality, sequencing },
    publicationPlan: planIdempotentPublicationV1(manifest),
  };
}

export interface PublicationAppendOperationV1 {
  batchIndex: number;
  startIndex: number;
  endExclusive: number;
  appleStableIds: readonly string[];
  idempotencyKey: string;
}

export interface IdempotentPublicationPlanV1 {
  manifestRevisionId: string;
  manifestBindingHash: string;
  playlistMarker: string;
  createPlaylistIdempotencyKey: string;
  expectedOrderedAppleStableIds: readonly string[];
  batches: readonly PublicationAppendOperationV1[];
}

function appendIdempotencyKey(
  bindingHash: string,
  startIndex: number,
  appleStableIds: readonly string[],
): string {
  return sha256(JSON.stringify({
    operation: "apple_append_v1",
    bindingHash,
    startIndex,
    appleStableIds,
  }));
}

function appendOperation(
  plan: Pick<IdempotentPublicationPlanV1, "manifestBindingHash">,
  startIndex: number,
  appleStableIds: readonly string[],
  batchIndex: number,
): PublicationAppendOperationV1 {
  return Object.freeze({
    batchIndex,
    startIndex,
    endExclusive: startIndex + appleStableIds.length,
    appleStableIds: Object.freeze([...appleStableIds]),
    idempotencyKey: appendIdempotencyKey(
      plan.manifestBindingHash,
      startIndex,
      appleStableIds,
    ),
  });
}

export function planIdempotentPublicationV1(
  manifest: ContractBoundManifestV1,
  batchSize = 25,
): IdempotentPublicationPlanV1 {
  const integrity = validateContractBoundManifestV1(manifest);
  if (!integrity.valid) {
    throw new ContractBoundManifestIntegrityErrorV1(integrity.reasonCodes[0]!);
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 25) {
    throw new RangeError("Publication batch size must be an integer from 1 to 25");
  }
  const expected = Object.freeze(manifest.tracks.map((track) => track.appleStableId));
  const batches: PublicationAppendOperationV1[] = [];
  for (let startIndex = 0; startIndex < expected.length; startIndex += batchSize) {
    batches.push(appendOperation(
      { manifestBindingHash: manifest.bindingHash },
      startIndex,
      expected.slice(startIndex, startIndex + batchSize),
      batches.length,
    ));
  }
  return Object.freeze({
    manifestRevisionId: manifest.revisionId,
    manifestBindingHash: manifest.bindingHash,
    playlistMarker: `[genio-manifest:${manifest.bindingHash}]`,
    createPlaylistIdempotencyKey: sha256(
      `apple_create_playlist_v1:${manifest.bindingHash}`,
    ),
    expectedOrderedAppleStableIds: expected,
    batches: Object.freeze(batches),
  });
}

export type PlaylistCreationReconciliationV1 =
  | {
    state: "create_required";
    marker: string;
    idempotencyKey: string;
  }
  | {
    state: "reconciled";
    applePlaylistId: string;
  }
  | {
    state: "quarantined";
    reasonCode: "multiple_playlists_for_manifest_marker" | "invalid_apple_playlist_identity";
  };

export function reconcilePlaylistCreationV1(
  plan: IdempotentPublicationPlanV1,
  observedMatchingPlaylistIds: readonly string[],
): PlaylistCreationReconciliationV1 {
  if (observedMatchingPlaylistIds.some((playlistId) => !nonEmpty(playlistId))) {
    return { state: "quarantined", reasonCode: "invalid_apple_playlist_identity" };
  }
  const unique = [...new Set(observedMatchingPlaylistIds)];
  if (unique.length === 0) {
    return {
      state: "create_required",
      marker: plan.playlistMarker,
      idempotencyKey: plan.createPlaylistIdempotencyKey,
    };
  }
  if (unique.length === 1) {
    return { state: "reconciled", applePlaylistId: unique[0]! };
  }
  return {
    state: "quarantined",
    reasonCode: "multiple_playlists_for_manifest_marker",
  };
}

export type PublicationBatchReconciliationV1 =
  | {
    state: "complete";
    acknowledgedCount: number;
  }
  | {
    state: "append_required";
    acknowledgedCount: number;
    operation: PublicationAppendOperationV1;
  }
  | {
    state: "await_visibility";
    acknowledgedCount: number;
    reasonCode: "apple_read_behind_checkpoint" | "pending_append_not_visible";
  }
  | {
    state: "quarantined";
    reasonCode:
      | "invalid_publication_checkpoint"
      | "apple_playlist_longer_than_manifest"
      | "apple_playlist_order_diverged"
      | "pending_operation_not_bound_to_manifest";
  };

function operationMatchesPlan(
  plan: IdempotentPublicationPlanV1,
  operation: PublicationAppendOperationV1,
): boolean {
  if (!Number.isSafeInteger(operation.startIndex)
    || !Number.isSafeInteger(operation.endExclusive)
    || operation.startIndex < 0
    || operation.endExclusive <= operation.startIndex
    || operation.endExclusive > plan.expectedOrderedAppleStableIds.length) {
    return false;
  }
  const expected = plan.expectedOrderedAppleStableIds.slice(
    operation.startIndex,
    operation.endExclusive,
  );
  return expected.length === operation.appleStableIds.length
    && expected.every((appleStableId, index) => (
      appleStableId === operation.appleStableIds[index]
    ))
    && operation.idempotencyKey === appendIdempotencyKey(
      plan.manifestBindingHash,
      operation.startIndex,
      operation.appleStableIds,
    );
}

function operationFromPosition(
  plan: IdempotentPublicationPlanV1,
  startIndex: number,
): PublicationAppendOperationV1 {
  const batch = plan.batches.find((candidate) => (
    startIndex >= candidate.startIndex && startIndex < candidate.endExclusive
  ))!;
  const ids = plan.expectedOrderedAppleStableIds.slice(
    startIndex,
    batch.endExclusive,
  );
  return appendOperation(plan, startIndex, ids, batch.batchIndex);
}

/**
 * Reconcile Apple’s observed ordered stable IDs before another append. A
 * pending operation is never blindly replayed. Full, partial, and delayed
 * visibility are distinguished using the exact expected prefix.
 */
export function reconcilePublicationBatchesV1(input: {
  plan: IdempotentPublicationPlanV1;
  observedOrderedAppleStableIds: readonly string[];
  acknowledgedCount: number;
  pendingOperation?: PublicationAppendOperationV1 | null;
}): PublicationBatchReconciliationV1 {
  const { plan } = input;
  if (!Number.isSafeInteger(input.acknowledgedCount)
    || input.acknowledgedCount < 0
    || input.acknowledgedCount > plan.expectedOrderedAppleStableIds.length) {
    return { state: "quarantined", reasonCode: "invalid_publication_checkpoint" };
  }
  if (input.observedOrderedAppleStableIds.length
    > plan.expectedOrderedAppleStableIds.length) {
    return { state: "quarantined", reasonCode: "apple_playlist_longer_than_manifest" };
  }
  const exactPrefix = input.observedOrderedAppleStableIds.every(
    (appleStableId, index) => (
      appleStableId === plan.expectedOrderedAppleStableIds[index]
    ),
  );
  if (!exactPrefix) {
    return { state: "quarantined", reasonCode: "apple_playlist_order_diverged" };
  }
  if (input.pendingOperation && !operationMatchesPlan(plan, input.pendingOperation)) {
    return {
      state: "quarantined",
      reasonCode: "pending_operation_not_bound_to_manifest",
    };
  }

  const visibleCount = input.observedOrderedAppleStableIds.length;
  if (visibleCount < input.acknowledgedCount) {
    return {
      state: "await_visibility",
      acknowledgedCount: input.acknowledgedCount,
      reasonCode: "apple_read_behind_checkpoint",
    };
  }
  if (input.pendingOperation && visibleCount <= input.pendingOperation.startIndex) {
    return {
      state: "await_visibility",
      acknowledgedCount: Math.max(input.acknowledgedCount, visibleCount),
      reasonCode: "pending_append_not_visible",
    };
  }
  if (visibleCount === plan.expectedOrderedAppleStableIds.length) {
    return { state: "complete", acknowledgedCount: visibleCount };
  }
  return {
    state: "append_required",
    acknowledgedCount: visibleCount,
    operation: operationFromPosition(plan, visibleCount),
  };
}
